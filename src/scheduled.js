'use strict';
// Envios automáticos: relatório semanal em PowerPoint e alerta de tablet sem sinal.
const { get, all, run, audit } = require('./db');
const { getSettings } = require('./settings');
const { queueEmail, renderEmail } = require('./notify');
const { reportFor } = require('./stats');
const { localNow, formatLocal } = require('./time');
const zones = require('./zones');
const { hoursStatus } = require('./responses');
const { branchRecipients } = require('./alerts');
const { publicUrl } = require('./config');

const { getState, setState } = require('./settings');
const { companyTz, BLOCKED } = require('./companies');

const fmtNps = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toLocaleString('pt-BR'));
const pct = (v, t) => (t ? Math.round((v / t) * 100) + '%' : '—');

// Período: os 7 dias anteriores ao dia do envio (sem o dia atual, que ainda não terminou).
function lastWeek(date) {
  const end = new Date(date + 'T12:00:00Z');
  const to = new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10);
  const from = new Date(end.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

// Empresas que recebem rotinas automáticas (suspensas e canceladas ficam de fora).
const activeCompanies = () => all("SELECT id FROM companies WHERE status NOT IN ('suspended','canceled') ORDER BY id").map((c) => c.id);

// Usuário "virtual" para calcular o relatório no escopo certo (gestor: só as unidades dele).
function reportUser(companyId, u) {
  const scopeIds = u.role === 'gestor' ? all(`SELECT ub.branch_id FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
    WHERE ub.user_id = ? AND b.company_id = ?`, u.id, companyId).map((r) => r.branch_id) : null;
  return { id: u.id, name: u.name, role: u.role, companyId, scope: scopeIds };
}

// Relatório semanal de UMA empresa.
async function sendWeeklyReportFor(companyId, { force = false, now = Date.now() } = {}) {
  const s = getSettings(companyId);
  if (!s.weeklyReport.enabled && !force) return { sent: 0, skipped: 'desativado' };
  const ln = localNow(now, companyTz(companyId));
  if (!force && (ln.weekday !== s.weeklyReport.weekday || ln.hour < s.weeklyReport.hour)) return { sent: 0, skipped: 'fora do horário' };
  if (!force && getState(companyId, 'weeklyReportLastSent') === ln.date) return { sent: 0, skipped: 'já enviado hoje' };
  setState(companyId, 'weeklyReportLastSent', ln.date);

  const period = lastWeek(ln.date);
  // Destinatários: usuários DESTA empresa; cada um recebe o relatório no SEU escopo.
  const users = all("SELECT id, name, email, role FROM users WHERE company_id = ? AND active = 1 AND notify_reports = 1", companyId);
  const recipients = users.map((u) => ({ email: u.email, user: reportUser(companyId, u) }));
  const adminScope = { id: 0, role: 'admin', name: 'Relatório automático', companyId, scope: null };
  for (const e of s.weeklyReport.extraEmails) if (!recipients.some((r) => r.email === e)) recipients.push({ email: e, user: adminScope });

  let sent = 0;
  for (const r of recipients) {
    if (r.user.role === 'gestor' && !r.user.scope.length) continue;
    const { buffer, stats } = await reportFor(r.user, period, 'Relatório automático');
    const o = stats.overall;
    const sc = r.user.scope;
    const open = get(`SELECT COUNT(*) AS n FROM cases c WHERE c.company_id = ? AND c.status IN ('aberto','em_contato')
      ${sc ? (sc.length ? `AND c.branch_id IN (${sc.map(() => '?').join(',')})` : 'AND 0') : ''}`, companyId, ...(sc || [])).n;
    const { html, text } = renderEmail({
      brand: s, title: 'Relatório semanal de satisfação',
      intro: `Resumo de ${period.from.split('-').reverse().join('/')} a ${period.to.split('-').reverse().join('/')}. O relatório completo em PowerPoint está anexado.`,
      rows: [['NPS', fmtNps(o.nps)], ['Respostas', String(stats.totalResponses)], ['Promotores', pct(o.promoters, o.total)],
        ['Detratores', pct(o.detractors, o.total)], ['Casos pendentes', String(open)],
        ...stats.ranking.slice(0, 5).map((b) => [`${b.position}º ${b.name}`, `NPS ${fmtNps(b.nps)}${b.goal !== null ? ` (meta ${b.goal})` : ''}`])],
      button: { label: 'Abrir o painel', url: `${publicUrl}/admin/` },
      footer: 'Para deixar de receber, desmarque "Relatório semanal" em Minha conta.',
    });
    if (queueEmail({ to: r.email, subject: `${s.companyName}: relatório semanal (NPS ${fmtNps(o.nps)})`, text, html, kind: 'weekly_report',
      attachment: buffer, attachmentName: `relatorio-nps-${period.to}.pptx`, companyId })) sent++;
  }
  audit(null, 'report.weekly_queued', { sent, period }, null, { companyId });
  return { sent, period };
}

// Rotina: passa por todas as empresas ativas. Com companyId, envia só aquela (botão "Enviar agora").
async function sendWeeklyReport({ force = false, now = Date.now(), companyId = null } = {}) {
  if (companyId) return sendWeeklyReportFor(companyId, { force, now });
  const results = {};
  for (const cid of activeCompanies()) results[cid] = await sendWeeklyReportFor(cid, { force, now });
  return results;
}

function checkOfflineTablets(now = Date.now()) {
  const settingsCache = new Map();
  const cfg = (cid) => { if (!settingsCache.has(cid)) settingsCache.set(cid, getSettings(cid)); return settingsCache.get(cid); };
  const devices = all(`SELECT d.*, b.name AS branch_name, c.status AS company_status FROM devices d
    JOIN branches b ON b.id = d.branch_id AND b.company_id = d.company_id JOIN companies c ON c.id = d.company_id
    WHERE d.active = 1 AND b.active = 1 AND d.token_hash IS NOT NULL
      AND (d.offline_alerted_at IS NULL OR d.offline_alerted_at < d.last_seen_at) /* tenant-ok: rotina de todas as empresas; cada aviso usa a empresa do tablet */`);
  let alerted = 0;
  for (const d of devices) {
    if (BLOCKED.has(d.company_status)) continue;
    const s = cfg(d.company_id);
    if (!s.offlineAlert.enabled || d.last_seen_at >= now - s.offlineAlert.minutes * 60_000) continue;
    const branch = get('SELECT * FROM branches WHERE id = ? AND company_id = ?', d.branch_id, d.company_id);
    if (!hoursStatus(branch, now, zones.forBranch(branch, d)).open) continue; // fora do expediente, tablet desligado é esperado
    const { html, text } = renderEmail({
      brand: s, title: `Tablet sem sinal — ${d.branch_name}`,
      intro: `O tablet "${d.name}" não se comunica com o sistema há mais de ${s.offlineAlert.minutes} minutos, durante o horário de funcionamento. Verifique se está ligado, conectado ao Wi-Fi e com a pesquisa aberta.`,
      rows: [['Unidade', d.branch_name], ['Tablet', d.name], ['Último contato', formatLocal(d.last_seen_at, zones.forBranch(branch, d))]],
      button: { label: 'Ver tablets no painel', url: `${publicUrl}/admin/#/dispositivos` },
    });
    for (const to of branchRecipients(d.company_id, d.branch_id, 'notify_offline')) {
      queueEmail({ to, subject: `[Alerta] Tablet sem sinal: ${d.name} (${d.branch_name})`, text, html, kind: 'device_offline', companyId: d.company_id });
    }
    run('UPDATE devices SET offline_alerted_at = ? WHERE id = ? AND company_id = ?', now, d.id, d.company_id);
    alerted++;
  }
  return alerted;
}

module.exports = { sendWeeklyReport, sendWeeklyReportFor, checkOfflineTablets, lastWeek, activeCompanies };

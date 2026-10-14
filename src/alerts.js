'use strict';
// Cliente insatisfeito (nota de NPS de 0 a 6): abre um caso para tratamento e avisa os responsáveis.
// Webhook e WhatsApp recebem só o mínimo (filial, nota, link) — dados pessoais ficam no painel.
const { get, all, run } = require('./db');
const { getSettings } = require('./settings');
const { queueEmail, queueWebhook, queueWhatsApp, renderEmail } = require('./notify');
const { decryptFor } = require('./companies');
const { publicUrl } = require('./config');
const zones = require('./zones');

const DETRACTOR_MAX = 6;
const parseList = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// Destinatários de e-mail de uma unidade: lista da unidade + gestores da unidade (pode haver vários)
// e administradores DA MESMA EMPRESA que querem o aviso. O Master não recebe alertas das empresas.
const PREF_COLUMNS = new Set(['notify_detractors', 'notify_reports', 'notify_offline']);
function branchRecipients(companyId, branchId, prefColumn) {
  if (!PREF_COLUMNS.has(prefColumn)) throw new Error('Preferência inválida.');
  const b = get('SELECT alert_emails FROM branches WHERE id = ? AND company_id = ?', branchId, companyId);
  if (!b) return [];
  const users = all(`SELECT DISTINCT u.email FROM users u LEFT JOIN user_branches ub ON ub.user_id = u.id
      WHERE u.company_id = ? AND u.active = 1 AND u.${prefColumn} = 1 AND (u.role = 'admin' OR ub.branch_id = ?)`, companyId, branchId).map((r) => r.email);
  return [...new Set([...parseList(b.alert_emails), ...users].map((e) => String(e).toLowerCase()))];
}

function onResponse(responseId) {
  const r = get(`SELECT r.*, b.name AS branch_name, b.timezone AS branch_tz FROM responses r JOIN branches b ON b.id = r.branch_id AND b.company_id = r.company_id
    WHERE r.id = ? /* tenant-ok: id recém-gravado pelo próprio servidor */`, responseId);
  if (!r) return null;
  const score = get(`SELECT MIN(a.value_num) AS m FROM answers a JOIN questions q ON q.id = a.question_id AND q.is_nps = 1 WHERE a.response_id = ?`, r.id).m;
  if (score === null || score > DETRACTOR_MAX) return null;
  const now = Date.now();
  const ins = run('INSERT OR IGNORE INTO cases (company_id, response_id, branch_id, min_score, created_at, updated_at) VALUES (?,?,?,?,?,?)', r.company_id, responseId, r.branch_id, score, now, now);
  if (!ins.changes) return null;
  const caseId = Number(ins.lastInsertRowid);
  notifyDetractor(r, score, caseId);
  return caseId;
}

function notifyDetractor(r, score, caseId) {
  const cid = r.company_id;
  const s = getSettings(cid);
  const url = `${publicUrl}/admin/#/casos/${caseId}`;
  const comments = all(`SELECT q.text, a.value_text FROM answers a JOIN questions q ON q.id = a.question_id
      WHERE a.response_id = ? AND q.type = 'text' AND a.value_text IS NOT NULL`, r.id);
  const hasContact = !!r.contact_consent_at && !r.anonymized_at;
  if (s.alerts.detractorEmail) {
    const rows = [['Unidade', r.branch_name], ['Nota', String(score)], ['Quando', new Date(r.submitted_at).toLocaleString('pt-BR', { timeZone: zones.forBranch({ id: r.branch_id, company_id: cid, timezone: r.branch_tz }) })]];
    for (const c of comments) rows.push([c.text, c.value_text]);
    if (hasContact) {
      rows.push(['Cliente pediu contato', decryptFor(cid, r.contact_name_enc) || '(sem nome)']);
      const phone = decryptFor(cid, r.contact_phone_enc); const mail = decryptFor(cid, r.contact_email_enc);
      if (phone) rows.push(['Telefone', phone]);
      if (mail) rows.push(['E-mail', mail]);
    }
    const { html, text } = renderEmail({ brand: s, title: `Cliente insatisfeito — ${r.branch_name}`,
      intro: `Uma resposta com nota ${score} acabou de chegar. Um caso foi aberto para tratamento.`, rows,
      button: { label: 'Abrir o caso no painel', url }, footer: 'Você recebe este aviso porque está cadastrado para alertas desta filial. Ajuste em Minha conta.' });
    for (const to of branchRecipients(cid, r.branch_id, 'notify_detractors')) {
      queueEmail({ to, subject: `[Alerta] Nota ${score} em ${r.branch_name}`, text, html, kind: 'detractor', companyId: cid });
    }
  }
  const { hasFeature } = require('./plans');
  if (s.alerts.webhookUrl && hasFeature(cid, 'webhook')) {
    queueWebhook(s.alerts.webhookUrl, { event: 'detractor', caseId, branch: r.branch_name, score, channel: r.channel,
      contactRequested: hasContact, submittedAt: new Date(r.submitted_at).toISOString(), url }, 'detractor', cid);
  }
  if (s.alerts.whatsappTemplate && hasFeature(cid, 'whatsapp')) {
    const phones = parseList(get('SELECT alert_phones FROM branches WHERE id = ? AND company_id = ?', r.branch_id, cid)?.alert_phones);
    // + WhatsApp pessoal dos usuários (gestores da filial e administradores) que quiserem o aviso
    const mine = all(`SELECT DISTINCT u.whatsapp FROM users u LEFT JOIN user_branches ub ON ub.user_id = u.id
        WHERE u.company_id = ? AND u.active = 1 AND u.notify_detractors = 1 AND u.whatsapp IS NOT NULL AND (u.role = 'admin' OR ub.branch_id = ?)`, cid, r.branch_id).map((x) => x.whatsapp);
    for (const p of [...new Set([...phones, ...mine])]) queueWhatsApp(p, { template: s.alerts.whatsappTemplate, language: s.alerts.whatsappLanguage, params: [r.branch_name, String(score), url] }, 'detractor', cid);
  }
}

module.exports = { onResponse, branchRecipients, parseList, DETRACTOR_MAX };

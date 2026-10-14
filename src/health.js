'use strict';
// Saúde e capacidade da plataforma, para o Master crescer o servidor ANTES de virar problema.
// Cada indicador tem um limite; a 70% vira "atenção" e a 90% vira "crítico". Ao subir de nível,
// os Masters recebem um e-mail (no máximo um por indicador e nível a cada 7 dias).
const fs = require('node:fs');
const os = require('node:os');
const { get, all } = require('./db');
const { getPlatform, setPlatform, platformBranding } = require('./settings');

const CAPACITY_DEFAULTS = {
  dbLimitMb: 5120,              // acima disso, hora de migrar para PostgreSQL
  responsesPerDayLimit: 50_000, // SQLite grava uma coisa por vez; acima disso, PostgreSQL
  devicesLimit: 2000,           // cada tablet consulta o servidor a cada minuto
  companiesLimit: 300,
  alertEmails: [],
};
const capacity = () => ({ ...CAPACITY_DEFAULTS, ...(getPlatform('capacity', {}) || {}) });

const level = (pct) => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok');
const mb = (b) => Math.round((b / 1048576) * 10) / 10;
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

function snapshot(now = Date.now()) {
  const cap = capacity();
  const dbFile = require('./db').DB_FILE;
  const dbBytes = fileSize(dbFile) + fileSize(dbFile + '-wal');
  let disk = null;
  try {
    const st = fs.statfsSync(require('node:path').dirname(dbFile) || '.');
    const total = st.blocks * st.bsize; const free = st.bavail * st.bsize;
    disk = { totalGb: Math.round((total / 1073741824) * 10) / 10, freeGb: Math.round((free / 1073741824) * 10) / 10, usedPct: total ? Math.round(((total - free) / total) * 1000) / 10 : 0 };
  } catch { disk = null; }
  const counts = get(`SELECT (SELECT COUNT(*) FROM companies) AS companies,
      (SELECT COUNT(*) FROM companies WHERE status IN ('active','trial','past_due')) AS activeCompanies,
      (SELECT COUNT(*) FROM responses) AS responses,
      (SELECT COUNT(*) FROM responses WHERE received_at >= ?) AS responses24h,
      (SELECT COUNT(*) FROM devices WHERE active = 1 AND token_hash IS NOT NULL) AS devices,
      (SELECT COUNT(*) FROM devices WHERE active = 1 AND last_seen_at >= ?) AS devicesOnline,
      (SELECT COUNT(*) FROM users WHERE active = 1) AS users,
      (SELECT COUNT(*) FROM outbox WHERE status = 'pending') AS outboxPending,
      (SELECT COUNT(*) FROM outbox WHERE status = 'failed') AS outboxFailed /* tenant-ok: painel de saúde da plataforma */`, now - 86_400_000, now - 10 * 60_000);
  const mem = { rssMb: mb(process.memoryUsage().rss), systemTotalMb: mb(os.totalmem()), systemFreeMb: mb(os.freemem()) };
  const pct = (v, lim) => (lim > 0 ? Math.round((v / lim) * 1000) / 10 : 0);
  const indicators = [
    { key: 'disk', label: 'Espaço em disco', value: disk ? `${disk.usedPct}% usado (${disk.freeGb} GB livres de ${disk.totalGb} GB)` : 'indisponível', pct: disk?.usedPct ?? 0,
      advice: 'Aumente o disco da VPS ou apague backups antigos do servidor (os externos ficam).' },
    { key: 'db', label: 'Tamanho do banco de dados', value: `${mb(dbBytes)} MB de ${cap.dbLimitMb} MB recomendados`, pct: pct(mb(dbBytes), cap.dbLimitMb),
      advice: 'Planeje a migração para PostgreSQL (o sistema já está preparado) ou revise os prazos de retenção.' },
    { key: 'responses', label: 'Respostas nas últimas 24 horas', value: `${counts.responses24h.toLocaleString('pt-BR')} de ${cap.responsesPerDayLimit.toLocaleString('pt-BR')} por dia`, pct: pct(counts.responses24h, cap.responsesPerDayLimit),
      advice: 'Volume alto para SQLite: planeje PostgreSQL e um servidor maior.' },
    { key: 'devices', label: 'Tablets ativos', value: `${counts.devices.toLocaleString('pt-BR')} de ${cap.devicesLimit.toLocaleString('pt-BR')}`, pct: pct(counts.devices, cap.devicesLimit),
      advice: 'Aumente CPU/memória da VPS antes de cadastrar muitos tablets novos.' },
    { key: 'memory', label: 'Memória do servidor', value: `${Math.round(mem.systemTotalMb - mem.systemFreeMb)} MB usados de ${Math.round(mem.systemTotalMb)} MB`, pct: pct(mem.systemTotalMb - mem.systemFreeMb, mem.systemTotalMb),
      advice: 'Aumente a memória da VPS.' },
    { key: 'companies', label: 'Empresas ativas', value: `${counts.activeCompanies} de ${cap.companiesLimit}`, pct: pct(counts.activeCompanies, cap.companiesLimit),
      advice: 'Revise o tamanho do servidor e considere PostgreSQL.' },
  ].map((i) => ({ ...i, level: level(i.pct) }));
  return {
    at: now, indicators, counts, memory: mem, disk, db: { sizeMb: mb(dbBytes) },
    load: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length, uptimeHours: Math.round(process.uptime() / 360) / 10, node: process.version,
    worst: indicators.some((i) => i.level === 'crit') ? 'crit' : indicators.some((i) => i.level === 'warn') ? 'warn' : 'ok',
  };
}

// Tarefa periódica: avisa os Masters quando um indicador sobe de nível.
function checkCapacity(now = Date.now()) {
  const snap = snapshot(now);
  const state = getPlatform('state.capacityAlerts', {}) || {};
  const rank = { ok: 0, warn: 1, crit: 2 };
  const toAlert = snap.indicators.filter((i) => i.level !== 'ok' && !(state[i.key] && rank[state[i.key].level] >= rank[i.level] && now - state[i.key].at < 7 * 86_400_000));
  for (const i of snap.indicators) if (i.level === 'ok' && state[i.key]) delete state[i.key];
  if (!toAlert.length) { setPlatform('state.capacityAlerts', state); return { sent: 0, snapshot: snap }; }
  const { queueEmail, renderEmail } = require('./notify');
  const masters = all("SELECT email FROM users WHERE role = 'master' AND active = 1 /* tenant-ok: aviso para os Masters */").map((u) => u.email);
  const to = [...new Set([...masters, ...(capacity().alertEmails || [])])];
  const crit = toAlert.some((i) => i.level === 'crit');
  const { html, text } = renderEmail({
    brand: platformBranding(), title: crit ? 'Capacidade CRÍTICA no servidor' : 'Atenção à capacidade do servidor',
    intro: 'Um ou mais indicadores do servidor passaram do limite recomendado. Veja o que fazer antes que vire problema:',
    rows: toAlert.map((i) => [`${i.level === 'crit' ? '🔴' : '🟡'} ${i.label}`, `${i.value} — ${i.advice}`]),
    footer: 'Detalhes em Painel Master → Saúde da plataforma.',
  });
  for (const addr of to) queueEmail({ to: addr, subject: `${crit ? '[CRÍTICO]' : '[Atenção]'} Capacidade do servidor de pesquisas`, text, html, kind: 'capacity' });
  for (const i of toAlert) state[i.key] = { level: i.level, at: now };
  setPlatform('state.capacityAlerts', state);
  return { sent: to.length, alerted: toAlert.map((i) => i.key), snapshot: snap };
}

module.exports = { snapshot, checkCapacity, capacity, CAPACITY_DEFAULTS };

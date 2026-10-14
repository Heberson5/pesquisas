'use strict';
// Migrações numeradas do banco. Cada uma roda uma única vez, dentro de uma transação (ou tudo, ou nada),
// e fica registrada em schema_migrations. Assim qualquer servidor chega à mesma estrutura, na ordem certa.
// IMPORTANTE: nunca altere uma migração já publicada; crie a próxima.
const { newSalt, companyKeys, encryptK, lookupK, decrypt } = require('./vault');

const slugify = (s) => String(s || 'empresa').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'empresa';

// Recria uma tabela seguindo o procedimento oficial do SQLite (nova → copia → apaga a antiga → renomeia),
// preservando os ids (as referências das outras tabelas continuam válidas).
function rebuild(db, table, createSql, columns, selectExpr) {
  db.exec(createSql.replace(`CREATE TABLE ${table} (`, `CREATE TABLE ${table}_new (`));
  db.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${selectExpr} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
}

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const addColumn = (db, table, ddl) => { if (!cols(db, table).includes(ddl.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); };

// ---------------------------------------------------------------- 1: multiempresa
function multiempresa(db) {
  const now = Date.now();
  db.exec(`
CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  cnpj TEXT UNIQUE,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','past_due','suspended','canceled')),
  plan_id INTEGER,
  trial_ends_at INTEGER,
  timezone TEXT,
  billing_email TEXT,
  key_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  canceled_at INTEGER
);
CREATE TABLE company_settings (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (company_id, key)
);
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`);

  // A instalação atual (se já tem dados) vira a empresa nº 1.
  const hasData = db.prepare('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM branches) + (SELECT COUNT(*) FROM responses) + (SELECT COUNT(*) FROM surveys) AS n /* tenant-ok: migração do banco */').get().n > 0;
  let companyId = null;
  if (hasData) {
    let name = 'Minha empresa';
    try { const row = db.prepare("SELECT value FROM settings WHERE key = 'companyName'").get(); if (row) name = JSON.parse(row.value) || name; } catch { /* mantém o padrão */ }
    companyId = Number(db.prepare('INSERT INTO companies (name, slug, status, key_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(name, slugify(name), 'active', newSalt(), now, now).lastInsertRowid);
  }

  // users: papel master/admin/gestor + empresa (master não tem empresa) + permissões liberadas pelo administrador.
  rebuild(db, 'users', `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('master','admin','gestor')),
  permissions TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER,
  notify_detractors INTEGER NOT NULL DEFAULT 1,
  notify_reports INTEGER NOT NULL DEFAULT 1,
  notify_offline INTEGER NOT NULL DEFAULT 1,
  whatsapp TEXT,
  CHECK ((role = 'master') = (company_id IS NULL))
)`, 'id, company_id, name, email, password_hash, role, active, failed_logins, locked_until, created_at, totp_secret_enc, totp_enabled, totp_last_step, notify_detractors, notify_reports, notify_offline, whatsapp',
  `id, ${companyId === null ? 'NULL' : companyId}, name, email, password_hash, role, active, failed_logins, locked_until, created_at, totp_secret_enc, totp_enabled, totp_last_step, notify_detractors, notify_reports, notify_offline, whatsapp`);
  db.exec('CREATE INDEX idx_users_company ON users(company_id)');

  // branches: código único DENTRO da empresa (antes era único na instalação inteira).
  rebuild(db, 'branches', `CREATE TABLE branches (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  city TEXT,
  survey_id INTEGER REFERENCES surveys(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  timezone TEXT,
  alert_emails TEXT,
  alert_phones TEXT,
  nps_goal INTEGER,
  hours_json TEXT,
  public_enabled INTEGER NOT NULL DEFAULT 0,
  public_token_enc TEXT,
  public_token_hash TEXT,
  UNIQUE (company_id, code)
)`, 'id, company_id, code, name, city, survey_id, active, created_at, timezone, alert_emails, alert_phones, nps_goal, hours_json, public_enabled, public_token_enc, public_token_hash',
  `id, ${companyId === null ? 'NULL' : companyId}, code, name, city, survey_id, active, created_at, timezone, alert_emails, alert_phones, nps_goal, hours_json, public_enabled, public_token_enc, public_token_hash`);
  db.exec(`CREATE UNIQUE INDEX idx_branch_public ON branches(public_token_hash);
CREATE INDEX idx_branches_company ON branches(company_id);`);

  // Demais tabelas da empresa: ganham o campo de empresa (filtrado em toda consulta).
  for (const t of ['surveys', 'media', 'devices', 'responses', 'cases', 'schedules', 'outbox']) addColumn(db, t, 'company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE');
  addColumn(db, 'audit_log', 'company_id INTEGER');
  addColumn(db, 'audit_log', 'branch_id INTEGER');
  addColumn(db, 'audit_log', 'as_master INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'sessions', 'acting_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL');
  addColumn(db, 'sessions', 'acting_until INTEGER');
  addColumn(db, 'sessions', 'acting_reason TEXT');
  if (companyId !== null) {
    for (const t of ['surveys', 'media', 'devices', 'responses', 'cases', 'schedules', 'outbox', 'audit_log']) db.prepare(`UPDATE ${t} SET company_id = ?`).run(companyId);
  }
  db.exec(`CREATE INDEX idx_surveys_company ON surveys(company_id);
CREATE INDEX idx_media_company ON media(company_id);
CREATE INDEX idx_devices_company ON devices(company_id);
CREATE INDEX idx_responses_company_time ON responses(company_id, submitted_at);
CREATE INDEX idx_cases_company_status ON cases(company_id, status);
CREATE INDEX idx_schedules_company ON schedules(company_id, starts_at);
CREATE INDEX idx_outbox_company ON outbox(company_id);
CREATE INDEX idx_audit_company ON audit_log(company_id, id);`);

  if (companyId !== null) {
    // Configurações atuais passam a ser da empresa nº 1; o e-mail/WhatsApp atual vira o padrão da plataforma.
    for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
      if (key === 'delivery') db.prepare('INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?,?)').run('delivery', value);
      else db.prepare('INSERT OR REPLACE INTO company_settings (company_id, key, value) VALUES (?,?,?)').run(companyId, key, value);
    }
    // Contatos de clientes: abertos com a chave antiga e gravados de novo com a chave da empresa nº 1.
    const salt = db.prepare('SELECT key_salt FROM companies WHERE id = ?').get(companyId).key_salt;
    const keys = companyKeys(companyId, salt);
    const rows = db.prepare('SELECT id, contact_name_enc, contact_phone_enc, contact_email_enc FROM responses WHERE contact_name_enc IS NOT NULL OR contact_phone_enc IS NOT NULL OR contact_email_enc IS NOT NULL /* tenant-ok: migração do banco */').all();
    const upd = db.prepare('UPDATE responses SET contact_name_enc = ?, contact_phone_enc = ?, contact_email_enc = ?, contact_phone_lookup = ?, contact_email_lookup = ? WHERE id = ? /* tenant-ok: migração do banco */');
    for (const r of rows) {
      const name = decrypt(r.contact_name_enc); const phone = decrypt(r.contact_phone_enc); const email = decrypt(r.contact_email_enc);
      upd.run(encryptK(keys, name), encryptK(keys, phone), encryptK(keys, email),
        phone ? lookupK(keys, 'phone:' + phone) : null, email ? lookupK(keys, 'email:' + email) : null, r.id);
    }
  }
}

// ---------------------------------------------------------------- 2: cadastro completo da empresa e convites
// Dados da Receita (endereço, CNAE, situação), contato, observações internas do Master e convite de usuário
// (link para o próprio usuário criar a senha, reaproveitando a tabela de redefinição de senha).
function cadastroEmpresa(db) {
  for (const ddl of ['trade_name TEXT', 'address_json TEXT', 'phone TEXT', 'contact_email TEXT', 'cnae TEXT', 'opened_at TEXT',
    'receita_status TEXT', 'receita_checked_at INTEGER', 'notes TEXT', "origin TEXT NOT NULL DEFAULT 'master'", 'status_reason TEXT']) addColumn(db, 'companies', ddl);
  addColumn(db, 'password_resets', "kind TEXT NOT NULL DEFAULT 'reset'");
}

// ---------------------------------------------------------------- 3: planos e limites
// Plano = preço mensal + limites + recursos. Empresa sem plano (plan_id nulo) não tem limites (ex.: a empresa nº 1 migrada).
function planos(db) {
  db.exec(`CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  limits_json TEXT NOT NULL DEFAULT '{}',
  features_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
  const now = Date.now();
  const add = db.prepare('INSERT INTO plans (name, description, price_cents, limits_json, features_json, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  // Planos iniciais (o Master ajusta nomes, preços e limites no painel).
  add.run('Essencial', 'Para uma loja ou clínica', 14900, JSON.stringify({ branches: 1, devices: 2, users: 3, surveys: 3, responsesMonth: 2000 }),
    JSON.stringify({ pptx: true, whatsapp: false, webhook: false }), 1, now, now);
  add.run('Profissional', 'Para pequenas redes', 34900, JSON.stringify({ branches: 5, devices: 10, users: 15, surveys: 10, responsesMonth: 10000 }),
    JSON.stringify({ pptx: true, whatsapp: true, webhook: false }), 2, now, now);
  add.run('Rede', 'Para redes com muitas unidades', 79900, JSON.stringify({ branches: 30, devices: 60, users: 80, surveys: 30, responsesMonth: 60000 }),
    JSON.stringify({ pptx: true, whatsapp: true, webhook: true }), 3, now, now);
}

// ---------------------------------------------------------------- 4: faturamento (Mercado Pago)
// Faturas por empresa, assinatura no cartão (preapproval do Mercado Pago), PIX/boleto gerado pelo Master e
// registro de notificações recebidas (cada uma é processada uma única vez).
function faturamento(db) {
  for (const ddl of ["billing_method TEXT NOT NULL DEFAULT 'card'", 'auto_invoice INTEGER NOT NULL DEFAULT 0', 'billing_day INTEGER',
    'mp_preapproval_id TEXT', 'mp_preapproval_status TEXT', 'lock_kind TEXT']) addColumn(db, 'companies', ddl);
  db.exec(`CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period TEXT,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','canceled')),
  method TEXT,
  checkout_url TEXT,
  mp_preference_id TEXT,
  mp_payment_id TEXT,
  paid_at INTEGER,
  paid_amount_cents INTEGER,
  sent_at INTEGER,
  notes TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_invoices_period ON invoices(company_id, period) WHERE period IS NOT NULL AND status <> 'canceled';
CREATE INDEX idx_invoices_company ON invoices(company_id, status, due_date);
CREATE UNIQUE INDEX idx_invoices_mp_payment ON invoices(mp_payment_id) WHERE mp_payment_id IS NOT NULL;
CREATE UNIQUE INDEX idx_companies_preapproval ON companies(mp_preapproval_id) WHERE mp_preapproval_id IS NOT NULL;
CREATE TABLE billing_events (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  company_id INTEGER,
  result TEXT,
  received_at INTEGER NOT NULL
);`);
}

const MIGRATIONS = [
  { version: 1, name: 'multiempresa', up: multiempresa },
  { version: 2, name: 'cadastro_empresa', up: cadastroEmpresa },
  { version: 3, name: 'planos', up: planos },
  { version: 4, name: 'faturamento', up: faturamento },
];

function runMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`Migração ${m.version} deixaria ${broken.length} referência(s) inválida(s).`);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(m.version, m.name, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

const currentVersion = (db) => db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get().v;

module.exports = { runMigrations, MIGRATIONS, currentVersion, slugify };

'use strict';
// Gera os prints do manual (manual/img/*.jpg) com os dados de DEMONSTRAÇÃO, num banco temporário.
// Uso (em um computador de desenvolvimento, com o Playwright instalado):
//   npx playwright install chromium   (uma vez)
//   node scripts/manual-screenshots.js
// Nada aqui toca o banco real: tudo roda numa pasta temporária que é apagada no fim.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Instale o Playwright: npm i -D playwright && npx playwright install chromium'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'manual', 'img');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pesquisa-manual-'));
const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'Demo12345678';
const env = { ...process.env, DB_FILE: path.join(tmp, 'demo.db'), MEDIA_DIR: path.join(tmp, 'media'), DATA_DIR: tmp, NODE_ENV: 'development',
  DISABLE_JOBS: 'true', PORT: String(PORT), PUBLIC_URL: BASE, DEMO_ADMIN_PASSWORD: PASS, COOKIE_SECURE: 'false' };
const node = (args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env, stdio: 'inherit' });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  node(['scripts/seed-demo.js']);
  // Situação da demonstração: plano, faturas, permissões extras e "novidades já vistas".
  node(['-e', `
    const { run, get } = require('./src/db'); const b = require('./src/billing'); const { VERSION } = require('./src/manual');
    run("UPDATE companies SET plan_id = (SELECT id FROM plans WHERE name = 'Rede'), billing_method = 'card', billing_day = 10, mp_preapproval_status = 'authorized' WHERE id = 1");
    const i1 = b.createInvoice(1, { period: '2026-09', amountCents: 79900, description: 'Assinatura Rede — 09/2026', dueDate: '2026-09-10', method: 'card' });
    run("UPDATE invoices SET status = 'paid', paid_at = ?, paid_amount_cents = 79900 WHERE id = ?", Date.now() - 30 * 86400000, i1);
    const i2 = b.createInvoice(1, { period: '2026-10', amountCents: 79900, description: 'Assinatura Rede — 10/2026', dueDate: '2026-10-10', method: 'card' });
    run("UPDATE invoices SET status = 'paid', paid_at = ?, paid_amount_cents = 79900 WHERE id = ?", Date.now() - 4 * 86400000, i2);
    run("UPDATE users SET permissions = ? WHERE email = 'gestor.rj01@varejo.demo.local'", JSON.stringify(['privacy.manage', 'users.gestores']));
    run('UPDATE users SET seen_version = ?', VERSION);
  `]);
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env, stdio: process.env.DEBUG_SERVER ? 'inherit' : 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* aguardando */ } await new Promise((r) => setTimeout(r, 200)); }

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const shot = async (page, file) => { await page.waitForTimeout(900); await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 72 }); console.log('  ✓', file); };
  async function login(email) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console', (msg) => { if (process.env.DEBUG_SERVER) console.log('[navegador]', msg.text()); });
    page.on('pageerror', (e) => console.log('[erro na página]', e.message));
    await page.goto(BASE + '/admin/');
    await page.fill('input[type=email]', email); await page.fill('input[type=password]', PASS); await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    return page;
  }
  const go = async (page, hash) => { await page.goto(BASE + '/admin/#/' + hash); await page.waitForTimeout(400); };
  try {
    const a = await login('admin@varejo.demo.local');
    for (const [hash, file] of [['dashboard', 'painel.jpg'], ['respostas', 'respostas.jpg'], ['casos', 'casos.jpg'], ['pesquisas/1', 'pesquisa-editor.jpg'],
      ['filiais', 'unidades.jpg'], ['dispositivos', 'tablets.jpg'], ['auditoria', 'auditoria.jpg'], ['configuracoes', 'configuracoes.jpg'],
      ['plano', 'plano.jpg'], ['faturamento', 'faturamento.jpg'], ['conta', 'conta.jpg']]) { await go(a, hash); await shot(a, file); }
    await go(a, 'usuarios'); await a.waitForTimeout(600);
    await a.click('tr:has-text("gestor") >> text=Editar'); await shot(a, 'usuario.jpg');
    const g = await login('gestor.rj01@varejo.demo.local');
    await go(g, 'lgpd'); await shot(g, 'lgpd.jpg');
    const m = await login('master@demo.local');
    for (const [hash, file] of [['empresas', 'master-empresas.jpg'], ['empresas/1', 'master-ficha.jpg'], ['planos', 'master-planos.jpg'], ['saude', 'master-saude.jpg']]) { await go(m, hash); await shot(m, file); }
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('Prints gerados em', OUT);
})().catch((e) => { console.error(e); process.exit(1); });

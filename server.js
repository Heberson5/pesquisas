'use strict';
const path = require('node:path');
const express = require('express');
const { securityHeaders } = require('./src/security');
const { HttpError } = require('./src/validate');
const { get } = require('./src/db');
const { getSettings, publicBranding, platformBranding } = require('./src/settings');
const { mediaPath } = require('./src/media');

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// Atrás de um proxy reverso (nginx, Cloudflare), defina TRUST_PROXY=1 para req.ip/req.secure corretos.
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false);

app.use(securityHeaders);

// Verificação de saúde (Docker/monitoramento). Não expõe versão nem detalhes.
app.get('/healthz', (req, res) => {
  try { get('SELECT 1 AS ok'); res.set('Cache-Control', 'no-store').json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
app.use('/api', express.json({ limit: '64kb', strict: true }));

// Empresa pelo endereço curto (?empresa=slug), usado no ícone e no app instalado do tablet.
const companyBySlug = (slug) => (typeof slug === 'string' && /^[a-z0-9-]{2,60}$/.test(slug)
  ? get("SELECT id FROM companies WHERE slug = ? AND status NOT IN ('canceled')", slug) : null);

// Identidade visual pública (tela de login e tablet). Sem empresa: a marca da plataforma. Não expõe nada sensível.
app.get('/api/public/branding', (req, res) => {
  const c = companyBySlug(req.query.empresa);
  res.json(c ? publicBranding(c.id) : platformBranding());
});
app.use('/api/kiosk', require('./src/routes/kiosk'));
app.use('/api/link', require('./src/routes/link'));
app.use('/api/admin', require('./src/routes/auth'));
app.use('/api/admin/cases', require('./src/routes/cases'));
app.use('/api/admin/privacy', require('./src/routes/privacy'));
app.use('/api/admin', require('./src/routes/panel'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// Mídia (logo, ícones, agradecimento): nomes aleatórios de 128 bits, tipo validado no upload,
// arquivo guardado na pasta da empresa dona.
const mediaRow = (id) => (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? get('SELECT id, mime, company_id FROM media WHERE id = ? /* tenant-ok: id aleatório público */', id) : null);
app.get('/media/:id', (req, res, next) => {
  const m = mediaRow(req.params.id);
  if (!m) return res.status(404).end();
  res.sendFile(mediaPath(m), {
    headers: { 'Content-Type': m.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'public, max-age=86400, immutable' },
  }, (err) => err && next(err));
});

// Ícones configuráveis: navegador (favicon) e aplicativo instalado no tablet — da empresa (?empresa=slug) ou o padrão.
function sendIcon(res, next, mediaId) {
  const m = mediaRow(mediaId);
  if (!m) return res.sendFile(path.join(__dirname, 'public', 'kiosk', 'icon.svg'), { headers: { 'Cache-Control': 'no-cache' } }, (e) => e && next(e));
  res.sendFile(mediaPath(m), { headers: { 'Content-Type': m.mime, 'Cache-Control': 'no-cache' } }, (e) => e && next(e));
}
const settingsBySlug = (slug) => { const c = companyBySlug(slug); return c ? getSettings(c.id) : null; };
app.get(['/favicon.ico', '/favicon'], (req, res, next) => sendIcon(res, next, settingsBySlug(req.query.empresa)?.faviconMediaId));
app.get(['/app-icon', '/apple-touch-icon.png'], (req, res, next) => sendIcon(res, next, settingsBySlug(req.query.empresa)?.appIconMediaId));
app.get('/kiosk/manifest.webmanifest', (req, res) => {
  const c = companyBySlug(req.query.empresa);
  const s = c ? getSettings(c.id) : platformBranding();
  const icon = s.appIconMediaId ? mediaRow(s.appIconMediaId) : null;
  const q = c ? `?empresa=${encodeURIComponent(req.query.empresa)}` : '';
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
    name: s.companyName, short_name: s.companyName.slice(0, 12), start_url: '/kiosk/' + q, scope: '/kiosk/',
    display: 'fullscreen', orientation: 'any', background_color: s.primaryColor, theme_color: s.primaryColor,
    icons: icon
      ? [{ src: '/app-icon' + q, sizes: '512x512', type: icon.mime, purpose: 'any' }, { src: '/app-icon' + q, sizes: '192x192', type: icon.mime, purpose: 'any' }]
      : [{ src: '/kiosk/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }));
});

const staticOpts = { index: 'index.html', dotfiles: 'deny', redirect: true, maxAge: 0 };
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), staticOpts));
app.use('/kiosk', express.static(path.join(__dirname, 'public', 'kiosk'), staticOpts));
app.use('/shared', express.static(path.join(__dirname, 'public', 'shared'), staticOpts));
// Página da pesquisa por link/QR Code (mesmo app do tablet, em modo celular).
app.get('/r/:token', (req, res, next) => {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(req.params.token)) return res.status(404).end();
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  res.sendFile(path.join(__dirname, 'public', 'kiosk', 'index.html'), (e) => e && next(e));
});
app.get('/', (req, res) => res.redirect('/admin/'));

app.use((req, res) => res.status(404).type('text/plain').send('Não encontrado'));

// Tratamento de erros: nunca devolve stack trace nem detalhes internos ao cliente.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Conteúdo grande demais.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  if (err.status === 404 || err.code === 'ENOENT') return res.status(404).end();
  console.error(new Date().toISOString(), req.method, req.path, err);
  res.status(500).json({ error: 'Erro interno.' });
});

if (require.main === module) {
  const { jobsEnabled } = require('./src/config');
  if (jobsEnabled) require('./src/jobs').start();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => console.log(`Pesquisa de satisfação rodando em http://${host}:${port}  (painel: /admin  •  tablet: /kiosk)`));
  // Parada limpa (docker stop / atualização): termina as requisições em andamento e fecha o banco.
  const shutdown = (sig) => {
    console.log(`${sig} recebido, encerrando…`);
    server.close(() => { try { require('./src/db').db.close(); } catch { /* */ } process.exit(0); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;

'use strict';
// Painel administrativo (SPA sem dependências). Todo texto vindo do servidor é
// inserido com textContent (via h()) — nunca innerHTML — para impedir XSS.
(() => {
  const root = document.getElementById('root');
  let me = null;
  let csrf = null;
  let questionTypes = {};
  const cache = {};

  // ------------------------------------------------------------ utilidades
  function h(tag, attrs = {}, ...children) {
    const el = document.createElementNS(attrs.svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'svg' || v === null || v === undefined || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const fmtDate = (t) => (t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const fmtDateTz = (t, tz) => { try { return t ? new Date(t).toLocaleString('pt-BR', { timeZone: tz || undefined, dateStyle: 'short', timeStyle: 'short' }) : '—'; } catch { return fmtDate(t); } };
  const fmtNps = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toLocaleString('pt-BR'));
  const npsClass = (n) => (n === null ? '' : n >= 50 ? 'good' : n >= 0 ? 'midc' : 'bad');
  const qLabel = (q) => (/[?:!.]$/.test(q) ? q + ' ' : q + ': ');
  const isoDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  let toastTimer;
  function toast(msg, error = false) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (error ? ' error' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (body !== undefined && !(body instanceof Blob)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    if (opts.method && opts.method !== 'GET') headers['X-CSRF-Token'] = csrf || '';
    const res = await fetch('/api/admin' + path, { method: opts.method || 'GET', headers, body, credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401 && path !== '/login') {
      const hadSession = !!me;
      me = null; showLogin(hadSession ? 'Sua sessão expirou. Entre novamente.' : '');
      throw new Error('401');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === 'MFA_SETUP_REQUIRED') { showMfaSetup(true); throw new Error('401'); }
    // Empresa suspensa: recarrega a situação e leva para a tela de faturamento.
    if (res.status === 402 && data.code === 'COMPANY_LOCKED' && path !== '/me') { me = null; location.hash = '#/faturamento'; route(); throw new Error('401'); }
    if (!res.ok) { const e = new Error(data.error || 'Erro ' + res.status); e.status = res.status; throw e; }
    return data;
  }

  const icon = (name, size = 20, opts = {}) => window.Icons.svg(name, { size, ...opts });
  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  function modal(title, content, actions = []) {
    const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } });
    const close = () => bg.remove();
    bg.append(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('h2', {}, title), content,
      h('div', { class: 'actions' }, h('button', { class: 'btn secondary', onclick: close }, actions.length ? 'Cancelar' : 'Fechar'),
        ...actions.map((a) => h('button', { class: 'btn ' + (a.cls || ''), onclick: () => a.onClick(close) }, a.label)))));
    document.body.append(bg);
    return close;
  }

  // ------------------------------------------------------------ identidade visual e tema
  let branding = { companyName: 'Pesquisa de Satisfação', primaryColor: '#0f3d5e', accentColor: '#ffd166', logoUrl: null };
  let settings = null;
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('admin.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('admin.' + k, v); } catch { /* */ } },
  };
  function applyBranding(b) {
    if (b) branding = { ...branding, ...b };
    const r = document.documentElement.style;
    r.setProperty('--brand', branding.primaryColor);
    r.setProperty('--accent', branding.accentColor);
    document.title = 'Painel · ' + branding.companyName;
  }
  function applyTheme() {
    const t = prefs.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = t;
  }
  applyTheme();
  const loadBranding = fetch('/api/public/branding', { cache: 'no-store' }).then((r) => r.json()).then(applyBranding).catch(() => {});

  // ------------------------------------------------------------ login
  // Moldura das telas sem login (entrar, 2FA, esqueci a senha, redefinir).
  async function loginShell(title, sub, ...content) {
    await loadBranding;
    root.replaceChildren(h('div', { class: 'login-wrap' },
      h('div', { class: 'login-hero' },
        branding.logoUrl ? h('div', {}, h('span', { class: 'logo-box' }, h('img', { src: branding.logoUrl, alt: branding.companyName })))
          : h('div', { class: 'row' }, h('span', { class: 'brand-mark' }, initials(branding.companyName)), h('b', {}, branding.companyName)),
        h('div', {}, h('h2', {}, 'A opinião dos seus clientes, de todas as unidades, em um só lugar.'),
          h('p', {}, 'NPS em tempo real, relatórios em PowerPoint e tablets em modo quiosque.'))),
      h('div', { class: 'login-side' }, h('div', { class: 'login' }, h('h1', {}, title), sub ? h('p', { class: 'muted' }, sub) : null, ...content))));
  }

  function formOf(fields, button, onSubmit) {
    const err = h('p', { class: 'bad small', role: 'alert' });
    const btn = h('button', { class: 'btn', type: 'submit' }, button);
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = '';
      try { await onSubmit(); } catch (ex) { if (ex.message !== '401') err.textContent = ex.message; btn.disabled = false; }
    } }, ...fields, btn, err);
    return { form, err };
  }

  async function afterLogin(r) {
    csrf = r.csrf;
    if (r.mfaSetupRequired) return showMfaSetup(true);
    await loadMe(); await route();
    if (me?.whatsNew && !document.querySelector('.modal-bg')) showWhatsNew();
  }

  // Novidades da versão (uma vez por versão, só com o que o perfil da pessoa pode usar).
  async function showWhatsNew() {
    try {
      const m = await api('/manual');
      const v = m.versions[0];
      const seen = () => api('/manual/seen', { method: 'POST' }).then(() => { me.whatsNew = false; }).catch(() => {});
      if (!v) return seen();
      modal(`Novidades da versão ${v.version}`, h('div', {}, h('p', { class: 'muted' }, v.title), h('ul', { class: 'news' }, v.items.map((t) => h('li', {}, t)))),
        [{ label: 'Ver o manual', cls: 'secondary', onClick: async (close) => { await seen(); close(); location.hash = '#/manual'; } },
          { label: 'Entendi', onClick: async (close) => { await seen(); close(); } }]);
    } catch { /* sem novidades */ }
  }

  async function showLogin(msg) {
    const email = h('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'seu@email.com' });
    const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: '••••••••••' });
    const { form, err } = formOf([h('label', { class: 'f' }, 'E-mail', email), h('label', { class: 'f' }, 'Senha', pw)], 'Entrar', async () => {
      try {
        const r = await api('/login', { method: 'POST', body: { email: email.value, password: pw.value } });
        if (r.mfaRequired) return showMfaStep(r.challenge, r.webauthn);
        await afterLogin(r);
      } catch (ex) { pw.value = ''; throw ex; }
    });
    err.textContent = msg || '';
    const signup = await fetch('/api/public/signup', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({}));
    await loginShell('Entrar no painel', branding.companyName, form,
      h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); showForgot(email.value); } }, 'Esqueci minha senha'),
      signup.enabled ? h('p', { class: 'small mt' }, 'Sua empresa ainda não usa? ', h('a', { href: '#/cadastro' }, `Cadastre-se e teste grátis por ${signup.trialDays} dias`)) : null);
    email.focus();
  }

  // Autocadastro da empresa (só aparece quando o Master liga em Configurações gerais).
  async function showSignup() {
    const startedAt = Date.now();
    const pub = async (path, opts = {}) => {
      const res = await fetch('/api/public/signup' + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Erro ' + res.status);
      return data;
    };
    const cnpj = h('input', { required: true, inputmode: 'numeric', maxlength: '18', placeholder: '00.000.000/0000-00' });
    const info = h('div', { class: 'small' });
    const name = h('input', { required: true, maxlength: '60', placeholder: 'Como sua empresa é conhecida' });
    const adminName = h('input', { required: true, maxlength: '100', autocomplete: 'name' });
    const email = h('input', { type: 'email', required: true, autocomplete: 'email' });
    const pw = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
    const pw2 = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
    const terms = h('input', { type: 'checkbox' });
    const trap = h('input', { tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    cnpj.addEventListener('change', async () => {
      const d = cnpj.value.replace(/\D/g, '');
      if (d.length !== 14) return;
      info.replaceChildren(h('span', { class: 'muted' }, 'Consultando…'));
      try {
        const r = await pub('/cnpj/' + d);
        if (!r.found) return info.replaceChildren(h('span', { class: 'bad' }, r.notFound ? 'CNPJ não encontrado na Receita Federal.' : 'Consulta indisponível agora. Tente em alguns minutos.'));
        if (!name.value) name.value = (r.tradeName || r.legalName || '').slice(0, 60);
        info.replaceChildren(h('span', { class: r.active ? 'good' : 'bad' }, `${r.legalName} — ${r.city || ''}/${r.uf || ''} — situação ${r.status}`));
      } catch (ex) { info.replaceChildren(h('span', { class: 'bad' }, ex.message)); }
    });
    const { form, err } = formOf([
      h('label', { class: 'f' }, 'CNPJ da empresa', cnpj), info, h('label', { class: 'f' }, 'Nome da empresa', name),
      h('label', { class: 'f' }, 'Seu nome', adminName), h('label', { class: 'f' }, 'Seu e-mail (será o seu login)', email),
      h('label', { class: 'f' }, 'Senha (mín. 10 caracteres, letras e números)', pw), h('label', { class: 'f' }, 'Repita a senha', pw2),
      h('label', { class: 'hp' }, 'Não preencha', trap),
      h('label', { class: 'signup-terms' }, terms, h('span', {}, 'Li e aceito os termos de uso e a política de privacidade da plataforma.')),
    ], 'Criar conta e começar o teste', async () => {
      if (pw.value !== pw2.value) throw new Error('As senhas não conferem.');
      const r = await pub('', { method: 'POST', body: { cnpj: cnpj.value, name: name.value, adminName: adminName.value, email: email.value, password: pw.value,
        acceptTerms: terms.checked, website: trap.value, startedAt } });
      history.replaceState(null, '', '/admin/');
      showLogin(`Conta criada! Seu teste grátis de ${r.trialDays} dias começou. Entre com o seu e-mail e senha.`);
    });
    void err;
    await loginShell('Cadastrar minha empresa', 'Teste grátis, sem cartão. Você será o Administrador da conta da sua empresa.', form,
      h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); history.replaceState(null, '', '/admin/'); showLogin(); } }, 'Já tenho conta — entrar'));
    cnpj.focus();
  }

  // Chaves de acesso (passkeys): conversões base64url ⇄ bytes para a API WebAuthn do navegador.
  const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const passkeySupported = () => !!window.PublicKeyCredential && !!navigator.credentials;

  async function showMfaStep(challenge, webauthn = null) {
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '11', placeholder: '000000', class: 'code-input' });
    const { form, err } = formOf([h('label', { class: 'f' }, 'Código de 6 dígitos', code)], 'Confirmar', async () => {
      await afterLogin(await api('/login/mfa', { method: 'POST', body: { challenge, code: code.value } }));
    });
    const usePasskey = async () => {
      try {
        const cred = await navigator.credentials.get({ publicKey: { challenge: b64uToBuf(webauthn.challenge), rpId: webauthn.rpId, timeout: webauthn.timeout,
          userVerification: 'required', allowCredentials: webauthn.allowCredentials.map((c) => ({ type: 'public-key', id: b64uToBuf(c.id) })) } });
        if (!cred) return;
        await afterLogin(await api('/login/webauthn', { method: 'POST', body: { challenge, credential: { id: cred.id, type: cred.type, response: {
          clientDataJSON: bufToB64u(cred.response.clientDataJSON), authenticatorData: bufToB64u(cred.response.authenticatorData), signature: bufToB64u(cred.response.signature) } } } }));
      } catch (ex) { err.textContent = ex.name === 'NotAllowedError' ? 'Operação cancelada. Tente de novo ou use o código.' : ex.message; }
    };
    await loginShell('Verificação em duas etapas', 'Abra o aplicativo autenticador no celular e digite o código. Sem o celular? Use um dos códigos de recuperação.',
      webauthn && passkeySupported() ? h('div', {}, h('button', { class: 'btn', type: 'button', onclick: usePasskey }, icon('key', 18), 'Entrar com chave de acesso (biometria/PIN)'),
        h('p', { class: 'small muted center' }, 'ou digite o código')) : null,
      form, h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); showLogin(); } }, 'Voltar'));
    if (webauthn && passkeySupported()) usePasskey(); else code.focus();
  }

  async function showForgot(prefill = '') {
    const email = h('input', { type: 'email', required: true, value: prefill, placeholder: 'seu@email.com' });
    const { form, err } = formOf([h('label', { class: 'f' }, 'E-mail cadastrado', email)], 'Enviar link', async () => {
      const r = await api('/password/forgot', { method: 'POST', body: { email: email.value } });
      err.className = 'good small'; err.textContent = r.message;
    });
    await loginShell('Esqueci minha senha', 'Enviaremos um link para criar uma nova senha. O link vale por 30 minutos.',
      form, h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); showLogin(); } }, 'Voltar ao login'));
    email.focus();
  }

  async function showReset(token) {
    const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const { form } = formOf([h('label', { class: 'f' }, 'Nova senha (mín. 10 caracteres, letras e números)', pw), h('label', { class: 'f' }, 'Repita a nova senha', pw2)], 'Salvar nova senha', async () => {
      if (pw.value !== pw2.value) throw new Error('As senhas não conferem.');
      await api('/password/reset', { method: 'POST', body: { token, password: pw.value } });
      history.replaceState(null, '', '/admin/'); // remove o token da barra de endereço
      showLogin('Senha alterada. Entre com a nova senha.');
    });
    await loginShell('Criar nova senha', null, form);
  }

  // Configuração do 2FA. forced = administrador que ainda não ativou (obrigatório).
  async function showMfaSetup(forced) {
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const area = h('div');
    const { form } = formOf([h('label', { class: 'f' }, 'Confirme sua senha', pw)], 'Continuar', async () => {
      const s = await api('/mfa/setup', { method: 'POST', body: { password: pw.value } });
      const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '000000', class: 'code-input' });
      const step2 = formOf([h('label', { class: 'f' }, 'Digite o código que aparece no aplicativo', code)], 'Ativar', async () => {
        const r = await api('/mfa/enable', { method: 'POST', body: { code: code.value } });
        showRecoveryCodes(r.recoveryCodes, forced);
      });
      area.replaceChildren(
        h('ol', { class: 'small steps' }, h('li', {}, 'Instale o Google Authenticator, Microsoft Authenticator ou Authy.'),
          h('li', {}, 'Leia o QR Code abaixo com o aplicativo.'), h('li', {}, 'Digite o código de 6 dígitos gerado.')),
        h('img', { src: s.qr, alt: 'QR Code para o aplicativo autenticador', class: 'qr' }),
        h('p', { class: 'small muted' }, 'Não consegue ler? Digite esta chave: ', h('code', { class: 'secret' }, s.secret)),
        step2.form);
      code.focus();
    });
    area.append(form);
    const content = [area];
    if (forced) {
      content.push(h('a', { href: '#', class: 'small', onclick: async (e) => { e.preventDefault(); await api('/logout', { method: 'POST' }).catch(() => {}); me = null; showLogin(); } }, 'Sair'));
      await loginShell('Ative a verificação em duas etapas', 'Por segurança, administradores precisam usar um código do celular além da senha.', ...content);
    } else {
      modal('Ativar verificação em duas etapas', h('div', {}, ...content));
    }
    pw.focus();
  }

  function showRecoveryCodes(codes, forced) {
    document.querySelector('.modal-bg')?.remove();
    const text = codes.join('\n');
    const download = () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([`Códigos de recuperação — ${branding.companyName}\nCada código funciona uma única vez.\n\n${text}\n`], { type: 'text/plain' })), download: 'codigos-recuperacao.txt' });
      document.body.append(a); a.click(); a.remove();
    };
    const content = h('div', {},
      h('p', {}, 'Guarde estes códigos em local seguro. Cada um permite entrar uma única vez caso você perca o celular.'),
      h('div', { class: 'recovery' }, codes.map((c) => h('code', {}, c))),
      h('div', { class: 'row' }, h('button', { class: 'btn secondary', onclick: download }, icon('download', 16), 'Baixar .txt'),
        h('button', { class: 'btn secondary', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copiado.')) }, icon('copy', 16), 'Copiar')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { document.querySelector('.modal-bg')?.remove(); me = null; await loadMe(); route(); } }, 'Guardei os códigos, continuar')));
    if (forced) loginShell('2FA ativado', null, content);
    else modal('2FA ativado', content);
  }

  let displays = {};
  let contactModes = {};
  async function loadMe() {
    const r = await api('/me');
    if (r.mfaSetupRequired) { csrf = r.csrf; showMfaSetup(true); throw new Error('401'); }
    me = r.user; csrf = r.csrf; questionTypes = r.questionTypes; displays = r.displays; settings = r.settings; contactModes = r.contactModes;
    // Permissões vêm do servidor (que confere tudo de novo); aqui só decidem o que aparece na tela.
    const perms = new Set(me.permissions || []);
    me.can = (p) => perms.has(p);
    me.company = r.company; me.acting = r.acting; me.grantable = r.grantable || [];
    me.whatsNew = !!r.whatsNew;
    for (const k of Object.keys(cache)) delete cache[k];
    const b = settings || r.platform;
    applyBranding({ companyName: b.companyName, primaryColor: b.primaryColor, accentColor: b.accentColor,
      logoUrl: settings?.logoMediaId ? '/media/' + settings.logoMediaId : null });
  }
  const ROLE_LABEL = { master: 'Master', admin: 'Administrador', gestor: 'Gestor de unidade' };
  // Página visível? Sem empresa em uso (Master fora de uma empresa) só aparecem as páginas da plataforma.
  const locked = () => me.company?.status === 'suspended' && me.role !== 'master';
  const canSee = (p) => {
    if (p[3] === 'master') return me.role === 'master';
    if (!me.company) return false;
    if (locked()) return p[0] === 'faturamento';
    if (p[0] === 'faturamento') return me.can('settings.manage') && (me.role !== 'master' || !!me.acting);
    return !p[3] || (typeof p[3] === 'function' ? p[3]() : me.can(p[3]));
  };

  // ------------------------------------------------------------ layout + rotas
  // [rota, rótulo, página, permissão exigida ('master' = só o Master), grupo]
  const PAGES = [
    ['empresas', 'Empresas', pageCompanies, 'master', 'Plataforma'],
    ['planos', 'Planos', pagePlans, 'master', 'Plataforma'],
    ['faturas', 'Faturas', pageInvoices, 'master', 'Plataforma'],
    ['plataforma', 'Configurações gerais', pagePlatform, 'master', 'Plataforma'],
    ['saude', 'Saúde da plataforma', pageHealth, 'master', 'Plataforma'],
    ['auditoria-plataforma', 'Auditoria da plataforma', pagePlatformAudit, 'master', 'Plataforma'],
    ['dashboard', 'Visão geral', pageDashboard, 'dashboard.view', 'Análise'],
    ['casos', 'Casos', pageCases, 'cases.manage', 'Análise'],
    ['respostas', 'Respostas', pageResponses, 'dashboard.view', 'Análise'],
    ['pesquisas', 'Pesquisas', pageSurveys, null, 'Coleta'],
    ['filiais', 'Unidades', pageBranches, null, 'Coleta'],
    ['dispositivos', 'Tablets', pageDevices, null, 'Coleta'],
    ['usuarios', 'Usuários', pageUsers, () => me.can('users.manage') || me.can('users.gestores'), 'Administração'],
    ['plano', 'Plano e uso', pageMyPlan, 'settings.manage', 'Administração'],
    ['faturamento', 'Faturamento', pageBilling, () => true, 'Administração'],
    ['configuracoes', 'Configurações', pageSettings, 'settings.manage', 'Administração'],
    ['lgpd', 'Pedidos LGPD', pagePrivacy, () => me.can('privacy.manage') && !me.can('settings.manage'), 'Administração'],
    ['auditoria', 'Auditoria', pageAudit, 'audit.view', 'Administração'],
    ['conta', 'Minha conta', pageAccount, () => true, 'Administração'],
    ['manual', 'Manual e novidades', pageManual, () => true, 'Ajuda'],
  ];
  const menuIcon = (id) => settings?.menuIcons?.[id] || window.Icons.MENU_DEFAULTS[id];

  function layout(active, content) {
    const collapsed = prefs.get('sidebar', 'open') === 'collapsed';
    const shell = h('div', { class: 'layout' + (collapsed ? ' collapsed' : '') });
    const visible = PAGES.filter((p) => p[0] === 'conta' || p[0] === 'manual' || canSee(p));
    const groups = [...new Set(visible.map((p) => p[4]))];
    const dark = document.documentElement.dataset.theme === 'dark';
    const toggleCollapse = () => {
      const now = !shell.classList.contains('collapsed');
      shell.classList.toggle('collapsed', now);
      prefs.set('sidebar', now ? 'collapsed' : 'open');
      collapseBtn.replaceChildren(icon(now ? 'chevrons-right' : 'chevrons-left'), h('span', {}, 'Recolher menu'));
      collapseBtn.title = now ? 'Expandir menu' : 'Recolher menu';
    };
    const collapseBtn = h('button', { class: 'side-btn collapse-btn', onclick: toggleCollapse, title: collapsed ? 'Expandir menu' : 'Recolher menu' },
      icon(collapsed ? 'chevrons-right' : 'chevrons-left'), h('span', {}, 'Recolher menu'));
    shell.append(
      h('nav', { class: 'side', 'aria-label': 'Menu principal' },
        h('div', { class: 'brand' },
          branding.logoUrl ? h('img', { class: 'brand-logo', src: branding.logoUrl, alt: branding.companyName }) : null,
          h('span', { class: 'brand-mark' + (branding.logoUrl ? ' hidden' : '') }, initials(branding.companyName)),
          branding.logoUrl ? null : h('span', { class: 'brand-name' }, branding.companyName)),
        groups.map((g) => h('div', { class: 'nav' }, h('div', { class: 'nav-label' }, g),
          visible.filter((p) => p[4] === g).map(([id, label]) => h('a', { href: '#/' + id, class: id === active ? 'active' : null, title: label,
            onclick: () => shell.classList.remove('mobile-open') }, icon(menuIcon(id)), h('span', {}, label))))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'side-foot' },
          h('button', { class: 'side-btn', title: dark ? 'Tema claro' : 'Tema escuro', onclick: () => { prefs.set('theme', dark ? 'light' : 'dark'); applyTheme(); route(); } },
            icon(dark ? 'sun' : 'moon'), h('span', {}, dark ? 'Tema claro' : 'Tema escuro')),
          collapseBtn,
          h('div', { class: 'who', title: me.name }, h('span', { class: 'avatar' }, initials(me.name)),
            h('div', { class: 'who-text' }, h('b', {}, me.name), h('span', {}, ROLE_LABEL[me.role] || me.role))),
          h('button', { class: 'side-btn', title: 'Sair', onclick: async () => { await api('/logout', { method: 'POST' }).catch(() => {}); me = null; showLogin(); } },
            icon('logout'), h('span', {}, 'Sair')))),
      h('div', {},
        h('div', { class: 'mobile-bar' },
          h('button', { class: 'btn secondary icon-only', 'aria-label': 'Abrir menu', onclick: () => shell.classList.add('mobile-open') }, icon('menu')),
          h('b', {}, branding.companyName)),
        actingBanner(), billingBanner(),
        h('main', { class: 'main' }, content)));
    shell.addEventListener('click', (e) => { if (e.target === shell) shell.classList.remove('mobile-open'); });
    root.replaceChildren(shell);
  }

  async function route() {
    document.querySelectorAll('.modal-bg').forEach((m) => m.remove()); // janela aberta não sobrevive à troca de página
    const reset = /^#\/redefinir\/([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
    if (reset) return showReset(reset[1]);
    if (location.hash === '#/cadastro' && !me) return showSignup();
    if (!me) { try { await loadMe(); } catch { return; } }
    const [, name = 'dashboard', param] = location.hash.split('/');
    const visible = PAGES.filter((p) => p[0] === 'conta' || p[0] === 'manual' || canSee(p));
    const page = visible.find((p) => p[0] === name) || (locked() ? visible.find((p) => p[0] === 'faturamento') : null) || visible[0];
    const container = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
    layout(page[0], container);
    try { container.replaceChildren(await page[2](param)); } catch (e) { if (e.message !== '401') container.replaceChildren(h('div', { class: 'card bad' }, e.message)); }
  }
  window.addEventListener('hashchange', route);

  // No celular as linhas das tabelas viram cartões; cada célula ganha o nome da coluna (CSS usa data-label).
  let labelPending = false;
  const labelTables = () => {
    labelPending = false;
    document.querySelectorAll('table').forEach((t) => {
      const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      if (!heads.length) return;
      t.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => {
        if (td.colSpan > 1 || td.dataset.label !== undefined) return;
        td.dataset.label = heads[i] || '';
      }));
    });
  };
  new MutationObserver(() => { if (!labelPending) { labelPending = true; requestAnimationFrame(labelTables); } })
    .observe(document.body, { childList: true, subtree: true });

  // Cabeçalho padrão das páginas: título, subtítulo e botões.
  const pageHead = (title, sub, ...actions) => h('div', { class: 'topbar' },
    h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, ...actions));

  async function branches(force) { if (force || !cache.branches) cache.branches = await api('/branches'); return cache.branches; }
  async function surveys(force) { if (force || !cache.surveys) cache.surveys = await api('/surveys'); return cache.surveys; }

  // ------------------------------------------------------------ filtros reutilizáveis
  function filterBar(state, onChange, { withSurvey = true } = {}) {
    const from = h('input', { type: 'date', value: state.from });
    const to = h('input', { type: 'date', value: state.to });
    const br = h('select', {}, h('option', { value: '' }, 'Todas as unidades'), cache.branches.map((b) => h('option', { value: String(b.id) }, b.name)));
    br.value = state.branchId || '';
    const sv = h('select', {}, h('option', { value: '' }, 'Todas as pesquisas'), cache.surveys.map((s) => h('option', { value: String(s.id) }, s.title)));
    sv.value = state.surveyId || '';
    const ch = h('select', {}, h('option', { value: '' }, 'Tablet e QR Code'), h('option', { value: 'tablet' }, 'Só tablet'), h('option', { value: 'link' }, 'Só QR Code / link'));
    ch.value = state.channel || '';
    const uf = h('select', {}, h('option', { value: '' }, 'Todos os estados'), UFS.map((u) => h('option', { value: u }, u)),
      h('option', { value: '_fora' }, 'Fora do Brasil'), h('option', { value: '_sem' }, 'QR Code sem localização'));
    uf.value = state.uf || '';
    const apply = () => { Object.assign(state, { from: from.value, to: to.value, branchId: br.value, surveyId: sv.value, channel: ch.value, uf: uf.value }); onChange(); };
    [from, to, br, sv, ch, uf].forEach((el) => el.addEventListener('change', apply));
    return h('div', { class: 'filters card' },
      h('label', { class: 'f' }, 'De', from), h('label', { class: 'f' }, 'Até', to),
      h('label', { class: 'f' }, 'Unidade', br), withSurvey ? h('label', { class: 'f' }, 'Pesquisa', sv) : null, h('label', { class: 'f' }, 'Canal', ch), h('label', { class: 'f' }, 'Estado do cliente', uf));
  }
  const qs = (state) => new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString();
  const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
  const filterState = { from: isoDay(new Date(Date.now() - 29 * 86400000)), to: isoDay(new Date()), branchId: '', surveyId: '', channel: '', uf: '' };

  // ------------------------------------------------------------ dashboard
  async function pageDashboard() {
    await Promise.all([branches(), surveys()]);
    const body = h('div');
    const load = async () => {
      body.replaceChildren(h('p', { class: 'muted' }, 'Carregando…'));
      const s = await api('/stats?' + qs(filterState));
      body.replaceChildren(renderStats(s));
    };
    await load();
    return h('div', {}, pageHead('Visão geral', 'Indicador NPS e satisfação das unidades', exportButtons()), filterBar(filterState, load), body);
  }

  function exportButtons() {
    return [
      h('button', { class: 'btn secondary', onclick: () => { location.href = '/api/admin/responses.csv?' + qs(filterState); } }, icon('download', 18), 'CSV'),
      h('button', { class: 'btn', onclick: () => { toast('Gerando PowerPoint…'); location.href = '/api/admin/report.pptx?' + qs(filterState); } }, icon('slides', 18), 'Exportar PowerPoint'),
    ];
  }

  function npsStack(o) {
    const t = o.total || 1;
    const bar = h('div', { class: 'stack', title: `Promotores ${o.promoters} · Neutros ${o.passives} · Detratores ${o.detractors}` },
      h('span', { class: 'p' }), h('span', { class: 'n' }), h('span', { class: 'd' }));
    [o.promoters, o.passives, o.detractors].forEach((v, i) => { bar.children[i].style.width = (v / t) * 100 + '%'; });
    return bar;
  }

  function renderStats(s) {
    const o = s.overall;
    const pct = (v) => (o.total ? Math.round((v / o.total) * 100) + '%' : '—');
    const kpi = (ic, cls, label, value, valueCls, hint) => h('div', { class: 'card kpi' },
      h('div', { class: 'kpi-icon ' + cls }, icon(ic, 22)),
      h('div', {}, h('div', { class: 'label' }, label), h('div', { class: 'value ' + valueCls }, value), hint ? h('div', { class: 'small muted' }, hint) : null));
    const kpis = h('div', { class: 'grid k4' },
      kpi('gauge', '', 'NPS', fmtNps(o.nps), npsClass(o.nps), o.total ? `${o.total.toLocaleString('pt-BR')} notas de NPS` : 'Sem notas de NPS'),
      kpi('inbox', '', 'Respostas', s.totalResponses.toLocaleString('pt-BR'), '', 'pesquisas concluídas'),
      kpi('thumbs', 'good', 'Promotores', pct(o.promoters), 'good', 'notas 9 e 10'),
      kpi('activity', 'bad', 'Detratores', pct(o.detractors), 'bad', 'notas de 0 a 6'));

    const maxN = Math.max(1, ...s.scoreDist.map((d) => d.n));
    const dist = h('div', { class: 'bars' }, Array.from({ length: 11 }, (_, n) => {
      const c = s.scoreDist.find((d) => d.score === n)?.n || 0;
      const col = h('div'); col.style.height = (c / maxN) * 100 + '%';
      col.style.background = n <= 6 ? 'var(--bad)' : n <= 8 ? 'var(--neutral)' : 'var(--good)';
      return h('div', { class: 'bar', title: `${c} notas ${n}` }, h('small', {}, c || ''), col, h('b', {}, n));
    }));

    const byBranch = h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Unidade'), h('th', {}, 'Respostas'), h('th', {}, 'NPS'), h('th', {}, 'Composição'))),
      h('tbody', {}, s.byBranch.length ? s.byBranch.map((b) => h('tr', {},
        h('td', {}, b.name), h('td', {}, b.responses), h('td', { class: npsClass(b.nps) }, h('b', {}, fmtNps(b.nps))), h('td', {}, b.total ? npsStack(b) : '—')))
        : h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'Nenhuma resposta no período.')))));

    const byQuestion = s.byQuestion.length ? s.byQuestion.map((q) => h('div', { class: 'hbar' },
      h('span', { title: q.survey }, q.text), npsStack(q), h('b', { class: npsClass(q.nps) }, fmtNps(q.nps))))
      : h('p', { class: 'muted' }, 'Nenhuma pergunta marcada para NPS recebeu respostas.');

    return h('div', {}, kpis,
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Evolução diária'), trendChart(s.trend)),
        h('div', { class: 'card' }, h('h2', {}, 'Distribuição das notas (0 a 10)'), dist)),
      rankingCard(s), regionCard(s),
      h('div', { class: 'card' }, h('h2', {}, 'NPS por unidade'), byBranch,
        h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'lp' }), 'Promotores'), h('span', {}, h('i', { class: 'ln' }), 'Neutros'), h('span', {}, h('i', { class: 'ld' }), 'Detratores'))),
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'NPS por pergunta marcada'), byQuestion),
        h('div', { class: 'card comments-card' }, h('h2', {}, 'Comentários recentes'), s.comments.length ? s.comments.map((c) => h('div', { class: 'comment' },
          h('span', { class: 'comment-icon' }, icon('message', 16)),
          h('div', {}, h('div', {}, c.comment), h('div', { class: 'small muted' }, `${c.branch} · ${fmtDate(c.submitted_at)}`)))) : h('p', { class: 'muted' }, 'Sem comentários.'))));
  }

  // De onde vieram as respostas do QR Code (somente quem autorizou a localização).
  function regionCard(s) {
    if (!s.byRegion?.length && !s.linkNoGeo) return null;
    const table = (head, rows, empty) => h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: String(head.length), class: 'empty' }, empty)))));
    const nps = (r) => h('td', { class: npsClass(r.nps) }, h('b', {}, fmtNps(r.nps)));
    return h('div', { class: 'card' }, h('h2', {}, 'Origem das respostas pelo QR Code'),
      h('div', { class: 'grid c2' },
        table(['Estado', 'Região', 'Respostas', 'NPS'], (s.byRegion || []).map((r) => h('tr', {}, h('td', {}, h('b', {}, r.place)), h('td', {}, r.region), h('td', {}, r.responses), nps(r))), 'Sem localização no período.'),
        table(['Cidade (mais próxima)', 'UF', 'Respostas', 'NPS'], (s.byCity || []).map((r) => h('tr', {}, h('td', {}, h('b', {}, r.city)), h('td', {}, r.uf), h('td', {}, r.responses), nps(r))), 'Sem cidades identificadas.')),
      h('p', { class: 'small muted' }, `${s.linkNoGeo || 0} respostas do QR Code sem localização (o cliente não autorizou ou o aparelho não informou). Cidade = município do IBGE mais próximo do ponto informado; o ponto é guardado com ~1 km de precisão.`));
  }

  // Ranking das unidades com a meta de NPS de cada uma.
  function rankingCard(s) {
    if (!s.ranking.length) return null;
    const medal = ['🥇', '🥈', '🥉'];
    return h('div', { class: 'card' }, h('h2', {}, 'Ranking das unidades'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Unidade'), h('th', {}, 'NPS'), h('th', {}, 'Meta'), h('th', {}, 'Situação'), h('th', {}, 'Respostas'))),
        h('tbody', {}, s.ranking.map((b) => h('tr', {},
          h('td', {}, h('b', {}, medal[b.position - 1] || `${b.position}º`)),
          h('td', {}, b.name),
          h('td', { class: npsClass(b.nps) }, h('b', {}, fmtNps(b.nps))),
          h('td', {}, b.goal === null ? '—' : fmtNps(b.goal)),
          h('td', {}, b.goalMet === null ? h('span', { class: 'muted small' }, 'sem meta') : b.goalMet
            ? h('span', { class: 'badge ok' }, icon('check', 12), 'Meta atingida') : h('span', { class: 'badge off' }, `Faltam ${(b.goal - b.nps).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} pts`)),
          h('td', {}, b.responses)))))));
  }

  function trendChart(trend) {
    if (!trend.length) return h('p', { class: 'muted' }, 'Sem dados no período.');
    const W = 600, H = 200, P = 28;
    const maxR = Math.max(1, ...trend.map((t) => t.responses));
    const x = (i) => P + (trend.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (trend.length - 1));
    const bw = Math.max(2, Math.min(24, (W - 2 * P) / trend.length - 4));
    const yN = (v) => H - P - ((v + 100) / 200) * (H - 2 * P);
    const svg = h('svg', { svg: true, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Evolução de respostas e NPS' });
    svg.append(h('line', { svg: true, x1: P, x2: W - P, y1: yN(0), y2: yN(0), class: 'zero', 'stroke-dasharray': '4 4' }));
    trend.forEach((t, i) => {
      const bh = (t.responses / maxR) * (H - 2 * P) * 0.6;
      svg.append(h('rect', { svg: true, x: x(i) - bw / 2, y: H - P - bh, width: bw, height: bh, class: 'tbar', rx: 3 },
        h('title', { svg: true }, `${t.day}: ${t.responses} respostas, NPS ${fmtNps(t.nps)}`)));
    });
    const pts = trend.map((t, i) => (t.nps === null ? null : `${x(i)},${yN(t.nps)}`)).filter(Boolean);
    if (pts.length) svg.append(h('polyline', { svg: true, points: pts.join(' '), class: 'tline' }));
    trend.forEach((t, i) => { if (t.nps !== null) svg.append(h('circle', { svg: true, cx: x(i), cy: yN(t.nps), r: 3.5, class: 'tpt' })); });
    svg.append(h('text', { svg: true, x: 2, y: yN(100) + 4, 'font-size': 11, class: 'tlabel' }, '+100'));
    svg.append(h('text', { svg: true, x: 2, y: yN(-100) + 4, 'font-size': 11, class: 'tlabel' }, '-100'));
    return h('div', { class: 'chart' }, svg, h('div', { class: 'legend' }, h('span', {}, '▮ Respostas por dia'), h('span', {}, '— NPS do dia')));
  }

  // ------------------------------------------------------------ casos (clientes insatisfeitos)
  const CASE_BADGE = { aberto: 'off', em_contato: 'warn', resolvido: 'ok', sem_retorno: '' };
  const caseState = { status: 'pendentes', branchId: '', mine: '' };

  async function pageCases(param) {
    await branches();
    const body = h('div');
    const kpis = h('div');
    const load = async (page = 1) => {
      const q = new URLSearchParams(Object.entries({ ...caseState, page }).filter(([, v]) => v)).toString();
      const [sum, r] = await Promise.all([api('/cases/summary?' + qs({ branchId: caseState.branchId })), api('/cases?' + q)]);
      const k = (ic, cls, label, value, hint) => h('div', { class: 'card kpi' }, h('div', { class: 'kpi-icon ' + cls }, icon(ic, 22)),
        h('div', {}, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'small muted' }, hint) : null));
      kpis.replaceChildren(h('div', { class: 'grid k4' },
        k('bell', 'bad', 'Abertos', String(sum.abertos || 0), 'aguardando ação'),
        k('message', '', 'Em contato', String(sum.em_contato || 0)),
        k('check', 'good', 'Resolvidos', String(sum.resolvidos || 0), sum.total ? `${Math.round(((sum.resolvidos || 0) / sum.total) * 100)}% dos casos` : null),
        k('history', '', 'Tempo médio até resolver', sum.avgHours === null ? '—' : `${sum.avgHours.toLocaleString('pt-BR')} h`)));
      const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      body.replaceChildren(h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Quando'), h('th', {}, 'Unidade'), h('th', {}, 'Nota'), h('th', {}, 'Comentário'), h('th', {}, 'Status'), h('th', {}, 'Responsável'), h('th', {}))),
        h('tbody', {}, r.rows.length ? r.rows.map((c) => h('tr', {},
          h('td', {}, fmtDate(c.created_at), c.channel === 'link' ? h('div', { class: 'small muted' }, 'via QR Code') : null),
          h('td', {}, c.branch), h('td', {}, h('b', { class: 'bad' }, c.min_score)),
          h('td', { class: 'small' }, c.comment ? (c.comment.length > 90 ? c.comment.slice(0, 90) + '…' : c.comment) : h('span', { class: 'muted' }, '—'),
            c.has_contact ? h('div', {}, h('span', { class: 'badge ok' }, 'Pediu contato')) : null),
          h('td', {}, h('span', { class: 'badge ' + CASE_BADGE[c.status] }, r.statuses[c.status])),
          h('td', { class: 'small' }, c.assignee || h('span', { class: 'muted' }, 'ninguém')),
          h('td', {}, h('a', { class: 'btn secondary sm', href: '#/casos/' + c.id }, 'Abrir'))))
          : h('tr', {}, h('td', { colspan: '7', class: 'empty' }, 'Nenhum caso com esses filtros. 🎉')))),
      h('div', { class: 'row' },
        h('button', { class: 'btn secondary sm', disabled: page <= 1, onclick: () => load(page - 1) }, '‹ Anterior'),
        h('span', { class: 'small muted' }, `Página ${page} de ${pages}`),
        h('button', { class: 'btn secondary sm', disabled: page >= pages, onclick: () => load(page + 1) }, 'Próxima ›'))));
    };
    const st = h('select', { onchange: (e) => { caseState.status = e.target.value; load(); } },
      [['pendentes', 'Pendentes (abertos e em contato)'], ['', 'Todos'], ['aberto', 'Abertos'], ['em_contato', 'Em contato'], ['resolvido', 'Resolvidos'], ['sem_retorno', 'Sem retorno']]
        .map(([v, l]) => h('option', { value: v }, l)));
    st.value = caseState.status;
    const br = h('select', { onchange: (e) => { caseState.branchId = e.target.value; load(); } }, h('option', { value: '' }, 'Todas as unidades'), cache.branches.map((b) => h('option', { value: String(b.id) }, b.name)));
    br.value = caseState.branchId;
    const mine = h('input', { type: 'checkbox', checked: caseState.mine === '1', onchange: (e) => { caseState.mine = e.target.checked ? '1' : ''; load(); } });
    await load();
    if (param) setTimeout(() => openCase(Number(param), load), 0);
    return h('div', {}, pageHead('Casos', 'Clientes que deram nota de 0 a 6 — acompanhe até resolver'),
      kpis, h('div', { class: 'filters card' }, h('label', { class: 'f' }, 'Status', st), h('label', { class: 'f' }, 'Unidade', br), h('label', { class: 'chk' }, mine, 'Só os meus')), body);
  }

  async function openCase(caseId, reload) {
    let c;
    try { c = await api('/cases/' + caseId); } catch (ex) { toast(ex.message, true); return; }
    const status = h('select', {}, Object.entries(c.statuses).map(([v, l]) => h('option', { value: v }, l)));
    status.value = c.status;
    const who = h('select', {}, h('option', { value: '' }, '— ninguém —'), c.assignable.map((u) => h('option', { value: String(u.id) }, u.name)));
    who.value = c.assignee_id ? String(c.assignee_id) : '';
    const note = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'O que foi feito? Ex.: liguei para o cliente, ofereci desconto…' });
    const contact = c.contact ? h('div', { class: 'contact-box' },
      h('b', {}, 'Cliente pediu contato'), h('div', {}, c.contact.name || '(sem nome)'),
      c.contact.phone ? h('div', {}, h('a', { href: 'tel:+' + (c.contact.phone.length <= 11 ? '55' : '') + c.contact.phone }, c.contact.phone),
        ' · ', h('a', { href: 'https://wa.me/' + (c.contact.phone.length <= 11 ? '55' : '') + c.contact.phone, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp')) : null,
      c.contact.email ? h('div', {}, h('a', { href: 'mailto:' + c.contact.email }, c.contact.email)) : null,
      h('div', { class: 'small muted' }, 'Consentimento em ' + fmtDate(c.contact.consentAt))) : h('p', { class: 'small muted' }, 'O cliente não deixou contato.');
    modal(`Caso #${c.id} · ${c.branch}`, h('div', {},
      h('p', { class: 'small muted' }, `${fmtDate(c.submitted_at)} · ${c.survey}${c.channel === 'link' ? ' · via QR Code' : c.device ? ' · ' + c.device : ''}`),
      h('ul', { class: 'answers' }, c.answers.map((a) => h('li', {}, h('b', {}, qLabel(a.question)), a.value))),
      contact,
      h('h2', {}, 'Histórico'),
      c.notes.length ? h('ul', { class: 'timeline' }, c.notes.map((n) => h('li', {},
        h('div', { class: 'small muted' }, `${fmtDate(n.at)} · ${n.user || 'sistema'}${n.status_to ? ` · ${c.statuses[n.status_from] || n.status_from} → ${c.statuses[n.status_to]}` : ''}`),
        n.text ? h('div', {}, n.text) : null))) : h('p', { class: 'small muted' }, 'Nenhuma ação registrada ainda.'),
      h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Status', status), h('label', { class: 'f' }, 'Responsável', who)),
      h('label', { class: 'f' }, 'Anotação', note)),
    [{ label: 'Salvar', onClick: async (close) => {
      try {
        await api('/cases/' + c.id, { method: 'PUT', body: { status: status.value, assigneeId: who.value ? Number(who.value) : null, note: note.value } });
        close(); toast('Caso atualizado.'); if (location.hash !== '#/casos') history.replaceState(null, '', '#/casos'); reload();
      } catch (ex) { toast(ex.message, true); }
    } }]);
  }

  // ------------------------------------------------------------ respostas
  // Onde a resposta foi dada: QR Code = região informada pelo cliente (se ele autorizou); tablet = cidade da unidade.
  function locationBadge(x) {
    if (x.channel !== 'link') return h('div', { class: 'small muted loc' }, icon('map-pin', 13), x.branch_city ? `${x.branch_city} (loja)` : 'Cidade da unidade não cadastrada');
    if (!x.geo_region) return h('div', { class: 'small muted loc' }, icon('map-pin', 13), 'Local não informado');
    const place = x.geo_region === 'Fora do Brasil' ? 'Fora do Brasil' : [x.geo_city, x.geo_uf].filter(Boolean).join('/') + ` · ${x.geo_region}`;
    const link = x.geo_lat !== null && x.geo_lat !== undefined
      ? h('a', { class: 'small', target: '_blank', rel: 'noopener noreferrer', title: 'Abrir no mapa (ponto aproximado, ~1 km)',
        href: `https://www.openstreetmap.org/?mlat=${x.geo_lat}&mlon=${x.geo_lng}#map=11/${x.geo_lat}/${x.geo_lng}` }, ' mapa') : null;
    return h('div', { class: 'small loc' }, icon('map-pin', 13), place, link);
  }

  // Dispositivo: tablet = nome cadastrado; QR Code = tipo de aparelho e navegador do cliente.
  function deviceBadge(x) {
    const name = x.device_label || x.device;
    return h('div', {}, h('div', {}, icon(x.channel === 'link' ? 'phone' : 'tablet', 14), ' ', h('b', {}, name || (x.channel === 'link' ? 'Aparelho não identificado' : 'Tablet removido'))),
      h('div', { class: 'small muted' }, x.channel === 'link' ? 'QR Code (celular do cliente)' : 'Tablet da loja'));
  }

  async function pageResponses() {
    await Promise.all([branches(), surveys()]);
    const isAdmin = me.can('responses.delete'); // Administrador (e Master dentro da empresa); o servidor também confere
    let page = 1;
    const body = h('div');
    // Apaga tudo o que o filtro atual mostra (limpeza dos testes). Exige digitar EXCLUIR.
    const deleteFiltered = (total) => {
      const word = h('input', { placeholder: 'EXCLUIR', autocomplete: 'off' });
      const conf = confirmFields();
      modal('Excluir respostas filtradas', h('div', {},
        h('p', {}, `Serão excluídas definitivamente ${total} respostas (com os casos e anotações ligados a elas), conforme os filtros da tela: período, unidade, pesquisa e canal.`),
        h('p', { class: 'small muted' }, 'Isso não pode ser desfeito. Faça um backup antes se tiver dúvida. Digite EXCLUIR para confirmar.'), word, conf.el),
      [{ label: 'Excluir definitivamente', cls: 'danger', onClick: async (close) => {
        try {
          const f = Object.fromEntries(Object.entries(filterState).filter(([, v]) => v));
          const r = await api('/responses/delete-filtered', { method: 'POST', body: { confirm: word.value.trim(), filter: f, ...conf.value() } });
          close(); toast(`${r.deleted} respostas excluídas.`); page = 1; load();
        } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    const load = async () => {
      const r = await api(`/responses?${qs(filterState)}&page=${page}`);
      const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      body.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('p', { class: 'muted' }, `${r.total} respostas encontradas`),
          isAdmin && r.total ? h('button', { class: 'btn danger sm', onclick: () => deleteFiltered(r.total) }, icon('trash', 14), 'Excluir todas as filtradas') : null),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Unidade'), h('th', {}, 'Localização'), h('th', {}, 'Dispositivo'), h('th', {}, 'Pesquisa'), h('th', {}, 'Respostas'), isAdmin ? h('th', {}) : null)),
          h('tbody', {}, r.rows.length ? r.rows.map((x) => h('tr', {},
            h('td', {}, fmtDate(x.submitted_at), x.lang && x.lang !== 'pt' ? h('div', {}, h('span', { class: 'badge' }, x.lang.toUpperCase())) : null),
            h('td', {}, x.branch),
            h('td', {}, locationBadge(x)),
            h('td', {}, deviceBadge(x)), h('td', {}, x.survey),
            h('td', {}, h('ul', { class: 'answers' }, (x.answers || []).map((a) => h('li', {},
              h('b', {}, qLabel(a.question)), a.value, a.is_nps ? h('span', { class: 'badge nps' }, ' NPS') : null)))),
            isAdmin ? h('td', {}, h('button', { class: 'btn danger sm', onclick: async () => {
              if (!confirm('Excluir esta resposta definitivamente? Isso não pode ser desfeito.')) return;
              try { await api(`/responses/${x.id}`, { method: 'DELETE' }); toast('Resposta excluída.'); load(); } catch (ex) { toast(ex.message, true); }
            } }, icon('trash', 14), 'Excluir')) : null))
            : h('tr', {}, h('td', { colspan: '7', class: 'empty' }, 'Nenhuma resposta.'))))),
        h('div', { class: 'row' },
          h('button', { class: 'btn secondary sm', disabled: page <= 1, onclick: () => { page--; load(); } }, '‹ Anterior'),
          h('span', { class: 'small muted' }, `Página ${page} de ${pages}`),
          h('button', { class: 'btn secondary sm', disabled: page >= pages, onclick: () => { page++; load(); } }, 'Próxima ›'))));
    };
    await load();
    return h('div', {},
      pageHead('Respostas', 'Todas as pesquisas recebidas, dos tablets e dos QR Codes', exportButtons()),
      filterBar(filterState, () => { page = 1; load(); }), body);
  }

  // ------------------------------------------------------------ pesquisas
  async function pageSurveys(param) {
    if (param) return surveyEditor(param === 'nova' ? null : Number(param));
    const list = await surveys(true);
    return h('div', {},
      pageHead('Pesquisas', 'Perguntas exibidas nos tablets e marcação do NPS',
        me.can('surveys.manage') ? h('a', { class: 'btn', href: '#/pesquisas/nova' }, icon('plus', 18), 'Nova pesquisa') : null),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Título'), h('th', {}, 'Perguntas'), h('th', {}, 'NPS'), h('th', {}, 'Respostas'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, list.length ? list.map((s) => h('tr', {},
          h('td', {}, h('b', {}, s.title), h('div', { class: 'small muted' }, 'Atualizada ' + fmtDate(s.updated_at))),
          h('td', {}, s.questions), h('td', {}, s.nps_questions ? h('span', { class: 'badge nps' }, `${s.nps_questions} marcada(s)`) : h('span', { class: 'badge warn' }, 'nenhuma')),
          h('td', {}, s.responses), h('td', {}, h('span', { class: 'badge ' + (s.active ? 'ok' : 'off') }, s.active ? 'Ativa' : 'Inativa')),
          h('td', {}, h('div', { class: 'row' },
            h('a', { class: 'btn secondary sm', href: '#/pesquisas/' + s.id }, s.editable ? 'Editar' : 'Ver'),
            me.can('surveys.manage') ? h('button', { class: 'btn secondary sm', onclick: async () => {
              const r = await api(`/surveys/${s.id}/duplicate`, { method: 'POST' }); toast('Pesquisa duplicada.'); location.hash = '#/pesquisas/' + r.id;
            } }, 'Duplicar') : null))))
          : h('tr', {}, h('td', { colspan: '6', class: 'empty' }, 'Nenhuma pesquisa criada.'))))),
      await campaignsCard(list));
  }

  // Campanhas: trocam a pesquisa de uma unidade (ou de todas) por um período, e voltam sozinhas à padrão.
  async function campaignsCard(svs) {
    const [rows, brs] = await Promise.all([api('/schedules'), branches()]);
    const now = Date.now();
    const status = (c) => (c.ends_at <= now ? h('span', { class: 'badge' }, 'Encerrada') : c.starts_at <= now ? h('span', { class: 'badge ok' }, 'No ar') : h('span', { class: 'badge warn' }, 'Agendada'));
    const add = () => {
      const sv = h('select', {}, svs.filter((s) => s.active).map((s) => h('option', { value: String(s.id) }, s.title)));
      const br = h('select', {}, h('option', { value: '' }, 'Todas as unidades'), brs.map((b) => h('option', { value: String(b.id) }, b.name)));
      const st = h('input', { type: 'datetime-local' }); const en = h('input', { type: 'datetime-local' });
      modal('Agendar campanha', h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Pesquisa', sv), h('label', { class: 'f' }, 'Unidade', br),
        h('label', { class: 'f' }, 'Início', st), h('label', { class: 'f' }, 'Fim', en),
        h('p', { class: 'small muted' }, 'O dia e a hora valem no fuso da unidade escolhida (ou no da empresa, quando for "Todas as unidades").')),
      [{ label: 'Agendar', onClick: async (close) => {
        try { await api('/schedules', { method: 'POST', body: { surveyId: Number(sv.value), branchId: br.value ? Number(br.value) : null, startsAt: st.value, endsAt: en.value } }); close(); toast('Campanha agendada.'); route(); } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    return h('div', { class: 'card' },
      h('div', { class: 'topbar' }, h('div', {}, h('h2', {}, 'Campanhas agendadas'), h('div', { class: 'small muted' }, 'Durante o período, a pesquisa da campanha substitui a padrão; depois, tudo volta sozinho.')),
        me.can('schedules.manage') ? h('button', { class: 'btn secondary', onclick: add }, icon('calendar', 16), 'Agendar campanha') : null),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Pesquisa'), h('th', {}, 'Unidade'), h('th', {}, 'Período'), h('th', {}, 'Situação'), h('th', {}))),
        h('tbody', {}, rows.map((c) => h('tr', {}, h('td', {}, c.survey), h('td', {}, c.branch || 'Todas'), h('td', { class: 'small' }, `${fmtDateTz(c.starts_at, c.tz)} → ${fmtDateTz(c.ends_at, c.tz)}`),
          h('td', {}, status(c)), h('td', {}, me.can('schedules.manage') ? h('button', { class: 'btn secondary sm', onclick: async () => {
            if (!confirm('Excluir esta campanha?')) return;
            try { await api('/schedules/' + c.id, { method: 'DELETE' }); route(); } catch (ex) { toast(ex.message, true); }
          } }, 'Excluir') : null))))))
        : h('p', { class: 'muted small' }, 'Nenhuma campanha agendada.'));
  }

  const NEW_SURVEY = {
    title: '', welcome_title: 'Sua opinião é muito importante!', welcome_text: 'Leva menos de 1 minuto.',
    thanks_title: 'Obrigado!', thanks_text: 'Sua resposta nos ajuda a melhorar.', thanks_seconds: 8, idle_seconds: 45, active: 1,
    thanks_media_id: null, thanks_media: null, has_responses: false,
    questions: [{ text: 'Em uma escala de 0 a 10, o quanto você recomendaria nossa empresa a um amigo ou familiar?', type: 'nps', required: true, is_nps: true, options: [] }],
  };

  function defaultStyleName() {
    const d = settings?.defaultDisplay || 'numbers';
    return d === 'numbers' ? 'números coloridos' : d === 'faces' ? 'carinhas coloridas' : (window.Icons.ICONS[settings.ratingIcon]?.label || 'ícones').toLowerCase();
  }

  async function surveyEditor(sid) {
    const s = sid ? await api('/surveys/' + sid) : structuredClone(NEW_SURVEY);
    const ro = sid ? !s.editable : !me.can('surveys.manage'); // gestor: só pesquisas usadas apenas nas unidades dele
    const locked = s.has_responses;
    const f = {};
    const field = (key, label, type = 'text', extra = {}) => {
      const el = type === 'textarea' ? h('textarea', { rows: '2', ...extra }) : h('input', { type, ...extra });
      el.value = s[key] ?? ''; el.disabled = ro; f[key] = el;
      return h('label', { class: 'f' }, label, el);
    };
    const qList = h('div');
    // Chave interna estável: condições continuam apontando para a pergunta certa mesmo após reordenar.
    let keySeq = 0;
    const questions = s.questions.map((q) => ({ ...q, options: [...(q.options || [])], i18n: structuredClone(q.i18n || {}), _k: ++keySeq }));
    questions.forEach((q) => { if (q.show_if && questions[q.show_if.ref]) q.cond = { k: questions[q.show_if.ref]._k, op: q.show_if.op, value: q.show_if.value }; });
    const langs = new Set(s.languages || ['pt']);
    const sI18n = structuredClone(s.i18n || {});
    const extraLangs = () => ['en', 'es'].filter((l) => langs.has(l));
    const LNAME = { en: 'Inglês', es: 'Espanhol' };

    // Editor de condição: "mostrar somente se a pergunta N ..."
    const COND_TYPES = ['nps', 'scale5', 'yesno', 'single', 'multi'];
    function condEditor(q, i) {
      if (i === 0) return null;
      const prev = questions.slice(0, i).map((x, j) => ({ x, j })).filter(({ x }) => COND_TYPES.includes(x.type));
      if (!prev.length) return null;
      const target = q.cond ? questions.find((x) => x._k === q.cond.k) : null;
      const valid = target && questions.indexOf(target) < i && COND_TYPES.includes(target.type);
      const sel = h('select', { disabled: ro, onchange: (e) => {
        const t = questions.find((x) => String(x._k) === e.target.value);
        q.cond = t ? { k: t._k, ...defaultCond(t) } : null; renderQuestions();
      } }, h('option', { value: '' }, 'Mostrar sempre'), prev.map(({ x, j }) => h('option', { value: String(x._k) }, `Mostrar só se a pergunta ${j + 1}…`)));
      sel.value = valid ? String(target._k) : '';
      if (!valid) { if (q.cond) q.cond = null; return h('div', { class: 'row cond' }, icon('sliders', 16), sel); }
      let op; let val;
      if (target.type === 'nps' || target.type === 'scale5') {
        op = h('select', { disabled: ro, onchange: (e) => { q.cond.op = e.target.value; } }, [['lte', 'for menor ou igual a'], ['gte', 'for maior ou igual a'], ['eq', 'for igual a']].map(([v, l]) => h('option', { value: v }, l)));
        val = h('input', { type: 'number', min: target.type === 'nps' ? '0' : '1', max: target.type === 'nps' ? '10' : '5', value: q.cond.value, disabled: ro, oninput: (e) => { q.cond.value = Number(e.target.value); } });
      } else if (target.type === 'yesno') {
        op = h('span', { class: 'small muted' }, 'for');
        val = h('select', { disabled: ro, onchange: (e) => { q.cond.value = e.target.value; } }, h('option', { value: 'sim' }, 'Sim'), h('option', { value: 'nao' }, 'Não'));
      } else {
        op = h('span', { class: 'small muted' }, target.type === 'multi' ? 'incluir' : 'for');
        val = h('select', { disabled: ro, onchange: (e) => { q.cond.value = e.target.value; } }, target.options.map((o) => h('option', { value: o }, o)));
      }
      if (op.tagName === 'SELECT') op.value = q.cond.op;
      val.value = q.cond.value;
      return h('div', { class: 'row cond' }, icon('sliders', 16), sel, op, val);
    }
    function defaultCond(t) {
      if (t.type === 'nps') return { op: 'lte', value: 6 };
      if (t.type === 'scale5') return { op: 'lte', value: 2 };
      if (t.type === 'yesno') return { op: 'eq', value: 'nao' };
      return { op: t.type === 'multi' ? 'has' : 'eq', value: t.options[0] };
    }

    // Traduções de uma pergunta (aparece quando a pesquisa tem inglês/espanhol).
    function translations(q) {
      const ls = extraLangs();
      if (!ls.length) return null;
      return h('details', { class: 'tr' }, h('summary', {}, 'Traduções (' + ls.map((l) => LNAME[l]).join(', ') + ')'),
        ls.map((l) => {
          q.i18n[l] = q.i18n[l] || {};
          const t = q.i18n[l];
          return h('div', { class: 'form-grid' },
            h('label', { class: 'f' }, `Pergunta (${LNAME[l]})`, h('input', { value: t.text || '', disabled: ro, maxlength: '300', oninput: (e) => { t.text = e.target.value; } })),
            h('label', { class: 'f' }, `Apoio (${LNAME[l]})`, h('input', { value: t.help_text || '', disabled: ro, maxlength: '300', oninput: (e) => { t.help_text = e.target.value; } })),
            ['single', 'multi'].includes(q.type) ? h('label', { class: 'f' }, `Opções (${LNAME[l]}, uma por linha, na mesma ordem)`,
              h('textarea', { rows: String(q.options.length), disabled: ro, value: (t.options || []).join('\n'), oninput: (e) => { t.options = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); } })) : null);
        }));
    }

    function renderQuestions() {
      qList.replaceChildren(...questions.map((q, i) => {
        const text = h('input', { value: q.text, placeholder: 'Texto da pergunta', disabled: ro, oninput: (e) => { q.text = e.target.value; } });
        const help = h('input', { value: q.help_text || '', placeholder: 'Texto de apoio (opcional)', disabled: ro, oninput: (e) => { q.help_text = e.target.value; } });
        const type = h('select', { disabled: ro || locked, onchange: (e) => { q.type = e.target.value; if (q.type !== 'nps') q.is_nps = false; if (['single', 'multi'].includes(q.type) && q.options.length < 2) q.options = ['Opção 1', 'Opção 2']; renderQuestions(); } },
          Object.entries(questionTypes).map(([k, v]) => h('option', { value: k }, v)));
        type.value = q.type;
        const req = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: q.required, disabled: ro, onchange: (e) => { q.required = e.target.checked; } }), 'Obrigatória');
        const isScale = ['nps', 'scale5'].includes(q.type);
        const disp = h('select', { disabled: ro, title: 'Como a escala aparece no tablet — o valor gravado é sempre o número',
          onchange: (e) => { q.display = e.target.value; renderQuestions(); } },
          Object.entries(displays).map(([k, v]) => h('option', { value: k }, 'Aparência: ' + (k === 'default' ? `${v} (${defaultStyleName()})` : v))));
        disp.value = q.display || 'default';
        const iconPick = isScale && q.display === 'icons' ? h('div', { class: 'icon-grid' },
          h('button', { class: 'icon-choice' + (!q.icon ? ' selected' : ''), title: 'Padrão das configurações', disabled: ro, onclick: () => { q.icon = null; renderQuestions(); } }, h('span', { class: 'small' }, 'Padrão')),
          window.Icons.RATING_ICONS.map((k) => h('button', { class: 'icon-choice' + (q.icon === k ? ' selected' : ''), title: window.Icons.ICONS[k].label, disabled: ro,
            onclick: () => { q.icon = k; renderQuestions(); } }, icon(k, 20, { fill: q.icon === k })))) : null;
        const nps = h('label', { class: 'chk', title: 'Somente perguntas do tipo NPS (0 a 10) entram no cálculo' },
          h('input', { type: 'checkbox', checked: q.is_nps, disabled: ro || q.type !== 'nps', onchange: (e) => { q.is_nps = e.target.checked; renderQuestions(); } }), icon('star', 16, { fill: q.is_nps }), 'Entra na análise de NPS');
        const move = (d) => { const j = i + d; if (j < 0 || j >= questions.length) return; [questions[i], questions[j]] = [questions[j], questions[i]]; renderQuestions(); };
        const opts = ['single', 'multi'].includes(q.type) ? h('div', {},
          h('div', { class: 'small muted' }, 'Opções (uma por linha)'),
          h('textarea', { rows: String(Math.max(2, q.options.length)), disabled: ro || locked, value: q.options.join('\n'),
            oninput: (e) => { q.options = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); } })) : null;
        return h('div', { class: 'q-editor' + (q.is_nps ? ' nps-marked' : '') },
          h('div', { class: 'row' }, h('b', { class: 'q-num' }, String(i + 1)), text,
            ro ? null : h('button', { class: 'btn secondary sm', disabled: locked, onclick: () => move(-1), title: 'Subir' }, '↑'),
            ro ? null : h('button', { class: 'btn secondary sm', disabled: locked, onclick: () => move(1), title: 'Descer' }, '↓'),
            ro ? null : h('button', { class: 'btn danger sm', disabled: locked || questions.length === 1, onclick: () => { questions.splice(i, 1); renderQuestions(); } }, 'Remover')),
          h('div', { class: 'row', style: null }, help),
          h('div', { class: 'row' }, type, isScale ? disp : null, req, nps), iconPick ? h('div', { class: 'row' }, iconPick) : null, opts,
          condEditor(q, i), translations(q));
      }));
    }
    renderQuestions();

    // mídia de agradecimento
    let mediaId = s.thanks_media_id;
    const mediaPreview = h('div');
    const showMedia = (m) => {
      mediaPreview.replaceChildren();
      if (!m) return mediaPreview.append(h('span', { class: 'small muted' }, 'Nenhuma imagem ou vídeo.'));
      mediaPreview.append(m.mime.startsWith('video/')
        ? h('video', { class: 'preview-media', src: '/media/' + m.id, muted: true, autoplay: true, loop: true, playsinline: true })
        : h('img', { class: 'preview-media', src: '/media/' + m.id, alt: '' }));
      if (!ro) mediaPreview.append(h('button', { class: 'btn secondary sm', onclick: () => { mediaId = null; showMedia(null); } }, 'Remover mídia'));
    };
    showMedia(s.thanks_media);
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm', disabled: ro, onchange: async (e) => {
      const fl = e.target.files[0]; if (!fl) return;
      try {
        const r = await uploadMedia(fl);
        mediaId = r.id; showMedia({ id: r.id, mime: r.mime }); toast('Mídia enviada.');
      } catch (ex) { toast(ex.message, true); }
      e.target.value = '';
    } });

    const activeChk = h('input', { type: 'checkbox', checked: !!s.active, disabled: ro });
    // Remove traduções vazias e idiomas desligados antes de enviar.
    const cleanI18n = (o) => Object.fromEntries(Object.entries(o || {}).filter(([l]) => langs.has(l) && l !== 'pt')
      .map(([l, t]) => [l, Object.fromEntries(Object.entries(t).filter(([, v]) => (Array.isArray(v) ? v.length : v)))]).filter(([, t]) => Object.keys(t).length));
    const contactSel = h('select', { disabled: ro }, Object.entries(contactModes).map(([v, l]) => h('option', { value: v }, l)));
    contactSel.value = s.contact_mode || 'never';
    const langBox = h('div', { class: 'row' }, ['en', 'es'].map((l) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: langs.has(l), disabled: ro,
      onchange: (e) => { e.target.checked ? langs.add(l) : langs.delete(l); renderQuestions(); renderSurveyTr(); } }), LNAME[l])));
    const surveyTr = h('div');
    function renderSurveyTr() {
      surveyTr.replaceChildren(...extraLangs().map((l) => {
        sI18n[l] = sI18n[l] || {};
        const t = sI18n[l];
        const inp = (k, label, max) => h('label', { class: 'f' }, `${label} (${LNAME[l]})`, h('input', { value: t[k] || '', maxlength: String(max), disabled: ro, oninput: (e) => { t[k] = e.target.value; } }));
        return h('div', { class: 'form-grid' }, inp('welcome_title', 'Título inicial', 120), inp('welcome_text', 'Subtítulo', 300), inp('thanks_title', 'Agradecimento', 120), inp('thanks_text', 'Mensagem final', 300));
      }));
    }
    renderSurveyTr();
    const save = async () => {
      const body = {
        title: f.title.value, welcome_title: f.welcome_title.value, welcome_text: f.welcome_text.value,
        thanks_title: f.thanks_title.value, thanks_text: f.thanks_text.value, thanks_media_id: mediaId,
        thanks_seconds: Number(f.thanks_seconds.value), idle_seconds: Number(f.idle_seconds.value), active: activeChk.checked,
        contact_mode: contactSel.value,
        languages: ['pt', ...extraLangs()],
        i18n: cleanI18n(sI18n),
        questions: questions.map((q, i) => {
          const target = q.cond ? questions.findIndex((x) => x._k === q.cond.k) : -1;
          return { text: q.text, help_text: q.help_text || '', type: q.type, required: !!q.required, is_nps: !!q.is_nps, options: q.options,
            display: ['nps', 'scale5'].includes(q.type) ? (q.display || 'default') : undefined, icon: q.display === 'icons' ? q.icon || null : null,
            show_if: target >= 0 && target < i ? { ref: target, op: q.cond.op, value: q.cond.value } : null,
            i18n: cleanI18n(q.i18n) };
        }),
      };
      try {
        if (sid) await api('/surveys/' + sid, { method: 'PUT', body });
        else { const r = await api('/surveys', { method: 'POST', body }); location.hash = '#/pesquisas/' + r.id; }
        toast('Pesquisa salva.'); cache.surveys = null;
      } catch (ex) { toast(ex.message, true); }
    };

    return h('div', {},
      pageHead(sid ? 'Editar pesquisa' : 'Nova pesquisa', s.title || null,
        h('a', { class: 'btn secondary', href: '#/pesquisas' }, 'Voltar'), ro ? null : h('button', { class: 'btn', onclick: save }, 'Salvar pesquisa')),
      locked ? h('div', { class: 'card small' }, '🔒 Esta pesquisa já possui respostas: é possível corrigir textos e a marcação de NPS, mas não adicionar/remover perguntas ou mudar tipos. Para mudanças estruturais, use "Duplicar".') : null,
      h('div', { class: 'card' }, h('h2', {}, 'Dados gerais'), h('div', { class: 'form-grid' },
        field('title', 'Título interno', 'text', { maxlength: '120' }),
        h('label', { class: 'chk' }, activeChk, 'Pesquisa ativa'))),
      h('div', { class: 'card' }, h('h2', {}, 'Contato e idiomas'),
        h('div', { class: 'form-grid' },
          h('label', { class: 'f' }, 'Perguntar ao cliente se quer ser contatado', contactSel),
          h('div', {}, h('div', { class: 'small muted' }, 'Idiomas oferecidos no tablet (além do português)'), langBox)),
        h('p', { class: 'small muted' }, 'O contato só é gravado com autorização expressa do cliente (LGPD) e fica criptografado. As traduções vazias usam o texto em português.'),
        surveyTr),
      h('div', { class: 'card' }, h('h2', {}, 'Tela inicial do tablet'), h('div', { class: 'form-grid' },
        field('welcome_title', 'Título', 'text', { maxlength: '120' }), field('welcome_text', 'Subtítulo', 'textarea', { maxlength: '300' }),
        field('idle_seconds', 'Voltar ao início após inatividade (segundos)', 'number', { min: '15', max: '600' }))),
      h('div', { class: 'card' }, h('h2', {}, 'Perguntas'),
        h('p', { class: 'small muted' }, 'Marque "Entra na análise de NPS" nas perguntas de 0 a 10. A aparência (números, carinhas ou ícones) não muda o cálculo: o tablet sempre grava a nota de 0 a 10.'),
        qList,
        ro || locked ? null : h('button', { class: 'btn secondary', onclick: () => { questions.push({ text: '', type: 'scale5', required: true, is_nps: false, options: [], i18n: {}, _k: ++keySeq }); renderQuestions(); } }, '+ Adicionar pergunta')),
      h('div', { class: 'card' }, h('h2', {}, 'Tela de agradecimento'), h('div', { class: 'form-grid' },
        field('thanks_title', 'Título', 'text', { maxlength: '120' }), field('thanks_text', 'Mensagem', 'textarea', { maxlength: '300' }),
        field('thanks_seconds', 'Tempo na tela (segundos)', 'number', { min: '3', max: '60' }),
        h('label', { class: 'f' }, 'Imagem ou vídeo curto (até 25 MB)', file, mediaPreview))));
  }

  // ------------------------------------------------------------ unidades
  const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const parseList = (j) => { try { const v = JSON.parse(j || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const lines = (el) => el.value.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

  async function pageBranches() {
    const [list, svs, tzInfo] = await Promise.all([branches(true), surveys(true), api('/timezones')]);
    const canEdit = me.can('branches.edit');
    const canCreate = me.can('branches.create');
    const tzName = (tz) => (tzInfo.choices.find((c) => c.value === tz)?.label) || tz;
    const edit = (b = {}) => {
      const tzSel = h('select', {}, h('option', { value: 'auto' }, 'Automático — usar o fuso do tablet'), tzInfo.choices.map((c) => h('option', { value: c.value }, c.label)));
      tzSel.value = b.timezone || 'auto';
      const code = h('input', { value: b.code || '', maxlength: '20', placeholder: 'Ex.: SP01' });
      const name = h('input', { value: b.name || '', maxlength: '100' });
      const city = h('input', { value: b.city || '', maxlength: '100' });
      const active = h('input', { type: 'checkbox', checked: b.id ? !!b.active : true });
      const goal = h('input', { type: 'number', min: '-100', max: '100', value: b.nps_goal ?? '', placeholder: `Padrão: ${settings?.defaultNpsGoal ?? '—'}` });
      const emails = h('textarea', { rows: '2', placeholder: 'gerente@empresa.com (um por linha)', value: parseList(b.alert_emails).join('\n') });
      const phones = h('textarea', { rows: '2', placeholder: '5511999990000 (DDI + DDD + número)', value: parseList(b.alert_phones).join('\n') });
      // Horário: sem horário = sempre aberto.
      let hours = null; try { hours = b.hours_json ? JSON.parse(b.hours_json) : null; } catch { hours = null; }
      const useHours = h('input', { type: 'checkbox', checked: !!hours });
      const dayRows = DAYS.map((d, i) => {
        const cur = hours?.[i];
        const open = h('input', { type: 'time', value: cur?.open || '08:00' });
        const close = h('input', { type: 'time', value: cur?.close || '18:00' });
        const isOpen = h('input', { type: 'checkbox', checked: hours ? !!cur : i !== 0 });
        return { el: h('div', { class: 'hours-row' }, h('label', { class: 'chk' }, isOpen, d), open, h('span', { class: 'muted small' }, 'às'), close), get: () => (isOpen.checked ? { open: open.value, close: close.value } : null) };
      });
      const hoursBox = h('div', { class: 'hours' + (hours ? '' : ' hidden') }, dayRows.map((r) => r.el));
      useHours.addEventListener('change', () => hoursBox.classList.toggle('hidden', !useHours.checked));
      modal(b.id ? 'Editar unidade' : 'Nova unidade', h('div', {},
        h('div', { class: 'form-grid' },
          h('label', { class: 'f' }, 'Código', code), h('label', { class: 'f' }, 'Nome', name), h('label', { class: 'f' }, 'Cidade', city),
          h('label', { class: 'f' }, 'Meta de NPS', goal), h('label', { class: 'chk' }, active, 'Ativa')),
        h('h2', { class: 'mt' }, 'Alertas de cliente insatisfeito'),
        h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'E-mails da unidade', emails), h('label', { class: 'f' }, 'WhatsApp (se configurado)', phones)),
        h('h2', { class: 'mt' }, 'Horário de funcionamento'),
        h('label', { class: 'f' }, 'Fuso horário da unidade', tzSel,
          h('span', { class: 'small muted' }, b.id ? `Em uso agora: ${tzName(b.effective_tz)}${b.timezone ? '' : ' (informado pelo tablet)'}. ` : '',
            `Em "Automático" o horário abaixo vale no fuso configurado no tablet; se o tablet informar algo fora do Brasil, vale o da empresa (${tzName(tzInfo.company)}).`)),
        h('label', { class: 'chk' }, useHours, 'Definir horário (fora dele o tablet mostra tela de descanso e não gera alerta de "sem sinal")'),
        hoursBox),
      [{ label: 'Salvar', onClick: async (close) => {
        try {
          const body = { code: code.value, name: name.value, city: city.value, active: active.checked, nps_goal: goal.value === '' ? null : Number(goal.value),
            alert_emails: lines(emails), alert_phones: lines(phones), timezone: tzSel.value === 'auto' ? null : tzSel.value, hours: useHours.checked ? dayRows.map((r) => r.get()) : null };
          await api(b.id ? '/branches/' + b.id : '/branches', { method: b.id ? 'PUT' : 'POST', body });
          close(); toast('Unidade salva.'); route();
        } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    return h('div', {},
      pageHead('Unidades', 'Cada unidade coleta separadamente e exibe sua própria pesquisa', canCreate ? h('button', { class: 'btn', onclick: () => edit() }, icon('plus', 18), 'Nova unidade') : null),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Código'), h('th', {}, 'Unidade'), h('th', {}, 'Pesquisa padrão dos tablets'), h('th', {}, 'Meta'), h('th', {}, 'Tablets'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, list.length ? list.map((b) => {
          const sel = h('select', { onchange: async (e) => {
            try { await api(`/branches/${b.id}/survey`, { method: 'PUT', body: { surveyId: e.target.value ? Number(e.target.value) : null } }); toast('Pesquisa da unidade atualizada. Os tablets recebem em até 1 minuto.'); cache.branches = null; } catch (ex) { toast(ex.message, true); }
          } }, h('option', { value: '' }, '— nenhuma —'), svs.filter((s) => s.active).map((s) => h('option', { value: String(s.id) }, s.title)));
          sel.value = b.survey_id ? String(b.survey_id) : '';
          return h('tr', {}, h('td', {}, h('code', {}, b.code)), h('td', {}, h('b', {}, b.name), h('div', { class: 'small muted' }, b.city || ''), h('div', { class: 'small muted' }, `Fuso: ${tzName(b.effective_tz)}`)),
            h('td', {}, sel), h('td', {}, b.nps_goal ?? h('span', { class: 'muted small' }, 'padrão')), h('td', {}, b.devices),
            h('td', {}, h('span', { class: 'badge ' + (b.active ? 'ok' : 'off') }, b.active ? 'Ativa' : 'Inativa'), b.public_enabled ? h('span', { class: 'badge ok' }, 'QR ativo') : null),
            h('td', {}, h('div', { class: 'row' },
              h('button', { class: 'btn secondary sm', onclick: () => openLink(b) }, 'QR Code'),
              canEdit ? h('button', { class: 'btn secondary sm', onclick: () => edit(b) }, 'Editar') : null)));
        }) : h('tr', {}, h('td', { colspan: '7', class: 'empty' }, 'Nenhuma unidade cadastrada.'))))));
  }

  // Link/QR Code público da unidade + cartaz para imprimir.
  async function openLink(b) {
    let info = await api(`/branches/${b.id}/public-link`);
    const isAdmin = me.can('branches.edit');
    const box = h('div');
    const draw = () => {
      box.replaceChildren(
        info.url ? h('div', { class: 'poster' + (info.enabled ? '' : ' off') },
          branding.logoUrl ? h('img', { class: 'poster-logo', src: branding.logoUrl, alt: '' }) : h('b', {}, branding.companyName),
          h('div', { class: 'poster-title' }, 'Avalie nosso atendimento'),
          h('img', { class: 'poster-qr', src: info.qr, alt: 'QR Code da pesquisa' }),
          h('div', { class: 'poster-sub' }, 'Aponte a câmera do celular · leva menos de 1 minuto'),
          h('div', { class: 'poster-branch' }, b.name)) : h('p', { class: 'muted' }, 'O link desta unidade ainda não foi criado.'),
        info.url ? h('p', { class: 'small' }, h('code', { class: 'secret' }, info.url)) : null,
        h('p', { class: 'small muted' }, info.enabled ? 'Ativo: qualquer pessoa com o QR pode responder (limite de 10 respostas por hora por aparelho).' : 'Desativado: o link não aceita respostas.'),
        h('div', { class: 'row' },
          info.url ? h('button', { class: 'btn secondary sm', onclick: () => { document.body.classList.add('printing-poster'); window.print(); document.body.classList.remove('printing-poster'); } }, 'Imprimir cartaz') : null,
          info.url ? h('a', { class: 'btn secondary sm', href: info.qr, download: `qrcode-${b.code}.png` }, icon('download', 14), 'Baixar QR') : null,
          isAdmin ? h('button', { class: 'btn sm', onclick: () => act({ enabled: !info.enabled }) }, info.enabled ? 'Desativar link' : 'Ativar link') : null,
          isAdmin && info.url ? h('button', { class: 'btn danger sm', onclick: () => { if (confirm('Gerar um novo link? Os QR Codes já impressos deixarão de funcionar.')) act({ enabled: true, regenerate: true }); } }, 'Gerar novo link') : null));
    };
    const act = async (body) => { try { info = await api(`/branches/${b.id}/public-link`, { method: 'POST', body }); draw(); cache.branches = null; } catch (ex) { toast(ex.message, true); } };
    draw();
    modal(`QR Code · ${b.name}`, box);
  }

  // ------------------------------------------------------------ dispositivos
  function showCode(r, deviceName) {
    modal('Código de pareamento', h('div', {},
      h('p', {}, `Abra no tablet "${deviceName}" o endereço:`), h('p', {}, h('code', {}, location.origin + '/kiosk/')),
      h('p', {}, 'e digite o código abaixo:'), h('div', { class: 'code-box' }, r.code),
      h('p', { class: 'small muted' }, `Válido até ${fmtDate(r.expiresAt)} (15 minutos) e pode ser usado uma única vez. O código não será exibido novamente.`)));
  }

  async function pageDevices() {
    const [devs, brs] = await Promise.all([api('/devices'), branches(true)]);
    const now = Date.now();
    const status = (d) => {
      if (!d.active) return h('span', { class: 'badge off' }, 'Revogado');
      if (!d.paired) return h('span', { class: 'badge warn' }, d.pairing_pending ? 'Aguardando pareamento' : 'Código expirado');
      if (d.last_seen_at && now - d.last_seen_at < 3 * 60_000) return h('span', { class: 'badge ok' }, 'Online');
      return h('span', { class: 'badge' }, 'Offline');
    };
    const add = () => {
      const br = h('select', {}, brs.filter((b) => b.active).map((b) => h('option', { value: String(b.id) }, b.name)));
      const name = h('input', { placeholder: 'Ex.: Tablet recepção', maxlength: '60' });
      modal('Novo tablet', h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Unidade', br), h('label', { class: 'f' }, 'Identificação', name)),
        [{ label: 'Gerar código', onClick: async (close) => {
          try { const r = await api('/devices', { method: 'POST', body: { branchId: Number(br.value), name: name.value } }); close(); await route(); showCode(r, name.value); } catch (ex) { toast(ex.message, true); }
        } }]);
    };
    return h('div', {},
      pageHead('Tablets', 'Dispositivos de coleta vinculados às unidades', h('button', { class: 'btn secondary', onclick: showGuide }, icon('file', 18), 'Guia de instalação'),
        brs.length ? h('button', { class: 'btn', onclick: add }, icon('plus', 18), 'Novo tablet') : null),
      h('p', { class: 'muted' }, 'Cada tablet é vinculado a uma única unidade. As respostas coletadas nele são sempre gravadas nessa unidade — o tablet não consegue escolher ou trocar de unidade.'),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Tablet'), h('th', {}, 'Unidade'), h('th', {}, 'Status'), h('th', {}, 'Último contato'), h('th', {}))),
        h('tbody', {}, devs.length ? devs.map((d) => h('tr', {},
          h('td', {}, h('b', {}, d.name), h('div', { class: 'small muted' }, d.timezone ? `Fuso do tablet: ${d.timezone}` : 'Fuso ainda não informado')), h('td', {}, d.branch_name), h('td', {}, status(d)), h('td', {}, fmtDate(d.last_seen_at)),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'btn secondary sm', onclick: async () => {
              if (d.paired && !confirm('Gerar novo código desconecta o tablet atual até ele ser pareado de novo. Continuar?')) return;
              try { const r = await api(`/devices/${d.id}/pairing-code`, { method: 'POST' }); await route(); showCode(r, d.name); } catch (ex) { toast(ex.message, true); }
            } }, 'Novo código'),
            d.active ? h('button', { class: 'btn danger sm', onclick: async () => {
              if (!confirm(`Revogar o acesso do tablet "${d.name}"? Ele deixará de coletar respostas imediatamente.`)) return;
              try { await api(`/devices/${d.id}/revoke`, { method: 'POST' }); toast('Tablet revogado.'); route(); } catch (ex) { toast(ex.message, true); }
            } }, 'Revogar') : null))))
          : h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'Nenhum tablet cadastrado.'))))));
  }

  function showGuide() {
    const url = location.origin + '/kiosk/';
    const step = (...t) => h('li', {}, ...t);
    modal('Guia de instalação do tablet', h('div', { class: 'guide' },
      h('p', {}, 'Endereço da pesquisa: ', h('code', {}, url)),
      h('h2', {}, 'Android (recomendado: Fully Kiosk Browser)'),
      h('ol', {}, step('Instale "Fully Kiosk Browser & Lockdown" na Play Store.'),
        step('Settings → Start URL: ', h('code', {}, url), '; ligue Keep Screen On e Launch on Boot.'),
        step('Kiosk Mode: ative, defina um PIN e bloqueie barra de status, Home e apps recentes.'),
        step('Na tela "Ativar tablet", digite o código de 8 letras gerado em "Novo tablet".')),
      h('h2', {}, 'iPad (Acesso Guiado)'),
      h('ol', {}, step('No Safari, abra o endereço → Compartilhar → Adicionar à Tela de Início.'),
        step('Abra pelo ícone e ative com o código.'),
        step('Ajustes → Acessibilidade → Acesso Guiado: ative e defina um código.'),
        step('Ajustes → Tela e Brilho → Bloqueio Automático: Nunca.'),
        step('Com a pesquisa aberta, clique 3 vezes no botão lateral → Iniciar.')),
      h('p', { class: 'small muted' }, 'Tablet perdido? Use "Revogar". Sem internet, as respostas ficam guardadas e são enviadas depois. O guia completo está em docs/INSTALACAO-TABLET.md.')));
  }

  // ------------------------------------------------------------ faturamento
  const INV_STATUS = { open: ['warn', 'Em aberto'], paid: ['ok', 'Paga'], canceled: ['', 'Cancelada'] };
  const METHOD = { card: 'Cartão (assinatura)', pix: 'PIX', boleto: 'Boleto', pix_boleto: 'PIX/boleto', manual: 'Baixa manual', account_money: 'Saldo Mercado Pago' };
  const invStatus = (i) => (i.status === 'open' && i.due_date < isoDay(new Date()) ? h('span', { class: 'badge off' }, 'Vencida') : h('span', { class: 'badge ' + INV_STATUS[i.status][0] }, INV_STATUS[i.status][1]));

  // Avisos no topo: teste grátis terminando e fatura vencida (antes da suspensão).
  function billingBanner() {
    const c = me.company;
    if (!c || me.role === 'master') return null;
    if (c.status === 'past_due') return h('div', { class: 'acting-banner bad-banner', role: 'alert' }, icon('bell', 16), h('span', {}, h('b', {}, 'Fatura vencida. '), c.statusReason || '', ' Pague para evitar a suspensão no fim do 5º dia útil após o vencimento.'),
      me.can('settings.manage') ? h('a', { class: 'btn secondary sm', href: '#/faturamento' }, 'Ver faturas') : null);
    if (c.status === 'trial' && c.trialEndsAt) {
      const days = Math.ceil((c.trialEndsAt - Date.now()) / 86_400_000);
      if (days <= 7) return h('div', { class: 'acting-banner', role: 'status' }, icon('calendar', 16), h('span', {}, `Seu teste grátis termina ${days <= 0 ? 'hoje' : days === 1 ? 'amanhã' : `em ${days} dias`} (${fmtDay(c.trialEndsAt)}). Assine para não interromper as pesquisas.`),
        me.can('settings.manage') ? h('a', { class: 'btn secondary sm', href: '#/faturamento' }, 'Assinar agora') : null);
    }
    return null;
  }

  async function pageBilling() {
    const o = await api('/billing');
    const c = o.company;
    const lockedMsg = c.lock_kind === 'trial_expired' ? 'O teste grátis terminou. Para voltar a usar o painel, os tablets e o QR Code, assine abaixo.'
      : c.lock_kind === 'overdue' ? 'O acesso foi suspenso porque uma fatura não foi paga até o fim do 5º dia útil após o vencimento. Assim que o pagamento for confirmado, tudo volta na hora.'
        : c.lock_kind === 'manual' ? `O acesso desta empresa foi suspenso pela plataforma${c.status_reason ? ': ' + c.status_reason : ''}. Fale com o suporte.` : null;
    if (o.limited) {
      return h('div', {}, pageHead('Faturamento', ''), h('div', { class: 'card warn-card' }, h('h2', {}, o.locked ? 'Acesso suspenso' : 'Faturamento'),
        h('p', {}, o.locked ? (lockedMsg || 'O acesso está suspenso.') : 'Os dados de cobrança são vistos pelo administrador da empresa.'),
        o.locked && c.lock_kind !== 'manual' ? h('p', {}, 'Peça ao administrador da sua empresa para regularizar o pagamento.') : null));
    }
    const subscribe = async () => {
      try { const r = await api('/billing/subscribe', { method: 'POST' }); location.href = r.url; } catch (ex) { toast(ex.message, true); }
    };
    const plan = o.plan;
    const card = c.billing_method !== 'pix_boleto';
    const subOk = c.mp_preapproval_status === 'authorized';
    const action = !plan || !plan.priceCents ? h('p', { class: 'muted' }, 'Sua empresa ainda não tem um plano pago definido. Fale com o suporte da plataforma.')
      : !o.mpConfigured ? h('p', { class: 'muted' }, 'O pagamento on-line ainda não está disponível. Fale com o suporte da plataforma.')
        : card ? (subOk ? h('p', {}, h('span', { class: 'badge ok' }, '✓ Assinatura ativa no cartão'), ' A cobrança é automática todo mês, no cartão cadastrado no Mercado Pago.')
          : h('div', {}, h('p', {}, `Assine o plano ${plan.name} por ${money(plan.priceCents)} por mês no cartão de crédito. O cartão é cadastrado na página segura do Mercado Pago — ele não passa pelo nosso sistema.`),
            h('button', { class: 'btn', onclick: subscribe }, icon('lock', 16), c.mp_preapproval_status === 'pending' ? 'Continuar assinatura no Mercado Pago' : 'Assinar com cartão (Mercado Pago)')))
          : h('p', {}, 'A cobrança da sua empresa é por PIX ou boleto: as faturas aparecem abaixo com o link de pagamento e também chegam por e-mail.');
    if (o.locked && !document.querySelector('.modal-bg')) {
      // Pop-up obrigatório: com a empresa suspensa, não há outra tela.
      setTimeout(() => modal('Pagamento necessário', h('div', {}, h('p', {}, lockedMsg)), []), 50);
    }
    return h('div', {}, pageHead('Faturamento', plan ? `Plano ${plan.name} · ${money(plan.priceCents)} por mês` : ''),
      lockedMsg ? h('div', { class: 'card warn-card' }, h('b', {}, lockedMsg)) : null,
      o.graceDeadline && !o.locked ? h('div', { class: 'card warn-card' }, h('b', {}, `Fatura vencida: pague até ${fmtDate(o.graceDeadline - 1).split(' ')[0]} para evitar a suspensão.`)) : null,
      c.status === 'trial' && c.trial_ends_at ? h('div', { class: 'card' }, h('p', {}, `Teste grátis até ${fmtDay(c.trial_ends_at)}.`)) : null,
      h('div', { class: 'card' }, h('h2', {}, 'Forma de pagamento'), action),
      h('div', { class: 'card table-wrap' }, h('h2', {}, 'Faturas'),
        o.invoices.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Descrição', 'Vencimento', 'Valor', 'Situação', 'Pago em', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, o.invoices.map((i) => h('tr', {}, h('td', {}, i.description), h('td', {}, fmtDay(Date.parse(i.due_date + 'T12:00:00'))), h('td', {}, money(i.amount_cents)),
            h('td', {}, invStatus(i)), h('td', {}, i.paid_at ? fmtDay(i.paid_at) + (i.method ? ` · ${METHOD[i.method] || i.method}` : '') : '—'),
            h('td', {}, i.status === 'open' && i.checkout_url ? h('a', { class: 'btn sm', href: i.checkout_url, target: '_blank', rel: 'noopener noreferrer' }, 'Pagar (PIX/boleto)') : null)))))
          : h('p', { class: 'muted' }, 'Nenhuma fatura ainda.')));
  }

  // Master: todas as faturas.
  async function pageInvoices() {
    const st = h('select', {}, h('option', { value: 'overdue' }, 'Vencidas'), h('option', { value: 'open' }, 'Em aberto'), h('option', { value: 'paid' }, 'Pagas'), h('option', { value: '' }, 'Todas'));
    st.value = prefs.get('invStatus', 'overdue');
    const body = h('div', { class: 'card table-wrap' });
    const load = async () => {
      prefs.set('invStatus', st.value);
      const rows = await api('/master/invoices?status=' + st.value);
      body.replaceChildren(rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Empresa', 'Descrição', 'Vencimento', 'Valor', 'Situação', 'Forma'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((i) => h('tr', {}, h('td', {}, h('a', { href: '#/empresas/' + i.company_id }, i.company)), h('td', {}, i.description),
          h('td', {}, fmtDay(Date.parse(i.due_date + 'T12:00:00'))), h('td', {}, money(i.amount_cents)), h('td', {}, invStatus(i)), h('td', {}, METHOD[i.method] || i.method || '—')))))
        : h('p', { class: 'muted' }, 'Nenhuma fatura com esse filtro.'));
    };
    st.addEventListener('change', load); await load();
    const total = h('span');
    return h('div', {}, pageHead('Faturas', 'Cobranças de todas as empresas', h('button', { class: 'btn secondary', onclick: async () => {
      try { const r = await api('/master/billing/run', { method: 'POST' }); toast(`Rotina executada: ${r.invoices} fatura(s) criada(s), ${r.sent} enviada(s).`); load(); } catch (ex) { toast(ex.message, true); }
    } }, icon('refresh', 16), 'Rodar cobrança agora')), h('div', { class: 'card filters' }, h('label', { class: 'f' }, 'Situação', st), total), body);
  }

  // Ficha da empresa (Master): forma de cobrança, assinatura e faturas com ações.
  async function companyBillingCard(cid) {
    const o = await api(`/master/companies/${cid}/billing`);
    const c = o.company;
    const method = h('select', {}, h('option', { value: 'card' }, 'Cartão (assinatura feita pelo cliente)'), h('option', { value: 'pix_boleto' }, 'PIX/boleto (gerado pela plataforma)'));
    method.value = c.billing_method || 'card';
    const day = h('input', { type: 'number', min: '1', max: '28', value: c.billing_day ?? '', placeholder: 'ex.: 10' });
    const auto = h('input', { type: 'checkbox', checked: !!c.auto_invoice });
    const newInv = () => {
      const amount = h('input', { type: 'number', min: '0.01', step: '0.01', value: o.plan?.priceCents ? (o.plan.priceCents / 100).toFixed(2) : '' });
      const desc = h('input', { maxlength: '200', value: o.plan ? `Assinatura ${o.plan.name}` : '' });
      const due = h('input', { type: 'date', value: isoDay(new Date(Date.now() + 5 * 86_400_000)) });
      modal('Nova fatura', h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Descrição', desc), h('label', { class: 'f' }, 'Valor (R$)', amount), h('label', { class: 'f' }, 'Vencimento', due)),
        [{ label: 'Criar', onClick: async (close) => {
          try { await api(`/master/companies/${cid}/invoices`, { method: 'POST', body: { description: desc.value, amountCents: Math.round(Number(amount.value) * 100), dueDate: due.value } }); close(); toast('Fatura criada.'); route(); } catch (ex) { toast(ex.message, true); }
        } }]);
    };
    const act = (i) => h('div', { class: 'row wrap' },
      i.status === 'open' ? h('button', { class: 'btn secondary sm', onclick: async () => {
        try { const r = await api(`/master/invoices/${i.id}/pix`, { method: 'POST', body: { send: true } }); toast('Link de PIX/boleto gerado e enviado por e-mail.'); navigator.clipboard?.writeText(r.url).catch(() => {}); route(); } catch (ex) { toast(ex.message, true); }
      } }, i.checkout_url ? 'Reenviar PIX/boleto' : 'Gerar e enviar PIX/boleto') : null,
      i.status === 'open' ? h('button', { class: 'btn secondary sm', onclick: () => {
        const note = h('input', { maxlength: '200', placeholder: 'Ex.: pago por transferência em 10/11' });
        modal('Dar baixa manual', h('label', { class: 'f' }, 'Observação (obrigatória)', note), [{ label: 'Marcar como paga', onClick: async (close) => {
          try { await api(`/master/invoices/${i.id}/paid`, { method: 'POST', body: { note: note.value } }); close(); toast('Fatura paga.'); route(); } catch (ex) { toast(ex.message, true); }
        } }]);
      } }, 'Baixa manual') : null,
      i.status === 'open' ? h('button', { class: 'btn danger sm', onclick: async () => {
        const reason = prompt('Motivo do cancelamento da fatura:'); if (!reason) return;
        try { await api(`/master/invoices/${i.id}/cancel`, { method: 'POST', body: { reason } }); toast('Fatura cancelada.'); route(); } catch (ex) { toast(ex.message, true); }
      } }, 'Cancelar') : null);
    const SUB = { authorized: ['ok', 'ativa'], pending: ['warn', 'aguardando o cliente'], paused: ['warn', 'pausada'], cancelled: ['off', 'cancelada'] };
    const sub = SUB[c.mp_preapproval_status];
    return h('div', { class: 'card' }, h('div', { class: 'topbar' }, h('h2', {}, 'Cobrança'), h('button', { class: 'btn secondary sm', onclick: newInv }, icon('plus', 14), 'Nova fatura')),
      o.mpConfigured ? null : h('p', { class: 'warn-text small' }, 'Mercado Pago ainda não configurado (Configurações gerais → Faturamento).'),
      h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Forma de cobrança', method), h('label', { class: 'f' }, 'Dia do vencimento (1 a 28)', day),
        h('label', { class: 'chk' }, auto, h('span', {}, 'PIX/boleto: gerar e enviar a fatura automaticamente', h('div', { class: 'small muted' }, 'Sete dias antes do vencimento, por e-mail.')))),
      h('div', { class: 'row mt' }, h('button', { class: 'btn secondary', onclick: async () => {
        try { await api(`/master/companies/${cid}/billing`, { method: 'POST', body: { method: method.value, billingDay: day.value === '' ? null : Number(day.value), autoInvoice: auto.checked } }); toast('Cobrança salva.'); route(); } catch (ex) { toast(ex.message, true); }
      } }, 'Salvar cobrança'),
        sub ? h('span', {}, 'Assinatura no cartão: ', h('span', { class: 'badge ' + sub[0] }, sub[1])) : h('span', { class: 'muted small' }, 'Sem assinatura no cartão.'),
        c.mp_preapproval_status === 'authorized' ? h('button', { class: 'btn danger sm', onclick: () => {
          const conf = confirmFields();
          modal('Cancelar assinatura no cartão', h('div', {}, h('p', {}, 'O Mercado Pago deixa de cobrar o cartão do cliente.'), conf.el), [{ label: 'Cancelar assinatura', cls: 'danger', onClick: async (close) => {
            try { await api(`/master/companies/${cid}/subscription/cancel`, { method: 'POST', body: conf.value() }); close(); toast('Assinatura cancelada.'); route(); } catch (ex) { toast(ex.message, true); }
          } }]);
        } }, 'Cancelar assinatura') : null),
      o.invoices.length ? h('div', { class: 'table-wrap mt' }, h('table', {}, h('thead', {}, h('tr', {}, ['Descrição', 'Vencimento', 'Valor', 'Situação', 'Forma', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, o.invoices.map((i) => h('tr', {}, h('td', {}, i.description), h('td', {}, fmtDay(Date.parse(i.due_date + 'T12:00:00'))), h('td', {}, money(i.amount_cents)),
          h('td', {}, invStatus(i)), h('td', {}, METHOD[i.method] || i.method || '—'), h('td', {}, act(i)))))))
        : h('p', { class: 'muted mt' }, 'Nenhuma fatura.'));
  }

  // ------------------------------------------------------------ Master: empresas da plataforma
  // Faixa fixa quando o Master está dentro de uma empresa: deixa claro onde ele está e até quando.
  function actingBanner() {
    if (!me.acting || !me.company) return null;
    const until = new Date(me.acting.until).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return h('div', { class: 'acting-banner', role: 'status' }, icon('shield', 16),
      h('span', {}, 'Você está na empresa ', h('b', {}, me.company.name), ` como Master (até ${until}). Tudo o que fizer fica registrado na auditoria dela.`),
      h('button', { class: 'btn secondary sm', onclick: async () => {
        try { await api('/master/leave', { method: 'POST' }); me = null; location.hash = '#/empresas'; await route(); } catch (ex) { toast(ex.message, true); }
      } }, 'Sair da empresa'));
  }

  const STATUS_CLS = { active: 'ok', trial: 'warn', past_due: 'warn', suspended: 'off', canceled: 'off' };
  const fmtCnpj = (c) => (c ? String(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : '');
  const fmtDay = (t) => (t ? new Date(t).toLocaleDateString('pt-BR') : '—');

  // Entrar numa empresa (com motivo) para dar suporte.
  function enterCompany(c) {
    const reason = h('input', { maxlength: '200', placeholder: 'Ex.: suporte solicitado pelo cliente por e-mail' });
    modal('Entrar na empresa ' + c.name, h('div', {},
      h('p', {}, 'Você verá e poderá alterar os dados desta empresa por até 2 horas. A entrada e tudo o que fizer ficam registrados na auditoria dela.'),
      h('label', { class: 'f' }, 'Motivo (obrigatório)', reason)),
    [{ label: 'Entrar', onClick: async (close) => {
      try { await api('/master/act', { method: 'POST', body: { companyId: c.id, reason: reason.value } }); close(); me = null; location.hash = '#/dashboard'; await route(); } catch (ex) { toast(ex.message, true); }
    } }]);
  }

  // Campos do cadastro da empresa (usados no "Nova empresa" e na ficha). Consulta o CNPJ e preenche o que vier da Receita.
  function companyForm(c = {}, { isNew = false } = {}) {
    const a = c.address || {};
    const f = {
      cnpj: h('input', { value: fmtCnpj(c.cnpj), placeholder: '00.000.000/0000-00', inputmode: 'numeric', maxlength: '18' }),
      name: h('input', { value: c.name || '', maxlength: '60', placeholder: 'Como aparece no painel' }),
      legalName: h('input', { value: c.legal_name || '', maxlength: '150' }), tradeName: h('input', { value: c.trade_name || '', maxlength: '150' }),
      street: h('input', { value: a.street || '', maxlength: '150' }), number: h('input', { value: a.number || '', maxlength: '20' }),
      complement: h('input', { value: a.complement || '', maxlength: '80' }), district: h('input', { value: a.district || '', maxlength: '80' }),
      city: h('input', { value: a.city || '', maxlength: '80' }), uf: h('input', { value: a.uf || '', maxlength: '2', placeholder: 'UF' }), cep: h('input', { value: a.cep || '', maxlength: '9', inputmode: 'numeric' }),
      phone: h('input', { value: c.phone || '', maxlength: '20', inputmode: 'tel' }), contactEmail: h('input', { type: 'email', value: c.contact_email || '' }),
      billingEmail: h('input', { type: 'email', value: c.billing_email || '', placeholder: 'Para faturas e avisos de cobrança' }),
      notes: h('textarea', { rows: '2', maxlength: '1000', value: c.notes || '', placeholder: 'Anotações internas (só o Master vê)' }),
    };
    const info = h('div', { class: 'small' });
    const lookup = async () => {
      info.replaceChildren(h('span', { class: 'muted' }, 'Consultando a Receita Federal…'));
      try {
        const r = await api('/master/cnpj/' + f.cnpj.value.replace(/\D/g, ''));
        f.cnpj.value = r.formatted;
        if (r.duplicate && r.duplicate.id !== c.id) return info.replaceChildren(h('span', { class: 'bad' }, `Já cadastrado: ${r.duplicate.name} (${r.duplicate.statusLabel}).`));
        if (r.notFound) return info.replaceChildren(h('span', { class: 'bad' }, 'CNPJ não encontrado na Receita Federal.'));
        if (r.unavailable) return info.replaceChildren(h('span', { class: 'warn-text' }, 'Consulta indisponível agora. Preencha os dados à mão — o cadastro fica marcado como "não conferido".'));
        const d = r.data;
        const set = (el, v) => { if (v && !el.value) el.value = v; };
        set(f.legalName, d.legalName); set(f.tradeName, d.tradeName); set(f.name, (d.tradeName || d.legalName || '').slice(0, 60));
        set(f.street, d.address?.street); set(f.number, d.address?.number); set(f.complement, d.address?.complement); set(f.district, d.address?.district);
        set(f.city, d.address?.city); set(f.uf, d.address?.uf); set(f.cep, d.address?.cep); set(f.phone, d.phone); set(f.contactEmail, d.email);
        info.replaceChildren(h('span', { class: d.active ? 'good' : 'bad' }, `Situação na Receita: ${d.status || '—'}`, d.active ? ' ✓' : ' — só é possível cadastrar empresa ATIVA.'),
          h('div', { class: 'muted' }, [d.cnae, d.openedAt ? 'Abertura: ' + d.openedAt.split('-').reverse().join('/') : null, 'Fonte: ' + d.source].filter(Boolean).join(' · ')));
      } catch (ex) { info.replaceChildren(h('span', { class: 'bad' }, ex.message)); }
    };
    f.cnpj.addEventListener('change', () => { if (f.cnpj.value.replace(/\D/g, '').length === 14) lookup(); });
    const L = (label, el, cls = 'f') => h('label', { class: cls }, label, el);
    const el = h('div', {},
      h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'CNPJ', h('div', { class: 'row' }, f.cnpj, h('button', { class: 'btn secondary sm', type: 'button', onclick: lookup }, 'Consultar'))), info,
        L('Nome no painel', f.name), L('Razão social', f.legalName), L('Nome fantasia', f.tradeName)),
      h('h2', { class: 'mt' }, 'Endereço e contato'),
      h('div', { class: 'form-grid' }, L('Logradouro', f.street), L('Número', f.number), L('Complemento', f.complement), L('Bairro', f.district),
        L('Cidade', f.city), L('UF', f.uf), L('CEP', f.cep), L('Telefone', f.phone), L('E-mail de contato', f.contactEmail), L('E-mail de cobrança', f.billingEmail)),
      L('Observações internas', f.notes));
    const value = () => ({
      cnpj: f.cnpj.value, name: f.name.value, legalName: f.legalName.value, tradeName: f.tradeName.value,
      address: { street: f.street.value, number: f.number.value, complement: f.complement.value, district: f.district.value, city: f.city.value, uf: f.uf.value, cep: f.cep.value },
      phone: f.phone.value, contactEmail: f.contactEmail.value, billingEmail: f.billingEmail.value, notes: f.notes.value,
    });
    if (isNew) setTimeout(() => f.cnpj.focus(), 50);
    return { el, value };
  }

  async function pageCompanies(param) {
    if (param) return pageCompany(Number(param));
    const [list, planList] = await Promise.all([api('/master/companies'), api('/master/plans')]);
    const create = () => {
      const plan = h('select', {}, h('option', { value: '' }, 'Sem limites'), planList.plans.filter((p) => p.active).map((p) => h('option', { value: String(p.id) }, `${p.name} — ${money(p.priceCents)}/mês`)));
      const form = companyForm({}, { isNew: true });
      const adminName = h('input', { maxlength: '100' }); const adminEmail = h('input', { type: 'email' });
      const status = h('select', {}, h('option', { value: 'trial' }, 'Em teste grátis'), h('option', { value: 'active' }, 'Ativa (já contratou)'));
      const days = h('input', { type: 'number', min: '1', max: '90', value: '14' });
      modal('Nova empresa', h('div', {}, form.el,
        h('h2', { class: 'mt' }, 'Primeiro administrador (recebe um convite por e-mail para criar a senha)'),
        h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Nome', adminName), h('label', { class: 'f' }, 'E-mail', adminEmail),
          h('label', { class: 'f' }, 'Situação inicial', status), h('label', { class: 'f' }, 'Dias de teste grátis', days), h('label', { class: 'f' }, 'Plano', plan))),
      [{ label: 'Cadastrar empresa', onClick: async (close) => {
        try {
          const r = await api('/master/companies', { method: 'POST', body: { ...form.value(), status: status.value, trialDays: Number(days.value), planId: plan.value ? Number(plan.value) : null,
            admin: adminEmail.value ? { name: adminName.value, email: adminEmail.value } : null } });
          close(); toast(r.manual ? 'Empresa cadastrada (dados não conferidos na Receita).' : 'Empresa cadastrada.' + (r.userId ? ' Convite enviado ao administrador.' : ''));
          location.hash = '#/empresas/' + r.id;
        } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    const search = h('input', { type: 'search', placeholder: 'Buscar por nome ou CNPJ…' });
    const stSel = h('select', {}, h('option', { value: '' }, 'Todas as situações'), Object.entries({ trial: 'Em teste', active: 'Ativa', past_due: 'Pagamento em atraso', suspended: 'Suspensa', canceled: 'Cancelada' }).map(([k, l]) => h('option', { value: k }, l)));
    const body = h('tbody');
    const draw = () => {
      const q = search.value.trim().toLowerCase(); const qd = q.replace(/\D/g, '');
      const rows = list.filter((c) => (!stSel.value || c.status === stSel.value) && (!q || c.name.toLowerCase().includes(q) || (qd && (c.cnpj || '').includes(qd))));
      body.replaceChildren(...(rows.length ? rows.map((c) => h('tr', {},
        h('td', {}, h('a', { href: '#/empresas/' + c.id }, h('b', {}, c.name)), h('div', { class: 'small muted' }, c.cnpj ? 'CNPJ ' + fmtCnpj(c.cnpj) : c.slug)),
        h('td', {}, h('span', { class: 'badge ' + (STATUS_CLS[c.status] || '') }, c.statusLabel), c.status === 'trial' && c.trial_ends_at ? h('div', { class: 'small muted' }, 'até ' + fmtDay(c.trial_ends_at)) : null,
          c.origin === 'self' ? h('div', { class: 'small muted' }, 'autocadastro') : null),
        h('td', {}, c.plan_name || h('span', { class: 'muted small' }, 'sem limites')),
        h('td', {}, c.branches), h('td', {}, c.devices), h('td', {}, c.users), h('td', {}, c.responses30d),
        h('td', {}, h('div', { class: 'row' }, h('a', { class: 'btn secondary sm', href: '#/empresas/' + c.id }, 'Ficha'),
          me.company?.id === c.id ? h('span', { class: 'badge ok' }, 'Você está aqui') : c.status !== 'canceled' ? h('button', { class: 'btn secondary sm', onclick: () => enterCompany(c) }, 'Entrar') : null))))
        : [h('tr', {}, h('td', { colspan: '8', class: 'empty' }, list.length ? 'Nenhuma empresa com esses filtros.' : 'Nenhuma empresa cadastrada ainda.'))]));
    };
    search.addEventListener('input', draw); stSel.addEventListener('change', draw); draw();
    const count = (st) => list.filter((c) => c.status === st).length;
    return h('div', {},
      pageHead('Empresas', 'Clientes da plataforma. Para ver ou ajustar os dados de uma empresa, entre nela informando o motivo.',
        h('button', { class: 'btn', onclick: create }, icon('plus', 18), 'Nova empresa')),
      h('div', { class: 'grid c4' }, [['Ativas', count('active'), 'ok'], ['Em teste', count('trial'), 'warn'], ['Suspensas / atraso', count('suspended') + count('past_due'), 'off'], ['Canceladas', count('canceled'), '']]
        .map(([l, n, cls]) => h('div', { class: 'card kpi-mini' }, h('div', { class: 'small muted' }, l), h('div', { class: 'kpi-num ' + cls }, String(n))))),
      h('div', { class: 'card filters' }, h('label', { class: 'f' }, 'Buscar', search), h('label', { class: 'f' }, 'Situação', stSel)),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Empresa'), h('th', {}, 'Situação'), h('th', {}, 'Plano'), h('th', {}, 'Unidades'), h('th', {}, 'Tablets'), h('th', {}, 'Usuários'), h('th', {}, 'Respostas (30 dias)'), h('th', {}))),
        body)));
  }

  // Confirmação de ação sensível: senha (e código do 2FA, se ativo).
  const confirmFields = () => {
    const password = h('input', { type: 'password', autocomplete: 'current-password' });
    const code = h('input', { inputmode: 'numeric', maxlength: '6', placeholder: 'Se o 2FA estiver ativo' });
    return { el: h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Sua senha', password), h('label', { class: 'f' }, 'Código do aplicativo autenticador', code)),
      value: () => ({ password: password.value, code: code.value }) };
  };

  async function pageCompany(cid) {
    const [c, planList] = await Promise.all([api('/master/companies/' + cid), api('/master/plans')]);
    const planSel = h('select', {}, h('option', { value: '' }, 'Sem limites'), planList.plans.map((p) => h('option', { value: String(p.id) }, `${p.name} — ${money(p.priceCents)}/mês${p.active ? '' : ' (desativado)'}`)));
    planSel.value = c.plan_id ? String(c.plan_id) : '';
    const form = companyForm(c);
    const status = (to, title, text, { needsReason = true, sensitive = false } = {}) => {
      const reason = h('input', { maxlength: '300', placeholder: 'Motivo (fica na auditoria)' });
      const conf = sensitive ? confirmFields() : null;
      modal(title, h('div', {}, h('p', {}, text), needsReason ? h('label', { class: 'f' }, 'Motivo', reason) : null, conf ? conf.el : null),
        [{ label: 'Confirmar', cls: to === 'canceled' ? 'danger' : '', onClick: async (close) => {
          try { await api(`/master/companies/${cid}/status`, { method: 'POST', body: { status: to, reason: reason.value, ...(conf ? conf.value() : {}) } }); close(); toast('Situação alterada.'); route(); } catch (ex) { toast(ex.message, true); }
        } }]);
    };
    const purge = () => {
      const name = h('input', { placeholder: c.name }); const conf = confirmFields();
      modal('Excluir definitivamente', h('div', {},
        h('p', { class: 'bad' }, 'Apaga TODOS os dados da empresa (unidades, pesquisas, respostas, usuários, arquivos e a chave de criptografia). Não há como desfazer. O CNPJ fica livre para um novo cadastro.'),
        h('label', { class: 'f' }, `Digite o nome da empresa: ${c.name}`, name), conf.el),
      [{ label: 'Excluir tudo', cls: 'danger', onClick: async (close) => {
        try { await api('/master/companies/' + cid, { method: 'DELETE', body: { confirmName: name.value, ...conf.value() } }); close(); toast('Empresa excluída definitivamente.'); location.hash = '#/empresas'; } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    const invite = () => {
      const n = h('input', { maxlength: '100' }); const e = h('input', { type: 'email' });
      modal('Convidar administrador', h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Nome', n), h('label', { class: 'f' }, 'E-mail', e),
        h('p', { class: 'small muted' }, 'A pessoa recebe um link (válido por 7 dias) para criar a própria senha.')),
      [{ label: 'Enviar convite', onClick: async (close) => {
        try { await api(`/master/companies/${cid}/admins`, { method: 'POST', body: { name: n.value, email: e.value } }); close(); toast('Convite enviado.'); route(); } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    const extend = () => {
      const days = h('input', { type: 'number', min: '1', max: '90', value: '7' });
      modal('Prorrogar teste grátis', h('label', { class: 'f' }, 'Dias a mais', days), [{ label: 'Prorrogar', onClick: async (close) => {
        try { await api(`/master/companies/${cid}/trial`, { method: 'POST', body: { days: Number(days.value) } }); close(); toast('Teste prorrogado.'); route(); } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    const actions = [];
    if (c.status !== 'canceled') actions.push(h('button', { class: 'btn secondary', onclick: () => enterCompany(c) }, 'Entrar na empresa'));
    if (['active', 'trial', 'past_due'].includes(c.status)) actions.push(h('button', { class: 'btn secondary', onclick: () => status('suspended', 'Suspender empresa', 'Os usuários perdem o acesso e os tablets/QR Codes param de aceitar respostas até a reativação.') }, 'Suspender'));
    if (['suspended', 'past_due', 'trial'].includes(c.status)) actions.push(h('button', { class: 'btn secondary', onclick: () => status('active', 'Ativar empresa', 'A empresa volta a funcionar normalmente.', { needsReason: false }) }, 'Ativar'));
    if (['trial', 'suspended'].includes(c.status)) actions.push(h('button', { class: 'btn secondary', onclick: extend }, 'Prorrogar teste'));
    if (c.status !== 'canceled') actions.push(h('button', { class: 'btn danger', onclick: () => status('canceled', 'Cancelar empresa', 'Ninguém da empresa consegue mais entrar e os tablets param. Os dados ficam guardados até a exclusão definitiva.', { sensitive: true }) }, 'Cancelar'));
    else actions.push(h('button', { class: 'btn secondary', onclick: () => status('active', 'Reativar empresa', 'A empresa volta a funcionar normalmente.', { needsReason: false }) }, 'Reativar'), h('button', { class: 'btn danger', onclick: purge }, 'Excluir definitivamente'));
    return h('div', {},
      pageHead(c.name, h('span', {}, h('span', { class: 'badge ' + (STATUS_CLS[c.status] || '') }, c.statusLabel), ' ', c.cnpj ? 'CNPJ ' + fmtCnpj(c.cnpj) : '', c.receita_status ? ` · Receita: ${c.receita_status}` : ' · não conferido na Receita'),
        h('a', { class: 'btn secondary', href: '#/empresas' }, 'Voltar')),
      c.status_reason ? h('div', { class: 'card warn-card' }, h('b', {}, 'Motivo da situação: '), c.status_reason) : null,
      h('div', { class: 'card' }, h('div', { class: 'row wrap' }, actions),
        h('p', { class: 'small muted mt' }, `Cadastrada em ${fmtDay(c.created_at)}${c.origin === 'self' ? ' pelo autocadastro' : ''}`, c.status === 'trial' && c.trial_ends_at ? ` · teste grátis até ${fmtDay(c.trial_ends_at)}` : '',
          ` · endereço curto: ${c.slug}`)),
      h('div', { class: 'grid c4' }, [['Unidades', c.counts.branches], ['Tablets ativos', c.counts.devices], ['Usuários ativos', c.counts.users], ['Respostas', c.counts.responses]]
        .map(([l, n]) => h('div', { class: 'card kpi-mini' }, h('div', { class: 'small muted' }, l), h('div', { class: 'kpi-num' }, String(n))))),
      h('div', { class: 'card' }, h('div', { class: 'topbar' }, h('h2', {}, 'Plano e uso'), h('div', { class: 'row' }, planSel, h('button', { class: 'btn secondary sm', onclick: async () => {
        try { await api(`/master/companies/${cid}/plan`, { method: 'POST', body: { planId: planSel.value ? Number(planSel.value) : null } }); toast('Plano alterado.'); route(); } catch (ex) { toast(ex.message, true); }
      } }, 'Trocar plano'))), usageTable(c.planUsage)),
      await companyBillingCard(cid),
      h('div', { class: 'card' }, h('div', { class: 'topbar' }, h('h2', {}, 'Administradores'), h('button', { class: 'btn secondary sm', onclick: invite }, icon('plus', 14), 'Convidar administrador')),
        c.admins.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Nome', 'E-mail', '2FA', 'Situação', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, c.admins.map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.totp_enabled ? h('span', { class: 'badge ok' }, 'Ativo') : h('span', { class: 'badge warn' }, 'Não')),
            h('td', {}, h('span', { class: 'badge ' + (u.active ? 'ok' : 'off') }, u.active ? 'Ativo' : 'Inativo')),
            h('td', {}, h('button', { class: 'btn secondary sm', onclick: async () => {
              try { await api(`/master/companies/${cid}/admins`, { method: 'POST', body: { userId: u.id } }); toast('Novo convite enviado para ' + u.email); } catch (ex) { toast(ex.message, true); }
            } }, 'Reenviar convite')))))))
          : h('p', { class: 'muted' }, 'Nenhum administrador. Convide o responsável pela empresa.')),
      h('div', { class: 'card' }, h('h2', {}, 'Cadastro'), form.el,
        h('div', { class: 'row mt' }, h('button', { class: 'btn', onclick: async () => {
          try { await api('/master/companies/' + cid, { method: 'PUT', body: form.value() }); toast('Cadastro salvo.'); route(); } catch (ex) { toast(ex.message, true); }
        } }, 'Salvar cadastro'))));
  }

  // ------------------------------------------------------------ planos
  const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  // Tabela de uso x limite (tela do administrador e ficha da empresa).
  function usageTable(v) {
    return h('div', {},
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Item', 'Em uso', 'Limite do plano', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, v.rows.map((x) => h('tr', {}, h('td', {}, x.label), h('td', {}, x.used.toLocaleString('pt-BR')),
          h('td', {}, x.max === null ? h('span', { class: 'muted' }, 'sem limite') : x.max.toLocaleString('pt-BR')),
          h('td', {}, x.pct === null ? null : h('div', { class: 'meter' }, (() => { const bar = h('span', { class: 'meter-fill ' + (x.pct >= 100 ? 'crit' : x.pct >= 80 ? 'warn' : 'ok') }); bar.style.width = Math.min(100, x.pct) + '%'; return bar; })()))))))),
      h('p', { class: 'small' }, 'Recursos: ', v.features.map((f) => h('span', { class: 'badge ' + (f.enabled ? 'ok' : 'off') }, (f.enabled ? '✓ ' : '✗ ') + f.label)).flatMap((x) => [x, ' '])),
      h('p', { class: 'small muted' }, 'Respostas de clientes nunca são recusadas por limite: ao chegar a 80% e a 100% do mês, os administradores recebem um aviso.'));
  }

  async function pageMyPlan() {
    const v = await api('/plan');
    return h('div', {}, pageHead('Plano e uso', v.plan ? `Plano ${v.plan.name}${v.plan.priceCents ? ' · ' + money(v.plan.priceCents) + ' por mês' : ''}` : 'Sua empresa não tem limites de uso'),
      h('div', { class: 'card' }, h('h2', {}, 'Uso atual'), usageTable(v)),
      v.available.length ? h('div', { class: 'card' }, h('h2', {}, 'Planos disponíveis'),
        h('div', { class: 'grid c3' }, v.available.map((p) => h('div', { class: 'card plan-card' + (v.plan?.id === p.id ? ' current' : '') },
          h('h3', {}, p.name, v.plan?.id === p.id ? h('span', { class: 'badge ok' }, ' seu plano') : null), h('div', { class: 'kpi-num' }, money(p.priceCents), h('span', { class: 'small muted' }, ' /mês')),
          p.description ? h('p', { class: 'small muted' }, p.description) : null,
          h('ul', { class: 'small' }, Object.entries({ branches: ['unidade', 'unidades'], devices: ['tablet', 'tablets'], users: ['usuário', 'usuários'], surveys: ['pesquisa ativa', 'pesquisas ativas'], responsesMonth: ['resposta/mês', 'respostas/mês'] })
            .map(([k, [one, many]]) => h('li', {}, p.limits[k] === null || p.limits[k] === undefined ? `${many}: sem limite` : `${p.limits[k].toLocaleString('pt-BR')} ${p.limits[k] === 1 ? one : many}`)),
            p.features.pptx ? h('li', {}, 'Relatório em PowerPoint') : null, p.features.whatsapp ? h('li', {}, 'Alertas por WhatsApp') : null, p.features.webhook ? h('li', {}, 'Integração por webhook') : null)))),
        h('p', { class: 'small muted' }, 'Para trocar de plano, fale com o suporte da plataforma.')) : null);
  }

  async function pagePlans() {
    const { plans, limits, features } = await api('/master/plans');
    const edit = (p = { limits: {}, features: { pptx: true }, active: true, priceCents: 0 }) => {
      const name = h('input', { value: p.name || '', maxlength: '40' }); const desc = h('input', { value: p.description || '', maxlength: '200' });
      const price = h('input', { type: 'number', min: '0', step: '0.01', value: (p.priceCents / 100).toFixed(2) });
      const pos = h('input', { type: 'number', min: '0', max: '1000', value: p.position ?? 0 });
      const active = h('input', { type: 'checkbox', checked: p.active !== false });
      const lim = Object.fromEntries(Object.keys(limits).map((k) => [k, h('input', { type: 'number', min: '0', value: p.limits[k] ?? '', placeholder: 'sem limite' })]));
      const feat = Object.fromEntries(Object.keys(features).map((k) => [k, h('input', { type: 'checkbox', checked: !!p.features[k] })]));
      modal(p.id ? 'Editar plano' : 'Novo plano', h('div', {},
        h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Nome', name), h('label', { class: 'f' }, 'Preço mensal (R$)', price), h('label', { class: 'f' }, 'Descrição', desc),
          h('label', { class: 'f' }, 'Ordem na lista', pos), h('label', { class: 'chk' }, active, 'Disponível para novas contratações')),
        h('h2', { class: 'mt' }, 'Limites (em branco = sem limite)'),
        h('div', { class: 'form-grid' }, Object.entries(limits).map(([k, l]) => h('label', { class: 'f' }, l, lim[k]))),
        h('h2', { class: 'mt' }, 'Recursos'), Object.entries(features).map(([k, l]) => h('label', { class: 'chk' }, feat[k], l)),
        p.id && p.companies ? h('p', { class: 'small muted' }, `${p.companies} empresa(s) neste plano: a mudança vale para elas na hora.`) : null),
      [{ label: 'Salvar', onClick: async (close) => {
        try {
          const body = { name: name.value, description: desc.value, priceCents: Math.round(Number(price.value) * 100), position: Number(pos.value), active: active.checked,
            limits: Object.fromEntries(Object.entries(lim).map(([k, el]) => [k, el.value === '' ? null : Number(el.value)])),
            features: Object.fromEntries(Object.entries(feat).map(([k, el]) => [k, el.checked])) };
          await api(p.id ? '/master/plans/' + p.id : '/master/plans', { method: p.id ? 'PUT' : 'POST', body }); close(); toast('Plano salvo.'); route();
        } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    const lim = (v) => (v === null || v === undefined ? '∞' : v.toLocaleString('pt-BR'));
    return h('div', {}, pageHead('Planos', 'Preço, limites e recursos de cada plano. Empresa sem plano não tem limites.', h('button', { class: 'btn', onclick: () => edit() }, icon('plus', 18), 'Novo plano')),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Plano', 'Preço/mês', 'Unidades', 'Tablets', 'Usuários', 'Pesquisas', 'Respostas/mês', 'Recursos', 'Empresas', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, plans.map((p) => h('tr', {},
          h('td', {}, h('b', {}, p.name), p.active ? null : h('span', { class: 'badge off' }, 'desativado'), p.description ? h('div', { class: 'small muted' }, p.description) : null),
          h('td', {}, money(p.priceCents)), ...['branches', 'devices', 'users', 'surveys', 'responsesMonth'].map((k) => h('td', {}, lim(p.limits[k]))),
          h('td', { class: 'small' }, Object.entries(features).filter(([k]) => p.features[k]).map(([, l]) => l).join(', ') || '—'),
          h('td', {}, p.companies),
          h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn secondary sm', onclick: () => edit(p) }, 'Editar'),
            p.companies ? null : h('button', { class: 'btn danger sm', onclick: async () => {
              if (!confirm(`Excluir o plano ${p.name}?`)) return;
              try { await api('/master/plans/' + p.id, { method: 'DELETE' }); route(); } catch (ex) { toast(ex.message, true); }
            } }, 'Excluir')))))))));
  }

  // ------------------------------------------------------------ Master: configurações gerais, saúde e auditoria da plataforma
  async function pagePlatform() {
    const [p, planList] = await Promise.all([api('/master/platform'), api('/master/plans')]);
    const st = structuredClone(p);
    const signupPlan = h('select', { onchange: (e) => { st.signup.planId = e.target.value ? Number(e.target.value) : null; } }, h('option', { value: '' }, 'Sem limites'),
      planList.plans.filter((x) => x.active).map((x) => h('option', { value: String(x.id) }, x.name)));
    signupPlan.value = st.signup.planId ? String(st.signup.planId) : '';
    const chk = (obj, k, label, hint) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: obj[k], onchange: (e) => { obj[k] = e.target.checked; } }), h('span', {}, label, hint ? h('div', { class: 'small muted' }, hint) : null));
    const num = (obj, k, min, max) => h('input', { type: 'number', min: String(min), max: String(max), value: obj[k], oninput: (e) => { obj[k] = Number(e.target.value); } });
    const txt = (obj, k, extra = {}) => h('input', { value: obj[k] ?? '', oninput: (e) => { obj[k] = e.target.value; }, ...extra });
    const emails = h('textarea', { rows: '2', value: (st.capacity.alertEmails || []).join('\n'), placeholder: 'ti@suaempresa.com.br (um por linha)' });
    const save = async () => {
      try {
        await api('/master/platform', { method: 'PUT', body: {
          branding: st.branding, signup: st.signup, companyDefaults: st.companyDefaults, security: st.security,
          capacity: { ...st.capacity, alertEmails: emails.value.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean) } } });
        toast('Configurações gerais salvas.'); route();
      } catch (ex) { toast(ex.message, true); }
    };
    const mpv = await api('/master/billing');
    const mpToken = h('input', { type: 'password', autocomplete: 'off', placeholder: mpv.tokenSet ? `${mpv.tokenHint} (cadastrado — deixe em branco para manter)` : 'APP_USR-… (Access Token de produção)' });
    const mpSecret = h('input', { type: 'password', autocomplete: 'off', placeholder: mpv.secretSet ? '•••••••• (cadastrada — deixe em branco para manter)' : 'Assinatura secreta dos webhooks' });
    const mpCard = h('div', { class: 'card' }, h('h2', {}, 'Faturamento (Mercado Pago)'),
      h('p', {}, mpv.configured ? h('span', { class: 'badge ok' }, mpv.sandbox ? 'Configurado (modo de TESTE)' : 'Configurado') : h('span', { class: 'badge warn' }, 'Não configurado')),
      h('ol', { class: 'small muted steps' },
        h('li', {}, 'No Mercado Pago: Seu negócio → Configurações → Gestão e administração → Credenciais (ou developers → Suas integrações). Copie o Access Token de produção.'),
        h('li', {}, 'Em Suas integrações → Webhooks: cadastre a URL abaixo, marque "Pagamentos" e "Planos e assinaturas" e copie a Assinatura secreta.'),
        h('li', {}, 'Use "Testar conexão". Para testes, use as credenciais de teste (começam com TEST-).')),
      h('p', { class: 'small' }, 'URL de notificações: ', h('code', { class: 'secret' }, location.origin + '/api/webhooks/mercadopago')),
      h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Access Token', mpToken), h('label', { class: 'f' }, 'Assinatura secreta (webhook)', mpSecret)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
        try { await api('/master/billing', { method: 'PUT', body: { accessToken: mpToken.value, webhookSecret: mpSecret.value } }); toast('Mercado Pago salvo.'); route(); } catch (ex) { toast(ex.message, true); }
      } }, 'Salvar Mercado Pago'),
      mpv.configured ? h('button', { class: 'btn secondary', onclick: async () => {
        try { const r = await api('/master/billing/test', { method: 'POST' }); toast(`Conexão OK: conta ${r.account.nickname || r.account.id}.`); } catch (ex) { toast(ex.message, true); }
      } }, 'Testar conexão') : null),
      h('p', { class: 'small muted' }, 'Inadimplência: a empresa fica "em atraso" após o vencimento e é suspensa no fim do 5º dia útil (sem sábados, domingos e feriados nacionais).'));
    const delivery = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
    deliveryTab(null, () => route(), { platform: true }).then((el) => delivery.replaceChildren(el)).catch((ex) => delivery.replaceChildren(h('p', { class: 'bad' }, ex.message)));
    return h('div', {}, pageHead('Plataforma', 'Configurações gerais que valem para todas as empresas', h('button', { class: 'btn', onclick: save }, 'Salvar')),
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Marca da plataforma'), h('p', { class: 'small muted' }, 'Aparece na tela de login e nos e-mails enviados fora de uma empresa.'),
          h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Nome', txt(st.branding, 'companyName', { maxlength: '60' })),
            h('label', { class: 'f' }, 'Cor principal', txt(st.branding, 'primaryColor', { type: 'color' })), h('label', { class: 'f' }, 'Cor de destaque', txt(st.branding, 'accentColor', { type: 'color' })))),
        h('div', { class: 'card' }, h('h2', {}, 'Cadastro de empresas pelo site'),
          chk(st.signup, 'enabled', 'Permitir que a própria empresa se cadastre', 'Aparece o link "Cadastrar minha empresa" na tela de login. O CNPJ precisa estar ATIVO na Receita.'),
          h('label', { class: 'f' }, 'Dias de teste grátis', num(st.signup, 'trialDays', 1, 90)), h('label', { class: 'f' }, 'Plano das empresas que se cadastram', signupPlan)),
        h('div', { class: 'card' }, h('h2', {}, 'Segurança'),
          chk(st.security, 'masterMfa', 'Exigir verificação em duas etapas (2FA) do Master', 'Recomendado: o Master enxerga todas as empresas.'),
          chk(st.companyDefaults, 'requireAdminMfa', 'Exigir 2FA dos administradores (padrão das empresas)', 'Cada empresa pode mudar nas configurações dela.')),
        h('div', { class: 'card' }, h('h2', {}, 'Avisos de capacidade do servidor'),
          h('p', { class: 'small muted' }, 'Ao passar de 70% (atenção) ou 90% (crítico) de um limite, os Masters recebem um e-mail. Veja em "Saúde".'),
          h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Banco de dados (MB)', num(st.capacity, 'dbLimitMb', 100, 1000000)),
            h('label', { class: 'f' }, 'Respostas por dia', num(st.capacity, 'responsesPerDayLimit', 100, 100000000)),
            h('label', { class: 'f' }, 'Tablets ativos', num(st.capacity, 'devicesLimit', 10, 10000000)), h('label', { class: 'f' }, 'Empresas ativas', num(st.capacity, 'companiesLimit', 1, 1000000))),
          h('label', { class: 'f' }, 'Também avisar (e-mails)', emails))),
      mpCard,
      h('h2', { class: 'mt' }, 'E-mail e WhatsApp padrão da plataforma'),
      h('p', { class: 'small muted' }, 'Usados pelas empresas que não configurarem os próprios, e para convites, recuperação de senha e avisos da plataforma.'),
      delivery);
  }

  async function pageHealth() {
    const s = await api('/master/health');
    const LV = { ok: ['ok', 'Normal'], warn: ['warn', 'Atenção'], crit: ['off', 'Crítico'] };
    return h('div', {}, pageHead('Saúde da plataforma', `Atualizado ${fmtDate(s.at)} · servidor no ar há ${s.uptimeHours} h · Node ${s.node}`, h('button', { class: 'btn secondary', onclick: () => route() }, icon('refresh', 16), 'Atualizar')),
      h('div', { class: 'card ' + (s.worst === 'ok' ? '' : 'warn-card') }, s.worst === 'ok' ? h('b', {}, 'Tudo dentro dos limites.') : h('b', {}, 'Há indicadores pedindo atenção — veja a recomendação de cada um abaixo.')),
      h('div', { class: 'grid c2' }, s.indicators.map((i) => h('div', { class: 'card' },
        h('div', { class: 'topbar' }, h('h2', {}, i.label), h('span', { class: 'badge ' + LV[i.level][0] }, LV[i.level][1])),
        h('div', { class: 'meter' }, (() => { const bar = h('span', { class: 'meter-fill ' + i.level }); bar.style.width = Math.min(100, i.pct) + '%'; return bar; })()),
        h('p', {}, i.value, h('span', { class: 'muted' }, ` (${i.pct}%)`)),
        i.level !== 'ok' ? h('p', { class: 'small' }, h('b', {}, 'O que fazer: '), i.advice) : null))),
      h('div', { class: 'card' }, h('h2', {}, 'Números gerais'),
        h('div', { class: 'grid c4' }, [['Empresas', s.counts.companies], ['Usuários ativos', s.counts.users], ['Respostas (total)', s.counts.responses.toLocaleString('pt-BR')],
          ['Tablets on-line agora', s.counts.devicesOnline], ['Fila de envios', s.counts.outboxPending], ['Envios com falha', s.counts.outboxFailed],
          ['Carga (1/5/15 min)', s.load.join(' / ') + ` · ${s.cpus} CPU`], ['Memória do sistema', `${Math.round(s.memory.systemFreeMb)} MB livres`]]
          .map(([l, v]) => h('div', {}, h('div', { class: 'small muted' }, l), h('b', {}, String(v)))))));
  }

  async function pagePlatformAudit() {
    const [rows, chk] = await Promise.all([api('/master/audit?limit=500'), api('/master/audit/verify')]);
    const ctx = { branches: new Map(), surveys: new Map(), users: new Map(), devices: new Map() };
    return h('div', {}, pageHead('Auditoria da plataforma', 'Ações do Master e acessos fora das empresas (cada empresa tem a própria auditoria)',
      h('span', { class: 'badge ' + (chk.ok ? 'ok' : 'off') }, icon('shield', 14), chk.ok ? ` Todas as ${chk.chains.length} correntes íntegras` : ' ALTERAÇÃO DETECTADA')),
      chk.ok ? null : h('div', { class: 'card warn-card' }, h('b', {}, 'Registros alterados fora do sistema: '), chk.chains.filter((c) => !c.ok).map((c) => `${c.name} (a partir do #${c.brokenAt})`).join('; ')),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Quando', 'Quem', 'O que aconteceu', 'De onde'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.length ? rows.map((r) => { const e = auditEvent(r, ctx); return h('tr', { class: e.tone ? 'tone-' + e.tone : '' },
          h('td', {}, fmtDate(r.at)), h('td', {}, r.name ? h('div', {}, h('b', {}, r.name), h('div', { class: 'small muted' }, r.email)) : h('span', { class: 'muted' }, 'Visitante / sistema')),
          h('td', {}, h('b', {}, e.title), e.detail ? h('div', { class: 'small muted' }, e.detail) : null), h('td', { class: 'small' }, r.ip || '—')); })
          : h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'Nenhum registro.'))))));
  }

  // ------------------------------------------------------------ usuários
  async function pageUsers() {
    const [users, brs] = await Promise.all([api('/users'), branches(true)]);
    const edit = (u = {}) => {
      const name = h('input', { value: u.name || '', maxlength: '100' });
      const email = h('input', { type: 'email', value: u.email || '', maxlength: '254' });
      // Só o Administrador escolhe o perfil e libera permissões; o gestor autorizado cadastra apenas gestores.
      const full = me.can('users.manage');
      const role = h('select', { disabled: !full }, h('option', { value: 'gestor' }, 'Gestor de unidade'), h('option', { value: 'admin' }, 'Administrador'));
      role.value = u.role || 'gestor';
      const grants = new Set(u.permissions || []);
      const permBox = h('div', { class: 'perm-box' }, h('div', { class: 'small muted' }, 'Permissões extras deste gestor (além do padrão: painel, respostas, casos, pesquisas, unidades, tablets e campanhas)'),
        me.grantable.map((g) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: grants.has(g.id), onchange: (e) => { e.target.checked ? grants.add(g.id) : grants.delete(g.id); } }), g.label)));
      const syncRole = () => permBox.classList.toggle('hidden', !full || role.value !== 'gestor');
      role.addEventListener('change', syncRole); syncRole();
      const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: u.id ? 'Deixe em branco para manter' : 'Mín. 10 caracteres, letras e números' });
      // Novo usuário: por padrão recebe convite por e-mail e cria a própria senha.
      const invite = h('input', { type: 'checkbox', checked: !u.id, onchange: () => { pwLabel.classList.toggle('hidden', invite.checked); } });
      const pwLabel = h('label', { class: 'f' + (!u.id ? ' hidden' : '') }, 'Senha', pw);
      const active = h('input', { type: 'checkbox', checked: u.id ? !!u.active : true });
      const resetMfa = h('input', { type: 'checkbox' });
      const chosen = new Set(u.branches || []);
      const brBox = h('div', {}, brs.map((b) => h('label', { class: 'chk' },
        h('input', { type: 'checkbox', checked: chosen.has(b.id), onchange: (e) => { e.target.checked ? chosen.add(b.id) : chosen.delete(b.id); } }), b.name)));
      modal(u.id ? 'Editar usuário' : 'Novo usuário', h('div', { class: 'form-grid' },
        h('label', { class: 'f' }, 'Nome', name), h('label', { class: 'f' }, 'E-mail', email), h('label', { class: 'f' }, 'Perfil', role),
        u.id ? null : h('label', { class: 'chk' }, invite, 'Enviar convite por e-mail (a pessoa cria a própria senha)'),
        pwLabel, h('label', { class: 'chk' }, active, 'Ativo'),
        u.id && u.totp_enabled && u.id !== me.id ? h('label', { class: 'chk', title: 'Use quando a pessoa perdeu o celular' }, resetMfa, 'Resetar 2FA (perdeu o celular)') : null,
        h('div', {}, h('div', { class: 'small muted' }, 'Unidades que o gestor pode ver'), brBox), permBox),
      [{ label: 'Salvar', onClick: async (close) => {
        try {
          await api(u.id ? '/users/' + u.id : '/users', { method: u.id ? 'PUT' : 'POST', body: {
            name: name.value, email: email.value, role: role.value, password: !u.id && invite.checked ? null : pw.value || null, invite: !u.id && invite.checked,
            active: active.checked, branches: [...chosen], unlock: true, resetMfa: resetMfa.checked,
            ...(full && role.value === 'gestor' ? { permissions: [...grants] } : {}) } });
          close(); toast('Usuário salvo.'); route();
        } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    const bName = (id) => brs.find((b) => b.id === id)?.name || id;
    return h('div', {},
      pageHead('Usuários', me.can('users.manage') ? 'Administradores e gestores de unidade' : 'Gestores das suas unidades', h('button', { class: 'btn', onclick: () => edit() }, icon('plus', 18), 'Novo usuário')),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Nome'), h('th', {}, 'Perfil'), h('th', {}, 'Unidades'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', {}, h('b', {}, u.name), h('div', { class: 'small muted' }, u.email)),
          h('td', {}, ROLE_LABEL[u.role] || u.role, (u.permissions || []).length ? h('div', { class: 'small muted' }, '+ ' + u.permissions.map((p) => me.grantable.find((g) => g.id === p)?.label || p).join('; ')) : null),
          h('td', { class: 'small' }, u.role === 'admin' ? 'Todas' : (u.branches.map(bName).join(', ') || '—')),
          h('td', {}, h('span', { class: 'badge ' + (u.active ? 'ok' : 'off') }, u.active ? 'Ativo' : 'Inativo'),
            u.locked_until && u.locked_until > Date.now() ? h('span', { class: 'badge warn' }, 'Bloqueado') : null,
            u.totp_enabled ? h('span', { class: 'badge ok', title: 'Verificação em duas etapas ativa' }, icon('shield', 12), '2FA') : null),
          h('td', {}, h('button', { class: 'btn secondary sm', onclick: () => edit(u) }, 'Editar'))))))));
  }

  // ------------------------------------------------------------ configurações
  async function uploadMedia(file, { imagesOnly = false } = {}) {
    if (file.size > 25 * 1024 * 1024) throw new Error('Arquivo maior que 25 MB.');
    if (imagesOnly && !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Use uma imagem PNG, JPG, WEBP ou GIF.');
    return api('/media', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } });
  }

  let settingsTab = 'identidade';
  async function pageSettings() {
    const st = structuredClone(await api('/settings'));
    const body = h('div');
    const save = async () => {
      try {
        const saved = await api('/settings', { method: 'PUT', body: st });
        settings = saved;
        applyBranding({ companyName: saved.companyName, primaryColor: saved.primaryColor, accentColor: saved.accentColor,
          logoUrl: saved.logoMediaId ? '/media/' + saved.logoMediaId : null });
        toast('Configurações salvas. Os tablets recebem as mudanças em até 1 minuto.');
        route();
      } catch (ex) { toast(ex.message, true); }
    };
    const tabs = [['identidade', 'Identidade visual', 'palette'], ['menu', 'Ícones do menu', 'layout'], ['respostas', 'Ícones das respostas', 'star'],
      ['envios', 'E-mail e WhatsApp', 'mail'], ['alertas', 'Alertas e relatórios', 'bell'], ['seguranca', 'Segurança e LGPD', 'shield']];
    const TAB = { identidade: identityTab, menu: menuTab, respostas: ratingTab, envios: deliveryTab, alertas: alertsTab, seguranca: securityTab };
    const renderTab = async () => {
      const content = await (TAB[settingsTab] || identityTab)(st, renderTab);
      body.replaceChildren(h('div', { class: 'tabs' }, tabs.map(([k, label, ic]) => h('button', { class: settingsTab === k ? 'active' : '',
        onclick: () => { settingsTab = k; renderTab(); } }, icon(ic, 16), label))), content);
    };
    await renderTab();
    return h('div', {}, pageHead('Configurações', 'Marca, ícones, alertas, relatórios, segurança e LGPD', h('button', { class: 'btn', onclick: save }, 'Salvar configurações')), body);
  }

  function identityTab(st, rerender) {
    const name = h('input', { value: st.companyName, maxlength: '60', oninput: (e) => { st.companyName = e.target.value; } });
    const color = (key, label) => {
      const text = h('input', { value: st[key], maxlength: '7', class: 'small', oninput: (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) { st[key] = e.target.value; picker.value = e.target.value; } } });
      const picker = h('input', { type: 'color', value: st[key], oninput: (e) => { st[key] = e.target.value; text.value = e.target.value; preview(); } });
      return h('label', { class: 'f' }, label, h('div', { class: 'row' }, picker, text));
    };
    const slot = (key, title, hint) => {
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'hidden', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const r = await uploadMedia(f, { imagesOnly: true }); st[key] = r.id; toast('Imagem enviada — clique em "Salvar configurações".'); rerender(); } catch (ex) { toast(ex.message, true); }
      } });
      return h('div', { class: 'brand-slot' },
        h('div', { class: 'thumb' }, st[key] ? h('img', { src: '/media/' + st[key], alt: '' }) : icon('image', 26)),
        h('div', { style: null }, h('b', {}, title), h('div', { class: 'small muted' }, hint),
          h('div', { class: 'row' }, file,
            h('button', { class: 'btn secondary sm', onclick: () => file.click() }, st[key] ? 'Trocar' : 'Enviar imagem'),
            st[key] ? h('button', { class: 'btn secondary sm', onclick: () => { st[key] = null; rerender(); } }, 'Remover') : null)));
    };
    const pv = h('div', { class: 'style-preview' });
    function preview() {
      pv.style.background = st.primaryColor;
      pv.replaceChildren(h('b', {}, 'Prévia do tablet:'), ...[1, 2, 3, 4, 5].map((n) => { const e = icon('star', 26, { fill: n <= 4 }); e.style.color = st.accentColor; return e; }));
    }
    preview();
    return h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('h2', {}, 'Empresa e cores'),
        h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Nome da empresa', name), color('primaryColor', 'Cor principal'), color('accentColor', 'Cor de destaque')),
        h('div', { style: null }, h('p', { class: 'small muted' }, 'A cor principal é o fundo do tablet e a cor do menu; a de destaque realça botões e seleções.'), pv)),
      h('div', { class: 'card' }, h('h2', {}, 'Logo e ícones'),
        h('div', { class: 'grid' },
          slot('logoMediaId', 'Logo da empresa', 'Aparece no painel, na tela inicial do tablet e no PowerPoint. PNG com fundo transparente fica melhor.'),
          slot('faviconMediaId', 'Ícone do navegador (favicon)', 'Ícone da aba do navegador. PNG quadrado, 64×64 px ou maior.'),
          slot('appIconMediaId', 'Ícone do aplicativo', 'Ícone do app instalado no tablet. PNG quadrado de 512×512 px.'))));
  }

  function menuTab(st, rerender) {
    return h('div', { class: 'card' }, h('h2', {}, 'Ícone de cada item do menu'),
      h('p', { class: 'small muted' }, 'Clique no ícone desejado para cada item. A mudança vale para todos os usuários.'),
      PAGES.map(([id, label]) => h('div', { class: 'menu-icon-row' },
        h('div', { class: 'current' }, icon(st.menuIcons[id], 22), label),
        h('div', { class: 'icon-grid' }, window.Icons.MENU_ICONS.map((k) => h('button', {
          class: 'icon-choice' + (st.menuIcons[id] === k ? ' selected' : ''), title: window.Icons.ICONS[k].label,
          onclick: () => { st.menuIcons[id] = k; rerender(); } }, icon(k, 20)))))));
  }

  // Prévia em miniatura de uma escala 0–10 no estilo escolhido (mesmo desenho do tablet).
  function scalePreview(st, display, iconName, scheme = st.colorScheme) {
    const box = h('div', { class: 'mini-scale' });
    box.style.background = st.primaryColor;
    for (let n = 0; n <= 10; n++) {
      const c = window.Icons.levelColor(n, true, scheme);
      if (display === 'numbers') { const e = h('span', { class: 'mini-num' }, String(n)); e.style.background = c; box.append(e); }
      else if (display === 'faces') box.append(window.Icons.face(window.Icons.levelT(n, true), { color: c, mono: st.faceStyle === 'mono', size: 20 }));
      else { const on = n > 0 && n <= 8; const e = icon(iconName, 18, { fill: on }); e.style.color = on ? st.accentColor : 'rgba(255,255,255,.5)'; box.append(e); }
    }
    return box;
  }

  function ratingTab(st, rerender) {
    const isSel = (display, ic) => st.defaultDisplay === display && (display !== 'icons' || st.ratingIcon === ic);
    const card = (title, sub, display, ic) => h('button', { class: 'style-card' + (isSel(display, ic) ? ' selected' : ''),
      onclick: () => { st.defaultDisplay = display; if (ic) st.ratingIcon = ic; rerender(); } },
      scalePreview(st, display, ic), h('b', {}, title), h('span', { class: 'small muted' }, sub));
    const scheme = (v, title, sub) => h('button', { class: 'style-card' + (st.colorScheme === v ? ' selected' : ''), onclick: () => { st.colorScheme = v; rerender(); } },
      scalePreview(st, 'numbers', null, v), h('b', {}, title), h('span', { class: 'small muted' }, sub));
    const faceOpt = (v, label) => h('button', { class: 'style-card' + (st.faceStyle === v ? ' selected' : ''), onclick: () => { st.faceStyle = v; rerender(); } },
      scalePreview({ ...st, faceStyle: v }, 'faces'), h('b', {}, label));
    return h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'Estilo padrão das respostas'),
        h('p', { class: 'small muted' }, 'Usado nas perguntas de escala com aparência "Padrão das configurações" (o padrão de toda pergunta nova). Qualquer estilo vale para o NPS: o tablet sempre grava a nota de 0 a 10.'),
        h('div', { class: 'style-grid' },
          card('Números coloridos', 'Cores conforme o nível de satisfação', 'numbers'),
          card('Carinhas coloridas', 'Expressão e cor mudam com a nota', 'faces'),
          window.Icons.RATING_ICONS.map((k) => card(window.Icons.ICONS[k].label, 'Preenche até a nota escolhida', 'icons', k)))),
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Cores conforme o nível de satisfação'),
          h('p', { class: 'small muted' }, 'Vale para números e carinhas.'),
          h('div', { class: 'style-grid two' },
            scheme('bands', 'Faixas do NPS', 'Vermelho 0–6 · amarelo 7–8 · verde 9–10'),
            scheme('gradient', 'Gradiente', 'Muda aos poucos do vermelho ao verde'))),
        h('div', { class: 'card' }, h('h2', {}, 'Estilo das carinhas'),
          h('div', { class: 'style-grid two' }, faceOpt('color', 'Coloridas'), faceOpt('mono', 'Só contorno')))));
  }

  const DOW = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const chk = (checked, onchange, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), label);

  async function alertsTab(st) {
    const n = await api('/settings/notifications');
    const status = (ok, yes, no) => h('span', { class: 'badge ' + (ok ? 'ok' : 'warn') }, ok ? yes : no);
    const webhook = h('input', { value: st.alerts.webhookUrl || '', placeholder: 'https://hooks.exemplo.com/...', oninput: (e) => { st.alerts.webhookUrl = e.target.value.trim() || null; } });
    const waTpl = h('input', { value: st.alerts.whatsappTemplate || '', placeholder: 'ex.: alerta_detrator', oninput: (e) => { st.alerts.whatsappTemplate = e.target.value.trim() || null; } });
    const waLang = h('input', { value: st.alerts.whatsappLanguage, oninput: (e) => { st.alerts.whatsappLanguage = e.target.value.trim(); } });
    const day = h('select', { onchange: (e) => { st.weeklyReport.weekday = Number(e.target.value); } }, DOW.map((d, i) => h('option', { value: String(i) }, d)));
    day.value = String(st.weeklyReport.weekday);
    const hour = h('input', { type: 'number', min: '0', max: '23', value: st.weeklyReport.hour, oninput: (e) => { st.weeklyReport.hour = Number(e.target.value); } });
    const extra = h('textarea', { rows: '2', placeholder: 'diretoria@empresa.com (um por linha)', value: st.weeklyReport.extraEmails.join('\n'), oninput: (e) => { st.weeklyReport.extraEmails = lines(e.target); } });
    const goal = h('input', { type: 'number', min: '-100', max: '100', value: st.defaultNpsGoal ?? '', oninput: (e) => { st.defaultNpsGoal = e.target.value === '' ? null : Number(e.target.value); } });
    const offMin = h('input', { type: 'number', min: '10', max: '1440', value: st.offlineAlert.minutes, oninput: (e) => { st.offlineAlert.minutes = Number(e.target.value); } });
    const dimAfter = h('input', { type: 'number', min: '5', max: '3600', value: st.screen.dimAfterSeconds, oninput: (e) => { st.screen.dimAfterSeconds = Number(e.target.value); } });
    const dimLevel = h('input', { type: 'range', min: '20', max: '90', step: '5', value: st.screen.dimLevel });
    const dimLabel = h('span', { class: 'small muted' }, `${st.screen.dimLevel}%`);
    dimLevel.addEventListener('input', () => { st.screen.dimLevel = Number(dimLevel.value); dimLabel.textContent = `${dimLevel.value}%`; });
    return h('div', {},
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Cliente insatisfeito (nota 0 a 6)'),
          h('p', { class: 'small muted' }, 'Cada nota baixa abre um caso em "Casos" e avisa a unidade. Os destinatários de cada unidade ficam no cadastro da unidade; usuários escolhem em Minha conta.'),
          chk(st.alerts.detractorEmail, (v) => { st.alerts.detractorEmail = v; }, 'Enviar e-mail na hora'),
          h('label', { class: 'f mt' }, 'Webhook (opcional — integra com n8n, Zapier, Make, Slack…)', webhook),
          h('p', { class: 'small muted' }, 'Envia unidade, nota e link do caso (sem dados pessoais), assinado com HMAC-SHA256 no cabeçalho X-Pesquisa-Signature. Segredo: ', h('code', { class: 'secret' }, n.webhookSecret)),
          h('div', { class: 'form-grid mt' }, h('label', { class: 'f' }, 'Modelo aprovado do WhatsApp (Meta)', waTpl), h('label', { class: 'f' }, 'Idioma do modelo', waLang)),
          h('p', { class: 'small muted' }, 'WhatsApp: ', status(n.whatsappConfigured, 'configurado', 'não configurado — veja a aba "E-mail e WhatsApp"'), ' · parâmetros do modelo: {{1}} unidade, {{2}} nota, {{3}} link.')),
        h('div', { class: 'card' }, h('h2', {}, 'Relatório semanal por e-mail'),
          chk(st.weeklyReport.enabled, (v) => { st.weeklyReport.enabled = v; }, 'Enviar automaticamente o PowerPoint da semana'),
          h('div', { class: 'form-grid mt' }, h('label', { class: 'f' }, 'Dia', day), h('label', { class: 'f' }, 'Hora (Brasília)', hour)),
          h('label', { class: 'f mt' }, 'Destinatários extras (recebem todas as unidades)', extra),
          h('p', { class: 'small muted' }, 'Administradores e gestores recebem conforme a preferência em Minha conta; cada gestor recebe apenas as unidades dele.'),
          h('button', { class: 'btn secondary sm', onclick: async () => {
            try { const r = await api('/settings/weekly-report/send-now', { method: 'POST' }); toast(`Relatório enviado para ${r.sent} destinatário(s).`); renderAgain(); } catch (ex) { toast(ex.message, true); }
          } }, 'Enviar agora (teste)'))),
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Tela do tablet e bateria'),
          chk(st.screen.keepAwake, (v) => { st.screen.keepAwake = v; }, 'Manter a tela sempre acesa'),
          chk(st.screen.dim, (v) => { st.screen.dim = v; }, 'Escurecer a tela quando ninguém estiver usando (economiza bateria)'),
          h('div', { class: 'form-grid mt' }, h('label', { class: 'f' }, 'Escurecer após (segundos sem toque)', dimAfter),
            h('label', { class: 'f' }, h('span', {}, 'Escurecimento ', dimLabel), dimLevel)),
          h('p', { class: 'small muted' }, 'Um toque na tela volta ao brilho normal na hora. No Fully Kiosk (Android) o brilho do aparelho é reduzido de verdade, se a opção "JavaScript Interface" estiver ligada; nos demais, uma camada escura reduz o brilho (em telas OLED/iPad isso também poupa bateria). O tablet pega a mudança em até 1 minuto. No iPad, deixe também Ajustes → Tela e Brilho → Bloqueio Automático em "Nunca".')),
        h('div', { class: 'card' }, h('h2', {}, 'Metas e alertas'),
          h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Meta de NPS padrão (cada unidade pode ter a sua)', goal)),
          chk(st.offlineAlert.enabled, (v) => { st.offlineAlert.enabled = v; }, 'Avisar quando um tablet ficar sem sinal no horário de funcionamento'),
          h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Minutos sem sinal para avisar', offMin)))));
  }

  // ------------------------------------------------------------ aba: e-mail (SMTP) e WhatsApp
  const SMTP_PRESETS = [
    ['', 'Escolha o provedor (opcional)', null],
    ['gmail', 'Gmail / Google Workspace', { host: 'smtp.gmail.com', port: 587 }],
    ['m365', 'Microsoft 365 / Outlook', { host: 'smtp.office365.com', port: 587 }],
    ['locaweb', 'Locaweb', { host: 'email-ssl.com.br', port: 587 }],
    ['brevo', 'Brevo (Sendinblue)', { host: 'smtp-relay.brevo.com', port: 587 }],
    ['sendgrid', 'SendGrid', { host: 'smtp.sendgrid.net', port: 587 }],
  ];
  // E-mail e WhatsApp: da empresa (Configurações) ou o padrão da plataforma (Master → Plataforma).
  async function deliveryTab(st, rerender, { platform = false } = {}) {
    const base = platform ? '/master/delivery' : '/settings/delivery';
    const [d, n] = await Promise.all([api(base), platform ? null : api('/settings/notifications')]);
    const ownSource = platform ? 'painel' : 'empresa';
    const ORIGIN = { empresa: ['ok', 'Configurado aqui (só desta empresa)'], painel: ['ok', 'Configurado no painel'],
      plataforma: ['ok', 'Usando o padrão da plataforma (configure aqui para usar o da sua empresa)'], servidor: ['ok', 'Configurado no servidor (.env)'] };
    const origin = (x) => { const o = ORIGIN[x.source] || ['warn', 'Não configurado']; return h('span', { class: 'badge ' + o[0] }, o[1]); };
    const field = (label, el, hint) => h('label', { class: 'f' }, label, el, hint ? h('span', { class: 'small muted' }, hint) : null);

    // ----- e-mail
    const preset = h('select', {}, SMTP_PRESETS.map(([v, l]) => h('option', { value: v }, l)));
    const host = h('input', { value: d.smtp.host, placeholder: 'smtp.gmail.com', autocomplete: 'off' });
    const port = h('select', {}, [587, 465, 25, 2525].map((p) => h('option', { value: String(p) }, String(p) + (p === 587 ? ' (recomendada)' : p === 465 ? ' (SSL)' : ''))));
    port.value = String(d.smtp.port);
    const user = h('input', { value: d.smtp.user, placeholder: 'pesquisa@suaempresa.com.br', autocomplete: 'off' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: d.smtp.passwordSet ? '•••••••• (cadastrada — deixe em branco para manter)' : 'Senha ou senha de aplicativo' });
    const from = h('input', { value: d.smtp.from, placeholder: 'Pesquisa Empresa <pesquisa@suaempresa.com.br>', autocomplete: 'off' });
    preset.addEventListener('change', () => { const p = SMTP_PRESETS.find((x) => x[0] === preset.value)?.[2]; if (p) { host.value = p.host; port.value = String(p.port); } });
    const saveMail = async () => {
      try {
        await api(base, { method: 'PUT', body: { smtp: { host: host.value, port: Number(port.value), user: user.value, password: pass.value, from: from.value } } });
        toast('E-mail salvo. Use "Enviar e-mail de teste" para conferir.'); rerender();
      } catch (ex) { toast(ex.message, true); }
    };
    const mailCard = h('div', { class: 'card' }, h('h2', {}, 'Envio de e-mails (SMTP)'),
      h('p', {}, origin(d.smtp)),
      h('p', { class: 'small muted' }, 'Usado para alertas de cliente insatisfeito, relatório semanal, recuperação de senha e aviso de tablet sem sinal. A senha fica criptografada e nunca é mostrada de volta.'),
      h('div', { class: 'form-grid' }, field('Provedor', preset), field('Servidor SMTP', host), field('Porta', port), field('Usuário (login)', user),
        field('Senha', pass), field('Remetente (De)', from, 'Aparece como quem enviou. Ex.: Pesquisa Empresa <pesquisa@empresa.com.br>')),
      h('p', { class: 'small muted' }, h('b', {}, 'Gmail: '), 'ative a verificação em duas etapas na conta Google e crie uma "Senha de app" (myaccount.google.com/apppasswords); use essa senha aqui, não a senha normal. ',
        h('b', {}, 'Microsoft 365: '), 'o SMTP autenticado precisa estar liberado para a caixa.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: saveMail }, 'Salvar e-mail'),
        h('button', { class: 'btn secondary', onclick: async () => {
          try { const r = await api(platform ? '/master/test-email' : '/settings/test-email', { method: 'POST' }); r.sent ? toast('E-mail de teste enviado para ' + me.email) : toast('Falhou: ' + (r.error || 'erro'), true); rerender(); } catch (ex) { toast(ex.message, true); }
        } }, icon('mail', 16), 'Enviar e-mail de teste para mim'),
        d.smtp.source === ownSource ? h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Remover a configuração de e-mail feita no painel?')) return;
          try { await api(base, { method: 'PUT', body: { smtp: { clear: true } } }); toast('Configuração removida.'); rerender(); } catch (ex) { toast(ex.message, true); }
        } }, 'Remover') : null));

    // ----- WhatsApp
    const phoneId = h('input', { value: d.whatsapp.phoneId, placeholder: 'Ex.: 109876543210987', inputmode: 'numeric', autocomplete: 'off' });
    const token = h('input', { type: 'password', autocomplete: 'new-password', placeholder: d.whatsapp.tokenSet ? '•••••••• (cadastrado — deixe em branco para manter)' : 'Token de acesso permanente' });
    const testPhone = h('input', { placeholder: '5511999990000 (opcional, para enviar um teste)', inputmode: 'numeric' });
    const waCard = h('div', { class: 'card' }, h('h2', {}, 'WhatsApp (API oficial da Meta)'),
      h('p', {}, origin(d.whatsapp)),
      h('p', { class: 'small muted' }, 'Avisa por WhatsApp quando chega uma nota baixa. Os números que recebem são cadastrados em Unidades (campo WhatsApp) e, para cada pessoa, em Minha conta. O modelo da mensagem fica na aba "Alertas e relatórios".'),
      h('div', { class: 'form-grid' }, field('Identificador do número (Phone number ID)', phoneId, 'Painel da Meta → WhatsApp → Configuração da API.'),
        field('Token de acesso', token, 'Use um token permanente (usuário do sistema), não o temporário de 24 h.')),
      h('ol', { class: 'small muted steps' },
        h('li', {}, 'Em developers.facebook.com crie um app do tipo "Empresa" e adicione o produto WhatsApp.'),
        h('li', {}, 'Cadastre e verifique o número da empresa e copie o Identificador do número.'),
        h('li', {}, 'Em "Usuários do sistema" gere um token permanente com a permissão whatsapp_business_messaging.'),
        h('li', {}, 'Crie e aprove um modelo de mensagem com 3 variáveis ({{1}} unidade, {{2}} nota, {{3}} link) e informe o nome dele na aba "Alertas e relatórios".')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          try { await api(base, { method: 'PUT', body: { whatsapp: { phoneId: phoneId.value, token: token.value } } }); toast('WhatsApp salvo. Use "Testar conexão".'); rerender(); } catch (ex) { toast(ex.message, true); }
        } }, 'Salvar WhatsApp'),
        d.whatsapp.source === ownSource ? h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Remover a configuração de WhatsApp feita no painel?')) return;
          try { await api(base, { method: 'PUT', body: { whatsapp: { clear: true } } }); toast('Configuração removida.'); rerender(); } catch (ex) { toast(ex.message, true); }
        } }, 'Remover') : null),
      d.whatsapp.configured && !platform ? h('div', { class: 'row mt' }, testPhone,
        h('button', { class: 'btn secondary', onclick: async () => {
          try {
            const r = await api('/settings/test-whatsapp', { method: 'POST', body: { phone: testPhone.value } });
            if (r.ok) toast(`Conexão OK: ${r.number}${r.name ? ' (' + r.name + ')' : ''}${r.sentTest ? ' — mensagem de teste enviada.' : ''}`);
            else toast('Falhou: ' + (r.error || 'erro'), true);
          } catch (ex) { toast(ex.message, true); }
        } }, 'Testar conexão' + '')) : null);

    if (platform) return h('div', { class: 'grid c2' }, mailCard, waCard);
    // ----- fila
    const queue = h('div', { class: 'card' }, h('h2', {}, 'Fila de envios'),
      h('p', { class: 'small muted' }, `Na fila: ${n.pending} · com falha nos últimos 7 dias: ${n.failed}. Se o servidor de e-mail cair, as mensagens ficam guardadas e são reenviadas sozinhas.`),
      n.recent.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'small' },
        h('thead', {}, h('tr', {}, ['Quando', 'Tipo', 'Canal', 'Situação', 'Erro'].map((t) => h('th', {}, t)))),
        h('tbody', {}, n.recent.map((o) => h('tr', {}, h('td', {}, fmtDate(o.created_at)), h('td', {}, ({ detractor: 'Cliente insatisfeito', report: 'Relatório', offline: 'Tablet sem sinal', test: 'Teste', reset: 'Senha' })[o.kind] || o.kind),
          h('td', {}, ({ email: 'E-mail', whatsapp: 'WhatsApp', webhook: 'Webhook' })[o.channel] || o.channel),
          h('td', {}, h('span', { class: 'badge ' + (o.status === 'sent' ? 'ok' : o.status === 'failed' ? 'off' : 'warn') }, ({ sent: 'Enviado', failed: 'Falhou', pending: 'Na fila' })[o.status] || o.status)),
          h('td', { class: 'muted' }, o.last_error || '')))))) : h('p', { class: 'muted' }, 'Nenhum envio ainda.'));
    return h('div', {}, h('div', { class: 'grid c2' }, mailCard, waCard), queue);
  }
  const renderAgain = () => { if (location.hash.startsWith('#/configuracoes')) route(); };

  async function securityTab(st) {
    const privacy = h('textarea', { rows: '5', maxlength: '1500', value: st.privacyText, oninput: (e) => { st.privacyText = e.target.value; } });
    const num = (obj, k, min, max) => h('input', { type: 'number', min: String(min), max: String(max), value: obj[k], oninput: (e) => { obj[k] = Number(e.target.value); } });
    return h('div', {},
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Acesso ao painel'),
          chk(st.requireAdminMfa, (v) => { st.requireAdminMfa = v; }, 'Exigir verificação em duas etapas (2FA) de administradores'),
          h('p', { class: 'small muted' }, 'Recomendado. Com isso ligado, o administrador sem 2FA é obrigado a configurá-lo no próximo login.')),
        h('div', { class: 'card' }, h('h2', {}, 'Prazo de guarda dos dados (LGPD)'),
          h('div', { class: 'form-grid' },
            h('label', { class: 'f' }, 'Contatos (meses)', num(st.retention, 'contactsMonths', 1, 60)),
            h('label', { class: 'f' }, 'Comentários (meses)', num(st.retention, 'commentsMonths', 1, 120)),
            h('label', { class: 'f' }, 'Auditoria (meses)', num(st.retention, 'auditMonths', 6, 120))),
          h('p', { class: 'small muted' }, 'Depois do prazo, os dados são apagados automaticamente. As notas numéricas (sem dados pessoais) são mantidas para o histórico do NPS.'))),
      h('div', { class: 'card' }, h('h2', {}, 'Aviso de privacidade exibido no tablet e no QR Code'), privacy),
      privacyRequestCard());
  }

  // Pedido do titular (LGPD): localizar, exportar e excluir os dados de um cliente. Usado em Configurações e na
  // tela "Pedidos LGPD" (para gestores com essa permissão).
  function privacyRequestCard() {
    const phone = h('input', { placeholder: 'Telefone do titular' });
    const mail = h('input', { type: 'email', placeholder: 'ou e-mail' });
    const results = h('div');
    const query = () => ({ phone: phone.value.trim() || undefined, email: mail.value.trim() || undefined });
    const search = async () => {
      try {
        const r = await api('/privacy/search', { method: 'POST', body: query() });
        results.replaceChildren(r.length ? h('div', {},
          h('p', {}, `${r.length} registro(s) encontrado(s).`),
          h('ul', { class: 'answers' }, r.map((x) => h('li', {}, `${fmtDate(x.submitted_at)} · ${x.branch} · ${x.name || '(sem nome)'}`))),
          h('div', { class: 'row' },
            h('button', { class: 'btn secondary sm', onclick: async () => {
              const res = await fetch('/api/admin/privacy/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(query()), credentials: 'same-origin' });
              const a = h('a', { href: URL.createObjectURL(await res.blob()), download: 'dados-titular.json' }); document.body.append(a); a.click(); a.remove();
            } }, icon('download', 14), 'Exportar dados (JSON)'),
            h('button', { class: 'btn danger sm', onclick: () => {
              const conf = confirmFields();
              modal('Excluir dados do titular', h('div', {}, h('p', {}, 'Excluir definitivamente os dados pessoais e comentários desta pessoa? As notas numéricas são mantidas de forma anônima.'), conf.el),
                [{ label: 'Excluir dados', cls: 'danger', onClick: async (close) => {
                  try { const e = await api('/privacy/erase', { method: 'POST', body: { ...query(), confirm: true, ...conf.value() } }); close(); toast(`${e.erased} registro(s) anonimizado(s).`); results.replaceChildren(); } catch (ex) { toast(ex.message, true); }
                } }]);
            } }, 'Excluir dados'))) : h('p', { class: 'muted' }, 'Nenhum registro com esse contato.'));
      } catch (ex) { toast(ex.message, true); }
    };
    return h('div', { class: 'card' }, h('h2', {}, 'Pedido do titular (LGPD)'),
      h('p', { class: 'small muted' }, 'Quando um cliente pedir acesso ou exclusão dos dados dele, localize pelo telefone ou e-mail informado.'),
      h('div', { class: 'row' }, phone, mail, h('button', { class: 'btn secondary', onclick: search }, 'Localizar')), results);
  }
  async function pagePrivacy() { return h('div', {}, pageHead('Pedidos LGPD', 'Acesso e exclusão dos dados de um cliente, a pedido dele'), privacyRequestCard()); }

  // ------------------------------------------------------------ auditoria
  // ------------------------------------------------------------ auditoria (histórico em português simples)
  const CASE_STATUS = { aberto: 'Aberto', em_contato: 'Em contato', resolvido: 'Resolvido', sem_retorno: 'Sem retorno' };
  const ROLE = { master: 'Master', admin: 'Administrador', gestor: 'Gestor' };
  const CHANNEL = { tablet: 'tablet', link: 'QR Code' };
  const AUDIT_CATS = { acesso: 'Acesso ao sistema', conta: 'Senhas e segurança da conta', usuarios: 'Usuários', cadastros: 'Unidades, pesquisas e configurações',
    tablets: 'Tablets', dados: 'Respostas, casos e relatórios', lgpd: 'Privacidade (LGPD)', sistema: 'Rotinas automáticas' };
  const dayBR = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : iso);

  // Cada ação vira uma frase. ctx traz nomes de unidades, pesquisas, usuários e tablets para trocar números por nomes.
  function auditEvent(r, ctx) {
    const d = (() => { try { return r.detail ? JSON.parse(r.detail) : {}; } catch { return {}; } })() || {};
    const br = (i) => (i ? `a unidade "${ctx.branches.get(Number(i)) || '#' + i}"` : '');
    const brName = (i) => ctx.branches.get(Number(i)) || (i ? '#' + i : '');
    const sv = (i) => ctx.surveys.get(Number(i)) || (i ? '#' + i : '');
    const filt = (f = {}) => {
      const p = [];
      if (f.from || f.to) p.push(`período ${dayBR(f.from) || '…'} a ${dayBR(f.to) || '…'}`);
      if (f.branchId) p.push(`unidade ${brName(f.branchId)}`);
      if (f.surveyId) p.push(`pesquisa ${sv(f.surveyId)}`);
      if (f.channel) p.push(`canal ${CHANNEL[f.channel] || f.channel}`);
      if (f.uf) p.push(`estado ${({ _fora: 'fora do Brasil', _sem: 'QR sem localização' })[f.uf] || f.uf}`);
      return p.length ? p.join(', ') : 'sem filtros (todos os dados)';
    };
    const plural = (n, a1, a2) => `${n} ${n === 1 ? a1 : a2}`;
    const E = (cat, tone, title, detail) => ({ cat, tone, title, detail: detail || '' });
    switch (r.action) {
      case 'login.ok': return E('acesso', 'ok', 'Entrou no sistema', d.mfa ? 'Com verificação em duas etapas.' : 'Só com senha (sem verificação em duas etapas).');
      case 'logout': return E('acesso', '', 'Saiu do sistema');
      case 'master.enter_company': return E('acesso', 'warn', 'Master (suporte da plataforma) entrou na empresa', d.reason ? `Motivo informado: ${d.reason}` : '');
      case 'master.leave_company': return E('acesso', '', 'Master (suporte da plataforma) saiu da empresa');
      case 'company.create': return E('cadastros', '', `Cadastrou a empresa "${d.name || '#' + d.id}"`, [d.cnpj ? 'CNPJ ' + fmtCnpj(d.cnpj) : null, d.manual ? 'dados NÃO conferidos na Receita (consulta fora do ar)' : d.receita ? 'Receita: ' + d.receita : null, d.adminInvited ? 'administrador convidado por e-mail' : null].filter(Boolean).join(' · '));
      case 'company.update': return E('cadastros', '', `Alterou o cadastro da empresa "${d.name || '#' + d.id}"`, d.changedCnpj ? 'O CNPJ foi trocado.' : '');
      case 'company.status': return E('cadastros', d.to === 'canceled' || d.to === 'suspended' ? 'bad' : 'warn', `Mudou a situação da empresa: ${({ trial: 'em teste', active: 'ativa', suspended: 'suspensa', canceled: 'cancelada', past_due: 'em atraso' })[d.to] || d.to}`, d.reason ? 'Motivo: ' + d.reason : '');
      case 'company.trial_extended': return E('cadastros', '', `Prorrogou o teste grátis em ${d.days} dia(s)`, d.until ? 'Até ' + new Date(d.until).toLocaleDateString('pt-BR') : '');
      case 'company.admin_invited': return E('usuarios', '', `Convidou o administrador ${d.email || ''}`);
      case 'company.admin_reinvited': return E('usuarios', '', `Reenviou o convite para ${d.email || ''}`);
      case 'company.purged': return E('dados', 'bad', `Excluiu definitivamente a empresa "${d.name || ''}"`, d.cnpj ? 'CNPJ ' + fmtCnpj(d.cnpj) + ' liberado.' : '');
      case 'company.self_signup': return E('cadastros', 'ok', `Empresa cadastrada pelo site: ${d.name || ''}`, d.cnpj ? 'CNPJ ' + fmtCnpj(d.cnpj) : '');
      case 'platform.settings': return E('cadastros', '', 'Alterou as configurações gerais da plataforma', (d.changed || []).join(', '));
      case 'platform.delivery': return E('cadastros', '', 'Alterou o e-mail/WhatsApp padrão da plataforma');
      case 'plan.create': return E('cadastros', '', `Criou o plano "${d.name || ''}"`);
      case 'plan.update': return E('cadastros', '', `Alterou o plano "${d.name || ''}"`, d.priceCents !== undefined ? 'Preço: ' + money(Number(d.priceCents) || 0) : '');
      case 'plan.delete': return E('cadastros', 'warn', `Excluiu o plano "${d.name || ''}"`);
      case 'company.plan': return E('cadastros', '', `Trocou o plano da empresa para: ${d.plan || '—'}`);
      case 'billing.status': return E('dados', d.to === 'suspended' ? 'bad' : d.to === 'past_due' ? 'warn' : 'ok', `Situação alterada pelo faturamento: ${({ active: 'ativa', past_due: 'em atraso', suspended: 'suspensa' })[d.to] || d.to}`, d.reason || '');
      case 'billing.invoice_paid': return E('dados', 'ok', `Fatura paga: ${money(Number(d.amount) || 0)}`, d.manual ? 'Baixa manual pela plataforma.' : 'Confirmado pelo Mercado Pago.');
      case 'billing.invoice_created': return E('dados', '', `Fatura criada: ${money(Number(d.amount) || 0)}`, d.due ? 'Vencimento ' + d.due.split('-').reverse().join('/') : '');
      case 'billing.subscribe_started': return E('dados', '', 'Iniciou a assinatura no cartão (Mercado Pago)', d.plan ? 'Plano ' + d.plan : '');
      case 'billing.subscription_authorized': return E('dados', 'ok', 'Assinatura no cartão ativada');
      case 'billing.subscription_status': return E('dados', 'warn', `Assinatura no cartão: ${d.status}`);
      case 'billing.subscription_canceled': return E('dados', 'warn', 'Assinatura no cartão cancelada pela plataforma');
      case 'billing.pix_issued': return E('dados', '', 'Gerou o link de PIX/boleto', d.sent ? 'Enviado por e-mail.' : '');
      case 'billing.invoice_manual_paid': return E('dados', 'warn', 'Deu baixa manual em uma fatura', d.note || '');
      case 'billing.invoice_canceled': return E('dados', 'warn', 'Cancelou uma fatura', d.reason || '');
      case 'billing.method': return E('cadastros', '', `Forma de cobrança: ${METHOD[d.method] || d.method}`, [d.billingDay ? 'vencimento dia ' + d.billingDay : null, d.autoInvoice ? 'envio automático' : null].filter(Boolean).join(' · '));
      case 'billing.credentials': return E('cadastros', 'warn', 'Alterou as credenciais do Mercado Pago');
      case 'billing.webhook_rejected': return E('acesso', 'bad', 'Notificação de pagamento recusada', d.reason || '');
      case 'billing.amount_mismatch': return E('dados', 'bad', 'Cobrança do cartão MENOR que a fatura (não foi dada baixa)', `Esperado ${money(Number(d.expected) || 0)}, recebido ${money(Number(d.received) || 0)}. Confira o valor da assinatura no Mercado Pago.`);
      case 'billing.run_manual': return E('dados', '', 'Rodou a rotina de cobrança manualmente');
      case 'session.revoked': return E('conta', '', `Encerrou ${d.count} sessão(ões) em outros aparelhos`);
      case 'webauthn.added': return E('conta', 'ok', `Cadastrou uma chave de acesso (passkey): ${d.name || ''}`);
      case 'webauthn.removed': return E('conta', 'warn', 'Removeu uma chave de acesso (passkey)');
      case 'login.webauthn_failed': return E('acesso', 'warn', 'Chave de acesso recusada no login');
      case 'invite.accepted': return E('conta', 'ok', 'Aceitou o convite e criou a senha');
      case 'confirm.bad_password': return E('conta', 'warn', 'Senha errada ao confirmar uma ação sensível');
      case 'confirm.bad_code': return E('conta', 'warn', 'Código do 2FA errado ao confirmar uma ação sensível');
      case 'login.company_canceled': return E('acesso', 'bad', 'Tentativa de entrada com a empresa cancelada');
      case 'login.failed': return E('acesso', 'warn', 'Tentativa de entrada recusada', `Senha ou e-mail incorretos${d.email ? ' (e-mail digitado: ' + d.email + ')' : ''}.`);
      case 'login.mfa_failed': return E('acesso', 'warn', 'Código da verificação em duas etapas errado', 'A senha estava certa, mas o código do aplicativo não.');
      case 'mfa.bad_password': return E('conta', 'warn', 'Senha errada ao mexer na verificação em duas etapas');
      case 'login.locked': return E('acesso', 'bad', 'Conta bloqueada por 15 minutos', 'Muitas senhas erradas seguidas.');
      case 'mfa.enabled': return E('conta', 'ok', 'Ativou a verificação em duas etapas');
      case 'mfa.disabled': return E('conta', 'warn', 'Desativou a verificação em duas etapas', 'Atenção: a conta ficou protegida só pela senha.');
      case 'mfa.recovery_code_used': return E('conta', 'warn', 'Entrou usando um código de recuperação', 'Costuma indicar que o celular com o aplicativo não estava à mão.');
      case 'mfa.recovery_regenerated': return E('conta', '', 'Gerou novos códigos de recuperação', 'Os códigos antigos deixaram de valer.');
      case 'password.reset_requested': return E('conta', '', 'Pediu para redefinir a senha', 'Um link foi enviado por e-mail.');
      case 'password.reset_unknown': return E('conta', 'warn', 'Pedido de nova senha para e-mail não cadastrado', d.email ? `E-mail digitado: ${d.email}.` : '');
      case 'password.reset_done': return E('conta', 'ok', 'Definiu uma nova senha pelo link do e-mail');
      case 'user.password_changed': return E('conta', 'ok', 'Trocou a própria senha');
      case 'user.create': return E('usuarios', '', `Criou o usuário ${d.email || ''}`, `Perfil: ${ROLE[d.role] || d.role}${d.role === 'gestor' ? ` · ${plural((d.branches || []).length, 'unidade', 'filiais')}: ${(d.branches || []).map(brName).join(', ') || 'nenhuma'}` : ''}.`);
      case 'user.update': {
        const bits = [`Perfil: ${ROLE[d.role] || d.role}`, d.active === 0 || d.active === false ? 'usuário DESATIVADO' : 'usuário ativo'];
        if (d.passwordReset) bits.push('senha redefinida pelo administrador');
        if (d.resetMfa) bits.push('verificação em duas etapas reiniciada');
        return E('usuarios', d.active === 0 || d.active === false || d.resetMfa ? 'warn' : '', `Alterou o usuário ${d.email || '#' + d.id}`, bits.join(' · ') + '.');
      }
      case 'branch.create': return E('cadastros', '', `Cadastrou a unidade "${d.name || d.code || '#' + d.id}"`, [d.code && `Código ${d.code}`, d.city].filter(Boolean).join(' · '));
      case 'branch.update': return E('cadastros', '', `Alterou a unidade "${d.name || brName(d.id)}"`, d.active === 0 || d.active === false ? 'Unidade DESATIVADA.' : '');
      case 'branch.set_survey': return E('cadastros', '', `Definiu a pesquisa padrão da unidade "${brName(d.branchId)}"`, d.surveyId ? `Pesquisa: ${sv(d.surveyId)}.` : 'Sem pesquisa padrão.');
      case 'branch.public_link': return E('cadastros', d.regenerated ? 'warn' : '', `${d.regenerated ? 'Gerou um novo QR Code/link' : d.enabled ? 'Ativou o QR Code/link' : 'Desativou o QR Code/link'} da unidade "${brName(d.branchId)}"`, d.regenerated ? 'O QR Code antigo parou de funcionar.' : '');
      case 'schedule.create': return E('cadastros', '', `Agendou uma campanha${d.branchId ? ' na unidade "' + brName(d.branchId) + '"' : ' em todas as unidades'}`, `Pesquisa: ${sv(d.surveyId)} · de ${d.startsAt ? new Date(d.startsAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '…'} a ${d.endsAt ? new Date(d.endsAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '…'}.`);
      case 'schedule.delete': return E('cadastros', '', 'Excluiu uma campanha agendada');
      case 'survey.create': return E('cadastros', '', `Criou a pesquisa "${d.title || sv(d.id)}"`);
      case 'survey.update': return E('cadastros', '', `Alterou a pesquisa "${d.title || sv(d.id)}"`);
      case 'survey.duplicate': return E('cadastros', '', `Duplicou a pesquisa "${sv(d.from)}"`, 'Criou uma cópia para editar.');
      case 'media.upload': return E('cadastros', '', `Enviou ${String(d.mime || '').startsWith('video/') ? 'um vídeo' : 'uma imagem'}`, d.size ? `Tamanho: ${d.size > 1048576 ? (d.size / 1048576).toFixed(1) + ' MB' : Math.round(d.size / 1024) + ' KB'}.` : '');
      case 'settings.update': return E('cadastros', '', 'Alterou as configurações do sistema', d.companyName ? `Empresa: ${d.companyName}.` : '');
      case 'settings.delivery': return E('cadastros', 'warn', 'Alterou a configuração de e-mail/WhatsApp', [d.smtp && `E-mail: ${d.smtp}`, d.whatsapp && `WhatsApp: ${d.whatsapp}`].filter(Boolean).join(' · ') + '. (senhas e tokens não são registrados)');
      case 'device.create': return E('tablets', '', `Cadastrou o tablet "${d.name || '#' + d.id}"`, d.branchId ? `Unidade: ${brName(d.branchId)}.` : '');
      case 'device.new_code': return E('tablets', 'warn', `Gerou um novo código de pareamento para o tablet "${ctx.devices.get(Number(d.id)) || '#' + d.id}"`, 'O tablet atual perdeu o acesso até ser pareado de novo.');
      case 'device.revoke': return E('tablets', 'warn', `Revogou o acesso do tablet "${ctx.devices.get(Number(d.id)) || '#' + d.id}"`, 'Ele não coleta mais respostas.');
      case 'device.paired': return E('tablets', 'ok', `Um tablet foi pareado${d.deviceId ? ': "' + (ctx.devices.get(Number(d.deviceId)) || '#' + d.deviceId) + '"' : ''}`);
      case 'device.pair_failed': return E('tablets', 'warn', 'Tentativa de parear tablet com código errado ou vencido');
      case 'response.delete': return E('dados', 'bad', 'Excluiu uma resposta', `Unidade ${brName(d.branchId)} · pesquisa ${sv(d.surveyId)}.`);
      case 'responses.delete_filtered': return E('dados', 'bad', `Excluiu ${plural(d.count ?? 0, 'resposta', 'respostas')} de uma vez`, `Filtro usado: ${filt(d.filter)}.`);
      case 'responses.export': return E('dados', '', `Exportou ${plural(d.count ?? 0, 'resposta', 'respostas')} em planilha (CSV)`, `Filtro: ${filt(d.filter)}.`);
      case 'report.pptx': return E('dados', '', 'Gerou o relatório em PowerPoint', `Filtro: ${filt(d.filter)}.`);
      case 'report.weekly_manual': return E('dados', '', 'Enviou o relatório semanal manualmente', d.sent !== undefined ? `Enviado a ${plural(d.sent, 'pessoa', 'pessoas')}.` : '');
      case 'report.weekly_queued': return E('sistema', '', 'Relatório semanal enviado automaticamente', d.sent !== undefined ? `Enviado a ${plural(d.sent, 'pessoa', 'pessoas')}.` : '');
      case 'case.update': return E('dados', '', `Atualizou o caso #${d.id}`, `Situação: ${CASE_STATUS[d.status] || d.status || '—'}${d.assignee ? ' · responsável: ' + (ctx.users.get(Number(d.assignee)) || '#' + d.assignee) : ''}.`);
      case 'contact.view': return E('lgpd', 'warn', `Viu os dados de contato de um cliente (caso #${d.caseId})`, 'Todo acesso a dado pessoal fica registrado.');
      case 'privacy.search': return E('lgpd', '', 'Buscou dados de um cliente (LGPD)', `Encontrou ${plural(d.found ?? 0, 'registro', 'registros')}.`);
      case 'privacy.export': return E('lgpd', 'warn', 'Exportou os dados de um cliente (LGPD)', `${plural(d.count ?? 0, 'registro', 'registros')}.`);
      case 'privacy.erase': return E('lgpd', 'bad', 'Excluiu os dados pessoais de um cliente (LGPD)', `${plural(d.count ?? 0, 'registro anonimizado', 'registros anonimizados')}.`);
      case 'lgpd.retention': return E('sistema', '', 'Limpeza automática de dados antigos (LGPD)', [d.contacts && `${d.contacts} contatos`, d.comments && `${d.comments} comentários`, d.audit && `${d.audit} registros de auditoria`, d.coordinates && `${d.coordinates} localizações`].filter(Boolean).join(' · ') + ' apagados pelo prazo de retenção.');
      default: return E('sistema', '', r.action);
    }
  }
  const TONE_LABEL = { ok: 'Normal', warn: 'Atenção', bad: 'Importante' };

  async function pageAudit() {
    const [rows, brs, svs, users, devs] = await Promise.all([api('/audit?limit=500'), branches(), surveys(), api('/users'), api('/devices')]);
    const ctx = { branches: new Map(brs.map((b) => [b.id, b.name])), surveys: new Map(svs.map((x) => [x.id, x.title])),
      users: new Map(users.map((u) => [u.id, u.name])), devices: new Map(devs.map((x) => [x.id, x.name])) };
    const events = rows.map((r) => ({ r, e: auditEvent(r, ctx) }));
    const cat = h('select', {}, h('option', { value: '' }, 'Todos os tipos'), Object.entries(AUDIT_CATS).map(([k, l]) => h('option', { value: k }, l)));
    const search = h('input', { type: 'search', placeholder: 'Buscar por pessoa, unidade, palavra…' });
    const onlyAlerts = h('input', { type: 'checkbox' });
    const list = h('div', { class: 'card table-wrap' });
    const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : ''; };
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = events.filter(({ r, e }) => (!cat.value || e.cat === cat.value) && (!onlyAlerts.checked || e.tone === 'warn' || e.tone === 'bad')
        && (!q || `${e.title} ${e.detail} ${r.name || ''} ${r.email || ''} ${r.ip || ''}`.toLowerCase().includes(q)));
      list.replaceChildren(h('table', {},
        h('thead', {}, h('tr', {}, ['Quando', 'Quem', 'O que aconteceu', 'De onde'].map((t) => h('th', {}, t)))),
        h('tbody', {}, shown.length ? shown.map(({ r, e }) => h('tr', { class: e.tone ? 'tone-' + e.tone : '' },
          h('td', {}, h('div', {}, fmtDate(r.at)), h('div', { class: 'small muted' }, ago(r.at))),
          h('td', {}, r.name ? h('div', {}, h('b', {}, r.name), r.as_master ? h('span', { class: 'badge warn', title: 'Suporte da plataforma' }, 'Master') : null, h('div', { class: 'small muted' }, r.email)) : h('span', { class: 'muted' }, r.action.startsWith('login.') || r.action.startsWith('password.') || r.action === 'device.pair_failed' || r.action === 'device.paired' ? 'Visitante / aparelho' : 'Sistema (automático)')),
          h('td', {}, h('div', {}, e.tone && e.tone !== '' && e.tone !== 'ok' ? h('span', { class: 'badge ' + (e.tone === 'bad' ? 'off' : 'warn') }, TONE_LABEL[e.tone]) : null, e.tone && e.tone !== 'ok' ? ' ' : '', h('b', {}, e.title)),
            e.detail ? h('div', { class: 'small muted' }, e.detail) : null, h('div', { class: 'small muted' }, AUDIT_CATS[e.cat])),
          h('td', { class: 'small' }, r.ip || '—')))
          : h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'Nenhum registro com esses filtros.')))));
    };
    [cat, onlyAlerts].forEach((el) => el.addEventListener('change', draw));
    search.addEventListener('input', draw);
    draw();
    const integrity = me.can('settings.manage') ? await api('/audit/verify').catch(() => null) : null;
    return h('div', {}, pageHead('Auditoria', 'Quem fez o quê no sistema — as últimas 500 ações, em linguagem simples',
      integrity ? h('span', { class: 'badge ' + (integrity.ok ? 'ok' : 'off'), title: 'Cada registro guarda o resumo do anterior: alterações escondidas no banco quebram a corrente.' },
        icon('shield', 14), integrity.ok ? ` Registros íntegros (${integrity.rows})` : ` ALTERAÇÃO DETECTADA no registro #${integrity.brokenAt}`) : null),
      h('div', { class: 'card filters' }, h('label', { class: 'f' }, 'Tipo', cat), h('label', { class: 'f' }, 'Buscar', search),
        h('label', { class: 'chk' }, onlyAlerts, 'Mostrar só o que merece atenção')),
      list);
  }

  // ------------------------------------------------------------ notas de versão e manual
  let manualTab = 'manual';
  async function pageManual() {
    const m = await api('/manual');
    const body = h('div');
    const search = h('input', { type: 'search', placeholder: 'Buscar no manual (ex.: QR Code, tablet, senha)…' });
    const zoom = (img) => modal(img.caption, h('img', { class: 'manual-zoom', src: img.url, alt: img.caption }), []);
    const section = (s) => h('div', { class: 'card manual-sec', id: 'm-' + s.id },
      h('h2', {}, s.title), s.intro ? h('p', {}, s.intro) : null,
      s.steps?.length ? h('ol', { class: 'steps' }, s.steps.map((t) => h('li', {}, t))) : null,
      s.images.length ? h('div', { class: 'manual-imgs' }, s.images.map((i) => h('figure', {}, h('img', { src: i.url, alt: i.caption, loading: 'lazy', onclick: () => zoom(i) }), h('figcaption', { class: 'small muted' }, i.caption)))) : null,
      s.tips?.length ? h('div', { class: 'manual-tips small' }, s.tips.map((t) => h('p', {}, h('b', {}, 'Dica: '), t))) : null);
    const draw = () => {
      if (manualTab === 'novidades') {
        body.replaceChildren(...m.versions.map((v) => h('div', { class: 'card' }, h('h2', {}, `Versão ${v.version} — ${v.title}`), h('p', { class: 'small muted' }, fmtDay(Date.parse(v.date + 'T12:00:00'))),
          h('ul', { class: 'news' }, v.items.map((t) => h('li', {}, t))))));
        return;
      }
      const q = search.value.trim().toLowerCase();
      const list = m.sections.filter((s) => !q || JSON.stringify([s.title, s.intro, s.steps, s.tips]).toLowerCase().includes(q));
      const groups = [...new Set(list.map((s) => s.group))];
      body.replaceChildren(
        h('div', { class: 'card' }, h('h2', {}, 'Neste manual'), groups.length ? groups.map((g) => h('div', { class: 'manual-toc' }, h('b', {}, g + ': '),
          list.filter((s) => s.group === g).map((s) => h('a', { href: '#/manual', onclick: (e) => { e.preventDefault(); document.getElementById('m-' + s.id)?.scrollIntoView({ behavior: 'smooth' }); } }, s.title)).flatMap((a, i) => (i ? [' · ', a] : [a]))))
          : h('p', { class: 'muted' }, 'Nada encontrado.')),
        ...list.map(section));
    };
    search.addEventListener('input', draw);
    const tabs = h('div', { class: 'tabs' }, [['manual', 'Manual', 'list'], ['novidades', 'Notas de versão', 'star']].map(([k, label, ic]) => h('button', { class: manualTab === k ? 'active' : '',
      onclick: () => { manualTab = k; tabs.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', ['manual', 'novidades'][i] === k)); search.parentElement.classList.toggle('hidden', k !== 'manual'); draw(); } }, icon(ic, 16), label)));
    draw();
    return h('div', {}, pageHead('Notas de versão e manual', `Versão ${m.version} · mostrando só o que o seu perfil pode usar`), tabs,
      h('div', { class: 'card filters' + (manualTab === 'manual' ? '' : ' hidden') }, h('label', { class: 'f' }, 'Buscar', search)), body);
  }

  // ------------------------------------------------------------ minha conta
  async function pageAccount() {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const pw = h('input', { type: 'password', autocomplete: 'new-password' });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const mfa = await api('/mfa');
    const askPw = (title, withCode, run) => {
      const p = h('input', { type: 'password', autocomplete: 'current-password' });
      const c = h('input', { inputmode: 'numeric', maxlength: '6', placeholder: '000000' });
      modal(title, h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Senha atual', p), withCode ? h('label', { class: 'f' }, 'Código do aplicativo', c) : null),
        [{ label: 'Confirmar', onClick: async (close) => { try { await run(p.value, c.value, close); } catch (ex) { toast(ex.message, true); } } }]);
    };
    const notif = (key, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: me.notify[key], onchange: async (e) => {
      try { await api('/me/notifications', { method: 'PUT', body: { [key]: e.target.checked } }); me.notify[key] = e.target.checked; toast('Preferência salva.'); } catch (ex) { toast(ex.message, true); }
    } }), label);
    const wa = h('input', { value: me.whatsapp || '', placeholder: '5511999990000', inputmode: 'numeric', autocomplete: 'tel' });
    const [sess, keys] = await Promise.all([api('/me/sessions'), mfa.enabled ? api('/webauthn') : []]);
    const addPasskey = () => askPw('Cadastrar chave de acesso', true, async (p, c, close) => {
      const opt = await api('/webauthn/register/options', { method: 'POST', body: { password: p, code: c } });
      close();
      try {
        const cred = await navigator.credentials.create({ publicKey: { ...opt, challenge: b64uToBuf(opt.challenge), user: { ...opt.user, id: b64uToBuf(opt.user.id) },
          excludeCredentials: opt.excludeCredentials.map((x) => ({ type: 'public-key', id: b64uToBuf(x.id) })) } });
        const name = prompt('Nome desta chave (ex.: Notebook, Celular):', 'Minha chave') || 'Minha chave';
        await api('/webauthn/register', { method: 'POST', body: { name, credential: { id: cred.id, type: cred.type,
          response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject) } } } });
        toast('Chave de acesso cadastrada.'); route();
      } catch (ex) { toast(ex.name === 'NotAllowedError' ? 'Cadastro cancelado.' : ex.message, true); }
    });
    const uaShort = (ua) => { const s = String(ua || ''); const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad/.test(s) ? 'iPhone/iPad' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : '';
      const br = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Navegador'; return `${br}${os ? ' · ' + os : ''}`; };
    const securityCards = h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('div', { class: 'topbar' }, h('h2', {}, 'Aparelhos conectados'),
        sess.sessions.length > 1 ? h('button', { class: 'btn secondary sm', onclick: async () => {
          try { const r = await api('/me/sessions/revoke-others', { method: 'POST' }); toast(`${r.removed} sessão(ões) encerrada(s).`); route(); } catch (ex) { toast(ex.message, true); }
        } }, 'Sair de todos os outros') : null),
        h('div', { class: 'table-wrap' }, h('table', { class: 'small' }, h('thead', {}, h('tr', {}, ['Aparelho', 'IP', 'Último uso', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, sess.sessions.map((x) => h('tr', {}, h('td', {}, uaShort(x.user_agent), x.current ? h('span', { class: 'badge ok' }, 'este') : null), h('td', {}, x.ip || '—'), h('td', {}, fmtDate(x.last_seen_at)),
            h('td', {}, x.current ? null : h('button', { class: 'btn secondary sm', onclick: async () => { try { await api('/me/sessions/' + x.id, { method: 'DELETE' }); route(); } catch (ex) { toast(ex.message, true); } } }, 'Encerrar'))))))),
        h('p', { class: 'small muted' }, 'Avisamos por e-mail quando sua conta é acessada de um aparelho ou rede novos. Não reconhece um acesso? Troque a senha (encerra tudo).')),
      h('div', { class: 'card' }, h('h2', {}, 'Chaves de acesso (passkeys)'),
        h('p', { class: 'small muted' }, 'Entre confirmando com a digital, o rosto ou o PIN do aparelho, em vez de digitar o código. Funciona só no endereço verdadeiro do painel: protege contra sites falsos.'),
        !mfa.enabled ? h('p', { class: 'small' }, 'Ative primeiro a verificação em duas etapas.') : !passkeySupported() ? h('p', { class: 'small' }, 'Este navegador não suporta chaves de acesso.') : null,
        keys.length ? h('ul', { class: 'small' }, keys.map((k) => h('li', {}, h('b', {}, k.name), ` — cadastrada em ${fmtDay(k.created_at)}${k.last_used_at ? ', último uso ' + fmtDate(k.last_used_at) : ''} `,
          h('button', { class: 'btn secondary sm', onclick: () => askPw('Remover chave de acesso', true, async (p, c, close) => { await api('/webauthn/' + k.id, { method: 'DELETE', body: { password: p, code: c } }); close(); toast('Chave removida.'); route(); }) }, 'Remover')))) : null,
        mfa.enabled && passkeySupported() ? h('button', { class: 'btn secondary', onclick: addPasskey }, icon('key', 16), 'Cadastrar chave de acesso') : null));
    return h('div', {}, pageHead('Minha conta', me.email),
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Verificação em duas etapas (2FA)'),
          h('p', {}, mfa.enabled ? h('span', { class: 'badge ok' }, icon('shield', 14), 'Ativa') : h('span', { class: 'badge warn' }, 'Desativada'),
            mfa.enabled ? h('span', { class: 'small muted' }, `  ${mfa.recoveryCodesLeft} códigos de recuperação restantes`) : null),
          h('p', { class: 'small muted' }, 'Além da senha, o login pede um código que muda a cada 30 segundos no seu celular.'),
          h('div', { class: 'row' },
            !mfa.enabled ? h('button', { class: 'btn', onclick: () => showMfaSetup(false) }, 'Ativar 2FA') : null,
            mfa.enabled ? h('button', { class: 'btn secondary', onclick: () => askPw('Gerar novos códigos de recuperação', false, async (p, _c, close) => {
              const r = await api('/mfa/recovery-codes', { method: 'POST', body: { password: p } }); close(); showRecoveryCodes(r.recoveryCodes, false);
            }) }, 'Novos códigos de recuperação') : null,
            mfa.enabled && !mfa.required ? h('button', { class: 'btn danger', onclick: () => askPw('Desativar 2FA', true, async (p, c, close) => {
              await api('/mfa/disable', { method: 'POST', body: { password: p, code: c } }); close(); toast('2FA desativado.'); route();
            }) }, 'Desativar') : null),
          mfa.required ? h('p', { class: 'small muted' }, 'Obrigatório para administradores nesta empresa.') : null),
        h('div', { class: 'card' }, h('h2', {}, 'Minhas notificações'),
          h('div', { class: 'grid' },
            notif('detractors', 'Cliente insatisfeito (nota de 0 a 6) nas minhas unidades'),
            notif('reports', 'Relatório semanal em PowerPoint'),
            notif('offline', 'Tablet sem sinal nas minhas unidades'),
            h('label', { class: 'f mt' }, 'Meu WhatsApp para receber o alerta de cliente insatisfeito (opcional)', wa,
              h('span', { class: 'small muted' }, 'DDD + número, ex.: 11 99999-0000. Só funciona se o WhatsApp estiver configurado em Configurações → E-mail e WhatsApp. Deixe em branco para não receber.')),
            h('div', { class: 'row' }, h('button', { class: 'btn secondary sm', onclick: async () => {
              try { await api('/me/notifications', { method: 'PUT', body: { whatsapp: wa.value } }); toast('WhatsApp salvo.'); me = null; await loadMe(); } catch (ex) { toast(ex.message, true); }
            } }, 'Salvar WhatsApp'))))),
      securityCards,
      h('div', { class: 'card' }, h('h2', {}, 'Trocar senha'), h('div', { class: 'form-grid' },
        h('label', { class: 'f' }, 'Senha atual', cur), h('label', { class: 'f' }, 'Nova senha', pw), h('label', { class: 'f' }, 'Repita a nova senha', pw2)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
        if (pw.value !== pw2.value) return toast('As senhas não conferem.', true);
        try { await api('/me/password', { method: 'POST', body: { current: cur.value, password: pw.value } }); me = null; showLogin('Senha alterada. Entre com a nova senha.'); } catch (ex) { toast(ex.message, true); }
      } }, 'Salvar nova senha'))));
  }

  route();
})();

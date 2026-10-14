'use strict';
// Faturamento das empresas.
//   • Padrão: assinatura mensal no CARTÃO pelo Mercado Pago (o próprio administrador assina no painel).
//   • PIX/boleto: só o Master gera — na hora, ou ligando a geração e o envio automáticos para a empresa.
//   • Teste grátis: ao terminar sem assinatura, a empresa é suspensa e o painel mostra só a tela de pagamento.
//   • Atraso: vencida a fatura, a empresa fica "em atraso" (tudo funciona, com aviso). No FIM do 5º dia útil
//     após o vencimento (sem sábados, domingos e feriados nacionais), é suspensa: painel limitado ao pagamento
//     e tablets/QR Code param. Pagou, volta na hora.
// Toda baixa de pagamento vem da API do Mercado Pago (nunca do que a notificação diz) e confere valor e moeda.
const { get, all, run, tx, audit } = require('./db');
const { HttpError, bad } = require('./validate');
const mp = require('./mercadopago');
const { companyTz } = require('./companies');
const { planOf } = require('./plans');
const { graceDeadline } = require('./businessDays');
const { localNow } = require('./time');
const { publicUrl } = require('./config');

const today = (companyId, now = Date.now()) => localNow(now, companyTz(companyId)).date;
const fmtMoney = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brDate = (d) => d.split('-').reverse().join('/');
const LOCKED = new Set(['suspended']);

function addMonthsKeepDay(date, months, day) {
  const [y, m] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- avisos por e-mail
function notifyCompany(companyId, { subject, title, intro, rows = [], button = null, alsoMasters = false }) {
  const { queueEmail, renderEmail } = require('./notify');
  const { getSettings } = require('./settings');
  const c = get('SELECT name, billing_email FROM companies WHERE id = ?', companyId);
  const { html, text } = renderEmail({ brand: getSettings(companyId), title, intro, rows, button });
  const to = new Set(all("SELECT email FROM users WHERE company_id = ? AND role = 'admin' AND active = 1", companyId).map((u) => u.email));
  if (c.billing_email) to.add(c.billing_email);
  if (alsoMasters) for (const m of all("SELECT email FROM users WHERE role = 'master' AND active = 1 /* tenant-ok: aviso aos Masters */")) to.add(m.email);
  for (const addr of to) queueEmail({ to: addr, subject: `${c.name}: ${subject}`, text, html, kind: 'billing', companyId });
}

// ---------------------------------------------------------------- faturas
function createInvoice(companyId, { period = null, amountCents, description, dueDate, method = null, createdBy = null }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw bad('Valor inválido.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate || '')) throw bad('Vencimento inválido.');
  if (period && get("SELECT 1 FROM invoices WHERE company_id = ? AND period = ? AND status <> 'canceled'", companyId, period)) throw new HttpError(409, 'Já existe fatura deste mês.');
  const now = Date.now();
  return Number(run(`INSERT INTO invoices (company_id, period, description, amount_cents, due_date, method, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, companyId, period, String(description).slice(0, 200), amountCents, dueDate, method, createdBy, now, now).lastInsertRowid);
}

const invoicesOf = (companyId, limit = 36) => all(`SELECT id, period, description, amount_cents, due_date, status, method, checkout_url, paid_at, paid_amount_cents, sent_at, created_at
  FROM invoices WHERE company_id = ? ORDER BY due_date DESC, id DESC LIMIT ?`, companyId, limit);

// Gera o link de PIX/boleto (Mercado Pago) para a fatura e, se pedido, envia por e-mail.
async function issuePixBoleto(invoiceId, { send = false } = {}) {
  const inv = get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv) throw new HttpError(404, 'Fatura não encontrada.');
  if (inv.status !== 'open') throw new HttpError(409, 'Só é possível cobrar uma fatura em aberto.');
  const c = get('SELECT id, name, billing_email FROM companies WHERE id = ?', inv.company_id);
  if (!inv.checkout_url) {
    const pref = await mp.createPixBoletoPreference({ invoiceId: inv.id, title: `${inv.description} — ${c.name}`, amountCents: inv.amount_cents,
      payerEmail: c.billing_email, notificationUrl: `${publicUrl}/api/webhooks/mercadopago`, backUrl: `${publicUrl}/admin/#/faturamento`,
      expiresAt: Date.now() + 30 * 86_400_000 });
    if (!pref?.init_point || !/^https:\/\//.test(pref.init_point)) throw new HttpError(502, 'O Mercado Pago não devolveu o link de pagamento.');
    run("UPDATE invoices SET checkout_url = ?, mp_preference_id = ?, method = 'pix_boleto', updated_at = ? WHERE id = ?", pref.init_point, String(pref.id || ''), Date.now(), inv.id);
    inv.checkout_url = pref.init_point;
  }
  if (send) {
    notifyCompany(inv.company_id, { subject: `fatura de ${fmtMoney(inv.amount_cents)} (vence ${brDate(inv.due_date)})`, title: 'Sua fatura está disponível',
      intro: 'Pague por PIX ou boleto no link abaixo. A confirmação é automática.',
      rows: [['Descrição', inv.description], ['Valor', fmtMoney(inv.amount_cents)], ['Vencimento', brDate(inv.due_date)]],
      button: { label: 'Pagar com PIX ou boleto', url: inv.checkout_url } });
    run('UPDATE invoices SET sent_at = ? WHERE id = ?', Date.now(), inv.id);
  }
  return { url: inv.checkout_url };
}

function markPaid(invoiceId, { paymentId = null, amountCents = null, method = null, by = null, note = null }) {
  const inv = get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv) throw new HttpError(404, 'Fatura não encontrada.');
  if (inv.status === 'paid') return false;
  if (inv.status === 'canceled' && !paymentId) throw new HttpError(409, 'Fatura cancelada.');
  run("UPDATE invoices SET status = 'paid', paid_at = ?, paid_amount_cents = ?, mp_payment_id = COALESCE(?, mp_payment_id), method = COALESCE(?, method), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?",
    Date.now(), amountCents ?? inv.amount_cents, paymentId, method, note, Date.now(), invoiceId);
  audit(by, 'billing.invoice_paid', { invoiceId, amount: amountCents ?? inv.amount_cents, paymentId, method, manual: !paymentId }, null, { companyId: inv.company_id, asMaster: !!by });
  reevaluate(inv.company_id);
  return true;
}

// ---------------------------------------------------------------- situação da empresa (automática)
function setStatusAuto(c, status, lockKind, reason) {
  run('UPDATE companies SET status = ?, lock_kind = ?, status_reason = ?, updated_at = ? WHERE id = ?', status, lockKind, reason, Date.now(), c.id);
  audit(null, 'billing.status', { from: c.status, to: status, reason }, null, { companyId: c.id });
  audit(null, 'billing.status', { companyId: c.id, company: c.name, from: c.status, to: status, reason }, null, { companyId: null });
}

// Recalcula a situação de UMA empresa pelas faturas e pelo teste grátis. Suspensão manual do Master não é mexida.
function reevaluate(companyId, now = Date.now()) {
  const c = get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c || c.status === 'canceled' || c.lock_kind === 'manual') return c?.status;
  const tz = companyTz(companyId); const day = today(companyId, now);
  // Fatura de cartão: tolerância de 3 dias (a cobrança automática pode cair 1 a 3 dias depois do dia 28, ou levar um dia para confirmar).
  const cardCut = new Date(Date.parse(day + 'T00:00:00Z') - 3 * 86_400_000).toISOString().slice(0, 10);
  const overdue = all(`SELECT id, due_date, amount_cents FROM invoices WHERE company_id = ? AND status = 'open'
    AND due_date < (CASE WHEN method = 'card' THEN ? ELSE ? END) ORDER BY due_date`, companyId, cardCut, day);
  const expired = overdue.filter((i) => now >= graceDeadline(i.due_date, tz));
  const paidSomething = !!get("SELECT 1 FROM invoices WHERE company_id = ? AND status = 'paid'", companyId);
  const subscribed = c.mp_preapproval_status === 'authorized';
  if (expired.length) {
    if (c.status !== 'suspended') {
      setStatusAuto(c, 'suspended', 'overdue', `Fatura vencida em ${brDate(expired[0].due_date)} não paga até o 5º dia útil.`);
      notifyCompany(companyId, { subject: 'acesso suspenso por falta de pagamento', title: 'Acesso suspenso',
        intro: 'A fatura abaixo não foi paga até o fim do 5º dia útil após o vencimento. O painel mostra só a tela de pagamento e os tablets e QR Codes pararam de receber respostas. Assim que o pagamento for confirmado, tudo volta na hora.',
        rows: expired.map((i) => [`Vencimento ${brDate(i.due_date)}`, fmtMoney(i.amount_cents)]), button: { label: 'Pagar agora', url: `${publicUrl}/admin/#/faturamento` }, alsoMasters: true });
    }
    return 'suspended';
  }
  if (overdue.length) {
    // Só reabre o acesso de quem estava suspenso POR ATRASO; fim de teste grátis continua bloqueado até pagar.
    const eligible = c.status === 'active' || c.status === 'trial' || (c.status === 'suspended' && c.lock_kind === 'overdue');
    if (!eligible) return c.status;
    {
      const deadline = graceDeadline(overdue[0].due_date, tz);
      setStatusAuto(c, 'past_due', null, `Fatura vencida em ${brDate(overdue[0].due_date)}.`);
      notifyCompany(companyId, { subject: 'fatura vencida', title: 'Sua fatura venceu',
        intro: `Para evitar a suspensão, pague até ${new Date(deadline - 1).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short' })} (fim do 5º dia útil após o vencimento).`,
        rows: overdue.map((i) => [`Vencimento ${brDate(i.due_date)}`, fmtMoney(i.amount_cents)]), button: { label: 'Ver faturas', url: `${publicUrl}/admin/#/faturamento` } });
    }
    return 'past_due';
  }
  // Teste grátis terminou sem assinatura nem pagamento: suspende e mostra a tela de pagamento.
  if (c.status === 'trial' && c.trial_ends_at && now >= c.trial_ends_at && !subscribed && !paidSomething) {
    setStatusAuto(c, 'suspended', 'trial_expired', 'Teste grátis encerrado.');
    notifyCompany(companyId, { subject: 'seu teste grátis terminou', title: 'O teste grátis terminou',
      intro: 'Para continuar usando o painel, os tablets e o QR Code, escolha o plano e cadastre o cartão. Leva um minuto.',
      button: { label: 'Assinar agora', url: `${publicUrl}/admin/#/faturamento` }, alsoMasters: true });
    return 'suspended';
  }
  // Em dia: volta ao normal.
  if (c.status === 'past_due' || (c.status === 'suspended' && ['overdue', 'trial_expired'].includes(c.lock_kind) && (subscribed || paidSomething))
    || (c.status === 'trial' && (subscribed || paidSomething))) {
    setStatusAuto(c, 'active', null, null);
    if (c.status === 'suspended') notifyCompany(companyId, { subject: 'acesso liberado', title: 'Pagamento confirmado', intro: 'Obrigado! O acesso foi liberado e os tablets voltaram a funcionar.' });
    return 'active';
  }
  return c.status;
}

// ---------------------------------------------------------------- assinatura no cartão (feita pelo administrador)
async function startCardSubscription(companyId, user) {
  const c = get('SELECT * FROM companies WHERE id = ?', companyId);
  const plan = planOf(companyId);
  if (!plan || !plan.priceCents) throw bad('A empresa ainda não tem um plano pago definido. Fale com o suporte da plataforma.');
  if (c.billing_method === 'pix_boleto') throw bad('A cobrança desta empresa é por PIX/boleto, enviada pela plataforma.');
  if (c.mp_preapproval_status === 'authorized') throw new HttpError(409, 'A assinatura no cartão já está ativa.');
  const r = await mp.createPreapproval({ companyId, reason: `${plan.name} — ${c.name}`, payerEmail: c.billing_email || user.email,
    amountCents: plan.priceCents, backUrl: `${publicUrl}/admin/#/faturamento` });
  if (!r?.init_point || !/^https:\/\//.test(r.init_point)) throw new HttpError(502, 'O Mercado Pago não devolveu o link da assinatura.');
  run('UPDATE companies SET mp_preapproval_status = COALESCE(mp_preapproval_status, ?), updated_at = ? WHERE id = ?', 'pending', Date.now(), companyId);
  audit(user.id, 'billing.subscribe_started', { plan: plan.name, amount: plan.priceCents, preapprovalId: r.id }, null, { companyId, asMaster: user.role === 'master' });
  return { url: r.init_point };
}

// Pagamento aprovado da assinatura: baixa a fatura em aberto mais antiga (ou cria a do mês, já paga).
function subscriptionPaid(companyId, { paymentId, amountCents }) {
  if (get('SELECT 1 FROM invoices WHERE mp_payment_id = ?', String(paymentId))) return 'já registrado';
  const open = get("SELECT * FROM invoices WHERE company_id = ? AND status = 'open' ORDER BY due_date LIMIT 1", companyId);
  if (open && amountCents < open.amount_cents) {
    // Cobrado menos que a fatura (ex.: plano mudou e a assinatura não acompanhou): não dá baixa, avisa o Master.
    audit(null, 'billing.amount_mismatch', { invoiceId: open.id, expected: open.amount_cents, received: amountCents, paymentId: String(paymentId) }, null, { companyId });
    audit(null, 'billing.amount_mismatch', { companyId, invoiceId: open.id, expected: open.amount_cents, received: amountCents }, null, { companyId: null });
    return `valor menor que a fatura (${amountCents} < ${open.amount_cents})`;
  }
  if (open) { markPaid(open.id, { paymentId: String(paymentId), amountCents, method: 'card' }); return `fatura ${open.id} paga`; }
  const day = today(companyId); const plan = planOf(companyId);
  const id = createInvoice(companyId, { period: get("SELECT 1 FROM invoices WHERE company_id = ? AND period = ? AND status <> 'canceled'", companyId, day.slice(0, 7)) ? null : day.slice(0, 7),
    amountCents, description: `Assinatura ${plan?.name || ''} — ${day.slice(5, 7)}/${day.slice(0, 4)}`.trim(), dueDate: day, method: 'card' });
  markPaid(id, { paymentId: String(paymentId), amountCents, method: 'card' });
  return `fatura ${id} criada e paga`;
}

// ---------------------------------------------------------------- notificações do Mercado Pago
const parseRef = (ref, kind) => { const m = new RegExp(`^${kind}:(\\d+)$`).exec(String(ref || '')); return m ? Number(m[1]) : null; };

async function handleNotification(topic, resourceId) {
  const t = String(topic || '').toLowerCase();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(resourceId || ''))) return { ignored: 'id inválido' };
  if (t === 'payment') {
    const p = await mp.getPayment(resourceId);
    const key = `payment:${p.id}:${p.status}`;
    if (get('SELECT 1 FROM billing_events WHERE event_key = ?', key)) return { duplicate: true };
    let result = `pagamento ${p.status}`; let companyId = null;
    const invoiceId = parseRef(p.external_reference, 'invoice');
    const amount = mp.cents(p.transaction_amount);
    if (p.status === 'approved' && p.currency_id === 'BRL') {
      if (invoiceId) {
        const inv = get('SELECT * FROM invoices WHERE id = ?', invoiceId);
        companyId = inv?.company_id ?? null;
        if (!inv) result = 'fatura inexistente';
        else if (amount < inv.amount_cents) result = `valor menor que a fatura (${amount} < ${inv.amount_cents})`;
        else result = markPaid(inv.id, { paymentId: String(p.id), amountCents: amount, method: p.payment_type_id === 'ticket' ? 'boleto' : p.payment_method_id === 'pix' ? 'pix' : p.payment_type_id }) ? `fatura ${inv.id} paga` : 'fatura já paga';
      } else {
        const viaSub = parseRef(p.external_reference, 'company') || (p.metadata?.preapproval_id ? get('SELECT id FROM companies WHERE mp_preapproval_id = ?', String(p.metadata.preapproval_id))?.id : null);
        if (viaSub) { companyId = viaSub; result = subscriptionPaid(viaSub, { paymentId: p.id, amountCents: amount }); }
        else result = 'pagamento sem referência conhecida';
      }
    }
    run('INSERT INTO billing_events (event_key, topic, resource_id, company_id, result, received_at) VALUES (?,?,?,?,?,?)', key, 'payment', String(p.id), companyId, result, Date.now());
    return { result };
  }
  if (t === 'subscription_preapproval' || t === 'preapproval') {
    const s = await mp.getPreapproval(resourceId);
    // A mesma assinatura pode voltar a um estado anterior (ativa → pausada → ativa): a chave inclui a data da mudança.
    const key = `preapproval:${s.id}:${s.status}:${s.last_modified || s.date_modified || Date.now()}`;
    if (get('SELECT 1 FROM billing_events WHERE event_key = ?', key)) return { duplicate: true };
    const companyId = parseRef(s.external_reference, 'company');
    const c = companyId ? get('SELECT * FROM companies WHERE id = ?', companyId) : null;
    let result = 'assinatura sem empresa';
    if (c) {
      if (s.status === 'authorized') {
        const old = c.mp_preapproval_id && c.mp_preapproval_id !== s.id ? c.mp_preapproval_id : null;
        tx(() => {
          run("UPDATE companies SET mp_preapproval_id = NULL WHERE mp_preapproval_id = ? AND id <> ? /* tenant-ok: id da assinatura é único */", s.id, c.id);
          run("UPDATE companies SET mp_preapproval_id = ?, mp_preapproval_status = 'authorized', billing_method = 'card', billing_day = ?, updated_at = ? WHERE id = ?",
            s.id, Math.min(28, Number(today(c.id).slice(8, 10))), Date.now(), c.id);
        });
        // Cartão trocado: cancela a assinatura anterior para não cobrar duas vezes.
        if (old) { try { await mp.updatePreapproval(old, { status: 'cancelled' }); } catch (e) { console.error('[mp] cancelar assinatura antiga', e.message); } }
        audit(null, 'billing.subscription_authorized', { preapprovalId: s.id, replaced: old }, null, { companyId: c.id });
        reevaluate(c.id);
        result = 'assinatura ativa';
      } else if (c.mp_preapproval_id === s.id || !c.mp_preapproval_id) {
        run('UPDATE companies SET mp_preapproval_status = ?, updated_at = ? WHERE id = ?', String(s.status).slice(0, 20), Date.now(), c.id);
        audit(null, 'billing.subscription_status', { preapprovalId: s.id, status: s.status }, null, { companyId: c.id });
        result = `assinatura ${s.status}`;
      } else result = `assinatura antiga ${s.status} (ignorada)`;
    }
    run('INSERT INTO billing_events (event_key, topic, resource_id, company_id, result, received_at) VALUES (?,?,?,?,?,?)', key, 'preapproval', String(s.id), c?.id ?? null, result, Date.now());
    return { result };
  }
  if (t === 'subscription_authorized_payment' || t === 'authorized_payment') {
    const a = await mp.getAuthorizedPayment(resourceId);
    const payStatus = a.payment?.status || a.status;
    const key = `authorized_payment:${a.id}:${payStatus}`;
    if (get('SELECT 1 FROM billing_events WHERE event_key = ?', key)) return { duplicate: true };
    const c = a.preapproval_id ? get('SELECT id FROM companies WHERE mp_preapproval_id = ?', String(a.preapproval_id)) : null;
    let result = `cobrança da assinatura ${payStatus}`;
    if (c && payStatus === 'approved' && (a.currency_id || 'BRL') === 'BRL' && !a.payment?.id) result = 'aprovada, aguardando o número do pagamento';
    else if (c && payStatus === 'approved' && (a.currency_id || 'BRL') === 'BRL') result = subscriptionPaid(c.id, { paymentId: a.payment.id, amountCents: mp.cents(a.transaction_amount) });
    else if (!c) result = 'assinatura desconhecida';
    run('INSERT INTO billing_events (event_key, topic, resource_id, company_id, result, received_at) VALUES (?,?,?,?,?,?)', key, 'authorized_payment', String(a.id), c?.id ?? null, result, Date.now());
    return { result };
  }
  return { ignored: `tópico ${t}` };
}

// ---------------------------------------------------------------- rotina (de hora em hora)
// 1) cria a fatura do mês 7 dias antes do vencimento (e, se ligado, gera e envia o PIX/boleto);
// 2) recalcula a situação de todas as empresas (teste grátis, atraso, suspensão, liberação).
async function runBilling(now = Date.now()) {
  const out = { invoices: 0, sent: 0, statuses: {} };
  const companies = all("SELECT * FROM companies WHERE status <> 'canceled' ORDER BY id /* tenant-ok: rotina de faturamento de todas as empresas */");
  for (const c of companies) {
    try {
      const plan = planOf(c.id);
      const billable = plan?.priceCents > 0 && c.billing_day && ['active', 'past_due', 'suspended'].includes(c.status) && c.lock_kind !== 'manual'
        // Cartão: continua gerando a fatura mesmo com a assinatura pausada/cancelada no Mercado Pago (aí ela vence e o atraso segue o normal).
        && (c.billing_method === 'pix_boleto' || (c.billing_method === 'card' && !!c.mp_preapproval_id));
      if (billable) {
        const day = today(c.id, now);
        // Próximo vencimento: neste mês (se ainda não passou) ou no próximo.
        let due = addMonthsKeepDay(day, 0, c.billing_day);
        if (due < day) due = addMonthsKeepDay(day, 1, c.billing_day);
        const daysTo = (Date.parse(due) - Date.parse(day)) / 86_400_000;
        const period = due.slice(0, 7);
        if (daysTo <= 7 && !get("SELECT 1 FROM invoices WHERE company_id = ? AND period = ? AND status <> 'canceled'", c.id, period)) {
          const id = createInvoice(c.id, { period, amountCents: plan.priceCents, description: `Assinatura ${plan.name} — ${period.slice(5)}/${period.slice(0, 4)}`,
            dueDate: due, method: c.billing_method === 'pix_boleto' ? 'pix_boleto' : 'card' });
          out.invoices++;
          audit(null, 'billing.invoice_created', { invoiceId: id, period, amount: plan.priceCents, due }, null, { companyId: c.id });
          if (c.billing_method === 'pix_boleto' && c.auto_invoice && mp.configured()) {
            try { await issuePixBoleto(id, { send: true }); out.sent++; } catch (e) { console.error(`[faturamento] PIX/boleto empresa ${c.id}`, e.message); }
          }
        }
      }
      out.statuses[c.id] = reevaluate(c.id, now);
    } catch (e) { console.error(`[faturamento] empresa ${c.id}`, e.message); }
  }
  return out;
}

// Resumo para a tela de faturamento (administrador e Master).
function overview(companyId) {
  const c = get('SELECT id, name, status, status_reason, lock_kind, trial_ends_at, billing_method, auto_invoice, billing_day, mp_preapproval_status, billing_email FROM companies WHERE id = ?', companyId);
  const plan = planOf(companyId);
  const tz = companyTz(companyId);
  const invoices = invoicesOf(companyId);
  const firstOverdue = invoices.filter((i) => i.status === 'open' && i.due_date < today(companyId)).sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  return {
    company: c, plan, mpConfigured: mp.configured(), invoices,
    graceDeadline: firstOverdue ? graceDeadline(firstOverdue.due_date, tz) : null,
    locked: LOCKED.has(c.status),
  };
}

module.exports = { createInvoice, invoicesOf, issuePixBoleto, markPaid, reevaluate, startCardSubscription, subscriptionPaid, handleNotification, runBilling, overview, addMonthsKeepDay, LOCKED };

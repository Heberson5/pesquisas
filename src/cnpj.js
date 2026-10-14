'use strict';
// CNPJ: validação dos dígitos verificadores e consulta dos dados públicos da Receita Federal.
// Consulta primeiro a BrasilAPI e, se ela falhar, a ReceitaWS. Os endereços são fixos (nunca vêm do usuário),
// o CNPJ vai só com dígitos e a resposta é reduzida aos campos que o cadastro usa.

const digits = (v) => String(v ?? '').replace(/\D/g, '');

function isValid(value) {
  const c = digits(value);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((s, x, i) => s + x * Number(c[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

const format = (value) => digits(value).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

const clip = (v, max = 150) => (v === null || v === undefined || v === '' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null);
const title = (v) => (v ? v.toLowerCase().replace(/(^|[\s/(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (w) => w.toLowerCase()) : v);
const cep = (v) => { const d = digits(v); return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : null; };
const brDate = (v) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null); };
const email = (v) => (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase().slice(0, 254) : null);

function fromBrasilApi(j) {
  const street = [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(' ');
  return {
    legalName: clip(j.razao_social), tradeName: clip(j.nome_fantasia),
    status: clip(j.descricao_situacao_cadastral, 40), openedAt: brDate(j.data_inicio_atividade),
    cnae: clip([j.cnae_fiscal, j.cnae_fiscal_descricao].filter(Boolean).join(' — '), 200),
    address: { street: clip(title(street)), number: clip(j.numero, 20), complement: clip(j.complemento, 80), district: clip(title(j.bairro), 80),
      city: clip(title(j.municipio), 80), uf: clip(j.uf, 2), cep: cep(j.cep) },
    phone: clip(digits(j.ddd_telefone_1) || null, 20), email: email(j.email), source: 'BrasilAPI',
  };
}

function fromReceitaWs(j) {
  if (j.status && j.status !== 'OK') throw new Error(j.message || 'CNPJ não encontrado.');
  const act = Array.isArray(j.atividade_principal) ? j.atividade_principal[0] : null;
  return {
    legalName: clip(j.nome), tradeName: clip(j.fantasia),
    status: clip(j.situacao, 40), openedAt: brDate(j.abertura),
    cnae: clip(act ? `${act.code} — ${act.text}` : null, 200),
    address: { street: clip(title(j.logradouro)), number: clip(j.numero, 20), complement: clip(j.complemento, 80), district: clip(title(j.bairro), 80),
      city: clip(title(j.municipio), 80), uf: clip(j.uf, 2), cep: cep(j.cep) },
    phone: clip(digits(String(j.telefone || '').split('/')[0]) || null, 20), email: email(j.email), source: 'ReceitaWS',
  };
}

const SOURCES = [
  { name: 'BrasilAPI', url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, parse: fromBrasilApi },
  { name: 'ReceitaWS', url: (c) => `https://receitaws.com.br/v1/cnpj/${c}`, parse: fromReceitaWs },
];

// Trocável nos testes (o servidor real usa o fetch do Node).
const net = { fetch: (...a) => fetch(...a), timeoutMs: 6000 };

// Devolve { found: true, data } | { found: false, notFound: true } | { found: false, unavailable: true, errors }.
async function lookup(value) {
  const c = digits(value);
  if (!isValid(c)) return { found: false, invalid: true };
  const errors = [];
  let notFound = false;
  for (const s of SOURCES) {
    try {
      const res = await net.fetch(s.url(c), { headers: { Accept: 'application/json', 'User-Agent': 'PesquisaSatisfacao/1.0' }, redirect: 'error', signal: AbortSignal.timeout(net.timeoutMs) });
      if (res.status === 404) { notFound = true; continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 200_000) throw new Error('Resposta grande demais.');
      const data = s.parse(JSON.parse(text));
      if (!data.legalName) throw new Error('Resposta sem razão social.');
      return { found: true, data: { cnpj: c, ...data, active: /^ATIVA$/i.test(data.status || '') } };
    } catch (e) {
      if (/não encontrado|not found|inválido/i.test(e.message)) notFound = true;
      errors.push(`${s.name}: ${e.message}`.slice(0, 200));
    }
  }
  return notFound ? { found: false, notFound: true } : { found: false, unavailable: true, errors };
}

module.exports = { digits, isValid, format, lookup, net, fromBrasilApi, fromReceitaWs };

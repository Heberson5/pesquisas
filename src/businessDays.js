'use strict';
// Dias úteis no Brasil: sem sábados, domingos e feriados nacionais — inclusive os bancários que mudam de data
// (Carnaval, Sexta-feira Santa e Corpus Christi), para nunca suspender alguém num dia em que o banco não compensa.
const { parseLocal } = require('./time');

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher).
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;

const cache = new Map();
function holidays(y) {
  if (cache.has(y)) return cache.get(y);
  const map = new Map([
    [`${y}-01-01`, 'Confraternização Universal'], [`${y}-04-21`, 'Tiradentes'], [`${y}-05-01`, 'Dia do Trabalho'],
    [`${y}-09-07`, 'Independência'], [`${y}-10-12`, 'Nossa Senhora Aparecida'], [`${y}-11-02`, 'Finados'],
    [`${y}-11-15`, 'Proclamação da República'], [`${y}-12-25`, 'Natal'],
  ]);
  if (y >= 2024) map.set(`${y}-11-20`, 'Dia Nacional de Zumbi e da Consciência Negra');
  const e = easter(y);
  map.set(iso(e - 48 * DAY), 'Carnaval (segunda)'); map.set(iso(e - 47 * DAY), 'Carnaval (terça)');
  map.set(iso(e - 2 * DAY), 'Sexta-feira Santa'); map.set(iso(e + 60 * DAY), 'Corpus Christi');
  cache.set(y, map);
  return map;
}

function isBusinessDay(date) {
  const t = Date.parse(date + 'T00:00:00Z');
  const wd = new Date(t).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays(+date.slice(0, 4)).has(date);
}

// n-ésimo dia útil DEPOIS de date (YYYY-MM-DD).
function addBusinessDays(date, n) {
  let t = Date.parse(date + 'T00:00:00Z'); let left = n;
  while (left > 0) { t += DAY; if (isBusinessDay(iso(t))) left--; }
  return iso(t);
}

// Fim do 5º dia útil após o vencimento (meia-noite seguinte, no fuso informado). Depois disso, suspende.
function graceDeadline(dueDate, tz, days = 5) {
  const last = addBusinessDays(dueDate, days);
  return parseLocal(iso(Date.parse(last + 'T00:00:00Z') + DAY) + 'T00:00', tz);
}

module.exports = { easter, holidays, isBusinessDay, addBusinessDays, graceDeadline };

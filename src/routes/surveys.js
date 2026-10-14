'use strict';
// Pesquisas e arquivos (imagem/vídeo de agradecimento, logo, ícones) — sempre da empresa em uso.
// Gestor cria pesquisas e altera as que só são usadas nas unidades dele.
const express = require('express');
const { get, all, run, tx, auditReq } = require('../db');
const { requireCompany, requirePerm } = require('../auth');
const { P } = require('../permissions');
const { HttpError, bad, str, int, id } = require('../validate');
const { LANGS, CONTACT_MODES, loadSurvey, normalizeQuestions, normalizeI18n } = require('../surveys');
const { computeBreakdown } = require('../stats');
const { scope } = require('../scope');
const { MEDIA_MAX, sniffMime, saveMedia, mediaOf } = require('../media');

const router = express.Router();
router.use(requireCompany);

// Gestor só altera uma pesquisa se TODAS as unidades que a usam (como padrão ou em campanha) forem dele;
// campanha para todas as unidades conta como uso fora do escopo dele.
function canEditSurvey(user, surveyId) {
  const s = scope(user);
  if (!s) return true;
  const used = all('SELECT id FROM branches WHERE company_id = ? AND survey_id = ?', user.companyId, surveyId).map((b) => b.id);
  const sched = all('SELECT branch_id FROM schedules WHERE company_id = ? AND survey_id = ? AND ends_at > ?', user.companyId, surveyId, Date.now());
  if (sched.some((x) => x.branch_id === null)) return false;
  return [...used, ...sched.map((x) => x.branch_id)].every((b) => s.includes(b));
}

router.get('/surveys', (req, res) => {
  const rows = all(`SELECT s.id, s.title, s.active, s.updated_at,
      (SELECT COUNT(*) FROM questions q WHERE q.survey_id = s.id) AS questions,
      (SELECT COUNT(*) FROM questions q WHERE q.survey_id = s.id AND q.is_nps = 1) AS nps_questions,
      (SELECT COUNT(*) FROM responses r WHERE r.survey_id = s.id AND r.company_id = s.company_id) AS responses
    FROM surveys s WHERE s.company_id = ? ORDER BY s.active DESC, s.updated_at DESC`, req.user.companyId);
  res.json(rows.map((s) => ({ ...s, editable: req.user.can(P.SURVEYS) && canEditSurvey(req.user, s.id) })));
});

router.get('/surveys/:id', (req, res) => {
  const cid = req.user.companyId;
  const s = loadSurvey(id(req.params.id), cid);
  if (!s) throw new HttpError(404, 'Pesquisa não encontrada.');
  withRefs(s);
  s.has_responses = !!get('SELECT 1 FROM responses WHERE survey_id = ? AND company_id = ? LIMIT 1', s.id, cid);
  s.thanks_media = s.thanks_media_id ? get('SELECT id, mime, original_name FROM media WHERE id = ? AND company_id = ?', s.thanks_media_id, cid) : null;
  s.editable = req.user.can(P.SURVEYS) && canEditSurvey(req.user, s.id);
  res.json(s);
});

function surveyInput(companyId, body) {
  const mediaId = body?.thanks_media_id ? String(body.thanks_media_id) : null;
  if (mediaId && (!/^[a-f0-9]{32}$/.test(mediaId) || !mediaOf(companyId, mediaId))) throw bad('Mídia inválida.');
  const questions = body?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 30) throw bad('A pesquisa deve ter entre 1 e 30 perguntas.');
  const languages = parseLanguages(body.languages);
  return {
    title: str(body.title, { field: 'título', min: 3, max: 120 }),
    welcome_title: str(body.welcome_title, { field: 'título de boas-vindas', min: 2, max: 120 }),
    welcome_text: str(body.welcome_text, { field: 'texto de boas-vindas', max: 300, optional: true }),
    thanks_title: str(body.thanks_title, { field: 'título de agradecimento', min: 2, max: 120 }),
    thanks_text: str(body.thanks_text, { field: 'texto de agradecimento', max: 300, optional: true }),
    thanks_media_id: mediaId,
    thanks_seconds: int(body.thanks_seconds, { field: 'tempo do agradecimento', min: 3, max: 60 }),
    idle_seconds: int(body.idle_seconds, { field: 'tempo de inatividade', min: 15, max: 600 }),
    active: body.active === false ? 0 : 1,
    contact_mode: body.contact_mode === undefined ? 'never' : (Object.hasOwn(CONTACT_MODES, body.contact_mode) ? body.contact_mode : (() => { throw bad('Modo de contato inválido.'); })()),
    languages,
    i18n: normalizeI18n(body.i18n, languages, [['welcome_title', 120], ['welcome_text', 300], ['thanks_title', 120], ['thanks_text', 300]], { where: 'da pesquisa' }),
    questions: normalizeQuestions(questions, languages),
  };
}

function parseLanguages(v) {
  if (v === undefined) return ['pt'];
  if (!Array.isArray(v) || v.length > LANGS.length || !v.every((l) => LANGS.includes(l))) throw bad('Idiomas inválidos.');
  return ['pt', ...LANGS.filter((l) => l !== 'pt' && v.includes(l))];
}

// Condições no banco referenciam o id da pergunta; no editor, a posição (ref). Converte nos dois sentidos.
function withRefs(survey) {
  const pos = new Map(survey.questions.map((q, i) => [q.id, i]));
  survey.questions = survey.questions.map((q) => ({ ...q, show_if: q.show_if && pos.has(q.show_if.q) ? { ref: pos.get(q.show_if.q), op: q.show_if.op, value: q.show_if.value } : null }));
  return survey;
}
const condForDb = (cond, ids) => (cond ? JSON.stringify({ q: ids[cond.ref], op: cond.op, value: cond.value }) : null);
const i18nForDb = (o) => (o && Object.keys(o).length ? JSON.stringify(o) : null);

function insertQuestions(surveyId, questions) {
  const ids = [];
  questions.forEach((q, i) => {
    const r = run(
      'INSERT INTO questions (survey_id, position, text, help_text, type, required, is_nps, options_json, display, icon, show_if, i18n) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      surveyId, i, q.text, q.help_text, q.type, q.required, q.is_nps, q.options.length ? JSON.stringify(q.options) : null, q.display || 'default', q.icon || null,
      condForDb(q.show_if, ids), i18nForDb(q.i18n));
    ids.push(Number(r.lastInsertRowid));
  });
}

router.post('/surveys', requirePerm(P.SURVEYS), (req, res) => {
  const cid = req.user.companyId;
  const s = surveyInput(cid, req.body);
  const now = Date.now();
  const newId = tx(() => {
    const r = run(`INSERT INTO surveys (company_id, title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_media_id,
      thanks_seconds, idle_seconds, active, contact_mode, languages, i18n, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    cid, s.title, s.welcome_title, s.welcome_text, s.thanks_title, s.thanks_text, s.thanks_media_id,
    s.thanks_seconds, s.idle_seconds, s.active, s.contact_mode, JSON.stringify(s.languages), i18nForDb(s.i18n), now, now);
    insertQuestions(r.lastInsertRowid, s.questions);
    return Number(r.lastInsertRowid);
  });
  auditReq(req, 'survey.create', { id: newId, title: s.title });
  res.status(201).json({ id: newId });
});

router.put('/surveys/:id', requirePerm(P.SURVEYS), (req, res) => {
  const cid = req.user.companyId;
  const sid = id(req.params.id);
  const current = loadSurvey(sid, cid);
  if (!current) throw new HttpError(404, 'Pesquisa não encontrada.');
  if (!canEditSurvey(req.user, sid)) throw new HttpError(403, 'Esta pesquisa também é usada em unidades que não são suas. Peça ao administrador ou use "Duplicar".');
  const s = surveyInput(cid, req.body);
  const hasResponses = !!get('SELECT 1 FROM responses WHERE survey_id = ? AND company_id = ? LIMIT 1', sid, cid);
  tx(() => {
    run(`UPDATE surveys SET title=?, welcome_title=?, welcome_text=?, thanks_title=?, thanks_text=?, thanks_media_id=?,
      thanks_seconds=?, idle_seconds=?, active=?, contact_mode=?, languages=?, i18n=?, updated_at=? WHERE id=? AND company_id=?`,
    s.title, s.welcome_title, s.welcome_text, s.thanks_title, s.thanks_text, s.thanks_media_id,
    s.thanks_seconds, s.idle_seconds, s.active, s.contact_mode, JSON.stringify(s.languages), i18nForDb(s.i18n), Date.now(), sid, cid);
    if (!hasResponses) {
      run('DELETE FROM questions WHERE survey_id = ?', sid);
      insertQuestions(sid, s.questions);
    } else {
      // Com respostas coletadas, a estrutura fica congelada para não corromper o histórico.
      // Só é permitido corrigir textos e a marcação de NPS (que recalcula os relatórios).
      if (s.questions.length !== current.questions.length) throw new HttpError(409, 'Esta pesquisa já tem respostas: não é possível adicionar ou remover perguntas. Use "Duplicar".');
      s.questions.forEach((q, i) => {
        const old = current.questions[i];
        if (old.type !== q.type || JSON.stringify(old.options) !== JSON.stringify(q.options)) {
          throw new HttpError(409, 'Esta pesquisa já tem respostas: não é possível mudar tipo ou opções. Use "Duplicar".');
        }
        // A aparência (números/carinhas/ícones) pode mudar: o valor gravado continua o mesmo número.
        run('UPDATE questions SET text=?, help_text=?, required=?, is_nps=?, display=?, icon=?, show_if=?, i18n=? WHERE id=? AND survey_id=?',
          q.text, q.help_text, q.required, q.is_nps, q.display, q.icon, condForDb(q.show_if, current.questions.map((x) => x.id)), i18nForDb(q.i18n), old.id, sid);
      });
    }
    if (!s.active) run('UPDATE branches SET survey_id = NULL WHERE company_id = ? AND survey_id = ?', cid, sid);
  });
  auditReq(req, 'survey.update', { id: sid, title: s.title });
  res.json({ ok: true });
});

router.post('/surveys/:id/duplicate', requirePerm(P.SURVEYS), (req, res) => {
  const cid = req.user.companyId;
  const src = loadSurvey(id(req.params.id), cid);
  if (!src) throw new HttpError(404, 'Pesquisa não encontrada.');
  const now = Date.now();
  const newId = tx(() => {
    const r = run(`INSERT INTO surveys (company_id, title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_media_id,
      thanks_seconds, idle_seconds, active, contact_mode, languages, i18n, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
    cid, (src.title + ' (cópia)').slice(0, 120), src.welcome_title, src.welcome_text, src.thanks_title, src.thanks_text,
    src.thanks_media_id, src.thanks_seconds, src.idle_seconds, src.contact_mode, JSON.stringify(src.languages), i18nForDb(src.i18n), now, now);
    insertQuestions(r.lastInsertRowid, withRefs(src).questions.map((q) => ({ ...q, required: q.required ? 1 : 0, is_nps: q.is_nps ? 1 : 0 })));
    return Number(r.lastInsertRowid);
  });
  auditReq(req, 'survey.duplicate', { from: src.id, id: newId });
  res.status(201).json({ id: newId });
});

router.get('/surveys/:id/breakdown', requirePerm(P.DASHBOARD), (req, res) => {
  const survey = loadSurvey(id(req.params.id), req.user.companyId);
  if (!survey) throw new HttpError(404, 'Pesquisa não encontrada.');
  res.json(computeBreakdown(req.user, survey, req.query));
});

// ---------------------------------------------------------------- mídia (imagem/vídeo de agradecimento, logo, ícones)
const canUpload = (req, res, next) => {
  if (!req.user.can(P.SURVEYS) && !req.user.can(P.SETTINGS)) throw new HttpError(403, 'Você não tem permissão para esta ação.');
  next();
};
router.post('/media', canUpload, express.raw({ type: () => true, limit: MEDIA_MAX }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw bad('Arquivo vazio.');
  const mime = sniffMime(req.body);
  if (!mime) throw new HttpError(415, 'Formato não suportado. Use JPG, PNG, WEBP, GIF, MP4 ou WEBM.');
  const original = str(decodeURIComponent(String(req.get('x-filename') || '')).slice(0, 200), { field: 'nome', max: 200, optional: true });
  const mediaId = saveMedia(req.user.companyId, req.body, mime, original);
  auditReq(req, 'media.upload', { id: mediaId, mime, size: req.body.length });
  res.status(201).json({ id: mediaId, mime, url: `/media/${mediaId}` });
});

module.exports = router;

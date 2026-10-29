// Durable, case-bound work. Page navigation never owns or cancels these jobs.
import crypto from 'node:crypto';
import { HttpError, can } from './auth.js';
import { nowISO } from './db.js';

const PERMISSION = { analysis: 'case.edit', collection: 'case.edit', verification: 'ai.request', report: 'case.edit' };
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export function makeCaseTasks(db, { cases, audit, concurrency = 2 }) {
  const handlers = new Map();
  let running = 0, stopped = false;
  db.prepare("UPDATE case_tasks SET status='failed', error='The server stopped during this task. Retry to continue using the same case records.', finished_at=? WHERE status='processing'").run(nowISO());
  const parse = row => row && ({ ...row, input: JSON.parse(row.input_json), result: row.result_json ? JSON.parse(row.result_json) : null, input_json: undefined, result_json: undefined, status_label: ({ pending: 'Pending', processing: 'Processing', completed: 'Completed', failed: 'Failed' })[row.status] });
  const row = id => { const r = db.prepare('SELECT * FROM case_tasks WHERE id=?').get(id); if (!r) throw new HttpError(404, 'Task not found.'); return r; };
  function allowed(user, task, edit = false) {
    if (!can(user, 'case.read')) throw new HttpError(403, 'Your role cannot read cases.');
    const c = cases.mustCase(task.case_id);
    if (edit) {
      if (!can(user, PERMISSION[task.kind])) throw new HttpError(403, 'Your role cannot run this task.');
      cases.requireEdit(user, c, { states: new Set(["draft", "analysing", "analysis_failed", "analyst_review", "needs_evidence"]) });
    }
    return c;
  }
  function enqueue(user, caseId, kind, input = {}, { requestKey = null } = {}) {
    if (!handlers.has(kind)) throw new HttpError(400, 'Unknown task type.');
    allowed(user, { case_id: caseId, kind }, true);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Task options must be an object.');
    const claims = cases.aggregate(caseId).claims.filter(c => !c.removed);
    if (input.claim_ids && (!Array.isArray(input.claim_ids) || input.claim_ids.some(id => !claims.some(c => c.id === id)))) throw new HttpError(400, 'Task claims must belong to this case.');
    const encoded = JSON.stringify(canonical(input));
    if (encoded.length > 16000 || (requestKey != null && (typeof requestKey !== 'string' || requestKey.length > 160))) throw new HttpError(400, 'Invalid task options or request key.');
    // Same options return the same record after a refresh. An explicit new run may
    // provide a new request key. While work is active, even new keys coalesce.
    const c = cases.mustCase(caseId);
    const source = [c.claim_text, c.source_url, c.published_at, c.claimed_event_at,
      db.prepare("SELECT id,sha256 FROM media WHERE case_id=? ORDER BY id").all(caseId),
      db.prepare("SELECT id,current_text FROM ocr_texts WHERE case_id=? ORDER BY id").all(caseId)];
    if (kind !== "analysis") source.push(claims.map(cl => [cl.id, cl.text, cl.assessment, cl.rationale]));
    const digest = crypto.createHash('sha256').update(JSON.stringify([caseId, kind, user.id, encoded, requestKey, source])).digest('hex');
    const id = db.transaction(() => {
      const existing = db.prepare("SELECT id,created_by FROM case_tasks WHERE dedupe_key=? OR (case_id=? AND kind=? AND input_json=? AND status IN ('pending','processing')) ORDER BY id DESC LIMIT 1").get(digest, caseId, kind, encoded);
      if (existing) { if (existing.created_by !== user.id) throw new HttpError(409, "A matching task is already queued for this case."); return existing.id; }
      const r = db.prepare("INSERT INTO case_tasks(case_id,kind,dedupe_key,input_json,status,created_by,created_at) VALUES (?,?,?,?,'pending',?,?)").run(caseId, kind, digest, encoded, user.id, nowISO());
      audit(user, 'Background task queued', 'case', caseId, { task_id: Number(r.lastInsertRowid), kind });
      return Number(r.lastInsertRowid);
    }).immediate();
    setImmediate(pump);
    return get(user, id);
  }
  function get(user, id) { const r = row(id); allowed(user, r); if (r.created_by !== user.id && user.role !== "admin") throw new HttpError(403, "This task belongs to another requester."); return parse(r); }
  function list(user, caseId = null) {
    if (!can(user, 'case.read')) throw new HttpError(403, 'Your role cannot read cases.');
    if (caseId) cases.mustCase(caseId);
    // Other users' task options/results are private; case-wide activity is exposed
    // only as a small summary in the case aggregate.
    return db.prepare(`SELECT * FROM case_tasks WHERE created_by=? ${caseId ? 'AND case_id=?' : ''} ORDER BY id DESC LIMIT 100`).all(user.id, ...(caseId ? [caseId] : [])).map(parse);
  }
  function retry(user, id) {
    const task = row(id); allowed(user, task, true);
    if (task.created_by !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only the requester or an administrator can retry this task.');
    db.prepare("UPDATE case_tasks SET status='pending', error=NULL, finished_at=NULL, created_by=? WHERE id=? AND status='failed'").run(user.id, task.id);
    setImmediate(pump); return get(user, id);
  }
  async function execute(task) {
    try {
      const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(task.created_by);
      if (!user) throw new HttpError(403, 'The requesting account is no longer active.');
      allowed(user, task, true);
      const result = await handlers.get(task.kind)(user, task.case_id, JSON.parse(task.input_json));
      db.prepare("UPDATE case_tasks SET status='completed',result_json=?,finished_at=?,error=NULL WHERE id=? AND status='processing'").run(JSON.stringify(result ?? {}), nowISO(), task.id);
      audit(user, 'Background task completed', 'case', task.case_id, { task_id: task.id, kind: task.kind });
    } catch (e) {
      const message = e.status && e.status < 500 ? e.message : 'The task could not finish. Existing case records were retained. Retry or ask an administrator to check the server.';
      db.prepare("UPDATE case_tasks SET status='failed',error=?,finished_at=? WHERE id=?").run(message, nowISO(), task.id);
      audit(null, 'Background task failed', 'case', task.case_id, { task_id: task.id, kind: task.kind, error: message });
      console.error('background task failed', task.id, e.message);
    } finally { running--; setImmediate(pump); }
  }
  function pump() {
    if (stopped || !db.open) return;
    while (running < concurrency) {
      const next = db.transaction(() => {
        const t = db.prepare("SELECT t.* FROM case_tasks t WHERE t.status='pending' AND NOT EXISTS (SELECT 1 FROM case_tasks r WHERE r.case_id=t.case_id AND r.status='processing') AND NOT EXISTS (SELECT 1 FROM investigations i WHERE i.case_id=t.case_id AND i.status IN ('queued','running')) ORDER BY t.id LIMIT 1").get();
        if (!t || !handlers.has(t.kind)) return null;
        if (!db.prepare("UPDATE case_tasks SET status='processing',started_at=?,attempts=attempts+1 WHERE id=? AND status='pending'").run(nowISO(), t.id).changes) return null;
        return t;
      }).immediate();
      if (!next) break;
      running++; void execute(next);
    }
  }
  const wake = setInterval(pump, 1000); wake.unref();
  return { enqueue, get, list, retry, register(kind, fn) { handlers.set(kind, fn); }, start() { setImmediate(pump); }, idle: () => !running && !db.prepare("SELECT 1 FROM case_tasks WHERE status='pending'").get(), close() { stopped = true; clearInterval(wake); } };
}

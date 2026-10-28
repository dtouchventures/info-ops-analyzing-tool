import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, reopenServer, login } from './helpers.js';
import { CLAIM_LIMIT_MESSAGE } from '../shared/claim-limit.js';

let S, ana, other, viewer;
before(async () => { S = await startServer(); ana = await login(S.base, 'ana'); other = await login(S.base, 'ana2'); viewer = await login(S.base, 'view'); });
after(async () => { S.ctx.tasks.close(); await S.close(); S.ctx.db.close(); });
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, predicate = x => ['completed', 'failed', 'done'].includes(x?.status)) {
  for (let i = 0; i < 250; i++) { const v = await fn(); if (predicate(v)) return v; await pause(20); }
  assert.fail('task did not settle');
}
const fresh = async (text = 'A county opened three public libraries. A ministry built two bridges. A school enrolled fifty pupils.') => (await ana.post('/api/cases', { claim_text: text })).body.id;
const task = async (id, kind, input = {}, request_key) => ana.post(`/api/cases/${id}/tasks`, { kind, input, request_key });

test('two-claim lifetime limit is atomic across simultaneous API requests and direct database writes', async () => {
  const id = await fresh();
  assert.equal((await ana.get(`/api/cases/${id}`)).body.claimCapacity.used, 0);
  const requests = await Promise.all(Array.from({ length: 8 }, (_, n) => ana.post(`/api/cases/${id}/claims`, { text: `Claim number ${n} needs evidence.` })));
  assert.equal(requests.filter(r => r.status === 201).length, 2);
  for (const r of requests.filter(r => r.status !== 201)) { assert.equal(r.status, 409); assert.equal(r.body.error, CLAIM_LIMIT_MESSAGE); }
  let a = (await ana.get(`/api/cases/${id}`)).body;
  assert.equal(a.claims.length, 2);
  assert.throws(() => S.ctx.db.prepare("INSERT INTO claims(id,case_id,seq,text,origin,kind,created_at) VALUES ('bypass',?,99,'Third','analyst','statement',?)").run(id, new Date().toISOString()), new RegExp(CLAIM_LIMIT_MESSAGE));
  assert.equal((await ana.patch(`/api/claims/${a.claims[0].id}`, { text: 'An existing claim may be corrected.' })).status, 200);
  assert.equal((await ana.del(`/api/claims/${a.claims[1].id}`)).status, 200);
  assert.equal((await ana.post(`/api/cases/${id}/claims`, { text: 'Removal must not reopen a slot.' })).status, 409);
  const relogin = await login(S.base, 'ana');
  a = (await relogin.get(`/api/cases/${id}`)).body;
  assert.equal(a.claimCapacity.used, 2); assert.equal(a.claimCapacity.remaining, 0);
  assert.ok(S.ctx.db.prepare("SELECT 1 FROM audit_log WHERE entity_id=? AND action LIKE 'Claim creation rejected%'").get(id));
});

test('explicit splitting preserves identity, evidence links and history and cannot create a third claim', async () => {
  const id = await fresh();
  const cid = (await ana.post(`/api/cases/${id}/claims`, { text: 'The county built a library and the school enrolled new pupils.' })).body.id;
  await ana.post(`/api/cases/${id}/evidence`, { kind: 'observation', text: 'An original record.', reference: 'Public register', links: [{ claim_id: cid, stance: 'context' }] });
  const r = await ana.post(`/api/claims/${cid}/split`, { parts: ['The county built a library.', 'The school enrolled new pupils.'] });
  assert.equal(r.status, 200); assert.equal(r.body.ids[0], cid);
  assert.equal((await ana.post(`/api/claims/${cid}/split`, { parts: ['One more part.', 'Another part.'] })).status, 409);
  const a = (await ana.get(`/api/cases/${id}`)).body;
  assert.equal(a.claims.length, 2); assert.ok(a.evidence[0].links.some(l => l.claim_id === cid));
  assert.ok(a.versions.some(v => v.reason.includes('split')));
});

test('initial analysis retains extra candidates; reruns, OCR and reports do not add extra claims', async () => {
  const id = await fresh();
  await ana.post(`/api/cases/${id}/analyse?wait=1`);
  let a = (await ana.get(`/api/cases/${id}`)).body;
  assert.equal(a.claims.length, 2); assert.ok(a.claimCandidates.length > 2);
  const ids = a.claims.map(c => c.id);
  await ana.post(`/api/cases/${id}/analyse?wait=1`);
  assert.deepEqual((await ana.get(`/api/cases/${id}`)).body.claims.map(c => c.id), ids);
  const t = await task(id, 'report'); assert.equal(t.status, 202);
  assert.equal((await waitFor(async () => (await ana.get(`/api/tasks/${t.body.id}`)).body)).status, 'completed');
  const report = (await ana.get(`/api/cases/${id}/automatic-report.json`)).body;
  assert.ok(report.assessment.claims.length <= 2);
  assert.ok((await ana.get(`/api/cases/${id}/report.json`)).body.claims.length <= 2);
  a = (await ana.get(`/api/cases/${id}`)).body; assert.deepEqual(a.claims.map(c => c.id), ids);
});

test('persistent tasks return immediately, deduplicate, serialize by case and respect permissions', async () => {
  const id = await fresh(); let release, calls = 0;
  const gate = new Promise(r => release = r);
  S.ctx.tasks.register('collection', async () => { calls++; await gate; return { connectors: [] }; });
  const one = await task(id, 'collection'); assert.equal(one.status, 202);
  await waitFor(async () => (await ana.get(`/api/tasks/${one.body.id}`)).body, x => x.status === 'processing');
  const duplicates = await Promise.all(Array.from({ length: 5 }, () => task(id, 'collection')));
  assert.ok(duplicates.every(r => r.body.id === one.body.id)); assert.equal(calls, 1);
  assert.equal((await viewer.post(`/api/cases/${id}/tasks`, { kind: 'analysis' })).status, 403);
  assert.equal((await other.post(`/api/cases/${id}/tasks`, { kind: 'analysis' })).status, 403);
  assert.equal((await other.get(`/api/tasks/${one.body.id}`)).status, 403);
  assert.equal((await fetch(`${S.base}/api/tasks`)).status, 401);
  const second = await task(id, 'analysis'); assert.equal(second.body.status, 'pending');
  assert.equal((await ana.get('/api/tasks')).status, 200, 'other pages remain usable while collection waits');
  release();
  assert.equal((await waitFor(async () => (await ana.get(`/api/tasks/${one.body.id}`)).body)).status, 'completed');
  assert.equal((await waitFor(async () => (await ana.get(`/api/tasks/${second.body.id}`)).body)).status, 'completed');
  const updatedInput = await task(id, 'collection');
  await waitFor(async () => (await ana.get(`/api/tasks/${updatedInput.body.id}`)).body);
  assert.equal((await task(id, 'collection')).body.id, updatedInput.body.id, 'unchanged completed work is reused');
});

test('failed tasks retry the same record without duplicating claims; foreign claim references are rejected', async () => {
  const id = await fresh(); let fail = true;
  S.ctx.tasks.register('collection', async () => { if (fail) throw new Error('Injected collection failure'); return { connectors: [] }; });
  const started = await task(id, 'collection');
  assert.equal((await waitFor(async () => (await ana.get(`/api/tasks/${started.body.id}`)).body)).status, 'failed');
  fail = false;
  const retried = await ana.post(`/api/tasks/${started.body.id}/retry`); assert.equal(retried.body.id, started.body.id);
  const done = await waitFor(async () => (await ana.get(`/api/tasks/${started.body.id}`)).body);
  assert.equal(done.status, 'completed'); assert.equal(done.attempts, 2);
  const otherCase = await fresh(), foreign = (await ana.post(`/api/cases/${otherCase}/claims`, { text: 'A claim in another case.' })).body.id;
  assert.equal((await task(id, 'collection', { claim_ids: [foreign] })).status, 400);
});

test('migration preserves legacy claims and reports; explicit selection is required for new reports', async () => {
  const L = await startServer(), user = await login(L.base, 'ana');
  const id = (await user.post('/api/cases', { claim_text: 'An older case with several statements.' })).body.id;
  const db = L.ctx.db;
  const userId = db.prepare("SELECT id FROM users WHERE username='ana'").get().id;
  db.exec('DROP TRIGGER claims_case_limit_insert; DROP TRIGGER claims_case_limit_move;');
  for (let n = 1; n <= 3; n++) db.prepare("INSERT INTO claims(id,case_id,seq,text,origin,kind,created_by,created_at) VALUES (?,?,?,?,'analyst','statement',?,?)").run(`legacy-${n}`, id, n, `Legacy claim ${n}`, userId, new Date().toISOString());
  db.prepare("INSERT INTO evidence(id,case_id,kind,origin,status,text,reference,created_by,created_at) VALUES ('legacy-evidence',?,'observation','analyst','accepted','Preserve this evidence','Register',?,?)").run(id, userId, new Date().toISOString());
  db.prepare("INSERT INTO evidence_links(evidence_id,claim_id,stance) VALUES ('legacy-evidence','legacy-3','context')").run();
  // Reconstruct the schema immediately before the additive migration.
  db.exec('DROP TABLE case_tasks; DROP TABLE claim_candidates; DROP INDEX investigations_submission; ALTER TABLE investigations DROP COLUMN submission_key; PRAGMA user_version=23;');
  const historical = JSON.stringify({ claims: ['legacy-1', 'legacy-2', 'legacy-3'], note: 'Frozen approved report' });
  db.prepare("INSERT INTO reports(id,case_id,revision,json_snapshot,html_snapshot,sha256,approved_by,created_at) VALUES ('legacy-report',?,1,?,'<p>Frozen report</p>','legacy-snapshot-hash',?,?)").run(id, historical, userId, new Date().toISOString());
  const before = db.prepare('SELECT id,text FROM claims WHERE case_id=? ORDER BY id').all(id);
  L.ctx.tasks.close(); await L.close(); db.close();
  const R = await reopenServer(L.dataDir), signed = await login(R.base, 'ana');
  try {
    assert.deepEqual(R.ctx.db.prepare('SELECT id,text FROM claims WHERE case_id=? ORDER BY id').all(id), before);
    assert.equal((await signed.get(`/api/cases/${id}/report.json`)).status, 409);
    assert.equal((await signed.post(`/api/cases/${id}/claims/select`, { claim_ids: ['legacy-1', 'legacy-2'] })).status, 200);
    assert.equal(R.ctx.db.prepare('SELECT COUNT(*) n FROM claims WHERE case_id=?').get(id).n, 3);
    assert.equal(R.ctx.db.prepare("SELECT COUNT(*) n FROM evidence_links WHERE claim_id='legacy-3'").get().n, 1);
    assert.equal((await signed.get(`/api/cases/${id}/report.json`)).body.claims.length, 2);
    assert.equal((await signed.post(`/api/cases/${id}/claims`, { text: 'A fourth claim' })).status, 409);
    assert.equal(R.ctx.db.prepare("SELECT json_snapshot FROM reports WHERE id='legacy-report'").get().json_snapshot, historical);
    assert.ok(fs.readdirSync(L.dataDir).some(x => x.includes('.before-v24-')));
  } finally { R.ctx.tasks.close(); await R.close(); R.ctx.db.close(); }
});

test('processing tasks become retryable failures on restart; pending work resumes with original cases', async () => {
  const T = await startServer(), signed = await login(T.base, 'ana');
  const id = (await signed.post('/api/cases', { claim_text: 'A durable case survives the restart.' })).body.id;
  const uid = T.ctx.db.prepare("SELECT id FROM users WHERE username='ana'").get().id;
  const ins = T.ctx.db.prepare("INSERT INTO case_tasks(case_id,kind,dedupe_key,input_json,status,created_by,created_at) VALUES (?,'analysis',?,'{}',?,?,?)");
  const interrupted = Number(ins.run(id, 'interrupted-test', 'processing', uid, new Date().toISOString()).lastInsertRowid);
  const pending = Number(ins.run(id, 'pending-test', 'pending', uid, new Date().toISOString()).lastInsertRowid);
  T.ctx.tasks.close(); await T.close(); T.ctx.db.close();
  const R = await reopenServer(T.dataDir), u = await login(R.base, 'ana');
  try {
    assert.equal((await u.get(`/api/tasks/${interrupted}`)).body.status, 'failed');
    assert.equal((await waitFor(async () => (await u.get(`/api/tasks/${pending}`)).body)).status, 'completed');
    assert.equal((await u.post(`/api/tasks/${interrupted}/retry`)).body.id, interrupted);
    assert.equal((await waitFor(async () => (await u.get(`/api/tasks/${interrupted}`)).body)).status, 'completed');
    assert.ok((await u.get(`/api/cases/${id}`)).body.claims.length <= 2);
  } finally { R.ctx.tasks.close(); await R.close(); R.ctx.db.close(); }
});

test('duplicate investigation submissions reuse the record; retry after failure reuses the same case', async () => {
  const I = await startServer(), u = await login(I.base, 'ana');
  const aggregate = I.ctx.cases.aggregate; let injected = false;
  I.ctx.cases.aggregate = (...args) => { if (!injected) { injected = true; throw new Error('Injected failure after case creation'); } return aggregate(...args); };
  try {
    const text = 'The county built two new libraries for local residents.';
    const r = await u.post('/api/investigations', { text }); assert.equal(r.status, 202);
    const failed = await waitFor(async () => (await u.get(`/api/investigations/${r.body.id}`)).body, x => x.status === 'failed');
    assert.ok(failed.case_id);
    assert.equal((await u.post('/api/investigations', { text })).body.id, r.body.id);
    assert.equal((await u.post(`/api/investigations/${r.body.id}/retry`)).body.id, r.body.id);
    const done = await waitFor(async () => (await u.get(`/api/investigations/${r.body.id}`)).body);
    assert.equal(done.status, 'done'); assert.equal(done.case_id, failed.case_id);
    assert.equal(I.ctx.db.prepare('SELECT COUNT(*) n FROM cases').get().n, 1);
    assert.ok(I.ctx.cases.aggregate(failed.case_id).claims.length <= 2);
  } finally { await waitFor(async () => I.ctx.investigations.idle(), x => x); I.ctx.tasks.close(); await I.close(); I.ctx.db.close(); }
});

test('real collection handler marks total connector failure Failed and can retry the same task', async () => {
  const T = await startServer(), u = await login(T.base, 'ana');
  try {
    const id = (await u.post('/api/cases', { claim_text: 'A local claim needs evidence.' })).body.id;
    T.ctx.retrieval.retrieve = async () => ({ connectors: [{ key: 'web', configured: true, errors: ['HTTP 503'] }] });
    const started = (await u.post(`/api/cases/${id}/tasks`, { kind: 'collection' })).body;
    const failed = await waitFor(async () => (await u.get(`/api/tasks/${started.id}`)).body);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /Evidence collection failed/);
    T.ctx.retrieval.retrieve = async () => ({ connectors: [{ key: 'web', configured: true, results: 0, stored: 0, errors: [] }] });
    await u.post(`/api/tasks/${started.id}/retry`);
    assert.equal((await waitFor(async () => (await u.get(`/api/tasks/${started.id}`)).body)).status, 'completed');
  } finally { T.ctx.tasks.close(); await T.close(); T.ctx.db.close(); }
});

test('queued work rechecks the requesting account before it executes', async () => {
  const T = await startServer(), u = await login(T.base, 'ana'); let release;
  try {
    const id = (await u.post('/api/cases', { claim_text: 'A pending claim must not run for a disabled account.' })).body.id;
    const gate = new Promise(r => release = r);
    T.ctx.tasks.register('collection', async () => { await gate; return {}; });
    const first = (await u.post(`/api/cases/${id}/tasks`, { kind: 'collection' })).body;
    await waitFor(async () => (await u.get(`/api/tasks/${first.id}`)).body, x => x.status === 'processing');
    const second = (await u.post(`/api/cases/${id}/tasks`, { kind: 'analysis' })).body;
    T.ctx.db.prepare("UPDATE users SET active=0 WHERE username='ana'").run(); release();
    const failed = await waitFor(async () => T.ctx.db.prepare('SELECT status,error FROM case_tasks WHERE id=?').get(second.id));
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /no longer active/);
    assert.equal(T.ctx.db.prepare('SELECT COUNT(*) n FROM claims WHERE case_id=?').get(id).n, 0);
  } finally { release?.(); T.ctx.tasks.close(); await T.close(); T.ctx.db.close(); }
});

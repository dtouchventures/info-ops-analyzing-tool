import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, reopenServer, login } from './helpers.js';
import { buildAutomaticReport, automaticReportHtml } from '../server/lib/automatic-report.js';

let S, analyst, viewer, other;
before(async () => {
  S = await startServer({ ai: { provider: 'mock', apiKey: 'test', model: 'mock-1', baseUrl: '', timeoutMs: 5000, maxImages: 6 } });
  analyst = await login(S.base, 'ana'); viewer = await login(S.base, 'view'); other = await login(S.base, 'ana2');
});
after(async () => { await S.close(); S.ctx.db.close(); });
async function newCase(text = 'The county council opened three new public libraries in Nairobi yesterday.') {
  return (await analyst.post('/api/cases', { claim_text: text, title: 'Public claim', received_at: '2026-10-27T08:00:00Z' })).body.id;
}
async function finish(id) {
  for (let i = 0; i < 150; i++) {
    const saved = (await analyst.get(`/api/cases/${id}/automatic-report`)).body;
    if (saved?.status !== 'running') return saved;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('automatic report did not finish');
}
test('automatic report needs no comments, preserves original content and decisions, and discloses offline limits', async () => {
  const id = await newCase(), original = S.ctx.cases.mustCase(id).claim_text_original;
  assert.equal((await analyst.post(`/api/cases/${id}/automatic-report`, {})).status, 202);
  const saved = await finish(id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.report.assessment.value, 'insufficient');
  assert.match(saved.report.report_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(saved.report.limitations.some(l => l.includes('External evidence research')));
  assert.equal(saved.report.analysis.ai.status, 'not_requested');
  assert.equal(S.ctx.cases.mustCase(id).claim_text_original, original);
  assert.equal(S.ctx.cases.mustCase(id).conclusion, null);
  assert.equal((await analyst.get(`/api/cases/${id}/automatic-report.html`)).status, 200);
  assert.equal((await analyst.get(`/api/cases/${id}/automatic-report.json`)).body.schema, 'aivs-automatic-report/1');
});
test('report permissions, duplicate jobs, consent and validated AI runs', async () => {
  const id = await newCase();
  assert.equal((await viewer.post(`/api/cases/${id}/automatic-report`, {})).status, 403);
  assert.equal((await other.post(`/api/cases/${id}/automatic-report`, {})).status, 403);
  const user = { id: S.ctx.cases.mustCase(id).created_by, role: 'analyst', username: 'ana' };
  const run = S.ctx.automaticReports.start(user, id, { confirm_external: true });
  assert.throws(() => S.ctx.automaticReports.start(user, id, {}), e => e.status === 409);
  await run.job;
  const saved = await finish(id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.report.analysis.ai.status, 'completed');
  assert.equal(S.ctx.cases.aggregate(id).aiRuns.length, 2);
  assert.equal((await viewer.get(`/api/cases/${id}/automatic-report`)).status, 200);
});
test('suggestions and search snippets do not become confirmed findings; citations and untrusted text are escaped', async () => {
  const id = await newCase('<script>alert(1)</script> The council opened three libraries yesterday.');
  await S.ctx.cases.startAnalysis({ id: S.ctx.cases.mustCase(id).created_by, role: 'analyst', username: 'ana' }, id);
  const agg = S.ctx.cases.aggregate(id), claim = agg.claims[0];
  agg.evidence.push({ id: 'E-999998', status: 'suggested', source_url: 'https://example.org/review', source_title: '<img src=x onerror=alert(1)>', links: [{ claim_id: claim.id, stance: 'contradicts' }] });
  agg.evidence.push({ id: 'E-999999', status: 'suggested', source_url: 'javascript:alert(1)', links: [] });
  const report = buildAutomaticReport(agg, { generatedAt: '2026-10-27T09:00:00Z' });
  assert.equal(report.assessment.claims[0].value, 'insufficient');
  assert.equal(report.citations.length, 1);
  assert.equal(report.citations[0].verification.status, 'not_checked');
  assert.equal(buildAutomaticReport(agg, { generatedAt: '2026-10-27T23:00:00Z' }).report_date, '2026-10-28');
  const html = automaticReportHtml(report);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('&lt;script&gt;'));
  agg.evidence[0].status = 'accepted';
  assert.equal(buildAutomaticReport(agg).assessment.claims[0].value, 'contradicted');
});
test('only a matching archived published fact-check can contribute an automatic provisional rating', async () => {
  const id = await newCase();
  const user = { id: S.ctx.cases.mustCase(id).created_by, role: 'analyst', username: 'ana' };
  await S.ctx.cases.startAnalysis(user, id);
  const agg = S.ctx.cases.aggregate(id), cl = agg.claims[0];
  agg.evidence.push({ id: 'E-999997', claim_id: cl.id, connector: 'factcheck', rating: 'False', status: 'suggested', source_url: 'https://example.org/factcheck', links: [] });
  assert.equal(buildAutomaticReport(agg).assessment.claims[0].value, 'insufficient');
  const check = { evidence_id: 'E-999997', status: 'retrieved', matched_claim_ids: [cl.id] };
  const rated = buildAutomaticReport(agg, { checks: [check] });
  assert.equal(rated.assessment.claims[0].value, 'contradicted');
  assert.match(rated.assessment.claims[0].basis, /Provisional.*context/);
  assert.equal(agg.evidence.at(-1).status, 'suggested');
  assert.equal(buildAutomaticReport(agg, { checks: [{ ...check, status: 'failed' }] }).assessment.claims[0].value, 'insufficient');
});
test('external searches require consent, source failures are disclosed, and leads do not become verdicts', async () => {
  let calls = 0;
  const web = S.ctx.retrieval.connectors.web, run = web.run;
  web.configured = true;
  web.run = async () => { calls++; return [{ title: 'The county council opened three new public libraries in Nairobi yesterday.', url: 'http://127.0.0.1:9/review', publisher: 'Test source', snippet: 'Three libraries opened in Nairobi.' }]; };
  try {
    const id = await newCase();
    await analyst.post(`/api/cases/${id}/automatic-report`, {}); await finish(id);
    assert.equal(calls, 0);
    await analyst.post(`/api/cases/${id}/automatic-report`, { search_external: true });
    const saved = await finish(id);
    assert.equal(saved.status, 'completed'); assert.ok(calls > 0);
    assert.ok(saved.report.citations.some(c => c.verification.status === 'failed'));
    assert.equal(saved.report.assessment.value, 'insufficient');
    assert.ok(S.ctx.cases.aggregate(id).evidence.every(e => e.status !== 'accepted'));
  } finally { web.configured = false; web.run = run; }
});
test('generated reports survive restart and interrupted jobs are labelled without losing the prior report', async () => {
  const initial = await startServer();
  const user = initial.ctx.db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const id = initial.ctx.cases.create(user, { claim_text: 'The public library opened three new reading rooms yesterday.', received_at: '2026-10-27T08:00:00Z' });
  await initial.ctx.automaticReports.start(user, id).job;
  const report = initial.ctx.automaticReports.get(id).report;
  assert.ok(report);
  initial.ctx.db.prepare("UPDATE automatic_reports SET status='running', stage='evidence_research' WHERE case_id=?").run(id);
  await initial.close(); initial.ctx.db.close();
  const reopened = await reopenServer(initial.dataDir);
  try {
    const saved = reopened.ctx.automaticReports.get(id);
    assert.equal(saved.status, 'interrupted');
    assert.deepEqual(saved.report, report);
    assert.equal(reopened.ctx.cases.mustCase(id).claim_text_original, 'The public library opened three new reading rooms yesterday.');
  } finally { await reopened.close(); }
});

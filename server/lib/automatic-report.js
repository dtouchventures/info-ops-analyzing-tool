import { MAX_CASE_CLAIMS } from "../../shared/claim-limit.js";
// Public-content fact-checking reports. Automated output never changes reviewer decisions.
import { HttpError, can } from './auth.js';
import { nowISO } from './db.js';
import { fetchPage } from './fetchurl.js';
import { analyseContent } from './content-analysis.js';
import { extractClaims } from '../../shared/text.js';
import { ratingToVerdict } from '../../shared/verdict.js';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const http = value => { try { return /^https?:$/.test(new URL(value).protocol) ? value : null; } catch { return null; } };
const LABEL = { supported: 'Supported by recorded evidence', contradicted: 'Contradicted by recorded evidence', insufficient: 'Insufficient evidence', not_verifiable: 'Not verifiable', mixed: 'Mixed findings' };
const normal = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function buildAutomaticReport(agg, { generatedAt = nowISO(), timezone = 'Africa/Nairobi', checks = [], research = [], ai = { status: 'not_requested' }, warnings = [] } = {}) {
  const claims = agg.claims.filter(c => !c.removed);
  if (claims.length > MAX_CASE_CLAIMS) throw new HttpError(409, "Choose at most two claims for this older case before generating a new report.");
  const evidence = agg.evidence.filter(e => e.status !== 'dismissed');
  const citations = evidence.filter(e => http(e.source_url) || e.status === 'accepted').map(e => ({ id: e.id, url: http(e.source_url), title: e.source_title || e.reference || e.source_url || e.id,
    publisher: e.source_publisher, published_at: e.source_published_at, retrieved_at: e.retrieved_at, status: e.status,
    verification: checks.find(c => c.evidence_id === e.id) || { status: http(e.source_url) ? 'not_checked' : 'internal_record' } }));
  const assessment = claims.map(c => {
    const linked = evidence.filter(e => e.status === 'accepted' && e.links?.some(l => l.claim_id === c.id));
    const published = evidence.filter(e => e.status !== 'accepted' && ['factcheck', 'kb'].includes(e.connector) && e.claim_id === c.id &&
      ['supported', 'contradicted'].includes(ratingToVerdict(e.rating)) && checks.some(check => check.evidence_id === e.id && check.status === 'retrieved' && check.matched_claim_ids?.includes(c.id)));
    const stances = new Set(linked.flatMap(e => e.links.filter(l => l.claim_id === c.id).map(l => l.stance)));
    for (const review of published) stances.add(ratingToVerdict(review.rating) === 'supported' ? 'supports' : 'contradicts');
    // A search snippet, model answer or accessible page alone is never proof.
    let value = c.claim_type && c.claim_type !== 'factual' ? 'not_verifiable' : 'insufficient';
    if (value !== 'not_verifiable') {
      if (stances.has('supports') && stances.has('contradicts')) value = 'mixed';
      else if (stances.has('supports')) value = 'supported';
      else if (stances.has('contradicts')) value = 'contradicted';
    }
    return { claim_id: c.id, text: c.text, value, label: LABEL[value], evidence_ids: [...linked, ...published].map(e => e.id),
      basis: published.length ? 'Provisional synthesis of published fact-check ratings: the complete claim text appears on the archived source page. Check event, date and context before relying on it. This is not independent approval.'
        : linked.length ? 'Provisional synthesis of accepted evidence links; not independent approval.' : 'No accepted evidence or matching archived fact-check establishes this claim. Retrieved sources remain leads.' };
  });
  const values = [...new Set(assessment.map(a => a.value))];
  const overall = !values.length ? 'insufficient' : values.length === 1 ? values[0] : 'mixed';
  const content = analyseContent({ agg });
  const limitations = [...warnings, 'Source accessibility verifies retrieval, not the truth of the source or its relevance to a claim.',
    'Search coverage is incomplete. No result does not mean a claim is false.',
    'Falsity alone does not establish intent to deceive; disinformation and malinformation are not inferred automatically.'];
  if (!research.some(r => r.configured && !['kb', 'holdings'].includes(r.connector))) limitations.push('External evidence research was not performed or is not configured.');
  if (ai.status !== 'completed') limitations.push(`AI analysis: ${ai.status}. The report uses local checks and recorded evidence.`);
  const recommendations = [...new Set([
    ...(assessment.some(a => a.value === 'insufficient') ? ['Find an original or primary source and an independent corroborating source for unresolved claims.'] : []),
    ...(checks.some(c => c.status === 'failed') ? ['Retry inaccessible citations or obtain a public archived copy.'] : []),
    ...(agg.ocr.length ? ['Check OCR names, figures and dates against the original image or document.'] : []),
    'Read the cited sources before relying on the assessment; compare publication dates with the claimed event date.'
  ])];
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(generatedAt));
  const datePart = name => parts.find(p => p.type === name).value;
  return { schema: 'aivs-automatic-report/1', generated_at: generatedAt, report_date: `${datePart('year')}-${datePart('month')}-${datePart('day')}`, timezone,
    case_id: agg.case.id, case_version: agg.case.version, title: agg.case.title, status: 'Preliminary automated assessment',
    background: { text: agg.case.claim_text.slice(0, 1800), source_url: http(agg.case.source_url), received_at: agg.case.received_at,
      published_at: agg.case.published_at, claimed_event_at: agg.case.claimed_event_at },
    analysis: { claims: claims.length, topics: content.estimates.topics.items, red_flags: content.estimates.red_flags.items.slice(0, 5),
      media_files: agg.media.length, ocr_records: agg.ocr.length, research, ai },
    assessment: { value: overall, label: LABEL[overall], claims: assessment }, recommendations, citations, limitations };
}

export function automaticReportHtml(r) {
  const e = escape, list = rows => `<ul>${rows.map(s => `<li>${e(s)}</li>`).join('')}</ul>`;
  const claims = r.assessment.claims.slice(0, 6), cited = new Set(claims.flatMap(c => c.evidence_ids));
  const citations = [...r.citations.filter(c => cited.has(c.id)), ...r.citations.filter(c => !cited.has(c.id))].slice(0, 8);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${e(r.case_id)} · ${e(r.report_date)}</title>
  <style>body{font:15px/1.5 system-ui;max-width:850px;margin:32px auto;padding:0 24px;color:#172b3a}h1{font-size:24px}h2{font-size:19px;margin-top:26px}a{overflow-wrap:anywhere}li{margin-bottom:7px}small{color:#475569}@media print{body{margin:0}}</style>
  <h1>${e(r.title)}</h1><p>${e(r.case_id)} · ${e(r.report_date)} (${e(r.timezone)})<br><b>${e(r.status)}</b></p>
  <h2>Background</h2><p>${e(r.background.text.slice(0, 900))}</p><p>Received: ${e(r.background.received_at)}<br>Published: ${e(r.background.published_at || 'Unknown')}<br>Claimed event: ${e(r.background.claimed_event_at || 'Unknown')}</p>
  <h2>Analysis</h2><p>${r.analysis.claims} claims; ${r.analysis.media_files} files; ${r.analysis.ocr_records} OCR records. Topics: ${e(r.analysis.topics.join(', ') || 'None identified')}.</p>
  ${r.analysis.ai.summary ? `<p>${e(r.analysis.ai.summary.slice(0, 1000))}</p>` : ''}
  <h2>Assessment</h2><p><b>${e(r.assessment.label)}</b></p>${list(claims.map(c => `${c.text.slice(0, 500)} — ${c.label}. ${c.basis}${c.evidence_ids.length ? ` [${c.evidence_ids.join(', ')}]` : ''}`))}
  <h2>Recommendations</h2>${list(r.recommendations)}<h2>Citations</h2><ol>${citations.map(c => `<li id="${e(c.id)}">[${e(c.id)}] ${c.url ? `<a href="${e(c.url)}" rel="noreferrer noopener">${e(c.title)}</a>` : e(c.title)} — ${e(c.publisher || 'Publisher unknown')}; published ${e(c.published_at || 'unknown')}; retrieved ${e(c.retrieved_at || 'unknown')}; ${e(c.status)}; source check: ${e(c.verification.status)}.</li>`).join('') || '<li>No citations available.</li>'}</ol>
  ${r.assessment.claims.length > claims.length || r.citations.length > citations.length ? `<p>This concise view shows ${claims.length} of ${r.assessment.claims.length} claims and ${citations.length} of ${r.citations.length} citations. <a href="automatic-report.json">Download the complete report</a>.</p>` : ''}
  <h2>Limits and uncertainty</h2>${list(r.limitations)}<small>Generated ${e(r.generated_at)}. Analyst comments are optional. This report does not approve a case.</small></html>`;
}

export function makeAutomaticReports(db, { cases, retrieval, ai, storage, config, audit }) {
  db.exec(`CREATE TABLE IF NOT EXISTS automatic_reports (
    case_id TEXT PRIMARY KEY REFERENCES cases(id), status TEXT NOT NULL, stage TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, report_json TEXT, error TEXT
  )`);
  // An interrupted process must never leave a report claiming to still run.
  db.prepare("UPDATE automatic_reports SET status='interrupted', stage='interrupted', error='The server stopped. Run the automatic report again.' WHERE status='running'").run();
  const jobs = new Map();
  const get = id => { cases.mustCase(id); const r = db.prepare('SELECT * FROM automatic_reports WHERE case_id=?').get(id); return r ? { ...r, report: r.report_json ? JSON.parse(r.report_json) : null, report_json: undefined } : null; };
  const stage = (id, name) => db.prepare('UPDATE automatic_reports SET stage=? WHERE case_id=?').run(name, id);
  async function generate(user, id, opts) {
    const warnings = [], checks = []; let research = [], aiResult = { status: 'not_requested' };
    while (cases.isRunning(id)) await new Promise(resolve => setTimeout(resolve, 100));
    cases.requireEdit(user, cases.mustCase(id));
    stage(id, 'extraction');
    const extracted = cases.aggregate(id);
    cases.assertReportClaims(id);
    // Additional document/OCR statements are proposals, never extra case claims.
    for (const o of extracted.ocr) cases.proposeClaims(id, extractClaims(o.current_text, false), `ocr:${o.id}`);
    for (const m of extracted.media.filter(m => m.kind === 'document')) {
      const doc = db.prepare('SELECT text FROM document_texts WHERE media_id = ?').get(m.id);
      if (doc?.text) cases.proposeClaims(id, extractClaims(doc.text, false), `document:${m.id}`);
    }
    for (const m of extracted.media.filter(m => m.kind === 'image' && !extracted.ocr.some(o => o.media_id === m.id))) warnings.push(`No OCR text is recorded for ${m.original_name}. Read its text from the case's media tools.`);
    stage(id, 'local_analysis'); await cases.startAnalysis(user, id);
    if (cases.mustCase(id).status === 'analysis_failed') throw new Error('Local analysis failed. Retry after checking the uploaded files.');
    const runAI = async () => {
      const st = ai.status();
      if (!opts.confirm_external) return { status: 'not_requested' };
      if (!st.configured || !st.enabled) return { status: 'not_configured' };
      if (!can(user, 'ai.request')) return { status: 'not_permitted' };
      try {
        const run = await ai.request(user, id, { confirm_external: true, include_ocr: true, include_evidence: true, media_ids: [] }); await run.job;
        const saved = cases.aggregate(id).aiRuns.find(r => r.id === run.id);
        return { status: saved.status, run_id: run.id, summary: saved.status === 'completed' ? saved.response.summary_draft : null };
      } catch (e) { warnings.push('AI analysis was unavailable; local analysis was retained.'); return { status: 'failed' }; }
    };
    stage(id, 'ai_analysis'); aiResult = await runAI();
    stage(id, 'evidence_research');
    const use = retrieval.status().filter(s => !s.sends_to || opts.search_external).map(s => s.key);
    const found = await retrieval.retrieve(user, id, { use }, cases); research = found.connectors || found.report || [];
    stage(id, 'source_verification');
    const sources = cases.aggregate(id).evidence.filter(e => e.status !== 'dismissed' && http(e.source_url)).slice(0, 8);
    for (const source of sources) {
      try {
        const page = await fetchPage(source.source_url, { allowPrivate: false });
        const snapshot = await storage.putBuffer(page.raw, page.mime);
        checks.push({ evidence_id: source.id, status: 'retrieved', final_url: page.finalUrl, sha256: snapshot.sha256, checked_at: nowISO(),
          matched_claim_ids: cases.aggregate(id).claims.filter(cl => !cl.removed && normal(cl.text).length >= 40 && normal(page.text).includes(normal(cl.text))).map(cl => cl.id),
          note: 'Page retrieved and archived; truth and claim relevance are not established by availability.' });
      } catch { checks.push({ evidence_id: source.id, status: 'failed', checked_at: nowISO() }); }
    }
    if (sources.length === 8) warnings.push('Source retrieval is limited to the first eight cited pages per run.');
    stage(id, 'report');
    // AI synthesis can cite researched evidence, but cannot promote evidence or approve a verdict.
    if (opts.confirm_external && aiResult.status === 'completed') aiResult = await runAI();
    const report = buildAutomaticReport(cases.aggregate(id), { checks, research, ai: aiResult, warnings, timezone: config.reportTimezone || 'Africa/Nairobi' });
    db.prepare("UPDATE automatic_reports SET status='completed',stage='completed',finished_at=?,report_json=?,error=NULL WHERE case_id=?").run(nowISO(), JSON.stringify(report), id);
    audit(user, 'Automatic public-content report generated', 'case', id, { citations: report.citations.length, date: report.report_date });
  }
  function start(user, id, opts = {}) {
    cases.requireEdit(user, cases.mustCase(id), { states: new Set(['draft','analysing','analysis_failed','analyst_review','needs_evidence']) });
    if (jobs.has(id)) throw new HttpError(409, 'An automatic report is already running.');
    db.prepare(`INSERT INTO automatic_reports(case_id,status,stage,started_at) VALUES (?,'running','queued',?)
      ON CONFLICT(case_id) DO UPDATE SET status='running',stage='queued',started_at=excluded.started_at,finished_at=NULL,error=NULL`).run(id, nowISO());
    const job = Promise.resolve().then(() => generate(user, id, opts)).catch(() => {
      db.prepare("UPDATE automatic_reports SET status='failed',stage='failed',finished_at=?,error='The automatic report could not finish. Existing records were retained; retry or use the regular case tools.' WHERE case_id=?").run(nowISO(), id);
    }).finally(() => jobs.delete(id));
    jobs.set(id, job); return { job };
  }
  return { start, get };
}

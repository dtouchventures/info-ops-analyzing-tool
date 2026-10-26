// Phase 2 (AIVS 1.4): six verdicts, evidence strength, evidence retrieval with citations (against local test
// doubles of the Google Fact Check Tools and Brave Search APIs), suggested verdicts, source checks, red flags,
// review outcomes, related cases, and PDF/CSV exports.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, login } from "./helpers.js";
import { expectedConclusion, evidenceStrength, ratingToVerdict } from "../shared/verdict.js";

let fc, brave, site, S, N, ana, rev, view, anaN, calls = { fc: 0, brave: 0 };
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
before(async () => {
  fc = http.createServer((req, res) => {
    calls.fc++; const u = new URL(req.url, "http://x");
    if (u.searchParams.get("key") !== "fc-test-key") return json(res, { error: { message: "API key not valid" } }, 400);
    const q = u.searchParams.get("query") || "";
    if (/lemon/i.test(q)) return json(res, { claims: [{ text: "Hot lemon water cures malaria", claimant: "Social media posts", claimReview: [
      { publisher: { name: "Africa Check", site: "africacheck.org" }, url: "https://africacheck.org/fact-checks/reports/lemon-water-malaria", title: "No, lemon water does not cure malaria", reviewDate: "2024-03-02T00:00:00Z", textualRating: "False", languageCode: "en" },
      { publisher: { name: "PesaCheck" }, url: "https://pesacheck.org/lemon-malaria-false", title: "FALSE: Lemon water is not a malaria cure", reviewDate: "2024-03-05T00:00:00Z", textualRating: "FALSE", languageCode: "en" }] },
      { text: "Football results unrelated", claimReview: [{ publisher: { name: "Other" }, url: "https://example.org/unrelated", title: "Football score", textualRating: "True" }] },
      { text: "Bad link", claimReview: [{ publisher: { name: "X" }, url: "javascript:alert(1)", title: "x", textualRating: "False" }] }] });
    return json(res, {});
  });
  brave = http.createServer((req, res) => {
    calls.brave++;
    if (req.headers["x-subscription-token"] !== "brave-test-key") return json(res, { error: { message: "bad token" } }, 401);
    const q = new URL(req.url, "http://x").searchParams.get("q") || "";
    if (/lemon/i.test(q)) return json(res, { web: { results: [{ title: "Malaria treatment guidelines", url: "https://health.go.ke/malaria-guidelines", description: "Ministry of Health guidance on <b>malaria</b> treatment and lemon remedies", profile: { name: "Ministry of Health" } }] } });
    return json(res, { web: { results: [] } });
  });
  site = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<html><head><title>Rally speech</title></head><body><article><p>${"Long introduction about the event. ".repeat(10)}</p><p>The governor told the rally: we will close some schools next week because of floods.</p></article></body></html>`); });
  for (const s of [fc, brave, site]) await new Promise(ok => s.listen(0, "127.0.0.1", ok));
  const base = s => `http://127.0.0.1:${s.address().port}`;
  S = await startServer({ allowPrivateFetch: true, search: { factcheckKey: "fc-test-key", factcheckBase: base(fc), braveKey: "brave-test-key", braveBase: base(brave), braveUsdPerRequest: 0.005, timeoutMs: 3000 } });
  N = await startServer();                                    // no search services configured
  [ana, rev, view] = await Promise.all(["ana", "rev", "view"].map(u => login(S.base, u)));
  anaN = await login(N.base, "ana");
  site.url = base(site);
});
after(async () => { await S.close(); await N.close(); for (const s of [fc, brave, site]) s.close(); });

test("six verdicts: the overall conclusion follows from claim verdicts", () => {
  const e = (...a) => expectedConclusion(a.map(x => ({ assessment: x })));
  assert.equal(e("supported", "supported"), "supported");
  assert.equal(e("supported", "contradicted"), "mixed");
  assert.equal(e("partially_supported", "contradicted"), "mixed");
  assert.equal(e("contradicted", "insufficient"), "contradicted");
  assert.equal(e("misleading_context", "supported"), "misleading_context");
  assert.equal(e("supported", "insufficient"), "partially_supported");
  assert.equal(e("insufficient", "not_verifiable"), "insufficient");
  assert.equal(e("not_verifiable", "not_verifiable"), "not_verifiable");
  assert.equal(e("supported", "unassessed"), null);
  assert.equal(ratingToVerdict("Mostly false"), "contradicted"); assert.equal(ratingToVerdict("Missing context"), "misleading_context"); assert.equal(ratingToVerdict("Not true"), "contradicted");
  assert.equal(ratingToVerdict("4 Pinocchios"), null, "unknown scales are not guessed");
});

test("evidence strength counts independent accepted sources, never a probability", () => {
  const link = s => [{ claim_id: "C", stance: s }];
  const ev = [{ id: "1", status: "accepted", kind: "source_claim", source_url: "https://knbs.or.ke/a", links: link("supports") },
    { id: "2", status: "accepted", kind: "source_claim", source_url: "https://knbs.or.ke/b", links: link("supports") },
    { id: "3", status: "suggested", kind: "observation", links: link("supports") }];
  const s = evidenceStrength({ id: "C" }, ev);
  assert.equal(s.independent, 1, "two links to the same site are one source"); assert.equal(s.level, "weak");
  ev.push({ id: "4", status: "accepted", kind: "observation", reference: "Site visit by analyst", links: link("supports") }, { id: "5", status: "accepted", kind: "source_claim", source_url: "https://nation.africa/x", links: link("supports") });
  assert.equal(evidenceStrength({ id: "C" }, ev).level, "strong");
  ev.push({ id: "6", status: "accepted", kind: "source_claim", source_url: "https://other.org/x", links: link("contradicts") });
  const s2 = evidenceStrength({ id: "C" }, ev); assert.equal(s2.level, "moderate", "conflict lowers strength"); assert.ok(s2.reasons.some(r => /conflicts/.test(r)));
  assert.equal(typeof s2.score, "number"); assert.ok(!JSON.stringify(s2).includes("%"));
});

let caseId;
test("verify + search: real fact-checks and web results become cited suggestions; nothing invented", async () => {
  const r = await ana.post("/api/verify", { input: "BREAKING: Drinking hot lemon water every hour cures malaria, doctors confirm. Share before they delete this!", search: true });
  assert.equal(r.status, 201, JSON.stringify(r.body)); caseId = r.body.id;
  const fcRow = r.body.search.connectors.find(c => c.connector === "factcheck"), webRow = r.body.search.connectors.find(c => c.connector === "web");
  assert.equal(fcRow.status, "ok"); assert.equal(webRow.status, "ok");
  assert.ok(r.body.search.skipped.some(s => /call to action/.test(s.reason)), "calls to action are not searched");
  const agg = (await ana.get(`/api/cases/${caseId}`)).body, ret = agg.evidence.filter(e => e.origin === "retrieval");
  const urls = ret.map(e => e.source_url).sort();
  assert.deepEqual(urls.filter(u => u.includes("lemon") || u.includes("malaria")).sort(), ["https://africacheck.org/fact-checks/reports/lemon-water-malaria", "https://health.go.ke/malaria-guidelines", "https://pesacheck.org/lemon-malaria-false"].sort(),
    "citations are exactly the URLs the services returned");
  assert.ok(!urls.some(u => /unrelated|javascript/.test(u)), "unrelated results and non-http links are dropped");
  const africa = ret.find(e => e.source_publisher === "Africa Check");
  assert.equal(africa.rating, "False"); assert.equal(africa.status, "suggested"); assert.equal(africa.kind, "source_claim");
  assert.deepEqual(africa.suggested_links.map(l => l.stance), ["contradicts"]);
  const claim = agg.claims.find(c => /lemon/i.test(c.text));
  assert.equal(claim.suggested_assessment, "contradicted"); assert.match(claim.suggested_basis, /Africa Check rated it “False”/);
  assert.equal(claim.assessment, "unassessed", "suggestions never apply themselves");
  assert.ok(agg.evidence.some(e => e.sys_key === "flag:cure"), "regional red flag raised");
  assert.ok(agg.evidence.some(e => e.sys_key === "flag:urgency"));
  assert.equal(agg.case.topic, "health");
  const usage = S.ctx.db.prepare("SELECT service, est_cost_usd FROM api_usage").all();
  assert.ok(usage.some(u => u.service === "web" && u.est_cost_usd === 0.005) && usage.some(u => u.service === "factcheck" && u.est_cost_usd === 0), "usage and cost recorded");
  assert.ok(agg.retrievals.length >= 2);
});

test("without search keys the services say they are not configured and nothing is stored from them", async () => {
  const st = (await anaN.get("/api/search-services")).body.services;
  assert.equal(st.find(s => s.key === "factcheck").configured, false); assert.match(st.find(s => s.key === "factcheck").needs, /GOOGLE_FACTCHECK_API_KEY/);
  const r = await anaN.post("/api/verify", { input: "Drinking hot lemon water every hour cures malaria in Kisumu.", search: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.search.connectors.find(c => c.connector === "factcheck").status, "not_configured");
  const agg = (await anaN.get(`/api/cases/${r.body.id}`)).body;
  assert.equal(agg.evidence.filter(e => e.origin === "retrieval" && ["factcheck", "web", "official"].includes(e.connector)).length, 0);
});

test("a failing service is reported, not hidden; the key never reaches the browser", async () => {
  const B = await startServer({ search: { factcheckKey: "wrong-key", factcheckBase: `http://127.0.0.1:${fc.address().port}`, timeoutMs: 3000 } });
  try {
    const u = await login(B.base, "ana");
    const r = await u.post("/api/verify", { input: "Drinking hot lemon water cures malaria in Kisumu clinics.", search: true });
    const row = r.body.search.connectors.find(c => c.connector === "factcheck");
    assert.equal(row.status, "error"); assert.match(row.errors[0], /HTTP 400: API key not valid/);
    const all = JSON.stringify([(await u.get("/api/meta")).body, (await u.get("/api/search-services")).body, (await u.get(`/api/cases/${r.body.id}`)).body]);
    assert.ok(!all.includes("wrong-key") && !all.includes("fc-test-key"), "keys never appear in responses");
  } finally { await B.close(); }
});

test("accepting a cited suggestion, adopting a suggested verdict, and strength", async () => {
  let agg = (await ana.get(`/api/cases/${caseId}`)).body;
  const claim = agg.claims.find(c => /lemon/i.test(c.text));
  for (const e of agg.evidence.filter(x => x.status === "suggested")) await ana.patch(`/api/evidence/${e.id}`, e.connector === "factcheck" ? { status: "accepted", links: e.suggested_links } : { status: "dismissed" });
  assert.equal((await ana.patch(`/api/evidence/${agg.evidence.find(e => e.connector === "factcheck").id}`, { text: "rewritten" })).status, 400, "retrieved wording is locked");
  assert.equal((await ana.post(`/api/claims/${claim.id}/apply-suggestion`, {})).status, 200);
  agg = (await ana.get(`/api/cases/${caseId}`)).body;
  const c2 = agg.claims.find(c => c.id === claim.id);
  assert.equal(c2.assessment, "contradicted"); assert.match(c2.rationale, /Adopted AIVS suggestion after review/);
  assert.equal(c2.strength.independent, 2); assert.equal(c2.strength.level, "moderate");
  assert.ok(agg.versions.some(v => /assessed as contradicted/.test(v.reason)), "change is versioned and attributed");
});

test("review outcomes: needs additional evidence, rejected, reopened; reviewer identity recorded", async () => {
  let agg = (await ana.get(`/api/cases/${caseId}`)).body;
  for (const c of agg.claims.filter(c => !c.removed && c.assessment === "unassessed")) await ana.patch(`/api/claims/${c.id}`, { assessment: c.claim_type === "factual" ? "insufficient" : "not_verifiable", rationale: "Not checkable or no source." });
  agg = (await ana.get(`/api/cases/${caseId}`)).body;
  const exp = (await ana.get(`/api/cases/${caseId}/readiness`)).body.expected;
  await ana.patch(`/api/cases/${caseId}`, { conclusion: exp, conclusion_rationale: "Two fact-checkers rated the cure claim false.", uncertainties: "Origin of the post unknown." });
  assert.equal((await ana.post(`/api/cases/${caseId}/submit`, {})).status, 200, JSON.stringify((await ana.get(`/api/cases/${caseId}/readiness`)).body));
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "return", comment: "Add the Ministry of Health guidance." })).status, 200);
  agg = (await ana.get(`/api/cases/${caseId}`)).body; assert.equal(agg.case.status, "needs_evidence"); assert.equal(agg.case.status_label, "Needs additional evidence");
  assert.ok((await ana.get("/api/dashboard?training=0")).body.returned.some(x => x.id === caseId));
  assert.equal((await ana.post(`/api/cases/${caseId}/submit`, {})).status, 200, "resubmitted from needs_evidence");
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "reject" })).status, 400, "rejection needs a reason");
  assert.equal((await view.post(`/api/cases/${caseId}/decision`, { decision: "reject", comment: "x" })).status, 403);
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "reject", comment: "Conclusion overstates the evidence." })).status, 200);
  agg = (await ana.get(`/api/cases/${caseId}`)).body; assert.equal(agg.case.status, "rejected"); assert.equal(agg.case.decider.username, "rev"); assert.equal(agg.reports.length, 0, "no report is frozen for a rejection");
  assert.equal((await ana.patch(`/api/cases/${caseId}`, { title: "x" })).status, 409, "rejected cases are locked");
  assert.equal((await ana.post(`/api/cases/${caseId}/revise`, { reason: "Reworking after rejection" })).status, 200);
  agg = (await ana.get(`/api/cases/${caseId}`)).body; assert.equal(agg.case.status, "analyst_review"); assert.equal(agg.case.revision, 2);
});

test("checking a cited source archives it and tests quotations", async () => {
  const r = await ana.post("/api/cases", { claim_text: `The governor said “we will close all schools tomorrow because of floods” at the rally. ${site.url}/speech` });
  const id = r.body.id; await ana.post(`/api/cases/${id}/analyse?wait=1`, {});
  const e = await ana.post(`/api/cases/${id}/evidence`, { kind: "source_claim", text: "Speech transcript on the county website.", reference: `${site.url}/speech` });
  const chk = await ana.post(`/api/evidence/${e.body.id}/check-source`, {});
  assert.equal(chk.status, 200, JSON.stringify(chk.body)); assert.match(chk.body.sha256, /^[0-9a-f]{64}$/);
  assert.equal(chk.body.quotes.length, 1); assert.equal(chk.body.quotes[0].found, false, "the exact words differ from the source");
  assert.ok(chk.body.quotes[0].partial > 0.5, "but most words appear: possibly altered quote");
  const agg = (await ana.get(`/api/cases/${id}`)).body;
  assert.ok(agg.evidence.find(x => x.id === e.body.id).snapshot_sha256);
  assert.ok(agg.evidence.some(x => x.sys_key === "flag:quote"), "attributed quotation flagged");
  const snap = await fetch(S.base + `/api/evidence/${e.body.id}/snapshot`, { headers: { cookie: ana.cookie } });
  assert.equal(snap.status, 200); assert.match(snap.headers.get("content-security-policy"), /sandbox/);
});

test("related cases link both ways and stay within scope", async () => {
  const a = (await ana.post("/api/cases", { claim_text: "Claim A about Nakuru floods yesterday." })).body.id, b = (await ana.post("/api/cases", { claim_text: "Claim B about Nakuru floods today." })).body.id;
  assert.equal((await ana.post(`/api/cases/${a}/links`, { related_id: b, relation: "same_claim", note: "Same image" })).status, 201);
  assert.equal((await ana.get(`/api/cases/${b}`)).body.related[0].id, a);
  assert.equal((await ana.post(`/api/cases/${a}/links`, { related_id: a })).status, 400);
  const t = (await ana.post("/api/cases", { claim_text: "Training claim", is_training: true })).body.id;
  assert.equal((await ana.post(`/api/cases/${a}/links`, { related_id: t })).status, 400);
  assert.equal((await ana.del(`/api/cases/${a}/links/${b}`)).status, 200);
  assert.equal((await ana.get(`/api/cases/${b}`)).body.related.length, 0);
});

test("reports export as PDF and CSV from stored data; approved PDF carries the frozen fingerprint", async () => {
  const r = await ana.post("/api/verify", { input: "The Kenya National Bureau of Statistics reported inflation of 4.5% in September 2026." });
  const id = r.body.id;
  const ev = await ana.post(`/api/cases/${id}/evidence`, { kind: "source_claim", text: "KNBS CPI release shows 4.5% for September 2026.", reference: "https://knbs.or.ke/cpi-september-2026" });
  let agg = (await ana.get(`/api/cases/${id}`)).body;
  for (const e of agg.evidence.filter(x => x.status === "suggested")) await ana.patch(`/api/evidence/${e.id}`, { status: "dismissed" });
  for (const c of agg.claims.filter(c => !c.removed)) {
    if (c.claim_type === "factual" && c.kind === "statement") { await ana.patch(`/api/evidence/${ev.body.id}`, { links: [{ claim_id: c.id, stance: "supports" }] }); await ana.patch(`/api/claims/${c.id}`, { assessment: "supported", rationale: "Matches the KNBS release." }); }
    else await ana.patch(`/api/claims/${c.id}`, { assessment: "insufficient", rationale: "Not established." });
  }
  const exp = (await ana.get(`/api/cases/${id}/readiness`)).body.expected;
  await ana.patch(`/api/cases/${id}`, { conclusion: exp, conclusion_rationale: "The figure matches the official release.", uncertainties: "None identified." });
  const draftPdf = await fetch(S.base + `/api/cases/${id}/report.pdf`, { headers: { cookie: ana.cookie } }), dbuf = Buffer.from(await draftPdf.arrayBuffer());
  assert.equal(draftPdf.status, 200); assert.equal(dbuf.slice(0, 5).toString(), "%PDF-"); assert.match(draftPdf.headers.get("content-disposition"), /draft\.pdf/);
  assert.equal((await ana.post(`/api/cases/${id}/submit`, {})).status, 200);
  assert.equal((await rev.post(`/api/cases/${id}/decision`, { decision: "approve" })).status, 200);
  agg = (await rev.get(`/api/cases/${id}`)).body; const rid = agg.reports[0].id;
  const pdf = await fetch(S.base + `/api/reports/${rid}.pdf`, { headers: { cookie: rev.cookie } }), buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdf.status, 200); assert.equal(buf.slice(0, 5).toString(), "%PDF-"); assert.ok(buf.length > 3000);
  assert.ok(buf.includes(Buffer.from("/URI (https://knbs.or.ke/cpi-september-2026)")), "citation is a clickable link in the PDF");
  const csv = await (await fetch(S.base + `/api/reports/${rid}.csv`, { headers: { cookie: rev.cookie } })).text();
  assert.match(csv, /"claim","C-\d{4}-\d{4}"/); assert.match(csv, /knbs\.or\.ke\/cpi-september-2026/); assert.match(csv, /approved by REV/);
  const j = JSON.parse(await (await fetch(S.base + `/api/reports/${rid}.json`, { headers: { cookie: rev.cookie } })).text());
  assert.ok(j.methodology.length >= 3 && j.limitations.length >= 2); assert.equal(j.review.approved, true); assert.equal(j.review.decided_by, "REV");
  assert.equal(j.claims.find(c => c.assessment === "supported").evidence_strength.label, "Weak", "one source gives weak strength, honestly");
});

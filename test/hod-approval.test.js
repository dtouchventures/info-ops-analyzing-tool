// KDF Information Operations reporting and Head of Department approval (1.32), on the KDF recruitment case, against local TEST
// DOUBLES of Google Fact Check Tools, a fact-checker's article page and the organisation's Ollama server. Every item below is a
// labelled TEST FIXTURE. Real sources and the real Ollama server are checked on a connected computer with npm run check:verify-url.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, login } from "./helpers.js";
import { hashPassword } from "../server/lib/auth.js";
import { nowISO } from "../server/lib/db.js";
import { extractDocument } from "../server/lib/docs.js";

let F, fake, S, ana, ana2, hod, hod2, admin, rev, invId, inv2Id;
const AI = { recs: "valid", calls: [] };
const TEXT = "TEST FIXTURE: KDF recruitment is open. Applicants must pay KSh 2,000 to register through WhatsApp before Friday. The Kenya Defence Forces is a respected institution. KDF recruitment is open now. Share this with every young person you know.";
before(async () => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), j = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/v1alpha1/claims:search") { const q = u.searchParams.get("query") || "";
      return j(200, { claims: /recruit|ksh|pay|whatsapp/i.test(q) ? [{ text: "KDF recruits must pay a registration fee through WhatsApp", claimant: "Facebook posts", claimReview: [{ publisher: { name: "PesaCheck" }, url: `${F}/factcheck/kdf-fee`, title: "TEST FIXTURE: No, KDF does not charge recruitment fees", reviewDate: "2026-10-21T08:00:00Z", textualRating: "False", languageCode: "en" }] }] : [] }); }
    if (u.pathname === "/factcheck/kdf-fee") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><head><title>TEST FIXTURE: No, KDF does not charge recruitment fees</title><meta property="article:published_time" content="2026-10-21T08:00:00Z"></head><body><article><p>TEST FIXTURE ARTICLE. Posts claim that applicants must pay KSh 2,000 to register through WhatsApp for KDF recruitment.</p><p>The Kenya Defence Forces said recruitment is free of charge and applicants must never pay any fee to register; registration is not done through WhatsApp.</p></article></body></html>`); }
    if (u.pathname === "/api/tags") return j(200, { models: [{ name: "qwen3:4b-instruct" }] });
    if (u.pathname === "/api/show") return j(200, { capabilities: ["completion"] });
    if (u.pathname === "/api/chat") { let b = ""; req.on("data", d => (b += d)); req.on("end", () => {
      const p = JSON.parse(b).messages.at(-1).content, say = o => j(200, { model: "qwen3:4b-instruct", message: { content: typeof o === "string" ? o : JSON.stringify(o) } });
      if (/single word OK/.test(p)) return say("OK");
      if (/why the stated verdict follows/.test(p)) { AI.calls.push("explain"); const ns = [...p.matchAll(/"n":(\d+)/g)].map(m => +m[1]);
        return say({ claims: [{ n: ns[0], explanation: "The accepted fact-check and its article both describe recruitment as free of charge, the opposite of what the post states." }, ...(ns[1] ? [{ n: ns[1], explanation: "This claim is false, see https://example.invalid/proof" }] : [])],
          conclusion: "The principal claim is contradicted by accepted evidence, while what remains uncertain is stated separately." }); }
      if (/PRINCIPAL claims/.test(p)) { AI.calls.push("rank"); const lines = p.split("\n").filter(l => /^\d+\. /.test(l)); const pick = lines.filter(l => /KSh|WhatsApp/.test(l)).map(l => +l.split(".")[0]); return say({ principal: pick.slice(0, 3), reason: "fixture" }); }
      if (/KDF \(Kenya Defence Forces\) Information Operations Assessment/.test(p)) { AI.calls.push("draft");
        return say({ background: "A Facebook post claims that KDF recruitment is open and that applicants must pay KSh 2,000 to register through WhatsApp. The content is significant to KDF because recruitment fraud targets young applicants and could damage confidence in official recruitment.",
          analysis: "Claim 1 on the registration fee is False: PesaCheck rates it False and the article states that recruitment is free of charge [1]. Claim 2 on registration through WhatsApp is contradicted by the same source, which states that registration is not done through WhatsApp [1]. No supporting source was found. The origin and date of the post could not be established.",
          assessment: "Available evidence establishes that the principal claim is False. The content meets the description of misinformation; the evidence does not establish intent to deceive, so it cannot be classified as disinformation. If repeated, it could expose applicants to fraud and erode confidence in KDF's official recruitment communication. No amplification data indicates coordinated activity. Significance is high and confidence is high; the main limitation is that the origin of the post is unknown.",
          recommendations: AI.recs === "valid" ? ["There is a need to issue a timely public clarification through authorised KDF channels that recruitment is free of charge.", "There is a need to raise public awareness of fraudulent recruitment narratives that request payment.", "There is a need to monitor related recruitment narratives through the AIVS watchlist for renewed circulation.", "There is a need to preserve the evidence collected and escalate the matter for authorised review."]
            : ["Check the KDF website to confirm the recruitment dates.", "Search for evidence on other platforms.", "Verify the information manually."] }); }
      if (/narratives: up to 3/.test(p)) return say({ language: "en", narratives: ["A paid recruitment shortcut is offered"], sentiment: { label: "neutral", towards: "KDF recruitment" }, misleading: [{ quote: "Applicants must pay KSh 2,000", why: "a fee claim without an official source" }], entities: { people: [], organisations: ["KDF"], places: [], dates: [] }, gaps: ["No official notice is cited."] });
      return say("{}"); }); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ allowPrivateFetch: true, search: { factcheckKey: "fc-key", factcheckBase: F, gdelt: false, wikipedia: false, timeoutMs: 3000 },
    ai: { provider: "ollama", model: "qwen3:4b-instruct", baseUrl: F, apiKey: "", timeoutMs: 8000, healthTimeoutMs: 4000, maxImages: 6 } });
  for (const [u, d] of [["hod", "Head of Department, Information Operations"], ["hod2", "Deputy Head of Department"]])
    S.ctx.db.prepare("INSERT INTO users(username,display_name,role,designation,password_hash,created_at) VALUES (?,?,?,?,?,?)").run(u, u.toUpperCase(), "hod", d, hashPassword("correct-horse-42"), nowISO());
  [ana, ana2, hod, hod2, admin, rev] = await Promise.all(["ana", "ana2", "hod", "hod2", "admin", "rev"].map(u => login(S.base, u)));
});
after(async () => { await S.ctx.investigations.close(); await S.close(); fake.close(); });

async function investigate(client, text) {
  const fd = new FormData(); fd.append("text", text);
  const r = await client.post("/api/investigations", undefined, { form: fd }); assert.equal(r.status, 202, JSON.stringify(r.body));
  for (let i = 0; i < 600; i++) { const g = await client.get(`/api/investigations/${r.body.id}`); if (["done", "failed"].includes(g.body.status)) return g.body; await new Promise(ok => setTimeout(ok, 100)); }
  throw new Error("investigation did not finish");
}
const pdfText = async (client, url) => { const f = await fetch(`${S.base}${url}`, { headers: { cookie: client.cookie } }), buf = Buffer.from(await f.arrayBuffer()); return { buf, text: (await extractDocument(buf, "r.pdf")).text.replace(/\s+/g, " "), pages: (buf.toString("latin1").match(/\/Type \/Page\b/g) || []).length }; };

test("KDF recruitment case: at most two principal claims, automatic evidence with the source read in full, False with a fact-check, AI used, KDF IO assessment, four sections, one page", async () => {
  const inv = await investigate(ana, TEXT), r = inv.result; invId = inv.id;
  assert.equal(inv.status, "done", inv.error);
  assert.ok(r.claims.length >= 1 && r.claims.length <= 2, `principal claims: ${r.claims.map(c => c.text)}`); assert.equal(r.principal_by, "case records");
  assert.ok(r.claims.some(c => /KSh 2,000/.test(c.text))); assert.equal(r.other_claims.length, 0, "reports contain only the saved case claims"); assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM claim_candidates WHERE case_id=?").get(inv.case_id).n > 2, "additional statements are retained as review candidates"); assert.ok(!r.claims.some(c => /respected institution/.test(c.text)), "background is not a principal claim");
  assert.equal(inv.stages.find(s => s.key === "search").status, "done"); assert.ok(r.search.some(s => s.key === "factcheck" && s.status === "ok"), "evidence searched automatically");
  const fc = r.evidence.find(e => e.connector === "factcheck"); assert.ok(fc.page_read, "the fact-check article itself was read"); assert.match(fc.passage, /pay KSh 2,000|free of charge/);
  assert.equal(r.overall.verdict, "contradicted"); assert.equal(r.ai.used, true);
  const a = (await ana.get(`/api/investigations/${inv.id}/report.json`)).body;
  if (process.env.DUMP) { const rb = await import("../server/lib/ioassessment.js"); console.log("RULES", JSON.stringify(rb.buildAssessment(r), null, 1)); console.log("FINAL", JSON.stringify(a, null, 1)); }
  assert.equal(a.verdict_label, "False"); assert.equal(a.written_by, "ai"); assert.ok(AI.calls.includes("draft"));
  assert.match(a.assessment, /misinformation/); assert.match(a.assessment, /KDF/); assert.doesNotMatch(a.assessment, /\bis disinformation\b|hostile|coordinated campaign/i);
  assert.ok(a.recommendations.length >= 3 && a.recommendations.length <= 5 && a.recommendations.every(x => x.startsWith("There is a need to ")));
  assert.ok(a.claims.length <= 2 && a.claims[0].contradicting.length, "the claim's contradicting evidence is cited");
  const html = (await ana.get(`/api/investigations/${inv.id}/report.html`)).body; for (const h of ["1. PURPOSE","2. BACKGROUND","3. ANALYSIS","5. ASSESSMENT","6. RECOMMENDATIONS","7. CONCLUSION"]) assert.ok(html.includes(h)); assert.match(html, /DRAFT — NOT APPROVED/); assert.doesNotMatch(html, /APPROVED BY HEAD OF DEPARTMENT/);
  const p = await pdfText(ana, `/api/investigations/${inv.id}/report.pdf`); assert.equal(p.pages, 1, "one A4 page"); assert.match(p.text, /DRAFT [-—] NOT APPROVED/);
  for (const h of ["PURPOSE", "BACKGROUND", "ANALYSIS", "ASSESSMENT", "RECOMMENDATIONS", "CONCLUSION"]) assert.ok(p.text.includes(h), h);
  assert.ok(!/KEY REFERENCES|LIMITATIONS|REPORT STATUS|METHODOLOGY/.test(p.text), "no extra body sections");
});

test("AI recommendations that ask for manual verification are refused; the rule-based ones are used; an unsupported claim is not declared true", async () => {
  AI.recs = "invalid";
  const inv = await investigate(ana2, "TEST FIXTURE: A new steel bridge across the river in Marsabit town was opened last night by unknown contractors."); inv2Id = inv.id;
  const a = (await ana2.get(`/api/investigations/${inv.id}/report.json`)).body; AI.recs = "valid";
  assert.ok(a.recommendations.every(x => x.startsWith("There is a need to ") && !/website|search for evidence|manually/i.test(x)), JSON.stringify(a.recommendations));
  assert.ok(["Insufficient Evidence", "Unverified"].includes(a.verdict_label), a.verdict_label); assert.match(a.recommendations.join(" "), /treat the narrative as unverified/);
  assert.ok(inv.result.ai.notes.some(n => /recommendations: .*not within the rules/.test(n)), JSON.stringify(inv.result.ai.notes));
});

test("automatic completion and submission: the case is completed by AIVS (no manual fields), the draft goes to the HOD queue by itself, the HOD is notified", async () => {
  const inv = (await ana.get(`/api/investigations/${invId}`)).body, r = inv.result, db = S.ctx.db;
  assert.deepEqual(inv.stages.map(s => s.key), ["source", "extract", "analyse", "search", "compare", "media", "assess", "conclude", "report", "submit"]);
  assert.equal(inv.stages.find(s => s.key === "conclude").status, "done"); assert.match(inv.stages.find(s => s.key === "submit").detail, /submitted automatically · pending HOD approval · HOD/);
  // the case: claims assessed with an evidence-based rationale, evidence validated and linked, conclusion, reasoning, uncertainties
  const c = db.prepare("SELECT * FROM cases WHERE id = ?").get(inv.case_id), cls = db.prepare("SELECT * FROM claims WHERE case_id = ? AND removed = 0").all(c.id);
  assert.equal(c.status, "awaiting_approval"); assert.equal(c.approval_route, "hod"); assert.ok(c.auto_completed_at);
  assert.equal(c.conclusion, "contradicted", JSON.stringify({ c: c.conclusion, cls: S.ctx.db.prepare("SELECT seq, assessment, removed, rationale FROM claims WHERE case_id = ?").all(c.id), st: c.status })); assert.match(c.conclusion_rationale, /Determined automatically from/); assert.match(c.conclusion_rationale, /Confidence: (High|Medium|Low)/); assert.ok(c.uncertainties.trim().length > 10);
  assert.ok(cls.length >= 1 && cls.length <= 2, "at most two principal claims stay in the case");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claims WHERE case_id=?").get(c.id).n, cls.length, "automation never removes saved claims to make room");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM claim_candidates WHERE case_id=?").get(c.id).n > 2, "additional statements remain candidates");
  for (const cl of cls) { assert.equal(cl.assessed_auto, 1); assert.notEqual(cl.assessment, "unassessed"); assert.match(cl.rationale, /^Observed: .*Interpretation \(AIVS rules\)/); assert.doesNotMatch(cl.rationale, /^ok$/i); }
  const ev = db.prepare("SELECT * FROM evidence WHERE case_id = ?").all(c.id);
  assert.equal(ev.filter(e => e.status === "suggested").length, 0, "every suggestion was decided by the rules");
  for (const e of ev.filter(e => e.origin === "retrieval")) { const v = JSON.parse(e.validation); assert.equal(v.by, "AIVS rules"); assert.equal(v.accepted, e.status === "accepted"); }
  for (const cl of cls) assert.ok(db.prepare("SELECT COUNT(*) n FROM evidence_links l JOIN evidence e ON e.id = l.evidence_id WHERE l.claim_id = ? AND e.status = 'accepted'").get(cl.id).n <= 2, "at most two evidence items per claim");
  const fc = ev.find(e => e.connector === "factcheck" && e.status === "accepted"); assert.ok(fc, "the fact-check was accepted"); assert.ok(fc.source_url && fc.retrieved_at, "original address and time kept");
  assert.equal(db.prepare("SELECT stance FROM evidence_links WHERE evidence_id = ?").get(fc.id).stance, "contradicts");
  assert.equal((await ana.get(`/api/cases/${c.id}/readiness`)).body.ok, true, "no manual completion is needed");
  assert.equal(r.automation.conclusion, "contradicted", JSON.stringify(r.automation).slice(0, 600)); assert.ok(r.automation.uncertainties.length >= 1); assert.ok(r.automation.ai && AI.calls.includes("explain"), "the AI explained the decided verdicts"); assert.ok(!cls.some(x => /example\.invalid/.test(x.rationale)), "an AI sentence with a link or a truth claim is not used");
  assert.match(cls[0].rationale + c.conclusion_rationale, /AI interpretation \(qwen3:4b-instruct, checked; not evidence\)/);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM case_gaps WHERE case_id = ? AND origin = 'rules' AND rule_code LIKE 'auto_%'").get(c.id).n >= 1, "uncertainties appear in evidence coverage");
  // nothing is ever "supported" without accepted supporting evidence (whole database)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claims c WHERE c.assessment = 'supported' AND c.removed = 0 AND NOT EXISTS (SELECT 1 FROM evidence_links l JOIN evidence e ON e.id = l.evidence_id WHERE l.claim_id = c.id AND l.stance = 'supports' AND e.status = 'accepted')").get().n, 0);
  // the approval record and the HOD's notification
  const st0 = (await ana.get(`/api/investigations/${invId}/approval`)).body; assert.equal(st0.status, "pending"); assert.equal(st0.assigned_hod_name, "HOD", "the least-loaded HOD is assigned");
  assert.equal(st0.events[0].action, "submitted automatically for HOD approval");
  const nt = (await hod.get("/api/notifications")).body; assert.ok(nt.unread >= 1 && nt.items.some(n => n.kind === "approval_pending" && n.ref === inv.report_id), JSON.stringify(nt));
  assert.equal((await rev.post(`/api/cases/${c.id}/decision`, { decision: "approve" })).status, 409, "a reviewer does not decide a case that goes to the HOD");
  assert.equal((await ana.post(`/api/cases/${c.id}/submit`, {})).status, 409);
});

test("HOD approval: permissions, return for revision, revision rules, approval, final PDF with genuine approval details, verification; the case follows", async () => {
  // an analyst cannot approve, an administrator has no approval authority, another HOD cannot decide
  assert.equal((await ana.post(`/api/investigations/${invId}/decision`, { action: "approve" })).status, 403);
  assert.equal((await admin.post(`/api/investigations/${invId}/decision`, { action: "approve" })).status, 403);
  const caseId = S.ctx.db.prepare("SELECT case_id FROM investigations WHERE id = ?").get(invId).case_id, cstat = () => S.ctx.db.prepare("SELECT status FROM cases WHERE id = ?").get(caseId).status;
  const hodId = (await ana.get(`/api/investigations/${invId}/approval`)).body.hods.find(h => h.name === "HOD").id;
  assert.equal((await hod2.post(`/api/investigations/${invId}/decision`, { action: "approve" })).status, 403, "only the assigned HOD decides");
  // the dashboard
  assert.ok((await hod.get("/api/approvals?status=pending")).body.reports.some(x => x.ref_id === invId && x.can_decide));
  assert.ok(!(await hod2.get("/api/approvals")).body.reports.some(x => x.ref_id === invId), "another HOD does not see it");
  assert.ok((await ana.get("/api/approvals")).body.reports.some(x => x.ref_id === invId && x.status === "pending" && !x.can_decide));
  // returned for revision, with a reason
  assert.equal((await hod.post(`/api/investigations/${invId}/decision`, { action: "return" })).status, 400, "a return needs a reason");
  assert.equal((await hod.post(`/api/investigations/${invId}/decision`, { action: "return", note: "Shorten recommendation 3." })).body.status, "returned");
  assert.equal(cstat(), "needs_evidence", "the case is returned with the report"); assert.ok((await ana.get("/api/notifications")).body.items.some(n => n.kind === "approval_returned"));
  const cur = (await ana.get(`/api/investigations/${invId}/report.json`)).body;
  const bad = await ana.put(`/api/investigations/${invId}/assessment`, { recommendations: [...cur.recommendations.slice(0, 2), "Visit the KDF website to verify the information manually."] }); assert.equal(bad.status, 400); assert.match(bad.body.error, /There is a need to|verification work/);
  const ok = await ana.put(`/api/investigations/${invId}/assessment`, { recommendations: [...cur.recommendations.slice(0, 2), "There is a need to monitor recruitment narratives through the AIVS watchlist."] }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.status, "returned"); assert.equal(ok.body.version, 2);
  assert.equal((await ana.post(`/api/investigations/${invId}/submit`, { hod_id: hodId })).body.status, "pending"); assert.equal(cstat(), "awaiting_approval");
  // approval: the final PDF is generated, stored and served; it carries the HOD's name, designation, date, reference and code
  const ap = await hod.post(`/api/investigations/${invId}/decision`, { action: "approve", note: "Approved for release." }); assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.status, "approved"); assert.match(ap.body.approval_ref, /^APR-\d{8}-\d{3}$/);
  assert.equal(cstat(), "approved", "the HOD's approval is the case approval"); assert.ok(S.ctx.db.prepare("SELECT 1 FROM reports WHERE case_id = ?").get(caseId), "the case report is frozen");
  const html = (await ana.get(`/api/investigations/${invId}/report.html`)).body; assert.match(html, /APPROVED BY HEAD OF DEPARTMENT/); assert.match(html, /Head of Department, Information Operations/); assert.doesNotMatch(html, /DRAFT — NOT APPROVED/);
  const p1 = await pdfText(ana, `/api/investigations/${invId}/report.pdf`), p2 = await pdfText(rev, `/api/investigations/${invId}/report.pdf`);
  assert.equal(p1.pages, 1); assert.ok(p1.buf.equals(p2.buf), "the stored approved PDF is served unchanged");
  assert.match(p1.text, /APPROVED BY HEAD OF DEPARTMENT/); assert.match(p1.text, /Approved by HOD, Head of Department, Information Operations/); assert.match(p1.text, new RegExp(ap.body.approval_ref)); assert.doesNotMatch(p1.text, /DRAFT [-—] NOT APPROVED/);
  const code = /Verification code ([0-9A-F-]{19})/.exec(p1.text)?.[1]; assert.ok(code, p1.text.slice(-400));
  const v = (await fetch(`${S.base}/api/public/verify-report?ref=${ap.body.approval_ref}&code=${code}`).then(r => r.json())); assert.equal(v.valid, true); assert.equal(v.approved_by, "HOD"); assert.equal(v.analysis, undefined, "no report content is exposed");
  assert.equal((await fetch(`${S.base}/api/public/verify-report?ref=${ap.body.approval_ref}&code=0000-0000-0000-0000`).then(r => r.json())).valid, false);
  assert.match(await (await fetch(`${S.base}/verify-report?ref=${ap.body.approval_ref}&code=${code}`)).text(), /Genuine/);
  // a material change after approval invalidates it
  const edit = await ana.put(`/api/investigations/${invId}/assessment`, { assessment: `${cur.assessment} The post remains in circulation.` }); assert.equal(edit.status, 200); assert.equal(edit.body.status, "draft");
  assert.match((await ana.get(`/api/investigations/${invId}/report.html`)).body, /DRAFT — NOT APPROVED/);
  assert.match((await pdfText(ana, `/api/investigations/${invId}/report.pdf`)).text, /DRAFT [-—] NOT APPROVED/);
  assert.equal((await fetch(`${S.base}/api/public/verify-report?ref=${ap.body.approval_ref}&code=${code}`).then(r => r.json())).valid, false, "the old approval no longer verifies");
  // the record: events, versions, audit and an intact hash chain
  const st = (await ana.get(`/api/investigations/${invId}/approval`)).body;
  assert.deepEqual(st.events.map(e => e.action), ["submitted automatically for HOD approval", "returned for revision", "revised", "submitted for HOD approval", "approved by the Head of Department", "approval invalidated by a material change"]);
  assert.ok(st.versions.length >= 4); assert.ok(S.ctx.approvals.chainIntact("investigation", invId));
  const audit = S.ctx.db.prepare("SELECT action FROM audit_log WHERE entity = 'investigation' AND entity_id = ?").all(invId).map(x => x.action);
  for (const x of ["Report submitted automatically for HOD approval", "Report submitted for HOD approval", "Report returned for revision", "Report approved by the Head of Department", "Report approval invalidated by a material change"]) assert.ok(audit.includes(x), x);
  S.ctx.db.prepare("UPDATE report_approval_events SET note = 'tampered' WHERE id = (SELECT MIN(id) FROM report_approval_events)").run();
  assert.equal(S.ctx.approvals.chainIntact("investigation", invId), false, "a changed event breaks the chain");
});

test("rejection needs a reason and is final; the HOD cannot decide on a report they prepared", async () => {
  const hodId = (await ana2.get(`/api/investigations/${inv2Id}/approval`)).body.hods.find(h => h.name === "HOD2").id, st = (await ana2.get(`/api/investigations/${inv2Id}/approval`)).body;
  assert.equal(st.status, "pending", "submitted automatically"); assert.equal(st.assigned_hod_name, "HOD2", "the HOD with fewer reports waiting");
  assert.equal((await hod2.post(`/api/investigations/${inv2Id}/decision`, { action: "reject" })).status, 400);
  const rj = await hod2.post(`/api/investigations/${inv2Id}/decision`, { action: "reject", note: "Insufficient evidence for release." }); assert.equal(rj.body.status, "rejected");
  assert.equal((await ana2.post(`/api/investigations/${inv2Id}/submit`, { hod_id: hodId })).status, 409); assert.equal((await ana2.put(`/api/investigations/${inv2Id}/assessment`, {})).status, 409);
  assert.match((await ana2.get(`/api/investigations/${inv2Id}/report.html`)).body, /DRAFT — NOT APPROVED \(Rejected\)/);
  assert.equal(S.ctx.db.prepare("SELECT c.status FROM cases c JOIN investigations i ON i.case_id = c.id WHERE i.id = ?").get(inv2Id).status, "rejected");
  // a HOD who submitted a report cannot approve it (a HOD given the reviewer's submit right is still refused)
  const row = S.ctx.db.prepare("SELECT id FROM report_approvals WHERE ref_id = ?").get(inv2Id);
  S.ctx.db.prepare("UPDATE report_approvals SET status = 'pending', submitted_by = (SELECT id FROM users WHERE username = 'hod2'), assigned_hod = (SELECT id FROM users WHERE username = 'hod2') WHERE id = ?").run(row.id);
  assert.equal((await hod2.post(`/api/investigations/${inv2Id}/decision`, { action: "approve" })).status, 403);
});

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
  assert.ok(r.claims.length >= 1 && r.claims.length <= 2, `principal claims: ${r.claims.map(c => c.text)}`); assert.equal(r.principal_by, "ai"); assert.ok(AI.calls.includes("rank"));
  assert.ok(r.claims.some(c => /KSh 2,000/.test(c.text))); assert.ok(r.other_claims.length >= 1, "the other statements are kept"); assert.ok(!r.claims.some(c => /respected institution/.test(c.text)), "background is not a principal claim");
  assert.equal(inv.stages.find(s => s.key === "search").status, "done"); assert.ok(r.search.some(s => s.key === "factcheck" && s.status === "ok"), "evidence searched automatically");
  const fc = r.evidence.find(e => e.connector === "factcheck"); assert.ok(fc.page_read, "the fact-check article itself was read"); assert.match(fc.passage, /pay KSh 2,000|free of charge/);
  assert.equal(r.overall.verdict, "contradicted"); assert.equal(r.ai.used, true);
  const a = (await ana.get(`/api/investigations/${inv.id}/report.json`)).body;
  if (process.env.DUMP) { const rb = await import("../server/lib/ioassessment.js"); console.log("RULES", JSON.stringify(rb.buildAssessment(r), null, 1)); console.log("FINAL", JSON.stringify(a, null, 1)); }
  assert.equal(a.verdict_label, "False"); assert.equal(a.written_by, "ai"); assert.ok(AI.calls.includes("draft"));
  assert.match(a.assessment, /misinformation/); assert.match(a.assessment, /KDF/); assert.doesNotMatch(a.assessment, /\bis disinformation\b|hostile|coordinated campaign/i);
  assert.ok(a.recommendations.length >= 3 && a.recommendations.length <= 5 && a.recommendations.every(x => x.startsWith("There is a need to ")));
  assert.ok(a.claims.length <= 2 && a.claims[0].contradicting.length, "the claim's contradicting evidence is cited");
  const html = (await ana.get(`/api/investigations/${inv.id}/report.html`)).body; assert.equal((html.match(/<h2>/g) || []).length, 4); assert.match(html, /DRAFT — NOT APPROVED/); assert.doesNotMatch(html, /APPROVED BY HEAD OF DEPARTMENT/);
  const p = await pdfText(ana, `/api/investigations/${inv.id}/report.pdf`); assert.equal(p.pages, 1, "one A4 page"); assert.match(p.text, /DRAFT - NOT APPROVED/);
  for (const h of ["EXECUTIVE SUMMARY / BACKGROUND INFORMATION", "ANALYSIS", "ASSESSMENT", "RECOMMENDATIONS"]) assert.ok(p.text.includes(h), h);
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

test("HOD approval: submission, permissions, return for revision, revision rules, approval, final PDF with genuine approval details, verification", async () => {
  // an analyst cannot approve, an administrator has no approval authority, and nothing can be decided before submission
  assert.equal((await ana.post(`/api/investigations/${invId}/decision`, { action: "approve" })).status, 403);
  assert.equal((await admin.post(`/api/investigations/${invId}/decision`, { action: "approve" })).status, 403);
  assert.equal((await hod.post(`/api/investigations/${invId}/decision`, { action: "approve" })).status, 409, "not submitted yet");
  const st0 = (await ana.get(`/api/investigations/${invId}/approval`)).body; assert.equal(st0.status, "draft"); assert.ok(st0.hods.length === 2);
  assert.equal((await ana.post(`/api/investigations/${invId}/submit`, {})).status, 400, "the HOD must be chosen when there are several");
  assert.equal((await ana2.post(`/api/investigations/${invId}/submit`, { hod_id: st0.hods[0].id })).status, 403, "only the analyst who ran it (or a reviewer) submits it");
  const hodId = st0.hods.find(h => h.name === "HOD").id;
  const sub = await ana.post(`/api/investigations/${invId}/submit`, { hod_id: hodId, note: "Fact-check and article read." }); assert.equal(sub.status, 200, JSON.stringify(sub.body)); assert.equal(sub.body.status, "pending"); assert.equal(sub.body.assigned_hod_name, "HOD");
  assert.equal((await hod2.post(`/api/investigations/${invId}/decision`, { action: "approve" })).status, 403, "only the assigned HOD decides");
  // the dashboard
  assert.ok((await hod.get("/api/approvals?status=pending")).body.reports.some(x => x.ref_id === invId && x.can_decide));
  assert.ok(!(await hod2.get("/api/approvals")).body.reports.some(x => x.ref_id === invId), "another HOD does not see it");
  assert.ok((await ana.get("/api/approvals")).body.reports.some(x => x.ref_id === invId && x.status === "pending" && !x.can_decide));
  // returned for revision, with a reason
  assert.equal((await hod.post(`/api/investigations/${invId}/decision`, { action: "return" })).status, 400, "a return needs a reason");
  assert.equal((await hod.post(`/api/investigations/${invId}/decision`, { action: "return", note: "Shorten recommendation 3." })).body.status, "returned");
  const cur = (await ana.get(`/api/investigations/${invId}/report.json`)).body;
  const bad = await ana.put(`/api/investigations/${invId}/assessment`, { recommendations: [...cur.recommendations.slice(0, 2), "Visit the KDF website to verify the information manually."] }); assert.equal(bad.status, 400); assert.match(bad.body.error, /There is a need to|verification work/);
  const ok = await ana.put(`/api/investigations/${invId}/assessment`, { recommendations: [...cur.recommendations.slice(0, 2), "There is a need to monitor recruitment narratives through the AIVS watchlist."] }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.status, "returned"); assert.equal(ok.body.version, 2);
  assert.equal((await ana.post(`/api/investigations/${invId}/submit`, { hod_id: hodId })).body.status, "pending");
  // approval: the final PDF is generated, stored and served; it carries the HOD's name, designation, date, reference and code
  const ap = await hod.post(`/api/investigations/${invId}/decision`, { action: "approve", note: "Approved for release." }); assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.status, "approved"); assert.match(ap.body.approval_ref, /^APR-\d{8}-\d{3}$/);
  const html = (await ana.get(`/api/investigations/${invId}/report.html`)).body; assert.match(html, /APPROVED BY HEAD OF DEPARTMENT/); assert.match(html, /Head of Department, Information Operations/); assert.doesNotMatch(html, /DRAFT — NOT APPROVED/);
  const p1 = await pdfText(ana, `/api/investigations/${invId}/report.pdf`), p2 = await pdfText(rev, `/api/investigations/${invId}/report.pdf`);
  assert.equal(p1.pages, 1); assert.ok(p1.buf.equals(p2.buf), "the stored approved PDF is served unchanged");
  assert.match(p1.text, /APPROVED BY HEAD OF DEPARTMENT/); assert.match(p1.text, /Approved by HOD, Head of Department, Information Operations/); assert.match(p1.text, new RegExp(ap.body.approval_ref)); assert.doesNotMatch(p1.text, /DRAFT - NOT APPROVED/);
  const code = /Verification code ([0-9A-F-]{19})/.exec(p1.text)?.[1]; assert.ok(code, p1.text.slice(-400));
  const v = (await fetch(`${S.base}/api/public/verify-report?ref=${ap.body.approval_ref}&code=${code}`).then(r => r.json())); assert.equal(v.valid, true); assert.equal(v.approved_by, "HOD"); assert.equal(v.analysis, undefined, "no report content is exposed");
  assert.equal((await fetch(`${S.base}/api/public/verify-report?ref=${ap.body.approval_ref}&code=0000-0000-0000-0000`).then(r => r.json())).valid, false);
  assert.match(await (await fetch(`${S.base}/verify-report?ref=${ap.body.approval_ref}&code=${code}`)).text(), /Genuine/);
  // a material change after approval invalidates it
  const edit = await ana.put(`/api/investigations/${invId}/assessment`, { assessment: `${cur.assessment} The post remains in circulation.` }); assert.equal(edit.status, 200); assert.equal(edit.body.status, "draft");
  assert.match((await ana.get(`/api/investigations/${invId}/report.html`)).body, /DRAFT — NOT APPROVED/);
  assert.match((await pdfText(ana, `/api/investigations/${invId}/report.pdf`)).text, /DRAFT - NOT APPROVED/);
  assert.equal((await fetch(`${S.base}/api/public/verify-report?ref=${ap.body.approval_ref}&code=${code}`).then(r => r.json())).valid, false, "the old approval no longer verifies");
  // the record: events, versions, audit and an intact hash chain
  const st = (await ana.get(`/api/investigations/${invId}/approval`)).body;
  assert.deepEqual(st.events.map(e => e.action), ["submitted for HOD approval", "returned for revision", "revised", "submitted for HOD approval", "approved by the Head of Department", "approval invalidated by a material change"]);
  assert.ok(st.versions.length >= 4); assert.ok(S.ctx.approvals.chainIntact("investigation", invId));
  const audit = S.ctx.db.prepare("SELECT action FROM audit_log WHERE entity = 'investigation' AND entity_id = ?").all(invId).map(x => x.action);
  for (const x of ["Report submitted for HOD approval", "Report returned for revision", "Report approved by the Head of Department", "Report approval invalidated by a material change"]) assert.ok(audit.includes(x), x);
  S.ctx.db.prepare("UPDATE report_approval_events SET note = 'tampered' WHERE id = (SELECT MIN(id) FROM report_approval_events)").run();
  assert.equal(S.ctx.approvals.chainIntact("investigation", invId), false, "a changed event breaks the chain");
});

test("rejection needs a reason and is final; the HOD cannot decide on a report they prepared", async () => {
  const hodId = (await ana2.get(`/api/investigations/${inv2Id}/approval`)).body.hods.find(h => h.name === "HOD2").id;
  assert.equal((await ana2.post(`/api/investigations/${inv2Id}/submit`, { hod_id: hodId })).status, 200);
  assert.equal((await hod2.post(`/api/investigations/${inv2Id}/decision`, { action: "reject" })).status, 400);
  const rj = await hod2.post(`/api/investigations/${inv2Id}/decision`, { action: "reject", note: "Insufficient evidence for release." }); assert.equal(rj.body.status, "rejected");
  assert.equal((await ana2.post(`/api/investigations/${inv2Id}/submit`, { hod_id: hodId })).status, 409); assert.equal((await ana2.put(`/api/investigations/${inv2Id}/assessment`, {})).status, 409);
  assert.match((await ana2.get(`/api/investigations/${inv2Id}/report.html`)).body, /DRAFT — NOT APPROVED \(Rejected\)/);
  // a HOD who submitted a report cannot approve it (a HOD given the reviewer's submit right is still refused)
  const row = S.ctx.db.prepare("SELECT id FROM report_approvals WHERE ref_id = ?").get(inv2Id);
  S.ctx.db.prepare("UPDATE report_approvals SET status = 'pending', submitted_by = (SELECT id FROM users WHERE username = 'hod2'), assigned_hod = (SELECT id FROM users WHERE username = 'hod2') WHERE id = ?").run(row.id);
  assert.equal((await hod2.post(`/api/investigations/${inv2Id}/decision`, { action: "approve" })).status, 403);
});

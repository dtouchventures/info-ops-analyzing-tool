import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer, login, file, T, PW } from "./helpers.js";
import { verifyChain } from "../server/lib/audit.js";

let S, admin, rev, rev2, ana, ana2, view, caseId, mediaId;
before(async () => {
  S = await startServer();
  [admin, rev, rev2, ana, ana2, view] = await Promise.all(["admin", "rev", "rev2", "ana", "ana2", "view"].map(u => login(S.base, u)));
});
after(async () => S.close());

test("authentication and CSRF protections", async () => {
  assert.equal((await login(S.base, "ana", "wrong-password-1")).status, 401);
  assert.equal((await fetch(S.base + "/api/cases")).status, 401);
  const r = await fetch(S.base + "/api/cases", { method: "POST", headers: { cookie: ana.cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 403, "missing X-AIVS header must be rejected");
  const r2 = await fetch(S.base + "/", {}); assert.match(r2.headers.get("content-security-policy"), /default-src 'self'/);
});

test("role permissions", async () => {
  assert.equal((await view.post("/api/cases", { title: "x", claim_text: "x", source_platform: "x", received_at: new Date().toISOString() })).status, 403);
  assert.equal((await ana.get("/api/users")).status, 403);
  assert.equal((await admin.get("/api/users")).status, 200);
});

test("create a case, preserve the original submission, upload media with SHA-256", async () => {
  const r = await ana.post("/api/cases", { title: "Convoy flood photo", claim_text: "BREAKING: KDF trucks were abandoned in floodwater near Garissa last night. Soldiers retreated on foot.", source_platform: "X", received_at: "2026-10-15T06:42:00Z", claimed_event_at: "2026-10-14T23:00:00Z", claimed_event_basis: "Post says 'last night'" });
  assert.equal(r.status, 201); caseId = r.body.id; assert.match(caseId, /^C-\d{4}-\d{4}$/);
  const up = await ana.post(`/api/cases/${caseId}/media`, null, { form: file(T("images/case_convoy.jpg")) });
  assert.equal(up.status, 201); mediaId = up.body.media[0].id;
  const sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(T("images/case_convoy.jpg"))).digest("hex");
  assert.equal(up.body.media[0].sha256, sha, "server SHA-256 must equal the file's bytes");
  const bad = await ana.post(`/api/cases/${caseId}/media`, null, { form: (() => { const f = new FormData(); f.append("files", new Blob(["<script>alert(1)</script>"]), "evil.jpg"); return f; })() });
  assert.equal(bad.status, 422, "type is sniffed from bytes, not the file name");
  const ed = await ana.patch(`/api/cases/${caseId}`, { claim_text: "Edited working text. KDF trucks were abandoned near Garissa last night." });
  assert.equal(ed.status, 200);
  const agg = (await ana.get(`/api/cases/${caseId}`)).body;
  assert.match(agg.case.claim_text_original, /^BREAKING/); assert.match(agg.case.claim_text, /^Edited/);
  assert.ok(agg.versions.length >= 3, "edits are versioned");
});

test("training archive is separate; real archive match is found as a lead", async () => {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(T("images/archive_convoy.jpg"))]), "convoy-2018.jpg");
  for (const [k, v] of Object.entries({ title: "Convoy crossing 2018", description: "Documented convoy crossing; all vehicles completed it.", documented_date: "2018-10-14", source_ref: "Unit media release 2018/994", record_type: "original" })) fd.append(k, v);
  assert.equal((await ana.post("/api/archive", null, { form: fd })).status, 403, "analysts cannot edit the archive");
  const a = await rev.post("/api/archive", null, { form: fd }); assert.equal(a.status, 201); assert.match(a.body.id, /^A-\d{4}$/);
  // training archive must not match real cases
  await admin.post("/api/admin/training", {});
  const an = await ana.post(`/api/cases/${caseId}/analyse?wait=1`, {}); assert.equal(an.status, 202);
  const agg = (await ana.get(`/api/cases/${caseId}`)).body;
  assert.equal(agg.case.status, "analyst_review");
  const m = agg.matches.filter(x => x.target_archive_id);
  assert.equal(m.length, 1); assert.equal(m[0].target_archive_id, a.body.id); assert.equal(m[0].kind, "perceptual"); assert.equal(m[0].level, "strong");
  assert.ok(!agg.matches.some(x => /^TA-/.test(x.target_archive_id || "")), "real cases never match training records");
  const lead = agg.evidence.find(e => e.archive_id === a.body.id);
  assert.equal(lead.kind, "lead"); assert.equal(lead.status, "suggested"); assert.match(lead.text, /Lead:/);
  assert.ok(agg.claims.length >= 2 && agg.claims.some(c => c.kind === "timing"));
});

test("identical bytes are distinguished from similarity; seen-before across cases", async () => {
  const r = await ana2.post("/api/cases", { title: "Same photo again", claim_text: "Trucks stuck in Garissa floods today.", source_platform: "WhatsApp", received_at: new Date().toISOString() });
  await ana2.post(`/api/cases/${r.body.id}/media`, null, { form: file(T("images/case_convoy.jpg")) });
  await ana2.post(`/api/cases/${r.body.id}/analyse?wait=1`, {});
  const agg = (await ana2.get(`/api/cases/${r.body.id}`)).body;
  const ex = agg.matches.find(x => x.target_case_id === caseId);
  assert.equal(ex.kind, "exact"); assert.equal(ex.level, "identical");
  assert.ok(agg.evidence.some(e => e.related_case_id === caseId && /identical file/.test(e.text)));
  assert.equal((await ana.patch(`/api/cases/${r.body.id}`, { title: "hijack" })).status, 403, "analysts cannot edit others' cases");
});

test("no archive match is never presented as authenticity", async () => {
  const r = await ana.post("/api/cases", { title: "Patrol", claim_text: "Troops patrolled near the outpost this morning. The area is calm.", source_platform: "Facebook", received_at: new Date().toISOString() });
  await ana.post(`/api/cases/${r.body.id}/media`, null, { form: file(T("images/case_patrol.jpg")) });
  await ana.post(`/api/cases/${r.body.id}/analyse?wait=1`, {});
  const agg = (await ana.get(`/api/cases/${r.body.id}`)).body;
  const e = agg.evidence.find(x => /No earlier copy/.test(x.text));
  assert.match(e.text, /does not show that the media is new, original or authentic/);
});

test("per-claim assessments, mixed findings and approval rules with separation of duties", async () => {
  let agg = (await ana.get(`/api/cases/${caseId}`)).body;
  // accept every suggestion; link the archive lead as contradicting the timing claim
  const timing = agg.claims.find(c => c.kind === "timing");
  for (const e of agg.evidence.filter(x => x.status === "suggested")) {
    const links = e.archive_id ? [{ claim_id: timing.id, stance: "contradicts" }] : [];
    assert.equal((await ana.patch(`/api/evidence/${e.id}`, { status: e.kind === "lead" && !e.archive_id && !e.related_case_id ? "dismissed" : "accepted", links })).status, 200);
  }
  const sup = await ana.post(`/api/cases/${caseId}/evidence`, { kind: "source_claim", text: "Unit log confirms the vehicles are KDF trucks.", reference: "Unit log 4B/2018", links: [{ claim_id: agg.claims[0].id, stance: "supports" }] });
  assert.equal(sup.status, 201);
  assert.equal((await ana.post(`/api/cases/${caseId}/evidence`, { kind: "inference", text: "no ref" })).status, 400, "evidence needs a reference");
  agg = (await ana.get(`/api/cases/${caseId}`)).body;
  for (const c of agg.claims.filter(c => !c.removed)) {
    const a = c.id === timing.id ? "contradicted" : c.id === agg.claims[0].id ? "supported" : "insufficient";
    await ana.patch(`/api/claims/${c.id}`, { assessment: a, rationale: "Test rationale." });
  }
  let r = await ana.post(`/api/cases/${caseId}/submit`, {});
  assert.equal(r.status, 422); assert.ok(r.body.details.some(p => /conclusion/i.test(p)));
  await ana.patch(`/api/cases/${caseId}`, { conclusion: "contradicted", conclusion_rationale: "Old image.", uncertainties: "Exact event location unconfirmed." });
  r = await ana.post(`/api/cases/${caseId}/submit`, {});
  assert.equal(r.status, 422); assert.ok(r.body.details.some(p => /Mixed findings/.test(p)), "supported + contradicted claims require 'mixed'");
  await ana.patch(`/api/cases/${caseId}`, { conclusion: "mixed" });
  assert.equal((await ana.post(`/api/cases/${caseId}/submit`, {})).status, 200);
  assert.equal((await ana.patch(`/api/cases/${caseId}`, { title: "x" })).status, 409, "locked while awaiting approval");
  assert.equal((await ana.post(`/api/cases/${caseId}/decision`, { decision: "approve" })).status, 403, "analysts cannot approve");
  // reviewer returns, analyst resubmits, a reviewer approves
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "return" })).status, 400, "returning requires a comment");
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "return", comment: "Add the location check." })).status, 200);
  assert.equal((await ana.post(`/api/cases/${caseId}/submit`, {})).status, 200);
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "approve" })).status, 200);
  const rep = (await rev.get("/api/reports")).body.approved.find(x => x.case_id === caseId);
  assert.ok(rep && /^[0-9a-f]{64}$/.test(rep.sha256));
  const html = await rev.get(`/api/reports/${rep.id}.html`);
  assert.match(html.body, /MIXED FINDINGS/); assert.doesNotMatch(html.body, /DRAFT — not approved/);
  assert.match(html.body, /does not establish authenticity/);
});

test("reviewer cannot approve their own analysis", async () => {
  const r = await rev2.post("/api/cases", { title: "Own work", claim_text: "A claim about a convoy in Wajir yesterday.", source_platform: "X", received_at: new Date().toISOString() });
  const id = r.body.id;
  await rev2.post(`/api/cases/${id}/analyse?wait=1`, {});
  const agg = (await rev2.get(`/api/cases/${id}`)).body;
  for (const c of agg.claims) await rev2.patch(`/api/claims/${c.id}`, { assessment: "insufficient", rationale: "Nothing found." });
  await rev2.patch(`/api/cases/${id}`, { conclusion: "insufficient", conclusion_rationale: "No evidence either way.", uncertainties: "All." });
  assert.equal((await rev2.post(`/api/cases/${id}/submit`, {})).status, 200);
  assert.equal((await rev2.post(`/api/cases/${id}/decision`, { decision: "approve" })).status, 403);
  assert.equal((await rev.post(`/api/cases/${id}/decision`, { decision: "approve" })).status, 200);
});

test("revision after approval keeps the approved report", async () => {
  assert.equal((await ana.post(`/api/cases/${caseId}/revise`, {})).status, 400, "reason required");
  assert.equal((await ana.post(`/api/cases/${caseId}/revise`, { reason: "New source found" })).status, 200);
  const agg = (await ana.get(`/api/cases/${caseId}`)).body;
  assert.equal(agg.case.revision, 2); assert.equal(agg.case.status, "analyst_review"); assert.equal(agg.reports.length, 1);
});

test("claims can be split; OCR keeps the original extraction", async () => {
  const agg = (await ana.get(`/api/cases/${caseId}`)).body;
  const cl = await ana.post(`/api/cases/${caseId}/claims`, { text: "The trucks were abandoned and the soldiers walked back to base." });
  const sp = await ana.post(`/api/claims/${cl.body.id}/split`, {});
  assert.equal(sp.status, 200); assert.equal(sp.body.ids.length, 2);
  const o = await ana.post(`/api/media/${mediaId}/ocr`, { engine: "tesseract.js 5.1.1", lang: "eng+swa", confidence: 71, text: "Dated 14 0ctober 1968" });
  await ana.patch(`/api/ocr/${o.body.id}`, { text: "Dated 14 October 1968" });
  const a2 = (await ana.get(`/api/cases/${caseId}`)).body, rec = a2.ocr.find(x => x.id === o.body.id);
  assert.equal(rec.original_text, "Dated 14 0ctober 1968"); assert.equal(rec.current_text, "Dated 14 October 1968"); assert.equal(rec.versions.length, 1);
  assert.ok(agg);
});

test("video frames are stored with timestamps", async () => {
  const r = await ana.post(`/api/cases/${caseId}/media`, null, { form: file(T("images/sample_clip.webm")) });
  const vid = r.body.media[0]; assert.equal(vid.kind, "video");
  const fd = new FormData(); fd.append("frame", new Blob([fs.readFileSync(T("images/case_convoy.jpg"))]), "f.jpg"); fd.append("time", "5.25"); fd.append("origin", "analyst");
  const f = await ana.post(`/api/media/${vid.id}/frames`, null, { form: fd }); assert.equal(f.status, 201);
  const m = (await ana.get(`/api/cases/${caseId}`)).body.media.find(x => x.id === f.body.id);
  assert.equal(m.parent_media_id, vid.id); assert.equal(m.frame_time, 5.25); assert.equal(m.frame_origin, "analyst");
  const content = await fetch(S.base + `/api/media/${vid.id}/content`, { headers: { cookie: ana.cookie, range: "bytes=0-99" } });
  assert.equal(content.status, 206, "video supports range requests");
});

test("analysis failure and retry", async () => {
  process.env.AIVS_FAIL_ANALYSIS = "Will fail";
  const r = await ana.post("/api/cases", { title: "Will fail", claim_text: "Some claim text about Lamu today.", source_platform: "X", received_at: new Date().toISOString() });
  await ana.post(`/api/cases/${r.body.id}/analyse?wait=1`, {});
  let c = (await ana.get(`/api/cases/${r.body.id}`)).body.case;
  assert.equal(c.status, "analysis_failed"); assert.match(c.analysis_error, /Simulated/);
  delete process.env.AIVS_FAIL_ANALYSIS;
  await ana.post(`/api/cases/${r.body.id}/analyse?wait=1`, {});
  c = (await ana.get(`/api/cases/${r.body.id}`)).body.case;
  assert.equal(c.status, "analyst_review"); assert.equal(c.analysis_attempts, 2);
});

test("AI not configured is reported and blocks requests", async () => {
  const st = (await ana.get("/api/ai/status")).body;
  assert.equal(st.configured, false); assert.match(st.reason, /AI not configured/);
  assert.equal((await ana.post(`/api/cases/${caseId}/ai/runs`, { confirm_external: true })).status, 503);
});

test("audit log is hash-chained and tamper-evident", async () => {
  assert.equal((await rev.get("/api/audit/verify")).body.ok, true);
  S.ctx.db.prepare("UPDATE audit_log SET action = 'tampered' WHERE id = 3").run();
  assert.equal(verifyChain(S.ctx.db).ok, false);
});

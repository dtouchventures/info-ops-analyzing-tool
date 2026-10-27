// AIVS 1.1 stage tests: persistence across restart, file preservation, evidence corrections, notes,
// archive bundles, report exports, approval revisions, dashboard lists and permission boundaries.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { startServer, reopenServer, login, file, T } from "./helpers.js";

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
let S, admin, rev, ana, ana2, view, caseId, mediaId, videoId, evId;
const users = () => Promise.all(["admin", "rev", "ana", "ana2", "view"].map(u => login(S.base, u)));
before(async () => { S = await startServer(); [admin, rev, ana, ana2, view] = await users(); });
after(async () => S.close());

async function analysedCase(who, title, img = "images/case_convoy.jpg") {
  const r = await who.post("/api/cases", { title, claim_text: "KDF trucks were abandoned in floodwater near Garissa last night. Soldiers retreated on foot.", source_platform: "X", received_at: new Date().toISOString() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const up = await who.post(`/api/cases/${r.body.id}/media`, null, { form: file(T(img)) }); assert.equal(up.status, 201);
  await who.post(`/api/cases/${r.body.id}/analyse?wait=1`, {});
  return { id: r.body.id, media: up.body.media[0] };
}
async function readyAndSubmit(who, id) {
  const agg = (await who.get(`/api/cases/${id}`)).body;
  for (const e of agg.evidence.filter(x => x.status === "suggested")) await who.patch(`/api/evidence/${e.id}`, { status: "dismissed" });
  for (const c of agg.claims.filter(c => !c.removed)) await who.patch(`/api/claims/${c.id}`, { assessment: "insufficient", rationale: "No independent source found." });
  await who.patch(`/api/cases/${id}`, { conclusion: "insufficient", conclusion_rationale: "Nothing confirms or refutes it.", uncertainties: "All claims open." });
  const s = await who.post(`/api/cases/${id}/submit`, {}); assert.equal(s.status, 200, JSON.stringify(s.body));
}

test("evidence keeps source dates and every correction", async () => {
  const c = await analysedCase(ana, "Correction test"); caseId = c.id; mediaId = c.media.id;
  assert.equal((await ana.post(`/api/cases/${caseId}/evidence`, { kind: "source_claim", text: "x", reference: "y", source_date: "2018-13-01" })).status, 400, "invalid month rejected");
  assert.equal((await ana.post(`/api/cases/${caseId}/evidence`, { kind: "source_claim", text: "x", reference: "y", source_date: "2999-01-01" })).status, 400, "future date rejected");
  const r = await ana.post(`/api/cases/${caseId}/evidence`, { kind: "source_claim", text: "Press office says the photo is from 2018.", reference: "Call log 4/10", source_date: "2018-10" });
  assert.equal(r.status, 201); evId = r.body.id;
  assert.equal((await ana.patch(`/api/evidence/${evId}`, { text: "Press office says the photo was taken 14 Oct 2018.", source_date: "2018-10-14" })).status, 200);
  let agg = (await ana.get(`/api/cases/${caseId}`)).body, e = agg.evidence.find(x => x.id === evId);
  assert.equal(e.source_date, "2018-10-14"); assert.match(e.text, /14 Oct 2018/);
  assert.equal(e.versions.length, 1); assert.equal(e.versions[0].text, "Press office says the photo is from 2018."); assert.equal(e.versions[0].source_date, "2018-10");
  assert.ok(agg.versions.some(v => /corrected/.test(v.reason)), "correction is a case version");
  const sys = agg.evidence.find(x => x.origin === "system");
  assert.ok(sys, "analysis produced system suggestions");
  assert.equal((await ana.patch(`/api/evidence/${sys.id}`, { text: "rewritten" })).status, 400, "automated wording cannot be rewritten");
  assert.equal((await ana.patch(`/api/evidence/${sys.id}`, { source_date: "2018" })).status, 200, "a source date can be recorded on a lead");
  assert.equal((await view.patch(`/api/evidence/${evId}`, { text: "viewer edit" })).status, 403);
});

test("case notes: signed-in authors, edit history, role limits", async () => {
  assert.equal((await view.post(`/api/cases/${caseId}/notes`, { body: "viewer note" })).status, 403, "viewers read only");
  assert.equal((await ana.post(`/api/cases/${caseId}/notes`, { body: "   " })).status, 400);
  const n = await ana.post(`/api/cases/${caseId}/notes`, { body: "Called the press office at 10:40." }); assert.equal(n.status, 201);
  const n2 = await rev.post(`/api/cases/${caseId}/notes`, { body: "Please check the location too." }); assert.equal(n2.status, 201);
  const before = (await ana.get(`/api/cases/${caseId}`)).body.case.version;
  assert.equal((await ana2.patch(`/api/notes/${n.body.id}`, { body: "hijack" })).status, 403, "only the author edits");
  assert.equal((await ana.patch(`/api/notes/${n.body.id}`, { body: "Called the press office at 10:40; reply due 14:00." })).status, 200);
  assert.equal((await ana.del(`/api/notes/${n2.body.id}`)).status, 403, "cannot delete someone else's note");
  assert.equal((await admin.del(`/api/notes/${n2.body.id}`)).status, 200, "administrators can remove a note");
  const agg = (await view.get(`/api/cases/${caseId}`)).body;
  assert.equal(agg.case.version, before, "notes never change the case version");
  const a = agg.notes.find(x => x.id === n.body.id), b = agg.notes.find(x => x.id === n2.body.id);
  assert.equal(a.author_id, (await ana.get("/api/me")).body.user.id, "author is the session user, not a typed name");
  assert.equal(a.versions.length, 1); assert.match(a.versions[0].body, /10:40\.$/);
  assert.equal(b.deleted, 1); assert.equal(b.body, "", "deleted text is not served");
  const audit = (await admin.get(`/api/audit?entity_id=${caseId}`)).body;
  assert.ok(JSON.stringify(audit).includes("Note deleted"), "note actions are audited");
  const html = await ana.get(`/api/cases/${caseId}/report.html`);
  assert.doesNotMatch(html.body, /press office at 10:40/, "notes never appear in reports");
});

test("work persists across a server restart; stored files are byte-identical", async () => {
  const v = await ana.post(`/api/cases/${caseId}/media`, null, { form: file(T("images/sample_clip.webm")) }); videoId = v.body.media[0].id;
  const before = (await ana.get(`/api/cases/${caseId}`)).body;
  const dataDir = S.dataDir; await S.close(); S.ctx.db.close();
  S = await reopenServer(dataDir); [admin, rev, ana, ana2, view] = await users();
  const after = (await ana.get(`/api/cases/${caseId}`)).body;
  for (const k of ["case", "claims", "evidence", "notes", "media", "matches", "checklist", "versions"]) assert.deepEqual(after[k], before[k], `${k} restored after restart`);
  for (const [id, f] of [[mediaId, "images/case_convoy.jpg"], [videoId, "images/sample_clip.webm"]]) {
    const r = await fetch(S.base + `/api/media/${id}/content`, { headers: { cookie: ana.cookie } });
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(fs.readFileSync(T(f))), `${f} served byte-for-byte`);
  }
  const integ = await admin.post("/api/admin/storage/verify", {}); assert.equal(integ.status, 200); assert.ok(integ.body.checked > 0); assert.deepEqual(integ.body.failed, [], "every stored object re-hashes to its name");
});

test("dashboard lists: returned to me, recent; approval, report exports and revisions", async () => {
  await readyAndSubmit(ana, caseId);
  assert.equal((await ana.post(`/api/cases/${caseId}/decision`, { decision: "approve" })).status, 403, "analysts cannot approve");
  assert.equal((await view.post(`/api/cases/${caseId}/decision`, { decision: "approve" })).status, 403, "viewers cannot approve");
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "return", comment: "Record the press office reply." })).status, 200);
  let d = (await ana.get("/api/dashboard?training=0")).body;
  assert.ok(d.returned.some(x => x.id === caseId), "returned case is listed for its analyst");
  assert.ok(d.recent.some(x => x.id === caseId)); assert.ok(Array.isArray(d.processing));
  assert.equal((await ana.post(`/api/cases/${caseId}/submit`, {})).status, 200);
  const ap = await rev.post(`/api/cases/${caseId}/decision`, { decision: "approve", comment: "Agreed." }); assert.equal(ap.status, 200);
  d = (await ana.get("/api/dashboard?training=0")).body; assert.ok(!d.returned.some(x => x.id === caseId));
  const agg = (await rev.get(`/api/cases/${caseId}`)).body; assert.equal(agg.case.decider.username, "rev", "approval records the signed-in reviewer");
  const r1 = agg.reports[0];
  const json = await fetch(S.base + `/api/reports/${r1.id}.json`, { headers: { cookie: rev.cookie } }), jtxt = await json.text();
  assert.equal(json.status, 200); assert.equal(sha(jtxt), r1.sha256, "exported JSON matches the frozen report hash");
  assert.equal(JSON.parse(jtxt).evidence.find(e => e.id === evId).source_date, "2018-10-14");
  const html = await rev.get(`/api/reports/${r1.id}.html`); assert.equal(html.status, 200); assert.match(html.body, /Source dated 2018-10-14/); assert.match(html.body, /Corrected 1/);
  // revision 2: edit, resubmit, approve -> second report; first unchanged
  assert.equal((await ana.post(`/api/cases/${caseId}/revise`, { reason: "Press office replied" })).status, 200);
  await ana.patch(`/api/evidence/${evId}`, { text: "Press office confirmed in writing: taken 14 Oct 2018." });
  await readyAndSubmit(ana, caseId);
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "approve" })).status, 200);
  const agg2 = (await rev.get(`/api/cases/${caseId}`)).body;
  assert.equal(agg2.reports.length, 2); assert.equal(agg2.reports[0].sha256, r1.sha256, "revision 1 report is unchanged");
  const old = await fetch(S.base + `/api/reports/${r1.id}.json`, { headers: { cookie: rev.cookie } });
  assert.equal(sha(await old.text()), r1.sha256);
});

test("archive bundles: export, verified import, duplicates, tampering and scope", async () => {
  const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(T("images/archive_convoy.jpg"))]), "convoy-2018.jpg");
  for (const [k, v] of Object.entries({ title: "Convoy crossing, 2018", description: "Documented convoy crossing.", documented_date: "2018-10-14", source_ref: "Release 2018/994", record_type: "original" })) fd.append(k, v);
  assert.equal((await rev.post("/api/archive", null, { form: fd })).status, 201);
  assert.equal((await ana.get("/api/archive/export?training=0")).status, 403, "analysts cannot export the archive");
  const ex = await fetch(S.base + "/api/archive/export?training=0", { headers: { cookie: rev.cookie } }), raw = await ex.text(), b = JSON.parse(raw);
  assert.equal(ex.status, 200); assert.match(ex.headers.get("content-disposition"), /attachment/);
  assert.equal(b.format, "aivs-archive-bundle"); assert.equal(b.records.length, 1); assert.equal(sha(Buffer.from(b.records[0].image.data_base64, "base64")), b.records[0].image.sha256);
  // import into a different, empty installation
  const S2 = await startServer(); const rev2 = await login(S2.base, "rev"), ana2b = await login(S2.base, "ana");
  const form = (obj, name = "bundle.json") => { const f = new FormData(); f.append("bundle", new Blob([typeof obj === "string" ? obj : JSON.stringify(obj)]), name); return f; };
  try {
    assert.equal((await ana2b.post("/api/archive/import?training=0", null, { form: form(raw) })).status, 403, "analysts cannot import");
    assert.equal((await rev2.post("/api/archive/import?training=1", null, { form: form(raw) })).status, 400, "operational bundle refused in training scope");
    assert.equal((await rev2.post("/api/archive/import?training=0", null, { form: form("not json") })).status, 400);
    const im = await rev2.post("/api/archive/import?training=0", null, { form: form(raw, "aivs-archive.json") });
    assert.equal(im.status, 200); assert.equal(im.body.imported.length, 1, JSON.stringify(im.body));
    const id = im.body.imported[0].id, rec = (await rev2.get(`/api/archive/${id}`)).body;
    assert.equal(rec.media[0].sha256, b.records[0].image.sha256, "same bytes after import");
    assert.equal(rec.record.documented_date, "2018-10-14");
    assert.ok(rec.history.some(h => /Imported from bundle aivs-archive\.json/.test(h.action)), "provenance recorded");
    assert.ok(rec.media[0].dhash, "imported image is indexed for matching");
    const again = await rev2.post("/api/archive/import?training=0", null, { form: form(raw) });
    assert.equal(again.body.imported.length, 0); assert.equal(again.body.skipped.length, 1, "duplicate image skipped");
    const bad = structuredClone(b); bad.records[0].image.sha256 = "0".repeat(64);
    const t = await rev2.post("/api/archive/import?training=0", null, { form: form(bad) });
    assert.equal(t.body.failed.length, 1); assert.match(t.body.failed[0].reason, /SHA-256/);
    // imported record is used by matching in the new installation
    const c = await analysedCase(ana2b, "Matches imported archive");
    const agg = (await ana2b.get(`/api/cases/${c.id}`)).body;
    assert.ok(agg.matches.some(m => m.target_archive_id === id), "imported record produces archive matches");
  } finally { await S2.close(); }
});

test("permission boundaries for the new endpoints", async () => {
  assert.equal((await fetch(S.base + `/api/cases/${caseId}/notes`, { method: "POST", headers: { "content-type": "application/json", "x-aivs": "1" }, body: '{"body":"x"}' })).status, 401, "signed-out users cannot post notes");
  assert.equal((await fetch(S.base + `/api/cases/${caseId}/notes`, { method: "POST", headers: { cookie: ana.cookie, "content-type": "application/json" }, body: '{"body":"x"}' })).status, 403, "CSRF header required");
  assert.equal((await view.get("/api/archive/export?training=0")).status, 403);
  assert.equal((await view.get(`/api/cases/${caseId}`)).status, 200, "viewers can read cases");
});

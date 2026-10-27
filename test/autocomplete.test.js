// Automatic completion of investigations (1.33): the documented evidence rules, at most two evidence items per claim, the
// correction of a verdict the accepted evidence does not carry (never "Supported" without accepted supporting evidence),
// connector failures recorded as failures (not as "no evidence"), and a genuine system failure routed for technical review.
// TEST FIXTURES only; nothing here is a real source.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, login } from "./helpers.js";
import { validate, pickTwo, ACCEPT_RULES } from "../server/lib/autocomplete.js";
import { compare, assessClaim } from "../server/lib/autoeval.js";

let S, admin, user;
before(async () => { S = await startServer(); admin = await login(S.base, "admin"); user = S.ctx.db.prepare("SELECT * FROM users WHERE username = 'ana'").get(); });
after(async () => { await S.ctx.investigations.close(); await S.close(); });

const item = (o) => ({ claim_id: "CL-1", connector: "web", source_url: "https://www.nation.africa/x", retrieved_at: "2026-10-20T08:00:00Z", tier: "news", stance: "supports", relevance: 0.4, score: 0.5, ...o });
test("the evidence rules: each rule is documented and applied; at most two items per claim, one of each side when they conflict", () => {
  const P = new Set(["CL-1"]);
  assert.ok(Object.keys(ACCEPT_RULES).length >= 7);
  assert.equal(validate(item(), P).ok, true);
  assert.deepEqual(validate(item({ claim_id: "CL-9" }), P).failed, ["principal"]);
  assert.deepEqual(validate(item({ source_url: null }), P).failed, ["retrievable"]);
  assert.deepEqual(validate(item({ tier: "reference" }), P).failed, ["reliable"], "Wikipedia is not accepted");
  assert.deepEqual(validate(item({ tier: "earlier_case" }), P).failed, ["reliable"], "an earlier AIVS case is not accepted");
  assert.deepEqual(validate(item({ relevance: 0.05 }), P).failed, ["relevant"]);
  assert.deepEqual(validate(item({ repeat_of: "E-1" }), P).failed, ["independent"]);
  assert.equal(validate(item({ stance: "related", relevance: 0.3 }), P).stance, "context");
  assert.equal(validate(item({ connector: "factcheck", tier: "unknown", rating: "False", stance: "contradicts", relevance: 0 }), P).ok, true, "a published rating counts");
  assert.ok(validate(item({ read_error: "HTTP 403" }), P).notes.some(n => /could not be read/.test(n)), "a retrieval failure is recorded");
  const three = [item({ id: "a", score: 0.9 }), item({ id: "b", score: 0.8 }), item({ id: "c", score: 0.7, stance: "contradicts" })];
  assert.deepEqual(pickTwo(three).map(e => e.id).sort(), ["a", "c"]);
  assert.equal(pickTwo([item({ id: "a" }), item({ id: "b" }), item({ id: "d" })]).length, 2);
});

test("a claim the preliminary reading calls Supported, without accepted supporting evidence, is corrected; rationale, conclusion and uncertainties are written", async () => {
  const { cases, autocomplete, db } = S.ctx;
  const caseId = cases.create(user, { title: "TEST FIXTURE automatic completion", claim_text: "TEST FIXTURE: The county opened a new water project in Isiolo on 20 October 2026.", received_at: "2026-10-21T08:00:00Z", priority: "routine" });
  const c1 = cases.addClaim(user, caseId, { text: "The county opened a new water project in Isiolo on 20 October 2026" }), c2 = cases.addClaim(user, caseId, { text: "Thousands of residents attended the opening" });
  const c3 = cases.addClaim(user, caseId, { text: "Share this with everyone" });
  const ins = db.prepare("INSERT INTO evidence(id,case_id,kind,origin,status,text,reference,source_url,source_title,source_publisher,source_published_at,connector,retrieved_at,claim_id,created_by,created_at) VALUES (?,?,?,'retrieval','suggested',?,?,?,?,?,?,?,?,?,?,?)");
  const mk = (id, cl, url, title, pub) => ins.run(id, caseId, "source_claim", title, url, url, title, pub, "2026-10-20", "web", "2026-10-21T08:00:00Z", cl, user.id, "2026-10-21T08:00:00Z");
  mk("E-T1", c1, "https://en.wikipedia.org/wiki/Isiolo", "TEST FIXTURE Isiolo county water project opened", "Wikipedia");
  mk("E-T2", c1, "https://example-blog.test/isiolo", "TEST FIXTURE Isiolo county opened new water project 20 October", "blog");
  mk("E-T3", c2, "https://www.nation.africa/isiolo", "TEST FIXTURE Isiolo water project opening attended by residents", "Nation");
  const claims = db.prepare("SELECT * FROM claims WHERE case_id = ? ORDER BY seq").all(caseId).map(c => ({ ...c, claim_type: "factual" }));
  const ev = db.prepare("SELECT * FROM evidence WHERE case_id = ?").all(caseId).map(e => ({ ...e, snippet: e.text }));
  const compared = compare(claims.slice(0, 2), ev);
  const pre = claims.slice(0, 2).map(c => assessClaim(c, compared, true)); pre[0] = { ...pre[0], verdict: "supported", strength: "moderate", reason: "TEST: a preliminary reading of supported." };
  const out = autocomplete.complete(user, { caseId, claims: claims.slice(0, 2), otherClaims: [claims[2]], compared, assessments: pre, searched: true,
    connectors: [{ key: "web", label: "Web search (Brave)", status: "error", errors: ["HTTP 429 rate limited"], results: 0 }, { key: "news", label: "GDELT news index", status: "ok", results: 0 }], source: {}, aiState: { ok: false, reason: "AI not configured" } });
  const cl = db.prepare("SELECT * FROM claims WHERE case_id = ? ORDER BY seq").all(caseId), c = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId);
  assert.notEqual(cl[0].assessment, "supported", "never Supported without accepted supporting evidence"); assert.equal(cl[0].assessment, "insufficient");
  assert.ok(out.corrected.some(x => x.seq === 1 && x.from === "supported"));
  assert.match(cl[0].rationale, /^Observed: 2 items retrieved for this claim; 0 items accepted .*not from a reliable source type/); assert.match(cl[0].rationale, /corrected to “Insufficient evidence”/);
  assert.equal(cl[2].removed, 1); assert.match(cl[2].rationale, /not prioritised/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM evidence WHERE case_id = ? AND status = 'suggested'").get(caseId).n, 0);
  assert.equal(JSON.parse(db.prepare("SELECT validation FROM evidence WHERE id = 'E-T1'").get().validation).failed[0], "reliable");
  assert.ok(c.conclusion && c.conclusion_rationale && c.uncertainties); assert.match(c.conclusion_rationale, /Confidence: Low/);
  assert.match(c.uncertainties, /Web search \(Brave\) could not be searched \(connector error: HTTP 429 rate limited\); this is a system failure/);
  assert.match(c.uncertainties, /GDELT news index answered but returned no results/, "no results is recorded apart from an error");
  assert.match(c.uncertainties, /AI model was not available/);
  assert.equal(cases.readiness(caseId).ok, true, JSON.stringify(cases.readiness(caseId).problems));
});

test("a genuine system failure is recorded and routed for technical review; administrators are told; no result is invented", async () => {
  const ana = await login(S.base, "ana"), fd = new FormData(); fd.append("text", "TEST FIXTURE: The county opened a new water project in Isiolo on 20 October 2026.");
  const create = S.ctx.cases.create; S.ctx.cases.create = () => { throw new Error("TEST FIXTURE: database write failed (disk full)"); };   // a simulated storage failure
  const r = await ana.post("/api/investigations", undefined, { form: fd }); assert.equal(r.status, 202);
  let inv; for (let i = 0; i < 200; i++) { inv = (await ana.get(`/api/investigations/${r.body.id}`)).body; if (["done", "failed"].includes(inv.status)) break; await new Promise(ok => setTimeout(ok, 50)); }
  S.ctx.cases.create = create;
  assert.equal(inv.status, "failed"); assert.equal(inv.result, null, "no report is produced"); assert.match(inv.error, /disk full/);
  const tr = (await admin.get("/api/technical-reviews")).body; assert.ok(tr.items.some(t => t.ref_id === inv.id && /disk full/.test(t.error)), JSON.stringify(tr));
  assert.ok((await admin.get("/api/notifications")).body.items.some(n => n.kind === "technical_review" && n.link === `#/investigate/${inv.id}`));
  const t = tr.items.find(x => x.ref_id === inv.id);
  assert.equal((await ana.post(`/api/technical-reviews/${t.id}/resolve`, { resolution: "x" })).status, 403);
  assert.equal((await admin.post(`/api/technical-reviews/${t.id}/resolve`, { resolution: "Time limit raised; investigation started again." })).status, 200);
  assert.equal((await admin.get("/api/technical-reviews")).body.open, 0);
});

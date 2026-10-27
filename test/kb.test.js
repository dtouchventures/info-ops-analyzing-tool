// Dataset registry and knowledge base (AIVS 1.8): formats, licence records, de-duplication, leakage-free splits,
// approval by a second person, retrieval as cited suggestions, record review, synthetic data kept to training,
// and a measured retrieval baseline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, login } from "./helpers.js";
import { parseDataset, splitOf, toLabel } from "../server/lib/kb.js";

let S, admin, rev, ana, view;
before(async () => { S = await startServer(); [admin, rev, ana, view] = await Promise.all(["admin", "rev", "ana", "view"].map(u => login(S.base, u))); });
after(async () => { await S.close(); });
const B = s => Buffer.from(s);
const form = (content, fields = {}, name = "d.csv") => { const fd = new FormData(); fd.append("file", new Blob([content]), name); for (const [k, v] of Object.entries({ name: "Test fact-checks", license: "CC BY 4.0", permitted_use: "Research and internal reference", ...fields })) fd.append(k, v); return fd; };

test("formats: Google Fact Check JSON, ClaimReview, FEVER, LIAR, MultiFC and the CSV template", () => {
  const g = parseDataset(B(JSON.stringify({ claims: [{ text: "Lemon water cures malaria", claimant: "Posts", claimReview: [{ publisher: { name: "Africa Check" }, url: "https://africacheck.org/x", textualRating: "False", reviewDate: "2024-03-01T00:00:00Z", languageCode: "en" }] }] })));
  assert.equal(g.format, "google-factcheck"); assert.deepEqual([g.rows[0].publisher, g.rows[0].label_raw, g.rows[0].language], ["Africa Check", "False", "en"]);
  const c = parseDataset(B(JSON.stringify([{ "@type": "ClaimReview", claimReviewed: "KDF charges a recruitment fee", reviewRating: { alternateName: "Fake" }, url: "https://pesacheck.org/y", author: { name: "PesaCheck" }, datePublished: "2025-01-02" }])));
  assert.equal(c.format, "claimreview"); assert.equal(toLabel(c.rows[0].label_raw), "contradicted");
  const f = parseDataset(B('{"id": 1, "verifiable": "VERIFIABLE", "label": "SUPPORTS", "claim": "Nairobi is the capital of Kenya."}\n{"id": 2, "verifiable": "VERIFIABLE", "label": "REFUTES", "claim": "Mombasa is the capital of Kenya."}'));
  assert.equal(f.format, "fever"); assert.deepEqual(f.rows.map(r => toLabel(r.label_raw)), ["supported", "contradicted"]);
  const l = parseDataset(B("2635.json\tfalse\tSays the budget doubled.\teconomy\tspeaker\tjob\tstate\tparty\t0\t1\t0\t0\t0\ta speech\n10540.json\thalf-true\tSays crime fell by half.\tcrime\tx\ty\tz\tp\t0\t0\t1\t0\t0\tTV"));
  assert.equal(l.format, "liar"); assert.deepEqual(l.rows.map(r => toLabel(r.label_raw)), ["contradicted", "partially_supported"]);
  const m = parseDataset(B("pomt-00001\tSays taxes rose.\tmostly true\thttp://example.org/a\treason\tcat\tspeaker\tchecker\ttags\ttitle\t2016-01-01\tclimate\tentities"));
  assert.equal(m.format, "multifc"); assert.equal(m.rows[0].source_url, "http://example.org/a");
  const t = parseDataset(B("claim,label,url,publisher,date,language\n\"Shule zitafungwa Jumatatu\",Si kweli,https://example.org/z,Checker,2026-01-01,sw\n"));
  assert.equal(t.format, "aivs-csv"); assert.equal(toLabel(t.rows[0].label_raw), "contradicted");
  assert.throws(() => parseDataset(B("who,what\nx,y\n")), /claim and label columns/);
});

test("splits are deterministic by text, so duplicates can never cross between training and test", () => {
  const h = "ab12cd34" + "0".repeat(56); assert.equal(splitOf(h), splitOf(h));
  const all = Array.from({ length: 2000 }, (_, i) => splitOf(require_hash(String(i))));
  const share = k => all.filter(x => x === k).length / all.length;
  assert.ok(share("train") > 0.75 && share("train") < 0.85 && share("test") > 0.07 && share("test") < 0.13);
});
import crypto from "node:crypto";
function require_hash(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

test("registry: licence required, pending until a second person approves, then searched with citations", async () => {
  assert.equal((await view.post("/api/kb/datasets", undefined, { form: form("claim,label\nx,y\n") })).status, 403);
  const noLic = await admin.post("/api/kb/datasets", undefined, { form: form("claim,label\nLemon water cures malaria quickly,False\n", { license: "" }) }); assert.equal(noLic.status, 400); assert.match(noLic.body.error, /licence/);
  const csv = "claim,label,url,publisher,date,language\n\"Drinking hot lemon water cures malaria\",False,https://africacheck.org/lemon,Africa Check,2024-03-01,en\n\"Drinking hot lemon water cures malaria\",False,https://dup.example/x,Dup,2024-03-02,en\n\"Kenya census 2019 counted 47.6 million people\",True,https://example.org/census,Checker,2020-01-01,en\n";
  const imp = await admin.post("/api/kb/datasets", undefined, { form: form(csv) }); assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(imp.body.imported, 2); assert.equal(imp.body.duplicates, 1); assert.equal(imp.body.format, "aivs-csv");
  const id = imp.body.id;
  const c1 = await ana.post("/api/verify", { input: "Drinking hot lemon water cures malaria, a post says." });
  assert.equal(c1.body.search.connectors.find(x => x.connector === "kb").results, 0, "pending datasets are not searched");
  assert.equal((await admin.post(`/api/kb/datasets/${id}/approve`, {})).status, 403, "the importer cannot approve their own dataset");
  assert.equal((await rev.post(`/api/kb/datasets/${id}/approve`, {})).status, 200);
  const c2 = await ana.post("/api/verify", { input: "Drinking hot lemon water cures malaria, a post says." });
  const kbRow = c2.body.search.connectors.find(x => x.connector === "kb"); assert.equal(kbRow.results, 1);
  const ev = c2.body.evidence.find(e => e.connector === "kb"); assert.equal(ev.source_url, "https://africacheck.org/lemon"); assert.equal(ev.rating, "False");
  assert.equal(c2.body.claims[0].suggested_assessment, "contradicted", "a published verdict from an approved dataset can suggest a verdict");
  // review: removing the record takes it out of search
  const rec = (await rev.get(`/api/kb/datasets/${id}?q=lemon`)).body.records[0];
  assert.equal((await rev.patch(`/api/kb/records/${rec.id}`, { review_status: "removed" })).status, 400, "a reason is required");
  assert.equal((await rev.patch(`/api/kb/records/${rec.id}`, { review_status: "removed", note: "Wrong claim wording" })).status, 200);
  const c3 = await ana.post("/api/verify", { input: "Drinking hot lemon water cures malaria, a post says." });
  assert.equal(c3.body.search.connectors.find(x => x.connector === "kb").results, 0);
  const csvOut = await view.get(`/api/kb/datasets/${id}/records.csv`); assert.equal(csvOut.status, 200); assert.ok(!csvOut.body.includes("africacheck.org/lemon"), "removed records are not exported");
});

test("new versions retire the old one; synthetic practice data reaches training cases only", async () => {
  const a = await admin.post("/api/kb/datasets", undefined, { form: form("claim,label\n\"The bridge in Kisumu collapsed in 2025\",False\n", { name: "Versioned" }) });
  await rev.post(`/api/kb/datasets/${a.body.id}/approve`, {});
  const b = await admin.post("/api/kb/datasets", undefined, { form: form("claim,label\n\"The bridge in Kisumu collapsed in 2025\",Mostly false\n", { name: "Versioned" }) });
  assert.equal(b.body.version, 2); await rev.post(`/api/kb/datasets/${b.body.id}/approve`, {});
  const ds = (await view.get("/api/kb/datasets")).body.datasets; assert.equal(ds.find(x => x.id === a.body.id).status, "retired"); assert.equal(ds.find(x => x.id === b.body.id).status, "approved");
  const s = await admin.post("/api/kb/sample"); assert.equal(s.status, 201); await rev.post(`/api/kb/datasets/${s.body.id}/approve`, {});
  const op = await ana.post("/api/verify", { input: "KDF recruitment requires applicants to pay a registration fee by M-Pesa." });
  assert.ok(!op.body.evidence.some(e => /synthetic/i.test(e.source_publisher || "")), "synthetic records never reach operational cases");
  const tr = await ana.post("/api/verify", { input: "KDF recruitment requires applicants to pay a registration fee by M-Pesa.", is_training: true });
  assert.ok(tr.body.evidence.some(e => e.connector === "kb"), "but are offered on training cases");
});

test("evaluation: measured on the held-out test split against training records only", async () => {
  const topics = ["school closures in Garissa", "fuel price increase", "KDF recruitment fee", "lemon water malaria cure", "bridge collapse Kisumu", "water project funds", "census population figure", "flood photo Tana River", "election results Nakuru", "vaccine side effects"];
  const labels = ["False", "True", "Half true", "Missing context", "Unproven"]; let csv = "claim,label,language\n";
  for (let i = 0; i < 400; i++) { const t = topics[i % 10], lab = labels[(i % 10) % 5]; csv += `"Posts claim ${t} reported by account ${i} in county ${i % 7} this week",${lab},${i % 3 ? "en" : "sw"}\n`; }
  const r = await admin.post("/api/kb/datasets", undefined, { form: form(csv, { name: "Eval set" }) }); const id = r.body.id;
  assert.ok(r.body.splits.test >= 20 && r.body.splits.train >= 280, JSON.stringify(r.body.splits));
  const e = await admin.post(`/api/kb/datasets/${id}/evaluate`, {}); assert.equal(e.status, 200, JSON.stringify(e.body)); const m = e.body.metrics;
  assert.equal(m.test_records, r.body.splits.test); assert.ok(m.coverage >= 0 && m.coverage <= 1); assert.ok(m.accuracy_when_predicting > 0.5, `measured ${m.accuracy_when_predicting}`);
  assert.ok(m.per_class.contradicted && "f1" in m.per_class.contradicted); assert.ok(m.by_language.en && m.by_language.sw);
  const d = (await view.get(`/api/kb/datasets/${id}`)).body; assert.equal(d.evaluations.length, 1);
  const tiny = await admin.post("/api/kb/datasets", undefined, { form: form("claim,label\n\"One single short claim here\",False\n", { name: "Tiny" }) });
  assert.equal((await admin.post(`/api/kb/datasets/${tiny.body.id}/evaluate`, {})).status, 409);
});

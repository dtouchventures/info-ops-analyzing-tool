// Information operations monitor (AIVS 1.5): parsing, column detection, signal detection on planted
// patterns, false-alarm control on organic data, permissions, exports and audit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, login } from "./helpers.js";
import { parseCsv, detectMapping, analyse, normText, sampleDataset } from "../server/lib/io.js";

let S, ana, view, admin;
before(async () => { S = await startServer(); [ana, view, admin] = await Promise.all(["ana", "view", "admin"].map(u => login(S.base, u))); });
after(async () => { await S.close(); });
const form = (csv, fields = {}, name = "posts.csv") => { const fd = new FormData(); fd.append("file", new Blob([csv]), name); for (const [k, v] of Object.entries({ name: "Test set", source: "Unit test", authorisation: "Synthetic", ...fields })) fd.append(k, v); return fd; };
const post = (i, account, at, text, extra = {}) => ({ id: i, account, posted_at: new Date(at).toISOString(), text, hashtags: JSON.stringify((text.match(/#\w+/g) || []).map(x => x.toLowerCase())), urls: JSON.stringify(text.match(/https?:\/\/\S+/g) || []), mentions: "[]", ...extra });

test("CSV parser handles quotes, doubled quotes, embedded newlines and semicolons", () => {
  const r = parseCsv('﻿user;date;tweet\n"a";2026-01-01;"He said ""hi""; then left"\nb;2026-01-02;"line one\nline two"\n');
  assert.equal(r.length, 2); assert.equal(r[0].tweet, 'He said "hi"; then left'); assert.equal(r[1].tweet, "line one\nline two");
  const m = detectMapping(["Screen Name", "Created At", "Full Text", "Retweet Count"]);
  assert.deepEqual([m.account, m.posted_at, m.text, m.shares], ["Screen Name", "Created At", "Full Text", "Retweet Count"]);
  assert.equal(detectMapping(["a", "b", "c"], { text: "c", account: "a", posted_at: "b" }).text, "c", "manual choice wins");
});

test("planted synchronised message is found; genuine everyday posts give no false alarm", () => {
  const a = analyse(sampleDataset().map((r, i) => post(i + 1, r.account, r.posted_at, r.text, { platform: r.platform, repost_of: r.repost_of || null, account_created_at: r.account_created_at || null })));
  const sync = a.clusters.filter(c => c.synchronised);
  assert.equal(sync.length, 1, "exactly one synchronised message");
  assert.equal(sync[0].accounts, 14); assert.equal(sync[0].posts, 28); assert.equal(sync[0].variants, 3, "three wording variants grouped together"); assert.ok(sync[0].cross_platform);
  assert.ok(sync[0].sync.p_adjusted < 0.01);
  assert.ok(a.hashtags.find(h => h.tag === "#samplewaterscandal").bursts.length >= 1, "hashtag burst detected");
  assert.equal(a.hashtags.filter(h => /traffic|weather|sports|market/.test(h.tag)).flatMap(h => h.bursts).length, 0, "no bursts on everyday hashtags");
  assert.equal(a.links[0].max_accounts_in_window, 14);
  assert.equal(a.amplification[0].of, "county_events_sample"); assert.equal(a.amplification[0].reposts, 40);
  assert.ok(a.network.nodes.every(n => n.id.startsWith("newvoice_")), "network contains only the coordinated accounts");
  assert.ok(a.accounts.slice(0, 14).every(x => x.new_account), "new accounts are marked");
});

test("a common slogan spread over days is a repeated message but not synchronised", () => {
  const P = []; for (let i = 0; i < 30; i++) P.push(post(i, `fan${i}`, Date.UTC(2026, 0, 1) + i * 7 * 3600e3, "Happy new year to everyone in the county, stay safe"));
  const a = analyse(P); assert.equal(a.clusters.length, 1); assert.equal(a.clusters[0].synchronised, false); assert.equal(a.network.nodes.length, 0);
});

test("normalisation ignores links, mentions and punctuation", () => {
  assert.equal(normText("Demand answers NOW!!! @someone https://x.org/a"), "demand answers now");
});

test("import: required provenance, permissions, column errors, skipped rows, analysis and audit", async () => {
  const csv = "username,created_at,text\nalice,2026-01-01T10:00:00Z,Hello there everyone\nbob,not-a-date,Hi\n,2026-01-01T10:05:00Z,No account\ncarol,2026-01-01T10:06:00Z,\n";
  assert.equal((await view.post("/api/io/datasets", undefined, { form: form(csv) })).status, 403, "viewers cannot import");
  const noBasis = await ana.post("/api/io/datasets", undefined, { form: form(csv, { authorisation: "" }) });
  assert.equal(noBasis.status, 400); assert.match(noBasis.body.error, /basis/);
  const badCols = await ana.post("/api/io/datasets", undefined, { form: form("who,when,what\nx,2026-01-01,y\n") });
  assert.equal(badCols.status, 400); assert.match(badCols.body.error, /Could not find a column/);
  const jpg = await ana.post("/api/io/datasets", undefined, { form: form(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), {}, "photo.jpg") });
  assert.equal(jpg.status, 400); assert.match(jpg.body.error, /picture, not a list of posts/, "an image gets a clear explanation");
  const xl = await ana.post("/api/io/datasets", undefined, { form: form(new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 6, 0]), {}, "posts.xlsx") });
  assert.match(xl.body.error, /Save As/);
  const ok = await ana.post("/api/io/datasets", undefined, { form: form(csv) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.imported, 1); assert.deepEqual(ok.body.skipped, { no_text: 1, no_account: 1, bad_date: 1 });
  const mapped = await ana.post("/api/io/datasets", undefined, { form: form("who,when,what\nx,2026-01-01T00:00:00Z,some words here\n", { map_account: "who", map_posted_at: "when", map_text: "what" }) });
  assert.equal(mapped.status, 201, "manual column choice works");
  const json = await ana.post("/api/io/datasets", undefined, { form: form(JSON.stringify({ data: [{ author: { username: "dan" }, created_at: "2026-01-02T00:00:00Z", text: "nested json works #tag" }] }), {}, "x.json") });
  assert.equal(json.status, 201, JSON.stringify(json.body));
  const audit = S.ctx.db.prepare("SELECT action FROM audit_log WHERE entity = 'io_dataset'").all().map(r => r.action);
  assert.ok(audit.some(a => a.startsWith("Post dataset imported")) && audit.some(a => a === "Post dataset analysed"));
});

test("sample dataset: view, re-analyse with settings, posts filter, exports, case from message, delete", async () => {
  const s = await ana.post("/api/io/sample"); assert.equal(s.status, 201); const id = s.body.id;
  const d = (await view.get(`/api/io/datasets/${id}`)).body; assert.equal(d.dataset.is_sample, 1); assert.ok(d.analysis.summary.synchronised_clusters >= 1);
  const c1 = d.analysis.clusters.find(c => c.synchronised);
  const ps = (await view.get(`/api/io/datasets/${id}/posts?cluster=${c1.id}`)).body; assert.equal(ps.total, c1.posts);
  const re = await ana.post(`/api/io/datasets/${id}/analyse`, { window_min: 60, min_similarity: 0.9 }); assert.equal(re.body.analysis.params.window_min, 60);
  assert.equal((await view.post(`/api/io/datasets/${id}/analyse`, {})).status, 403);
  assert.equal((await view.get(`/api/io/datasets/${id}/posts?account=newvoice_01`)).body.total, 2);
  const csv = await view.get(`/api/io/datasets/${id}/signals.csv`); assert.equal(csv.status, 200); assert.match(csv.body, /"repeated_message"/); assert.match(csv.body, /"caveat"/);
  const js = await view.get(`/api/io/datasets/${id}/signals.json`); assert.equal(js.body.dataset.sample, true);
  const re2 = await ana.post(`/api/io/datasets/${id}/analyse`, {}); const cid = re2.body.analysis.clusters.find(c => c.synchronised).id;
  const kc = await ana.post(`/api/io/datasets/${id}/clusters/${cid}/case`); assert.equal(kc.status, 201); assert.match(kc.body.id, /^TR-/, "a case from synthetic data is a training case");
  assert.equal((await ana.del(`/api/io/datasets/${id}`)).status, 403, "only administrators delete datasets");
  assert.equal((await admin.del(`/api/io/datasets/${id}`)).status, 200);
  assert.equal((await view.get(`/api/io/datasets/${id}`)).status, 404);
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM io_posts WHERE dataset_id = ?").get(id).n, 0);
  assert.equal((await view.get(`/api/cases/${kc.body.id}`)).status, 200, "the case survives deletion of the dataset");
});

test("performance: 50,000 posts analyse in reasonable time", () => {
  let x = 9; const r = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const V = "road water rain market school price power match lake ward debate fees bus fuel maize tea sugar milk".split(" "), P = [];
  for (let i = 0; i < 50000; i++) P.push(post(i, `u${Math.floor(r() * 9000)}`, Date.UTC(2026, 0, 1) + Math.floor(r() * 20 * 864e5), Array.from({ length: 10 }, () => V[Math.floor(r() * V.length)]).join(" ")));
  const t = Date.now(), a = analyse(P); const ms = Date.now() - t;
  assert.ok(ms < 30000, `took ${ms} ms`); assert.equal(a.summary.synchronised_clusters, 0, "random text gives no synchronised messages");
});

test("post screenshots: account, time and text are read from OCR text, with the basis stated", async () => {
  const { parsePostScreenshot, findPostTime } = await import("../shared/text.js");
  const fb = parsePostScreenshot("Kenya News Updates\nOctober 21 at 3:45 PM ·\nFunds have disappeared #WaterScandal\n1.2K\n45 comments 12 shares\nLike Comment Share", { fileTime: Date.UTC(2026, 9, 22) });
  assert.equal(fb.account, "kenya news updates"); assert.equal(fb.text, "Funds have disappeared #WaterScandal"); assert.equal(fb.platform, "Facebook"); assert.match(fb.time_basis, /year assumed/); assert.equal(fb.time_exact, false);
  const x = parsePostScreenshot("Jane Doe\n@janedoe_ke\nSchools close tomorrow. Share widely!\n3:45 PM · Oct 21, 2026\n12K Views\n45 Reposts 3 Quotes 120 Likes");
  assert.equal(x.account, "janedoe_ke"); assert.equal(x.platform, "X (Twitter)"); assert.equal(x.time_exact, true); assert.equal(x.text, "Schools close tomorrow. Share widely!");
  const sw = parsePostScreenshot("Mwananchi Forum\n2h ·\nSerikali imetangaza nafasi za kazi\nPenda\nToa maoni\nShiriki", { fileTime: Date.UTC(2026, 9, 22, 9) });
  assert.equal(sw.platform, "Facebook"); assert.equal(sw.posted_at, "2026-10-22T07:00:00.000Z"); assert.match(sw.time_basis, /approximate/);
  assert.equal(parsePostScreenshot("Just some words without a time").posted_at, null, "no time is invented");
  assert.equal(findPostTime("21/10/2026 15:45").at.getDate(), 21, "numeric dates are read day first");
});

test("adding posts to a dataset: duplicates skipped, analysis re-run, sample and viewers refused", async () => {
  const c1 = "account,posted_at,text\nkenya news,2026-10-21T12:45:00Z,The water project funds have disappeared demand answers now\ncounty voices,2026-10-21T12:47:00Z,The water project funds have disappeared demand answers now\n";
  const r = await ana.post("/api/io/datasets", undefined, { form: form(c1) }); assert.equal(r.status, 201);
  assert.equal(r.body.summary.synchronised_clusters, 0, "two posts are not enough");
  const c2 = c1 + "nairobi daily,2026-10-21T12:46:00Z,\"The water project funds have disappeared, demand answers now!\"\n";
  const fd = new FormData(); fd.append("file", new Blob([c2]), "more.csv"); fd.append("note", "second batch");
  const a = await ana.post(`/api/io/datasets/${r.body.id}/add`, undefined, { form: fd });
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.imported, 1); assert.equal(a.body.duplicates, 2);
  assert.equal(a.body.summary.posts, 3); assert.equal(a.body.summary.synchronised_clusters, 1, "three accounts within minutes are now a signal");
  const d = (await view.get(`/api/io/datasets/${r.body.id}`)).body.dataset; assert.equal(d.posts, 3); assert.match(d.description, /second batch/);
  const fd2 = new FormData(); fd2.append("file", new Blob([c2]), "more.csv");
  assert.equal((await view.post(`/api/io/datasets/${r.body.id}/add`, undefined, { form: fd2 })).status, 403);
  const s = await ana.post("/api/io/sample"); const fd3 = new FormData(); fd3.append("file", new Blob([c2]), "more.csv");
  assert.equal((await ana.post(`/api/io/datasets/${s.body.id}/add`, undefined, { form: fd3 })).status, 400, "the synthetic sample stays as it is");
});

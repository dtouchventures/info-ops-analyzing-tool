// AI Watchlist on imported datasets (AIVS 1.21): the full workflow on the SYNTHETIC election dataset with planted
// patterns. Create → activate → import → automatic check → alerts that point at the records that caused them →
// no duplicates → acknowledge / dismiss → send a claim to Information Verification → analytics → delete.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer, login } from "./helpers.js";
import { watchDemoRows } from "../server/lib/watch-demo.js";

let S, rev, ana, wid, dsId, alerts;
const DAY = (d, h = 0) => Date.parse("2026-10-01T00:00:00Z") + (d - 1) * 864e5 + h * 3600e3;
before(async () => { S = await startServer({ watch: { enabled: false } }); rev = await login(S.base, "rev"); ana = await login(S.base, "ana"); });
after(async () => { await S.close(); });
const post = id => S.ctx.db.prepare("SELECT * FROM watch_posts WHERE id = ?").get(id);

test("demo data: exactly 1,000 posts, deterministic, with the planted patterns at known times", () => {
  const a = watchDemoRows(), b = watchDemoRows();
  assert.equal(a.length, 1000); assert.deepEqual(a, b);
  assert.equal(a.filter(r => r.account.startsWith("truth_teller_")).length, 12);
  assert.ok(a.filter(r => /burned|chomwa/.test(r.text) && Date.parse(r.posted_at) >= DAY(6, 14) && Date.parse(r.posted_at) < DAY(6, 16)).length >= 60);
});

test("create, edit, save and reload a watchlist that monitors imported datasets; analysts cannot manage it", async () => {
  assert.equal((await ana.post("/api/watch/lists", { name: "x", definition: { terms: ["IEBC"] } })).status, 403);
  assert.equal((await rev.post("/api/watch/lists", { name: "Election", definition: { terms: [] } })).status, 400, "at least one term");
  const c = await rev.post("/api/watch/lists", { name: "Election Misinformation", description: "Election claims in imported datasets", definition: { terms: ["election", "IEBC", "voting", "ballot"], all_datasets: true, alert_mode: "signals_only", thresholds: { count_min_posts: 10, count_window_min: 60 } } });
  assert.equal(c.status, 201); wid = c.body.id;
  const ed = await rev.patch(`/api/watch/lists/${wid}`, { description: "Election claims (edited)", definition: { terms: ["election", "IEBC", "voting", "ballot", "ballot boxes"], exclude: ["football"], all_datasets: true, alert_mode: "signals_only", thresholds: { count_min_posts: 10, count_window_min: 60 } } });
  assert.equal(ed.status, 200);
  const g = (await rev.get(`/api/watch/lists/${wid}`)).body.watchlist;
  assert.equal(g.description, "Election claims (edited)"); assert.equal(g.definition.all_datasets, true); assert.ok(g.definition.terms.includes("ballot boxes")); assert.equal(g.definition.thresholds.count_min_posts, 10);
  assert.equal((await rev.post(`/api/watch/lists/${wid}/status`, { status: "active" })).status, 409, "preview first");
  const pv = await rev.post(`/api/watch/lists/${wid}/preview`, { samples: "IEBC says tallying will be streamed live\nGreat football match" }); assert.equal(pv.status, 200);
  assert.equal(pv.body.local.samples[0].matched, true); assert.equal(pv.body.local.samples[1].matched, false);
  const act = await rev.post(`/api/watch/lists/${wid}/status`, { status: "active" });
  assert.equal(act.status, 200, JSON.stringify(act.body)); assert.equal(act.body.status, "active", "a dataset-only watchlist needs no platform credentials or collection basis");
});

test("empty and invalid files are refused with a clear message; nothing is monitored from them", async () => {
  const empty = new FormData(); empty.append("file", new Blob(["text,account,posted_at\n"]), "empty.csv"); for (const [k, v] of Object.entries({ name: "Empty", source: "test", authorisation: "test" })) empty.append(k, v);
  const e = await ana.post("/api/io/datasets", undefined, { form: empty }); assert.equal(e.status, 400, JSON.stringify(e.body));
  const bad = new FormData(); bad.append("file", new Blob([Buffer.from([0, 1, 2, 3, 255, 254])]), "posts.xlsx"); for (const [k, v] of Object.entries({ name: "Bad", source: "test", authorisation: "test" })) bad.append(k, v);
  assert.equal((await ana.post("/api/io/datasets", undefined, { form: bad })).status, 400);
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_matches").get().n, 0);
});

test("uploading a CSV dataset checks it automatically and raises alerts that correspond to the planted records", async () => {
  // the analyst uploads the CSV file (training/watch-demo-posts.csv: the same 1,000 synthetic posts)
  const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync("training/watch-demo-posts.csv")]), "watch-demo-posts.csv");
  for (const [k, v] of Object.entries({ name: "SYNTHETIC election posts (CSV upload)", source: "AIVS synthetic demo data", authorisation: "synthetic data for testing" })) fd.append(k, v);
  const r = await ana.post("/api/io/datasets", undefined, { form: fd }); assert.equal(r.status, 201, JSON.stringify(r.body)); dsId = r.body.id; assert.equal(r.body.imported, 1000);
  const w = r.body.watchlists.find(x => x.watchlist_id === wid);
  assert.ok(w, "the active watchlist checked the new dataset"); assert.equal(w.checked, 1000); assert.ok(w.matched > 100 && w.matched < 1000, `matched ${w.matched}`); assert.ok(w.alerts >= 3);
  const matched = S.ctx.db.prepare("SELECT p.text FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ?").all(wid);
  assert.ok(matched.every(p => /election|iebc|voting|ballot/i.test(p.text)), "every matched post contains a term"); assert.ok(!matched.some(p => /football/i.test(p.text)), "exclusions are applied");
  alerts = (await ana.get(`/api/watch/alerts?watchlist=${wid}&status=all&limit=100`)).body.alerts;
  if (process.env.SHOW_ALERTS) for (const a of alerts) console.log(a.kind, a.severity, a.title, process.env.SHOW_ALERTS === "2" ? a.reason : "");
  const kinds = new Set(alerts.map(a => a.kind)); for (const k of ["volume", "threshold", "coordination", "repeated", "narrative"]) assert.ok(kinds.has(k), `a ${k} alert`);
  assert.ok(!alerts.some(a => a.kind === "match"), "signals only: no alert per post");
  // unusual rises only where something was planted: day 6 from 14:00, and the synchronised burst on day 5 at 10:00
  for (const v of alerts.filter(a => a.kind === "volume")) { const t = Date.parse(v.detail.window_start); assert.ok((t >= DAY(6, 13) && t < DAY(6, 17)) || (t >= DAY(5, 9) && t < DAY(5, 11)), `volume alert at ${v.detail.window_start}`); assert.equal(v.detail.mode, "historical"); assert.match(v.reason, /Historical dataset analysis/); }
  assert.ok(alerts.some(a => a.kind === "volume" && Date.parse(a.detail.window_start) >= DAY(6, 13)), "the day-6 rise is found");
  const vol = alerts.filter(a => a.kind === "volume").find(a => Date.parse(a.detail.window_start) >= DAY(6, 13)); assert.equal(vol.severity, "high"); assert.ok(vol.detail.post_ids.map(post).every(p => /burned|ballot|chomwa/i.test(p.text)) || vol.detail.post_ids.map(post).filter(p => /burned/i.test(p.text)).length > vol.detail.post_ids.length / 2);
  // coordination: the 12 synchronised accounts, within 6 minutes, presented as a signal
  const co = alerts.find(a => a.kind === "coordination"); assert.equal(co.detail.accounts, 12); assert.ok(co.detail.span_minutes <= 6); assert.equal(co.severity, "high");
  assert.ok(co.detail.post_ids.map(post).every(p => p.account.startsWith("truth_teller_"))); assert.ok(co.detail.shared_hashtags.includes("#electiontruth")); assert.match(co.reason, /not evidence of coordinated manipulation/);
  // the emerging narrative is the burned ballot boxes story, with representative posts
  const nar = alerts.find(a => a.kind === "narrative"); assert.ok(nar.detail.terms.some(t => /burn/.test(t)), nar.detail.terms.join(","));
  assert.ok(nar.detail.post_ids.map(post).filter(p => /burned|chomwa/i.test(p.text)).length >= nar.detail.post_ids.length * 0.8);
  // no false alarms on the ordinary background: every alert's supporting posts lie in a planted period
  const planted = t => (t >= DAY(5, 9) && t < DAY(5, 11)) || (t >= DAY(6, 13) && t < DAY(6, 17));
  for (const a of alerts) { const ps = a.detail.post_ids.map(post), inP = ps.filter(p => planted(Date.parse(p.posted_at))).length; assert.ok(inP >= 0.8 * ps.length, `${a.kind} alert “${a.title}” is outside the planted periods`); }
  for (const a of alerts) { assert.ok(["low", "medium", "high"].includes(a.severity)); assert.ok(a.detail.recommended_action); assert.ok(a.detail.post_ids?.length); for (const id of a.detail.post_ids) assert.ok(post(id), "supporting posts exist"); }
  // alert details list the supporting posts
  const d = (await ana.get(`/api/watch/alerts/${co.id}`)).body; assert.equal(d.related.length, co.detail.post_ids.length);
});

test("no duplicate processing and no duplicate alerts: analysing again and re-importing add nothing", async () => {
  const n0 = S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_alerts").get().n, m0 = S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_matches").get().n;
  const again = await rev.post(`/api/watch/lists/${wid}/analyse`, {}); assert.equal(again.status, 200);
  assert.equal(again.body.scans[0].checked, 0, "posts already checked are not checked again"); assert.equal(again.body.analysis.total, 0);
  await ana.post("/api/io/watch-demo", {});   // the same posts imported again as a second dataset: same platform post IDs
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_matches").get().n, m0, "the same posts are not matched twice");
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_alerts").get().n, n0);
});

test("analytics: trends, sentiment, top terms, narratives and alert history computed from the matched posts", async () => {
  const a = (await rev.get(`/api/watch/lists/${wid}/analytics`)).body, n = S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_matches WHERE watchlist_id = ?").get(wid).n;
  assert.equal(a.posts, n); assert.equal(a.trend.points.reduce((s, p) => s + p.n, 0), n);
  assert.equal(Object.values(a.sentiment.counts).reduce((s, v) => s + v, 0), n); assert.ok(!a.sentiment.counts["not classified"], "every matched post has a tone label");
  assert.ok(a.top_terms[0].count > 0); assert.ok(a.narratives.topics.length >= 2); assert.ok(a.narratives.topics.every(t => t.examples.length));
  assert.ok(a.volume.spikes.length >= 1); assert.equal(a.alerts.recent.length, Math.min(20, alerts.length)); assert.match(a.note, /not on live monitoring/);
  const ov = (await rev.get("/api/watch/overview")).body; assert.equal(ov.stats.monitored_posts, n); assert.ok(ov.stats.recent_scans.length >= 1); assert.ok(ov.severity_rules.volume);
});

test("acknowledge, dismiss (reason required), and send a claim from an alert to Information Verification", async () => {
  const thr = alerts.find(a => a.kind === "threshold"), rep = alerts.find(a => a.kind === "repeated"), vol = alerts.find(a => a.kind === "volume");
  assert.equal((await ana.post(`/api/watch/alerts/${thr.id}/action`, { action: "acknowledge" })).status, 200);
  assert.equal((await ana.post(`/api/watch/alerts/${rep.id}/action`, { action: "dismiss" })).status, 400);
  assert.equal((await ana.post(`/api/watch/alerts/${rep.id}/action`, { action: "dismiss", note: "Already covered by the coordination alert" })).status, 200);
  assert.equal((await ana.post(`/api/watch/alerts/${vol.id}/action`, { action: "convert" })).status, 400, "a volume alert needs the claim chosen");
  const claim = S.ctx.db.prepare("SELECT text FROM watch_posts WHERE id = ?").get(vol.detail.post_ids[0]).text;
  const cv = await ana.post(`/api/watch/alerts/${vol.id}/action`, { action: "convert", claim_text: claim }); assert.equal(cv.status, 200, JSON.stringify(cv.body));
  const c = (await ana.get(`/api/cases/${cv.body.case_id}`)).body;
  assert.equal(c.case.claim_text, claim); assert.match(c.case.title, /^AI Watchlist/);
  const lead = c.evidence.find(e => e.kind === "lead" && /AI Watchlist alert/.test(e.text)); assert.ok(lead, "the alert is a suggested lead in the case"); assert.equal(lead.status, "suggested");
  assert.match(lead.text, /high severity|medium severity/); assert.equal((await ana.get(`/api/watch/alerts/${vol.id}`)).body.status, "converted");
});

test("pause stops automatic checks; delete hides the watchlist, keeps its history and closes open alerts", async () => {
  assert.equal((await rev.post(`/api/watch/lists/${wid}/status`, { status: "paused" })).status, 200);
  const r = await ana.post("/api/io/watch-demo", {}); assert.ok(!(r.body.watchlists || []).some(x => x.watchlist_id === wid), "a paused watchlist does not check new imports");
  assert.equal((await ana.del(`/api/watch/lists/${wid}`)).status, 403);
  assert.equal((await rev.del(`/api/watch/lists/${wid}`)).status, 200);
  assert.ok(!(await rev.get("/api/watch/overview")).body.watchlists.some(w => w.id === wid));
  const left = S.ctx.db.prepare("SELECT status, COUNT(*) n FROM watch_alerts WHERE watchlist_id = ? GROUP BY status").all(wid);
  assert.ok(!left.some(x => x.status === "new" || x.status === "acknowledged")); assert.ok(left.some(x => x.status === "converted"), "the converted alert keeps its link to the case");
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity = 'watchlist' AND entity_id = ? AND action = 'Watchlist deleted'").get(String(wid)).n === 1);
});

// AIVS 1.21.1: the dashboard figures for the AI Watchlist come from stored records. On a fresh server:
// 0 active watchlists and 0 open alerts → create (still 0) → activate (1) → import posts that match NOTHING
// (alerts stay 0, posts are counted as checked) → import the labelled SYNTHETIC dataset with matching posts and a spike
// (alerts rise, each saved in watch_alerts) → the monitoring status reports the last successful analysis.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer, login } from "./helpers.js";

let S, rev, ana;
before(async () => { S = await startServer({ watch: { enabled: false } }); rev = await login(S.base, "rev"); ana = await login(S.base, "ana"); });
after(async () => { await S.close(); });

// the same two figures the dashboard shows, computed exactly as public/js/pages/home.js computes them
const figures = async () => {
  const ov = (await ana.get("/api/watch/overview")).body;
  return { ov, active: ov.watchlists.filter(w => w.status === "active").length, open: (ov.alert_counts.new || 0) + (ov.alert_counts.acknowledged || 0) };
};
const upload = async (name, csv) => {
  const fd = new FormData(); fd.append("file", new Blob([csv]), `${name}.csv`);
  for (const [k, v] of Object.entries({ name, source: "AIVS synthetic test data", authorisation: "synthetic data for testing" })) fd.append(k, v);
  return ana.post("/api/io/datasets", undefined, { form: fd });
};

test("the client and the package carry the same version, so a stale server is detectable", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  assert.match(fs.readFileSync("public/js/app.js", "utf8"), new RegExp(`CLIENT_VERSION = "${pkg.replace(/\./g, "\\.")}"`));
});

test("dashboard counters follow the database: 0 → 1 on activation; alerts rise only when a real alert is raised", async () => {
  let f = await figures();
  assert.equal(f.active, 0); assert.equal(f.open, 0);
  assert.equal(f.ov.stats.monitoring.active_watchlists, 0); assert.equal(f.ov.stats.monitoring.last_successful_analysis, null);

  const c = await rev.post("/api/watch/lists", { name: "TEST Election watchlist", definition: { terms: ["election", "IEBC", "ballot"], all_datasets: true, alert_mode: "signals_only", thresholds: { count_min_posts: 10, count_window_min: 60 } } });
  assert.equal(c.status, 201);
  f = await figures(); assert.equal(f.active, 0, "a draft is not active"); assert.equal(f.open, 0);

  await rev.post(`/api/watch/lists/${c.body.id}/preview`, { samples: "IEBC update" });
  assert.equal((await rev.post(`/api/watch/lists/${c.body.id}/status`, { status: "active" })).status, 200);
  f = await figures(); assert.equal(f.active, 1, "active watchlists 0 → 1"); assert.equal(f.open, 0, "activation alone raises no alert");
  assert.equal(f.ov.stats.monitoring.active_watchlists, 1);
  assert.deepEqual(f.ov.stats.monitoring.live_sources_connected, [], "a dataset-only watchlist uses no live platform, so none is reported as connected");

  // posts that do not match: checked, nothing matched, no alert
  const rows = ["text,account,posted_at", ...Array.from({ length: 30 }, (_, i) => `Great football match tonight number ${i},fan_${i},2026-10-0${1 + (i % 5)}T1${i % 10}:00:00Z`)].join("\n");
  const u1 = await upload("SYNTHETIC non-matching posts", rows); assert.equal(u1.status, 201, JSON.stringify(u1.body));
  const w1 = u1.body.watchlists.find(x => x.watchlist_id === c.body.id); assert.equal(w1.checked, 30); assert.equal(w1.matched, 0); assert.equal(w1.alerts, 0);
  f = await figures(); assert.equal(f.open, 0, "no match, no alert");
  const m1 = f.ov.stats.monitoring; assert.equal(m1.posts_checked, 30); assert.equal(m1.posts_matched, 0); assert.ok(m1.last_successful_analysis, "the analysis time is recorded");

  // the labelled synthetic dataset with matching posts and a planted activity spike
  const u2 = await upload("SYNTHETIC election posts with a planted spike", fs.readFileSync("training/watch-demo-posts.csv"));
  assert.equal(u2.status, 201, JSON.stringify(u2.body));
  const w2 = u2.body.watchlists.find(x => x.watchlist_id === c.body.id); assert.ok(w2.matched > 100 && w2.alerts > 0, JSON.stringify(w2));
  f = await figures();
  const saved = S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_alerts WHERE watchlist_id = ? AND status IN ('new','acknowledged')").get(c.body.id).n;
  assert.equal(f.open, saved, "the open-alert figure equals the alerts saved in the database"); assert.equal(f.open, w2.alerts);
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_alerts WHERE watchlist_id = ? AND kind = 'volume'").get(c.body.id).n >= 1, "the spike raised an unusual-spike alert");
  assert.equal(f.ov.stats.monitoring.posts_checked, 1030); assert.equal(f.ov.stats.monitoring.posts_matched, w2.matched);

  // analysing again adds nothing
  const again = await rev.post(`/api/watch/lists/${c.body.id}/analyse`, {});
  assert.ok([200, 201].includes(again.status), JSON.stringify(again.body));
  assert.equal((await figures()).open, f.open, "re-analysis does not inflate the alert count");

  // pausing takes it out of the active figure
  await rev.post(`/api/watch/lists/${c.body.id}/status`, { status: "paused" });
  assert.equal((await figures()).active, 0);
});

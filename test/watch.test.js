// KDF Mention Watch: matching, preview before activation, scheduled collection (X recent search, YouTube, news feeds)
// with pagination, duplicates, retries, rate limits, refusals, daily limits and restart recovery; the X filtered
// stream (rules, heartbeats, reconnection, stalls, gap recovery); alerts and their actions. External services are
// stand-ins on this computer that answer in the documented formats; nothing here reaches the internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, reopenServer, login } from "./helpers.js";
import { matchPost, normaliseDefinition, xQuery, youtubeQuery, similarity, kdfTemplate } from "../server/lib/watch.js";

// ---- stand-in for the X API, YouTube and a news feed
const X = { calls: [], search: [], rules: [], ruleSeq: 100, mode: "ok", fail503: 0, streamPlan: [], streamConns: 0, lookups: 0, likes: 5 };
let fake, F;
const tweet = (id, text, user, at, extra = {}) => ({ id: String(id), text, author_id: `u-${user}`, created_at: at, lang: "en", public_metrics: { like_count: 1, reply_count: 0, retweet_count: 0, quote_count: 0, impression_count: 50 }, ...extra });
const users = ids => ids.map(u => ({ id: `u-${u}`, username: u, name: u.toUpperCase() }));
before(async () => {
  fake = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), json = (st, b, h = {}) => { res.writeHead(st, { "content-type": "application/json", ...h }); res.end(JSON.stringify(b)); };
    let body = ""; for await (const c of req) body += c;
    X.calls.push(`${req.method} ${u.pathname}${u.search}`);
    if (u.pathname === "/x/2/tweets/search/recent") {
      if (req.headers.authorization !== "Bearer test-x") return json(401, { title: "Unauthorized", detail: "Unauthorized" });
      if (X.mode === "auth") return json(403, { title: "Client Forbidden", detail: "This app has no credit" });
      if (X.mode === "rate") return json(429, { title: "Too Many Requests" }, { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 600), "x-rate-limit-remaining": "0" });
      if (X.fail503 > 0) { X.fail503--; return json(503, { title: "Service Unavailable" }); }
      X.search.push(Object.fromEntries(u.searchParams));
      const page = u.searchParams.get("next_token") === "p2" ? 2 : 1, since = u.searchParams.get("since_id");
      if (since === "1003") return json(200, { meta: { result_count: 0 } });
      if (page === 1) return json(200, { data: [tweet(1003, "KDF soldiers rebuilt the Garissa bridge after the floods, residents say", "amina", "2026-10-26T07:58:00Z"), tweet(1002, "Kenya Defence Forces open recruitment next week, check the official site", "brian", "2026-10-26T07:50:00Z"), tweet(1001, "My KDF file will not open in the viewer", "carol", "2026-10-26T07:40:00Z")],
        includes: { users: users(["amina", "brian", "carol"]) }, meta: { newest_id: "1003", next_token: "p2", result_count: 3 } });
      return json(200, { data: [tweet(1000, "Wanajeshi wa KDF wamesaidia wakazi wa Garissa baada ya mafuriko", "daudi", "2026-10-26T07:30:00Z", { lang: "sw" }), tweet(999, "RT @amina: KDF soldiers rebuilt the bridge", "eve", "2026-10-26T07:20:00Z", { referenced_tweets: [{ type: "retweeted", id: "1003" }] })],
        includes: { users: users(["daudi", "eve"]) }, meta: { result_count: 2 } });
    }
    if (u.pathname === "/x/2/tweets") { X.lookups++; X.likes += 400; return json(200, { data: u.searchParams.get("ids").split(",").map(id => ({ ...tweet(id, "x", "amina", "2026-10-26T07:58:00Z"), public_metrics: { like_count: X.likes, reply_count: 10, retweet_count: 30, quote_count: 0, impression_count: 90000 } })), includes: { users: users(["amina"]) } }); }
    if (u.pathname === "/x/2/tweets/search/stream/rules") {
      if (req.method === "GET") return json(200, { data: X.rules, meta: { result_count: X.rules.length } });
      const b = JSON.parse(body || "{}");
      if (u.searchParams.get("dry_run") === "true") return json(200, b.add[0].value.length > 1024 ? { errors: [{ title: "Invalid Rule", details: ["too long"] }], meta: { summary: { valid: 0 } } } : { meta: { summary: { valid: 1, invalid: 0 } } });
      if (b.delete) X.rules = X.rules.filter(r => !b.delete.ids.includes(r.id));
      if (b.add) for (const a of b.add) X.rules.push({ id: String(++X.ruleSeq), ...a });
      return json(200, { meta: { summary: { created: b.add?.length || 0 } } });
    }
    if (u.pathname === "/x/2/tweets/search/stream") {
      X.streamConns++; const plan = X.streamPlan.shift() || "hold";
      if (plan === "401") return json(401, { title: "Unauthorized" });
      if (plan === "503") return json(503, { title: "Service Unavailable" });
      res.writeHead(200, { "content-type": "application/json" });
      const tag = X.rules.find(r => r.tag.startsWith("aivs-wl-"))?.tag;
      res.write("\r\n");
      if (plan === "posts" || plan === "posts-close") {
        res.write(JSON.stringify({ data: tweet(2001, "KDF convoy seen near Mandera this morning", "fatma", new Date().toISOString()), includes: { users: users(["fatma"]) }, matching_rules: [{ id: "1", tag }] }) + "\r\n");
        res.write(JSON.stringify({ data: tweet(2002, "Unrelated post from another rule", "gina", new Date().toISOString()), includes: { users: users(["gina"]) }, matching_rules: [{ id: "9", tag: "someone-else" }] }) + "\r\n");
      }
      if (plan === "posts-close") return setTimeout(() => res.end(), 50);
      if (plan === "stall") return;   // headers sent, then silence: the client must notice and reconnect
      const hb = setInterval(() => res.write("\r\n"), 100); res.on("close", () => clearInterval(hb)); return;
    }
    if (u.pathname === "/yt/youtube/v3/search") return json(200, { items: [{ id: { videoId: "yt1" } }, { id: { videoId: "yt2" } }], nextPageToken: "more" });
    if (u.pathname === "/yt/youtube/v3/videos") return json(200, { items: [{ id: "yt1", snippet: { title: "KDF engineers rebuild bridge", description: "Report", channelTitle: "Channel A", publishedAt: "2026-10-26T06:00:00Z" }, statistics: { viewCount: "1200", likeCount: "40", commentCount: "3" } },
      { id: "yt2", snippet: { title: "Cooking with friends", description: "no mention", channelTitle: "Channel B", publishedAt: "2026-10-26T06:10:00Z" }, statistics: { viewCount: "10" } }].filter(v => u.searchParams.get("id").split(",").includes(v.id)) });
    if (u.pathname === "/feed.xml") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Example news</title>
      <item><title>KDF hands over borehole in Wajir</title><link>https://news.example/kdf-1</link><pubDate>${new Date(Date.now() - 600e3).toUTCString()}</pubDate><guid>k1</guid></item>
      <item><title>Weather update</title><link>https://news.example/w</link><pubDate>${new Date(Date.now() - 600e3).toUTCString()}</pubDate><guid>k2</guid></item></channel></rss>`); }
    json(404, { error: "not here" });
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
});
after(() => { fake.closeAllConnections(); fake.close(); });
const cfg = (extra = {}) => ({ allowPrivateFetch: true, collect: { xBearer: "test-x", youtubeKey: "test-yt", timeoutMs: 3000, maxItems: 500, bases: { x: `${F}/x`, youtube: `${F}/yt` } },
  watch: { enabled: false, retryScale: 0.001, xDailyPosts: 2000, stallMs: 400, metricsRefreshMinutes: 0, ...extra } });
const DEF = { terms: ["KDF", "Kenya Defence Forces", "#KDF", "Wanajeshi wa KDF"], exclude: ["kdf file"], sources: ["x_search"], lookback_minutes: 60 };

test("matching: terms, hashtags, phrases, exclusions, context, languages, reposts", () => {
  const d = normaliseDefinition({ ...DEF, context: [] });
  assert.deepEqual(matchPost(d, { text: "The #KDF team arrived" }).terms, ["KDF", "#KDF"], "a plain term also matches the hashtag; the hashtag term matches only the hashtag");
  assert.equal(matchPost(d, { text: "KDFX is a different word" }).matched, false);
  assert.equal(matchPost(d, { text: "kenya   defence-forces statement" }).matched, true, "phrases tolerate spacing and hyphens");
  assert.match(matchPost(d, { text: "Open the KDF file please" }).why, /excluded by “kdf file”/);
  const c = normaliseDefinition({ ...DEF, context: ["Garissa"], languages: ["sw"] });
  assert.match(matchPost(c, { text: "KDF in Mombasa" }).why, /context/);
  assert.match(matchPost(c, { text: "KDF in Garissa", language: "en" }).why, /language/);
  assert.equal(matchPost(c, { text: "KDF Garissa" }).matched, true, "unknown language is kept");
  assert.match(matchPost(d, { text: "RT KDF", repost_of: "5" }).why, /repost/);
  const q = xQuery(d); assert.equal(q.query, '(KDF OR "Kenya Defence Forces" OR #KDF OR "Wanajeshi wa KDF") -"kdf file" -is:retweet'); assert.ok(q.ok);
  assert.equal(xQuery(normaliseDefinition({ terms: Array.from({ length: 40 }, (_, i) => `term number ${i} long`) })).ok, false, "queries longer than X allows are refused with a reason");
  assert.match(youtubeQuery(d).query, /^KDF\|"Kenya Defence Forces"\|"Wanajeshi wa KDF" -"kdf file"$/);
  assert.ok(similarity("KDF soldiers rebuilt the Garissa bridge after the floods today", "KDF soldiers rebuilt the Garissa bridge after the floods!!") > 0.8);
  assert.throws(() => normaliseDefinition({ terms: ['"KDF"'] }), /quotation marks/);
  assert.ok(kdfTemplate().definition.terms.includes("Kenya Defence Forces"));
});

test("watchlists: permissions, preview required before activation, edits return to draft", async () => {
  const S = await startServer(cfg()), rev = await login(S.base, "rev"), ana = await login(S.base, "ana"), view = await login(S.base, "view");
  try {
    assert.equal((await ana.post("/api/watch/lists", { name: "x", definition: DEF })).status, 403, "analysts cannot create watchlists");
    assert.equal((await rev.post("/api/watch/lists", { name: "KDF", definition: { terms: [] } })).status, 400);
    const id = (await rev.post("/api/watch/lists", { name: "KDF mentions", definition: DEF })).body.id;
    let r = await rev.post(`/api/watch/lists/${id}/status`, { status: "active" }); assert.equal(r.status, 409); assert.match(r.body.error, /Preview/);
    const t = await rev.post("/api/watch/test", { definition: DEF, samples: ["KDF trucks in Garissa", "My KDF file is broken", "Nothing here"] });
    assert.deepEqual(t.body.results.map(x => x.matched), [true, false, false]); assert.match(t.body.results[1].why, /excluded/);
    const p = await rev.post(`/api/watch/lists/${id}/preview`, { samples: "Kenya Defence Forces statement on floods\nkdf file viewer" });
    assert.equal(p.status, 200); assert.equal(p.body.local.matched, 1); assert.equal(p.body.local.excluded, 1); assert.equal(p.body.live, null, "no paid request unless asked");
    r = await rev.post(`/api/watch/lists/${id}/status`, { status: "active" }); assert.equal(r.status, 400); assert.match(r.body.error, /basis/);
    await rev.patch(`/api/watch/lists/${id}`, { authorisation: "X API terms; unit policy IO-7" });
    r = await rev.post(`/api/watch/lists/${id}/status`, { status: "active" }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, "active");
    r = await rev.patch(`/api/watch/lists/${id}`, { definition: { ...DEF, terms: [...DEF.terms, "Jeshi la Kenya"] } }); assert.equal(r.body.status, "draft", "a changed definition must be previewed and activated again");
    r = await rev.post(`/api/watch/lists/${id}/status`, { status: "active" }); assert.equal(r.status, 409);
    // a live preview makes one search request and stores nothing
    const lp = await rev.post(`/api/watch/lists/${id}/preview`, { live: true });
    assert.equal(lp.body.live[0].fetched, 3); assert.equal(lp.body.live[0].matched, 2); assert.match(lp.body.live[0].note, /One X recent search request/);
    assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, 0);
    assert.equal((await view.get("/api/watch/overview")).status, 200, "viewers can read");
    assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM watchlist_versions WHERE watchlist_id = ?").get(id).n >= 3);
    const ov = (await rev.get("/api/watch/overview")).body;
    assert.equal(ov.status.sources.find(s => s.key === "x_stream").state, "disabled"); assert.ok(ov.status.unsupported.some(u => /TikTok/.test(u.platform))); assert.ok(ov.caveats.some(c => /not guaranteed/.test(c)));
  } finally { await S.close(); }
});

async function activeList(S, rev, def = DEF, name = "KDF mentions") {
  const id = (await rev.post("/api/watch/lists", { name, definition: def, authorisation: "Platform API terms; unit policy" })).body.id;
  await rev.post(`/api/watch/lists/${id}/preview`, {}); const r = await rev.post(`/api/watch/lists/${id}/status`, { status: "active" }); assert.equal(r.status, 200, JSON.stringify(r.body));
  return id;
}

test("X recent search: pagination, exclusions, reposts, duplicates, saved position, retries, rate limits, refusals, daily limit, restart", async () => {
  X.search = []; X.mode = "ok"; X.fail503 = 0;
  const S = await startServer(cfg()), rev = await login(S.base, "rev"), wc = S.ctx.watchCollector;
  try {
    const id = await activeList(S, rev);
    let r = await wc.runSource(S.ctx.watch.get(id), "x_search");
    assert.equal(r.fetched, 5); assert.equal(r.matched, 3); assert.equal(r.not_confirmed, 2, "the KDF file post and the repost are not kept");
    assert.ok(X.search[0].start_time && !X.search[0].since_id, "first run starts from the look-back time"); assert.equal(X.search[1].next_token, "p2", "pagination followed");
    const st = S.ctx.db.prepare("SELECT * FROM watch_source_state WHERE watchlist_id = ?").get(id); assert.equal(st.cursor, "1003"); assert.equal(st.status, "ok");
    const alerts = (await rev.get("/api/watch/alerts?status=new")).body; assert.equal(alerts.total, 3);
    const a = alerts.alerts.find(x => x.post_text.includes("bridge"));
    assert.equal(a.platform, "X (Twitter)"); assert.equal(a.url, "https://x.com/amina/status/1003"); assert.equal(a.posted_at, "2026-10-26T07:58:00Z"); assert.ok(a.first_detected_at); assert.match(a.reason, /Matched watchlist “KDF mentions”: “KDF”/);
    assert.equal(a.views, 50); assert.equal(a.shares, 0);
    assert.equal(S.ctx.db.prepare("SELECT SUM(units) n FROM api_usage WHERE service = 'x_api' AND unit = 'posts'").get().n, 5, "posts returned are counted for cost");
    // second run continues from the saved position; nothing is stored twice
    r = await wc.runSource(S.ctx.watch.get(id), "x_search"); assert.equal(X.search.at(-1).since_id, "1003"); assert.equal(r.fetched, 0);
    S.ctx.db.prepare("UPDATE watch_source_state SET cursor = NULL, cursor_time = NULL").run(); r = await wc.runSource(S.ctx.watch.get(id), "x_search");
    assert.equal(r.new_matches, 0, "the same posts collected again are recognised"); assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, 3);
    // transient errors are retried inside the run
    X.fail503 = 2; S.ctx.db.prepare("UPDATE watch_source_state SET cursor = '1003', cursor_time = ?").run(new Date().toISOString());
    r = await wc.runSource(S.ctx.watch.get(id), "x_search"); assert.equal(r.error, undefined); assert.equal(X.fail503, 0);
    // rate limit: waits until X's reset time
    X.mode = "rate"; r = await wc.runSource(S.ctx.watch.get(id), "x_search"); assert.match(r.error, /rate limit/);
    let s = S.ctx.db.prepare("SELECT * FROM watch_source_state WHERE watchlist_id = ?").get(id); assert.equal(s.status, "rate_limited"); assert.ok(Date.parse(s.backoff_until) > Date.now());
    assert.equal(s.cursor, "1003", "the saved position survives a failure");
    // refusal (no credit / wrong access level)
    X.mode = "auth"; r = await wc.runSource(S.ctx.watch.get(id), "x_search"); s = S.ctx.db.prepare("SELECT * FROM watch_source_state WHERE watchlist_id = ?").get(id);
    assert.equal(s.status, "not_permitted"); assert.match(s.last_error, /refused access \(HTTP 403: Client Forbidden: This app has no credit\)/);
    assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_runs WHERE status = 'failed'").get().n >= 2);
    X.mode = "ok";
    // daily limit
    S.ctx.db.prepare("INSERT INTO api_usage(at,service,operation,units,unit,status) VALUES (?,?,?,?,?,?)").run(new Date().toISOString(), "x_api", "test", 5000, "posts", "ok");
    r = await wc.runSource(S.ctx.watch.get(id), "x_search"); assert.equal(r.skipped, "budget");
    assert.equal(S.ctx.db.prepare("SELECT status FROM watch_source_state WHERE watchlist_id = ?").get(id).status, "budget_reached");
    S.ctx.db.prepare("DELETE FROM api_usage WHERE operation = 'test'").run();
    // restart recovery: a run cut off mid-way is marked; the next run continues from the saved position
    S.ctx.db.prepare("INSERT INTO watch_runs(watchlist_id,source,started_at,status) VALUES (?,?,?,?)").run(id, "x_search", new Date().toISOString(), "running");
    const dir = S.dataDir; await S.close(); S.ctx.db.close();
    const S2 = await reopenServer(dir, cfg()); try {
      assert.equal(S2.ctx.watchCollector.resume().interrupted_runs, 1);
      X.search = []; await S2.ctx.watchCollector.runSource(S2.ctx.watch.get(id), "x_search"); assert.equal(X.search[0].since_id, "1003");
    } finally { await S2.close(); }
  } finally { try { await S.close(); } catch {} }
});

test("repeated wording, engagement changes from observed counts, volume against a baseline", async () => {
  const S = await startServer(cfg()), rev = await login(S.base, "rev"), W = S.ctx.watch;
  try {
    const id = await activeList(S, rev, { ...DEF, sources: ["x_search"], alert_mode: "every_post" });
    const now = Date.now(), at = m => new Date(now - m * 60e3).toISOString(), wl = () => W.get(id);
    const row = (pid, text, acc, m, extra = {}) => ({ platform: "X (Twitter)", post_id: pid, text, account: "@" + acc, posted_at: at(m), url: `https://x.com/${acc}/status/${pid}`, likes: 2, comments: 0, shares: 1, views: null, ...extra });
    W.ingest(wl(), "x_search", [row("r1", "BREAKING: KDF convoy ambushed near Lamu, many soldiers missing, share now", "a1", 30)]);
    W.ingest(wl(), "x_search", [row("r2", "breaking kdf convoy ambushed near Lamu many soldiers missing share now!!", "a2", 20)]);
    let al = (await rev.get("/api/watch/alerts")).body; assert.equal(al.alerts.filter(a => a.kind === "match").length, 1, "the copy joins the first post's group instead of a new alert");
    W.ingest(wl(), "x_search", [row("r3", "BREAKING: KDF convoy ambushed near Lamu, many soldiers missing, share now https://t.co/x", "a3", 10)]);
    al = (await rev.get("/api/watch/alerts?kind=repeated")).body; assert.equal(al.total, 1);
    assert.equal(al.alerts[0].detail.posts, 3); assert.equal(al.alerts[0].detail.accounts, 3); assert.match(al.alerts[0].reason, /not proof of coordination/);
    W.ingest(wl(), "x_search", [row("r4", "BREAKING: KDF convoy ambushed near Lamu, many soldiers missing, share now", "a4", 5)]);
    al = (await rev.get(`/api/watch/alerts/${al.alerts[0].id}`)).body; assert.equal(al.detail.posts, 4, "the alert is updated, not duplicated"); assert.equal(al.related.length, 4);
    // engagement: two observations of the same post's public counts
    const one = W.ingest(wl(), "x_search", [row("e1", "KDF statement on the Lamu reports", "press", 60, { likes: 10, comments: 2, shares: 3, views: 900 })]);
    assert.equal(one.alerts, 1);
    W.ingest(wl(), "x_search", [row("e1", "KDF statement on the Lamu reports", "press", 60, { likes: 300, comments: 40, shares: 90, views: 50000 })]);
    al = (await rev.get("/api/watch/alerts?kind=engagement")).body; assert.equal(al.total, 1);
    assert.match(al.alerts[0].reason, /rose from 15 to 430 \(\+415\)/); assert.match(al.alerts[0].reason, /not an estimate of reach/);
    const nv = W.ingest(wl(), "x_search", [row("n1", "KDF post without counts", "quiet", 5, { likes: null, comments: null, shares: null })]);
    assert.equal(S.ctx.db.prepare("SELECT likes FROM watch_posts WHERE post_id = 'n1'").get().likes, null, "a count the platform did not report stays unknown, not zero"); assert.equal(nv.new_matches, 1);
    // volume: not enough history yet
    let v = W.volume(wl()); assert.equal(v.sufficient, false); assert.match(v.insufficient_reason, /needs 24 earlier windows/);
    // pretend the watchlist has been collecting for two days with successful runs, a quiet baseline, then a burst
    S.ctx.db.prepare("UPDATE watchlists SET activated_at = ? WHERE id = ?").run(at(3000), id);
    for (let h = 1; h < 30; h++) S.ctx.db.prepare("INSERT INTO watch_runs(watchlist_id,source,started_at,finished_at,status) VALUES (?,?,?,?,?)").run(id, "x_search", at(h * 60), at(h * 60), "ok");
    const base = []; for (let h = 2; h < 24; h += 3) base.push(row(`b${h}`, `KDF routine update number ${h} about training`, `u${h}`, h * 60 + 5));
    W.ingest(wl(), "x_search", base);
    const burst = []; for (let i = 0; i < 14; i++) burst.push(row(`s${i}`, `KDF helicopter seen over Eastleigh ${i} people asking why ${i * 7}`, `burst${i}`, 2 + i * 3));
    W.ingest(wl(), "x_search", burst);
    v = W.volume(wl()); assert.equal(v.sufficient, true, v.insufficient_reason); assert.ok(v.current >= 14); assert.equal(v.spike, true);
    assert.equal(W.checkVolume(wl()), 1); assert.equal(W.checkVolume(wl()), 0, "one alert per window");
    al = (await rev.get("/api/watch/alerts?kind=volume")).body.alerts[0]; assert.match(al.reason, /against an average of/); assert.match(al.reason, /Threshold: at least 10 posts/);
    // low coverage: failed runs make the baseline unreliable, so no spike is reported
    for (let h = 1; h < 30; h++) S.ctx.db.prepare("INSERT INTO watch_runs(watchlist_id,source,started_at,finished_at,status) VALUES (?,?,?,?,?)").run(id, "x_search", at(h * 60 + 1), at(h * 60 + 1), "failed");
    v = W.volume(wl()); assert.equal(v.sufficient, false); assert.match(v.insufficient_reason, /collection succeeded for only 50%/);
  } finally { await S.close(); }
});

test("alert actions: acknowledge, assign, dismiss with reason, reopen, convert to a case; permissions", async () => {
  const S = await startServer(cfg()), rev = await login(S.base, "rev"), ana = await login(S.base, "ana"), view = await login(S.base, "view"), W = S.ctx.watch;
  try {
    const id = await activeList(S, rev);
    W.ingest(W.get(id), "x_search", ["Kenya Defence Forces deny claims of a base closure", "KDF recruitment fraud message circulating", "KDF band performs in Nakuru"].map((t, i) => ({ platform: "X (Twitter)", post_id: `p${i}`, text: t, account: `@acc${i}`, posted_at: new Date().toISOString(), url: `https://x.com/acc${i}/status/p${i}` })));
    const [a1, a2, a3] = (await rev.get("/api/watch/alerts")).body.alerts.map(a => a.id).sort();
    const act = (who, aid, b) => who.post(`/api/watch/alerts/${aid}/action`, b);
    assert.equal((await act(view, a1, { action: "acknowledge" })).status, 403);
    assert.equal((await act(ana, a1, { action: "acknowledge" })).status, 200);
    assert.equal((await act(ana, a1, { action: "acknowledge" })).status, 409);
    const anaId = S.ctx.db.prepare("SELECT id FROM users WHERE username = 'ana'").get().id, revId = S.ctx.db.prepare("SELECT id FROM users WHERE username = 'rev'").get().id;
    assert.equal((await act(ana, a2, { action: "assign", user_id: revId })).status, 403, "analysts assign only to themselves");
    assert.equal((await act(ana, a2, { action: "assign", user_id: anaId })).status, 200);
    assert.equal((await act(rev, a3, { action: "assign", user_id: anaId, note: "please check" })).status, 200);
    assert.equal((await ana.get("/api/watch/alerts?mine=1")).body.total, 2);
    assert.equal((await act(ana, a3, { action: "dismiss" })).status, 400, "dismissal needs a reason");
    assert.equal((await act(ana, a3, { action: "dismiss", note: "routine band event, unrelated" })).status, 200);
    assert.equal((await act(ana, a3, { action: "reopen" })).status, 200);
    const c = await act(ana, a2, { action: "convert", priority: "priority" }); assert.equal(c.status, 200); assert.match(c.body.case_id, /^C-\d{4}-\d{4}$/);
    const k = S.ctx.db.prepare("SELECT * FROM cases WHERE id = ?").get(c.body.case_id);
    assert.equal(k.claim_text, "KDF recruitment fraud message circulating"); assert.equal(k.source_url, "https://x.com/acc1/status/p1"); assert.equal(k.source_platform, "X (Twitter)"); assert.equal(k.priority, "priority");
    assert.equal((await act(ana, a2, { action: "dismiss", note: "x" })).status, 409, "a converted alert continues in its case");
    const d = (await rev.get(`/api/watch/alerts/${a2}`)).body; assert.deepEqual(d.events.map(e => e.action), ["raised", "assigned", "converted"]); assert.equal(d.case_id, c.body.case_id);
    assert.ok(d.post.highlights.length >= 1);
    assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'Mention alert%'").get().n >= 5);
  } finally { await S.close(); }
});

test("YouTube and news feeds on schedule; YouTube daily search limit; metrics refresh raises engagement alerts", async () => {
  X.likes = 5;
  const S = await startServer({ ...cfg({ metricsRefreshMinutes: 60 }), }), rev = await login(S.base, "rev"), W = S.ctx.watch, wc = S.ctx.watchCollector;
  try {
    const id = await activeList(S, rev, { ...DEF, sources: ["youtube", "news", "x_search"], feeds: [`${F}/feed.xml`] });
    const t = await wc.tick(); assert.equal(t.runs, 3);
    const posts = S.ctx.db.prepare("SELECT platform, post_id, views FROM watch_posts ORDER BY id").all();
    assert.ok(posts.some(p => p.platform === "YouTube" && p.post_id === "yt1" && p.views === 1200)); assert.ok(!posts.some(p => p.post_id === "yt2"), "unrelated YouTube results are not kept");
    assert.ok(posts.some(p => p.platform === "News website"));
    assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM api_usage WHERE operation = 'search.list'").get().n, 1, "one YouTube search call per run (only the first page)");
    assert.match(S.ctx.db.prepare("SELECT note FROM watch_runs WHERE source = 'youtube'").get().note, /only the first page/);
    // metrics refresh: X lookups of posts with open alerts; counts rise between observations
    await wc.refreshMetrics(); await wc.refreshMetrics();
    assert.ok(X.lookups >= 2); assert.ok((await rev.get("/api/watch/alerts?kind=engagement")).body.total >= 1);
    // second tick: nothing is due yet
    assert.equal((await wc.tick()).runs, 0);
    for (let i = 0; i < 95; i++) S.ctx.db.prepare("INSERT INTO api_usage(at,service,operation,units,unit,status) VALUES (?,?,?,?,?,?)").run(new Date().toISOString(), "youtube_api", "search.list", 1, "search calls", "ok");
    S.ctx.db.prepare("UPDATE watch_source_state SET next_run_at = NULL").run();
    await wc.runSource(W.get(id), "youtube"); assert.equal(S.ctx.db.prepare("SELECT status FROM watch_source_state WHERE source = 'youtube'").get().status, "budget_reached");
    const ov = (await rev.get("/api/watch/overview")).body.status; assert.equal(ov.budgets.youtube_search_today, 96); assert.equal(ov.budgets.youtube_search_limit, 90);
  } finally { await S.close(); }
});

test("X filtered stream: rules, posts by rule tag, reconnection after close and stall, gap recovery, refusal", async () => {
  X.rules = [{ id: "7", value: "cats", tag: "someone-else" }, { id: "8", value: "old", tag: "aivs-wl-999" }]; X.search = []; X.streamConns = 0;
  X.streamPlan = ["posts-close", "503", "stall", "hold"];
  const S = await startServer(cfg({ xStream: true })), rev = await login(S.base, "rev"), wc = S.ctx.watchCollector;
  const waitFor = async (f, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 50)); } return true; };
  try {
    const id = await activeList(S, rev, { ...DEF, sources: ["x_stream"] });
    // preview checked the rule with X (dry run)
    assert.ok(X.calls.some(c => c.includes("dry_run=true")));
    await wc.tick();
    assert.ok(await waitFor(() => S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts WHERE post_id = '2001'").get().n === 1), "a streamed post is stored");
    assert.deepEqual(X.rules.map(r => r.tag).sort(), [`aivs-wl-${id}`, "someone-else"], "AIVS replaces only its own rules");
    assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts WHERE post_id = '2002'").get().n, 0, "posts for other rules are ignored");
    // closed connection -> reconnect; 503 -> back off; stall (no keep-alive) -> reconnect
    assert.ok(await waitFor(() => X.streamConns >= 4), `reconnected ${X.streamConns} times`);
    assert.ok(await waitFor(() => (S.ctx.db.prepare("SELECT value_json FROM watch_service WHERE key = 'x_stream'").get()?.value_json || "").includes('"status":"connected"')));
    const gaps = S.ctx.db.prepare("SELECT * FROM watch_runs WHERE source = 'x_stream' AND kind = 'gap'").all(); assert.ok(gaps.length >= 2, "disconnections are recorded");
    await wc.tick();   // recovers the gaps with recent search over the missed period
    assert.ok(X.search.some(s => s.start_time && s.end_time && s.query.includes("KDF")), "gap recovered by recent search");
    assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_runs WHERE kind = 'gapfill'").get().n >= 1);
    assert.match(S.ctx.db.prepare("SELECT note FROM watch_runs WHERE kind = 'gap' ORDER BY id LIMIT 1").get().note, /recovered by recent search/);
    // pausing the watchlist removes its rule and closes the stream
    await rev.post(`/api/watch/lists/${id}/status`, { status: "paused" }); await wc.tick();
    assert.match(S.ctx.db.prepare("SELECT value_json FROM watch_service WHERE key = 'x_stream'").get().value_json, /"status":"off"/);
    // refusal: the stream stays off until an administrator reconnects
    X.streamPlan = ["401"]; await rev.post(`/api/watch/lists/${id}/status`, { status: "active" }); await wc.tick();
    assert.ok(await waitFor(() => S.ctx.db.prepare("SELECT value_json FROM watch_service WHERE key = 'x_stream'").get().value_json.includes("not_permitted")));
    const n = X.streamConns; await wc.tick(); await new Promise(r => setTimeout(r, 300)); assert.equal(X.streamConns, n, "no retries after a refusal");
    const ad = await login(S.base, "admin"); X.streamPlan = ["hold"]; assert.equal((await ad.post("/api/watch/stream/reconnect", {})).status, 200);
    assert.ok(await waitFor(() => X.streamConns > n));
  } finally { wc.stop(); await S.close(); }
});

// Mention Watch platforms beyond X, YouTube and news: Reddit, Bluesky, Mastodon, Threads, Instagram hashtags.
// Stand-in servers answer in each platform's documented format; nothing reaches the internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, login } from "./helpers.js";
import { termQueries, termTags, redditQueries } from "../server/lib/watch-platforms.js";
import { normaliseDefinition } from "../server/lib/watch.js";

const seen = []; let fake, F, redditDeleted = false, igCalls = 0;
const now = () => Date.now() / 1000;
before(async () => {
  fake = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), json = (st, b, h = {}) => { res.writeHead(st, { "content-type": "application/json", ...h }); res.end(JSON.stringify(b)); };
    let body = ""; for await (const c of req) body += c; seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization, ua: req.headers["user-agent"], proxy: req.headers["atproto-proxy"], body });
    // Reddit
    if (u.pathname === "/rauth/api/v1/access_token") return req.headers.authorization === `Basic ${Buffer.from("rid:rsecret").toString("base64")}` ? json(200, { access_token: "rtok", expires_in: 3600 }) : json(401, { error: "invalid_grant" });
    if (u.pathname === "/r/search") return json(200, { data: { after: null, children: [
      { data: { name: "t3_a1", id: "a1", title: "KDF engineers rebuild a bridge in Garissa", selftext: "Photos from the site", author: "kenyan_reader", subreddit_name_prefixed: "r/Kenya", permalink: "/r/Kenya/comments/a1/x/", created_utc: now() - 600, num_comments: 12 } },
      { data: { name: "t3_a2", id: "a2", title: "Converting a KDF file to PDF", selftext: "", author: "techie", permalink: "/r/tech/comments/a2/", created_utc: now() - 900, num_comments: 1 } }] } }, { "x-ratelimit-remaining": "95", "x-ratelimit-reset": "300" });
    if (u.pathname === "/r/api/info") return json(200, { data: { children: redditDeleted ? [] : [{ data: { name: "t3_a1", author: "kenyan_reader", selftext: "Photos from the site" } }] } });
    // Bluesky (PDS)
    if (u.pathname === "/bsky/xrpc/com.atproto.server.createSession") return JSON.parse(body).password === "app-pass" ? json(200, { accessJwt: "bjwt", did: "did:plc:me" }) : json(401, { error: "AuthenticationRequired", message: "Invalid identifier or password" });
    if (u.pathname === "/bsky/xrpc/app.bsky.feed.searchPosts") {
      if (req.headers.authorization !== "Bearer bjwt") return json(401, { error: "AuthMissing" });
      return json(200, { posts: u.searchParams.get("q") === "KDF" ? [{ uri: "at://did:plc:abc/app.bsky.feed.post/3kx1", author: { handle: "amina.bsky.social", displayName: "Amina" }, record: { text: "KDF convoy spotted near Mandera", createdAt: new Date().toISOString(), langs: ["en"] }, likeCount: 4, replyCount: 1, repostCount: 2, quoteCount: 1 }] : [] });
    }
    // Mastodon
    if (u.pathname.startsWith("/masto/api/v1/timelines/tag/")) {
      const tag = decodeURIComponent(u.pathname.split("/").pop());
      if (tag.toLowerCase() !== "kdf") return json(200, []);
      return json(200, [{ id: "1002", uri: "https://mastodon.example/users/juma/statuses/1002", url: "https://mastodon.example/@juma/1002", created_at: new Date().toISOString(), visibility: "public", language: "sw", content: "<p>Wanajeshi wa <a href=\"#\">#KDF</a> wamefika Lamu</p>", account: { acct: "juma", display_name: "Juma" }, favourites_count: 3, replies_count: 0, reblogs_count: 1 },
        { id: "1001", reblog: { id: "9", content: "<p>KDF boosted</p>" }, created_at: new Date().toISOString(), account: { acct: "booster" } }]);
    }
    // Threads
    if (u.pathname === "/threads/v1.0/keyword_search") {
      if (u.searchParams.get("access_token") !== "ttok") return json(400, { error: { message: "Invalid OAuth access token", code: 190 } });
      return json(200, { data: u.searchParams.get("q") === "Kenya Defence Forces" ? [{ id: "th1", text: "Kenya Defence Forces statement on the floods", permalink: "https://www.threads.com/@ministry/post/abc", timestamp: new Date().toISOString().replace("Z", "+0000"), username: "ministry" }] : [] });
    }
    // Instagram Graph API
    if (u.pathname === "/graph/v26.0/ig_hashtag_search") { igCalls++; return json(200, { data: u.searchParams.get("q").toLowerCase() === "kdf" ? [{ id: "17840000000000001" }] : [] }); }
    if (u.pathname === "/graph/v26.0/17840000000000001/recent_media") return json(200, { data: [{ id: "ig1", caption: "Proud of our #KDF peacekeepers", media_type: "IMAGE", permalink: "https://www.instagram.com/p/ig1/", timestamp: new Date().toISOString().replace("Z", "+0000"), like_count: 120, comments_count: 8 }] });
    json(404, { error: "not here" });
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
});
after(() => { fake.closeAllConnections(); fake.close(); });

const DEF = { terms: ["KDF", "#KDF", "Kenya Defence Forces"], exclude: ["kdf file"], lookback_minutes: 120 };
test("search strings and hashtags derived from the terms", () => {
  const d = normaliseDefinition(DEF);
  assert.deepEqual(termQueries(d).map(x => x.q), ["KDF", '"Kenya Defence Forces"']);
  assert.deepEqual(termTags(d), ["KDF", "KenyaDefenceForces"]);
  assert.equal(redditQueries(d)[0], 'KDF OR "Kenya Defence Forces"');
  assert.equal(redditQueries(normaliseDefinition({ terms: Array.from({ length: 40 }, (_, i) => `long phrase number ${i}`) })).length > 1, true, "long term lists are split into several Reddit queries");
});

test("Reddit, Bluesky, Mastodon, Threads and Instagram collect through their APIs; status lists what is not covered", async () => {
  const S = await startServer({ collect: { timeoutMs: 3000, bases: { reddit_auth: `${F}/rauth`, reddit: `${F}/r`, threads: `${F}/threads`, graph: `${F}/graph`, mastodon: `${F}/masto` } },
    platforms: { redditClientId: "rid", redditClientSecret: "rsecret", redditUsername: "aivs_team", blueskyHandle: "team.bsky.social", blueskyAppPassword: "app-pass", blueskyPds: `${F}/bsky`, mastodonInstances: "mastodon.example", threadsToken: "ttok", threadsDailyQueries: 50, instagramToken: "itok", instagramUserId: "1784" },
    watch: { enabled: false, retryScale: 0.001, metricsRefreshMinutes: 0 } });
  const rev = await login(S.base, "rev"), wc = S.ctx.watchCollector;
  try {
    const ov = (await rev.get("/api/watch/overview")).body;
    for (const k of ["reddit", "bluesky", "mastodon", "threads", "instagram"]) assert.equal(ov.status.sources.find(s => s.key === k).state, "ready", k);
    assert.deepEqual(ov.template.definition.sources.sort(), ["bluesky", "instagram", "mastodon", "reddit", "threads"], "the template starts with the connected sources");
    assert.ok(ov.status.unsupported.some(u => /^Facebook/.test(u.platform)) && ov.status.unsupported.some(u => /TikTok/.test(u.platform)));
    const id = (await rev.post("/api/watch/lists", { name: "KDF all platforms", authorisation: "Each platform's API terms; unit policy", definition: { ...DEF, sources: ["reddit", "bluesky", "mastodon", "threads", "instagram"] } })).body.id;
    const lp = await rev.post(`/api/watch/lists/${id}/preview`, { live: true, live_sources: ["bluesky"] }); assert.equal(lp.body.live[0].matched, 1); assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, 0, "preview stores nothing");
    assert.equal((await rev.post(`/api/watch/lists/${id}/status`, { status: "active" })).status, 200);
    const t = await wc.tick(); assert.equal(t.runs, 5);
    const posts = S.ctx.db.prepare("SELECT platform, post_id, account, url, likes, comments, shares, text FROM watch_posts ORDER BY platform").all(), by = p => posts.find(x => x.platform === p);
    assert.deepEqual(posts.map(p => p.platform), ["Bluesky", "Instagram", "Mastodon", "Reddit", "Threads"]);
    assert.equal(by("Reddit").url, "https://www.reddit.com/r/Kenya/comments/a1/x/"); assert.equal(by("Reddit").comments, 12); assert.equal(by("Reddit").likes, null, "Reddit's vote score is not presented as likes");
    assert.ok(!posts.some(p => /KDF file/.test(p.text)), "exclusions apply to every platform");
    assert.equal(by("Bluesky").url, "https://bsky.app/profile/amina.bsky.social/post/3kx1"); assert.equal(by("Bluesky").shares, 3);
    assert.equal(by("Mastodon").account, "@juma@mastodon.example"); assert.equal(by("Mastodon").text, "Wanajeshi wa #KDF wamefika Lamu"); assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts WHERE text LIKE '%boosted%'").get().n, 0, "boosts are reposts and are skipped");
    assert.equal(by("Threads").likes, null, "Threads search gives no counts, so none are shown");
    assert.equal(by("Instagram").account, null, "Instagram does not give usernames for hashtag media"); assert.equal(by("Instagram").likes, 120);
    // request details the platforms require
    assert.match(seen.find(x => x.path === "/r/search").ua, /^server:aivs-mention-watch:.+ \(by \/u\/aivs_team\)$/); assert.equal(seen.find(x => x.path === "/r/search").auth, "Bearer rtok");
    assert.equal(seen.find(x => x.path.endsWith("searchPosts")).proxy, "did:web:api.bsky.app#bsky_appview");
    assert.equal(seen.find(x => x.path === "/threads/v1.0/keyword_search" && x.q.q === "KDF").q.search_mode, "TAG", "a term written as a hashtag is searched as a topic tag");
    // Mastodon continues from the newest status seen; Instagram hashtags are counted toward 30 in 7 days
    S.ctx.db.prepare("UPDATE watch_source_state SET next_run_at = NULL").run(); await wc.tick();
    assert.equal(seen.filter(x => x.path.endsWith("/tag/KDF")).at(-1).q.min_id, "1002");
    assert.equal(igCalls, 2, "hashtag IDs are looked up once and reused");
    assert.equal((await rev.get("/api/watch/overview")).body.status.budgets.instagram_hashtags_7d, 2, "both hashtags looked up count, even the one Instagram does not know");
    // Reddit Data API terms: a post deleted on Reddit is blanked in AIVS
    redditDeleted = true; const m = await wc.refreshMetrics(); assert.deepEqual(m.reddit_deleted_check, { checked: 1, removed: 1 }, JSON.stringify(m));
    const rd = S.ctx.db.prepare("SELECT text, account FROM watch_posts WHERE platform = 'Reddit'").get(); assert.match(rd.text, /deleted on Reddit/); assert.equal(rd.account, null);
    const alerts = (await rev.get("/api/watch/alerts?status=all")).body; assert.equal(alerts.total, 5);
  } finally { await S.close(); }
});

test("wrong credentials are reported per platform and do not stop the others", async () => {
  const S = await startServer({ collect: { timeoutMs: 3000, bases: { reddit_auth: `${F}/rauth`, reddit: `${F}/r`, threads: `${F}/threads` } },
    platforms: { redditClientId: "rid", redditClientSecret: "wrong", redditUsername: "aivs_team", blueskyHandle: "team.bsky.social", blueskyAppPassword: "wrong", blueskyPds: `${F}/bsky`, threadsToken: "bad" },
    watch: { enabled: false, retryScale: 0.001, metricsRefreshMinutes: 0 } });
  const rev = await login(S.base, "rev");
  try {
    const id = (await rev.post("/api/watch/lists", { name: "x", authorisation: "terms", definition: { ...DEF, sources: ["reddit", "bluesky", "threads"] } })).body.id;
    await rev.post(`/api/watch/lists/${id}/preview`, {}); await rev.post(`/api/watch/lists/${id}/status`, { status: "active" });
    await S.ctx.watchCollector.tick();
    const st = Object.fromEntries(S.ctx.db.prepare("SELECT source, status, last_error FROM watch_source_state").all().map(r => [r.source, r]));
    assert.equal(st.reddit.status, "not_permitted"); assert.match(st.reddit.last_error, /invalid_grant/);
    assert.equal(st.bluesky.status, "not_permitted"); assert.match(st.bluesky.last_error, /Invalid identifier or password/);
    assert.match(st.threads.last_error, /Invalid OAuth access token/);
  } finally { await S.close(); }
});

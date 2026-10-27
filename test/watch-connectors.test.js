// SIMULATED TESTS (no live platform is contacted): Facebook Pages, TikTok Research API, Telegram bot, WhatsApp
// Business webhook, the capability table and its statuses, live checks, manual link submission, file import and
// retention. Stand-in servers answer with fixtures shaped like each platform's documented responses. Live
// verification is separate: it happens only through "Test connection" on a configured server, and is recorded as such.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { startServer, login } from "./helpers.js";

let fake, F; const seen = [];
const iso = (minAgo = 5) => new Date(Date.now() - minAgo * 60e3).toISOString();
before(async () => {
  fake = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), json = (st, b) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    let body = ""; for await (const c of req) body += c; seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), body });
    // Facebook Graph API (fixtures follow the /page/feed and /post/comments documentation)
    if (u.pathname === "/graph/v26.0/kdfpage") return u.searchParams.get("access_token") === "fbtok" ? json(200, { name: "Example Defence Page", id: "1001" }) : json(400, { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } });
    if (u.pathname === "/graph/v26.0/kdfpage/feed") return json(200, { data: [
      { id: "1001_1", message: "KDF engineers complete the Garissa bridge repairs", created_time: iso(30).replace("Z", "+0000"), permalink_url: "https://www.facebook.com/1001/posts/1", shares: { count: 14 }, reactions: { summary: { total_count: 220 } }, comments: { summary: { total_count: 31 } } },
      { id: "1001_2", created_time: iso(40).replace("Z", "+0000") }] });
    if (u.pathname === "/graph/v26.0/1001_1/comments") return json(200, { data: [{ id: "1001_1_c1", message: "Is it true KDF closed the road at night?", created_time: iso(10).replace("Z", "+0000"), permalink_url: "https://www.facebook.com/1001/posts/1?comment_id=c1", like_count: 3 }, { id: "1001_1_c2", message: "Great work", created_time: iso(9).replace("Z", "+0000"), like_count: 1 }] });
    // TikTok Research API
    if (u.pathname === "/tt/v2/oauth/token/") return new URLSearchParams(body).get("client_secret") === "tsecret" ? json(200, { access_token: "clt.test", expires_in: 7200, token_type: "Bearer" }) : json(401, { error: "invalid_client", error_description: "Client key or secret is incorrect." });
    // the real API sends 64-bit IDs as bare numbers; the fixture is written as raw JSON so the digits are exact
    if (u.pathname === "/tt/v2/research/video/query/") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: { videos: [{ id: "__ID__", video_description: "KDF passing out parade in Eldoret", create_time: Math.floor(Date.now() / 1000) - 3600, username: "parade_fan", region_code: "KE", like_count: 900, comment_count: 40, share_count: 77, view_count: 12000, hashtag_names: ["kdf"] }], cursor: 1, has_more: false, search_id: "s1" }, error: { code: "ok", message: "" } }).replace('"__ID__"', "7300000000000000001")); }
    // Telegram Bot API
    if (u.pathname === "/tg/botbot123/getUpdates") return json(200, { ok: true, result: [
      { update_id: 500, channel_post: { message_id: 77, date: Math.floor(Date.now() / 1000) - 120, chat: { id: -1001, type: "channel", title: "Public News", username: "publicnews" }, text: "KDF statement on the Lamu operation" } },
      { update_id: 501, channel_post: { message_id: 3, date: Math.floor(Date.now() / 1000) - 100, chat: { id: -1002, type: "channel", title: "Someone's private channel" }, text: "KDF private channel post" } },
      { update_id: 502, message: { message_id: 9, date: Math.floor(Date.now() / 1000) - 90, chat: { id: -2001, type: "group", title: "A group" }, text: "KDF in a group chat" } },
      { update_id: 503, channel_post: { message_id: 4, date: Math.floor(Date.now() / 1000) - 80, chat: { id: -1003, type: "channel", title: "Our own private channel" }, caption: "KDF photo caption in our own channel" } }] });
    if (u.pathname === "/tg/botbad/getUpdates") return json(401, { ok: false, error_code: 401, description: "Unauthorized" });
    json(404, { error: "not here" });
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
});
after(() => { fake.closeAllConnections(); fake.close(); });

const DEF = { terms: ["KDF", "Kenya Defence Forces"], exclude: ["kdf file"], lookback_minutes: 120 };
const cfg = (p = {}) => ({ collect: { timeoutMs: 3000, bases: { graph: `${F}/graph`, tiktok: `${F}/tt`, telegram: `${F}/tg` } },
  platforms: { facebookToken: "fbtok", tiktokClientKey: "tkey", tiktokClientSecret: "tsecret", telegramToken: "bot123", telegramOwnChannels: "-1003", whatsappVerifyToken: "verify-me", whatsappAppSecret: "app-secret", ...p },
  watch: { enabled: false, retryScale: 0.001, metricsRefreshMinutes: 0 } });
async function active(rev, sources, extra = {}) {
  const id = (await rev.post("/api/watch/lists", { name: "KDF", authorisation: "Platform API terms; unit policy", definition: { ...DEF, sources, ...extra } })).body.id;
  await rev.post(`/api/watch/lists/${id}/preview`, {}); const r = await rev.post(`/api/watch/lists/${id}/status`, { status: "active" }); assert.equal(r.status, 200, JSON.stringify(r.body)); return id;
}

test("Facebook named Pages and comments, TikTok Research API, Telegram channels where the bot is a member", async () => {
  const S = await startServer(cfg()), rev = await login(S.base, "rev");
  try {
    await active(rev, ["facebook", "tiktok", "telegram"], { fb_pages: ["https://www.facebook.com/kdfpage"] });
    await S.ctx.watchCollector.tick();
    const P = S.ctx.db.prepare("SELECT platform, post_id, account, author_name, url, likes, comments, shares, views, text, collected_via FROM watch_posts ORDER BY id").all();
    const fb = P.filter(p => p.platform === "Facebook");
    assert.equal(fb.length, 2, "the Page post and the matching comment (the empty post and the unrelated comment are not kept)");
    assert.equal(fb[0].account, "Example Defence Page"); assert.equal(fb[0].likes, 220); assert.equal(fb[0].shares, 14);
    assert.equal(fb[1].account, null, "commenters are not identified"); assert.match(fb[1].author_name, /comment on a post by Example Defence Page/);
    const tt = P.find(p => p.platform === "TikTok"); assert.equal(tt.url, "https://www.tiktok.com/@parade_fan/video/7300000000000000001"); assert.equal(tt.views, 12000);
    const q = JSON.parse(seen.find(x => x.path === "/tt/v2/research/video/query/").body); assert.equal(q.query.or[0].field_name, "keyword"); assert.match(q.start_date, /^\d{8}$/);
    const tg = P.filter(p => p.platform === "Telegram"); assert.deepEqual(tg.map(x => x.account).sort(), ["@publicnews", "Our own private channel"], "public channels and our listed own channel only; never groups or other private channels");
    assert.equal(tg.find(x => x.account === "@publicnews").url, "https://t.me/publicnews/77");
    assert.equal(JSON.parse(seen.find(x => x.path.endsWith("getUpdates")).q.allowed_updates).join(), "channel_post,edited_channel_post");
    // second run: Telegram continues from the last update; nothing stored twice
    S.ctx.db.prepare("UPDATE watch_source_state SET next_run_at = NULL").run(); await new Promise(r => setTimeout(r, 30)); await S.ctx.watchCollector.tick();
    assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, P.length);
    assert.equal(JSON.parse(S.ctx.db.prepare("SELECT value_json FROM watch_service WHERE key = 'telegram_updates'").get().value_json).offset, 504, "the next request confirms the updates already received");
  } finally { await S.close(); }
});

test("WhatsApp Business webhook: verification, signature, pseudonymised senders, only matching messages stored", async () => {
  const S = await startServer(cfg()), rev = await login(S.base, "rev");
  try {
    await active(rev, ["whatsapp_business"]);
    assert.equal(await (await fetch(`${S.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`)).text(), "12345");
    assert.equal((await fetch(`${S.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" }, contacts: [{ profile: { name: "A Citizen" }, wa_id: "254700000001" }],
      messages: [{ from: "254700000001", id: "wamid.1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Is this message about KDF recruitment fees real?" } },
        { from: "254700000002", id: "wamid.2", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hello, what time do you open?" } }] } }] }] });
    const sig = "sha256=" + crypto.createHmac("sha256", "app-secret").update(payload).digest("hex");
    assert.equal((await fetch(`${S.base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0") }, body: payload })).status, 401);
    assert.equal((await fetch(`${S.base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: payload })).status, 200);
    const rows = S.ctx.db.prepare("SELECT * FROM watch_posts").all(); assert.equal(rows.length, 1, "the unrelated message is not stored");
    assert.match(rows[0].account, /^sender [0-9a-f]{10}$/); assert.ok(!JSON.stringify(rows).includes("254700000001") && !JSON.stringify(rows).includes("A Citizen"), "no phone number or name is stored");
    const t = (await rev.get("/api/watch/overview")).body.status.platforms.find(p => /WhatsApp/.test(p.platform)); assert.equal(t.status, "working"); assert.ok(t.last_success);
  } finally { await S.close(); }
});

test("capability table: statuses, last successful collection, live checks recorded apart from simulated tests", async () => {
  const S = await startServer({ ...cfg({ tiktokClientSecret: "wrong", facebookToken: "", telegramToken: "bad" }), collect: { timeoutMs: 3000, bases: { tiktok: `${F}/tt`, telegram: `${F}/tg`, x: `${F}/none` }, xBearer: "", youtubeKey: "" } });
  const rev = await login(S.base, "rev"), ad = await login(S.base, "admin");
  try {
    let T = Object.fromEntries((await rev.get("/api/watch/overview")).body.status.platforms.map(p => [p.platform, p]));
    assert.equal(T.LinkedIn.status, "unavailable"); assert.equal(T.Facebook.status, "restricted", "approval-gated and not configured");
    assert.equal(T.YouTube.status, "needs configuration"); assert.equal(T["News websites (RSS/Atom)"].status, "needs configuration");
    assert.equal(T.TikTok.status, "needs configuration", "credentials set but nothing collected yet");
    for (const p of Object.values(T)) for (const k of ["content", "search", "access", "mode", "quotas", "coverage", "docs"]) assert.ok(p[k], `${p.platform} ${k}`);
    await active(rev, ["tiktok", "telegram"]); await S.ctx.watchCollector.tick();
    T = Object.fromEntries((await rev.get("/api/watch/overview")).body.status.platforms.map(p => [p.platform, p]));
    assert.equal(T.TikTok.status, "restricted"); assert.match(T.TikTok.detail, /Client key or secret is incorrect/);
    assert.equal(T["Telegram (public channels)"].status, "restricted"); assert.match(T["Telegram (public channels)"].detail, /\[token\]|refused/); assert.ok(!JSON.stringify(T).includes("botbad"), "the bot token never appears");
    assert.equal((await rev.post("/api/watch/sources/tiktok/check", {})).status, 403, "live checks are for administrators");
    const lc = await ad.post("/api/watch/sources/tiktok/check", {}); assert.equal(lc.body.ok, false);
    T = Object.fromEntries((await rev.get("/api/watch/overview")).body.status.platforms.map(p => [p.platform, p]));
    assert.equal(T.TikTok.connectors_state[0].live_check.ok, false); assert.equal(T.YouTube.connectors_state[0].live_check, null, "never verified live");
  } finally { await S.close(); }
});

test("manual link submission and file import are labelled; retention deletes only what no open alert or case needs", async () => {
  const S = await startServer(cfg({ facebookToken: "", tiktokClientKey: "", telegramToken: "" })), rev = await login(S.base, "rev"), ana = await login(S.base, "ana"), ad = await login(S.base, "admin");
  try {
    const id = await active(rev, ["news"], { feeds: ["https://news.example/rss"] });
    let r = await ana.post(`/api/watch/lists/${id}/submit`, { url: "https://www.tiktok.com/@someone/video/7300000000000000099", text: "Video says KDF soldiers were seen in Kismayu yesterday" });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.platform, "TikTok");
    r = await ana.post(`/api/watch/lists/${id}/submit`, { url: "https://www.facebook.com/somepage/posts/123", text: "Nothing relevant here" }); assert.equal(r.status, 422); assert.match(r.body.error, /does not match/);
    const a = (await rev.get("/api/watch/alerts")).body.alerts[0]; assert.match(a.reason, /Public link submitted by an analyst/); assert.match(a.collected_via, /submitted by ANA/);
    const fd = new FormData(); fd.append("file", new Blob(["platform,account,created_at,text,url,likes\nFacebook,page_a,2026-10-25T10:00:00Z,KDF hands over a borehole in Wajir,https://facebook.com/x/1,40\nFacebook,page_b,2026-10-25T11:00:00Z,Market prices today,https://facebook.com/x/2,3\n"]), "export.csv");
    assert.equal((await rev.post(`/api/watch/lists/${id}/import`, undefined, { form: fd })).status, 400, "the basis for using the file is required");
    fd.append("authorisation", "Export from our own Page insights");
    r = await rev.post(`/api/watch/lists/${id}/import`, undefined, { form: fd }); assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.rows, 2); assert.equal(r.body.new_matches, 1);
    assert.match(S.ctx.db.prepare("SELECT collected_via FROM watch_posts WHERE text LIKE '%borehole%'").get().collected_via, /File import “export.csv” \(SHA-256 [0-9a-f]{12}\) by REV; basis: Export from our own Page insights/);
    // retention: age the posts; the one behind an open alert stays, the dismissed one goes
    const al = (await rev.get("/api/watch/alerts")).body.alerts, imp = al.find(x => /borehole/.test(x.post_text));
    await rev.post(`/api/watch/alerts/${imp.id}/action`, { action: "dismiss", note: "routine" });
    S.ctx.db.prepare("UPDATE watch_posts SET first_detected_at = '2025-01-01T00:00:00Z'").run();
    await ad.put("/api/admin/retention", { watch_days: 30 });
    const due = (await ad.get("/api/admin/retention")).body.due.watch; assert.equal(due.n, 1);
    r = await ad.post("/api/admin/retention/apply", { confirm: true, watch: true }); assert.equal(r.body.watch, 1);
    assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, 1); assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'Retention: mention watch posts deleted'").get().n === 1);
  } finally { await S.close(); }
});

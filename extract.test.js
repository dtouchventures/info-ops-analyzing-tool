// Content extraction (AIVS 1.20): every platform adapter against local stand-ins for the platforms' official
// services (no internet). Checks: link detection and normalisation, Facebook share redirects, Graph API and oEmbed
// kept apart (metadata vs text), X API fallback with rate-limit cooldown, YouTube Data API, TikTok short links,
// Instagram, news pages (SSRF-protected, previewed copy reused), credentials never returned, honest failures,
// and the content analysis that receives the extracted text.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, login } from "./helpers.js";
import { normalizeLink, facebookIds, youtubeId } from "../server/lib/social.js";

const SECRETS = ["META|CLIENTSECRET123", "XBEARER-SECRET-456", "YTKEY-SECRET-789", "FBTOKEN-SECRET-000"];
let S, S2, ana, ana2, fake, F, calls = [];
const ARTICLE = `<!doctype html><html><head><title>Ignore</title><meta property="og:title" content="County opens new borehole in Garissa"><meta property="og:site_name" content="Practice News">
  <meta property="article:published_time" content="2026-10-20T07:30:00Z"></head><body><nav>Home | News</nav><article><h1>County opens new borehole in Garissa</h1>
  <p>The county government of Garissa opened a new borehole on Monday, the governor said. The project cost Sh12 million and will serve 4,000 residents, according to the county water office.</p>
  <p>Residents said the water would reduce the long walks to the river during the dry season. The county plans two more boreholes next year.</p></article><footer>Contact</footer></body></html>`;

before(async () => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname; calls.push(p + u.search);
    const json = (code, o, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
    const go = loc => { res.writeHead(302, { location: loc }); res.end(); };
    // Facebook share links (Facebook's own redirect) and the Graph API / oEmbed
    if (p === "/fbres/share/p/OK1/") return go("https://www.facebook.com/kdfinfo/posts/123456789?rdid=abc");
    if (p === "/fbres/share/p/LOGIN/") return go("https://www.facebook.com/login/?next=%2Fshare%2Fp%2FLOGIN%2F");
    if (p === "/fbres/share/p/AWAY/") return go("https://evil.example/landing");
    if (p === "/graph/v26.0/kdfinfo") return json(200, { id: "100200300" });
    if (p === "/graph/v26.0/otherpage") return json(200, { id: "999" });
    if (p === "/graph/v26.0/100200300_123456789") { assert.equal(u.searchParams.get("access_token"), SECRETS[3]); return json(200, { id: "100200300_123456789", message: "SYNTHETIC TEST POST: KDF engineers repaired the Modika bridge this week.", created_time: "2026-10-19T09:00:00+0000", permalink_url: "https://www.facebook.com/kdfinfo/posts/123456789", from: { name: "Practice Page" } }); }
    if (p === "/graph/v26.0/999_555") return json(400, { error: { message: "(#10) This endpoint requires the 'pages_read_engagement' permission or the 'Page Public Content Access' feature", code: 10 } });
    if (p === "/graph/v26.0/7770000001") return json(400, { error: { message: "(#4) Application request limit reached", code: 4 } });
    if (p === "/meta/v21.0/oembed_post") { assert.equal(u.searchParams.get("access_token"), SECRETS[0]); return u.searchParams.get("url").includes("otherpage") ? json(200, { author_name: "Other Page", html: `<blockquote class="fb-xfbml-parse-ignore"><p>Short version of the post…</p>Posted by <a href="#">Other Page</a></blockquote>` }) : json(200, { author_name: "Some Page", html: "<blockquote></blockquote>" }); }
    if (p === "/meta/v21.0/oembed_video") return json(400, { error: { message: "Invalid URL" } });
    if (p === "/meta/v21.0/instagram_oembed") return json(200, { author_name: "practice_ig", title: "SYNTHETIC caption: flooding near Garissa town #floods" });
    // X: public embed fails for these IDs; the API knows one of them
    if (p === "/x/oembed") return json(404, { error: "not found" });
    if (p === "/xapi/2/tweets/1846000000000000777") { assert.equal(req.headers.authorization, `Bearer ${SECRETS[1]}`); return json(200, { data: { id: "1846000000000000777", text: "short", note_tweet: { text: "SYNTHETIC long post: the full text of a long X post that the embed did not show." }, created_at: "2024-10-14T09:01:02.000Z", author_id: "42", lang: "en", public_metrics: { like_count: 5, retweet_count: 2, reply_count: 1, impression_count: 300 } }, includes: { users: [{ id: "42", username: "practice_desk", name: "Practice Desk" }] } }); }
    if (p === "/xapi/2/tweets/1846000000000000888") return json(429, { title: "Too Many Requests" }, { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) });
    // YouTube Data API and embed
    if (p === "/ytapi/youtube/v3/videos") { assert.equal(u.searchParams.get("key"), SECRETS[2]); return json(200, { items: u.searchParams.get("id") === "abc123def45" ? [{ snippet: { title: "Floods in Budalang'i", description: "SYNTHETIC description: water levels rose overnight.", channelTitle: "Practice Channel", publishedAt: "2026-10-18T12:00:00Z", tags: ["floods"] }, contentDetails: { duration: "PT2M10S" }, statistics: { viewCount: "1200" } }] : [] }); }
    if (p === "/yt/oembed") return json(200, { title: "Embed title", author_name: "Practice Channel", author_url: "https://www.youtube.com/@practicechannel" });
    // TikTok short link and embed
    if (p === "/ttres/ZMabc/") { res.writeHead(301, { location: "https://www.tiktok.com/@practice_tt/video/7300000000000000000?is_from_webapp=1" }); return res.end(); }
    if (p === "/tt/oembed") return json(200, { title: "SYNTHETIC TikTok caption", author_name: "Practice TT", author_unique_id: "practice_tt" });
    if (p === "/article.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(ARTICLE); }
    res.writeHead(404); res.end();
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  const bases = { x: `${F}/x`, xapi: `${F}/xapi`, youtube: `${F}/yt`, ytapi: `${F}/ytapi`, tiktok: `${F}/tt`, meta: `${F}/meta`, graph: `${F}/graph`, telegram: `${F}/tg`, resolve: { "www.facebook.com": `${F}/fbres`, "vm.tiktok.com": `${F}/ttres` } };
  S = await startServer({ allowPrivateFetch: true, social: { timeoutMs: 3000, metaToken: SECRETS[0], bases }, collect: { xBearer: SECRETS[1], youtubeKey: SECRETS[2], timeoutMs: 3000 }, platforms: { facebookToken: SECRETS[3], graphVersion: "v26.0" }, watch: { enabled: false } });
  S2 = await startServer({ social: { timeoutMs: 3000, bases } });   // no credentials, and private addresses refused
  ana = await login(S.base, "ana"); ana2 = await login(S2.base, "ana");
});
after(async () => { await S.close(); await S2.close(); fake.close(); });
const noSecrets = o => { const t = JSON.stringify(o); for (const s of SECRETS) assert.ok(!t.includes(s), "a credential was returned to the browser"); };
const X = async (url, a = ana) => { const r = await a.post("/api/extract", { url }); assert.equal(r.status, 200, JSON.stringify(r.body)); noSecrets(r.body); return r.body; };

test("link detection and normalisation: tracking removed, mobile hosts mapped, IDs read", () => {
  assert.equal(normalizeLink("http://m.facebook.com/kdfinfo/posts/123?mibextid=xyz&fbclid=1"), "https://www.facebook.com/kdfinfo/posts/123");
  assert.equal(normalizeLink("https://mobile.twitter.com/a/status/1?s=20&t=abc"), "https://x.com/a/status/1");
  assert.equal(normalizeLink("https://youtu.be/abc123def45?si=x"), "https://youtu.be/abc123def45");
  assert.equal(normalizeLink("https://m.youtube.com/watch?v=abc123def45&feature=share&pp=1"), "https://www.youtube.com/watch?v=abc123def45");
  assert.equal(normalizeLink("javascript:alert(1)"), null); assert.equal(normalizeLink("https://user:pw@example.com/"), null);
  assert.deepEqual(facebookIds("https://www.facebook.com/permalink.php?story_fbid=987654321&id=100200300"), { kind: "post", owner: "100200300", post: "987654321", pfbid: false });
  assert.equal(facebookIds("https://www.facebook.com/kdfinfo/posts/pfbid02abc").pfbid, true);
  assert.equal(facebookIds("https://www.facebook.com/reel/1234567890").video, "1234567890");
  assert.equal(facebookIds("https://www.facebook.com/groups/abc/posts/12345").kind, "group");
  assert.equal(youtubeId("https://www.youtube.com/shorts/abc123def45"), "abc123def45");
});

test("Facebook: share link resolved through Facebook's redirect, full text from the Graph API, token kept on the server", async () => {
  const r = await X("https://www.facebook.com/share/p/OK1/");
  assert.equal(r.kind, "social"); assert.equal(r.platform, "Facebook"); assert.equal(r.status, "ok"); assert.equal(r.text_status, "full");
  assert.equal(r.resolved_url, "https://www.facebook.com/kdfinfo/posts/123456789"); assert.match(r.text, /Modika bridge/); assert.equal(r.text_source, "Facebook Graph API");
  assert.equal(r.author_name, "Practice Page"); assert.equal(r.posted_at, "2026-10-19T09:00:00.000Z"); assert.match(r.posted_basis, /Graph API/);
  assert.deepEqual(r.attempts.map(a => a.method), ["share link redirect", "Facebook Graph API"]);
  assert.ok(!calls.some(c => c.startsWith("/meta/")), "oEmbed is not needed when the Graph API gave the text");
});

test("Facebook: Graph API refused → oEmbed gives only a possibly shortened text, labelled as such; sign-in and off-site redirects are not followed", async () => {
  const r = await X("https://www.facebook.com/otherpage/posts/555");
  assert.equal(r.status, "partial"); assert.equal(r.text_status, "partial"); assert.equal(r.text, "Short version of the post…"); assert.match(r.message, /shortened/);
  assert.equal(r.attempts[0].result, "refused"); assert.match(r.attempts[0].detail, /Page Public Content Access/);
  const login = await X("https://www.facebook.com/share/p/LOGIN/");
  assert.equal(login.attempts[0].result, "blocked"); assert.match(login.attempts[0].detail, /does not sign in/); assert.equal(login.text, null); assert.notEqual(login.status, "ok");
  const away = await X("https://www.facebook.com/share/p/AWAY/"); assert.match(away.attempts[0].detail, /off the platform/); assert.ok(!calls.some(c => c.includes("landing")));
  const author = await X("https://www.facebook.com/somepage/posts/pfbid02xyz");
  assert.equal(author.status, "no_text"); assert.equal(author.author_name, "Some Page"); assert.match(author.attempts.find(a => a.method === "Facebook Graph API").detail, /pfbid/);
  const g = await X("https://www.facebook.com/groups/12345/posts/67890"); assert.equal(g.status, "restricted"); assert.match(g.message, /does not read groups/);
});

test("X: public embed fails → X API v2 gives the full long text, exact time and metrics; a rate limit stops further calls", async () => {
  const r = await X("https://x.com/practice_desk/status/1846000000000000777?s=20");
  assert.equal(r.status, "ok"); assert.match(r.text, /^SYNTHETIC long post/); assert.equal(r.text_source, "X API v2 (post lookup)"); assert.equal(r.posted_at, "2024-10-14T09:01:02.000Z"); assert.equal(r.metrics.views, 300);
  const cost = S.ctx.db.prepare("SELECT est_cost_usd FROM api_usage WHERE service = 'x_api' AND status = 'ok'").get(); assert.ok(cost.est_cost_usd > 0, "the paid read is recorded with its cost");
  const lim = await X("https://x.com/a/status/1846000000000000888"); assert.equal(lim.attempts.at(-1).result, "rate limited");
  const n = calls.filter(c => c.startsWith("/xapi/2/tweets/1846000000000000888")).length;
  const again = await X("https://x.com/a/status/1846000000000000888"); assert.equal(again.attempts.at(-1).result, "skipped");
  assert.equal(calls.filter(c => c.startsWith("/xapi/2/tweets/1846000000000000888")).length, n, "no call during the cooldown");
});

test("YouTube: Data API gives title, description, channel, date and length; transcripts are explained as unavailable", async () => {
  const r = await X("https://youtu.be/abc123def45?si=share");
  assert.equal(r.status, "ok"); assert.match(r.text, /^Floods in Budalang'i\n\nSYNTHETIC description/); assert.equal(r.author_name, "Practice Channel"); assert.equal(r.duration, "PT2M10S"); assert.equal(r.posted_at, "2026-10-18T12:00:00.000Z");
  assert.match(r.transcript.note, /owner/); assert.equal(r.transcript.available, false);
  const gone = await X("https://www.youtube.com/watch?v=zzzzzzzzzzz"); assert.equal(gone.status, "unavailable"); assert.match(gone.message, /private, removed/);
});

test("TikTok short link resolved; Instagram caption marked as possibly shortened", async () => {
  const t = await X("https://vm.tiktok.com/ZMabc/");
  assert.equal(t.resolved_url, "https://www.tiktok.com/@practice_tt/video/7300000000000000000"); assert.equal(t.text, "SYNTHETIC TikTok caption"); assert.equal(t.account, "@practice_tt"); assert.ok(t.posted_at, "upload time from the video ID");
  const i = await X("https://www.instagram.com/p/ABC123/?igsh=xyz");
  assert.equal(i.text_status, "partial"); assert.match(i.text, /flooding near Garissa/); assert.equal(i.author_name, "practice_ig");
});

test("without credentials: each platform says which setting is needed, nothing is sent to Meta, nothing is invented", async () => {
  const before = calls.length;
  const fb = await X("https://www.facebook.com/share/p/18j15o3bDz/", ana2);
  assert.equal(fb.status, "not_configured"); assert.equal(fb.text, null); assert.deepEqual(fb.needs.map(n => n.setting).sort(), ["FACEBOOK_ACCESS_TOKEN", "META_OEMBED_TOKEN"]);
  const ig = await X("https://www.instagram.com/reel/XYZ/", ana2); assert.equal(ig.status, "not_configured"); assert.match(ig.message, /META_OEMBED_TOKEN/);
  const yt = await X("https://www.youtube.com/watch?v=abc123def45", ana2); assert.equal(yt.text_status, "title"); assert.ok(yt.needs.some(n => n.setting === "YOUTUBE_API_KEY"));
  assert.ok(!calls.slice(before).some(c => c.startsWith("/meta/") || c.startsWith("/graph/") || c.startsWith("/ytapi/")), "no call to a credentialled API without credentials");
  const meta = (await ana2.get("/api/meta")).body.social; noSecrets((await ana.get("/api/meta")).body);
  assert.equal(meta.find(s => s.key === "meta").configured, false); assert.match(meta.find(s => s.key === "meta").needs, /META_OEMBED_TOKEN/);
});

test("news page: headline, text, date and site; private addresses refused; the previewed copy is the one archived; analyst edits recorded", async () => {
  const url = `${F}/article.html`, r = await X(url);
  assert.equal(r.kind, "web"); assert.equal(r.status, "ok"); assert.equal(r.title, "County opens new borehole in Garissa"); assert.equal(r.site, "Practice News"); assert.equal(r.posted_at, "2026-10-20T07:30:00.000Z");
  assert.match(r.text, /Sh12 million/); assert.ok(!/Home \| News|Contact/.test(r.text), "navigation and footer are left out");
  const priv = await X(url, ana2); assert.equal(priv.status, "unavailable"); assert.match(priv.message, /private or local network/);
  const n = calls.filter(c => c === "/article.html").length;
  const v = await ana.post("/api/verify", { input: url, search: false }); assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(calls.filter(c => c === "/article.html").length, n, "the page was not retrieved a second time");
  const c = S.ctx.db.prepare("SELECT claim_text, source_snapshot_sha256 FROM cases WHERE id = ?").get(v.body.id); assert.match(c.claim_text, /^County opens new borehole in Garissa\nThe county government/); assert.ok(c.source_snapshot_sha256);
  const e = await ana.post("/api/verify", { input: url, text: "The borehole cost Sh12 million and serves 4,000 residents.", search: false }); assert.equal(e.status, 201);
  assert.equal(S.ctx.db.prepare("SELECT claim_text FROM cases WHERE id = ?").get(e.body.id).claim_text, "The borehole cost Sh12 million and serves 4,000 residents.");
  assert.match(S.ctx.db.prepare("SELECT details FROM audit_log WHERE entity_id = ? AND action = 'Source page retrieved and archived'").get(e.body.id).details, /"text_edited_by_analyst":true/);
});

test("analysis receives the extracted content: claims, tone, topics, names, red flags and missing evidence, kept apart", async () => {
  await X("https://www.facebook.com/share/p/OK1/");
  const fd = new FormData(); fd.append("url", "https://www.facebook.com/share/p/OK1/"); fd.append("search", "local");
  const r = await ana.post("/api/verify/post", undefined, { form: fd }); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.text_basis, "Facebook Graph API"); assert.ok(r.body.claims.some(c => /Modika bridge/.test(c.text)), "claims come from the extracted text");
  const a = (await ana.get(`/api/cases/${r.body.id}/content-analysis`)).body; noSecrets(a);
  assert.ok(a.recorded.some(x => x.label === "Where the words came from" && x.value === "Facebook Graph API"));
  assert.ok(a.claims.length >= 1 && a.claims.every(c => c.status_label === "Not yet assessed: unverified"));
  assert.ok(a.estimates.entities.places.includes("Modika")); assert.ok(a.estimates.entities.organisations.includes("KDF"));
  assert.ok(a.estimates.sentiment.label && a.estimates.sentiment.method && /not misinformation/.test(a.estimates.sentiment.limits));
  assert.match(a.estimates.similar.limits, /never proof of coordination/); assert.ok(a.missing.some(m => /No evidence has been accepted/.test(m)));
  assert.deepEqual(Object.keys(a.legend), ["recorded", "claim", "estimate", "missing"]);
  const t = new FormData(); for (const [k, v] of Object.entries({ text: "President William Ruto said the Garissa road will open on 3 March 2025. Share before they delete this!", platform: "X (Twitter)", search: "local" })) t.append(k, v);
  const b = (await ana.post("/api/verify/post", undefined, { form: t })).body, a2 = (await ana.get(`/api/cases/${b.id}/content-analysis`)).body;
  assert.ok(a2.estimates.entities.people.includes("President William Ruto")); assert.ok(a2.estimates.red_flags.items.some(f => /share/i.test(f.cue))); assert.ok(a2.estimates.entities.dates.includes("3 March 2025"));
  const view = await login(S.base, "view"); assert.equal((await view.post("/api/extract", { url: "https://x.com/a/status/1" })).status, 403, "only roles that create cases can extract");
});

// last: a rate limit puts the Graph API on hold for this server for an hour
test("Facebook rate limit: the Graph API is not called again until the reset", async () => {
  const r = await X("https://www.facebook.com/watch/?v=7770000001"); assert.equal(r.attempts[0].result, "rate limited");
  const again = await X("https://www.facebook.com/watch/?v=7770000001"); assert.equal(again.attempts[0].result, "rate limited"); assert.match(again.attempts[0].detail, /try again after/);
  assert.equal(calls.filter(c => c.startsWith("/graph/v26.0/7770000001")).length, 1, "no Graph API call during the cooldown");
});

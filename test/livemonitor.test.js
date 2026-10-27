// Live monitoring (1.26) against a local TEST DOUBLE of the Meta Graph API and Google Fact Check Tools. The double
// returns clearly labelled fixture posts ("TEST FIXTURE") for a fixture Page ID; nothing here is real Facebook content.
// The real Graph API is checked on a server with the real token by `npm run check:facebook`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { startServer, login } from "./helpers.js";
import { classify, usageOf, postRow, makeGraph } from "../server/lib/meta-graph.js";
import { confidenceOf, analysePost } from "../server/lib/livemonitor.js";

const TOKEN = "EAATESTPAGETOKEN0123456789abcdefTEST", PAGE = "900000000000001", APP = "1234567", SECRET = "appsecret-test-0001";
const G = { mode: "ok", calls: [], posts: null, debugExpires: null };
const H = h => new Date(Date.now() - h * 3600e3).toISOString().replace(/\.\d+Z$/, "+0000");
function fixturePosts() {
  return [
    { id: `${PAGE}_3`, message: "TEST FIXTURE: KDF recruitment is open. Applicants must pay KSh 2,000 to register through WhatsApp before Friday. Share before it is deleted!", created_time: H(1), updated_time: H(1), permalink_url: `https://www.facebook.com/${PAGE}/posts/3`, full_picture: `${F}/img/p3.jpg`, shares: { count: 4 }, reactions: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } } },
    { id: `${PAGE}_2`, message: "TEST FIXTURE: The county opened two new water points in Garissa town this week.", created_time: H(3), permalink_url: `https://www.facebook.com/${PAGE}/posts/2`, reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 0 } } },
    { id: `${PAGE}_1`, message: "TEST FIXTURE: Thank you to everyone who attended the open day.", created_time: H(30), permalink_url: `https://www.facebook.com/${PAGE}/posts/1`, reactions: { summary: { total_count: 2 } }, comments: { summary: { total_count: 0 } } }];
}
let F, fake, S, ana, rev, admin;
const json = (res, c, o, headers = {}) => { res.writeHead(c, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(o)); };
before(async () => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), q = Object.fromEntries(u.searchParams); G.calls.push({ path: u.pathname, q });
    if (u.pathname.startsWith("/img/")) { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(fs.readFileSync("training/images/case_patrol.jpg")); }
    if (u.pathname === "/v1alpha1/claims:search") return json(res, 200, { claims: /recruit/i.test(q.query || "") ? [{ text: "KDF recruitment requires a KSh 2,000 registration fee on WhatsApp", claimReview: [{ publisher: { name: "Test Fact-check Desk" }, url: "https://factcheck.example/test-kdf-fee", title: "TEST FIXTURE: FALSE — KDF does not charge a recruitment fee", reviewDate: "2026-10-18T00:00:00Z", textualRating: "False" }] }] : [] });
    if (!u.pathname.startsWith("/v26.0/")) { res.writeHead(404); return res.end(); }
    const p = u.pathname.slice(7);
    if (G.mode === "network") { req.socket.destroy(); return; }
    if (p === "debug_token") return q.access_token === `${APP}|${SECRET}` ? json(res, 200, { data: { is_valid: true, type: "PAGE", expires_at: G.debugExpires ?? 0, scopes: ["pages_read_engagement", "pages_show_list"] } }) : json(res, 400, { error: { message: "bad app token", code: 190 } });
    if (q.access_token !== TOKEN) return json(res, 400, { error: { message: `Invalid OAuth access token - Cannot parse access token ${q.access_token}`, type: "OAuthException", code: 190 } });
    if (G.mode === "expired") return json(res, 400, { error: { message: `Error validating access token: Session has expired. token=${TOKEN}`, type: "OAuthException", code: 190, error_subcode: 463 } });
    if (G.mode === "rate") return json(res, 400, { error: { message: "(#80001) There have been too many calls to this Page account.", code: 80001 } }, { "x-business-use-case-usage": JSON.stringify({ [PAGE]: [{ type: "pages", call_count: 100, total_cputime: 30, total_time: 40, estimated_time_to_regain_access: 30 }] }) });
    if (p === "me") return json(res, 200, { id: PAGE, name: "Test Fixture Page" });
    if (p === "") return json(res, 200, Object.fromEntries(String(q.ids || "").split(",").map(id => [id, { id, shares: { count: 400 }, reactions: { summary: { total_count: 900 } }, comments: { summary: { total_count: 50 } } }])));
    if (p === PAGE) return json(res, 200, { id: PAGE, name: "Test Fixture Page", link: `https://www.facebook.com/${PAGE}` });
    if (p === `${PAGE}/posts`) {
      if (G.mode === "nofields" && /reactions/.test(q.fields || "")) return json(res, 400, { error: { message: "(#10) This endpoint requires the 'pages_read_engagement' permission", code: 10 } });
      const all = (G.posts || fixturePosts()).filter(x => !q.since || Date.parse(x.created_time.replace("+0000", "Z")) >= +q.since * 1000);
      // two pages: the first two posts, then the rest through paging.next (which carries the token, as Meta's links do)
      if (q.after === "c2") return json(res, 200, { data: all.slice(2), paging: {} });
      return json(res, 200, { data: all.slice(0, 2), paging: all.length > 2 ? { next: `${F}/v26.0/${PAGE}/posts?after=c2&access_token=${TOKEN}&fields=${encodeURIComponent(q.fields)}&limit=${q.limit}${q.since ? `&since=${q.since}` : ""}` } : {} });
    }
    if (p === "17841400000000001") return json(res, 200, { id: "17841400000000001", username: "test_fixture_ig", media_count: 3 });
    if (p === "17841400000000001/media") return json(res, 200, { data: [{ id: "ig1", caption: "TEST FIXTURE: Instagram caption", timestamp: H(2), permalink: "https://www.instagram.com/p/test", media_type: "IMAGE", media_url: `${F}/img/ig1.jpg`, like_count: 3, comments_count: 1 }] });
    json(res, 404, { error: { message: "Unknown path", code: 100 } });
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ allowPrivateFetch: true, search: { factcheckKey: "fc", factcheckBase: F, timeoutMs: 3000 },
    live: { pageToken: TOKEN, pageIds: PAGE, graphBase: F, appId: APP, appSecret: SECRET, intervalMinutes: 5, initialPosts: 25, tickSeconds: 3600, engagementRefreshMinutes: 30, igUserId: "17841400000000001", igToken: TOKEN } });
  [ana, rev, admin] = await Promise.all([login(S.base, "ana"), login(S.base, "rev"), login(S.base, "admin")]);
  S.ctx.live.ensureSources();
});
after(async () => { await S.ctx.investigations.close(); await S.close(); fake.close(); });
const L = () => S.ctx.live, src = () => S.ctx.db.prepare("SELECT * FROM social_sources WHERE external_id = ?").get(PAGE);
async function settle() { for (let i = 0; i < 600; i++) { await L().work(); const busy = S.ctx.db.prepare("SELECT COUNT(*) n FROM social_posts WHERE analysis_status IN ('pending','analysing','verifying')").get().n; if (!busy && S.ctx.investigations.idle()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error("analysis did not finish"); }

test("Graph client: error classification, usage headers, post mapping, token redaction", () => {
  assert.equal(classify(190, 463), "token"); assert.equal(classify(4), "rate"); assert.equal(classify(80001), "rate"); assert.equal(classify(10), "permission"); assert.equal(classify(100), "request"); assert.equal(classify(2), "temporary");
  const u = usageOf(new Map([["x-app-usage", JSON.stringify({ call_count: 85, total_time: 10, total_cputime: 5 })]]));
  assert.equal(u.max_pct, 85);
  const r = postRow(fixturePosts()[0]); assert.equal(r.likes, 12); assert.equal(r.shares, 4); assert.match(r.image_url, /p3\.jpg/);
  const nb = postRow({ id: "1_2", message: "x", created_time: H(1) }); assert.equal(nb.likes, null, "missing engagement stays empty, not zero");
  assert.equal(makeGraph({ token: TOKEN }).redact(`failed ${TOKEN} access_token=${TOKEN}&x`), "failed [token] access_token=[token]&x");
});

test("token check: the Page is identified and its expiry read from Meta; the token never leaves the server", async () => {
  const v = await L().checkToken({ force: true });
  assert.equal(v.state, "valid"); assert.equal(v.subject_id, PAGE); assert.equal(v.expires_at, "never"); assert.ok(v.scopes.includes("pages_read_engagement"));
  const ov = await ana.get("/api/live/overview");
  assert.equal(ov.body.facebook.token.state, "valid"); assert.equal(ov.body.facebook.token.page, "Test Fixture Page");
  assert.ok(!JSON.stringify(ov.body).includes(TOKEN) && !JSON.stringify(ov.body).includes(SECRET), "no secret in the API answer");
  assert.equal(ov.body.instagram.status, "Not connected", "Instagram is not connected until its test has passed");
});

test("collection: real-shaped posts saved with images and counts, pagination followed, checkpoint saved, duplicates ignored, edits recorded", async () => {
  G.mode = "ok"; G.calls = []; G.posts = null;
  let r = await L().sync(src().id);
  assert.equal(r.fetched, 3); assert.equal(r.new_posts, 3); assert.equal(r.duplicates, 0);
  assert.ok(G.calls.some(c => c.q.after === "c2"), "the second page was read through paging.next");
  const s = src(); assert.equal(s.status, "ok"); assert.ok(s.checkpoint_time); assert.equal(s.fields_level, "full"); assert.ok(Date.parse(s.next_sync_at) > Date.now() + 4 * 60e3, "next run in 5 minutes");
  const p3 = S.ctx.db.prepare("SELECT * FROM social_posts WHERE post_id = ?").get(`${PAGE}_3`);
  assert.equal(p3.likes, 12); assert.equal(p3.shares, 4); assert.ok(p3.image_sha256, "the image was downloaded and stored"); assert.equal(p3.analysis_status, "pending");
  const img = await fetch(`${S.base}/api/live/posts/${p3.id}/image`, { headers: { cookie: ana.cookie } }); assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/jpeg");
  // second run: starts two hours before the checkpoint; the same posts are not stored again
  G.calls = []; r = await L().sync(src().id);
  const call = G.calls.find(c => c.path.endsWith("/posts")); assert.ok(call.q.since, "the second run asks only for posts since the checkpoint");
  assert.equal(r.new_posts, 0); assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM social_posts WHERE source_id = ?").get(src().id).n, 3);
  // an edited post: the new wording is kept and queued for analysis again
  G.posts = fixturePosts(); G.posts[1].message += " Residents should report broken taps to the county."; G.posts[1].updated_time = H(0);
  r = await L().sync(src().id); assert.equal(r.updated, 1);
  const p2 = S.ctx.db.prepare("SELECT * FROM social_posts WHERE post_id = ?").get(`${PAGE}_2`); assert.equal(p2.edited, 1); assert.match(p2.message, /broken taps/);
  const syncs = (await ana.get("/api/live/syncs")).body.syncs; assert.ok(syncs.length >= 3 && syncs.every(x => x.status === "ok"));
  G.posts = null;
});

test("watchlist on live Facebook monitoring: a new post matching the terms raises an alert", async () => {
  const id = (await rev.post("/api/watch/lists", { name: "Recruitment fraud (test)", definition: { terms: ["recruitment"], context: [], sources: ["fb_live"], alert_mode: "every_post" }, authorisation: "Own Page, Page access token" })).body.id;
  await rev.post(`/api/watch/lists/${id}/preview`, {}); const a = await rev.post(`/api/watch/lists/${id}/status`, { status: "active" }); assert.equal(a.status, 200, JSON.stringify(a.body));
  G.posts = [{ id: `${PAGE}_4`, message: "TEST FIXTURE: Beware of fake recruitment notices asking for money. KDF recruitment is free of charge.", created_time: H(0.5), permalink_url: `https://www.facebook.com/${PAGE}/posts/4`, reactions: { summary: { total_count: 1 } }, comments: { summary: { total_count: 0 } } }, ...fixturePosts()];
  const r = await L().sync(src().id); assert.equal(r.new_posts, 1);
  const al = (await rev.get("/api/watch/alerts?limit=20")).body.alerts;
  assert.ok(al.some(x => x.watchlist_id === id && /fake recruitment notices/.test(x.title)), JSON.stringify(al.map(x => x.title)));
  G.posts = null;
});

test("automatic analysis and verification: every new post is analysed; a contradicted claim gets evidence, confidence, review flag, alert and a one-page report", async () => {
  await settle();
  const list = (await ana.get("/api/live/posts?limit=50")).body;
  assert.equal(list.total, 4); assert.ok(list.posts.every(p => ["done", "skipped"].includes(p.analysis_status)), JSON.stringify(list.posts.map(p => [p.id, p.analysis_status, p.analysis_error])));
  const fee = list.posts.find(p => /KSh 2,000/.test(p.message));
  assert.equal(fee.verification, "contradicted"); assert.equal(fee.verification_label, "Contradicted by evidence"); assert.ok(fee.needs_review);
  const d = (await ana.get(`/api/live/posts/${fee.id}`)).body;
  assert.ok(d.analysis.claims.length && d.analysis.indicators.length, "claims and misinformation indicators found"); assert.ok(d.analysis.entities.organisations.includes("KDF"));
  assert.ok(d.analysis.tone && "uncertain" in d.analysis.tone); assert.ok(d.analysis.facts[0].includes("Published by"));
  assert.ok(d.confidence.score >= 40 && d.confidence.criteria.some(c => /fact-check/.test(c.rule)), JSON.stringify(d.confidence));
  const inv = (await ana.get(`/api/investigations/${d.investigation.id}`)).body;
  assert.equal(inv.origin, "live"); assert.equal(inv.result.source.platform, "Facebook"); assert.equal(inv.result.source.input_type, "url");
  assert.ok(inv.result.evidence.some(e => e.source_url === "https://factcheck.example/test-kdf-fee"), "the evidence is kept with the verification");
  assert.match(inv.result.source.method, /Graph API/); assert.ok(inv.case_id);
  const pdf = Buffer.from(await (await fetch(`${S.base}/api/investigations/${d.investigation.id}/report.pdf`, { headers: { cookie: ana.cookie } })).arrayBuffer());
  assert.equal((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1, "one-page PDF report");
  const html = (await ana.get(`/api/investigations/${d.investigation.id}/report.html`)).body; assert.match(html, /AI-Generated \(not reviewed\)/);
  const al = (await ana.get("/api/live/alerts?group=1")).body;
  const v = al.alerts.find(a => a.kind === "verification" && a.post_id === fee.id); assert.ok(v, JSON.stringify(al.alerts.map(a => a.kind)));
  assert.ok(v.priority_reasons.length && v.detail.priority_rule, "the priority is explained"); assert.ok(al.groups.length >= 1);
  // the other posts were analysed too, and none was labelled false without evidence
  assert.ok(list.posts.filter(p => p.id !== fee.id).every(p => p.verification !== "contradicted"));
});

test("analyst review, approval and alert actions; escalation needs a reason", async () => {
  const fee = (await ana.get("/api/live/posts?verification=contradicted")).body.posts[0], invId = fee.investigation_id;
  assert.equal((await rev.post(`/api/investigations/${invId}/approve`, { note: "x" })).status, 409, "a report is reviewed before it is approved");
  assert.equal((await rev.post(`/api/investigations/${invId}/review`, { note: "Checked the fact-check and the post." })).status, 200);
  assert.equal((await rev.post(`/api/investigations/${invId}/approve`, { note: "ok" })).status, 403, "the reviewer cannot also approve");
  assert.equal((await admin.post(`/api/investigations/${invId}/approve`, { note: "Approved for internal reporting." })).status, 200);
  assert.match((await ana.get(`/api/investigations/${invId}/report.html`)).body, /Approved by ADMIN/);
  const a = (await ana.get("/api/live/alerts?kind=verification")).body.alerts[0];
  assert.equal((await ana.post(`/api/live/alerts/${a.id}/action`, { action: "escalate" })).status, 400);
  const r = await ana.post(`/api/live/alerts/${a.id}/action`, { action: "escalate", note: "Possible recruitment fraud; senior analyst to decide on a public clarification." });
  assert.equal(r.status, 200); assert.equal(r.body.status, "escalated"); assert.ok(r.body.events.some(e => e.action === "escalate"));
  assert.equal((await (await login(S.base, "view")).post(`/api/live/alerts/${a.id}/action`, { action: "dismiss", note: "x" })).status, 403);
});

test("Verify Information with a link to a collected post uses the stored record, without calling Meta again", async () => {
  G.calls = [];
  const r = await ana.post("/api/investigations", undefined, { form: (() => { const f = new FormData(); f.append("url", `https://www.facebook.com/${PAGE}/posts/2`); return f; })() });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  for (let i = 0; i < 300; i++) { const g = (await ana.get(`/api/investigations/${r.body.id}`)).body; if (g.status === "done") { assert.match(g.result.content, /water points/); assert.equal(g.result.source.platform, "Facebook"); break; } await new Promise(ok => setTimeout(ok, 100)); }
  assert.ok(!G.calls.some(c => c.path.startsWith("/v26.0/")), "no Graph API request");
});

test("failures: expired token, rate limit, missing permission and network errors are handled safely and never leak the token", async () => {
  // missing engagement permission: falls back to the basic fields that were tested, and says so
  G.mode = "nofields"; G.posts = [{ id: `${PAGE}_5`, message: "TEST FIXTURE: Basic-field post.", created_time: H(0.2), permalink_url: `https://www.facebook.com/${PAGE}/posts/5` }];
  S.ctx.db.prepare("UPDATE social_sources SET backoff_until = NULL WHERE id = ?").run(src().id);
  let r = await L().sync(src().id); assert.equal(r.new_posts, 1); assert.match(r.note, /not available with this token's permissions/); assert.equal(src().fields_level, "basic");
  assert.equal(S.ctx.db.prepare("SELECT likes FROM social_posts WHERE post_id = ?").get(`${PAGE}_5`).likes, null);
  S.ctx.db.prepare("UPDATE social_sources SET fields_level = 'full' WHERE id = ?").run(src().id);
  // rate limit: Meta's announced wait is respected
  G.mode = "rate"; r = await L().sync(src().id); assert.equal(r.kind, "rate");
  let s = src(); assert.equal(s.status, "rate_limited"); assert.ok(Date.parse(s.backoff_until) - Date.now() >= 29 * 60e3, "waits the 30 minutes Meta announced");
  // network failure: retried later with a short back-off
  G.mode = "network"; r = await L().sync(src().id); assert.equal(r.kind, "network"); assert.equal(src().status, "retrying");
  // expired token: collection stops, a high-priority alert explains why, the scheduler does not keep retrying
  G.mode = "expired"; r = await L().sync(src().id); assert.equal(r.kind, "token"); assert.match(r.error, /expired/);
  s = src(); assert.equal(s.status, "token_refused");
  const al = (await ana.get("/api/live/alerts?kind=collection")).body.alerts; assert.ok(al.some(a => a.priority === "high" && /stopped/.test(a.title)));
  S.ctx.db.prepare("UPDATE social_sources SET backoff_until = NULL, next_sync_at = NULL WHERE id = ?").run(src().id); G.calls = [];
  await L().tick(); assert.ok(!G.calls.some(c => c.path.endsWith("/posts")), "a refused token is not retried by the scheduler");
  const ov = (await ana.get("/api/live/overview")).body; assert.equal(ov.facebook.connection.state, "token_refused");
  // nothing stored or returned contains the token
  const dump = JSON.stringify([S.ctx.db.prepare("SELECT * FROM social_api_errors").all(), S.ctx.db.prepare("SELECT * FROM social_syncs").all(), S.ctx.db.prepare("SELECT * FROM social_sources").all(),
    S.ctx.db.prepare("SELECT * FROM audit_log").all(), S.ctx.db.prepare("SELECT * FROM live_alerts").all(), ov, (await admin.get("/api/live/errors")).body]);
  assert.ok(!dump.includes(TOKEN), "the token appears nowhere"); assert.ok(dump.includes("[token]") || dump.includes("expired"));
  // a new valid check (token replaced and confirmed) lets collection resume
  G.mode = "ok"; assert.equal((await rev.post("/api/live/check")).body.state, "valid");
  S.ctx.db.prepare("UPDATE social_sources SET backoff_until = NULL, next_sync_at = NULL, status = 'idle' WHERE id = ?").run(src().id);
  await L().tick(); assert.equal(src().status, "ok"); G.posts = null;
});

test("unusual posting frequency and emerging topics are detected against history, with explained priorities", async () => {
  const db = S.ctx.db, sid = src().id, ins = db.prepare("INSERT INTO social_posts(source_id,platform,post_id,message,created_time,collected_at,updated_at,analysis_status) VALUES (?,?,?,?,?,?,?,'done')");
  for (let d = 2; d <= 12; d++) ins.run(sid, "facebook", `hist-${d}`, `TEST FIXTURE: daily notice number ${d}.`, new Date(Date.now() - d * 864e5).toISOString(), new Date().toISOString(), new Date().toISOString());
  for (let i = 0; i < 7; i++) ins.run(sid, "facebook", `burst-${i}`, `TEST FIXTURE: update ${i} on the situation in Mandera #ManderaUpdate`, new Date(Date.now() - i * 1800e3).toISOString(), new Date().toISOString(), new Date().toISOString());
  const r = L().checks(sid);
  assert.equal(r.frequency, 1); assert.ok(r.topics >= 1);
  const al = (await ana.get("/api/live/alerts?group=1")).body.alerts;
  const f = al.find(a => a.kind === "frequency"); assert.ok(f && /usual/.test(f.priority_reasons[0]) && /not a finding/.test(f.reason));
  const t = al.find(a => a.kind === "emerging_topic" && /mandera/i.test(a.title)); assert.ok(t, JSON.stringify(al.map(a => a.title)));
  assert.ok(!al.some(a => /coordinat/i.test(a.title)), "no coordination claim from frequency or repetition");
});

test("engagement refresh stores public counts and flags an unusual jump", async () => {
  S.ctx.db.prepare("UPDATE social_sources SET last_engagement_at = NULL, fields_level = 'full' WHERE id = ?").run(src().id);
  S.ctx.db.prepare("UPDATE social_posts SET likes = 2, comments = 0, shares = 0 WHERE post_id LIKE 'hist-%'").run();   // the Page's usual level
  const r = await L().refreshEngagement(); assert.ok(r.posts >= 1, JSON.stringify(r));
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM social_post_metrics").get().n >= 1);
  assert.ok((await ana.get("/api/live/alerts?kind=engagement")).body.alerts.length >= 1);
});

test("dashboard figures come from the database; Training fixtures stay in Training mode", async () => {
  const ov = (await ana.get("/api/live/overview")).body, db = S.ctx.db;
  assert.equal(ov.counts.total_posts, db.prepare("SELECT COUNT(*) n FROM social_posts WHERE is_training = 0").get().n);
  assert.equal(ov.counts.completed_reports, db.prepare("SELECT COUNT(*) n FROM investigations WHERE is_training = 0 AND status = 'done'").get().n);
  assert.ok(ov.facebook.last_successful_sync); assert.ok(ov.counts.live_watchlists >= 1);
  assert.equal((await ana.post("/api/live/training/sample")).status, 400, "practice posts are refused in Operational mode");
  const t = await ana.post("/api/live/training/sample?training=1"); assert.equal(t.status, 201); assert.equal(t.body.new_posts, 5);
  await settle();
  const tr = (await ana.get("/api/live/overview?training=1")).body; assert.equal(tr.counts.total_posts, 5); assert.equal(tr.facebook.connection.state, "training");
  assert.ok(tr.recent_posts.every(p => /^PRACTICE/.test(p.message) && p.is_training));
  assert.equal((await ana.get("/api/live/overview")).body.counts.total_posts, ov.counts.total_posts, "operational figures unchanged");
  const ops = (await ana.get("/api/live/posts?limit=200")).body.posts; assert.ok(ops.every(p => !p.is_training));
  // filters
  assert.ok((await ana.get("/api/live/posts?verification=contradicted")).body.posts.every(p => p.verification === "contradicted"));
  assert.ok((await ana.get(`/api/live/posts?source=${src().id}&priority=medium`)).body.posts.length >= 0);
});

test("Instagram: Not connected until the connection test succeeds", async () => {
  assert.equal((await ana.get("/api/live/overview")).body.instagram.connected, false);
  assert.equal((await ana.post("/api/live/instagram/test")).status, 403);
  const r = (await rev.post("/api/live/instagram/test")).body; assert.equal(r.ok, true); assert.equal(r.username, "test_fixture_ig");
  const ig = (await ana.get("/api/live/overview")).body.instagram; assert.equal(ig.connected, true); assert.match(ig.note, /not all public accounts/);
});

test("confidence and local analysis are documented and conservative", () => {
  const none = confidenceOf({ overall: { verdict: "insufficient" }, evidence: [], source: {} }); assert.ok(none.score <= 10 && none.level === "Low");
  const nv = confidenceOf({ overall: { verdict: "not_verifiable" }, evidence: [] }); assert.equal(nv.score, null);
  const conflict = confidenceOf({ overall: { verdict: "insufficient" }, source: { published_at: "x", account: "y" }, evidence: [{ stance: "supports", tier: "news" }, { stance: "contradicts", tier: "official" }] });
  assert.ok(conflict.criteria.some(c => c.points < 0));
  const a = analysePost({ id: 1, message: "TEST FIXTURE: Breaking! Send KSh 500 to this number to claim your prize. Share now!", created_time: H(1) }, { source: { name: "P" } });
  assert.ok(a.indicators.length); assert.ok(a.inferences.some(t => /do not show that this post is false/.test(t)));
});

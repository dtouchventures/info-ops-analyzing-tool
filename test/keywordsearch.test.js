// Keyword search and monitoring (1.27) against local TEST DOUBLES of GDELT, the Brave News API, a news site with an RSS
// feed, the YouTube Data API and an Ollama server. Every item below is a labelled fixture ("TEST FIXTURE"); the real
// sources are checked on a connected server with `npm run check:search -- "<keyword>"`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { startServer, login } from "./helpers.js";
import { parseQuery, urlKey, situation, analyseItem } from "../server/lib/keywordsearch.js";

let F, fake, S, ana, rev, admin;
const seen = [], H = h => new Date(Date.now() - h * 3600e3);
const gd = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const STATE = { braveFail: false, extra: false };
before(async () => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), q = Object.fromEntries(u.searchParams), j = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    seen.push({ path: u.pathname, q, headers: req.headers });
    if (u.pathname === "/api/v2/doc/doc") {
      const arts = [
        { url: `${F}/news/lamu-ferry?utm_source=gdelt`, title: "TEST FIXTURE: Ferry capsizes near Lamu, 12 people missing", seendate: gd(H(3)), domain: "fixture-news-a.example", language: "English", socialimage: `${F}/img/a.jpg` },
        { url: `${F}/news/lamu-ferry-2`, title: "TEST FIXTURE: Kenya Navy says 20 people missing after Lamu ferry accident", seendate: gd(H(2)), domain: "fixture-news-b.example", language: "English" },
        { url: `${F}/news/lamu-ferry-3`, title: "TEST FIXTURE: Rescue teams search for missing passengers after Lamu ferry accident", seendate: gd(H(1)), domain: "fixture-news-c.example", language: "English" },
        { url: `${F}/news/lamu-ferry-4`, title: "TEST FIXTURE: Rescue teams search for missing passengers after Lamu ferry accident", seendate: gd(H(1)), domain: "fixture-news-d.example", language: "English" },
        ...(STATE.extra ? [{ url: `${F}/news/lamu-ferry-5`, title: "TEST FIXTURE: Lamu ferry services resume after inspection", seendate: gd(H(0.2)), domain: "fixture-news-a.example", language: "English" }] : [])];
      return j(200, { articles: /lamu/i.test(q.query) && !/football/.test(q.query.replace(/-"?football"?/, "")) ? arts : [] });
    }
    if (u.pathname === "/res/v1/news/search") {
      if (STATE.braveFail) return j(401, { error: "invalid subscription token" });
      if (req.headers["x-subscription-token"] !== "brave-key") return j(401, { error: "bad token" });
      return j(200, { results: /lamu/i.test(q.q) ? [{ title: "TEST FIXTURE: Ferry capsizes near Lamu, 12 people missing", url: `${F}/news/lamu-ferry`, description: "A ferry capsized near Lamu on Monday.", page_age: H(3).toISOString(), meta_url: { hostname: "fixture-news-a.example" }, thumbnail: { src: `${F}/img/a.jpg` } },
        { title: "TEST FIXTURE: Lamu football club wins league", url: `${F}/news/lamu-football`, description: "Lamu football", page_age: H(5).toISOString(), meta_url: { hostname: "fixture-sport.example" } }] : [] });
    }
    if (u.pathname === "/site") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><head><title>Fixture News</title><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>news</body></html>`); }
    if (u.pathname === "/feed.xml") { res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Fixture County News</title>
<item><title>TEST FIXTURE: County officials visit Lamu ferry survivors</title><link>${F}/news/rss-1</link><guid>rss-1</guid><pubDate>${H(4).toUTCString()}</pubDate><description>Officials met families.</description><media:content url="https://images.example/rss1.jpg" medium="image"/></item>
<item><title>TEST FIXTURE: Market prices rise in Mombasa</title><link>${F}/news/rss-2</link><guid>rss-2</guid><pubDate>${H(4).toUTCString()}</pubDate><description>Prices.</description></item>
</channel></rss>`); }
    if (u.pathname === "/youtube/v3/search") return j(200, { items: /lamu/i.test(q.q) ? [{ id: { videoId: "fixtureVid01" } }] : [] });
    if (u.pathname === "/youtube/v3/videos") return j(200, { items: [{ id: "fixtureVid01", snippet: { title: "TEST FIXTURE: Lamu ferry rescue video", description: "Footage from the rescue.", channelTitle: "Fixture TV", publishedAt: H(2).toISOString(), thumbnails: { high: { url: `${F}/img/a.jpg` } } }, statistics: { viewCount: "1200", likeCount: "40", commentCount: "5" } }] });
    if (u.pathname.startsWith("/img/")) { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(fs.readFileSync("training/images/case_convoy.jpg")); }
    if (u.pathname.startsWith("/news/")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><head><title>TEST FIXTURE: Ferry capsizes near Lamu</title><meta property="article:published_time" content="${H(3).toISOString()}"></head><body><article><p>TEST FIXTURE ARTICLE: A ferry capsized near Lamu on Monday and 12 people are missing, county officials said. Rescue teams from the Kenya Navy are searching the channel.</p></article></body></html>`); }
    if (u.pathname === "/api/tags") return j(200, { models: [{ name: "qwen3:4b-instruct" }] });
    if (u.pathname === "/api/chat") { let b = ""; req.on("data", d => (b += d)); req.on("end", () => {
      const p = JSON.parse(b).messages.at(-1).content;
      if (/Rewrite the four sections/.test(p)) return j(200, { message: { content: JSON.stringify({ background: "AIVS searched the connected public sources for the analyst's keywords about a ferry accident near Lamu and found several news items and one video. The subject matters because public information about the accident may shape understanding of maritime safety and the security response on the coast in the coming days.",
        analysis: "The items form one main narrative about a ferry accident near Lamu and the search for missing people [1]. Reports disagree on the number of people missing: one gives twelve and another twenty, so the figure remains unresolved. The same headline about rescue teams appears on two sites, which is repetition of wording and not evidence of coordination. No official statement was found among the results, which leaves an information gap about the confirmed facts and the response by the authorities.",
        assessment: "Available reporting indicates public discussion of a ferry accident near Lamu across several independent news sources. Conflicting figures mean the number of missing people remains unresolved until confirmed by an authoritative source. There are no indicators of coordinated activity in the available data. Overall: monitoring summary. Evidence strength: Moderate, based on the number of independent sources found.",
        recommendations: ["Confirm the number of missing people with the responsible authority before reporting it.", "Keep the keywords as a recurring watchlist and review new items daily.", "Refer this AI-generated assessment for authorised human review before any operational use."] }) }, model: "qwen3:4b-instruct" });
      return j(200, { message: { content: "{}" }, model: "qwen3:4b-instruct" }); }); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ allowPrivateFetch: true, search: { gdelt: true, gdeltBase: F, braveKey: "brave-key", braveBase: F, timeoutMs: 3000 }, collect: { youtubeKey: "yt-key", timeoutMs: 3000, bases: { youtube: F } },
    watch: { enabled: false, metricsRefreshMinutes: 0, gdeltPauseMs: 0 }, ai: { provider: "ollama", model: "qwen3:4b-instruct", baseUrl: F, apiKey: "", timeoutMs: 10000, healthTimeoutMs: 5000, maxImages: 6 } });
  [ana, rev, admin] = await Promise.all([login(S.base, "ana"), login(S.base, "rev"), login(S.base, "admin")]);
});
after(async () => { await S.ctx.investigations.close(); await S.close(); fake.close(); });
async function done(client, id) { for (let i = 0; i < 300; i++) { const g = (await client.get(`/api/monitor/searches/${id}`)).body; if (g.status !== "running") return g; await new Promise(r => setTimeout(r, 100)); } throw new Error("search did not finish"); }

test("query syntax: phrases, OR, AND, exclusions and hashtags", () => {
  assert.deepEqual(parseQuery("Lamu ferry"), { terms: ["Lamu ferry"], require_groups: [], exclude: [] });
  assert.deepEqual(parseQuery('"Kenya Army" OR KDF AND Lamu -recruitment'), { terms: ["Kenya Army", "KDF"], require_groups: [["Lamu"]], exclude: ["recruitment"] });
  assert.deepEqual(parseQuery("#KDF, Jeshi la Kenya NOT football"), { terms: ["#KDF", "Jeshi la Kenya"], require_groups: [], exclude: ["football"] });
  assert.throws(() => parseQuery("-only"), /no words/); assert.throws(() => parseQuery(""), /Type a keyword/);
  assert.equal(urlKey("https://www.example.com/a/b/?utm_source=x#top"), urlKey("https://example.com/a/b"));
});

test("an analyst-entered keyword is searched across every connected source; results keep URL, date, image and matched terms; duplicates and exclusions handled", async () => {
  const st = await ana.post("/api/monitor/searches", { query: '"Lamu ferry" -football', sources: ["gdelt", "brave_news", "news", "youtube", "x_search", "facebook", "fb_live"], feeds: [`${F}/site`], from: H(48).toISOString().slice(0, 10) });
  assert.equal(st.status, 202, JSON.stringify(st.body)); assert.match(st.body.description, /Lamu ferry.*without.*football/);
  const s = await done(ana, st.body.id); assert.equal(s.status, "done", s.error);
  const per = Object.fromEntries(s.per_source.map(p => [p.source, p]));
  assert.equal(per.gdelt.state, "ok"); assert.equal(per.gdelt.matched, 4); assert.equal(per.brave_news.state, "ok"); assert.equal(per.news.state, "ok"); assert.equal(per.youtube.state, "ok");
  assert.equal(per.x_search.state, "not_configured"); assert.match(per.x_search.error, /X_BEARER_TOKEN/);
  assert.equal(per.facebook.state, "not_configured"); assert.equal(per.fb_live.state, "not_configured");
  assert.equal(per.brave_news.matched, 1, "the football article is excluded"); assert.equal(per.brave_news.duplicates, 1, "the same article found by GDELT is marked as a duplicate");
  assert.equal(per.news.matched, 1, "only the RSS item that contains the keyword");
  const gq = seen.find(x => x.path === "/api/v2/doc/doc").q.query; assert.match(gq, /"Lamu ferry"/); assert.match(gq, /-football/);
  const r = (await ana.get(`/api/monitor/searches/${st.body.id}/results`)).body;
  assert.equal(r.total, 7);
  for (const it of r.items) { assert.ok(it.url && /^http/.test(it.url), "original URL"); assert.ok(it.posted_at, "publication date"); assert.equal(it.verification.status, "not_verified"); assert.ok(it.analysis, "analysed"); assert.equal(it.origin, "live"); }
  const rss = r.items.find(i => i.platform === "News website"); assert.deepEqual(rss.matched_terms, ["Lamu ferry"]); assert.ok(rss.has_image);
  const yt = r.items.find(i => i.platform === "YouTube"); assert.ok(yt.has_image);
  const img = await fetch(`${S.base}/api/monitor/items/${r.items.find(i => i.has_image && i.platform === "News (GDELT)").id}/image`, { headers: { cookie: ana.cookie } }); assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal((await ana.get(`/api/monitor/searches/${st.body.id}/results?source=YouTube`)).body.total, 1);
  assert.equal((await ana.get(`/api/monitor/searches/${st.body.id}/results?hide_duplicates=1`)).body.total, 6);
  // a second search finds the same items again: nothing is stored twice
  const n0 = S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, s2 = await ana.post("/api/monitor/searches", { query: "Lamu ferry", sources: ["gdelt"] }); await done(ana, s2.body.id);
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, n0); assert.ok((await ana.get(`/api/monitor/searches/${s2.body.id}/results`)).body.items.every(i => i.is_new === false));
});

test("source status shows connected, restricted, unavailable and not configured, with the platforms' limits", async () => {
  const s = (await ana.get("/api/monitor/sources")).body, by = Object.fromEntries(s.sources.map(x => [x.key, x]));
  assert.equal(by.gdelt.category, "Connected"); assert.ok(by.gdelt.items_collected >= 4); assert.equal(by.x_search.category, "Not configured"); assert.equal(by.facebook.category, "Not configured");
  assert.match(by.facebook.access_limit, /does not offer keyword search of Facebook/); assert.match(by.fb_live.access_limit, /not a search of Facebook/);
  assert.match(s.note, /cannot search all public Facebook posts, personal profiles/); assert.ok(s.not_available.length);
  STATE.braveFail = true; const st = await ana.post("/api/monitor/searches", { query: "Lamu ferry", sources: ["brave_news", "gdelt"] }); const d = await done(ana, st.body.id); STATE.braveFail = false;
  const b = d.per_source.find(p => p.source === "brave_news"); assert.equal(b.state, "restricted"); assert.equal(d.per_source.find(p => p.source === "gdelt").state, "ok", "one failing source does not stop the others");
  assert.equal((await ana.get("/api/monitor/sources")).body.sources.find(x => x.key === "brave_news").category, "Restricted");
});

test("verification of a discovered item runs the automatic investigation and its status is shown", async () => {
  const sid = (await ana.get("/api/monitor/searches")).body.searches.at(-1).id, it = (await ana.get(`/api/monitor/searches/${sid}/results?source=News`)).body.items.find(i => /12 people/.test(i.text));
  const v = await ana.post(`/api/monitor/items/${it.id}/verify`, {}); assert.equal(v.status, 202, JSON.stringify(v.body));
  for (let i = 0; i < 300 && !S.ctx.investigations.idle(); i++) await new Promise(r => setTimeout(r, 100));
  const d = (await ana.get(`/api/monitor/items/${it.id}`)).body;
  assert.ok(["insufficient", "supported", "contradicted", "misleading", "not_verifiable"].includes(d.verification.status), JSON.stringify(d.verification)); assert.ok(d.verification.report_id);
  const inv = (await ana.get(`/api/investigations/${d.verification.investigation_id}`)).body; assert.match(inv.result.content, /12 people are missing/, "the article was read from its own page");
});

test("analysis and draft report: narratives, contradictions, repetition, gaps; Ollama drafts the text, which is checked; four sections, one page, real references", async () => {
  const sid = (await ana.get("/api/monitor/searches")).body.searches.at(-1).id;
  const r = await ana.post(`/api/monitor/searches/${sid}/report`, {}); assert.equal(r.status, 201, JSON.stringify(r.body));
  const sit = r.body.situation, a = r.body.report;
  assert.ok(sit.contradictions.some(c => c.kind === "figures" && /12 people/.test(c.detail)), JSON.stringify(sit.contradictions));
  assert.ok(sit.repeated.length >= 1, "the same headline on two sites"); assert.ok(sit.gaps.some(g => /official/.test(g)));
  assert.equal(a.written_by, "ai", JSON.stringify(a.ai_notes)); assert.match(a.analysis, /disagree/);
  assert.ok(a.references.length >= 1 && a.references.every(f => sit.items.some(i => i.url === f.url)), "references are items that were found");
  assert.ok(a.recommendations.some(x => /human review/.test(x)));
  const pdf = Buffer.from(await (await fetch(`${S.base}/api/monitor/reports/${r.body.id}/file.pdf`, { headers: { cookie: ana.cookie } })).arrayBuffer());
  assert.equal((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1);
  const html = (await ana.get(`/api/monitor/reports/${r.body.id}/file.html`)).body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/(\d\.) (\w)/g, "$1 $2"); for (const h of ["1. BACKGROUND", "2. ANALYSIS", "3. ASSESSMENT", "4. RECOMMENDATIONS", "PUBLIC INFORMATION MONITORING REPORT", "AI-Generated (not reviewed)"]) assert.ok(html.includes(h), h);
  assert.equal((await ana.post(`/api/monitor/reports/${r.body.id}/review`, { note: "x" })).status, 403, "analyst cannot review");
  assert.equal((await rev.post(`/api/monitor/reports/${r.body.id}/review`, { note: "Checked the two figures against the articles." })).status, 200);
  assert.match((await ana.get(`/api/monitor/reports/${r.body.id}/file.html`)).body, /Reviewed by REV/);
});

test("a search saved as a watchlist repeats automatically and its new items are found, matched and alerted", async () => {
  const sid = (await ana.get("/api/monitor/searches")).body.searches.find(s => s.query.includes("-football")).id;
  assert.equal((await ana.post(`/api/monitor/searches/${sid}/watchlist`, {})).status, 403, "analysts cannot activate collection");
  const w = await rev.post(`/api/monitor/searches/${sid}/watchlist`, { name: "Lamu ferry (test)", interval: 30, alert_mode: "every_post" }); assert.equal(w.status, 201, JSON.stringify(w.body)); assert.equal(w.body.status, "active");
  const wl = S.ctx.watch.get(w.body.watchlist_id); assert.ok(wl.definition.sources.includes("gdelt") && wl.definition.exclude.includes("football"));
  STATE.extra = true; await S.ctx.watchCollector.runSource(wl, "gdelt"); STATE.extra = false;
  const feed = (await ana.get(`/api/monitor/feed?watchlist=${w.body.watchlist_id}`)).body;
  assert.ok(feed.items.some(i => /services resume/.test(i.text)), "the new article from the scheduled run");
  assert.ok((await rev.get("/api/watch/alerts?limit=50")).body.alerts.some(a => a.watchlist_id === w.body.watchlist_id && /services resume/.test(a.title)));
  const rep = await rev.post(`/api/monitor/watchlists/${w.body.watchlist_id}/report`, { hours: 48 }); assert.equal(rep.status, 201); assert.ok(rep.body.situation.total >= 5);
  assert.ok((await ana.get("/api/live/alerts?kind=contradiction")).body.alerts.length >= 1, "conflicting reports become an alert for a recurring watchlist");
});

test("searches are refused in Training mode; nothing is invented when no source returns anything", async () => {
  assert.equal((await ana.post("/api/monitor/searches?training=1", { query: "Lamu ferry" })).status, 400);
  const st = await ana.post("/api/monitor/searches", { query: "zzqx nothing matches", sources: ["gdelt", "brave_news"] }), d = await done(ana, st.body.id);
  assert.equal(d.results, 0); const rep = (await ana.post(`/api/monitor/searches/${st.body.id}/report`, {})).body;
  assert.equal(rep.situation.total, 0); assert.equal(rep.report.references.length, 0); assert.match(rep.report.background, /found no matching item/);
});

test("set analysis is conservative", () => {
  const items = [{ n: 1, platform: "X (Twitter)", account: "a", text: "TEST FIXTURE: Send KSh 500 now to register for KDF recruitment, share before it is deleted!", posted_at: H(1).toISOString() }].map(i => ({ ...i, analysis: analyseItem(i.text) }));
  const s = situation(items); assert.ok(s.indicators.length); assert.ok(s.gaps.some(g => /No news coverage/.test(g))); assert.match(s.note, /do not show coordination/);
});

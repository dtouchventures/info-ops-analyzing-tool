// The default KDF watchlist (1.28): editable keywords, spelling variants, contextual keywords such as CDF, the organisation's own
// Page kept out of the results, and AI analysis queued while the Ollama server cannot be reached. Every post below is a labelled
// TEST FIXTURE given to the watchlist directly or served by a local stand-in for Ollama; real sources are checked on a connected
// computer with `npm run check:kdf-watchlist`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, login, reopenServer } from "./helpers.js";
import { normaliseDefinition, matchPost, KDF_DEFAULT, xQuery, youtubeQuery } from "../server/lib/watch.js";
import { markTestRecords } from "../server/lib/db.js";
process.env.MONITOR_AUTO_REPORT_MIN_ITEMS = "3";

let S, F, fake, ana, rev, view, wid;
const OLLAMA = { up: false, calls: 0 };
const H = h => new Date(Date.now() - h * 3600e3).toISOString();
const row = (id, text, extra = {}) => ({ platform: "News website", post_id: `fixture-${id}`, url: `https://news.example/${id}`, account: extra.account || `Fixture outlet ${id}`, text: `TEST FIXTURE: ${text}`, posted_at: extra.at || H(1), ...extra });

before(async () => {
  fake = http.createServer((req, res) => {
    const j = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!OLLAMA.up) { req.socket.destroy(); return; }   // the AI server cannot be reached
    if (req.url === "/api/tags") return j(200, { models: [{ name: "qwen3:4b-instruct" }] });
    let b = ""; req.on("data", d => (b += d)); req.on("end", () => {
      OLLAMA.calls++;
      const p = JSON.parse(b).messages.at(-1).content;
      if (/single word OK/.test(p)) return j(200, { message: { content: "OK" }, model: "qwen3:4b-instruct" });
      const text = (p.match(/<content>\n([\s\S]*?)\n<\/content>/) || [])[1] || "";
      return j(200, { model: "qwen3:4b-instruct", message: { content: JSON.stringify({ about_subject: /General|troops|soldiers|Navy/.test(text) ? "yes" : "unclear", about_reason: "fixture",
        indicators: /Share widely/.test(text) ? ["unsourced figure", "call to share"] : [], credibility: /Share widely/.test(text) ? "low" : "medium", credibility_reason: "fixture", uncertainty: "medium", uncertainty_reason: "fixture",
        summary: "A fixture item about the subject.", claims: [{ text: "troops", quote: text.slice(14, 60) }, { text: "invented", quote: "words that are not in the item at all" }], themes: ["security"], tone: "neutral" }) } });
    });
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ search: { gdelt: false }, watch: { enabled: false, metricsRefreshMinutes: 0 },
    ai: { provider: "ollama", model: "qwen3:4b-instruct", baseUrl: F, apiKey: "", timeoutMs: 3000, healthTimeoutMs: 2000, connectTimeoutMs: 500, maxImages: 6 } });
  [ana, rev, view] = await Promise.all([login(S.base, "ana"), login(S.base, "rev"), login(S.base, "view")]);
});
after(async () => { await S.close(); fake.close(); });

test("keywords match regardless of capitals, joined, spaced or hyphenated words, Defence/Defense, hashtags and Kiswahili", () => {
  const d = normaliseDefinition(KDF_DEFAULT.definition), m = t => matchPost(d, { text: t });
  for (const t of ["kenya airforce jets flew over Nairobi", "The KENYA AIR-FORCE said", "#KenyaAirForce at 60", "Kenya Defense Forces deployed", "#MajeshiYetu", "jeshi la kenya limetangaza", "Statement by the Chief of Defence Forces", "kdf soldiers"])
    assert.equal(m(t).matched, true, t);
  assert.equal(m("Kenya Airways flight delayed").matched, false);
  assert.equal(m("Convert the KDF file format").matched, false, "excluded meaning of KDF");
});

test("CDF and other ambiguous keywords need their context; another meaning excludes; alone they wait for an analyst", () => {
  const d = normaliseDefinition(KDF_DEFAULT.definition), m = t => matchPost(d, { text: t });
  const ctx = m("CDF General addressed troops at the barracks"); assert.equal(ctx.matched, true); assert.equal(ctx.quality, "contextual"); assert.ok(ctx.disambiguated_by.includes("General"));
  assert.equal(m("NG-CDF bursary cheques issued in Kisumu").matched, false); assert.equal(m("NG-CDF bursary cheques issued in Kisumu").ambiguous, undefined);
  assert.equal(m("CDF allocation for the constituency").matched, false);
  const alone = m("The CDF said on Monday that the plan is ready"); assert.equal(alone.matched, false); assert.equal(alone.ambiguous, true);
  assert.equal(m("US Navy Commander retires").matched, false);
  assert.equal(m("Kenya Navy Commander visits Mtongwe").quality, "confirmed", "Kenya Navy is itself a keyword");
  assert.equal(m("CDF and KDF officers met").quality, "confirmed", "with a firm keyword the match is confirmed");
  // a platform's own search is not asked for CDF alone (it returns mostly unrelated items); the news feeds are read in full
  assert.doesNotMatch(xQuery(d).query, /\bCDF\b/); assert.doesNotMatch(youtubeQuery(d).query, /\bCDF\b/); assert.match(xQuery(d).query, /KDF/);
});

test("the default watchlist is created once with the 12 keywords, active, and is not recreated after deletion", async () => {
  const sys = S.ctx.live.systemUser(), d = S.ctx.keywords.ensureDefault(sys); assert.ok(d.id); wid = d.id;
  const wl = S.ctx.watch.get(wid); assert.equal(wl.name, "KDF and Kenya Defence Forces Monitoring"); assert.equal(wl.status, "active", d.status);
  assert.deepEqual(wl.definition.terms, ["KDF", "Kenya Defence Forces", "Kenya Army", "Kenya Navy", "CDF", "Kenya Air Force", "Kenya Airforce", "Navy Commander", "Air Force Commander", "Majeshi Yetu", "Chief of Defence Forces", "Jeshi la Kenya"]);
  assert.deepEqual(wl.definition.contextual.map(c => c.term), ["CDF", "Navy Commander", "Air Force Commander"]);
  assert.ok(!wl.definition.sources.includes("fb_live"), "the own Facebook Page is not a source of this watchlist");
  assert.equal(S.ctx.keywords.ensureDefault(sys), null, "only once");
});

test("analysts add, edit, switch off and delete keywords from the dashboard; the watchlist keeps running; viewers cannot", async () => {
  const cur = S.ctx.watch.get(wid);
  assert.equal((await view.patch(`/api/watch/lists/${wid}/keywords`, { terms: ["KDF"] })).status, 403);
  const terms = [...cur.definition.terms.filter(t => t !== "Jeshi la Kenya"), "Kenya Defence Force", "#KDFUpdates"];
  const r = await ana.patch(`/api/watch/lists/${wid}/keywords`, { terms, paused_terms: ["Jeshi la Kenya"], contextual: cur.definition.contextual });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, "active", "still running");
  const wl = S.ctx.watch.get(wid); assert.ok(wl.definition.terms.includes("#KDFUpdates")); assert.deepEqual(wl.definition.paused_terms, ["Jeshi la Kenya"]);
  assert.equal(matchPost(wl.definition, { text: "Jeshi la Kenya limetangaza" }).matched, false, "a switched-off keyword is not matched");
  const back = await ana.patch(`/api/watch/lists/${wid}/keywords`, { terms: [...wl.definition.terms.filter(t => t !== "Kenya Defence Force"), "Jeshi la Kenya"], paused_terms: [] });
  assert.equal(back.status, 200); assert.ok(!S.ctx.watch.get(wid).definition.terms.includes("Kenya Defence Force"), "deleted"); assert.equal(S.ctx.watch.get(wid).status, "active");
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM watchlist_versions WHERE watchlist_id = ?").get(wid).n >= 3, "every change is versioned");
});

test("only genuine matches are shown; CDF alone waits for an analyst; duplicates are stored once; alerts follow", async () => {
  const wl = S.ctx.watch.get(wid);
  const rows = [row(1, "KDF soldiers repel attack in Lamu county"), row(2, "Kenya Airforce jets in flypast over Nanyuki"), row(3, "CDF General Kahariri inspects troops at Lanet"),
    row(4, "CDF bursary cheques issued to students in Kisumu constituency"), row(5, "The CDF said on Monday that the plan is ready"), row(6, "Football: Gor Mahia win again"), row(1, "KDF soldiers repel attack in Lamu county")];
  const out = S.ctx.watch.ingest(wl, "news", rows);
  assert.equal(out.new_matches, 3, "the repeated item is matched once"); assert.equal(out.ambiguous, 1); assert.equal(out.new_posts, 4, "stored once each; the ambiguous item is kept for the analyst");
  const feed = (await ana.get(`/api/monitor/feed?watchlist=${wid}`)).body, texts = feed.items.map(i => i.text);
  assert.equal(feed.total, 3); assert.ok(!texts.some(t => /bursary|plan is ready|Gor Mahia/.test(t)));
  const cdf = feed.items.find(i => /Kahariri/.test(i.text)); assert.equal(cdf.quality, "contextual"); assert.match(cdf.quality_label, /Contextual/); assert.ok(cdf.disambiguated_by.includes("General"));
  for (const it of feed.items) { assert.ok(it.url && it.posted_at && it.matched_terms.length); }
  const amb = (await ana.get(`/api/monitor/feed?watchlist=${wid}&quality=ambiguous`)).body; assert.equal(amb.total, 1); assert.match(amb.items[0].text, /plan is ready/);
  const alerts = () => S.ctx.db.prepare("SELECT * FROM watch_alerts WHERE watchlist_id = ? AND kind = 'match'").all(wid);
  assert.equal(alerts().length, 3, "an alert for each genuine match, none for the ambiguous one"); assert.match(alerts().find(a => /Kahariri/.test(a.title)).reason, /Contextual match/);
  assert.equal((await view.post(`/api/watch/lists/${wid}/matches/${amb.items[0].id}/review`, { relevant: true })).status, 403);
  const rv = await ana.post(`/api/watch/lists/${wid}/matches/${amb.items[0].id}/review`, { relevant: false }); assert.equal(rv.status, 200); assert.equal(rv.body.quality, "rejected");
  assert.equal((await ana.get(`/api/monitor/feed?watchlist=${wid}&quality=ambiguous`)).body.total, 0);
});

test("posts of the organisation's own Facebook Page never appear in monitoring results, alerts or the overview", async () => {
  const wl = S.ctx.watch.get(wid);
  S.ctx.watch.ingest(wl, "fb_live", [{ platform: "Facebook", post_id: "fixture-page_1", url: "https://www.facebook.com/fixture/posts/1", account: "Praetorian (fixture)", text: "TEST FIXTURE: Our KDF partnership training day", posted_at: H(1) }]);
  // a Praetorian post stored earlier by another route (it is in the live monitoring table) is recognised too
  S.ctx.db.prepare("INSERT INTO social_sources(platform,external_id,name,origin,created_at) VALUES ('facebook','fixture-page','Praetorian (fixture)','settings',?)").run(H(9));
  S.ctx.db.prepare("INSERT INTO social_posts(source_id,platform,post_id,message,created_time,collected_at,updated_at) SELECT id,'facebook','fixture-page_2','TEST FIXTURE: KDF day at our office',?,?,? FROM social_sources WHERE external_id = 'fixture-page'").run(H(1), H(1), H(1));
  S.ctx.watch.ingest(wl, "news", [{ platform: "Facebook", post_id: "fixture-page_2", url: "https://www.facebook.com/fixture/posts/2", account: "Praetorian (fixture)", text: "TEST FIXTURE: KDF day at our office", posted_at: H(1) }]);
  for (const q of ["", "&own=1", "&quality=all"]) assert.ok(!(await ana.get(`/api/monitor/feed?watchlist=${wid}${q}`)).body.items.some(i => /partnership|our office/.test(i.text)), q);
  assert.ok(!(await ana.get("/api/monitor/overview")).body.recent.some(i => /partnership|our office/.test(i.text)));
  assert.ok(!(await ana.get("/api/watch/alerts?limit=100")).body.alerts.some(a => /partnership|our office/.test(a.title)));
  assert.ok(S.ctx.db.prepare("SELECT 1 FROM watch_posts WHERE post_id = 'fixture-page_1'").get(), "records are kept, not deleted");
  assert.ok(!(await ana.get("/api/monitor/sources")).body.sources.some(x => x.key === "fb_live"), "not offered as a source");
});

test("items are stored while the AI server cannot be reached; AI analysis waits and runs when it answers; Ollama AI Ready only after a working answer", async () => {
  OLLAMA.up = false; await S.ctx.ai.health({ force: true });
  const r1 = await S.ctx.keywords.aiTick(); assert.equal(r1.waiting, true); assert.ok(r1.queued >= 3, JSON.stringify(r1));
  const q1 = (await ana.get("/api/monitor/ai")).body; assert.equal(q1.ready, false); assert.equal(q1.label, "Ollama AI unavailable"); assert.ok(q1.queue.pending >= 3); assert.equal(q1.queue.done, 0); assert.equal(q1.queue.state, "waiting"); assert.match(q1.queue.reason, /did not answer|cannot be reached|refused|connect/i);
  assert.equal((await ana.get("/api/monitor/overview")).body.counts.ai_indicator.ready, false);
  const pend = (await ana.get(`/api/monitor/feed?watchlist=${wid}`)).body.items[0]; assert.equal(pend.ai.status, "pending");
  OLLAMA.up = true; await S.ctx.ai.health({ force: true });
  const ok = (await ana.get("/api/monitor/ai")).body; assert.equal(ok.ready, true); assert.equal(ok.label, "Ollama AI Ready"); assert.equal(ok.model, "qwen3:4b-instruct");
  for (let i = 0; i < 5 && (await ana.get("/api/monitor/ai")).body.queue.pending; i++) await S.ctx.keywords.aiTick();
  const q2 = (await ana.get("/api/monitor/ai")).body.queue; assert.equal(q2.pending, 0, JSON.stringify(q2)); assert.ok(q2.done >= 3); assert.equal(q2.state, "running");
  const it = (await ana.get(`/api/monitor/feed?watchlist=${wid}`)).body.items.find(i => /Kahariri/.test(i.text));
  assert.equal(it.ai.status, "done"); assert.equal(it.ai.result.about_subject, "yes"); assert.equal(it.ai.model, "qwen3:4b-instruct");
  assert.ok(it.ai.result.claims.every(c => it.text.toLowerCase().includes(c.quote.toLowerCase())), "only quotes found in the item are kept"); assert.equal(it.ai.result.claims_dropped, 1);
  assert.ok(["high", "medium", "low"].includes(it.ai.result.credibility) && ["low", "medium", "high"].includes(it.ai.result.uncertainty), "credibility and uncertainty");
});

test("after the AI reading: explainable alerts, automatic evidence search (verification) and a draft report from the collected items", async () => {
  const wl = S.ctx.watch.get(wid);
  S.ctx.watch.ingest(wl, "news", [row("pipe1", "Share widely: KDF soldiers say 500 troops deployed to the border overnight", { account: "Fixture blog" }), row("pipe2", "Kenya Navy patrol boats seen near Lamu", { account: "Fixture Coast" })]);
  for (let i = 0; i < 5; i++) { await S.ctx.keywords.aiTick(); if (!(await ana.get("/api/monitor/ai")).body.queue.pending) break; }
  const al = (await ana.get("/api/live/alerts?scope=watchlists&kind=ai_assessment&limit=50")).body.alerts;
  const a = al.find(x => /500 troops/.test(x.title)); assert.ok(a, JSON.stringify(al.map(x => x.title)));
  assert.match(a.reason, /signs of possible misinformation in the text: unsourced figure/); assert.match(a.reason, /not a finding/); assert.equal(a.detail.ai.credibility, "low");
  assert.ok(!al.some(x => /patrol boats/.test(x.title)), "no alert without a reason");
  const sent = S.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts WHERE investigation_id IS NOT NULL AND is_training = 0").get().n; assert.ok(sent >= 1, "genuine items about the subject are sent to the automatic investigation");
  for (let i = 0; i < 300 && !S.ctx.investigations.idle(); i++) await new Promise(r => setTimeout(r, 100));
  const reps = S.ctx.db.prepare("SELECT * FROM monitor_reports WHERE watchlist_id = ? AND origin = 'auto'").all(wid); assert.equal(reps.length, 1, "one automatic draft report");
  const rep = (await ana.get(`/api/monitor/reports/${reps[0].id}`)).body;
  for (const k of ["background", "analysis", "assessment", "recommendations"]) assert.ok(rep.report[k] && String(rep.report[k]).length > 20, k);
  assert.ok(rep.situation.items.length >= 3 && rep.situation.items.every(i => S.ctx.db.prepare("SELECT 1 FROM watch_posts WHERE id = ?").get(i.id)), "built from stored items");
  assert.ok(!rep.situation.items.some(i => /partnership|our office/.test(i.text)), "not from the own Page");
});

test("test records stay in Training: never among Operational results or alerts; existing ones are moved without deleting", async () => {
  const S2 = await startServer({ search: { gdelt: false }, watch: { enabled: false, metricsRefreshMinutes: 0, markTestData: true } });
  try {
    const ana2 = await login(S2.base, "ana"), d = S2.ctx.keywords.ensureDefault(S2.ctx.live.systemUser()), wl = S2.ctx.watch.get(d.id);
    S2.ctx.watch.ingest(wl, "news", [row("t1", "KDF statement on the fixture exercise"), { platform: "News website", post_id: "real-1", url: "https://www.nation.africa/kenya/news/kdf-1", account: "Nation", text: "KDF says officers completed training in Nanyuki", posted_at: H(2) }]);
    const op = (await ana2.get(`/api/monitor/feed?watchlist=${d.id}&training=0`)).body, tr = (await ana2.get(`/api/monitor/feed?watchlist=${d.id}&training=1`)).body;
    assert.deepEqual(op.items.map(i => i.text), ["KDF says officers completed training in Nanyuki"]); assert.equal(tr.total, 1); assert.match(tr.items[0].text, /TEST FIXTURE/); assert.equal(tr.items[0].origin, "test");
    assert.ok(!(await ana2.get("/api/watch/alerts?limit=50")).body.alerts.some(a => /TEST FIXTURE/.test(a.title)), "Operational alerts");
    assert.ok((await ana2.get("/api/watch/alerts?limit=50&training=1")).body.alerts.some(a => /TEST FIXTURE/.test(a.title)), "Training alerts");
    assert.ok(!(await ana2.get("/api/monitor/overview?training=0")).body.recent.some(i => /TEST FIXTURE/.test(i.text)));
    // records stored before this version: moved by the migration's rule, nothing deleted
    S2.ctx.db.prepare("UPDATE watch_posts SET is_training = 0").run(); S2.ctx.db.prepare("UPDATE watch_alerts SET is_training = 0").run();
    S2.ctx.db.prepare("INSERT INTO live_alerts(kind,dedupe_key,group_key,is_training,priority,title,reason,priority_reasons_json,detail_json,status,created_at,updated_at) VALUES ('narrative','x1','watchlist:1',0,'low','TEST FIXTURE: old alert','r','[]','{}','new',?,?)").run(H(1), H(1));
    const before = S2.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, moved = markTestRecords(S2.ctx.db);
    assert.ok(moved.watch_posts === 1 && moved.watch_alerts >= 1 && moved.live_alerts === 1, JSON.stringify(moved)); assert.equal(S2.ctx.db.prepare("SELECT COUNT(*) n FROM watch_posts").get().n, before);
    assert.ok(!(await ana2.get("/api/live/alerts?scope=watchlists")).body.alerts.some(a => /TEST FIXTURE/.test(a.title)));
  } finally { await S2.close(); }
});

test("an emerging topic within the watchlist raises an alert", async () => {
  const wl = S.ctx.watch.get(wid), rows = [];
  for (let i = 0; i < 5; i++) rows.push(row(`em${i}`, `KDF statement on security operations in Garissa, update ${i}`, { account: `Outlet ${i}`, at: H(0.5 + i / 10) }));
  S.ctx.watch.ingest(wl, "news", rows);
  const topics = (await ana.get(`/api/watch/lists/${wid}/emerging`)).body.topics; assert.ok(topics.some(t => t.topic === "Garissa" && t.items >= 4), JSON.stringify(topics));
  assert.ok(S.ctx.keywords.emergingTick() >= 1);
  assert.ok(S.ctx.db.prepare("SELECT 1 FROM watch_alerts WHERE watchlist_id = ? AND kind = 'narrative' AND title LIKE '%Garissa%'").get(wid));
  assert.equal(S.ctx.keywords.emergingTick(), 0, "once a day per topic");
});

test("a source connected later (a key added) is added to the default watchlist once; one an analyst removes is not added back", async () => {
  const S3 = await startServer({ search: { gdelt: false }, watch: { enabled: false, metricsRefreshMinutes: 0 } });
  const d = S3.ctx.keywords.ensureDefault(S3.ctx.live.systemUser()); assert.ok(!S3.ctx.watch.get(d.id).definition.sources.includes("mastodon"));
  assert.deepEqual(S3.ctx.keywords.addReadySources(S3.ctx.live.systemUser()), [], "nothing new is connected"); await S3.close();
  // AIVS restarted after MASTODON_INSTANCES was added to .env
  const S4 = await reopenServer(S3.dataDir, { search: { gdelt: false }, watch: { enabled: false, metricsRefreshMinutes: 0 }, platforms: { mastodonInstances: "mastodon.social" } });
  try {
    const sys = S4.ctx.live.systemUser(); assert.ok(S4.ctx.watchCollector.sourcesReady("mastodon"));
    assert.deepEqual(S4.ctx.keywords.addReadySources(sys), ["mastodon"]); const wl = S4.ctx.watch.get(d.id);
    assert.ok(wl.definition.sources.includes("mastodon")); assert.equal(wl.status, "active", "it keeps running");
    S4.ctx.watch.update(sys, d.id, { definition: { ...wl.definition, sources: wl.definition.sources.filter(k => k !== "mastodon") } });
    assert.deepEqual(S4.ctx.keywords.addReadySources(sys), [], "not added back after an analyst removed it");
  } finally { await S4.close(); }
});

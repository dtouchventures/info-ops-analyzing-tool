// Social media analysis module (AIVS 1.11): imports (CSV, JSON, Excel), stored per-post analysis, filtered insights,
// engagement, geography with location bases kept apart, claims with published fact-checks and cases, local AI
// (Ollama, faked) with validation, collection through official APIs (faked), reports, permissions, persistence
// across restart, and the database upgrade from version 7 with a backup.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { startServer, login, PW } from "./helpers.js";
import { createApp } from "../server/app.js";
import { openDb } from "../server/lib/db.js";
import { sentiment, sentimentEvaluation, themesOf, topicClusters, discussionSample, countyOf } from "../server/lib/social-analysis.js";
import { parseXlsx } from "../server/lib/io.js";
import { isLocalHost } from "../server/lib/ollama.js";

// ---- a minimal .xlsx writer (stored zip entries) so Excel import is tested with a real workbook structure
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const parts = [], central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), nm = Buffer.from(name), def = zlib.deflateRawSync(data), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc(data), 14); h.writeUInt32LE(def.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc(data), 16); c.writeUInt32LE(def.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, def); central.push(c, nm); off += 30 + nm.length + def.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
function xlsx(rows) {
  const strings = [], si = s => { const i = strings.indexOf(s); return i >= 0 ? i : strings.push(s) - 1; };
  const col = i => String.fromCharCode(65 + i);
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => typeof v === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(String(v))}</v></c>`).join("")}</row>`).join("");
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Posts" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst>${strings.map(s => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`, "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheet}</sheetData></worksheet>` });
}

let S, ana, rev, admin, view, fake, F, ollamaMode = "ok", calls = [];
const wait = async (u, jid) => { for (let i = 0; i < 200; i++) { const j = (await u.get(`/api/io/jobs/${jid}`)).body; if (["done", "failed"].includes(j.status)) return j; await new Promise(r => setTimeout(r, 50)); } throw new Error("job did not finish"); };
const form = (content, fields = {}, name = "posts.csv") => { const fd = new FormData(); fd.append("file", new Blob([content]), name); for (const [k, v] of Object.entries({ name: "Test posts", source: "partner export", authorisation: "written permission", ...fields })) fd.append(k, v); return fd; };
before(async () => {
  fake = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"); calls.push(u.pathname);
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/ol/api/tags") return json(200, { models: [{ name: "testmodel:latest" }] });
    if (u.pathname === "/ol/api/chat") {
      let body = ""; for await (const c of req) body += c; const j = JSON.parse(body), input = JSON.parse(j.messages[1].content);
      if (ollamaMode === "garbage") return json(200, { message: { content: "I think these are positive." } });
      if (j.format?.properties?.results) { const posts = input.posts; return json(200, { message: { content: JSON.stringify({ results: (ollamaMode === "skip" ? posts.slice(1) : posts).map(p => ({ id: p.id, label: /terrible|no water|angry/i.test(p.text) ? "negative" : "neutral", confidence: 0.8 })) }) } }); }
      if (j.format?.properties?.topics) return json(200, { message: { content: JSON.stringify({ topics: input.topics.map(t => ({ topic_no: t.topic_no, label: `Topic about ${t.key_terms[0]}`, summary: "Posts discussing this subject." })) }) } });
      if (j.format?.properties?.summary) return json(200, { message: { content: JSON.stringify({ summary: "The posts mostly discuss water and prices.", points: [{ text: "Water shortages are discussed.", post_ids: ollamaMode === "cite_bad" ? [99999999] : [input.posts[0].id] }] }) } });
      if (j.format?.properties?.claims) return json(200, { message: { content: JSON.stringify({ claims: input.posts.slice(0, 2).map(p => ({ post_id: p.id, claim: p.text })).concat([{ post_id: input.posts[0].id, claim: "Aliens landed in the stadium yesterday evening." }]) }) } });
    }
    if (u.pathname === "/site") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><head><title>Example County News</title><link rel="alternate" type="application/rss+xml" title="News" href="/feed.xml"></head><body>Home</body></html>`); }
    if (u.pathname === "/nofeed") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><body>No feed here</body></html>"); }
    if (u.pathname === "/feed.xml") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<?xml version="1.0"?><rss><channel><title>Example County News</title>
      <item><title>Water rationing announced in Garissa</title><link>https://news.example/1</link><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>The county says supply will return next week.</p>]]></description><guid>n1</guid></item>
      <item><title>Football results</title><link>https://news.example/2</link><pubDate>Tue, 06 Oct 2026 09:00:00 GMT</pubDate><description>Weekend scores.</description><guid>n2</guid></item></channel></rss>`); }
    if (u.pathname === "/yt/youtube/v3/search") return json(200, { items: [{ id: { videoId: "v1" } }, { id: { videoId: "v2" } }] });
    if (u.pathname === "/yt/youtube/v3/videos") return json(200, { items: ["v1", "v2"].map((id, i) => ({ id, snippet: { title: `Floods in Budalang'i ${i}`, description: "Residents describe the damage", channelTitle: "Practice Channel", publishedAt: `2026-10-0${i + 2}T10:00:00Z` }, statistics: { viewCount: String(1000 * (i + 1)), likeCount: "50", commentCount: "7" } })) });
    if (u.pathname === "/x/2/tweets/search/recent") return json(200, { data: [{ id: "1", author_id: "u1", created_at: "2026-10-20T08:00:00Z", text: "Prices of fuel are terrible this week", public_metrics: { like_count: 3, reply_count: 1, retweet_count: 2, quote_count: 1, impression_count: 400 }, lang: "en", geo: { place_id: "p1" } }],
      includes: { users: [{ id: "u1", username: "practice_user", created_at: "2020-01-01T00:00:00Z" }], places: [{ id: "p1", country_code: "KE", full_name: "Nairobi, Kenya" }] }, meta: {} });
    res.writeHead(404); res.end();
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ allowPrivateFetch: true, ollama: { url: `${F}/ol`, model: "testmodel", timeoutMs: 3000, batch: 7 }, collect: { youtubeKey: "test-key", xBearer: "", timeoutMs: 3000, maxItems: 100, bases: { youtube: `${F}/yt`, x: `${F}/x` } } });
  [ana, rev, admin, view] = await Promise.all(["ana", "rev", "admin", "view"].map(u => login(S.base, u)));
});
after(async () => { await S.close(); fake.close(); });

test("methods: sentiment with negation and Kiswahili; measured on labelled sentences; themes; deterministic topics; places", () => {
  assert.equal(sentiment("The service is great, thank you").label, "positive");
  assert.equal(sentiment("The water is not safe to drink").label, "negative", "negation flips a positive word");
  assert.equal(sentiment("Bei ya mafuta ni ghali mno").label, "negative");
  assert.equal(sentiment("The meeting is on Tuesday").label, "neutral");
  assert.equal(sentiment("Good teachers, terrible classrooms").label, "mixed");
  const ev = sentimentEvaluation(); assert.equal(ev.overall.items, 60); assert.ok(ev.overall.accuracy >= 0.85, `accuracy ${ev.overall.accuracy}`); assert.ok(ev.kiswahili.items >= 20); assert.match(ev.description, /optimistic/);
  assert.deepEqual(themesOf("Bandits attacked the village near the school"), ["security", "education"]);
  const posts = discussionSample().map((p, i) => ({ id: i, text: p.text })), a = topicClusters(posts), b = topicClusters(posts);
  assert.ok(a.k >= 2); assert.deepEqual(a.assign, b.assign, "topics are reproducible");
  assert.equal(countyOf("Nairobi, Kenya"), "Nairobi"); assert.equal(countyOf("Garissa County"), "Garissa");
  assert.equal(isLocalHost("127.0.0.1"), true); assert.equal(isLocalHost("192.168.1.20"), true); assert.equal(isLocalHost("ollama.example.com"), false);
});

test("Excel import: a real .xlsx workbook with engagement, location and an Excel date", async () => {
  const wb = xlsx([["account", "created_at", "text", "platform", "likes", "comments", "views", "county", "url"], ["kenya_one", 46300.5, "No water in Garissa for five days, terrible", "SampleNet", 12, 3, 400, "Garissa", "https://example.org/p/1"],
    ["kenya_two", 46301.25, "The new clinic in Kisumu is great, thank you", "SampleNet", 5, 0, "", "Kisumu", "https://example.org/p/2"], ["kenya_three", "2026-10-03T08:00:00Z", "Prices at the market & fuel are expensive", "SampleTube", "1.2k", "", "", "", ""]]);
  assert.equal(parseXlsx(wb).length, 3);
  const r = await ana.post("/api/io/datasets", undefined, { form: form(wb, { name: "Excel posts", research_question: "How do residents describe services?" }, "posts.xlsx") });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.imported, 3); assert.ok(r.body.content.claims >= 1);
  const all = (await ana.get(`/api/io/datasets/${r.body.id}/posts`)).body.posts, p = ["kenya_one", "kenya_two", "kenya_three"].map(a => all.find(x => x.account === a));
  assert.equal(p[0].posted_at, new Date(Math.round((46300.5 - 25569) * 864e5)).toISOString(), "Excel date serial converted");
  assert.equal(p[0].likes, 12); assert.equal(p[0].views, 400); assert.equal(p[1].views, null, "an empty cell is not zero"); assert.equal(p[2].likes, 1200, "1.2k read as 1200");
  assert.equal(p[0].loc_basis, "post"); assert.equal(p[0].sentiment, "negative"); assert.match(p[0].collected_via, /posts\.xlsx.*SHA-256/);
  const d = (await ana.get(`/api/io/datasets/${r.body.id}/insights`)).body.dataset; assert.equal(d.research_question, "How do residents describe services?");
});

test("insights: stored results, working filters, engagement only where present, geography bases kept apart", async () => {
  const csv = ["account,posted_at,text,platform,likes,shares,region,user_location", "a1,2026-10-01T08:00:00Z,No water in Garissa again this is terrible,SampleNet,10,2,Garissa,", "a2,2026-10-01T09:00:00Z,The water project in Kisumu is working well thank you,SampleNet,4,0,,\"Kisumu, Kenya\"",
    "a3,2026-10-02T09:00:00Z,Fuel prices are too expensive #FuelKE,SampleTube,1,1,,", "a4,2026-10-05T09:00:00Z,Bandits attacked a village near Turkana people are afraid,SampleNet,7,3,,", "a5,2026-10-05T10:00:00Z,The meeting about fuel prices is on Tuesday #FuelKE,SampleTube,0,0,Nairobi,"].join("\n");
  const id = (await ana.post("/api/io/datasets", undefined, { form: form(csv) })).body.id;
  const all = (await ana.get(`/api/io/datasets/${id}/insights`)).body.insights;
  assert.equal(all.posts, 5); assert.equal(Object.values(all.sentiment.counts).reduce((a, b) => a + b, 0), 5);
  assert.equal(all.engagement.totals.likes, 22); assert.equal(all.engagement.totals.shares, 6); assert.equal(all.engagement.totals.views, undefined, "views are not in the data, so not reported");
  assert.equal(all.geography.recorded.post, 2); assert.equal(all.geography.recorded.profile, 1); assert.equal(all.geography.recorded.unknown, 2);
  assert.ok(all.geography.mentioned.some(m => m.name === "Turkana"), "places in the text are listed separately");
  assert.ok(all.geography.counties.find(c => c.name === "Kisumu" && c.basis === "profile"));
  assert.equal(all.hashtags[0].tag, "#fuelke"); assert.ok(all.themes.find(t => t.key === "economy").posts >= 2);
  const f = async q => (await ana.get(`/api/io/datasets/${id}/insights?${new URLSearchParams(q)}`)).body.insights;
  assert.equal((await f({ platform: "SampleTube" })).posts, 2); assert.equal((await f({ theme: "security" })).posts, 1); assert.equal((await f({ sentiment: "negative" })).posts, all.sentiment.counts.negative);
  assert.equal((await f({ q: "fuel" })).posts, 2); assert.equal((await f({ from: "2026-10-05", to: "2026-10-05" })).posts, 2); assert.equal((await f({ q: "nothing-matches-this" })).empty, true);
  assert.equal((await f({ q: "50%_\\" })).posts, 0, "LIKE wildcards in the search are treated as text");
  const pg = (await ana.get(`/api/io/datasets/${id}/posts?limit=2&offset=2&platform=SampleNet`)).body; assert.equal(pg.total, 3); assert.equal(pg.posts.length, 1);
});

test("synthetic discussion sample: growing theme, unusual engagement, repeated claim and scam flagged; claim to case; report", async () => {
  const r = await ana.post("/api/io/discussion-sample", {}); assert.equal(r.status, 201, JSON.stringify(r.body)); const id = r.body.id;
  const I = (await ana.get(`/api/io/datasets/${id}/insights`)).body.insights;
  assert.ok(I.emerging.some(e => e.key === "security"), "the planted late security theme is detected"); assert.ok(I.engagement.unusual.posts >= 1);
  assert.ok(I.platforms.length === 3); assert.ok(I.topics.length >= 2);
  const C = (await ana.get(`/api/io/datasets/${id}/claims`)).body;
  const bore = C.claims.find(c => /boreholes in Garissa/.test(c.text)); assert.equal(bore.posts, 9); assert.equal(bore.accounts, 9);
  const all = (await ana.get(`/api/io/datasets/${id}/claims?limit=100`)).body.claims, scam = all.find(c => /inaajiri vijana/.test(c.text));
  assert.ok(scam && scam.status === "needs_review" && scam.flags.some(f => f.key === "payment"), "the scam claim carries red flags and needs review");
  assert.equal((await ana.patch(`/api/io/claims/${bore.id}`, { status: "dismissed" })).status, 400, "dismissing needs a reason");
  assert.equal((await view.patch(`/api/io/claims/${bore.id}`, { status: "dismissed", note: "x" })).status, 403);
  const k = await ana.post(`/api/io/claims/${bore.id}/case`, {}); assert.equal(k.status, 201); assert.match(k.body.id, /^TR-/, "a synthetic dataset opens training cases");
  const after = (await ana.get(`/api/io/datasets/${id}/claims?status=in_case`)).body.claims[0]; assert.equal(after.case_id, k.body.id);
  assert.equal((await ana.post(`/api/io/claims/${bore.id}/case`, {})).status, 409);
  // report in all formats; the stored copy matches its fingerprint; same data and filters give the same input fingerprint
  const j1 = await ana.get(`/api/io/datasets/${id}/report.json?platform=SampleNet&research_question=${encodeURIComponent("What do residents say?")}`); assert.equal(j1.status, 200);
  const R = j1.body; assert.equal(R.synthetic, true); assert.equal(R.research_question, "What do residents say?"); assert.equal(R.filters.platform, "SampleNet");
  for (const sec of ["executive_summary", "methodology", "sentiment", "themes", "topics", "engagement", "geography", "coordination_indicators", "claims", "limitations", "recommendations", "reproducibility"]) assert.ok(R[sec] !== undefined, sec);
  assert.equal(R.sentiment.counts.positive + R.sentiment.counts.negative + R.sentiment.counts.neutral + R.sentiment.counts.mixed, R.reproducibility.posts_included);
  const j2 = (await ana.get(`/api/io/datasets/${id}/report.json?platform=SampleNet`)).body; assert.equal(j2.reproducibility.input_sha256, R.reproducibility.input_sha256);
  const pdf = await ana.get(`/api/io/datasets/${id}/report.pdf`); assert.equal(pdf.status, 200); assert.equal(pdf.headers.get("content-type"), "application/pdf");
  const csv = await ana.get(`/api/io/datasets/${id}/report.csv`); assert.match(csv.body, /"sentiment","negative"/);
  const html = await ana.get(`/api/io/datasets/${id}/report.html`); assert.match(html.body, /SYNTHETIC DATASET/); assert.match(html.headers.get("content-security-policy"), /default-src 'none'/);
  const list = (await ana.get(`/api/io/datasets/${id}/reports`)).body.reports; assert.equal(list.length, 5);
  const again = await ana.get(`/api/io/reports/${R.report_id}.json`); assert.equal(again.body.content_sha256, R.content_sha256); assert.equal(again.body.generated_at, R.generated_at, "a stored report is reproduced exactly");
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'Social media analysis report generated%'").get().n >= 5);
});

test("claims: published fact-checks from approved datasets are linked; case evidence is shown with the claim", async () => {
  const kf = new FormData(); kf.append("file", new Blob(["claim,label,url,publisher,date,language\nThe county government has closed all boreholes in Garissa,False,https://factcheck.example/boreholes,Example Check,2026-09-01,en\n"]), "kb.csv");
  for (const [k, v] of Object.entries({ name: "Example fact-checks", license: "CC BY 4.0", permitted_use: "Research" })) kf.append(k, v);
  const kid = (await admin.post("/api/kb/datasets", undefined, { form: kf })).body.id; assert.equal((await rev.post(`/api/kb/datasets/${kid}/approve`, {})).status, 200);
  const csv = ["account,posted_at,text", ...[1, 2, 3].map(i => `acc${i},2026-10-0${i}T08:00:00Z,The county government has closed all boreholes in Garissa until further notice.`)].join("\n");
  const id = (await ana.post("/api/io/datasets", undefined, { form: form(csv) })).body.id;
  const c = (await ana.get(`/api/io/datasets/${id}/claims`)).body.claims[0];
  assert.equal(c.status, "needs_review"); assert.equal(c.kb[0].publisher, "Example Check"); assert.equal(c.kb[0].url, "https://factcheck.example/boreholes"); assert.equal(c.kb[0].label, "contradicted");
  const k = (await ana.post(`/api/io/claims/${c.id}/case`, {})).body.id;
  const caseClaim = S.ctx.db.prepare("SELECT id FROM claims WHERE case_id = ? AND removed = 0 LIMIT 1").get(k);
  const eid = (await ana.post(`/api/cases/${k}/evidence`, { kind: "source_claim", text: "County water office statement: boreholes remain open.", reference: "https://county.example/statement", links: [{ claim_id: caseClaim.id, stance: "contradicts" }] })).body.id;
  await ana.patch(`/api/evidence/${eid}`, { status: "accepted" });
  const c2 = (await ana.get(`/api/io/datasets/${id}/claims?status=in_case`)).body.claims[0];
  assert.equal(c2.case_id, k); assert.ok(c2.case_evidence.some(e => e.stance === "contradicts" && /boreholes remain open/.test(e.text)), JSON.stringify(c2.case_evidence));
});

test("local AI (Ollama): status, sentiment stored with its method, invalid or incomplete answers rejected, citations checked", async () => {
  const st = (await ana.get("/api/social/ollama")).body; assert.equal(st.reachable, true); assert.equal(st.model_available, true);
  const csv = ["account,posted_at,text", ...Array.from({ length: 10 }, (_, i) => `u${i},2026-10-01T0${i}:00:00Z,${i % 2 ? "No water again this is terrible" : "Meeting on Tuesday about the road project"}`)].join("\n");
  const id = (await ana.post("/api/io/datasets", undefined, { form: form(csv) })).body.id;
  assert.equal((await view.post(`/api/io/datasets/${id}/ai`, { task: "sentiment" })).status, 403);
  ollamaMode = "ok"; let j = await wait(ana, (await ana.post(`/api/io/datasets/${id}/ai`, { task: "sentiment" })).body.job);
  assert.equal(j.status, "done", j.error); assert.equal(j.counts.classified, 10);
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM io_posts WHERE dataset_id = ? AND sentiment_method = 'ollama:testmodel'").get(id).n, 10);
  const I = (await ana.get(`/api/io/datasets/${id}/insights`)).body.insights; assert.equal(I.sentiment.methods[0].method, "ollama:testmodel");
  await ana.post(`/api/io/datasets/${id}/enrich`, {}); assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM io_posts WHERE dataset_id = ? AND sentiment_method = 'ollama:testmodel'").get(id).n, 10, "re-running the rules keeps AI labels");
  ollamaMode = "skip"; j = await wait(ana, (await ana.post(`/api/io/datasets/${id}/ai`, { task: "sentiment" })).body.job);
  assert.equal(j.counts.classified, 0); assert.equal(j.counts.failed, 10); assert.match(j.counts.errors[0], /rejected/);
  ollamaMode = "garbage"; j = await wait(ana, (await ana.post(`/api/io/datasets/${id}/ai`, { task: "summary" })).body.job); assert.equal(j.status, "failed"); assert.match(j.error, /valid JSON/);
  ollamaMode = "cite_bad"; j = await wait(ana, (await ana.post(`/api/io/datasets/${id}/ai`, { task: "summary" })).body.job); assert.equal(j.status, "failed"); assert.match(j.error, /cited posts/);
  ollamaMode = "ok"; j = await wait(ana, (await ana.post(`/api/io/datasets/${id}/ai`, { task: "summary" })).body.job); assert.equal(j.status, "done");
  assert.match((await ana.get(`/api/io/datasets/${id}/insights`)).body.dataset.content.ai_summary.summary, /water/);
  j = await wait(ana, (await ana.post(`/api/io/datasets/${id}/ai`, { task: "claims" })).body.job); assert.equal(j.status, "done"); assert.ok(j.counts.rejected_unsupported >= 1, "a claim not found in its post is rejected");
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM io_claims WHERE dataset_id = ? AND text LIKE '%Aliens%'").get(id).n, 0);
});

test("local AI unavailable: clear status, no job started, rule-based analysis unaffected; public addresses refused", async () => {
  const S2 = await startServer({ ollama: { url: "http://127.0.0.1:9", model: "m", timeoutMs: 1000 } }), a2 = await login(S2.base, "ana");
  const st = (await a2.get("/api/social/ollama")).body; assert.equal(st.reachable, false); assert.match(st.error, /not reachable/);
  const id = (await a2.post("/api/io/datasets", undefined, { form: form("account,posted_at,text\nx,2026-10-01T00:00:00Z,No water again this is terrible\n") })).body.id;
  const r = await a2.post(`/api/io/datasets/${id}/ai`, { task: "sentiment" }); assert.equal(r.status, 409); assert.match(r.body.error, /rule-based analysis is unaffected/);
  assert.equal((await a2.get(`/api/io/datasets/${id}/insights`)).body.insights.sentiment.counts.negative, 1);
  await S2.close();
  const S3 = await startServer({ ollama: { url: "http://ollama.example.com:11434", model: "m" } }), a3 = await login(S3.base, "ana");
  assert.match((await a3.get("/api/social/ollama")).body.error, /must not be exposed to the internet/); await S3.close();
  const S4 = await startServer(), a4 = await login(S4.base, "ana"); const st4 = (await a4.get("/api/social/ollama")).body; assert.equal(st4.configured, false); assert.match(st4.needs, /OLLAMA_URL/); await S4.close();
});

test("collection: news feeds and YouTube through official access; X not configured; pending platforms refused; provenance kept", async () => {
  const ov = (await ana.get("/api/social/overview")).body.collectors;
  assert.equal(ov.find(c => c.key === "youtube").state, "ready"); assert.equal(ov.find(c => c.key === "x").state, "not_configured"); assert.equal(ov.find(c => c.key === "tiktok").state, "pending");
  assert.equal((await ana.post("/api/io/collect", { source: "tiktok", name: "x", authorisation: "y" })).status, 400);
  assert.equal((await ana.post("/api/io/collect", { source: "x", query: "fuel", name: "x", authorisation: "y" })).status, 409);
  assert.equal((await ana.post("/api/io/collect", { source: "news", feeds: `${F}/feed.xml`, name: "News" })).status, 400, "the basis for use is required");
  assert.equal((await view.post("/api/io/collect", { source: "news", feeds: `${F}/feed.xml`, name: "News", authorisation: "y" })).status, 403);
  let j = await wait(ana, (await ana.post("/api/io/collect", { source: "news", feeds: `${F}/feed.xml`, query: "water", name: "County news", authorisation: "Public news feeds, our policy" })).body.job);
  assert.equal(j.status, "done", j.error); assert.equal(j.counts.collected, 1, "the query filters items");
  const p = (await ana.get(`/api/io/datasets/${j.counts.dataset_id}/posts`)).body.posts[0];
  assert.equal(p.platform, "News website"); assert.equal(p.account, "example county news"); assert.equal(p.url, "https://news.example/1"); assert.match(p.text, /supply will return/); assert.match(p.collected_via, /RSS\/Atom feed/);
  j = await wait(ana, (await ana.post("/api/io/collect", { source: "news", feeds: `${F}/site ${F}/nofeed`, name: "County news from site", authorisation: "Public news feeds" })).body.job);
  assert.equal(j.status, "done", j.error); assert.equal(j.counts.collected, 2, "the feed announced by the website is found and read"); assert.deepEqual(j.counts.feeds_found, [`${F}/feed.xml`]); assert.match(j.counts.errors[0], /does not announce a news feed/);
  j = await wait(ana, (await ana.post("/api/io/collect", { source: "youtube", query: "floods", name: "YouTube floods", authorisation: "YouTube API terms" })).body.job);
  assert.equal(j.status, "done", j.error); const ds = j.counts.dataset_id, y = (await ana.get(`/api/io/datasets/${ds}/posts`)).body.posts;
  assert.equal(y.length, 2); assert.equal(y[1].views, 2000); assert.equal(y[0].comments, 7); assert.match(y[0].collected_via, /YouTube Data API v3/);
  j = await wait(ana, (await ana.post("/api/io/collect", { source: "youtube", query: "floods", dataset_id: ds })).body.job);
  assert.equal(j.counts.added, 0); assert.equal(j.counts.duplicates, 2, "collected posts already present are not added twice");
  assert.equal(S.ctx.db.prepare("SELECT SUM(units) u FROM api_usage WHERE service = 'youtube_api' AND operation = 'search.list' AND unit = 'search calls'").get().u, 2, "YouTube search calls are counted (100 a day, own quota bucket)");
  const jobs = (await ana.get("/api/social/overview")).body.jobs; assert.ok(jobs.some(x => x.kind === "collect_youtube" && x.status === "done"));
  const S5 = await startServer({ collect: { xBearer: "test-token", timeoutMs: 3000, bases: { x: `${F}/x` } } }), a5 = await login(S5.base, "ana");
  const jx = await wait(a5, (await a5.post("/api/io/collect", { source: "x", query: "fuel", name: "X fuel", authorisation: "X API terms" })).body.job); assert.equal(jx.status, "done", jx.error);
  const xp = (await a5.get(`/api/io/datasets/${jx.counts.dataset_id}/posts`)).body.posts[0];
  assert.equal(xp.account, "practice_user"); assert.equal(xp.shares, 3, "retweets and quotes"); assert.equal(xp.views, 400); assert.equal(xp.loc_basis, "post"); assert.equal(xp.loc_country, "KE"); assert.equal(xp.url, "https://x.com/practice_user/status/1");
  await S5.close();
});

test("data survives a restart; deleting a dataset removes its topics and claims and is audited", async () => {
  const id = (await ana.post("/api/io/datasets", undefined, { form: form("account,posted_at,text\nx,2026-10-01T00:00:00Z,The county closed the main road to Garissa for repairs this week.\n") })).body.id;
  const { app } = createApp(S.config), srv = await new Promise(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const a2 = await login(`http://127.0.0.1:${srv.address().port}`, "ana"); const I = (await a2.get(`/api/io/datasets/${id}/insights`)).body.insights;
  assert.equal(I.posts, 1); assert.equal((await a2.get(`/api/io/datasets/${id}/claims`)).body.total, 1); srv.close();
  assert.equal((await ana.del(`/api/io/datasets/${id}`)).status, 403); assert.equal((await admin.del(`/api/io/datasets/${id}`)).status, 200);
  for (const t of ["io_posts", "io_topics", "io_claims"]) assert.equal(S.ctx.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE dataset_id = ?`).get(id).n, 0, t);
  const anon = await fetch(`${S.base}/api/io/datasets/1/insights`); assert.equal(anon.status, 401);
});

test("upgrade from database version 7: a backup is written first and existing posts are kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-mig-")), file = path.join(dir, "aivs.db");
  let db = openDb(file);
  db.prepare("INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES ('u','U','analyst','x','2026-01-01')").run();
  db.prepare("INSERT INTO io_datasets(name,source,authorisation,posts,accounts,imported_by,imported_at) VALUES ('old','s','a',1,1,1,'2026-01-01')").run();
  db.prepare("INSERT INTO io_posts(dataset_id,account,posted_at,text) VALUES (1,'acc','2026-01-01T00:00:00Z','an old post')").run();
  // turn it back into a version-7 database
  db.exec("DROP INDEX io_posts_topic; DROP TABLE io_topics; DROP TABLE io_claims; DROP TABLE io_jobs; DROP TABLE io_reports;");
  for (const c of ["url", "comments", "views", "language", "collected_at", "collected_via", "loc_country", "loc_region", "loc_name", "loc_basis", "mentioned_places", "sentiment", "sentiment_score", "sentiment_confidence", "sentiment_method", "themes", "topic_no"]) db.exec(`ALTER TABLE io_posts DROP COLUMN ${c}`);
  for (const c of ["research_question", "collection_method", "enriched_at", "enrich_json"]) db.exec(`ALTER TABLE io_datasets DROP COLUMN ${c}`);
  db.pragma("user_version = 7"); db.close();
  db = openDb(file);
  assert.ok(db.pragma("user_version", { simple: true }) >= 9, "upgraded to the latest version"); assert.equal(db.prepare("SELECT text FROM io_posts").get().text, "an old post");
  const bak = fs.readdirSync(dir).find(f => /^aivs\.db\.before-v\d+-.*\.bak$/.test(f)); assert.ok(bak, "backup written");
  const old = new Database(path.join(dir, bak), { readonly: true }); assert.equal(old.pragma("user_version", { simple: true }), 7); assert.equal(old.prepare("SELECT COUNT(*) n FROM io_posts").get().n, 1); old.close(); db.close();
});

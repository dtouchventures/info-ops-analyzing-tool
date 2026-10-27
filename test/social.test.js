// Social media analysis (AIVS 1.10): one public post through the platforms' public embed services (faked locally),
// honest statuses when a post cannot be read, a post case with screenshots and OCR, the platform's answer archived,
// account/message comparison with imported post datasets, and Verify sending social links to the post flow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { startServer, login, T } from "./helpers.js";

const XID = "1846000000000000000";   // an X post ID encodes its creation time (October 2024)
let S, ana, fake, F, calls = [];
const pdf = text => new Promise(ok => { const d = new PDFDocument({ info: { Title: "County notice" } }), ch = []; d.on("data", c => ch.push(c)); d.on("end", () => ok(Buffer.concat(ch))); d.text(text); d.end(); });
before(async () => {
  const notice = await pdf("PUBLIC NOTICE. The county government will close the Garissa road for repairs from 3 March 2025. Motorists should use the bypass. Issued by the County Secretary.");
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); calls.push(u.pathname + u.search);
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/x/oembed") {
      const target = u.searchParams.get("url");
      if (target.endsWith(XID)) return json(200, { author_name: "Kenya Practice Desk", author_url: "https://twitter.com/practice_desk", html: `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">BREAKING: Ministry of Health confirms hot lemon water cures malaria.<br>Share before they delete this! <a href="https://t.co/x">#HealthKE</a></p>&mdash; Kenya Practice Desk (@practice_desk) <a href="https://twitter.com/practice_desk/status/${XID}?ref_src=twsrc">October 14, 2024</a></blockquote>` });
      return json(404, { error: "not found" });
    }
    if (u.pathname === "/yt/oembed") return json(200, { title: "Floods in Budalang'i today", author_name: "Practice Channel", author_url: "https://www.youtube.com/@practicechannel" });
    if (u.pathname === "/tg/practicechan/42") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<div class="tgme_widget_message"><a class="tgme_widget_message_owner_name" href="#"><span dir="auto">Practice Channel</span></a><div class="tgme_widget_message_text js-message_text" dir="auto">Tuma Sh1,500 kwa M-Pesa ili kusajiliwa.<br/>Nafasi ni chache!</div><time datetime="2026-10-20T08:15:00+00:00" class="time">08:15</time></div>`); }
    if (u.pathname === "/notice.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end(notice); }
    res.writeHead(404); res.end();
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ allowPrivateFetch: true, social: { timeoutMs: 3000, bases: { x: `${F}/x`, youtube: `${F}/yt`, telegram: `${F}/tg`, tiktok: `${F}/tt`, meta: `${F}/meta` } } });
  ana = await login(S.base, "ana");
});
after(async () => { await S.close(); fake.close(); });

test("lookup: X post through the public embed; text, account, ID time; raw answer kept on the server only", async () => {
  const r = (await ana.post("/api/social/lookup", { url: `https://x.com/practice_desk/status/${XID}` })).body;
  assert.equal(r.social, true); assert.equal(r.status, "ok"); assert.equal(r.platform, "X (Twitter)"); assert.equal(r.account, "@practice_desk"); assert.equal(r.author_name, "Kenya Practice Desk");
  assert.match(r.text, /^BREAKING: Ministry of Health confirms hot lemon water cures malaria\.\nShare before they delete this! #HealthKE$/);
  assert.match(r.posted_basis, /post ID/); assert.ok(r.posted_at.startsWith("2024-10-")); assert.equal(r.raw, undefined); assert.equal(r.archived, true);
  assert.equal(r.text_source, "X public embed (oEmbed)");
});

test("lookup: honest statuses (deleted post, account link, Meta without token, WhatsApp, a news site); nothing invented", async () => {
  const del = (await ana.post("/api/social/lookup", { url: "https://x.com/someone/status/1846000000000000999" })).body;
  assert.equal(del.status, "unavailable"); assert.equal(del.text, null); assert.match(del.message, /deleted|private/); assert.equal(del.account, "@someone", "what the link itself shows is still given");
  assert.equal((await ana.post("/api/social/lookup", { url: "https://x.com/someone" })).body.status, "not_a_post");
  const fb = (await ana.post("/api/social/lookup", { url: "https://www.facebook.com/somepage/posts/123" })).body;
  assert.equal(fb.status, "not_configured"); assert.match(fb.message, /META_OEMBED_TOKEN/); assert.ok(!calls.some(c => c.startsWith("/meta")), "nothing is sent to Meta without a token");
  assert.equal((await ana.post("/api/social/lookup", { url: "https://wa.me/254700000000" })).body.status, "unsupported");
  assert.equal((await ana.post("/api/social/lookup", { url: "https://nation.africa/kenya/news/story" })).body.social, false);
  assert.equal((await ana.post("/api/social/lookup", { url: "not a link" })).status, 400);
  const yt = (await ana.post("/api/social/lookup", { url: "https://www.youtube.com/watch?v=abc123def45&si=tracking" })).body;
  assert.equal(yt.status, "partial"); assert.equal(yt.text_status, "title"); assert.equal(yt.normalized_url, "https://www.youtube.com/watch?v=abc123def45"); assert.match(yt.transcript.note, /owner/); assert.equal(yt.account, "@practicechannel"); assert.match(yt.text_source, /title only/);
  const tg = (await ana.post("/api/social/lookup", { url: "https://t.me/practicechan/42" })).body;
  assert.equal(tg.status, "ok"); assert.equal(tg.account, "@practicechan"); assert.equal(tg.text, "Tuma Sh1,500 kwa M-Pesa ili kusajiliwa.\nNafasi ni chache!"); assert.equal(tg.posted_at, "2026-10-20T08:15:00.000Z");
  const usage = S.ctx.db.prepare("SELECT service, status FROM api_usage WHERE operation = 'post lookup'").all();
  assert.ok(usage.some(u => u.service === "x_embed" && u.status === "ok") && usage.some(u => u.service === "x_embed" && u.status === "error"));
  const svc = (await ana.get("/api/meta")).body.social; assert.equal(svc.find(s => s.key === "meta").configured, false); assert.equal(svc.find(s => s.key === "x").configured, true);
});

test("post case: embed text, screenshot with its OCR, archived platform answer, claims and red-flag leads, dataset comparison", async () => {
  // a post dataset in the IO monitor that contains the same account and a near-identical message from others
  const csv = ["account,posted_at,text", `practice_desk,2024-10-14T09:00:00Z,"BREAKING: Ministry of Health confirms hot lemon water cures malaria. Share before they delete this!"`,
    `copycat_1,2024-10-14T09:02:00Z,"BREAKING Ministry of Health confirms hot lemon water cures malaria. share before they delete this"`, `other,2024-10-14T10:00:00Z,"Traffic is heavy on Thika road this morning near the flyover"`].join("\n");
  const fd0 = new FormData(); fd0.append("file", new Blob([csv]), "p.csv"); for (const [k, v] of Object.entries({ name: "October exports", source: "test", authorisation: "test" })) fd0.append(k, v);
  assert.equal((await ana.post("/api/io/datasets", undefined, { form: fd0 })).status, 201);
  const url = `https://x.com/practice_desk/status/${XID}`, look = (await ana.post("/api/social/lookup", { url })).body, n0 = calls.length;
  const fd = new FormData();
  for (const [k, v] of Object.entries({ url, text: look.text, account: look.account, platform: look.platform, posted_at: look.posted_at, posted_basis: look.posted_basis, search: "local" })) fd.append(k, v);
  fd.append("files", new Blob([fs.readFileSync(T("images/case_convoy.jpg"))], { type: "image/jpeg" }), "shot.jpg");
  fd.append("ocr_0", JSON.stringify({ text: "Kenya Practice Desk @practice_desk BREAKING: Ministry of Health confirms", confidence: 81, lang: "eng+swa" }));
  const r = await ana.post("/api/verify/post", undefined, { form: fd });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(calls.length, n0, "the server reused its lookup instead of asking the platform again");
  const b = r.body, c = S.ctx.db.prepare("SELECT * FROM cases WHERE id = ?").get(b.id);
  assert.equal(c.source_platform, "X (Twitter)"); assert.equal(c.source_account, "@practice_desk"); assert.equal(c.source_url, url); assert.match(c.published_basis, /post ID/);
  assert.equal(b.text_basis, "X public embed (oEmbed)"); assert.ok(c.source_snapshot_sha256); assert.equal(b.post.archived_sha256, c.source_snapshot_sha256);
  const snap = JSON.parse(fs.readFileSync(S.ctx.storage.pathOf(c.source_snapshot_sha256), "utf8")); assert.match(snap.platform_response, /Kenya Practice Desk/); assert.equal(snap.link, url);
  assert.ok(b.claims.length >= 1); assert.equal(b.media.length, 1); assert.deepEqual(b.media_errors, []);
  const o = S.ctx.db.prepare("SELECT * FROM ocr_texts WHERE case_id = ?").get(b.id); assert.equal(o.lang, "eng+swa"); assert.equal(o.confidence, 81); assert.match(o.engine, /browser/);
  const leads = S.ctx.db.prepare("SELECT sys_key FROM evidence WHERE case_id = ? AND kind = 'lead'").all(b.id).map(x => x.sys_key).join(" "); assert.match(leads, /flag:/, "red flags (cure, urgency) become leads");
  const x = b.io_context; assert.equal(x.datasets_searched, 1); assert.equal(x.account_posts, 1); assert.equal(x.similar_accounts, 2); assert.equal(x.similar[0].account, "practice_desk");
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id = ? AND action LIKE 'Post looked up%'").get(b.id).n === 1);
  const dl = await ana.get(`/api/cases/${b.id}/snapshot`); assert.equal(dl.status, 200); assert.match(dl.headers.get("content-disposition"), /\.txt"/);
});

test("post case from a link only: the server fills the words from the platform's public embed; Facebook without a token says why", async () => {
  const url = `https://x.com/practice_desk/status/${XID}`, fd = new FormData(); fd.append("url", url); fd.append("search", "local");
  const r = await ana.post("/api/verify/post", undefined, { form: fd }); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.text_basis, "X public embed (oEmbed)"); assert.ok(r.body.claims.length >= 1);
  const c = S.ctx.db.prepare("SELECT claim_text, source_snapshot_sha256 FROM cases WHERE id = ?").get(r.body.id); assert.match(c.claim_text, /Ministry of Health/); assert.ok(c.source_snapshot_sha256, "the platform's answer is archived");
  const f = new FormData(); f.append("url", "https://www.facebook.com/share/p/18j15o3bDz/");
  const e = await ana.post("/api/verify/post", undefined, { form: f }); assert.equal(e.status, 400); assert.match(e.body.error, /words of the post.*META_OEMBED_TOKEN/);
});

test("post case from a screenshot only (no link); missing words refused with temporary files removed; analyst-typed text labelled", async () => {
  const fd = new FormData(); fd.append("files", new Blob([fs.readFileSync(T("images/case_convoy.jpg"))], { type: "image/jpeg" }), "wa.jpg");
  fd.append("ocr_0", JSON.stringify({ text: "Forwarded many times. Wizara ya Ulinzi inaajiri vijana 5,000. Tuma Sh1,500 kwa M-Pesa namba 0712 345 678.", confidence: 74, lang: "eng+swa" })); fd.append("platform", "WhatsApp"); fd.append("search", "local");
  const r = await ana.post("/api/verify/post", undefined, { form: fd }); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.text_basis, /OCR/); assert.equal(r.body.post.platform, "WhatsApp"); assert.equal(r.body.post.archived_sha256, null, "nothing to archive without a lookup");
  const tmp = S.ctx.storage.tmpDir, before = fs.readdirSync(tmp).length;
  const bad = new FormData(); bad.append("files", new Blob([fs.readFileSync(T("images/case_convoy.jpg"))], { type: "image/jpeg" }), "x.jpg"); bad.append("url", "https://x.com/a/status/1");
  const e = await ana.post("/api/verify/post", undefined, { form: bad }); assert.equal(e.status, 400); assert.match(e.body.error, /words of the post/);
  assert.equal(fs.readdirSync(tmp).length, before, "uploaded files are removed when the request is refused");
  const t = new FormData(); for (const [k, v] of Object.entries({ text: "The governor said the dam will be finished in May 2025.", account: "@county_watch", platform: "Facebook", search: "local" })) t.append(k, v);
  const r2 = (await ana.post("/api/verify/post", undefined, { form: t })).body; assert.equal(r2.text_basis, "entered by the analyst"); assert.equal(r2.post.account, "@county_watch");
  const view = await login(S.base, "view"); assert.equal((await view.post("/api/verify/post", undefined, { form: t })).status, 403);
});

test("synthetic practice datasets are compared only with training cases; OCR text is labelled as OCR", async () => {
  assert.equal((await ana.post("/api/io/sample", {})).status, 201);
  const mk = async training => { const fd = new FormData(); for (const [k, v] of Object.entries({ text: "The water project funds have disappeared, demand answers now", account: "@someone_new", search: "local", is_training: String(training), text_source: "ocr" })) fd.append(k, v);
    fd.append("files", new Blob([fs.readFileSync(T("images/case_convoy.jpg"))], { type: "image/jpeg" }), "s.jpg"); fd.append("ocr_0", JSON.stringify({ text: "County Voices\nThe water project funds have disappeared, demand answers now", confidence: 90, lang: "eng" }));
    const r = await ana.post("/api/verify/post", undefined, { form: fd }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const real = await mk(false), tr = await mk(true);
  assert.equal(real.io_context.similar.length, 0, "a real case is not compared with invented posts"); assert.ok(tr.io_context.similar.length >= 3, "a training case is");
  assert.match(real.text_basis, /OCR/);
});

test("Verify information: social links are sent to the post flow; PDF links are read", async () => {
  const s = await ana.post("/api/verify", { input: `https://x.com/practice_desk/status/${XID}` });
  assert.equal(s.status, 422); assert.match(s.body.error, /Social media post/);
  const p = await ana.post("/api/verify", { input: `${F}/notice.pdf`, search: false });
  assert.equal(p.status, 201, JSON.stringify(p.body)); assert.equal(p.body.source.title, "County notice"); assert.ok(p.body.claims.some(c => /Garissa road/.test(c.text)));
  const c = S.ctx.db.prepare("SELECT source_snapshot_mime FROM cases WHERE id = ?").get(p.body.id); assert.equal(c.source_snapshot_mime, "application/pdf");
  const dl = await ana.get(`/api/cases/${p.body.id}/snapshot`); assert.match(dl.headers.get("content-disposition"), /\.pdf"/);
});

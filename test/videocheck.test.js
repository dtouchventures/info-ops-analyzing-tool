// Reverse video search and video verification (1.35). The videos in test/fixtures/video are SYNTHETIC (invented textures with
// captions labelled TEST FIXTURE, made by scripts/make-video-fixtures.mjs). Google Cloud Vision, the YouTube Data API, the
// transcription service and the "earlier publications" are local TEST DOUBLES; nothing here reaches the internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startServer, login } from "./helpers.js";
import { sniff } from "../server/lib/sniff.js";
import { fingerprint, compareFp, videoTools } from "../server/lib/videocheck.js";
import { extractDocument } from "../server/lib/docs.js";

const FX = f => path.resolve("test/fixtures/video", f);
let F, fake, S, S2, ana, view, ana2, earlierFp;
const calls = { vision: 0, youtube: 0, transcribe: 0 };
before(async () => {
  earlierFp = await fingerprint(FX("earlier-copy-scene-a.jpg"));
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), j = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const body = () => new Promise(ok => { const b = []; req.on("data", d => b.push(d)); req.on("end", () => ok(Buffer.concat(b))); });
    // Google Cloud Vision web detection: reports the earlier page for the keyframe that shows scene A, and an unrelated page as a partial match
    if (u.pathname === "/v1/images:annotate") return body().then(async b => { calls.vision++; const img = Buffer.from(JSON.parse(b).requests[0].image.content, "base64"), d = compareFp(await fingerprint(img), earlierFp);
      j(200, { responses: [{ webDetection: d.score <= 30 ? { pagesWithMatchingImages: [{ url: `${F}/news/2019-convoy`, pageTitle: "TEST FIXTURE convoy", fullMatchingImages: [{ url: `${F}/img/earlier.jpg` }] }, { url: `${F}/blog/market`, pageTitle: "TEST FIXTURE market", partialMatchingImages: [{ url: `${F}/img/unrelated.jpg` }] }],
        fullMatchingImages: [{ url: `${F}/img/earlier.jpg` }], bestGuessLabels: [{ label: "test fixture" }] } : {} }] }); });
    if (u.pathname === "/news/2019-convoy") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><head><title>TEST FIXTURE: Convoy passes through Garissa town</title><meta property="article:published_time" content="2019-10-14T09:00:00Z"><meta property="og:site_name" content="Example Kenya News (test)"><meta property="og:image" content="${F}/img/earlier.jpg"></head><body><article><h1>Convoy passes through Garissa town</h1><p>TEST FIXTURE. A military convoy passed through Garissa town on Monday morning, residents said. The vehicles were on a routine movement.</p></article></body></html>`); }
    if (u.pathname === "/blog/market") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><head><title>TEST FIXTURE: Market day in Wajir</title><meta property="article:published_time" content="2024-01-05T09:00:00Z"></head><body><article><p>TEST FIXTURE. A busy market day in Wajir with traders from the region and their goods.</p></article></body></html>`); }
    if (u.pathname === "/img/earlier.jpg") { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(fs.readFileSync(FX("earlier-copy-scene-a.jpg"))); }
    if (u.pathname === "/img/unrelated.jpg") { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(fs.readFileSync(FX("unrelated-scene-e.jpg"))); }
    if (u.pathname === "/media/clip.mov") { res.writeHead(200, { "content-type": "video/quicktime" }); return res.end(fs.readFileSync(FX("fresh-lamu.mov"))); }
    // YouTube Data API search: one earlier upload whose thumbnail is scene A, one unrelated
    if (u.pathname === "/youtube/v3/search") { calls.youtube++; assert.equal(u.searchParams.get("key"), "yt-key"); return j(200, { items: [
      { id: { videoId: "TESTFIXT001" }, snippet: { title: "TEST FIXTURE convoy video", channelTitle: "Test Channel", publishedAt: "2019-10-15T07:00:00Z", description: "TEST FIXTURE. Convoy in Garissa.", thumbnails: { high: { url: `${F}/img/earlier.jpg` } } } },
      { id: { videoId: "TESTFIXT002" }, snippet: { title: "TEST FIXTURE market", channelTitle: "Other", publishedAt: "2024-01-05T07:00:00Z", thumbnails: { high: { url: `${F}/img/unrelated.jpg` } } } }] }); }
    // the AIVS transcription service (faster-whisper)
    if (u.pathname === "/v1/jobs" && req.method === "POST") return body().then(() => { calls.transcribe++; j(200, { id: "job1", duration_s: 9 }); });
    if (u.pathname === "/v1/jobs/job1" && req.method === "GET") return j(200, { status: "done", result: { language: "en", language_probability: 0.98, engine: "faster-whisper", model: "small (test double)", speech_found: true,
      segments: [{ start: 0.4, end: 4.2, text: "TEST FIXTURE. Our KDF convoy was attacked in Lamu this morning.", confidence: 0.9 }, { start: 4.5, end: 8.6, text: "Share this video so everyone knows.", confidence: 0.88 }] } });
    if (u.pathname.startsWith("/v1/jobs/") && req.method === "DELETE") return j(200, { ok: true });
    if (u.pathname === "/v1alpha1/claims:search") return j(200, { claims: [] });
    res.writeHead(404); res.end();
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ allowPrivateFetch: true, search: { factcheckKey: "fc", factcheckBase: F, gdelt: false, wikipedia: false, timeoutMs: 3000 },
    mediaCheck: { visionKey: "vision-key", visionBase: F, timeoutMs: 8000 }, collect: { youtubeKey: "yt-key" }, video: { youtubeBase: `${F}/youtube/v3` }, transcribe: { url: F, token: "tok", pollMs: 50 } });
  S2 = await startServer({ allowPrivateFetch: true, search: { gdelt: false, wikipedia: false, timeoutMs: 3000 } });   // no reverse-search provider, no speech-to-text
  [ana, view] = await Promise.all(["ana", "view"].map(u => login(S.base, u))); ana2 = await login(S2.base, "ana");
});
after(async () => { for (const s of [S, S2]) { await s.ctx.videoCheck.idle(); await s.ctx.investigations.close(); await s.close(); } fake.close(); });

async function investigate(client, { text = "", url = "", file = null }) {
  const fd = new FormData(); if (text) fd.append("text", text); if (url) fd.append("url", url); if (file) fd.append("files", new Blob([fs.readFileSync(FX(file))]), file);
  const r = await client.post("/api/investigations", undefined, { form: fd }); assert.equal(r.status, 202, JSON.stringify(r.body));
  for (let i = 0; i < 1800; i++) { const g = await client.get(`/api/investigations/${r.body.id}`); if (["done", "failed"].includes(g.body.status)) return g.body; await new Promise(ok => setTimeout(ok, 100)); }
  throw new Error("investigation did not finish");
}
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(FX(f))).digest("hex");
let caseId, videoId, firstResult;

test("formats and tools: MP4, MOV and AVI recognised by content; FFmpeg and FFprobe found and reported", async () => {
  assert.equal(sniff(fs.readFileSync(FX("recycled-convoy.mp4")).subarray(0, 64)).ext, "mp4");
  assert.equal(sniff(fs.readFileSync(FX("fresh-lamu.mov")).subarray(0, 64)).ext, "mov");
  assert.deepEqual(sniff(fs.readFileSync(FX("recycled-convoy.avi")).subarray(0, 64)), { mime: "video/x-msvideo", kind: "video", ext: "avi" });
  const t = videoTools({}); assert.ok(t.ffmpeg && t.ffprobe, "FFmpeg and FFprobe available");
  const st = (await ana.get("/api/video-checks/status")).body;
  assert.equal(st.ffmpeg.available, true); assert.equal(st.speech.available, true); assert.ok(st.reverse_providers.every(p => p.configured));
  const st2 = (await ana2.get("/api/video-checks/status")).body; assert.ok(st2.reverse_providers.every(p => !p.configured)); assert.equal(st2.speech.available, false);
});

test("uploaded MP4 with a caption: keyframes, OCR, speech, reverse search; earlier copy VERIFIED and dated, recycled footage, misleading context, date and place inconsistencies; ranked; in the one-page report", async () => {
  const inv = await investigate(ana, { text: "TEST FIXTURE: Video shows the KDF convoy attacked in Lamu this morning.", file: "recycled-convoy.mp4" }), r = inv.result;
  assert.equal(inv.status, "done", inv.error); caseId = r.case_id;
  const v = r.media.videos[0]; firstResult = v; videoId = v.video.media_id;
  // the original is kept unchanged; keyframes are kept as images of the case with their timestamps
  assert.equal(v.video.sha256, sha("recycled-convoy.mp4"));
  assert.deepEqual(v.keyframes.map(k => k.t), [0, 3, 6]);
  const frames = S.ctx.db.prepare("SELECT * FROM media WHERE parent_media_id = ? ORDER BY frame_time").all(videoId);
  assert.equal(frames.length, 3); assert.deepEqual(frames.map(f => f.frame_time), [0, 3, 6]); assert.ok(frames.every(f => f.kind === "image" && f.dhash && f.case_id === caseId));
  // on-screen text and speech were read, and feed the claims
  assert.ok(v.onscreen_text.some(o => /Garissa/.test(o.text) && o.t === 0), JSON.stringify(v.onscreen_text));
  assert.match(v.transcript.text, /convoy was attacked in Lamu/); assert.equal(calls.transcribe, 1);
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id WHERE t.media_id = ?").get(videoId).n === 2, "transcript kept with the video");
  assert.ok(S.ctx.db.prepare("SELECT 1 FROM ocr_texts WHERE media_id = ?").get(frames[0].id), "keyframe OCR kept");
  assert.match(r.source.method, /speech in recycled-convoy\.mp4 transcribed/); assert.match(r.source.method, /on-screen text read by OCR from 3 keyframe/);
  // matches: verified (AIVS's own comparison) vs possible (reported by the provider, not confirmed)
  assert.equal(v.internet_search, true); assert.ok(calls.vision >= 1 && calls.youtube === 1);
  const top = v.matches[0]; assert.equal(top.rank, 1); assert.equal(top.verification, "verified"); assert.equal(top.keyframe_t, 0); assert.match(top.date, /^2019-10-1[45]/); assert.ok(top.days_before_claim > 2000);
  const news = v.matches.find(m => m.url === `${F}/news/2019-convoy`); assert.equal(news.verification, "verified"); assert.equal(news.provider_match, "full"); assert.match(news.method, /confirmed by AIVS/); assert.ok(news.snapshot_sha256, "the page is archived");
  assert.ok(fs.existsSync(S.ctx.storage.pathOf(news.snapshot_sha256)));
  const yt = v.matches.find(m => m.provider === "YouTube Data API"); assert.equal(yt.verification, "verified"); assert.equal(yt.url, "https://www.youtube.com/watch?v=TESTFIXT001");
  const blog = v.matches.find(m => m.url === `${F}/blog/market`); assert.equal(blog.verification, "possible"); assert.match(blog.method, /did not confirm/);
  assert.ok(!v.matches.some(m => /TESTFIXT002/.test(m.url || "")), "an unrelated thumbnail is not listed");
  assert.ok(v.matches.every((m, i) => i === 0 || m.relevance <= v.matches[i - 1].relevance), "ranked by relevance");
  // findings
  const kinds = v.findings.map(f => f.kind);
  if (process.env.DUMP) console.log(JSON.stringify({ f: v.findings, o: v.onscreen_text, cd: v.claim_date }, null, 1));
  for (const k of ["recycled", "context", "date", "location", "repeats_claim"]) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  assert.match(v.findings.find(f => f.kind === "context").text, /Garissa.*Lamu/);
  assert.ok(v.reuse.length >= 1); assert.equal(r.overall.verdict, "misleading", "verified recycled footage makes the content misleading");
  assert.match(v.coverage, /not a search of the entire internet/); assert.ok(v.limits.some(l => /did not establish who first published/.test(l)) && v.limits.some(l => /No test for AI generation/.test(l)));
  assert.doesNotMatch(JSON.stringify(v), /entire internet was searched|original uploader is|deepfake detected|AI-generated video/i);
  // one-page report: four sections, the video sentence, a recommendation about the recycled footage, one page
  const a = (await ana.get(`/api/investigations/${inv.id}/report.json`)).body;
  assert.match(a.analysis, /Video verification: 3 keyframes were compared; an earlier copy dated 2019-10-1\d .* was verified, indicating recycled footage/);
  assert.ok(a.recommendations.some(x => /recycled video/.test(x)) && a.recommendations.every(x => x.startsWith("There is a need to")));
  const html = (await ana.get(`/api/investigations/${inv.id}/report.html`)).body; assert.equal((html.match(/<h2>/g) || []).length, 4);
  const pdf = Buffer.from(await (await fetch(`${S.base}/api/investigations/${inv.id}/report.pdf`, { headers: { cookie: ana.cookie } })).arrayBuffer());
  assert.equal((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1); assert.match((await extractDocument(pdf, "r.pdf")).text.replace(/\s+/g, " "), /Video verification/);
  const det = (await ana.get(`/api/investigations/${inv.id}/details.html`)).body; assert.match(det, /<h2>Video verification<\/h2>/); assert.match(det, /Verified match/); assert.match(det, /Possible similarity/);
  const c = (await ana.get(`/api/cases/${caseId}`)).body.case; assert.match(c.uncertainties, /possible similarit/);
  if (process.env.DUMP) console.log(JSON.stringify({ analysis: a.analysis, recommendations: a.recommendations, findings: v.findings, matches: v.matches.map(m => ({ rank: m.rank, v: m.verification, url: m.url, date: m.date, method: m.method, relevance: m.relevance })), summary: v.summary }, null, 1));
});

test("Reverse video search beside Reverse image search: run again on the stored video from the case; permissions; image refused", async () => {
  const r = await ana.post(`/api/media/${videoId}/video-check`); assert.equal(r.status, 202, JSON.stringify(r.body)); assert.match(r.body.id, /^VC-\d{6}$/);
  let g; for (let i = 0; i < 1200; i++) { g = (await ana.get(`/api/video-checks/${r.body.id}`)).body; if (["done", "failed"].includes(g.status)) break; await new Promise(ok => setTimeout(ok, 100)); }
  assert.equal(g.status, "done", g.error); assert.equal(g.result.matches[0].verification, "verified"); assert.equal(g.result.keyframes.length, 3);
  assert.ok(g.stages.every(s => ["done", "warning", "skipped"].includes(s.status)), JSON.stringify(g.stages));
  assert.equal((await ana.get(`/api/media/${videoId}/video-checks`)).body.analyses.length, 2);
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM media WHERE parent_media_id = ?").get(videoId).n, 3, "keyframes of a second run are not stored twice");
  assert.equal((await view.post(`/api/media/${videoId}/video-check`)).status, 403);
  const img = S.ctx.db.prepare("SELECT id FROM media WHERE parent_media_id = ?").get(videoId).id;
  assert.equal((await ana.post(`/api/media/${img}/video-check`)).status, 415);
});

test("without reverse-search providers: keyframes and local similarity only, clearly stated; MOV without sound; AVI matched locally with the earlier MP4 upload", async () => {
  const a = await investigate(ana2, { text: "TEST FIXTURE: KDF convoy attacked in Lamu this morning.", file: "recycled-convoy.mp4" }), va = a.result.media.videos[0];
  assert.equal(va.internet_search, false); assert.match(va.coverage, /^Internet-wide reverse search was not completed .*Keyframe extraction and local similarity analysis .* were done\./);
  assert.match(va.transcript.skipped, /Speech-to-text is not configured/); assert.equal(va.matches.length, 0);
  const rep = (await ana2.get(`/api/investigations/${a.id}/report.json`)).body; assert.match(rep.analysis, /internet-wide reverse search was not completed/); assert.match(rep.assessment, /reverse search of the video's keyframes was not completed|Main limitation/);
  const b = await investigate(ana2, { text: "TEST FIXTURE: New footage of KDF engineers in Lamu.", file: "recycled-convoy.avi" }), vb = b.result.media.videos[0];
  assert.equal(b.status, "done", b.error); assert.equal(vb.video.mime, "video/x-msvideo"); assert.equal(vb.keyframes.length, 3);
  const ev = vb.matches.find(m => m.source === "earlier_video"); assert.ok(ev, JSON.stringify(vb.matches)); assert.equal(ev.verification, "verified"); assert.equal(ev.ref, a.result.case_id); assert.match(ev.method, /perceptual hashes/);
  const c = await investigate(ana2, { text: "TEST FIXTURE: Lamu waterfront today.", file: "fresh-lamu.mov" }), vc = c.result.media.videos[0];
  assert.equal(vc.probe.audio, null); assert.match(vc.transcript.skipped, /no sound track/); assert.ok(!vc.matches.some(m => m.verification === "verified" && m.source === "earlier_video"));
});

test("public video URL: the video file is downloaded, kept and verified; a video with no speech or text is still checked as footage", async () => {
  const inv = await investigate(ana, { url: `${F}/media/clip.mov` }), r = inv.result;
  assert.equal(inv.status, "done", inv.error); assert.match(r.source.method, /video file downloaded from the link/);
  if (process.env.DUMP) console.log(JSON.stringify({ media: r.media, case: r.case_id, claims: r.claims, ov: r.overall, preview: inv.preview?.images }, null, 1));
  const v = r.media.videos[0]; assert.equal(v.video.sha256, sha("fresh-lamu.mov")); assert.ok(v.keyframes.length >= 2);
  assert.ok(r.claims.length === 0 || !r.claims.some(c => /Video submitted for verification/.test(c.text)), "the description of the submission is not a claim");
  assert.ok(["not_verifiable", "insufficient"].includes(r.overall.verdict));
});

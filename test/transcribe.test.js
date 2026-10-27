// Speech-to-text in AIVS (1.13): audio and video uploads, background transcription through the private service
// (a stand-in here that follows the real service's API), timestamps, unclear speech, silence, invalid files,
// limits, editing with history, search, downloads, evidence, the research assistant, restarts and failures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startServer, login, T } from "./helpers.js";
import { createApp } from "../server/app.js";
import { sniff } from "../server/lib/sniff.js";

// a real 16 kHz mono WAV file; a marker in a LIST chunk tells the stand-in service what the recording "contains"
function wav(marker, seconds = 3) {
  const n = 16000 * seconds, data = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * (marker === "SILENCE" ? 0 : 6000)), i * 2);
  const info = Buffer.from(`INFOICMT${String.fromCharCode(marker.length + 1, 0, 0, 0)}${marker}\0`, "latin1"), list = Buffer.concat([Buffer.from("LIST"), Buffer.alloc(4), info]); list.writeUInt32LE(info.length, 4);
  const fmt = Buffer.alloc(24); fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const dh = Buffer.alloc(8); dh.write("data", 0); dh.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, list, dh, data]), head = Buffer.alloc(8); head.write("RIFF", 0); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
const SEGS = {
  EN: { language: "en", basis: "detected automatically (94% likely)", segments: [{ start: 0.4, end: 3.2, text: "The county road will close on Monday.", confidence: 0.82, no_speech_prob: 0.02, unclear: false, reasons: [] },
    { start: 3.6, end: 6.1, text: "Motorists should use the bypass.", confidence: 0.79, no_speech_prob: 0.03, unclear: false, reasons: [] }, { start: 6.5, end: 7.4, text: "Thank you for watching.", confidence: 0.31, no_speech_prob: 0.4, unclear: true, reasons: ["low confidence", "typical text produced from noise"] }] },
  SW: { language: "sw", basis: "chosen by the analyst", segments: [{ start: 0.3, end: 4.0, text: "Barabara ya kaunti itafungwa Jumatatu.", confidence: 0.7, no_speech_prob: 0.05, unclear: false, reasons: [] }] },
  SILENCE: { language: "en", basis: "detected automatically (51% likely)", segments: [] }
};
let S, ana, view, fake, F, calls = [], up = true;
const jobs = new Map();
before(async () => {
  fake = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString("latin1");
    const js = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    calls.push(`${req.method} ${req.url}`);
    if (!up) return req.socket.destroy();
    if (req.url === "/health") return js(200, { ok: true, engine: "faster-whisper", model: "small", compute_type: "int8", device: "cpu", cpu_threads: 7, ram_total_gb: 16, max_minutes: 120, max_mb: 500 });
    if (req.headers.authorization !== "Bearer secret-token") return js(401, { detail: "Missing or wrong token." });
    if (req.method === "POST" && req.url === "/v1/jobs") {
      const lang = (/name="language"\r\n\r\n(\w+)/.exec(body) || [])[1];
      if (body.includes("LONGREC")) return js(413, { detail: "The recording lasts 150 minutes; the limit is 120 minutes. Cut it into parts." });
      if (!/RIFF|\x1aE\xdf\xa3|OggS/.test(body)) return js(415, { detail: "This file is not an audio or video recording that can be read (InvalidDataError)." });
      const kind = body.includes("SILENCE") ? "SILENCE" : body.includes("KISWAHILI") || lang === "sw" ? "SW" : "EN", id = `job${jobs.size + 1}`;
      jobs.set(id, { polls: 0, kind, lang, fail: body.includes("FAILME") }); return js(202, { id, status: "queued", duration_s: 7.5 });
    }
    const m = /^\/v1\/jobs\/([\w-]+)$/.exec(req.url);
    if (m && req.method === "DELETE") { jobs.delete(m[1]); return js(200, { ok: true }); }
    if (m) {
      const j = jobs.get(m[1]); if (!j) return js(404, { detail: "No such job. The transcription service may have restarted; start the transcription again." });
      j.polls++; if (j.fail) return js(200, { status: "failed", error: "RuntimeError: out of memory" });
      if (j.polls < 2) return js(200, { status: "running", progress: 0.5 });
      const R = SEGS[j.kind]; return js(200, { status: "done", progress: 1, result: { language: R.language, language_probability: 0.94, language_basis: j.lang === "sw" ? "chosen by the analyst" : R.basis, engine: "faster-whisper", model: "small", segments: R.segments, speech_found: R.segments.length > 0, dropped_non_speech: 0, processing_s: 2.1 } });
    }
    js(404, { detail: "not found" });
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ transcribe: { url: F, token: "secret-token", maxMb: 50, pollMs: 30, timeoutMs: 20000 } });
  [ana, view] = await Promise.all([login(S.base, "ana"), login(S.base, "view")]);
});
after(async () => { await S.close(); fake.close(); });

const caseWith = async () => (await ana.post("/api/cases", { claim_text: "Voice note shared on WhatsApp: the county road will close on Monday for repairs.", source_platform: "WhatsApp" })).body.id;
const upload = async (cid, buf, name, transcribe = "auto", u = ana) => { const fd = new FormData(); fd.append("files", new Blob([buf]), name); if (transcribe) fd.append("transcribe", transcribe); return u.post(`/api/cases/${cid}/media`, undefined, { form: fd }); };
const done = async tid => { for (let i = 0; i < 200; i++) { const t = (await ana.get(`/api/transcripts/${tid}`)).body; if (["done", "failed"].includes(t.status)) return t; await new Promise(r => setTimeout(r, 25)); } throw new Error("transcript did not finish"); };

test("file types: audio recognised from its bytes (WAV, MP3, Ogg Opus voice notes, M4A, AMR); text renamed .mp3 is not", () => {
  assert.equal(sniff(wav("EN")).kind, "audio");
  assert.deepEqual(sniff(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1")), { mime: "audio/mpeg", kind: "audio", ext: "mp3" });
  assert.equal(sniff(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])).ext, "mp3");
  assert.equal(sniff(Buffer.concat([Buffer.from("OggS\0\x02"), Buffer.alloc(22), Buffer.from("OpusHead")])).ext, "opus");
  assert.equal(sniff(Buffer.from("\0\0\0\x20ftypM4A \0\0\0\0", "latin1")).kind, "audio");
  assert.equal(sniff(Buffer.from("#!AMR\n")).kind, "audio");
  assert.equal(sniff(Buffer.from("\0\0\0\x18ftypisom", "latin1")).kind, "video");
  assert.equal(sniff(Buffer.from("This is text renamed to .mp3")), null);
});

test("health: really contacts the service and checks AIVS's token; not configured, wrong token and public address are explained", async () => {
  const h = (await ana.get("/api/transcribe/health?force=1")).body; assert.equal(h.ok, true); assert.equal(h.health.state, "ok", JSON.stringify(h)); assert.equal(h.health.model, "small"); assert.equal(h.health.device, "cpu");
  const S2 = await startServer({ transcribe: { url: F, token: "wrong" } }), a2 = await login(S2.base, "ana");
  const w = (await a2.get("/api/transcribe/health?force=1")).body.health; assert.equal(w.state, "failed"); assert.match(w.error, /rejected AIVS's token/); await S2.close();
  const S3 = await startServer(), a3 = await login(S3.base, "ana"); assert.equal((await a3.get("/api/transcribe/health")).body.health.state, "not_configured"); await S3.close();
  const S4 = await startServer({ transcribe: { url: "http://stt.example.com:9000", token: "x" } }), a4 = await login(S4.base, "ana"); assert.match((await a4.get("/api/transcribe/health?force=1")).body.health.error, /public address/); await S4.close();
});

test("English voice note: uploaded, transcribed in the background with timestamps, unclear speech marked, labelled machine-generated", async () => {
  const cid = await caseWith(), r = await upload(cid, wav("EN"), "voice-note.wav");
  assert.equal(r.status, 201, JSON.stringify(r.body)); const m = r.body.media[0]; assert.equal(m.kind, "audio"); assert.match(m.transcript, /^T-\d{6}$/);
  const t0 = (await ana.get(`/api/transcripts/${m.transcript}`)).body; assert.ok(["queued", "running"].includes(t0.status), "transcription runs in the background");
  const t = await done(m.transcript);
  assert.equal(t.status, "done"); assert.equal(t.language, "en"); assert.match(t.language_basis, /detected automatically/); assert.equal(t.model, "small");
  assert.equal(t.segments.length, 3); assert.equal(t.segments[0].start_s, 0.4); assert.equal(t.segments[0].end_s, 3.2);
  assert.equal(t.segments[2].unclear, 1); assert.deepEqual(t.segments[2].reasons, ["low confidence", "typical text produced from noise"]);
  assert.match(t.label, /^MACHINE-GENERATED TRANSCRIPT/); assert.match(t.label, new RegExp(m.id));
  const media = S.ctx.db.prepare("SELECT sha256 FROM media WHERE id = ?").get(m.id); assert.ok(fs.existsSync(S.ctx.storage.pathOf(media.sha256)), "the original recording is kept unchanged");
  assert.equal(t.media_sha256, media.sha256);
  assert.ok(calls.some(c => c.startsWith("DELETE /v1/jobs/")), "AIVS tells the service to forget the job once it has the transcript");
});

test("Kiswahili chosen manually, a video's soundtrack, and silence (no text is invented)", async () => {
  const cid = await caseWith();
  const sw = await upload(cid, wav("KISWAHILI"), "ujumbe.wav", "sw"), tsw = await done(sw.body.media[0].transcript);
  assert.equal(tsw.language, "sw"); assert.equal(tsw.language_basis, "chosen by the analyst"); assert.match(tsw.segments[0].text_current, /Barabara/);
  const v = await upload(cid, fs.readFileSync(T("images/sample_clip.webm")), "clip.webm", "auto"); assert.equal(v.body.media[0].kind, "video");
  assert.equal((await done(v.body.media[0].transcript)).status, "done");
  const si = await upload(cid, wav("SILENCE"), "silence.wav"), tsi = await done(si.body.media[0].transcript);
  assert.equal(tsi.status, "done"); assert.equal(tsi.speech_found, 0); assert.equal(tsi.segments.length, 0);
  assert.match((await ana.get(`/api/transcripts/${tsi.id}.txt`)).body, /No speech was detected in this recording/);
});

test("invalid files and limits: clear refusals, nothing sent that should not be", async () => {
  const cid = await caseWith();
  const bad = await upload(cid, Buffer.from("This is a text file renamed to .mp3\n".repeat(20)), "fake.mp3"); assert.equal(bad.status, 422); assert.match(bad.body.errors[0], /unsupported file type[\s\S]*audio \(MP3/);
  const img = (await upload(cid, fs.readFileSync(T("images/case_convoy.jpg")), "photo.jpg", null)).body.media[0];
  const ri = await ana.post(`/api/media/${img.id}/transcripts`, { language: "auto" }); assert.equal(ri.status, 415); assert.match(ri.body.error, /Only audio and video/);
  const long = await upload(cid, wav("LONGREC"), "meeting.wav"), tl = await done(long.body.media[0].transcript);
  assert.equal(tl.status, "failed"); assert.match(tl.error, /limit is 120 minutes/);
  const aud = (await upload(cid, wav("EN"), "x.wav", null)).body.media[0];
  assert.equal((await ana.post(`/api/media/${aud.id}/transcripts`, { language: "fr" })).status, 400);
  assert.equal((await view.post(`/api/media/${aud.id}/transcripts`, { language: "auto" })).status, 403);
  const S2 = await startServer({ transcribe: { url: F, token: "secret-token", maxMb: 0.01 } }), a2 = await login(S2.base, "ana"), c2 = (await a2.post("/api/cases", { claim_text: "A recording that is too large to transcribe here." })).body.id;
  const fd = new FormData(); fd.append("files", new Blob([wav("EN")]), "big.wav"); const big = (await a2.post(`/api/cases/${c2}/media`, undefined, { form: fd })).body.media[0];
  const n0 = calls.length, rb = await a2.post(`/api/media/${big.id}/transcripts`, { language: "auto" }); assert.equal(rb.status, 413); assert.match(rb.body.error, /transcription limit/); assert.equal(calls.length, n0, "nothing was sent"); await S2.close();
  const fm = await upload(cid, wav("FAILME"), "f.wav"), tf = await done(fm.body.media[0].transcript); assert.equal(tf.status, "failed"); assert.match(tf.error, /out of memory/);
});

test("review: edit with history, search, downloads (TXT, SRT, VTT, JSON) and attach segments to the case as evidence", async () => {
  const cid = await caseWith(), m = (await upload(cid, wav("EN"), "note.wav")).body.media[0], t = await done(m.transcript), s1 = t.segments[0];
  assert.equal((await view.patch(`/api/transcript-segments/${s1.id}`, { text: "x" })).status, 403);
  assert.equal((await ana.patch(`/api/transcript-segments/${s1.id}`, { text: "The county road will close on Monday 3 March." })).status, 200);
  const t2 = (await ana.get(`/api/transcripts/${t.id}`)).body; assert.equal(t2.segments[0].text_current, "The county road will close on Monday 3 March."); assert.equal(t2.segments[0].text_machine, "The county road will close on Monday."); assert.equal(t2.edited_segments, 1);
  const hist = (await ana.get(`/api/transcript-segments/${s1.id}/history`)).body.edits; assert.equal(hist.length, 1); assert.equal(hist[0].old_text, "The county road will close on Monday.");
  assert.equal((await ana.get(`/api/transcripts/${t.id}?q=bypass`)).body.segments.length, 1);
  const txt = (await ana.get(`/api/transcripts/${t.id}.txt`)).body; assert.match(txt, /^MACHINE-GENERATED TRANSCRIPT/); assert.match(txt, /\[0:00\.4 – 0:03\.2\] The county road will close on Monday 3 March\. \[corrected by analyst\]/); assert.match(txt, /\[unclear\]/);
  const srt = (await ana.get(`/api/transcripts/${t.id}.srt`)).body; assert.match(srt, /^1\n00:00:00,400 --> 00:00:03,200\n/);
  assert.match((await ana.get(`/api/transcripts/${t.id}.vtt`)).body, /^WEBVTT\n\nNOTE MACHINE-GENERATED/);
  const jr = (await ana.get(`/api/transcripts/${t.id}.json`)).body; const json = typeof jr === 'string' ? JSON.parse(jr) : jr; assert.equal(json.segments[0].machine_text, "The county road will close on Monday."); assert.equal(json.media_sha256, t.media_sha256);
  const claim = (await ana.post(`/api/cases/${cid}/claims`, { text: "The county road will close on Monday." })).body;
  const ev = await ana.post(`/api/transcripts/${t.id}/evidence`, { segment_ids: [t.segments[0].id, t.segments[1].id], claim_id: claim.id, stance: "supports" }); assert.equal(ev.status, 201, JSON.stringify(ev.body));
  const e = S.ctx.db.prepare("SELECT * FROM evidence WHERE id = ?").get(ev.body.id);
  assert.equal(e.kind, "observation"); assert.equal(e.media_id, m.id); assert.match(e.text, /at 0:00\.4–0:06\.1: “The county road will close on Monday 3 March\. Motorists should use the bypass\.”/);
  assert.match(e.reference, new RegExp(`Machine transcript ${t.id}, segments 1, 2`)); assert.match(e.uncertainty, /Machine-generated transcript: includes machine text not yet corrected/);
  assert.equal(S.ctx.db.prepare("SELECT stance FROM evidence_links WHERE evidence_id = ?").get(ev.body.id).stance, "supports");
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id = ? AND action LIKE 'Transcript % corrected'").get(cid).n === 1);
  // the research assistant can find and cite the transcript
  const r = await ana.post(`/api/cases/${cid}/assistant`, { question: "bypass motorists", mode: "rules" }); assert.equal(r.status, 201);
  const ans = (await ana.get(`/api/cases/${cid}/assistant`)).body.messages.at(-1); assert.match(ans.content, new RegExp(`\\[${t.id}#1\\]`)); assert.match(ans.content, /Machine transcript/);
});

test("a restart while transcribing: AIVS picks the job up again; a lost job is reported, not guessed", async () => {
  const cid = await caseWith(), m = (await upload(cid, wav("EN"), "r.wav", null)).body.media[0], sha = S.ctx.db.prepare("SELECT sha256 FROM media WHERE id = ?").get(m.id).sha256;
  jobs.set("jobR", { polls: 0, kind: "EN" });
  S.ctx.db.prepare("INSERT INTO transcripts(id,media_id,case_id,status,language_requested,media_sha256,remote_job_id,created_at) VALUES ('T-900001',?,?,'running','auto',?,'jobR',?)").run(m.id, cid, sha, new Date().toISOString());
  S.ctx.db.prepare("INSERT INTO transcripts(id,media_id,case_id,status,language_requested,media_sha256,remote_job_id,created_at) VALUES ('T-900002',?,?,'running','auto',?,'gone',?)").run(m.id, cid, sha, new Date().toISOString());
  const { ctx } = createApp(S.config); ctx.transcriber.resume();
  assert.equal((await done("T-900001")).status, "done"); const lost = await done("T-900002"); assert.equal(lost.status, "failed"); assert.match(lost.error, /restarted and lost this job/);
  up = false; const m2 = (await upload(cid, wav("EN"), "down.wav")).body.media[0], td = await done(m2.transcript); assert.equal(td.status, "failed"); assert.match(td.error, /transcription service/); up = true;
});

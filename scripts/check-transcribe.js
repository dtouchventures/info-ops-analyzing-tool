// End-to-end check of speech-to-text with the REAL transcription service named in .env (TRANSCRIBE_URL, TRANSCRIBE_TOKEN).
// It starts a temporary, separate copy of AIVS (empty database in a temporary folder: your cases are not touched),
// signs in as a temporary analyst and, through the normal AIVS upload and transcript endpoints:
//   uploads synthetic English (WAV), Kiswahili (MP3), a video with sound, silence, a video without sound and a fake MP3;
//   waits for the background transcription; checks language, word accuracy, timestamps and that silence gives no text;
//   corrects a segment (history kept), searches, downloads TXT/SRT/VTT/JSON, and adds segments to the case as evidence.
// The token is never printed. Results: on screen and in data/transcribe-check.txt.  Usage:  npm run check:transcribe
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT } from "../server/config.js";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/lib/auth.js";
import { nowISO } from "../server/lib/db.js";

const MEDIA = path.join(ROOT, "test", "media", "stt"), EXP = JSON.parse(fs.readFileSync(path.join(MEDIA, "expected.json"), "utf8"));
const lines = [], ok = [], log = s => { console.log(s); lines.push(s); };
const check = (name, pass, detail = "") => { ok.push(pass); log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
const words = t => String(t || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
function accuracy(ref, hyp) {
  const r = words(ref), h = words(hyp), d = Array.from({ length: r.length + 1 }, (_, i) => Array.from({ length: h.length + 1 }, (_, j) => (i * j === 0 ? i + j : 0)));
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] !== h[j - 1] ? 1 : 0));
  return Math.max(0, 1 - d[r.length][h.length] / Math.max(1, r.length));
}

log(`AIVS speech-to-text check ${nowISO()}`);
if (!config.transcribe?.url || !config.transcribe?.token) { log("NOT CONFIGURED: TRANSCRIBE_URL and TRANSCRIBE_TOKEN must be set in .env (run set-transcribe.bat)."); process.exit(2); }
log(`Service: ${config.transcribe.url}  (token set: yes, not shown)`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-stt-check-"));
const { app, ctx } = createApp({ ...config, dataDir: tmp, backupDisabled: true, port: 0, host: "127.0.0.1", ai: { ...config.ai, provider: "" } });
ctx.db.prepare("INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?)").run("stt-check", "Speech check", "analyst", hashPassword("stt-check-temporary-1"), nowISO());
const server = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";
const call = async (method, url, body, form) => {
  const o = { method, headers: { cookie, "x-aivs": "1" } };
  if (form) o.body = form; else if (body !== undefined) { o.body = JSON.stringify(body); o.headers["content-type"] = "application/json"; }
  const r = await fetch(base + url, o), ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
};
let code = 1;
try {
  const li = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-aivs": "1" }, body: JSON.stringify({ username: "stt-check", password: "stt-check-temporary-1" }) });
  cookie = (li.headers.get("set-cookie") || "").split(";")[0];
  // 1. the authenticated health check (the same one that decides "Available" on the Start page)
  const h = (await call("GET", "/api/transcribe/health?force=1")).body;
  check("authenticated health check (service reachable, token accepted)", h.health?.state === "ok", h.health?.state === "ok" ? `${h.health.engine} ${h.health.model} ${h.health.compute_type}, ${h.health.cpu_threads} threads, ${h.health.ram_available_gb}/${h.health.ram_total_gb} GB RAM free` : (h.health?.error || h.reason));
  if (h.health?.state !== "ok") throw new Error("stop: the service is not usable, so the upload tests were skipped");
  const cid = (await call("POST", "/api/cases", { title: "SYNTHETIC speech-to-text check", claim_text: "SYNTHETIC test content for the speech-to-text check.", source_platform: "test" })).body.id;
  const upload = async (name, lang = "auto") => { const fd = new FormData(); fd.append("files", new Blob([fs.readFileSync(path.join(MEDIA, name))]), name); fd.append("transcribe", lang); return call("POST", `/api/cases/${cid}/media`, null, fd); };
  const wait = async tid => { const t0 = Date.now(); for (;;) { const t = (await call("GET", `/api/transcripts/${tid}`)).body; if (["done", "failed"].includes(t.status)) return { t, s: Math.round((Date.now() - t0) / 100) / 10 }; if (Date.now() - t0 > 20 * 60e3) return { t, s: -1 }; await new Promise(r => setTimeout(r, 1500)); } };
  const results = {};
  for (const [name, lang] of [["english.wav", "auto"], ["kiswahili.mp3", "auto"], ["video.mp4", "auto"], ["silence.wav", "auto"], ["kiswahili.mp3", "sw"]]) {
    const up = await upload(name, lang), m = up.body.media?.[0];
    if (!m?.transcript) { check(`${name} (${lang}): upload starts a transcription`, false, up.body.media?.[0]?.transcribe_error || JSON.stringify(up.body).slice(0, 200)); continue; }
    const { t, s } = await wait(m.transcript), e = EXP[name], text = (t.segments || []).map(x => x.text_current).join(" ");
    if (e.silence) { check(`${name}: silence gives no text`, t.status === "done" && !t.segments.length, t.status === "done" ? `${t.segments.length} segment(s), ${s} s` : t.error); continue; }
    const acc = accuracy(e.text, text), langOk = t.language === e.lang, ts = t.segments.length > 0 && t.segments.every((x, i) => x.end_s > x.start_s && (i === 0 || x.start_s >= t.segments[i - 1].start_s));
    check(`${name} (${lang === "auto" ? "detected" : "chosen"} language): ${e.lang === "sw" ? "Kiswahili" : "English"}, word accuracy ≥ 60%, ordered timestamps`, t.status === "done" && langOk && acc >= 0.6 && ts,
      `${t.status}${t.error ? `: ${t.error}` : ""}; language ${t.language} (${t.language_basis}); accuracy ${Math.round(acc * 100)}%; ${t.segments?.length || 0} segment(s); ${s} s to transcribe; “${text.slice(0, 120)}”`);
    results[`${name}|${lang}`] = { t, m };
  }
  // invalid files: a fake MP3 is refused at upload; a video without sound is refused by the service with a clear reason
  const bad = await upload("not-audio.mp3");
  check("not-audio.mp3: refused at upload (file content is not audio)", !bad.body.media?.length && bad.status >= 400 || (bad.body.errors || []).length > 0, String(bad.body.error || (bad.body.errors || []).join(" ")).slice(0, 160));
  const ns = await upload("video-no-sound.mp4"), nsm = ns.body.media?.[0];
  if (nsm?.transcript) { const { t } = await wait(nsm.transcript); check("video-no-sound.mp4: transcription refused with a clear reason", t.status === "failed" && /no audio track/i.test(t.error || ""), t.error || t.status); }
  else check("video-no-sound.mp4: transcription refused with a clear reason", /audio/i.test(nsm?.transcribe_error || ""), nsm?.transcribe_error || JSON.stringify(ns.body).slice(0, 160));
  // review: correction with history, search, downloads, evidence
  const en = results["english.wav|auto"]?.t;
  if (en?.segments?.length) {
    const sg = en.segments[0], fixed = `${sg.text_current} [checked]`;
    const pa = await call("PATCH", `/api/transcript-segments/${sg.id}`, { text: fixed }), hist = (await call("GET", `/api/transcript-segments/${sg.id}/history`)).body.edits || [];
    const t2 = (await call("GET", `/api/transcripts/${en.id}`)).body, s2 = t2.segments.find(x => x.id === sg.id);
    check("a correction is saved and the machine text kept in the history", pa.status === 200 && s2.text_current === fixed && s2.text_machine === sg.text_machine && hist.length === 1);
    const word = words(sg.text_machine).find(w => w.length > 4) || "road", q = (await call("GET", `/api/transcripts/${en.id}?q=${encodeURIComponent(word)}`)).body;
    check(`search finds “${word}”`, (q.segments || []).length >= 1);
    const txt = (await call("GET", `/api/transcripts/${en.id}.txt`)).body, srt = (await call("GET", `/api/transcripts/${en.id}.srt`)).body, vtt = (await call("GET", `/api/transcripts/${en.id}.vtt`)).body, js = (await call("GET", `/api/transcripts/${en.id}.json`)).body;
    const jo = typeof js === "string" ? JSON.parse(js) : js;
    check("downloads: TXT, SRT, VTT and JSON, labelled machine-generated, with the correction", /^MACHINE-GENERATED TRANSCRIPT/.test(txt) && txt.includes("[corrected by analyst]") && /^1\n\d\d:\d\d:\d\d,\d{3} --> /.test(srt) && /^WEBVTT/.test(vtt) && jo.segments?.length === t2.total_segments);
    const claim = (await call("POST", `/api/cases/${cid}/claims`, { text: "SYNTHETIC: the road to Garissa will close on Monday." })).body.id;
    const ev = await call("POST", `/api/transcripts/${en.id}/evidence`, { segment_ids: t2.segments.slice(0, 2).map(x => x.id), claim_id: claim, stance: "supports" });
    const e = ctx.db.prepare("SELECT * FROM evidence WHERE id = ?").get(ev.body?.id);
    check("segments added to the case as evidence, linked to their recording times", ev.status === 201 && e?.transcript_id === en.id && e.loc_start_s === t2.segments[0].start_s && /Machine-generated transcript/.test(e.uncertainty || ""), ev.body?.id || JSON.stringify(ev.body));
    const cov = (await call("GET", `/api/cases/${cid}/coverage`)).body, loc = cov.claims?.[0]?.supports?.[0]?.locations?.[0];
    check("evidence coverage opens that evidence at its time in the recording", loc?.type === "timestamp" && loc.start === t2.segments[0].start_s);
  } else check("review checks (correction, search, downloads, evidence)", false, "skipped: the English transcription did not produce segments");
  code = ok.every(Boolean) ? 0 : 1;
} catch (e) { log(`STOPPED: ${e.message}`); code = 1; }
finally {
  log(code === 0 ? "\nALL SPEECH-TO-TEXT CHECKS PASSED" : `\n${ok.filter(x => !x).length || "Some"} check(s) failed or the check stopped (see above).`);
  try { fs.writeFileSync(path.join(config.dataDir, "transcribe-check.txt"), lines.join("\n") + "\n"); } catch {}
  server.close(); try { ctx.db.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(code), 200);
}

// AIVS 1.35: automatic video verification ("Reverse video search").
//
//   video (upload, public video-file link, or a video kept with a case)
//     -> container metadata (FFprobe) -> representative keyframes (FFmpeg scene detection + even sampling, near-duplicates dropped)
//     -> perceptual hashes (dHash + pHash) and a colour-layout embedding per keyframe
//     -> OCR of each keyframe (captions, on-screen text, text in logos) -> speech transcript (the AIVS transcription service)
//     -> local similarity: reference archive, earlier cases, keyframes of earlier analysed videos
//     -> reverse image search of selected keyframes through authorised providers (Google Cloud Vision web detection, when a key is
//        configured), each reported page retrieved and its image compared locally; earlier uploads on YouTube (Data API, when a key
//        is configured) compared by thumbnail
//     -> ranked matches, findings (possible recycled footage, misleading context, date/location inconsistencies), coverage statement
//
// Rules kept here:
//   * VERIFIED match = AIVS itself compared the two pictures (identical file, or perceptual distance <= 24 of 128 AND embedding
//     similarity >= 0.90). Everything else is a POSSIBLE similarity, including a provider's "match" AIVS could not confirm.
//   * AIVS never says it searched the whole internet, never names the original uploader, and makes no finding about AI generation
//     or manipulation (it does not test for them).
//   * Original files are never changed. Keyframes are stored as images of the case with their timestamps; retrieved pages are archived.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import sharp from "sharp";
import { nowISO, nextId } from "./db.js";
import { HttpError } from "./auth.js";
import { safeRm } from "./storage.js";
import { submissionHashes, ham } from "./hashing.js";
import { runMatching } from "./matching.js";
import { extractEntities } from "../../shared/text.js";
import { similarities, classify, TIERS, hostOf } from "./autoeval.js";

const require = createRequire(import.meta.url);
export const VERIFIED = { score: 24, cosine: 0.9 }, POSSIBLE = { score: 34, cosine: 0.8 };
const DAY = 864e5;
export const VIDEO_STAGES = [["probe", "Video read (container metadata)"], ["keyframes", "Keyframes extracted"], ["ocr", "On-screen text read (OCR)"], ["speech", "Speech transcribed"],
  ["local", "Compared with the archive, earlier cases and earlier videos"], ["reverse", "Reverse search of keyframes"], ["findings", "Findings and ranking"]];

// ---------------------------------------------------------------- FFmpeg / FFprobe (checked, never assumed)
let toolCache = null;
export function videoTools(config = {}, { fresh = false } = {}) {
  if (toolCache && !fresh) return toolCache;
  const V = config.video || {};
  const pick = (explicit, pkg, sys) => {
    const cands = [];
    if (explicit) cands.push([explicit, "configured path"]);
    try { cands.push([require(pkg).path, `bundled package ${pkg}`]); } catch {}
    cands.push([sys, "system PATH"]);
    for (const [p, source] of cands) {
      try { const r = spawnSync(p, ["-version"], { timeout: 10000, encoding: "utf8", windowsHide: true }); if (r.status === 0) return { path: p, source, version: String(r.stdout).split("\n")[0].replace(/ Copyright.*$/, "").trim() }; } catch {}
    }
    return null;
  };
  toolCache = { ffmpeg: pick(V.ffmpegPath, "@ffmpeg-installer/ffmpeg", "ffmpeg"), ffprobe: pick(V.ffprobePath, "@ffprobe-installer/ffprobe", "ffprobe") };
  return toolCache;
}
function runTool(bin, args, { timeoutMs = 120000, maxOut = 8 << 20 } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(bin, args, { windowsHide: true }); let out = "", err = "", killed = false;
    const t = setTimeout(() => { killed = true; p.kill("SIGKILL"); }, timeoutMs);
    p.stdout.on("data", d => { if (out.length < maxOut) out += d; }); p.stderr.on("data", d => { if (err.length < maxOut) err += d; });
    p.on("error", e => { clearTimeout(t); no(e); });
    p.on("close", code => { clearTimeout(t); if (killed) return no(new Error(`${path.basename(bin)} took longer than ${Math.round(timeoutMs / 1000)} s`)); ok({ code, out, err }); });
  });
}

// ---------------------------------------------------------------- container metadata
export async function probe(tools, file) {
  if (!tools.ffprobe) throw new Error("FFprobe is not available on this computer.");
  const r = await runTool(tools.ffprobe.path, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`The video could not be read (${String(r.err).trim().split("\n").pop()?.slice(0, 200) || "FFprobe failed"}). The file may be damaged or not a video.`);
  const j = JSON.parse(r.out || "{}"), streams = j.streams || [], v = streams.find(s => s.codec_type === "video"), a = streams.find(s => s.codec_type === "audio");
  if (!v) throw new Error("The file contains no video stream.");
  const tags = {}; for (const src of [j.format?.tags, v.tags, a?.tags]) for (const [k, val] of Object.entries(src || {})) tags[k.toLowerCase()] = String(val).slice(0, 200);
  const fr = String(v.avg_frame_rate || v.r_frame_rate || "0/1").split("/").map(Number), fps = fr[1] ? Math.round((fr[0] / fr[1]) * 100) / 100 : null;
  const rot = Number(tags.rotate || (v.side_data_list || []).find(x => x.rotation != null)?.rotation || 0);
  return {
    duration_s: Number(j.format?.duration || v.duration || 0) || null, container: j.format?.format_long_name || j.format?.format_name || null, size: Number(j.format?.size || 0) || null,
    video: { codec: v.codec_name, width: v.width, height: v.height, fps, rotation: rot || 0 }, audio: a ? { codec: a.codec_name, channels: a.channels, sample_rate: Number(a.sample_rate) || null } : null,
    metadata: { creation_time: tags.creation_time || tags.date || null, location: tags["com.apple.quicktime.location.iso6709"] || tags.location || tags["location-eng"] || null,
      make: tags["com.apple.quicktime.make"] || tags.make || null, model: tags["com.apple.quicktime.model"] || tags.model || null, software: tags["com.apple.quicktime.software"] || tags.software || null,
      encoder: tags.encoder || null, title: tags.title || null, comment: tags.comment || tags.description || null }
  };
}

// ---------------------------------------------------------------- picture fingerprints
// a colour-layout embedding: an 8x8 colour grid (layout) and a 4x4x4 colour histogram, normalised. It is a fixed, hand-built
// descriptor (not a neural network); it complements the perceptual hashes when footage is recoloured, cropped slightly or re-encoded.
export async function embedding(input) {
  const g = await sharp(input, { failOn: "none" }).rotate().resize(8, 8, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const h = await sharp(input, { failOn: "none" }).rotate().resize(64, 64, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const grid = Array.from(g, x => x / 255), mean = grid.reduce((a, x) => a + x, 0) / grid.length, gv = grid.map(x => x - mean);
  const hist = new Array(64).fill(0); for (let i = 0; i < h.length; i += 3) hist[(h[i] >> 6) * 16 + (h[i + 1] >> 6) * 4 + (h[i + 2] >> 6)]++;
  const norm = a => { const n = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1; return a.map(x => x / n); };
  return [...norm(gv).map(x => x * 0.8), ...norm(hist).map(x => x * 0.6)].map(x => Math.round(x * 10000) / 10000);
}
export const cosine = (a, b) => { if (!a?.length || a.length !== b?.length) return 0; let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? s / Math.sqrt(na * nb) : 0; };
export async function fingerprint(input) { const [h, e] = await Promise.all([submissionHashes(input), embedding(input)]); return { dhash: h.dhash, phash: h.phash, dhash_m: h.dhash_m, phash_m: h.phash_m, emb: e }; }
// distance between two fingerprints (best of normal and mirrored), with the embedding similarity
export function compareFp(a, b) {
  const n = ham(a.dhash, b.dhash) + ham(a.phash, b.phash), m = a.dhash_m ? ham(a.dhash_m, b.dhash) + ham(a.phash_m, b.phash) : 999, score = Math.min(n, m);
  const cos = Math.round(cosine(a.emb, b.emb) * 1000) / 1000;
  const verification = score <= VERIFIED.score && cos >= VERIFIED.cosine ? "verified" : score <= POSSIBLE.score && cos >= POSSIBLE.cosine ? "possible" : null;
  return { score, mirrored: m < n, cosine: cos, verification };
}

// ---------------------------------------------------------------- keyframes
export async function keyframes(tools, file, dir, { duration, maxS = 900, max = 10, timeoutMs = 240000 } = {}) {
  if (!tools.ffmpeg) throw new Error("FFmpeg is not available on this computer.");
  fs.mkdirSync(dir, { recursive: true });
  const cap = Math.max(1, Math.min(maxS, duration || maxS)), scale = "scale='min(960,iw)':-2";
  // 1. scene changes (the first frame, then each frame that differs strongly from the one before)
  const r = await runTool(tools.ffmpeg.path, ["-hide_banner", "-nostdin", "-nostats", "-t", String(cap), "-i", file, "-vf", `select='eq(n,0)+gt(scene,0.3)',showinfo,${scale}`, "-vsync", "vfr", "-frames:v", "40", "-q:v", "3", path.join(dir, "s%03d.jpg")], { timeoutMs });
  const times = [...String(r.err).matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*([\d.]+)/g)].map(m => Number(m[1]));
  const cand = fs.readdirSync(dir).filter(f => /^s\d+\.jpg$/.test(f)).sort().map((f, i) => ({ t: times[i] ?? 0, file: path.join(dir, f), origin: "scene change" }));
  // 2. even sampling, so that a video without cuts is still represented across its length
  const want = Math.max(3, Math.min(max, Math.ceil(cap / 6)));
  if (cand.length < want && duration) {
    for (let i = 0; i < want; i++) {
      const t = Math.min(cap - 0.05, (cap * (i + 0.5)) / want), out = path.join(dir, `u${String(i).padStart(3, "0")}.jpg`);
      const u = await runTool(tools.ffmpeg.path, ["-hide_banner", "-nostdin", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", scale, "-q:v", "3", "-y", out], { timeoutMs: 30000 }).catch(() => null);
      if (u?.code === 0 && fs.existsSync(out)) cand.push({ t: Math.round(t * 100) / 100, file: out, origin: "even sampling" });
    }
  }
  if (!cand.length) throw new Error(`No frame could be extracted (${String(r.err).trim().split("\n").pop()?.slice(0, 160) || "FFmpeg failed"}).`);
  // 3. fingerprints; near-identical frames are dropped; at most `max`, spread over the video
  for (const c of cand) Object.assign(c, await fingerprint(c.file));
  cand.sort((a, b) => a.t - b.t);
  const kept = [];
  for (const c of cand) { const near = kept.find(k => { const d = compareFp(c, k); return d.score <= 12 && d.cosine >= 0.97; }); if (!near) kept.push(c); }
  let pick = kept;
  if (kept.length > max) { pick = []; for (let i = 0; i < max; i++) pick.push(kept[Math.round((i * (kept.length - 1)) / (max - 1))]); pick = [...new Set(pick)]; }
  for (const c of cand) if (!pick.includes(c)) safeRm(c.file, "unused frame");
  return { frames: pick.map(c => ({ ...c, t: Math.round(c.t * 100) / 100 })), candidates: cand.length, analysed_s: cap, truncated: !!duration && duration > cap };
}

const wordy = s => { const t = s.split(/\s+/).filter(Boolean); return t.length ? t.filter(x => /^(https?:|www\.|[#@])/i.test(x) || /^[\d.,:%/-]+$/.test(x) || ((x.match(/\p{L}/gu) || []).length >= 2 && /[aeiouy]/i.test(x))).length / t.length : 0; };
export const cleanOcr = text => String(text || "").split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(l => l.length >= 3 && /\p{L}{2}/u.test(l) && wordy(l) >= 0.6);

// ---------------------------------------------------------------- the service
export function makeVideoCheck(db, { config, storage, audit, media, cases, transcriber = null, ocr = null, fetchPage, fetchImage }) {
  const V = { maxAnalyseS: 900, maxKeyframes: 10, reverseFrames: 4, maxDownloadMb: 200, youtubeBase: "https://www.googleapis.com/youtube/v3", ...(config.video || {}) };
  const MC = { visionKey: "", visionBase: "https://vision.googleapis.com", timeoutMs: 15000, ...(config.mediaCheck || {}) };
  const ytKey = config.collect?.youtubeKey || "";
  const tools = () => videoTools(config);
  const jobs = new Map();
  const status = () => {
    const t = tools(), tr = transcriber?.configured?.() || { ok: false, reason: "Speech-to-text is not set up." };
    return {
      ffmpeg: t.ffmpeg ? { available: true, version: t.ffmpeg.version, source: t.ffmpeg.source } : { available: false, needs: "FFmpeg: run npm install (installs the bundled @ffmpeg-installer package) or set FFMPEG_PATH to ffmpeg.exe" },
      ffprobe: t.ffprobe ? { available: true, version: t.ffprobe.version, source: t.ffprobe.source } : { available: false, needs: "FFprobe: run npm install (installs @ffprobe-installer) or set FFPROBE_PATH to ffprobe.exe" },
      ocr: { available: !!ocr }, speech: tr.ok ? { available: true } : { available: false, needs: tr.reason },
      reverse_providers: [
        MC.visionKey ? { name: "Google Cloud Vision web detection", configured: true, note: "keyframes are sent to Google; each send is audited" } : { name: "Google Cloud Vision web detection", configured: false, needs: "GOOGLE_VISION_API_KEY" },
        ytKey ? { name: "YouTube Data API (earlier uploads, compared by thumbnail)", configured: true } : { name: "YouTube Data API (earlier uploads, compared by thumbnail)", configured: false, needs: "YOUTUBE_API_KEY" }],
      local: { available: true, note: "reference archive, earlier cases and keyframes of earlier analysed videos (perceptual hashes and colour-layout embedding)" }
    };
  };
  const available = () => { const t = tools(); return !!(t.ffmpeg && t.ffprobe); };
  const row = id => db.prepare("SELECT * FROM video_analyses WHERE id = ?").get(id);
  const setStage = (id, key, st, detail = null) => { const r = row(id); if (!r) return; const s = JSON.parse(r.stages_json).map(x => x.key === key ? { ...x, status: st, detail: detail ? String(detail).slice(0, 400) : null, at: nowISO() } : x);
    db.prepare("UPDATE video_analyses SET stages_json = ?, stage = ? WHERE id = ?").run(JSON.stringify(s), key, id); };
  const newStages = () => JSON.stringify(VIDEO_STAGES.map(([key, label]) => ({ key, label, status: "pending", detail: null })));

  // ---- 1. reading the file: metadata, keyframes, OCR, speech (works on a file; nothing is stored yet)
  async function extract(file, name, { budgetMs = 300000, transcribe = true, language = "auto", onStage = () => {} } = {}) {
    const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0), T = tools(), out = { tools: { ffmpeg: T.ffmpeg?.version || null, ffprobe: T.ffprobe?.version || null }, notes: [], errors: [], frames: [], ocr: [], transcript: null, stageState: {} };
    const report = onStage; onStage = (k, st, d = null) => { out.stageState[k] = { status: st, detail: d }; report(k, st, d); };
    if (!T.ffmpeg || !T.ffprobe) { out.errors.push(`Video analysis needs FFmpeg and FFprobe, which are not available on this computer (${[!T.ffmpeg && "FFmpeg", !T.ffprobe && "FFprobe"].filter(Boolean).join(" and ")} missing). Run npm install, or set FFMPEG_PATH and FFPROBE_PATH.`); onStage("probe", "failed", out.errors[0]); return out; }
    onStage("probe", "running");
    try { out.probe = await probe(T, file); onStage("probe", "done", `${out.probe.video.codec} ${out.probe.video.width}×${out.probe.video.height}, ${out.probe.duration_s ? `${out.probe.duration_s.toFixed(1)} s` : "duration unknown"}, ${out.probe.audio ? "with sound" : "no sound track"}${out.probe.metadata.creation_time ? `, container creation time ${out.probe.metadata.creation_time}` : ""}`); }
    catch (e) { out.errors.push(e.message); onStage("probe", "failed", e.message); return out; }
    onStage("keyframes", "running");
    out.dir = fs.mkdtempSync(path.join(storage.tmpDir, "vid-"));
    try {
      const k = await keyframes(T, file, out.dir, { duration: out.probe.duration_s, maxS: V.maxAnalyseS, max: V.maxKeyframes, timeoutMs: Math.max(30000, Math.min(240000, left() - 60000)) });
      out.frames = k.frames; out.keyframe_stats = { candidates: k.candidates, kept: k.frames.length, analysed_s: k.analysed_s, truncated: k.truncated };
      if (k.truncated) out.notes.push(`Only the first ${Math.round(k.analysed_s)} s of the ${Math.round(out.probe.duration_s)} s video were analysed for keyframes (VIDEO_MAX_ANALYSE_S).`);
      onStage("keyframes", "done", `${k.frames.length} keyframes kept from ${k.candidates} candidates (scene changes and even sampling), at ${k.frames.map(f => `${f.t.toFixed(1)} s`).join(", ")}`);
    } catch (e) { out.errors.push(`Keyframes: ${e.message}`); onStage("keyframes", "failed", e.message); }
    // OCR: captions, on-screen text, text in logos (logos without text are not recognised)
    onStage("ocr", "running");
    if (ocr && out.frames.length) {
      const seen = new Set(); let n = 0;
      for (const f of out.frames) {
        if (left() < 60000) { out.notes.push("Some keyframes were not read by OCR because the time limit was reached."); break; }
        try { const o = await ocr(f.file, 60000); f.ocr = { text: String(o.text || "").trim(), confidence: o.confidence ?? null }; n++;
          for (const l of cleanOcr(f.ocr.text)) { const k = l.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.ocr.push({ t: f.t, text: l, confidence: o.confidence ?? null }); } } }
        catch (e) { out.notes.push(`OCR of the keyframe at ${f.t} s failed (${e.message}).`); }
      }
      onStage("ocr", out.ocr.length ? "done" : "warning", out.ocr.length ? `${out.ocr.length} distinct line(s) of on-screen text in ${n} keyframe(s)` : `no readable on-screen text in ${n} keyframe(s)`);
    } else onStage("ocr", "skipped", ocr ? "no keyframes" : "OCR is not available");
    // speech
    onStage("speech", "running");
    if (!transcribe) onStage("speech", "skipped", "not requested");
    else if (!out.probe.audio) { out.transcript = { skipped: "The video has no sound track." }; onStage("speech", "skipped", "the video has no sound track"); }
    else if (!transcriber?.configured?.().ok) { out.transcript = { skipped: transcriber?.configured?.().reason || "Speech-to-text is not set up." }; onStage("speech", "skipped", out.transcript.skipped); }
    else if (left() < 90000) { out.transcript = { skipped: "There was not enough time left to transcribe the speech." }; onStage("speech", "skipped", out.transcript.skipped); }
    else {
      try { const r = await transcriber.transcribeFile(file, name, { language, timeoutMs: Math.min(600000, left() - 60000) }); out.transcript = { result: r, text: (r.segments || []).map(s => String(s.text).trim()).join(" ").trim() };
        onStage("speech", "done", `${(r.segments || []).length} segment(s), language ${r.language || "not stated"} (${r.engine || "speech-to-text"} ${r.model || ""}); machine transcript, not checked`); }
      catch (e) { out.transcript = { error: e.message }; onStage("speech", "warning", `not transcribed: ${e.message}`); }
    }
    return out;
  }
  // text from the video for claim extraction (labelled where it is used)
  const videoText = x => ({ speech: x.transcript?.text || "", onscreen: x.ocr.map(o => /[.!?]$/.test(o.text) ? o.text : `${o.text}.`).join("\n") });

  // ---- 2. keeping it with the case: keyframes as images of the case (with their timestamps), OCR texts, transcript, the record
  async function persist(user, { caseId, mediaId, extracted, investigationId = null, analysisId = null, contextText = null }) {
    const c = cases.mustCase(caseId), v = db.prepare("SELECT * FROM media WHERE id = ?").get(mediaId);
    let id = analysisId;
    if (!id) {
      id = nextId(db, "video_analysis", n => `VC-${String(n).padStart(6, "0")}`);
      db.prepare("INSERT INTO video_analyses(id,media_id,case_id,investigation_id,status,stage,stages_json,is_training,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, mediaId, caseId, investigationId, "running", "local", newStages(), c.is_training ? 1 : 0, user?.id ?? null, nowISO());
      const st = JSON.parse(row(id).stages_json).map(s => ["probe", "keyframes", "ocr", "speech"].includes(s.key) ? { ...s, status: extracted.stageState?.[s.key]?.status || (extracted.errors.length ? "warning" : "done"), detail: extracted.stageState?.[s.key]?.detail || null } : s);
      db.prepare("UPDATE video_analyses SET stages_json = ? WHERE id = ?").run(JSON.stringify(st), id);
    }
    const kept = [];
    for (const f of extracted.frames) {
      try {
        // a keyframe already kept from an earlier run on the same video (same bytes, same time) is reused, not stored twice
        const fsha = crypto.createHash("sha256").update(fs.readFileSync(f.file)).digest("hex");
        const prev = db.prepare("SELECT * FROM media WHERE parent_media_id = ? AND sha256 = ? AND abs(frame_time - ?) < 0.05").get(mediaId, fsha, f.t);
        const m = prev || await media.ingest(f.file, { name: `${mediaId}-keyframe-${f.t.toFixed(2)}s.jpg`, caseId, isTraining: c.is_training, user, parent: mediaId, frameTime: f.t, frameOrigin: "auto" });
        if (prev) safeRm(f.file, "duplicate keyframe");
        const lines = cleanOcr(f.ocr?.text);
        if (lines.length && !(prev && db.prepare("SELECT 1 FROM ocr_texts WHERE media_id = ?").get(m.id))) try { cases.addOcr(user, m.id, { text: lines.join("\n"), lang: "eng+swa", confidence: f.ocr.confidence, engine: "tesseract.js (server, video keyframe)" }); } catch {}
        db.prepare("INSERT INTO video_keyframes(analysis_id,video_media_id,frame_media_id,t,origin,dhash,phash,dhash_m,phash_m,embedding,ocr_text,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, mediaId, m.id, f.t, f.origin, f.dhash, f.phash, f.dhash_m, f.phash_m, JSON.stringify(f.emb), lines.join("\n") || null, nowISO());
        kept.push(m.id);
      } catch (e) { extracted.notes.push(`The keyframe at ${f.t} s could not be kept (${e.message}).`); }
    }
    if (extracted.dir) { try { fs.rmSync(extracted.dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
    let transcriptId = null;
    if (extracted.transcript?.result) { try { transcriptId = transcriber.storeResult(user, mediaId, extracted.transcript.result); } catch (e) { extracted.notes.push(`The transcript could not be stored (${e.message}).`); } }
    db.prepare("UPDATE video_analyses SET probe_json = ?, extract_json = ?, transcript_id = ? WHERE id = ?").run(JSON.stringify(extracted.probe || null),
      JSON.stringify({ context_text: contextText ? String(contextText).slice(0, 4000) : null, tools: extracted.tools, keyframe_stats: extracted.keyframe_stats || null, ocr: extracted.ocr, transcript: extracted.transcript ? { text: extracted.transcript.text || null, skipped: extracted.transcript.skipped || null, error: extracted.transcript.error || null, language: extracted.transcript.result?.language || null, model: extracted.transcript.result ? `${extracted.transcript.result.engine || ""} ${extracted.transcript.result.model || ""}`.trim() : null } : null, notes: extracted.notes, errors: extracted.errors }), transcriptId, id);
    if (kept.length) cases.change(user, caseId, `Keyframes of ${mediaId} analysed: ${kept.length} (${kept.join(", ")})`, () => {}, { analysis: id, video: v?.sha256 });
    audit(user, "Video keyframes extracted and kept with the case", "case", caseId, { analysis: id, video: mediaId, keyframes: kept.length, sha256: v?.sha256 });
    return id;
  }

  // ---- 3. verification: local similarity, reverse search, findings, ranking
  async function vision(buf) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), Math.max(15000, MC.timeoutMs));
    try {
      const r = await fetch(`${MC.visionBase}/v1/images:annotate?key=${encodeURIComponent(MC.visionKey)}`, { method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal,
        body: JSON.stringify({ requests: [{ image: { content: buf.toString("base64") }, features: [{ type: "WEB_DETECTION", maxResults: 10 }] }] }) });
      const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      const w = j?.responses?.[0]?.webDetection || {}, http = u => /^https?:\/\//i.test(String(u || ""));
      return { pages: (w.pagesWithMatchingImages || []).filter(p => http(p.url)).slice(0, 10).map(p => ({ url: p.url, title: String(p.pageTitle || "").replace(/<[^>]+>/g, "").slice(0, 200),
          full: (p.fullMatchingImages || []).map(i => i.url).filter(http).slice(0, 3), partial: (p.partialMatchingImages || []).map(i => i.url).filter(http).slice(0, 3) })),
        full: (w.fullMatchingImages || []).map(i => i.url).filter(http).slice(0, 5), labels: (w.bestGuessLabels || []).map(l => l.label).filter(Boolean).slice(0, 3) };
    } catch (e) { throw new Error(e.name === "AbortError" ? "no answer in time" : e.message); } finally { clearTimeout(t); }
  }
  async function getJson(url, ms = 15000) { const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms); try { const r = await fetch(url, { signal: ac.signal }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`); return j; } catch (e) { throw new Error(e.name === "AbortError" ? "no answer in time" : e.message); } finally { clearTimeout(t); } }
  async function remoteFp(url) { const g = await fetchImage(url, { allowPrivate: !!config.allowPrivateFetch }); return { ...(await fingerprint(g.raw)), finalUrl: g.finalUrl }; }
  const storedFp = async mediaId => { const m = db.prepare("SELECT sha256 FROM media WHERE id = ?").get(mediaId); return fingerprint(storage.pathOf(m.sha256)); };

  // contextText: the words that came with the video (the post's caption or text); places and dates are compared with it
  async function verify(user, { analysisId, claims = null, claimDate = null, contextText = null, budgetMs = 180000, check = () => {} }) {
    const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
    const A = row(analysisId); if (!A) throw new HttpError(404, "Video analysis not found.");
    const c = cases.mustCase(A.case_id), scope = c.is_training ? 1 : 0, ex = JSON.parse(A.extract_json || "{}"), pr = JSON.parse(A.probe_json || "null");
    claims = claims || cases.aggregate(c.id).claims.filter(x => !x.removed).map(x => ({ id: x.id, seq: x.seq, text: x.text }));
    claimDate = claimDate || c.published_at || c.claimed_event_at || c.received_at || A.created_at;
    const cd = Date.parse(claimDate), kf = db.prepare("SELECT * FROM video_keyframes WHERE analysis_id = ? ORDER BY t").all(analysisId).map(k => ({ ...k, emb: JSON.parse(k.embedding || "[]") }));
    const video = db.prepare("SELECT * FROM media WHERE id = ?").get(A.media_id), matches = [], searched = [], unavailable = [], errors = [], notes = [];
    const daysBefore = d => { const x = Date.parse(d); return isNaN(x) || isNaN(cd) ? null : Math.round((cd - x) / DAY); };
    const add = m => matches.push({ ...m, days_before_claim: m.date ? daysBefore(m.date) : null });

    // a) reference archive and earlier cases (perceptual hashes of the stored keyframes, AIVS's matching), confirmed by embedding
    setStage(analysisId, "local", "running");
    try {
      runMatching(db, c);
      for (const k of kf) {
        for (const x of db.prepare("SELECT x.*, a.documented_date, a.title AS archive_title, a.description AS archive_description, a.record_type, a.source_ref, c2.title AS case_title, c2.received_at AS case_received FROM matches x LEFT JOIN archive_records a ON a.id = x.target_archive_id LEFT JOIN cases c2 ON c2.id = x.target_case_id WHERE x.case_id = ? AND x.media_id = ?").all(c.id, k.frame_media_id)) {
          if (x.target_media_id && db.prepare("SELECT parent_media_id FROM media WHERE id = ?").get(x.target_media_id)?.parent_media_id === A.media_id) continue;
          let cos = null; try { cos = Math.round(cosine(k.emb, (await storedFp(x.target_media_id)).emb) * 1000) / 1000; } catch {}
          const verified = x.kind === "exact" || (x.score <= VERIFIED.score && (cos ?? 0) >= VERIFIED.cosine);
          add({ source: x.target_archive_id ? "archive" : "case", verification: verified ? "verified" : "possible", keyframe_t: k.t, frame_media_id: k.frame_media_id, target_media_id: x.target_media_id,
            ref: x.target_archive_id || x.target_case_id, title: x.archive_title || x.case_title, description: x.archive_description || null, url: null, publisher: x.target_archive_id ? `AIVS reference archive${x.source_ref ? ` (source: ${x.source_ref})` : ""}` : "earlier AIVS case",
            date: x.target_archive_id ? x.documented_date : x.case_received, date_basis: x.target_archive_id ? "date documented in the reference archive" : "date the earlier case was received",
            score: x.score, cosine: cos, mirrored: !!x.mirrored, record_type: x.record_type || null, method: x.kind === "exact" ? "identical file (SHA-256)" : `perceptual hashes (${x.score}/128, ${x.window_label})${cos != null ? ` and embedding (${cos})` : ""}` });
        }
      }
      // keyframes of videos analysed before in other cases
      const others = db.prepare("SELECT k.*, va.case_id, va.created_at AS analysed_at, c2.title AS case_title, c2.received_at AS case_received, m.sha256 AS video_sha FROM video_keyframes k JOIN video_analyses va ON va.id = k.analysis_id JOIN cases c2 ON c2.id = va.case_id JOIN media m ON m.id = k.video_media_id WHERE va.case_id != ? AND va.is_training = ?").all(c.id, scope);
      const bestByVideo = new Map();
      for (const k of kf) for (const o of others) {
        const d = compareFp({ dhash: k.dhash, phash: k.phash, dhash_m: k.dhash_m, phash_m: k.phash_m, emb: k.emb }, { dhash: o.dhash, phash: o.phash, emb: JSON.parse(o.embedding || "[]") });
        if (!d.verification) continue;
        const key = o.video_media_id, cur = bestByVideo.get(key);
        if (!cur || d.score < cur.score) bestByVideo.set(key, { source: "earlier_video", verification: video.sha256 === o.video_sha ? "verified" : d.verification, keyframe_t: k.t, frame_media_id: k.frame_media_id, target_media_id: o.frame_media_id,
          ref: o.case_id, title: o.case_title, url: null, publisher: `earlier AIVS case ${o.case_id} (video ${o.video_media_id}, keyframe at ${o.t} s)`, date: o.case_received, date_basis: "date the earlier case was received",
          score: d.score, cosine: d.cosine, mirrored: d.mirrored, method: video.sha256 === o.video_sha ? "identical video file (SHA-256)" : `perceptual hashes (${d.score}/128) and embedding (${d.cosine})` });
      }
      for (const m of bestByVideo.values()) add(m);
      const nl = matches.length;
      setStage(analysisId, "local", "done", nl ? `${nl} local match(es): ${matches.filter(m => m.verification === "verified").length} verified, ${matches.filter(m => m.verification === "possible").length} possible` : "no earlier copy in the reference archive, earlier cases or earlier analysed videos");
    } catch (e) { errors.push(`Local comparison: ${e.message}`); setStage(analysisId, "local", "failed", e.message); }
    check();

    // b) reverse search through authorised providers
    setStage(analysisId, "reverse", "running");
    const pick = kf.length <= V.reverseFrames ? kf : Array.from({ length: V.reverseFrames }, (_, i) => kf[Math.round((i * (kf.length - 1)) / (V.reverseFrames - 1))]).filter((x, i, a) => a.indexOf(x) === i);
    if (!MC.visionKey) unavailable.push({ provider: "Google Cloud Vision web detection", reason: "not configured (GOOGLE_VISION_API_KEY)" });
    else {
      const pages = new Map(); let sent = 0;
      for (const k of pick) {
        check(); if (left() < 25000) { notes.push("Not every selected keyframe was sent to reverse search: the time limit was reached."); break; }
        const m = db.prepare("SELECT sha256 FROM media WHERE id = ?").get(k.frame_media_id);
        try {
          audit(user, "Video keyframe sent to reverse-image search", "case", c.id, { analysis: analysisId, keyframe: k.frame_media_id, t: k.t, service: "Google Cloud Vision", sha256: m.sha256 });
          const r = await vision(storage.read(m.sha256)); sent++;
          for (const p of r.pages) { const cur = pages.get(p.url), rank = p.full.length ? 2 : p.partial.length ? 1 : 0; if (!cur || rank > cur.rank) pages.set(p.url, { ...p, rank, k, labels: r.labels }); }
        } catch (e) { errors.push(`Google Cloud Vision (keyframe at ${k.t} s): ${e.message}`); }
      }
      searched.push({ provider: "Google Cloud Vision web detection", keyframes: sent, pages: pages.size });
      // each reported page: retrieved (archived), its date read, its matching image compared with the keyframe by AIVS
      for (const p of [...pages.values()].sort((a, b) => b.rank - a.rank).slice(0, 8)) {
        check(); if (left() < 20000) { notes.push("Some pages found by reverse search were not retrieved: the time limit was reached."); break; }
        const mm = { source: "web", provider: "Google Cloud Vision", provider_match: p.rank === 2 ? "full" : p.rank === 1 ? "partial" : "page", keyframe_t: p.k.t, frame_media_id: p.k.frame_media_id, url: p.url, title: p.title || null, publisher: hostOf(p.url), date: null, date_basis: null, verification: "possible", score: null, cosine: null, method: "reported by Google Cloud Vision; not confirmed by AIVS" };
        try {
          const pg = await fetchPage(p.url, { allowPrivate: !!config.allowPrivateFetch });
          Object.assign(mm, { title: pg.title || mm.title, publisher: pg.site || mm.publisher, date: pg.published || null, date_basis: pg.published ? (pg.publishedBasis || "publication date stated on the page") : null, description: pg.description || null, page_text: String(pg.text || "").slice(0, 1500) });
          if (pg.raw) { const snap = await storage.putBuffer(pg.raw, pg.mime || "text/html"); mm.snapshot_sha256 = snap.sha256; }
        } catch (e) { mm.page_error = e.message; }
        const imgUrl = p.full[0] || p.partial[0] || null;
        if (imgUrl) {
          try { const fp = await remoteFp(imgUrl), d = compareFp({ dhash: p.k.dhash, phash: p.k.phash, dhash_m: p.k.dhash_m, phash_m: p.k.phash_m, emb: p.k.emb }, fp);
            Object.assign(mm, { image_url: fp.finalUrl, score: d.score, cosine: d.cosine, mirrored: d.mirrored, verification: d.verification === "verified" ? "verified" : "possible",
              method: d.verification === "verified" ? `reported by Google Cloud Vision (${mm.provider_match} match) and confirmed by AIVS: perceptual hashes ${d.score}/128, embedding ${d.cosine}` : `reported by Google Cloud Vision (${mm.provider_match} match); AIVS's own comparison did not confirm it (${d.score}/128, embedding ${d.cosine})` }); }
          catch (e) { mm.method = `reported by Google Cloud Vision (${mm.provider_match} match); the matching image could not be retrieved for AIVS's own comparison (${e.message})`; }
        }
        add(mm);
      }
    }
    // earlier uploads on YouTube: searched by the video's words, published before the claim, compared by thumbnail
    const words = [...claims.map(x => x.text), ex.transcript?.text || "", (ex.ocr || []).map(o => o.text).join(" ")].join(" ");
    const q = [...new Set((words.toLowerCase().match(/[\p{L}][\p{L}'-]{3,}/gu) || []).filter(w => !/^(test|fixture|that|this|with|from|have|were|been|today|they|their|there|which|about|after|before|video|shows)$/.test(w)))].slice(0, 6).join(" ");
    if (!ytKey) unavailable.push({ provider: "YouTube Data API", reason: "not configured (YOUTUBE_API_KEY)" });
    else if (!q) notes.push("YouTube was not searched: the video gave no words to search with.");
    else if (left() > 20000) {
      try {
        const before = !isNaN(cd) ? new Date(cd - DAY).toISOString() : null;
        const u = `${V.youtubeBase}/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(q)}${before ? `&publishedBefore=${encodeURIComponent(before)}` : ""}&key=${encodeURIComponent(ytKey)}`;
        audit(user, "Video keywords sent to YouTube search", "case", c.id, { analysis: analysisId, query: q, published_before: before });
        const j = await getJson(u); let n = 0;
        for (const it of (j.items || []).slice(0, 5)) {
          const vid = it.id?.videoId, sn = it.snippet || {}, th = sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url; if (!vid || !th) continue; n++;
          try {
            const fp = await remoteFp(th); let best = null;
            for (const k of kf) { const d = compareFp({ dhash: k.dhash, phash: k.phash, dhash_m: k.dhash_m, phash_m: k.phash_m, emb: k.emb }, fp); if (!best || d.score < best.d.score) best = { d, k }; }
            if (best?.d.verification) add({ source: "web", provider: "YouTube Data API", provider_match: "thumbnail", keyframe_t: best.k.t, frame_media_id: best.k.frame_media_id, url: `https://www.youtube.com/watch?v=${vid}`, title: String(sn.title || "").slice(0, 200), publisher: `YouTube channel ${String(sn.channelTitle || "").slice(0, 100)}`,
              date: sn.publishedAt || null, date_basis: "publication time from the YouTube Data API", description: String(sn.description || "").slice(0, 500), image_url: th, score: best.d.score, cosine: best.d.cosine, mirrored: best.d.mirrored, verification: best.d.verification,
              method: `YouTube thumbnail compared by AIVS: perceptual hashes ${best.d.score}/128, embedding ${best.d.cosine}` });
          } catch (e) { notes.push(`A YouTube thumbnail could not be compared (${e.message}).`); }
        }
        searched.push({ provider: "YouTube Data API", query: q, results: n });
      } catch (e) { errors.push(`YouTube Data API: ${e.message}`); }
    }
    const sentAny = searched.some(s => (s.keyframes || s.results));
    setStage(analysisId, "reverse", searched.length ? (errors.some(e => /Vision|YouTube/.test(e)) ? "warning" : "done") : "skipped",
      searched.length ? searched.map(s => s.keyframes != null ? `${s.provider}: ${s.keyframes} keyframe(s) sent, ${s.pages} page(s) reported` : `${s.provider}: ${s.results} earlier upload(s) compared`).join("; ")
        : `internet-wide reverse search was not completed: ${unavailable.map(u => `${u.provider} ${u.reason}`).join("; ")}`);
    check();

    // c) findings and ranking
    setStage(analysisId, "findings", "running");
    const tierOf = m => m.url ? classify({ source_url: m.url })[0] : m.source === "archive" ? "official" : "earlier_case";
    for (const m of matches) {
      m.tier = tierOf(m); m.tier_label = TIERS[m.tier]?.[1] || null;
      m.relevance = Math.round(((m.verification === "verified" ? 60 : 25) + (m.score != null ? Math.max(0, 20 * (1 - m.score / 40)) : 0) + (m.cosine != null ? 10 * Math.max(0, m.cosine - 0.7) / 0.3 : 0)
        + (m.date ? 5 : 0) + (m.days_before_claim > 0 ? 5 : 0) + 5 * (TIERS[m.tier]?.[0] || 0.3)) * 10) / 10;
      m.relevance = Math.min(100, m.relevance);
    }
    matches.sort((a, b) => b.relevance - a.relevance || (Date.parse(a.date || "9999") - Date.parse(b.date || "9999")));
    matches.forEach((m, i) => { m.rank = i + 1; });
    const claimText = contextText || ex.context_text || claims.map(x => x.text).join(" "), claimPlaces = extractEntities(claimText).locations;
    const findings = [], reuse = [], fmt = d => String(d).slice(0, 10);
    for (const m of matches.filter(m => m.date && m.days_before_claim != null && m.days_before_claim > 30)) {
      const where = m.url ? m.url : `${m.source === "archive" ? "archive record" : "case"} ${m.ref}`;
      if (m.verification === "verified") {
        const t = `Possible recycled footage: the keyframe at ${m.keyframe_t} s matches ${m.title ? `“${String(m.title).slice(0, 90)}” ` : ""}(${where}), dated ${fmt(m.date)} (${m.date_basis}), ${m.days_before_claim} days before the claim. The match was confirmed by AIVS's own comparison (${m.method}). This shows the footage existed earlier; it does not identify who first published it.`;
        findings.push({ kind: "recycled", strength: "strong", rank: m.rank, text: t }); reuse.push({ media_id: A.media_id, text: t, video_analysis: analysisId });
      } else findings.push({ kind: "possible_recycled", strength: "weak", rank: m.rank, text: `Possible similarity (not confirmed): the keyframe at ${m.keyframe_t} s resembles footage at ${where}, dated ${fmt(m.date)}, ${m.days_before_claim} days before the claim (${m.method}). Compare them before relying on it.` });
    }
    for (const m of matches.filter(m => m.verification === "verified").slice(0, 5)) {
      const ctx = [m.title, m.description, m.page_text].filter(Boolean).join(" "), places = extractEntities(ctx).locations;
      if (claimPlaces.length && places.length && !places.some(p => claimPlaces.includes(p)))
        findings.push({ kind: "context", strength: "moderate", rank: m.rank, text: `Possible misleading context: the matching earlier copy (${m.url || `${m.source} ${m.ref}`}) refers to ${places.slice(0, 3).join(", ")}, while the text accompanying the video refers to ${claimPlaces.slice(0, 3).join(", ")}.` });
    }
    const onscreen = (ex.ocr || []).map(o => o.text).join(" "), speech = ex.transcript?.text || "";
    const yearsOn = extractEntities(onscreen).dates.map(d => Number(String(d.iso).slice(0, 4))).filter(Boolean), cy = isNaN(cd) ? null : new Date(cd).getUTCFullYear();
    if (cy && yearsOn.some(y => y < cy - 1)) findings.push({ kind: "date", strength: "weak", text: `Date inconsistency: on-screen text in the video shows ${[...new Set(yearsOn.filter(y => y < cy - 1))].join(", ")}, earlier than the claim (${cy}). A caption can show an old date for many reasons; check the footage's origin.` });
    for (const [what, txt] of [["on-screen text", onscreen], ["speech", speech]]) {
      const pl = extractEntities(txt).locations;
      if (claimPlaces.length && pl.length && !pl.some(p => claimPlaces.includes(p))) findings.push({ kind: "location", strength: "weak", text: `Location inconsistency: the video's ${what} names ${pl.slice(0, 3).join(", ")}, while the text accompanying the video names ${claimPlaces.slice(0, 3).join(", ")}.` });
    }
    const ct = pr?.metadata?.creation_time; if (ct && !isNaN(cd) && cd - Date.parse(ct) > 30 * DAY && Date.parse(ct) > Date.parse("1995-01-01")) findings.push({ kind: "metadata_date", strength: "weak", text: `The container creation time (${fmt(ct)}) is ${Math.round((cd - Date.parse(ct)) / DAY)} days before the claim. Container times are often reset or copied by editing and messaging apps; treat this as a lead only.` });
    if (pr?.metadata?.location) findings.push({ kind: "metadata_location", strength: "observed", text: `The file carries a location tag (${pr.metadata.location}). It is metadata, which can be wrong or edited; it is not proof of where the footage was recorded.` });
    if (claims.length && (speech || onscreen)) { const s = similarities(`${speech} ${onscreen}`, claims.map(x => x.text)), b = s.length ? Math.max(...s) : 0; if (b >= 0.3) findings.push({ kind: "repeats_claim", strength: "observed", text: `The video's speech or on-screen text repeats claim ${claims[s.indexOf(b)].seq}.` }); }
    const ver = matches.filter(m => m.verification === "verified").length, pos = matches.length - ver;
    const providers = searched.map(s => s.provider), internet = sentAny;
    const coverage = internet
      ? `Reverse search used ${providers.join(" and ")} on ${kf.length ? `${pick.length} of ${kf.length} keyframes` : "the keyframes"}${unavailable.length ? `; ${unavailable.map(u => u.provider).join(" and ")} not available` : ""}. These services index only part of the web: this is not a search of the entire internet, and absence of a match does not show the footage is new.`
      : `Internet-wide reverse search was not completed (${unavailable.map(u => `${u.provider}: ${u.reason}`).join("; ") || "provider errors"}). Keyframe extraction and local similarity analysis (reference archive, earlier cases and earlier analysed videos) were done.`;
    const limits = ["AIVS did not establish who first published or recorded the footage.", "No test for AI generation or deepfake manipulation was performed; no finding about manipulation is made.", "A verified match means two pictures were compared and found visually the same; it does not by itself prove what the footage shows."];
    const strongest = findings.find(f => f.kind === "recycled");
    const summary = `Video verification: ${kf.length} keyframe(s) of ${video.original_name} were extracted and compared${ex.transcript?.text ? ", its speech transcribed" : ""}${(ex.ocr || []).length ? ", its on-screen text read" : ""}. `
      + (strongest ? `An earlier copy was verified (${matches.find(m => m.rank === strongest.rank)?.publisher || "earlier source"}, ${fmt(matches.find(m => m.rank === strongest.rank)?.date)}), so the footage is likely recycled. ` : ver ? `${ver} verified match(es) were found, none dated well before the claim. ` : pos ? `${pos} possible similarit${pos === 1 ? "y was" : "ies were"} found but not confirmed. ` : "No earlier copy was found. ")
      + (internet ? `Reverse search covered ${providers.join(" and ")} only.` : "Internet-wide reverse search was not completed.");
    const result = { analysis_id: analysisId, video: { media_id: video.id, name: video.original_name, sha256: video.sha256, size: video.size, mime: video.mime }, probe: pr, keyframes: kf.map(k => ({ t: k.t, media_id: k.frame_media_id, origin: k.origin, ocr: k.ocr_text })),
      transcript: ex.transcript || null, onscreen_text: ex.ocr || [], matches: matches.map(({ page_text, ...m }) => m), verified: ver, possible: pos, findings, reuse, coverage, internet_search: internet, searched, unavailable, limits, summary, errors, notes: [...(ex.notes || []), ...notes],
      claim_date: claimDate, thresholds: { verified: VERIFIED, possible: POSSIBLE }, completed_at: nowISO() };
    db.prepare("UPDATE video_analyses SET status = 'done', result_json = ?, completed_at = ?, error = NULL WHERE id = ?").run(JSON.stringify(result), result.completed_at, analysisId);
    setStage(analysisId, "findings", "done", `${matches.length} match(es) ranked (${ver} verified, ${pos} possible); ${findings.length} finding(s)`);
    audit(user, "Video verification completed", "case", c.id, { analysis: analysisId, video: video.id, keyframes: kf.length, verified: ver, possible: pos, recycled: reuse.length, internet_search: internet });
    return result;
  }

  // ---- standalone: "Reverse video search" on a video kept with a case (runs in the background)
  function start(user, mediaId) {
    const v = db.prepare("SELECT * FROM media WHERE id = ?").get(mediaId);
    if (!v?.case_id) throw new HttpError(404, "Video not found.");
    if (v.kind !== "video") throw new HttpError(415, "Reverse video search works on video files (MP4, MOV, AVI, WebM). For an image, use Reverse image search.");
    const c = cases.mustCase(v.case_id); cases.requireEdit(user, c);
    if (!available()) throw new HttpError(503, status().ffmpeg.available ? status().ffprobe.needs : status().ffmpeg.needs);
    if (db.prepare("SELECT 1 FROM video_analyses WHERE media_id = ? AND status IN ('queued','running')").get(mediaId)) throw new HttpError(409, "This video is already being analysed.");
    const id = nextId(db, "video_analysis", n => `VC-${String(n).padStart(6, "0")}`);
    db.prepare("INSERT INTO video_analyses(id,media_id,case_id,status,stage,stages_json,is_training,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, mediaId, c.id, "running", "probe", newStages(), c.is_training ? 1 : 0, user.id, nowISO());
    audit(user, "Reverse video search started", "case", c.id, { analysis: id, video: mediaId, sha256: v.sha256 });
    const p = (async () => {
      const x = await extract(storage.pathOf(v.sha256), v.original_name, { onStage: (k, s, d) => setStage(id, k, s, d) });
      if (!x.frames.length) throw new Error(x.errors[0] || "No keyframe could be extracted.");
      await persist(user, { caseId: c.id, mediaId, extracted: x, analysisId: id });
      await verify(user, { analysisId: id });
    })().catch(e => { db.prepare("UPDATE video_analyses SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").run(String(e.message).slice(0, 500), nowISO(), id); audit(user, "Reverse video search failed", "case", c.id, { analysis: id, error: String(e.message).slice(0, 300) }); })
      .finally(() => jobs.delete(id));
    jobs.set(id, p);
    return get(id);
  }
  function get(id) {
    const r = row(id); if (!r) throw new HttpError(404, "Video analysis not found.");
    return { ...r, stages: JSON.parse(r.stages_json), probe: r.probe_json ? JSON.parse(r.probe_json) : null, result: r.result_json ? JSON.parse(r.result_json) : null, stages_json: undefined, probe_json: undefined, result_json: undefined, extract_json: undefined };
  }
  const forMedia = mediaId => db.prepare("SELECT id FROM video_analyses WHERE media_id = ? ORDER BY created_at DESC, id DESC").all(mediaId).map(r => get(r.id));
  const idle = () => Promise.allSettled([...jobs.values()]);
  db.prepare("UPDATE video_analyses SET status = 'failed', error = 'Interrupted: the server stopped before the analysis finished. Run Reverse video search again.' WHERE status IN ('queued','running')").run();
  return { status, available, extract, videoText, persist, verify, start, get, forMedia, idle };
}

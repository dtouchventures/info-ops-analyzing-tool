// Speech-to-text for case audio and video, through the AIVS transcription service (faster-whisper) running on a
// server on the organisation's network. The original recording is never changed: a copy is sent to the service,
// which deletes it after transcribing. Transcripts are stored as timestamped segments, labelled machine-generated,
// and every analyst correction is kept with the machine text it replaced.
import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./auth.js";
import { nowISO, nextId } from "./db.js";
import { isLocalHost } from "./ollama.js";

export const LANGS = { auto: "Detect automatically", en: "English", sw: "Kiswahili" };
const ts = s => { const t = Math.max(0, Number(s) || 0), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${x.toFixed(1).padStart(4, "0")}`; };
export const fmtTs = ts;
const srtTs = (s, sep = ",") => { const t = Math.max(0, s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = Math.floor(t % 60), ms = Math.round((t % 1) * 1000); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}${sep}${String(ms).padStart(3, "0")}`; };

export function makeTranscriber(db, { config, storage, audit, cases }) {
  const T = { url: "", token: "", maxMb: 500, timeoutMs: 600000, pollMs: 2000, allowRemote: false, ...(config.transcribe || {}) };
  const base = String(T.url || "").replace(/\/+$/, "");
  let health = { state: "unknown", checked_at: null, error: null };
  function configured() {
    if (!base) return { ok: false, reason: "Speech-to-text is not configured: install the AIVS transcription service (transcriber folder) on a server on your network and set TRANSCRIBE_URL and TRANSCRIBE_TOKEN." };
    let host; try { host = new URL(base).hostname; } catch { return { ok: false, reason: "TRANSCRIBE_URL is not a valid address." }; }
    if (!isLocalHost(host) && !T.allowRemote) return { ok: false, reason: `TRANSCRIBE_URL points to a public address (${host}). Recordings must stay on your own network. Use the server's private address, or set TRANSCRIBE_ALLOW_REMOTE=true only for a protected institution server.` };
    if (!T.token) return { ok: false, reason: "TRANSCRIBE_TOKEN is missing (the installer printed it on the transcription server)." };
    return { ok: true };
  }
  async function call(method, path, body, timeoutMs = 30000) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(base + path, { method, body, headers: { authorization: `Bearer ${T.token}` }, signal: ac.signal });
      const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
      if (!r.ok) throw Object.assign(new Error(j?.detail || j?.error || `The transcription service answered HTTP ${r.status}.`), { status: r.status });
      return j;
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`The transcription service did not answer within ${Math.round(timeoutMs / 1000)} s.`);
      if (e.status) throw e;
      const code = e.cause?.code || e.cause?.errors?.[0]?.code || "";
      if (/ECONNREFUSED/.test(code)) throw new Error(`The transcription service refused the connection at ${base}. Check that it is running on the server (sudo systemctl status aivs-transcribe) and that its firewall allows this AIVS computer.`);
      if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT/.test(code)) throw new Error(`The transcription server ${base} cannot be reached from this computer (${code}). Check the network and the server's firewall.`);
      throw new Error(`Could not connect to the transcription service at ${base} (${code || e.cause?.message || e.message}).`);
    } finally { clearTimeout(t); }
  }
  async function checkHealth({ force = false } = {}) {
    const c = configured(); if (!c.ok) return (health = { state: "not_configured", checked_at: nowISO(), error: c.reason });
    if (!force && health.checked_at && Date.now() - Date.parse(health.checked_at) < (health.state === "ok" ? 5 * 60e3 : 60e3)) return health;
    try {
      const h = await call("GET", "/health", undefined, 120000);
      // /health has no token; check the token too, so "available" means AIVS can really submit recordings
      try { await call("GET", "/v1/jobs/aivs-token-check"); } catch (e) { if (e.status === 401 || e.status === 503) throw new Error(`The service rejected AIVS's token: ${e.message} Copy TRANSCRIBE_TOKEN from /etc/aivs-transcribe.env on the server.`); if (e.status !== 404) throw e; }
      health = h.ok ? { state: "ok", checked_at: nowISO(), error: null, ...h } : { state: "failed", checked_at: nowISO(), error: h.error || "The service reports a problem.", ...h };
    } catch (e) { health = { state: "failed", checked_at: nowISO(), error: e.message }; }
    // a plain record of the last check, for the administrator (never the token)
    try { if (config.dataDir) fs.writeFileSync(path.join(config.dataDir, "transcribe-health.txt"), `AIVS speech-to-text health check ${health.checked_at}\nService: ${base}\nResult: ${health.state === "ok" ? `ok (token accepted; ${health.engine} ${health.model}, ${health.compute_type}, ${health.cpu_threads} threads, ${health.ram_available_gb}/${health.ram_total_gb} GB RAM free)` : health.state}\n${health.error ? `Problem: ${health.error}\n` : ""}`); } catch {}
    return health;
  }
  const status = () => ({ ...configured(), health, max_mb: Math.min(T.maxMb, config.maxUploadMb || T.maxMb), max_minutes: health.max_minutes || null, languages: LANGS });

  // ---- jobs (run in the background; progress is stored so the page can follow it and survive a restart)
  const running = new Set();
  function start(user, mediaId, language = "auto") {
    if (!LANGS[language]) throw new HttpError(400, "Choose a language: auto, en or sw.");
    const m = db.prepare("SELECT * FROM media WHERE id = ?").get(mediaId); if (!m || !m.case_id) throw new HttpError(404, "Recording not found.");
    if (!["audio", "video"].includes(m.kind)) throw new HttpError(415, "Only audio and video can be transcribed.");
    const c = cases.mustCase(m.case_id); cases.requireEdit(user, c);
    const cf = configured(); if (!cf.ok) throw new HttpError(503, cf.reason);
    const max = Math.min(T.maxMb, config.maxUploadMb || T.maxMb);
    if (m.size > max * 1048576) throw new HttpError(413, `This recording is ${(m.size / 1048576).toFixed(0)} MB; the transcription limit is ${max} MB. Cut it into parts.`);
    if (db.prepare("SELECT 1 FROM transcripts WHERE media_id = ? AND status IN ('queued','running')").get(m.id)) throw new HttpError(409, "This recording is already being transcribed.");
    const id = nextId(db, "transcript", n => `T-${String(n).padStart(6, "0")}`);
    db.prepare("INSERT INTO transcripts(id,media_id,case_id,status,language_requested,media_sha256,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, m.id, m.case_id, "queued", language, m.sha256, user.id, nowISO());
    audit(user, `Transcription started for ${m.id} (${LANGS[language]})`, "case", m.case_id, { transcript: id, media: m.id, sha256: m.sha256, destination: new URL(base).host });
    setImmediate(() => run(id, m).catch(() => {}));
    return id;
  }
  const upd = (id, f) => db.prepare(`UPDATE transcripts SET ${Object.keys(f).map(k => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...f, id });
  async function run(id, m) {
    if (running.has(id)) return; running.add(id);
    try {
      let t = db.prepare("SELECT * FROM transcripts WHERE id = ?").get(id);
      if (!t.remote_job_id) {
        const fd = new FormData();
        fd.append("file", await fs.openAsBlob(storage.pathOf(m.sha256)), `${m.id}.${(m.original_name.match(/\.(\w+)$/) || [, "bin"])[1]}`);
        fd.append("language", t.language_requested);
        const j = await call("POST", "/v1/jobs", fd, Math.max(120000, T.timeoutMs));
        upd(id, { remote_job_id: j.id, duration_s: j.duration_s, status: "running" });
        t = db.prepare("SELECT * FROM transcripts WHERE id = ?").get(id);
      }
      const t0 = Date.now(), limit = Math.max(T.timeoutMs, (t.duration_s || 0) * 1000 * 6);   // CPU transcription: allow up to 6x the recording length
      for (;;) {
        const j = await call("GET", `/v1/jobs/${t.remote_job_id}`);
        if (j.status === "failed") throw new Error(`The transcription service could not transcribe this recording: ${j.error}`);
        if (j.status === "done") { save(id, j.result); call("DELETE", `/v1/jobs/${t.remote_job_id}`).catch(() => {}); return; }
        upd(id, { progress: Math.max(0, Math.min(0.99, j.progress || 0)), status: j.status === "queued" ? "queued" : "running" });
        if (Date.now() - t0 > limit) throw new Error(`The transcription took longer than ${Math.round(limit / 60000)} minutes and was stopped waiting. The server may be busy; try again later.`);
        await new Promise(r => setTimeout(r, T.pollMs));
      }
    } catch (e) {
      upd(id, { status: "failed", error: String(e.status === 404 && /No such job/.test(e.message) ? "The transcription service restarted and lost this job. Start the transcription again." : e.message).slice(0, 600), finished_at: nowISO() });
      const t = db.prepare("SELECT case_id FROM transcripts WHERE id = ?").get(id); audit(null, "Transcription failed", "case", t.case_id, { transcript: id, error: String(e.message).slice(0, 300) });
    } finally { running.delete(id); }
  }
  function save(id, r) {
    db.transaction(() => {
      db.prepare("DELETE FROM transcript_segments WHERE transcript_id = ?").run(id);
      const ins = db.prepare("INSERT INTO transcript_segments(transcript_id,seq,start_s,end_s,text_machine,text_current,confidence,no_speech_prob,unclear,reasons) VALUES (?,?,?,?,?,?,?,?,?,?)");
      (r.segments || []).forEach((s, i) => ins.run(id, i + 1, s.start, s.end, String(s.text).slice(0, 4000), String(s.text).slice(0, 4000), s.confidence ?? null, s.no_speech_prob ?? null, s.unclear ? 1 : 0, JSON.stringify(s.reasons || [])));
      upd(id, { status: "done", progress: 1, language: r.language, language_probability: r.language_probability, language_basis: r.language_basis, engine: r.engine, model: r.model,
        speech_found: r.speech_found ? 1 : 0, dropped_non_speech: r.dropped_non_speech || 0, processing_s: r.processing_s, finished_at: nowISO(), error: null });
    })();
    const t = db.prepare("SELECT case_id, media_id FROM transcripts WHERE id = ?").get(id);
    audit(null, "Machine transcript stored", "case", t.case_id, { transcript: id, media: t.media_id, segments: (r.segments || []).length, language: r.language, model: `${r.engine} ${r.model}`, unclear: (r.segments || []).filter(s => s.unclear).length });
  }
  // after a restart, keep following jobs that were in progress
  function resume() { for (const t of db.prepare("SELECT t.id AS tid, m.* FROM transcripts t JOIN media m ON m.id = t.media_id WHERE t.status IN ('queued','running')").all()) run(t.tid, t).catch(() => {}); }

  // ---- reading, editing, searching, exporting, evidence
  function get(id, { q } = {}) {
    const t = db.prepare("SELECT t.*, m.original_name, m.kind AS media_kind, u.display_name AS created_by_name FROM transcripts t JOIN media m ON m.id = t.media_id LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?").get(id);
    if (!t) throw new HttpError(404, "Transcript not found.");
    let segs = db.prepare("SELECT s.*, u.display_name AS edited_by_name FROM transcript_segments s LEFT JOIN users u ON u.id = s.edited_by WHERE s.transcript_id = ? ORDER BY s.seq").all(id).map(s => ({ ...s, reasons: JSON.parse(s.reasons || "[]"), edited: s.text_current !== s.text_machine }));
    const total = segs.length;
    if (q) { const n = String(q).toLowerCase().slice(0, 200); segs = segs.filter(s => s.text_current.toLowerCase().includes(n) || s.text_machine.toLowerCase().includes(n)); }
    return { ...t, label: label(t), segments: segs, total_segments: total, edited_segments: db.prepare("SELECT COUNT(*) n FROM transcript_segments WHERE transcript_id = ? AND text_current != text_machine").get(id).n };
  }
  const label = t => `MACHINE-GENERATED TRANSCRIPT (${t.engine || "speech recognition"} ${t.model || ""}, language ${t.language ? `${LANGS[t.language] || t.language}: ${t.language_basis || ""}` : "not yet known"}). It may contain mistakes and does not include speech it could not make out. Check it against the original recording ${t.media_id} (SHA-256 ${t.media_sha256.slice(0, 16)}…).`;
  const list = mediaId => db.prepare("SELECT id, status, progress, language_requested, language, model, error, created_at, finished_at FROM transcripts WHERE media_id = ? ORDER BY created_at DESC").all(mediaId);
  function segment(segId) { const s = db.prepare("SELECT s.*, t.case_id, t.status FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id WHERE s.id = ?").get(Number(segId)); if (!s) throw new HttpError(404, "Segment not found."); return s; }
  function edit(user, segId, text) {
    const s = segment(segId); cases.requireEdit(user, cases.mustCase(s.case_id));
    const v = String(text ?? "").replace(/\s+/g, " ").trim(); if (v.length > 4000) throw new HttpError(400, "Keep a segment under 4,000 characters.");
    if (v === s.text_current) return;
    db.transaction(() => {
      db.prepare("INSERT INTO transcript_edits(segment_id,old_text,new_text,edited_by,edited_at) VALUES (?,?,?,?,?)").run(s.id, s.text_current, v, user.id, nowISO());
      db.prepare("UPDATE transcript_segments SET text_current = ?, edited_by = ?, edited_at = ? WHERE id = ?").run(v, user.id, nowISO(), s.id);
    })();
    audit(user, `Transcript ${s.transcript_id} segment ${s.seq} corrected`, "case", s.case_id, { from: s.text_current.slice(0, 300), to: v.slice(0, 300), machine: s.text_machine.slice(0, 300) });
  }
  const history = segId => db.prepare("SELECT e.old_text, e.new_text, e.edited_at, u.display_name AS by_name FROM transcript_edits e LEFT JOIN users u ON u.id = e.edited_by WHERE e.segment_id = ? ORDER BY e.id").all(Number(segId));
  function exportAs(id, fmt) {
    const t = get(id), segs = t.segments;
    if (fmt === "json") return JSON.stringify({ label: t.label, transcript: t.id, media: t.media_id, media_sha256: t.media_sha256, file: t.original_name, engine: t.engine, model: t.model, language: t.language, language_basis: t.language_basis, created_at: t.created_at, segments: segs.map(s => ({ seq: s.seq, start: s.start_s, end: s.end_s, text: s.text_current, machine_text: s.text_machine, edited: s.edited, unclear: !!s.unclear, reasons: s.reasons, confidence: s.confidence })) }, null, 2);
    const note = s => `${s.unclear ? " [unclear]" : ""}${s.edited ? " [corrected by analyst]" : ""}`;
    if (fmt === "srt") return segs.map((s, i) => `${i + 1}\n${srtTs(s.start_s)} --> ${srtTs(s.end_s)}\n${s.text_current}${note(s)}\n`).join("\n");
    if (fmt === "vtt") return `WEBVTT\n\nNOTE ${t.label}\n\n` + segs.map(s => `${srtTs(s.start_s, ".")} --> ${srtTs(s.end_s, ".")}\n${s.text_current}${note(s)}\n`).join("\n");
    return `${t.label}\nTranscript ${t.id} of ${t.media_id} (${t.original_name}), made ${t.created_at}. ${t.edited_segments} segment(s) corrected by analysts.\n\n` + (segs.length ? segs.map(s => `[${ts(s.start_s)} – ${ts(s.end_s)}] ${s.text_current}${note(s)}`).join("\n") : "No speech was detected in this recording.") + "\n";
  }
  function toEvidence(user, id, { segment_ids = [], claim_id = null, stance = "context" } = {}) {
    const t = get(id); cases.requireEdit(user, cases.mustCase(t.case_id));
    const segs = t.segments.filter(s => segment_ids.map(Number).includes(s.id)); if (!segs.length) throw new HttpError(400, "Choose at least one segment.");
    if (!["supports", "contradicts", "context"].includes(stance)) throw new HttpError(400, "The stance must be supports, contradicts or context.");
    const from = segs[0].start_s, to = segs.at(-1).end_s, text = segs.map(s => s.text_current).join(" ");
    const flags = [segs.some(s => s.unclear) && "includes passages marked unclear", segs.some(s => !s.edited) && "includes machine text not yet corrected by an analyst"].filter(Boolean);
    const eid = cases.addEvidence(user, t.case_id, {
      kind: "observation", media_id: t.media_id, transcript_id: t.id, loc_start_s: from, loc_end_s: to, links: claim_id ? [{ claim_id, stance }] : [],
      text: `Heard in ${t.media_id} (${t.original_name}) at ${ts(from)}–${ts(to)}: “${text.slice(0, 3000)}”`,
      reference: `Machine transcript ${t.id}, segment${segs.length > 1 ? "s" : ""} ${segs.map(s => s.seq).join(", ")} (${t.engine} ${t.model}, ${LANGS[t.language] || t.language}); recording ${t.media_id} SHA-256 ${t.media_sha256.slice(0, 16)}…, ${ts(from)}–${ts(to)}`,
      uncertainty: `Machine-generated transcript${flags.length ? `: ${flags.join("; ")}` : ", checked by the analyst"}. Listen to the recording at ${ts(from)} before relying on the wording.`
    });
    audit(user, `Transcript ${t.id} segments added as evidence ${eid}`, "case", t.case_id, { segments: segs.map(s => s.seq), from, to });
    return eid;
  }
  return { status, checkHealth, start, resume, get, list, edit, history, exportAs, toEvidence, label };
}

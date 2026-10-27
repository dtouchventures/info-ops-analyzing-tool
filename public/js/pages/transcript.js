// Machine transcripts of case audio and video: start, follow progress, review, correct, search, download, cite as evidence.
// The transcript is always shown as machine-generated; timestamps jump the player to the moment so the analyst can listen.
import { api } from "../api.js";
import { App } from "../app.js";
import { $, $$, esc, toast, fail, modal, fmtDT } from "../ui.js";

export const LANG_OPTS = [["auto", "Detect automatically (English or Kiswahili)"], ["en", "English"], ["sw", "Kiswahili"]];
const LN = { en: "English", sw: "Kiswahili" };
export const ts = s => { const t = Math.max(0, Number(s) || 0), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${x.toFixed(1).padStart(4, "0")}`; };
const langSelect = (id, sel = "auto") => `<select id="${id}" style="width:auto" aria-label="Spoken language">${LANG_OPTS.map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`).join("")}</select>`;
const svc = () => App.meta.transcribe || { ok: false, reason: "Speech-to-text is not configured." };

// one panel per recording; filled in by bindTranscripts
export const transcriptPanel = m => `<div class="tpanel" data-tpanel="${esc(m.id)}" style="margin-top:12px"><div class="small sub"><span class="spin"></span> Loading transcript…</div></div>`;

export function bindTranscripts(A, c, P, reload, isCurrent) {
  for (const box of $$("[data-tpanel]")) {
    const mid = box.dataset.tpanel, list = A.transcripts.filter(t => t.media_id === mid), last = list.at(-1);
    if (!last) { box.innerHTML = startForm(mid, P); bindStart(box, mid, reload); continue; }
    if (last.status === "queued" || last.status === "running") { follow(box, last.id, mid, reload, isCurrent); continue; }
    if (last.status === "failed") { api.get(`/api/transcripts/${last.id}`).then(t => { box.innerHTML = `<div class="callout bad"><div><b>Transcription ${esc(t.id)} failed.</b> ${esc(t.error || "")}<div class="tiny sub">The original recording is unchanged.</div></div></div>${startForm(mid, P, true)}`; bindStart(box, mid, reload); }).catch(e => (box.innerHTML = `<div class="callout bad"><div>${esc(e.message)}</div></div>`)); continue; }
    show(box, last.id, mid, c, P, A, reload);
  }
}

function startForm(mid, P, again = false) {
  const S = svc(), H = S.health || {};
  if (!S.ok) return `<div class="callout"><div class="small"><b>Speech-to-text not available.</b> ${esc(S.reason)}</div></div>`;
  if (H.state === "failed") return `<div class="callout warn"><div class="small"><b>The transcription service is not answering.</b> ${esc(H.error || "")}</div></div>`;
  if (!P.edit) return `<div class="small sub">No transcript yet.</div>`;
  return `<div class="row"><b class="small">${again ? "Try again" : "Transcribe speech"}</b>${langSelect(`tl-${mid}`)}<button class="btn sm primary" data-tstart="${esc(mid)}">Transcribe</button></div>
    <div class="tiny sub">Runs on your organisation's transcription server (${esc(H.model ? `faster-whisper ${H.model}` : "faster-whisper")}, CPU). Long recordings take a while; you can leave this page. Supports English and Kiswahili.</div>`;
}
function bindStart(box, mid, reload) {
  const b = box.querySelector("[data-tstart]"); if (!b) return;
  b.onclick = async () => { b.disabled = true; b.innerHTML = '<span class="spin"></span> Sending…'; try { await api.post(`/api/media/${mid}/transcripts`, { language: $(`#tl-${mid}`).value }); toast("Transcription started. The recording was sent only to your transcription server."); await reload(); } catch (e) { fail(e); b.disabled = false; b.textContent = "Transcribe"; } };
}

function follow(box, tid, mid, reload, isCurrent) {
  const t0 = Date.now();
  const tick = async () => {
    if (!document.body.contains(box) || !isCurrent()) return;
    let t; try { t = await api.get(`/api/transcripts/${tid}`); } catch (e) { box.innerHTML = `<div class="callout bad"><div>${esc(e.message)}</div></div>`; return; }
    if (t.status === "done" || t.status === "failed") return reload();
    const pct = Math.round((t.progress || 0) * 100), sec = Math.round((Date.now() - t0) / 1000);
    box.innerHTML = `<div class="small"><b>${t.status === "queued" ? "Waiting for the transcription server" : "Transcribing"}</b> ${esc(t.id)} · ${t.status === "running" ? `${pct}%` : "queued"}${t.duration_s ? ` of ${ts(t.duration_s)}` : ""} <span class="tiny sub">(${sec} s on this page)</span></div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Transcription progress"><div style="width:${Math.max(3, pct)}%"></div></div>
      <div class="tiny sub">Processed in the background on the server; you can leave this page and come back.</div>`;
    setTimeout(tick, 2500);
  };
  tick();
}

async function show(box, tid, mid, c, P, A, reload) {
  let t; try { t = await api.get(`/api/transcripts/${tid}`); } catch (e) { box.innerHTML = `<div class="callout bad"><div>${esc(e.message)}</div></div>`; return; }
  const player = () => document.getElementById(`aud-${mid}`) || document.getElementById(`vid-${mid}`);
  const seg = s => `<div class="tseg${s.unclear ? " unclear" : ""}" data-sid="${s.id}">
      <div class="row" style="gap:6px">${P.edit ? `<input type="checkbox" data-tsel="${s.id}" aria-label="Select segment ${s.seq}">` : ""}<button class="btn sm ghost mono" data-seek="${s.start_s}" title="Play from here">${ts(s.start_s)} – ${ts(s.end_s)}</button>
        ${s.unclear ? `<span class="chip warn" title="Check this passage by listening">unclear: ${esc(s.reasons.join(", "))}</span>` : ""}${s.edited ? `<span class="chip info">corrected by ${esc(s.edited_by_name || "analyst")}</span><button class="btn sm ghost" data-thist="${s.id}">History</button>` : ""}
        <span class="tiny sub" style="margin-left:auto">${s.confidence != null ? `confidence ${Math.round(s.confidence * 100)}%` : ""}</span></div>
      ${P.edit ? `<textarea data-ttext="${s.id}" rows="2" aria-label="Text of segment ${s.seq}">${esc(s.text_current)}</textarea><div class="row" data-tsave-row="${s.id}" hidden><button class="btn sm primary" data-tsave="${s.id}">Save correction</button><button class="btn sm ghost" data-tundo="${s.id}">Cancel</button></div>` : `<div class="small">${esc(s.text_current)}</div>`}
      ${s.edited ? `<div class="tiny sub">Machine text: “${esc(s.text_machine)}”</div>` : ""}</div>`;
  const claims = A.claims.filter(x => !x.removed);
  box.innerHTML = `<div class="callout warn"><div class="small"><b>Machine-generated transcript ${esc(t.id)}</b> · ${esc(LN[t.language] || t.language || "")} (${esc(t.language_basis || "")}) · ${esc(`${t.engine} ${t.model}`)} · ${fmtDT(t.finished_at)}${t.processing_s ? ` · ${t.processing_s} s to process` : ""}<div class="tiny">It may contain mistakes and leaves out speech it could not make out. Listen to the recording before relying on any wording.${t.dropped_non_speech ? ` ${t.dropped_non_speech} passage(s) judged not to be speech were left out.` : ""}</div></div></div>
    ${!t.speech_found ? `<div class="callout"><div class="small"><b>No speech was detected in this recording.</b> Nothing was written down. If you can hear speech, try again choosing the language manually.</div></div>` : `
    <div class="row" style="margin-top:8px"><input type="search" id="tq-${esc(mid)}" placeholder="Search this transcript" style="flex:1;min-width:180px" aria-label="Search transcript"><span class="tiny sub" id="tc-${esc(mid)}">${t.total_segments} segment(s) · ${t.segments.filter(s => s.unclear).length} unclear · ${t.edited_segments} corrected</span></div>
    <div class="tsegs" id="ts-${esc(mid)}" style="max-height:460px;overflow:auto;margin-top:6px">${t.segments.map(seg).join("")}</div>`}
    <div class="row" style="margin-top:8px">${["txt", "srt", "vtt", "json"].map(f => `<a class="btn sm ghost" href="/api/transcripts/${esc(t.id)}.${f}" download>${f.toUpperCase()}</a>`).join("")}
      ${P.edit && t.speech_found ? `<button class="btn sm primary" data-tev="${esc(t.id)}" disabled>Add selected as evidence</button>` : ""}
      ${P.edit ? `<span style="margin-left:auto" class="row">${langSelect(`tl-${mid}`, t.language_requested)}<button class="btn sm" data-tstart="${esc(mid)}">Transcribe again</button></span>` : ""}</div>`;
  bindStart(box, mid, reload);
  const segsEl = box.querySelector(".tsegs");
  const bindSegs = () => {
    box.querySelectorAll("[data-seek]").forEach(b => b.onclick = () => { const p = player(); if (!p) return; p.currentTime = Number(b.dataset.seek); p.play?.().catch(() => {}); p.scrollIntoView({ block: "nearest" }); });
    box.querySelectorAll("[data-ttext]").forEach(ta => { const orig = ta.value, row = box.querySelector(`[data-tsave-row="${ta.dataset.ttext}"]`); ta.oninput = () => (row.hidden = ta.value === orig); });
    box.querySelectorAll("[data-tundo]").forEach(b => b.onclick = () => { const ta = box.querySelector(`[data-ttext="${b.dataset.tundo}"]`); ta.value = ta.defaultValue; b.parentElement.hidden = true; });
    box.querySelectorAll("[data-tsave]").forEach(b => b.onclick = async () => { try { await api.patch(`/api/transcript-segments/${b.dataset.tsave}`, { text: box.querySelector(`[data-ttext="${b.dataset.tsave}"]`).value }); toast("Correction saved. The machine text is kept in the history."); await reload(); } catch (e) { fail(e); } });
    box.querySelectorAll("[data-thist]").forEach(b => b.onclick = async () => { try { const h = (await api.get(`/api/transcript-segments/${b.dataset.thist}/history`)).edits; modal("Segment history", `<table class="tbl small"><thead><tr><th>When</th><th>Who</th><th>Before</th><th>After</th></tr></thead><tbody>${h.map(e => `<tr><td>${fmtDT(e.edited_at)}</td><td>${esc(e.by_name || "")}</td><td>${esc(e.old_text)}</td><td>${esc(e.new_text)}</td></tr>`).join("")}</tbody></table>`, undefined, { wide: true }); } catch (e) { fail(e); } });
    const evb = box.querySelector("[data-tev]"), upd = () => { if (evb) evb.disabled = !box.querySelectorAll("[data-tsel]:checked").length; };
    box.querySelectorAll("[data-tsel]").forEach(x => x.onchange = upd); upd();
  };
  bindSegs();
  const q = box.querySelector(`#tq-${CSS.escape(mid)}`);
  if (q) { let qt; q.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { try { const r = await api.get(`/api/transcripts/${t.id}${q.value.trim() ? `?q=${encodeURIComponent(q.value.trim())}` : ""}`); segsEl.innerHTML = r.segments.map(seg).join("") || `<div class="small sub" style="padding:8px">No segment contains “${esc(q.value)}”.</div>`; $(`#tc-${CSS.escape(mid)}`).textContent = q.value.trim() ? `${r.segments.length} of ${r.total_segments} segment(s) match` : `${r.total_segments} segment(s)`; bindSegs(); } catch (e) { fail(e); } }, 250); }; }
  const evb = box.querySelector("[data-tev]");
  if (evb) evb.onclick = async () => {
    const ids = [...box.querySelectorAll("[data-tsel]:checked")].map(x => Number(x.dataset.tsel));
    const r = await modal("Add transcript passage as evidence", `<p class="small">${ids.length} segment(s) will be recorded as an observation, quoting the current text with the recording's timestamps. It is marked as coming from a machine transcript.</p>
      <label class="f" for="tevc">Link to claim (optional)</label><select id="tevc"><option value="">None</option>${claims.map(x => `<option value="${esc(x.id)}">${esc(x.id)} · ${esc(x.text.slice(0, 90))}</option>`).join("")}</select>
      <label class="f" for="tevs">The passage…</label><select id="tevs"><option value="context">gives context</option><option value="supports">supports the claim</option><option value="contradicts">contradicts the claim</option></select>`,
      [{ label: "Cancel", value: null }, { label: "Add evidence", kind: "primary", value: el => ({ claim_id: $("#tevc", el).value || null, stance: $("#tevs", el).value }) }]);
    if (!r.value) return;
    try { const e = await api.post(`/api/transcripts/${t.id}/evidence`, { segment_ids: ids, ...r.value }); toast(`Added as evidence ${e.id}.`); await reload(); } catch (e) { fail(e); }
  };
}

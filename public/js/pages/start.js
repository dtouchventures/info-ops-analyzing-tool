// New investigation, step 1 of 4: one box for text or a link, plus files. One button starts the case and the
// automatic checks; the case then opens at step 2. Uses the same server calls as Verify information and New case.
import { api } from "../api.js";
import { App, crumbs, refreshNavCounts } from "../app.js";
import { $, esc, toast, kb } from "../ui.js";
import { recognise } from "../lib/ocr.js";
import { parseSourceLink } from "/shared/text.js";
import { STEP_NAMES } from "./steps.js";
import { extractAttachedText, readPdfText } from '../lib/automatic-extraction.js';

const SOCIAL = ["X (Twitter)", "Facebook", "Instagram", "TikTok", "YouTube", "Telegram", "Threads", "LinkedIn", "WhatsApp", "Reddit"];
// a clearly labelled, invented example for practice (becomes a training case)
export const SYNTHETIC_EXAMPLE = "SYNTHETIC PRACTICE CASE (invented, not a real post): Soldiers from an army base near Garissa were seen selling relief food at the market last night. The county commissioner confirmed the food was meant for flood victims. Share this before it is deleted!";

export async function render(el) {
  if (!App.can("case.create")) { el.innerHTML = `<div class="callout warn"><div>Your role can read cases but cannot start new ones.</div></div>`; return; }
  crumbs(`<b>New investigation</b>${App.training ? " · training records" : ""}`);
  let files = [], ocrs = [], pSrc = "", looked = null, lookFor = "", lookP = null, lookT = 0;
  el.innerHTML = `<div class="ghead"><h1 style="margin:0 0 4px">New investigation</h1><p class="small sub" style="margin:0">Four steps. Your work is saved as you go, so you can stop and come back.</p>
      <ol class="gsteps">${STEP_NAMES.map((n, i) => `<li class="${i === 0 ? "cur" : ""}"><span><i>${i + 1}</i> ${n}</span></li>`).join("")}</ol></div>
    <div class="card"><div class="bd">
      <label class="f" for="si" style="margin-top:0">Text or link <span id="sDet" class="chip teal" hidden></span></label>
      <textarea id="si" rows="7" maxlength="20000" placeholder="Paste the post, message or article text, or one link (https://…)"></textarea>
      <div class="gmiss" id="siMiss" hidden></div><div class="hint" id="siHint">AIVS keeps the original exactly as received and splits it into claims for you to check.</div>
      <div id="ptBox" hidden>
        <div class="xprev" id="xPrev" aria-live="polite"></div>
        <label class="f" for="pt" id="ptLab">Words of the post</label><textarea id="pt" rows="5" placeholder="Filled in automatically when the platform shares them. Otherwise paste them, or add a screenshot and AIVS reads it."></textarea><div id="ptMsg" class="small" aria-live="polite"></div></div>
      <label class="f">Files <span class="sub">(optional)</span></label>
      <div class="dropzone" id="sdz" tabindex="0" role="button" aria-label="Add files"><b>Drop pictures, video, voice notes or documents</b><div class="small muted">or <u>choose files</u>, or paste a screenshot (Ctrl+V)</div><input type="file" id="sfi" multiple hidden></div>
      <ul class="uplist" id="sfl"></ul>
      <label class="small" style="display:block;margin-top:12px"><input type="checkbox" id="sAuto" checked> Automatically generate a dated fact-checking report (no analyst comments required)</label>
      <label class="small" style="display:block;margin-top:8px"><input type="checkbox" id="sAI"> Send the case's text, OCR and evidence to the configured AI service for analysis</label>
      <details style="margin-top:12px"><summary class="small">Options</summary><div class="grid g2" style="margin-top:6px">
        <div><label class="f" for="st">Title</label><input type="text" id="st" maxlength="200" placeholder="AIVS suggests one"></div>
        <div><label class="f" for="sp">Priority</label><select id="sp"><option value="routine">Routine</option><option value="priority">Priority</option><option value="urgent">Urgent</option></select></div></div>
        <label class="small" style="display:block;margin-top:8px"><input type="checkbox" id="sx" ${(App.meta.search || []).some(s => s.sends_to && s.configured) ? "checked" : "disabled"}> Also search published fact-checks outside AIVS${(App.meta.search || []).some(s => s.sends_to && s.configured) ? "" : " (not configured on this server)"}</label></details>
      ${App.training ? `<div class="callout train" style="margin-top:12px"><div>Training records are shown: this becomes a training case (TR-…), kept apart from real cases.</div></div>` : ""}
      <div id="serr" class="callout bad" style="margin-top:12px" hidden></div>
      <div class="gnav"><button class="btn ghost sm" id="sEx" type="button">Try a synthetic example</button><div class="row"><span id="sprog" class="small sub" aria-live="polite"></span><button class="btn primary" id="sGo">Analyze content</button></div></div>
    </div></div>`;
  const input = $("#si"), err = $("#serr"), miss = $("#siMiss");
  const linkOf = () => { const v = input.value.trim(); return /^https?:\/\/\S+$/i.test(v) ? parseSourceLink(v) : null; };
  const social = () => { const L = linkOf(); return L && SOCIAL.includes(L.platform) ? L : null; };
  const onInput = () => { const L = social(), W = linkOf(), link = !!W; $("#ptBox").hidden = !link; miss.hidden = true;
    const det = $("#sDet"); det.hidden = !link; if (link) det.textContent = L ? `${L.platform} link detected` : `Web page: ${W.platform.replace(/ \(website\)$/, "")}`;
    $("#ptLab").textContent = L || !link ? "Words of the post" : "Text of the page";
    if (!link) { $("#xPrev").innerHTML = ""; lookFor = ""; }
    clearTimeout(lookT); if (link && input.value.trim() !== lookFor) lookT = setTimeout(lookup, 500);
    $("#siHint").textContent = L ? `A ${L.platform} link. AIVS fetches the post's content through ${L.platform}'s official services where they allow it. Add a screenshot if you have one.` : link ? "A web page: AIVS retrieves it once, keeps an unchanged copy with its fingerprint, and reads its text and date." : "AIVS keeps the original exactly as received and splits it into claims for you to check."; };
  input.addEventListener("input", onInput);
  $("#sEx").onclick = () => { try { sessionStorage.setItem("aivs-start-example", "1"); } catch {} if (!App.training) { App.setScope("training"); App.go("#/start"); toast("Training records: the synthetic example becomes a training case."); } else render(el); };
  try { if (sessionStorage.getItem("aivs-start-example") === "1") { sessionStorage.removeItem("aivs-start-example"); input.value = SYNTHETIC_EXAMPLE; onInput(); } } catch {}
  // look the link up through the platform's public embed and fill in the words of the post
  const ptx = $("#pt"), pmsg = $("#ptMsg");
  ptx.addEventListener("input", () => { pSrc = ptx.value.trim() ? "typed" : ""; });
  const xp = $("#xPrev"), TS = { full: ["sup", "Full text"], partial: ["warn", "Possibly shortened"], title: ["warn", "Title only"], none: ["con", "No text"] };
  const when = (iso, basis) => iso ? `${esc(new Date(iso).toLocaleString())}${basis ? ` <span class="tiny sub">(${esc(basis)})</span>` : ""}` : "";
  function preview(r) {
    const ok = !!r.text, [cls, lab] = TS[r.text_status || "none"] || TS.none, src = r.permalink || r.resolved_url || r.final_url || r.normalized_url || r.url;
    const rows = [["Platform", esc(r.platform || "")], ["Author", esc([r.author_name, r.account].filter(Boolean).join(" · "))], ["Site", r.kind === "web" ? esc(r.site || "") : ""], ["Title", esc(r.title || "")],
      ["Posted", when(r.posted_at, r.posted_basis)], ["Source", src ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(src.length > 70 ? src.slice(0, 70) + "…" : src)}</a>` : ""],
      ["Text", `<span class="chip ${cls}">${lab}</span>${r.text_source ? ` <span class="tiny sub">from ${esc(r.text_source)}</span>` : ""}`],
      ["Metrics", r.metrics ? esc(Object.entries(r.metrics).filter(([, v]) => v != null).map(([k, v]) => `${k} ${Number(v).toLocaleString()}`).join(" · ")) : ""]].filter(([, v]) => v);
    xp.innerHTML = `<div class="xhead ${ok ? "ok" : "bad"}"><b>${ok ? (r.text_status === "full" ? "Content retrieved" : "Content partly retrieved") : "Content not retrieved"}</b><button class="btn sm ghost" type="button" id="xRetry">Retry</button></div>
      ${r.message ? `<div class="small ${ok ? "sub" : ""}" style="margin:4px 0">${esc(r.message)}</div>` : ""}
      <dl class="xmeta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${r.transcript?.note ? `<div class="tiny sub">${esc(r.transcript.note)}</div>` : ""}
      ${(r.needs || []).length ? `<div class="tiny" style="margin-top:4px"><b>An administrator can add:</b> ${r.needs.map(n => `<code>${esc(n.setting)}</code>: ${esc(n.why)}`).join("; ")}</div>` : ""}
      ${(r.attempts || []).length ? `<details class="tiny" style="margin-top:4px"><summary>How AIVS tried</summary><ul>${r.attempts.map(a => `<li>${esc(a.method)}: <b>${esc(a.result)}</b>${a.detail ? ` (${esc(a.detail)})` : ""}</li>`).join("")}</ul></details>` : ""}`;
    $("#xRetry").onclick = () => { lookFor = ""; lookup(); };
  }
  function lookup() {
    const v = input.value.trim(), L = social(), W = linkOf(); if (!W || v === lookFor) return lookP;
    lookFor = v; looked = null; if (pSrc === "embed") { ptx.value = ""; pSrc = ""; }   // words retrieved for another link
    pmsg.textContent = ""; xp.innerHTML = `<div class="xhead"><span><span class="spin"></span> ${L ? "Fetching post content…" : "Fetching the page…"}</span></div>`;
    lookP = api.post("/api/extract", { url: v }).then(r => {
      if (input.value.trim() !== v) return;
      looked = r; preview(r);
      if (r.text) {
        if (!ptx.value.trim() || pSrc === "embed") { ptx.value = r.text; pSrc = "embed"; pmsg.className = "gnote"; pmsg.textContent = `Filled in from ${r.text_source}. You can edit it. Check it against the ${L ? "post" : "page"}.`; }
        else { pmsg.className = "gnote"; pmsg.innerHTML = `${esc(r.platform)} returned the words, but you have already typed some. <button class="btn sm" type="button" id="ptUse">Use the retrieved words</button>`; $("#ptUse").onclick = () => { ptx.value = r.text; pSrc = "embed"; pmsg.textContent = `Filled in from ${r.text_source}. Check it against the post.`; }; }
      } else if (!ptx.value.trim()) {
        pmsg.className = "gmiss"; pmsg.textContent = L ? "Add a screenshot of the post below and AIVS reads the words from it, or paste them here." : "Paste the text of the page here.";
      } else { pmsg.textContent = ""; }
    }).catch(e => { if (input.value.trim() === v) { lookFor = ""; preview({ platform: (L || W).platform, text: null, text_status: "none", message: `The lookup failed (${e.message}). Retry, paste the words, or add a screenshot.` }); } });
    return lookP;
  }
  // files
  const dz = $("#sdz"), fi = $("#sfi");
  const show = () => { $("#sfl").innerHTML = files.map((f, i) => `<li><div class="ph">${esc((f.type.split("/")[0] || "file").toUpperCase())}</div><div style="min-width:0"><b class="small">${esc(f.name)}</b> <span class="tiny sub">${kb(f.size)}</span></div><button class="btn sm ghost" data-rmf="${i}" style="margin-left:auto">Remove</button></li>`).join("");
    el.querySelectorAll("[data-rmf]").forEach(b => b.onclick = () => { files.splice(+b.dataset.rmf, 1); ocrs.splice(+b.dataset.rmf, 1); show(); }); };
  const add = async list => {
    for (const f of list) { if (f.size > App.meta.maxUploadMb * 1048576) { toast(`${f.name} is larger than ${App.meta.maxUploadMb} MB.`, "err"); continue; } files.push(f); }
    show();
    // no text yet: read it from the first document or picture, for the analyst to check
    if (social() && !ptx.value.trim()) { const i = files.findIndex(f => f.type.startsWith("image/")); if (i >= 0) await readPostFrom(i); }
    else if (!input.value.trim() && files.length) await readTextFrom(files[0]);
  };
  // a screenshot of a social post: read its words into "Words of the post"
  async function readPostFrom(i) {
    const f = files[i], langs = App.meta.ocr || [], prog = $("#sprog"); if (!langs.length) return;
    try {
      pmsg.className = "small sub"; pmsg.textContent = `Reading the words in ${f.name}…`;
      const lang = langs.length > 1 ? "eng+swa" : langs[0].code, o = await recognise(f, lang, p => (pmsg.textContent = `Reading the words in ${f.name}… ${Math.round(p * 100)}%`));
      if (o.text?.trim() && !ptx.value.trim()) { ptx.value = o.text.trim(); pSrc = "ocr"; ocrs[i] = { text: o.text, lang, confidence: o.confidence }; pmsg.className = "gnote"; pmsg.textContent = `Read from ${f.name}. Check it against the screenshot and correct any reading mistakes.`; }
      else if (!o.text?.trim()) { pmsg.className = "gmiss"; pmsg.textContent = `No words could be read from ${f.name}. Type them in.`; }
    } catch { pmsg.textContent = ""; } finally { prog.textContent = ""; }
  }
  async function readTextFrom(f) {
    const prog = $("#sprog");
    try {
      let text = "";
      if (f.type.startsWith("image/")) { const langs = App.meta.ocr || []; if (!langs.length) return; prog.textContent = `Reading the text in ${f.name}…`; text = (await recognise(f, langs.length > 1 ? "eng+swa" : langs[0].code, p => (prog.textContent = `Reading the text in ${f.name}… ${Math.round(p * 100)}%`))).text; }
      else if (/\.(pdf|docx|txt|csv|json)$/i.test(f.name)) {
        prog.textContent = `Reading ${f.name}…`; const fd = new FormData(); fd.append("file", f, f.name); const r = await api.upload("/api/extract-text", fd); text = r.text || "";
        if (/\.pdf$/i.test(f.name) && (r.scanned || !text.trim())) text = (await readPdfText(f, App.meta.ocr || [], p => { prog.textContent = `Reading scanned pages… ${Math.round(p * 100)}%`; })).text;
      }
      if (text.trim()) { input.value = text.trim(); onInput(); miss.hidden = false; miss.className = "gnote"; miss.textContent = `Text read from ${f.name}. Check it against the file and correct any reading mistakes before you start.`; }
    } catch (e) { miss.hidden = false; miss.className = 'gmiss'; miss.textContent = `Text extraction failed for ${f.name}: ${e.message}. Paste the text or retry the file.`; } finally { prog.textContent = ""; }
  }
  dz.onclick = () => fi.click(); dz.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
  dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); }; dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove("over"); add([...e.dataTransfer.files]); }; fi.onchange = () => { add([...fi.files]); fi.value = ""; };
  const onPaste = e => { if (!el.isConnected) return document.removeEventListener("paste", onPaste); const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); add(fs.map(f => new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.png`, { type: f.type }))); } };
  document.addEventListener("paste", onPaste);

  $("#sGo").onclick = async () => {
    const v = input.value.trim(), L = social(), b = $("#sGo"), prog = $("#sprog"); err.hidden = true;
    if (!v && !files.length) { miss.className = "gmiss"; miss.hidden = false; miss.textContent = "Paste the text or a link, or add a file."; input.focus(); return; }
    if (L && !$("#pt").value.trim() && lookP) { prog.textContent = "Waiting for the post lookup…"; await lookP; prog.textContent = ""; }
    if (L && !$("#pt").value.trim() && !files.some(f => f.type.startsWith("image/"))) { pmsg.className = "gmiss"; pmsg.textContent = "AIVS needs the words of the post. Paste them here, or add a screenshot of the post and AIVS reads them."; $("#pt").focus(); return; }
    if (!L && linkOf() && lookP) { prog.textContent = "Waiting for the page…"; await lookP; prog.textContent = ""; }
    if (!v && !L) { miss.className = "gmiss"; miss.hidden = false; miss.textContent = "AIVS needs the words to check. Type or paste them (the text of the post, or its main claim)."; input.focus(); return; }
    b.disabled = true; b.innerHTML = '<span class="spin"></span> Starting…';
    try {
      let id;
      if (L) {
        const fd = new FormData(); fd.append("url", v); fd.append("text", $("#pt").value.trim()); fd.append("text_source", pSrc === "ocr" ? "ocr-edited" : pSrc); fd.append("priority", $("#sp").value); fd.append("is_training", String(App.training)); fd.append("search", String(!$("#sAuto").checked && $("#sx").checked));
        if ($("#st").value.trim()) fd.append("title", $("#st").value.trim());
        files.forEach((f, i) => { fd.append("files", f, f.name); if (ocrs[i]) fd.append(`ocr_${i}`, JSON.stringify(ocrs[i])); });
        prog.textContent = "Reading the post and saving the files…";
        id = (await api.upload("/api/verify/post", fd)).id;
      } else {
        prog.textContent = /^https?:\/\//i.test(v) ? "Retrieving the page…" : "Saving…";
        id = (await api.post("/api/verify", { input: v, text: linkOf() && ptx.value.trim() ? ptx.value.trim() : undefined, title: $("#st").value.trim() || undefined, priority: $("#sp").value, is_training: App.training, search: !$("#sAuto").checked && $("#sx").checked })).id;
        if (files.length) {
          for (const f of files) { prog.textContent = `Uploading ${f.name}…`; const fd = new FormData(); fd.append("files", f, f.name); await api.upload(`/api/cases/${id}/media`, fd); }
          // run the checks again once the first run has finished, so the files are compared too
          prog.textContent = "Checking the files…";
          for (let i = 0; i < 60; i++) { const s = (await api.get(`/api/cases/${encodeURIComponent(id)}`)).case.status; if (s !== "analysing") break; await new Promise(r => setTimeout(r, 1000)); }
          await api.post(`/api/cases/${id}/analyse`);
        }
      }
      if ($("#sAuto").checked) {
        prog.textContent = 'Preparing text extraction…';
        let saved;
        for (let i = 0; i < 120; i++) {
          saved = await api.get(`/api/cases/${encodeURIComponent(id)}`);
          if (saved.case.status !== 'analysing') break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        for (const media of saved.media.filter(m => !saved.ocr.some(o => o.media_id === m.id) && (m.kind === 'image' || m.kind === 'document' && /pdf/.test(m.mime)))) {
          try { await extractAttachedText(media, App.meta.ocr || [], p => { prog.textContent = `Reading ${media.original_name}… ${Math.round(p * 100)}%`; }); }
          catch (e) { toast(`Text extraction for ${media.original_name}: ${e.message}`, 'err'); }
        }
        await api.post(`/api/cases/${encodeURIComponent(id)}/automatic-report`, { search_external: $("#sx").checked, confirm_external: $("#sAI").checked });
        refreshNavCounts(); App.go(`#/case/${encodeURIComponent(id)}/automatic`);
      } else {
        refreshNavCounts(); toast(`Investigation ${id} started.`); App.go(`#/case/${encodeURIComponent(id)}`);
      }
    } catch (e) {
      b.disabled = false; b.textContent = "Analyze content"; prog.textContent = "";
      if (L && /needs the words of the post/i.test(e.message)) { $("#ptBox").hidden = false; pmsg.className = "gmiss"; pmsg.textContent = `${e.message.replace(/^The case needs the words of the post\.\s*/, "") || `${L.platform} did not give AIVS the words of this post.`} Paste them here, or add a screenshot.`; $("#pt").focus(); return; }
      err.hidden = false; err.innerHTML = `<div>${esc(e.message)}</div>`;
    }
  };
  input.focus();
}

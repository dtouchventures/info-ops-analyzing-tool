// Guided submission: 1 details → 2 media → 3 review and start analysis.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, toast, fail, kb, toLocalInput, fromLocalInput, confirmBox } from "../ui.js";
import { sampleFrames } from "../lib/video.js";
import { recognise } from "../lib/ocr.js";
import { extractClaims, suggestSource } from "/shared/text.js";

// read a PDF's text layer in the browser (used when the server cannot read it)
async function pdfInBrowser(f, note) {
  note.innerHTML = `<div><span class="spin"></span> Reading ${esc(f.name)} in this browser…</div>`;
  const pdfjs = await import("/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()), isEvalSupported: false }).promise, pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 300); i++) { const tc = await (await doc.getPage(i)).getTextContent(); pages.push(tc.items.map(x => x.str + (x.hasEOL ? "\n" : " ")).join("").trim()); }
  const text = pages.join("\n\n").trim(), scanned = pages.filter(p => p.replace(/\s/g, "").length < 10).length >= Math.ceil(pages.length / 2);
  return { text: text.slice(0, 20000), truncated: text.length > 20000, pages: doc.numPages, warnings: ["Read in your browser because the server could not read this PDF."], scanned };
}
export async function render(el) {
  if (!App.can("case.create")) { el.innerHTML = `<div class="callout warn"><div>Your role cannot create cases.</div></div>`; return; }
  crumbs(`<a href="#/cases">Cases</a> / <b>New case</b>`);
  let caseId = null, uploaded = [], pending = [];   // pending: the file the text was taken from, attached automatically in step 2
  const steps = ["1. Claim and source", "2. Media", "3. Review and start"];
  const head = n => `<div class="wizard">${steps.map((s, i) => `<div class="${i === n ? "on" : i < n ? "done" : ""}">${s}</div>`).join("")}</div>`;

  function step1() {
    el.innerHTML = `<div class="pagehead"><div><h1>New case</h1><p>Record the content exactly as received. Only the text is needed: paste it, or take it from a document or screenshot. AIVS fills in what it can, and you can correct anything.</p></div></div>${head(0)}
    ${App.training ? `<div class="callout train" style="margin-bottom:14px"><div><b>Training mode.</b> This will be a training case (TR-…), kept apart from operational records.</div></div>` : ""}
    <form class="card" id="f1" novalidate><div class="bd">
      <label class="f" for="su">Link to the post or article <span class="sub" style="font-weight:400">(optional)</span></label><input type="url" id="su" placeholder="https://x.com/…/status/…, a Facebook, TikTok, Telegram or news link, or a message reference">
      <div class="hint">AIVS reads the platform, account and (for X and TikTok links) the posting time from the link itself. To retrieve and archive a web page, use Verify information.</div>
      <label class="f" for="cl">Post or report text, exactly as received <span class="req">*</span></label><textarea id="cl" rows="5" placeholder="Paste the full text. Do not correct spelling or remove anything."></textarea>
      <div class="row" style="margin-top:6px"><span class="small muted">No text to paste?</span><button type="button" class="btn sm" id="fromFile">Take the text from a file</button><span class="tiny sub">PDF, Word (.docx), TXT or a screenshot</span><input type="file" id="ff" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/*" hidden></div>
      <div id="ffNote" class="callout info" style="margin-top:8px" hidden></div>
      <div class="hint" id="clHint"></div>
      <div id="autonote" class="callout info" style="margin-top:10px" hidden></div>
      <details id="more" style="margin-top:14px"><summary><b>Source details and dates</b> <span class="small sub">— optional; filled automatically where possible</span></summary>
      <div class="grid g3">
        <div><label class="f" for="sp">Where it was seen</label><input type="text" id="sp" list="platforms" placeholder="Platform, channel or outlet"><datalist id="platforms"><option>X (Twitter)</option><option>Facebook</option><option>WhatsApp forward</option><option>Telegram channel</option><option>TikTok</option><option>Instagram</option><option>YouTube</option><option>News website</option></datalist></div>
        <div><label class="f" for="sa">Account or author</label><input type="text" id="sa" placeholder="@handle, page or sender"></div>
        <div><label class="f" for="ht">Hashtags</label><input type="text" id="ht" placeholder="#example #another"></div>
      </div>
      <div class="grid g3">
        <div><label class="f" for="ra">Received by you</label><input type="datetime-local" id="ra" value="${toLocalInput(new Date().toISOString())}"><div class="hint">When the content reached the team.</div></div>
        <div><label class="f" for="pa">Published (per the source)</label><input type="datetime-local" id="pa"><input type="text" id="pb" placeholder="How do you know? e.g. post timestamp" style="margin-top:6px"></div>
        <div><label class="f" for="ea">Event date the content claims</label><input type="datetime-local" id="ea"><input type="text" id="eb" placeholder="e.g. post says “last night”" style="margin-top:6px"></div>
      </div>
      <div class="grid g3"><div><label class="f" for="t">Case title</label><input type="text" id="t" maxlength="200" placeholder="Made from the text if left empty"></div>
        <div><label class="f" for="pr">Priority</label><select id="pr"><option value="routine">Routine</option><option value="priority">Priority</option><option value="urgent">Urgent</option></select></div></div></details>
      <div id="err1" class="callout bad" style="margin-top:14px" hidden></div>
    </div><div class="bd" style="border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end"><a class="btn" href="#/cases">Cancel</a><button class="btn primary" id="n1">Save and add media</button></div></form>`;
    // fill empty fields from the link and the text; never overwrite what the analyst typed
    const F = { sp: "platform", sa: "account", su: "url", pa: "published", pb: "published_basis", ea: "event", eb: "event_basis", ht: "hashtags" };
    const LABEL = { sp: "where it was seen", sa: "account", su: "link", pa: "published date", ea: "event date", ht: "hashtags" };
    for (const id of Object.keys(F)) $("#" + id).addEventListener("input", e => { if (e.isTrusted) { delete $("#" + id).dataset.auto; $("#" + id).classList.remove("autofilled"); } });
    function autofill() {
      if (!$("#f1")) return;
      const g = suggestSource({ text: $("#cl").value, url: $("#su").value.trim() });
      const val = { platform: g.platform, account: g.account, url: !$("#su").value.trim() ? g.url : null, published: g.published_at ? toLocalInput(g.published_at) : null, published_basis: g.published_at ? g.published_basis : null,
        event: g.event?.at ? toLocalInput(g.event.at) : null, event_basis: g.event?.basis || null, hashtags: g.hashtags.length ? g.hashtags.join(" ") : null };
      const filled = [];
      for (const [id, k] of Object.entries(F)) {
        const x = $("#" + id), auto = x.dataset.auto === "1";
        if (x.value.trim() && !auto) continue;
        const v = val[k] || "";
        if (v) { x.value = v; x.dataset.auto = "1"; x.classList.add("autofilled"); if (LABEL[id]) filled.push(LABEL[id]); }
        else if (auto) { x.value = ""; delete x.dataset.auto; x.classList.remove("autofilled"); }
      }
      const n = $("#autonote");
      if (filled.length) { n.hidden = false; n.innerHTML = `<div>Filled automatically: <b>${esc(filled.join(", "))}</b>. Fields marked in blue below were filled by AIVS; check them and change anything that is wrong.${g.published_at ? " The posting time comes from the post ID in the link, not from the post's own page." : ""}</div>`; $("#more").open = true; }
      else n.hidden = true;
    }
    let tm; const sched = () => { clearTimeout(tm); tm = setTimeout(autofill, 250); };
    $("#su").addEventListener("input", sched); $("#cl").addEventListener("input", sched);
    const hint = () => { const n = extractClaims($("#cl").value, false).length; $("#clHint").textContent = $("#cl").value.trim() ? `About ${n} checkable claim${n === 1 ? "" : "s"} detected. You can split, merge and edit claims after analysis.` : ""; };
    $("#cl").addEventListener("input", hint); $("#su").focus();
    $("#fromFile").onclick = () => $("#ff").click();
    $("#ff").onchange = async () => {
      const f = $("#ff").files[0]; if (!f) return; $("#ff").value = "";
      if ($("#cl").value.trim() && !(await confirmBox("Replace the text?", "The text box already has text. Replace it with the text from this file?", "Replace"))) return;
      const note = $("#ffNote"), b = $("#fromFile"); note.hidden = false; b.disabled = true; note.innerHTML = `<div><span class="spin"></span> Reading ${esc(f.name)}…</div>`;
      try {
        let text = "", extra = "";
        if (f.type.startsWith("image/")) {
          const langs = App.meta.ocr || []; if (!langs.length) throw new Error("Text reading (OCR) is not installed on this server.");
          const r = await recognise(f, langs.length > 1 ? "eng+swa" : langs[0].code, p => (note.innerHTML = `<div><span class="spin"></span> Reading ${esc(f.name)}: ${Math.round(p * 100)}%</div>`));
          text = r.text; extra = ` Read with OCR (confidence ${Math.round(r.confidence)}%): names, numbers and small print are often misread.`;
        } else {
          const fd = new FormData(); fd.append("file", f, f.name); let r;
          try { r = await api.upload("/api/extract-text", fd); }
          catch (e) { if (!/\.pdf$/i.test(f.name) || /password/i.test(e.message)) throw e; r = await pdfInBrowser(f, note); }   // fallback: read the PDF in this browser
          if (r.scanned || !r.text) { pending = [f]; note.className = "callout warn"; note.innerHTML = `<div><b>${esc(f.name)} has no text layer</b> (it looks scanned). It will be attached in the next step; then open it in the case and use <b>Read text from pages (OCR)</b>. Meanwhile, type a short description of what it says above.</div>`; return; }
          text = r.text; extra = `${r.pages ? ` ${r.pages} page${r.pages > 1 ? "s" : ""}.` : ""}${r.truncated ? " Only the first 20,000 characters were put in the box; the whole document stays attached." : ""}${r.warnings.length ? ` Note: ${r.warnings.map(esc).join(" ")}` : ""}`;
        }
        if (!text.trim()) throw new Error("No text was found in this file.");
        $("#cl").value = text.trim(); $("#cl").dispatchEvent(new Event("input")); pending = [f];
        note.className = "callout info"; note.innerHTML = `<div><b>Text taken from ${esc(f.name)}.</b> Check it against the original and correct reading mistakes before saving.${extra} The file itself will be attached to the case in the next step, unchanged.</div>`;
      } catch (e) { note.className = "callout bad"; note.innerHTML = `<div>${esc(e.message)}</div>`; }
      finally { b.disabled = false; }
    };
    $("#f1").onsubmit = async e => {
      e.preventDefault(); clearTimeout(tm);
      const body = { title: $("#t").value.trim() || null, claim_text: $("#cl").value, source_platform: $("#sp").value.trim() || null, source_account: $("#sa").value.trim() || null, source_url: $("#su").value.trim() || null, hashtags: $("#ht").value,
        received_at: fromLocalInput($("#ra").value) || new Date().toISOString(), published_at: fromLocalInput($("#pa").value), published_basis: $("#pb").value.trim() || null, claimed_event_at: fromLocalInput($("#ea").value), claimed_event_basis: $("#eb").value.trim() || null,
        priority: $("#pr").value, is_training: App.training };
      if (!body.claim_text.trim()) { $("#err1").hidden = false; $("#err1").textContent = body.source_url ? "Paste the text of the post as well, or use Verify information to retrieve a web page from its link." : "Paste the text of the post or report, or use “Take the text from a file”."; $("#cl").focus(); return; }
      if (body.published_at && !body.published_basis) body.published_basis = "entered by the analyst";
      if (!body.title) delete body.title;
      const b = $("#n1"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Saving…';
      try { caseId = (await api.post("/api/cases", body)).id; toast(`Case ${caseId} created as a draft.`); step2(); }
      catch (er) { $("#err1").hidden = false; $("#err1").textContent = er.message; b.disabled = false; b.textContent = "Save and add media"; }
    };
  }

  function step2() {
    crumbs(`<a href="#/cases">Cases</a> / <b>${esc(caseId)}</b> / media`);
    el.innerHTML = `<div class="pagehead"><div><h1>Add media to ${esc(caseId)}</h1><p>Images and video are stored unchanged. Each file is fingerprinted with SHA-256 when it arrives.</p></div></div>${head(1)}
    <div class="card"><div class="bd">
      <div class="dropzone" id="dz" tabindex="0" role="button" aria-label="Add files"><b>Drop images, video or documents here</b><div class="small muted">or paste a screenshot (Ctrl+V), or <u>choose files</u> · images, video, PDF, Word (.docx), TXT · up to ${App.meta.maxUploadMb} MB each</div><input type="file" id="fi" multiple accept="image/*,video/*,.pdf,.docx,.txt,.csv,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden></div>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="auto" checked> For video, extract 6 evenly spaced frames automatically so they can be compared with the archive</label>
      <ul class="uplist" id="ul"></ul>
    </div><div class="bd" style="border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="skip">Continue without media</button><button class="btn primary" id="n2" disabled>Continue</button></div></div>`;
    const dz = $("#dz"), fi = $("#fi");
    dz.onclick = () => fi.click(); dz.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
    dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); }; dz.ondragleave = () => dz.classList.remove("over");
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove("over"); send([...e.dataTransfer.files]); };
    fi.onchange = () => send([...fi.files]);
    const onPaste = e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); send(fs.map(f => f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now()}.png`, { type: f.type }))); } };
    document.addEventListener("paste", onPaste); const off = () => document.removeEventListener("paste", onPaste);
    $("#skip").onclick = () => { off(); step3(); }; $("#n2").onclick = () => { off(); step3(); };
    if (pending.length) { const p = pending; pending = []; setTimeout(() => send(p), 0); }   // the file the text came from
    async function send(files) {
      for (const f of files) {
        const li = document.createElement("li"), isImg = f.type.startsWith("image/");
        li.innerHTML = `${isImg ? `<img alt="">` : `<div class="ph">${f.type.startsWith("video") ? "VIDEO" : "DOC"}</div>`}<div style="min-width:0"><b class="small">${esc(f.name)}</b> <span class="tiny sub">${kb(f.size)}</span><div class="progress" style="margin-top:6px"><div style="width:0%"></div></div><div class="tiny sub st">Uploading…</div></div><span></span>`;
        if (isImg) li.querySelector("img").src = URL.createObjectURL(f);
        $("#ul").appendChild(li);
        const bar = li.querySelector(".progress > div"), st = li.querySelector(".st");
        if (f.size > App.meta.maxUploadMb * 1048576) { st.textContent = `Too large: the limit is ${App.meta.maxUploadMb} MB.`; st.style.color = "var(--con)"; continue; }
        const fd = new FormData(); fd.append("files", f, f.name);
        try {
          const r = await api.upload(`/api/cases/${caseId}/media`, fd, p => (bar.style.width = `${Math.round(p * 100)}%`));
          if (!r.media?.length) throw new Error((r.errors || []).join(" ") || "Upload failed.");
          const m = r.media[0]; uploaded.push(m); bar.style.width = "100%";
          st.innerHTML = `Stored as <b>${esc(m.id)}</b> · SHA-256 <span class="mono">${esc(m.sha256.slice(0, 16))}…</span>${m.identicalTo.length ? ` · <span class="chip warn">Identical file already held (${m.identicalTo.map(x => esc(x.case_id || x.archive_id)).join(", ")})</span>` : ""}`;
          if (m.kind === "video" && $("#auto").checked) {
            st.insertAdjacentHTML("beforeend", `<div class="fr">Extracting frames…</div>`);
            try { const n = await sampleFrames(m.id, `/api/media/${m.id}/content`, 6, p => (li.querySelector(".fr").textContent = `Extracting frames… ${Math.round(p * 100)}%`)); li.querySelector(".fr").textContent = `${n} frames extracted with their timestamps.`; }
            catch (e) { li.querySelector(".fr").innerHTML = `<span style="color:var(--con)">${esc(e.message)}</span> You can capture frames manually in the case workspace.`; }
          }
          $("#n2").disabled = false;
        } catch (e) { st.textContent = e.message; st.style.color = "var(--con)"; bar.style.background = "var(--con)"; }
      }
    }
  }

  function step3() {
    el.innerHTML = `<div class="pagehead"><div><h1>Review and start</h1></div></div>${head(2)}
    <div class="card"><div class="bd">
      <p><b>${esc(caseId)}</b> is saved as a draft with ${uploaded.length} media file${uploaded.length === 1 ? "" : "s"}.</p>
      <div class="callout info"><div><b>What local analysis does.</b> On this server only: splits the text into checkable claims, compares images and frames with the reference archive and with other cases, reads embedded metadata, and lists leads for you to accept or dismiss. Nothing is sent outside the system.</div></div>
    </div><div class="bd" style="border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <a class="btn" href="#/case/${esc(caseId)}">Open draft without analysing</a><button class="btn primary" id="go">Start local analysis</button></div></div>`;
    $("#go").onclick = async () => { try { await api.post(`/api/cases/${caseId}/analyse`); App.go(`#/case/${caseId}`); } catch (e) { fail(e); } };
  }
  step1();
}

// Automatic social media screenshot analysis (1.34): preview, what was read (observed / inferred / not available), the
// populated Social Media Analysis fields, live progress, the verdict, the KDF IO assessment draft and the HOD status.
// The analyst only uploads; corrections to the fields are optional and are recorded beside what AIVS produced.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, toast, fail, errMsg } from "../ui.js";

let timer = null;
const BASIS = { observed: ["Observed", "sup", "read directly from the screenshot"], inferred: ["Inferred", "unr", "worked out by AIVS from what is visible; may be wrong"],
  not_available: ["Not available", "grey", "not shown in the screenshot; nothing was guessed"], generated: ["Generated", "train", "written by AIVS from the record"], analyst: ["Analyst", "con", "corrected by the analyst"] };
const chip = b => { const x = BASIS[b] || [b, "grey", ""]; return `<span class="chip ${x[1]}" title="${esc(x[2])}">${esc(x[0])}</span>`; };
const val = f => f?.value == null ? `<span class="muted">Not available</span>` : Array.isArray(f.value) ? esc(f.value.join(" ")) : typeof f.value === "number" ? esc(f.value.toLocaleString("en-GB")) : esc(f.value);
const row = (label, f) => `<tr><th style="width:30%">${esc(label)}</th><td>${val(f)}${f?.note ? `<div class="tiny sub">${esc(f.note)}</div>` : ""}</td><td style="width:1%">${chip(f?.basis || "not_available")}</td></tr>`;
const VERDICT = { supported: ["Supported", "sup"], contradicted: ["False", "con"], misleading: ["Misleading", "con"], insufficient: ["Unverified — insufficient evidence", "unr"], mixed: ["Unverified — sources disagree", "unr"], not_verifiable: ["Not verifiable", "grey"], extraction_blocked: ["Content not readable", "grey"], insufficient_content: ["Insufficient content", "grey"] };
const icon = s => (s === "done" ? "✓" : s === "warning" ? "!" : s === "failed" ? "×" : s === "skipped" ? "–" : "");
const stageList = (list, offset = 0) => (list || []).map((s, i) => `<li class="${esc(s.status)}"><span class="dot">${icon(s.status)}</span><span>${i + 1 + offset}. ${esc(s.label || s.key)}${s.detail ? `<span class="tiny sub" style="display:block">${esc(s.detail)}</span>` : ""}</span></li>`).join("");

export async function render(el, [id]) {
  clearTimeout(timer);
  crumbs(`<a href="#/monitor">Social Media Analysis</a> › <b>Screenshot ${esc(id)}</b>`);
  el.innerHTML = `<div class="pagehead"><div><h1>Screenshot analysis <span class="mono small">${esc(id)}</span></h1><p>AIVS reads the screenshot, separates the main post from comments, advertisements and interface text, fills in the analysis fields and runs the full investigation automatically. Each detail says whether it was <b>observed</b> in the picture, <b>inferred</b> by AIVS, or is <b>not available</b>.</p></div></div>
    <div class="callout warn" style="margin-bottom:12px"><div><b>A screenshot is not proof.</b> It shows how a post looked to whoever captured it; it may be edited or fabricated. AIVS never treats the screenshot, or anything read from it, as evidence for a claim.</div></div>
    <div class="split"><div class="stack">
      <div class="card"><div class="hd"><h3>Progress</h3><span class="chip grey right" id="sStatus">…</span></div><div class="bd"><ol class="istages" id="sStages"></ol><ol class="istages" id="sInvStages" style="margin-top:6px"></ol><div id="sErr"></div></div></div>
      <div class="card" id="sResultCard" hidden><div class="hd"><h3>Result</h3></div><div class="bd" id="sResult"></div></div>
      <div class="card"><div class="hd"><h3>Main post identified</h3></div><div class="bd" id="sPost"><span class="spin"></span> Reading…</div></div>
      <div class="card"><div class="hd"><h3>Social Media Analysis fields (populated automatically)</h3></div><div class="bd" id="sForm"><span class="spin"></span> Waiting for the extraction…</div></div>
    </div><div class="stack">
      <div class="card"><div class="hd"><h3>Screenshot</h3></div><div class="bd"><img id="sImg" alt="Uploaded screenshot" style="max-width:100%;border:1px solid var(--line,#ddd);border-radius:6px" src="/api/screenshots/${encodeURIComponent(id)}/image"></div></div>
      <div class="card"><div class="hd"><h3>Also in the screenshot (excluded)</h3></div><div class="bd small" id="sExcluded">—</div></div>
      <div class="card"><div class="hd"><h3>Uncertainties</h3></div><div class="bd small" id="sUnc">—</div></div>
    </div></div>`;
  let formShown = false;
  const tick = async () => {
    if (!document.body.contains($("#sStages"))) return;
    let s; try { s = await api.get(`/api/screenshots/${encodeURIComponent(id)}`); } catch (e) { $("#sErr").innerHTML = `<div class="callout bad"><div>${esc(errMsg(e))}</div></div>`; return; }
    const inv = s.investigation, finished = s.status === "failed" || (s.status === "done" && inv && ["done", "failed"].includes(inv.status));
    $("#sStatus").textContent = s.status === "failed" ? "Failed" : !inv ? "Reading the screenshot" : inv.status === "done" ? "Completed" : inv.status === "failed" ? "Investigation failed" : "Investigating";
    $("#sStages").innerHTML = stageList(s.stages);
    $("#sInvStages").innerHTML = inv ? stageList(inv.stages, s.stages.length) : "";
    $("#sErr").innerHTML = s.error ? `<div class="callout bad"><div>${esc(s.error)}</div></div>` : inv?.error ? `<div class="callout bad"><div>${esc(inv.error)}</div></div>` : "";
    if (s.extraction) post(s);
    if (s.form && !formShown) { formShown = true; form(s); }
    if (inv?.status === "done") result(s);
    if (!finished) timer = setTimeout(tick, 1200);
  };
  tick();
}

function post(s) {
  const x = s.extraction, E = x.engagement;
  const eng = Object.entries(E).filter(([, v]) => v.value != null);
  $("#sPost").innerHTML = `<div class="tablewrap"><table class="t"><tbody>
    ${row("Apparent platform", x.platform)}${row("Account / page", x.account)}${row("Time shown", x.posted_text)}${row("Publication date", x.published_at)}
    ${row("Post text", x.text)}${row("Central narrative", x.central_narrative)}${row("Hashtags", x.hashtags)}${row("Mentions", x.mentions)}${row("Links visible", x.urls)}
    ${eng.length ? eng.map(([k, v]) => row(`Engagement: ${k}`, v)).join("") : row("Engagement", { value: null, basis: "not_available" })}
    ${row("Language", x.language)}
    <tr><th>Embedded media</th><td>${x.media.count ? `${x.media.count} picture region(s)` : `<span class="muted">Not available</span>`}<div class="tiny sub">${esc(x.media.note)}</div></td><td>${chip(x.media.basis)}</td></tr>
    <tr><th>Entities</th><td>${esc([...x.entities.places, ...x.entities.organisations, ...x.entities.dates, ...x.entities.numbers].join(" · ") || "none found")}</td><td>${chip("inferred")}</td></tr>
    <tr><th>Keywords · topic</th><td>${esc(x.keywords.join(", ") || "—")}${x.topic ? ` · ${esc(x.topic.label)}` : ""}</td><td>${chip("inferred")}</td></tr>
    <tr><th>KDF relevance</th><td>${x.kdf_relevance.relevant ? "Yes" : "Not indicated"}<div class="tiny sub">${esc(x.kdf_relevance.note)}</div></td><td>${chip("inferred")}</td></tr>
    <tr><th>Original post</th><td>${x.original ? (x.original.retrieved ? `Retrieved from the visible link (${esc(x.original.method)}); text similarity ${Math.round((x.original.similarity || 0) * 100)}%` : x.original.attempted ? `Not retrieved: ${esc(x.original.reason || "")}` : "No link visible: not independently retrieved") : "…"}</td><td>${chip(x.original?.retrieved ? "observed" : "not_available")}</td></tr>
    ${x.duplicates?.length ? `<tr><th>Similar earlier screenshots</th><td>${x.duplicates.map(d => `<a href="#/monitor/shot/${esc(d.id)}">${esc(d.id)}</a> (${Math.round(d.similarity * 100)}%${d.identical_file ? ", identical file" : ""})`).join(", ")}</td><td>${chip("inferred")}</td></tr>` : ""}
    </tbody></table></div><div class="tiny sub" style="margin-top:6px">OCR confidence ${esc(x.ocr_confidence)} of 100 · ${esc(x.width)}×${esc(x.height)} px</div>`;
  $("#sExcluded").innerHTML = `${x.multiple_posts ? `<p style="margin-top:0"><b>${x.posts.length} posts in the picture.</b> Only the main post is analysed.</p><ul style="margin:0 0 8px 18px">${x.posts.map(p => `<li>${p.main ? "<b>Main post</b>: " : p.advertisement ? "Advertisement: " : "Other post: "}${esc(p.account || "account not visible")}${p.time ? ` · ${esc(p.time)}` : ""} — ${esc(p.text.slice(0, 120))}</li>`).join("")}</ul>` : ""}
    ${x.comments.length ? `<p style="margin-top:0"><b>${x.comments.length} comment(s)</b> (not part of the post):</p><ul style="margin:0 0 8px 18px">${x.comments.map(c => `<li>${esc(c.author || "unnamed")}: ${esc(c.text.slice(0, 160))}</li>`).join("")}</ul>` : ""}
    ${x.interface_text_excluded.length ? `<p style="margin:0"><b>Interface text:</b> ${esc(x.interface_text_excluded.join(" · "))}</p>` : ""}` || "Nothing else.";
  $("#sUnc").innerHTML = `<ul style="margin:0 0 0 18px">${x.uncertainties.map(u => `<li>${esc(u)}</li>`).join("")}${(x.notes || []).map(u => `<li>${esc(u)}</li>`).join("")}</ul>`;
}

function form(s) {
  const f = s.form, canEdit = App.can("io.import") && App.can("case.create");
  const FIELDS = [["name", "Name", "input"], ["source", "Where the data came from", "input"], ["authorisation", "Basis for using it", "input"], ["research_question", "Research question", "input"], ["description", "Notes", "textarea"]];
  $("#sForm").innerHTML = `${FIELDS.map(([k, label, kind]) => `<label class="f" for="sf_${k}">${esc(label)} ${chip(f[k]?.basis || "not_available")}</label>${kind === "textarea" ? `<textarea id="sf_${k}" rows="6" ${canEdit ? "" : "readonly"}>${esc(f[k]?.value || "")}</textarea>` : `<input type="text" id="sf_${k}" value="${esc(f[k]?.value || "")}" ${canEdit ? "" : "readonly"}>`}<div class="tiny sub">${esc(f[k]?.note || "")}</div>`).join("")}
    <div class="grid g3" style="margin-top:8px"><div><span class="tiny sub">Collection method</span><div>${esc(f.collection_method?.value || "")}</div></div><div><span class="tiny sub">Dataset record</span><div>${s.dataset_id ? `<a href="#/monitor/${esc(s.dataset_id)}">Dataset ${esc(s.dataset_id)}</a>` : "not saved"}</div></div><div><span class="tiny sub">Post row</span><div>${f.post_record?.saved ? "saved" : esc(f.post_record?.reason || "not saved")}</div></div></div>
    ${canEdit ? `<div class="row" style="margin-top:10px"><button class="btn" id="sfSave">Save corrections (optional)</button><span class="tiny sub">Corrections are recorded beside what AIVS produced.</span></div>` : ""}
    ${s.form_edits?.length ? `<div class="tiny sub" style="margin-top:6px">${s.form_edits.length} correction(s) recorded: ${s.form_edits.map(e => `${esc(e.field)} by ${esc(e.by_name || "")}`).join(", ")}</div>` : ""}`;
  if ($("#sfSave")) $("#sfSave").onclick = async () => {
    const body = Object.fromEntries(FIELDS.map(([k]) => [k, $(`#sf_${k}`).value]));
    try { const r = await api.patch(`/api/screenshots/${encodeURIComponent(s.id)}`, body); toast(r.form_edits.length ? "Corrections saved." : "No changes."); form(r); } catch (e) { fail(e); }
  };
}

function result(s) {
  const inv = s.investigation, r = inv.result; if (!r) return;
  const v = VERDICT[r.verdict] || [r.label || r.verdict, "grey"], ap = s.approval;
  $("#sResultCard").hidden = false;
  $("#sResult").innerHTML = `<div class="row" style="gap:8px;flex-wrap:wrap"><span class="chip ${v[1]}">${esc(v[0])}</span><span class="small">Confidence: ${esc(r.strength || "—")}</span>
      <span class="small">HOD approval: <b>${esc(ap?.label || ap?.status || "not submitted")}</b>${ap?.assigned ? ` (${esc(ap.assigned)})` : ""}${ap?.approval_ref ? ` · ${esc(ap.approval_ref)}` : ""}</span></div>
    <h4 style="margin:10px 0 4px">Principal claims (at most two)</h4>
    ${r.claims.length ? `<ol style="margin:0 0 0 18px">${r.claims.map(c => `<li>${esc(c.text)} — <b>${esc((VERDICT[c.verdict] || [c.label || c.verdict || "—"])[0])}</b>${c.reason ? `<div class="tiny sub">${esc(c.reason)}</div>` : ""}</li>`).join("")}</ol>` : `<p class="small muted">No checkable claim was identified.</p>`}
    ${r.evidence?.length ? `<h4 style="margin:10px 0 4px">Accepted evidence</h4><ul style="margin:0 0 0 18px">${r.evidence.map(e => `<li>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title || e.url)}</a>` : esc(e.title || "")}${e.publisher ? ` · ${esc(e.publisher)}` : ""}${e.date ? ` · ${esc(String(e.date).slice(0, 10))}` : ""}${e.stance ? ` · ${esc(e.stance)}` : ""}</li>`).join("")}</ul>` : `<p class="small muted">No reliable evidence was accepted; the claims stay unverified.</p>`}
    <div class="row" style="margin-top:12px;flex-wrap:wrap"><a class="btn primary" href="/api/investigations/${esc(inv.id)}/report.pdf" target="_blank" rel="noopener">One-page KDF IO assessment (PDF)</a><a class="btn" href="/api/investigations/${esc(inv.id)}/report.html" target="_blank" rel="noopener">View as page</a><a class="btn ghost" href="#/investigate/${esc(inv.id)}">Full investigation ${esc(inv.report_id)}</a>${r.case_id ? `<a class="btn ghost" href="#/case/${esc(r.case_id)}">Case ${esc(r.case_id)}</a>` : ""}</div>
    <div class="tiny sub" style="margin-top:6px">${ap?.status === "approved" ? "The final approved PDF carries the Head of Department's approval." : "This is a DRAFT. The final PDF is issued only after the Head of Department approves it."}</div>`;
}

// the upload card shown at the top of Social Media Analysis
export function uploadCard() {
  if (!(App.can("io.import") && App.can("case.create"))) return "";
  return `<div class="card shotcard" style="border:2px solid var(--teal-500,#13948f)"><div class="hd"><h3>Upload Screenshot — Automatic AI Analysis</h3></div><div class="bd">
    <p class="small" style="margin-top:0">Upload one screenshot of a social media post (PNG, JPEG or WebP, up to 25 MB). AIVS reads it, identifies the main post, fills in the analysis fields, checks up to two principal claims against evidence, writes the one-page KDF IO assessment and sends it to the Head of Department. Nothing else is needed.</p>
    <label class="dropzone" id="shotDrop" for="shotFile" style="display:block;padding:18px;border:2px dashed var(--line,#c8cdd4);border-radius:8px;text-align:center;cursor:pointer"><b>Choose a screenshot</b> or drop it here<input type="file" id="shotFile" accept="image/png,image/jpeg,image/webp" style="display:block;margin:8px auto 0"></label>
    <div class="row" style="margin-top:8px"><span class="small muted" id="shotProg" aria-live="polite"></span></div><div id="shotErr" class="callout bad" style="margin-top:8px" hidden></div>
  </div></div>`;
}
export function wireUploadCard() {
  const input = $("#shotFile"); if (!input) return;
  const go = async f => {
    const err = $("#shotErr"); err.hidden = true;
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { err.hidden = false; err.textContent = `“${f.name}” is not a PNG, JPEG or WebP image. Save the screenshot in one of these formats.`; return; }
    const fd = new FormData(); fd.append("file", f, f.name); if (App.training) fd.append("is_training", "true");
    try {
      const r = await api.upload("/api/screenshots", fd, p => ($("#shotProg").innerHTML = p < 1 ? `Uploading ${Math.round(p * 100)}%` : `<span class="spin"></span> Starting the analysis…`));
      if (r.duplicate) toast(`This screenshot was analysed before (${r.id}); showing that analysis.`);
      App.go(`#/monitor/shot/${r.id}`);
    } catch (e) { err.hidden = false; err.textContent = errMsg(e); $("#shotProg").textContent = ""; }
  };
  input.onchange = () => go(input.files[0]);
  const dz = $("#shotDrop");
  dz.ondragover = e => { e.preventDefault(); dz.style.background = "var(--teal-50,#e8f5f4)"; };
  dz.ondragleave = () => { dz.style.background = ""; };
  dz.ondrop = e => { e.preventDefault(); dz.style.background = ""; go(e.dataTransfer.files[0]); };
}
export async function recentList() {
  try {
    const { analyses } = await api.get("/api/screenshots?limit=8"); if (!analyses.length) return "";
    return `<div class="card"><div class="hd"><h3>Recent screenshot analyses</h3></div><div class="tablewrap"><table class="t"><tbody>${analyses.map(a => `<tr class="click" data-shot="${esc(a.id)}"><td class="mono small">${esc(a.id)}</td><td>${esc(a.platform || "platform not identified")}<div class="tiny sub">${esc(a.account || "account not visible")}</div></td><td class="small">${esc((a.text || "").slice(0, 90))}</td><td class="small">${esc(a.status)}</td></tr>`).join("")}</tbody></table></div></div>`;
  } catch { return ""; }
}
export const wireRecent = () => $$("[data-shot]").forEach(r => (r.onclick = () => App.go(`#/monitor/shot/${r.dataset.shot}`)));

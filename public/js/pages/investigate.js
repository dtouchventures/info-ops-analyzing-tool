// Verify Information (1.22): one page, one button. The analyst gives a link, text, image, screenshot, PDF or Word
// document; AIVS extracts, analyses, searches, compares, assesses and writes the report on its own. The report is
// labelled "AI-generated · not reviewed" until a reviewer records a review. Step-by-step investigation is still
// available from the link on this page.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, errMsg, kb } from "../ui.js";

const STAGES = [["extract", "Extracting information"], ["analyse", "Analyzing content"], ["search", "Searching for evidence"], ["compare", "Comparing sources"], ["assess", "Preparing assessment"], ["report", "Generating report"]];
const VC = { supported: "sup", contradicted: "con", mixed: "mix", insufficient: "grey", not_verifiable: "grey" };
const eat = iso => iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " EAT" : "—";
let timer = null;

export async function render(el, params = []) {
  clearTimeout(timer);
  crumbs(`<b>Verify Information</b>${App.training ? " · training records" : ""}`);
  if (!App.can("case.create")) { el.innerHTML = `<div class="callout warn"><div>Your role can read reports but cannot start investigations. See <a href="#/reports">Reports</a>.</div></div>`; return; }
  el.innerHTML = `<div class="pagehead"><div><h1>Verify Information</h1><p>Give AIVS the information to check. It extracts the content, searches for evidence, compares the sources, assesses each claim and writes the report. No comments are needed.</p></div>
      <div class="row"><a class="btn ghost sm" href="#/start" title="The earlier, step-by-step investigation">Step-by-step investigation</a></div></div>
    <div class="card" id="invForm"><div class="bd">
      <label class="f" for="iv" style="margin-top:0">Link or text</label>
      <textarea id="iv" rows="5" maxlength="20000" placeholder="Paste a news article or social media link, or the text of a post, message or report"></textarea>
      <div class="row" style="margin-top:8px;gap:10px;flex-wrap:wrap">
        <label class="btn ghost" for="ifile" style="cursor:pointer">Add image, screenshot, PDF or Word file</label>
        <input id="ifile" type="file" multiple accept="image/*,.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style="position:absolute;opacity:0;width:1px;height:1px">
        <span id="ifiles" class="small muted"></span></div>
      ${App.training ? `<div class="callout train" style="margin-top:12px"><div>You are viewing Training records: this becomes a training investigation, kept apart from real cases.</div></div>` : ""}
      <div id="ierr" class="callout bad" style="margin-top:12px" hidden></div>
      <button class="btn primary" id="igo" style="margin-top:14px;width:100%;justify-content:center;font-size:16px;padding:12px">Analyze Information</button>
      <p class="tiny sub" style="margin:8px 0 0">The report is generated automatically and marked “AI-generated · not reviewed”. Check important findings before acting on them.</p>
    </div></div>
    <div class="card" id="invProg" hidden><div class="hd"><h3>Progress</h3><span class="mono small" id="irid"></span></div><div class="bd"><ol class="istages" id="istages"></ol></div></div>
    <div id="invOut" hidden>
      <div class="row" style="margin:6px 0 10px;flex-wrap:wrap;gap:8px" id="iacts"></div>
      <iframe id="irep" title="Report" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin" style="width:100%;height:78vh;min-height:520px;border:1px solid var(--line);border-radius:10px;background:#fff"></iframe>
    </div>`;
  const files = $("#ifile"), err = $("#ierr");
  files.onchange = () => { $("#ifiles").textContent = [...files.files].map(f => `${f.name} (${kb(f.size)})`).join(", "); };
  $("#igo").onclick = async () => {
    err.hidden = true;
    const v = $("#iv").value.trim();
    if (!v && !files.files.length) { err.innerHTML = "<div>Paste a link or some text, or add a file.</div>"; err.hidden = false; return; }
    const fd = new FormData();
    if (/^https?:\/\/\S+$/i.test(v)) fd.append("url", v); else if (v) fd.append("text", v);
    for (const f of [...files.files].slice(0, 5)) fd.append("files", f);
    if (App.training) fd.append("is_training", "true");
    $("#igo").disabled = true; $("#igo").textContent = "Analyzing…";
    try { const r = await api.upload("/api/investigations", fd); location.hash = `#/investigate/${r.id}`; }
    catch (e) { err.innerHTML = `<div>${esc(errMsg(e))}</div>`; err.hidden = false; $("#igo").disabled = false; $("#igo").textContent = "Analyze Information"; }
  };
  if (params[0]) follow(el, params[0]);
}

function stages(list) {
  const by = Object.fromEntries((list || []).map(s => [s.key, s]));
  $("#istages").innerHTML = STAGES.map(([k, l], i) => { const s = by[k] || { status: "pending" };
    return `<li class="${esc(s.status)}"><span class="dot">${s.status === "done" ? "✓" : s.status === "warning" ? "!" : ""}</span><span>${i + 1}. ${esc(l)}${s.detail ? `<span class="tiny sub" style="display:block">${esc(s.detail)}</span>` : ""}</span></li>`; }).join("");
}
async function follow(el, id) {
  $("#invForm").hidden = true; $("#invProg").hidden = false;
  const tick = async () => {
    if (!el.isConnected || !location.hash.includes(id)) return;
    let inv; try { inv = await api.get(`/api/investigations/${encodeURIComponent(id)}`); } catch (e) { $("#istages").innerHTML = `<li class="warning">${esc(errMsg(e))}</li>`; return; }
    $("#irid").textContent = inv.report_id; stages(inv.stages);
    if (inv.status === "failed") { $("#invProg .bd").insertAdjacentHTML("beforeend", `<div class="callout bad" style="margin-top:10px"><div>The investigation stopped: ${esc(inv.error || "unknown error")}. <a href="#/investigate">Start again</a>.</div></div>`); return; }
    if (inv.status !== "done") { timer = setTimeout(tick, 1200); return; }
    const r = inv.result, base = `/api/investigations/${encodeURIComponent(inv.id)}/report`;
    $("#iacts").innerHTML = `<span class="chip ${VC[r.overall.verdict]}" style="font-size:14px">${esc(r.overall.label)} · ${esc(r.overall.strength_label)}</span>
      <a class="btn sm" href="${base}.pdf" download>Download PDF</a><a class="btn sm" href="${base}.docx" download>Download Word</a><a class="btn sm ghost" href="${base}.html?download=1">HTML</a>
      ${inv.case_id ? `<a class="btn sm ghost" href="#/case/${esc(inv.case_id)}">Open case ${esc(inv.case_id)}</a>` : ""}<a class="btn sm ghost" href="#/investigate">New investigation</a>
      ${App.can("case.approve") && !r.review?.at && inv.created_by !== App.me.id ? `<button class="btn sm ghost" id="irev">Record a review</button>` : ""}`;
    $("#irep").srcdoc = await (await fetch(`${base}.html`, { credentials: "same-origin" })).text();
    $("#invOut").hidden = false; $("#invProg").open = false;
    const rb = $("#irev"); if (rb) rb.onclick = async () => { const note = prompt("What did you check? (recorded with your name)"); if (!note) return; try { await api.post(`/api/investigations/${encodeURIComponent(inv.id)}/review`, { note }); follow(el, id); } catch (e) { alert(errMsg(e)); } };
  };
  tick();
}

// list of automatic reports by date, used by the Reports page
export function listHtml(list) {
  if (!list.length) return `<p class="small sub" style="margin:0">No automatic reports for these dates.</p>`;
  return `<div class="tablewrap"><table class="t"><thead><tr><th>Investigation date</th><th>Report</th><th>Subject</th><th>Source published</th><th>Assessment</th><th>Review</th><th>Export</th></tr></thead><tbody>${list.map(x => `<tr>
    <td class="small">${esc(eat(x.created_at))}</td><td class="mono small"><a href="#/investigate/${esc(x.id)}">${esc(x.report_id)}</a></td><td class="small">${esc((x.subject || (x.status === "failed" ? "Stopped: " + (x.error || "") : x.status)).slice(0, 90))}${x.case_id ? ` <a class="tiny" href="#/case/${esc(x.case_id)}">${esc(x.case_id)}</a>` : ""}</td>
    <td class="small">${x.source_published_at ? esc(eat(x.source_published_at)) : "Not known"}</td><td>${x.overall ? `<span class="chip ${VC[x.overall]}">${esc(x.overall_label)}</span>` : `<span class="chip grey">${esc(x.status)}</span>`}</td>
    <td class="small">${x.reviewed_at ? `Reviewed by ${esc(x.reviewed_by_name)}` : "Not reviewed"}</td>
    <td>${x.status === "done" ? `<div class="row"><a class="btn sm ghost" href="/api/investigations/${esc(x.id)}/report.pdf" download>PDF</a><a class="btn sm ghost" href="/api/investigations/${esc(x.id)}/report.docx" download>Word</a></div>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
}

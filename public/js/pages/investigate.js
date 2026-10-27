// Verify Information (1.24): paste a link, press Analyse Automatically. AIVS extracts the post or article (text,
// headline, images, author, date, hashtags, engagement, video details), detects the claims, searches for evidence,
// compares sources, checks the images, assesses each claim and writes the report. The extracted content is shown as
// soon as it is available. Text, screenshots and files can still be given when there is no link, or to correct an
// incomplete extraction. Everything is labelled as an AI-generated preliminary assessment.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, esc, errMsg, kb } from "../ui.js";

const STAGES = [["extract", "Extracting the content"], ["analyse", "Detecting claims"], ["search", "Searching for evidence"], ["compare", "Cross-checking sources"], ["media", "Checking images and media"], ["assess", "AI assessment"], ["report", "Generating the report"]];
const VC = { supported: "sup", contradicted: "con", misleading: "mix", mixed: "grey", insufficient: "grey", not_verifiable: "grey" };
const STANCE = { supports: ["Supports", "sup"], contradicts: ["Contradicts", "con"], misleading: ["Misleading / missing context", "mix"], related: ["Related only", "grey"] };
const eat = iso => iso ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00+03:00` : iso).toLocaleString("en-GB", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", year: "numeric", ...(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? {} : { hour: "2-digit", minute: "2-digit" }) }) + (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? "" : " EAT") : "Not known";
const httpLink = (u, t) => /^https?:\/\//i.test(String(u || "")) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t || u)}</a>` : esc(t || u || "");
let timer = null;

export async function render(el, params = []) {
  clearTimeout(timer);
  crumbs(`<b>Verify Information</b>${App.training ? " · training records" : ""}`);
  if (!App.can("case.create")) { el.innerHTML = `<div class="callout warn"><div>Your role can read reports but cannot start investigations. See <a href="#/reports">Reports</a>.</div></div>`; return; }
  el.innerHTML = `<div class="pagehead"><div><h1>Verify Information</h1><p>Paste a link. AIVS extracts the post or article with its images, detects the claims, searches for evidence, checks the images and writes a preliminary report. You do not need to type anything else.</p></div>
      <div class="row"><a class="btn ghost sm" href="#/start" title="The earlier, step-by-step investigation">Step-by-step investigation</a></div></div>
    <div class="card" id="invForm"><div class="bd">
      <label class="f" for="iv" style="margin-top:0;font-size:16px">Paste a link to verify</label>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:stretch">
        <input id="iv" type="text" inputmode="url" autocomplete="off" maxlength="2000" placeholder="https://example.com/news/article" style="flex:1;min-width:240px;font-size:16px;padding:12px">
        <button class="btn primary" id="igo" style="font-size:16px;padding:12px 20px">Analyse Automatically</button></div>
      <div class="tiny sub" style="margin-top:6px">News sites, blogs, X, YouTube, TikTok, Telegram and other public pages. Facebook and Instagram posts can be read only with an approved Meta access token; otherwise add a screenshot below.</div>
      <details id="imore" style="margin-top:12px"><summary class="small">No link? Paste text, or add a screenshot, image, PDF or Word file</summary>
        <textarea id="itext" rows="4" maxlength="20000" style="margin-top:8px" placeholder="Paste the text of a post, message or report"></textarea>
        <div class="row" style="margin-top:8px;gap:10px;flex-wrap:wrap"><label class="btn ghost sm" for="ifile" style="cursor:pointer">Add files</label>
          <input id="ifile" type="file" multiple accept="image/*,.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style="position:absolute;opacity:0;width:1px;height:1px"><span id="ifiles" class="small muted"></span></div>
      </details>
      ${App.training ? `<div class="callout train" style="margin-top:12px"><div>You are viewing Training records: this becomes a training investigation, kept apart from real cases.</div></div>` : ""}
      <div id="ierr" class="callout bad" style="margin-top:12px" hidden></div>
      <p class="tiny sub" style="margin:10px 0 0">Results are AI-generated preliminary assessments, labelled as not reviewed. AI confidence is not proof; consequential decisions need human review.</p>
    </div></div>
    <div id="invRun" hidden>
      <div class="grid g2" style="align-items:start">
        <div class="card"><div class="hd"><h3>Extracted content</h3><span id="iplat" class="chip grey"></span></div><div class="bd" id="iprev"><span class="spin"></span> Waiting for the content…</div></div>
        <div class="card"><div class="hd"><h3>AI investigation progress</h3><span class="mono small" id="irid"></span></div><div class="bd"><ol class="istages" id="istages"></ol></div></div>
      </div>
      <div id="ifix"></div>
      <div id="ires"></div>
      <div id="invOut" hidden>
        <div class="row" style="margin:12px 0 8px;flex-wrap:wrap;gap:8px" id="iacts"></div>
        <div class="card"><div class="hd"><h3>Information Operations Assessment</h3><span class="small muted">One-page assessment · full evidence in Supporting evidence</span></div><div class="bd" style="padding:0">
          <iframe id="irep" title="Information Operations Assessment" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin" style="width:100%;height:78vh;min-height:520px;border:0;border-radius:0 0 10px 10px;background:#fff"></iframe></div></div>
      </div>
    </div>`;
  const files = $("#ifile"), err = $("#ierr");
  files.onchange = () => { $("#ifiles").textContent = [...files.files].map(f => `${f.name} (${kb(f.size)})`).join(", "); };
  $("#iv").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); $("#igo").click(); } };
  $("#igo").onclick = async () => {
    err.hidden = true;
    const v = $("#iv").value.trim(), t = $("#itext").value.trim();
    if (!v && !t && !files.files.length) { err.innerHTML = "<div>Paste a link or some text, or add a file.</div>"; err.hidden = false; return; }
    const fd = new FormData();
    if (/^https?:\/\/\S+$/i.test(v)) fd.append("url", v);
    else if (v && /^(www\.|[\w-]+\.[a-z]{2,}\/)/i.test(v)) { err.innerHTML = "<div>Links must start with https:// or http://.</div>"; err.hidden = false; return; }
    else if (v) fd.append("text", v);
    if (t) fd.append("text", t);
    for (const f of [...files.files].slice(0, 5)) fd.append("files", f);
    if (App.training) fd.append("is_training", "true");
    $("#igo").disabled = true; $("#igo").textContent = "Starting…";
    try { const r = await api.upload("/api/investigations", fd); location.hash = `#/investigate/${r.id}`; }
    catch (e) { err.innerHTML = `<div>${esc(errMsg(e))}</div>`; err.hidden = false; $("#igo").disabled = false; $("#igo").textContent = "Analyse Automatically"; }
  };
  if (params[0]) follow(el, params[0]);
}

function stages(list) {
  const by = Object.fromEntries((list || []).map(s => [s.key, s]));
  $("#istages").innerHTML = STAGES.map(([k, l], i) => { const s = by[k] || { status: "pending" };
    return `<li class="${esc(s.status)}"><span class="dot">${s.status === "done" ? "✓" : s.status === "warning" ? "!" : s.status === "failed" ? "×" : ""}</span><span>${i + 1}. ${esc(l)}${s.detail ? `<span class="tiny sub" style="display:block">${esc(s.detail)}</span>` : ""}</span></li>`; }).join("");
}
function preview(p) {
  if (!p) return;
  $("#iplat").textContent = p.platform || (p.url ? "Website" : "Submitted content");
  const meta = [p.author && `By ${esc(p.author)}`, p.publisher && esc(p.publisher), p.published_at && `Published ${esc(eat(p.published_at))}`].filter(Boolean).join(" · ");
  const counts = p.metrics ? Object.entries(p.metrics).filter(([, v]) => v != null).map(([k, v]) => `${esc(k)} ${Number(v).toLocaleString()}`).join(" · ") : "";
  $("#iprev").innerHTML = `${p.url ? `<div class="tiny sub" style="word-break:break-all">${httpLink(p.url)}</div>` : ""}
    ${p.title ? `<h3 style="margin:6px 0 4px">${esc(p.title)}</h3>` : ""}${meta ? `<div class="small sub">${meta}</div>` : ""}
    ${p.description ? `<p class="small" style="margin:6px 0">${esc(p.description)}</p>` : ""}
    ${(p.images || []).length ? `<div class="row" style="gap:8px;flex-wrap:wrap;margin:8px 0">${p.images.map(i => `<figure style="margin:0;max-width:200px"><img src="/api/media/${encodeURIComponent(i.media_id)}/thumb" alt="${esc(i.name)}" style="max-width:200px;max-height:150px;border:1px solid var(--line);border-radius:6px;display:block"><figcaption class="tiny sub">${esc(i.source || i.name)}</figcaption></figure>`).join("")}</div>` : ""}
    ${p.text ? `<div class="small" style="white-space:pre-wrap;max-height:220px;overflow:auto;border-left:3px solid var(--line);padding-left:8px">${esc(p.text.slice(0, 1500))}${p.text.length > 1500 ? "…" : ""}</div>` : '<p class="small sub">No text could be extracted.</p>'}
    ${(p.hashtags || []).length || (p.mentions || []).length ? `<div class="tiny sub" style="margin-top:6px">${[...(p.hashtags || []), ...(p.mentions || [])].slice(0, 12).map(esc).join(" ")}</div>` : ""}
    ${counts ? `<div class="tiny sub">Public engagement: ${counts}</div>` : ""}
    ${p.video ? `<div class="tiny sub">Video: ${esc([p.video.title, p.video.channel, p.video.duration].filter(Boolean).join(" · "))}${p.video.captions ? `<br>Captions: ${esc(p.video.captions)}` : ""}</div>` : ""}
    ${(p.claims || []).length ? `<div style="margin-top:8px"><b class="small">Detected claims</b><ol class="small" style="margin:4px 0 0 18px">${p.claims.map(c => `<li>${esc(c.text)}${c.claim_type && c.claim_type !== "factual" ? ` <span class="chip grey">${esc(c.claim_type)}</span>` : ""}</li>`).join("")}</ol></div>` : ""}
    ${(p.notes || []).length ? `<div class="callout warn" style="margin-top:8px"><div class="small">${p.notes.map(esc).join("<br>")}</div></div>` : ""}`;
}
function fixForm(inv) {
  const p = inv.preview || {}, x = inv.result?.source || {};
  if (!["restricted", "failed", "partial"].includes(x.access || p.access)) return "";
  return `<div class="card" style="margin-top:12px"><div class="hd"><h3>Extraction was incomplete</h3></div><div class="bd">
    <p class="small">${esc(x.fallback || p.fallback || "Add what is missing and AIVS will analyse the link again.")}</p>
    <textarea id="fxText" rows="3" placeholder="Paste the text of the post or article"></textarea>
    <div class="row" style="margin-top:8px;gap:10px;flex-wrap:wrap"><label class="btn ghost sm" for="fxFile" style="cursor:pointer">Add a screenshot or file</label><input id="fxFile" type="file" multiple accept="image/*,.pdf,.docx" style="position:absolute;opacity:0;width:1px;height:1px"><span id="fxNames" class="small muted"></span>
      <button class="btn primary sm" id="fxGo">Analyse again with this</button></div><div id="fxErr" class="callout bad" style="margin-top:8px" hidden></div></div></div>`;
}
function results(inv) {
  const r = inv.result, o = r.overall, by = Object.fromEntries(r.evidence.map(e => [e.id, e]));
  const evRow = e => `<li class="small" style="margin-bottom:4px"><span class="chip ${STANCE[e.stance][1]}">${STANCE[e.stance][0]}</span> ${httpLink(e.source_url, e.source_title || e.reference)} <span class="tiny sub">${esc(e.publisher || "")} · ${esc(e.tier_label)} · ${e.source_published_at ? esc(eat(e.source_published_at.slice(0, 10))) : "date not known"}${e.rating ? ` · rating “${esc(e.rating)}”` : ""}${e.ai_disagrees ? " · AI read this differently: check it" : ""}</span></li>`;
  const claims = r.claims.map((c, i) => { const a = r.assessments[i], top = (r.top[c.id] || []).map(id => by[id]).filter(Boolean);
    const sup = top.filter(e => e.stance === "supports"), con = top.filter(e => e.stance === "contradicts" || e.stance === "misleading"), rel = top.filter(e => e.stance === "related");
    return `<div class="card" style="margin-top:10px"><div class="bd"><div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><b>Claim ${c.seq}</b><span class="chip ${VC[a.verdict]}">${esc({ supported: "Supported", contradicted: "Contradicted", misleading: "Misleading or missing context", insufficient: a.conflicting ? "Insufficient evidence (sources disagree)" : "Insufficient evidence", not_verifiable: "Unverifiable", mixed: "Insufficient evidence (sources disagree)" }[a.verdict])} · ${esc({ strong: "strong", moderate: "moderate", weak: "weak", none: "no" }[a.strength])} evidence</span></div>
      <p style="margin:6px 0">${esc(c.text)}</p><p class="small sub" style="margin:0 0 6px">${esc(a.reason)}</p>
      ${sup.length ? `<div class="small"><b>Supporting evidence</b><ul style="margin:4px 0 6px 18px">${sup.map(evRow).join("")}</ul></div>` : ""}
      ${con.length ? `<div class="small"><b>Contradicting evidence</b><ul style="margin:4px 0 6px 18px">${con.map(evRow).join("")}</ul></div>` : ""}
      ${rel.length ? `<details class="small"><summary>Related sources (${rel.length})</summary><ul style="margin:4px 0 6px 18px">${rel.map(evRow).join("")}</ul></details>` : ""}</div></div>`; }).join("");
  const imgs = (r.media?.images || []).map(i => `<div class="row" style="gap:12px;align-items:flex-start;margin:8px 0;flex-wrap:wrap"><img src="/api/media/${encodeURIComponent(i.media_id)}/thumb" alt="${esc(i.name)}" style="max-width:160px;max-height:120px;border:1px solid var(--line);border-radius:6px">
    <ul class="small" style="flex:1;min-width:220px;margin:0 0 0 18px">${i.observations.map(x => `<li>${esc(x.text)}${x.strength === "ai" ? ' <span class="chip grey">AI, not verified</span>' : x.kind === "reuse" ? ' <span class="chip mix">possible reuse</span>' : ""}</li>`).join("")}</ul></div>`).join("");
  const cred = Object.entries(r.evidence.filter(e => !e.repeat_of).reduce((m, e) => (m[e.tier_label] = (m[e.tier_label] || 0) + 1, m), {}));
  return `<div class="card" style="margin-top:12px;border-left:6px solid var(--${VC[o.verdict] === "grey" ? "line" : VC[o.verdict]})"><div class="bd">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><div><div class="tiny sub">Overall preliminary verdict</div><h2 style="margin:2px 0">${esc(o.label)}</h2></div><span class="chip ${VC[o.verdict]}" style="font-size:13px">Strength of the evidence: ${esc(o.strength_label)}</span></div>
      ${o.note ? `<p class="small" style="margin:6px 0">${esc(o.note)}</p>` : ""}
      <p class="small" style="margin:6px 0">${esc(r.sections.assessment.slice(0, 2).join(" "))}</p>
      <p class="tiny sub" style="margin:4px 0 0">AI-generated preliminary assessment · ${esc(r.review?.status === "reviewed" ? `reviewed by ${r.review.by}` : "not reviewed by an analyst")}. The strength label describes the evidence found, not the probability that the claim is true.${r.ai.used ? ` AI model: ${esc(r.ai.model)}.` : ` AI not used: ${esc(r.ai.reason || "")}`}</p></div></div>
    <h3 style="margin:16px 0 4px">Claims and evidence</h3>${claims || '<p class="small sub">No claim could be checked.</p>'}
    ${imgs ? `<h3 style="margin:16px 0 4px">Image verification</h3><div class="card"><div class="bd">${imgs}<p class="tiny sub">${esc(r.media.note)}</p></div></div>` : ""}
    <div class="grid g2" style="margin-top:12px;align-items:start">
      <div class="card"><div class="hd"><h3>Evidence sources</h3></div><div class="bd small">${r.search.length ? `<ul style="margin:0 0 0 18px">${r.search.map(s => `<li>${esc(s.label)}: ${s.status === "ok" || s.status === "partial" ? `${s.results} result(s)` : s.status === "not_configured" ? "not configured" : `<span style="color:var(--con)">${esc((s.errors || [])[0] || s.status)}</span>`}</li>`).join("")}</ul>` : "No search was run."}
        ${cred.length ? `<p class="tiny sub" style="margin:8px 0 0">Source credibility (independent sources): ${cred.map(([k, n]) => `${esc(k)} ${n}`).join(" · ")}</p>` : ""}</div></div>
      <div class="card"><div class="hd"><h3>Recommended next steps</h3></div><div class="bd small"><ul style="margin:0 0 0 18px">${r.sections.recommendations.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div></div></div>`;
}
async function follow(el, id) {
  $("#invForm").hidden = true; $("#invRun").hidden = false;
  const tick = async () => {
    if (!el.isConnected || !location.hash.includes(id)) return;
    let inv; try { inv = await api.get(`/api/investigations/${encodeURIComponent(id)}`); } catch (e) { $("#istages").innerHTML = `<li class="warning">${esc(errMsg(e))}</li>`; return; }
    $("#irid").textContent = inv.report_id; stages(inv.stages); preview(inv.preview);
    if (inv.status === "failed") { $("#ires").innerHTML = `<div class="callout bad" style="margin-top:10px"><div>The investigation stopped: ${esc(inv.error || "unknown error")}. <a href="#/investigate">Start again</a>.</div></div>`; return; }
    if (inv.status !== "done") { timer = setTimeout(tick, 1200); return; }
    const r = inv.result, base = `/api/investigations/${encodeURIComponent(inv.id)}/report`;
    if (!inv.preview) preview({ platform: r.source.platform, url: r.source.url, title: r.source.title, text: r.content, claims: r.claims, notes: r.source.notes });
    $("#ifix").innerHTML = fixForm(inv); $("#ires").innerHTML = results(inv);
    $("#iacts").innerHTML = `<span class="chip ${VC[r.overall.verdict]}" style="font-size:14px">${esc(r.overall.label)} · ${esc(r.overall.strength_label)}</span>
      <a class="btn sm primary" href="${base}.pdf" download>Download Report (PDF)</a><a class="btn sm" href="${base}.docx" download>Word</a><a class="btn sm ghost" href="${base}.html?download=1">HTML</a>
      <a class="btn sm ghost" id="idet" href="${base.replace(/report$/, "details")}.html" target="_blank" rel="noopener">Supporting evidence</a><a class="btn sm ghost" href="${base.replace(/report$/, "details")}.pdf" download>Evidence (PDF)</a>
      ${inv.case_id ? `<a class="btn sm ghost" href="#/case/${esc(inv.case_id)}">Open case ${esc(inv.case_id)}</a>` : ""}<a class="btn sm ghost" href="#/investigate">New investigation</a>
      ${App.can("case.approve") && !r.review?.at && inv.created_by !== App.me.id ? `<button class="btn sm ghost" id="irev">Record a review</button>` : ""}`;
    $("#irep").srcdoc = await (await fetch(`${base}.html`, { credentials: "same-origin" })).text();
    $("#invOut").hidden = false;
    const rb = $("#irev"); if (rb) rb.onclick = async () => { const note = prompt("What did you check? (recorded with your name)"); if (!note) return; try { await api.post(`/api/investigations/${encodeURIComponent(inv.id)}/review`, { note }); follow(el, id); } catch (e) { alert(errMsg(e)); } };
    const fx = $("#fxGo");
    if (fx) {
      $("#fxFile").onchange = () => { $("#fxNames").textContent = [...$("#fxFile").files].map(f => f.name).join(", "); };
      fx.onclick = async () => { const fd = new FormData(), t = $("#fxText").value.trim(); if (t) fd.append("text", t); for (const f of [...$("#fxFile").files].slice(0, 5)) fd.append("files", f);
        try { const n = await api.upload(`/api/investigations/${encodeURIComponent(inv.id)}/rerun`, fd); location.hash = `#/investigate/${n.id}`; } catch (e) { $("#fxErr").innerHTML = `<div>${esc(errMsg(e))}</div>`; $("#fxErr").hidden = false; } };
    }
  };
  tick();
}

// list of automatic reports by date, used by the Reports page
export function listHtml(list) {
  if (!list.length) return `<p class="small sub" style="margin:0">No automatic reports for these dates.</p>`;
  const L = { supported: "Supported", contradicted: "Contradicted", misleading: "Misleading or missing context", insufficient: "Insufficient evidence", not_verifiable: "Unverifiable", mixed: "Insufficient evidence (sources disagree)" };
  return `<div class="tablewrap"><table class="t"><thead><tr><th>Investigation date</th><th>Report</th><th>Subject</th><th>Source published</th><th>Assessment</th><th>Review</th><th>Export</th></tr></thead><tbody>${list.map(x => `<tr>
    <td class="small">${esc(eat(x.created_at))}</td><td class="mono small"><a href="#/investigate/${esc(x.id)}">${esc(x.report_id)}</a></td><td class="small">${esc((x.subject || (x.status === "failed" ? "Stopped: " + (x.error || "") : x.status)).slice(0, 90))}${x.case_id ? ` <a class="tiny" href="#/case/${esc(x.case_id)}">${esc(x.case_id)}</a>` : ""}</td>
    <td class="small">${x.source_published_at ? esc(eat(x.source_published_at)) : "Not known"}</td><td>${x.overall ? `<span class="chip ${VC[x.overall] || "grey"}">${esc(L[x.overall] || x.overall)}</span>` : `<span class="chip grey">${esc(x.status)}</span>`}</td>
    <td class="small">${x.reviewed_at ? `Reviewed by ${esc(x.reviewed_by_name)}` : "Not reviewed"}</td>
    <td>${x.status === "done" ? `<div class="row"><a class="btn sm ghost" href="/api/investigations/${esc(x.id)}/report.pdf" download>PDF</a><a class="btn sm ghost" href="/api/investigations/${esc(x.id)}/report.docx" download>Word</a></div>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
}

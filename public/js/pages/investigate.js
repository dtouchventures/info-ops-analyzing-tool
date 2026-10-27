// Verify Information (1.24): paste a link, press Analyse Automatically. AIVS extracts the post or article (text,
// headline, images, author, date, hashtags, engagement, video details), detects the claims, searches for evidence,
// compares sources, checks the images, assesses each claim and writes the report. The extracted content is shown as
// soon as it is available. Text, screenshots and files can still be given when there is no link, or to correct an
// incomplete extraction. Everything is labelled as an AI-generated preliminary assessment.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, esc, errMsg, kb } from "../ui.js";

const STAGES = [["source", "Detecting the source"], ["extract", "Extracting the content (authorised methods)"], ["analyse", "Detecting claims (AI)"], ["search", "Collecting evidence"], ["compare", "Cross-checking sources"], ["media", "Checking images and media"], ["assess", "Assessment"], ["report", "Generating the report"]];
const VC = { supported: "sup", contradicted: "con", misleading: "mix", mixed: "grey", insufficient: "grey", not_verifiable: "grey", extraction_blocked: "warn", insufficient_content: "warn" };
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
      <div class="tiny sub" style="margin-top:6px">News sites, blogs, X, YouTube, TikTok, Telegram, Facebook and Instagram. AIVS tries every method it is allowed to use; when a platform restricts access it says so and offers the alternatives.</div>
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
  if (params[0] === "capture") return captureView(el);
  if (params[0]) follow(el, params[0]);
}
// the bookmarklet opens AIVS with the post's address and the text the analyst selected in their own browser; nothing is sent until
// the analyst checks it and presses Continue
function captureView(el) {
  const raw = new URLSearchParams(location.hash.split("?").slice(1).join("?")).get("d") || "{}"; let d = {};
  try { d = JSON.parse(raw); } catch { try { d = JSON.parse(decodeURIComponent(raw)); } catch {} }
  history.replaceState(null, "", "#/investigate/capture");   // the captured text does not stay in the address bar
  $("#invForm").hidden = true;
  const box = document.createElement("div"); box.className = "card"; box.id = "icap";
  box.innerHTML = `<div class="hd"><h3>Captured from your browser</h3></div><div class="bd">
    <p class="small" style="margin-top:0">This was captured from a page open in your own browser. Check it, correct it if needed, and continue. The report will say it was captured by you, not retrieved by AIVS.</p>
    <label class="f" for="capUrl">Post address</label><input id="capUrl" style="width:100%" value="${esc(d.u || "")}">
    <label class="f" for="capText">Text</label><textarea id="capText" rows="6" style="width:100%">${esc(d.t || "")}</textarea>
    ${d.ti ? `<div class="tiny sub">Page title: ${esc(d.ti)}</div>` : ""}
    <div class="row" style="gap:8px;margin-top:10px"><button class="btn primary" id="capGo">Continue the investigation</button><a class="btn ghost" href="#/investigate">Cancel</a></div><div id="capErr" class="callout bad" style="margin-top:8px" hidden></div></div>`;
  el.querySelector(".pagehead").after(box);
  $("#capGo").onclick = async () => { $("#capGo").disabled = true;
    try { const n = await api.post("/api/investigations/capture", { url: $("#capUrl").value.trim(), text: $("#capText").value, title: d.ti || "" }); location.hash = `#/investigate/${n.id}`; }
    catch (e) { $("#capErr").innerHTML = `<div>${esc(errMsg(e))}</div>`; $("#capErr").hidden = false; $("#capGo").disabled = false; } };
}
// a bookmark the analyst keeps once; on a post they are permitted to see, it sends the selected text (or the page's own description)
const bookmarklet = () => `javascript:(()=>{const s=String(getSelection()||'').trim(),m=n=>(document.querySelector('meta[property="'+n+'"]')||{}).content||'',d={u:location.href,t:(s||m('og:description')).slice(0,8000),ti:document.title.slice(0,200)};if(!d.t){alert('Select the text of the post first, then click AIVS capture again.');return}window.open(${JSON.stringify(location.origin + "/#/investigate/capture?d=")}+encodeURIComponent(JSON.stringify(d)),'_blank','noopener')})()`;

function stages(list) {
  const by = Object.fromEntries((list || []).map(s => [s.key, s]));
  $("#istages").innerHTML = STAGES.map(([k, l], i) => { const s = by[k] || { status: "pending" };
    return `<li class="${esc(s.status)}"><span class="dot">${s.status === "done" ? "✓" : s.status === "warning" ? "!" : s.status === "failed" ? "×" : s.status === "skipped" ? "–" : ""}</span><span>${i + 1}. ${esc(l)}${s.detail ? `<span class="tiny sub" style="display:block">${esc(s.detail)}</span>` : ""}</span></li>`; }).join("");
}
function preview(p) {
  if (!p) return;
  $("#iplat").textContent = p.platform || (p.url ? "Website" : "Submitted content");
  const meta = [p.author && `By ${esc(p.author)}`, p.publisher && esc(p.publisher), p.published_at && `Published ${esc(eat(p.published_at))}`].filter(Boolean).join(" · ");
  const counts = p.metrics ? Object.entries(p.metrics).filter(([, v]) => v != null).map(([k, v]) => `${esc(k)} ${Number(v).toLocaleString()}`).join(" · ") : "";
  const si = p.source_info, prevInv = si?.previous?.length ? `<div class="callout info" style="margin:6px 0"><div class="small">Investigated before: ${si.previous.map(x => `<a href="#/investigate/${esc(x.id)}">${esc(x.report_id)}</a> (${esc(x.label || "")}, ${esc(eat(x.created_at))})`).join(" · ")}</div></div>` : "";
  $("#iprev").innerHTML = `${si?.valid ? `<div class="tiny sub">Detected: ${esc([si.platform, si.kind, si.account && `account ${si.account}`, si.post_id && `ID ${si.post_id}`].filter(Boolean).join(" · "))}</div>` : ""}${prevInv}${p.url ? `<div class="tiny sub" style="word-break:break-all">${httpLink(p.url)}</div>` : ""}
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
// the content could not be read automatically: the analyst supplies it and the same investigation continues (1.30)
function continueForm(inv, b) {
  const plat = inv.result?.source?.platform || "The platform";
  return `<div class="card" style="margin-top:12px;border-left:6px solid var(--warn)" id="icont"><div class="hd"><h3>Continue the investigation</h3></div><div class="bd">
    <p class="small" style="margin-top:0">${esc(plat)} did not allow AIVS to read this ${/Facebook|Instagram/.test(plat) ? "post" : "content"} automatically. This is a limitation of the platform's access, not an error in AIVS. Add what you can see, and AIVS continues with claim detection, evidence search, cross-checking, image checks and AI analysis. The original link is kept, and the report will say the content was supplied by you.</p>
    <div class="grid g2" style="gap:12px">
      <div><label class="f" for="ctShot">Screenshot of the post</label><input id="ctShot" type="file" accept="image/*" multiple><div class="tiny sub">Its text is read by OCR.</div></div>
      <div><label class="f" for="ctMedia">Image or video evidence</label><input id="ctMedia" type="file" accept="image/*,video/*,audio/*,.pdf,.docx" multiple><div class="tiny sub">Kept with the case; images are checked.</div></div>
    </div>
    <label class="f" for="ctText" style="margin-top:10px">The post's text</label><textarea id="ctText" rows="4" style="width:100%" placeholder="Paste the text exactly as it appears in the post"></textarea>
    <label class="f" for="ctSrc">Original source link (optional)</label><input id="ctSrc" style="width:100%" placeholder="https://… the article or page the post comes from">
    <div class="row" style="gap:10px;margin-top:10px;align-items:center"><button class="btn primary" id="ctGo">Continue the investigation</button><span class="tiny sub">Up to 5 files.</span></div>
    <div id="ctErr" class="callout bad" style="margin-top:8px" hidden></div>
    <details style="margin-top:10px"><summary class="small"><b>Capture it from your own browser</b> (one click, for posts you are permitted to see)</summary><div class="small" style="margin-top:6px">
      1. Drag this button to your browser's bookmarks bar once: <a class="btn sm" id="ctBm" href="${esc(bookmarklet())}">AIVS capture</a><br>
      2. Open the post on ${esc(plat)}, select its text, and click <b>AIVS capture</b> in your bookmarks bar. AIVS opens with the text filled in for you to check.<br>
      <span class="tiny sub">The capture runs in your browser with your own access; AIVS never signs in to ${esc(plat)}.</span></div></details>
    ${(b.attempts || []).length ? `<details class="tiny sub" style="margin-top:8px"><summary>What AIVS tried</summary><ul style="margin:4px 0 0 18px">${b.attempts.map(a => `<li>${esc(a.method)}: <b>${esc(a.result)}</b>${a.detail ? ` — ${esc(a.detail)}` : ""}</li>`).join("")}</ul></details>` : ""}
    ${inv.result.references ? `<div class="small" style="margin-top:8px"><b>Independent references</b> <span class="tiny sub">(public pages that mention the post; not the post's content)</span>: ${inv.result.references.results?.length ? `<ul style="margin:4px 0 0 18px">${inv.result.references.results.map(x => `<li>${httpLink(x.url, x.title)} <span class="tiny sub">${esc(x.publisher || "")}${x.published_at ? ` · ${esc(eat(x.published_at))}` : ""}</span></li>`).join("")}</ul>` : esc(inv.result.references.note || "none found")}</div>` : ""}
    <details class="tiny sub" style="margin-top:8px"><summary>Why it could not be read</summary>${esc(b.reason)}</details></div></div>`;
}
function fixForm(inv) {
  const p = inv.preview || {}, x = inv.result?.source || {};
  if (inv.result?.blocked || x.provenance || !["restricted", "failed", "partial"].includes(x.access || p.access)) return "";
  return `<div class="card" style="margin-top:12px"><div class="hd"><h3>Extraction was incomplete</h3></div><div class="bd">
    <p class="small">${esc(x.fallback || p.fallback || "Add what is missing and AIVS will analyse the link again.")}</p>
    <textarea id="fxText" rows="3" placeholder="Paste the text of the post or article"></textarea>
    <div class="row" style="margin-top:8px;gap:10px;flex-wrap:wrap"><label class="btn ghost sm" for="fxFile" style="cursor:pointer">Add a screenshot or file</label><input id="fxFile" type="file" multiple accept="image/*,.pdf,.docx" style="position:absolute;opacity:0;width:1px;height:1px"><span id="fxNames" class="small muted"></span>
      <button class="btn primary sm" id="fxGo">Analyse again with this</button></div><div id="fxErr" class="callout bad" style="margin-top:8px" hidden></div></div></div>`;
}
// the AI's reading of the content (Ollama), kept apart from the evidence: it is not verification
function aiFindings(a) {
  if (!a) return "";
  const ent = Object.entries(a.entities || {}).filter(([, v]) => v.length).map(([k, v]) => `${esc(k)}: ${v.map(esc).join(", ")}`).join(" · ");
  return `<div class="card" style="margin-top:12px" id="iai"><div class="hd"><h3>AI findings</h3><span class="chip grey">AI-supported, not verification · ${esc(a.model || "")}</span></div><div class="bd small">
    <div>Language: <b>${esc(a.language || "not stated")}</b>${a.sentiment?.label ? ` · Tone: <b>${esc(a.sentiment.label)}</b>${a.sentiment.towards ? ` towards ${esc(a.sentiment.towards)}` : ""}` : ""}</div>
    ${a.narratives.length ? `<div style="margin-top:6px"><b>Narratives</b><ul style="margin:2px 0 0 18px">${a.narratives.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    ${a.misleading.length ? `<div style="margin-top:6px"><b>Possibly misleading claims</b><ul style="margin:2px 0 0 18px">${a.misleading.map(m => `<li>“${esc(m.quote)}” <span class="sub">— ${esc(m.why)}</span></li>`).join("")}</ul></div>` : ""}
    ${ent ? `<div style="margin-top:6px"><b>Named in the content</b> — ${ent}</div>` : ""}
    ${a.gaps.length ? `<div style="margin-top:6px"><b>Information gaps</b><ul style="margin:2px 0 0 18px">${a.gaps.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    <p class="tiny sub" style="margin:6px 0 0">${esc(a.note)}</p></div></div>`;
}
function results(inv) {
  // nothing readable was extracted: no analysis ran, and the page says what happened and what to do instead
  if (inv.result?.blocked) { const b = inv.result.blocked, f = inv.result.source?.facebook;
    return `<div class="callout warn" style="margin-top:12px" id="iblocked"><div><b>${b.verdict === "extraction_blocked" ? "Content not available automatically" : "Insufficient content"}.</b> ${esc(b.reason)}
      <p style="margin:6px 0 0">No claim extraction, evidence search or AI analysis has run yet, because there is nothing to analyse. Nothing was guessed.</p>
      ${f?.attempts?.length ? `<p class="tiny sub" style="margin:6px 0 0">Facebook: ${esc(f.attempts.map(a => `${a.method}: ${a.result}${a.detail ? ` (${a.detail})` : ""}`).join("; "))}</p>` : ""}</div></div>${b.can_continue ? continueForm(inv, b) : ""}`; }
  const r = inv.result, o = r.overall, by = Object.fromEntries(r.evidence.map(e => [e.id, e]));
  const pv = r.source.provenance ? `<div class="callout info" style="margin-top:12px" id="iprov"><div><b>Content supplied by ${esc(r.source.provenance.supplied_by)}, not retrieved automatically.</b> ${esc(r.source.provenance.platform || "The platform")} did not allow automatic extraction${r.source.provenance.continues ? ` (report ${esc(r.source.provenance.continues)})` : ""}. Analysed: ${esc(r.source.provenance.items.join(", "))}. Original link kept: ${httpLink(r.source.provenance.original_link, r.source.provenance.original_link)}.</div></div>` : "";
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
  return `${pv}<div class="card" style="margin-top:12px;border-left:6px solid var(--${VC[o.verdict] === "grey" ? "line" : VC[o.verdict]})"><div class="bd">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><div><div class="tiny sub">Overall preliminary verdict</div><h2 style="margin:2px 0">${esc(o.label)}</h2></div><span class="chip ${VC[o.verdict]}" style="font-size:13px">Strength of the evidence: ${esc(o.strength_label)}</span></div>
      ${o.note ? `<p class="small" style="margin:6px 0">${esc(o.note)}</p>` : ""}
      <p class="small" style="margin:6px 0">${esc(r.sections.assessment.slice(0, 2).join(" "))}</p>
      <p class="tiny sub" style="margin:4px 0 0">AI-generated preliminary assessment · ${esc(r.review?.status === "reviewed" ? `reviewed by ${r.review.by}` : "not reviewed by an analyst")}. The strength label describes the evidence found, not the probability that the claim is true.${r.ai.used ? ` AI model: ${esc(r.ai.model)}.` : ` AI not used: ${esc(r.ai.reason || "")}`}</p></div></div>
    ${aiFindings(r.ai?.content)}
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
      ${!r.blocked ? `<button class="btn sm primary" id="igen" title="Write the one-page report again from the stored evidence, with the AI model if it is available now">Generate Report</button>` : ""}<a class="btn sm ${r.blocked ? "primary" : ""}" href="${base}.pdf" download>Download Report (PDF)</a><a class="btn sm" href="${base}.docx" download>Word</a><a class="btn sm ghost" href="${base}.html?download=1">HTML</a>
      <a class="btn sm ghost" id="idet" href="${base.replace(/report$/, "details")}.html" target="_blank" rel="noopener">Supporting evidence</a><a class="btn sm ghost" href="${base.replace(/report$/, "details")}.pdf" download>Evidence (PDF)</a>
      ${inv.case_id ? `<a class="btn sm ghost" href="#/case/${esc(inv.case_id)}">Open case ${esc(inv.case_id)}</a>` : ""}<a class="btn sm ghost" href="#/investigate">New investigation</a>
      ${App.can("case.approve") && !r.review?.at && inv.created_by !== App.me.id ? `<button class="btn sm ghost" id="irev">Record a review</button>` : ""}`;
    $("#irep").srcdoc = await (await fetch(`${base}.html`, { credentials: "same-origin" })).text();
    $("#invOut").hidden = false;
    const rb = $("#irev"); if (rb) rb.onclick = async () => { const note = prompt("What did you check? (recorded with your name)"); if (!note) return; try { await api.post(`/api/investigations/${encodeURIComponent(inv.id)}/review`, { note }); follow(el, id); } catch (e) { alert(errMsg(e)); } };
    const bm = $("#ctBm"); if (bm) bm.onclick = e => { e.preventDefault(); alert("Drag this button to your bookmarks bar, then use it on the post's page."); };
    const gen = $("#igen");
    if (gen) gen.onclick = async () => { gen.disabled = true; gen.textContent = "Generating…";
      try { const g = await api.post(`/api/investigations/${encodeURIComponent(inv.id)}/report`, {}); $("#irep").srcdoc = await (await fetch(`${base}.html`, { credentials: "same-origin" })).text(); gen.textContent = g.written_by === "ai" ? `Report generated (${g.ai})` : "Report generated (rule-based)"; if (g.reason) gen.title = `AI not used: ${g.reason}`; }
      catch (e) { gen.textContent = "Generate Report"; alert(errMsg(e)); } finally { gen.disabled = false; } };
    const ct = $("#ctGo");
    if (ct) ct.onclick = async () => {
      const fd = new FormData(), t = $("#ctText").value.trim(), su = $("#ctSrc").value.trim(), files = [...$("#ctShot").files, ...$("#ctMedia").files];
      if (!t && !files.length && !su) { $("#ctErr").innerHTML = "<div>Add a screenshot, image or video, the post's text, or the original source's link.</div>"; $("#ctErr").hidden = false; return; }
      if (files.length > 5) { $("#ctErr").innerHTML = "<div>Add at most 5 files.</div>"; $("#ctErr").hidden = false; return; }
      if (t) fd.append("text", t); if (su) fd.append("source_url", su); for (const f of files) fd.append("files", f);
      ct.disabled = true; ct.textContent = "Continuing…";
      try { const n = await api.upload(`/api/investigations/${encodeURIComponent(inv.id)}/rerun`, fd); location.hash = `#/investigate/${n.id}`; } catch (e) { $("#ctErr").innerHTML = `<div>${esc(errMsg(e))}</div>`; $("#ctErr").hidden = false; ct.disabled = false; ct.textContent = "Continue the investigation"; } };
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
  const L = { extraction_blocked: "Extraction blocked", insufficient_content: "Insufficient content", supported: "Supported", contradicted: "Contradicted", misleading: "Misleading or missing context", insufficient: "Insufficient evidence", not_verifiable: "Unverifiable", mixed: "Insufficient evidence (sources disagree)" };
  return `<div class="tablewrap"><table class="t"><thead><tr><th>Investigation date</th><th>Report</th><th>Subject</th><th>Source published</th><th>Assessment</th><th>Review</th><th>Export</th></tr></thead><tbody>${list.map(x => `<tr>
    <td class="small">${esc(eat(x.created_at))}</td><td class="mono small"><a href="#/investigate/${esc(x.id)}">${esc(x.report_id)}</a></td><td class="small">${esc((x.subject || (x.status === "failed" ? "Stopped: " + (x.error || "") : x.status)).slice(0, 90))}${x.case_id ? ` <a class="tiny" href="#/case/${esc(x.case_id)}">${esc(x.case_id)}</a>` : ""}</td>
    <td class="small">${x.source_published_at ? esc(eat(x.source_published_at)) : "Not known"}</td><td>${x.overall ? `<span class="chip ${VC[x.overall] || "grey"}">${esc(L[x.overall] || x.overall)}</span>` : `<span class="chip grey">${esc(x.status)}</span>`}</td>
    <td class="small">${x.reviewed_at ? `Reviewed by ${esc(x.reviewed_by_name)}` : "Not reviewed"}</td>
    <td>${x.status === "done" ? `<div class="row"><a class="btn sm ghost" href="/api/investigations/${esc(x.id)}/report.pdf" download>PDF</a><a class="btn sm ghost" href="/api/investigations/${esc(x.id)}/report.docx" download>Word</a></div>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
}

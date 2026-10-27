// Automatic single-page report for one-click investigations: Background, Analysis, Assessment, Recommendations,
// References. Rendered as HTML, PDF (pdfkit) and Word (.docx written directly as Office Open XML). Every value from
// the submission or from sources is escaped; only http(s) links are clickable. Always labelled as AI-generated and
// not reviewed, unless a person has actually reviewed it.
import zlib from "node:zlib";
import PDFDocument from "pdfkit";
import { AUTO_VERDICTS, STRENGTH } from "./autoeval.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isHttp = u => /^https?:\/\//i.test(String(u || ""));
// all times in East Africa Time (UTC+3, no daylight saving)
export const eat = (iso, withTime = true) => { if (!iso) return "Not known"; if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) withTime = false;   // a date without a time is not given one
  const d = new Date(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? `${iso}T00:00:00+03:00` : iso) + 3 * 3600e3); if (isNaN(d)) return "Not known";
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()], p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${m} ${d.getUTCFullYear()}${withTime ? `, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} EAT` : ""}`; };
const cites = ids => ids.length ? " " + ids.slice(0, 4).map(i => `[${i}]`).join(" ") : "";

// ---------------------------------------------------------------- rule-based writer
export function writeSections(r) {
  const x = r.source, o = r.overall;
  const kind = { url: "a link", text: "pasted text", image: "an image or screenshot", document: "a document" }[x.input_type] || "a submission";
  const bg = [`The submission was ${kind}${x.platform ? ` from ${x.platform}` : ""}${x.title ? `, titled “${x.title}”` : ""}.`];
  const who = [x.author && `attributed to ${x.author} (${x.author_basis || "basis not stated"})`, x.published_at && `dated ${eat(x.published_at)} (${x.published_basis || "basis not stated"})`].filter(Boolean);
  bg.push(who.length ? `It is ${who.join(" and ")}.` : "No author or publication date could be established from the submission.");
  const chk = r.claims.filter((c, i) => r.assessments[i].verdict !== "not_verifiable" || c.claim_type === "factual");
  bg.push(r.claims.length ? `${r.claims.length} claim(s) were identified, ${chk.length} of them checkable against evidence.` : "No claim could be identified in the submission.");
  const ent = r.entities || {}, ctx = [ent.locations?.length && `places: ${ent.locations.slice(0, 5).join(", ")}`, ent.orgs?.length && `organisations: ${ent.orgs.slice(0, 5).join(", ")}`].filter(Boolean);
  if (ctx.length) bg.push(`It refers to ${ctx.join(" and ")}.`);

  const ok = r.search.filter(s => s.status === "ok" || s.status === "partial").map(s => s.label);
  const an = [ok.length ? `Evidence was searched in ${ok.join(", ")}: ${r.evidence.length} item(s) were compared, ${r.evidence.filter(e => !e.repeat_of).length} of them independent.`
    : "No evidence source could be searched, so the claims could not be compared with outside evidence."];
  r.claims.forEach((c, i) => { const a = r.assessments[i]; an.push(`Claim ${c.seq} (“${c.text.slice(0, 140)}”): ${AUTO_VERDICTS[a.verdict].toLowerCase()}. ${a.reason}${cites([...a.supporting, ...a.contradicting])}`); });
  const reps = r.evidence.filter(e => /near-identical/.test(e.repeat_reason || ""));
  if (reps.length) an.push(`${reps.length} item(s) repeat the wording of another item and were counted once, as repeated reporting of the same source.`);
  const early = r.evidence.filter(e => /before the claim/.test(e.date_note || "") && e.relevance >= 0.35);
  if (early.length) an.push(`Some closely matching reports were published well before the submission's date, which can indicate an earlier event or recycled content.${cites(early.map(e => e.id))}`);
  const dis = r.evidence.filter(e => e.ai_disagrees);
  if (dis.length) an.push(`The AI model read ${dis.length} source(s) differently from the rule-based comparison; the rules decided, and these sources should be checked by a person.${cites(dis.map(e => e.id))}`);
  if (r.io.observed.length) an.push(`Indicators observed: ${r.io.observed.slice(0, 4).map(i => i.indicator.replace(/\.$/, "")).join("; ")}.`);
  const gaps = r.claims.filter((c, i) => r.assessments[i].verdict === "insufficient").map(c => `claim ${c.seq}`);
  if (gaps.length) an.push(`Information gaps: no decisive evidence for ${gaps.join(", ")}.`);

  const as = [`Overall: ${o.label}. Strength of the available evidence: ${o.strength_label.toLowerCase()}.${o.note ? ` ${o.note}` : ""}`, r.io.assessment];
  if (["restricted", "failed"].includes(x.access)) as.push("The original content could not be fully read, which limits this assessment.");
  if (r.media?.images?.length) as.push(r.media.reuse.length ? "Image findings: at least one image appears to be reused from an earlier context (see Image verification)." : `Image findings: ${r.media.images.length} image(s) were checked; no sign of reuse of an older image was found in the reference archive${r.media.services?.reverse_search?.configured ? " or by reverse-image search" : ""}. This does not show that the images are original or unaltered.`);
  if (["insufficient", "mixed"].includes(o.verdict)) as.push("The claim should not be treated as established or as false until stronger evidence is available.");

  const rec = [];
  if (o.verdict === "contradicted") rec.push("Treat the claim as false or misleading as presented, and cite the contradicting sources when responding.", "Continue monitoring the narrative: add its key terms to an AI Watchlist.");
  else if (o.verdict === "supported") rec.push("The claim is consistent with independent reliable sources; keep the cited sources with the record.", "Check that attached media, dates and places match the supported event before reuse.");
  else if (o.verdict === "misleading") rec.push("Do not repeat the content as presented: explain what context is missing (for example an older image or event shown as new).", "Find the original source and date of the image or statement, and cite them when responding.", "Continue monitoring the narrative in AI Watchlist.");
  else if (o.verdict === "mixed") rec.push("Seek confirmation from an authoritative source (the responsible ministry, county or agency).", "Compare the conflicting sources' dates and origins before drawing a conclusion.");
  else if (o.verdict === "insufficient" && /disagree/.test(o.note || "")) rec.push("Sources disagree: seek confirmation from an authoritative source (the responsible ministry, county or agency).", "Compare the conflicting sources' dates and origins, and avoid drawing conclusions until they are resolved.");
  else if (o.verdict === "insufficient") rec.push("Avoid drawing conclusions until additional evidence is available.", "Seek confirmation from an authoritative source or a fact-checking organisation.", "Flag the claim for further investigation and run the search again later.");
  else rec.push("No factual claim can be checked here; assess the content's purpose and spread instead of its truth.");
  if (r.hashtags?.length) rec.push(`Monitor the related hashtags in AI Watchlist: ${r.hashtags.slice(0, 5).join(" ")}.`);
  if (x.fallback) rec.push(x.fallback);
  if (r.media?.images?.length && !r.media.services?.reverse_search?.configured) rec.push("Run a reverse-image search on the image(s) (for example with Google Lens or TinEye) to find their earliest appearance; automatic reverse search is not configured.");
  if (!ok.length) rec.push("Configure at least one evidence source (Settings → Service status) and analyse again.");
  return { background: bg, analysis: an, assessment: as, recommendations: rec };
}
export function limitations(r) {
  const out = ["This report was generated automatically by AIVS and has not been reviewed or approved by an analyst.",
    "Search results show what sources say, not that a claim is true; only the sources listed were consulted.",
    `Relevance: ${r.methods.similarity}. Evidence stance: ${r.methods.stance}.`,
    "Strength labels are qualitative; no calibrated confidence percentage is given because none has been evaluated."];
  out.push(r.ai.used ? `Parts of the text were drafted by the AI model ${r.ai.model} from the listed evidence and checked automatically; verdicts were set by fixed rules, not by the model.`
    : `AI model not used: ${r.ai.reason || "not available"} The text was written by AIVS's rule-based writer.`);
  for (const n of r.source.notes || []) out.push(n);
  const failed = r.search.filter(s => s.status === "error" || s.status === "partial");
  if (failed.length) out.push(`Searches that failed: ${failed.map(s => `${s.label} (${String(s.errors?.[0] || "error").slice(0, 80)})`).join("; ")}.`);
  return out;
}

// ---------------------------------------------------------------- references
export function references(r) {
  const ids = [...new Set(r.claims.flatMap(c => r.top[c.id] || []))], by = Object.fromEntries(r.evidence.map(e => [e.id, e]));
  return { main: ids.map(i => by[i]).filter(Boolean), rest: r.evidence.filter(e => !ids.includes(e.id)) };
}
const STANCE = { supports: "supports", contradicts: "contradicts", misleading: "says it is misleading or lacks context", related: "related only" };
// what the investigation could and could not do, for the report header
export function completion(r) {
  const issues = [];
  if (["restricted", "failed"].includes(r.source.access)) issues.push("the original content could not be fully read");
  else if (r.source.access === "partial") issues.push("only part of the original content could be read");
  if (!r.search.some(s => (s.status === "ok" || s.status === "partial") && !["kb", "holdings"].includes(s.key))) issues.push("no outside evidence source could be searched");
  if (r.search.some(s => s.status === "error" || s.status === "partial")) issues.push("some evidence searches failed");
  if (!r.ai.used) issues.push("AI analysis was not used");
  return { status: issues.length ? "Completed with limitations" : "Completed", issues };
}

// ---------------------------------------------------------------- HTML
const VC = { extraction_blocked: "#b42318", insufficient_content: "#b54708", supported: "#0f7a4a", contradicted: "#b42318", misleading: "#b54708", mixed: "#475467", insufficient: "#475467", not_verifiable: "#475467" };
const CSS = `:root{--ink:#101828;--muted:#475467;--line:#d0d5dd;--navy:#0b1f3a}*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.rep{max-width:880px;margin:0 auto;padding:24px 20px}.top{border-bottom:3px solid var(--navy);padding-bottom:10px;margin-bottom:12px}.top h1{font-size:20px;margin:0 0 6px}
.lab{display:inline-block;background:#fef0c7;color:#7a2e0e;border:1px solid #fedf89;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600}.lab.ok{background:#d1fadf;color:#05603a;border-color:#a6f4c5}.lab.tr{background:#ece6ff;color:#3e1c96;border-color:#d9ccff}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:4px 16px;font-size:12.5px;color:var(--muted);margin-top:8px}.meta b{color:var(--ink)}
.v{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-left:6px solid var(--vc);border-radius:6px;padding:10px 14px;margin:12px 0}.v b{font-size:18px;color:var(--vc)}.v span{color:var(--muted)}
h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--navy);border-bottom:1px solid var(--line);padding-bottom:3px;margin:16px 0 6px}p{margin:4px 0}ul,ol{margin:4px 0;padding-left:20px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0}th,td{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted)}
.tag{display:inline-block;border-radius:10px;padding:0 8px;font-size:12px;font-weight:600;color:#fff;background:var(--vc);white-space:nowrap}.s{font-size:12px;color:var(--muted)}a{color:#0b6563}.refs{list-style:none;padding:0}.refs li{margin-bottom:6px}
details{margin-top:10px;border:1px solid var(--line);border-radius:6px;padding:6px 10px}summary{cursor:pointer;font-weight:600}@media print{details{display:none}.rep{padding:0}}
@media (max-width:560px){.rep{padding:14px}.top h1{font-size:18px}th:nth-child(3),td:nth-child(3){display:none}}`;
const link = (u, t) => isHttp(u) ? `<a href="${esc(u)}" rel="noopener noreferrer" target="_blank">${esc(t || u)}</a>` : esc(t || u);
const withCites = (s, ids) => esc(s).replace(/\[(E-\d+)\]/g, (m, id) => ids.has(id) ? `<a href="#${id}">[${id}]</a>` : m);
export function label(r) { return r.review?.status === "reviewed" ? `AI-generated · reviewed by ${r.review.by} on ${eat(r.review.at)}` : "AI-generated · not reviewed by an analyst"; }
const imgHtml = (r, images) => {
  const list = (r.media?.images || []);
  if (!list.length) return "";
  return `<h2>Image verification</h2>${list.map(i => { const d = images.find(x => x.media_id === i.media_id);
    return `<div style="display:flex;gap:12px;align-items:flex-start;margin:8px 0;flex-wrap:wrap">${d?.dataUri ? `<img src="${d.dataUri}" alt="${esc(i.name)}" style="max-width:220px;max-height:180px;border:1px solid var(--line);border-radius:4px">` : ""}
    <div style="flex:1;min-width:220px"><div class="s"><b>${esc(i.name)}</b>${i.width ? ` · ${i.width}×${i.height}` : ""}${i.link ? ` · ${esc(i.link.source)} · ${link(i.link.url, "image link")}` : ""}</div>
    <ul>${i.observations.map(o => `<li>${esc(o.text)}${o.strength === "ai" ? ' <span class="s">(AI, not verified)</span>' : ""}</li>`).join("")}</ul>${i.reverse?.pages?.length ? `<div class="s">Pages with this image: ${i.reverse.pages.slice(0, 5).map(p => link(p.url, p.title || p.url)).join(" · ")}</div>` : ""}</div></div>`; }).join("")}<p class="s">${esc(r.media.note)}</p>`;
};
export function toHtml(r, { standalone = true, images = [] } = {}) {
  const o = r.overall, x = r.source, ids = new Set(r.evidence.map(e => e.id)), { main, rest } = references(r), S = r.sections;
  const ref = e => `<li id="${esc(e.id)}"><b>[${esc(e.id)}]</b> ${link(e.source_url, e.source_title || e.reference)}<div class="s">${esc(e.publisher)} · ${esc(e.source_published_at ? eat(e.source_published_at, false) : "date not known")} · ${esc(e.tier_label)} · claim ${esc(e.claim_seq)}: ${esc(STANCE[e.stance])} (${esc(e.stance_basis)})${e.ai_stance ? ` · AI reading: ${esc(STANCE[e.ai_stance])}${e.ai_disagrees ? " (differs; check this source)" : ""}` : ""}${e.rating ? ` · rating “${esc(e.rating)}”` : ""}${e.repeat_of ? ` · repeats ${esc(e.repeat_of)}` : ""} · found via ${esc(e.connector_label)}, ${esc(eat(e.retrieved_at))}</div></li>`;
  const rows = r.claims.map((c, i) => { const a = r.assessments[i]; return `<tr><td>${c.seq}</td><td>${esc(c.text)}<div class="s">${esc(a.reason)}</div></td><td>${esc(STRENGTH[a.strength])}</td><td><span class="tag" style="--vc:${VC[a.verdict]}">${esc(AUTO_VERDICTS[a.verdict])}</span></td></tr>`; }).join("");
  const ind = r.io.observed.map(i => `<li>${esc(i.indicator)}${i.cue ? ` <span class="s">(seen: “${esc(i.cue)}”)</span>` : ""}<div class="s">${esc(i.check)}</div></li>`).join("");
  const body = `<div class="rep"><div class="top"><div class="s" style="letter-spacing:.06em;font-weight:700;color:var(--navy)">AIVS — SUPPORTING EVIDENCE AND INVESTIGATION DETAILS</div><h1>${esc(r.subject)}</h1><span class="lab${r.review?.status === "reviewed" ? " ok" : ""}">${esc(label(r))}</span>${r.training ? ' <span class="lab tr">Training case (synthetic material)</span>' : ""}
  <div class="meta"><div><b>Report</b> ${esc(r.report_id)}</div><div><b>Investigation date</b> ${esc(eat(r.created_at))}</div><div><b>Source published</b> ${esc(x.published_at ? eat(x.published_at) : "Not known")}</div>
  <div><b>Analysis completed</b> ${esc(eat(r.completed_at))}</div><div><b>Source</b> ${x.url ? link(x.url, x.platform || x.url) : esc(x.platform || x.input_type)}</div><div><b>Case</b> ${r.case_id ? esc(r.case_id) : "not created (no readable content)"}</div></div></div>
  <div class="v" style="--vc:${VC[o.verdict]}"><b>${esc(o.label)}</b><span>Strength of the evidence: ${esc(o.strength_label)} · ${esc(completion(r).status)}${completion(r).issues.length ? ` (${esc(completion(r).issues.join("; "))})` : ""}</span></div>
  <p class="s">The strength label describes the evidence found, not the probability that the claim is true. It is an AI-generated preliminary assessment; consequential decisions need human review.</p>
  ${x.url || x.title || r.content ? `<h2>Original content</h2>${x.title ? `<p><b>${esc(x.title)}</b></p>` : ""}${x.description ? `<p class="s">${esc(x.description)}</p>` : ""}${(() => { const m = (images.find(i => i.dataUri && r.media?.images?.[0]?.media_id === i.media_id)); return m ? `<img src="${m.dataUri}" alt="Image from the content" style="max-width:100%;max-height:260px;border:1px solid var(--line);border-radius:4px;margin:4px 0">` : ""; })()}
  <p class="s" style="white-space:pre-wrap">${esc(String(r.content || "").slice(0, 1200))}${String(r.content || "").length > 1200 ? "…" : ""}</p>
  <p class="s">${[x.author && `Author: ${esc(x.author)}`, x.publisher && `Publisher: ${esc(x.publisher)}`, r.hashtags?.length && `Hashtags: ${esc(r.hashtags.join(" "))}`, x.mentions?.length && `Mentions: ${esc(x.mentions.join(" "))}`, x.metrics && `Engagement (public counts): ${esc(Object.entries(x.metrics).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(", "))}`, x.video && `Video: ${esc([x.video.title, x.video.duration, x.video.channel].filter(Boolean).join(" · "))}`].filter(Boolean).join(" · ")}</p>` : ""}
  ${r.written_by === "ai" ? `<p class="s"><b>Sections A–D were drafted by the AI model ${esc(r.ai.model)} from the listed evidence and checked automatically. The assessment labels come from fixed rules.</b></p>` : ""}
  <h2>A. Background</h2>${S.background.map(s => `<p>${withCites(s, ids)}</p>`).join("")}
  <h2>B. Analysis</h2>${S.analysis.map(s => `<p>${withCites(s, ids)}</p>`).join("")}${rows ? `<table><tr><th>#</th><th>Claim</th><th>Evidence strength</th><th>Assessment</th></tr>${rows}</table>` : ""}
  <h2>C. Assessment</h2>${S.assessment.map(s => `<p>${withCites(s, ids)}</p>`).join("")}${ind ? `<p class="s"><b>Information operations indicators (observed):</b></p><ul>${ind}</ul>` : ""}
  <p class="s"><b>Limitations:</b> ${r.limitations.map(esc).join(" ")}</p>
  <h2>D. Recommendations</h2><ul>${S.recommendations.map(s => `<li>${withCites(s, ids)}</li>`).join("")}</ul>
  ${imgHtml(r, images)}
  <h2>E. References</h2>${main.length ? `<ol class="refs">${main.map(ref).join("")}</ol>` : '<p class="s">No relevant evidence was retrieved.</p>'}
  ${rest.length ? `<details><summary>Supplementary evidence (${rest.length} more item${rest.length > 1 ? "s" : ""}, kept for audit)</summary><ol class="refs">${rest.map(ref).join("")}</ol></details>` : ""}
  <p class="s" style="margin-top:14px">Generated by AIVS ${esc(r.version)}. Text drafted by ${r.written_by === "ai" ? `the AI model ${esc(r.ai.model)} (checked)` : "the AIVS rule-based writer"}. Times in East Africa Time (UTC+3).</p></div>`;
  return standalone ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${esc(r.report_id)} · Supporting evidence and investigation details</title><style>${CSS}</style></head><body>${body}</body></html>` : body;
}

// ---------------------------------------------------------------- PDF
let replaced = 0;
const safe = s => String(s ?? "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/…/g, "...").replace(/·/g, "-").replace(/→/g, "->").replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/gu, () => { replaced++; return "?"; });
export function toPdf(r, { images = [] } = {}) {
  replaced = 0;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 48, bottom: 54, left: 50, right: 50 }, info: { Title: `${r.report_id} - AIVS report`, Author: "AIVS (automatic)", Subject: safe(r.subject) } });
    const chunks = []; doc.on("data", c => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const W = doc.page.width - 100, NAVY = "#0b1f3a", MUTED = "#475467";
    const p = (t, o = {}) => doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(o.size || 9.5).fillColor(o.color || "#101828").text(safe(t), { width: W, ...o.opts });
    const h2 = t => { doc.moveDown(0.6); p(t.toUpperCase(), { bold: true, size: 10.5, color: NAVY }); const y = doc.y + 1; doc.moveTo(50, y).lineTo(50 + W, y).lineWidth(0.8).strokeColor("#d0d5dd").stroke(); doc.moveDown(0.3); };
    const y0 = doc.y; doc.rect(50, y0, W, 18).fill(r.review?.status === "reviewed" ? "#05603a" : "#8a5300"); doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9).text(safe(label(r)).toUpperCase(), 58, y0 + 5, { width: W - 16 }); doc.y = y0 + 24;
    if (r.training) p("TRAINING CASE - synthetic material for practice.", { bold: true, size: 8.5, color: "#5b3fc4" });
    p(r.subject, { bold: true, size: 15, color: NAVY }); doc.moveDown(0.3);
    p(`Report ${r.report_id}  |  Investigation ${eat(r.created_at)}  |  Source published ${r.source.published_at ? eat(r.source.published_at) : "not known"}  |  Completed ${eat(r.completed_at)}${r.case_id ? `  |  Case ${r.case_id}` : ""}`, { size: 8, color: MUTED });
    if (r.source.url) p(`Source: ${r.source.url}`, { size: 8, color: MUTED });
    doc.moveDown(0.4); p(`${r.overall.label}  -  strength of the evidence: ${r.overall.strength_label}`, { bold: true, size: 12, color: VC[r.overall.verdict] });
    const cp = completion(r); p(`Status: ${cp.status}${cp.issues.length ? ` (${cp.issues.join("; ")})` : ""}. AI-generated preliminary assessment; the strength label describes the evidence, not the probability that the claim is true.`, { size: 8, color: MUTED });
    h2("Original content");
    if (r.source.title) p(r.source.title, { bold: true });
    const first = images.find(i => i.buffer && i.media_id === r.media?.images?.[0]?.media_id);
    if (first) { try { doc.image(first.buffer, { fit: [W * 0.6, 170] }); doc.moveDown(0.3); } catch { p("(The image could not be drawn in the PDF.)", { size: 8, color: MUTED }); } }
    p(String(r.content || "").slice(0, 1200) + (String(r.content || "").length > 1200 ? "..." : ""), { size: 8.5 });
    const meta = [r.source.author && `Author: ${r.source.author}`, r.source.publisher && `Publisher: ${r.source.publisher}`, r.hashtags?.length && `Hashtags: ${r.hashtags.join(" ")}`, r.source.metrics && `Engagement: ${Object.entries(r.source.metrics).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(", ")}`].filter(Boolean);
    if (meta.length) p(meta.join("  |  "), { size: 8, color: MUTED });
    p("Detected claims:", { bold: true, size: 9 }); r.claims.forEach((c, i) => p(`${c.seq}. ${c.text} - ${AUTO_VERDICTS[r.assessments[i].verdict]}`, { size: 8.5 }));
    h2("A. Background"); r.sections.background.forEach(s => p(s));
    h2("B. Analysis"); r.sections.analysis.forEach(s => { p(s); doc.moveDown(0.15); });
    h2("C. Assessment"); r.sections.assessment.forEach(s => p(s));
    if (r.io.observed.length) { doc.moveDown(0.2); p("Information operations indicators (observed):", { bold: true, size: 9 }); r.io.observed.forEach(i => p(`- ${i.indicator}${i.cue ? ` (seen: "${i.cue}")` : ""}`, { size: 8.5 })); }
    doc.moveDown(0.2); p(`Limitations: ${r.limitations.join(" ")}`, { size: 8, color: MUTED });
    if (r.media?.images?.length) {
      h2("Image verification");
      for (const i of r.media.images) { p(`${i.name}${i.width ? ` (${i.width}x${i.height})` : ""}${i.link ? ` - ${i.link.source}` : ""}`, { bold: true, size: 8.5 }); for (const o of i.observations) p(`- ${o.text}${o.strength === "ai" ? " (AI, not verified)" : ""}`, { size: 8 }); }
      p(r.media.note, { size: 7.5, color: MUTED });
    }
    h2("D. Recommendations"); r.sections.recommendations.forEach(s => p(`- ${s}`));
    h2("E. References"); const { main, rest } = references(r);
    if (!main.length) p("No relevant evidence was retrieved.", { size: 8.5, color: MUTED });
    for (const e of main) { p(`[${e.id}] ${e.source_title || e.reference}`, { bold: true, size: 8.5 }); p(`${e.publisher} - ${e.source_published_at ? eat(e.source_published_at, false) : "date not known"} - ${e.tier_label} - claim ${e.claim_seq}: ${STANCE[e.stance]}${e.rating ? ` - rating "${e.rating}"` : ""}${e.source_url ? ` - ${e.source_url}` : ""}`, { size: 7.5, color: MUTED }); doc.moveDown(0.15); }
    if (rest.length) p(`${rest.length} further evidence item(s) are kept in the investigation record for audit (see the HTML report).`, { size: 8, color: MUTED });
    if (replaced) p(`${replaced} character(s) outside the PDF font were shown as "?"; the HTML and Word reports keep the exact text.`, { size: 7.5, color: MUTED });
    doc.end();
  });
}

// ---------------------------------------------------------------- Word (.docx, Office Open XML in a zip)
const xml = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
const run = (t, { b, color, size } = {}) => `<w:r><w:rPr>${b ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}${size ? `<w:sz w:val="${size}"/>` : ""}</w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
const para = (t, o = {}) => `<w:p>${o.style ? `<w:pPr><w:pStyle w:val="${o.style}"/></w:pPr>` : ""}${run(t, o)}</w:p>`;
function zip(files) {
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const local = [], central = []; let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8"), comp = zlib.deflateRawSync(data), n = Buffer.from(name), c = crc(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(0x00210000, 10); h.writeUInt32LE(c, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(0x00210000, 12); cd.writeUInt32LE(c, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(off, 42);
    local.push(h, n, comp); central.push(cd, n); off += 30 + n.length + comp.length;
  }
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cdBuf, end]);
}
export function toDocx(r) {
  const { main, rest } = references(r), P = [];
  P.push(para(label(r), { b: true, color: "7A2E0E" }), para(r.subject, { style: "Title" }));
  for (const [k, v] of [["Report", r.report_id], ["Investigation date", eat(r.created_at)], ["Source published", r.source.published_at ? eat(r.source.published_at) : "Not known"], ["Analysis completed", eat(r.completed_at)],
    ["Source", r.source.url || r.source.platform || r.source.input_type], ["Case", r.case_id || "not created"], ["Overall assessment", `${r.overall.label} (evidence strength: ${r.overall.strength_label})`]])
    P.push(`<w:p>${run(`${k}: `, { b: true })}${run(v)}</w:p>`);
  const sec = (t, lines, bullet) => { P.push(para(t, { style: "Heading1" })); for (const s of lines) P.push(para(bullet ? `• ${s}` : s)); };
  sec("A. Background", r.sections.background); sec("B. Analysis", r.sections.analysis);
  r.claims.forEach((c, i) => P.push(para(`Claim ${c.seq}: ${c.text} — ${AUTO_VERDICTS[r.assessments[i].verdict]} (strength: ${STRENGTH[r.assessments[i].strength]})`, { b: true })));
  if (r.content) { P.push(para("Original content", { style: "Heading1" })); if (r.source.title) P.push(para(r.source.title, { b: true })); P.push(para(String(r.content).slice(0, 1500))); }
  if (r.media?.images?.length) { P.push(para("Image verification", { style: "Heading1" })); for (const i of r.media.images) { P.push(para(i.name, { b: true })); for (const o of i.observations) P.push(para(`• ${o.text}${o.strength === "ai" ? " (AI, not verified)" : ""}`)); } P.push(para("The images are in the PDF and HTML reports.", { size: 18, color: "475467" })); }
  sec("C. Assessment", r.sections.assessment); for (const i of r.io.observed) P.push(para(`• Indicator (observed): ${i.indicator}`));
  P.push(para(`Limitations: ${r.limitations.join(" ")}`, { size: 18, color: "475467" }));
  sec("D. Recommendations", r.sections.recommendations, true);
  P.push(para("E. References", { style: "Heading1" }));
  for (const e of main) P.push(para(`[${e.id}] ${e.source_title || e.reference} — ${e.publisher}, ${e.source_published_at ? eat(e.source_published_at, false) : "date not known"}. ${e.source_url || ""} (${STANCE[e.stance]}; ${e.tier_label}; retrieved ${eat(e.retrieved_at)})`));
  if (rest.length) P.push(para(`${rest.length} further item(s) are kept in the investigation record for audit.`));
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:color w:val="0B1F3A"/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="0B1F3A"/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${P.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`]
  ]);
}

// a Word package around a ready <w:body> element (used by the details report and the one-page assessment)
export function docxFromBody(bodyXml) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="19"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}>${bodyXml}</w:document>`]
  ]);
}

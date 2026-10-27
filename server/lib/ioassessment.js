// AIVS — Information Operations Assessment Report (1.25): a one-page analytical support product.
// Built automatically from a completed investigation (or a case): Background, Analysis, Assessment, Recommendations,
// up to three key references, one limitation and the report status. British English, calibrated wording, word limits.
// Rules: nothing is invented (only the investigation's own records are used); references are numbered [1]–[3] and each
// is checked for whether it addresses the claim; coordination, hostile intent, foreign involvement or attribution are
// never stated without supporting data; "Approved" is shown only when an approval was actually recorded.
// The full evidence stays in the Supporting evidence / investigation details report (autoreport.js).
import { AUTO_VERDICTS } from "./autoeval.js";

export const LIMITS = { background: [60, 80], analysis: [100, 130], assessment: [70, 100], recommendations: [50, 70] };
export const words = s => String(s || "").trim().split(/\s+/).filter(Boolean).length;
// keep whole sentences up to the word limit (a sentence that would cross the limit is left out, never cut mid-way)
export function fit(sentences, max) {
  const out = []; let n = 0;
  for (const s of sentences.filter(Boolean)) { const w = words(s); if (n + w > max) { if (!out.length) { out.push(s.split(/\s+/).slice(0, max).join(" ").replace(/[,;:]?$/, "…")); n = max; } continue; } out.push(s); n += w; }
  return out.join(" ");
}
const eatDate = (iso, time = false) => { if (!iso) return null; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00+03:00` : iso); if (isNaN(d)) return null;
  const e = new Date(d.getTime() + 3 * 3600e3), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], p = n => String(n).padStart(2, "0");
  return `${p(e.getUTCDate())} ${M[e.getUTCMonth()]} ${e.getUTCFullYear()}${time && !/^\d{4}-\d{2}-\d{2}$/.test(iso) ? ` ${p(e.getUTCHours())}${p(e.getUTCMinutes())}hrs EAT` : ""}`; };
const short = (t, n) => { const w = String(t || "").replace(/\s+/g, " ").trim().split(" "); return w.length > n ? w.slice(0, n).join(" ") + "…" : w.join(" "); };
const lc = s => s && !/^.[A-Z0-9]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; // keep acronyms and capitalised words ("PRACTICE", "KDF")
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const firstSentence = t => String(t || "").split(/(?<=[.!?])\s+/)[0].replace(/[.!?…]+$/, "");
const tierName = t => String(t || "").replace(/\s*\(.*\)\s*/g, "").trim();
const TOPIC = [[/\b(health|cholera|malaria|covid|corona|virus|vaccin|hospital|disease|outbreak|5g)\b/i, "public health"], [/\b(kdf|defence|defense|army|soldier|military|police|security|attack|al-?shabaab)\b/i, "security and the armed forces"],
  [/\b(election|iebc|vote|ballot|polling)\b/i, "elections"], [/\b(flood|drought|disaster|emergency|fire|earthquake)\b/i, "a disaster or emergency"], [/\b(m-?pesa|fee|ksh|shilling|loan|investment|fraud|scam)\b/i, "finance or fraud"],
  [/\b(recruit|job|vacanc|ajira|nafasi)\b/i, "recruitment"], [/\b(school|exam|knec|education)\b/i, "education"]];
const topicOfText = t => (TOPIC.find(([re]) => re.test(t)) || [])[1] || null;

// ---------------------------------------------------------------- references: up to three, each checked against the claim
function pickReferences(r) {
  const main = mainClaim(r), mine = r.evidence.filter(e => !main || e.claim_id === main.id);
  // only sources that actually address the claim are cited: they support it, contradict it, rate it, or report the same event with different figures
  const addresses = e => e.stance !== "related" || (/different figures/.test(e.stance_basis || "") && (e.relevance || 0) >= 0.3);
  const rank = e => (e.rating ? 3 : 0) + ({ official: 2, fact_checker: 2, knowledge_base: 1.5, news: 1 }[e.tier] || 0) + (e.stance !== "related" ? 1.5 : 0) + (e.relevance || 0) - (e.repeat_of ? 2 : 0);
  // every contradicting or "misleading" source that addresses the claim is preferred, then the best supporting ones
  const sorted = [...mine].filter(e => e.source_url || e.reference).sort((a, b) => (b.stance === "contradicts" || b.stance === "misleading") - (a.stance === "contradicts" || a.stance === "misleading") || rank(b) - rank(a));
  return sorted.filter(addresses).slice(0, 3).map((e, i) => ({ n: i + 1, id: e.id, url: /^https?:\/\//i.test(e.source_url || "") ? e.source_url : null, title: short(e.source_title || e.reference, 11), publisher: e.publisher || e.domain,
    date: eatDate(e.source_published_at && e.source_published_at.slice(0, 10)), tier: e.tier_label, stance: e.stance, rating: e.rating || null,
    figures: /different figures/.test(e.stance_basis || ""),
    addresses: e.stance === "supports" ? "supports the claim" : e.stance === "contradicts" ? "contradicts the claim" : e.stance === "misleading" ? "rates the claim misleading" : /different figures/.test(e.stance_basis || "") ? "reports different figures" : "does not settle the claim" }));
}
function mainClaim(r) {
  const chk = r.claims.map((c, i) => ({ c, a: r.assessments[i] })).filter(x => x.a.verdict !== "not_verifiable");
  return (chk.find(x => x.a.verdict === r.overall.verdict) || chk[0] || { c: r.claims[0] }).c || null;
}

// ---------------------------------------------------------------- the four sections (rule-based, British English)
export function buildAssessment(r, { priority = null, approval = null } = {}) {
  const x = r.source, o = r.overall, main = mainClaim(r), mi = main ? r.claims.indexOf(main) : -1, ma = mi >= 0 ? r.assessments[mi] : null;
  const refs = pickReferences(r), cite = id => { const f = refs.find(f => f.id === id); return f ? ` [${f.n}]` : ""; };
  const text = `${r.content || ""} ${r.claims.map(c => c.text).join(" ")}`, topic = topicOfText(text);
  const kind = x.input_type === "url" ? (x.platform && !/website/i.test(x.platform) && !["Website"].includes(x.platform) && /X \(|Facebook|Instagram|TikTok|YouTube|Telegram|Threads|WhatsApp|Reddit|LinkedIn/.test(x.platform) ? "post" : "article") : x.input_type === "image" ? "image" : x.input_type === "document" ? "document" : "message";
  const places = (r.entities?.locations || []).slice(0, 3), orgs = (r.entities?.orgs || []).slice(0, 3);
  const pub = eatDate(x.published_at && x.published_at.slice(0, 10)), recv = eatDate(r.created_at);
  const indicators = r.io?.observed || [], amplification = indicators.filter(i => ["repetition", "dataset", "amplification", "spread"].includes(i.kind)), content = indicators.filter(i => i.kind === "content");

  // 1. BACKGROUND (60–80 words)
  const who = [x.author && `attributed to ${x.author}`, x.platform && `on ${x.platform}`].filter(Boolean).join(" ");
  const bg = [
    main ? `${kind === "image" ? "An" : "A"} ${kind}${who ? ` ${who}` : ""} claims that ${lc(short(main.text.replace(/[.!]+$/, ""), 32))}.` : `${kind === "image" ? "An" : "A"} ${kind}${who ? ` ${who}` : ""} was submitted, but no checkable claim could be identified.`,
    x.provenance ? (x.provenance.continues ? `${x.provenance.platform || "The platform"} did not allow automatic extraction; the content was supplied by an analyst, not retrieved automatically.` : "The content was captured by an analyst from their own browser view, not retrieved automatically.") : null,
    pub ? `It was published on ${pub}${x.published_basis ? "" : ""} and received by AIVS on ${recv}.` : `Its publication date could not be established; AIVS received it on ${recv}.`,
    places.length || orgs.length ? `It refers to ${[places.length && places.join(", "), orgs.length && orgs.join(", ")].filter(Boolean).join(" and ")}.` : null,
    `It merits analysis because it ${topic ? `concerns ${topic}` : "makes a checkable public claim"}${content.length ? " and shows features common in misleading messages" : ""}, and could affect public understanding if repeated.`,
    ["restricted", "failed"].includes(x.access) && !x.provenance ? "The original content could not be fully retrieved." : null,
    x.input_type !== "url" ? `It was submitted ${{ text: "as text", image: "as an image", document: "as a document" }[x.input_type] || "directly"} without a link to the original, so where it first appeared is not known.` : null];
  let background = fit(bg, LIMITS.background[1]);

  // 2. ANALYSIS (100–130 words): observations, source statements and AIVS inferences, kept apart
  const ok = r.search.filter(s => (s.status === "ok" || s.status === "partial") && !["kb", "holdings"].includes(s.key));
  const an = [];
  const nChk = r.assessments.filter(a => a.verdict !== "not_verifiable").length;
  if (r.claims.length) an.push(`AIVS identified ${plural(r.claims.length, "statement")} in the content, of which ${nChk} can be checked against evidence.`);
  const SHORT = { factcheck: "fact-checks", web: "web search", official: "official sites", news: "a news index", reference: "Wikipedia" };
  an.push(ok.length ? `AIVS searched ${plural(ok.length, "source type")} (${ok.map(s => SHORT[s.key] || s.label).join(", ")}) and compared ${plural(r.evidence.length, "item")} (${r.evidence.filter(e => !e.repeat_of).length} independent).` : "No outside evidence source could be searched, so the claim could not be compared with independent reporting.");
  // one line per reference, or one grouped line when several references say the same thing (keeps the page short)
  const kindOf = f => f.rating ? "rating" : f.stance === "misleading" ? "misleading" : f.stance === "supports" ? "supports" : f.stance === "contradicts" ? "contradicts" : f.figures ? "figures" : "related";
  const groups = []; for (const f of refs) { const k = kindOf(f), g = k !== "rating" && groups.find(g => g.k === k); if (g) g.refs.push(f); else groups.push({ k, refs: [f] }); }
  const list = a => a.length < 2 ? a[0] : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
  for (const g of groups) {
    const one = g.refs.length === 1, f = g.refs[0], who = list(g.refs.map(f => `${f.publisher}${cite(f.id)}`)), tier = one && tierName(f.tier) ? ` (${lc(tierName(f.tier))})` : "";
    an.push({ rating: `${who}${tier} rates the claim “${f.rating}”.`, supports: `${who}${tier} ${one ? "reports" : "report"} the same information.`, contradicts: `${who}${tier} ${one ? "contradicts" : "contradict"} the claim.`,
      misleading: `${who} ${one ? "states" : "state"} that the claim lacks context.`, figures: `${who}${tier} ${one ? "reports" : "report"} the same event with different figures.`, related: `${who} ${one ? "covers" : "cover"} the subject but ${one ? "does" : "do"} not address the specific claim.` }[g.k]);
  }
  an.push(x.author || pub ? `The original source is partly traceable (${[x.author ? "author named" : "author unknown", pub ? "date stated" : "date unknown"].join(", ")}).` : "The original source is not traceable: no author or publication date was established.");
  if (content.length) an.push(`The text shows ${content.slice(0, 2).map(i => lc(short(firstSentence(i.indicator), 12))).join("; ")}.`);
  if (amplification.length) an.push(`AIVS observed ${lc(short(firstSentence(amplification[0].indicator), 16))}.`);
  else an.push("No repetition or amplification data was available for this content.");
  if (r.media?.reuse?.length) an.push("An attached image appears to be an earlier image reused in a new context.");
  else if (r.media?.images?.length) an.push(`Checks on ${r.media.images.length} image(s) found no earlier copy in the reference archive.`);
  if (["contradicted", "misleading"].includes(o.verdict)) an.push(`AIVS assesses that, if repeated, the content could mislead the public${topic ? ` on ${topic}` : ""}.`);
  let analysis = fit(an, LIMITS.analysis[1]);

  // 3. ASSESSMENT (70–100 words): calibrated judgement, verdict and an explained evidence-strength rating
  const strengthWhy = { strong: "a published fact-check, an official source or several independent reliable sources", moderate: "at least one independent reliable source", weak: "only limited or lower-reliability sources", none: "no relevant independent evidence" }[o.strength];
  const open = { supported: o.strength === "strong" ? "Available evidence indicates that the claim is accurate as stated." : "Current reporting suggests that the claim is accurate, but further corroboration is required.",
    contradicted: o.strength === "strong" ? "Available evidence indicates that the claim is false as stated." : "Current reporting suggests that the claim is inaccurate; further corroboration is required.",
    misleading: "Available evidence indicates that the content is misleading or lacks essential context.",
    insufficient: /disagree/.test(o.note || "") || ma?.conflicting ? "Reliable sources disagree, so the claim remains unresolved." : "There is insufficient evidence to establish whether the claim is accurate.",
    not_verifiable: "The content contains no factual claim that can be checked against evidence.",
    extraction_blocked: "The content could not be extracted, so nothing was assessed. No claim about it can be made.", insufficient_content: "Too little readable content was extracted to identify or assess a claim.", mixed: "Reliable sources disagree, so the claim remains unresolved." }[o.verdict];
  const coord = amplification.length ? "The observed repetition is consistent with organised amplification, but does not prove coordination." : "There are no indicators of coordinated information activity in the available data; account and timing data were not assessed.";
  const impl = { contradicted: "Continued circulation could reduce public confidence in accurate information.", misleading: "Continued circulation could distort public understanding of the event.", supported: "No adverse effect on the information environment is indicated.", insufficient: "Its effect on the information environment cannot yet be judged.", not_verifiable: null, mixed: "Its effect on the information environment cannot yet be judged." }[o.verdict];
  const unc = ["restricted", "failed"].includes(x.access) ? "the original content could not be fully read" : !ok.length ? "no outside source could be searched" : !x.author && !pub ? "the origin and date of the content are unknown" : r.evidence.filter(e => !e.repeat_of).length < 2 ? "few independent sources were found" : !r.ai.used ? "the analysis relied on rule-based comparison without AI" : "sources may not cover later developments";
  const figs = refs.filter(f => f.figures);
  const as = [open, `Overall verdict: ${o.label}. Evidence strength: ${o.strength_label}, based on ${strengthWhy}.`, figs.length && o.verdict !== "contradicted" ? `Reporting${figs.map(f => ` [${f.n}]`).join("")} gives different figures, which the content must reconcile.` : null, coord, impl, `Key uncertainty: ${unc}.`];
  let assessment = fit(as.filter(Boolean), LIMITS.assessment[1]);

  // 4. RECOMMENDATIONS (2–4, 50–70 words)
  const rec = [];
  if (x.provenance) rec.push("Confirm the analyst-supplied content against the live post before relying on this assessment.");
  if (["contradicted", "misleading"].includes(o.verdict)) rec.push(`Prepare a factual clarification citing ${refs.length ? `[1]` : "authoritative sources"}, for authorised use only.`);
  if (["insufficient", "mixed"].includes(o.verdict) || !ok.length) rec.push("Seek corroboration from the responsible authority or an established fact-checker before drawing conclusions.");
  if (!x.author && !pub) rec.push("Trace the earliest available version of the content to establish its origin and date.");
  if (["contradicted", "misleading"].includes(o.verdict) || amplification.length || content.length) rec.push(`Monitor related public narratives${r.hashtags?.length ? ` (${r.hashtags.slice(0, 2).join(" ")})` : ""} in AI Watchlist.`);
  if (o.verdict === "supported") rec.push("Retain the cited sources with the record; no further action is indicated.");
  if (["extraction_blocked", "insufficient_content"].includes(o.verdict)) rec.push("Obtain the content by permitted means (a screenshot or the pasted text) and run the verification again.");
  if (o.verdict === "not_verifiable") rec.push("Assess the content's purpose and spread rather than its accuracy.");
  rec.push("Refer this AI-generated assessment for authorised human review before any operational use.");
  const recommendations = [...new Set(rec)].slice(0, 4);
  while (words(recommendations.join(" ")) > LIMITS.recommendations[1] && recommendations.length > 2) recommendations.splice(recommendations.length - 2, 1);

  const limitation = `The most important uncertainty is that ${unc}${unc.endsWith(".") ? "" : "."}`;
  const reviewed = r.review?.status === "reviewed";
  const status = approval ? `Approved by ${approval.by} on ${eatDate(approval.at)}` : reviewed ? `Reviewed by ${r.review.by} on ${eatDate(r.review.at)}` : "AI-Generated (not reviewed)";
  // the whole page stays at about 400 words: when the header, references and status take more room, the four
  // sections are shortened in proportion (whole sentences are dropped from the end, never cut mid-way)
  const header = { reference: r.report_id, date: eatDate(r.completed_at || r.created_at, true), subject: short(r.subject, 14), source: [x.platform, x.publisher && x.publisher !== x.platform ? x.publisher : null].filter(Boolean).join(" · ") || ({ text: "Submitted text", image: "Submitted image", document: "Submitted document" }[x.input_type] || "Not established"),
    source_url: x.url || null, area: places.length ? places.join(", ") : "Not established", priority: ({ routine: "Routine", priority: "Priority", urgent: "Urgent" })[priority] || "Routine", status };
  const report_status = `Generated automatically by AIVS ${r.version || ""}${approval ? `; ${lc(status)}` : reviewed ? `; ${lc(status)}; not approved` : "; not reviewed or approved by a person"}. Analytical support product; not an official KDF intelligence document.`;
  const obj = () => ({ title: "AIVS — INFORMATION OPERATIONS ASSESSMENT REPORT", header, background, analysis, assessment, recommendations, references: refs, limitation, report_status,
    verdict: o.verdict, verdict_label: AUTO_VERDICTS[o.verdict] || o.label, strength: o.strength_label, written_by: "rules", training: !!r.training });
  const pageWords = () => words(assessmentHtml(obj(), { detailsUrl: true }).replace(/<style[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " "));
  const full = [words(background), words(analysis), words(assessment)];
  for (let k = 0.95; pageWords() > 400 && k > 0.5; k -= 0.05) { background = fit(bg, Math.floor(full[0] * k)); analysis = fit(an, Math.floor(full[1] * k)); assessment = fit(as.filter(Boolean), Math.max(45, Math.floor(full[2] * k))); }
  return obj();
}
// ---------------------------------------------------------------- AI drafting of the four sections, checked
const ATTRIBUTION = /\b(hostile|adversar\w*|enemy|foreign (actor|state|interference|involvement)|state[- ]sponsored|troll farm|bot network|botnet|coordinated (campaign|inauthentic)|influence operation|propaganda campaign|psy-?ops?)\b/i;
const PCT = /\d+(\.\d+)?\s*(%|percent|per cent)|\bprobabilit/i;
export function checkAiSections(out, base, { hasAmplification = false, nRefs = 0 } = {}) {
  const res = { ...base }, removed = [];
  for (const k of ["background", "analysis", "assessment"]) {
    const t = String(out?.[k] || "").replace(/\s+/g, " ").trim(); if (!t) continue;
    const bad = (t.match(/\[(\d+)\]/g) || []).map(m => +m.slice(1, -1)).filter(n => n < 1 || n > nRefs);
    const why = bad.length ? `cites references that do not exist (${bad.join(", ")})` : PCT.test(t) ? "gives a percentage or probability" : /https?:\/\/|www\./i.test(t) ? "contains a link" : !hasAmplification && ATTRIBUTION.test(t) ? `attributes intent or coordination without data (“${t.match(ATTRIBUTION)[0]}”)` : words(t) > LIMITS[k][1] + 10 ? "is longer than allowed" : words(t) < LIMITS[k][0] - 25 ? "is too short" : null;
    if (why) removed.push(`${k}: ${why}`); else res[k] = fit(t.split(/(?<=[.!?])\s+/), LIMITS[k][1]);
  }
  const recs = Array.isArray(out?.recommendations) ? out.recommendations.map(s => String(s).replace(/\s+/g, " ").trim()).filter(Boolean) : [];
  if (recs.length >= 2 && recs.length <= 4 && words(recs.join(" ")) <= LIMITS.recommendations[1] + 5 && !recs.some(s => ATTRIBUTION.test(s) || /https?:\/\//.test(s) || /\b(suppress|remove (the )?(post|account)|take ?down|target|dox|identify the (author|person)|retaliat)\w*/i.test(s)))
    res.recommendations = recs.some(s => /human review|authori[sz]ed/i.test(s)) ? recs : [...recs.slice(0, 3), "Refer this AI-generated assessment for authorised human review before any operational use."];
  else if (recs.length) removed.push("recommendations: not within the rules (number, length or content)");
  if (removed.length < 4 && ["background", "analysis", "assessment"].some(k => res[k] !== base[k])) res.written_by = "ai";
  return { ...res, removed };
}
export function aiPrompt(a, facts) {
  return `Rewrite the four sections of a one-page Information Operations Assessment in formal British English, objective military reporting style. Use ONLY these facts and the draft; do not add facts, places, dates, actors or sources. Keep the same overall verdict and evidence strength. Cite only [1]-[${a.references.length}]. Do not state or imply hostile intent, coordination, foreign involvement or attribution unless the facts list amplification data. Use calibrated wording (for example "Available evidence indicates", "There is insufficient evidence to establish", "consistent with ..., but does not prove"). Distinguish observations, source statements and assessments.
Limits: background 60-80 words; analysis 100-130 words; assessment 70-100 words, ending with the overall verdict and evidence strength; 2-4 recommendations, 50-70 words in total, proportionate, including authorised human review; never recommend suppressing lawful expression or targeting individuals.
<content>
${JSON.stringify(facts).replace(/<\/?content/gi, "‹content").slice(0, 8000)}
</content>
Draft:
<content>
${JSON.stringify({ background: a.background, analysis: a.analysis, assessment: a.assessment, recommendations: a.recommendations }).replace(/<\/?content/gi, "‹content")}
</content>
JSON: {"background": "...", "analysis": "...", "assessment": "...", "recommendations": ["...", "..."]}`;
}

// ---------------------------------------------------------------- one-page HTML (A4 portrait; prints in black and white)
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CSS = `@page{size:A4 portrait;margin:12mm 13mm}*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#111827}
body{font:9.4pt/1.38 "Segoe UI",Calibri,Arial,sans-serif}.page{width:184mm;max-width:100%;margin:0 auto;padding:6mm 0}
.t{background:#0b1f3a;color:#fff;padding:7px 10px;border-bottom:3px solid #9b1c1c;font-weight:700;letter-spacing:.06em;font-size:11.5pt}
.st{float:right;font-size:8pt;font-weight:600;letter-spacing:0;border:1px solid #fff;padding:1px 6px;border-radius:3px;margin-top:1px}
table.h{width:100%;border-collapse:collapse;font-size:8.2pt;margin:6px 0 4px}table.h td{border:1px solid #c7ccd6;padding:3px 5px;vertical-align:top}table.h td b{display:block;font-size:7pt;color:#0b1f3a;text-transform:uppercase;letter-spacing:.04em}
h2{font-size:9.2pt;margin:9px 0 2px;color:#0b1f3a;letter-spacing:.06em;border-bottom:1.2px solid #0b1f3a;padding-bottom:1px}h2 span{color:#9b1c1c}
p{margin:2px 0;text-align:justify}ol{margin:2px 0 0 17px;padding:0}li{margin:1px 0}.v{border-left:4px solid #9b1c1c;padding:3px 7px;margin:4px 0;background:#f8f9fb;font-weight:600}
.refs{font-size:8pt}.refs li{margin:1px 0}.small{font-size:7.8pt;color:#374151}a{color:#0b1f3a}
@media screen{body{background:#eef1f5}.page{background:#fff;padding:12mm 13mm;margin:10px auto;box-shadow:0 1px 4px rgba(0,0,0,.15);width:210mm;min-height:297mm}}
@media screen and (max-width:820px){.page{width:auto;min-height:0;padding:14px;margin:0}table.h td{display:block;border-width:0 0 1px}}
@media print{a{color:inherit;text-decoration:none}.v{background:none}}`;
export function assessmentHtml(a, { standalone = true, detailsUrl = null } = {}) {
  const h = a.header;
  const body = `<div class="page"><div class="t">${esc(a.title)}<span class="st">${esc(h.status.startsWith("AI-Generated") ? "AI-GENERATED" : h.status.startsWith("Approved") ? "APPROVED" : "REVIEWED")}</span></div>
  <table class="h"><tr><td><b>Reference</b>${esc(h.reference)}</td><td><b>Date / time of analysis</b>${esc(h.date)}</td><td><b>Priority</b>${esc(h.priority)}</td><td><b>Status</b>${esc(h.status)}</td></tr>
  <tr><td colspan="2"><b>Subject / narrative</b>${esc(h.subject)}</td><td><b>Source / platform</b>${h.source_url ? `<a href="${esc(h.source_url)}" rel="noopener noreferrer" target="_blank">${esc(h.source)}</a>` : esc(h.source)}</td><td><b>Area of interest</b>${esc(h.area)}</td></tr></table>
  ${a.training ? '<p class="small"><b>TRAINING MATERIAL — synthetic content for practice.</b></p>' : ""}
  <h2><span>1.</span> BACKGROUND</h2><p>${esc(a.background)}</p>
  <h2><span>2.</span> ANALYSIS</h2><p>${esc(a.analysis)}</p>
  <h2><span>3.</span> ASSESSMENT</h2><div class="v">${esc(a.verdict_label)} · Evidence strength: ${esc(a.strength)}</div><p>${esc(a.assessment)}</p>
  <h2><span>4.</span> RECOMMENDATIONS</h2><ol>${a.recommendations.map(x => `<li>${esc(x)}</li>`).join("")}</ol>
  <h2>KEY REFERENCES</h2>${a.references.length ? `<ol class="refs">${a.references.map(f => `<li>${f.url ? `<a href="${esc(f.url)}" rel="noopener noreferrer" target="_blank">${esc(f.publisher)}</a>` : esc(f.publisher)}, “${esc(f.title)}”${f.date ? `, ${esc(f.date)}` : ""} — ${esc(f.addresses)}.</li>`).join("")}</ol>` : '<p class="small">No source that addresses the claim was retrieved.</p>'}
  <h2>LIMITATIONS</h2><p class="small">${esc(a.limitation)}</p>
  <h2>REPORT STATUS</h2><p class="small">${esc(a.report_status)}${a.written_by === "ai" ? " Section text drafted by AI and checked automatically; the verdict follows fixed rules." : ""}${detailsUrl ? ` Supporting evidence and investigation details are kept in the separate details report.` : ""}</p></div>`;
  return standalone ? `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(a.header.reference)} · Information Operations Assessment</title><style>${CSS}</style></head><body>${body}</body></html>` : body;
}

// ---------------------------------------------------------------- one-page PDF (pdfkit); the text is shrunk, never cut, to fit one A4 page
const pdfSafe = s => String(s ?? "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/…/g, "...").replace(/·/g, "|").replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/gu, "?");
export async function assessmentPdf(a) {
  const { default: PDFDocument } = await import("pdfkit");
  const render = size => new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 34, bottom: 30, left: 38, right: 38 }, bufferPages: true, info: { Title: `${a.header.reference} - Information Operations Assessment`, Author: "AIVS (automatic)", Subject: pdfSafe(a.header.subject) } });
    const chunks = []; doc.on("data", c => chunks.push(c)); doc.on("error", reject);
    doc.on("end", () => resolve({ buf: Buffer.concat(chunks), pages: pages }));
    const W = doc.page.width - 76, NAVY = "#0b1f3a", RED = "#9b1c1c", L = 38;
    const p = (t, o = {}) => doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(o.size || size).fillColor(o.color || "#111827").text(pdfSafe(t), o.x ?? L, o.y, { width: o.w || W, align: o.align || "justify", lineGap: 1, ...(o.link ? { link: o.link, underline: false } : {}) });
    const h2 = (n, t) => { doc.moveDown(0.45); const y = doc.y; doc.font("Helvetica-Bold").fontSize(size + 0.3).fillColor(RED).text(n ? `${n} ` : "", L, y, { continued: !!n }).fillColor(NAVY).text(t); const y2 = doc.y + 1; doc.moveTo(L, y2).lineTo(L + W, y2).lineWidth(0.9).strokeColor(NAVY).stroke(); doc.y = y2 + 2; };
    // title bar
    doc.rect(L, 30, W, 20).fill(NAVY); doc.rect(L, 50, W, 2.2).fill(RED);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#ffffff").text(pdfSafe(a.title), L + 7, 35.5, { width: W - 120, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(7.5).text(a.header.status.startsWith("AI-Generated") ? "AI-GENERATED" : a.header.status.startsWith("Approved") ? "APPROVED" : "REVIEWED", L + W - 110, 37, { width: 103, align: "right" });
    // header grid
    const cells = [["Reference", a.header.reference], ["Date / time of analysis", a.header.date], ["Priority", a.header.priority], ["Status", a.header.status], ["Subject / narrative", a.header.subject], ["Source / platform", a.header.source], ["Area of interest", a.header.area]];
    let y = 57; const cw = W / 4;
    const cell = (i, x, w, k, v, link) => { doc.font("Helvetica-Bold").fontSize(6.3).fillColor(NAVY).text(k.toUpperCase(), x + 3, y + 2, { width: w - 6 }); doc.font("Helvetica").fontSize(7.6).fillColor("#111827").text(pdfSafe(v), x + 3, y + 9.5, { width: w - 6, height: 18, ellipsis: true, ...(link ? { link } : {}) }); doc.rect(x, y, w, 29).lineWidth(0.5).strokeColor("#9aa3b2").stroke(); };
    cells.slice(0, 4).forEach(([k, v], i) => cell(i, L + i * cw, cw, k, v)); y += 29;
    cell(4, L, cw * 2, ...cells[4]); cell(5, L + cw * 2, cw, cells[5][0], cells[5][1], a.header.source_url || undefined); cell(6, L + cw * 3, cw, ...cells[6]); y += 29;
    doc.y = y + 2;
    if (a.training) p("TRAINING MATERIAL - synthetic content for practice.", { bold: true, size: size - 1.2 });
    h2("1.", "BACKGROUND"); p(a.background);
    h2("2.", "ANALYSIS"); p(a.analysis);
    h2("3.", "ASSESSMENT"); { const yy = doc.y; doc.rect(L, yy, 3, size + 1.5).fill(RED); p(`${a.verdict_label}  |  Evidence strength: ${a.strength}`, { bold: true, x: L + 7, w: W - 7, align: "left" }); doc.moveDown(0.15); } p(a.assessment);
    h2("4.", "RECOMMENDATIONS"); a.recommendations.forEach((x, i) => p(`${i + 1}.  ${x}`, { align: "left" }));
    h2("", "KEY REFERENCES");
    if (!a.references.length) p("No source that addresses the claim was retrieved.", { size: size - 1.2, color: "#374151" });
    a.references.forEach(f => p(`[${f.n}] ${f.publisher}, "${f.title}"${f.date ? `, ${f.date}` : ""} - ${f.addresses}.${f.url ? ` ${f.url}` : ""}`, { size: size - 1.4, color: "#1f2937", align: "left", link: f.url || undefined }));
    h2("", "LIMITATIONS"); p(a.limitation, { size: size - 1.2, color: "#374151" });
    h2("", "REPORT STATUS"); p(`${a.report_status}${a.written_by === "ai" ? " Section text drafted by AI and checked automatically; the verdict follows fixed rules." : ""}`, { size: size - 1.2, color: "#374151" });
    const pages = doc.bufferedPageRange().count;
    doc.end();
  });
  // try normal size first; shrink only if needed, so all text always appears on a single page
  for (const size of [9.4, 9, 8.6, 8.2, 7.8, 7.4]) { const r = await render(size); if (r.pages === 1) return { ...r, size }; if (size === 7.4) return { ...r, size }; }
}

// ---------------------------------------------------------------- one-page Word
export function assessmentDocxXml(a) {
  const x = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, "");
  const run = (t, { b, color, size = 18 } = {}) => `<w:r><w:rPr>${b ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
  const para = (inner, { after = 40, shade = null, jc = "both" } = {}) => `<w:p><w:pPr><w:spacing w:before="0" w:after="${after}"/><w:jc w:val="${jc}"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:pPr>${inner}</w:p>`;
  const h2 = (n, t) => `<w:p><w:pPr><w:spacing w:before="100" w:after="30"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="0B1F3A"/></w:pBdr></w:pPr>${n ? run(n + " ", { b: true, color: "9B1C1C", size: 19 }) : ""}${run(t, { b: true, color: "0B1F3A", size: 19 })}</w:p>`;
  const h = a.header, cellX = (k, v, span = 1) => `<w:tc><w:tcPr>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(k.toUpperCase(), { b: true, color: "0B1F3A", size: 13 })}</w:p><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(v, { size: 16 })}</w:p></w:tc>`;
  const B = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(s => `<w:${s} w:val="single" w:sz="4" w:color="9AA3B2"/>`).join("")}</w:tblBorders>`;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${B}</w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid><w:tr>${cellX("Reference", h.reference)}${cellX("Date / time of analysis", h.date)}${cellX("Priority", h.priority)}${cellX("Status", h.status)}</w:tr><w:tr>${cellX("Subject / narrative", h.subject, 2)}${cellX("Source / platform", h.source)}${cellX("Area of interest", h.area)}</w:tr></w:tbl>`;
  const body = [para(run(a.title, { b: true, color: "FFFFFF", size: 22 }), { shade: "0B1F3A", after: 60, jc: "left" }), table, a.training ? para(run("TRAINING MATERIAL — synthetic content for practice.", { b: true, size: 16 })) : "",
    h2("1.", "BACKGROUND"), para(run(a.background)), h2("2.", "ANALYSIS"), para(run(a.analysis)),
    h2("3.", "ASSESSMENT"), para(run(`${a.verdict_label} · Evidence strength: ${a.strength}`, { b: true }), { jc: "left" }), para(run(a.assessment)),
    h2("4.", "RECOMMENDATIONS"), ...a.recommendations.map((r, i) => para(run(`${i + 1}.  ${r}`), { after: 10, jc: "left" })),
    h2("", "KEY REFERENCES"), ...(a.references.length ? a.references.map(f => para(run(`[${f.n}] ${f.publisher}, “${f.title}”${f.date ? `, ${f.date}` : ""} — ${f.addresses}.${f.url ? ` ${f.url}` : ""}`, { size: 15 }), { after: 10, jc: "left" })) : [para(run("No source that addresses the claim was retrieved.", { size: 15 }))]),
    h2("", "LIMITATIONS"), para(run(a.limitation, { size: 15, color: "374151" })), h2("", "REPORT STATUS"), para(run(a.report_status, { size: 15, color: "374151" }))].join("");
  return `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="680" w:right="737" w:bottom="680" w:left="737" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body>`;
}

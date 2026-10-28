// AIVS — KDF Information Operations Assessment (1.25; four-section format and HOD approval 1.32): a one-page product.
// Built automatically from a completed investigation: exactly four sections (Executive Summary / Background Information,
// Analysis of at most two principal claims with their evidence, a KDF Information Operations Assessment, and 3–5
// recommendations each beginning "There is a need to…"). British English, calibrated wording, word limits.
// Rules: nothing is invented (only the investigation's own records are used); references are numbered [1]–[3] and each
// is checked for whether it addresses the claim; coordination, hostile intent, foreign involvement or attribution are
// never stated without supporting data; "Approved" is shown only when an approval was actually recorded.
// The full evidence stays in the Supporting evidence / investigation details report (autoreport.js).
import { AUTO_VERDICTS } from "./autoeval.js";

export const LIMITS = { background: [40, 80], analysis: [80, 180], assessment: [70, 130], recommendations: [45, 115] };
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

// ---------------------------------------------------------------- verdicts, confidence and recommendation rules (1.32)
// The one-page report uses the vocabulary of KDF Information Operations reporting: True, False, Misleading, Unverified or
// Insufficient Evidence, with a confidence level that follows the strength of the independent evidence, never the AI's opinion.
export const IO_VERDICT = { supported: "True", contradicted: "False", misleading: "Misleading", not_verifiable: "Unverified", insufficient: "Insufficient Evidence", mixed: "Insufficient Evidence",
  extraction_blocked: "Insufficient Evidence", insufficient_content: "Insufficient Evidence" };
export const CONFIDENCE = { strong: "High", moderate: "Moderate", weak: "Low", none: "Low" };
export const REC_PREFIX = "There is a need to";
// recommendations are for the organisation's communication and review, never tasks the verification engine should have done,
// never covert or suppressive measures
const MANUAL = /\b(visit|check|consult|browse|look at|go to)\b[^.]{0,40}\b(website|site|page|portal)\b|\bsearch (for|the) (evidence|sources|web|internet)\b|\bverify (the|this) (information|claim|content) manually\b|\bmanual(ly)? (verification|check)\b|\bconfirm (it |this |the claim )?(from|with|on) the\b/i;
const HARMFUL = /\b(suppress|censor|remove (the )?(post|account|content)|take ?down|block (the )?(account|user)|target(ing)? (individuals?|the (author|account|user))|dox|identify the (author|person)|retaliat|covert|fabricat|counter-?narrative campaign|astroturf|fake account)\w*/i;
export function validRecommendation(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t.startsWith(`${REC_PREFIX} `)) return `must begin with “${REC_PREFIX}…”`;
  if (words(t) < 8 || words(t) > 45) return "must be between 8 and 45 words";
  if (MANUAL.test(t)) return "asks a person to do verification work that AIVS performs automatically";
  if (HARMFUL.test(t)) return "recommends a measure that is not permitted (suppression, targeting individuals or covert activity)";
  if (/https?:\/\/|www\./i.test(t)) return "contains a link";
  return null;
}

// ---------------------------------------------------------------- references: up to two per claim, each checked against its claim
const addresses = e => e.stance !== "related" || (/different figures/.test(e.stance_basis || "") && (e.relevance || 0) >= 0.3);
const rank = e => (e.rating ? 3 : 0) + ({ official: 2, fact_checker: 2, knowledge_base: 1.5, news: 1 }[e.tier] || 0) + (e.page_read ? 0.5 : 0) + (e.stance !== "related" ? 1.5 : 0) + (e.relevance || 0) - (e.repeat_of ? 2 : 0);
function refsFor(r, claimIds, max = 4) {
  const out = [];
  for (const id of claimIds) {
    const mine = r.evidence.filter(e => e.claim_id === id && (e.source_url || e.reference) && !["reference", "earlier_case"].includes(e.tier) && addresses(e))
      .sort((a, b) => (b.stance === "contradicts" || b.stance === "misleading") - (a.stance === "contradicts" || a.stance === "misleading") || rank(b) - rank(a));
    for (const e of mine.slice(0, 2)) if (out.length < max && !out.some(f => f.id === e.id)) out.push(e);
  }
  return out.map((e, i) => ({ n: i + 1, id: e.id, claim_id: e.claim_id, url: /^https?:\/\//i.test(e.source_url || "") ? e.source_url : null, title: short(e.source_title || e.reference, 11), publisher: e.publisher || e.domain,
    date: eatDate(e.source_published_at && e.source_published_at.slice(0, 10)), tier: e.tier_label, stance: e.stance, rating: e.rating || null, read: !!e.page_read, figures: /different figures/.test(e.stance_basis || ""),
    addresses: e.stance === "supports" ? "supports the claim" : e.stance === "contradicts" ? "contradicts the claim" : e.stance === "misleading" ? "rates the claim misleading" : /different figures/.test(e.stance_basis || "") ? "reports different figures" : "does not settle the claim" }));
}
// the principal claims: at most two (the investigation already selected them; older records may hold more)
export function principalClaims(r) {
  const idx = r.claims.map((c, i) => i);
  const order = r.principal?.length ? r.principal.map(id => r.claims.findIndex(c => c.id === id)).filter(i => i >= 0) : idx.filter(i => r.assessments[i]?.verdict !== "not_verifiable").concat(idx.filter(i => r.assessments[i]?.verdict === "not_verifiable"));
  return order.slice(0, 2).map(i => ({ c: r.claims[i], a: r.assessments[i] }));
}
const KDF_RE = /\b(kdf|kenya defen[cs]e forces?|kenya army|kenya navy|kenya air ?force|military|soldiers?|troops|defen[cs]e|jeshi|wanajeshi|recruit\w*|cdf|al-?shabaab|atmis|amisom)\b/i;

// ---------------------------------------------------------------- the four sections (rule-based, British English)
// one sentence per verified video for the one-page report (1.35): what was compared, verified vs possible, and the search coverage
export function videoNote(r) {
  const vids = (r.media?.videos || []).filter(v => !v.error); if (!vids.length) return null;
  const one = v => { const rec = v.findings?.find(f => f.kind === "recycled"), m = rec ? v.matches.find(x => x.rank === rec.rank) : null, ctx = v.findings?.some(f => f.kind === "context");
    const what = m ? `an earlier copy dated ${String(m.date).slice(0, 10)} (${m.publisher || m.url || "earlier source"}) was verified, indicating recycled footage` : v.verified ? `${v.verified} verified match(es) were found, none dated well before the claim` : v.possible ? `${v.possible} possible similarit${v.possible === 1 ? "y was" : "ies were"} found but not confirmed` : "no earlier copy was found";
    return `${v.keyframes.length} keyframes were compared; ${what}${ctx ? ", and the earlier copy refers to a different place" : ""}; ${v.internet_search ? `reverse search covered ${(v.searched || []).map(s => s.provider.replace(/ \(.*\)$/, "")).join(" and ")} only` : "internet-wide reverse search was not completed"}`; };
  return `Video verification: ${vids.map(one).join("; another video: ")}.`;
}
// an AI-written analysis keeps the video sentence (it is added back when the model left it out, within the word limit)
export function keepVideoNote(a) {
  if (!a?.video_note || a.analysis.includes("Video verification")) return a;
  const ss = String(a.analysis).split(/(?<=[.!?])\s+/).filter(Boolean); ss.splice(Math.min(1, ss.length), 0, a.video_note);
  return { ...a, analysis: fit(ss, LIMITS.analysis[1]) };
}
export function buildAssessment(r, { priority = null } = {}) {
  const x = r.source, o = r.overall, P = principalClaims(r), main = P[0]?.c || null;
  const refs = refsFor(r, P.map(p => p.c.id)), cite = ids => { const ns = refs.filter(f => ids.includes(f.id)).map(f => `[${f.n}]`); return ns.length ? ` ${ns.join("")}` : ""; };
  const text = `${r.content || ""} ${r.claims.map(c => c.text).join(" ")}`, topic = topicOfText(text), kdf = KDF_RE.test(text);
  const kind = x.input_type === "url" ? (x.platform && /X \(|Facebook|Instagram|TikTok|YouTube|Telegram|Threads|WhatsApp|Reddit|LinkedIn/.test(x.platform) ? "post" : "article") : x.input_type === "image" ? "image" : x.input_type === "screenshot" ? "screenshot of a post" : x.input_type === "document" ? "document" : "message";
  const pub = eatDate(x.published_at && x.published_at.slice(0, 10)), recv = eatDate(r.created_at);
  const indicators = r.io?.observed || [], amplification = indicators.filter(i => ["repetition", "dataset", "amplification", "spread"].includes(i.kind)), cues = indicators.filter(i => i.kind === "content");
  const ok = (r.search || []).filter(s => (s.status === "ok" || s.status === "partial") && !["kb", "holdings", "reference"].includes(s.key));
  const errored = (r.search || []).filter(s => s.status === "error"), unconfigured = (r.search || []).filter(s => s.status === "not_configured" || s.configured === false);
  const ioV = IO_VERDICT[o.verdict] || o.label, conf = CONFIDENCE[o.strength] || "Low";
  const claims = P.map(({ c, a }, k) => { const sup = refs.filter(f => f.claim_id === c.id && f.stance === "supports"), con = refs.filter(f => f.claim_id === c.id && (f.stance === "contradicts" || f.stance === "misleading"));
    return { n: k + 1, id: c.id, text: c.text, verdict: a.verdict, verdict_io: IO_VERDICT[a.verdict] || a.verdict, confidence: CONFIDENCE[a.strength] || "Low", reason: a.reason, supporting: sup.map(f => f.n), contradicting: con.map(f => f.n),
      gap: a.verdict === "insufficient" ? (ok.length ? "no independent reliable source addresses it" : "no outside source could be searched") : a.verdict === "not_verifiable" ? "it is an opinion, prediction or question rather than a checkable fact" : null }; });

  // 1. EXECUTIVE SUMMARY / BACKGROUND INFORMATION (40–80 words)
  const shot = x.input_type === "screenshot";
  const who = [x.author && `attributed to ${x.author}${shot ? " (as shown)" : ""}`, x.platform && `on ${x.platform}${shot ? " (apparent)" : ""}`].filter(Boolean).join(" ");
  const bg = [
    main ? `${kind === "image" ? "An" : "A"} ${kind}${who ? ` ${who}` : ""} asserts that ${lc(short(main.text.replace(/[.!]+$/, ""), 28))}${P[1] ? `, and that ${lc(short(P[1].c.text.replace(/[.!]+$/, ""), 18))}` : ""}.` : `${kind === "image" ? "An" : "A"} ${kind}${who ? ` ${who}` : ""} was submitted, but no checkable claim could be identified.`,
    x.provenance ? (x.provenance.continues ? `${x.provenance.platform || "The platform"} did not allow automatic extraction; the content was supplied by an analyst.` : "The content was captured by an analyst from their own browser view.") : null,
    // 1.34: a screenshot is a copy of a post, not proof of it; whether the original was retrieved is always stated
    shot ? `The screenshot was submitted by an analyst; ${x.screenshot?.original?.retrieved ? "the original post was retrieved from the visible link" : "the original post was not independently retrieved"}, so its authenticity is not established.` : null,
    pub ? `It was published on ${pub} and received by AIVS on ${recv}.` : `Its publication date could not be established; AIVS received it on ${recv}.`,
    `It is significant to KDF because it ${kdf ? "concerns the Kenya Defence Forces or their activities" : topic ? `concerns ${topic}` : "makes a public claim"} and could shape public understanding if repeated.`,
    ["restricted", "failed"].includes(x.access) && !x.provenance ? "The original content could not be fully retrieved." : null];
  let background = fit(bg, LIMITS.background[1]);

  // video verification (1.35): one concise sentence, placed right after the evidence-search sentence so it is never cut
  const vnote = videoNote(r);
  // 2. ANALYSIS (80–180 words): each principal claim, its evidence and the gaps
  const SHORT = { factcheck: "fact-check databases", web: "web search", official: "official and fact-checking sites", news: "a news index" };
  const an = [ok.length ? `AIVS searched ${ok.map(s => SHORT[s.key] || s.label).join(", ")} automatically and compared ${plural(r.evidence.filter(e => !e.repeat_of && !["reference", "earlier_case"].includes(e.tier)).length, "independent item")}${r.evidence.some(e => e.page_read) ? `, reading the full text of ${plural(r.evidence.filter(e => e.page_read).length, "source")}` : ""}.`
    : `No independent evidence source could be searched${errored.length ? ` (${errored.map(s => s.label).join(", ")} returned errors)` : unconfigured.length ? " (no search service is configured)" : ""}, so the claims could not be compared with outside reporting.`];
  if (vnote) an.push(vnote);
  for (const k of claims) {
    const parts = [`Claim ${k.n} (“${short(k.text, 16)}”) is assessed as ${k.verdict_io} (confidence: ${k.confidence}).`];
    if (k.contradicting.length) parts.push(`It is contradicted by ${refs.filter(f => k.contradicting.includes(f.n)).map(f => `${f.publisher}${f.rating ? `, which rates it “${f.rating}”` : ""} [${f.n}]`).join(" and ")}.`);
    if (k.supporting.length) parts.push(`${k.contradicting.length ? "Supporting" : "It is supported by"} ${refs.filter(f => k.supporting.includes(f.n)).map(f => `${f.publisher} [${f.n}]`).join(" and ")}${k.contradicting.length ? " also reports it, so the sources disagree" : ""}.`);
    if (!k.contradicting.length && !k.supporting.length) parts.push(k.gap ? `No evidence settles it: ${k.gap}.` : "No independent source addresses it directly.");
    an.push(parts.join(" "));
  }
  if (r.other_claims?.length) an.push(`${plural(r.other_claims.length, "further statement")} in the content ${r.other_claims.length === 1 ? "was" : "were"} recorded but not prioritised.`);
  if (cues.length) an.push(`Warning signs in the text: ${cues.slice(0, 2).map(i => lc(short(firstSentence(i.indicator), 10)).replace(/…$/, "")).join("; ")}.`);
  an.push(x.author || pub ? `The source is partly traceable (${[x.author ? "author named" : "author unknown", pub ? "date stated" : "date unknown"].join(", ")}).` : "The original source is not traceable: no author or publication date was established.");
  let analysis = fit(an, LIMITS.analysis[1]);

  // 3. ASSESSMENT (70–130 words): KDF Information Operations judgement, classification, implications, confidence and limitation
  const open = { supported: "Available evidence establishes that the principal claim is true.", contradicted: "Available evidence establishes that the principal claim is false.",
    misleading: "Available evidence establishes that the content is misleading or lacks essential context.", insufficient: "Available evidence does not establish whether the principal claim is accurate; it remains unverified.",
    mixed: "Reliable sources disagree, so the principal claim remains unverified.", not_verifiable: "The content contains no factual claim that can be checked; it is unverified.",
    extraction_blocked: "The content could not be read, so no claim could be verified.", insufficient_content: "Too little content was available to verify any claim." }[o.verdict] || `The assessment is ${ioV}.`;
  const classify = ["contradicted", "misleading"].includes(o.verdict)
    ? `It meets the description of misinformation; the evidence does not establish intent to deceive, so it cannot be classified as disinformation${cues.length ? ", although its features are common in deceptive messages" : ""}.`
    : o.verdict === "supported" ? "There is no basis to classify it as misinformation; nothing indicates genuine information being used to cause harm (malinformation)."
    : "No classification as misinformation, disinformation or malinformation is justified on the available evidence.";
  const impl = ["contradicted", "misleading"].includes(o.verdict) ? (kdf ? `If repeated, it could mislead the public about KDF${/recruit|fee|ksh|pay|m-?pesa/i.test(text) ? ", expose applicants to fraud" : ""} and erode confidence in the institution's official communication.` : "If repeated, it could mislead the public and reduce confidence in accurate information.")
    : o.verdict === "supported" ? (kdf ? "It does not threaten KDF's information environment; accurate reporting supports public understanding." : "No adverse effect on the information environment is indicated.")
    : kdf ? "Its effect on KDF's information environment cannot be judged until evidence is available; it should not be presumed false." : "Its effect on the information environment cannot yet be judged.";
  const spread = amplification.length ? "Repetition was observed, which is consistent with amplification but does not prove coordination." : "No dissemination or amplification data indicates coordinated activity.";
  const urgency = ["contradicted", "misleading"].includes(o.verdict) && (kdf || cues.length) ? (o.strength === "strong" ? "High" : "Moderate") : o.verdict === "supported" ? "Low" : "Moderate";
  const unc = shot && !x.screenshot?.original?.retrieved ? "the post is known only from a screenshot; the original was not independently retrieved" : ["restricted", "failed"].includes(x.access) && !x.provenance ? "the original content could not be fully read" : x.provenance ? "the content was supplied by an analyst and could not be compared with the live post" : !ok.length ? "no independent source could be searched" : !x.author && !pub ? "the origin and date of the content are unknown" : r.evidence.filter(e => !e.repeat_of).length < 2 ? "few independent sources were found" : "the sources consulted cover only what they index";
  const vids = (r.media?.videos || []).filter(v => !v.error);
  const unc2 = vids.length && !vids.some(v => v.internet_search) && /few independent sources|cover only what they index|could not be searched/.test(unc) ? "internet-wide reverse search of the video's keyframes was not completed" : unc;
  const as = [open, classify, impl, spread, `Significance: ${urgency}; confidence: ${conf}. Main limitation: ${unc2}.`];
  let assessment = fit(as.filter(Boolean), LIMITS.assessment[1]);

  // 4. RECOMMENDATIONS (3–5, each beginning "There is a need to…"): communication and review measures, never verification chores
  const rec = [];
  const firstCon = refs.find(f => f.stance === "contradicts" || f.stance === "misleading");
  if (["contradicted", "misleading"].includes(o.verdict)) {
    rec.push(`${REC_PREFIX} issue a timely public clarification through authorised KDF channels that corrects the inaccurate claim${firstCon ? `, citing the evidence [${firstCon.n}]` : ""}.`);
    rec.push(`${REC_PREFIX} raise public awareness of this ${/recruit|fee|ksh|pay|m-?pesa/i.test(text) ? "fraudulent recruitment narrative and of the official recruitment channels" : "misleading narrative"} through authorised communication.`);
  }
  if ((r.media?.videos || []).some(v => v.reuse?.length)) rec.push(`${REC_PREFIX} make the footage's earlier, verified context known through authorised KDF channels if the recycled video continues to circulate.`);
  if (o.verdict === "supported") rec.push(`${REC_PREFIX} reinforce the accurate information through authorised KDF channels where public interest warrants it.`);
  if (["insufficient", "mixed", "not_verifiable"].includes(o.verdict)) rec.push(`${REC_PREFIX} treat the narrative as unverified and avoid public statements that presume it false until evidence becomes available.`);
  if (["extraction_blocked", "insufficient_content"].includes(o.verdict)) rec.push(`${REC_PREFIX} obtain the content through permitted means so that the verification can be completed.`);
  rec.push(`${REC_PREFIX} monitor related public narratives${r.hashtags?.length ? ` (${r.hashtags.slice(0, 2).join(" ")})` : ""} through the AIVS watchlist for renewed circulation or amplification.`);
  if (o.verdict !== "supported") rec.push(`${REC_PREFIX} strengthen transparent institutional communication on the subject so that accurate information is readily available to the public.`);
  rec.push(`${REC_PREFIX} preserve the evidence collected and escalate significant concerns for authorised review.`);
  let recommendations = [...new Set(rec)].slice(0, 5);
  while (recommendations.length < 3) recommendations.push(`${REC_PREFIX} keep the subject under review as new information becomes available.`);
  while (words(recommendations.join(" ")) > LIMITS.recommendations[1] && recommendations.length > 3) recommendations.splice(recommendations.length - 2, 1);

  const srcLabel = shot ? `Screenshot · ${x.platform ? `${x.platform} (apparent)` : "platform not identified"}${x.account ? ` · ${x.account}` : ""}` : null;
  const header = { reference: r.report_id, date: eatDate(r.completed_at || r.created_at, true), subject: short(r.subject, 16), source: [x.platform, x.publisher && x.publisher !== x.platform ? x.publisher : null].filter(Boolean).join(" · ") || ({ text: "Submitted text", image: "Submitted image", document: "Submitted document", screenshot: "Screenshot" }[x.input_type] || "Not established"),
    ...(srcLabel ? { source: srcLabel } : {}), source_url: x.url || null, priority: ({ routine: "Routine", priority: "Priority", urgent: "Urgent" })[priority] || "Routine", status: "DRAFT — NOT APPROVED" };
  const obj = () => ({ title: "AIVS — KDF INFORMATION OPERATIONS ASSESSMENT", header, background, analysis, assessment, recommendations, references: refs, claims, limitation: null,
    verdict: o.verdict, verdict_label: ioV, strength: conf, urgency, written_by: "rules", training: !!r.training, ...(vnote ? { video_note: vnote } : {}) });
  // the page stays near 480 words: sections are shortened in proportion, whole sentences only
  const pageWords = () => words(assessmentHtml(obj()).replace(/<style[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " "));
  const full = [words(background), words(analysis), words(assessment)];
  for (let k = 0.95; pageWords() > 500 && k > 0.5; k -= 0.05) { background = fit(bg, Math.floor(full[0] * k)); analysis = fit(an, Math.floor(full[1] * k)); assessment = fit(as.filter(Boolean), Math.max(60, Math.floor(full[2] * k))); }
  return obj();
}
// approval state shown on the report: only a real, current HOD approval makes it "APPROVED BY HEAD OF DEPARTMENT"
export function applyApproval(a, ap) {
  const out = { ...a, header: { ...a.header }, approval: null };
  if (ap?.approved) { out.header.status = "APPROVED BY HEAD OF DEPARTMENT"; out.approval = ap; }
  else out.header.status = `DRAFT — NOT APPROVED${ap?.label ? ` (${ap.label})` : ""}`;
  return out;
}
// ---------------------------------------------------------------- AI drafting of the four sections, checked
const ATTRIBUTION = /\b(hostile|adversar\w*|enemy|foreign (actor|state|interference|involvement)|state[- ]sponsored|troll farm|bot network|botnet|coordinated (campaign|inauthentic)|influence operation|propaganda campaign|psy-?ops?|disinformation campaign|deliberate(ly)? (spread|deceiv))\b/i;
const PCT = /\d+(\.\d+)?\s*(%|percent|per cent)|\bprobabilit/i;
export function checkAiSections(out, base, { hasAmplification = false, nRefs = 0 } = {}) {
  const res = { ...base }, removed = [];
  for (const k of ["background", "analysis", "assessment"]) {
    const t = String(out?.[k] || "").replace(/\s+/g, " ").trim(); if (!t) continue;
    const bad = (t.match(/\[(\d+)\]/g) || []).map(m => +m.slice(1, -1)).filter(n => n < 1 || n > nRefs);
    const verdictOk = k !== "assessment" || !base.verdict_label || new RegExp(base.verdict_label.replace(/\s+/g, "\\s+"), "i").test(t) || (base.verdict === "contradicted" && /\bfalse\b/i.test(t)) || (base.verdict === "supported" && /\b(true|accurate)\b/i.test(t)) || (/insufficient|mixed|not_verifiable/.test(base.verdict) && /unverified|insufficient/i.test(t)) || (base.verdict === "misleading" && /misleading/i.test(t));
    const why = bad.length ? `cites references that do not exist (${bad.join(", ")})` : PCT.test(t) ? "gives a percentage or probability" : /https?:\/\/|www\./i.test(t) ? "contains a link" : !hasAmplification && ATTRIBUTION.test(t) ? `attributes intent or coordination without data (“${t.match(ATTRIBUTION)[0]}”)` : !verdictOk ? "does not keep the evidence-based verdict" : words(t) > LIMITS[k][1] + 10 ? "is longer than allowed" : words(t) < LIMITS[k][0] - 15 ? "is too short" : null;
    if (why) removed.push(`${k}: ${why}`); else res[k] = fit(t.split(/(?<=[.!?])\s+/), LIMITS[k][1]);
  }
  const recs = Array.isArray(out?.recommendations) ? out.recommendations.map(s => String(s).replace(/\s+/g, " ").trim()).filter(Boolean) : [];
  const good = recs.filter(s => !validRecommendation(s) && !ATTRIBUTION.test(s)), bad = recs.filter(s => validRecommendation(s) || ATTRIBUTION.test(s));
  if (good.length >= 3 && words(good.slice(0, 5).join(" ")) <= LIMITS.recommendations[1] + 10) res.recommendations = good.slice(0, 5);
  else if (recs.length) removed.push(`recommendations: ${bad.length ? `${bad.length} not within the rules (${validRecommendation(bad[0]) || "attribution"})` : "fewer than three valid"}; rule-based recommendations kept`);
  if (["background", "analysis", "assessment"].some(k => res[k] !== base[k]) || res.recommendations !== base.recommendations) res.written_by = "ai";
  return { ...res, removed };
}
export function aiPrompt(a, facts) {
  return `Rewrite the four sections of a one-page KDF (Kenya Defence Forces) Information Operations Assessment in formal British English, objective military reporting style. Use ONLY these facts and the draft; do not add facts, places, dates, actors or sources. Keep the evidence-based verdict exactly (${a.verdict_label || "as given"}) and the confidence level; an AI opinion is never evidence. Cite only [1]-[${a.references.length}]. Classify carefully: misinformation = false or misleading information without established intent; disinformation only where evidence shows deliberate intent to deceive; malinformation only where genuine information is used to cause harm. Do not state or imply hostile intent, coordination, foreign involvement or attribution unless the facts include such evidence; criticism of KDF or high engagement is not evidence of hostile intent. No percentages or probabilities. No links.
Sections: background = executive summary (the information, its origin, date, central narrative and significance to KDF); analysis = each of the at most two principal claims with its verdict, supporting and contradicting evidence and the main gap; assessment = what the evidence establishes, the implications for KDF's information environment and public confidence, the classification, observed dissemination, significance, confidence and the main limitation.
Limits: background 40-80 words; analysis 80-180 words; assessment 70-130 words; 3-5 recommendations, each one sentence beginning exactly "There is a need to", oriented to KDF Information Operations (timely clarification through authorised channels, public awareness, monitoring, transparent communication, preserving evidence and authorised review). Never recommend that anyone visit websites, search for evidence or verify the claim manually; never recommend covert activity, suppressing lawful criticism or targeting individuals. If the evidence is insufficient, say so and do not presume the narrative false.
<content>
${JSON.stringify(facts).replace(/<\/?content/gi, "‹content").slice(0, 8000)}
</content>
Draft:
<content>
${JSON.stringify({ background: a.background, analysis: a.analysis, assessment: a.assessment, recommendations: a.recommendations }).replace(/<\/?content/gi, "‹content")}
</content>
JSON: {"background": "...", "analysis": "...", "assessment": "...", "recommendations": ["There is a need to ...", "There is a need to ...", "There is a need to ..."]}`;
}

// ---------------------------------------------------------------- one-page HTML (A4 portrait; prints in black and white)
// Exactly four body sections. Evidence references sit at the end of the Analysis; the main limitation is part of the Assessment.
// The header carries the review and approval status; the footer the Head of Department's approval, when there really is one.
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CSS = `@page{size:A4 portrait;margin:11mm 12mm}*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#111827}
body{font:9.2pt/1.36 "Segoe UI",Calibri,Arial,sans-serif}.page{width:186mm;max-width:100%;margin:0 auto;padding:5mm 0}
.t{background:#0b1f3a;color:#fff;padding:7px 10px;border-bottom:3px solid #9b1c1c;font-weight:700;letter-spacing:.05em;font-size:11pt}
.st{float:right;font-size:7.6pt;font-weight:700;letter-spacing:0;border:1px solid #fff;padding:1px 6px;border-radius:3px;margin-top:1px}
.draft{color:#9b1c1c;border:1.5px solid #9b1c1c;text-align:center;font-weight:800;letter-spacing:.12em;margin:5px 0;padding:2px;font-size:9pt}.ok{color:#05603a;border-color:#05603a}
table.h{width:100%;border-collapse:collapse;font-size:8.1pt;margin:5px 0 3px}table.h td{border:1px solid #c7ccd6;padding:3px 5px;vertical-align:top}table.h td b{display:block;font-size:6.9pt;color:#0b1f3a;text-transform:uppercase;letter-spacing:.04em}
h2{font-size:9pt;margin:8px 0 2px;color:#0b1f3a;letter-spacing:.05em;border-bottom:1.2px solid #0b1f3a;padding-bottom:1px}h2 span{color:#9b1c1c}
p{margin:2px 0;text-align:justify}ol{margin:2px 0 0 17px;padding:0}li{margin:1px 0}.v{border-left:4px solid #9b1c1c;padding:3px 7px;margin:4px 0;background:#f8f9fb;font-weight:600}
.refs{font-size:7.7pt;color:#1f2937;margin-top:3px}.small{font-size:7.7pt;color:#374151}a{color:#0b1f3a}
.ap{margin-top:8px;border:1.2px solid #05603a;padding:4px 7px;font-size:7.8pt}.ap b{color:#05603a}
@media screen{body{background:#eef1f5}.page{background:#fff;padding:11mm 12mm;margin:10px auto;box-shadow:0 1px 4px rgba(0,0,0,.15);width:210mm;min-height:297mm}}
@media screen and (max-width:820px){.page{width:auto;min-height:0;padding:14px;margin:0}table.h td{display:block;border-width:0 0 1px}}
@media print{a{color:inherit;text-decoration:none}.v{background:none}}`;
const refLine = f => `[${f.n}] ${f.publisher}, “${f.title}”${f.date ? `, ${f.date}` : ""} — ${f.addresses}${f.read ? " (full text read)" : ""}.`;
const approvalLine = ap => `Approved by ${ap.name}${ap.designation ? `, ${ap.designation}` : ""}, on ${ap.at_text} · Approval reference ${ap.ref} · Status: APPROVED · Verification code ${ap.code}${ap.verify_path ? ` (verify at ${ap.verify_path})` : ""}`;
export function assessmentHtml(a, { standalone = true } = {}) {
  const h = a.header, approved = !!a.approval;
  const body = `<div class="page"><div class="t">${esc(a.title)}<span class="st">${approved ? "APPROVED" : "DRAFT"}</span></div>
  ${approved ? "" : '<div class="draft">DRAFT — NOT APPROVED</div>'}
  <table class="h"><tr><td><b>Reference</b>${esc(h.reference)}</td><td><b>Date / time</b>${esc(h.date)}</td><td><b>Source / platform</b>${h.source_url ? `<a href="${esc(h.source_url)}" rel="noopener noreferrer" target="_blank">${esc(h.source)}</a>` : esc(h.source)}</td><td><b>Review and approval status</b>${esc(h.status)}</td></tr>
  <tr><td colspan="4"><b>Subject / narrative</b>${esc(h.subject)}</td></tr></table>
  ${a.training ? '<p class="small"><b>TRAINING MATERIAL — synthetic content for practice.</b></p>' : ""}
  <h2><span>1.</span> EXECUTIVE SUMMARY / BACKGROUND INFORMATION</h2><p>${esc(a.background)}</p>
  <h2><span>2.</span> ANALYSIS</h2><p>${esc(a.analysis)}</p>${a.references?.length ? `<div class="refs">${a.references.map(f => `<div>${f.url ? `<a href="${esc(f.url)}" rel="noopener noreferrer" target="_blank">${esc(refLine(f))}</a>` : esc(refLine(f))}</div>`).join("")}</div>` : ""}
  <h2><span>3.</span> ASSESSMENT</h2><div class="v">Verdict: ${esc(a.verdict_label)} · Confidence: ${esc(a.strength)}</div><p>${esc(a.assessment)}${a.limitation ? ` ${esc(a.limitation)}` : ""}</p>
  <h2><span>4.</span> RECOMMENDATIONS</h2><ol>${a.recommendations.map(x => `<li>${esc(x)}</li>`).join("")}</ol>
  ${approved ? `<div class="ap"><b>APPROVED BY HEAD OF DEPARTMENT</b> — ${esc(approvalLine(a.approval))}</div>` : `<p class="small" style="margin-top:8px">${esc(a.written_by === "ai" ? "AI-assisted draft generated by AIVS; verdicts follow the evidence and fixed rules." : "Draft generated by AIVS from the evidence collected.")} Not approved for release: Head of Department approval is required.</p>`}</div>`;
  return standalone ? `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(a.header.reference)} · KDF Information Operations Assessment</title><style>${CSS}</style></head><body>${body}</body></html>` : body;
}

// ---------------------------------------------------------------- one-page PDF (pdfkit); the text is shrunk, never cut, to fit one A4 page
const pdfSafe = s => String(s ?? "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/…/g, "...").replace(/·/g, "|").replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/gu, "?");
export async function assessmentPdf(a) {
  const { default: PDFDocument } = await import("pdfkit");
  const approved = !!a.approval;
  const render = size => new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 32, bottom: 28, left: 36, right: 36 }, bufferPages: true, info: { Title: `${a.header.reference} - KDF Information Operations Assessment${approved ? "" : " (DRAFT - NOT APPROVED)"}`, Author: approved ? `AIVS; approved by ${pdfSafe(a.approval.name)}` : "AIVS (draft)", Subject: pdfSafe(a.header.subject), Keywords: approved ? `approval ${a.approval.ref}` : "draft not approved" } });
    const chunks = []; doc.on("data", c => chunks.push(c)); doc.on("error", reject);
    doc.on("end", () => resolve({ buf: Buffer.concat(chunks), pages }));
    const W = doc.page.width - 72, NAVY = "#0b1f3a", RED = "#9b1c1c", GREEN = "#05603a", L = 36;
    const p = (t, o = {}) => doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(o.size || size).fillColor(o.color || "#111827").text(pdfSafe(t), o.x ?? L, o.y, { width: o.w || W, align: o.align || "justify", lineGap: 0.8, ...(o.link ? { link: o.link, underline: false } : {}) });
    const h2 = (n, t) => { doc.moveDown(0.4); const y = doc.y; doc.font("Helvetica-Bold").fontSize(size + 0.2).fillColor(RED).text(`${n} `, L, y, { continued: true }).fillColor(NAVY).text(t); const y2 = doc.y + 1; doc.moveTo(L, y2).lineTo(L + W, y2).lineWidth(0.9).strokeColor(NAVY).stroke(); doc.y = y2 + 2; };
    doc.rect(L, 28, W, 20).fill(NAVY); doc.rect(L, 48, W, 2.2).fill(RED);
    doc.font("Helvetica-Bold").fontSize(10.6).fillColor("#ffffff").text(pdfSafe(a.title), L + 7, 33.5, { width: W - 90, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(7.5).text(approved ? "APPROVED" : "DRAFT", L + W - 80, 35, { width: 73, align: "right" });
    let y = 54;
    if (!approved) { doc.rect(L, y, W, 13).lineWidth(1.2).strokeColor(RED).stroke(); doc.font("Helvetica-Bold").fontSize(8.5).fillColor(RED).text("DRAFT - NOT APPROVED", L, y + 3, { width: W, align: "center", characterSpacing: 1.2 }); y += 16; }
    const cw = W / 4;
    const cell = (x, w, k, v, link, hgt = 27) => { doc.font("Helvetica-Bold").fontSize(6.2).fillColor(NAVY).text(k.toUpperCase(), x + 3, y + 2, { width: w - 6 }); doc.font("Helvetica").fontSize(7.4).fillColor("#111827").text(pdfSafe(v), x + 3, y + 9, { width: w - 6, height: hgt - 10, ellipsis: true, ...(link ? { link } : {}) }); doc.rect(x, y, w, hgt).lineWidth(0.5).strokeColor("#9aa3b2").stroke(); };
    cell(L, cw * 0.8, "Reference", a.header.reference); cell(L + cw * 0.8, cw * 0.9, "Date / time", a.header.date); cell(L + cw * 1.7, cw * 1.0, "Source / platform", a.header.source, a.header.source_url || undefined); cell(L + cw * 2.7, cw * 1.3, "Review and approval status", a.header.status); y += 27;
    cell(L, W, "Subject / narrative", a.header.subject, undefined, 20); y += 20;
    doc.y = y + 2;
    if (a.training) p("TRAINING MATERIAL - synthetic content for practice.", { bold: true, size: size - 1.2 });
    h2("1.", "EXECUTIVE SUMMARY / BACKGROUND INFORMATION"); p(a.background);
    h2("2.", "ANALYSIS"); p(a.analysis);
    if (a.references?.length) { doc.moveDown(0.15); a.references.forEach(f => p(`${refLine(f)}${f.url ? ` ${f.url}` : ""}`, { size: size - 1.6, color: "#1f2937", align: "left", link: f.url || undefined })); }
    h2("3.", "ASSESSMENT"); { const yy = doc.y; doc.rect(L, yy, 3, size + 1.5).fill(RED); p(`Verdict: ${a.verdict_label}  |  Confidence: ${a.strength}`, { bold: true, x: L + 7, w: W - 7, align: "left" }); doc.moveDown(0.15); } p(`${a.assessment}${a.limitation ? ` ${a.limitation}` : ""}`);
    h2("4.", "RECOMMENDATIONS"); a.recommendations.forEach((x, i) => p(`${i + 1}.  ${x}`, { align: "left" }));
    doc.moveDown(0.5);
    if (approved) { const yy = doc.y; const t = `APPROVED BY HEAD OF DEPARTMENT - ${approvalLine(a.approval)}`; const hh = doc.font("Helvetica").fontSize(size - 1.4).heightOfString(pdfSafe(t), { width: W - 10 }) + 6; doc.rect(L, yy, W, hh).lineWidth(1).strokeColor(GREEN).stroke(); p(t, { size: size - 1.4, color: GREEN, x: L + 5, y: yy + 3, w: W - 10, align: "left" }); }
    else p(`${a.written_by === "ai" ? "AI-assisted draft generated by AIVS; verdicts follow the evidence and fixed rules." : "Draft generated by AIVS from the evidence collected."} Not approved for release: Head of Department approval is required.`, { size: size - 1.4, color: "#374151" });
    const pages = doc.bufferedPageRange().count;
    doc.end();
  });
  for (const size of [9.2, 8.8, 8.4, 8, 7.6, 7.2, 6.8]) { const r = await render(size); if (r.pages === 1) return { ...r, size }; if (size === 6.8) return { ...r, size }; }
}

// ---------------------------------------------------------------- one-page Word
export function assessmentDocxXml(a) {
  const x = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, "");
  const run = (t, { b, color, size = 18 } = {}) => `<w:r><w:rPr>${b ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
  const para = (inner, { after = 40, shade = null, jc = "both" } = {}) => `<w:p><w:pPr><w:spacing w:before="0" w:after="${after}"/><w:jc w:val="${jc}"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:pPr>${inner}</w:p>`;
  const h2 = (n, t) => `<w:p><w:pPr><w:spacing w:before="100" w:after="30"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="0B1F3A"/></w:pBdr></w:pPr>${run(n + " ", { b: true, color: "9B1C1C", size: 19 })}${run(t, { b: true, color: "0B1F3A", size: 19 })}</w:p>`;
  const h = a.header, cellX = (k, v, span = 1) => `<w:tc><w:tcPr>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(k.toUpperCase(), { b: true, color: "0B1F3A", size: 13 })}</w:p><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(v, { size: 16 })}</w:p></w:tc>`;
  const B = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(s => `<w:${s} w:val="single" w:sz="4" w:color="9AA3B2"/>`).join("")}</w:tblBorders>`;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${B}</w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid><w:tr>${cellX("Reference", h.reference)}${cellX("Date / time", h.date)}${cellX("Source / platform", h.source)}${cellX("Review and approval status", h.status)}</w:tr><w:tr>${cellX("Subject / narrative", h.subject, 4)}</w:tr></w:tbl>`;
  const body = [para(run(a.title, { b: true, color: "FFFFFF", size: 22 }), { shade: "0B1F3A", after: 60, jc: "left" }), a.approval ? "" : para(run("DRAFT — NOT APPROVED", { b: true, color: "9B1C1C", size: 18 }), { jc: "center" }), table,
    a.training ? para(run("TRAINING MATERIAL — synthetic content for practice.", { b: true, size: 16 })) : "",
    h2("1.", "EXECUTIVE SUMMARY / BACKGROUND INFORMATION"), para(run(a.background)), h2("2.", "ANALYSIS"), para(run(a.analysis)),
    ...(a.references || []).map(f => para(run(`${refLine(f)}${f.url ? ` ${f.url}` : ""}`, { size: 15 }), { after: 10, jc: "left" })),
    h2("3.", "ASSESSMENT"), para(run(`Verdict: ${a.verdict_label} · Confidence: ${a.strength}`, { b: true }), { jc: "left" }), para(run(`${a.assessment}${a.limitation ? ` ${a.limitation}` : ""}`)),
    h2("4.", "RECOMMENDATIONS"), ...a.recommendations.map((r, i) => para(run(`${i + 1}.  ${r}`), { after: 10, jc: "left" })),
    a.approval ? para(run(`APPROVED BY HEAD OF DEPARTMENT — ${approvalLine(a.approval)}`, { b: true, color: "05603A", size: 15 }), { jc: "left" }) : para(run("Not approved for release: Head of Department approval is required.", { size: 15, color: "374151" }))].join("");
  return `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="640" w:right="700" w:bottom="640" w:left="700" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body>`;
}

import { informationTasks } from "../../shared/information-tasks.js";
// Formal one-page report (UNIT: STRATEGIC COMMUNICATION / RESTRICTED): what it says.
// A draft is written only from records AIVS already holds: a verification case (claims, verdicts, accepted
// evidence, the reviewer's decision) or a social media dataset analysis. Nothing is invented: a fact that is not
// recorded is written as "not recorded" so the author can supply it. The author then edits every part before
// printing. Formatting, Word, PDF and printing are in formal-print.js.
import { fit } from "./formal-print.js";
import { CONCLUSION_LABELS, VERDICTS } from "../../shared/verdict.js";

export const UNAVAILABLE = "Not recorded; requires verification.";
// Military date-time group: DDHHMM, time zone letter, month, two-digit year (281430Z OCT 26). Z = UTC.
export const dtg = (d = new Date()) => `${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}Z ${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(-2)}`;
export const DTG_RE = /^\d{6}[A-IK-Z] (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) \d{2}$/;
export const LIMITS = { date: 40, subject: 200, section: 6000, recommendation: 600, recommendations: 12, preparer: 120 };
const SECTION_KEYS = ["purpose", "background", "analysis", "assessment", "conclusion"];
const LABELS = { date: "Date-time group", subject: "Subject", purpose: "1. Purpose", background: "2. Background", analysis: "3. Analysis", assessment: "5. Assessment", recommendations: "6. Recommendations", conclusion: "7. Conclusion", rank: "Rank", name: "Name", appointment: "Appointment" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : null; };
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s; };
const sentence = s => { s = String(s || "").trim(); return !s ? "" : /[.!?…”"]$/.test(s) ? s : `${s}.`; };
const plural = (n, w, p = `${w}s`) => `${n} ${Number(String(n).replace(/,/g, "")) === 1 ? w : p}`;
const list = a => a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`;

// Text over a limit is refused with the field named, never cut without telling the author.
export function tooLong(input = {}) {
  const over = [], len = v => String(v ?? "").trim().length, recs = Array.isArray(input.recommendations) ? input.recommendations : String(input.recommendations ?? "").split(/\n+/);
  if (len(input.date) > LIMITS.date) over.push(`${LABELS.date} (at most ${LIMITS.date} characters)`);
  if (len(input.subject) > LIMITS.subject) over.push(`${LABELS.subject} (at most ${LIMITS.subject} characters)`);
  for (const k of SECTION_KEYS) if (len(input[k]) > LIMITS.section) over.push(`${LABELS[k]} (at most ${LIMITS.section} characters)`);
  if (recs.filter(x => String(x).trim()).length > LIMITS.recommendations) over.push(`${LABELS.recommendations} (at most ${LIMITS.recommendations} points)`);
  if (recs.some(x => len(x) > LIMITS.recommendation)) over.push(`a recommendation (at most ${LIMITS.recommendation} characters each)`);
  for (const k of ["rank", "name", "appointment"]) if (len(input.preparer?.[k]) > LIMITS.preparer) over.push(`${LABELS[k]} (at most ${LIMITS.preparer} characters)`);
  return over;
}
// Clean user input into the stored shape, enforcing the limits.
export function normalise(input = {}, base = {}) {
  const s = (v, n) => String(v ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);
  const recs = Array.isArray(input.recommendations) ? input.recommendations : String(input.recommendations ?? "").split(/\n+/);
  const p = input.preparer || {};
  return {
    date: s(input.date, LIMITS.date).toUpperCase(),
    subject: s(input.subject, LIMITS.subject),
    ...Object.fromEntries(SECTION_KEYS.map(k => [k, s(input[k], LIMITS.section)])),
    // "(a)" labels are added when printed: remove any the author typed, and any bullet or number
    recommendations: recs.map(x => s(String(x).replace(/^\s*(\(?[a-z]{1,2}[).]|[-•*–]|\d+[.)])\s+/i, ""), LIMITS.recommendation)).filter(Boolean).slice(0, LIMITS.recommendations),
    preparer: { rank: s(p.rank, LIMITS.preparer), name: s(p.name, LIMITS.preparer), appointment: s(p.appointment, LIMITS.preparer) },
    source: base.source || input.source || null
  };
}

// Required fields. Returns a list of plain-language problems (empty when complete).
export function validate(r) {
  const missing = [];
  if (!r.date) missing.push(LABELS.date);
  if (!r.subject) missing.push(LABELS.subject);
  for (const k of SECTION_KEYS) if (!r[k]) missing.push(LABELS[k]);
  if (!r.recommendations?.length) missing.push(`${LABELS.recommendations} (at least one)`);
  // Rank, Name and Appointment are printed blank by default, to be completed by hand; they are optional
  const placeholder = [r.subject, ...SECTION_KEYS.map(k => r[k]), ...(r.recommendations || [])].some(t => /\[(rank|name|appointment|subject|insert[^\]]*)\]/i.test(t || ""));
  const badDate = r.date && !DTG_RE.test(r.date) ? [`Write the date-time group as DDHHMM, zone letter, month, year, for example ${dtg()}.`] : [];
  return [...(missing.length ? [`Complete: ${missing.join(", ")}.`] : []), ...badDate, ...(placeholder ? ["Replace the text in square brackets."] : [])];
}

export function check(r) { const problems = validate(r), layout = fit(r); return { problems, layout, ready: !problems.length && layout.fits }; }

// Write the shortest version that still fits, starting from the most detailed.
function shortest(build) { let last; for (const lvl of [0, 1, 2, 3]) { last = build(lvl); if (fit(last).fits) return last; } return last; }

// ------------------------------------------------------------------ from a verification case
const DECIDED = new Set(["supported", "contradicted", "partially_supported", "misleading_context"]);
export function fromCase(d, preparer) {
  return shortest(lvl => {
    const c = d.case, k = d.conclusion, claims = d.claims.filter(x => x.type !== "removed");
    const maxClaims = [6, 4, 3, 2][lvl], cut = [220, 150, 110, 80][lvl];
    const ev = cl => { const s = cl.evidence.filter(e => e.stance === "supports").length, x = cl.evidence.filter(e => e.stance === "contradicts").length; return { s, x, n: cl.evidence.length }; };
    const approved = d.review.approved, label = k.label || null;
    const src = [c.source.platform, c.source.account ? `account ${c.source.account}` : null].filter(Boolean).join(", ");

    const purpose = `To report the outcome of the verification of “${clip(c.title, 140)}” (JICHO AI case ${c.id}) and to recommend handling action.`;

    const bg = [];
    bg.push(`${c.dates.received_at ? `On ${day(c.dates.received_at)}` : "On a date not recorded,"} the following content was received for verification${src ? ` from ${src}` : ""}: “${clip(c.claim_as_received || c.claim_working_text, [320, 240, 180, 130][lvl])}”`);
    bg.push(`Date first published: ${c.dates.published_at ? `${day(c.dates.published_at)}${c.dates.published_basis ? ` (${clip(c.dates.published_basis, 80)})` : ""}` : "not recorded; requires verification"}.${d.topic ? ` Topic: ${d.topic}.` : ""}${c.source.url && lvl < 2 ? ` Source: ${clip(c.source.url, 90)}.` : ""}`);
    if (d.related_cases?.length && lvl < 2) bg.push(`Related JICHO AI cases: ${d.related_cases.slice(0, 3).map(r => r.id).join(", ")}.`);

    const an = [];
    if (!claims.length) an.push(`No checkable claim has been recorded in the case. ${UNAVAILABLE}`);
    else {
      an.push(`${plural(claims.length, "claim")} examined; ${plural(d.evidence.length, "evidence item")} accepted by the analyst.`);
      const said = new Set();   // the same rationale is written once, not repeated for every claim
      for (const cl of claims.slice(0, maxClaims)) {
        const e = ev(cl), status = DECIDED.has(cl.assessment) ? "Verified" : "Unverified", why = cl.rationale && lvl < 3 && !said.has(cl.rationale.trim()) ? ` ${sentence(clip(cl.rationale, [200, 140, 100][lvl]))}` : "";
        if (cl.rationale) said.add(cl.rationale.trim());
        an.push(`Claim ${cl.number} (${status}): “${clip(cl.text, cut)}”; verdict: ${cl.assessment_label || "Not assessed"}${e.n ? ` (${plural(e.x, "source")} ${e.x === 1 ? "contradicts" : "contradict"}, ${e.s} ${e.s === 1 ? "supports" : "support"})` : " (no accepted evidence)"}.${why}`);
      }
      if (claims.length > maxClaims) an.push(`${plural(claims.length - maxClaims, "further claim")} ${claims.length - maxClaims === 1 ? "is" : "are"} recorded in verification report ${c.id}.`);
    }
    const leads = [];
    if (d.media.length) leads.push(`${plural(d.media.length, "media file")} checked against the reference archive (${plural(d.matches.length, "match", "matches")}; similarity is a lead, not proof)`);
    if (d.ocr.length && lvl < 2) leads.push(`text read from ${plural(d.ocr.length, "image")}`);
    if (leads.length) an.push(`${sentence(leads.join("; ").replace(/^./, x => x.toUpperCase()))}`);
    if (k.uncertainties) an.push(`Analytical assumptions and uncertainties: ${sentence(clip(k.uncertainties, [300, 200, 150, 100][lvl]))}`);

    const as = [];
    const outcome = { supported: "accurate", contradicted: "false", misleading_context: "misleading in its stated context" }[k.value];
    const grounded = outcome && claims.length && k.rationale && claims.every(cl => cl.evidence.some(e => k.value === "supported" ? e.stance === "supports" : e.stance === "contradicts" || e.stance === "misleading"));
    as.push(grounded ? `It is likely that the assessed content is ${outcome}, based on accepted evidence linked to the claims. Confidence has not been separately graded in the case record.` : "Insufficient evidence to assess a likelihood. No probability judgement is made where evidence is incomplete or conflicting.");
    as.push(label ? `Overall assessment: ${label.toUpperCase()}.${k.rationale ? ` ${sentence(clip(k.rationale, [420, 300, 220, 160][lvl]))}` : " The rationale has not been recorded; requires analyst input."}` : "No overall assessment has been recorded; the case is still under analysis.");
    as.push(approved ? `Assessment approved by ${d.review.decided_by} on ${day(d.review.decided_at)}.` : "The assessment has not yet been approved by a reviewer and is provisional.");
    const verdicts = claims.map(x => x.assessment);
    if (verdicts.some(v => !DECIDED.has(v)) && verdicts.some(v => DECIDED.has(v))) as.push("Some claims remain unverified; they must not be presented as confirmed.");

    const recs = [];
    const v = k.value;
    if (["contradicted", "misleading_context", "mixed"].includes(v)) {
      recs.push(`Do not repeat or amplify the contradicted ${v === "mixed" ? "parts of the content" : "content"} as fact in any communication.`);
      recs.push(`Task authorised information operations staff to prepare a factual clarification for approval, citing the accepted evidence in case ${c.id}${d.evidence.some(e => e.citation?.url) ? " and its published sources" : ""}.`);
      recs.push("Monitor the public narrative through the JICHO AI Watchlist and report observed changes in reach and recurring claims.");
    } else if (v === "supported" || v === "partially_supported") {
      recs.push("Task authorised information operations staff to prepare factual talking points, citing the accepted evidence, for approval where a response is required.");
      recs.push(`Record case ${c.id} as the reference for any further enquiries on this content.`);
    } else if (v === "insufficient") {
      recs.push("Treat the content as unverified and do not use it as a basis for communication or action.");
      recs.push("Seek confirmation from the original or an authoritative source and add the result to the case.");
      recs.push("Reassess the narrative when additional evidence becomes available and submit the revised judgement for review.");
    } else if (v === "not_verifiable") {
      recs.push("Handle the content as opinion or prediction; it cannot be confirmed or refuted as fact.");
      recs.push("Monitor its spread and audience reaction where it is relevant to the mission.");
    } else {
      recs.push("Complete the verification and record an overall assessment before this report is used.");
    }
    recs.splice(0, recs.length, ...informationTasks(k.value === "misleading_context" ? "misleading" : k.value, as[0], {reference:`(case ${c.id})`}).map(t => t.replace(/^There is a need to /,"")));
    if (!approved && label) recs.push(`Obtain reviewer approval of case ${c.id} before acting on this assessment.`);

    const concl = label
      ? `The content in case ${c.id} is assessed as ${label.toLowerCase()}${approved ? " (approved)" : " (provisional, awaiting approval)"}. Follow-up: action recommendations ${recs.length > 1 ? `(a) to (${String.fromCharCode(96 + recs.length)})` : "(a)"}.`
      : `Verification of case ${c.id} is incomplete. Follow-up: complete the assessment and reissue this report.`;
    return normalise({ date: dtg(), subject: c.title, purpose, background: bg.join("\n"), analysis: an.join("\n"), assessment: as.join("\n"), recommendations: recs, conclusion: concl, preparer }, { source: { kind: "case", id: c.id, revision: c.revision } });
  });
}

// ------------------------------------------------------------------ from a social media dataset analysis
export function fromDataset(d, preparer) {
  return shortest(lvl => {
    const ds = d.dataset, cp = d.collection_period || {}, ind = d.coordination_indicators || null, C = d.claims || { total: 0, by_status: {}, listed: [] };
    const purpose = `To report the analysis of the social media dataset “${clip(ds.name, 120)}” and to recommend follow-up action.${d.research_question ? ` Research question: ${sentence(clip(d.research_question, 200))}` : ""}`;
    const bg = [
      `The dataset holds ${plural((ds.posts || 0).toLocaleString("en-GB"), "post")} from ${plural((ds.accounts || 0).toLocaleString("en-GB"), "account")}, posted between ${day(cp.first_post) || "an unrecorded date"} and ${day(cp.last_post) || "an unrecorded date"}.`,
      `Source: ${ds.source ? clip(ds.source, 120) : "not recorded"}; basis for use: ${ds.authorisation ? clip(ds.authorisation, 120) : "not recorded; requires verification"}. Imported ${day(ds.imported_at) || "on an unrecorded date"}.`,
      d.synthetic ? "This is SYNTHETIC demonstration data and is not evidence about real events." : null
    ].filter(Boolean);
    // the first summary line repeats the dataset size and period already given in the background
    const exec = (d.executive_summary || []).filter((x, i) => !(i === 0 && /posts from .* accounts, posted between/.test(x)) && !/checkable claims? found/.test(x)).map(x => x.replace(/\s*\(rule-based estimate; see limitations\)/, " (rule-based estimate)"))
      .slice(0, [6, 5, 4, 3][lvl]).map(x => clip(x, [260, 200, 160, 130][lvl]));
    const an = exec.length ? exec : [UNAVAILABLE];
    const claims = C.listed || [];
    if (claims.length && lvl < 3) an.push(`Most repeated claims: ${claims.slice(0, [3, 2, 1][lvl]).map(c => `“${clip(c.text, [110, 90, 70][lvl])}” (${plural(c.posts || 0, "post")}${c.case_conclusion ? `, verified as ${(CONCLUSION_LABELS[c.case_conclusion] || c.case_conclusion).toLowerCase()}` : ", unverified"})`).join("; ")}.`);
    an.push("Tone, topics and coordination indicators are computed estimates; they are not verified facts.");
    const as = [];
    if (ind?.synchronised) as.push(`${plural(ind.synchronised, "synchronised repeated message")} ${ind.synchronised === 1 ? "indicates" : "indicate"} possible coordinated activity that requires examination of the accounts involved; this is not proof of coordination.`);
    const reviewed = claims.filter(c => c.case_conclusion).length, open = C.by_status?.needs_review || 0;
    as.push(C.total ? `${plural(C.total, "checkable claim")} identified: ${reviewed} reviewed in JICHO AI cases, ${open} still requiring review.` : "No checkable claim was identified in the posts analysed.");
    as.push("The findings describe this dataset only and should not be generalised without comparison with other sources.");
    const recs = (d.recommendations || []).slice(0, [6, 5, 4, 3][lvl]).map(x => clip(x, [260, 200, 160, 140][lvl]));
    const concl = `The dataset analysis is complete for ${plural((ds.posts || 0).toLocaleString("en-GB"), "post")}${d.synthetic ? " of synthetic data" : ""}. Follow-up: action recommendations ${recs.length > 1 ? `(a) to (${String.fromCharCode(96 + recs.length)})` : "(a)"}${open ? ` and verify the ${plural(open, "claim")} still requiring review` : ""}.`;
    return normalise({ date: dtg(), subject: d.title, purpose, background: bg.join("\n"), analysis: an.join("\n"), assessment: as.join("\n"), recommendations: recs.length ? recs : ["Review the dataset analysis and record recommendations."], conclusion: concl, preparer }, { source: { kind: "dataset", id: ds.id } });
  });
}

// ------------------------------------------------------------------ storage
export function makeFormalReports(db, { audit }) {
  const get = (kind, id) => { const r = db.prepare("SELECT * FROM formal_reports WHERE source_kind = ? AND source_id = ?").get(kind, String(id)); return r ? { ...r, content: JSON.parse(r.content_json), content_json: undefined } : null; };
  function save(user, kind, id, content, note) {
    const now = new Date().toISOString(), json = JSON.stringify(content), cur = get(kind, id);
    if (cur) db.prepare("UPDATE formal_reports SET content_json = ?, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(json, user.id, now, cur.id);
    else db.prepare("INSERT INTO formal_reports(source_kind, source_id, content_json, revision, created_by, created_at, updated_by, updated_at) VALUES (?,?,?,1,?,?,?,?)").run(kind, String(id), json, user.id, now, user.id, now);
    db.prepare("INSERT INTO formal_report_versions(source_kind, source_id, content_json, saved_by, saved_at, note) VALUES (?,?,?,?,?,?)").run(kind, String(id), json, user.id, now, note || null);
    audit(user, note || "Formal report saved", kind === "case" ? "case" : "io_dataset", String(id));
    return get(kind, id);
  }
  return { get, save };
}
export { VERDICTS };

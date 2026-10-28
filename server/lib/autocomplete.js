// Automatic completion of an investigation's case (1.33). After the evidence has been searched, read and compared, AIVS
// itself completes what an analyst used to complete by hand in the case workspace:
//   - at most two principal claims stay in the case; the other statements are recorded but not assessed;
//   - every retrieved evidence item is validated against the documented rules below and accepted (linked to its claim as
//     supporting, contradicting or context) or dismissed, with the result of each rule kept on the item;
//   - each claim's verdict is decided from the ACCEPTED evidence only, so a claim can never be "Supported" without accepted
//     supporting evidence; a preliminary reading that the accepted evidence does not carry is corrected and the correction stated;
//   - an evidence-based rationale (what was observed, then how it was interpreted), the overall conclusion that follows from
//     the claim verdicts, its reasoning, a confidence assessment, the evidence limitations and the remaining uncertainties.
// Everything is written as one versioned, audited change of the case. Nothing is invented: when evidence is missing or could
// not be retrieved, the result is an uncertainty verdict and the uncertainty is recorded.
import { nowISO } from "./db.js";
import { VERDICTS, CONCLUSION_LABELS, expectedConclusion, verdictNeeds } from "../../shared/verdict.js";
import { assessClaim, overall, AUTO_VERDICTS, STRENGTH } from "./autoeval.js";

// the documented evidence-acceptance rules; an item is accepted only when every rule passes
export const ACCEPT_RULES = {
  principal: "It was retrieved for one of the principal claims (at most two per investigation).",
  retrievable: "It has its original web address (http or https), a published fact-check rating, or an approved AIVS knowledge-base record, and the time it was retrieved is recorded.",
  reliable: "It comes from an official source, an established fact-checking organisation (including a published ClaimReview rating returned by Google Fact Check Tools), an established news organisation or the AIVS knowledge base. Wikipedia and other reference works, earlier AIVS investigations, social media and websites whose reliability is not assessed are not accepted as evidence.",
  relevant: "Its text addresses the claim: a text similarity of at least 0.12 for supporting or contradicting items and 0.25 for context, or a published rating of the claim.",
  independent: "It is not a repeat of an item already counted (same organisation, or near-identical wording of the same original report).",
  stance: "Its stance (supports, contradicts, context) was decided by a published rating or by the fixed wording rules. An AI reading alone never decides it.",
  limit: "At most two evidence items are accepted for each claim: the two strongest that pass every rule (published ratings and supporting or contradicting items before context; when the evidence conflicts, one of each side is kept)."
};
export const MAX_EVIDENCE_PER_CLAIM = 2;
// the two items kept for a claim, from those that passed every other rule
export function pickTwo(items) {
  const rank = e => (e.rating ? 2 : 0) + (["supports", "contradicts"].includes(e.stance) || e.stance === "misleading" ? 1 : 0);
  const sorted = [...items].sort((a, b) => rank(b) - rank(a) || (b.score ?? 0) - (a.score ?? 0));
  const sup = sorted.find(e => e.stance === "supports"), con = sorted.find(e => e.stance === "contradicts" || (e.stance === "misleading" && e.rating));
  if (sup && con) return [con, sup];
  return sorted.slice(0, MAX_EVIDENCE_PER_CLAIM);
}
const RELIABLE = new Set(["official", "fact_checker", "news", "knowledge_base"]);
const TO_CASE = { supported: "supported", contradicted: "contradicted", misleading: "contradicted", insufficient: "insufficient", mixed: "insufficient", not_verifiable: "not_verifiable" };
export const CONFIDENCE_OF = { strong: "High", moderate: "Medium", weak: "Low", none: "Low" };
const date = d => d ? String(d).slice(0, 10) : "date not known";
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };

// one item against the rules: { ok, stance (case link stance), failed: [rule], notes: [] }
export function validate(e, principalIds) {
  const failed = [], notes = [];
  if (!principalIds.has(e.claim_id)) failed.push("principal");
  if (!(/^https?:\/\//i.test(e.source_url || "") || e.rating || e.connector === "kb") || !e.retrieved_at) failed.push("retrievable");
  if (!RELIABLE.has(e.tier) && !(e.connector === "factcheck" && e.rating)) failed.push("reliable");
  const decisive = ["supports", "contradicts"].includes(e.stance) || (e.stance === "misleading" && e.rating);
  const stance = e.stance === "supports" ? "supports" : e.stance === "contradicts" || (e.stance === "misleading" && e.rating) ? "contradicts" : "context";
  if (!e.rating && (e.relevance ?? 0) < (decisive ? 0.12 : 0.25)) failed.push("relevant");
  if (e.repeat_of) failed.push("independent");
  if (e.read_error) notes.push(`the full page could not be read (${cut(e.read_error, 80)}); the search excerpt was used`);
  else if (e.page_read) notes.push("the full source page was read");
  if (e.ai_disagrees) notes.push(`the AI read it as “${e.ai_stance}”; the rules decided “${e.stance}”`);
  return { ok: !failed.length, stance, decisive: !!decisive, failed, notes };
}

// compared: the investigation's compared evidence; assessments: the preliminary per-claim results (same order as claims)
export function makeAutoComplete(db, { cases }) {
  function complete(user, { caseId, claims, otherClaims = [], compared, assessments, searched, connectors = [], media = null, source = {}, aiState = null }) {
    const principalIds = new Set(claims.map(c => c.id)), checks = new Map();
    for (const e of compared) checks.set(e.id, validate(e, principalIds));
    for (const cl of claims) {   // at most two accepted evidence items per claim
      const pass = compared.filter(e => e.claim_id === cl.id && checks.get(e.id).ok), keep = new Set(pickTwo(pass).map(e => e.id));
      for (const e of pass) if (!keep.has(e.id)) { const v = checks.get(e.id); v.ok = false; v.failed.push("limit"); }
    }
    const accepted = compared.filter(e => checks.get(e.id).ok);
    // the verdict of each claim, decided again from the accepted evidence only
    const finals = claims.map((cl, i) => {
      const pre = assessments[i], fin = assessClaim(cl, accepted.filter(e => e.claim_id === cl.id).map(e => ({ ...e, stance: e.stance === "related" ? "related" : e.stance })), searched);
      if (pre.verdict !== fin.verdict && !["not_verifiable"].includes(pre.verdict)) fin.corrected_from = pre.verdict;
      return fin;
    });
    // safety net: never a decisive verdict without the matching accepted link
    const links = new Map(claims.map(c => [c.id, accepted.filter(e => e.claim_id === c.id).map(e => checks.get(e.id).stance)]));
    claims.forEach((cl, i) => {
      const need = verdictNeeds(TO_CASE[finals[i].verdict], links.get(cl.id));
      if (need) { finals[i] = { ...finals[i], corrected_from: finals[i].corrected_from || finals[i].verdict, verdict: "insufficient", strength: "weak", reason: `${finals[i].reason} No accepted evidence carries that reading, so the claim is assessed as insufficient evidence.` }; }
    });
    const ov = overall(finals, claims, media?.reuse || []);
    const conclusion = expectedConclusion(claims.map((c, i) => ({ assessment: TO_CASE[finals[i].verdict] })));
    const order = ["none", "weak", "moderate", "strong"], decisive = finals.filter(f => f.verdict !== "not_verifiable");
    const strength = decisive.length ? decisive.map(f => f.strength).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] : "none";
    const confidence = CONFIDENCE_OF[ov.verdict === "insufficient" ? "none" : strength] || "Low";

    // rationale per claim: observed facts first, then the rule-based interpretation
    const failedSearch = connectors.filter(c => c.status === "error" || (c.status === "partial" && (c.errors || []).length)), emptySearch = connectors.filter(c => c.status === "ok" && !c.results && !["holdings", "kb"].includes(c.key));
    const rationale = claims.map((cl, i) => {
      const mine = compared.filter(e => e.claim_id === cl.id), acc = mine.filter(e => checks.get(e.id).ok), f = finals[i];
      const by = k => acc.filter(e => checks.get(e.id).stance === k), rej = mine.filter(e => !checks.get(e.id).ok);
      const why = {}; for (const e of rej) for (const r of checks.get(e.id).failed) why[r] = (why[r] || 0) + 1;
      const obs = [`Observed: ${searched ? `${plural(mine.length, "item")} retrieved for this claim` : "no outside evidence source could be searched"}`
        + (mine.length ? `; ${plural(acc.length, "item")} accepted under the AIVS evidence rules (${by("supports").length} supporting, ${by("contradicts").length} contradicting, ${by("context").length} context)` : "")
        + (rej.length ? `; ${rej.length} not accepted (${Object.entries(why).map(([k, n]) => `${n} ${{ principal: "not about a principal claim", retrievable: "without an original address", reliable: "not from a reliable source type", relevant: "not relevant enough", independent: "duplicates", stance: "stance not established", limit: "beyond the two strongest items" }[k]}`).join(", ")})` : "") + "."];
      for (const e of acc.slice(0, 3)) obs.push(`${e.publisher || e.reference} (${date(e.source_published_at)}) ${checks.get(e.id).stance}${e.rating ? `, rated “${cut(e.rating, 40)}”` : ""}: “${cut(e.passage || e.source_title || e.snippet, 140)}” ${e.source_url || ""}`.trim());
      const interp = `Interpretation (AIVS rules): ${f.reason}${f.corrected_from ? ` The preliminary reading “${AUTO_VERDICTS[f.corrected_from]}” was corrected to “${AUTO_VERDICTS[f.verdict]}” because the accepted evidence does not carry it.` : ""}`;
      return `${obs.join(" ")} ${interp}`.slice(0, 3900);
    });

    // remaining uncertainties and evidence limitations, each tied to a claim where it concerns one
    const unc = [];
    claims.forEach((cl, i) => { if (["insufficient", "not_verifiable", "mixed"].includes(finals[i].verdict)) unc.push({ claim_id: cl.id, code: "auto_claim", text: `Claim ${cl.seq}: ${finals[i].reason}` }); });
    if (!searched) unc.push({ code: "auto_search", text: "No outside evidence source could be searched (none is configured or none answered), so no claim could be checked against independent sources." });
    for (const c of failedSearch) unc.push({ code: "auto_connector", text: `${c.label} could not be searched (connector error: ${cut((c.errors || [])[0] || c.status, 120)}); this is a system failure, not a finding that no evidence exists.` });
    if (emptySearch.length) unc.push({ code: "auto_empty", text: `${emptySearch.map(c => c.label).join(", ")} answered but returned no results for the claims.` });
    const unread = compared.filter(e => e.read_error && checks.get(e.id).ok);
    if (unread.length) unc.push({ code: "auto_unread", text: `${plural(unread.length, "accepted source page")} could not be read in full; the search excerpt was used.` });
    // 1.34: a screenshot shows a post but does not prove it exists or was published as shown
    if (source.input_type === "screenshot") unc.push({ code: "auto_screenshot", text: `The content is known from a screenshot submitted by an analyst; ${source.screenshot?.original?.retrieved ? "the original post was retrieved from the visible link for comparison" : "the original post was not independently retrieved"}. A screenshot is not proof that the post exists or was published as shown, and OCR may misread names and numbers.` });
    if (!source.published_at) unc.push({ code: "auto_date", text: "The original publication date of the content could not be established from the source." });
    for (const v of (media?.videos || []).filter(v => !v.error)) {
      if (!v.internet_search) unc.push({ code: "auto_video_search", text: `Video ${v.video.name}: internet-wide reverse search of its keyframes was not completed (${(v.unavailable || []).map(u => `${u.provider}: ${u.reason}`).join("; ") || "provider errors"}); only local similarity analysis was done.` });
      if (v.possible) unc.push({ code: "auto_video_possible", text: `Video ${v.video.name}: ${v.possible} possible similarit${v.possible === 1 ? "y" : "ies"} with earlier footage could not be confirmed by AIVS's own comparison.` });
    }
    if (media?.reuse?.length) unc.push({ code: "auto_media", text: `${plural(media.reuse.length, "image reuse indicator")} suggest an attached image may be older than the claim; see the image findings.` });
    if (otherClaims.length) unc.push({ code: "auto_other", text: `${plural(otherClaims.length, "further statement")} in the content ${otherClaims.length === 1 ? "was" : "were"} recorded but not assessed (at most two principal claims are assessed).` });
    if (aiState && !aiState.ok) unc.push({ code: "auto_ai", text: `The organisation's AI model was not available (${cut(aiState.reason, 120)}); the assessment was written by the fixed AIVS rules.` });
    const uncertainties = unc.length ? unc.map(u => `- ${u.text}`).join("\n") : "None identified beyond the evidence limitations stated in the reasoning.";

    const nAcc = accepted.length, indep = new Set(accepted.map(e => e.domain)).size;
    const parts = claims.map((cl, i) => `claim ${cl.seq} is ${VERDICTS[TO_CASE[finals[i].verdict]].toLowerCase()} (${{ strong: "strong evidence", moderate: "moderate evidence", weak: "weak evidence", none: "no accepted evidence" }[finals[i].strength] || "no accepted evidence"})`);
    const combine = { supported: "every principal claim is supported by accepted independent evidence", contradicted: "accepted evidence contradicts at least one principal claim and none is supported", insufficient: "the accepted evidence does not settle the principal claim(s) either way", not_verifiable: "the principal statements are not factual claims that evidence can settle", mixed: "the principal claims point in different directions, so no single finding covers the submission" }[conclusion] || "";
    const reasoning = [`Determined automatically from ${plural(claims.length, "principal claim")}: ${parts.join("; ")}.`, combine ? `Overall, ${combine}.` : "", ov.note || "",
      `Evidence base: ${plural(nAcc, "accepted item")} from ${plural(indep, "independent source")}${failedSearch.length ? `; ${plural(failedSearch.length, "evidence source")} failed` : ""}.`,
      `Confidence: ${confidence}${confidence === "Low" ? " (the evidence is limited or absent)" : ""}.`].filter(Boolean).join(" ");

    const now = nowISO();
    cases.change(user, caseId, `Completed automatically by the AIVS investigation pipeline: ${plural(claims.length, "principal claim")}, ${plural(nAcc, "evidence item")} accepted, conclusion “${CONCLUSION_LABELS[conclusion] || "—"}”`, () => {
      // claims: principal ones assessed; the others recorded but not prioritised (kept, not deleted)
      for (const cl of otherClaims) db.prepare("UPDATE claims SET removed = 1, rationale = ? WHERE id = ? AND removed = 0").run("Recorded but not prioritised: AIVS assesses at most two principal claims per investigation.", cl.id);
      claims.forEach((cl, i) => db.prepare("UPDATE claims SET assessment = ?, rationale = ?, assessed_by = ?, assessed_at = ?, assessed_auto = 1 WHERE id = ?").run(TO_CASE[finals[i].verdict], rationale[i], user.id, now, cl.id));
      // evidence: every retrieved suggestion decided by the rules, with the rule results kept on the item
      const byId = new Map(compared.map(e => [e.id, e]));
      for (const ev of db.prepare("SELECT id, claim_id FROM evidence WHERE case_id = ? AND status = 'suggested'").all(caseId)) {
        const e = byId.get(ev.id), v = e ? checks.get(e.id) : { ok: false, failed: [principalIds.has(ev.claim_id) ? "relevant" : "principal"], notes: ["not compared with the claim"], stance: null };
        db.prepare("UPDATE evidence SET status = ?, decided_by = ?, decided_at = ?, validation = ? WHERE id = ?").run(v.ok ? "accepted" : "dismissed", user.id, now,
          JSON.stringify({ by: "AIVS rules", at: now, accepted: v.ok, stance: v.ok ? v.stance : null, failed: v.failed, notes: v.notes, relevance: e?.relevance ?? null, tier: e?.tier || null, duplicate_of: e?.repeat_of || null }), ev.id);
        db.prepare("DELETE FROM evidence_links WHERE evidence_id = ?").run(ev.id);
        if (v.ok) db.prepare("INSERT INTO evidence_links(evidence_id,claim_id,stance) VALUES (?,?,?)").run(ev.id, e.claim_id, v.stance);
      }
      db.prepare("UPDATE cases SET conclusion = ?, conclusion_rationale = ?, uncertainties = ?, confidence = ?, auto_completed_at = ? WHERE id = ?").run(conclusion, reasoning.slice(0, 3900), uncertainties.slice(0, 3900), confidence, now, caseId);
      // the uncertainties also appear in evidence coverage, as open items the rules recorded
      const have = new Set(db.prepare("SELECT text FROM case_gaps WHERE case_id = ?").all(caseId).map(g => g.text));
      for (const u of unc) if (!have.has(u.text)) db.prepare("INSERT INTO case_gaps(case_id,claim_id,kind,text,status,origin,sources,rule_code,created_by,created_at) VALUES (?,?,'missing',?,'open','rules',?,?,?,?)")
        .run(caseId, u.claim_id || null, u.text.slice(0, 500), JSON.stringify([u.claim_id || caseId]), u.code, user.id, now);
    }, { automatic: true, accepted: nAcc, dismissed: compared.length - nAcc, conclusion, confidence, corrected: finals.filter(f => f.corrected_from).length });
    return { finals, overall: ov, conclusion, conclusion_label: CONCLUSION_LABELS[conclusion], reasoning, uncertainties: unc.map(u => u.text), confidence, accepted: nAcc, independent: indep,
      checks: Object.fromEntries([...checks].map(([k, v]) => [k, v])), corrected: finals.map((f, i) => f.corrected_from ? { seq: claims[i].seq, from: f.corrected_from, to: f.verdict } : null).filter(Boolean), rules: ACCEPT_RULES };
  }
  // the AI's interpretation, appended to a rationale or the reasoning after it passed the checks (see investigate.js)
  function addInterpretation(user, caseId, { claims = {}, conclusion = null, model }) {
    cases.change(user, caseId, `AI interpretation added (${model}, checked)`, () => {
      for (const [id, t] of Object.entries(claims)) db.prepare("UPDATE claims SET rationale = substr(rationale || ' AI interpretation (' || ? || ', checked; not evidence): ' || ?, 1, 4000) WHERE id = ? AND case_id = ?").run(model, t, id, caseId);
      if (conclusion) db.prepare("UPDATE cases SET conclusion_rationale = substr(conclusion_rationale || ' AI interpretation (' || ? || ', checked; not evidence): ' || ?, 1, 4000) WHERE id = ?").run(model, conclusion, caseId);
    });
  }
  return { complete, addInterpretation, ACCEPT_RULES };
}

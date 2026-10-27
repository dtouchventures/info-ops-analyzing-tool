// Verdict categories, the overall conclusion that follows from claim verdicts, evidence strength, and the
// mapping of published fact-check ratings to suggested verdicts. Shared by the server and the browser.
// Nothing here decides a case: it computes what the analyst's own choices imply, and labels suggestions.

export const VERDICTS = {
  supported: "Supported",
  contradicted: "Contradicted",
  partially_supported: "Partially supported",
  misleading_context: "Misleading context",
  insufficient: "Insufficient evidence",
  not_verifiable: "Not verifiable"
};
export const CONCLUSION_LABELS = { ...VERDICTS, mixed: "Mixed findings" };
export const VERDICT_HELP = {
  supported: "Independent, accepted evidence supports the claim as stated.",
  contradicted: "Accepted evidence shows the claim is false as stated.",
  partially_supported: "Part of the claim is supported; another part is not, or it overstates what the evidence shows.",
  misleading_context: "Genuine material presented with a false or missing context: wrong date, place, event or meaning.",
  insufficient: "The available evidence is not enough to decide either way.",
  not_verifiable: "Not a factual claim that evidence can settle: opinion, prediction, satire or question."
};

// The overall conclusion implied by the claim verdicts. Claims that are not verifiable do not decide the
// outcome unless every claim is not verifiable. Returns null while any claim is unassessed.
export function expectedConclusion(claims) {
  const a = claims.filter(c => !c.removed).map(c => c.assessment);
  if (!a.length || a.includes("unassessed")) return null;
  const d = a.filter(x => x !== "not_verifiable");
  if (!d.length) return "not_verifiable";
  const has = k => d.includes(k);
  const positive = has("supported") || has("partially_supported");
  if (has("contradicted") && positive) return "mixed";
  if (has("contradicted")) return "contradicted";
  if (has("misleading_context")) return "misleading_context";
  if (d.every(x => x === "supported")) return "supported";
  if (d.every(x => x === "insufficient")) return "insufficient";
  return "partially_supported";                       // supported/partial mixed with insufficient
}

// What each verdict needs before a case can be submitted.
export function verdictNeeds(assessment, stances) {
  if (assessment === "supported" && !stances.includes("supports")) return "is marked supported but no accepted evidence supports it";
  if (assessment === "contradicted" && !stances.includes("contradicts")) return "is marked contradicted but no accepted evidence contradicts it";
  if (assessment === "partially_supported" && !stances.includes("supports")) return "is marked partially supported but no accepted evidence supports any part of it";
  if (assessment === "misleading_context" && !stances.some(s => s === "contradicts" || s === "context")) return "is marked misleading context but no accepted evidence shows the true context (link it as context or contradicts)";
  return null;
}

// Evidence strength for one claim: how much accepted, independent evidence bears on it.
// Not a probability that the claim is true. Inputs: the claim and the case's evidence with links.
const WEIGHT = { observation: 2, source_claim: 2, inference: 0.5, lead: 0.5 };
function sourceKey(e) {
  const u = e.source_url || (String(e.reference || "").match(/https?:\/\/[^\s]+/) || [])[0];
  if (u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch {} }
  return String(e.source_publisher || e.reference || e.id).toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 3).join(" ");
}
export function evidenceStrength(claim, evidence) {
  const linked = evidence.filter(e => e.status === "accepted").map(e => ({ e, s: (e.links || []).find(l => l.claim_id === claim.id)?.stance })).filter(x => x.s);
  if (!linked.length) return { level: "none", score: 0, reasons: ["No accepted evidence is linked to this claim."], independent: 0 };
  const sources = new Map();
  for (const { e, s } of linked) { const k = sourceKey(e), w = WEIGHT[e.kind] ?? 1, cur = sources.get(k); if (!cur || w > cur.w) sources.set(k, { w, s, kind: e.kind }); }
  const sup = linked.filter(x => x.s === "supports").length, con = linked.filter(x => x.s === "contradicts").length, ctx = linked.filter(x => x.s === "context").length;
  const independent = sources.size, score = [...sources.values()].reduce((a, b) => a + b.w, 0), direct = [...sources.values()].filter(x => x.w >= 2).length;
  const reasons = [`${linked.length} accepted item${linked.length > 1 ? "s" : ""} from ${independent} independent source${independent > 1 ? "s" : ""}`];
  if (direct) reasons.push(`${direct} source${direct > 1 ? "s give" : " gives"} direct observation or a source statement`); else reasons.push("only inferences or leads, no direct observation or source statement");
  if (sup && con) reasons.push(`evidence conflicts: ${sup} supporting, ${con} contradicting`);
  if (ctx && !sup && !con) reasons.push("evidence gives context only");
  let level = score >= 5 && direct >= 2 ? "strong" : score >= 2.5 && direct >= 1 ? "moderate" : "weak";
  if (sup && con && level === "strong") level = "moderate";
  return { level, score, reasons, independent };
}
export const STRENGTH_LABELS = { none: "No evidence", weak: "Weak", moderate: "Moderate", strong: "Strong" };

// Published fact-check ratings ("textualRating") are free text in many languages. Map the common ones to a
// suggested verdict; anything unrecognised returns null and is shown as the publisher's own wording.
const RATING_RULES = [
  [/\b(satire|parody|opinion|unverifiable|not a claim|cannot be verified|haiwezi kuthibitishwa)\b/i, "not_verifiable"],
  [/\b(missing context|out of context|misleading|misattributed|manipulated|altered|doctored|old (photo|video|image)|recycled|exaggerat|potovu|inapotosha|nje ya muktadha)\w*/i, "misleading_context"],
  [/\b(half[- ]true|partly[- ](true|false)|partially[- ](true|false|correct|supported)|mixture|mixed|mostly[- ](true|correct|accurate)|needs context|nusu kweli)\b/i, "partially_supported"],
  [/\b(not enough info(rmation)?|unproven|unsupported|no evidence|insufficient( evidence)?|research in progress|hakuna ushahidi)\b/i, "insufficient"],
  [/\b(not (true|correct|accurate|kweli)|mostly false|barely[- ]true|false|fake|incorrect|wrong|untrue|baseless|fabricated|hoax|scam|pants[- ]on[- ]fire|pants[- ]fire|debunked|refutes?|refuted|contradicted|uongo|si kweli|feki|bandia|ulaghai)\b/i, "contradicted"],
  [/\b(true|correct|accurate|verified|confirmed|supports?|supported|kweli|sahihi)\b/i, "supported"]
];
export function ratingToVerdict(rating) {
  const r = String(rating || "").trim(); if (!r) return null;
  for (const [re, v] of RATING_RULES) if (re.test(r)) return v;
  return null;
}

// Content analysis of one case's material (AIVS 1.20): a single view that keeps four kinds of statement apart:
//   recorded  – what the source itself shows (platform, account, time, link, archived copy). Not proof the content is true.
//   claim     – statements in the content; unverified until an analyst assesses them with evidence.
//   estimate  – automatic predictions (sentiment, topics, names, red flags, similar posts) with their method and limits.
//   missing   – evidence or data that is not available, and why.
// Everything is computed from the case's stored records with the same rule-based methods as the rest of AIVS.
// Nothing is decided here: no verdict, no truth score, and no finding of coordination.
import { extractEntities, extractHashtags, redFlags, TOPICS } from "../../shared/text.js";
import { classifySentiment, SENTIMENT_LABELS, themesOf, THEMES } from "./social-analysis.js";
import { VERDICTS } from "../../shared/verdict.js";

const TITLES = "President|Deputy President|Cabinet Secretary|CS|PS|Principal Secretary|General|Gen\\.|Maj\\.|Major|Col\\.|Colonel|Lt\\.|Lieutenant|Capt\\.|Captain|Brig\\.|Brigadier|Hon\\.|Senator|Sen\\.|Governor|MP|MCA|Commissioner|Inspector General|Mr\\.?|Mrs\\.?|Ms\\.?|Dr\\.?|Prof\\.?|Rais|Naibu Rais|Waziri|Gavana|Seneta|Mbunge|Mheshimiwa|Bw\\.|Bi\\.";
const PERSON_RE = new RegExp(`\\b(${TITLES})\\s+((?:[A-Z][a-z'’-]+)(?:\\s+[A-Z][a-z'’-]+){0,2})`, "g");
export function peopleIn(text) {
  const out = new Map(); let m; PERSON_RE.lastIndex = 0;
  while ((m = PERSON_RE.exec(String(text || "")))) { const name = `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim(); if (!/^(Mr|Mrs|Ms|Dr|Prof)\.? (The|This|That)$/.test(name)) out.set(name, (out.get(name) || 0) + 1); }
  return [...out.keys()].slice(0, 30);
}

const SAME_TOPIC = { disaster: "disaster", health: "health", election: "politics", finance_scam: "scams" };   // red-flag topics already covered by a theme

export function analyseContent({ agg, extraction = null, io = null, matches = [], evidenceServices = [], ai = { ready: false } }) {
  const c = agg.case, text = String(c.claim_text || ""), claims = (agg.claims || []).filter(x => !x.removed), ev = agg.evidence || [];
  const recorded = [
    { label: "Platform or site", value: c.source_platform || null },
    { label: "Account", value: c.source_account || null },
    { label: "Link", value: c.source_url || null, link: c.source_url || null },
    { label: "Posted", value: c.published_at || null, basis: c.published_basis || null },
    { label: "Archived copy of the source", value: c.source_snapshot_sha256 ? `SHA-256 ${c.source_snapshot_sha256.slice(0, 16)}… retrieved ${c.source_fetched_at || ""}`.trim() : null },
    { label: "Where the words came from", value: extraction?.text_basis || null, basis: extraction?.text_status === "partial" ? "the platform may have shortened the text" : extraction?.text_status === "title" ? "only the title was available" : null }
  ].filter(r => r.value);
  const assessedLabel = a => !a || a === "unassessed" ? "Not yet assessed: unverified" : `${VERDICTS[a] || a} (analyst's assessment)`;
  const claimRows = claims.map(cl => ({ id: cl.id, text: cl.text, kind: cl.kind, claim_type: cl.claim_type || null, status: cl.assessment || "unassessed", status_label: assessedLabel(cl.assessment),
    accepted_evidence: ev.filter(e => e.status === "accepted" && (e.claim_id === cl.id || (e.links || []).some(l => l.claim_id === cl.id))).length }));

  const s = classifySentiment(text), themes = themesOf(text), flags = redFlags(text), ent = extractEntities(text);
  const estimates = {
    sentiment: { label: SENTIMENT_LABELS[s.label] || s.label, score: s.score, confidence: s.confidence, basis: s.basis, method: s.method === "lexicon-1" ? "word list in English and Kiswahili (lexicon-1)" : `classifier trained on 45,615 labelled English tweets (${s.method}; measured accuracy on held-out tweets: see Settings → AI models)`,
      limits: "Misses sarcasm, slang and context. Tone is not truth: a negative post is not misinformation, and criticism is not a threat." },
    topics: { items: [...themes.map(k => THEMES[k][0]), ...[...new Set(flags.map(f => f.topic).filter(t => t && !themes.includes(SAME_TOPIC[t])))].map(t => TOPICS[t])].filter((v, i, a) => v && a.indexOf(v) === i), method: "keyword rules (English and Kiswahili)", limits: "A topic is suggested when a keyword appears; the post may only mention it." },
    entities: { people: peopleIn(text), places: ent.locations, organisations: ent.orgs, dates: ent.dates.map(d => d.text), numbers: ent.numbers, hashtags: extractHashtags(text), handles: [...new Set(text.match(/(^|[^\w@])@\w{2,30}/g) || [])].map(h => h.trim().replace(/^[^@]+/, "")).slice(0, 20),
      method: "names after titles (President, CS, Gen., Mr…), and AIVS's lists of Kenyan places and institutions", limits: "Names without a title, and places or bodies not on the lists, are missed. Check each name before relying on it." },
    red_flags: { items: flags.map(f => ({ cue: f.cue, why: f.text, check: f.check })), method: "patterns fact-checkers in the region often see", limits: "A red flag is a reason to check, never a finding." },
    similar: {
      datasets_searched: io?.datasets_searched ?? 0, account_posts: io?.account_posts ?? 0, similar_posts: (io?.similar || []).length, similar_accounts: io?.similar_accounts ?? 0, examples: (io?.similar || []).slice(0, 5).map(x => ({ account: x.account, posted_at: x.posted_at, similarity: x.similarity, dataset: x.dataset })),
      earlier_cases: matches.filter(m => m.target_case_id).length, archive_matches: matches.filter(m => m.target_archive_id).length,
      method: "near-identical wording in imported post datasets (word pairs, 60% or more shared) and image/text matches with earlier cases and the reference archive",
      limits: "Identical wording from several accounts can be copying, quoting or a shared news source. It is a lead for the analyst, never proof of coordination." }
  };
  const missing = [];
  if (!extraction?.text_status && /^https?:/.test(c.source_url || "") && !c.source_snapshot_sha256) missing.push("No archived copy of the source: it was not retrieved automatically.");
  if (extraction?.text_status === "partial") missing.push("The words of the post may be incomplete: the platform may have shortened them. Compare with the post or a screenshot.");
  if (extraction?.text_status === "title") missing.push("Only the video's title was available; what is said in it has not been checked. Add a permitted copy of the video to transcribe it.");
  if (/YouTube|TikTok/.test(c.source_platform || "") && !(agg.media || []).some(m => /video|audio/.test(m.kind))) missing.push("What is said in the video is not included: platforms do not provide it. Add a permitted copy of the video to the case to transcribe it.");
  if (!c.published_at) missing.push("The posting time is not known.");
  const unconfigured = evidenceServices.filter(x => x.sends_to && !x.configured).map(x => x.label);
  if (unconfigured.length) missing.push(`Not searched (not configured on this server): ${unconfigured.join(", ")}.`);
  if (!ev.some(e => e.status === "accepted")) missing.push("No evidence has been accepted yet.");
  if (!estimates.similar.datasets_searched) missing.push("No post datasets are imported, so similar posts by other accounts could not be looked for.");
  const unassessed = claimRows.filter(x => x.status === "unassessed").length;
  return {
    case_id: c.id, recorded, claims: claimRows, estimates, missing,
    summary: { claims: claimRows.length, unassessed, accepted_evidence: ev.filter(e => e.status === "accepted").length, suggested_evidence: ev.filter(e => e.status === "suggested").length },
    ai: { ready: !!ai.ready, note: ai.ready ? "The AI assistant (More tools) can explain these results in plain words. It cites the case's records; its answers are suggestions, never findings." : "No AI service is connected. All results above come from rules that work without AI." },
    legend: { recorded: "What the source itself shows. It is not proof that the content is true.", claim: "Statements in the content. Unverified until an analyst assesses them with evidence.", estimate: "Automatic predictions, with their method and limits. Not findings.", missing: "Evidence or data that is not available, and why." }
  };
}

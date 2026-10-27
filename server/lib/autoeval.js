// Automatic evidence comparison and assessment for one-click investigations (AIVS 1.22).
// Pure functions: no database, no network. Everything here is a fixed, explainable rule:
//   relevance   TF-IDF cosine over words and character trigrams (English and Kiswahili, no model download)
//   source      category of the source (official, fact-checker, news, reference, other, social)
//   independence near-identical wording or the same organisation counts as one source
//   stance      published rating -> AI reading with a verified quote -> conservative wording rules
//   verdict     per claim and overall, from the compared evidence; never from the AI model
// No percentages are produced: strength is a qualitative label with its reason.
import { ratingToVerdict, activeVerdict } from "../../shared/verdict.js";
import { OFFICIAL_SOURCES } from "./retrieval.js";

export const AUTO_VERDICTS = { extraction_blocked: "Extraction blocked", insufficient_content: "Insufficient content", supported: "Supported", contradicted: "Contradicted", misleading: "Misleading or missing context", insufficient: "Insufficient evidence", not_verifiable: "Unverifiable",
  mixed: "Insufficient evidence (sources disagree)" };   // "mixed" is kept only to read reports saved by 1.23
export const STRENGTH = { strong: "Strong", moderate: "Moderate", weak: "Weak", none: "None found" };

// ---------------------------------------------------------------- text similarity
const STOP = new Set(`a an the and or but of to in on at for from by with as is are was were be been being it its this that these those there here which who whom whose
what when where why how not no yes than then so such very can could would should will shall may might must has have had do does did done also just only into over after
before about said says say their they them he she his her we our you your i me my up out new more most other some any all each per via
na ya wa kwa za la ni katika kuwa hii huo hiyo hizo hili hilo leo pia lakini kama hata wao sisi yeye hapa pale baada kabla kutoka hadi bila kuna ndiyo hapana sana tu au`.split(/\s+/));
export const words = s => String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
const grams = s => { const t = ` ${String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `, out = []; for (let i = 0; i < t.length - 2; i++) out.push(t.slice(i, i + 3)); return out; };

function tfidfCos(query, docs, tok) {
  const all = [query, ...docs].map(tok), df = new Map();
  for (const d of all) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const N = all.length, vec = d => { const tf = new Map(); for (const t of d) tf.set(t, (tf.get(t) || 0) + 1); const v = new Map(); let n = 0;
    for (const [t, c] of tf) { const w = (1 + Math.log(c)) * (Math.log((1 + N) / (1 + df.get(t))) + 1); v.set(t, w); n += w * w; } return { v, n: Math.sqrt(n) || 1 }; };
  const vs = all.map(vec), q = vs[0];
  return vs.slice(1).map(d => { let dot = 0; for (const [t, w] of q.v) { const x = d.v.get(t); if (x) dot += w * x; } return dot / (q.n * d.n); });
}
export function similarities(query, docs) {
  if (!docs.length) return [];
  const w = tfidfCos(query, docs, words), c = tfidfCos(query, docs, grams);
  return w.map((x, i) => Math.round((0.6 * x + 0.4 * c[i]) * 1000) / 1000);
}
const jaccard = (a, b) => { const A = new Set(grams(a)), B = new Set(grams(b)); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); };

// ---------------------------------------------------------------- source categories
const FACT_CHECKERS = { "africacheck.org": "Africa Check", "pesacheck.org": "PesaCheck", "factcheck.afp.com": "AFP Fact Check", "fullfact.org": "Full Fact", "politifact.com": "PolitiFact",
  "snopes.com": "Snopes", "factcheck.org": "FactCheck.org", "dubawa.org": "Dubawa", "leadstories.com": "Lead Stories", "logicallyfacts.com": "Logically Facts", "boomlive.in": "BOOM" };
const NEWS = { "nation.africa": "Nation (Kenya)", "standardmedia.co.ke": "The Standard (Kenya)", "the-star.co.ke": "The Star (Kenya)", "citizen.digital": "Citizen Digital", "kbc.co.ke": "KBC",
  "capitalfm.co.ke": "Capital FM", "pd.co.ke": "People Daily", "kenyanews.go.ke": "Kenya News Agency", "theeastafrican.co.ke": "The EastAfrican", "businessdailyafrica.com": "Business Daily",
  "tuko.co.ke": "Tuko", "kenyans.co.ke": "Kenyans.co.ke", "bbc.com": "BBC", "bbc.co.uk": "BBC", "aljazeera.com": "Al Jazeera", "reuters.com": "Reuters", "apnews.com": "AP News", "afp.com": "AFP",
  "france24.com": "France 24", "dw.com": "DW", "voanews.com": "VOA", "theguardian.com": "The Guardian", "monitor.co.ug": "Daily Monitor (Uganda)", "thecitizen.co.tz": "The Citizen (Tanzania)" };
const INTERNATIONAL = ["who.int", "un.org", "unicef.org", "unhcr.org", "wfp.org", "worldbank.org", "imf.org", "au.int", "igad.int", "eac.int", "icrc.org", "reliefweb.int"];
const SOCIAL = ["facebook.com", "x.com", "twitter.com", "instagram.com", "tiktok.com", "youtube.com", "t.me", "reddit.com", "threads.net", "linkedin.com", "whatsapp.com"];
export const TIERS = { official: [1.0, "Official or intergovernmental source"], fact_checker: [0.95, "Established fact-checking organisation"], news: [0.75, "Established news organisation"],
  knowledge_base: [0.9, "AIVS knowledge base (approved dataset)"], earlier_case: [0.6, "Earlier AIVS investigation"], reference: [0.45, "Reference work (tertiary source)"],
  unknown: [0.35, "Other website (reliability not assessed)"], social: [0.15, "Social media (user-generated)"] };
export const hostOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/^(www|m|mobile|amp)\./, ""); } catch { return ""; } };
export function registrable(h) { const p = String(h || "").split("."); return p.length >= 3 && ["co", "go", "or", "ac", "gov", "com", "org", "ne"].includes(p[p.length - 2]) && p[p.length - 1].length === 2 ? p.slice(-3).join(".") : p.slice(-2).join("."); }
const under = (h, d) => h === d || h.endsWith("." + d);
export function classify(e) {
  if (e.connector === "kb") return ["knowledge_base", e.source_publisher || null];
  if (e.connector === "holdings") return ["earlier_case", null];
  const url = String(e.source_url || ""), h = hostOf(url);
  if (/reuters\.com\/fact-check/.test(url)) return ["fact_checker", "Reuters Fact Check"];
  for (const [d, n] of Object.entries(FACT_CHECKERS)) if (under(h, d)) return ["fact_checker", n];
  const off = OFFICIAL_SOURCES.find(([d]) => under(h, d) && !FACT_CHECKERS[d]);
  if (off || (h.endsWith(".go.ke") && h !== "kenyanews.go.ke") || /\.gov(\.[a-z]{2})?$/.test(h) || h.endsWith(".mil") || INTERNATIONAL.some(d => under(h, d))) return ["official", off?.[1] || null];
  for (const [d, n] of Object.entries(NEWS)) if (under(h, d)) return ["news", n];
  if (h.endsWith("wikipedia.org")) return ["reference", "Wikipedia"];
  if (SOCIAL.some(d => under(h, d))) return ["social", null];
  return ["unknown", null];
}

// ---------------------------------------------------------------- stance
const REFUTE = /\b(false|fake|hoax|debunk\w*|fabricat\w*|misleading|doctored|manipulated|not true|untrue|no evidence|baseless|denie[sd]|deny|refute\w*|dismiss\w*|uongo|si kweli|feki|amekanusha|wamekanusha|imekanusha|ghushi)\b/i;
const CONFIRM = /\b(confirm\w*|announced|official statement|said in a statement|according to (the )?(ministry|government|police|kdf)|amethibitisha|imethibitisha|wamethibitisha|tangazo rasmi)\b/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|januari|februari|machi|aprili|mei|juni|julai|agosti|septemba|oktoba|novemba|desemba)[a-z]*";
const DATES = new RegExp(`\\b\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?|\\b${MONTH}\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\b(?:19|20)\\d{2}\\b|\\b\\d{1,2}[:.]\\d{2}\\b`, "gi");
// figures stated in the text (counts, amounts), not the numbers inside dates and times
export const figures = t => new Set((String(t || "").replace(DATES, " ").match(/\b\d[\d,]*(?:\.\d+)?\b/g) || []).map(n => n.replace(/,/g, "")));

// the source negates the claim's own action ("5G networks spread the virus" / "5G networks do not spread the virus");
// absence of confirmation ("did not confirm", "could not verify") is not treated as a denial
const NEG = /\b(?:(?:do|does|did|can|could|will|would|is|are|was|were|has|have)\s+not|(?:do|does|did|ca|could|wo|would|is|are|was|were|has|have)n[’']t|cannot|never)\s+((?:\p{L}+\s+){0,2}?)(\p{L}{3,})/giu;
const ABSENCE = /^(confirm|verify|verif|comment|respond|say|said|know|disclose|reveal|identify|specify)/i;
export function negates(claimText, body) {
  const cw = String(claimText || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3 && !/^(that|this|with|from|have|been|they|their|there|will|would)$/.test(w)).map(w => w.slice(0, 5));
  if (/\b(not|never|no)\b|n't/i.test(claimText)) return null; // a negative claim needs a person to compare
  for (const m of String(body || "").matchAll(NEG)) { const w = m[2].toLowerCase(); if (!ABSENCE.test(w) && cw.includes(w.slice(0, 5))) return m[0].trim(); }
  return null;
}
export function ruleStance(claim, e) {
  if (e.rating) {
    const raw = ratingToVerdict(e.rating), v = activeVerdict(raw);
    // a rating settles the claim only when the fact-check is about this claim: close enough wording, and the claim is not
    // itself a warning or denial of the rated claim (a "False" rating then agrees with the post rather than refuting it)
    if ((e.relevance ?? 1) < 0.12) return ["related", "none", `a fact-check rated a different wording (“${e.rating}”); its claim is not close enough to this one to apply the rating`];
    const warns = String(claim.text || "").match(/\b(beware|fake|false|hoax|scam|not true|untrue|is free|free of charge|do not pay|don't pay|uongo|feki|si kweli|tahadhari)\b/i);
    if (warns && ["contradicted", "misleading_context"].includes(raw === "misleading_context" ? raw : v)) return ["related", "none", `the post itself warns about or denies the rated claim (“${warns[0]}”), so the “${e.rating}” rating may agree with it; read the fact-check`];
    if (raw === "misleading_context") return ["misleading", "strong", `published rating “${e.rating}” (misleading or missing context)`];
    if (v === "contradicted") return ["contradicts", "strong", `published rating “${e.rating}”`];
    if (v === "supported") return ["supports", "strong", `published rating “${e.rating}”`];
    return ["related", "none", `the rating “${e.rating}” does not settle the claim; read the source`];
  }
  if (e.connector === "holdings") return ["related", "none", "an earlier investigation of a similar claim (see its conclusion)"];
  const body = `${e.source_title || ""} ${e.snippet || ""}`, rel = e.relevance || 0;
  if (rel < 0.18) return ["related", "none", "mentions similar topics only"];
  const ref = body.match(REFUTE);
  if (ref && rel >= 0.22) return ["contradicts", "moderate", `the source uses refuting words (“${ref[0]}”) about the same subject`];
  const neg = negates(claim.text, body);
  if (neg && rel >= 0.3) return ["contradicts", "weak", `the source states the opposite (“${neg}”)`];
  const fc = figures(claim.text), fe = figures(body), names = claim.names || [];
  const namesOk = names.length ? names.filter(n => body.toLowerCase().includes(n.toLowerCase())).length / names.length >= 0.5 : false;
  const figsOk = [...fc].every(n => fe.has(n));
  if (rel >= 0.35 && namesOk && figsOk) return ["supports", CONFIRM.test(body) ? "moderate" : "weak", `close wording with the same names${fc.size ? " and figures" : ""}${CONFIRM.test(body) ? " and confirming language" : ""}`];
  if (fc.size && fe.size && !figsOk && rel >= 0.3 && namesOk) return ["related", "none", "reports the same subject with different figures (check the figures)"];
  return ["related", "none", "same subject, but the source neither confirms nor refutes the claim"];
}
export const quoteOk = (quote, e) => { const n = s => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); const q = n(quote); return q.length >= 12 && n(`${e.source_title || ""} ${e.snippet || ""}`).includes(q); };

// ---------------------------------------------------------------- comparison and ranking
export function compare(claims, evidence, { claimDate = null, aiStances = {} } = {}) {
  const out = [];
  for (const cl of claims) {
    const mine = evidence.filter(e => e.claim_id === cl.id).map(e => ({ ...e }));
    const rel = similarities(cl.text, mine.map(e => `${e.source_title || ""}. ${e.snippet || ""}`));
    mine.forEach((e, i) => {
      e.relevance = rel[i];
      const [tier, outlet] = classify(e); e.tier = tier; e.tier_label = TIERS[tier][1];
      // a bare domain name is replaced by the organisation's name when AIVS knows it (e.g. health.go.ke -> Ministry of Health)
      e.publisher = outlet && (!e.source_publisher || /^[\w.-]+\.[a-z]{2,}$/i.test(e.source_publisher)) ? outlet : e.source_publisher || outlet || hostOf(e.source_url) || e.reference;
      e.domain = e.source_url ? registrable(hostOf(e.source_url)) : `${e.connector}:${e.id}`;
      const [stance, strength, basis] = ruleStance(cl, e);
      Object.assign(e, { stance, stance_strength: strength, stance_basis: basis, stance_method: e.rating ? "published rating" : "rules" });
      // The AI's reading is recorded beside the rule result but never replaces it (verdicts come only from the rules).
      // A reading whose quote is not really in the source is discarded; a reading that disagrees is flagged for a person.
      const a = aiStances[e.id];
      if (a && ["supports", "contradicts", "related"].includes(a.stance)) {
        if (quoteOk(a.quote, e)) { e.ai_stance = a.stance; e.ai_quote = String(a.quote).slice(0, 200); e.ai_disagrees = a.stance !== stance; }
        else e.ai_rejected = "the quoted words are not in the source";
      }
    });
    // independence: the most reliable, most relevant item of a group stands for it
    mine.sort((a, b) => (TIERS[b.tier][0] + b.relevance) - (TIERS[a.tier][0] + a.relevance));
    // Only items that say the same thing (same stance, no published rating of their own) are grouped, so a contradicting
    // source or a fact-check is never folded into a supporting one from the same site.
    mine.forEach((e, i) => {
      if (e.rating) return;
      for (let j = 0; j < i; j++) {
        const o = mine[j]; if (o.rating || o.stance !== e.stance) continue;
        const same = o.domain === e.domain, near = jaccard(`${o.source_title} ${o.snippet}`, `${e.source_title} ${e.snippet}`) >= 0.6;
        if (same || near) { e.repeat_of = o.repeat_of || o.id; e.repeat_reason = same ? "same organisation" : "near-identical wording (likely the same original report)"; break; }
      }
    });
    const cd = claimDate ? Date.parse(claimDate) : NaN;
    for (const e of mine) {
      const pd = e.source_published_at ? Date.parse(e.source_published_at) : NaN;
      if (isNaN(pd)) { e.date_score = 0.3; e.date_note = "publication date not known"; }
      else if (isNaN(cd)) { e.date_score = 0.6; e.date_note = null; }
      else { const d = Math.round((pd - cd) / 864e5); [e.date_score, e.date_note] = Math.abs(d) <= 14 ? [1, "published within two weeks of the claim"] : d < -14 ? [0.5, `published ${-d} days before the claim (possible earlier event or recycled story)`] : [0.7, `published ${d} days after the claim`]; }
      if (e.date_kind === "last edited" || e.connector === "reference") e.date_note = "the date is the article's last edit, not an event date";
      else if (e.connector === "news" && e.source_published_at) e.date_note = `${e.date_note ? e.date_note + "; " : ""}date is when the GDELT index first saw the article (close to, not the same as, publication)`;
      const s = { strong: 1, moderate: 0.6, weak: 0.3 }[e.stance_strength] || 0;
      e.score = Math.round((0.45 * e.relevance + 0.25 * TIERS[e.tier][0] + 0.15 * s + 0.1 * e.date_score + 0.05 * ((e.source_published_at ? 0.5 : 0) + (e.source_url ? 0.5 : 0)) - (e.repeat_of ? 0.12 : 0)) * 1000) / 1000;
    }
    mine.sort((a, b) => b.score - a.score);
    out.push(...mine);
  }
  return out;
}
// the best n items for a claim; contradicting items are always kept in view
export function topFor(compared, claimId, n = 5) {
  const mine = compared.filter(e => e.claim_id === claimId && (e.stance !== "related" || e.relevance >= 0.2));
  const best = mine.slice(0, n);
  for (const e of mine.slice(n)) if (e.stance === "contradicts" || e.stance === "misleading" || e.ai_disagrees) best.push(e);
  return best;
}

// ---------------------------------------------------------------- assessment
const TYPE_REASON = { opinion: "it is an opinion or value judgement", prediction: "it is a prediction about the future", question: "it is a question, not a statement",
  appeal: "it is a call to action (share, forward), not a statement", satire: "it is marked as satire", media: "it is about the attached media, which needs image checks (reverse search, metadata, archive matches) rather than a text search",
  timing: "it is about timing, judged from the dates of the main claims and their sources",
  location: "it restates the places named in the main claims, which are checked with them" };
const RELIABLE = new Set(["official", "fact_checker", "news", "knowledge_base"]);
export function assessClaim(cl, compared, searched) {
  const type = cl.kind !== "statement" && cl.kind !== "attribution" ? cl.kind : cl.claim_type || "factual";
  if (type !== "factual") return { verdict: "not_verifiable", strength: "none", reason: `Not checked as true or false because ${TYPE_REASON[type] || "it cannot be checked against evidence"}.`, supporting: [], contradicting: [] };
  const mine = compared.filter(e => e.claim_id === cl.id), ind = st => mine.filter(e => e.stance === st && !e.repeat_of);
  const sup = ind("supports"), con = ind("contradicts"), mis = mine.filter(e => e.stance === "misleading" && e.rating);
  const fcSup = sup.filter(e => e.rating && ["fact_checker", "knowledge_base"].includes(e.tier) || e.rating && e.connector === "factcheck"), fcCon = con.filter(e => e.rating && (["fact_checker", "knowledge_base"].includes(e.tier) || e.connector === "factcheck"));
  const relSup = sup.filter(e => RELIABLE.has(e.tier)), relCon = con.filter(e => RELIABLE.has(e.tier)), offSup = sup.filter(e => e.tier === "official" && e.stance_strength !== "weak");
  const ids = xs => xs.map(e => e.id), names = xs => [...new Set(xs.map(e => e.publisher))].join(", ");
  let verdict, strength, reason;
  if ((relSup.length || fcSup.length) && (relCon.length || fcCon.length)) {
    verdict = "insufficient"; strength = "weak"; reason = `Reliable sources disagree: ${relSup.length || fcSup.length} independent source(s) support the claim and ${relCon.length || fcCon.length} contradict it, so the evidence does not settle it.`;
    return { verdict, strength, reason, conflicting: true, supporting: ids(sup), contradicting: ids(con) };
  } else if (mis.length && !relSup.length) {
    verdict = "misleading"; strength = "strong"; reason = `A published fact-check rates it misleading or missing context (${names(mis)}): parts may be accurate, but the way it is presented is not.`;
    return { verdict, strength, reason, supporting: ids(sup), contradicting: ids([...con, ...mis]) };
  } else if (fcCon.length || relCon.length) {
    verdict = "contradicted"; strength = fcCon.length || relCon.length >= 2 ? "strong" : "moderate";
    reason = fcCon.length ? `A published fact-check rates it false or misleading (${names(fcCon)}).` : `${relCon.length} independent reliable source(s) contradict it (${names(relCon)}) and none support it.`;
  } else if (fcSup.length || relSup.length >= 2 || offSup.length) {
    verdict = "supported"; strength = fcSup.length || relSup.length >= 3 || (offSup.length && relSup.length >= 2) ? "strong" : "moderate";
    reason = fcSup.length ? `A published fact-check rates it true (${names(fcSup)}).` : offSup.length ? `An official source states the same thing (${names(offSup)})${relSup.length > 1 ? `, and ${relSup.length - 1} other independent source(s) agree` : ""}.`
      : `${relSup.length} independent reliable sources report the same thing (${names(relSup)}), and none contradict it.`;
  } else {
    verdict = "insufficient"; strength = sup.length || con.length ? "weak" : "none";
    reason = !searched ? "No outside evidence source could be searched (none is configured or none answered), so the claim could not be checked against outside evidence."
      : sup.length || con.length ? `Only weak or lower-reliability evidence was found (${mine.filter(e => e.stance === "supports").length} consistent, ${mine.filter(e => e.stance === "contradicts").length} contradicting item(s)); a fact-check, an official source or two independent reliable sources are needed.`
      : mine.length ? `${mine.length} related item(s) were found, but none confirms or refutes the claim.` : "No relevant evidence was found by the sources searched.";
  }
  return { verdict, strength, reason, supporting: ids(sup), contradicting: ids(con) };
}
// The first checkable claim is the main claim (claims are in the order of the submission). Contradictions in any claim
// always show in the overall result; otherwise the main claim's result is used, noting claims that were not established.
// how checkable a claim is: figures, dates, places and organisations make a claim the submission's main claim
export function checkability(text) {
  const t = String(text || ""), caps = (t.match(/\b[A-Z][\p{L}]{2,}/gu) || []).length;
  return figures(t).size * 1.2 + (new RegExp(DATES.source, "i").test(t) ? 1 : 0) + Math.min(3, caps) * 0.5 + Math.min(1, words(t).length / 12);
}
export function overall(results, claims = [], reuse = []) {
  results = results.map((r, i) => ({ ...r, _k: claims[i] ? checkability(claims[i].text) : -i }));
  const chk = results.filter(r => r.verdict !== "not_verifiable").sort((a, b) => b._k - a._k);
  const order = ["none", "weak", "moderate", "strong"];
  if (!chk.length) return { verdict: "not_verifiable", label: AUTO_VERDICTS.not_verifiable, strength: "none", strength_label: STRENGTH.none, note: null };
  const vs = chk.map(r => r.verdict);
  const conflict = vs.includes("supported") && vs.includes("contradicted");
  let v = conflict ? "insufficient" : vs.includes("contradicted") ? "contradicted" : vs.includes("misleading") ? "misleading" : chk[0].verdict;
  const basis = chk.filter(r => r.verdict === v); let strength = (basis.length ? basis : chk).map(r => r.strength).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  const others = chk.slice(1).filter(r => r.verdict === "insufficient").length;
  let note = conflict || chk.some(r => r.conflicting) ? "Sources disagree about at least one claim." : v === "supported" && others ? `The main claim is supported; ${others} other claim(s) in the submission could not be established.` : null;
  // an old image presented as new: the text may be accurate, but the presentation is misleading
  if (reuse.length && ["supported", "insufficient"].includes(v)) { v = "misleading"; strength = "moderate"; note = `${note ? note + " " : ""}An attached image appears to be an old image reused in a new context (${reuse.length} indicator(s)); see the image findings.`; }
  return { verdict: v, label: AUTO_VERDICTS[v], strength, strength_label: STRENGTH[strength], note };
}

// observed information-operations indicators; each one says what was seen, none proves coordination
export function ioIndicators({ flags = [], injection = [], compared = [], hashtags = [], ioContext = null }) {
  const out = flags.map(f => ({ kind: "content", indicator: f.text, cue: f.cue, check: f.check }));
  if (injection.length) out.push({ kind: "content", indicator: "The text contains instructions aimed at AI systems; they were ignored.", cue: injection.slice(0, 3).join("; "), check: "Treat the source as deliberately manipulative content." });
  const dom = new Set(compared.filter(e => /near-identical/.test(e.repeat_reason || "")).map(e => e.domain));
  if (dom.size >= 3) out.push({ kind: "repetition", indicator: `Near-identical wording appears on ${dom.size} different websites.`, cue: [...dom].slice(0, 6).join(", "), check: "Repeated wording often comes from one press release or wire story; find the original before reading it as coordination." });
  if (hashtags.length >= 4) out.push({ kind: "amplification", indicator: `The text uses ${hashtags.length} hashtags.`, cue: hashtags.slice(0, 6).join(" "), check: "Add them to an AI Watchlist to see whether many accounts push them at the same time." });
  if (ioContext?.account_posts) out.push({ kind: "dataset", indicator: `The account appears ${ioContext.account_posts} time(s) in imported post datasets.`, cue: ioContext.account, check: "Open Social Media Analysis to see its posting pattern." });
  if (ioContext?.similar?.length) out.push({ kind: "dataset", indicator: `Similar wording appears in ${ioContext.similar.length} imported post(s)${ioContext.similar_accounts ? ` from ${ioContext.similar_accounts} account(s)` : ""}.`, cue: "", check: "Check in Social Media Analysis whether these posts appeared at the same time (possible coordination)." });
  return { observed: out, assessment: out.length ? "Indicators were observed (listed above). They describe the content and how it appears; they are not, on their own, evidence of a coordinated information operation. Coordination needs account and timing data (AI Watchlist or Social Media Analysis)."
    : "No information operations indicators were observed in this submission." };
}

// ---------------------------------------------------------------- AI output checks
const PCT = /\d+(\.\d+)?\s*(%|percent|per cent)|\bprobabilit|\b\d+(\.\d+)?\s*(in|out of)\s*\d+\s*chance/i;
const TRUE_WORDS = /\b(is|are|was|were) (true|accurate|correct|genuine|authentic|verified|confirmed)\b|\bhas been (confirmed|verified)\b|\bis supported by the (available )?evidence\b/i;
const FALSE_WORDS = /\b(is|are|was|were) (false|fake|untrue|a hoax|fabricated|misleading|incorrect)\b|\bhas been (debunked|refuted)\b|\bis contradicted by\b/i;
export function checkSections(data, ids, verdict = null) {
  const out = { background: [], analysis: [], assessment: [], recommendations: [], removed: [] };
  if (!data || typeof data !== "object") return out;
  for (const k of ["background", "analysis", "assessment", "recommendations"]) {
    let v = data[k]; if (typeof v === "string") v = [v]; if (!Array.isArray(v)) continue;
    for (let s of v.slice(0, 8)) {
      s = String(s ?? "").replace(/\s+/g, " ").trim(); if (!s) continue;
      const cited = [...new Set(s.match(/\bE-?\d+\b/g) || [])].map(x => x.replace(/^E(?!-)/, "E-")), bad = cited.filter(c => !ids.has(c));
      if (bad.length) out.removed.push(`cites evidence that does not exist (${bad.join(", ")}): ${s.slice(0, 120)}`);
      else if (PCT.test(s)) out.removed.push(`gives a percentage or probability: ${s.slice(0, 120)}`);
      else if (/https?:\/\/|www\./i.test(s)) out.removed.push(`contains a link: ${s.slice(0, 120)}`);
      else if (verdict && verdict !== "supported" && TRUE_WORDS.test(s)) out.removed.push(`states the claim is true, but the rule-based assessment is ${AUTO_VERDICTS[verdict]}: ${s.slice(0, 120)}`);
      else if (verdict && verdict !== "contradicted" && FALSE_WORDS.test(s)) out.removed.push(`states the claim is false, but the rule-based assessment is ${AUTO_VERDICTS[verdict]}: ${s.slice(0, 120)}`);
      else if (/\b(I|we) (have )?(checked|verified|confirmed|reviewed|approved)\b|\b(analyst|reviewer) (has |have )?(checked|verified|approved)\b/i.test(s)) out.removed.push(`speaks as if a person checked or approved it: ${s.slice(0, 120)}`);
      else out[k].push(s.slice(0, 600));
    }
  }
  return out;
}

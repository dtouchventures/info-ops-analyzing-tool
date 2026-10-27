// Evidence coverage tab: per claim, the assessment and reasoning, accepted supporting and contradicting evidence,
// context and unreviewed suggestions (kept apart), missing information, open questions and next steps, with
// links to the exact place each piece of evidence comes from. What blocks submission is shown exactly as the
// approval rules report it (GET /api/cases/:id/readiness and this view use the same function on the server).
// Counts describe what is recorded; they never decide whether a claim is true.
import { api } from "../api.js";
import { $, $$, esc, toast, fail, modal, viewer, fmtDT } from "../ui.js";

const content = id => `/api/media/${id}/content`;
let LANG = (() => { try { return localStorage.getItem("aivs.coverage.lang") === "sw" ? "sw" : "en"; } catch { return "en"; } })();

// ---- labels (English / Kiswahili)
const W = {
  title: ["Evidence coverage", "Ushahidi kwa kila dai"],
  intro: ["For each claim: the assessment, the evidence accepted for and against it, what is still missing and what to check next. Counts show what has been recorded; they do not decide whether a claim is true.",
    "Kwa kila dai: tathmini, ushahidi uliokubaliwa unaoliunga mkono na unaolipinga, kinachokosekana na cha kuangalia baadaye. Idadi zinaonyesha kilichorekodiwa tu; haziamui kama dai ni kweli."],
  overview: ["Case overview", "Muhtasari wa kesi"], ready: ["Ready to submit for review", "Iko tayari kuwasilishwa kwa ukaguzi"],
  blocked: ["Submission is blocked", "Uwasilishaji umezuiwa"], blockedBy: ["These approval rules are not met yet:", "Masharti haya ya idhini bado hayajatimizwa:"],
  notSubmittable: ["Submission is possible only while the case is under investigation or returned for more evidence.", "Kesi inaweza kuwasilishwa tu ikiwa chini ya uchunguzi au imerudishwa kwa ushahidi zaidi."],
  needAttention: ["Claims that need attention", "Madai yanayohitaji kushughulikiwa"], allClear: ["No claim needs attention.", "Hakuna dai linalohitaji kushughulikiwa."],
  claim: ["Claim", "Dai"], assessment: ["Assessment", "Tathmini"], reasoning: ["Analyst’s reasoning", "Sababu za mchambuzi"], noReasoning: ["No reasoning written yet.", "Bado hakuna sababu zilizoandikwa."],
  by: ["by", "na"], editClaims: ["Edit on the Claims tab", "Hariri kwenye kichupo cha Madai"],
  supports: ["Accepted: supports", "Imekubaliwa: inaunga mkono"], contradicts: ["Accepted: contradicts", "Imekubaliwa: inapinga"], context: ["Context (accepted, neither for nor against)", "Muktadha (umekubaliwa, hauungi wala haupingi)"],
  none: ["None", "Hakuna"], unreviewed: ["Unreviewed suggestions: not evidence until accepted", "Mapendekezo ambayo hayajakaguliwa: si ushahidi hadi yakubaliwe"],
  reviewOn: ["Review on the Evidence tab", "Kagua kwenye kichupo cha Ushahidi"], proposed: ["proposed", "inapendekezwa"],
  strength: ["Recorded evidence", "Ushahidi uliorekodiwa"], notProb: ["a description of what is recorded, not a probability", "maelezo ya kilichorekodiwa, si uwezekano"],
  flagged: ["Flagged: the verdict is not backed by accepted evidence", "Imealamishwa: uamuzi hauna ushahidi uliokubaliwa"],
  gapsTitle: ["Missing information, questions and next steps", "Kinachokosekana, maswali na hatua zinazofuata"], noGaps: ["Nothing recorded yet.", "Bado hakuna kilichorekodiwa."],
  sugTitle: ["Suggestions (not recorded until you accept them)", "Mapendekezo (hayarekodiwi hadi uyakubali)"], noSug: ["No suggestions.", "Hakuna mapendekezo."],
  accept: ["Accept", "Kubali"], hide: ["Hide", "Ficha"], add: ["Add", "Ongeza"], addPh: ["What is missing, the question, or the next step", "Kinachokosekana, swali, au hatua inayofuata"],
  edit: ["Correct", "Sahihisha"], resolve: ["Resolve", "Tatua"], drop: ["Drop", "Ondoa"], reopen: ["Reopen", "Fungua tena"], history: ["History", "Historia"],
  missing: ["Missing information", "Kinachokosekana"], question: ["Open question", "Swali lisilojibiwa"], next_step: ["Next step", "Hatua inayofuata"],
  open: ["open", "wazi"], resolved: ["resolved", "imetatuliwa"], dropped: ["dropped", "imeondolewa"],
  oAnalyst: ["analyst", "mchambuzi"], oRules: ["accepted rule-based suggestion", "pendekezo la sheria lililokubaliwa"], oAi: ["accepted AI suggestion", "pendekezo la AI lililokubaliwa"],
  sRules: ["rule-based suggestion", "pendekezo la sheria"], sAi: ["AI suggestion", "pendekezo la AI"], basedOn: ["based on", "kwa msingi wa"],
  aiBtn: ["Suggest with AI (optional)", "Pendekeza kwa AI (hiari)"], aiOff: ["AI suggestions are not available", "Mapendekezo ya AI hayapatikani"],
  aiNote: ["AI suggestions use only this case’s records, must cite them, and are never recorded until you accept them.", "Mapendekezo ya AI yanatumia rekodi za kesi hii tu, lazima yazitaje, na hayarekodiwi hadi uyakubali."],
  aiFail: ["AI suggestions failed; the rule-based suggestions below still apply.", "Mapendekezo ya AI yameshindwa; mapendekezo ya sheria hapa chini bado yanafaa."],
  aiRemoved: ["Removed by AIVS checks", "Yaliyoondolewa na ukaguzi wa AIVS"], aiDone: ["AI suggestions added to the claims below.", "Mapendekezo ya AI yameongezwa kwenye madai hapa chini."],
  caseItems: ["About the case as a whole", "Kuhusu kesi kwa ujumla"], openConclusion: ["Open the conclusion", "Fungua hitimisho"],
  viewOnly: ["You can read this view. Only the assigned analyst, a reviewer or an administrator can record items, while the case is open for changes.", "Unaweza kusoma ukurasa huu. Ni mchambuzi aliyepewa kesi, mkaguzi au msimamizi tu wanaoweza kurekodi, wakati kesi iko wazi kwa mabadiliko."],
  // locations
  openPage: ["Page", "Ukurasa"], of: ["of", "ya"], docNoPage: ["Page not recorded", "Ukurasa haujarekodiwa"], recNoTime: ["Time not recorded", "Muda haujarekodiwa"],
  viewImage: ["View image", "Tazama picha"], frameAt: ["Frame at", "Fremu katika"], play: ["Play", "Cheza"], openSource: ["Open source", "Fungua chanzo"], fromRef: ["link found in the reference", "kiungo kilichopatikana kwenye marejeo"],
  snapshot: ["Archived copy", "Nakala iliyohifadhiwa"], archive: ["Reference archive", "Kumbukumbu za marejeo"], otherCase: ["Case", "Kesi"],
  noLoc: ["Exact location not recorded", "Mahali halisi hapajarekodiwa"], fileGone: ["Original file not available on this server", "Faili asili haipatikani kwenye seva hii"], mediaGone: ["Media item not found in this case", "Kipengele hakipo kwenye kesi hii"],
  setLoc: ["Record location", "Rekodi mahali"], docText: ["Document text", "Maandishi ya hati"], cancel: ["Cancel", "Ghairi"], type: ["Type", "Aina"], text: ["Text", "Maandishi"]
};
const t = k => (W[k] ? W[k][LANG === "sw" ? 1 : 0] : k);
const VSW = { supported: "Imethibitishwa", contradicted: "Imepingwa", partially_supported: "Imethibitishwa kwa sehemu", misleading_context: "Muktadha wa kupotosha", insufficient: "Ushahidi hautoshi", not_verifiable: "Haiwezi kuthibitishwa", unassessed: "Haijatathminiwa", mixed: "Matokeo mchanganyiko" };
const VEN = { supported: "Supported", contradicted: "Contradicted", partially_supported: "Partially supported", misleading_context: "Misleading context", insufficient: "Insufficient evidence", not_verifiable: "Not verifiable", unassessed: "Not assessed", mixed: "Mixed findings" };
const V = k => (LANG === "sw" ? VSW : VEN)[k] || k;
const VCLS = { supported: "sup", contradicted: "con", partially_supported: "mix", misleading_context: "mix", insufficient: "unr", not_verifiable: "grey", unassessed: "grey" };
const NEED_SW = { supported: "hakuna ushahidi uliokubaliwa unaoliunga mkono", contradicted: "hakuna ushahidi uliokubaliwa unaolipinga", partially_supported: "hakuna ushahidi uliokubaliwa unaounga mkono sehemu yoyote", misleading_context: "hakuna ushahidi uliokubaliwa unaoonyesha muktadha halisi" };
// the approval rules' own wording in English; the same rule in Kiswahili
function rule(i) {
  if (LANG !== "sw") return i.text;
  return ({ no_claims: "Ongeza angalau dai moja.", unassessed: `Dai ${i.seq} halijatathminiwa.`, no_rationale: `Dai ${i.seq} linahitaji maelezo mafupi ya sababu.`,
    verdict_needs: `Dai ${i.seq} limewekwa “${V(i.assessment)}” lakini ${NEED_SW[i.assessment] || "ushahidi uliokubaliwa haulingani na uamuzi"}.`,
    pending_suggestions: `Mapendekezo ${i.n} ya ushahidi bado yanasubiri kukubaliwa au kukataliwa.`, no_conclusion: "Chagua hitimisho la jumla.",
    conclusion_mismatch: `Hitimisho la jumla linapaswa kuwa “${V(i.expected)}” kulingana na tathmini za madai (sasa ni “${V(i.actual)}”).`,
    no_conclusion_reasoning: "Andika sababu za hitimisho la jumla.", no_uncertainties: "Rekodi mashaka yaliyobaki (andika “Hakuna yaliyobainika” kama hakuna)." })[i.code] || i.text;
}
const ATT = { conflict: ["evidence points both ways", "ushahidi unaelekea pande zote"], unreviewed: ["unreviewed suggestions", "mapendekezo hayajakaguliwa"], open_items: ["open items", "mambo yaliyo wazi"], file_unavailable: ["a source file is unavailable", "faili ya chanzo haipatikani"] };
const att = a => a.level === "blocks" ? rule(a) : `${a.n ? `${a.n} ` : ""}${ATT[a.code]?.[LANG === "sw" ? 1 : 0] || a.code}`;
const KIND_EN = { observation: "observation", source_claim: "source statement", inference: "inference", lead: "lead" }, KIND_SW = { observation: "uchunguzi", source_claim: "kauli ya chanzo", inference: "makisio", lead: "kidokezo" };
const ORIGIN_EN = { analyst: "analyst", system: "automatic check", ai: "AI", retrieval: "evidence search" }, ORIGIN_SW = { analyst: "mchambuzi", system: "ukaguzi wa kiotomatiki", ai: "AI", retrieval: "utafutaji wa ushahidi" };
const ts = s => { const x = Math.max(0, Number(s) || 0), m = Math.floor(x / 60); return `${m}:${(x % 60).toFixed(1).padStart(4, "0")}`; };
const parseTs = v => { const s = String(v || "").trim(); if (!s) return null; const p = s.split(":").map(Number); if (p.some(n => !Number.isFinite(n) || n < 0)) return NaN; return p.reduce((a, b) => a * 60 + b, 0); };
const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : null;

// AI results and hidden suggestions survive the page redraw that follows each change (per case, per language)
const AI = new Map(), HIDDEN = new Map();
export async function coverageTab(body, c, P, { reload }) {
  let D;
  const key = () => `${c.id}|${LANG}`;
  let ai = AI.get(key()) || null;
  const load = async () => { D = await api.get(`/api/cases/${encodeURIComponent(c.id)}/coverage?lang=${LANG}`); };
  await load();
  if (!HIDDEN.has(c.id)) HIDDEN.set(c.id, new Set());
  const hidden = HIDDEN.get(c.id);
  const draw = () => {
    const ed = D.perms.edit, R = D.readiness;
    const claimLink = id => { const x = D.claims.find(k => k.id === id); return x ? `<a href="#cov-${esc(id)}" data-jump="${esc(id)}">${t("claim")} ${x.seq}</a>` : esc(id); };
    body.innerHTML = `
      <div class="card"><div class="hd"><h3>${t("title")}</h3><span class="right"><span class="seg" role="group" aria-label="Language / Lugha"><button class="btn sm ${LANG === "en" ? "primary" : "ghost"}" data-lang="en" aria-pressed="${LANG === "en"}">English</button><button class="btn sm ${LANG === "sw" ? "primary" : "ghost"}" data-lang="sw" aria-pressed="${LANG === "sw"}">Kiswahili</button></span></span></div>
        <div class="bd"><p class="small muted" style="margin:0">${t("intro")}</p>${ed ? "" : `<div class="tiny sub" style="margin-top:6px">${t("viewOnly")}</div>`}</div></div>
      <div class="card" id="covOverview"><div class="hd"><h3>${t("overview")}</h3><span class="right">${R.ok ? `<span class="chip sup">${t("ready")}</span>` : `<span class="chip con">${t("blocked")}</span>`}</span></div><div class="bd">
        ${R.ok ? (R.submittable_state ? "" : `<div class="small muted">${t("notSubmittable")}</div>`) : `<div class="small"><b>${t("blockedBy")}</b></div><ul class="small covblock">${R.items.map(i => `<li>${i.claim_id ? `${claimLink(i.claim_id)}: ` : ""}${esc(rule(i))}${!i.claim_id ? ` <a class="tiny" href="#/case/${esc(c.id)}/report">${t("openConclusion")}</a>` : ""}</li>`).join("")}</ul>`}
        <h4 style="margin-top:12px">${t("needAttention")}</h4>
        ${D.attention.length ? `<div class="covatt">${D.attention.map(a => { const x = D.claims.find(k => k.id === a.id); return `<div class="covatt-row"><a href="#cov-${esc(a.id)}" data-jump="${esc(a.id)}"><b>${t("claim")} ${a.seq}</b></a><span class="chip ${VCLS[x.assessment] || "grey"}">${esc(V(x.assessment))}</span><span class="small covatt-t">${esc(x.text.slice(0, 110))}${x.text.length > 110 ? "…" : ""}</span><span class="covatt-why">${x.attention.map(z => `<span class="chip ${z.level === "blocks" ? "con" : "warn"}">${esc(att(z))}</span>`).join("")}</span></div>`; }).join("")}</div>` : `<div class="small muted">${t("allClear")}</div>`}
        ${aiBar(D, P)}
        <div id="aiOut"></div>
        ${D.case_gaps.length || ed || sugsOf(holder("")).length ? `<h4 style="margin-top:14px">${t("caseItems")}</h4>${gapsList(D.case_gaps, ed)}${sugsOf(holder("")).map(s => sugItem(s, "", s.i, ed)).join("")}${ed ? addForm("") : ""}` : ""}
      </div></div>
      ${D.claims.map(x => claimCard(x, ed)).join("")}`;
    bind();
  };
  const aiBar = D => {
    const A = D.ai, can = D.perms.ai && A.configured && A.enabled && !(A.training_only && !D.case.is_training);
    const why = !A.configured || !A.enabled ? A.reason : A.training_only && !D.case.is_training ? "AI_TRAINING_ONLY" : !D.perms.ai ? "" : A.health === "failed" ? "last connection check failed" : "";
    return `<div class="row" style="margin-top:12px;align-items:center"><button class="btn sm" id="covAi" ${can ? "" : "disabled"} title="${esc(can ? t("aiNote") : `${t("aiOff")}${why ? `: ${why}` : ""}`)}">${t("aiBtn")}</button>
      <span class="tiny sub">${can ? `${esc(A.provider || "")} ${esc(A.model || "")} · ${t("aiNote")}` : `${t("aiOff")}${why ? `: ${esc(why)}` : ""}`}</span></div>`;
  };
  const evItem = (e, { sugg = false } = {}) => `<div class="ev ${sugg ? "sugg" : ""}">
      <div class="row" style="gap:6px"><a class="mono small" href="#/case/${esc(c.id)}/evidence" title="Open on the Evidence tab"><b>${esc(e.id)}</b></a><span class="chip grey">${esc((LANG === "sw" ? KIND_SW : KIND_EN)[e.kind] || e.kind)}</span><span class="chip ${e.origin === "analyst" ? "grey" : "info"}">${esc((LANG === "sw" ? ORIGIN_SW : ORIGIN_EN)[e.origin] || e.origin)}</span>${sugg && e.proposed_stance ? `<span class="chip teal">${t("proposed")}: ${esc(e.proposed_stance)}</span>` : ""}${e.uncertainty ? `<span class="chip warn" title="${esc(e.uncertainty)}">${esc(e.uncertainty.slice(0, 60))}${e.uncertainty.length > 60 ? "…" : ""}</span>` : ""}</div>
      <div class="small" style="margin-top:4px">${esc(e.text)}</div>
      <div class="tiny sub" style="margin-top:2px;overflow-wrap:anywhere">${esc(e.reference)}${e.source_date ? ` · ${esc(e.source_date)}` : ""}</div>
      <div class="covloc">${e.locations.map(l => loc(e, l)).join("")}</div></div>`;
  const loc = (e, l) => {
    const canSet = D.perms.edit && e.status === "accepted";
    switch (l.type) {
      case "document_page": return `<button class="btn sm" data-page="${esc(l.media_id)}" data-n="${l.page}" data-name="${esc(l.name)}">${t("openPage")} ${l.page}${l.pages ? ` ${t("of")} ${l.pages}` : ""} · ${esc(l.media_id)}</button>${canSet ? `<button class="btn sm ghost" data-setloc="${esc(e.id)}" data-mk="document" data-mid="${esc(l.media_id)}">${t("setLoc")}</button>` : ""}`;
      case "document": return `<span class="chip grey">${t("docNoPage")}</span><a class="btn sm ghost" href="#/case/${esc(c.id)}/media" data-mc="${esc(l.media_id)}">${t("docText")} · ${esc(l.media_id)}</a>${canSet ? `<button class="btn sm ghost" data-setloc="${esc(e.id)}" data-mk="document" data-mid="${esc(l.media_id)}">${t("setLoc")}</button>` : ""}`;
      case "image": return `<button class="btn sm" data-img="${esc(l.media_id)}" data-name="${esc(l.name)}">${t("viewImage")} · ${esc(l.media_id)}</button>`;
      case "frame": return `<button class="btn sm" data-play="${esc(l.video_id)}" data-kind="video" data-s="${l.start}">${t("frameAt")} ${ts(l.start)} · ${esc(l.video_id)}</button><button class="btn sm ghost" data-img="${esc(l.media_id)}" data-name="${esc(l.name)}">${t("viewImage")}</button>`;
      case "timestamp": return `<button class="btn sm" data-play="${esc(l.media_id)}" data-kind="${esc(l.media_kind)}" data-s="${l.start}" data-e="${l.end ?? ""}">▶ ${t("play")} ${ts(l.start)}${l.end != null ? `–${ts(l.end)}` : ""} · ${esc(l.media_id)}</button>${l.transcript_id ? `<span class="chip grey">${esc(l.transcript_id)}</span>` : ""}${canSet ? `<button class="btn sm ghost" data-setloc="${esc(e.id)}" data-mk="time" data-mid="${esc(l.media_id)}">${t("setLoc")}</button>` : ""}`;
      case "recording": return `<span class="chip grey">${t("recNoTime")}</span><button class="btn sm ghost" data-play="${esc(l.media_id)}" data-kind="${esc(l.media_kind)}" data-s="0">▶ ${t("play")} · ${esc(l.media_id)}</button>${canSet ? `<button class="btn sm ghost" data-setloc="${esc(e.id)}" data-mk="time" data-mid="${esc(l.media_id)}">${t("setLoc")}</button>` : ""}`;
      case "file_unavailable": return `<span class="chip con" title="${esc(l.media_id)}">${t("fileGone")} (${esc(l.media_id)})</span>`;
      case "missing_media": return `<span class="chip con">${t("mediaGone")} (${esc(l.media_id)})</span>`;
      case "url": { const u = safeUrl(l.url); let host = ""; try { host = new URL(u).hostname; } catch {} return u ? `<a class="btn sm" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow" title="${esc(u)}">${t("openSource")} ↗ ${esc(host)}</a>${l.from_reference ? `<span class="tiny sub">${t("fromRef")}</span>` : ""}${l.snapshot ? `<a class="btn sm ghost" href="${esc(l.snapshot)}">${t("snapshot")}</a>` : ""}` : ""; }
      case "archive": return `<a class="btn sm ghost" href="#/archive">${t("archive")} · ${esc(l.id)}</a>`;
      case "case": return `<a class="btn sm ghost" href="#/case/${esc(l.id)}">${t("otherCase")} ${esc(l.id)}</a>`;
      default: return `<span class="chip grey">${t("noLoc")}</span>`;
    }
  };
  const gapsList = (gs, ed) => gs.length ? `<div class="covgaps">${gs.map(g => `<div class="covgap ${g.status !== "open" ? "closed" : ""}" data-gid="${g.id}">
      <div class="row" style="gap:6px"><span class="chip ${g.kind === "missing" ? "warn" : g.kind === "question" ? "info" : "teal"}">${t(g.kind)}</span><span class="chip ${g.status === "open" ? "grey" : g.status === "resolved" ? "sup" : "unr"}">${t(g.status)}</span>
        <span class="tiny sub">${esc(g.origin === "analyst" ? t("oAnalyst") : g.origin === "ai" ? t("oAi") : t("oRules"))}${g.ai_model ? ` (${esc(g.ai_model)})` : ""} · ${esc(g.created_by_name || "")} · ${fmtDT(g.created_at)}${g.updated_at ? ` · ${esc(g.updated_by_name || "")} ${fmtDT(g.updated_at)}` : ""}</span></div>
      <div class="small" style="margin-top:4px">${esc(g.text)}</div>${g.resolution ? `<div class="tiny sub">→ ${esc(g.resolution)}</div>` : ""}
      ${g.sources.length ? `<div class="tiny sub">${t("basedOn")}: ${g.sources.map(s => `<span class="mono">${esc(s)}</span>`).join(", ")}</div>` : ""}
      <div class="row" style="margin-top:4px">${ed ? `<button class="btn sm ghost" data-gedit="${g.id}">${t("edit")}</button>${g.status === "open" ? `<button class="btn sm ghost" data-gres="${g.id}">${t("resolve")}</button><button class="btn sm ghost" data-gdrop="${g.id}">${t("drop")}</button>` : `<button class="btn sm ghost" data-gopen="${g.id}">${t("reopen")}</button>`}` : ""}${g.history.length ? `<button class="btn sm ghost" data-ghist="${g.id}">${t("history")} (${g.history.length})</button>` : ""}</div></div>`).join("")}</div>` : `<div class="small muted">${t("noGaps")}</div>`;
  const addForm = claimId => `<div class="row covadd" style="margin-top:8px"><select data-addkind="${esc(claimId)}" aria-label="Type">${["missing", "question", "next_step"].map(k => `<option value="${k}">${t(k)}</option>`).join("")}</select><input type="text" data-addtext="${esc(claimId)}" placeholder="${esc(t("addPh"))}" maxlength="2000" aria-label="${esc(t("addPh"))}"><button class="btn sm" data-add="${esc(claimId)}">${t("add")}</button></div>`;
  const sugItem = (s, claimId, i, ed) => `<div class="covsug ${s.origin === "ai" ? "ai" : ""}"><div class="row" style="gap:6px"><span class="chip ${s.kind === "missing" ? "warn" : s.kind === "question" ? "info" : "teal"}">${t(s.kind)}</span><span class="chip ${s.origin === "ai" ? "info" : "grey"}">${s.origin === "ai" ? t("sAi") : t("sRules")}</span><span class="tiny sub">${t("basedOn")}: ${s.sources.map(x => `<span class="mono">${esc(x)}</span>`).join(", ")}</span></div>
      <div class="small" style="margin-top:3px">${esc(s.text)}</div>${ed ? `<div class="row" style="margin-top:4px"><button class="btn sm" data-sacc="${esc(claimId)}" data-i="${i}" data-src="${s.origin}">${t("accept")}</button><button class="btn sm ghost" data-shide="${esc(claimId)}" data-i="${i}" data-src="${s.origin}">${t("hide")}</button></div>` : ""}</div>`;
  const holder = id => id ? D.claims.find(k => k.id === id) : { id: "", gaps: D.case_gaps, rule_suggestions: [] };
  const recorded = x => new Set(x.gaps.map(g => g.text.toLowerCase().trim()));
  const sugsOf = x => [...x.rule_suggestions.map(s => ({ ...s, origin: "rules" })), ...((ai?.items || []).filter(s => (s.claim_id || "") === x.id).map(s => ({ ...s, origin: "ai" })))]
    .filter(s => !hidden.has(`${x.id}|${s.text}`) && !recorded(x).has(s.text.toLowerCase().trim())).map((s, i) => ({ ...s, i }));
  const claimCard = (x, ed) => {
    const sg = sugsOf(x), col = (k, list) => `<div class="covcol"><div class="covcol-h ${k}">${t(k)} <span class="num">(${list.length})</span></div>${list.length ? list.map(e => evItem(e)).join("") : `<div class="small muted">${t("none")}</div>`}</div>`;
    return `<div class="card covclaim${x.flagged ? " flagged" : ""}" id="cov-${esc(x.id)}"><div class="hd"><h3>${t("claim")} ${x.seq}</h3><span class="mono tiny sub">${esc(x.id)}</span><span class="chip ${VCLS[x.assessment] || "grey"}">${esc(V(x.assessment))}</span>${x.attention.length ? `<span class="right">${x.attention.map(z => `<span class="chip ${z.level === "blocks" ? "con" : "warn"}">${esc(att(z))}</span>`).join("")}</span>` : ""}</div>
      <div class="bd">
        ${x.flagged ? `<div class="callout bad" role="alert"><div class="small"><b>${t("flagged")}.</b> ${esc(rule(x.blocking.find(b => b.code === "verdict_needs")))}</div></div>` : ""}
        <p style="margin:0 0 8px"><b>${esc(x.text)}</b></p>
        <dl class="kv small"><dt>${t("assessment")}</dt><dd>${esc(V(x.assessment))}${x.assessed_by_name ? ` <span class="tiny sub">${t("by")} ${esc(x.assessed_by_name)} · ${fmtDT(x.assessed_at)}</span>` : ""}</dd>
          <dt>${t("reasoning")}</dt><dd>${x.rationale ? esc(x.rationale) : `<span class="sub">${t("noReasoning")}</span>`} <a class="tiny" href="#/case/${esc(c.id)}/claims">${t("editClaims")}</a></dd>
          <dt>${t("strength")}</dt><dd>${x.strength ? esc(x.strength.reasons.join("; ")) : ""} <span class="tiny sub">(${t("notProb")})</span></dd></dl>
        <div class="covcols">${col("supports", x.supports)}${col("contradicts", x.contradicts)}</div>
        <div class="covcol" style="margin-top:10px"><div class="covcol-h context">${t("context")} <span class="num">(${x.context.length})</span></div>${x.context.length ? x.context.map(e => evItem(e)).join("") : `<div class="small muted">${t("none")}</div>`}</div>
        ${x.suggestions.length ? `<div class="covcol" style="margin-top:10px"><div class="covcol-h sugg">${t("unreviewed")} <span class="num">(${x.suggestions.length})</span> <a class="tiny" href="#/case/${esc(c.id)}/evidence">${t("reviewOn")}</a></div>${x.suggestions.map(e => evItem(e, { sugg: true })).join("")}</div>` : ""}
        <h4 style="margin-top:14px">${t("gapsTitle")}</h4>${gapsList(x.gaps, ed)}${ed ? addForm(x.id) : ""}
        <h4 style="margin-top:14px">${t("sugTitle")}</h4>${sg.length ? sg.map(s => sugItem(s, x.id, s.i, ed)).join("") : `<div class="small muted">${t("noSug")}</div>`}
      </div></div>`;
  };
  const refresh = async () => { await load(); draw(); };
  const after = async msg => { if (msg) toast(msg); await reload(); };   // reloads the case (counts, guided step) and redraws this tab
  function bind() {
    $$("[data-lang]", body).forEach(b => b.onclick = async () => { LANG = b.dataset.lang; try { localStorage.setItem("aivs.coverage.lang", LANG); } catch {} ai = AI.get(key()) || null; await refresh(); });
    $$("[data-jump]", body).forEach(a => a.onclick = ev => { ev.preventDefault(); document.getElementById(`cov-${a.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); });
    $$("[data-img]", body).forEach(b => b.onclick = () => viewer(content(b.dataset.img), `${b.dataset.img} · ${b.dataset.name}`));
    $$("[data-play]", body).forEach(b => b.onclick = () => player(b.dataset.play, b.dataset.kind, Number(b.dataset.s) || 0, b.dataset.e === "" || b.dataset.e === undefined ? null : Number(b.dataset.e)));
    $$("[data-page]", body).forEach(b => b.onclick = async () => {
      try { const p = await api.get(`/api/media/${encodeURIComponent(b.dataset.page)}/pages/${b.dataset.n}`);
        modal(`${b.dataset.page} · ${t("openPage")} ${p.page}${p.pages ? ` ${t("of")} ${p.pages}` : ""}`, `<div class="tiny sub">${esc(p.name)} · ${LANG === "sw" ? "maandishi yaliyotolewa; hati asili inafunguliwa kwa kupakuliwa tu" : "extracted text; the original document opens only as a download"}</div>${p.text != null ? `<pre class="box" style="max-height:60vh;overflow:auto;white-space:pre-wrap">${esc(p.text || "(no text on this page)")}</pre>` : `<div class="callout warn"><div class="small">${esc(p.note)}</div></div>`}<a class="btn sm ghost" href="${content(b.dataset.page)}?download=1">Download original</a>`, undefined, { wide: true }); }
      catch (e) { fail(e); }
    });
    $$("[data-mc]", body).forEach(a => a.onclick = () => setTimeout(() => document.getElementById(`mc-${a.dataset.mc}`)?.scrollIntoView({ block: "start" }), 600));
    $$("[data-setloc]", body).forEach(b => b.onclick = () => setLocation(b.dataset.setloc, b.dataset.mk, b.dataset.mid));
    $$("[data-add]", body).forEach(b => b.onclick = async () => {
      const k = b.dataset.add, text = $(`[data-addtext="${CSS.escape(k)}"]`, body).value.trim(), kind = $(`[data-addkind="${CSS.escape(k)}"]`, body).value;
      if (!text) return toast(t("addPh"));
      try { await api.post(`/api/cases/${c.id}/gaps`, { claim_id: k || null, kind, text }); await after(); } catch (e) { fail(e); }
    });
    $$("[data-sacc]", body).forEach(b => b.onclick = async () => {
      const x = holder(b.dataset.sacc), s = sugsOf(x)[Number(b.dataset.i)]; if (!s) return;
      try { await api.post(`/api/cases/${c.id}/gaps`, { claim_id: x.id || null, kind: s.kind, text: s.text, origin: s.origin, sources: s.sources, code: s.code, ai_model: s.origin === "ai" ? ai?.model : undefined });
        await after(); } catch (e) { fail(e); }
    });
    $$("[data-shide]", body).forEach(b => b.onclick = () => { const x = holder(b.dataset.shide), s = sugsOf(x)[Number(b.dataset.i)]; if (s) hidden.add(`${x.id}|${s.text}`); draw(); });
    const gap = id => [...D.case_gaps, ...D.claims.flatMap(x => x.gaps)].find(g => g.id === Number(id));
    $$("[data-gedit]", body).forEach(b => b.onclick = async () => {
      const g = gap(b.dataset.gedit);
      const r = await modal(t("edit"), `<label class="f" for="gk">${t("type")}</label><select id="gk">${["missing", "question", "next_step"].map(k => `<option value="${k}" ${k === g.kind ? "selected" : ""}>${t(k)}</option>`).join("")}</select><label class="f" for="gt">${t("text")}</label><textarea id="gt" rows="3" maxlength="2000">${esc(g.text)}</textarea><div class="tiny sub">${LANG === "sw" ? "Maandishi ya awali yanahifadhiwa kwenye historia." : "The earlier wording is kept in the history."}</div>`,
        [{ label: t("cancel"), value: null }, { label: t("edit"), kind: "primary", value: el => ({ kind: $("#gk", el).value, text: $("#gt", el).value }) }]);
      if (!r.value) return; try { await api.patch(`/api/gaps/${g.id}`, r.value); await after(); } catch (e) { fail(e); }
    });
    $$("[data-gres]", body).forEach(b => b.onclick = async () => {
      const r = await modal(t("resolve"), `<label class="f" for="gr">${LANG === "sw" ? "Imetatuliwaje? (kwa mfano kitambulisho cha ushahidi kinachojibu)" : "How was it resolved? (for example the evidence ID that answers it)"}</label><textarea id="gr" rows="2" maxlength="2000"></textarea>`,
        [{ label: t("cancel"), value: null }, { label: t("resolve"), kind: "primary", value: el => $("#gr", el).value }]);
      if (r.value == null) return; try { await api.patch(`/api/gaps/${b.dataset.gres}`, { status: "resolved", resolution: r.value }); await after(); } catch (e) { fail(e); }
    });
    $$("[data-gdrop]", body).forEach(b => b.onclick = async () => { try { await api.patch(`/api/gaps/${b.dataset.gdrop}`, { status: "dropped" }); await after(); } catch (e) { fail(e); } });
    $$("[data-gopen]", body).forEach(b => b.onclick = async () => { try { await api.patch(`/api/gaps/${b.dataset.gopen}`, { status: "open" }); await after(); } catch (e) { fail(e); } });
    $$("[data-ghist]", body).forEach(b => b.onclick = () => { const g = gap(b.dataset.ghist);
      modal(t("history"), `<table class="tbl small"><thead><tr><th>${LANG === "sw" ? "Lini" : "When"}</th><th>${LANG === "sw" ? "Nani" : "Who"}</th><th>${LANG === "sw" ? "Kabla" : "Before"}</th></tr></thead><tbody>${g.history.map(v => `<tr><td>${fmtDT(v.changed_at)}</td><td>${esc(v.changed_by_name || "")}</td><td>${t(v.kind)} · ${t(v.status)}<br>${esc(v.text)}${v.resolution ? `<br><span class="sub">→ ${esc(v.resolution)}</span>` : ""}</td></tr>`).join("")}<tr><td>${fmtDT(g.updated_at || g.created_at)}</td><td>${esc(g.updated_by_name || g.created_by_name || "")}</td><td><b>${LANG === "sw" ? "Sasa" : "Now"}:</b> ${t(g.kind)} · ${t(g.status)}<br>${esc(g.text)}</td></tr></tbody></table>`, undefined, { wide: true }); });
    const aib = $("#covAi", body);
    if (aib) aib.onclick = async () => {
      aib.disabled = true; aib.innerHTML = `<span class="spin"></span> ${t("aiBtn")}`;
      try { ai = await api.post(`/api/cases/${c.id}/coverage/ai`, { lang: LANG }); } catch (e) { ai = { mode: "rules", fallback: true, error: e.message, items: [], removed: [] }; }
      AI.set(key(), ai); draw();
    };
    if (ai) $("#aiOut", body).innerHTML = ai.fallback ? `<div class="callout warn" style="margin-top:8px"><div class="small"><b>${t("aiFail")}</b> ${esc(ai.error || "")}</div></div>`
        : `<div class="callout" style="margin-top:8px"><div class="small">${t("aiDone")} (${ai.items.length}; ${esc(ai.model || "")})${ai.injection_flags ? ` · ${ai.injection_flags} possible instruction(s) found in the case material were treated as data` : ""}</div>${ai.removed.length ? `<details style="margin-top:6px"><summary class="small">${t("aiRemoved")} (${ai.removed.length})</summary><ul class="tiny">${ai.removed.map(r => `<li>“${esc(r.text.slice(0, 160))}” — ${esc(r.why)}</li>`).join("")}</ul></details>` : ""}</div>`;
  }
  async function setLocation(eid, mk, mid) {
    const body2 = mk === "document" ? `<label class="f" for="lp">${t("openPage")} (${esc(mid)})</label><input type="number" id="lp" min="1" step="1" inputmode="numeric">`
      : `<div class="grid g2"><div><label class="f" for="ls">Start (m:ss)</label><input type="text" id="ls" placeholder="1:05" inputmode="decimal"></div><div><label class="f" for="le">End (m:ss, optional)</label><input type="text" id="le" placeholder="1:20" inputmode="decimal"></div></div>`;
    const r = await modal(`${t("setLoc")} · ${eid}`, body2, [{ label: t("cancel"), value: null }, { label: t("setLoc"), kind: "primary", value: el => mk === "document" ? { loc_page: $("#lp", el).value === "" ? null : Number($("#lp", el).value) } : { loc_start_s: parseTs($("#ls", el).value), loc_end_s: parseTs($("#le", el).value) },
      validate: el => mk === "document" ? null : Number.isNaN(parseTs($("#ls", el).value)) || Number.isNaN(parseTs($("#le", el).value)) ? "Use minutes:seconds, for example 1:05." : null }]);
    if (!r.value) return;
    try { await api.patch(`/api/evidence/${eid}`, r.value); await after(); } catch (e) { fail(e); }
  }
  function player(mid, kind, start, end) {
    const tag = kind === "audio" ? "audio" : "video";
    modal(`${mid} · ${ts(start)}${end != null ? `–${ts(end)}` : ""}`, `<${tag} id="covPlayer" src="${content(mid)}" controls preload="metadata" style="width:100%;max-height:60vh"></${tag}><div class="tiny sub" style="margin-top:6px">${LANG === "sw" ? "Inaanza kucheza kwenye muda uliorekodiwa." : "Starts at the recorded time."}${end != null ? (LANG === "sw" ? " Inasimama mwisho wa kipande." : " Pauses at the end of the passage.") : ""}</div>`, undefined, { wide: true, onOpen: el => {
      const p = el.querySelector("#covPlayer"); const go = () => { try { p.currentTime = start; } catch {} p.play?.().catch(() => {}); };
      if (p.readyState >= 1) go(); else p.addEventListener("loadedmetadata", go, { once: true });
      if (end != null) p.addEventListener("timeupdate", () => { if (p.currentTime >= end) p.pause(); });
    } });
  }
  draw();
  return { refresh };
}

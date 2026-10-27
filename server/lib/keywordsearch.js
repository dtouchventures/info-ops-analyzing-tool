// Keyword search and monitoring of public information (AIVS 1.27).
//
// An analyst types any keyword, phrase, hashtag or combination and searches every connected, authorised source at once:
//   query syntax   Kenya Army              a phrase (words next to each other are one phrase)
//                  "Kenya Army" OR KDF     alternatives (OR or a comma)
//                  KDF AND Lamu            every group must match
//                  KDF -recruitment        exclude a word or phrase (also NOT recruitment)
//                  #KDF                    a hashtag
// Sources: news sites (RSS/Atom), GDELT and Brave news search, YouTube, X, Reddit, Bluesky, Mastodon, Threads, Instagram
// hashtags, named Facebook Pages, TikTok (approved researchers) and the posts of the organisation's own Facebook Page. Each is
// used only when its official API is configured; the result of every source is reported (results, error, not configured,
// restricted). Nothing is invented and nothing is stored that a source did not return.
// Results are stored once (platform + post ID); the same article found by several sources is marked as a duplicate.
// A search can be saved as a watchlist, which then repeats automatically on the watch scheduler (watch-collect.js).
// Analysis: rule-based reading of every item (claims, places, organisations, themes, tone, misinformation cues), then the
// set as a whole (narratives, repeated wording, contradictory figures or denials, information gaps), then a draft report
// (Background, Analysis, Assessment, Recommendations) whose text the organisation's Ollama model may rewrite; the rewrite is
// checked (no new references, links, percentages or attribution) and the report stays "AI-generated" until reviewed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nowISO } from "./db.js";
import { HttpError } from "./auth.js";
import { WATCH_SOURCES, UNSUPPORTED, normaliseDefinition, matchPost, normForRepeat, similarity, KENYA_NEWS_SITES, KDF_DEFAULT, isTestRecord } from "./watch.js";
import { fetchImage } from "./fetchurl.js";
import { classifySentiment, themesOf, THEMES, SENTIMENT_LABELS, topicClusters, sourceCategory } from "./social-analysis.js";
import { extractEntities, extractHashtags, splitSentences, classifyStatement, redFlags } from "../../shared/text.js";
import { figures, negates } from "./autoeval.js";
import { VERIFY_LABELS, VERDICT_TO_STATUS } from "./livemonitor.js";
import { checkAiSections, aiPrompt, assessmentHtml, assessmentPdf, assessmentDocxXml, words, applyApproval, validRecommendation } from "./ioassessment.js";
import { docxFromBody } from "./autoreport.js";

// sources an analyst can search on demand, and what their access really is
// (the organisation's own Facebook Page is no longer a monitoring source (1.29): its posts are not public information discovered by
// keyword; the Meta Graph integration stays for Verify Information and later authorised use)
export const SEARCHABLE = ["news", "gdelt", "brave_news", "youtube", "x_search", "reddit", "bluesky", "mastodon", "threads", "instagram", "facebook", "tiktok"];
// posts of the organisation's own Page never count as monitoring results, whichever way they were stored
const NOT_OWN = p => `coalesce(${p}.first_source,'') <> 'fb_live' AND NOT EXISTS (SELECT 1 FROM social_posts sp WHERE sp.post_id = ${p}.post_id AND ${p}.platform IN ('Facebook','Instagram'))`;
const RESTRICTED = {
  facebook: "Meta does not offer keyword search of Facebook. AIVS reads only the Pages named in the watchlist or FACEBOOK_PAGES, with a token those Pages allow (Page Public Content Access for other organisations' Pages). Personal profiles and groups are never read.",
  instagram: "Hashtag search only, through an Instagram professional account and Meta's Instagram Public Content Access approval. Personal accounts are not searched.",
  threads: "Keyword search needs Meta's approval for threads_keyword_search.",
  tiktok: "Only researchers approved by TikTok can use the Research API.",
  mastodon: "Follows public hashtags on the named servers only; Mastodon offers no full-text search.",
  fb_live: "Only the organisation's own authorised Facebook Page(s), collected by live monitoring. This is not a search of Facebook."
};
const ENGINE = new Set(["gdelt", "brave_news", "youtube", "x_search", "reddit", "bluesky", "threads"]);   // the platform matched the query itself, often in text AIVS does not receive
// which matches count as genuine results: confirmed by a keyword, by a contextual keyword with its context, or by an analyst.
// News search engines (GDELT, Brave) match the full article, of which AIVS receives the headline: such items are kept as "keyword in
// the full article". Ambiguous keyword matches wait for an analyst; social media items found only by the platform's own search (the
// keyword is not in the text AIVS received) are listed only when asked for. Older records without a quality count as confirmed.
const GOOD = q => `coalesce(${q},'confirmed') IN ('confirmed','contextual','analyst','article')`;
const QUALITY_LABEL = { confirmed: "Keyword match", contextual: "Contextual match — confirm", analyst: "Confirmed by an analyst", ambiguous: "Ambiguous — needs an analyst", article: "Keyword in the full article (news search)", engine: "Found by the platform's search only", rejected: "Not relevant (analyst)" };
const PLATFORM_GROUP = p => /^News/.test(p) ? "News" : p === "X (Twitter)" ? "X" : p;
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const J = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const eatIso = (d, end = false) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? new Date(new Date(`${d}T00:00:00+03:00`).getTime() + (end ? 864e5 - 1 : 0)).toISOString() : d && !isNaN(Date.parse(d)) ? new Date(d).toISOString() : null;
export function urlKey(u) {
  try { const x = new URL(u); x.hash = ""; for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ocid|cmpid|ref$|src$)/i.test(k)) x.searchParams.delete(k);
    return `${x.hostname.replace(/^(www|m|amp|mobile)\./, "").toLowerCase()}${x.pathname.replace(/\/amp\/?$/, "/").replace(/\/+$/, "")}${x.search}`; } catch { return null; }
}

// ---------------------------------------------------------------- query syntax
export function parseQuery(q) {
  const text = String(q || "").trim();
  if (!text) throw new HttpError(400, "Type a keyword, phrase, hashtag or topic to search for.");
  if (text.length > 500) throw new HttpError(400, "The search is too long (at most 500 characters).");
  const tokens = [...text.matchAll(/"([^"]+)"|(\S+)/g)].map(m => (m[1] != null ? { w: m[1].trim(), quoted: true } : { w: m[2] }));
  const groups = [[]], exclude = []; let phrase = [], negate = false;
  const flush = () => { if (phrase.length) { const t = phrase.join(" ").replace(/^[,;]+|[,;]+$/g, "").trim(); if (t) (negate ? exclude : groups[groups.length - 1]).push(t); } phrase = []; negate = false; };
  for (const t of tokens) {
    if (!t.quoted && /^(OR|\||,)$/.test(t.w)) { flush(); continue; }
    if (!t.quoted && /^(AND|&|\+)$/.test(t.w)) { flush(); groups.push([]); continue; }
    if (!t.quoted && t.w === "NOT") { flush(); negate = true; continue; }
    if (!t.quoted && /^-[^\s-]/.test(t.w)) { flush(); exclude.push(t.w.slice(1)); continue; }
    if (t.quoted) { flush(); const was = negate; phrase = [t.w]; negate = was; flush(); continue; }
    if (t.w.endsWith(",")) { phrase.push(t.w.slice(0, -1)); flush(); continue; }
    phrase.push(t.w);
    if (negate) flush();
  }
  flush();
  const g = groups.map(x => [...new Set(x)]).filter(x => x.length);
  if (!g.length) throw new HttpError(400, "The search has no words to look for (only exclusions).");
  for (const t of g.flat()) if (t.replace(/^#/, "").length < 2) throw new HttpError(400, `“${t}” is too short to search for.`);
  return { terms: g[0], require_groups: g.slice(1), exclude: [...new Set(exclude)] };
}
export const describeQuery = p => [p.terms.map(t => `“${t}”`).join(" or "), ...p.require_groups.map(g => `and ${g.map(t => `“${t}”`).join(" or ")}`), p.exclude.length ? `without ${p.exclude.map(t => `“${t}”`).join(", ")}` : ""].filter(Boolean).join(" ");

// ---------------------------------------------------------------- analysis of one item (rules; every result says how it was produced)
export function analyseItem(text) {
  const t = String(text || ""), ent = extractEntities(t), sent = t ? classifySentiment(t) : null;
  const statements = splitSentences(t).slice(0, 10).map(s => ({ text: s, type: classifyStatement(s).type }));
  return { method: `AIVS rules; tone by ${sent?.method || "none"}`, claims: statements.filter(s => s.type === "factual").map(s => s.text).slice(0, 6), entities: { locations: ent.locations, organisations: ent.orgs, numbers: ent.numbers },
    hashtags: extractHashtags(t), themes: themesOf(t).map(k => THEMES[k][0]), tone: sent ? { label: SENTIMENT_LABELS[sent.label] || sent.label, uncertain: sent.label === "mixed" || (sent.confidence ?? 0) < 0.6, basis: sent.basis } : null,
    indicators: redFlags(t).map(f => ({ cue: f.cue, indicator: f.text, check: f.check })), figures: [...figures(t)] };
}

// ---------------------------------------------------------------- analysis of a set of items (pure; used for reports and tests)
// items: { n, id, platform, account, text, url, posted_at, analysis }
export function situation(items, { query = "", from = null, to = null, perSource = [] } = {}) {
  const N = items.length, byPlatform = {}, outlets = new Set(), themes = {};
  for (const it of items) { const g = PLATFORM_GROUP(it.platform); byPlatform[g] = (byPlatform[g] || 0) + 1; outlets.add(`${it.platform}|${it.account || "?"}`); for (const th of it.analysis?.themes || []) themes[th] = (themes[th] || 0) + 1; }
  // narratives: clusters of items about the same thing (term overlap); emerging when most of a cluster is recent
  const cl = N >= 6 ? topicClusters(items.map(i => ({ text: i.text }))) : { topics: [], assign: [] };
  const latest = items.reduce((a, i) => (i.posted_at && i.posted_at > a ? i.posted_at : a), ""), cut = latest ? new Date(Date.parse(latest) - 864e5).toISOString() : null;
  const narratives = cl.topics.map(t => { const members = items.filter((_, i) => cl.assign[i] === t.topic_no); const recent = cut ? members.filter(m => m.posted_at && m.posted_at >= cut).length : 0;
    return { label: t.label, terms: t.terms, items: members.map(m => m.n), sources: new Set(members.map(m => m.account)).size, recent, emerging: members.length >= 3 && recent / members.length >= 0.7 }; });
  // repeated wording: the same or nearly the same text from more than one item
  const repeated = [], seen = new Set();
  for (const a of items) { if (seen.has(a.n) || normForRepeat(a.text).split(" ").length < 6) continue; const same = items.filter(b => b !== a && !seen.has(b.n) && (normForRepeat(b.text) === normForRepeat(a.text) || similarity(a.text, b.text) >= 0.8));
    if (same.length) { const g = [a, ...same]; g.forEach(x => seen.add(x.n)); repeated.push({ items: g.map(x => x.n), accounts: new Set(g.map(x => x.account)).size, text: a.text.slice(0, 160) }); } }
  // contradictions: items about the same places/organisations that give different figures, or where one denies what another states
  const contradictions = [];
  for (let i = 0; i < N && contradictions.length < 8; i++) for (let j = i + 1; j < N && contradictions.length < 8; j++) {
    const a = items[i], b = items[j], ea = a.analysis?.entities || {}, eb = b.analysis?.entities || {};
    const shared = [...new Set([...(ea.locations || []), ...(ea.organisations || [])])].filter(x => [...(eb.locations || []), ...(eb.organisations || [])].includes(x));
    if (!shared.length || similarity(a.text, b.text) >= 0.8 || a.account === b.account) continue;
    const den = negates(a.text, b.text) || negates(b.text, a.text);
    const na = (ea.numbers || []).map(x => x.match(/\d[\d,]*/)?.[0]?.replace(/,/g, "")).filter(Boolean), nb = (eb.numbers || []).map(x => x.match(/\d[\d,]*/)?.[0]?.replace(/,/g, "")).filter(Boolean);
    const unit = s => (s.match(/[a-z]+$/i) || [""])[0].toLowerCase(), pairs = (ea.numbers || []).flatMap(x => (eb.numbers || []).filter(y => unit(x) && unit(x) === unit(y) && x.replace(/\D/g, "") !== y.replace(/\D/g, "")).map(y => [x, y]));
    if (den) contradictions.push({ kind: "denial", items: [a.n, b.n], about: shared.slice(0, 3), detail: `one item states the opposite of the other (“${den}”)` });
    else if (pairs.length && na.length && nb.length) contradictions.push({ kind: "figures", items: [a.n, b.n], about: shared.slice(0, 3), detail: `different figures: ${pairs[0][0]} against ${pairs[0][1]}` });
  }
  // information gaps
  const cats = items.map(i => (i.url ? sourceCategory(i.url) : null)), official = cats.filter(c => c === "official").length, newsN = items.filter(i => /^News/.test(i.platform)).length;
  const socialOnly = narratives.filter(nv => nv.items.every(k => !/^News/.test(items[k - 1].platform)));
  const failed = perSource.filter(s => s.state !== "ok"), gaps = [];
  if (!official) gaps.push("No official (government) source appears among the results.");
  if (N && !newsN) gaps.push("No news coverage was found; the results come from social media only.");
  for (const nv of socialOnly.slice(0, 2)) gaps.push(`The narrative “${nv.label}” appears only on social media, with no news coverage found.`);
  const undated = items.filter(i => !i.posted_at).length; if (undated) gaps.push(`${undated} item(s) carry no publication date.`);
  if (failed.length) gaps.push(`Not searched or failed: ${failed.map(s => `${s.label} (${s.state.replace(/_/g, " ")})`).join("; ")}.`);
  const indicators = items.filter(i => i.analysis?.indicators?.length).map(i => ({ n: i.n, cues: i.analysis.indicators.map(x => x.cue) }));
  return { query, from, to, total: N, by_platform: byPlatform, outlets: outlets.size, themes: Object.entries(themes).sort((a, b) => b[1] - a[1]).slice(0, 6), narratives, repeated, contradictions, gaps, indicators,
    note: "Repetition, frequency and similarity are observations about publicly visible content; they do not show coordination, intent or who is behind a message." };
}

// ---------------------------------------------------------------- the draft report (Background, Analysis, Assessment, Recommendations)
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function eatStamp(iso, time = true) { const d = new Date(Date.parse(iso) + 3 * 3600e3), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], p = x => String(x).padStart(2, "0"); return isNaN(d) ? "—" : `${p(d.getUTCDate())} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}${time ? ` ${p(d.getUTCHours())}${p(d.getUTCMinutes())}hrs EAT` : ""}`; }
export function draftReport(sit, items, { reference, subject, status = "AI-Generated (not reviewed)", version = "", training = false }) {
  const refs = [], cite = n => { const it = items[n - 1]; if (!it) return ""; let r = refs.find(x => x.item === n); if (!r && refs.length < 3 && it.url) { r = { n: refs.length + 1, item: n, url: it.url, title: it.text.slice(0, 90), publisher: it.account || it.platform, date: it.posted_at ? eatStamp(it.posted_at, false) : null, addresses: "reports on the subject" }; refs.push(r); } return r ? ` [${r.n}]` : ""; };
  const period = `${sit.from ? eatStamp(sit.from, false) : "the start of the available results"} to ${sit.to ? eatStamp(sit.to, false) : eatStamp(nowISO(), false)}`;
  const plat = Object.entries(sit.by_platform).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const background = sit.total ? `AIVS searched the connected public sources for ${subject}, covering ${period}. It found ${plural(sit.total, "item")} from ${plural(sit.outlets, "source")} (${plat}). The subject is monitored because public information about it may shape understanding of Kenya's security environment.`
    : `AIVS searched the connected public sources for ${subject}, covering ${period}, and found no matching item. The absence of results may reflect the sources available rather than an absence of discussion.`;
  const an = [];
  if (sit.narratives.length) an.push(`The items group into ${plural(sit.narratives.length, "narrative")}: ${sit.narratives.slice(0, 3).map(nv => `“${nv.label}” (${plural(nv.items.length, "item")}${nv.emerging ? ", mostly in the last 24 hours" : ""})${cite(nv.items[0])}`).join("; ")}.`);
  else if (sit.total) an.push(`Too few items were found to identify distinct narratives${sit.total ? `; the first item reports: “${items[0].text.slice(0, 80)}”${cite(1)}` : ""}.`);
  if (sit.themes.length) an.push(`Recurring themes are ${sit.themes.slice(0, 3).map(([t, c]) => `${t.toLowerCase()} (${c})`).join(", ")}.`);
  if (sit.repeated.length) an.push(`The same or nearly the same wording appears in ${sit.repeated.map(r => r.items.length).reduce((a, b) => a + b, 0)} items across ${plural(sit.repeated.length, "group")}${cite(sit.repeated[0].items[0])}; repetition alone does not show coordination.`);
  if (sit.contradictions.length) an.push(`${plural(sit.contradictions.length, "pair")} of items disagree: ${sit.contradictions.slice(0, 2).map(c => `${c.detail} about ${c.about.join(", ")}${cite(c.items[0])}${cite(c.items[1])}`).join("; ")}.`);
  if (sit.indicators.length) an.push(`${plural(sit.indicators.length, "item")} show features common in misleading messages (${[...new Set(sit.indicators.flatMap(i => i.cues))].slice(0, 3).join(", ")}); these are indicators, not proof.`);
  const analysis = an.join(" ") || "No item was available to analyse.";
  const strength = !sit.total ? "None found" : sit.outlets >= 3 && sit.by_platform.News ? "Moderate" : "Weak";
  const as = [sit.total ? `Available reporting indicates public discussion of the subject across ${plural(sit.outlets, "source")}; this is a summary of what was found, not a verification of each claim.` : "There is insufficient information to assess the subject from the connected sources.",
    sit.contradictions.length ? "Conflicting reports mean the facts remain unresolved until checked against an authoritative source." : null,
    sit.narratives.some(n => n.emerging) ? "At least one narrative is emerging and may gain attention if repeated." : null,
    "There are no indicators of coordinated activity in the available data; account and timing data were not assessed.",
    `Overall: ${sit.total ? "monitoring summary" : "no results"}. Evidence strength: ${strength}, based on the number and type of independent sources found.`,
    sit.gaps.length ? `Key gap: ${sit.gaps[0].replace(/\.$/, "")}.` : null].filter(Boolean).join(" ");
  // recommendations of the KDF Information Operations format: each begins "There is a need to…"; verification itself is AIVS's task
  const rec = [];
  if (sit.contradictions.length) rec.push("There is a need to avoid relying on either of the conflicting reports in public communication until the facts are established.");
  if (sit.indicators.length) rec.push("There is a need to raise public awareness of the misleading features observed in some items, through authorised KDF communication channels.");
  if (sit.narratives.some(n => n.emerging) || sit.repeated.length) rec.push("There is a need to monitor the emerging narrative through the AIVS watchlist for renewed circulation or amplification.");
  else rec.push("There is a need to keep the subject under monitoring through the AIVS watchlist while it remains of interest.");
  rec.push("There is a need to provide timely and accurate information on the subject through authorised KDF channels where public interest warrants it.");
  rec.push("There is a need to preserve the items collected and escalate significant concerns for authorised review.");
  return { title: "AIVS — PUBLIC INFORMATION MONITORING REPORT", header: { reference, date: eatStamp(nowISO()), subject: subject.slice(0, 120), source: plat, source_url: null, area: [...new Set(items.flatMap(i => i.analysis?.entities?.locations || []))].slice(0, 3).join(", ") || "Not established", priority: sit.contradictions.length || sit.indicators.length ? "Priority" : "Routine", status },
    background, analysis, assessment: as, recommendations: [...new Set(rec)].slice(0, 5), references: refs, limitation: sit.gaps[0] ? `The most important limitation is that ${sit.gaps[0].replace(/\.$/, "").replace(/^./, c => c.toLowerCase())}.` : "Only the connected sources were searched; content outside them was not seen.",
    report_status: `Generated automatically by AIVS ${version}; not reviewed or approved by a person. Analytical support product; not an official KDF intelligence document.`, verdict_label: sit.total ? "Monitoring summary" : "No results", strength, written_by: "rules", training };
}

export function makeKeywordSearch(db, { watch, watchCollector, investigations, storage, audit, config, version = "dev", live = null, ai = null, approvals = null }) {
  const W = { searchMaxPerSource: 50, ...(config.watch || {}) };
  const running = new Set();
  const SRC = () => watchCollector.status().sources;

  // ---------------------------------------------------------------- source status: connected, restricted, unavailable, not configured
  function sources() {
    const st = Object.fromEntries(SRC().map(s => [s.key, s]));
    const last = key => db.prepare("SELECT per_source_json, finished_at FROM monitor_searches WHERE status = 'done' ORDER BY id DESC LIMIT 30").all().flatMap(r => (J(r.per_source_json) || []).map(x => ({ ...x, at: r.finished_at }))).find(x => x.source === key) || null;
    const run = key => db.prepare("SELECT status, last_ok_at, last_error, last_run_at FROM watch_source_state WHERE source = ? ORDER BY coalesce(last_run_at,'') DESC LIMIT 1").get(key) || null;
    const items = key => db.prepare("SELECT COUNT(*) n FROM watch_posts WHERE first_source = ?").get(key).n;
    const out = SEARCHABLE.map(key => {
      const s = key === "fb_live" ? { label: WATCH_SOURCES.fb_live.label, ...(config.live?.pageToken ? { state: "ready" } : { state: "not_configured", needs: "META_PAGE_ACCESS_TOKEN and META_PAGE_IDS" }) } : st[key] || { state: "unsupported" };
      const l = last(key), r = run(key), failed = (l && l.state !== "ok" && l.state !== "not_configured") || (r && ["not_permitted", "retrying", "error", "rate_limited"].includes(r.status));
      const category = s.state !== "ready" ? (s.state === "disabled" ? "Not configured" : s.state === "unsupported" ? "Unavailable" : "Not configured")
        : (l?.state === "restricted" || r?.status === "not_permitted") ? "Restricted" : failed ? "Unavailable" : (l?.state === "ok" || r?.last_ok_at) ? "Connected" : "Configured, not yet tested";
      return { key, label: s.label || WATCH_SOURCES[key]?.label || key, platform: WATCH_SOURCES[key]?.platform || key, state: s.state, category, needs: s.needs || null, access_limit: RESTRICTED[key] || null, limits: s.limits || null,
        last_search: l ? { at: l.at, state: l.state, results: l.matched ?? 0, error: l.error || null } : null, last_scheduled: r ? { at: r.last_run_at, ok_at: r.last_ok_at, status: r.status, error: r.last_error } : null, items_collected: key === "fb_live" ? db.prepare("SELECT COUNT(*) n FROM social_posts WHERE is_training = 0").get().n : items(key) };
    });
    return { sources: out, not_available: UNSUPPORTED, note: "AIVS searches only through each platform's official API and only what the configured access allows. It cannot search all public Facebook posts, personal profiles, private groups or WhatsApp chats." };
  }

  // ---------------------------------------------------------------- run a search
  const insPost = db.prepare(`INSERT INTO watch_posts(platform,post_id,url,account,author_name,text,language,posted_at,first_detected_at,first_source,collected_via,repost_of,quote_of,text_hash,likes,comments,shares,views,image_url,url_key,is_training)
    VALUES (@platform,@post_id,@url,@account,@author_name,@text,@language,@posted_at,@now,@source,@collected_via,@repost_of,@quote_of,@text_hash,@likes,@comments,@shares,@views,@image_url,@url_key,@is_training) ON CONFLICT(platform, post_id) DO NOTHING`);
  function storeRow(source, r, now) {
    const row = { platform: r.platform, post_id: String(r.post_id).slice(0, 500), url: /^https?:\/\//.test(r.url || "") ? r.url : null, account: r.account || null, author_name: r.author_name || null, text: String(r.text).slice(0, 10000), language: r.language || null,
      posted_at: r.posted_at || null, now, source, collected_via: r.collected_via || WATCH_SOURCES[source]?.label || source, repost_of: r.repost_of || null, quote_of: r.quote_of || null, text_hash: sha(normForRepeat(r.text)),
      likes: r.likes ?? null, comments: r.comments ?? null, shares: r.shares ?? null, views: r.views ?? null, image_url: /^https?:\/\//.test(r.image_url || "") ? r.image_url : null, url_key: r.url ? urlKey(r.url) : null,
      is_training: (config.watch?.markTestData ?? !config.isTest) && isTestRecord(r.text, r.url) ? 1 : 0 };
    const isNew = insPost.run(row).changes > 0, post = db.prepare("SELECT * FROM watch_posts WHERE platform = ? AND post_id = ?").get(row.platform, row.post_id);
    if (!isNew && row.image_url && !post.image_url) db.prepare("UPDATE watch_posts SET image_url = ? WHERE id = ?").run(row.image_url, post.id);
    if (!isNew && row.url_key && !post.url_key) db.prepare("UPDATE watch_posts SET url_key = ? WHERE id = ?").run(row.url_key, post.id);
    return { post, isNew };
  }
  function start(user, b = {}) {
    if (b.training) throw new HttpError(400, "Searches use live public sources, so they run in Operational mode only. Switch Records to Operational.");
    const q = parseQuery(b.query), avail = SEARCHABLE.filter(k => WATCH_SOURCES[k]);
    const sources = (Array.isArray(b.sources) && b.sources.length ? b.sources : avail).filter(k => avail.includes(k));
    if (!sources.length) throw new HttpError(400, "Choose at least one source.");
    const from = eatIso(b.from) || new Date(Date.now() - 7 * 864e5).toISOString(), to = eatIso(b.to, true);
    if (to && to < from) throw new HttpError(400, "The end date is before the start date.");
    const max = Math.min(100, Math.max(5, +b.max || 30));
    const feeds = (Array.isArray(b.feeds) ? b.feeds : String(b.feeds || "").split(/[\s,]+/)).map(x => String(x).trim()).filter(x => /^https?:\/\//.test(x)).slice(0, 20);
    const known = contextualLibrary(), contextual = q.terms.map(t => known.get(t.toLowerCase())).filter(Boolean).map(c => ({ ...c, term: q.terms.find(t => t.toLowerCase() === c.term.toLowerCase()) }));
    const def = normaliseDefinition({ terms: q.terms, require_groups: q.require_groups, exclude: q.exclude, contextual, sources: sources.filter(k => k !== "fb_live"), feeds: feeds.length ? feeds : String(config.collect?.rssFeeds || "").split(/[\s,]+/).filter(Boolean).length ? [] : KENYA_NEWS_SITES,
      include_reposts: false, lookback_minutes: Math.min(7 * 1440, Math.max(10, Math.round((Date.now() - Date.parse(from)) / 60e3))) });
    const id = Number(db.prepare("INSERT INTO monitor_searches(query,definition_json,sources_json,period_from,period_to,max_per_source,status,created_by,created_at) VALUES (?,?,?,?,?,?, 'running', ?, ?)")
      .run(String(b.query).trim(), JSON.stringify(def), JSON.stringify(sources), from, to, max, user.id, nowISO()).lastInsertRowid);
    audit(user, "Keyword search started", "monitor_search", String(id), { query: String(b.query).trim(), sources, from, to });
    const job = run(id).catch(e => db.prepare("UPDATE monitor_searches SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String(e.message).slice(0, 500), nowISO(), id));
    running.add(id); job.finally(() => running.delete(id));
    return { id, parsed: q, description: describeQuery(q) };
  }
  async function run(id) {
    const s = db.prepare("SELECT * FROM monitor_searches WHERE id = ?").get(id), def = J(s.definition_json), sources = J(s.sources_json), per = [], now = nowISO();
    const link = db.prepare("INSERT INTO monitor_search_results(search_id,post_id,source,terms_json,is_new,duplicate_of,quality) VALUES (?,?,?,?,?,?,?) ON CONFLICT(search_id, post_id) DO NOTHING");
    const byKey = new Map(), byHash = new Map();
    const record = (source, r, m) => {
      const { post, isNew } = storeRow(source, r, now);
      // a duplicate is the same item found again (same address, or the same text from the same account); the same words from
      // different outlets are kept as separate items and reported as repeated wording
      const hk = `${post.account || ""}|${post.text_hash}`;
      const dupe = (post.url_key && byKey.get(post.url_key)) || (byHash.get(hk) !== post.id ? byHash.get(hk) : null) || null;
      if (post.url_key && !byKey.has(post.url_key)) byKey.set(post.url_key, post.id); if (!byHash.has(hk)) byHash.set(hk, post.id);
      return link.run(id, post.id, source, JSON.stringify(m.terms || []), isNew ? 1 : 0, dupe && dupe !== post.id ? dupe : null, m.engine ? (m.article ? "article" : "engine") : m.ambiguous ? "ambiguous" : m.quality || "confirmed").changes ? { isNew, dupe: !!dupe } : null;
    };
    for (const source of sources) {
      const label = source === "fb_live" ? "Own Facebook Page (live monitoring)" : WATCH_SOURCES[source]?.label || source, item = { source, label, state: "ok", fetched: 0, matched: 0, ambiguous: 0, engine_only: 0, new: 0, duplicates: 0, requests: 0, note: RESTRICTED[source] || null, error: null };
      try {
        if (source === "fb_live") {
          if (!config.live?.pageToken) throw Object.assign(new Error("META_PAGE_ACCESS_TOKEN and META_PAGE_IDS are not set"), { kind: "config" });
          const rows = db.prepare("SELECT p.*, s.name source_name FROM social_posts p JOIN social_sources s ON s.id = p.source_id WHERE p.is_training = 0 AND p.message IS NOT NULL AND (p.created_time IS NULL OR p.created_time >= ?) AND (? IS NULL OR p.created_time <= ?)").all(s.period_from, s.period_to, s.period_to);
          item.fetched = rows.length;
          for (const p of rows) { const m = matchPost(def, { text: p.message }); if (!m.matched) continue; item.matched++;
            const r = record(source, { platform: "Facebook", post_id: p.post_id, url: p.permalink_url, account: p.source_name, text: p.message, posted_at: p.created_time, likes: p.likes, comments: p.comments, shares: p.shares, collected_via: "Own Facebook Page, collected by live monitoring (Meta Graph API)" }, m);
            if (p.image_sha256) db.prepare("UPDATE watch_posts SET image_sha256 = coalesce(image_sha256, ?), image_mime = coalesce(image_mime, ?) WHERE platform = 'Facebook' AND post_id = ?").run(p.image_sha256, p.image_mime, p.post_id);
            if (r) { if (r.isNew) item.new++; if (r.dupe) item.duplicates++; } }
        } else {
          const r = await watchCollector.fetchSource(def, source, { from: s.period_from, to: s.period_to, max: s.max_per_source });
          item.fetched = r.rows.length; item.requests = r.requests; item.note = [RESTRICTED[source], r.note].filter(Boolean).join(" ") || null;
          let kept = 0;
          for (const row of r.rows) {
            if (kept >= s.max_per_source) break;
            let m = matchPost(def, row);
            // a search engine matched the full article or video; AIVS receives only its headline, so exclusions are still applied here
            // (never for contextual keywords alone: without the text there is nothing to tell CDF the military office from CDF the fund)
            const allCtx = def.terms.every(t => (def.contextual || []).some(c => c.term.toLowerCase() === t.toLowerCase()));
            if (!m.matched && !allCtx && ENGINE.has(source) && /none of the watch terms appear/.test(m.why || "") && (!def.require_groups?.length || ["gdelt", "brave_news"].includes(source)) && !(def.exclude.length && matchPost({ terms: def.exclude, exclude: [], context: [], languages: [], include_reposts: true }, row).matched)) m = { matched: true, terms: [], engine: true, article: ["gdelt", "brave_news"].includes(source) };
            if (!m.matched && !m.ambiguous) continue;
            kept++; if (m.engine && !m.article) item.engine_only++; else if (m.ambiguous) item.ambiguous++; else item.matched++; const x = record(source, row, m); if (x) { if (x.isNew) item.new++; if (x.dupe) item.duplicates++; }
          }
        }
      } catch (e) {
        item.state = e.kind === "config" ? (e.state === "disabled" ? "not_configured" : "not_configured") : e.kind === "auth" ? "restricted" : e.kind === "rate" ? "rate_limited" : "failed";
        item.error = String(e.message || e).slice(0, 400);
      }
      per.push(item);
      db.prepare("UPDATE monitor_searches SET per_source_json = ? WHERE id = ?").run(JSON.stringify(per), id);
    }
    // every result gets the rule-based reading straight away
    for (const r of db.prepare("SELECT p.id, p.text FROM monitor_search_results x JOIN watch_posts p ON p.id = x.post_id LEFT JOIN watch_post_analysis a ON a.post_id = p.id WHERE x.search_id = ? AND a.post_id IS NULL").all(id)) analyseStore(r.id, r.text);
    db.prepare("UPDATE monitor_searches SET status = 'done', finished_at = ?, per_source_json = ? WHERE id = ?").run(nowISO(), JSON.stringify(per), id);
    return per;
  }
  function analyseStore(postId, text, { keepAi = true } = {}) {
    const a = analyseItem(text);
    db.prepare("INSERT INTO watch_post_analysis(post_id,analysed_at,method,themes_json,sentiment,sentiment_json,claims_json,entities_json,indicators_json,figures_json) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET analysed_at = excluded.analysed_at, themes_json = excluded.themes_json, sentiment_json = excluded.sentiment_json, claims_json = excluded.claims_json, entities_json = excluded.entities_json, indicators_json = excluded.indicators_json, figures_json = excluded.figures_json")
      .run(postId, nowISO(), a.method, JSON.stringify(a.themes), a.tone?.label || null, JSON.stringify(a.tone), JSON.stringify(a.claims), JSON.stringify({ ...a.entities, hashtags: a.hashtags }), JSON.stringify(a.indicators), JSON.stringify(a.figures));
    return a;
  }
  const analysisOf = r => r.analysed_at ? { themes: J(r.themes_json) || [], tone: J(r.sentiment_json), claims: J(r.claims_json) || [], entities: J(r.entities_json) || {}, indicators: J(r.indicators_json) || [], figures: J(r.figures_json) || [] } : null;
  function verificationOf(r) {
    if (!r.investigation_id) return { status: "not_verified", label: "Not verified yet" };
    if (["queued", "running"].includes(r.inv_status)) return { status: "pending", label: VERIFY_LABELS.pending, investigation_id: r.investigation_id, report_id: r.inv_report_id };
    if (r.inv_status === "failed") return { status: "failed", label: "Verification failed", investigation_id: r.investigation_id, report_id: r.inv_report_id };
    const v = VERDICT_TO_STATUS[r.inv_overall] || "insufficient"; return { status: v, label: VERIFY_LABELS[v], investigation_id: r.investigation_id, report_id: r.inv_report_id, reviewed: !!r.inv_reviewed };
  }
  const itemRow = r => ({ id: r.id, platform: r.platform, source_group: PLATFORM_GROUP(r.platform), source: r.first_source, source_label: WATCH_SOURCES[r.first_source]?.label || r.first_source, account: r.account, text: r.text, url: r.url, posted_at: r.posted_at,
    collected_at: r.first_detected_at, collected_via: r.collected_via, has_image: !!(r.image_url || r.image_sha256), likes: r.likes, comments: r.comments, shares: r.shares, views: r.views,
    matched_terms: J(r.terms_json) || [], engine_match: r.terms_json === "[]" || r.quality === "engine", quality: r.quality || (r.terms_json === "[]" ? "article" : "confirmed"), quality_label: QUALITY_LABEL[r.quality || (r.terms_json === "[]" ? "article" : "confirmed")], disambiguated_by: J(r.context_json) || [],
    ai: r.ai_status ? { status: r.ai_status, attempts: r.ai_attempts, next_at: r.ai_next_at, error: r.ai_error, model: r.ai_model, at: r.ai_at, result: J(r.ai_json) } : null, duplicate_of: r.duplicate_of || null, is_new: r.is_new == null ? null : !!r.is_new, verification: verificationOf(r), analysis: analysisOf(r),
    origin: r.is_training ? "test" : r.first_source === "fb_live" ? "own_page" : r.dataset_id ? "imported" : /demo|training|practice/i.test(r.collected_via || "") ? "test" : "live" });
  const SEL = `SELECT p.*, a.analysed_at, a.themes_json, a.sentiment_json, a.claims_json, a.entities_json, a.indicators_json, a.figures_json, a.ai_status, a.ai_attempts, a.ai_next_at, a.ai_error, a.ai_model, a.ai_at, a.ai_json, i.status inv_status, i.overall inv_overall, i.report_id inv_report_id, i.reviewed_at inv_reviewed`;
  const JOINS = `LEFT JOIN watch_post_analysis a ON a.post_id = p.id LEFT JOIN investigations i ON i.id = p.investigation_id`;
  function filtersSql(f, a) {
    const w = [];
    if (eatIso(f.from)) { w.push("coalesce(p.posted_at, p.first_detected_at) >= @from"); a.from = eatIso(f.from); }
    if (eatIso(f.to, true)) { w.push("coalesce(p.posted_at, p.first_detected_at) <= @to"); a.to = eatIso(f.to, true); }
    const groups = String(f.source || "").split(",").filter(Boolean);
    if (groups.length) { w.push(`(${groups.map((g, i) => { a[`g${i}`] = g; return g === "News" ? "p.platform LIKE 'News%'" : g === "X" ? "p.platform = 'X (Twitter)'" : `p.platform = @g${i}`; }).join(" OR ")})`); }
    if (f.q) { w.push("p.text LIKE @q"); a.q = `%${String(f.q).slice(0, 100).replace(/[%_]/g, "")}%`; }
    if (f.verification === "not_verified") w.push("p.investigation_id IS NULL"); else if (f.verification === "verified") w.push("p.investigation_id IS NOT NULL");
    if (f.images === "1") w.push("(p.image_url IS NOT NULL OR p.image_sha256 IS NOT NULL)");
    if (f.hide_duplicates === "1") w.push("x.duplicate_of IS NULL");
    // the organisation's own Facebook Page is not a monitoring source; test records appear only with the Training records
    w.push(NOT_OWN("p")); w.push("p.is_training = @tr"); a.tr = f.training == 1 || f.training === "1" ? 1 : 0;
    return w;
  }
  function get(id) {
    const s = db.prepare("SELECT s.*, u.display_name created_by_name FROM monitor_searches s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?").get(id); if (!s) throw new HttpError(404, "No such search.");
    const def = J(s.definition_json);
    return { ...s, definition: def, description: describeQuery({ terms: def.terms, require_groups: def.require_groups || [], exclude: def.exclude }), sources: J(s.sources_json), per_source: J(s.per_source_json) || [], definition_json: undefined, sources_json: undefined, per_source_json: undefined,
      results: db.prepare("SELECT COUNT(*) n FROM monitor_search_results WHERE search_id = ?").get(id).n };
  }
  function results(id, f = {}) {
    get(id); const a = { id, limit: Math.min(500, +f.limit || 200), offset: Math.max(0, +f.offset || 0) }, w = ["x.search_id = @id", qualitySql("x.quality", f.quality), ...filtersSql(f, a)];
    const sql = `FROM monitor_search_results x JOIN watch_posts p ON p.id = x.post_id ${JOINS} WHERE ${w.join(" AND ")}`;
    const held = db.prepare(`SELECT coalesce(x.quality,'confirmed') q, COUNT(*) n FROM monitor_search_results x WHERE x.search_id = ? GROUP BY 1`).all(id);
    return { held: Object.fromEntries(held.map(h => [h.q, h.n])), total: db.prepare(`SELECT COUNT(*) n ${sql}`).get(a).n, items: db.prepare(`${SEL}, x.terms_json, x.duplicate_of, x.is_new, x.quality, NULL context_json ${sql} ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT @limit OFFSET @offset`).all(a).map(itemRow),
      by_source: db.prepare(`SELECT p.platform, COUNT(*) n ${sql} GROUP BY p.platform`).all(a) };
  }
  function list(limit = 30) { return db.prepare("SELECT s.id, s.query, s.status, s.created_at, s.finished_at, s.period_from, s.period_to, s.watchlist_id, s.report_id, u.display_name by_name, (SELECT COUNT(*) FROM monitor_search_results r WHERE r.search_id = s.id) results FROM monitor_searches s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC LIMIT ?").all(Math.min(200, +limit || 30)); }
  // everything discovered by keyword: saved watchlists (recurring) and searches
  function feed(f = {}) {
    const a = { limit: Math.min(500, +f.limit || 100), offset: Math.max(0, +f.offset || 0) }, w = filtersSql(f, a);
    const qm = qualitySql("m.quality", f.quality), qx = qualitySql("x.quality", f.quality);
    let scope = `(p.id IN (SELECT m.post_id FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE w.deleted_at IS NULL AND ${qm}) OR p.id IN (SELECT x.post_id FROM monitor_search_results x WHERE ${qx}))`;
    if (+f.watchlist) { scope = `p.id IN (SELECT m.post_id FROM watch_matches m WHERE m.watchlist_id = @wl AND ${qm})`; a.wl = +f.watchlist; }
    if (+f.search) { scope = `p.id IN (SELECT x.post_id FROM monitor_search_results x WHERE x.search_id = @sid AND ${qx})`; a.sid = +f.search; }
    const sql = `FROM watch_posts p ${JOINS} LEFT JOIN monitor_search_results x ON 0 WHERE ${[scope, ...w.filter(c => !c.includes("x.duplicate_of"))].join(" AND ")}`;
    const mq = +f.watchlist ? "m.watchlist_id = @wl" : "1";
    const items = db.prepare(`${SEL}, coalesce((SELECT terms_json FROM watch_matches m WHERE m.post_id = p.id AND ${mq} ORDER BY m.id LIMIT 1), (SELECT terms_json FROM monitor_search_results x WHERE x.post_id = p.id ORDER BY x.search_id DESC LIMIT 1)) terms_json,
      coalesce((SELECT quality FROM watch_matches m WHERE m.post_id = p.id AND ${mq} ORDER BY m.id LIMIT 1), (SELECT quality FROM monitor_search_results x WHERE x.post_id = p.id ORDER BY x.search_id DESC LIMIT 1)) quality,
      (SELECT context_json FROM watch_matches m WHERE m.post_id = p.id AND ${mq} ORDER BY m.id LIMIT 1) context_json, NULL duplicate_of, NULL is_new ${sql} ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT @limit OFFSET @offset`).all(a).map(itemRow);
    for (const it of items) it.watchlists = db.prepare("SELECT w.id, w.name, coalesce(m.quality,'confirmed') quality FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE m.post_id = ? AND w.deleted_at IS NULL").all(it.id);
    return { total: db.prepare(`SELECT COUNT(*) n ${sql}`).get(a).n, items, by_source: db.prepare(`SELECT p.platform, COUNT(*) n ${sql} GROUP BY p.platform`).all(a) };
  }
  function item(id) {
    const r = db.prepare(`${SEL}, (SELECT terms_json FROM watch_matches m WHERE m.post_id = p.id ORDER BY m.id LIMIT 1) terms_json, (SELECT quality FROM watch_matches m WHERE m.post_id = p.id ORDER BY m.id LIMIT 1) quality, (SELECT context_json FROM watch_matches m WHERE m.post_id = p.id ORDER BY m.id LIMIT 1) context_json, NULL duplicate_of, NULL is_new FROM watch_posts p ${JOINS} WHERE p.id = ?`).get(id); if (!r) throw new HttpError(404, "No such item.");
    const it = itemRow(r);
    it.watchlists = db.prepare("SELECT w.id, w.name, m.terms_json, coalesce(m.quality,'confirmed') quality, m.context_json FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE m.post_id = ?").all(id).map(m => ({ ...m, terms: J(m.terms_json), terms_json: undefined }));
    it.searches = db.prepare("SELECT s.id, s.query, x.terms_json FROM monitor_search_results x JOIN monitor_searches s ON s.id = x.search_id WHERE x.post_id = ? ORDER BY s.id DESC LIMIT 10").all(id).map(m => ({ ...m, terms: J(m.terms_json), terms_json: undefined }));
    if (!it.analysis) it.analysis = analyseStore(id, r.text);
    return it;
  }
  async function image(id) {
    const p = db.prepare("SELECT id, image_url, image_sha256, image_mime FROM watch_posts WHERE id = ?").get(id); if (!p) throw new HttpError(404, "No such item.");
    if (!p.image_sha256) {
      if (!p.image_url) throw new HttpError(404, "This item has no image.");
      const g = await fetchImage(p.image_url, { allowPrivate: !!config.allowPrivateFetch }), s = await storage.putBuffer(g.raw, g.mime);
      db.prepare("UPDATE watch_posts SET image_sha256 = ?, image_mime = ? WHERE id = ?").run(s.sha256, g.mime, p.id); return { buf: g.raw, mime: g.mime };
    }
    return { buf: storage.read(p.image_sha256), mime: p.image_mime || "image/jpeg" };
  }

  // ---------------------------------------------------------------- verification of one item (the automatic investigation)
  function verify(user, id) {
    const p = db.prepare("SELECT * FROM watch_posts WHERE id = ?").get(id); if (!p) throw new HttpError(404, "No such item.");
    if (p.investigation_id) { const i = db.prepare("SELECT status FROM investigations WHERE id = ?").get(p.investigation_id); if (i && i.status !== "failed") return { investigation_id: p.investigation_id, already: true }; }
    let inv;
    // a news article is read from its own page (full text and images); a social post is analysed from the text the platform API returned
    if (/^News/.test(p.platform) && p.url) inv = investigations.start(user, { url: p.url, origin: "monitor" });
    else {
      const files = [];
      if (p.image_sha256) { const tmp = path.join(storage.tmpDir, `mon-${p.id}-${Date.now()}.${p.image_mime === "image/png" ? "png" : "jpg"}`); fs.writeFileSync(tmp, storage.read(p.image_sha256)); files.push({ originalname: path.basename(tmp), size: fs.statSync(tmp).size, path: tmp }); }
      inv = investigations.start(user, { text: p.text, files, origin: "monitor", prefetched: { platform: p.platform.replace(/ \(.*\)$/, ""), url: p.url, account: p.account, publisher: p.account, author_basis: `the account that published it (${p.collected_via})`,
        published_at: p.posted_at, published_basis: p.posted_at ? `publication time from ${p.collected_via}` : null, method: p.collected_via, notes: [] } });
    }
    db.prepare("UPDATE watch_posts SET investigation_id = ? WHERE id = ?").run(inv.id, p.id);
    audit(user, "Discovered item sent for verification", "watch_post", String(p.id), { investigation: inv.id, url: p.url });
    return { investigation_id: inv.id, report_id: inv.report_id };
  }

  // ---------------------------------------------------------------- analysis of a set and the draft report
  function scopeItems({ searchId = null, watchlistId = null, from = null, to = null, limit = 150 }) {
    let rows;
    const base = `${SEL}, NULL terms_json, NULL duplicate_of, NULL is_new FROM watch_posts p ${JOINS}`;
    if (searchId) rows = db.prepare(`${base} WHERE p.id IN (SELECT post_id FROM monitor_search_results x WHERE x.search_id = ? AND x.duplicate_of IS NULL AND ${GOOD("x.quality")}) AND ${NOT_OWN("p")} AND p.is_training = 0 ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT ?`).all(searchId, limit);
    else rows = db.prepare(`${base} WHERE p.id IN (SELECT post_id FROM watch_matches m WHERE m.watchlist_id = ? AND ${GOOD("m.quality")}) AND ${NOT_OWN("p")} AND p.is_training = 0 AND coalesce(p.posted_at, p.first_detected_at) >= ? AND coalesce(p.posted_at, p.first_detected_at) <= ? ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT ?`).all(watchlistId, from, to, limit);
    return rows.map((r, i) => { const it = itemRow(r); if (!it.analysis) it.analysis = analyseStore(r.id, r.text); return { ...it, n: i + 1 }; });
  }
  async function report(user, { searchId = null, watchlistId = null, hours = 24, origin = "analyst" } = {}) {
    let subject, from, to, perSource = [];
    if (searchId) { const s = get(searchId); if (s.status === "running") throw new HttpError(409, "The search is still running."); subject = s.description; from = s.period_from; to = s.period_to || nowISO(); perSource = s.per_source; }
    else { const wl = watch.get(watchlistId); subject = `${wl.name}: ${describeQuery({ terms: wl.definition.terms, require_groups: wl.definition.require_groups || [], exclude: wl.definition.exclude })}`; to = nowISO(); from = new Date(Date.now() - hours * 3600e3).toISOString(); }
    const items = scopeItems({ searchId, watchlistId, from, to });
    const sit = situation(items, { query: subject, from, to, perSource });
    const ymd = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
    const n = db.prepare("INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get(`mon-${ymd}`).value, reference = `AIVS-M-${ymd}-${String(n).padStart(3, "0")}`;
    let a = draftReport(sit, items, { reference, subject, version });
    // the organisation's AI model (Ollama) may rewrite the four sections from the same facts; the result is checked
    const notes = [];
    const ready = investigations.aiReady ? await investigations.aiReady(user, false).catch(e => ({ ok: false, reason: e.message })) : { ok: false, reason: "not available" };
    if (ready.ok && items.length) {
      try {
        const facts = { subject, period: [from, to], items: items.slice(0, 25).map(i => ({ n: i.n, source: `${i.platform} ${i.account || ""}`.trim(), date: i.posted_at, text: i.text.slice(0, 300) })), narratives: sit.narratives.map(x => ({ label: x.label, items: x.items.length, emerging: x.emerging })),
          repeated: sit.repeated.length, contradictions: sit.contradictions.map(c => c.detail), gaps: sit.gaps, indicators: sit.indicators.length, references: a.references.map(r => ({ n: r.n, publisher: r.publisher, title: r.title })), evidence_strength: a.strength };
        const out = await investigations.askJson(user, null, "monitoring report drafting", aiPrompt(a, facts));
        const chk = checkAiSections(out, a, { hasAmplification: false, nRefs: a.references.length });
        if (chk.removed.length) notes.push(`AI text not used for: ${chk.removed.join("; ")}`);
        a = { ...chk, removed: undefined }; if (a.written_by === "ai") a.ai_model = ready.model;
      } catch (e) { notes.push(`AI drafting was not used (${e.message}); rule-based text applied.`); }
    } else notes.push(`AI drafting was not used: ${String(ready.reason || "no items").replace(/\.+$/, "")}.`);
    a.ai_notes = notes;
    const id = Number(db.prepare("INSERT INTO monitor_reports(report_id,period_from,period_to,created_at,created_by,origin,search_id,watchlist_id,situation_json,report_json,written_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(reference, from, to, nowISO(), user?.id ?? null, origin, searchId, watchlistId, JSON.stringify({ ...sit, items: items.map(i => ({ n: i.n, id: i.id, platform: i.platform, account: i.account, url: i.url, posted_at: i.posted_at, text: i.text.slice(0, 300) })) }), JSON.stringify(a), a.written_by).lastInsertRowid);
    if (searchId) db.prepare("UPDATE monitor_searches SET report_id = ? WHERE id = ?").run(id, searchId);
    audit(user, "Monitoring report drafted", "monitor_report", reference, { search: searchId, watchlist: watchlistId, items: items.length, written_by: a.written_by });
    // findings that need attention become live alerts (recurring watchlists only; an ad-hoc search is looked at by the analyst who ran it)
    if (watchlistId && live) {
      for (const c of sit.contradictions.slice(0, 3)) live.raise({ kind: "contradiction", key: `contra:${watchlistId}:${items[c.items[0] - 1].id}:${items[c.items[1] - 1].id}`, group: `watchlist:${watchlistId}`, priority: "medium", priorityReasons: [c.detail],
        title: `Conflicting reports about ${c.about.join(", ")}`, reason: "Two discovered items disagree. Check both against an authoritative source before relying on either.", detail: { report: reference, items: c.items.map(k => items[k - 1].id), watch_posts: true } });
      for (const nv of sit.narratives.filter(x => x.emerging).slice(0, 3)) live.raise({ kind: "narrative", key: `narr:${watchlistId}:${nv.label}:${new Date().toISOString().slice(0, 10)}`, group: `watchlist:${watchlistId}`, priority: nv.sources >= 3 ? "medium" : "low",
        priorityReasons: [`${nv.items.length} items from ${nv.sources} sources, mostly in the last 24 hours`], title: `Emerging narrative: ${nv.label}`, reason: "A group of related items is appearing quickly. This is an observation about public content, not a finding about who is behind it.", detail: { report: reference, items: nv.items.map(k => items[k - 1].id), watch_posts: true } });
    }
    return reportGet(id);
  }
  function reportGet(id) { const r = db.prepare("SELECT * FROM monitor_reports WHERE id = ? OR report_id = ?").get(id, id); if (!r) throw new HttpError(404, "No such report."); return { id: r.id, report_id: r.report_id, created_at: r.created_at, origin: r.origin, search_id: r.search_id, watchlist_id: r.watchlist_id, written_by: r.written_by, reviewed_at: r.reviewed_at, approved_at: r.approved_at, report: J(r.report_json), situation: J(r.situation_json) }; }
  function reports(limit = 50) { return db.prepare("SELECT r.id, r.report_id, r.created_at, r.origin, r.search_id, r.watchlist_id, r.written_by, r.reviewed_at, r.approved_at, s.query, w.name watchlist, coalesce(ap.status, 'draft') approval_status, ap.approval_ref FROM monitor_reports r LEFT JOIN monitor_searches s ON s.id = r.search_id LEFT JOIN watchlists w ON w.id = r.watchlist_id LEFT JOIN report_approvals ap ON ap.kind = 'monitor_report' AND ap.ref_id = CAST(r.id AS TEXT) WHERE r.is_training = 0 ORDER BY r.id DESC LIMIT ?").all(Math.min(200, +limit || 50)); }
  // ---------------------------------------------------------------- Head of Department approval of monitoring reports (1.32)
  const withApproval = r => { const a = r.report; if (!approvals) return a; const ap = approvals.info("monitor_report", r.id, a); return applyApproval(a, ap.approved ? ap : { ...ap, label: [ap.label, r.reviewed_at ? "reviewed" : null].filter(Boolean).join("; ") }); };
  function approvalState(id) { const r = reportGet(id); return { ...approvals.state("monitor_report", r.id), hods: approvals.hods([ownerOf(r.id)]).map(u => ({ id: u.id, name: u.display_name, designation: u.designation })) }; }
  const ownerOf = id => db.prepare("SELECT created_by FROM monitor_reports WHERE id = ?").get(id)?.created_by ?? null;
  function submitReport(user, id, { hod_id, note }) { const r = reportGet(id); return approvals.submit(user, "monitor_report", r.id, r.report, { reportRef: r.report_id, createdBy: ownerOf(r.id), hodId: hod_id, note }); }
  async function decideReport(user, id, b) { const r = reportGet(id); return approvals.decide(user, "monitor_report", r.id, r.report, b, async ap => (await assessmentPdf(applyApproval(r.report, ap))).buf, { createdBy: ownerOf(r.id) }); }
  function editAssessment(user, id, b = {}) {
    const r = reportGet(id), a = r.report, out = {};
    if (approvals.state("monitor_report", r.id).status === "rejected") throw new HttpError(409, "A rejected report cannot be revised; draft a new report.");
    for (const k of ["background", "analysis", "assessment"]) { const t = String(b[k] ?? a[k]).replace(/\s+/g, " ").trim(); if (words(t) < 10 || words(t) > 220) throw new HttpError(400, `${k}: keep it between 10 and 220 words.`); out[k] = t; }
    const recs = (Array.isArray(b.recommendations) ? b.recommendations : a.recommendations).map(x => String(x).replace(/\s+/g, " ").trim()).filter(Boolean);
    if (recs.length < 3 || recs.length > 5) throw new HttpError(400, "Give 3 to 5 recommendations.");
    for (const [i, x] of recs.entries()) { const why = validRecommendation(x); if (why) throw new HttpError(400, `Recommendation ${i + 1} ${why}.`); }
    const next = { ...a, ...out, recommendations: recs, written_by: "analyst", edited_by: user.display_name, edited_at: nowISO() };
    db.prepare("UPDATE monitor_reports SET report_json = ? WHERE id = ?").run(JSON.stringify(next), r.id);
    audit(user, "Monitoring report revised by the analyst", "monitor_report", r.report_id, {});
    approvals.ensure("monitor_report", r.id, r.report_id, ownerOf(r.id));
    return approvals.changed(user, "monitor_report", r.id, next, "revised by the analyst");
  }
  async function reportFile(id, fmt) {
    const r = reportGet(id), a = withApproval(r);
    if (fmt === "html") return { body: assessmentHtml(a), type: "text/html; charset=utf-8", name: `${r.report_id}.html` };
    if (fmt === "pdf") { const fin = a.approval && approvals.finalPdf("monitor_report", r.id, r.report); return fin ? { body: fin, type: "application/pdf", name: `${r.report_id}-approved.pdf` } : { body: (await assessmentPdf(a)).buf, type: "application/pdf", name: `${r.report_id}-draft.pdf` }; }
    if (fmt === "docx") return { body: docxFromBody(assessmentDocxXml(a)), type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: `${r.report_id}.docx` };
    return { body: JSON.stringify(r, null, 2), type: "application/json", name: `${r.report_id}.json` };
  }
  function reviewReport(user, id, note) {
    const r = db.prepare("SELECT * FROM monitor_reports WHERE id = ?").get(id); if (!r) throw new HttpError(404, "No such report.");
    if (r.created_by === user.id) throw new HttpError(403, "Another person must review a report you generated.");
    if (r.reviewed_at) throw new HttpError(409, "Already reviewed.");
    if (!String(note || "").trim()) throw new HttpError(400, "Say briefly what you checked.");
    const a = J(r.report_json); a.header.status = `Reviewed by ${user.display_name} on ${eatStamp(nowISO(), false)}`; a.report_status = a.report_status.replace("not reviewed or approved by a person", `reviewed by ${user.display_name}; not approved`);
    db.prepare("UPDATE monitor_reports SET reviewed_by = ?, reviewed_at = ?, review_note = ?, report_json = ? WHERE id = ?").run(user.id, nowISO(), String(note).trim().slice(0, 1000), JSON.stringify(a), r.id);
    audit(user, "Monitoring report reviewed", "monitor_report", r.report_id, { note });
    return reportGet(r.id);
  }

  // ---------------------------------------------------------------- save a search as a recurring watchlist
  function saveAsWatchlist(user, id, b = {}) {
    const s = get(id), name = String(b.name || s.query).trim().slice(0, 120);
    const def = normaliseDefinition({ ...s.definition, sources: s.sources.filter(k => k !== "fb_live" && WATCH_SOURCES[k]?.mode === "poll").concat(s.sources.includes("fb_live") ? ["fb_live"] : []), alert_mode: b.alert_mode === "every_post" ? "every_post" : "threshold",
      intervals: b.interval ? Object.fromEntries(Object.keys(WATCH_SOURCES).map(k => [k, +b.interval])) : undefined, lookback_minutes: 1440 });
    const wid = watch.create(user, { name, description: `Saved from keyword search ${id}: ${s.description}`, definition: def, authorisation: String(b.authorisation || "").trim() || "Public content through each platform's official API, under the platform's terms and the organisation's monitoring policy." });
    // the search itself is the preview of what this watchlist finds
    watch.recordPreview(user, wid, { local: { matched: s.results }, live: s.per_source.map(p => ({ source: p.source, fetched: p.fetched, matched: p.matched, error: p.error })), from_search: id });
    let status = "draft";
    if (b.activate !== false) { try { watch.setStatus(user, wid, "active", k => k === "fb_live" ? !!config.live?.pageToken : watchCollector.sourcesReady(k)); status = "active"; } catch (e) { status = `draft (${e.message})`; } }
    // the results already found count as this watchlist's first matches
    for (const r of db.prepare("SELECT post_id, source, terms_json, quality FROM monitor_search_results WHERE search_id = ?").all(id))
      db.prepare("INSERT INTO watch_matches(watchlist_id,post_id,detected_at,source,terms_json,context_json,definition_sha256,cluster,is_repost,quality) SELECT ?, ?, ?, ?, ?, '[]', definition_sha256, NULL, 0, ? FROM watchlists WHERE id = ? AND NOT EXISTS (SELECT 1 FROM watch_matches WHERE watchlist_id = ? AND post_id = ?)")
        .run(wid, r.post_id, nowISO(), r.source, r.terms_json, r.quality || "confirmed", wid, wid, r.post_id);
    db.prepare("UPDATE monitor_searches SET watchlist_id = ? WHERE id = ?").run(wid, id);
    return { watchlist_id: wid, status };
  }

  // ---------------------------------------------------------------- daily draft report for each active watchlist (automatic)
  let lastDaily = null;
  async function daily(user, hour = 7) {
    const eat = new Date(Date.now() + 3 * 3600e3), day = eat.toISOString().slice(0, 10);
    if (eat.getUTCHours() < hour || lastDaily === day || db.prepare("SELECT 1 FROM monitor_reports WHERE origin = 'daily' AND created_at >= ?").get(new Date(`${day}T00:00:00+03:00`).toISOString())) return 0;
    lastDaily = day; let n = 0;
    for (const w of db.prepare("SELECT id FROM watchlists WHERE status = 'active' AND deleted_at IS NULL").all()) {
      const c = db.prepare(`SELECT COUNT(*) n FROM watch_matches m WHERE m.watchlist_id = ? AND ${GOOD("m.quality")} AND m.detected_at >= ?`).get(w.id, new Date(Date.now() - 864e5).toISOString()).n;
      if (!c) continue; try { await report(user, { watchlistId: w.id, hours: 24, origin: "daily" }); n++; } catch (e) { console.warn("[monitor] daily report:", e.message); }
    }
    return n;
  }
  function overview(f = {}) {
    const tr = f.training == 1 || f.training === "1" ? 1 : 0;
    const n = (sql, ...a) => db.prepare(sql).get(...a).n, today = new Date(`${new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)}T00:00:00+03:00`).toISOString();
    const scope = `${NOT_OWN("p")} AND p.is_training = ${tr} AND (p.id IN (SELECT m.post_id FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE w.deleted_at IS NULL AND ${GOOD("m.quality")}) OR p.id IN (SELECT x.post_id FROM monitor_search_results x WHERE ${GOOD("x.quality")}))`;
    const src = sources().sources, cat = {}; for (const x of src) cat[x.category] = (cat[x.category] || 0) + 1;
    return { counts: { items: n(`SELECT COUNT(*) n FROM watch_posts p WHERE ${scope}`), items_today: n(`SELECT COUNT(*) n FROM watch_posts p WHERE ${scope} AND p.first_detected_at >= ?`, today),
        verified: n(`SELECT COUNT(*) n FROM watch_posts p WHERE ${scope} AND p.investigation_id IS NOT NULL`), searches: n("SELECT COUNT(*) n FROM monitor_searches"),
        active_watchlists: n("SELECT COUNT(*) n FROM watchlists WHERE status = 'active' AND deleted_at IS NULL"), reports: n("SELECT COUNT(*) n FROM monitor_reports"),
        new_alerts: n("SELECT COUNT(*) n FROM watch_alerts a JOIN watchlists w ON w.id = a.watchlist_id WHERE a.status = 'new' AND w.deleted_at IS NULL AND a.is_training = ?", tr) + n("SELECT COUNT(*) n FROM live_alerts WHERE status = 'new' AND is_training = ? AND group_key LIKE 'watchlist:%'", tr),
        ai_indicator: aiIndicator(), ambiguous: n(`SELECT COUNT(*) n FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id JOIN watch_posts p ON p.id = m.post_id WHERE w.deleted_at IS NULL AND m.quality = 'ambiguous' AND p.is_training = ? AND ${NOT_OWN("p")}`, tr), ai: aiQueueCounts() },
      by_category: cat, connected: src.filter(x => x.category === "Connected").map(x => x.platform), sources: src,
      by_platform: db.prepare(`SELECT p.platform, COUNT(*) n, MAX(p.first_detected_at) last FROM watch_posts p WHERE ${scope} GROUP BY p.platform ORDER BY n DESC`).all(),
      recent: feed({ limit: 8, training: tr }).items, searches: list(5) };
  }
  // ---------------------------------------------------------------- which matches are shown
  function qualitySql(col, q) {
    if (q === "ambiguous") return `${col} = 'ambiguous'`;
    if (q === "engine") return `coalesce(${col},'confirmed') IN ('confirmed','contextual','analyst','article','engine')`;
    if (q === "all") return `coalesce(${col},'confirmed') <> 'rejected'`;
    return GOOD(col);
  }
  // contextual keywords configured in any watchlist also apply to an ad-hoc search for the same keyword
  function contextualLibrary() {
    const m = new Map();
    for (const w of db.prepare("SELECT definition_json FROM watchlists WHERE deleted_at IS NULL ORDER BY (status = 'active') DESC, id").all())
      for (const c of J(w.definition_json)?.contextual || []) if (!m.has(c.term.toLowerCase())) m.set(c.term.toLowerCase(), c);
    return m;
  }

  // ---------------------------------------------------------------- AI analysis queue (the organisation's Ollama server)
  // Collected items are stored whatever the AI's state. Each genuine (or ambiguous) watchlist match waits in this queue until the
  // AI server answers its health check; then a few items a minute are analysed. A connection failure leaves the item waiting
  // without counting as an attempt; any other failure is retried with growing pauses and given up after 6 attempts.
  const AIQ = { perTick: Math.max(1, +(config.monitorAi?.perTick ?? process.env.MONITOR_AI_ITEMS_PER_MINUTE ?? 4)), maxAttempts: 6, days: Math.max(1, +(process.env.MONITOR_AI_DAYS ?? 7)) };
  let aiState = { state: "idle", at: null, reason: null };
  function aiQueueCounts() {
    const r = Object.fromEntries(db.prepare("SELECT ai_status s, COUNT(*) n FROM watch_post_analysis WHERE ai_status IS NOT NULL GROUP BY ai_status").all().map(x => [x.s, x.n]));
    return { pending: r.pending || 0, done: r.done || 0, failed: r.failed || 0, state: aiState.state, reason: aiState.reason, checked_at: aiState.at };
  }
  function enqueueAi() {
    const since = new Date(Date.now() - AIQ.days * 864e5).toISOString(), now = nowISO();
    const ids = db.prepare(`SELECT DISTINCT p.id, p.text FROM watch_posts p JOIN watch_matches m ON m.post_id = p.id JOIN watchlists w ON w.id = m.watchlist_id LEFT JOIN watch_post_analysis a ON a.post_id = p.id
      WHERE w.deleted_at IS NULL AND coalesce(m.quality,'confirmed') IN ('confirmed','contextual','analyst','ambiguous') AND ${NOT_OWN("p")} AND p.is_training = 0 AND m.detected_at >= ? AND (a.post_id IS NULL OR a.ai_status IS NULL) LIMIT 500`).all(since);
    for (const r of ids) { analyseStore(r.id, r.text, { keepAi: true }); db.prepare("UPDATE watch_post_analysis SET ai_status = 'pending', ai_queued_at = ?, ai_next_at = ? WHERE post_id = ? AND ai_status IS NULL").run(now, now, r.id); }
    return ids.length;
  }
  const quoteIn = (q, text) => { const n = x => String(x || "").toLowerCase().replace(/\s+/g, " ").trim(); return n(q).length >= 8 && n(text).includes(n(q)); };
  async function analyseOneAi(user, post, model) {
    const wls = db.prepare("SELECT w.name, w.definition_json, coalesce(m.quality,'confirmed') quality, m.terms_json FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE m.post_id = ? AND w.deleted_at IS NULL").all(post.id);
    const subject = wls.map(w => `${w.name} (keywords found: ${(J(w.terms_json) || []).join(", ") || "none"})`).join("; ");
    const prompt = `A monitoring watchlist collected the public item below because it contains these keywords: ${subject}.\nItem (${post.platform}, ${post.account || "source not named"}, published ${post.posted_at || "date not given"}):\n<content>\n${String(post.text).slice(0, 4000)}\n</content>\n\nUsing ONLY the words of the item:\n1. Does the item concern the subject of the watchlist (for the Kenya Defence Forces: Kenya's military, its services, commanders or operations)? Some keywords are ambiguous (CDF can mean Chief of Defence Forces or Constituency Development Fund). Answer yes, no or unclear and give the reason.\n2. Summarise the item in one or two sentences without adding facts.\n3. List up to 5 factual claims, each with the exact words of the item that state it ("quote", copied exactly).\n4. Give the main themes (up to 4 short labels) and the tone towards the subject: positive, negative, neutral or mixed.\n5. List signs of possible misinformation that are visible in the text itself (unsourced figures, calls to share, emotional framing); an empty list if none.\n6. Judge how credible the item is from what it shows (named sources, attribution, an established outlet, specific verifiable details): high, medium or low, and say why. Then say how uncertain this reading is (low, medium or high uncertainty) and what would reduce the uncertainty.\nJSON: {"about_subject": "yes|no|unclear", "about_reason": "...", "summary": "...", "claims": [{"text": "...", "quote": "..."}], "themes": ["..."], "tone": "positive|negative|neutral|mixed", "indicators": ["..."], "credibility": "high|medium|low", "credibility_reason": "...", "uncertainty": "low|medium|high", "uncertainty_reason": "..."}`;
    const out = await investigations.askJson(user, null, "monitoring item analysis", prompt);
    const claims = (Array.isArray(out.claims) ? out.claims : []).filter(c => c && quoteIn(c.quote, post.text)).slice(0, 5).map(c => ({ text: String(c.text || c.quote).slice(0, 300), quote: String(c.quote).slice(0, 300) }));
    return { about_subject: ["yes", "no", "unclear"].includes(out.about_subject) ? out.about_subject : "unclear", about_reason: String(out.about_reason || "").slice(0, 400), summary: String(out.summary || "").slice(0, 600),
      claims, claims_dropped: (Array.isArray(out.claims) ? out.claims.length : 0) - claims.length, themes: (Array.isArray(out.themes) ? out.themes : []).map(String).slice(0, 4), tone: ["positive", "negative", "neutral", "mixed"].includes(out.tone) ? out.tone : null,
      indicators: (Array.isArray(out.indicators) ? out.indicators : []).map(String).slice(0, 5), model,
      credibility: ["high", "medium", "low"].includes(out.credibility) ? out.credibility : null, credibility_reason: String(out.credibility_reason || "").slice(0, 400),
      uncertainty: ["low", "medium", "high"].includes(out.uncertainty) ? out.uncertainty : "high", uncertainty_reason: String(out.uncertainty_reason || "").slice(0, 400), note: "AI-supported reading of the item's own words; not a verification. A person decides." };
  }
  let aiBusy = false;
  async function aiTick() {
    if (aiBusy) return { busy: true }; aiBusy = true;
    try {
      const queued = enqueueAi(), user = live?.systemUser ? live.systemUser() : null;
      const ready = user && investigations.aiReady ? await investigations.aiReady(user, false).catch(e => ({ ok: false, reason: e.message })) : { ok: false, reason: "AI is not available to the monitor" };
      aiState = { state: ready.ok ? "running" : "waiting", at: nowISO(), reason: ready.ok ? null : String(ready.reason || "").slice(0, 400) };
      if (!ready.ok) return { queued, analysed: 0, waiting: true, reason: ready.reason };
      const due = db.prepare(`SELECT p.*, a.ai_attempts FROM watch_post_analysis a JOIN watch_posts p ON p.id = a.post_id WHERE a.ai_status = 'pending' AND (a.ai_next_at IS NULL OR a.ai_next_at <= ?) ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT ?`).all(nowISO(), AIQ.perTick);
      let analysed = 0;
      for (const p of due) {
        try {
          const r = await analyseOneAi(user, p, ready.model);
          db.prepare("UPDATE watch_post_analysis SET ai_json = ?, ai_status = 'done', ai_model = ?, ai_at = ?, ai_error = NULL, ai_attempts = ai_attempts + 1 WHERE post_id = ?").run(JSON.stringify(r), ready.model, nowISO(), p.id); analysed++;
          afterAnalysis(user, p, r);
        } catch (e) {
          const net = /cannot be reached|did not answer|refused the connection|Could not connect|fetch failed|ETIMEDOUT|ECONNRE|UND_ERR/i.test(e.message);
          if (net) { aiState = { state: "waiting", at: nowISO(), reason: e.message.slice(0, 400) }; db.prepare("UPDATE watch_post_analysis SET ai_error = ? WHERE post_id = ?").run(`waiting for the AI server: ${e.message}`.slice(0, 400), p.id); break; }
          const n = (p.ai_attempts || 0) + 1;
          db.prepare("UPDATE watch_post_analysis SET ai_attempts = ?, ai_error = ?, ai_status = ?, ai_next_at = ? WHERE post_id = ?").run(n, e.message.slice(0, 400), n >= AIQ.maxAttempts ? "failed" : "pending", new Date(Date.now() + Math.min(6 * 3600e3, 60e3 * 2 ** n)).toISOString(), p.id);
        }
      }
      const verified = autoVerify(user), followed = verificationAlerts(), reports = await autoReports(user);
      return { queued, analysed, verified, verification_alerts: followed, reports };
    } finally { aiBusy = false; }
  }
  // ---- what follows the AI reading of each genuine item (1.29): explainable alerts, evidence search, reports. Nothing is invented:
  // an alert says which words of the item and which AI judgement raised it, and a person decides.
  const AUTO = { verifyPerHour: Math.max(0, +(process.env.MONITOR_AUTO_VERIFY_PER_HOUR ?? config.monitorAi?.verifyPerHour ?? 6)), reportMinItems: Math.max(1, +(process.env.MONITOR_AUTO_REPORT_MIN_ITEMS ?? 5)), reportEveryH: Math.max(1, +(process.env.MONITOR_AUTO_REPORT_HOURS ?? 6)) };
  const wlsOf = postId => db.prepare("SELECT w.id, w.name, coalesce(m.quality,'confirmed') quality FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE m.post_id = ? AND w.deleted_at IS NULL AND w.status = 'active'").all(postId);
  function afterAnalysis(user, post, r) {
    if (!live?.raise || post.is_training) return;
    const genuine = wlsOf(post.id).filter(w => ["confirmed", "contextual", "analyst", "article"].includes(w.quality));
    if (!genuine.length || r.about_subject === "no") return;
    const why = [r.indicators.length ? `signs of possible misinformation in the text: ${r.indicators.join("; ")}` : null, r.credibility === "low" ? `low credibility: ${r.credibility_reason || "no reason given"}` : null].filter(Boolean);
    if (!why.length) return;
    for (const w of genuine) live.raise({ kind: "ai_assessment", key: `aia:${w.id}:${post.id}`, group: `watchlist:${w.id}`, isTraining: 0, priority: r.indicators.length >= 2 && r.credibility === "low" ? "medium" : "low",
      priorityReasons: why, title: `Check before relying on it: ${post.text.replace(/\s+/g, " ").slice(0, 120)}`,
      reason: `The AI reading of this ${post.platform} item (${r.model || "AI"}) found ${why.join("; ")}. Uncertainty: ${r.uncertainty}${r.uncertainty_reason ? ` (${r.uncertainty_reason})` : ""}. This is an AI-supported lead, not a finding; verify the item before use.`,
      detail: { watch_post: post.id, url: post.url, watchlist: w.id, ai: { credibility: r.credibility, uncertainty: r.uncertainty, indicators: r.indicators }, watch_posts: true } });
  }
  // supporting and contradicting evidence: the automatic investigation of Verify Information, for genuine items the AI read as
  // being about the subject, within an hourly limit (each one searches the evidence sources)
  function autoVerify(user) {
    if (!AUTO.verifyPerHour) return 0;
    const done = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'Discovered item sent for verification' AND at >= ? AND user_id = ?").get(new Date(Date.now() - 3600e3).toISOString(), user.id)?.n || 0;
    const room = Math.max(0, AUTO.verifyPerHour - done); if (!room) return 0;
    const due = db.prepare(`SELECT p.id FROM watch_posts p JOIN watch_post_analysis a ON a.post_id = p.id WHERE a.ai_status = 'done' AND p.investigation_id IS NULL AND p.is_training = 0 AND ${NOT_OWN("p")}
      AND json_extract(a.ai_json, '$.about_subject') <> 'no' AND EXISTS (SELECT 1 FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE m.post_id = p.id AND w.status = 'active' AND w.deleted_at IS NULL AND ${GOOD("m.quality")})
      ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT ?`).all(room);
    let n = 0; for (const d of due) { try { verify(user, d.id); n++; } catch (e) { console.warn("[monitor] automatic verification:", e.message); } }
    return n;
  }
  // a finished verification that contradicts the item, or finds it misleading, becomes an explainable alert once
  function verificationAlerts() {
    if (!live?.raise) return 0; let n = 0;
    for (const r of db.prepare(`SELECT p.id, p.text, p.platform, p.url, i.overall, i.report_id, i.id inv FROM watch_posts p JOIN investigations i ON i.id = p.investigation_id WHERE i.status = 'done' AND i.overall IN ('contradicted','misleading') AND p.is_training = 0 AND i.completed_at >= ?`).all(new Date(Date.now() - 2 * 864e5).toISOString()))
      for (const w of wlsOf(r.id)) n += live.raise({ kind: "verification", key: `ver:${w.id}:${r.id}`, group: `watchlist:${w.id}`, isTraining: 0, priority: "medium", priorityReasons: [`the automatic verification found the item ${VERIFY_LABELS[VERDICT_TO_STATUS[r.overall]].toLowerCase()}`],
        title: `${VERIFY_LABELS[VERDICT_TO_STATUS[r.overall]]}: ${r.text.replace(/\s+/g, " ").slice(0, 120)}`, reason: `Report ${r.report_id} compared the item's claims with the evidence found and rated it ${VERIFY_LABELS[VERDICT_TO_STATUS[r.overall]].toLowerCase()}. Read the report's evidence before acting; a person decides.`,
        detail: { watch_post: r.id, url: r.url, report_id: r.report_id, investigation: r.inv, watch_posts: true } });
    return n;
  }
  // a draft report (Background, Analysis, Assessment, Recommendations) for each active watchlist once enough new genuine items have
  // been analysed since its last report
  async function autoReports(user) {
    let n = 0;
    for (const w of db.prepare("SELECT id FROM watchlists WHERE status = 'active' AND deleted_at IS NULL").all()) {
      const last = db.prepare("SELECT MAX(created_at) t FROM monitor_reports WHERE watchlist_id = ? AND is_training = 0").get(w.id).t;
      if (last && Date.now() - Date.parse(last) < AUTO.reportEveryH * 3600e3) continue;
      const fresh = db.prepare(`SELECT COUNT(DISTINCT p.id) n FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id JOIN watch_post_analysis a ON a.post_id = p.id WHERE m.watchlist_id = ? AND ${GOOD("m.quality")} AND a.ai_status = 'done' AND p.is_training = 0 AND ${NOT_OWN("p")} AND a.ai_at > ?`).get(w.id, last || "").n;
      if (fresh < AUTO.reportMinItems) continue;
      try { await report(user, { watchlistId: w.id, hours: last ? Math.min(168, Math.ceil((Date.now() - Date.parse(last)) / 3600e3)) : 24, origin: "auto" }); n++; } catch (e) { console.warn("[monitor] automatic report:", e.message); }
    }
    return n;
  }
  // "Ollama AI Ready" only after AIVS itself has had a working answer from the model
  function aiIndicator() {
    const st = ai?.status ? ai.status() : null, h = st?.health || {};
    const ready = !!st?.configured && st.enabled && h.state === "ok";
    return { ready, label: ready ? `${st.provider === "ollama" ? "Ollama AI" : "AI"} Ready` : !st?.configured ? "AI not configured" : !st.enabled ? "AI switched off" : h.state === "failed" ? `${st.provider === "ollama" ? "Ollama AI" : "AI"} unavailable` : "AI not checked yet",
      provider: st?.provider || null, model: st?.model || null, endpoint: st?.endpoint || null, checked_at: h.checked_at || null, latency_ms: h.latency_ms ?? null, error: ready ? null : h.error || st?.reason || null, queue: aiQueueCounts() };
  }
  function retryAi(user, id) {
    const a = db.prepare("SELECT post_id FROM watch_post_analysis WHERE post_id = ?").get(id); if (!a) throw new HttpError(404, "This item has no analysis record yet.");
    db.prepare("UPDATE watch_post_analysis SET ai_status = 'pending', ai_attempts = 0, ai_next_at = ?, ai_error = NULL WHERE post_id = ?").run(nowISO(), id);
    audit(user, "AI analysis of a discovered item queued again", "watch_post", String(id), {}); return aiQueueCounts();
  }

  // ---------------------------------------------------------------- emerging topics within each active watchlist
  // A place, organisation or hashtag that appears in at least 4 genuine items from at least 3 accounts or outlets in the last
  // 6 hours, and at least 3 times as often as its usual 6-hour rate over the previous 7 days, raises a watchlist alert.
  const STOP_TOPICS = new Set(["kenya", "kenyan", "nairobi", "news", "today", "breaking"]);
  function emerging(wlId, { at = Date.now(), hours = 6, minItems = 4, minSources = 3, ratio = 3 } = {}) {
    const wl = watch.get(wlId), terms = new Set([...wl.definition.terms, ...(wl.definition.paused_terms || [])].map(t => t.toLowerCase().replace(/^#/, "").replace(/[\s\-_]+/g, "")));
    const from = new Date(at - 7 * 864e5 - hours * 3600e3).toISOString(), cut = at - hours * 3600e3;
    const rows = db.prepare(`SELECT p.id, p.text, p.account, p.platform, coalesce(p.posted_at, m.detected_at) t FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND ${GOOD("m.quality")} AND m.is_repost = 0 AND coalesce(p.posted_at, m.detected_at) >= ? AND coalesce(p.posted_at, m.detected_at) <= ?`).all(wl.id, from, new Date(at).toISOString());
    const topics = new Map();
    for (const r of rows) {
      const e = extractEntities(r.text), keys = new Set([...e.locations, ...e.orgs, ...extractHashtags(r.text).map(h => `#${String(h).replace(/^#/, "")}`)].map(x => String(x).trim()).filter(x => x.length > 2));
      for (const k of keys) { const norm = k.toLowerCase().replace(/^#/, "").replace(/[\s\-_]+/g, ""); if (terms.has(norm) || STOP_TOPICS.has(norm)) continue;
        const g = topics.get(norm) || { label: k, recent: [], before: 0, sources: new Set() }; if (Date.parse(r.t) >= cut) { g.recent.push(r.id); g.sources.add(`${r.platform}|${r.account || ""}`); } else g.before++; topics.set(norm, g); }
    }
    const out = [];
    for (const [norm, g] of topics) {
      const base = g.before / (7 * 24 / hours);   // usual items per period
      if (g.recent.length >= minItems && g.sources.size >= minSources && g.recent.length >= ratio * Math.max(base, 1 / ratio)) out.push({ topic: g.label, key: norm, items: g.recent.length, sources: g.sources.size, usual: Math.round(base * 10) / 10, post_ids: g.recent.slice(0, 50) });
    }
    return out.sort((a, b) => b.items - a.items).slice(0, 5);
  }
  function emergingTick() {
    let n = 0;
    for (const w of db.prepare("SELECT id FROM watchlists WHERE status = 'active' AND deleted_at IS NULL").all()) {
      const wl = watch.get(w.id);
      for (const t of emerging(w.id)) n += watch.raise(wl, "narrative", `emerg:${wl.id}:${t.key}:${new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)}`, { title: `Emerging topic in “${wl.name}”: ${t.topic}`,
        reason: `“${t.topic}” appears in ${t.items} items from ${t.sources} sources in the last 6 hours (usually about ${t.usual} in 6 hours over the past week). This is an observation about public content, not a finding about who is behind it.`,
        severity: t.sources >= 5 ? "medium" : "low", detail: { topic: t.topic, items: t.items, sources: t.sources, usual_per_6h: t.usual, post_ids: t.post_ids } });
    }
    return n;
  }

  // ---------------------------------------------------------------- the default watchlist (created once; then edited like any other)
  function ensureDefault(user) {
    if (!user || db.prepare("SELECT value FROM settings WHERE key = 'default_kdf_watchlist'").get()) return null;
    const existing = db.prepare("SELECT id FROM watchlists WHERE lower(name) = lower(?) AND deleted_at IS NULL").get(KDF_DEFAULT.name);
    let id = existing?.id || null, status = existing ? "existing" : "draft";
    if (!id) {
      const ready = k => k === "fb_live" ? !!config.live?.pageToken : watchCollector.sourcesReady(k);
      const def = { ...KDF_DEFAULT.definition, sources: KDF_DEFAULT.definition.sources.filter(k => WATCH_SOURCES[k] && (ready(k) || ["news", "gdelt"].includes(k))) };
      id = watch.create(user, { name: KDF_DEFAULT.name, description: KDF_DEFAULT.description, definition: def, authorisation: KDF_DEFAULT.authorisation });
      watch.recordPreview(user, id, { local: { matched: 0 }, live: [], note: "default watchlist created by AIVS 1.28; activated with the sources that need no key" });
      try { watch.setStatus(user, id, "active", ready); status = "active"; } catch (e) { status = `draft (${e.message})`; }
    }
    db.prepare("INSERT INTO settings(key, value) VALUES ('default_kdf_watchlist', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(id));
    audit(user, "Default KDF watchlist set up", "watchlist", String(id), { status });
    return { id, status };
  }
  // a source of the default watchlist that becomes connected later (a key added to .env) is added to it once; a source an analyst
  // removes afterwards is not added again. The watchlist keeps running.
  function addReadySources(user) {
    const id = Number(db.prepare("SELECT value FROM settings WHERE key = 'default_kdf_watchlist'").get()?.value); if (!id || !user) return [];
    const wl = db.prepare("SELECT id FROM watchlists WHERE id = ? AND deleted_at IS NULL").get(id) && watch.get(id); if (!wl) return [];
    const offered = new Set(J(db.prepare("SELECT value FROM settings WHERE key = 'default_kdf_sources_offered'").get()?.value) || wl.definition.sources);
    const add = KDF_DEFAULT.definition.sources.filter(k => !offered.has(k) && !wl.definition.sources.includes(k) && WATCH_SOURCES[k] && watchCollector.sourcesReady(k));
    for (const k of add) offered.add(k); for (const k of wl.definition.sources) offered.add(k);
    db.prepare("INSERT INTO settings(key, value) VALUES ('default_kdf_sources_offered', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify([...offered]));
    if (!add.length) return [];
    const wasActive = wl.status === "active", intervals = { ...wl.definition.intervals }; for (const k of add) intervals[k] = KDF_DEFAULT.definition.intervals[k] ?? intervals[k];
    watch.update(user, id, { definition: { ...wl.definition, sources: [...wl.definition.sources, ...add], intervals } });
    if (wasActive) { watch.recordPreview(user, id, { local: { matched: 0 }, live: [], note: `connected source(s) added: ${add.join(", ")}` }); try { watch.setStatus(user, id, "active", k => watchCollector.sourcesReady(k)); } catch (e) { console.warn("[monitor] default watchlist:", e.message); } }
    audit(user, "Newly connected sources added to the default watchlist", "watchlist", String(id), { sources: add });
    return add;
  }

  return { overview, sources, start, run, get, results, list, feed, item, image, verify, report, reportGet, reports, reportFile, reviewReport, saveAsWatchlist, daily, running: () => [...running], parseQuery,
    approvalState, submitReport, decideReport, editAssessment, aiTick, aiQueueCounts, aiIndicator, retryAi, emerging, emergingTick, ensureDefault, addReadySources, contextualLibrary };
}

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
import { WATCH_SOURCES, UNSUPPORTED, normaliseDefinition, matchPost, normForRepeat, similarity, KENYA_NEWS_SITES } from "./watch.js";
import { fetchImage } from "./fetchurl.js";
import { classifySentiment, themesOf, THEMES, SENTIMENT_LABELS, topicClusters, sourceCategory } from "./social-analysis.js";
import { extractEntities, extractHashtags, splitSentences, classifyStatement, redFlags } from "../../shared/text.js";
import { figures, negates } from "./autoeval.js";
import { VERIFY_LABELS, VERDICT_TO_STATUS } from "./livemonitor.js";
import { checkAiSections, aiPrompt, assessmentHtml, assessmentPdf, assessmentDocxXml, words } from "./ioassessment.js";
import { docxFromBody } from "./autoreport.js";

// sources an analyst can search on demand, and what their access really is
export const SEARCHABLE = ["news", "gdelt", "brave_news", "youtube", "x_search", "reddit", "bluesky", "mastodon", "threads", "instagram", "facebook", "tiktok", "fb_live"];
const RESTRICTED = {
  facebook: "Meta does not offer keyword search of Facebook. AIVS reads only the Pages named in the watchlist or FACEBOOK_PAGES, with a token those Pages allow (Page Public Content Access for other organisations' Pages). Personal profiles and groups are never read.",
  instagram: "Hashtag search only, through an Instagram professional account and Meta's Instagram Public Content Access approval. Personal accounts are not searched.",
  threads: "Keyword search needs Meta's approval for threads_keyword_search.",
  tiktok: "Only researchers approved by TikTok can use the Research API.",
  mastodon: "Follows public hashtags on the named servers only; Mastodon offers no full-text search.",
  fb_live: "Only the organisation's own authorised Facebook Page(s), collected by live monitoring. This is not a search of Facebook."
};
const ENGINE = new Set(["gdelt", "brave_news", "youtube", "x_search", "reddit", "bluesky", "threads"]);   // the platform matched the query itself, often in text AIVS does not receive
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
  const rec = [];
  if (sit.contradictions.length) rec.push("Verify the conflicting items against the responsible authority or an established fact-checker before relying on either.");
  if (sit.gaps.some(g => /official/.test(g))) rec.push("Seek an official statement or record on the subject.");
  if (sit.indicators.length) rec.push("Run the flagged items through Verify Information before any use.");
  if (sit.narratives.some(n => n.emerging) || sit.repeated.length) rec.push("Keep the search as a recurring watchlist and review new items daily.");
  if (!rec.length) rec.push("Keep the search as a recurring watchlist if the subject remains of interest.");
  rec.push("Refer this AI-generated assessment for authorised human review before any operational use.");
  return { title: "AIVS — PUBLIC INFORMATION MONITORING REPORT", header: { reference, date: eatStamp(nowISO()), subject: subject.slice(0, 120), source: plat, source_url: null, area: [...new Set(items.flatMap(i => i.analysis?.entities?.locations || []))].slice(0, 3).join(", ") || "Not established", priority: sit.contradictions.length || sit.indicators.length ? "Priority" : "Routine", status },
    background, analysis, assessment: as, recommendations: [...new Set(rec)].slice(0, 4), references: refs, limitation: sit.gaps[0] ? `The most important limitation is that ${sit.gaps[0].replace(/\.$/, "").replace(/^./, c => c.toLowerCase())}.` : "Only the connected sources were searched; content outside them was not seen.",
    report_status: `Generated automatically by AIVS ${version}; not reviewed or approved by a person. Analytical support product; not an official KDF intelligence document.`, verdict_label: sit.total ? "Monitoring summary" : "No results", strength, written_by: "rules", training };
}

export function makeKeywordSearch(db, { watch, watchCollector, investigations, storage, audit, config, version = "dev", live = null }) {
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
  const insPost = db.prepare(`INSERT INTO watch_posts(platform,post_id,url,account,author_name,text,language,posted_at,first_detected_at,first_source,collected_via,repost_of,quote_of,text_hash,likes,comments,shares,views,image_url,url_key)
    VALUES (@platform,@post_id,@url,@account,@author_name,@text,@language,@posted_at,@now,@source,@collected_via,@repost_of,@quote_of,@text_hash,@likes,@comments,@shares,@views,@image_url,@url_key) ON CONFLICT(platform, post_id) DO NOTHING`);
  function storeRow(source, r, now) {
    const row = { platform: r.platform, post_id: String(r.post_id).slice(0, 500), url: /^https?:\/\//.test(r.url || "") ? r.url : null, account: r.account || null, author_name: r.author_name || null, text: String(r.text).slice(0, 10000), language: r.language || null,
      posted_at: r.posted_at || null, now, source, collected_via: r.collected_via || WATCH_SOURCES[source]?.label || source, repost_of: r.repost_of || null, quote_of: r.quote_of || null, text_hash: sha(normForRepeat(r.text)),
      likes: r.likes ?? null, comments: r.comments ?? null, shares: r.shares ?? null, views: r.views ?? null, image_url: /^https?:\/\//.test(r.image_url || "") ? r.image_url : null, url_key: r.url ? urlKey(r.url) : null };
    const isNew = insPost.run(row).changes > 0, post = db.prepare("SELECT * FROM watch_posts WHERE platform = ? AND post_id = ?").get(row.platform, row.post_id);
    if (!isNew && row.image_url && !post.image_url) db.prepare("UPDATE watch_posts SET image_url = ? WHERE id = ?").run(row.image_url, post.id);
    if (!isNew && row.url_key && !post.url_key) db.prepare("UPDATE watch_posts SET url_key = ? WHERE id = ?").run(row.url_key, post.id);
    return { post, isNew };
  }
  function start(user, b = {}) {
    if (b.training) throw new HttpError(400, "Searches use live public sources, so they run in Operational mode only. Switch Records to Operational.");
    const q = parseQuery(b.query), avail = SEARCHABLE.filter(k => k === "fb_live" || WATCH_SOURCES[k]);
    const sources = (Array.isArray(b.sources) && b.sources.length ? b.sources : avail).filter(k => avail.includes(k));
    if (!sources.length) throw new HttpError(400, "Choose at least one source.");
    const from = eatIso(b.from) || new Date(Date.now() - 7 * 864e5).toISOString(), to = eatIso(b.to, true);
    if (to && to < from) throw new HttpError(400, "The end date is before the start date.");
    const max = Math.min(100, Math.max(5, +b.max || 30));
    const feeds = (Array.isArray(b.feeds) ? b.feeds : String(b.feeds || "").split(/[\s,]+/)).map(x => String(x).trim()).filter(x => /^https?:\/\//.test(x)).slice(0, 20);
    const def = normaliseDefinition({ terms: q.terms, require_groups: q.require_groups, exclude: q.exclude, sources: sources.filter(k => k !== "fb_live"), feeds: feeds.length ? feeds : String(config.collect?.rssFeeds || "").split(/[\s,]+/).filter(Boolean).length ? [] : KENYA_NEWS_SITES,
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
    const link = db.prepare("INSERT INTO monitor_search_results(search_id,post_id,source,terms_json,is_new,duplicate_of) VALUES (?,?,?,?,?,?) ON CONFLICT(search_id, post_id) DO NOTHING");
    const byKey = new Map(), byHash = new Map();
    const record = (source, r, m) => {
      const { post, isNew } = storeRow(source, r, now);
      // a duplicate is the same item found again (same address, or the same text from the same account); the same words from
      // different outlets are kept as separate items and reported as repeated wording
      const hk = `${post.account || ""}|${post.text_hash}`;
      const dupe = (post.url_key && byKey.get(post.url_key)) || (byHash.get(hk) !== post.id ? byHash.get(hk) : null) || null;
      if (post.url_key && !byKey.has(post.url_key)) byKey.set(post.url_key, post.id); if (!byHash.has(hk)) byHash.set(hk, post.id);
      return link.run(id, post.id, source, JSON.stringify(m.terms || []), isNew ? 1 : 0, dupe && dupe !== post.id ? dupe : null).changes ? { isNew, dupe: !!dupe } : null;
    };
    for (const source of sources) {
      const label = source === "fb_live" ? "Own Facebook Page (live monitoring)" : WATCH_SOURCES[source]?.label || source, item = { source, label, state: "ok", fetched: 0, matched: 0, new: 0, duplicates: 0, requests: 0, note: RESTRICTED[source] || null, error: null };
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
            if (!m.matched && ENGINE.has(source) && /none of the watch terms appear/.test(m.why || "") && (!def.require_groups?.length || ["gdelt", "brave_news"].includes(source)) && !(def.exclude.length && matchPost({ terms: def.exclude, exclude: [], context: [], languages: [], include_reposts: true }, row).matched)) m = { matched: true, terms: [], engine: true };
            if (!m.matched) continue;
            kept++; item.matched++; const x = record(source, row, m); if (x) { if (x.isNew) item.new++; if (x.dupe) item.duplicates++; }
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
  function analyseStore(postId, text) {
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
    matched_terms: J(r.terms_json) || [], engine_match: r.terms_json === "[]", duplicate_of: r.duplicate_of || null, is_new: r.is_new == null ? null : !!r.is_new, verification: verificationOf(r), analysis: analysisOf(r),
    origin: r.first_source === "fb_live" ? "own_page" : r.dataset_id ? "imported" : /demo|training|practice/i.test(r.collected_via || "") ? "test" : "live" });
  const SEL = `SELECT p.*, a.analysed_at, a.themes_json, a.sentiment_json, a.claims_json, a.entities_json, a.indicators_json, a.figures_json, i.status inv_status, i.overall inv_overall, i.report_id inv_report_id, i.reviewed_at inv_reviewed`;
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
    return w;
  }
  function get(id) {
    const s = db.prepare("SELECT s.*, u.display_name created_by_name FROM monitor_searches s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?").get(id); if (!s) throw new HttpError(404, "No such search.");
    const def = J(s.definition_json);
    return { ...s, definition: def, description: describeQuery({ terms: def.terms, require_groups: def.require_groups || [], exclude: def.exclude }), sources: J(s.sources_json), per_source: J(s.per_source_json) || [], definition_json: undefined, sources_json: undefined, per_source_json: undefined,
      results: db.prepare("SELECT COUNT(*) n FROM monitor_search_results WHERE search_id = ?").get(id).n };
  }
  function results(id, f = {}) {
    get(id); const a = { id, limit: Math.min(500, +f.limit || 200), offset: Math.max(0, +f.offset || 0) }, w = ["x.search_id = @id", ...filtersSql(f, a)];
    const sql = `FROM monitor_search_results x JOIN watch_posts p ON p.id = x.post_id ${JOINS} WHERE ${w.join(" AND ")}`;
    return { total: db.prepare(`SELECT COUNT(*) n ${sql}`).get(a).n, items: db.prepare(`${SEL}, x.terms_json, x.duplicate_of, x.is_new ${sql} ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT @limit OFFSET @offset`).all(a).map(itemRow),
      by_source: db.prepare(`SELECT p.platform, COUNT(*) n ${sql} GROUP BY p.platform`).all(a) };
  }
  function list(limit = 30) { return db.prepare("SELECT s.id, s.query, s.status, s.created_at, s.finished_at, s.period_from, s.period_to, s.watchlist_id, s.report_id, u.display_name by_name, (SELECT COUNT(*) FROM monitor_search_results r WHERE r.search_id = s.id) results FROM monitor_searches s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC LIMIT ?").all(Math.min(200, +limit || 30)); }
  // everything discovered by keyword: saved watchlists (recurring) and searches
  function feed(f = {}) {
    const a = { limit: Math.min(500, +f.limit || 100), offset: Math.max(0, +f.offset || 0) }, w = filtersSql(f, a);
    let scope = "(p.id IN (SELECT post_id FROM watch_matches) OR p.id IN (SELECT post_id FROM monitor_search_results))";
    if (+f.watchlist) { scope = "p.id IN (SELECT post_id FROM watch_matches WHERE watchlist_id = @wl)"; a.wl = +f.watchlist; }
    if (+f.search) { scope = "p.id IN (SELECT post_id FROM monitor_search_results WHERE search_id = @sid)"; a.sid = +f.search; }
    const sql = `FROM watch_posts p ${JOINS} LEFT JOIN monitor_search_results x ON 0 WHERE ${[scope, ...w.filter(c => !c.includes("x.duplicate_of"))].join(" AND ")}`;
    const items = db.prepare(`${SEL}, (SELECT terms_json FROM watch_matches m WHERE m.post_id = p.id LIMIT 1) terms_json, NULL duplicate_of, NULL is_new ${sql} ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT @limit OFFSET @offset`).all(a).map(itemRow);
    for (const it of items) it.watchlists = db.prepare("SELECT w.id, w.name FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE m.post_id = ?").all(it.id);
    return { total: db.prepare(`SELECT COUNT(*) n ${sql}`).get(a).n, items, by_source: db.prepare(`SELECT p.platform, COUNT(*) n ${sql} GROUP BY p.platform`).all(a) };
  }
  function item(id) {
    const r = db.prepare(`${SEL}, NULL terms_json, NULL duplicate_of, NULL is_new FROM watch_posts p ${JOINS} WHERE p.id = ?`).get(id); if (!r) throw new HttpError(404, "No such item.");
    const it = itemRow(r);
    it.watchlists = db.prepare("SELECT w.id, w.name, m.terms_json FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE m.post_id = ?").all(id).map(m => ({ ...m, terms: J(m.terms_json), terms_json: undefined }));
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
    if (searchId) rows = db.prepare(`${base} WHERE p.id IN (SELECT post_id FROM monitor_search_results WHERE search_id = ? AND duplicate_of IS NULL) ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT ?`).all(searchId, limit);
    else rows = db.prepare(`${base} WHERE p.id IN (SELECT post_id FROM watch_matches WHERE watchlist_id = ?) AND coalesce(p.posted_at, p.first_detected_at) >= ? AND coalesce(p.posted_at, p.first_detected_at) <= ? ORDER BY coalesce(p.posted_at, p.first_detected_at) DESC LIMIT ?`).all(watchlistId, from, to, limit);
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
  function reports(limit = 50) { return db.prepare("SELECT r.id, r.report_id, r.created_at, r.origin, r.search_id, r.watchlist_id, r.written_by, r.reviewed_at, r.approved_at, s.query, w.name watchlist FROM monitor_reports r LEFT JOIN monitor_searches s ON s.id = r.search_id LEFT JOIN watchlists w ON w.id = r.watchlist_id ORDER BY r.id DESC LIMIT ?").all(Math.min(200, +limit || 50)); }
  async function reportFile(id, fmt) {
    const r = reportGet(id), a = r.report;
    if (r.reviewed_at && a.header.status.startsWith("AI-Generated")) a.header.status = "Reviewed";
    if (fmt === "html") return { body: assessmentHtml(a), type: "text/html; charset=utf-8", name: `${r.report_id}.html` };
    if (fmt === "pdf") return { body: (await assessmentPdf(a)).buf, type: "application/pdf", name: `${r.report_id}.pdf` };
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
    for (const r of db.prepare("SELECT post_id, source, terms_json FROM monitor_search_results WHERE search_id = ?").all(id))
      db.prepare("INSERT INTO watch_matches(watchlist_id,post_id,detected_at,source,terms_json,context_json,definition_sha256,cluster,is_repost) SELECT ?, ?, ?, ?, ?, '[]', definition_sha256, NULL, 0 FROM watchlists WHERE id = ? AND NOT EXISTS (SELECT 1 FROM watch_matches WHERE watchlist_id = ? AND post_id = ?)")
        .run(wid, r.post_id, nowISO(), r.source, r.terms_json, wid, wid, r.post_id);
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
      const c = db.prepare("SELECT COUNT(*) n FROM watch_matches WHERE watchlist_id = ? AND detected_at >= ?").get(w.id, new Date(Date.now() - 864e5).toISOString()).n;
      if (!c) continue; try { await report(user, { watchlistId: w.id, hours: 24, origin: "daily" }); n++; } catch (e) { console.warn("[monitor] daily report:", e.message); }
    }
    return n;
  }
  function overview() {
    const n = (sql, ...a) => db.prepare(sql).get(...a).n, today = new Date(`${new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)}T00:00:00+03:00`).toISOString();
    const scope = "(p.id IN (SELECT post_id FROM watch_matches) OR p.id IN (SELECT post_id FROM monitor_search_results))";
    const src = sources().sources, cat = {}; for (const x of src) cat[x.category] = (cat[x.category] || 0) + 1;
    return { counts: { items: n(`SELECT COUNT(*) n FROM watch_posts p WHERE ${scope}`), items_today: n(`SELECT COUNT(*) n FROM watch_posts p WHERE ${scope} AND p.first_detected_at >= ?`, today),
        verified: n(`SELECT COUNT(*) n FROM watch_posts p WHERE ${scope} AND p.investigation_id IS NOT NULL`), searches: n("SELECT COUNT(*) n FROM monitor_searches"),
        active_watchlists: n("SELECT COUNT(*) n FROM watchlists WHERE status = 'active' AND deleted_at IS NULL"), reports: n("SELECT COUNT(*) n FROM monitor_reports"),
        new_alerts: n("SELECT COUNT(*) n FROM watch_alerts a JOIN watchlists w ON w.id = a.watchlist_id WHERE a.status = 'new' AND w.deleted_at IS NULL") + n("SELECT COUNT(*) n FROM live_alerts WHERE status = 'new' AND is_training = 0") },
      by_category: cat, connected: src.filter(x => x.category === "Connected").map(x => x.platform), sources: src,
      by_platform: db.prepare(`SELECT p.platform, COUNT(*) n, MAX(p.first_detected_at) last FROM watch_posts p WHERE ${scope} GROUP BY p.platform ORDER BY n DESC`).all(),
      recent: feed({ limit: 8 }).items, searches: list(5) };
  }
  return { overview, sources, start, run, get, results, list, feed, item, image, verify, report, reportGet, reports, reportFile, reviewReport, saveAsWatchlist, daily, running: () => [...running], parseQuery };
}

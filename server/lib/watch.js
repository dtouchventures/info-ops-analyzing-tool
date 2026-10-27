// KDF Mention Watch: saved watchlists, matching, the alert queue and the signals that raise alerts.
// Collection (official APIs and feeds) lives in watch-collect.js; this file decides what a post matches, stores it
// once, and turns stored observations into alerts that an analyst acknowledges, dismisses, assigns or converts.
// Nothing here claims complete coverage: a watchlist only sees what its configured sources return.
// Signals are leads for an analyst. Repeated wording or a rise in volume is never treated as proof of coordination,
// and no metric is invented: counts the platform did not report are stored as unknown (null), never as zero.
import crypto from "node:crypto";
import { HttpError } from "./auth.js";
import { nowISO } from "./db.js";

// ---------------------------------------------------------------- sources a watchlist can use
export const WATCH_SOURCES = {
  x_stream: { label: "X filtered stream (near real time)", platform: "X (Twitter)", mode: "stream" },
  x_search: { label: "X recent search (scheduled)", platform: "X (Twitter)", mode: "poll" },
  youtube: { label: "YouTube Data API search (scheduled)", platform: "YouTube", mode: "poll" },
  news: { label: "News websites (RSS/Atom feeds, scheduled)", platform: "News website", mode: "poll" },
  reddit: { label: "Reddit Data API search (scheduled)", platform: "Reddit", mode: "poll" },
  bluesky: { label: "Bluesky search (scheduled)", platform: "Bluesky", mode: "poll" },
  mastodon: { label: "Mastodon hashtag timelines (scheduled)", platform: "Mastodon", mode: "poll" },
  threads: { label: "Threads keyword search (scheduled)", platform: "Threads", mode: "poll" },
  instagram: { label: "Instagram hashtag search (scheduled)", platform: "Instagram", mode: "poll" },
  facebook: { label: "Facebook public Pages and their comments (scheduled)", platform: "Facebook", mode: "poll" },
  gdelt: { label: "GDELT news search (worldwide online news index, scheduled)", platform: "News (GDELT)", mode: "poll" },
  brave_news: { label: "Brave News Search API (scheduled)", platform: "News (Brave)", mode: "poll" },
  fb_live: { label: "Live Facebook monitoring (every post of the authorised Pages, collected by AIVS)", platform: "Facebook", mode: "push" },
  tiktok: { label: "TikTok Research API (scheduled)", platform: "TikTok", mode: "poll" },
  telegram: { label: "Telegram channels where our bot is a member (scheduled)", platform: "Telegram", mode: "poll" },
  whatsapp_business: { label: "WhatsApp Business: messages sent to our own business number (webhook)", platform: "WhatsApp Business", mode: "webhook" }
};
// posts added by people rather than by a connector, labelled as such wherever they appear
export const MANUAL_SOURCES = { manual_link: "Public link submitted by an analyst", file_import: "File import (an export you are permitted to use)", dataset: "Imported dataset (Social Media Analysis)" };
// platforms the watch cannot cover, with the reason; shown so nobody assumes they are monitored
export const UNSUPPORTED = [
  { platform: "Facebook (search across all of Facebook, groups, profiles)", reason: "Meta offers no keyword search of all public Facebook posts to applications like AIVS; the Meta Content Library works only inside Meta's research environment. AIVS reads only the public Pages you name. Use a file import or submit public links." },
  { platform: "Instagram (caption search)", reason: "Instagram offers hashtag search only. Use a file import or submit public links." },
  { platform: "TikTok (without Research API access)", reason: "TikTok's only search API is the Research API, granted to academic institutions in the U.S., EEA, UK, Canada or Switzerland and some EU non-profit research bodies (checked October 2026). Submit public links instead; Verify information reads a single TikTok post's caption." },
  { platform: "LinkedIn", reason: "No public post search API. The Community Management API (vetted, approval required) covers only Pages you administer; not built in AIVS. Submit public links instead." },
  { platform: "Telegram (search of public channels)", reason: "The Bot API only delivers posts from channels where your bot is a member; there is no search. Submit public links for other channels." },
  { platform: "WhatsApp (personal chats, groups, channels)", reason: "Private messaging. Never collected. Only messages people send to your own WhatsApp Business number are received." },
  { platform: "Private accounts, private groups and direct messages (any platform)", reason: "Never collected." }
];
export const CAVEATS = [
  "Coverage is limited to the sources listed as connected. Posts on other platforms, in private spaces, or that a platform does not return are not seen.",
  "Detection is not guaranteed and may come after a post has already spread: scheduled searches run at intervals, platforms index posts with delays, and limits or outages pause collection.",
  "An alert is a lead for an analyst, not a finding. Repeated wording and rising volume can be genuine public reaction; they are not proof of coordination, and no person or organisation is identified as responsible.",
  "Engagement figures are the public counts a platform reported at the time shown. AIVS does not estimate reach and does not fill in counts a platform did not report.",
  "A mention of KDF, criticism or a negative tone is not, by itself, misinformation or a threat. Watch public content and overall trends; do not use this to build files on individuals."
];

export const DEFAULT_THRESHOLDS = {
  volume_window_min: 60, volume_baseline_windows: 24, volume_min_posts: 10, volume_ratio: 3, volume_sd: 3, volume_min_coverage: 0.8,
  repeat_min_posts: 3, repeat_min_accounts: 2, repeat_window_h: 24, repeat_similarity: 0.8,
  engagement_min_increase: 100, engagement_ratio: 2, engagement_window_h: 6,
  // used for imported datasets (historical analysis): keyword threshold, emerging narrative, coordination indicator
  count_min_posts: 10, count_window_min: 60, narrative_min_posts: 8, narrative_window_h: 6, narrative_ratio: 3, narrative_sd: 3, narrative_baseline_windows: 8, repeat_burst_ratio: 3, coord_min_accounts: 3, coord_window_min: 10
};
const T_LIMITS = { volume_window_min: [15, 1440], volume_baseline_windows: [6, 168], volume_min_posts: [2, 100000], volume_ratio: [1.2, 100], volume_sd: [0, 10], volume_min_coverage: [0.5, 1],
  repeat_min_posts: [2, 1000], repeat_min_accounts: [1, 1000], repeat_window_h: [1, 168], repeat_similarity: [0.5, 1], engagement_min_increase: [1, 1e9], engagement_ratio: [1.1, 1000], engagement_window_h: [1, 72],
  count_min_posts: [1, 100000], count_window_min: [5, 10080], narrative_min_posts: [2, 10000], narrative_window_h: [1, 720], narrative_ratio: [1.1, 100], narrative_sd: [0, 10], narrative_baseline_windows: [1, 500], repeat_burst_ratio: [1, 1000], coord_min_accounts: [2, 1000], coord_window_min: [1, 1440] };
const INTERVAL_LIMITS = { gdelt: [15, 1440], brave_news: [30, 1440], x_search: [5, 1440], youtube: [30, 1440], news: [5, 1440], reddit: [5, 1440], bluesky: [5, 1440], mastodon: [5, 1440], threads: [15, 1440], instagram: [30, 1440], facebook: [15, 1440], tiktok: [60, 1440], telegram: [5, 1440] };
const DEFAULT_INTERVALS = { gdelt: 30, brave_news: 60, x_search: 15, youtube: 60, news: 15, reddit: 15, bluesky: 15, mastodon: 15, threads: 30, instagram: 60, facebook: 30, tiktok: 180, telegram: 10 };

// a starting point for analysts to review and edit (spelling variants, hashtags, English and Kiswahili); not an official list
export function kdfTemplate() {
  return {
    name: "KDF mentions",
    description: "Public posts that mention the Kenya Defence Forces. Starting template: review the terms, add local spellings and current hashtags, and preview before activating.",
    definition: normaliseDefinition({
      terms: ["KDF", "Kenya Defence Forces", "Kenya Defense Forces", "Kenya Defence Force", "Kenya Defense Force", "#KDF", "#KenyaDefenceForces", "Jeshi la Kenya", "Wanajeshi wa Kenya", "Wanajeshi wa KDF", "Vikosi vya Ulinzi vya Kenya"],
      context: [],
      exclude: ["kdf file", "kdf format", ".kdf"],
      languages: [], sources: ["x_search"], feeds: [], include_reposts: false, alert_mode: "every_post",
      intervals: { ...DEFAULT_INTERVALS }, lookback_minutes: 60, thresholds: { ...DEFAULT_THRESHOLDS }
    })
  };
}

// Kenya security monitoring (1.27): the keywords asked for by the unit, across every keyword source AIVS supports. Sources that are
// not configured are skipped and shown as such; nothing is searched without a stated basis and an activation by a reviewer.
export const KENYA_NEWS_SITES = ["https://nation.africa", "https://www.standardmedia.co.ke", "https://www.the-star.co.ke", "https://www.capitalfm.co.ke/news", "https://www.kbc.co.ke", "https://www.citizen.digital", "https://www.kenyans.co.ke", "https://www.pd.co.ke"];
export function kenyaSecurityTemplate() {
  return {
    name: "KDF and Kenya security (public information)",
    description: "Public information that mentions the Kenya Defence Forces or Kenya's security environment, discovered across news sites, news search APIs and the social media APIs that are connected.",
    definition: normaliseDefinition({
      terms: ["KDF", "Kenya Defence Forces", "Kenya Defense Forces", "Kenya Army", "Kenya military", "Kenya security", "Kenya Defence Forces operations", "#KDF", "Jeshi la Kenya", "Wanajeshi wa Kenya"],
      context: [], exclude: ["kdf file", "kdf format", ".kdf"], languages: [],
      sources: ["news", "gdelt", "brave_news", "youtube", "x_search", "reddit", "bluesky", "mastodon", "threads", "instagram", "fb_live"], feeds: KENYA_NEWS_SITES,
      include_reposts: false, alert_mode: "every_post", lookback_minutes: 1440, thresholds: { ...DEFAULT_THRESHOLDS }
    })
  };
}

// The default watchlist (1.28), created once on start-up and then edited from the dashboard like any other. Contextual keywords
// (CDF, and Navy or Air Force Commander, which also name other countries' officers) count only with their context words and
// never when a word shows another meaning; otherwise the item is held for an analyst. Context words are a starting point to edit.
const MIL_CONTEXT = ["KDF", "Kenya Defence Forces", "Kenya Army", "Kenya Navy", "Kenya Air Force", "military", "soldiers", "troops", "army", "defence", "Ministry of Defence", "General", "Gen", "Lieutenant General", "Major General", "Chief of Defence Forces", "Vice Chief of Defence Forces", "Defence Council", "barracks", "deployment", "peacekeeping", "al-Shabaab", "ATMIS", "AUSSOM", "AMISOM", "Jeshi", "wanajeshi", "Majeshi"];
export const KDF_DEFAULT = {
  name: "KDF and Kenya Defence Forces Monitoring",
  description: "Default watchlist: public information that mentions the Kenya Defence Forces, its services and commanders, across the connected news, search and social media sources. Keywords are edited from the dashboard; ambiguous abbreviations need their context.",
  authorisation: "Public content through each source's official API or public news feed, under the source's terms and the organisation's monitoring policy.",
  definition: {
    terms: ["KDF", "Kenya Defence Forces", "Kenya Army", "Kenya Navy", "CDF", "Kenya Air Force", "Kenya Airforce", "Navy Commander", "Air Force Commander", "Majeshi Yetu", "Chief of Defence Forces", "Jeshi la Kenya"],
    contextual: [
      { term: "CDF", require: MIL_CONTEXT, exclude: ["Constituency Development Fund", "NG-CDF", "NGCDF", "CDF bursary", "bursary", "bursaries", "constituency", "CDF funds", "CDF kitty", "Zambia", "Pakistan", "Nigeria", "Malawi"] },
      { term: "Navy Commander", require: ["Kenya", "Kenyan", "KDF", "Mtongwe", "Manda Bay", "Mombasa", "Lamu", "Kenya Navy"], exclude: ["US Navy", "U.S. Navy", "Royal Navy", "Indian Navy", "Chinese Navy", "Pakistan Navy", "Nigerian Navy"] },
      { term: "Air Force Commander", require: ["Kenya", "Kenyan", "KDF", "Laikipia Air Base", "Moi Air Base", "Eastleigh", "Kenya Air Force"], exclude: ["US Air Force", "U.S. Air Force", "Royal Air Force", "Indian Air Force", "Nigerian Air Force", "Pakistan Air Force"] }
    ],
    context: [], exclude: ["kdf file", "kdf format", ".kdf"], languages: [],
    sources: ["news", "gdelt", "brave_news", "youtube", "x_search", "reddit", "bluesky", "mastodon"], feeds: KENYA_NEWS_SITES,
    include_reposts: false, alert_mode: "every_post", lookback_minutes: 1440,
    intervals: { news: 30, gdelt: 30, brave_news: 60, youtube: 120, x_search: 30, reddit: 30, bluesky: 30, mastodon: 30 }
  }
};

// ---------------------------------------------------------------- definitions
const listOf = (v, max, label) => {
  const a = (Array.isArray(v) ? v : String(v || "").split(/\r?\n|,/)).map(x => String(x).replace(/\s+/g, " ").trim()).filter(Boolean);
  const out = [...new Map(a.map(x => [x.toLowerCase(), x])).values()];
  if (out.length > max) throw new HttpError(400, `Too many ${label}: at most ${max}.`);
  for (const x of out) if (x.length > 80) throw new HttpError(400, `“${x.slice(0, 40)}…” is too long: keep each of the ${label} under 80 characters.`);
  return out;
};
export function normaliseDefinition(d = {}) {
  const terms = listOf(d.terms, 150, "terms"), context = listOf(d.context, 40, "context words"), exclude = listOf(d.exclude, 60, "exclusions");
  for (const t of terms) if (t.replace(/^#/, "").length < 2) throw new HttpError(400, `“${t}” is too short to search for.`);
  for (const t of [...terms, ...context, ...exclude]) if (/["()]/.test(t)) throw new HttpError(400, `“${t}”: leave out quotation marks and brackets. Each line is matched as written; a line with spaces is matched as a phrase.`);
  const languages = [...new Set((d.languages || []).filter(l => ["en", "sw"].includes(l)))];
  const sources = [...new Set((d.sources || []).filter(s => WATCH_SOURCES[s]))];
  const feeds = listOf(d.feeds, 20, "feeds").filter(f => /^https?:\/\//i.test(f));
  // Facebook Pages to read (Page IDs, usernames or facebook.com links); only stored when given, so older definitions keep their hash
  // terms switched off by an analyst stay listed but are not searched or matched; only stored when given, so older hashes stay the same
  // keyword combinations: every group must match (each group is a list of alternatives), e.g. (KDF OR "Kenya Army") AND (Lamu OR Boni)
  const groups = (Array.isArray(d.require_groups) ? d.require_groups : []).map(g => listOf(g, 30, "combined terms")).filter(g => g.length).slice(0, 5);
  const paused = listOf(d.paused_terms, 150, "paused terms").filter(t => !terms.some(x => x.toLowerCase() === t.toLowerCase()));
  const fbPages = listOf(d.fb_pages, 50, "Facebook Pages").map(x => x.replace(/^https?:\/\/(www\.|m\.)?facebook\.com\//i, "").replace(/[/?#].*$/, "")).filter(x => /^[\w.-]{2,100}$/.test(x));
  const intervals = { ...DEFAULT_INTERVALS };
  for (const [k, [lo, hi]] of Object.entries(INTERVAL_LIMITS)) if (d.intervals?.[k] != null) intervals[k] = Math.min(hi, Math.max(lo, Math.round(+d.intervals[k] || DEFAULT_INTERVALS[k])));
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const [k, [lo, hi]] of Object.entries(T_LIMITS)) if (d.thresholds?.[k] != null && !isNaN(+d.thresholds[k])) thresholds[k] = Math.min(hi, Math.max(lo, +d.thresholds[k]));
  // imported datasets to monitor (Social Media Analysis); stored only when given, so older definitions keep their hash
  // contextual (ambiguous) keywords such as CDF: a post that matches only these needs one of its context words, and none of the
  // words that show another meaning (CDF also means Constituency Development Fund); otherwise it is held for an analyst to decide
  const contextual = (Array.isArray(d.contextual) ? d.contextual : []).map(c => ({ term: String(c?.term || "").replace(/\s+/g, " ").trim(), require: listOf(c?.require, 60, "context words"), exclude: listOf(c?.exclude, 60, "words that show another meaning") }))
    .filter(c => c.term && [...terms, ...paused].some(t => t.toLowerCase() === c.term.toLowerCase())).filter((c, i, a) => a.findIndex(x => x.term.toLowerCase() === c.term.toLowerCase()) === i);
  const datasets = [...new Set((Array.isArray(d.datasets) ? d.datasets : String(d.datasets || "").split(/[\s,]+/)).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 100);
  const allDs = d.all_datasets === true || d.all_datasets === "true";
  return { terms, ...(groups.length ? { require_groups: groups } : {}), ...(paused.length ? { paused_terms: paused } : {}), ...(contextual.length ? { contextual } : {}), context, exclude, languages, sources, feeds, ...(fbPages.length ? { fb_pages: fbPages } : {}), ...(datasets.length && !allDs ? { datasets } : {}), ...(allDs ? { all_datasets: true } : {}), ...(d.fb_comments === false || d.fb_comments === "false" ? { fb_comments: false } : {}), include_reposts: !!d.include_reposts, alert_mode: d.alert_mode === "signals_only" ? "signals_only" : "every_post",
    intervals, lookback_minutes: Math.min(7 * 1440, Math.max(10, Math.round(+d.lookback_minutes || 60))), thresholds };
}
export const definitionHash = def => crypto.createHash("sha256").update(JSON.stringify(def)).digest("hex");

// ---------------------------------------------------------------- matching
const fold = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’‘`´]/g, "'").toLowerCase();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// spelling variants handled for every term: words may be joined, spaced or hyphenated (Air Force, Airforce, Air-Force, #KenyaAirForce),
// and British or American spelling of defence; anything else (Kiswahili forms, other spellings) is added as its own keyword
const VARIANT = { defence: "defen[cs]e", defense: "defen[cs]e", defences: "defen[cs]es", defenses: "defen[cs]es", airforce: "air[\\s\\-_]*force" };
const wordRe = w => VARIANT[w] || escRe(w);
function termRe(term) {
  const f = fold(term).trim(), tag = f.startsWith("#"), body = (tag ? f.slice(1) : f).split(/[\s\-_]+/).filter(Boolean).map(wordRe).join("[\\s\\-_]*");
  // a plain term also matches the same word written as a hashtag (KDF matches #KDF); a hashtag term matches only the hashtag
  return new RegExp(`(^|[^\\p{L}\\p{N}_${tag ? "#" : ""}])${tag ? "#" : ""}${body}(?![\\p{L}\\p{N}_])`, "u");
}
const reCache = new Map();
const re = t => { let r = reCache.get(t); if (!r) { r = termRe(t); if (reCache.size > 5000) reCache.clear(); reCache.set(t, r); } return r; };
// returns which terms matched and why the post was (or was not) kept
export function matchPost(def, post) {
  const text = fold(post.text), found = def.terms.filter(t => re(t).test(text));
  if (!found.length) return { matched: false, why: "none of the watch terms appear in the text" };
  // contextual keywords: confirmed only together with a non-contextual keyword, or with one of their context words
  const ctxOf = t => (def.contextual || []).find(c => c.term.toLowerCase() === t.toLowerCase());
  const firm = found.filter(t => !ctxOf(t)), ctxHits = [], other = [];
  if (!firm.length) {
    for (const t of found) { const c = ctxOf(t), ex = c.exclude.filter(w => re(w).test(text)), rq = c.require.filter(w => re(w).test(text));
      if (ex.length) other.push(`“${t}” used with ${ex.map(w => `“${w}”`).join(", ")} (another meaning)`); else if (rq.length) ctxHits.push(...rq); }
    if (other.length === found.length) return { matched: false, terms: found, why: other.join("; ") };
    if (!ctxHits.length) return { matched: false, ambiguous: true, terms: found, quality: "ambiguous", why: `only the ambiguous keyword${found.length > 1 ? "s" : ""} ${found.map(t => `“${t}”`).join(", ")}, without any of ${found.length > 1 ? "their" : "its"} context words: an analyst must decide whether it concerns this subject` };
  }
  const terms = found, quality = firm.length ? "confirmed" : "contextual";
  for (const g of def.require_groups || []) if (!g.some(t => re(t).test(text))) return { matched: false, terms, why: `none of ${g.map(t => `“${t}”`).join(", ")} appears (all keyword groups must match)` };
  const excl = def.exclude.filter(t => re(t).test(text));
  if (excl.length) return { matched: false, terms, why: `excluded by “${excl.join("”, “")}”` };
  const ctx = def.context.filter(t => re(t).test(text));
  if (def.context.length && !ctx.length) return { matched: false, terms, why: "none of the required context words appear" };
  if (def.languages.length && post.language && !def.languages.includes(String(post.language).slice(0, 2).toLowerCase()))
    return { matched: false, terms, why: `language “${post.language}” is not one of the selected languages` };
  if (!def.include_reposts && post.repost_of) return { matched: false, terms, why: "a repost (reposts are not included in this watchlist)" };
  return { matched: true, terms, quality, ...(ctxHits.length ? { disambiguated_by: [...new Set(ctxHits)] } : {}), context: ctx, language_unknown: !!def.languages.length && !post.language };
}
// highlight ranges for the alert view (start,end in the original text) — computed on the folded text, same length for Latin scripts
export function highlights(def, text) {
  const out = [], f = fold(text);
  if (f.length !== String(text).length) return out;
  for (const t of [...def.terms, ...def.context]) { const r = new RegExp(re(t).source, "gu"); for (const m of f.matchAll(r)) { const s = m.index + m[1].length; out.push([s, m.index + m[0].length]); } }
  return out.sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------- platform queries compiled from a definition
// terms sent to a platform's own search: contextual keywords are left out when the watchlist has others (searching "CDF" alone returns
// mostly unrelated items); news feeds are read in full, so contextual keywords are still found there and checked with their context
export const queryTerms = def => { const c = new Set((def.contextual || []).map(x => x.term.toLowerCase())), firm = def.terms.filter(t => !c.has(t.toLowerCase())); return firm.length ? firm : def.terms; };
const xTok = t => { const f = t.trim(); if (f.startsWith("#")) return f; return /[\s\-]/.test(f) ? `"${f}"` : f; };
export function xQuery(def, { stream = false } = {}) {
  const terms = queryTerms(def).map(xTok), parts = [terms.length > 1 ? `(${terms.join(" OR ")})` : terms[0]];
  if (def.context.length) parts.push(def.context.length > 1 ? `(${def.context.map(xTok).join(" OR ")})` : xTok(def.context[0]));
  for (const e of def.exclude) { const tok = e.startsWith(".") ? `"${e}"` : xTok(e); parts.push(`-${tok}`); }
  if (!def.include_reposts) parts.push("-is:retweet");
  if (def.languages.length === 1) parts.push(`lang:${def.languages[0]}`);
  const q = parts.join(" "), max = stream ? 1024 : 512;
  return { query: q, length: q.length, max, ok: q.length <= max, problem: q.length > max ? `The X ${stream ? "stream rule" : "search query"} built from this watchlist is ${q.length} characters; X allows ${max}${stream ? " on pay-per-use access" : ""}. Remove some terms or exclusions.` : null };
}
export function youtubeQuery(def) {
  const q = [queryTerms(def).filter(t => !t.startsWith("#")).map(t => (/\s/.test(t) ? `"${t}"` : t)).join("|"), ...def.exclude.filter(e => !e.startsWith(".")).map(e => `-${/\s/.test(e) ? `"${e}"` : e}`)].join(" ");
  return { query: q, note: "YouTube search is broad; AIVS re-checks every result against the watch terms, context words and exclusions before keeping it." };
}

// ---------------------------------------------------------------- text helpers for repeated wording
export const normForRepeat = s => fold(s).replace(/https?:\/\/\S+/g, " ").replace(/(^|\s)[@][\w.]+/g, " ").replace(/^rt\s+/, "").replace(/[^\p{L}\p{N}#\s]/gu, " ").replace(/\s+/g, " ").trim();
const shingles = s => { const w = normForRepeat(s).split(" ").filter(Boolean), out = new Set(); for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(" ")); if (w.length < 3) out.add(w.join(" ")); return out; };
export const similarity = (a, b) => { const A = shingles(a), B = shingles(b); let n = 0; for (const x of A) if (B.has(x)) n++; return A.size && B.size ? n / (A.size + B.size - n) : 0; };
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const engagementOf = m => [m.likes, m.comments, m.shares].every(v => v == null) ? null : (m.likes || 0) + (m.comments || 0) + (m.shares || 0);
const engagementParts = m => ["likes", "comments", "shares"].filter(k => m[k] != null);

// Alert categories, documented severity rules and the analyst action each one calls for (also in the README)
export const ALERT_KINDS = ["match", "threshold", "volume", "narrative", "repeated", "coordination", "engagement"];
export const SEVERITY_DEFAULT = { match: "low", threshold: "low", volume: "medium", narrative: "low", repeated: "medium", coordination: "medium", engagement: "medium" };
export const SEVERITY_RULES = {
  threshold: "Low; medium when the window has at least twice the configured number of posts.",
  volume: "Medium; high when the window is at least 5× its baseline average and at least 5 standard deviations above it.",
  narrative: "Low; medium when the recent period has at least twice the minimum number of posts.",
  repeated: "Medium; high when 10 or more accounts used the same wording. In imported datasets, wording counts only when it is concentrated in time (at least the burst ratio × its usual rate), and messages repeated in the same period form one alert.",
  coordination: "Medium; high when 5 or more accounts posted near-identical text within 10 minutes.",
  match: "Low.", engagement: "Medium."
};
export const ACTION = {
  match: "Read the post. Dismiss it if the term is used in an unrelated sense; otherwise acknowledge it, or verify its claim if it is checkable.",
  threshold: "Open the posts in the window and see what drove the activity. If a checkable claim is spreading, send it to Verify Information.",
  volume: "Compare the spike with news and official statements from the same period, then check the most shared claim. A rise can be genuine public reaction.",
  narrative: "Read the representative posts. If the narrative contains a factual claim, send it to Verify Information; otherwise note it and keep watching.",
  repeated: "Check whether the repeated text quotes a news item or official notice. If not, look at the accounts' creation dates and timing before drawing any conclusion.",
  coordination: "Treat as a lead only: look for independent explanations (a shared news link, a campaign that asks people to repost). Escalate to a reviewer before any action.",
  engagement: "See who is sharing the post and whether its claim is checkable; verify it if it is spreading."
};

// ---------------------------------------------------------------- the module
export function makeWatch(db, { audit, cases, config = {} }) {
  const W = { usdPerXPost: 0.005, ...(config.watch || {}) };
  const getWl = id => { const w = db.prepare("SELECT * FROM watchlists WHERE id = ?").get(Number(id)); if (!w) throw new HttpError(404, "Watchlist not found."); return { ...w, definition: JSON.parse(w.definition_json), preview: w.preview_json ? JSON.parse(w.preview_json) : null, previewed_current: w.previewed_sha256 === w.definition_sha256 }; };
  const version = (wl, user, note) => db.prepare("INSERT INTO watchlist_versions(watchlist_id,definition_json,definition_sha256,status,changed_by,changed_at,note) VALUES (?,?,?,?,?,?,?)").run(wl.id, wl.definition_json, wl.definition_sha256, wl.status, user?.id ?? null, nowISO(), note || null);

  function create(user, b = {}) {
    const name = String(b.name || "").trim().slice(0, 120); if (!name) throw new HttpError(400, "Give the watchlist a name.");
    const def = normaliseDefinition(b.definition || {}); if (!def.terms.length) throw new HttpError(400, "Add at least one term to watch for, for example KDF.");
    const now = nowISO(), hash = definitionHash(def);
    const id = Number(db.prepare("INSERT INTO watchlists(name,description,definition_json,definition_sha256,status,authorisation,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(name, String(b.description || "").trim().slice(0, 1000) || null, JSON.stringify(def), hash, "draft", String(b.authorisation || "").trim().slice(0, 1000) || null, user.id, now, user.id, now).lastInsertRowid);
    version(getWl(id), user, "created"); audit(user, "Watchlist created", "watchlist", String(id), { name, terms: def.terms.length, sources: def.sources });
    return id;
  }
  function update(user, id, b = {}) {
    const wl = getWl(id), def = b.definition ? normaliseDefinition(b.definition) : wl.definition;
    if (!def.terms.length) throw new HttpError(400, "Add at least one term to watch for.");
    const name = b.name != null ? String(b.name).trim().slice(0, 120) : wl.name; if (!name) throw new HttpError(400, "Give the watchlist a name.");
    // compare with the stored definition normalised the same way, so new optional settings added by an upgrade do not count as a change
    const hash = definitionHash(def), changed = hash !== definitionHash(normaliseDefinition(wl.definition));
    // a changed definition goes back to draft: it must be previewed and activated again before it collects
    const status = changed && wl.status === "active" ? "draft" : wl.status;
    db.prepare("UPDATE watchlists SET name = ?, description = ?, authorisation = ?, definition_json = ?, definition_sha256 = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(name, b.description != null ? String(b.description).trim().slice(0, 1000) || null : wl.description, b.authorisation != null ? String(b.authorisation).trim().slice(0, 1000) || null : wl.authorisation, changed ? JSON.stringify(def) : wl.definition_json, changed ? hash : wl.definition_sha256, status, user.id, nowISO(), wl.id);
    if (changed) version(getWl(wl.id), user, wl.status === "active" ? "definition changed; returned to draft until previewed and activated again" : "definition changed");
    audit(user, "Watchlist updated", "watchlist", String(wl.id), { name, definition_changed: changed, status });
    return { status, returned_to_draft: status !== wl.status };
  }
  function recordPreview(user, id, preview) {
    const wl = getWl(id), now = nowISO();
    db.prepare("UPDATE watchlists SET previewed_sha256 = ?, previewed_at = ?, previewed_by = ?, preview_json = ? WHERE id = ?").run(wl.definition_sha256, now, user.id, JSON.stringify({ ...preview, at: now }), wl.id);
    audit(user, "Watchlist previewed", "watchlist", String(wl.id), { local_matches: preview.local?.matched, live: preview.live?.map(l => ({ source: l.source, fetched: l.fetched, matched: l.matched, error: l.error })) });
  }
  function setStatus(user, id, status, sourcesReady) {
    const wl = getWl(id);
    if (status === "active") {
      if (wl.previewed_sha256 !== wl.definition_sha256) throw new HttpError(409, "Preview the matches for the current terms before activating. The watchlist changed since its last preview, or was never previewed.");
      const hasData = !!(wl.definition.all_datasets || wl.definition.datasets?.length);
      if (!wl.definition.sources.length && !hasData) throw new HttpError(400, "Choose at least one imported dataset or source to monitor.");
      // imported datasets carry their own source and authorisation; collecting from platforms needs a stated basis
      if (wl.definition.sources.length && !String(wl.authorisation || "").trim()) throw new HttpError(400, "State the basis on which these public posts may be collected (for example: the platform's API terms and your organisation's policy).");
      const notReady = wl.definition.sources.filter(s => !sourcesReady(s, wl));
      if (wl.definition.sources.length && notReady.length === wl.definition.sources.length && !hasData) throw new HttpError(409, `None of the chosen sources is connected: ${notReady.map(s => WATCH_SOURCES[s].label).join(", ")}. See Sources and status.`);
      if (wl.definition.sources.includes("news") && !wl.definition.feeds.length && !String(config.collect?.rssFeeds || "").trim()) throw new HttpError(400, "Name at least one news feed, or remove News websites from the sources.");
    }
    const now = nowISO();
    db.prepare(`UPDATE watchlists SET status = @status, ${status === "active" ? "activated_by = @u, activated_at = @now," : ""} updated_by = @u, updated_at = @now WHERE id = @id`).run({ status, u: user.id, now, id: wl.id });
    version(getWl(wl.id), user, status === "active" ? "activated" : status === "paused" ? "paused" : "set to draft");
    audit(user, `Watchlist ${status === "active" ? "activated" : status === "paused" ? "paused" : "set to draft"}`, "watchlist", String(wl.id), { definition_sha256: wl.definition_sha256, sources: wl.definition.sources });
    return getWl(wl.id);
  }
  const list = () => db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM watch_matches m WHERE m.watchlist_id = w.id AND coalesce(m.quality,'confirmed') NOT IN ('ambiguous','rejected')) matches, (SELECT COUNT(*) FROM watch_matches m WHERE m.watchlist_id = w.id AND m.quality = 'ambiguous') ambiguous,
      (SELECT COUNT(*) FROM watch_alerts a WHERE a.watchlist_id = w.id AND a.status = 'new') new_alerts, (SELECT MAX(detected_at) FROM watch_matches m WHERE m.watchlist_id = w.id AND coalesce(m.quality,'confirmed') NOT IN ('ambiguous','rejected')) last_match_at, (SELECT MAX(scanned_at) FROM watch_dataset_scans s WHERE s.watchlist_id = w.id) last_scan_at
      FROM watchlists w WHERE w.deleted_at IS NULL ORDER BY (w.status = 'active') DESC, w.id`).all().map(w => ({ ...w, definition: JSON.parse(w.definition_json), definition_json: undefined, preview_json: undefined, previewed_current: w.previewed_sha256 === w.definition_sha256 }));

  // ------------------------------------------------------------ ingesting collected posts
  // rows: { platform, post_id, url, account, author_name, text, language, posted_at, likes, comments, shares, views, repost_of, quote_of, collected_via }
  const insPost = db.prepare(`INSERT INTO watch_posts(platform,post_id,url,account,author_name,text,language,posted_at,first_detected_at,first_source,collected_via,repost_of,quote_of,text_hash,likes,comments,shares,views,metrics_at,metrics_source,dataset_id,io_post_id)
    VALUES (@platform,@post_id,@url,@account,@author_name,@text,@language,@posted_at,@now,@source,@collected_via,@repost_of,@quote_of,@text_hash,@likes,@comments,@shares,@views,@metrics_at,@metrics_source,@dataset_id,@io_post_id) ON CONFLICT(platform, post_id) DO NOTHING`);
  const getPost = db.prepare("SELECT * FROM watch_posts WHERE platform = ? AND post_id = ?");
  function observeMetrics(post, row, source, at) {
    const m = { likes: row.likes ?? null, comments: row.comments ?? null, shares: row.shares ?? null, views: row.views ?? null };
    if (Object.values(m).every(v => v == null)) return null;
    db.prepare("INSERT INTO watch_metrics(post_id,observed_at,source,likes,comments,shares,views) VALUES (?,?,?,?,?,?,?)").run(post.id, at, source, m.likes, m.comments, m.shares, m.views);
    db.prepare("UPDATE watch_posts SET likes = ?, comments = ?, shares = ?, views = ?, metrics_at = ?, metrics_source = ? WHERE id = ?").run(m.likes, m.comments, m.shares, m.views, at, source, post.id);
    return m;
  }
  // signalsOnly: imported datasets are analysed as a whole afterwards (watch-datasets.js), not post by post
  function ingest(wlOrId, source, rows, { runId = null, signalsOnly = false } = {}) {
    const wl = typeof wlOrId === "object" ? wlOrId : getWl(wlOrId), def = wl.definition, now = nowISO(), out = { fetched: rows.length, matched: 0, new_posts: 0, new_matches: 0, not_confirmed: 0, alerts: 0, reasons: {} }, cache = {};
    db.transaction(() => {
      for (const r of rows) {
        if (!r?.post_id || !String(r.text || "").trim()) continue;
        const m = matchPost(def, r);
        // an ambiguous keyword alone (CDF without military context) is kept for an analyst to decide, hidden from results, never alerted
        const hold = m.ambiguous && !def.exclude.some(t => re(t).test(fold(r.text))) && (!def.languages.length || !r.language || def.languages.includes(String(r.language).slice(0, 2).toLowerCase()));
        if (!m.matched && !hold) { out.not_confirmed++; out.reasons[m.why] = (out.reasons[m.why] || 0) + 1; continue; }
        if (hold) { out.ambiguous = (out.ambiguous || 0) + 1; out.reasons[m.why] = (out.reasons[m.why] || 0) + 1; } else out.matched++;
        const row = { platform: r.platform, post_id: String(r.post_id), url: r.url || null, account: r.account || null, author_name: r.author_name || null, text: String(r.text).slice(0, 10000), language: r.language || null,
          posted_at: r.posted_at || null, now, source, collected_via: r.collected_via || WATCH_SOURCES[source]?.label || MANUAL_SOURCES[source] || source, repost_of: r.repost_of || null, quote_of: r.quote_of || null,
          text_hash: sha(normForRepeat(r.text)), likes: r.likes ?? null, comments: r.comments ?? null, shares: r.shares ?? null, views: r.views ?? null, metrics_at: null, metrics_source: null,
          dataset_id: r.dataset_id ?? null, io_post_id: r.io_post_id ?? null };
        const isNew = insPost.run(row).changes > 0; if (isNew) out.new_posts++;
        let post = getPost.get(row.platform, row.post_id);
        if (r.image_url && /^https?:\/\//.test(r.image_url) && !post.image_url) { db.prepare("UPDATE watch_posts SET image_url = ? WHERE id = ?").run(String(r.image_url).slice(0, 2000), post.id); post = getPost.get(row.platform, row.post_id); }
        const metrics = observeMetrics(post, r, source, now);
        // already matched by this watchlist (another source, a retry, or a stream backfill): keep one record
        const existing = db.prepare("SELECT id FROM watch_matches WHERE watchlist_id = ? AND post_id = ?").get(wl.id, post.id);
        if (existing) { if (metrics && !hold) out.alerts += checkEngagement(wl, post.id); continue; }
        if (hold) { db.prepare("INSERT INTO watch_matches(watchlist_id,post_id,detected_at,source,terms_json,context_json,definition_sha256,cluster,is_repost,quality) VALUES (?,?,?,?,?,?,?,?,?,'ambiguous')")
          .run(wl.id, post.id, now, source, JSON.stringify(m.terms), "[]", wl.definition_sha256, null, r.repost_of ? 1 : 0); continue; }
        const cluster = r.repost_of ? null : clusterFor(wl, post, cache);
        if (cluster && cache.byHash && !cache.byHash.has(post.text_hash)) cache.byHash.set(post.text_hash, cluster);
        db.prepare("INSERT INTO watch_matches(watchlist_id,post_id,detected_at,source,terms_json,context_json,definition_sha256,cluster,is_repost,quality) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(wl.id, post.id, now, source, JSON.stringify(m.terms), JSON.stringify([...(m.context || []), ...(m.disambiguated_by || [])]), wl.definition_sha256, cluster, r.repost_of ? 1 : 0, m.quality || "confirmed");
        out.new_matches++;
        if (!r.repost_of && !signalsOnly) {
          const rep = checkRepeated(wl, cluster);
          out.alerts += rep.alert;
          if (def.alert_mode === "every_post" && rep.size <= 1) out.alerts += matchAlert(wl, post, m, source, now);
        }
      }
    })();
    if (runId) db.prepare("UPDATE watch_runs SET fetched = fetched + ?, matched = matched + ?, new_posts = new_posts + ?, not_confirmed = not_confirmed + ? WHERE id = ?").run(out.fetched, out.matched, out.new_matches, out.not_confirmed, runId);
    return out;
  }

  // ------------------------------------------------------------ alerts
  const addEvent = (alertId, action, user, note) => db.prepare("INSERT INTO watch_alert_events(alert_id,action,note,by_user,at) VALUES (?,?,?,?,?)").run(alertId, action, note || null, user?.id ?? null, nowISO());
  function raise(wl, kind, key, { post_id = null, title, reason, detail, severity = null }) {
    const sev = severity || SEVERITY_DEFAULT[kind] || "low";
    const now = nowISO(), r = db.prepare("INSERT INTO watch_alerts(watchlist_id,kind,dedupe_key,post_id,title,reason,detail_json,status,created_at,updated_at,severity) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING")
      .run(wl.id, kind, key, post_id, title.slice(0, 300), reason, JSON.stringify({ ...detail, recommended_action: detail?.recommended_action || ACTION[kind] }), "new", now, now, sev);
    if (r.changes) { addEvent(Number(r.lastInsertRowid), "raised", null, reason); return 1; }
    return 0;
  }
  function matchAlert(wl, post, m, source, now) {
    const lag = post.posted_at ? Math.round((Date.parse(now) - Date.parse(post.posted_at)) / 60000) : null;
    return raise(wl, "match", `m:${wl.id}:${post.id}`, { post_id: post.id, title: `${post.platform}: ${post.text.replace(/\s+/g, " ").slice(0, 120)}`,
      reason: `Matched watchlist “${wl.name}”: ${m.terms.map(t => `“${t}”`).join(", ")}${m.context?.length ? `, with context ${m.context.map(t => `“${t}”`).join(", ")}` : ""}${m.disambiguated_by?.length ? `. Contextual match: the ambiguous keyword appears with ${m.disambiguated_by.map(t => `“${t}”`).join(", ")}; confirm that it concerns this subject` : ""}${m.analyst ? `. Ambiguous keyword confirmed as relevant by ${m.analyst}` : ""}. Found by ${WATCH_SOURCES[source]?.label || MANUAL_SOURCES[source] || source}.`,
      detail: { terms: m.terms, context: m.context || [], quality: m.analyst ? "analyst" : m.quality || "confirmed", disambiguated_by: m.disambiguated_by || [], source, detection_lag_minutes: lag, language_unknown: !!m.language_unknown } });
  }
  // the earliest similar post among this watchlist's recent matches decides the cluster (same normalised wording, or nearly the same)
  // cache: within one ingest call, the cluster representatives and their word sequences are read once
  function clusterFor(wl, post, cache = null) {
    const T = wl.definition.thresholds, since = new Date(Date.now() - T.repeat_window_h * 3600e3).toISOString();
    if (cache && !cache.byHash) { cache.byHash = new Map(); for (const r of db.prepare("SELECT p.text_hash h, m.cluster c FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND m.cluster IS NOT NULL ORDER BY m.id DESC").all(wl.id)) cache.byHash.set(r.h, r.c); }
    const same = cache ? (cache.byHash.has(post.text_hash) ? { cluster: cache.byHash.get(post.text_hash) } : null)
      : db.prepare("SELECT m.cluster FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND p.text_hash = ? AND m.cluster IS NOT NULL ORDER BY m.id LIMIT 1").get(wl.id, post.text_hash);
    if (same) return same.cluster;
    if (normForRepeat(post.text).split(" ").length >= 6) {
      let reps = cache?.reps;
      if (!reps) { reps = db.prepare(`SELECT m.cluster, p.text FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND m.is_repost = 0 AND m.detected_at >= ? AND m.cluster = p.text_hash ORDER BY m.id DESC LIMIT 400`).all(wl.id, since).map(r => ({ cluster: r.cluster, sh: shingles(r.text) })); if (cache) cache.reps = reps; }
      const sh = shingles(post.text);
      for (const r of reps) { let n = 0; for (const x of sh) if (r.sh.has(x)) n++; const sim = sh.size && r.sh.size ? n / (sh.size + r.sh.size - n) : 0; if (sim >= T.repeat_similarity) return r.cluster; }
      if (cache) { reps.unshift({ cluster: post.text_hash, sh }); if (reps.length > 400) reps.pop(); }
    }
    return post.text_hash;
  }
  function checkRepeated(wl, cluster) {
    const T = wl.definition.thresholds, since = new Date(Date.now() - T.repeat_window_h * 3600e3).toISOString();
    const ps = db.prepare(`SELECT p.id, p.account, p.platform, p.posted_at, p.url, p.text, m.detected_at FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id
      WHERE m.watchlist_id = ? AND m.cluster = ? AND m.is_repost = 0 AND coalesce(m.quality,'confirmed') NOT IN ('ambiguous','rejected') AND coalesce(p.posted_at, m.detected_at) >= ? ORDER BY coalesce(p.posted_at, m.detected_at)`).all(wl.id, cluster, since);
    const accounts = new Set(ps.map(p => String(p.account || "").toLowerCase()).filter(Boolean));
    if (ps.length < T.repeat_min_posts || accounts.size < T.repeat_min_accounts) return { size: ps.length, alert: 0 };
    const first = ps[0], key = `rep:${wl.id}:${cluster}`;
    const detail = { posts: ps.length, accounts: accounts.size, platforms: [...new Set(ps.map(p => p.platform))], first_at: first.posted_at || first.detected_at, last_at: ps.at(-1).posted_at || ps.at(-1).detected_at,
      window_h: T.repeat_window_h, threshold_posts: T.repeat_min_posts, threshold_accounts: T.repeat_min_accounts, similarity: T.repeat_similarity, post_ids: ps.slice(0, 50).map(p => p.id) };
    const reason = `${ps.length} posts from ${accounts.size} account${accounts.size === 1 ? "" : "s"} used the same or nearly the same wording within ${T.repeat_window_h} h (threshold: at least ${T.repeat_min_posts} posts from ${T.repeat_min_accounts} accounts; “nearly the same” means at least ${Math.round(T.repeat_similarity * 100)}% of three-word sequences shared). Repeated wording can be genuine sharing of news; it is not proof of coordination.`;
    const ex = db.prepare("SELECT id, status, detail_json FROM watch_alerts WHERE dedupe_key = ?").get(key);
    if (ex) {
      const old = JSON.parse(ex.detail_json);
      if (old.posts !== ps.length) { db.prepare("UPDATE watch_alerts SET reason = ?, detail_json = ?, updated_at = ? WHERE id = ?").run(reason, JSON.stringify(detail), nowISO(), ex.id); addEvent(ex.id, "updated", null, `now ${ps.length} posts from ${accounts.size} accounts`); }
      return { size: ps.length, alert: 0 };
    }
    return { size: ps.length, alert: raise(wl, "repeated", key, { post_id: first.id, title: `Repeated wording: ${first.text.replace(/\s+/g, " ").slice(0, 110)}`, reason, detail }) };
  }
  // engagement: compares the public counts observed for one post at two collection times
  function checkEngagement(wl, postId) {
    const T = wl.definition.thresholds, snaps = db.prepare("SELECT * FROM watch_metrics WHERE post_id = ? ORDER BY observed_at DESC LIMIT 50").all(postId);
    if (snaps.length < 2) return 0;
    const now = snaps[0], parts = engagementParts(now), cutoff = Date.parse(now.observed_at) - T.engagement_window_h * 3600e3;
    // the earliest observation inside the window that reported the same counts
    const prev = snaps.slice(1).filter(s => Date.parse(s.observed_at) >= cutoff && engagementParts(s).join() === parts.join()).at(-1);
    if (!prev || !parts.length) return 0;
    const a = engagementOf(prev), b = engagementOf(now), d = b - a;
    if (d < T.engagement_min_increase || b < T.engagement_ratio * Math.max(1, a)) return 0;
    const post = db.prepare("SELECT * FROM watch_posts WHERE id = ?").get(postId), hours = (Date.parse(now.observed_at) - Date.parse(prev.observed_at)) / 3600e3;
    return raise(wl, "engagement", `eng:${wl.id}:${postId}:${now.observed_at.slice(0, 10)}`, { post_id: postId, title: `Engagement rising: ${post.text.replace(/\s+/g, " ").slice(0, 110)}`,
      reason: `Public engagement (${parts.join(" + ")}) reported by the platform rose from ${a} to ${b} (+${d}) between ${prev.observed_at.slice(0, 16).replace("T", " ")} and ${now.observed_at.slice(0, 16).replace("T", " ")} UTC (${hours.toFixed(1)} h). Threshold: an increase of at least ${T.engagement_min_increase} and at least ${T.engagement_ratio}× the earlier figure within ${T.engagement_window_h} h. These are observed counts, not an estimate of reach.`,
      detail: { from: prev, to: now, increase: d, counted: parts, views_from: prev.views, views_to: now.views, threshold_increase: T.engagement_min_increase, threshold_ratio: T.engagement_ratio, window_h: T.engagement_window_h } });
  }
  // volume: matched posts (by publication time) in the latest window against the windows before it
  function volume(wlOrId, { at = Date.now() } = {}) {
    const wl = typeof wlOrId === "object" ? wlOrId : getWl(wlOrId), T = wl.definition.thresholds, W = T.volume_window_min * 60e3, N = T.volume_baseline_windows;
    const end = at, start = end - (N + 1) * W, rows = db.prepare(`SELECT coalesce(p.posted_at, m.detected_at) t FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND coalesce(m.quality,'confirmed') NOT IN ('ambiguous','rejected') AND coalesce(p.posted_at, m.detected_at) >= ? AND coalesce(p.posted_at, m.detected_at) < ?`)
      .all(wl.id, new Date(start).toISOString(), new Date(end).toISOString());
    const counts = Array(N + 1).fill(0); for (const r of rows) { const i = Math.floor((Date.parse(r.t) - start) / W); if (i >= 0 && i <= N) counts[i]++; }
    const current = counts[N], base = counts.slice(0, N), mean = base.reduce((a, b) => a + b, 0) / N, sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / N);
    const out = { window_min: T.volume_window_min, baseline_windows: N, current, mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, series: counts, window_end: new Date(end).toISOString(),
      threshold: { min_posts: T.volume_min_posts, ratio: T.volume_ratio, sd: T.volume_sd }, sufficient: true, insufficient_reason: null, coverage: null, spike: false };
    // enough history: active for the whole baseline, and collection actually ran for most of it
    const act = wl.activated_at ? Date.parse(wl.activated_at) : null;
    if (wl.status !== "active" || !act || act > start) { out.sufficient = false; out.insufficient_reason = `needs ${N} earlier windows of ${T.volume_window_min} min of continuous collection (about ${Math.round((N + 1) * T.volume_window_min / 60)} h after activation)`; return out; }
    const runs = db.prepare("SELECT source, status, started_at, window_from, window_to FROM watch_runs WHERE watchlist_id = ? AND started_at >= ? AND kind != 'preview'").all(wl.id, new Date(start).toISOString());
    const sched = runs.filter(r => r.source !== "x_stream"), okShare = sched.length ? sched.filter(r => ["ok", "partial"].includes(r.status)).length / sched.length : 1;
    const gaps = db.prepare("SELECT window_from, window_to FROM watch_runs WHERE source = 'x_stream' AND status = 'failed' AND window_to >= ?").all(new Date(start).toISOString());
    const gapMs = gaps.reduce((a, g) => a + Math.max(0, Math.min(end, Date.parse(g.window_to)) - Math.max(start, Date.parse(g.window_from))), 0);
    const streamShare = wl.definition.sources.includes("x_stream") ? 1 - gapMs / (end - start) : 1;
    out.coverage = Math.round(Math.min(okShare, streamShare) * 100) / 100;
    if (!sched.length && !wl.definition.sources.includes("x_stream")) { out.sufficient = false; out.insufficient_reason = "no collection runs were recorded in the baseline period"; return out; }
    if (out.coverage < T.volume_min_coverage) { out.sufficient = false; out.insufficient_reason = `collection succeeded for only ${Math.round(out.coverage * 100)}% of the baseline period (at least ${Math.round(T.volume_min_coverage * 100)}% needed), so a rise could be an artefact of missed collection`; return out; }
    out.spike = current >= T.volume_min_posts && current >= T.volume_ratio * mean && current >= mean + T.volume_sd * sd;
    return out;
  }
  function checkVolume(wl) {
    const v = volume(wl); if (!v.sufficient || !v.spike) return 0;
    const W = v.window_min * 60e3, slot = new Date(Math.floor(Date.parse(v.window_end) / W) * W).toISOString();
    return raise(wl, "volume", `vol:${wl.id}:${slot}`, { title: `Unusual rise in mentions: ${v.current} posts in ${v.window_min} min (${wl.name})`,
      reason: `${v.current} matching posts were published in the last ${v.window_min} min, against an average of ${v.mean} (standard deviation ${v.sd}) in each of the previous ${v.baseline_windows} windows. Threshold: at least ${v.threshold.min_posts} posts, at least ${v.threshold.ratio}× the average and at least ${v.threshold.sd} standard deviations above it. Collection covered ${Math.round(v.coverage * 100)}% of the period. A rise can follow genuine news; it is not proof of coordination.`,
      detail: v });
  }

  // ------------------------------------------------------------ the queue
  const alertRow = a => ({ ...a, detail: JSON.parse(a.detail_json), detail_json: undefined });
  function alerts(q = {}, user) {
    const w = ["1"], P = [];
    if (["new", "acknowledged", "dismissed", "converted"].includes(q.status)) { w.push("a.status = ?"); P.push(q.status); } else if (q.status === "open") w.push("a.status IN ('new','acknowledged')");
    if (ALERT_KINDS.includes(q.kind)) { w.push("a.kind = ?"); P.push(q.kind); }
    if (["high", "medium", "low"].includes(q.severity)) { w.push("a.severity = ?"); P.push(q.severity); }
    if (q.watchlist) { w.push("a.watchlist_id = ?"); P.push(Number(q.watchlist)); }
    if (q.mine === "1" && user) { w.push("a.assigned_to = ?"); P.push(user.id); }
    if (q.platform) { w.push("p.platform = ?"); P.push(String(q.platform)); }
    if (q.q) { w.push("(lower(a.title) LIKE ? OR lower(p.text) LIKE ?)"); P.push(`%${String(q.q).toLowerCase().slice(0, 100)}%`, `%${String(q.q).toLowerCase().slice(0, 100)}%`); }
    const limit = Math.min(100, Math.max(1, +q.limit || 30)), offset = Math.max(0, +q.offset || 0), where = w.join(" AND ");
    const total = db.prepare(`SELECT COUNT(*) n FROM watch_alerts a LEFT JOIN watch_posts p ON p.id = a.post_id WHERE ${where}`).get(...P).n;
    const rows = db.prepare(`SELECT a.*, w.name watchlist_name, w.definition_json, u.display_name assigned_name, p.platform, p.url, p.account, p.author_name, p.text post_text, p.posted_at, p.first_detected_at, p.first_source, p.collected_via,
        p.likes, p.comments, p.shares, p.views, p.metrics_at, p.metrics_source, p.language
      FROM watch_alerts a JOIN watchlists w ON w.id = a.watchlist_id LEFT JOIN watch_posts p ON p.id = a.post_id LEFT JOIN users u ON u.id = a.assigned_to
      WHERE ${where} ORDER BY (a.status = 'new') DESC, a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`).all(...P, limit, offset)
      .map(a => ({ ...alertRow(a), definition_json: undefined, highlights: a.post_text ? highlights(JSON.parse(a.definition_json), a.post_text) : [] }));
    const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM watch_alerts GROUP BY status").all().map(r => [r.status, r.n]));
    return { total, offset, limit, counts, alerts: rows };
  }
  function alert(id) {
    const a = db.prepare(`SELECT a.*, w.name watchlist_name, w.definition_json, u.display_name assigned_name FROM watch_alerts a JOIN watchlists w ON w.id = a.watchlist_id LEFT JOIN users u ON u.id = a.assigned_to WHERE a.id = ?`).get(Number(id));
    if (!a) throw new HttpError(404, "Alert not found.");
    const def = JSON.parse(a.definition_json), post = a.post_id ? db.prepare("SELECT * FROM watch_posts WHERE id = ?").get(a.post_id) : null, d = JSON.parse(a.detail_json);
    const ids = d.post_ids ? d.post_ids : a.kind === "volume" ? db.prepare(`SELECT p.id FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND coalesce(p.posted_at, m.detected_at) >= ? AND coalesce(p.posted_at, m.detected_at) < ? ORDER BY coalesce(p.posted_at, m.detected_at) DESC LIMIT 50`).all(a.watchlist_id, new Date(Date.parse(d.window_end) - d.window_min * 60e3).toISOString(), d.window_end).map(r => r.id) : [];
    const related = ids.length ? db.prepare(`SELECT * FROM watch_posts WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY coalesce(posted_at, first_detected_at)`).all(...ids) : [];
    const matchOf = pid => db.prepare("SELECT source, detected_at, terms_json FROM watch_matches WHERE watchlist_id = ? AND post_id = ?").get(a.watchlist_id, pid);
    const withMatch = p => p && ({ ...p, match: (m => m && { ...m, terms: JSON.parse(m.terms_json), terms_json: undefined })(matchOf(p.id)), highlights: highlights(def, p.text), metrics: db.prepare("SELECT observed_at, source, likes, comments, shares, views FROM watch_metrics WHERE post_id = ? ORDER BY observed_at").all(p.id) });
    const events = db.prepare("SELECT e.*, u.display_name by_name FROM watch_alert_events e LEFT JOIN users u ON u.id = e.by_user WHERE alert_id = ? ORDER BY e.id").all(a.id);
    return { ...alertRow(a), definition_json: undefined, post: withMatch(post), related: related.map(withMatch), events };
  }
  const mustAlert = id => { const a = db.prepare("SELECT * FROM watch_alerts WHERE id = ?").get(Number(id)); if (!a) throw new HttpError(404, "Alert not found."); return a; };
  function act(user, id, b = {}, { canAssignOthers, canCreateCase } = {}) {
    const a = mustAlert(id), action = b.action, note = String(b.note || "").trim().slice(0, 2000) || null, now = nowISO();
    const set = (fields, ev, evNote) => { const cols = Object.keys(fields); db.prepare(`UPDATE watch_alerts SET ${cols.map(c => `${c} = @${c}`).join(", ")}, updated_at = @now, updated_by = @uid WHERE id = @id`).run({ ...fields, now, uid: user.id, id: a.id }); addEvent(a.id, ev, user, evNote); audit(user, `Mention alert ${ev}`, "watch_alert", String(a.id), { kind: a.kind, note: evNote || null, ...fields }); };
    if (a.status === "converted" && action !== "assign") throw new HttpError(409, `This alert became case ${a.case_id}; continue there.`);
    if (action === "acknowledge") { if (a.status !== "new") throw new HttpError(409, "Only new alerts can be acknowledged."); set({ status: "acknowledged" }, "acknowledged", note); }
    else if (action === "dismiss") { if (!note) throw new HttpError(400, "Say why the alert needs no further work (for example: unrelated use of the term, already known, routine news)."); set({ status: "dismissed", note }, "dismissed", note); }
    else if (action === "reopen") { if (a.status !== "dismissed" && a.status !== "acknowledged") throw new HttpError(409, "Only acknowledged or dismissed alerts can be reopened."); set({ status: "new" }, "reopened", note); }
    else if (action === "assign") {
      const uid = b.user_id == null || b.user_id === "" ? null : Number(b.user_id);
      if (uid !== null) { const u = db.prepare("SELECT id, role, active, display_name FROM users WHERE id = ?").get(uid); if (!u || !u.active || u.role === "viewer") throw new HttpError(400, "Choose an active analyst, reviewer or administrator."); }
      if (uid !== user.id && !canAssignOthers) throw new HttpError(403, "Your role can assign alerts only to yourself.");
      set({ assigned_to: uid, ...(a.status === "new" && uid ? { status: "acknowledged" } : {}) }, uid ? "assigned" : "unassigned", uid ? `to ${db.prepare("SELECT display_name FROM users WHERE id = ?").get(uid).display_name}${note ? `: ${note}` : ""}` : note);
    } else if (action === "convert") {
      if (!canCreateCase) throw new HttpError(403, "Your role cannot open cases.");
      const full = alert(a.id), post = full.post, claim = String(b.claim_text || "").trim() || (!["volume", "threshold", "narrative"].includes(a.kind) && post ? post.text : "");
      if (!claim) throw new HttpError(400, "This alert is about volume, not one post. Write the claim to verify (or choose one of the posts listed).");
      const caseId = cases.create(user, { title: String(b.title || "").trim() || `AI Watchlist: ${claim.replace(/\s+/g, " ").slice(0, 80)}`, claim_text: claim, source_platform: post?.platform || "AI Watchlist",
        source_url: post?.url || null, source_account: a.kind === "repeated" ? `${full.detail.accounts} accounts (mention alert ${a.id})` : post?.account || null,
        published_at: post?.posted_at || null, published_basis: post?.posted_at ? `publication time reported by ${post.platform} (${post.collected_via})` : null, received_at: now, priority: ["urgent", "priority"].includes(b.priority) ? b.priority : "routine",
        hashtags: post ? [...new Set(post.text.match(/#[\p{L}\p{N}_]+/gu) || [])].join(" ") || null : null });
      set({ status: "converted", case_id: caseId }, "converted", `case ${caseId}`);
      // the alert itself becomes a suggested lead in the case, so its reason and supporting posts can be accepted into the report
      const support = (full.related.length ? full.related : post ? [post] : []).slice(0, 10);
      const eid = `E-${String(db.prepare("INSERT INTO counters(name,value) VALUES ('evidence',1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get().value).padStart(6, "0")}`;
      db.prepare("INSERT INTO evidence(id,case_id,kind,origin,status,text,reference,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(eid, caseId, "lead", "system", "suggested",
        `AI Watchlist alert ${a.id} (${a.kind}${a.severity ? `, ${a.severity} severity` : ""}) from watchlist “${full.watchlist_name}”: ${a.reason}`.slice(0, 4000),
        `AI Watchlist alert ${a.id}, raised ${a.created_at}; supporting posts: ${support.map(p => p.url || `${p.platform} post ${p.post_id}${p.dataset_id ? ` (dataset ${p.dataset_id})` : ""}`).join("; ") || "none listed"}`.slice(0, 1000), user.id, now);
      audit(user, `Case opened from mention alert ${a.id}`, "case", caseId, { alert_kind: a.kind, watchlist_id: a.watchlist_id, post_url: post?.url || null, detected_at: post?.first_detected_at || a.created_at });
      return { case_id: caseId };
    } else throw new HttpError(400, "Unknown action. Use acknowledge, dismiss, assign, reopen or convert.");
    return { ok: true };
  }
  // posts matched by a watchlist (also shown when alerts are only raised for signals)
  function matches(id, q = {}) {
    const wl = getWl(id), limit = Math.min(200, Math.max(1, +q.limit || 50)), offset = Math.max(0, +q.offset || 0);
    const qf = q.quality === "ambiguous" ? "m.quality = 'ambiguous'" : q.quality === "all" ? "1" : "coalesce(m.quality,'confirmed') NOT IN ('ambiguous','rejected')";
    const total = db.prepare(`SELECT COUNT(*) n FROM watch_matches m WHERE m.watchlist_id = ? AND ${qf}`).get(wl.id).n;
    const rows = db.prepare(`SELECT p.*, m.detected_at, m.source, m.terms_json, m.is_repost, coalesce(m.quality,'confirmed') quality FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND ${qf} ORDER BY m.detected_at DESC, m.id DESC LIMIT ? OFFSET ?`).all(wl.id, limit, offset)
      .map(r => ({ ...r, terms: JSON.parse(r.terms_json), terms_json: undefined, highlights: highlights(wl.definition, r.text) }));
    return { total, offset, limit, posts: rows };
  }
  // an analyst decides an ambiguous match: relevant (kept, and alerted like any match) or not relevant (hidden for good)
  function reviewMatch(user, id, postId, relevant, note = "") {
    const wl = getWl(id), m = db.prepare("SELECT * FROM watch_matches WHERE watchlist_id = ? AND post_id = ?").get(wl.id, Number(postId));
    if (!m) throw new HttpError(404, "This item is not held by the watchlist.");
    if (!["ambiguous", "analyst", "rejected"].includes(m.quality)) throw new HttpError(409, "Only matches of an ambiguous keyword are decided by an analyst; this one was confirmed by its keywords.");
    const q = relevant ? "analyst" : "rejected", now = nowISO();
    db.prepare("UPDATE watch_matches SET quality = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(q, user.id, now, m.id);
    let alerts = 0;
    if (relevant && m.quality !== "analyst" && wl.definition.alert_mode === "every_post") {
      const post = db.prepare("SELECT * FROM watch_posts WHERE id = ?").get(m.post_id);
      alerts = matchAlert(wl, post, { terms: JSON.parse(m.terms_json), context: [], analyst: user.display_name || user.username }, m.source, now);
    }
    audit(user, relevant ? "Ambiguous match confirmed as relevant" : "Ambiguous match marked not relevant", "watchlist", String(wl.id), { post_id: m.post_id, terms: JSON.parse(m.terms_json), note: String(note || "").slice(0, 300) || undefined });
    return { quality: q, alerts };
  }
  // delete: the watchlist is hidden and stops; its history, matched posts and alerts are kept; open alerts are closed with a note
  function remove(user, id) {
    const wl = getWl(id); if (wl.deleted_at) return;
    const now = nowISO(), open = db.prepare("SELECT id FROM watch_alerts WHERE watchlist_id = ? AND status IN ('new','acknowledged')").all(wl.id);
    db.transaction(() => {
      db.prepare("UPDATE watchlists SET status = 'paused', deleted_at = ?, deleted_by = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(now, user.id, user.id, now, wl.id);
      for (const a of open) { db.prepare("UPDATE watch_alerts SET status = 'dismissed', note = ?, updated_at = ?, updated_by = ? WHERE id = ?").run("Watchlist deleted", now, user.id, a.id); addEvent(a.id, "dismissed", user, "watchlist deleted"); }
      version(getWl(wl.id), user, "deleted");
    })();
    audit(user, "Watchlist deleted", "watchlist", String(wl.id), { name: wl.name, open_alerts_closed: open.length });
  }
  return { create, update, recordPreview, setStatus, reviewMatch, list, get: getWl, ingest, remove, raise, addEvent, checkVolume, checkEngagement, volume, alerts, alert, act, matches, observeMetrics };
}

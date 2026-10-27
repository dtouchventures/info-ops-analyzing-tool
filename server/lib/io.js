// Information operations monitor: import post datasets the operator is permitted to use, and compute
// coordination SIGNALS (repeated messages, synchronised posting, hashtag bursts, shared links, co-activity).
// Signals are leads for an analyst. They are never findings, never proof, and never attribution.
import crypto from "node:crypto";
import { HttpError } from "./auth.js";
import { nowISO } from "./db.js";
import { unzip } from "./docs.js";
import { enrichPosts, filterSql, cleanFilters } from "./social-analysis.js";

export const CAVEATS = [
  "These are statistical signals for an analyst to investigate. They are not proof of coordination, automation or intent.",
  "Many genuine users repeat slogans, share the same link or join a trending hashtag at the same time, especially around news events.",
  "AIVS does not attribute activity to any person, organisation or state. Attribution needs independent, verifiable evidence.",
  "Results depend entirely on the dataset: how it was collected, what was left out, and whether timestamps are accurate."
];

// ---------------------------------------------------------------- parsing
// RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, comma/semicolon/tab delimiters.
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "", delim = [",", ";", "\t"].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"' && f === "") q = true;
    else if (c === delim) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some(x => x !== "")) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some(x => x !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// common column names in platform exports and research tools
const ALIASES = {
  text: ["text", "content", "message", "body", "post", "tweet", "full_text", "caption", "post_text", "description"],
  account: ["account", "author", "username", "user", "screen_name", "handle", "user_screen_name", "author_username", "from", "page", "channel", "user_name"],
  posted_at: ["posted_at", "created_at", "date", "time", "timestamp", "datetime", "published_at", "post_date", "created", "date_time", "time_utc"],
  post_id: ["post_id", "id", "tweet_id", "status_id", "message_id", "url_id"],
  platform: ["platform", "source", "network", "site"],
  url: ["url", "link", "permalink", "post_url"],
  reply_to: ["reply_to", "in_reply_to", "in_reply_to_screen_name", "reply_to_user", "replied_to"],
  repost_of: ["repost_of", "retweet_of", "retweeted_status_id", "shared_from", "retweeted_user", "repost_of_account", "forwarded_from"],
  likes: ["likes", "like_count", "favorite_count", "reactions", "favourites", "public_metrics_like_count", "statistics_likecount"],
  comments: ["comments", "comment_count", "replies", "reply_count", "public_metrics_reply_count", "statistics_commentcount"],
  shares: ["shares", "share_count", "retweet_count", "reposts", "forwards", "public_metrics_retweet_count"],
  views: ["views", "view_count", "views_count", "plays", "play_count", "impression_count", "public_metrics_impression_count", "statistics_viewcount"],
  language: ["language", "lang", "post_language"],
  collected_at: ["collected_at", "retrieved_at", "scraped_at", "collection_time", "downloaded_at"],
  loc_country: ["loc_country", "country", "country_code", "place_country", "place_country_code", "geo_country"],
  loc_region: ["loc_region", "region", "county", "state", "province", "place_region", "admin1"],
  loc_name: ["loc_name", "place", "place_name", "place_full_name", "location_name", "geo_place", "city", "town", "location"],
  profile_location: ["user_location", "author_location", "profile_location", "account_location"],
  account_created_at: ["account_created_at", "user_created_at", "author_created_at", "account_created"]
};
export function detectMapping(columns, overrides = {}) {
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const cols = columns.map(c => [c, norm(c)]), m = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    if (overrides[field] && columns.includes(overrides[field])) { m[field] = overrides[field]; continue; }
    const hit = names.map(n => cols.find(([, nc]) => nc === n)).find(Boolean); if (hit) m[field] = hit[0];
  }
  return m;
}
const flatten = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o || {})) { const key = p ? `${p}_${k}` : k; if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out); else out[key] = Array.isArray(v) ? v.join(" ") : v; } return out; };
// recognise files that are not post tables, and say what to do instead
function notATable(buf, name) {
  const h = buf.subarray(0, 8), hex = h.toString("hex"), ext = (String(name).match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  if (hex.startsWith("504b0304") && ext === "xlsx") return null;   // Excel workbook: read by parseXlsx
  if (hex.startsWith("ffd8ff") || hex.startsWith("89504e47") || hex.startsWith("47494638") || h.subarray(0, 4).toString() === "RIFF" || ["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(ext))
    return "This is a picture, not a list of posts. The monitor looks for patterns across many posts, so it needs a table (CSV or JSON). To check a single post or screenshot, use Verify information or New case (files) instead.";
  if (h.subarray(0, 4).toString() === "%PDF" || ext === "pdf") return "This is a PDF, not a list of posts. Copy the posts into a spreadsheet (one row per post: account, posted_at, text), save it as CSV, and import that.";
  if (ext === "xls") return "This is an old Excel file (.xls). In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV UTF-8, then import that file.";
  if (hex.startsWith("504b0304") && ext !== "xlsx") return ext && ext.startsWith("doc") ? "This is a Word document, not a list of posts. Put the posts in a spreadsheet (one row per post: account, posted_at, text) and save it as .xlsx or CSV." : "This is a compressed file that is not an Excel workbook. Import a .xlsx, .csv or .json file of posts.";
  if (["mp4", "mov", "avi", "mkv", "mp3", "wav"].includes(ext) || hex.slice(8, 16) === "66747970") return "This is a video or audio file, not a list of posts. To examine a video, use New case (files).";
  const sample = buf.subarray(0, 2000); let bad = 0; for (const b of sample) if (b === 0 || (b < 9)) bad++;
  if (bad > 5) return "This file is not text. The monitor needs a CSV or JSON table of posts (one row per post: account, posted_at, text).";
  return null;
}
// Excel .xlsx (first worksheet): read with the built-in unzip; no spreadsheet library needed
export function parseXlsx(buf) {
  let files; try { files = unzip(buf, n => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(n)).files; } catch (e) { throw new HttpError(400, `The Excel file could not be opened (${e.message}).`); }
  const get = n => files.get(n)?.toString("utf8");
  const dec = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
  const wb = get("xl/workbook.xml"); if (!wb) throw new HttpError(400, "This .xlsx file has no workbook. Save it again from Excel and retry.");
  const rid = (/<sheet\b[^>]*r:id="([^"]+)"/.exec(wb) || [])[1], rels = get("xl/_rels/workbook.xml.rels") || "";
  let target = rid && (new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels) || [])[1];
  target = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`) : "xl/worksheets/sheet1.xml";
  const sheet = get(target); if (!sheet) throw new HttpError(400, "The first worksheet could not be read.");
  const shared = [...(get("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => dec([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  const colNo = ref => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1], ref = (/\br="([A-Z]+\d+)"/.exec(a) || [])[1], t = (/\bt="(\w+)"/.exec(a) || [])[1], inner = cm[2] || "";
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      const val = t === "s" ? shared[+v] ?? "" : t === "inlineStr" ? dec([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join("")) : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v != null ? dec(v) : "";
      r[ref ? colNo(ref) : r.length] = val;
    }
    if (r.some(x => x !== undefined && x !== "")) rows.push(Array.from(r, x => x ?? ""));
  }
  if (rows.length < 2) return [];
  const head = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]).filter(([h]) => h)));
}
export function parseFile(buf, name) {
  const why = notATable(buf, name); if (why) throw new HttpError(400, why);
  if (/\.xlsx$/i.test(name) || buf.subarray(0, 4).toString("hex") === "504b0304") return parseXlsx(buf);
  const s = buf.toString("utf8").trim();
  if (/\.json$/i.test(name) || s.startsWith("[") || s.startsWith("{")) {
    let j; try { j = JSON.parse(s); } catch { try { j = s.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); } catch { throw new HttpError(400, "The file is not valid JSON or JSON Lines."); } }
    const arr = Array.isArray(j) ? j : Array.isArray(j?.posts) ? j.posts : Array.isArray(j?.data) ? j.data : null;
    if (!arr) throw new HttpError(400, "The JSON must be a list of posts, or an object with a \"posts\" or \"data\" list.");
    return arr.map(x => flatten(x));
  }
  return parseCsv(s);
}
const tagsOf = t => [...new Set((String(t).match(/(^|[^\p{L}\p{N}_&/#])#[\p{L}\p{N}_]{2,60}/gu) || []).map(h => "#" + h.trim().replace(/^[^#]+/, "").slice(1).toLowerCase()))];
const mentionsOf = t => [...new Set((String(t).match(/(^|[^\p{L}\p{N}_@])@[A-Za-z0-9_.]{2,40}/g) || []).map(h => h.trim().replace(/^[^@]+/, "").toLowerCase()))];
const urlsOf = t => [...new Set(String(t).match(/https?:\/\/[^\s<>"'“”)\]]+/g) || [])].map(u => u.replace(/[.,;:!?]+$/, ""));
const cleanAcct = a => String(a || "").trim().replace(/^@/, "").toLowerCase().slice(0, 80);
const num = (r, col) => { if (!col) return null; const v = String(r[col] ?? "").replace(/[,\s]/g, ""); if (v === "") return null; const m = /^(\d+(?:\.\d+)?)([kmb])?$/i.exec(v); if (!m) return null; return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || "").toLowerCase()] || 1)); };
// location recorded with the post (platform place/geo fields) is kept apart from a self-reported profile location
function location(r, m) {
  const g = k => (m[k] ? String(r[m[k]] ?? "").trim().slice(0, 120) : "") || null;
  const country = g("loc_country"), region = g("loc_region"), name = g("loc_name");
  if (country || region || name) return { loc_country: country, loc_region: region, loc_name: name, loc_basis: "post" };
  const prof = g("profile_location"); if (prof) return { loc_country: null, loc_region: null, loc_name: prof, loc_basis: "profile" };
  return { loc_country: null, loc_region: null, loc_name: null, loc_basis: null };
}
function toISO(v) {
  if (v == null || v === "") return null;
  if (/^\d{10}(\.\d+)?$/.test(String(v))) return new Date(Number(v) * 1000).toISOString();
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString();
  if (/^\d{5}(\.\d+)?$/.test(String(v)) && +v > 20000 && +v < 80000) return new Date(Math.round((Number(v) - 25569) * 864e5)).toISOString();   // Excel date serial (days since 1899-12-30)
  const d = new Date(String(v).replace(/^(\d{4}-\d\d-\d\d) (\d)/, "$1T$2")); return isNaN(d) ? null : d.toISOString();
}

// ---------------------------------------------------------------- near-duplicate detection (MinHash + LSH)
const STOPW = new Set("the a an and or of to in on at for is are was were be this that it rt via na ya wa kwa ni la za".split(" "));
export function normText(t) { return String(t || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/@[a-z0-9_.]+/g, " ").replace(/[^\p{L}\p{N}#\s]/gu, " ").replace(/\s+/g, " ").trim(); }
function shingles(t) {
  const w = normText(t).split(" ").filter(x => x && !STOPW.has(x));
  if (w.length < 2) return new Set(w.length ? [w[0]] : []);
  const s = new Set(); for (let i = 0; i + 1 < w.length; i++) s.add(`${w[i]} ${w[i + 1]}`); return s;   // word pairs: robust to small edits in short posts
}
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
const K = 64, BANDS = 16, ROWS = 4;
const COEF = (() => { let x = 2463534242; const r = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; return Array.from({ length: K }, () => [r() | 1, r()]); })();
// 32-bit hash family h_i(x) = mix(a_i * x + b_i); the minimum per function gives the MinHash signature
const mix = h => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
function minhash(sh) {
  const sig = new Uint32Array(K).fill(0xffffffff);
  for (const s of sh) { const h = fnv(s); for (let i = 0; i < K; i++) { const v = mix((Math.imul(COEF[i][0], h) + COEF[i][1]) >>> 0); if (v < sig[i]) sig[i] = v; } }
  return sig;
}
function poissonTail(k, l) { let term = Math.exp(-l), cdf = 0; for (let i = 0; i < k; i++) { cdf += term; term *= l / (i + 1); } return Math.max(0, 1 - cdf); }
// most distinct accounts inside any sliding window of W ms; items sorted by time: [[ts, account], ...]
function maxInWindow(items, W) {
  const cnt = new Map(); let best = { n: 0, i: 0, j: -1 }, distinct = 0;
  for (let i = 0, j = 0; j < items.length; j++) {
    const a = items[j][1]; cnt.set(a, (cnt.get(a) || 0) + 1); if (cnt.get(a) === 1) distinct++;
    while (items[j][0] - items[i][0] > W) { const b = items[i][1]; cnt.set(b, cnt.get(b) - 1); if (!cnt.get(b)) distinct--; i++; }
    if (distinct > best.n) best = { n: distinct, i, j };
  }
  return best;
}
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };

// ---------------------------------------------------------------- analysis
export function analyse(posts, { windowMin = 5, minSimilarity = 0.6, minClusterPosts = 3, minClusterAccounts = 2 } = {}) {
  const t0 = Date.now(), W = windowMin * 60000;
  const P2 = posts.map((p, i) => ({ ...p, i, ts: Date.parse(p.posted_at), tags: JSON.parse(p.hashtags || "[]"), urls: JSON.parse(p.urls || "[]"), ments: JSON.parse(p.mentions || "[]") })).sort((a, b) => a.ts - b.ts);
  const accounts = new Set(P2.map(p => p.account)), first = P2[0]?.ts, last = P2.at(-1)?.ts, span = (last - first) || 0;
  const bucketMs = span > 4 * 864e5 ? 864e5 : 3600e3, bucket = ts => Math.floor((ts - first) / bucketMs);
  const nB = Math.max(1, bucket(last) + 1);

  // repeated messages: original posts only (reposts are counted separately as amplification)
  const orig = P2.filter(p => !p.repost_of && normText(p.text).length >= 15);
  const sh = orig.map(p => shingles(p.text)), sig = sh.map(minhash), parent = orig.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const tested = new Set(), exact = new Map();
  orig.forEach((p, i) => { const k = normText(p.text); if (exact.has(k)) parent[find(i)] = find(exact.get(k)); else exact.set(k, i); });   // identical wording
  for (let b = 0; b < BANDS; b++) {
    const buckets = new Map();
    for (let i = 0; i < orig.length; i++) { const k = sig[i].slice(b * ROWS, b * ROWS + ROWS).join(","); (buckets.get(k) || buckets.set(k, []).get(k)).push(i); }
    for (const ids of buckets.values()) {
      if (ids.length < 2) continue;
      const a = ids[0];                                   // compare against the bucket's first member, then chain
      for (let j = 1; j < ids.length; j++) { const x = ids[j]; if (find(x) === find(a)) continue; const key = a < x ? `${a}:${x}` : `${x}:${a}`; if (tested.has(key)) continue; tested.add(key); if (jaccard(sh[a], sh[x]) >= minSimilarity) parent[find(x)] = find(a); }
    }
  }
  const groups = new Map(); orig.forEach((p, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(p); });
  const clusters = [];
  for (const g of groups.values()) {
    const acc = new Set(g.map(p => p.account)); if (g.length < minClusterPosts || acc.size < minClusterAccounts) continue;
    g.sort((a, b) => a.ts - b.ts);
    // synchronisation: most distinct accounts posting this message inside any window of W minutes
    const mw = maxInWindow(g.map(p => [p.ts, p.account]), W), best = { accounts: mw.n, from: g[mw.i]?.posted_at || null, to: g[mw.j]?.posted_at || null };
    // is that many accounts in one window unusual for this message's own posting rate? (Poisson tail, corrected for the number of windows)
    const spanMs = Math.max(W, g.at(-1).ts - g[0].ts), lambda = g.length * W / spanMs, windows = Math.max(1, spanMs / W);
    best.expected = Math.round(lambda * 100) / 100; best.p_adjusted = Math.min(1, poissonTail(mw.n, lambda) * windows);
    const synchronised = mw.n >= 3 && (best.p_adjusted < 0.01 || mw.n >= Math.ceil(0.5 * acc.size));
    const platforms = [...new Set(g.map(p => p.platform).filter(Boolean))];
    clusters.push({ id: 0, posts: g.length, accounts: acc.size, account_list: [...acc].slice(0, 200), first_at: g[0].posted_at, last_at: g.at(-1).posted_at, span_min: Math.round((g.at(-1).ts - g[0].ts) / 60000),
      text: g[0].text.slice(0, 500), variants: new Set(g.map(p => normText(p.text))).size, platforms, cross_platform: platforms.length > 1, sync: best,
      synchronised, post_ids: g.slice(0, 500).map(p => p.id) });
  }
  clusters.sort((a, b) => (b.synchronised - a.synchronised) || (b.accounts - a.accounts) || (b.posts - a.posts)); clusters.forEach((c, i) => c.id = i + 1);

  // amplification: reposts per original account / post
  const amp = new Map(); for (const p of P2.filter(p => p.repost_of)) { const k = String(p.repost_of).toLowerCase(); const v = amp.get(k) || { of: k, reposts: 0, accounts: new Set(), first: p.posted_at, last: p.posted_at }; v.reposts++; v.accounts.add(p.account); v.last = p.posted_at; amp.set(k, v); }
  const amplification = [...amp.values()].map(v => ({ of: v.of, reposts: v.reposts, accounts: v.accounts.size, first_at: v.first, last_at: v.last })).sort((a, b) => b.reposts - a.reposts).slice(0, 30);

  // timeline and hashtag trends with burst detection (count well above the series' earlier level)
  const timeline = new Array(nB).fill(0); for (const p of P2) timeline[bucket(p.ts)]++;
  const tagCount = new Map(); for (const p of P2) for (const t of p.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const hashtags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([tag, total]) => {
    const series = new Array(nB).fill(0), accs = new Set(); for (const p of P2) if (p.tags.includes(tag)) { series[bucket(p.ts)]++; accs.add(p.account); }
    const bursts = [];
    // burst: a bucket far above this hashtag's usual level (Poisson tail vs the larger of the recent and overall rate, corrected for the number of buckets)
    for (let k = 0; k < nB; k++) { const prev = series.slice(Math.max(0, k - 24), k), mean = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0, lam = Math.max(mean, total / nB, 0.2), p = poissonTail(series[k], lam) * nB;
      if (series[k] >= 5 && p < 0.001) bursts.push({ bucket: k, at: new Date(first + k * bucketMs).toISOString(), count: series[k], baseline: Math.round(lam * 10) / 10, p_adjusted: p }); }
    return { tag, total, accounts: accs.size, series, bursts };
  });

  // shared links: URLs posted by several accounts; and fast co-sharing (same URL by different accounts within W)
  const urlMap = new Map(); for (const p of P2) for (const u of p.urls) { const v = urlMap.get(u) || { url: u, posts: 0, accounts: new Set(), times: [] }; v.posts++; v.accounts.add(p.account); v.times.push([p.ts, p.account]); urlMap.set(u, v); }
  const links = [...urlMap.values()].filter(v => v.accounts.size >= 2).map(v => { const fast = maxInWindow(v.times, W).n; let host = ""; try { host = new URL(v.url).hostname.replace(/^www\./, ""); } catch {} return { url: v.url, host, posts: v.posts, accounts: v.accounts.size, max_accounts_in_window: fast }; }).sort((a, b) => b.accounts - a.accounts).slice(0, 40);

  // co-activity network: accounts linked when they posted the same repeated message, or the same link within W
  const edge = new Map(), addE = (a, b, why) => { if (a === b) return; const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`; const e = edge.get(k) || { a: a < b ? a : b, b: a < b ? b : a, weight: 0, shared_messages: 0, shared_links: 0 }; e.weight++; e[why]++; edge.set(k, e); };
  const byId = new Map(P2.map(p => [p.id, p]));
  for (const c of clusters) { const g = c.post_ids.map(i => byId.get(i)).filter(Boolean); for (let i = 0; i < g.length && i < 400; i++) for (let j = i + 1; j < g.length && g[j].ts - g[i].ts <= W; j++) addE(g[i].account, g[j].account, "shared_messages"); }
  for (const v of urlMap.values()) { const t = v.times; for (let i = 0; i < t.length && i < 400; i++) for (let j = i + 1; j < t.length && t[j][0] - t[i][0] <= W; j++) addE(t[i][1], t[j][1], "shared_links"); }
  let edges = [...edge.values()].sort((x, y) => y.weight - x.weight).slice(0, 1500);
  const deg = new Map(); for (const e of edges) { deg.set(e.a, (deg.get(e.a) || 0) + e.weight); deg.set(e.b, (deg.get(e.b) || 0) + e.weight); }
  const keep = new Set([...deg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150).map(x => x[0])); edges = edges.filter(e => keep.has(e.a) && keep.has(e.b));
  // connected groups in the kept network
  const gp = new Map(), gf = x => { while (gp.get(x) !== x) { gp.set(x, gp.get(gp.get(x))); x = gp.get(x); } return x; }; for (const n of keep) gp.set(n, n); for (const e of edges) gp.set(gf(e.a), gf(e.b));
  const comp = new Map(); for (const n of keep) { const r = gf(n); comp.set(r, (comp.get(r) || 0) + 1); }
  const compIds = new Map([...comp.entries()].sort((a, b) => b[1] - a[1]).map(([r], i) => [r, i + 1]));
  const perAcct = new Map(); for (const p of P2) { const v = perAcct.get(p.account) || { account: p.account, posts: 0, reposts: 0, first: p.ts, last: p.ts, created: p.account_created_at || null }; v.posts++; if (p.repost_of) v.reposts++; v.last = p.ts; perAcct.set(p.account, v); }
  const inCl = new Map(); for (const c of clusters.filter(c => c.synchronised)) for (const a of c.account_list) inCl.set(a, (inCl.get(a) || 0) + 1);
  const nodes = [...keep].map(a => ({ id: a, weight: deg.get(a), posts: perAcct.get(a)?.posts || 0, synchronised_messages: inCl.get(a) || 0, group: compIds.get(gf(a)) }));

  // accounts appearing in the most signals (factual counts, not a judgement about the account)
  const accountsOut = [...perAcct.values()].map(v => {
    const days = Math.max(1 / 24, (v.last - v.first) / 864e5), created = v.created ? Date.parse(v.created) : NaN;
    return { account: v.account, posts: v.posts, reposts: v.reposts, posts_per_day: Math.round(v.posts / Math.max(1, days) * 10) / 10, synchronised_messages: inCl.get(v.account) || 0, network_links: deg.get(v.account) || 0,
      account_created_at: v.created, new_account: !isNaN(created) && first - created < 30 * 864e5 };
  }).sort((a, b) => (b.synchronised_messages - a.synchronised_messages) || (b.network_links - a.network_links) || (b.posts - a.posts)).slice(0, 100);

  return {
    version: 1, generated_at: nowISO(), duration_ms: Date.now() - t0,
    params: { window_min: windowMin, min_similarity: minSimilarity, min_cluster_posts: minClusterPosts, min_cluster_accounts: minClusterAccounts },
    summary: { posts: P2.length, accounts: accounts.size, first_at: P2[0]?.posted_at || null, last_at: P2.at(-1)?.posted_at || null, reposts: P2.filter(p => p.repost_of).length,
      platforms: [...new Set(P2.map(p => p.platform).filter(Boolean))], clusters: clusters.length, synchronised_clusters: clusters.filter(c => c.synchronised).length,
      accounts_in_clusters: new Set(clusters.flatMap(c => c.account_list)).size, hashtag_bursts: hashtags.reduce((a, h) => a + h.bursts.length, 0), network_groups: compIds.size },
    bucket: bucketMs === 864e5 ? "day" : "hour", bucket_start: first ? new Date(first).toISOString() : null, timeline,
    clusters: clusters.slice(0, 200), amplification, hashtags, links, network: { nodes, edges: edges.map(e => ({ ...e })) }, accounts: accountsOut, caveats: CAVEATS
  };
}

// ---------------------------------------------------------------- service
export function makeIo(db, { audit }) {
  const MAX_POSTS = 200000;
  function cleanRows(rowsIn) { return readRows(null, "collected.json", {}, rowsIn); }
  function readRows(buf, filename, mapping, given = null) {
    const rows = given || parseFile(buf, filename || "");
    if (!rows.length) throw new HttpError(400, "The file has no rows.");
    if (rows.length > MAX_POSTS) throw new HttpError(413, `The file has ${rows.length.toLocaleString()} rows; the limit is ${MAX_POSTS.toLocaleString()}. Split it into smaller periods.`);
    const cols = [...new Set(rows.slice(0, 2000).flatMap(r => Object.keys(r)))];   // JSON records may not all have the same fields
    const m = detectMapping(cols, mapping);
    const missing = ["text", "account", "posted_at"].filter(k => !m[k]);
    if (missing.length) throw new HttpError(400, `Could not find a column for: ${missing.join(", ")}. Columns in the file: ${cols.slice(0, 30).join(", ")}. Rename the columns (text, account, posted_at) or choose them in the import form.`, { columns: cols, mapping: m });
    const skipped = { no_text: 0, no_account: 0, bad_date: 0 }, out = [];
    for (const r of rows) {
      const text = String(r[m.text] ?? "").trim(), account = cleanAcct(r[m.account]), at = toISO(r[m.posted_at]);
      if (!text) { skipped.no_text++; continue; } if (!account) { skipped.no_account++; continue; } if (!at) { skipped.bad_date++; continue; }
      out.push({ platform: m.platform ? String(r[m.platform] || "").slice(0, 60) || null : null, post_id: m.post_id ? String(r[m.post_id] || "").slice(0, 120) || null : null, account, posted_at: at, text: text.slice(0, 5000),
        hashtags: JSON.stringify(tagsOf(text)), mentions: JSON.stringify(mentionsOf(text)), urls: JSON.stringify(urlsOf(text)),
        reply_to: m.reply_to ? cleanAcct(r[m.reply_to]) || null : null, repost_of: m.repost_of ? String(r[m.repost_of] || "").trim().slice(0, 120) || null : null,
        likes: num(r, m.likes), comments: num(r, m.comments), shares: num(r, m.shares), views: num(r, m.views), account_created_at: m.account_created_at ? toISO(r[m.account_created_at]) : null,
        url: m.url && /^https?:\/\//i.test(String(r[m.url] || "").trim()) ? String(r[m.url]).trim().slice(0, 1000) : null, language: m.language ? String(r[m.language] || "").trim().slice(0, 12) || null : null,
        collected_at: m.collected_at ? toISO(r[m.collected_at]) : null, collected_via: given && r.collected_via ? String(r.collected_via).slice(0, 300) : null, ...location(r, m) });
    }
    if (!out.length) throw new HttpError(400, `No usable rows: ${skipped.no_text} without text, ${skipped.no_account} without an account, ${skipped.bad_date} with an unreadable date.`);
    return { rows, out, skipped, m };
  }
  const INS = "INSERT INTO io_posts(dataset_id,platform,post_id,account,posted_at,text,hashtags,mentions,urls,reply_to,repost_of,likes,comments,shares,views,account_created_at,url,language,collected_at,collected_via,loc_country,loc_region,loc_name,loc_basis) VALUES (@d,@platform,@post_id,@account,@posted_at,@text,@hashtags,@mentions,@urls,@reply_to,@repost_of,@likes,@comments,@shares,@views,@account_created_at,@url,@language,@collected_at,@collected_via,@loc_country,@loc_region,@loc_name,@loc_basis)";
  const row = (p, d, via, at) => ({ d, comments: null, views: null, url: null, language: null, collected_at: null, loc_country: null, loc_region: null, loc_name: null, loc_basis: null, likes: null, shares: null, reply_to: null, repost_of: null, account_created_at: null, platform: null, post_id: null, ...p, collected_via: p.collected_via || via, collected_at: p.collected_at || at });
  function job(user, datasetId, kind, params) { return Number(db.prepare("INSERT INTO io_jobs(dataset_id,kind,status,params_json,created_by,created_at,started_at) VALUES (?,?,?,?,?,?,?)").run(datasetId ?? null, kind, "running", JSON.stringify(params || {}), user?.id ?? null, nowISO(), nowISO()).lastInsertRowid); }
  function jobDone(id, { datasetId, counts, error } = {}) { db.prepare("UPDATE io_jobs SET status = ?, counts_json = ?, error = ?, progress = 1, finished_at = ?, dataset_id = coalesce(?, dataset_id) WHERE id = ?").run(error ? "failed" : "done", counts ? JSON.stringify(counts) : null, error || null, nowISO(), datasetId ?? null, id); }
  function importPosts(user, { buf, filename, name, description, source, authorisation, mapping = {}, isSample = false, researchQuestion = null, method = null, via = null, rowsIn = null }) {
    if (!String(name || "").trim()) throw new HttpError(400, "Give the dataset a name.");
    if (!String(source || "").trim()) throw new HttpError(400, "Say where the data came from (for example: X research API export, CrowdTangle archive, partner submission).");
    if (!String(authorisation || "").trim()) throw new HttpError(400, "Confirm the basis on which you may use this data (for example: platform research API terms, written permission, or public data under your organisation's policy).");
    const jid = job(user, null, "import", { filename, method: method || "file" });
    let id;
    try {
      const { rows, out, skipped, m } = rowsIn ? cleanRows(rowsIn) : readRows(buf, filename, mapping);
      const sha = crypto.createHash("sha256").update(buf || JSON.stringify(rowsIn)).digest("hex"), times = out.map(p => p.posted_at).sort(), at = nowISO();
      const provenance = via || `file “${String(filename || "upload").slice(0, 120)}” (SHA-256 ${sha.slice(0, 16)}…) imported ${at.slice(0, 10)}`;
      id = db.transaction(() => {
        const r = db.prepare("INSERT INTO io_datasets(name,description,source,authorisation,is_sample,posts,accounts,first_at,last_at,file_sha256,imported_by,imported_at,research_question,collection_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(String(name).trim().slice(0, 200), String(description || "").slice(0, 2000) || null, String(source).trim().slice(0, 500), String(authorisation).trim().slice(0, 1000), isSample ? 1 : 0, out.length, new Set(out.map(p => p.account)).size, times[0], times.at(-1), sha, user.id, at, String(researchQuestion || "").trim().slice(0, 1000) || null, method || (isSample ? "sample" : "file"));
        const ins = db.prepare(INS);
        for (const p of out) ins.run(row(p, r.lastInsertRowid, provenance, at));
        return Number(r.lastInsertRowid);
      })();
      audit(user, `Post dataset imported: ${name}`, "io_dataset", String(id), { rows: rows.length, imported: out.length, skipped, sha256: sha, mapping: m, source, authorisation, sample: !!isSample, method: method || "file" });
      const analysis = runAnalysis(user, id), content = enrichPosts(db, id);
      jobDone(jid, { datasetId: id, counts: { rows: rows.length, imported: out.length, skipped } });
      return { id, imported: out.length, skipped, mapping: m, summary: analysis.summary, content };
    } catch (e) { jobDone(jid, { datasetId: id, error: e.message }); throw e; }
  }
  // add more posts to an existing dataset (identical posts already present are skipped)
  function appendPosts(user, id, { buf, filename, mapping = {}, note }) {
    const ds = getDataset(id);
    if (ds.is_sample) throw new HttpError(400, "The synthetic sample cannot be extended. Create your own dataset.");
    const jid = job(user, ds.id, "append", { filename });
    try {
    const { rows, out, skipped, m } = readRows(buf, filename, mapping);
    const have = new Set(db.prepare("SELECT account, posted_at, text FROM io_posts WHERE dataset_id = ?").all(ds.id).map(p => `${p.account}\u0000${p.posted_at}\u0000${p.text}`));
    const fresh = out.filter(p => !have.has(`${p.account}\u0000${p.posted_at}\u0000${p.text}`)), duplicates = out.length - fresh.length;
    if (db.prepare("SELECT COUNT(*) n FROM io_posts WHERE dataset_id = ?").get(ds.id).n + fresh.length > MAX_POSTS) throw new HttpError(413, `A dataset can hold at most ${MAX_POSTS.toLocaleString()} posts.`);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const at = nowISO(), provenance = `file “${String(filename || "upload").slice(0, 120)}” (SHA-256 ${sha.slice(0, 16)}…) added ${at.slice(0, 10)}`;
    db.transaction(() => {
      const ins = db.prepare(INS);
      for (const p of fresh) ins.run(row(p, ds.id, provenance, at));
      const agg = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT account) a, MIN(posted_at) f, MAX(posted_at) l FROM io_posts WHERE dataset_id = ?").get(ds.id);
      const desc = [ds.description, note ? `${nowISO().slice(0, 10)}: ${String(note).slice(0, 500)}` : null].filter(Boolean).join("\n").slice(0, 4000) || null;
      db.prepare("UPDATE io_datasets SET posts = ?, accounts = ?, first_at = ?, last_at = ?, description = ? WHERE id = ?").run(agg.n, agg.a, agg.f, agg.l, desc, ds.id);
    })();
    audit(user, `Posts added to dataset: ${ds.name}`, "io_dataset", String(ds.id), { rows: rows.length, added: fresh.length, duplicates, skipped, sha256: sha, mapping: m });
    const analysis = runAnalysis(user, ds.id), content = enrichPosts(db, ds.id);
    jobDone(jid, { counts: { rows: rows.length, added: fresh.length, duplicates, skipped } });
    return { id: ds.id, imported: fresh.length, duplicates, skipped, mapping: m, summary: analysis.summary, content };
    } catch (e) { jobDone(jid, { error: e.message }); throw e; }
  }
  // add collected records (from an API collector) to a dataset, skipping posts already present (same platform post ID, or same account+time+text)
  function appendCollected(user, id, rowsIn, via) {
    const ds = getDataset(id), { out, skipped } = cleanRows(rowsIn), at = nowISO();
    const have = new Set(db.prepare("SELECT platform, post_id, account, posted_at, text FROM io_posts WHERE dataset_id = ?").all(ds.id).flatMap(p => [p.post_id ? `id\u0000${p.platform}\u0000${p.post_id}` : null, `${p.account}\u0000${p.posted_at}\u0000${p.text}`].filter(Boolean)));
    const fresh = out.filter(p => !(p.post_id && have.has(`id\u0000${p.platform}\u0000${p.post_id}`)) && !have.has(`${p.account}\u0000${p.posted_at}\u0000${p.text}`));
    db.transaction(() => {
      const ins = db.prepare(INS); for (const p of fresh) ins.run(row(p, ds.id, via, at));
      const agg = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT account) a, MIN(posted_at) f, MAX(posted_at) l FROM io_posts WHERE dataset_id = ?").get(ds.id);
      db.prepare("UPDATE io_datasets SET posts = ?, accounts = ?, first_at = ?, last_at = ? WHERE id = ?").run(agg.n, agg.a, agg.f, agg.l, ds.id);
    })();
    if (fresh.length) { runAnalysis(user, ds.id); enrichPosts(db, ds.id); }
    return { added: fresh.length, duplicates: out.length - fresh.length, skipped };
  }
  function runAnalysis(user, id, params = {}) {
    const ds = getDataset(id);
    const p = { windowMin: clamp(params.window_min, 1, 1440, 5), minSimilarity: clamp(params.min_similarity, 0.3, 0.95, 0.6), minClusterPosts: clamp(params.min_cluster_posts, 2, 1000, 3), minClusterAccounts: clamp(params.min_cluster_accounts, 2, 1000, 2) };
    const posts = db.prepare("SELECT * FROM io_posts WHERE dataset_id = ?").all(ds.id);
    const a = analyse(posts, p);
    db.prepare("UPDATE io_datasets SET analysis_json = ?, analysed_at = ? WHERE id = ?").run(JSON.stringify(a), nowISO(), ds.id);
    audit(user, "Post dataset analysed", "io_dataset", String(ds.id), { params: a.params, summary: a.summary });
    return a;
  }
  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  function getDataset(id) { const d = db.prepare("SELECT * FROM io_datasets WHERE id = ?").get(Number(id)); if (!d) throw new HttpError(404, "Dataset not found."); return d; }
  const list = () => db.prepare("SELECT d.id,d.name,d.description,d.source,d.authorisation,d.is_sample,d.posts,d.accounts,d.first_at,d.last_at,d.imported_at,d.analysed_at,u.display_name AS imported_by FROM io_datasets d LEFT JOIN users u ON u.id = d.imported_by ORDER BY d.id DESC").all();
  function posts(id, query = {}) {
    const ds = getDataset(id), { account, cluster, ids: idList, limit = 200, offset = 0 } = query; let ids = null;
    if (cluster) { const a = JSON.parse(ds.analysis_json || "{}"); ids = a.clusters?.find(c => c.id === Number(cluster))?.post_ids || []; }
    if (idList) ids = String(idList).split(",").map(Number).filter(Number.isFinite).slice(0, 500);
    const { where, params } = filterSql(cleanFilters(query));
    let rows = db.prepare(`SELECT p.id,p.platform,p.post_id,p.account,p.posted_at,p.text,p.repost_of,p.reply_to,p.url,p.likes,p.comments,p.shares,p.views,p.sentiment,p.sentiment_confidence,p.sentiment_method,p.themes,p.topic_no,p.loc_basis,p.loc_name,p.loc_region,p.loc_country,p.collected_via,p.collected_at FROM io_posts p WHERE ${where} ORDER BY p.posted_at, p.id`).all({ ds: ds.id, ...params });
    if (ids) { const s = new Set(ids); rows = rows.filter(r => s.has(r.id)); }
    if (account) rows = rows.filter(r => r.account === cleanAcct(account));
    const lim = Math.min(1000, Math.max(1, Number(limit) || 200)), off = Math.max(0, Number(offset) || 0);
    return { total: rows.length, offset: off, limit: lim, posts: rows.slice(off, off + lim).map(r => ({ ...r, themes: JSON.parse(r.themes || "[]") })) };
  }
  function remove(user, id) {
    const ds = getDataset(id);
    db.transaction(() => { for (const t of ["io_posts", "io_topics", "io_claims"]) db.prepare(`DELETE FROM ${t} WHERE dataset_id = ?`).run(ds.id); db.prepare("DELETE FROM io_datasets WHERE id = ?").run(ds.id); })();
    audit(user, `Post dataset deleted: ${ds.name}`, "io_dataset", String(ds.id), { posts: ds.posts, sha256: ds.file_sha256 });
  }
  function exportCsv(id) {
    const ds = getDataset(id), a = JSON.parse(ds.analysis_json || "null"); if (!a) throw new HttpError(409, "Analyse the dataset first.");
    const q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const rows = [["signal", "id", "description", "posts", "accounts", "first_at", "last_at", "detail"]];
    for (const c of a.clusters) rows.push(["repeated_message", c.id, c.text, c.posts, c.accounts, c.first_at, c.last_at, `${c.synchronised ? `synchronised: ${c.sync.accounts} accounts within ${a.params.window_min} min` : "not synchronised"}; ${c.variants} wording variant(s)${c.cross_platform ? `; platforms ${c.platforms.join(", ")}` : ""}`]);
    for (const h of a.hashtags) for (const b of h.bursts) rows.push(["hashtag_burst", h.tag, `${b.count} posts in one ${a.bucket} (earlier average ${b.baseline})`, b.count, h.accounts, b.at, "", ""]);
    for (const l of a.links) rows.push(["shared_link", l.host, l.url, l.posts, l.accounts, "", "", `up to ${l.max_accounts_in_window} accounts within ${a.params.window_min} min`]);
    rows.push(["caveat", "", CAVEATS.join(" "), "", "", "", "", ""]);
    return "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n") + "\r\n";
  }
  return { importPosts, appendPosts, appendCollected, runAnalysis, getDataset, list, posts, remove, exportCsv, job, jobDone };
}

// ---------------------------------------------------------------- synthetic sample (clearly labelled; no real people or events)
export function sampleDataset() {
  let x = 20261022; const r = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = a => a[Math.floor(r() * a.length)], start = Date.UTC(2026, 8, 1, 6), rows = [];
  const A = ["Traffic on the bypass", "Tomato prices at the market", "The match at the stadium", "Rain in the highlands", "The new water point in our ward", "The budget debate", "School fees this term", "The power supply", "The sunset over the lake", "Football training"],
    B = ["is", "seems", "was", "looks", "has been", "felt", "might be", "is honestly", "keeps being", "will be"],
    C = ["slow again today", "better than last week", "the talk of the estate", "a big surprise", "worth watching", "frustrating for everyone", "quite good actually", "late as usual", "the best thing this month", "hard to predict"],
    D = ["", "what do you think?", "anyone else?", "lol", "ok then", "let's see", "as always", "my friends agree", "can't complain", "true story"];
  const tagsO = ["#SampleTraffic", "#SampleWeather", "#SampleSports", "#SampleMarket", ""];
  for (let i = 0; i < 520; i++) { const t = start + Math.floor(r() * 72 * 3600e3); rows.push({ account: `resident_${String(1 + Math.floor(r() * 140)).padStart(3, "0")}`, posted_at: new Date(t).toISOString(), text: `${pick(A)} ${pick(B)} ${pick(C)} ${pick(D)} ${pick(tagsO)}`.replace(/\s+/g, " ").trim() + (r() < 0.5 ? ` (${Math.floor(r() * 1000)})` : ""), platform: "SampleNet" }); }
  // planted pattern A: 14 accounts post near-identical text within 4 minutes, twice, with a shared link and a new hashtag
  const msg = ["The water project funds have disappeared, demand answers now #SampleWaterScandal https://example.org/sample-story", "Water project funds have disappeared! Demand answers now #SampleWaterScandal https://example.org/sample-story",
    "The water project funds disappeared, demand answers now!! #SampleWaterScandal https://example.org/sample-story"];
  for (const wave of [30, 52]) for (let k = 0; k < 14; k++) rows.push({ account: `newvoice_${String(k + 1).padStart(2, "0")}`, posted_at: new Date(start + wave * 3600e3 + Math.floor(r() * 240e3)).toISOString(), text: msg[k % 3], platform: k % 4 === 0 ? "SampleChat" : "SampleNet", account_created_at: new Date(start - (3 + k) * 864e5).toISOString() });
  // planted pattern B: reposts of one account by many accounts
  for (let k = 0; k < 40; k++) rows.push({ account: `resident_${String(1 + Math.floor(r() * 140)).padStart(3, "0")}`, posted_at: new Date(start + 40 * 3600e3 + k * 50e3).toISOString(), text: "RT: Join the community clean-up on Saturday #SampleCleanUp", repost_of: "county_events_sample", platform: "SampleNet" });
  return rows.sort((a, b) => a.posted_at.localeCompare(b.posted_at));
}

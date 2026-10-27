// Information operations monitor: import post datasets the operator is permitted to use, and compute
// coordination SIGNALS (repeated messages, synchronised posting, hashtag bursts, shared links, co-activity).
// Signals are leads for an analyst. They are never findings, never proof, and never attribution.
import crypto from "node:crypto";
import { HttpError } from "./auth.js";
import { nowISO } from "./db.js";

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
  likes: ["likes", "like_count", "favorite_count", "reactions", "favourites"],
  shares: ["shares", "share_count", "retweet_count", "reposts", "forwards"],
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
  if (hex.startsWith("ffd8ff") || hex.startsWith("89504e47") || hex.startsWith("47494638") || h.subarray(0, 4).toString() === "RIFF" || ["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(ext))
    return "This is a picture, not a list of posts. The monitor looks for patterns across many posts, so it needs a table (CSV or JSON). To check a single post or screenshot, use Verify information or New case (files) instead.";
  if (h.subarray(0, 4).toString() === "%PDF" || ext === "pdf") return "This is a PDF, not a list of posts. Copy the posts into a spreadsheet (one row per post: account, posted_at, text), save it as CSV, and import that.";
  if (hex.startsWith("504b0304") || ["xlsx", "xls", "docx", "doc"].includes(ext)) return ext && ext.startsWith("doc") ? "This is a Word document, not a list of posts. Put the posts in a spreadsheet (one row per post: account, posted_at, text) and save it as CSV." : "This is an Excel file. In Excel choose File → Save As → \"CSV UTF-8 (Comma delimited)\", then import the .csv file.";
  if (["mp4", "mov", "avi", "mkv", "mp3", "wav"].includes(ext) || hex.slice(8, 16) === "66747970") return "This is a video or audio file, not a list of posts. To examine a video, use New case (files).";
  const sample = buf.subarray(0, 2000); let bad = 0; for (const b of sample) if (b === 0 || (b < 9)) bad++;
  if (bad > 5) return "This file is not text. The monitor needs a CSV or JSON table of posts (one row per post: account, posted_at, text).";
  return null;
}
export function parseFile(buf, name) {
  const why = notATable(buf, name); if (why) throw new HttpError(400, why);
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
function toISO(v) {
  if (v == null || v === "") return null;
  if (/^\d{10}(\.\d+)?$/.test(String(v))) return new Date(Number(v) * 1000).toISOString();
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString();
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
  function readRows(buf, filename, mapping) {
    const rows = parseFile(buf, filename || "");
    if (!rows.length) throw new HttpError(400, "The file has no rows.");
    if (rows.length > MAX_POSTS) throw new HttpError(413, `The file has ${rows.length.toLocaleString()} rows; the limit is ${MAX_POSTS.toLocaleString()}. Split it into smaller periods.`);
    const m = detectMapping(Object.keys(rows[0]), mapping);
    const missing = ["text", "account", "posted_at"].filter(k => !m[k]);
    if (missing.length) throw new HttpError(400, `Could not find a column for: ${missing.join(", ")}. Columns in the file: ${Object.keys(rows[0]).slice(0, 30).join(", ")}. Rename the columns (text, account, posted_at) or choose them in the import form.`, { columns: Object.keys(rows[0]), mapping: m });
    const skipped = { no_text: 0, no_account: 0, bad_date: 0 }, out = [];
    for (const r of rows) {
      const text = String(r[m.text] ?? "").trim(), account = cleanAcct(r[m.account]), at = toISO(r[m.posted_at]);
      if (!text) { skipped.no_text++; continue; } if (!account) { skipped.no_account++; continue; } if (!at) { skipped.bad_date++; continue; }
      out.push({ platform: m.platform ? String(r[m.platform] || "").slice(0, 60) || null : null, post_id: m.post_id ? String(r[m.post_id] || "").slice(0, 120) || null : null, account, posted_at: at, text: text.slice(0, 5000),
        hashtags: JSON.stringify(tagsOf(text)), mentions: JSON.stringify(mentionsOf(text)), urls: JSON.stringify(urlsOf(text)),
        reply_to: m.reply_to ? cleanAcct(r[m.reply_to]) || null : null, repost_of: m.repost_of ? String(r[m.repost_of] || "").trim().slice(0, 120) || null : null,
        likes: m.likes ? Number(r[m.likes]) || 0 : null, shares: m.shares ? Number(r[m.shares]) || 0 : null, account_created_at: m.account_created_at ? toISO(r[m.account_created_at]) : null });
    }
    if (!out.length) throw new HttpError(400, `No usable rows: ${skipped.no_text} without text, ${skipped.no_account} without an account, ${skipped.bad_date} with an unreadable date.`);
    return { rows, out, skipped, m };
  }
  function importPosts(user, { buf, filename, name, description, source, authorisation, mapping = {}, isSample = false }) {
    if (!String(name || "").trim()) throw new HttpError(400, "Give the dataset a name.");
    if (!String(source || "").trim()) throw new HttpError(400, "Say where the data came from (for example: X research API export, CrowdTangle archive, partner submission).");
    if (!String(authorisation || "").trim()) throw new HttpError(400, "Confirm the basis on which you may use this data (for example: platform research API terms, written permission, or public data under your organisation's policy).");
    const { rows, out, skipped, m } = readRows(buf, filename, mapping);
    const sha = crypto.createHash("sha256").update(buf).digest("hex"), times = out.map(p => p.posted_at).sort();
    const id = db.transaction(() => {
      const r = db.prepare("INSERT INTO io_datasets(name,description,source,authorisation,is_sample,posts,accounts,first_at,last_at,file_sha256,imported_by,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(String(name).trim().slice(0, 200), String(description || "").slice(0, 2000) || null, String(source).trim().slice(0, 500), String(authorisation).trim().slice(0, 1000), isSample ? 1 : 0, out.length, new Set(out.map(p => p.account)).size, times[0], times.at(-1), sha, user.id, nowISO());
      const ins = db.prepare("INSERT INTO io_posts(dataset_id,platform,post_id,account,posted_at,text,hashtags,mentions,urls,reply_to,repost_of,likes,shares,account_created_at) VALUES (@d,@platform,@post_id,@account,@posted_at,@text,@hashtags,@mentions,@urls,@reply_to,@repost_of,@likes,@shares,@account_created_at)");
      for (const p of out) ins.run({ d: r.lastInsertRowid, ...p });
      return Number(r.lastInsertRowid);
    })();
    audit(user, `Post dataset imported: ${name}`, "io_dataset", String(id), { rows: rows.length, imported: out.length, skipped, sha256: sha, mapping: m, source, authorisation, sample: !!isSample });
    const analysis = runAnalysis(user, id);
    return { id, imported: out.length, skipped, mapping: m, summary: analysis.summary };
  }
  // add more posts to an existing dataset (identical posts already present are skipped)
  function appendPosts(user, id, { buf, filename, mapping = {}, note }) {
    const ds = getDataset(id);
    if (ds.is_sample) throw new HttpError(400, "The synthetic sample cannot be extended. Create your own dataset.");
    const { rows, out, skipped, m } = readRows(buf, filename, mapping);
    const have = new Set(db.prepare("SELECT account, posted_at, text FROM io_posts WHERE dataset_id = ?").all(ds.id).map(p => `${p.account}\u0000${p.posted_at}\u0000${p.text}`));
    const fresh = out.filter(p => !have.has(`${p.account}\u0000${p.posted_at}\u0000${p.text}`)), duplicates = out.length - fresh.length;
    if (db.prepare("SELECT COUNT(*) n FROM io_posts WHERE dataset_id = ?").get(ds.id).n + fresh.length > MAX_POSTS) throw new HttpError(413, `A dataset can hold at most ${MAX_POSTS.toLocaleString()} posts.`);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    db.transaction(() => {
      const ins = db.prepare("INSERT INTO io_posts(dataset_id,platform,post_id,account,posted_at,text,hashtags,mentions,urls,reply_to,repost_of,likes,shares,account_created_at) VALUES (@d,@platform,@post_id,@account,@posted_at,@text,@hashtags,@mentions,@urls,@reply_to,@repost_of,@likes,@shares,@account_created_at)");
      for (const p of fresh) ins.run({ d: ds.id, ...p });
      const agg = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT account) a, MIN(posted_at) f, MAX(posted_at) l FROM io_posts WHERE dataset_id = ?").get(ds.id);
      const desc = [ds.description, note ? `${nowISO().slice(0, 10)}: ${String(note).slice(0, 500)}` : null].filter(Boolean).join("\n").slice(0, 4000) || null;
      db.prepare("UPDATE io_datasets SET posts = ?, accounts = ?, first_at = ?, last_at = ?, description = ? WHERE id = ?").run(agg.n, agg.a, agg.f, agg.l, desc, ds.id);
    })();
    audit(user, `Posts added to dataset: ${ds.name}`, "io_dataset", String(ds.id), { rows: rows.length, added: fresh.length, duplicates, skipped, sha256: sha, mapping: m });
    const analysis = runAnalysis(user, ds.id);
    return { id: ds.id, imported: fresh.length, duplicates, skipped, mapping: m, summary: analysis.summary };
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
  function posts(id, { account, cluster, q, limit = 200 } = {}) {
    const ds = getDataset(id); let ids = null;
    if (cluster) { const a = JSON.parse(ds.analysis_json || "{}"); ids = a.clusters?.find(c => c.id === Number(cluster))?.post_ids || []; }
    let rows = db.prepare("SELECT id,platform,post_id,account,posted_at,text,repost_of,reply_to FROM io_posts WHERE dataset_id = ? ORDER BY posted_at").all(ds.id);
    if (ids) { const s = new Set(ids); rows = rows.filter(r => s.has(r.id)); }
    if (account) rows = rows.filter(r => r.account === cleanAcct(account));
    if (q) { const t = String(q).toLowerCase(); rows = rows.filter(r => r.text.toLowerCase().includes(t) || r.account.includes(t)); }
    return { total: rows.length, posts: rows.slice(0, Math.min(1000, Number(limit) || 200)) };
  }
  function remove(user, id) {
    const ds = getDataset(id);
    db.transaction(() => { db.prepare("DELETE FROM io_posts WHERE dataset_id = ?").run(ds.id); db.prepare("DELETE FROM io_datasets WHERE id = ?").run(ds.id); })();
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
  return { importPosts, appendPosts, runAnalysis, getDataset, list, posts, remove, exportCsv };
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

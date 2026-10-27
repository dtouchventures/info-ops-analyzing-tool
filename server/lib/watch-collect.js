// KDF Mention Watch collection: scheduled searches and the X filtered stream, through official APIs only.
//   X recent search    GET /2/tweets/search/recent       X_BEARER_TOKEN; pay-per-use, charged per post returned
//   X filtered stream  GET /2/tweets/search/stream       X_BEARER_TOKEN + WATCH_X_STREAM=true; one connection on pay-per-use
//                      POST/GET /2/tweets/search/stream/rules (rules tagged aivs-wl-<id>; other rules are left alone)
//   YouTube            search.list (100 calls a day, own quota bucket) + videos.list for public counts   YOUTUBE_API_KEY
//   News websites      RSS/Atom feeds named in the watchlist (or RSS_FEEDS)
// Behaviour follows X's published guidance (docs.x.com, checked October 2026): a keep-alive arrives every 20 s and
// a silent connection is reconnected; network errors back off linearly (+250 ms, up to 16 s), HTTP errors
// exponentially (5 s doubling, up to 320 s), rate limits exponentially from 1 min; missed periods are recovered
// with backfill_minutes only if enabled, otherwise with a recent search over the gap. Every run is recorded, and
// the position reached (since_id, last publication time) is stored after the posts are, so a restart resumes
// without losing or double-counting posts. Daily limits stop collection before costs or quotas are exceeded.
import { WATCH_SOURCES, xQuery, youtubeQuery, UNSUPPORTED, matchPost } from "./watch.js";
import { nowISO } from "./db.js";
import { makePlatforms } from "./watch-platforms.js";
import { CAPABILITIES, DOCS_CHECKED } from "./watch-capabilities.js";
import crypto from "node:crypto";

const X_FIELDS = { "tweet.fields": "created_at,public_metrics,lang,author_id,referenced_tweets,conversation_id", expansions: "author_id", "user.fields": "username,name,created_at" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const utcDayStart = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").toISOString();
// YouTube quotas reset at midnight Pacific Time
function pacificDayStart(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now).map(x => [x.type, x.value]));
  const sinceMidnight = ((+p.hour * 60 + +p.minute) * 60 + +p.second) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnight).toISOString();
}
export class ApiFailure extends Error { constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); } }   // kind: network | http | rate | auth | config

// map an X post (+ includes) to a watch row
export function xRow(t, users, via) {
  const u = users.get(t.author_id) || {}, m = t.public_metrics || {}, refs = t.referenced_tweets || [];
  return { platform: "X (Twitter)", post_id: t.id, account: u.username ? "@" + u.username : t.author_id || null, author_name: u.name || null, text: t.note_tweet?.text || t.text, language: t.lang && t.lang !== "und" && t.lang !== "zxx" ? t.lang : null,
    posted_at: t.created_at || null, url: u.username ? `https://x.com/${u.username}/status/${t.id}` : `https://x.com/i/web/status/${t.id}`,
    likes: m.like_count ?? null, comments: m.reply_count ?? null, shares: m.retweet_count != null ? m.retweet_count + (m.quote_count || 0) : null, views: m.impression_count ?? null,
    repost_of: refs.find(r => r.type === "retweeted")?.id || null, quote_of: refs.find(r => r.type === "quoted")?.id || null, collected_via: via };
}

export function makeWatchCollector(db, { watch, collectors, config, audit, version = "dev" }) {
  const C = { xBearer: "", youtubeKey: "", timeoutMs: 15000, rssFeeds: "", ...(config.collect || {}) };
  const W = { enabled: true, tickSeconds: 30, xStream: false, xBackfillMinutes: 0, xDailyPosts: 2000, xPostsPerRun: 100, xPagesPerRun: 5, usdPerXPost: 0.005, youtubeSearchDaily: 90, youtubePagesPerRun: 1,
    metricsRefreshMinutes: 60, retryScale: 1, stallMs: 25000, maxHttpBackoffMs: 320000, ...(config.watch || {}) };
  const B = { youtube: "https://www.googleapis.com", x: "https://api.x.com", ...(C.bases || {}) };
  const UA = `AIVS-mention-watch/${version}`;
  const usage = (service, op, units, unit, status, cost = null) => { try { db.prepare("INSERT INTO api_usage(at,service,operation,units,unit,est_cost_usd,status) VALUES (?,?,?,?,?,?,?)").run(nowISO(), service, op, units, unit, cost, status); } catch {} };
  const xPostsToday = () => db.prepare("SELECT coalesce(SUM(units),0) n FROM api_usage WHERE service = 'x_api' AND unit = 'posts' AND at >= ?").get(utcDayStart()).n;
  const ytSearchesToday = () => db.prepare("SELECT COUNT(*) n FROM api_usage WHERE service = 'youtube_api' AND operation = 'search.list' AND at >= ?").get(pacificDayStart()).n;
  const svc = { get: k => { const r = db.prepare("SELECT value_json FROM watch_service WHERE key = ?").get(k); return r ? JSON.parse(r.value_json) : null; },
    set: (k, v) => db.prepare("INSERT INTO watch_service(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").run(k, JSON.stringify(v), nowISO()) };

  // ------------------------------------------------------------ HTTP with the platforms' error handling
  // bigIds: 64-bit numeric IDs (TikTok) are read as strings, because JavaScript numbers would round them
  async function request(url, { method = "GET", headers = {}, body, form, timeoutMs = C.timeoutMs, bigIds = false } = {}) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    let r, text;
    try { r = await fetch(url, { method, headers: { Accept: "application/json", "User-Agent": UA, ...(body ? { "Content-Type": "application/json" } : form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...headers }, body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined, signal: ac.signal }); text = await r.text(); }
    catch (e) { throw new ApiFailure("network", e.name === "AbortError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `could not connect (${e.cause?.code || e.message})`); }
    finally { clearTimeout(t); }
    if (bigIds) text = text.replace(/"(id|music_id|playlist_id)"\s*:\s*(\d{15,})/g, '"$1":"$2"');
    let j = null; try { j = JSON.parse(text); } catch {}
    const msg = j ? [j.title, j.detail, j.error?.message, typeof j.error === "string" ? j.error : null, j.error_description, j.description, j.message, j.errors?.[0]?.message, j.reason].filter(Boolean).join(": ").slice(0, 300) : text.slice(0, 200);
    const reset = Number(r.headers.get("x-rate-limit-reset")) || null, remaining = r.headers.get("x-rate-limit-remaining");
    if (r.status === 429) throw new ApiFailure("rate", `rate limit reached${msg ? ` (${msg})` : ""}`, { status: 429, resetAt: reset ? new Date(reset * 1000).toISOString() : null });
    if (r.status === 401 || r.status === 403 || r.status === 402) throw new ApiFailure("auth", `the service refused access (HTTP ${r.status}${msg ? `: ${msg}` : ""}). Check the key and that the account's access level and credit include this endpoint.`, { status: r.status });
    if (!r.ok) throw new ApiFailure("http", `HTTP ${r.status}${msg ? `: ${msg}` : ""}`, { status: r.status, retryable: r.status >= 500 });
    if (j == null) throw new ApiFailure("http", "the service did not return JSON", { retryable: false });
    return { json: j, headers: r.headers, remaining: remaining == null ? null : +remaining, resetAt: reset ? new Date(reset * 1000).toISOString() : null };
  }
  // transient failures (network, 5xx) are retried a few times inside one run; rate limits and refusals are not
  async function withRetry(fn, attempts = 3) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) { if (i + 1 >= attempts || !(e.kind === "network" || (e.kind === "http" && e.retryable))) throw e; await sleep(1000 * 2 ** i * W.retryScale); }
    }
  }

  // ------------------------------------------------------------ what is connected
  const platforms = makePlatforms({ request, withRetry, config, W, svc, version, ApiFailure,
    usage: { add: (service, op, units, unit, status) => usage(service, op, units, unit, status), count: (service, since) => db.prepare("SELECT coalesce(SUM(units),0) n FROM api_usage WHERE service = ? AND status = 'ok' AND at >= ?").get(service, since).n } });
  function sourceState(s) {
    if (platforms[s]) return platforms[s].ready();
    if (s === "whatsapp_business") return config.platforms?.whatsappVerifyToken && config.platforms?.whatsappAppSecret ? { state: "ready" } : { state: "not_configured", needs: "WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET from your WhatsApp Business (Cloud API) app, and a public HTTPS address for Meta to send webhooks to: https://<your address>/webhooks/whatsapp" };
    if (s === "x_search") return C.xBearer ? { state: "ready" } : { state: "not_configured", needs: "X_BEARER_TOKEN (an X developer app with pay-per-use credit; recent search covers the last 7 days)" };
    if (s === "x_stream") return !C.xBearer ? { state: "not_configured", needs: "X_BEARER_TOKEN and WATCH_X_STREAM=true" } : !W.xStream ? { state: "disabled", needs: "WATCH_X_STREAM=true in the server settings, once your X access includes the filtered stream (pay-per-use allows one connection and 1,000 rules; another app using the same stream would disconnect AIVS)" } : { state: "ready" };
    if (s === "youtube") return C.youtubeKey ? { state: "ready" } : { state: "not_configured", needs: "YOUTUBE_API_KEY (YouTube Data API v3)" };
    if (s === "news") return { state: "ready" };
    if (s === "fb_live") return (config.live?.pageToken) ? { state: "ready" } : { state: "not_configured", needs: "META_PAGE_ACCESS_TOKEN and META_PAGE_IDS (live monitoring of the authorised Facebook Pages)" };
    return { state: "unsupported" };
  }
  const sourcesReady = s => sourceState(s).state === "ready";
  function status() {
    const stream = svc.get("x_stream") || { status: "off" }, x = xPostsToday(), y = ytSearchesToday();
    return {
      sources: Object.entries(WATCH_SOURCES).map(([key, s]) => ({ key, ...s, ...sourceState(key),
        limits: key === "x_search" ? `Up to ${W.xPostsPerRun} posts per run. Charged per post returned (about $${W.usdPerXPost} each; the same post read again on the same UTC day is not charged again). Rate limit 450 requests per 15 min.`
          : key === "x_stream" ? "One connection; rules up to 1,024 characters; posts arrive about 4–5 s after publication when connected. Posts count toward the same daily limit."
          : key === "youtube" ? `search.list: 100 calls a day per project (own quota bucket); AIVS stops at ${W.youtubeSearchDaily}. Results depend on YouTube's search index and can be delayed or incomplete.`
          : key === "fb_live" ? "Every post that live monitoring collects from the authorised Facebook Pages (META_PAGE_IDS) is checked against this watchlist as it arrives. No separate collection, quota or cost."
          : platforms[key] ? platforms[key].limits
          : "Only the headline, summary, link and date that publishers put in their feeds. Feeds are read on the watchlist's schedule." })),
      unsupported: UNSUPPORTED,
      platforms: platformTable(),
      docs_checked: DOCS_CHECKED,
      budgets: { x_posts_today: x, x_posts_limit: W.xDailyPosts, x_est_cost_today_usd: Math.round(x * W.usdPerXPost * 100) / 100, x_cost_note: "upper estimate: X does not charge again for a post already read on the same UTC day", youtube_search_today: y, youtube_search_limit: W.youtubeSearchDaily,
        threads_queries_24h: db.prepare("SELECT coalesce(SUM(units),0) n FROM api_usage WHERE service = 'threads_api' AND status = 'ok' AND at >= ?").get(new Date(Date.now() - 864e5).toISOString()).n, threads_queries_limit: (config.platforms?.threadsDailyQueries ?? 1000),
        instagram_hashtags_7d: Object.keys(svc.get("instagram_hashtags") || {}).filter(k => Date.parse((svc.get("instagram_hashtags") || {})[k].first) > Date.now() - 7 * 864e5).length },
      stream: { ...stream, enabled: sourcesReady("x_stream"), backfill_minutes: W.xBackfillMinutes },
      scheduler: { enabled: W.enabled, tick_seconds: W.tickSeconds, running: !!timer, metrics_refresh_minutes: W.metricsRefreshMinutes }
    };
  }

  // ------------------------------------------------------------ runs
  const st = (wid, source) => db.prepare("SELECT * FROM watch_source_state WHERE watchlist_id = ? AND source = ?").get(wid, source) || { watchlist_id: wid, source, failures: 0 };
  const saveSt = s => db.prepare(`INSERT INTO watch_source_state(watchlist_id,source,cursor,cursor_time,status,last_run_at,last_ok_at,next_run_at,backoff_until,failures,last_error,last_found,last_new)
    VALUES (@watchlist_id,@source,@cursor,@cursor_time,@status,@last_run_at,@last_ok_at,@next_run_at,@backoff_until,@failures,@last_error,@last_found,@last_new)
    ON CONFLICT(watchlist_id, source) DO UPDATE SET cursor=excluded.cursor, cursor_time=excluded.cursor_time, status=excluded.status, last_run_at=excluded.last_run_at, last_ok_at=excluded.last_ok_at, next_run_at=excluded.next_run_at,
    backoff_until=excluded.backoff_until, failures=excluded.failures, last_error=excluded.last_error, last_found=excluded.last_found, last_new=excluded.last_new`)
    .run({ cursor: null, cursor_time: null, status: "idle", last_run_at: null, last_ok_at: null, next_run_at: null, backoff_until: null, failures: 0, last_error: null, last_found: null, last_new: null, ...s });
  const startRun = (wid, source, kind, from, to) => Number(db.prepare("INSERT INTO watch_runs(watchlist_id,source,kind,started_at,window_from,window_to) VALUES (?,?,?,?,?,?)").run(wid, source, kind, nowISO(), from, to).lastInsertRowid);
  const endRun = (id, status, f = {}) => db.prepare("UPDATE watch_runs SET finished_at = ?, status = ?, requests = requests + ?, pages = pages + ?, note = ?, error = ? WHERE id = ?").run(nowISO(), status, f.requests || 0, f.pages || 0, f.note || null, f.error || null, id);

  // X recent search over a window (a scheduled run, or recovery of a stream gap)
  async function xSearch(wl, { start_time, end_time, since_id, runId, maxPosts, maxPages = W.xPagesPerRun }) {
    const q = xQuery(wl.definition); if (!q.ok) throw new ApiFailure("config", q.problem);
    const rows = [], out = { requests: 0, pages: 0, newest_id: null, newest_at: null, stopped: null };
    let next = null;
    while (out.pages < maxPages) {
      const left = Math.min(maxPosts - rows.length, W.xDailyPosts - xPostsToday());
      if (left <= 0) { out.stopped = rows.length >= maxPosts ? "per-run limit reached" : "daily X post limit reached"; break; }
      const u = new URL(`${B.x.replace(/\/$/, "")}/2/tweets/search/recent`);
      for (const [k, v] of Object.entries({ query: q.query, max_results: String(Math.min(100, Math.max(10, left))), ...X_FIELDS })) u.searchParams.set(k, v);
      if (since_id) u.searchParams.set("since_id", since_id); else if (start_time) u.searchParams.set("start_time", start_time);
      if (end_time) u.searchParams.set("end_time", end_time); if (next) u.searchParams.set("next_token", next);
      let r; try { r = await withRetry(() => request(u, { headers: { Authorization: `Bearer ${C.xBearer}` } })); out.requests++; } catch (e) { usage("x_api", "tweets/search/recent", 0, "posts", "error"); e.partial = { rows, out }; throw e; }
      const users = new Map((r.json.includes?.users || []).map(x => [x.id, x])), data = r.json.data || [];
      usage("x_api", "tweets/search/recent", data.length, "posts", "ok", data.length * W.usdPerXPost);
      if (!out.newest_id && r.json.meta?.newest_id) out.newest_id = r.json.meta.newest_id;
      for (const t of data) { rows.push(xRow(t, users, `X API v2 recent search “${q.query}”`)); if (t.created_at && (!out.newest_at || t.created_at > out.newest_at)) out.newest_at = t.created_at; }
      out.pages++; next = r.json.meta?.next_token; if (!next) break;
    }
    if (next && !out.stopped) out.stopped = `stopped after ${out.pages} pages; older matching posts in this window were not fetched`;
    return { rows, ...out };
  }

  async function youtubeSearch(wl, { publishedAfter }) {
    const q = youtubeQuery(wl.definition), rows = [], out = { requests: 0, pages: 0, stopped: null }; let token = null; const ids = [];
    while (out.pages < W.youtubePagesPerRun) {
      if (ytSearchesToday() >= W.youtubeSearchDaily) { out.stopped = "daily YouTube search limit reached"; break; }
      const u = new URL(`${B.youtube.replace(/\/$/, "")}/youtube/v3/search`);
      for (const [k, v] of Object.entries({ part: "snippet", type: "video", q: q.query, maxResults: "50", order: "date", publishedAfter, key: C.youtubeKey })) u.searchParams.set(k, v);
      if (token) u.searchParams.set("pageToken", token);
      let r; try { r = await withRetry(() => request(u)); out.requests++; usage("youtube_api", "search.list", 1, "search calls", "ok"); } catch (e) { usage("youtube_api", "search.list", 1, "search calls", "error"); e.partial = { rows, out }; throw e; }
      for (const it of r.json.items || []) if (it.id?.videoId) ids.push(it.id.videoId);
      out.pages++; token = r.json.nextPageToken; if (!token) break;
    }
    if (token && !out.stopped) out.stopped = "more results were available; only the first page is read each run to stay within the daily search quota";
    for (let i = 0; i < ids.length; i += 50) {
      const u = new URL(`${B.youtube.replace(/\/$/, "")}/youtube/v3/videos`); u.searchParams.set("part", "snippet,statistics"); u.searchParams.set("id", ids.slice(i, i + 50).join(",")); u.searchParams.set("key", C.youtubeKey);
      let r; try { r = await withRetry(() => request(u)); out.requests++; usage("youtube_api", "videos.list", 1, "quota units", "ok"); } catch (e) { usage("youtube_api", "videos.list", 1, "quota units", "error"); e.partial = { rows, out }; throw e; }
      for (const v of r.json.items || []) rows.push(ytRow(v, `YouTube Data API v3 search “${q.query}”`));
    }
    return { rows, ...out };
  }
  const ytRow = (v, via) => { const s = v.snippet || {}, x = v.statistics || {}, n = k => (x[k] == null ? null : Number(x[k]));
    return { platform: "YouTube", post_id: v.id, account: s.channelTitle || s.channelId || null, text: [s.title, s.description].filter(Boolean).join(" — ").slice(0, 5000), url: `https://www.youtube.com/watch?v=${v.id}`,
      posted_at: s.publishedAt || null, language: s.defaultAudioLanguage || s.defaultLanguage || null, likes: n("likeCount"), comments: n("commentCount"), shares: null, views: n("viewCount"), collected_via: via }; };

  // one scheduled run of one source for one watchlist
  async function runSource(wl, source, { kind = "scheduled" } = {}) {
    const s = st(wl.id, source), def = wl.definition, now = new Date(), iso = now.toISOString(), interval = (def.intervals[source] || 15) * 60e3;
    if (!sourcesReady(source)) { saveSt({ ...s, status: "not_configured", last_error: sourceState(source).needs, next_run_at: new Date(+now + interval).toISOString() }); return { skipped: "not configured" }; }
    let from = s.cursor_time ? new Date(Date.parse(s.cursor_time) - (source === "x_search" ? 0 : (source === "youtube" ? 120 : 60) * 60e3)) : new Date(+now - def.lookback_minutes * 60e3);
    if (source === "x_search" && +now - from > 6.9 * 864e5) from = new Date(+now - 6.9 * 864e5);
    const runId = startRun(wl.id, source, kind, from.toISOString(), iso);
    saveSt({ ...s, status: "running", last_run_at: iso });
    try {
      let r, note = null;
      if (source === "x_search") {
        if (xPostsToday() >= W.xDailyPosts) { endRun(runId, "skipped", { note: `daily X post limit (${W.xDailyPosts}) reached; resumes after 00:00 UTC` }); saveSt({ ...s, status: "budget_reached", last_error: `Daily X post limit (${W.xDailyPosts}) reached. Collection resumes after 00:00 UTC.`, next_run_at: new Date(+now + interval).toISOString() }); return { skipped: "budget" }; }
        const useSince = s.cursor && s.cursor_time && +now - Date.parse(s.cursor_time) < 6.9 * 864e5;
        r = await xSearch(wl, { since_id: useSince ? s.cursor : null, start_time: useSince ? null : from.toISOString(), runId, maxPosts: W.xPostsPerRun });
        note = r.stopped;
      } else if (source === "youtube") {
        if (ytSearchesToday() >= W.youtubeSearchDaily) { endRun(runId, "skipped", { note: "daily YouTube search limit reached" }); saveSt({ ...s, status: "budget_reached", last_error: `Daily YouTube search limit (${W.youtubeSearchDaily}) reached. Resumes after midnight Pacific Time.`, next_run_at: new Date(+now + interval).toISOString() }); return { skipped: "budget" }; }
        r = await youtubeSearch(wl, { publishedAfter: from.toISOString() }); note = r.stopped;
      } else if (source === "news") {
        const feeds = def.feeds.length ? def.feeds : String(C.rssFeeds || "").split(/[\s,]+/).filter(Boolean);
        const n = await collectors.run.news({ feeds: feeds.join(" "), from: from.toISOString(), max: 500 });
        r = { rows: n.rows, requests: feeds.length, pages: feeds.length }; note = n.errors.length ? `some feeds failed: ${n.errors.join("; ").slice(0, 500)}` : null;
        if (n.errors.length && !n.rows.length && n.errors.length === feeds.length) throw new ApiFailure("http", n.errors.join("; ").slice(0, 500), { retryable: false });
      } else if (platforms[source]) {
        r = await platforms[source].search(def, { from: from.toISOString(), cursor: s.cursor }); note = r.stopped;
      }
      const res = watch.ingest(wl, source, r.rows, { runId });
      // the position is saved only after the posts are stored
      const newest = r.rows.reduce((a, x) => (x.posted_at && x.posted_at > a ? x.posted_at : a), s.cursor_time && source !== "x_search" ? s.cursor_time : "");
      saveSt({ ...s, status: "ok", cursor: source === "x_search" ? r.newest_id || s.cursor : r.cursor ?? null, cursor_time: source === "x_search" ? (r.newest_id ? iso : s.cursor_time) : (newest || iso), last_run_at: iso, last_ok_at: nowISO(), next_run_at: new Date(+now + interval).toISOString(),
        backoff_until: null, failures: 0, last_error: note, last_found: res.matched, last_new: res.new_matches });
      endRun(runId, note && /failed|stopped|limit/.test(note) ? "partial" : "ok", { requests: r.requests, pages: r.pages, note });
      return res;
    } catch (e) {
      const partial = e.partial?.rows?.length ? watch.ingest(wl, source, e.partial.rows, { runId }) : null;
      const failures = (s.failures || 0) + 1, wait = e.kind === "rate" ? (e.resetAt ? Math.max(60e3, Date.parse(e.resetAt) - Date.now()) : 60e3 * 2 ** Math.min(6, failures - 1)) : Math.min(W.maxHttpBackoffMs, 5e3 * 2 ** (failures - 1));
      const status = e.kind === "auth" ? "not_permitted" : e.kind === "rate" ? "rate_limited" : e.kind === "config" ? "error" : "retrying";
      saveSt({ ...s, status, last_run_at: iso, failures, backoff_until: new Date(Date.now() + wait * W.retryScale).toISOString(), next_run_at: s.next_run_at || iso, last_error: e.message });
      endRun(runId, partial ? "partial" : "failed", { requests: e.partial?.out?.requests || 0, pages: e.partial?.out?.pages || 0, error: e.message });
      if (failures === 5 || e.kind === "auth") audit(null, "Mention watch collection failing", "watchlist", String(wl.id), { source, failures, error: e.message });
      return { error: e.message, partial };
    }
  }

  // ------------------------------------------------------------ metrics refresh (public counts of posts under watch)
  async function refreshMetrics() {
    const since = new Date(Date.now() - 48 * 3600e3).toISOString(), out = { x: 0, youtube: 0, errors: [] };
    const pick = platform => db.prepare(`SELECT DISTINCT p.id, p.post_id FROM watch_posts p JOIN watch_matches m ON m.post_id = p.id JOIN watchlists w ON w.id = m.watchlist_id
      WHERE w.status = 'active' AND p.platform = ? AND m.detected_at >= ? AND (EXISTS (SELECT 1 FROM watch_alerts a WHERE a.post_id = p.id AND a.status IN ('new','acknowledged'))
        OR (SELECT COUNT(*) FROM watch_matches m2 WHERE m2.watchlist_id = m.watchlist_id AND m2.cluster = m.cluster) > 1 OR p.platform = 'YouTube') LIMIT ?`).all(platform, since, platform === "YouTube" ? 200 : 100);
    const apply = (row, source) => {
      const p = db.prepare("SELECT * FROM watch_posts WHERE platform = ? AND post_id = ?").get(row.platform, row.post_id); if (!p) return;
      watch.observeMetrics(p, row, source, nowISO());
      for (const m of db.prepare("SELECT watchlist_id FROM watch_matches WHERE post_id = ?").all(p.id)) { const wl = watch.get(m.watchlist_id); if (wl.status === "active") watch.checkEngagement(wl, p.id); }
    };
    const xs = C.xBearer ? pick("X (Twitter)") : [];
    if (xs.length && xPostsToday() + xs.length <= W.xDailyPosts) {
      const u = new URL(`${B.x.replace(/\/$/, "")}/2/tweets`); u.searchParams.set("ids", xs.map(x => x.post_id).join(",")); for (const [k, v] of Object.entries(X_FIELDS)) u.searchParams.set(k, v);
      try { const r = await withRetry(() => request(u, { headers: { Authorization: `Bearer ${C.xBearer}` } })), data = r.json.data || [], users = new Map((r.json.includes?.users || []).map(x => [x.id, x]));
        usage("x_api", "tweets lookup (metrics refresh)", data.length, "posts", "ok", data.length * W.usdPerXPost); for (const t of data) apply(xRow(t, users, "X API v2 post lookup"), "x_lookup"); out.x = data.length; }
      catch (e) { out.errors.push(`X: ${e.message}`); }
    }
    const ys = C.youtubeKey ? pick("YouTube") : [];
    for (let i = 0; i < ys.length; i += 50) {
      const u = new URL(`${B.youtube.replace(/\/$/, "")}/youtube/v3/videos`); u.searchParams.set("part", "snippet,statistics"); u.searchParams.set("id", ys.slice(i, i + 50).map(x => x.post_id).join(",")); u.searchParams.set("key", C.youtubeKey);
      try { const r = await withRetry(() => request(u)); usage("youtube_api", "videos.list (metrics refresh)", 1, "quota units", "ok"); for (const v of r.json.items || []) { apply(ytRow(v, "YouTube Data API v3 videos.list"), "youtube_lookup"); out.youtube++; } }
      catch (e) { out.errors.push(`YouTube: ${e.message}`); break; }
    }
    // Reddit Data API terms: blank stored posts that were deleted on Reddit
    try { const sw = await platforms.reddit.sweep(db); if (sw) out.reddit_deleted_check = sw; } catch (e) { out.errors.push(`Reddit deletion check: ${e.message}`); }
    svc.set("metrics_refresh", { at: nowISO(), ...out });
    return out;
  }

  // ------------------------------------------------------------ X filtered stream
  const S = { ac: null, connecting: false, lastData: 0, backoff: 0, failures: 0, stopped: true, timer: null, watchdog: null, gapFrom: null, lastSaved: 0, connectedAt: null };
  const streamState = patch => { const cur = svc.get("x_stream") || {}; const next = { ...cur, ...patch }; svc.set("x_stream", next); return next; };
  const streamWatchlists = () => db.prepare("SELECT id FROM watchlists WHERE status = 'active'").all().map(r => watch.get(r.id)).filter(w => w.definition.sources.includes("x_stream"));
  const tagOf = id => `aivs-wl-${id}`;
  async function syncRules() {
    const desired = streamWatchlists().map(w => ({ value: xQuery(w.definition, { stream: true }).query, tag: tagOf(w.id), ok: xQuery(w.definition, { stream: true }).ok })).filter(r => r.ok);
    const H = { Authorization: `Bearer ${C.xBearer}` }, base = `${B.x.replace(/\/$/, "")}/2/tweets/search/stream/rules`;
    const cur = (await withRetry(() => request(base, { headers: H }))).json.data || [], mine = cur.filter(r => String(r.tag || "").startsWith("aivs-wl-"));
    const del = mine.filter(r => !desired.some(d => d.tag === r.tag && d.value === r.value)).map(r => r.id), add = desired.filter(d => !mine.some(r => r.tag === d.tag && r.value === d.value)).map(({ value, tag }) => ({ value, tag }));
    if (del.length) await withRetry(() => request(base, { method: "POST", headers: H, body: { delete: { ids: del } } }));
    let errors = [];
    if (add.length) { const r = await withRetry(() => request(base, { method: "POST", headers: H, body: { add } })); errors = (r.json.errors || []).map(e => `${e.value || ""} ${e.title || ""} ${e.details?.join(" ") || e.detail || ""}`.trim()); }
    const out = { rules: desired.length, added: add.length, deleted: del.length, other_rules: cur.length - mine.length, errors, at: nowISO() };
    streamState({ rules: out });
    if (out.other_rules) streamState({ note: `${out.other_rules} rule(s) not created by AIVS exist in this X project. Their posts arrive on the same connection and are ignored by AIVS.` });
    return out;
  }
  async function validateRule(value) {
    const r = await request(`${B.x.replace(/\/$/, "")}/2/tweets/search/stream/rules?dry_run=true`, { method: "POST", headers: { Authorization: `Bearer ${C.xBearer}` }, body: { add: [{ value, tag: "aivs-dry-run" }] } });
    const errs = (r.json.errors || []).map(e => [e.title, e.detail, ...(e.details || [])].filter(Boolean).join(": "));
    return { valid: !errs.length && (r.json.meta?.summary?.valid ?? 1) > 0, errors: errs };
  }
  function handleLine(line) {
    let j; try { j = JSON.parse(line); } catch { return; }
    if (!j.data) { if (j.errors?.length) { const e = j.errors[0]; streamState({ last_error: [e.title, e.detail].filter(Boolean).join(": ").slice(0, 300) }); if (/disconnect/i.test(e.title || "") || e.disconnect_type) S.ac?.abort(new ApiFailure("http", e.detail || e.title, { retryable: true })); } return; }
    const users = new Map((j.includes?.users || []).map(x => [x.id, x])), row = xRow(j.data, users, "X API v2 filtered stream");
    usage("x_api", "tweets/search/stream", 1, "posts", "ok", W.usdPerXPost);
    let used = 0;
    for (const m of j.matching_rules || []) {
      const id = /^aivs-wl-(\d+)$/.exec(m.tag || "")?.[1]; if (!id) continue;
      let wl; try { wl = watch.get(id); } catch { continue; }
      if (wl.status !== "active" || !wl.definition.sources.includes("x_stream")) continue;
      watch.ingest(wl, "x_stream", [row]); used++;
    }
    if (!used) streamState({ ignored: (svc.get("x_stream")?.ignored || 0) + 1 });
    if (xPostsToday() >= W.xDailyPosts) { streamState({ status: "budget_reached", last_error: `Daily X post limit (${W.xDailyPosts}) reached; the stream reconnects after 00:00 UTC.` }); S.budgetStop = true; S.ac?.abort(); }
  }
  async function connectStream() {
    if (S.connecting || S.ac) return; S.connecting = true;
    const gapStart = S.gapFrom || (svc.get("x_stream")?.status === "connected" ? svc.get("x_stream")?.last_data_at : null);
    const u = new URL(`${B.x.replace(/\/$/, "")}/2/tweets/search/stream`); for (const [k, v] of Object.entries(X_FIELDS)) u.searchParams.set(k, v);
    const gapMin = gapStart ? (Date.now() - Date.parse(gapStart)) / 60e3 : 0;
    if (W.xBackfillMinutes > 0 && gapStart) u.searchParams.set("backfill_minutes", String(Math.min(5, W.xBackfillMinutes, Math.ceil(gapMin))));
    const ac = new AbortController(); S.ac = ac;
    try {
      await syncRules();
      const r = await fetch(u, { headers: { Authorization: `Bearer ${C.xBearer}`, "User-Agent": UA }, signal: ac.signal });
      if (!r.ok) { const t = await r.text().catch(() => ""); let j = null; try { j = JSON.parse(t); } catch {} const msg = [j?.title, j?.detail, j?.connection_issue].filter(Boolean).join(": ") || t.slice(0, 200);
        throw new ApiFailure(r.status === 429 ? "rate" : [401, 402, 403].includes(r.status) ? "auth" : "http", `HTTP ${r.status}${msg ? `: ${msg}` : ""}`, { status: r.status, retryable: true }); }
      S.connecting = false; S.lastData = Date.now(); S.failures = 0; S.backoff = 0; S.connectedAt = nowISO();
      const now = nowISO();
      // record the period without a connection, then recover it (backfill covers up to 5 min when enabled; otherwise recent search)
      if (gapStart) { const covered = W.xBackfillMinutes > 0 && gapMin <= Math.min(5, W.xBackfillMinutes); recordGap(gapStart, now, covered); }
      S.gapFrom = null;
      streamState({ status: "connected", connected_at: now, last_data_at: now, last_error: null, backoff_ms: 0, failures: 0 });
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) throw new ApiFailure("network", "the stream was closed by X");
        S.lastData = Date.now(); buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); if (line.trim()) handleLine(line); }
        if (Date.now() - S.lastSaved > 60e3) { S.lastSaved = Date.now(); streamState({ last_data_at: new Date(S.lastData).toISOString() }); }
      }
    } catch (e) {
      const err = ac.signal.reason instanceof ApiFailure ? ac.signal.reason : e instanceof ApiFailure ? e : new ApiFailure("network", ac.signal.aborted ? (S.stalled ? `no data or keep-alive for ${Math.round(W.stallMs / 1000)} s` : "connection closed") : `could not connect (${e.cause?.code || e.message})`);
      S.connecting = false; S.ac = null; S.stalled = false;
      if (S.lastData && !S.gapFrom) S.gapFrom = new Date(S.lastData).toISOString(); else if (!S.gapFrom) S.gapFrom = nowISO();
      if (S.stopped) { streamState({ status: "off", last_data_at: S.lastData ? new Date(S.lastData).toISOString() : null }); return; }
      if (S.budgetStop) { S.budgetStop = false; return; }
      S.failures++;
      if (err.kind === "auth") { streamState({ status: "not_permitted", last_error: `${err.message}. The stream stays off until an administrator presses Reconnect (check the token, the access level and the credit).`, failures: S.failures }); audit(null, "X filtered stream refused", "watch", "x_stream", { error: err.message }); return; }
      S.backoff = err.kind === "network" ? Math.min(16000, S.backoff + 250) : err.kind === "rate" ? (S.backoff >= 60000 ? S.backoff * 2 : 60000) : Math.min(W.maxHttpBackoffMs, S.backoff >= 5000 ? S.backoff * 2 : 5000);
      // reconnect immediately after the first drop of an established connection (X's guidance), then back off
      const wait = S.failures === 1 && err.kind === "network" ? 0 : S.backoff;
      streamState({ status: "reconnecting", last_error: err.message, backoff_ms: wait, failures: S.failures, last_data_at: S.lastData ? new Date(S.lastData).toISOString() : null, ...(wait >= W.maxHttpBackoffMs ? { warning: `Reconnects are failing repeatedly (${S.failures} attempts). Check X's status page and the server's connection.` } : {}) });
      if (S.failures === 10) audit(null, "X filtered stream reconnecting repeatedly", "watch", "x_stream", { failures: S.failures, error: err.message });
      clearTimeout(S.timer); S.timer = setTimeout(() => { if (!S.stopped) connectStream(); }, wait * W.retryScale); S.timer.unref?.();
    }
  }
  function recordGap(from, to, coveredByBackfill) {
    const id = Number(db.prepare("INSERT INTO watch_runs(watchlist_id,source,kind,started_at,finished_at,status,window_from,window_to,note) VALUES (NULL,'x_stream','gap',?,?,?,?,?,?)")
      .run(nowISO(), nowISO(), coveredByBackfill ? "ok" : "failed", from, to, coveredByBackfill ? "disconnected; recovered with backfill_minutes on reconnection" : "disconnected; recovery by recent search pending").lastInsertRowid);
    if (!coveredByBackfill) S.pendingGaps = [...(S.pendingGaps || []), { id, from, to }];
    return id;
  }
  // recover stream gaps with recent search (X's documented alternative when backfill is not available or the gap is longer)
  async function fillGaps() {
    const gaps = S.pendingGaps || []; S.pendingGaps = [];
    for (const g of gaps) {
      if (!sourcesReady("x_search")) { db.prepare("UPDATE watch_runs SET note = ? WHERE id = ?").run("disconnected; not recovered: X recent search is not configured", g.id); continue; }
      const end = new Date(Math.min(Date.parse(g.to), Date.now() - 30e3)).toISOString(); let fetched = 0, errs = [];
      for (const wl of streamWatchlists()) {
        const runId = startRun(wl.id, "x_search", "gapfill", g.from, end);
        try { const r = await xSearch(wl, { start_time: g.from, end_time: end, runId, maxPosts: W.xPostsPerRun }); watch.ingest(wl, "x_search", r.rows, { runId }); fetched += r.rows.length; endRun(runId, r.stopped ? "partial" : "ok", { requests: r.requests, pages: r.pages, note: r.stopped }); }
        catch (e) { errs.push(e.message); endRun(runId, "failed", { error: e.message }); }
      }
      db.prepare("UPDATE watch_runs SET note = ? WHERE id = ?").run(errs.length ? `disconnected; recovery by recent search failed: ${errs.join("; ").slice(0, 300)}` : `disconnected; recovered by recent search (${fetched} posts fetched)`, g.id);
      if (!errs.length) db.prepare("UPDATE watch_runs SET status = 'ok' WHERE id = ?").run(g.id);
    }
  }
  function ensureStream() {
    const want = sourcesReady("x_stream") && streamWatchlists().length > 0 && (svc.get("x_stream")?.status !== "not_permitted") && xPostsToday() < W.xDailyPosts;
    if (want && S.stopped) { S.stopped = false; connectStream(); S.watchdog = setInterval(() => { if (S.ac && !S.connecting && Date.now() - S.lastData > W.stallMs) { S.stalled = true; S.ac.abort(); } }, Math.min(5000, W.stallMs / 2)); S.watchdog.unref?.(); }
    else if (want && S.ac && !S.connecting) { const h = JSON.stringify(streamWatchlists().map(w => [w.id, xQuery(w.definition, { stream: true }).query])); if (h !== S.rulesHash) { S.rulesHash = h; syncRules().catch(e => streamState({ last_error: `rules: ${e.message}` })); } }
    else if (!want && !S.stopped) stopStream();
  }
  function stopStream() { S.stopped = true; clearTimeout(S.timer); clearInterval(S.watchdog); S.ac?.abort(); S.ac = null; streamState({ status: "off" }); }
  function reconnect(user) { streamState({ status: "off", last_error: null }); audit(user, "X filtered stream reconnect requested", "watch", "x_stream"); stopStream(); S.failures = 0; S.backoff = 0; ensureStream(); }

  // ------------------------------------------------------------ the scheduler
  let timer = null, ticking = false, lastMetrics = 0;
  async function tick() {
    if (ticking) return { busy: true }; ticking = true; const out = { runs: 0 };
    try {
      ensureStream();
      if (S.pendingGaps?.length) await fillGaps();
      const now = Date.now();
      for (const { id } of db.prepare("SELECT id FROM watchlists WHERE status = 'active' ORDER BY id").all()) {
        const wl = watch.get(id);
        for (const source of wl.definition.sources.filter(x => WATCH_SOURCES[x]?.mode === "poll")) {
          const s = st(wl.id, source);
          if (s.backoff_until && Date.parse(s.backoff_until) > now) continue;
          if (s.next_run_at && Date.parse(s.next_run_at) > now && s.status !== "retrying" && s.status !== "rate_limited") continue;
          if (s.status === "not_permitted" && s.backoff_until && Date.parse(s.backoff_until) > now - 3600e3) continue;
          await runSource(wl, source); out.runs++;
        }
        watch.checkVolume(watch.get(id));
      }
      if (W.metricsRefreshMinutes > 0 && Date.now() - lastMetrics > W.metricsRefreshMinutes * 60e3) { lastMetrics = Date.now(); await refreshMetrics(); }
    } finally { ticking = false; }
    return out;
  }
  // after a restart: runs cut off mid-way are marked, and the stream's silent period is recorded for recovery
  function resume() {
    const n = db.prepare("UPDATE watch_runs SET status = 'interrupted', finished_at = ?, note = 'interrupted by a server restart; the next run continues from the last saved position' WHERE status = 'running'").run(nowISO()).changes;
    db.prepare("UPDATE watch_source_state SET status = 'idle' WHERE status = 'running'").run();
    const s = svc.get("x_stream");
    if (s && ["connected", "reconnecting"].includes(s.status) && s.last_data_at) { S.gapFrom = s.last_data_at; streamState({ status: "off", note: "server restarted; the period since the last data will be recovered" }); }
    return { interrupted_runs: n };
  }
  function start() { if (!W.enabled || timer) return; resume(); timer = setInterval(() => tick().catch(e => console.error("Mention watch:", e.message)), W.tickSeconds * 1000); timer.unref?.(); setTimeout(() => tick().catch(() => {}), 5000).unref?.(); }
  function stop() { clearInterval(timer); timer = null; stopStream(); }

  // ------------------------------------------------------------ preview without storing anything
  async function previewLive(def, sources, { max = 25 } = {}) {
    const fake = { id: 0, name: "preview", definition: def }, out = [];
    for (const source of sources) {
      const item = { source, label: WATCH_SOURCES[source]?.label || source, fetched: 0, matched: 0, posts: [], error: null, note: null };
      try {
        if (!sourcesReady(source === "x_stream" ? "x_search" : source)) throw new Error(sourceState(source).needs || "not configured");
        let rows = [];
        if (source === "x_search" || source === "x_stream") {
          if (source === "x_stream") { const v = await validateRule(xQuery(def, { stream: true }).query); item.rule_check = v; if (!v.valid) throw new Error(`X rejected the stream rule: ${v.errors.join("; ")}`); }
          if (xPostsToday() + max > W.xDailyPosts) throw new Error("the daily X post limit would be exceeded");
          const r = await xSearch(fake, { start_time: new Date(Date.now() - def.lookback_minutes * 60e3).toISOString(), maxPosts: Math.min(100, Math.max(10, max)), maxPages: 1 }); rows = r.rows;
          item.note = `One X recent search request (${r.rows.length} posts returned, about $${(r.rows.length * W.usdPerXPost).toFixed(3)}).${source === "x_stream" ? " The stream rule was checked with X (dry run) and the same query was searched over the look-back period." : ""}`;
        } else if (source === "youtube") { const r = await youtubeSearch(fake, { publishedAfter: new Date(Date.now() - Math.max(def.lookback_minutes, 1440) * 60e3).toISOString() }); rows = r.rows; item.note = "One YouTube search call (of the 100 a day) over the last 24 hours or the look-back period."; }
        else if (platforms[source]) { const r = await platforms[source].search(def, { from: new Date(Date.now() - Math.max(def.lookback_minutes, 1440) * 60e3).toISOString() }); rows = r.rows; item.note = `${r.requests} request(s) to ${platforms[source].platform}.${r.stopped ? ` ${r.stopped}.` : ""}`; }
        else if (source === "news") { const feeds = def.feeds.length ? def.feeds : String(C.rssFeeds || "").split(/[\s,]+/).filter(Boolean); if (!feeds.length) throw new Error("no news feeds named"); const n = await collectors.run.news({ feeds: feeds.join(" "), max: 300 }); rows = n.rows; if (n.errors.length) item.note = n.errors.join("; ").slice(0, 400); }
        item.fetched = rows.length;
        for (const r of rows) { const m = matchPost(def, r); if (m.matched) item.matched++; if (item.posts.length < max) item.posts.push({ platform: r.platform, account: r.account, text: r.text.slice(0, 600), url: r.url, posted_at: r.posted_at, matched: m.matched, why: m.why || null, terms: m.terms || [] }); }
      } catch (e) { item.error = e.message; }
      out.push(item);
    }
    return out;
  }
  // ------------------------------------------------------------ the capability table with each connector's real state
  function lastSuccess(key) {
    if (key === "x_stream") { const x = svc.get("x_stream"); return x?.status === "connected" ? x.last_data_at || x.connected_at : x?.last_data_at || null; }
    if (key === "whatsapp_business") return svc.get("whatsapp_webhook")?.last_at || null;
    return db.prepare("SELECT MAX(last_ok_at) t FROM watch_source_state WHERE source = ?").get(key).t || null;
  }
  function platformTable() {
    const live = svc.get("live_check") || {};
    return CAPABILITIES.map(c => {
      const cons = c.connectors.map(k => {
        const st = sourceState(k), refused = db.prepare("SELECT last_error FROM watch_source_state WHERE source = ? AND status = 'not_permitted' ORDER BY last_run_at DESC LIMIT 1").get(k), last = lastSuccess(k);
        const failing = k === "x_stream" ? svc.get("x_stream")?.status === "not_permitted" : !!refused;
        return { key: k, label: WATCH_SOURCES[k]?.label || k, state: st.state, needs: st.needs || null, last_success: last, refused: failing ? (refused?.last_error || svc.get("x_stream")?.last_error || "refused") : null, live_check: live[k] || null };
      });
      let status, detail;
      if (!c.built) { status = "unavailable"; detail = c.coverage; }
      else if (cons.some(x => x.refused)) { status = "restricted"; detail = `The platform refused access: ${cons.find(x => x.refused).refused}`; }
      else if (cons.some(x => x.state === "ready" && x.last_success)) { status = "working"; detail = "Configured; last successful collection shown."; }
      else if (cons.some(x => x.state === "ready")) { status = "needs configuration"; detail = "Credentials are set, but no collection has succeeded yet: activate a watchlist that uses it, or press Test connection."; }
      else if (c.approval) { status = "restricted"; detail = `Needs approval from the platform: ${c.access}`; }
      else { status = "needs configuration"; detail = cons.map(x => x.needs).filter(Boolean).join("; "); }
      return { ...c, status, detail, connectors_state: cons, last_success: cons.map(x => x.last_success).filter(Boolean).sort().at(-1) || null };
    });
  }
  // one real request to a configured source, to verify it live (the result is kept and shown; simulated tests never set it)
  async function liveCheck(user, key, def) {
    let r;
    if (key === "whatsapp_business") { const w = svc.get("whatsapp_webhook"); r = { ok: !!w?.last_at, note: w?.last_at ? `last webhook from Meta received ${w.last_at}` : "no webhook has been received from Meta yet; Meta must be able to reach this server over HTTPS" }; }
    else if (key === "x_stream") { try { const v = await validateRule(xQuery(def, { stream: true }).query); r = { ok: v.valid, note: v.valid ? "X accepted the stream rule (dry run)" : v.errors.join("; ") }; } catch (e) { r = { ok: false, note: e.message }; } }
    else { const [p] = await previewLive(def, [key], { max: 10 }); r = { ok: !p.error, fetched: p.fetched, matched: p.matched, note: p.error || p.note || `${p.fetched} item(s) returned, ${p.matched} matching` }; }
    const all = svc.get("live_check") || {}; all[key] = { ...r, at: nowISO(), by: user?.display_name || null }; svc.set("live_check", all);
    audit(user, `Mention watch live check: ${key} ${r.ok ? "passed" : "failed"}`, "watch", key, { note: String(r.note || "").slice(0, 300) });
    return all[key];
  }
  // WhatsApp Business webhook: messages people send to our own business number. Senders are pseudonymised; only
  // messages matching an active watchlist that uses this source are stored.
  function whatsappWebhook(payload) {
    const out = { messages: 0, text: 0, matched: 0 }, wls = db.prepare("SELECT id FROM watchlists WHERE status = 'active'").all().map(x => watch.get(x.id)).filter(w => w.definition.sources.includes("whatsapp_business"));
    for (const e of payload?.entry || []) for (const ch of e.changes || []) {
      if (ch.field !== "messages") continue;
      for (const m of ch.value?.messages || []) {
        out.messages++; if (m.type !== "text" || !m.text?.body) continue; out.text++;
        const row = { platform: "WhatsApp Business", post_id: m.id, account: `sender ${crypto.createHash("sha256").update(String(m.from)).digest("hex").slice(0, 10)}`, author_name: null, text: String(m.text.body).slice(0, 10000), url: null,
          posted_at: m.timestamp ? new Date(+m.timestamp * 1000).toISOString() : null, language: null, collected_via: "Message sent to our WhatsApp Business number (Cloud API webhook); sender pseudonymised" };
        for (const wl of wls) out.matched += watch.ingest(wl, "whatsapp_business", [row]).new_matches;
      }
    }
    const prev = svc.get("whatsapp_webhook") || {}; svc.set("whatsapp_webhook", { last_at: nowISO(), received: (prev.received || 0) + out.messages, matched: (prev.matched || 0) + out.matched });
    usage("whatsapp_webhook", "messages", out.messages, "messages", "ok");
    return out;
  }
  return { status, start, stop, tick, resume, runSource, refreshMetrics, syncRules, validateRule, ensureStream, reconnect, sourcesReady, previewLive, liveCheck, whatsappWebhook, sourceLabel: k => WATCH_SOURCES[k]?.label || k, _stream: S };
}

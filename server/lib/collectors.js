// Collection of PUBLIC posts through official, documented access methods only. Each collector runs on the server,
// keeps its key in server settings, respects the service's limits (one request at a time, a cap on items) and
// records exactly which API and query produced each record. Platforms without an approved access route are
// listed as pending; AIVS never scrapes, logs in, or works around privacy settings or rate limits.
//   news (RSS/Atom)  public news feeds chosen by the analyst         no key
//   youtube          YouTube Data API v3: search + video statistics  YOUTUBE_API_KEY (search.list: 100 calls a day, own bucket)
//   x                X API v2 recent search (last 7 days)            X_BEARER_TOKEN (paid access tiers)
//   facebook, instagram, tiktok                                      pending: need approved research access
import { fetchPage } from "./fetchurl.js";
import { HttpError } from "./auth.js";
import { nowISO } from "./db.js";

export function collectorStatus(config) {
  const C = config.collect || {};
  return [
    { key: "file", label: "File import (CSV, JSON, Excel .xlsx)", platforms: ["Any platform's export"], state: "ready", note: "Exports you are permitted to use, such as research API downloads or partner submissions." },
    { key: "screenshots", label: "Screenshots of posts", platforms: ["Any platform"], state: "ready", note: "Read on your computer with OCR; you check every row before it is imported." },
    { key: "news", label: "News websites (RSS or Atom feeds)", platforms: ["Public news websites"], state: "ready", note: "Feeds you name; only the headline, summary, link and date the publisher puts in the feed are stored." },
    { key: "youtube", label: "YouTube Data API v3", platforms: ["YouTube"], state: C.youtubeKey ? "ready" : "not_configured", needs: "YOUTUBE_API_KEY (free key from Google Cloud). Searches are limited to 100 calls a day per project (search.list has its own quota bucket; each page of 50 results is one call)", note: "Video titles, descriptions, channel, date and public counts (views, likes, comments)." },
    { key: "x", label: "X API v2 recent search", platforms: ["X (Twitter)"], state: C.xBearer ? "ready" : "not_configured", needs: "X_BEARER_TOKEN (an X developer account with a paid access tier that includes search)", note: "Public posts from the last 7 days with public counts." },
    { key: "facebook", label: "Facebook and Instagram (Meta Content Library)", platforms: ["Facebook", "Instagram"], state: "pending", needs: "approved research access to the Meta Content Library; not built until access exists. Use exports you are permitted to use meanwhile." },
    { key: "tiktok", label: "TikTok Research API", platforms: ["TikTok"], state: "pending", needs: "approved TikTok Research API access (academic and non-profit researchers); not built until access exists. Use exports meanwhile." }
  ];
}

export function makeCollectors(db, { config }) {
  const C = { timeoutMs: 15000, maxItems: 500, youtubeKey: "", xBearer: "", ...(config.collect || {}) };
  const B = { youtube: "https://www.googleapis.com", x: "https://api.x.com", ...(C.bases || {}) };
  const usage = (service, op, units, status) => { try { db.prepare("INSERT INTO api_usage(at,service,operation,units,unit,est_cost_usd,status) VALUES (?,?,?,?,?,?,?)").run(nowISO(), service, op, units, service === "youtube_api" ? (op === "search.list" ? "search calls" : "quota units") : "request", null, status); } catch {} };
  async function getJson(url, headers = {}) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), C.timeoutMs);
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ac.signal }), body = await r.text(); let j = null; try { j = JSON.parse(body); } catch {}
      if (r.status === 429) throw new Error("the service's rate limit was reached; try again later (AIVS does not retry automatically)");
      if (!r.ok) throw new Error(`HTTP ${r.status}${j?.error?.message ? `: ${String(j.error.message).slice(0, 200)}` : j?.detail ? `: ${String(j.detail).slice(0, 200)}` : j?.title ? `: ${j.title}` : ""}`);
      if (!j) throw new Error("the service did not return JSON"); return j;
    } catch (e) { if (e.name === "AbortError") throw new Error(`no answer within ${Math.round(C.timeoutMs / 1000)} s`); throw e; }
    finally { clearTimeout(t); }
  }
  const cap = n => Math.max(1, Math.min(C.maxItems, Number(n) || 100));
  const inRange = (iso, from, to) => (!from || iso >= from) && (!to || iso <= to);
  const strip = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, m => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " }[m.toLowerCase()] ?? (m[2]?.toLowerCase() === "x" ? String.fromCodePoint(parseInt(m.slice(3, -1), 16)) : String.fromCodePoint(+m.slice(2, -1))))).replace(/\s+/g, " ").trim();
  const matches = (text, query) => { const q = String(query || "").toLowerCase().split(/\s+/).filter(Boolean); if (!q.length) return true; const t = text.toLowerCase(); return q.every(w => t.includes(w)); };

  async function news({ feeds, query, from, to, max }) {
    const list = [...new Set(String(feeds || "").split(/[\s,]+/).filter(Boolean))].slice(0, 20);
    if (!list.length) throw new HttpError(400, "Give at least one news feed address (RSS or Atom), for example https://www.example-news.co.ke/rss.");
    const rows = [], errors = [], found = [], at = nowISO();
    for (let f of list) {
      try {
        let page = await fetchPage(f, { allowPrivate: !!config.allowPrivateFetch, allowXml: true });
        if (!page.xml) {   // a website address: use the feed the site itself announces (<link rel="alternate" type="application/rss+xml">)
          const html = page.raw.toString("utf8"), links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).filter(t => /rel=["']?alternate/i.test(t) && /type=["']?application\/(rss|atom)\+xml/i.test(t));
          const href = links.map(t => (/href=["']([^"']+)["']/i.exec(t) || [])[1]).find(Boolean);
          if (!href) { errors.push(`${f}: this page does not announce a news feed. Ask the publisher for its RSS address, or look for an RSS link on the site.`); continue; }
          const feedUrl = new URL(href, page.finalUrl).href; found.push({ site: f, feed: feedUrl });
          page = await fetchPage(feedUrl, { allowPrivate: !!config.allowPrivateFetch, allowXml: true });
          if (!page.xml) { errors.push(`${f}: the announced feed ${feedUrl} is not an RSS or Atom feed`); continue; }
          f = feedUrl;
        }
        const xml = page.xml || page.raw.toString("utf8"), channel = strip((/<(?:channel|feed)\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml) || [])[1]) || new URL(page.finalUrl).hostname;
        const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
        if (!items.length && !/<(rss|feed|rdf)\b/i.test(xml)) { errors.push(`${f}: this is not an RSS or Atom feed`); continue; }
        for (const it of items) {
          const g = tag => (new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(it) || [])[1];
          const link = strip(g("link")) || (/<link\b[^>]*href="([^"]+)"/i.exec(it) || [])[1] || null, title = strip(g("title")), desc = strip(g("description") || g("summary") || g("content"));
          const when = strip(g("pubDate") || g("published") || g("updated") || g("dc:date")), d = new Date(when);
          if (!title || isNaN(d)) continue; const iso = d.toISOString();
          const text = desc && !desc.startsWith(title) ? `${title} — ${desc}` : title;
          if (!inRange(iso, from, to) || !matches(text, query)) continue;
          rows.push({ platform: "News website", account: channel.slice(0, 80), posted_at: iso, text: text.slice(0, 5000), url: link && /^https?:\/\//.test(link) ? link : null, post_id: strip(g("guid") || g("id")) || link, collected_at: at, collected_via: `RSS/Atom feed ${f}${query ? `, filtered for “${query}”` : ""}`, author: strip(g("dc:creator") || g("author")) || null });
          if (rows.length >= cap(max)) break;
        }
      } catch (e) { errors.push(`${f}: ${e.message}`); }
      if (rows.length >= cap(max)) break;
    }
    return { rows, errors, found, query: { feeds: list, query: query || null, from: from || null, to: to || null } };
  }

  async function youtube({ query, from, to, max }) {
    if (!C.youtubeKey) throw new HttpError(409, "YouTube collection is not configured: add YOUTUBE_API_KEY to the server settings.");
    if (!String(query || "").trim()) throw new HttpError(400, "Give search words for YouTube.");
    const ids = [], errors = [], at = nowISO(); let pageToken = null, pages = 0;
    while (ids.length < cap(max) && pages < 10) {
      const u = new URL(`${B.youtube.replace(/\/$/, "")}/youtube/v3/search`); for (const [k, v] of Object.entries({ part: "snippet", type: "video", q: query, maxResults: "50", order: "date", key: C.youtubeKey })) u.searchParams.set(k, v);
      if (from) u.searchParams.set("publishedAfter", new Date(from).toISOString()); if (to) u.searchParams.set("publishedBefore", new Date(to).toISOString()); if (pageToken) u.searchParams.set("pageToken", pageToken);
      let j; try { j = await getJson(u); usage("youtube_api", "search.list", 1, "ok"); } catch (e) { usage("youtube_api", "search.list", 1, "error"); errors.push(e.message); break; }
      for (const it of j.items || []) if (it.id?.videoId) ids.push(it.id.videoId);
      pages++; pageToken = j.nextPageToken; if (!pageToken) break;
    }
    const rows = [];
    for (let i = 0; i < ids.length && rows.length < cap(max); i += 50) {
      const u = new URL(`${B.youtube.replace(/\/$/, "")}/youtube/v3/videos`); u.searchParams.set("part", "snippet,statistics"); u.searchParams.set("id", ids.slice(i, i + 50).join(",")); u.searchParams.set("key", C.youtubeKey);
      let j; try { j = await getJson(u); usage("youtube_api", "videos.list", 1, "ok"); } catch (e) { usage("youtube_api", "videos.list", 1, "error"); errors.push(e.message); break; }
      for (const v of j.items || []) {
        const s = v.snippet || {}, st = v.statistics || {}, n = x => (x == null ? null : Number(x));
        rows.push({ platform: "YouTube", post_id: v.id, account: s.channelTitle || s.channelId || "unknown channel", posted_at: s.publishedAt, text: [s.title, s.description].filter(Boolean).join(" — ").slice(0, 5000), url: `https://www.youtube.com/watch?v=${v.id}`,
          likes: n(st.likeCount), comments: n(st.commentCount), views: n(st.viewCount), language: s.defaultAudioLanguage || s.defaultLanguage || null, collected_at: at, collected_via: `YouTube Data API v3 search “${query}”` });
      }
    }
    return { rows: rows.slice(0, cap(max)), errors, query: { query, from: from || null, to: to || null } };
  }

  async function x({ query, from, to, max }) {
    if (!C.xBearer) throw new HttpError(409, "X collection is not configured: add X_BEARER_TOKEN to the server settings.");
    if (!String(query || "").trim()) throw new HttpError(400, "Give an X search query, for example: #ExampleTag lang:sw -is:retweet");
    const rows = [], errors = [], at = nowISO(); let next = null, pages = 0;
    while (rows.length < cap(max) && pages < 10) {
      const u = new URL(`${B.x.replace(/\/$/, "")}/2/tweets/search/recent`);
      for (const [k, v] of Object.entries({ query, max_results: String(Math.min(100, Math.max(10, cap(max) - rows.length))), "tweet.fields": "created_at,public_metrics,lang,geo,referenced_tweets,author_id", expansions: "author_id,geo.place_id", "user.fields": "username,created_at", "place.fields": "country_code,full_name" })) u.searchParams.set(k, v);
      if (from) u.searchParams.set("start_time", new Date(from).toISOString()); if (to) u.searchParams.set("end_time", new Date(to).toISOString()); if (next) u.searchParams.set("next_token", next);
      let j; try { j = await getJson(u, { Authorization: `Bearer ${C.xBearer}` }); usage("x_api", "tweets/search/recent", 1, "ok"); } catch (e) { usage("x_api", "tweets/search/recent", 1, "error"); errors.push(e.message); break; }
      const users = new Map((j.includes?.users || []).map(u => [u.id, u])), places = new Map((j.includes?.places || []).map(p => [p.id, p]));
      for (const t of j.data || []) {
        const u = users.get(t.author_id) || {}, m = t.public_metrics || {}, pl = t.geo?.place_id ? places.get(t.geo.place_id) : null, rt = (t.referenced_tweets || []).find(r => r.type === "retweeted");
        rows.push({ platform: "X (Twitter)", post_id: t.id, account: u.username || t.author_id, posted_at: t.created_at, text: t.text, url: u.username ? `https://x.com/${u.username}/status/${t.id}` : null, likes: m.like_count ?? null, comments: m.reply_count ?? null,
          shares: m.retweet_count != null ? m.retweet_count + (m.quote_count || 0) : null, views: m.impression_count ?? null, language: t.lang || null, repost_of: rt?.id || null, account_created_at: u.created_at || null,
          loc_country: pl?.country_code || null, loc_name: pl?.full_name || null, collected_at: at, collected_via: `X API v2 recent search “${query}”` });
      }
      pages++; next = j.meta?.next_token; if (!next) break;
    }
    return { rows: rows.slice(0, cap(max)), errors, query: { query, from: from || null, to: to || null } };
  }
  return { status: () => collectorStatus({ collect: C }), run: { news, youtube, x } };
}

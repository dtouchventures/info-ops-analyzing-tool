// More platforms for KDF Mention Watch, each through its own official API (documentation read 26 October 2026).
//   reddit     Reddit Data API: app-only OAuth, GET /search (posts)        REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME
//              Free access is 100 queries a minute per client and needs Reddit's approval. Reddit's terms require removing
//              content that was deleted on Reddit, so stored Reddit posts are re-checked and blanked when deleted.
//   bluesky    app.bsky.feed.searchPosts through your own PDS               BLUESKY_HANDLE, BLUESKY_APP_PASSWORD (an app password)
//              The public AppView refuses unauthenticated search, so AIVS signs in with an app password.
//   mastodon   public hashtag timelines GET /api/v1/timelines/tag/:tag      MASTODON_INSTANCES (no key)
//              Full-text status search is not public on Mastodon, so only hashtags derived from the terms are followed.
//   threads    Threads keyword_search (KEYWORD and TAG modes)               THREADS_ACCESS_TOKEN with threads_keyword_search approved
//              2,200 queries per user in a rolling 24 h; without approval only the token owner's own posts are searched.
//   instagram  Instagram Graph API hashtag search + recent_media (24 h)     INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID
//              Needs the Instagram Public Content Access feature; at most 30 unique hashtags in 7 days; no usernames.
//   facebook   Graph API /{page}/feed and /{post}/comments for named public Pages   FACEBOOK_ACCESS_TOKEN (+ Pages in the watchlist or FACEBOOK_PAGES)
//              Other people's Pages need the Page Public Content Access feature (App Review and business verification);
//              your own Pages need only a Page token. Facebook offers no keyword search across all of Facebook.
//   tiktok     TikTok Research API POST /v2/research/video/query/             TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
//              Only for researchers TikTok has approved (academic institutions in the U.S., EEA, UK, Canada, Switzerland and
//              some EU non-profits); 1,000 requests a day, 100 videos each.
//   telegram   Bot API getUpdates (channel_post)                              TELEGRAM_BOT_TOKEN
//              Only channels where your bot has been added; public channels, plus your own private channels listed in
//              TELEGRAM_OWN_CHANNELS. Group chats and direct messages to the bot are ignored. There is no search.
// Every result is matched again against the watchlist (terms, context words, exclusions) before it is kept.
import { nowISO } from "./db.js";

const strip = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, m => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " }[m])).replace(/\n{3,}/g, "\n\n").trim();
const n = v => (v == null || v === "" ? null : Number(v));
// one search string per term (hashtags without #), duplicates removed; phrases quoted
export function termQueries(def) {
  const seen = new Map();
  for (const t of def.terms) { const bare = t.replace(/^#/, "").trim(), k = bare.toLowerCase(); if (!seen.has(k)) seen.set(k, { q: /\s/.test(bare) ? `"${bare}"` : bare, bare, tag: t.startsWith("#") }); else if (t.startsWith("#")) seen.get(k).tag = true; }
  return [...seen.values()];
}
// hashtags a platform can follow: written hashtags, single words, and phrases joined up (Kenya Defence Forces -> KenyaDefenceForces)
export function termTags(def) {
  const out = new Map();
  for (const t of def.terms) { const tag = t.replace(/^#/, "").split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean).map((w, i, a) => (a.length > 1 ? w[0].toUpperCase() + w.slice(1) : w)).join(""); if (tag.length >= 2 && tag.length <= 100) out.set(tag.toLowerCase(), tag); }
  return [...out.values()];
}
export function redditQueries(def, max = 480) {
  const parts = termQueries(def).map(x => x.q), out = []; let cur = "";
  for (const p of parts) { const next = cur ? `${cur} OR ${p}` : p; if (next.length > max && cur) { out.push(cur); cur = p; } else cur = next; }
  if (cur) out.push(cur); return out;
}

export function makePlatforms({ request, withRetry, usage, config, W, svc, version, ApiFailure }) {
  const P = { redditClientId: "", redditClientSecret: "", redditUsername: "", blueskyHandle: "", blueskyAppPassword: "", blueskyPds: "https://bsky.social", mastodonInstances: "", threadsToken: "", threadsDailyQueries: 1000,
    instagramToken: "", instagramUserId: "", graphVersion: "v26.0", facebookToken: "", facebookPages: "", facebookCommentPosts: 10, tiktokClientKey: "", tiktokClientSecret: "", tiktokDailyRequests: 500, telegramToken: "", telegramOwnChannels: "", ...(config.platforms || {}) };
  const B = { reddit_auth: "https://www.reddit.com", reddit: "https://oauth.reddit.com", threads: "https://graph.threads.com", graph: "https://graph.facebook.com", tiktok: "https://open.tiktokapis.com", telegram: "https://api.telegram.org", ...(config.collect?.bases || {}) };
  const tok = {};   // short-lived tokens, kept in memory only
  const countSince = (service, ms) => usage.count(service, new Date(Date.now() - ms).toISOString());
  const pages = (W.platformPagesPerRun || 3);

  // ---------------------------------------------------------------- Reddit
  const redditUA = () => `server:aivs-mention-watch:${version} (by /u/${P.redditUsername})`;
  async function redditToken() {
    if (tok.reddit && tok.reddit.exp > Date.now() + 60e3) return tok.reddit.v;
    const r = await withRetry(() => request(`${B.reddit_auth}/api/v1/access_token`, { method: "POST", form: { grant_type: "client_credentials" }, headers: { Authorization: `Basic ${Buffer.from(`${P.redditClientId}:${P.redditClientSecret}`).toString("base64")}`, "User-Agent": redditUA() } }));
    if (!r.json.access_token) throw new ApiFailure("auth", `Reddit gave no access token${r.json.error ? ` (${r.json.error})` : ""}. Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET and that the app is approved.`);
    tok.reddit = { v: r.json.access_token, exp: Date.now() + (r.json.expires_in || 3600) * 1000 }; return tok.reddit.v;
  }
  const redditGet = async url => { const t = await redditToken(), r = await withRetry(() => request(url, { headers: { Authorization: `Bearer ${t}`, "User-Agent": redditUA() } })); usage.add("reddit_api", new URL(url).pathname, 1, "request", "ok"); const h = r.headers?.get("x-ratelimit-remaining"), rem = h == null ? NaN : Number(h); if (!isNaN(rem) && rem < 5) throw new ApiFailure("rate", "Reddit's rate limit is nearly used up", { resetAt: new Date(Date.now() + (Number(r.headers.get("x-ratelimit-reset")) || 60) * 1000).toISOString() }); return r.json; };
  const redditRow = (d, via) => ({ platform: "Reddit", post_id: d.name || `t3_${d.id}`, account: d.author && d.author !== "[deleted]" ? `u/${d.author}` : null, author_name: d.subreddit_name_prefixed || null,
    text: [d.title, d.selftext].filter(x => x && x !== "[removed]" && x !== "[deleted]").join(" — ").slice(0, 10000), url: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    posted_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null, language: null, likes: null, comments: n(d.num_comments), shares: null, views: null, collected_via: via });
  const reddit = {
    label: "Reddit Data API search (scheduled)", platform: "Reddit", interval: [15, 5, 1440],
    ready: () => P.redditClientId && P.redditClientSecret && P.redditUsername ? { state: "ready" } : { state: "not_configured", needs: "REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_USERNAME from a Reddit app registered and approved under Reddit's Data API terms" },
    limits: "100 queries a minute per OAuth client (free access). Searches posts (titles and text), not comments. Reddit's terms require deleting content removed on Reddit: AIVS re-checks stored Reddit posts and blanks deleted ones.",
    async search(def, { from }) {
      const since = Date.parse(from) / 1000, rows = [], out = { requests: 0, pages: 0, stopped: null };
      for (const q of redditQueries(def)) {
        let after = null, p = 0;
        while (p < pages) {
          const u = new URL(`${B.reddit}/search`); for (const [k, v] of Object.entries({ q, sort: "new", type: "link", limit: "100", raw_json: "1", t: "week" })) u.searchParams.set(k, v); if (after) u.searchParams.set("after", after);
          const j = await redditGet(u.href); out.requests++; p++; out.pages++;
          const items = (j.data?.children || []).map(c => c.data).filter(Boolean); let older = false;
          for (const d of items) { if (d.created_utc < since) { older = true; continue; } rows.push(redditRow(d, `Reddit Data API search “${q.slice(0, 120)}”`)); }
          after = j.data?.after; if (!after || older) break;
        }
        if (after && p >= pages) out.stopped = `stopped after ${pages} pages for one query; older posts in the window were not fetched`;
      }
      return { rows, ...out };
    },
    // Reddit Data API terms: content deleted on Reddit must be removed from storage
    async sweep(db) {
      if (reddit.ready().state !== "ready") return null;
      const ids = db.prepare("SELECT id, post_id FROM watch_posts WHERE platform = 'Reddit' AND text NOT LIKE '[deleted on Reddit%' ORDER BY id DESC LIMIT 500").all(); let removed = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100), j = await redditGet(`${B.reddit}/api/info?raw_json=1&id=${chunk.map(x => x.post_id).join(",")}`), live = new Map((j.data?.children || []).map(c => [c.data.name, c.data]));
        for (const x of chunk) { const d = live.get(x.post_id); const gone = !d || d.removed_by_category || d.author === "[deleted]" || d.selftext === "[deleted]" || d.selftext === "[removed]";
          if (gone) { db.prepare("UPDATE watch_posts SET text = '[deleted on Reddit; content removed under Reddit''s Data API terms]', account = NULL, author_name = NULL, likes = NULL, comments = NULL WHERE id = ?").run(x.id); db.prepare("DELETE FROM watch_metrics WHERE post_id = ?").run(x.id); removed++; } }
      }
      return { checked: ids.length, removed };
    }
  };

  // ---------------------------------------------------------------- Bluesky
  async function bskySession(force) {
    if (tok.bsky && !force && tok.bsky.exp > Date.now()) return tok.bsky.v;
    const r = await withRetry(() => request(`${P.blueskyPds.replace(/\/$/, "")}/xrpc/com.atproto.server.createSession`, { method: "POST", body: { identifier: P.blueskyHandle, password: P.blueskyAppPassword } }));
    tok.bsky = { v: r.json.accessJwt, exp: Date.now() + 60 * 60e3 }; return tok.bsky.v;
  }
  const bsky = {
    label: "Bluesky search (scheduled)", platform: "Bluesky", interval: [15, 5, 1440],
    ready: () => P.blueskyHandle && P.blueskyAppPassword ? { state: "ready" } : { state: "not_configured", needs: "BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (create an app password in Bluesky settings; never use the account's main password)" },
    limits: "Searches each term separately through your own Bluesky server (one request per term per run). Bluesky's search ranks and indexes posts in its own way; the newest posts can be missing for a short time.",
    async search(def, { from }) {
      const rows = [], out = { requests: 0, pages: 0, stopped: null }, base = P.blueskyPds.replace(/\/$/, "");
      for (const t of termQueries(def)) {
        const u = new URL(`${base}/xrpc/app.bsky.feed.searchPosts`); for (const [k, v] of Object.entries({ q: t.q, sort: "latest", limit: "100", since: from })) u.searchParams.set(k, v);
        const get = async force => request(u, { headers: { Authorization: `Bearer ${await bskySession(force)}`, "atproto-proxy": "did:web:api.bsky.app#bsky_appview" } });
        let r; try { r = await withRetry(() => get(false)); } catch (e) { if (e.status === 400 || e.status === 401) r = await withRetry(() => get(true)); else throw e; }
        usage.add("bluesky_api", "searchPosts", 1, "request", "ok"); out.requests++; out.pages++;
        for (const p of r.json.posts || []) {
          const rkey = String(p.uri || "").split("/").pop(), h = p.author?.handle;
          rows.push({ platform: "Bluesky", post_id: p.uri, account: h ? `@${h}` : p.author?.did || null, author_name: p.author?.displayName || null, text: String(p.record?.text || "").slice(0, 10000),
            url: h && rkey ? `https://bsky.app/profile/${h}/post/${rkey}` : null, posted_at: p.record?.createdAt || p.indexedAt || null, language: p.record?.langs?.[0] || null,
            likes: n(p.likeCount), comments: n(p.replyCount), shares: p.repostCount == null ? null : p.repostCount + (p.quoteCount || 0), views: null, repost_of: null, collected_via: `Bluesky app.bsky.feed.searchPosts “${t.q}”` });
        }
      }
      return { rows, ...out };
    }
  };

  // ---------------------------------------------------------------- Mastodon (public hashtag timelines)
  const instances = () => String(P.mastodonInstances || "").split(/[\s,]+/).map(x => x.replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean).slice(0, 10);
  const mastodon = {
    label: "Mastodon hashtag timelines (scheduled)", platform: "Mastodon", interval: [15, 5, 1440],
    ready: () => instances().length ? { state: "ready" } : { state: "not_configured", needs: "MASTODON_INSTANCES (for example mastodon.social); no key needed" },
    limits: "Follows public hashtags only (Mastodon does not offer public full-text search). Hashtags come from the terms: #KDF, KDF, and phrases joined up such as #KenyaDefenceForces. Only what the named servers know about is seen.",
    async search(def, { cursor, from }) {
      const rows = [], out = { requests: 0, pages: 0, stopped: null }, cur = cursor ? JSON.parse(cursor) : {}, tags = termTags(def).slice(0, 15);
      for (const inst of instances()) for (const tag of tags) {
        const key = `${inst}#${tag.toLowerCase()}`, u = new URL(`${(config.collect?.bases?.mastodon || "https://" + inst).replace(/\/$/, "")}/api/v1/timelines/tag/${encodeURIComponent(tag)}`); u.searchParams.set("limit", "40"); if (cur[key]) u.searchParams.set("min_id", cur[key]);
        let r; try { r = await withRetry(() => request(u)); } catch (e) { if (e.kind === "auth") { out.stopped = `${inst} requires sign-in for hashtag timelines; skipped`; continue; } throw e; }
        usage.add("mastodon_api", `${inst} tag timeline`, 1, "request", "ok"); out.requests++; out.pages++;
        const list = Array.isArray(r.json) ? r.json : [];
        for (const s0 of list) {
          const s = s0.reblog || s0; if (s0.reblog) continue;   // boosts are reposts
          if (!cur[key] || BigInt(s0.id) > BigInt(cur[key])) cur[key] = s0.id;
          if (s.visibility && s.visibility !== "public") continue;
          if (from && s.created_at && s.created_at < from) continue;
          rows.push({ platform: "Mastodon", post_id: s.uri || s.url || `${inst}:${s.id}`, account: s.account?.acct ? `@${s.account.acct.includes("@") ? s.account.acct : `${s.account.acct}@${inst}`}` : null, author_name: s.account?.display_name || null,
            text: [s.spoiler_text, strip(s.content)].filter(Boolean).join(" — ").slice(0, 10000), url: s.url || s.uri || null, posted_at: s.created_at || null, language: s.language || null,
            likes: n(s.favourites_count), comments: n(s.replies_count), shares: n(s.reblogs_count), views: null, collected_via: `Mastodon ${inst} hashtag timeline #${tag}` });
        }
      }
      return { rows, ...out, cursor: JSON.stringify(cur) };
    }
  };

  // ---------------------------------------------------------------- Threads
  const threads = {
    label: "Threads keyword search (scheduled)", platform: "Threads", interval: [30, 15, 1440],
    ready: () => P.threadsToken ? { state: "ready" } : { state: "not_configured", needs: "THREADS_ACCESS_TOKEN from a Meta app approved for threads_basic and threads_keyword_search (without that approval only the token owner's own posts are searched)" },
    limits: `One query per term per run; Threads allows 2,200 queries per user in a rolling 24 h (queries with no results do not count). AIVS stops at ${P.threadsDailyQueries}. Search does not return like or reply counts. Sensitive keywords return nothing.`,
    async search(def, { from }) {
      const rows = [], out = { requests: 0, pages: 0, stopped: null }, since = Math.floor(Date.parse(from) / 1000);
      for (const t of termQueries(def)) {
        if (countSince("threads_api", 864e5) >= P.threadsDailyQueries) { out.stopped = `daily Threads query limit (${P.threadsDailyQueries}) reached`; break; }
        const u = new URL(`${B.threads.replace(/\/$/, "")}/v1.0/keyword_search`);
        for (const [k, v] of Object.entries({ q: t.bare, search_type: "RECENT", search_mode: t.tag && !/\s/.test(t.bare) ? "TAG" : "KEYWORD", since: String(since), limit: "100", fields: "id,text,media_type,permalink,timestamp,username,is_quote_post,is_reply", access_token: P.threadsToken })) u.searchParams.set(k, v);
        const r = await withRetry(() => request(u)); out.requests++; out.pages++;
        const data = r.json.data || []; if (data.length) usage.add("threads_api", "keyword_search", 1, "query", "ok");
        for (const p of data) rows.push({ platform: "Threads", post_id: p.id, account: p.username ? `@${p.username}` : null, text: String(p.text || "").slice(0, 10000), url: p.permalink || null, posted_at: p.timestamp ? new Date(p.timestamp).toISOString() : null,
          language: null, likes: null, comments: null, shares: null, views: null, collected_via: `Threads keyword_search “${t.bare}”` });
      }
      return { rows, ...out };
    }
  };

  // ---------------------------------------------------------------- Instagram (hashtags)
  const instagram = {
    label: "Instagram hashtag search (scheduled)", platform: "Instagram", interval: [60, 30, 1440],
    ready: () => P.instagramToken && P.instagramUserId ? { state: "ready" } : { state: "not_configured", needs: "INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID (an Instagram professional account linked to a Facebook Page, in a Meta app approved for Instagram Public Content Access)" },
    limits: "Hashtags only, from the terms; at most 30 different hashtags in any 7 days (AIVS keeps count); only public photos and videos from the last 24 hours; usernames are not provided by Instagram. Keyword search of Instagram posts is not offered.",
    async search(def) {
      const rows = [], out = { requests: 0, pages: 0, stopped: null }, used = svc.get("instagram_hashtags") || {}, week = Date.now() - 7 * 864e5, base = `${B.graph.replace(/\/$/, "")}/${P.graphVersion}`;
      for (const k of Object.keys(used)) if (Date.parse(used[k].first) < week) delete used[k];
      for (const tag of termTags(def)) {
        const k = tag.toLowerCase();
        if (!used[k] && Object.keys(used).length >= 30) { out.stopped = `Instagram allows 30 different hashtags in 7 days; #${tag} and later ones were skipped`; continue; }
        // a looked-up hashtag counts toward Instagram's 30 in 7 days even when it has no ID, so the answer is remembered either way
        if (!used[k]) { const r = await withRetry(() => request(`${base}/ig_hashtag_search?${new URLSearchParams({ user_id: P.instagramUserId, q: tag, access_token: P.instagramToken })}`)); out.requests++; usage.add("instagram_api", "ig_hashtag_search", 1, "request", "ok");
          used[k] = { id: r.json.data?.[0]?.id || null, first: nowISO() }; svc.set("instagram_hashtags", used); }
        const id = used[k].id; if (!id) continue;
        const r = await withRetry(() => request(`${base}/${id}/recent_media?${new URLSearchParams({ user_id: P.instagramUserId, fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count", limit: "50", access_token: P.instagramToken })}`));
        out.requests++; out.pages++; usage.add("instagram_api", "recent_media", 1, "request", "ok");
        for (const m of r.json.data || []) rows.push({ platform: "Instagram", post_id: m.id, account: null, text: String(m.caption || "").slice(0, 10000), url: m.permalink || null, posted_at: m.timestamp ? new Date(m.timestamp).toISOString() : null,
          language: null, likes: n(m.like_count), comments: n(m.comments_count), shares: null, views: null, collected_via: `Instagram Graph API recent media for #${tag}` });
      }
      return { rows, ...out };
    }
  };

  // ---------------------------------------------------------------- Facebook (named public Pages and their public comments)
  // Meta's errors arrive as HTTP 400/403 with a code: 190 means the token is invalid or expired; 4, 17, 32 and 613 are rate limits
  async function metaGet(url) {
    try { return (await withRetry(() => request(url))).json; }
    catch (e) {
      if (/request limit|rate limit|\(#(4|17|32|613)\)/i.test(e.message)) throw new ApiFailure("rate", `Meta's rate limit was reached (${e.message.replace(P.facebookToken, "[token]").slice(0, 200)})`, { resetAt: new Date(Date.now() + 3600e3).toISOString() });
      if (/OAuth|access token|\(#(10|100|200)\)|permission/i.test(e.message)) throw new ApiFailure("auth", `Facebook refused access: ${e.message.replace(P.facebookToken, "[token]").slice(0, 300)}. Check the token and that the app has Page Public Content Access (or that the Page is your own).`);
      throw e;
    }
  }
  const fbPagesOf = def => (def.fb_pages?.length ? def.fb_pages : String(P.facebookPages || "").split(/[\s,]+/).filter(Boolean)).slice(0, 25);
  const facebook = {
    label: "Facebook public Pages and their comments (scheduled)", platform: "Facebook", interval: [30, 15, 1440],
    ready: () => P.facebookToken ? { state: "ready" } : { state: "not_configured", needs: "FACEBOOK_ACCESS_TOKEN from a business-verified Meta app approved for Page Public Content Access (for other organisations' Pages), or a Page access token for your own Pages; then name the Pages in the watchlist" },
    limits: "Reads the posts and public comments of the Facebook Pages you name (up to 25 per watchlist). It cannot search all of Facebook, groups or personal profiles. Commenters' names are not collected. The likes figure is Facebook's total reactions.",
    async search(def, { from }) {
      const rows = [], out = { requests: 0, pages: 0, stopped: null }, base = `${B.graph.replace(/\/$/, "")}/${P.graphVersion}`, since = Math.floor(Date.parse(from) / 1000), pagesList = fbPagesOf(def);
      if (!pagesList.length) { out.stopped = "no Facebook Pages are named in this watchlist (or FACEBOOK_PAGES)"; return { rows, ...out }; }
      const names = svc.get("facebook_page_names") || {};
      for (const pg of pagesList) {
        if (!names[pg]) { const j = await metaGet(`${base}/${encodeURIComponent(pg)}?${new URLSearchParams({ fields: "name", access_token: P.facebookToken })}`); out.requests++; names[pg] = j.name || pg; svc.set("facebook_page_names", names); }
        const j = await metaGet(`${base}/${encodeURIComponent(pg)}/feed?${new URLSearchParams({ fields: "id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)", since: String(since), limit: "100", access_token: P.facebookToken })}`);
        out.requests++; out.pages++; usage.add("facebook_api", "page feed", 1, "request", "ok");
        const posts = j.data || [];
        for (const p of posts) if (p.message) rows.push({ platform: "Facebook", post_id: p.id, account: names[pg], author_name: null, text: String(p.message).slice(0, 10000), url: p.permalink_url || `https://www.facebook.com/${p.id}`, posted_at: p.created_time ? new Date(p.created_time).toISOString() : null,
          language: null, likes: n(p.reactions?.summary?.total_count), comments: n(p.comments?.summary?.total_count), shares: n(p.shares?.count), views: null, collected_via: `Facebook Graph API feed of Page ${names[pg]}` });
        if (def.fb_comments === false) continue;
        // public comments on the Page's recent posts (newest posts first, a few per run)
        const recent = posts.filter(p => Date.parse(p.created_time) > Date.now() - 48 * 3600e3).slice(0, P.facebookCommentPosts);
        for (const p of recent) {
          let c; try { c = await metaGet(`${base}/${p.id}/comments?${new URLSearchParams({ fields: "id,message,created_time,permalink_url,like_count", order: "reverse_chronological", filter: "stream", limit: "100", access_token: P.facebookToken })}`); }
          catch (e) { if (e.kind === "auth" || e.kind === "rate") throw e; out.stopped = `comments on some posts could not be read (${String(e.message).replace(P.facebookToken, "[token]").slice(0, 120)})`; continue; }
          out.requests++; usage.add("facebook_api", "post comments", 1, "request", "ok");
          for (const k of c.data || []) if (k.message && Date.parse(k.created_time) >= Date.parse(from)) rows.push({ platform: "Facebook", post_id: k.id, account: null, author_name: `comment on a post by ${names[pg]}`, text: String(k.message).slice(0, 10000),
            url: k.permalink_url || p.permalink_url || null, posted_at: new Date(k.created_time).toISOString(), language: null, likes: n(k.like_count), comments: null, shares: null, views: null, collected_via: `Facebook Graph API comments on a post by Page ${names[pg]}` });
        }
      }
      return { rows, ...out };
    }
  };

  // ---------------------------------------------------------------- TikTok Research API (approved researchers only)
  async function tiktokToken() {
    if (tok.tiktok && tok.tiktok.exp > Date.now() + 60e3) return tok.tiktok.v;
    const r = await withRetry(() => request(`${B.tiktok.replace(/\/$/, "")}/v2/oauth/token/`, { method: "POST", form: { client_key: P.tiktokClientKey, client_secret: P.tiktokClientSecret, grant_type: "client_credentials" } }));
    if (!r.json.access_token) throw new ApiFailure("auth", `TikTok gave no access token${r.json.error ? ` (${r.json.error}: ${r.json.error_description || ""})` : ""}. Check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET and that Research API access was approved.`);
    tok.tiktok = { v: r.json.access_token, exp: Date.now() + (r.json.expires_in || 7200) * 1000 }; return tok.tiktok.v;
  }
  const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  const tiktok = {
    label: "TikTok Research API (scheduled)", platform: "TikTok", interval: [180, 60, 1440],
    ready: () => P.tiktokClientKey && P.tiktokClientSecret ? { state: "ready" } : { state: "not_configured", needs: "TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET with approved TikTok Research API access. TikTok grants it only to academic institutions in the U.S., EEA, UK, Canada and Switzerland and some EU non-profit research bodies; a government unit in Kenya is not eligible on its own" },
    limits: `Searches video descriptions and hashtags by day (TikTok's query works in whole UTC days, up to 30 days). TikTok allows 1,000 requests a day; AIVS stops at ${P.tiktokDailyRequests}. TikTok's terms for research data apply to everything collected.`,
    async search(def, { from }) {
      const rows = [], out = { requests: 0, pages: 0, stopped: null }, start = new Date(Math.max(Date.parse(from), Date.now() - 29 * 864e5));
      const conds = termQueries(def).map(t => ({ operation: "EQ", field_name: t.tag && !/\s/.test(t.bare) ? "hashtag_name" : "keyword", field_values: [t.bare] }));
      let cursor = 0, search_id = null, more = true;
      while (more && out.pages < pages) {
        if (countSince("tiktok_api", Date.now() - Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z")) >= P.tiktokDailyRequests) { out.stopped = `daily TikTok request limit (${P.tiktokDailyRequests}) reached`; break; }
        const t = await tiktokToken(), u = `${B.tiktok.replace(/\/$/, "")}/v2/research/video/query/?fields=id,video_description,create_time,username,region_code,like_count,comment_count,share_count,view_count,hashtag_names`;
        const r = await withRetry(() => request(u, { method: "POST", headers: { Authorization: `Bearer ${t}` }, bigIds: true, body: { query: { or: conds }, start_date: ymd(start), end_date: ymd(new Date()), max_count: 100, cursor, ...(search_id ? { search_id } : {}) } }));
        out.requests++; out.pages++; usage.add("tiktok_api", "research/video/query", 1, "request", "ok");
        if (r.json.error && r.json.error.code && r.json.error.code !== "ok") throw new ApiFailure(/access|permission|scope|token/i.test(r.json.error.code) ? "auth" : "http", `TikTok: ${r.json.error.code}${r.json.error.message ? `: ${r.json.error.message}` : ""}`);
        const d = r.json.data || {};
        for (const v of d.videos || []) { const at = v.create_time ? new Date(v.create_time * 1000).toISOString() : null; if (at && at < from) continue;
          rows.push({ platform: "TikTok", post_id: String(v.id), account: v.username ? `@${v.username}` : null, text: [v.video_description, ...(v.hashtag_names || []).map(h => `#${h}`).filter(h => !String(v.video_description || "").includes(h))].filter(Boolean).join(" ").slice(0, 10000),
            url: v.username ? `https://www.tiktok.com/@${v.username}/video/${v.id}` : null, posted_at: at, language: null, likes: n(v.like_count), comments: n(v.comment_count), shares: n(v.share_count), views: n(v.view_count), collected_via: "TikTok Research API video query" }); }
        more = !!d.has_more; cursor = d.cursor || 0; search_id = d.search_id || search_id;
      }
      if (more && !out.stopped) out.stopped = `stopped after ${pages} pages; more matching videos were available`;
      return { rows, ...out };
    }
  };

  // ---------------------------------------------------------------- Telegram (channels where our bot is a member)
  // getUpdates hands each update out once, so one fetch serves every watchlist: updates are kept in a short shared buffer
  // and each watchlist remembers the last update it has seen.
  const ownChannels = () => new Set(String(P.telegramOwnChannels || "").split(/[\s,]+/).filter(Boolean).map(String));
  async function telegramFetch() {
    if (tok.tgAt && Date.now() - tok.tgAt < 20e3) return;
    const st = svc.get("telegram_updates") || { offset: 0, buffer: [] };
    const u = `${B.telegram.replace(/\/$/, "")}/bot${P.telegramToken}/getUpdates?${new URLSearchParams({ offset: String(st.offset || 0), limit: "100", timeout: "0", allowed_updates: JSON.stringify(["channel_post", "edited_channel_post"]) })}`;
    let r; try { r = await withRetry(() => request(u)); } catch (e) { e.message = e.message.replace(P.telegramToken, "[token]"); if (e.status === 401 || e.status === 404) e.kind = "auth"; throw e; }
    usage.add("telegram_api", "getUpdates", 1, "request", "ok"); tok.tgAt = Date.now();
    const ups = r.json.result || [], own = ownChannels();
    for (const up of ups) {
      const m = up.channel_post || up.edited_channel_post; st.offset = Math.max(st.offset || 0, up.update_id + 1);
      if (!m || m.chat?.type !== "channel") continue;   // only channels; never groups or private chats
      if (!m.chat.username && !own.has(String(m.chat.id))) continue;   // a private channel only if it is listed as our own
      st.buffer.push({ update_id: up.update_id, chat: { id: m.chat.id, title: m.chat.title, username: m.chat.username || null }, message_id: m.message_id, date: m.date, text: m.text || m.caption || "", edited: !!up.edited_channel_post });
    }
    st.buffer = st.buffer.filter(x => x.date * 1000 > Date.now() - 3 * 864e5).slice(-2000);
    svc.set("telegram_updates", st);
  }
  const telegram = {
    label: "Telegram channels where our bot is a member (scheduled)", platform: "Telegram", interval: [10, 5, 1440],
    ready: () => P.telegramToken ? { state: "ready" } : { state: "not_configured", needs: "TELEGRAM_BOT_TOKEN from @BotFather, and the bot added to each channel to follow (by that channel's administrator)" },
    limits: "Receives posts only from channels where the bot has been added; it cannot search Telegram or read channels it is not in. Group chats and direct messages are ignored. Views and forwards are not provided to bots.",
    async search(def, { cursor }) {
      await telegramFetch();
      const st = svc.get("telegram_updates") || { buffer: [] }, last = Number(cursor || 0), rows = [];
      for (const x of st.buffer.filter(b => b.update_id > last && b.text))
        rows.push({ platform: "Telegram", post_id: `${x.chat.id}:${x.message_id}`, account: x.chat.username ? `@${x.chat.username}` : x.chat.title, author_name: x.chat.title || null, text: String(x.text).slice(0, 10000),
          url: x.chat.username ? `https://t.me/${x.chat.username}/${x.message_id}` : null, posted_at: new Date(x.date * 1000).toISOString(), language: null, likes: null, comments: null, shares: null, views: null,
          collected_via: `Telegram Bot API (bot is a member of ${x.chat.username ? "@" + x.chat.username : "our own channel " + x.chat.title})${x.edited ? ", edited post" : ""}` });
      const maxId = st.buffer.reduce((a, b) => Math.max(a, b.update_id), last);
      return { rows, requests: 1, pages: 1, stopped: null, cursor: String(maxId) };
    }
  };
  // ---------------------------------------------------------------- news search APIs (keyword discovery across news sites)
  const S = { gdelt: true, gdeltBase: "https://api.gdeltproject.org", braveKey: "", braveBase: "https://api.search.brave.com", ...(config.search || {}) };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // the other keyword groups (all must match) and the exclusions, in the search engines' own syntax
  const qt = t => { const b = t.replace(/^#/, "").trim(); return /\s/.test(b) ? `"${b}"` : b; };
  const extra = def => [...(def.require_groups || []).map(g => g.length > 1 ? `(${g.map(qt).join(" OR ")})` : qt(g[0])), ...def.exclude.filter(x => !/^\./.test(x)).slice(0, 10).map(x => `-${qt(x)}`)].join(" ");
  const gdeltTime = iso => new Date(iso).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const fromGdelt = s => { const m = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})/.exec(String(s || "")); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null; };
  // GDELT DOC 2.0: a free, keyless index of worldwide online news (headline, link, date, site, image). One request per 5 s.
  const gdelt = {
    label: "GDELT news search (worldwide online news index, scheduled)", platform: "News (GDELT)", interval: [30, 15, 1440],
    ready: () => S.gdelt ? { state: "ready" } : { state: "disabled", needs: "SEARCH_GDELT=true (on by default; no key)" },
    limits: "Free, no key. Indexes online news worldwide within about 15–60 minutes of publication. Returns the headline, link, date, site and main image, not the article text. At most one request every 5 seconds; up to 250 results per request.",
    async search(def, { from }) {
      const rows = [], out = { requests: 0, pages: 0, stopped: null };
      const qs = (() => { const parts = termQueries(def).filter(t => t.bare.length >= 3).map(t => t.q), o = []; let cur = []; for (const p of parts) { if ([...cur, p].join(" OR ").length > 220 && cur.length) { o.push(cur); cur = []; } cur.push(p); } if (cur.length) o.push(cur); return o.map(c => [c.length > 1 ? `(${c.join(" OR ")})` : c[0], extra(def)].filter(Boolean).join(" ")); })();
      if (!qs.length) { out.stopped = "no term of 3 or more characters to search for"; return { rows, ...out }; }
      for (const [i, q] of qs.slice(0, 4).entries()) {
        if (i) await sleep(W.gdeltPauseMs ?? 5500);
        const u = new URL(`${S.gdeltBase.replace(/\/$/, "")}/api/v2/doc/doc`);
        for (const [k, v] of Object.entries({ query: q, mode: "artlist", format: "json", maxrecords: "100", sort: "datedesc", startdatetime: gdeltTime(from || new Date(Date.now() - 864e5).toISOString()) })) u.searchParams.set(k, v);
        // GDELT allows one request every 5 seconds per address (shared by everyone on the same office connection): a refusal is retried twice after a pause
        let r; for (let t = 0; ; t++) { try { r = await withRetry(() => request(u)); break; } catch (e) { if (t >= 2 || !/limit requests|rate limit/i.test(e.message)) throw e; await sleep(W.gdeltPauseMs ?? 6000 * (t + 1)); } }
        out.requests++; out.pages++; usage.add("gdelt", "doc artlist", 1, "request", "ok");
        for (const a of r.json.articles || []) {
          if (!/^https?:\/\//.test(a.url || "")) continue;
          rows.push({ platform: "News (GDELT)", post_id: a.url, account: a.domain || null, text: String(a.title || "").trim(), url: a.url, posted_at: fromGdelt(a.seendate), language: a.language ? String(a.language).slice(0, 2).toLowerCase() : null,
            image_url: /^https?:\/\//.test(a.socialimage || "") ? a.socialimage : null, likes: null, comments: null, shares: null, views: null, collected_via: `GDELT DOC 2.0 news search ${q}` });
        }
      }
      if (qs.length > 4) out.stopped = `only the first 4 of ${qs.length} term groups are searched each run`;
      return { rows: rows.filter(r => r.text), ...out };
    }
  };
  // Brave Search API, news endpoint (the same key as the evidence search)
  const braveNews = {
    label: "Brave News Search API (scheduled)", platform: "News (Brave)", interval: [60, 30, 1440],
    ready: () => S.braveKey ? { state: "ready" } : { state: "not_configured", needs: "BRAVE_SEARCH_API_KEY (the same key as the evidence search)" },
    limits: "Paid per request on Brave's plans. Returns headline, summary, link, site, age and thumbnail of recent news articles. One request per term group each run.",
    async search(def) {
      const rows = [], out = { requests: 0, pages: 0, stopped: null };
      const parts = termQueries(def).map(t => t.q), groups = []; let cur = [];
      for (const p of parts) { if ([...cur, p].join(" OR ").length > 300 && cur.length) { groups.push(cur); cur = []; } cur.push(p); } if (cur.length) groups.push(cur);
      for (const g of groups.slice(0, 3)) {
        const u = new URL(`${S.braveBase.replace(/\/$/, "")}/res/v1/news/search`); u.searchParams.set("q", [g.length > 1 ? `(${g.join(" OR ")})` : g[0], extra(def)].filter(Boolean).join(" ")); u.searchParams.set("count", "50"); u.searchParams.set("freshness", "pd");
        const r = await withRetry(() => request(u, { headers: { "X-Subscription-Token": S.braveKey } })); out.requests++; out.pages++; usage.add("brave_api", "news search", 1, "request", "ok");
        for (const a of r.json.results || []) {
          if (!/^https?:\/\//.test(a.url || "")) continue;
          const when = a.page_age ? new Date(a.page_age) : null;
          rows.push({ platform: "News (Brave)", post_id: a.url, account: a.meta_url?.hostname || a.profile?.name || null, text: [strip(a.title), strip(a.description)].filter(Boolean).join(" — ").slice(0, 5000), url: a.url,
            posted_at: when && !isNaN(when) ? when.toISOString() : null, language: null, image_url: /^https?:\/\//.test(a.thumbnail?.src || "") ? a.thumbnail.src : null, likes: null, comments: null, shares: null, views: null, collected_via: `Brave News Search “${g.join(" OR ").slice(0, 120)}”` });
        }
      }
      if (groups.length > 3) out.stopped = `only the first 3 of ${groups.length} term groups are searched each run`;
      return { rows, ...out };
    }
  };
  return { reddit, bluesky: bsky, mastodon, threads, instagram, facebook, tiktok, telegram, gdelt, brave_news: braveNews };
}

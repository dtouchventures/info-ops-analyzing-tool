// Social media post extraction: reads one public post from its link, using only what each platform officially
// offers, and says plainly what it could not get. One adapter per platform; each tries its methods in order and
// records every attempt (method, outcome, reason):
//   X (Twitter)  publish.twitter.com oEmbed (no key) → X API v2 GET /2/tweets/:id if X_BEARER_TOKEN (paid per read)
//   YouTube      YouTube Data API videos.list if YOUTUBE_API_KEY (title, description, channel, date) → oEmbed (title only)
//   TikTok       tiktok.com oEmbed (caption) → TikTok Research API by video ID if approved credentials
//   Telegram     t.me/<channel>/<id>?embed=1 public preview (public channels only)
//   Facebook     share links (/share/…, fb.watch) resolved by following Facebook's own redirect (no page is read) →
//                Graph API with FACEBOOK_ACCESS_TOKEN (Pages the token may read) → Meta oEmbed with META_OEMBED_TOKEN
//   Instagram    Meta oEmbed with META_OEMBED_TOKEN
// Metadata (author, date, title) and the words of the post are reported separately: an embed may give the author
// but not the words, or only a shortened text. Nothing is scraped, nothing needs a personal login, rate limits are
// respected (a refused method is not retried until its reset time), and no text is ever invented. Tokens stay on
// the server and are removed from every message and stored answer.
import { parseSourceLink } from "../../shared/text.js";
import { nowISO } from "./db.js";
import { normText } from "./io.js";

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = s => String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? (() => { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; })() : ENT[e.toLowerCase()] ?? m);
const htmlText = h => decode(String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n").replace(/<[^>]+>/g, "")).split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
const handleOf = u => { try { const p = new URL(u).pathname.split("/").filter(Boolean)[0]; return p ? (p.startsWith("@") ? p : "@" + p) : null; } catch { return null; } };
const SOCIAL = ["X (Twitter)", "Facebook", "Instagram", "TikTok", "YouTube", "Telegram", "WhatsApp", "Threads", "LinkedIn", "Reddit"];
const TRACKING = /^(utm_\w+|fbclid|gclid|igshid|igsh|mibextid|rdid|share_url|s|t|si|ref|ref_src|ref_url|_r|is_from_webapp|sender_device|feature|pp|sfnsn|__cft__\[0\]|__tn__|_t)$/i;

// one canonical form of a link: https, no tracking parameters, mobile hosts mapped to the main site
export function normalizeLink(input) {
  let u; try { u = new URL(String(input || "").trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  u.protocol = "https:"; u.hash = "";
  const h = u.hostname.toLowerCase();
  if (/^(m|mobile|mbasic|web|touch|free|lm|l)\.facebook\.com$|^fb\.com$|^facebook\.com$/.test(h)) u.hostname = "www.facebook.com";
  else if (/^(mobile\.)?(twitter|x)\.com$/.test(h)) u.hostname = "x.com";
  else if (/^(m|music)\.youtube\.com$|^youtube\.com$/.test(h)) u.hostname = "www.youtube.com";
  else if (/^(m\.)?instagram\.com$/.test(h)) u.hostname = "www.instagram.com";
  else if (/^m\.tiktok\.com$|^tiktok\.com$/.test(h)) u.hostname = "www.tiktok.com";
  const keep = new Set(/youtube\.com$/.test(u.hostname) ? ["v", "t"] : /facebook\.com$/.test(u.hostname) ? ["story_fbid", "id", "fbid", "v", "set"] : []);
  for (const k of [...u.searchParams.keys()]) if (!keep.has(k) && (TRACKING.test(k) || /youtube\.com$|facebook\.com$|instagram\.com$|tiktok\.com$|x\.com$/.test(u.hostname))) u.searchParams.delete(k);
  return u.href;
}

// identifiers in a Facebook link, after any share redirect
export function facebookIds(link) {
  let u; try { u = new URL(link); } catch { return {}; }
  const p = u.pathname.split("/").filter(Boolean), q = k => u.searchParams.get(k), num = s => /^\d{5,}$/.test(s || "") ? s : null;
  if (/^(permalink|story)\.php$/.test(p[0] || "")) return { kind: "post", owner: num(q("id")), post: q("story_fbid"), pfbid: /^pfbid/.test(q("story_fbid") || "") };
  if (p[0] === "share") return { kind: "share" };
  if (p[0] === "watch" || p[0] === "reel" || p[0] === "videos") return { kind: "video", video: num(q("v")) || num(p[1]) };
  if (/^photo(\.php)?$/.test(p[0] || "")) return { kind: "photo", photo: num(q("fbid")) };
  if (p[0] === "groups") return { kind: "group", group: p[1] || null, post: num(p[3]) };
  if (p[0] === "profile.php") return { kind: "profile" };
  if (p[0] && p[1] === "posts" && p[2]) return { kind: "post", page: p[0], post: p[2], owner: num(p[0]), pfbid: /^pfbid/.test(p[2]) };
  if (p[0] && (p[1] === "videos" || p[1] === "reels")) return { kind: "video", page: p[0], video: num(p.at(-1)) };
  if (p[0] && p[1] === "photos") return { kind: "photo", page: p[0], photo: num(p.at(-1)) };
  if (p[0] && p.length === 1) return { kind: "page", page: p[0] };
  return { kind: "unknown" };
}
export const youtubeId = link => { try { const u = new URL(link), p = u.pathname.split("/").filter(Boolean); const id = u.hostname === "youtu.be" ? p[0] : u.searchParams.get("v") || (["shorts", "live", "embed", "v"].includes(p[0]) ? p[1] : null); return /^[\w-]{11}$/.test(id || "") ? id : null; } catch { return null; } };

// what each platform offers, for the start page, Verify and the Integrations tab (no secrets)
export function socialStatus(config) {
  const S = config.social || {}, C = config.collect || {}, P = config.platforms || {};
  return [
    { key: "x", label: "X (Twitter)", platforms: ["X (Twitter)"], configured: true, gives: C.xBearer ? "post text, account and date from the public embed; the X API (X_BEARER_TOKEN, paid per post read) is used when the embed fails" : "post text, account and date from the public embed",
      optional: C.xBearer ? null : "X_BEARER_TOKEN: reads posts the public embed cannot show (paid per post read)" },
    { key: "youtube", label: "YouTube", platforms: ["YouTube"], configured: true, gives: C.youtubeKey ? "title, description, channel, date, length and views (YouTube Data API)" : "title and channel only (public embed)",
      optional: C.youtubeKey ? null : "YOUTUBE_API_KEY: adds the description, upload date, length and views", transcript: "not available from YouTube's API for other people's videos; add a permitted copy of the video to the case to transcribe it" },
    { key: "tiktok", label: "TikTok", platforms: ["TikTok"], configured: true, gives: "caption and account (not what is said in the video)" },
    { key: "telegram", label: "Telegram", platforms: ["Telegram"], configured: true, gives: "post text and time (public channels only)" },
    { key: "meta", label: "Facebook and Instagram", platforms: ["Facebook", "Instagram"], configured: !!(S.metaToken || P.facebookToken),
      gives: [P.facebookToken && "Facebook posts and videos of Pages your token may read (Graph API)", S.metaToken && "author and, where Meta includes it, a possibly shortened text (Meta oEmbed)"].filter(Boolean).join("; ") || "nothing until a Meta token is set",
      needs: S.metaToken && P.facebookToken ? null : "META_OEMBED_TOKEN (APPID|CLIENTTOKEN of a Meta app with the oEmbed Read feature) and/or FACEBOOK_ACCESS_TOKEN (a Page access token for your own Pages, or an app approved for Page Public Content Access)" }
  ];
}

export function makeSocial(db, { config }) {
  const S = { timeoutMs: 10000, metaToken: "", ...(config.social || {}) }, C = config.collect || {}, P = { graphVersion: "v26.0", ...(config.platforms || {}) };
  const B = { x: "https://publish.twitter.com", xapi: "https://api.x.com", youtube: "https://www.youtube.com", ytapi: "https://www.googleapis.com", tiktok: "https://www.tiktok.com", tiktokapi: "https://open.tiktokapis.com",
    telegram: "https://t.me", meta: "https://graph.facebook.com", graph: "https://graph.facebook.com", ...(S.bases || {}) };
  const secrets = () => [S.metaToken, C.xBearer, C.youtubeKey, P.facebookToken, P.tiktokClientSecret].filter(s => s && s.length > 6);
  const redact = s => { let t = String(s ?? ""); for (const k of secrets()) t = t.split(k).join("[token]"); return t.replace(/access_token=[^&\s"]+/g, "access_token=[token]"); };
  const usage = (service, ok, op = "post lookup", cost = 0) => { try { db.prepare("INSERT INTO api_usage(at,service,operation,units,unit,est_cost_usd,status) VALUES (?,?,?,?,?,?,?)").run(nowISO(), service, op, 1, "request", cost, ok ? "ok" : "error"); } catch {} };
  const cooldown = new Map();   // method → time (ms) before which it is not called again, after a rate limit
  const log = (platform, method, msg) => { if (!config.isTest) console.warn(`[extract] ${platform} ${method}: ${redact(msg).slice(0, 300)}`); };

  async function get(url, { accept = "application/json", headers = {}, method = "GET", body, redirect = "follow" } = {}) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), S.timeoutMs);
    try {
      const r = await fetch(url, { method, headers: { Accept: accept, "User-Agent": "AIVS-verification (public post lookup)", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal, redirect });
      if (redirect === "manual") { r.body?.cancel().catch(() => {}); return { status: r.status, location: r.headers.get("location"), headers: r.headers, body: "" }; }
      const text = await r.text();
      if (text.length > 2_000_000) throw new Error("the answer was too large");
      return { status: r.status, body: text, headers: r.headers };
    } catch (e) { if (e.name === "AbortError") throw new Error(`no answer within ${Math.round(S.timeoutMs / 1000)} s`); throw new Error(e.cause?.code || e.message); }
    finally { clearTimeout(t); }
  }
  // one retry for network failures and server errors; rate limits and refusals are not retried
  async function getRetry(url, opts) {
    try { const r = await get(url, opts); if (r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { r }); return r; }
    catch (e) { await new Promise(ok => setTimeout(ok, config.isTest ? 50 : 1500)); try { return await get(url, opts); } catch (e2) { if (e.r) return e.r; throw e2; } }
  }
  const json = r => { try { return JSON.parse(r.body); } catch { return null; } };
  const notFound = st => st === 404 || st === 403 || st === 400 || st === 401
    ? "The platform's public embed returned no post. It may have been deleted, made private or age-restricted, or the link may be incomplete."
    : st === 429 ? "The platform's rate limit was reached. Try again in a few minutes." : `The platform answered with HTTP ${st}.`;

  async function oembed(service, endpoint) {
    const r = await getRetry(endpoint);
    if (r.status !== 200) { usage(service, false); return { ok: false, http: r.status, message: notFound(r.status) }; }
    const j = json(r); if (!j) { usage(service, false); return { ok: false, message: "The platform did not return the expected data." }; }
    usage(service, true); return { ok: true, json: j, raw: r.body };
  }

  // follow a platform's own share redirect (Facebook /share/…, fb.watch, vm.tiktok.com) to the post's address.
  // Only the redirect header is read: the page itself is not downloaded. Every hop must stay on the platform.
  async function resolveShare(link, hostRe, attempts) {
    let url = link;
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(url), base = S.bases?.resolve?.[u.hostname], target = base ? `${base}${u.pathname}${u.search}` : url;
      let r; try { r = await get(target, { accept: "text/html", redirect: "manual" }); } catch (e) { attempts.push({ method: "share link redirect", result: "error", detail: `could not be followed (${e.message})` }); return null; }
      if (r.status < 300 || r.status >= 400 || !r.location) { if (hop) return url; attempts.push({ method: "share link redirect", result: "failed", detail: `the platform answered HTTP ${r.status} without sending the post's address` }); return null; }
      const next = new URL(r.location, url);
      if (!hostRe.test(next.hostname)) { attempts.push({ method: "share link redirect", result: "failed", detail: `the link leads off the platform (${next.hostname}); not followed` }); return null; }
      if (/^\/(login|checkpoint|recover|cookie|consent)/i.test(next.pathname) || /\/login\b/.test(next.pathname)) { attempts.push({ method: "share link redirect", result: "blocked", detail: "the platform asks for a sign-in before it reveals where this share link leads. AIVS does not sign in to platforms." }); return null; }
      url = next.href;
      if (!/^(fb\.watch|v[mt]\.tiktok\.com)$/.test(next.hostname) && !/^\/share\//.test(next.pathname)) { attempts.push({ method: "share link redirect", result: "ok", detail: `leads to ${normalizeLink(url) || url}` }); return normalizeLink(url) || url; }
    }
    attempts.push({ method: "share link redirect", result: "failed", detail: "too many redirects" }); return null;
  }

  // ---------------------------------------------------------------- adapters
  async function xAdapter(out, L, A) {
    out.service = "x";
    if (!L.post_id) return { status: "not_a_post", message: "This link is to an account or a search, not to a single post. Open the post itself and copy its link (it contains /status/ and a number)." };
    const r = await oembed("x_embed", `${B.x}/oembed?${new URLSearchParams({ url: `https://twitter.com/${(L.account || "@i").slice(1)}/status/${L.post_id}`, omit_script: "true", dnt: "true", lang: "en" })}`);
    if (r.ok) {
      const html = String(r.json.html || ""), p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html), dateA = [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>\s*<\/blockquote>/gi)].pop();
      Object.assign(out, { raw: r.raw, author_name: r.json.author_name || null, account: handleOf(r.json.author_url) || out.account, text: p ? htmlText(p[1]) : null, text_source: "X public embed (oEmbed)", text_status: p ? "full" : "none" });
      if (!out.posted_at && dateA && !isNaN(new Date(dateA[1]))) Object.assign(out, { posted_at: new Date(`${dateA[1]} 12:00 UTC`).toISOString(), posted_basis: `date shown in X's public embed: “${dateA[1]}” (day only)` });
      A.push({ method: "X public embed", result: p ? "ok" : "no text" }); if (p) return;
    } else A.push({ method: "X public embed", result: "failed", detail: r.message });
    if (!C.xBearer) { out.needs.push({ setting: "X_BEARER_TOKEN", why: "lets AIVS read the post through the X API when the public embed cannot (paid per post read)" }); return r.ok ? null : { status: "unavailable", message: r.message }; }
    if ((cooldown.get("x_api") || 0) > Date.now()) { A.push({ method: "X API", result: "skipped", detail: `rate limit until ${new Date(cooldown.get("x_api")).toISOString()}` }); return { status: "unavailable", message: "X's rate limit was reached. Try again later, paste the words or add a screenshot." }; }
    const x = await getRetry(`${B.xapi}/2/tweets/${L.post_id}?${new URLSearchParams({ "tweet.fields": "created_at,lang,public_metrics,note_tweet,author_id", expansions: "author_id", "user.fields": "username,name" })}`, { headers: { Authorization: `Bearer ${C.xBearer}` } });
    const j = json(x) || {};
    if (x.status === 429) { const reset = Number(x.headers.get("x-rate-limit-reset")) * 1000 || Date.now() + 15 * 60e3; cooldown.set("x_api", reset); usage("x_api", false, "post lookup"); A.push({ method: "X API", result: "rate limited", detail: `until ${new Date(reset).toISOString()}` }); return { status: "unavailable", message: "X's rate limit was reached. Try again later." }; }
    if (x.status === 401 || x.status === 403 || x.status === 402) { usage("x_api", false); log("X", "API", `HTTP ${x.status} ${x.body.slice(0, 200)}`); A.push({ method: "X API", result: "refused", detail: `HTTP ${x.status}: check X_BEARER_TOKEN and that the account has credit for post reads` }); return { status: "unavailable", message: "The X API refused the request. The administrator should check X_BEARER_TOKEN and the account's credit." }; }
    if (!j.data) { usage("x_api", false); const why = j.errors?.[0]?.title || j.errors?.[0]?.detail || `HTTP ${x.status}`; A.push({ method: "X API", result: "failed", detail: why }); return { status: "unavailable", message: /authoriz|protected/i.test(why) ? "This post is from a protected account. AIVS reads only public posts." : "X has no public post with this ID. It may have been deleted." }; }
    usage("x_api", true, "post lookup", Number(config.watch?.usdPerXPost ?? 0.005) || 0);
    const u = (j.includes?.users || []).find(v => v.id === j.data.author_id) || {};
    Object.assign(out, { raw: x.body, text: j.data.note_tweet?.text || j.data.text, text_source: "X API v2 (post lookup)", text_status: "full", author_name: u.name || out.author_name, account: u.username ? "@" + u.username : out.account, language: j.data.lang || null,
      metrics: j.data.public_metrics ? { likes: j.data.public_metrics.like_count, reposts: j.data.public_metrics.retweet_count, replies: j.data.public_metrics.reply_count, views: j.data.public_metrics.impression_count } : null });
    if (j.data.created_at) Object.assign(out, { posted_at: new Date(j.data.created_at).toISOString(), posted_basis: "time stated by the X API" });
    A.push({ method: "X API", result: "ok" });
  }

  async function youtubeAdapter(out, L, A) {
    out.service = "youtube"; const id = youtubeId(L.url); out.post_id = id;
    out.transcript = { available: false, note: "YouTube's API gives caption files only to the video's owner, so AIVS cannot fetch a transcript. To check what is said, add a copy of the video that you are permitted to use to the case: the AIVS transcription service transcribes it." };
    if (!id) return { status: "not_a_post", message: "This link is to a channel or a list, not to one video. Open the video and copy its link." };
    if (C.youtubeKey && (cooldown.get("youtube_api") || 0) < Date.now()) {
      const r = await getRetry(`${B.ytapi}/youtube/v3/videos?${new URLSearchParams({ part: "snippet,contentDetails,statistics", id, key: C.youtubeKey })}`), j = json(r) || {};
      if (r.status === 200 && j.items) {
        usage("youtube_api", true, "videos.list");
        const v = j.items[0];
        if (!v) { A.push({ method: "YouTube Data API", result: "not found" }); return { status: "unavailable", message: "YouTube has no public video with this ID. It may be private, removed or age-restricted." }; }
        const sn = v.snippet || {};
        Object.assign(out, { raw: redact(r.body), text: [sn.title, sn.description].filter(Boolean).join("\n\n"), text_source: "YouTube Data API (title and description; the spoken content is not included)", text_status: "full", author_name: sn.channelTitle || null,
          title: sn.title || null, language: sn.defaultAudioLanguage || sn.defaultLanguage || null, duration: v.contentDetails?.duration || null, tags: sn.tags?.slice(0, 20) || [], metrics: v.statistics ? { views: +v.statistics.viewCount || null, likes: +v.statistics.likeCount || null, comments: +v.statistics.commentCount || null } : null });
        if (sn.publishedAt) Object.assign(out, { posted_at: new Date(sn.publishedAt).toISOString(), posted_basis: "upload time stated by the YouTube Data API" });
        A.push({ method: "YouTube Data API", result: "ok" }); return;
      }
      usage("youtube_api", false, "videos.list");
      const why = j.error?.errors?.[0]?.reason || j.error?.message || `HTTP ${r.status}`;
      if (/quota|rateLimit/i.test(why) || r.status === 429) cooldown.set("youtube_api", Date.now() + 3600e3);
      log("YouTube", "Data API", why); A.push({ method: "YouTube Data API", result: "failed", detail: redact(why) });
    } else if (!C.youtubeKey) out.needs.push({ setting: "YOUTUBE_API_KEY", why: "adds the video's description, upload date, length and views (free quota)" });
    const r = await oembed("youtube_embed", `${B.youtube}/oembed?${new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: "json" })}`);
    if (!r.ok) { A.push({ method: "YouTube public embed", result: "failed", detail: r.message }); return { status: "unavailable", message: r.message }; }
    A.push({ method: "YouTube public embed", result: "title only" });
    Object.assign(out, { raw: r.raw, author_name: r.json.author_name || null, account: handleOf(r.json.author_url) || out.account, text: r.json.title || null, title: r.json.title || null, text_source: "YouTube public embed (title only; the description and spoken content are not included)", text_status: r.json.title ? "title" : "none" });
  }

  async function tiktokAdapter(out, L, A) {
    out.service = "tiktok";
    if (/^v[mt]\.tiktok\.com$/.test(new URL(L.url).hostname)) {
      const to = await resolveShare(L.url, /(^|\.)tiktok\.com$/, A);
      if (to) { const L2 = parseSourceLink(to); Object.assign(L, { url: to, account: L2.account, post_id: L2.post_id }); Object.assign(out, { resolved_url: to, account: L2.account || out.account, post_id: L2.post_id, posted_at: out.posted_at || L2.published_at, posted_basis: out.posted_basis || L2.published_basis }); }
    }
    out.transcript = { available: false, note: "TikTok does not offer what is said in a video. Add a copy you are permitted to use to the case to transcribe it." };
    const r = await oembed("tiktok_embed", `${B.tiktok}/oembed?${new URLSearchParams({ url: L.url })}`);
    if (r.ok) { A.push({ method: "TikTok public embed", result: r.json.title ? "ok" : "no caption" }); Object.assign(out, { raw: r.raw, author_name: r.json.author_name || null, account: r.json.author_unique_id ? "@" + r.json.author_unique_id : out.account, text: r.json.title || null, text_source: "TikTok public embed (caption only; the spoken content is not included)", text_status: r.json.title ? "full" : "none" }); return; }
    A.push({ method: "TikTok public embed", result: "failed", detail: r.message });
    if (!(P.tiktokClientKey && P.tiktokClientSecret) || !out.post_id) return { status: "unavailable", message: r.message };
    try {
      const tr = await fetch(`${B.tiktokapi}/v2/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_key: P.tiktokClientKey, client_secret: P.tiktokClientSecret, grant_type: "client_credentials" }) }).then(x => x.json());
      if (!tr.access_token) throw new Error("TikTok gave no access token (Research API access may not be approved)");
      const q = await get(`${B.tiktokapi}/v2/research/video/query/?fields=id,video_description,create_time,username`, { method: "POST", headers: { Authorization: `Bearer ${tr.access_token}` }, body: { query: { and: [{ operation: "EQ", field_name: "video_id", field_values: [out.post_id] }] }, start_date: out.posted_at ? out.posted_at.slice(0, 10).replace(/-/g, "") : "20160101", end_date: new Date().toISOString().slice(0, 10).replace(/-/g, ""), max_count: 1 } });
      const v = (json({ body: q.body.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"') })?.data?.videos || [])[0];
      usage("tiktok_api", !!v, "research/video/query");
      if (!v) { A.push({ method: "TikTok Research API", result: "not found" }); return { status: "unavailable", message: r.message }; }
      Object.assign(out, { text: v.video_description || null, text_status: v.video_description ? "full" : "none", text_source: "TikTok Research API (description)", account: v.username ? "@" + v.username : out.account, raw: q.body });
      A.push({ method: "TikTok Research API", result: "ok" });
    } catch (e) { A.push({ method: "TikTok Research API", result: "failed", detail: redact(e.message) }); return { status: "unavailable", message: r.message }; }
  }

  async function telegramAdapter(out, L, A, parts) {
    out.service = "telegram";
    const ch = parts[0] === "s" ? parts[1] : parts[0], id = parts[0] === "s" ? parts[2] : parts[1];
    if (!ch || !/^\d+$/.test(id || "")) return { status: "not_a_post", message: "This link is to a channel, not to a single post. Open the post and use “Copy link” (it ends with a number)." };
    out.post_id = id; out.account = "@" + ch;
    const r = await getRetry(`${B.telegram}/${encodeURIComponent(ch)}/${id}?embed=1&mode=tme`, { accept: "text/html" });
    if (r.status !== 200) { usage("telegram_embed", false); A.push({ method: "Telegram public preview", result: "failed", detail: `HTTP ${r.status}` }); return { status: "unavailable", message: notFound(r.status) }; }
    const m = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(r.body), tm = /<time[^>]*datetime="([^"]+)"/i.exec(r.body), au = /<a class="tgme_widget_message_owner_name"[^>]*>(?:<span[^>]*>)?([\s\S]*?)<\/(?:span|a)>/i.exec(r.body);
    if (/tgme_widget_message_error|Post not found/i.test(r.body) || (!m && !tm)) { usage("telegram_embed", false); A.push({ method: "Telegram public preview", result: "not found" }); return { status: "unavailable", message: "Telegram's public preview has no such post. It may be deleted, or the channel may be private." }; }
    usage("telegram_embed", true); A.push({ method: "Telegram public preview", result: m ? "ok" : "no text" });
    Object.assign(out, { raw: r.body.slice(0, 200000), author_name: au ? htmlText(au[1]) : null, text: m ? htmlText(m[1]) : null, text_source: "Telegram public post preview", text_status: m ? "full" : "none" });
    if (tm && !isNaN(new Date(tm[1]))) Object.assign(out, { posted_at: new Date(tm[1]).toISOString(), posted_basis: "time stated in Telegram's public post preview" });
  }

  // Facebook Graph API: errors arrive with a code; 190 token invalid, 10/100/200 permission, 4/17/32/613 rate limits
  async function graph(path, fields) {
    if ((cooldown.get("facebook_api") || 0) > Date.now()) throw Object.assign(new Error(`Meta's rate limit was reached; try again after ${new Date(cooldown.get("facebook_api")).toISOString()}`), { kind: "rate" });
    const r = await getRetry(`${B.graph.replace(/\/$/, "")}/${P.graphVersion}/${path}?${new URLSearchParams({ fields, access_token: P.facebookToken })}`), j = json(r) || {};
    if (r.status === 200 && !j.error) { usage("facebook_api", true, "post lookup"); return { j, raw: r.body }; }
    usage("facebook_api", false, "post lookup");
    const code = j.error?.code, msg = redact(j.error?.message || `HTTP ${r.status}`);
    if ([4, 17, 32, 613].includes(code) || r.status === 429) { cooldown.set("facebook_api", Date.now() + 3600e3); throw Object.assign(new Error(`Meta's rate limit was reached (${msg})`), { kind: "rate" }); }
    if (code === 190) throw Object.assign(new Error(`the Facebook token is invalid or has expired (${msg})`), { kind: "auth" });
    if ([10, 200].includes(code) || (code === 100 && /permission|does not exist|cannot be loaded|missing/i.test(msg))) throw Object.assign(new Error(`Facebook does not let this token read that post (${msg}). A Page token reads only its own Page; other Pages need an app approved for Page Public Content Access.`), { kind: "refused" });
    throw Object.assign(new Error(msg), { kind: "http" });
  }
  async function facebookAdapter(out, L, A) {
    out.service = "meta"; let link = L.url;
    const host = new URL(link).hostname;
    if (host === "fb.watch" || /^\/share\//.test(new URL(link).pathname)) {
      const to = await resolveShare(link, /(^|\.)facebook\.com$|^fb\.watch$/, A);
      if (to) { link = to; out.resolved_url = to; const L2 = parseSourceLink(to); if (L2?.account) out.account = L2.account; }
    }
    const ids = facebookIds(link); out.content_type = ids.kind;
    if (ids.kind === "group") return { status: "restricted", message: "This is a Facebook group post. AIVS does not read groups: their posts are not public through Meta's APIs. Add a screenshot of the post if you are permitted to see it." };
    if (ids.kind === "profile") return { status: "restricted", message: "This is a personal Facebook profile. AIVS does not read personal profiles. Add a screenshot of the post if you are permitted to see it." };
    // 1. Graph API (full text of Page posts and videos the token may read)
    if (P.facebookToken && ids.kind !== "share" && ids.kind !== "unknown") {
      try {
        let gid = null, fields = "message,created_time,permalink_url,full_picture,from{name,username},story";
        if (ids.kind === "post" && ids.post && !ids.pfbid) gid = ids.owner ? `${ids.owner}_${ids.post}` : ids.page ? `${(await graph(encodeURIComponent(ids.page), "id")).j.id}_${ids.post}` : null;
        else if (ids.kind === "video" && ids.video) { gid = ids.video; fields = "description,title,created_time,permalink_url,from{name,username},length"; }
        else if (ids.kind === "photo" && ids.photo) { gid = ids.photo; fields = "name,created_time,link,from{name,username}"; }
        else if (ids.kind === "page") { gid = encodeURIComponent(ids.page); fields = "name,about,description,link,username"; }
        if (!gid) A.push({ method: "Facebook Graph API", result: "skipped", detail: ids.pfbid ? "this link uses Facebook's newer post code (pfbid…), which the Graph API does not accept" : "the link does not name the Page and post" });
        else {
          const { j, raw } = await graph(gid, fields), words = ids.kind === "page" ? [j.about, j.description].filter(Boolean).join("\n\n") : [j.title, j.message || j.description || j.name].filter(Boolean).join("\n\n");
          Object.assign(out, { raw, text: words || null, text_status: words ? "full" : "none", text_source: ids.kind === "page" ? "Facebook Graph API (Page details)" : "Facebook Graph API", author_name: j.from?.name || (ids.kind === "page" ? j.name : null) || out.author_name, account: j.from?.username || j.username || out.account,
            title: ids.kind === "page" ? j.name : j.title || null, post_id: j.id || gid, permalink: j.permalink_url || j.link || null, ...(j.full_picture ? { thumbnail_url: j.full_picture } : {}) });
          if (j.created_time) Object.assign(out, { posted_at: new Date(j.created_time).toISOString(), posted_basis: "time stated by the Facebook Graph API" });
          A.push({ method: "Facebook Graph API", result: words ? "ok" : "no text" }); if (words) return;
        }
      } catch (e) { log("Facebook", "Graph API", e.message); A.push({ method: "Facebook Graph API", result: e.kind === "rate" ? "rate limited" : e.kind === "refused" || e.kind === "auth" ? "refused" : "failed", detail: redact(e.message) }); }
    } else if (!P.facebookToken) out.needs.push({ setting: "FACEBOOK_ACCESS_TOKEN", why: "reads the full text of posts and videos on Pages the token may read: your own Pages with a Page access token, or other public Pages once Meta approves your app for Page Public Content Access" });
    // 2. Meta oEmbed (author; a text that may be shortened or left out)
    if (S.metaToken && ids.kind !== "page") {
      const ep = ids.kind === "video" ? "oembed_video" : "oembed_post";
      const r = await oembed("meta_embed", `${B.meta}/v21.0/${ep}?${new URLSearchParams({ url: link, access_token: S.metaToken, omitscript: "true" })}`);
      if (r.ok) {
        const bq = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i.exec(String(r.json.html || "")), p = bq && /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(bq[1]);
        if (!out.text && p) Object.assign(out, { text: htmlText(p[1]), text_status: "partial", text_source: "Facebook public embed (Meta oEmbed; the text may be shortened)" });
        Object.assign(out, { raw: out.raw || redact(r.raw), author_name: out.author_name || r.json.author_name || null });
        A.push({ method: "Meta oEmbed", result: p ? "ok (text may be shortened)" : "author only, no text" }); if (out.text) return;
      } else A.push({ method: "Meta oEmbed", result: "failed", detail: ids.kind === "share" ? `${r.message} Share links are often not accepted: open the post and copy the address from the browser bar.` : r.message });
    } else if (!S.metaToken) out.needs.push({ setting: "META_OEMBED_TOKEN", why: "the app ID and client token (APPID|CLIENTTOKEN) of a Meta app with the oEmbed Read feature: gives the author and sometimes a shortened text of public posts" });
    if (out.text) return;
    if (!S.metaToken && !P.facebookToken) return { status: "not_configured", message: "Facebook shares the words of a post only with registered apps, and no Meta token is set on this server (META_OEMBED_TOKEN or FACEBOOK_ACCESS_TOKEN)." };
    return { status: out.author_name ? "no_text" : "unavailable", message: ids.kind === "share" && !out.resolved_url ? "Facebook did not reveal where this share link leads. Open it, copy the post's address from the browser bar and paste that instead." : "Facebook did not give AIVS the words of this post." };
  }
  async function instagramAdapter(out, L, A) {
    out.service = "meta";
    if (!S.metaToken) { out.needs.push({ setting: "META_OEMBED_TOKEN", why: "Instagram shares a post's author and caption only with registered Meta apps that have the oEmbed Read feature" }); return { status: "not_configured", message: "Instagram shares a post only with registered apps, and no Meta app token (META_OEMBED_TOKEN) is set on this server." }; }
    const r = await oembed("meta_embed", `${B.meta}/v21.0/instagram_oembed?${new URLSearchParams({ url: L.url, access_token: S.metaToken, omitscript: "true" })}`);
    if (!r.ok) { A.push({ method: "Meta oEmbed (Instagram)", result: "failed", detail: r.message }); return { status: "unavailable", message: r.message }; }
    const bq = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i.exec(String(r.json.html || "")), p = bq && /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(bq[1]);
    const words = r.json.title || (p ? htmlText(p[1]) : null);
    A.push({ method: "Meta oEmbed (Instagram)", result: words ? "ok (caption may be shortened)" : "author only, no caption" });
    Object.assign(out, { raw: redact(r.raw), author_name: r.json.author_name || null, account: r.json.author_name ? "@" + r.json.author_name : out.account, text: words, text_status: words ? "partial" : "none", text_source: "Instagram public embed (Meta oEmbed; the caption may be shortened)" });
  }

  // look up one link; returns what was found with its source, every attempt, and a clear reason when nothing was retrieved
  async function lookup(url) {
    const norm = normalizeLink(url), L = norm ? parseSourceLink(norm) : null;
    if (!L) return { social: false, message: "That is not a valid web address." };
    if (/\(website\)$/.test(L.platform) || !SOCIAL.includes(L.platform)) return { social: false, platform: L.platform, url: norm };
    const out = { social: true, url: url.trim(), normalized_url: norm, resolved_url: null, platform: L.platform, content_type: null, account: L.account, post_id: L.post_id, posted_at: L.published_at, posted_basis: L.published_basis,
      text: null, text_status: "none", text_source: null, author_name: null, title: null, language: null, metrics: null, service: null, status: "unsupported", message: null, raw: null, attempts: [], needs: [], transcript: null, looked_up_at: nowISO() };
    const A = out.attempts, parts = new URL(L.url).pathname.split("/").filter(Boolean);
    let fail;
    try {
      if (L.platform === "X (Twitter)") fail = await xAdapter(out, L, A);
      else if (L.platform === "YouTube") fail = await youtubeAdapter(out, L, A);
      else if (L.platform === "TikTok") fail = await tiktokAdapter(out, L, A);
      else if (L.platform === "Telegram") fail = await telegramAdapter(out, L, A, parts);
      else if (L.platform === "Facebook") fail = await facebookAdapter(out, L, A);
      else if (L.platform === "Instagram") fail = await instagramAdapter(out, L, A);
      else fail = { status: "unsupported", message: `${L.platform} has no public way to read a post from its link. Paste the text and add a screenshot.` };
    } catch (e) {
      usage(`${out.service}_embed`, false); log(L.platform, "lookup", e.message);
      A.push({ method: "lookup", result: "error", detail: redact(e.message) });
      fail = { status: "error", message: `The ${L.platform} service could not be reached (${redact(e.message)}). Try again, paste the text, or add a screenshot.` };
    }
    if (out.raw) out.raw = redact(out.raw);
    if (out.text) { out.text = out.text.trim(); out.status = out.text_status === "full" ? "ok" : "partial"; out.message = out.text_status === "partial" ? "The platform may have shortened this text. Compare it with the post and complete it if needed." : out.text_status === "title" ? "Only the title is available. Add what is said or written in the post yourself if it matters." : null; }
    else if (fail) Object.assign(out, fail);
    else { out.status = "no_text"; out.message = `${L.platform} returned the post's details but no text. Paste the text yourself or add a screenshot.`; }
    return out;
  }

  // has this account or this message been seen in the post datasets imported into the IO monitor?
  function ioContext({ account, text, training = false }) {
    const scope = training ? "" : " AND d.is_sample = 0";   // synthetic practice datasets are compared only with training cases
    const acc = String(account || "").trim().toLowerCase().replace(/^@/, ""), out = { account: acc || null, account_posts: 0, account_datasets: [], similar: [], similar_accounts: 0 };
    const nDatasets = db.prepare(`SELECT COUNT(*) n FROM io_datasets d WHERE 1${scope}`).get().n; out.datasets_searched = nDatasets;
    if (!nDatasets) return out;
    if (acc) {
      const rows = db.prepare(`SELECT d.id, d.name, COUNT(*) n, MIN(p.posted_at) first, MAX(p.posted_at) last FROM io_posts p JOIN io_datasets d ON d.id = p.dataset_id WHERE lower(ltrim(p.account,'@')) = ?${scope} GROUP BY d.id ORDER BY n DESC LIMIT 10`).all(acc);
      out.account_datasets = rows; out.account_posts = rows.reduce((a, r) => a + r.n, 0);
    }
    const words = [...new Set(normText(text).split(" ").filter(w => w.length > 4 && !w.startsWith("#")))].sort((a, b) => b.length - a.length).slice(0, 4);
    if (words.length >= 2) {
      const wp = w => (s => new Set(s.map((x, i) => `${x} ${s[i + 1]}`).slice(0, -1)))(normText(w).split(" ").filter(Boolean));
      const A = wp(text), cand = db.prepare(`SELECT p.id, p.dataset_id, d.name dataset, p.account, p.posted_at, p.platform, p.text FROM io_posts p JOIN io_datasets d ON d.id = p.dataset_id WHERE (${words.map(() => "lower(p.text) LIKE ?").join(" OR ")})${scope} LIMIT 5000`).all(...words.map(w => `%${w}%`));
      for (const c of cand) { const Bs = wp(c.text); let n = 0; for (const x of A) if (Bs.has(x)) n++; const sim = A.size && Bs.size ? n / (A.size + Bs.size - n) : 0; if (sim >= 0.6) out.similar.push({ ...c, similarity: Math.round(sim * 100) / 100, text: c.text.slice(0, 280) }); }
      out.similar.sort((a, b) => String(a.posted_at).localeCompare(String(b.posted_at)));
      out.similar_accounts = new Set(out.similar.map(s => String(s.account).toLowerCase().replace(/^@/, ""))).size;
      out.similar = out.similar.slice(0, 20);
    }
    return out;
  }
  return { lookup, ioContext, status: () => socialStatus({ social: S, collect: C, platforms: P }) };
}

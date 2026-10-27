// Meta Graph API client for live monitoring (1.26). Server side only: the access token is read from the server's
// settings, sent to graph.facebook.com and nowhere else, and removed from every error message, log line and record.
//   validate()           GET /me?fields=id,name (with a Page token this is the Page) and, when META_APP_ID and
//                        META_APP_SECRET are set, GET /debug_token for validity, expiry and permissions
//   pagePosts(page, …)   GET /{page-id}/posts with paging; fields fall back to the basic tested set when the token's
//                        permissions do not cover engagement counts or attachments
//   postsByIds(ids)      GET /?ids=… for refreshing public engagement counts
//   igMedia(user, …)     GET /{ig-user-id}/media (Instagram professional account linked to the Page; prepared)
// Errors are classified with Meta's documented codes:
//   190 (subcodes 458, 459, 460, 463, 464, 467) token invalid or expired → "token"
//   4, 17, 32, 613, 80001–80014 rate limits → "rate" (with estimated_time_to_regain_access when Meta gives it)
//   10, 200–299 permission missing → "permission";   100 unknown field or object → "request";   1, 2 and HTTP 5xx → "temporary"
// The X-App-Usage and X-Business-Use-Case-Usage headers are read on every answer so collection slows down before
// Meta's limits are reached.
export const FULL_FIELDS = "id,message,created_time,updated_time,permalink_url,full_picture,status_type,attachments{media_type,url,media,subattachments.limit(4){media_type,media}},shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)";
export const BASIC_FIELDS = "id,message,created_time,permalink_url,full_picture";   // the field set tested by the user on 26 Oct 2026
export const ENGAGEMENT_FIELDS = "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)";
export const IG_FIELDS = "id,caption,timestamp,permalink,media_type,media_url,thumbnail_url,like_count,comments_count";

export class GraphError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}
const TOKEN_SUB = { 458: "the app was removed from the account", 459: "the user must log in to Facebook to fix their account", 460: "the password was changed, so the token was invalidated", 463: "the token has expired", 464: "the user account is not confirmed", 467: "the token is no longer valid" };
export function classify(code, subcode, httpStatus) {
  if (code === 190 || code === 102) return "token";
  if ([4, 17, 32, 341, 368, 613].includes(code) || (code >= 80001 && code <= 80014) || httpStatus === 429) return "rate";
  if (code === 10 || (code >= 200 && code <= 299)) return "permission";
  if (code === 100 || code === 803) return "request";
  if (code === 1 || code === 2 || httpStatus >= 500) return "temporary";
  return "request";
}
// the largest percentage in Meta's usage headers, and the wait Meta announces (minutes)
export function usageOf(headers) {
  const out = { app: null, business: null, max_pct: 0, regain_minutes: 0 };
  const parse = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const app = parse(headers.get?.("x-app-usage")), page = parse(headers.get?.("x-page-usage")), buc = parse(headers.get?.("x-business-use-case-usage"));
  for (const u of [app, page].filter(Boolean)) { out.app = out.app || u; out.max_pct = Math.max(out.max_pct, +u.call_count || 0, +u.total_time || 0, +u.total_cputime || 0); }
  if (buc) { out.business = buc; for (const list of Object.values(buc)) for (const u of [].concat(list || [])) { out.max_pct = Math.max(out.max_pct, +u.call_count || 0, +u.total_time || 0, +u.total_cputime || 0); out.regain_minutes = Math.max(out.regain_minutes, +u.estimated_time_to_regain_access || 0); } }
  return out;
}

export function makeGraph({ token, version = "v26.0", base = "https://graph.facebook.com", appId = "", appSecret = "", timeoutMs = 20000, userAgent = "AIVS-live-monitor", fetchImpl = fetch } = {}) {
  const secrets = () => [token, appSecret, appId && appSecret ? `${appId}|${appSecret}` : null].filter(s => s && s.length > 6);
  const redact = s => { let t = String(s ?? ""); for (const x of secrets()) t = t.split(x).join("[token]"); return t.replace(/access_token=[^&\s"]+/g, "access_token=[token]").replace(/(EAA[A-Za-z0-9]{20,})/g, "[token]"); };
  const root = `${String(base).replace(/\/$/, "")}/${version}`;
  let lastUsage = null;
  async function get(pathOrUrl, params = {}, { auth = token } = {}) {
    if (!auth) throw new GraphError("config", "No Meta access token is set on the server (META_PAGE_ACCESS_TOKEN).");
    const u = /^https?:\/\//.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(`${root}/${String(pathOrUrl).replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));
    if (!/^https?:\/\//.test(pathOrUrl) || !u.searchParams.has("access_token")) u.searchParams.set("access_token", auth);
    // paging links come from Meta and already carry the token; only Meta's own host is followed
    if (new URL(root).host !== u.host) throw new GraphError("request", `Refused to follow a link outside the Graph API (${u.host}).`);
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    let r, text;
    try { r = await fetchImpl(u, { headers: { Accept: "application/json", "User-Agent": userAgent }, signal: ac.signal }); text = await r.text(); }
    catch (e) { throw new GraphError("network", e.name === "AbortError" ? `Meta did not answer within ${Math.round(timeoutMs / 1000)} s` : `could not connect to the Graph API (${redact(e.cause?.code || e.message)})`); }
    finally { clearTimeout(t); }
    lastUsage = usageOf(r.headers);
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!r.ok || j?.error) {
      const e = j?.error || {}, code = +e.code || null, sub = +e.error_subcode || null, kind = classify(code, sub, r.status);
      const msg = redact(`${e.message || `HTTP ${r.status}`}${code ? ` (code ${code}${sub ? `, subcode ${sub}` : ""})` : ""}`);
      const why = kind === "token" ? `Meta refused the access token: ${TOKEN_SUB[sub] || "it is invalid or has expired"}. Generate a new Page access token and set META_PAGE_ACCESS_TOKEN on the server.`
        : kind === "rate" ? "Meta's rate limit was reached. AIVS waits before trying again." : kind === "permission" ? "The token does not have the permission this request needs." : null;
      throw new GraphError(kind, why ? `${why} [${msg}]` : msg, { code, subcode: sub, status: r.status, regain_minutes: lastUsage.regain_minutes || null, usage: lastUsage });
    }
    if (j == null) throw new GraphError("temporary", "The Graph API did not return JSON.");
    return j;
  }
  // a few quick retries for temporary failures inside one synchronisation; rate limits and refusals are not retried
  async function getRetry(p, params, attempts = 3) {
    for (let i = 0; ; i++) {
      try { return await get(p, params); }
      catch (e) { if (i + 1 >= attempts || !["network", "temporary"].includes(e.kind)) throw e; await new Promise(r => setTimeout(r, 800 * 2 ** i)); }
    }
  }

  async function validate() {
    const me = await get("me", { fields: "id,name" });
    const out = { valid: true, subject_id: me.id, subject_name: me.name || null, checked_at: new Date().toISOString(), expires_at: null, data_access_expires_at: null, scopes: null, type: null, debug: false };
    if (appId && appSecret) {
      try {
        const d = (await get("debug_token", { input_token: token }, { auth: `${appId}|${appSecret}` })).data || {};
        Object.assign(out, { debug: true, valid: d.is_valid !== false, type: d.type || null, scopes: d.scopes || null,
          expires_at: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : d.expires_at === 0 ? "never" : null,
          data_access_expires_at: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString() : null, debug_error: d.error?.message ? redact(d.error.message) : null });
      } catch (e) { out.debug_error = redact(e.message); }
    }
    return out;
  }
  // the newest posts of a Page; stops at `since` (ISO time) or after maxPages; falls back to the basic fields once
  async function pagePosts(pageId, { since = null, limit = 25, maxPages = 5, maxPosts = 1000, fields = FULL_FIELDS } = {}) {
    const out = { posts: [], requests: 0, pages: 0, fields_level: fields === BASIC_FIELDS ? "basic" : "full", more: false, field_note: null };
    let next = null;
    const params = { fields, limit: Math.min(100, Math.max(1, limit)) };
    if (since) params.since = Math.floor(Date.parse(since) / 1000);
    while (out.pages < maxPages) {
      let j;
      try { j = next ? await getRetry(next, {}) : await getRetry(`${encodeURIComponent(pageId)}/posts`, params); }
      catch (e) {
        if (!next && fields !== BASIC_FIELDS && (e.kind === "permission" || (e.kind === "request" && e.code === 100))) {
          const r = await pagePosts(pageId, { since, limit, maxPages, maxPosts, fields: BASIC_FIELDS });
          return { ...r, requests: r.requests + out.requests + 1, field_note: `Engagement counts and attachments are not available with this token's permissions (${e.message.slice(0, 160)}); only the basic fields were read.` };
        }
        e.partial = out; throw e;
      }
      out.requests++; out.pages++;
      const data = Array.isArray(j.data) ? j.data : [];
      out.posts.push(...data);
      next = j.paging?.next || null;
      if (!next || !data.length) break;
      if (out.posts.length >= maxPosts) { out.posts = out.posts.slice(0, maxPosts); break; }
      if (since && data.some(p => p.created_time && Date.parse(p.created_time) < Date.parse(since))) break;
    }
    out.more = !!since && !!next && out.pages >= maxPages; out.older_not_read = !since && !!next;
    return out;
  }
  async function postsByIds(ids, fields = ENGAGEMENT_FIELDS) { return ids.length ? getRetry("", { ids: ids.join(","), fields }) : {}; }
  async function igMedia(igUserId, { limit = 25 } = {}) { return getRetry(`${encodeURIComponent(igUserId)}/media`, { fields: IG_FIELDS, limit }); }
  return { get, validate, pagePosts, postsByIds, igMedia, redact, usage: () => lastUsage, configured: () => !!token };
}

// a Graph post → the fields AIVS keeps (nothing is invented: missing values stay null and are labelled)
export function postRow(p) {
  const n = v => (v == null || isNaN(+v) ? null : +v);
  const images = [];
  const add = (src, kind) => { if (src && /^https?:\/\//.test(src) && !images.some(i => i.url === src)) images.push({ url: src, kind }); };
  add(p.full_picture, "full_picture");
  for (const a of p.attachments?.data || []) { add(a.media?.image?.src, a.media_type || "attachment"); for (const s of a.subattachments?.data || []) add(s.media?.image?.src, s.media_type || "attachment"); }
  const hasEng = p.reactions || p.comments || p.shares;
  return { post_id: String(p.id), message: p.message ? String(p.message).slice(0, 20000) : null, created_time: p.created_time ? new Date(p.created_time).toISOString() : null,
    updated_time: p.updated_time ? new Date(p.updated_time).toISOString() : null, permalink_url: /^https:\/\//i.test(p.permalink_url || "") ? p.permalink_url : null, image_url: images[0]?.url || null, images: images.slice(0, 6),
    status_type: p.status_type || null, likes: hasEng ? n(p.reactions?.summary?.total_count) : null, comments: hasEng ? n(p.comments?.summary?.total_count) : null, shares: hasEng ? (p.shares ? n(p.shares.count) : 0) : null };
}

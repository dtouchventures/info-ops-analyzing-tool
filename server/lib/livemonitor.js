// Live monitoring of authorised social media sources (AIVS 1.26).
//
//   collect   every post of the Facebook Pages named in META_PAGE_IDS (or added under Live Monitoring → Sources), read
//             with the Meta Graph API and the Page access token kept on the server. Runs on the server's own schedule
//             (every LIVE_MONITOR_INTERVAL_MINUTES, 5 by default), whether or not anyone has AIVS open. Each post is
//             stored once (platform post ID); a repeated collection only updates counts and records edits. The position
//             reached (newest publication time) is saved after the posts are, and the next run starts two hours before it,
//             so nothing is missed and nothing is counted twice. Every run is recorded (social_syncs) with its errors.
//   analyse   every new post: statements and claims, places, organisations, people, hashtags, themes, tone (with its
//             uncertainty), possible misinformation indicators (cues, not proof), near-identical earlier posts.
//   verify    the post goes through the automatic investigation (investigate.js): evidence search, comparison, image
//             checks (OCR, archive matching, reverse search and AI image description where configured) and the one-page
//             assessment. The result is stored with the post: a verification status, a documented confidence score, and
//             whether a person must review it.
//   watch     new posts are matched against the active AI Watchlists that include "Live Facebook monitoring".
//   alert     live alerts with documented, explained priorities: verification outcomes that need attention, unusual
//             posting frequency against the source's own history, emerging topics, repeated wording, unusual engagement,
//             and collection problems (token refused or expiring, repeated failures). Analysts acknowledge, dismiss or
//             escalate them; nothing is decided automatically.
// Rules: only content the token is authorised to read is collected; nothing is invented (missing values stay empty and
// are labelled); repetition alone is never called coordination; no intent, threat status or attribution is inferred.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nowISO } from "./db.js";
import { HttpError, hashPassword } from "./auth.js";
import { makeGraph, postRow, GraphError, FULL_FIELDS, BASIC_FIELDS } from "./meta-graph.js";
import { fetchImage } from "./fetchurl.js";
import { similarity, normForRepeat } from "./watch.js";
import { classifySentiment, themesOf, THEMES, SENTIMENT_LABELS, languageGuess } from "./social-analysis.js";
import { extractEntities, extractHashtags, splitSentences, classifyStatement, redFlags } from "../../shared/text.js";
import { peopleIn } from "./content-analysis.js";

export const VERIFY_LABELS = { pending: "Pending verification", supported: "Supported by evidence", contradicted: "Contradicted by evidence", insufficient: "Insufficient evidence",
  misleading: "Misleading or missing context", not_verifiable: "No checkable claim" };
const VERDICT_TO_STATUS = { supported: "supported", contradicted: "contradicted", insufficient: "insufficient", mixed: "insufficient", misleading: "misleading", not_verifiable: "not_verifiable" };
// documented confidence criteria (points add up; the score is capped between 0 and 100)
export const CONFIDENCE_CRITERIA = [
  ["factcheck", 35, "a published fact-check rating that addresses the claim"],
  ["official", 20, "an official or intergovernmental source that addresses the claim"],
  ["independent", 8, "each further independent, reliable source that addresses the claim (at most 3)"],
  ["agree", 10, "all sources that address the claim point the same way"],
  ["traceable", 6, "the origin is known (the Page and the publication time come from the platform API)"],
  ["conflict", -25, "reliable sources disagree"],
  ["ai_disagrees", -10, "the AI's reading of a source differed from the rules (flagged for a person)"],
  ["lower_only", 0, "only lower-reliability sources: the score is capped at 35"],
  ["none", 0, "no source addresses the claim: the score is at most 10"]];
export const CONFIDENCE_LEVELS = "High: 70–100 · Moderate: 40–69 · Low: 0–39. The score measures how well the evidence AIVS found supports the verification status; it is not a probability.";
export const PRIORITY_RULES = {
  verification: "Medium when a claim is contradicted or rated misleading. High when the confidence is High and the post also matched a watchlist or has unusually high engagement. Low when the confidence is Low.",
  frequency: "Medium when a source publishes at least three times its usual daily number of posts (and at least 4). High at five times and at least 10 posts. Needs at least 7 days of history.",
  emerging_topic: "Low when a hashtag, place or organisation appears in at least 3 posts in 24 hours after at most 1 in the 7 days before. Medium at 5 posts or more, or across more than one source.",
  repeated: "Low when the same or nearly the same wording appears in 3 posts within 72 hours; medium at 5 or more. Repetition alone does not show coordination or intent.",
  engagement: "Low when a post's public reactions, comments and shares reach ten times the Page's usual level (at least 50); medium at 25 times.",
  collection: "High when Meta refuses the token or a permission (collection has stopped). Medium after 5 failed runs in a row, or when the token expires within 7 days."
};
const KIND_LABEL = { verification: "Verification outcome", frequency: "Unusual posting frequency", emerging_topic: "Emerging topic", repeated: "Repeated wording", engagement: "Unusual engagement", collection: "Collection problem" };
const STOP = new Set("this that with from have will your their they them there been were what when which about into more than just also over only some such after before then these those very would could should other being because while where most must make made many much said says news today page post posts".split(" "));
const eatDay = (d = new Date()) => new Date(new Date(d).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
const eatTime = iso => { const d = new Date(Date.parse(iso) + 3 * 3600e3), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], p = x => String(x).padStart(2, "0"); return isNaN(d) ? iso : `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}hrs EAT`; };
const eatDayStart = (d = new Date()) => new Date(`${eatDay(d)}T00:00:00+03:00`).toISOString();
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const J = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

// ---------------------------------------------------------------- confidence and review (pure functions over an investigation result)
export function confidenceOf(r) {
  const ov = r.overall || {}, ev = (r.evidence || []).filter(e => !e.repeat_of && e.stance && e.stance !== "related");
  if (ov.verdict === "not_verifiable") return { score: null, level: "Not applicable", criteria: [{ rule: "no checkable claim was found, so there is nothing to be confident about", points: 0 }], scale: CONFIDENCE_LEVELS };
  const crit = [], add = (key, n = 1) => { const c = CONFIDENCE_CRITERIA.find(x => x[0] === key); crit.push({ rule: c[2], points: c[1] * n }); };
  const fc = ev.filter(e => e.rating), off = ev.filter(e => !e.rating && e.tier === "official"), rel = ev.filter(e => !e.rating && ["news", "fact_checker", "knowledge_base"].includes(e.tier));
  if (fc.length) add("factcheck"); if (off.length) add("official");
  const further = Math.min(3, Math.max(0, fc.length + off.length + rel.length - 1)); if (further) add("independent", further);
  const dirs = new Set(ev.map(e => e.stance === "misleading" ? "contradicts" : e.stance));
  if (ev.length && dirs.size === 1) add("agree"); if (dirs.has("supports") && dirs.has("contradicts")) add("conflict");
  if (r.source?.published_at && (r.source?.account || r.source?.author)) add("traceable");
  if ((r.evidence || []).some(e => e.ai_disagrees)) add("ai_disagrees");
  let score = crit.reduce((a, c) => a + c.points, 0);
  if (!ev.length) { score = Math.min(score, 10); add("none"); }
  else if (!fc.length && !off.length && !rel.length) { score = Math.min(score, 35); add("lower_only"); }
  score = Math.max(0, Math.min(100, score));
  return { score, level: score >= 70 ? "High" : score >= 40 ? "Moderate" : "Low", criteria: crit, scale: CONFIDENCE_LEVELS };
}
export function reviewReasons(r, conf, local) {
  const out = [], v = r.overall?.verdict;
  if (v === "contradicted" || v === "misleading") out.push(`the claim is assessed as ${String(VERIFY_LABELS[VERDICT_TO_STATUS[v]]).toLowerCase()}; a person must confirm this before it is used`);
  // Low confidence matters when a finding was reached, or when an unconfirmed claim touches a sensitive subject
  const sensitive = (local?.themes || []).filter(t => /Security|Health|Elections|Scams|Disaster/.test(t));
  if (conf.level === "Low" && ["supported", "contradicted", "misleading"].includes(v)) out.push("the finding rests on Low-confidence evidence");
  else if (["insufficient", "mixed"].includes(v) && sensitive.length) out.push(`the claim could not be confirmed and concerns ${sensitive.join(", ").toLowerCase()}`);
  if (conf.criteria.some(c => c.points < 0 && /disagree/.test(c.rule))) out.push("reliable sources disagree");
  if ((r.evidence || []).some(e => e.ai_disagrees)) out.push("the AI's reading of a source differs from the rules");
  if (r.media?.reuse?.length) out.push("an image may be an earlier image reused");
  if (local?.indicators?.length) out.push(`possible misinformation indicators: ${local.indicators.map(i => i.cue).slice(0, 3).join(", ")}`);
  return out;
}

// ---------------------------------------------------------------- local analysis of one post (rules; every result says how it was produced)
export function analysePost(post, { source, history = [] } = {}) {
  const text = String(post.message || "").trim(), ent = extractEntities(text), sent = text ? classifySentiment(text) : null;
  const statements = splitSentences(text).slice(0, 12).map(s => ({ text: s, type: classifyStatement(s).type }));
  const indicators = text ? redFlags(text).map(f => ({ cue: f.cue, indicator: f.text, check: f.check })) : [];
  let best = null;
  for (const h of history) { if (h.id === post.id || !h.message) continue; const s = h.text_hash === post.text_hash ? 1 : similarity(text, h.message); if (s >= 0.6 && (!best || s > best.similarity)) best = { post_id: h.id, similarity: Math.round(s * 100) / 100, created_time: h.created_time, source: h.source_name || null }; }
  const engagement = [post.likes, post.comments, post.shares].every(v => v == null) ? null : (post.likes || 0) + (post.comments || 0) + (post.shares || 0);
  return {
    method: "AIVS rules (shared/text.js, social-analysis.js); tone by " + (sent?.method || "none"),
    facts: [`Published by ${source?.name || "the Page"} on ${post.platform === "instagram" ? "Instagram" : "Facebook"} ${post.created_time ? `on ${eatTime(post.created_time)}` : "at an unknown time"} (from the platform API record).`,
      post.permalink_url ? "The post's own link was returned by the API." : "The API did not return a link to the post.",
      post.image_url ? (post.image_sha256 ? "An image is attached and a copy was stored." : `An image is attached but no copy could be stored${post.image_note ? ` (${post.image_note})` : ""}.`) : "No image was returned with the post.",
      engagement == null ? null : `Public counts when collected: ${post.likes ?? "not available"} reactions, ${post.comments ?? "not available"} comments, ${post.shares ?? "not available"} shares.`].filter(Boolean),
    claims: statements.filter(s => s.type === "factual").map(s => s.text), statements,
    entities: { locations: ent.locations, organisations: ent.orgs, people: peopleIn(text), numbers: ent.numbers, dates: ent.dates.map(d => d.text) },
    hashtags: extractHashtags(text), themes: themesOf(text).map(k => THEMES[k][0]), language: text ? languageGuess(text) : null,
    tone: sent ? { label: SENTIMENT_LABELS[sent.label] || sent.label, confidence: sent.confidence, uncertain: sent.label === "mixed" || (sent.confidence ?? 0) < 0.6, basis: sent.basis, method: sent.method } : null,
    indicators, similar: best,
    inferences: ["Themes, tone and indicators are automatic readings of the wording; they are leads, not findings.", ...(indicators.length ? ["Misinformation indicators are features common in misleading messages; they do not show that this post is false."] : [])],
    unknowns: [!text ? "The post has no text." : null, engagement == null ? "Public engagement counts were not available with this token's permissions." : null,
      "Whether the claims are accurate is not known until the verification has finished.", "Who else shared or repeated the post is not known: AIVS reads only the authorised Pages."].filter(Boolean)
  };
}

export function makeLiveMonitor(db, { config, investigations, watch, storage, audit, version = "dev", graphFactory = makeGraph }) {
  const L = { enabled: true, pageToken: "", pageIds: "", graphVersion: "v26.0", graphBase: "https://graph.facebook.com", appId: "", appSecret: "", intervalMinutes: 5, initialPosts: 25, maxPagesPerSync: 5,
    autoAnalyse: true, analyseConcurrency: 1, storeImages: true, engagementRefreshMinutes: 30, timeoutMs: 20000, tickSeconds: 30, igUserId: "", igToken: "", ...(config.live || {}) };
  const graph = graphFactory({ token: L.pageToken, version: L.graphVersion, base: L.graphBase, appId: L.appId, appSecret: L.appSecret, timeoutMs: L.timeoutMs, userAgent: `AIVS-live-monitor/${version}` });
  const ig = graphFactory({ token: L.igToken, version: L.graphVersion, base: L.graphBase, timeoutMs: L.timeoutMs, userAgent: `AIVS-live-monitor/${version}` });
  const tokenPrint = L.pageToken ? sha(L.pageToken).slice(0, 12) : null;
  const svc = { get: k => J(db.prepare("SELECT value_json FROM social_service WHERE key = ?").get(k)?.value_json), set: (k, v) => db.prepare("INSERT INTO social_service(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").run(k, JSON.stringify(v), nowISO()) };
  const usage = (op, status) => { try { db.prepare("INSERT INTO api_usage(at,service,operation,units,unit,est_cost_usd,status) VALUES (?,?,?,?,?,?,?)").run(nowISO(), "meta_graph", op, 1, "request", null, status); } catch {} };

  // the account the automatic work runs as (cannot sign in)
  function systemUser() {
    let u = db.prepare("SELECT * FROM users WHERE username = 'aivs-live'").get();
    if (!u) { db.prepare("INSERT INTO users(username,display_name,role,password_hash,active,created_at) VALUES ('aivs-live','AIVS Live Monitoring (automatic)','analyst',?,0,?)").run(hashPassword(crypto.randomBytes(24).toString("base64url") + "9a"), nowISO()); u = db.prepare("SELECT * FROM users WHERE username = 'aivs-live'").get(); }
    return u;
  }

  // ---------------------------------------------------------------- sources
  const getSource = id => db.prepare("SELECT * FROM social_sources WHERE id = ?").get(id);
  function ensureSources() {
    for (const raw of String(L.pageIds || "").split(/[\s,;]+/).filter(Boolean)) {
      const id = raw.replace(/^https?:\/\/(www\.|m\.)?facebook\.com\//i, "").replace(/[/?#].*$/, "");
      if (!/^[\w.-]{2,100}$/.test(id)) { console.warn(`[live] ignored META_PAGE_IDS entry “${raw.slice(0, 60)}”`); continue; }
      db.prepare("INSERT INTO social_sources(platform,external_id,origin,created_at) VALUES ('facebook',?, 'settings', ?) ON CONFLICT(platform, external_id, is_training) DO NOTHING").run(id, nowISO());
    }
  }
  async function addSource(user, { page, platform = "facebook" }) {
    const id = String(page || "").trim().replace(/^https?:\/\/(www\.|m\.)?facebook\.com\//i, "").replace(/[/?#].*$/, "");
    if (platform !== "facebook") throw new HttpError(400, "Only Facebook Pages can be added here. Instagram is set up with INSTAGRAM_USER_ID and a connection test.");
    if (!/^[\w.-]{2,100}$/.test(id)) throw new HttpError(400, "Give the Page ID (numbers) or the Page's facebook.com address.");
    if (!graph.configured()) throw new HttpError(409, "No Meta access token is set on the server (META_PAGE_ACCESS_TOKEN).");
    let j; try { j = await graph.get(encodeURIComponent(id), { fields: "id,name,link" }); usage("page details", "ok"); }
    catch (e) { usage("page details", "error"); throw new HttpError(e.kind === "token" || e.kind === "permission" ? 403 : 502, `Meta did not let AIVS read this Page: ${e.message}`); }
    const ins = db.prepare("INSERT INTO social_sources(platform,external_id,name,url,origin,added_by,created_at) VALUES ('facebook',?,?,?,'analyst',?,?) ON CONFLICT(platform, external_id, is_training) DO UPDATE SET enabled = 1, name = excluded.name").run(String(j.id), j.name || null, j.link || null, user.id, nowISO());
    const row = db.prepare("SELECT * FROM social_sources WHERE platform = 'facebook' AND external_id = ? AND is_training = 0").get(String(j.id));
    audit(user, "Live monitoring source added", "social_source", String(row.id), { platform: "facebook", page_id: j.id, name: j.name });
    return { ...row, created: ins.changes > 0 };
  }
  function setEnabled(user, id, enabled) {
    const s = getSource(id); if (!s) throw new HttpError(404, "No such source.");
    db.prepare("UPDATE social_sources SET enabled = ?, status = CASE WHEN ? = 0 THEN 'paused' ELSE 'idle' END, next_sync_at = NULL WHERE id = ?").run(enabled ? 1 : 0, enabled ? 1 : 0, s.id);
    audit(user, enabled ? "Live monitoring source resumed" : "Live monitoring source paused", "social_source", String(s.id), { name: s.name || s.external_id });
    return getSource(id);
  }

  // ---------------------------------------------------------------- token check
  async function checkToken({ force = false } = {}) {
    const cur = svc.get("meta_token");
    if (!graph.configured()) { const v = { state: "not_configured", needs: "META_PAGE_ACCESS_TOKEN (a Page access token for the authorised Page, kept in the server's .env)", checked_at: nowISO() }; svc.set("meta_token", v); return v; }
    if (!force && cur?.fingerprint === tokenPrint && cur.checked_at && Date.now() - Date.parse(cur.checked_at) < 6 * 3600e3 && cur.state !== "error") return cur;
    let v;
    try {
      const t = await graph.validate(); usage("token check", "ok");
      const soon = t.expires_at && t.expires_at !== "never" && Date.parse(t.expires_at) - Date.now() < 7 * 864e5;
      v = { state: t.valid ? "valid" : "invalid", subject_id: t.subject_id, subject_name: t.subject_name, expires_at: t.expires_at, data_access_expires_at: t.data_access_expires_at, type: t.type,
        scopes: t.scopes, expiry_known: t.debug, expiry_note: t.debug ? null : "Set META_APP_ID and META_APP_SECRET to let AIVS read the token's expiry date from Meta.", debug_error: t.debug_error || null, checked_at: nowISO(), fingerprint: tokenPrint, expiring_soon: !!soon };
      if (soon) raise({ kind: "collection", key: `token-expiry:${tokenPrint}`, group: "collection:meta", priority: "medium", priorityReasons: ["the Page access token expires within 7 days"], title: "Meta access token expires soon",
        reason: `The Page access token expires on ${t.expires_at}. Generate a new one and set META_PAGE_ACCESS_TOKEN on the server before then, or collection will stop.`, detail: { expires_at: t.expires_at } });
    } catch (e) {
      usage("token check", "error");
      v = { state: e.kind === "token" ? "invalid" : e.kind === "network" || e.kind === "temporary" ? "unreachable" : "error", error: graph.redact(e.message), kind: e.kind, code: e.code || null, subcode: e.subcode || null, checked_at: nowISO(), fingerprint: tokenPrint };
      logError(null, "facebook", e);
      if (e.kind === "token" || e.kind === "permission") raise({ kind: "collection", key: `token:${tokenPrint}:${e.code}:${e.subcode || 0}`, group: "collection:meta", priority: "high", priorityReasons: ["Meta refused the access token, so collection has stopped"],
        title: "Facebook collection stopped: the access token was refused", reason: graph.redact(e.message), detail: { code: e.code, subcode: e.subcode } });
    }
    svc.set("meta_token", v);
    if (v.state !== cur?.state) audit(null, "Meta access token checked", "live_monitor", "facebook", { state: v.state, subject: v.subject_name || null, error: v.error || null });
    return v;
  }
  function logError(sourceId, platform, e) {
    try { db.prepare("INSERT INTO social_api_errors(at,platform,source_id,kind,code,subcode,message) VALUES (?,?,?,?,?,?,?)").run(nowISO(), platform, sourceId, e.kind || "error", e.code || null, e.subcode || null, graph.redact(e.message).slice(0, 800)); } catch {}
  }

  // ---------------------------------------------------------------- collection
  const insPost = db.prepare(`INSERT INTO social_posts(source_id,platform,post_id,is_training,message,created_time,updated_time,permalink_url,image_url,attachments_json,likes,comments,shares,engagement_note,text_hash,collected_at,updated_at)
    VALUES (@source_id,@platform,@post_id,@is_training,@message,@created_time,@updated_time,@permalink_url,@image_url,@attachments_json,@likes,@comments,@shares,@engagement_note,@text_hash,@now,@now) ON CONFLICT(platform, post_id, is_training) DO NOTHING`);
  function store(src, rows, fieldNote) {
    const out = { new_posts: 0, duplicates: 0, updated: 0, fresh: [] }, now = nowISO();
    db.transaction(() => {
      for (const r of rows) {
        if (!r.post_id) continue;
        const rec = { source_id: src.id, platform: src.platform, post_id: r.post_id, is_training: src.is_training, message: r.message, created_time: r.created_time, updated_time: r.updated_time, permalink_url: r.permalink_url,
          image_url: r.image_url, attachments_json: r.images?.length > 1 ? JSON.stringify(r.images) : null, likes: r.likes, comments: r.comments, shares: r.shares,
          engagement_note: r.likes == null && r.comments == null && r.shares == null ? fieldNote || "engagement counts not returned" : null, text_hash: r.message ? sha(normForRepeat(r.message)) : null, now };
        if (insPost.run(rec).changes) { out.new_posts++; out.fresh.push(db.prepare("SELECT * FROM social_posts WHERE platform = ? AND post_id = ? AND is_training = ?").get(src.platform, r.post_id, src.is_training)); continue; }
        out.duplicates++;
        const old = db.prepare("SELECT * FROM social_posts WHERE platform = ? AND post_id = ? AND is_training = ?").get(src.platform, r.post_id, src.is_training);
        const changed = (r.message || null) !== (old.message || null);
        if (r.likes != null || r.comments != null || r.shares != null) metric(old.id, r, now);
        if (changed) {
          // an edited post: the new wording is kept and analysed again; the earlier analysis stays in its investigation
          db.prepare("UPDATE social_posts SET message = ?, text_hash = ?, updated_time = ?, edited = 1, updated_at = ?, analysis_status = CASE WHEN analysis_status IN ('done','failed','skipped') THEN 'pending' ELSE analysis_status END, analysis_attempts = 0, same_as_post = NULL WHERE id = ?")
            .run(r.message, r.message ? sha(normForRepeat(r.message)) : null, r.updated_time, now, old.id);
          out.updated++;
        }
      }
    })();
    return out;
  }
  function metric(postId, r, at) {
    db.prepare("UPDATE social_posts SET likes = coalesce(?, likes), comments = coalesce(?, comments), shares = coalesce(?, shares), updated_at = ? WHERE id = ?").run(r.likes, r.comments, r.shares, at, postId);
    db.prepare("INSERT INTO social_post_metrics(post_id,at,likes,comments,shares) VALUES (?,?,?,?,?)").run(postId, at, r.likes, r.comments, r.shares);
  }
  async function storeImage(p, { localFile = null } = {}) {
    if (!L.storeImages || (!p.image_url && !localFile)) return;
    try {
      let raw, mime;
      if (localFile) { raw = fs.readFileSync(localFile); mime = /\.png$/i.test(localFile) ? "image/png" : "image/jpeg"; }
      else { const g = await fetchImage(p.image_url, { allowPrivate: !!config.allowPrivateFetch }); raw = g.raw; mime = g.mime; }
      const s = await storage.putBuffer(raw, mime);
      db.prepare("UPDATE social_posts SET image_sha256 = ?, image_mime = ?, image_note = NULL WHERE id = ?").run(s.sha256, mime, p.id);
    } catch (e) { db.prepare("UPDATE social_posts SET image_note = ? WHERE id = ?").run(`the image could not be downloaded (${graph.redact(e.message).slice(0, 160)})`, p.id); }
  }

  const running = new Set();
  async function sync(sourceId, { kind = "scheduled", user = null } = {}) {
    const src = getSource(sourceId); if (!src) throw new HttpError(404, "No such source.");
    if (src.is_training) throw new HttpError(400, "Training sources are not collected from a platform; use “Load practice posts”.");
    if (running.has(src.id)) return { busy: true };
    running.add(src.id);
    const started = nowISO(), syncId = Number(db.prepare("INSERT INTO social_syncs(source_id,kind,started_at) VALUES (?,?,?)").run(src.id, kind, started).lastInsertRowid);
    const finish = (status, f = {}) => db.prepare("UPDATE social_syncs SET finished_at = ?, status = ?, requests = ?, pages = ?, fetched = ?, new_posts = ?, duplicates = ?, updated_posts = ?, since = ?, error_kind = ?, error = ?, note = ?, usage_json = ? WHERE id = ?")
      .run(nowISO(), status, f.requests || 0, f.pages || 0, f.fetched || 0, f.new_posts || 0, f.duplicates || 0, f.updated || 0, f.since || null, f.error_kind || null, f.error ? graph.redact(f.error).slice(0, 800) : null, f.note || null, f.usage ? JSON.stringify(f.usage) : null, syncId);
    db.prepare("UPDATE social_sources SET status = 'running', last_sync_at = ? WHERE id = ?").run(started, src.id);
    const since = src.checkpoint_time ? new Date(Date.parse(src.checkpoint_time) - 2 * 3600e3).toISOString() : null;
    try {
      let rows = [], meta = { requests: 0, pages: 0, field_note: null, fields_level: src.fields_level, more: false };
      if (src.platform === "facebook") {
        if (!graph.configured()) throw new GraphError("config", "No Meta access token is set on the server (META_PAGE_ACCESS_TOKEN).");
        if (!src.name) { try { const j = await graph.get(encodeURIComponent(src.external_id), { fields: "id,name,link" }); meta.requests++; db.prepare("UPDATE social_sources SET name = ?, url = ? WHERE id = ?").run(j.name || null, j.link || null, src.id); src.name = j.name; } catch (e) { if (e.kind === "token") throw e; } }
        const r = await graph.pagePosts(src.external_id, { since, limit: since ? 50 : Math.min(25, L.initialPosts), maxPosts: since ? 1000 : L.initialPosts, maxPages: L.maxPagesPerSync, fields: src.fields_level === "basic" ? BASIC_FIELDS : FULL_FIELDS });
        meta = { ...meta, ...r, requests: meta.requests + r.requests }; rows = r.posts.map(postRow);
      } else if (src.platform === "instagram") {
        if (!svc.get("instagram_test")?.ok) throw new GraphError("config", "Instagram is not connected: run the Instagram connection test first.");
        const j = await ig.igMedia(src.external_id, { limit: since ? 50 : L.initialPosts }); meta.requests = 1; meta.pages = 1;
        rows = (j.data || []).filter(m => !since || Date.parse(m.timestamp) >= Date.parse(since)).map(m => ({ post_id: String(m.id), message: m.caption || null, created_time: m.timestamp ? new Date(m.timestamp).toISOString() : null, updated_time: null,
          permalink_url: /^https:\/\//i.test(m.permalink || "") ? m.permalink : null, image_url: m.media_type === "VIDEO" ? m.thumbnail_url || null : m.media_url || null, images: [], likes: m.like_count ?? null, comments: m.comments_count ?? null, shares: null }));
      }
      for (let i = 0; i < meta.requests; i++) usage(src.platform === "instagram" ? "instagram media" : "page posts", "ok");
      const res = store(src, rows, meta.field_note);
      for (const p of res.fresh) await storeImage(p);
      // when more posts were waiting than one run reads, the position is not moved, so the next run reads the rest
      const newest = meta.more ? src.checkpoint_time || "" : rows.reduce((a, x) => (x.created_time && x.created_time > a ? x.created_time : a), src.checkpoint_time || "");
      const u = graph.usage?.() || null, busy = (u?.max_pct || 0) >= 95 ? Math.max(60, u.regain_minutes || 0) : (u?.max_pct || 0) >= 80 ? L.intervalMinutes * 3 : L.intervalMinutes;
      const note = [meta.field_note, meta.more ? `more than ${meta.pages} pages of posts were available; the rest is read on the next run` : null, meta.older_not_read ? `first run: the latest ${rows.length} posts were collected; older posts are not collected` : null, busy !== L.intervalMinutes ? `Meta reports ${u.max_pct}% of the rate limit used; the next run is delayed to ${busy} minutes` : null].filter(Boolean).join(" ") || null;
      db.prepare("UPDATE social_sources SET status = 'ok', last_ok_at = ?, next_sync_at = ?, backoff_until = NULL, failures = 0, last_error = ?, checkpoint_time = ?, fields_level = ? WHERE id = ?")
        .run(nowISO(), new Date(Date.now() + busy * 60e3).toISOString(), note, newest || null, meta.fields_level || (meta.field_note ? "basic" : "full"), src.id);
      finish(meta.more || meta.field_note ? "partial" : "ok", { requests: meta.requests, pages: meta.pages, fetched: rows.length, new_posts: res.new_posts, duplicates: res.duplicates, updated: res.updated, since, note, usage: u });
      if (kind !== "scheduled") audit(user, "Live monitoring synchronised", "social_source", String(src.id), { fetched: rows.length, new_posts: res.new_posts, duplicates: res.duplicates });
      if (svc.get("meta_token")?.state !== "valid" && src.platform === "facebook") checkToken({ force: true }).catch(() => {});
      afterCollect(getSource(src.id), res.fresh);
      return { fetched: rows.length, new_posts: res.new_posts, duplicates: res.duplicates, updated: res.updated, note };
    } catch (e) {
      // posts read before the failure are kept, and the position moves only as far as those posts
      let res = null;
      if (e.partial?.posts?.length) { const rows = e.partial.posts.map(postRow); res = store(src, rows); for (const p of res.fresh) await storeImage(p); afterCollect(src, res.fresh); }
      const failures = (src.failures || 0) + 1, kindE = e.kind || "error";
      const waitMin = kindE === "rate" ? Math.max(15, e.regain_minutes || 15 * 2 ** Math.min(4, failures - 1)) : kindE === "token" || kindE === "permission" ? 360 : kindE === "network" || kindE === "temporary" ? Math.min(30, 2 ** (failures - 1)) : 60;
      const status = kindE === "token" ? "token_refused" : kindE === "permission" ? "not_permitted" : kindE === "rate" ? "rate_limited" : kindE === "config" ? "not_configured" : "retrying";
      db.prepare("UPDATE social_sources SET status = ?, failures = ?, backoff_until = ?, next_sync_at = ?, last_error = ? WHERE id = ?").run(status, failures, new Date(Date.now() + waitMin * 60e3).toISOString(), new Date(Date.now() + waitMin * 60e3).toISOString(), graph.redact(e.message).slice(0, 600), src.id);
      finish(res ? "partial" : "failed", { requests: e.partial?.requests || 0, pages: e.partial?.pages || 0, fetched: e.partial?.posts?.length || 0, new_posts: res?.new_posts || 0, duplicates: res?.duplicates || 0, since, error_kind: kindE, error: e.message });
      logError(src.id, src.platform, e);
      if (kindE === "token" || kindE === "permission") { svc.set("meta_token", { ...(svc.get("meta_token") || {}), state: kindE === "token" ? "invalid" : "not_permitted", error: graph.redact(e.message), checked_at: nowISO(), fingerprint: tokenPrint });
        raise({ kind: "collection", key: `refused:${src.id}:${tokenPrint}:${e.code}`, group: "collection:meta", source: src, priority: "high", priorityReasons: ["Meta refused the token or a permission, so collection from this source has stopped"],
          title: `Collection stopped for ${src.name || src.external_id}`, reason: graph.redact(e.message), detail: { code: e.code, subcode: e.subcode } }); }
      if (failures === 5) raise({ kind: "collection", key: `failing:${src.id}:${eatDay()}`, group: "collection:meta", source: src, priority: "medium", priorityReasons: ["5 collection runs in a row failed"], title: `Collection failing for ${src.name || src.external_id}`, reason: graph.redact(e.message), detail: { failures } });
      if (failures === 5 || kindE === "token" || kindE === "permission") audit(null, "Live monitoring collection failing", "social_source", String(src.id), { kind: kindE, failures, error: graph.redact(e.message).slice(0, 300) });
      return { error: graph.redact(e.message), kind: kindE, partial: res ? { new_posts: res.new_posts } : null };
    } finally { running.delete(src.id); }
  }

  // ---------------------------------------------------------------- after each collection: watchlists, alerts for frequency and topics, analysis
  function afterCollect(src, fresh) {
    if (fresh.length) for (const p of fresh) matchWatchlists(src, p);
    try { frequencyCheck(src); } catch (e) { console.warn("[live] frequency check:", e.message); }
    try { if (fresh.length) emergingTopics(src.is_training); } catch (e) { console.warn("[live] topic check:", e.message); }
    for (const p of fresh) try { repeatedCheck(p, src); } catch (e) { console.warn("[live] repeat check:", e.message); }
    if (fresh.length) setImmediate(() => work().catch(e => console.error("[live] analysis:", e.message)));
  }
  function matchWatchlists(src, p) {
    if (src.is_training || !p.message || !watch) return 0;
    let n = 0;
    for (const { id } of db.prepare("SELECT id FROM watchlists WHERE status = 'active' AND deleted_at IS NULL").all()) {
      const wl = watch.get(id); if (!wl.definition.sources.includes("fb_live")) continue;
      if (wl.definition.fb_pages?.length && !wl.definition.fb_pages.includes(src.external_id)) continue;
      const r = watch.ingest(wl, "fb_live", [{ platform: src.platform === "instagram" ? "Instagram" : "Facebook", post_id: p.post_id, account: src.name || src.external_id, text: p.message, url: p.permalink_url,
        posted_at: p.created_time, likes: p.likes, comments: p.comments, shares: p.shares, collected_via: `Live monitoring (Meta Graph API, ${src.name || src.external_id})` }]);
      n += r.new_matches;
    }
    return n;
  }
  function frequencyCheck(src) {
    const now = Date.now(), day = 864e5;
    const first = db.prepare("SELECT MIN(created_time) t FROM social_posts WHERE source_id = ?").get(src.id).t;
    if (!first || now - Date.parse(first) < 8 * day) return null;   // at least 7 full days of history before the last 24 hours
    const recent = db.prepare("SELECT COUNT(*) n FROM social_posts WHERE source_id = ? AND created_time >= ?").get(src.id, new Date(now - day).toISOString()).n;
    const days = Math.min(14, Math.floor((now - Date.parse(first)) / day) - 1), counts = [];
    for (let i = 1; i <= days; i++) counts.push(db.prepare("SELECT COUNT(*) n FROM social_posts WHERE source_id = ? AND created_time >= ? AND created_time < ?").get(src.id, new Date(now - (i + 1) * day).toISOString(), new Date(now - i * day).toISOString()).n);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length, ratio = mean ? recent / mean : recent;
    if (recent < 4 || ratio < 3) return null;
    const pri = ratio >= 5 && recent >= 10 ? "high" : "medium";
    return raise({ kind: "frequency", key: `freq:${src.id}:${eatDay()}`, group: `source:${src.id}`, source: src, priority: pri,
      priorityReasons: [`${recent} posts in the last 24 hours against a usual ${mean.toFixed(1)} a day over ${counts.length} days (${ratio.toFixed(1)} times)`],
      title: `${src.name || src.external_id}: ${recent} posts in 24 hours (usually ${mean.toFixed(1)} a day)`, reason: "The source is publishing much more often than usual. This is a change in publicly observable activity, not a finding about its purpose.",
      detail: { recent, baseline_mean: Math.round(mean * 10) / 10, baseline_days: counts.length, daily_counts: counts.reverse() } });
  }
  function emergingTopics(isTraining) {
    const now = Date.now(), day = 864e5;
    const first = db.prepare("SELECT MIN(created_time) t FROM social_posts WHERE is_training = ?").get(isTraining).t;
    if (!first || now - Date.parse(first) < 4 * day) return 0;     // three days of history are needed to call something new
    const recent = db.prepare("SELECT p.id, p.message, p.source_id FROM social_posts p WHERE p.is_training = ? AND p.created_time >= ? AND p.message IS NOT NULL").all(isTraining, new Date(now - day).toISOString());
    const prior = db.prepare("SELECT p.message FROM social_posts p WHERE p.is_training = ? AND p.created_time >= ? AND p.created_time < ? AND p.message IS NOT NULL").all(isTraining, new Date(now - 8 * day).toISOString(), new Date(now - day).toISOString());
    const terms = t => { const e = extractEntities(t); return new Set([...extractHashtags(t).map(h => h.toLowerCase()), ...e.locations, ...e.orgs]); };
    const rec = new Map(); for (const p of recent) for (const k of terms(p.message)) { const v = rec.get(k) || { posts: [], sources: new Set() }; v.posts.push(p.id); v.sources.add(p.source_id); rec.set(k, v); }
    const before = new Map(); for (const p of prior) for (const k of terms(p.message)) before.set(k, (before.get(k) || 0) + 1);
    let n = 0;
    for (const [k, v] of rec) {
      if (v.posts.length < 3 || (before.get(k) || 0) > 1 || STOP.has(k.toLowerCase())) continue;
      const pri = v.posts.length >= 5 || v.sources.size > 1 ? "medium" : "low";
      n += raise({ kind: "emerging_topic", key: `topic:${isTraining}:${k.toLowerCase()}:${eatDay()}`, group: `topic:${k.toLowerCase()}`, isTraining, priority: pri,
        priorityReasons: [`“${k}” appears in ${v.posts.length} posts in 24 hours${v.sources.size > 1 ? ` from ${v.sources.size} sources` : ""}, after ${before.get(k) || 0} in the 7 days before`],
        title: `Emerging topic: ${k} (${v.posts.length} posts in 24 hours)`, reason: "A hashtag, place or organisation that was rarely mentioned is now appearing repeatedly. Check what the posts say before drawing conclusions.",
        detail: { term: k, posts: v.posts, prior_7_days: before.get(k) || 0 }, postId: v.posts[0] });
    }
    return n;
  }
  function repeatedCheck(p, src) {
    if (!p.message || normForRepeat(p.message).split(" ").length < 6) return 0;
    const since = new Date(Date.parse(p.created_time || nowISO()) - 72 * 3600e3).toISOString();
    const near = db.prepare("SELECT id, message, text_hash, created_time, source_id FROM social_posts WHERE is_training = ? AND id != ? AND created_time >= ? AND message IS NOT NULL ORDER BY created_time LIMIT 500").all(p.is_training, p.id, since)
      .filter(h => h.text_hash === p.text_hash || similarity(p.message, h.message) >= 0.8);
    if (near.length < 2) return 0;
    const ids = [...near.map(h => h.id), p.id], firstId = Math.min(...ids), pri = ids.length >= 5 ? "medium" : "low";
    // one alert per group of near-identical posts; the alert grows as more appear
    const key = `repeat:${p.is_training}:${firstId}`, existing = db.prepare("SELECT id, detail_json FROM live_alerts WHERE dedupe_key = ?").get(key);
    const detail = { posts: ids, sources: [...new Set([...near.map(h => h.source_id), p.source_id])], window_hours: 72, note: "Repetition alone does not show coordination or intent." };
    if (existing) { db.prepare("UPDATE live_alerts SET detail_json = ?, priority = CASE WHEN ? = 'medium' THEN 'medium' ELSE priority END, title = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(detail), pri, `Same wording in ${ids.length} posts within 72 hours`, nowISO(), existing.id); return 0; }
    return raise({ kind: "repeated", key, group: `repeat:${firstId}`, source: src, priority: pri, priorityReasons: [`${ids.length} posts with the same or nearly the same wording within 72 hours`],
      title: `Same wording in ${ids.length} posts within 72 hours`, reason: "The same message is being published repeatedly. Repetition alone does not show coordination or intent; check who published each post and when.", detail, postId: p.id });
  }
  // ---------------------------------------------------------------- live alerts
  function raise({ kind, key, group = null, source = null, isTraining = null, postId = null, priority, priorityReasons, title, reason, detail = {} }) {
    const now = nowISO(), r = db.prepare("INSERT INTO live_alerts(kind,dedupe_key,group_key,is_training,source_id,post_id,priority,title,reason,priority_reasons_json,detail_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?,?) ON CONFLICT(dedupe_key) DO NOTHING")
      .run(kind, key, group, isTraining ?? source?.is_training ?? 0, source?.id ?? null, postId, priority, String(title).slice(0, 300), String(reason).slice(0, 1000), JSON.stringify(priorityReasons), JSON.stringify({ ...detail, priority_rule: PRIORITY_RULES[kind] }), now, now);
    if (r.changes) { db.prepare("INSERT INTO live_alert_events(alert_id,action,note,by_user,at) VALUES (?,?,?,?,?)").run(Number(r.lastInsertRowid), "raised", reason.slice(0, 300), null, now); return 1; }
    return 0;
  }
  const alertRow = a => a && ({ ...a, kind_label: KIND_LABEL[a.kind] || a.kind, priority_reasons: J(a.priority_reasons_json) || [], detail: J(a.detail_json) || {}, priority_reasons_json: undefined, detail_json: undefined });
  function alerts({ status = "", priority = "", kind = "", training = 0, limit = 100, group = false } = {}) {
    let q = "SELECT a.*, s.name source_name, s.external_id FROM live_alerts a LEFT JOIN social_sources s ON s.id = a.source_id WHERE a.is_training = ?"; const args = [training ? 1 : 0];
    for (const [k, v, allowed] of [["a.status", status, ["new", "acknowledged", "dismissed", "escalated"]], ["a.priority", priority, ["low", "medium", "high"]], ["a.kind", kind, Object.keys(KIND_LABEL)]]) {
      const vals = String(v || "").split(",").filter(x => allowed.includes(x)); if (vals.length) { q += ` AND ${k} IN (${vals.map(() => "?").join(",")})`; args.push(...vals); } }
    q += " ORDER BY CASE a.status WHEN 'new' THEN 0 WHEN 'escalated' THEN 1 WHEN 'acknowledged' THEN 2 ELSE 3 END, CASE a.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.created_at DESC LIMIT ?"; args.push(Math.min(500, +limit || 100));
    const list = db.prepare(q).all(...args).map(alertRow);
    if (!group) return { alerts: list, priority_rules: PRIORITY_RULES };
    const groups = new Map(); for (const a of list) { const k = a.group_key || `alert:${a.id}`; const g = groups.get(k) || { group_key: k, kind: a.kind, kind_label: a.kind_label, alerts: [], top_priority: "low", new: 0 };
      g.alerts.push(a); if ({ high: 2, medium: 1, low: 0 }[a.priority] > { high: 2, medium: 1, low: 0 }[g.top_priority]) g.top_priority = a.priority; if (a.status === "new") g.new++; groups.set(k, g); }
    return { groups: [...groups.values()], alerts: list, priority_rules: PRIORITY_RULES };
  }
  function alert(id) {
    const a = alertRow(db.prepare("SELECT a.*, s.name source_name FROM live_alerts a LEFT JOIN social_sources s ON s.id = a.source_id WHERE a.id = ?").get(id)); if (!a) throw new HttpError(404, "No such alert.");
    const ids = [...new Set([a.post_id, ...(a.detail.posts || [])].filter(Boolean))].slice(0, 30);
    a.posts = ids.map(i => postSummary(db.prepare("SELECT p.*, s.name source_name FROM social_posts p JOIN social_sources s ON s.id = p.source_id WHERE p.id = ?").get(i))).filter(Boolean);
    a.events = db.prepare("SELECT e.*, u.display_name by_name FROM live_alert_events e LEFT JOIN users u ON u.id = e.by_user WHERE alert_id = ? ORDER BY e.id").all(a.id);
    return a;
  }
  function act(user, id, { action, note }) {
    const a = db.prepare("SELECT * FROM live_alerts WHERE id = ?").get(id); if (!a) throw new HttpError(404, "No such alert.");
    const to = { acknowledge: "acknowledged", dismiss: "dismissed", escalate: "escalated", reopen: "new" }[action]; if (!to) throw new HttpError(400, "Choose acknowledge, dismiss, escalate or reopen.");
    note = String(note || "").trim().slice(0, 1000);
    if ((action === "dismiss" || action === "escalate") && !note) throw new HttpError(400, action === "escalate" ? "Say why this needs a decision by a senior analyst or commander." : "Say briefly why the alert is dismissed.");
    db.prepare("UPDATE live_alerts SET status = ?, note = coalesce(?, note), updated_at = ?, updated_by = ? WHERE id = ?").run(to, note || null, nowISO(), user.id, a.id);
    db.prepare("INSERT INTO live_alert_events(alert_id,action,note,by_user,at) VALUES (?,?,?,?,?)").run(a.id, action, note || null, user.id, nowISO());
    audit(user, `Live alert ${to}`, "live_alert", String(a.id), { kind: a.kind, priority: a.priority, note: note || null });
    return alert(a.id);
  }

  // ---------------------------------------------------------------- analysis and verification queue
  let working = false;
  async function work() {
    if (working) return { busy: true }; working = true; const out = { analysed: 0, started: 0, finished: 0 };
    try {
      // 1 results of investigations that have finished
      for (const p of db.prepare("SELECT p.*, i.status inv_status FROM social_posts p JOIN investigations i ON i.id = p.investigation_id WHERE p.analysis_status = 'verifying'").all()) {
        if (p.inv_status === "done") { finishVerification(p); out.finished++; }
        else if (p.inv_status === "failed") {
          const err = db.prepare("SELECT error FROM investigations WHERE id = ?").get(p.investigation_id)?.error;
          db.prepare("UPDATE social_posts SET analysis_status = ?, analysis_error = ?, investigation_id = CASE WHEN ? THEN investigation_id ELSE NULL END WHERE id = ?").run(p.analysis_attempts >= 3 ? "failed" : "pending", `verification failed: ${String(err || "").slice(0, 300)}`, p.analysis_attempts >= 3 ? 1 : 0, p.id);
        }
      }
      // 2 local analysis of new posts, then verification (a few at a time, so the server stays responsive)
      const sys = systemUser();
      for (const p of db.prepare("SELECT p.*, s.name source_name, s.external_id, s.is_training src_training FROM social_posts p JOIN social_sources s ON s.id = p.source_id WHERE p.analysis_status = 'pending' AND p.analysis_attempts < 3 ORDER BY p.created_time LIMIT 50").all()) {
        const busy = db.prepare("SELECT COUNT(*) n FROM social_posts WHERE analysis_status = 'verifying'").get().n;
        db.prepare("UPDATE social_posts SET analysis_status = 'analysing' WHERE id = ?").run(p.id);
        const history = db.prepare("SELECT p.id, p.message, p.text_hash, p.created_time, s.name source_name FROM social_posts p JOIN social_sources s ON s.id = p.source_id WHERE p.is_training = ? AND p.id != ? AND p.created_time >= ? ORDER BY p.created_time DESC LIMIT 800")
          .all(p.is_training, p.id, new Date(Date.parse(p.created_time || nowISO()) - 30 * 864e5).toISOString());
        const local = analysePost(p, { source: { name: p.source_name || p.external_id }, history });
        db.prepare("UPDATE social_posts SET analysis_json = ?, topics_json = ?, analysed_at = ? WHERE id = ?").run(JSON.stringify(local), JSON.stringify(local.themes), nowISO(), p.id); out.analysed++;
        if (!p.message && !p.image_sha256) { db.prepare("UPDATE social_posts SET analysis_status = 'skipped', verification = 'not_verifiable', analysis_error = 'the post has no text and no stored image' WHERE id = ?").run(p.id); continue; }
        // the same wording was already verified: its result is reused instead of searching again
        const twin = local.similar && local.similar.similarity >= 0.92 ? db.prepare("SELECT * FROM social_posts WHERE id = ? AND analysis_status = 'done' AND investigation_id IS NOT NULL").get(local.similar.post_id) : null;
        if (twin && !p.image_sha256) {
          db.prepare("UPDATE social_posts SET analysis_status = 'done', same_as_post = ?, investigation_id = ?, verification = ?, confidence = ?, confidence_json = ?, needs_review = ?, review_reasons_json = ?, analysis_error = NULL WHERE id = ?")
            .run(twin.id, twin.investigation_id, twin.verification, twin.confidence, twin.confidence_json, twin.needs_review, JSON.stringify([...(J(twin.review_reasons_json) || []), `same wording as post ${twin.id}, whose verification is reused`]), p.id);
          continue;
        }
        if (!L.autoAnalyse) { db.prepare("UPDATE social_posts SET analysis_status = 'done', verification = 'pending', analysis_error = 'automatic verification is switched off (LIVE_AUTO_ANALYSE=false)' WHERE id = ?").run(p.id); continue; }
        if (busy >= L.analyseConcurrency) { db.prepare("UPDATE social_posts SET analysis_status = 'pending' WHERE id = ?").run(p.id); break; }
        try { startVerification(sys, p); out.started++; }
        catch (e) { db.prepare("UPDATE social_posts SET analysis_status = 'failed', analysis_attempts = analysis_attempts + 1, analysis_error = ? WHERE id = ?").run(String(e.message).slice(0, 300), p.id); }
      }
    } finally { working = false; }
    return out;
  }
  function startVerification(sys, p) {
    const files = [];
    if (p.image_sha256) { const ext = p.image_mime === "image/png" ? "png" : p.image_mime === "image/webp" ? "webp" : "jpg", tmp = path.join(storage.tmpDir, `live-${p.id}-${Date.now()}.${ext}`);
      fs.writeFileSync(tmp, storage.read(p.image_sha256)); files.push({ originalname: `${p.platform}-post-${p.post_id.replace(/\W/g, "_")}.${ext}`, size: fs.statSync(tmp).size, path: tmp }); }
    const plat = p.platform === "instagram" ? "Instagram" : "Facebook";
    const inv = investigations.start(sys, { text: p.message || "", files, isTraining: !!p.is_training, origin: "live", prefetched: {
      platform: plat, url: p.permalink_url, account: p.source_name || p.external_id, publisher: p.source_name || null, author_basis: `the ${plat} Page that published the post (platform API)`,
      published_at: p.created_time, published_basis: `publication time from the ${plat} Graph API`, method: `${plat} Graph API (authorised access token), collected ${p.collected_at}`,
      metrics: p.likes == null && p.comments == null && p.shares == null ? null : { reactions: p.likes, comments: p.comments, shares: p.shares },
      notes: [p.is_training ? "PRACTICE post from the training fixtures; not real content." : null, p.image_note, p.edited ? "The post was edited after it was first collected; the current wording was analysed." : null].filter(Boolean) } });
    db.prepare("UPDATE social_posts SET analysis_status = 'verifying', investigation_id = ?, analysis_attempts = analysis_attempts + 1, verification = 'pending', analysis_error = NULL WHERE id = ?").run(inv.id, p.id);
  }
  function finishVerification(p) {
    const inv = db.prepare("SELECT result_json FROM investigations WHERE id = ?").get(p.investigation_id), r = J(inv?.result_json); if (!r) return;
    const local = J(p.analysis_json) || {}, conf = confidenceOf(r), status = VERDICT_TO_STATUS[r.overall?.verdict] || "insufficient", reasons = reviewReasons(r, conf, local);
    // the analysis record now says what the verification found (still AI-generated until a person reviews the report)
    local.unknowns = (local.unknowns || []).filter(u => !/until the verification has finished/.test(u));
    local.verification = `${VERIFY_LABELS[status]} (automatic investigation ${r.report_id}; ${conf.level === "Not applicable" ? "confidence not applicable" : `confidence ${conf.level}, ${conf.score}/100`}; AI-generated, not reviewed).`;
    if (status === "insufficient") local.unknowns.push("No source found by AIVS confirms or refutes the claim; it remains unverified.");
    db.prepare("UPDATE social_posts SET analysis_status = 'done', verification = ?, confidence = ?, confidence_json = ?, needs_review = ?, review_reasons_json = ?, analysis_json = ?, analysis_error = NULL WHERE id = ?")
      .run(status, conf.score, JSON.stringify(conf), reasons.length ? 1 : 0, JSON.stringify(reasons), JSON.stringify(local), p.id);
    if (status === "contradicted" || status === "misleading") {
      const src = getSource(p.source_id), watched = db.prepare("SELECT COUNT(*) n FROM watch_posts wp JOIN watch_matches m ON m.post_id = wp.id WHERE wp.platform = ? AND wp.post_id = ?").get(p.platform === "instagram" ? "Instagram" : "Facebook", p.post_id).n > 0;
      const eng = (p.likes || 0) + (p.comments || 0) + (p.shares || 0), base = median(db.prepare("SELECT coalesce(likes,0)+coalesce(comments,0)+coalesce(shares,0) e FROM social_posts WHERE source_id = ? AND id != ? ORDER BY created_time DESC LIMIT 50").all(p.source_id, p.id).map(x => x.e));
      const highEng = eng >= 50 && eng >= 2 * Math.max(1, base), why = [`the claim is assessed as ${VERIFY_LABELS[status].toLowerCase()} with ${conf.level.toLowerCase()} confidence (${conf.score}/100)`];
      if (watched) why.push("the post matched an active watchlist"); if (highEng) why.push(`engagement (${eng}) is at least twice the Page's usual level (${base})`);
      const pri = conf.level === "Low" ? "low" : conf.level === "High" && (watched || highEng) ? "high" : "medium";
      raise({ kind: "verification", key: `verify:${p.id}:${p.investigation_id}`, group: `claim:${p.text_hash || p.id}`, source: src, postId: p.id, priority: pri, priorityReasons: why,
        title: `${VERIFY_LABELS[status]}: ${String(p.message || "").replace(/\s+/g, " ").slice(0, 110)}`, reason: `The automatic verification found the post's main claim ${status === "misleading" ? "misleading or missing context" : "contradicted by evidence"}. AI-generated: a person must review the report before anything is done with it.`,
        detail: { investigation_id: p.investigation_id, report_id: r.report_id, confidence: conf, review_reasons: reasons } });
    }
  }

  // ---------------------------------------------------------------- engagement refresh (public counts of recent posts)
  async function refreshEngagement() {
    const out = { posts: 0, alerts: 0, errors: [] };
    for (const src of db.prepare("SELECT * FROM social_sources WHERE platform = 'facebook' AND enabled = 1 AND is_training = 0 AND status NOT IN ('token_refused','not_permitted') AND coalesce(fields_level,'full') = 'full'").all()) {
      if (src.last_engagement_at && Date.now() - Date.parse(src.last_engagement_at) < L.engagementRefreshMinutes * 60e3) continue;
      const posts = db.prepare("SELECT * FROM social_posts WHERE source_id = ? AND created_time >= ? ORDER BY created_time DESC LIMIT 50").all(src.id, new Date(Date.now() - 72 * 3600e3).toISOString());
      db.prepare("UPDATE social_sources SET last_engagement_at = ? WHERE id = ?").run(nowISO(), src.id);
      if (!posts.length) continue;
      try {
        const j = await graph.postsByIds(posts.map(p => p.post_id)); usage("engagement refresh", "ok");
        const base = median(db.prepare("SELECT coalesce(likes,0)+coalesce(comments,0)+coalesce(shares,0) e FROM social_posts WHERE source_id = ? AND created_time >= ? AND likes IS NOT NULL").all(src.id, new Date(Date.now() - 30 * 864e5).toISOString()).map(x => x.e));
        const enough = db.prepare("SELECT COUNT(*) n FROM social_posts WHERE source_id = ? AND likes IS NOT NULL").get(src.id).n >= 5;
        for (const p of posts) {
          const g = j[p.post_id]; if (!g) continue; const r = postRow({ id: p.post_id, ...g }); metric(p.id, r, nowISO()); out.posts++;
          const e = (r.likes || 0) + (r.comments || 0) + (r.shares || 0);
          if (enough && e >= 50 && e >= 10 * Math.max(1, base)) out.alerts += raise({ kind: "engagement", key: `eng:${p.id}`, group: `source:${src.id}`, source: src, postId: p.id, priority: e >= 25 * Math.max(1, base) ? "medium" : "low",
            priorityReasons: [`${e} public reactions, comments and shares against a usual ${base} for this Page`], title: `Unusual engagement: ${String(p.message || "").replace(/\s+/g, " ").slice(0, 100)}`,
            reason: "Public counts only. High engagement shows reach, not who engaged or why.", detail: { engagement: e, page_median: base } });
        }
      } catch (e) { usage("engagement refresh", "error"); out.errors.push(graph.redact(e.message)); logError(src.id, "facebook", e); }
    }
    return out;
  }

  // ---------------------------------------------------------------- scheduler (runs inside the server, independent of any open page)
  let timer = null, ticking = false, lastTokenCheck = 0;
  async function tick() {
    if (ticking) return { busy: true }; ticking = true; const out = { synced: 0 };
    try {
      if (Date.now() - lastTokenCheck > 6 * 3600e3 && graph.configured()) { lastTokenCheck = Date.now(); await checkToken().catch(() => {}); }
      const tok = svc.get("meta_token");
      for (const s of db.prepare("SELECT * FROM social_sources WHERE enabled = 1 AND is_training = 0 ORDER BY id").all()) {
        if (s.platform === "facebook" && !graph.configured()) continue;
        if (s.platform === "facebook" && tok?.state === "invalid" && tok.fingerprint === tokenPrint) continue;    // a refused token is not retried until it is replaced
        if (s.backoff_until && Date.parse(s.backoff_until) > Date.now()) continue;
        if (s.next_sync_at && Date.parse(s.next_sync_at) > Date.now()) continue;
        await sync(s.id); out.synced++;
      }
      await work();
      if (L.engagementRefreshMinutes > 0) await refreshEngagement().catch(e => console.warn("[live] engagement:", e.message));
    } finally { ticking = false; }
    return out;
  }
  function start() {
    if (!L.enabled || timer) return;
    db.prepare("UPDATE social_sources SET status = 'idle' WHERE status = 'running'").run();
    db.prepare("UPDATE social_syncs SET status = 'interrupted', finished_at = ?, note = 'interrupted by a server restart; the next run continues from the last saved position' WHERE status = 'running'").run(nowISO());
    db.prepare("UPDATE social_posts SET analysis_status = 'pending' WHERE analysis_status = 'analysing'").run();
    ensureSources();
    timer = setInterval(() => tick().catch(e => console.error("[live] monitoring:", e.message)), L.tickSeconds * 1000); timer.unref?.();
    setTimeout(() => tick().catch(e => console.error("[live] monitoring:", e.message)), 2000).unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  // ---------------------------------------------------------------- Instagram (prepared; "Not connected" until a test succeeds)
  async function testInstagram(user) {
    if (!L.igUserId) { const v = { ok: false, at: nowISO(), error: "INSTAGRAM_USER_ID is not set (the Instagram professional account linked to the Facebook Page)." }; svc.set("instagram_test", v); return v; }
    let v;
    try { const a = await ig.get(encodeURIComponent(L.igUserId), { fields: "id,username,media_count" }); const m = await ig.igMedia(L.igUserId, { limit: 1 }); usage("instagram test", "ok");
      v = { ok: true, at: nowISO(), username: a.username || null, media_count: a.media_count ?? null, sample_items: (m.data || []).length };
      db.prepare("INSERT INTO social_sources(platform,external_id,name,origin,added_by,created_at,enabled) VALUES ('instagram',?,?,'settings',?,?,0) ON CONFLICT(platform, external_id, is_training) DO UPDATE SET name = excluded.name").run(String(a.id), a.username ? `@${a.username}` : null, user?.id ?? null, nowISO()); }
    catch (e) { usage("instagram test", "error"); v = { ok: false, at: nowISO(), error: ig.redact(e.message), kind: e.kind }; }
    svc.set("instagram_test", v); audit(user, "Instagram connection tested", "live_monitor", "instagram", { ok: v.ok, error: v.error || null });
    return v;
  }
  function instagramStatus() {
    const t = svc.get("instagram_test");
    if (t?.ok) return { status: "Connected (tested)", connected: true, tested_at: t.at, account: t.username ? `@${t.username}` : null, note: "Collection runs only for Instagram sources that an administrator has switched on. Meta's permissions cover only accounts linked to your Page, not all public accounts or hashtags." };
    return { status: "Not connected", connected: false, tested_at: t?.at || null, reason: t?.error || (L.igUserId ? "The connection has not been tested yet." : "INSTAGRAM_USER_ID is not set."),
      note: "Instagram Graph API access covers the professional account linked to your Facebook Page (and hashtag search only with Meta's approval). It does not allow monitoring of all public accounts." };
  }

  // ---------------------------------------------------------------- reading
  const postSummary = p => p && ({ id: p.id, platform: p.platform, post_id: p.post_id, source_id: p.source_id, source_name: p.source_name || null, message: p.message, created_time: p.created_time, updated_time: p.updated_time, permalink_url: p.permalink_url,
    has_image: !!p.image_url, image_stored: !!p.image_sha256, image_note: p.image_note, likes: p.likes, comments: p.comments, shares: p.shares, engagement_note: p.engagement_note, collected_at: p.collected_at, edited: !!p.edited,
    analysis_status: p.analysis_status, analysis_error: p.analysis_error, verification: p.verification || (["pending", "analysing", "verifying"].includes(p.analysis_status) ? "pending" : null),
    verification_label: VERIFY_LABELS[p.verification || "pending"] || null, confidence: p.confidence, confidence_level: J(p.confidence_json)?.level || null, needs_review: !!p.needs_review,
    review_reasons: J(p.review_reasons_json) || [], topics: J(p.topics_json) || [], investigation_id: p.investigation_id, same_as_post: p.same_as_post, is_training: !!p.is_training,
    top_alert: p.top_alert || null });
  function posts(f = {}) {
    const where = ["p.is_training = @training"], a = { training: f.training ? 1 : 0, limit: Math.min(200, Math.max(1, +f.limit || 50)), offset: Math.max(0, +f.offset || 0) };
    const day = (v, end) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? new Date(new Date(`${v}T00:00:00+03:00`).getTime() + (end ? 864e5 : 0)).toISOString() : null;
    if (day(f.from)) { where.push("p.created_time >= @from"); a.from = day(f.from); }
    if (day(f.to, true)) { where.push("p.created_time < @to"); a.to = day(f.to, true); }
    if (+f.source) { where.push("p.source_id = @source"); a.source = +f.source; }
    if (f.topic) { where.push("p.topics_json LIKE @topic"); a.topic = `%${String(f.topic).replace(/[%_"]/g, "")}%`; }
    if (f.verification && (VERIFY_LABELS[f.verification])) { if (f.verification === "pending") where.push("(p.verification = 'pending' OR p.analysis_status IN ('pending','analysing','verifying'))"); else { where.push("p.verification = @verification"); a.verification = f.verification; } }
    if (f.status && ["pending", "analysing", "verifying", "done", "skipped", "failed"].includes(f.status)) { where.push("p.analysis_status = @status"); a.status = f.status; }
    if (f.review === "1") where.push("p.needs_review = 1");
    if (f.q) { where.push("p.message LIKE @q"); a.q = `%${String(f.q).slice(0, 100).replace(/[%_]/g, "")}%`; }
    const top = "(SELECT CASE MAX(CASE priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) WHEN 3 THEN 'high' WHEN 2 THEN 'medium' WHEN 1 THEN 'low' END FROM live_alerts la WHERE la.post_id = p.id AND la.status != 'dismissed')";
    if (["low", "medium", "high"].includes(f.priority)) { where.push(`${top} = @priority`); a.priority = f.priority; }
    const sql = `FROM social_posts p JOIN social_sources s ON s.id = p.source_id WHERE ${where.join(" AND ")}`;
    return { total: db.prepare(`SELECT COUNT(*) n ${sql}`).get(a).n, posts: db.prepare(`SELECT p.*, s.name source_name, ${top} top_alert ${sql} ORDER BY p.created_time DESC LIMIT @limit OFFSET @offset`).all(a).map(postSummary),
      topics: Object.values(THEMES).map(t => t[0]), verification_labels: VERIFY_LABELS };
  }
  function post(id) {
    const p = db.prepare("SELECT p.*, s.name source_name, s.external_id, s.platform src_platform FROM social_posts p JOIN social_sources s ON s.id = p.source_id WHERE p.id = ?").get(id); if (!p) throw new HttpError(404, "No such post.");
    const inv = p.investigation_id ? db.prepare("SELECT id, report_id, status, overall, completed_at, reviewed_at, approved_at, error FROM investigations WHERE id = ?").get(p.investigation_id) : null;
    return { post: postSummary(p), analysis: J(p.analysis_json), confidence: J(p.confidence_json), confidence_criteria: CONFIDENCE_CRITERIA.map(([, points, rule]) => ({ points, rule })), confidence_scale: CONFIDENCE_LEVELS,
      attachments: J(p.attachments_json) || [], investigation: inv, metrics: db.prepare("SELECT at, likes, comments, shares FROM social_post_metrics WHERE post_id = ? ORDER BY id DESC LIMIT 50").all(p.id),
      alerts: db.prepare("SELECT * FROM live_alerts WHERE post_id = ? OR detail_json LIKE ? ORDER BY id DESC LIMIT 20").all(p.id, `%"posts":[%${p.id}%`).map(alertRow).filter(a => a.post_id === p.id || (a.detail.posts || []).includes(p.id)),
      watch_matches: db.prepare("SELECT w.id, w.name, m.detected_at, m.terms_json FROM watch_posts wp JOIN watch_matches m ON m.post_id = wp.id JOIN watchlists w ON w.id = m.watchlist_id WHERE wp.platform = ? AND wp.post_id = ?").all(p.platform === "instagram" ? "Instagram" : "Facebook", p.post_id).map(m => ({ ...m, terms: J(m.terms_json), terms_json: undefined })) };
  }
  function image(id) { const p = db.prepare("SELECT image_sha256, image_mime FROM social_posts WHERE id = ?").get(id); if (!p?.image_sha256) throw new HttpError(404, "No stored image for this post."); return { buf: storage.read(p.image_sha256), mime: p.image_mime || "image/jpeg" }; }
  function overview({ training = 0 } = {}) {
    const T = training ? 1 : 0, tok = svc.get("meta_token"), today = eatDayStart();
    const src = db.prepare("SELECT s.*, (SELECT COUNT(*) FROM social_posts p WHERE p.source_id = s.id) posts FROM social_sources s WHERE s.is_training = ? ORDER BY s.id").all(T);
    const fb = src.filter(s => s.platform === "facebook"), lastOk = fb.map(s => s.last_ok_at).filter(Boolean).sort().pop() || null;
    const conn = training ? { state: "training", label: "Training mode: practice posts only, no platform connection" } : !graph.configured() ? { state: "not_configured", label: "Not configured: META_PAGE_ACCESS_TOKEN is not set" }
      : tok?.state === "invalid" ? { state: "token_refused", label: "Token refused by Meta: collection stopped" } : tok?.state === "not_permitted" ? { state: "not_permitted", label: "Permission missing: collection stopped" }
      : !fb.length ? { state: "no_sources", label: "Connected, but no Page is configured (META_PAGE_IDS)" } : fb.some(s => s.last_ok_at) && tok?.state === "valid" ? { state: "connected", label: "Connected" }
      : tok?.state === "unreachable" ? { state: "unreachable", label: "Meta could not be reached" } : fb.some(s => s.last_ok_at) ? { state: "connected", label: "Connected (token not checked yet)" } : { state: "not_tested", label: "Configured, not yet synchronised" };
    const n = (sql, ...a) => db.prepare(sql).get(...a).n;
    const activeW = db.prepare("SELECT definition_json FROM watchlists WHERE status = 'active' AND deleted_at IS NULL").all();
    return {
      facebook: { configured: graph.configured(), connection: conn, token: tok ? { state: tok.state, page: tok.subject_name || null, page_id: tok.subject_id || null, expires_at: tok.expires_at || null, expiry_known: !!tok.expiry_known, expiry_note: tok.expiry_note || null, checked_at: tok.checked_at, error: tok.error || null } : null,
        last_successful_sync: lastOk, graph_version: L.graphVersion, interval_minutes: L.intervalMinutes },
      instagram: instagramStatus(),
      scheduler: { enabled: L.enabled, running: !!timer, tick_seconds: L.tickSeconds, interval_minutes: L.intervalMinutes, auto_analyse: L.autoAnalyse, note: "Collection and analysis run inside the AIVS server; the dashboard does not need to be open, but the AIVS server must be running." },
      counts: {
        total_posts: n("SELECT COUNT(*) n FROM social_posts WHERE is_training = ?", T), posts_today: n("SELECT COUNT(*) n FROM social_posts WHERE is_training = ? AND collected_at >= ?", T, today),
        published_today: n("SELECT COUNT(*) n FROM social_posts WHERE is_training = ? AND created_time >= ?", T, today),
        awaiting_analysis: n("SELECT COUNT(*) n FROM social_posts WHERE is_training = ? AND analysis_status IN ('pending','analysing','verifying')", T), completed_analyses: n("SELECT COUNT(*) n FROM social_posts WHERE is_training = ? AND analysis_status IN ('done','skipped')", T),
        failed_analyses: n("SELECT COUNT(*) n FROM social_posts WHERE is_training = ? AND analysis_status = 'failed'", T), needs_review: n("SELECT COUNT(*) n FROM social_posts WHERE is_training = ? AND needs_review = 1", T),
        active_watchlists: activeW.length, live_watchlists: activeW.filter(w => (J(w.definition_json)?.sources || []).includes("fb_live")).length,
        new_alerts: n("SELECT COUNT(*) n FROM live_alerts WHERE is_training = ? AND status = 'new'", T) + (T ? 0 : n("SELECT COUNT(*) n FROM watch_alerts a JOIN watchlists w ON w.id = a.watchlist_id WHERE a.status = 'new' AND w.deleted_at IS NULL")),
        new_live_alerts: n("SELECT COUNT(*) n FROM live_alerts WHERE is_training = ? AND status = 'new'", T),
        pending_investigations: n("SELECT COUNT(*) n FROM investigations WHERE is_training = ? AND status IN ('queued','running')", T), completed_reports: n("SELECT COUNT(*) n FROM investigations WHERE is_training = ? AND status = 'done'", T),
        reviewed_reports: n("SELECT COUNT(*) n FROM investigations WHERE is_training = ? AND reviewed_at IS NOT NULL", T) },
      by_verification: Object.fromEntries(db.prepare("SELECT coalesce(verification,'pending') v, COUNT(*) n FROM social_posts WHERE is_training = ? GROUP BY v").all(T).map(r => [r.v, r.n])),
      sources: src.map(s => ({ id: s.id, platform: s.platform, external_id: s.external_id, name: s.name, enabled: !!s.enabled, origin: s.origin, status: s.status, last_sync_at: s.last_sync_at, last_ok_at: s.last_ok_at, next_sync_at: s.next_sync_at,
        failures: s.failures, last_error: s.last_error, checkpoint_time: s.checkpoint_time, fields_level: s.fields_level, posts: s.posts })),
      recent_syncs: db.prepare("SELECT y.*, s.name source_name FROM social_syncs y JOIN social_sources s ON s.id = y.source_id WHERE s.is_training = ? ORDER BY y.id DESC LIMIT 10").all(T),
      recent_errors: T ? [] : db.prepare("SELECT * FROM social_api_errors ORDER BY id DESC LIMIT 5").all(),
      recent_posts: posts({ training: T, limit: 8 }).posts, verification_labels: VERIFY_LABELS
    };
  }
  function syncs({ source = null, limit = 50 } = {}) { return db.prepare(`SELECT y.*, s.name source_name FROM social_syncs y JOIN social_sources s ON s.id = y.source_id ${+source ? "WHERE y.source_id = ?" : ""} ORDER BY y.id DESC LIMIT ?`).all(...(+source ? [+source] : []), Math.min(500, +limit || 50)); }
  function errors(limit = 50) { return db.prepare("SELECT e.*, s.name source_name FROM social_api_errors e LEFT JOIN social_sources s ON s.id = e.source_id ORDER BY e.id DESC LIMIT ?").all(Math.min(500, +limit || 50)); }
  // a post already collected, found by its link (Verify Information uses the stored record instead of fetching it again)
  function findByUrl(url) {
    const u = String(url || "").trim().replace(/[?#].*$/, ""); if (!/^https?:\/\//.test(u)) return null;
    return db.prepare("SELECT p.*, s.name source_name, s.external_id FROM social_posts p JOIN social_sources s ON s.id = p.source_id WHERE p.is_training = 0 AND (p.permalink_url = ? OR p.permalink_url LIKE ?) LIMIT 1").get(u, `${u}?%`) || null;
  }
  function prefetchedFor(p) {
    const plat = p.platform === "instagram" ? "Instagram" : "Facebook";
    return { platform: plat, url: p.permalink_url, account: p.source_name || p.external_id, publisher: p.source_name || null, author_basis: `the ${plat} Page that published the post (platform API)`, published_at: p.created_time,
      published_basis: `publication time from the ${plat} Graph API`, method: `${plat} Graph API record collected by live monitoring on ${p.collected_at}`, notes: [p.image_note].filter(Boolean) };
  }

  // ---------------------------------------------------------------- training fixtures (Training mode only, clearly labelled)
  async function loadPractice(user) {
    db.prepare("INSERT INTO social_sources(platform,external_id,name,is_training,origin,added_by,created_at,status) VALUES ('facebook','practice-page','PRACTICE Page (synthetic training data)',1,'training',?,?,'training') ON CONFLICT(platform, external_id, is_training) DO NOTHING").run(user.id, nowISO());
    const src = db.prepare("SELECT * FROM social_sources WHERE platform = 'facebook' AND external_id = 'practice-page' AND is_training = 1").get();
    const t = h => new Date(Date.now() - h * 3600e3).toISOString(), stamp = Date.now().toString(36);
    const rows = [
      { post_id: `practice-${stamp}-1`, message: "PRACTICE: The Ministry of Health confirmed 12 new cholera cases in Garissa County on 20 October 2026. Boil drinking water. #CholeraKE", created_time: t(5) },
      { post_id: `practice-${stamp}-2`, message: "PRACTICE: KDF recruitment is open. Applicants must pay KSh 2,000 to register through WhatsApp before Friday. Share before it is deleted!", created_time: t(4) },
      { post_id: `practice-${stamp}-3`, message: "PRACTICE: KDF recruitment is open. Applicants must pay KSh 2,000 to register through WhatsApp before Friday. Share now!", created_time: t(3) },
      { post_id: `practice-${stamp}-4`, message: "PRACTICE: Floods have cut the road between Garissa and Dadaab; travellers are advised to wait for updates from the county.", created_time: t(2), local_image: "training/images/archive_convoy.jpg" },
      { post_id: `practice-${stamp}-5`, message: "PRACTICE: We thank everyone who joined the community clean-up in Lamu this weekend.", created_time: t(1) }];
    const res = store(src, rows.map(r => ({ ...r, updated_time: null, permalink_url: null, image_url: r.local_image ? `practice-fixture://${path.basename(r.local_image)}` : null, images: [], likes: null, comments: null, shares: null })), "practice fixture without engagement counts");
    for (const p of res.fresh) { const r = rows.find(x => x.post_id === p.post_id); if (r?.local_image) await storeImage(p, { localFile: path.resolve(r.local_image) }); }
    db.prepare("UPDATE social_sources SET last_ok_at = ?, last_sync_at = ?, checkpoint_time = ? WHERE id = ?").run(nowISO(), nowISO(), rows[rows.length - 1].created_time, src.id);
    db.prepare("INSERT INTO social_syncs(source_id,kind,started_at,finished_at,status,fetched,new_posts,duplicates,note) VALUES (?,?,?,?,?,?,?,?,?)").run(src.id, "training", nowISO(), nowISO(), "ok", rows.length, res.new_posts, res.duplicates, "PRACTICE fixtures loaded in Training mode; nothing was collected from a platform");
    audit(user, "Practice posts loaded for live monitoring (Training mode)", "social_source", String(src.id), { posts: res.new_posts });
    afterCollect(getSource(src.id), res.fresh);
    return { source_id: src.id, new_posts: res.new_posts };
  }

  return { start, stop, tick, sync, work, refreshEngagement, checkToken, addSource, setEnabled, ensureSources, overview, posts, post, image, alerts, alert, act, syncs, errors, findByUrl, prefetchedFor,
    loadPractice, testInstagram, instagramStatus, checks: id => { const src = getSource(id); return { frequency: frequencyCheck(src), topics: emergingTopics(src.is_training) }; }, configured: () => graph.configured(), ready: () => graph.configured() && svc.get("meta_token")?.state !== "invalid", systemUser, raise, PRIORITY_RULES };
}

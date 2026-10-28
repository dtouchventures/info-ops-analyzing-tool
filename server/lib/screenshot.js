// AIVS 1.34: fully automated analysis of a social media screenshot.
//
//   upload -> format check -> OCR with line layout -> platform cues -> main post separated from comments, ads and interface
//   text -> structured record (every field says whether it was OBSERVED in the picture, INFERRED by AIVS, or NOT AVAILABLE)
//   -> Social Media Analysis fields populated -> visible link tried through permitted methods -> automatic investigation
//   (claims, evidence, verdicts, KDF IO assessment, one-page draft, automatic HOD submission).
//
// Rules kept here:
//   * Nothing missing is invented: an account, date, place, engagement figure or link that is not readable is "Not available".
//   * The screenshot is never treated as proof of the post, and nothing read from it is ever recorded as evidence.
//   * The text model (qwen3:4b-instruct) is never sent images. A picture is read by OCR (Tesseract, on this server); an
//     image model is used only when one is configured AND its server reports the "vision" capability.
//   * No permission, consent or API authorisation is invented: the basis recorded is that the analyst submitted the picture.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { createRequire } from "node:module";
import { nowISO, nextId } from "./db.js";
import { HttpError } from "./auth.js";
import { safeRm } from "./storage.js";
import { extractEntities, extractHashtags, extractLinks, findPostTime, redFlags, topicOf, TOPICS, parseSourceLink } from "../../shared/text.js";

const require = createRequire(import.meta.url);
export const SCREENSHOT_STAGES = [["detect", "Image checked and platform cues detected"], ["ocr", "Text read (OCR with line layout)"], ["identify", "Main post identified"],
  ["populate", "Analysis fields populated"], ["original", "Original post looked up (visible link)"], ["vision", "Image-model capability checked"], ["investigate", "Automatic investigation started"]];
export const MAX_SCREENSHOT_MB = 25;
const MAX_PIXELS = 60e6, MAX_HEIGHT = 16000;
const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const NA = "Not available";

// ---------------------------------------------------------------- format (by content, never by the file name)
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}
const describeFormat = buf => !buf?.length ? "an empty file" : buf.toString("latin1", 0, 3) === "GIF" ? "a GIF image" : buf.toString("latin1", 0, 4) === "%PDF" ? "a PDF document"
  : buf.toString("latin1", 4, 12).startsWith("ftyp") ? "a HEIC image or a video" : buf[0] === 0x42 && buf[1] === 0x4d ? "a BMP image" : "not a PNG, JPEG or WebP image";

// ---------------------------------------------------------------- line classification
const AUDIENCE = /^(public|friends|friends of friends|only me|custom|edited|umma|marafiki|🌐|🌍)$/i;
const REL = /^(\d{1,2}\s?(?:s|m|min|mins|h|hr|hrs|d|w|wk|y)|\d{1,2}\s+(?:seconds?|minutes?|mins?|hours?|days?|weeks?|months?|years?)\s+ago|just now|now|yesterday(?:\s+at\s+\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?)?|jana|saa\s+\d{1,2}\s+zilizopita|dakika\s+\d{1,2})$/i;
const ACTION_WORDS = new Set("like comment share reply repost send save quote retweet bookmark penda toa maoni shiriki jibu tuma".split(" "));
const SECTION = /^(most relevant|all comments|top comments|newest|most recent|relevant comments|write a comment.*|post your reply.*|add a comment.*|reply to .*|view more comments|view \d+ more repl(y|ies))$/i;
const UI = /^(follow|following|see more|see translation|translate|more|…|\.\.\.|see original|hide|report|message|joined .*)$/i;
const AD = /^(sponsored|promoted|paid partnership(?: with .*)?|ad|tangazo)$/i;
const METRIC = /(\d[\d.,]*\s*[KMB]?)\s*(reactions?|likes?|comments?|shares?|reposts?|retweets?|quotes?|views?|bookmarks?|replies|maoni|kushiriki)\b/gi;
const LIKED_BY = /^liked by (.+?) and ([\d.,]+\s*[KMB]?) others?$/i;
const VIEW_ALL = /^view all ([\d.,]+\s*[KMB]?) comments?$/i;
const HANDLE = /@([A-Za-z0-9_]+(?: _[A-Za-z0-9_]+)*)/;
const KDF_TERMS = /\b(KDF|Kenya Defen[cs]e Forces?|Kenya Army|Kenya Navy|Kenya Air Force|Ministry of Defen[cs]e|MoD|soldiers?|troops|military|barracks|army|recruits?|recruitment|wanajeshi|jeshi)\b/gi;

const clean = s => String(s || "").replace(/[​‎‏]/g, "").replace(/^[^\p{L}\p{N}@#"“'‘]+/u, "").replace(/\s+/g, " ").trim();
const normMeta = s => s.replace(/\s[-–•]\s/g, " · ").replace(/\s*·\s*/g, " · ");
const okTok = t => /^(https?:\/\/|www\.|[#@])/i.test(t) || /^[\d.,:%]+[KMB]?$/i.test(t) || ((t.match(/\p{L}/gu) || []).length >= 2 && /[aeiouy_]/i.test(t));
const wordy = s => { const t = s.split(/\s+/).filter(Boolean); return t.length ? t.filter(okTok).length / t.length : 0; };
const isAction = s => { const w = s.toLowerCase().split(/[\s·|]+/).filter(Boolean); return w.length >= 2 && w.every(x => ACTION_WORDS.has(x)) && new Set(w).size >= 2; };
export function parseCount(raw) {
  const m = String(raw || "").replace(/\s/g, "").match(/^([\d.,]+)([KMB])?$/i); if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || "").toLowerCase()] || 1;
  const n = mult > 1 ? Number(m[1].replace(",", ".")) : Number(m[1].replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) ? { value: Math.round(n * mult), approximate: mult > 1 } : null;
}
function metricsOf(s) {
  const out = []; let m; METRIC.lastIndex = 0;
  while ((m = METRIC.exec(s))) { const c = parseCount(m[1]); if (c) out.push({ key: metricKey(m[2]), ...c, text: m[0].trim() }); }
  return out;
}
const metricKey = w => { w = w.toLowerCase(); return /^react/.test(w) ? "reactions" : /^like/.test(w) ? "likes" : /^(comment|maoni)/.test(w) ? "comments" : /^(share|kushiriki)/.test(w) ? "shares"
  : /^(repost|retweet)/.test(w) ? "reposts" : /^quote/.test(w) ? "quotes" : /^view/.test(w) ? "views" : /^bookmark/.test(w) ? "bookmarks" : "replies"; };
const isMetricLine = s => { const ms = metricsOf(s); if (!ms.length) return false; let rest = s; METRIC.lastIndex = 0; rest = rest.replace(METRIC, "").replace(/[·|,\s-]/g, ""); return rest.replace(/[^\p{L}]/gu, "").length <= 3; };

// a time line: "2h · Public", "3 hours ago", "12:45 PM · Oct 27, 2026 · 3,456 Views", "21 October 2026 at 15:45"
function timeOf(s) {
  const t = normMeta(s), parts = t.split(" · ").map(x => x.trim()).filter(Boolean);
  if (!parts.length || t.length > 70 || /[.!?]$/.test(t.replace(/\.\.\.$/, ""))) return null;
  const rest = parts.slice(1).filter(p => !AUDIENCE.test(p) && !isMetricLine(p));
  const short = parts[0].match(/^(\S{1,3})\s+(public|friends)$/i);   // "1d Public" (separator lost by OCR)
  if (short) return REL.test(short[1]) ? { text: `${short[1]} · ${short[2]}`, relative: short[1] } : { text: t, unreadable: short[1] };
  if (REL.test(parts[0]) && !rest.length) return { text: t, relative: parts[0] };
  const abs = findPostTime(parts.slice(0, 3).join(" · ")), absHead = /^(\d{1,2}:\d{2}\s*[ap]\.?m\.?|\d{1,2}\s+[A-Za-z]{3,9}|[A-Za-z]{3,9}\.?\s+\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|yesterday|jana)/i.test(parts[0]);
  if (abs && absHead) return { text: t, absolute: abs, views: parts.filter(isMetricLine).flatMap(metricsOf) };
  // the time itself was not read reliably, but the line has the shape of one ("Sh · Public": OCR misread "5h")
  if (parts.length >= 2 && parts[0].length <= 3 && parts.slice(1).every(p => AUDIENCE.test(p))) return { text: t, unreadable: parts[0] };
  return null;
}
const nameLike = s => s.length <= 50 && s.split(" ").length <= 6 && /\p{L}/u.test(s) && (!/[.!?:;,]$/.test(s) || /(^|\s)\p{Lu}\.$/u.test(s)) && !/[!?#"“”]|https?:\/\/|\.\s+\p{Ll}/u.test(s);

// "Name @handle · 1h" (X header or reply), "@handle · 3h", "@handle"
function handleLine(n) {
  const h = n.match(HANDLE); if (!h) return null;
  const handle = `@${h[1].replace(/\s+/g, "")}`, before = n.slice(0, h.index).replace(/[·\s]+$/, "").trim(), after = n.slice(h.index + h[0].length).replace(/^[\s·]+/, "").trim();
  const tAfter = after ? timeOf(after) : null;
  return (!after || tAfter) && (!before || nameLike(before)) ? { type: "handle", handle, name: before || null, time: tAfter || null } : null;
}
export function classifyLines(lines, mediaRegions = []) {
  const inMedia = b => b && mediaRegions.some(r => { const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2; return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1; });
  return lines.map(l => {
    const text = clean(l.text), n = normMeta(text), conf = l.conf ?? 100, base = { text, conf, bbox: l.bbox || null };
    if (!text) return { ...base, type: "noise", why: "empty" };
    // lines with the exact shape of a time, a handle or "account Follow" are kept even when the characters are faint
    const tm0 = conf >= 35 ? timeOf(n) : null; if (tm0 && conf < 75) return { ...base, type: "time", time: tm0 };
    const hd0 = conf >= 35 && conf < 75 ? handleLine(n) : null; if (hd0) return { ...base, ...hd0 };
    const fo0 = n.match(/^([\p{L}\p{N}_.]{3,40})\s*(?:·\s*)?(follow|following)$/iu); if (fo0 && conf >= 35 && conf < 75) return { ...base, type: "name", name: fo0[1], follow: true };
    if (conf < 45 || (conf < 75 && wordy(text) < 0.5) || (inMedia(l.bbox) && conf < 85)) return { ...base, type: "noise", why: inMedia(l.bbox) ? "text inside a picture region" : "low-confidence characters" };
    if (isAction(n)) return { ...base, type: "action" };
    let m;
    if ((m = n.match(LIKED_BY))) { const c = parseCount(m[2]); return { ...base, type: "metric", metrics: c ? [{ key: "likes", value: c.value + 1, approximate: c.approximate, lower_bound: true, text }] : [] }; }
    if ((m = n.match(VIEW_ALL))) { const c = parseCount(m[1]); return { ...base, type: "metric", metrics: c ? [{ key: "comments", ...c, text }] : [] }; }
    if (isMetricLine(n)) return { ...base, type: "metric", metrics: metricsOf(n) };
    if (SECTION.test(n)) return { ...base, type: "section" };
    if (AD.test(n)) return { ...base, type: "ad" };
    const tm = timeOf(n); if (tm) return { ...base, type: "time", time: tm };
    { const hd = handleLine(n); if (hd) return { ...base, ...hd }; }
    if (UI.test(n)) return { ...base, type: "ui" };
    const follow = n.match(/^(.+?)\s*(?:·\s*)?(follow|following)$/i);
    if (follow && nameLike(follow[1])) return { ...base, type: "name", name: follow[1].trim(), follow: true };
    if (nameLike(n) && wordy(n) >= 0.5) return { ...base, type: "name", name: n.replace(/\s*[✓✔☑️]+$/u, "").trim() };
    return { ...base, type: "text" };
  });
}

// ---------------------------------------------------------------- post segmentation
export function segmentPosts(L) {
  // headers: a name followed by a time, a handle or "Sponsored"; a handle line with a time; an account with "Follow"
  const headers = [];
  for (let i = 0; i < L.length; i++) {
    const a = L[i], b = L[i + 1], c = L[i + 2];
    if (a.type === "noise") continue;
    if (a.type === "name" && (a.follow || (b && ["time", "handle", "ad"].includes(b.type)))) {
      const h = { start: i, name: a.name, follow: !!a.follow, handle: null, time: null, ad: false }; let j = i + 1;
      while (j < L.length && j <= i + 2 && ["time", "handle", "ad"].includes(L[j].type)) { const x = L[j]; if (x.type === "handle") { h.handle = x.handle; if (x.time) h.time = x.time; } if (x.type === "time" && !h.time) h.time = x.time; if (x.type === "ad") h.ad = true; j++; }
      if (!h.handle && !h.time && !h.ad && !h.follow) continue;
      h.end = j; headers.push(h); i = j - 1;
    } else if (a.type === "handle" && (a.time || a.name)) { headers.push({ start: i, end: i + 1, name: a.name, handle: a.handle, time: a.time, ad: false }); }
    void c;
  }
  const segs = [];
  if (!headers.length || headers[0].start > 0) { const end = headers.length ? headers[0].start : L.length; if (L.slice(0, end).some(x => ["text", "metric", "action"].includes(x.type))) segs.push({ header: null, from: 0, to: end }); }
  headers.forEach((h, k) => segs.push({ header: h, from: h.start, to: k + 1 < headers.length ? headers[k + 1].start : L.length }));
  const posts = [];
  for (const s of segs) {
    const lines = L.slice(s.header ? s.header.end : s.from, s.to);
    const actionAt = lines.findIndex(x => x.type === "action"), sectionAt = lines.findIndex(x => x.type === "section" && /^(most relevant|all comments|top comments|newest|most recent|relevant comments)$/i.test(x.text));
    const cut = [actionAt, sectionAt].filter(x => x >= 0); const boundary = cut.length ? Math.min(...cut) + (actionAt >= 0 && actionAt === Math.min(...cut) ? 1 : 0) : lines.length;
    const postLines = lines.slice(0, boundary), after = lines.slice(boundary);
    const isAd = !!s.header?.ad || postLines.some(x => x.type === "ad");
    const hasPostSignals = actionAt >= 0 || postLines.some(x => x.type === "metric") || isAd;
    if (posts.length && !hasPostSignals) { posts[posts.length - 1].comments.push(...commentsOf([...(s.header ? L.slice(s.header.start, s.header.end) : []), ...lines], s.header)); continue; }
    posts.push({ header: s.header, isAd, lines: postLines, comments: commentsOf(after, null), top: (L[s.from]?.bbox?.y0 ?? null), bottom: (L[s.to - 1]?.bbox?.y1 ?? null) });
  }
  return posts;
}
function commentsOf(lines, header) {
  const out = []; let cur = header ? { author: header.handle ? `${header.name ? `${header.name} ` : ""}${header.handle}` : header.name, time: header.time?.text || null, text: [] } : null;
  for (const x of lines) {
    if (header && x.start === undefined && (x.type === "handle" || x.type === "name") && cur && !cur.text.length && (x.handle === header.handle || x.name === header.name)) continue;
    if (x.type === "name" || x.type === "handle") { if (cur && (cur.text.length || cur.author)) out.push(cur); cur = { author: x.handle ? `${x.name ? `${x.name} ` : ""}${x.handle}` : x.name, time: x.time?.text || null, text: [] }; }
    else if (x.type === "text") { if (!cur) cur = { author: null, time: null, text: [] }; cur.text.push(x.text); }
    else if (x.type === "time" && cur && !cur.time) cur.time = x.time.text;
  }
  if (cur && (cur.text.length || cur.author)) out.push(cur);
  return out.filter(c => c.text.length).map(c => ({ author: c.author || null, time: c.time, text: c.text.join(" ") }));
}

// ---------------------------------------------------------------- platform cues (always "apparent": a picture can imitate any layout)
export function platformCues(L, header) {
  const all = L.filter(x => x.type !== "noise").map(x => normMeta(x.text)).join("\n"), low = all.toLowerCase(), score = {}, cues = {};
  const add = (p, w, cue) => { score[p] = (score[p] || 0) + w; (cues[p] = cues[p] || []).push(cue); };
  if (/\b\d[\d.,]*\s*[kmb]?\s*reposts?\b/i.test(all)) add("X (Twitter)", 2, "“Reposts” count");
  if (/\bquotes?\b/i.test(all) && /\breposts?\b/i.test(all)) add("X (Twitter)", 1, "“Quotes” count");
  if (/\bbookmarks?\b/i.test(all)) add("X (Twitter)", 1, "“Bookmarks” count");
  if (/^reply\s+repost\b/im.test(all)) add("X (Twitter)", 2, "Reply / Repost buttons");
  if (/\d{1,2}:\d{2}\s*[ap]m\s*·\s*[a-z]{3}\s+\d{1,2},\s*\d{4}/i.test(all)) add("X (Twitter)", 1, "time stamp “h:mm PM · Mon D, YYYY”");
  if (/post your reply/i.test(all)) add("X (Twitter)", 2, "“Post your reply”");
  if (header?.handle && header?.name) add("X (Twitter)", 1, "display name with @handle under it");
  if (/·\s*public\b|\b\d\w?\s+public\b/i.test(all)) add("Facebook", 2, "audience “Public” next to the time");
  if (/\breactions?\b/i.test(all)) add("Facebook", 1, "“reactions” count");
  if (/^like\s+comment\s+share$/im.test(all)) add("Facebook", 2, "Like / Comment / Share buttons");
  if (/most relevant|write a comment/i.test(all)) add("Facebook", 1, "“Most relevant” / “Write a comment”");
  if (/\bliked by\b/i.test(all)) add("Instagram", 2, "“Liked by … and N others”");
  if (/view all \d[\d.,]*\s*comments/i.test(all)) add("Instagram", 2, "“View all N comments”");
  if (/add a comment/i.test(all)) add("Instagram", 1, "“Add a comment…”");
  if (header?.follow) add("Instagram", 1, "“Follow” next to the account name");
  if (/\btiktok\b|for you\b.*following|following\b.*for you/i.test(all)) add("TikTok", 2, "TikTok interface words");
  if (/\bforwarded( many times)?\b/i.test(all)) add("WhatsApp", 2, "“Forwarded” label");
  if (/\bsubscribers\b/i.test(all) && /\bviews\b/i.test(all)) add("YouTube", 1, "subscribers and views");
  if (/\btelegram\b|\bjoin channel\b/i.test(low)) add("Telegram", 2, "Telegram interface words");
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 2) return { platform: null, confidence: null, cues: ranked.length ? cues[ranked[0][0]] : [], scores: score };
  const [p, s] = ranked[0], second = ranked[1]?.[1] || 0;
  return { platform: p, confidence: s >= 4 && s - second >= 2 ? "moderate" : "low", cues: cues[p], scores: score };
}

// ---------------------------------------------------------------- picture regions (photos, video frames) by local texture
export async function mediaRegions(file, textBoxes, { width, height }) {
  const W = Math.min(480, width), scale = W / width, H = Math.max(1, Math.round(height * scale)), T = 8;
  const { data } = await sharp(file, { limitInputPixels: MAX_PIXELS }).rotate().resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const cols = Math.floor(W / T), rows = Math.floor(H / T), busy = new Uint8Array(cols * rows), stats = new Float32Array(cols * rows * 2);
  const boxes = textBoxes.map(b => ({ x0: b.x0 * scale - 3, y0: b.y0 * scale - 3, x1: b.x1 * scale + 3, y1: b.y1 * scale + 3 }));
  // a picture differs from the page background (the most common tile brightness, so dark mode works too) or is textured
  const hist = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = c * T, y0 = r * T; let s = 0, s2 = 0;
    for (let y = y0; y < y0 + T; y++) for (let x = x0; x < x0 + T; x++) { const v = data[y * W + x]; s += v; s2 += v * v; }
    const n = T * T, mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean ** 2)); stats[(r * cols + c) * 2] = mean; stats[(r * cols + c) * 2 + 1] = sd;
    if (sd < 3) { const k = Math.round(mean / 8); hist.set(k, (hist.get(k) || 0) + 1); }
  }
  const bg = ([...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 31) * 8;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = c * T, y0 = r * T; if (boxes.some(b => x0 + T > b.x0 && x0 < b.x1 && y0 + T > b.y0 && y0 < b.y1)) continue;
    const mean = stats[(r * cols + c) * 2], sd = stats[(r * cols + c) * 2 + 1];
    if (Math.abs(mean - bg) > 22 || sd > 10) busy[r * cols + c] = 1;
  }
  const seen = new Uint8Array(cols * rows), out = [];
  for (let i = 0; i < busy.length; i++) {
    if (!busy[i] || seen[i]) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, count = 0; const st = [i]; seen[i] = 1;
    while (st.length) { const k = st.pop(), r = Math.floor(k / cols), c = k % cols; count++; x0 = Math.min(x0, c); x1 = Math.max(x1, c); y0 = Math.min(y0, r); y1 = Math.max(y1, r);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const rr = r + dr, cc = c + dc, kk = rr * cols + cc; if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && busy[kk] && !seen[kk]) { seen[kk] = 1; st.push(kk); } } }
    const bw = (x1 - x0 + 1) * T, bh = (y1 - y0 + 1) * T;
    if (bw >= W * 0.2 && bh >= Math.min(H * 0.08, 60) && count >= 0.5 * (x1 - x0 + 1) * (y1 - y0 + 1) && bw * bh >= W * H * 0.03)
      out.push({ x0: Math.round(x0 * T / scale), y0: Math.round(y0 * T / scale), x1: Math.round((x1 + 1) * T / scale), y1: Math.round((y1 + 1) * T / scale) });
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------- language, keywords, similarity
const STOP_EN = new Set("the a an and or of to in on for with at by from is are was were be been it this that these those as not no but if into their its our your his her they them we you he she i will would can could has have had do does did about after before over than then there here what which who whom how all any some more most other such only own same so too very just also now new".split(" "));
const STOP_SW = new Set("na ya wa za kwa la ni katika hii hiyo huu ili kama lakini pia sana wao yeye sisi wewe mimi kuwa kwamba hapa pale bado tena leo jana kesho watu kila hata baada kabla".split(" "));
export function language(text) {
  const w = String(text || "").toLowerCase().match(/\p{L}+/gu) || []; if (w.length < 4) return { code: null, label: NA, basis: "not_available", note: "too few words to judge" };
  const en = w.filter(x => STOP_EN.has(x)).length, sw = w.filter(x => STOP_SW.has(x)).length;
  if (!en && !sw) return { code: null, label: "Not determined", basis: "not_available", note: "no common English or Kiswahili words found" };
  if (en && sw && Math.min(en, sw) / Math.max(en, sw) > 0.35) return { code: "en+sw", label: "English and Kiswahili (mixed)", basis: "inferred", note: `common-word count: English ${en}, Kiswahili ${sw}` };
  return en >= sw ? { code: "en", label: "English", basis: "inferred", note: `common-word count: English ${en}, Kiswahili ${sw}` } : { code: "sw", label: "Kiswahili", basis: "inferred", note: `common-word count: English ${en}, Kiswahili ${sw}` };
}
function keywords(text, n = 8) {
  const f = new Map(); for (const w of String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/[\p{L}][\p{L}'-]{2,}/gu) || []) if (!STOP_EN.has(w) && !STOP_SW.has(w) && !["test", "fixture"].includes(w)) f.set(w, (f.get(w) || 0) + 1);
  return [...f.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
}
const grams = s => { const t = String(s || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim(), g = new Set(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; };
export function similarity(a, b) { const A = grams(a), B = grams(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); }
const sentences = t => String(t || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9“"])/).map(s => s.trim()).filter(Boolean);
const field = (value, basis, note = null) => ({ value: value == null || value === "" ? null : value, basis: value == null || value === "" ? "not_available" : basis, ...(note ? { note } : {}) });
const eat = iso => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().replace("T", " ").slice(0, 16) + " EAT";

// ---------------------------------------------------------------- reading one screenshot (pure: OCR layout in, structured record out)
export function extractPost({ lines, regions = [], width, height }) {
  const L = classifyLines(lines, regions), posts = segmentPosts(L);
  const mainIdx = Math.max(0, posts.findIndex(p => !p.isAd)), main = posts[mainIdx] || { header: null, lines: L.filter(x => x.type !== "noise"), comments: [], isAd: false };
  const plat = platformCues(L, main.header);
  // the main post's own text: text lines of its region; on Instagram the caption starts with the account name, which is removed
  let body = main.lines.filter(x => x.type === "text" || (x.type === "name" && !x.follow)).map(x => x.text);
  const acctNorm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const hdrName = main.header?.name || null, hdrHandle = main.header?.handle || null;
  if (body.length && (hdrName || hdrHandle)) {
    const target = acctNorm(hdrHandle || hdrName), toks = body[0].split(" "); let acc = "";
    for (let k = 0; k < Math.min(toks.length, 5); k++) { acc += acctNorm(toks[k]); if (acc === target && k < toks.length - 1) { body[0] = toks.slice(k + 1).join(" "); break; } if (!target.startsWith(acc)) break; }
  }
  const text = body.join(" ").replace(/\s+/g, " ").trim();
  // time: the header's, otherwise the first time line in the post's own region
  const tm = main.header?.time || main.lines.find(x => x.type === "time")?.time || null;
  const metrics = {}; for (const x of main.lines.filter(x => x.type === "metric")) for (const m of x.metrics) if (!(m.key in metrics)) metrics[m.key] = m;
  for (const v of tm?.views || []) if (!(v.key in metrics)) metrics[v.key] = v;
  const regionsOf = p => regions.filter(r => p.top == null || ((r.y0 + r.y1) / 2 >= p.top && (r.y0 + r.y1) / 2 <= (p.bottom ?? Infinity)));
  const mainMedia = posts.length > 1 ? regionsOf(main) : regions;
  let published = null;
  if (tm?.absolute?.at && tm.absolute.exact !== false) {
    // shown as a local clock time without a time zone: read as East Africa Time (the analyst's display time zone)
    const d = tm.absolute.at, iso = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) - 3 * 3600e3).toISOString();
    published = field(iso, "observed", `date and time shown on the post (“${tm.text}”); no time zone is shown, so it is read as East Africa Time`);
  } else if (tm?.absolute?.at) published = field(new Date(tm.absolute.at).toISOString().slice(0, 10), "observed", `date shown on the post (“${tm.text}”), no time shown`);
  const account = hdrHandle ? `${hdrName ? `${hdrName} ` : ""}(${hdrHandle})`.replace(/^\((.+)\)$/, "$1") : hdrName;
  const hashtags = extractHashtags(text), mentions = [...new Set((text.match(/(^|[^\w@])@([A-Za-z0-9_]{2,30})\b/g) || []).map(m => m.trim().replace(/^[^@]+/, "")))], urls = extractLinks(text);
  const ent = extractEntities(text), flags = redFlags(text), topic = topicOf(flags), kdf = [...new Map((text.match(KDF_TERMS) || []).map(x => [x.trim().toLowerCase(), x.trim()])).values()];
  const central = sentences(text.replace(/^TEST FIXTURE:\s*/i, "")).find(s => s.split(" ").length >= 5) || text.slice(0, 240) || null;
  const lang = language(text);
  const conf = lines.length ? Math.round(lines.reduce((a, l) => a + (l.conf || 0), 0) / lines.length) : 0;
  const uncertainties = [];
  if (!text) uncertainties.push("No readable post text was found in the screenshot.");
  if (!plat.platform) uncertainties.push("The platform could not be identified from the layout.");
  else uncertainties.push(`The platform (${plat.platform}) is inferred from the layout only; a picture can imitate any platform.`);
  if (!account) uncertainties.push("No account or page name is visible.");
  if (!tm) uncertainties.push("No publication date or time is visible.");
  else if (tm.unreadable) uncertainties.push(`The time shown (“${tm.text}”) could not be read reliably (OCR read “${tm.unreadable}”).`);
  else if (tm.relative) uncertainties.push(`Only a relative time (“${tm.relative}”) is shown; the publication date cannot be fixed because the time the screenshot was taken is unknown.`);
  if (L.some(x => x.type === "noise" && x.why === "low-confidence characters" && x.text.length > 3)) uncertainties.push("Some areas could not be read reliably (low OCR confidence) and were left out.");
  if (posts.length > 1) uncertainties.push(`The screenshot shows ${posts.length} posts; only the main post (the first that is not an advertisement) is analysed.`);
  if (Object.values(metrics).some(m => m.approximate)) uncertainties.push("Some engagement figures are abbreviated (for example 1.2K) and are therefore approximate.");
  if (!urls.length) uncertainties.push("No link to the original post is visible.");
  uncertainties.push("A screenshot is not proof that the post exists or was published as shown; it may be edited or fabricated.");
  const notShown = [!account && "account", !tm && "date/time", !Object.keys(metrics).length && "engagement figures", !urls.length && "link to the original", !mainMedia.length && "embedded picture"].filter(Boolean);

  return {
    width, height, ocr_confidence: conf, lines: L.map(x => ({ text: x.text, conf: x.conf, type: x.type, ...(x.why ? { why: x.why } : {}) })),
    platform: field(plat.platform, "inferred", plat.platform ? `layout cues: ${plat.cues.join("; ")} (confidence ${plat.confidence})` : plat.cues.length ? `too few cues (${plat.cues.join("; ")})` : "no platform-specific interface text was found"),
    platform_cues: plat.cues, platform_scores: plat.scores,
    account: field(account, "observed", account ? `name shown above the post${hdrHandle ? " with its handle" : ""}` : null),
    display_name: field(hdrName, "observed"), handle: field(hdrHandle, "observed"),
    posted_text: field(tm?.text || null, "observed", tm?.relative ? "relative time: counted from when the screenshot was taken, which is unknown" : tm?.unreadable ? "the time was not read reliably" : null),
    published_at: published || field(null, "not_available", tm ? "only a relative or unreadable time is shown" : "no date or time is visible"),
    text: field(text || null, "observed", text ? `read by OCR (average confidence ${conf} of 100)` : null),
    central_narrative: field(central, "inferred", central ? "first complete statement of the main post" : null),
    hashtags: field(hashtags.length ? hashtags : null, "observed"), mentions: field(mentions.length ? mentions : null, "observed"), urls: field(urls.length ? urls : null, "observed"),
    engagement: Object.fromEntries(["reactions", "likes", "comments", "shares", "reposts", "quotes", "views", "bookmarks"].map(k => [k, metrics[k] ? field(metrics[k].value, metrics[k].lower_bound ? "inferred" : "observed", `${metrics[k].text}${metrics[k].approximate ? " (abbreviated, approximate)" : ""}${metrics[k].lower_bound ? " (named account plus the count of others)" : ""}`) : field(null, "not_available")])),
    language: field(lang.label === NA ? null : lang.label, lang.basis, lang.note), language_code: lang.code,
    media: { count: mainMedia.length, regions: mainMedia, basis: mainMedia.length ? "observed" : "not_available", note: mainMedia.length ? "picture region(s) found by image texture; their content is not described by OCR" : "no picture region found in the main post" },
    entities: { places: ent.locations, organisations: ent.orgs, dates: ent.dates.map(d => d.text), numbers: ent.numbers, basis: "inferred" },
    keywords: keywords(text), topic: topic ? { key: topic, label: TOPICS[topic] } : null, flags: flags.map(f => f.text),
    kdf_relevance: { relevant: kdf.length > 0, terms: kdf, basis: "inferred", note: kdf.length ? `mentions ${kdf.join(", ")}` : "no KDF, defence or military term found" },
    posts: posts.map((p, k) => ({ index: k + 1, main: k === mainIdx, advertisement: p.isAd, account: p.header ? (p.header.handle ? `${p.header.name ? `${p.header.name} ` : ""}${p.header.handle}` : p.header.name) : null, time: (p.header?.time || p.lines.find(x => x.type === "time")?.time)?.text || null,
      text: p.lines.filter(x => x.type === "text").map(x => x.text).join(" ").slice(0, 400), comments: p.comments.length })),
    multiple_posts: posts.length > 1, advertisements_excluded: posts.filter(p => p.isAd).length, comments_excluded: posts.reduce((a, p) => a + p.comments.length, 0),
    comments: main.comments.slice(0, 20), interface_text_excluded: L.filter(x => ["action", "section", "ui", "ad"].includes(x.type)).map(x => x.text).slice(0, 30),
    uncertainties, not_shown: notShown
  };
}

// ---------------------------------------------------------------- the form of Social Media Analysis, populated from the record
export function populateForm(x, { user, file, sha256, uploadedAt }) {
  const plat = x.platform.value, topicLabel = x.topic?.label || (x.kdf_relevance.relevant ? "KDF-related claim" : "Public claim");
  const when = x.published_at.value ? `posted ${String(x.published_at.value).slice(0, 10)}` : `uploaded ${eat(uploadedAt).slice(0, 10)}`;
  const name = `${topicLabel} — ${plat ? `${plat.replace(/ \(Twitter\)/, "")} screenshot` : "Screenshot (platform not identified)"} — ${when}`;
  const source = [`Screenshot submitted by ${user.display_name || user.username || "the analyst"} on ${eat(uploadedAt)} (file “${String(file || "screenshot").slice(0, 80)}”, SHA-256 ${sha256.slice(0, 16)}…)`,
    plat ? `apparent platform: ${plat} (inferred from the layout)` : "platform not identified", x.account.value ? `account shown: ${x.account.value}` : "account not visible",
    x.urls.value ? `link visible in the post: ${x.urls.value[0]}` : null].filter(Boolean).join("; ");
  const authorisation = "Submitted by the analyst for analysis in AIVS. No platform API access, permission or consent is recorded for this content.";
  const c = x.central_narrative.value;
  const rq = c ? `Is the claim that ${c.replace(/[.!?]+$/, "").replace(/^[A-Z](?=[a-z])/, m => m.toLowerCase())} accurate, and how is it presented to the public?` : null;
  const observed = [x.account.value && `account ${x.account.value}`, x.posted_text.value && `time shown “${x.posted_text.value}”`, x.hashtags.value && `hashtags ${x.hashtags.value.join(" ")}`,
    x.mentions.value && `mentions ${x.mentions.value.join(" ")}`, ...Object.entries(x.engagement).filter(([, v]) => v.value != null).map(([k, v]) => `${k} ${/approximate/.test(v.note || "") ? "about " : ""}${v.value.toLocaleString("en-GB")}${v.basis === "inferred" ? " (inferred)" : ""}`),
    x.media.count ? `${x.media.count} picture region(s)` : null].filter(Boolean);
  const notes = [
    x.text.value ? `Content: ${x.text.value.slice(0, 600)}` : "Content: no readable post text.",
    `Observed in the screenshot: ${observed.length ? observed.join("; ") : "nothing beyond the text"}.`,
    `Inferred by AIVS: platform ${plat || "not identified"}; language ${x.language.value || "not determined"}${x.topic ? `; topic ${x.topic.label}` : ""}; KDF relevance ${x.kdf_relevance.relevant ? `yes (${x.kdf_relevance.terms.join(", ")})` : "not indicated"}.`,
    x.not_shown.length ? `Not available: ${x.not_shown.join(", ")}.` : null,
    x.multiple_posts ? `Excluded: ${x.posts.length - 1} other post(s)${x.advertisements_excluded ? `, including ${x.advertisements_excluded} advertisement(s)` : ""}, ${x.comments_excluded} comment(s) and the interface text.` : x.comments_excluded ? `Excluded: ${x.comments_excluded} comment(s) and the interface text.` : null,
    `Uncertainties: ${x.uncertainties.join(" ")}`
  ].filter(Boolean).join("\n");
  return {
    name: field(name.slice(0, 200), "generated", "from the topic, the apparent platform and the date"),
    source: field(source.slice(0, 500), "generated", "the screenshot, with the apparent platform and account where visible"),
    authorisation: field(authorisation, "generated", "the analyst submitted the screenshot; no other basis is assumed"),
    research_question: field(rq ? rq.slice(0, 1000) : null, "generated", rq ? "from the central narrative" : "no central statement could be identified"),
    description: field(notes.slice(0, 2000), "generated", "summary of content, metadata, uncertainties and what is missing"),
    collection_method: field("screenshot (automatic extraction)", "generated"),
    platform: x.platform, account: x.account, posted_at: x.published_at, language: x.language, url: field(x.urls.value?.[0] || null, "observed")
  };
}

// ---------------------------------------------------------------- the service
export function makeScreenshots(db, { config, storage, audit, investigations, io, social, fetchPage, notify = null }) {
  const row = id => db.prepare("SELECT * FROM screenshot_analyses WHERE id = ?").get(id);
  const parse = r => r && { ...r, stages: JSON.parse(r.stages_json), extraction: r.extraction_json ? JSON.parse(r.extraction_json) : null, form: r.form_json ? JSON.parse(r.form_json) : null,
    form_edits: r.form_edits_json ? JSON.parse(r.form_edits_json) : [], stages_json: undefined, extraction_json: undefined, form_json: undefined, form_edits_json: undefined };
  const setStage = (id, key, status, detail = null) => { const r = row(id); if (!r) return; const st = JSON.parse(r.stages_json).map(s => s.key === key ? { ...s, status, detail: detail ? String(detail).slice(0, 400) : null, at: nowISO() } : s);
    db.prepare("UPDATE screenshot_analyses SET stages_json = ?, stage = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(st), key, nowISO(), id); };
  const jobs = new Map();

  // what this server can actually do with images (checked, never assumed)
  let capCache = null;
  async function capabilities({ fresh = false } = {}) {
    if (!fresh && capCache && Date.now() - capCache.t < 10 * 60e3) return capCache.v;
    let ocr = { installed: false, engine: "Tesseract.js", languages: [] };
    try { require.resolve("tesseract.js"); ocr = { installed: true, engine: "Tesseract.js (on this server)", languages: ["eng", "swa"].filter(l => { try { require.resolve(`@tesseract.js-data/${l}/package.json`); return true; } catch { return false; } }) }; } catch (e) { ocr.error = e.message; }
    const vc = await investigations.visionCheck().catch(e => ({ supported: false, reason: e.message }));
    const textModel = config.ollama?.model || config.ai?.model || null, base = String(config.investigate?.visionBase || config.ollama?.url || config.ai?.baseUrl || "").replace(/\/+$/, "");
    const models = [];
    if (base && /^https?:\/\//.test(base)) {
      try {
        const tags = await getJson(`${base}/api/tags`, 8000);
        for (const m of (tags?.models || []).slice(0, 12)) {
          const nm = m.name || m.model; let caps = null;
          try { const j = await postJson(`${base}/api/show`, { model: nm }, 8000); caps = Array.isArray(j?.capabilities) ? j.capabilities : null; } catch {}
          models.push({ name: nm, capabilities: caps, vision: !!caps?.includes("vision") });
        }
      } catch (e) { models.push({ error: `the model list could not be read (${e.message})` }); }
    }
    const visionModel = config.investigate?.visionModel || null;
    const v = { ocr, text_model: { name: textModel, images: false, note: "the text model is never sent images; it receives only text read from the picture" },
      vision: { configured: visionModel, supported: !!vc?.supported && !!visionModel, reason: !visionModel ? "No image model is configured (INVESTIGATE_VISION_MODEL is not set). Screenshots are read by OCR only." : vc?.supported ? null : vc?.reason || "not supported",
        installed_vision_models: models.filter(m => m.vision).map(m => m.name) }, models };
    capCache = { t: Date.now(), v }; return v;
  }
  async function getJson(url, ms) { const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms); try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } catch (e) { throw new Error(e.name === "AbortError" ? `no answer within ${ms / 1000} s` : e.message); } finally { clearTimeout(t); } }
  async function postJson(url, body, ms) { const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms); try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } catch (e) { throw new Error(e.name === "AbortError" ? `no answer within ${ms / 1000} s` : e.message); } finally { clearTimeout(t); } }

  // ---- upload: checked synchronously (format, size, duplicate), analysed in the background
  async function submit(user, { file, isTraining = false, force = false }) {
    if (!file) throw new HttpError(400, "Choose a screenshot (PNG, JPEG or WebP).");
    let buf; try { buf = fs.readFileSync(file.path); } finally { safeRm(file.path, "upload"); }
    const fmt = sniffImage(buf);
    if (!fmt) throw new HttpError(415, `“${String(file.originalname || "file").slice(0, 80)}” is ${describeFormat(buf)}. Upload a screenshot saved as PNG, JPEG or WebP.`);
    if (buf.length > MAX_SCREENSHOT_MB * 1024 * 1024) throw new HttpError(413, `The screenshot is larger than ${MAX_SCREENSHOT_MB} MB. Save it again as JPEG or crop it to the post.`);
    let meta; try { meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata(); } catch (e) { throw new HttpError(422, /pixel limit/i.test(e.message) ? `The picture is too large (more than ${MAX_PIXELS / 1e6} million pixels). Crop it to the post.` : "The picture could not be decoded. It may be damaged or incomplete."); }
    if (!meta.width || !meta.height) throw new HttpError(422, "The picture could not be decoded. It may be damaged or incomplete.");
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const dup = db.prepare("SELECT id, status, investigation_id FROM screenshot_analyses WHERE sha256 = ? AND status != 'failed' ORDER BY created_at LIMIT 1").get(sha256);
    if (dup && !force) { audit(user, "Duplicate screenshot upload recognised", "screenshot", dup.id, { sha256 }); return { ...get(dup.id), duplicate: true }; }
    const stored = await storage.putBuffer(buf, MIME[fmt]);
    const id = nextId(db, "screenshot", n => `SA-${String(n).padStart(6, "0")}`), at = nowISO();
    db.prepare("INSERT INTO screenshot_analyses(id,sha256,mime,width,height,bytes,original_name,status,stage,stages_json,duplicate_of,is_training,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, stored.sha256, MIME[fmt], meta.width, meta.height, buf.length, String(file.originalname || `screenshot.${fmt}`).slice(0, 200), "queued", null,
        JSON.stringify(SCREENSHOT_STAGES.map(([key, label]) => ({ key, label, status: "pending", detail: null }))), dup ? dup.id : null, isTraining ? 1 : 0, user.id, at, at);
    audit(user, "Screenshot uploaded for automatic analysis", "screenshot", id, { sha256, bytes: buf.length, format: fmt, width: meta.width, height: meta.height, repeat_of: dup?.id || null });
    const p = run(id, user, { buf, fmt, meta }).catch(e => { console.error("screenshot analysis failed", id, e.message); fail(id, user, e.message); }).finally(() => jobs.delete(id));
    jobs.set(id, p);
    return get(id);
  }
  function fail(id, user, message) {
    const r = row(id); if (!r) return;
    const st = JSON.parse(r.stages_json).map(s => s.status === "running" ? { ...s, status: "failed", detail: String(message).slice(0, 300) } : s);
    db.prepare("UPDATE screenshot_analyses SET status = 'failed', error = ?, stages_json = ?, updated_at = ? WHERE id = ?").run(String(message).slice(0, 500), JSON.stringify(st), nowISO(), id);
    audit(user, "Screenshot analysis failed", "screenshot", id, { error: String(message).slice(0, 300) });
  }

  async function run(id, user, { buf, fmt, meta }) {
    db.prepare("UPDATE screenshot_analyses SET status = 'running', updated_at = ? WHERE id = ?").run(nowISO(), id);
    const r0 = row(id), tmpOcr = path.join(storage.tmpDir, `shot-${id}-ocr.png`), notes = [];
    // 1 ---- image prepared for reading: orientation, size (small text enlarged, very large pictures reduced)
    setStage(id, "detect", "running");
    let W = meta.width, H = meta.height;
    try {
      let img = sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate();
      if (H > MAX_HEIGHT) { img = img.extract({ left: 0, top: 0, width: W, height: MAX_HEIGHT }); notes.push(`The picture is very tall (${H} px); only the top ${MAX_HEIGHT} px were read.`); H = MAX_HEIGHT; }
      const scale = W < 600 ? 2 : W > 3000 ? 3000 / W : 1;
      if (scale !== 1) { img = img.resize(Math.round(W * scale)); notes.push(scale > 1 ? "Small picture enlarged ×2 for reading." : `Large picture reduced to 3000 px wide for reading.`); W = Math.round(W * scale); H = Math.round(H * scale); }
      fs.writeFileSync(tmpOcr, await img.png().toBuffer());
    } catch (e) { setStage(id, "detect", "failed", `The picture could not be prepared: ${e.message}`); throw new Error(`The picture could not be prepared for reading: ${e.message}`); }
    setStage(id, "detect", "done", `${fmt.toUpperCase()} ${meta.width}×${meta.height}, ${Math.round(buf.length / 1024)} KB${notes.length ? `; ${notes.join(" ")}` : ""}`);
    // 2 ---- OCR with layout (lines, positions, confidence)
    setStage(id, "ocr", "running");
    let o = null;
    try { o = await investigations.ocr(tmpOcr, 120000, { layout: true }); setStage(id, "ocr", o.lines.length ? "done" : "warning", o.lines.length ? `${o.lines.length} lines read, average confidence ${o.confidence} of 100 (Tesseract, English and Kiswahili)` : "no text was found in the picture"); }
    catch (e) { console.error("screenshot OCR failed", id, e.message); setStage(id, "ocr", "failed", `OCR failed: ${e.message}`); audit(user, "Screenshot OCR failed", "screenshot", id, { error: String(e.message).slice(0, 300) }); }
    // 3 ---- main post, platform, fields
    setStage(id, "identify", "running");
    let regions = [];
    try { regions = await mediaRegions(tmpOcr, (o?.lines || []).filter(l => l.conf >= 60).map(l => l.bbox), { width: W, height: H }); } catch (e) { notes.push(`Picture regions could not be measured (${e.message}).`); }
    const x = extractPost({ lines: o?.lines || [], regions, width: W, height: H });
    if (!o) x.uncertainties.unshift("The text of the screenshot could not be read (OCR failed); nothing was extracted from it.");
    x.notes = notes;
    // the same or nearly the same post analysed before
    const dups = [];
    if (x.text.value) for (const p of db.prepare("SELECT id, extraction_json FROM screenshot_analyses WHERE id != ? AND extraction_json IS NOT NULL ORDER BY created_at DESC LIMIT 500").all(id)) {
      const t = (() => { try { return JSON.parse(p.extraction_json).text?.value; } catch { return null; } })(); if (!t) continue;
      const s = similarity(x.text.value, t); if (s >= 0.6) dups.push({ id: p.id, similarity: Math.round(s * 100) / 100 });
    }
    if (r0.duplicate_of) dups.unshift({ id: r0.duplicate_of, similarity: 1, identical_file: true });
    x.duplicates = dups.slice(0, 5);
    db.prepare("UPDATE screenshot_analyses SET extraction_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(x), nowISO(), id);
    setStage(id, "identify", x.text.value ? "done" : "warning", [x.platform.value ? `apparent platform ${x.platform.value}` : "platform not identified", x.account.value ? `account ${x.account.value}` : "account not visible",
      x.posted_text.value ? `time “${x.posted_text.value}”` : "no time visible", x.multiple_posts ? `${x.posts.length} posts (main post selected)` : null, x.comments_excluded ? `${x.comments_excluded} comment(s) excluded` : null,
      x.duplicates.length ? `similar to ${x.duplicates.map(d => d.id).join(", ")}` : null].filter(Boolean).join(" · "));
    // 4 ---- Social Media Analysis fields, and the dataset record
    setStage(id, "populate", "running");
    const form = populateForm(x, { user, file: r0.original_name, sha256: r0.sha256, uploadedAt: r0.created_at });
    let datasetId = null, postSaved = null;
    try {
      const canPost = x.text.value && x.account.value && x.published_at.value && x.published_at.basis === "observed" && /T/.test(x.published_at.value);
      const via = `screenshot ${id} (SHA-256 ${r0.sha256.slice(0, 16)}…), main post read automatically by OCR`;
      if (canPost) {
        const rowIn = { text: x.text.value, account: x.handle.value || x.account.value, posted_at: x.published_at.value, platform: x.platform.value || "", url: x.urls.value?.[0] || "",
          likes: x.engagement.likes.value ?? "", comments: x.engagement.comments.value ?? "", shares: (x.engagement.shares.value ?? x.engagement.reposts.value) ?? "", views: x.engagement.views.value ?? "", language: x.language_code || "", collected_via: via };
        const r = io.importPosts(user, { buf: null, filename: `${id}.png`, name: form.name.value, description: form.description.value, source: form.source.value, authorisation: form.authorisation.value,
          researchQuestion: form.research_question.value, method: "screenshot (automatic extraction)", via, rowsIn: [rowIn] });
        datasetId = r.id; postSaved = true;
      } else {
        const at = nowISO();
        datasetId = Number(db.prepare("INSERT INTO io_datasets(name,description,source,authorisation,is_sample,posts,accounts,file_sha256,imported_by,imported_at,research_question,collection_method) VALUES (?,?,?,?,0,0,0,?,?,?,?,?)")
          .run(form.name.value, form.description.value, form.source.value, form.authorisation.value, r0.sha256, user.id, at, form.research_question.value, form.collection_method.value).lastInsertRowid);
        try { io.runAnalysis(user, datasetId); } catch {}
        postSaved = false;
        audit(user, "Screenshot analysis fields saved", "io_dataset", String(datasetId), { screenshot: id, post_saved: false });
      }
    } catch (e) { notes.push(`The analysis record could not be saved as a dataset (${e.message}).`); }
    const why = postSaved === false ? `the post was not added as a dataset row because ${[!x.account.value && "no account", !(x.published_at.value && /T/.test(x.published_at.value)) && "no exact publication time", !x.text.value && "no text"].filter(Boolean).join(" and ")} is visible` : null;
    form.post_record = { saved: !!postSaved, reason: why };
    db.prepare("UPDATE screenshot_analyses SET form_json = ?, dataset_id = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(form), datasetId, nowISO(), id);
    setStage(id, "populate", datasetId ? "done" : "warning", datasetId ? `fields populated; record saved as dataset ${datasetId}${why ? ` (${why})` : " with the post"}` : "fields populated; the dataset record could not be saved");
    // 5 ---- the original post, through permitted methods only (official embed / public page retrieval)
    setStage(id, "original", "running");
    const url = x.urls.value?.[0] || null; let original = { attempted: false, retrieved: false, url: null, method: null, reason: "no link is visible in the screenshot" };
    if (url) {
      original = { attempted: true, retrieved: false, url, method: null, reason: null };
      try {
        const L = parseSourceLink(url), isSocial = L && /X \(|Facebook|Instagram|TikTok|YouTube|Telegram|Threads|LinkedIn|Reddit/.test(L.platform || "");
        if (isSocial) { const lk = await timeout(social.lookup(url), 45000, "platform lookup"); original.method = `${L.platform} official embed / API`; if (lk?.text) Object.assign(original, { retrieved: true, text: String(lk.text).slice(0, 2000) }); else original.reason = lk?.message || "the platform did not return the post"; }
        else { const pg = await timeout(fetchPage(url, { allowPrivate: !!config.allowPrivateFetch }), 25000, "page retrieval"); original.method = "public web page retrieval"; if (String(pg?.text || "").trim().length >= 40) Object.assign(original, { retrieved: true, text: String(pg.text).slice(0, 2000), title: pg.title || null }); else original.reason = "the page had little or no readable text"; }
        if (original.retrieved) original.similarity = Math.round(similarity(x.text.value || "", original.text) * 100) / 100;
      } catch (e) { original.reason = String(e.message || e).slice(0, 200); }
    }
    x.original = original;
    db.prepare("UPDATE screenshot_analyses SET extraction_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(x), nowISO(), id);
    setStage(id, "original", !url ? "skipped" : original.retrieved ? "done" : "warning", !url ? "no link visible; the original post was not independently retrieved" : original.retrieved ? `retrieved by ${original.method}; text similarity to the screenshot ${Math.round(original.similarity * 100)}%` : `not retrieved (${original.reason}); the analysis continues from the screenshot`);
    // 6 ---- image model: only one that is configured AND reports the vision capability
    setStage(id, "vision", "running");
    const caps = await capabilities().catch(() => null), vis = caps?.vision;
    setStage(id, "vision", vis?.supported ? "done" : "skipped", vis?.supported ? `${vis.configured} reports image understanding; it describes the picture during the investigation (labelled as AI interpretation, never evidence)` : `${vis?.reason || "No image model is available."}${vis?.installed_vision_models?.length ? ` Image-capable models on the server: ${vis.installed_vision_models.join(", ")}.` : ""} The text model is not used for images.`);
    // 7 ---- the automatic investigation: claims (at most two), evidence, verdicts, KDF IO assessment, draft report, HOD submission
    setStage(id, "investigate", "running");
    const copy = path.join(storage.tmpDir, `shot-${id}-${crypto.randomBytes(4).toString("hex")}.${fmt === "jpeg" ? "jpg" : fmt}`);
    fs.writeFileSync(copy, buf);
    const pubBasis = x.published_at.value ? x.published_at.note : null;
    const prefetched = { screenshot: { id, sha256: r0.sha256, duplicates: x.duplicates.map(d => d.id), original: { attempted: original.attempted, retrieved: original.retrieved, url: original.url, method: original.method, reason: original.reason, similarity: original.similarity ?? null } },
      platform: x.platform.value ? `${x.platform.value}` : null, url: url || null, account: x.account.value || null, author_basis: x.account.value ? "name shown in the screenshot (not verified)" : null,
      published_at: x.published_at.value && /T/.test(x.published_at.value) ? x.published_at.value : null, published_basis: pubBasis,
      metrics: Object.values(x.engagement).some(v => v.value != null) ? { reactions: x.engagement.reactions.value ?? x.engagement.likes.value, comments: x.engagement.comments.value, shares: x.engagement.shares.value ?? x.engagement.reposts.value, views: x.engagement.views.value } : null,
      method: "screenshot submitted by the analyst; main post separated from comments, advertisements and interface text and read automatically by OCR",
      notes: [x.platform.value ? `Platform ${x.platform.value} is inferred from the screenshot's layout.` : "The platform could not be identified from the screenshot.", original.retrieved ? `The original post was retrieved from the visible link (${original.method}).` : "The original post was not independently retrieved.", ...notes].slice(0, 4),
      ocr_text: (o?.lines || []).map(l => l.text).join("\n").slice(0, 8000), ocr_confidence: o?.confidence ?? 0 };
    let inv;
    try { inv = investigations.start(user, { text: x.text.value || "", files: [{ originalname: r0.original_name || `screenshot.${fmt}`, size: buf.length, path: copy }], isTraining: !!r0.is_training, prefetched, origin: "screenshot" }); }
    catch (e) { safeRm(copy, "screenshot copy"); setStage(id, "investigate", "failed", e.message); throw e; }
    db.prepare("UPDATE screenshot_analyses SET investigation_id = ?, status = 'done', updated_at = ? WHERE id = ?").run(inv.id, nowISO(), id);
    setStage(id, "investigate", "done", `investigation ${inv.id} (report ${inv.report_id}) started: claims, evidence, verdicts, KDF IO assessment, one-page draft and automatic HOD submission`);
    audit(user, "Screenshot analysed automatically", "screenshot", id, { investigation: inv.id, dataset: datasetId, platform: x.platform.value, account_visible: !!x.account.value, posts: x.posts.length });
    safeRm(tmpOcr, "OCR copy");
  }
  const timeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} took longer than ${ms / 1000} s`)), ms).unref?.())]);

  function get(id) {
    const r = parse(row(id)); if (!r) throw new HttpError(404, "Screenshot analysis not found.");
    const inv = r.investigation_id ? (() => { try { return investigations.get(r.investigation_id); } catch { return null; } })() : null;
    let approval = null; if (inv?.report_id) { try { approval = investigations.approvalState(inv.id); } catch {} }
    const res = inv?.result || null;
    return { ...r, investigation: inv ? { id: inv.id, report_id: inv.report_id, status: inv.status, stage: inv.stage, stages: inv.stages, error: inv.error || null,
      result: res ? { verdict: res.overall?.verdict, label: res.overall?.label, strength: res.overall?.strength, case_id: res.case_id,
        claims: (res.claims || []).filter(c => (res.principal || []).includes(c.id)).map(c => { const i = res.claims.indexOf(c), a = res.assessments?.[i]; return { seq: c.seq, text: c.text, verdict: a?.verdict || null, label: a?.label || null, reason: a?.reason || null }; }),
        evidence: (res.evidence || []).filter(e => e.accepted || e.validation?.accepted).slice(0, 6).map(e => ({ title: e.title, url: e.url, publisher: e.publisher || e.source || null, date: e.published || e.date || null, stance: e.stance || null })),
        automation: res.automation || null } : null } : null,
      approval: approval ? { status: approval.status || null, label: approval.label || null, assigned: approval.assigned_hod_name || null, approval_ref: approval.approval_ref || null } : null };
  }
  const list = (limit = 30) => db.prepare("SELECT s.id, s.original_name, s.status, s.created_at, s.investigation_id, s.dataset_id, s.extraction_json, u.display_name created_by_name FROM screenshot_analyses s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.created_at DESC, s.id DESC LIMIT ?").all(limit)
    .map(r => { let x = null; try { x = JSON.parse(r.extraction_json || "null"); } catch {} return { id: r.id, original_name: r.original_name, status: r.status, created_at: r.created_at, created_by: r.created_by_name, investigation_id: r.investigation_id, dataset_id: r.dataset_id, platform: x?.platform?.value || null, account: x?.account?.value || null, text: x?.text?.value?.slice(0, 160) || null }; });
  // optional corrections by the analyst: recorded beside what AIVS produced, never replacing it silently
  const EDITABLE = ["name", "source", "authorisation", "research_question", "description"];
  function edit(user, id, changes = {}) {
    const r = row(id); if (!r) throw new HttpError(404, "Screenshot analysis not found."); if (!r.form_json) throw new HttpError(409, "The fields are still being populated.");
    const form = JSON.parse(r.form_json), edits = r.form_edits_json ? JSON.parse(r.form_edits_json) : [], at = nowISO(), done = [];
    for (const k of EDITABLE) if (changes[k] != null) {
      const v = String(changes[k]).trim(); if (!v && ["name", "source", "authorisation"].includes(k)) throw new HttpError(400, `${k.replace("_", " ")} cannot be empty.`);
      if (v === (form[k]?.value || "")) continue;
      edits.push({ field: k, from: form[k]?.value ?? null, to: v, by: user.id, by_name: user.display_name, at }); form[k] = { value: v || null, basis: "analyst", note: "corrected by the analyst" }; done.push(k);
    }
    if (!done.length) return get(id);
    db.prepare("UPDATE screenshot_analyses SET form_json = ?, form_edits_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(form), JSON.stringify(edits), at, id);
    if (r.dataset_id) db.prepare("UPDATE io_datasets SET name = ?, source = ?, authorisation = ?, research_question = ?, description = ? WHERE id = ?").run(form.name.value, form.source.value, form.authorisation.value, form.research_question.value, form.description.value, r.dataset_id);
    audit(user, "Screenshot analysis fields corrected", "screenshot", id, { fields: done });
    return get(id);
  }
  const image = id => { const r = row(id); if (!r) throw new HttpError(404, "Screenshot analysis not found."); return { buf: storage.read(r.sha256), mime: r.mime }; };
  const idle = () => Promise.allSettled([...jobs.values()]);
  // analyses interrupted by a restart are marked failed (their investigation, if started, continues on its own record)
  db.prepare("UPDATE screenshot_analyses SET status = 'failed', error = 'Interrupted: the server stopped before the analysis finished. Upload the screenshot again.', updated_at = ? WHERE status IN ('queued','running')").run(nowISO());
  return { submit, get, list, edit, image, capabilities, idle, STAGES: SCREENSHOT_STAGES };
}

// Safe retrieval of a public web page for verification (server side).
//  - http/https only; no credentials in the URL; at most 5 redirects, each re-checked
//  - every address the host name resolves to must be public: loopback, private, link-local, carrier-grade NAT,
//    multicast and reserved ranges are refused (SSRF protection); the checked address is pinned for the request,
//    so a second DNS answer cannot redirect it (DNS rebinding)
//  - 12 s timeout, 3 MB limit, no cookies, uncompressed or size-limited gzip/deflate/br
//  - only HTML and plain text are read; the body is returned unchanged for archiving and as extracted text
// The page's content is untrusted data. It is shown escaped and is never executed or obeyed.
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import zlib from "node:zlib";
import { HttpError } from "./auth.js";

const MAX_BYTES = 3 * 1024 * 1024, TIMEOUT = 12000, UA = "AIVS-verification/1.3 (+public interest verification; contact the operator of this installation)";

function v4Private(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return v4Private(ip);
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff") || x.startsWith("64:ff9b") || x.startsWith("2001:db8");
}

async function resolveSafe(host, allowPrivate) {
  const h = host.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(h) ? [{ address: h, family: net.isIP(h) }] : await dns.lookup(h, { all: true }).catch(() => { throw new HttpError(422, `The address ${host} could not be found. Check the link.`); });
  if (!addrs.length) throw new HttpError(422, `The address ${host} could not be found.`);
  if (!allowPrivate && addrs.some(a => isPrivateAddress(a.address))) throw new HttpError(422, "That link points to a private or local network address. AIVS only retrieves public web pages.");
  return addrs[0];
}

function request(url, addr, accept) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, {
      method: "GET", timeout: TIMEOUT, servername: net.isIP(url.hostname) ? undefined : url.hostname,
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en,sw;q=0.8", "Accept-Encoding": "gzip, deflate, br" }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location, status: res.statusCode }); }
      const len = +res.headers["content-length"] || 0;
      if (len > MAX_BYTES) { res.destroy(); return reject(new HttpError(413, "That page is larger than 3 MB. Paste the relevant text instead.")); }
      const chunks = []; let n = 0;
      res.on("data", d => { n += d.length; if (n > MAX_BYTES) { res.destroy(); reject(new HttpError(413, "That page is larger than 3 MB. Paste the relevant text instead.")); } else chunks.push(d); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new HttpError(504, "The page did not answer within 12 seconds. Try again later or paste the text.")));
    req.on("error", e => reject(e instanceof HttpError ? e : new HttpError(502, `The page could not be retrieved (${e.code || e.message}).`)));
    req.end();
  });
}

export async function fetchPage(input, { allowPrivate = false, allowPdf = false, allowXml = false } = {}) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new HttpError(400, "That does not look like a web address. It should start with http:// or https://."); }
  for (let hop = 0; hop <= 5; hop++) {
    if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http:// and https:// links can be retrieved.");
    if (url.username || url.password) throw new HttpError(400, "Links containing a user name or password are not retrieved.");
    const addr = await resolveSafe(url.hostname, allowPrivate);
    const r = await request(url, addr, allowXml ? "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.1" : "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1");
    if (r.redirect) { url = new URL(r.redirect, url); continue; }
    if (r.status >= 400) throw new HttpError(502, `The site answered with HTTP ${r.status}. The page may have been removed, or it may block automated retrieval.`);
    let body = r.body; const enc = String(r.headers["content-encoding"] || "").toLowerCase();
    try {
      const opt = { maxOutputLength: MAX_BYTES * 4 };
      if (enc === "gzip") body = zlib.gunzipSync(body, opt); else if (enc === "deflate") body = zlib.inflateSync(body, opt); else if (enc === "br") body = zlib.brotliDecompressSync(body, opt);
    } catch { throw new HttpError(422, "The page could not be decompressed safely."); }
    const ct = String(r.headers["content-type"] || "").toLowerCase(), mime = ct.split(";")[0].trim() || "text/html";
    if (allowXml && (/^(application\/(rss|atom|rdf)\+xml|application\/xml|text\/xml)$/.test(mime) || /^\s*<\?xml|^\s*<(rss|feed)\b/.test(body.subarray(0, 300).toString("utf8")))) return { finalUrl: url.href, mime, raw: body, xml: body.toString("utf8") };
    if (allowPdf && (mime === "application/pdf" || body.subarray(0, 5).toString("latin1") === "%PDF-")) return { finalUrl: url.href, mime: "application/pdf", raw: body, pdf: true };
    if (!/^(text\/html|application\/xhtml\+xml|text\/plain)$/.test(mime)) throw new HttpError(415, mime === "application/pdf" ? "That link is a PDF. Download it and add it to a case with Upload files: AIVS reads PDF text there." : `That link is ${mime}, not a web page. Upload images and video in a case instead.`);
    const charset = (/charset=([\w-]+)/i.exec(ct) || [])[1] || "utf-8";
    let text; try { text = new TextDecoder(charset, { fatal: false }).decode(body); } catch { text = body.toString("utf8"); }
    return { finalUrl: url.href, mime, raw: body, ...(mime === "text/plain" ? { title: null, text: text.trim(), published: null, site: url.hostname } : extractHtml(text, url)) };
  }
  throw new HttpError(508, "Too many redirects.");
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? (() => { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; })() : ENT[e.toLowerCase()] ?? m);
const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag); return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : null; };

export function extractHtml(html, url) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]);
  const meta = (...keys) => { for (const k of keys) for (const t of metas) { const n = (attr(t, "property") || attr(t, "name") || attr(t, "itemprop") || "").toLowerCase(); if (n === k) { const c = attr(t, "content"); if (c) return c.trim(); } } return null; };
  const title = meta("og:title", "twitter:title") || decode(((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "").replace(/\s+/g, " ").trim()) || null;
  let published = null, basis = null;
  for (const [k, b] of [["article:published_time", "page metadata (article:published_time)"], ["datepublished", "page metadata (datePublished)"], ["date", "page metadata (date)"], ["dc.date", "page metadata (DC.date)"], ["pubdate", "page metadata (pubdate)"]]) { const v = meta(k); if (v && !isNaN(new Date(v))) { published = new Date(v).toISOString(); basis = b; break; } }
  if (!published) { const m = /"datePublished"\s*:\s*"([^"]+)"/i.exec(html); if (m && !isNaN(new Date(m[1]))) { published = new Date(m[1]).toISOString(); basis = "structured data (datePublished)"; } }
  if (!published) { const m = /<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i.exec(html); if (m && !isNaN(new Date(m[1]))) { published = new Date(m[1]).toISOString(); basis = "first <time> element on the page"; } }
  const modified = meta("article:modified_time", "datemodified");
  let body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const pick = re => { const m = re.exec(body); return m && m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length > 200 ? m[1] : null; };
  body = pick(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || pick(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(body) || [, body])[1];
  const text = decode(body.replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .split("\n").map(l => l.replace(/[ \t\f\v ]+/g, " ").trim()).filter(l => l.length > 1).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text, published, publishedBasis: basis, modified: modified && !isNaN(new Date(modified)) ? new Date(modified).toISOString() : null, site: meta("og:site_name") || url.hostname, description: meta("og:description", "description") };
}

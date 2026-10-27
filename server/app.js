// Express application factory. `createApp(config)` is used by server/index.js and the test suite.
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { ROOT } from "./config.js";
import { openDb, nowISO } from "./lib/db.js";
import { makeAudit, verifyChain } from "./lib/audit.js";
import { makeStorage } from "./lib/storage.js";
import { makeMedia } from "./lib/media.js";
import { makeCases, STATES, CONCLUSIONS, DEFAULT_CHECKS } from "./lib/cases.js";
import { makeReports } from "./lib/report.js";
import { makeAutomaticReports, automaticReportHtml } from "./lib/automatic-report.js";
import { makeAI } from "./ai/index.js";
import { seedTraining, seedCoverageDemo } from "./lib/training.js";
import { fetchPage } from "./lib/fetchurl.js";
import { reportPdf, reportCsv } from "./lib/pdf.js";
import { makeRetrieval, OFFICIAL_SOURCES } from "./lib/retrieval.js";
import { makeIo, sampleDataset, normText, CAVEATS as IO_CAVEATS, parseFile, detectMapping } from "./lib/io.js";
import { extractDocument } from "./lib/docs.js";
import { makeInvestigations } from "./lib/investigate.js";
import { makeAssistant } from "./lib/assistant.js";
import { makeCoverage } from "./lib/coverage.js";
import { makeKb, sampleKb } from "./lib/kb.js";
import { makeAdmin } from "./lib/admin.js";
import { makeSocial } from "./lib/social.js";
import { makeDatasetWatch } from "./lib/watch-datasets.js";
import { watchDemoRows, WATCH_DEMO } from "./lib/watch-demo.js";
import { analyseContent } from "./lib/content-analysis.js";
import { insights, cleanFilters, sentimentEvaluation, discussionSample, enrichPosts, THEMES, SENTIMENT_LABELS, LIMITATIONS as SOCIAL_LIMITATIONS, filterSql, useSentimentModel, classifySentiment, sentimentModel } from "./lib/social-analysis.js";
import { loadModel } from "./ai/textclf.js";
import { makeOllama } from "./lib/ollama.js";
import { makeTranscriber } from "./lib/transcribe.js";
import { makeCollectors } from "./lib/collectors.js";
import { makeWatch, kdfTemplate, normaliseDefinition, matchPost, xQuery, youtubeQuery, CAVEATS as WATCH_CAVEATS, WATCH_SOURCES, MANUAL_SOURCES, highlights as watchHighlights, SEVERITY_RULES, ACTION as WATCH_ACTIONS } from "./lib/watch.js";
import { makeWatchCollector } from "./lib/watch-collect.js";
import { buildReport, reportHtml as ioReportHtml, reportCsv as ioReportCsv, reportPdf as ioReportPdf } from "./lib/io-report.js";
import { providers as aiProviders } from "./ai/providers.js";
import { VERDICTS, VERDICT_HELP, STRENGTH_LABELS } from "../shared/verdict.js";
import { TOPICS } from "../shared/text.js";
import { suggestSource, parseSourceLink } from "../shared/text.js";
import { makeLimiter } from "./lib/ratelimit.js";
import { submissionHashes, ham, levelOf } from "./lib/hashing.js";
import { sniff } from "./lib/sniff.js";
import { THRESH } from "./lib/hashing.js";
import { ROLES, ROLE_LABELS, PERMISSIONS, can, hashPassword, verifyPassword, passwordProblem, makeSessions, throttled, noteFailure, clearFailures, HttpError, requireUser, requirePerm } from "./lib/auth.js";

const require = createRequire(import.meta.url);
const pkgDir = name => path.dirname(require.resolve(`${name}/package.json`));

export function createApp(config) {
  // trained models shipped in models/ (see scripts/train-sentiment.js); missing files mean the word list is used
  const MODELS_DIR = config.modelsDir || path.join(ROOT, "models");
  useSentimentModel(config.noModels ? null : loadModel(MODELS_DIR, "sentiment-tweeteval-lr-1"));
  const db = openDb(path.join(config.dataDir, "aivs.db"));
  const audit = makeAudit(db);
  const storage = makeStorage(db, config.dataDir);
  const media = makeMedia(db, storage);
  const cases = makeCases(db, { audit, allowSelfApproval: config.allowSelfApproval, isTest: !!config.isTest });
  const reports = makeReports(db, { cases, storage });
  const ai = makeAI(db, { config, cases, storage, audit });
  // metered external calls are recorded for the administration page (cost estimates only where a rate is configured)
  const usage = (service, operation, costUsd, { units = 1, unit = "request", caseId = null, userId = null, status = "ok" } = {}) => {
    try { db.prepare("INSERT INTO api_usage(at,service,operation,units,unit,est_cost_usd,status,case_id,user_id) VALUES (?,?,?,?,?,?,?,?,?)").run(nowISO(), service, operation, units, unit, costUsd == null ? null : costUsd * units, status, caseId, userId); } catch {}
  };
  const retrieval = makeRetrieval(db, { config, audit, usage });
  const automaticReports = makeAutomaticReports(db, { cases, retrieval, ai, storage, config, audit });
  const social = makeSocial(db, { config });
  const ollama = makeOllama(db, { config }), collectors = makeCollectors(db, { config });
  const transcriber = makeTranscriber(db, { config, storage, audit, cases });
  const io = makeIo(db, { audit });
  const kb = makeKb(db, { audit });
  const admin = makeAdmin(db, { config, audit, storage });
  // the assistant's AI connection (a scripted double in tests: cites the first record sent, or invents one on request)
  const mockChat = { async chat(_c, { messages }) { const ids = [...messages.at(-1).content.matchAll(/<source id="([^"]+)"/g)].map(m => m[1]); return { text: `**Findings**\nThe content is recorded [${ids[0]}].${process.env.AIVS_MOCK_AI === "invent" ? " A ministry statement confirms it [E-999999]." : ""}\n**Uncertainties**\nNo independent source yet.`, model: "mock-1" }; } };
  const assistant = makeAssistant(db, { config, cases, audit, aiStatus: () => ai.status(), provider: () => (config.ai.provider === "mock" && config.isTest ? mockChat : aiProviders[config.ai.provider]), usage });
  const coverage = makeCoverage(db, { cases, storage, audit, config, aiStatus: () => ai.status(), provider: () => (config.ai.provider === "mock" && config.isTest ? mockChat : aiProviders[config.ai.provider]), usage });
  const sessions = makeSessions(db, config);
  const watch = makeWatch(db, { audit, cases, config });
  // AI Watchlist on imported datasets: every import or addition to a dataset is checked by the active watchlists that monitor it
  const dsWatch = makeDatasetWatch(db, { watch, audit });
  for (const fn of ["importPosts", "appendPosts", "appendCollected"]) {
    const orig = io[fn];
    io[fn] = (...args) => {
      const r = orig(...args), id = r?.id ?? (fn === "importPosts" ? null : args[1]);
      if (id) { try { const w = dsWatch.onDatasetChange(id); if (r && typeof r === "object") r.watchlists = w; } catch (e) { console.warn(`[watch] dataset ${id} could not be checked: ${e.message}`); if (r && typeof r === "object") r.watchlists_error = e.message; } }
      return r;
    };
  }
  const VERSION0 = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const watchCollector = makeWatchCollector(db, { watch, collectors, config, audit, version: VERSION0 });
  const investigations = makeInvestigations(db, { config, cases, retrieval, media, storage, social, fetchPage, extractDocument, ai, audit, version: VERSION0 });
  const ctx = { db, audit, storage, media, cases, reports, automaticReports, ai, sessions, config, retrieval, usage, transcriber, coverage, watch, watchCollector, investigations };

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  // health check for servers, containers and uptime monitors (no data, no sign-in)
  const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  app.get("/healthz", (req, res) => { try { db.prepare("SELECT 1").get(); res.json({ ok: true, version: VERSION }); } catch { res.status(503).json({ ok: false }); } });

  // ---------------------------------------------------------------- security headers
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (config.cookieSecure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  // CSRF: SameSite=Strict cookies + a custom header on every state-changing API call + Origin check
  app.use("/api", (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.headers["x-aivs"] !== "1") return next(new HttpError(403, "Request rejected (missing application header)."));
    const o = req.headers.origin;
    if (o && new URL(o).host !== req.headers.host) return next(new HttpError(403, "Request rejected (cross-site origin)."));
    next();
  });
  // WhatsApp Business webhook (Meta calls this; no AIVS sign-in). Verified with the app secret over the exact bytes received.
  app.get("/webhooks/whatsapp", (req, res) => {
    const P = config.platforms || {};
    if (P.whatsappVerifyToken && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === P.whatsappVerifyToken) return res.type("text/plain").send(String(req.query["hub.challenge"] || ""));
    res.sendStatus(403);
  });
  app.post("/webhooks/whatsapp", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const secret = config.platforms?.whatsappAppSecret; if (!secret) return res.sendStatus(404);
    const sig = String(req.headers["x-hub-signature-256"] || ""), mac = "sha256=" + crypto.createHmac("sha256", secret).update(req.body || Buffer.alloc(0)).digest("hex");
    if (sig.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac))) { audit(null, "WhatsApp webhook rejected (bad signature)", "watch", "whatsapp_business"); return res.sendStatus(401); }
    let j; try { j = JSON.parse(req.body.toString("utf8")); } catch { return res.sendStatus(400); }
    try { watchCollector.whatsappWebhook(j); } catch (e) { console.error("WhatsApp webhook:", e.message); }
    res.sendStatus(200);
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(sessions.load);

  // ---------------------------------------------------------------- static: app, shared code, local OCR engine
  const noStore = (res) => res.setHeader("Cache-Control", "no-cache");
  app.use(express.static(path.join(ROOT, "public"), { setHeaders: noStore }));
  app.use("/shared", express.static(path.join(ROOT, "shared"), { setHeaders: noStore }));
  app.use("/vendor/tesseract", express.static(path.join(pkgDir("tesseract.js"), "dist")));
  app.use("/vendor/tesseract-core", express.static(pkgDir("tesseract.js-core")));
  app.use("/vendor/pdfjs", express.static(path.join(pkgDir("pdfjs-dist"), "legacy", "build")));   // renders scanned PDF pages for OCR in the browser
  const langFile = l => { try { return path.join(pkgDir(`@tesseract.js-data/${l}`), "4.0.0", `${l}.traineddata.gz`); } catch { return null; } };
  const OCR_LANGS = { eng: "English", swa: "Kiswahili" };
  const ocrAvailable = () => Object.entries(OCR_LANGS).filter(([l]) => { const f = langFile(l); return f && fs.existsSync(f); }).map(([code, label]) => ({ code, label }));
  app.get("/vendor/tessdata/:file", (req, res, next) => {
    const m = /^(eng|swa)\.traineddata\.gz$/.exec(req.params.file); const f = m && langFile(m[1]);
    if (!f || !fs.existsSync(f)) return next(new HttpError(404, "OCR language data not installed."));
    res.setHeader("Cache-Control", "public, max-age=604800"); res.sendFile(f);
  });

  const api = express.Router();
  const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const users = () => db.prepare("SELECT id, username, display_name, role, active, must_change_password, created_at, last_login_at FROM users ORDER BY active DESC, display_name").all();
  const scopeOf = req => (req.query.training === "1" ? 1 : 0);

  // ---------------------------------------------------------------- auth
  api.post("/auth/login", h((req, res) => {
    const { username, password } = req.body || {}, key = `${String(username).toLowerCase()}|${req.ip}`;
    if (throttled(key)) throw new HttpError(429, "Too many failed attempts. Wait 15 minutes and try again.");
    const u = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || ""));
    if (!u || !u.active || !verifyPassword(String(password || ""), u.password_hash)) {
      noteFailure(key); audit(null, "Sign-in failed", "user", String(username || "").slice(0, 60)); throw new HttpError(401, "Wrong username or password, or the account is disabled.");
    }
    clearFailures(key); sessions.create(res, u, req);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowISO(), u.id);
    audit(u, "Signed in", "user", String(u.id));
    res.json({ ok: true, must_change_password: !!u.must_change_password });
  }));
  api.post("/auth/logout", (req, res) => { if (req.user) audit(req.user, "Signed out", "user", String(req.user.id)); sessions.destroy(req, res); res.json({ ok: true }); });
  api.get("/me", requireUser, (req, res) => res.json({ user: req.user, permissions: Object.keys(PERMISSIONS).filter(p => can(req.user, p)) }));
  api.post("/me/password", requireUser, h((req, res) => {
    const { current, next: pw } = req.body || {};
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!verifyPassword(String(current || ""), u.password_hash)) throw new HttpError(400, "Your current password is wrong.");
    const p = passwordProblem(pw); if (p) throw new HttpError(400, p);
    if (pw === current) throw new HttpError(400, "Choose a password you have not used here.");
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(pw), u.id);
    audit(req.user, "Password changed", "user", String(u.id)); res.json({ ok: true });
  }));

  api.use(requireUser);
  const upload = multer({ dest: storage.tmpDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20, fields: 20 } });
  const cleanup = files => (files || []).forEach(f => fs.rmSync(f.path, { force: true }));
  // rate limits: everything, plus a tighter budget for work that fetches, stores or computes a lot
  const RL = { windowMs: 300000, general: 1500, heavy: 60, ...(config.rateLimit || {}) };
  const general = makeLimiter({ windowMs: RL.windowMs, limit: RL.general, name: "General" }), heavy = makeLimiter({ windowMs: RL.windowMs, limit: RL.heavy, name: "Heavy" });
  const HEAVY = /^\/(investigations|verify|check-image|archive(\/import)?|cases\/[^/]+\/(media|analyse|ai\/runs|to-archive|assistant|coverage\/ai)|media\/[^/]+\/frames|cases\/[^/]+\/retrieve|evidence\/[^/]+\/check-source|io\/datasets(\/\d+\/(analyse|add))?|io\/sample|extract-text|social\/lookup|extract|verify\/post|io\/collect|io\/discussion-sample|io\/watch-demo|watch\/lists\/\d+\/analyse|io\/datasets\/\d+\/(enrich|ai)|io\/claims\/\d+\/case|watch\/lists\/\d+\/(preview|run|submit|import)|watch\/sources\/\w+\/check|watch\/alerts\/\d+\/action|media\/[^/]+\/transcripts|kb\/datasets(\/\d+\/evaluate)?|kb\/sample)$/;
  api.use(general);
  api.use((req, res, next) => (req.method === "POST" && HEAVY.test(req.path) ? heavy(req, res, next) : next()));

  api.patch("/me/preferences", h((req, res) => {
    const m = req.body?.ui_mode; if (!["guided", "advanced"].includes(m)) throw new HttpError(400, "Mode must be guided or advanced.");
    db.prepare("UPDATE users SET ui_mode = ? WHERE id = ?").run(m, req.user.id); res.json({ ok: true, ui_mode: m });
  }));

  // ---------------------------------------------------------------- Verify Information: one step from text or a link to a case
  api.post("/verify", requirePerm("case.create"), h(async (req, res) => {
    const b = req.body || {}, input = String(b.input || "").trim(), isTraining = !!b.is_training;
    if (!input) throw new HttpError(400, "Paste a claim, some article text or a link first.");
    if (input.length > 20000) throw new HttpError(400, "That is more than 20,000 characters. Paste the part that contains the claims.");
    const now = nowISO(), isUrl = /^https?:\/\/\S+$/i.test(input);
    const fields = { received_at: now, priority: ["routine", "priority", "urgent"].includes(b.priority) ? b.priority : "routine", is_training: isTraining };
    let page = null, snap = null, truncated = false;
    if (isUrl) {
      const SL = parseSourceLink(input);
      if (SL && ["X (Twitter)", "Facebook", "Instagram", "TikTok", "YouTube", "Telegram", "Threads", "LinkedIn", "WhatsApp", "Reddit"].includes(SL.platform))
        throw new HttpError(422, `This is a link to a ${SL.platform} post. Social platforms do not show posts to automatic page retrieval. Choose “Social media post” at the top of this page: it reads the post through ${SL.platform}'s public embed where one exists, or you paste the text and add a screenshot.`);
      const cached = lookups.get(`page ${req.user.id} ${input}`);   // the copy the analyst previewed on the New investigation page
      page = cached && Date.now() - cached.at < 30 * 60e3 ? cached.page : await fetchPage(input, { allowPrivate: !!config.allowPrivateFetch, allowPdf: true });
      if (page.pdf && !page.text) {   // a PDF link: read its text the same way as an uploaded PDF
        let d; try { d = await extractDocument(page.raw, "linked.pdf"); } catch (e) { throw new HttpError(422, `The PDF could not be read (${e.message}). Download it and add it to a case instead.`); }
        if (!d.text || d.text.replace(/\s/g, "").length < 40) throw new HttpError(422, "That PDF has no text layer (it looks scanned). Download it, start a case with Upload files, and use “Read text from pages (OCR)”.");
        Object.assign(page, { text: d.text, title: d.meta?.Title || null, site: new URL(page.finalUrl).hostname, published: d.created || null, publishedBasis: d.created ? "the PDF's creation date (document properties)" : null });
      }
      const typedText = typeof b.text === "string" && b.text.trim().length >= 10;
      if ((!page.text || page.text.replace(/\s/g, "").length < 40) && !typedText) throw new HttpError(422, "No readable text was found on that page. It may need JavaScript or a login. Open it yourself and paste the text instead.");
      snap = await storage.putBuffer(page.raw, page.mime);
      let text = page.text || ""; if (text.length > 12000) { text = text.slice(0, 12000); truncated = true; }
      const edited = typeof b.text === "string" && b.text.trim() && b.text.trim() !== text.trim() ? b.text.replace(/\r\n/g, "\n").trim().slice(0, 20000) : null;   // the analyst corrected the extracted text
      if (edited) { text = edited; page.textEdited = true; }
      Object.assign(fields, { title: String(b.title || page.title || new URL(page.finalUrl).hostname).slice(0, 200), claim_text: (page.title && !page.textEdited && !text.startsWith(page.title) ? `${page.title}\n\n` : "") + text,
        source_platform: String(page.site || new URL(page.finalUrl).hostname).slice(0, 200), source_url: input.slice(0, 2000), published_at: page.published || null, published_basis: page.published ? page.publishedBasis : null });
      const L = parseSourceLink(input), sg = suggestSource({ text: page.text });
      if (L?.account) fields.source_account = L.account;
      if (L && !/\(website\)$/.test(L.platform)) fields.source_platform = L.platform;
      if (!fields.published_at && L?.published_at) Object.assign(fields, { published_at: L.published_at, published_basis: L.published_basis });
      fields.hashtags = sg.hashtags; if (sg.event) Object.assign(fields, { claimed_event_at: sg.event.at || null, claimed_event_basis: sg.event.basis });
    } else {
      const first = input.replace(/\s+/g, " ").slice(0, 90);
      const sg = suggestSource({ text: input });
      Object.assign(fields, { title: String(b.title || (first.length < input.length ? first.replace(/\s+\S*$/, "") + "…" : first)).slice(0, 200), claim_text: input, source_platform: String(b.source_platform || sg.platform || "Pasted text").slice(0, 200),
        source_account: sg.account, source_url: sg.url, published_at: sg.published_at, published_basis: sg.published_basis, claimed_event_at: sg.event?.at || null, claimed_event_basis: sg.event?.basis || null, hashtags: sg.hashtags });
    }
    const id = cases.create(req.user, fields);
    if (page) {
      db.prepare("UPDATE cases SET source_title = ?, source_snapshot_sha256 = ?, source_snapshot_mime = ?, source_fetched_at = ?, source_final_url = ? WHERE id = ?").run(page.title, snap.sha256, page.mime, now, page.finalUrl, id);
      audit(req.user, "Source page retrieved and archived", "case", id, { url: input, final_url: page.finalUrl, sha256: snap.sha256, bytes: page.raw.length, published: page.published, published_basis: page.publishedBasis, truncated, text_edited_by_analyst: !!page.textEdited });
    }
    await cases.startAnalysis(req.user, id);
    // evidence search: local sources always; external services only when configured and requested
    let search = null;
    const ext = retrieval.status().filter(s => s.sends_to).map(s => s.key);   // unconfigured services report "not configured"
    if (b.search !== false) { try { search = await retrieval.retrieve(req.user, id, { use: ["kb", "holdings", ...(b.search ? ext : [])] }, cases); } catch (e) { search = { error: e.message }; } }
    res.status(201).json({ ...verifyResult(id, search), truncated,
      source: page ? { title: page.title, site: page.site, final_url: page.finalUrl, published: page.published, published_basis: page.publishedBasis, modified: page.modified, sha256: snap.sha256, bytes: page.raw.length } : null });
  }));
  function verifyResult(id, search) {
    const agg = cases.aggregate(id);
    return { id, status: agg.case.status, search, claims: agg.claims.filter(c => !c.removed).map(c => ({ id: c.id, text: c.text, kind: c.kind, claim_type: c.claim_type, suggested_assessment: c.suggested_assessment, suggested_basis: c.suggested_basis })),
      evidence: agg.evidence.filter(e => e.status === "suggested").map(e => ({ id: e.id, kind: e.kind, origin: e.origin, connector: e.connector, text: e.text, source_url: e.source_url, source_title: e.source_title, source_publisher: e.source_publisher, rating: e.rating, claim_id: e.claim_id })) };
  }
  async function searchFor(user, id, wantExternal) {
    const ext = retrieval.status().filter(s => s.sends_to).map(s => s.key);
    try { return await retrieval.retrieve(user, id, { use: ["kb", "holdings", ...(wantExternal ? ext : [])] }, cases); } catch (e) { return { error: e.message }; }
  }

  // ---------------------------------------------------------------- Social media analysis: check one public post
  // Step 1 (optional): look the link up through the platform's public embed service. Step 2: create the case from
  // the post's text (from the embed, typed, or read from a screenshot), with screenshots, images or video attached.
  const lookups = new Map();   // per user and link, 30 minutes: the server keeps what the platform returned
  const cacheKey = (u, url) => `${u.id} ${url}`;
  api.get("/social/services", (req, res) => res.json({ services: social.status() }));
  api.post("/social/lookup", requirePerm("case.create"), h(async (req, res) => {
    const url = String(req.body?.url || "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, "Paste the post's link, starting with https://");
    const r = await social.lookup(url);
    for (const [k, v] of lookups) if (Date.now() - v.at > 30 * 60e3) lookups.delete(k);
    if (r.social) lookups.set(cacheKey(req.user, url), { at: Date.now(), r });
    res.json({ ...r, raw: undefined, archived: !!r.raw });
  }));
  // Content extraction for the New investigation page: one call for any link. Social posts go through the
  // platform adapters above; news articles and other web pages are retrieved once (SSRF-protected), and that same
  // copy is reused when the case is created, so what the analyst previewed is exactly what is archived.
  api.post("/extract", requirePerm("case.create"), h(async (req, res) => {
    const url = String(req.body?.url || "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, "Paste one link, starting with https://");
    for (const [k, v] of lookups) if (Date.now() - v.at > 30 * 60e3) lookups.delete(k);
    const r = await social.lookup(url);
    if (r.social) { lookups.set(cacheKey(req.user, url), { at: Date.now(), r }); return res.json({ ...r, kind: "social", raw: undefined, archived: !!r.raw }); }
    if (!r.url) throw new HttpError(400, r.message || "That is not a valid web address.");
    const base = { kind: "web", social: false, url, normalized_url: r.url, platform: r.platform, looked_up_at: nowISO() };
    let page;
    try { page = await fetchPage(url, { allowPrivate: !!config.allowPrivateFetch, allowPdf: true }); }
    catch (e) { return res.json({ ...base, status: "unavailable", text: null, text_status: "none", message: e.message, attempts: [{ method: "page retrieval", result: "failed", detail: e.message }] }); }
    if (page.pdf) {
      let d; try { d = await extractDocument(page.raw, "linked.pdf"); } catch (e) { return res.json({ ...base, status: "unavailable", text: null, text_status: "none", message: `The PDF could not be read (${e.message}).`, attempts: [{ method: "PDF text", result: "failed" }] }); }
      Object.assign(page, { text: d.text, title: d.meta?.Title || null, site: new URL(page.finalUrl).hostname, published: d.created || null, publishedBasis: d.created ? "the PDF's creation date (document properties)" : null });
    }
    lookups.set(`page ${req.user.id} ${url}`, { at: Date.now(), page });
    const ok = page.text && page.text.replace(/\s/g, "").length >= 40;
    res.json({ ...base, final_url: page.finalUrl, status: ok ? "ok" : "no_text", title: page.title || null, site: page.site || null, description: page.description || null, posted_at: page.published || null, posted_basis: page.published ? page.publishedBasis : null,
      text: ok ? page.text.slice(0, 12000) : null, text_status: ok ? (page.text.length > 12000 ? "partial" : "full") : "none", text_source: page.pdf ? "the linked PDF's text" : "the page's main text (headline and article body)",
      message: ok ? (page.text.length > 12000 ? "The page is long: the first 12,000 characters are used." : null) : "No readable text was found on that page. It may need JavaScript or a login. Paste the text instead.",
      attempts: [{ method: "page retrieval", result: ok ? "ok" : "no text", detail: page.finalUrl !== url ? `redirected to ${page.finalUrl}` : undefined }], bytes: page.raw.length });
  }));
  api.post("/verify/post", requirePerm("case.create"), upload.array("files", 10), h(async (req, res) => {
    const files = req.files || [], b = req.body || {};
    let id, L = null, textBasis, ocrUsed = false;
    try {
      const url = String(b.url || "").trim();
      if (url && !/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, "The post's link should start with https://");
      const ocr = files.map((_, i) => { try { const o = JSON.parse(b[`ocr_${i}`] || "null"); return o && typeof o.text === "string" ? o : null; } catch { return null; } });
      let text = String(b.text || "").replace(/\r\n/g, "\n").trim();
      if (!text) { const t = ocr.filter(o => o?.text.trim()).map(o => o.text.trim()).join("\n\n"); if (t) { text = t; ocrUsed = true; } }
      // no words given: use what the platform's public embed returned for this link (looked up now if needed)
      if (!text && url) { const c = lookups.get(cacheKey(req.user, url)); L = c ? c.r : null; if (!L && b.lookup !== "0") { const r = await social.lookup(url).catch(() => null); if (r?.social) L = r; } if (L?.text) text = L.text.trim(); }
      if (!text) throw new HttpError(400, L?.message ? `The case needs the words of the post. ${L.message}` : "The case needs the words of the post. Paste them, look the link up, or add a screenshot and read its text.");
      if (text.length > 20000) throw new HttpError(400, "That is more than 20,000 characters. Paste the part that contains the claims.");
      let postedAt = null; if (b.posted_at) { const d = new Date(b.posted_at); if (isNaN(d)) throw new HttpError(400, "The posting time could not be read."); postedAt = d.toISOString(); }
      if (url && !L) { const c = lookups.get(cacheKey(req.user, url)); L = c ? c.r : null; if (!L && b.lookup !== "0") { const r = await social.lookup(url).catch(() => null); if (r?.social) L = r; } }
      const norm = t => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
      const inOcr = ocr.some(o => o?.text && norm(o.text).includes(norm(text).slice(0, 200)));
      textBasis = ocrUsed || inOcr ? "read from the screenshot with OCR (check it against the image)" : b.text_source === "ocr-edited" && ocr.some(o => o?.text) ? "read from the screenshot with OCR, then corrected by the analyst" : L?.text && norm(L.text) === norm(text) ? L.text_source : L?.text && norm(text).includes(norm(L.text).slice(0, 60)) ? `${L.text_source}, edited by the analyst` : "entered by the analyst";
      const sg = suggestSource({ text, url }), P = url ? parseSourceLink(url) : null;
      id = cases.create(req.user, {
        title: String(b.title || "").trim() || undefined, claim_text: text, received_at: nowISO(), priority: ["routine", "priority", "urgent"].includes(b.priority) ? b.priority : "routine", is_training: b.is_training === "true" || b.is_training === "1",
        source_platform: String(b.platform || L?.platform || P?.platform || sg.platform || "Social media post").replace(/ \(website\)$/, "").slice(0, 200),
        source_account: String(b.account || L?.account || P?.account || "").slice(0, 200) || null, source_url: url || null,
        published_at: postedAt, published_basis: postedAt ? String(b.posted_basis || "entered by the analyst").slice(0, 300) : null,
        hashtags: sg.hashtags, claimed_event_at: sg.event?.at || null, claimed_event_basis: sg.event?.basis || null });
    } catch (e) { cleanup(files); throw e; }
    const now = nowISO();
    if (L?.raw) {
      const snap = await storage.putBuffer(Buffer.from(JSON.stringify({ retrieved_at: L.looked_up_at, link: L.url, service: L.text_source || L.service, platform_response: L.raw }, null, 2)), "text/plain");
      db.prepare("UPDATE cases SET source_title = ?, source_snapshot_sha256 = ?, source_snapshot_mime = ?, source_fetched_at = ?, source_final_url = ? WHERE id = ?").run(`${L.platform} public embed response`, snap.sha256, "text/plain", L.looked_up_at, L.url, id);
      audit(req.user, "Post looked up through the platform's public embed and archived", "case", id, { url: L.url, service: L.service, sha256: snap.sha256, status: L.status });
    }
    audit(req.user, "Social media post recorded", "case", id, { url: b.url || null, platform: L?.platform || null, lookup: L ? L.status : "not used", text_status: L?.text && textBasis !== "entered by the analyst" && !/OCR/.test(textBasis) ? L.text_status || null : null, text_basis: textBasis, posted_basis: b.posted_basis || null });
    const added = [], mediaErrors = [], c = cases.mustCase(id);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const row = await media.ingest(f.path, { name: f.originalname, caseId: id, isTraining: c.is_training, user: req.user });
        added.push({ id: row.id, name: row.original_name, kind: row.kind, sha256: row.sha256 });
        let o = null; try { o = JSON.parse(b[`ocr_${i}`] || "null"); } catch {}
        if (o && typeof o.text === "string" && o.text.trim() && row.kind === "image") cases.addOcr(req.user, row.id, { text: o.text, lang: /^[a-z+]{3,15}$/.test(o.lang || "") ? o.lang : "eng", confidence: Number.isFinite(+o.confidence) ? +o.confidence : null, engine: "tesseract.js (in the browser)" });
      } catch (e) { fs.rmSync(f.path, { force: true }); mediaErrors.push(`${f.originalname}: ${e.message}`); }
    }
    if (added.length) cases.change(req.user, id, `Media received: ${added.map(o => `${o.id} (${o.name})`).join(", ")}`, () => {}, { sha256: added.map(o => o.sha256) });
    await cases.startAnalysis(req.user, id);
    const search = b.search === "false" ? null : await searchFor(req.user, id, b.search === "true");
    const cs = cases.mustCase(id);
    res.status(201).json({ ...verifyResult(id, search), media: added, media_errors: mediaErrors, text_basis: textBasis,
      post: { url: cs.source_url, platform: cs.source_platform, account: cs.source_account, posted_at: cs.published_at, posted_basis: cs.published_basis, archived_sha256: cs.source_snapshot_sha256 || null, lookup_status: L ? L.status : null, lookup_message: L?.message || null },
      io_context: social.ioContext({ account: cs.source_account, text: cs.claim_text, training: !!cs.is_training }) });
  }));
  api.get("/cases/:id/snapshot", (req, res) => {
    const c = cases.mustCase(req.params.id); if (!c.source_snapshot_sha256) throw new HttpError(404, "No archived copy of a source page for this case.");
    audit(req.user, "Archived source page downloaded", "case", c.id, { sha256: c.source_snapshot_sha256 });
    res.sendFile(storage.pathOf(c.source_snapshot_sha256), { headers: { "Content-Type": c.source_snapshot_mime === "application/pdf" ? "application/pdf" : `${c.source_snapshot_mime || "text/html"}; charset=utf-8`, "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${c.id}-source-${c.source_snapshot_sha256.slice(0, 12)}.${c.source_snapshot_mime === "text/plain" ? "txt" : c.source_snapshot_mime === "application/pdf" ? "pdf" : "html"}"` } });
  });

  // ---------------------------------------------------------------- evidence retrieval and source checks
  api.get("/search-services", (req, res) => res.json({ services: retrieval.status(), official: OFFICIAL_SOURCES }));
  api.post("/cases/:id/retrieve", requirePerm("case.edit"), h(async (req, res) => {
    const b = req.body || {}, use = Array.isArray(b.use) ? b.use.filter(k => retrieval.connectors[k]) : undefined;
    res.json(await retrieval.retrieve(req.user, req.params.id, { claimIds: Array.isArray(b.claim_ids) ? b.claim_ids : undefined, use }, cases));
  }));
  // retrieve and archive the page an evidence item cites; check quotations in the case against its text
  api.post("/evidence/:eid/check-source", requirePerm("case.edit"), h(async (req, res) => {
    const e = db.prepare("SELECT * FROM evidence WHERE id = ?").get(req.params.eid); if (!e) throw new HttpError(404, "Evidence not found.");
    const c = cases.mustCase(e.case_id); cases.requireEdit(req.user, c);
    const url = e.source_url || (String(e.reference || "").match(/https?:\/\/\S+/) || [])[0]; if (!url) throw new HttpError(400, "This evidence has no web link to check.");
    let page; try { page = await fetchPage(url, { allowPrivate: !!config.allowPrivateFetch }); }
    catch (er) { cases.change(req.user, c.id, `Source link of ${e.id} could not be retrieved`, () => {}, { url, error: er.message }); throw er; }
    const snap = await storage.putBuffer(page.raw, page.mime);
    const norm = s => String(s || "").toLowerCase().replace(/[“”"‘’'`]/g, "").replace(/\s+/g, " ").trim(), body = norm(`${page.title || ""} ${page.text}`);
    const quotes = [...new Set([...String(c.claim_text).matchAll(/[“"]([^”"]{12,300})[”"]/g)].map(m => m[1].trim()))];
    const quoteResults = quotes.map(q => ({ quote: q, found: body.includes(norm(q)), partial: !body.includes(norm(q)) && norm(q).split(" ").filter(w => w.length > 3).filter(w => body.includes(w)).length / Math.max(1, norm(q).split(" ").filter(w => w.length > 3).length) }));
    cases.change(req.user, c.id, `Source of ${e.id} retrieved and archived`, () => db.prepare("UPDATE evidence SET snapshot_sha256 = ?, source_title = COALESCE(source_title, ?), source_published_at = COALESCE(source_published_at, ?) WHERE id = ?").run(snap.sha256, page.title, page.published, e.id),
      { url, final_url: page.finalUrl, sha256: snap.sha256, quotes: quoteResults.map(q => ({ found: q.found })) });
    res.json({ final_url: page.finalUrl, title: page.title, published: page.published, published_basis: page.publishedBasis, sha256: snap.sha256, bytes: page.raw.length, quotes: quoteResults });
  }));
  api.get("/evidence/:eid/snapshot", (req, res) => {
    const e = db.prepare("SELECT * FROM evidence WHERE id = ?").get(req.params.eid); if (!e?.snapshot_sha256) throw new HttpError(404, "No archived copy for this evidence.");
    res.sendFile(storage.pathOf(e.snapshot_sha256), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="${e.id}-source-${e.snapshot_sha256.slice(0, 12)}.html"` } });
  });
  // the analyst adopts a suggested verdict (it never applies itself)
  api.post("/claims/:cid/apply-suggestion", requirePerm("case.edit"), h((req, res) => {
    const cl = db.prepare("SELECT * FROM claims WHERE id = ?").get(req.params.cid); if (!cl) throw new HttpError(404, "Claim not found.");
    if (!cl.suggested_assessment) throw new HttpError(409, "There is no suggested verdict for this claim.");
    cases.updateClaim(req.user, cl.id, { assessment: cl.suggested_assessment, rationale: String(cl.rationale || "").trim() ? cl.rationale : `Adopted AIVS suggestion after review. ${cl.suggested_basis}` });
    res.json({ ok: true, assessment: cl.suggested_assessment });
  }));
  // related cases
  api.post("/cases/:id/links", requirePerm("case.edit"), h((req, res) => {
    const c = cases.mustCase(req.params.id), other = cases.mustCase(String(req.body?.related_id || "").trim());
    if (other.id === c.id) throw new HttpError(400, "A case cannot be linked to itself.");
    if (other.is_training !== c.is_training) throw new HttpError(400, "Training and operational cases cannot be linked.");
    const rel = ["same_content", "same_claim", "same_campaign", "follow_up", "related"].includes(req.body?.relation) ? req.body.relation : "related";
    db.transaction(() => { for (const [a, b2] of [[c.id, other.id], [other.id, c.id]]) db.prepare("INSERT OR REPLACE INTO case_links(case_id,related_id,relation,note,created_by,created_at) VALUES (?,?,?,?,?,?)").run(a, b2, rel, String(req.body?.note || "").slice(0, 500) || null, req.user.id, nowISO()); })();
    audit(req.user, `Linked to ${other.id} (${rel})`, "case", c.id); audit(req.user, `Linked to ${c.id} (${rel})`, "case", other.id);
    res.status(201).json({ ok: true });
  }));
  api.delete("/cases/:id/links/:rid", requirePerm("case.edit"), h((req, res) => {
    const c = cases.mustCase(req.params.id);
    db.prepare("DELETE FROM case_links WHERE (case_id = ? AND related_id = ?) OR (case_id = ? AND related_id = ?)").run(c.id, req.params.rid, req.params.rid, c.id);
    audit(req.user, `Link to ${req.params.rid} removed`, "case", c.id); res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- dataset registry and knowledge base
  const kbUpload = multer({ dest: storage.tmpDir, limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 30 } });
  api.get("/kb/datasets", (req, res) => res.json({ datasets: kb.list() }));
  api.post("/kb/datasets", requirePerm("archive.manage"), kbUpload.single("file"), h((req, res) => {
    const f = req.file; if (!f) throw new HttpError(400, "Choose a dataset file (CSV, JSON, JSON Lines or TSV).");
    let buf; try { buf = fs.readFileSync(f.path); } finally { cleanup([f]); }
    res.status(201).json(kb.importDataset(req.user, { buf, filename: f.originalname, ...req.body, synthetic: false }));
  }));
  api.post("/kb/sample", requirePerm("archive.manage"), h((req, res) => res.status(201).json(kb.importDataset(req.user, { buf: Buffer.from(sampleKb()), filename: "sample.json", name: "SYNTHETIC practice fact-checks", license: "Synthetic data created by AIVS; no third-party content", permitted_use: "Training cases only", languages: "en, sw", limitations: "Invented claims for practice. Used only for training cases.", synthetic: true }))));
  api.get("/kb/datasets/:id", (req, res) => res.json(kb.detail(req.params.id, req.query)));
  api.post("/kb/datasets/:id/approve", requirePerm("archive.manage"), h((req, res) => { kb.approve(req.user, req.params.id, { use_retrieval: req.body?.use_retrieval !== false }); res.json({ ok: true }); }));
  api.post("/kb/datasets/:id/retire", requirePerm("archive.manage"), h((req, res) => { kb.retire(req.user, req.params.id); res.json({ ok: true }); }));
  api.post("/kb/datasets/:id/evaluate", requirePerm("archive.manage"), h((req, res) => res.json({ metrics: kb.evaluate(req.user, req.params.id, req.body || {}) })));
  api.patch("/kb/records/:rid", requirePerm("archive.manage"), h((req, res) => { kb.review(req.user, req.params.rid, req.body || {}); res.json({ ok: true }); }));
  api.get("/kb/datasets/:id/records.csv", (req, res) => { const d = kb.get(req.params.id), sp = ["train", "validation", "test"].includes(req.query.split) ? req.query.split : null; audit(req.user, "Dataset exported", "kb_dataset", String(d.id), { split: sp }); res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="aivs-kb-${d.id}${sp ? `-${sp}` : ""}.csv"`); res.send(kb.exportCsv(d.id, sp)); });

  // ---------------------------------------------------------------- research assistant
  // ---------------------------------------------------------------- AI models: what runs, how it was trained, how well it scores
  api.get("/ai/models", (req, res) => {
    const evals = []; try { for (const f of fs.readdirSync(MODELS_DIR).filter(f => f.endsWith(".eval.json")).sort()) { try { evals.push(JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f), "utf8"))); } catch {} } } catch {}
    const m = sentimentModel();
    res.json({ models: evals.map(e => ({ ...e, loaded: !!m && m.m.id === e.id })), word_list: sentimentEvaluation(),
      note: "Scores were measured once on held-out test data that the model never saw during training. They describe performance on that data, not on Kenyan posts." });
  });
  api.post("/ai/models/sentiment/try", h((req, res) => {
    const text = String(req.body?.text || "").trim().slice(0, 2000); if (!text) throw new HttpError(400, "Type a sentence to classify.");
    const r = classifySentiment(text), m = sentimentModel();
    res.json({ ...r, explanation: m && r.method === m.m.id ? m.explain(text, 8) : [] });
  }));

  // content analysis: what the source shows, the claims, automatic estimates and what is missing, kept apart
  api.get("/cases/:id/content-analysis", h(async (req, res) => {
    const agg = cases.aggregate(req.params.id, { forUser: req.user }), c = agg.case;
    const rec = db.prepare("SELECT details FROM audit_log WHERE entity = 'case' AND entity_id = ? AND action = 'Social media post recorded' ORDER BY id LIMIT 1").get(c.id);
    let extraction = null; try { extraction = rec ? JSON.parse(rec.details) : null; } catch {}
    const io = social.ioContext({ account: c.source_account, text: c.claim_text, training: !!c.is_training });
    const a = ai.status();
    res.json(analyseContent({ agg, extraction, io, matches: agg.matches || [], evidenceServices: retrieval.status(), ai: { ready: !!(a.configured && a.enabled) } }));
  }));
  api.get("/cases/:id/assistant", (req, res) => { const c = cases.mustCase(req.params.id); res.json({ messages: assistant.list(c.id), ai: ai.status(), is_training: !!c.is_training }); });
  // real health check of the AI connection; ?cached=1 returns the last result at once and refreshes it in the background
  api.get("/ai/health", h(async (req, res) => {
    if (req.query.cached === "1") { ai.health().catch(() => {}); return res.json({ ...ai.status().health, ai: ai.status() }); }
    const force = req.query.force === "1"; if (force) audit(req.user, "AI connection checked", "settings", "ai", { provider: config.ai.provider, model: config.ai.model });
    const hs = await ai.health({ force }); res.json({ ...hs, ai: ai.status() });
  }));
  api.post("/cases/:id/assistant", requirePerm("note.write"), h(async (req, res) => {
    const b = req.body || {}; if (b.mode === "ai" && !can(req.user, "ai.request")) throw new HttpError(403, "Your role cannot send case content to the AI service.");
    res.status(201).json(await assistant.ask(req.user, req.params.id, { question: b.question, mode: b.mode === "ai" ? "ai" : "rules" }));
  }));
  api.delete("/cases/:id/assistant", requirePerm("case.edit"), h((req, res) => { assistant.clear(req.user, req.params.id); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- evidence coverage (per claim; blocking items come from the approval rules)
  api.get("/cases/:id/coverage", (req, res) => res.json(coverage.build(cases.mustCase(req.params.id).id, req.user, req.query.lang === "sw" ? "sw" : "en")));
  api.post("/cases/:id/gaps", requirePerm("case.edit"), h((req, res) => res.status(201).json({ id: coverage.addGap(req.user, req.params.id, req.body || {}) })));
  api.patch("/gaps/:gid", requirePerm("case.edit"), h((req, res) => { coverage.updateGap(req.user, req.params.gid, req.body || {}); res.json({ ok: true }); }));
  api.post("/cases/:id/coverage/ai", requirePerm("ai.request"), h(async (req, res) => res.json(await coverage.suggest(req.user, req.params.id, { lang: req.body?.lang }))));

  // ---------------------------------------------------------------- information operations monitor
  const ioUpload = multer({ dest: storage.tmpDir, limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 30 } });
  const MAP_KEYS = ["text", "account", "posted_at", "platform", "post_id", "url", "reply_to", "repost_of", "likes", "comments", "shares", "views", "language", "collected_at", "loc_country", "loc_region", "loc_name", "profile_location", "account_created_at"];
  api.get("/io/datasets", (req, res) => res.json({ datasets: io.list(), caveats: IO_CAVEATS }));
  api.post("/io/datasets", requirePerm("io.import"), ioUpload.single("file"), h((req, res) => {
    const f = req.file; if (!f) throw new HttpError(400, "Choose a CSV or JSON file of posts.");
    let buf; try { buf = fs.readFileSync(f.path); } finally { cleanup([f]); }
    const b = req.body || {}, mapping = {}; for (const k of MAP_KEYS) if (b[`map_${k}`]) mapping[k] = String(b[`map_${k}`]);
    res.status(201).json(io.importPosts(req.user, { buf, filename: f.originalname, name: b.name, description: b.description, source: b.source, authorisation: b.authorisation, mapping, researchQuestion: b.research_question, method: b.method === "screenshots" ? "screenshots" : "file" }));
  }));
  api.post("/io/datasets/:id/add", requirePerm("io.import"), ioUpload.single("file"), h((req, res) => {
    const f = req.file; if (!f) throw new HttpError(400, "Choose a CSV or JSON file, or screenshots, with the posts to add.");
    let buf; try { buf = fs.readFileSync(f.path); } finally { cleanup([f]); }
    const b = req.body || {}, mapping = {}; for (const k of MAP_KEYS) if (b[`map_${k}`]) mapping[k] = String(b[`map_${k}`]);
    res.json(io.appendPosts(req.user, req.params.id, { buf, filename: f.originalname, mapping, note: b.note }));
  }));
  api.post("/io/sample", requirePerm("io.import"), h((req, res) => {
    const rows = sampleDataset(), csv = ["account,posted_at,text,platform,repost_of,account_created_at", ...rows.map(r => [r.account, r.posted_at, r.text, r.platform, r.repost_of || "", r.account_created_at || ""].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    res.status(201).json(io.importPosts(req.user, { buf: Buffer.from(csv), filename: "sample.csv", name: "SYNTHETIC SAMPLE: invented posts with a planted pattern", description: "Invented accounts and posts for practice. One planted pattern: 14 new accounts post near-identical text with the same link within minutes, twice, on two platforms. Also a repost wave. Nothing here is real.", source: "Generated by AIVS for training", authorisation: "Synthetic data, no real people", isSample: true }));
  }));
  api.get("/io/datasets/:id", (req, res) => { const d = io.getDataset(req.params.id), { analysis_json, ...meta } = d; res.json({ dataset: meta, analysis: analysis_json ? JSON.parse(analysis_json) : null }); });
  api.post("/io/datasets/:id/analyse", requirePerm("io.import"), h((req, res) => res.json({ analysis: io.runAnalysis(req.user, req.params.id, req.body || {}) })));
  api.get("/io/datasets/:id/posts", (req, res) => res.json(io.posts(req.params.id, req.query)));
  api.get("/io/datasets/:id/signals.:fmt(csv|json)", (req, res) => {
    const d = io.getDataset(req.params.id), name = `aivs-io-${d.id}-signals`;
    audit(req.user, "Post dataset signals exported", "io_dataset", String(d.id), { format: req.params.fmt });
    if (req.params.fmt === "csv") { res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`); return res.send(io.exportCsv(d.id)); }
    res.setHeader("Content-Disposition", `attachment; filename="${name}.json"`); res.json({ dataset: { id: d.id, name: d.name, source: d.source, authorisation: d.authorisation, sha256: d.file_sha256, sample: !!d.is_sample }, analysis: JSON.parse(d.analysis_json || "null") });
  });
  api.delete("/io/datasets/:id", requirePerm("settings.manage"), h((req, res) => { io.remove(req.user, req.params.id); res.json({ ok: true }); }));
  // open a case from a repeated message: the representative text becomes the content to verify
  api.post("/io/datasets/:id/clusters/:cid/case", requirePerm("case.create"), h(async (req, res) => {
    const d = io.getDataset(req.params.id), a = JSON.parse(d.analysis_json || "null"), c = a?.clusters?.find(x => x.id === Number(req.params.cid));
    if (!c) throw new HttpError(404, "That repeated message was not found. Re-run the analysis.");
    const id = cases.create(req.user, { title: `Repeated message: ${c.text.slice(0, 80)}`, claim_text: c.text, source_platform: c.platforms.join(", ") || "Post dataset", source_account: `${c.accounts} accounts (dataset ${d.id})`, received_at: nowISO(), priority: "routine", is_training: !!d.is_sample,
      hashtags: [...new Set((c.text.match(/#[\p{L}\p{N}_]+/gu) || []))].join(" ") });
    audit(req.user, `Case opened from post dataset ${d.id}, repeated message ${c.id}`, "case", id, { posts: c.posts, accounts: c.accounts, synchronised: c.synchronised });
    res.status(201).json({ id });
  }));

  // ---------------------------------------------------------------- KDF Mention Watch: watchlists, collection status, alert queue
  const assignable = () => users().filter(u => u.active && u.role !== "viewer").map(u => ({ id: u.id, name: u.display_name, role: u.role }));
  // the template starts with the sources that are connected on this server (X recent search is kept so its status shows)
  const template = () => { const t = kdfTemplate(), ready = ["x_search", "youtube", "reddit", "bluesky", "mastodon", "threads", "instagram", "tiktok"].filter(s => watchCollector.sourcesReady(s));
    t.definition.sources = [...new Set([...(ready.length ? ready : ["x_search"]), ...(String(config.collect?.rssFeeds || "").trim() ? ["news"] : [])])]; return t; };
  api.get("/watch/overview", (req, res) => res.json({ status: watchCollector.status(), caveats: WATCH_CAVEATS, sources: WATCH_SOURCES, manual_sources: MANUAL_SOURCES, watchlists: watch.list(), template: template(), users: assignable(),
    alert_counts: Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM watch_alerts GROUP BY status").all().map(r => [r.status, r.n])),
    datasets: db.prepare("SELECT id, name, posts, first_at, last_at, is_sample, imported_at FROM io_datasets ORDER BY id DESC").all(),
    stats: { monitored_posts: db.prepare("SELECT COUNT(DISTINCT m.post_id) n FROM watch_matches m JOIN watchlists w ON w.id = m.watchlist_id WHERE w.deleted_at IS NULL").get().n,
      open_by_severity: Object.fromEntries(db.prepare("SELECT coalesce(a.severity,'low') s, COUNT(*) n FROM watch_alerts a JOIN watchlists w ON w.id = a.watchlist_id WHERE a.status IN ('new','acknowledged') GROUP BY s").all().map(r => [r.s, r.n])),
      monitoring: (() => {
        const act = db.prepare("SELECT id FROM watchlists WHERE status = 'active' AND deleted_at IS NULL").all().map(r => r.id);
        const sc = act.length ? db.prepare(`SELECT COALESCE(SUM(posts_checked),0) checked, COALESCE(SUM(matched),0) matched, MAX(CASE WHEN status = 'ok' THEN scanned_at END) last_ok, SUM(status = 'failed') failed FROM watch_dataset_scans WHERE watchlist_id IN (${act.map(() => "?").join(",")})`).get(...act) : { checked: 0, matched: 0, last_ok: null, failed: 0 };
        // a live platform counts only if an active watchlist uses it and it is configured
        const used = new Set(db.prepare("SELECT definition_json FROM watchlists WHERE status = 'active' AND deleted_at IS NULL").all().flatMap(r => { try { return JSON.parse(r.definition_json).sources || []; } catch { return []; } }));
        const live = Object.keys(WATCH_SOURCES).filter(k => used.has(k) && watchCollector.sourcesReady(k));
        return { active_watchlists: act.length, datasets: db.prepare("SELECT COUNT(*) n FROM io_datasets").get().n, posts_checked: sc.checked, posts_matched: sc.matched, last_successful_analysis: sc.last_ok, failed_checks: sc.failed || 0,
          live_sources_connected: live.map(k => WATCH_SOURCES[k].label), scheduler_enabled: watchCollector.status().scheduler?.enabled ?? null };
      })(),
      recent_scans: db.prepare("SELECT s.watchlist_id, w.name watchlist, s.dataset_id, d.name dataset, s.posts_checked, s.matched, s.scanned_at, s.status, s.error FROM watch_dataset_scans s JOIN watchlists w ON w.id = s.watchlist_id LEFT JOIN io_datasets d ON d.id = s.dataset_id WHERE w.deleted_at IS NULL ORDER BY s.scanned_at DESC LIMIT 8").all() },
    severity_rules: SEVERITY_RULES, actions: WATCH_ACTIONS }));
  api.post("/watch/lists", requirePerm("watch.manage"), h((req, res) => res.status(201).json({ id: watch.create(req.user, req.body || {}) })));
  api.get("/watch/lists/:id", (req, res) => {
    const wl = watch.get(req.params.id);
    res.json({ watchlist: wl, queries: { x: xQuery(wl.definition), x_stream: xQuery(wl.definition, { stream: true }), youtube: youtubeQuery(wl.definition) },
      sources: wl.definition.sources.map(s => ({ source: s, label: WATCH_SOURCES[s].label, ready: watchCollector.sourcesReady(s), state: db.prepare("SELECT * FROM watch_source_state WHERE watchlist_id = ? AND source = ?").get(wl.id, s) || null })),
      runs: db.prepare("SELECT * FROM watch_runs WHERE watchlist_id = ? OR (watchlist_id IS NULL AND ? = 1) ORDER BY id DESC LIMIT 40").all(wl.id, wl.definition.sources.includes("x_stream") ? 1 : 0),
      volume: watch.volume(wl), versions: db.prepare("SELECT v.id, v.definition_sha256, v.status, v.changed_at, v.note, u.display_name by_name FROM watchlist_versions v LEFT JOIN users u ON u.id = v.changed_by WHERE watchlist_id = ? ORDER BY v.id DESC LIMIT 30").all(wl.id) });
  });
  api.patch("/watch/lists/:id", requirePerm("watch.manage"), h((req, res) => { const r = watch.update(req.user, req.params.id, req.body || {}); watchCollector.ensureStream(); res.json(r); }));
  // try terms against example sentences without saving anything
  api.post("/watch/test", requirePerm("watch.manage"), h((req, res) => {
    const def = normaliseDefinition(req.body?.definition || {}), samples = (Array.isArray(req.body?.samples) ? req.body.samples : String(req.body?.samples || "").split(/\r?\n/)).map(x => String(x).trim()).filter(Boolean).slice(0, 50);
    res.json({ queries: { x: xQuery(def), x_stream: xQuery(def, { stream: true }), youtube: youtubeQuery(def) }, results: samples.map(text => ({ text, ...matchPost(def, { text }), highlights: watchHighlights(def, text) })) });
  }));
  // preview before activation: stored posts (no cost), example sentences, and optionally one live request per source (costs shown)
  api.post("/watch/lists/:id/preview", requirePerm("watch.manage"), h(async (req, res) => {
    const wl = watch.get(req.params.id), def = wl.definition, b = req.body || {}, test = (p, origin) => ({ ...p, origin, ...matchPost(def, p) });
    const stored = [...db.prepare("SELECT platform, account, text, url, posted_at, language, repost_of FROM watch_posts ORDER BY id DESC LIMIT 5000").all().map(p => test(p, "earlier mention-watch collection")),
      ...db.prepare("SELECT p.platform, p.account, p.text, p.url, p.posted_at, p.language, p.repost_of FROM io_posts p JOIN io_datasets d ON d.id = p.dataset_id WHERE d.is_sample = 0 OR ? = 1 OR d.id IN (SELECT value FROM json_each(?)) ORDER BY p.id DESC LIMIT 5000").all(def.all_datasets ? 1 : 0, JSON.stringify(def.datasets || [])).map(p => test(p, "imported post dataset"))];
    const samples = (Array.isArray(b.samples) ? b.samples : String(b.samples || "").split(/\r?\n/)).map(x => String(x).trim()).filter(Boolean).slice(0, 50).map(text => test({ text }, "example you typed"));
    const all = [...samples, ...stored], m = all.filter(x => x.matched), ex = all.filter(x => !x.matched && x.terms?.length);
    const pick = (arr, n) => arr.slice(0, n).map(x => ({ origin: x.origin, platform: x.platform || null, account: x.account || null, text: String(x.text).slice(0, 500), url: x.url || null, posted_at: x.posted_at || null, terms: x.terms || [], context: x.context || [], why: x.why || null, highlights: watchHighlights(def, String(x.text).slice(0, 500)) }));
    const local = { checked: all.length, matched: m.length, excluded: ex.length, matches: pick(m, 30), excluded_examples: pick(ex, 20), samples: samples.map(x => ({ text: x.text, matched: x.matched, why: x.why || null, terms: x.terms || [] })) };
    let live = null;
    if (b.live) {
      const want = (Array.isArray(b.live_sources) ? b.live_sources : def.sources).filter(x => def.sources.includes(x) && WATCH_SOURCES[x]?.mode !== "webhook");
      live = await watchCollector.previewLive(def, [...new Set(want.map(x => (x === "x_stream" && want.includes("x_search") ? null : x)).filter(Boolean))], { max: Math.min(100, Math.max(10, +b.max || 25)) });
    }
    const preview = { local: { checked: local.checked, matched: local.matched, excluded: local.excluded }, live, queries: { x: xQuery(def), x_stream: xQuery(def, { stream: true }), youtube: youtubeQuery(def) } };
    watch.recordPreview(req.user, wl.id, preview);
    res.json({ ...preview, local, definition_sha256: wl.definition_sha256 });
  }));
  api.post("/watch/lists/:id/status", requirePerm("watch.manage"), h(async (req, res) => {
    const st = req.body?.status; if (!["active", "paused", "draft"].includes(st)) throw new HttpError(400, "Status must be active, paused or draft.");
    if (st === "active") {   // the stream rule is checked with X (dry run) before it is added
      const cur = watch.get(req.params.id);
      if (cur.definition.sources.includes("x_stream") && watchCollector.sourcesReady("x_stream")) {
        const q = xQuery(cur.definition, { stream: true }); if (!q.ok) throw new HttpError(400, q.problem);
        let v; try { v = await watchCollector.validateRule(q.query); } catch (e) { throw new HttpError(502, `The stream rule could not be checked with X: ${e.message}`); }
        if (!v.valid) throw new HttpError(400, `X rejected the stream rule: ${v.errors.join("; ")}`);
      }
    }
    const wl = watch.setStatus(req.user, req.params.id, st, s => watchCollector.sourcesReady(s));
    watchCollector.ensureStream();
    let datasets = null;
    if (st === "active" && (wl.definition.all_datasets || wl.definition.datasets?.length)) { try { datasets = dsWatch.scanAll(wl, { user: req.user }); } catch (e) { datasets = { error: e.message }; } }
    const notReady = st === "active" ? wl.definition.sources.filter(s => !watchCollector.sourcesReady(s)) : [];
    res.json({ status: wl.status, not_connected: notReady.map(s => WATCH_SOURCES[s].label), datasets });
  }));
  api.post("/watch/lists/:id/run", requirePerm("watch.manage"), h(async (req, res) => {
    const wl = watch.get(req.params.id), src = req.body?.source;
    if (wl.status !== "active") throw new HttpError(409, "Activate the watchlist first.");
    if (!wl.definition.sources.includes(src) || WATCH_SOURCES[src]?.mode !== "poll") throw new HttpError(400, "Choose one of this watchlist's scheduled sources.");
    audit(req.user, "Mention watch collection run started by hand", "watchlist", String(wl.id), { source: src });
    const r = await watchCollector.runSource(wl, src, { kind: "manual" }); watch.checkVolume(watch.get(wl.id)); res.json(r);
  }));
  api.get("/watch/lists/:id/matches", (req, res) => res.json(watch.matches(req.params.id, req.query)));
  // historical analysis of the imported datasets a watchlist monitors: check new posts, then run the detectors
  api.post("/watch/lists/:id/analyse", requirePerm("watch.manage"), h((req, res) => {
    const wl = watch.get(req.params.id); if (wl.deleted_at) throw new HttpError(404, "Watchlist not found.");
    if (wl.status !== "active") throw new HttpError(409, "Activate the watchlist first.");
    if (!wl.definition.all_datasets && !wl.definition.datasets?.length) throw new HttpError(400, "Choose at least one imported dataset for this watchlist to monitor.");
    res.json(dsWatch.scanAll(wl, { user: req.user }));
  }));
  api.get("/watch/lists/:id/analytics", (req, res) => res.json(dsWatch.analytics(req.params.id)));
  api.delete("/watch/lists/:id", requirePerm("watch.manage"), h((req, res) => { watch.remove(req.user, req.params.id); watchCollector.ensureStream(); res.json({ ok: true }); }));
  api.get("/watch/alerts", (req, res) => res.json(watch.alerts(req.query, req.user)));
  api.get("/watch/alerts/:id", (req, res) => res.json(watch.alert(req.params.id)));
  api.post("/watch/alerts/:id/action", requirePerm("watch.triage"), h((req, res) => res.json(watch.act(req.user, req.params.id, req.body || {}, { canAssignOthers: can(req.user, "case.assign"), canCreateCase: can(req.user, "case.create") }))));
  // live verification of one configured source (a real request; the result is shown next to the capability table)
  api.post("/watch/sources/:key/check", requirePerm("settings.manage"), h(async (req, res) => {
    const key = req.params.key; if (!WATCH_SOURCES[key]) throw new HttpError(404, "Unknown source.");
    if (!watchCollector.sourcesReady(key)) throw new HttpError(409, `${WATCH_SOURCES[key].label} is not configured.`);
    const wl = watch.list().find(w => w.status === "active") || null, def = wl ? wl.definition : kdfTemplate().definition;
    res.json(await watchCollector.liveCheck(req.user, key, def));
  }));
  // a public post an analyst found on a platform AIVS cannot collect from: added to the watchlist, labelled as submitted by hand
  api.post("/watch/lists/:id/submit", requirePerm("watch.triage"), h(async (req, res) => {
    const wl = watch.get(req.params.id), b = req.body || {}, L = parseSourceLink(String(b.url || "").trim());
    if (!L || !/^https?:\/\//.test(L.url)) throw new HttpError(400, "Paste the public link of the post.");
    let text = String(b.text || "").trim(), basis = "text pasted by the analyst", posted = b.posted_at && !isNaN(Date.parse(b.posted_at)) ? new Date(b.posted_at).toISOString() : L.published_at || null, account = String(b.account || "").trim() || L.account || null;
    if (!text) { const r = await social.lookup(L.url).catch(() => null); if (r?.text) { text = r.text; basis = r.text_source; posted = posted || r.posted_at || null; account = account || r.account || null; } }
    if (!text) throw new HttpError(400, "AIVS could not read this post's text from the platform's public embed. Paste the text of the post.");
    const m = matchPost(wl.definition, { text });
    if (!m.matched) throw new HttpError(422, `This post does not match the watchlist (${m.why}). Open it in Verify information instead if it still needs checking.`);
    const via = `Public link submitted by ${req.user.display_name} (${basis})`;
    const r = watch.ingest(wl, "manual_link", [{ platform: L.platform.replace(/ \(website\)$/, ""), post_id: L.post_id || L.url, url: L.url, account, text, posted_at: posted, collected_via: via }]);
    audit(req.user, "Public link submitted to mention watch", "watchlist", String(wl.id), { url: L.url, platform: L.platform, stored: r.new_matches });
    res.status(201).json({ ...r, platform: L.platform, text_basis: basis });
  }));
  // posts from an export you are permitted to use (CSV, JSON or .xlsx), labelled as a file import with its fingerprint
  const watchUpload = multer({ dest: storage.tmpDir, limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10 } });
  api.post("/watch/lists/:id/import", requirePerm("watch.manage"), watchUpload.single("file"), h((req, res) => {
    const wl = watch.get(req.params.id), f = req.file, b = req.body || {}; if (!f) throw new HttpError(400, "Choose a CSV, JSON or Excel file of posts.");
    let buf; try { buf = fs.readFileSync(f.path); } finally { cleanup([f]); }
    if (!String(b.authorisation || "").trim()) throw new HttpError(400, "State where the file comes from and why you may use it (for example: export from our own Page's insights, or a partner's permitted research export).");
    const rows = parseFile(buf, f.originalname); if (!rows.length) throw new HttpError(400, "The file has no rows.");
    if (rows.length > 20000) throw new HttpError(400, "At most 20,000 rows per import.");
    const map = detectMapping(Object.keys(rows[0])); if (!map.text) throw new HttpError(400, "The file needs a column with the post text (for example text, message or caption).");
    const sha = crypto.createHash("sha256").update(buf).digest("hex"), num = v => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v)), via = `File import “${f.originalname}” (SHA-256 ${sha.slice(0, 12)}) by ${req.user.display_name}; basis: ${String(b.authorisation).trim().slice(0, 200)}`;
    const out = watch.ingest(wl, "file_import", rows.map((r, i) => { const t = map.posted_at ? Date.parse(r[map.posted_at]) : NaN, url = map.url ? String(r[map.url] || "").trim() : "";
      return { platform: (map.platform && String(r[map.platform] || "").trim()) || String(b.platform || "").trim() || "Not stated", post_id: (map.post_id && String(r[map.post_id] || "").trim()) || url || `${sha.slice(0, 12)}:${i}`, url: /^https?:\/\//.test(url) ? url : null,
        account: map.account ? String(r[map.account] || "").trim() || null : null, text: String(r[map.text] || ""), posted_at: isNaN(t) ? null : new Date(t).toISOString(), language: map.language ? r[map.language] || null : null,
        likes: map.likes ? num(r[map.likes]) : null, comments: map.comments ? num(r[map.comments]) : null, shares: map.shares ? num(r[map.shares]) : null, views: map.views ? num(r[map.views]) : null, collected_via: via }; }));
    audit(req.user, "Posts imported into mention watch", "watchlist", String(wl.id), { file: f.originalname, sha256: sha, rows: rows.length, matched: out.matched, authorisation: String(b.authorisation).slice(0, 300) });
    res.status(201).json({ rows: rows.length, ...out, columns: map });
  }));
  api.post("/watch/stream/reconnect", requirePerm("settings.manage"), h((req, res) => { watchCollector.reconnect(req.user); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- Social media analysis (content analysis, claims, AI, collection, reports)
  const dsMeta = d => { const { analysis_json, enrich_json, ...m } = d; return { ...m, content: enrich_json ? JSON.parse(enrich_json) : null }; };
  api.get("/social/overview", h(async (req, res) => {
    const jobs = db.prepare("SELECT j.id, j.dataset_id, j.kind, j.status, j.progress, j.counts_json, j.error, j.created_at, j.finished_at, u.display_name AS by_name FROM io_jobs j LEFT JOIN users u ON u.id = j.created_by ORDER BY j.id DESC LIMIT 15").all().map(j => ({ ...j, counts: JSON.parse(j.counts_json || "null"), counts_json: undefined }));
    res.json({ collectors: collectors.status(), ollama: await ollama.status(), jobs, themes: Object.fromEntries(Object.entries(THEMES).map(([k, [l]]) => [k, l])), sentiment_labels: SENTIMENT_LABELS, limitations: SOCIAL_LIMITATIONS });
  }));
  api.get("/social/sentiment-evaluation", (req, res) => res.json(sentimentEvaluation()));
  // SYNTHETIC election dataset with planted patterns, for demonstrating and testing the AI Watchlist
  api.post("/io/watch-demo", requirePerm("io.import"), h((req, res) => {
    const rows = watchDemoRows();
    res.status(201).json(io.importPosts(req.user, { rowsIn: rows, filename: "synthetic-election-watch-demo.json", name: WATCH_DEMO.name, description: WATCH_DEMO.description, source: WATCH_DEMO.source, authorisation: WATCH_DEMO.authorisation, isSample: true, researchQuestion: "Does the AI Watchlist flag the planted rise and the synchronised posts, and nothing else of note?" }));
  }));
  api.post("/io/discussion-sample", requirePerm("io.import"), h((req, res) => {
    const rows = discussionSample();
    res.status(201).json(io.importPosts(req.user, { rowsIn: rows, filename: "synthetic-discussion.json", name: "SYNTHETIC: public discussion sample (services, prices, security, health)", isSample: true, method: "sample",
      description: "Invented posts on invented platforms (SampleNet, SampleTube, SamplePics) for practice. Planted: a security theme that grows in the last days, a repeated claim about boreholes, a recruitment scam message, and one post with very high engagement. Nothing here is real.",
      source: "Generated by AIVS for training", authorisation: "Synthetic data, no real people", researchQuestion: "How does public discussion of services, prices, security and health change over ten days, and which claims need checking?", via: "generated by AIVS (synthetic)" }));
  }));
  api.patch("/io/datasets/:id", requirePerm("io.import"), h((req, res) => {
    const d = io.getDataset(req.params.id), rq = String(req.body?.research_question ?? "").trim().slice(0, 1000) || null;
    db.prepare("UPDATE io_datasets SET research_question = ? WHERE id = ?").run(rq, d.id); audit(req.user, "Research question set", "io_dataset", String(d.id), { research_question: rq }); res.json({ ok: true });
  }));
  api.post("/io/datasets/:id/enrich", requirePerm("io.import"), h((req, res) => { const d = io.getDataset(req.params.id), jid = io.job(req.user, d.id, "content_analysis", {}); try { const m = enrichPosts(db, d.id); io.jobDone(jid, { counts: { posts: m.posts, topics: m.topics, claims: m.claims } }); audit(req.user, "Post dataset content analysed", "io_dataset", String(d.id), { topics: m.topics, claims: m.claims }); res.json(m); } catch (e) { io.jobDone(jid, { error: e.message }); throw e; } }));
  api.get("/io/datasets/:id/insights", h((req, res) => {
    const d = io.getDataset(req.params.id), I = insights(db, d.id, cleanFilters(req.query));
    I.platformsAll = db.prepare("SELECT coalesce(platform,'Not stated') p, COUNT(*) n FROM io_posts WHERE dataset_id = ? GROUP BY 1 ORDER BY n DESC").all(d.id).map(r => r.p);
    I.topicsAll = db.prepare("SELECT topic_no, label FROM io_topics WHERE dataset_id = ? ORDER BY topic_no").all(d.id);
    I.claimCounts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM io_claims WHERE dataset_id = ? GROUP BY status").all(d.id).map(r => [r.status, r.n]));
    res.json({ dataset: dsMeta(d), insights: I });
  }));
  api.get("/io/datasets/:id/claims", h((req, res) => {
    const d = io.getDataset(req.params.id), q = req.query, w = ["c.dataset_id = ?"], P = [d.id];
    if (["unreviewed", "needs_review", "in_case", "dismissed"].includes(q.status)) { w.push("c.status = ?"); P.push(q.status); }
    if (q.q) { w.push("lower(c.text) LIKE ?"); P.push(`%${String(q.q).toLowerCase().slice(0, 100)}%`); }
    if (q.theme && THEMES[q.theme]) { w.push("c.themes LIKE ?"); P.push(`%"${q.theme}"%`); }
    const limit = Math.min(100, Math.max(1, +q.limit || 25)), offset = Math.max(0, +q.offset || 0);
    const total = db.prepare(`SELECT COUNT(*) n FROM io_claims c WHERE ${w.join(" AND ")}`).get(...P).n;
    const rows = db.prepare(`SELECT c.*, k.status AS case_status, k.conclusion AS case_conclusion, u.display_name AS reviewed_by_name FROM io_claims c LEFT JOIN cases k ON k.id = c.case_id LEFT JOIN users u ON u.id = c.reviewed_by WHERE ${w.join(" AND ")} ORDER BY (c.status = 'needs_review') DESC, c.posts DESC, c.id LIMIT ? OFFSET ?`).all(...P, limit, offset);
    const ev = db.prepare("SELECT e.id, e.text, e.reference, e.source_url, e.source_publisher, e.rating, coalesce(l.stance, 'context') stance FROM evidence e LEFT JOIN evidence_links l ON l.evidence_id = e.id WHERE e.case_id = ? AND e.status = 'accepted' LIMIT 20");
    const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM io_claims WHERE dataset_id = ? GROUP BY status").all(d.id).map(r => [r.status, r.n]));
    res.json({ total, offset, limit, counts, claims: rows.map(c => ({ ...c, post_ids: JSON.parse(c.post_ids), flags: JSON.parse(c.flags || "[]"), kb: JSON.parse(c.kb_json || "[]"), themes: JSON.parse(c.themes || "[]"), kb_json: undefined, case_evidence: c.case_id ? ev.all(c.case_id) : [] })) });
  }));
  const claimOf = id => { const c = db.prepare("SELECT * FROM io_claims WHERE id = ?").get(Number(id)); if (!c) throw new HttpError(404, "Claim not found. Re-run the content analysis."); return c; };
  api.patch("/io/claims/:cid", requirePerm("io.import"), h((req, res) => {
    const c = claimOf(req.params.cid), st = req.body?.status, note = String(req.body?.note || "").trim().slice(0, 1000);
    if (!["unreviewed", "needs_review", "dismissed"].includes(st)) throw new HttpError(400, "Status must be unreviewed, needs_review or dismissed. Use “Verify in a case” to start a verification.");
    if (c.case_id) throw new HttpError(409, `This claim is being verified in case ${c.case_id}; its verdict is decided there.`);
    if (st === "dismissed" && !note) throw new HttpError(400, "Say why the claim needs no verification (for example: not a factual claim, out of scope).");
    db.prepare("UPDATE io_claims SET status = ?, note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(st, note || null, req.user.id, nowISO(), c.id);
    audit(req.user, `Dataset claim marked ${st.replace("_", " ")}`, "io_dataset", String(c.dataset_id), { claim_id: c.id, text: c.text.slice(0, 200), note }); res.json({ ok: true });
  }));
  api.post("/io/claims/:cid/case", requirePerm("case.create"), h(async (req, res) => {
    const c = claimOf(req.params.cid), d = io.getDataset(c.dataset_id); if (c.case_id) throw new HttpError(409, `Already being verified in case ${c.case_id}.`);
    const ids = JSON.parse(c.post_ids), ps = db.prepare(`SELECT platform, account, url, posted_at FROM io_posts WHERE id IN (${ids.slice(0, 200).map(() => "?").join(",") || "NULL"}) ORDER BY posted_at`).all(...ids.slice(0, 200));
    const first = ps[0] || {};
    const id = cases.create(req.user, { title: `Claim from dataset: ${c.text.slice(0, 80)}`, claim_text: c.text, source_platform: [...new Set(ps.map(p => p.platform).filter(Boolean))].join(", ") || "Post dataset", source_account: ps.length > 1 ? `${c.accounts} accounts (dataset ${d.id})` : first.account || null,
      source_url: first.url || null, published_at: first.posted_at || null, published_basis: first.posted_at ? `earliest post with this claim in dataset ${d.id} (“${d.name.slice(0, 80)}”)` : null, received_at: nowISO(), priority: "routine", is_training: !!d.is_sample });
    db.prepare("UPDATE io_claims SET status = 'in_case', case_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(id, req.user.id, nowISO(), c.id);
    audit(req.user, `Case opened from dataset ${d.id}, claim ${c.id}`, "case", id, { posts: c.posts, accounts: c.accounts, kb_matches: JSON.parse(c.kb_json || "[]").length });
    await cases.startAnalysis(req.user, id);
    res.status(201).json({ id });
  }));
  // background jobs: local AI tasks and collection; one at a time per dataset
  const running = new Map();
  function background(jid, key, fn) {
    running.set(key, jid);
    setImmediate(async () => { try { const counts = await fn(p => db.prepare("UPDATE io_jobs SET progress = ? WHERE id = ?").run(Math.round(p * 100) / 100, jid)); io.jobDone(jid, { counts, datasetId: counts?.dataset_id }); } catch (e) { io.jobDone(jid, { error: e.message }); } finally { running.delete(key); } });
  }
  api.get("/io/jobs/:jid", (req, res) => { const j = db.prepare("SELECT * FROM io_jobs WHERE id = ?").get(Number(req.params.jid)); if (!j) throw new HttpError(404, "Job not found."); res.json({ ...j, params: JSON.parse(j.params_json || "null"), counts: JSON.parse(j.counts_json || "null"), params_json: undefined, counts_json: undefined }); });
  api.get("/io/datasets/:id/jobs", (req, res) => res.json({ jobs: db.prepare("SELECT id, kind, status, progress, counts_json, error, created_at, finished_at FROM io_jobs WHERE dataset_id = ? ORDER BY id DESC LIMIT 30").all(io.getDataset(req.params.id).id).map(j => ({ ...j, counts: JSON.parse(j.counts_json || "null"), counts_json: undefined })) }));
  api.get("/social/ollama", h(async (req, res) => res.json(await ollama.status())));
  api.post("/io/datasets/:id/ai", requirePerm("io.import"), h(async (req, res) => {
    const d = io.getDataset(req.params.id), task = req.body?.task;
    if (!["sentiment", "topics", "summary", "claims"].includes(task)) throw new HttpError(400, "Choose a task: sentiment, topics, summary or claims.");
    const st = await ollama.status(); if (!st.configured || !st.reachable || !st.model_available) throw new HttpError(409, `Local AI is not available: ${st.error || st.needs}. The rule-based analysis is unaffected.`);
    if (running.has(`ds${d.id}`)) throw new HttpError(409, "Another job is running on this dataset. Wait for it to finish.");
    const limit = Math.min(5000, Math.max(1, +req.body?.limit || (task === "claims" ? 300 : 1000))), M = `ollama:${ollama.model}`;
    const jid = io.job(req.user, d.id, `ai_${task}`, { model: ollama.model, limit });
    audit(req.user, `Local AI task started: ${task}`, "io_dataset", String(d.id), { model: ollama.model, limit, url: st.url });
    background(jid, `ds${d.id}`, async progress => {
      if (task === "sentiment") {
        const ps = db.prepare("SELECT id, text FROM io_posts WHERE dataset_id = ? ORDER BY posted_at, id LIMIT ?").all(d.id, limit); let done = 0, failed = 0, errs = [];
        const up = db.prepare("UPDATE io_posts SET sentiment = ?, sentiment_confidence = ?, sentiment_score = NULL, sentiment_method = ? WHERE id = ? AND dataset_id = ?");
        for (let i = 0; i < ps.length; i += ollama.batch) { const b = ps.slice(i, i + ollama.batch); try { const r = await ollama.sentimentBatch(b); db.transaction(() => r.forEach(x => up.run(x.label, Math.round(x.confidence * 100) / 100, M, x.id, d.id)))(); done += r.length; } catch (e) { failed += b.length; if (errs.length < 3) errs.push(e.message); } progress((i + b.length) / ps.length); }
        audit(null, "Local AI sentiment stored", "io_dataset", String(d.id), { model: ollama.model, classified: done, failed });
        return { classified: done, failed, errors: errs, model: ollama.model };
      }
      if (task === "topics") {
        const ts = db.prepare("SELECT topic_no, terms FROM io_topics WHERE dataset_id = ?").all(d.id); if (!ts.length) throw new Error("This dataset has no topics to label.");
        const sample = db.prepare("SELECT text FROM io_posts WHERE dataset_id = ? AND topic_no = ? ORDER BY id LIMIT 5");
        const r = await ollama.topicLabels(ts.map(t => ({ topic_no: t.topic_no, terms: JSON.parse(t.terms), samples: sample.all(d.id, t.topic_no).map(x => x.text) })));
        const up = db.prepare("UPDATE io_topics SET label = ?, label_source = ?, summary = ? WHERE dataset_id = ? AND topic_no = ?"); db.transaction(() => r.forEach(t => up.run(t.label, M, t.summary, d.id, t.topic_no)))();
        progress(1); return { labelled: r.length, model: ollama.model };
      }
      if (task === "summary") {
        const I = insights(db, d.id, {}); if (I.empty) throw new Error("The dataset has no posts.");
        const ps = db.prepare("SELECT id, posted_at, text FROM io_posts WHERE dataset_id = ? ORDER BY ((id * 2654435761) % 4294967296) LIMIT 40").all(d.id);
        const stats = { posts: I.posts, accounts: I.accounts, period: [I.first_at, I.last_at], sentiment: I.sentiment.counts, themes: I.themes.slice(0, 6).map(t => ({ theme: t.label, posts: t.posts, growing_late: t.emerging })), top_keywords: I.keywords.slice(0, 15).map(k => k.term) };
        const r = await ollama.summary(stats, ps); const meta = JSON.parse(db.prepare("SELECT enrich_json FROM io_datasets WHERE id = ?").get(d.id).enrich_json || "{}");
        meta.ai_summary = { model: ollama.model, generated_at: nowISO(), posts: I.posts, sampled_posts: ps.length, ...r }; db.prepare("UPDATE io_datasets SET enrich_json = ? WHERE id = ?").run(JSON.stringify(meta), d.id);
        progress(1); return { points: r.points.length, model: ollama.model };
      }
      const ps = db.prepare("SELECT id, text, account, posted_at FROM io_posts WHERE dataset_id = ? ORDER BY posted_at, id LIMIT ?").all(d.id, limit); let added = 0, merged = 0, rejected = 0, failed = 0;
      const findH = db.prepare("SELECT id, post_ids, posts FROM io_claims WHERE dataset_id = ? AND text_hash = ?");
      for (let i = 0; i < ps.length; i += ollama.batch) {
        const b = ps.slice(i, i + ollama.batch);
        try { const r = await ollama.claimsBatch(b); rejected += r.rejected;
          db.transaction(() => { for (const c of r.accepted) { const p = b.find(x => x.id === c.post_id), hsh = crypto.createHash("sha256").update(normText(c.claim)).digest("hex"), ex = findH.get(d.id, hsh);
            if (ex) { const ids = [...new Set([...JSON.parse(ex.post_ids), p.id])]; db.prepare("UPDATE io_claims SET post_ids = ?, posts = ? WHERE id = ?").run(JSON.stringify(ids.slice(0, 500)), ids.length, ex.id); merged++; }
            else { db.prepare("INSERT INTO io_claims(dataset_id,text,text_hash,posts,accounts,first_at,last_at,post_ids,flags,kb_json,themes,status,extracted_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(d.id, c.claim.slice(0, 1000), hsh, 1, 1, p.posted_at, p.posted_at, JSON.stringify([p.id]), "[]", "[]", "[]", "needs_review", M); added++; } } })();
        } catch { failed += b.length; }
        progress((i + b.length) / ps.length);
      }
      return { added, merged, rejected_unsupported: rejected, failed_posts: failed, model: ollama.model };
    });
    res.status(202).json({ job: jid });
  }));
  api.post("/io/collect", requirePerm("io.import"), h(async (req, res) => {
    const b = req.body || {}, src = b.source, run = collectors.run[src];
    if (!run) throw new HttpError(400, "Choose a collection source: news, youtube or x. Facebook, Instagram and TikTok are pending approved research access.");
    const st = collectors.status().find(c => c.key === src); if (st.state !== "ready") throw new HttpError(409, `${st.label} is not configured: ${st.needs}.`);
    let target = null; if (b.dataset_id) { target = io.getDataset(b.dataset_id); if (target.is_sample) throw new HttpError(400, "The synthetic sample cannot be extended."); }
    else { if (!String(b.name || "").trim()) throw new HttpError(400, "Give the new dataset a name."); if (!String(b.authorisation || "").trim()) throw new HttpError(400, "State the basis on which you may collect and use these posts (for example: the platform's API terms and your organisation's policy)."); }
    if (b.from && isNaN(Date.parse(b.from)) || b.to && isNaN(Date.parse(b.to))) throw new HttpError(400, "The dates could not be read.");
    const key = `collect${req.user.id}`; if (running.has(key)) throw new HttpError(409, "You already have a collection running. Wait for it to finish.");
    const params = { source: src, query: String(b.query || "").slice(0, 500), feeds: String(b.feeds || "").slice(0, 4000), from: b.from || null, to: b.to || null, max: Math.min(+b.max || 100, config.collect?.maxItems || 500) };
    const jid = io.job(req.user, target?.id, `collect_${src}`, { ...params, feeds: params.feeds ? params.feeds.split(/[\s,]+/).filter(Boolean) : undefined });
    audit(req.user, `Collection started: ${st.label}`, "io_dataset", target ? String(target.id) : null, { ...params, authorisation: b.authorisation || target?.authorisation });
    background(jid, key, async progress => {
      const r = await run({ ...params }); progress(0.8);
      if (!r.rows.length) throw new Error(`Nothing was collected${r.errors.length ? `: ${r.errors.join("; ")}` : ". Check the query, dates or feed addresses."}`);
      const via = `${st.label}${params.query ? ` — query “${params.query}”` : ""}${params.from || params.to ? ` (${params.from || "…"} to ${params.to || "…"})` : ""}`;
      if (target) { const x = io.appendCollected(req.user, target.id, r.rows, via); return { dataset_id: target.id, collected: r.rows.length, ...x, errors: r.errors }; }
      const x = io.importPosts(req.user, { rowsIn: r.rows, filename: `${src}-collection.json`, name: b.name, description: b.description, source: via, authorisation: b.authorisation, researchQuestion: b.research_question, method: src, via });
      return { dataset_id: x.id, collected: r.rows.length, imported: x.imported, skipped: x.skipped, errors: r.errors, feeds_found: r.found?.length ? r.found.map(f => f.feed) : undefined };
    });
    res.status(202).json({ job: jid });
  }));
  // reports: built from stored records, stored write-once by SHA-256, downloadable again in any format
  const sendReport = async (res, data, sha, id, fmt) => {
    const name = `aivs-social-${data.dataset.id}-report-${id ?? "preview"}`;
    if (fmt === "json") { res.setHeader("Content-Disposition", `attachment; filename="${name}.json"`); return res.type("application/json").send(JSON.stringify({ ...data, content_sha256: sha, report_id: id }, null, 2)); }
    if (fmt === "csv") { res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`); return res.type("text/csv; charset=utf-8").send(ioReportCsv(data)); }
    if (fmt === "pdf") { res.setHeader("Content-Disposition", `attachment; filename="${name}.pdf"`); return res.type("application/pdf").send(await ioReportPdf(data, { sha256: sha, id })); }
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'"); return res.type("html").send(ioReportHtml(data, { sha256: sha, id }));
  };
  api.get("/io/datasets/:id/report.:fmt(html|json|pdf|csv)", h(async (req, res) => {
    const d = io.getDataset(req.params.id), filters = cleanFilters(req.query), rq = String(req.query.research_question || "").trim().slice(0, 1000) || null;
    const data = buildReport(db, { dataset: d, filters, user: req.user, version: VERSION, researchQuestion: rq });
    const buf = Buffer.from(JSON.stringify(data)), obj = await storage.putBuffer(buf, "application/json");
    const rid = Number(db.prepare("INSERT INTO io_reports(dataset_id,title,filters_json,research_question,content_sha256,input_sha256,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(d.id, data.title, JSON.stringify(filters), data.research_question, obj.sha256, data.reproducibility.input_sha256, req.user.id, nowISO()).lastInsertRowid);
    audit(req.user, `Social media analysis report generated (${req.params.fmt})`, "io_dataset", String(d.id), { report_id: rid, filters, content_sha256: obj.sha256, input_sha256: data.reproducibility.input_sha256 });
    await sendReport(res, data, obj.sha256, rid, req.params.fmt);
  }));
  api.get("/io/datasets/:id/reports", (req, res) => res.json({ reports: db.prepare("SELECT r.id, r.title, r.filters_json, r.research_question, r.content_sha256, r.input_sha256, r.created_at, u.display_name AS by_name FROM io_reports r LEFT JOIN users u ON u.id = r.created_by WHERE r.dataset_id = ? ORDER BY r.id DESC LIMIT 50").all(io.getDataset(req.params.id).id).map(r => ({ ...r, filters: JSON.parse(r.filters_json), filters_json: undefined })) }));
  api.get("/io/reports/:rid.:fmt(html|json|pdf|csv)", h(async (req, res) => {
    const r = db.prepare("SELECT * FROM io_reports WHERE id = ?").get(Number(req.params.rid)); if (!r) throw new HttpError(404, "Report not found.");
    const f = storage.pathOf(r.content_sha256); if (!fs.existsSync(f)) throw new HttpError(410, "The stored report content is missing. Run Verify stored files in Administration.");
    const buf = fs.readFileSync(f); if (crypto.createHash("sha256").update(buf).digest("hex") !== r.content_sha256) throw new HttpError(500, "The stored report does not match its fingerprint.");
    audit(req.user, `Stored social media analysis report downloaded (${req.params.fmt})`, "io_dataset", String(r.dataset_id), { report_id: r.id });
    await sendReport(res, JSON.parse(buf.toString("utf8")), r.content_sha256, r.id, req.params.fmt);
  }));

  // ---------------------------------------------------------------- Search & check
  api.get("/search", (req, res) => {
    const t = scopeOf(req), q = String(req.query.q || "").trim().slice(0, 200), terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return res.json({ results: [] });
    const where = cols => terms.map((_, i) => `(${cols.map(c => `lower(${c}) LIKE @t${i} ESCAPE '\\'`).join(" OR ")})`).join(" AND ");
    const P = { s: t, ...Object.fromEntries(terms.map((x, i) => [`t${i}`, `%${x.replace(/[\\%_]/g, m => "\\" + m)}%`])) };
    const snip = (txt) => { const s = String(txt || ""), i = Math.max(0, s.toLowerCase().indexOf(terms[0])); return (i > 60 ? "…" : "") + s.slice(Math.max(0, i - 60), i + 160) + (s.length > i + 160 ? "…" : ""); };
    const out = [], lim = "LIMIT 60";
    for (const r of db.prepare(`SELECT id, title, status, claim_text FROM cases WHERE is_training = @s AND ${where(["id", "title", "claim_text", "source_platform", "coalesce(source_url,'')", "coalesce(source_account,'')", "coalesce(hashtags,'')"])} ORDER BY updated_at DESC ${lim}`).all(P)) out.push({ case_id: r.id, title: r.title, status: r.status, where: "Case", tab: "overview", text: snip(r.claim_text) });
    for (const r of db.prepare(`SELECT x.text, x.seq, c.id, c.title, c.status FROM claims x JOIN cases c ON c.id = x.case_id WHERE x.removed = 0 AND c.is_training = @s AND ${where(["x.text", "coalesce(x.rationale,'')"])} ${lim}`).all(P)) out.push({ case_id: r.id, title: r.title, status: r.status, where: `Claim ${r.seq}`, tab: "claims", text: snip(r.text) });
    for (const r of db.prepare(`SELECT e.id eid, e.text, e.reference, e.status es, c.id, c.title, c.status FROM evidence e JOIN cases c ON c.id = e.case_id WHERE c.is_training = @s AND ${where(["e.id", "e.text", "e.reference", "coalesce(e.source_date,'')"])} ${lim}`).all(P)) out.push({ case_id: r.id, title: r.title, status: r.status, where: `Evidence ${r.eid}${r.es === "suggested" ? " (suggestion)" : r.es === "dismissed" ? " (dismissed)" : ""}`, tab: "evidence", text: snip(`${r.text} — ${r.reference}`) });
    for (const r of db.prepare(`SELECT o.media_id, o.current_text, c.id, c.title, c.status FROM ocr_texts o JOIN cases c ON c.id = o.case_id WHERE c.is_training = @s AND ${where(["o.current_text", "o.original_text"])} ${lim}`).all(P)) out.push({ case_id: r.id, title: r.title, status: r.status, where: `Visible text in ${r.media_id}`, tab: "media", text: snip(r.current_text) });
    for (const r of db.prepare(`SELECT m.id mid, m.original_name, m.sha256, c.id, c.title, c.status FROM media m JOIN cases c ON c.id = m.case_id WHERE c.is_training = @s AND ${where(["m.id", "m.original_name", "m.sha256"])} ${lim}`).all(P)) out.push({ case_id: r.id, title: r.title, status: r.status, where: `File ${r.mid}`, tab: "media", text: `${r.original_name} · SHA-256 ${r.sha256}` });
    for (const r of db.prepare(`SELECT n.body, c.id, c.title, c.status FROM case_notes n JOIN cases c ON c.id = n.case_id WHERE n.deleted = 0 AND c.is_training = @s AND ${where(["n.body"])} ${lim}`).all(P)) out.push({ case_id: r.id, title: r.title, status: r.status, where: "Note", tab: "notes", text: snip(r.body) });
    for (const r of db.prepare(`SELECT a.id, a.title, a.description, a.source_ref FROM archive_records a LEFT JOIN media m ON m.archive_id = a.id WHERE a.active = 1 AND a.is_training = @s AND ${where(["a.id", "a.title", "a.description", "a.source_ref", "coalesce(m.sha256,'')"])} GROUP BY a.id ${lim}`).all(P)) out.push({ archive_id: r.id, title: r.title, where: "Reference archive", text: snip(`${r.title} — ${r.description} — ${r.source_ref}`) });
    res.json({ results: out.slice(0, 200), total: out.length });
  });
  api.post("/check-image", upload.single("file"), h(async (req, res) => {
    const f = req.file; if (!f) throw new HttpError(400, "Choose an image to check.");
    try {
      const head = Buffer.alloc(64), fd = fs.openSync(f.path, "r"); fs.readSync(fd, head, 0, 64, 0); fs.closeSync(fd);
      const t = sniff(head); if (!t || t.kind !== "image") throw new HttpError(415, "Choose an image (JPEG, PNG, WebP, GIF or HEIC). For video, capture a frame inside a case first.");
      const buf = fs.readFileSync(f.path), sha = crypto.createHash("sha256").update(buf).digest("hex");
      let hs; try { hs = await submissionHashes(f.path); } catch { throw new HttpError(422, "The image could not be decoded. It may be damaged."); }
      const meta = await (await import("./lib/media.js")).readMetadata(f.path), scope = scopeOf(req), V = [[hs.dhash, hs.phash, 0], [hs.dhash_m, hs.phash_m, 1]], out = [];
      const best = new Map();
      for (const w of db.prepare("SELECT w.*, m.sha256, a.id aid, a.title, a.documented_date, a.record_type FROM archive_windows w JOIN media m ON m.id = w.media_id JOIN archive_records a ON a.id = m.archive_id WHERE a.active = 1 AND a.is_training = ?").all(scope)) {
        if (w.sha256 === sha) { best.set(w.aid, { kind: "exact", level: "identical", score: 0, archive: { id: w.aid, title: w.title, documented_date: w.documented_date, record_type: w.record_type } }); continue; }
        if (best.get(w.aid)?.kind === "exact") continue;
        for (const [d, p, mir] of V) { const dd = ham(d, w.dhash), pd = ham(p, w.phash), sc = dd + pd, cur = best.get(w.aid); if (!cur || sc < cur.score) best.set(w.aid, { kind: "perceptual", score: sc, dd, pd, window: w.label, mirrored: mir, archive: { id: w.aid, title: w.title, documented_date: w.documented_date, record_type: w.record_type } }); }
      }
      for (const b of best.values()) { const lv = b.kind === "exact" ? "identical" : levelOf(b.score); if (lv) out.push({ ...b, level: lv }); }
      for (const m of db.prepare("SELECT m.id, m.sha256, m.dhash, m.phash, c.id cid, c.title, c.status FROM media m JOIN cases c ON c.id = m.case_id WHERE m.kind = 'image' AND m.dhash IS NOT NULL AND c.is_training = ?").all(scope)) {
        if (m.sha256 === sha) { out.push({ kind: "exact", level: "identical", score: 0, case: { id: m.cid, title: m.title, status: m.status }, media_id: m.id }); continue; }
        let b = null; for (const [d, p, mir] of V) { const dd = ham(d, m.dhash), pd = ham(p, m.phash), sc = dd + pd; if (!b || sc < b.score) b = { score: sc, dd, pd, mirrored: mir }; }
        const lv = levelOf(b.score); if (lv) out.push({ kind: "perceptual", level: lv, ...b, window: "full image", case: { id: m.cid, title: m.title, status: m.status }, media_id: m.id });
      }
      audit(req.user, "Image checked against holdings (not stored)", "search", null, { sha256: sha, results: out.length });
      res.json({ sha256: sha, name: f.originalname, meta, results: out.sort((a, b) => a.score - b.score).slice(0, 50) });
    } finally { cleanup([f]); }
  }));

  // ---------------------------------------------------------------- meta & dashboard
  api.get("/meta", (req, res) => res.json({
    states: STATES, conclusions: CONCLUSIONS, roles: ROLE_LABELS, permissions: PERMISSIONS, thresholds: THRESH, defaultChecks: DEFAULT_CHECKS,
    ai: ai.status(), ocr: ocrAvailable(), maxUploadMb: config.maxUploadMb, allowSelfApproval: config.allowSelfApproval,
    verdicts: VERDICTS, verdictHelp: VERDICT_HELP, strengthLabels: STRENGTH_LABELS, topics: TOPICS, search: retrieval.status(), social: social.status(), transcribe: transcriber.status(), officialSources: OFFICIAL_SOURCES,
    users: users().filter(u => u.active).map(u => ({ id: u.id, name: u.display_name, role: u.role })),
    training: { cases: db.prepare("SELECT COUNT(*) n FROM cases WHERE is_training = 1").get().n, archive: db.prepare("SELECT COUNT(*) n FROM archive_records WHERE is_training = 1").get().n }
  }));
  api.get("/dashboard", (req, res) => {
    const t = scopeOf(req);
    const counts = Object.fromEntries(Object.keys(STATES).map(s => [s, 0]));
    for (const r of db.prepare("SELECT status, COUNT(*) n FROM cases WHERE is_training = ? GROUP BY status").all(t)) counts[r.status] = r.n;
    const conclusions = db.prepare("SELECT conclusion, COUNT(*) n FROM cases WHERE is_training = ? AND status IN ('approved','archived') GROUP BY conclusion").all(t);
    const list = (where, ...a) => db.prepare(`SELECT c.id, c.title, c.status, c.priority, c.updated_at, c.received_at, c.conclusion, u.display_name AS assigned FROM cases c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.is_training = ? AND ${where} ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'priority' THEN 1 ELSE 2 END, c.updated_at DESC LIMIT 8`).all(t, ...a);
    res.json({
      counts, total: Object.values(counts).reduce((a, b) => a + b, 0), conclusions,
      urgentOpen: db.prepare("SELECT COUNT(*) n FROM cases WHERE is_training = ? AND priority = 'urgent' AND status NOT IN ('approved','archived','rejected')").get(t).n,
      awaiting: list("c.status = 'awaiting_approval'"),
      mine: list("c.assigned_to = ? AND c.status NOT IN ('approved','archived')", req.user.id),
      failed: list("c.status = 'analysis_failed'"),
      processing: list("c.status = 'analysing'"),
      returned: list("c.status = 'needs_evidence' AND (c.assigned_to = ? OR c.submitted_by = ?)", req.user.id, req.user.id),
      recent: db.prepare("SELECT c.id, c.title, c.status, c.priority, c.updated_at, c.received_at, c.conclusion, u.display_name AS assigned FROM cases c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.is_training = ? ORDER BY c.updated_at DESC LIMIT 8").all(t),
      activity: db.prepare("SELECT a.at, a.username, a.action, a.entity_id FROM audit_log a JOIN cases c ON c.id = a.entity_id WHERE a.entity = 'case' AND c.is_training = ? ORDER BY a.id DESC LIMIT 12").all(t),
      archive: db.prepare("SELECT COUNT(*) n FROM archive_records WHERE is_training = ? AND active = 1").get(t).n
    });
  });

  // ---------------------------------------------------------------- cases
  api.get("/cases", (req, res) => {
    const w = ["c.is_training = @t"], p = { t: scopeOf(req) };
    if (req.query.q) { w.push("(c.id LIKE @q OR c.title LIKE @q OR c.claim_text LIKE @q OR c.source_platform LIKE @q)"); p.q = `%${req.query.q}%`; }
    if (req.query.status) { const s = String(req.query.status).split(",").filter(x => STATES[x]); if (s.length) w.push(`c.status IN (${s.map((x, i) => `@s${i}`).join(",")})`), s.forEach((x, i) => (p[`s${i}`] = x)); }
    if (req.query.priority) { w.push("c.priority = @pr"); p.pr = req.query.priority; }
    if (req.query.conclusion) { w.push("c.conclusion = @co"); p.co = req.query.conclusion; }
    if (req.query.assigned === "me") { w.push("c.assigned_to = @me"); p.me = req.user.id; }
    else if (req.query.assigned === "none") w.push("c.assigned_to IS NULL");
    else if (/^\d+$/.test(req.query.assigned || "")) { w.push("c.assigned_to = @as"); p.as = +req.query.assigned; }
    const rows = db.prepare(`SELECT c.id, c.title, c.status, c.priority, c.conclusion, c.source_platform, c.received_at, c.updated_at, c.revision, c.assigned_to, c.is_training, u.display_name AS assigned,
      (SELECT COUNT(*) FROM media m WHERE m.case_id = c.id AND m.parent_media_id IS NULL) AS media_count,
      (SELECT COUNT(*) FROM evidence e WHERE e.case_id = c.id AND e.status = 'suggested') AS pending,
      (SELECT COUNT(*) FROM claims k WHERE k.case_id = c.id AND k.removed = 0) AS claims
      FROM cases c LEFT JOIN users u ON u.id = c.assigned_to WHERE ${w.join(" AND ")} ORDER BY c.updated_at DESC LIMIT 500`).all(p);
    res.json({ cases: rows });
  });
  api.post("/cases", requirePerm("case.create"), h((req, res) => res.status(201).json({ id: cases.create(req.user, req.body || {}) })));
  api.get("/cases/:id", (req, res) => res.json(cases.aggregate(req.params.id, { forUser: req.user })));
  api.patch("/cases/:id", requirePerm("case.edit"), h((req, res) => res.json({ version: cases.update(req.user, req.params.id, req.body || {}, req.headers["if-match"]) })));
  api.post("/cases/:id/assign", h((req, res) => { cases.assign(req.user, req.params.id, req.body?.user_id || null); res.json({ ok: true }); }));
  api.post("/cases/:id/analyse", requirePerm("case.edit"), h(async (req, res) => {
    const done = cases.startAnalysis(req.user, req.params.id);
    if (req.query.wait === "1") await done;
    res.status(202).json({ status: cases.getCase(req.params.id).status });
  }));
  api.get("/cases/:id/readiness", (req, res) => res.json(cases.readiness(cases.mustCase(req.params.id).id)));
  api.post("/cases/:id/automatic-report", requirePerm("case.edit"), heavy, h((req, res) => {
    automaticReports.start(req.user, req.params.id, { search_external: req.body?.search_external === true, confirm_external: req.body?.confirm_external === true });
    res.status(202).json({ status: 'running' });
  }));
  api.get("/cases/:id/automatic-report", (req, res) => res.json(automaticReports.get(req.params.id)));
  api.get("/cases/:id/automatic-report.:fmt(html|json)", h((req, res) => {
    const saved = automaticReports.get(req.params.id);
    if (!saved?.report) throw new HttpError(404, 'No automatic report has been generated yet.');
    res.setHeader('Content-Disposition', `inline; filename="${req.params.id}-${saved.report.report_date}-automatic.${req.params.fmt}"`);
    if (req.params.fmt === 'json') return res.json(saved.report);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.type('html').send(automaticReportHtml(saved.report));
  }));
  api.post("/cases/:id/submit", requirePerm("case.edit"), h((req, res) => { cases.submit(req.user, req.params.id); res.json({ ok: true }); }));
  api.post("/cases/:id/decision", h((req, res) => { cases.decide(req.user, req.params.id, req.body || {}, id => reports.render(id)); res.json({ ok: true }); }));
  api.post("/cases/:id/archive", h((req, res) => { cases.archiveCase(req.user, req.params.id); res.json({ ok: true }); }));
  api.post("/cases/:id/revise", h((req, res) => { cases.revise(req.user, req.params.id, req.body?.reason); res.json({ ok: true }); }));
  api.get("/cases/:id/versions/:v", (req, res) => {
    const v = db.prepare("SELECT * FROM case_versions WHERE case_id = ? AND version = ?").get(req.params.id, +req.params.v);
    if (!v) throw new HttpError(404, "Version not found.");
    res.json({ ...v, snapshot: JSON.parse(v.snapshot_json), snapshot_json: undefined });
  });
  api.get("/cases/:id/audit", requirePerm("case.read"), (req, res) => res.json({ entries: db.prepare("SELECT id, at, username, action, details FROM audit_log WHERE entity = 'case' AND entity_id = ? ORDER BY id DESC").all(req.params.id) }));
  api.get("/cases/:id/report.:fmt(html|json|pdf|csv)", h(async (req, res) => {
    const c = cases.mustCase(req.params.id);
    const r = reports.render(req.params.id), approved = ["approved", "archived"].includes(c.status);
    if (req.query.download === "1" || ["pdf", "csv"].includes(req.params.fmt)) { audit(req.user, `Current report exported (${req.params.fmt})`, "case", req.params.id); res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}-${approved ? "current" : "draft"}.${req.params.fmt}"`); }
    if (req.params.fmt === "json") return res.type("application/json").send(r.json);
    if (req.params.fmt === "pdf") return res.type("application/pdf").send(await reportPdf(r.data, { approved }));
    if (req.params.fmt === "csv") return res.type("text/csv; charset=utf-8").send(reportCsv(r.data));
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'"); res.type("html").send(r.html);
  }));

  // claims / evidence / checklist / OCR
  api.get("/cases/:id/account-location/candidates", (req, res) => res.json(cases.accountLocationCandidates(req.params.id)));
  api.put("/cases/:id/account-location", requirePerm("case.edit"), h((req, res) => { cases.setAccountLocation(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
  api.post("/cases/:id/claims", requirePerm("case.edit"), h((req, res) => res.status(201).json({ id: cases.addClaim(req.user, req.params.id, req.body || {}) })));
  api.patch("/claims/:cid", requirePerm("case.edit"), h((req, res) => { cases.updateClaim(req.user, req.params.cid, req.body || {}); res.json({ ok: true }); }));
  api.delete("/claims/:cid", requirePerm("case.edit"), h((req, res) => { cases.removeClaim(req.user, req.params.cid); res.json({ ok: true }); }));
  api.post("/claims/:cid/split", requirePerm("case.edit"), h((req, res) => res.json({ ids: cases.splitClaim(req.user, req.params.cid, req.body?.parts) })));
  api.post("/cases/:id/evidence", requirePerm("case.edit"), h((req, res) => res.status(201).json({ id: cases.addEvidence(req.user, req.params.id, req.body || {}) })));
  api.patch("/evidence/:eid", requirePerm("case.edit"), h((req, res) => { cases.updateEvidence(req.user, req.params.eid, req.body || {}); res.json({ ok: true }); }));
  api.post("/cases/:id/notes", requirePerm("note.write"), h((req, res) => res.status(201).json({ id: cases.addNote(req.user, req.params.id, req.body?.body) })));
  api.patch("/notes/:nid", requirePerm("note.write"), h((req, res) => { cases.editNote(req.user, req.params.nid, req.body?.body); res.json({ ok: true }); }));
  api.delete("/notes/:nid", requirePerm("note.write"), h((req, res) => { cases.deleteNote(req.user, req.params.nid); res.json({ ok: true }); }));
  api.put("/cases/:id/checklist/:step", requirePerm("case.edit"), h((req, res) => { cases.setChecklist(req.user, req.params.id, req.params.step, req.body || {}); res.json({ ok: true }); }));
  api.post("/media/:mid/ocr", requirePerm("case.edit"), h((req, res) => res.status(201).json({ id: cases.addOcr(req.user, req.params.mid, req.body || {}) })));
  api.patch("/ocr/:oid", requirePerm("case.edit"), h((req, res) => { cases.editOcr(req.user, +req.params.oid, req.body?.text ?? ""); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- media
  api.post("/cases/:id/media", requirePerm("case.create"), upload.array("files", 20), h(async (req, res) => {
    const c = cases.mustCase(req.params.id);
    try { cases.requireEdit(req.user, c); } catch (e) { cleanup(req.files); throw e; }
    if (!req.files?.length) throw new HttpError(400, "Choose at least one file.");
    const out = [], errors = [];
    for (const f of req.files) {
      try {
        const row = await media.ingest(f.path, { name: f.originalname, caseId: c.id, isTraining: c.is_training, user: req.user });
        const same = db.prepare("SELECT id, case_id, archive_id FROM media WHERE sha256 = ? AND id != ?").all(row.sha256, row.id);
        let transcript = null, transcribe_error = null;
        if (["audio", "video"].includes(row.kind) && ["auto", "en", "sw"].includes(req.body?.transcribe)) { try { transcript = transcriber.start(req.user, row.id, req.body.transcribe); } catch (e) { transcribe_error = e.message; } }
        out.push({ id: row.id, name: row.original_name, sha256: row.sha256, kind: row.kind, identicalTo: same, transcript, transcribe_error });
      } catch (e) { fs.rmSync(f.path, { force: true }); errors.push(e.message); }
    }
    if (out.length) cases.change(req.user, c.id, `Media received: ${out.map(o => `${o.id} (${o.name})`).join(", ")}`, () => {}, { sha256: out.map(o => o.sha256) });
    res.status(out.length ? 201 : 422).json({ media: out, errors });
  }));
  // ---------------------------------------------------------------- speech-to-text (machine transcripts of case audio and video)
  api.get("/transcribe/health", h(async (req, res) => {
    if (req.query.cached === "1") { transcriber.checkHealth().catch(() => {}); return res.json(transcriber.status()); }
    await transcriber.checkHealth({ force: req.query.force === "1" }); res.json(transcriber.status());
  }));
  api.post("/media/:mid/transcripts", requirePerm("case.edit"), h((req, res) => res.status(202).json({ id: transcriber.start(req.user, req.params.mid, req.body?.language || "auto") })));
  api.get("/media/:mid/transcripts", (req, res) => { mediaRow(req.params.mid); res.json({ transcripts: transcriber.list(req.params.mid) }); });
  api.get("/transcripts/:tid.:fmt(txt|srt|vtt|json)", (req, res) => {
    const t = transcriber.get(req.params.tid); cases.mustCase(t.case_id);
    audit(req.user, `Transcript ${t.id} downloaded (${req.params.fmt})`, "case", t.case_id, { media: t.media_id });
    res.setHeader("Content-Disposition", `attachment; filename="${t.id}-${t.media_id}-machine-transcript.${req.params.fmt}"`);
    res.type({ txt: "text/plain", srt: "application/x-subrip", vtt: "text/vtt", json: "application/json" }[req.params.fmt] + "; charset=utf-8").send(transcriber.exportAs(t.id, req.params.fmt));
  });
  api.get("/transcripts/:tid", (req, res) => { const t = transcriber.get(req.params.tid, { q: req.query.q }); cases.mustCase(t.case_id); res.json(t); });
  api.patch("/transcript-segments/:sid", requirePerm("case.edit"), h((req, res) => { transcriber.edit(req.user, req.params.sid, req.body?.text); res.json({ ok: true }); }));
  api.get("/transcript-segments/:sid/history", (req, res) => res.json({ edits: transcriber.history(req.params.sid) }));
  api.post("/transcripts/:tid/evidence", requirePerm("case.edit"), h((req, res) => res.status(201).json({ id: transcriber.toEvidence(req.user, req.params.tid, req.body || {}) })));

  // a frame captured in the browser from a case video, at a recorded timestamp
  api.post("/media/:mid/frames", requirePerm("case.edit"), upload.single("frame"), h(async (req, res) => {
    const v = db.prepare("SELECT * FROM media WHERE id = ?").get(req.params.mid);
    if (!v || v.kind !== "video" || !v.case_id) { cleanup([req.file]); throw new HttpError(404, "Video not found."); }
    const c = cases.mustCase(v.case_id);
    try { cases.requireEdit(req.user, c); } catch (e) { cleanup([req.file]); throw e; }
    const t = Number(req.body.time), origin = req.body.origin === "auto" ? "auto" : "analyst";
    if (!req.file || !Number.isFinite(t) || t < 0) { cleanup([req.file]); throw new HttpError(400, "A frame image and a valid timestamp are required."); }
    const row = await media.ingest(req.file.path, { name: `${v.original_name} @ ${t.toFixed(2)}s.png`, caseId: c.id, isTraining: c.is_training, user: req.user, parent: v.id, frameTime: t, frameOrigin: origin });
    cases.change(req.user, c.id, `Frame ${row.id} captured from ${v.id} at ${t.toFixed(2)} s (${origin})`, () => {});
    res.status(201).json({ id: row.id });
  }));
  const mediaRow = id => { const m = db.prepare("SELECT * FROM media WHERE id = ?").get(id); if (!m) throw new HttpError(404, "Media not found."); return m; };
  api.get("/media/:mid/content", (req, res) => {
    const m = mediaRow(req.params.mid);
    if (req.query.download === "1") audit(req.user, "Original media downloaded", m.case_id ? "case" : "archive", m.case_id || m.archive_id, { media: m.id, sha256: m.sha256 });
    res.sendFile(storage.pathOf(m.sha256), { headers: { "Content-Type": m.mime, "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `${req.query.download === "1" || m.kind === "document" ? "attachment" : "inline"}; filename="${m.id}-${m.original_name.replace(/[^\w.\- @]/g, "_")}"` } });   // documents are never opened inside AIVS
  });
  api.get("/media/:mid/pages/:n", (req, res) => { const m = mediaRow(req.params.mid); if (m.kind !== "document") throw new HttpError(400, "Only documents have pages."); res.json({ media_id: m.id, name: m.original_name, ...coverage.pageText(m, req.params.n) }); });
  api.get("/media/:mid/text", (req, res) => {
    const m = mediaRow(req.params.mid), d = db.prepare("SELECT text FROM document_texts WHERE media_id = ?").get(m.id), o = db.prepare("SELECT current_text FROM ocr_texts WHERE media_id = ? ORDER BY id DESC").get(m.id);
    if (!d && !o) throw new HttpError(404, "No text has been extracted from this item.");
    res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="${m.id}-text.txt"`);
    res.send(`Text extracted by AIVS from ${m.original_name} (${m.id}, SHA-256 ${m.sha256})\n\n${d?.text || ""}${o ? `\n\n--- Text read by OCR (analyst-checked) ---\n${o.current_text}` : ""}\n`);
  });
  // read the text of a document for the New case form; nothing is stored (the file is attached in the next step)
  api.post("/extract-text", requirePerm("case.create"), upload.single("file"), h(async (req, res) => {
    const f = req.file; if (!f) throw new HttpError(400, "Choose a document.");
    let buf; try { buf = fs.readFileSync(f.path); } finally { cleanup([f]); }
    const d = await extractDocument(buf, f.originalname);
    res.json({ type: d.type, pages: d.pages, meta: d.meta, warnings: d.warnings, scanned: !!d.scanned, text: d.text.replace(/^--- Page \d+ ---\n?/gm, "").trim().slice(0, 20000), truncated: d.text.length > 20000 });
  }));
  api.post("/media/:mid/claims", requirePerm("case.edit"), h((req, res) => res.json(cases.claimsFromDocument(req.user, req.params.mid))));
  api.get("/media/:mid/thumb", (req, res) => {
    const m = mediaRow(req.params.mid);
    if (!m.thumb_sha256) throw new HttpError(404, "No preview for this item.");
    res.sendFile(storage.pathOf(m.thumb_sha256), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
  });

  // ---------------------------------------------------------------- AI
  api.get("/ai/status", (req, res) => res.json(ai.status()));
  api.post("/cases/:id/ai/preview", requirePerm("ai.request"), h(async (req, res) => {
    const p = await ai.buildPayload(req.params.id, req.body || {}); res.json({ sent: p.sent, text: p.text, injection_flags: p.flags, status: ai.status() });
  }));
  api.post("/cases/:id/ai/runs", requirePerm("ai.request"), h(async (req, res) => {
    const { id, job } = await ai.request(req.user, req.params.id, req.body || {});
    if (req.query.wait === "1") await job;
    res.status(202).json({ id, status: db.prepare("SELECT status FROM ai_runs WHERE id = ?").get(id).status });
  }));
  api.post("/ai/runs/:rid/apply", requirePerm("ai.request"), h((req, res) => res.json({ result: ai.apply(req.user, req.params.rid, req.body || {}) })));

  // ---------------------------------------------------------------- reference archive
  api.get("/archive", (req, res) => {
    const w = ["a.is_training = @t", "a.active = 1"], p = { t: scopeOf(req) };
    if (req.query.q) { w.push("(a.id LIKE @q OR a.title LIKE @q OR a.description LIKE @q OR a.source_ref LIKE @q)"); p.q = `%${req.query.q}%`; }
    if (req.query.type) { w.push("a.record_type = @ty"); p.ty = req.query.type; }
    res.json({ records: db.prepare(`SELECT a.*, m.id AS media_id, u.display_name AS created_by_name,
      (SELECT COUNT(DISTINCT x.case_id) FROM matches x WHERE x.target_archive_id = a.id) AS matched_cases
      FROM archive_records a LEFT JOIN media m ON m.archive_id = a.id LEFT JOIN users u ON u.id = a.created_by WHERE ${w.join(" AND ")} GROUP BY a.id ORDER BY a.documented_date DESC`).all(p) });
  });
  // ---------------------------------------------------------------- archive bundles (export / import)
  // A bundle is one JSON file: record metadata, history and each original image (base64) with its SHA-256.
  // Import re-checks every hash, refuses to mix training and operational records, skips images that are
  // already in the archive, and records where each record came from.
  const BUNDLE = "aivs-archive-bundle";
  api.get("/archive/export", requirePerm("archive.manage"), (req, res) => {
    const t = scopeOf(req);
    const recs = db.prepare("SELECT * FROM archive_records WHERE is_training = ? AND active = 1 ORDER BY id").all(t);
    const records = recs.map(a => {
      const m = db.prepare("SELECT original_name, mime, sha256 FROM media WHERE archive_id = ? ORDER BY id LIMIT 1").get(a.id);
      return { id: a.id, title: a.title, description: a.description, documented_date: a.documented_date, record_type: a.record_type, source_ref: a.source_ref, created_at: a.created_at,
        history: db.prepare("SELECT at, action FROM archive_history WHERE archive_id = ? ORDER BY id").all(a.id),
        image: m ? { name: m.original_name, mime: m.mime, sha256: m.sha256, data_base64: storage.read(m.sha256).toString("base64") } : null };
    });
    const bundle = { format: BUNDLE, version: 1, exported_at: nowISO(), exported_by: { username: req.user.username, name: req.user.display_name }, training: !!t, count: records.length, records };
    audit(req.user, "Archive exported", "archive", null, { training: !!t, records: records.length });
    res.setHeader("Content-Disposition", `attachment; filename="aivs-archive${t ? "-training" : ""}-${nowISO().slice(0, 10)}.json"`);
    res.type("application/json").send(JSON.stringify(bundle));
  });
  api.post("/archive/import", requirePerm("archive.manage"), upload.single("bundle"), h(async (req, res) => {
    const t = scopeOf(req), raw = req.file ? fs.readFileSync(req.file.path) : null; cleanup([req.file]);
    if (!raw) throw new HttpError(400, "Choose an archive bundle (.json) exported from AIVS.");
    let b; try { b = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "That file is not valid JSON. Choose a bundle exported from AIVS."); }
    if (b?.format !== BUNDLE || b.version !== 1 || !Array.isArray(b.records)) throw new HttpError(400, "That file is not an AIVS archive bundle (version 1).");
    if (!!b.training !== !!t) throw new HttpError(400, b.training ? "This bundle contains training records. Switch to Training before importing it." : "This bundle contains operational records. Switch to Operational before importing it.");
    if (b.records.length > 1000) throw new HttpError(400, "A bundle can hold at most 1,000 records.");
    const bundleSha = crypto.createHash("sha256").update(raw).digest("hex");
    const out = { imported: [], skipped: [], failed: [] };
    for (const r of b.records) {
      const from = String(r?.id || "?").slice(0, 40);
      try {
        const f = archiveFields(r || {}, false);
        if (!r.image?.data_base64 || !/^[0-9a-f]{64}$/.test(r.image.sha256 || "")) throw new HttpError(400, "no image or no SHA-256");
        const buf = Buffer.from(r.image.data_base64, "base64"), sha = crypto.createHash("sha256").update(buf).digest("hex");
        if (sha !== r.image.sha256) throw new HttpError(400, "image does not match its SHA-256 (damaged or altered)");
        const dup = db.prepare("SELECT a.id FROM media m JOIN archive_records a ON a.id = m.archive_id WHERE m.sha256 = ? AND a.is_training = ? AND a.active = 1").get(sha, t);
        if (dup) { out.skipped.push({ from, reason: `same image already in the archive as ${dup.id}` }); continue; }
        const tmp = path.join(storage.tmpDir, `import-${crypto.randomBytes(6).toString("hex")}`); fs.writeFileSync(tmp, buf);
        const id = await createArchiveRecord(req.user, f, !!t, [{ path: tmp, name: String(r.image.name || `${from}.jpg`) }]);
        db.prepare("INSERT INTO archive_history(archive_id,at,user_id,action,details) VALUES (?,?,?,?,?)").run(id, nowISO(), req.user.id,
          `Imported from bundle ${req.file.originalname || ""} (record ${from}, exported ${String(b.exported_at || "?").slice(0, 19)} by ${String(b.exported_by?.name || b.exported_by?.username || "unknown").slice(0, 80)})`,
          JSON.stringify({ bundle_sha256: bundleSha, original_id: from, original_history: Array.isArray(r.history) ? r.history.slice(0, 50) : [] }));
        out.imported.push({ from, id });
      } catch (e) { out.failed.push({ from, reason: String(e.message || e).slice(0, 200) }); }
    }
    db.prepare("INSERT INTO archive_imports(file_name,bundle_sha256,exported_at,exported_from,imported_by,imported_at,summary_json) VALUES (?,?,?,?,?,?,?)")
      .run(req.file.originalname || null, bundleSha, b.exported_at || null, b.exported_by?.username || null, req.user.id, nowISO(), JSON.stringify(out));
    audit(req.user, "Archive bundle imported", "archive", null, { bundle_sha256: bundleSha, imported: out.imported.length, skipped: out.skipped.length, failed: out.failed.length });
    res.json(out);
  }));
  api.get("/archive/:aid", (req, res) => {
    const a = db.prepare("SELECT * FROM archive_records WHERE id = ?").get(req.params.aid); if (!a) throw new HttpError(404, "Archive record not found.");
    res.json({ record: a, media: db.prepare("SELECT id, original_name, sha256, width, height, dhash, phash, uploaded_at FROM media WHERE archive_id = ?").all(a.id),
      history: db.prepare("SELECT h.*, u.display_name AS user FROM archive_history h LEFT JOIN users u ON u.id = h.user_id WHERE archive_id = ? ORDER BY h.id").all(a.id),
      cases: db.prepare("SELECT DISTINCT c.id, c.title, c.status, c.conclusion FROM matches x JOIN cases c ON c.id = x.case_id WHERE x.target_archive_id = ?").all(a.id) });
  });
  const archiveFields = (b, partial) => {
    const out = {};
    for (const k of ["title", "description", "documented_date", "source_ref"]) { if (b[k] !== undefined) { if (!String(b[k]).trim()) throw new HttpError(400, `${k.replace(/_/g, " ")} is required: an archive record is only useful with documented provenance.`); out[k] = String(b[k]).trim().slice(0, 4000); } else if (!partial) throw new HttpError(400, `${k.replace(/_/g, " ")} is required.`); }
    if (b.record_type !== undefined) { if (!["original", "misleading"].includes(b.record_type)) throw new HttpError(400, "Record type must be original or misleading."); out.record_type = b.record_type; } else if (!partial) out.record_type = "original";
    if (out.documented_date && isNaN(new Date(out.documented_date))) throw new HttpError(400, "Documented date is not a valid date.");
    return out;
  };
  async function createArchiveRecord(user, fields, isTraining, files, fromCase) {
    const id = isTraining ? nextArchiveId(1) : nextArchiveId(0), now = nowISO();
    db.prepare("INSERT INTO archive_records(id,is_training,title,description,documented_date,record_type,source_ref,from_case_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, isTraining ? 1 : 0, fields.title, fields.description, fields.documented_date, fields.record_type, fields.source_ref, fromCase || null, user.id, now, now);
    try { for (const f of files) await media.ingest(f.path, { name: f.name, archiveId: id, isTraining, user }); }
    catch (e) { db.prepare("DELETE FROM archive_windows WHERE media_id IN (SELECT id FROM media WHERE archive_id = ?)").run(id); db.prepare("DELETE FROM media WHERE archive_id = ?").run(id); db.prepare("DELETE FROM archive_records WHERE id = ?").run(id); throw e; }
    db.prepare("INSERT INTO archive_history(archive_id,at,user_id,action,details) VALUES (?,?,?,?,?)").run(id, now, user.id, fromCase ? `Created from approved case ${fromCase}` : "Created", JSON.stringify(fields));
    audit(user, "Archive record created", "archive", id, { fromCase, title: fields.title });
    return id;
  }
  const nextArchiveId = t => { const r = db.prepare("INSERT INTO counters(name,value) VALUES (?,1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get(t ? "archive-training" : "archive").value; return `${t ? "TA" : "A"}-${String(r).padStart(4, "0")}`; };
  api.post("/archive", requirePerm("archive.manage"), upload.single("file"), h(async (req, res) => {
    try {
      if (!req.file) throw new HttpError(400, "Attach the reference image.");
      const f = archiveFields(req.body || {}, false);
      res.status(201).json({ id: await createArchiveRecord(req.user, f, req.body.is_training === "1", [{ path: req.file.path, name: req.file.originalname }]) });
    } catch (e) { cleanup([req.file]); throw e; }
  }));
  api.patch("/archive/:aid", requirePerm("archive.manage"), h((req, res) => {
    const a = db.prepare("SELECT * FROM archive_records WHERE id = ?").get(req.params.aid); if (!a) throw new HttpError(404, "Archive record not found.");
    const f = archiveFields(req.body || {}, true);
    if (req.body.active !== undefined) f.active = req.body.active ? 1 : 0;
    if (!Object.keys(f).length) return res.json({ ok: true });
    if (!String(req.body.reason || "").trim()) throw new HttpError(400, "Give a reason for changing an archive record.");
    db.prepare(`UPDATE archive_records SET ${Object.keys(f).map(k => `${k} = @${k}`).join(", ")}, updated_at = @u WHERE id = @id`).run({ ...f, u: nowISO(), id: a.id });
    db.prepare("INSERT INTO archive_history(archive_id,at,user_id,action,details) VALUES (?,?,?,?,?)").run(a.id, nowISO(), req.user.id, f.active === 0 ? `Withdrawn: ${req.body.reason}` : `Edited: ${req.body.reason}`, JSON.stringify({ before: Object.fromEntries(Object.keys(f).map(k => [k, a[k]])), after: f }));
    audit(req.user, f.active === 0 ? "Archive record withdrawn" : "Archive record edited", "archive", a.id, { reason: req.body.reason }); res.json({ ok: true });
  }));
  api.post("/cases/:id/to-archive", requirePerm("archive.manage"), h(async (req, res) => {
    const c = cases.mustCase(req.params.id);
    if (!["approved", "archived"].includes(c.status)) throw new HttpError(409, "Only approved cases can contribute to the reference archive.");
    const ids = Array.isArray(req.body?.media_ids) ? req.body.media_ids : [];
    const rows = ids.map(i => db.prepare("SELECT * FROM media WHERE id = ? AND case_id = ? AND kind = 'image'").get(i, c.id));
    if (!rows.length || rows.some(r => !r)) throw new HttpError(400, "Choose images (or captured frames) from this case.");
    const f = archiveFields({ record_type: c.conclusion === "contradicted" || c.conclusion === "mixed" ? "misleading" : "original", documented_date: (c.published_at || c.received_at).slice(0, 10), source_ref: `Verification report ${c.id} revision ${c.revision}`, ...req.body }, false);
    const tmpFiles = rows.map(r => { const t = path.join(storage.tmpDir, `copy-${r.id}-${Date.now()}`); fs.copyFileSync(storage.pathOf(r.sha256), t); return { path: t, name: r.original_name }; });
    const id = await createArchiveRecord(req.user, f, c.is_training, tmpFiles, c.id);
    cases.change(req.user, c.id, `Media added to reference archive as ${id}`, () => {}); res.status(201).json({ id });
  }));

  // ---------------------------------------------------------------- reports
  // ---------------------------------------------------------------- automatic investigations (one click: extract, analyse, search, compare, assess, report)
  api.post("/investigations", requirePerm("case.create"), upload.array("files", 5), h((req, res) => {
    const b = req.body || {};
    try { res.status(202).json(investigations.start(req.user, { text: b.text, url: b.url, files: req.files || [], isTraining: b.is_training === "true" || b.is_training === true })); }
    catch (e) { cleanup(req.files || []); throw e; }
  }));
  api.get("/investigations", (req, res) => res.json({ investigations: investigations.list({ from: req.query.from, to: req.query.to, training: scopeOf(req) === 1, limit: req.query.limit }), timezone: "EAT (UTC+3)" }));
  api.get("/investigations/:id", (req, res) => res.json(investigations.get(req.params.id)));
  api.get("/investigations/:id/report.:fmt(html|pdf|docx|json)", h(async (req, res) => {
    const f = await investigations.file(req.params.id, req.params.fmt);
    if (req.params.fmt === "html") res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    if (req.params.fmt !== "html" || req.query.download) res.setHeader("Content-Disposition", `attachment; filename="${f.name}"`);
    res.type(f.type).send(f.body);
  }));
  api.post("/investigations/:id/review", requirePerm("case.approve"), h((req, res) => { investigations.review(req.user, req.params.id, req.body?.note); res.json(investigations.get(req.params.id)); }));

  api.get("/reports", (req, res) => {
    const t = scopeOf(req);
    res.json({
      approved: db.prepare("SELECT r.id, r.case_id, r.revision, r.sha256, r.created_at, c.title, c.conclusion, u.display_name AS approved_by FROM reports r JOIN cases c ON c.id = r.case_id LEFT JOIN users u ON u.id = r.approved_by WHERE c.is_training = ? ORDER BY r.created_at DESC").all(t),
      drafts: db.prepare("SELECT c.id AS case_id, c.title, c.status, c.revision, c.updated_at, u.display_name AS assigned FROM cases c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.is_training = ? AND c.status IN ('analyst_review','needs_evidence','awaiting_approval') ORDER BY c.updated_at DESC").all(t)
    });
  });
  api.get("/reports/:rid.:fmt(html|json|pdf|csv)", h(async (req, res) => {
    const r = db.prepare("SELECT * FROM reports WHERE id = ?").get(req.params.rid); if (!r) throw new HttpError(404, "Report not found.");
    if (req.query.download === "1" || ["pdf", "csv"].includes(req.params.fmt)) { audit(req.user, `Approved report exported (${req.params.fmt})`, "case", r.case_id, { report: r.id }); res.setHeader("Content-Disposition", `attachment; filename="${r.id}.${req.params.fmt}"`); }
    res.setHeader("X-Report-SHA256", r.sha256);
    if (req.params.fmt === "json") return res.type("application/json").send(r.json_snapshot);
    if (req.params.fmt === "pdf") return res.type("application/pdf").send(await reportPdf(JSON.parse(r.json_snapshot), { approved: true, sha256: r.sha256, reportId: r.id }));
    if (req.params.fmt === "csv") return res.type("text/csv; charset=utf-8").send(reportCsv(JSON.parse(r.json_snapshot)));
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'"); res.type("html").send(r.html_snapshot);
  }));

  // ---------------------------------------------------------------- administration
  api.get("/users", requirePerm("users.manage"), (req, res) => res.json({ users: users() }));
  const tempPassword = () => Array.from({ length: 3 }, () => Math.random().toString(36).slice(2, 7)).join("-") + Math.floor(Math.random() * 90 + 10);
  api.post("/users", requirePerm("users.manage"), h((req, res) => {
    const { username, display_name, role } = req.body || {};
    if (!/^[a-z0-9._-]{3,40}$/i.test(username || "")) throw new HttpError(400, "Username: 3–40 letters, numbers, dots, dashes or underscores.");
    if (!String(display_name || "").trim()) throw new HttpError(400, "Display name is required.");
    if (!ROLES.includes(role)) throw new HttpError(400, "Choose a role.");
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new HttpError(409, "That username is taken.");
    const pw = tempPassword();
    const id = db.prepare("INSERT INTO users(username,display_name,role,password_hash,must_change_password,created_at) VALUES (?,?,?,?,1,?)").run(username, String(display_name).trim().slice(0, 80), role, hashPassword(pw), nowISO()).lastInsertRowid;
    audit(req.user, "User created", "user", String(id), { username, role }); res.status(201).json({ id, temporary_password: pw });
  }));
  api.patch("/users/:uid", requirePerm("users.manage"), h((req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(+req.params.uid); if (!u) throw new HttpError(404, "User not found.");
    const set = {};
    if (req.body.role !== undefined) { if (!ROLES.includes(req.body.role)) throw new HttpError(400, "Unknown role."); set.role = req.body.role; }
    if (req.body.active !== undefined) set.active = req.body.active ? 1 : 0;
    if (req.body.display_name !== undefined) set.display_name = String(req.body.display_name).trim().slice(0, 80);
    if (u.id === req.user.id && (set.active === 0 || (set.role && set.role !== "admin"))) throw new HttpError(400, "You cannot disable or demote your own account.");
    if ((set.active === 0 || (set.role && set.role !== "admin")) && u.role === "admin" && db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n <= 1) throw new HttpError(400, "Keep at least one active administrator.");
    if (!Object.keys(set).length) return res.json({ ok: true });
    db.prepare(`UPDATE users SET ${Object.keys(set).map(k => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...set, id: u.id });
    if (set.active === 0 || set.role) sessions.revokeUser(u.id);
    audit(req.user, "User updated", "user", String(u.id), set); res.json({ ok: true });
  }));
  api.post("/users/:uid/reset-password", requirePerm("users.manage"), h((req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(+req.params.uid); if (!u) throw new HttpError(404, "User not found.");
    const pw = tempPassword();
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(hashPassword(pw), u.id); sessions.revokeUser(u.id);
    audit(req.user, "Password reset", "user", String(u.id)); res.json({ temporary_password: pw });
  }));
  api.get("/admin/integrations", requirePerm("settings.manage"), (req, res) => {
    const st = fs.statSync(path.join(config.dataDir, "aivs.db"));
    res.json({ ai: ai.status(), ocr: { languages: ocrAvailable(), engine: "Tesseract.js 5.1.1 (runs in the analyst's browser; served from this server)" },
      storage: { dataDir: config.dataDir, databaseBytes: st.size, objects: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM objects").get() },
      security: { cookieSecure: config.cookieSecure, sessionHours: config.sessionHours, allowSelfApproval: config.allowSelfApproval, maxUploadMb: config.maxUploadMb } });
  });
  api.put("/admin/settings/ai_enabled", requirePerm("settings.manage"), h((req, res) => {
    const v = req.body?.value ? "true" : "false";
    db.prepare("INSERT INTO settings(key,value) VALUES ('ai_enabled',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
    audit(req.user, `AI assistance ${v === "true" ? "enabled" : "disabled"}`, "settings", "ai_enabled"); res.json({ ok: true });
  }));
  api.get("/audit", requirePerm("audit.read"), (req, res) => {
    const lim = Math.min(500, +req.query.limit || 100), before = +req.query.before || 1e15;
    res.json({ entries: db.prepare("SELECT id, at, username, action, entity, entity_id, details FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, lim) });
  });
  api.get("/audit/verify", requirePerm("audit.read"), (req, res) => res.json(verifyChain(db)));
  api.post("/admin/training", requirePerm("settings.manage"), h(async (req, res) => res.json(await seedTraining(ctx, req.user))));
  api.post("/admin/training/coverage-demo", requirePerm("settings.manage"), h(async (req, res) => res.json(await seedCoverageDemo(ctx, req.user))));
  api.get("/admin/usage", requirePerm("settings.manage"), (req, res) => res.json(admin.usage({ days: Math.min(730, Number(req.query.days) || 90) })));
  api.get("/admin/storage", requirePerm("settings.manage"), (req, res) => res.json(admin.storageInfo()));
  api.get("/admin/backups", requirePerm("settings.manage"), (req, res) => res.json({ backups: admin.listBackups(), dir: admin.backupDir(), keep: Number(db.prepare("SELECT value FROM settings WHERE key = 'backup_keep'").get()?.value || config.backupKeep || 7), automatic: !config.backupDisabled }));
  api.post("/admin/backups", requirePerm("settings.manage"), h(async (req, res) => res.status(201).json(await admin.backupNow(req.user, "manual"))));
  api.get("/admin/retention", requirePerm("settings.manage"), (req, res) => res.json(admin.retention()));
  api.put("/admin/retention", requirePerm("settings.manage"), h((req, res) => { admin.setRetention(req.user, req.body || {}); res.json(admin.retention()); }));
  api.post("/admin/retention/apply", requirePerm("settings.manage"), h((req, res) => { const b = req.body || {}; if (b.confirm !== true) throw new HttpError(400, "Confirm the deletion."); res.json(admin.applyRetention(req.user, { io_ids: Array.isArray(b.io_ids) ? b.io_ids : [], assistant_case_ids: Array.isArray(b.assistant_case_ids) ? b.assistant_case_ids.map(String) : [], tmp: !!b.tmp, watch: !!b.watch })); }));
  api.post("/admin/storage/verify", requirePerm("settings.manage"), h(async (req, res) => {
    const objs = db.prepare("SELECT sha256 FROM objects").all(); let bad = [];
    for (const o of objs) if (!(await storage.verify(o.sha256))) bad.push(o.sha256);
    audit(req.user, "Stored files verified", "storage", null, { checked: objs.length, failed: bad.length }); res.json({ checked: objs.length, failed: bad });
  }));

  api.use((req, _res, next) => next(new HttpError(404, "Not found.")));
  app.use("/api", api);

  // errors: JSON for the API, never stack traces
  app.use((err, req, res, _next) => {
    let status = err.status || 500, message = err.message || "Unexpected error.";
    if (err instanceof multer.MulterError) { status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400; message = err.code === "LIMIT_FILE_SIZE" ? `A file is larger than the ${config.maxUploadMb} MB limit.` : `Upload problem: ${err.message}.`; }
    if (err.type === "entity.too.large") { status = 413; message = "Request too large."; }
    if (status >= 500 && !(err instanceof HttpError)) { console.error(err); message = "Something went wrong on the server. The error has been logged."; }
    res.status(status).json({ error: message, details: err.details });
  });
  return { app, admin, ctx };
}

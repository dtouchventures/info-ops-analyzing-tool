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
import { makeAI } from "./ai/index.js";
import { seedTraining } from "./lib/training.js";
import { fetchPage } from "./lib/fetchurl.js";
import { reportPdf, reportCsv } from "./lib/pdf.js";
import { makeRetrieval, OFFICIAL_SOURCES } from "./lib/retrieval.js";
import { makeIo, sampleDataset, CAVEATS as IO_CAVEATS } from "./lib/io.js";
import { extractDocument } from "./lib/docs.js";
import { makeAssistant } from "./lib/assistant.js";
import { makeKb, sampleKb } from "./lib/kb.js";
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
  const io = makeIo(db, { audit });
  const kb = makeKb(db, { audit });
  // the assistant's AI connection (a scripted double in tests: cites the first record sent, or invents one on request)
  const mockChat = { async chat(_c, { messages }) { const ids = [...messages.at(-1).content.matchAll(/<source id="([^"]+)"/g)].map(m => m[1]); return { text: `**Findings**\nThe content is recorded [${ids[0]}].${process.env.AIVS_MOCK_AI === "invent" ? " A ministry statement confirms it [E-999999]." : ""}\n**Uncertainties**\nNo independent source yet.`, model: "mock-1" }; } };
  const assistant = makeAssistant(db, { config, cases, audit, aiStatus: () => ai.status(), provider: () => (config.ai.provider === "mock" && config.isTest ? mockChat : aiProviders[config.ai.provider]), usage });
  const sessions = makeSessions(db, config);
  const ctx = { db, audit, storage, media, cases, reports, ai, sessions, config, retrieval, usage };

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

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
  const HEAVY = /^\/(verify|check-image|archive(\/import)?|cases\/[^/]+\/(media|analyse|ai\/runs|to-archive|assistant)|media\/[^/]+\/frames|cases\/[^/]+\/retrieve|evidence\/[^/]+\/check-source|io\/datasets(\/\d+\/(analyse|add))?|io\/sample|extract-text|kb\/datasets(\/\d+\/evaluate)?|kb\/sample)$/;
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
      page = await fetchPage(input, { allowPrivate: !!config.allowPrivateFetch });
      if (!page.text || page.text.replace(/\s/g, "").length < 40) throw new HttpError(422, "No readable text was found on that page. It may need JavaScript or a login. Open it yourself and paste the text instead.");
      snap = await storage.putBuffer(page.raw, page.mime);
      let text = page.text; if (text.length > 12000) { text = text.slice(0, 12000); truncated = true; }
      Object.assign(fields, { title: String(b.title || page.title || new URL(page.finalUrl).hostname).slice(0, 200), claim_text: (page.title && !text.startsWith(page.title) ? `${page.title}\n\n` : "") + text,
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
      audit(req.user, "Source page retrieved and archived", "case", id, { url: input, final_url: page.finalUrl, sha256: snap.sha256, bytes: page.raw.length, published: page.published, published_basis: page.publishedBasis, truncated });
    }
    await cases.startAnalysis(req.user, id);
    // evidence search: local sources always; external services only when configured and requested
    let search = null;
    const ext = retrieval.status().filter(s => s.sends_to).map(s => s.key);   // unconfigured services report "not configured"
    if (b.search !== false) { try { search = await retrieval.retrieve(req.user, id, { use: ["kb", "holdings", ...(b.search ? ext : [])] }, cases); } catch (e) { search = { error: e.message }; } }
    const agg = cases.aggregate(id);
    res.status(201).json({ id, status: agg.case.status, search, claims: agg.claims.filter(c => !c.removed).map(c => ({ id: c.id, text: c.text, kind: c.kind, claim_type: c.claim_type, suggested_assessment: c.suggested_assessment, suggested_basis: c.suggested_basis })), truncated,
      evidence: agg.evidence.filter(e => e.status === "suggested").map(e => ({ id: e.id, kind: e.kind, origin: e.origin, connector: e.connector, text: e.text, source_url: e.source_url, source_title: e.source_title, source_publisher: e.source_publisher, rating: e.rating, claim_id: e.claim_id })),
      source: page ? { title: page.title, site: page.site, final_url: page.finalUrl, published: page.published, published_basis: page.publishedBasis, modified: page.modified, sha256: snap.sha256, bytes: page.raw.length } : null });
  }));
  api.get("/cases/:id/snapshot", (req, res) => {
    const c = cases.mustCase(req.params.id); if (!c.source_snapshot_sha256) throw new HttpError(404, "No archived copy of a source page for this case.");
    audit(req.user, "Archived source page downloaded", "case", c.id, { sha256: c.source_snapshot_sha256 });
    res.sendFile(storage.pathOf(c.source_snapshot_sha256), { headers: { "Content-Type": `${c.source_snapshot_mime || "text/html"}; charset=utf-8`, "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${c.id}-source-${c.source_snapshot_sha256.slice(0, 12)}.${c.source_snapshot_mime === "text/plain" ? "txt" : "html"}"` } });
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
  api.get("/cases/:id/assistant", (req, res) => { const c = cases.mustCase(req.params.id); res.json({ messages: assistant.list(c.id), ai: ai.status(), is_training: !!c.is_training }); });
  api.post("/cases/:id/assistant", requirePerm("note.write"), h(async (req, res) => {
    const b = req.body || {}; if (b.mode === "ai" && !can(req.user, "ai.request")) throw new HttpError(403, "Your role cannot send case content to the AI service.");
    res.status(201).json(await assistant.ask(req.user, req.params.id, { question: b.question, mode: b.mode === "ai" ? "ai" : "rules" }));
  }));
  api.delete("/cases/:id/assistant", requirePerm("case.edit"), h((req, res) => { assistant.clear(req.user, req.params.id); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- information operations monitor
  const ioUpload = multer({ dest: storage.tmpDir, limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 30 } });
  api.get("/io/datasets", (req, res) => res.json({ datasets: io.list(), caveats: IO_CAVEATS }));
  api.post("/io/datasets", requirePerm("io.import"), ioUpload.single("file"), h((req, res) => {
    const f = req.file; if (!f) throw new HttpError(400, "Choose a CSV or JSON file of posts.");
    let buf; try { buf = fs.readFileSync(f.path); } finally { cleanup([f]); }
    const b = req.body || {}, mapping = {}; for (const k of ["text", "account", "posted_at", "platform", "post_id", "reply_to", "repost_of", "likes", "shares", "account_created_at"]) if (b[`map_${k}`]) mapping[k] = String(b[`map_${k}`]);
    res.status(201).json(io.importPosts(req.user, { buf, filename: f.originalname, name: b.name, description: b.description, source: b.source, authorisation: b.authorisation, mapping }));
  }));
  api.post("/io/datasets/:id/add", requirePerm("io.import"), ioUpload.single("file"), h((req, res) => {
    const f = req.file; if (!f) throw new HttpError(400, "Choose a CSV or JSON file, or screenshots, with the posts to add.");
    let buf; try { buf = fs.readFileSync(f.path); } finally { cleanup([f]); }
    const b = req.body || {}, mapping = {}; for (const k of ["text", "account", "posted_at", "platform", "post_id", "reply_to", "repost_of", "likes", "shares", "account_created_at"]) if (b[`map_${k}`]) mapping[k] = String(b[`map_${k}`]);
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
    verdicts: VERDICTS, verdictHelp: VERDICT_HELP, strengthLabels: STRENGTH_LABELS, topics: TOPICS, search: retrieval.status(), officialSources: OFFICIAL_SOURCES,
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
        out.push({ id: row.id, name: row.original_name, sha256: row.sha256, kind: row.kind, identicalTo: same });
      } catch (e) { fs.rmSync(f.path, { force: true }); errors.push(e.message); }
    }
    if (out.length) cases.change(req.user, c.id, `Media received: ${out.map(o => `${o.id} (${o.name})`).join(", ")}`, () => {}, { sha256: out.map(o => o.sha256) });
    res.status(out.length ? 201 : 422).json({ media: out, errors });
  }));
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
  return { app, ctx };
}

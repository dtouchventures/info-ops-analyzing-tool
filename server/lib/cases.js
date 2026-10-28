import { MAX_CASE_CLAIMS, CLAIM_LIMIT_MESSAGE } from "../../shared/claim-limit.js";
// Case domain service: aggregate reads, versioned edits, workflow transitions, local analysis.
import { nowISO, nextId } from "./db.js";
import { HttpError, can } from "./auth.js";
import { runMatching } from "./matching.js";
import { THRESH } from "./hashing.js";
import { detectAccountLocation, LOCATION_SOURCES } from "../../shared/account-location.js";
import { VERDICTS, CONCLUSION_LABELS, ACTIVE_VERDICTS, LEGACY_VERDICTS, expectedConclusion as expectedFromClaims, verdictNeeds, evidenceStrength } from "../../shared/verdict.js";
import { extractClaims, extractEntities, splitSentences, injectionFlags, classifyStatement, redFlags, topicOf, TOPICS } from "../../shared/text.js";

export const STATES = {
  draft: "Draft", analysing: "Analysing", analysis_failed: "Analysis failed", analyst_review: "Under investigation",
  awaiting_approval: "Awaiting review", needs_evidence: "Needs additional evidence", approved: "Approved", rejected: "Rejected", archived: "Archived"
};
export const CONCLUSIONS = CONCLUSION_LABELS;
export const ASSESSMENTS = ["unassessed", ...Object.keys(VERDICTS)];
export const EDITABLE = new Set(["draft", "analysis_failed", "analyst_review", "needs_evidence"]);
export const DEFAULT_CHECKS = [
  ["source", "Earliest available version and original poster traced"],
  ["published", "Publication date established from the source, not from the post's own wording"],
  ["event_date", "Claimed event date compared with archive, metadata and visible-text dates"],
  ["place", "Location checked against visible features (terrain, signs, landmarks)"],
  ["archive", "Reference-archive leads reviewed and their provenance checked"],
  ["text", "Visible text read (OCR checked by eye) and compared with the claim"],
  ["metadata", "Embedded metadata reviewed as a lead only"],
  ["official", "Official or primary source consulted"],
  ["second", "Independent second source consulted"]
];

// overall conclusion implied by per-claim assessments
export const expectedConclusion = expectedFromClaims;

// short title from the text when none is given; hashtags normalised to "#tag", at most 50
export function autoTitle(t) { const s = String(t || "").trim(), first = s.replace(/\s+/g, " ").slice(0, 90); return (first.length < s.replace(/\s+/g, " ").length ? first.replace(/\s+\S*$/, "") + "…" : first) || "Untitled case"; }
export function cleanTags(v) { let a = v; if (typeof v === "string") { try { a = JSON.parse(v); } catch { a = v.split(/[\s,]+/); } } if (!Array.isArray(a)) a = [];
  return [...new Set(a.map(x => String(x).trim()).filter(Boolean).map(x => "#" + x.replace(/^#+/, "")).filter(x => /^#[\p{L}\p{N}_]{1,60}$/u.test(x)))].slice(0, 50); }
export function makeCases(db, { audit, allowSelfApproval = false, isTest = false }) {
  db.prepare("UPDATE cases SET status='analysis_failed', analysis_error='The server stopped during analysis. Retry the task; existing claims and evidence were retained.' WHERE status='analysing'").run();
  const getCase = id => db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
  const mustCase = id => { const c = getCase(id); if (!c) throw new HttpError(404, `Case ${id} not found.`); return c; };

  const claimCount = id => db.prepare("SELECT COUNT(*) n FROM claims WHERE case_id = ?").get(id).n;
  function claimCapacity(id) {
    const total = claimCount(id), active = db.prepare("SELECT COUNT(*) n FROM claims WHERE case_id = ? AND removed = 0").get(id).n;
    return { used: total, active, max: MAX_CASE_CLAIMS, remaining: Math.max(0, MAX_CASE_CLAIMS - total), selection_required: active > MAX_CASE_CLAIMS };
  }
  function assertReportClaims(id) {
    if (claimCapacity(id).selection_required) throw new HttpError(409, "Choose at most two claims for this older case before generating a new report. Existing claims and evidence are preserved.");
  }
  function requireRoom(user, id, count = 1) {
    if (claimCount(id) + count > MAX_CASE_CLAIMS) {
      audit(user, "Claim creation rejected: case limit", "case", id, { requested: count, maximum: MAX_CASE_CLAIMS });
      throw new HttpError(409, CLAIM_LIMIT_MESSAGE);
    }
  }
  function proposeClaims(id, items, source = "analysis") {
    mustCase(id);
    const ins = db.prepare("INSERT OR IGNORE INTO claim_candidates(case_id,text,kind,origin,source_ref,created_at) VALUES (?,?,?,?,?,?)");
    db.transaction(() => { for (const x of items) {
      const text = String(x.text || "").trim().slice(0, 2000); if (text) ins.run(id, text, x.kind || "statement", x.origin || "extracted", source, nowISO());
    } })();
  }
  function selectClaims(user, id, ids) {
    const c = mustCase(id); requireEdit(user, c);
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_CASE_CLAIMS || new Set(ids).size !== ids.length) throw new HttpError(400, "Choose one or two existing claims.");
    const active = db.prepare("SELECT id FROM claims WHERE case_id = ? AND removed = 0").all(id);
    if (ids.some(cid => !active.some(cl => cl.id === cid))) throw new HttpError(400, "Choose claims belonging to this case.");
    if (active.length <= MAX_CASE_CLAIMS) throw new HttpError(409, "This case does not need a legacy claim selection.");
    change(user, id, "Legacy claim selection confirmed", () => {
      for (const cl of active) if (!ids.includes(cl.id)) db.prepare("UPDATE claims SET removed = 1 WHERE id = ?").run(cl.id);
    }, { selected: ids, note: "Other claims and their evidence links remain in the historical record." });
  }

  function aggregate(id, { forUser } = {}) {
    const c = mustCase(id);
    const users = Object.fromEntries(db.prepare("SELECT id, username, display_name, role FROM users").all().map(u => [u.id, u]));
    const docT = db.prepare("SELECT extractor, pages, chars, truncated, warnings, substr(text, 1, 6000) AS preview FROM document_texts WHERE media_id = ?");
    const media = db.prepare("SELECT * FROM media WHERE case_id = ? ORDER BY uploaded_at, id").all(id).map(m => { const d = m.kind === "document" ? docT.get(m.id) : null; return { ...m, metadata: JSON.parse(m.metadata_json || "{}"), metadata_json: undefined, document: d ? { ...d, warnings: JSON.parse(d.warnings || "[]") } : undefined }; });
    const matches = db.prepare(`SELECT x.*, a.title AS archive_title, a.documented_date AS archive_date, a.record_type AS archive_type, a.source_ref AS archive_ref, a.description AS archive_description,
        oc.title AS case_title, oc.status AS case_status, oc.conclusion AS case_conclusion, oc.received_at AS case_received_at
      FROM matches x LEFT JOIN archive_records a ON a.id = x.target_archive_id LEFT JOIN cases oc ON oc.id = x.target_case_id WHERE x.case_id = ? ORDER BY x.score`).all(id);
    const claims = db.prepare("SELECT * FROM claims WHERE case_id = ? ORDER BY seq").all(id);
    const evidence = db.prepare("SELECT * FROM evidence WHERE case_id = ? ORDER BY created_at, id").all(id).map(e => ({ ...e, suggested_links: JSON.parse(e.suggested_links || "[]") }));
    const links = db.prepare("SELECT l.* FROM evidence_links l JOIN evidence e ON e.id = l.evidence_id WHERE e.case_id = ?").all(id);
    const evVers = db.prepare("SELECT v.* FROM evidence_versions v JOIN evidence e ON e.id = v.evidence_id WHERE e.case_id = ? ORDER BY v.id").all(id);
    for (const e of evidence) { e.links = links.filter(l => l.evidence_id === e.id); e.versions = evVers.filter(v => v.evidence_id === e.id); }
    for (const cl of claims) cl.strength = cl.removed ? null : evidenceStrength(cl, evidence);
    const related = db.prepare("SELECT l.related_id AS id, l.relation, l.note, l.created_at, c.title, c.status, c.conclusion FROM case_links l JOIN cases c ON c.id = l.related_id WHERE l.case_id = ? ORDER BY l.created_at").all(id);
    const retrievals = db.prepare("SELECT connector, query, status, error, results, at, claim_id FROM retrievals WHERE case_id = ? ORDER BY id DESC LIMIT 60").all(id);
    const notes = db.prepare("SELECT * FROM case_notes WHERE case_id = ? ORDER BY id").all(id).map(n => n.deleted ? { ...n, body: "" } : n);
    const noteVers = db.prepare("SELECT v.* FROM case_note_versions v JOIN case_notes n ON n.id = v.note_id WHERE n.case_id = ? ORDER BY v.id").all(id);
    for (const n of notes) n.versions = n.deleted ? [] : noteVers.filter(v => v.note_id === n.id);
    const ocr = db.prepare("SELECT * FROM ocr_texts WHERE case_id = ? ORDER BY id").all(id);
    for (const o of ocr) o.versions = db.prepare("SELECT * FROM ocr_versions WHERE ocr_id = ? ORDER BY id").all(o.id);
    const transcripts = db.prepare("SELECT id, media_id, status, language, language_basis, engine, model, speech_found, finished_at FROM transcripts WHERE case_id = ? ORDER BY created_at").all(id)
      .map(t => ({ ...t, segments: t.status === "done" ? db.prepare("SELECT id, seq, start_s, end_s, text_current AS text, unclear, text_current != text_machine AS edited FROM transcript_segments WHERE transcript_id = ? ORDER BY seq").all(t.id) : [] }));
    const checklist = db.prepare("SELECT * FROM checklist WHERE case_id = ? ORDER BY rowid").all(id);
    const aiRuns = db.prepare("SELECT id, provider, model, prompt_version, status, requested_by, started_at, finished_at, duration_ms, sent_json, response_json, validation_errors, error, injection_flags FROM ai_runs WHERE case_id = ? ORDER BY started_at DESC").all(id)
      .map(r => ({ ...r, sent: JSON.parse(r.sent_json), response: r.response_json ? JSON.parse(r.response_json) : null, validation_errors: r.validation_errors ? JSON.parse(r.validation_errors) : [], injection_flags: r.injection_flags ? JSON.parse(r.injection_flags) : [], sent_json: undefined, response_json: undefined }));
    const reports = db.prepare("SELECT id, revision, sha256, approved_by, created_at FROM reports WHERE case_id = ? ORDER BY revision").all(id);
    const versions = db.prepare("SELECT version, revision, reason, changed_by, changed_at FROM case_versions WHERE case_id = ? ORDER BY version DESC").all(id);
    const u = uid => uid ? { id: uid, name: users[uid]?.display_name || "unknown", username: users[uid]?.username } : null;
    const perms = forUser ? {
      edit: canEditCase(forUser, c) && EDITABLE.has(c.status), approve: can(forUser, "case.approve") && c.status === "awaiting_approval" && (allowSelfApproval || !isOwnWork(forUser, c)),
      assign: can(forUser, "case.assign") && !["approved", "archived"].includes(c.status), ai: can(forUser, "ai.request") && canEditCase(forUser, c) && EDITABLE.has(c.status),
      revise: (can(forUser, "case.archive") || c.assigned_to === forUser.id) && ["approved", "archived", "rejected"].includes(c.status),
      archive: can(forUser, "case.archive") && ["approved", "rejected"].includes(c.status), ownWork: isOwnWork(forUser, c), note: can(forUser, "note.write")
    } : undefined;
    return {
      case: { ...c, hashtags: JSON.parse(c.hashtags || "[]"), status_label: STATES[c.status], conclusion_label: CONCLUSIONS[c.conclusion] || null, assigned: u(c.assigned_to), creator: u(c.created_by), submitter: u(c.submitted_by), decider: u(c.decided_by), investigation: db.prepare("SELECT id, report_id FROM investigations WHERE case_id = ? ORDER BY created_at DESC LIMIT 1").get(id) || null },
      media, matches, claims, evidence, notes, ocr, transcripts, checklist, related, retrievals, aiRuns, reports, versions, users: Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.display_name])),
      tasks: db.prepare("SELECT id,kind,status,error FROM case_tasks WHERE case_id=? ORDER BY id DESC LIMIT 10").all(id), claimCapacity: claimCapacity(id), claimCandidates: db.prepare("SELECT * FROM claim_candidates WHERE case_id = ? ORDER BY id").all(id), expectedConclusion: expectedConclusion(claims), perms, thresholds: THRESH
    };
  }

  const isOwnWork = (user, c) => c.assigned_to === user.id || c.submitted_by === user.id;
  function canEditCase(user, c) {
    if (!can(user, "case.edit")) return false;
    if (user.role === "analyst") return c.assigned_to === user.id || (c.assigned_to == null && c.created_by === user.id);
    return true;
  }
  function requireEdit(user, c, { states = EDITABLE } = {}) {
    if (!canEditCase(user, c)) throw new HttpError(403, "Only the assigned analyst, a reviewer or an administrator can change this case.");
    if (!states.has(c.status)) throw new HttpError(409, `This case is ${STATES[c.status].toLowerCase()}, so it cannot be changed now.`);
  }

  // full snapshot of the case aggregate after every change; version increments
  // statement-type hints (factual / opinion / prediction / satire / question) follow the current claim text
  function retype(caseId) {
    const up = db.prepare("UPDATE claims SET claim_type = ?, claim_type_cue = ? WHERE id = ?");
    for (const cl of db.prepare("SELECT id, text, kind FROM claims WHERE case_id = ? AND removed = 0").all(caseId)) {
      const t = cl.kind === "statement" || cl.kind === "attribution" ? classifyStatement(cl.text) : { type: "factual", cues: [] };
      up.run(t.type, t.cues.join(", ") || null, cl.id);
    }
  }
  function snapshot(caseId, user, reason) {
    retype(caseId);
    const c = getCase(caseId), v = c.version + 1;
    const snap = {
      case: c, claims: db.prepare("SELECT * FROM claims WHERE case_id = ?").all(caseId),
      evidence: db.prepare("SELECT * FROM evidence WHERE case_id = ?").all(caseId),
      links: db.prepare("SELECT l.* FROM evidence_links l JOIN evidence e ON e.id = l.evidence_id WHERE e.case_id = ?").all(caseId),
      checklist: db.prepare("SELECT * FROM checklist WHERE case_id = ?").all(caseId),
      media: db.prepare("SELECT id, sha256, original_name, kind, parent_media_id, frame_time FROM media WHERE case_id = ?").all(caseId),
      gaps: db.prepare("SELECT * FROM case_gaps WHERE case_id = ?").all(caseId)
    };
    db.prepare("UPDATE cases SET version = ?, updated_at = ? WHERE id = ?").run(v, nowISO(), caseId);
    snap.case.version = v;
    db.prepare("INSERT INTO case_versions(case_id,version,revision,snapshot_json,reason,changed_by,changed_at) VALUES (?,?,?,?,?,?,?)").run(caseId, v, c.revision, JSON.stringify(snap), reason, user?.id ?? null, nowISO());
    return v;
  }
  const tx = fn => db.transaction(fn);
  const change = (user, caseId, reason, fn, auditDetails) => tx(() => { const r = fn(); snapshot(caseId, user, reason); audit(user, reason, "case", caseId, auditDetails); return r; })();

  // ---------------------------------------------------------------- create / edit
  const FIELDS = ["title", "claim_text", "source_platform", "source_url", "source_account", "published_at", "published_basis", "claimed_event_at", "claimed_event_basis", "received_at", "priority", "conclusion", "conclusion_rationale", "uncertainties", "brief", "hashtags", "topic"];
  const clean = (k, v) => {
    if (v === undefined) return undefined;
    if (k === "hashtags") return JSON.stringify(cleanTags(v));
    if (k === "source_platform" && (v === null || String(v).trim() === "")) return "Not recorded";
    if (v === null || v === "") return ["title", "claim_text", "received_at"].includes(k) ? (() => { throw new HttpError(400, `${k.replace(/_/g, " ")} is required.`); })() : null;
    v = String(v);
    if (/_at$/.test(k) && isNaN(new Date(v))) throw new HttpError(400, `${k.replace(/_/g, " ")} is not a valid date.`);
    if (k === "priority" && !["routine", "priority", "urgent"].includes(v)) throw new HttpError(400, "Priority must be routine, priority or urgent.");
    if (k === "conclusion" && !CONCLUSIONS[v]) throw new HttpError(400, "Unknown conclusion.");
    if (k === "topic" && !TOPICS[v]) throw new HttpError(400, "Unknown topic.");
    return v.slice(0, k === "claim_text" || k === "brief" ? 20000 : 4000);
  };

  function create(user, body) {
    const isTraining = body.is_training ? 1 : 0;
    if (!String(body.claim_text || "").trim()) throw new HttpError(400, "Paste the text of the post or report.");
    body = { ...body, title: String(body.title || "").trim() || autoTitle(body.claim_text), source_platform: String(body.source_platform || "").trim() || "Not recorded", received_at: body.received_at || nowISO() };
    return tx(() => {
      const year = new Date().getFullYear();
      const id = isTraining ? nextId(db, "case-training", n => `TR-${String(n).padStart(4, "0")}`) : nextId(db, `case-${year}`, n => `C-${year}-${String(n).padStart(4, "0")}`);
      const now = nowISO(), row = { id, is_training: isTraining, status: "draft", created_by: user.id, assigned_to: user.role === "viewer" ? null : user.id, created_at: now, updated_at: now };
      for (const k of FIELDS) { const v = clean(k, body[k]); if (v !== undefined) row[k] = v; }
      row.claim_text_original = row.claim_text;
      row.priority = row.priority || "routine";
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO cases(${cols.join(",")}) VALUES (${cols.map(c => "@" + c).join(",")})`).run(row);
      const ck = db.prepare("INSERT INTO checklist(case_id,step,label) VALUES (?,?,?)");
      for (const [s, l] of DEFAULT_CHECKS) ck.run(id, s, l);
      db.prepare("INSERT INTO case_versions(case_id,version,revision,snapshot_json,reason,changed_by,changed_at) VALUES (?,?,?,?,?,?,?)").run(id, 1, 1, JSON.stringify({ case: getCase(id) }), "Case created (original submission)", user.id, now);
      audit(user, "Case created", "case", id, { title: row.title, training: !!isTraining });
      return id;
    })();
  }

  function update(user, id, body, expectedVersion) {
    const c = mustCase(id);
    const conclusionOnly = Object.keys(body).every(k => ["conclusion", "conclusion_rationale", "uncertainties", "brief"].includes(k));
    requireEdit(user, c);
    if (expectedVersion != null && +expectedVersion !== c.version) throw new HttpError(409, "Someone else changed this case. Reload to see the latest version, then try again.");
    const set = {};
    for (const k of FIELDS) { const v = clean(k, body[k]); if (v !== undefined) set[k] = v; }
    // the two older conclusions stay only where the case already has them or its older claim verdicts lead to them
    if (LEGACY_VERDICTS.includes(set.conclusion) && set.conclusion !== c.conclusion && set.conclusion !== expectedFromClaims(db.prepare("SELECT assessment, removed FROM claims WHERE case_id = ?").all(c.id)))
      throw new HttpError(400, "That conclusion is no longer offered. Use Supported, Contradicted, Insufficient evidence, Not verifiable or Mixed findings.");
    if (!Object.keys(set).length) return c.version;
    const changed = Object.keys(set).filter(k => String(c[k] ?? "") !== String(set[k] ?? ""));
    if (!changed.length) return c.version;
    return change(user, id, conclusionOnly ? "Findings edited" : `Case details edited (${changed.join(", ")})`, () => {
      db.prepare(`UPDATE cases SET ${Object.keys(set).map(k => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...set, id });
    }, { changed });
  }

  function assign(user, id, userId) {
    const c = mustCase(id);
    if (!can(user, "case.assign")) throw new HttpError(403, "Only reviewers and administrators can assign cases.");
    if (["approved", "archived"].includes(c.status)) throw new HttpError(409, "Approved cases cannot be reassigned. Open a new revision first.");
    const target = userId ? db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(userId) : null;
    if (userId && (!target || target.role === "viewer")) throw new HttpError(400, "Choose an active analyst, reviewer or administrator.");
    change(user, id, `Assigned to ${target ? target.display_name : "nobody"}`, () => db.prepare("UPDATE cases SET assigned_to = ? WHERE id = ?").run(target?.id ?? null, id));
  }

  // ---------------------------------------------------------------- analysis (local)
  const running = new Map();
  function startAnalysis(user, id) {
    const c = mustCase(id);
    if (!canEditCase(user, c)) throw new HttpError(403, "You cannot analyse this case.");
    if (running.has(id)) return running.get(id);
    requireEdit(user, c);
    const media = db.prepare("SELECT COUNT(*) n FROM media WHERE case_id = ?").get(id).n;
    change(user, id, c.status === "analysis_failed" ? "Analysis retried" : c.status === "analyst_review" ? "Analysis re-run" : "Analysis started", () =>
      db.prepare("UPDATE cases SET status = 'analysing', analysis_error = NULL, analysis_attempts = analysis_attempts + 1 WHERE id = ?").run(id), { media });
    const done = new Promise(resolve => setImmediate(async () => {
      try { await analyse(user, id); change(user, id, "Analysis completed", () => db.prepare("UPDATE cases SET status = 'analyst_review' WHERE id = ?").run(id)); }
      catch (e) {
        console.error("analysis failed", id, e);
        change(user, id, "Analysis failed", () => db.prepare("UPDATE cases SET status = 'analysis_failed', analysis_error = ? WHERE id = ?").run(String(e.message || e).slice(0, 500), id), { error: String(e.message || e) });
      } finally { running.delete(id); resolve(); }
    }));
    running.set(id, done);
    return done;
  }

  async function analyse(user, id) {
    const c = getCase(id);
    if (isTest && process.env.AIVS_FAIL_ANALYSIS === c.title) throw new Error("Simulated analysis failure (test hook)");
    const media = db.prepare("SELECT * FROM media WHERE case_id = ?").all(id);
    // claims: extract once, on first analysis, from the working claim text
    let claims = db.prepare("SELECT * FROM claims WHERE case_id = ? AND removed = 0 ORDER BY seq").all(id);
    if (!claimCount(id)) {
      const candidates = extractClaims(c.claim_text, media.length > 0);
      proposeClaims(id, candidates);
      const ins = db.prepare("INSERT INTO claims(id,case_id,seq,text,origin,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)");
      candidates.slice(0, MAX_CASE_CLAIMS).forEach((x, i) => ins.run(nextId(db, "claim", n => `CL-${String(n).padStart(6, "0")}`), id, i + 1, x.text, "extracted", x.kind, null, nowISO()));
      claims = db.prepare("SELECT * FROM claims WHERE case_id = ? AND removed = 0 ORDER BY seq").all(id);
    }
    const timing = claims.find(x => x.kind === "timing"), mediaClaim = claims.find(x => x.kind === "media");
    const { matches, archiveCount } = runMatching(db, c);
    const sugg = [];
    const claimedRef = c.claimed_event_at || c.published_at || (timing ? c.received_at : null);
    for (const m of media.filter(x => x.kind === "image")) {
      const label = m.parent_media_id ? `frame ${m.frame_time?.toFixed(2)}s of ${m.original_name}` : m.original_name;
      const mm = matches.filter(x => x.media_id === m.id);
      for (const x of mm) {
        const dist = `dHash ${x.dhash_distance}/64 + pHash ${x.phash_distance}/64 = ${x.score} bits differ; best on ${x.window_label}${x.mirrored ? ", mirrored" : ""}`;
        if (x.target_archive_id) {
          const a = db.prepare("SELECT * FROM archive_records WHERE id = ?").get(x.target_archive_id);
          const older = claimedRef && new Date(a.documented_date) < new Date(new Date(claimedRef) - 30 * 864e5);
          const what = x.kind === "exact" ? `is byte-for-byte identical (same SHA-256) to the image in archive record ${a.id}` : `is visually similar (${x.level} match: ${dist}) to the image in archive record ${a.id}`;
          const links = [];
          if (a.record_type === "misleading" && mediaClaim) links.push({ claim_id: mediaClaim.id, stance: "contradicts" });
          if (older) links.push({ claim_id: (timing || mediaClaim)?.id, stance: "contradicts" });
          sugg.push({ key: `arc:${m.id}:${a.id}`, kind: "lead", media_id: m.id, archive_id: a.id, links: links.filter(l => l.claim_id),
            text: `Lead: ${label} ${what} “${a.title}”, documented ${a.documented_date}${a.record_type === "misleading" ? " and previously assessed as misleading" : ""}. ${older ? "The archive date is more than 30 days before the claimed timing. " : ""}Check the archive record's provenance before relying on it. Archive context: ${a.description}`,
            reference: `Archive ${a.id}: ${a.source_ref}` });
        } else if (x.target_case_id) {
          const o = db.prepare("SELECT id, title, status, conclusion FROM cases WHERE id = ?").get(x.target_case_id);
          sugg.push({ key: `case:${m.id}:${o.id}`, kind: "lead", media_id: m.id, related_case_id: o.id, links: [],
            text: `Lead: ${label} ${x.kind === "exact" ? "is the identical file (same SHA-256) already received" : `closely resembles media (${dist})`} in case ${o.id} “${o.title}” (${STATES[o.status]}${o.conclusion ? `, ${CONCLUSIONS[o.conclusion]}` : ""}). Review that case before repeating the work.`,
            reference: `Case ${o.id}` });
        }
      }
      if (!mm.some(x => x.target_archive_id)) sugg.push({ key: `noarc:${m.id}`, kind: "lead", media_id: m.id, links: [],
        text: `No earlier copy of ${label} was found among ${archiveCount} reference-archive record(s). This does not show that the media is new, original or authentic, only that it is not in this archive.`,
        reference: `Archive search ${nowISO().slice(0, 16).replace("T", " ")} UTC; thresholds strong ≤ ${THRESH.strong}, possible ≤ ${THRESH.possible} bits` });
      const meta = JSON.parse(m.metadata_json || "{}"), keys = Object.keys(meta);
      sugg.push({ key: `meta:${m.id}`, kind: "lead", media_id: m.id, links: [],
        text: keys.length ? `Lead: embedded metadata in ${label} reports ${keys.map(k => `${k} = ${meta[k]}`).join("; ")}. Metadata can be edited, copied or stripped, so it is a lead to check, not proof of when, where or how the image was made.`
          : `${label} carries no embedded camera metadata (normal after most social-media uploads). Nothing can be concluded from its absence.`,
        reference: `Embedded metadata, ${m.id} (SHA-256 ${m.sha256.slice(0, 12)}…)` });
      if (m.meta_capture_at && claimedRef && new Date(m.meta_capture_at) < new Date(new Date(claimedRef) - 30 * 864e5))
        sugg.push({ key: `metadate:${m.id}`, kind: "lead", media_id: m.id, links: timing ? [{ claim_id: timing.id, stance: "contradicts" }] : [],
          text: `Lead: the metadata capture time of ${label} (${m.meta_capture_at}, time zone unknown) is more than 30 days before the claimed timing. Metadata can be wrong or altered; confirm by other means.`, reference: `Embedded metadata, ${m.id}` });
    }
    // documents: properties, warnings, dates and red flags in the text (all leads for the analyst)
    for (const m of media.filter(x => x.kind === "document")) {
      const meta = JSON.parse(m.metadata_json || "{}"), dt = db.prepare("SELECT * FROM document_texts WHERE media_id = ?").get(m.id), keys = Object.keys(meta).filter(k => k !== "Pages" && k !== "PDFVersion");
      sugg.push({ key: `docmeta:${m.id}`, kind: "lead", media_id: m.id, links: [],
        text: keys.length ? `Lead: the properties of document ${m.original_name} report ${keys.map(k => `${k} = ${meta[k]}`).join("; ")}. Document properties are easy to change and are often left over from templates, so they are a lead to check, not proof of who wrote it or when.`
          : `Document ${m.original_name} carries no author or date properties. Nothing can be concluded from their absence.`, reference: `Document properties, ${m.id} (SHA-256 ${m.sha256.slice(0, 12)}…)` });
      for (const [i, w] of JSON.parse(dt?.warnings || "[]").entries()) if (/tracked changes|saved \d+ times|macros|JavaScript|signature|comment/.test(w))
        sugg.push({ key: `docwarn:${m.id}:${i}`, kind: "observation", media_id: m.id, links: [], text: `Document ${m.original_name}: ${w}`, reference: `Document structure, ${m.id}` });
      if (dt?.text) {
        const ents = extractEntities(dt.text.slice(0, 20000)), created = meta.Created ? new Date(meta.Created) : null;
        const later = created ? ents.dates.filter(d => d.iso && new Date(d.iso) - created > 2 * 864e5) : [];
        if (later.length) sugg.push({ key: `docdate:${m.id}`, kind: "lead", media_id: m.id, links: [],
          text: `Lead: document ${m.original_name} states the date(s) ${later.slice(0, 3).map(d => `“${d.text}”`).join(", ")}, but its properties say it was created on ${meta.Created.slice(0, 10)}, earlier than that. This can be innocent (a template or a draft written in advance) or a sign the date in the text was changed. Compare with the original sender.`, reference: `Document properties and text, ${m.id}` });
        if (ents.numbers.length) sugg.push({ key: `docnum:${m.id}`, kind: "observation", media_id: m.id, links: [], text: `Document ${m.original_name} includes figures or contact details: ${ents.numbers.slice(0, 8).join(", ")}. Check them against official channels before repeating them.`, reference: `Document text, ${m.id}` });
        for (const f of redFlags(dt.text.slice(0, 20000))) sugg.push({ key: `flag:doc:${m.id}:${f.key}`, kind: "lead", media_id: m.id, links: [], text: `Red flag in document ${m.original_name}${f.topic ? ` (${TOPICS[f.topic]})` : ""}: ${f.text} Seen in the text: “${f.cue}”. A red flag is a reason to check, not a finding.`, reference: `AIVS regional checks (rule-based). What to check: ${f.check}` });
        const dinj = injectionFlags(dt.text); if (dinj.length) sugg.push({ key: `inj-doc:${m.id}`, kind: "observation", media_id: m.id, links: [], text: `Document ${m.original_name} contains text addressed to automated or AI systems (${dinj.slice(0, 3).map(x => `“${x}”`).join(", ")}). Treat it as content to examine; it has no effect on this system.`, reference: `Document text, ${m.id}` });
      }
    }
    // visible text (current, analyst-checked OCR)
    for (const o of db.prepare("SELECT * FROM ocr_texts WHERE case_id = ?").all(id)) {
      const ve = extractEntities(o.current_text), ref = claimedRef ? new Date(claimedRef) : null;
      const old = ref ? ve.dates.filter(d => d.iso && new Date(d.iso) < new Date(ref - 365 * 864e5)) : [];
      if (old.length) sugg.push({ key: `ocrdate:${o.id}`, kind: "observation", media_id: o.media_id, links: timing ? [{ claim_id: timing.id, stance: "contradicts" }] : [],
        text: `Text visible in ${o.media_id} includes the date(s) ${old.map(d => `“${d.text}”`).join(", ")}, more than a year before the claimed timing.`, reference: `OCR record ${o.id} (${o.engine}, ${o.lang}; analyst-checked text)` });
      if (ve.numbers.length) sugg.push({ key: `ocrnum:${o.id}`, kind: "observation", media_id: o.media_id, links: [],
        text: `Text visible in ${o.media_id} includes figures or contact details: ${ve.numbers.join(", ")}. Check them against official channels before repeating them.`, reference: `OCR record ${o.id}` });
      const inj = injectionFlags(o.current_text);
      if (inj.length) sugg.push({ key: `inj-ocr:${o.id}`, kind: "observation", media_id: o.media_id, links: [],
        text: `Text in ${o.media_id} appears to address automated or AI systems (${inj.map(x => `“${x}”`).join(", ")}). Treat it as content to examine; it has no effect on this system.`, reference: `OCR record ${o.id}` });
    }
    const inj = injectionFlags(c.claim_text);
    if (inj.length) sugg.push({ key: "inj-claim", kind: "observation", links: [], text: `The post text appears to address automated or AI systems (${inj.map(x => `“${x}”`).join(", ")}). This can indicate a deliberate attempt to manipulate automated checks.`, reference: "Submitted claim text" });

    // regional red flags (Kenya / East Africa): leads with the public sources that can settle them
    const flags = redFlags(c.claim_text);
    for (const f of flags) sugg.push({ key: `flag:${f.key}`, kind: "lead", links: [], text: `Red flag${f.topic ? ` (${TOPICS[f.topic]})` : ""}: ${f.text} Seen in the text: “${f.cue}”. A red flag is a reason to check, not a finding.`, reference: `AIVS regional checks (rule-based). What to check: ${f.check}` });
    const topic = topicOf(flags); if (topic) db.prepare("UPDATE cases SET topic = ? WHERE id = ? AND topic IS NULL").run(topic, id);

    const insE = db.prepare(`INSERT OR IGNORE INTO evidence(id,case_id,kind,origin,status,text,reference,media_id,archive_id,related_case_id,sys_key,suggested_links,source_date,created_at)
      VALUES (?,?,?,'system','suggested',?,?,?,?,?,?,?,?,?)`);
    const arcDate = db.prepare("SELECT documented_date FROM archive_records WHERE id = ?");
    const exists = db.prepare("SELECT 1 FROM evidence WHERE case_id = ? AND sys_key = ?");
    let added = 0;
    tx(() => { for (const s of sugg) if (!exists.get(id, s.key)) { insE.run(nextId(db, "evidence", n => `E-${String(n).padStart(6, "0")}`), id, s.kind, s.text, s.reference, s.media_id || null, s.archive_id || null, s.related_case_id || null, s.key, JSON.stringify(s.links || []), s.archive_id ? arcDate.get(s.archive_id)?.documented_date ?? null : null, nowISO()); added++; } })();
    audit(user, "Local analysis ran", "case", id, { images: media.filter(x => x.kind === "image").length, matches: matches.length, newSuggestions: added });
  }

  // ---------------------------------------------------------------- claims
  // propose checkable statements from a document's text as claims (the analyst removes what does not matter)
  function claimsFromDocument(user, mediaId) {
    const m = db.prepare("SELECT * FROM media WHERE id = ?").get(mediaId); if (!m || m.kind !== "document" || !m.case_id) throw new HttpError(404, "Document not found.");
    const c = mustCase(m.case_id); requireEdit(user, c);
    const dt = db.prepare("SELECT text FROM document_texts WHERE media_id = ?").get(m.id), ocr = db.prepare("SELECT current_text FROM ocr_texts WHERE media_id = ? ORDER BY id DESC").get(m.id);
    const text = String(dt?.text || "").replace(/^--- Page \d+ ---$/gm, "").trim() || ocr?.current_text || "";
    if (text.length < 20) throw new HttpError(409, "This document has no readable text yet. If it is scanned, read its pages with OCR first.");
    const have = new Set(db.prepare("SELECT lower(text) t FROM claims WHERE case_id = ? AND removed = 0").all(c.id).map(r => r.t));
    const found = extractClaims(text.slice(0, 30000), false).filter(x => x.kind !== "media" && x.text.length >= 20 && !have.has(x.text.toLowerCase())).slice(0, 15);
    proposeClaims(c.id, found, `document:${m.id}`);
    if (!found.length) return { added: 0 };
    requireRoom(user, c.id);
    const eligible = found.slice(0, claimCapacity(c.id).remaining);
    change(user, c.id, `${found.length} claim(s) proposed from document ${m.id} (${m.original_name})`, () => {
      let seq = db.prepare("SELECT COALESCE(MAX(seq),0) s FROM claims WHERE case_id = ?").get(c.id).s;
      const ins = db.prepare("INSERT INTO claims(id,case_id,seq,text,origin,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)");
      for (const x of eligible) ins.run(nextId(db, "claim", n => `CL-${String(n).padStart(6, "0")}`), c.id, ++seq, x.text.slice(0, 1000), "extracted", x.kind, user.id, nowISO());
    }, { media_id: m.id });
    return { added: eligible.length, proposed: found.length };
  }
  function addClaim(user, caseId, { text, kind = "statement", origin = "analyst" }) {
    const c = mustCase(caseId); requireEdit(user, c);
    if (!String(text || "").trim()) throw new HttpError(400, "Claim text is required.");
    if (!["statement", "timing", "media", "location", "attribution"].includes(kind)) throw new HttpError(400, "Unknown claim type.");
    requireRoom(user, caseId);
    return db.transaction(() => {
      requireRoom(user, caseId);
      const seq = (db.prepare("SELECT MAX(seq) m FROM claims WHERE case_id = ?").get(caseId).m || 0) + 1;
      const cid = nextId(db, "claim", n => `CL-${String(n).padStart(6, "0")}`);
      change(user, caseId, `Claim ${seq} added`, () => db.prepare("INSERT INTO claims(id,case_id,seq,text,origin,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(cid, caseId, seq, String(text).trim().slice(0, 2000), origin === "ai" ? "ai" : "analyst", kind, user.id, nowISO()));
      return cid;
    }).immediate();
  }
  const mustClaim = id => { const x = db.prepare("SELECT * FROM claims WHERE id = ?").get(id); if (!x) throw new HttpError(404, "Claim not found."); return x; };
  function updateClaim(user, claimId, body) {
    const cl = mustClaim(claimId), c = mustCase(cl.case_id); requireEdit(user, c);
    const set = {};
    if (body.text !== undefined) { if (!String(body.text).trim()) throw new HttpError(400, "Claim text cannot be empty."); set.text = String(body.text).trim().slice(0, 2000); }
    if (body.kind !== undefined) set.kind = body.kind;
    if (body.assessment !== undefined) {
      if (!ASSESSMENTS.includes(body.assessment)) throw new HttpError(400, `Unknown verdict. Use one of: ${ACTIVE_VERDICTS.map(v => VERDICTS[v]).join(", ")}.`);
      if (LEGACY_VERDICTS.includes(body.assessment) && body.assessment !== cl.assessment) throw new HttpError(400, `“${VERDICTS[body.assessment]}” is no longer offered. Use one of: ${ACTIVE_VERDICTS.map(v => VERDICTS[v]).join(", ")}.`);
      set.assessment = body.assessment; set.assessed_by = user.id; set.assessed_at = nowISO();
    }
    if (body.rationale !== undefined) set.rationale = String(body.rationale).slice(0, 4000);
    if (!Object.keys(set).length) return;
    change(user, c.id, `Claim ${cl.seq} ${set.assessment ? `assessed as ${set.assessment}` : "edited"}`, () =>
      db.prepare(`UPDATE claims SET ${Object.keys(set).map(k => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...set, id: claimId }));
  }
  function removeClaim(user, claimId) {
    const cl = mustClaim(claimId), c = mustCase(cl.case_id); requireEdit(user, c);
    change(user, c.id, `Claim ${cl.seq} removed`, () => { db.prepare("UPDATE claims SET removed = 1 WHERE id = ?").run(claimId); });
  }
  // split one claim into several (keeps the original as removed, for the record)
  function splitClaim(user, claimId, parts) {
    const cl = mustClaim(claimId), c = mustCase(cl.case_id); requireEdit(user, c);
    let list = Array.isArray(parts) && parts.length ? parts.map(p => String(p).trim()).filter(Boolean) : splitSentences(cl.text);
    if (list.length < 2) list = cl.text.split(/\s*(?:;|,? and |,? but | na | lakini )\s*/i).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 3);
    if (list.length < 2) throw new HttpError(400, "This claim could not be split automatically. Edit it, or add the parts as separate claims.");
    if (cl.removed) throw new HttpError(409, "Removed claims cannot be split.");
    requireRoom(user, c.id, list.length - 1);
    const ids = [claimId];
    change(user, c.id, `Claim ${cl.seq} split into ${list.length} claims`, () => {
      requireRoom(user, c.id, list.length - 1);
      db.prepare("UPDATE claims SET text = ?, assessment = 'unassessed', rationale = NULL, assessed_by = NULL, assessed_at = NULL WHERE id = ?").run(list[0].slice(0, 2000), claimId);
      let seq = db.prepare("SELECT MAX(seq) m FROM claims WHERE case_id = ?").get(c.id).m || 0;
      for (const t of list.slice(1)) { const id = nextId(db, "claim", n => `CL-${String(n).padStart(6, "0")}`); ids.push(id); db.prepare("INSERT INTO claims(id,case_id,seq,text,origin,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, c.id, ++seq, t.slice(0, 2000), "analyst", cl.kind, user.id, nowISO()); }
    }, { original_text: cl.text, note: "Re-check evidence links after splitting; original claim identity and evidence are retained." });
    return ids;
  }

  // ---------------------------------------------------------------- evidence
  const KINDS = ["observation", "source_claim", "inference", "lead"];
  function validLinks(caseId, links) {
    if (!Array.isArray(links)) return [];
    const ok = new Set(db.prepare("SELECT id FROM claims WHERE case_id = ? AND removed = 0").all(caseId).map(x => x.id));
    return links.filter(l => l && ok.has(l.claim_id) && ["supports", "contradicts", "context"].includes(l.stance));
  }
  function addEvidence(user, caseId, b) {
    const c = mustCase(caseId); requireEdit(user, c);
    if (!KINDS.includes(b.kind)) throw new HttpError(400, "Choose what kind of evidence this is: observation, source claim, inference or lead.");
    if (!String(b.text || "").trim() || !String(b.reference || "").trim()) throw new HttpError(400, "Evidence needs both a finding and a reference.");
    const sourceDate = checkSourceDate(b.source_date);
    if (b.media_id && !db.prepare("SELECT 1 FROM media WHERE id = ? AND case_id = ?").get(b.media_id, caseId)) throw new HttpError(400, "That media item is not part of this case.");
    const loc = checkLocation(caseId, b.media_id || null, b);
    const id = nextId(db, "evidence", n => `E-${String(n).padStart(6, "0")}`);
    change(user, caseId, `Evidence ${id} added (${b.kind})`, () => {
      db.prepare("INSERT INTO evidence(id,case_id,kind,origin,status,text,reference,uncertainty,media_id,source_date,created_by,created_at,decided_by,decided_at) VALUES (?,?,?,'analyst','accepted',?,?,?,?,?,?,?,?,?)")
        .run(id, caseId, b.kind, String(b.text).trim().slice(0, 4000), String(b.reference).trim().slice(0, 1000), b.uncertainty || null, b.media_id || null, sourceDate, user.id, nowISO(), user.id, nowISO());
      for (const l of validLinks(caseId, b.links)) db.prepare("INSERT INTO evidence_links(evidence_id,claim_id,stance) VALUES (?,?,?)").run(id, l.claim_id, l.stance);
      if (Object.keys(loc).length) db.prepare(`UPDATE evidence SET ${Object.keys(loc).map(k => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...loc, id });
    });
    return id;
  }
  // where in a recording or document a piece of evidence is: a page of a document, or a time range of audio or video
  function checkLocation(caseId, mediaId, b) {
    const out = {}, has = k => b[k] !== undefined;
    if (!has("loc_page") && !has("loc_start_s") && !has("loc_end_s") && !has("transcript_id")) return out;
    const m = mediaId ? db.prepare("SELECT m.*, d.pages FROM media m LEFT JOIN document_texts d ON d.media_id = m.id WHERE m.id = ? AND m.case_id = ?").get(mediaId, caseId) : null;
    const num = (v, what) => { if (v === null || v === "") return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${what} must be a number of 0 or more.`); return n; };
    if (has("loc_page")) {
      const p = num(b.loc_page, "The page");
      if (p !== null) {
        if (!m || m.kind !== "document") throw new HttpError(400, "A page can only be recorded for a document in this case.");
        if (!Number.isInteger(p) || p < 1) throw new HttpError(400, "The page must be a whole number from 1.");
        if (m.pages && p > m.pages) throw new HttpError(400, `This document has ${m.pages} page(s).`);
      }
      out.loc_page = p;
    }
    if (has("loc_start_s") || has("loc_end_s")) {
      const st = has("loc_start_s") ? num(b.loc_start_s, "The start time") : null, en = has("loc_end_s") ? num(b.loc_end_s, "The end time") : null;
      if ((st !== null || en !== null) && (!m || !["audio", "video"].includes(m.kind))) throw new HttpError(400, "A time can only be recorded for audio or video in this case.");
      if (en !== null && st === null) throw new HttpError(400, "Give the start time as well as the end time.");
      if (en !== null && en < st) throw new HttpError(400, "The end time cannot be before the start time.");
      out.loc_start_s = st; out.loc_end_s = en;
    }
    if (has("transcript_id")) {
      if (b.transcript_id && !db.prepare("SELECT 1 FROM transcripts WHERE id = ? AND media_id = ? AND case_id = ?").get(b.transcript_id, mediaId, caseId)) throw new HttpError(400, "That transcript does not belong to this recording.");
      out.transcript_id = b.transcript_id || null;
    }
    return out;
  }
  // a source's own date: YYYY, YYYY-MM or YYYY-MM-DD, not in the future. Empty clears it.
  function checkSourceDate(v) {
    if (v == null || String(v).trim() === "") return null;
    const d = String(v).trim();
    if (!/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(d) || (d.length === 10 && isNaN(new Date(d + "T00:00:00Z"))))
      throw new HttpError(400, "Source date must be a year (2018), a month (2018-10) or a full date (2018-10-14).");
    if (d > new Date().toISOString().slice(0, d.length)) throw new HttpError(400, "Source date cannot be in the future.");
    return d;
  }
  function updateEvidence(user, evId, b) {
    const e = db.prepare("SELECT * FROM evidence WHERE id = ?").get(evId); if (!e) throw new HttpError(404, "Evidence not found.");
    const c = mustCase(e.case_id); requireEdit(user, c);
    const set = {};
    if (b.status !== undefined) {
      if (!["accepted", "dismissed", "suggested"].includes(b.status)) throw new HttpError(400, "Unknown status.");
      set.status = b.status; set.decided_by = user.id; set.decided_at = nowISO();
    }
    if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) throw new HttpError(400, "Unknown evidence kind."); set.kind = b.kind; }
    if (b.text !== undefined && e.origin === "analyst") set.text = String(b.text).slice(0, 4000);
    if ((b.text !== undefined || b.reference !== undefined) && e.origin !== "analyst") throw new HttpError(400, "Automated and AI suggestions keep their original wording. Dismiss it and add your own evidence instead.");
    if (b.text !== undefined && !String(b.text).trim()) throw new HttpError(400, "The finding cannot be empty.");
    if (b.reference !== undefined && e.origin === "analyst") { if (!String(b.reference).trim()) throw new HttpError(400, "A reference is required."); set.reference = String(b.reference).slice(0, 1000); }
    if (b.source_date !== undefined) set.source_date = checkSourceDate(b.source_date);
    const loc = checkLocation(c.id, e.media_id, { ...b, transcript_id: undefined }), locChanged = Object.keys(loc).filter(k => (loc[k] ?? null) !== (e[k] ?? null));
    for (const k of locChanged) set[k] = loc[k];
    const corrected = ["text", "reference", "source_date"].filter(k => k in set && (set[k] ?? null) !== (e[k] ?? null));
    for (const k of ["text", "reference", "source_date"]) if (k in set && !corrected.includes(k)) delete set[k];
    const what = set.status === "accepted" ? "accepted" : set.status === "dismissed" ? "dismissed" : set.status === "suggested" ? "withdrawn to suggestions" : corrected.length ? `corrected (${corrected.join(", ")})` : locChanged.length ? "location recorded" : "edited";
    change(user, c.id, `Evidence ${evId} ${what}`, () => {
      if (corrected.length) db.prepare("INSERT INTO evidence_versions(evidence_id,text,reference,source_date,replaced_by,replaced_at) VALUES (?,?,?,?,?,?)").run(evId, e.text, e.reference, e.source_date ?? null, user.id, nowISO());
      if (Object.keys(set).length) db.prepare(`UPDATE evidence SET ${Object.keys(set).map(k => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...set, id: evId });
      if (b.links !== undefined) {
        db.prepare("DELETE FROM evidence_links WHERE evidence_id = ?").run(evId);
        for (const l of validLinks(c.id, b.links)) db.prepare("INSERT INTO evidence_links(evidence_id,claim_id,stance) VALUES (?,?,?)").run(evId, l.claim_id, l.stance);
      }
      if (set.status === "dismissed" || set.status === "suggested") db.prepare("DELETE FROM evidence_links WHERE evidence_id = ?").run(evId);
    }, locChanged.length ? { location_before: Object.fromEntries(locChanged.map(k => [k, e[k] ?? null])), location_after: Object.fromEntries(locChanged.map(k => [k, set[k] ?? null])) } : undefined);
  }

  // ---------------------------------------------------------------- account location (as the platform states it)
  // Recorded only by an analyst, from a screenshot of the platform's transparency panel or the account's profile.
  // Candidates are read from OCR text of the case's own images; nothing is fetched, scraped or inferred.
  function accountLocationCandidates(caseId) {
    mustCase(caseId);
    const rows = db.prepare("SELECT o.id, o.media_id, o.current_text FROM ocr_texts o JOIN media m ON m.id = o.media_id WHERE o.case_id = ? ORDER BY o.id").all(caseId);
    const out = []; for (const o of rows) for (const d of detectAccountLocation(o.current_text)) out.push({ ...d, media_id: o.media_id, ocr_id: o.id, source_label: LOCATION_SOURCES[d.source] });
    const unread = db.prepare("SELECT id, original_name FROM media WHERE case_id = ? AND kind = 'image' AND parent_media_id IS NULL AND id NOT IN (SELECT media_id FROM ocr_texts WHERE case_id = ?)").all(caseId, caseId);
    return { candidates: out, images_without_text: unread };
  }
  function setAccountLocation(user, caseId, b = {}) {
    const c = mustCase(caseId); requireEdit(user, c);
    if (b.clear) {
      if (!c.account_location) return;
      return change(user, caseId, "Account location removed", () => db.prepare("UPDATE cases SET account_location = NULL, account_location_source = NULL, account_location_basis = NULL, account_location_media_id = NULL, account_location_by = ?, account_location_at = ? WHERE id = ?").run(user.id, nowISO(), caseId),
        { before: { location: c.account_location, source: c.account_location_source } });
    }
    const loc = String(b.location || "").replace(/\s+/g, " ").trim();
    if (loc.length < 2 || loc.length > 120) throw new HttpError(400, "Write the location as the platform states it (2 to 120 characters).");
    if (!LOCATION_SOURCES[b.source]) throw new HttpError(400, `Say where it comes from: ${Object.keys(LOCATION_SOURCES).join(", ")}.`);
    const basis = String(b.basis || "").trim().slice(0, 1000) || null;
    if (b.media_id && !db.prepare("SELECT 1 FROM media WHERE id = ? AND case_id = ? AND kind = 'image'").get(b.media_id, caseId)) throw new HttpError(400, "That screenshot is not an image in this case.");
    if (!b.media_id && !basis) throw new HttpError(400, "Without a screenshot, describe where the location comes from (for example the page and the date you looked).");
    change(user, caseId, `Account location recorded: ${loc} (${b.source.replace(/_/g, " ")})`, () => db.prepare("UPDATE cases SET account_location = ?, account_location_source = ?, account_location_basis = ?, account_location_media_id = ?, account_location_by = ?, account_location_at = ? WHERE id = ?")
      .run(loc, b.source, basis, b.media_id || null, user.id, nowISO(), caseId), { before: c.account_location ? { location: c.account_location, source: c.account_location_source } : null, after: { location: loc, source: b.source, media: b.media_id || null } });
  }

  // ---------------------------------------------------------------- checklist & OCR
  function setChecklist(user, caseId, step, b) {
    const c = mustCase(caseId); requireEdit(user, c);
    const row = db.prepare("SELECT * FROM checklist WHERE case_id = ? AND step = ?").get(caseId, step);
    if (!row && !b.label) throw new HttpError(404, "Checklist step not found.");
    if (b.state && !["todo", "done", "na"].includes(b.state)) throw new HttpError(400, "Unknown state.");
    change(user, caseId, row ? `Checklist: “${row.label}” → ${b.state || row.state}` : `Checklist step added: ${b.label}`, () => {
      if (row) db.prepare("UPDATE checklist SET state = COALESCE(?, state), note = COALESCE(?, note), updated_by = ?, updated_at = ? WHERE case_id = ? AND step = ?").run(b.state || null, b.note ?? null, user.id, nowISO(), caseId, step);
      else db.prepare("INSERT INTO checklist(case_id,step,label,state,note,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)").run(caseId, step, String(b.label).slice(0, 300), b.state || "todo", b.note || null, user.id, nowISO());
    });
  }
  function addOcr(user, mediaId, b) {
    const m = db.prepare("SELECT * FROM media WHERE id = ?").get(mediaId); if (!m || !m.case_id) throw new HttpError(404, "Media not found.");
    const c = mustCase(m.case_id); requireEdit(user, c);
    if (typeof b.text !== "string") throw new HttpError(400, "OCR text is required.");
    if (!/^[a-z+]{3,15}$/.test(b.lang || "")) throw new HttpError(400, "Unknown OCR language.");
    let id;
    change(user, c.id, `Text extracted from ${mediaId} (${b.lang})`, () => {
      id = db.prepare("INSERT INTO ocr_texts(media_id,case_id,engine,lang,confidence,original_text,current_text,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(mediaId, c.id, String(b.engine || "manual").slice(0, 60), b.lang, b.confidence ?? null, b.text.slice(0, 50000), b.text.slice(0, 50000), user.id, nowISO()).lastInsertRowid;
    });
    return id;
  }
  function editOcr(user, ocrId, text) {
    const o = db.prepare("SELECT * FROM ocr_texts WHERE id = ?").get(ocrId); if (!o) throw new HttpError(404, "OCR record not found.");
    const c = mustCase(o.case_id); requireEdit(user, c);
    if (text === o.current_text) return;
    change(user, c.id, `OCR text ${ocrId} corrected`, () => {
      db.prepare("INSERT INTO ocr_versions(ocr_id,text,edited_by,edited_at) VALUES (?,?,?,?)").run(ocrId, o.current_text, user.id, nowISO());
      db.prepare("UPDATE ocr_texts SET current_text = ? WHERE id = ?").run(String(text).slice(0, 50000), ocrId);
    });
  }

  // ---------------------------------------------------------------- review workflow
  function readiness(caseId) {
    const c = getCase(caseId), claims = db.prepare("SELECT * FROM claims WHERE case_id = ? AND removed = 0").all(caseId);
    const ev = db.prepare("SELECT * FROM evidence WHERE case_id = ?").all(caseId);
    const links = db.prepare("SELECT l.* FROM evidence_links l JOIN evidence e ON e.id = l.evidence_id WHERE e.case_id = ? AND e.status = 'accepted'").all(caseId);
    // items carry a code and parameters so other views (evidence coverage, Kiswahili labels) show the same rules
    const items = [], add = (code, text, extra = {}) => items.push({ code, text, scope: extra.claim_id ? "claim" : "case", ...extra });
    if (claims.length > MAX_CASE_CLAIMS) add("claim_limit", "Choose at most two claims for this older case before approval.");
    if (!claims.length) add("no_claims", "Add at least one claim.");
    for (const cl of claims) {
      if (cl.assessment === "unassessed") add("unassessed", `Claim ${cl.seq} has no assessment.`, { claim_id: cl.id, seq: cl.seq });
      else if (!String(cl.rationale || "").trim()) add("no_rationale", `Claim ${cl.seq} needs a short rationale.`, { claim_id: cl.id, seq: cl.seq });
      const need = verdictNeeds(cl.assessment, links.filter(l => l.claim_id === cl.id).map(l => l.stance));
      if (need) add("verdict_needs", `Claim ${cl.seq} ${need}.`, { claim_id: cl.id, seq: cl.seq, assessment: cl.assessment });
    }
    const pending = ev.filter(e => e.status === "suggested").length;
    if (pending) add("pending_suggestions", `${pending} suggested evidence item(s) still need to be accepted or dismissed.`, { n: pending });
    const exp = expectedConclusion(claims);
    if (!c.conclusion) add("no_conclusion", "Choose the overall conclusion.");
    else if (exp && c.conclusion !== exp) add("conclusion_mismatch", `The overall conclusion should be “${CONCLUSIONS[exp]}” given the claim assessments (it is “${CONCLUSIONS[c.conclusion]}”).`, { expected: exp, actual: c.conclusion });
    if (!String(c.conclusion_rationale || "").trim()) add("no_conclusion_reasoning", "Write the reasoning for the overall conclusion.");
    if (!String(c.uncertainties || "").trim()) add("no_uncertainties", "Record the remaining uncertainties (write “None identified” if there are none).");
    const problems = items.map(i => i.text);
    return { ok: !problems.length, problems, items, expected: exp };
  }
  function submit(user, id) {
    const c = mustCase(id); requireEdit(user, c, { states: new Set(["analyst_review", "needs_evidence"]) });
    if (c.approval_route === "hod" || db.prepare("SELECT 1 FROM investigations i JOIN report_approvals a ON a.kind = 'investigation' AND a.ref_id = i.id WHERE i.case_id = ?").get(id))
      throw new HttpError(409, "This case belongs to an automatic investigation: its report goes to the Head of Department from the investigation's approval panel.");
    const r = readiness(id); if (!r.ok) throw new HttpError(422, "This case is not ready for approval.", r.problems);
    change(user, id, "Submitted for approval", () => db.prepare("UPDATE cases SET status = 'awaiting_approval', submitted_by = ?, submitted_at = ?, reviewer_comment = NULL WHERE id = ?").run(user.id, nowISO(), id));
  }
  function decide(user, id, { decision, comment }, renderReport) {
    const c = mustCase(id);
    if (!can(user, "case.approve")) throw new HttpError(403, "Only reviewers and administrators can approve or return assessments.");
    if (c.status !== "awaiting_approval") throw new HttpError(409, "This case is not awaiting approval.");
    if (c.approval_route === "hod") throw new HttpError(409, "This case is decided by the Head of Department in the report approval queue (Reports › Report approval), not by a reviewer.");
    if (isOwnWork(user, c) && !allowSelfApproval) throw new HttpError(403, "You analysed or submitted this case. A different reviewer must decide it (separation of duties).");
    if (decision === "return" || decision === "reject") {
      if (!String(comment || "").trim()) throw new HttpError(400, decision === "return" ? "Say what additional evidence or changes are needed." : "Say why the proposed conclusion is rejected.");
      const st = decision === "return" ? "needs_evidence" : "rejected";
      change(user, id, decision === "return" ? "Returned: needs additional evidence" : "Proposed conclusion rejected", () => db.prepare("UPDATE cases SET status = ?, reviewer_comment = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(st, String(comment).slice(0, 4000), user.id, nowISO(), id), { comment });
      return;
    }
    if (decision !== "approve") throw new HttpError(400, "Decision must be approve, return (needs additional evidence) or reject.");
    const r = readiness(id); if (!r.ok) throw new HttpError(422, "The case changed and is no longer ready.", r.problems);
    tx(() => {
      db.prepare("UPDATE cases SET status = 'approved', decided_by = ?, decided_at = ?, reviewer_comment = ? WHERE id = ?").run(user.id, nowISO(), comment ? String(comment).slice(0, 4000) : null, id);
      snapshot(id, user, "Approved");
      const { json, html, sha256 } = renderReport(id);
      db.prepare("INSERT INTO reports(id,case_id,revision,json_snapshot,html_snapshot,sha256,approved_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(`R-${id}-r${getCase(id).revision}`, id, getCase(id).revision, json, html, sha256, user.id, nowISO());
      audit(user, "Approved", "case", id, { conclusion: c.conclusion, reportSha256: sha256 });
    })();
  }
  function archiveCase(user, id) {
    const c = mustCase(id);
    if (!can(user, "case.archive")) throw new HttpError(403, "Only reviewers and administrators can archive cases.");
    if (!["approved", "rejected"].includes(c.status)) throw new HttpError(409, "Only approved or rejected cases can be archived.");
    change(user, id, "Case archived", () => db.prepare("UPDATE cases SET status = 'archived' WHERE id = ?").run(id));
  }
  function revise(user, id, reason) {
    const c = mustCase(id);
    if (!["approved", "archived", "rejected"].includes(c.status)) throw new HttpError(409, "Only approved, rejected or archived cases can be reopened as a new revision.");
    if (!(can(user, "case.archive") || c.assigned_to === user.id)) throw new HttpError(403, "Only the assigned analyst, reviewers or administrators can open a revision.");
    if (!String(reason || "").trim()) throw new HttpError(400, "Give a reason for the new revision.");
    change(user, id, `Revision ${c.revision + 1} opened: ${String(reason).slice(0, 200)}`, () =>
      db.prepare("UPDATE cases SET status = 'analyst_review', revision = revision + 1, submitted_by = NULL, submitted_at = NULL, decided_by = NULL, decided_at = NULL, reviewer_comment = ? WHERE id = ?").run(`Revision opened: ${reason}`, id));
  }

  // ---------------------------------------------------------------- case notes (team discussion)
  // Notes never change the case version (so a comment cannot collide with someone's edit) and never
  // appear in reports. Every edit and deletion keeps the earlier text and is written to the audit log.
  const mustNote = nid => { const n = db.prepare("SELECT * FROM case_notes WHERE id = ?").get(+nid); if (!n || n.deleted) throw new HttpError(404, "Note not found."); return n; };
  const noteBody = b => { const t = String(b ?? "").trim(); if (!t) throw new HttpError(400, "Write something before saving the note."); if (t.length > 4000) throw new HttpError(400, "Notes are limited to 4,000 characters."); return t; };
  function addNote(user, caseId, body) {
    const c = mustCase(caseId);
    if (!can(user, "note.write")) throw new HttpError(403, "Your role can read notes but not write them.");
    const t = noteBody(body);
    const id = db.prepare("INSERT INTO case_notes(case_id,revision,author_id,body,created_at) VALUES (?,?,?,?,?)").run(caseId, c.revision, user.id, t, nowISO()).lastInsertRowid;
    audit(user, "Note added", "case", caseId, { note: Number(id), chars: t.length });
    return Number(id);
  }
  function editNote(user, nid, body) {
    const n = mustNote(nid);
    if (n.author_id !== user.id) throw new HttpError(403, "Only the author can edit a note.");
    const t = noteBody(body); if (t === n.body) return;
    db.transaction(() => {
      db.prepare("INSERT INTO case_note_versions(note_id,body,replaced_by,replaced_at,reason) VALUES (?,?,?,?,?)").run(n.id, n.body, user.id, nowISO(), "edited");
      db.prepare("UPDATE case_notes SET body = ?, edited_at = ? WHERE id = ?").run(t, nowISO(), n.id);
    })();
    audit(user, "Note edited", "case", n.case_id, { note: n.id });
  }
  function deleteNote(user, nid) {
    const n = mustNote(nid);
    if (n.author_id !== user.id && user.role !== "admin") throw new HttpError(403, "Only the author or an administrator can delete a note.");
    db.transaction(() => {
      db.prepare("INSERT INTO case_note_versions(note_id,body,replaced_by,replaced_at,reason) VALUES (?,?,?,?,?)").run(n.id, n.body, user.id, nowISO(), "deleted");
      db.prepare("UPDATE case_notes SET deleted = 1, edited_at = ? WHERE id = ?").run(nowISO(), n.id);
    })();
    audit(user, "Note deleted", "case", n.case_id, { note: n.id });
  }

  return { claimCapacity, assertReportClaims, proposeClaims, selectClaims, claimsFromDocument, addNote, editNote, deleteNote, getCase, mustCase, aggregate, canEditCase, requireEdit, create, update, assign, startAnalysis, isRunning: id => running.has(id),
    addClaim, updateClaim, removeClaim, splitClaim, addEvidence, accountLocationCandidates, setAccountLocation, updateEvidence, setChecklist, addOcr, editOcr, readiness, submit, decide, archiveCase, revise, snapshot, change };
}

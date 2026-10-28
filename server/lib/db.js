import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
const MIG2 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-002.sql"), "utf8");
const MIG3 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-003.sql"), "utf8");
const MIG4 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-004.sql"), "utf8");
const MIG6 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-006.sql"), "utf8");

// Migration 5: widen CHECK constraints (new verdict categories, review outcomes, documents, retrieved evidence).
// SQLite cannot alter a CHECK in place, so each table is rebuilt from its current definition with the same
// columns and rows, then its indexes are recreated. Existing values all remain valid.
const WIDEN = {
  cases: [["'approved','archived')", "'approved','archived','needs_evidence','rejected')"], ["conclusion IN ('supported','contradicted','mixed','insufficient')", "conclusion IN ('supported','contradicted','mixed','insufficient','partially_supported','misleading_context','not_verifiable')"]],
  claims: [["assessment IN ('unassessed','supported','contradicted','insufficient')", "assessment IN ('unassessed','supported','contradicted','insufficient','partially_supported','misleading_context','not_verifiable')"]],
  media: [["kind IN ('image','video')", "kind IN ('image','video','document')"]],
  evidence: [["origin IN ('system','analyst','ai')", "origin IN ('system','analyst','ai','retrieval')"]]
};
function mig5(db) {
  for (const [t, reps] of Object.entries(WIDEN)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    let sql = row.sql; for (const [a, b] of reps) { if (!sql.includes(a)) throw new Error(`Migration 5: unexpected definition of ${t}`); sql = sql.replace(a, b); }
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t).map(r => r.sql);
    const n = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
    db.exec(sql.replace(/^CREATE TABLE\s+"?\w+"?/i, `CREATE TABLE "${t}__new"`));
    db.exec(`INSERT INTO "${t}__new" SELECT * FROM "${t}"; DROP TABLE "${t}"; ALTER TABLE "${t}__new" RENAME TO "${t}";`);
    for (const i of idx) db.exec(i);
    if (db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n !== n) throw new Error(`Migration 5: row count changed for ${t}`);
  }
}
const MIG7 = "ALTER TABLE kb_datasets ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0; ALTER TABLE kb_datasets ADD COLUMN format_detected TEXT;";
// Migration 9: audio recordings as media, and machine transcripts of audio and video (segments linked to timestamps; edits kept)
function mig9(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media'").get(), a = "kind IN ('image','video','document')";
  if (!row.sql.includes(a) && !row.sql.includes("'document','audio')")) throw new Error("Migration 9: unexpected definition of media");
  if (row.sql.includes(a)) {
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media' AND sql IS NOT NULL").all().map(r => r.sql), n = db.prepare("SELECT COUNT(*) n FROM media").get().n;
  db.exec(row.sql.replace(a, "kind IN ('image','video','document','audio')").replace(/^CREATE TABLE\s+"?\w+"?/i, 'CREATE TABLE "media__new"'));
  db.exec('INSERT INTO "media__new" SELECT * FROM "media"; DROP TABLE "media"; ALTER TABLE "media__new" RENAME TO "media";');
  for (const i of idx) db.exec(i);
  if (db.prepare("SELECT COUNT(*) n FROM media").get().n !== n) throw new Error("Migration 9: row count changed for media");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id), case_id TEXT NOT NULL REFERENCES cases(id),
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')), progress REAL NOT NULL DEFAULT 0,
    language_requested TEXT NOT NULL, language TEXT, language_probability REAL, language_basis TEXT,
    engine TEXT, model TEXT, duration_s REAL, speech_found INTEGER, dropped_non_speech INTEGER, processing_s REAL, remote_job_id TEXT, error TEXT,
    media_sha256 TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, finished_at TEXT);
  CREATE INDEX IF NOT EXISTS transcripts_media ON transcripts(media_id);
  CREATE TABLE IF NOT EXISTS transcript_segments (
    id INTEGER PRIMARY KEY, transcript_id TEXT NOT NULL REFERENCES transcripts(id), seq INTEGER NOT NULL, start_s REAL NOT NULL, end_s REAL NOT NULL,
    text_machine TEXT NOT NULL, text_current TEXT NOT NULL, confidence REAL, no_speech_prob REAL, unclear INTEGER NOT NULL DEFAULT 0, reasons TEXT,
    edited_by INTEGER REFERENCES users(id), edited_at TEXT, UNIQUE (transcript_id, seq));
  CREATE TABLE IF NOT EXISTS transcript_edits (id INTEGER PRIMARY KEY, segment_id INTEGER NOT NULL REFERENCES transcript_segments(id), old_text TEXT NOT NULL, new_text TEXT NOT NULL, edited_by INTEGER REFERENCES users(id), edited_at TEXT NOT NULL);`);
}
const MIG8 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-008.sql"), "utf8");
// Migration 10 (1.14): evidence coverage. Exact locations for evidence (document page, audio/video time range,
// transcript), and analyst-recorded missing information, open questions and next steps per claim, with history.
// Only adds columns and tables; existing transcript evidence gets its time range from the transcript it cites.
function mig10(db) {
  const cols = db.prepare("PRAGMA table_info(evidence)").all().map(c => c.name);
  for (const [c, t] of [["loc_page", "INTEGER"], ["loc_start_s", "REAL"], ["loc_end_s", "REAL"], ["transcript_id", "TEXT"]]) if (!cols.includes(c)) db.exec(`ALTER TABLE evidence ADD COLUMN ${c} ${t}`);
  db.exec(`CREATE TABLE IF NOT EXISTS case_gaps (
    id INTEGER PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), claim_id TEXT REFERENCES claims(id),
    kind TEXT NOT NULL CHECK (kind IN ('missing','question','next_step')), text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dropped')), resolution TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('analyst','rules','ai')), sources TEXT, rule_code TEXT, ai_model TEXT,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT);
  CREATE INDEX IF NOT EXISTS case_gaps_case ON case_gaps(case_id);
  CREATE TABLE IF NOT EXISTS case_gap_versions (id INTEGER PRIMARY KEY, gap_id INTEGER NOT NULL REFERENCES case_gaps(id), kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, resolution TEXT, changed_by INTEGER REFERENCES users(id), changed_at TEXT NOT NULL);`);
  const hasT = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_segments'").get();
  if (!hasT) return;
  for (const e of db.prepare("SELECT id, reference FROM evidence WHERE reference LIKE 'Machine transcript T-%' AND loc_start_s IS NULL").all()) {
    const m = /^Machine transcript (T-\d+), segments? ([\d, ]+)/.exec(e.reference); if (!m) continue;
    const seqs = m[2].split(/[ ,]+/).filter(Boolean).map(Number), q = db.prepare(`SELECT MIN(start_s) a, MAX(end_s) b FROM transcript_segments WHERE transcript_id = ? AND seq IN (${seqs.map(() => "?").join(",")})`).get(m[1], ...seqs);
    if (q?.a != null) db.prepare("UPDATE evidence SET transcript_id = ?, loc_start_s = ?, loc_end_s = ? WHERE id = ?").run(m[1], q.a, q.b, e.id);
  }
}
// Migration 11 (1.15): where the posting account is based, as the platform states it (read from an analyst's screenshot)
function mig11(db) {   // only adds columns; safe to run again
  const cols = db.prepare("PRAGMA table_info(cases)").all().map(c => c.name);
  for (const [c, t] of [["account_location", "TEXT"], ["account_location_source", "TEXT"], ["account_location_basis", "TEXT"], ["account_location_media_id", "TEXT"], ["account_location_by", "INTEGER"], ["account_location_at", "TEXT"]])
    if (!cols.includes(c)) db.exec(`ALTER TABLE cases ADD COLUMN ${c} ${t}`);
}
// Migration 12 (1.16): KDF Mention Watch. Saved watchlists, collection state per source (cursor, backoff, last
// error) kept so collection resumes after a restart, collected public posts (one row per platform post), the
// public counts observed at each collection, which watchlist each post matched and why, and the analyst alert
// queue with its action history. Only adds tables.
function mig12(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS watchlists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, definition_json TEXT NOT NULL, definition_sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')), authorisation TEXT,
    previewed_sha256 TEXT, previewed_at TEXT, previewed_by INTEGER REFERENCES users(id), preview_json TEXT,
    activated_by INTEGER REFERENCES users(id), activated_at TEXT,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT);
  CREATE TABLE IF NOT EXISTS watchlist_versions (id INTEGER PRIMARY KEY, watchlist_id INTEGER NOT NULL REFERENCES watchlists(id), definition_json TEXT NOT NULL, definition_sha256 TEXT NOT NULL, status TEXT NOT NULL, changed_by INTEGER REFERENCES users(id), changed_at TEXT NOT NULL, note TEXT);
  CREATE TABLE IF NOT EXISTS watch_source_state (
    watchlist_id INTEGER NOT NULL REFERENCES watchlists(id), source TEXT NOT NULL, cursor TEXT, cursor_time TEXT,
    status TEXT NOT NULL DEFAULT 'idle', last_run_at TEXT, last_ok_at TEXT, next_run_at TEXT, backoff_until TEXT, failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, last_found INTEGER, last_new INTEGER, PRIMARY KEY (watchlist_id, source));
  CREATE TABLE IF NOT EXISTS watch_runs (
    id INTEGER PRIMARY KEY, watchlist_id INTEGER REFERENCES watchlists(id), source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'scheduled',
    started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed','skipped','interrupted')),
    window_from TEXT, window_to TEXT, requests INTEGER NOT NULL DEFAULT 0, fetched INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, new_posts INTEGER NOT NULL DEFAULT 0,
    not_confirmed INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, note TEXT, error TEXT);
  CREATE INDEX IF NOT EXISTS watch_runs_wl ON watch_runs(watchlist_id, started_at);
  CREATE TABLE IF NOT EXISTS watch_service (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS watch_posts (
    id INTEGER PRIMARY KEY, platform TEXT NOT NULL, post_id TEXT NOT NULL, url TEXT, account TEXT, author_name TEXT, text TEXT NOT NULL, language TEXT,
    posted_at TEXT, first_detected_at TEXT NOT NULL, first_source TEXT NOT NULL, collected_via TEXT NOT NULL, repost_of TEXT, quote_of TEXT, text_hash TEXT NOT NULL,
    likes INTEGER, comments INTEGER, shares INTEGER, views INTEGER, metrics_at TEXT, metrics_source TEXT, UNIQUE (platform, post_id));
  CREATE INDEX IF NOT EXISTS watch_posts_hash ON watch_posts(text_hash);
  CREATE INDEX IF NOT EXISTS watch_posts_time ON watch_posts(posted_at);
  CREATE TABLE IF NOT EXISTS watch_metrics (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES watch_posts(id), observed_at TEXT NOT NULL, source TEXT NOT NULL, likes INTEGER, comments INTEGER, shares INTEGER, views INTEGER);
  CREATE INDEX IF NOT EXISTS watch_metrics_post ON watch_metrics(post_id, observed_at);
  CREATE TABLE IF NOT EXISTS watch_matches (
    id INTEGER PRIMARY KEY, watchlist_id INTEGER NOT NULL REFERENCES watchlists(id), post_id INTEGER NOT NULL REFERENCES watch_posts(id),
    detected_at TEXT NOT NULL, source TEXT NOT NULL, terms_json TEXT NOT NULL, context_json TEXT, definition_sha256 TEXT NOT NULL, cluster TEXT, is_repost INTEGER NOT NULL DEFAULT 0, UNIQUE (watchlist_id, post_id));
  CREATE INDEX IF NOT EXISTS watch_matches_cluster ON watch_matches(watchlist_id, cluster);
  CREATE INDEX IF NOT EXISTS watch_matches_wl ON watch_matches(watchlist_id, detected_at);
  CREATE TABLE IF NOT EXISTS watch_alerts (
    id INTEGER PRIMARY KEY, watchlist_id INTEGER NOT NULL REFERENCES watchlists(id), kind TEXT NOT NULL CHECK (kind IN ('match','volume','repeated','engagement')),
    dedupe_key TEXT NOT NULL UNIQUE, post_id INTEGER REFERENCES watch_posts(id), title TEXT NOT NULL, reason TEXT NOT NULL, detail_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','acknowledged','dismissed','converted')), assigned_to INTEGER REFERENCES users(id),
    case_id TEXT REFERENCES cases(id), note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id));
  CREATE INDEX IF NOT EXISTS watch_alerts_status ON watch_alerts(status, created_at);
  CREATE TABLE IF NOT EXISTS watch_alert_events (id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL REFERENCES watch_alerts(id), action TEXT NOT NULL, note TEXT, by_user INTEGER REFERENCES users(id), at TEXT NOT NULL);`);
}
// Migration 13 (1.21): AI Watchlist on imported datasets. New alert categories (keyword threshold, emerging
// narrative, coordination indicator) and a severity per alert; watchlists can be deleted (kept, hidden, with their
// alert history); collected posts remember their dataset row and get a sentiment label; a scan record per watchlist
// and dataset makes re-checking resume where it stopped, so no post is processed twice. Existing rows are kept.
function mig13(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'watch_alerts'").get(), a = "kind IN ('match','volume','repeated','engagement')";
  if (row.sql.includes(a)) {
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'watch_alerts' AND sql IS NOT NULL").all().map(r => r.sql), n = db.prepare("SELECT COUNT(*) n FROM watch_alerts").get().n;
    db.exec(row.sql.replace(a, "kind IN ('match','volume','repeated','engagement','threshold','narrative','coordination')").replace(/^CREATE TABLE\s+"?\w+"?/i, 'CREATE TABLE "watch_alerts__new"'));
    db.exec('INSERT INTO "watch_alerts__new" SELECT * FROM "watch_alerts"; DROP TABLE "watch_alerts"; ALTER TABLE "watch_alerts__new" RENAME TO "watch_alerts";');
    for (const i of idx) db.exec(i);
    if (db.prepare("SELECT COUNT(*) n FROM watch_alerts").get().n !== n) throw new Error("Migration 13: row count changed for watch_alerts");
  }
  const add = (t, defs) => { const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); for (const [c, d] of defs) if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  add("watch_alerts", [["severity", "TEXT"]]);
  add("watchlists", [["deleted_at", "TEXT"], ["deleted_by", "INTEGER"]]);
  add("watch_posts", [["dataset_id", "INTEGER"], ["io_post_id", "INTEGER"], ["sentiment", "TEXT"], ["sentiment_confidence", "REAL"], ["sentiment_method", "TEXT"]]);
  db.exec(`CREATE TABLE IF NOT EXISTS watch_dataset_scans (
    watchlist_id INTEGER NOT NULL REFERENCES watchlists(id), dataset_id INTEGER NOT NULL, last_io_post_id INTEGER NOT NULL DEFAULT 0, definition_sha256 TEXT,
    posts_checked INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, scanned_at TEXT, status TEXT, error TEXT, PRIMARY KEY (watchlist_id, dataset_id));
  CREATE INDEX IF NOT EXISTS watch_posts_ds ON watch_posts(dataset_id, io_post_id);`);
}
// 1.22: automatic investigations (one-click pipeline). The automated assessment and report are kept here, apart from
// the analyst's own verdicts and the approved reports, so automation never stands in for a person's decision.
function mig14(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS investigations (
    id TEXT PRIMARY KEY, report_id TEXT NOT NULL UNIQUE, case_id TEXT REFERENCES cases(id), is_training INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, stage TEXT, stages_json TEXT NOT NULL, input_json TEXT NOT NULL, subject TEXT, overall TEXT, source_published_at TEXT,
    result_json TEXT, error TEXT, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, completed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_note TEXT);
  CREATE INDEX IF NOT EXISTS investigations_created ON investigations(created_at);
  CREATE INDEX IF NOT EXISTS investigations_case ON investigations(case_id);`);
}
// 1.24: what was extracted from a link (shown while the investigation runs)
function mig15(db) { const cols = db.prepare("PRAGMA table_info(investigations)").all().map(c => c.name); if (!cols.includes("preview_json")) db.exec("ALTER TABLE investigations ADD COLUMN preview_json TEXT"); }
// Migration 16 (1.26): live monitoring of authorised social media sources (Facebook Pages through the Meta Graph API;
// Instagram prepared). Collected posts (one record per platform post ID), stored images, engagement snapshots, every
// synchronisation, API errors, local analysis, the verification outcome, live alerts with their history, and the
// approval of automatic reports. Nothing existing is changed.
function mig16(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS social_sources (
    id INTEGER PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT, url TEXT, is_training INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'settings', added_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle', last_sync_at TEXT, last_ok_at TEXT, next_sync_at TEXT, backoff_until TEXT, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    checkpoint_time TEXT, fields_level TEXT, last_engagement_at TEXT, UNIQUE(platform, external_id, is_training));
  CREATE TABLE IF NOT EXISTS social_posts (
    id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES social_sources(id), platform TEXT NOT NULL, post_id TEXT NOT NULL, is_training INTEGER NOT NULL DEFAULT 0,
    message TEXT, created_time TEXT, updated_time TEXT, permalink_url TEXT, image_url TEXT, image_sha256 TEXT, image_mime TEXT, image_note TEXT, attachments_json TEXT,
    likes INTEGER, comments INTEGER, shares INTEGER, engagement_note TEXT, text_hash TEXT, collected_at TEXT NOT NULL, updated_at TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0,
    analysis_status TEXT NOT NULL DEFAULT 'pending' CHECK (analysis_status IN ('pending','analysing','verifying','done','skipped','failed')), analysis_attempts INTEGER NOT NULL DEFAULT 0,
    analysis_error TEXT, analysis_json TEXT, analysed_at TEXT, investigation_id TEXT REFERENCES investigations(id), same_as_post INTEGER REFERENCES social_posts(id),
    verification TEXT, confidence INTEGER, confidence_json TEXT, needs_review INTEGER NOT NULL DEFAULT 0, review_reasons_json TEXT, topics_json TEXT,
    UNIQUE(platform, post_id, is_training));
  CREATE INDEX IF NOT EXISTS social_posts_created ON social_posts(created_time);
  CREATE INDEX IF NOT EXISTS social_posts_status ON social_posts(analysis_status);
  CREATE INDEX IF NOT EXISTS social_posts_source ON social_posts(source_id, created_time);
  CREATE TABLE IF NOT EXISTS social_post_metrics (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES social_posts(id), at TEXT NOT NULL, likes INTEGER, comments INTEGER, shares INTEGER);
  CREATE TABLE IF NOT EXISTS social_syncs (
    id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES social_sources(id), kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running', requests INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, fetched INTEGER NOT NULL DEFAULT 0, new_posts INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0, updated_posts INTEGER NOT NULL DEFAULT 0, since TEXT, error_kind TEXT, error TEXT, note TEXT, usage_json TEXT);
  CREATE INDEX IF NOT EXISTS social_syncs_source ON social_syncs(source_id, id);
  CREATE TABLE IF NOT EXISTS social_api_errors (id INTEGER PRIMARY KEY, at TEXT NOT NULL, platform TEXT NOT NULL, source_id INTEGER REFERENCES social_sources(id), kind TEXT NOT NULL, code INTEGER, subcode INTEGER, message TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS social_service (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS live_alerts (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, group_key TEXT, is_training INTEGER NOT NULL DEFAULT 0, source_id INTEGER REFERENCES social_sources(id),
    post_id INTEGER REFERENCES social_posts(id), priority TEXT NOT NULL CHECK (priority IN ('low','medium','high')), title TEXT NOT NULL, reason TEXT NOT NULL, priority_reasons_json TEXT NOT NULL,
    detail_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','acknowledged','dismissed','escalated')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id), note TEXT);
  CREATE INDEX IF NOT EXISTS live_alerts_status ON live_alerts(status, created_at);
  CREATE TABLE IF NOT EXISTS live_alert_events (id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL REFERENCES live_alerts(id), action TEXT NOT NULL, note TEXT, by_user INTEGER REFERENCES users(id), at TEXT NOT NULL);`);
  const cols = db.prepare("PRAGMA table_info(investigations)").all().map(c => c.name);
  if (!cols.includes("approved_by")) db.exec("ALTER TABLE investigations ADD COLUMN approved_by INTEGER REFERENCES users(id); ALTER TABLE investigations ADD COLUMN approved_at TEXT; ALTER TABLE investigations ADD COLUMN approval_note TEXT; ALTER TABLE investigations ADD COLUMN origin TEXT");
}
// Migration 17 (1.27): keyword-based public information monitoring. Images of discovered items, the analysis of each
// discovered item, and the monitoring reports (Background, Analysis, Assessment, Recommendations). Additive only.
function mig17(db) {
  const cols = db.prepare("PRAGMA table_info(watch_posts)").all().map(c => c.name);
  if (!cols.includes("image_url")) db.exec("ALTER TABLE watch_posts ADD COLUMN image_url TEXT; ALTER TABLE watch_posts ADD COLUMN image_sha256 TEXT; ALTER TABLE watch_posts ADD COLUMN image_mime TEXT; ALTER TABLE watch_posts ADD COLUMN investigation_id TEXT REFERENCES investigations(id); ALTER TABLE watch_posts ADD COLUMN url_key TEXT");
  db.exec(`
  CREATE TABLE IF NOT EXISTS watch_post_analysis (post_id INTEGER PRIMARY KEY REFERENCES watch_posts(id), analysed_at TEXT NOT NULL, method TEXT NOT NULL, themes_json TEXT, sentiment TEXT, sentiment_json TEXT,
    claims_json TEXT, entities_json TEXT, indicators_json TEXT, figures_json TEXT, ai_json TEXT);
  CREATE INDEX IF NOT EXISTS watch_posts_urlkey ON watch_posts(url_key);
  CREATE TABLE IF NOT EXISTS monitor_searches (id INTEGER PRIMARY KEY, query TEXT NOT NULL, definition_json TEXT NOT NULL, sources_json TEXT NOT NULL, period_from TEXT, period_to TEXT, max_per_source INTEGER NOT NULL,
    is_training INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')), created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, finished_at TEXT,
    per_source_json TEXT, error TEXT, watchlist_id INTEGER REFERENCES watchlists(id), report_id INTEGER);
  CREATE TABLE IF NOT EXISTS monitor_search_results (search_id INTEGER NOT NULL REFERENCES monitor_searches(id), post_id INTEGER NOT NULL REFERENCES watch_posts(id), source TEXT NOT NULL, terms_json TEXT,
    is_new INTEGER NOT NULL, duplicate_of INTEGER REFERENCES watch_posts(id), PRIMARY KEY (search_id, post_id));
  CREATE TABLE IF NOT EXISTS monitor_reports (id INTEGER PRIMARY KEY, report_id TEXT NOT NULL UNIQUE, is_training INTEGER NOT NULL DEFAULT 0, period_from TEXT NOT NULL, period_to TEXT NOT NULL,
    created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id), origin TEXT NOT NULL, search_id INTEGER REFERENCES monitor_searches(id), watchlist_id INTEGER REFERENCES watchlists(id), situation_json TEXT NOT NULL, report_json TEXT NOT NULL, written_by TEXT NOT NULL,
    reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_note TEXT, approved_by INTEGER REFERENCES users(id), approved_at TEXT, approval_note TEXT);`);
}
// Migration 18 (1.28): how strongly each match is established (confirmed by a keyword, by a contextual keyword with its context,
// ambiguous and held for an analyst, or found only by a source's own search engine), the analyst's decision on ambiguous matches,
// and a queue for AI analysis of discovered items that waits while the organisation's Ollama server cannot be reached. Additive only.
function mig18(db) {
  const add = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add("watch_matches", "quality", "TEXT");
  add("watch_matches", "reviewed_by", "INTEGER REFERENCES users(id)");
  add("watch_matches", "reviewed_at", "TEXT");
  add("monitor_search_results", "quality", "TEXT");
  for (const [c, d] of [["ai_status", "TEXT"], ["ai_attempts", "INTEGER NOT NULL DEFAULT 0"], ["ai_next_at", "TEXT"], ["ai_error", "TEXT"], ["ai_model", "TEXT"], ["ai_at", "TEXT"], ["ai_queued_at", "TEXT"]]) add("watch_post_analysis", c, d);
  db.exec("CREATE INDEX IF NOT EXISTS watch_post_analysis_ai ON watch_post_analysis(ai_status, ai_next_at); CREATE INDEX IF NOT EXISTS watch_matches_quality ON watch_matches(watchlist_id, quality)");
}
// Migration 19 (1.29): test records never appear among operational records. Watch posts and alerts get a training flag; records
// that carry the test label ("TEST FIXTURE") or point to a test address (localhost, *.example) are moved to Training. Nothing is
// deleted.
export const TEST_TEXT_SQL = (col) => `(${col} LIKE '%TEST FIXTURE%')`;
export const TEST_URL_SQL = (col) => `(${col} LIKE 'http://127.0.0.1%' OR ${col} LIKE 'http://localhost%' OR ${col} LIKE '%.example/%' OR ${col} LIKE '%.example' OR ${col} LIKE '%.test/%' OR ${col} LIKE '%.invalid/%')`;
function mig19(db) {
  const add = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add("watch_posts", "is_training", "INTEGER NOT NULL DEFAULT 0");
  add("watch_alerts", "is_training", "INTEGER NOT NULL DEFAULT 0");
  markTestRecords(db);
  db.exec("CREATE INDEX IF NOT EXISTS watch_posts_training ON watch_posts(is_training)");
}
// moves records labelled as tests to Training (also usable later by an administrator); returns how many rows of each kind moved
export function markTestRecords(db) {
  const n = {};
  for (const [k, sql] of Object.entries({ watch_posts: `UPDATE watch_posts SET is_training = 1 WHERE is_training = 0 AND (${TEST_TEXT_SQL("text")} OR ${TEST_URL_SQL("coalesce(url,'')")})`,
    watch_alerts: `UPDATE watch_alerts SET is_training = 1 WHERE is_training = 0 AND (${TEST_TEXT_SQL("title")} OR post_id IN (SELECT id FROM watch_posts WHERE is_training = 1))`,
    live_alerts: `UPDATE live_alerts SET is_training = 1 WHERE is_training = 0 AND (${TEST_TEXT_SQL("title")} OR ${TEST_TEXT_SQL("reason")})`,
    social_posts: `UPDATE OR IGNORE social_posts SET is_training = 1 WHERE is_training = 0 AND ${TEST_TEXT_SQL("coalesce(message,'')")}`,
    monitor_reports: `UPDATE monitor_reports SET is_training = 1 WHERE is_training = 0 AND ${TEST_TEXT_SQL("situation_json")}`,
    monitor_searches: "UPDATE monitor_searches SET is_training = 1 WHERE is_training = 0 AND id IN (SELECT search_id FROM monitor_search_results x JOIN watch_posts p ON p.id = x.post_id GROUP BY search_id HAVING MIN(p.is_training) = 1)" })) n[k] = db.prepare(sql).run().changes;
  return n;
}
// Migration 20 (1.32): Head of Department approval of reports. A "hod" role (and a designation for each user), the approval record
// of each report (investigation or monitoring report), its versions and a hash-chained event log. The users table is rebuilt
// only to allow the new role; every row is kept.
function mig20(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get(), a = "role IN ('admin','reviewer','analyst','viewer')";
  if (row.sql.replace(/\s+/g, " ").includes(a)) {
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND sql IS NOT NULL").all().map(r => r.sql), n = db.prepare("SELECT COUNT(*) n FROM users").get().n;
    db.exec(row.sql.replace(/\s+/g, " ").replace(a, "role IN ('admin','reviewer','analyst','viewer','hod')").replace(/^CREATE TABLE\s+"?\w+"?/i, 'CREATE TABLE "users__new"'));
    db.exec('INSERT INTO "users__new" SELECT * FROM "users"; DROP TABLE "users"; ALTER TABLE "users__new" RENAME TO "users";');
    for (const i of idx) db.exec(i);
    if (db.prepare("SELECT COUNT(*) n FROM users").get().n !== n) throw new Error("Migration 20: row count changed for users");
  }
  if (!db.prepare("PRAGMA table_info(users)").all().some(c => c.name === "designation")) db.exec("ALTER TABLE users ADD COLUMN designation TEXT");
  db.exec(`
  CREATE TABLE IF NOT EXISTS report_approvals (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('investigation','monitor_report')), ref_id TEXT NOT NULL, report_ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','returned','rejected','approved')), version INTEGER NOT NULL DEFAULT 1, content_sha256 TEXT,
    created_by INTEGER REFERENCES users(id), submitted_by INTEGER REFERENCES users(id), submitted_at TEXT, submit_note TEXT, assigned_hod INTEGER REFERENCES users(id),
    decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT, approval_ref TEXT UNIQUE, approved_sha256 TEXT, pdf_sha256 TEXT, verify_code TEXT,
    approver_name TEXT, approver_designation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (kind, ref_id));
  CREATE TABLE IF NOT EXISTS report_versions (id INTEGER PRIMARY KEY, approval_id INTEGER NOT NULL REFERENCES report_approvals(id), version INTEGER NOT NULL, content_json TEXT NOT NULL, content_sha256 TEXT NOT NULL,
    changed_by INTEGER REFERENCES users(id), changed_at TEXT NOT NULL, reason TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS report_approval_events (id INTEGER PRIMARY KEY, approval_id INTEGER NOT NULL REFERENCES report_approvals(id), action TEXT NOT NULL, from_status TEXT, to_status TEXT, version INTEGER,
    content_sha256 TEXT, by_user INTEGER REFERENCES users(id), by_name TEXT, at TEXT NOT NULL, note TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS report_approvals_status ON report_approvals(status, assigned_hod);`);
}
// 1.33: automatic completion of investigations: which records AIVS completed itself, how each evidence item was validated,
// the approval route of a case, in-app notifications and the technical-review queue
function mig21(db) {
  const add = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add("claims", "assessed_auto", "INTEGER NOT NULL DEFAULT 0");
  add("evidence", "validation", "TEXT");
  add("cases", "approval_route", "TEXT");
  add("cases", "auto_completed_at", "TEXT");
  add("cases", "confidence", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT,
    ref TEXT, created_at TEXT NOT NULL, read_at TEXT);
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read_at);
  CREATE TABLE IF NOT EXISTS technical_reviews (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, case_id TEXT, report_ref TEXT, stage TEXT, error TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, resolved_by INTEGER REFERENCES users(id), resolved_at TEXT, resolution TEXT);
  CREATE INDEX IF NOT EXISTS technical_reviews_status ON technical_reviews(status);`);
}
// 1.34: automatic social media screenshot analysis: one record per uploaded screenshot (what was read, what was inferred,
// the populated analysis fields, the dataset record and the investigation it started)
function mig22(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS screenshot_analyses (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER, height INTEGER, bytes INTEGER NOT NULL,
    original_name TEXT, status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')), stage TEXT, stages_json TEXT NOT NULL, extraction_json TEXT, form_json TEXT, form_edits_json TEXT,
    dataset_id INTEGER REFERENCES io_datasets(id), investigation_id TEXT, duplicate_of TEXT, error TEXT, is_training INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS screenshot_analyses_sha ON screenshot_analyses(sha256);
  CREATE INDEX IF NOT EXISTS screenshot_analyses_created ON screenshot_analyses(created_at);`);
}
// 1.35: video verification: one record per analysed video (stages, container metadata, extraction, ranked matches and findings) and
// its keyframes (stored as case images) with their timestamps, perceptual hashes and colour-layout embedding
function mig23(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS video_analyses (id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id), case_id TEXT NOT NULL REFERENCES cases(id), investigation_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')), stage TEXT, stages_json TEXT NOT NULL, probe_json TEXT, extract_json TEXT, result_json TEXT, transcript_id TEXT, error TEXT,
    is_training INTEGER NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, completed_at TEXT);
  CREATE INDEX IF NOT EXISTS video_analyses_media ON video_analyses(media_id);
  CREATE INDEX IF NOT EXISTS video_analyses_case ON video_analyses(case_id);
  CREATE TABLE IF NOT EXISTS video_keyframes (id INTEGER PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES video_analyses(id), video_media_id TEXT NOT NULL REFERENCES media(id), frame_media_id TEXT NOT NULL REFERENCES media(id),
    t REAL NOT NULL, origin TEXT, dhash TEXT, phash TEXT, dhash_m TEXT, phash_m TEXT, embedding TEXT, ocr_text TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS video_keyframes_analysis ON video_keyframes(analysis_id);`);
}
function mig24(db) {
  if (!db.prepare("PRAGMA table_info(investigations)").all().some(c => c.name === "submission_key")) db.exec("ALTER TABLE investigations ADD COLUMN submission_key TEXT");
  if (!db.prepare("PRAGMA table_info(investigations)").all().some(c => c.name === "content_key")) db.exec("ALTER TABLE investigations ADD COLUMN content_key TEXT");
  db.exec(fs.readFileSync(new URL("./migration-024.sql", import.meta.url), "utf8"));
}
const MIGRATIONS = [SCHEMA, MIG2, MIG3, MIG4, { fn: mig5, noFk: true }, MIG6, MIG7, MIG8, { fn: mig9, noFk: true }, { fn: mig10 }, { fn: mig11 }, { fn: mig12 }, { fn: mig13, noFk: true }, { fn: mig14 }, { fn: mig15 }, { fn: mig16 }, { fn: mig17 }, { fn: mig18 }, { fn: mig19 }, { fn: mig20, noFk: true }, { fn: mig21 }, { fn: mig22 }, { fn: mig23 }, { fn: mig24 }]; // index i => user_version i+1. Append new migrations; never edit old ones.

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const v = db.pragma("user_version", { simple: true });
  if (v > 0 && v < MIGRATIONS.length && file !== ":memory:") {   // keep a copy of the database as it was before upgrading
    db.pragma("wal_checkpoint(TRUNCATE)");
    const copy = `${file}.before-v${MIGRATIONS.length}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.bak`;
    fs.copyFileSync(file, copy); console.log(`  Database upgrade ${v} -> ${MIGRATIONS.length}: a copy of the previous database was saved as ${path.basename(copy)}`);
    // only the two most recent upgrade copies are kept, so repeated upgrades do not fill the disk (daily backups are separate)
    try { const dir = path.dirname(file), base = path.basename(file), olds = fs.readdirSync(dir).filter(f => f.startsWith(`${base}.before-v`) && f.endsWith(".bak")).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const o of olds.slice(2)) { fs.rmSync(path.join(dir, o.f), { force: true }); console.log(`  Removed an older upgrade copy: ${o.f}`); } } catch {}
  }
  for (let i = v; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    if (m.noFk) db.pragma("foreign_keys = OFF");             // table rebuilds; re-checked below
    try {
      db.transaction(() => { if (typeof m === "string") db.exec(m); else m.fn(db); db.pragma(`user_version = ${i + 1}`); })();
      if (m.noFk) { const bad = db.pragma("foreign_key_check"); if (bad.length) throw new Error(`Migration ${i + 1}: ${bad.length} broken references`); }
    } finally { if (m.noFk) db.pragma("foreign_keys = ON"); }
  }
  return db;
}

export const nowISO = () => new Date().toISOString();

// sequential human-readable IDs (C-2026-0001, TR-0001, A-0001 …)
export function nextId(db, name, fmt) {
  const row = db.prepare("INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get(name);
  return fmt(row.value);
}

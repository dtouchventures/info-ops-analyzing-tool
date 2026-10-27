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
const MIGRATIONS = [SCHEMA, MIG2, MIG3, MIG4, { fn: mig5, noFk: true }, MIG6, MIG7, MIG8, { fn: mig9, noFk: true }, { fn: mig10 }, { fn: mig11 }, { fn: mig12 }, { fn: mig13, noFk: true }, { fn: mig14 }, { fn: mig15 }]; // index i => user_version i+1. Append new migrations; never edit old ones.

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

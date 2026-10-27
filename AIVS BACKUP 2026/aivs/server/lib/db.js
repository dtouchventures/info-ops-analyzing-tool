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
const MIGRATIONS = [SCHEMA, MIG2, MIG3, MIG4, { fn: mig5, noFk: true }, MIG6, MIG7]; // index i => user_version i+1. Append new migrations; never edit old ones.

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const v = db.pragma("user_version", { simple: true });
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

-- Migration 2 (AIVS 1.1): evidence source dates and correction history, case notes, archive import log.
ALTER TABLE evidence ADD COLUMN source_date TEXT;           -- date the source itself carries (YYYY, YYYY-MM or YYYY-MM-DD)

CREATE TABLE evidence_versions (                            -- earlier wording kept whenever evidence is corrected
  id INTEGER PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  text TEXT NOT NULL, reference TEXT NOT NULL, source_date TEXT,
  replaced_by INTEGER REFERENCES users(id), replaced_at TEXT NOT NULL
);
CREATE INDEX evidence_versions_ev ON evidence_versions(evidence_id);

CREATE TABLE case_notes (                                   -- team discussion; internal, never part of a report
  id INTEGER PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  revision INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL, edited_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX case_notes_case ON case_notes(case_id);
CREATE TABLE case_note_versions (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES case_notes(id),
  body TEXT NOT NULL, replaced_by INTEGER REFERENCES users(id), replaced_at TEXT NOT NULL, reason TEXT
);

CREATE TABLE archive_imports (
  id INTEGER PRIMARY KEY,
  file_name TEXT, bundle_sha256 TEXT NOT NULL, exported_at TEXT, exported_from TEXT,
  imported_by INTEGER REFERENCES users(id), imported_at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

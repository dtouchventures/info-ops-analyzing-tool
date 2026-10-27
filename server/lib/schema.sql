PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','reviewer','analyst','viewer')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- content-addressed private object store index
CREATE TABLE objects (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  stored_at TEXT NOT NULL
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  is_training INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  claim_text_original TEXT NOT NULL,          -- immutable: the submission exactly as received
  claim_text TEXT NOT NULL,                   -- working copy (versioned via case_versions)
  source_platform TEXT NOT NULL,
  source_url TEXT, source_account TEXT,
  published_at TEXT, published_basis TEXT,        -- when the content was published, and how we know
  claimed_event_at TEXT, claimed_event_basis TEXT, -- when the content says the event happened
  received_at TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','priority','urgent')),
  status TEXT NOT NULL CHECK (status IN ('draft','analysing','analysis_failed','analyst_review','awaiting_approval','approved','archived')),
  analysis_error TEXT, analysis_attempts INTEGER NOT NULL DEFAULT 0,
  assigned_to INTEGER REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  conclusion TEXT CHECK (conclusion IN ('supported','contradicted','mixed','insufficient')),
  conclusion_rationale TEXT, uncertainties TEXT, brief TEXT,
  submitted_by INTEGER REFERENCES users(id), submitted_at TEXT,
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, reviewer_comment TEXT
);
CREATE INDEX cases_status ON cases(is_training, status);

CREATE TABLE case_versions (
  id INTEGER PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  version INTEGER NOT NULL, revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id), changed_at TEXT NOT NULL
);
CREATE INDEX case_versions_case ON case_versions(case_id, version);

CREATE TABLE archive_records (
  id TEXT PRIMARY KEY,
  is_training INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT NOT NULL,                 -- origin / context
  documented_date TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('original','misleading')),
  source_ref TEXT NOT NULL,
  from_case_id TEXT REFERENCES cases(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE archive_history (
  id INTEGER PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES archive_records(id),
  at TEXT NOT NULL, user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL, details TEXT
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  case_id TEXT REFERENCES cases(id),
  archive_id TEXT REFERENCES archive_records(id),
  sha256 TEXT NOT NULL REFERENCES objects(sha256),
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  size INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  parent_media_id TEXT REFERENCES media(id),   -- frames point at their video
  frame_time REAL, frame_origin TEXT CHECK (frame_origin IN ('auto','analyst')),
  metadata_json TEXT,                          -- embedded metadata, an investigative lead only
  meta_capture_at TEXT,
  dhash TEXT, phash TEXT, dhash_m TEXT, phash_m TEXT,
  thumb_sha256 TEXT,                           -- 640px JPEG preview derived from the original
  is_training INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id), uploaded_at TEXT NOT NULL
);
CREATE INDEX media_case ON media(case_id);
CREATE INDEX media_sha ON media(sha256);

-- crop windows indexed for archive media
CREATE TABLE archive_windows (
  media_id TEXT NOT NULL REFERENCES media(id),
  label TEXT NOT NULL, x REAL, y REAL, w REAL, h REAL,
  dhash TEXT NOT NULL, phash TEXT NOT NULL
);
CREATE INDEX archive_windows_media ON archive_windows(media_id);

CREATE TABLE matches (
  id INTEGER PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  media_id TEXT NOT NULL REFERENCES media(id),
  target_media_id TEXT NOT NULL REFERENCES media(id),
  target_archive_id TEXT REFERENCES archive_records(id),
  target_case_id TEXT REFERENCES cases(id),
  kind TEXT NOT NULL CHECK (kind IN ('exact','perceptual')),
  level TEXT NOT NULL CHECK (level IN ('identical','strong','possible')),
  dhash_distance INTEGER, phash_distance INTEGER, score INTEGER,
  window_label TEXT, wx REAL, wy REAL, ww REAL, wh REAL, mirrored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX matches_case ON matches(case_id);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('extracted','analyst','ai')),
  kind TEXT NOT NULL DEFAULT 'statement' CHECK (kind IN ('statement','timing','media','location','attribution')),
  assessment TEXT NOT NULL DEFAULT 'unassessed' CHECK (assessment IN ('unassessed','supported','contradicted','insufficient')),
  rationale TEXT,
  assessed_by INTEGER REFERENCES users(id), assessed_at TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX claims_case ON claims(case_id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL CHECK (kind IN ('observation','source_claim','inference','lead')),
  origin TEXT NOT NULL CHECK (origin IN ('system','analyst','ai')),
  status TEXT NOT NULL CHECK (status IN ('suggested','accepted','dismissed')),
  text TEXT NOT NULL,
  reference TEXT NOT NULL,
  uncertainty TEXT,
  media_id TEXT REFERENCES media(id),
  archive_id TEXT REFERENCES archive_records(id),
  related_case_id TEXT REFERENCES cases(id),
  ai_run_id TEXT,
  sys_key TEXT,
  suggested_links TEXT,          -- JSON [{claim_id, stance}] proposed by the system/AI; applied only when accepted
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES users(id), decided_at TEXT
);
CREATE INDEX evidence_case ON evidence(case_id);
CREATE UNIQUE INDEX evidence_syskey ON evidence(case_id, sys_key) WHERE sys_key IS NOT NULL;

CREATE TABLE evidence_links (
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  claim_id TEXT NOT NULL REFERENCES claims(id),
  stance TEXT NOT NULL CHECK (stance IN ('supports','contradicts','context')),
  PRIMARY KEY (evidence_id, claim_id)
);

CREATE TABLE ocr_texts (
  id INTEGER PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(id),
  case_id TEXT REFERENCES cases(id),
  engine TEXT NOT NULL, lang TEXT NOT NULL, confidence REAL,
  original_text TEXT NOT NULL,                -- immutable extraction
  current_text TEXT NOT NULL,                 -- analyst-corrected working text
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE ocr_versions (
  id INTEGER PRIMARY KEY,
  ocr_id INTEGER NOT NULL REFERENCES ocr_texts(id),
  text TEXT NOT NULL, edited_by INTEGER REFERENCES users(id), edited_at TEXT NOT NULL
);

CREATE TABLE checklist (
  case_id TEXT NOT NULL REFERENCES cases(id),
  step TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','done','na')),
  note TEXT, updated_by INTEGER REFERENCES users(id), updated_at TEXT,
  PRIMARY KEY (case_id, step)
);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','rejected','failed')),
  requested_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
  sent_json TEXT NOT NULL,        -- what left the system (IDs, sizes, hashes), not the bytes
  response_json TEXT, validation_errors TEXT, error TEXT,
  injection_flags TEXT
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  revision INTEGER NOT NULL,
  json_snapshot TEXT NOT NULL, html_snapshot TEXT NOT NULL, sha256 TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER, username TEXT,
  action TEXT NOT NULL, entity TEXT, entity_id TEXT, details TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);

CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

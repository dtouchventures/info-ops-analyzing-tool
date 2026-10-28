-- New claims are limited across the entire lifetime of a case, including removed
-- claims. Existing over-limit records and historical reports are not rewritten.
CREATE TRIGGER IF NOT EXISTS claims_case_limit_insert BEFORE INSERT ON claims
WHEN (SELECT COUNT(*) FROM claims WHERE case_id = NEW.case_id) >= 2
BEGIN SELECT RAISE(ABORT, 'This case has reached the maximum limit of two claims.'); END;
CREATE TRIGGER IF NOT EXISTS claims_case_limit_move BEFORE UPDATE OF case_id ON claims
WHEN NEW.case_id != OLD.case_id AND (SELECT COUNT(*) FROM claims WHERE case_id = NEW.case_id) >= 2
BEGIN SELECT RAISE(ABORT, 'This case has reached the maximum limit of two claims.'); END;
CREATE TABLE IF NOT EXISTS claim_candidates (
  id INTEGER PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
  text TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL,
  source_ref TEXT, created_at TEXT NOT NULL, UNIQUE(case_id, text)
);
CREATE TABLE IF NOT EXISTS case_tasks (
  id INTEGER PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed')),
  created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS case_tasks_case ON case_tasks(case_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS case_tasks_processing ON case_tasks(case_id) WHERE status = 'processing';

CREATE UNIQUE INDEX IF NOT EXISTS investigations_submission ON investigations(submission_key) WHERE submission_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS investigations_active_content ON investigations(content_key) WHERE content_key IS NOT NULL AND status IN ('queued','running');

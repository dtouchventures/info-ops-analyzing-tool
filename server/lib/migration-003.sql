-- Migration 3 (AIVS 1.3, Phase 1): statement types, interface mode, URL sources.
ALTER TABLE claims ADD COLUMN claim_type TEXT;            -- factual | opinion | prediction | satire | question | appeal (rule-based hint)
ALTER TABLE claims ADD COLUMN claim_type_cue TEXT;        -- the words that triggered the hint
ALTER TABLE users ADD COLUMN ui_mode TEXT NOT NULL DEFAULT 'guided' CHECK (ui_mode IN ('guided','advanced'));
ALTER TABLE cases ADD COLUMN source_title TEXT;
ALTER TABLE cases ADD COLUMN source_snapshot_sha256 TEXT; -- the page as fetched, stored unchanged in the object store
ALTER TABLE cases ADD COLUMN source_snapshot_mime TEXT;
ALTER TABLE cases ADD COLUMN source_fetched_at TEXT;
ALTER TABLE cases ADD COLUMN source_final_url TEXT;
CREATE INDEX IF NOT EXISTS cases_updated ON cases(is_training, updated_at);
CREATE INDEX IF NOT EXISTS media_sha ON media(sha256);

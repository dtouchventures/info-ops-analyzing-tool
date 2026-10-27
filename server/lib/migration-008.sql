-- Migration 8 (AIVS 1.11): social media analysis. Adds columns and tables only; no existing data is changed.
-- A copy of the database is written next to it before any migration runs on an existing database.

-- per-post fields captured at import, and per-post analysis results
ALTER TABLE io_posts ADD COLUMN url TEXT;
ALTER TABLE io_posts ADD COLUMN comments INTEGER;
ALTER TABLE io_posts ADD COLUMN views INTEGER;
ALTER TABLE io_posts ADD COLUMN language TEXT;
ALTER TABLE io_posts ADD COLUMN collected_at TEXT;            -- when the record was collected (from the file, or the collection job)
ALTER TABLE io_posts ADD COLUMN collected_via TEXT;           -- provenance: file name + SHA-256, or the API and query used
ALTER TABLE io_posts ADD COLUMN loc_country TEXT;
ALTER TABLE io_posts ADD COLUMN loc_region TEXT;
ALTER TABLE io_posts ADD COLUMN loc_name TEXT;
ALTER TABLE io_posts ADD COLUMN loc_basis TEXT;               -- 'post' (location recorded with the post) | 'profile' (self-reported) | NULL
ALTER TABLE io_posts ADD COLUMN mentioned_places TEXT;        -- JSON: places named in the text (what is discussed, not where the poster is)
ALTER TABLE io_posts ADD COLUMN sentiment TEXT;               -- positive | negative | neutral | mixed
ALTER TABLE io_posts ADD COLUMN sentiment_score REAL;
ALTER TABLE io_posts ADD COLUMN sentiment_confidence REAL;
ALTER TABLE io_posts ADD COLUMN sentiment_method TEXT;        -- 'lexicon-1' or 'ollama:<model>'
ALTER TABLE io_posts ADD COLUMN themes TEXT;                  -- JSON list of theme keys
ALTER TABLE io_posts ADD COLUMN topic_no INTEGER;             -- data-driven keyword cluster (0 = not clustered)
CREATE INDEX io_posts_topic ON io_posts(dataset_id, topic_no);

ALTER TABLE io_datasets ADD COLUMN research_question TEXT;
ALTER TABLE io_datasets ADD COLUMN collection_method TEXT;    -- file | screenshots | rss | youtube | x | sample
ALTER TABLE io_datasets ADD COLUMN enriched_at TEXT;
ALTER TABLE io_datasets ADD COLUMN enrich_json TEXT;          -- parameters and summary of the content analysis

-- keyword clusters (topics) found in a dataset
CREATE TABLE io_topics (
  dataset_id INTEGER NOT NULL REFERENCES io_datasets(id), topic_no INTEGER NOT NULL, label TEXT NOT NULL, label_source TEXT NOT NULL,
  terms TEXT NOT NULL, posts INTEGER NOT NULL, summary TEXT, PRIMARY KEY (dataset_id, topic_no)
);

-- checkable claims found in a dataset's posts (identical wording grouped), with their review state
CREATE TABLE io_claims (
  id INTEGER PRIMARY KEY, dataset_id INTEGER NOT NULL REFERENCES io_datasets(id), text TEXT NOT NULL, text_hash TEXT NOT NULL,
  posts INTEGER NOT NULL, accounts INTEGER NOT NULL, first_at TEXT, last_at TEXT, post_ids TEXT NOT NULL, flags TEXT, kb_json TEXT, themes TEXT,
  status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed','needs_review','in_case','dismissed')),
  case_id TEXT REFERENCES cases(id), note TEXT, reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, extracted_by TEXT NOT NULL,
  UNIQUE (dataset_id, text_hash)
);
CREATE INDEX io_claims_ds ON io_claims(dataset_id, status);

-- imports, collections and analysis runs, with their outcome (kept after a dataset is deleted, as a log)
CREATE TABLE io_jobs (
  id INTEGER PRIMARY KEY, dataset_id INTEGER, kind TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  params_json TEXT, counts_json TEXT, progress REAL, error TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX io_jobs_ds ON io_jobs(dataset_id, id);

-- generated analysis reports (the JSON content is stored write-once by its SHA-256 so a report can be reproduced and checked)
CREATE TABLE io_reports (
  id INTEGER PRIMARY KEY, dataset_id INTEGER NOT NULL, title TEXT NOT NULL, filters_json TEXT NOT NULL, research_question TEXT,
  content_sha256 TEXT NOT NULL, input_sha256 TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);

-- Migration 6 (AIVS 1.4): verification engine, related cases, documents, usage, datasets, IO monitor, assistant.

-- suggested verdicts produced from retrieved evidence (never applied automatically)
ALTER TABLE claims ADD COLUMN suggested_assessment TEXT;
ALTER TABLE claims ADD COLUMN suggested_basis TEXT;
ALTER TABLE claims ADD COLUMN suggested_at TEXT;
-- citation details for evidence found by search connectors (or entered by an analyst)
ALTER TABLE evidence ADD COLUMN source_url TEXT;
ALTER TABLE evidence ADD COLUMN source_title TEXT;
ALTER TABLE evidence ADD COLUMN source_publisher TEXT;
ALTER TABLE evidence ADD COLUMN source_published_at TEXT;
ALTER TABLE evidence ADD COLUMN connector TEXT;
ALTER TABLE evidence ADD COLUMN rating TEXT;
ALTER TABLE evidence ADD COLUMN retrieved_at TEXT;
ALTER TABLE evidence ADD COLUMN snapshot_sha256 TEXT;
ALTER TABLE evidence ADD COLUMN claim_id TEXT;            -- the claim a retrieval was run for
ALTER TABLE cases ADD COLUMN topic TEXT;                  -- regional topic (Kenya module)

CREATE TABLE retrievals (                                 -- every evidence search, for audit and cost
  id INTEGER PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), claim_id TEXT, connector TEXT NOT NULL, query TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, results INTEGER NOT NULL DEFAULT 0, user_id INTEGER REFERENCES users(id), at TEXT NOT NULL
);
CREATE INDEX retrievals_case ON retrievals(case_id);

CREATE TABLE case_links (
  case_id TEXT NOT NULL REFERENCES cases(id), related_id TEXT NOT NULL REFERENCES cases(id), relation TEXT NOT NULL, note TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, PRIMARY KEY (case_id, related_id)
);

CREATE TABLE document_texts (                             -- text extracted from uploaded documents
  media_id TEXT PRIMARY KEY REFERENCES media(id), extractor TEXT NOT NULL, pages INTEGER, chars INTEGER NOT NULL,
  text TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, warnings TEXT, extracted_at TEXT NOT NULL
);

CREATE TABLE api_usage (                                  -- calls to paid or metered services
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, service TEXT NOT NULL, operation TEXT NOT NULL, units REAL NOT NULL DEFAULT 1, unit TEXT NOT NULL DEFAULT 'request',
  est_cost_usd REAL, status TEXT NOT NULL, case_id TEXT, user_id INTEGER
);
CREATE INDEX api_usage_at ON api_usage(at);

-- dataset registry and knowledge base
CREATE TABLE kb_datasets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, source_url TEXT, license TEXT NOT NULL, permitted_use TEXT NOT NULL,
  use_retrieval INTEGER NOT NULL DEFAULT 0, use_training INTEGER NOT NULL DEFAULT 0, collected_at TEXT, languages TEXT, limitations TEXT, reliability TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','retired')), format TEXT, records INTEGER NOT NULL DEFAULT 0,
  file_sha256 TEXT, imported_by INTEGER REFERENCES users(id), imported_at TEXT NOT NULL, approved_by INTEGER REFERENCES users(id), approved_at TEXT, notes TEXT
);
CREATE TABLE kb_records (
  id INTEGER PRIMARY KEY, dataset_id INTEGER NOT NULL REFERENCES kb_datasets(id), ext_id TEXT, claim TEXT NOT NULL, label_raw TEXT, label TEXT, language TEXT,
  source_url TEXT, publisher TEXT, published_at TEXT, claimant TEXT, split TEXT NOT NULL CHECK (split IN ('train','validation','test')),
  text_hash TEXT NOT NULL, dup_of INTEGER, review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','confirmed','corrected','removed')),
  reviewed_by INTEGER, reviewed_at TEXT, review_note TEXT
);
CREATE INDEX kb_records_ds ON kb_records(dataset_id);
CREATE INDEX kb_records_hash ON kb_records(text_hash);
CREATE VIRTUAL TABLE kb_fts USING fts5(claim, publisher, content='kb_records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TABLE kb_evaluations (
  id INTEGER PRIMARY KEY, dataset_id INTEGER, method TEXT NOT NULL, at TEXT NOT NULL, user_id INTEGER, metrics_json TEXT NOT NULL
);

-- information operations monitor
CREATE TABLE io_datasets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, source TEXT NOT NULL, authorisation TEXT NOT NULL, is_sample INTEGER NOT NULL DEFAULT 0,
  posts INTEGER NOT NULL DEFAULT 0, accounts INTEGER NOT NULL DEFAULT 0, first_at TEXT, last_at TEXT, file_sha256 TEXT,
  imported_by INTEGER REFERENCES users(id), imported_at TEXT NOT NULL, analysis_json TEXT, analysed_at TEXT
);
CREATE TABLE io_posts (
  id INTEGER PRIMARY KEY, dataset_id INTEGER NOT NULL REFERENCES io_datasets(id), platform TEXT, post_id TEXT, account TEXT NOT NULL, posted_at TEXT NOT NULL,
  text TEXT NOT NULL, hashtags TEXT, mentions TEXT, urls TEXT, reply_to TEXT, repost_of TEXT, likes INTEGER, shares INTEGER, account_created_at TEXT
);
CREATE INDEX io_posts_ds ON io_posts(dataset_id, posted_at);

-- research assistant conversation per case
CREATE TABLE assistant_messages (
  id INTEGER PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL, language TEXT, sources_json TEXT, provider TEXT, model TEXT, status TEXT NOT NULL DEFAULT 'ok', error TEXT,
  user_id INTEGER REFERENCES users(id), at TEXT NOT NULL
);
CREATE INDEX assistant_case ON assistant_messages(case_id, id);

# AIVS architecture

## Stack and why

| Layer | Choice | Reason |
|---|---|---|
| Server | Node.js 20+, Express 4 | One language end to end, so the claim rules (`shared/text.js`) run on both server and browser. Small and auditable. Runs on Windows or Linux with no build step. |
| Database | SQLite (better-sqlite3, WAL mode) | A single file with no database service to administer, which suits a pilot on one machine or an isolated network. It is transactional. The schema is plain SQL, versioned by `PRAGMA user_version`, and portable to PostgreSQL. |
| Object storage | Private, content-addressed folder `data/objects/ab/cd/<sha256>` | Originals are immutable and deduplicated, and stored outside the web root. They are served only through authenticated API routes. Maps directly to S3/MinIO keys later. |
| Images | sharp (libvips) | Server-side decoding, auto-orientation, thumbnails and perceptual hashing, so results don't depend on the analyst's browser. |
| Metadata | exifr | EXIF/XMP/GPS from JPEG, PNG, WebP, HEIC and TIFF. |
| OCR | Tesseract.js 5.1.1 with English and Kiswahili data | Served from this server; runs in the analyst's browser. No CDN, so it works air-gapped. |
| AI | Provider adapter (`server/ai/`) | Anthropic Messages API or any OpenAI-compatible endpoint. Keys stay on the server. Output is validated with ajv. |
| Front end | Vanilla ES modules, no build | Readable source with a strict CSP (`script-src 'self'`) and nothing to compile. |

## Components

```
browser (public/)                      server (server/)
  app.js router, pages/*  ──HTTPS──▶   app.js  security headers, CSRF header, sessions, routes
  lib/ocr.js (Tesseract, local)          lib/auth.js      scrypt, sessions, role permissions
  lib/video.js (frame capture)           lib/cases.js     workflow, versions, claims, evidence, readiness
  lib/forensics.js (diff, ELA)           lib/media.js     sniff → store → metadata → hashes → thumbnail
  shared/text.js ◀────── same file ──▶   lib/matching.js  exact + perceptual + cross-case matching
                                         lib/report.js    JSON + HTML report, frozen on approval
                                         lib/audit.js     hash-chained audit log
                                         ai/              schema, prompt, providers, validation
                                         data/aivs.db, data/objects/
```

## Data model (main tables)

| Table | Holds |
|---|---|
| `cases` | `claim_text_original` (immutable), working text, source, the separate dates (received, published + basis, claimed event + basis), status, assignee, revision, version, conclusion, uncertainties, review fields |
| `case_versions` | Full JSON snapshot after every change, with the reason and the user |
| `media` | Originals and frames (`parent_media_id`, `frame_time`, `frame_origin`), SHA-256, metadata, capture time, dHash/pHash (normal and mirrored), thumbnail |
| `archive_records`, `archive_history`, `archive_windows` | Reference records with provenance; every edit and withdrawal with its reason; 40 hashed crop windows per image |
| `matches` | Kind (`exact`, `perceptual`), level (`identical`, `strong`, `possible`), both distances, window and mirror |
| `claims` | Per-claim text, type, origin, assessment, rationale; split or removed claims kept |
| `evidence`, `evidence_links`, `evidence_versions` | Kind (observation / source claim / inference / lead), origin (system / analyst / AI), status, reference, source date, uncertainty; link to each claim with a stance; earlier wording of every correction |
| `case_notes`, `case_note_versions` | Team notes by signed-in authors, with the case revision; earlier text of edits and deletions (internal, excluded from reports) |
| `archive_imports` | Each imported bundle: file name, SHA-256, exporter, importer and the result summary |
| `ocr_texts`, `ocr_versions` | Original extraction (immutable), current corrected text, earlier versions |
| `ai_runs` | Provider, model, prompt version, timings, what was sent (IDs, sizes, hashes), response, validation errors, injection flags |
| `reports` | Approved JSON + HTML snapshots and their SHA-256 |
| `audit_log` | Append-only, each row hashing the previous one |

## Matching

Each submission is hashed as the whole image and as its mirror. Each archive image is hashed as the full image plus:

- 27 overlapping crops (85/70/55 %);
- 12 full-width or full-height bands (75/60 %).

A submission's score against a record is its lowest combined distance over all of these windows. Real and training scopes never mix.

Comparison is linear over the windows (40 per record), which is fine for tens of thousands of records. Beyond that, add a BK-tree or a multi-index hash table.

## Scaling path

1. **PostgreSQL.** Port `schema.sql` and replace `better-sqlite3` calls with `pg` (the queries are standard SQL). Keep the audit chain in one serialised transaction.
2. **Object storage.** Replace `storage.js` with an S3/MinIO client. Keys are already SHA-256 values.
3. **Background analysis.** Move `startAnalysis` and AI runs to a job queue such as pg-boss or BullMQ. The states `analysing` / `analysis_failed` already model it.
4. **Single sign-on.** Put an OIDC or SAML proxy in front, map groups to the four roles, and keep local accounts for break-glass access only.

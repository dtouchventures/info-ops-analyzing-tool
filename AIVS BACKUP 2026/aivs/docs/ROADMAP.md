# AIVS development roadmap

Status as of 22 October 2026. **Done** means built and covered by the automated tests listed. **Planned** means not built yet. Nothing planned is simulated in the application. The start page shows each module's status.

## Architecture (recommended and in use)

```
Browser (vanilla ES modules, strict CSP)
   │  HTTPS, session cookie, X-AIVS header (CSRF)
   ▼
Node.js server (Express)
   ├── auth: accounts, roles, sessions, rate limits, audit log (hash-chained)
   ├── cases: workflow, claims, evidence, notes, reports, versions
   ├── media: fingerprints, archive matching, metadata, OCR, video frames
   ├── retrieval: safe page fetching (Phase 1) → evidence connectors (Phase 2)
   ├── knowledge: dataset registry + full-text/semantic index (Phase 3)
   ├── io-monitor: post-dataset analysis (Phase 4)
   ├── ai: provider adapters with schema validation and evidence-ID checks
   └── jobs: background work table (Phase 5–6)
Storage: SQLite (WAL) + content-addressed private object store
          → PostgreSQL (+ pgvector) and S3-compatible storage for multi-server pilots (Phase 8)
```

**Principles:**

- Every external service sits behind a server-side connector. Keys never reach the browser.
- Automated output is a suggestion or a lead until an analyst accepts it.
- Approval needs a second person.
- Retrieval of verified evidence comes before any model training.

**The browser editions:**

- **The no-install file and the claude.ai link** are offline, demo and trial clients built from shared sources (`browser-edition/`).
- **Where the backend features go:** retrieval, dataset and monitoring features belong in the server edition.

## Phase 1: simpler interface and repairs (done, version 1.3.0)

| Item | Files |
|---|---|
| **Start page.** Shows the eight modules with honest statuses (available, partly available, planned, not configured). | `public/js/pages/home.js`, `public/js/app.js`, `public/css/app.css`, `public/js/ui.js` (icons) |
| **Verify Information.** Paste a claim, article text or link and press Analyze to get a case with claims. | `public/js/pages/verify.js`, `server/app.js` (`POST /api/verify`, `GET /api/cases/:id/snapshot`) |
| **Safe page retrieval.** Covers the following:<ul><li>SSRF protection: private, loopback, link-local, carrier-grade NAT, multicast and reserved addresses are refused, and the checked address is pinned for the request;</li><li>redirects are re-checked;</li><li>12 s timeout, 3 MB limit and decompression limit;</li><li>HTML and plain text only;</li><li>the archived copy is kept unchanged with its SHA-256;</li><li>title, site and publication date are read from page metadata, with the basis stated.</li></ul> | `server/lib/fetchurl.js` |
| **Statement-type hints.** Labels each claim as factual, opinion, prediction, satire, question or call to action, in English and Kiswahili. Rule-based, and the analyst decides. | `shared/text.js`, `server/lib/cases.js`, `public/js/pages/case.js` |
| **Guided and Advanced modes.** The mode is stored per user. Guided mode shows one next step on each case and hides expert tools. | `server/lib/migration-003.sql`, `server/lib/auth.js`, `server/app.js` (`PATCH /api/me/preferences`), `public/js/pages/case.js` |
| **Search & check.** Moved over from the browser editions: search everything, check an image against holdings without storing it, and record a reverse-image-search result as a lead. | `server/app.js` (`GET /api/search`, `POST /api/check-image`), `public/js/pages/search.js`, `public/js/pages/case.js` |
| **Rate limits.** Apply per user, with a tighter budget for retrieval, uploads, analysis, AI and imports. Over the limit, the server answers 429 with Retry-After. | `server/lib/ratelimit.js`, `server/config.js` |
| **Privacy notice.** | `public/js/pages/privacy.js` |
| **Repair: analysis-failure test.** The test hook never fired, so failure and retry went untested; it now works. | `server/lib/cases.js` |
| **Repair: Windows start-up.** `start-windows.bat` checks for Node 22 or later, installs on the first run and opens the browser. The SQLite driver was updated so it installs on current Node versions. | `start-windows.bat`, `server/index.js`, `package.json` |

**Tests:**

- `npm test` runs 36 tests (11 of them new).
- `npm run test:e2e` runs 37 browser checks (12 new). The browser checks include an audit that every visible button (237) is wired to an action.

## Phase 2: claim verification, retrieval and citations (done, version 1.4.0, except the AI research assistant)

Built: six verdicts, evidence strength, Google Fact Check Tools and Brave connectors (need keys), internal knowledge-base and earlier-case search, citations, Check source with quotation comparison, Kenya red-flag leads, review outcomes, related cases, PDF and CSV reports. Files: `shared/verdict.js`, `server/lib/retrieval.js`, `server/lib/pdf.js`, `server/lib/migration-006.sql`, `server/lib/db.js`, `public/js/pages/case.js`, `verify.js`, `review.js`. Still to do from this phase: outdated-as-current date comparison against retrieved sources, and the AI research assistant (moved to its own phase).

Original plan:

- **Result categories.** Six per claim: supported, contradicted, partially supported, misleading or missing context, insufficient evidence, not a verifiable factual claim.
  - The overall conclusion follows from the claim results.
  - A database migration rebuilds the `claims` table to allow the new values.
- **Evidence-strength indicator per claim.** It is computed from:
  - the number of *independent* accepted sources;
  - the kind of evidence (observed, source statement, inference, lead);
  - whether sources are primary;
  - whether evidence conflicts.

  It is shown as *none, weak, moderate or strong* with the reasons. It is never a probability of truth.
- **Evidence connectors.** Each runs on the server and returns citations (URL, publisher, date, retrieved-at, archived copy):

  | Connector | Needs |
  |---|---|
  | Google Fact Check Tools API (ClaimReview search) | Free Google Cloud API key; terms of service apply |
  | Web search provider (for example Bing Web Search successor, Brave Search API or another licensed search API) | Paid key; the operator chooses and accepts the provider's terms |
  | Internal search over previous AIVS cases and the reference archive | Nothing external |

- **Quote checking.** Compares quoted text with retrieved source text and flags differences.
- **Outdated-as-current detection.** Compares the claimed date with dates in the source and in the archived page.
- **AI research assistant.** A chat attached to an investigation. It may cite only evidence IDs in the case (validated as AI assistance is today), labels findings, assumptions and uncertainties separately, works in English and Kiswahili, and keeps per-investigation history. Needs an AI provider key.

## Phase 3: datasets and knowledge retrieval (done, version 1.8.0, except scheduled updates)

Built: `server/lib/kb.js`, `public/js/pages/datasets.js`, `test/kb.test.js`. Not built: scheduled automatic updates from permitted sources.

Original plan:

**Dataset registry.** Each dataset gets a record with:

- source, licence and permitted use (research, commercial, redistribution);
- collection date, languages and size;
- known limitations and reliability notes;
- import version.

**Pipeline:**

1. Import and validation.
2. Duplicate detection.
3. Label-quality checks.
4. Human review and correction.
5. Versioning, with a fixed train/validation/test split by ID and deduplication across splits to prevent leakage.
6. Removal and correction workflow.
7. Scheduled updates from permitted sources only.

**Approach:** retrieval-augmented generation (RAG) first. Verified fact-checks are indexed (SQLite FTS5 now; pgvector at scale) and retrieved as candidate evidence with citations. Supervised fine-tuning is considered only after a retrieval baseline is measured, and only on data whose licence permits it.

**Candidate sources.** Each licence must be verified and recorded in the registry before import; none is assumed to allow unrestricted use:

| Source | What to verify first |
|---|---|
| Google Fact Check Tools API / ClaimReview | API terms; ClaimReview content belongs to each publisher |
| LIAR, FEVER, MultiFC | Licence of each release; FEVER is derived from Wikipedia; English only; US/UK-centred topics |
| Hugging Face datasets | The licence on each dataset card, and the licences of its upstream sources |
| Africa Check, PesaCheck published fact-checks | Terms of use and permission for bulk reuse; prefer their ClaimReview markup or a partnership |
| Kenyan and East African examples | Source permissions, personal data in posts, and balance across topics and parties |

## Phase 4: information operations monitor (done, version 1.5.0)

Built: `server/lib/io.js`, `public/js/pages/monitor.js`, `test/io.test.js`. Collecting posts directly from platforms is still not built; it needs approved research API access.

Original plan:

- **Input:** post datasets that the operator is permitted to use, for example CSV or JSON exports of public posts. There is no scraping. Platform research APIs need approved access and keys.
- **Signals:**
  - near-duplicate text clusters (shingling or MinHash);
  - synchronised posting (time-window co-occurrence);
  - bursts and frequency changes;
  - shared hashtags and URLs;
  - account co-activity networks;
  - cross-platform appearance of the same narrative.
- **Views:** interactive timelines, network diagrams and trend charts.
- **Every result is labelled as an investigative signal, not proof.** There is no attribution to any person, organisation or state without independently verifiable evidence.

## Phase 5: documents and media (documents done, version 1.6.0; speech-to-text and video metadata not built)

Built: `server/lib/docs.js`, document cards and OCR of scanned PDFs in `public/js/pages/case.js`, and `test/docs.test.js`.

Original plan:

- PDF and document text extraction (pdf.js on the server; DOCX through a library such as mammoth).
- Speech-to-text, either local with Whisper.cpp (no key, needs CPU or GPU time) or a paid API.
- Keyframe extraction and comparison for video.
- Reading video container metadata (ffprobe).
- Any AI-generated-media detector is labelled experimental, and its results are never treated as conclusive.

## Phase 6: case management, reporting, administration

- PDF report export generated on the server.
- CSV export of cases, claims and evidence.
- Comparison of investigations.
- Admin dashboard: users, investigations, claims analysed, evidence sources, AI usage and estimated cost, failed jobs, dataset imports, errors and evaluation results.
- Data retention periods and deletion controls, with deletions themselves audited.
- A background job queue for large files.

## Phase 7: security, performance and accuracy testing

- **Accuracy:**
  - precision, recall and F1, per language;
  - false positives and false negatives;
  - retrieval and citation accuracy, source diversity;
  - latency and cost per investigation;
  - agreement among human reviewers (Cohen's kappa).

  Accuracy is measured on held-out benchmark sets only, never on data used for tuning.
- **Security:** dependency audit, upload fuzzing, a prompt-injection test suite, and an access-control review.

## Phase 8: deployment

- Dockerfile and docker-compose (app, PostgreSQL, object storage, reverse proxy with TLS).
- Backups, health checks, logs and secret management.
- **Approval needed before any paid infrastructure is provisioned.**

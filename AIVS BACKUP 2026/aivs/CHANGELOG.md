# Changelog

## 1.8.0 — 22 October 2026: dataset registry and knowledge base

- **Datasets page:** import collections of published fact-checks and research datasets. Formats are recognised automatically:
  - Google Fact Check Tools JSON;
  - schema.org ClaimReview;
  - FEVER;
  - LIAR;
  - MultiFC;
  - a simple CSV template (`kb-template.csv`).
- **Licence first:** every import records its licence, permitted use, languages and known limitations, plus the file's SHA-256.
- **Approval:** a dataset is searched only after a second person approves it (separation of duties). Approving a new version retires the old one.
- **Duplicates** within and across datasets are detected. Each record gets a **fixed training / validation / test split** based on its text, so identical claims can never cross between splits.
- **Record review:** confirm, correct the label, or remove a record (a reason is required). Removed records leave search immediately. Every review is recorded in the audit log.
- **Search:** approved records appear in **Verify information** and **Search for evidence** as cited suggestions, with the publisher's verdict and link. When published verdicts agree, they can suggest a verdict.
- **Measured accuracy:** a leakage-free retrieval baseline (held-out test records matched only against training records). It reports coverage, accuracy, precision, recall and F1 per verdict and per language. All numbers are measured; none are estimated.
- **Synthetic practice set** (English and Kiswahili, clearly labelled), offered on training cases only.
- **Retrieval, not training:** AIVS cites dataset records; it does not train AI models on them.
- **Rating mapping** now also covers FEVER, LIAR and MultiFC labels (for example SUPPORTS, REFUTES, pants-fire, barely-true, mostly-true).
- **Database:** migration 7 (existing records are kept).
- **Tests:** `npm test` 73 (5 new); e2e all pass, including 3 new checks.

## 1.7.0 — 22 October 2026: research assistant

- **Assistant tab** in every case, for questions in English or Kiswahili, including quick questions.
- **Rules mode (no AI, free, nothing leaves AIVS):** what is missing, next checks (including the official sources behind any red flags), timeline, sources with links, summary, and searching the case records. Every point links to the record it comes from.
- **AI mode:**
  - sends the question with the case's most relevant records (claims, accepted evidence, documents, OCR text, properties), marked as untrusted material, under strict rules:
    - only those records may be used;
    - every point must cite a record ID;
    - findings, assumptions, uncertainties and next checks are kept separate;
    - no verdicts on its own authority;
    - no attribution;
    - the answer comes in the language of the question;
  - AIVS checks every citation: IDs that were not sent are marked ✗, and answers without citations are flagged;
  - text addressed to AI systems inside the case is detected and noted;
  - every send is recorded in the audit log, with the list of records sent.
- **AI services:**
  - Google Gemini (free tier for testing), Ollama (free, local or on another computer on the network), Anthropic and OpenAI-compatible services;
  - configured with `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` and `AI_BASE_URL`; keys never reach the browser.
- **`AI_TRAINING_ONLY=true` by default:** AI is used only for training cases until an administrator decides otherwise. This applies to the assistant and to AI assistance.
- **Tests:** `npm test` 68. The 5 new ones include requests to a stand-in Gemini server, the training-only guard, invented citations and prompt injection. e2e: all checks pass, including 3 new ones.

## 1.6.0 — 22 October 2026: documents in cases

- **Supported documents:** PDF, Word (.docx), TXT, CSV and JSON, added to a case like images and video. The original is kept unchanged and fingerprinted.
  - Document text is read on the server: pdf.js for PDF, a built-in reader for .docx.
  - Documents are always downloaded rather than opened inside AIVS, and macros or scripts in them are never run.
- **Document properties as leads:** author, last editor, created and modified dates, software, company and revision. They are labelled as easy to edit.
- **Warnings for:**
  - tracked changes (deleted text is kept out of the readable text);
  - reviewer comments;
  - macros;
  - JavaScript in PDFs;
  - PDFs saved several times (edited after creation);
  - signature fields (not validated);
  - embedded pictures.
- **Leads from the text:**
  - Kenya red flags (payment requests, recruitment fees and so on);
  - phone numbers and figures;
  - text addressed to AI systems;
  - a date in the text later than the document's own creation date.
- **Add claims from this document:** proposes up to 15 checkable statements and skips any already in the case.
- **Scanned PDFs** are detected; **Read text from pages (OCR)** reads up to 20 pages on the analyst's computer. The analyst checks and corrects the result.
- **Download text** for any document.
- **New case: "Take the text from a file".** Instead of pasting, choose a PDF, Word file, TXT or screenshot. AIVS fills in the text for checking (screenshots are read with OCR on the analyst's computer), and the file itself is attached to the case automatically in the next step.
- **Safety limits:** ZIP-bomb protection, at most 300 pages read, and 500,000 characters of text kept. Password-protected PDFs and Excel or PowerPoint files are refused, with an explanation.
- **PDF reading on Windows:**
  - the parser is now loaded inside the AIVS process instead of from a separate file;
  - if the server still cannot read a PDF, New case reads it in the browser instead;
  - a PDF whose text cannot be read is kept as evidence, with a warning and the OCR option, rather than refused;
  - error messages now give the underlying reason.
- **Fix:** OCR progress no longer updates a page you have already left.
- **Tests:** `npm test` 62 (5 new, with real PDF and Word files built in the tests); e2e all pass, including 4 new checks (OCR of a scanned PDF in the browser).

## 1.5.1 — 22 October 2026: screenshots in the IO monitor

- **Screenshots in the IO monitor:** you can choose up to 50 pictures of posts instead of a CSV file.
  - AIVS reads them on the analyst's computer (English and Kiswahili) and suggests the account, the post time (with its basis, marked *approximate* when worked out from "2h" or the file time), the platform and the text.
  - The analyst checks and corrects every row, against the picture, before anything is analysed.
  - Each post keeps a reference to its screenshot (file name and SHA-256 prefix).
- **Clear message for the wrong kind of file:** choosing an Excel, Word, PDF, video or other non-table file now explains what to do, instead of showing garbled characters.
- **Add posts:** posts can be added to an existing dataset, from screenshots or files. Posts already present are skipped, and the analysis re-runs.
- **Small datasets:** a dataset with fewer than 10 posts or 3 accounts says so, instead of showing bare zeros, and no single-bar chart is drawn.
- **Template:** `posts-template.csv` for collecting posts by hand.
- **Network mode:** `start-for-reviewers.bat` lets reviewers on the same trusted network sign in from their own computers. The address is shown in the AIVS window and saved to `network-address.txt`.
- **Tests:** `npm test` 57; all e2e checks pass, including 4 new ones that read real rendered post screenshots.

## 1.5.0 — 22 October 2026: information operations monitor (Phase 4)

- **Import post datasets** you are permitted to use: CSV, JSON or JSON Lines, up to 200,000 posts.
  - Common column names are recognised (text/content/tweet, username/author, created_at/date/timestamp), or you can choose the columns yourself.
  - Every import records where the data came from, the basis for using it, and the file's SHA-256.
  - No scraping: AIVS analyses only files you provide.
- **Signals:**
  - Repeated messages: near-identical wording by several accounts, using MinHash with word-pair overlap; reposts are counted separately.
  - Synchronised posting: more accounts in one time window than the message's own posting rate explains (Poisson test, corrected for the number of windows).
  - Hashtag bursts.
  - Links shared by several accounts within minutes.
  - Repost waves.
  - Accounts created shortly before the activity.
  - Cross-platform repetition.
  - A co-activity network diagram.
- **Settings are adjustable:** time window, similarity and minimum sizes, and the analysis can be re-run.
- **Every view states that signals are leads, not proof.** No attribution to any person, organisation or state.
- **Open a case from a repeated message**, to verify its content.
- **Export signals** as CSV or JSON.
- **Deleting a dataset** is limited to administrators, asks for confirmation, and is recorded in the audit log.
- **Synthetic practice dataset** with a planted pattern, clearly labelled.
- **Recent searches** on a case are now shown open, with what each service returned.
- **Tests:**
  - `npm test`: 55. The 7 new ones cover the planted pattern being found, no false alarms on everyday posts or a slow-spreading slogan, and 50,000 posts.
  - `npm run test:e2e`: all checks pass, including 5 new ones; 315 buttons are wired.

## 1.4.0 — 22 October 2026: claim verification, evidence search and citations (Phase 2)

- **Six verdicts per claim:** Supported, Partially supported, Contradicted, Misleading context, Insufficient evidence, Not verifiable. The overall conclusion follows from them. Database migration 5 rebuilds four tables to allow the new values; migration 6 adds citation fields and new tables. Existing records are kept (tested by upgrading a version-4 database).
- **Evidence strength per claim:** none, weak, moderate or strong, from the number of independent accepted sources and the kind of evidence, capped at moderate when evidence conflicts. Shown with its reasons. It is not a probability of truth.
- **Evidence search** (server side; keys never reach the browser):
  - always: the AIVS knowledge base and earlier investigations;
  - with a key: Google Fact Check Tools, Brave web search, and Brave restricted to Kenyan official and fact-checking sites.
  - Results arrive as suggestions with URL, publisher, date, rating and retrieval time. Without a key, the service is shown as "not configured"; no results are invented.
  - Verify Information can search straight away ("Also search for published fact-checks and sources").
- **Suggested verdicts** only when published fact-check ratings matched the claim and agree; the analyst adopts one explicitly.
- **Check source:** retrieves and archives a cited page (same SSRF protections), records its date, and checks quotations in the content against it (word for word, or the share of words found).
- **Kenya red flags** (EN/SW): payment requests, phone numbers, urgency, unrealistic returns, miracle cures, elections, statistics, quotes, disasters, official notices, recruitment, AI voice. Each becomes a lead naming the official source to check. No institution is treated as infallible.
- **Review outcomes:** Approve, Needs additional evidence (returns to the analyst), Reject (comment required, no report). Statuses relabelled: Under investigation, Awaiting review. Review queue has a tab per status.
- **Related cases:** link cases (same content, same claim, possibly same campaign, follow-up), recorded in the audit log. Linking is not a finding of common authorship.
- **Reports:** PDF and CSV exports added to HTML and JSON, for drafts and frozen approved reports. Reports now include methodology, limitations, citations, verdicts, evidence strength and reviewer status.
- **API usage log** for external services (per call, with estimated cost where configured).
- **Tests:** `npm test` 48 (10 new, using local fake search services); `npm run test:e2e` 46 checks (8 new).

## 1.3.1 — 22 October 2026: simpler new-case form

- **Required fields:** only the text is required. Title, where it was seen, account, link, hashtags and dates are optional and sit in a collapsible "Source details and dates" section. An empty title is made from the text; an empty platform is recorded as "Not recorded"; an empty received time is set to now.
- **Filled from a link** (the link is not opened):
  - the platform, for X, Facebook, Instagram, TikTok, YouTube, Telegram, WhatsApp, Threads, LinkedIn, Reddit and known Kenyan and international news sites;
  - the account or handle;
  - for X and TikTok, the posting time, decoded from the post ID with the basis stated. No date is guessed for platforms whose IDs do not document a time.
- **Filled from the text:**
  - hashtags;
  - a link inside the text;
  - the claimed event date, when the text contains one explicit date. A relative phrase such as "last night" fills only the basis, never an invented date.
- **The analyst's own entries are never overwritten.** Fields AIVS filled are highlighted until edited.
- **Hashtags are stored on each case,** can be edited on the case overview, link to search, and are searchable. Database migration 4 adds `cases.hashtags`.
- Verify information also uses these suggestions for pasted text, and for links to social platforms.
- **Tests:** `npm test` 38 pass; `npm run test:e2e` 38 checks pass.

## 1.3.0 — 22 October 2026: Phase 1 (simpler interface and repairs)

### Added
- **Start page:** lists the eight modules with honest statuses. Planned modules explain what they will do and which services or keys they need.
- **Verify Information:** paste a claim, article text or a link, then press Analyze to create a case with separate claims.
  - Links are retrieved by the server and archived unchanged with their SHA-256.
  - The page's title, site and publication date are read from its metadata, and the basis is stated.
  - Private, local and reserved network addresses are refused. Redirects are re-checked, and the request is pinned to the checked address.
  - Timeout, size and decompression limits apply.
- **Statement-type hints** on every claim, in English and Kiswahili: factual, opinion, prediction, satire, question, call to action. Each comes with an explanation of what to do; the analyst decides.
- **Guided and Advanced modes,** saved per user. Guided mode shows one next step on each case and hides expert tools.
- **Search & check** in the team edition:
  - search across cases, claims, evidence, text read from images, notes, files and the archive;
  - check an image against holdings without storing it.
- **Search the web** for an image, recording the result as a lead.
- **Rate limits** per user, with a tighter budget for heavy work. Over the limit, the server answers 429 with Retry-After.
- **Privacy notice.**
- **docs/ROADMAP.md:** the phases, the files each touches, and the external services and keys involved.

### Fixed
- The start page is the default page. The dashboard is still in the menu.
- Wildcard characters typed into search are treated as text.

### Database
- Migration 3 runs automatically and keeps existing data. It adds:
  - `claims.claim_type` and `claims.claim_type_cue`;
  - `users.ui_mode`;
  - the source-page fields on `cases`;
  - two indexes.

### Tests
- `npm test`: 36 pass (11 new).
- `npm run test:e2e`: 37 checks pass (12 new), including that every visible button (237) is wired to an action.

## 1.2.0 — 22 October 2026: no-install edition and analyst tools

### Added
- **No-install edition** (`AIVS (no install).html`): the whole application in one file, run by double-clicking it.
  - Work is saved in the browser's IndexedDB, including the original files.
  - Full backup and restore, with SHA-256 checks.
  - There is no sign-in, so approvals are labelled as *local analyst acknowledgements*.
  - Text in images can be read offline in English, Kiswahili or both.
  - Sources and the build script are in `browser-edition/`.
- **Search & check page** (no-install and hosted editions):
  - Search across cases, claims, evidence and references, visible text, notes, file names, SHA-256 fragments and the reference archive.
  - **Has this image been seen before?** compares a dropped image with every case and archive record without creating a case or storing anything.
- **Case packages**: *Export case* saves a case with its original files, notes, approved reports and contributor names as one file; *Import case* on another AIVS restores it.
  - Every file hash and the case history chain are verified on import.
  - A package that continues the local history updates the case.
  - A package whose history diverged, or one already contained here, is refused.
  - Use case packages to hand a case from an analyst to a reviewer when both use the no-install edition.
- **Search the web** for an image:
  - Saves an unchanged copy of the image.
  - Links Google Lens, Bing Visual Search, TinEye and Yandex, with a clear warning that this step leaves AIVS.
  - Records the result (service, date searched, date of the earliest copy) as a lead linked to that image.

## 1.1.0 — 21 October 2026: collaboration and reliability

### Added
- **Case notes**: team discussion on each case.
  - Authors are the signed-in users.
  - Edits and deletions keep the earlier text.
  - Every note action is in the audit log.
  - Notes never change the case version and never appear in reports.
  - Viewers can read notes but not write them.
- **Evidence source dates** (year, year-month or full date; never in the future).
  - Archive leads take the archive record's documented date.
- **Evidence correction history**.
  - Correcting an analyst's evidence keeps the earlier wording, reference and date.
  - The history is shown under the item, and the report notes the correction.
  - Automated and AI wording cannot be rewritten.
- **Archive bundles**: export and import of the reference archive as one JSON file with original images, plus:
  - SHA-256 re-check on import;
  - duplicates skipped;
  - training and operational records kept apart;
  - provenance recorded on each imported record and in an import log.
- **Dashboard lists**:
  - Returned to you by a reviewer;
  - Processing now (refreshes itself);
  - Recently updated cases.
- **Dashboard tiles** now open the case list already filtered to the figure shown (open, urgent and open, analysis failures).
- **Visible validation** on the evidence and note forms.

### Fixed
- The analysis-failure test hook depended on `NODE_ENV` and never fired under `npm test`. It now uses the test configuration, so failure and retry are tested again.

### Database
- Migration 2 runs automatically on start and keeps existing data. It adds:
  - `evidence.source_date`
  - `evidence_versions`
  - `case_notes`
  - `case_note_versions`
  - `archive_imports`

### Tests
- `npm test`: 25 tests (was 18). New tests cover:
  - restart persistence, with byte-identical files;
  - evidence corrections;
  - notes permissions;
  - archive round trip into a second installation;
  - report export hashes;
  - approval revisions;
  - dashboard lists;
  - AI timeout.
- `npm run test:e2e`: 26 browser checks (was 17). New checks cover:
  - refresh recovery;
  - notes;
  - evidence correction;
  - filtered tiles;
  - archive export and import;
  - an audit that every visible button is wired to an action (149 buttons).

## 1.0.0 — 21 October 2026
- Client–server platform: accounts and roles, workflow, per-claim evidence, archive matching, OCR, video frames, reviewer approval, frozen reports, hash-chained audit log and optional cloud AI.

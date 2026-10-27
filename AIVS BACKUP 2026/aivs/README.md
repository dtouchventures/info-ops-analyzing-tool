# AIVS: Information Verification and Evidence Assistant

AIVS is a working tool for authorised Information Operations analysts. They use it to:

- examine public or approved text, images and video;
- compare that material with a reference archive and with earlier cases;
- record evidence and the uncertainty that remains;
- produce verification reports that a second person reviews.

Automated checks and optional cloud AI only produce **leads and suggestions**. Every assessment is made by an analyst and approved by a different, authorised reviewer.

> Training material (cases `TR-…`, archive `TA-…`) is synthetic and clearly labelled. It is stored apart from operational records and never matches them.

## Quick start

You need **Node.js 22 or later** (the LTS version from nodejs.org). On Windows, `start-windows.bat` checks this, installs everything on first run and opens your browser when the server is ready. Keep its black window open while you use AIVS.

| | Windows | Linux / macOS |
|---|---|---|
| Install | double-click `start-windows.bat` | `npm install` |
| Run | (same file) | `npm start` |
| Open | http://localhost:8080 | http://localhost:8080 |

On first start the server creates an `admin` account and writes a one-time password to `data/FIRST-LOGIN.txt`. You must change it at first sign-in; delete the file afterwards.

Then:

1. **Administration → Users**: add analysts and reviewers. Each person gets a one-time password to change at first sign-in.
2. **Reference archive**: add images whose origin is documented, such as official releases and earlier verified reports.
3. Optional: **Administration → Training data → Load training cases**, then switch the top bar to **Training** to practise.

Configuration is through environment variables or a `.env` file. See `.env.example`.

## Where your work is stored

Everything lives on the server, in the folder named by `DATA_DIR` (default `data/` inside the project). Nothing is kept only in a browser, so closing the tab, refreshing or restarting the server loses nothing.

| What | Where |
|---|---|
| Cases, claims, evidence (with every correction), notes, OCR text, checklist, AI run records, case versions, reports, users, sessions, audit log | `data/aivs.db` (SQLite, write-ahead logging) |
| Original uploads, video, captured frames, archive images, thumbnails | `data/objects/ab/cd/<sha256>`: private, write-once, named by the SHA-256 of the bytes, outside the web root |
| Upload staging | `data/tmp/` (emptied as files are stored) |

To back up, stop the server and copy the whole `data` folder. **Administration → Audit → Verify stored files** re-hashes every object. `npm run verify-audit` checks the audit chain. Upgrading keeps existing data: the database is migrated in place on start.

## Where to start

- **Start page.** It opens after sign-in and lists the eight modules with their real status in this installation.
- **Verify information.** Paste a claim, article text or a link, then press **Analyze**. For a link, the server retrieves the public page once and keeps an unchanged archived copy with its fingerprint. It reads the title and publication date when the page states them, and it refuses private or local network addresses. The content is split into separate claims. Each claim is labelled as a checkable statement, an opinion, a prediction, satire, a question or a call to action.
- **Guided and Advanced.** The switch at the top selects the mode for your account. Guided mode shows one next step on each case and hides expert tools. Advanced mode shows everything.
- **Search & check.** Search everything recorded, or check whether an image has been seen before without opening a case.
- **Privacy.** The privacy page explains what is stored and what leaves the server.
- **Roadmap.** `docs/ROADMAP.md` lists what is planned and which external services need keys.

## Workflow

```
Draft → Analysing → Analyst review → Awaiting approval → Approved → Archived
            ↘ Analysis failed (retry) ↗          ↖ returned with comment
Approved / Archived → new revision (the approved report stays frozen)
```

| Step | What happens |
|---|---|
| New case | Guided form. The text **as received** is stored permanently. Analysts work on a versioned copy. Dates are recorded separately: received, published (with basis) and claimed event (with basis). |
| Media | Drop, paste or choose files. The type is checked from the file bytes. The original is stored unchanged with its SHA-256. Video frames are captured at a recorded timestamp, automatically or by the analyst. |
| Local analysis | Runs on the server: splits the text into claims, compares images and frames with the archive (including crops and mirror images) and with other cases, and reads metadata. Results arrive as **suggestions**. |
| Claims | Split, edit, add and remove claims. Each claim gets its own assessment and rationale. |
| Evidence | Four kinds of evidence: *observed detail*, *source statement*, *analyst inference* and *investigative lead*. Each item has a reference, an optional **source date** (the date the source itself carries) and a stated relation to each claim (supports, contradicts or context). Automated and AI suggestions do not count until an analyst accepts them, and their wording cannot be rewritten. Analysts' own evidence can be corrected, and every earlier wording is kept and shown. |
| Conclusion | One of: Supported / Contradicted / **Mixed findings** / Insufficient evidence. The conclusion must follow from the claim assessments. Uncertainties are mandatory. |
| Approval | A different reviewer approves the case or returns it with a comment. On approval, the report is frozen with a SHA-256 of its content. The approval is recorded under the reviewer's signed-in account, never a typed name. |
| Notes | Team discussion on each case: handovers, questions to a reviewer, decisions. Authors are the signed-in users. Edits and deletions keep the earlier text. Notes are internal and never appear in reports. Viewers can read them but not write them. |

The verification aids are:

- side-by-side, slider, difference-map and matched-region comparisons;
- error level analysis and a zoom viewer;
- OCR in English and Kiswahili that runs locally and keeps the original extraction alongside corrections;
- a date timeline that flags timing conflicts;
- a nine-step checklist.

## Sharing the reference archive

Reviewers and administrators can use **Reference archive → Export bundle** to download one JSON file. It holds each record's metadata, history and original image with its SHA-256. **Import bundle** on another installation then works as follows:

- it re-checks every image hash and rejects damaged or altered images;
- it skips images that are already in the archive;
- it refuses to mix training and operational records;
- it records where each imported record came from in that record's history.

Imported records are indexed and used in matching straight away.

## What the matching numbers mean

- **Identical file**: the same bytes (equal SHA-256). The file was received before. This says nothing about its true origin.
- **Similarity**: the number of differing bits between perceptual fingerprints (dHash + pHash, 0–128, lower is more alike).
  - **Strong** is ≤ 24 and **possible** is ≤ 34.
  - On the built-in test set, copies (re-saved, cropped, recoloured, captioned or mirrored) scored ≤ 18 and unrelated images ≥ 45.
  - It is **not a probability** that two images show the same event.
- **No match**: the image is not in this archive. It does **not** show that the image is new or authentic.

Re-tune the thresholds on your own approved dataset before relying on them.

## Evidence search (optional keys)

AIVS always searches its own knowledge base and earlier investigations. Two external services can be added by the administrator in `.env`, then restart the server:

| Setting | Service | Notes |
|---|---|---|
| `GOOGLE_FACTCHECK_API_KEY` | Google Fact Check Tools (published fact-checks, including Africa Check and PesaCheck where they publish ClaimReview) | Free key from Google Cloud Console; enable "Fact Check Tools API". |
| `BRAVE_SEARCH_API_KEY` | Brave Search API: web search, plus a search limited to Kenyan official and fact-checking sites | Paid plans. Set `BRAVE_USD_PER_REQUEST` to log an estimated cost. |

When a key is missing, the service shows "not configured" and nothing is invented. Search sends the claim wording (not files or case notes) to the service. Every result is a suggestion with its link; the analyst opens it and decides.

## Information operations monitor

Open **IO monitor** in the menu. Import a CSV or JSON export of posts you are permitted to use, giving where it came from and the basis for using it. AIVS lists:

- repeated messages, and which of them were synchronised;
- hashtag bursts;
- links shared together;
- repost waves;
- accounts that repeatedly act together, in a network diagram.

To learn the views, click **Load synthetic sample**. These results are signals for an analyst, never proof, and AIVS does not attribute activity to anyone.

## AI assistance (optional)

Set `AI_PROVIDER` (`anthropic` or `openai` for any OpenAI-compatible endpoint), `AI_MODEL` and `AI_API_KEY` on the server. Without them the interface shows **"AI not configured"** and every local feature still works.

- **Sending**: content leaves the system only when an analyst previews exactly what will be sent and ticks a confirmation. The request's destination, model and payload fingerprint are written to the audit log.
- **Validation**: replies must match a strict JSON schema. A reply that cites an evidence, media or claim ID that was not sent is rejected in full.
- **Untrusted content**: case content is passed only as data. Instruction-like text in posts or images is flagged to the analyst and never obeyed.
- **Nothing automatic**: AI output is never applied automatically. Analysts accept individual claims, observations, checks or the summary draft.
- **Records**: each run stores the provider, model, prompt version, duration, status and validation errors. The API key is never stored or sent to browsers.

## Commands

```bash
npm start                 # run the server
npm run seed:training     # load synthetic training cases (also available in Administration)
npm run create-user -- jdoe "Jane Doe" analyst
npm run verify-audit      # check the hash-chained audit log
npm test                  # 36 API, AI-adapter, collaboration and Phase 1 tests (node:test)
npm run test:e2e          # 37-check browser test of the full workflow (needs Playwright + Chromium;
                          # set CHROMIUM_PATH to use an installed Chromium)
```

## Documentation

- `docs/AUDIT.md`: audit of the earlier single-file prototype and what changed.
- `docs/ARCHITECTURE.md`: stack, data model, components and how to scale.
- `docs/SECURITY.md`: access control, data handling, AI safeguards and the deployment checklist.

## Limits (pilot)

- Single server with SQLite. See `docs/ARCHITECTURE.md` for moving to PostgreSQL and object storage.
- Video is compared through frames. The video container's metadata is not read (there is no ffprobe dependency).
- The text rules (claim extraction, dates, places) are rule-based. Treat their output as a starting point.
- Thresholds were tuned on a small synthetic set.

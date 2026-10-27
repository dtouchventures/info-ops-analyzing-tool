# Audit of the existing prototype (v0.2, single-file "Verification Assistant.html")

Audited 21 Oct 2026 against the source in `info-verification-assistant/` (`index.html`, `css/style.css`, 13 files in `js/`, ≈1,340 lines). The single-file build is the same code bundled.

## Confirmed working (kept and carried into AIVS)

| Feature | Where | Notes |
|---|---|---|
| SHA-256 on receipt | `util.js` `sha256()` (WebCrypto + JS fallback) | Correct. Moved to the server, computed on the stored bytes. |
| dHash + pHash | `hashing.js` | 9×8 gradient and 32×32 DCT, 64 bits each. Ported to the server (sharp). |
| Crop and mirror matching | `archiveSig()`, `submissionSig()` | Archive indexed as full image + 39 windows; submission also mirrored. |
| JPEG EXIF reading | `exif.js` | JPEG only, ASCII tags only. Replaced with `exifr` on the server (JPEG, PNG, WebP, HEIC, TIFF). |
| OCR | `analysis.js` `ocr()` | Tesseract.js 5.1.1, English only, **loaded from cdn.jsdelivr.net**. |
| Video frames | `analyseVideoFile()` | 4–16 evenly spaced frames in the browser; analyst cannot pick a frame at a chosen time. |
| Rule-based claim extraction | `text-analysis.js` | Sentences, recency words (EN + a few Kiswahili), places, organisations, figures. |
| Evidence board | `ui-case.js` | Suggestions → accept/dismiss; reference required. |
| Approval rules | `bindCase()` | Blocks approval unless evidence backs the verdict. |
| Report | `report.js` | Printable HTML. |
| Difference map, ELA, zoom | `forensics.js` | Client-side aids. Kept. |
| Timeline, checklist, briefing summary, cross-case "seen before" | `workflow.js` | Kept and moved onto stored data. |

## Incomplete features and defects

1. **No identity.** "Working as" is a free-text name; anyone can type any reviewer name. Approval is self-asserted, and the same person can analyse and approve.
2. **Overall verdict only.** Claims have statuses, but there is no per-claim rationale and no "mixed findings" outcome. A post with one true and one false claim must be forced into one verdict.
3. **Edits overwrite.** Claim text, received date, visible text and evidence are overwritten in place. The original submission is not preserved separately, and there is no versioning. Running OCR appends to the visible text, so the original extraction is lost after editing.
4. **Dates conflated.** Only "received" is recorded. Publication date, claimed event date and capture date are not separate fields.
5. **Evidence types not distinguished.** Observations, source claims and analyst inference are all one kind of item. Archive matches are presented as findings rather than investigative leads.
6. **Exact vs similar.** Byte-identical files and perceptually similar files are not distinguished.
7. **No workflow states** beyond open/approved. No analysis-failure state or retry. Reopening discards the approval instead of creating a revision.
8. **Video**: no metadata, and frames cannot be chosen at a specific timestamp.
9. **Thresholds** (strong ≤ 24, possible ≤ 34) were tuned on the same 14 synthetic images they are tested on.

## Synthetic and hardcoded content

- `main.js` `seed()` creates REC-001, REC-002 and DEMO-1..3 from `demo-data.js` (≈1.9 MB of embedded JPEGs). They sit in the same list as real cases; "Clear all cases" deletes real work together with demo data.
- The Evaluation tab runs on 14 synthetic images. Its figures are method checks, not operational statistics.
- No findings are hardcoded: all suggestions are computed from the inputs. Demo claim text and archive descriptions are fixed strings, labelled synthetic.

## Persistence

- v0.1: everything was lost when the tab closed.
- v0.2: one IndexedDB key holds the whole state, written after every logged action (cost grows with every image).
- Storage is per browser and per device, unencrypted. Clearing site data deletes all cases. Nothing is shared between analysts.

## External dependencies and network requests

| Request | When | Risk |
|---|---|---|
| `https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/...` plus language data | First OCR use | Leaks use pattern to a CDN; fails offline or air-gapped |
| Hosted artifact page | When opened from claude.ai | Not suitable for real case material |

There are no other runtime network calls and no telemetry.

## Security gaps

- No authentication, authorisation or separation of duties (see 1).
- The audit log is an ordinary editable array in browser storage, so it is not tamper-evident.
- Archive import accepts arbitrary JSON, including any `dataUrl`, with no validation.
- File type is trusted from the browser's MIME label. There is no size limit: a large video is read fully into memory, and a large image as a data URL.
- `innerHTML` is used widely. Values pass through `esc()`, but the pattern is fragile.
- No content security policy (CSP).

## Usability gaps

- There is no dashboard, review queue, assignment or report library.
- Demo and real cases are mixed together.
- Confirmations rely on a two-click pattern.
- Errors appear only as toasts.

## Performance gaps

- On every load, the archive signatures (40 windows per record) are recomputed on the main thread.
- The whole state is serialised on every change.
- Difference-map alignment is a brute-force search on the main thread (acceptable at 96 px).

## Decision

Rebuild as a client–server application (**AIVS**). Keep the verified algorithms (hashing, windows, thresholds as the starting point, extraction rules, forensics aids). Move identity, storage, hashing, matching and audit to the server, where they can be trusted.

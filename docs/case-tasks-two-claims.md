# Background case tasks and the two-claim limit

This extends the existing Express, browser-module and SQLite application. It adds no runtime dependencies and preserves the approved JICHO AI interface.

## Working while processing continues

The sidebar and top bar link to **Background tasks**. Case checks, evidence collection, AI verification and automatic reports save a server-side task record. Users can navigate, refresh, or sign out and return to the same task and case. Case polling pauses while an analyst is typing, so background updates do not discard an active edit. Unchanged task status does not repeatedly replace the task list. The task page shows **Pending**, **Processing**, **Completed** or **Failed**, with results linked to the case and a **Retry** control for failures. **Run again** is a separate explicit action for completed work.

`case_tasks` stores the requester, case, operation, options, attempts, error and result. Requests with unchanged inputs reuse their task; pending/processing duplicates coalesce even when sent with a different request key. A source fingerprint allows new analysis after the input, media or OCR changes. Work is bounded to two tasks at a time and serialized within each case. Task creation, execution and retry use the existing role and case-edit permissions; task options and results are private to the requester and administrators.

After a server restart, pending work resumes. Processing work is marked Failed with a retry explanation rather than claiming to still run or silently repeating an external request. Partial case results are retained. Retry uses the same task and authoritative case records. Existing evidence-retrieval keys prevent duplicate evidence suggestions; report storage remains one current automatic report per case. AI run attempts remain in their existing audit history.

Automatic investigations keep their existing stages, queue and stored results. Repeated submissions reuse the same investigation. An explicit new submission can supply `request_key` to request a fresh assessment; identical active work still coalesces. A failed investigation can be retried from its result page. If it already created a case, retry reuses the saved case content, claims, media and evidence instead of creating another case. If failure occurred before an upload was preserved, the original file must be supplied again. An attempt that timed out must finish stopping before it can be retried.

This is designed for the app's existing single-server deployment: run one application process per SQLite database. It is not a distributed worker service. Existing platform collectors, screenshot/video analysis and transcription retain their own persisted queues and status screens.

## Claims

`shared/claim-limit.js` defines the limit and exact rejection message. Migration 24 adds SQLite insert/move triggers enforcing a maximum of **two saved claim rows per case**, including removed claims. Removing a claim does not recycle a slot. Service checks provide HTTP 409 with:

> This case has reached the maximum limit of two claims.

Initial analysis creates at most the first two extracted claims. All extracted statements are preserved separately in `claim_candidates`; additional statements do not become extra case claims or report assessments. Original submissions, document text, OCR and evidence remain available. Analysts can review candidates and edit the two existing claim texts; AI suggestions still require an explicit analyst action. Later AI/OCR/report processing saves additional proposals without inserting more claims.

Manual creation, document extraction, splitting and accepted AI claim suggestions share the same service and database guard. Splitting a single claim into two retains the first claim's identity and evidence links, creates just one additional claim, resets the edited verdict and retains the original wording in the case version history. Recheck links after a split. Existing claims and evidence are never silently removed to make room.

Case pages show **Claims: n/2** for slots used. Add/split/document-claim controls are disabled or hidden when no slot remains. Evidence may still be added to either existing claim.

## Existing records and migration

Migration 24 is additive and runs automatically on the next normal server start. `openDb` keeps its existing automatic pre-upgrade database backup. No old claim, evidence, user, case version or report snapshot is deleted or rewritten by the migration.

Older cases can already have more than two saved claims. They are preserved as historical records, with no capacity to insert more. If more than two are still active, an authorized editor must open **Claims**, choose one or two existing claims and confirm the selection before a new case report or approval can proceed. Unselected claims are marked historical, with their evidence links retained. Submitted/approved cases must first follow the existing return/revision workflow. Frozen historical reports remain unchanged, even if their original scope exceeded the new limit.

New report generation checks the selected claim scope; it never silently truncates an over-limit legacy case. Training coverage examples now use three separate synthetic cases, with at most two claims in each, preserving all five demonstration scenarios.

Restart the existing app after deploying the changed server files. No manual SQL or dependency installation is required. Do not start a second server on the same production database while upgrading.

## Main components

| Component | Responsibility |
| --- | --- |
| `server/lib/migration-024.sql`, `db.js` | Persistent tasks, candidate pool, submission keys and database claim guards |
| `server/lib/case-tasks.js`, `server/app.js` | Queue, idempotency, authorization, status/retry endpoints and operation handlers |
| `server/lib/cases.js` | Lifetime capacity, candidate retention, bounded creation/splitting and explicit legacy selection |
| `server/lib/investigate.js`, `autocomplete.js`, `automatic-report.js`, `report.js`, `server/ai/index.js` | Reuse existing cases on retry, preserve claims, enforce report scope and avoid overlapping AI sends |
| `public/js/pages/tasks.js`, `case.js`, `automatic.js`, `investigate.js`, `public/js/app.js` | Navigation, task visibility, retries, claim counters and controls |
| `server/lib/training.js` | Demonstration cases that obey the same limit |

The new endpoints are `GET /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks/:id/retry`, `POST /api/cases/:id/tasks`, `POST /api/cases/:id/claims/select` and `POST /api/investigations/:id/retry`. Existing synchronous API options remain for compatibility. The normal case-analysis and automatic-report buttons now queue durable work.

## Verification

- `node --test test/case-tasks-claims.test.js`: simultaneous submissions, direct database guard, removed-slot policy, splitting/evidence retention, task deduplication, permissions, failure/retry, restart recovery, legacy migration/selection and investigation retry without a second case.
- `node test/case-tasks-e2e.mjs`: real browser checks for navigation during processing, refresh, results on return, retry, sign-out/sign-in, claim controls, report scope and mobile layout. Requires installed Chrome or `CHROMIUM_PATH` and the project's existing Playwright dependency. All records are synthetic and stored in temporary test databases.
- Existing tests cover authentication, reports, investigations, evidence coverage, media, search, monitoring and training. Updated fixtures distinguish additional candidates and preserved legacy claims from new case claims.

For a manual check, create a case, add two claims, try a third, start an evidence search, open Settings, then open Background tasks and return to the case. Refresh or sign out/in; the same two claims and task results should remain. Generate a report and confirm its assessed claims belong to that case and number at most two.

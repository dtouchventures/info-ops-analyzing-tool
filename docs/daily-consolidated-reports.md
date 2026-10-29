# Daily and consolidated reports

Open **Reports → Daily and consolidated reports**.

## Automatic daily report
- Generated inside the JICHO AI server at **23:59 East Africa Time (Africa/Nairobi, UTC+3)**, checked every 30 seconds.
- The window is exactly the preceding 24 hours, including its start and excluding its end. It is not a midnight-to-midnight calendar-day report.
- Includes high- and medium-priority Live Monitoring and AI Watchlist alerts created in that window; excludes dismissed alerts, low-priority alerts and training records from scheduled operational reports.
- Sorts high priority first. Duplicate source URLs or sufficiently long identical content are grouped; original alert references, reasons, statuses and source modules remain traceable.
- A saved draft is generated even if no qualifying alerts exist. It explains that missing alerts do not establish complete coverage or absence of events.
- Reports state source configuration at generation and the last successful recorded collection within the window. Monitoring leads do not become verified misinformation, intent or coordinated activity merely by inclusion.
- The app and computer must remain running for generation on time. The persisted schedule catches up missed daily windows after restart, at most seven windows per 30-second check. It starts with the first 23:59 cutoff on or after the date the feature is enabled; it does not silently backfill older history from before installation.
- Each scheduled window is generated once, with a unique reference and fingerprint. Saved snapshots are not overwritten. Authorised users receive an in-app notification; nothing is emailed or published externally.
- **Generate last 24 hours now** produces an on-demand report. Training mode stays separate. Identical requests with unchanged alert records and coverage within the same minute reuse the existing on-demand snapshot to avoid accidental duplicate reports.

## Consolidate selected verifications
1. Click **Select verifications to combine**.
2. Find and select 2–50 completed verifications in the current operational/training scope.
3. Set a title and click **Generate one report**.
4. Open the saved report or download PDF, Word or JSON.

The picker lists up to the 500 most recent completed verifications. Reports retain original verification IDs, report references, cases, claims, assessments, source links, evidence IDs and source-result fingerprints. Exact duplicates with the same source/content, claim findings, verdict and assessment are grouped and their body is printed once with every source reference; different or conflicting findings remain separate. Selection order does not create duplicate reports. An identical selection and unchanged source snapshots reuse the same report; changed source snapshots produce a new reference. A consolidated document is a new draft, even when an original report was approved; individual approvals do not approve the combined document.

## Exports and preservation

HTML/print preview, PDF, Word and JSON exports are available. Daily exports use the existing one-page service-writing format, summarising up to five highest-priority then most recent distinct alerts. Longer content is condensed, and omitted-group counts are explicit. Every alert remains in the saved snapshot and JSON. Consolidated exports may span multiple pages to retain selected verifications; individual verification reports keep their existing format. No person-detail footer is added. Snapshot SHA-256 values identify saved content; downloads verify that fingerprint before rendering. Originals, individual case claim limits, existing approvals and previous frozen reports remain unchanged.

Validation covers EAT cutoffs, inclusive/exclusive 24-hour boundaries, priority/status/scope filters, cross-module duplicate provenance, repeated runs, restart catch-up, permissions, source integrity, consolidation uniqueness/conflicts, multi-page exports and browser selection/mobile layouts. A synthetic multi-page Word report was opened in Microsoft Word and exported successfully; its PDF layout was rendered and inspected. No operational report was fabricated as a test.

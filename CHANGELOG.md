# Changelog

## 1.21.1 — AI Watchlist: dashboard figures, monitoring status, stale-server warning (26 October 2026)

Fix for "the dashboard shows 0 active watchlists and 0 open alerts".

**Root causes found**

1. **Dashboard counter bug.** `public/js/pages/home.js` counted watchlists with `w.active`, a field the server never sends (it sends `status: "active"`). The "active watchlists" figure was therefore always 0, whatever the database held.
2. **Server not restarted after the 1.21 update.** On the owner's PC the server was started before the 1.21 files arrived. The server loads its code once at start, so it kept running the old code: no dataset monitoring, no automatic check on import, so no alerts. The new pages were talking to the old server.
3. **Pages not robust to an older server.** The AI Watchlist pages assumed fields that only a 1.21 server sends.

**Changes**

- The dashboard counts active watchlists from `status`. The open-alert figure is the number of saved alerts with status new or acknowledged.
- `/api/watch/overview` → `stats.monitoring` reports:
  - active watchlists;
  - datasets;
  - posts checked and matching;
  - the last successful analysis time;
  - failed checks;
  - live platforms. These are counted only if an active watchlist uses them and they are configured.
- One status line on the dashboard and on *AI Watchlist → Overview* says what is happening: no active watchlist; active but no data source; or monitoring active, with the last analysis time, posts checked and matching, and a note when nothing matches.
- The dashboard refreshes its figures every 30 seconds while it is open, and redraws when you come back to it after creating a watchlist, importing a dataset or receiving alerts.
- **Restart warning:** if the server reports a different version from the pages, a banner says to close AIVS and start it again.
- The AI Watchlist pages fill in defaults for fields an older server does not send. They no longer act on a page you have already left.
- On the dashboard, alert titles no longer repeat their category.

**Tests**

- `test/watch-counters.test.js`:
  - the dashboard figures go 0/0 → draft 0/0 → activated 1/0;
  - 30 non-matching posts: checked, 0 matching, 0 alerts;
  - the SYNTHETIC dataset: alerts equal to the rows saved in `watch_alerts`, including an unusual-spike alert;
  - re-analysis adds nothing;
  - paused → 0 active.
- A new browser test does the same through the screens on a fresh server.
- **Results:** `npm test` 157/157; `npm run test:e2e` 192/192.


## 1.21.0 — three services

### Notebook, testing report and demo guide (26 October 2026)

- `notebooks/AIVS_Information_Operations_AI_Demo.ipynb` (33 cells) ran here end to end with no errors (5 charts and an interactive map). It covers four datasets with their source, date, size and limitations: LIAR, TweetEval, and the two AIVS synthetic sets, which it generates identically to the application (fingerprints match). Contents:
  - cleaning and NLP preprocessing;
  - the sentiment model: test accuracy 60.2%, macro-F1 59.8%, with its confusion matrix;
  - an optional pretrained DistilBERT (skipped here: no Hugging Face access);
  - claim classification from wording on LIAR: 6 labels 23.6% against 16.7% chance; 2 classes 63.1% against 56.7% for the majority class. This shows why verdicts must rest on evidence;
  - claim extraction and evidence retrieval by TF-IDF cosine similarity (the nearest earlier fact-check points the same way 55% of the time);
  - k-means topics, repeated messages, a county map of recorded locations only, and watchlist anomaly detection;
  - a results table and limitations.
- `docs/TESTING-REPORT.md` and `docs/DEMO-GUIDE.md`.

### Connecting APIs (26 October 2026)

- `set-api-keys.bat` (with `scripts/set-api-keys.ps1`) asks for the keys of any of 12 services and saves them in `.env`:
  - it says where to get each key;
  - typing is hidden, and values are never shown;
  - empty answers keep the current value, and the old file is kept as `.env.before-keys`.
- Tested with PowerShell 7.4 and sample values: the chosen keys were replaced or added, other lines were kept, and the backup was written.

### AI Watchlist: early warning on imported datasets (26 October 2026)

- **Watchlists monitor imported datasets** (`server/lib/watch-datasets.js`): choose datasets or "All imported datasets". Every import or addition in Social Media Analysis (CSV, JSON, Excel, screenshots, permitted collection) is checked automatically by the active watchlists that monitor it; activation and **Analyse datasets now** check what is already there.
  - Each watchlist and dataset has a stored scan record, so no post is processed twice; a post imported twice is recognised by its platform post ID.
  - A dataset-only watchlist needs no platform credentials and no collection basis (each dataset already records its own).
- **New alert categories and detectors**, all over the posts' publication times:
  - keyword threshold (your rule);
  - unusual posting spike (rolling baseline: minimum posts, ratio over the mean and standard deviations);
  - emerging narrative (term bursts over words and word pairs, with a minimum history);
  - repeated-message activity (concentrated in time; one alert per episode);
  - potential coordination indicator (several accounts, same text, within minutes, with shared hashtags and links).

  Consecutive flagged windows form one event. Every alert is labelled "Historical dataset analysis".
- **Severity** (low, medium, high) by documented rules, and a **recommended action**, on every alert (new column; database migration 13 widens the alert categories, adds the scan table and keeps every existing row).
- **Verify a claim** from any alert: choose the claim from the supporting posts. The case gets the alert's reason and supporting posts as a suggested lead for the report.
- **Delete** a watchlist: it is hidden and stops; its history, posts and alerts are kept; its open alerts are closed with the note "Watchlist deleted". Pause stops automatic checks.
- **Interface:**
  - an **Overview** tab (active watchlists, monitored posts, open alerts by severity, recent dataset checks, how alerts are decided);
  - a watchlist table (name, keywords, data source, status, posts, last analysed, actions);
  - a simple **New watchlist** form;
  - severity filter and chips;
  - an **Analysis** panel per watchlist (posts per day, spike windows, sentiment, top keywords, recurring narratives, alert history).

  Import messages in Social Media Analysis say what the watchlists found.
- **Matched posts get a tone label** (trained classifier for English, word list for Kiswahili).
- **SYNTHETIC demonstration dataset** (`server/lib/watch-demo.js`, `training/watch-demo-posts.csv`, `POST /api/io/watch-demo`): 1,000 invented election posts with two planted patterns at known times.
- **Notebook** `notebooks/AIVS_AI_Watchlist_Demo.ipynb`, run end to end here with no errors (5 charts). It covers loading and cleaning, keyword matching, sentiment (TF-IDF + logistic regression on TweetEval: test accuracy 58.8%, macro-F1 58.5%), an optional pretrained DistilBERT (skipped here because Hugging Face is unreachable; runs in Colab), k-means narratives, posting frequency, anomaly detection, alert generation and charts. It also checks the alerts against the planted answers: 7 alerts, all in planted periods, both events found.
- **Speed:** 20,000 imported posts are checked and analysed in about 1.5 s on top of the import (6.2 s in total in the test environment).
- **Tests:** `npm test` 155 (8 new in `test/watch-datasets.test.js`: create, edit, save and reload, preview, activate, empty and invalid files, CSV upload, automatic check, alerts traced to the planted records, no false alarms on the background, no duplicates, analytics, acknowledge, dismiss, verify a claim, pause, delete), all pass. `npm run test:e2e` 184 checks, all pass, including the whole workflow in the browser.

### Phase 3–4 (part 1): a trained sentiment classifier, with measured scores (26 October 2026)

- **New model** `models/sentiment-tweeteval-lr-1.json`: TF-IDF of words and word pairs (negation marked) with multinomial logistic regression, written in plain JavaScript (`server/ai/textclf.js`). Training, evaluation and prediction use the same code.
- **Data:** TweetEval sentiment (SemEval-2017 Task 4; Barbieri et al., 2020), official splits: 45,615 train, 2,000 validation, 12,284 test English tweets, downloaded from github.com/cardiffnlp/tweeteval with each file's SHA-256 recorded. Settings were chosen on the validation split.
- **Measured once on the 12,284 test tweets:** accuracy 59.5%, macro-F1 59.4%, macro-recall 60.7%. The word list AIVS used before scores 55.9% accuracy and 49.2% macro-F1; always guessing the commonest label scores 48.3% accuracy. Per-class scores and the confusion matrix are in `models/sentiment-tweeteval-lr-1.eval.json`. An honest note is recorded there: the test score of a first run was seen before the learning-rate grid was widened.
- **Reproducible:** `npm run train:sentiment` downloads the data, trains (about 1 minute), evaluates, and checks that the stored model reproduces the scores.
- **Used for** English posts in Social Media Analysis (per-post tone, when a dataset is analysed) and in the case Content analysis card, with the probability and the words that weighed most. Kiswahili text still uses the word list, because the model was not trained on it; every result names its method.
- **Settings → AI models** (`#/models`): data source and citation, sizes, settings, test scores against both baselines, per-class precision/recall/F1, the confusion matrix, limitations, and a box to try the model on any sentence. API: `GET /api/ai/models`, `POST /api/ai/models/sentiment/try`.
- Still pending: a pretrained transformer (DistilBERT, MiniLM). Hugging Face cannot be reached from the development workspace yet.
- Tests: `npm test` 147 (4 new in `test/models.test.js`), all pass; `npm run test:e2e` 176 checks, all pass.

### Four verdicts (26 October 2026)

- Analysts now choose from four verdicts: **Supported**, **Contradicted**, **Insufficient evidence**, **Not verifiable**. The overall conclusion is one of them or **Mixed findings** (supported claims beside contradicted ones, or beside claims without enough evidence; before, that gave "Partially supported").
- "Partially supported" and "Misleading context" are no longer offered: the server refuses them for new verdicts and conclusions. Claims and cases that already have them keep them, and they are still shown, counted and reported.
- Suggested verdicts from published ratings: "misleading" or "missing context" ratings suggest **Contradicted** (false as presented); "half true" ratings give no suggestion, so the analyst decides.
- The coverage demo case now marks its "road closed for a month" claim as contradicted as stated.
- Tests: `npm test` 143, all pass (updated for four verdicts, plus a check that the older verdicts are refused); `npm run test:e2e` 174 checks, all pass.

### Phase 2: simpler navigation and dashboard (26 October 2026)

- **Main menu has six items:** Dashboard, Verify Information, Social Media Analysis, AI Watchlist, Reports, Settings. Verify Information has sub-tabs: New investigation, Cases, Review queue (its badge counts cases awaiting approval).
- **Dashboard** (`#/home`): three service cards with live figures from the server (open, awaiting review and approved cases; datasets and posts; active watchlists and open alerts), recent investigations and recent alerts. No sample figures.
- **Settings** (`#/settings`): password, interface mode, Service status (the former start page, now `#/status`), Administration, and **Other tools**: Statistics, the one-page Verify form, New case with files, Search and check, Reference archive and Fact-check datasets. They are hidden from the menu in Guided mode, listed under "Other tools" in Advanced mode, and keep working with their data.
- The research assistant and AI assistance tabs are no longer offered in a case's guided "More tools"; they remain in Advanced mode.
- "KDF Mention Watch" is now titled **AI Watchlist**; "Social media analysis" is **Social Media Analysis**.
- Tests: `npm test` 143, all pass; `npm run test:e2e` 174 checks, all pass.

## 1.20.0 — 26 October 2026: content from links, and content analysis

- **Content from links** (`POST /api/extract`, New investigation page): pasting a link detects the platform, cleans the link, and after half a second shows "Fetching post content…". A preview follows, with author, posting time (and how it is known), title, source link, metrics, text status (full, possibly shortened, title only, none), every method tried, and the settings that would help. The words fill in automatically and can be edited before analysis. Retry and screenshot reading are offered when nothing is found. Text is never invented.
- **Platform adapters** (`server/lib/social.js`), each recording its attempts:
  - **Facebook:** share links and `fb.watch` are resolved by following Facebook's own redirect. Only the header is read, sign-in pages and off-site hops are not followed. Then the Graph API (`FACEBOOK_ACCESS_TOKEN`) for full text of Page posts, videos and reels, then Meta oEmbed (`META_OEMBED_TOKEN`) for metadata and a possibly shortened text, labelled as such. Groups and personal profiles are refused with an explanation. `pfbid…` links are explained.
  - **X:** public embed first (free), then the X API v2 with `X_BEARER_TOKEN` (full long-post text, exact time, metrics; cost logged).
  - **YouTube:** Data API with `YOUTUBE_API_KEY` (title, description, channel, upload time, length, views), else the embed title. Transcripts are explained as unavailable (owner-only), with transcription of a permitted copy as the alternative. Shorts, `youtu.be` and live links are recognised.
  - **TikTok:** `vm.tiktok.com` short links resolved; caption from the embed; Research API by video ID when approved credentials exist.
  - **Instagram:** Meta oEmbed caption, marked as possibly shortened.
  - **News and web pages:** headline, main text, date and site through the existing SSRF-protected fetcher. The previewed copy is reused when the case is created, so the archived copy is exactly what was previewed. Analyst edits to the text are recorded in the audit log.
- **Rate limits and failures:** a "too many requests" answer puts that method on hold until its reset time; network failures and 5xx answers are retried once; tokens are removed from messages, logs and stored answers; failures are logged on the server.
- **Content analysis** (`GET /api/cases/:id/content-analysis`, a card on step 2): what the source shows, the claims (unverified until assessed), automatic estimates (tone, topics, people, places, organisations, dates, figures, hashtags, red flags, near-identical posts in imported datasets and matches with earlier cases), and what is missing. Each estimate has its method and limits. Nothing is a finding, and similarity is never presented as proof of coordination.
- The main button on New investigation now reads **Analyze content**.
- Tests: `npm test` 143 (10 new in `test/extract.test.js`, against local stand-ins for each platform's services), all pass. `npm run test:e2e` 170 checks, all pass.

## 1.19.1 — 26 October 2026: post links fill in the words automatically

- **New investigation:** pasting a social post link now asks the platform's public embed for the post straight away and fills in "Words of the post", with its source ("Filled in from X public embed…"). This lookup was missing from the new page in 1.19.0. Words retrieved for an earlier link are cleared when the link changes, and typed words are never overwritten (a "Use the retrieved words" button is offered).
- When the platform shares no words, the reason is shown beside the field. For Facebook and Instagram that is usually because no Meta app token (`META_OEMBED_TOKEN`) is set. Adding a screenshot then reads the words from it (OCR) into the field, and the case records that they came from the screenshot.
- The server also fills in the words from the lookup when a post is submitted with a link only.
- Facebook share links (`/share/p/…`): if Meta refuses one, the message says to copy the post's full address instead.
- Tests: `npm test` 133, all pass. `npm run test:e2e` 163 checks, all pass.

## 1.19.0 — 26 October 2026: Guided mode in four steps

- **Four steps** on every case in Guided mode: 1 Add content, 2 Review findings, 3 Record conclusion, 4 Review and export. A step bar sits at the top, with one main button per step and a **← Back** link. Each step has its own address (`#/case/ID/stepN`), so reloading or the browser's back button keeps your place. A case opens at the step it has reached.
- **New investigation** page (`#/start`): one box for text or a link (a social link reveals a "Words of the post" field), plus files. If there is no text, AIVS reads the first file (OCR or document text) for the analyst to check. Title, priority and external search sit under Options. **Try a synthetic example** creates a clearly labelled training case.
- **Step 2** shows suggested evidence with Accept / Dismiss and the claim it relates to, plus accepted evidence, warnings (timing conflicts, close matches, non-factual claims, document warnings), claims, and a fact-check search.
- **Step 3**: verdicts use plain labels. "Why" and the conclusion fields save when you leave them, without redrawing the page. Missing information is explained beside the field and disappears once it is saved.
- **Step 4** lists exactly what blocks submission, each with a **Fix** link that opens the step and highlights the field. Submit needs no confirmation dialog. Reviewers approve, send back (comment required) or reject here. The report downloads as PDF, HTML or JSON.
- **More tools**: in Guided mode, the left menu shows Home, New investigation, Cases, Review and Reports. Every other module is under More tools, which also appears on each case. Tool pages have a "← Back to the steps" bar.
- Unchanged: evidence references, analyst acceptance, role permissions, audit history, independent approval and the readiness checks on the server. AI suggestions are never accepted automatically. Advanced mode keeps the full tab layout.
- Tests: `npm test` 132, all pass. `npm run test:e2e` 160 checks, all pass, including a new Guided-mode run with the synthetic example: analyst steps 1–4 → reviewer approval → PDF → audit history → phone width.

## 1.18.1 — 26 October 2026: AI connection survives short VPN drops

- On JK's PC, connections to lab1 failed 3 times in 7 attempts (13:48–13:51, Test-NetConnection) through the OpenVPN link. When the AI server cannot be reached (no route, connect timeout, connection reset), AIVS now retries twice, 2 s and 5 s apart, before reporting a failure. A refused connection or a slow model is not retried.
- The health check's "did not answer a simple request" now also gets these retries.
- Tested with a simulated link that drops the first two connections (health check passed on the third). `npm test` 132, all pass.

## 1.18.0 — 26 October 2026: modular connectors for all major platforms, with a capability table

- **Capability table** (`server/lib/watch-capabilities.js`) for 13 platforms: X, Facebook, Instagram, Threads, TikTok, YouTube, Reddit, Bluesky, Mastodon, LinkedIn, Telegram, WhatsApp Business and news feeds.
  - For each one it gives the content and search the official API offers, the access and approval needed, the mode (stream, poll or webhook), quotas and costs, and coverage limits.
  - It also gives the live status (working, needs configuration, restricted or unavailable), the last successful collection, and the live verification result. Every platform's documentation was checked on 26 October 2026.
- **New connectors:**
  - **Facebook:** posts and public comments of named public Pages. Commenters are not identified. Meta's errors are mapped to refused access or rate limits.
  - **TikTok:** Research API video query, with 64-bit IDs read exactly. It works only with credentials TikTok approves.
  - **Telegram:** Bot API `getUpdates` for channels only. Private channels must be listed as our own. Groups and DMs are ignored. One shared fetch serves every watchlist.
  - **WhatsApp Business:** Cloud API webhook (`/webhooks/whatsapp`) with token verification and an `X-Hub-Signature-256` check. Senders are pseudonymised, and messages that match no watchlist are not stored.
- **Not built:** LinkedIn. It offers no public post search; its vetted Community Management API covers only Pages you administer.
- **Alternatives for unsupported sources:** submitting a public link and importing a permitted file, both labelled as such and audited.
- **Live verification:** an administrator's **Test connection** makes one real request and stores the result. It is shown separately from the simulated tests.
- **Watchlists:**
  - Facebook Pages to read, and a setting to include or leave out comments;
  - a coverage-gaps list per watchlist;
  - adding new optional settings in an upgrade no longer counts as a definition change.
- **Alerts:** a matching post that is older than the repeated-wording window now still raises its own alert.
- **Retention:** a period for mention watch posts. Posts behind open alerts and cases are kept, and deletions are audited.
- **Caveat added:** a mention, criticism or negative tone is not misinformation or a threat, and the feature is not for building files on individuals.
- **Tests:**
  - `npm test`: 132, all pass (4 new, simulated, with documented fixtures);
  - e2e: 138 checks, all pass (2 new).
- **Not verified live:** no platform credentials are configured on this server.

## 1.17.0 — 26 October 2026: more platforms in Mention Watch

- **New sources** (`server/lib/watch-platforms.js`), each through its official API. Documentation was read on 26 October 2026.
  - **Reddit:** Data API app-only OAuth, `/search`, with the User-Agent and rate-limit headers Reddit requires. Stored Reddit posts that were deleted on Reddit are re-checked and blanked, as Reddit's Data API terms require.
  - **Bluesky:** `app.bsky.feed.searchPosts` through your own server, signed in with an app password. The public AppView refuses unauthenticated search (403, checked).
  - **Mastodon:** public hashtag timelines on the servers you name. The cursor is kept per server and hashtag, and boosts are skipped.
  - **Threads:** `keyword_search` (KEYWORD and TAG modes), with a daily query limit.
  - **Instagram:** hashtag search plus `recent_media`. AIVS keeps count of the 30 different hashtags allowed in 7 days.
- **Behaviour common to all sources:**
  - every result is checked again against the watchlist's terms, context words and exclusions;
  - counts a platform does not give stay unknown;
  - credentials go only in `.env`;
  - a source that is not configured is shown as such.
- **Not covered, with reasons on the Sources page:** Facebook, Instagram keyword search, TikTok (its Research API is not available to government or Kenya-based users), Telegram, WhatsApp and LinkedIn.
- **Interface:** collection intervals for every source; Threads and Instagram usage on the Sources page; the template starts with the connected sources.
- **Tests:** `npm test` 128, all pass (3 new, with stand-in servers for the five platforms).
- **Not tested live:** no platform credentials are configured.

## 1.16.0 — 26 October 2026: KDF Mention Watch

- **Mention watch** page with three tabs: alert queue, watchlists, sources and status.
- **Watchlists:**
  - terms, spelling variants, hashtags, and English and Kiswahili names (KDF template included);
  - context words and exclusions; languages; reposts on or off;
  - sources, intervals and signal thresholds;
  - try example sentences while editing;
  - **preview** against stored posts and examples, with an optional paid live sample;
  - activation is refused until the current definition has been previewed;
  - every change is versioned.
- **Collection** through official APIs, checked against current documentation on 26 October 2026:
  - X recent search on a schedule, continuing from `since_id`;
  - X filtered stream (`WATCH_X_STREAM=true`), with rules synchronised by tag; other projects' rules are left alone;
  - YouTube search plus video statistics;
  - RSS/Atom feeds.
- **Collection handling:**
  - pagination, duplicates, retries with back-off, rate-limit reset times, refused keys and credit;
  - daily post and search limits;
  - stream keep-alive watchdog, with gaps recorded and recovered by recent search;
  - restart recovery.

  Unsupported platforms are listed with the reason.
- **Alert queue:**
  - each alert shows the matched text with highlights, link, platform, account, publication and detection times, the reason, and observed public counts;
  - signals for repeated wording, volume rise (only with enough collection history) and engagement rise, each with its thresholds;
  - acknowledge, assign, dismiss with a reason, reopen, or convert to a case;
  - history and audit for every action.

  Reach is not estimated; unreported counts stay unknown.
- **Permissions:** new `watch.manage` (administrator, reviewer) and `watch.triage` (administrator, reviewer, analyst).
- **Database migration 12:** only adds tables; a backup is made first.
- **YouTube quota corrected:** `search.list` is now 100 calls a day in its own quota bucket, at 1 unit per call (it was 100 units of 10,000). The Social media analysis collector and its usage records were updated.
- **Tests:**
  - `npm test`: 125 tests, all pass (7 new, using stand-in X, YouTube and feed servers);
  - e2e: 136 checks, all pass (12 new);
  - an existing e2e step that raced the stand-in transcription service was made robust.

## 1.15.0 — 26 October 2026: account location for Facebook and Instagram

- **Account location card** on a case's Overview. It reads where an account is based from the text of the analyst's screenshot of the platform's own panel:
  - Facebook Page transparency: "primarily located in …", or the country list with counts;
  - Instagram "About this account → Account based in …";
  - a profile's "Lives in / From …", labelled as self-reported.
- **Confirmation:** candidates show the quoted text and the screenshot. Unrecognised country names are flagged. Nothing is recorded until the analyst confirms. Manual entry needs a screenshot or a written basis. Changes and removals are versioned and audited.
- **Reports:** HTML, JSON and PDF show the location, its source, the screenshot, who recorded it and when, with the caveat that it is the platform's or the account's statement, not verified, and not where any post was made.
- **Not done:** nothing is fetched, scraped or inferred. There is no permitted platform API for this.
- **Database migration 11:** it only adds columns to `cases`, can be run again safely, and makes a backup first.
- **Tests:** `npm test` 118, all pass (3 new); e2e all pass (4 new checks).

## 1.14.1 — 26 October 2026: speech-to-text setup and verification tools

- `transcriber/install.sh`:
  - checks what is installed first and leaves a healthy service alone (`--reinstall` forces a reinstall);
  - keeps the existing token and settings, and **no longer prints the token**;
  - `AIVS_ALLOW_FROM` restricts port 9000 to exactly the AIVS computer or network, and removes older, wider rules;
  - installs unattended (no service-restart prompt).
- `transcriber/status.sh`: a read-only status report (service, start at boot, settings without the token, firewall, health).
- `check-transcribe.bat` and `npm run check:transcribe`: an end-to-end test with the **real** service through a temporary copy of AIVS.
  - It uploads bundled synthetic English, Kiswahili, video, silence, no-sound video and fake-MP3 files.
  - It checks the authenticated health check, language, word accuracy, timestamps, silence, refusals, corrections with history, search, downloads, and evidence with recording times.
  - The token is never shown. Results are saved in `data/transcribe-check.txt`.
- AIVS writes each speech-to-text health check to `data/transcribe-health.txt`, without the token.
- `transcriber/README.md` now gives the actual setup, with Windows PowerShell and Ubuntu commands kept separate, troubleshooting and limitations.

## 1.14.0 — 26 October 2026: evidence coverage

- **Evidence coverage tab** in every case. For each claim it shows:
  - the assessment and the analyst's reasoning;
  - accepted supporting and contradicting evidence, side by side;
  - context and unreviewed suggestions, kept apart;
  - missing information, open questions and next steps.
- **Case overview:** why submission is blocked, and which claims need attention and why. It is built from the approval rules themselves: `readiness()` now also returns each problem as a coded item with the same text, so the Conclusion tab, submission and this view always agree. A claim whose verdict lacks the accepted evidence it needs stays flagged. Verdicts are never changed, and no probability or truth score is shown.
- **Clickable evidence locations:**
  - a PDF page (its extracted text, from the new `GET /api/media/:id/pages/:n`);
  - an image, or a video frame at its time;
  - an audio or video time range (a player that starts there);
  - a web source and its archived copy;
  - an archive record or a related case.

  Missing locations and missing files are stated. Evidence can now record a page (`loc_page`) or a time range (`loc_start_s`, `loc_end_s`), which are validated against the document's pages and the media type. Location changes are audited with the before and after values. Transcript evidence records its transcript and times automatically.
- **Analyst records:** missing information, open questions and next steps are stored per claim or for the whole case. Each has its author, corrections (earlier wording kept), resolved (with a note), dropped and reopened states. All are in the case history and the audit log, and in the version snapshot.
- **Suggestions:**
  - rule-based suggestions work offline, in English and Kiswahili, and always cite the records they come from;
  - optional AI suggestions (`POST /api/cases/:id/coverage/ai`) send the case records as untrusted material. Possible instructions are found even across line breaks. Items with missing or invented citations, verdicts, probabilities, web-search claims or links that are not in the records are removed and listed;
  - nothing is stored until an analyst accepts it. The server checks the citations again on acceptance;
  - if the AI fails, the response falls back to the rule-based suggestions.
- **Guided mode:** a new step points to the tab when a verdict lacks the evidence it needs. A case returned for more evidence now gets its own step (before, it was shown as "Done"). The Conclusion tab links to the tab from its "Not ready yet" list.
- **Languages and layout:** English and Kiswahili labels, including the approval rules. The layout is usable at phone width.
- **Demonstration case:** a labelled synthetic training case, loaded from Settings → Training data → **Load evidence coverage demo** or with `npm run seed:coverage-demo`.
- **Database migration 10:** it only adds columns (`evidence.loc_page`, `loc_start_s`, `loc_end_s`, `transcript_id`) and tables (`case_gaps`, `case_gap_versions`). A backup is taken first, and existing transcript evidence gets its time range.
- **Tests:**
  - `npm test`: 115, all pass. 11 are new: supported, contradicted, mixed and insufficient claims; the flagged verdict; agreement with readiness and submission; locations and their validation; an inaccessible file; gaps, history and audit; permissions; rule and AI suggestions with missing and invented citations; AI down, bad answer and not configured; approval and report afterwards; the demonstration case; the migration and its backfill.
  - e2e: all pass, 110 checks. New: guided step, tab badge, overview, flag, page text, player at time, missing location, recording an item, accepting a suggestion, AI disabled with the reason, Kiswahili, phone width, viewer read-only.

## 1.13.0 — 26 October 2026: speech-to-text for audio and video

- **AIVS transcription service** (`transcriber/`): a small FastAPI service running **faster-whisper**, a dedicated speech recognition engine, on the CPU (int8) of a server on your network.
  - `install.sh` checks CPU, RAM and disk and picks a model the CPU can run: `small` by default, `base` under 3 GB RAM, `medium` with 12+ cores and 12+ GB.
  - It creates a locked-down systemd service on port 9000 with a random token, downloads the model once (the service then runs offline), and copies the Ollama firewall rules to port 9000.
  - `selftest.py` checks the real model on spoken English and Kiswahili, a video, silence and invalid files.
- **Audio uploads:** WAV, MP3, AAC, Ogg/Opus, FLAC, AMR and M4A are recognised from their bytes, so a renamed text file is refused. Audio cases get an audio card with a player.
- **Transcription:** started from the Media tab, or on upload (case Media tab or new case), with automatic language detection or English or Kiswahili chosen manually.
  - Runs as a background job with progress shown, and is picked up again after an AIVS restart.
  - Clear errors for an unreadable file, a video without sound, recordings that are too long or too large, a service that is down, and a wrong token.
- **Transcripts:**
  - timestamped segments linked to the recording; clicking a time plays from that moment;
  - search; corrections with history (the machine text is always kept; corrections are audited);
  - TXT, SRT, VTT and JSON downloads;
  - selected segments can be added as evidence (an observation with times, the recording's fingerprint and a machine-transcript caveat), optionally linked to a claim;
  - the research assistant can cite transcript passages (`T-…#n`).
- **Never invents speech:** voice activity detection skips silence; segments that are probably not speech are dropped; low-confidence and typical noise text is marked unclear; and every transcript and export is labelled machine-generated.
- **Privacy:** only the AIVS server talks to the service (shared token plus firewall). A public address is refused unless `TRANSCRIBE_ALLOW_REMOTE=true`. The service deletes each recording after transcribing it.
- **Start page:** Upload files shows Available only after a passed connection and token check; otherwise it says what is missing.
- `set-transcribe.bat` writes `TRANSCRIBE_URL` and `TRANSCRIBE_TOKEN` into `.env`, reading the token over SSH so nothing has to be pasted.
- **Tests:**
  - `npm test`: 104, with 7 new against a stand-in service that follows the real API;
  - service tests: 9, using real decoding and real voice activity detection on synthesised English and Kiswahili speech, video, silence and invalid files, with scripted text in place of the model;
  - e2e: all checks pass (new: Available label, upload with transcription, progress, label, timestamps and seeking, correction, search, downloads, evidence).
  - The real Whisper model could not be run in the build environment. Its accuracy and speed are measured by `selftest.py` on the server.

## 1.12.0 — 25 October 2026: research assistant on Ollama

- **Native Ollama connection** for the research assistant (`/api/chat`). The context size is set (`AI_NUM_CTX`), so long case material is not silently cut. The model stays loaded between questions (`AI_KEEP_ALIVE`). A JSON schema is enforced, and any `<think>` text is stripped.
- **Settings:** endpoint and model come from `AI_BASE_URL` and `AI_MODEL`. Only the AIVS server contacts Ollama. A public address is refused unless `AI_ALLOW_REMOTE=true`. Ollama on a private address may answer for real cases (`AI_TRAINING_ONLY` applies only to services outside your network). The social media module uses the same Ollama server unless `OLLAMA_URL` is set.
- **Real health check:** confirms the model is installed and that it generates text. It runs at start-up, from **Check connection now**, and from `/api/ai/health`. The result is written to `data/ai-health.txt`. The Assistant tab and the Start page show **AI available** only after a passed check.
- **Grounded, checked answers:**
  - built from the case content, claims, evidence, document text, OCR, properties and a new *dates* record;
  - the model is told which evidence searches AIVS actually ran, and that it cannot search the web;
  - answers keep **facts** (each must cite records), **what is missing**, **suggested verification steps** (suggestions, not findings) and the **timeline** apart, in English or Kiswahili;
  - AIVS removes facts and timeline entries without a valid record, links that are not in the records, and claims of web searches that never happened, and lists what it removed.
- **Fallback and errors:** if Ollama refuses, cannot be reached, times out, errors or answers in the wrong format, the rule-based answer is shown with the reason. Connection errors say what to check (`OLLAMA_HOST`, firewall, network). The Assistant tab shows elapsed time against the limit (`AI_TIMEOUT_MS`).
- **Tests:** `npm test` 97 (5 new against a stand-in Ollama: a complete case question with a document and sources, citation, link and web-claim checks, Kiswahili, the search log, failure fallbacks, refused, public and missing-model cases); e2e 98 checks, all pass (new: available only after a check, structured answer with links, removal shown, server stopped, rules still work, Start page status).

## 1.11.0 — 25 October 2026: social media analysis dashboard

- **Social media analysis** (menu; formerly IO monitor) is now a full dashboard for post datasets. Filters for date range, platform, theme, topic, tone and keyword apply to every view, and are kept in the address so a filtered view can be shared.
- **Getting posts in:**
  - **Excel .xlsx import** (first sheet; Excel dates converted; no new dependency);
  - new columns captured: url, comments, views, language, collected_at, country / county / place, and self-reported user_location;
  - per-record **provenance** (file and SHA-256, or API and query) and collection time;
  - JSON records with differing fields are read correctly.
- **Collection through official access:**
  - public news feeds (RSS/Atom, no key);
  - YouTube Data API v3 (`YOUTUBE_API_KEY`);
  - X API v2 recent search (`X_BEARER_TOKEN`).

  Collection runs as a background job with a cap on items and no automatic retries. Duplicates are skipped and usage is counted. Facebook, Instagram and TikTok are shown as **pending**, because they need approved research access.
- **Sentiment:**
  - an English and Kiswahili word list with negation, intensifiers and emoji, giving positive, negative, neutral or mixed/uncertain with a confidence value;
  - distribution, trend, and breakdowns by theme and platform;
  - measured accuracy on 60 labelled sentences (EN 97%, SW 95%). These sentences were written alongside the word list, so the figure is optimistic, and the page says so.
- **Topics and narratives:**
  - 9 themes (EN/SW keyword lists);
  - data-driven topics (TF-IDF k-means, deterministic);
  - "growing late in the period" detection;
  - keywords, phrases, hashtags and duplicate wording;
  - a two-topic comparison.
- **Engagement:**
  - totals and medians only for counts present in the data (absent is not zero);
  - trend, platform comparison and top content;
  - a robust unusual-engagement indicator.

  Reach and demographics are never estimated.
- **Geography:**
  - from location data only;
  - "location field in the data", "self-reported profile" and "named in text" kept apart;
  - a schematic county bubble map, county and country tables;
  - aggregates only.
- **Claims:**
  - checkable statements grouped across posts, with red flags (from the whole post) and similar published fact-checks from approved knowledge-base datasets;
  - statuses: needs review, not reviewed, being verified, no verification needed (a reason is required);
  - **Verify in a case** opens a case (a training case for synthetic data) and shows the case's accepted supporting and contradicting evidence.
- **Local AI through Ollama (optional):**
  - tone classification, topic labels, dataset summary and claim finding;
  - strict JSON schemas, answers must cover exactly the posts given, and cited post IDs and extracted claims are checked against the posts;
  - failures store nothing;
  - status, model availability and public addresses are checked (refused unless `OLLAMA_ALLOW_REMOTE=true`);
  - background jobs with progress.
- **Reports** (PDF, HTML, CSV, JSON):
  - sections: executive summary, research question, dataset and collection period, methodology, findings, claims with evidence, limitations, recommendations and reproducibility;
  - stored write-once with SHA-256, re-downloadable exactly, with an input fingerprint;
  - audited.
- **Synthetic discussion sample** for practice (clearly labelled).
- **Database:**
  - migration 8 adds columns and the tables io_topics, io_claims, io_jobs and io_reports;
  - **a copy of the database is saved automatically before any upgrade** (`aivs.db.before-v8-….bak`);
  - existing posts are kept and analysed on the next import or re-run.
- **Tests:** `npm test` 92 (10 new: imports including a real .xlsx, filters, engagement, geography, claims and fact-checks, Ollama success and every failure path, collectors, restart persistence, the upgrade from v7 with backup); e2e 91 checks, all pass (13 new dashboard checks; 517 buttons wired).

## 1.10.0 — 24 October 2026: checking a social media post

- **Verify information → Social media post**, a new flow from a post's link or screenshot to a case:
  - **Look up:** reads one public post through the platform's own public embed service. X gives text, account and date; YouTube and TikTok give the title or caption and account; Telegram gives text and time for public channels. Facebook and Instagram need `META_OEMBED_TOKEN` and are shown as **Not configured** until it is set.
  - **Honest failures:** deleted, private or unreachable posts are reported as such. Only what the link itself shows (account, the time encoded in the post ID) is filled in, and nothing is invented.
  - **Screenshots and video** can be added. Screenshots are read in the browser, filling empty fields only. The OCR text is saved with each image.
  - **Provenance:** the case records where the words came from (platform embed, OCR, or the analyst, including edits). The platform's answer is archived with a SHA-256 fingerprint and an audit entry.
  - **Dataset comparison:** shows whether the account, or a near-identical message from other accounts, appears in post datasets imported into the IO monitor. Synthetic practice datasets are compared only with training cases. It is labelled as a signal, not proof.
  - Clear loading, success and error states at every step. The form works at phone width.
- **Claim, text or link:**
  - a pasted social media link now leads to the post form instead of failing;
  - **PDF links are read** (text, title and creation date), and the PDF is archived.
- **Start page:** the Social media analysis module describes what is available now and what each missing part needs.
- **Integrations:** a new card shows the status of each post lookup service. Lookups are counted under Usage & storage.
- **Tests:** `npm test` 82 (6 new; one older test updated because PDF links are now read); e2e 78 checks, all pass.

## 1.9.0 — 24 October 2026: administration, backups and server deployment

- **Usage & storage** (Administration). Shows:
  - calls, failures and estimated cost per external service;
  - recent failures (evidence search, assistant, AI, analysis);
  - database, file and backup sizes;
  - record counts.

  Costs are estimates from configured prices.
- **Backups:**
  - automatic daily, plus **Back up now**;
  - a consistent database copy taken while AIVS runs;
  - files are copied once into a shared store, so later backups are quick;
  - a SHA-256 manifest; the newest N are kept (default 7); each backup is audited;
  - restore steps are in the README.
- **Retention:** periods for IO monitor post datasets and assistant conversations (default: keep). Items past their period are listed for review and deleted only on explicit confirmation, and every deletion is audited. Cases, evidence, reports and the audit log are never deleted by retention. Old temporary uploads can also be cleared.
- **Server deployment kit:**
  - `Dockerfile`;
  - `deploy/docker-compose.yml` with Caddy for automatic HTTPS;
  - `deploy/aivs.service` (systemd);
  - `/healthz`;
  - `docs/DEPLOY.md`.

  Tested: clean production install and secure mode (Secure cookie, HSTS). **Not yet tested:** the Docker image build and certificate issuance on a real server.
- **Windows starter** stops an older AIVS still running on the port, so updates take effect.
- **Tests:** `npm test` 76 (3 new); e2e 69 checks, all pass.

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

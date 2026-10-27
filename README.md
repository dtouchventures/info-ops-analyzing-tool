# AIVS: Information Verification and Evidence Assistant

AIVS is a working tool for authorised Information Operations analysts. They use it to:

- examine public or approved text, images and video;
- compare that material with a reference archive and with earlier cases;
- record evidence and the uncertainty that remains;
- produce verification reports that a second person reviews.

**Verify Information works in one click (1.23).** Give AIVS a link, text, image, screenshot, PDF or Word document and press **Analyze Information**. It extracts the content (with OCR for images), searches for evidence, compares the sources, assesses each claim and writes a single-page report (Background, Analysis, Assessment, Recommendations, References), with no comments needed. These automatic reports are labelled **"AI-generated · not reviewed by an analyst"**. They follow fixed, explainable rules, give no percentages, and say what could not be read or checked. The analyst's own verdicts and the approval by a different, authorised reviewer work as before, and remain the only way to an approved report.

Automated checks and optional AI produce **preliminary findings with stated limits**. The existing reviewed-report workflow still requires a different authorised reviewer for approval.

## Automatic public-content fact-checking reports (1.22)

In **New investigation**, paste a public social media or website URL, paste text, or upload images or documents. **Automatically generate a dated fact-checking report** is selected by default. Choose **Analyze content**. No analyst comments, rationale or approval are required to generate this preliminary report.

The workflow preserves the original, reads document text and image OCR, extracts claims, runs local checks, optionally analyses them with AI, researches evidence, checks source accessibility and generates the report. Scanned PDFs are read locally with OCR, up to the first 12 pages per file; that coverage is disclosed. English and Kiswahili OCR assets are served locally. Text-reading failures remain visible rather than being treated as successful extraction.

The report includes **Background, Analysis, Assessment, Recommendations and Citations**, with separate received, published and claimed-event dates. The report date uses **Africa/Nairobi** by default (`REPORT_TIMEZONE` can select another IANA timezone); timestamps retain their explicit UTC offset. Read or print the report, or download its JSON. To regenerate an existing case, use **More tools → Automatic report**. A report remains available after restarting the server; interrupted jobs are labelled and can be retried.

External evidence searches use the configured connectors only when the search option is selected. AI requires selecting the option that allows sending the case's text, OCR and evidence to the configured service. A run can make two AI requests: initial analysis and synthesis after research. AI training-only restrictions still apply. Missing configuration and failed searches are disclosed; no evidence is invented.

Search snippets and accessible pages are leads, not proof. Source checks retrieve and fingerprint up to eight public citation pages per run. Automatic assessments synthesise accepted evidence links or published fact-check ratings where the full claim text appears on the archived page; published ratings remain explicitly provisional and need date, event and context checks. Otherwise the assessment states **Insufficient evidence**. The workflow does not accept suggestions, change existing claim verdicts, approve a case, or infer an author's intent. The existing reviewed reports and approval tools remain available. Switch off automatic reporting to follow the original four-step workflow.

### Source restoration

The original GitHub upload flattened files into the repository root and omitted required modules. The working source is restored under `server/`, `public/`, `shared/`, `test/`, `scripts/` and the documented supporting directories. Legacy root-level uploads are retained; `npm start` and the Windows launchers use the restored directory structure. Runtime databases, uploads, secrets and backups are excluded from Git.

Validation: `npm test`, `npm run test:e2e`, and `npm run test:automatic:e2e`. Browser tests require Playwright Chromium, or set `CHROMIUM_PATH` to an installed Chrome executable.

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

**Connecting platform APIs** (YouTube, X, Facebook, Instagram, Telegram, Reddit, Bluesky, Mastodon, news feeds, TikTok research, Google Fact Check, Brave): on Windows, double-click `set-api-keys.bat`. It shows which keys are already saved (never their values), says where to get each one, hides what you type, and writes `.env` (keeping the old file as `.env.before-keys`). Then restart AIVS and press **Test connection** for each platform under *AI Watchlist → Sources and status*.

## Investigate a post in four steps (Guided mode)

**Verdicts.** Each claim gets one of four verdicts: **Supported**, **Contradicted**, **Insufficient evidence** or **Not verifiable** (opinion, prediction, satire or a question). The overall conclusion is one of these, or **Mixed findings** when claims point different ways. Supported and contradicted need accepted evidence. Cases recorded before version 1.21 may show the older "Partially supported" or "Misleading context"; they keep them.

Guided mode is the default. Choose **New investigation** in the left menu and follow the four steps shown at the top of every case page:

1. **Add content.** Paste the text or one link, or drop pictures, video, voice notes or documents. For a link, AIVS fetches the post or page by itself and shows what it found (see [Content from links](#content-from-links)); check or edit the words. Choose **Analyze content**. AIVS keeps the original exactly as received and runs its checks.
2. **Review findings.** Read the extracted claims, warnings, suggested evidence and the **Content analysis** (tone, topics, names, red flags and similar posts, each with its method and limits). For each suggestion, pick the claim it relates to and choose **Accept** or **Dismiss**. Nothing is accepted for you.
3. **Record conclusion.** Give each claim a verdict and say why. Then choose the overall conclusion, explain it and note what is still uncertain.
4. **Review and export.** If anything blocks submission, AIVS lists it with a **Fix** link that opens the exact field. Choose **Submit for approval**. A different reviewer opens the same case at step 4 and approves, sends it back or rejects it. Download the report as PDF.

Tips:

- Your work saves when you leave a field. You can close the page and continue later from **Cases**.
- **← Back** returns to the previous step. Each step has its own address, so the browser's back button works too.
- **More tools** (top right of a case, and at the bottom of the left menu) opens every other module, such as the timeline, image checks, notes and history. Use them only when needed.
- To practise, choose **Try a synthetic example** on the New investigation page. It becomes a training case (`TR-…`) and never mixes with real cases.
- Prefer the full set of tabs? Switch to **Advanced** mode in the top bar. Nothing is lost either way.

## AI models

**Settings → AI models** shows what runs inside AIVS, the data it was trained on, and its scores on test data it never saw.

| Model | Used for | Trained on | Test scores |
|---|---|---|---|
| `sentiment-tweeteval-lr-1`: TF-IDF + logistic regression (`server/ai/textclf.js`) | Tone of English posts in Social Media Analysis and in Content analysis | TweetEval sentiment, 45,615 English tweets ([source](https://github.com/cardiffnlp/tweeteval)) | 59.5% accuracy, 59.4% macro-F1 on 12,284 test tweets (the old word list: 55.9%, 49.2%) |
| Word list `lexicon-1` | Tone of Kiswahili text | written by hand | not measured on real posts |

To retrain and re-measure: `npm run train:sentiment` (downloads the data once, about 1 minute). The scores describe tweets from 2013–2017, not Kenyan posts; tone is never evidence that a claim is true or false.

## Where your work is stored

Everything lives on the server, in the folder named by `DATA_DIR` (default `data/` inside the project). Nothing is kept only in a browser, so closing the tab, refreshing or restarting the server loses nothing.

| What | Where |
|---|---|
| Cases, claims, evidence (with every correction), notes, OCR text, checklist, AI run records, case versions, reports, users, sessions, audit log | `data/aivs.db` (SQLite, write-ahead logging) |
| Original uploads, video, captured frames, archive images, thumbnails | `data/objects/ab/cd/<sha256>`: private, write-once, named by the SHA-256 of the bytes, outside the web root |
| Upload staging | `data/tmp/` (emptied as files are stored) |

**Administration → Audit → Verify stored files** re-hashes every object. `npm run verify-audit` checks the audit chain. Upgrading keeps existing data: the database is migrated in place on start.

## Backups

AIVS backs itself up **daily**, and on demand from **Administration → Backups & retention → Back up now**. It keeps the newest 7 backups (adjustable). The server keeps running during a backup.

- Location: `backups/` next to the data folder, or `BACKUP_DIR`.
- Each backup `backups/aivs-YYYYMMDD-HHMMSS/` holds:
  - `aivs.db`, a consistent copy of the database;
  - `manifest.json`, with the database's SHA-256.
- Files are stored once in `backups/objects/ab/<sha256>`, shared by all backups.
- Backups are on the same disk as the data. **Copy the `backups` folder to another place regularly** (USB drive, another computer).

**To restore** (nothing is overwritten; the current data is kept aside):

1. Stop AIVS. Rename `data` to `data-before-restore`.
2. Create a new `data` folder and copy `aivs.db` from the chosen backup into it.
3. Copy every file from `backups/objects/ab/<sha256>` to `data/objects/ab/cd/<sha256>`. `cd` is the 3rd and 4th characters of the name. For example, `backups/objects/3f/3fa2…` goes to `data/objects/3f/a2/3fa2…`.
4. Start AIVS. Run **Administration → Audit → Verify stored files** to confirm that every file is present and intact.

**Retention:** **Administration → Backups & retention** sets how long IO monitor post datasets and assistant conversations are kept (0 = always). Items past their period are listed first and deleted only when an administrator selects them and confirms. Each deletion is written to the audit log. Cases, evidence, reports and the audit log are never deleted by retention.

**Usage & storage** shows calls, failures and estimated cost per external service, plus database, file and backup sizes.

To put AIVS on a rented server with HTTPS, see `docs/DEPLOY.md`.

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
| Evidence coverage | One view per case of every claim: the assessment and reasoning, accepted supporting and contradicting evidence, context and unreviewed suggestions (kept apart), and missing information, open questions and next steps. What blocks submission is listed exactly as the approval rules report it. See [Evidence coverage](#evidence-coverage). |
| Notes | Team discussion on each case: handovers, questions to a reviewer, decisions. Authors are the signed-in users. Edits and deletions keep the earlier text. Notes are internal and never appear in reports. Viewers can read them but not write them. |

The verification aids are:

- side-by-side, slider, difference-map and matched-region comparisons;
- error level analysis and a zoom viewer;
- OCR in English and Kiswahili that runs locally and keeps the original extraction alongside corrections;
- a date timeline that flags timing conflicts;
- a nine-step checklist.

## Account location (Facebook and Instagram)

Facebook and Instagram publish where some accounts are based:

| Platform | Where to find it | What it says |
|---|---|---|
| Facebook Page | Page → About → **Page transparency** | "People who manage this Page are primarily located in …", or a list such as "Kenya (4)" |
| Instagram | profile → ⋯ → **About this account** | "Account based in …" |
| Profile intro | the account's own profile | "Lives in …" / "From …" (self-reported by the account) |

**Recording it:**

1. Screenshot the panel and add the screenshot to the case on the **Media** tab.
2. Click **Read text** on the screenshot.
3. On the **Overview** tab, open the **Account location** card and click **Find in screenshots**. AIVS lists what it found, with the quoted text and the screenshot.
4. Click **Use this** to confirm one. Nothing is recorded until you confirm. A name that isn't a recognised country (often an OCR misspelling) is flagged.
5. If there's nothing to read, use **Record it yourself** and give a screenshot or a written basis.

**In reports:** the HTML, JSON and PDF reports show the location with its source, the screenshot ID, who recorded it and when. They add a caveat: this is what the platform (or the account) states, it is not verified, and it does not show where any post was made, because an account can be run from elsewhere.

**Limits:** AIVS never fetches, scrapes or guesses an account's location. The Meta embed lookup doesn't provide it, and the platforms offer no permitted API for it. Only English panel wording is recognised so far. Changes and removals are kept in the case history and the audit log.

## Evidence coverage

The **Evidence coverage** tab of a case shows, for every claim:

- the analyst's assessment and reasoning, with who assessed it and when;
- accepted evidence that **supports** it and accepted evidence that **contradicts** it, side by side;
- **context** (accepted, neither for nor against) and **unreviewed suggestions** (dashed, "not evidence until accepted"), kept apart;
- **missing information, open questions and next steps** that analysts record. Each item keeps its author, every correction (earlier wording kept), and whether it is open, resolved (with how) or dropped;
- **suggested** next steps, never recorded until an analyst accepts one:
  - **rule-based** suggestions always work, with or without AI;
  - **AI** suggestions are optional and use the configured AI service (for example Ollama). They must cite records of the case. AIVS removes any that cite records that do not exist, decide the claim, give a probability, claim a web search or add links that are not in the records, and lists what it removed. If the AI fails, the rule-based suggestions remain.

**Every evidence reference is clickable** when the location is known:

| Evidence points to | What opens |
|---|---|
| a page of a PDF | the extracted text of that page (documents are never opened inside AIVS; the original downloads) |
| an image or video frame | the image viewer, or the video at the frame's time |
| a time in audio or video, including transcript passages | a player that starts at the recorded time and pauses at the end |
| a web source | the link in a new tab, plus the archived copy if one was taken |
| an archive record or another case | that record or case |

When the exact place is not recorded, the view says **Exact location not recorded**, **Page not recorded** or **Time not recorded**. An analyst can then use **Record location**, or fill in the page and time fields when adding evidence. When the original file is missing from storage, the view says **Original file not available on this server**.

**Case overview:** it lists why submission is blocked, in the approval rules' own words, and which claims need attention and why. A claim marked supported or contradicted without the accepted evidence that verdict needs stays **flagged** in red until it is fixed. The view never changes a verdict, and evidence counts never decide whether a claim is true. The "recorded evidence" line describes what is recorded; it is not a probability. Open items are shown but do not block submission: the approval rules are unchanged.

**Guided mode:** when a verdict is not backed by evidence, or a reviewer returns the case, the next-step panel points to this tab.

**Languages:** labels switch between English and Kiswahili with the toggle at the top of the tab. Rule-based suggestions and the approval rules are translated too. Analysts' own text is shown as written.

**Who can do what:** everyone who can read the case can read the tab. Only the assigned analyst, a reviewer or an administrator can record items or locations, and only while the case is open for changes. Every change is in the case history and the audit log.

### Demonstration case (synthetic)

1. Start AIVS as usual (`start-windows.bat`, or `npm start`).
2. Load the demonstration case, in one of two ways:
   - **Settings → Training data → Load evidence coverage demo**; or
   - in a second terminal in the `aivs` folder: `npm run seed:coverage-demo`.
3. Switch **Records** (top right) to **Training**, open **Training 4 · Evidence coverage demo (SYNTHETIC)**, then open the **Evidence coverage** tab.

The case has five claims:

- contradicted, with a cited PDF page;
- contradicted as stated, with evidence both ways (a lane closed for two days, not a road for a month);
- insufficient, with a synthetic audio tone and a timestamp;
- supported but backed only by context, which shows how a flagged verdict looks;
- supported.

It also has an unreviewed suggestion and two recorded next steps. Every record is labelled SYNTHETIC and describes no real event.

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

## Content from links

Paste a link into **Text or link** on **New investigation**. Half a second later AIVS:

1. recognises the platform (or a news site) and cleans the link (tracking parameters removed, mobile addresses mapped to the main site);
2. shows **Fetching post content…**, then a preview: author, posting time and how it is known, title, source link, metrics where given, and whether the text is **Full**, **Possibly shortened**, **Title only** or **No text**;
3. fills in **Words of the post** (or **Text of the page**), which you can edit before analysis.

When nothing could be fetched, the preview says why, lists every method AIVS tried (**How AIVS tried**), and names the setting an administrator could add. Add a screenshot and AIVS reads the words from it, or paste them. **Retry** asks again. AIVS never invents text.

| Platform | Without keys | With keys (server `.env`; never sent to browsers) |
|---|---|---|
| X (Twitter) | text, account and day from the public embed | `X_BEARER_TOKEN`: when the embed fails, the X API gives the full text (including long posts), exact time and metrics. Each read is paid (about $0.005) and logged with its cost. |
| YouTube | title and channel | `YOUTUBE_API_KEY`: title, description, channel, upload time, length and views (free quota) |
| TikTok | caption and account; `vm.tiktok.com` short links are followed | `TIKTOK_CLIENT_KEY`/`SECRET` (approved Research API only): description by video ID |
| Telegram | text and time of public channel posts | – |
| Facebook | nothing: Meta shares posts only with registered apps | see below |
| Instagram | nothing | `META_OEMBED_TOKEN`: author and caption, which may be shortened |
| News sites and other web pages | headline, main text, publication date and site, retrieved once with SSRF protection; the same copy is archived when you analyse it | – |
| WhatsApp, Threads, LinkedIn, Reddit, Facebook groups, personal profiles | nothing; add a screenshot | – |

**Facebook in detail.** Share links (`facebook.com/share/p/…`, `fb.watch`) are first followed through Facebook's own redirect to find the post's real address. Only the redirect is read, never the page, and AIVS stops if Facebook asks for a sign-in. Then:

- `FACEBOOK_ACCESS_TOKEN`: the **Graph API** gives the full text and exact time of posts, videos and reels of Pages the token may read. A **Page access token** reads your own Pages. Reading other organisations' public Pages needs a business-verified Meta app approved for **Page Public Content Access**. Links using Facebook's newer `pfbid…` post codes cannot be looked up this way.
- `META_OEMBED_TOKEN` (`APPID|CLIENTTOKEN` of a Meta app with the **oEmbed Read** feature): **metadata** (author) and, where Meta includes it, a text that **may be shortened**. AIVS labels it "Possibly shortened" and never treats it as the full post.

Rate limits are respected: after a platform says "too many requests", AIVS does not call it again until the reset time. Network failures and server errors are retried once. Tokens are removed from every message, log line and stored answer.

What is **said** in a video is never available from these services (YouTube gives caption files only to the video's owner). To check speech, add a copy of the video you are permitted to use: the AIVS transcription service transcribes it.

## Checking a social media post

**Verify information → Social media post**:

1. Paste the post's link and click **Look up**. AIVS reads the post through the platform's own public embed service, the one websites use to show posts. Only the link is sent.
2. Add or correct the words, then add screenshots, images or video. Screenshots are read in the browser (English and Kiswahili).
3. Click **Analyze post**.

The case records:

- where the words came from (the embed, OCR or the analyst);
- the platform's answer, archived with its SHA-256 fingerprint;
- whether the account or a near-identical message appears in post datasets imported into the IO monitor.

| Platform | Lookup | Needs |
|---|---|---|
| X (Twitter) | post text, account, date | nothing |
| YouTube, TikTok | title or caption and account (speech is not transcribed) | nothing |
| Telegram | post text and time (public channels) | nothing |
| Facebook, Instagram | post text where Meta includes it | `META_OEMBED_TOKEN` (a Meta developer app: `APPID|CLIENTTOKEN`) |
| WhatsApp, Threads, LinkedIn, Reddit | none | paste the text and add a screenshot |

When a post is deleted, private or cannot be reached, AIVS says so and fills in only what the link itself shows.

Social links pasted into **Claim, text or link** are sent to this form. PDF links pasted there are read like uploaded PDFs.

## Social media analysis

Open **Social media analysis** in the menu.

**Get posts in:**

- **Import a file:** CSV, JSON or Excel (.xlsx) exports you are permitted to use.
  - Needed columns: text, account and time.
  - Optional columns: platform, url, likes, comments, shares, views, language, country, county or place, user_location, collected_at.
- **Screenshots of posts:** read on your computer; you check every row before import.
- **Collect** from public news feeds (RSS/Atom), YouTube (needs `YOUTUBE_API_KEY`) or X (needs `X_BEARER_TOKEN`). Facebook, Instagram and TikTok are **pending**: they need approved research access.

Every record keeps its provenance (file and SHA-256, or the API and query) and its collection time.

**Dataset views** (the filters for date range, platform, theme, topic, tone and keyword apply to all of them):

- **Overview:** key figures and tone over time.
- **Sentiment:**
  - estimated tone: positive, negative, neutral, mixed or uncertain;
  - shown over time and by theme and platform;
  - with a measured-accuracy note.
- **Topics & narratives:**
  - themes (English and Kiswahili keyword lists) and topics (keyword clusters found in the data);
  - narratives that grow late in the period;
  - keywords, phrases, hashtags and duplicate wording;
  - a side-by-side topic comparison.
- **Engagement:**
  - likes, comments, shares and views, only where the data has them;
  - trends, platform comparison and top content;
  - an unusual-engagement indicator.
- **Claims:**
  - checkable statements, grouped;
  - red flags and similar published fact-checks from approved datasets;
  - **Verify in a case**, which shows the case's accepted supporting and contradicting evidence;
  - "no verification needed", which requires a reason.
- **Geography:** only from location data in the records, with three kinds kept apart:
  - a location field in the data;
  - a self-reported profile location;
  - places named in the text.

  It is a schematic county map and tables. No individual tracking.
- **Report:**
  - PDF, HTML, CSV or JSON, built from the stored records with the current filters;
  - stored with a SHA-256 so it can be downloaded again exactly;
  - includes an input fingerprint for reproducibility.

**Local AI (optional):** set `OLLAMA_URL` and `OLLAMA_MODEL` to use Ollama for tone, topic labels, summaries and claim finding.

- Answers must be valid JSON in a fixed format and may cite only the posts given. Anything else is rejected.
- Without Ollama, every view works with the rule-based methods.

**Practice:** **Load discussion sample** creates an invented dataset with a planted growing theme, a repeated claim, a scam message and a viral post.

## Information operations monitor (coordination indicators)

Open a dataset and choose **Coordination**. AIVS lists:

- repeated messages, and which of them were synchronised;
- hashtag bursts;
- links shared together;
- repost waves;
- accounts that repeatedly act together, in a network diagram.

To learn the views, click **Load synthetic sample**. These results are signals for an analyst, never proof, and AIVS does not attribute activity to anyone.

## AI Watchlist (early warning on imported datasets)

**AI Watchlist** watches topics in public post datasets imported into **Social Media Analysis** (CSV, JSON or Excel), with or without any platform API.

1. **Create** a watchlist under *AI Watchlist → Watchlists → New watchlist*. Give it a name, a description, keywords, hashtags or phrases, and a rule such as "10 matching posts within 60 minutes". Then choose the datasets to monitor, or *All imported datasets* to include future imports.
2. **Preview and activate** it. The chosen datasets are checked at once.
3. **Import data.** Every new import, or posts added to a dataset, is checked automatically by each active watchlist that monitors it. Posts already checked are not processed again: progress is stored per watchlist and dataset, and a post imported twice is recognised by its platform post ID.
4. **Review the alerts** (*Alerts* tab). Acknowledge, dismiss with a reason, assign, or choose **Verify a claim**. That last action opens a case in Verify Information with the claim you pick from the supporting posts. The alert's reason and posts are added as a suggested lead, ready to be accepted into the report.

| Alert category | Raised when (default thresholds, all editable) | Severity |
|---|---|---|
| Keyword threshold exceeded | at least 10 matching posts within 60 minutes (your rule) | low; medium at twice the rule |
| Unusual posting spike | a 60-minute window with at least 10 posts, at least 3× the average of the 24 windows before it and 3 standard deviations above it | medium; high at 5× and 5 SD |
| Emerging narrative | words or word pairs in at least 8 posts in a 6-hour window, at 3× their usual rate and 3 SD above it, after 8 windows of history | low; medium at twice the minimum |
| Repeated-message activity | the same or nearly the same text from at least 2 accounts, at least 3 posts within 24 hours, concentrated in time (3× its usual rate); messages repeated in the same period form one alert | medium; high at 10+ accounts |
| Potential coordination indicator | at least 3 accounts posting the same text within 10 minutes | medium; high at 5+ accounts within 10 minutes |

Each alert gives:

- its category and severity;
- the detection time and the number of posts;
- the reason, with the figures and thresholds;
- the supporting posts and the datasets they come from;
- a recommended action.

Spikes are judged against the windows before them, so a topic that is simply always popular does not raise alerts. The **Analysis** panel of each watchlist shows:

- posts per day and the spike windows;
- sentiment (the trained classifier for English, the word list for Kiswahili);
- top keywords;
- recurring narratives (TF-IDF and k-means, with example posts);
- alert history.

**What this is not.** Imported datasets are analysed by the publication times they contain, which is *historical dataset analysis*, labelled as such on every alert; it is not real-time monitoring. Live monitoring needs a connected, authorised platform API (see *Sources and status*) and runs on a schedule. Sentiment, repetition and coordination indicators are signals for a human; they are never proof of misinformation or manipulation.

**Demonstration data.** *AI Watchlist → Overview → Load the SYNTHETIC election dataset* imports 1,000 invented posts. The same data is in `training/watch-demo-posts.csv`, generated by `server/lib/watch-demo.js`. It contains two planted patterns: a "ballot boxes burned" rise on 6 October from 14:00 UTC, and 12 new accounts posting the same message within 6 minutes on 5 October at 10:00 UTC. With the example watchlist (*election, IEBC, voting, ballot*), AIVS raises alerts only for these two events; `test/watch-datasets.test.js` checks this.

**Notebook.** `notebooks/AIVS_AI_Watchlist_Demo.ipynb` (Google Colab) walks through the same logic step by step:

- loading and cleaning the data, keyword matching;
- sentiment trained and tested on TweetEval, plus an optional pretrained DistilBERT;
- TF-IDF + k-means narratives, posting frequency and anomaly detection;
- alert generation and charts;
- a check of the alerts against the planted answers (7 alerts, all in planted periods, both events found);
- limitations.

## KDF Mention Watch (early detection of public posts)

Open **Mention watch**. It looks for public posts that mention the Kenya Defence Forces and puts them in an alert queue for analysts.

**Watchlists** (reviewers and administrators):

1. **New watchlist from the KDF template** fills English and Kiswahili terms, spelling variants and hashtags. Review them: the template is a starting point, not an official list.
2. Add **context words** (a post must also contain one) and **exclusions** (for example "kdf file") to cut unrelated matches. **Try examples** shows at once whether a sentence would match and why.
3. Choose the **sources**, write the **basis for collecting** (API terms, unit policy), and save.
4. **Preview matches.** This checks the terms against posts already stored in AIVS and your examples, at no cost. Optionally it fetches one live sample per source, with the cost shown. Nothing is stored or alerted.
5. **Activate.** Activation is refused until the current terms have been previewed. Changing terms or rules returns the watchlist to draft.

**Platforms.** The **Sources and status** page has the full capability table. For each platform it shows:

- what its official API provides and what search it allows;
- the access it needs;
- whether it streams, polls or uses a webhook;
- quotas and costs where documented, and coverage limits;
- its status: working, needs configuration, restricted or unavailable;
- the last successful collection;
- whether it has been verified live, or only in simulated tests.

The documentation was checked on 26 October 2026.

| Platform | What AIVS can collect | Needs | Status without setup |
|---|---|---|---|
| X | Keyword search (7 days) and filtered stream | `X_BEARER_TOKEN` (pay-per-use, about $0.005 a post); `WATCH_X_STREAM=true` | needs configuration |
| Facebook | Posts and public comments of **named public Pages** only; no search across Facebook | `FACEBOOK_ACCESS_TOKEN` (Page Public Content Access approval, or your own Page's token) | restricted |
| Instagram | **Hashtags** only: 30 in 7 days, last 24 h, no usernames | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID` (Public Content Access approval) | restricted |
| Threads | Keyword and tag search | `THREADS_ACCESS_TOKEN` (`threads_keyword_search` approval) | restricted |
| TikTok | Keyword and hashtag search through the Research API | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`; **only for researchers TikTok approves** (academic in US/EEA/UK/CA/CH, some EU non-profits) | restricted |
| YouTube | Keyword search (100 searches a day) | `YOUTUBE_API_KEY` | needs configuration |
| Reddit | Post search (not comments); deleted posts are blanked | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME` (Reddit approval) | restricted |
| Bluesky | Keyword search | `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | needs configuration |
| Mastodon | Public **hashtag** timelines on servers you name | `MASTODON_INSTANCES` | needs configuration |
| Telegram | Posts in **channels where your bot is a member**; no search | `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_OWN_CHANNELS` for your private channels) | needs configuration |
| WhatsApp Business | Text messages people send to **your own business number**; senders pseudonymised; non-matching messages not stored | `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, and a public HTTPS address | needs configuration |
| News websites | RSS/Atom items | feed addresses | needs configuration |
| LinkedIn | Nothing: no public post search API | (Community Management API covers only Pages you run; not built) | unavailable |

**Never collected:**

- personal WhatsApp chats;
- private groups, accounts or messages on any platform;
- anything reached by scraping, borrowed credentials or unofficial access.

**Alternatives for platforms AIVS cannot collect from.** Both appear on each watchlist's page and are labelled wherever the posts appear:

- **Submit a public link:** paste the link, and the text if the platform's public embed does not give it.
- **Import a file:** a CSV, JSON or Excel export you are permitted to use. You must state the basis for using it; the file's fingerprint is recorded.

**Live verification versus tests.** The automated tests run against stand-in servers that answer in each platform's documented format; they are simulated. A connector counts as verified live only after an administrator presses **Test connection** on a configured server. The result is stored and shown, with who ran it and when.

**Retention:** in **Administration → Backups & retention** you can set a period for mention watch posts. Posts behind an open alert or a case are kept.

**Alert queue** (analysts, reviewers, administrators):

- Each alert shows the matching text with the terms highlighted, the source link, platform, account, publication time, detection time and how long after publication it was detected, and **why** it was raised.
- Engagement shows the **public counts the platform reported** and when. Counts it did not report show as "not reported". AIVS does not estimate reach.
- Signals:
  - **repeated wording:** by default 3 posts from 2 accounts in 24 h, same or nearly the same text;
  - **volume rise:** the latest hour against the previous 24, only once that much collection history exists with at least 80% successful runs;
  - **engagement rising:** an increase of at least 100 and at least ×2 within 6 h, between two observations of the same post.

  Thresholds are shown on each alert and can be changed per watchlist. None of these is proof of coordination, and no one is named as responsible.
- Actions:
  - **Acknowledge.**
  - **Assign:** analysts can assign only to themselves.
  - **Dismiss:** a reason is required.
  - **Reopen.**
  - **Convert to case:** the text, link, platform, account and publication time are copied into a new case.

  Every action is kept in the alert's history and in the audit log.

**Reliability:**

- Every run is recorded. The position reached is saved only after the posts are stored, so a restart continues where it stopped and nothing is stored twice.
- Network and server errors are retried. Rate limits wait until the platform's reset time. A refused key or exhausted credit stops that source and says so.
- Daily limits (`WATCH_X_DAILY_POSTS`, `WATCH_YOUTUBE_SEARCH_DAILY`) stop collection before costs or quotas run over.
- **Stream:**
  - a silent connection is reconnected after 25 s (X sends a keep-alive every 20 s);
  - back-off follows X's guidance;
  - periods without a connection are recorded and recovered with recent search.

**Limits:** detection is not guaranteed and may come only after a post has spread. Searches run at intervals, platforms index posts with delays, and limits or outages pause collection.

## Research assistant with Ollama (private AI on your network)

In `.env` on the AIVS computer:

```
AI_PROVIDER=ollama
AI_BASE_URL=http://10.104.4.151:11434
AI_MODEL=qwen3:4b-instruct
AI_TIMEOUT_MS=240000
AI_NUM_CTX=8192
```

- **Private:** only the AIVS server talks to Ollama; browsers never do. A public Ollama address is refused unless `AI_ALLOW_REMOTE=true`.
- **Real cases:** because Ollama on your own network keeps the records inside the organisation, `AI_TRAINING_ONLY` does not apply to it.
- **Health check:** at start-up and from **Check connection now**, AIVS asks Ollama whether the model is installed, then asks it for one word. The assistant shows **AI available** only when that works. The last result is written to `data/ai-health.txt`.
- **Answers** come back in a fixed format, built only from the case's records (content, claims, evidence, document text, OCR, properties and dates) and a log of the searches AIVS actually ran:
  - **facts**, each citing records;
  - **what is missing**;
  - **suggested verification steps** (suggestions, not findings);
  - a **timeline**.
- **Checks on every answer:** AIVS removes any fact or date that cites no record of the case, links that are not in the records, and claims of web searches that did not happen. It lists what it removed.
- **Fallback:** if Ollama fails, times out or answers in the wrong format, the rule-based answer is shown with the reason.
- **Speed:** on a CPU-only server, a 4-billion-parameter model may take 30 seconds to several minutes, longest on the first question while it loads.

## Speech-to-text for audio and video (private, on your network)

Upload voice notes (MP3, M4A, WAV, OGG/Opus, AMR, FLAC) or video to a case. AIVS sends a copy to the **AIVS transcription service** (`transcriber/` folder): faster-whisper, a dedicated speech recognition engine, running on the CPU of your Ubuntu server. Ollama is not used for speech. Nothing goes to an outside service.

- **Languages:** English and Kiswahili, detected automatically or chosen by the analyst.
- **Video:** the soundtrack is read directly; a video without sound is refused with a clear message.
- **Background jobs:** long recordings are processed one at a time on the server, with a progress bar. You can leave the page, and a job in progress survives an AIVS restart.
- **Review:** each segment has its start and end time. Clicking a time plays the recording from there. You can search, correct a segment (the machine text and every correction are kept and audited), download TXT, SRT, VTT or JSON, and add selected segments to the case as evidence, optionally linked to a claim.
- **Honest output:** every transcript is labelled *machine-generated*. Silence and noise are skipped by voice activity detection, so silence gives no text. Passages that are probably not speech are dropped. Low-confidence or typical "noise" text (for example "thank you for watching") is kept but marked **unclear**. Evidence made from a transcript says whether it includes unchecked machine text.
- **Originals:** the uploaded file is never changed. The transcript records the recording's SHA-256. The server deletes its copy when the job finishes.
- **Limits:** 500 MB and 120 minutes per recording (`TRANSCRIBE_MAX_MB`; `TRANSCRIBE_MAX_MINUTES` on the server).
- **Availability:** the Start page shows Upload files as **Available** only after AIVS has reached the service and the service has accepted its token.

Setup: see `transcriber/README.md` for the step-by-step guide, with Windows and Ubuntu commands separated. In short:

1. Copy the `transcriber` folder to the server.
2. `sudo bash status.sh` shows what is already installed.
3. `sudo AIVS_ALLOW_FROM=<AIVS PC address> bash install.sh` installs or repairs the service.
4. Run the real-model self-test.
5. Run `set-transcribe.bat` on the AIVS PC.
6. Restart AIVS.
7. `check-transcribe.bat` tests real uploads through AIVS: English, Kiswahili, video, silence, invalid files, timestamps, corrections, downloads and evidence.

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
npm run train:sentiment   # retrain and re-measure the sentiment classifier
npm run create-user -- jdoe "Jane Doe" analyst
npm run verify-audit      # check the hash-chained audit log
npm test                  # 157 API and library tests (node:test)
npm run test:e2e          # 192-check browser test of the full workflow (needs Playwright + Chromium;
                          # set CHROMIUM_PATH to use an installed Chromium)
```

## Documentation

- `docs/DEMO-GUIDE.md`: a 15-minute academic demonstration, step by step, with expected questions.
- `docs/TESTING-REPORT.md`: what was tested, how, and the actual results and limits.
- `notebooks/AIVS_Information_Operations_AI_Demo.ipynb`: Google Colab notebook for all three services. It covers data, preprocessing, the sentiment model, claim classification and evidence retrieval, topics, the map, anomaly detection, evaluation and limitations.
- `notebooks/AIVS_AI_Watchlist_Demo.ipynb`: Google Colab notebook on the watchlist logic.
- `docs/AUDIT.md`: audit of the earlier single-file prototype and what changed.
- `docs/ARCHITECTURE.md`: stack, data model, components and how to scale.
- `docs/SECURITY.md`: access control, data handling, AI safeguards and the deployment checklist.
- `docs/DEPLOY.md`: running AIVS on a virtual server with HTTPS (Docker + Caddy, or systemd).

## Limits (pilot)

- Single server with SQLite. See `docs/ARCHITECTURE.md` for moving to PostgreSQL and object storage.
- Video is compared through frames. The video container's metadata is not read (there is no ffprobe dependency).
- Speech-to-text supports English and Kiswahili only. Accuracy depends on the recording; on a CPU, expect roughly real-time to a few times slower with the `small` model. Always check against the recording.
- The text rules (claim extraction, dates, places) are rule-based. Treat their output as a starting point.
- Thresholds were tuned on a small synthetic set.

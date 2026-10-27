# AIVS 1.21.1: testing report

Date: 26 October 2026. Environment: the development workspace (Linux, Node 22, Chromium via Playwright, Python 3 with scikit-learn 1.9). Every figure below is from an actual run there. None of it is copied from elsewhere or estimated.

## 1. How to repeat the tests

```bash
npm test                 # API and library tests (node:test)
npm run test:e2e         # browser test of the whole application (Playwright + Chromium)
npm run train:sentiment  # retrains the sentiment model and checks that the stored model reproduces its scores
```

Run the notebooks in Google Colab (*Runtime → Run all*) or with `jupyter nbconvert --execute`.

## 2. Results

| Suite | What it covers | Result |
|---|---|---|
| `npm test` | 157 tests: users, roles, cases, claims, evidence, verdicts, approval, reports, audit chain, uploads, OCR, documents, social media lookup and link extraction, datasets, coordination indicators, the AI Watchlist, the trained model, migrations | **157 passed, 0 failed** |
| `npm run test:e2e` | 192 checks in a real browser: every page and menu, the four guided steps, link extraction, upload, the review queue, reports (PDF), the AI Watchlist workflow, phone-width layout, every visible button wired, no browser errors | **192 passed, 0 failed** |
| `AIVS_AI_Watchlist_Demo.ipynb` | Watchlist logic end to end (33 cells) | **ran with no errors**, 5 charts |
| `AIVS_Information_Operations_AI_Demo.ipynb` | All three services' AI end to end (33 cells), including the map | **ran with no errors**, 5 charts and an interactive map |

## 3. The AI Watchlist workflow (test/watch-datasets.test.js, 8 tests)

Each step below runs against a fresh server.

| Step | Checked | Result |
|---|---|---|
| Create watchlist | name, description, keywords; analysts cannot manage; at least one keyword | passed |
| Edit, save, reload | definition and thresholds kept | passed |
| Preview, then activate | activation refused before a preview; a dataset-only watchlist needs no API keys | passed |
| Empty and invalid files | an empty CSV and a corrupt Excel file are refused; nothing is monitored | passed |
| Upload a dataset | the CSV `training/watch-demo-posts.csv` (1,000 posts) is imported and checked automatically | 1,000 checked, 577 matching |
| Alerts match real records | each alert's supporting posts exist and fall in the planted periods; no alerts on the background posts | passed (9 alerts in 5 categories) |
| No duplicates | analysing again and re-importing the same posts add no matches or alerts | passed |
| Analytics | trend, sentiment and top terms add up to the matched posts | passed |
| Acknowledge, dismiss, verify | dismiss needs a reason; "Verify a claim" opens a case carrying the alert as a suggested lead | passed |
| Pause and delete | a paused watchlist ignores new imports; delete keeps history and closes open alerts | passed |

The alerts raised for the synthetic election data, all inside the planted periods:

- keyword threshold, twice;
- unusual spike, twice: 6 October 14:00 with high severity, and 5 October 10:00;
- emerging narrative, twice ("ballot boxes burned" and the "#ElectionTruth" message);
- repeated messages, twice;
- coordination indicator, once: 12 accounts within 5.5 minutes, high severity.

**Speed:** 20,000 posts imported and checked in 6.2 seconds; the watchlist's share was about 1.6 seconds.

## 3a. Dashboard figures (1.21.1, test/watch-counters.test.js and the browser test)

These checks run on a fresh server. The figures are read exactly as the dashboard reads them.

| Step | Active watchlists | Open alerts | Monitoring line |
|---|---|---|---|
| Fresh server | 0 | 0 | "No watchlist is active…" |
| Watchlist created (draft) | 0 | 0 | unchanged |
| Previewed and activated | **1** | 0 | "…but no data source" |
| 30 non-matching posts imported | 1 | 0 | 30 checked, 0 matching |
| SYNTHETIC election dataset imported (1,000 posts, planted spike) | 1 | **9** = rows saved in `watch_alerts` | "Monitoring active · last analysis … · 1,000 posts checked, 577 matching" |
| Analysed again | 1 | 9 (no duplicates) | unchanged |
| Paused | 0 | 9 | — |

**Bug found and fixed:** the dashboard counted `w.active`, a field that does not exist, so it always showed 0 active watchlists.

## 4. Models: measured scores (held-out test data)

| Model | Data | Test | Result | Baseline |
|---|---|---|---|---|
| Sentiment in the application (`models/sentiment-tweeteval-lr-1`, JavaScript) | TweetEval, 45,615 training tweets | 12,284 test tweets | accuracy 59.5%, macro-F1 59.4% | old word list 55.9% / 49.2%; majority class 48.3% |
| Sentiment in the notebook (scikit-learn, same method) | same | same | accuracy 60.2%, macro-F1 59.8% | majority 48.3% |
| Truth from wording alone, 6 labels (notebook) | LIAR, 10,269 training statements | 1,283 test statements | accuracy 23.6% | majority 20.8%; chance 16.7% |
| Truth from wording alone, 2 classes (notebook) | same | same | accuracy 63.1% | majority 56.7% |
| Evidence retrieval points the same way (notebook) | LIAR | 500 test statements | 55.0% (70% for close matches, 10 cases) | 50% |
| Watchlist alerts against planted answers (notebook) | synthetic, 1,000 posts | 2 planted events | 7 alerts, all in planted periods; both events found | — |

**Disclosure:** for the application's sentiment model, the test score of a first run was seen before the learning-rate grid was widened. The results file records this.

## 5. Not tested, or not working here

- **Pretrained transformer (DistilBERT):** the notebook cells for it were skipped, because Hugging Face cannot be reached from the development workspace. In Colab they normally run. It is not inside the application for the same reason.
- **Live platform APIs** (X, YouTube, Facebook, Instagram, Telegram, Reddit, Bluesky, TikTok): tested only against simulated services. Their live tests need the owner's keys (`set-api-keys.bat`, then *Test connection*).
- **Mention Watch scheduler on live sources:** tested with simulated services only.
- **On the owner's PC:** the PC server was started before the 1.21 files arrived, so it was still running the old code. It must be restarted. From 1.21.1, a banner warns when the server and the pages differ. Database migration 13 runs at first start and keeps a backup copy.
- **Real-world accuracy** of the watchlist rules on Kenyan posts has not been measured: the planted data shows the rules work as designed, not how often real alerts are useful.

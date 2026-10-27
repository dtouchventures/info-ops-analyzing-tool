# AIVS: academic demonstration guide (about 15 minutes)

**Goal:** show three connected AI services working on real components:

1. a dataset is uploaded;
2. the AI Watchlist flags unusual activity;
3. a claim from the alert goes to Verify Information;
4. a reviewed report comes out.

Then explain the data, the models and their limits with the notebooks.

## Before the session (10 minutes, the day before)

1. Start AIVS with `start-for-reviewers.bat` (or `start-windows.bat` if only you present). Sign in as an **administrator or reviewer**. Keep a second account (reviewer) ready for the approval step: approval must come from a different person.
2. If earlier demo data is present, either use it or start from a fresh copy of the `data` folder. The live database is never deleted.
3. Open both notebooks in Google Colab and press *Runtime → Run all* once (about 1 minute), so the charts are ready:
   - `notebooks/AIVS_Information_Operations_AI_Demo.ipynb`
   - `notebooks/AIVS_AI_Watchlist_Demo.ipynb`
4. Have the files ready: `training/watch-demo-posts.csv` (1,000 synthetic posts) and `docs/TESTING-REPORT.md`.

## The demonstration

| Min | Show | Say |
|---|---|---|
| 0–1 | **Dashboard** | "Three services. All figures come from the database; nothing is sample data unless it is labelled synthetic." |
| 1–3 | **AI Watchlist → Watchlists → New watchlist**: name *Election Misinformation*; keywords `election`, `IEBC`, `voting`, `ballot`; all datasets; 10 posts within 60 minutes. Then **Preview matches → Activate**. | "A watchlist is a topic to monitor. Thresholds are mine to set and are all documented." |
| 3–5 | **Social Media Analysis → Import**: upload `training/watch-demo-posts.csv`. Source: "AIVS synthetic demo data"; basis: "synthetic". | "On import, every active watchlist checks the new posts automatically. This is historical analysis of the posting times in the file, not live monitoring." Point out the message saying how many posts matched and how many alerts were raised. |
| 5–8 | **AI Watchlist → Alerts** | Walk through these, each with its *Why this alert* and *Recommended action*:<br>• the **unusual spike** on 6 Oct 14:00: 12× the average and 14.6 standard deviations above it, high severity;<br>• the **emerging narrative** "ballot boxes burned";<br>• the **coordination indicator**: 12 accounts within 5.5 minutes, with the same hashtag and link.<br>"This is a signal for review, not proof: people share news together." |
| 8–9 | Open the watchlist: the **Analysis** panel | Posts per day, spike windows in red, sentiment (the model trained on 45,615 tweets), top keywords, recurring narratives with examples, alert history. |
| 9–11 | On the spike alert, **Verify a claim**: pick "Ballot boxes burned in …", then open the case. | Follow the 4 steps. **Step 2:** the claims, the content analysis, and the alert as a suggested lead. Accept it. **Step 3:** a verdict from the four (with only this lead, *Insufficient evidence* or *Not verifiable*), why, and what is uncertain. "A model never decides the verdict; evidence does." |
| 11–12 | **Step 4: Submit.** Sign in as the second reviewer, **approve**, then **Download PDF**. | "Independent approval, an audit trail, and a frozen report with a fingerprint." |
| 12–15 | **Colab notebook** | **Section 4:** the sentiment model's test scores and confusion matrix.<br>**Section 5a:** LIAR, a model guessing truth from wording is close to chance. "That's why verdicts need evidence."<br>**Section 5b:** evidence retrieval.<br>**Section 7:** the map.<br>**Section 8:** the spike chart. |

## Questions to expect, and honest answers

- **"Is it real-time?"** The watchlist runs on uploaded datasets now, which is historical analysis. Live monitoring works through official platform APIs once keys are added with `set-api-keys.bat`; each platform is tested under *AI Watchlist → Sources and status*.
- **"What AI does it use?"**
  - A sentiment classifier trained here on TweetEval: TF-IDF features and logistic regression, 59.5% accuracy on 12,284 test tweets, compared with 55.9% for the old word list.
  - TF-IDF + k-means for narratives; term-burst detection for emerging narratives.
  - Statistical anomaly detection: a rolling baseline with a ratio and a standard-deviation rule.
  - MinHash/Jaccard similarity for repeated messages.
  - Optionally, a local language model (Ollama) for the assistant.
  - A pretrained DistilBERT appears in the notebook (it runs in Colab).
- **"How do you know it works?"**
  - 157 automated tests and 192 browser checks pass.
  - The planted synthetic data shows every alert pointing at the planted events and none at the background.
  - Measured test scores are shown under *Settings → AI models*.
- **"What are the limits?"**
  - The training data is English.
  - The synthetic data is not evidence about Kenya.
  - Sentiment and coordination signals are never proof.
  - Accuracy on real Kenyan posts has not been measured yet.
- **"Privacy?"** Only public or permitted data is used. No individual profiling. Every action is audited.

## If something goes wrong

| Problem | What to do |
|---|---|
| A yellow banner says the server is still running the old version | Close the AIVS window and run `start-windows.bat` again. |
| No alerts after import | Check that the watchlist is **Active** and monitors "All imported datasets". Then use **Analyse datasets now**. |
| "Preview the matches first" | Press **Preview matches**, then **Activate**. |
| The PDF won't download | Use *Open in browser* (HTML), then print to PDF. |
| Colab download fails | Re-run the first cells. GitHub is sometimes slow; wait a minute. |

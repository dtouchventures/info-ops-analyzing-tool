// Trained models (AIVS 1.21): the shipped sentiment classifier loads, predicts and explains; its stored evaluation is
// internally consistent; the training code learns a separable toy problem; the API reports models and runs them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, login } from "./helpers.js";
import { TextClassifier, buildVocabulary, vectorise, train, scores, evaluate, tokens } from "../server/ai/textclf.js";
import { classifySentiment, languageGuess } from "../server/lib/social-analysis.js";

const M = path.resolve("models/sentiment-tweeteval-lr-1.json"), E = path.resolve("models/sentiment-tweeteval-lr-1.eval.json");
let S, ana;
before(async () => { S = await startServer(); ana = await login(S.base, "ana"); });
after(async () => { await S.close(); });

test("the shipped sentiment model loads and gives sensible, explained predictions", () => {
  const m = TextClassifier.load(M);
  assert.deepEqual(m.m.labels, ["negative", "neutral", "positive"]);
  const pos = m.predict("I love this, the new hospital is great and the staff were so helpful"), neg = m.predict("Terrible service, I hate this, worst day ever");
  assert.equal(pos.label, "positive"); assert.equal(neg.label, "negative");
  assert.ok(Math.abs(Object.values(pos.probabilities).reduce((a, b) => a + b, 0) - 1) < 0.01, "probabilities sum to 1");
  assert.ok(m.explain("Terrible service, I hate this").some(t => /hate|terrible/.test(t.term)), "the explanation names the words that weighed most");
  assert.ok(tokens("this is not good").includes("neg_good"), "negation is marked");
});

test("the stored evaluation is internally consistent and honest about its data", () => {
  const e = JSON.parse(fs.readFileSync(E, "utf8")), cm = e.test.confusion_matrix.matrix, n = cm.flat().reduce((a, b) => a + b, 0);
  assert.equal(n, e.data.sizes.test); assert.equal(n, 12284, "the official TweetEval sentiment test split");
  assert.equal(Math.round(cm.reduce((a, r, i) => a + r[i], 0) / n * 1e4) / 1e4, e.test.accuracy, "accuracy follows from the confusion matrix");
  assert.ok(e.test.accuracy > e.baselines.majority_class.accuracy, "better than always guessing the most common label");
  assert.match(e.data.source, /github\.com\/cardiffnlp\/tweeteval/); assert.ok(e.data.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.ok(e.data.limitations.some(l => /Kiswahili/.test(l))); assert.match(e.selection.process_note, /test set had been seen/);
  const m = JSON.parse(fs.readFileSync(M, "utf8")); assert.equal(m.evaluation.test.accuracy, e.test.accuracy);
});

test("training code: learns a separable toy problem and the metrics are computed correctly", () => {
  const X = ["good great", "great fine good", "bad awful", "awful terrible bad", "good fine", "terrible bad"], y = [1, 1, 0, 0, 1, 0];
  const v = buildVocabulary(X, { minDf: 1 }), idx = new Map(v.terms.map((t, i) => [t, i])), V = X.map(x => vectorise(x, idx, v.idf));
  const m = train(V, y, 2, v.terms.length, { epochs: 30, lr: 0.1 }), pred = V.map(x => { const s = scores(x, m.W, m.b); return s.indexOf(Math.max(...s)); });
  assert.deepEqual(pred, y);
  const ev = evaluate([0, 0, 1, 1], [0, 1, 1, 1], ["a", "b"]);
  assert.equal(ev.accuracy, 0.75); assert.deepEqual(ev.confusion_matrix.matrix, [[1, 1], [0, 2]]); assert.equal(ev.per_class[1].precision, 0.6667); assert.equal(ev.per_class[0].recall, 0.5);
});

test("sentiment uses the trained model for English and the word list for Kiswahili; the API reports and runs models", async () => {
  assert.equal(languageGuess("Serikali ya kaunti imefungua kisima kipya na watu wamefurahi sana"), "sw"); assert.equal(languageGuess("The county opened a new borehole"), "en");
  const en = classifySentiment("Thank you county, the water project is working well"); assert.equal(en.method, "sentiment-tweeteval-lr-1"); assert.equal(en.label, "positive");
  const sw = classifySentiment("Asante kaunti, mradi wa maji ni mzuri sana na watu wamefurahi"); assert.equal(sw.method, "lexicon-1"); assert.match(sw.basis, /Kiswahili/);
  const r = (await ana.get("/api/ai/models")).body;
  assert.equal(r.models[0].id, "sentiment-tweeteval-lr-1"); assert.equal(r.models[0].loaded, true); assert.ok(r.models[0].test.confusion_matrix);
  const t = (await ana.post("/api/ai/models/sentiment/try", { text: "This is the worst flooding we have seen, people are angry" })).body;
  assert.equal(t.label, "negative"); assert.ok(t.explanation.length > 0); assert.equal((await ana.post("/api/ai/models/sentiment/try", { text: "" })).status, 400);
});

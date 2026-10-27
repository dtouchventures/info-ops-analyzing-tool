// Text classification without external services: TF-IDF features (words and word pairs) and a multinomial
// logistic regression, trained by scripts/train-sentiment.js on a public labelled dataset and stored as JSON in
// models/. Training, evaluation and prediction all use the code in this file, so the measured scores describe
// exactly what the server runs. Pure JavaScript: no Python, no GPU, no network at prediction time.
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- preprocessing (shared by training and prediction)
export function normalise(text) {
  return String(text || "").toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, " http ")
    .replace(/(^|\s)@\w+/g, " @user ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/(.)\1{3,}/g, "$1$1$1");                  // "soooooo" → "sooo"
}
const NEG = new Set(["not", "no", "never", "don't", "dont", "isn't", "isnt", "wasn't", "wasnt", "can't", "cant", "won't", "wont", "didn't", "didnt", "doesn't", "doesnt", "aren't", "arent", "nothing", "nobody", "hardly", "si", "hapana", "hakuna", "sio", "siyo"]);
export function tokens(text) {
  const t = normalise(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*|[#@][\p{L}\p{N}_]+|[!?]|\p{Extended_Pictographic}/gu) || [];
  // mark the three words after a negation (a standard trick for sentiment): "not good" → "not neg_good"
  const out = []; let neg = 0;
  for (const w of t) { if (/^[!?]$/.test(w)) { neg = 0; out.push(w); continue; } out.push(neg > 0 ? "neg_" + w : w); neg = NEG.has(w) ? 3 : Math.max(0, neg - 1); }
  return out;
}
export function features(text) {
  const t = tokens(text), f = new Map();
  for (let i = 0; i < t.length; i++) { f.set(t[i], (f.get(t[i]) || 0) + 1); if (i + 1 < t.length) { const b = t[i] + " " + t[i + 1]; f.set(b, (f.get(b) || 0) + 1); } }
  return f;
}

// ---------------------------------------------------------------- vectoriser
export function buildVocabulary(texts, { minDf = 3, maxFeatures = 40000 } = {}) {
  const df = new Map();
  for (const x of texts) for (const k of features(x).keys()) df.set(k, (df.get(k) || 0) + 1);
  const terms = [...df].filter(([, n]) => n >= minDf).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, maxFeatures);
  const N = texts.length;
  return { terms: terms.map(([k]) => k), idf: terms.map(([, n]) => Math.round(Math.log((1 + N) / (1 + n)) * 1e4) / 1e4 + 1) };
}
export function vectorise(text, index, idf) {
  const v = [];
  for (const [k, n] of features(text)) { const i = index.get(k); if (i !== undefined) v.push([i, (1 + Math.log(n)) * idf[i]]); }
  const norm = Math.sqrt(v.reduce((a, [, x]) => a + x * x, 0)) || 1;
  return v.map(([i, x]) => [i, x / norm]);
}

// ---------------------------------------------------------------- multinomial logistic regression
const softmax = z => { const m = Math.max(...z), e = z.map(x => Math.exp(x - m)), s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); };
export function scores(vec, W, b) { return b.map((bc, c) => { let s = bc; const w = W[c]; for (const [i, x] of vec) s += w[i] * x; return s; }); }

// Mini-batch gradient descent with Adam and L2 regularisation; deterministic (seeded shuffle).
export function train(X, y, K, D, { epochs = 8, lr = 0.05, l2 = 1e-4, batch = 64, seed = 42, classWeights = null, log = () => {} } = {}) {
  const W = Array.from({ length: K }, () => new Float64Array(D)), b = new Float64Array(K);
  const mW = W.map(() => new Float64Array(D)), vW = W.map(() => new Float64Array(D)), mb = new Float64Array(K), vb = new Float64Array(K);
  let rnd = seed >>> 0; const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const order = X.map((_, i) => i), B1 = 0.9, B2 = 0.999, EPS = 1e-8; let t = 0;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let loss = 0;
    for (let s = 0; s < order.length; s += batch) {
      const idx = order.slice(s, s + batch), gW = W.map(() => new Map()), gb = new Float64Array(K);
      for (const n of idx) {
        const p = softmax(scores(X[n], W, b)), cw = classWeights ? classWeights[y[n]] : 1;
        loss -= Math.log(Math.max(p[y[n]], 1e-12)) * cw;
        for (let c = 0; c < K; c++) { const g = (p[c] - (c === y[n] ? 1 : 0)) * cw / idx.length; gb[c] += g; for (const [i, x] of X[n]) gW[c].set(i, (gW[c].get(i) || 0) + g * x); }
      }
      t++; const a = lr * Math.sqrt(1 - B2 ** t) / (1 - B1 ** t);
      for (let c = 0; c < K; c++) {
        // sparse ("lazy") Adam with L2 applied to the touched weights
        for (const [i, g0] of gW[c]) { const g = g0 + l2 * W[c][i]; mW[c][i] = B1 * mW[c][i] + (1 - B1) * g; vW[c][i] = B2 * vW[c][i] + (1 - B2) * g * g; W[c][i] -= a * mW[c][i] / (Math.sqrt(vW[c][i]) + EPS); }
        mb[c] = B1 * mb[c] + (1 - B1) * gb[c]; vb[c] = B2 * vb[c] + (1 - B2) * gb[c] * gb[c]; b[c] -= a * mb[c] / (Math.sqrt(vb[c]) + EPS);
      }
    }
    log(`epoch ${ep + 1}/${epochs}: mean training loss ${(loss / order.length).toFixed(4)}`);
  }
  return { W, b };
}

// ---------------------------------------------------------------- evaluation
export function evaluate(yTrue, yPred, labels) {
  const K = labels.length, cm = Array.from({ length: K }, () => new Array(K).fill(0));
  yTrue.forEach((t, i) => cm[t][yPred[i]]++);
  const per = labels.map((l, c) => {
    const tp = cm[c][c], fp = cm.reduce((a, r, i) => a + (i === c ? 0 : r[c]), 0), fn = cm[c].reduce((a, x, j) => a + (j === c ? 0 : x), 0);
    const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
    return { label: l, precision: round(p), recall: round(r), f1: round(p + r ? 2 * p * r / (p + r) : 0), support: cm[c].reduce((a, b) => a + b, 0) };
  });
  const acc = yTrue.filter((t, i) => t === yPred[i]).length / yTrue.length, mean = k => round(per.reduce((a, x) => a + x[k], 0) / K);
  return { n: yTrue.length, accuracy: round(acc), macro: { precision: mean("precision"), recall: mean("recall"), f1: mean("f1") }, per_class: per, confusion_matrix: { labels, rows_are: "true label", columns_are: "predicted label", matrix: cm } };
}
const round = x => Math.round(x * 10000) / 10000;

// ---------------------------------------------------------------- the stored model
export function pack(meta, vocab, W, b) {
  // weights rounded to 4 decimals and stored per class; terms whose weights are all ~0 are kept so indices stay aligned
  return { ...meta, terms: vocab.terms, idf: vocab.idf, bias: [...b].map(x => round(x)), weights: W.map(w => Array.from(w, x => Math.round(x * 1e4) / 1e4)) };
}
export class TextClassifier {
  constructor(m) { this.m = m; this.index = new Map(m.terms.map((t, i) => [t, i])); }
  static load(file) { return new TextClassifier(JSON.parse(fs.readFileSync(file, "utf8"))); }
  predict(text) {
    const v = vectorise(text, this.index, this.m.idf), p = softmax(scores(v, this.m.weights, this.m.bias)), k = p.indexOf(Math.max(...p));
    return { label: this.m.labels[k], probability: round(p[k]), probabilities: Object.fromEntries(this.m.labels.map((l, i) => [l, round(p[i])])), known_terms: v.length, method: this.m.id };
  }
  // the words and word pairs that pushed this text towards the predicted label (an explanation of the model, not of the truth)
  explain(text, n = 6) {
    const v = vectorise(text, this.index, this.m.idf), p = this.predict(text), c = this.m.labels.indexOf(p.label);
    return v.map(([i, x]) => ({ term: this.m.terms[i], weight: round(x * (this.m.weights[c][i] - Math.max(...this.m.weights.map((w, j) => j === c ? -Infinity : w[i])))) }))
      .filter(t => t.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, n);
  }
}

// models shipped in models/ (loaded once; absent files simply mean "not available")
const cache = new Map();
export function loadModel(dir, id) {
  if (cache.has(id)) return cache.get(id);
  const f = path.join(dir, `${id}.json`); let m = null;
  try { if (fs.existsSync(f)) m = TextClassifier.load(f); } catch (e) { console.warn(`[ai] model ${id} could not be loaded: ${e.message}`); }
  cache.set(id, m); return m;
}

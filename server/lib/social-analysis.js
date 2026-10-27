// Social media content analysis for post datasets: sentiment, themes, keyword clusters (topics), keyword and
// hashtag frequency, narrative change over time, public engagement, geography and checkable claims.
// Everything here is computed from the stored posts. Methods are rule-based and deterministic unless an
// analyst runs the optional local AI (Ollama) step, which is recorded per post. Results are estimates for an
// analyst, never findings: the limitations are returned with every result and printed in reports.
import crypto from "node:crypto";
import { extractClaims, classifyStatement, redFlags, PLACES } from "../../shared/text.js";
import { normText } from "./io.js";

// ---------------------------------------------------------------- sentiment (English + Kiswahili lexicon)
// A small, transparent lexicon with negation and intensifiers. It is a baseline, not a language model:
// sarcasm, slang and context are missed. Its measured accuracy on AIVS's labelled test sentences is reported
// by sentimentEvaluation(); that figure does not carry over to real posts.
export const SENTIMENT_METHOD = "lexicon-1";
const POS = `good great excellent amazing awesome wonderful love loved loves liked happy glad proud thank thanks thankful grateful congratulations congrats
  best better improve improved improving improvement success successful win won winning safe peace peaceful calm support supported helpful help helped fair
  progress progressive hope hopeful positive beautiful brilliant fantastic nice enjoy enjoyed welcome welcomed relief resolved fixed restored working affordable
  impressive appreciate appreciated respect strong recovery recovered celebrate celebrating delighted excited trust reliable clean honest transparent
  nzuri bora safi poa asante shukrani hongera furaha penda napenda tunapenda upendo amani salama msaada imeboreshwa maendeleo bahati heri mzuri vizuri sawa
  tumefurahi nimefurahi fahari tumaini imani shangwe ushindi tumeshinda`;
const NEG = `bad terrible awful horrible worst worse hate hated hates angry anger sad sadly disappointed disappointing disappointment fail failed failure failing
  corrupt corruption scandal stolen steal stealing theft fraud scam scams lies lie lying liar fake shame shameful disgrace disgraceful useless poor problem problems
  crisis danger dangerous unsafe attack attacked attacks killed kill killing dead death deaths violence violent fear afraid worried worry worrying broken delay delayed
  delays expensive unfair injustice protest protests chaos suffering suffer suffered hunger shortage shortages outage blackout loss losses abandoned neglected
  incompetent arrogant betrayed rubbish nonsense pathetic mess frustrating frustrated annoying difficult impossible threat threats insecurity
  mbaya mbovu chuki hasira huzuni wizi mwizi wezi ufisadi rushwa uongo aibu hatari shida matatizo tatizo njaa vita ghasia hofu woga ubaguzi dhuluma kufa wamekufa
  ameuawa wameuawa mauaji gharama ghali uharibifu tumechoka nimechoka kero balaa`;
const NEGATORS = new Set("not no never none nobody nothing neither nor cannot cant can't dont don't doesnt doesn't didnt didn't isnt isn't wasnt wasn't arent aren't wont won't without hardly si sio siyo hapana hakuna bila wala".split(/\s+/));
const INTENS = new Set("very really so extremely totally absolutely truly too super highly sana kabisa mno zaidi".split(/\s+/));
const POSSET = new Set(POS.split(/\s+/).filter(Boolean)), NEGSET = new Set(NEG.split(/\s+/).filter(Boolean));
const POS_EMO = /[😀😃😄😁😊🙂😍🥰😘👍👏🙏🎉❤💚💯✅🔥]/gu, NEG_EMO = /[😡😠🤬😢😭😞😔😟😨😱👎💔🤮😤]/gu;
const tok = t => String(t || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[@#]/g, " ").split(/[^\p{L}\p{N}']+/u).filter(Boolean);

export function sentiment(text) {
  const w = tok(text); let pos = 0, neg = 0;
  for (let i = 0; i < w.length; i++) {
    const p = POSSET.has(w[i]), n = NEGSET.has(w[i]); if (!p && !n) continue;
    let v = 1, flip = false;
    for (let j = Math.max(0, i - 3); j < i; j++) { if (NEGATORS.has(w[j])) flip = !flip; if (INTENS.has(w[j])) v = 1.5; }
    if ((p && !flip) || (n && flip)) pos += v; else neg += v;
  }
  pos += (String(text).match(POS_EMO) || []).length * 0.8; neg += (String(text).match(NEG_EMO) || []).length * 0.8;
  const total = pos + neg;
  if (!total) return { label: "neutral", score: 0, confidence: 0.5, method: SENTIMENT_METHOD, basis: "no sentiment words found" };
  const score = Math.round(((pos - neg) / total) * 100) / 100;
  if (pos > 0 && neg > 0 && Math.min(pos, neg) / Math.max(pos, neg) >= 0.5) return { label: "mixed", score, confidence: 0.5, method: SENTIMENT_METHOD, basis: `positive and negative words (${pos} / ${neg})` };
  const confidence = Math.round(Math.min(0.9, 0.5 + 0.12 * total * Math.abs(score)) * 100) / 100;
  return { label: score > 0 ? "positive" : "negative", score, confidence, method: SENTIMENT_METHOD, basis: `${score > 0 ? "positive" : "negative"} words outweigh the others (${pos} / ${neg})` };
}
export const SENTIMENT_LABELS = { positive: "Positive", negative: "Negative", neutral: "Neutral", mixed: "Mixed or uncertain" };

// The trained classifier (models/sentiment-tweeteval-lr-1.json, see scripts/train-sentiment.js) is used for
// English text when it is present; Kiswahili text, and every text when the model file is missing, use the word list
// above. Each result names the method that produced it.
let SENT_MODEL = null;
export function useSentimentModel(m) { SENT_MODEL = m || null; }
export const sentimentModel = () => SENT_MODEL;
const SW_WORDS = new Set("na ya wa kwa ni za la katika hii huu hiyo huo sana hakuna kama lakini pia wao sisi wewe mimi yeye kuna watu leo serikali kaunti habari tena bado kwamba ili hata baada kabla".split(" "));
const EN_WORDS = new Set("the and is of to in for on that this with are was it be as at by from have has not you we they he she will an or but".split(" "));
export function languageGuess(text) {
  const w = tok(text); let sw = 0, en = 0; for (const x of w) { if (SW_WORDS.has(x)) sw++; if (EN_WORDS.has(x)) en++; }
  return sw > en ? "sw" : en > 0 || !sw ? "en" : "sw";
}
export function classifySentiment(text) {
  if (!SENT_MODEL || languageGuess(text) === "sw") { const s = sentiment(text); return SENT_MODEL ? { ...s, basis: `${s.basis}; word list used because the text looks like Kiswahili, which the trained model does not cover` } : s; }
  const p = SENT_MODEL.predict(text), pr = p.probabilities, top = SENT_MODEL.explain(text, 4).map(t => `“${t.term.replace(/^neg_/, "not ")}”`).join(", ");
  return { label: p.label, score: Math.round(((pr.positive || 0) - (pr.negative || 0)) * 100) / 100, confidence: p.probability, method: p.method,
    probabilities: pr, basis: `trained classifier: ${Math.round(p.probability * 100)}% ${p.label}${top ? `; words that weighed most: ${top}` : ""}` };
}

// ---------------------------------------------------------------- themes (rule-based, English + Kiswahili)
export const THEMES = {
  security: ["Security and defence", "security attack attacks attacked police officers kdf military army soldiers troops militants terror terrorist terrorism shabaab bandit bandits banditry insecurity gunmen killed usalama polisi jeshi wanajeshi shambulio majambazi magaidi"],
  health: ["Health", "health hospital hospitals clinic clinics malaria cholera vaccine vaccines vaccination doctors nurses disease diseases outbreak medicine drugs covid afya hospitali zahanati ugonjwa magonjwa chanjo madaktari dawa"],
  politics: ["Elections and politics", "election elections vote votes voting voters iebc ballot campaign mp mps senator governor president parliament politician politicians party uchaguzi kura siasa rais gavana bunge mbunge chama"],
  economy: ["Economy and prices", "price prices fuel tax taxes jobs unemployment inflation shilling budget loan loans debt salary salaries cost market bei mafuta kodi ajira uchumi mshahara deni soko"],
  disaster: ["Disaster and weather", "flood floods flooding drought landslide fire rain rains storm famine displaced mafuriko ukame mvua moto njaa maporomoko"],
  services: ["Water, roads and power", "water borehole road roads power electricity outage blackout project projects bridge sewage maji barabara umeme mradi daraja"],
  education: ["Education", "school schools fees students pupils teachers exam exams university college shule wanafunzi walimu karo mtihani chuo"],
  scams: ["Scams and fraud", "scam scams fraud fraudster mpesa m-pesa paybill prize lottery investment registration fee guaranteed tapeli utapeli tuma lipa"],
  sports: ["Sports and entertainment", "match football goal goals league team players music concert festival film mechi mpira timu muziki tamasha"]
};
const THEME_SETS = Object.fromEntries(Object.entries(THEMES).map(([k, [, words]]) => [k, new Set(words.split(/\s+/))]));
export function themesOf(text) { const w = new Set(tok(text)); return Object.keys(THEME_SETS).filter(k => [...THEME_SETS[k]].some(x => w.has(x))); }

// ---------------------------------------------------------------- places named in the text (inferred, not the poster's location)
const TOWNS = { Eldoret: "Uasin Gishu", Thika: "Kiambu", Malindi: "Kilifi", Nanyuki: "Laikipia", Lodwar: "Turkana", Kitale: "Trans Nzoia", Naivasha: "Nakuru", Kakuma: "Turkana", Dadaab: "Garissa", Moyale: "Marsabit", Watamu: "Kilifi", Ruiru: "Kiambu", Kikuyu: "Kiambu", Karatina: "Nyeri", Voi: "Taita-Taveta", Diani: "Kwale" };
export function placesIn(text) {
  const t = String(text || ""), out = new Set();
  for (const p of PLACES) if (new RegExp(`\\b${p.replace(/[-']/g, ".")}\\b`, "i").test(t)) out.add(p);
  for (const [town, county] of Object.entries(TOWNS)) if (new RegExp(`\\b${town}\\b`, "i").test(t)) out.add(county);
  return [...out];
}
// approximate centres of Kenya's 47 counties, for a schematic bubble map (not precise boundaries)
export const COUNTY_XY = { Mombasa: [-4.04, 39.66], Kwale: [-4.18, 39.45], Kilifi: [-3.51, 39.91], "Tana River": [-1.65, 39.65], Lamu: [-2.27, 40.9], "Taita-Taveta": [-3.4, 38.56], "Taita Taveta": [-3.4, 38.56], Garissa: [-0.45, 39.65], Wajir: [1.75, 40.06], Mandera: [3.94, 41.86],
  Marsabit: [2.33, 37.98], Isiolo: [0.35, 37.58], Meru: [0.05, 37.65], "Tharaka-Nithi": [-0.3, 37.8], "Tharaka Nithi": [-0.3, 37.8], Embu: [-0.53, 37.45], Kitui: [-1.37, 38.01], Machakos: [-1.52, 37.26], Makueni: [-1.8, 37.62], Nyandarua: [-0.18, 36.52], Nyeri: [-0.42, 36.95],
  Kirinyaga: [-0.5, 37.28], "Murang'a": [-0.72, 37.15], Muranga: [-0.72, 37.15], Kiambu: [-1.03, 36.83], Turkana: [3.12, 35.6], "West Pokot": [1.62, 35.12], Samburu: [1.22, 36.95], "Trans Nzoia": [1.02, 35.0], "Trans-Nzoia": [1.02, 35.0], "Uasin Gishu": [0.52, 35.27],
  "Elgeyo-Marakwet": [0.78, 35.5], "Elgeyo Marakwet": [0.78, 35.5], Nandi: [0.18, 35.13], Baringo: [0.47, 35.97], Laikipia: [0.2, 36.78], Nakuru: [-0.3, 36.07], Narok: [-1.08, 35.87], Kajiado: [-1.85, 36.78], Kericho: [-0.37, 35.28], Bomet: [-0.78, 35.34],
  Kakamega: [0.28, 34.75], Vihiga: [0.07, 34.72], Bungoma: [0.57, 34.56], Busia: [0.46, 34.11], Siaya: [0.06, 34.29], Kisumu: [-0.09, 34.77], "Homa Bay": [-0.53, 34.46], Migori: [-1.06, 34.47], Kisii: [-0.68, 34.77], Nyamira: [-0.57, 34.94], Nairobi: [-1.29, 36.82] };
const COUNTY_CANON = Object.fromEntries(Object.keys(COUNTY_XY).map(k => [k.toLowerCase().replace(/[^a-z]/g, ""), k.replace(/^Taita Taveta$/, "Taita-Taveta").replace(/^Tharaka Nithi$/, "Tharaka-Nithi").replace(/^Muranga$/, "Murang'a").replace(/^Trans-Nzoia$/, "Trans Nzoia").replace(/^Elgeyo Marakwet$/, "Elgeyo-Marakwet")]));
export const countyOf = s => { for (const part of String(s || "").split(/[,/;|]/)) { const k = part.toLowerCase().trim().replace(/\s+(county|city)$/, "").replace(/[^a-z]/g, ""); if (COUNTY_CANON[k]) return COUNTY_CANON[k]; } return null; };
const COUNTRIES = { ke: "Kenya", kenya: "Kenya", ug: "Uganda", uganda: "Uganda", tz: "Tanzania", tanzania: "Tanzania", so: "Somalia", somalia: "Somalia", et: "Ethiopia", ethiopia: "Ethiopia", ss: "South Sudan", "south sudan": "South Sudan", rw: "Rwanda", rwanda: "Rwanda", bi: "Burundi", burundi: "Burundi", cd: "DR Congo", "dr congo": "DR Congo", us: "United States", "united states": "United States", usa: "United States", gb: "United Kingdom", uk: "United Kingdom", "united kingdom": "United Kingdom" };
export const countryName = s => { const k = String(s || "").trim().toLowerCase(); return k ? COUNTRIES[k] || String(s).trim().slice(0, 60) : null; };

// ---------------------------------------------------------------- keywords and topic clusters
const STOP = new Set(`the a an and or but of to in on at for with by from is are was were be been being this that these those it its as has have had will would can could should may might not no yes their there they them he she his her we our you your i me my
  rt via amp just now also more most very than then so if what when where who how which why about into over after before all any some one two new get got like dont im its it's https http www com co ke
  na ya wa kwa ni la za katika hii huu hiyo hizo hao wao sisi wewe mimi yeye kama lakini pia sana tu bado leo jana kuna hakuna ili au ndio hapana kwamba hiki hili hivi hapa pale kila baada kabla sasa
  will said says say one two three new also people time day today year`.split(/\s+/));
const terms = t => tok(t).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
export function keywordCounts(texts, limit = 40) {
  const c = new Map(), docs = new Map(), bi = new Map();
  for (const t of texts) {
    const w = terms(t); const seen = new Set();
    for (const x of w) { c.set(x, (c.get(x) || 0) + 1); if (!seen.has(x)) { seen.add(x); docs.set(x, (docs.get(x) || 0) + 1); } }
    for (let i = 0; i + 1 < w.length; i++) { const k = `${w[i]} ${w[i + 1]}`; bi.set(k, (bi.get(k) || 0) + 1); }
  }
  return { keywords: [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([term, count]) => ({ term, count, posts: docs.get(term) })),
    phrases: [...bi.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([term, count]) => ({ term, count })) };
}
// k-means on TF-IDF vectors (cosine), deterministic farthest-point start; small clusters are left unclustered (0)
export function topicClusters(posts, { k: kWanted } = {}) {
  const docs = posts.map(p => terms(p.text)), df = new Map(); docs.forEach(d => new Set(d).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
  const N = docs.length, vocab = [...df.entries()].filter(([, n]) => n >= 2 && n <= Math.max(2, 0.5 * N)).sort((a, b) => b[1] - a[1]).slice(0, 3000).map(([w]) => w), V = new Map(vocab.map((w, i) => [w, i]));
  const vecs = docs.map(d => { const tf = new Map(); for (const w of d) if (V.has(w)) tf.set(V.get(w), (tf.get(V.get(w)) || 0) + 1); let norm = 0; const v = new Map(); for (const [i, f] of tf) { const x = (1 + Math.log(f)) * Math.log(N / df.get(vocab[i])); v.set(i, x); norm += x * x; } norm = Math.sqrt(norm) || 1; for (const [i, x] of v) v.set(i, x / norm); return v; });
  const usable = vecs.map((v, i) => v.size ? i : -1).filter(i => i >= 0);
  const k = Math.max(0, Math.min(kWanted || Math.round(Math.sqrt(usable.length / 8)), 12, Math.floor(usable.length / 3)));
  const assign = new Array(N).fill(0);
  if (k < 2) return { k: 0, assign, topics: [], vocabulary: vocab.length };
  const dot = (a, c) => { let s = 0; for (const [i, x] of a) s += x * (c[i] || 0); return s; };
  const dense = v => { const c = new Float64Array(vocab.length); for (const [i, x] of v) c[i] = x; return c; };
  let cents = [dense(vecs[usable.reduce((b, i) => (vecs[i].size > vecs[b].size ? i : b), usable[0])])];
  while (cents.length < k) { let best = -1, bd = -1; for (const i of usable) { const d = 1 - Math.max(...cents.map(c => dot(vecs[i], c))); if (d > bd) { bd = d; best = i; } } cents.push(dense(vecs[best])); }
  for (let it = 0; it < 12; it++) {
    let moved = 0;
    for (const i of usable) { let b = 0, bs = -1; cents.forEach((c, j) => { const s = dot(vecs[i], c); if (s > bs) { bs = s; b = j; } }); if (assign[i] !== b + 1) { moved++; assign[i] = b + 1; } }
    cents = cents.map((_, j) => { const c = new Float64Array(vocab.length); let n = 0; for (const i of usable) if (assign[i] === j + 1) { n++; for (const [t, x] of vecs[i]) c[t] += x; } const norm = Math.sqrt(c.reduce((a, x) => a + x * x, 0)) || 1; return c.map(x => x / norm); });
    if (!moved) break;
  }
  const topics = cents.map((c, j) => {
    const members = usable.filter(i => assign[i] === j + 1), top = [...c].map((x, t) => [t, x]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => vocab[t]);
    return { topic_no: j + 1, posts: members.length, terms: top };
  });
  // too small to be a topic: leave unclustered
  for (const t of topics) if (t.posts < 3) { for (let i = 0; i < N; i++) if (assign[i] === t.topic_no) assign[i] = 0; t.posts = 0; }
  const kept = topics.filter(t => t.posts > 0).sort((a, b) => b.posts - a.posts), renum = new Map(kept.map((t, i) => [t.topic_no, i + 1]));
  for (let i = 0; i < N; i++) assign[i] = renum.get(assign[i]) || 0;
  return { k: kept.length, assign, topics: kept.map(t => ({ ...t, topic_no: renum.get(t.topic_no), label: t.terms.slice(0, 3).join(" · ") })), vocabulary: vocab.length };
}

// ---------------------------------------------------------------- source reliability indicators for links in posts (categories, not scores)
const OFFICIAL = /(^|\.)go\.ke$|(^|\.)(knbs|iebc|cma|kra|kenyalaw|redcross)\.or\.ke$|(^|\.)centralbank\.go\.ke$|(^|\.)(who|un|unicef|reliefweb)\.(int|org)$/;
const FACTCHECK = /(^|\.)(africacheck\.org|pesacheck\.org|factcheck\.afp\.com|fullfact\.org|snopes\.com|politifact\.com)$/;
const NEWS = /(^|\.)(nation\.africa|standardmedia\.co\.ke|the-star\.co\.ke|citizen\.digital|kbc\.co\.ke|capitalfm\.co\.ke|tuko\.co\.ke|kenyans\.co\.ke|pd\.co\.ke|theeastafrican\.co\.ke|bbc\.(com|co\.uk)|reuters\.com|apnews\.com|aljazeera\.com|monitor\.co\.ug|thecitizen\.co\.tz)$/;
export function sourceCategory(url) {
  let h; try { h = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return { host: null, category: "unreadable link" }; }
  return { host: h, category: OFFICIAL.test(h) ? "official body" : FACTCHECK.test(h) ? "fact-checking organisation" : NEWS.test(h) ? "established news outlet" : /(bit\.ly|t\.co|tinyurl|goo\.gl|ow\.ly|rb\.gy)$/.test(h) ? "link shortener (destination hidden)" : "other or unknown site" };
}

// ---------------------------------------------------------------- per-post enrichment (stored), topics and claims
export function enrichPosts(db, datasetId) {
  const t0 = Date.now();
  const posts = db.prepare("SELECT id, text, posted_at, account, sentiment_method FROM io_posts WHERE dataset_id = ? ORDER BY posted_at, id").all(datasetId);
  const tc = topicClusters(posts);
  db.transaction(() => {
    const up = db.prepare("UPDATE io_posts SET sentiment = ?, sentiment_score = ?, sentiment_confidence = ?, sentiment_method = ?, themes = ?, mentioned_places = ?, topic_no = ? WHERE id = ?");
    const keepAi = db.prepare("UPDATE io_posts SET themes = ?, mentioned_places = ?, topic_no = ? WHERE id = ?");
    posts.forEach((p, i) => {
      const th = JSON.stringify(themesOf(p.text)), pl = JSON.stringify(placesIn(p.text));
      if (p.sentiment_method && p.sentiment_method.startsWith("ollama:")) keepAi.run(th, pl, tc.assign[i], p.id);   // an AI classification already reviewed in place is kept
      else { const s = classifySentiment(p.text); up.run(s.label, s.score, s.confidence, s.method, th, pl, tc.assign[i], p.id); }
    });
    const oldT = new Map(db.prepare("SELECT terms, label, label_source, summary FROM io_topics WHERE dataset_id = ?").all(datasetId).map(t => [t.terms, t]));
    db.prepare("DELETE FROM io_topics WHERE dataset_id = ?").run(datasetId);
    const it = db.prepare("INSERT INTO io_topics(dataset_id,topic_no,label,label_source,terms,posts,summary) VALUES (?,?,?,?,?,?,?)");
    for (const t of tc.topics) { const o = oldT.get(JSON.stringify(t.terms)), ai = o && o.label_source !== "terms"; it.run(datasetId, t.topic_no, ai ? o.label : t.label, ai ? o.label_source : "terms", JSON.stringify(t.terms), t.posts, ai ? o.summary : null); }
  })();
  const claims = extractDatasetClaims(db, datasetId, posts);
  const prev = JSON.parse(db.prepare("SELECT enrich_json FROM io_datasets WHERE id = ?").get(datasetId)?.enrich_json || "null");
  const meta = { generated_at: new Date().toISOString(), duration_ms: Date.now() - t0, sentiment_method: SENT_MODEL ? `${SENT_MODEL.m.id} (English) and ${SENTIMENT_METHOD} (Kiswahili)` : SENTIMENT_METHOD, topics: tc.k, vocabulary: tc.vocabulary, claims, posts: posts.length,
    ...(prev?.ai_summary ? { ai_summary: { ...prev.ai_summary, outdated: prev.ai_summary.posts !== posts.length || undefined } } : {}) };
  db.prepare("UPDATE io_datasets SET enriched_at = ?, enrich_json = ? WHERE id = ?").run(meta.generated_at, JSON.stringify(meta), datasetId);
  return meta;
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
// group identical checkable statements across posts; keep review decisions already made
export function extractDatasetClaims(db, datasetId, posts) {
  const groups = new Map();
  for (const p of posts) {
    for (const c of extractClaims(p.text, false)) {
      if (c.kind !== "statement" || classifyStatement(c.text).type !== "factual") continue;
      const key = normText(c.text); if (key.split(" ").length < 4) continue;
      const g = groups.get(key) || { text: c.text, post: p.text, ids: [], accounts: new Set(), first: p.posted_at, last: p.posted_at };
      g.ids.push(p.id); g.accounts.add(p.account); if (p.posted_at < g.first) g.first = p.posted_at; if (p.posted_at > g.last) g.last = p.posted_at; groups.set(key, g);
    }
  }
  const old = new Map(db.prepare("SELECT text_hash, status, case_id, note, reviewed_by, reviewed_at FROM io_claims WHERE dataset_id = ?").all(datasetId).map(r => [r.text_hash, r]));
  const kbq = db.prepare(`SELECT r.id, r.claim, r.label, r.label_raw, r.source_url, r.publisher, d.name dataset FROM kb_fts f JOIN kb_records r ON r.id = f.rowid JOIN kb_datasets d ON d.id = r.dataset_id
    WHERE kb_fts MATCH ? AND d.status = 'approved' AND d.use_retrieval = 1 AND r.review_status != 'removed' AND r.dup_of IS NULL AND (d.is_synthetic = 0 OR ?) ORDER BY bm25(kb_fts) LIMIT 3`);
  const isSample = !!db.prepare("SELECT is_sample FROM io_datasets WHERE id = ?").get(datasetId)?.is_sample;
  const rows = [...groups.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length).slice(0, 2000);
  db.transaction(() => {
    db.prepare("DELETE FROM io_claims WHERE dataset_id = ?").run(datasetId);
    const ins = db.prepare("INSERT INTO io_claims(dataset_id,text,text_hash,posts,accounts,first_at,last_at,post_ids,flags,kb_json,themes,status,case_id,note,reviewed_by,reviewed_at,extracted_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const [key, g] of rows) {
      const h = sha(key), flags = redFlags(g.post).map(f => ({ key: f.key, text: f.text, check: f.check, cue: f.cue }));
      const words = [...new Set(terms(g.text))].slice(0, 10).map(w => `"${w.replace(/"/g, "")}"`).join(" OR ");
      let kb = []; if (words) { try { kb = kbq.all(words, isSample ? 1 : 0).filter(r => overlap(r.claim, g.text) >= 0.4).map(r => ({ id: r.id, claim: r.claim, label: r.label, rating: r.label_raw || r.label, url: r.source_url, publisher: r.publisher, dataset: r.dataset, similarity: Math.round(overlap(r.claim, g.text) * 100) / 100 })); } catch {} }
      const o = old.get(h), status = o?.status || (flags.length || kb.length ? "needs_review" : "unreviewed");
      ins.run(datasetId, g.text.slice(0, 1000), h, g.ids.length, g.accounts.size, g.first, g.last, JSON.stringify(g.ids.slice(0, 500)), JSON.stringify(flags), JSON.stringify(kb), JSON.stringify(themesOf(g.text)), status, o?.case_id || null, o?.note || null, o?.reviewed_by || null, o?.reviewed_at || null, "rules");
    }
  })();
  return rows.length;
}
function overlap(a, b) { const A = new Set(terms(a)), B = new Set(terms(b)); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.min(A.size, B.size); }

// ---------------------------------------------------------------- filtered queries and insights
export function filterSql(f = {}) {
  const w = ["p.dataset_id = @ds"], P = {};
  if (f.from && !isNaN(Date.parse(f.from))) { w.push("p.posted_at >= @from"); P.from = new Date(f.from).toISOString(); }
  if (f.to && !isNaN(Date.parse(f.to))) { const d = new Date(f.to); if (/^\d{4}-\d\d-\d\d$/.test(f.to)) d.setUTCHours(23, 59, 59, 999); w.push("p.posted_at <= @to"); P.to = d.toISOString(); }
  if (f.platform) { w.push("coalesce(p.platform,'') = @platform"); P.platform = String(f.platform).slice(0, 60); }
  if (f.theme && THEMES[f.theme]) { w.push("p.themes LIKE @theme"); P.theme = `%"${f.theme}"%`; } else if (f.theme === "none") w.push("(p.themes IS NULL OR p.themes = '[]')");
  if (f.topic !== undefined && f.topic !== "" && /^\d+$/.test(String(f.topic))) { w.push("p.topic_no = @topic"); P.topic = Number(f.topic); }
  if (f.sentiment && SENTIMENT_LABELS[f.sentiment]) { w.push("p.sentiment = @sentiment"); P.sentiment = f.sentiment; }
  if (f.q) { w.push("(lower(p.text) LIKE @q ESCAPE '\\' OR p.account LIKE @q ESCAPE '\\')"); P.q = `%${String(f.q).toLowerCase().slice(0, 100).replace(/[\\%_]/g, m => "\\" + m)}%`; }
  return { where: w.join(" AND "), params: P };
}
export const FILTER_KEYS = ["from", "to", "platform", "theme", "topic", "sentiment", "q"];
export const cleanFilters = q => Object.fromEntries(FILTER_KEYS.filter(k => q?.[k] !== undefined && q[k] !== "").map(k => [k, String(q[k]).slice(0, 100)]));

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function insights(db, datasetId, filters = {}) {
  const { where, params } = filterSql(filters);
  const rows = db.prepare(`SELECT p.id, p.platform, p.account, p.posted_at, p.text, p.url, p.likes, p.comments, p.shares, p.views, p.hashtags, p.sentiment, p.sentiment_score, p.sentiment_confidence, p.sentiment_method, p.themes, p.topic_no, p.loc_country, p.loc_region, p.loc_name, p.loc_basis, p.mentioned_places, p.repost_of
    FROM io_posts p WHERE ${where} ORDER BY p.posted_at`).all({ ds: Number(datasetId), ...params });
  const total = db.prepare("SELECT COUNT(*) n FROM io_posts WHERE dataset_id = ?").get(Number(datasetId)).n;
  const out = { filters, posts: rows.length, dataset_posts: total, accounts: new Set(rows.map(r => r.account)).size, first_at: rows[0]?.posted_at || null, last_at: rows.at(-1)?.posted_at || null };
  if (!rows.length) return { ...out, empty: true };
  const t0 = Date.parse(rows[0].posted_at), t1 = Date.parse(rows.at(-1).posted_at), span = t1 - t0, bucketMs = span > 4 * 864e5 ? 864e5 : 3600e3, nB = Math.min(400, Math.floor(span / bucketMs) + 1);
  const bk = r => Math.min(nB - 1, Math.floor((Date.parse(r.posted_at) - t0) / bucketMs));
  out.bucket = bucketMs === 864e5 ? "day" : "hour"; out.bucket_start = new Date(t0).toISOString(); out.buckets = nB;
  out.timeline = new Array(nB).fill(0); for (const r of rows) out.timeline[bk(r)]++;
  // platforms
  const plat = new Map(); for (const r of rows) { const k = r.platform || "Not stated"; plat.set(k, (plat.get(k) || 0) + 1); }
  out.platforms = [...plat.entries()].sort((a, b) => b[1] - a[1]).map(([platform, posts]) => ({ platform, posts }));
  // sentiment
  const L = ["positive", "negative", "neutral", "mixed"], sc = Object.fromEntries(L.map(l => [l, 0])), methods = new Map(), series = Object.fromEntries(L.map(l => [l, new Array(nB).fill(0)]));
  let unclassified = 0, confSum = 0;
  for (const r of rows) { if (!r.sentiment) { unclassified++; continue; } sc[r.sentiment]++; series[r.sentiment][bk(r)]++; confSum += r.sentiment_confidence || 0; methods.set(r.sentiment_method, (methods.get(r.sentiment_method) || 0) + 1); }
  out.sentiment = { counts: sc, unclassified, series, mean_confidence: rows.length - unclassified ? Math.round(confSum / (rows.length - unclassified) * 100) / 100 : null, methods: [...methods.entries()].map(([method, posts]) => ({ method, posts })),
    by_platform: out.platforms.slice(0, 8).map(p => ({ platform: p.platform, ...Object.fromEntries(L.map(l => [l, rows.filter(r => (r.platform || "Not stated") === p.platform && r.sentiment === l).length])) })) };
  // themes and topics, with narrative change (share in the last third of the period vs before)
  const third = t0 + (span * 2) / 3, late = rows.filter(r => Date.parse(r.posted_at) >= third).length || 1, early = rows.length - late || 1;
  const change = sel => { const a = rows.filter(sel), l = a.filter(r => Date.parse(r.posted_at) >= third).length, e = a.length - l, ratio = ((l / late) + 1e-9) / ((e / early) + 1e-9); return { late: l, early: e, emerging: span > 0 && l >= 5 && ratio >= 2, ratio: Math.round(Math.min(ratio, 99) * 10) / 10 }; };
  const themeRows = Object.keys(THEMES).map(k => { const sel = r => (r.themes || "").includes(`"${k}"`), a = rows.filter(sel); return { key: k, label: THEMES[k][0], posts: a.length, series: (() => { const s = new Array(nB).fill(0); for (const r of a) s[bk(r)]++; return s; })(), sentiment: Object.fromEntries(L.map(l => [l, a.filter(r => r.sentiment === l).length])), ...change(sel) }; }).filter(t => t.posts).sort((a, b) => b.posts - a.posts);
  out.themes = themeRows; out.no_theme = rows.filter(r => !r.themes || r.themes === "[]").length;
  const topicMeta = new Map(db.prepare("SELECT topic_no, label, label_source, terms, summary FROM io_topics WHERE dataset_id = ?").all(Number(datasetId)).map(t => [t.topic_no, t]));
  const tcount = new Map(); for (const r of rows) tcount.set(r.topic_no || 0, (tcount.get(r.topic_no || 0) || 0) + 1);
  out.topics = [...tcount.entries()].filter(([no]) => no).map(([no, posts]) => { const m = topicMeta.get(no) || {}, sel = r => r.topic_no === no, s = new Array(nB).fill(0); for (const r of rows) if (sel(r)) s[bk(r)]++;
    return { topic_no: no, label: m.label || `Topic ${no}`, label_source: m.label_source || "terms", terms: JSON.parse(m.terms || "[]"), summary: m.summary || null, posts, series: s, sentiment: Object.fromEntries(L.map(l => [l, rows.filter(r => sel(r) && r.sentiment === l).length])), ...change(sel) }; }).sort((a, b) => b.posts - a.posts);
  out.unclustered = tcount.get(0) || 0;
  out.emerging = [...themeRows.filter(t => t.emerging).map(t => ({ kind: "theme", key: t.key, label: t.label, ratio: t.ratio, late: t.late })), ...out.topics.filter(t => t.emerging).map(t => ({ kind: "topic", key: t.topic_no, label: t.label, ratio: t.ratio, late: t.late }))];
  Object.assign(out, keywordCounts(rows.map(r => r.text)));
  const tags = new Map(); for (const r of rows) for (const t of JSON.parse(r.hashtags || "[]")) { const v = tags.get(t) || { tag: t, posts: 0, accounts: new Set(), series: new Array(nB).fill(0) }; v.posts++; v.accounts.add(r.account); v.series[bk(r)]++; tags.set(t, v); }
  out.hashtags = [...tags.values()].sort((a, b) => b.posts - a.posts).slice(0, 30).map(v => ({ tag: v.tag, posts: v.posts, accounts: v.accounts.size, series: v.series }));
  // duplicates within the filtered posts (identical wording after normalisation)
  const dup = new Map(); for (const r of rows) { const k = normText(r.text); if (k.length >= 15) dup.set(k, (dup.get(k) || 0) + 1); }
  out.duplicates = { identical_groups: [...dup.values()].filter(n => n > 1).length, posts_in_groups: [...dup.values()].filter(n => n > 1).reduce((a, n) => a + n, 0) };
  // engagement: only fields present in the data are reported; absent is not zero
  const F = ["likes", "comments", "shares", "views"], has = Object.fromEntries(F.map(f => [f, rows.filter(r => r[f] != null).length]));
  const sum = f => rows.reduce((a, r) => a + (r[f] || 0), 0), eng = r => (r.likes || 0) + (r.comments || 0) + (r.shares || 0);
  const withEng = rows.filter(r => r.likes != null || r.comments != null || r.shares != null);
  const logs = withEng.map(r => Math.log1p(eng(r))), med = median(logs), mad = median(logs.map(x => Math.abs(x - med)));
  const unusual = mad ? withEng.filter(r => 0.6745 * (Math.log1p(eng(r)) - med) / mad > 3.5) : [];
  out.engagement = { available: has, posts_with_engagement: withEng.length,
    totals: Object.fromEntries(F.filter(f => has[f]).map(f => [f, sum(f)])), median_per_post: Object.fromEntries(F.filter(f => has[f]).map(f => [f, median(rows.filter(r => r[f] != null).map(r => r[f]))])),
    series: Object.fromEntries(F.filter(f => has[f]).map(f => { const s = new Array(nB).fill(0); for (const r of rows) s[bk(r)] += r[f] || 0; return [f, s]; })),
    by_platform: out.platforms.map(p => { const a = rows.filter(r => (r.platform || "Not stated") === p.platform); return { platform: p.platform, posts: a.length, ...Object.fromEntries(F.filter(f => has[f]).map(f => [f, a.reduce((x, r) => x + (r[f] || 0), 0)])) }; }),
    top: withEng.sort((a, b) => eng(b) - eng(a)).slice(0, 10).map(r => ({ id: r.id, platform: r.platform, account: r.account, posted_at: r.posted_at, url: r.url, text: r.text.slice(0, 280), likes: r.likes, comments: r.comments, shares: r.shares, views: r.views })),
    unusual: { posts: unusual.length, rule: "engagement (likes + comments + shares) more than 3.5 robust deviations above the median of these posts (log scale)", examples: unusual.slice(0, 5).map(r => ({ id: r.id, account: r.account, posted_at: r.posted_at, text: r.text.slice(0, 160), engagement: eng(r) })) },
    note: "Only public counts present in the data are shown. Reach, impressions and audience demographics are not in the data and are not estimated." };
  // geography: recorded locations only; places named in the text are reported separately
  const geo = { post: 0, profile: 0, unknown: 0 }, counties = new Map(), countries = new Map(), mentioned = new Map();
  for (const r of rows) {
    if (r.loc_basis === "post" || r.loc_basis === "profile") { geo[r.loc_basis]++; const c = countyOf(r.loc_region) || countyOf(r.loc_name); const k = `${r.loc_basis}\u0000${c || ""}`; if (c) counties.set(k, (counties.get(k) || 0) + 1); const ctry = countryName(r.loc_country) || (c ? "Kenya" : null); if (ctry) { const kk = `${r.loc_basis}\u0000${ctry}`; countries.set(kk, (countries.get(kk) || 0) + 1); } }
    else geo.unknown++;
    for (const p of JSON.parse(r.mentioned_places || "[]")) mentioned.set(p, (mentioned.get(p) || 0) + 1);
  }
  const split = m => [...m.entries()].map(([k, n]) => { const [basis, name] = k.split("\u0000"); return { basis, name, posts: n, xy: COUNTY_XY[name] || null }; }).sort((a, b) => b.posts - a.posts);
  out.geography = { recorded: geo, counties: split(counties), countries: split(countries), mentioned: [...mentioned.entries()].sort((a, b) => b[1] - a[1]).map(([name, posts]) => ({ name, posts, xy: COUNTY_XY[name] || null })),
    note: "Locations from a location field in the data and self-reported profile locations are not verified by AIVS. Places named in the text show what is discussed, not where anyone is. Results are aggregated; AIVS does not track individuals' locations." };
  // links and their source categories
  const links = new Map(); for (const r of rows) for (const u of (String(r.text).match(/https?:\/\/[^\s<>"'“”)\]]+/g) || [])) { const c = sourceCategory(u.replace(/[.,;:!?]+$/, "")); if (!c.host) continue; const v = links.get(c.host) || { host: c.host, category: c.category, posts: 0 }; v.posts++; links.set(c.host, v); }
  out.sources = [...links.values()].sort((a, b) => b.posts - a.posts).slice(0, 30);
  out.limitations = LIMITATIONS;
  return out;
}
export const LIMITATIONS = [
  "Sentiment is estimated with a small English and Kiswahili word list (or, where shown, a local AI model). Sarcasm, slang, Sheng and context are often misread. Treat it as an indication of tone, not of opinion.",
  "Themes come from keyword lists; topics are keyword clusters computed from this dataset. A post can be about a theme without using its words.",
  "Results describe only the posts in this dataset. How they were collected decides what they can show; they are not a sample of all public opinion.",
  "Engagement counts are as recorded when the data was collected and may have changed since.",
  "Indicators such as repeated wording, synchronised posting or unusual engagement are reasons to look closer, not evidence of coordination or of who is behind it."
];

// ---------------------------------------------------------------- measured accuracy on AIVS's labelled test sentences
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const TEST_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../training/sentiment-test.json");
export function sentimentEvaluation() {
  const T = JSON.parse(fs.readFileSync(TEST_FILE, "utf8")), L = ["positive", "negative", "neutral", "mixed"];
  const res = T.items.map(([text, gold, lang]) => ({ text, gold, lang, pred: sentiment(text).label }));
  const per = (rows) => ({ items: rows.length, accuracy: rows.length ? Math.round(rows.filter(r => r.pred === r.gold).length / rows.length * 100) / 100 : null,
    classes: Object.fromEntries(L.map(l => { const tp = rows.filter(r => r.pred === l && r.gold === l).length, fp = rows.filter(r => r.pred === l && r.gold !== l).length, fn = rows.filter(r => r.pred !== l && r.gold === l).length;
      const p = tp + fp ? tp / (tp + fp) : 0, rc = tp + fn ? tp / (tp + fn) : 0; return [l, { precision: Math.round(p * 100) / 100, recall: Math.round(rc * 100) / 100, f1: p + rc ? Math.round(2 * p * rc / (p + rc) * 100) / 100 : 0, support: tp + fn }]; })) });
  return { method: SENTIMENT_METHOD, description: T.description, overall: per(res), english: per(res.filter(r => r.lang === "en")), kiswahili: per(res.filter(r => r.lang === "sw")), errors: res.filter(r => r.pred !== r.gold).slice(0, 20) };
}

// ---------------------------------------------------------------- synthetic public discussion sample (clearly labelled)
export function discussionSample() {
  let x = 20261025; const r = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = a => a[Math.floor(r() * a.length)], start = Date.UTC(2026, 9, 1, 5), days = 10, rows = [];
  const counties = ["Nairobi", "Garissa", "Kisumu", "Mombasa", "Nakuru", "Turkana", "Kakamega", "Machakos"];
  const T = {
    services: { pos: ["The new water point in {c} is working well, thank you", "Maji safi sasa yanapatikana {c}, tunashukuru", "Road repairs in {c} finished, the drive is safe again"],
      neg: ["No water in {c} for five days, this is terrible", "The water project in {c} failed and nobody explains why", "Barabara ya {c} ni mbovu, tumechoka"], neu: ["Water rationing schedule for {c} published today", "The county will inspect boreholes in {c} next week"] },
    economy: { pos: ["Prices at the {c} market improved this week, good news", "Bei ya unga imeshuka {c}, asante"], neg: ["Fuel prices are too expensive, families in {c} are suffering", "Bei ya mafuta ni ghali mno {c}", "Taxes again? People in {c} cannot afford food"], neu: ["The budget debate starts on Tuesday", "New fuel prices take effect at midnight"] },
    security: { pos: ["Peace has returned to {c}, thank you to the officers", "Amani imerudi {c}"], neg: ["Bandits attacked a village near {c}, people are afraid", "Insecurity in {c} is getting worse", "Majambazi wameshambulia {c}, hali ni mbaya"], neu: ["Police announced road checks around {c} tonight", "Security meeting held in {c} today"] },
    health: { pos: ["The clinic in {c} now opens on weekends, happy about this", "Hongera madaktari wa {c}"], neg: ["The hospital in {c} has no medicine again, shameful", "Hakuna dawa hospitali ya {c}"], neu: ["Vaccination days in {c} are Monday and Thursday", "Health officers will visit schools in {c}"] }
  };
  const platforms = ["SampleNet", "SampleNet", "SampleTube", "SamplePics"];
  const emit = (theme, day, i) => {
    const kind = r() < 0.42 ? "neg" : r() < 0.6 ? "pos" : "neu", c = pick(counties), text = pick(T[theme][kind]).replace("{c}", c);
    const plat = pick(platforms), at = start + day * 864e5 + Math.floor(r() * 16 * 3600e3), base = Math.floor(Math.exp(r() * 4));
    const locRoll = r(), loc = locRoll < 0.4 ? { region: c, location_basis: "post" } : locRoll < 0.55 ? { user_location: `${pick(counties)}, Kenya` } : {};
    rows.push({ account: `sample_user_${String(1 + Math.floor(r() * 160)).padStart(3, "0")}`, posted_at: new Date(at).toISOString(), text, platform: plat, likes: base * 3, comments: Math.floor(base / 2), shares: Math.floor(base / 3), views: plat === "SampleTube" ? base * 90 : "", url: `https://example.org/sample/${i}`, ...loc });
  };
  let i = 0;
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < 14; k++) emit(pick(["services", "services", "economy", "health"]), d, i++);
    for (let k = 0; k < (d >= 7 ? 12 : 2); k++) emit("security", d, i++);            // a theme that grows late in the period
  }
  // claims: one repeated checkable claim, one scam message (red flags), one post with very high engagement
  for (let k = 0; k < 9; k++) rows.push({ account: `sample_user_${String(200 + k)}`, posted_at: new Date(start + 5 * 864e5 + k * 1800e3).toISOString(), text: "The county government has closed all boreholes in Garissa until further notice.", platform: "SampleNet", likes: 20 + k, comments: 4, shares: 9, url: `https://example.org/sample/claim${k}`, region: "Garissa" });
  for (let k = 0; k < 6; k++) rows.push({ account: `sample_jobs_${k}`, posted_at: new Date(start + 6 * 864e5 + k * 600e3).toISOString(), text: "TANGAZO: Kaunti inaajiri vijana 500. Tuma Sh500 kwa M-Pesa namba 0712 000 111 ili kusajiliwa. Nafasi ni chache!", platform: "SamplePics", likes: 2, comments: 0, shares: 15 });
  rows.push({ account: "sample_user_077", posted_at: new Date(start + 8 * 864e5).toISOString(), text: "The clinic in Kisumu is good but the waiting time is terrible", platform: "SampleNet", likes: 9400, comments: 1200, shares: 3100, url: "https://example.org/sample/viral", region: "Kisumu" });
  return rows.sort((a, b) => a.posted_at.localeCompare(b.posted_at));
}

// Dataset registry and knowledge base: published fact-checks and research datasets, recorded with their licence
// and permitted use, de-duplicated, split deterministically (train / validation / test), reviewable, and searched
// as candidate evidence only after approval. AIVS does NOT train models on these records; "use_training" only
// records whether the licence would permit it.
import crypto from "node:crypto";
import { HttpError } from "./auth.js";
import { nowISO } from "./db.js";
import { parseCsv, normText } from "./io.js";
import { ratingToVerdict, VERDICTS } from "../../shared/verdict.js";

const MAX = 200000;
const iso = v => { if (!v) return null; const d = new Date(String(v)); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
const httpOr = u => (/^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim().slice(0, 1000) : null);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
// deterministic split from the normalised claim text: identical claims always land in the same split (no leakage)
export const splitOf = hash => { const n = parseInt(hash.slice(0, 8), 16) % 100; return n < 80 ? "train" : n < 90 ? "validation" : "test"; };
const FEVER = { SUPPORTS: "supported", REFUTES: "contradicted", "NOT ENOUGH INFO": "insufficient" };
export const toLabel = raw => FEVER[String(raw || "").trim().toUpperCase()] || ratingToVerdict(raw) || null;

// ---------------------------------------------------------------- format detection and parsing
export function parseDataset(buf, filename = "") {
  const s = buf.toString("utf8").replace(/^﻿/, "").trim(); if (!s) throw new HttpError(400, "The file is empty.");
  const rows = [];
  const fromReview = (claim, rv, extra = {}) => rows.push({ claim, label_raw: rv.textualRating || rv.reviewRating?.alternateName || rv.reviewRating?.name || null, source_url: rv.url, publisher: rv.publisher?.name || rv.author?.name || rv.publisher?.site || null,
    published_at: rv.reviewDate || rv.datePublished, language: rv.languageCode || rv.inLanguage || extra.language || null, claimant: extra.claimant || rv.itemReviewed?.author?.name || null, ext_id: rv.url || null });
  if (s.startsWith("{") || s.startsWith("[")) {
    let j; try { j = JSON.parse(s); } catch { j = null; }
    if (j === null) { const lines = s.split(/\r?\n/).filter(Boolean); try { j = lines.map(l => JSON.parse(l)); } catch { throw new HttpError(400, "The file is not valid JSON or JSON Lines."); } }
    const arr = Array.isArray(j) ? j : Array.isArray(j.claims) ? j.claims : Array.isArray(j.data) ? j.data : Array.isArray(j.records) ? j.records : Array.isArray(j["@graph"]) ? j["@graph"] : [j];
    let format = null;
    for (const x of arr) {
      if (Array.isArray(x?.claimReview)) { format = "google-factcheck"; for (const rv of x.claimReview) fromReview(x.text, rv, { claimant: x.claimant, language: x.languageCode }); }
      else if (x?.["@type"] === "ClaimReview" || x?.claimReviewed) { format = "claimreview"; fromReview(x.claimReviewed, x); }
      else if (x && "claim" in x && "label" in x && ("evidence" in x || "verifiable" in x || FEVER[String(x.label).toUpperCase()])) { format = "fever"; rows.push({ claim: x.claim, label_raw: x.label, ext_id: String(x.id ?? ""), language: "en" }); }
      else if (x && (x.claim || x.statement)) { format = "aivs-json"; rows.push({ claim: x.claim || x.statement, label_raw: x.label || x.rating || x.verdict, source_url: x.url || x.source_url, publisher: x.publisher, published_at: x.date || x.published_at, language: x.language, claimant: x.claimant || x.speaker, ext_id: x.id }); }
    }
    if (!rows.length) throw new HttpError(400, "No fact-check records were recognised. Supported: Google Fact Check Tools JSON, schema.org ClaimReview, FEVER JSON Lines, or a list of objects with “claim” and “label”.");
    return { format, rows };
  }
  // tab-separated research datasets without a header
  const first = s.split(/\r?\n/, 1)[0], tabs = first.split("\t");
  if (tabs.length >= 13 && /^\d+\.json$/.test(tabs[0])) return { format: "liar", rows: s.split(/\r?\n/).map(l => l.split("\t")).filter(c => c.length >= 3).map(c => ({ ext_id: c[0], label_raw: c[1], claim: c[2], claimant: c[4] || null, language: "en" })) };
  if (tabs.length >= 10 && /^[a-z]+-\d+/i.test(tabs[0])) return { format: "multifc", rows: s.split(/\r?\n/).map(l => l.split("\t")).filter(c => c.length >= 4).map(c => ({ ext_id: c[0], claim: c[1], label_raw: c[2], source_url: c[3], claimant: c[6] || null, publisher: c[7] || null, published_at: c[10] || null, language: "en" })) };
  const csv = parseCsv(s); if (!csv.length) throw new HttpError(400, "The file has no rows.");
  const cols = Object.keys(csv[0]), pick = (...names) => cols.find(c => names.includes(c.toLowerCase().replace(/[^a-z]/g, "")));
  const cC = pick("claim", "claimreviewed", "statement", "text"), cL = pick("label", "rating", "verdict", "textualrating"), cU = pick("url", "link", "sourceurl", "reviewurl"), cP = pick("publisher", "factchecker", "checker", "author"),
    cD = pick("date", "publishedat", "reviewdate", "datepublished"), cLa = pick("language", "lang", "languagecode"), cCl = pick("claimant", "speaker"), cI = pick("id", "claimid");
  if (!cC || !cL) throw new HttpError(400, `Could not find the claim and label columns. Columns in the file: ${cols.slice(0, 20).join(", ")}. Use the template (claim, label, url, publisher, date, language, claimant).`);
  return { format: "aivs-csv", rows: csv.map(r => ({ claim: r[cC], label_raw: r[cL], source_url: cU && r[cU], publisher: cP && r[cP], published_at: cD && r[cD], language: cLa && r[cLa], claimant: cCl && r[cCl], ext_id: cI && r[cI] })) };
}

// ---------------------------------------------------------------- service
export function makeKb(db, { audit }) {
  const ftsAdd = db.prepare("INSERT INTO kb_fts(rowid, claim, publisher) VALUES (?, ?, ?)"), ftsDel = db.prepare("INSERT INTO kb_fts(kb_fts, rowid, claim, publisher) VALUES ('delete', ?, ?, ?)");
  const get = id => { const d = db.prepare("SELECT * FROM kb_datasets WHERE id = ?").get(Number(id)); if (!d) throw new HttpError(404, "Dataset not found."); return d; };
  function importDataset(user, { buf, filename, name, license, permitted_use, source_url, languages, limitations, reliability, collected_at, notes, synthetic = false }) {
    for (const [k, v, msg] of [["name", name, "Give the dataset a name."], ["license", license, "Record the dataset's licence (for example CC BY 4.0, or “publisher's terms, permission obtained on …”)."], ["permitted_use", permitted_use, "Record what the licence permits (for example: research and internal reference; no redistribution)."]])
      if (!String(v || "").trim()) throw new HttpError(400, msg);
    const { format, rows } = parseDataset(buf, filename);
    if (rows.length > MAX) throw new HttpError(413, `The file has ${rows.length.toLocaleString()} records; the limit is ${MAX.toLocaleString()}.`);
    const prev = db.prepare("SELECT MAX(version) v FROM kb_datasets WHERE name = ?").get(String(name).trim()).v || 0;
    const seenHash = new Map(db.prepare("SELECT text_hash, MIN(id) id FROM kb_records WHERE review_status != 'removed' AND dup_of IS NULL GROUP BY text_hash").all().map(r => [r.text_hash, r.id]));
    const stats = { read: rows.length, imported: 0, duplicates: 0, skipped_no_claim: 0, unmapped_labels: 0, splits: { train: 0, validation: 0, test: 0 }, labels: {} };
    const id = db.transaction(() => {
      const r = db.prepare(`INSERT INTO kb_datasets(name,version,source_url,license,permitted_use,use_retrieval,use_training,collected_at,languages,limitations,reliability,status,format,format_detected,records,file_sha256,imported_by,imported_at,notes,is_synthetic)
        VALUES (?,?,?,?,?,0,0,?,?,?,?,'pending',?,?,0,?,?,?,?,?)`).run(String(name).trim().slice(0, 200), prev + 1, httpOr(source_url), String(license).trim().slice(0, 300), String(permitted_use).trim().slice(0, 500), iso(collected_at), String(languages || "").slice(0, 100) || null,
        String(limitations || "").slice(0, 2000) || null, String(reliability || "").slice(0, 1000) || null, format, format, sha(buf), user.id, nowISO(), String(notes || "").slice(0, 2000) || null, synthetic ? 1 : 0);
      const ds = Number(r.lastInsertRowid), ins = db.prepare(`INSERT INTO kb_records(dataset_id,ext_id,claim,label_raw,label,language,source_url,publisher,published_at,claimant,split,text_hash,dup_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const local = new Set();
      for (const x of rows) {
        const claim = String(x.claim || "").replace(/\s+/g, " ").trim(); if (claim.length < 8) { stats.skipped_no_claim++; continue; }
        const h = sha(normText(claim)); if (local.has(h)) { stats.duplicates++; continue; } local.add(h);
        const label = toLabel(x.label_raw); if (!label) stats.unmapped_labels++; stats.labels[label || "unmapped"] = (stats.labels[label || "unmapped"] || 0) + 1;
        const split = splitOf(h), dup = seenHash.get(h) ?? null; if (dup) stats.duplicates++;
        const rid = ins.run(ds, String(x.ext_id || "").slice(0, 200) || null, claim.slice(0, 2000), String(x.label_raw || "").slice(0, 100) || null, label, String(x.language || "").slice(0, 10).toLowerCase() || null, httpOr(x.source_url), String(x.publisher || "").slice(0, 200) || null, iso(x.published_at), String(x.claimant || "").slice(0, 200) || null, split, h, dup).lastInsertRowid;
        if (!dup) ftsAdd.run(rid, claim, x.publisher || null);
        stats.imported++; stats.splits[split]++;
      }
      db.prepare("UPDATE kb_datasets SET records = ? WHERE id = ?").run(stats.imported, ds);
      return ds;
    })();
    if (!stats.imported) throw new HttpError(400, "No usable records: every row was empty or too short.");
    audit(user, `Dataset imported: ${name} v${prev + 1}`, "kb_dataset", String(id), { format, ...stats, license, permitted_use, sha256: sha(buf) });
    return { id, version: prev + 1, format, ...stats };
  }
  function approve(user, id, { use_retrieval = true } = {}) {
    const d = get(id); if (d.status === "retired") throw new HttpError(409, "A retired dataset cannot be approved. Import it again as a new version.");
    if (d.imported_by === user.id) throw new HttpError(403, "A different administrator or reviewer must approve a dataset you imported.");
    db.transaction(() => {
      db.prepare("UPDATE kb_datasets SET status = 'approved', use_retrieval = ?, approved_by = ?, approved_at = ? WHERE id = ?").run(use_retrieval ? 1 : 0, user.id, nowISO(), d.id);
      for (const old of db.prepare("SELECT id FROM kb_datasets WHERE name = ? AND id != ? AND status = 'approved'").all(d.name, d.id)) db.prepare("UPDATE kb_datasets SET status = 'retired', use_retrieval = 0 WHERE id = ?").run(old.id);   // one live version per dataset
    })();
    audit(user, `Dataset approved: ${d.name} v${d.version}`, "kb_dataset", String(d.id), { use_retrieval: !!use_retrieval });
  }
  function retire(user, id) { const d = get(id); db.prepare("UPDATE kb_datasets SET status = 'retired', use_retrieval = 0 WHERE id = ?").run(d.id); audit(user, `Dataset retired: ${d.name} v${d.version}`, "kb_dataset", String(d.id)); }
  function review(user, rid, { review_status, label, note }) {
    const r = db.prepare("SELECT * FROM kb_records WHERE id = ?").get(Number(rid)); if (!r) throw new HttpError(404, "Record not found.");
    if (!["confirmed", "corrected", "removed"].includes(review_status)) throw new HttpError(400, "Choose confirmed, corrected or removed.");
    if (review_status === "corrected" && !VERDICTS[label]) throw new HttpError(400, "Choose the corrected label.");
    if (review_status !== "confirmed" && !String(note || "").trim()) throw new HttpError(400, "Say why the record is corrected or removed.");
    db.transaction(() => {
      db.prepare("UPDATE kb_records SET review_status = ?, label = COALESCE(?, label), reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?").run(review_status, review_status === "corrected" ? label : null, user.id, nowISO(), String(note || "").slice(0, 1000) || null, r.id);
      if (review_status === "removed" && !r.dup_of) ftsDel.run(r.id, r.claim, r.publisher);
      if (r.review_status === "removed" && review_status !== "removed" && !r.dup_of) ftsAdd.run(r.id, r.claim, r.publisher);
    })();
    audit(user, `Dataset record ${review_status}: KB-${r.id}`, "kb_dataset", String(r.dataset_id), { record: r.id, from: r.label, to: review_status === "corrected" ? label : undefined, note });
  }
  const list = () => db.prepare("SELECT d.*, u.display_name AS imported_by_name, a.display_name AS approved_by_name FROM kb_datasets d LEFT JOIN users u ON u.id = d.imported_by LEFT JOIN users a ON a.id = d.approved_by ORDER BY d.id DESC").all();
  function detail(id, { q, split, review: rv, label, limit = 100, offset = 0 } = {}) {
    const d = { ...get(id) }, where = ["dataset_id = ?"], args = [d.id];
    const nm = uid => (uid ? db.prepare("SELECT display_name FROM users WHERE id = ?").get(uid)?.display_name : null); d.imported_by_name = nm(d.imported_by); d.approved_by_name = nm(d.approved_by);
    if (split) { where.push("split = ?"); args.push(split); } if (rv) { where.push("review_status = ?"); args.push(rv); } if (label) { where.push(label === "unmapped" ? "label IS NULL" : "label = ?"); if (label !== "unmapped") args.push(label); }
    if (q) { where.push("(claim LIKE ? ESCAPE '\\' OR publisher LIKE ? ESCAPE '\\')"); const like = `%${String(q).replace(/[\\%_]/g, m => "\\" + m)}%`; args.push(like, like); }
    const W = where.join(" AND "), total = db.prepare(`SELECT COUNT(*) n FROM kb_records WHERE ${W}`).get(...args).n;
    const records = db.prepare(`SELECT * FROM kb_records WHERE ${W} ORDER BY id LIMIT ? OFFSET ?`).all(...args, Math.min(500, Number(limit) || 100), Number(offset) || 0);
    const counts = { splits: Object.fromEntries(db.prepare("SELECT split, COUNT(*) n FROM kb_records WHERE dataset_id = ? GROUP BY split").all(d.id).map(r => [r.split, r.n])),
      labels: Object.fromEntries(db.prepare("SELECT COALESCE(label,'unmapped') l, COUNT(*) n FROM kb_records WHERE dataset_id = ? GROUP BY l").all(d.id).map(r => [r.l, r.n])),
      review: Object.fromEntries(db.prepare("SELECT review_status s, COUNT(*) n FROM kb_records WHERE dataset_id = ? GROUP BY s").all(d.id).map(r => [r.s, r.n])),
      languages: Object.fromEntries(db.prepare("SELECT COALESCE(language,'unknown') l, COUNT(*) n FROM kb_records WHERE dataset_id = ? GROUP BY l").all(d.id).map(r => [r.l, r.n])),
      duplicates: db.prepare("SELECT COUNT(*) n FROM kb_records WHERE dataset_id = ? AND dup_of IS NOT NULL").get(d.id).n };
    const evaluations = db.prepare("SELECT * FROM kb_evaluations WHERE dataset_id = ? ORDER BY id DESC LIMIT 10").all(d.id).map(e => ({ ...e, metrics: JSON.parse(e.metrics_json), metrics_json: undefined }));
    return { dataset: d, total, records, counts, evaluations };
  }

  // Retrieval baseline evaluation, leakage-free: each TEST record is matched only against TRAIN records (never the
  // same text, which the hash split already guarantees); the matched record's label is the prediction. Measured,
  // not estimated; records without a match count as "no prediction" (coverage).
  function evaluate(user, id, { min_overlap = 0.5 } = {}) {
    const d = get(id), test = db.prepare("SELECT * FROM kb_records WHERE dataset_id = ? AND split = 'test' AND label IS NOT NULL AND review_status != 'removed' AND dup_of IS NULL").all(d.id);
    if (test.length < 5) throw new HttpError(409, `Only ${test.length} labelled test record(s): at least 5 are needed for a meaningful measurement.`);
    const STOP = new Set("the a an and or of to in on at for is are was were be this that it with by from as has have had will".split(" ")), tk = s => new Set(normText(s).split(" ").filter(w => w.length > 2 && !STOP.has(w)));
    const match = db.prepare(`SELECT r.id, r.claim, r.label FROM kb_fts f JOIN kb_records r ON r.id = f.rowid WHERE kb_fts MATCH ? AND r.dataset_id = ? AND r.split = 'train' AND r.label IS NOT NULL AND r.review_status != 'removed' ORDER BY bm25(kb_fts) LIMIT 5`);
    const classes = Object.keys(VERDICTS), conf = {}, byLang = {}; let predicted = 0, correct = 0;
    for (const t of test) {
      const qt = tk(t.claim), fq = [...qt].slice(0, 12).map(w => `"${w.replace(/"/g, "")}"`).join(" OR "); let pred = null;
      if (fq) for (const m of match.all(fq, d.id)) { const mt = tk(m.claim); let n = 0; for (const w of qt) if (mt.has(w)) n++; if (n / Math.max(1, Math.min(qt.size, mt.size)) >= min_overlap) { pred = m.label; break; } }
      const lang = t.language || "unknown"; byLang[lang] ||= { n: 0, predicted: 0, correct: 0 }; byLang[lang].n++;
      if (pred) { predicted++; byLang[lang].predicted++; if (pred === t.label) { correct++; byLang[lang].correct++; } }
      (conf[t.label] ||= {})[pred || "none"] = ((conf[t.label] ||= {})[pred || "none"] || 0) + 1;
    }
    const per = {};
    for (const c of classes) {
      const tp = conf[c]?.[c] || 0, fp = classes.filter(x => x !== c).reduce((a, x) => a + (conf[x]?.[c] || 0), 0), fn = Object.entries(conf[c] || {}).filter(([k]) => k !== c).reduce((a, [, v]) => a + v, 0);
      if (!tp && !fp && !fn) continue; const p = tp + fp ? tp / (tp + fp) : null, r = tp + fn ? tp / (tp + fn) : null;
      per[c] = { support: tp + fn, precision: p, recall: r, f1: p != null && r != null && p + r ? 2 * p * r / (p + r) : null };
    }
    const metrics = { method: "retrieval-baseline-1", test_records: test.length, coverage: predicted / test.length, accuracy_when_predicting: predicted ? correct / predicted : null, accuracy_overall: correct / test.length, min_overlap, per_class: per, by_language: byLang, confusion: conf,
      note: "Measured on this dataset's held-out test split against its training split only. A baseline for retrieval of published verdicts, not an estimate of how often AIVS conclusions are right." };
    db.prepare("INSERT INTO kb_evaluations(dataset_id,method,at,user_id,metrics_json) VALUES (?,?,?,?,?)").run(d.id, metrics.method, nowISO(), user.id, JSON.stringify(metrics));
    audit(user, `Dataset evaluated: ${d.name} v${d.version}`, "kb_dataset", String(d.id), { coverage: metrics.coverage, accuracy_when_predicting: metrics.accuracy_when_predicting, test_records: test.length });
    return metrics;
  }
  function exportCsv(id, split) {
    const d = get(id), q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const rows = db.prepare(`SELECT * FROM kb_records WHERE dataset_id = ? ${split ? "AND split = ?" : ""} AND review_status != 'removed' ORDER BY id`).all(...(split ? [d.id, split] : [d.id]));
    return "﻿" + [["kb_id", "claim", "label", "label_raw", "language", "url", "publisher", "published_at", "split", "review_status", "duplicate_of"], ...rows.map(r => [r.id, r.claim, r.label, r.label_raw, r.language, r.source_url, r.publisher, r.published_at, r.split, r.review_status, r.dup_of])].map(r => r.map(q).join(",")).join("\r\n") + "\r\n";
  }
  return { importDataset, approve, retire, review, list, detail, evaluate, exportCsv, get };
}

// A small SYNTHETIC set for practice with training cases only: invented claims, no real publishers or links.
export function sampleKb() {
  const R = [["Drinking hot lemon water every hour cures malaria", "False"], ["Lemon water is a cure for malaria", "False"], ["Hot lemon drinks cure malaria in children", "False"], ["Malaria is treated with antimalarial medicine prescribed at a clinic", "True"],
    ["KDF recruitment requires applicants to pay a registration fee by M-Pesa", "False"], ["The Ministry of Defence charges a fee to register for KDF recruitment", "False"], ["KDF recruitment is free of charge", "True"], ["Applicants must send money to a phone number to join KDF", "Scam"],
    ["Flood photos from 2018 shared as this week's floods in Garissa", "Missing context"], ["Old flood photo of trucks shared as new", "Out of context"], ["All schools in the county will close on Monday because of floods", "Unproven"],
    ["The county closed all schools because of floods", "Unproven"], ["Fuel prices will double next month", "Unverifiable"], ["The new road was opened in March 2024", "True"], ["The water project funds have disappeared", "Mixed"], ["Water project money has vanished", "Mixed"],
    ["Serikali inatoa ajira za KDF kwa malipo ya Sh1,500", "Si kweli"], ["Ajira za KDF zinahitaji malipo kwa M-Pesa", "Uongo"], ["Maji ya limau yanatibu malaria", "Si kweli"], ["Shule zote zitafungwa Jumatatu kwa sababu ya mafuriko", "Hakuna ushahidi"]];
  return JSON.stringify({ records: R.map(([claim, label], i) => ({ id: `SYN-${i + 1}`, claim, label, publisher: "AIVS training (synthetic)", language: /[a-z]+(ya|za|wa)\b|Serikali|Maji|Shule|Ajira/.test(claim) ? "sw" : "en" })) });
}

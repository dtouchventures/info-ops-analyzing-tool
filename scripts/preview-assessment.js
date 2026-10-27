// Read-only preview of the one-page Information Operations Assessment for an EXISTING investigation in your real database.
// The database is opened read-only and its checksum is compared before and after, so nothing is changed.
// Usage:  npm run report:preview -- --find "5G"          (newest completed investigation whose subject/content matches)
//         npm run report:preview -- --id <investigation id or AIVS-… reference>
// Output: data/report-preview/<reference>-assessment.html and .pdf, plus a summary on screen and in summary.txt:
//         pages, words per section, and for each key reference whether it actually addresses the claim.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { config } from "../server/config.js";
import { buildAssessment, assessmentHtml, assessmentPdf, words, LIMITS } from "../server/lib/ioassessment.js";

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const find = arg("--find"), id = arg("--id");
if (!find && !id) { console.error('Usage: npm run report:preview -- --find "5G"   or   -- --id <id>'); process.exit(2); }
const file = path.join(config.dataDir, "aivs.db");
if (!fs.existsSync(file)) { console.error(`No database at ${file}`); process.exit(2); }
const sum = () => { const h = crypto.createHash("sha256"); for (const f of [file, `${file}-wal`]) if (fs.existsSync(f)) h.update(fs.readFileSync(f)); return h.digest("hex"); };
const before = sum();
const db = new Database(file, { readonly: true, fileMustExist: true });
const lines = [], log = s => { console.log(s); lines.push(s); };

let row;
if (id) row = db.prepare("SELECT * FROM investigations WHERE (id = ? OR report_id = ?) AND status = 'done'").get(id, id);
else {
  const like = `%${find}%`;
  row = db.prepare("SELECT * FROM investigations WHERE status = 'done' AND (subject LIKE ? OR result_json LIKE ?) ORDER BY created_at DESC").get(like, like);
  if (!row) {
    const cases = db.prepare("SELECT id, title, status, created_at FROM cases WHERE title LIKE ? OR claim_text LIKE ? ORDER BY created_at DESC LIMIT 5").all(like, like);
    log(`No completed automatic investigation matches “${find}”.`);
    if (cases.length) log(`Matching case(s) (the one-page assessment is built from automatic investigations, not from cases):\n${cases.map(c => `  ${c.id} · ${c.status} · ${c.created_at} · ${c.title}`).join("\n")}\nTo produce the assessment, submit the same claim or link on Verify Information; the original case is not changed.`);
  }
}
let failed = false;
if (row) {
  const r = JSON.parse(row.result_json), a = buildAssessment(r, { priority: r.priority });
  const out = path.join(config.dataDir, "report-preview"); fs.mkdirSync(out, { recursive: true });
  const html = assessmentHtml(a, { standalone: true }), pdf = await assessmentPdf(a);
  fs.writeFileSync(path.join(out, `${row.report_id}-assessment.html`), html); fs.writeFileSync(path.join(out, `${row.report_id}-assessment.pdf`), pdf.buf);
  const plain = [a.title, ...Object.values(a.header), a.background, a.analysis, a.assessment, ...a.recommendations, ...a.references.map(f => `${f.publisher} ${f.title} ${f.date || ""}`), a.limitation, a.report_status].join(" ");
  log(`Investigation ${row.report_id} (${row.created_at}) · subject: ${row.subject}`);
  log(`Verdict: ${a.verdict_label} · evidence strength: ${a.strength} · status: ${a.header.status}`);
  log(`PDF pages: ${pdf.pages} (font size ${pdf.size} pt) ${pdf.pages === 1 ? "PASS" : "FAIL"}`);
  log(`Words: total ${words(plain)} · background ${words(a.background)}/${LIMITS.background.join("–")} · analysis ${words(a.analysis)}/${LIMITS.analysis.join("–")} · assessment ${words(a.assessment)}/${LIMITS.assessment.join("–")} · recommendations ${words(a.recommendations.join(" "))}/${LIMITS.recommendations.join("–")} (${a.recommendations.length})`);
  log(`Evidence items in the investigation: ${r.evidence.length}. Key references (${a.references.length}):`);
  for (const f of a.references) {
    const e = r.evidence.find(x => x.id === f.id);
    log(`  [${f.n}] ${f.publisher} — ${f.title} — ${f.addresses}${e ? ` (stance ${e.stance}, relevance ${(e.relevance ?? 0).toFixed(2)}${e.stance_basis ? `; ${e.stance_basis}` : ""})` : ""}\n      ${f.url || "no link"}`);
  }
  if (!a.references.length) log("  none: no retrieved evidence addressed the claim, so none is cited.");
  failed = pdf.pages !== 1;
  log(`Files: ${out}`);
}
db.close();
const after = sum();
log(`Database unchanged: ${before === after ? "PASS" : "FAIL"} (sha256 ${before.slice(0, 16)}…)`);
if (row) fs.writeFileSync(path.join(config.dataDir, "report-preview", "summary.txt"), lines.join("\n"));
process.exit(failed || before !== after ? 1 : row ? 0 : 3);

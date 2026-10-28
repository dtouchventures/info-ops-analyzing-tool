// Formal one-page report (UNIT: STRATEGIC COMMUNICATION / ACADEMIC / UNOFFICIAL), AIVS 1.22.
// A real case is verified and approved through the API; the report is generated from those records, checked for the
// required structure and wording, downloaded as Word and PDF, and its page count is measured on the actual files:
// the PDF with pdf.js, and the Word file by converting it with LibreOffice when LibreOffice is installed.
// Set FORMAL_OUT=<folder> to keep the sample files.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, login, file, T } from "./helpers.js";
import { normalise, validate, dtg, DTG_RE } from "../server/lib/formal-report.js";
import { fit } from "../server/lib/formal-print.js";

let S, ana, rev, view, caseId;
const OUT = process.env.FORMAL_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "aivs-formal-"));
before(async () => { S = await startServer(); ana = await login(S.base, "ana"); rev = await login(S.base, "rev"); view = await login(S.base, "view"); fs.mkdirSync(OUT, { recursive: true }); });
after(async () => { await S.close(); });

async function binary(user, url) { const r = await fetch(S.base + url, { headers: { cookie: user.cookie, "x-aivs": "1" } }); return { status: r.status, type: r.headers.get("content-type"), buf: Buffer.from(await r.arrayBuffer()), text: () => "" }; }
async function pdfPages(buf) { const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); const d = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false }).promise; const n = d.numPages; await d.cleanup(); return n; }
function unzip(buf, name) {
  // read one file from the .docx with the zip central directory
  let e = buf.length - 22; while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < buf.readUInt16LE(e + 10); i++) {
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42), nm = buf.toString("utf8", p + 46, p + 46 + nl);
    if (nm === name) { const ln = buf.readUInt16LE(off + 26), lx = buf.readUInt16LE(off + 28), size = buf.readUInt32LE(p + 20); return (awaitInflate)(buf.subarray(off + 30 + ln + lx, off + 30 + ln + lx + size)); }
    p += 46 + nl + xl + cl;
  }
  return null;
}
import zlib from "node:zlib";
const awaitInflate = b => zlib.inflateRawSync(b).toString("utf8");
const soffice = (() => { for (const c of ["soffice", "libreoffice", "C:\\Program Files\\LibreOffice\\program\\soffice.exe"]) { try { execFileSync(c, ["--version"], { stdio: "ignore", timeout: 60000 }); return c; } catch { /* not installed */ } } return null; })();

test("a verified, approved case: the analyst sets rank and appointment, viewers cannot prepare the report", async () => {
  const r = await ana.post("/api/cases", { title: "Convoy photo claimed to show trucks in Garissa today", claim_text: "KDF trucks were swept away in Garissa floods today. The photo was taken this morning.", source_platform: "WhatsApp", source_account: "+254 7xx forwarded group", received_at: "2026-10-20T07:30:00Z" });
  caseId = r.body.id;
  await ana.post(`/api/cases/${caseId}/media`, null, { form: file(T("images/case_convoy.jpg")) });
  await ana.post(`/api/cases/${caseId}/analyse?wait=1`, {});
  let agg = (await ana.get(`/api/cases/${caseId}`)).body;
  for (const e of agg.evidence.filter(x => x.status === "suggested")) await ana.patch(`/api/evidence/${e.id}`, { status: "dismissed" });
  const live = agg.claims.filter(c => !c.removed);
  for (const c of live) await ana.post(`/api/cases/${caseId}/evidence`, { kind: "source_claim", text: "County disaster office: no KDF vehicle was lost in the October floods; the photo matches a 2018 image.", reference: "Garissa County disaster office statement, 21 Oct 2026", links: [{ claim_id: c.id, stance: "contradicts" }] });
  for (const c of live) await ana.patch(`/api/claims/${c.id}`, { assessment: "contradicted", rationale: "The county statement and the 2018 copy of the photo contradict it." });
  await ana.patch(`/api/cases/${caseId}`, { conclusion: "contradicted", conclusion_rationale: "The photo predates the floods and official records show no vehicle loss.", uncertainties: "The original 2018 photographer has not been identified." });
  assert.equal((await ana.post(`/api/cases/${caseId}/submit`, {})).status, 200);
  assert.equal((await rev.post(`/api/cases/${caseId}/decision`, { decision: "approve" })).status, 200);
  assert.equal((await ana.patch("/api/me/profile", { rank: "Captain", appointment: "Staff Officer Information Operations" })).status, 200);
  const me = (await ana.get("/api/me")).body.user; assert.equal(me.rank, "Captain"); assert.equal(me.appointment, "Staff Officer Information Operations");
  const g = await ana.get(`/api/formal/case/${caseId}`); assert.equal(g.status, 200); assert.equal(g.body.saved, false);
  assert.equal((await view.post(`/api/formal/case/${caseId}/generate`, {})).status, 403);
});

test("Generate Report: the exact structure, filled from the case records only, ready to print on one page", async () => {
  const r = await ana.post(`/api/formal/case/${caseId}/generate`, {}); assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body.content;
  assert.equal(c.subject, "Convoy photo claimed to show trucks in Garissa today");
  assert.match(c.date, DTG_RE, "military date-time group, e.g. 281430Z OCT 26"); assert.equal(dtg(new Date("2026-10-28T14:30:00Z")), "281430Z OCT 26");
  for (const k of ["purpose", "background", "analysis", "assessment", "conclusion"]) assert.ok(c[k].length > 20, k);
  assert.match(c.purpose, new RegExp(caseId)); assert.match(c.background, /20 Oct 2026/); assert.match(c.background, /WhatsApp/);
  assert.match(c.background, /Date first published: not recorded; requires verification/, "a missing fact is stated as missing");
  assert.match(c.analysis, /Claim 1 \(Verified\)/); assert.match(c.analysis, /verdict: Contradicted \(1 source contradicts, 0 support\)/); assert.equal(c.analysis.split("The county statement and the 2018 copy").length - 1, 1, "the shared rationale is written once"); assert.match(c.analysis, /Analytical assumptions and uncertainties: The original 2018 photographer/);
  assert.match(c.assessment, /Overall assessment: CONTRADICTED\./); assert.match(c.assessment, /approved by REV/);
  assert.ok(c.recommendations.length >= 3 && c.recommendations.every(x => !/^\(?[a-z]\)/.test(x)), "lettered when printed, stored without letters");
  assert.deepEqual(c.preparer, { rank: "Captain", name: "ANA", appointment: "Staff Officer Information Operations" });
  assert.deepEqual(r.body.problems, []); assert.equal(r.body.layout.fits, true); assert.equal(r.body.ready, true);
  assert.equal(r.body.layout.marginCm, 1.5); assert.ok(r.body.layout.size >= 9 && r.body.layout.size <= 10);
});

test("Download Word: A4 portrait, 1.5 cm margins, Arial 9–10 pt, headings in the required order, no academic/unofficial marking", async () => {
  const d = await binary(ana, `/api/formal/case/${caseId}/report.docx`); assert.equal(d.status, 200); assert.match(d.type, /wordprocessingml/);
  fs.writeFileSync(path.join(OUT, "AIVS-formal-report-sample.docx"), d.buf);
  const doc = unzip(d.buf, "word/document.xml"), foot = unzip(d.buf, "word/footer1.xml");
  assert.match(doc, /<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"\/>/);
  assert.match(doc, /<w:pgMar w:top="851" w:right="851" w:bottom="851" w:left="851"/);
  assert.match(doc, /w:ascii="Arial"/); const sizes = [...doc.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map(m => +m[1] / 2); assert.ok(Math.min(...sizes) >= 9 && Math.min(...sizes) <= 10, String(sizes[0]));
  const text = [...doc.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g)].map(m => m[1]).join("|");
  assert.match(doc, /<w:tab w:val="right"/, "the date-time group sits at the right margin of the top line");
  const order = ["UNIT: STRATEGIC COMMUNICATION", "Z ", "RESTRICTED", "SUBJECT: ", "1. PURPOSE", "2. BACKGROUND", "3. ANALYSIS", "5. ASSESSMENT", "6. RECOMMENDATIONS", "7. CONCLUSION", "Prepared by:", "Rank: ", "Name: ", "Appointment: "];
  let at = -1; for (const h of order) { const i = text.indexOf(h, at + 1); assert.ok(i > at, `${h} after the previous heading`); at = i; }
  assert.ok(!text.includes("4. "), "specified numbering gap is preserved");
  assert.match(text, /\(a\)\|.*\(b\)\|.*\(c\)/, "recommendations lettered (a), (b), (c)");
  assert.ok(text.includes("Captain") && text.includes("Staff Officer Information Operations"), "authorised profile details populated");
  assert.match(foot, /RESTRICTED/); assert.match(text, /\|CONVOY PHOTO CLAIMED TO SHOW TRUCKS IN GARISSA TODAY\|/);
});

test("one A4 page, measured on the produced files: the PDF, and the Word file rendered by LibreOffice", async (t) => {
  const p = await binary(ana, `/api/formal/case/${caseId}/report.pdf`); assert.equal(p.status, 200);
  fs.writeFileSync(path.join(OUT, "AIVS-formal-report-sample.pdf"), p.buf);
  assert.equal(await pdfPages(p.buf), 1, "the PDF has exactly one page");
  const pg = (await pdfjsPageSize(p.buf)); assert.ok(Math.abs(pg.w - 595.28) < 1 && Math.abs(pg.h - 841.89) < 1, "A4 portrait");
  if (!soffice) return t.skip("LibreOffice is not installed here, so the Word file could not be rendered");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-docx-")), f = path.join(dir, "r.docx"); fs.writeFileSync(f, (await binary(ana, `/api/formal/case/${caseId}/report.docx`)).buf);
  execFileSync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", dir, f], { stdio: "ignore", timeout: 120000 });
  const conv = fs.readFileSync(path.join(dir, "r.pdf")); fs.writeFileSync(path.join(OUT, "AIVS-formal-report-sample.docx-rendered-by-LibreOffice.pdf"), conv);
  assert.equal(await pdfPages(conv), 1, "the Word file renders on exactly one page");
});
async function pdfjsPageSize(buf) { const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); const d = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise; const v = (await d.getPage(1)).view; await d.cleanup(); return { w: v[2] - v[0], h: v[3] - v[1] }; }

test("print preview, edits, validation of missing fields, and the one-page limit", async () => {
  const h = await ana.get(`/api/formal/case/${caseId}/report.html`); assert.equal(h.status, 200); assert.match(h.body, /@page \{ size: A4 portrait/); assert.doesNotMatch(h.body, /Not ready to print/);
  let cur = (await ana.get(`/api/formal/case/${caseId}`)).body;
  // edit: a missing name blocks downloads and printing, with the missing field named
  let r = await ana.put(`/api/formal/case/${caseId}`, { revision: cur.revision, content: { ...cur.content, subject: "Edited subject: convoy photo", conclusion: "" } });
  assert.equal(r.status, 200); assert.equal(r.body.content.subject, "Edited subject: convoy photo"); assert.equal(r.body.ready, false); assert.match(r.body.problems.join(" "), /Complete: 7\. Conclusion\./); assert.doesNotMatch(r.body.problems.join(" "), /Rank|Name|Appointment/, "blank Prepared by is allowed");
  let d = await ana.get(`/api/formal/case/${caseId}/report.docx`); assert.equal(d.status, 409); assert.match(d.body.error || JSON.stringify(d.body), /7\. Conclusion/);
  assert.equal((await ana.post(`/api/formal/case/${caseId}/printed`, {})).status, 409);
  assert.match((await ana.get(`/api/formal/case/${caseId}/report.html`)).body, /Not ready to print/);
  assert.equal((await ana.put(`/api/formal/case/${caseId}`, { revision: cur.revision, content: cur.content })).status, 409, "a stale revision is refused");
  // too long for one page: refused with the overflow, never cut silently
  cur = (await ana.get(`/api/formal/case/${caseId}`)).body; cur.content.conclusion = "The content is assessed as contradicted.";
  const long = Array.from({ length: 15 }, (_, i) => `Paragraph ${i + 1}: ${"Additional analytical detail recorded by the analyst for this assessment. ".repeat(5)}`).join("\n");
  r = await ana.put(`/api/formal/case/${caseId}`, { revision: cur.revision, content: { ...cur.content, analysis: long, preparer: { rank: "Captain", name: "J. Doe", appointment: "SO2 Info Ops" } } });
  assert.equal(r.status, 200); assert.equal(r.body.layout.fits, false); assert.ok(r.body.layout.over_lines > 0);
  assert.equal(r.body.content.analysis, long.split("\n").map(x => x.trim()).join("\n"), "the text is kept as typed, not cut");
  const huge = await ana.put(`/api/formal/case/${caseId}`, { revision: r.body.revision, content: { ...r.body.content, analysis: "x ".repeat(4000) } });
  assert.equal(huge.status, 400); assert.match(huge.body.error, /Too long: 3\. Analysis/);
  d = await ana.get(`/api/formal/case/${caseId}/report.pdf`); assert.equal(d.status, 409); assert.match(d.body.error, /longer than one A4 page/);
  // a moderately longer text fits by tightening spacing or font size, and is still one page
  cur = r.body; const mid = cur.content.analysis.split("\n").slice(0, 4).join("\n");
  r = await ana.put(`/api/formal/case/${caseId}`, { revision: cur.revision, content: { ...cur.content, analysis: mid } }); assert.equal(r.body.ready, true, JSON.stringify(r.body.layout));
  const p = await binary(ana, `/api/formal/case/${caseId}/report.pdf`); assert.equal(await pdfPages(p.buf), 1);
  assert.equal((await ana.post(`/api/formal/case/${caseId}/printed`, {})).status, 200);
  // regenerate: refreshed from the records, keeping the author's subject and Prepared-by details
  r = await ana.post(`/api/formal/case/${caseId}/generate`, {}); assert.equal(r.body.content.subject, "Edited subject: convoy photo"); assert.equal(r.body.content.preparer.name, "J. Doe"); assert.doesNotMatch(r.body.content.analysis, /Paragraph 1:/);
  const audit = S.ctx.db.prepare("SELECT action FROM audit_log WHERE entity_id = ? AND action LIKE 'Formal report%'").all(caseId).map(a => a.action);
  for (const a of ["Formal report generated from the records", "Formal report edited", "Formal report downloaded (pdf)", "Formal report printed"]) assert.ok(audit.includes(a), a);
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM formal_report_versions WHERE source_id = ?").get(caseId).n >= 5, "every saved version is kept");
});

test("the existing verification report is unchanged and still downloads", async () => {
  const h = await ana.get(`/api/cases/${caseId}/report.html`); assert.equal(h.status, 200); assert.match(h.body, /CONTRADICTED/);
  assert.equal((await binary(ana, `/api/cases/${caseId}/report.pdf`)).status, 200);
});

test("a social media dataset gets the same report, filled from its analysis; synthetic data is labelled", async () => {
  const d = await ana.post("/api/io/watch-demo", {}); assert.equal(d.status, 201, JSON.stringify(d.body));
  const r = await ana.post(`/api/formal/dataset/${d.body.id}/generate`, {}); assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body.content; assert.match(c.background, /1,000 posts/); assert.doesNotMatch(c.analysis, /posted between/, "no repetition of the background"); assert.match(c.background, /SYNTHETIC/); assert.ok(c.recommendations.length >= 1);
  assert.equal(r.body.ready, true, JSON.stringify(r.body));
  const p = await binary(ana, `/api/formal/dataset/${d.body.id}/report.pdf`); assert.equal(p.status, 200); assert.equal(await pdfPages(p.buf), 1);
  const w = await binary(ana, `/api/formal/dataset/${d.body.id}/report.docx`); assert.equal(w.status, 200);
  fs.writeFileSync(path.join(OUT, "AIVS-formal-report-dataset-sample.docx"), w.buf); fs.writeFileSync(path.join(OUT, "AIVS-formal-report-dataset-sample.pdf"), p.buf);
});

test("text clean-up and validation rules", () => {
  const n = normalise({ subject: "  S  ", recommendations: "- First action\n(b) Second action\n3. Third action\n\n• Fourth", purpose: "p", background: "b", analysis: "a", assessment: "x", conclusion: "c", preparer: { rank: "Maj", name: "N", appointment: "[Appointment]" } });
  assert.deepEqual(n.recommendations, ["First action", "Second action", "Third action", "Fourth"]); assert.equal(n.subject, "S");
  assert.match(validate(n).join(" "), /Complete: Date-time group/);
  assert.match(validate({ ...n, date: "28 October" }).join(" "), /DDHHMM, zone letter/); assert.doesNotMatch(validate({ ...n, date: "281430c oct 26".toUpperCase() }).join(" "), /DDHHMM/);
  assert.match(validate(n).join(" "), /square brackets/);
  assert.match(validate(normalise({})).join(" "), /Subject, 1\. Purpose, 2\. Background, 3\. Analysis, 5\. Assessment, 7\. Conclusion, 6\. Recommendations/);
  assert.equal(fit(n).fits, true);
});

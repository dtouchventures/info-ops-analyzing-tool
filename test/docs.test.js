// Documents in cases (AIVS 1.6): PDF, Word .docx and text files, document properties as leads, warnings for
// tracked changes / macros / scripts / incremental saves, scanned-PDF detection, claims from documents, safety limits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { startServer, login, T } from "./helpers.js";
import { docxText, pdfDate, extractDocument, unzip } from "../server/lib/docs.js";

let S, ana, view;
before(async () => { S = await startServer(); [ana, view] = await Promise.all(["ana", "view"].map(u => login(S.base, u))); });
after(async () => { await S.close(); });

// minimal ZIP writer (stored entries) for building .docx files in tests
export function zip(entries) {
  const parts = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content), nm = Buffer.from(name), crc = zlib.crc32(data), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, data); central.push(c, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(entries).length, 8); e.writeUInt16LE(Object.keys(entries).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const W = body => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
const P = t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
export const docx = (body, { core = "", extra = {} } = {}) => zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": W(body),
  "docProps/core.xml": `<cp:coreProperties xmlns:cp="a" xmlns:dc="b" xmlns:dcterms="c">${core}</cp:coreProperties>`, "docProps/app.xml": "<Properties><Application>Microsoft Office Word</Application><Pages>1</Pages></Properties>", ...extra });
export const pdf = (pages, info = {}, image = null) => new Promise(ok => { const d = new PDFDocument({ info }), ch = []; d.on("data", c => ch.push(c)); d.on("end", () => ok(Buffer.concat(ch))); pages.forEach((t, i) => { if (i) d.addPage(); if (image) d.image(image, 50, 50, { width: 400 }); else d.text(t); }); d.end(); });
const up = (caseId, buf, name) => { const fd = new FormData(); fd.append("files", new Blob([buf]), name); return ana.post(`/api/cases/${caseId}/media`, undefined, { form: fd }); };

test("docx text: paragraphs, tabs, entities; deleted tracked text is left out", () => {
  const t = docxText(W(P("Hello &amp; welcome") + `<w:p><w:r><w:t>A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>B</w:t></w:r></w:p>` + `<w:p><w:del><w:r><w:delText>secret old wording</w:delText></w:r></w:del><w:ins><w:r><w:t>new wording</w:t></w:r></w:ins></w:p>`));
  assert.equal(t, "Hello & welcome\nA\tB\nnew wording");
  assert.equal(pdfDate("D:20240305101500+03'00'"), "2024-03-05T07:15:00.000Z"); assert.equal(pdfDate("D:2024"), "2024-01-01T00:00:00.000Z"); assert.equal(pdfDate("garbage"), null);
});

test("readers: PDF text, pages and properties; docx properties and warnings; other office files refused", async () => {
  const p = await extractDocument(await pdf(["First page about the recruitment notice.", "Second page."], { Title: "Notice", Author: "Clerk", Creator: "Microsoft Word", CreationDate: new Date(Date.UTC(2024, 2, 5)) }), "n.pdf");
  assert.equal(p.type, "pdf"); assert.equal(p.pages, 2); assert.match(p.text, /--- Page 1 ---\nFirst page about the recruitment notice\./); assert.match(p.text, /--- Page 2 ---\nSecond page\./);
  assert.equal(p.meta.Author, "Clerk"); assert.equal(p.meta.Created, "2024-03-05T00:00:00.000Z"); assert.equal(p.scanned, false);
  const d = await extractDocument(docx(P("Body") + `<w:p><w:ins><w:r><w:t>x</w:t></w:r></w:ins></w:p>`, { core: "<dc:creator>A. Writer</dc:creator><cp:lastModifiedBy>B. Editor</cp:lastModifiedBy><dcterms:created>2026-01-02T10:00:00Z</dcterms:created>", extra: { "word/comments.xml": "<w:comments><w:comment/></w:comments>", "word/vbaProject.bin": "x" } }), "d.docx");
  assert.equal(d.meta.Author, "A. Writer"); assert.equal(d.meta.LastModifiedBy, "B. Editor"); assert.equal(d.meta.Application, "Microsoft Office Word");
  assert.ok(d.warnings.some(w => /tracked changes/.test(w)) && d.warnings.some(w => /comment/.test(w)) && d.warnings.some(w => /macros/.test(w)));
  await assert.rejects(extractDocument(zip({ "xl/workbook.xml": "<x/>" }), "a.xlsx"), /Excel workbook/);
  await assert.rejects(extractDocument(Buffer.from("plain"), "a.bin"), /unsupported/);
  const t = await extractDocument(Buffer.from("﻿Notice: send money now"), "msg.txt"); assert.equal(t.text, "Notice: send money now");
});

test("safety: incremental saves and scripts are flagged; zip bombs refused; scanned PDFs detected", async () => {
  const base = await pdf(["Text page"]);
  const inc = await extractDocument(Buffer.concat([base, Buffer.from("\n/JavaScript (app.alert(1))\n%%EOF\n")]), "x.pdf");
  assert.ok(inc.warnings.some(w => /saved 2 times/.test(w))); assert.ok(inc.warnings.some(w => /JavaScript/.test(w)));
  const big = zlib.deflateRawSync(Buffer.alloc(60 * 1024 * 1024)), z = zip({ "word/document.xml": "x" });
  // rewrite the entry as a 60 MB deflate stream declared in the central directory
  const bomb = Buffer.from(z); const cdAt = bomb.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); bomb.writeUInt32LE(60 * 1024 * 1024, cdAt + 24);
  assert.throws(() => unzip(bomb), /unsafe size/); assert.ok(big.length > 0);
  const sc = await extractDocument(await pdf(["", ""], {}, T("images/case_notice.jpg")), "scan.pdf");
  assert.equal(sc.scanned, true); assert.ok(sc.warnings.some(w => /scanned/.test(w)));
});

test("documents in a case: stored, leads from properties and text, claims from the document, text download", async () => {
  const c = await ana.post("/api/cases", { claim_text: "A circular says KDF is recruiting and applicants must pay a fee. See attached document." });
  const id = c.body.id;
  const buf = await pdf(["MINISTRY OF DEFENCE\nRECRUITMENT NOTICE\nThe Kenya Defence Forces will recruit 5,000 youths on 30 October 2026. Applicants must send KSh 1,500 via M-Pesa to 0712 345 678 to register.\nOnly registered applicants will be considered."],
    { Title: "Recruitment", Author: "John Doe", Creator: "Microsoft Word 2016", CreationDate: new Date(Date.UTC(2026, 0, 2)) });
  const u = await up(id, buf, "circular.pdf"); assert.equal(u.status, 201, JSON.stringify(u.body)); const mid = u.body.media[0].id; assert.equal(u.body.media[0].kind, "document");
  const tx = await up(id, Buffer.from("Forwarded: KDF recruitment, send 1500 to register."), "forward.txt"); assert.equal(tx.status, 201);
  const xl = await up(id, zip({ "xl/workbook.xml": "<x/>" }), "sheet.xlsx"); assert.equal(xl.status, 422); assert.match(xl.body.errors[0], /Excel workbook/);
  await ana.post(`/api/cases/${id}/analyse?wait=1`, {});
  let agg = (await ana.get(`/api/cases/${id}`)).body;
  const m = agg.media.find(x => x.id === mid); assert.equal(m.document.pages, 1); assert.match(m.document.preview, /RECRUITMENT NOTICE/); assert.equal(m.metadata.Author, "John Doe");
  const keys = agg.evidence.map(e => e.sys_key);
  assert.ok(keys.includes(`docmeta:${mid}`), "properties lead"); assert.ok(keys.includes(`docnum:${mid}`), "contact details noted");
  assert.ok(keys.some(k => k.startsWith(`flag:doc:${mid}:payment`)), "payment red flag found in the document text");
  assert.ok(keys.includes(`docdate:${mid}`), "the document states a date after its creation date");
  const before = agg.claims.filter(x => !x.removed).length;
  const cl = await ana.post(`/api/media/${mid}/claims`, {}); assert.equal(cl.status, 200); assert.ok(cl.body.added >= 1);
  agg = (await ana.get(`/api/cases/${id}`)).body; assert.equal(agg.claims.filter(x => !x.removed).length, before + cl.body.added);
  assert.ok(agg.claims.some(x => /M-Pesa|recruit/i.test(x.text)));
  assert.equal((await ana.post(`/api/media/${mid}/claims`, {})).body.added, 0, "the same claims are not added twice");
  assert.equal((await view.post(`/api/media/${mid}/claims`, {})).status, 403);
  const txt = await view.get(`/api/media/${mid}/text`); assert.equal(txt.status, 200); assert.match(txt.body, /RECRUITMENT NOTICE/); assert.match(txt.headers.get("content-disposition"), /attachment/);
  const raw = await fetch(S.base + `/api/media/${mid}/content`, { headers: { cookie: ana.cookie } }); assert.match(raw.headers.get("content-disposition"), /^attachment/, "documents are never shown inline");
  const rep = await ana.get(`/api/cases/${id}/report.json`); assert.ok(rep.body.media.some(x => x.id === mid));
});

test("new case form: text is read from a document without storing it", async () => {
  const fd = () => { const f = new FormData(); return f; };
  const f1 = fd(); f1.append("file", new Blob([await pdf(["Notice: schools close on Monday."])]), "n.pdf");
  const r = await ana.post("/api/extract-text", undefined, { form: f1 }); assert.equal(r.status, 200); assert.equal(r.body.text, "Notice: schools close on Monday."); assert.equal(r.body.scanned, false);
  const f2 = fd(); f2.append("file", new Blob([await pdf(["x"])]), "n.pdf"); assert.equal((await view.post("/api/extract-text", undefined, { form: f2 })).status, 403);
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM media WHERE original_name = 'n.pdf'").get().n, 0, "nothing is stored");
});

test("a PDF whose text cannot be read is still kept as evidence, with a warning and the OCR route", async () => {
  const c = await ana.post("/api/cases", { claim_text: "Damaged circular received by email." });
  const fd = new FormData(); fd.append("files", new Blob([Buffer.from("%PDF-1.4\nthis is not a real pdf body\n%%EOF\n")]), "broken.pdf");
  const u = await ana.post(`/api/cases/${c.body.id}/media`, undefined, { form: fd }); assert.equal(u.status, 201, JSON.stringify(u.body));
  const m = (await ana.get(`/api/cases/${c.body.id}`)).body.media[0]; assert.equal(m.kind, "document"); assert.equal(m.document.chars, 0);
  assert.match(m.document.warnings[0], /could not be read on the server/);
});

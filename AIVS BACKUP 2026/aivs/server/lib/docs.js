// Document text and properties: PDF (pdf.js), Word .docx (built-in ZIP/XML reader), and plain text/CSV/JSON.
// Properties such as author and dates are LEADS: they are easy to edit and are never proof of origin.
import zlib from "node:zlib";
import path from "node:path";
import { createRequire } from "node:module";
import { HttpError } from "./auth.js";

const MAX_TEXT = 500_000, MAX_PAGES = 300, MAX_ENTRY = 50 * 1024 * 1024;
const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));

// ---------------------------------------------------------------- ZIP (central directory; stored and deflate only)
export function unzip(buf, want = () => true) {
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new HttpError(422, "The file is not a valid ZIP-based document.");
  const n = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16); if (n > 5000) throw new HttpError(422, "The document has too many parts.");
  const out = new Map(), names = []; let p = cdOff, total = 0;
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new HttpError(422, "The document structure is damaged.");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl); names.push(name); p += 46 + nl + xl + cl;
    if (!want(name)) continue;
    if (usize > MAX_ENTRY || (total += usize) > 4 * MAX_ENTRY) throw new HttpError(422, "The document expands to an unsafe size and was not opened.");
    const ln = buf.readUInt16LE(lho + 26), lx = buf.readUInt16LE(lho + 28), start = lho + 30 + ln + lx, raw = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }) : null);
  }
  return { files: out, names };
}

const ent = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? ent(m[1]).trim() : null; };

export function docxText(xml) {
  return ent(xml.replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, "")        // deleted (tracked) text is not part of the visible document
    .replace(/<w:tab\/>/g, "\t").replace(/<w:(br|cr)\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, "\u0001$1\u0002")
    .replace(/<[^>]+>/g, "").replace(/\u0001|\u0002/g, "")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function readDocx(buf) {
  const { files, names } = unzip(buf, n => /^(word\/(document|comments)\.xml|docProps\/(core|app)\.xml)$/.test(n));
  if (!files.has("word/document.xml")) {
    const kind = names.some(n => n.startsWith("xl/")) ? "an Excel workbook" : names.some(n => n.startsWith("ppt/")) ? "a PowerPoint file" : names.some(n => n === "content.xml") ? "an OpenDocument file" : "a ZIP archive";
    throw new HttpError(415, `This is ${kind}, not a Word document. Save it as PDF or .docx, or copy the text into Verify information.`);
  }
  const doc = files.get("word/document.xml").toString("utf8"), core = files.get("docProps/core.xml")?.toString("utf8") || "", app = files.get("docProps/app.xml")?.toString("utf8") || "";
  const meta = clean({ Title: tag(core, "dc:title"), Subject: tag(core, "dc:subject"), Author: tag(core, "dc:creator"), LastModifiedBy: tag(core, "cp:lastModifiedBy"), Revision: tag(core, "cp:revision"),
    Created: tag(core, "dcterms:created"), Modified: tag(core, "dcterms:modified"), Application: tag(app, "Application"), AppVersion: tag(app, "AppVersion"), Company: tag(app, "Company"), Template: tag(app, "Template"), EditingMinutes: tag(app, "TotalTime"), Pages: tag(app, "Pages") });
  const warnings = [];
  const ins = (doc.match(/<w:ins\b/g) || []).length, del = (doc.match(/<w:del\b/g) || []).length;
  if (ins || del) warnings.push(`Contains tracked changes (${ins} insertion(s), ${del} deletion(s)). Deleted text is not shown in the text below; open the original in Word to see the edit history.`);
  if (files.has("word/comments.xml")) warnings.push(`Contains ${(files.get("word/comments.xml").toString("utf8").match(/<w:comment\b/g) || []).length} reviewer comment(s). Open the original to read them.`);
  if (names.some(n => /vbaProject\.bin$/i.test(n))) warnings.push("Contains macros (VBA code). AIVS does not run them. Do not open the original with macros enabled.");
  const images = names.filter(n => /^word\/media\//.test(n)).length; if (images) warnings.push(`Contains ${images} embedded picture(s). Their text is not read here; save them and add them to the case as images if they matter.`);
  return { type: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx", extractor: "AIVS DOCX reader", text: docxText(doc), pages: meta.Pages ? Number(meta.Pages) || null : null, meta, warnings, created: meta.Created || null };
}

// PDF date "D:20240305101500+03'00'" -> ISO
export function pdfDate(s) {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(String(s || "").trim()); if (!m) return null;
  const iso = `${m[1]}-${m[2] || "01"}-${m[3] || "01"}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}${m[7] === "Z" || !m[7] ? "Z" : `${m[7]}${m[8] || "00"}:${m[9] || "00"}`}`;
  const d = new Date(iso); return isNaN(d) ? null : d.toISOString();
}
async function readPdf(buf) {
  const raw = buf.toString("latin1");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // load the parser in this process (no separate worker file to locate; avoids path problems on Windows)
  if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  let doc, task; try { task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, standardFontDataUrl: path.join(pdfjsDir, "standard_fonts") + path.sep, verbosity: 0 }); doc = await task.promise; }
  catch (e) { if (/password/i.test(e?.name || e?.message)) throw new HttpError(422, "This PDF is password-protected. Ask for an unprotected copy, or open it and save a copy without a password."); console.error("PDF read error:", e); throw new HttpError(422, `The PDF could not be read (${String(e?.message || e).slice(0, 160)}). If other PDFs open, this one may be damaged.`); }
  const info = (await doc.getMetadata().catch(() => ({}))).info || {};
  const meta = clean({ Title: info.Title, Author: info.Author, Subject: info.Subject, Keywords: info.Keywords, Creator: info.Creator, Producer: info.Producer, Created: pdfDate(info.CreationDate), Modified: pdfDate(info.ModDate), PDFVersion: info.PDFFormatVersion, Pages: String(doc.numPages) });
  const pages = [], warnings = [];
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map(x => x.str + (x.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim());
  }
  if (doc.numPages > MAX_PAGES) warnings.push(`Only the first ${MAX_PAGES} of ${doc.numPages} pages were read.`);
  const empty = pages.filter(p => p.replace(/\s/g, "").length < 10).length, scanned = pages.length > 0 && empty >= Math.ceil(pages.length / 2);   // most pages carry no text layer
  if (scanned) warnings.push("Little or no text layer: this looks like a scanned document or photos of pages. Use “Read text from pages” to read it with OCR.");
  const revisions = (raw.match(/%%EOF/g) || []).length; if (revisions > 1) warnings.push(`The file was saved ${revisions} times (incremental updates). It may have been edited after it was first created; compare versions if the wording matters.`);
  if (/\/JavaScript|\/JS\s*[(<]/.test(raw)) warnings.push("Contains JavaScript. AIVS does not run it. Do not open the original in a PDF reader with scripts enabled.");
  if (info.IsSignaturesPresent) warnings.push("Contains a digital signature field. AIVS does not validate signatures; check it in a PDF reader that verifies signatures.");
  await task.destroy().catch(() => {});
  return { type: "pdf", mime: "application/pdf", ext: "pdf", extractor: "pdf.js (pdfjs-dist)", text: pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\n"), pages: doc.numPages, meta, warnings, created: meta.Created || null, scanned };
}
function clean(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v != null && String(v).trim() !== "") r[k] = String(v).trim().slice(0, 300); return r; }

export function isTextName(name) { return /\.(txt|csv|json|md|text|log)$/i.test(String(name || "")); }
export async function extractDocument(buf, name) {
  let r;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") r = await readPdf(buf);
  else if (buf.readUInt32LE(0) === 0x04034b50) r = readDocx(buf);
  else if (isTextName(name)) {
    const s = buf.toString("utf8").replace(/^﻿/, "");
    if (s.includes("�") && (s.match(/�/g) || []).length > s.length / 50) throw new HttpError(415, `${name}: the text is not UTF-8. Save it as UTF-8 and try again.`);
    const ext = String(name).match(/\.(\w+)$/)[1].toLowerCase();
    r = { type: ext === "json" ? "json" : ext === "csv" ? "csv" : "text", mime: ext === "json" ? "application/json" : ext === "csv" ? "text/csv" : "text/plain", ext, extractor: "UTF-8 text", text: s, pages: null, meta: {}, warnings: [], created: null };
  } else throw new HttpError(415, `${name}: unsupported file type.`);
  r.truncated = r.text.length > MAX_TEXT; if (r.truncated) { r.text = r.text.slice(0, MAX_TEXT); r.warnings.push(`Only the first ${MAX_TEXT.toLocaleString()} characters are kept as text.`); }
  return r;
}

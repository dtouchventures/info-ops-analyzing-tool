// Formal one-page report (Strategic Communication format): layout, Word (.docx), PDF and printable HTML.
// This file only formats. What the report says comes from formal-report.js.
//
// One layout, three outputs. The page is A4 portrait, Arial, single block of text. Every line height is fixed
// (exact line spacing), so the height of the report can be measured before it is produced: text is wrapped with
// the Helvetica metrics built into PDFKit, which are the same character widths as Arial (and as Liberation Sans,
// the Arial-compatible font LibreOffice uses). fit() tries the normal settings first and, only if the text is too
// long, tightens paragraph spacing, then the font size (down to 9 pt), then the margins (down to 1.0 cm). If it
// still does not fit, fits = false and nothing may be downloaded or printed until the text is shortened.
import zlib from "node:zlib";
import fs from "node:fs";
import PDFDocument from "pdfkit";

export const A4 = { w: 595.28, h: 841.89 };             // points
const CM = 28.3465;                                     // points per centimetre
const LINE = 1.15;                                      // line height as a multiple of the font size
const SAFETY = 0.97;                                    // use at most 97% of the usable height (rounding in Word)
export const UNIT_LINE = "UNIT: STRATEGIC COMMUNICATION";
export const CLASSIFICATION = "RESTRICTED";
export const SECTIONS = [["purpose", "1. PURPOSE"], ["background", "2. BACKGROUND"], ["analysis", "3. ANALYSIS"], ["assessment", "5. ASSESSMENT"], ["recommendations", "6. RECOMMENDATIONS"], ["conclusion", "7. CONCLUSION"]];
// tried in this order; the first that fits is used
const STEPS = [];
for (const m of [1.5, 1.27, 1.0]) for (const size of [10, 9.5, 9]) for (const gap of [4, 3, 2, 1]) STEPS.push({ marginCm: m, size, gap });

const letter = i => `(${String.fromCharCode(97 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""})`;
const paras = s => String(s || "").split(/\n+/).map(x => x.trim()).filter(Boolean);

export function assessmentPoints(value) {
  const p = paras(value).map(x => x.replace(/^\(?[a-z]\)[.]?\s+|^[•*-]\s+/i, ""));
  if (p.length > 1) return p;
  return [...new Intl.Segmenter("en-GB", { granularity: "sentence" }).segment(p[0] || "")].map(x => x.segment.trim()).filter(Boolean);
}

// The report as a list of lines of the page, in order. Each block: text runs, alignment, indent and spacing role.
export function blocks(r) {
  const B = [];
  if (CLASSIFICATION) B.push({ role: "classif", align: "center", runs: [{ text: CLASSIFICATION, bold: true }], scale: 1.2 });
  B.push({ role: "top", runs: [{ text: UNIT_LINE, bold: true }], right: String(r.date || "") });
  B.push({ role: "subject", runs: [{ text: "SUBJECT: ", bold: true }, { text: String(r.subject || "").toUpperCase(), bold: true }] });
  for (const [k, head] of SECTIONS) {
    B.push({ role: "head", runs: [{ text: head, bold: true }] });
    if (k === "recommendations") (r.recommendations || []).forEach((t, i) => B.push({ role: "rec", hang: true, label: letter(i), runs: [{ text: t }] }));
    else if (k === "assessment") assessmentPoints(r[k]).forEach((t, i) => B.push({ role: "rec", hang: true, label: letter(i), runs: [{ text: t }] }));
    else paras(r[k]).forEach(t => B.push({ role: "body", runs: [{ text: t }] }));
  }
  return B;
}
// space before each block, in points, for a paragraph gap g
const before = (b, g, prev) => !prev ? 0 : b.role === "classif" ? g : b.role === "subject" ? g * 1.5 + 2 : b.role === "head" ? g * 1.5 + 2 : b.role === "prep" ? g * 2 + 4 : b.role === "prepline" ? 0 : g;
const HANG = 0.75 * CM;

let measurer = null;
function measure() { if (!measurer) { measurer = new PDFDocument({ size: "A4", autoFirstPage: true }); } return measurer; }
const textOf = b => b.runs.map(x => x.text).join("");
const anyBold = b => b.runs.every(x => x.bold);
function lines(doc, b, size, width) {
  const w = width - (b.hang ? HANG : 0), s = size * (b.scale || 1);
  doc.font(anyBold(b) ? "Helvetica-Bold" : "Helvetica").fontSize(s);
  // labels such as "Rank: " are bold: measure the bold part in bold and the rest in regular, as one line of text
  const bold = b.runs.filter(x => x.bold).map(x => x.text).join(""), rest = b.runs.filter(x => !x.bold).map(x => x.text).join("");
  const words = [];
  if (!anyBold(b) && bold) { doc.font("Helvetica-Bold"); words.push(doc.widthOfString(bold)); doc.font("Helvetica"); }
  const text = anyBold(b) ? textOf(b) : rest;
  if (!text.trim()) return 1;
  // greedy wrap, the way Word and LibreOffice wrap: break at spaces; a word longer than the line is split
  let n = 1, x = words[0] || 0;
  const sp = doc.widthOfString(" ");
  for (const word of text.split(/ +/)) {
    let ww = doc.widthOfString(word);
    if (x > 0 && x + ww > w + 0.01) { n++; x = 0; }
    while (ww > w) { n++; ww -= w; }
    x += ww + sp;
  }
  return n;
}

// Height used on the page with given settings, in points, and the height available.
export function measureLayout(r, { marginCm, size, gap }) {
  const doc = measure(), width = A4.w - 2 * marginCm * CM, avail = A4.h - 2 * marginCm * CM;
  let h = 0, prev = null;
  for (const b of blocks(r)) { h += before(b, gap, prev) + lines(doc, b, size, width) * size * (b.scale || 1) * LINE; prev = b; }
  return { used: Math.round(h * 10) / 10, available: Math.round(avail * SAFETY * 10) / 10 };
}
export function fit(r) {
  let last;
  for (const s of STEPS) { const m = measureLayout(r, s); last = { ...s, ...m }; if (m.used <= m.available) return { fits: true, ...last, adjusted: s !== STEPS[0] }; }
  return { fits: false, ...last, over_lines: Math.ceil((last.used - last.available) / (last.size * LINE)) };
}

// ------------------------------------------------------------------ Word (.docx)
const xe = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const tw = pt => Math.round(pt * 20);                   // twentieths of a point
function runXml(t, { bold, sizePt }) {
  return `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/>${bold ? "<w:b/><w:bCs/>" : ""}<w:sz w:val="${Math.round(sizePt * 2)}"/><w:szCs w:val="${Math.round(sizePt * 2)}"/></w:rPr><w:t xml:space="preserve">${xe(t)}</w:t></w:r>`;
}
function paraXml(b, L, prev) {
  const s = L.size * (b.scale || 1), width = A4.w - 2 * L.marginCm * CM;
  const ppr = `<w:pPr><w:widowControl w:val="0"/><w:spacing w:before="${tw(before(b, L.gap, prev))}" w:after="0" w:line="${tw(s * LINE)}" w:lineRule="exact"/>${b.hang ? `<w:tabs><w:tab w:val="left" w:pos="${tw(HANG)}"/></w:tabs><w:ind w:left="${tw(HANG)}" w:hanging="${tw(HANG)}"/>` : b.right ? `<w:tabs><w:tab w:val="right" w:pos="${tw(width) - 2}"/></w:tabs>` : ""}<w:jc w:val="${b.align === "center" ? "center" : "left"}"/></w:pPr>`;
  const label = b.hang ? `${runXml(b.label, { sizePt: s })}<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="${Math.round(s * 2)}"/></w:rPr><w:tab/></w:r>` : "";
  const right = b.right ? `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="${Math.round(s * 2)}"/></w:rPr><w:tab/></w:r>${runXml(b.right, { bold: true, sizePt: s })}` : "";
  return `<w:p>${ppr}${label}${b.runs.filter(x => x.text).map(x => runXml(x.text, { bold: x.bold, sizePt: s })).join("")}${right}</w:p>`;
}
export function docx(r, L) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  let prev = null; const body = blocks(r).map(b => { const x = paraXml(b, L, prev); prev = b; return x; }).join("");
  const m = Math.round(L.marginCm * 567), foot = Math.round(Math.min(0.6, L.marginCm / 2) * 567);
  const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/><w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}" w:header="${foot}" w:footer="${foot}" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>`;
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr>${runXml(CLASSIFICATION, { bold: true, sizePt: L.size * 1.2 })}</w:p></w:ftr>`;
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="${Math.round(L.size * 2)}"/><w:szCs w:val="${Math.round(L.size * 2)}"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`,
    "word/settings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W}><w:zoom w:percent="100"/><w:defaultTabStop w:val="425"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
    "word/footer1.xml": footerXml,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}${sect}</w:body></w:document>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xe(r.subject)}</dc:title><dc:creator>AIVS</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AIVS</Application><Pages>1</Pages></Properties>`
  };
  return zip(Object.entries(files).map(([name, s]) => [name, Buffer.from(s, "utf8")]));
}

// minimal ZIP writer (deflate), enough for an Office document; no extra dependency
function zip(entries) {
  const parts = [], central = []; let off = 0;
  const d = new Date(), dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [name, data] of entries) {
    const nm = Buffer.from(name, "utf8"), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(dosT, 10); h.writeUInt16LE(dosD, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, nm, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(dosT, 12); c.writeUInt16LE(dosD, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

// ------------------------------------------------------------------ PDF (same layout as the Word file)
// Uses Arial when it is installed (Windows), otherwise Helvetica, which has the same character widths.
const ARIAL = [["C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\arialbd.ttf"], ["/usr/share/fonts/truetype/msttcorefonts/Arial.ttf", "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf"]].find(([a, b]) => { try { return fs.existsSync(a) && fs.existsSync(b); } catch { return false; } });
export function pdf(r, L) {
  return new Promise((ok, bad) => {
    const m = L.marginCm * CM, doc = new PDFDocument({ size: "A4", margins: { top: m, bottom: 0, left: m, right: m }, info: { Title: r.subject || "Report", Creator: "AIVS" } });
    const out = []; doc.on("data", c => out.push(c)); doc.on("end", () => ok(Buffer.concat(out))); doc.on("error", bad);
    let R = "Helvetica", Bd = "Helvetica-Bold";
    if (ARIAL) { doc.registerFont("Arial", ARIAL[0]); doc.registerFont("Arial-Bold", ARIAL[1]); R = "Arial"; Bd = "Arial-Bold"; }
    const width = A4.w - 2 * m; let y = m, prev = null;
    for (const b of blocks(r)) {
      const s = L.size * (b.scale || 1), lh = s * LINE;
      y += before(b, L.gap, prev); prev = b;
      doc.fontSize(s); doc.font(R); const gapPt = lh - doc.currentLineHeight(true);
      const x0 = m + (b.hang ? HANG : 0), w = width - (b.hang ? HANG : 0);
      const o = { width: w, lineGap: gapPt, align: b.align === "center" ? "center" : "left" };
      if (b.hang) doc.font(R).text(b.label, m, y, { lineBreak: false });
      if (b.right) doc.font(Bd).text(b.right, m, y, { width, align: "right", lineBreak: false });
      b.runs.forEach((x, i) => { doc.font(x.bold ? Bd : R); const oo = { ...o, continued: i < b.runs.length - 1 }; const t = x.text || " "; if (i === 0) doc.text(t, x0, y, oo); else doc.text(t, oo); });
      y = doc.y;
    }
    doc.font(Bd).fontSize(L.size * 1.2).text(CLASSIFICATION, m, A4.h - Math.min(0.6, L.marginCm / 2) * CM - L.size * 1.2 * LINE, { width, align: "center", lineBreak: false });
    doc.end();
  });
}

// ------------------------------------------------------------------ printable HTML (preview and Print Report)
const he = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function html(r, L, { problems = [], fits = true } = {}) {
  let prev = null;
  const rows = blocks(r).map(b => {
    const s = L.size * (b.scale || 1), st = `margin-top:${before(b, L.gap, prev)}pt;font-size:${s}pt;line-height:${(s * LINE).toFixed(2)}pt;${b.align === "center" ? "text-align:center;" : ""}${b.hang ? `padding-left:${HANG.toFixed(2)}pt;text-indent:-${HANG.toFixed(2)}pt;` : ""}`;
    prev = b;
    return `<p style="${st}">${b.right ? `<b style="float:right">${he(b.right)}</b>` : ""}${b.hang ? `<span class="lab">${he(b.label)}</span>` : ""}${b.runs.map(x => x.bold ? `<b>${he(x.text)}</b>` : he(x.text)).join("")}</p>`;
  }).join("");
  const m = L.marginCm;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${he(r.subject || "Report")}</title><style>
@page { size: A4 portrait; margin: 0 }
* { box-sizing: border-box }
html, body { margin: 0; background: #e9ecef; font-family: Arial, "Liberation Sans", Helvetica, sans-serif; color: #000 }
.page { width: 210mm; height: 297mm; margin: 12px auto; background: #fff; padding: ${m}cm; position: relative; overflow: hidden; box-shadow: 0 1px 6px rgba(0,0,0,.25) }
.page p { margin: 0; white-space: pre-wrap; word-wrap: break-word }
.lab { display: inline-block; width: ${HANG.toFixed(2)}pt; text-indent: 0 }
.foot { position: absolute; left: 0; right: 0; bottom: ${Math.min(0.6, m / 2)}cm; text-align: center; font-weight: bold; font-size: ${(L.size * 1.2).toFixed(1)}pt; line-height: ${(L.size * 1.2 * LINE).toFixed(2)}pt }
.warn { max-width: 210mm; margin: 12px auto 0; background: #fff3cd; border: 1px solid #e0b100; padding: 8px 12px; font-size: 13px }
@media print { html, body { background: #fff } .page { margin: 0; box-shadow: none } .warn { display: none } }
</style></head><body>${!fits || problems.length ? `<div class="warn"><b>Not ready to print.</b> ${he([!fits ? "The text does not fit on one A4 page: shorten it." : "", ...problems].filter(Boolean).join(" "))}</div>` : ""}<div class="page">${rows}<div class="foot">${CLASSIFICATION}</div></div></body></html>`;
}

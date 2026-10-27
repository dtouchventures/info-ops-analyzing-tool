// PDF rendering of a verification report from its stored JSON (pdfkit, standard fonts, no network).
// An approved report is rendered from the frozen JSON, so the PDF says exactly what was approved.
import PDFDocument from "pdfkit";

const fmt = iso => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
// standard PDF fonts cover Latin-1 plus common punctuation; replace anything else so text never disappears
const safe = s => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
const NAVY = "#0b1f3a", MUTED = "#44596c", LINE = "#c9d6dd";

export function reportPdf(d, { approved, sha256 = null, reportId = null }) {
  const doc = new PDFDocument({ size: "A4", margins: { top: 54, bottom: 60, left: 54, right: 54 }, bufferPages: true, info: { Title: `${d.case.id} verification report`, Author: "AIVS", Subject: d.case.title } });
  const chunks = []; doc.on("data", c => chunks.push(c));
  const W = doc.page.width - 108;
  const h2 = t => { doc.moveDown(0.8); doc.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text(safe(t).toUpperCase()); const y = doc.y + 2; doc.moveTo(54, y).lineTo(54 + W, y).lineWidth(1.2).strokeColor(NAVY).stroke(); doc.moveDown(0.5); };
  const p = (t, o = {}) => doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(o.size || 9.5).fillColor(o.color || NAVY).text(safe(t), { width: W, ...o.opts });
  const small = t => p(t, { size: 8, color: MUTED });
  const banner = (t, color) => { const y = doc.y; doc.rect(54, y, W, 22).fill(color); doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9.5).text(safe(t), 62, y + 6, { width: W - 16 }); doc.y = y + 30; doc.x = 54; };

  if (d.case.training) banner("TRAINING CASE - synthetic material for practice. Not an operational assessment.", "#5b3fc4");
  if (!approved) banner(`DRAFT - not approved (status: ${d.case.status}). Do not rely on or circulate this assessment.`, "#8a5300");
  p("Information Verification Report", { bold: true, size: 17 });
  small(`AIVS · ${d.case.id} · revision ${d.case.revision} · ${d.case.status}${reportId ? ` · report ${reportId}` : ""} · generated ${fmt(d.generated_at)}`);
  doc.moveDown(0.6);
  const meta = [["Title", d.case.title], ["Source", `${d.case.source.platform}${d.case.source.account ? ` · ${d.case.source.account}` : ""}`], ["Link / reference", d.case.source.url || "—"],
    ["Received", fmt(d.case.dates.received_at)], ["Published (per source)", d.case.dates.published_at ? `${fmt(d.case.dates.published_at)}${d.case.dates.published_basis ? ` - ${d.case.dates.published_basis}` : ""}` : "Not established"],
    ["Claimed event date", d.case.dates.claimed_event_at ? fmt(d.case.dates.claimed_event_at) : (d.case.dates.claimed_event_basis || "Not stated")], ["Analyst", d.case.assigned_analyst || "—"],
    ...(d.topic ? [["Topic", d.topic]] : []), ...(d.hashtags?.length ? [["Hashtags", d.hashtags.join(" ")]] : [])];
  for (const [k, v] of meta) { doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY).text(`${safe(k)}: `, { continued: true, width: W }).font("Helvetica").text(safe(v)); }

  h2("Methodology"); (d.methodology || []).forEach((m, i) => p(`${i + 1}. ${m}`, { size: 9 }));
  h2("1. Content as received"); p(d.case.claim_as_received, { size: 9 });
  h2("2. Conclusion");
  p((d.conclusion.label || "Not concluded").toUpperCase(), { bold: true, size: 13 });
  p(`Reasoning: ${d.conclusion.rationale || "—"}`); doc.moveDown(0.3); p(`Remaining uncertainties: ${d.conclusion.uncertainties || "—"}`);
  h2("3. Claim-by-claim findings");
  for (const x of d.claims) {
    p(`Claim ${x.number}: ${x.text}`, { bold: true });
    small(`${x.type}${x.statement_type && x.statement_type !== "factual" ? ` · ${x.statement_type}` : ""} · ${x.origin}`);
    p(`Verdict: ${x.assessment_label || x.assessment}${x.evidence_strength ? `   ·   Evidence strength: ${x.evidence_strength.label}` : ""}`);
    if (x.rationale) p(`Rationale: ${x.rationale}`, { size: 9 });
    if (x.system_suggestion?.label) small(`AIVS suggestion (not a decision): ${x.system_suggestion.label}. ${x.system_suggestion.basis || ""}`);
    small(`Evidence: ${x.evidence.map(e => `${e.id} (${e.stance})`).join(", ") || "none linked"}`);
    doc.moveDown(0.4);
  }
  h2("4. Evidence relied on");
  for (const e of d.evidence) {
    p(`${e.id} · ${e.kind.replace("_", " ")} · ${e.origin === "analyst" ? "analyst" : `${e.origin} suggestion, accepted by analyst`}`, { bold: true, size: 9 });
    p(e.text, { size: 9 });
    if (e.citation) {
      doc.font("Helvetica").fontSize(8.5).fillColor("#1c5d99").text(safe(e.citation.title || e.citation.url), { width: W, link: e.citation.url, underline: true });
      small(`${e.citation.url}${e.citation.publisher ? ` · ${e.citation.publisher}` : ""}${e.citation.published_at ? ` · ${String(e.citation.published_at).slice(0, 10)}` : ""}${e.citation.rating ? ` · rated "${e.citation.rating}"` : ""}${e.citation.found_by ? ` · found by ${e.citation.found_by}` : ""}`);
    } else small(`Reference: ${e.reference}`);
    doc.moveDown(0.3);
  }
  if (!d.evidence.length) small("No accepted evidence.");
  if (d.media?.length) { h2("5. Media examined"); for (const m of d.media) small(`${m.id} · ${m.name} · ${m.mime} · SHA-256 ${m.sha256}`); }
  h2("Limitations"); (d.limitations || []).forEach(l => p(`• ${l}`, { size: 9 }));
  h2("Review and approval");
  p(approved ? `Approved by ${d.case.decided_by} (signed-in reviewer) on ${fmt(d.case.decided_at)}.` : `Not approved. Status: ${d.case.status}.`, { bold: true });
  if (d.case.reviewer_comment) p(`Reviewer comment: ${d.case.reviewer_comment}`, { size: 9 });
  small(d.review?.note || "");
  if (sha256) small(`Frozen report fingerprint (SHA-256 of the report JSON): ${sha256}`);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(safe(`${d.case.id} · ${approved ? "approved report" : "DRAFT"} · page ${i + 1} of ${range.count}`), 54, doc.page.height - 40, { width: W, align: "center", lineBreak: false });
  }
  doc.end();
  return new Promise(ok => doc.on("end", () => ok(Buffer.concat(chunks))));
}

// CSV: one row per claim, then one row per accepted evidence item (RFC 4180 quoting; formulas neutralised)
export function reportCsv(d) {
  const q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const rows = [["record", "case_id", "revision", "number_or_id", "text", "verdict_or_kind", "evidence_strength", "rationale_or_reference", "citation_url", "publisher", "published_at", "rating", "linked"]];
  for (const x of d.claims) rows.push(["claim", d.case.id, d.case.revision, x.number, x.text, x.assessment_label || x.assessment, x.evidence_strength?.label || "", x.rationale || "", "", "", "", "", x.evidence.map(e => `${e.id}:${e.stance}`).join(" ")]);
  for (const e of d.evidence) rows.push(["evidence", d.case.id, d.case.revision, e.id, e.text, e.kind, "", e.reference, e.citation?.url || "", e.citation?.publisher || "", e.citation?.published_at || e.source_date || "", e.citation?.rating || "", ""]);
  rows.push(["conclusion", d.case.id, d.case.revision, "", d.conclusion.rationale || "", d.conclusion.label || "", "", d.conclusion.uncertainties || "", "", "", "", "", d.review?.approved ? `approved by ${d.case.decided_by}` : "not approved"]);
  return "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n") + "\r\n";
}

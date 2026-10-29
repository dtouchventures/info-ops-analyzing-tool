// Verification report: a structured JSON record plus a self-contained printable HTML rendering.
// Approved reports are frozen (stored with a SHA-256 of the JSON) at the moment of approval.
import crypto from "node:crypto";
import { STATES, CONCLUSIONS } from "./cases.js";
import { VERDICTS, STRENGTH_LABELS } from "../../shared/verdict.js";
import { TOPICS } from "../../shared/text.js";
import { LOCATION_SOURCES } from "../../shared/account-location.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = iso => iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
const refUrl = r => { const m = String(r || "").match(/https?:\/\/[^\s<>"]+/); return m ? m[0].replace(/[).,;]+$/, "") : null; };
const KIND = { observation: "Observed detail", source_claim: "Source statement", inference: "Analyst inference", lead: "Investigative lead" };
const ASSESS = { ...VERDICTS, unassessed: "Not assessed" };
const CONNECTOR = { factcheck: "Google Fact Check Tools", web: "Web search (Brave)", official: "Official and fact-checking sources", kb: "AIVS knowledge base", holdings: "Earlier AIVS investigations", news: "News coverage index (GDELT)", reference: "Wikipedia" };

export function makeReports(db, { cases, storage }) {
  function data(caseId) {
    cases.assertReportClaims(caseId);
    const a = cases.aggregate(caseId), c = a.case, u = id => (id ? a.users[id] || "unknown" : null);
    const claims = a.claims.filter(x => !x.removed);
    const accepted = a.evidence.filter(e => e.status === "accepted");
    const caseAudit = db.prepare("SELECT at, username, action FROM audit_log WHERE entity = 'case' AND entity_id = ? ORDER BY id").all(caseId);
    return {
      schema: "aivs-report/1", generated_at: new Date().toISOString(),
      case: { id: c.id, revision: c.revision, version: c.version, training: !!c.is_training, title: c.title, status: STATES[c.status], priority: c.priority,
        claim_as_received: c.claim_text_original, claim_working_text: c.claim_text,
        source: { platform: c.source_platform, url: c.source_url, account: c.source_account,
          account_location: c.account_location ? { location: c.account_location, source: c.account_location_source, source_label: LOCATION_SOURCES[c.account_location_source] || c.account_location_source, basis: c.account_location_basis,
            screenshot_media_id: c.account_location_media_id, recorded_by: u(c.account_location_by), recorded_at: c.account_location_at,
            note: c.account_location_source === "profile_self_reported" ? "Stated by the account itself; not verified. It does not show where any post was made." : "As stated by the platform about the account; not verified by AIVS. It does not show where any post was made, and an account can be run from elsewhere." } : null },
        dates: { received_at: c.received_at, published_at: c.published_at, published_basis: c.published_basis, claimed_event_at: c.claimed_event_at, claimed_event_basis: c.claimed_event_basis },
        assigned_analyst: c.assigned?.name || null, submitted_by: u(c.submitted_by), submitted_at: c.submitted_at, decided_by: u(c.decided_by), decided_at: c.decided_at, reviewer_comment: c.reviewer_comment },
      conclusion: { value: c.conclusion, label: CONCLUSIONS[c.conclusion] || null, rationale: c.conclusion_rationale, uncertainties: c.uncertainties, briefing_summary: c.brief },
      claims: claims.map(cl => ({ id: cl.id, number: cl.seq, text: cl.text, type: cl.kind, statement_type: cl.claim_type || null, origin: cl.origin, assessment: cl.assessment, assessment_label: ASSESS[cl.assessment], rationale: cl.rationale, assessed_by: u(cl.assessed_by),
        evidence_strength: cl.strength ? { level: cl.strength.level, label: STRENGTH_LABELS[cl.strength.level], reasons: cl.strength.reasons } : null,
        system_suggestion: cl.suggested_assessment || cl.suggested_basis ? { verdict: cl.suggested_assessment, label: VERDICTS[cl.suggested_assessment] || null, basis: cl.suggested_basis, note: "Suggested by AIVS from published ratings; not a reviewer decision" } : null,
        evidence: accepted.filter(e => e.links.some(l => l.claim_id === cl.id)).map(e => ({ id: e.id, stance: e.links.find(l => l.claim_id === cl.id).stance })) })),
      evidence: accepted.map(e => ({ id: e.id, kind: e.kind, origin: e.origin, text: e.text, reference: e.reference,
        citation: (e.source_url || refUrl(e.reference)) ? { url: e.source_url || refUrl(e.reference), title: e.source_title, publisher: e.source_publisher, published_at: e.source_published_at, rating: e.rating, found_by: CONNECTOR[e.connector] || null, retrieved_at: e.retrieved_at, archived_copy_sha256: e.snapshot_sha256 || null } : null, source_date: e.source_date || null, corrections: (e.versions || []).length, uncertainty: e.uncertainty, media_id: e.media_id, archive_id: e.archive_id, related_case_id: e.related_case_id, ai_run_id: e.ai_run_id, accepted_by: u(e.decided_by), links: e.links.map(l => ({ claim_id: l.claim_id, stance: l.stance })) })),
      dismissed_suggestions: a.evidence.filter(e => e.status === "dismissed").length,
      media: a.media.map(m => ({ id: m.id, name: m.original_name, kind: m.kind, mime: m.mime, size: m.size, sha256: m.sha256, width: m.width, height: m.height, frame_of: m.parent_media_id, frame_time_s: m.frame_time, frame_origin: m.frame_origin, metadata_capture_at: m.meta_capture_at, metadata: m.metadata, dhash: m.dhash, phash: m.phash, uploaded_at: m.uploaded_at, thumb: m.thumb_sha256 })),
      matches: a.matches.map(x => ({ media_id: x.media_id, kind: x.kind, level: x.level, archive_id: x.target_archive_id, archive_title: x.archive_title, archive_date: x.archive_date, case_id: x.target_case_id, dhash_distance: x.dhash_distance, phash_distance: x.phash_distance, combined_distance: x.score, window: x.window_label, mirrored: !!x.mirrored, target_media_id: x.target_media_id })),
      ocr: a.ocr.map(o => ({ id: o.id, media_id: o.media_id, engine: o.engine, lang: o.lang, confidence: o.confidence, original_text: o.original_text, current_text: o.current_text, corrections: o.versions.length })),
      checklist: a.checklist.map(k => ({ step: k.label, state: k.state, note: k.note })),
      ai_runs: a.aiRuns.map(r => ({ id: r.id, provider: r.provider, model: r.model, prompt_version: r.prompt_version, status: r.status, started_at: r.started_at, duration_ms: r.duration_ms, requested_by: u(r.requested_by) })),
      thresholds: a.thresholds,
      topic: c.topic ? TOPICS[c.topic] : null, hashtags: c.hashtags || [],
      related_cases: (a.related || []).map(r => ({ id: r.id, relation: r.relation, title: r.title, status: STATES[r.status] })),
      methodology: methodology(a),
      limitations: limitations(a),
      review: { status: STATES[c.status], approved: ["approved", "archived"].includes(c.status) && !!c.decided_by, decided_by: u(c.decided_by), decided_at: c.decided_at, comment: c.reviewer_comment,
        note: "Verdicts are recorded by the analyst and approved by a different, signed-in reviewer. Suggestions made by AIVS or AI are labelled as such and are not decisions." },
      audit: caseAudit
    };
  }
  function methodology(a) {
    const steps = ["The content was preserved exactly as received; the working copy is versioned."];
    if (a.case.source_snapshot_sha256) steps.push(`The source page was retrieved by the AIVS server on ${fmt(a.case.source_fetched_at)} and archived unchanged (SHA-256 ${a.case.source_snapshot_sha256}).`);
    steps.push("The text was split into separate claims; statements that are opinions, predictions, satire, questions or calls to action were flagged as not checkable as true or false.");
    if (a.media.length) steps.push(`${a.media.length} media file(s) were fingerprinted (SHA-256) and compared with the reference archive and earlier cases using perceptual hashes; embedded metadata was read as a lead.`);
    if (a.ocr.length) steps.push(`Visible text was read from ${a.ocr.length} image(s) and checked by the analyst.`);
    const used = [...new Set((a.retrievals || []).filter(r => r.status === "ok").map(r => CONNECTOR[r.connector] || r.connector))];
    steps.push(used.length ? `Evidence was searched with: ${used.join(", ")}. Results were stored as suggestions and only count once an analyst accepted them.` : "No automated evidence search was run; evidence was gathered by the analyst.");
    steps.push("Each claim received its own verdict and rationale, with linked evidence. The overall conclusion follows from the claim verdicts.");
    return steps;
  }
  function limitations(a) {
    const l = [];
    if (a.case.uncertainties) l.push(`Analyst: ${a.case.uncertainties}`);
    const failed = (a.retrievals || []).filter(r => r.status === "error"); if (failed.length) l.push(`${failed.length} evidence search request(s) failed and returned nothing.`);
    l.push("Search services and datasets cover only what they index; absence of evidence is not evidence of absence.");
    l.push("Perceptual similarity and metadata are investigative leads, not proof. No automated tool here can establish that media is AI-generated.");
    return l;
  }
  const thumb = sha => { try { return sha ? `data:image/jpeg;base64,${storage.read(sha).toString("base64")}` : null; } catch { return null; } };

  function html(d, { approved }) {
    const c = d.case, k = d.conclusion, cls = { supported: "sup", contradicted: "con", mixed: "mix", insufficient: "unr", partially_supported: "mix", misleading_context: "con", not_verifiable: "unr" }[k.value] || "";
    const evById = Object.fromEntries(d.evidence.map(e => [e.id, e]));
    const archThumb = id => { const m = db.prepare("SELECT thumb_sha256 FROM media WHERE id = ?").get(id); return thumb(m?.thumb_sha256); };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.id)} verification report</title>
<style>
body{font:13px/1.5 "Segoe UI",system-ui,-apple-system,Arial,sans-serif;color:#0b1f3a;max-width:900px;margin:0 auto;padding:28px 24px;background:#fff}
h1{font-size:20px;margin:0} h2{font-size:14px;margin:22px 0 8px;padding-bottom:4px;border-bottom:2px solid #0b1f3a;text-transform:uppercase;letter-spacing:.04em}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;background:#f2f6f8;border:1px solid #d5e0e6;padding:10px 12px;margin-top:12px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px} th,td{border:1px solid #c9d6dd;padding:5px 7px;text-align:left;vertical-align:top} th{background:#e8f0f3}
.banner{padding:8px 12px;font-weight:700;border:1px solid}
.draft{background:#fff7e0;border-color:#c99a00;color:#6b5000} .train{background:#efe9ff;border-color:#6b4fc8;color:#3f2a8a}
.verdict{border:2px solid #0b1f3a;padding:10px;text-align:center;font-weight:800;font-size:16px;margin:8px 0}
.sup{color:#0b6b3a;border-color:#0b6b3a} .con{color:#a3161c;border-color:#a3161c} .mix{color:#7a4b00;border-color:#7a4b00} .unr{color:#555;border-color:#777}
.imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px} .imgs figure{margin:0} .imgs img{width:100%;border:1px solid #c9d6dd} figcaption{font-size:11px;color:#3d5566}
.mono{font-family:Consolas,ui-monospace,monospace;font-size:11px;word-break:break-all} pre{white-space:pre-wrap;background:#f6f8f9;border:1px solid #dde5ea;padding:8px;font-size:11.5px}
.small{font-size:11px;color:#3d5566} @media print{body{padding:0}}
</style></head><body>
${c.training ? `<div class="banner train">TRAINING CASE — synthetic material for practice. Not an operational assessment.</div>` : ""}
${approved ? "" : `<div class="banner draft">DRAFT — not approved. Do not rely on or circulate this assessment.</div>`}
<div style="display:flex;justify-content:space-between;gap:12px;margin-top:10px"><div><h1>Information Verification Report</h1><div class="small">AIVS · Information Operations verification workflow</div></div>
<div style="text-align:right"><b>${esc(c.id)}</b><br>Revision ${c.revision} · version ${c.version}<br>${esc(c.status)}</div></div>
<div class="meta"><div><b>Title:</b> ${esc(c.title)}</div><div><b>Priority:</b> ${esc(c.priority)}</div>
<div><b>Source:</b> ${esc(c.source.platform)}${c.source.account ? ` · ${esc(c.source.account)}` : ""}</div><div><b>Link / reference:</b> ${esc(c.source.url || "—")}</div>
${c.source.account_location ? `<div style="grid-column:1/-1"><b>Account location:</b> ${esc(c.source.account_location.location)} — ${esc(c.source.account_location.source_label)}${c.source.account_location.screenshot_media_id ? `, screenshot ${esc(c.source.account_location.screenshot_media_id)}` : ""}${c.source.account_location.basis ? `; ${esc(c.source.account_location.basis)}` : ""}; recorded by ${esc(c.source.account_location.recorded_by || "—")} ${fmt(c.source.account_location.recorded_at)}<div class="small">${esc(c.source.account_location.note)}</div></div>` : ""}
<div><b>Received:</b> ${fmt(c.dates.received_at)}</div><div><b>Published (per source):</b> ${c.dates.published_at ? fmt(c.dates.published_at) + (c.dates.published_basis ? ` — ${esc(c.dates.published_basis)}` : "") : "Not established"}</div>
<div><b>Claimed event date:</b> ${c.dates.claimed_event_at ? fmt(c.dates.claimed_event_at) + (c.dates.claimed_event_basis ? ` — ${esc(c.dates.claimed_event_basis)}` : "") : "Not stated"}</div><div><b>Analyst:</b> ${esc(c.assigned_analyst || "—")}</div></div>

<h2>Methodology</h2><ol class="small" style="margin:0 0 0 18px">${d.methodology.map(m => `<li>${esc(m)}</li>`).join("")}</ol>
${d.topic || d.hashtags.length ? `<p class="small">${d.topic ? `Topic: ${esc(d.topic)}. ` : ""}${d.hashtags.length ? `Hashtags: ${esc(d.hashtags.join(" "))}` : ""}</p>` : ""}
<h2>1. Content as received</h2><pre>${esc(c.claim_as_received)}</pre>
${c.claim_working_text !== c.claim_as_received ? `<div class="small">Working text used for analysis (edited by the analyst):</div><pre>${esc(c.claim_working_text)}</pre>` : ""}

<h2>2. Conclusion</h2>
<div class="verdict ${cls}">${esc((k.label || "Not concluded").toUpperCase())}</div>
<p><b>Reasoning.</b> ${esc(k.rationale || "—")}</p><p><b>Remaining uncertainties.</b> ${esc(k.uncertainties || "—")}</p>
${k.briefing_summary ? `<p><b>Summary for briefing</b></p><pre>${esc(k.briefing_summary)}</pre>` : ""}

<h2>3. Claim-by-claim findings</h2>
<table><tr><th style="width:28px">#</th><th>Claim</th><th style="width:120px">Verdict</th><th>Rationale</th><th style="width:120px">Evidence</th></tr>
${d.claims.map(x => `<tr><td>${x.number}</td><td>${esc(x.text)}<div class="small">${esc(x.type)} · ${esc(x.origin)}${x.statement_type && x.statement_type !== "factual" ? ` · ${esc(x.statement_type)}` : ""}</div></td><td><b>${ASSESS[x.assessment]}</b>${x.evidence_strength ? `<div class="small">Evidence strength: ${esc(x.evidence_strength.label)}</div>` : ""}</td><td>${esc(x.rationale || "")}${x.system_suggestion?.label ? `<div class="small">AIVS suggestion (not a decision): ${esc(x.system_suggestion.label)}</div>` : ""}</td><td class="mono">${x.evidence.map(e => `${esc(e.id)} (${e.stance})`).join("<br>") || "—"}</td></tr>`).join("")}</table>

<h2>4. Evidence relied on</h2>
<p class="small">Observed details are what can be seen directly; source statements are what a source says; analyst inferences are reasoning; investigative leads (archive similarity, metadata) point to checks and are not proof on their own.</p>
<table><tr><th style="width:80px">ID</th><th style="width:110px">Type</th><th>Finding</th><th>Reference</th></tr>
${d.evidence.map(e => `<tr><td class="mono">${esc(e.id)}</td><td>${KIND[e.kind]}<div class="small">${esc(e.origin === "ai" ? "AI-suggested, analyst-accepted" : e.origin === "system" ? "System lead, analyst-accepted" : "Analyst")}</div></td><td>${esc(e.text)}${e.uncertainty ? `<div class="small">Uncertainty: ${esc(e.uncertainty)}</div>` : ""}</td><td>${e.citation ? `<a href="${esc(e.citation.url)}">${esc(e.citation.title || e.citation.url)}</a><div class="small">${esc(e.citation.publisher || "")}${e.citation.published_at ? ` · ${esc(String(e.citation.published_at).slice(0, 10))}` : ""}${e.citation.rating ? ` · rated “${esc(e.citation.rating)}”` : ""}${e.citation.found_by ? ` · found by ${esc(e.citation.found_by)}` : ""}${e.citation.archived_copy_sha256 ? ` · archived copy ${esc(e.citation.archived_copy_sha256.slice(0, 12))}…` : ""}</div>` : esc(e.reference)}${e.source_date ? `<div class="small">Source dated ${esc(e.source_date)}</div>` : ""}${e.corrections ? `<div class="small">Corrected ${e.corrections}× by analyst (earlier wording in case history)</div>` : ""}</td></tr>`).join("") || `<tr><td colspan="4">None</td></tr>`}</table>
<p class="small">${d.dismissed_suggestions} system or AI suggestion(s) were reviewed and dismissed.</p>

<h2>5. Media examined</h2>
<div class="imgs">${d.media.filter(m => m.thumb).map(m => `<figure><img src="${thumb(m.thumb)}" alt=""><figcaption>${esc(m.id)} · ${esc(m.name)}${m.frame_of ? ` · frame at ${m.frame_time_s?.toFixed(2)} s of ${esc(m.frame_of)}` : ""}</figcaption></figure>`).join("")}</div>
<table><tr><th>Media</th><th>SHA-256 (original bytes)</th><th>Metadata (lead only)</th></tr>
${d.media.map(m => `<tr><td>${esc(m.id)}<div class="small">${esc(m.name)} · ${esc(m.mime)} · ${(m.size / 1024).toFixed(0)} KB${m.width ? ` · ${m.width}×${m.height}` : ""}</div></td><td class="mono">${esc(m.sha256)}</td><td>${Object.entries(m.metadata || {}).map(([a, b]) => `${esc(a)}: ${esc(b)}`).join("<br>") || "None"}</td></tr>`).join("")}</table>

<h2>6. Matches found</h2>
<p class="small">“Identical” means the same file bytes (equal SHA-256). Other matches are perceptual similarity: the number of differing bits between image fingerprints (0–128; lower is more similar; strong ≤ ${d.thresholds.strong}, possible ≤ ${d.thresholds.possible}). These are not probabilities that two images show the same event.</p>
<table><tr><th>Media</th><th>Match</th><th>Target</th><th>Distance</th></tr>
${d.matches.map(x => `<tr><td class="mono">${esc(x.media_id)}</td><td>${esc(x.level)} (${esc(x.kind)})${x.mirrored ? ", mirrored" : ""}</td><td>${x.archive_id ? `Archive ${esc(x.archive_id)} “${esc(x.archive_title)}”, documented ${esc(x.archive_date)}` : `Case ${esc(x.case_id)}`}</td><td>${x.kind === "exact" ? "identical bytes" : `${x.dhash_distance} + ${x.phash_distance} = ${x.combined_distance}; ${esc(x.window)}`}</td></tr>`).join("") || `<tr><td colspan="4">No matches in the reference archive or other cases. This does not establish that the media is new or authentic.</td></tr>`}</table>
${d.matches.filter(x => x.archive_id && x.kind === "perceptual" && x.level === "strong").slice(0, 2).map(x => { const sub = d.media.find(m => m.id === x.media_id); const at = archThumb(x.target_media_id); return sub?.thumb && at ? `<div class="imgs" style="grid-template-columns:1fr 1fr;margin-top:8px"><figure><img src="${thumb(sub.thumb)}" alt=""><figcaption>Submitted ${esc(sub.id)}</figcaption></figure><figure><img src="${at}" alt=""><figcaption>Archive ${esc(x.archive_id)} (${esc(x.archive_date)})</figcaption></figure></div>` : ""; }).join("")}

${d.ocr.length ? `<h2>7. Visible text</h2>${d.ocr.map(o => `<p class="small">${esc(o.media_id)} · ${esc(o.engine)} · ${esc(o.lang)}${o.confidence != null ? ` · mean confidence ${Math.round(o.confidence)}%` : ""} · ${o.corrections} correction(s)</p><pre>${esc(o.current_text)}</pre>${o.corrections ? `<details><summary class="small">Original extraction</summary><pre>${esc(o.original_text)}</pre></details>` : ""}`).join("")}` : ""}

<h2>8. Verification checklist</h2>
<table><tr><th>Step</th><th style="width:110px">Status</th><th>Note</th></tr>${d.checklist.map(x => `<tr><td>${esc(x.step)}</td><td>${x.state === "done" ? "Done" : x.state === "na" ? "Not applicable" : "Not done"}</td><td>${esc(x.note || "")}</td></tr>`).join("")}</table>

${d.ai_runs.length ? `<h2>9. AI assistance</h2><table><tr><th>Run</th><th>Provider / model</th><th>Prompt version</th><th>Status</th><th>Requested by</th></tr>${d.ai_runs.map(r => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.provider)} / ${esc(r.model)}</td><td class="mono">${esc(r.prompt_version)}</td><td>${esc(r.status)}</td><td>${esc(r.requested_by)}</td></tr>`).join("")}</table><p class="small">AI output was treated as suggestions. Only items an analyst accepted appear in the evidence above.</p>` : ""}

<h2>Limitations</h2><ul class="small" style="margin:0 0 0 18px">${d.limitations.map(m => `<li>${esc(m)}</li>`).join("")}</ul>
${d.related_cases.length ? `<h2>Related cases</h2><p class="small">${d.related_cases.map(r => `${esc(r.id)} (${esc(r.relation.replace(/_/g, " "))}) — ${esc(r.title)} · ${esc(r.status)}`).join("<br>")}</p>` : ""}
<h2>Review and approval</h2>
<p>Submitted by <b>${esc(c.submitted_by || "—")}</b> ${c.submitted_at ? `on ${fmt(c.submitted_at)}` : ""}. ${approved ? `Approved by <b>${esc(c.decided_by)}</b> (signed-in reviewer) on ${fmt(c.decided_at)}.` : `<b>Not approved.</b> Status: ${esc(c.status)}.`}${c.reviewer_comment ? ` Reviewer comment: ${esc(c.reviewer_comment)}` : ""}</p>
<details><summary class="small">Case audit trail (${d.audit.length} entries)</summary><table><tr><th style="width:150px">Time</th><th style="width:110px">User</th><th>Action</th></tr>${d.audit.map(x => `<tr><td>${fmt(x.at)}</td><td>${esc(x.username)}</td><td>${esc(x.action)}</td></tr>`).join("")}</table></details>
<p class="small" style="margin-top:20px">Automated checks organise evidence for the analyst; they do not decide. Metadata and archive similarity are investigative leads. The absence of an archive match does not establish authenticity. Visual inspection alone does not prove AI generation or manipulation.</p>
</body></html>`;
  }

  function render(caseId) {
    const d = data(caseId), c = cases.getCase(caseId), approved = ["approved", "archived"].includes(c.status);
    const json = JSON.stringify(d, null, 2);
    return { json, html: html(d, { approved }), sha256: crypto.createHash("sha256").update(json).digest("hex"), data: d };
  }
  return { data, render };
}

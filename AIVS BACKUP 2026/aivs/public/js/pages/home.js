// Start page: the eight AIVS modules, each with an honest status (available, partly available, planned).
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, icon, modal } from "../ui.js";

// What exists today, and what each planned module will need. Keep this in step with docs/ROADMAP.md.
function modules() {
  const ai = App.meta.ai, admin = App.can("settings.manage");
  return [
    { key: "verify", icon: "verify", title: "Verify information", text: "Paste a claim, article text or a link. AIVS retrieves the page, keeps an archived copy and splits the content into separate claims to check.",
      status: "available", href: App.can("case.create") ? "#/verify" : null, cta: "Start verifying" },
    { key: "upload", icon: "upload", title: "Upload files", text: "Images, video and documents: fingerprints, archive matching, metadata, offline text reading (English and Kiswahili), video frames, and text and properties from PDF, Word (.docx), TXT, CSV and JSON, including OCR of scanned PDFs.",
      status: "partial", href: App.can("case.create") ? "#/new" : null, cta: "Upload files",
      missing: "Speech-to-text for video and audio is not built yet (it needs a transcription service or a local speech model). Older Word (.doc), Excel and PowerPoint files are not read: save them as PDF or .docx." },
    { key: "social", icon: "social", title: "Social media analysis", text: "Verify an individual public post today: paste its text or link, and add screenshots, images or video.",
      status: "partial", href: App.can("case.create") ? "#/verify" : null, cta: "Check a post",
      missing: "Account and network analysis needs data you are permitted to use: either your own exports of public posts (planned, Phase 4) or a platform's research API, which requires an approved account and a key." },
    { key: "assistant", icon: "chat", title: "Research assistant", text: `In each case, ask what is missing, what to check next, for a timeline, sources or a summary, in English or Kiswahili. Rule-based answers work without AI. ${ai.configured ? `AI answers use ${esc(ai.providerLabel || ai.provider)}${ai.trainingOnly ? " (training cases only)" : ""} and must cite the case records.` : "AI answers need an AI service (free options: Google Gemini free tier for testing, or Ollama on a capable computer)."}`,
      status: ai.configured && ai.enabled ? "available" : "partial", href: "#/cases", cta: "Open a case",
      missing: ai.configured ? (ai.trainingOnly ? "AI is limited to training cases (AI_TRAINING_ONLY). For real cases, use a service with a data agreement or a local AI server." : null) : "AI answers need AI_PROVIDER, AI_MODEL and (for online services) AI_API_KEY in the server settings." },
    { key: "monitor", icon: "monitor", title: "Information operations monitor", text: "Look for signs of coordination in sets of public posts: near-identical messages, synchronised timing, sudden bursts and shared hashtags. These are signals to investigate, never proof.",
      status: "available", href: "#/monitor", cta: "Open the monitor", missing: "Works on post files you import (CSV or JSON). Collecting posts directly from platforms needs approved research API access, which is not connected." },
    { key: "reports", icon: "reports", title: "Reports", text: "Reports include methodology, citations, limitations and reviewer status. Approved reports are frozen with a fingerprint. Download them as PDF, HTML, JSON or CSV.",
      status: "available", href: "#/reports", cta: "View reports" },
    { key: "data", icon: "data", title: "Training and datasets", text: `Training cases, a reference archive of documented images${App.meta.training.cases ? ` (${App.meta.training.cases} training case${App.meta.training.cases > 1 ? "s" : ""} loaded)` : ""}, and a registry of fact-check datasets (licence, review, splits, measured accuracy) that is searched for every claim once approved.`,
      status: "available", href: "#/datasets", cta: "Open datasets",
      missing: "AIVS retrieves and cites dataset records; it does not train AI models on them. Datasets are not bundled: each must be imported with its licence recorded." },
    { key: "settings", icon: "admin", title: admin ? "Settings" : "Your settings", text: admin ? "Users and roles, AI connection, audit trail, storage checks and training data." : "Guided or advanced mode (top of the page) and your password (bottom left).",
      status: "available", href: admin ? "#/admin" : null, cta: admin ? "Open settings" : null }
  ];
}
const STATUS = { available: ["Available", "sup"], partial: ["Partly available", "warn"], planned: ["Planned", "grey"], off: ["Not configured", "grey"] };

export async function render(el) {
  crumbs(`<b>Start</b>${App.training ? " · training records" : ""}`);
  const M = modules(), first = App.me.display_name.split(" ")[0];
  let counts = null; try { counts = (await api.get(`/api/dashboard?${App.q()}`)).counts; } catch {}
  const open = counts ? counts.draft + counts.analysing + counts.analysis_failed + counts.analyst_review : 0;
  el.innerHTML = `<div class="pagehead"><div><h1>Welcome, ${esc(first)}</h1><p>AIVS helps you check claims, images and video against evidence, record what remains uncertain, and produce reports that a second person reviews. It never declares something false because it is controversial.</p></div></div>
    ${App.guided() ? `<div class="card"><div class="bd"><div class="howto">
      <div><span class="hn">1</span><b>Bring the content</b><span class="small muted">Paste a claim, article or link, or upload the image or video.</span></div>
      <div><span class="hn">2</span><b>Review what AIVS finds</b><span class="small muted">Separate claims, earlier copies of images, dates, and leads to follow up.</span></div>
      <div><span class="hn">3</span><b>Decide with evidence</b><span class="small muted">Assess each claim, explain why, and send it to a reviewer.</span></div></div>
      ${App.can("case.create") ? `<div class="row" style="margin-top:14px"><a class="btn primary" href="#/verify">${icon("verify")} Verify information</a><a class="btn" href="#/new">${icon("upload")} Upload image or video</a><a class="btn ghost" href="#/search">${icon("search")} Has this image been seen before?</a></div>` : ""}</div></div>` : ""}
    ${counts && (open || counts.awaiting_approval) ? `<div class="callout info" style="margin-bottom:14px"><div>${open ? `<a href="#/cases?status=draft,analysing,analysis_failed,analyst_review,needs_evidence,awaiting_approval">${open} open case${open > 1 ? "s" : ""}</a>` : ""}${open && counts.awaiting_approval ? " · " : ""}${counts.awaiting_approval ? `<a href="#/review">${counts.awaiting_approval} waiting for a reviewer</a>` : ""}. <a href="#/dashboard">Open the dashboard</a> for figures and activity.</div></div>` : ""}
    <div class="modules">${M.map(m => `<div class="module ${m.status}" data-mod="${m.key}">
      <div class="mtop"><span class="mic">${icon(m.icon)}</span><span class="chip ${STATUS[m.status][1]}">${STATUS[m.status][0]}${m.phase ? ` · Phase ${m.phase}` : ""}</span></div>
      <h3>${esc(m.title)}</h3><p class="small">${m.text}</p>
      <div class="row mfoot">${(m.href || m.action) && m.cta ? `<a class="btn sm ${m.status === "available" ? "primary" : ""}" ${m.href ? `href="${m.href}"` : `href="#" data-act="${m.action}"`}>${esc(m.cta)}</a>` : ""}${m.missing ? `<button class="btn sm ghost" data-more="${m.key}">${m.status === "planned" ? "What it will do" : "What is not ready yet"}</button>` : ""}</div></div>`).join("")}</div>
    <p class="tiny sub" style="margin-top:14px">Statuses describe this installation as it is now. Nothing marked planned is simulated. <a href="#/privacy">How AIVS handles data</a></p>`;
  $$("[data-more]").forEach(b => b.onclick = () => { const m = M.find(x => x.key === b.dataset.more); modal(m.title, `<p>${m.missing}</p><p class="small muted">See docs/ROADMAP.md in the project folder for the phases, the external services involved and which of them need keys or subscriptions.</p>`); });
  $$('[data-act="practice"]').forEach(a => a.onclick = e => { e.preventDefault(); App.setScope("training"); App.go("#/cases"); });
}

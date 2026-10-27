// Service status (Settings → Service status): every AIVS module, each with an honest status (available, partly available, planned).
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, icon, modal } from "../ui.js";

// What exists today, and what each planned module will need. Keep this in step with docs/ROADMAP.md.
function modules(H = {}, TH = {}) {
  const tState = TH.health?.state, tOk = !!TH.ok && tState === "ok";
  const ai = { ...App.meta.ai, ...(H.ai || {}) }, hs = H.state || ai.health?.state, admin = App.can("settings.manage");
  return [
    { key: "verify", icon: "verify", title: "Verify information", text: "Paste a claim, article text or a link. AIVS retrieves the page, keeps an archived copy and splits the content into separate claims to check.",
      status: "available", href: App.can("case.create") ? "#/verify" : null, cta: "Start verifying" },
    { key: "upload", icon: "upload", title: "Upload files", text: `Images, video, audio and documents: fingerprints, archive matching, metadata, offline text reading (English and Kiswahili), video frames, text and properties from PDF, Word (.docx), TXT, CSV and JSON including OCR of scanned PDFs, and ${tOk ? `machine transcripts of speech in English and Kiswahili (${esc(TH.health?.model ? `faster-whisper ${TH.health.model}` : "faster-whisper")} on your own server)` : "speech-to-text for audio and video once the transcription service is set up"}.`,
      status: tOk ? "available" : "partial", href: App.can("case.create") ? "#/new" : null, cta: "Upload files",
      pending: tOk ? null : !TH.ok ? `Speech-to-text not set up: ${TH.reason || "install the transcription service and set TRANSCRIBE_URL and TRANSCRIBE_TOKEN."}` : tState === "failed" ? `Speech-to-text check failed: ${TH.health?.error || ""}` : "Speech-to-text not checked yet: reload this page in a moment.",
      missing: `${tOk ? "" : "Speech-to-text is shown as available only after AIVS has reached the transcription service and its token is accepted. "}Transcripts are machine-generated: speech that cannot be made out is left out, and every passage must be checked against the recording. Only English and Kiswahili are supported. Older Word (.doc), Excel and PowerPoint files are not read: save them as PDF or .docx.` },
    { key: "social", icon: "social", title: "Social media analysis", text: `A dashboard for sets of public posts: import CSV, JSON or Excel exports, screenshots or news feeds, then review estimated tone, themes and topics, narrative change over time, public engagement, recorded locations and checkable claims with published fact-checks, with filters and downloadable reports. To check one post, use <a href="#/verify/post">Verify information → Social media post</a>.`,
      status: "available", href: "#/monitor", cta: "Open the dashboard",
      pending: "Pending: Facebook, Instagram and TikTok collection (needs approved research access). YouTube and X collection need API keys.",
      missing: `Collection through platform APIs: YouTube and X work when the administrator adds their keys (YOUTUBE_API_KEY, X_BEARER_TOKEN); Facebook, Instagram and TikTok need approved research access and are pending, so use exports you are permitted to use. Tone is a rule-based estimate unless a local AI model (Ollama) is set up. ${(App.meta.social || []).filter(x => !x.configured).map(x => `Single-post lookup: ${esc(x.label)} needs ${esc(x.needs)}. `).join("")}${tOk ? "" : "Video and audio in uploaded cases are transcribed only once speech-to-text is set up."}` },
    { key: "assistant", icon: "chat", title: "Research assistant", text: `In each case, ask what is missing, what to check next, for a timeline, sources or a summary, in English or Kiswahili. Rule-based answers work without AI. ${ai.configured ? `AI answers use ${esc(ai.providerLabel || ai.provider)}${ai.trainingOnly ? " (training cases only)" : ""} and must cite the case records.` : "AI answers need an AI service (free options: Google Gemini free tier for testing, or Ollama on a capable computer)."}`,
      status: ai.configured && ai.enabled && hs === "ok" ? "available" : "partial", href: "#/cases", cta: "Open a case",
      pending: ai.configured && ai.enabled ? (hs === "ok" ? null : hs === "failed" ? `AI connection check failed: ${H.error || ai.health?.error || ""} Rule-based answers still work.` : "AI connection not checked yet: open a case's Assistant tab, or reload this page in a moment.") : null,
      missing: ai.configured ? (ai.trainingOnly ? "AI is limited to training cases (AI_TRAINING_ONLY). For real cases, use a service with a data agreement or a local AI server." : hs === "ok" ? null : `The AI service must pass a connection check before it is shown as available. ${H.error || ai.health?.error || ""}`) : "AI answers need AI_PROVIDER, AI_MODEL and (for online services) AI_API_KEY in the server settings." },
    { key: "monitor", icon: "monitor", title: "Information operations monitor", text: "Coordination indicators in sets of public posts: near-identical messages, synchronised timing, sudden bursts and shared hashtags. These are signals to investigate, never proof.",
      status: "available", href: "#/monitor", cta: "Open coordination indicators", missing: "Works on posts you import or collect (see Social media analysis). Collecting posts directly from platforms needs approved research API access, which is not connected." },
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
  crumbs(`<a href="#/settings">Settings</a> / <b>Service status</b>`);
  let H = {}, TH = App.meta.transcribe || {}; try { [H, TH] = await Promise.all([api.get("/api/ai/health?cached=1").catch(() => ({})), api.get("/api/transcribe/health?cached=1").catch(() => TH)]); } catch {}
  if (TH?.ok !== undefined) App.meta.transcribe = TH;
  const M = modules(H, TH), first = App.me.display_name.split(" ")[0];
  let counts = null; try { counts = (await api.get(`/api/dashboard?${App.q()}`)).counts; } catch {}
  const open = counts ? counts.draft + counts.analysing + counts.analysis_failed + counts.analyst_review : 0;
  el.innerHTML = `<div class="pagehead"><div><h1>Service status</h1><p>Every module of this installation and what it needs. Hello, ${esc(first)}.</p></div></div>
    ${App.guided() ? `<div class="card" style="margin-bottom:14px"><div class="bd"><div class="howto howto4">
      <div><span class="hn">1</span><b>Add content</b><span class="small muted">Paste text or a link, or upload a file.</span></div>
      <div><span class="hn">2</span><b>Review findings</b><span class="small muted">Claims, warnings and suggested evidence. You accept or dismiss each one.</span></div>
      <div><span class="hn">3</span><b>Record conclusion</b><span class="small muted">A verdict and a reason for each claim, then the overall conclusion.</span></div>
      <div><span class="hn">4</span><b>Review and export</b><span class="small muted">A second person approves it. Then download the report.</span></div></div>
      ${App.can("case.create") ? `<div class="row" style="margin-top:14px"><a class="btn primary" href="#/start">${icon("new")} New investigation</a><a class="btn ghost" href="#/cases">Continue a case</a></div>` : ""}</div></div>` : ""}
    ${counts && (open || counts.awaiting_approval) ? `<div class="callout info" style="margin-bottom:14px"><div>${open ? `<a href="#/cases?status=draft,analysing,analysis_failed,analyst_review,needs_evidence,awaiting_approval">${open} open case${open > 1 ? "s" : ""}</a>` : ""}${open && counts.awaiting_approval ? " · " : ""}${counts.awaiting_approval ? `<a href="#/review">${counts.awaiting_approval} waiting for a reviewer</a>` : ""}. <a href="#/dashboard">Open the dashboard</a> for figures and activity.</div></div>` : ""}
    <div class="modules">${M.map(m => `<div class="module ${m.status}" data-mod="${m.key}">
      <div class="mtop"><span class="mic">${icon(m.icon)}</span><span class="chip ${STATUS[m.status][1]}">${STATUS[m.status][0]}${m.phase ? ` · Phase ${m.phase}` : ""}</span></div>
      <h3>${esc(m.title)}</h3><p class="small">${m.text}</p>${m.pending ? `<p class="tiny" style="margin:-4px 0 8px;color:var(--warn)">${esc(m.pending)}</p>` : ""}
      <div class="row mfoot">${(m.href || m.action) && m.cta ? `<a class="btn sm ${m.status === "available" ? "primary" : ""}" ${m.href ? `href="${m.href}"` : `href="#" data-act="${m.action}"`}>${esc(m.cta)}</a>` : ""}${m.missing ? `<button class="btn sm ghost" data-more="${m.key}">${m.status === "planned" ? "What it will do" : m.status === "available" ? "Pending integrations" : "What is not ready yet"}</button>` : ""}</div></div>`).join("")}</div>
    <p class="tiny sub" style="margin-top:14px">Statuses describe this installation as it is now. Nothing marked planned is simulated. <a href="#/privacy">How AIVS handles data</a></p>`;
  $$("[data-more]").forEach(b => b.onclick = () => { const m = M.find(x => x.key === b.dataset.more); modal(m.title, `<p>${m.missing}</p><p class="small muted">See docs/ROADMAP.md in the project folder for the phases, the external services involved and which of them need keys or subscriptions.</p>`); });
  $$('[data-act="practice"]').forEach(a => a.onclick = e => { e.preventDefault(); App.setScope("training"); App.go("#/cases"); });
}

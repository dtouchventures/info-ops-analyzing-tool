import { MAX_CASE_CLAIMS, CLAIM_LIMIT_MESSAGE } from "/shared/claim-limit.js";
// Case workspace: header with workflow state and actions; tabs for overview, media, claims, evidence, AI, report, history.
import { api } from "../api.js";
import { App, crumbs, refreshNavCounts } from "../app.js";
import { $, $$, esc, toast, fail, modal, confirmBox, viewer, fmtDT, fmtD, ago, kb, toLocalInput, fromLocalInput, status, concl, pri, empty, STATUS, CONCL, ASSESS, KIND, STRENGTH, errMsg } from "../ui.js";
import { extractEntities } from "/shared/text.js";
import { differenceMap, errorLevel, matchedRegion, bindSlider } from "../lib/forensics.js";
import { recognise } from "../lib/ocr.js";
import { openVideo, frameBlob, uploadFrame, sampleFrames } from "../lib/video.js";
import { videoResultHtml, stagesHtml } from "../lib/videoview.js";
import { transcriptPanel, bindTranscripts, LANG_OPTS } from "./transcript.js";
import { coverageTab } from "./coverage.js";
import { verdictNeeds, ACTIVE_VERDICTS, ACTIVE_CONCLUSIONS } from "/shared/verdict.js";
import { LOCATION_SOURCES } from "/shared/account-location.js";
import { renderSteps, currentStep, STEP_NAMES, moreTools } from "./steps.js";
import { renderAutomatic } from "./automatic.js";

// cases of automatic investigations (1.33): completed by AIVS, decided by the Head of Department in the report approval queue
const hodRoute = c => c.approval_route === "hod" || !!c.auto_completed_at;
function autoNote(c) {
  if (!hodRoute(c)) return "";
  const inv = c.investigation, link = inv ? `<a href="#/investigate/${esc(inv.id)}">${esc(inv.report_id)}</a>` : "its investigation";
  return `<div class="callout info" id="autoNote"><div>${c.auto_completed_at ? `<b>Completed automatically by AIVS</b> on ${fmtDT(c.auto_completed_at)}: claims assessed from accepted evidence, rationales, the conclusion${c.confidence ? ` (confidence ${esc(c.confidence)})` : ""} and the remaining uncertainties were written by the investigation pipeline. ` : ""}
    Approval is by the Head of Department through the report approval panel of ${link}${c.status === "awaiting_approval" ? " (pending HOD approval)" : ""}. Manual changes here are for exceptional review, corrections or a returned report.</div></div>`;
}
const TABS = [["overview", "Overview"], ["media", "Media & matches"], ["claims", "Claims"], ["evidence", "Evidence"], ["coverage", "Evidence coverage"], ["assistant", "Assistant"], ["ai", "AI assistance"], ["report", "Conclusion & report"], ["notes", "Notes"], ["history", "History"]];
const STYPE = { appeal: "call to action", opinion: "opinion", prediction: "prediction", satire: "satire or humour", question: "question" };
const STYPE_HELP = { opinion: "Looks like an opinion or value judgement, which cannot be shown true or false. If so, remove it (it stays on record), or assess it as insufficient evidence and say why. Check any facts it relies on as separate claims.",
  prediction: "Looks like a prediction, which cannot be verified yet. Check the facts it is based on as separate claims.",
  satire: "Marked as satire or humour. Check whether it is being shared as if it were real; that is the claim to verify.",
  appeal: "A call to share, forward or send something is not a claim by itself. Remove it, but note it: urgency and pressure to share are common in misleading posts and scams.",
  question: "A question is not a claim by itself. Turn any statement it implies into a separate claim." };
const FLOW = ["draft", "analysing", "analyst_review", "awaiting_approval", "approved", "archived"];
const content = id => `/api/media/${id}/content`, thumb = id => `/api/media/${id}/thumb`;
const fmtClock = s => { const x = Math.max(0, Number(s) || 0), m = Math.floor(x / 60); return `${m}:${(x % 60).toFixed(1).padStart(4, "0")}`; };

export async function render(el, [id, tabArg], { isCurrent }) {
  const GSTEP = /^step[1-4]$/;
  let tab = tabArg === 'automatic' ? 'automatic' : TABS.some(t => t[0] === tabArg) ? tabArg : GSTEP.test(tabArg || "") ? tabArg : "overview";
  let A, pollT, lastView = null, lastStatus = null;
  const load = async () => { A = await api.get(`/api/cases/${encodeURIComponent(id)}`); };
  try { await load(); } catch (e) { el.innerHTML = `<div class="callout bad"><div><b>Case not available.</b> ${esc(e.message)}</div></div>`; return; }
  const reload = async () => {
    // Polling must not replace a form while the analyst is typing into it.
    if (isCurrent() && el.contains(document.activeElement) && document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')) {
      clearTimeout(pollT); pollT = setTimeout(() => isCurrent() && reload(), 1500); return;
    }
    await load(); if (isCurrent()) draw();
  };
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); await reload(); refreshNavCounts(); } catch (e) { fail(e); } };

  function taskSummary() {
    const cap = A.claimCapacity || { active: A.claims.filter(x => !x.removed).length }, ongoing = (A.tasks || []).filter(t => ["pending", "processing"].includes(t.status));
    return `<div class="row case-task-summary" style="margin-bottom:12px"><b>Claims: ${cap.selection_required ? cap.active : Math.min(cap.used ?? cap.active, MAX_CASE_CLAIMS)}/${MAX_CASE_CLAIMS}</b><a href="#/tasks">Background tasks${ongoing.length ? ` (${ongoing.length} active)` : ""}</a>${cap.selection_required ? `<a href="#/case/${encodeURIComponent(id)}/claims">Choose two claims for this older case</a>` : ""}</div>`;
  }
  function draw() {
    const c = A.case, P = A.perms;
    crumbs(`<a href="#/cases">Cases</a> / <b>${esc(c.id)}</b>`);
    if (tab === 'automatic') { renderAutomatic(el, c.id, P.edit, isCurrent); return; }
    // guided mode: the case in four steps (#/case/ID/step1..4); the full tools stay one click away under "More tools"
    if (App.guided() && (GSTEP.test(tab) || !tabArg)) {
      let n = GSTEP.test(tab) ? +tab.slice(4) : currentStep(A);
      if (!tabArg) window.history.replaceState(null, "", `#/case/${encodeURIComponent(c.id)}/step${n}`);
      // when the checks finish, move on to the findings by themselves
      if (n === 1 && ["draft", "analysing", "analysis_failed"].includes(lastStatus) && c.status === "analyst_review") { lastStatus = c.status; location.hash = `#/case/${encodeURIComponent(c.id)}/step2`; return; }
      const view = `step${n}`, y = view === lastView ? window.scrollY : 0; lastView = view; lastStatus = c.status;
      renderSteps(el, n, { A, act, reload, linkEvidence, runSearch, timeline, refresh: async () => { await load(); } });
      el.insertAdjacentHTML("afterbegin", taskSummary());
      if (y) window.scrollTo(0, y);
      clearTimeout(pollT);
      if (c.status === "analysing" || A.tasks?.some(t => ["pending", "processing"].includes(t.status))) pollT = setTimeout(() => isCurrent() && reload(), 1500);
      return;
    }
    // a step address opened in Advanced mode shows the matching full tool
    if (GSTEP.test(tab)) tab = { step1: "overview", step2: "evidence", step3: "claims", step4: "report" }[tab];
    lastView = tab; lastStatus = c.status;
    const pending = A.evidence.filter(e => e.status === "suggested").length, unassessed = A.claims.filter(x => !x.removed && x.assessment === "unassessed").length;
    const counts = { media: A.media.length, claims: unassessed, evidence: pending, ai: A.aiRuns.length, notes: A.notes.filter(n => !n.deleted).length, coverage: needAttention().length };
    el.innerHTML = `${taskSummary()}${header(c, P)}${App.guided() ? `<div class="gback"><a class="btn sm" href="#/case/${esc(c.id)}/step${currentStep(A)}">← Back to the steps</a><span class="small sub">More tools. Everything you change here is saved and counts in the steps.</span>${moreTools(c)}</div>` : ""}
      <nav class="tabs" aria-label="Case sections">${TABS.map(([k, l]) => `<a href="#/case/${esc(c.id)}/${k}" class="${k === tab ? "on" : ""}">${l}${k === "claims" && counts.claims ? `<span class="count" title="Claims not yet assessed">${counts.claims}</span>` : ""}${k === "evidence" && counts.evidence ? `<span class="count" title="Suggestions to review">${counts.evidence}</span>` : ""}${k === "notes" && counts.notes ? `<span class="count grey" title="Team notes">${counts.notes}</span>` : ""}${k === "coverage" && counts.coverage ? `<span class="count" title="Claims that block submission">${counts.coverage}</span>` : ""}</a>`).join("")}</nav>
      <div id="tabBody"></div>`;
    bindHeader(c, P);
    const body = $("#tabBody");
    Promise.resolve(({ overview, media, claims, evidence, coverage: (b, cc, pp) => coverageTab(b, cc, pp, { reload }), assistant, ai, report, notes, history })[tab](body, c, P)).catch(e => { body.innerHTML = `<div class="callout bad"><div>${esc(errMsg(e))}</div></div>`; console.error(e); });
    clearTimeout(pollT);
    if (c.status === "analysing" || A.aiRuns.some(r => r.status === "running") || A.tasks?.some(t => ["pending", "processing"].includes(t.status))) pollT = setTimeout(() => isCurrent() && reload(), 1500);
  }

  // ---------------------------------------------------------------- guided mode: see steps.js
  // claims that block submission under the approval rules (same rules as the server's readiness check)
  function needAttention() {
    return A.claims.filter(x => !x.removed).filter(x => x.assessment === "unassessed" || !String(x.rationale || "").trim()
      || verdictNeeds(x.assessment, A.evidence.filter(e => e.status === "accepted").flatMap(e => e.links.filter(l => l.claim_id === x.id).map(l => l.stance))));
  }
  // ---------------------------------------------------------------- header
  function header(c, P) {
    const MAPS = { analysis_failed: "analysing", needs_evidence: "analyst_review", rejected: "awaiting_approval" }, idx = FLOW.indexOf(MAPS[c.status] || c.status), bad = ["analysis_failed", "rejected"].includes(c.status);
    const steps = FLOW.map((s, i) => `<div class="${i < idx ? "done" : i === idx ? (bad ? "fail" : "cur") : ""}">${i < idx ? "✓ " : ""}${i === idx && MAPS[c.status] ? STATUS[c.status] : STATUS[s]}</div>`).join("");
    const staff = App.meta.users.filter(u => u.role !== "viewer");
    let actions = "";
    if (c.status === "draft" && P.edit) actions = `<button class="btn primary" data-a="analyse">Run local analysis</button>`;
    if (c.status === "analysing") actions = `<span class="chip info"><span class="spin"></span> Analysing on the server…</span>`;
    if (c.status === "analysis_failed" && P.edit) actions = `<button class="btn primary" data-a="analyse">Retry analysis</button>`;
    if (["analyst_review", "needs_evidence"].includes(c.status) && P.edit) actions = `<button class="btn" data-a="analyse" title="Re-run archive matching and checks; your decisions are kept">Re-run checks</button><a class="btn primary" href="#/case/${esc(c.id)}/report">Prepare conclusion</a>`;
    if (c.status === "awaiting_approval") actions = P.approve ? `<a class="btn primary" href="#/case/${esc(c.id)}/report">Review and decide</a>` : `<span class="chip warn">${P.ownWork ? "Waiting for a different reviewer" : "Waiting for a reviewer"}</span>`;
    if (c.status === "approved") actions = `${P.archive ? `<button class="btn" data-a="archive">Archive case</button>` : ""}${App.can("archive.manage") ? `<button class="btn" data-a="toArchive">Add media to reference archive</button>` : ""}${P.revise ? `<button class="btn" data-a="revise">Open new revision</button>` : ""}${A.reports.length ? `<a class="btn primary" href="/api/reports/${esc(A.reports.at(-1).id)}.html" target="_blank" rel="noopener">Approved report</a>` : ""}`;
    if (c.status === "rejected") actions = `${P.revise ? `<button class="btn primary" data-a="revise">Rework as new revision</button>` : ""}${P.archive ? `<button class="btn" data-a="archive">Archive case</button>` : ""}`;
    if (c.status === "archived") actions = `${P.revise ? `<button class="btn" data-a="revise">Open new revision</button>` : ""}${A.reports.length ? `<a class="btn primary" href="/api/reports/${esc(A.reports.at(-1).id)}.html" target="_blank" rel="noopener">Approved report</a>` : ""}`;
    return `<div class="casehead">
      ${c.is_training ? `<div class="callout train" style="margin-bottom:10px"><div><b>Training case.</b> Synthetic material for practice; not an operational assessment.</div></div>` : ""}
      <div class="top"><div style="min-width:0"><div class="id">${esc(c.id)} · revision ${c.revision} · version ${c.version}</div><h1 style="margin-top:2px">${esc(c.title)}</h1></div><div class="acts">${actions}</div></div>
      <div class="facts"><span>${status(c.status)} ${concl(c.conclusion && ["awaiting_approval", "approved", "archived"].includes(c.status) ? c.conclusion : null)}</span><span>Priority: ${pri(c.priority)}</span>
        <span>Analyst: ${P.assign ? `<select id="assignSel" aria-label="Assigned analyst" style="display:inline-block;width:auto;padding:2px 6px;font-size:13px"><option value="">Unassigned</option>${staff.map(u => `<option value="${u.id}" ${u.id === c.assigned_to ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>` : `<b>${esc(c.assigned?.name || "Unassigned")}</b>`}</span>
        <span>Source: <b>${esc(c.source_platform)}</b></span><span>Received: <b>${fmtDT(c.received_at)}</b></span></div>
      <div class="stepper" aria-label="Workflow">${steps}</div>
      ${c.status === "analysis_failed" ? `<div class="callout bad" style="margin-top:12px"><div><b>Analysis failed${c.analysis_attempts > 1 ? ` (attempt ${c.analysis_attempts})` : ""}.</b> ${esc(c.analysis_error || "")} Nothing was lost. Fix the cause if it is clear (for example, remove a damaged file) and retry.</div></div>` : ""}
      ${c.reviewer_comment && c.status === "analyst_review" ? `<div class="callout warn" style="margin-top:12px"><div><b>${c.revision > 1 && !c.decided_by ? "Revision note" : "Returned by reviewer"}:</b> ${esc(c.reviewer_comment)}</div></div>` : ""}
      ${c.status === "needs_evidence" ? `<div class="callout warn" style="margin-top:12px"><div><b>Reviewer asked for more evidence${c.decider ? ` (${esc(c.decider.name)})` : ""}:</b> ${esc(c.reviewer_comment || "")}</div></div>` : ""}
      ${c.status === "rejected" ? `<div class="callout bad" style="margin-top:12px"><div><b>Rejected by reviewer${c.decider ? ` ${esc(c.decider.name)}` : ""}:</b> ${esc(c.reviewer_comment || "")} No report was issued. Open a new revision to rework it, or archive it.</div></div>` : ""}
    </div>`;
  }
  function bindHeader(c, P) {
    [...el.querySelectorAll(".casehead [data-a], .nextstep [data-a]")].forEach(b => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === "analyse") return act(() => api.queueTask(c.id, "analysis"), "Analysis started.");
      if (a === "archive") { if (await confirmBox("Archive this case?", "Archived cases stay searchable and can be reopened as a new revision.", "Archive")) act(() => api.post(`/api/cases/${c.id}/archive`), "Case archived."); }
      if (a === "revise") {
        const r = await modal("Open a new revision", `<p class="small">The approved report stays on record unchanged. The case returns to analyst review as revision ${c.revision + 1}.</p><label class="f" for="rr">Reason <span class="req">*</span></label><textarea id="rr" rows="3" placeholder="e.g. new source found, reviewer request"></textarea>`,
          [{ label: "Cancel", value: null }, { label: "Open revision", kind: "primary", validate: el => (!$("#rr", el).value.trim() ? "Give a reason." : null), value: el => $("#rr", el).value.trim() }]);
        if (r.value) act(() => api.post(`/api/cases/${c.id}/revise`, { reason: r.value }), `Revision ${c.revision + 1} opened.`);
      }
      if (a === "toArchive") toArchive(c);
    });
    const s = $("#assignSel"); if (s) s.onchange = () => act(() => api.post(`/api/cases/${c.id}/assign`, { user_id: s.value ? +s.value : null }), "Assignment updated.");
  }
  async function toArchive(c) {
    const imgs = A.media.filter(m => m.kind === "image");
    if (!imgs.length) return toast("This case has no images or frames to archive.", "err");
    const r = await modal("Add to the reference archive", `<p class="small muted">The selected images become a reference record linked to this approved case. Future submissions will be compared with them.</p>
      <div class="frames">${imgs.map(m => `<label style="display:block"><figure><img src="${thumb(m.id)}" alt=""><figcaption><input type="checkbox" value="${esc(m.id)}" ${m.parent_media_id ? "" : "checked"}> ${esc(m.id)}</figcaption></figure></label>`).join("")}</div>
      <label class="f" for="at">Title <span class="req">*</span></label><input type="text" id="at" value="${esc(c.title)}">
      <label class="f" for="ad">What the record shows and how it was established <span class="req">*</span></label><textarea id="ad" rows="3">${esc(`Assessed in case ${c.id} (revision ${c.revision}) as ${CONCL[c.conclusion]?.[0] || "—"}. ${c.conclusion_rationale || ""}`)}</textarea>
      <div class="grid g2"><div><label class="f" for="adt">Documented date <span class="req">*</span></label><input type="date" id="adt" value="${esc((c.published_at || c.received_at).slice(0, 10))}"></div>
      <div><label class="f" for="aty">Record type</label><select id="aty"><option value="misleading" ${["contradicted", "mixed"].includes(c.conclusion) ? "selected" : ""}>Previously documented misleading item</option><option value="original" ${["contradicted", "mixed"].includes(c.conclusion) ? "" : "selected"}>Original with documented origin</option></select></div></div>
      <label class="f" for="ar">Source reference <span class="req">*</span></label><input type="text" id="ar" value="${esc(`Verification report ${c.id} revision ${c.revision}`)}">`,
      [{ label: "Cancel", value: null }, { label: "Add to archive", kind: "primary", validate: el => (!$$("input[type=checkbox]:checked", el).length ? "Choose at least one image." : null),
        value: el => ({ media_ids: $$("input[type=checkbox]:checked", el).map(x => x.value), title: $("#at", el).value, description: $("#ad", el).value, documented_date: $("#adt", el).value, record_type: $("#aty", el).value, source_ref: $("#ar", el).value }) }], { wide: true });
    if (r.value) act(async () => { const x = await api.post(`/api/cases/${c.id}/to-archive`, r.value); toast(`Archive record ${x.id} created.`); });
  }

  // ---------------------------------------------------------------- overview
  // where the posting account is based, as the platform states it (from the analyst's screenshot); never inferred
  function accountLocationCard(c, P) {
    const social = /facebook|instagram|meta/i.test(`${c.source_platform} ${c.source_url || ""}`), imgs = A.media.filter(m => m.kind === "image" && !m.parent_media_id);
    if (!social && !c.account_location && !P.edit) return "";
    const by = c.account_location_by ? A.users[c.account_location_by] : null;
    return `<div class="card" id="alCard"><div class="hd"><h3>Account location</h3><span class="chip grey right">As the platform states it</span></div><div class="bd small">
      ${c.account_location ? `<div><b style="font-size:15px">${esc(c.account_location)}</b></div><div class="sub">${esc(LOCATION_SOURCES[c.account_location_source] || c.account_location_source)}${c.account_location_media_id ? ` · screenshot <a href="#" data-alview="${esc(c.account_location_media_id)}">${esc(c.account_location_media_id)}</a>` : ""}</div>
        ${c.account_location_basis ? `<div class="tiny sub" style="margin-top:4px">${esc(c.account_location_basis)}</div>` : ""}<div class="tiny sub">Recorded by ${esc(by || "—")} · ${fmtDT(c.account_location_at)}</div>
        <div class="hint">${c.account_location_source === "profile_self_reported" ? "Stated by the account itself." : "Stated by the platform about the account."} Not verified, and not where any post was made: an account can be run from elsewhere. Shown in the report with its source.</div>
        ${P.edit ? `<div class="row" style="margin-top:8px"><button class="btn sm" id="alFind">Find in screenshots again</button><button class="btn sm ghost" id="alClear">Remove</button></div>` : ""}`
      : `<p class="muted" style="margin:0">Not recorded.${social ? " For Facebook or Instagram accounts, the platform publishes where an account is based:" : ""}</p>
        ${social ? `<ul class="tiny" style="margin:6px 0 0 16px;padding:0"><li><b>Facebook Page:</b> Page → About → <i>Page transparency</i> (“primarily located in…”)</li><li><b>Instagram:</b> profile → ⋯ → <i>About this account</i> (“Account based in…”)</li></ul><div class="tiny sub" style="margin-top:4px">Take a screenshot of that panel, add it on the Media tab and read its text, then click Find.</div>` : ""}
        ${P.edit ? `<div class="row" style="margin-top:8px"><button class="btn sm primary" id="alFind">Find in screenshots</button></div>` : ""}`}
      <div id="alOut"></div>
      ${P.edit ? `<details style="margin-top:8px"><summary class="tiny sub">Record it yourself</summary>
        <label class="f" for="alLoc">Location as stated</label><input type="text" id="alLoc" maxlength="120" placeholder="Kenya" value="${esc(c.account_location || "")}">
        <label class="f" for="alSrc">Where it is stated</label><select id="alSrc">${Object.entries(LOCATION_SOURCES).map(([k, v]) => `<option value="${k}" ${k === c.account_location_source ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
        <label class="f" for="alMed">Screenshot</label><select id="alMed"><option value="">None</option>${imgs.map(m => `<option value="${esc(m.id)}" ${m.id === c.account_location_media_id ? "selected" : ""}>${esc(m.id)} · ${esc(m.original_name)}</option>`).join("")}</select>
        <label class="f" for="alBasis">Basis</label><input type="text" id="alBasis" maxlength="1000" placeholder="Required without a screenshot: the page and the date you looked" value="${esc(c.account_location_basis || "")}">
        <div style="margin-top:8px"><button class="btn sm" id="alSave">Save</button></div></details>` : ""}
    </div></div>`;
  }
  function bindAccountLocation(c, P) {
    $$("[data-alview]").forEach(a => a.onclick = ev => { ev.preventDefault(); viewer(content(a.dataset.alview), a.dataset.alview); });
    if (!P.edit || !$("#alCard")) return;
    if ($("#alClear")) $("#alClear").onclick = async () => { if (await confirmBox("Remove the account location?", "The earlier value stays in the case history.", "Remove", "danger")) act(() => api.put(`/api/cases/${c.id}/account-location`, { clear: true }), "Account location removed."); };
    $("#alSave").onclick = () => act(() => api.put(`/api/cases/${c.id}/account-location`, { location: $("#alLoc").value, source: $("#alSrc").value, media_id: $("#alMed").value || null, basis: $("#alBasis").value }), "Account location saved.");
    $("#alFind").onclick = async () => {
      const out = $("#alOut"); out.innerHTML = '<div class="tiny sub" style="margin-top:6px"><span class="spin"></span> Reading the text of this case’s screenshots…</div>';
      try {
        const r = await api.get(`/api/cases/${c.id}/account-location/candidates`);
        out.innerHTML = `${r.candidates.length ? `<div style="margin-top:8px"><b class="tiny">Found in screenshots: confirm the one that is right</b>${r.candidates.map((x, i) => `<div class="ev" style="margin-top:6px"><div><b>${esc(x.location)}</b> ${x.recognised ? "" : `<span class="chip warn">not a recognised country: check the spelling</span>`}</div><div class="tiny sub">${esc(x.source_label)} · <a href="#" data-alview="${esc(x.media_id)}">${esc(x.media_id)}</a></div><div class="tiny sub">“${esc(x.quote)}”</div><button class="btn sm" data-aluse="${i}" style="margin-top:4px">Use this</button></div>`).join("")}</div>`
          : `<div class="callout" style="margin-top:8px"><div class="tiny">No “Account based in” or “primarily located in” text was found in this case’s screenshots.${r.images_without_text.length ? ` Text has not been read yet from ${r.images_without_text.map(m => esc(m.id)).join(", ")}: open the Media tab and click “Read text” on the screenshot first.` : ""}</div></div>`}`;
        $$("[data-alview]", out).forEach(a => a.onclick = ev => { ev.preventDefault(); viewer(content(a.dataset.alview), a.dataset.alview); });
        $$("[data-aluse]", out).forEach(b => b.onclick = () => { const x = r.candidates[+b.dataset.aluse];
          act(() => api.put(`/api/cases/${c.id}/account-location`, { location: x.location, source: x.source, media_id: x.media_id, basis: `Read from screenshot ${x.media_id}: “${x.quote}”` }), "Account location recorded from the screenshot."); });
      } catch (e) { out.innerHTML = `<div class="callout bad"><div class="tiny">${esc(e.message)}</div></div>`; }
    };
  }
  function overview(body, c, P) {
    const ed = P.edit ? "" : "disabled";
    body.innerHTML = `<div class="split">
      <div class="stack">
        <div class="card"><div class="hd"><h3>Content as received</h3><span class="chip grey right">Preserved, cannot be edited</span></div><div class="bd"><div class="quote">${esc(c.claim_text_original)}</div></div></div>
        ${c.source_snapshot_sha256 ? `<div class="card"><div class="hd"><h3>Source page</h3><span class="chip info right">Retrieved by AIVS</span></div><div class="bd small">
          <div><b>${esc(c.source_title || c.source_url)}</b></div><div class="sub" style="overflow-wrap:anywhere"><a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(c.source_url)}</a>${c.source_final_url && c.source_final_url !== c.source_url ? ` → redirected to ${esc(c.source_final_url)}` : ""}</div>
          <dl class="kv" style="margin-top:8px"><dt>Retrieved</dt><dd>${fmtDT(c.source_fetched_at)}</dd><dt>Published (per page)</dt><dd>${c.published_at ? `${fmtDT(c.published_at)} <span class="sub">from ${esc(c.published_basis || "")}</span>` : `<span class="sub">The page gives no machine-readable date. Establish it another way.</span>`}</dd>
            <dt>Archived copy</dt><dd><a href="/api/cases/${esc(c.id)}/snapshot">Download the page exactly as retrieved</a> <span class="mono tiny sub adv">SHA-256 ${esc(c.source_snapshot_sha256)}</span></dd></dl>
          <div class="hint">Page dates can be wrong or changed later. Treat them as what the page states, and check them.</div></div></div>` : ""}
        <div class="card"><div class="hd"><h3>Working copy for analysis</h3></div><div class="bd">
          <textarea id="wc" rows="4" ${ed} aria-label="Working copy of the claim text">${esc(c.claim_text)}</textarea>
          <div class="hint">Use this to correct obvious transcription errors or translate. Changes are versioned; the original above never changes.</div></div></div>
        <div class="card"><div class="hd"><h3>Source and dates</h3></div><div class="bd">
          <div class="grid g2"><div><label class="f" for="o_t">Title</label><input type="text" id="o_t" value="${esc(c.title)}" ${ed}></div><div><label class="f" for="o_p">Priority</label><select id="o_p" ${ed}>${["routine", "priority", "urgent"].map(p => `<option ${p === c.priority ? "selected" : ""} value="${p}">${p[0].toUpperCase() + p.slice(1)}</option>`).join("")}</select></div></div>
          <div class="grid g3"><div><label class="f" for="o_sp">Where seen</label><input type="text" id="o_sp" value="${esc(c.source_platform)}" ${ed}></div><div><label class="f" for="o_sa">Account</label><input type="text" id="o_sa" value="${esc(c.source_account || "")}" ${ed}></div><div><label class="f" for="o_su">Link / reference</label><input type="text" id="o_su" value="${esc(c.source_url || "")}" ${ed}></div></div>
          <label class="f" for="o_ht">Hashtags</label><input type="text" id="o_ht" value="${esc((c.hashtags || []).join(" "))}" placeholder="#example #another" ${ed}>${(c.hashtags || []).length ? `<div class="row" style="margin-top:6px">${c.hashtags.map(h => `<a class="chip info" href="#/search?q=${encodeURIComponent(h)}" title="Find other records with this hashtag">${esc(h)}</a>`).join("")}</div>` : ""}
          <div class="grid g3">
            <div><label class="f" for="o_ra">Received</label><input type="datetime-local" id="o_ra" value="${toLocalInput(c.received_at)}" ${ed}></div>
            <div><label class="f" for="o_pa">Published (per source)</label><input type="datetime-local" id="o_pa" value="${toLocalInput(c.published_at)}" ${ed}><input type="text" id="o_pb" value="${esc(c.published_basis || "")}" placeholder="How established" style="margin-top:6px" ${ed}></div>
            <div><label class="f" for="o_ea">Claimed event date</label><input type="datetime-local" id="o_ea" value="${toLocalInput(c.claimed_event_at)}" ${ed}><input type="text" id="o_eb" value="${esc(c.claimed_event_basis || "")}" placeholder="What the content says" style="margin-top:6px" ${ed}></div>
          </div>
          <div class="hint">Capture dates come from each file's metadata and are shown on the timeline as leads.</div>
          ${P.edit ? `<div style="margin-top:12px"><button class="btn primary" id="saveO">Save changes</button></div>` : ""}</div></div>
      </div>
      <div class="stack">${accountLocationCard(c, P)}${timelineCard(c)}${relatedCard(c, P)}${checklistCard(c, P)}</div></div>`;
    if (P.edit) $("#saveO").onclick = () => act(() => api.patch(`/api/cases/${c.id}`, {
      title: $("#o_t").value, priority: $("#o_p").value, claim_text: $("#wc").value, source_platform: $("#o_sp").value, source_account: $("#o_sa").value || null, source_url: $("#o_su").value || null, hashtags: $("#o_ht").value,
      received_at: fromLocalInput($("#o_ra").value), published_at: fromLocalInput($("#o_pa").value), published_basis: $("#o_pb").value || null, claimed_event_at: fromLocalInput($("#o_ea").value), claimed_event_basis: $("#o_eb").value || null
    }), "Saved. A new version was recorded.");
    bindChecklist(c, P); bindAccountLocation(c, P);
    if ($("#relAdd")) $("#relAdd").onclick = () => { const id2 = $("#relId").value.trim().toUpperCase(); if (!id2) return toast("Enter a case ID, for example C-2026-0004.", "err"); act(() => api.post(`/api/cases/${c.id}/links`, { related_id: id2, relation: $("#relKind").value, note: $("#relNote").value }), `Linked to ${id2}.`); };
    $$("[data-unrel]").forEach(b => b.onclick = async () => { if (await confirmBox("Remove this link?", "Both cases stay as they are; only the link is removed (recorded in the audit log).", "Remove")) act(() => api.del(`/api/cases/${c.id}/links/${b.dataset.unrel}`), "Link removed."); });
  }
  function relatedCard(c, P) {
    const REL = { same_content: "Same content", same_claim: "Same claim", same_campaign: "Possibly same campaign (unconfirmed)", follow_up: "Follow-up", related: "Related" }, R = A.related || [];
    return `<div class="card"><div class="hd"><h3>Related cases</h3><span class="chip grey right">${R.length}</span></div><div class="bd">
      ${R.length ? `<ul class="mini">${R.map(r => `<li><a class="mono small" href="#/case/${esc(r.id)}">${esc(r.id)}</a><span class="small" style="flex:1">${esc(r.title)} <span class="sub">· ${esc(REL[r.relation] || r.relation)}${r.note ? ` · ${esc(r.note)}` : ""}</span></span>${status(r.status)}${P.edit ? `<button class="btn sm ghost" data-unrel="${esc(r.id)}" aria-label="Remove link to ${esc(r.id)}">×</button>` : ""}</li>`).join("")}</ul>` : `<p class="small muted" style="margin:0">No linked cases. Similar earlier cases found by analysis or search appear as evidence leads.</p>`}
      ${P.edit ? `<div class="row" style="margin-top:8px"><input type="text" id="relId" placeholder="Case ID" style="width:130px"><select id="relKind" style="width:auto">${Object.entries(REL).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div><input type="text" id="relNote" placeholder="Note (optional)" style="margin-top:6px"><button class="btn sm" id="relAdd" style="margin-top:6px">Link case</button>
        <div class="hint">Linking records a working relationship. It is not a finding that the cases share an author or campaign.</div>` : ""}</div></div>`;
  }
  function timeline(c) {
    const T = [], add = (d, kind, label) => d && !isNaN(new Date(d)) && T.push({ d, kind, label });
    add(c.received_at, "received", `Received by the team (${c.source_platform})`);
    add(c.published_at, "published", `Published, per source${c.published_basis ? ` — ${c.published_basis}` : ""}`);
    add(c.claimed_event_at, "claimed", `Event date the content claims${c.claimed_event_basis ? ` — ${c.claimed_event_basis}` : ""}`);
    const ce = extractEntities(c.claim_text);
    ce.dates.filter(d => d.iso).forEach(d => add(d.iso, "claimed", `Date stated in the post: “${d.text}”`));
    if (ce.relative.length && !c.claimed_event_at) add(c.published_at || c.received_at, "claimed", `Post presents events as current (${ce.relative.map(r => `“${r}”`).join(", ")}) — placed on the ${c.published_at ? "publication" : "received"} date`);
    const seen = new Set();
    for (const m of A.matches.filter(x => x.target_archive_id)) { const k = m.target_archive_id; if (!seen.has(k)) { seen.add(k); add(m.archive_date, "archive", `${m.kind === "exact" ? "Identical file" : m.level === "strong" ? "Strong archive match" : "Possible archive match"}: ${m.target_archive_id} “${m.archive_title}”`); } }
    for (const m of A.matches.filter(x => x.target_case_id)) add(m.case_received_at, "case", `Same media received in case ${m.target_case_id}`);
    for (const m of A.media.filter(x => x.meta_capture_at)) add(m.meta_capture_at, "meta", `Capture time in metadata of ${m.id} (lead; time zone unknown)`);
    for (const o of A.ocr) extractEntities(o.current_text).dates.filter(d => d.iso).forEach(d => add(d.iso, "visible", `Date visible in ${o.media_id}: “${d.text}”`));
    T.sort((a, b) => new Date(a.d) - new Date(b.d));
    const claimed = T.filter(t => t.kind === "claimed" || t.kind === "published").map(t => +new Date(t.d)), ev = T.filter(t => ["archive", "visible", "meta"].includes(t.kind));
    let conflict = null;
    if (claimed.length && ev.length) { const gap = (Math.min(...claimed) - new Date(ev[0].d)) / 864e5; if (gap > 30) conflict = { e: ev[0], days: Math.round(gap) }; }
    return { T, conflict };
  }
  function timelineCard(c) {
    const { T, conflict } = timeline(c), L = { received: "Received", published: "Published", claimed: "Claimed", archive: "Archive", case: "Other case", meta: "Metadata", visible: "Visible text" };
    const span = d => d >= 730 ? `${Math.round(d / 365)} years` : d >= 60 ? `${Math.round(d / 30)} months` : `${d} days`;
    return `<div class="card"><div class="hd"><h3>Date timeline</h3><span class="small sub right">Each date as one source states it</span></div><div class="bd">
      ${conflict ? `<div class="callout bad" style="margin-bottom:10px"><div><b>Timing conflict.</b> ${esc(conflict.e.label)} (${fmtD(conflict.e.d)}) is ${span(conflict.days)} earlier than the timing the content claims. Treat this as a lead and confirm the earlier date independently.</div></div>` : ""}
      ${T.length ? `<ol class="tl">${T.map(t => `<li class="${t.kind}"><span class="num small">${fmtD(t.d)}</span><span><span class="chip grey">${L[t.kind]}</span></span><span class="small">${esc(t.label)}</span></li>`).join("")}</ol>` : `<p class="muted small">No dates recorded yet.</p>`}</div></div>`;
  }
  function checklistCard(c, P) {
    const done = A.checklist.filter(k => k.state !== "todo").length;
    return `<div class="card"><div class="hd"><h3>Verification checklist</h3><span class="chip ${done === A.checklist.length ? "sup" : "grey"} right">${done} of ${A.checklist.length} addressed</span></div><div class="bd"><div class="ckl">
      ${A.checklist.map(k => `<div class="it ${k.state}"><select data-ck="${esc(k.step)}" ${P.edit ? "" : "disabled"} aria-label="${esc(k.label)}"><option value="todo">Not done</option><option value="done" ${k.state === "done" ? "selected" : ""}>Done</option><option value="na" ${k.state === "na" ? "selected" : ""}>Not applicable</option></select><span>${esc(k.label)}</span><input type="text" data-ckn="${esc(k.step)}" value="${esc(k.note || "")}" placeholder="Note or reference" ${P.edit ? "" : "disabled"}></div>`).join("")}
      </div>${P.edit ? `<div class="row" style="margin-top:10px"><input type="text" id="ckNew" placeholder="Add a case-specific check" style="max-width:360px"><button class="btn sm" id="ckAdd">Add</button></div>` : ""}</div></div>`;
  }
  function bindChecklist(c, P) {
    if (!P.edit) return;
    $$("[data-ck]").forEach(s => s.onchange = () => act(() => api.put(`/api/cases/${c.id}/checklist/${encodeURIComponent(s.dataset.ck)}`, { state: s.value })));
    $$("[data-ckn]").forEach(i => i.onchange = () => act(() => api.put(`/api/cases/${c.id}/checklist/${encodeURIComponent(i.dataset.ckn)}`, { note: i.value })));
    $("#ckAdd").onclick = () => { const v = $("#ckNew").value.trim(); if (v) act(() => api.put(`/api/cases/${c.id}/checklist/custom-${Date.now()}`, { label: v }), "Check added."); };
  }

  // ---------------------------------------------------------------- media
  function media(body, c, P) {
    const top = A.media.filter(m => !m.parent_media_id), frames = id => A.media.filter(m => m.parent_media_id === id);
    const canAdd = P.edit;
    body.innerHTML = `${canAdd ? `<div class="card"><div class="bd"><div class="dropzone" id="dz" tabindex="0" role="button"><b>Add images, video, audio or documents</b><div class="small muted">Drop files, paste a screenshot (Ctrl+V) or choose files: images, video, audio (voice notes: MP3, M4A, WAV, OGG/Opus, AMR, FLAC), PDF, Word (.docx), TXT, CSV or JSON. Originals are kept unchanged and fingerprinted. Re-run checks afterwards.</div><input type="file" id="fi" multiple accept="image/*,video/*,audio/*,.mov,.avi,.opus,.amr,.m4a,.pdf,.docx,.txt,.csv,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden></div>${App.meta.transcribe?.ok ? `<div class="row" style="margin-top:8px"><label class="small" for="utl">Transcribe audio and video on upload</label><select id="utl" style="width:auto"><option value="">No</option>${LANG_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>` : ""}<ul class="uplist" id="ul"></ul></div></div>` : ""}
      <div class="card"><div class="hd"><h3>Media under examination</h3><span class="small sub right">${A.media.length} item${A.media.length === 1 ? "" : "s"} · archive similarity and metadata are investigative leads, not proof</span></div>
      ${top.length ? top.map(m => m.kind === "document" ? docCard(m, P) : m.kind === "audio" ? audioCard(m, P) : m.kind === "video" ? videoCard(m, frames(m.id), P) + frames(m.id).map(f => imageCard(f, P)).join("") : imageCard(m, P)).join("") : `<div class="bd">${empty("No media attached", "This case has text only. Add the image or video that circulated with the post, if there was one.")}</div>`}</div>`;
    if (canAdd) bindUpload(c);
    bindMedia(c, P);
    bindTranscripts(A, c, P, reload, isCurrent);
  }
  function audioCard(m, P) {
    return `<div class="mediacard" id="mc-${esc(m.id)}"><div><div class="docicon" aria-hidden="true">AUDIO</div><div class="tiny sub" style="margin-top:6px">${kb(m.size)}</div></div>
      <div><h4>${esc(m.id)} <span class="small sub" style="font-weight:400">${esc(m.original_name)}</span> <span class="chip grey">Audio</span></h4>
        <audio id="aud-${esc(m.id)}" src="${content(m.id)}" controls preload="metadata" style="width:100%;margin-top:6px"></audio>
        <dl class="kv" style="margin-top:8px"><dt>File</dt><dd>${esc(m.mime)} · ${kb(m.size)} · received ${fmtDT(m.uploaded_at)}</dd><dt>SHA-256 (exact bytes)</dt><dd class="mono tiny">${esc(m.sha256)}</dd></dl>
        <div class="row"><a class="btn sm ghost" href="${content(m.id)}?download=1">Download original</a></div>
        ${transcriptPanel(m)}</div></div>`;
  }
  function docCard(m, P) {
    const d = m.document || {}, meta = Object.entries(m.metadata || {}), ocr = A.ocr.filter(o => o.media_id === m.id), scanned = (d.warnings || []).some(w => /scanned/.test(w)), ext = (m.original_name.match(/\.(\w+)$/) || [])[1]?.toUpperCase() || "DOC";
    return `<div class="mediacard" id="mc-${esc(m.id)}"><div><div class="docicon" aria-hidden="true">${esc(ext)}</div><div class="tiny sub" style="margin-top:6px">${kb(m.size)}${d.pages ? ` · ${d.pages} page${d.pages > 1 ? "s" : ""}` : ""}</div></div>
      <div><h4>${esc(m.id)} <span class="small sub" style="font-weight:400">${esc(m.original_name)}</span> <span class="chip grey">Document</span></h4>
        <div class="mono tiny sub adv">SHA-256 ${esc(m.sha256)}</div>
        ${(d.warnings || []).map(w => `<div class="callout warn" style="margin-top:6px"><div class="small">${esc(w)}</div></div>`).join("")}
        <div style="margin-top:8px"><b class="small">Document properties</b> <span class="tiny sub">(leads only: easy to edit, often left over from templates)</span>${meta.length ? `<dl class="kv small" style="margin-top:4px">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : `<div class="small muted">None recorded.</div>`}</div>
        <details style="margin-top:8px" ${d.chars && d.chars < 4000 ? "open" : ""}><summary class="small"><b>Text</b> <span class="sub">(${(d.chars || 0).toLocaleString()} characters, ${esc(d.extractor || "")})</span></summary><pre class="box" style="max-height:360px;overflow:auto">${esc(d.preview || "(no text layer)")}${(d.chars || 0) > 6000 ? "\n\n… (download the full text)" : ""}</pre></details>
        ${ocr.map(o => `<div class="ocrbox" style="margin-top:8px"><b class="small">Text read from the pages (OCR, ${esc(o.lang)})</b><textarea data-ocrtext="${o.id}" rows="6" ${P.edit ? "" : "disabled"}>${esc(o.current_text)}</textarea>${P.edit ? `<button class="btn sm" data-ocrsave="${o.id}">Save correction</button>` : ""}</div>`).join("")}
        <div class="row" style="margin-top:10px">${P.edit ? `<button class="btn sm primary" data-docclaims="${esc(m.id)}" ${A.claimCapacity.remaining < 1 ? "disabled" : ""}>Add claims from this document</button>${scanned || !d.chars ? `<button class="btn sm" data-dococr="${esc(m.id)}" ${App.meta.ocr.length ? "" : "disabled"}>Read text from pages (OCR)</button>` : ""}` : ""}<a class="btn sm ghost" href="/api/media/${esc(m.id)}/text">Download text</a><a class="btn sm ghost" href="${content(m.id)}?download=1">Download original</a></div>
        <div class="hint">AIVS never opens documents inside the app and does not run macros or scripts in them.</div></div></div>`;
  }
  function bindUpload(c) {
    const dz = $("#dz"), fi = $("#fi");
    dz.onclick = () => fi.click(); dz.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
    dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); }; dz.ondragleave = () => dz.classList.remove("over");
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove("over"); up([...e.dataTransfer.files]); };
    fi.onchange = () => up([...fi.files]);
    const onPaste = e => { if (!document.body.contains(dz)) return document.removeEventListener("paste", onPaste); const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); up(fs.map(f => new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.png`, { type: f.type }))); } };
    document.addEventListener("paste", onPaste);
    async function up(files) {
      for (const f of files) {
        const li = document.createElement("li"); li.innerHTML = `<div class="ph">${f.type.startsWith("video") ? "VIDEO" : f.type.startsWith("audio") ? "AUDIO" : f.type.startsWith("image") ? "IMG" : "DOC"}</div><div><b class="small">${esc(f.name)}</b> <span class="tiny sub">${kb(f.size)}</span><div class="progress"><div style="width:0"></div></div><div class="tiny sub st">Uploading…</div></div><span></span>`;
        $("#ul").appendChild(li);
        const fd = new FormData(); fd.append("files", f, f.name); if ($("#utl")?.value) fd.append("transcribe", $("#utl").value);
        try { const r = await api.upload(`/api/cases/${c.id}/media`, fd, p => (li.querySelector(".progress div").style.width = `${p * 100}%`)); if (!r.media?.length) throw new Error((r.errors || []).join(" ")); const x = r.media[0]; li.querySelector(".st").textContent = `Stored as ${x.id}.${x.transcript ? ` Transcription ${x.transcript} started.` : ""}${x.transcribe_error ? ` Not transcribed: ${x.transcribe_error}` : ""}`; }
        catch (e) { li.querySelector(".st").textContent = e.message; li.querySelector(".st").style.color = "var(--con)"; }
      }
      toast("Upload finished. Re-run checks to compare the new items."); await reload();
    }
  }
  const explain = m => m.kind === "exact" ? `The two files are byte-for-byte identical (equal SHA-256). This shows the same file was received before; it says nothing about where it originally came from.`
    : `${m.dhash_distance} of 64 gradient bits and ${m.phash_distance} of 64 frequency bits differ (${m.score} of 128 in total; lower means more alike). In the built-in test set, re-saved, cropped, recoloured or captioned copies scored 18 or less and unrelated pictures 45 or more. This measures how alike the two files look — it is not a probability that they show the same event.`;
  function imageCard(m, P) {
    const ms = A.matches.filter(x => x.media_id === m.id), ocr = A.ocr.filter(o => o.media_id === m.id), meta = Object.entries(m.metadata || {});
    const parent = m.parent_media_id ? A.media.find(x => x.id === m.parent_media_id) : null;
    return `<div class="mediacard" id="mc-${esc(m.id)}">
      <div><div class="pv"><img src="${thumb(m.id)}" alt="${esc(m.original_name)}" data-view="${esc(m.id)}" loading="lazy"></div>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-view="${esc(m.id)}">Enlarge</button><button class="btn sm adv" data-ela="${esc(m.id)}">Error level analysis</button>${P.edit ? `<button class="btn sm primary" data-ris="${esc(m.id)}">Search prior postings</button>` : ""}<button class="btn sm" data-web="${esc(m.id)}" title="Upload the image yourself to a reverse-image search service">Manual reverse search</button><a class="btn sm ghost" href="${content(m.id)}" target="_blank" rel="noopener">Original</a><a class="btn sm ghost" href="${content(m.id)}?download=1">Download</a></div>
        <div data-elabox="${esc(m.id)}" hidden></div></div>
      <div style="min-width:0">
        <h4>${esc(m.id)} ${parent ? `<span class="chip info">Frame at ${m.frame_time.toFixed(2)} s of ${esc(parent.id)} · ${m.frame_origin === "auto" ? "auto-sampled" : "selected by analyst"}</span>` : `<span class="small sub" style="font-weight:400">${esc(m.original_name)}</span>`}</h4>
        <dl class="kv" style="margin-top:8px"><dt>File</dt><dd>${esc(m.mime)} · ${kb(m.size)}${m.width ? ` · ${m.width}×${m.height}` : ""} · received ${fmtDT(m.uploaded_at)}</dd>
          <dt>SHA-256 (exact bytes)</dt><dd class="mono tiny">${esc(m.sha256)}</dd>
          <dt class="adv">Perceptual hashes</dt><dd class="mono tiny adv">dHash ${esc(m.dhash || "—")} · pHash ${esc(m.phash || "—")}</dd>
          <dt>Embedded metadata</dt><dd>${meta.length ? meta.map(([k, v]) => `<div><span class="sub">${esc(k)}:</span> ${esc(v)}</div>`).join("") : `<span class="sub">None. Usual after social-media upload; nothing follows from its absence.</span>`}<div class="tiny sub">Investigative lead only: metadata can be edited, copied or stripped.</div></dd></dl>
        <div style="margin-top:12px"><b class="small">Matches</b>${ms.length ? ms.map(x => matchBlock(m, x)).join("") : `<div class="callout info" style="margin-top:6px"><div>${A.case.status === "draft" ? "Run local analysis to search the reference archive." : "No earlier copy in the reference archive or other cases. This does not show the image is new, original or authentic."}</div></div>`}</div>
        <div class="ocrbox"><div class="row"><b class="small">Visible text (OCR)</b>${P.edit ? `<span style="margin-left:auto" class="row"><select data-ocrlang="${esc(m.id)}" style="width:auto;padding:4px 6px;font-size:12.5px" aria-label="OCR language">${App.meta.ocr.length > 1 ? `<option value="eng+swa">English + Kiswahili</option>` : ""}${App.meta.ocr.map(l => `<option value="${l.code}">${l.label}</option>`).join("")}</select><button class="btn sm" data-ocr="${esc(m.id)}" ${App.meta.ocr.length ? "" : "disabled"}>Read text</button></span>` : ""}</div>
          ${!App.meta.ocr.length ? `<div class="hint">OCR language data is not installed on the server.</div>` : ""}
          ${ocr.map(o => `<div style="margin-top:10px"><div class="tiny sub">${esc(o.engine)} · ${esc(o.lang)}${o.confidence != null ? ` · mean confidence ${Math.round(o.confidence)}%` : ""} · ${fmtDT(o.created_at)}${o.versions.length ? ` · ${o.versions.length} correction${o.versions.length > 1 ? "s" : ""}` : ""}</div>
            <textarea data-ocrtext="${o.id}" rows="4" ${P.edit ? "" : "disabled"} aria-label="Checked OCR text">${esc(o.current_text)}</textarea>
            <div class="row" style="margin-top:4px">${P.edit ? `<button class="btn sm" data-ocrsave="${o.id}">Save correction</button>` : ""}<details><summary class="tiny sub">Original extraction (unchanged)</summary><pre class="box">${esc(o.original_text)}</pre></details></div></div>`).join("") || `<div class="hint">No text extracted yet. OCR runs in your browser using the engine on this server; nothing leaves the system.</div>`}</div>
      </div></div>`;
  }
  function matchBlock(m, x) {
    const lvl = x.kind === "exact" ? `<span class="chip con">Identical file</span>` : x.level === "strong" ? `<span class="chip con">Strong similarity</span>` : `<span class="chip warn">Possible similarity</span>`;
    const target = x.target_archive_id ? `Archive <b>${esc(x.target_archive_id)}</b> · ${esc(x.archive_title)} · documented ${fmtD(x.archive_date)} ${x.archive_type === "misleading" ? `<span class="chip con">previously assessed misleading</span>` : `<span class="chip sup">documented original</span>`}`
      : `Case <a href="#/case/${esc(x.target_case_id)}">${esc(x.target_case_id)}</a> · ${esc(x.case_title)} · ${esc(STATUS[x.case_status])}${x.case_conclusion ? ` · ${esc(CONCL[x.case_conclusion][0])}` : ""}`;
    return `<div class="match ${x.kind === "exact" ? "identical" : x.level}" data-match="${x.id}">
      <div class="mh">${lvl}<span class="small" style="min-width:0">${target}</span></div>
      <div class="mb">${x.target_archive_id ? `<div class="small muted">${esc(x.archive_description || "")} <span class="sub">Source: ${esc(x.archive_ref || "")}</span></div>` : ""}
        <div class="explain">${explain(x)}${x.kind !== "exact" ? ` Best match on the archive's <b>${esc(x.window_label)}</b>${x.mirrored ? "; the submission is a <b>mirror image</b>" : ""}.` : ""}</div>
        <div class="seg" style="margin-top:8px" role="group" aria-label="Comparison view">${["Side by side", "Slider", ...(x.kind === "exact" ? [] : ["Differences"]), ...(x.target_archive_id && x.ww != null ? ["Matched region"] : [])].map((l, i) => `<button class="${i === 0 ? "on" : ""}" data-cmp="${x.id}" data-mode="${l}">${l}</button>`).join("")}</div>
        <div class="cmpbox" data-cmpbox="${x.id}">${sbs(m, x)}</div></div></div>`;
  }
  const sbs = (m, x) => `<div class="compare sbs"><figure><img src="${thumb(m.id)}" alt="Submitted" style="${x.mirrored ? "transform:scaleX(-1)" : ""}"><figcaption>Submitted ${esc(m.id)}${x.mirrored ? " (flipped back)" : ""}</figcaption></figure><figure><img src="${thumb(x.target_media_id)}" alt="Reference"><figcaption>${x.target_archive_id ? `Archive ${esc(x.target_archive_id)}` : `Case ${esc(x.target_case_id)}`}</figcaption></figure></div>`;
  function videoCard(m, frames, P) {
    return `<div class="mediacard" id="mc-${esc(m.id)}"><div><div class="pv"><video id="vid-${esc(m.id)}" src="${content(m.id)}" controls preload="metadata"></video></div>
        <div class="row" style="margin-top:8px">${P.edit ? `<button class="btn sm primary" data-rvs="${esc(m.id)}" title="Automatic: keyframes, on-screen text, speech, reverse search of keyframes, earlier versions, findings">Reverse video search</button><button class="btn sm" data-cap="${esc(m.id)}">Capture this frame</button><button class="btn sm" data-sample="${esc(m.id)}">Sample 6 frames</button>` : ""}<a class="btn sm ghost" href="${content(m.id)}?download=1">Download original</a></div>
        <div class="tiny sub" id="vt-${esc(m.id)}" style="margin-top:4px"></div></div>
      <div><h4>${esc(m.id)} <span class="small sub" style="font-weight:400">${esc(m.original_name)}</span> <span class="chip grey">Video</span></h4>
        <dl class="kv" style="margin-top:8px"><dt>File</dt><dd>${esc(m.mime)} · ${kb(m.size)} · received ${fmtDT(m.uploaded_at)}</dd><dt>SHA-256 (exact bytes)</dt><dd class="mono tiny">${esc(m.sha256)}</dd></dl>
        <p class="small muted">Video is compared through its frames. Pause on a moment worth checking and capture it; the timestamp is recorded with the frame. Frames are then matched like images after you re-run checks.</p>
        <div class="frames">${frames.map(f => `<figure><a href="#mc-${esc(f.id)}"><img src="${thumb(f.id)}" alt=""></a><figcaption class="num">${f.frame_time.toFixed(2)} s · ${f.frame_origin === "auto" ? "auto" : "analyst"}${A.matches.some(x => x.media_id === f.id && x.level !== "possible") ? ` <span class="chip con">match</span>` : ""}</figcaption></figure>`).join("") || `<span class="small sub">No frames yet.</span>`}</div>
        <div class="vbox" data-rvsbox="${esc(m.id)}" style="margin-top:10px"></div>
        ${transcriptPanel(m)}</div></div>`;
  }
  // reverse video search (1.35): automatic; the latest analysis of each video is shown in its card
  async function showVideoCheck(mid, poll = false) {
    const box = $(`[data-rvsbox="${CSS.escape(mid)}"]`); if (!box) return;
    let list; try { list = (await api.get(`/api/media/${encodeURIComponent(mid)}/video-checks`)).analyses; } catch { return; }
    const a = list[0]; if (!a) { box.innerHTML = ""; return; }
    const running = ["queued", "running"].includes(a.status);
    box.innerHTML = `<div class="card"><div class="hd"><h3>Reverse video search <span class="mono small">${esc(a.id)}</span></h3><span class="chip ${a.status === "done" ? "sup" : a.status === "failed" ? "con" : "grey"} right">${esc(a.status === "done" ? "Completed" : a.status === "failed" ? "Failed" : "Running")}</span></div><div class="bd">
      ${running || a.status === "failed" ? stagesHtml(a.stages) : ""}${a.status === "failed" ? `<div class="callout bad" style="margin-top:6px"><div>${esc(a.error || "")}</div></div>` : ""}${a.result ? videoResultHtml(a.result) : ""}</div></div>`;
    if (running) setTimeout(() => showVideoCheck(mid, true), 1500);
    else if (poll && a.status === "done") { toast("Reverse video search finished. The keyframes were added to the case."); await reload(); }
  }
  function bindMedia(c, P) {
    $$("[data-rvsbox]").forEach(b => showVideoCheck(b.dataset.rvsbox));
    $$("[data-rvs]").forEach(b => b.onclick = async () => {
      b.disabled = true; b.innerHTML = '<span class="spin"></span> Starting…';
      try { await api.post(`/api/media/${encodeURIComponent(b.dataset.rvs)}/video-check`); toast("Reverse video search started. It runs automatically; results appear here."); showVideoCheck(b.dataset.rvs, true); }
      catch (e) { fail(e); } finally { b.disabled = false; b.textContent = "Reverse video search"; }
    });
    $$("[data-ris]").forEach(b => b.onclick = () => onlineImageSearch(A.media.find(m=>m.id===b.dataset.ris),P));
    $$("[data-web]").forEach(b => b.onclick = () => webSearch(A.media.find(x => x.id === b.dataset.web), P));
    $$("[data-view]").forEach(b => b.onclick = () => { const m = A.media.find(x => x.id === b.dataset.view); viewer(content(m.id), `${m.id} · ${m.original_name}`); });
    $$("[data-ela]").forEach(b => b.onclick = async () => {
      const box = $(`[data-elabox="${b.dataset.ela}"]`); if (!box.hidden) { box.hidden = true; return; }
      b.innerHTML = '<span class="spin"></span> Computing…';
      try { const r = await errorLevel(content(b.dataset.ela)); box.innerHTML = `<img src="${r.url}" alt="Error level analysis" style="width:100%;margin-top:8px;border-radius:6px;cursor:zoom-in"><div class="hint">Bright areas recompress differently from the rest. Edges, text and re-saved images are naturally bright. Use it to decide where to look closer; it does not prove editing or AI generation.</div>`; box.hidden = false; box.querySelector("img").onclick = () => viewer(r.url, "Error level analysis"); }
      catch (e) { fail(e); } b.textContent = "Error level analysis";
    });
    $$("[data-cmp]").forEach(b => b.onclick = async () => {
      const x = A.matches.find(y => String(y.id) === b.dataset.cmp), m = A.media.find(y => y.id === x.media_id), box = $(`[data-cmpbox="${x.id}"]`);
      b.parentElement.querySelectorAll("button").forEach(y => y.classList.toggle("on", y === b));
      const mode = b.dataset.mode;
      if (mode === "Side by side") box.innerHTML = sbs(m, x);
      if (mode === "Slider") { box.innerHTML = `<div class="compare slider"><img src="${thumb(x.target_media_id)}" alt=""><div class="clip"><img src="${thumb(m.id)}" alt="" style="${x.mirrored ? "transform:scaleX(-1)" : ""}"></div><span class="lbl">Submitted</span><span class="lbl r">Reference</span></div><div class="hint">Drag across the image, or focus it and use the arrow keys.</div>`; bindSlider(box.querySelector(".slider")); }
      if (mode === "Differences") {
        box.innerHTML = `<div class="small muted" style="padding:10px"><span class="spin"></span> Aligning and comparing…</div>`;
        try { const r = await differenceMap(content(x.target_media_id), content(m.id), { mirrored: !!x.mirrored, hintW: x.ww }); box.innerHTML = `<div class="compare"><img class="single" src="${r.url}" alt="Difference map"></div><div class="explain"><b>${Math.round(r.changed * 100)}%</b> of the submitted image differs noticeably from the reference (red). The submission was aligned to ${Math.round(r.region.w * 100)}% × ${Math.round(r.region.h * 100)}% of the reference. Red marks added, removed or altered content such as a caption banner or crop edge; scattered specks are compression noise. This does not show who changed what, or when.</div>`; box.querySelector("img").onclick = () => viewer(r.url, "Difference map"); }
        catch (e) { box.innerHTML = `<div class="callout bad"><div>${esc(e.message)}</div></div>`; }
      }
      if (mode === "Matched region") { const u = await matchedRegion(content(x.target_media_id), x); box.innerHTML = `<div class="compare"><img class="single" src="${u}" alt="Matched region"></div><div class="explain">The outlined area of archive ${esc(x.target_archive_id)} is the part that best matches the submission (${esc(x.window_label)}).</div>`; }
    });
    $$("[data-ocr]").forEach(b => b.onclick = async () => {
      const mid = b.dataset.ocr, lang = $(`[data-ocrlang="${mid}"]`).value; b.disabled = true; b.innerHTML = '<span class="spin"></span> Reading 0%';
      try { const r = await recognise(content(mid), lang, p => (b.innerHTML = `<span class="spin"></span> Reading ${Math.round(p * 100)}%`)); await api.post(`/api/media/${mid}/ocr`, { engine: r.engine, lang, confidence: r.confidence, text: r.text }); toast(r.text ? "Text extracted. Check it by eye and correct it if needed." : "No text found in this image."); await reload(); }
      catch (e) { fail(e); b.disabled = false; b.textContent = "Read text"; }
    });
    $$("[data-docclaims]").forEach(b => b.onclick = async () => { try { const r = await api.post(`/api/media/${b.dataset.docclaims}/claims`); toast(r.added ? `${r.added} claim${r.added > 1 ? "s" : ""} added from the document. Review them on the Claims tab and remove any that do not matter.` : "No new checkable statements were found in the document."); await reload(); } catch (e) { fail(e); } });
    $$("[data-dococr]").forEach(b => b.onclick = async () => {
      const mid = b.dataset.dococr, lang = App.meta.ocr.length > 1 ? "eng+swa" : App.meta.ocr[0].code; b.disabled = true; b.innerHTML = '<span class="spin"></span> Opening…';
      try {
        const pdfjs = await import("/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
        const data = new Uint8Array(await (await fetch(content(mid), { credentials: "same-origin" })).arrayBuffer()), doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise, n = Math.min(doc.numPages, 20), parts = []; let conf = 0;
        for (let i = 1; i <= n; i++) {
          const pg = await doc.getPage(i), vp = pg.getViewport({ scale: 2 }), cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
          await pg.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
          const r = await recognise(cv, lang, p => (b.innerHTML = `<span class="spin"></span> Page ${i} of ${n}: ${Math.round(p * 100)}%`)); parts.push(`--- Page ${i} ---\n${r.text}`); conf += r.confidence;
        }
        await api.post(`/api/media/${mid}/ocr`, { engine: `pdf.js + Tesseract.js (local)${doc.numPages > n ? `, first ${n} of ${doc.numPages} pages` : ""}`, lang, confidence: conf / n, text: parts.join("\n\n") });
        toast("Pages read. Check the text against the document and correct it if needed."); await reload();
      } catch (e) { fail(e); b.disabled = false; b.textContent = "Read text from pages (OCR)"; }
    });
    $$("[data-ocrsave]").forEach(b => b.onclick = () => act(() => api.patch(`/api/ocr/${b.dataset.ocrsave}`, { text: $(`[data-ocrtext="${b.dataset.ocrsave}"]`).value }), "Correction saved. The original extraction is kept."));
    $$("[data-cap]").forEach(b => b.onclick = async () => {
      const v = $(`#vid-${CSS.escape(b.dataset.cap)}`); if (!v.videoWidth) return toast("Play or seek the video first so a frame is loaded.", "err");
      v.pause(); const t = v.currentTime; b.disabled = true;
      try { await uploadFrame(b.dataset.cap, await frameBlob(v), t, "analyst"); toast(`Frame at ${t.toFixed(2)} s captured. Re-run checks to compare it.`); await reload(); } catch (e) { fail(e); b.disabled = false; }
    });
    $$("[data-sample]").forEach(b => b.onclick = async () => {
      b.disabled = true; const st = $(`#vt-${CSS.escape(b.dataset.sample)}`);
      try { const n = await sampleFrames(b.dataset.sample, content(b.dataset.sample), 6, p => (st.textContent = `Extracting frames… ${Math.round(p * 100)}%`)); toast(`${n} frames extracted.`); await reload(); } catch (e) { st.textContent = e.message; b.disabled = false; }
    });
    $$("video").forEach(v => { const st = $(`#vt-${CSS.escape(v.id.slice(4))}`); v.ontimeupdate = () => st && (st.textContent = `Current position ${v.currentTime.toFixed(2)} s of ${isFinite(v.duration) ? v.duration.toFixed(2) : "?"} s`); v.onerror = () => st && (st.innerHTML = `<span style="color:var(--con)">This browser cannot play this video format. Download the original and convert it to MP4 (H.264), then add the converted copy.</span>`); });
  }

  // ---------------------------------------------------------------- claims
  function claims(body, c, P) {
    const active = A.claims.filter(x => !x.removed), removed = A.claims.filter(x => x.removed), ed = P.edit;
    const n = k => active.filter(x => x.assessment === k).length, exp = A.expectedConclusion;
    const linked = cl => A.evidence.filter(e => e.status === "accepted" && e.links.some(l => l.claim_id === cl.id)).map(e => ({ e, s: e.links.find(l => l.claim_id === cl.id).stance }));
    body.innerHTML = `<div class="card"><div class="bd"><div class="row" style="gap:18px">
        <div><div class="label">Assessed</div><div class="num" style="font-size:20px;font-weight:800">${active.length - n("unassessed")} / ${active.length}</div></div>
        ${Object.keys(ASSESS).filter(k => k !== "unassessed" && (n(k) || ["supported", "contradicted", "insufficient"].includes(k))).map(k => `<div><div class="label">${ASSESS[k][0]}</div><div class="num" style="font-size:20px;font-weight:800;color:var(--${ASSESS[k][1]})">${n(k)}</div></div>`).join("")}
        <div style="margin-left:auto;max-width:440px" class="small">${exp ? `These assessments lead to an overall conclusion of ${concl(exp)}.${exp === "mixed" ? " The post contains both supported and contradicted claims." : ""}` : `Assess every claim to reach an overall conclusion. A post with both supported and contradicted claims is concluded as <b>Mixed findings</b>.`}</div></div></div></div>
      ${searchCard(c, P, active)}
      ${!active.length ? `<div class="card"><div class="bd">${empty(c.status === "draft" ? "Claims appear after analysis" : "No claims", c.status === "draft" ? "Run local analysis to split the post into checkable claims, or add claims yourself." : "Add the specific, checkable statements the content makes.")}</div></div>` : ""}
      <div style="margin-top:14px">${active.map(cl => { const L = linked(cl); return `<div class="claim a-${cl.assessment}"><div class="no" aria-label="Claim ${cl.seq}">${cl.seq}</div><div style="min-width:0">
        <div class="row" style="margin-bottom:6px"><span class="chip grey">${esc(cl.kind)}</span>${cl.claim_type && cl.claim_type !== "factual" ? `<span class="chip warn" title="Rule-based hint${cl.claim_type_cue ? `: triggered by “${esc(cl.claim_type_cue)}”` : ""}. You decide.">${esc(STYPE[cl.claim_type] || cl.claim_type)}</span>` : cl.claim_type === "factual" ? `<span class="chip teal adv" title="Rule-based hint">checkable statement</span>` : ""}<span class="chip ${cl.origin === "ai" ? "info" : cl.origin === "extracted" ? "teal" : "grey"}">${cl.origin === "ai" ? "suggested by AI" : cl.origin === "extracted" ? "extracted automatically" : "added by analyst"}</span>
          ${ed ? `<span style="margin-left:auto" class="row"><select data-ckind="${cl.id}" style="width:auto;padding:3px 6px;font-size:12.5px" aria-label="Claim type">${["statement", "timing", "media", "location", "attribution"].map(k => `<option ${k === cl.kind ? "selected" : ""}>${k}</option>`).join("")}</select><button class="btn sm ghost" data-split="${cl.id}" ${A.claimCapacity.remaining < 1 ? "disabled" : ""}>Split</button><button class="btn sm ghost" data-rm="${cl.id}">Remove</button></span>` : ""}</div>
        ${cl.claim_type && cl.claim_type !== "factual" ? `<div class="hint" style="margin:-2px 0 6px">${esc(STYPE_HELP[cl.claim_type] || "")}</div>` : ""}<textarea class="ct" data-ctext="${cl.id}" rows="2" ${ed ? "" : "disabled"} aria-label="Claim ${cl.seq} text">${esc(cl.text)}</textarea>
        ${suggestBlock(cl, ed)}<div class="row" style="margin-top:8px"><div class="seg wrap" role="group" aria-label="Verdict for claim ${cl.seq}">${[...ACTIVE_VERDICTS, ...["partially_supported", "misleading_context"].filter(k => cl.assessment === k), "unassessed"].map(k => `<button data-v="${k}" data-assess="${cl.id}" class="${cl.assessment === k ? "on" : ""}" title="${esc(App.meta.verdictHelp?.[k] || "Not assessed yet")}" ${ed ? "" : "disabled"}>${ASSESS[k][0]}</button>`).join("")}</div>
          ${strengthChip(cl)}
          ${cl.assessed_by ? `<span class="tiny sub">by ${esc(A.users[cl.assessed_by] || "")} ${ago(cl.assessed_at)}</span>` : ""}</div>
        <label class="f" for="r-${cl.id}">Rationale for this claim</label><textarea id="r-${cl.id}" data-rat="${cl.id}" rows="2" ${ed ? "" : "disabled"} placeholder="What the evidence shows for this claim, and what it does not">${esc(cl.rationale || "")}</textarea>
        <div class="links">${L.map(({ e, s }) => `<span class="chip ${s === "supports" ? "sup" : s === "contradicts" ? "con" : "grey"}" title="${esc(e.text)}">${esc(e.id)} ${s}</span>`).join("") || `<span class="tiny sub">No evidence linked.</span>`}${ed ? `<button class="btn sm ghost" data-link="${cl.id}">Link evidence</button>${cl.kind !== "media" && (!cl.claim_type || cl.claim_type === "factual") ? `<button class="btn sm ghost" data-find="${cl.id}" title="Search the knowledge base, earlier cases and any configured search services for this claim">Search for evidence</button>` : ""}` : ""}</div>
      </div></div>`; }).join("")}</div>
      ${ed && A.claimCapacity.remaining > 0 ? `<div class="card" style="margin-top:14px"><div class="bd"><label class="f" for="nc" style="margin-top:0">Add a claim</label><div class="row"><input type="text" id="nc" placeholder="One specific, checkable statement" style="flex:1;min-width:240px"><select id="nck" style="width:auto">${["statement", "timing", "media", "location", "attribution"].map(k => `<option>${k}</option>`).join("")}</select><button class="btn primary" id="ncAdd">Add claim</button></div></div></div>` : ""}
      ${removed.length ? `<details style="margin-top:14px"><summary class="small sub">Historical claims (${removed.length}) — kept for the record</summary>${removed.map(cl => `<div class="panel small" style="margin-top:6px"><s>${esc(cl.text)}</s></div>`).join("")}</details>` : ""}`;
    if (A.claimCapacity.remaining === 0) body.insertAdjacentHTML("beforeend", `<p class="callout info" role="status">${CLAIM_LIMIT_MESSAGE} Edit the existing claims as needed. Removing a claim does not reopen a slot.</p>`);
    if (ed && A.claimCapacity.selection_required) {
      body.insertAdjacentHTML("afterbegin", `<div class="card"><div class="bd"><h3>Select claims for this older case</h3><p>Choose at most two. Unselected claims and their evidence links remain in history; existing report snapshots stay unchanged.</p>${active.map(cl => `<label class="check"><input type="checkbox" data-legacy-claim="${esc(cl.id)}"> ${esc(cl.text)}</label>`).join("")}<button class="btn primary" id="selectLegacyClaims">Keep selected claims</button></div></div>`);
      $("#selectLegacyClaims").onclick = () => act(() => api.post(`/api/cases/${c.id}/claims/select`, { claim_ids: $$("[data-legacy-claim]:checked").map(x => x.dataset.legacyClaim) }), "Claim selection saved.");
    }
    const candidates = (A.claimCandidates || []).filter(x => !A.claims.some(cl => cl.text === x.text));
    if (candidates.length) body.insertAdjacentHTML("beforeend", `<details><summary>Additional extracted statements (${candidates.length}) — not case claims</summary><p class="small">The original text is preserved. These candidates do not appear as assessed claims in a report.</p>${candidates.map(x => `<p class="small">${esc(x.text)}</p>`).join("")}</details>`);
    if (!ed) return;
    $$("[data-assess]").forEach(b => b.onclick = () => act(() => api.patch(`/api/claims/${b.dataset.assess}`, { assessment: b.dataset.v, rationale: $(`[data-rat="${b.dataset.assess}"]`).value })));
    $$("[data-rat]").forEach(t => t.onchange = () => act(() => api.patch(`/api/claims/${t.dataset.rat}`, { rationale: t.value })));
    $$("[data-ctext]").forEach(t => t.onchange = () => act(() => api.patch(`/api/claims/${t.dataset.ctext}`, { text: t.value }), "Claim updated."));
    $$("[data-ckind]").forEach(s => s.onchange = () => act(() => api.patch(`/api/claims/${s.dataset.ckind}`, { kind: s.value })));
    $$("[data-split]").forEach(b => b.onclick = async () => {
      const cl = A.claims.find(x => x.id === b.dataset.split);
      const r = await modal("Split claim", `<p class="small muted">Put each separate statement on its own line. Leave as is to split automatically at sentences and conjunctions.</p><textarea id="sp" rows="5">${esc(cl.text)}</textarea>`, [{ label: "Cancel", value: null }, { label: "Split", kind: "primary", value: el => $("#sp", el).value }]);
      if (r.value != null) { const parts = r.value.split(/\n+/).map(s => s.trim()).filter(Boolean); act(() => api.post(`/api/claims/${cl.id}/split`, { parts: parts.length > 1 ? parts : undefined }), "Claim split."); }
    });
    $$("[data-rm]").forEach(b => b.onclick = async () => { if (await confirmBox("Remove this claim?", "It stays in the record as removed, with its evidence links preserved. This does not free a claim slot.", "Remove", "danger")) act(() => api.del(`/api/claims/${b.dataset.rm}`), "Claim removed."); });
    $$("[data-link]").forEach(b => b.onclick = () => linkEvidence(b.dataset.link));
    $$("[data-find]").forEach(b => b.onclick = () => runSearch(c, [b.dataset.find]));
    $$("[data-apply]").forEach(b => b.onclick = async () => { if (await confirmBox("Adopt this suggested verdict?", "You are taking responsibility for it. Check the cited fact-checks first; the suggestion is based only on published ratings that matched this claim's wording.", "Adopt")) act(() => api.post(`/api/claims/${b.dataset.apply}/apply-suggestion`), "Verdict set. Edit the rationale in your own words."); });
    if ($("#srchAll")) $("#srchAll").onclick = () => runSearch(c);
    if ($("#ncAdd")) $("#ncAdd").onclick = () => { const t = $("#nc").value.trim(); if (!t) return toast("Write the claim first.", "err"); act(() => api.post(`/api/cases/${c.id}/claims`, { text: t, kind: $("#nck").value }), "Claim added."); };
  }
  function strengthChip(cl) {
    const st = cl.strength; if (!st) return "";
    return `<span class="chip ${STRENGTH[st.level]?.[1] || "grey"}" title="${esc((st.reasons || []).join("; "))}. This measures how much accepted, independent evidence there is. It is not a probability that the claim is true.">${esc(STRENGTH[st.level]?.[0] || st.level)}${st.independent ? ` · ${st.independent} source${st.independent > 1 ? "s" : ""}` : ""}</span>`;
  }
  function suggestBlock(cl, ed) {
    if (!cl.suggested_assessment && !cl.suggested_basis) return "";
    return `<div class="callout info" style="margin:6px 0"><div class="small">${cl.suggested_assessment ? `<b>AIVS suggestion (not a decision): ${esc(ASSESS[cl.suggested_assessment]?.[0] || cl.suggested_assessment)}.</b> ` : "<b>No suggestion.</b> "}${esc(cl.suggested_basis || "")}
      ${ed && cl.suggested_assessment && cl.assessment !== cl.suggested_assessment ? `<div style="margin-top:6px"><button class="btn sm" data-apply="${cl.id}">Adopt after review</button></div>` : ""}</div></div>`;
  }
  function searchCard(c, P, active) {
    const svc = App.meta.search || [], ext = svc.filter(s => s.sends_to), last = (A.retrievals || []).slice(0, 8);
    return `<div class="card case-search" style="margin-top:14px"><div class="hd"><h3>Evidence search</h3><span class="small sub right">Results arrive as suggestions on the Evidence tab, with their links. Nothing is accepted automatically.</span></div><div class="bd">
      <div class="row small" style="gap:6px">${svc.map(s => `<span class="chip ${s.configured ? "teal" : "grey"}" title="${esc(s.configured ? (s.sends_to ? `Sends the claim wording to ${s.sends_to}` : "Runs inside AIVS") : `Not configured: ${s.needs || ""}`)}">${esc(s.label)}${s.configured ? "" : " · not configured"}</span>`).join("")}</div>
      ${ext.some(s => !s.configured) ? `<div class="hint">Services marked “not configured” need an API key set by the administrator on the server (see README, “Evidence search”). AIVS does not invent results when a service is unavailable.</div>` : ""}
      ${P.edit && active.length ? `<div class="row" style="margin-top:10px"><label class="small"><input type="checkbox" id="srchExt" ${ext.some(s => s.configured) ? "checked" : "disabled"}> Include external services${ext.some(s => s.configured) ? ` (${esc(ext.filter(s => s.configured).map(s => s.label).join(", "))})` : " (none configured)"}</label><button class="btn primary sm" id="srchAll" style="margin-left:auto">Search for evidence for all claims</button></div>` : ""}
      ${last.length ? `<details open style="margin-top:10px"><summary class="small"><b>Recent searches</b> (${(A.retrievals || []).length}): what each service returned</summary><table class="tbl small" style="margin-top:6px"><tr><th>When</th><th>Service</th><th>Query</th><th>Result</th></tr>${last.map(r => `<tr><td>${ago(r.at)}</td><td>${esc(svc.find(s => s.key === r.connector)?.label || r.connector)}</td><td>${esc(r.query || "")}</td><td>${r.status === "ok" ? `${r.results} found` : `<span style="color:var(--con)">${esc(r.status)}${r.error ? `: ${esc(r.error)}` : ""}</span>`}</td></tr>`).join("")}</table></details>` : ""}
    </div></div>`;
  }
  async function runSearch(c, claimIds) {
    const extOn = $("#srchExt")?.checked, svc = App.meta.search || [];
    const use = ["kb", "holdings", ...(extOn !== false ? svc.filter(s => s.sends_to && s.configured).map(s => s.key) : [])];
    try {
      const task = await api.queueTask(c.id, "collection", { ...(claimIds ? { claim_ids: claimIds } : {}), use });
      toast(`Evidence collection ${task.status_label.toLowerCase()}. You can continue on another page; view Background tasks for results.`);
      await reload();
    } catch (e) { fail(e); }
  }

  async function linkEvidence(claimId) {
    const acc = A.evidence.filter(e => e.status === "accepted");
    if (!acc.length) return toast("Accept or add evidence first (Evidence tab).", "err");
    const cur = e => e.links.find(l => l.claim_id === claimId)?.stance || "";
    const r = await modal("Link evidence to this claim", `<p class="small muted">Choose how each accepted item bears on the claim.</p>${acc.map(e => `<div class="ev k-${e.kind}" style="display:grid;grid-template-columns:minmax(0,1fr) 150px;gap:10px;align-items:center"><div class="small"><b class="mono">${esc(e.id)}</b> <span class="chip grey">${KIND[e.kind][0]}</span> ${esc(e.text)}</div><select data-st="${esc(e.id)}" aria-label="Stance of ${esc(e.id)}"><option value="">Not related</option>${["supports", "contradicts", "context"].map(s => `<option value="${s}" ${cur(e) === s ? "selected" : ""}>${s === "context" ? "Context only" : s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></div>`).join("")}`,
      [{ label: "Cancel", value: null }, { label: "Save links", kind: "primary", value: el => $$("[data-st]", el).map(s => ({ id: s.dataset.st, stance: s.value })) }], { wide: true });
    if (!r.value) return;
    act(async () => { for (const { id: eid, stance } of r.value) { const e = acc.find(x => x.id === eid); if ((cur(e) || "") === stance) continue; const links = e.links.filter(l => l.claim_id !== claimId).concat(stance ? [{ claim_id: claimId, stance }] : []); await api.patch(`/api/evidence/${eid}`, { links }); } }, "Links saved.");
  }

  // ---------------------------------------------------------------- evidence
  function urlOf(e) { return e.source_url || (String(e.reference || "").match(/https?:\/\/[^\s<>"]+/) || [])[0] || null; }
  function citeBlock(e) {
    const u = urlOf(e); if (!u) return "";
    const conn = (App.meta.search || []).find(s => s.key === e.connector)?.label;
    return `<div class="cite small"><a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(e.source_title || u)}</a>
      <div class="sub">${[e.source_publisher, e.source_published_at ? `published ${esc(String(e.source_published_at).slice(0, 10))}` : "", e.rating ? `rated <b>“${esc(e.rating)}”</b> by the publisher` : "", conn ? `found by ${esc(conn)}` : "", e.retrieved_at ? `retrieved ${ago(e.retrieved_at)}` : ""].filter(Boolean).map(x => x === e.source_publisher ? esc(x) : x).join(" · ")}${e.snapshot_sha256 ? ` · <a href="/api/evidence/${esc(e.id)}/snapshot">archived copy</a>` : ""}</div></div>`;
  }
  async function checkSource(eid) {
    toast("Retrieving the source…");
    try {
      const r = await api.post(`/api/evidence/${eid}/check-source`, {});
      const q = r.quotes || [];
      await modal("Source checked", `<dl class="kv small"><dt>Page</dt><dd>${esc(r.title || r.final_url)}</dd><dt>Address</dt><dd style="overflow-wrap:anywhere">${esc(r.final_url)}</dd><dt>Published (per page)</dt><dd>${r.published ? `${fmtDT(r.published)} <span class="sub">${esc(r.published_basis || "")}</span>` : "No machine-readable date"}</dd><dt>Archived</dt><dd class="mono tiny">SHA-256 ${esc(r.sha256)}</dd></dl>
        <h4>Quotations in the content</h4>${q.length ? `<ul class="small">${q.map(x => `<li>“${esc(x.quote)}” — ${x.found ? `<b style="color:var(--sup)">found word for word</b> in the source` : x.partial > 0.5 ? `<b style="color:var(--warn)">not found exactly</b>; ${Math.round(x.partial * 100)}% of its words appear. The quote may be altered or paraphrased: compare it by reading the source.` : `<b style="color:var(--con)">not found</b> in this source`}</li>`).join("")}</ul>` : `<p class="small muted">The content contains no quotation in quotation marks.</p>`}
        <p class="tiny sub">A quote missing from one page does not prove it was never said; it may come from another source or recording.</p>`, [{ label: "OK", kind: "primary", value: 1 }]);
      await reload();
    } catch (e) { fail(e); }
  }
  function evidence(body, c, P) {
    const ed = P.edit, active = A.claims.filter(x => !x.removed), sug = A.evidence.filter(e => e.status === "suggested"), acc = A.evidence.filter(e => e.status === "accepted"), dis = A.evidence.filter(e => e.status === "dismissed");
    const origin = e => e.origin === "system" ? "System lead" : e.origin === "ai" ? "AI suggestion" : e.origin === "retrieval" ? "Search result" : "Analyst";
    const linkEditor = e => active.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px;margin-top:8px">${active.map(cl => { const s = (e.status === "suggested" ? e.suggested_links : e.links).find(l => l.claim_id === cl.id)?.stance || ""; return `<label class="small" style="display:grid;grid-template-columns:auto 1fr;gap:6px;align-items:center"><span class="chip grey">Claim ${cl.seq}</span><select data-ln="${esc(e.id)}" data-cl="${cl.id}" style="padding:3px 6px;font-size:12.5px" ${ed ? "" : "disabled"} title="${esc(cl.text)}"><option value="">Not related</option>${["supports", "contradicts", "context"].map(x => `<option value="${x}" ${s === x ? "selected" : ""}>${x === "context" ? "Context" : x[0].toUpperCase() + x.slice(1)}</option>`).join("")}</select></label>`; }).join("")}</div>` : "";
    const item = e => `<div class="ev k-${e.kind} ${e.status === "suggested" ? "sugg" : ""}"><div class="row"><span class="mono small"><b>${esc(e.id)}</b></span><span class="chip grey">${KIND[e.kind][0]}</span><span class="chip ${e.origin === "ai" ? "info" : e.origin === "system" ? "teal" : "grey"}">${origin(e)}</span>${e.media_id ? `<a class="small" href="#/case/${esc(c.id)}/media">${esc(e.media_id)}</a>` : ""}${e.uncertainty ? `<span class="chip warn">${esc(e.uncertainty)}</span>` : ""}</div>
      <div style="margin-top:6px">${esc(e.text)}</div>${citeBlock(e)}<div class="meta"><span>Reference: ${esc(e.reference)}</span>${e.source_date ? `<span>· Source dated <b>${esc(e.source_date)}</b></span>` : `<span class="sub">· Source date not recorded</span>`}${e.loc_page ? `<span>· page ${e.loc_page}</span>` : ""}${e.loc_start_s != null ? `<span>· at ${fmtClock(e.loc_start_s)}${e.loc_end_s != null ? `–${fmtClock(e.loc_end_s)}` : ""}</span>` : ""}${e.decided_by ? `<span>· ${e.status} by ${esc(A.users[e.decided_by] || "")} ${ago(e.decided_at)}</span>` : ""}</div>
      ${e.versions?.length ? `<details class="small" style="margin-top:6px"><summary class="sub">Corrected ${e.versions.length} time${e.versions.length > 1 ? "s" : ""} — earlier wording kept</summary>${e.versions.slice().reverse().map(v => `<div class="ev-old"><div class="tiny sub">Replaced ${fmtDT(v.replaced_at)} by ${esc(A.users[v.replaced_by] || "—")}</div><div>${esc(v.text)}</div><div class="tiny sub">Reference: ${esc(v.reference)}${v.source_date ? ` · source dated ${esc(v.source_date)}` : ""}</div></div>`).join("")}</details>` : ""}
      ${e.status !== "dismissed" ? linkEditor(e) : ""}
      ${ed ? `<div class="row" style="margin-top:8px">${e.status === "suggested" ? `<button class="btn sm primary" data-acc="${esc(e.id)}">Accept</button><button class="btn sm" data-dis="${esc(e.id)}">Dismiss</button>` : e.status === "accepted" ? `<button class="btn sm" data-savel="${esc(e.id)}">Save links</button><button class="btn sm" data-fix="${esc(e.id)}">${e.origin === "analyst" ? "Correct" : "Set source date"}</button>${urlOf(e) ? `<button class="btn sm ghost" data-chk="${esc(e.id)}" title="Retrieve and archive the linked page, and check quotations in the content against it">Check source</button>` : ""}<button class="btn sm ghost" data-wd="${esc(e.id)}">Withdraw</button>` : `<button class="btn sm ghost" data-rs="${esc(e.id)}">Restore as suggestion</button>`}</div>` : ""}</div>`;
    body.innerHTML = `<div class="kindlegend">${Object.entries(KIND).map(([k, [l, d]]) => `<div class="k-${k}"><b>${l}</b>${d}</div>`).join("")}</div>
      ${sug.length ? `<div class="card"><div class="hd"><h3>Suggestions to review</h3><span class="chip warn">${sug.length}</span><span class="small sub right">Nothing counts until you accept it. Set how each item bears on the claims first.</span></div><div class="bd">${sug.map(item).join("")}</div></div>` : ""}
      <div class="card"><div class="hd"><h3>Accepted evidence</h3><span class="chip teal">${acc.length}</span></div><div class="bd">
        ${acc.length ? Object.keys(KIND).map(k => { const it = acc.filter(e => e.kind === k); return it.length ? `<h4 style="margin:10px 0 6px">${KIND[k][0]}s</h4>${it.map(item).join("")}` : ""; }).join("") : `<p class="muted small">No evidence accepted yet.${A.case.status === "draft" ? " Run local analysis for automatic leads, or add your own findings below." : ""}</p>`}</div></div>
      ${ed ? `<div class="card"><div class="hd"><h3>Add evidence</h3></div><div class="bd">
        <div class="grid g3"><div><label class="f" for="nk">Type <span class="req">*</span></label><select id="nk">${Object.entries(KIND).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select><div class="hint" id="nkh">${KIND.observation[1]}</div></div>
          <div><label class="f" for="nm">Relates to media</label><select id="nm"><option value="">None</option>${A.media.map(m => `<option value="${esc(m.id)}">${esc(m.id)} · ${esc(m.original_name)}</option>`).join("")}</select></div>
          <div><label class="f" for="nu">Uncertainty</label><input type="text" id="nu" placeholder="Optional, e.g. single source"></div></div>
        <div id="nlocBox" class="grid g3" hidden><div data-lk="document"><label class="f" for="nlp">Page in the document</label><input type="number" id="nlp" min="1" step="1" inputmode="numeric"><div class="hint">So a reviewer can open the exact page.</div></div>
          <div data-lk="time"><label class="f" for="nls">From (m:ss)</label><input type="text" id="nls" placeholder="1:05" inputmode="decimal"></div><div data-lk="time"><label class="f" for="nle">To (m:ss)</label><input type="text" id="nle" placeholder="1:20" inputmode="decimal"><div class="hint">So a reviewer can play the exact passage.</div></div></div>
        <label class="f" for="nt">Finding <span class="req">*</span></label><textarea id="nt" rows="3" placeholder="State it factually. Keep inference separate from what was observed."></textarea>
        <div class="grid" style="grid-template-columns:minmax(0,1fr) 200px;gap:12px"><div><label class="f" for="nr">Reference <span class="req">*</span></label><input type="text" id="nr" placeholder="Document, URL, message ID, person and date, or media ID"></div>
          <div><label class="f" for="nsd">Source date</label><input type="text" id="nsd" placeholder="2018-10-14" inputmode="numeric"><div class="hint">Date the source itself carries: year, year-month or full date.</div></div></div>
        ${active.length ? `<label class="f">How it bears on the claims</label>${linkEditor({ id: "new", status: "accepted", links: [] })}` : ""}
        <div id="evErr" class="callout bad" style="margin-top:10px" hidden></div><div style="margin-top:12px"><button class="btn primary" id="addEv">Add evidence</button></div></div></div>` : ""}
      ${dis.length ? `<details style="margin-top:14px"><summary class="small sub">Dismissed suggestions (${dis.length})</summary><div style="margin-top:8px">${dis.map(item).join("")}</div></details>` : ""}`;
    if (!ed) return;
    const linksOf = id => $$(`[data-ln="${CSS.escape(id)}"]`).filter(s => s.value).map(s => ({ claim_id: s.dataset.cl, stance: s.value }));
    $("#nk").onchange = e => ($("#nkh").textContent = KIND[e.target.value][1]);
    const locKind = () => { const m = A.media.find(x => x.id === $("#nm").value); return m?.kind === "document" ? "document" : ["audio", "video"].includes(m?.kind) ? "time" : null; };
    $("#nm").onchange = () => { const k = locKind(); $("#nlocBox").hidden = !k; $$("#nlocBox [data-lk]").forEach(d => (d.hidden = d.dataset.lk !== k)); };
    const clock = v => { const x = String(v || "").trim(); if (!x) return null; const p = x.split(":").map(Number); if (p.some(n => !Number.isFinite(n) || n < 0)) throw new Error("Write times as minutes:seconds, for example 1:05."); return p.reduce((a, b) => a * 60 + b, 0); };
    $$("[data-acc]").forEach(b => b.onclick = () => act(() => api.patch(`/api/evidence/${b.dataset.acc}`, { status: "accepted", links: linksOf(b.dataset.acc) }), `${b.dataset.acc} accepted.`));
    $$("[data-dis]").forEach(b => b.onclick = () => act(() => api.patch(`/api/evidence/${b.dataset.dis}`, { status: "dismissed" }), `${b.dataset.dis} dismissed.`));
    $$("[data-savel]").forEach(b => b.onclick = () => act(() => api.patch(`/api/evidence/${b.dataset.savel}`, { links: linksOf(b.dataset.savel) }), "Links saved."));
    $$("[data-chk]").forEach(b => b.onclick = () => checkSource(b.dataset.chk));
    $$("[data-wd]").forEach(b => b.onclick = () => act(() => api.patch(`/api/evidence/${b.dataset.wd}`, { status: "suggested" }), "Moved back to suggestions."));
    $$("[data-rs]").forEach(b => b.onclick = () => act(() => api.patch(`/api/evidence/${b.dataset.rs}`, { status: "suggested" }), "Restored."));
    $$("[data-fix]").forEach(b => b.onclick = () => correctEvidence(A.evidence.find(e => e.id === b.dataset.fix)));
    $("#addEv").onclick = async () => {
      const err = $("#evErr"), miss = [!$("#nt").value.trim() && "the finding", !$("#nr").value.trim() && "a reference"].filter(Boolean);
      if (miss.length) { err.hidden = false; err.textContent = `Add ${miss.join(" and ")} before saving. Every piece of evidence needs a reference someone else can check.`; ($("#nt").value.trim() ? $("#nr") : $("#nt")).focus(); return; }
      err.hidden = true; const btn = $("#addEv"); btn.disabled = true;
      try { const k = locKind(), loc = k === "document" ? { loc_page: $("#nlp").value === "" ? null : Number($("#nlp").value) } : k === "time" ? { loc_start_s: clock($("#nls").value), loc_end_s: clock($("#nle").value) } : {};
        await api.post(`/api/cases/${c.id}/evidence`, { kind: $("#nk").value, text: $("#nt").value, reference: $("#nr").value, source_date: $("#nsd").value.trim() || null, media_id: $("#nm").value || null, uncertainty: $("#nu").value || null, links: linksOf("new"), ...loc }); toast("Evidence added."); await reload(); }
      catch (e) { err.hidden = false; err.textContent = errMsg(e); btn.disabled = false; }
    };
  }
  async function correctEvidence(e) {
    const own = e.origin === "analyst";
    const body = `${own ? `<p class="small muted" style="margin-top:0">The current wording is kept in the evidence history and in the case audit log.</p>
      <label class="f" for="ceT">Finding</label><textarea id="ceT" rows="4">${esc(e.text)}</textarea>
      <label class="f" for="ceR">Reference</label><input type="text" id="ceR" value="${esc(e.reference)}">` : `<p class="small muted" style="margin-top:0">${e.origin === "ai" ? "AI" : "Automated"} suggestions keep their original wording. You can record the date the underlying source carries.</p>`}
      <label class="f" for="ceD">Source date</label><input type="text" id="ceD" value="${esc(e.source_date || "")}" placeholder="2018-10-14"><div class="hint">Year, year-month or full date. Leave empty if unknown.</div>`;
    const r = await modal(own ? `Correct ${e.id}` : `Source date for ${e.id}`, body, [{ label: "Cancel", value: null }, { label: "Save", kind: "primary",
      validate: async el => { try { await api.patch(`/api/evidence/${e.id}`, { ...(own ? { text: $("#ceT", el).value, reference: $("#ceR", el).value } : {}), source_date: $("#ceD", el).value.trim() || null }); } catch (er) { return errMsg(er); } }, value: true }]);
    if (r.value) { toast(`${e.id} updated.`); await reload(); }
  }

  // ---------------------------------------------------------------- AI
  // ---------------------------------------------------------------- research assistant
  async function assistant(body, c, P) {
    const D = await api.get(`/api/cases/${c.id}/assistant`), st = D.ai, canAsk = App.can("note.write"), H = st.health || { state: "unknown" };
    const healthy = H.state === "ok" || H.state === "unchecked", aiOk = st.configured && st.enabled && healthy && App.can("ai.request") && (!st.trainingOnly || D.is_training);
    const chip = !st.configured ? `<span class="chip grey">AI not configured</span>` : !st.enabled ? `<span class="chip grey">AI switched off</span>` : H.state === "ok" ? `<span class="chip sup" title="Checked ${esc(H.checked_at || "")}: the server answered and the model generated text in ${H.latency_ms} ms">AI available</span>` : H.state === "failed" ? `<span class="chip con" title="${esc(H.error || "")}">AI unavailable</span>` : H.state === "unchecked" ? `<span class="chip grey">AI configured (not checked)</span>` : `<span class="chip grey"><span class="spin"></span> Checking AI…</span>`;
    const known = new Set([c.id, ...A.claims.map(x => x.id), ...A.evidence.map(e => e.id), ...A.media.map(m => m.id), ...(A.transcripts || []).map(t => t.id)]);
    const where = id => id.startsWith("CL-") ? "claims" : id.startsWith("E-") ? "evidence" : id.startsWith("M-") || id.startsWith("T-") ? "media" : "overview";
    const md = (t, inv = []) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^- (.*)$/gm, "<li>$1</li>").replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
      .replace(/\[([A-Z]{1,3}-[\w-]+(?:[#@][\w]+)?)\]/g, (_, id) => { const base = id.split(/[#@]/)[0], bad = inv.includes(id) || !known.has(base); return bad ? `<span class="chip con" title="Not a record in this case: do not rely on this point">${esc(id)} ✗</span>` : `<a class="chip info" href="#/case/${esc(c.id)}/${where(base)}" title="Open the cited record">${esc(id)}</a>`; })
      .replace(/\n/g, "<br>").replace(/<br><ul>/g, "<ul>").replace(/<\/ul><br>/g, "</ul>");
    const QUICK = [["What is missing?", "missing"], ["What should I check next?", "next"], ["Summarise the case", "summary"], ["Timeline", "timeline"], ["Sources with links", "sources"], ["Kinakosekana nini?", "sw"]];
    const aiNote = m => { const S = m.sources || {}, bits = [];
      if (S.removed) bits.push(`<b style="color:var(--con)">AIVS removed ${S.removed} statement(s) that cited no record of this case or claimed a search that did not happen (listed at the end).</b>`);
      if (S.links_removed) bits.push(`${S.links_removed} link(s) not found in the case records were removed.`);
      if (S.records_left_out) bits.push(`${S.records_left_out} lower-ranked record(s) did not fit in the model's context and were not sent.`);
      if (S.context_full) bits.push(`<b>The material filled the model's context; some of it may have been cut.</b> Ask a narrower question, or raise AI_NUM_CTX.`);
      if (S.seconds) bits.push(`Answered in ${S.seconds} s.`);
      bits.push(S.searches_in_log ? `The model was told about ${S.searches_in_log} evidence search(es) AIVS ran for this case; it cannot search the web itself.` : "No evidence search has been run for this case, and the model cannot search the web.");
      return bits.join(" "); };
    const msg = m => m.role === "user" ? `<div class="am user"><div class="who">${esc(A.users[m.user_id] || "Analyst")} · ${ago(m.at)}${m.provider && m.provider !== "rules" ? ` · <span class="chip info">sent to AI</span>` : ""}</div><div>${esc(m.content)}</div></div>`
      : m.status === "error" ? `<div class="am bot err"><div class="who">${esc(m.provider)} · ${ago(m.at)}</div><div>The AI service did not answer: ${esc(m.error || "")}</div></div>`
      : `<div class="am bot"><div class="who">${m.provider === "rules" ? "AIVS rules (no AI)" : `AI · ${esc(m.provider)} / ${esc(m.model || "")}`} · ${ago(m.at)}</div>
          ${m.provider !== "rules" ? `<div class="tiny" style="margin-bottom:6px;color:var(--warn)">AI output: check every point against the cited records before using it.${m.sources?.invalid?.length && !m.sources?.structured ? ` <b style="color:var(--con)">${m.sources.invalid.length} citation(s) do not match any record sent and are marked ✗.</b>` : ""}${m.sources?.uncited ? ` <b style="color:var(--con)">This answer cites no records.</b>` : ""}${m.sources?.injection_flags?.length ? ` The case material contains text addressed to AI systems; the assistant was told to ignore it.` : ""} ${aiNote(m)}</div>` : m.sources?.fallback_from_ai ? `<div class="callout warn" style="margin:0 0 6px"><div><b>The AI did not answer, so this is the rule-based answer.</b> ${esc(m.sources.fallback_from_ai)}</div></div>` : ""}
          <div class="amtext">${md(m.content, m.sources?.invalid || [])}</div></div>`;
    body.innerHTML = `<div class="split"><div class="stack"><div class="card"><div class="hd"><h3>Research assistant</h3><span class="right" id="aiChip">${chip}</span></div><div class="bd">
        <p class="small sub" style="margin-top:0">Answers come only from this case's records, with the record IDs they rely on.</p>
        <div class="chat" id="chat">${D.messages.length ? D.messages.map(msg).join("") : `<p class="muted small" style="margin:0">Ask about this case, or use a quick question below. In English or Kiswahili.</p>`}</div>
        ${canAsk ? `<div class="row" style="margin-top:10px;flex-wrap:wrap">${QUICK.map(([l]) => `<button class="btn sm ghost" data-q="${esc(l)}">${esc(l)}</button>`).join("")}</div>
        <div class="row" style="margin-top:8px"><textarea id="aq" rows="2" style="flex:1;min-width:240px" placeholder="e.g. Which claims rest on a single source?  /  Ushahidi gani unaunga mkono dai la 2?"></textarea></div>
        <div class="row" style="margin-top:8px"><div class="seg" role="group" aria-label="Answer with"><button data-mode="rules" class="on">Rules (no AI)</button><button data-mode="ai" ${aiOk ? "" : "disabled"} title="${esc(aiOk ? `Sends the relevant case records to ${st.providerLabel}` : !st.configured ? st.reason : st.trainingOnly && !D.is_training ? "AI is limited to training cases on this server" : st.reason || "Not available to your role")}">AI${st.configured ? ` (${esc(st.provider)})` : ""}</button></div>
          <button class="btn primary" id="askGo" style="margin-left:auto">Ask</button><span id="askWait" class="small muted" aria-live="polite"></span>${P.edit && D.messages.length ? `<button class="btn ghost" id="askClear">Clear conversation</button>` : ""}</div>
        <div id="askErr" class="callout bad" style="margin-top:8px" hidden></div>` : `<div class="callout info" style="margin-top:10px"><div>Your role can read the conversation but not ask questions.</div></div>`}</div></div></div>
      <div class="stack"><div class="card"><div class="hd"><h3>How it works</h3></div><div class="bd small">
        <p style="margin-top:0"><b>Rules (no AI)</b> answers from the case records directly: what is missing, next checks, timeline, sources, summary, or searching the records. Free, instant, and nothing leaves AIVS.</p>
        <p><b>AI</b> ${st.configured ? `uses <b>${esc(st.providerLabel)}</b> (model ${esc(st.model)}) at ${esc(st.endpoint)}${st.local ? ": a server on your own network, so the records stay inside the organisation. The browser never contacts it; only the AIVS server does" : ""}. The most relevant records of this case are sent with your question. ${st.trainingOnly ? `<span class="chip warn">Training cases only</span> This server sends only training cases to AI.` : ""}` : `is not configured. ${esc(st.reason || "")}`}</p>
        ${st.configured ? `<div class="panel small" id="aiHealth">${H.state === "ok" ? `Connection checked ${ago(H.checked_at)}: the model answered in ${H.latency_ms} ms.` : H.state === "failed" ? `<b style="color:var(--con)">Connection check failed ${ago(H.checked_at)}:</b> ${esc(H.error)}<br>Questions are answered by the rules until it works again.` : H.state === "unchecked" ? esc(H.error || "") : "Checking the connection…"}
          <div style="margin-top:6px"><button class="btn sm" id="aiCheck">Check connection now</button></div></div>` : ""}
        <p>${st.provider === "ollama" ? "Ollama answers in a fixed format: <b>facts</b> (each must cite records), <b>what is missing</b>, <b>suggested steps</b> (suggestions, not findings) and a <b>timeline</b>. AIVS removes any fact or date that cites nothing in this case, links that are not in the records, and claims of web searches that did not happen. " : ""}A local model on a CPU can take a minute or more; the limit is ${st.timeoutS || 90} s. If the AI fails, the rule-based answer is shown instead.</p>
        <p>AI answers must cite record IDs. AIVS checks every citation: a citation to anything that was not sent is marked <span class="chip con">✗</span>. AI answers are suggestions for the analyst, never findings.</p></div></div></div></div>`;
    const el2 = $("#chat"); if (el2) el2.scrollTop = el2.scrollHeight;
    if (!canAsk) return;
    if ($("#aiCheck")) $("#aiCheck").onclick = async () => { const b = $("#aiCheck"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Checking… (a cold model can take a minute)'; try { await api.get("/api/ai/health?force=1"); } catch (e) { fail(e); } assistant(body, c, P); };
    if (st.configured && st.enabled && H.state === "unknown") api.get("/api/ai/health").then(() => assistant(body, c, P)).catch(() => {});
    let mode = aiOk ? "ai" : "rules";
    if (aiOk) $$("[data-mode]").forEach(x => x.classList.toggle("on", x.dataset.mode === "ai"));
    $$("[data-mode]").forEach(b => b.onclick = () => { if (b.disabled) return; mode = b.dataset.mode; $$("[data-mode]").forEach(x => x.classList.toggle("on", x === b)); });
    const ask = async q => {
      q = String(q || "").trim(); if (!q) return; const b = $("#askGo"); b.disabled = true; b.innerHTML = `<span class="spin"></span> ${mode === "ai" ? "Asking the AI…" : "Working…"}`; $("#askErr").hidden = true;
      const t0 = Date.now(), tick = mode === "ai" ? setInterval(() => { const sec = Math.round((Date.now() - t0) / 1000); $("#askWait").textContent = `${sec} s of up to ${st.timeoutS || 90} s${sec > 20 ? " · a local model can be slow, especially on the first question" : ""}`; }, 1000) : null;
      try { const r = await api.post(`/api/cases/${c.id}/assistant`, { question: q, mode }); if (r.fallback) toast("The AI did not answer; the rule-based answer is shown.", "err"); assistant(body, c, P); }
      catch (e) { $("#askErr").hidden = false; $("#askErr").textContent = errMsg(e); b.disabled = false; b.textContent = "Ask"; }
      finally { if (tick) clearInterval(tick); }
    };
    $("#askGo").onclick = () => ask($("#aq").value); $("#aq").onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ask($("#aq").value); };
    $$("[data-q]").forEach(b => b.onclick = () => ask(b.dataset.q));
    if ($("#askClear")) $("#askClear").onclick = async () => { if (await confirmBox("Clear the conversation?", "All questions and answers on this case are deleted. The clearing is recorded in the audit log.", "Clear", "danger")) { try { await api.del(`/api/cases/${c.id}/assistant`); assistant(body, c, P); } catch (e) { fail(e); } } };
  }
  function ai(body, c, P) {
    const st = App.meta.ai, imgs = A.media.filter(m => m.kind === "image");
    const runs = A.aiRuns;
    body.innerHTML = `<div class="split"><div class="stack">
      <div class="card"><div class="hd"><h3>AI assistance</h3>${st.configured && st.enabled ? `<span class="chip teal right">Available</span>` : `<span class="chip grey right">AI not configured</span>`}</div><div class="bd">
        <div class="callout info"><div><b>Local and cloud processing are separate.</b> Archive matching, metadata, OCR and claim extraction run on this server or in your browser. AI assistance sends the case content you select to an external service, only when you confirm it.</div></div>
        ${!st.configured || !st.enabled ? `<p style="margin-top:12px"><b>${esc(st.reason || "AI not configured.")}</b></p><p class="small muted">All local verification features keep working without it.</p>` : `
        <dl class="kv" style="margin-top:12px"><dt>Service</dt><dd>${esc(st.providerLabel)} at <b>${esc(st.endpoint)}</b></dd><dt>Model</dt><dd class="mono">${esc(st.model)}</dd><dt>Prompt version</dt><dd class="mono">${esc(st.promptVersion)}</dd></dl>
        <p class="small muted">The AI can extract claims and entities, transcribe and describe visible content with stated uncertainty, suggest gaps and next checks, and draft a summary from the evidence already in the case. Its output is checked against a fixed schema; replies that cite evidence that does not exist are rejected. Nothing is applied until you accept it.</p>`}</div></div>
      ${st.configured && st.enabled && P.ai ? `<div class="card"><div class="hd"><h3>Choose what to send</h3></div><div class="bd">
        ${imgs.length ? `<div class="label">Images (up to ${st.maxImages})</div><div class="frames">${imgs.map((m, i) => `<label><figure><img src="${thumb(m.id)}" alt=""><figcaption><input type="checkbox" data-aim="${esc(m.id)}" ${i < Math.min(2, st.maxImages) && !m.parent_media_id ? "checked" : ""}> ${esc(m.id)}</figcaption></figure></label>`).join("")}</div>` : `<p class="small muted">No images in this case. The text and evidence can still be sent.</p>`}
        <label class="check" style="margin-top:10px"><input type="checkbox" id="aiOcr" checked> Include checked OCR text for the selected images</label>
        <label class="check"><input type="checkbox" id="aiEv" checked> Include evidence items (so the AI can cite them by ID)</label>
        <div class="row" style="margin-top:12px"><button class="btn" id="aiPrev">Preview what will be sent</button></div>
        <div id="aiPv"></div></div></div>` : ""}
    </div><div class="stack">
      <div class="card"><div class="hd"><h3>AI runs</h3><span class="chip grey right">${runs.length}</span></div><div class="bd">${runs.length ? runs.map(runCard).join("") : `<p class="small muted">No AI requests for this case.</p>`}</div></div>
    </div></div>`;
    if ($("#aiPrev")) $("#aiPrev").onclick = async () => {
      const opts = { media_ids: $$("[data-aim]:checked").map(x => x.dataset.aim), include_ocr: $("#aiOcr").checked, include_evidence: $("#aiEv").checked };
      try {
        const p = await api.post(`/api/cases/${c.id}/ai/preview`, opts), s = p.sent;
        $("#aiPv").innerHTML = `<div class="panel" style="margin-top:12px"><b>This request would send to ${esc(s.destination)}:</b><ul class="small" style="margin:6px 0 0;padding-left:18px">
          <li>The working claim text, source and dates (${s.text_chars.toLocaleString()} characters in total)</li><li>${s.claim_ids.length} claim(s) and ${s.evidence_ids.length} evidence item(s) with their IDs</li>
          <li>${s.images.length} image(s), resized to at most 1568 px (${kb(s.images.reduce((a, b) => a + b.bytes, 0))})</li><li>Visible text from ${s.ocr_media_ids.length} OCR record(s)</li></ul>
          ${p.injection_flags.length ? `<div class="callout warn" style="margin-top:8px"><div>The content contains text that addresses AI systems (${p.injection_flags.map(x => `“${esc(x)}”`).join(", ")}). It is sent as data to examine; the AI is instructed never to follow it.</div></div>` : ""}
          <details style="margin-top:8px"><summary class="small">Show the exact text</summary><pre class="box">${esc(p.text)}</pre></details>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="aiOk"> I confirm this case content may be sent to ${esc(s.destination)} (${esc(s.provider)} / ${esc(s.model)}). The request and its fingerprint are recorded in the audit log.</label>
          <button class="btn primary" id="aiSend" style="margin-top:10px" disabled>Send to AI service</button></div>`;
        $("#aiOk").onchange = e => ($("#aiSend").disabled = !e.target.checked);
        $("#aiSend").onclick = () => act(() => api.queueTask(c.id, "verification", { ...opts, confirm_external: true }), "Sent. The result appears under AI runs when it arrives.");
      } catch (e) { fail(e); }
    };
    bindRuns(c, P);
  }
  function runCard(r) {
    const o = r.response, can = A.perms.ai && r.status === "completed";
    const chip = { running: `<span class="chip info"><span class="spin"></span> Running</span>`, completed: `<span class="chip sup">Validated</span>`, rejected: `<span class="chip con">Rejected</span>`, failed: `<span class="chip con">Failed</span>` }[r.status];
    return `<div class="panel" style="margin-bottom:10px"><div class="row"><b class="mono small">${esc(r.id)}</b>${chip}<span class="tiny sub" style="margin-left:auto">${fmtDT(r.started_at)}${r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)} s` : ""}</span></div>
      <div class="tiny sub" style="margin-top:4px">${esc(r.provider)} · <span class="mono">${esc(r.model)}</span> · prompt ${esc(r.prompt_version)} · requested by ${esc(A.users[r.requested_by] || "")} · sent ${r.sent.images.length} image(s), ${r.sent.evidence_ids.length} evidence item(s) to ${esc(r.sent.destination)}</div>
      ${r.injection_flags.length ? `<div class="tiny" style="color:var(--warn);margin-top:4px">Instruction-like text was present in the content and was sent as data only.</div>` : ""}
      ${r.status === "failed" ? `<div class="callout bad" style="margin-top:8px"><div>${esc(r.error)}</div></div>` : ""}
      ${r.status === "rejected" ? `<div class="callout bad" style="margin-top:8px"><div><b>The reply was rejected and none of it can be used.</b><ul class="problems small">${r.validation_errors.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div></div>` : ""}
      ${r.status === "completed" && o ? `
        ${o.claims.length ? `<h4 style="margin-top:10px">Claims</h4>${o.claims.map((x, i) => `<div class="ev"><div class="small">${esc(x.text)} <span class="chip grey">${esc(x.kind)}</span>${x.existing_claim_id ? ` <span class="tiny sub">matches ${esc(x.existing_claim_id)}</span>` : ""}</div>${x.entities?.length ? `<div class="tiny sub">${x.entities.map(e => `${esc(e.type)}: ${esc(e.value)}`).join(" · ")}</div>` : ""}${x.supporting_evidence_ids.length || x.conflicting_evidence_ids.length ? `<div class="tiny">Supports: ${esc(x.supporting_evidence_ids.join(", ") || "—")} · Conflicts: ${esc(x.conflicting_evidence_ids.join(", ") || "—")}</div>` : ""}${can && !x.existing_claim_id ? `<button class="btn sm" data-apply="${esc(r.id)}" data-type="claim" data-i="${i}" style="margin-top:6px">Add as claim</button>` : ""}</div>`).join("")}` : ""}
        ${o.observations.length ? `<h4 style="margin-top:10px">Observations</h4>${o.observations.map((x, i) => `<div class="ev"><div class="small"><span class="mono">${esc(x.media_id)}</span> <span class="chip grey">${x.kind === "visible_text" ? "visible text" : "visible content"}</span> <span class="chip warn">uncertainty ${esc(x.uncertainty)}</span></div><div class="small" style="margin-top:4px">${esc(x.description)}</div>${x.basis ? `<div class="tiny sub">Basis: ${esc(x.basis)}</div>` : ""}${can ? `<button class="btn sm" data-apply="${esc(r.id)}" data-type="observation" data-i="${i}" style="margin-top:6px">Accept as evidence</button>` : ""}</div>`).join("")}` : ""}
        ${o.uncertainties.length ? `<h4 style="margin-top:10px">Uncertainties</h4><ul class="small problems">${o.uncertainties.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${o.next_checks.length ? `<h4 style="margin-top:10px">Suggested next checks</h4>${o.next_checks.map((x, i) => `<div class="row small" style="margin-top:4px"><span style="flex:1">${esc(x)}</span>${can ? `<button class="btn sm ghost" data-apply="${esc(r.id)}" data-type="check" data-i="${i}">Add to checklist</button>` : ""}</div>`).join("")}` : ""}
        ${o.summary_draft ? `<h4 style="margin-top:10px">Summary draft</h4><pre class="box">${esc(o.summary_draft)}</pre>${can ? `<button class="btn sm" data-apply="${esc(r.id)}" data-type="summary" style="margin-top:6px">Use as briefing draft</button>` : ""}` : ""}` : ""}</div>`;
  }
  function bindRuns() {
    $$("[data-apply]").forEach(b => b.onclick = () => act(() => api.post(`/api/ai/runs/${b.dataset.apply}/apply`, { type: b.dataset.type, index: +b.dataset.i || 0 }), b.dataset.type === "observation" ? "Accepted as evidence. Link it to claims on the Evidence tab." : "Added."));
  }

  // ---------------------------------------------------------------- conclusion, review and report
  async function report(body, c, P) {
    const ed = P.edit && ["analyst_review", "needs_evidence"].includes(c.status), exp = A.expectedConclusion;
    let ready = null; try { ready = await api.get(`/api/cases/${c.id}/readiness`); } catch {}
    body.innerHTML = `<div class="split"><div class="stack">
      <div class="card"><div class="hd"><h3>Overall conclusion</h3>${c.conclusion ? concl(c.conclusion) : ""}</div><div class="bd">
        ${exp ? `<div class="callout ${exp === "mixed" ? "warn" : "info"}"><div>From the claim assessments, the conclusion should be <b>${esc(CONCL[exp][0])}</b>.${exp === "mixed" ? " The content contains both supported and contradicted claims." : ""}</div></div>` : `<div class="callout info"><div>Assess every claim first (Claims tab). The overall conclusion follows from them.</div></div>`}
        <label class="f" for="cc">Conclusion</label><select id="cc" ${ed ? "" : "disabled"}><option value="">Choose…</option>${Object.entries(CONCL).filter(([k]) => ACTIVE_CONCLUSIONS.includes(k) || k === c.conclusion || k === A.expectedConclusion).map(([k, [l]]) => `<option value="${k}" ${c.conclusion === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <label class="f" for="cr">Reasoning <span class="req">*</span></label><textarea id="cr" rows="4" ${ed ? "" : "disabled"} placeholder="How the evidence leads to this conclusion. Distinguish what was observed from what is inferred.">${esc(c.conclusion_rationale || "")}</textarea>
        <label class="f" for="cu">Remaining uncertainties <span class="req">*</span></label><textarea id="cu" rows="3" ${ed ? "" : "disabled"} placeholder="What is still unknown and what would resolve it. Write “None identified” if there are none.">${esc(c.uncertainties || "")}</textarea>
        <div class="row" style="margin-top:12px"><label class="f" for="cb" style="margin:0">Summary for briefing</label>${ed ? `<button class="btn sm ghost" id="draftB" style="margin-left:auto">Draft from accepted evidence</button>` : ""}<button class="btn sm ghost" id="copyB">Copy</button></div>
        <textarea id="cb" rows="7" ${ed ? "" : "disabled"} style="margin-top:6px;font-family:var(--mono);font-size:12.5px" placeholder="Plain-text summary for briefs and corrections">${esc(c.brief || "")}</textarea>
        ${ed ? `<div class="row" style="margin-top:12px"><button class="btn primary" id="saveC">Save</button></div>` : ""}</div></div>
    </div><div class="stack">
      ${autoNote(c)}
      ${["analyst_review", "needs_evidence"].includes(c.status) && !hodRoute(c) ? `<div class="card"><div class="hd"><h3>Submit for approval</h3></div><div class="bd">
        ${ready?.ok ? `<div class="callout good"><div><b>Ready.</b> Every claim is assessed with a rationale and backed by evidence, all suggestions are reviewed, and the conclusion matches the claims.</div></div>` : `<div class="callout warn"><div><b>Not ready yet:</b><ul class="problems">${(ready?.problems || []).map(p => `<li>${esc(p)}</li>`).join("")}</ul><a class="btn sm" href="#/case/${esc(c.id)}/coverage">See each claim’s evidence coverage</a></div></div>`}
        ${P.edit ? `<button class="btn primary" id="submitA" style="margin-top:12px" ${ready?.ok ? "" : "disabled"}>Submit for approval</button><div class="hint">The case locks while a reviewer decides. A different person must approve it.</div>` : ""}</div></div>` : ""}
      ${c.status === "awaiting_approval" && !hodRoute(c) ? `<div class="card"><div class="hd"><h3>Reviewer decision</h3></div><div class="bd">
        <p class="small">Submitted by <b>${esc(c.submitter?.name || "—")}</b> ${fmtDT(c.submitted_at)}.</p>
        ${P.approve ? `<p class="small muted">Read the draft report, check the claims and evidence, then decide. Approval freezes the report with a fingerprint.</p>
          <label class="f" for="rc">Comment</label><textarea id="rc" rows="3" placeholder="Required for “Needs additional evidence” and “Reject”; optional when approving"></textarea>
          <div class="row" style="margin-top:10px"><button class="btn primary" id="appr">Approve</button><button class="btn" id="ret">Needs additional evidence</button><button class="btn danger" id="rej">Reject</button></div>
          <div class="hint">Needs additional evidence returns the case to the analyst. Reject closes it without a report; it can be reworked as a new revision.</div>`
        : `<div class="callout info"><div>${P.ownWork ? "You analysed or submitted this case, so a different reviewer must decide it." : App.can("case.approve") ? "This case cannot be decided by you." : "Waiting for a reviewer."}</div></div>`}</div></div>` : ""}
      <div class="card"><div class="hd"><h3>Report</h3></div><div class="bd">
        <div class="row"><a class="btn" href="/api/cases/${esc(c.id)}/report.html" target="_blank" rel="noopener">Preview ${["approved", "archived"].includes(c.status) ? "current" : "draft"} report</a><a class="btn ghost" href="/api/cases/${esc(c.id)}/report.pdf?download=1">PDF</a><a class="btn ghost" href="/api/cases/${esc(c.id)}/report.html?download=1">HTML</a><a class="btn ghost" href="/api/cases/${esc(c.id)}/report.json?download=1">JSON</a><a class="btn ghost" href="/api/cases/${esc(c.id)}/report.csv?download=1">CSV</a></div>
        ${["approved", "archived"].includes(c.status) ? "" : `<div class="hint">Drafts are marked DRAFT on every page. Only an approved report is frozen and fingerprinted.</div>`}
        ${A.reports.length ? `<h4 style="margin-top:14px">Approved reports</h4><ul class="mini">${A.reports.map(r => `<li><span class="mono small">${esc(r.id)}</span><span class="tiny sub" style="flex:1">${fmtDT(r.created_at)} · SHA-256 ${esc(r.sha256.slice(0, 12))}…</span><a class="btn sm" href="/api/reports/${esc(r.id)}.html" target="_blank" rel="noopener">View</a><a class="btn sm ghost" href="/api/reports/${esc(r.id)}.pdf?download=1">PDF</a><a class="btn sm ghost" href="/api/reports/${esc(r.id)}.json?download=1">JSON</a><a class="btn sm ghost" href="/api/reports/${esc(r.id)}.csv?download=1">CSV</a></li>`).join("")}</ul>` : `<p class="small muted" style="margin-top:10px">An approved report is frozen here when a reviewer approves the case.</p>`}</div></div>
    </div></div>`;
    $("#copyB").onclick = () => { const t = $("#cb").value; navigator.clipboard?.writeText(t).then(() => toast("Summary copied."), () => { $("#cb").select(); toast("Press Ctrl+C to copy."); }); };
    if (ed) {
      $("#draftB").onclick = () => { $("#cb").value = draftBrief(c, $("#cc").value, $("#cr").value, $("#cu").value); toast("Draft written. Edit it, then save."); };
      $("#saveC").onclick = () => act(() => api.patch(`/api/cases/${c.id}`, { conclusion: $("#cc").value || null, conclusion_rationale: $("#cr").value, uncertainties: $("#cu").value, brief: $("#cb").value }), "Saved.");
    }
    if ($("#submitA")) $("#submitA").onclick = async () => { if (await confirmBox("Submit for approval?", "The case will lock until a reviewer approves it or returns it to you.", "Submit")) act(() => api.post(`/api/cases/${c.id}/submit`), "Submitted for approval."); };
    if ($("#appr")) $("#appr").onclick = async () => { if (await confirmBox("Approve this assessment?", "The report will be frozen with a SHA-256 fingerprint and recorded as approved by you.", "Approve")) act(() => api.post(`/api/cases/${c.id}/decision`, { decision: "approve", comment: $("#rc").value }), "Approved. The report is frozen."); };
    if ($("#ret")) $("#ret").onclick = () => { if (!$("#rc").value.trim()) return toast("Say what evidence is missing before returning the case.", "err"); act(() => api.post(`/api/cases/${c.id}/decision`, { decision: "return", comment: $("#rc").value }), "Returned to the analyst: needs additional evidence."); };
    if ($("#rej")) $("#rej").onclick = async () => { if (!$("#rc").value.trim()) return toast("Give the reason for rejecting.", "err"); if (await confirmBox("Reject this assessment?", "No report will be issued. The analyst can rework it as a new revision.", "Reject", "danger")) act(() => api.post(`/api/cases/${c.id}/decision`, { decision: "reject", comment: $("#rc").value }), "Rejected."); };
  }
  function draftBrief(c, conclusion, rationale, unc) {
    const acc = A.evidence.filter(e => e.status === "accepted"), claims = A.claims.filter(x => !x.removed);
    const L = [`Assessment: ${CONCL[conclusion]?.[0]?.toUpperCase() || "NOT YET CONCLUDED"} (draft, not approved)`, `Content: “${c.claim_text.trim()}”`, `Seen on ${c.source_platform}; received ${fmtDT(c.received_at)}. Case ${c.id}.`, "", "Claim by claim:"];
    for (const cl of claims) { const ev = acc.filter(e => e.links.some(l => l.claim_id === cl.id && l.stance !== "context")).map(e => e.id); L.push(`${cl.seq}. ${cl.text} — ${ASSESS[cl.assessment][0]}${ev.length ? ` [${ev.join(", ")}]` : ""}`); }
    if (rationale) L.push("", `Reasoning: ${rationale}`);
    if (unc) L.push(`Uncertainties: ${unc}`);
    if (conclusion === "contradicted" || conclusion === "mixed") L.push("", "Handling: do not repeat the contradicted parts as fact. Any correction should cite the earliest documented source.");
    if (conclusion === "insufficient") L.push("", "Handling: report as unverified and seek confirmation from the named source before use.");
    return L.join("\n");
  }

  // ---------------------------------------------------------------- history
  // ---------------------------------------------------------------- reverse image search (done by the analyst, outside AIVS)
  async function onlineImageSearch(m,P) {
    try {
      const state=await api.get("/api/reverse-images/status");
      if(!state.configured) {const choice=await modal("Online image search is not configured", `<p>${esc(state.needs)}</p><p>Image descriptions do not search earlier web postings. Add the institution's reverse-image provider key to the server configuration, then restart JICHO AI.</p>`,[{label:"Use manual reverse search",value:"manual",kind:"primary"},{label:"Close",value:null}]);if(choice.value==="manual")await webSearch(m,P);return;}
      const r=await modal("Search prior image postings", "<p>This sends a copy of the image to the configured reverse-image provider to find matching public web pages. Continue only for an image cleared for external search. Dates and matches will be checked where accessible; private posts and the first uploader may remain unknown.</p>",[{label:"Cancel",value:null},{label:"Search online",value:true,kind:"primary"}]);
      if(!r.value)return;
      await api.queueTask(A.case.id,"collection",{reverse_image:true,media_id:m.id,confirm_external:true});
      toast("Reverse-image search started. Results will be saved under Background tasks.");location.hash="#/tasks";
    } catch(e){fail(e);}
  }
  async function webSearch(m, P) {
    const sites = [["Google Lens", "https://lens.google.com/"], ["Bing Visual Search", "https://www.bing.com/visualsearch"], ["TinEye", "https://tineye.com/"], ["Yandex Images", "https://yandex.com/images/"]];
    const body = `<div class="callout warn"><div><b>This step leaves AIVS.</b> You upload the image to an outside search service yourself. Do it only for material that is public or cleared for external search. AIVS sends nothing.</div></div>
      <ol class="small" style="margin:12px 0 0 18px;line-height:1.7"><li><a class="btn sm" href="${content(m.id)}?download=1">Download ${esc(m.id)}</a> (the original bytes, unchanged).</li>
        <li>Open one or more services and upload it: ${sites.map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${n}</a>`).join(" · ")}</li>
        <li>Look for the <b>earliest</b> appearance, its date and who posted it. Note different captions for the same picture.</li><li>Record what you found. Leave the date empty if the page does not show one.</li></ol>
      ${P.edit ? `<div class="grid g2" style="margin-top:12px"><div><label class="f" for="wsS">Service and search date</label><input type="text" id="wsS" value="${esc(`Reverse image search, ${new Date().toISOString().slice(0, 10)}`)}"></div><div><label class="f" for="wsD">Date of the earliest copy found</label><input type="text" id="wsD" placeholder="2018-10-14"></div></div>
      <label class="f" for="wsF">What you found (include the link)</label><textarea id="wsF" rows="3" placeholder="e.g. Earliest copy: news site X, 14 Oct 2018, captioned as a convoy crossing in Garissa. https://…"></textarea>
      <label class="check" style="margin-top:8px"><input type="checkbox" id="wsNone"> Nothing relevant found (recorded as a lead, not as proof that the image is new)</label>` : ""}`;
    const r = await modal(`Search the web for ${m.id}`, body, [{ label: P.edit ? "Cancel" : "Close", value: null }, ...(P.edit ? [{ label: "Record result", kind: "primary", value: true, validate: async el => {
      const none = $("#wsNone", el).checked, txt = $("#wsF", el).value.trim(), svc = $("#wsS", el).value.trim();
      if (!none && !txt) return "Describe what you found, or tick “Nothing relevant found”.";
      if (!svc) return "Say which service you used and when.";
      try { await api.post(`/api/cases/${A.case.id}/evidence`, { kind: "lead", media_id: m.id, text: none ? `Reverse image search for ${m.id} found no relevant earlier copy. This does not show that the image is new or authentic.` : `Reverse image search for ${m.id}: ${txt}`, reference: svc, source_date: none ? null : ($("#wsD", el).value.trim() || null) }); }
      catch (e) { return errMsg(e); } } }] : [])]);
    if (r.value) { toast("Result recorded as accepted evidence (a lead). Link it to the claims it bears on."); await reload(); }
  }

  // ---------------------------------------------------------------- notes (team discussion)
  function notes(body, c, P) {
    const list = A.notes, me = App.me.id;
    const one = n => n.deleted ? `<div class="note-item deleted"><span class="small sub">Note deleted by its author or an administrator ${ago(n.edited_at)}.</span></div>`
      : `<div class="note-item" id="note-${n.id}"><div class="row"><b>${esc(A.users[n.author_id] || "—")}</b><span class="tiny sub" title="${esc(fmtDT(n.created_at))}">${ago(n.created_at)}</span>${n.revision !== c.revision ? `<span class="chip grey">revision ${n.revision}</span>` : ""}${n.edited_at ? `<span class="tiny sub">· edited ${ago(n.edited_at)}</span>` : ""}
        <span class="right row">${n.author_id === me ? `<button class="btn sm ghost" data-ne="${n.id}">Edit</button>` : ""}${n.author_id === me || App.me.role === "admin" ? `<button class="btn sm ghost" data-nd="${n.id}">Delete</button>` : ""}</span></div>
        <div class="note-body">${esc(n.body)}</div>
        ${n.versions?.length ? `<details class="small"><summary class="sub">Earlier wording (${n.versions.length})</summary>${n.versions.slice().reverse().map(v => `<div class="ev-old"><div class="tiny sub">Replaced ${fmtDT(v.replaced_at)}</div>${esc(v.body)}</div>`).join("")}</details>` : ""}</div>`;
    body.innerHTML = `<div class="card"><div class="hd"><h3>Team notes</h3><span class="small sub right">Internal working notes. They are kept with the case and in the audit log, and never appear in reports.</span></div><div class="bd">
      ${list.length ? `<div class="notes">${list.map(one).join("")}</div>` : `<p class="muted small">No notes yet. Use notes to hand over work, ask a reviewer a question or record a decision.</p>`}
      ${P.note ? `<label class="f" for="nb">Add a note</label><textarea id="nb" rows="3" maxlength="4000" placeholder="e.g. Contacted the unit press office at 10:40; awaiting a reply."></textarea><div id="nbErr" class="callout bad" style="margin-top:8px" hidden></div><div style="margin-top:10px"><button class="btn primary" id="nbAdd">Add note</button></div>`
        : `<p class="small sub">Your role can read notes but not write them.</p>`}</div></div>`;
    if (P.note) $("#nbAdd").onclick = async () => {
      const t = $("#nb").value.trim(), err = $("#nbErr");
      if (!t) { err.hidden = false; err.textContent = "Write something before adding the note."; $("#nb").focus(); return; }
      try { await api.post(`/api/cases/${c.id}/notes`, { body: t }); toast("Note added."); await reload(); } catch (e) { err.hidden = false; err.textContent = errMsg(e); }
    };
    $$("[data-ne]").forEach(b => b.onclick = async () => {
      const n = list.find(x => x.id === +b.dataset.ne);
      const r = await modal("Edit note", `<p class="small muted" style="margin-top:0">The earlier wording stays visible under the note.</p><textarea id="neT" rows="5" maxlength="4000">${esc(n.body)}</textarea>`, [{ label: "Cancel", value: null }, { label: "Save", kind: "primary", value: true,
        validate: async el => { try { await api.patch(`/api/notes/${n.id}`, { body: $("#neT", el).value }); } catch (e) { return errMsg(e); } } }]);
      if (r.value) { toast("Note updated."); await reload(); }
    });
    $$("[data-nd]").forEach(b => b.onclick = async () => { if (await confirmBox("Delete note", "The note will be hidden from the case. Its text is kept in the record for audit.", "Delete note", "danger")) act(() => api.del(`/api/notes/${b.dataset.nd}`), "Note deleted."); });
  }

  async function history(body, c) {
    const au = await api.get(`/api/cases/${c.id}/audit`).catch(() => ({ entries: [] }));
    body.innerHTML = `<div class="split"><div class="card"><div class="hd"><h3>Versions</h3><span class="small sub right">Every change saves a full snapshot</span></div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Version</th><th>Change</th><th>By</th><th>When</th><th></th></tr></thead><tbody>
      ${A.versions.map(v => `<tr><td class="num">${v.version}<div class="tiny sub">rev ${v.revision}</div></td><td class="small">${esc(v.reason)}</td><td class="small">${esc(A.users[v.changed_by] || "system")}</td><td class="small sub">${fmtDT(v.changed_at)}</td><td><button class="btn sm ghost" data-ver="${v.version}">View</button></td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><div class="hd"><h3>Audit trail</h3><span class="small sub right">Hash-chained; edits to past entries are detectable</span></div><div class="bd"><ul class="mini">${au.entries.map(a => `<li><span class="tiny sub" style="width:130px;flex:none">${fmtDT(a.at)}</span><span class="small"><b>${esc(a.username)}</b> · ${esc(a.action)}</span></li>`).join("") || `<li class="small muted">No entries.</li>`}</ul></div></div></div>`;
    $$("[data-ver]").forEach(b => b.onclick = async () => {
      const v = await api.get(`/api/cases/${c.id}/versions/${b.dataset.ver}`), s = v.snapshot, k = s.case;
      modal(`Version ${v.version} · ${v.reason}`, `<p class="small muted">Saved ${fmtDT(v.changed_at)} by ${esc(A.users[v.changed_by] || "system")}.</p>
        <dl class="kv"><dt>Status</dt><dd>${esc(STATUS[k.status])}</dd><dt>Title</dt><dd>${esc(k.title)}</dd><dt>Working text</dt><dd>${esc(k.claim_text)}</dd><dt>Conclusion</dt><dd>${esc(CONCL[k.conclusion]?.[0] || "—")}</dd><dt>Reasoning</dt><dd>${esc(k.conclusion_rationale || "—")}</dd><dt>Uncertainties</dt><dd>${esc(k.uncertainties || "—")}</dd></dl>
        ${s.claims ? `<h4 style="margin-top:12px">Claims</h4><ul class="small">${s.claims.filter(x => !x.removed).map(x => `<li>${esc(x.text)} — <b>${esc(ASSESS[x.assessment][0])}</b></li>`).join("")}</ul>` : ""}
        ${s.evidence ? `<p class="small">${s.evidence.filter(e => e.status === "accepted").length} accepted evidence item(s), ${s.evidence.filter(e => e.status === "suggested").length} pending.</p>` : ""}
        <details><summary class="small">Full snapshot (JSON)</summary><pre class="box">${esc(JSON.stringify(s, null, 2))}</pre></details>`, [{ label: "Close" }], { wide: true });
    });
  }

  draw();
}

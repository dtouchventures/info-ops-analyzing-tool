// Guided mode: a case in four steps, one main action each.
//   1 Add content      the material as received, files, run the automatic checks
//   2 Review findings  claims, warnings, and suggested evidence to accept or dismiss
//   3 Record conclusion  a verdict and reason per claim, the overall conclusion, uncertainties
//   4 Review and export  what still blocks submission (each with a link to fix it), submit, approve, download
// Every change is saved through the same API calls as the full tools, so evidence references, analyst acceptance,
// permissions, versions, audit history and independent approval all stay exactly as they are. Nothing is accepted for
// the analyst: suggestions and AI verdicts need an explicit click, and submission uses the server's own readiness check.
import { api } from "../api.js";
import { App, refreshNavCounts } from "../app.js";
import { $, $$, esc, toast, fail, confirmBox, fmtDT, kb, status, concl, CONCL, KIND } from "../ui.js";
import { verdictNeeds, ACTIVE_CONCLUSIONS } from "/shared/verdict.js";

export const STEP_NAMES = ["Add content", "Review findings", "Record conclusion", "Review and export"];
// the four verdicts; the two older ones are shown only on claims that already carry them
const VERDICTS = [["supported", "Supported"], ["contradicted", "Contradicted"], ["insufficient", "Not enough evidence"], ["not_verifiable", "Cannot be verified"]];
const LEGACY = [["partially_supported", "Partly supported (older verdict)"], ["misleading_context", "Misleading context (older verdict)"]];
const VLABEL = Object.fromEntries([...VERDICTS, ...LEGACY]);
const TOOLS = [["overview", "Source and dates", "Edit the title, source, dates and working copy of the text"], ["media", "Media and matches", "Archive matches, metadata, text in images, video frames, transcripts"], ["claims", "Claims", "Split, merge, edit or remove claims; search for evidence"],
  ["evidence", "Evidence", "Add your own evidence; correct accepted items"], ["coverage", "Evidence coverage", "Evidence per claim, missing information, next steps"], ["assistant", "Assistant", "Ask questions about this case"], ["ai", "AI assistance", "Optional AI analysis (suggestions only)"],
  ["report", "Conclusion and report (full)", "All report formats and the briefing summary"], ["notes", "Notes", "Team notes (never in reports)"], ["history", "History", "Every version and the audit trail"]];
const HIDDEN_TOOLS = ["assistant", "ai"];   // secondary: still in Advanced mode, not offered in the guided steps
const FOCUS_KEY = "aivs-step-focus";

// which step a case is at
export function currentStep(A) {
  const c = A.case;
  if (["draft", "analysing", "analysis_failed"].includes(c.status)) return 1;
  if (["analyst_review", "needs_evidence"].includes(c.status)) {
    const active = A.claims.filter(x => !x.removed);
    // findings come first: while suggestions wait, or before any claim has a verdict
    if (!active.length || A.evidence.some(e => e.status === "suggested") || (active.every(x => x.assessment === "unassessed") && !c.conclusion)) return 2;
    if (claimProblems(A).length || !c.conclusion || !String(c.conclusion_rationale || "").trim() || !String(c.uncertainties || "").trim()) return 3;
  }
  return 4;
}
function claimProblems(A) {
  const acc = A.evidence.filter(e => e.status === "accepted");
  return A.claims.filter(x => !x.removed).map(cl => {
    const stances = acc.flatMap(e => e.links.filter(l => l.claim_id === cl.id).map(l => l.stance));
    if (cl.assessment === "unassessed") return { cl, msg: "Choose a verdict." };
    if (!String(cl.rationale || "").trim()) return { cl, msg: "Write one or two sentences saying why.", field: "why" };
    const need = verdictNeeds(cl.assessment, stances); if (need) return { cl, msg: `This claim ${need}. Link the evidence that shows it, or change the verdict.`, evidence: true };
    return null;
  }).filter(Boolean);
}

export function moreTools(c, extra = "") {
  return `<details class="moretools"><summary>More tools</summary><div class="mt-menu"><a href="#/case/${esc(c.id)}/automatic"><b>Automatic report</b><span>Dated fact-checking report; no analyst comments required</span></a>${TOOLS.filter(([k]) => !HIDDEN_TOOLS.includes(k)).map(([k, l, d]) => `<a href="#/case/${esc(c.id)}/${k}"><b>${esc(l)}</b><span>${esc(d)}</span></a>`).join("")}${extra}</div></details>`;
}

export function renderSteps(el, step, ctx) {
  const { A, act, reload, linkEvidence, runSearch, timeline } = ctx, c = A.case, P = A.perms, cur = currentStep(A), base = `#/case/${esc(c.id)}`;
  const edit = P.edit && ["analyst_review", "needs_evidence"].includes(c.status);
  const reachable = n => n === 1 || !["draft", "analysing", "analysis_failed"].includes(c.status);
  const bar = `<ol class="gsteps" aria-label="Investigation steps">${STEP_NAMES.map((name, i) => { const n = i + 1, cls = n === step ? "cur" : n < cur ? "done" : ""; return `<li class="${cls}">${reachable(n) && n !== step ? `<a href="${base}/step${n}">` : "<span>"}<i>${n < cur && n !== step ? "✓" : n}</i> ${name}${reachable(n) && n !== step ? "</a>" : "</span>"}</li>`; }).join("")}</ol>`;
  const head = `<div class="ghead">
      ${c.is_training ? `<div class="callout train" style="margin-bottom:10px"><div><b>Training case.</b> Synthetic material for practice; not an operational assessment.</div></div>` : ""}
      <div class="row" style="align-items:flex-start;gap:10px"><div style="min-width:0;flex:1"><div class="id mono small sub">${esc(c.id)} · revision ${c.revision}</div><h1 style="margin:2px 0 4px">${esc(c.title)}</h1>
        <div class="small sub">${status(c.status)} · ${esc(c.source_platform)} · received ${fmtDT(c.received_at)} · analyst ${esc(c.assigned?.name || "unassigned")}</div></div>${moreTools(c)}</div>${bar}</div>`;
  const nav = (back, main) => `<div class="gnav">${back ? `<a class="btn" href="${back}">← Back</a>` : "<span></span>"}<div class="row" style="justify-content:flex-end">${main}</div></div>`;
  const saved = id => `<span class="saved tiny sub" id="sv-${id}" aria-live="polite"></span>`;
  const flash = id => { const s = $(`#sv-${id}`); if (s) { s.textContent = "Saved"; setTimeout(() => { if (s.isConnected) s.textContent = ""; }, 2500); } };
  // text boxes save when you leave them, without redrawing the page (so the next box keeps its focus)
  const quietPatch = async (url, body, id, field) => { try { await api.patch(url, body); flash(id); await ctx.refresh();
    const m = field && $(`[data-miss="${CSS.escape(id)}"]`); if (m) m.hidden = !!field.value.trim(); } catch (e) { fail(e); } };
  let html = "";

  // ------------------------------------------------------------ 1 Add content
  if (step === 1) {
    const files = A.media.filter(m => !m.parent_media_id), draft = c.status === "draft";
    html = `<div class="card"><div class="hd"><h3>Content as received</h3><span class="chip grey right">Kept unchanged</span></div><div class="bd">
        <div class="quote">${esc(c.claim_text_original)}</div>
        ${c.source_url ? `<div class="small" style="margin-top:8px">Link: <a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(c.source_url)}</a>${c.source_snapshot_sha256 ? ` · <a href="/api/cases/${esc(c.id)}/snapshot">archived copy</a>` : ""}</div>` : ""}</div></div>
      <div class="card"><div class="hd"><h3>Files</h3><span class="small sub right">${files.length} file${files.length === 1 ? "" : "s"}</span></div><div class="bd">
        ${files.length ? `<ul class="uplist">${files.map(m => `<li>${m.kind === "image" ? `<img src="/api/media/${esc(m.id)}/thumb" alt="">` : `<div class="ph">${esc(m.kind.toUpperCase())}</div>`}<div style="min-width:0"><b class="small">${esc(m.original_name)}</b> <span class="tiny sub">${kb(m.size_bytes || m.size || 0)} · ${esc(m.id)} · SHA-256 <span class="mono">${esc(String(m.sha256).slice(0, 12))}…</span></span></div></li>`).join("")}</ul>`
          : `<p class="small sub" style="margin:0 0 8px">No files. That is fine for text. If the post had a picture, video or voice note, add it: pictures are compared with the reference archive.</p>`}
        ${draft && P.edit ? `<div class="dropzone" id="gdz" tabindex="0" role="button" aria-label="Add files" style="margin-top:8px"><b>Add files</b><div class="small muted">Drop them here or <u>choose files</u> · images, video, audio, PDF, Word</div><input type="file" id="gfi" multiple hidden></div><div id="gup" class="small" style="margin-top:6px"></div>` : ""}</div></div>
      ${c.status === "analysis_failed" ? `<div class="callout bad"><div><b>The checks failed.</b> ${esc(c.analysis_error || "")} Nothing was lost. Remove a damaged file in More tools → Media if that is the cause, then try again.</div></div>` : ""}
      ${c.status === "analysing" ? `<div class="callout info"><div><span class="spin"></span> <b>Checking…</b> AIVS is splitting the text into claims and comparing the files with the archive. This page moves on by itself.</div></div>` : ""}
      ${nav(null, draft || c.status === "analysis_failed" ? (P.edit ? `<button class="btn primary" id="gRun">${draft ? "Run checks" : "Try again"}</button>` : `<span class="small sub">The assigned analyst runs the checks.</span>`) : c.status === "analysing" ? "" : `<a class="btn primary" href="${base}/step2">Next: Review findings →</a>`)}`;
  }

  // ------------------------------------------------------------ 2 Review findings
  if (step === 2) {
    const active = A.claims.filter(x => !x.removed), sug = A.evidence.filter(e => e.status === "suggested"), acc = A.evidence.filter(e => e.status === "accepted");
    const warn = [];
    const { conflict } = timeline(c); if (conflict) warn.push(`<b>Timing conflict:</b> ${esc(conflict.e.label)} is dated ${fmtDT(conflict.e.d)}, earlier than the timing the content claims. The material may be older than presented.`);
    for (const m of A.matches.filter(x => ["identical", "strong"].includes(x.level))) warn.push(`<b>${m.level === "identical" ? "Identical" : "Very similar"} image already held:</b> ${esc(m.media_id)} matches ${m.target_archive_id ? `archive record ${esc(m.target_archive_id)}${m.archive_date ? ` (dated ${esc(String(m.archive_date).slice(0, 10))})` : ""}` : `case ${esc(m.target_case_id)}`}. Check where it first appeared.`);
    for (const cl of active.filter(x => x.claim_type && x.claim_type !== "factual")) warn.push(`<b>Claim ${cl.seq} looks like ${esc({ opinion: "an opinion", prediction: "a prediction", satire: "satire", question: "a question", appeal: "a call to share" }[cl.claim_type] || cl.claim_type)}</b>, which cannot be shown true or false. Remove it in More tools → Claims, or explain this in step 3.`);
    for (const m of A.media.filter(x => x.document?.warnings?.length)) warn.push(`<b>${esc(m.original_name)}:</b> ${esc(m.document.warnings.join("; "))}`);
    const stanceSel = (e, cl) => { const s = (e.suggested_links || []).find(l => l.claim_id === cl.id)?.stance || ""; return `<label class="small gstance"><span class="chip grey">Claim ${cl.seq}</span><select data-ln="${esc(e.id)}" data-cl="${esc(cl.id)}" ${edit ? "" : "disabled"} title="${esc(cl.text)}"><option value="">Not related</option>${["supports", "contradicts", "context"].map(x => `<option value="${x}" ${s === x ? "selected" : ""}>${{ supports: "Supports", contradicts: "Contradicts", context: "Context only" }[x]}</option>`).join("")}</select></label>`; };
    const origin = e => e.origin === "system" ? "Automatic check" : e.origin === "ai" ? "AI suggestion" : e.origin === "retrieval" ? "Search result" : "Analyst";
    const cite = e => { const u = e.source_url || (String(e.reference || "").match(/https?:\/\/[^\s<>"]+/) || [])[0]; return u ? `<div class="small"><a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(e.source_title || u)}</a>${e.source_publisher ? ` · ${esc(e.source_publisher)}` : ""}${e.rating ? ` · rated “${esc(e.rating)}”` : ""}</div>` : `<div class="small sub">Reference: ${esc(e.reference)}</div>`; };
    html = `<div class="split"><div class="stack">
      <div class="card"><div class="hd"><h3>Suggested evidence</h3>${sug.length ? `<span class="chip warn">${sug.length} to review</span>` : `<span class="chip sup">all reviewed</span>`}</div><div class="bd">
        <p class="small sub" style="margin-top:0">Suggestions count for nothing until you accept them. Say how each one bears on the claims, then accept or dismiss it.</p>
        ${sug.length ? sug.map(e => `<div class="ev sugg" id="ev-${esc(e.id)}"><div class="row"><span class="mono small"><b>${esc(e.id)}</b></span><span class="chip grey">${KIND[e.kind]?.[0] || e.kind}</span><span class="chip ${e.origin === "ai" ? "info" : "teal"}">${origin(e)}</span></div>
            <div style="margin-top:6px">${esc(e.text)}</div>${cite(e)}
            ${active.length ? `<div class="gstances">${active.map(cl => stanceSel(e, cl)).join("")}</div>` : ""}
            ${edit ? `<div class="row" style="margin-top:8px"><button class="btn sm primary" data-acc="${esc(e.id)}">Accept</button><button class="btn sm" data-dis="${esc(e.id)}">Dismiss</button></div>` : ""}</div>`).join("")
          : `<p class="small" style="margin:0">No suggestions waiting.${acc.length ? "" : " Add your own evidence in More tools → Evidence, or search below."}</p>`}
        ${edit && active.length ? `<div class="row" style="margin-top:10px"><button class="btn sm ghost" id="gSearch">Search for fact-checks and sources</button><span class="tiny sub">Results arrive here as suggestions.</span></div>` : ""}</div></div>
      <div class="card"><div class="hd"><h3>Accepted evidence</h3><span class="chip teal">${acc.length}</span><a class="small right" href="${base}/evidence">Add your own</a></div><div class="bd">
        ${acc.length ? `<ul class="mini">${acc.map(e => `<li><span class="mono small">${esc(e.id)}</span><span class="small" style="flex:1">${esc(e.text.slice(0, 160))}${e.text.length > 160 ? "…" : ""} ${e.links.map(l => { const cl = active.find(x => x.id === l.claim_id); return cl ? `<span class="chip ${l.stance === "supports" ? "sup" : l.stance === "contradicts" ? "con" : "grey"}">claim ${cl.seq}: ${l.stance}</span>` : ""; }).join(" ")}</span></li>`).join("")}</ul>` : `<p class="small sub" style="margin:0">None yet.</p>`}</div></div>
    </div><div class="stack">
      <div class="card"><div class="hd"><h3>Warnings</h3><span class="chip ${warn.length ? "warn" : "grey"}">${warn.length}</span></div><div class="bd small">${warn.length ? `<ul class="gwarn">${warn.map(w => `<li>${w}</li>`).join("")}</ul><p class="tiny sub">Warnings are leads to check, not findings.</p>` : `<p style="margin:0">The automatic checks raised no warnings. That does not mean the content is accurate.</p>`}</div></div>
      <div class="card"><div class="hd"><h3>Claims to check</h3><span class="chip grey">${active.length}</span><a class="small right" href="${base}/claims">Edit, split or add</a></div><div class="bd">
        ${active.length ? `<ol class="gclaims">${active.map(cl => `<li id="cl-${esc(cl.id)}">${esc(cl.text)}</li>`).join("")}</ol>` : `<p class="small" style="margin:0"><b>No claims yet.</b> Add at least one specific, checkable statement in <a href="${base}/claims">Claims</a>.</p>`}</div></div>
      <div class="card" id="gCA"><div class="hd"><h3>Content analysis</h3><button class="btn sm ghost right" id="gCAgo" type="button">Analyze content</button></div><div class="bd small" id="gCAbd"><p class="sub" style="margin:0">Tone, topics, names, red flags and similar posts, each with its method and limits. Nothing here is a finding.</p></div></div>
    </div></div>
    ${nav(`${base}/step1`, `${sug.length ? `<span class="small sub" style="max-width:340px">${sug.length} suggestion${sug.length > 1 ? "s" : ""} still to accept or dismiss before you can submit. You can continue and come back.</span>` : ""}<a class="btn primary" href="${base}/step3">Next: Record conclusion →</a>`)}`;
  }

  // ------------------------------------------------------------ 3 Record conclusion
  if (step === 3) {
    const active = A.claims.filter(x => !x.removed), acc = A.evidence.filter(e => e.status === "accepted"), probs = new Map(claimProblems(A).map(p => [p.cl.id, p])), exp = A.expectedConclusion;
    const ed = edit;
    html = `${!["analyst_review", "needs_evidence"].includes(c.status) ? `<div class="callout info" style="margin-bottom:12px"><div>This case is ${esc(c.status_label || c.status)}; the conclusion can no longer be changed here.</div></div>` : ""}
      ${c.status === "needs_evidence" && c.reviewer_comment ? `<div class="callout warn" style="margin-bottom:12px"><div><b>The reviewer asked for more:</b> ${esc(c.reviewer_comment)}</div></div>` : ""}
      <div class="stack">${active.map(cl => { const L = acc.filter(e => e.links.some(l => l.claim_id === cl.id)), p = probs.get(cl.id);
        return `<div class="card gclaim" id="cl-${esc(cl.id)}"><div class="bd">
          <div class="row" style="align-items:flex-start"><span class="no">${cl.seq}</span><div style="flex:1;min-width:0"><b>${esc(cl.text)}</b>
            <div class="small" style="margin-top:4px">${L.length ? L.map(e => { const s = e.links.find(l => l.claim_id === cl.id).stance; return `<span class="chip ${s === "supports" ? "sup" : s === "contradicts" ? "con" : "grey"}" title="${esc(e.text)}">${esc(e.id)} ${s}</span>`; }).join(" ") : `<span class="sub">No accepted evidence linked.</span>`}
              ${ed ? `<button class="btn sm ghost" data-link="${esc(cl.id)}">Link evidence</button>` : ""}</div></div></div>
          ${cl.suggested_assessment ? `<div class="callout info small" style="margin:8px 0 0"><div><b>Suggestion (not a decision): ${esc(VLABEL[cl.suggested_assessment] || cl.suggested_assessment)}.</b> ${esc(cl.suggested_basis || "")} ${ed && cl.assessment !== cl.suggested_assessment ? `<button class="btn sm" data-use="${esc(cl.id)}" data-v="${esc(cl.suggested_assessment)}">Use this verdict</button>` : ""}</div></div>` : ""}
          <div class="seg wrap" role="group" aria-label="Verdict for claim ${cl.seq}" style="margin-top:10px">${[...VERDICTS, ...LEGACY.filter(([k]) => cl.assessment === k)].map(([k, l]) => `<button type="button" data-assess="${esc(cl.id)}" data-v="${k}" class="${cl.assessment === k ? "on" : ""}" ${ed ? "" : "disabled"}>${l}</button>`).join("")}</div>
          <label class="f" for="r-${esc(cl.id)}">Why ${saved(`r-${cl.id}`)}</label><textarea id="r-${esc(cl.id)}" data-rat="${esc(cl.id)}" rows="2" ${ed ? "" : "disabled"} placeholder="What the evidence shows for this claim, and what it does not">${esc(cl.rationale || "")}</textarea>
          ${p ? `<div class="gmiss" ${p.field === "why" ? `data-miss="r-${esc(cl.id)}"` : ""}>${esc(p.msg)}${p.evidence ? ` <a href="${base}/step2">Review findings</a>` : ""}</div>` : ""}</div></div>`; }).join("") || `<div class="callout warn"><div>No claims to assess. <a href="${base}/claims">Add a claim</a> first.</div></div>`}
      <div class="card" id="overall"><div class="hd"><h3>Overall conclusion</h3>${c.conclusion ? concl(c.conclusion) : ""}</div><div class="bd">
        ${exp ? `<div class="small">Your claim verdicts lead to <b>${esc(CONCL[exp][0])}</b>.${ed && c.conclusion !== exp ? ` <button class="btn sm" id="gUseExp">Use it</button>` : ""}</div>` : `<div class="small sub">Give every claim a verdict first; AIVS then shows which conclusion they lead to.</div>`}
        <label class="f" for="gcc">Conclusion ${saved("gcc")}</label><select id="gcc" ${ed ? "" : "disabled"}><option value="">Choose…</option>${Object.entries(CONCL).filter(([k]) => ACTIVE_CONCLUSIONS.includes(k) || k === c.conclusion || k === exp).map(([k, [l]]) => `<option value="${k}" ${c.conclusion === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${!c.conclusion ? `<div class="gmiss">Choose the conclusion.</div>` : exp && c.conclusion !== exp ? `<div class="gmiss">It should be “${esc(CONCL[exp][0])}” given the claim verdicts.</div>` : ""}
        <label class="f" for="gcr">Explanation ${saved("gcr")}</label><textarea id="gcr" rows="3" ${ed ? "" : "disabled"} placeholder="How the evidence leads to this conclusion. Separate what was observed from what is inferred.">${esc(c.conclusion_rationale || "")}</textarea>
        ${!String(c.conclusion_rationale || "").trim() ? `<div class="gmiss" data-miss="gcr">Explain the conclusion in a few sentences.</div>` : ""}
        <label class="f" for="gcu">What is still uncertain ${saved("gcu")}</label><textarea id="gcu" rows="2" ${ed ? "" : "disabled"} placeholder="What is still unknown and what would settle it. Write “None identified” if nothing.">${esc(c.uncertainties || "")}</textarea>
        ${!String(c.uncertainties || "").trim() ? `<div class="gmiss" data-miss="gcu">Write what remains uncertain, or “None identified”.</div>` : ""}
        <div class="tiny sub" style="margin-top:8px">Changes are saved as you leave each box. Every change is versioned.</div></div></div></div>
      ${nav(`${base}/step2`, `<a class="btn primary" href="${base}/step4">Next: Review and export →</a>`)}`;
  }

  // ------------------------------------------------------------ 4 Review and export
  if (step === 4) {
    html = `<div id="g4"><div class="empty"><span class="spin"></span> Checking…</div></div>`;
  }
  el.innerHTML = head + `<div class="gbody">${html}</div>`;

  // ------------------------------------------------------------ wiring
  const run = $("#gRun"); if (run) run.onclick = () => act(() => api.post(`/api/cases/${c.id}/analyse`), "Checks started.");
  const dz = $("#gdz"), fi = $("#gfi");
  if (dz) {
    const send = async files => { const box = $("#gup"); for (const f of files) { box.innerHTML = `<span class="spin"></span> Uploading ${esc(f.name)}…`; const fd = new FormData(); fd.append("files", f, f.name);
      try { const r = await api.upload(`/api/cases/${c.id}/media`, fd); if (!r.media?.length) throw new Error((r.errors || []).join(" ") || "Upload failed."); } catch (e) { box.innerHTML = `<span style="color:var(--con)">${esc(f.name)}: ${esc(e.message)}</span>`; return; } }
      box.textContent = ""; toast(`${files.length} file${files.length > 1 ? "s" : ""} added.`); reload(); };
    dz.onclick = () => fi.click(); dz.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
    dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); }; dz.ondragleave = () => dz.classList.remove("over");
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove("over"); send([...e.dataTransfer.files]); }; fi.onchange = () => send([...fi.files]);
  }
  const linksOf = id => $$(`[data-ln="${CSS.escape(id)}"]`).filter(s => s.value).map(s => ({ claim_id: s.dataset.cl, stance: s.value }));
  $$("[data-acc]").forEach(b => b.onclick = () => act(() => api.patch(`/api/evidence/${b.dataset.acc}`, { status: "accepted", links: linksOf(b.dataset.acc) }), `${b.dataset.acc} accepted.`));
  $$("[data-dis]").forEach(b => b.onclick = () => act(() => api.patch(`/api/evidence/${b.dataset.dis}`, { status: "dismissed" }), `${b.dataset.dis} dismissed.`));
  const gs = $("#gSearch"); if (gs) gs.onclick = () => runSearch(c);
  $$("[data-link]").forEach(b => b.onclick = () => linkEvidence(b.dataset.link));
  $$("[data-assess]").forEach(b => b.onclick = () => act(() => api.patch(`/api/claims/${b.dataset.assess}`, { assessment: b.dataset.v, rationale: $(`[data-rat="${CSS.escape(b.dataset.assess)}"]`).value })));
  $$("[data-use]").forEach(b => b.onclick = () => act(() => api.patch(`/api/claims/${b.dataset.use}`, { assessment: b.dataset.v, rationale: $(`[data-rat="${CSS.escape(b.dataset.use)}"]`).value }), "Verdict set. Check it and write why."));
  $$("[data-rat]").forEach(t => t.onchange = () => quietPatch(`/api/claims/${t.dataset.rat}`, { rationale: t.value }, `r-${t.dataset.rat}`, t));
  const cc = $("#gcc"); if (cc && edit) {
    cc.onchange = () => act(() => api.patch(`/api/cases/${c.id}`, { conclusion: cc.value || null }));
    $("#gcr").onchange = () => quietPatch(`/api/cases/${c.id}`, { conclusion_rationale: $("#gcr").value }, "gcr", $("#gcr"));
    $("#gcu").onchange = () => quietPatch(`/api/cases/${c.id}`, { uncertainties: $("#gcu").value }, "gcu", $("#gcu"));
    const ue = $("#gUseExp"); if (ue) ue.onclick = () => act(() => api.patch(`/api/cases/${c.id}`, { conclusion: A.expectedConclusion }), "Conclusion set.");
  }
  if (step === 4) step4(c, P, base, nav, act);
  const ca = $("#gCAgo"); if (ca) { ca.onclick = () => contentAnalysis(c.id); contentAnalysis(c.id); }
  // jump to what a "Fix" link pointed at
  let f = null; try { f = sessionStorage.getItem(FOCUS_KEY); sessionStorage.removeItem(FOCUS_KEY); } catch {}
  if (f) { const t = document.getElementById(f); if (t) { t.scrollIntoView({ block: "center" }); t.classList.add("gflash"); setTimeout(() => t.classList.remove("gflash"), 2500);
    // after the router has finished (it moves focus to the page)
    setTimeout(() => (t.matches("textarea, select, input") ? t : t.querySelector("textarea, select, button") || t).focus?.({ preventScroll: true }), 50); } }
}

// Content analysis: recorded facts, claims, automatic estimates and missing evidence, each labelled
const TAG = { recorded: "What the source shows", claim: "Claims: unverified until assessed", estimate: "Automatic estimate", missing: "Not available" };
async function contentAnalysis(id) {
  const bd = $("#gCAbd"); if (!bd) return;
  bd.innerHTML = `<span class="spin"></span> Analysing the content…`;
  let r; try { r = await api.get(`/api/cases/${encodeURIComponent(id)}/content-analysis`); } catch (e) { bd.innerHTML = `<div class="gmiss">${esc(e.message)}</div>`; return; }
  const E = r.estimates, sec = (k, body, lim) => `<div class="ca-sec"><h4><span class="ca-tag ${k}">${TAG[k]}</span></h4>${body}${lim ? `<div class="ca-lim">${esc(lim)}</div>` : ""}</div>`;
  const list = (label, a) => a?.length ? `<li><b>${label}:</b> ${a.map(esc).join(", ")}</li>` : "";
  const ent = E.entities, ents = [list("People", ent.people), list("Places", ent.places), list("Organisations", ent.organisations), list("Dates", ent.dates), list("Figures and numbers", ent.numbers), list("Hashtags", ent.hashtags), list("Accounts", ent.handles)].join("");
  const sim = E.similar;
  bd.innerHTML = sec("recorded", r.recorded.length ? `<ul>${r.recorded.map(x => `<li><b>${esc(x.label)}:</b> ${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.value)}</a>` : esc(x.value)}${x.basis ? ` <span class="sub">(${esc(x.basis)})</span>` : ""}</li>`).join("")}</ul>` : `<p class="sub" style="margin:0">No source details recorded.</p>`, r.legend.recorded)
    + sec("claim", r.claims.length ? `<ul>${r.claims.map(x => `<li>${esc(x.text.length > 140 ? x.text.slice(0, 140) + "…" : x.text)} <span class="chip ${x.status === "unassessed" ? "grey" : "teal"}">${esc(x.status_label)}</span>${x.accepted_evidence ? ` <span class="tiny sub">${x.accepted_evidence} accepted evidence</span>` : ""}</li>`).join("")}</ul>` : `<p class="sub" style="margin:0">No claims.</p>`, r.legend.claim)
    + sec("estimate", `<ul>
        <li><b>Tone:</b> ${esc(E.sentiment.label)} <span class="sub">(confidence ${Math.round(E.sentiment.confidence * 100)}%: ${esc(E.sentiment.basis)}; ${esc(E.sentiment.method)})</span><div class="ca-lim">${esc(E.sentiment.limits)} <a href="#/models">How the model was trained and scored</a></div></li>
        <li><b>Topics:</b> ${E.topics.items.length ? E.topics.items.map(esc).join(", ") : "none recognised"} <span class="sub">(${esc(E.topics.method)})</span><div class="ca-lim">${esc(E.topics.limits)}</div></li>
        <li><b>Names and details found:</b>${ents ? `<ul>${ents}</ul>` : " none"}<div class="ca-lim">${esc(ent.limits)}</div></li>
        <li><b>Red flags:</b> ${E.red_flags.items.length ? `<ul>${E.red_flags.items.map(f => `<li>“${esc(f.cue)}”: ${esc(f.why)} <span class="sub">Check: ${esc(f.check)}</span></li>`).join("")}</ul>` : "none"}<div class="ca-lim">${esc(E.red_flags.limits)}</div></li>
        <li><b>Similar content:</b> ${sim.datasets_searched ? `${sim.similar_posts} near-identical post${sim.similar_posts === 1 ? "" : "s"} from ${sim.similar_accounts} account${sim.similar_accounts === 1 ? "" : "s"} in ${sim.datasets_searched} imported dataset${sim.datasets_searched === 1 ? "" : "s"}` : "no post datasets imported"}; ${sim.earlier_cases} match${sim.earlier_cases === 1 ? "" : "es"} with earlier cases, ${sim.archive_matches} with the reference archive.
          ${sim.examples.length ? `<ul>${sim.examples.map(x => `<li>${esc(x.account || "?")} · ${esc(x.posted_at || "time unknown")} · ${Math.round(x.similarity * 100)}% same wording · ${esc(x.dataset)}</li>`).join("")}</ul>` : ""}<div class="ca-lim">${esc(sim.limits)}</div></li></ul>`, r.legend.estimate)
    + sec("missing", r.missing.length ? `<ul>${r.missing.map(m => `<li>${esc(m)}</li>`).join("")}</ul>` : `<p class="sub" style="margin:0">Nothing noted.</p>`, r.legend.missing)
    + `<p class="tiny sub" style="margin:8px 0 0">${esc(r.ai.note)}</p>`;
}

const FIX = { no_claims: [2, null, "Add a claim"], unassessed: [3, "cl-", "Choose a verdict"], no_rationale: [3, "cl-", "Write why"], verdict_needs: [3, "cl-", "Link evidence or change the verdict"], pending_suggestions: [2, null, "Review suggestions"],
  no_conclusion: [3, "gcc", "Choose the conclusion"], conclusion_mismatch: [3, "gcc", "Match the conclusion"], no_conclusion_reasoning: [3, "gcr", "Explain the conclusion"], no_uncertainties: [3, "gcu", "Record uncertainties"] };
async function step4(c, P, base, nav, act) {
  const box = $("#g4"), open = ["analyst_review", "needs_evidence"].includes(c.status), done = ["approved", "archived"].includes(c.status);
  let R = null; if (open) { try { R = await api.get(`/api/cases/${c.id}/readiness`); } catch (e) { fail(e); } }
  if (!box.isConnected) return;
  const fix = it => { const [n, anchor, label] = FIX[it.code] || [3, null, "Fix"]; const target = anchor === "cl-" ? `cl-${it.claim_id}` : anchor; return `<a class="btn sm" href="${base}/step${n}" data-focus="${esc(target || "")}">${esc(label)} →</a>`; };
  const report = `<div class="card"><div class="hd"><h3>${done ? "Approved report" : "Report"}</h3></div><div class="bd"><div class="row">
      <a class="btn ${done ? "primary" : ""}" href="/api/cases/${esc(c.id)}/report.pdf?download=1">Download PDF</a><a class="btn ghost" href="/api/cases/${esc(c.id)}/report.html" target="_blank" rel="noopener">Open in browser</a><a class="btn ghost" href="/api/cases/${esc(c.id)}/report.json">JSON</a></div>
      <div class="hint">${done ? "This is the approved report, frozen with a SHA-256 fingerprint." : "Until it is approved, every page is marked DRAFT."}</div></div></div>`;
  let main = "", body = "";
  if (open) {
    body = R?.ok ? `<div class="callout good"><div><b>Ready to submit.</b> Every claim has a verdict, a reason and the evidence it needs; all suggestions are reviewed; the conclusion matches the claims.</div></div>`
      : `<div class="card"><div class="hd"><h3>Before you can submit</h3><span class="chip warn">${R?.items?.length || 0}</span></div><div class="bd"><ul class="gfix">${(R?.items || []).map(it => `<li><span>${esc(it.text)}</span>${P.edit ? fix(it) : ""}</li>`).join("")}</ul></div></div>`;
    main = P.edit ? `<div class="gsubmit"><button class="btn primary" id="gSubmit" ${R?.ok ? "" : "disabled"}>Submit for approval</button><div class="tiny sub">A different person reviews it. The case is locked until they approve it or send it back.</div></div>` : `<span class="small sub">The assigned analyst submits the case.</span>`;
  } else if (c.status === "awaiting_approval") {
    body = `<div class="card"><div class="hd"><h3>Independent approval</h3></div><div class="bd">
      <p class="small" style="margin-top:0">Submitted by <b>${esc(c.submitter?.name || "—")}</b> ${fmtDT(c.submitted_at)}. Proposed conclusion: ${concl(c.conclusion)}</p>
      ${P.approve ? `<p class="small sub">Read the draft report, then decide. Approving freezes the report.</p><label class="f" for="grc">Comment</label><textarea id="grc" rows="2" placeholder="Needed when sending back or rejecting"></textarea>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="gAppr">Approve</button><button class="btn" id="gRet">Send back for more evidence</button><button class="btn danger" id="gRej">Reject</button></div>`
        : `<div class="callout info"><div>${P.ownWork ? "You worked on this case, so a different reviewer must decide it." : "Waiting for a reviewer."}</div></div>`}</div></div>`;
  } else if (c.status === "rejected") body = `<div class="callout bad"><div><b>Rejected</b>${c.decider ? ` by ${esc(c.decider.name)}` : ""}: ${esc(c.reviewer_comment || "")} No report was issued. A new revision can rework it (More tools → History, or switch to Advanced).</div></div>`;
  else if (done) body = `<div class="callout good"><div><b>Approved</b>${c.decider ? ` by ${esc(c.decider.name)}` : ""} ${fmtDT(c.decided_at)}. ${concl(c.conclusion)}</div></div>`;
  box.innerHTML = `<div class="stack">${body}${report}</div>${nav(`${base}/step3`, main)}`;
  $$("[data-focus]", box).forEach(a => a.onclick = () => { try { if (a.dataset.focus) sessionStorage.setItem(FOCUS_KEY, a.dataset.focus); } catch {} });
  const s = $("#gSubmit"); if (s) s.onclick = () => act(() => api.post(`/api/cases/${c.id}/submit`), "Submitted for approval. A reviewer will decide.");
  const ap = $("#gAppr"); if (ap) ap.onclick = async () => { if (await confirmBox("Approve this assessment?", "The report will be frozen with a SHA-256 fingerprint and recorded as approved by you.", "Approve")) act(() => api.post(`/api/cases/${c.id}/decision`, { decision: "approve", comment: $("#grc").value }), "Approved. The report is frozen."); };
  const rt = $("#gRet"); if (rt) rt.onclick = () => { if (!$("#grc").value.trim()) { $("#grc").focus(); return toast("Write what evidence is missing first.", "err"); } act(() => api.post(`/api/cases/${c.id}/decision`, { decision: "return", comment: $("#grc").value }), "Sent back to the analyst."); };
  const rj = $("#gRej"); if (rj) rj.onclick = async () => { if (!$("#grc").value.trim()) { $("#grc").focus(); return toast("Write why it is rejected first.", "err"); } if (await confirmBox("Reject this assessment?", "No report will be issued. It can be reworked as a new revision.", "Reject", "danger")) act(() => api.post(`/api/cases/${c.id}/decision`, { decision: "reject", comment: $("#grc").value }), "Rejected."); };
}

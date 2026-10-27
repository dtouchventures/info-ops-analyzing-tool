"use strict";
// ---------------------------------------------------------------- app shell and router (in-page; no URL routing in hosted pages)
const App = { scope: "real", route: "#/home", mode: "guided", get training() { return this.scope === "training"; }, guided() { return this.mode !== "advanced"; } };
try { App.scope = sessionStorage.getItem("aivs-scope") === "training" ? "training" : "real"; } catch {}
try { App.mode = localStorage.getItem("aivs-mode") === "advanced" ? "advanced" : "guided"; } catch {}
let routeSeq = 0;
function go(r) { App.route = r; route(); window.scrollTo(0, 0); }
document.addEventListener("click", e => { const a = e.target.closest('a[href^="#/"]'); if (a) { e.preventDefault(); go(a.getAttribute("href")); } });
const crumbs = h => { const c = $("#crumbs"); if (c) c.innerHTML = h; };
const PAGES = [[/^#\/?$|^#\/home$/, pageHome, "home"], [/^#\/dashboard$/, pageDashboard, "dashboard"], [/^#\/verify$/, pageVerify, "verify"], [/^#\/privacy$/, pagePrivacy, "privacy"], [/^#\/cases(?:\?(.*))?$/, pageCases, "cases"], [/^#\/search(?:\?(.*))?$/, pageSearch, "search"], [/^#\/new$/, pageNew, "new"], [/^#\/case\/([^/]+)(?:\/(\w+))?$/, pageCase, "cases"], [/^#\/archive$/, pageArchive, "archive"], [/^#\/review$/, pageReview, "review"], [/^#\/reports$/, pageReports, "reports"], [/^#\/admin(?:\/(\w+))?$/, pageAdmin, "admin"]];

function shell() {
  const nav = [["home", "#/home", "Start", "home"], can("case.create") ? ["verify", "#/verify", "Verify information", "verify"] : null, ["dashboard", "#/dashboard", "Dashboard", "dash"], ["cases", "#/cases", "Cases", "cases"], can("case.create") ? ["new", "#/new", "New case (files)", "new"] : null, ["search", "#/search", "Search & check", "search"], ["review", "#/review", "Review queue", "review"], ["archive", "#/archive", "Reference archive", "archive"], ["reports", "#/reports", "Reports", "reports"], ["admin", "#/admin", "Administration", "admin"]].filter(Boolean);
  $("#root").innerHTML = `<div class="shell"><aside class="side" aria-label="Main navigation"><div class="brand"><div class="brand-mark">AIVS</div><div><b>AIVS</b><span>Information verification</span></div></div>
    <nav class="nav">${nav.map(([k, h, l, ic]) => `<a href="${h}" data-nav="${k}">${icon(ic)}<span>${l}</span>${k === "review" ? `<span class="count" id="navReview" hidden></span>` : ""}</a>`).join("")}</nav>
    <div class="side-foot"><b id="meName">${esc(PL.me?.name || "Signed in")}</b>${LOCAL ? "Local user · name not verified" : `${esc(ROLES[myRole()])}${PL.isOwner ? " · owner" : ""}`}<div style="margin-top:4px"><a href="#/privacy" style="color:#9fd8d5">How data is handled</a></div></div></aside>
    <div class="main"><div class="topbar"><div class="crumbs" id="crumbs"></div><div class="right"><div class="scope mode" role="group" aria-label="Interface mode" title="Guided shows one next step at a time; Advanced shows every tool"><button data-mode="guided" class="${App.guided() ? "on" : ""}">Guided</button><button data-mode="advanced" class="${App.guided() ? "" : "on"}">Advanced</button></div><span class="small sub">Records:</span><div class="scope" role="group" aria-label="Which records to show"><button data-scope="real" class="${App.training ? "" : "on"}">Operational</button><button data-scope="training" class="train ${App.training ? "on" : ""}">Training</button></div></div></div>
    ${App.training ? `<div class="trainbar">Training mode — synthetic practice cases and archive records. They are kept separate from operational records and never match them.</div>` : ""}
    ${PL.canWrite === false || myRole() === "viewer" ? `<div class="trainbar" style="background:var(--info-bg);color:var(--info);border-color:#b7d0ea">${PL.canWrite === false ? "You have view-only access to this page. Ask the owner for Contributor access to work on cases." : "Your role is Viewer. The owner can give you an Analyst or Reviewer role under Administration → People and roles."}</div>` : ""}
    <main class="page" id="page" tabindex="-1"></main></div></div>`;
  document.body.classList.toggle("guided", App.guided());
  $$("[data-mode]").forEach(b => b.onclick = () => { if (App.mode === b.dataset.mode) return; App.mode = b.dataset.mode; try { localStorage.setItem("aivs-mode", App.mode); } catch {} shell(); route(); toast(App.guided() ? "Guided mode: one next step at a time, advanced tools hidden." : "Advanced mode: all tools shown."); });
  $$("[data-scope]").forEach(b => b.onclick = () => { App.scope = b.dataset.scope; try { sessionStorage.setItem("aivs-scope", App.scope); } catch {} shell(); route(); });
}
async function route() {
  const seq = ++routeSeq, r = PAGES.find(([re]) => re.test(App.route)) || PAGES[0];
  $$("[data-nav]").forEach(a => a.classList.toggle("on", a.dataset.nav === r[2]));
  const page = $("#page"); page.innerHTML = `<div class="empty"><span class="spin"></span> Loading…</div>`;
  try { await r[1](page, (App.route.match(r[0]) || []).slice(1), { isCurrent: () => seq === routeSeq }); }
  catch (e) { if (seq === routeSeq) page.innerHTML = `<div class="callout bad"><div><b>This page could not be loaded.</b> ${esc(errMsg(e))}</div></div>`; console.error(e); }
  navCounts();
}
async function navCounts() { try { const n = (await Svc.listCases(App.training)).filter(c => c.status === "awaiting_approval").length, el = $("#navReview"); if (el) { el.hidden = !n; el.textContent = n; } } catch {} }

// ---------------------------------------------------------------- dashboard
async function pageDashboard(el) {
  crumbs(`<b>Dashboard</b>${App.training ? " · training records" : ""}`);
  const cases = await Svc.listCases(App.training), arch = await Svc.listArchive(App.training), cnt = Object.fromEntries(Object.keys(STATUS).map(s => [s, cases.filter(c => c.status === s).length]));
  const nm = await names(cases.map(c => c.assigned_to).concat(cases.flatMap(c => (c.audit || []).slice(-3).map(a => a.uid))));
  const open = cnt.draft + cnt.analysing + cnt.analysis_failed + cnt.analyst_review, urgent = cases.filter(c => c.priority === "urgent" && !["approved", "archived"].includes(c.status)).length;
  const sortP = l => l.sort((a, b) => ({ urgent: 0, priority: 1, routine: 2 }[a.priority] - { urgent: 0, priority: 1, routine: 2 }[b.priority]) || b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  const list = (rows, none) => rows.length ? `<ul class="mini">${rows.map(r => `<li><a href="#/case/${esc(r.id)}">${esc(r.id)}</a><span style="min-width:0;flex:1">${esc(r.title)}<div class="tiny sub">${r.assigned_to ? `Assigned to ${esc(nm(r.assigned_to))} · ` : "Unassigned · "}updated ${ago(r.updated_at)}</div></span>${pri(r.priority)} ${status(r.status)}</li>`).join("")}</ul>` : `<p class="muted small">${esc(none)}</p>`;
  const activity = cases.flatMap(c => (c.audit || []).map(a => ({ ...a, case_id: c.id }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
  const approved = cases.filter(c => ["approved", "archived"].includes(c.status));
  const returned = cases.filter(c => c.status === "analyst_review" && c.decided_by && (c.assigned_to === PL.uid || c.submitted_by === PL.uid));
  const processing = cases.filter(c => c.status === "analysing"), failed = cases.filter(c => c.status === "analysis_failed").slice(0, 8);
  const recent = cases.slice().sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")).slice(0, 8);
  el.innerHTML = `<div class="pagehead"><div><h1>${esc(PL.me?.name ? `Welcome, ${PL.me.name.split(" ")[0]}` : "Dashboard")}</h1><p>${App.training ? "Training records only. These figures never include operational cases." : "Figures are counted live from the shared case records. Training cases are excluded."}</p></div><div class="actions">${can("case.create") ? `<a class="btn primary" href="#/new">+ New case</a>` : ""}</div></div>
  ${!cases.length ? `<div class="card"><div class="bd">${empty(App.training ? "No training cases loaded" : "No cases yet", App.training ? "The owner can load the synthetic training cases from Administration → Training data." : "Create the first case to start a verification. Cases your team creates appear here with their status.", App.training ? (PL.isOwner ? `<a class="btn primary" href="#/admin/training">Load training cases</a>` : "") : (can("case.create") ? `<a class="btn primary" href="#/new">Create a case</a>` : ""))}</div></div>` : `
  <div class="kpis"><a class="kpi" href="#/cases?status=open"><div class="l">Open cases</div><div class="v">${open}</div><div class="tiny sub">${cnt.draft} draft · ${cnt.analyst_review} in analyst review</div></a>
    <a class="kpi attn" href="#/review"><div class="l">Awaiting approval</div><div class="v">${cnt.awaiting_approval}</div><div class="tiny sub">Reviewer decision needed</div></a>
    <a class="kpi ${urgent ? "alert" : ""}" href="#/cases?priority=urgent&status=open"><div class="l">Urgent and open</div><div class="v">${urgent}</div><div class="tiny sub">Marked urgent, not yet approved</div></a>
    <a class="kpi ${cnt.analysis_failed ? "alert" : ""}" href="#/cases?status=analysis_failed"><div class="l">Analysis failures</div><div class="v">${cnt.analysis_failed}</div><div class="tiny sub">Need a retry</div></a>
    <a class="kpi" href="#/reports"><div class="l">Approved</div><div class="v">${approved.length}</div><div class="tiny sub">${cnt.archived} archived · ${arch.length} archive records</div></a></div>
  <div class="dash"><div class="stack">
    ${returned.length ? `<div class="card"><div class="hd"><h3>Returned to you by a reviewer</h3></div><div class="bd">${list(sortP(returned), "")}</div></div>` : ""}
    ${processing.length ? `<div class="card"><div class="hd"><h3>Processing now</h3><span class="chip info right"><span class="spin"></span> ${processing.length} analysing</span></div><div class="bd">${list(processing, "")}</div></div>` : ""}
    ${failed.length ? `<div class="card"><div class="hd"><h3>Analysis failed</h3><a class="btn ghost sm right" href="#/cases?status=analysis_failed">Show all</a></div><div class="bd">${list(failed, "")}</div></div>` : ""}
    <div class="card"><div class="hd"><h3>Assigned to you</h3><a class="btn ghost sm right" href="#/cases?assigned=me&status=open">All yours</a></div><div class="bd">${list(sortP(cases.filter(c => c.assigned_to === PL.uid && !["approved", "archived"].includes(c.status))), "Nothing assigned to you is open.")}</div></div>
    <div class="card"><div class="hd"><h3>Awaiting approval</h3><a class="btn ghost sm right" href="#/review">Review queue</a></div><div class="bd">${list(sortP(cases.filter(c => c.status === "awaiting_approval")), "No assessments are waiting for a reviewer.")}</div></div>
  </div><div class="stack">
    <div class="card"><div class="hd"><h3>Approved conclusions</h3></div><div class="bd">${approved.length ? `<div class="bars">${["contradicted", "mixed", "supported", "insufficient"].map(k => { const n = approved.filter(c => c.conclusion === k).length; return `<div class="bar"><span>${CONCL[k][0]}</span><div class="track"><div class="fill" style="width:${(n / approved.length * 100).toFixed(1)}%;background:var(--${CONCL[k][1]})"></div></div><span class="num">${n}</span></div>`; }).join("")}</div>` : `<p class="muted small">No approved assessments yet.</p>`}</div></div>
    <div class="card"><div class="hd"><h3>Recently updated cases</h3><a class="btn ghost sm right" href="#/cases?">All cases</a></div><div class="bd">${list(recent, "No cases yet.")}</div></div>
    <div class="card"><div class="hd"><h3>Recent activity</h3></div><div class="bd"><ul class="mini">${activity.map(a => `<li><span class="tiny sub" style="width:76px;flex:none">${ago(a.at)}</span><span style="min-width:0"><b>${esc(a.uid ? nm(a.uid) : "system")}</b> · ${esc(a.action)} · <a href="#/case/${esc(a.case_id)}">${esc(a.case_id)}</a></span></li>`).join("")}</ul></div></div>
  </div></div>`}`;
  if (processing.length) { const r0 = App.route; setTimeout(() => { if (App.route === r0 && /^#\/?$|^#\/dashboard$/.test(App.route)) pageDashboard(el).catch(() => {}); }, 3000); }
}

// ---------------------------------------------------------------- search and quick image check
let SQ = "";
async function pageSearch(el, [qs]) {
  crumbs(`<b>Search & check</b>${App.training ? " · training records" : ""}`);
  if (qs !== undefined) SQ = new URLSearchParams(qs).get("q") || "";
  el.innerHTML = `<div class="pagehead"><div><h1>Search & check</h1><p>Find anything already recorded, or check whether an image has been seen before, without opening a case.</p></div></div>
  <div class="split"><div class="stack"><div class="card"><div class="hd"><h3>Search everything</h3></div><div class="bd">
    <input type="search" id="sq" placeholder="Words, case or evidence ID, place, date, or part of a SHA-256" value="${esc(SQ)}" aria-label="Search">
    <div class="hint">Searches case text, claims, evidence and references, visible text read from images, notes, file names and fingerprints, and the reference archive${App.training ? " (training records only)" : " (training records excluded)"}.</div><div id="sr" style="margin-top:12px"></div></div></div></div>
  <div class="stack"><div class="card"><div class="hd"><h3>Has this image been seen before?</h3></div><div class="bd">
    <div class="dropzone" id="cdz" tabindex="0" role="button" aria-label="Choose an image to check"><b>Drop an image here</b> or <button class="btn sm" id="cpick">choose a file</button><input type="file" id="cfi" accept="image/*" hidden><div class="hint">Compared with every case and archive record in this ${LOCAL ? "browser" : "workspace"}. Nothing is stored and nothing is sent anywhere.</div></div>
    <div id="cres" style="margin-top:12px"></div></div></div></div></div>`;
  const run = async () => {
    SQ = $("#sq").value.trim(); const box = $("#sr");
    if (!SQ) { box.innerHTML = `<p class="small muted">Type at least one word.</p>`; return; }
    box.innerHTML = `<div class="empty"><span class="spin"></span></div>`;
    const r = await Svc.search(SQ, App.training);
    box.innerHTML = r.length ? `<p class="small sub">${r.length} result${r.length > 1 ? "s" : ""}${r.length > 200 ? ", first 200 shown" : ""}</p><ul class="results">${r.slice(0, 200).map(x => `<li><a href="${x.case_id ? `#/case/${esc(x.case_id)}/${x.tab}` : "#/archive"}"><b>${esc(x.case_id || x.archive_id)}</b> · ${esc(x.where)}</a><div class="small">${esc(x.title)}${x.status ? ` ${status(x.status)}` : ""}</div><div class="small muted">${esc(x.text)}</div></li>`).join("")}</ul>` : `<p class="small muted">Nothing matches “${esc(SQ)}”. Try fewer or different words.</p>`;
  };
  let t; $("#sq").oninput = () => { clearTimeout(t); t = setTimeout(() => run().catch(fail), 250); };
  if (SQ) run().catch(fail);
  const check = async f => {
    const box = $("#cres"); box.innerHTML = `<div class="empty"><span class="spin"></span> Comparing…</div>`;
    try {
      const r = await Svc.checkImage(f, App.training), u = URL.createObjectURL(f);
      box.innerHTML = `<div class="row" style="gap:12px;align-items:flex-start"><img src="${u}" alt="" style="width:120px;max-height:120px;object-fit:contain;border:1px solid var(--line);border-radius:6px"><div style="min-width:0"><b>${esc(f.name)}</b><div class="tiny sub mono" style="overflow-wrap:anywhere">SHA-256 ${esc(r.sha256)}</div>${Object.keys(r.meta).length ? `<div class="tiny sub">Metadata: ${esc(Object.entries(r.meta).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(" · "))}</div>` : ""}</div></div>
        ${r.results.length ? `<ul class="results" style="margin-top:10px">${r.results.map(x => `<li><span class="chip ${x.level === "identical" || x.level === "strong" ? "con" : "warn"}">${x.level === "identical" ? "Identical file" : x.level === "strong" ? "Strong similarity" : "Possible similarity"}</span>
          ${x.archive ? `<a href="#/archive">Archive ${esc(x.archive.id)}</a> “${esc(x.archive.title)}”, documented ${esc(x.archive.documented_date)}` : `<a href="#/case/${esc(x.case.id)}/media">${esc(x.case.id)} · ${esc(x.media.id)}</a> “${esc(x.case.title)}” ${status(x.case.status)}`}
          <div class="tiny sub">${x.kind === "exact" ? "Same SHA-256: the same file was received before. This says nothing about its true origin." : `dHash ${x.dd}/64 + pHash ${x.pd}/64 = ${x.score} bits differ (best on ${esc(x.window)}${x.mirrored ? ", mirrored" : ""}). Not a probability.`}</div></li>`).join("")}</ul>`
          : `<div class="callout info" style="margin-top:10px"><div>No earlier copy among the records held here. This does <b>not</b> show the image is new or authentic, only that it is not in these records.</div></div>`}
        ${can("case.create") ? `<p class="small" style="margin-top:10px">To verify it, <a href="#/new">start a new case</a> and attach this image.</p>` : ""}`;
    } catch (e) { box.innerHTML = `<div class="callout bad"><div>${esc(errMsg(e))}</div></div>`; }
  };
  $("#cpick").onclick = e => { e.stopPropagation(); $("#cfi").click(); };
  $("#cdz").onclick = () => $("#cfi").click();
  $("#cdz").onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#cfi").click(); } };
  $("#cfi").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) check(f); };
  $("#cdz").ondragover = e => { e.preventDefault(); $("#cdz").classList.add("over"); };
  $("#cdz").ondragleave = () => $("#cdz").classList.remove("over");
  $("#cdz").ondrop = e => { e.preventDefault(); $("#cdz").classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) check(f); };
}

// ---------------------------------------------------------------- cases list
const CF = { q: "", status: "", priority: "", conclusion: "", assigned: "" };
async function pageCases(el, [qs]) {
  crumbs(`<b>Cases</b>`);
  // links such as #/cases?status=analysis_failed (dashboard tiles) set the filters they name
  if (qs !== undefined) { const p = new URLSearchParams(qs); Object.assign(CF, { q: (p.get("q") || "").toLowerCase(), status: p.get("status") || "", priority: p.get("priority") || "", conclusion: p.get("conclusion") || "", assigned: p.get("assigned") || "" }); }
  const staff = Object.entries(PL.config.members || {}).filter(([, r]) => r !== "viewer").map(([id]) => id).concat(PL.config.ownerId ? [PL.config.ownerId] : []);
  const nm = await names(staff);
  el.innerHTML = `<div class="pagehead"><div><h1>Cases</h1><p>Search, filter and assign verification cases.</p></div><div class="actions">${can("case.create") ? `<button class="btn" id="impC">Import case</button><input type="file" id="impCF" accept=".json,application/json" hidden><a class="btn primary" href="#/new">+ New case</a>` : ""}</div></div>
  <div class="card"><div class="hd" style="gap:8px"><input type="search" id="fq" placeholder="Search ID, title, text or source" style="max-width:280px" value="${esc(CF.q)}" aria-label="Search cases">
    <select id="fs" style="max-width:190px" aria-label="Status"><option value="">All statuses</option><option value="open">All open</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
    <select id="fp" style="max-width:140px" aria-label="Priority"><option value="">Any priority</option><option value="urgent">Urgent</option><option value="priority">Priority</option><option value="routine">Routine</option></select>
    <select id="fc" style="max-width:180px" aria-label="Conclusion"><option value="">Any conclusion</option>${Object.entries(CONCL).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select>
    <select id="fa" style="max-width:180px" aria-label="Assigned"><option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>${[...new Set(staff)].map(u => `<option value="${esc(u)}">${esc(nm(u))}</option>`).join("")}</select></div>
  <div id="list"><div class="empty"><span class="spin"></span></div></div></div>`;
  for (const [i, k] of [["fs", "status"], ["fp", "priority"], ["fc", "conclusion"], ["fa", "assigned"]]) { $("#" + i).value = CF[k]; $("#" + i).onchange = e => { CF[k] = e.target.value; draw(); }; }
  let t; $("#fq").oninput = e => { clearTimeout(t); t = setTimeout(() => { CF.q = e.target.value.trim().toLowerCase(); draw(); }, 200); };
  if ($("#impC")) {
    $("#impC").onclick = () => $("#impCF").click();
    $("#impCF").onchange = async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      const b = $("#impC"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Importing…';
      try { const r = await Svc.importCase(f, App.training); toast(`${r.updated ? "Updated" : "Imported"} ${r.id}: ${r.media} file(s), ${r.notes} note(s), ${r.reports} approved report(s). Every file was checked against its SHA-256.`); go(`#/case/${r.id}/history`); }
      catch (er) { fail(er); b.disabled = false; b.textContent = "Import case"; }
    };
  }
  const all = await Svc.listCases(App.training), nm2 = await names(all.map(c => c.assigned_to));
  function draw() {
    const rows = all.filter(c => (!CF.q || [c.id, c.title, c.claim_text, c.source_platform].join(" ").toLowerCase().includes(CF.q)) && (!CF.status || (CF.status === "open" ? !["approved", "archived"].includes(c.status) : c.status === CF.status)) && (!CF.priority || c.priority === CF.priority) && (!CF.conclusion || c.conclusion === CF.conclusion) && (!CF.assigned || (CF.assigned === "me" ? c.assigned_to === PL.uid : CF.assigned === "none" ? !c.assigned_to : c.assigned_to === CF.assigned)));
    const filtered = Object.values(CF).some(Boolean), canA = can("case.assign");
    $("#list").innerHTML = rows.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th>Title</th><th>Status</th><th>Priority</th><th>Assigned</th><th class="n">Media</th><th class="n">Claims</th><th>To review</th><th>Updated</th></tr></thead><tbody>${rows.map(c => { const pend = c.evidence.filter(e => e.status === "suggested").length; return `<tr class="click" data-id="${esc(c.id)}"><td class="mono">${esc(c.id)}${c.revision > 1 ? `<div class="tiny sub">rev ${c.revision}</div>` : ""}</td><td style="min-width:220px"><b>${esc(c.title)}</b><div class="tiny sub">${esc(c.source_platform)} · received ${ago(c.received_at)}</div></td><td>${status(c.status)} ${concl(c.conclusion && ["approved", "archived", "awaiting_approval"].includes(c.status) ? c.conclusion : null)}</td><td>${pri(c.priority)}</td>
      <td>${canA && !["approved", "archived"].includes(c.status) ? `<select class="assign" data-id="${esc(c.id)}" aria-label="Assign ${esc(c.id)}" style="padding:4px 6px;font-size:12.5px;min-width:140px"><option value="">Unassigned</option>${[...new Set([...staff, c.assigned_to].filter(Boolean))].map(u => `<option value="${esc(u)}" ${u === c.assigned_to ? "selected" : ""}>${esc(nm2(u))}</option>`).join("")}</select>` : esc(c.assigned_to ? nm2(c.assigned_to) : "Unassigned")}</td>
      <td class="n">${c.media.filter(m => !m.parent).length}</td><td class="n">${c.claims.filter(x => !x.removed).length}</td><td>${pend ? `<span class="chip warn">${pend} suggestion${pend > 1 ? "s" : ""}</span>` : ""}</td><td class="small sub">${ago(c.updated_at)}</td></tr>`; }).join("")}</tbody></table></div>`
      : `<div class="bd">${empty(filtered ? "No cases match these filters" : "No cases yet", filtered ? "Clear a filter or search for something else." : "Cases you create appear here.", !filtered && can("case.create") ? `<a class="btn primary" href="#/new">Create a case</a>` : "")}</div>`;
    $$("tr.click").forEach(r => r.onclick = e => { if (!e.target.closest("select")) go(`#/case/${r.dataset.id}`); });
    $$(".assign").forEach(s => s.onchange = async () => { try { await Svc.assign(s.dataset.id, s.value || null); toast(`${s.dataset.id} assigned.`); } catch (e) { fail(e); } });
  }
  draw();
}

// ---------------------------------------------------------------- new case wizard
async function pageNew(el) {
  if (!can("case.create")) { el.innerHTML = `<div class="callout warn"><div>Your role cannot create cases.</div></div>`; return; }
  crumbs(`<a href="#/cases">Cases</a> / <b>New case</b>`);
  let caseId = null; const up = [], steps = ["1. Claim and source", "2. Media", "3. Review and start"];
  const head = n => `<div class="wizard">${steps.map((s, i) => `<div class="${i === n ? "on" : i < n ? "done" : ""}">${s}</div>`).join("")}</div>`;
  function step1() {
    el.innerHTML = `<div class="pagehead"><div><h1>New case</h1><p>Record the content exactly as received. Only the text is needed; AIVS fills in what it can from the link and the text, and you can correct anything.</p></div></div>${head(0)}
    ${App.training ? `<div class="callout train" style="margin-bottom:14px"><div><b>Training mode.</b> This will be a training case (TR-…), kept apart from operational records.</div></div>` : ""}
    <form class="card" id="f1" novalidate><div class="bd">
      <label class="f" for="su">Link to the post or article <span class="sub" style="font-weight:400">(optional)</span></label><input type="url" id="su" placeholder="https://x.com/…/status/…, a Facebook, TikTok, Telegram or news link, or a message reference">
      <div class="hint">AIVS reads the platform, account and (for X and TikTok links) the posting time from the link itself. It does not open the link.</div>
      <label class="f" for="cl">Post or report text, exactly as received <span class="req">*</span></label><textarea id="cl" rows="5" placeholder="Paste the full text. Do not correct spelling or remove anything."></textarea><div class="hint" id="clh"></div>
      <div id="autonote" class="callout info" style="margin-top:10px" hidden></div>
      <details id="more" style="margin-top:14px"><summary><b>Source details and dates</b> <span class="small sub">— optional; filled automatically where possible</span></summary>
      <div class="grid g3"><div><label class="f" for="sp">Where it was seen</label><input type="text" id="sp" list="pl" placeholder="Platform, channel or outlet"><datalist id="pl"><option>X (Twitter)</option><option>Facebook</option><option>WhatsApp forward</option><option>Telegram channel</option><option>TikTok</option><option>Instagram</option><option>YouTube</option><option>News website</option></datalist></div>
        <div><label class="f" for="sa">Account or author</label><input type="text" id="sa" placeholder="@handle, page or sender"></div><div><label class="f" for="ht">Hashtags</label><input type="text" id="ht" placeholder="#example #another"></div></div>
      <div class="grid g3"><div><label class="f" for="ra">Received by you</label><input type="datetime-local" id="ra" value="${toLocalInput(nowISO())}"></div>
        <div><label class="f" for="pa">Published (per the source)</label><input type="datetime-local" id="pa"><input type="text" id="pb" placeholder="How do you know? e.g. post timestamp" style="margin-top:6px"></div>
        <div><label class="f" for="ea">Event date the content claims</label><input type="datetime-local" id="ea"><input type="text" id="eb" placeholder="e.g. post says “last night”" style="margin-top:6px"></div></div>
      <div class="grid g3"><div><label class="f" for="t">Case title</label><input type="text" id="t" maxlength="200" placeholder="Made from the text if left empty"></div>
        <div><label class="f" for="pr">Priority</label><select id="pr"><option value="routine">Routine</option><option value="priority">Priority</option><option value="urgent">Urgent</option></select></div></div></details>
      <div id="err1" class="callout bad" style="margin-top:14px" hidden></div></div>
      <div class="bd" style="border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end"><a class="btn" href="#/cases">Cancel</a><button class="btn primary" id="n1">Save and add media</button></div></form>`;
    // fill empty fields from the link and the text; never overwrite what the analyst typed
    const F = { sp: "platform", sa: "account", su: "url", pa: "published", pb: "published_basis", ea: "event", eb: "event_basis", ht: "hashtags" };
    const LABEL = { sp: "where it was seen", sa: "account", su: "link", pa: "published date", ea: "event date", ht: "hashtags" };
    for (const id of Object.keys(F)) $("#" + id).addEventListener("input", e => { if (e.isTrusted) { delete $("#" + id).dataset.auto; $("#" + id).classList.remove("autofilled"); } });
    function autofill() {
      if (!$("#f1")) return;                                        // the form has been left
      const g = suggestSource({ text: $("#cl").value, url: $("#su").value.trim() });
      const val = { platform: g.platform, account: g.account, url: !$("#su").value.trim() ? g.url : null, published: g.published_at ? toLocalInput(g.published_at) : null, published_basis: g.published_at ? g.published_basis : null,
        event: g.event?.at ? toLocalInput(g.event.at) : null, event_basis: g.event?.basis || null, hashtags: g.hashtags.length ? g.hashtags.join(" ") : null };
      const filled = [];
      for (const [id, k] of Object.entries(F)) {
        const x = $("#" + id), auto = x.dataset.auto === "1";
        if (x.value.trim() && !auto) continue;                       // the analyst's own entry wins
        const v = val[k] || "";
        if (v) { x.value = v; x.dataset.auto = "1"; x.classList.add("autofilled"); if (LABEL[id]) filled.push(LABEL[id]); }
        else if (auto) { x.value = ""; delete x.dataset.auto; x.classList.remove("autofilled"); }
      }
      const n = $("#autonote");
      if (filled.length) { n.hidden = false; n.innerHTML = `<div>Filled automatically: <b>${esc(filled.join(", "))}</b>. Fields marked in blue below were filled by AIVS; check them and change anything that is wrong.${g.published_at ? ` The posting time comes from the post ID in the link, not from the post's own page.` : ""}</div>`; if (!$("#more").open) $("#more").open = true; }
      else n.hidden = true;
    }
    let tm; const sched = () => { clearTimeout(tm); tm = setTimeout(autofill, 250); };
    $("#su").addEventListener("input", sched); $("#cl").addEventListener("input", sched);
    $("#cl").addEventListener("input", () => { const n = extractClaims($("#cl").value, false).length; $("#clh").textContent = $("#cl").value.trim() ? `About ${n} checkable claim${n === 1 ? "" : "s"} detected. You can split, merge and edit claims after analysis.` : ""; });
    $("#f1").onsubmit = async e => {
      e.preventDefault();
      const b = { title: $("#t").value.trim(), claim_text: $("#cl").value, source_platform: $("#sp").value.trim(), source_account: $("#sa").value.trim() || null, source_url: $("#su").value.trim() || null, hashtags: $("#ht").value,
        received_at: fromLocalInput($("#ra").value) || nowISO(), published_at: fromLocalInput($("#pa").value), published_basis: $("#pb").value.trim() || null, claimed_event_at: fromLocalInput($("#ea").value), claimed_event_basis: $("#eb").value.trim() || null, priority: $("#pr").value, is_training: App.training };
      if (!b.claim_text.trim()) { $("#err1").hidden = false; $("#err1").textContent = b.source_url ? "Paste the text of the post as well. This version cannot open links to read them." : "Paste the text of the post or report."; $("#cl").focus(); return; }
      if (b.published_at && !b.published_basis) b.published_basis = "entered by the analyst";
      const btn = $("#n1"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Saving…';
      try { caseId = await Svc.createCase(b); toast(`Case ${caseId} created as a draft.`); step2(); } catch (er) { $("#err1").hidden = false; $("#err1").textContent = errMsg(er); btn.disabled = false; btn.textContent = "Save and add media"; }
    };
    $("#su").focus();
  }
  function step2() {
    crumbs(`<a href="#/cases">Cases</a> / <b>${esc(caseId)}</b> / media`);
    el.innerHTML = `<div class="pagehead"><div><h1>Add media to ${esc(caseId)}</h1><p>Images and video are stored unchanged. Each file is fingerprinted with SHA-256 before upload.</p></div></div>${head(1)}
    <div class="card"><div class="bd">${PL.assets ? `<div class="dropzone" id="dz" tabindex="0" role="button"><b>Drop images or video here</b><div class="small muted">or paste a screenshot (Ctrl+V), or <u>choose files</u> · JPEG, PNG, WebP, GIF, MP4, MOV, WebM · up to 20 MB each</div><input type="file" id="fi" multiple accept="image/*,video/*" hidden></div>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="auto" checked> For video, extract 6 evenly spaced frames so they can be compared with the archive</label><ul class="uplist" id="ul"></ul>` : `<div class="callout warn"><div>File storage is not available to you on this page. Ask the owner for Contributor access, or continue without media.</div></div>`}</div>
    <div class="bd" style="border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="skip">Continue without media</button><button class="btn primary" id="n2" disabled>Continue</button></div></div>`;
    $("#skip").onclick = step3; $("#n2").onclick = step3;
    if (PL.assets) bindDrop($("#dz"), $("#fi"), files => sendFiles(files));
    async function sendFiles(files) {
      for (const f of files) {
        const li = document.createElement("li"), isImg = f.type.startsWith("image/");
        li.innerHTML = `${isImg ? `<img alt="">` : `<div class="ph">VIDEO</div>`}<div style="min-width:0"><b class="small">${esc(f.name)}</b> <span class="tiny sub">${kb(f.size)}</span><div class="progress" style="margin-top:6px"><div style="width:30%"></div></div><div class="tiny sub st">Fingerprinting and uploading…</div></div><span></span>`;
        if (isImg) li.querySelector("img").src = URL.createObjectURL(f); $("#ul").appendChild(li);
        const st = li.querySelector(".st"), bar = li.querySelector(".progress > div");
        try {
          const m = await Svc.addMedia(caseId, f); up.push(m); bar.style.width = "100%";
          st.innerHTML = `Stored as <b>${esc(m.id)}</b> · SHA-256 <span class="mono">${esc(m.sha256.slice(0, 16))}…</span>`;
          if (m.kind === "video" && $("#auto").checked) { st.insertAdjacentHTML("beforeend", `<div class="fr">Extracting frames…</div>`); try { const n = await sampleFrames(caseId, m, 6, p => (li.querySelector(".fr").textContent = `Extracting frames… ${Math.round(p * 100)}%`)); li.querySelector(".fr").textContent = `${n} frames extracted with their timestamps.`; } catch (e) { li.querySelector(".fr").innerHTML = `<span style="color:var(--con)">${esc(errMsg(e))}</span>`; } }
          $("#n2").disabled = false;
        } catch (e) { st.textContent = errMsg(e); st.style.color = "var(--con)"; bar.style.background = "var(--con)"; }
      }
    }
  }
  function step3() {
    el.innerHTML = `<div class="pagehead"><div><h1>Review and start</h1></div></div>${head(2)}<div class="card"><div class="bd"><p><b>${esc(caseId)}</b> is saved as a draft with ${up.length} media file${up.length === 1 ? "" : "s"}.</p>
      <div class="callout info"><div><b>What local analysis does.</b> In your browser: splits the text into checkable claims, compares images and frames with the reference archive and other cases, reads embedded metadata, and lists leads for you to accept or dismiss. Nothing is sent to an AI service.</div></div></div>
      <div class="bd" style="border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><a class="btn" href="#/case/${esc(caseId)}">Open draft without analysing</a><button class="btn primary" id="gostart">Start local analysis</button></div></div>`;
    $("#gostart").onclick = async () => { $("#gostart").disabled = true; $("#gostart").innerHTML = '<span class="spin"></span> Analysing…'; await Svc.analyse(caseId).catch(fail); go(`#/case/${caseId}`); };
  }
  step1();
}
function bindDrop(dz, fi, onFiles) {
  dz.onclick = () => fi.click(); dz.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
  dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); }; dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove("over"); onFiles([...e.dataTransfer.files]); };
  fi.onchange = () => { onFiles([...fi.files]); fi.value = ""; };
  const onPaste = e => { if (!document.body.contains(dz)) return document.removeEventListener("paste", onPaste); const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); onFiles(fs.map(f => new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.png`, { type: f.type }))); } };
  document.addEventListener("paste", onPaste);
}
async function sampleFrames(caseId, m, n, onP) {
  const v = await openVideo(m.url), d = v.duration; if (!isFinite(d) || d <= 0) throw new AppError("The video duration could not be read.");
  const count = Math.max(2, Math.min(n, Math.ceil(d)));
  for (let i = 0; i < count; i++) { const t = Math.min(d - 0.05, (d * (i + 0.5)) / count); await seekTo(v, t); const b = await frameBlob(v); await Svc.addMedia(caseId, new File([b], `${m.name} @ ${t.toFixed(2)}s.png`, { type: "image/png" }), { parent: m.id, frameTime: t, frameOrigin: "auto" }); onP?.((i + 1) / count); }
  return count;
}

// ---------------------------------------------------------------- review queue and reports
async function pageReview(el) {
  crumbs(`<b>Review queue</b>`);
  const cases = (await Svc.listCases(App.training)).filter(c => c.status === "awaiting_approval"), nm = await names(cases.flatMap(c => [c.assigned_to, c.submitted_by]));
  el.innerHTML = `<div class="pagehead"><div><h1>Review queue</h1><p>Assessments waiting for an independent reviewer. A reviewer cannot decide a case they analysed or submitted.</p></div></div>
  <div class="card">${cases.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th>Title</th><th>Proposed conclusion</th><th>Claims</th><th>Submitted</th><th>Priority</th><th></th></tr></thead><tbody>${cases.map(c => { const P = permsFor(c), cl = c.claims.filter(x => !x.removed); return `<tr><td class="mono">${esc(c.id)}</td><td><b>${esc(c.title)}</b><div class="tiny sub">Analyst: ${esc(nm(c.assigned_to))}</div></td><td>${concl(c.conclusion)}</td><td class="small">${["supported", "contradicted", "insufficient"].map(s => `${cl.filter(x => x.assessment === s).length} ${s}`).join(" · ")}</td><td class="small">${esc(nm(c.submitted_by))}<div class="tiny sub">${fmtDT(c.submitted_at)}</div></td><td>${pri(c.priority)}</td><td>${P.approve ? `<a class="btn primary sm" href="#/case/${esc(c.id)}/report">Review</a>` : `<a class="btn sm" href="#/case/${esc(c.id)}/report">${P.ownWork ? "Your own work" : "View"}</a>`}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="bd">${empty("Nothing is waiting for approval", "When an analyst submits an assessment it appears here for a reviewer.")}</div>`}</div>`;
}
async function pageReports(el) {
  crumbs(`<b>Reports</b>`);
  const reps = await Svc.listReports(App.training), drafts = (await Svc.listCases(App.training)).filter(c => ["analyst_review", "awaiting_approval"].includes(c.status)), nm = await names(reps.map(r => r.approved_by).concat(drafts.map(c => c.assigned_to)));
  el.innerHTML = `<div class="pagehead"><div><h1>Reports</h1><p>Approved reports are frozen at approval with a SHA-256 fingerprint of their content. Drafts change as analysts work.</p></div></div>
  <div class="card"><div class="hd"><h3>Approved reports</h3><span class="chip teal">${reps.length}</span></div>${reps.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Report</th><th>Case</th><th>Conclusion</th><th>Approved</th><th>SHA-256</th><th></th></tr></thead><tbody>${reps.map(r => `<tr><td class="mono">${esc(r.id)}</td><td><a href="#/case/${esc(r.case_id)}">${esc(r.case_id)}</a> · ${esc(r.title)}<div class="tiny sub">Revision ${r.revision}</div></td><td>${concl(r.conclusion)}</td><td class="small">${esc(nm(r.approved_by))}<div class="tiny sub">${fmtDT(r.created_at)}</div></td><td class="mono tiny" title="${esc(r.sha256)}">${esc(r.sha256.slice(0, 16))}…</td><td><div class="row"><button class="btn sm" data-view="${esc(r.id)}">View</button><button class="btn sm ghost" data-dl="${esc(r.id)}" data-f="html">HTML</button><button class="btn sm ghost" data-dl="${esc(r.id)}" data-f="json">JSON</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="bd">${empty("No approved reports yet", "A report is created automatically when a reviewer approves an assessment.")}</div>`}</div>
  <div class="card"><div class="hd"><h3>Drafts in progress</h3><span class="chip grey">${drafts.length}</span></div>${drafts.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th>Status</th><th>Analyst</th><th>Updated</th><th></th></tr></thead><tbody>${drafts.map(c => `<tr><td><a href="#/case/${esc(c.id)}">${esc(c.id)}</a> · ${esc(c.title)}</td><td>${status(c.status)}</td><td>${esc(nm(c.assigned_to))}</td><td class="small sub">${ago(c.updated_at)}</td><td><a class="btn sm" href="#/case/${esc(c.id)}/report">Open</a></td></tr>`).join("")}</tbody></table></div>` : `<div class="bd">${empty("No drafts in progress", "Cases in analyst review or awaiting approval appear here.")}</div>`}</div>`;
  $$("[data-view]").forEach(b => b.onclick = async () => { const r = await Svc.getReport(b.dataset.view); showReport(JSON.parse(r.json), true, `${r.id} · SHA-256 ${r.sha256.slice(0, 16)}…`); });
  $$("[data-dl]").forEach(b => b.onclick = async () => { const r = await Svc.getReport(b.dataset.dl); exportReport(JSON.parse(r.json), true, b.dataset.f, r.id); });
}
async function showReport(d, approved, caption) {
  const html = await reportHtml(d, approved);
  await modal(caption || "Report", `<iframe class="repframe" sandbox title="Report preview"></iframe>`, [{ label: "Download HTML", value: "html" }, { label: "Download JSON", value: "json" }, { label: "Close", kind: "primary", value: null }], { wide: true, onOpen: m => { m.querySelector("iframe").srcdoc = html; } })
    .then(r => r.value && exportReport(d, approved, r.value, `${d.case.id}${approved ? `-r${d.case.revision}` : "-draft"}`));
}
async function exportReport(d, approved, fmt, name) {
  if (!PL.downloads) return toast("Downloads are not available in this view.", "err");
  try { const data = fmt === "json" ? JSON.stringify(d, null, 2) : await reportHtml(d, approved, { embed: true }); await PL.downloads.save({ filename: `${name}.${fmt}`, data }); toast("Report saved."); }
  catch (e) { if (e?.code !== "declined") fail(e); }
}

// ---------------------------------------------------------------- reference archive
const AF = { q: "", type: "" };
async function pageArchive(el) {
  crumbs(`<b>Reference archive</b>`);
  const manage = can("archive.manage") && !!PL.assets;
  el.innerHTML = `<div class="pagehead"><div><h1>Reference archive</h1><p>Images with documented origins. New submissions are compared with every active record. A match is an investigative lead: check the record's provenance before relying on it.</p></div><div class="actions">${manage ? `${PL.downloads ? `<button class="btn" id="expA">Export bundle</button>` : ""}<button class="btn" id="impA">Import bundle</button><input type="file" id="impF" accept=".json,application/json" hidden><button class="btn primary" id="addA">+ Add record</button>` : ""}</div></div>
  <div class="card"><div class="hd"><input type="search" id="aq" placeholder="Search title, description, source or ID" style="max-width:340px" value="${esc(AF.q)}" aria-label="Search the archive"><select id="at" style="max-width:240px" aria-label="Record type"><option value="">All record types</option><option value="original">Documented originals</option><option value="misleading">Previously assessed misleading</option></select></div><div class="bd" id="ag"><div class="empty"><span class="spin"></span></div></div></div>`;
  $("#at").value = AF.type;
  const all = await Svc.listArchive(App.training), cases = await Svc.listCases(App.training);
  const matched = id => cases.filter(c => (c.matches || []).some(x => x.archive_id === id));
  function draw() {
    const q = AF.q.toLowerCase(), rows = all.filter(a => (!q || [a.id, a.title, a.description, a.source_ref].join(" ").toLowerCase().includes(q)) && (!AF.type || a.record_type === AF.type));
    $("#ag").innerHTML = rows.length ? `<div class="archgrid">${rows.map(r => `<button class="arec" data-id="${esc(r.id)}"><img src="${esc(r.media.url)}" alt="" loading="lazy"><div class="bd"><div class="row"><span class="mono tiny">${esc(r.id)}</span><span class="tiny sub" style="margin-left:auto">documented ${fmtD(r.documented_date)}</span></div><b>${esc(r.title)}</b><div>${r.record_type === "misleading" ? `<span class="chip con">Previously assessed misleading</span>` : `<span class="chip sup">Documented original</span>`} ${r.from_case_id ? `<span class="chip info">From ${esc(r.from_case_id)}</span>` : ""}</div><div class="tiny sub">Source: ${esc(r.source_ref)}${matched(r.id).length ? ` · matched in ${matched(r.id).length} case(s)` : ""}</div></div></button>`).join("")}</div>`
      : empty(AF.q || AF.type ? "No records match" : "The reference archive is empty", AF.q || AF.type ? "Try a different search." : "Add images whose origin is documented (official releases, earlier verified reports). Submissions are compared against them.", "");
    $$(".arec").forEach(b => b.onclick = () => detail(b.dataset.id));
  }
  let t; $("#aq").oninput = e => { clearTimeout(t); t = setTimeout(() => { AF.q = e.target.value.trim(); draw(); }, 200); };
  $("#at").onchange = e => { AF.type = e.target.value; draw(); };
  if (manage) {
    if ($("#expA")) $("#expA").onclick = async () => {
      const b = $("#expA"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Preparing…';
      try {
        const bundle = await Svc.exportArchive(App.training);
        await PL.downloads.save({ filename: `aivs-archive${App.training ? "-training" : ""}-${nowISO().slice(0, 10)}.json`, data: new Blob([JSON.stringify(bundle)], { type: "application/json" }) });
        toast(`Bundle with ${bundle.count} record(s) offered for download.`);
      } catch (e) { if (e?.code !== "declined" && e?.code !== "cancelled") fail(e); }
      b.disabled = false; b.textContent = "Export bundle";
    };
    $("#impA").onclick = () => $("#impF").click();
    $("#impF").onchange = async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      const b = $("#impA"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Importing…';
      try {
        const r = await Svc.importArchive(f, App.training);
        const li = (rows, fmt) => rows.length ? `<ul class="small">${rows.map(x => `<li>${fmt(x)}</li>`).join("")}</ul>` : `<p class="small sub">None.</p>`;
        await modal("Archive import finished", `<p>${r.imported.length} imported · ${r.skipped.length} skipped · ${r.failed.length} failed. Every image was checked against its SHA-256 before it was added.</p>
          <h4>Imported</h4>${li(r.imported, x => `${esc(x.from)} → <b class="mono">${esc(x.id)}</b>`)}<h4>Skipped</h4>${li(r.skipped, x => `${esc(x.from)}: ${esc(x.reason)}`)}<h4>Failed</h4>${li(r.failed, x => `${esc(x.from)}: ${esc(x.reason)}`)}`);
        pageArchive(el);
      } catch (er) { fail(er); b.disabled = false; b.textContent = "Import bundle"; }
    };
  }
  if (manage) $("#addA").onclick = async () => {
    const r = await modal("Add a reference record", `<p class="small muted">Only add material whose origin is documented. Every field is required so later analysts can trace it.</p>
      <label class="f" for="nf">Image <span class="req">*</span></label><input type="file" id="nf" accept="image/*"><label class="f" for="nt">Title <span class="req">*</span></label><input type="text" id="nt" placeholder="What the image shows">
      <label class="f" for="nd">Origin and context <span class="req">*</span></label><textarea id="nd" rows="3" placeholder="Where and when it was first published, by whom, and what it actually shows"></textarea>
      <div class="grid g2"><div><label class="f" for="ndt">Documented date <span class="req">*</span></label><input type="date" id="ndt"></div><div><label class="f" for="nty">Record type</label><select id="nty"><option value="original">Documented original</option><option value="misleading">Previously assessed misleading item</option></select></div></div>
      <label class="f" for="nr">Source reference <span class="req">*</span></label><input type="text" id="nr" placeholder="Publication, URL, file reference or report ID">${App.training ? `<div class="callout train" style="margin-top:12px"><div>This will be a training record (TA-…), used only with training cases.</div></div>` : ""}`,
      [{ label: "Cancel", value: null }, { label: "Add record", kind: "primary", validate: async m => { const f = $("#nf", m).files[0]; if (!f) return "Choose the image."; try { await Svc.createArchive({ title: $("#nt", m).value, description: $("#nd", m).value, documented_date: $("#ndt", m).value, record_type: $("#nty", m).value, source_ref: $("#nr", m).value }, { file: f, training: App.training }); } catch (e) { return errMsg(e); } }, value: true }]);
    if (r.value) { toast("Record added and indexed."); pageArchive(el); }
  };
  async function detail(id) {
    const a = await Svc.getArchive(id), nm = await names(a.history.map(h => h.uid)), mc = matched(id);
    const r = await modal(`${a.id} · ${a.title}`, `<div class="split"><div><img src="${esc(a.media.url)}" alt="" style="width:100%;border-radius:6px;cursor:zoom-in" id="dimg"><dl class="kv small" style="margin-top:10px"><dt>SHA-256</dt><dd class="mono tiny">${esc(a.media.sha256)}</dd><dt>dHash / pHash</dt><dd class="mono tiny">${esc(a.media.dhash)} / ${esc(a.media.phash)}</dd><dt>Size</dt><dd>${a.media.width}×${a.media.height}</dd></dl></div>
      <div><dl class="kv"><dt>Type</dt><dd>${a.record_type === "misleading" ? "Previously assessed misleading" : "Documented original"}</dd><dt>Documented</dt><dd>${fmtD(a.documented_date)}</dd><dt>Origin</dt><dd>${esc(a.description)}</dd><dt>Source</dt><dd>${esc(a.source_ref)}</dd>${a.from_case_id ? `<dt>From case</dt><dd>${esc(a.from_case_id)}</dd>` : ""}<dt>Status</dt><dd>${a.active === false ? "Withdrawn" : "Active"}</dd></dl>
      <h4 style="margin-top:14px">Source history</h4><ul class="mini">${a.history.map(h => `<li><span class="tiny sub" style="width:120px;flex:none">${fmtDT(h.at)}</span><span class="small">${esc(h.action)} · ${esc(nm(h.uid))}</span></li>`).join("")}</ul>
      <h4 style="margin-top:14px">Cases that matched this record</h4>${mc.length ? `<ul class="mini">${mc.map(c => `<li><span class="mono small">${esc(c.id)}</span><span class="small" style="flex:1">${esc(c.title)}</span>${status(c.status)}</li>`).join("")}</ul>` : `<p class="small muted">None yet.</p>`}</div></div>`,
      [...(can("archive.manage") && a.active !== false ? [{ label: "Withdraw", kind: "danger", value: "withdraw" }, { label: "Edit", value: "edit" }] : []), { label: "Close", value: null }], { wide: true, onOpen: m => ($("#dimg", m).onclick = () => viewer(a.media.url, a.title)) });
    if (r.value === "edit") {
      const e = await modal(`Edit ${a.id}`, `<label class="f" for="et">Title</label><input type="text" id="et" value="${esc(a.title)}"><label class="f" for="ed">Origin and context</label><textarea id="ed" rows="3">${esc(a.description)}</textarea><div class="grid g2"><div><label class="f" for="edt">Documented date</label><input type="date" id="edt" value="${esc(a.documented_date.slice(0, 10))}"></div><div><label class="f" for="ety">Type</label><select id="ety"><option value="original" ${a.record_type === "original" ? "selected" : ""}>Documented original</option><option value="misleading" ${a.record_type === "misleading" ? "selected" : ""}>Previously assessed misleading</option></select></div></div><label class="f" for="er">Source reference</label><input type="text" id="er" value="${esc(a.source_ref)}"><label class="f" for="ere">Reason for the change <span class="req">*</span></label><input type="text" id="ere" placeholder="Recorded in the source history">`,
        [{ label: "Cancel", value: null }, { label: "Save", kind: "primary", validate: async m => { try { await Svc.editArchive(a.id, { title: $("#et", m).value, description: $("#ed", m).value, documented_date: $("#edt", m).value, record_type: $("#ety", m).value, source_ref: $("#er", m).value }, $("#ere", m).value); } catch (x) { return errMsg(x); } }, value: true }]);
      if (e.value) { toast("Record updated."); pageArchive(el); }
    } else if (r.value === "withdraw") {
      const w = await modal(`Withdraw ${a.id}`, `<p class="small">Withdrawn records stop matching new submissions but stay on file with their history.</p><label class="f" for="wr">Reason <span class="req">*</span></label><input type="text" id="wr">`, [{ label: "Cancel", value: null }, { label: "Withdraw", kind: "danger", validate: async m => { try { await Svc.editArchive(a.id, { active: false }, $("#wr", m).value); } catch (x) { return errMsg(x); } }, value: true }]);
      if (w.value) { toast("Record withdrawn."); pageArchive(el); }
    }
  }
  draw();
}

// ---------------------------------------------------------------- administration
async function pageAdmin(el, [tabArg]) {
  const tabs = [LOCAL ? ["people", "You and this browser"] : ["people", "People and roles"], ...(LOCAL ? [["backup", "Backup and storage"]] : []), ["permissions", "Permissions"], ["integrations", "Integrations"], ["audit", "Audit"], ["training", "Training data"]];
  const tab = tabs.some(t => t[0] === tabArg) ? tabArg : "people";
  crumbs(`<b>Administration</b>`);
  el.innerHTML = `<div class="pagehead"><div><h1>Administration</h1><p>People, permissions, integrations and audit trails.</p></div></div><nav class="tabs">${tabs.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav><div id="ab"></div>`;
  const b = $("#ab");
  if (tab === "people" && LOCAL) {
    b.innerHTML = `<div class="card"><div class="hd"><h3>You and this browser</h3></div><div class="bd">
      <div class="callout warn"><div><b>No-install edition: single user, no sign-in.</b> The name below is typed, not a verified identity. Approvals made here are recorded as <b>local analyst acknowledgements</b>, not independent reviews. For separate analyst and reviewer accounts with server-enforced permissions, use the team edition (start-windows.bat).</div></div>
      <label class="f" for="pn">Name shown on your work</label><div class="row"><input type="text" id="pn" maxlength="80" value="${esc(PL.me?.name || "")}" style="max-width:320px"><button class="btn primary" id="pnSave">Save name</button></div>
      <p class="small muted">Changing the name changes how your earlier work is labelled too, because all of it belongs to this one local profile.</p></div></div>`;
    $("#pnSave").onclick = async () => { try { await LOCALAPI.setName($("#pn").value); PL.me = await PL.user.me(); PL.names = {}; toast("Name saved."); shell(); go("#/admin/people"); } catch (e) { fail(e); } };
  }
  if (tab === "backup" && LOCAL) {
    const est = await navigator.storage?.estimate?.().catch(() => null), persisted = await navigator.storage?.persisted?.().catch(() => null);
    b.innerHTML = `<div class="card"><div class="hd"><h3>Where your work is stored</h3></div><div class="bd">
      <p>Everything (cases, evidence, notes, the archive, reports and the original files, unchanged) is saved in <b>this browser on this computer</b>, in its private IndexedDB storage for AIVS. It survives refreshing, closing the browser and restarting the computer. It is <b>not</b> shared with other browsers, other computers or other people.</p>
      <dl class="kv"><dt>Used</dt><dd>${est?.usage != null ? kb(est.usage) : "unknown"}${est?.quota ? ` of about ${kb(est.quota)} available` : ""}</dd><dt>Protected from automatic clean-up</dt><dd>${persisted ? "Yes" : "Not confirmed. The browser may remove the data if the disk gets very full, so export backups regularly."}</dd></dl>
      <div class="callout warn" style="margin-top:12px"><div>Clearing this browser's site data, using a private window, or opening the file in a different browser shows an empty AIVS. <b>Export a backup</b> before doing any of those.</div></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="bkExp">Export full backup</button><button class="btn" id="bkImp">Restore from backup…</button><input type="file" id="bkF" accept=".json,application/json" hidden></div>
      <p class="small muted">A backup is one file with every record and every stored file, each with its SHA-256. Restoring replaces everything currently in this browser.</p></div></div>`;
    $("#bkExp").onclick = async () => { const x = $("#bkExp"); x.disabled = true; x.innerHTML = '<span class="spin"></span> Preparing…'; try { const d = await LOCALAPI.backup(); await PL.downloads.save({ filename: `aivs-backup-${nowISO().slice(0, 10)}.json`, data: new Blob([JSON.stringify(d)], { type: "application/json" }) }); toast(`Backup with ${d.docs.length} records and ${d.blobs.length} files saved to your downloads.`); } catch (e) { fail(e); } x.disabled = false; x.textContent = "Export full backup"; };
    $("#bkImp").onclick = () => $("#bkF").click();
    $("#bkF").onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; if (!(await confirmBox("Restore from backup?", `Everything now stored in this browser will be replaced by the contents of ${f.name}.`, "Replace and restore", "danger"))) return;
      try { const r = await LOCALAPI.restore(f); toast(`Restored ${r.records} records and ${r.files} files. Reloading…`); setTimeout(() => location.reload(), 900); } catch (er) { fail(er); } };
  }
  if (tab === "people" && !LOCAL) {
    const ids = [...new Set([PL.config.ownerId, ...Object.keys(PL.config.members || {})].filter(Boolean))], nm = await names(ids);
    b.innerHTML = `<div class="card"><div class="hd"><h3>People and roles</h3>${PL.isOwner ? `<div class="right row"><input type="search" id="ps" placeholder="Find a colleague by name" style="width:240px" aria-label="Find a person"><div id="pr" style="position:relative"></div></div>` : ""}</div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Person</th><th>Role</th><th></th></tr></thead><tbody>${ids.map(id => `<tr><td><b>${esc(nm(id))}</b>${id === PL.uid ? ` <span class="chip teal">you</span>` : ""}${id === PL.config.ownerId ? ` <span class="chip navy">owner</span>` : ""}</td><td>${id === PL.config.ownerId ? "Administrator (always)" : PL.isOwner ? `<select data-role="${esc(id)}" style="width:auto;padding:4px 6px">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}" ${PL.config.members[id] === k ? "selected" : ""}>${l}</option>`).join("")}</select>` : esc(ROLES[PL.config.members[id]])}</td><td>${PL.isOwner && id !== PL.config.ownerId ? `<button class="btn sm ghost" data-rm="${esc(id)}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>
      <div class="bd"><label class="f" for="dr" style="margin-top:0">Role for anyone else who opens this page with edit access</label><select id="dr" style="max-width:280px" ${PL.isOwner ? "" : "disabled"}><option value="viewer">Viewer (read-only)</option><option value="analyst">Analyst</option></select>
      <div class="callout info" style="margin-top:14px"><div><b>How access works here.</b> claude.ai controls who can open this page and who can write to it (share it as <b>Contributor</b> to people who will work on cases). AIVS roles then decide what each person can do inside the workflow. Role checks run in the page, so for strict separation of duties give Contributor access only to trusted staff.</div></div>
      ${PL.isOwner ? `<label class="check" style="margin-top:14px"><input type="checkbox" id="sa" ${PL.config.allowSelfApproval ? "checked" : ""}> Allow a reviewer to approve their own work (single-person testing only; switch off for operational use)</label>` : ""}</div></div>`;
    $("#dr").value = PL.config.defaultRole || "viewer";
    if (PL.isOwner) {
      $("#dr").onchange = e => Svc.saveConfig({ defaultRole: e.target.value }).then(() => toast("Default role saved.")).catch(fail);
      $("#sa").onchange = e => Svc.saveConfig({ allowSelfApproval: e.target.checked }).then(() => toast(e.target.checked ? "Self-approval allowed (testing)." : "Self-approval blocked.")).catch(fail);
      $$("[data-role]").forEach(s => s.onchange = () => Svc.saveConfig({ members: { ...PL.config.members, [s.dataset.role]: s.value } }).then(() => toast("Role saved.")).catch(fail));
      $$("[data-rm]").forEach(x => x.onclick = async () => { const m = { ...PL.config.members }; delete m[x.dataset.rm]; await Svc.saveConfig({ members: m }).catch(fail); pageAdmin(el, ["people"]); });
      let tt; $("#ps").onfocus = () => $("#ps").dispatchEvent(new Event("input")); $("#ps").oninput = e => { clearTimeout(tt); tt = setTimeout(async () => {
        const hits = PL.user?.search ? await PL.user.search(e.target.value).catch(() => []) : [];
        $("#pr").innerHTML = hits.length ? `<div class="card" style="position:absolute;right:0;top:4px;z-index:30;width:300px;max-height:280px;overflow:auto">${hits.filter(h => !ids.includes(h.id)).map(h => `<button class="btn ghost" style="width:100%;justify-content:flex-start" data-add="${esc(h.id)}"></button>`).join("") || `<div class="bd small muted">Everyone found already has a role.</div>`}</div>` : "";
        $$("[data-add]").forEach((x, i) => { x.textContent = hits.filter(h => !ids.includes(h.id))[i].name || "Colleague"; x.onclick = async () => { await Svc.saveConfig({ members: { ...PL.config.members, [x.dataset.add]: "analyst" } }).catch(fail); pageAdmin(el, ["people"]); }; });
      }, 200); };
    }
  }
  if (tab === "permissions") {
    const R = Object.keys(ROLES);
    b.innerHTML = `<div class="card"><div class="hd"><h3>What each role can do</h3></div><div class="tablewrap"><table class="perm"><thead><tr><th>Permission</th>${R.map(r => `<th>${esc(ROLES[r])}</th>`).join("")}</tr></thead><tbody>${Object.entries(PERMISSIONS).map(([k, v]) => `<tr><td>${esc(v.label)}</td>${R.map(r => `<td>${v.roles.includes(r) ? `<span class="yes">✓</span>` : `<span class="no-ic">—</span>`}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="bd small muted">Separation of duties: ${PL.config.allowSelfApproval ? "<b>self-approval is currently allowed for testing</b>." : "a reviewer can never approve a case they are assigned to or submitted."} Analysts can change only cases they created or are assigned to.</div></div>`;
  }
  if (tab === "integrations") {
    const lim = PL.sample ? await PL.sample.limits?.().catch(() => null) : null, st = PL.assets ? await PL.assets.list().catch(() => null) : null;
    b.innerHTML = `<div class="split"><div class="stack"><div class="card"><div class="hd"><h3>AI assistance</h3><span class="chip ${PL.sample ? "sup" : "grey"} right">${PL.sample ? "Available" : "AI not configured"}</span></div><div class="bd">
      ${PL.sample ? `<p>Claude through claude.ai, on each analyst's own account. No API key is stored in this page.</p><dl class="kv"><dt>Prompt version</dt><dd class="mono">${PROMPT_VERSION}</dd><dt>Images per request</dt><dd>${lim?.images?.maxCount ?? "—"}</dd></dl><p class="small muted">Nothing is sent until an analyst previews the request and confirms. Replies are checked against a fixed schema; replies citing evidence that does not exist are rejected.</p>` : `<p>AI not configured${LOCAL ? " in the no-install edition: there is no server to keep an API key safe, so nothing is ever sent to a cloud service from here. Use the team edition for cloud AI." : " for this view."} Every local verification feature still works.</p>`}</div></div>
      <div class="card"><div class="hd"><h3>Reading text in images</h3></div><div class="bd"><p class="small">The offline OCR engine of the full AIVS app cannot run inside a hosted page. Here, visible text is typed by the analyst or transcribed by Claude after confirmation; the first transcription is kept unchanged alongside corrections.</p></div></div></div>
      <div class="stack"><div class="card"><div class="hd"><h3>Storage</h3></div><div class="bd"><dl class="kv"><dt>Records</dt><dd>Shared database of this page (cases, archive, reports, versions)</dd><dt>Files</dt><dd>${st ? `${st.usage.files} file(s), ${kb(st.usage.bytes)} of ${kb(st.usage.maxBytes)}` : "Visible to editors only"}</dd><dt>Your access</dt><dd>${PL.canWrite === false ? "View only" : "Can write shared records"}${PL.assets ? " · can upload files" : ""}</dd></dl></div></div></div></div>`;
  }
  if (tab === "audit") {
    const cases = await Svc.listCases(App.training);
    b.innerHTML = `<div class="card"><div class="hd"><h3>Case audit trails</h3><span class="small sub right">Each case keeps a hash-chained trail; editing or removing an entry breaks the chain.</span></div><div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th class="n">Entries</th><th>Last change</th><th>Integrity</th></tr></thead><tbody>${cases.map(c => `<tr><td><a href="#/case/${esc(c.id)}/history">${esc(c.id)}</a> · ${esc(c.title)}</td><td class="n">${c.audit.length}</td><td class="small">${esc(c.audit.at(-1)?.action || "")}<div class="tiny sub">${fmtDT(c.audit.at(-1)?.at)}</div></td><td data-ver="${esc(c.id)}"><span class="spin"></span></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No cases.</td></tr>`}</tbody></table></div></div>`;
    for (const c of cases) { const r = await verifyCaseChain(c), td = $(`[data-ver="${CSS.escape(c.id)}"]`); if (td) td.innerHTML = r.ok ? `<span class="chip sup">Intact · ${r.checked}</span>` : `<span class="chip con">Broken at entry ${r.brokenAt + 1}</span>`; }
  }
  if (tab === "training") {
    const n = (await Svc.listCases(true)).length, na = (await Svc.listArchive(true, true)).length;
    b.innerHTML = `<div class="card"><div class="hd"><h3>Training data</h3></div><div class="bd"><p>Three synthetic practice cases (TR-…) and two synthetic archive records (TA-…). They are flagged as training, appear only when <b>Training</b> is selected at the top, never match operational cases, and are excluded from operational dashboards and reports.</p>
      <p class="small muted">Currently loaded: ${n} training case(s), ${na} training archive record(s).</p><button class="btn primary" id="seed" ${n || !can("settings.manage") ? "disabled" : ""}>${n ? "Training data already loaded" : "Load training cases"}</button></div></div>`;
    $("#seed").onclick = async () => { const x = $("#seed"); x.disabled = true; x.innerHTML = '<span class="spin"></span> Loading…'; try { await seedTraining(); toast("Training cases loaded. Switch to Training at the top to see them."); pageAdmin(el, ["training"]); } catch (e) { fail(e); x.disabled = false; x.textContent = "Load training cases"; } };
  }
}
const fetchFile = async (url, name) => { const r = await fetch(url); if (!r.ok) throw new AppError(`Training file ${name} could not be read.`); const b = await r.blob(); return new File([b], name, { type: b.type }); };
async function seedTraining() {
  if ((await Svc.listCases(true)).length) throw new AppError("Training cases already exist.");
  for (const a of TRAINING.archive) await Svc.createArchive(a, { file: await fetchFile(a.url, a.file), assetUrl: LOCAL ? undefined : a.url, training: true });
  const rx = new Date(Date.now() - 2 * 3600e3).toISOString();
  for (const c of TRAINING.cases) { const id = await Svc.createCase({ ...c, received_at: rx, is_training: true }); await Svc.addMedia(id, await fetchFile(c.url, c.file), { assetUrl: LOCAL ? undefined : c.url }); }
}


// ---------------------------------------------------------------- Start page: the eight modules with honest statuses
const MODSTATUS = { available: ["Available", "sup"], partial: ["Partly available", "warn"], planned: ["Planned", "grey"], off: ["Not available here", "grey"] };
function startModules() {
  const admin = can("settings.manage"), ai = !!PL.sample, where = LOCAL ? "this file" : "this page";
  return [
    { key: "verify", icon: "verify", title: "Verify information", text: "Paste a claim or text. AIVS keeps the original exactly as received and splits it into separate claims, marking opinions, predictions, satire, questions and calls to share.",
      status: "partial", href: can("case.create") ? "#/verify" : null, cta: "Start verifying", missing: `Retrieving and archiving a web page from a link needs the AIVS team edition (it runs a server that fetches pages safely). In ${where}, paste the page's text and add the link as the source.` },
    { key: "upload", icon: "upload", title: "Upload files", text: `Images and video: fingerprints, archive matching, metadata${LOCAL ? ", offline text reading (English and Kiswahili)" : ""} and video frames.`,
      status: "partial", href: can("case.create") ? "#/new" : null, cta: "Upload images or video", missing: "PDF and document text extraction, and speech-to-text for video, are planned for Phase 5." },
    { key: "social", icon: "social", title: "Social media analysis", text: "Verify an individual public post: paste its text, and add screenshots, images or video.",
      status: "partial", href: can("case.create") ? "#/verify" : null, cta: "Check a post", missing: "Account and network analysis of sets of posts is planned for Phase 4, using post data you are permitted to use." },
    { key: "assistant", icon: "chat", title: "AI research assistant", text: ai ? "Inside each case, AI assistance sends only the material you choose to Claude, after you confirm, and checks every reply against the case evidence." : `${LOCAL ? "This file works offline, so it has no AI service." : "AI assistance is not available to you on this page."} Everything else works without it.`,
      status: ai ? "partial" : "off", href: ai ? "#/cases" : null, cta: ai ? "Open a case" : null, missing: "A conversational assistant that keeps context across an investigation, in English and Kiswahili, is planned for Phase 2." },
    { key: "monitor", icon: "monitor", title: "Information operations monitor", text: "Look for signs of coordination in sets of public posts: near-identical messages, synchronised timing, sudden bursts and shared hashtags. Signals to investigate, never proof.",
      status: "planned", phase: 4, missing: "Planned for Phase 4. It will analyse post datasets that you import yourself and show timelines and network diagrams. It will not attribute activity to any person, group or state." },
    { key: "reports", icon: "reports", title: "Reports", text: "Approved reports are frozen with a fingerprint. Download them as HTML (print to PDF from your browser) or JSON.", status: "available", href: "#/reports", cta: "View reports" },
    { key: "data", icon: "data", title: "Training and datasets", text: "Synthetic training cases kept apart from real ones, and a reference archive of documented images.",
      status: "partial", act: "training", cta: "Open training cases", missing: "A dataset registry (published fact-checks with their licences, versioning and evaluation splits) is planned for Phase 3. Evidence will come from retrieval of those records before any model training." },
    { key: "settings", icon: "admin", title: "Settings", text: LOCAL ? "Your name, backup and storage, and training data." : admin ? "People and roles, integrations, audit trail and training data." : "Guided or advanced mode (top of the page).",
      status: "available", href: admin || LOCAL ? "#/admin" : null, cta: admin || LOCAL ? "Open settings" : null }
  ];
}
async function pageHome(el) {
  crumbs(`<b>Start</b>${App.training ? " · training records" : ""}`);
  const M = startModules(), first = String(PL.me?.name || "").split(" ")[0];
  const cases = await Svc.listCases(App.training).catch(() => []), open = cases.filter(c => !["approved", "archived", "awaiting_approval"].includes(c.status)).length, waiting = cases.filter(c => c.status === "awaiting_approval").length;
  el.innerHTML = `<div class="pagehead"><div><h1>${first ? `Welcome, ${esc(first)}` : "Welcome"}</h1><p>AIVS helps you check claims, images and video against evidence, record what remains uncertain, and produce reports that a second person reviews. It never declares something false because it is controversial.</p></div></div>
    ${App.guided() ? `<div class="card"><div class="bd"><div class="howto">
      <div><span class="hn">1</span><b>Bring the content</b><span class="small muted">Paste a claim or text, or upload the image or video.</span></div>
      <div><span class="hn">2</span><b>Review what AIVS finds</b><span class="small muted">Separate claims, earlier copies of images, dates, and leads to follow up.</span></div>
      <div><span class="hn">3</span><b>Decide with evidence</b><span class="small muted">Assess each claim, explain why, and send it for review.</span></div></div>
      ${can("case.create") ? `<div class="row" style="margin-top:14px"><a class="btn primary" href="#/verify">${icon("verify")} Verify information</a><a class="btn" href="#/new">${icon("upload")} Upload image or video</a><a class="btn ghost" href="#/search">${icon("search")} Has this image been seen before?</a></div>` : ""}</div></div>` : ""}
    ${open || waiting ? `<div class="callout info" style="margin-bottom:14px"><div>${open ? `<a href="#/cases?status=open">${open} open case${open > 1 ? "s" : ""}</a>` : ""}${open && waiting ? " · " : ""}${waiting ? `<a href="#/review">${waiting} waiting for review</a>` : ""}. <a href="#/dashboard">Open the dashboard</a> for figures and activity.</div></div>` : ""}
    <div class="modules">${M.map(m => `<div class="module ${m.status}"><div class="mtop"><span class="mic">${icon(m.icon)}</span><span class="chip ${MODSTATUS[m.status][1]}">${MODSTATUS[m.status][0]}${m.phase ? ` · Phase ${m.phase}` : ""}</span></div>
      <h3>${esc(m.title)}</h3><p class="small">${m.text}</p>
      <div class="row mfoot">${m.cta && (m.href || m.act) ? `<a class="btn sm ${m.status === "available" ? "primary" : ""}" ${m.href ? `href="${m.href}"` : `href="#/cases" data-act="${m.act}"`}>${esc(m.cta)}</a>` : ""}${m.missing ? `<button class="btn sm ghost" data-more="${m.key}">${m.status === "planned" ? "What it will do" : "What is not ready yet"}</button>` : ""}</div></div>`).join("")}</div>
    <p class="tiny sub" style="margin-top:14px">Statuses describe ${LOCAL ? "this file" : "this page"} as it is now. Nothing marked planned is simulated. <a href="#/privacy">How data is handled</a></p>`;
  $$("[data-more]").forEach(b => b.onclick = () => { const m = M.find(x => x.key === b.dataset.more); modal(m.title, `<p>${m.missing}</p>`); });
  $$('[data-act="training"]').forEach(a => a.addEventListener("click", () => { App.scope = "training"; try { sessionStorage.setItem("aivs-scope", "training"); } catch {} shell(); }, true));
}

// ---------------------------------------------------------------- Verify information (text)
const VTYPE = { factual: ["checkable statement", "teal"], opinion: ["opinion", "warn"], prediction: ["prediction", "warn"], satire: ["satire or humour", "warn"], question: ["question", "warn"], appeal: ["call to action", "warn"] };
const VSAMPLES = [
  ["Practice: health rumour (English)", "BREAKING: The Ministry of Health has confirmed that drinking hot lemon water every hour cures malaria. Clinics in Kisumu have stopped giving medicine since last week. Share before they delete this!"],
  ["Practice: job scam (Kiswahili)", "TANGAZO: Wizara ya Ulinzi inaajiri vijana 5,000 mwezi huu. Tuma Sh1,500 kwa M-Pesa namba 0712 345 678 ili kusajiliwa. Nafasi ni chache, tuma leo!"],
  ["Practice: opinion and prediction", "I think the new road in Garissa is the worst project ever built. Prices of fuel will rise by 2030. The road was opened in March 2024 by the county government."]
];
async function pageVerify(el) {
  if (!can("case.create")) { el.innerHTML = `<div class="callout warn"><div>Your role can read cases but cannot start new ones.</div></div>`; return; }
  crumbs(`<b>Verify information</b>${App.training ? " · training records" : ""}`);
  el.innerHTML = `<div class="pagehead"><div><h1>Verify information</h1><p>Paste what you want to check. AIVS creates a case, keeps the original exactly as received, and splits it into separate claims for you to assess.</p></div></div>
    <div class="split"><div class="stack"><div class="card"><div class="bd">
      <label class="f" for="vi" style="margin-top:0">Claim or text <span class="req">*</span></label>
      <textarea id="vi" rows="8" maxlength="20000" placeholder="Paste a post, a message or part of an article"></textarea>
      <div class="hint">Links: open the page yourself and paste its text. Retrieving and archiving pages automatically needs the AIVS team edition.</div>
      <div class="grid g2"><div><label class="f" for="vt">Title (optional)</label><input type="text" id="vt" maxlength="200" placeholder="AIVS suggests one if left empty"></div>
        <div><label class="f" for="vp">Priority</label><select id="vp"><option value="routine">Routine</option><option value="priority">Priority</option><option value="urgent">Urgent</option></select></div></div>
      ${App.training ? `<div class="callout train" style="margin-top:12px"><div>You are viewing Training records: this becomes a training case (TR-…), kept apart from real cases.</div></div>` : ""}
      <div id="verr" class="callout bad" style="margin-top:12px" hidden></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="vgo">Analyze</button><span id="vprog" class="small muted" aria-live="polite"></span></div>
      <details id="vsamp" style="margin-top:14px"><summary class="small sub">Try a practice text (invented examples)</summary><div class="row" style="margin-top:8px">${VSAMPLES.map(([l], i) => `<button class="btn sm ghost" data-sample="${i}">${esc(l)}</button>`).join("")}</div></details>
    </div></div></div>
    <div class="stack"><div class="card"><div class="hd"><h3>What happens</h3></div><div class="bd small">
      <ol style="margin:0 0 0 18px;line-height:1.7"><li>A case is created and the text is preserved as received.</li><li>The text is split into separate claims. Opinions, predictions, satire, questions and calls to share are flagged, because they cannot be shown true or false.</li><li>You review, assess each claim with evidence, and send the conclusion for review.</li></ol>
      <div class="callout info" style="margin-top:10px"><div>AIVS does not decide what is true. Automated steps produce suggestions and leads. Each conclusion is made by an analyst${LOCAL ? "" : " and approved by a second person"}.</div></div></div></div></div></div>
    <div id="vres" style="margin-top:14px"></div>`;
  const input = $("#vi"), err = $("#verr");
  $$("[data-sample]").forEach(b => b.onclick = () => { input.value = VSAMPLES[+b.dataset.sample][1]; $("#vt").value = VSAMPLES[+b.dataset.sample][0]; input.focus(); });
  $("#vgo").onclick = async () => {
    const v = input.value.trim();
    if (!v) { err.hidden = false; err.textContent = "Paste a claim or some text first."; input.focus(); return; }
    err.hidden = true; const b = $("#vgo"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Working…'; $("#vprog").textContent = "Creating the case and splitting it into claims…";
    try {
      const c = await Svc.verify({ input: v, title: $("#vt").value.trim() || undefined, priority: $("#vp").value, training: App.training }), cl = c.claims.filter(x => !x.removed);
      navCounts();
      $("#vres").innerHTML = `<div class="card"><div class="hd"><h3>Case ${esc(c.id)} created</h3><span class="chip sup right">${cl.length} claim${cl.length === 1 ? "" : "s"} found</span></div><div class="bd">
        <ol class="claimlist">${cl.map(x => `<li><span>${esc(x.text)}</span> <span class="chip ${VTYPE[x.claim_type]?.[1] || "grey"}">${VTYPE[x.claim_type]?.[0] || esc(x.kind)}</span></li>`).join("") || `<li class="muted">No separate claims were found. Open the case and add them yourself.</li>`}</ol>
        <div class="row" style="margin-top:12px"><a class="btn primary" href="#/case/${esc(c.id)}/claims">Open the case</a><a class="btn" href="#/case/${esc(c.id)}/media">Add images or video</a><button class="btn ghost" id="vagain">Verify something else</button></div></div></div>`;
      $("#vagain").onclick = () => { input.value = ""; $("#vt").value = ""; $("#vres").innerHTML = ""; input.focus(); };
      $("#vres").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { err.hidden = false; err.textContent = errMsg(e); }
    finally { $("#vprog").textContent = ""; b.disabled = false; b.textContent = "Analyze"; }
  };
}

// ---------------------------------------------------------------- privacy notice
async function pagePrivacy(el) {
  crumbs(`<b>How data is handled</b>`);
  el.innerHTML = `<div class="pagehead"><div><h1>How AIVS handles data</h1><p>This describes ${LOCAL ? "the no-install file on this computer" : "this claude.ai page"} as it works now.</p></div></div><div class="card"><div class="bd prose">
    <h3>Where it is stored</h3>${LOCAL ? `<p>Everything (cases, files, notes, reports) is saved in this browser on this computer (IndexedDB). It is not sent anywhere. Clearing the browser's site data deletes it, so export backups regularly (Settings → Backup and storage).</p>`
      : `<p>Cases, files, notes and reports are kept in this page's shared storage on claude.ai. Everyone the owner has shared the page with can read them; people with Contributor access can change them.</p>`}
    <h3>Identity</h3><p>${LOCAL ? "There is no sign-in. The name you typed is shown on your work but is not a verified identity, and acknowledgements made here are labelled as local." : "People are identified by their claude.ai accounts. Roles (analyst, reviewer, administrator) are set by the page owner. Role checks run in the page itself; for strict separation of duties use the AIVS team edition, which enforces them on a server."}</p>
    <h3>What leaves ${LOCAL ? "this computer" : "this page"}</h3><ul>
      <li><b>AI assistance:</b> ${PL.sample ? "case material is sent to Claude only when you preview it and confirm." : "not available here, so nothing is sent to an AI service."}</li>
      <li><b>Search the web</b> for an image: you upload the image to the outside service yourself; AIVS sends nothing.</li>
      <li>Everything else, including image matching${LOCAL ? " and reading text in images" : ""}, runs in your browser.</li></ul>
    <h3>Personal information</h3><p>Material under investigation can contain personal information about other people. Enter only what the investigation needs, and delete cases you no longer need.</p></div></div>`;
}

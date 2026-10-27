import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { esc, status, concl, pri, ago, empty, CONCL } from "../ui.js";

export async function render(el, args = [], opts = {}) {
  crumbs(`<b>Dashboard</b>${App.training ? " · training records" : ""}`);
  const d = await api.get(`/api/dashboard?${App.q()}`), c = d.counts;
  const open = c.draft + c.analysing + c.analysis_failed + c.analyst_review + (c.needs_evidence || 0);
  const list = (rows, none) => rows.length ? `<ul class="mini">${rows.map(r => `<li><a href="#/case/${esc(r.id)}">${esc(r.id)}</a><span style="min-width:0;flex:1">${esc(r.title)}<div class="tiny sub">${r.assigned ? `Assigned to ${esc(r.assigned)} · ` : "Unassigned · "}updated ${ago(r.updated_at)}</div></span>${pri(r.priority)} ${status(r.status)}</li>`).join("")}</ul>` : `<p class="muted small">${esc(none)}</p>`;
  const totalApproved = d.conclusions.reduce((a, b) => a + b.n, 0);
  el.innerHTML = `
  <div class="pagehead"><div><h1>Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}, ${esc(App.me.display_name.split(" ")[0])}</h1>
    <p>${App.training ? "Training records only. These figures never include operational cases." : "Figures are counted live from the case records. Training cases are excluded."}</p></div>
    <div class="actions">${App.can("case.create") ? `<a class="btn primary" href="#/new">+ New case</a>` : ""}</div></div>
  ${d.total === 0 ? `<div class="card"><div class="bd">${empty(App.training ? "No training cases loaded" : "No cases yet",
      App.training ? "An administrator can load the synthetic training cases from Administration → Training data." : "Create the first case to start a verification. Cases you and your team create will appear here with their status.",
      App.training ? (App.can("settings.manage") ? `<a class="btn primary" href="#/admin/training">Load training cases</a>` : "") : (App.can("case.create") ? `<a class="btn primary" href="#/new">Create a case</a>` : ""))}</div></div>` : `
  <div class="kpis">
    <a class="kpi" href="#/cases?status=draft,analysing,analysis_failed,analyst_review,needs_evidence,awaiting_approval"><div class="l">Open cases</div><div class="v">${open}</div><div class="tiny sub">${c.draft} draft · ${c.analyst_review} under investigation · ${c.needs_evidence || 0} need evidence</div></a>
    <a class="kpi attn" href="#/review"><div class="l">Awaiting review</div><div class="v">${c.awaiting_approval}</div><div class="tiny sub">Reviewer decision needed</div></a>
    <a class="kpi ${d.urgentOpen ? "alert" : ""}" href="#/cases?priority=urgent&status=draft,analysing,analysis_failed,analyst_review,needs_evidence,awaiting_approval"><div class="l">Urgent and open</div><div class="v">${d.urgentOpen}</div><div class="tiny sub">Marked urgent, not yet approved</div></a>
    <a class="kpi ${c.analysis_failed ? "alert" : ""}" href="#/cases?status=analysis_failed"><div class="l">Analysis failures</div><div class="v">${c.analysis_failed}</div><div class="tiny sub">Need a retry</div></a>
    <a class="kpi" href="#/reports"><div class="l">Approved</div><div class="v">${c.approved + c.archived}</div><div class="tiny sub">${c.archived} archived · ${d.archive} archive records</div></a>
  </div>
  <div class="dash">
    <div class="stack">
      ${d.returned.length ? `<div class="card attn-card"><div class="hd"><h3>Needs additional evidence (returned by a reviewer)</h3></div><div class="bd">${list(d.returned, "")}</div></div>` : ""}
      ${d.processing.length ? `<div class="card"><div class="hd"><h3>Processing now</h3><span class="chip info right"><span class="spin"></span> ${d.processing.length} analysing</span></div><div class="bd">${list(d.processing, "")}</div></div>` : ""}
      <div class="card"><div class="hd"><h3>Assigned to you</h3><a class="btn ghost sm right" href="#/cases?assigned=me&status=draft,analysing,analysis_failed,analyst_review,needs_evidence,awaiting_approval">All yours</a></div><div class="bd">${list(d.mine, "Nothing assigned to you is open.")}</div></div>
      <div class="card"><div class="hd"><h3>Awaiting approval</h3><a class="btn ghost sm right" href="#/review">Review queue</a></div><div class="bd">${list(d.awaiting, "No assessments are waiting for a reviewer.")}</div></div>
      ${d.failed.length ? `<div class="card"><div class="hd"><h3>Analysis failed</h3></div><div class="bd">${list(d.failed, "")}</div></div>` : ""}
    </div>
    <div class="stack">
      <div class="card"><div class="hd"><h3>Approved conclusions</h3></div><div class="bd">${totalApproved ? `<div class="bars">${["contradicted", "mixed", "supported", "insufficient"].map(k => { const n = d.conclusions.find(x => x.conclusion === k)?.n || 0; return `<div class="bar"><span>${CONCL[k][0]}</span><div class="track"><div class="fill" style="width:${(n / totalApproved * 100).toFixed(1)}%;background:var(--${CONCL[k][1]})"></div></div><span class="num">${n}</span></div>`; }).join("")}</div>` : `<p class="muted small">No approved assessments yet.</p>`}</div></div>
      <div class="card"><div class="hd"><h3>Recently updated cases</h3><a class="btn ghost sm right" href="#/cases?">All cases</a></div><div class="bd">${list(d.recent, "No cases yet.")}</div></div>
      <div class="card"><div class="hd"><h3>Recent activity</h3></div><div class="bd">${d.activity.length ? `<ul class="mini">${d.activity.map(a => `<li><span class="tiny sub" style="width:76px;flex:none">${ago(a.at)}</span><span style="min-width:0"><b>${esc(a.username)}</b> · ${esc(a.action)} · <a href="#/case/${esc(a.entity_id)}">${esc(a.entity_id)}</a></span></li>`).join("")}</ul>` : `<p class="muted small">No activity yet.</p>`}</div></div>
    </div>
  </div>`}`;
  if (d.processing?.length) setTimeout(() => { if (opts.isCurrent?.()) render(el, args, opts).catch(() => {}); }, 3000);
}

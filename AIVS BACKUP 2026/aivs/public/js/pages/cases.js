import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, status, concl, pri, ago, empty, fail, toast, STATUS, CONCL } from "../ui.js";

let F = { q: "", status: "", priority: "", conclusion: "", assigned: "" };
export async function render(el, [qs]) {
  crumbs(`<b>Cases</b>`);
  // links such as #/cases?status=analysis_failed (dashboard tiles) set the filters they name
  if (qs !== undefined) { const p = new URLSearchParams(qs); F = { q: p.get("q") || "", status: p.get("status") || "", priority: p.get("priority") || "", conclusion: p.get("conclusion") || "", assigned: p.get("assigned") || "" }; }
  const canAssign = App.can("case.assign"), staff = App.meta.users.filter(u => u.role !== "viewer");
  el.innerHTML = `<div class="pagehead"><div><h1>Cases</h1><p>Search, filter and assign verification cases.</p></div>
    <div class="actions">${App.can("case.create") ? `<a class="btn primary" href="#/new">+ New case</a>` : ""}</div></div>
    <div class="card"><div class="hd" style="gap:8px">
      <input type="search" id="fq" placeholder="Search ID, title, text or source" style="max-width:280px" value="${esc(F.q)}" aria-label="Search cases">
      <select id="fs" style="max-width:190px" aria-label="Status"><option value="">All statuses</option><option value="draft,analysing,analysis_failed,analyst_review,needs_evidence,awaiting_approval">All open</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <select id="fp" style="max-width:140px" aria-label="Priority"><option value="">Any priority</option><option value="urgent">Urgent</option><option value="priority">Priority</option><option value="routine">Routine</option></select>
      <select id="fc" style="max-width:180px" aria-label="Conclusion"><option value="">Any conclusion</option>${Object.entries(CONCL).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select>
      <select id="fa" style="max-width:180px" aria-label="Assigned"><option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>${staff.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select>
    </div><div id="list"><div class="empty"><span class="spin"></span></div></div></div>`;
  for (const [id, k] of [["fs", "status"], ["fp", "priority"], ["fc", "conclusion"], ["fa", "assigned"]]) { $("#" + id).value = F[k]; $("#" + id).onchange = e => { F[k] = e.target.value; load(); }; }
  let t; $("#fq").oninput = e => { clearTimeout(t); t = setTimeout(() => { F.q = e.target.value.trim(); load(); }, 250); };
  async function load() {
    const qs = new URLSearchParams(Object.entries(F).filter(([, v]) => v)).toString();
    const { cases } = await api.get(`/api/cases?${App.q(qs)}`);
    const filtered = Object.values(F).some(Boolean);
    $("#list").innerHTML = cases.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th>Title</th><th>Status</th><th>Priority</th><th>Assigned</th><th class="n">Media</th><th class="n">Claims</th><th>To review</th><th>Updated</th></tr></thead><tbody>
      ${cases.map(c => `<tr class="click" data-id="${esc(c.id)}"><td class="mono">${esc(c.id)}${c.revision > 1 ? `<div class="tiny sub">rev ${c.revision}</div>` : ""}</td>
        <td style="min-width:220px"><b>${esc(c.title)}</b><div class="tiny sub">${esc(c.source_platform)} · received ${ago(c.received_at)}</div></td>
        <td>${status(c.status)} ${concl(c.conclusion)}</td><td>${pri(c.priority)}</td>
        <td>${canAssign && !["approved", "archived"].includes(c.status) ? `<select class="assign" data-id="${esc(c.id)}" aria-label="Assign ${esc(c.id)}" style="padding:4px 6px;font-size:12.5px;min-width:140px"><option value="">Unassigned</option>${staff.map(u => `<option value="${u.id}" ${u.id === c.assigned_to ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>` : esc(c.assigned || "Unassigned")}</td>
        <td class="n">${c.media_count}</td><td class="n">${c.claims}</td><td>${c.pending ? `<span class="chip warn">${c.pending} suggestion${c.pending > 1 ? "s" : ""}</span>` : ""}</td><td class="small sub">${ago(c.updated_at)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="bd">${empty(filtered ? "No cases match these filters" : "No cases yet", filtered ? "Clear a filter or search for something else." : "Cases you create appear here.", !filtered && App.can("case.create") ? `<a class="btn primary" href="#/new">Create a case</a>` : "")}</div>`;
    $$("tr.click").forEach(r => r.onclick = e => { if (!e.target.closest("select")) App.go(`#/case/${r.dataset.id}`); });
    $$(".assign").forEach(s => s.onchange = async () => { try { await api.post(`/api/cases/${s.dataset.id}/assign`, { user_id: s.value ? +s.value : null }); toast(`${s.dataset.id} assigned.`); } catch (e) { fail(e); load(); } });
  }
  await load();
}

import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { esc, concl, status, fmtDT, ago, empty } from "../ui.js";

export async function render(el) {
  crumbs(`<b>Reports</b>`);
  const d = await api.get(`/api/reports?${App.q()}`);
  el.innerHTML = `<div class="pagehead"><div><h1>Reports</h1><p>Approved reports are frozen when approved and carry a SHA-256 fingerprint of their content. Drafts change as analysts work.</p></div></div>
  <div class="card"><div class="hd"><h3>Approved reports</h3><span class="chip teal">${d.approved.length}</span></div>
  ${d.approved.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Report</th><th>Case</th><th>Conclusion</th><th>Approved</th><th>SHA-256</th><th>Export</th></tr></thead><tbody>
    ${d.approved.map(r => `<tr><td class="mono">${esc(r.id)}</td><td><a href="#/case/${esc(r.case_id)}">${esc(r.case_id)}</a> · ${esc(r.title)}<div class="tiny sub">Revision ${r.revision}</div></td><td>${concl(r.conclusion)}</td>
      <td class="small">${esc(r.approved_by || "—")}<div class="tiny sub">${fmtDT(r.created_at)}</div></td><td class="mono tiny" title="${esc(r.sha256)}">${esc(r.sha256.slice(0, 16))}…</td>
      <td><div class="row"><a class="btn sm" href="/api/reports/${esc(r.id)}.html" target="_blank" rel="noopener">View</a><a class="btn sm ghost" href="/api/reports/${esc(r.id)}.html?download=1">HTML</a><a class="btn sm ghost" href="/api/reports/${esc(r.id)}.json?download=1">JSON</a></div></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="bd">${empty("No approved reports yet", "A report is created automatically when a reviewer approves an assessment.")}</div>`}</div>
  <div class="card"><div class="hd"><h3>Drafts in progress</h3><span class="chip grey">${d.drafts.length}</span></div>
  ${d.drafts.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th>Status</th><th>Analyst</th><th>Updated</th><th></th></tr></thead><tbody>
    ${d.drafts.map(r => `<tr><td><a href="#/case/${esc(r.case_id)}">${esc(r.case_id)}</a> · ${esc(r.title)}</td><td>${status(r.status)}</td><td>${esc(r.assigned || "—")}</td><td class="small sub">${ago(r.updated_at)}</td>
      <td><div class="row"><a class="btn sm" href="/api/cases/${esc(r.case_id)}/report.html" target="_blank" rel="noopener">Preview draft</a><a class="btn sm ghost" href="#/case/${esc(r.case_id)}/report">Open</a></div></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="bd">${empty("No drafts in progress", "Cases in analyst review or awaiting approval appear here.")}</div>`}</div>`;
}

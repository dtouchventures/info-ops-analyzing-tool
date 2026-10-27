import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $$, esc, concl, pri, ago, empty, fmtDT, status, STATUS, ASSESS } from "../ui.js";

const QUEUES = ["awaiting_approval", "analyst_review", "needs_evidence", "approved", "rejected", "archived"];
export async function render(el, args, ctx) {
  crumbs(`<b>Review queue</b>`);
  const want = new URLSearchParams(location.hash.split("?")[1] || "").get("s"), st = QUEUES.includes(want) ? want : "awaiting_approval";
  const { cases } = await api.get(`/api/cases?${App.q(`status=${st}`)}`);
  if (st !== "awaiting_approval") {
    el.innerHTML = `<div class="pagehead"><div><h1>Review queue</h1><p>Cases by review status.</p></div></div>${tabs(st)}
    <div class="card">${cases.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th>Title</th><th>Status</th><th>Conclusion</th><th>Updated</th><th>Priority</th></tr></thead><tbody>${cases.map(c => `<tr class="click" data-id="${esc(c.id)}"><td class="mono">${esc(c.id)}</td><td><b>${esc(c.title)}</b></td><td>${status(c.status)}</td><td>${concl(c.conclusion)}</td><td class="small">${ago(c.updated_at)}</td><td>${pri(c.priority)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="bd">${empty(`No cases: ${STATUS[st]}`, "")}</div>`}</div>`;
    $$("tr.click").forEach(r => r.onclick = () => App.go(`#/case/${r.dataset.id}`)); return;
  }
  const full = await Promise.all(cases.map(c => api.get(`/api/cases/${c.id}`)));
  el.innerHTML = `<div class="pagehead"><div><h1>Review queue</h1><p>Assessments submitted by analysts and waiting for an independent reviewer. A reviewer cannot decide a case they analysed or submitted.</p></div></div>${tabs(st)}
  <div class="card">${full.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th>Title</th><th>Proposed conclusion</th><th>Claims</th><th>Submitted</th><th>Priority</th><th></th></tr></thead><tbody>
    ${full.map(a => { const c = a.case, cl = a.claims.filter(x => !x.removed); return `<tr class="click" data-id="${esc(c.id)}"><td class="mono">${esc(c.id)}</td><td><b>${esc(c.title)}</b><div class="tiny sub">Analyst: ${esc(c.assigned?.name || "—")}</div></td>
      <td>${concl(c.conclusion)}</td><td class="small">${Object.keys(ASSESS).filter(k => k !== "unassessed").map(s => [s, cl.filter(x => x.assessment === s).length]).filter(([, n]) => n).map(([s, n]) => `${n} ${ASSESS[s][0].toLowerCase()}`).join(" · ")}</td>
      <td class="small">${esc(c.submitter?.name || "—")}<div class="tiny sub">${fmtDT(c.submitted_at)}</div></td><td>${pri(c.priority)}</td>
      <td>${a.perms.approve ? `<a class="btn primary sm" href="#/case/${esc(c.id)}/report">Review</a>` : `<span class="chip grey" title="Separation of duties">${a.perms.ownWork ? "Your own work" : "View only"}</span>`}</td></tr>`; }).join("")}</tbody></table></div>`
    : `<div class="bd">${empty("Nothing is waiting for approval", "When an analyst submits an assessment it appears here for a reviewer.")}</div>`}</div>`;
  $$("tr.click").forEach(r => r.onclick = e => { if (!e.target.closest("a")) App.go(`#/case/${r.dataset.id}/report`); });
}
function tabs(st) { return `<nav class="tabs" aria-label="Review status" style="margin-bottom:12px">${QUEUES.map(k => `<a href="#/review?s=${k}" class="${k === st ? "on" : ""}">${STATUS[k]}</a>`).join("")}</nav>`; }

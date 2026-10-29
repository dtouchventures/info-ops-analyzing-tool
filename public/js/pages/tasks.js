import { reverseImageHtml } from "../lib/reverseview.js";
import { api, newTaskKey } from '../api.js';
import { crumbs } from '../app.js';
import { esc, fmtDT } from '../ui.js';

const LABEL = { analysis: 'Evidence analysis', collection: 'Evidence collection', verification: 'AI verification', report: 'Report generation' };
export async function render(el, _args, { isCurrent }) {
  crumbs('<b>Background tasks</b>');
  el.innerHTML = '<div class="pagehead"><div><h1>Background tasks</h1><p>Submitted work continues on the server while you use other pages. Wait until each upload has finished before leaving. Procedures using the same case may queue to protect its records. Your tasks remain available after refreshing or signing in again.</p><div class="row" style="flex-wrap:wrap"><a class="btn sm" href="#/reverse-image">New image search</a><a class="btn sm" href="#/reverse-video">New video search</a><a class="btn sm ghost" href="#/investigate">New investigation</a><a class="btn sm ghost" href="#/monitor">Social media analysis</a><a class="btn sm ghost" href="#/live">Live monitoring</a><a class="btn sm ghost" href="#/watch">AI Watchlist</a></div></div></div><div id="taskConnection" role="status"></div><div id="taskList" aria-live="polite">Loading…</div>';
  const panel = el.querySelector('#taskList'); let lastData = '';
  async function update() {
    if (!isCurrent() || !panel.isConnected) return;
    try {
      const data = await api.get('/api/tasks');
      if (!isCurrent() || !panel.isConnected) return;
      el.querySelector('#taskConnection').textContent = '';
      const signature = JSON.stringify(data);
      if (signature === lastData) {
        setTimeout(update, 1500);
        return;
      }
      lastData = signature;
      panel.innerHTML = data.tasks.length ? data.tasks.map(t => `<article class="card" style="margin-bottom:12px"><div class="bd"><div class="row"><h2>${esc(t.input?.reverse_image ? "Reverse image search" : LABEL[t.kind] || t.kind)} · Task ${t.id}</h2><span class="chip ${t.status === 'failed' ? 'warn' : t.status === 'completed' ? 'sup' : 'info'}">${esc(t.status_label)}</span><a href="#/case/${encodeURIComponent(t.case_id)}">${esc(t.case_id)}</a></div><p class="small sub">Requested ${fmtDT(t.created_at)} · Attempt ${t.attempts}</p>${t.error ? `<p role="status">${esc(t.error)}</p>` : ''}
        ${t.kind === 'collection' && t.result && !t.result.reverse_image ? `<p class="small">${(t.result.connectors || []).reduce((n, x) => n + (x.stored || 0), 0)} new evidence suggestions. <a href="#/case/${encodeURIComponent(t.case_id)}/evidence">Review evidence</a></p><ul class="small">${(t.result.connectors || []).map(c => `<li>${esc(c.label || c.key)}: ${c.errors?.length ? esc(c.errors.join("; ")) : !c.configured ? "Not configured" : `${c.results || 0} results, ${c.stored || 0} new suggestions`}</li>`).join("")}</ul>` : ''}
        ${reverseImageHtml(t.result?.reverse_image)}
        ${t.result?.official_check ? `<p class="small">Official KDF source check: ${t.result.official_check.checkable ? `${t.result.official_check.stored} evidence suggestion(s) saved. Read and compare the dated sources before classification.` : "No readable factual claim was available. Add the post text to check official sources."} <a href="#/case/${encodeURIComponent(t.case_id)}/evidence">Review official-source evidence</a></p>${t.result.official_check.connectors.flatMap(c => c.errors || []).map(e => `<p class="small" role="status">${esc(e)}</p>`).join("")}` : ""}
        ${t.input?.media_id ? `<p class="small">Image: ${esc(t.input.media_id)}</p>` : ""}
        ${t.status === 'failed' ? `<button class="btn sm" data-retry="${t.id}">Retry</button>` : t.status === 'completed' ? `<button class="btn sm" data-again="${t.id}">Run again</button>` : '<p class="small">You can leave this page. Results will be saved with the case.</p>'}
        ${t.kind === 'report' && t.status === 'completed' ? `<a class="btn sm" href="#/case/${encodeURIComponent(t.case_id)}/automatic">Open report</a>` : ''}</div></article>`).join('') : '<div class="card"><div class="bd">No case tasks yet. Start checks, evidence collection, AI verification or a report from a case.</div></div>';
      if (data.investigations?.length) panel.insertAdjacentHTML('beforeend', `<div class="card"><div class="hd"><h2>Automatic investigations</h2></div><div class="bd">${data.investigations.map(t => `<p><a href="#/investigate/${encodeURIComponent(t.id)}">${esc(t.report_id)}</a> · ${esc(t.status_label)}${t.stage ? ` · Stage: ${esc(t.stage)}` : ""}${t.subject ? ` · ${esc(t.subject)}` : ""}${t.case_id ? ` · ${esc(t.case_id)}` : ''}</p>`).join('')}</div></div>`);
      if (data.jobs?.length) panel.insertAdjacentHTML('beforeend', `<div class="card"><div class="hd"><h2>Other processing tasks</h2></div><div class="bd">${data.jobs.map(t => `<article style="margin-bottom:14px"><a href="${esc(t.href)}">${esc(t.kind)} · ${esc(t.id)}</a><span class="chip">${esc(t.status_label)}</span>${t.original_name ? `<p class="small">${esc(t.original_name)}</p>` : ""}${t.stage ? `<p class="small">Stage: ${esc(t.stage)}</p>` : ""}${Number.isFinite(t.progress) ? `<p class="small">Progress: ${Math.round(Math.max(0, Math.min(1,t.progress))*100)}%</p>` : ""}<p class="tiny sub">Requested ${fmtDT(t.created_at)}. Open to see progress and results.</p></article>`).join("")}</div></div>`);
      panel.querySelectorAll('[data-retry],[data-again]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try {
          if (b.dataset.retry) await api.post(`/api/tasks/${b.dataset.retry}/retry`);
          else { const t = data.tasks.find(t => t.id === +b.dataset.again); await api.post(`/api/cases/${encodeURIComponent(t.case_id)}/tasks`, { kind: t.kind, input: t.input, request_key: newTaskKey() }); }
          await update();
        } catch (e) { b.disabled = false; const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = e.message; b.after(error); }
      });
      setTimeout(update, 1500);
    } catch (e) { if (isCurrent() && panel.isConnected) { el.querySelector('#taskConnection').textContent = 'Progress connection interrupted. Reconnecting… ' + e.message; setTimeout(update, 3000); } }
  }
  await update();
}

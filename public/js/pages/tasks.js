import { reverseImageHtml } from "../lib/reverseview.js";
import { api, newTaskKey } from '../api.js';
import { crumbs } from '../app.js';
import { esc, fmtDT } from '../ui.js';

const LABEL = { analysis: 'Evidence analysis', collection: 'Evidence collection', verification: 'AI verification', report: 'Report generation' };
export async function render(el, _args, { isCurrent }) {
  crumbs('<b>Background tasks</b>');
  el.innerHTML = '<div class="pagehead"><div><h1>Background tasks</h1><p>Work continues on the server while you use other pages. Your tasks remain available after refreshing or signing in again.</p></div></div><div id="taskList" aria-live="polite">Loading…</div>';
  const panel = el.querySelector('#taskList'); let lastData = '';
  async function update() {
    if (!isCurrent() || !panel.isConnected) return;
    try {
      const data = await api.get('/api/tasks');
      if (!isCurrent() || !panel.isConnected) return;
      const signature = JSON.stringify(data);
      if (signature === lastData) {
        if (data.tasks.some(t => ['pending', 'processing'].includes(t.status)) || data.investigations?.some(t => ['Pending', 'Processing'].includes(t.status_label))) setTimeout(update, 1500);
        return;
      }
      lastData = signature;
      panel.innerHTML = data.tasks.length ? data.tasks.map(t => `<article class="card" style="margin-bottom:12px"><div class="bd"><div class="row"><h2>${esc(LABEL[t.kind] || t.kind)}</h2><span class="chip ${t.status === 'failed' ? 'warn' : t.status === 'completed' ? 'sup' : 'info'}">${esc(t.status_label)}</span><a href="#/case/${encodeURIComponent(t.case_id)}">${esc(t.case_id)}</a></div><p class="small sub">Requested ${fmtDT(t.created_at)} · Attempt ${t.attempts}</p>${t.error ? `<p role="status">${esc(t.error)}</p>` : ''}
        ${t.kind === 'collection' && t.result && !t.result.reverse_image ? `<p class="small">${(t.result.connectors || []).reduce((n, x) => n + (x.stored || 0), 0)} new evidence suggestions. <a href="#/case/${encodeURIComponent(t.case_id)}/evidence">Review evidence</a></p><ul class="small">${(t.result.connectors || []).map(c => `<li>${esc(c.label || c.key)}: ${c.errors?.length ? esc(c.errors.join("; ")) : !c.configured ? "Not configured" : `${c.results || 0} results, ${c.stored || 0} new suggestions`}</li>`).join("")}</ul>` : ''}
        ${reverseImageHtml(t.result?.reverse_image)}
        ${t.status === 'failed' ? `<button class="btn sm" data-retry="${t.id}">Retry</button>` : t.status === 'completed' ? `<button class="btn sm" data-again="${t.id}">Run again</button>` : '<p class="small">You can leave this page. Results will be saved with the case.</p>'}
        ${t.kind === 'report' && t.status === 'completed' ? `<a class="btn sm" href="#/case/${encodeURIComponent(t.case_id)}/automatic">Open report</a>` : ''}</div></article>`).join('') : '<div class="card"><div class="bd">No case tasks yet. Start checks, evidence collection, AI verification or a report from a case.</div></div>';
      if (data.investigations?.length) panel.insertAdjacentHTML('beforeend', `<div class="card"><div class="hd"><h2>Automatic investigations</h2></div><div class="bd">${data.investigations.map(t => `<p><a href="#/investigate/${encodeURIComponent(t.id)}">${esc(t.report_id)}</a> · ${esc(t.status_label)}${t.case_id ? ` · ${esc(t.case_id)}` : ''}</p>`).join('')}</div></div>`);
      panel.querySelectorAll('[data-retry],[data-again]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try {
          if (b.dataset.retry) await api.post(`/api/tasks/${b.dataset.retry}/retry`);
          else { const t = data.tasks.find(t => t.id === +b.dataset.again); await api.post(`/api/cases/${encodeURIComponent(t.case_id)}/tasks`, { kind: t.kind, input: t.input, request_key: newTaskKey() }); }
          await update();
        } catch (e) { b.disabled = false; const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = e.message; b.after(error); }
      });
      if (data.tasks.some(t => ['pending', 'processing'].includes(t.status)) || data.investigations?.some(t => ['Pending', 'Processing'].includes(t.status_label))) setTimeout(update, 1500);
    } catch (e) { if (isCurrent() && panel.isConnected) panel.textContent = e.message; }
  }
  await update();
}

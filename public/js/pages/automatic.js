import { api } from '../api.js';
import { esc, fail } from '../ui.js';

export async function renderAutomatic(el, id, editable, isCurrent) {
  const base = `/api/cases/${encodeURIComponent(id)}/automatic-report`;
  if (!isCurrent()) return;
  const aggregate = await api.get(`/api/cases/${encodeURIComponent(id)}`);
  if (!isCurrent()) return;
  el.innerHTML = `<p><b>Claims: ${aggregate.claimCapacity.selection_required ? aggregate.claimCapacity.active : Math.min(aggregate.claimCapacity.used, 2)}/2</b> · <a href="#/tasks">Background tasks</a>${aggregate.claimCapacity.selection_required ? ` · <a href="#/case/${encodeURIComponent(id)}/claims">Select up to two claims</a>` : ""}</p><h1>Automatic fact-checking report</h1><p>No analyst comments are required. Findings are preliminary and include evidence limits.</p>
    <div id="autoState" aria-live="polite">Loading…</div>
    ${editable ? `<div class="card"><div class="bd"><label><input id="autoSearch" type="checkbox"> Search configured external evidence services</label><br>
    <label><input id="autoAI" type="checkbox"> Send this case's text, OCR and evidence to the configured AI service for analysis</label>
    <p class="small sub">Without AI or external search, the report uses local checks and existing evidence.</p><button id="autoRun" class="btn primary">Generate report</button></div></div>` : ''}
    <p><a href="#/case/${encodeURIComponent(id)}/step2">Open case tools</a></p>`;
  let failedTaskId = null;
  const panel = el.querySelector('#autoState'), button = el.querySelector('#autoRun');
  async function update() {
    if (!isCurrent() || !panel.isConnected) return;
    try {
      const saved = await api.get(base);
      if (!isCurrent() || !panel.isConnected) return;
      failedTaskId = saved?.task?.status === 'failed' ? saved.task.id : null;
      if (button) { button.disabled = saved?.status === 'running'; button.textContent = failedTaskId ? 'Retry failed task' : 'Generate report'; }
      const r = saved?.report;
      panel.innerHTML = saved?.status === 'running' ? `<p><span class="spin"></span> ${esc(saved.stage.replace(/_/g, ' '))}… You can leave this page; the report continues on the server.</p>`
        : saved?.error ? `<div class="callout warn">${esc(saved.error)}</div>` : '';
      if (r) panel.insertAdjacentHTML('beforeend', `<div class="card"><div class="bd"><h2>${esc(r.report_date)} · ${esc(r.assessment.label)}</h2><p>${esc(r.status)}</p>
        <p>${r.analysis.claims} claims · ${r.citations.length} citations · AI: ${esc(r.analysis.ai.status)}</p>
        <div class="row"><a class="btn primary" href="${base}.html" target="_blank" rel="noopener">Read / print report</a><a class="btn" href="${base}.json" download>Download JSON</a></div>
        <p class="small sub">${r.case_version !== (await api.get(`/api/cases/${encodeURIComponent(id)}`)).case.version ? 'The case has changed since this report. Generate a fresh report.' : 'Report reflects the case records at generation time.'}</p></div></div>`);
      if (!saved) panel.textContent = 'No report yet. Generate one using the saved content and evidence.';
      if (saved?.status === 'running') setTimeout(update, 1500);
    } catch (e) { if (panel.isConnected) panel.textContent = e.message; }
  }
  if (button) button.onclick = async () => {
    button.disabled = true;
    try { if (failedTaskId) await api.post(`/api/tasks/${failedTaskId}/retry`); else await api.queueTask(id, "report", { search_external: el.querySelector('#autoSearch').checked, confirm_external: el.querySelector('#autoAI').checked }); await update(); }
    catch (e) { button.disabled = false; fail(e); }
  };
  await update();
}

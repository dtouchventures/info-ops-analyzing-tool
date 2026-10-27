import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, toast, fail, modal, confirmBox, fmtDT, ago, kb } from "../ui.js";

export async function render(el, [tabArg]) {
  const tabs = [["users", "Users", "users.manage"], ["permissions", "Permissions", null], ["integrations", "Integrations", "settings.manage"], ["usage", "Usage & storage", "settings.manage"], ["backups", "Backups & retention", "settings.manage"], ["audit", "Audit log", "audit.read"], ["training", "Training data", "settings.manage"]].filter(t => !t[2] || App.can(t[2]));
  const tab = tabs.some(t => t[0] === tabArg) ? tabArg : tabs[0][0];
  crumbs(`<b>Administration</b>`);
  el.innerHTML = `<div class="pagehead"><div><h1>Administration</h1><p>Accounts, permissions, integrations, usage, backups and the audit trail.</p></div></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav><div id="ab"></div>`;
  const b = $("#ab");
  await ({ users, permissions, integrations, usage, backups, audit, training })[tab](b);
}

async function users(b) {
  const { users } = await api.get("/api/users"), roles = App.meta.roles;
  b.innerHTML = `<div class="card"><div class="hd"><h3>User accounts</h3><button class="btn primary sm right" id="nu">+ Add user</button></div><div class="tablewrap"><table class="t"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Designation</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr><td><b>${esc(u.display_name)}</b>${u.id === App.me.id ? ` <span class="chip teal">you</span>` : ""}</td><td class="mono">${esc(u.username)}</td>
      <td><select data-role="${u.id}" style="width:auto;padding:4px 6px" ${u.id === App.me.id ? "disabled" : ""} aria-label="Role of ${esc(u.username)}">${Object.entries(roles).map(([k, l]) => `<option value="${k}" ${k === u.role ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><input data-desig="${u.id}" value="${esc(u.designation || "")}" placeholder="${u.role === "hod" ? "required on approved reports" : "optional"}" style="width:180px;padding:4px 6px" aria-label="Designation of ${esc(u.username)}"></td>
      <td>${u.active ? `<span class="chip sup">Active</span>` : `<span class="chip grey">Disabled</span>`}${u.must_change_password ? ` <span class="chip warn">Temporary password</span>` : ""}</td>
      <td class="small sub">${u.last_login_at ? ago(u.last_login_at) : "Never"}</td>
      <td><div class="row">${u.id !== App.me.id ? `<button class="btn sm" data-toggle="${u.id}" data-active="${u.active}">${u.active ? "Disable" : "Enable"}</button>` : ""}<button class="btn sm ghost" data-reset="${u.id}">Reset password</button></div></td></tr>`).join("")}</tbody></table></div></div>
    <div class="callout info" style="margin-top:14px"><div><b>Head of Department approval:</b> give the approver the role “Head of Department” and a designation (for example “Head of Department, Information Operations”), which is printed on approved reports. Administrators do not approve reports unless they hold that role.<br>New accounts and password resets produce a one-time temporary password. Pass it to the person through a separate, secure channel; they must change it at first sign-in. Disabling an account or changing its role ends its open sessions.</div></div>`;
  const tmp = (u, pw) => modal("Temporary password", `<p>Give this to <b>${esc(u)}</b> securely. It is shown once.</p><pre class="box" style="font-size:16px">${esc(pw)}</pre>`, [{ label: "Done", kind: "primary" }]);
  $("#nu").onclick = async () => {
    const r = await modal("Add user", `<label class="f" for="un">Full name</label><input type="text" id="un"><label class="f" for="uu">Username</label><input type="text" id="uu" autocomplete="off"><label class="f" for="ur">Role</label><select id="ur">${Object.entries(App.meta.roles).map(([k, l]) => `<option value="${k}" ${k === "analyst" ? "selected" : ""}>${l}</option>`).join("")}</select>`,
      [{ label: "Cancel", value: null }, { label: "Create", kind: "primary", validate: async el => { try { el._r = await api.post("/api/users", { display_name: $("#un", el).value, username: $("#uu", el).value.trim(), role: $("#ur", el).value }); } catch (e) { return e.message; } }, value: el => ({ ...el._r, username: $("#uu", el).value }) }]);
    if (r.value) { await tmp(r.value.username, r.value.temporary_password); await App.refreshMeta(); users(b); }
  };
  $$("[data-desig]").forEach(x => x.onchange = async () => { try { await api.patch(`/api/users/${x.dataset.desig}`, { designation: x.value }); toast("Designation saved."); } catch (e) { fail(e); } });
  $$("[data-role]").forEach(s => s.onchange = async () => { try { await api.patch(`/api/users/${s.dataset.role}`, { role: s.value }); toast("Role changed. The user's sessions were ended."); await App.refreshMeta(); } catch (e) { fail(e); users(b); } });
  $$("[data-toggle]").forEach(x => x.onclick = async () => { try { await api.patch(`/api/users/${x.dataset.toggle}`, { active: x.dataset.active !== "1" }); await App.refreshMeta(); users(b); } catch (e) { fail(e); } });
  $$("[data-reset]").forEach(x => x.onclick = async () => { if (!(await confirmBox("Reset this password?", "The current password stops working and open sessions end.", "Reset"))) return; try { const r = await api.post(`/api/users/${x.dataset.reset}/reset-password`); await tmp(users.find(u => u.id === +x.dataset.reset).username, r.temporary_password); users(b); } catch (e) { fail(e); } });
}

async function permissions(b) {
  const P = App.meta.permissions, roles = Object.keys(App.meta.roles);
  b.innerHTML = `<div class="card"><div class="hd"><h3>What each role can do</h3></div><div class="tablewrap"><table class="perm"><thead><tr><th>Permission</th>${roles.map(r => `<th>${esc(App.meta.roles[r])}</th>`).join("")}</tr></thead><tbody>
    ${Object.entries(P).map(([k, v]) => `<tr><td>${esc(v.label)}<div class="tiny sub mono">${esc(k)}</div></td>${roles.map(r => `<td>${v.roles.includes(r) ? `<span class="yes" aria-label="yes">✓</span>` : `<span class="no-ic" aria-label="no">—</span>`}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <div class="bd small muted">Separation of duties: ${App.meta.allowSelfApproval ? "<b>self-approval is currently allowed by server configuration</b> (ALLOW_SELF_APPROVAL=true)." : "a reviewer can never approve a case they are assigned to or submitted."} Analysts can change only cases they created or are assigned to.</div></div>`;
}

async function integrations(b) {
  const d = await api.get("/api/admin/integrations"), ai = d.ai;
  b.innerHTML = `<div class="split"><div class="stack">
    <div class="card"><div class="hd"><h3>AI service</h3>${ai.configured ? `<span class="chip ${ai.enabled ? "sup" : "grey"} right">${ai.enabled ? "Enabled" : "Switched off"}</span>` : `<span class="chip grey right">AI not configured</span>`}</div><div class="bd">
      ${ai.configured ? `<dl class="kv"><dt>Provider</dt><dd>${esc(ai.providerLabel)}</dd><dt>Endpoint</dt><dd>${esc(ai.endpoint)}</dd><dt>Model</dt><dd class="mono">${esc(ai.model)}</dd><dt>Prompt version</dt><dd class="mono">${esc(ai.promptVersion)}</dd><dt>API key</dt><dd>Held on the server only (environment variable). Never shown or stored in the database.</dd></dl>
        <label class="check" style="margin-top:12px"><input type="checkbox" id="aiOn" ${ai.enabled ? "checked" : ""}> Allow analysts to send case content to this service</label>`
      : `<p>${esc(ai.reason)}</p><pre class="box">AI_PROVIDER=anthropic        # or openai (any OpenAI-compatible endpoint)
AI_MODEL=&lt;model name&gt;
AI_API_KEY=&lt;secret key&gt;
# AI_BASE_URL=https://…        # optional: private or regional endpoint</pre><p class="small muted">Put these in the server's <span class="mono">.env</span> file or environment and restart. Local verification features work without AI.</p>`}</div></div>
    <div class="card"><div class="hd"><h3>Social media post lookup</h3></div><div class="bd small"><ul style="margin:0 0 0 18px;line-height:1.7">${(App.meta.social || []).map(s => `<li><b>${esc(s.label)}</b> <span class="chip ${s.configured ? "sup" : "grey"}">${s.configured ? "ready, no key needed" : "not configured"}</span>${s.configured ? "" : `<div class="sub">Needs ${esc(s.needs)}.</div>`}</li>`).join("")}</ul>
      <p class="muted" style="margin-bottom:0">Used by <b>Verify information → Social media post</b> to read one public post from its link. Only the link is sent to the platform. Calls are counted under Usage &amp; storage.</p></div></div>
    <div class="card"><div class="hd"><h3>OCR</h3></div><div class="bd"><dl class="kv"><dt>Engine</dt><dd>${esc(d.ocr.engine)}</dd><dt>Languages</dt><dd>${d.ocr.languages.map(l => esc(l.label)).join(", ") || "None installed"}</dd></dl><p class="small muted">OCR runs in the analyst's browser from files served by this server. No text or image is sent elsewhere.</p></div></div>
  </div><div class="stack">
    <div class="card"><div class="hd"><h3>Storage</h3></div><div class="bd"><dl class="kv"><dt>Data folder</dt><dd class="mono tiny">${esc(d.storage.dataDir)}</dd><dt>Database</dt><dd>${kb(d.storage.databaseBytes)}</dd><dt>Stored files</dt><dd>${d.storage.objects.n} (${kb(d.storage.objects.bytes)}), content-addressed by SHA-256</dd></dl>
      <button class="btn" id="verifyS" style="margin-top:12px">Verify every stored file</button><div id="vsr" class="small" style="margin-top:8px"></div></div></div>
    <div class="card"><div class="hd"><h3>Security settings</h3></div><div class="bd"><dl class="kv"><dt>Secure cookies</dt><dd>${d.security.cookieSecure ? "On (HTTPS)" : "Off — turn on (COOKIE_SECURE=true) when served over HTTPS"}</dd><dt>Session length</dt><dd>${d.security.sessionHours} hours</dd><dt>Self-approval</dt><dd>${d.security.allowSelfApproval ? "Allowed" : "Blocked"}</dd><dt>Upload limit</dt><dd>${d.security.maxUploadMb} MB per file</dd></dl></div></div>
  </div></div>`;
  if ($("#aiOn")) $("#aiOn").onchange = async e => { try { await api.put("/api/admin/settings/ai_enabled", { value: e.target.checked }); await App.refreshMeta(); toast(e.target.checked ? "AI assistance enabled." : "AI assistance switched off."); } catch (er) { fail(er); } };
  $("#verifyS").onclick = async () => { $("#vsr").innerHTML = `<span class="spin"></span> Re-hashing files…`; try { const r = await api.post("/api/admin/storage/verify"); $("#vsr").innerHTML = r.failed.length ? `<span style="color:var(--con)"><b>${r.failed.length} file(s) failed</b> the check: ${r.failed.map(esc).join(", ")}</span>` : `<span style="color:var(--sup)">All ${r.checked} files match their SHA-256 fingerprints.</span>`; } catch (e) { fail(e); } };
}

async function audit(b) {
  let before = 0;
  b.innerHTML = `<div class="card"><div class="hd"><h3>Audit log</h3><div class="right row"><span id="vr" class="small"></span><button class="btn sm" id="vb">Verify integrity</button></div></div><div class="tablewrap"><table class="t"><thead><tr><th>#</th><th>Time</th><th>User</th><th>Action</th><th>Record</th></tr></thead><tbody id="ar"></tbody></table></div><div class="bd"><button class="btn sm" id="more">Older entries</button></div></div>`;
  async function more() {
    const { entries } = await api.get(`/api/audit?limit=100${before ? `&before=${before}` : ""}`);
    $("#ar").insertAdjacentHTML("beforeend", entries.map(e => `<tr><td class="num tiny sub">${e.id}</td><td class="small">${fmtDT(e.at)}</td><td class="small">${esc(e.username)}</td><td class="small">${esc(e.action)}${e.details ? `<div class="tiny sub mono" style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.details)}">${esc(e.details)}</div>` : ""}</td><td class="small">${e.entity === "case" ? `<a href="#/case/${esc(e.entity_id)}">${esc(e.entity_id)}</a>` : esc([e.entity, e.entity_id].filter(Boolean).join(" "))}</td></tr>`).join(""));
    if (entries.length) before = entries.at(-1).id; $("#more").hidden = entries.length < 100;
  }
  $("#more").onclick = more;
  $("#vb").onclick = async () => { const r = await api.get("/api/audit/verify"); $("#vr").innerHTML = r.ok ? `<span style="color:var(--sup)">Intact: ${r.checked} entries verified.</span>` : `<span style="color:var(--con)"><b>Broken at entry ${r.brokenAt}.</b> Entries may have been altered.</span>`; };
  await more();
}

async function training(b) {
  const t = App.meta.training;
  b.innerHTML = `<div class="card"><div class="hd"><h3>Training data</h3></div><div class="bd">
    <p>Three synthetic practice cases (TR-…) and two synthetic archive records (TA-…). They are flagged as training, appear only when <b>Training</b> is selected at the top of the page, never match operational cases, and are excluded from operational dashboards and reports.</p>
    <p class="small muted">Currently loaded: ${t.cases} training case(s), ${t.archive} training archive record(s).</p>
    <button class="btn primary" id="seed" ${t.cases ? "disabled" : ""}>${t.cases ? "Training data already loaded" : "Load training cases"}</button>
    <button class="btn" id="seedCov" title="One synthetic training case with supported, contradicted, mixed, insufficient and unbacked claims, for the Evidence coverage tab">Load evidence coverage demo</button></div></div>`;
  $("#seedCov").onclick = async () => { const x = $("#seedCov"); x.disabled = true; try { const r = await api.post("/api/admin/training/coverage-demo"); toast(`${r.message} Switch to Training records to open it.`); await App.refreshMeta(); } catch (e) { fail(e); } x.disabled = false; };
  $("#seed").onclick = async () => { const x = $("#seed"); x.disabled = true; x.innerHTML = '<span class="spin"></span> Loading…'; try { const r = await api.post("/api/admin/training"); toast(r.message); await App.refreshMeta(); training(b); } catch (e) { fail(e); x.disabled = false; } };
}

const mb = n => (n > 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`);
async function usage(b) {
  const [u, st] = await Promise.all([api.get("/api/admin/usage?days=90"), api.get("/api/admin/storage")]);
  const C = st.counts;
  b.innerHTML = `<div class="kpis" style="margin-top:14px">
      <div class="kpi"><div class="l">Database</div><div class="v" style="font-size:22px">${mb(st.database_bytes)}</div><div class="tiny sub">${C.cases} cases · ${C.evidence} evidence items · ${C.audit_entries} audit entries</div></div>
      <div class="kpi"><div class="l">Stored files</div><div class="v" style="font-size:22px">${mb(st.files_bytes)}</div><div class="tiny sub">${st.files} files (images, video, documents)</div></div>
      <div class="kpi"><div class="l">Backups</div><div class="v" style="font-size:22px">${mb(st.backups_bytes)}</div><div class="tiny sub" style="overflow-wrap:anywhere">${esc(st.backup_dir)}</div></div>
      <div class="kpi"><div class="l">Monitor and datasets</div><div class="v" style="font-size:22px">${C.io_posts.toLocaleString()}</div><div class="tiny sub">posts in ${C.io_datasets} dataset(s) · ${C.kb_records.toLocaleString()} fact-check records</div></div></div>
    <div class="card" style="margin-top:14px"><div class="hd"><h3>External services, last ${u.days} days</h3></div>${u.byService.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Service</th><th class="n">Calls</th><th class="n">Failed</th><th class="n">Estimated cost (USD)</th><th>Last used</th></tr></thead><tbody>${u.byService.map(r => `<tr><td><b>${esc(r.label)}</b></td><td class="n">${r.calls}</td><td class="n">${r.failed ? `<b style="color:var(--con)">${r.failed}</b>` : 0}</td><td class="n">${Number(r.cost || 0).toFixed(2)}</td><td class="small">${fmtDT(r.last)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="bd small muted">No external service has been used yet.</div>`}<div class="bd hint" style="padding-top:0">${esc(u.note)}</div></div>
    <div class="card" style="margin-top:14px"><div class="hd"><h3>Recent failures</h3></div>${u.failures.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>When</th><th>What</th><th>Detail</th><th>Error</th></tr></thead><tbody>${u.failures.map(f => `<tr><td class="small">${fmtDT(f.at)}</td><td>${esc(f.what)}</td><td class="small mono">${esc(f.detail || "")}</td><td class="small" style="overflow-wrap:anywhere">${esc(String(f.error || "").slice(0, 300))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="bd small muted">No failures recorded.</div>`}</div>`;
}
async function backups(b) {
  const [bk, rt] = await Promise.all([api.get("/api/admin/backups"), api.get("/api/admin/retention")]);
  const S = rt.settings, D = rt.due;
  b.innerHTML = `<div class="split" style="margin-top:14px"><div class="stack">
    <div class="card"><div class="hd"><h3>Backups</h3><button class="btn primary sm right" id="bkNow">Back up now</button></div><div class="bd small">
      <p style="margin-top:0">${bk.automatic ? "AIVS makes a backup automatically once a day while it is running" : "Automatic backups are switched off (BACKUP_DISABLED)"}, and keeps the newest <b>${bk.keep}</b>. Each backup is a consistent copy of the database plus every stored file, in <span class="mono" style="overflow-wrap:anywhere">${esc(bk.dir)}</span>.</p>
      <div class="callout warn"><div><b>Copy backups off this computer too</b> (an encrypted USB drive or your organisation's backup server). A backup on the same disk does not survive a disk failure or theft.</div></div>
      ${bk.backups.length ? `<div class="tablewrap" style="margin-top:10px"><table class="t"><thead><tr><th>Backup</th><th>Made</th><th class="n">Database</th><th class="n">New files</th></tr></thead><tbody>${bk.backups.map(x => `<tr><td class="mono small">${esc(x.name)}</td><td class="small">${fmtDT(x.created_at)} · ${esc(x.reason || "")}${x.by ? ` · ${esc(x.by)}` : ""}</td><td class="n small">${x.database_bytes ? mb(x.database_bytes) : "—"}</td><td class="n small">${x.files_copied ?? "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No backups yet.</p>`}
      <details style="margin-top:8px"><summary class="small sub">How to restore</summary><ol style="margin:6px 0 0 18px;line-height:1.6"><li>Stop AIVS (close its window).</li><li>Rename the current <span class="mono">data</span> folder to keep it (for example <span class="mono">data-old</span>).</li><li>Create a new <span class="mono">data</span> folder and copy <span class="mono">aivs.db</span> from the chosen backup into it.</li><li>Copy the files from <span class="mono">backups/objects</span> back into <span class="mono">data/objects</span> (see README, “Backups”).</li><li>Start AIVS and check a few cases and reports.</li></ol></details></div></div>
  </div><div class="stack">
    <div class="card"><div class="hd"><h3>Retention</h3></div><div class="bd small">
      <p style="margin-top:0">${esc(rt.note)}</p>
      <div class="grid g2"><div><label class="f" for="rIo">${esc(rt.labels.io_days)}: keep for (days)</label><input type="number" id="rIo" min="0" value="${S.io_days}"></div>
        <div><label class="f" for="rAs">${esc(rt.labels.assistant_days)}: keep for (days)</label><input type="number" id="rAs" min="0" value="${S.assistant_days}"></div>
        <div><label class="f" for="rWa">${esc(rt.labels.watch_days)}: keep for (days)</label><input type="number" id="rWa" min="0" value="${S.watch_days}"></div>
        <div><label class="f" for="rBk">Backups to keep</label><input type="number" id="rBk" min="1" max="60" value="${bk.keep}"></div></div>
      <button class="btn sm" id="rSave" style="margin-top:10px">Save</button>
      <h4 style="margin-top:16px">Past the retention period</h4>
      ${D.io.length || D.assistant.length || D.tmp_files || D.watch?.n ? `<div style="line-height:1.9">${D.io.map(x => `<label class="check"><input type="checkbox" data-io="${x.id}"> Post dataset “${esc(x.name)}” (${x.posts.toLocaleString()} posts, imported ${fmtDT(x.imported_at)})</label>`).join("")}
        ${D.assistant.map(x => `<label class="check"><input type="checkbox" data-as="${esc(x.case_id)}"> Assistant conversation on <a href="#/case/${esc(x.case_id)}/assistant">${esc(x.case_id)}</a> (${x.messages} messages, last ${fmtDT(x.last)})</label>`).join("")}
        ${D.watch?.n ? `<label class="check"><input type="checkbox" id="rWatch"> ${D.watch.n.toLocaleString()} mention watch post(s) first detected before ${fmtDT(new Date(Date.now() - S.watch_days * 864e5).toISOString())} (not behind an open alert or a case)</label>` : ""}
        ${D.tmp_files ? `<label class="check"><input type="checkbox" id="rTmp"> ${D.tmp_files} leftover temporary upload file(s) older than a day</label>` : ""}</div>
        <button class="btn danger sm" id="rApply" style="margin-top:8px">Delete selected</button>` : `<p class="muted">Nothing is past its retention period.</p>`}</div></div>
  </div></div>`;
  $("#bkNow").onclick = async () => { const x = $("#bkNow"); x.disabled = true; x.innerHTML = '<span class="spin"></span> Backing up…'; try { const r = await api.post("/api/admin/backups"); toast(`Backup ${r.name} made (${r.files_copied} new file(s)).`); backups(b); } catch (e) { fail(e); x.disabled = false; x.textContent = "Back up now"; } };
  $("#rSave").onclick = async () => { try { await api.put("/api/admin/retention", { io_days: $("#rIo").value, assistant_days: $("#rAs").value, watch_days: $("#rWa").value, backup_keep: $("#rBk").value }); toast("Saved."); backups(b); } catch (e) { fail(e); } };
  if ($("#rApply")) $("#rApply").onclick = async () => {
    const io_ids = $$("[data-io]:checked").map(x => +x.dataset.io), assistant_case_ids = $$("[data-as]:checked").map(x => x.dataset.as), tmp = !!$("#rTmp")?.checked, watch = !!$("#rWatch")?.checked;
    if (!io_ids.length && !assistant_case_ids.length && !tmp && !watch) return toast("Tick what to delete first.", "err");
    if (!(await confirmBox("Delete permanently?", `${io_ids.length} post dataset(s), ${assistant_case_ids.length} assistant conversation(s)${watch ? `, ${D.watch.n} mention watch post(s)` : ""}${tmp ? " and old temporary files" : ""} will be deleted. This cannot be undone (except from a backup). Each deletion is recorded in the audit log.`, "Delete", "danger"))) return;
    try { const r = await api.post("/api/admin/retention/apply", { confirm: true, io_ids, assistant_case_ids, tmp, watch }); toast(`Deleted: ${r.io} dataset(s), ${r.assistant} conversation(s), ${r.watch} mention watch post(s)${r.tmp ? `, ${r.tmp} temporary file(s)` : ""}.`); backups(b); } catch (e) { fail(e); }
  };
}

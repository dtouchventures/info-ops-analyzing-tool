import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, toast, fail, modal, confirmBox, fmtDT, ago, kb } from "../ui.js";

export async function render(el, [tabArg]) {
  const tabs = [["users", "Users", "users.manage"], ["permissions", "Permissions", null], ["integrations", "Integrations", "settings.manage"], ["audit", "Audit log", "audit.read"], ["training", "Training data", "settings.manage"]].filter(t => !t[2] || App.can(t[2]));
  const tab = tabs.some(t => t[0] === tabArg) ? tabArg : tabs[0][0];
  crumbs(`<b>Administration</b>`);
  el.innerHTML = `<div class="pagehead"><div><h1>Administration</h1><p>Accounts, permissions, integrations and the audit trail.</p></div></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav><div id="ab"></div>`;
  const b = $("#ab");
  await ({ users, permissions, integrations, audit, training })[tab](b);
}

async function users(b) {
  const { users } = await api.get("/api/users"), roles = App.meta.roles;
  b.innerHTML = `<div class="card"><div class="hd"><h3>User accounts</h3><button class="btn primary sm right" id="nu">+ Add user</button></div><div class="tablewrap"><table class="t"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr><td><b>${esc(u.display_name)}</b>${u.id === App.me.id ? ` <span class="chip teal">you</span>` : ""}</td><td class="mono">${esc(u.username)}</td>
      <td><select data-role="${u.id}" style="width:auto;padding:4px 6px" ${u.id === App.me.id ? "disabled" : ""} aria-label="Role of ${esc(u.username)}">${Object.entries(roles).map(([k, l]) => `<option value="${k}" ${k === u.role ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td>${u.active ? `<span class="chip sup">Active</span>` : `<span class="chip grey">Disabled</span>`}${u.must_change_password ? ` <span class="chip warn">Temporary password</span>` : ""}</td>
      <td class="small sub">${u.last_login_at ? ago(u.last_login_at) : "Never"}</td>
      <td><div class="row">${u.id !== App.me.id ? `<button class="btn sm" data-toggle="${u.id}" data-active="${u.active}">${u.active ? "Disable" : "Enable"}</button>` : ""}<button class="btn sm ghost" data-reset="${u.id}">Reset password</button></div></td></tr>`).join("")}</tbody></table></div></div>
    <div class="callout info" style="margin-top:14px"><div>New accounts and password resets produce a one-time temporary password. Pass it to the person through a separate, secure channel; they must change it at first sign-in. Disabling an account or changing its role ends its open sessions.</div></div>`;
  const tmp = (u, pw) => modal("Temporary password", `<p>Give this to <b>${esc(u)}</b> securely. It is shown once.</p><pre class="box" style="font-size:16px">${esc(pw)}</pre>`, [{ label: "Done", kind: "primary" }]);
  $("#nu").onclick = async () => {
    const r = await modal("Add user", `<label class="f" for="un">Full name</label><input type="text" id="un"><label class="f" for="uu">Username</label><input type="text" id="uu" autocomplete="off"><label class="f" for="ur">Role</label><select id="ur">${Object.entries(App.meta.roles).map(([k, l]) => `<option value="${k}" ${k === "analyst" ? "selected" : ""}>${l}</option>`).join("")}</select>`,
      [{ label: "Cancel", value: null }, { label: "Create", kind: "primary", validate: async el => { try { el._r = await api.post("/api/users", { display_name: $("#un", el).value, username: $("#uu", el).value.trim(), role: $("#ur", el).value }); } catch (e) { return e.message; } }, value: el => ({ ...el._r, username: $("#uu", el).value }) }]);
    if (r.value) { await tmp(r.value.username, r.value.temporary_password); await App.refreshMeta(); users(b); }
  };
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
    <button class="btn primary" id="seed" ${t.cases ? "disabled" : ""}>${t.cases ? "Training data already loaded" : "Load training cases"}</button></div></div>`;
  $("#seed").onclick = async () => { const x = $("#seed"); x.disabled = true; x.innerHTML = '<span class="spin"></span> Loading…'; try { const r = await api.post("/api/admin/training"); toast(r.message); await App.refreshMeta(); training(b); } catch (e) { fail(e); x.disabled = false; } };
}

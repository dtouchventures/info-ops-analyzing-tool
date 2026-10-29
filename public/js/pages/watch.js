import { renderLatestNews } from "./latest-news.js";
// KDF Mention Watch: the analyst alert queue, saved watchlists (terms, include and exclude rules, preview before
// activation) and the status of each collection source. Everything shown comes from the server's stored records;
// counts a platform did not report are shown as "not reported", and no reach figure is estimated.
import { api } from "../api.js";
import { App, crumbs, refreshNavCounts } from "../app.js";
import { $, $$, esc, toast, fail, modal, fmtDT, ago, empty } from "../ui.js";

const KIND = { threshold: ["Keyword threshold exceeded", "info"], volume: ["Unusual posting spike", "warn"], narrative: ["Emerging narrative", "teal"], repeated: ["Repeated-message activity", "mix"],
  coordination: ["Potential coordination indicator", "con"], match: ["Match", "info"], engagement: ["Engagement rising", "warn"] };
const SEV = { high: ["High", "con"], medium: ["Medium", "warn"], low: ["Low", "grey"] };
const STATUS = { new: ["New", "con"], acknowledged: ["Acknowledged", "teal"], dismissed: ["Dismissed", "grey"], converted: ["Case opened", "sup"] };
const SRC_STATE = { ready: ["Configured", "sup"], not_configured: ["Not configured", "grey"], disabled: ["Off", "grey"], unsupported: ["Not supported", "grey"] };
const RUNSTATE = { ok: ["ok", "sup"], partial: ["partial", "mix"], failed: ["failed", "con"], skipped: ["skipped", "grey"], interrupted: ["interrupted", "mix"], running: ["running", "info"] };
let SRCLABEL = {};
const srcName = k => SRCLABEL[k] || k;
const chip = ([l, c]) => `<span class="chip ${c}">${esc(l)}</span>`;
const dt = iso => (iso ? fmtDT(iso) : "—");
const num = v => (v == null ? `<span class="sub">not reported</span>` : Number(v).toLocaleString());
function marked(text, ranges = []) {
  let out = "", i = 0;
  for (const [a, b] of ranges) { if (a < i) continue; out += esc(text.slice(i, a)) + `<mark>${esc(text.slice(a, b))}</mark>`; i = b; }
  return out + esc(text.slice(i));
}
const lag = (posted, detected) => { if (!posted || !detected) return ""; const m = Math.round((Date.parse(detected) - Date.parse(posted)) / 60000); return m < 0 ? "" : m < 60 ? `${m} min after publication` : m < 2880 ? `${Math.round(m / 60)} h after publication` : `${Math.round(m / 1440)} days after publication`; };
let OV = null;
// Defaults keep every tab working if the server is an older version that does not send a field yet.
const OV_DEFAULTS = { watchlists: [], datasets: [], stats: {}, alert_counts: {}, sources: {}, manual_sources: {}, caveats: ["", ""], users: [], status: { sources: [], budgets: {}, stream: {} }, severity_rules: {}, actions: {} };
const overview = async (force) => {
  if (OV && !force) return OV;
  const r = await api.get("/api/watch/overview");
  OV = { ...OV_DEFAULTS, ...r, status: { ...OV_DEFAULTS.status, ...(r.status || {}) } };
  if (!Array.isArray(OV.caveats) || OV.caveats.length < 2) OV.caveats = [...(OV.caveats || []), "", ""].slice(0, Math.max(2, (OV.caveats || []).length));
  return OV;
};
// One line saying whether monitoring is running, when it last succeeded and how much it checked.
export function monitoringText(ov) {
  const m = ov.stats?.monitoring;
  if (!m) return ["warn", "Monitoring status is not available from this server. If AIVS was just updated, close the AIVS window and start it again."];
  if (!m.active_watchlists) return ["warn", "Monitoring is off: no watchlist is active. Create a watchlist, preview its matches, then activate it."];
  if (!m.datasets && !(m.live_sources_connected || []).length) return ["warn", `${m.active_watchlists} active watchlist(s), but no data source yet: import a dataset in Social Media Analysis, or connect a platform under Sources and status.`];
  const last = m.last_successful_analysis ? fmtDT(m.last_successful_analysis) : "not yet";
  const none = m.posts_checked && !m.posts_matched ? " None of the checked posts match the watchlist terms." : "";
  const failed = m.failed_checks ? ` ${m.failed_checks} check(s) failed; see Recent activity.` : "";
  return [m.failed_checks ? "bad" : "ok", `Monitoring active: ${m.active_watchlists} watchlist(s) · last successful analysis ${last} · ${Number(m.posts_checked).toLocaleString()} posts checked, ${Number(m.posts_matched).toLocaleString()} matching · live platforms: ${(m.live_sources_connected || []).length ? m.live_sources_connected.join(", ") : "none connected"}.${none}${failed}`];
}

export async function render(el, [tab = "overview", id]) {
  const ov = await overview(true), nNew = ov.alert_counts.new || 0;
  SRCLABEL = { ...Object.fromEntries(Object.entries(ov.sources).map(([k, v]) => [k, v.label])), ...ov.manual_sources };
  crumbs(`AI Watchlist${tab === "list" ? " / Watchlist" : ""}`);
  const tabs = [["overview", "Overview"], ["news", "Latest news"], ["security", "Security news"], ["alerts", `Alerts${nNew ? `<span class="count">${nNew}</span>` : ""}`], ["lists", "Watchlists"], ["sources", "Sources and status"]];
  el.innerHTML = `<div class="pagehead"><div><h1>AI Watchlist</h1><p>Watch topics, keywords and hashtags in public posts collected through permitted APIs and feeds, or imported from datasets. Alerts are leads for an analyst to check; they are not findings.</p></div></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/watch/${k}" class="${k === tab || (tab === "list" && k === "lists") ? "on" : ""}">${l}</a>`).join("")}</nav><div id="wb"></div>`;
  const body = $("#wb", el);
  if (tab === "security") return renderLatestNews(body, { security: true });
  if (tab === "news") return renderLatestNews(body);
  if (tab === "lists") return lists(body, ov);
  if (tab === "list") return listView(body, ov, id);
  if (tab === "sources") return sources(body, ov);
  if (tab === "alerts") return queue(body, ov);
  return overviewTab(body, ov);
}

// ---------------------------------------------------------------- overview
function overviewTab(body, ov) {
  const live = ov.watchlists.filter(w => w.status === "active"), st = ov.stats || {}, sev = st.open_by_severity || {}, open = (ov.alert_counts.new || 0) + (ov.alert_counts.acknowledged || 0);
  const fig = (n, l, h) => `<a class="kpi" href="${h}"><div class="l">${l}</div><div class="v">${Number(n).toLocaleString()}</div></a>`;
  const [mc, mt] = monitoringText(ov);
  body.innerHTML = `<div class="wmon ${mc}" id="wMon">${esc(mt)}</div><div class="kpis wkpis">${fig(live.length, "active watchlists", "#/watch/lists")}${fig(st.monitored_posts || 0, "monitored posts (matched)", "#/watch/lists")}${fig(open, "open alerts", "#/watch/alerts")}
      <div class="kpi"><div class="l">Open alerts by severity</div><div class="v small-v"><span style="color:var(--con)">${sev.high || 0}</span> · <span style="color:var(--warn)">${sev.medium || 0}</span> · ${sev.low || 0}</div><div class="tiny sub">high · medium · low</div></div></div>
    ${!ov.watchlists.length ? `<div class="card" style="margin-top:12px"><div class="bd"><h3 style="margin-top:0">Start in three steps</h3><ol class="small" style="margin:0 0 0 18px">
        <li><b>Create a watchlist</b> with keywords, hashtags or phrases, and choose the imported datasets to monitor (Watchlists tab).</li>
        <li><b>Preview and activate</b> it. AIVS checks the chosen datasets straight away.</li>
        <li><b>Import data</b> in Social Media Analysis (CSV, JSON or Excel). Every new import is checked by the active watchlists automatically.</li></ol>
      ${App.can("io.import") ? `<p class="small" style="margin-bottom:0">For a demonstration: <button class="btn sm" id="wDemo" type="button">Load the SYNTHETIC election dataset</button> <span class="sub">1,000 invented posts with planted patterns at known times.</span></p>` : ""}</div></div>` : ""}
    <div class="grid g2" style="margin-top:12px">
      <div class="card"><div class="hd"><h3>Recent activity</h3></div><div class="bd small">${(st.recent_scans || []).length ? `<ul class="mini">${st.recent_scans.map(r => `<li><span class="chip ${r.status === "ok" ? "sup" : "con"}">${esc(r.status || "")}</span><span style="flex:1"><a href="#/watch/list/${r.watchlist_id}">${esc(r.watchlist)}</a> checked “${esc(r.dataset || `dataset ${r.dataset_id}`)}”: ${r.posts_checked.toLocaleString()} posts, ${r.matched.toLocaleString()} matching${r.error ? ` <span class="sub">${esc(r.error)}</span>` : ""}</span><span class="sub">${dt(r.scanned_at)}</span></li>`).join("")}</ul>` : `<p class="sub" style="margin:0">No dataset has been checked yet.</p>`}
        ${App.can("io.import") && ov.watchlists.length ? `<div class="row" style="margin-top:8px"><a class="btn sm" href="#/monitor">Import a dataset</a><button class="btn sm ghost" id="wDemo" type="button">Load the SYNTHETIC demo dataset</button></div>` : ""}</div></div>
      <div class="card"><div class="hd"><h3>Active watchlists</h3><a class="small right" href="#/watch/lists">All</a></div><div class="bd small">${live.length ? `<ul class="mini">${live.map(w => `<li><a href="#/watch/list/${w.id}" style="flex:1">${esc(w.name)}</a><span class="sub">${w.matches.toLocaleString()} posts · ${w.new_alerts} new alerts</span></li>`).join("")}</ul>` : `<p class="sub" style="margin:0">None active.</p>`}</div></div>
    </div>
    <div class="card" style="margin-top:12px"><div class="hd"><h3>How alerts are decided</h3></div><div class="bd small"><table class="t"><thead><tr><th>Category</th><th>Severity rule</th><th>What to do</th></tr></thead><tbody>
      ${["threshold", "volume", "narrative", "repeated", "coordination"].map(k => `<tr><td>${chip(KIND[k])}</td><td>${esc(ov.severity_rules?.[k] || "")}</td><td>${esc(ov.actions?.[k] || "")}</td></tr>`).join("")}</tbody></table>
      <p class="hint">Imported datasets are analysed by the publication times they contain (historical analysis). Live monitoring needs a connected source (Sources and status) and runs on a schedule. Every alert is a lead for an analyst; sentiment and coordination signals are never proof of misinformation.</p></div></div>`;
  $$("#wDemo", body).forEach(b => b.onclick = async () => { b.disabled = true; b.innerHTML = '<span class="spin"></span> Importing…'; try { const r = await api.post("/api/io/watch-demo", {}); const w = (r.watchlists || []).reduce((a, x) => a + x.alerts, 0); toast(`Dataset ${r.id} imported (${r.imported} posts). ${r.watchlists?.length ? `${r.watchlists.length} active watchlist(s) checked it: ${w} new alert(s).` : "No active watchlist monitors it yet."}`); render($("#page"), ["overview"]); refreshNavCounts(); } catch (e) { fail(e); b.disabled = false; } });
}

// ---------------------------------------------------------------- alert queue
async function queue(body, ov) {
  const qp = new URLSearchParams(location.hash.split("?")[1] || ""), f = { status: qp.get("status") || "open", kind: qp.get("kind") || "", severity: qp.get("severity") || "", watchlist: qp.get("watchlist") || "", mine: qp.get("mine") || "", q: qp.get("q") || "", offset: +qp.get("offset") || 0 };
  const r = await api.get(`/api/watch/alerts?${new URLSearchParams(Object.entries({ ...f, limit: 25 }).filter(([, v]) => v !== "" && v != null))}`);
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? "selected" : ""}>${esc(l)}</option>`, c = r.counts;
  const active = ov.watchlists.filter(w => w.status === "active").length;
  body.innerHTML = `${!ov.watchlists.length ? `<div class="callout info" style="margin-bottom:12px"><div><b>No watchlists yet.</b> ${App.can("watch.manage") ? `Create one from the KDF template on the <a href="#/watch/lists">Watchlists</a> tab, preview its matches, then activate it.` : "A reviewer or administrator creates and activates watchlists."}</div></div>`
      : !active ? `<div class="callout warn" style="margin-bottom:12px"><div><b>No watchlist is active</b>, so nothing new is being collected.</div></div>` : ""}
    <form class="card" id="qf" style="margin-bottom:12px"><div class="bd" style="padding:10px 14px"><div class="fgrid">
      <div><label class="f" for="qs" style="margin-top:0">Status</label><select id="qs">${opt("open", `Open (${(c.new || 0) + (c.acknowledged || 0)})`, f.status)}${opt("new", `New (${c.new || 0})`, f.status)}${opt("acknowledged", `Acknowledged (${c.acknowledged || 0})`, f.status)}${opt("dismissed", `Dismissed (${c.dismissed || 0})`, f.status)}${opt("converted", `Case opened (${c.converted || 0})`, f.status)}${opt("all", "All", f.status)}</select></div>
      <div><label class="f" for="qk" style="margin-top:0">Type</label><select id="qk">${opt("", "All types", f.kind)}${Object.entries(KIND).map(([k, [l]]) => opt(k, l, f.kind)).join("")}</select></div>
      <div><label class="f" for="qv" style="margin-top:0">Severity</label><select id="qv">${opt("", "Any severity", f.severity)}${Object.entries(SEV).map(([k, [l]]) => opt(k, l, f.severity)).join("")}</select></div>
      <div><label class="f" for="qw" style="margin-top:0">Watchlist</label><select id="qw">${opt("", "All watchlists", f.watchlist)}${ov.watchlists.map(w => opt(w.id, w.name, f.watchlist)).join("")}</select></div>
      <div style="grid-column:span 2"><label class="f" for="qq" style="margin-top:0">Words in the post or alert</label><input type="search" id="qq" value="${esc(f.q)}"></div>
      <div style="align-self:end"><label class="small"><input type="checkbox" id="qm" ${f.mine ? "checked" : ""}> Assigned to me</label></div></div>
      <div class="row" style="margin-top:8px"><button class="btn sm primary" type="submit">Show</button><span class="small sub">${r.total} alert${r.total === 1 ? "" : "s"}</span><button class="btn sm ghost right" type="button" id="qr">Refresh</button></div></div></form>
    <div id="al" class="stack">${r.alerts.length ? r.alerts.map(card).join("") : `<div class="card"><div class="bd">${empty("No alerts here", f.status === "open" ? "Nothing waiting. New alerts appear as active watchlists collect posts." : "Change the filters above.")}</div></div>`}</div>
    ${r.total > r.limit ? `<div class="row" style="margin-top:10px">${f.offset > 0 ? `<a class="btn sm" href="${qhref({ ...f, offset: Math.max(0, f.offset - r.limit) })}">Newer</a>` : ""}<span class="small sub">${f.offset + 1}–${Math.min(r.total, f.offset + r.limit)} of ${r.total}</span>${f.offset + r.limit < r.total ? `<a class="btn sm" href="${qhref({ ...f, offset: f.offset + r.limit })}">Older</a>` : ""}</div>` : ""}
    <p class="hint">${esc(ov.caveats[1])}</p>`;
  if (!body.isConnected) return;
  $("#qf", body).onsubmit = e => { e.preventDefault(); App.go(qhref({ status: $("#qs").value, kind: $("#qk").value, severity: $("#qv").value, watchlist: $("#qw").value, mine: $("#qm").checked ? "1" : "", q: $("#qq").value.trim() })); };
  $("#qr", body).onclick = () => App.go(location.hash);
  wireCards(body, ov);
}
const qhref = f => `#/watch/alerts?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== "" && v != null && v !== 0))}`;
function metricsLine(a) {
  if (!a.platform) return "";
  if ([a.likes, a.comments, a.shares, a.views].every(v => v == null)) return `<div class="small sub" style="margin-top:6px">Engagement: not reported by ${esc(a.platform)}.</div>`;
  return `<div class="small" style="margin-top:6px"><b>Observed engagement</b> (public counts reported by ${esc(a.platform)} at ${dt(a.metrics_at)}): likes ${num(a.likes)} · replies/comments ${num(a.comments)} · shares/reposts ${num(a.shares)} · views ${num(a.views)}. <span class="sub">Reach is not estimated.</span></div>`;
}
function card(a) {
  const post = a.post_text != null;
  return `<div class="card walert" data-id="${a.id}"><div class="hd" style="flex-wrap:wrap;gap:6px">${chip(KIND[a.kind] || [a.kind, "grey"])}${a.severity ? chip([`${SEV[a.severity]?.[0] || a.severity} severity`, SEV[a.severity]?.[1] || "grey"]) : ""}${chip(STATUS[a.status])}${a.detail?.mode === "historical" ? `<span class="chip grey" title="${esc(a.detail.note || "")}">Historical dataset</span>` : ""}<span class="small sub">${esc(a.watchlist_name)} · alert ${a.id} · raised ${ago(a.created_at)}</span>
      ${a.assigned_name ? `<span class="chip teal">Assigned: ${esc(a.assigned_name)}</span>` : ""}${a.case_id ? `<a class="chip sup" href="#/case/${esc(a.case_id)}">${esc(a.case_id)}</a>` : ""}</div>
    <div class="bd">
      ${post && !["volume", "threshold", "narrative", "coordination"].includes(a.kind) ? `<blockquote class="wpost">${marked(a.post_text, a.highlights)}</blockquote>
        <div class="kv small wmeta"><span><b>Platform</b> ${esc(a.platform)}</span><span><b>Account</b> ${esc(a.account || "not stated")}</span>
          <span><b>Published</b> ${dt(a.posted_at)}</span>${a.first_source === "dataset" ? `<span><b>Imported</b> ${dt(a.first_detected_at)} <span class="sub">(from a dataset)</span></span>` : `<span><b>Detected</b> ${dt(a.first_detected_at)}${a.posted_at ? ` <span class="sub">(${esc(lag(a.posted_at, a.first_detected_at))})</span>` : ""}</span>`}
          ${a.url ? `<span><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a></span>` : ""}</div>` : `<h3 style="margin:0 0 6px">${esc(a.title)}</h3>`}
      <div class="callout info small" style="margin-top:8px"><div><b>Why this alert:</b> ${esc(a.reason)}</div></div>
      ${a.detail?.recommended_action ? `<div class="small" style="margin-top:6px"><b>Recommended action:</b> ${esc(a.detail.recommended_action)}</div>` : ""}
      ${a.detail?.post_ids ? `<div class="small sub" style="margin-top:4px">${a.detail.post_ids.length} supporting post${a.detail.post_ids.length === 1 ? "" : "s"} listed under Details.</div>` : ""}
      ${["match", "repeated", "engagement"].includes(a.kind) ? metricsLine(a) : ""}
      ${a.note ? `<div class="small" style="margin-top:6px"><b>Note:</b> ${esc(a.note)}</div>` : ""}
      <div class="row" style="margin-top:10px;flex-wrap:wrap">
        <button class="btn sm" data-act="details">Details</button>
        ${App.can("watch.triage") && a.status !== "converted" ? `${a.status === "new" ? `<button class="btn sm" data-act="acknowledge">Acknowledge</button>` : ""}
          <button class="btn sm" data-act="assign">Assign</button>
          ${a.status !== "dismissed" ? `<button class="btn sm" data-act="dismiss">Dismiss</button>` : ""}${a.status !== "new" ? `<button class="btn sm ghost" data-act="reopen">Reopen</button>` : ""}
          ${App.can("case.create") ? `<button class="btn sm primary" data-act="convert">Verify a claim</button>` : ""}` : ""}
      </div></div></div>`;
}
function wireCards(root, ov) {
  $$(".walert [data-act]", root).forEach(b => b.onclick = async () => {
    const id = b.closest(".walert").dataset.id, act = b.dataset.act;
    try {
      if (act === "details") return details(id, ov);
      const done = await action(id, act, ov); if (done) { toast(done); render($("#page"), ["alerts"]); refreshNavCounts(); }
    } catch (e) { fail(e); }
  });
}
async function action(id, act, ov) {
  const send = b => api.post(`/api/watch/alerts/${id}/action`, { action: act, ...b });
  if (act === "acknowledge") { await send({}); return "Alert acknowledged."; }
  if (act === "reopen") { await send({}); return "Alert reopened."; }
  if (act === "dismiss") {
    const r = await modal("Dismiss alert", `<label class="f" for="dn">Why does this need no further work?</label><textarea id="dn" rows="3" placeholder="For example: unrelated use of the term; routine news already known; duplicate of alert 12"></textarea>`,
      [{ label: "Cancel", value: null }, { label: "Dismiss", kind: "primary", validate: el => (!$("#dn", el).value.trim() ? "Give a reason." : null), value: el => $("#dn", el).value.trim() }]);
    if (!r.value) return null; await send({ note: r.value }); return "Alert dismissed.";
  }
  if (act === "assign") {
    const others = App.can("case.assign"), users = others ? ov.users : ov.users.filter(u => u.id === App.me.id);
    const r = await modal("Assign alert", `<label class="f" for="au">Assign to</label><select id="au">${users.map(u => `<option value="${u.id}" ${u.id === App.me.id ? "selected" : ""}>${esc(u.name)} (${esc(App.meta.roles[u.role] || u.role)})</option>`).join("")}<option value="">Nobody (unassign)</option></select>
      ${others ? "" : `<div class="hint">Your role can assign alerts to yourself only.</div>`}<label class="f" for="an">Note (optional)</label><input type="text" id="an">`,
      [{ label: "Cancel", value: null }, { label: "Assign", kind: "primary", value: el => ({ user_id: $("#au", el).value, note: $("#an", el).value.trim() }) }]);
    if (!r.value) return null; await send(r.value); return "Assignment saved.";
  }
  if (act === "convert") {
    const a = await api.get(`/api/watch/alerts/${id}`), needClaim = ["volume", "threshold", "narrative"].includes(a.kind);
    const r = await modal("Send a claim to Verify Information", `<p class="small">${needClaim ? "This alert is about activity across many posts. Choose the post whose claim you want to verify, or write the claim." : "The post's text becomes the claim to verify; its link, platform, account and publication time are copied into the case."} The alert's reason and supporting posts are added to the case as a suggested lead, so they can go into the report once accepted.</p>
      <label class="f" for="cc">Claim to verify</label><textarea id="cc" rows="4">${esc(needClaim ? "" : a.post?.text || "")}</textarea>
      ${a.related.length ? `<div class="small" style="max-height:200px;overflow:auto;margin-top:6px"><b>Supporting posts</b>${a.related.slice(0, 20).map(p => `<div class="covsug" style="margin:4px 0"><span class="sub">${esc(p.account || "")} · ${dt(p.posted_at)}</span><div>${esc(p.text.slice(0, 240))}</div><button class="btn sm ghost" type="button" data-copy="${esc(p.text)}">Use this claim</button></div>`).join("")}</div>` : ""}
      <label class="f" for="cp">Priority</label><select id="cp"><option value="routine">Routine</option><option value="priority">Priority</option><option value="urgent">Urgent</option></select>`,
      [{ label: "Cancel", value: null }, { label: "Open case", kind: "primary", validate: el => (!$("#cc", el).value.trim() ? "Write the claim to verify." : null), value: el => ({ claim_text: $("#cc", el).value.trim(), priority: $("#cp", el).value }) }],
      { wide: true, onOpen: el => $$("[data-copy]", el).forEach(b => b.onclick = () => { $("#cc", el).value = b.dataset.copy; }) });
    if (!r.value) return null; const res = await send(r.value); toast(`Case ${res.case_id} opened from the alert.`); App.go(`#/case/${res.case_id}`); return null;
  }
}
async function details(id, ov) {
  const a = await api.get(`/api/watch/alerts/${id}`), d = a.detail, p = a.post;
  const mrows = m => m.length ? `<div class="tablewrap"><table class="small"><thead><tr><th>Observed at</th><th>Source</th><th>Likes</th><th>Replies</th><th>Shares</th><th>Views</th></tr></thead><tbody>${m.map(x => `<tr><td>${dt(x.observed_at)}</td><td>${esc(x.source)}</td><td>${num(x.likes)}</td><td>${num(x.comments)}</td><td>${num(x.shares)}</td><td>${num(x.views)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small sub">No public counts were reported for this post.</p>`;
  const postBlock = x => `<div class="covsug" style="margin:6px 0"><div class="small sub">${esc(x.platform)} · ${esc(x.account || "account not stated")} · published ${dt(x.posted_at)} · ${x.first_source === "dataset" ? "imported" : "detected"} ${dt(x.first_detected_at)} by ${esc(srcName(x.first_source))}${x.url ? ` · <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ""}</div><div>${marked(x.text, x.highlights)}</div></div>`;
  const vol = a.kind === "volume" && d.mode !== "historical" ? `<h3>Matching posts per ${d.window_min}-minute window</h3>${bars(d.series)}<p class="small">Latest window: <b>${d.current}</b>. Previous ${d.baseline_windows} windows: average ${d.mean}, standard deviation ${d.sd}. Threshold: at least ${d.threshold.min_posts} posts, at least ${d.threshold.ratio}× the average and ${d.threshold.sd} standard deviations above it. Collection covered ${Math.round(d.coverage * 100)}% of the period.</p>` : "";
  await modal(`Alert ${a.id}: ${(KIND[a.kind] || [a.kind])[0]}`, `<div class="small sub">${esc(a.watchlist_name)} · raised ${dt(a.created_at)} · ${(STATUS[a.status] || [a.status])[0]}${a.assigned_name ? ` · assigned to ${esc(a.assigned_name)}` : ""}</div>
    <div class="callout info small" style="margin:8px 0"><div><b>Why this alert:</b> ${esc(a.reason)}</div></div>
    ${p ? `<h3>Post</h3>${postBlock(p)}<p class="small">${p.match ? `Matched terms: ${p.match.terms.map(t => `<b>${esc(t)}</b>`).join(", ")}. ` : ""}Language: ${esc(p.language || "not stated by the platform")}. Collected via ${esc(p.collected_via)}.</p>
      <h3>Observed engagement</h3><p class="small sub" style="margin-top:0">Public counts as the platform reported them at each collection. Views are the platform's own figure where it gives one. AIVS does not estimate reach and leaves unreported counts blank.</p>${mrows(p.metrics)}` : ""}
    ${vol}${extraDetail(a)}${a.related.length && a.kind !== "volume" ? `<h3>Posts in this group (${a.related.length})</h3>` : a.related.length ? `<h3>Posts in the latest window (${a.related.length} shown)</h3>` : ""}${a.related.map(postBlock).join("")}
    <h3>History</h3><ul class="small">${a.events.map(e => `<li>${dt(e.at)} — ${esc(e.action)}${e.action === "assigned" && e.note ? ` ${esc(e.note)}` : ""}${e.by_name ? ` by ${esc(e.by_name)}` : " (system)"}${e.note && e.action !== "assigned" ? `: ${esc(e.note)}` : ""}</li>`).join("")}</ul>`, [{ label: "Close", value: null }], { wide: true });
}
function extraDetail(a) {
  const d = a.detail || {};
  const sev = a.severity ? `<p class="small"><b>Severity:</b> ${esc(SEV[a.severity]?.[0] || a.severity)}. <b>Recommended action:</b> ${esc(d.recommended_action || "")}</p>` : "";
  if (a.kind === "repeated" && d.messages) return `${sev}<h3>Repeated messages</h3><ul class="small">${d.messages.map(m => `<li>${esc(m.text)} <span class="sub">(${m.posts} posts, ${m.accounts} accounts${m.burst_ratio ? `, ${m.burst_ratio}× usual rate` : ""})</span></li>`).join("")}</ul>`;
  if (a.kind === "coordination") return `${sev}<p class="small">${d.accounts} accounts within ${d.span_minutes} min.${d.shared_hashtags?.length ? ` Shared hashtags: ${d.shared_hashtags.map(esc).join(" ")}.` : ""}${d.shared_links?.length ? ` Shared link: ${esc(d.shared_links[0])}.` : ""}</p>`;
  if (a.kind === "narrative") return `${sev}<p class="small">Words that became frequent: ${d.terms.map(t => `<b>${esc(t)}</b>`).join(", ")}. Method: ${esc(d.method || "")}.</p>`;
  if (a.kind === "volume" && d.mode === "historical") return `${sev}<h3>Matching posts per ${d.window_min}-minute window (the alert window last)</h3>${bars(d.series)}`;
  return sev;
}
const bars = s => { const m = Math.max(1, ...s); return `<div class="wbars" role="img" aria-label="Posts per window: ${s.join(", ")}">${s.map((v, i) => `<span title="${v} posts" style="height:${Math.max(2, (v / m) * 60)}px${i === s.length - 1 ? ";background:var(--con)" : ""}"></span>`).join("")}</div>`; };

// ---------------------------------------------------------------- watchlists
function lists(body, ov) {
  const mg = App.can("watch.manage"), dsName = id => ov.datasets.find(d => d.id === id)?.name || `dataset ${id}`;
  const srcOf = w => [w.definition.all_datasets ? "All imported datasets" : (w.definition.datasets || []).map(dsName).join(", "), w.definition.sources.map(s => ov.sources[s]?.label || s).join(", ")].filter(Boolean).join(" + ") || "none chosen";
  const stChip = w => chip(w.status === "active" ? ["Active", "sup"] : w.status === "paused" ? ["Paused", "mix"] : ["Draft", "grey"]);
  body.innerHTML = `<div class="row" style="margin-bottom:12px">${mg ? `<button class="btn primary" id="nwb">New watchlist</button><button class="btn ghost" id="nw">New from the KDF template</button>` : `<span class="small sub">Reviewers and administrators create and activate watchlists.</span>`}</div>
    ${ov.watchlists.length ? `<div class="card"><div class="tablewrap"><table class="t wlt"><thead><tr><th>Name</th><th>Keywords</th><th>Data source</th><th>Status</th><th class="n">Posts</th><th>Last analysed</th><th>Actions</th></tr></thead><tbody>
      ${ov.watchlists.map(w => `<tr data-w="${w.id}"><td><a href="#/watch/list/${w.id}"><b>${esc(w.name)}</b></a>${w.description ? `<div class="tiny sub">${esc(w.description.slice(0, 90))}</div>` : ""}</td>
        <td class="small">${w.definition.terms.slice(0, 6).map(esc).join(", ")}${w.definition.terms.length > 6 ? ` <span class="sub">+${w.definition.terms.length - 6}</span>` : ""}</td><td class="small">${esc(srcOf(w))}</td>
        <td>${stChip(w)}${w.status !== "active" && !w.previewed_current ? `<div class="tiny sub">needs a preview</div>` : ""}</td><td class="n">${w.matches.toLocaleString()}${w.new_alerts ? `<div class="tiny"><a href="#/watch/alerts?watchlist=${w.id}">${w.new_alerts} new alerts</a></div>` : ""}</td>
        <td class="small">${w.last_scan_at || w.last_match_at ? dt(w.last_scan_at || w.last_match_at) : `<span class="sub">never</span>`}</td>
        <td><div class="row" style="flex-wrap:nowrap"><a class="btn sm" href="#/watch/list/${w.id}">Open</a>${mg && w.status === "active" ? `<button class="btn sm ghost" data-pause="${w.id}">Pause</button>` : ""}${mg ? `<button class="btn sm ghost" data-del="${w.id}">Delete</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div></div>`
      : `<div class="card"><div class="bd">${empty("No watchlists", "A watchlist names the keywords, hashtags or phrases to look for and the imported datasets or sources to watch.")}</div></div>`}`;
  const nw = $("#nw", body); if (nw) nw.onclick = async () => {
    try { const t = ov.template, r = await api.post("/api/watch/lists", { name: t.name, description: t.description, definition: t.definition }); toast("Draft watchlist created from the template. Review the terms, then preview."); App.go(`#/watch/list/${r.id}`); } catch (e) { fail(e); }
  };
  const nwb = $("#nwb", body); if (nwb) nwb.onclick = () => newWatchlist(ov);
  $$("[data-pause]", body).forEach(b => b.onclick = async () => { try { await api.post(`/api/watch/lists/${b.dataset.pause}/status`, { status: "paused" }); toast("Paused."); render($("#page"), ["lists"]); } catch (e) { fail(e); } });
  $$("[data-del]", body).forEach(b => b.onclick = () => del(b.dataset.del, ov));
}
async function del(id, ov) {
  const w = ov.watchlists.find(x => String(x.id) === String(id));
  const r = await modal("Delete watchlist", `<p>Delete “${esc(w?.name || id)}”? It stops at once and disappears from the lists. Its matched posts, alert history and any cases opened from it are kept, and its open alerts are closed with the note “Watchlist deleted”.</p>`, [{ label: "Cancel", value: null }, { label: "Delete", kind: "danger", value: true }]);
  if (!r.value) return; try { await api.del(`/api/watch/lists/${id}`); toast("Watchlist deleted."); App.go("#/watch/lists"); render($("#page"), ["lists"]); } catch (e) { fail(e); }
}
async function newWatchlist(ov) {
  const dsOpts = ov.datasets.length ? ov.datasets.map(d => `<label class="small" style="display:block;margin:3px 0"><input type="checkbox" name="nds" value="${d.id}"> ${esc(d.name)} <span class="sub">(${(d.posts || 0).toLocaleString()} posts${d.first_at ? `, ${esc(d.first_at.slice(0, 10))} to ${esc((d.last_at || "").slice(0, 10))}` : ""})</span></label>`).join("") : `<p class="small sub">No dataset imported yet. Choose “All imported datasets” to check every future import.</p>`;
  const r = await modal("New watchlist", `<label class="f" for="nn">Name</label><input type="text" id="nn" placeholder="For example: Election misinformation">
    <label class="f" for="nd">Description</label><input type="text" id="nd" placeholder="What this watchlist is for">
    <label class="f" for="nt">Keywords, hashtags and phrases (one per line)</label><textarea id="nt" rows="5" placeholder="election&#10;IEBC&#10;voting&#10;ballot&#10;#Election2026"></textarea>
    <label class="f">Imported datasets to monitor</label><label class="small" style="display:block;margin:3px 0"><input type="checkbox" id="nall" checked> <b>All imported datasets</b>, including future imports</label><div id="ndl">${dsOpts}</div>
    <div class="fgrid" style="margin-top:6px"><div><label class="f" for="nc">Alert when at least … matching posts</label><input type="number" id="nc" value="10" min="1"></div><div><label class="f" for="nw2">… within minutes</label><input type="number" id="nw2" value="60" min="5"></div></div>
    <p class="hint">Unusual spikes, emerging narratives, repeated messages and coordination indicators are also checked, with the default thresholds (editable on the watchlist's page).</p>`,
    [{ label: "Cancel", value: null }, { label: "Create", kind: "primary", validate: el => (!$("#nn", el).value.trim() ? "Give it a name." : !splitLines($("#nt", el).value).length ? "Add at least one keyword." : !$("#nall", el).checked && !$$("input[name=nds]:checked", el).length ? "Choose at least one dataset, or all datasets." : null),
      value: el => ({ name: $("#nn", el).value.trim(), description: $("#nd", el).value.trim(), definition: { terms: splitLines($("#nt", el).value), all_datasets: $("#nall", el).checked, datasets: $$("input[name=nds]:checked", el).map(x => +x.value), sources: [], alert_mode: "signals_only", thresholds: { count_min_posts: +$("#nc", el).value || 10, count_window_min: +$("#nw2", el).value || 60 } } }) }],
    { wide: true, onOpen: el => { const sync = () => $$("input[name=nds]", el).forEach(x => (x.disabled = $("#nall", el).checked)); $("#nall", el).onchange = sync; sync(); } });
  if (!r.value) return;
  try { const c = await api.post("/api/watch/lists", r.value); toast("Watchlist created. Preview its matches, then activate it."); App.go(`#/watch/list/${c.id}`); } catch (e) { fail(e); }
}
const lines = a => (a || []).join("\n");
const splitLines = v => v.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
async function listView(body, ov, id) {
  const d = await api.get(`/api/watch/lists/${id}`), w = d.watchlist, def = w.definition, edit = App.can("watch.manage"), th = def.thresholds;
  crumbs(`<a href="#/watch">AI Watchlist</a> / ${esc(w.name)}`);
  const srcOpt = s => { const info = ov.status.sources.find(x => x.key === s); return `<label class="small" style="display:block;margin:4px 0"><input type="checkbox" name="src" value="${s}" ${def.sources.includes(s) ? "checked" : ""} ${edit ? "" : "disabled"}> ${esc(ov.sources[s].label)} ${chip(SRC_STATE[info.state] || [info.state, "grey"])}${info.needs && info.state !== "ready" ? `<span class="sub" title="${esc(info.needs)}"> — see Sources and status</span>` : ""}</label>`; };
  const num2 = (k, l, step = 1) => `<div><label class="f" for="t_${k}" style="margin-top:0">${l}</label><input type="number" step="${step}" id="t_${k}" value="${th[k]}" ${edit ? "" : "disabled"}></div>`;
  const v = d.volume, hasDs = !!(def.all_datasets || def.datasets?.length);
  const dsBox = `<label class="f">Imported datasets to monitor <span class="sub">(Social Media Analysis)</span></label>
        <label class="small" style="display:block;margin:3px 0"><input type="checkbox" id="wall" ${def.all_datasets ? "checked" : ""} ${edit ? "" : "disabled"}> <b>All imported datasets</b>, including future imports</label>
        ${ov.datasets.map(x => `<label class="small" style="display:block;margin:3px 0"><input type="checkbox" name="wds" value="${x.id}" ${(def.datasets || []).includes(x.id) ? "checked" : ""} ${edit && !def.all_datasets ? "" : "disabled"}> ${esc(x.name)} <span class="sub">(${(x.posts || 0).toLocaleString()} posts)</span></label>`).join("") || `<p class="small sub" style="margin:2px 0">No dataset imported yet.</p>`}
        <div class="hint">Each new import or addition to a chosen dataset is checked automatically while the watchlist is active. This is analysis of the posting times in the data, not live monitoring.</div>`;
  body.innerHTML = `<div class="row" style="margin-bottom:10px;flex-wrap:wrap">${chip(w.status === "active" ? ["Active", "sup"] : w.status === "paused" ? ["Paused", "mix"] : ["Draft", "grey"])}<span class="small sub">Created ${dt(w.created_at)}${w.activated_at ? ` · activated ${dt(w.activated_at)}` : ""} · definition ${esc(w.definition_sha256.slice(0, 12))}</span>
      <span class="right row">${edit && w.status === "active" && hasDs ? `<button class="btn" id="wScan">Analyse datasets now</button>` : ""}${edit && w.status !== "active" ? `<button class="btn primary" id="wAct" ${w.previewed_current ? "" : "disabled title=\"Preview the current terms first\""}>Activate</button>` : ""}${edit && w.status === "active" ? `<button class="btn" id="wPause">Pause</button>` : ""}${edit ? `<button class="btn ghost danger" id="wDel">Delete</button>` : ""}</span></div>
    ${w.status !== "active" ? `<div class="callout ${w.previewed_current ? "info" : "warn"}" style="margin-bottom:12px"><div>${w.previewed_current ? `Previewed ${dt(w.preview?.at)}: ${w.preview?.local?.matched ?? 0} of ${w.preview?.local?.checked ?? 0} stored posts and examples matched${w.preview?.live ? `; live sample: ${w.preview.live.map(l => `${esc(l.label)} ${l.error ? "failed" : `${l.matched} of ${l.fetched}`}`).join(", ")}` : ""}. You can activate it.` : "Preview the matches for the current terms before activating. Any change to the terms or rules needs a new preview."}</div></div>` : ""}
    <div class="card" id="wan" style="margin-bottom:14px"><div class="hd"><h3>Analysis</h3><span class="small sub right" id="wanNote"></span></div><div class="bd" id="wanb"><span class="spin"></span></div></div>
    <div class="split"><div class="stack">
      <form class="card" id="wf"><div class="hd"><h3>Definition</h3></div><div class="bd">
        <label class="f" for="wn">Name</label><input type="text" id="wn" value="${esc(w.name)}" ${edit ? "" : "disabled"}>
        <label class="f" for="wd">Description</label><input type="text" id="wd" value="${esc(w.description || "")}" ${edit ? "" : "disabled"}>
        <label class="f" for="wa">Basis for collecting these public posts</label><input type="text" id="wa" value="${esc(w.authorisation || "")}" placeholder="For example: X and YouTube API terms; unit information operations policy, approval reference" ${edit ? "" : "disabled"}>
        <div class="fgrid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
          <div><label class="f" for="wt">Terms to watch for (one per line)</label><textarea id="wt" rows="9" ${edit ? "" : "disabled"}>${esc(lines(def.terms))}</textarea><div class="hint">Spelling variants, English and Kiswahili names, #hashtags. A term also matches the same word as a hashtag. A line with spaces is a phrase.</div></div>
          <div><label class="f" for="wc">Must also contain one of (optional)</label><textarea id="wc" rows="4" ${edit ? "" : "disabled"}>${esc(lines(def.context))}</textarea><div class="hint">Leave empty to keep every post with a term.</div>
            <label class="f" for="wx">Rule out posts containing</label><textarea id="wx" rows="4" ${edit ? "" : "disabled"}>${esc(lines(def.exclude))}</textarea><div class="hint">Removes unrelated uses, for example “kdf file”.</div></div></div>
        <label class="f">Languages</label><div class="small"><label><input type="checkbox" name="lang" value="en" ${def.languages.includes("en") ? "checked" : ""} ${edit ? "" : "disabled"}> English</label> <label style="margin-left:12px"><input type="checkbox" name="lang" value="sw" ${def.languages.includes("sw") ? "checked" : ""} ${edit ? "" : "disabled"}> Kiswahili</label> <span class="sub">— none ticked means any language. Posts whose language the platform does not state are kept.</span></div>
        ${dsBox}
        <details style="margin-top:10px" ${def.sources.length ? "open" : ""}><summary class="small"><b>Live sources</b> (platform APIs and feeds; need credentials)</summary>
        <label class="f">Sources</label>${Object.keys(ov.sources).map(srcOpt).join("")}
        <label class="f" for="wfeeds">News feeds (one per line; RSS or Atom)</label><textarea id="wfeeds" rows="2" ${edit ? "" : "disabled"}>${esc(lines(def.feeds))}</textarea>
        <label class="f" for="wfb">Facebook Pages to read (one per line: Page username, ID or facebook.com link)</label><textarea id="wfb" rows="2" ${edit ? "" : "disabled"} placeholder="Only public Pages; Facebook cannot be searched as a whole">${esc(lines(def.fb_pages))}</textarea>
        <label class="small" style="display:block;margin-top:4px"><input type="checkbox" id="wfbc" ${def.fb_comments === false ? "" : "checked"} ${edit ? "" : "disabled"}> Also read public comments on those Pages' recent posts (commenters' names are not collected)</label>
        <div class="fgrid" style="margin-top:6px">
          ${Object.entries(ov.sources).filter(([, x]) => x.mode === "poll").map(([k, x]) => `<div><label class="f" for="i_${k}">${esc(k === "x_search" ? "X search" : k === "news" ? "News" : x.platform)} every (min)</label><input type="number" id="i_${k}" value="${def.intervals[k] ?? ""}" ${edit ? "" : "disabled"}></div>`).join("")}
          <div><label class="f" for="wl">First look-back (min)</label><input type="number" id="wl" value="${def.lookback_minutes}" ${edit ? "" : "disabled"}></div></div>
        </details>
        <label class="small" style="display:block;margin-top:8px"><input type="checkbox" id="wr" ${def.include_reposts ? "checked" : ""} ${edit ? "" : "disabled"}> Include reposts (counted for volume; never alerted one by one)</label>
        <label class="f" for="wm">Alerts</label><select id="wm" ${edit ? "" : "disabled"}><option value="every_post" ${def.alert_mode === "every_post" ? "selected" : ""}>An alert for every new matching post, plus signals</option><option value="signals_only" ${def.alert_mode === "signals_only" ? "selected" : ""}>Only signals (repeated wording, volume, engagement); posts are listed below</option></select>
        <details style="margin-top:10px"><summary class="small"><b>Signal thresholds</b> (what raises a repeated-wording, volume or engagement alert)</summary>
          <div class="fgrid" style="margin-top:6px">${num2("count_min_posts", "Keyword threshold: posts")}${num2("count_window_min", "…within minutes")}
            ${num2("narrative_min_posts", "Narrative: posts")}${num2("narrative_window_h", "…per window (hours)")}${num2("narrative_ratio", "…× the usual rate", 0.5)}${num2("narrative_sd", "…standard deviations above", 0.5)}${num2("narrative_baseline_windows", "…after windows of history")}
            ${num2("coord_min_accounts", "Coordination: accounts")}${num2("coord_window_min", "…within minutes")}${num2("repeat_burst_ratio", "Repeated (datasets): × usual rate", 0.5)}
            ${num2("repeat_min_posts", "Repeated: posts")}${num2("repeat_min_accounts", "…from accounts")}${num2("repeat_window_h", "…within hours")}${num2("repeat_similarity", "…similarity (0.5–1)", 0.05)}
            ${num2("volume_window_min", "Volume: window (min)")}${num2("volume_baseline_windows", "…compared with windows")}${num2("volume_min_posts", "…at least posts")}${num2("volume_ratio", "…× the average", 0.1)}${num2("volume_sd", "…standard deviations above", 0.5)}${num2("volume_min_coverage", "…collection coverage needed", 0.05)}
            ${num2("engagement_min_increase", "Engagement: increase of")}${num2("engagement_ratio", "…and × earlier", 0.1)}${num2("engagement_window_h", "…within hours")}</div>
          <p class="hint">Imported datasets: a spike compares each window with the windows before it in the data (volume settings above); a narrative is a set of words that suddenly becomes frequent; repeated wording must be concentrated in time; coordination looks for many accounts posting the same text within minutes. Live sources: volume is compared only when the watchlist has collected for the whole comparison period and collection succeeded for enough of it; otherwise no volume alert is raised. Engagement compares the public counts the platform reported at two collection times.</p></details>
        ${edit ? `<div class="row" style="margin-top:12px"><button class="btn primary" type="submit">Save</button><span class="small sub">Saving changed terms or rules returns an active watchlist to draft until it is previewed and activated again.</span></div>` : ""}
      </div></form>
      <div class="card"><div class="hd"><h3>Matched posts</h3><span class="small sub right" id="mcount"></span></div><div class="bd" id="mp"><span class="spin"></span></div></div>
    </div><div class="stack">
      ${edit ? `<div class="card"><div class="hd"><h3>Try examples</h3></div><div class="bd"><textarea id="ex" rows="4" placeholder="Paste example posts, one per line, to see whether they would match and why"></textarea><div id="exr" class="small" style="margin-top:6px"></div><div id="qx" class="small sub" style="margin-top:6px"></div></div></div>
      <div class="card"><div class="hd"><h3>Preview before activating</h3></div><div class="bd small">
        <p style="margin-top:0">Checks the saved terms against posts already stored in AIVS (earlier collection and imported datasets) and the examples above. Nothing is collected or alerted.</p>
        <label><input type="checkbox" id="pl"> Also fetch a live sample from each chosen source (one request per source; X charges per post returned, about $${(0.005 * 25).toFixed(2)} for 25 posts; one of YouTube's 100 daily searches)</label>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="pv">Preview matches</button></div><div id="pvr" style="margin-top:8px"></div></div></div>` : ""}
      <div class="card"><div class="hd"><h3>Collection</h3></div><div class="bd small">${d.sources.length ? d.sources.map(s => `<div style="margin:6px 0"><b>${esc(s.label)}</b> ${s.ready ? "" : chip(["Not connected", "grey"])} ${s.state ? chip([s.state.status.replace(/_/g, " "), s.state.status === "ok" ? "sup" : ["retrying", "rate_limited", "budget_reached"].includes(s.state.status) ? "mix" : s.state.status === "not_permitted" || s.state.status === "error" ? "con" : "grey"]) : ""}
          <div class="sub">${s.state ? `Last run ${dt(s.state.last_run_at)}${s.state.last_found != null ? `, ${s.state.last_found} matching, ${s.state.last_new} new` : ""}${s.state.next_run_at && s.source !== "x_stream" ? ` · next ${dt(s.state.next_run_at)}` : ""}${s.state.last_error ? `<br>${esc(s.state.last_error)}` : ""}` : s.source === "x_stream" ? `Stream: ${esc(ov.status.stream.status || "off")}` : "Not run yet."}</div>
          ${edit && w.status === "active" && s.source !== "x_stream" && s.ready ? `<button class="btn sm ghost" data-run="${s.source}">Run now</button>` : ""}</div>`).join("") : "No sources chosen."}
        <p class="hint">${esc(ov.caveats[1])}</p></div></div>
      ${def.sources.length ? `<div class="card"><div class="hd"><h3>Live volume</h3></div><div class="bd small">${v.sufficient ? `${bars(v.series)}<p>Latest ${v.window_min} min: <b>${v.current}</b> posts; previous ${v.baseline_windows} windows average ${v.mean} (SD ${v.sd}). Collection coverage ${Math.round(v.coverage * 100)}%. ${v.spike ? "<b>Above the threshold.</b>" : "Within the usual range."}</p>` : `<p style="margin-top:0">Not enough history to judge unusual volume: ${esc(v.insufficient_reason)}.</p>`}</div></div>` : ""}
      <div class="card"><div class="hd"><h3>Platform queries</h3></div><div class="bd small"><div><b>X search</b> (${d.queries.x.length}/${d.queries.x.max} characters)${d.queries.x.ok ? "" : ` ${chip(["too long", "con"])}`}<div class="mono" style="overflow-wrap:anywhere">${esc(d.queries.x.query)}</div></div>
        <div style="margin-top:6px"><b>X stream rule</b> (${d.queries.x_stream.length}/${d.queries.x_stream.max})</div><div style="margin-top:6px"><b>YouTube</b><div class="mono" style="overflow-wrap:anywhere">${esc(d.queries.youtube.query)}</div><div class="sub">${esc(d.queries.youtube.note)}</div></div></div></div>
      ${App.can("watch.triage") ? `<div class="card"><div class="hd"><h3>Submit a public link</h3></div><div class="bd small">
        <p style="margin-top:0">For a post on a platform AIVS cannot collect from (for example Facebook outside the listed Pages, TikTok or LinkedIn). It is added only if it matches this watchlist, and is labelled “submitted by” you.</p>
        <label class="f" for="slu">Public link</label><input type="url" id="slu" placeholder="https://…">
        <label class="f" for="slt">Text of the post (needed when the platform's public embed does not give it)</label><textarea id="slt" rows="2"></textarea>
        <button class="btn sm" id="slGo" style="margin-top:8px">Add to this watchlist</button></div></div>` : ""}
      ${edit ? `<div class="card"><div class="hd"><h3>Import a file</h3></div><div class="bd small">
        <p style="margin-top:0">CSV, JSON or Excel export you are permitted to use (columns such as text, account, created_at, url, platform, likes). Only rows that match this watchlist are kept; each is labelled with the file's name and fingerprint.</p>
        <label class="f" for="imf">File</label><input type="file" id="imf" accept=".csv,.json,.jsonl,.xlsx">
        <label class="f" for="ima">Where it comes from and why you may use it</label><input type="text" id="ima" placeholder="For example: export from our own Facebook Page insights">
        <label class="f" for="imp">Platform (if the file has no platform column)</label><input type="text" id="imp" placeholder="For example: Facebook">
        <button class="btn sm" id="imGo" style="margin-top:8px">Import</button></div></div>` : ""}
      <div class="card"><div class="hd"><h3>Coverage gaps (last 7 days)</h3></div><div class="bd small">${(() => { const g = d.runs.filter(r => ["failed", "skipped", "interrupted", "partial"].includes(r.status) && Date.parse(r.started_at) > Date.now() - 7 * 864e5);
        return g.length ? `<p style="margin-top:0">Periods or runs in which collection did not fully succeed. Posts from these periods may be missing.</p><ul style="margin:0 0 0 16px">${g.slice(0, 15).map(r => `<li>${dt(r.window_from || r.started_at)} – ${dt(r.window_to || r.finished_at)}: ${esc(srcName(r.source))} ${chip(RUNSTATE[r.status] || [r.status, "grey"])} ${esc((r.error || r.note || "").slice(0, 140))}</li>`).join("")}</ul>` : `<p style="margin:0">No failed, skipped or partial collection recorded. This does not mean every post was captured: platforms only return what their APIs provide.</p>`; })()}</div></div>
      <div class="card"><div class="hd"><h3>Recent runs</h3></div><div class="bd"><div class="tablewrap"><table class="small"><thead><tr><th>Started</th><th>Source</th><th>Result</th><th>Fetched</th><th>Matched</th><th>New</th></tr></thead><tbody>
        ${d.runs.length ? d.runs.slice(0, 20).map(r => `<tr title="${esc([r.note, r.error].filter(Boolean).join(" — "))}"><td>${dt(r.started_at)}</td><td>${esc(r.source)}${r.kind !== "scheduled" ? ` <span class="sub">(${esc(r.kind)})</span>` : ""}</td><td>${chip(RUNSTATE[r.status] || [r.status, "grey"])}${r.error ? `<div class="sub">${esc(r.error.slice(0, 120))}</div>` : r.note ? `<div class="sub">${esc(r.note.slice(0, 120))}</div>` : ""}</td><td>${r.fetched}</td><td>${r.matched}</td><td>${r.new_posts}</td></tr>`).join("") : `<tr><td colspan="6" class="sub">No runs yet.</td></tr>`}</tbody></table></div></div></div>
      <div class="card"><div class="hd"><h3>History</h3></div><div class="bd small"><ul style="margin:0 0 0 16px">${d.versions.map(x => `<li>${dt(x.changed_at)} — ${esc(x.note || x.status)}${x.by_name ? ` by ${esc(x.by_name)}` : ""} <span class="sub mono">${esc(x.definition_sha256.slice(0, 10))}</span></li>`).join("")}</ul></div></div>
    </div></div>`;
  if (!body.isConnected) return; // the user moved to another page while this one was loading
  const collect = () => ({ name: $("#wn").value.trim(), description: $("#wd").value.trim(), authorisation: $("#wa").value.trim(), definition: { terms: splitLines($("#wt").value), context: splitLines($("#wc").value), exclude: splitLines($("#wx").value),
    languages: $$("input[name=lang]:checked").map(x => x.value), all_datasets: $("#wall").checked, datasets: $$("input[name=wds]:checked").map(x => +x.value), sources: $$("input[name=src]:checked").map(x => x.value), feeds: splitLines($("#wfeeds").value), fb_pages: splitLines($("#wfb").value), fb_comments: $("#wfbc").checked, include_reposts: $("#wr").checked, alert_mode: $("#wm").value,
    intervals: Object.fromEntries(Object.keys(ov.sources).filter(k => k !== "x_stream" && $(`#i_${k}`)?.value).map(k => [k, +$(`#i_${k}`).value])), lookback_minutes: +$("#wl").value, thresholds: Object.fromEntries(Object.keys(th).map(k => [k, +$(`#t_${k}`).value])) } });
  const reload = () => render($("#page"), ["list", String(w.id)]);
  if (edit) {
    $("#wf").onsubmit = async e => { e.preventDefault(); try { const r = await api.patch(`/api/watch/lists/${w.id}`, collect()); toast(r.returned_to_draft ? "Saved. The terms changed, so the watchlist is back in draft: preview, then activate again." : "Saved."); reload(); } catch (er) { fail(er); } };
    let tmr; const tryEx = () => { clearTimeout(tmr); tmr = setTimeout(async () => { if (!$("#ex")) return; try { const r = await api.post("/api/watch/test", { definition: collect().definition, samples: $("#ex").value });
      if (!$("#exr")) return; $("#exr").innerHTML = r.results.map(x => `<div class="covsug" style="margin:4px 0">${x.matched ? chip(["would match", "sup"]) : chip(["no match", "grey"])} ${marked(x.text, x.highlights)}${x.why ? `<div class="sub">${esc(x.why)}</div>` : ""}</div>`).join("");
      $("#qx").innerHTML = `X query with these terms: ${r.queries.x.length}/${r.queries.x.max} characters${r.queries.x.ok ? "" : ` — ${esc(r.queries.x.problem)}`}`; } catch (er) { const x = $("#exr"); if (x) x.textContent = er.message; } }, 300); };
    $("#ex").oninput = tryEx; $("#wf").addEventListener("input", e => { if ($("#ex").value.trim() && e.target.id !== "ex") tryEx(); });
    $("#pv").onclick = async () => {
      const b = $("#pv"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Previewing…';
      try {
        const r = await api.post(`/api/watch/lists/${w.id}/preview`, { samples: $("#ex").value, live: $("#pl").checked }), L = r.local;
        const row = x => `<div class="covsug" style="margin:4px 0"><div class="sub">${esc(x.origin || x.platform || "")}${x.account ? ` · ${esc(x.account)}` : ""}${x.posted_at ? ` · ${dt(x.posted_at)}` : ""}${x.url ? ` · <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ""}</div>${x.highlights ? marked(x.text, x.highlights) : esc(x.text)}${x.why ? `<div class="sub">Not kept: ${esc(x.why)}</div>` : ""}</div>`;
        $("#pvr").innerHTML = `<p><b>${L.matched}</b> of ${L.checked} stored posts and examples match; <b>${L.excluded}</b> contain a term but are ruled out.</p>
          ${L.matches.length ? `<details open><summary>Matches (${L.matches.length} shown)</summary>${L.matches.map(row).join("")}</details>` : ""}${L.excluded_examples.length ? `<details><summary>Ruled out (${L.excluded_examples.length} shown)</summary>${L.excluded_examples.map(row).join("")}</details>` : ""}
          ${(r.live || []).map(l => `<details open><summary><b>${esc(l.label)}</b>: ${l.error ? `<span class="chip con">failed</span> ${esc(l.error)}` : `${l.matched} of ${l.fetched} fetched would be kept`}</summary>${l.note ? `<div class="sub">${esc(l.note)}</div>` : ""}${l.posts.map(x => `<div class="covsug" style="margin:4px 0">${x.matched ? chip(["kept", "sup"]) : chip(["not kept", "grey"])} <span class="sub">${esc(x.account || "")} ${dt(x.posted_at)}${x.url ? ` · <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ""}</span><div>${esc(x.text)}</div>${x.why ? `<div class="sub">${esc(x.why)}</div>` : ""}</div>`).join("")}</details>`).join("")}
          <div class="row" style="margin-top:8px"><button class="btn sm primary" id="pvDone">Done, show the activate button</button></div>`;
        $("#pvDone").onclick = reload;
      } catch (e) { fail(e); } finally { b.disabled = false; b.textContent = "Preview matches"; }
    };
    const act = $("#wAct"); if (act) act.onclick = async () => { try { const r = await api.post(`/api/watch/lists/${w.id}/status`, { status: "active" }); const ds = r.datasets?.scans ? ` Checked ${r.datasets.scans.reduce((a, x) => a + x.checked, 0).toLocaleString()} imported posts: ${r.datasets.scans.reduce((a, x) => a + x.matched, 0).toLocaleString()} matching, ${r.datasets.analysis.total} new alert(s).` : ""; toast(`Activated.${ds}${r.not_connected.length ? ` Not connected, so not collecting: ${r.not_connected.join(", ")}.` : def.sources.length ? " Collection starts within a minute." : ""}`); reload(); refreshNavCounts(); } catch (e) { fail(e); } };
    $("#wall").onchange = () => $$("input[name=wds]").forEach(x => (x.disabled = $("#wall").checked));
    const sc = $("#wScan"); if (sc) sc.onclick = async () => { sc.disabled = true; sc.innerHTML = '<span class="spin"></span> Analysing…'; try { const r = await api.post(`/api/watch/lists/${w.id}/analyse`, {}); toast(`${r.scans.reduce((a, x) => a + x.checked, 0).toLocaleString()} new posts checked; ${r.analysis.total} new alert(s).`); reload(); refreshNavCounts(); } catch (e) { fail(e); sc.disabled = false; } };
    $("#wDel").onclick = () => del(w.id, ov);
    const ps = $("#wPause"); if (ps) ps.onclick = async () => { try { await api.post(`/api/watch/lists/${w.id}/status`, { status: "paused" }); toast("Paused. Nothing is collected until it is activated again."); reload(); } catch (e) { fail(e); } };
    $$("[data-run]").forEach(b => b.onclick = async () => { b.disabled = true; b.innerHTML = '<span class="spin"></span> Running…'; try { const r = await api.post(`/api/watch/lists/${w.id}/run`, { source: b.dataset.run }); toast(r.error ? `Run failed: ${r.error}` : r.skipped ? `Skipped: ${r.skipped}` : `${r.matched} matching posts, ${r.new_matches} new, ${r.alerts} alerts.`, r.error ? "err" : ""); reload(); } catch (e) { fail(e); b.disabled = false; } });
  }
  const sl = $("#slGo"); if (sl) sl.onclick = async () => { sl.disabled = true; try { const r = await api.post(`/api/watch/lists/${w.id}/submit`, { url: $("#slu").value.trim(), text: $("#slt").value.trim() }); toast(`Added (${r.platform}; text: ${r.text_basis}).`); reload(); } catch (e) { fail(e); sl.disabled = false; } };
  const im = $("#imGo"); if (im) im.onclick = async () => {
    const f = $("#imf").files[0]; if (!f) return toast("Choose a file first.", "err");
    const fd = new FormData(); fd.append("file", f); fd.append("authorisation", $("#ima").value.trim()); fd.append("platform", $("#imp").value.trim());
    im.disabled = true; try { const r = await api.upload(`/api/watch/lists/${w.id}/import`, fd); toast(`${r.rows} rows read; ${r.new_matches} new matching posts added; ${r.not_confirmed} did not match.`); reload(); } catch (e) { fail(e); im.disabled = false; }
  };
  loadMatches(w, 0); loadAnalytics(w);
}
// analytics computed by the server from the matched posts: trend, spikes, sentiment, terms, narratives, alert history
const SCOL = { positive: "var(--sup)", negative: "var(--con)", mixed: "var(--mix)", neutral: "var(--line-strong)", "not classified": "var(--unr-bg)" };
async function loadAnalytics(w) {
  let a; try { a = await api.get(`/api/watch/lists/${w.id}/analytics`); } catch (e) { const b = $("#wanb"); if (b) b.textContent = e.message; return; }
  const box = $("#wanb"); if (!box) return;
  if (!a.posts) { box.innerHTML = `<p class="small sub" style="margin:0">No matching posts yet. ${w.status === "active" ? "Import a dataset in Social Media Analysis, or analyse the datasets again." : "Preview and activate the watchlist: the chosen datasets are checked straight away."}</p>`; return; }
  $("#wanNote").textContent = `${a.posts.toLocaleString()} matching posts (${a.from_datasets.toLocaleString()} from imported datasets, ${a.collected.toLocaleString()} collected live)${a.first_at ? ` · ${a.first_at.slice(0, 10)} to ${a.last_at.slice(0, 10)}` : ""}`;
  const max = Math.max(1, ...a.trend.points.map(p => p.n)), S = a.sentiment.counts, tot = Object.values(S).reduce((x, y) => x + y, 0) || 1, order = ["positive", "neutral", "mixed", "negative", "not classified"];
  const vmax = Math.max(1, ...a.volume.counts), spikes = new Set(a.volume.spikes.map(i => i - a.volume.offset)), tmax = Math.max(1, ...a.top_terms.map(t => t.count));
  box.innerHTML = `<div class="grid g2">
    <div><h4 style="margin:0">Matching posts per ${a.trend.unit}</h4><div class="wtrend" role="img" aria-label="Matching posts per ${a.trend.unit}">${a.trend.points.map(p => `<span title="${esc(p.t.slice(0, a.trend.unit === "day" ? 10 : 13).replace("T", " "))}: ${p.n} posts" style="height:${Math.max(2, (p.n / max) * 88)}px"></span>`).join("")}</div>
      <div class="tiny sub">${esc(a.trend.points[0]?.t.slice(0, 10) || "")} → ${esc(a.trend.points.at(-1)?.t.slice(0, 10) || "")}</div>
      <h4 style="margin:12px 0 0">Unusual spikes <span class="sub small">(${a.volume.window_min}-minute windows; red: above the threshold)</span></h4>${a.volume.sufficient ? `<div class="wtrend" style="height:60px" role="img" aria-label="Posts per window, spikes in red">${a.volume.counts.map((c, i) => `<span class="${spikes.has(i) ? "spike" : ""}" title="${c} posts" style="height:${Math.max(1, (c / vmax) * 58)}px"></span>`).join("")}</div>` : `<p class="small sub">${esc(a.volume.insufficient_reason || "")}</p>`}</div>
    <div><h4 style="margin:0">Sentiment</h4><div class="wsent">${order.filter(k => S[k]).map(k => `<span style="width:${(S[k] / tot) * 100}%;background:${SCOL[k]}" title="${k}: ${S[k]}"></span>`).join("")}</div>
      <div class="wlegend">${order.filter(k => S[k]).map(k => `<span><i style="background:${SCOL[k]}"></i>${esc(k)} ${Math.round((S[k] / tot) * 100)}% (${S[k]})</span>`).join("")}</div>
      <p class="tiny sub">${esc(a.sentiment.note)}</p>
      <h4 style="margin:12px 0 4px">Top keywords</h4><div class="wterms">${a.top_terms.slice(0, 8).map(t => `<span>${esc(t.term)}</span><span class="bar"><i style="width:${(t.count / tmax) * 100}%"></i></span><span class="sub">${t.count}</span>`).join("")}</div></div></div>
    <h4 style="margin:14px 0 4px">Recurring narratives <span class="sub small">(${esc(a.narratives.method)}; read the examples)</span></h4>
    ${a.narratives.topics.length ? `<div class="grid g2">${a.narratives.topics.slice(0, 6).map(t => `<div class="covsug"><b>${esc(t.label)}</b> <span class="sub">${t.posts} posts</span><div class="tiny sub">${t.terms.slice(0, 8).map(esc).join(", ")}</div>${t.examples.slice(0, 2).map(x => `<div class="small" style="margin-top:4px">“${esc(x.text.slice(0, 160))}” <span class="sub">${esc(x.account || "")} · ${dt(x.posted_at)}</span></div>`).join("")}</div>`).join("")}</div>` : `<p class="small sub">Too few matching posts to group (about 24 or more are needed).</p>`}
    <h4 style="margin:14px 0 4px">Alert history</h4>${a.alerts.recent.length ? `<ul class="mini">${a.alerts.recent.map(x => `<li>${chip(KIND[x.kind] || [x.kind, "grey"])}${x.severity ? chip([SEV[x.severity]?.[0] || x.severity, SEV[x.severity]?.[1] || "grey"]) : ""}<a href="#/watch/alerts?watchlist=${w.id}&status=all" style="flex:1" class="small">${esc(x.title)}</a><span class="tiny sub">${esc(x.status)} · ${dt(x.created_at)}</span></li>`).join("")}</ul>` : `<p class="small sub" style="margin:0">No alerts yet.</p>`}
    <p class="hint">${esc(a.note)}</p>`;
}
async function loadMatches(w, offset) {
  const r = await api.get(`/api/watch/lists/${w.id}/matches?limit=20&offset=${offset}`), box = $("#mp"), cnt = $("#mcount"); if (!box || !cnt) return;
  cnt.textContent = `${r.total} post${r.total === 1 ? "" : "s"}`;
  box.innerHTML = r.posts.length ? r.posts.map(p => `<div class="covsug" style="margin:6px 0"><div class="small sub">${esc(p.platform)} · ${esc(p.account || "not stated")} · published ${dt(p.posted_at)} · ${p.source === "dataset" ? "checked" : "detected"} ${dt(p.detected_at)} by ${esc(srcName(p.source))}${p.is_repost ? " · repost" : ""}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ""}</div><div>${marked(p.text, p.highlights)}</div></div>`).join("")
    + `<div class="row">${offset > 0 ? `<button class="btn sm" id="mpPrev">Newer</button>` : ""}${offset + r.limit < r.total ? `<button class="btn sm" id="mpNext">Older</button>` : ""}</div>` : `<p class="small sub" style="margin:0">No matched posts yet.</p>`;
  const pv = $("#mpPrev"), nx = $("#mpNext"); if (pv) pv.onclick = () => loadMatches(w, Math.max(0, offset - r.limit)); if (nx) nx.onclick = () => loadMatches(w, offset + r.limit);
}

// ---------------------------------------------------------------- sources and status
const PSTATUS = { working: "sup", "needs configuration": "grey", restricted: "mix", unavailable: "con" };
function sources(body, ov) {
  const s = ov.status, b = s.budgets, st = s.stream, admin = App.can("settings.manage");
  const liveCell = p => p.connectors_state.length ? p.connectors_state.map(c => `<div style="margin-bottom:4px"><span class="sub">${esc(c.label)}:</span> ${c.live_check ? `${chip(c.live_check.ok ? ["passed", "sup"] : ["failed", "con"])} ${dt(c.live_check.at)}${c.live_check.note ? `<div class="sub">${esc(String(c.live_check.note).slice(0, 160))}</div>` : ""}` : `<span class="sub">not verified live (simulated tests only)</span>`}
      ${admin && c.state === "ready" ? `<button class="btn sm ghost" data-check="${esc(c.key)}">Test connection</button>` : ""}</div>`).join("") : `<span class="sub">no connector</span>`;
  body.innerHTML = `<div class="callout warn" style="margin-bottom:12px"><div><b>What this can and cannot see.</b><ul style="margin:6px 0 0 18px">${ov.caveats.map(c => `<li>${esc(c)}</li>`).join("")}</ul></div></div>
    <div class="card" style="margin-bottom:14px"><div class="hd"><h3>Platforms: what their official APIs allow</h3><span class="small sub right">Documentation checked ${esc(s.docs_checked)}</span></div><div class="bd">
      <p class="small" style="margin-top:0">A platform listed here does not mean AIVS can search all of it. Each row says what its official API provides, what access it needs, and whether the connector works on this server now. <b>Working</b>: configured and collected successfully. <b>Needs configuration</b>: credentials or settings to add, or nothing collected yet. <b>Restricted</b>: the platform must approve access, or refused it. <b>Unavailable</b>: no permitted API for this.</p>
      <div class="tablewrap"><table class="small wcap"><thead><tr><th>Platform</th><th>Content and search</th><th>Access needed</th><th>Mode, quotas and limits</th><th>Last successful collection</th><th>Live verification</th></tr></thead><tbody>
      ${s.platforms.map(p => `<tr><td><b>${esc(p.platform)}</b><div>${chip([p.status, PSTATUS[p.status] || "grey"])}</div><div class="sub">${esc(p.detail || "")}</div><a class="sub" href="${esc(p.docs)}" target="_blank" rel="noopener noreferrer">documentation ↗</a></td>
        <td>${esc(p.content)}<div class="sub"><b>Search:</b> ${esc(p.search)}</div></td><td>${esc(p.access)}</td>
        <td><div><b>${esc(p.mode)}</b></div><div>${esc(p.quotas)}</div><div class="sub">${esc(p.coverage)}</div></td>
        <td>${p.last_success ? dt(p.last_success) : `<span class="sub">never</span>`}</td><td>${liveCell(p)}</td></tr>`).join("")}</tbody></table></div></div></div>
    <div class="card" style="margin-bottom:14px"><div class="hd"><h3>For platforms AIVS cannot collect from</h3></div><div class="bd small">
      <p style="margin-top:0">Two permitted alternatives, both labelled wherever the posts appear: <b>Submit a public link</b> (an analyst pastes the link and, if the platform's public embed does not give it, the text) and <b>Import a file</b> (an export you are permitted to use, such as your own Page's data or a partner's research export). Both are on each watchlist's page.</p></div></div>
    <div class="split"><div class="stack">
      <div class="card"><div class="hd"><h3>Not covered</h3></div><div class="bd small"><ul style="margin:0 0 0 18px">${s.unsupported.map(u => `<li><b>${esc(u.platform)}</b>: ${esc(u.reason)}</li>`).join("")}</ul></div></div>
    </div><div class="stack">
      <div class="card"><div class="hd"><h3>X filtered stream</h3>${App.can("settings.manage") && st.enabled ? `<button class="btn sm right" id="rc">Reconnect</button>` : ""}</div><div class="bd small">
        <div>Status: ${chip([String(st.status || "off").replace(/_/g, " "), st.status === "connected" ? "sup" : st.status === "reconnecting" ? "mix" : st.status === "not_permitted" ? "con" : "grey"])}${st.enabled ? "" : ` <span class="sub">— switched off in the server settings (WATCH_X_STREAM)</span>`}</div>
        ${st.connected_at ? `<div>Connected since ${dt(st.connected_at)}; last data or keep-alive ${dt(st.last_data_at)}.</div>` : ""}${st.last_error ? `<div>Last problem: ${esc(st.last_error)}</div>` : ""}${st.warning ? `<div class="callout bad" style="margin-top:6px"><div>${esc(st.warning)}</div></div>` : ""}
        ${st.rules ? `<div>Rules: ${st.rules.rules} from AIVS${st.rules.other_rules ? `, ${st.rules.other_rules} from elsewhere (ignored)` : ""}; last synchronised ${dt(st.rules.at)}${st.rules.errors?.length ? `; X reported: ${esc(st.rules.errors.join("; "))}` : ""}.</div>` : ""}
        <p class="hint">Periods without a connection are recorded and recovered with recent search (or backfill of up to 5 minutes when enabled: ${st.backfill_minutes ? `${st.backfill_minutes} min` : "off"}).</p></div></div>
      <div class="card"><div class="hd"><h3>Today's usage</h3></div><div class="bd small">
        <div><b>X posts read:</b> ${b.x_posts_today.toLocaleString()} of the ${b.x_posts_limit.toLocaleString()} daily limit set for AIVS (about $${b.x_est_cost_today_usd}; ${esc(b.x_cost_note)}).</div>
        <div><b>YouTube searches:</b> ${b.youtube_search_today} of ${b.youtube_search_limit} (YouTube allows 100 a day; resets at midnight Pacific Time).</div>
        <div><b>Threads queries (last 24 h):</b> ${b.threads_queries_24h} of ${b.threads_queries_limit} (Threads allows 2,200 in a rolling 24 h).</div>
        <div><b>Instagram hashtags (last 7 days):</b> ${b.instagram_hashtags_7d} of 30 allowed.</div>
        <p class="hint">When a limit is reached, collection from that source stops until the next day and the watchlist shows why.</p></div></div>
      <div class="card"><div class="hd"><h3>Scheduler</h3></div><div class="bd small">${s.scheduler.enabled ? `Checks for due collection every ${s.scheduler.tick_seconds} s${s.scheduler.running ? "" : " (starts with the server)"}. Public counts of posts under watch are refreshed every ${s.scheduler.metrics_refresh_minutes || "—"} min${s.scheduler.metrics_refresh_minutes ? "" : " (off)"}.` : "Switched off in the server settings (WATCH_ENABLED=false). Nothing is collected."}</div></div>
    </div></div>`;
  $$("[data-check]", body).forEach(bt => bt.onclick = async () => { bt.disabled = true; bt.innerHTML = '<span class="spin"></span> Testing…'; try { const r = await api.post(`/api/watch/sources/${bt.dataset.check}/check`, {}); toast(r.ok ? "Live check passed." : `Live check failed: ${r.note}`, r.ok ? "" : "err"); render($("#page"), ["sources"]); } catch (e) { fail(e); bt.disabled = false; bt.textContent = "Test connection"; } });
  const rc = $("#rc", body); if (rc) rc.onclick = async () => { try { await api.post("/api/watch/stream/reconnect", {}); toast("Reconnecting the X stream."); setTimeout(() => render($("#page"), ["sources"]), 1500); } catch (e) { fail(e); } };
}

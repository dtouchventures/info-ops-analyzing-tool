// Live Monitoring: posts collected automatically from the authorised Facebook Pages (Meta Graph API, token on the
// server), their analysis and verification status, live alerts, and the collection sources with their history.
// Everything shown is read from the server's records; values a platform did not return are labelled, never filled in.
import { api } from "../api.js";
import { App, crumbs, refreshNavCounts } from "../app.js";
import { $, $$, esc, toast, fail, modal, fmtDT, ago, empty } from "../ui.js";

const VCHIP = { pending: "info", supported: "sup", contradicted: "con", insufficient: "grey", misleading: "mix", not_verifiable: "grey" };
const PRI = { high: ["High", "con"], medium: ["Medium", "warn"], low: ["Low", "grey"] };
const AST = { new: ["New", "con"], acknowledged: ["Acknowledged", "teal"], dismissed: ["Dismissed", "grey"], escalated: ["Escalated", "warn"] };
const SYNC = { ok: "sup", partial: "mix", failed: "con", running: "info", interrupted: "mix" };
const CONN = { connected: "sup", training: "train", not_configured: "grey", no_sources: "warn", not_tested: "warn", token_refused: "con", not_permitted: "con", unreachable: "warn" };
const STAGE = { pending: "Waiting for analysis", analysing: "Analysing", verifying: "Verifying evidence", done: "Analysed", skipped: "Nothing to analyse", failed: "Analysis failed" };
const chip = (l, c) => `<span class="chip ${c}">${esc(l)}</span>`;
const dt = iso => (iso ? fmtDT(iso) : "—");
const n = v => (v == null ? `<span class="sub">not available</span>` : Number(v).toLocaleString());
const q = (extra = "") => App.q(extra);

export async function render(el, [tab = "overview", id = null] = []) {
  crumbs(`<a href="#/home">Dashboard</a> › <b>Live Monitoring</b>${App.training ? " · training records" : ""}`);
  const tabs = [["overview", "Overview"], ["search", "Search"], ["discovered", "Discovered items"], ["watchlists", "Watchlists"], ["reports", "Reports"], ["alerts", "Alerts"], ["posts", "Own Facebook Page"], ["sources", "Sources"]];
  const on = { post: "posts", item: "discovered" }[tab] || tab;
  el.innerHTML = `<div class="pagehead"><div><h1>Live Monitoring</h1><p>Search any keyword, phrase, hashtag or topic across the connected public sources, keep searches as recurring watchlists, and get evidence-based analysis and draft reports. Results are AI-supported leads until a person reviews them.</p></div></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/live/${k}" class="${k === on ? "on" : ""}">${l}</a>`).join("")}</nav><div id="lb"></div>`;
  const body = $("#lb", el);
  const K = await import("./keywords.js");
  if (!body.isConnected) return;   // the analyst moved to another page meanwhile
  if (App.training && ["search", "discovered", "watchlists", "reports"].includes(tab)) { body.innerHTML = `<div class="callout info"><div>Keyword searches use live public sources, so they run with Operational records only. Switch Records to Operational. In Training mode, the Own Facebook Page tab offers practice posts.</div></div>`; return; }
  if (tab === "post" && id) return postView(body, id);
  if (tab === "posts") { const own = await api.get(`/api/live/overview?${q()}`); body.innerHTML = `${statusLine(own)}<p class="tiny sub">Posts of the organisation's own Facebook Page(s), collected with the Page's token. This is one authorised source, not a search of Facebook.</p><div id="lplist" style="margin-top:12px"></div>`; return postsView($("#lplist", body)); }
  if (tab === "alerts") return alertsView(body);
  if (tab === "sources") { body.innerHTML = `<div id="ksrc"></div><h2 style="margin-top:18px">Own Facebook Page (authorised source)</h2><div id="lsrc"></div>`; await K.sourcesTable($("#ksrc", body)); return sourcesView($("#lsrc", body)); }
  if (tab === "search") return K.searchView(body, id);
  if (tab === "discovered") return K.discoveredView(body);
  if (tab === "watchlists") return K.watchlistsView(body);
  if (tab === "reports") return K.reportsView(body);
  if (App.training) { await overviewView(body); return; }
  const own = await api.get(`/api/live/overview?${q()}`).catch(() => null);
  await K.overviewView(body, own ? `<div class="card" style="margin-top:12px"><div class="hd"><h3>Own Facebook Page (authorised source)</h3><a class="small right" href="#/live/posts">Open</a></div><div class="bd">${statusLine(own)}<p class="tiny sub" style="margin:6px 0 0">${own.counts.total_posts} post(s) collected from the organisation's own Page. This is a separate source: its posts and alerts are kept out of the keyword monitoring results above. <a href="#/live/alerts?scope=own_page">Own Page alerts</a>.</p></div></div>` : "");
}

export function statusLine(o) {
  const c = o.facebook.connection;
  return `<div class="wmon ${c.state === "connected" ? "ok" : ["token_refused", "not_permitted"].includes(c.state) ? "bad" : "warn"}" id="liveConn"><b>Facebook: ${esc(c.label)}</b>
    · last successful synchronisation ${o.facebook.last_successful_sync ? `${dt(o.facebook.last_successful_sync)} (${ago(o.facebook.last_successful_sync)})` : "never"}
    ${o.facebook.token?.page ? ` · token for “${esc(o.facebook.token.page)}”` : ""}${o.facebook.token?.expires_at ? ` · expires ${o.facebook.token.expires_at === "never" ? "never (long-lived Page token)" : dt(o.facebook.token.expires_at)}` : ""}
    · Instagram: ${esc(o.instagram.status)}</div>`;
}
const card = p => `<div class="lpost" data-id="${p.id}">
    ${p.image_stored ? `<img src="/api/live/posts/${p.id}/image" alt="Image attached to the post" loading="lazy">` : p.has_image ? `<div class="noimg small sub">${esc(p.image_note || "image not stored")}</div>` : ""}
    <div class="lpb"><div class="row" style="gap:6px;flex-wrap:wrap">${chip(p.verification_label || "—", VCHIP[p.verification] || "grey")}${p.confidence != null ? chip(`Confidence ${p.confidence_level} (${p.confidence}/100)`, p.confidence_level === "High" ? "sup" : p.confidence_level === "Moderate" ? "mix" : "grey") : ""}
      ${p.needs_review ? chip("Needs review", "warn") : ""}${p.top_alert ? chip(`Alert: ${PRI[p.top_alert][0]}`, PRI[p.top_alert][1]) : ""}${p.edited ? chip("Edited", "grey") : ""}${p.is_training ? chip("PRACTICE", "train") : ""}</div>
      <p class="lmsg">${esc((p.message || "(no text)").slice(0, 400))}${(p.message || "").length > 400 ? "…" : ""}</p>
      <div class="tiny sub">${esc(p.source_name || "Facebook Page")} · published ${dt(p.created_time)} · ${esc(STAGE[p.analysis_status] || p.analysis_status)}${p.topics.length ? ` · ${esc(p.topics.join(", "))}` : ""}
        ${p.permalink_url ? ` · <a href="${esc(p.permalink_url)}" target="_blank" rel="noopener noreferrer">Open on Facebook</a>` : ""} · <a href="#/live/post/${p.id}">Details</a></div></div></div>`;

async function overviewView(body) {
  const o = await api.get(`/api/live/overview?${q()}`), c = o.counts;
  const fig = (v, l, h, cls = "") => `<a class="kpi ${cls}" href="${h}"><div class="l">${l}</div><div class="v">${Number(v).toLocaleString()}</div></a>`;
  body.innerHTML = `${statusLine(o)}
    <div class="kpis" style="margin-top:12px">${fig(c.total_posts, "real posts collected", "#/live/posts")}${fig(c.posts_today, "collected today", "#/live/posts")}${fig(c.awaiting_analysis, "awaiting AI analysis", "#/live/posts", c.awaiting_analysis ? "attn" : "")}
      ${fig(c.completed_analyses, "AI analyses completed", "#/live/posts")}${fig(c.needs_review, "need human review", "#/live/posts", c.needs_review ? "attn" : "")}
      ${fig(c.active_watchlists, "active watchlists", "#/watch/lists")}${fig(c.new_alerts, "new alerts", "#/live/alerts", c.new_alerts ? "alert" : "")}${fig(c.pending_investigations, "investigations running", "#/reports")}
      ${fig(c.completed_reports, "reports completed", "#/reports")}${fig(c.reviewed_reports, "reports reviewed", "#/reports")}</div>
    ${App.training ? `<div class="callout info" style="margin-bottom:12px"><div>Training mode shows PRACTICE posts only. ${App.can("case.create") ? `<button class="btn sm" id="lPractice">Load practice posts</button>` : ""}</div></div>` : !o.facebook.configured ? `<div class="callout warn" style="margin-bottom:12px"><div><b>Not configured.</b> An administrator sets META_PAGE_ACCESS_TOKEN and META_PAGE_IDS in the server's .env file and restarts AIVS. The token is never entered in the browser.</div></div>` : ""}
    <div class="card"><div class="hd"><h3>Recent posts</h3><a class="small right" href="#/live/posts">All posts and filters</a></div><div class="bd">${o.recent_posts.length ? `<div class="lposts">${o.recent_posts.map(card).join("")}</div>` : `<p class="sub" style="margin:0">No posts collected yet.</p>`}</div></div>
    <div class="grid g2" style="margin-top:12px">
      <div class="card"><div class="hd"><h3>Verification status</h3></div><div class="bd small">${Object.entries(o.verification_labels).map(([k, l]) => `<div class="row" style="justify-content:space-between"><a href="#/live/posts?verification=${k}">${esc(l)}</a><b>${(o.by_verification[k] || 0).toLocaleString()}</b></div>`).join("")}</div></div>
      <div class="card"><div class="hd"><h3>Latest synchronisations</h3><a class="small right" href="#/live/sources">History</a></div><div class="bd small">${o.recent_syncs.length ? `<ul class="mini">${o.recent_syncs.slice(0, 6).map(s => `<li>${chip(s.status, SYNC[s.status] || "grey")}<span style="flex:1">${esc(s.source_name || "")}: ${s.fetched} read, ${s.new_posts} new, ${s.duplicates} already stored${s.error ? ` <span class="sub">${esc(s.error.slice(0, 120))}</span>` : ""}</span><span class="sub">${dt(s.started_at)}</span></li>`).join("")}</ul>` : `<p class="sub" style="margin:0">No synchronisation yet.</p>`}</div></div></div>
    <p class="tiny sub" style="margin-top:10px">${esc(o.scheduler.note)} Checked every ${o.scheduler.interval_minutes} minutes (Meta's rate limits permitting).</p>`;
  $("#lPractice", body)?.addEventListener("click", async e => { e.target.disabled = true; try { const r = await api.post(`/api/live/training/sample?${q()}`, {}); toast(`${r.new_posts} practice posts loaded; analysis has started.`); overviewView(body); } catch (x) { fail(x); e.target.disabled = false; } });
}

async function postsView(body) {
  const f = Object.fromEntries(new URLSearchParams(location.hash.split("?")[1] || ""));
  const o = await api.get(`/api/live/overview?${q()}`);
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur || "") === String(v) ? "selected" : ""}>${esc(l)}</option>`;
  body.innerHTML = `<form class="card lfilt" id="lf"><div class="bd row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
      <div><label class="f" for="lfrom">From</label><input type="date" id="lfrom" value="${esc(f.from || "")}"></div><div><label class="f" for="lto">To</label><input type="date" id="lto" value="${esc(f.to || "")}"></div>
      <div><label class="f" for="lsrc">Source</label><select id="lsrc">${opt("", "All sources")}${o.sources.map(s => opt(s.id, s.name || s.external_id, f.source)).join("")}</select></div>
      <div><label class="f" for="ltop">Topic</label><select id="ltop">${opt("", "All topics")}${["Security and defence", "Health", "Elections and politics", "Economy and prices", "Disaster and weather", "Water, roads and power", "Education", "Scams and fraud", "Sports and entertainment"].map(t => opt(t, t, f.topic)).join("")}</select></div>
      <div><label class="f" for="lver">Verification</label><select id="lver">${opt("", "Any status")}${Object.entries(o.verification_labels).map(([k, l]) => opt(k, l, f.verification)).join("")}</select></div>
      <div><label class="f" for="lpri">Alert priority</label><select id="lpri">${opt("", "Any")}${["high", "medium", "low"].map(k => opt(k, PRI[k][0], f.priority)).join("")}</select></div>
      <div><label class="f" for="lq">Words</label><input id="lq" value="${esc(f.q || "")}" placeholder="search the text"></div>
      <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="lrev" ${f.review === "1" ? "checked" : ""}> Needs review</label>
      <button class="btn primary sm">Apply</button><a class="btn ghost sm" href="#/live/posts">Clear</a></div></form><div id="lres"><div class="empty"><span class="spin"></span> Loading…</div></div>`;
  $("#lf", body).onsubmit = e => { e.preventDefault(); const p = new URLSearchParams(); for (const [k, s] of [["from", "#lfrom"], ["to", "#lto"], ["source", "#lsrc"], ["topic", "#ltop"], ["verification", "#lver"], ["priority", "#lpri"], ["q", "#lq"]]) { const v = $(s, body).value; if (v) p.set(k, v); } if ($("#lrev", body).checked) p.set("review", "1"); location.hash = `#/live/posts${p.toString() ? `?${p}` : ""}`; };
  const r = await api.get(`/api/live/posts?${q(new URLSearchParams({ ...f, limit: 100 }).toString())}`);
  $("#lres", body).innerHTML = r.posts.length ? `<p class="small sub">${r.total.toLocaleString()} post(s)${r.total > r.posts.length ? `, newest ${r.posts.length} shown` : ""}.</p><div class="lposts">${r.posts.map(card).join("")}</div>` : empty("No posts", "No collected post matches these filters.");
}

async function postView(body, id) {
  const d = await api.get(`/api/live/posts/${id}`), p = d.post, a = d.analysis || {}, inv = d.investigation, base = inv ? `/api/investigations/${encodeURIComponent(inv.id)}` : null;
  const list = (t, xs) => xs?.length ? `<h4>${t}</h4><ul class="small">${xs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  body.innerHTML = `<div class="grid g2"><div>${card(p)}
      <div class="card" style="margin-top:12px"><div class="hd"><h3>Verification</h3>${chip(p.verification_label || "—", VCHIP[p.verification] || "grey")}</div><div class="bd small">
        ${inv ? `<p>Automatic investigation <a href="#/investigate/${esc(inv.id)}" class="mono">${esc(inv.report_id)}</a>: ${esc(inv.status)}${inv.reviewed_at ? " · reviewed" : " · AI-generated, not reviewed"}${inv.approved_at ? " · approved" : ""}${inv.error ? ` <span class="sub">${esc(inv.error)}</span>` : ""}</p>
          ${inv.status === "done" ? `<div class="row" style="gap:8px;flex-wrap:wrap"><a class="btn sm primary" href="${base}/report.pdf" download>Report (PDF)</a><a class="btn sm" href="${base}/report.docx" download>Word</a><a class="btn sm ghost" href="${base}/report.html" target="_blank" rel="noopener">Open report</a><a class="btn sm ghost" href="${base}/details.html" target="_blank" rel="noopener">Supporting evidence</a></div>` : ""}`
          : p.same_as_post ? `<p>Same wording as <a href="#/live/post/${p.same_as_post}">post ${p.same_as_post}</a>; its verification is reused.</p>` : `<p class="sub">${esc(STAGE[p.analysis_status] || p.analysis_status)}${p.analysis_error ? `: ${esc(p.analysis_error)}` : ""}</p>`}
        ${d.confidence ? `<h4>Confidence: ${esc(d.confidence.level)}${d.confidence.score != null ? ` (${d.confidence.score}/100)` : ""}</h4><ul>${d.confidence.criteria.map(c => `<li>${c.points > 0 ? "+" : ""}${c.points} ${esc(c.rule)}</li>`).join("")}</ul><p class="tiny sub">${esc(d.confidence_scale)}</p>` : ""}
        ${p.review_reasons.length ? `<div class="callout warn"><div><b>Human review needed:</b> ${esc(p.review_reasons.join("; "))}.</div></div>` : ""}</div></div></div>
    <div><div class="card"><div class="hd"><h3>AI-supported analysis</h3><span class="tiny sub">${esc(a.method || "")}</span></div><div class="bd small">
      ${list("Facts (from the platform record)", a.facts)}${list(a.verification ? "Claims found" : "Claims found (not yet verified)", a.claims)}${a.verification ? `<p><b>Verification:</b> ${esc(a.verification)}</p>` : ""}
      ${a.entities ? `<h4>Places, organisations and people</h4><p>${esc([...(a.entities.locations || []), ...(a.entities.organisations || []), ...(a.entities.people || [])].join(", ") || "none found")}</p>` : ""}
      ${a.hashtags?.length ? `<p><b>Hashtags:</b> ${esc(a.hashtags.join(" "))}</p>` : ""}${a.themes?.length ? `<p><b>Themes:</b> ${esc(a.themes.join(", "))}</p>` : ""}
      ${a.tone ? `<p><b>Tone:</b> ${esc(a.tone.label)}${a.tone.uncertain ? " (uncertain)" : ""} <span class="sub">${esc(a.tone.basis || "")}</span></p>` : ""}
      ${a.indicators?.length ? `<h4>Possible misinformation indicators</h4><ul>${a.indicators.map(i => `<li><b>${esc(i.cue)}</b>: ${esc(i.indicator)} <span class="sub">Check: ${esc(i.check)}</span></li>`).join("")}</ul>` : ""}
      ${a.similar ? `<p><b>Similar earlier post:</b> <a href="#/live/post/${a.similar.post_id}">post ${a.similar.post_id}</a> (${Math.round(a.similar.similarity * 100)}% the same wording)</p>` : ""}
      ${list("Inferences", a.inferences)}${list("Unknowns", a.unknowns)}</div></div>
      <div class="card" style="margin-top:12px"><div class="hd"><h3>Alerts and watchlists</h3></div><div class="bd small">
        ${d.alerts.length ? `<ul class="mini">${d.alerts.map(x => `<li>${chip(PRI[x.priority][0], PRI[x.priority][1])}${chip(AST[x.status][0], AST[x.status][1])}<a href="#/live/alerts?id=${x.id}" style="flex:1">${esc(x.title)}</a></li>`).join("")}</ul>` : `<p class="sub" style="margin:0">No live alert for this post.</p>`}
        ${d.watch_matches.length ? `<p>Matched watchlist(s): ${d.watch_matches.map(m => `<a href="#/watch/list/${m.id}">${esc(m.name)}</a> (${esc((m.terms || []).join(", "))})`).join("; ")}</p>` : ""}
        <h4>Public counts</h4><p>${n(p.likes)} reactions · ${n(p.comments)} comments · ${n(p.shares)} shares${p.engagement_note ? ` <span class="sub">(${esc(p.engagement_note)})</span>` : ""}</p>
        ${d.metrics.length ? `<p class="tiny sub">${d.metrics.length} later reading(s); latest ${dt(d.metrics[0].at)}.</p>` : ""}</div></div></div></div>`;
}

// watchlist alerts (keyword monitoring) first; the organisation's own Facebook Page has its alerts apart
async function alertsView(body) {
  const f = Object.fromEntries(new URLSearchParams(location.hash.split("?")[1] || "")), st = f.status ?? "new,acknowledged,escalated", scope = f.scope === "own_page" ? "own_page" : "watchlists";
  const [r, wa] = await Promise.all([api.get(`/api/live/alerts?${q(new URLSearchParams({ group: "1", status: st, scope, ...(f.priority ? { priority: f.priority } : {}), limit: 300 }).toString())}`),
    scope === "watchlists" && !App.training ? api.get(`/api/watch/alerts?status=${st.includes("dismissed") && !st.includes("new") ? "dismissed" : st === "" ? "" : "open"}&limit=60`).catch(() => null) : null]);
  const KL = { match: "Keyword match", volume: "Unusual volume", narrative: "Emerging topic", repeated: "Repeated wording", coordination: "Coordination indicator", engagement: "Unusual engagement", threshold: "Threshold" };
  const watchList = wa ? `<div class="card" style="margin-bottom:12px"><div class="hd"><h3>Watchlist alerts</h3><a class="small right" href="#/watch/alerts">Work all watchlist alerts</a></div><div class="bd">${wa.alerts.length ? `<ul class="mini">${wa.alerts.map(a => `<li>${chip(a.status, a.status === "new" ? "con" : "grey")}${chip(a.severity || "low", a.severity === "high" ? "con" : a.severity === "medium" ? "warn" : "grey")}<a class="small" style="flex:1" href="#/watch/alerts/${a.id}">${esc(KL[a.kind] || a.kind)}: ${esc((a.title || "").slice(0, 140))}</a><span class="tiny sub">${esc(a.watchlist_name || "")} · ${dt(a.created_at)}</span></li>`).join("")}</ul>` : `<p class="sub" style="margin:0">No open watchlist alert.</p>`}</div></div>` : "";
  body.innerHTML = `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:6px"><a class="btn sm ${scope === "watchlists" ? "primary" : "ghost"}" href="#/live/alerts">Watchlist alerts</a><a class="btn sm ${scope === "own_page" ? "primary" : "ghost"}" href="#/live/alerts?scope=own_page">Own Facebook Page alerts</a></div>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">${[["new,acknowledged,escalated", "Open"], ["new", "New"], ["escalated", "Escalated"], ["dismissed", "Dismissed"], ["", "All"]].map(([v, l]) => `<a class="btn sm ${st === v ? "primary" : "ghost"}" href="#/live/alerts?status=${v}${scope === "own_page" ? "&scope=own_page" : ""}">${l}</a>`).join("")}</div>
    ${watchList}${scope === "watchlists" ? `<h3 style="margin:6px 0">Findings across watchlist items</h3>` : `<p class="tiny sub">Alerts about the organisation's own Page. They are kept out of the keyword monitoring results.</p>`}
    ${r.groups.length ? r.groups.map(g => `<div class="card lgroup"><div class="hd">${chip(PRI[g.top_priority][0], PRI[g.top_priority][1])}<h3>${esc(g.kind_label)}${g.alerts.length > 1 ? ` · ${g.alerts.length} related alerts` : ""}</h3></div><div class="bd">
      ${g.alerts.map(a => `<div class="lalert ${String(a.id) === f.id ? "focus" : ""}" data-id="${a.id}"><div class="row" style="gap:6px;flex-wrap:wrap">${chip(AST[a.status][0], AST[a.status][1])}${chip(PRI[a.priority][0], PRI[a.priority][1])}<b style="flex:1">${esc(a.title)}</b><span class="tiny sub">${dt(a.created_at)}</span></div>
        <p class="small">${esc(a.reason)}</p><p class="tiny sub"><b>Why this priority:</b> ${esc(a.priority_reasons.join("; "))}. <i>${esc(a.detail.priority_rule || "")}</i></p>
        ${a.post_id ? `<p class="tiny"><a href="#/live/post/${a.post_id}">Open the post</a>${a.detail.report_id ? ` · report ${esc(a.detail.report_id)}` : ""}</p>` : ""}${a.note ? `<p class="tiny">Note: ${esc(a.note)}</p>` : ""}
        ${App.can("watch.triage") ? `<div class="row" style="gap:6px">${a.status !== "acknowledged" && a.status !== "dismissed" ? `<button class="btn sm" data-act="acknowledge">Acknowledge</button>` : ""}${a.status !== "dismissed" ? `<button class="btn sm ghost" data-act="dismiss">Dismiss</button>` : ""}${a.status !== "escalated" ? `<button class="btn sm ghost" data-act="escalate">Escalate</button>` : ""}${a.status === "dismissed" ? `<button class="btn sm ghost" data-act="reopen">Reopen</button>` : ""}</div>` : ""}</div>`).join("")}</div></div>`).join("")
      : empty("No alerts", "No live alert matches this view. Alerts appear for verification outcomes that need attention, unusual posting frequency, emerging topics, repeated wording, unusual engagement and collection problems.")}
    <details class="card" style="margin-top:12px"><summary class="hd"><h3>How priorities are set</h3></summary><div class="bd small"><ul>${Object.entries(r.priority_rules).map(([k, v]) => `<li><b>${esc(k.replace(/_/g, " "))}:</b> ${esc(v)}</li>`).join("")}</ul><p>Alerts point an analyst to something worth checking. Escalation records that a person must decide; AIVS takes no action itself.</p></div></details>`;
  for (const b of $$("[data-act]", body)) b.onclick = async () => {
    const id = b.closest("[data-id]").dataset.id, action = b.dataset.act;
    let note = "";
    if (action === "dismiss" || action === "escalate") {
      const m = await modal(action === "escalate" ? "Escalate alert" : "Dismiss alert", `<label class="f" for="anote">${action === "escalate" ? "Why does this need a decision by a senior analyst or commander?" : "Why is it dismissed?"}</label><textarea id="anote" rows="3"></textarea>`,
        [{ label: "Cancel", value: null }, { label: action === "escalate" ? "Escalate" : "Dismiss", kind: "primary", validate: el => $("#anote", el).value.trim() ? null : "A short reason is required.", value: el => $("#anote", el).value }]);
      if (!m.value) return; note = typeof m.value === "string" ? m.value : $("#anote")?.value || "";
    }
    try { await api.post(`/api/live/alerts/${id}/action`, { action, note }); toast("Alert updated."); refreshNavCounts(); alertsView(body); } catch (e) { fail(e); }
  };
}

async function sourcesView(body) {
  const [o, sy] = await Promise.all([api.get(`/api/live/overview?${q()}`), api.get("/api/live/syncs?limit=40")]);
  const manage = App.can("watch.manage") && !App.training;
  body.innerHTML = `${statusLine(o)}
    <div class="card" style="margin-top:12px"><div class="hd"><h3>Sources</h3>${manage ? `<button class="btn sm right" id="lCheck">Check the Meta connection</button>` : ""}</div><div class="bd">
      ${o.sources.length ? `<table class="t"><thead><tr><th>Source</th><th>Status</th><th>Last success</th><th>Next run</th><th>Posts</th><th></th></tr></thead><tbody>${o.sources.map(s => `<tr><td><b>${esc(s.name || s.external_id)}</b><div class="tiny sub">${esc(s.platform)} · ${esc(s.external_id)} · from ${esc(s.origin)}${s.fields_level === "basic" ? " · basic fields only" : ""}</div></td>
        <td>${chip(s.enabled ? s.status : "paused", s.status === "ok" ? "sup" : ["token_refused", "not_permitted"].includes(s.status) ? "con" : "grey")}${s.last_error ? `<div class="tiny sub">${esc(s.last_error.slice(0, 200))}</div>` : ""}</td><td class="small">${dt(s.last_ok_at)}</td><td class="small">${dt(s.next_sync_at)}</td><td>${s.posts}</td>
        <td>${manage && !s.is_training && s.platform === "facebook" ? `<div class="row" style="gap:6px"><button class="btn sm" data-sync="${s.id}">Synchronise now</button><button class="btn sm ghost" data-en="${s.id}" data-on="${s.enabled ? 0 : 1}">${s.enabled ? "Pause" : "Resume"}</button></div>` : ""}</td></tr>`).join("")}</tbody></table>`
        : `<p class="sub" style="margin:0">No source yet. Set META_PAGE_IDS in the server's .env file${manage ? ", or add a Page the token is authorised to read" : ""}.</p>`}
      ${manage ? `<form class="row" id="lAdd" style="gap:8px;margin-top:10px;flex-wrap:wrap"><input id="lPage" placeholder="Page ID or facebook.com/… address" style="min-width:280px"><button class="btn sm primary">Add Facebook Page</button><span class="tiny sub">Meta must allow the server's token to read the Page; AIVS checks this before adding it.</span></form>` : ""}</div></div>
    <div class="card" style="margin-top:12px"><div class="hd"><h3>Instagram</h3>${chip(o.instagram.status, o.instagram.connected ? "sup" : "grey")}${manage ? `<button class="btn sm right" id="lIg">Test the Instagram connection</button>` : ""}</div><div class="bd small"><p>${esc(o.instagram.reason || "")}${o.instagram.account ? ` Account ${esc(o.instagram.account)}.` : ""}</p><p class="sub">${esc(o.instagram.note)}</p></div></div>
    <div class="card" style="margin-top:12px"><div class="hd"><h3>Synchronisation history</h3></div><div class="bd">${sy.syncs.length ? `<table class="t"><thead><tr><th>Started</th><th>Source</th><th>Result</th><th>Read</th><th>New</th><th>Already stored</th><th>Edited</th><th>Note or error</th></tr></thead><tbody>${sy.syncs.map(s => `<tr><td class="small">${dt(s.started_at)}</td><td class="small">${esc(s.source_name || "")}</td><td>${chip(s.status, SYNC[s.status] || "grey")}</td><td>${s.fetched}</td><td>${s.new_posts}</td><td>${s.duplicates}</td><td>${s.updated_posts}</td><td class="tiny">${esc(s.error || s.note || "")}</td></tr>`).join("")}</tbody></table>` : `<p class="sub" style="margin:0">No synchronisation yet.</p>`}</div></div>`;
  $("#lCheck", body)?.addEventListener("click", async () => { try { const v = await api.post("/api/live/check", {}); toast(v.state === "valid" ? `Connected: token for ${v.subject_name}.` : `Not connected: ${v.error || v.needs || v.state}`, v.state === "valid" ? "" : "err"); sourcesView(body); } catch (e) { fail(e); } });
  $("#lIg", body)?.addEventListener("click", async () => { try { const v = await api.post("/api/live/instagram/test", {}); toast(v.ok ? `Instagram connected (@${v.username}).` : `Instagram not connected: ${v.error}`, v.ok ? "" : "err"); sourcesView(body); } catch (e) { fail(e); } });
  $("#lAdd", body)?.addEventListener("submit", async e => { e.preventDefault(); try { const r = await api.post("/api/live/sources", { page: $("#lPage", body).value }); toast(`${r.name || r.external_id} added.`); sourcesView(body); } catch (x) { fail(x); } });
  for (const b of $$("[data-sync]", body)) b.onclick = async () => { b.disabled = true; b.textContent = "Synchronising…"; try { const r = await api.post(`/api/live/sources/${b.dataset.sync}/sync`, {}); toast(r.error ? `Failed: ${r.error}` : `${r.fetched} read, ${r.new_posts} new.`, r.error ? "err" : ""); } catch (e) { fail(e); } sourcesView(body); };
  for (const b of $$("[data-en]", body)) b.onclick = async () => { try { await api.patch(`/api/live/sources/${b.dataset.en}`, { enabled: b.dataset.on === "1" }); sourcesView(body); } catch (e) { fail(e); } };
}

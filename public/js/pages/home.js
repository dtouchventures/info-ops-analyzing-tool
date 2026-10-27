// Dashboard: the three AIVS services, recent investigations and recent alerts. Figures come from the server;
// nothing here is sample data. Service status for every module is under Settings → Service status.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { esc, icon, fmtDT, status, ago } from "../ui.js";
import { statusLine } from "./live.js";

const KIND = { match: "Keyword match", threshold: "Keyword threshold exceeded", volume: "Unusual posting spike", narrative: "Emerging narrative", repeated: "Repeated message", coordination: "Coordination indicator", engagement: "High engagement" };

// The dashboard re-reads the server every 30 seconds while it is open, so new watchlists, imports and alerts show up
// without reloading the page.
export async function render(el) {
  await draw(el);
  const h = location.hash, t = setInterval(() => { if (!el.isConnected || location.hash !== h || document.hidden) { if (!el.isConnected || location.hash !== h) clearInterval(t); return; } draw(el).catch(() => {}); }, 30000);
}
// monitoring status under the AI Watchlist card: what is connected, when the last analysis ran, how many posts it checked
function monitoringLine(W) {
  if (!W) return `<div class="wmon bad">The AI Watchlist status could not be loaded from the server.</div>`;
  const m = W.stats?.monitoring;
  if (!m) return `<div class="wmon warn">The server is running an older AIVS version. Restart AIVS to load the current watchlist features.</div>`;
  if (!m.active_watchlists) return `<div class="wmon">No watchlist is active, so nothing is being monitored. <a href="#/watch/lists">Create or activate one</a>.</div>`;
  if (!m.datasets && !m.live_sources_connected.length) return `<div class="wmon warn">${m.active_watchlists} active watchlist${m.active_watchlists > 1 ? "s" : ""}, but no data source: import a dataset in <a href="#/monitor">Social Media Analysis</a>, or connect a platform API.</div>`;
  return `<div class="wmon ${m.failed_checks ? "warn" : "ok"}"><b>Monitoring ${m.failed_checks ? "with errors" : "active"}</b> · last analysis ${m.last_successful_analysis ? fmtDT(m.last_successful_analysis) : "not run yet"} · ${m.posts_checked.toLocaleString()} posts checked, ${m.posts_matched.toLocaleString()} matching
    · ${m.live_sources_connected.length ? `live: ${esc(m.live_sources_connected.join(", "))}` : "no live platform connected (imported datasets only)"}${m.posts_checked && !m.posts_matched ? `<div class="tiny">No imported post matches the watchlist keywords yet.</div>` : ""}</div>`;
}
async function draw(el) {
  const h0 = location.hash;
  crumbs(`<b>Dashboard</b>${App.training ? " · training records" : ""}`);
  const [D, W, IO] = await Promise.all([api.get(`/api/dashboard?${App.q()}`).catch(() => null), api.get("/api/watch/overview").catch(() => null), api.get("/api/io/datasets").catch(() => null)]);
  const [al, INV, LV, MO] = await Promise.all([api.get("/api/watch/alerts?limit=6").catch(() => null), api.get(`/api/investigations?limit=6&${App.q()}`).catch(() => null), api.get(`/api/live/overview?${App.q()}`).catch(() => null), api.get("/api/monitor/overview").catch(() => null)]);
  if (location.hash !== h0) return;   // the user moved on while the figures were loading: do not draw over the next page
  const c = D?.counts || {}, open = (c.draft || 0) + (c.analysing || 0) + (c.analysis_failed || 0) + (c.analyst_review || 0) + (c.needs_evidence || 0);
  const ds = (IO?.datasets || []).filter(d => App.training ? d.is_sample : !d.is_sample), posts = ds.reduce((a, d) => a + (d.posts || 0), 0);
  const wls = W?.watchlists || [], activeW = wls.filter(w => w.status === "active").length, openAlerts = (W?.alert_counts?.new || 0) + (W?.alert_counts?.acknowledged || 0);
  const card = (key, ic, title, text, figs, href, cta, extra = "") => `<div class="svc" data-svc="${key}"><div class="svc-top"><span class="mic">${icon(ic)}</span><h2>${title}</h2></div>
    <p class="small muted">${text}</p><div class="svc-figs">${figs.map(([n, l, h]) => `<a href="${h}" data-fig="${esc(l)}"><b>${n}</b><span>${l}</span></a>`).join("")}</div>${extra}<a class="btn primary" href="${href}">${cta}</a></div>`;
  el.innerHTML = `<div class="pagehead"><div><h1>Dashboard</h1><p>Check claims against evidence, analyse public post datasets, and watch topics for unusual activity. Automatic results are leads for an analyst, never findings.</p></div></div>
    <div class="svcs">
      ${card("verify", "verify", "Verify Information", "Give a link, text, image, PDF or Word file. AIVS extracts the claims, searches for evidence and writes an assessed report automatically.",
        [[open, "open", "#/cases?status=draft,analysing,analysis_failed,analyst_review,needs_evidence"], [c.awaiting_approval || 0, "awaiting review", "#/review"], [(c.approved || 0) + (c.archived || 0), "approved", "#/reports"]],
        App.can("case.create") ? "#/investigate" : "#/reports", App.can("case.create") ? "Analyze information" : "Open reports")}
      ${card("social", "monitor", "Social Media Analysis", "Upload a CSV, JSON or Excel set of public posts: tone, topics, hashtags, trends, repeated messages and a map.",
        [[ds.length, "datasets", "#/monitor"], [posts.toLocaleString(), "posts", "#/monitor"]], "#/monitor", "Analyse a dataset")}
      ${card("watch", "watch", "AI Watchlist", "Watch topics and hashtags in imported or collected posts, and get alerts for unusual increases and repeated messages.",
        [[activeW, "active watchlists", "#/watch/lists"], [openAlerts, "open alerts", "#/watch/alerts"]], "#/watch", "Open watchlists", monitoringLine(W))}
    </div>
    ${liveSection(LV, MO)}
    <div class="grid g3" style="margin-top:16px">
      <div class="card"><div class="hd"><h3>Recent automatic reports</h3><a class="small right" href="#/reports">All reports</a></div><div class="bd">
        ${(INV?.investigations || []).length ? `<table class="t"><tbody>${INV.investigations.map(x => `<tr><td><a href="#/investigate/${esc(x.id)}" class="mono small">${esc(x.report_id)}</a></td><td class="small">${esc((x.subject || x.status).slice(0, 70))}</td><td>${x.overall ? `<span class="chip ${({ supported: "sup", contradicted: "con", mixed: "mix" })[x.overall] || "grey"}">${esc(x.overall_label)}</span>` : `<span class="chip grey">${esc(x.status)}</span>`}</td><td class="tiny sub">${fmtDT(x.created_at)}</td></tr>`).join("")}</tbody></table>`
          : `<p class="small sub" style="margin:0">No automatic reports yet.${App.can("case.create") ? ` <a href="#/investigate">Analyze information</a>.` : ""}</p>`}</div></div>
      <div class="card"><div class="hd"><h3>Recent investigations</h3><a class="small right" href="#/cases">All cases</a></div><div class="bd">
        ${(D?.recent || []).length ? `<table class="t"><tbody>${D.recent.slice(0, 6).map(r => `<tr><td><a href="#/case/${esc(r.id)}" class="mono small">${esc(r.id)}</a></td><td class="small">${esc((r.title || "").slice(0, 70))}</td><td>${status(r.status)}</td><td class="tiny sub" style="white-space:nowrap">${fmtDT(r.updated_at)}</td></tr>`).join("")}</tbody></table>`
          : `<p class="small sub" style="margin:0">No investigations yet.${App.can("case.create") ? ` <a href="#/start">Start one</a>.` : ""}</p>`}</div></div>
      <div class="card"><div class="hd"><h3>Recent alerts</h3><a class="small right" href="#/watch/alerts">All alerts</a></div><div class="bd">
        ${(al?.alerts || []).length ? `<ul class="mini">${al.alerts.map(a => `<li><span class="chip ${a.status === "new" ? "warn" : "grey"}">${esc(a.status)}</span><a class="small" style="flex:1" href="#/watch/alerts/${a.id}">${esc((t => (t.toLowerCase().startsWith(String(KIND[a.kind] || a.kind).toLowerCase()) ? t : `${KIND[a.kind] || a.kind}: ${t}`))(a.title || "").slice(0, 90))}</a><span class="tiny sub" style="white-space:nowrap">${esc(a.watchlist_name || "")} · ${fmtDT(a.created_at)}</span></li>`).join("")}</ul>`
          : `<p class="small sub" style="margin:0">No alerts. Alerts appear when a watchlist finds matching posts or an unusual increase.</p>`}</div></div>
    </div>`;
}

// Public information monitoring: keyword discovery across the connected sources, with the organisation's own Facebook Page
// shown as one authorised source among others. Figures come from the server's records.
const VC = { pending: "info", supported: "sup", contradicted: "con", insufficient: "grey", misleading: "mix", not_verifiable: "grey", not_verified: "grey" };
const CATC = { Connected: "sup", "Configured, not yet tested": "info", Restricted: "warn", Unavailable: "con", "Not configured": "grey" };
function liveSection(o, m) {
  if (!m) return `<div class="card livecard" style="margin-top:16px"><div class="hd"><h3>Public information monitoring</h3></div><div class="bd"><div class="wmon bad">The monitoring status could not be loaded from the server.</div></div></div>`;
  const c = m.counts, f = (v, l, h, cls = "") => `<a class="kpi ${cls}" href="${h}" data-fig="${esc(l)}"><div class="l">${l}</div><div class="v">${Number(v).toLocaleString()}</div></a>`;
  return `<div class="card livecard" style="margin-top:16px" id="liveDash"><div class="hd"><h3>${icon("live")} Public information monitoring</h3><a class="small right" href="#/live/search">Search a keyword</a></div><div class="bd">
    <div class="wmon ${m.connected.length ? "ok" : "warn"}" id="monSources"><b>Sources:</b> ${Object.entries(m.by_category).map(([k, v]) => `<span class="chip ${CATC[k] || "grey"}">${esc(k)} ${v}</span>`).join(" ")} · connected: ${esc(m.connected.join(", ") || "none yet")} · <a href="#/live/sources">details</a></div>
    <div class="kpis">${f(c.items, "items discovered", "#/live/discovered")}${f(c.items_today, "found today", "#/live/discovered")}${f(c.active_watchlists, "active watchlists", "#/live/watchlists")}${f(c.searches, "searches run", "#/live/search")}
      ${f(c.new_alerts, "new alerts", "#/live/alerts", c.new_alerts ? "alert" : "")}${f(c.verified, "items sent for verification", "#/live/discovered?verification=verified")}${f(c.reports, "monitoring reports", "#/live/reports")}
</div>
    ${o ? `<div class="tiny sub" style="margin:6px 0 10px">Own Facebook Page (a separate source, not part of these results): <a href="#/live/posts">${o.counts.total_posts} post(s)</a> · ${o.counts.awaiting_analysis} awaiting AI analysis${m.counts.own_page_alerts ? ` · <a href="#/live/alerts?scope=own_page">${m.counts.own_page_alerts} new alert(s)</a>` : ""}</div>` : ""}
    ${m.recent.length ? `<ul class="mini">${m.recent.slice(0, 6).map(p => `<li>${p.has_image ? `<img src="/api/monitor/items/${p.id}/image" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:6px">` : ""}<span class="chip navy">${esc(p.platform)}</span><span class="chip ${VC[p.verification.status] || "grey"}">${esc(p.verification.label)}</span>
      <a class="small" style="flex:1" href="${p.url ? esc(p.url) : "#/live/discovered"}" ${p.url ? 'target="_blank" rel="noopener noreferrer"' : ""}>${esc(p.text.slice(0, 110))}</a><span class="tiny sub">${p.posted_at ? fmtDT(p.posted_at) : "date not given"}</span></li>`).join("")}</ul>`
      : `<p class="small sub" style="margin:0">Nothing discovered yet. <a href="#/live/search">Search a keyword</a> across the connected sources, or keep a search as a recurring watchlist.</p>`}
    ${o ? `<div style="margin-top:10px">${statusLine(o)}</div>` : ""}</div></div>`;
}

// Dashboard: the three AIVS services, recent investigations and recent alerts. Figures come from the server;
// nothing here is sample data. Service status for every module is under Settings → Service status.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { esc, icon, fmtDT, status } from "../ui.js";

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
  if (!m) return `<div class="wmon warn">The server is running an older version. Restart JICHO AI to load the current watchlist features.</div>`;
  if (!m.active_watchlists) return `<div class="wmon">No watchlist is active, so nothing is being monitored. <a href="#/watch/lists">Create or activate one</a>.</div>`;
  if (!m.datasets && !m.live_sources_connected.length) return `<div class="wmon warn">${m.active_watchlists} active watchlist${m.active_watchlists > 1 ? "s" : ""}, but no data source: import a dataset in <a href="#/monitor">Social Media Analysis</a>, or connect a platform API.</div>`;
  return `<div class="wmon ${m.failed_checks || !m.last_successful_analysis ? "warn" : "ok"}"><b>${m.failed_checks ? "Checks need attention" : m.last_successful_analysis ? "Analysis completed" : "Awaiting first analysis"}</b> · last analysis ${m.last_successful_analysis ? fmtDT(m.last_successful_analysis) : "not run yet"} · ${m.posts_checked.toLocaleString()} posts checked, ${m.posts_matched.toLocaleString()} matching
    · <details class="watch-source-details"><summary>${m.live_sources_connected.length} configured live source${m.live_sources_connected.length === 1 ? "" : "s"}</summary>${esc(m.live_sources_connected.join(", ") || "Imported datasets only. No live source connected.")}</details>${m.posts_checked && !m.posts_matched ? `<div class="tiny">No imported post matches the watchlist keywords yet.</div>` : ""}</div>`;
}
async function draw(el) {
  crumbs(`<b>Dashboard</b>${App.training ? " · training records" : ""}`);
  const [D, W, IO] = await Promise.all([api.get(`/api/dashboard?${App.q()}`).catch(() => null), api.get("/api/watch/overview").catch(() => null), api.get("/api/io/datasets").catch(() => null)]);
  const al = await api.get("/api/watch/alerts?limit=6").catch(() => null);
  const c = D?.counts || {}, open = (c.draft || 0) + (c.analysing || 0) + (c.analysis_failed || 0) + (c.analyst_review || 0) + (c.needs_evidence || 0);
  const ds = (IO?.datasets || []).filter(d => App.training ? d.is_sample : !d.is_sample), posts = ds.reduce((a, d) => a + (d.posts || 0), 0);
  const wls = W?.watchlists || [], activeW = wls.filter(w => w.status === "active").length, openAlerts = (W?.alert_counts?.new || 0) + (W?.alert_counts?.acknowledged || 0);
  const card = (key, ic, title, text, figs, href, cta, extra = "") => `<div class="svc" data-svc="${key}"><div class="svc-top"><span class="mic">${icon(ic)}</span><h2>${title}</h2></div>
    <p class="small muted">${text}</p><div class="svc-figs">${figs.map(([n, l, h]) => `<a href="${h}" data-fig="${esc(l)}"><b>${({ verify: D, social: IO, watch: W })[key] ? n : "—"}</b><span>${l}</span></a>`).join("")}</div>${extra}<a class="btn primary" href="${href}">${cta}</a></div>`;
  el.innerHTML = `<div class="pagehead"><div><p class="dashboard-eyebrow">JICHO AI · Analyst workspace</p><h1>Dashboard</h1><p>Check claims against evidence, analyse public post datasets, and watch topics for unusual activity. Automatic results are leads for an analyst, never findings.</p></div></div>
    ${!D || !W || !IO ? `<div class="callout warn dashboard-load-warning" role="status">Some dashboard data could not be loaded. Unavailable totals appear as —. <a href="#/status">Check service status</a>.</div>` : ""}
    <div class="svcs">
      ${card("verify", "verify", "Verify Information", "Use JICHO AI to examine claims, gather evidence and prepare an assessment for analyst review.",
        [[open, "open", "#/cases?status=draft,analysing,analysis_failed,analyst_review,needs_evidence"], [c.awaiting_approval || 0, "awaiting review", "#/review"], [(c.approved || 0) + (c.archived || 0), "approved", "#/reports"]],
        App.can("case.create") ? "#/start" : "#/cases", App.can("case.create") ? "New investigation" : "Open cases")}
      ${card("social", "monitor", "Social Media Analysis", "Upload a CSV, JSON or Excel set of public posts: tone, topics, hashtags, trends, repeated messages and a map.",
        [[ds.length, "datasets", "#/monitor"], [posts.toLocaleString(), "posts", "#/monitor"]], "#/monitor", "Analyse a dataset")}
      ${card("watch", "watch", "AI Watchlist", "Watch topics and hashtags in imported or collected posts, and get alerts for unusual increases and repeated messages.",
        [[activeW, "active watchlists", "#/watch/lists"], [openAlerts, "open alerts", "#/watch/alerts"]], "#/watch", "Open watchlists", monitoringLine(W))}
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="hd"><h3>Recent investigations</h3><a class="small right" href="#/cases">All cases</a></div><div class="bd">
        ${(D?.recent || []).length ? `<table class="t"><tbody>${D.recent.slice(0, 6).map(r => `<tr><td><a href="#/case/${esc(r.id)}" class="mono small">${esc(r.id)}</a></td><td class="small">${esc((r.title || "").slice(0, 70))}</td><td>${status(r.status)}</td><td class="tiny sub" style="white-space:nowrap">${fmtDT(r.updated_at)}</td></tr>`).join("")}</tbody></table>`
          : !D ? `<p class="small sub" style="margin:0">Investigation data is currently unavailable.</p>` : `<p class="small sub" style="margin:0">No investigations yet.${App.can("case.create") ? ` <a href="#/start">Start one</a>.` : ""}</p>`}</div></div>
      <div class="card"><div class="hd"><h3>Recent alerts</h3><a class="small right" href="#/watch/alerts">All alerts</a></div><div class="bd">
        ${(al?.alerts || []).length ? `<ul class="mini">${al.alerts.map(a => `<li><span class="chip ${a.status === "new" ? "warn" : "grey"}">${esc(a.status)}</span><a class="small" style="flex:1" href="#/watch/alerts/${a.id}">${esc((t => (t.toLowerCase().startsWith(String(KIND[a.kind] || a.kind).toLowerCase()) ? t : `${KIND[a.kind] || a.kind}: ${t}`))(a.title || "").slice(0, 90))}</a><span class="tiny sub" style="white-space:nowrap">${esc(a.watchlist_name || "")} · ${fmtDT(a.created_at)}</span></li>`).join("")}</ul>`
          : !al ? `<p class="small sub" style="margin:0">Alert data is currently unavailable.</p>` : `<p class="small sub" style="margin:0">No alerts. Alerts appear when a watchlist finds matching posts or an unusual increase.</p>`}</div></div>
    </div>`;
}

// AIVS single-page application: session, shell, routing, scope (operational vs training).
import { api } from "./api.js";
import { $, esc, toast, fail, icon, modal } from "./ui.js";

export const App = {
  me: null, perms: [], meta: null, scope: "real",
  can(p) { return this.perms.includes(p); },
  guided() { return (this.me?.ui_mode || "guided") !== "advanced"; },
  get training() { return this.scope === "training"; },
  q(extra = "") { return `training=${this.training ? 1 : 0}${extra ? "&" + extra : ""}`; },
  async refreshMeta() { this.meta = await api.get("/api/meta"); return this.meta; },
  go(hash) { if (location.hash === hash) route(); else location.hash = hash; },
  setScope(sc) { this.scope = sc === "training" ? "training" : "real"; try { sessionStorage.setItem("aivs-scope", this.scope); } catch {} shell(); },
  userName(id) { return this.meta?.users.find(u => u.id === id)?.name || "—"; }
};
try { App.scope = sessionStorage.getItem("aivs-scope") === "training" ? "training" : "real"; } catch {}

const ROUTES = [
  [/^#\/?$|^#\/home$/, () => import("./pages/home.js"), "home"],
  [/^#\/start$/, () => import("./pages/start.js"), "start"],
  [/^#\/dashboard$/, () => import("./pages/dashboard.js"), "dashboard"],
  [/^#\/verify(?:\/(post))?$/, () => import("./pages/verify.js"), "verify"],
  [/^#\/investigate(?:\/(INV-\d+|capture)(?:\?.*)?)?$/, () => import("./pages/investigate.js"), "investigate"],
  [/^#\/search(?:\?(.*))?$/, () => import("./pages/search.js"), "search"],
  [/^#\/privacy$/, () => import("./pages/privacy.js"), "privacy"],
  [/^#\/cases(?:\?(.*))?$/, () => import("./pages/cases.js"), "cases"],
  [/^#\/new$/, () => import("./pages/newcase.js"), "new"],
  [/^#\/case\/([^/]+)(?:\/(\w+))?$/, () => import("./pages/case.js"), "cases"],
  [/^#\/watch(?:\/(overview|alerts|lists|sources|list)(?:\/(\d+))?)?(?:\?.*)?$/, () => import("./pages/watch.js"), "watch"],
  [/^#\/live(?:\/(overview|search|discovered|watchlists|reports|item|posts|alerts|sources|post|page)(?:\/(\d+))?)?(?:\?.*)?$/, () => import("./pages/live.js"), "live"],
  [/^#\/monitor(?:\/(\d+)(?:\/(\w+))?)?(?:\?.*)?$/, () => import("./pages/monitor.js"), "monitor"],
  [/^#\/datasets(?:\/(\d+))?(?:\?.*)?$/, () => import("./pages/datasets.js"), "datasets"],
  [/^#\/archive$/, () => import("./pages/archive.js"), "archive"],
  [/^#\/review(?:\?(.*))?$/, () => import("./pages/review.js"), "review"],
  [/^#\/reports$/, () => import("./pages/reports.js"), "reports"],
  [/^#\/admin(?:\/(\w+))?$/, () => import("./pages/admin.js"), "admin"],
  [/^#\/settings$/, () => import("./pages/settings.js"), "settings"],
  [/^#\/status$/, () => import("./pages/status.js"), "settings"],
  [/^#\/models$/, () => import("./pages/models.js"), "settings"]
];

// The six services in the main menu. Every other module keeps working and stays reachable from Settings
// (and from "Other tools" in Advanced mode); nothing is removed.
export const GROUPS = { verify: ["investigate", "start", "cases", "review", "verify", "new", "search"], social: ["monitor"], live: ["live"], watch: ["watch"], reports: ["reports"], settings: ["settings", "admin"], home: ["home"] };
export const OTHER_TOOLS = [["dashboard", "#/dashboard", "Statistics", "dash"], ["verify", "#/verify", "Verify (single page)", "verify"], ["new", "#/new", "New case with files", "new"], ["search", "#/search", "Search and check", "search"],
  ["archive", "#/archive", "Reference archive", "archive"], ["datasets", "#/datasets", "Fact-check datasets", "data"]];
function shell() {
  const nav = [
    ["home", "#/home", "Dashboard", "dash"],
    ["verify", App.can("case.create") ? "#/investigate" : "#/cases", "Verify Information", "verify"],
    ["social", "#/monitor", "Social Media Analysis", "monitor"],
    ["live", "#/live", "Live Monitoring", "live"],
    ["watch", "#/watch", "AI Watchlist", "watch"],
    ["reports", "#/reports", "Reports", "reports"],
    ["settings", "#/settings", "Settings", "admin"]
  ];
  const more = App.guided() ? [] : OTHER_TOOLS.filter(([k]) => k !== "new" || App.can("case.create")).filter(([k]) => k !== "verify" || App.can("case.create"));
  $("#root").innerHTML = `<div class="shell">
    <aside class="side" aria-label="Main navigation">
      <div class="brand"><div class="brand-mark">AIVS</div><div><b>AIVS</b><span>Information verification</span></div></div>
      <nav class="nav">${nav.map(([k, h, l, ic]) => `<a href="${h}" data-nav="${k}">${icon(ic)}<span>${l}</span>${k === "verify" ? `<span class="count" id="navReview" hidden title="Cases awaiting approval"></span>` : k === "watch" ? `<span class="count" id="navWatch" hidden></span>` : k === "live" ? `<span class="count" id="navLive" hidden></span>` : ""}</a>`).join("")}
        ${more.length ? `<details class="navmore" id="navMore" open><summary>${icon("cases")}<span>Other tools</span></summary>${more.map(([k, h, l, ic]) => `<a href="${h}" data-nav="x-${k}">${icon(ic)}<span>${l}</span></a>`).join("")}</details>` : ""}</nav>
      <div class="side-foot"><b>${esc(App.me.display_name)}</b>${esc(App.meta.roles[App.me.role])} · <a href="#" id="pwLink" style="color:#9fd8d5">Password</a> · <a href="#/privacy" style="color:#9fd8d5">Privacy</a> · <a href="#" id="logout" style="color:#9fd8d5">Sign out</a></div>
    </aside>
    <div class="main">
      <div class="topbar"><div class="crumbs" id="crumbs"></div>
        <div class="right"><div class="scope mode" role="group" aria-label="Interface mode" title="Guided shows one next step at a time; Advanced shows every tool"><button data-mode="guided" class="${App.guided() ? "on" : ""}">Guided</button><button data-mode="advanced" class="${App.guided() ? "" : "on"}">Advanced</button></div><span class="small sub">Records:</span><div class="scope" role="group" aria-label="Which records to show">
          <button data-scope="real" class="${App.training ? "" : "on"}">Operational</button><button data-scope="training" class="train ${App.training ? "on" : ""}">Training</button></div></div></div>
      ${App.training ? `<div class="trainbar">Training mode — synthetic practice cases and archive records. They are kept separate from operational records and never match them.</div>` : ""}
      <div id="subnav"></div><main class="page" id="page" tabindex="-1"></main>
    </div></div>`;
  $("#logout").onclick = async e => { e.preventDefault(); await api.post("/api/auth/logout").catch(() => {}); location.hash = ""; location.reload(); };
  $("#pwLink").onclick = e => { e.preventDefault(); changePassword(false); };
  document.body.classList.toggle("guided", App.guided());
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = async () => {
    const m = b.dataset.mode; if ((App.me.ui_mode || "guided") === m) return;
    try { await api.patch("/api/me/preferences", { ui_mode: m }); App.me.ui_mode = m; shell(); route(); toast(m === "guided" ? "Guided mode: one next step at a time, advanced tools hidden." : "Advanced mode: all tools shown."); } catch (e) { fail(e); }
  });
  document.querySelectorAll("[data-scope]").forEach(b => b.onclick = () => { App.setScope(b.dataset.scope); route(); });
}
export function crumbs(html) { const c = $("#crumbs"); if (c) c.innerHTML = html; }

let routeSeq = 0;
async function route() {
  if (!App.me) return;
  const h = location.hash || "#/home", seq = ++routeSeq;
  const r = ROUTES.find(([re]) => re.test(h));
  if (!r) { location.hash = "#/home"; return; }
  const group = Object.keys(GROUPS).find(g => GROUPS[g].includes(r[2]));
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("on", a.dataset.nav === group || a.dataset.nav === `x-${r[2]}`));
  const sn = $("#subnav"); if (sn) sn.innerHTML = group === "verify" ? `<nav class="subnav" aria-label="Verify Information">${[App.can("case.create") && ["investigate", "#/investigate", "Analyze information"], ["cases", "#/cases", "Cases"], ["review", "#/review", "Review queue"]].filter(Boolean).map(([k, hr, l]) => `<a href="${hr}" class="${k === r[2] || (k === "investigate" && r[2] === "start") ? "on" : ""}"${k === r[2] ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>` : "";
  const nm = $("#navMore"); if (nm && nm.querySelector(".on")) nm.open = true;
  const page = $("#page"); page.innerHTML = `<div class="empty"><span class="spin"></span> Loading…</div>`;
  try {
    const mod = await r[1]();
    if (seq !== routeSeq) return;
    await mod.render(page, h.match(r[0]).slice(1), { isCurrent: () => seq === routeSeq });
    page.focus({ preventScroll: true });
  } catch (e) { if (seq === routeSeq) page.innerHTML = `<div class="callout bad"><div><b>This page could not be loaded.</b> ${esc(e.message)}</div></div>`; console.error(e); }
  refreshNavCounts();
}
export async function refreshNavCounts() {
  try { const d = await api.get(`/api/dashboard?${App.q()}`); const n = d.counts.awaiting_approval, el = $("#navReview"); if (el) { el.hidden = !n; el.textContent = n; } } catch {}
  try { const o = await api.get(`/api/live/alerts?status=new&scope=watchlists&limit=500&${App.q()}`), el = $("#navLive"); if (el) { el.hidden = !o.alerts.length; el.textContent = o.alerts.length; el.title = "New live monitoring alerts"; } } catch {}
  try { const w = await api.get("/api/watch/alerts?status=new&limit=1"), el = $("#navWatch"); if (el) { el.hidden = !w.total; el.textContent = w.total; el.title = "New mention alerts"; } } catch {}
}

async function changePassword(forced) {
  const body = `${forced ? `<div class="callout warn" style="margin-bottom:10px"><div>You signed in with a temporary password. Choose your own before continuing.</div></div>` : ""}
    <label class="f" for="pwCur">Current password</label><input type="password" id="pwCur" autocomplete="current-password">
    <label class="f" for="pwNew">New password</label><input type="password" id="pwNew" autocomplete="new-password"><div class="hint">At least 12 characters, with letters and numbers.</div>
    <label class="f" for="pwNew2">Repeat new password</label><input type="password" id="pwNew2" autocomplete="new-password">`;
  const r = await modal(forced ? "Choose a new password" : "Change password", body, [...(forced ? [] : [{ label: "Cancel", value: null }]), { label: "Save password", kind: "primary",
    validate: async el => { const n = $("#pwNew", el).value; if (n !== $("#pwNew2", el).value) return "The new passwords do not match."; try { await api.post("/api/me/password", { current: $("#pwCur", el).value, next: n }); } catch (e) { return e.message; } }, value: true }]);
  if (r.value) { toast("Password changed."); if (forced) { App.me.must_change_password = false; start(); } }
  else if (forced) changePassword(true);
}

function loginView(msg) {
  $("#root").innerHTML = `<div class="login">
    <section class="art"><div><div class="brand-mark" style="width:44px;height:44px;font-size:15px">AIVS</div>
      <h1>Information Verification and Evidence Assistant</h1>
      <p>A workspace for authorised analysts to examine public or approved text, images and video, compare evidence, record what remains uncertain, and produce reviewed verification reports.</p>
      <ul><li>Every file is preserved and fingerprinted on receipt.</li><li>Automated checks and AI produce leads and suggestions only.</li><li>Every assessment is approved by a second, authorised reviewer.</li></ul></div>
      <p class="tiny" style="color:#8aa2b8">Authorised use only. Activity is recorded in a tamper-evident audit log.</p></section>
    <section class="form"><h2>Sign in</h2><p class="muted small">Use the account issued by your administrator.</p>
      <form id="lf" novalidate>
        <label class="f" for="lu">Username</label><input type="text" id="lu" autocomplete="username" required>
        <label class="f" for="lp">Password</label><input type="password" id="lp" autocomplete="current-password" required>
        <div id="lerr" class="callout bad" style="margin-top:12px" ${msg ? "" : "hidden"}>${esc(msg || "")}</div>
        <button class="btn primary" style="width:100%;margin-top:16px;padding:10px" id="lb">Sign in</button>
      </form>
      <div class="notice">First installation? The server creates an <b>admin</b> account and writes a one-time password to <span class="mono">data/FIRST-LOGIN.txt</span>.</div></section></div>`;
  $("#lu").focus();
  $("#lf").onsubmit = async e => {
    e.preventDefault(); const b = $("#lb"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Signing in…';
    try { await api.post("/api/auth/login", { username: $("#lu").value.trim(), password: $("#lp").value }); await start(); }
    catch (er) { $("#lerr").hidden = false; $("#lerr").textContent = er.message; b.disabled = false; b.textContent = "Sign in"; }
  };
}

// The version of these browser files. If the running server reports a different version, the server was not
// restarted after an update: the pages are new but the server code is old, so new features show nothing.
export const CLIENT_VERSION = "1.31.0";
async function checkServerVersion() {
  try {
    const h = await fetch("/healthz", { cache: "no-store" }).then(r => r.json());
    if (h?.version && h.version !== CLIENT_VERSION && !$("#verBanner")) {
      const d = document.createElement("div"); d.id = "verBanner"; d.className = "callout warn"; d.style.cssText = "margin:8px 16px";
      d.innerHTML = `<div><b>AIVS was updated, but the server is still running the old version (${esc(h.version)}; the pages are ${CLIENT_VERSION}).</b> Close the AIVS window and start it again (start-windows.bat or start-for-reviewers.bat). Until then, new features such as the AI Watchlist dataset monitoring will not work.</div>`;
      document.body.prepend(d);
    }
  } catch { /* the health check is optional */ }
}
async function start() {
  try { const me = await api.get("/api/me"); App.me = me.user; App.perms = me.permissions; }
  catch { App.me = null; return loginView(); }
  if (App.me.must_change_password) { $("#root").innerHTML = ""; return changePassword(true); }
  try { await App.refreshMeta(); } catch (e) { return fail(e); }
  shell(); route(); checkServerVersion();
}
window.addEventListener("hashchange", route);
window.addEventListener("aivs:signedout", () => { if (App.me) { App.me = null; loginView("Your session ended. Sign in again."); } });
start();

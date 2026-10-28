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
  [/^#\/search(?:\?(.*))?$/, () => import("./pages/search.js"), "search"],
  [/^#\/privacy$/, () => import("./pages/privacy.js"), "privacy"],
  [/^#\/cases(?:\?(.*))?$/, () => import("./pages/cases.js"), "cases"],
  [/^#\/new$/, () => import("./pages/newcase.js"), "new"],
  [/^#\/case\/([^/]+)(?:\/(\w+))?$/, () => import("./pages/case.js"), "cases"],
  [/^#\/watch(?:\/(overview|alerts|lists|sources|list)(?:\/(\d+))?)?(?:\?.*)?$/, () => import("./pages/watch.js"), "watch"],
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
export const GROUPS = { verify: ["start", "cases", "review", "verify", "new", "search"], social: ["monitor"], watch: ["watch"], reports: ["reports"], settings: ["settings", "admin"], home: ["home"] };
export const OTHER_TOOLS = [["dashboard", "#/dashboard", "Statistics", "dash"], ["verify", "#/verify", "Verify (single page)", "verify"], ["new", "#/new", "New case with files", "new"], ["search", "#/search", "Search and check", "search"],
  ["archive", "#/archive", "Reference archive", "archive"], ["datasets", "#/datasets", "Fact-check datasets", "data"]];
function shell() {
  const nav = [
    ["home", "#/home", "Dashboard", "dash"],
    ["verify", App.can("case.create") ? "#/start" : "#/cases", "Verify Information", "verify"],
    ["social", "#/monitor", "Social Media Analysis", "monitor"],
    ["watch", "#/watch", "AI Watchlist", "watch"],
    ["reports", "#/reports", "Reports", "reports"],
    ["settings", "#/settings", "Settings", "admin"]
  ];
  const more = App.guided() ? [] : OTHER_TOOLS.filter(([k]) => k !== "new" || App.can("case.create")).filter(([k]) => k !== "verify" || App.can("case.create"));
  $("#root").innerHTML = `<div class="shell">
    <aside class="side" aria-label="Main navigation">
      <div class="brand"><div class="brand-mark">AIVS</div><div><b>AIVS</b><span>Information verification</span></div></div>
      <nav class="nav">${nav.map(([k, h, l, ic]) => `<a href="${h}" data-nav="${k}">${icon(ic)}<span>${l}</span>${k === "verify" ? `<span class="count" id="navReview" hidden title="Cases awaiting approval"></span>` : k === "watch" ? `<span class="count" id="navWatch" hidden></span>` : ""}</a>`).join("")}
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
  const sn = $("#subnav"); if (sn) sn.innerHTML = group === "verify" ? `<nav class="subnav" aria-label="Verify Information">${[App.can("case.create") && ["start", "#/start", "New investigation"], ["cases", "#/cases", "Cases"], ["review", "#/review", "Review queue"]].filter(Boolean).map(([k, hr, l]) => `<a href="${hr}" class="${k === r[2] ? "on" : ""}"${k === r[2] ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>` : "";
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
  $("#root").innerHTML = `<main class="login">
    <section class="art" aria-label="JICHO AI introduction">
      <div class="login-brand"><div class="stratcom-mark">
        <svg viewBox="0 0 200 48" aria-label="STRATCOM" role="img"><defs><path id="stratcom-arc" d="M 18,44 Q 100,-22 182,44"/></defs><text><textPath href="#stratcom-arc" startOffset="50%" text-anchor="middle">STRATCOM</textPath></text></svg>
        <img src="/assets/login/kdf.png" alt="Kenya Defence Forces emblem" width="1244" height="1120">
      </div><div><h1>JICHO <span>AI</span></h1><p>Information Operations<br>Intelligence System</p><div class="kenya-stripe" aria-hidden="true"></div></div></div>
      <p class="login-motto">Monitor · Verify · Analyse · Assess · Report</p>
      <div class="login-context"><b>Academic / unofficial project</b><p>Emblems are reference assets. This project does not imply KDF or DMI endorsement.</p></div>
    </section>
    <section class="form" aria-labelledby="login-title">
      <img class="dmi-emblem" src="/assets/login/dmi.png" alt="Directorate of Military Intelligence emblem" width="1500" height="1070">
      <div class="login-fields"><h2 id="login-title">Sign in</h2><p class="login-intro">Use the account issued by your administrator.</p>
      <form id="lf">
        <label class="f" for="lu">Username</label><input type="text" id="lu" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
        <label class="f" for="lp">Password</label><div class="login-password"><input type="password" id="lp" name="password" autocomplete="current-password" required><button type="button" id="loginReveal" aria-controls="lp" aria-pressed="false">Show password</button></div>
        <div id="lerr" class="callout bad" role="alert" tabindex="-1" ${msg ? "" : "hidden"}>${esc(msg || "")}</div>
        <button class="btn primary" id="lb" type="submit">Sign in <span aria-hidden="true">→</span></button>
      </form>
      <div class="notice">Need access or help signing in? Contact your administrator.</div>
      <p class="login-audit">Authorised use only. Activity is recorded in an audit log.</p></div>
    </section></main>`;
  $("#lu").focus({ preventScroll: true });
  $("#loginReveal").onclick = () => {
    const input = $("#lp"), reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    $("#loginReveal").textContent = reveal ? "Hide password" : "Show password";
    $("#loginReveal").setAttribute("aria-pressed", String(reveal));
  };
  $("#lf").onsubmit = async e => {
    e.preventDefault(); const b = $("#lb"); if (b.disabled) return;
    b.disabled = true; b.textContent = "Signing in…"; $("#lf").setAttribute("aria-busy", "true"); $("#lerr").hidden = true;
    try { await api.post("/api/auth/login", { username: $("#lu").value.trim(), password: $("#lp").value }); $("#lp").value = ""; await start(); }
    catch (er) {
      const error = $("#lerr"); error.hidden = false; error.textContent = er.message;
      $("#lp").value = ""; $("#lp").type = "password"; $("#loginReveal").textContent = "Show password"; $("#loginReveal").setAttribute("aria-pressed", "false");
      b.disabled = false; b.textContent = "Sign in"; $("#lf").removeAttribute("aria-busy"); error.focus();
    }
  };
}

// The version of these browser files. If the running server reports a different version, the server was not
// restarted after an update: the pages are new but the server code is old, so new features show nothing.
export const CLIENT_VERSION = "1.22.0";
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

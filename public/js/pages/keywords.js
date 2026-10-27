// Keyword search and monitoring of public information: any keyword, phrase, hashtag or combination, searched now across every
// connected source, saved as recurring watchlists, analysed and reported. Everything shown comes from the server's records;
// sources that are not configured, restricted or failing say so, and nothing is filled in.
import { api } from "../api.js";
import { App } from "../app.js";
import { $, $$, esc, toast, fail, fmtDT, ago, empty } from "../ui.js";

const CAT = { Connected: "sup", "Configured, not yet tested": "info", Restricted: "warn", Unavailable: "con", "Not configured": "grey" };
const RUN = { ok: ["Results", "sup"], not_configured: ["Not configured", "grey"], restricted: ["Restricted", "warn"], rate_limited: ["Rate limited", "warn"], failed: ["Failed", "con"] };
const VER = { not_verified: "grey", pending: "info", supported: "sup", contradicted: "con", insufficient: "grey", misleading: "mix", not_verifiable: "grey", failed: "con" };
const GROUPS = ["News", "YouTube", "X", "Facebook", "Instagram", "Reddit", "Bluesky", "Mastodon", "Threads", "TikTok", "Telegram"];
const chip = (l, c) => `<span class="chip ${c}">${esc(l)}</span>`;
const dt = iso => (iso ? fmtDT(iso) : "date not given");
const qs = () => Object.fromEntries(new URLSearchParams(location.hash.split("?")[1] || ""));

export function itemCard(it) {
  return `<div class="lpost" data-item="${it.id}">
    ${it.has_image ? `<img src="/api/monitor/items/${it.id}/image" alt="Image published with the item" loading="lazy">` : ""}
    <div class="lpb"><div class="row" style="gap:6px;flex-wrap:wrap">${chip(it.platform, "navy")}${chip(it.verification.label, VER[it.verification.status] || "grey")}
      ${it.duplicate_of ? chip("Same item found by another source", "grey") : ""}${it.origin === "own_page" ? chip("Own Page", "teal") : it.origin === "test" ? chip("Test data", "train") : ""}
      ${(it.analysis?.indicators || []).length ? chip("Misinformation indicators", "warn") : ""}</div>
      <p class="lmsg">${esc(it.text.slice(0, 420))}${it.text.length > 420 ? "…" : ""}</p>
      <div class="tiny sub">${esc(it.account || "source not named")} · published ${esc(dt(it.posted_at))} · found ${ago(it.collected_at)}
        · ${it.matched_terms?.length ? `matched ${it.matched_terms.map(t => `“${esc(t)}”`).join(", ")}` : "matched by the source's own search (the keyword is in the full article or video)"}${(it.analysis?.themes || []).length ? ` · ${esc(it.analysis.themes.slice(0, 2).join(", "))}` : ""}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap">${it.url ? `<a class="btn sm ghost" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Open original</a>` : ""}
        ${it.verification.report_id ? `<a class="btn sm ghost" href="#/investigate/${esc(it.verification.investigation_id)}">Report ${esc(it.verification.report_id)}</a>` : App.can("case.create") ? `<button class="btn sm" data-verify="${it.id}">Verify</button>` : ""}</div></div></div>`;
}
function wireVerify(root, again) {
  for (const im of $$(".lpost img", root)) im.addEventListener("error", () => im.remove(), { once: true });   // an image the source no longer serves is left out
  for (const b of $$("[data-verify]", root)) b.onclick = async () => { b.disabled = true; b.textContent = "Verifying…"; try { const r = await api.post(`/api/monitor/items/${b.dataset.verify}/verify`, {}); toast(`Verification started (${r.report_id || r.investigation_id}).`); setTimeout(again, 1500); } catch (e) { fail(e); b.disabled = false; b.textContent = "Verify"; } };
}
function filterBar(f, sourcesSeen) {
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur || "") === String(v) ? "selected" : ""}>${esc(l)}</option>`;
  return `<form class="card lfilt" id="kf"><div class="bd row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
    <div><label class="f" for="kfs">Source</label><select id="kfs">${opt("", "All sources")}${GROUPS.filter(g => !sourcesSeen || sourcesSeen.includes(g)).map(g => opt(g, g, f.source)).join("")}</select></div>
    <div><label class="f" for="kff">From</label><input type="date" id="kff" value="${esc(f.from || "")}"></div><div><label class="f" for="kft">To</label><input type="date" id="kft" value="${esc(f.to || "")}"></div>
    <div><label class="f" for="kfq">Words</label><input id="kfq" value="${esc(f.q || "")}" placeholder="within the results"></div>
    <div><label class="f" for="kfv">Verification</label><select id="kfv">${opt("", "Any")}${opt("not_verified", "Not verified yet", f.verification)}${opt("verified", "Sent for verification", f.verification)}</select></div>
    <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="kfd" ${f.hide_duplicates === "1" ? "checked" : ""}> Hide duplicates</label>
    <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="kfi" ${f.images === "1" ? "checked" : ""}> With images</label>
    <button class="btn primary sm">Apply</button></div></form>`;
}
function readFilters(root, base, keep = {}) {
  const p = new URLSearchParams(keep); for (const [k, s] of [["source", "#kfs"], ["from", "#kff"], ["to", "#kft"], ["q", "#kfq"], ["verification", "#kfv"]]) { const v = $(s, root).value; if (v) p.set(k, v); }
  if ($("#kfd", root).checked) p.set("hide_duplicates", "1"); if ($("#kfi", root).checked) p.set("images", "1"); location.hash = `${base}${p.toString() ? `?${p}` : ""}`;
}
const groupsIn = rows => [...new Set(rows.map(r => /^News/.test(r.platform) ? "News" : r.platform === "X (Twitter)" ? "X" : r.platform))];

// ---------------------------------------------------------------- overview (multi-source)
export async function overviewView(body, ownPage) {
  const o = await api.get("/api/monitor/overview"), c = o.counts;
  const fig = (v, l, h, cls = "") => `<a class="kpi ${cls}" href="${h}"><div class="l">${l}</div><div class="v">${Number(v).toLocaleString()}</div></a>`;
  body.innerHTML = `<div class="kpis">${fig(c.items, "items discovered", "#/live/discovered")}${fig(c.items_today, "found today", "#/live/discovered")}${fig(c.active_watchlists, "active watchlists", "#/live/watchlists")}
      ${fig(c.searches, "searches run", "#/live/search")}${fig(c.new_alerts, "new alerts", "#/live/alerts", c.new_alerts ? "alert" : "")}${fig(c.verified, "items sent for verification", "#/live/discovered?verification=verified")}${fig(c.reports, "monitoring reports", "#/live/reports")}</div>
    <div class="grid g2"><div class="card"><div class="hd"><h3>Sources</h3><a class="small right" href="#/live/sources">Details</a></div><div class="bd small">
      ${Object.entries(o.by_category).map(([k, v]) => `<div class="row" style="justify-content:space-between">${chip(k, CAT[k] || "grey")}<b>${v}</b></div>`).join("")}
      <p class="tiny sub" style="margin-top:8px">Connected: ${esc(o.connected.join(", ") || "none yet")}. Collected items by platform: ${esc(o.by_platform.map(p => `${p.platform} ${p.n}`).join(", ") || "none yet")}.</p></div></div>
    <div class="card"><div class="hd"><h3>Recent searches</h3><a class="small right" href="#/live/search">New search</a></div><div class="bd small">${o.searches.length ? `<ul class="mini">${o.searches.map(s => `<li><a href="#/live/search/${s.id}" style="flex:1">${esc(s.query)}</a><span class="sub">${s.results} result(s) · ${ago(s.created_at)}</span></li>`).join("")}</ul>` : `<p class="sub" style="margin:0">No search yet.</p>`}</div></div></div>
    <div class="card" style="margin-top:12px"><div class="hd"><h3>Latest discovered items</h3><a class="small right" href="#/live/discovered">All items and filters</a></div><div class="bd">${o.recent.length ? `<div class="lposts">${o.recent.map(itemCard).join("")}</div>` : `<p class="sub" style="margin:0">Nothing discovered yet. <a href="#/live/search">Search a keyword</a> or activate a watchlist.</p>`}</div></div>
    ${ownPage || ""}`;
  wireVerify(body, () => overviewView(body, ownPage));
}

// ---------------------------------------------------------------- search
export async function searchView(body, id) {
  if (id) return runView(body, id);
  const s = await api.get("/api/monitor/sources"), f = qs();
  body.innerHTML = `<form class="card" id="ks"><div class="bd">
      <label class="f" for="kq">Keyword, phrase, hashtag or topic</label><input id="kq" style="width:100%;font-size:16px" value="${esc(f.q || "")}" placeholder='for example:  "Kenya Army" OR KDF AND Lamu -recruitment' autocomplete="off">
      <div class="tiny sub" id="kqp" style="margin-top:4px">Words next to each other are one phrase. Use OR (or a comma) for alternatives, AND for words that must also appear, -word or NOT word to exclude, "quotes" for exact phrases, #tags for hashtags.</div>
      <div class="row" style="gap:12px;flex-wrap:wrap;margin-top:10px;align-items:flex-end"><div><label class="f" for="kfrom">From</label><input type="date" id="kfrom"></div><div><label class="f" for="kto">To</label><input type="date" id="kto"></div>
        <div><label class="f" for="kmax">Results per source</label><select id="kmax"><option>10</option><option selected>30</option><option>50</option><option>100</option></select></div></div>
      <h4 style="margin:14px 0 6px">Sources</h4><div class="ksrc">${s.sources.map(x => `<label class="ksource ${x.state === "ready" ? "" : "off"}" title="${esc([x.needs, x.access_limit].filter(Boolean).join(" "))}"><input type="checkbox" value="${x.key}" ${x.state === "ready" ? "checked" : "disabled"}> <b>${esc(x.platform)}</b> ${chip(x.category, CAT[x.category] || "grey")}<span class="tiny sub">${esc(x.state === "ready" ? (x.access_limit || "").slice(0, 140) : x.needs || "")}</span></label>`).join("")}</div>
      <details style="margin-top:8px"><summary class="small">News sites to read (RSS)</summary><label class="f" for="kfeeds">Feed or site addresses, one per line (empty: RSS_FEEDS from the server, or the main Kenyan news sites)</label><textarea id="kfeeds" rows="3" style="width:100%"></textarea></details>
      <p class="tiny sub">${esc(s.note)}</p>
      <div class="row" style="gap:8px"><button class="btn primary" id="kgo">Search now</button><span class="callout bad" id="kerr" hidden></span></div></div></form>
    <div class="card" style="margin-top:12px"><div class="hd"><h3>Earlier searches</h3></div><div class="bd" id="kprev"></div></div>`;
  const q = $("#kq", body), hint = $("#kqp", body), base = hint.textContent; let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(async () => { if (!q.value.trim()) { hint.textContent = base; return; } const r = await api.post("/api/monitor/parse", { query: q.value }).catch(() => null); hint.textContent = r?.ok ? `Searches for ${[r.parsed.terms.map(x => `“${x}”`).join(" or "), ...r.parsed.require_groups.map(g => `and ${g.map(x => `“${x}”`).join(" or ")}`), r.parsed.exclude.length ? `without ${r.parsed.exclude.map(x => `“${x}”`).join(", ")}` : ""].filter(Boolean).join(" ")}.` : r?.error || base; }, 300); };
  $("#ks", body).onsubmit = async e => { e.preventDefault(); const err = $("#kerr", body); err.hidden = true;
    const sources = $$(".ksrc input:checked", body).map(i => i.value);
    try { const r = await api.post("/api/monitor/searches", { query: q.value, sources, from: $("#kfrom", body).value || undefined, to: $("#kto", body).value || undefined, max: +$("#kmax", body).value, feeds: $("#kfeeds", body).value }); location.hash = `#/live/search/${r.id}`; }
    catch (x) { err.textContent = x.message; err.hidden = false; } };
  const prev = (await api.get("/api/monitor/searches?limit=15")).searches;
  $("#kprev", body).innerHTML = prev.length ? `<table class="t"><tbody>${prev.map(p => `<tr><td><a href="#/live/search/${p.id}">${esc(p.query)}</a></td><td class="small">${p.results} result(s)</td><td class="small">${esc(p.status)}</td><td class="small sub">${fmtDT(p.created_at)} · ${esc(p.by_name || "")}</td></tr>`).join("")}</tbody></table>` : `<p class="sub" style="margin:0">No search yet.</p>`;
  if (f.q) q.oninput();
}
async function runView(body, id) {
  const s = await api.get(`/api/monitor/searches/${id}`), f = qs();
  const per = s.per_source.map(p => `<tr><td><b>${esc(p.label)}</b>${p.note ? `<div class="tiny sub">${esc(p.note.slice(0, 220))}</div>` : ""}</td><td>${chip(...(RUN[p.state] || [p.state, "grey"]))}</td><td>${p.fetched}</td><td>${p.matched}</td><td>${p.new}</td><td>${p.duplicates}</td><td class="tiny">${esc(p.error || "")}</td></tr>`).join("");
  body.innerHTML = `<div class="card"><div class="hd"><h3>${esc(s.query)}</h3>${chip(s.status === "running" ? "Searching…" : s.status === "done" ? "Finished" : "Failed", s.status === "done" ? "sup" : s.status === "running" ? "info" : "con")}</div><div class="bd small">
      <p>Searched for ${esc(s.description)}, from ${fmtDT(s.period_from)}${s.period_to ? ` to ${fmtDT(s.period_to)}` : " to now"}, by ${esc(s.created_by_name || "")}. ${s.results} item(s) found.${s.error ? ` <span class="sub">${esc(s.error)}</span>` : ""}</p>
      <table class="t"><thead><tr><th>Source</th><th>Result</th><th>Returned</th><th>Matching</th><th>New</th><th>Duplicates</th><th>Error</th></tr></thead><tbody>${per || `<tr><td colspan="7" class="sub">Searching the first source…</td></tr>`}</tbody></table>
      ${s.status === "done" ? `<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">${App.can("watch.triage") ? `<button class="btn primary sm" id="krep">${s.report_id ? "Draft a new report" : "Analyse and draft report"}</button>` : ""}${s.report_id ? `<a class="btn sm" href="/api/monitor/reports/${s.report_id}/file.html" target="_blank" rel="noopener">Open report</a><a class="btn sm ghost" href="/api/monitor/reports/${s.report_id}/file.pdf" download>PDF</a>` : ""}
        ${s.watchlist_id ? `<a class="btn sm ghost" href="#/live/discovered?watchlist=${s.watchlist_id}">Recurring watchlist</a>` : App.can("watch.manage") ? `<button class="btn sm" id="kwl">Save as recurring watchlist</button>` : `<span class="tiny sub">A reviewer can save this search as a recurring watchlist.</span>`}</div>` : ""}</div></div>
    <div id="kres" style="margin-top:12px"></div>`;
  if (s.status === "running") { const h = location.hash; setTimeout(() => { if (location.hash === h) runView(body, id); }, 1500); }
  const r = await api.get(`/api/monitor/searches/${id}/results?${new URLSearchParams({ ...f, limit: 200 })}`);
  $("#kres", body).innerHTML = `${filterBar(f, groupsIn(r.by_source))}<p class="small sub">${r.total} item(s)${r.by_source.length ? `: ${esc(r.by_source.map(b => `${b.platform} ${b.n}`).join(", "))}` : ""}.</p>${r.items.length ? `<div class="lposts">${r.items.map(itemCard).join("")}</div>` : s.status === "done" ? empty("No results", "None of the searched sources returned an item that matches. Nothing is shown that a source did not return.") : ""}`;
  $("#kf", body).onsubmit = e => { e.preventDefault(); readFilters(body, `#/live/search/${id}`); };
  wireVerify(body, () => runView(body, id));
  $("#krep", body)?.addEventListener("click", async e => { e.target.disabled = true; e.target.textContent = "Analysing…"; try { const rep = await api.post(`/api/monitor/searches/${id}/report`, {}); toast(`Report ${rep.report_id} drafted${rep.written_by === "ai" ? " with the AI model" : ""}.`); window.open(`/api/monitor/reports/${rep.id}/file.html`, "_blank", "noopener"); runView(body, id); } catch (x) { fail(x); e.target.disabled = false; } });
  $("#kwl", body)?.addEventListener("click", async () => { try { const w = await api.post(`/api/monitor/searches/${id}/watchlist`, { alert_mode: "every_post" }); toast(`Saved as a watchlist (${w.status}). It repeats automatically.`); runView(body, id); } catch (x) { fail(x); } });
}

// ---------------------------------------------------------------- everything discovered
export async function discoveredView(body) {
  const f = qs(), [r, ov] = await Promise.all([api.get(`/api/monitor/feed?${new URLSearchParams({ ...f, limit: 150 })}`), api.get("/api/watch/overview").catch(() => ({ watchlists: [] }))]);
  const wls = ov.watchlists.filter(w => w.status === "active");
  body.innerHTML = `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px"><a class="btn sm ${!f.watchlist ? "primary" : "ghost"}" href="#/live/discovered">All watchlists and searches</a>${wls.map(w => `<a class="btn sm ${String(f.watchlist) === String(w.id) ? "primary" : "ghost"}" href="#/live/discovered?watchlist=${w.id}">${esc(w.name)}</a>`).join("")}</div>
    ${filterBar(f, null)}<p class="small sub">${r.total} item(s)${r.by_source.length ? `: ${esc(r.by_source.map(b => `${b.platform} ${b.n}`).join(", "))}` : ""}.</p>
    ${r.items.length ? `<div class="lposts">${r.items.map(itemCard).join("")}</div>` : empty("Nothing discovered", "No item matches these filters. Run a search, or activate a watchlist so the sources are searched automatically.")}`;
  $("#kf", body).onsubmit = e => { e.preventDefault(); readFilters(body, "#/live/discovered", f.watchlist ? { watchlist: f.watchlist } : {}); };
  wireVerify(body, () => discoveredView(body));
}

// ---------------------------------------------------------------- saved watchlists (recurring searches): create, edit, activate, pause, delete
const KENYA_SITES = ["https://nation.africa", "https://www.standardmedia.co.ke", "https://www.the-star.co.ke", "https://www.capitalfm.co.ke/news", "https://www.kbc.co.ke", "https://www.citizen.digital", "https://www.kenyans.co.ke", "https://www.pd.co.ke"];
const qt = t => (/[\s,]/.test(t) && !t.startsWith("#") ? `"${t}"` : t);
export const queryOf = d => [d.terms.map(qt).join(" OR "), ...(d.require_groups || []).map(g => `AND ${g.map(qt).join(" OR ")}`), ...d.exclude.map(x => `-${qt(x)}`)].join(" ");
// why a watchlist is not running, in plain words
function whyNot(w, ready) {
  if (w.status === "active") { const off = w.definition.sources.filter(k => !ready.has(k)); return off.length === w.definition.sources.length ? "Active, but none of its sources is connected, so nothing is collected." : off.length ? `Running. Not connected: ${off.join(", ")}.` : "Running on schedule."; }
  if (w.status === "paused") return "Paused by a reviewer: not collecting.";
  const live = w.definition.sources.filter(k => ready.has(k));
  if (!live.length) return `Not running: none of its sources (${w.definition.sources.join(", ") || "none"}) is connected. Edit it and choose connected sources.`;
  return w.previewed_current ? "Not running: checked but not activated yet." : "Not running: never activated, or changed since it was last checked.";
}
async function editor(w, srcs) {
  const { modal } = await import("../ui.js");
  const d = w?.definition || { terms: [], exclude: [], sources: srcs.filter(x => x.state === "ready" && x.key !== "fb_live").map(x => x.key), feeds: [], alert_mode: "every_post", intervals: {} };
  const iv = Object.values(d.intervals || {})[0] || 30;
  const usable = srcs;
  const body = `<label class="f" for="we_n">Name</label><input id="we_n" style="width:100%" value="${esc(w?.name || "")}" placeholder="for example: Lamu security">
    <label class="f" for="we_q">Keywords</label><textarea id="we_q" rows="2" style="width:100%" placeholder='"Kenya Army" OR KDF AND Lamu -recruitment'>${esc(w ? queryOf(d) : "")}</textarea>
    <div class="tiny sub" id="we_p">OR (or a comma) for alternatives, AND for words that must also appear, -word to exclude, "quotes" for exact phrases, #tags.</div>
    <label class="f">Sources</label><div class="ksrc">${usable.map(x => `<label class="ksource ${x.state === "ready" ? "" : "off"}"><input type="checkbox" class="we_s" value="${x.key}" ${d.sources.includes(x.key) ? "checked" : ""}> <b>${esc(x.platform)}</b> ${chip(x.category, CAT[x.category] || "grey")}${x.state !== "ready" ? `<span class="tiny sub">${esc(x.needs || "")}</span>` : ""}</label>`).join("")}</div>
    <div class="row" style="gap:12px;flex-wrap:wrap;margin-top:8px"><div><label class="f" for="we_i">Search every</label><select id="we_i">${[[15, "15 minutes"], [30, "30 minutes"], [60, "hour"], [180, "3 hours"], [720, "12 hours"], [1440, "day"]].map(([v, l]) => `<option value="${v}" ${+iv === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div><label class="f" for="we_a">Alerts</label><select id="we_a"><option value="every_post" ${d.alert_mode === "every_post" ? "selected" : ""}>For every new item</option><option value="threshold" ${d.alert_mode !== "every_post" ? "selected" : ""}>Only for unusual activity (spikes, repetition)</option></select></div></div>
    <label class="f" for="we_f">News sites or RSS feeds (one per line; used by the News websites source)</label><textarea id="we_f" rows="3" style="width:100%">${esc((d.feeds?.length ? d.feeds : KENYA_SITES).join("\n"))}</textarea>
    <label class="f" for="we_b">Basis for collecting (required to activate)</label><input id="we_b" style="width:100%" value="${esc(w?.authorisation || "Public content through each platform's official API, under the platform's terms and the organisation's monitoring policy.")}">`;
  return modal(w ? `Edit watchlist: ${w.name}` : "New watchlist", body, [{ label: "Cancel", value: null }, { label: "Save as draft", value: el => ({ el, activate: false }), validate: el => check(el) }, { label: "Save and activate", kind: "primary", value: el => ({ el, activate: true }), validate: el => check(el) }], { wide: true,
    onOpen: el => { const q = $("#we_q", el), p = $("#we_p", el), base = p.textContent; let t; q.oninput = () => { clearTimeout(t); t = setTimeout(async () => { const r = await api.post("/api/monitor/parse", { query: q.value }).catch(() => null); p.textContent = !q.value.trim() ? base : r?.ok ? `Looks for ${[r.parsed.terms.map(x => `“${x}”`).join(" or "), ...r.parsed.require_groups.map(g => `and ${g.map(x => `“${x}”`).join(" or ")}`), r.parsed.exclude.length ? `without ${r.parsed.exclude.map(x => `“${x}”`).join(", ")}` : ""].filter(Boolean).join(" ")}.` : r?.error || base; }, 300); }; } });
  async function check(el) { if (!$("#we_n", el).value.trim()) return "Give the watchlist a name."; if (!$$(".we_s:checked", el).length) return "Choose at least one source."; const r = await api.post("/api/monitor/parse", { query: $("#we_q", el).value }).catch(e => ({ ok: false, error: e.message })); return r.ok ? null : r.error; }
}
async function saveWatchlist(w, out) {
  const el = out.el, parsed = (await api.post("/api/monitor/parse", { query: $("#we_q", el).value })).parsed, sources = $$(".we_s:checked", el).map(i => i.value), iv = +$("#we_i", el).value;
  const definition = { ...(w?.definition || {}), terms: parsed.terms, require_groups: parsed.require_groups, exclude: parsed.exclude, sources, feeds: $("#we_f", el).value.split(/\s+/).filter(x => /^https?:\/\//.test(x)),
    intervals: Object.fromEntries(sources.map(k => [k, iv])), alert_mode: $("#we_a", el).value, lookback_minutes: Math.max(60, iv * 2) };
  const b = { name: $("#we_n", el).value.trim(), definition, authorisation: $("#we_b", el).value.trim() };
  const id = w ? (await api.patch(`/api/watch/lists/${w.id}`, b), w.id) : (await api.post("/api/watch/lists", b)).id;
  if (out.activate) await activate(id);
  return id;
}
// activation needs a check of the current terms first; the check here uses the records already stored (no paid request)
async function activate(id) { await api.post(`/api/watch/lists/${id}/preview`, { live_sources: [] }); return api.post(`/api/watch/lists/${id}/status`, { status: "active" }); }
export async function watchlistsView(body) {
  const [ov, sx] = await Promise.all([api.get("/api/watch/overview"), api.get("/api/monitor/sources")]), wls = ov.watchlists, ready = new Set(sx.sources.filter(x => x.state === "ready").map(x => x.key));
  const st = { active: "sup", draft: "grey", paused: "warn" }, manage = App.can("watch.manage");
  body.innerHTML = `<div class="row" style="gap:8px;margin-bottom:10px;align-items:center">${manage ? `<button class="btn primary sm" id="wNew">New watchlist</button>` : ""}<span class="small sub">A watchlist is a saved search that AIVS repeats automatically on its schedule and alerts on. ${manage ? "" : "Reviewers and administrators create, edit and activate watchlists."}</span></div>
    ${wls.length ? `<table class="t"><thead><tr><th>Watchlist</th><th>Status</th><th>Keywords</th><th>Sources</th><th>Items</th><th>Last match</th><th></th></tr></thead><tbody>${wls.map(w => `<tr data-w="${w.id}"><td><b>${esc(w.name)}</b></td><td>${chip(w.status, st[w.status] || "grey")}<div class="tiny sub" style="max-width:220px">${esc(whyNot(w, ready))}</div></td>
      <td class="small">${esc(queryOf(w.definition)).slice(0, 220)}</td>
      <td class="tiny">${w.definition.sources.map(k => `<span class="${ready.has(k) ? "" : "sub"}">${esc(k)}${ready.has(k) ? "" : " (not connected)"}</span>`).join(", ")}</td><td>${w.matches}</td><td class="small">${w.last_match_at ? ago(w.last_match_at) : "—"}</td>
      <td><div class="row" style="gap:6px;flex-wrap:wrap">${manage ? `<button class="btn sm" data-act="edit">Edit</button>${w.status === "active" ? `<button class="btn sm ghost" data-act="pause">Pause</button>` : `<button class="btn sm primary" data-act="activate">Activate</button>`}` : ""}
        <a class="btn sm ghost" href="#/live/discovered?watchlist=${w.id}">Items</a>${App.can("watch.triage") ? `<button class="btn sm ghost" data-act="report">Report (24 h)</button>` : ""}${manage ? `<button class="btn sm ghost" data-act="delete">Delete</button>` : ""}</div></td></tr>`).join("")}</tbody></table>`
      : empty("No watchlists", "Create one with New watchlist, or run a search and save it as a recurring watchlist.")}`;
  $("#wNew", body)?.addEventListener("click", async () => { const r = await editor(null, sx.sources); if (!r.value) return; try { await saveWatchlist(null, r.value); toast(r.value.activate ? "Watchlist saved and activated." : "Watchlist saved as a draft."); } catch (e) { fail(e); } watchlistsView(body); });
  for (const b of $$("[data-act]", body)) b.onclick = async () => {
    const id = +b.closest("[data-w]").dataset.w, w = wls.find(x => x.id === id), act = b.dataset.act;
    try {
      if (act === "edit") { const r = await editor(w, sx.sources); if (!r.value) return; await saveWatchlist(w, r.value); toast(r.value.activate ? "Saved and activated." : "Saved. It stays a draft until activated."); }
      if (act === "activate") { await activate(id); toast("Activated: it now runs on its schedule."); }
      if (act === "pause") { await api.post(`/api/watch/lists/${id}/status`, { status: "paused" }); toast("Paused."); }
      if (act === "delete") { const { confirmBox } = await import("../ui.js"); if (!(await confirmBox("Delete watchlist", `Delete “${w.name}”? Its collected items and alert history are kept; it stops running and is hidden.`, "Delete", "danger"))) return; await api.del(`/api/watch/lists/${id}`); toast("Deleted."); }
      if (act === "report") { b.disabled = true; const r = await api.post(`/api/monitor/watchlists/${id}/report`, { hours: 24 }); toast(`Report ${r.report_id} drafted.`); window.open(`/api/monitor/reports/${r.id}/file.html`, "_blank", "noopener"); }
    } catch (e) { fail(e); }
    watchlistsView(body);
  };
}

// ---------------------------------------------------------------- monitoring reports
export async function reportsView(body) {
  const r = await api.get("/api/monitor/reports");
  body.innerHTML = r.reports.length ? `<table class="t"><thead><tr><th>Reference</th><th>Subject</th><th>Made</th><th>Text</th><th>Status</th><th></th></tr></thead><tbody>${r.reports.map(x => `<tr><td class="mono small">${esc(x.report_id)}</td>
      <td class="small">${esc(x.query || x.watchlist || "")}</td><td class="small">${fmtDT(x.created_at)} · ${esc(x.origin)}</td><td class="small">${x.written_by === "ai" ? "AI-drafted, checked" : "rule-based"}</td><td>${x.reviewed_at ? chip("Reviewed", "sup") : chip("AI-generated, not reviewed", "warn")}</td>
      <td><div class="row" style="gap:6px"><a class="btn sm" href="/api/monitor/reports/${x.id}/file.html" target="_blank" rel="noopener">Open</a><a class="btn sm ghost" href="/api/monitor/reports/${x.id}/file.pdf" download>PDF</a><a class="btn sm ghost" href="/api/monitor/reports/${x.id}/file.docx" download>Word</a></div></td></tr>`).join("")}</tbody></table>`
    : empty("No monitoring reports", "Run a search and choose Analyse and draft report. Each active watchlist with new items also gets a daily draft at 07:00 EAT.");
}

// ---------------------------------------------------------------- source status
export async function sourcesTable(body) {
  const s = await api.get("/api/monitor/sources"), order = ["Connected", "Configured, not yet tested", "Restricted", "Unavailable", "Not configured"];
  body.innerHTML = `<div class="callout info" style="margin-bottom:12px"><div>${esc(s.note)}</div></div>
    <table class="t"><thead><tr><th>Source</th><th>Status</th><th>Last search</th><th>Last scheduled run</th><th>Items collected</th><th>Access and limits</th></tr></thead><tbody>
    ${[...s.sources].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category)).map(x => `<tr><td><b>${esc(x.platform)}</b><div class="tiny sub">${esc(x.label)}</div></td><td>${chip(x.category, CAT[x.category] || "grey")}${x.needs && x.state !== "ready" ? `<div class="tiny sub">Needs: ${esc(x.needs)}</div>` : ""}</td>
      <td class="small">${x.last_search ? `${fmtDT(x.last_search.at)}: ${esc(x.last_search.state === "ok" ? `${x.last_search.results} result(s)` : x.last_search.error || x.last_search.state)}` : "—"}</td>
      <td class="small">${x.last_scheduled ? `${fmtDT(x.last_scheduled.at)} (${esc(x.last_scheduled.status)})${x.last_scheduled.error ? `<div class="tiny sub">${esc(x.last_scheduled.error.slice(0, 160))}</div>` : ""}` : "—"}</td><td>${x.items_collected}</td>
      <td class="tiny">${esc([x.access_limit, x.limits].filter(Boolean).join(" "))}</td></tr>`).join("")}</tbody></table>
    <h4 style="margin-top:14px">Not available from any source</h4><ul class="small">${s.not_available.map(u => `<li><b>${esc(u.platform)}</b>: ${esc(u.reason)}</li>`).join("")}</ul>`;
}

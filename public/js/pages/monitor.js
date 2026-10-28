// Information operations monitor: import permitted post datasets and review coordination SIGNALS.
// Every view states that signals are leads, not proof, and nothing here names who is behind activity.
import { api } from "../api.js";
import { App, crumbs, refreshNavCounts } from "../app.js";
import { $, $$, esc, toast, fail, confirmBox, modal, fmtDT, empty, errMsg, viewer, toLocalInput, fromLocalInput } from "../ui.js";
import { recognise } from "../lib/ocr.js";
// what the AI Watchlist did with an import (active watchlists check every new import automatically)
const watchNote = r => r?.watchlists?.length ? ` AI Watchlist: ${r.watchlists.map(w => `“${w.watchlist}” found ${w.matched} matching post${w.matched === 1 ? "" : "s"}${w.alerts ? `, ${w.alerts} new alert${w.alerts === 1 ? "" : "s"}` : ""}`).join("; ")}.` : "";
import { parsePostScreenshot } from "/shared/text.js";
import * as SM from "./social.js";
import * as SHOT from "./screenshot.js";

// content analysis (filters apply) and coordination indicators (whole dataset)
const TABS = [["overview", "Overview"], ["sentiment", "Sentiment"], ["topics", "Topics & narratives"], ["engagement", "Engagement"], ["claims", "Claims"], ["geography", "Geography"], ["posts", "Posts"], ["report", "Report"],
  ["summary", "Coordination"], ["messages", "Repeated messages"], ["hashtags", "Hashtag bursts"], ["network", "Network"], ["links", "Links & reposts"], ["accounts", "Accounts"]];
const FILTERED = new Set(["overview", "sentiment", "topics", "engagement", "claims", "geography", "posts", "report"]);
const n = x => Number(x || 0).toLocaleString();
const MAPK = ["text", "account", "posted_at", "platform", "url", "likes", "comments", "shares", "views", "loc_country", "loc_region", "loc_name", "profile_location", "repost_of", "account_created_at"];
const dt = iso => (iso ? fmtDT(iso) : "—");

export async function render(el, [id, tabArg]) {
  if (!id) return listPage(el);
  return datasetPage(el, id, TABS.some(t => t[0] === tabArg) ? tabArg : "overview");
}

// ---------------------------------------------------------------- dataset list and import
async function listPage(el) {
  crumbs(`<b>Social Media Analysis</b>`);
  SM.resetMeta();
  const [{ datasets, caveats }, M] = await Promise.all([api.get("/api/io/datasets"), SM.meta()]), canImport = App.can("io.import");
  el.innerHTML = `<div class="pagehead"><div><h1>Social Media Analysis</h1><p>Import or collect public posts you are permitted to use. AIVS estimates tone, finds themes, topics and checkable claims, summarises public engagement and location data, and looks for signs of coordination: near-identical messages, synchronised posting, hashtag bursts and links shared together.</p></div></div>
    ${SHOT.uploadCard()}
    <div class="callout warn" style="margin:14px 0"><div><b>Signals, not proof.</b> ${esc(caveats[0])} ${esc(caveats[2])}</div></div>
    <div class="split"><div class="stack">
      <div id="shotRecent"></div>
      <div class="card"><div class="hd"><h3>Datasets</h3><span class="chip grey right">${datasets.length}</span></div>
        ${datasets.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Dataset</th><th class="n">Posts</th><th class="n">Accounts</th><th>Period</th><th>Imported</th></tr></thead><tbody>${datasets.map(d => `<tr class="click" data-ds="${d.id}"><td><b>${esc(d.name)}</b>${d.is_sample ? ` <span class="chip train">synthetic</span>` : ""}<div class="tiny sub">${esc(d.source)}</div></td><td class="n">${n(d.posts)}</td><td class="n">${n(d.accounts)}</td><td class="small">${dt(d.first_at)}<br>to ${dt(d.last_at)}</td><td class="small">${esc(d.imported_by || "—")}<div class="tiny sub">${dt(d.imported_at)}</div></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="bd">${empty("No datasets yet", "Import a CSV or JSON export of posts, or load the synthetic sample to see how the monitor works.")}</div>`}</div>
    </div><div class="stack">
      ${canImport ? `<div class="card"><div class="hd"><h3>Advanced: import a dataset</h3><span class="chip grey right">CSV · JSON · Excel</span></div><div class="bd">
        <div class="hint" style="margin-top:0">For one screenshot of a post, use <b>Upload Screenshot — Automatic AI Analysis</b> above: nothing needs to be typed. This form is for datasets of many posts.</div>
        <label class="f" for="iof" style="margin-top:0">Posts: a CSV/JSON file, or screenshots of posts <span class="req">*</span></label><input type="file" id="iof" multiple accept=".csv,.json,.jsonl,.txt,.xlsx,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*">
        <div class="hint"><b>Several screenshots for a dataset</b> (optional, up to 50): AIVS reads them on this computer and shows you the account, time and text it found, for you to check and correct before they are added as dataset rows.</div>
        <div class="hint">Needs one column each for the text, the account and the time. Common names are recognised (text/content/tweet, username/author/account, created_at/date/timestamp). Optional: platform, url, likes, comments, shares, views, language, country / county / place, user_location, collected_at, repost_of, reply_to, account_created_at. CSV, JSON or Excel (.xlsx, first sheet). Up to 200,000 posts. <a href="/posts-template.csv" download>Download a template</a>.</div>
        <label class="f" for="ion">Name <span class="req">*</span></label><input type="text" id="ion" maxlength="200" placeholder="e.g. #ExampleTag posts, 1–7 Oct">
        <label class="f" for="ios">Where the data came from <span class="req">*</span></label><input type="text" id="ios" maxlength="500" placeholder="e.g. platform research API export; partner submission">
        <label class="f" for="ioa">Basis for using it <span class="req">*</span></label><input type="text" id="ioa" maxlength="1000" placeholder="e.g. research API terms; written permission from …; public posts under our data policy">
        <label class="f" for="iorq">Research question</label><input type="text" id="iorq" maxlength="1000" placeholder="e.g. How do residents discuss water services this month?">
        <label class="f" for="iod">Notes</label><textarea id="iod" rows="2" placeholder="How it was collected, what is missing"></textarea>
        <details style="margin-top:8px"><summary class="small sub">Column names (only if AIVS cannot find them)</summary><div class="grid g3" style="margin-top:6px">${MAPK.map(k => `<div><label class="f" for="m_${k}">${k}</label><input type="text" id="m_${k}" placeholder="column name"></div>`).join("")}</div></details>
        <div id="ioerr" class="callout bad" style="margin-top:10px" hidden></div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="ioGo">Import and analyse</button><span class="small muted" id="ioprog" aria-live="polite"></span></div>
        <div class="hint">No scraping: AIVS analyses only files you provide. Keep personal data to what the investigation needs.</div></div></div>
      ${SM.collectCard(M)}
      <div class="card"><div class="hd"><h3>Practice</h3></div><div class="bd small">Invented datasets, clearly labelled synthetic, to learn the views:
        <ul style="margin:6px 0 0 18px"><li><b>Public discussion sample</b> (about 200 posts on three invented platforms): tone, themes, a theme that grows late, a repeated claim, a scam message, engagement and locations.</li><li><b>Coordination sample</b> (about 600 posts): one planted coordinated pattern and one repost wave.</li></ul>
        <div class="row" style="margin-top:8px"><button class="btn" id="ioDisc">Load discussion sample</button><button class="btn" id="ioSample">Load coordination sample</button></div></div></div>` : `<div class="callout info"><div>Your role can view datasets but not import them.</div></div>`}
      ${SM.statusCards(M)}
      <div class="card"><div class="hd"><h3>How to read the results</h3></div><div class="bd small"><ul style="margin:0 0 0 18px;line-height:1.6">${caveats.map(c => `<li>${esc(c)}</li>`).join("")}</ul></div></div>
    </div></div>`;
  $$("[data-ds]").forEach(r => r.onclick = () => App.go(`#/monitor/${r.dataset.ds}`));
  SHOT.wireUploadCard();
  SHOT.recentList().then(h => { const box = $("#shotRecent"); if (box && h) { box.innerHTML = h; SHOT.wireRecent(); } });
  SM.wireCollect();
  if ($("#ioDisc")) $("#ioDisc").onclick = async () => { const b = $("#ioDisc"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Loading…'; try { const r = await api.post("/api/io/discussion-sample"); toast("Synthetic discussion sample loaded and analysed."); App.go(`#/monitor/${r.id}`); } catch (e) { fail(e); b.disabled = false; b.textContent = "Load discussion sample"; } };
  if ($("#ioSample")) $("#ioSample").onclick = async () => { const b = $("#ioSample"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Loading…'; try { const r = await api.post("/api/io/sample"); toast("Synthetic sample loaded and analysed."); App.go(`#/monitor/${r.id}`); } catch (e) { fail(e); b.disabled = false; b.textContent = "Load synthetic sample"; } };
  if ($("#ioGo")) $("#ioGo").onclick = async () => {
    const err = $("#ioerr"), files = [...$("#iof").files], f = files[0]; err.hidden = true;
    if (files.length && files.every(x => x.type.startsWith("image/"))) {
      const miss = [!$("#ion").value.trim() && "a name", !$("#ios").value.trim() && "where the screenshots came from", !$("#ioa").value.trim() && "the basis for using them"].filter(Boolean);
      if (miss.length) { err.hidden = false; err.textContent = `Add ${miss.join(", ")}.`; return; }
      if (files.length > 50) { err.hidden = false; err.textContent = "Choose at most 50 screenshots at a time."; return; }
      return screenshots(el, files);
    }
    if (files.length > 1) { err.hidden = false; err.textContent = "Choose one CSV or JSON file, or only pictures (screenshots of posts)."; return; }
    const miss = [!f && "a file", !$("#ion").value.trim() && "a name", !$("#ios").value.trim() && "where the data came from", !$("#ioa").value.trim() && "the basis for using it"].filter(Boolean);
    if (miss.length) { err.hidden = false; err.textContent = `Add ${miss.join(", ")}.`; return; }
    const fd = new FormData(); fd.append("file", f); fd.append("name", $("#ion").value.trim()); fd.append("source", $("#ios").value.trim()); fd.append("authorisation", $("#ioa").value.trim()); fd.append("description", $("#iod").value);
    for (const k of MAPK) { const v = $(`#m_${k}`).value.trim(); if (v) fd.append(`map_${k}`, v); }
    if ($("#iorq").value.trim()) fd.append("research_question", $("#iorq").value.trim());
    const b = $("#ioGo"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Working…';
    try {
      const r = await api.upload("/api/io/datasets", fd, p => ($("#ioprog").textContent = p < 1 ? `Uploading ${Math.round(p * 100)}%` : "Analysing…"));
      const sk = Object.values(r.skipped).reduce((a, x) => a + x, 0);
      toast(`${n(r.imported)} posts imported${sk ? `, ${n(sk)} skipped` : ""}.${watchNote(r)}`); App.go(`#/monitor/${r.id}`);
    } catch (e) { err.hidden = false; err.textContent = errMsg(e); }
    finally { b.disabled = false; b.textContent = "Import and analyse"; $("#ioprog").textContent = ""; }
  };
}

// ---------------------------------------------------------------- screenshots of posts -> checked rows -> dataset
async function sha12(file) { try { const b = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 16); } catch { return null; } }   // crypto.subtle needs https or localhost
async function screenshots(el, files, meta0 = null, addTo = null) {
  const langs = App.meta.ocr || [], lang = langs.length > 1 ? "eng+swa" : langs[0]?.code;
  if (!lang) return toast("Text reading (OCR) is not installed on this server.", "err");
  const meta = meta0 || { name: $("#ion").value.trim(), source: $("#ios").value.trim(), authorisation: $("#ioa").value.trim(), description: $("#iod").value.trim() };
  el.innerHTML = `<div class="pagehead"><div><h1>Reading ${files.length} screenshot${files.length > 1 ? "s" : ""}</h1><p>Text is read on this computer. Nothing is analysed until you have checked every row.</p></div></div><div class="card"><div class="bd"><div id="shotProg" class="small"></div></div></div>`;
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i], url = URL.createObjectURL(f);
    $("#shotProg").innerHTML = `<span class="spin"></span> Reading screenshot ${i + 1} of ${files.length}: ${esc(f.name)}`;
    let ocr = { text: "", confidence: 0 }; try { ocr = await recognise(f, lang, p => ($("#shotProg").innerHTML = `<span class="spin"></span> Reading screenshot ${i + 1} of ${files.length}: ${Math.round(p * 100)}%`)); } catch (e) { ocr.error = errMsg(e); }
    const p = parsePostScreenshot(ocr.text, { fileTime: f.lastModified });
    rows.push({ file: f, url, sha: await sha12(f), ocr, account: p.account, account_basis: p.account_basis, posted_at: p.posted_at, time_basis: p.time_basis, time_exact: p.time_exact, text: p.text, platform: p.platform || "" });
  }
  reviewRows(el, rows, meta, addTo);
}
function reviewRows(el, rows, meta, addTo = null) {
  const save = () => rows.forEach((r, i) => { const g = k => $(`[data-r="${i}"][data-k="${k}"]`); if (!g("text")) return; r.account = g("account").value.trim().replace(/^@/, ""); r.text = g("text").value.trim(); r.platform = g("platform").value.trim(); if (g("at").value !== toLocalInput(r.posted_at)) { r.posted_at = fromLocalInput(g("at").value); r.time_exact = !!r.posted_at; r.time_basis = r.posted_at ? "entered by the analyst" : null; } });
  const draw = () => {
    el.innerHTML = `<div class="pagehead"><div><h1>Check what AIVS read</h1><p>${rows.length} post${rows.length > 1 ? "s" : ""} from screenshots. Compare each row with its picture and correct anything wrong. Text reading makes mistakes, especially with names, numbers and small print.</p></div></div>
      <div class="callout warn" style="margin-bottom:12px"><div><b>Times matter.</b> Synchronised-posting signals are only as good as these times. Times marked <i>approximate</i> were worked out from words like “2h” and the screenshot's file time. If you know the real time, enter it.</div></div>
      ${rows.map((r, i) => `<div class="card" style="margin-bottom:10px"><div class="bd" style="display:grid;grid-template-columns:minmax(120px,200px) minmax(0,1fr);gap:14px">
        <div><img src="${r.url}" alt="Screenshot ${i + 1}" style="width:100%;border:1px solid var(--line);border-radius:6px;cursor:zoom-in" data-view="${i}"><div class="tiny sub" style="margin-top:4px;overflow-wrap:anywhere">${esc(r.file.name)}${r.ocr.error ? `<br><span style="color:var(--con)">${esc(r.ocr.error)}</span>` : ""}</div></div>
        <div><div class="grid g3"><div><label class="f" for="a${i}" style="margin-top:0">Account <span class="req">*</span></label><input type="text" id="a${i}" data-r="${i}" data-k="account" value="${esc(r.account)}" placeholder="name or @handle">${r.account_basis ? `<div class="tiny sub">${esc(r.account_basis)}</div>` : `<div class="tiny" style="color:var(--con)">Not found; type it from the picture.</div>`}</div>
          <div><label class="f" for="t${i}" style="margin-top:0">Posted at <span class="req">*</span></label><input type="datetime-local" id="t${i}" data-r="${i}" data-k="at" value="${toLocalInput(r.posted_at)}">${r.time_basis ? `<div class="tiny ${r.time_exact ? "sub" : ""}" ${r.time_exact ? "" : 'style="color:var(--warn)"'}>${r.time_exact ? "" : "<b>approximate</b>: "}${esc(r.time_basis)}</div>` : `<div class="tiny" style="color:var(--con)">No time found. Enter it, or <a href="#" data-ft="${i}">use the screenshot's file time</a>.</div>`}</div>
          <div><label class="f" for="p${i}" style="margin-top:0">Platform</label><input type="text" id="p${i}" data-r="${i}" data-k="platform" value="${esc(r.platform)}" placeholder="e.g. Facebook"></div></div>
          <label class="f" for="x${i}">Post text <span class="req">*</span></label><textarea id="x${i}" rows="3" data-r="${i}" data-k="text">${esc(r.text)}</textarea>
          <details style="margin-top:4px"><summary class="tiny sub">Everything AIVS read from this picture${r.ocr.confidence ? ` (confidence ${Math.round(r.ocr.confidence)}%)` : ""}</summary><pre class="box">${esc(r.ocr.text || "(no text found)")}</pre></details>
          <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-dup="${i}">Another post in this picture</button><button class="btn sm ghost" data-rm="${i}">Remove</button></div></div></div></div>`).join("")}
      <div id="shotErr" class="callout bad" hidden></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="shotGo">${addTo ? "Add" : "Import"} ${rows.length} post${rows.length > 1 ? "s" : ""} and analyse</button><a class="btn ghost" href="#/monitor${addTo ? `/${addTo}` : ""}">Cancel</a></div>
      <div class="hint">Each post keeps a reference to its screenshot (name and fingerprint). The pictures themselves are not stored by the monitor; keep the originals.</div>`;
    $$("[data-view]").forEach(im => im.onclick = () => viewer(rows[+im.dataset.view].url, rows[+im.dataset.view].file.name));
    $$("[data-ft]").forEach(a => a.onclick = e => { e.preventDefault(); save(); const r = rows[+a.dataset.ft]; r.posted_at = new Date(r.file.lastModified).toISOString(); r.time_exact = false; r.time_basis = "the screenshot's file time: when the picture was taken or saved, not necessarily when the post was made"; draw(); });
    $$("[data-dup]").forEach(b => b.onclick = () => { save(); const r = rows[+b.dataset.dup]; rows.splice(+b.dataset.dup + 1, 0, { ...r, account: "", account_basis: null, text: "", posted_at: null, time_basis: null }); draw(); });
    $$("[data-rm]").forEach(b => b.onclick = () => { save(); rows.splice(+b.dataset.rm, 1); if (!rows.length) return App.go("#/monitor"); draw(); });
    $("#shotGo").onclick = async () => {
      save();
      const bad = rows.map((r, i) => [i + 1, [!r.account && "account", !r.posted_at && "time", !r.text && "text"].filter(Boolean)]).filter(([, m]) => m.length);
      if (bad.length) { $("#shotErr").hidden = false; $("#shotErr").textContent = `Fill in: ${bad.map(([i, m]) => `post ${i} (${m.join(", ")})`).join("; ")}.`; return; }
      const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = ["account,posted_at,text,platform,post_id", ...rows.map(r => [r.account, r.posted_at, r.text, r.platform, `screenshot:${r.sha || ""}:${r.file.name}`].map(q).join(","))].join("\n");
      const approx = rows.filter(r => !r.time_exact && r.time_basis !== "entered by the analyst").length;
      const fd = new FormData(); fd.append("file", new Blob([csv], { type: "text/csv" }), "screenshots.csv");
      const how = `Transcribed from ${rows.length} screenshot(s) by text recognition on the analyst's computer, then checked and corrected by the analyst.${approx ? ` ${approx} post time(s) are approximate.` : ""}`;
      if (addTo) fd.append("note", `${meta.note ? meta.note + ". " : ""}${how}`);
      else { fd.append("name", meta.name); fd.append("source", meta.source); fd.append("authorisation", meta.authorisation); fd.append("description", `${meta.description ? meta.description + "\n" : ""}${how}`); }
      const b = $("#shotGo"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Importing…';
      try { const r = await api.upload(addTo ? `/api/io/datasets/${addTo}/add` : "/api/io/datasets", fd); rows.forEach(x => URL.revokeObjectURL(x.url)); toast(`${r.imported} post${r.imported === 1 ? "" : "s"} ${addTo ? "added" : "imported"} from screenshots${r.duplicates ? `; ${r.duplicates} already in the dataset` : ""}.`); App.go(`#/monitor/${r.id}`); }
      catch (e) { $("#shotErr").hidden = false; $("#shotErr").textContent = errMsg(e); b.disabled = false; b.textContent = `Import ${rows.length} posts and analyse`; }
    };
  };
  draw();
}

// ---------------------------------------------------------------- one dataset
async function datasetPage(el, id, tab) {
  let D, R, M; const f = SM.readFilters();
  try { [D, R, M] = await Promise.all([api.get(`/api/io/datasets/${encodeURIComponent(id)}`), api.get(`/api/io/datasets/${encodeURIComponent(id)}/insights?${SM.filterQuery(f)}`), SM.meta()]); }
  catch (e) { el.innerHTML = `<div class="callout bad"><div>${esc(e.message)}</div></div>`; return; }
  const I = R.insights, d = { ...D.dataset, content: R.dataset.content }, A = D.analysis;
  crumbs(`<a href="#/monitor">Social media analysis</a> / <b>${esc(d.name)}</b>`);
  if (!A && !FILTERED.has(tab)) { el.innerHTML = `<div class="callout info"><div>Coordination indicators have not been computed for this dataset yet. ${App.can("io.import") ? `<button class="btn sm primary" id="runA">Compute now</button>` : ""}</div></div>`; if ($("#runA")) $("#runA").onclick = () => rerun(el, id, {}); return; }
  const S = A?.summary || { platforms: [], synchronised_clusters: 0 }, q = SM.filterQuery(f);
  el.innerHTML = `<div class="casehead">${d.is_sample ? `<div class="callout train" style="margin-bottom:10px"><div><b>Synthetic dataset.</b> Invented accounts and posts for practice. Nothing here is real.</div></div>` : ""}
      <div class="top"><div style="min-width:0"><div class="id">Dataset ${esc(d.id)} · imported ${dt(d.imported_at)} · ${esc(d.collection_method || "file")} · SHA-256 ${esc((d.file_sha256 || "").slice(0, 12))}…</div><h1 style="margin-top:2px">${esc(d.name)}</h1></div>
        <div class="acts">${App.can("io.import") && !d.is_sample ? `<button class="btn primary" id="addPosts">Add posts</button>` : ""}<a class="btn" href="#/monitor/${esc(d.id)}/report${q ? `?${q}` : ""}">Report</a><a class="btn" href="#/watch/lists" title="Watchlists check imported datasets for keyword activity, spikes, narratives and coordination indicators">AI Watchlist</a><a class="btn ghost" href="/api/io/datasets/${esc(d.id)}/signals.csv">Export signals (CSV)</a><a class="btn ghost" href="/api/io/datasets/${esc(d.id)}/signals.json">JSON</a>${App.can("settings.manage") ? `<button class="btn ghost" id="delDs">Delete</button>` : ""}</div></div>
      <div class="facts"><span>Source: <b>${esc(d.source)}</b></span><span>Basis for use: <b>${esc(d.authorisation)}</b></span><span>Period: <b>${dt(d.first_at)}</b> to <b>${dt(d.last_at)}</b></span>${I.platformsAll?.length ? `<span>Platforms: <b>${esc(I.platformsAll.join(", "))}</b></span>` : ""}</div></div>
    <nav class="tabs" aria-label="Analysis views">${TABS.map(([k, l]) => `<a href="#/monitor/${esc(d.id)}/${k}${FILTERED.has(k) && q ? `?${q}` : ""}" class="${k === tab ? "on" : ""}">${l}${k === "messages" && S.synchronised_clusters ? `<span class="count">${S.synchronised_clusters}</span>` : ""}${k === "claims" && I.claimCounts?.needs_review ? `<span class="count">${I.claimCounts.needs_review}</span>` : ""}</a>`).join("")}</nav>
    ${FILTERED.has(tab) && tab !== "claims" ? SM.filterBar(d, I, tab, M) : !FILTERED.has(tab) ? `<div class="callout warn" style="margin:0 0 12px"><div><b>Signals to investigate, not findings.</b> ${esc(A.caveats[1])} ${esc(A.caveats[2])} These views cover the whole dataset; the filters do not apply.</div></div>` : ""}
    <div id="tabBody" style="margin-top:4px">${FILTERED.has(tab) && !Object.keys(f).length && ((I.dataset_posts || 0) < 10 || (I.accounts || 0) < 3) ? `<div class="callout info" style="margin-bottom:12px"><div><b>Too few posts to find patterns yet: ${n(I.dataset_posts)} post${I.dataset_posts === 1 ? "" : "s"} from ${n(I.accounts)} account${I.accounts === 1 ? "" : "s"}.</b> Trends, topics and coordination need many posts from several accounts. Treat any pattern here as a reason to collect more.</div></div>` : ""}<div id="tabInner"></div></div>`;
  if ($("#delDs")) $("#delDs").onclick = async () => { if (await confirmBox("Delete this dataset?", `All ${n(d.posts)} imported posts, their analysis, topics and claims are removed permanently. The deletion is recorded in the audit log. Cases and reports opened from it are kept.`, "Delete", "danger")) { try { await api.del(`/api/io/datasets/${d.id}`); toast("Dataset deleted."); App.go("#/monitor"); } catch (e) { fail(e); } } };
  if ($("#addPosts")) $("#addPosts").onclick = () => addPosts(el, d);
  SM.wireFilters(d, tab);
  el.addEventListener("reload", () => render(el, [String(d.id), tab]), { once: true });
  const body = FILTERED.has(tab) ? $("#tabInner") : $("#tabBody");
  const V = { overview: SM.overview, sentiment: SM.sentimentTab, topics: SM.topicsTab, engagement: SM.engagementTab, claims: SM.claimsTab, geography: SM.geographyTab, report: SM.reportTab };
  if (V[tab]) return V[tab](body, d, I, A, M, el);
  if (tab === "posts") return posts(body, d);
  ({ summary, messages, hashtags, network, links, accounts })[tab](body, d, A, el);
}
async function addPosts(el, d) {
  const r = await modal("Add posts to this dataset", `<p class="small muted" style="margin-top:0">Choose more screenshots of posts (up to 50), or a CSV/JSON file. Posts already in the dataset are skipped. The analysis is re-run.</p>
    <input type="file" id="apf" multiple accept=".csv,.json,.jsonl,.txt,text/csv,application/json,image/*"><label class="f" for="apn">Note (optional)</label><input type="text" id="apn" maxlength="300" placeholder="e.g. screenshots collected 23 Oct from the county page">`,
    [{ label: "Cancel", value: null }, { label: "Continue", kind: "primary", validate: m => (!$("#apf", m).files.length ? "Choose at least one file." : null), value: m => ({ files: [...$("#apf", m).files], note: $("#apn", m).value.trim() }) }]);
  if (!r.value) return;
  const { files, note } = r.value;
  if (files.every(f => f.type.startsWith("image/"))) { if (files.length > 50) return toast("Choose at most 50 screenshots at a time.", "err"); return screenshots(el, files, { note }, d.id); }
  if (files.length > 1) return toast("Choose one CSV or JSON file, or only pictures.", "err");
  const fd = new FormData(); fd.append("file", files[0]); if (note) fd.append("note", note);
  try { const x = await api.upload(`/api/io/datasets/${d.id}/add`, fd); toast(`${x.imported} post${x.imported === 1 ? "" : "s"} added${x.duplicates ? `; ${x.duplicates} were already in the dataset` : ""}.${watchNote(x)}`); App.go(`#/monitor/${d.id}`); } catch (e) { fail(e); }
}
async function rerun(el, id, params) { try { await api.post(`/api/io/datasets/${id}/analyse`, params); toast("Analysis updated."); render(el, [id, "summary"]); } catch (e) { fail(e); } }

function bars(series, { height = 120, color = "var(--teal, #0f766e)", hi = [] } = {}) {
  const max = Math.max(1, ...series), w = Math.max(2, Math.min(14, Math.floor(860 / Math.max(1, series.length)))), W = series.length * w;
  return `<svg viewBox="0 0 ${W} ${height + 16}" preserveAspectRatio="none" style="width:100%;height:${height + 16}px;display:block" role="img" aria-label="Posts over time">
    ${series.map((v, i) => `<rect x="${i * w + 0.5}" y="${height - (v / max) * height}" width="${Math.max(1, w - 1)}" height="${(v / max) * height}" fill="${hi.includes(i) ? "var(--con, #b42318)" : color}"><title>${v}</title></rect>`).join("")}
    <line x1="0" y1="${height}" x2="${W}" y2="${height}" stroke="currentColor" stroke-opacity=".25"/></svg>`;
}
const spark = s => { const max = Math.max(1, ...s), w = 120 / Math.max(1, s.length - 1); return `<svg viewBox="0 0 120 24" style="width:120px;height:24px"><polyline fill="none" stroke="var(--teal, #0f766e)" stroke-width="1.5" points="${s.map((v, i) => `${(i * w).toFixed(1)},${(22 - (v / max) * 20).toFixed(1)}`).join(" ")}"/></svg>`; };

function summary(body, d, A, el) {
  const S = A.summary, burstIdx = A.hashtags.flatMap(h => h.bursts.map(b => b.bucket));
  const kpi = (l, v, sub, href) => `<a class="kpi" ${href ? `href="${href}"` : ""}><div class="l">${l}</div><div class="v">${v}</div><div class="tiny sub">${sub}</div></a>`;
  const small = S.posts < 10 || S.accounts < 3;
  body.innerHTML = `${small ? `<div class="callout info" style="margin-bottom:12px"><div><b>Too few posts to find patterns yet: ${n(S.posts)} post${S.posts === 1 ? "" : "s"} from ${n(S.accounts)} account${S.accounts === 1 ? "" : "s"}.</b> The monitor compares many posts from several accounts, ideally dozens or more around the same topic. ${S.synchronised_clusters || S.hashtag_bursts ? "With so few posts, a signal can appear by chance: treat it as a reason to collect more posts, not as a pattern." : "No signals here only means there is too little to compare, not that the activity is genuine."} ${App.can("io.import") && !d.is_sample ? `Use <b>Add posts</b> to add more screenshots or files.` : ""} To check what a single post says, use <a href="#/verify">Verify information</a>.</div></div>` : ""}<div class="kpis">${kpi("Posts", n(S.posts), `${n(S.reposts)} reposts`)}${kpi("Accounts", n(S.accounts), "distinct accounts")}${kpi("Synchronised messages", n(S.synchronised_clusters), `of ${n(S.clusters)} repeated messages`, `#/monitor/${d.id}/messages`)}${kpi("Hashtag bursts", n(S.hashtag_bursts), "unusually high activity", `#/monitor/${d.id}/hashtags`)}${kpi("Co-activity groups", n(S.network_groups), `${n(A.network.nodes.length)} accounts linked`, `#/monitor/${d.id}/network`)}</div>
    <div class="card" style="margin-top:14px"><div class="hd"><h3>Posts per ${A.bucket}</h3><span class="small sub right">From ${dt(A.bucket_start)}. Red bars contain a hashtag burst.</span></div><div class="bd">${A.timeline.length > 1 ? bars(A.timeline, { hi: burstIdx }) : `<p class="small muted" style="margin:0">All posts fall within one ${A.bucket}, so there is no timeline to draw yet.</p>`}</div></div>
    <div class="split" style="margin-top:14px"><div class="card"><div class="hd"><h3>What to look at first</h3></div><div class="bd small"><ol style="margin:0 0 0 18px;line-height:1.7">
      ${A.clusters.filter(c => c.synchronised).slice(0, 3).map(c => `<li><a href="#/monitor/${d.id}/messages">Repeated message ${c.id}</a>: ${n(c.posts)} posts by ${n(c.accounts)} accounts; ${c.sync.accounts} accounts within ${A.params.window_min} minutes. “${esc(c.text.slice(0, 120))}”</li>`).join("")}
      ${A.hashtags.filter(h => h.bursts.length).slice(0, 3).map(h => `<li><a href="#/monitor/${d.id}/hashtags">${esc(h.tag)}</a>: ${h.bursts.length} burst${h.bursts.length > 1 ? "s" : ""}, peak ${Math.max(...h.bursts.map(b => b.count))} posts in one ${A.bucket}.</li>`).join("")}
      ${A.links.filter(l => l.max_accounts_in_window >= 3).slice(0, 2).map(l => `<li><a href="#/monitor/${d.id}/links">${esc(l.host)}</a>: shared by ${n(l.accounts)} accounts, up to ${l.max_accounts_in_window} within ${A.params.window_min} minutes.</li>`).join("")}
      ${!S.synchronised_clusters && !S.hashtag_bursts ? "<li>No strong signals at these settings. That does not show activity is organic; the dataset may be incomplete, or coordination may be slower or more varied.</li>" : ""}</ol></div></div>
    <div class="card"><div class="hd"><h3>Analysis settings</h3></div><div class="bd small">
      <div class="grid g2"><div><label class="f" for="pw">Time window (minutes)</label><input type="number" id="pw" min="1" max="1440" value="${A.params.window_min}"></div><div><label class="f" for="ps">Similarity (0.3–0.95)</label><input type="number" id="ps" min="0.3" max="0.95" step="0.05" value="${A.params.min_similarity}"></div>
        <div><label class="f" for="pp">Minimum posts per message</label><input type="number" id="pp" min="2" value="${A.params.min_cluster_posts}"></div><div><label class="f" for="pa">Minimum accounts per message</label><input type="number" id="pa" min="2" value="${A.params.min_cluster_accounts}"></div></div>
      ${App.can("io.import") ? `<button class="btn sm" id="reA" style="margin-top:10px">Re-run analysis</button>` : ""}
      <div class="hint">Analysed ${dt(A.generated_at)} in ${n(A.duration_ms)} ms. Near-identical means word-pair overlap (Jaccard) at or above the similarity setting. “Synchronised” means more accounts posted the message inside one window than its own posting rate would explain (Poisson test, p &lt; 0.01 after correction), or at least half its accounts did.</div></div></div></div>`;
  if ($("#reA")) $("#reA").onclick = () => rerun(el, d.id, { window_min: $("#pw").value, min_similarity: $("#ps").value, min_cluster_posts: $("#pp").value, min_cluster_accounts: $("#pa").value });
}

function messages(body, d, A) {
  const C = A.clusters;
  body.innerHTML = C.length ? `<p class="small muted" style="margin-top:0">Messages posted in the same or nearly the same words by several accounts (reposts excluded; see Links & reposts). Synchronised ones are listed first.</p>
    ${C.map(c => `<div class="card" style="margin-bottom:12px"><div class="hd"><h3>Repeated message ${c.id}</h3>${c.synchronised ? `<span class="chip con">synchronised</span>` : `<span class="chip grey">spread out</span>`}${c.cross_platform ? `<span class="chip info">${esc(c.platforms.join(" + "))}</span>` : ""}<span class="small sub right">${n(c.posts)} posts · ${n(c.accounts)} accounts · ${c.variants} wording variant${c.variants > 1 ? "s" : ""}</span></div><div class="bd">
      <div class="quote">${esc(c.text)}</div>
      <div class="small" style="margin-top:8px">First ${dt(c.first_at)}, last ${dt(c.last_at)} (${c.span_min < 120 ? `${c.span_min} min` : `${Math.round(c.span_min / 60)} h`}). Busiest window: <b>${c.sync.accounts} accounts</b> within ${A.params.window_min} min${c.sync.from ? ` (${dt(c.sync.from)})` : ""}; at this message's own rate about ${c.sync.expected} would be expected.</div>
      <details style="margin-top:6px"><summary class="small sub">Accounts (${n(c.accounts)})</summary><div class="small" style="margin-top:4px;line-height:1.8">${c.account_list.map(a => `<a href="#/monitor/${d.id}/posts?account=${encodeURIComponent(a)}" class="chip grey">${esc(a)}</a>`).join(" ")}</div></details>
      <div class="row" style="margin-top:10px"><a class="btn sm" href="#/monitor/${d.id}/posts?cluster=${c.id}">See the posts</a>${App.can("case.create") ? `<button class="btn sm" data-case="${c.id}">Verify this message in a case</button>` : ""}</div></div></div>`).join("")}`
    : `<div class="card"><div class="bd">${empty("No repeated messages", "No message was posted in near-identical words by enough accounts at the current settings.")}</div></div>`;
  $$("[data-case]").forEach(b => b.onclick = async () => { if (!(await confirmBox("Open a verification case?", "A new case is created with this message as the content to verify. The dataset and message number are recorded in the audit log.", "Open case"))) return; try { const r = await api.post(`/api/io/datasets/${d.id}/clusters/${b.dataset.case}/case`); refreshNavCounts(); toast(`Case ${r.id} opened.`); App.go(`#/case/${r.id}`); } catch (e) { fail(e); } });
}

function hashtags(body, d, A) {
  const H = A.hashtags;
  body.innerHTML = `<div class="card"><div class="hd"><h3>Top hashtags</h3><span class="small sub right">Activity per ${A.bucket}. A burst is a ${A.bucket} far above the hashtag's usual level.</span></div>${H.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Hashtag</th><th class="n">Posts</th><th class="n">Accounts</th><th>Activity</th><th>Bursts</th></tr></thead><tbody>
    ${H.map(h => `<tr><td><a href="#/monitor/${d.id}/posts?q=${encodeURIComponent(h.tag)}">${esc(h.tag)}</a></td><td class="n">${n(h.total)}</td><td class="n">${n(h.accounts)}</td><td>${spark(h.series)}</td><td class="small">${h.bursts.length ? h.bursts.map(b => `<span class="chip con" title="usual level about ${b.baseline} per ${A.bucket}">${b.count} at ${dt(b.at)}</span>`).join(" ") : `<span class="sub">none</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="bd">${empty("No hashtags", "The posts contain no hashtags.")}</div>`}</div>`;
}

function links(body, d, A) {
  body.innerHTML = `<div class="split"><div class="card"><div class="hd"><h3>Links shared by several accounts</h3></div>${A.links.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Link</th><th class="n">Posts</th><th class="n">Accounts</th><th class="n">Most in ${A.params.window_min} min</th></tr></thead><tbody>${A.links.map(l => `<tr><td style="overflow-wrap:anywhere"><b>${esc(l.host)}</b><div class="tiny sub">${esc(l.url)}</div></td><td class="n">${n(l.posts)}</td><td class="n">${n(l.accounts)}</td><td class="n">${l.max_accounts_in_window >= 3 ? `<b style="color:var(--con)">${l.max_accounts_in_window}</b>` : l.max_accounts_in_window}</td></tr>`).join("")}</tbody></table></div><div class="bd hint" style="padding-top:0">Links are listed as text and are not opened by AIVS. Check them with care.</div>` : `<div class="bd">${empty("No shared links", "No link was posted by two or more accounts.")}</div>`}</div>
    <div class="card"><div class="hd"><h3>Most reposted</h3></div>${A.amplification.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Original</th><th class="n">Reposts</th><th class="n">Accounts</th><th>Period</th></tr></thead><tbody>${A.amplification.map(a => `<tr><td>${esc(a.of)}</td><td class="n">${n(a.reposts)}</td><td class="n">${n(a.accounts)}</td><td class="small">${dt(a.first_at)} – ${dt(a.last_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="bd">${empty("No reposts", "The file has no repost column, or no reposts.")}</div>`}</div></div>`;
}

function accounts(body, d, A) {
  body.innerHTML = `<div class="card"><div class="hd"><h3>Accounts that appear in the most signals</h3><span class="small sub right">Factual counts. Appearing here is not a finding about the account or the person behind it.</span></div><div class="tablewrap"><table class="t"><thead><tr><th>Account</th><th class="n">Posts</th><th class="n">Per day</th><th class="n">Reposts</th><th class="n">In synchronised messages</th><th class="n">Network links</th><th>Account age</th></tr></thead><tbody>
    ${A.accounts.map(a => `<tr class="click" data-acc="${esc(a.account)}"><td><b>${esc(a.account)}</b></td><td class="n">${n(a.posts)}</td><td class="n">${a.posts_per_day}</td><td class="n">${n(a.reposts)}</td><td class="n">${a.synchronised_messages || ""}</td><td class="n">${a.network_links || ""}</td><td class="small">${a.account_created_at ? `${a.new_account ? `<span class="chip warn">created within 30 days of the data</span>` : ""} ${dt(a.account_created_at)}` : `<span class="sub">not in file</span>`}</td></tr>`).join("")}</tbody></table></div></div>`;
  $$("[data-acc]").forEach(r => r.onclick = () => App.go(`#/monitor/${d.id}/posts?account=${encodeURIComponent(r.dataset.acc)}`));
}

async function posts(body, d) {
  const qp = new URLSearchParams(location.hash.split("?")[1] || ""), account = qp.get("account") || "", cluster = qp.get("cluster") || "", ids = qp.get("ids") || "", offset = +qp.get("offset") || 0, limit = 100;
  const r = await api.get(`/api/io/datasets/${d.id}/posts?${new URLSearchParams({ ...SM.readFilters(), account, cluster, ids, offset, limit })}`);
  const go = o => App.go(`#/monitor/${d.id}/posts?${new URLSearchParams({ ...Object.fromEntries(qp), ...o })}`);
  const eng = p => ["likes", "comments", "shares", "views"].filter(k => p[k] != null).map(k => `${n(p[k])} ${k}`).join(" · ");
  const TH = (await SM.meta()).themes;
  body.innerHTML = `<div class="card"><div class="hd"><h3>Posts</h3><span class="small sub right">${n(r.total)} matching${r.total > r.posts.length ? `, ${n(offset + 1)}–${n(offset + r.posts.length)} shown` : ""}</span></div><div class="bd">
    ${account || cluster || ids ? `<div class="row"><a class="btn sm ghost" href="#/monitor/${d.id}/posts?${SM.filterQuery(SM.readFilters())}">Clear selection (${esc(account ? `account ${account}` : cluster ? `message ${cluster}` : `${ids.split(",").length} selected posts`)})</a></div>` : ""}
    <div class="tablewrap" style="margin-top:6px"><table class="t"><thead><tr><th style="width:150px">Time</th><th style="width:150px">Account</th><th>Text</th><th style="width:170px">Analysis</th></tr></thead><tbody>${r.posts.map(p => `<tr>
      <td class="small">${dt(p.posted_at)}${p.platform ? `<div class="tiny sub">${esc(p.platform)}</div>` : ""}</td>
      <td class="small"><a href="#/monitor/${d.id}/posts?account=${encodeURIComponent(p.account)}">${esc(p.account)}</a>${p.loc_basis ? `<div class="tiny sub" title="${p.loc_basis === "post" ? "location field in the data" : "self-reported profile location"}">${esc([p.loc_name, p.loc_region, p.loc_country].filter(Boolean).join(", "))} (${p.loc_basis === "post" ? "data" : "self-reported"})</div>` : ""}</td>
      <td class="small">${p.repost_of ? `<span class="chip grey">repost of ${esc(p.repost_of)}</span> ` : ""}${esc(p.text)}${p.url ? ` <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer nofollow">open</a>` : ""}${eng(p) ? `<div class="tiny sub">${eng(p)}</div>` : ""}<details><summary class="tiny sub">Provenance</summary><div class="tiny sub">${esc(p.collected_via || "not recorded")}${p.collected_at ? `, ${dt(p.collected_at)}` : ""}${p.post_id ? ` · platform ID ${esc(p.post_id)}` : ""}</div></details></td>
      <td class="small">${p.sentiment ? `<span class="chip" style="background:var(--surface-2);border-left:4px solid ${SM.SENT[p.sentiment][1]}" title="${p.sentiment_method === "lexicon-1" ? "word list" : esc(p.sentiment_method)} · confidence ${p.sentiment_confidence ?? "—"}">${SM.SENT[p.sentiment][0]}</span>` : ""}
        ${p.themes.map(t => `<span class="chip grey">${esc(TH[t] || t)}</span>`).join(" ")}${p.topic_no ? ` <a class="chip info" href="#/monitor/${d.id}/topics?topic=${p.topic_no}">topic ${p.topic_no}</a>` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No posts match.</td></tr>`}</tbody></table></div>
    ${r.total > limit ? `<div class="row" style="margin-top:8px"><button class="btn sm" id="pPrev" ${offset ? "" : "disabled"}>Previous</button><button class="btn sm" id="pNext" ${offset + limit < r.total ? "" : "disabled"}>Next</button></div>` : ""}</div></div>`;
  if ($("#pPrev")) { $("#pPrev").onclick = () => go({ offset: Math.max(0, offset - limit) }); $("#pNext").onclick = () => go({ offset: offset + limit }); }
}

// force-directed layout computed in the browser (no library); deterministic start positions
function network(body, d, A) {
  const N = A.network.nodes, E = A.network.edges;
  if (!N.length) { body.innerHTML = `<div class="card"><div class="bd">${empty("No co-activity links", "No two accounts posted the same message or link within the time window.")}</div></div>`; return; }
  const W = 900, H = 560, idx = new Map(N.map((x, i) => [x.id, i])), P = N.map((x, i) => ({ x: W / 2 + Math.cos(i * 2.4) * (40 + i * 2), y: H / 2 + Math.sin(i * 2.4) * (40 + i * 2), vx: 0, vy: 0 }));
  const L = E.map(e => [idx.get(e.a), idx.get(e.b), e.weight]).filter(([a, b]) => a != null && b != null), k = Math.sqrt((W * H) / N.length) * 0.6;
  for (let it = 0; it < 300; it++) {
    const t = 1 - it / 300;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) { const dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = Math.max(1, dx * dx + dy * dy), f = (k * k) / d2; P[i].vx += dx * f / 10; P[i].vy += dy * f / 10; P[j].vx -= dx * f / 10; P[j].vy -= dy * f / 10; }
    for (const [a, b, w] of L) { const dx = P[a].x - P[b].x, dy = P[a].y - P[b].y, dist = Math.max(1, Math.hypot(dx, dy)), f = (dist * dist / k) * Math.min(3, 0.5 + w / 4) / dist / 20; P[a].vx -= dx * f; P[a].vy -= dy * f; P[b].vx += dx * f; P[b].vy += dy * f; }
    for (const p of P) { p.vx += (W / 2 - p.x) * 0.002; p.vy += (H / 2 - p.y) * 0.002; const v = Math.hypot(p.vx, p.vy), m = Math.min(v, 12 * t + 0.5); p.x += v ? p.vx / v * m : 0; p.y += v ? p.vy / v * m : 0; p.vx *= 0.5; p.vy *= 0.5; p.x = Math.min(W - 20, Math.max(20, p.x)); p.y = Math.min(H - 20, Math.max(20, p.y)); }
  }
  // spread the finished layout over the drawing area (dense groups otherwise collapse into a knot)
  { const xs = P.map(p => p.x), ys = P.map(p => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), m = 70;
    for (const p of P) { p.x = N.length === 1 ? W / 2 : m + (p.x - x0) / Math.max(1, x1 - x0) * (W - 2 * m); p.y = N.length === 1 ? H / 2 : m / 2 + (p.y - y0) / Math.max(1, y1 - y0) * (H - m); } }
  const COL = ["#0f766e", "#b42318", "#1d4ed8", "#a16207", "#7c3aed", "#be185d", "#15803d", "#475569"], maxW = Math.max(1, ...N.map(x => x.weight)), labels = new Set([...N].sort((a, b) => b.weight - a.weight).slice(0, 15).map(x => x.id));
  body.innerHTML = `<div class="card"><div class="hd"><h3>Co-activity network</h3><span class="small sub right">${n(N.length)} accounts · ${n(L.length)} links · ${A.summary.network_groups} group${A.summary.network_groups > 1 ? "s" : ""}</span></div><div class="bd">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:620px;background:var(--surface-2, #f6f8fa);border-radius:8px" role="img" aria-label="Network of accounts that posted the same message or link within ${A.params.window_min} minutes">
      ${L.map(([a, b, w]) => `<line x1="${P[a].x.toFixed(1)}" y1="${P[a].y.toFixed(1)}" x2="${P[b].x.toFixed(1)}" y2="${P[b].y.toFixed(1)}" stroke="#64748b" stroke-opacity="${Math.min(0.7, 0.15 + w / 10)}" stroke-width="${Math.min(4, 0.6 + w / 3)}"/>`).join("")}
      ${N.map((x, i) => `<g class="nd" data-acc="${esc(x.id)}" style="cursor:pointer"><circle cx="${P[i].x.toFixed(1)}" cy="${P[i].y.toFixed(1)}" r="${(4 + 10 * Math.sqrt(x.weight / maxW)).toFixed(1)}" fill="${COL[(x.group - 1) % COL.length]}" fill-opacity=".85" stroke="#fff" stroke-width="1"><title>${esc(x.id)}: ${x.posts} posts, ${x.synchronised_messages} synchronised message(s), link weight ${x.weight}</title></circle>${labels.has(x.id) ? `<text x="${(P[i].x + 9).toFixed(1)}" y="${(P[i].y + 4).toFixed(1)}" font-size="11" fill="currentColor">${esc(x.id)}</text>` : ""}</g>`).join("")}
    </svg>
    <div class="hint">Two accounts are linked when they posted the same message, or the same link, within ${A.params.window_min} minutes of each other; thicker lines mean more such moments. Colours mark connected groups. Click an account to see its posts. A link shows timing, not a relationship between the people behind the accounts.</div></div></div>`;
  $$(".nd").forEach(g => g.onclick = () => App.go(`#/monitor/${d.id}/posts?account=${encodeURIComponent(g.dataset.acc)}`));
}

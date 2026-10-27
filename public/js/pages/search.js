// Search & check: search everything recorded, or check an image against all holdings without storing it.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, esc, status, errMsg } from "../ui.js";

let SQ = "";
export async function render(el, [qs]) {
  crumbs(`<b>Search & check</b>${App.training ? " · training records" : ""}`);
  if (qs !== undefined) SQ = new URLSearchParams(qs).get("q") || "";
  el.innerHTML = `<div class="pagehead"><div><h1>Search & check</h1><p>Find anything already recorded, or check whether an image has been seen before, without opening a case.</p></div></div>
  <div class="split"><div class="stack"><div class="card"><div class="hd"><h3>Search everything</h3></div><div class="bd">
    <input type="search" id="sq" placeholder="Words, case or evidence ID, place, date, or part of a SHA-256" value="${esc(SQ)}" aria-label="Search">
    <div class="hint">Searches case text, claims, evidence and references, text read from images, notes, file names and fingerprints, and the reference archive${App.training ? " (training records only)" : " (training records excluded)"}.</div><div id="sr" style="margin-top:12px"></div></div></div></div>
  <div class="stack"><div class="card"><div class="hd"><h3>Has this image been seen before?</h3></div><div class="bd">
    <div class="dropzone" id="cdz" tabindex="0" role="button" aria-label="Choose an image to check"><b>Drop an image here</b> or <button class="btn sm" id="cpick">choose a file</button><input type="file" id="cfi" accept="image/*" hidden>
      <div class="hint">Compared with every case and archive record on this server. The image is not stored; the check is recorded in the audit log by its fingerprint only.</div></div>
    <div id="cres" style="margin-top:12px"></div></div></div></div></div>`;
  const run = async () => {
    SQ = $("#sq").value.trim(); const box = $("#sr");
    if (!SQ) { box.innerHTML = `<p class="small muted">Type at least one word.</p>`; return; }
    box.innerHTML = `<div class="empty"><span class="spin"></span></div>`;
    try {
      const { results: r, total } = await api.get(`/api/search?${App.q(new URLSearchParams({ q: SQ }).toString())}`);
      box.innerHTML = r.length ? `<p class="small sub">${total} result${total > 1 ? "s" : ""}${total > r.length ? `, first ${r.length} shown` : ""}</p><ul class="results">${r.map(x => `<li><a href="${x.case_id ? `#/case/${esc(x.case_id)}/${x.tab}` : "#/archive"}"><b>${esc(x.case_id || x.archive_id)}</b> · ${esc(x.where)}</a><div class="small">${esc(x.title)}${x.status ? ` ${status(x.status)}` : ""}</div><div class="small muted">${esc(x.text)}</div></li>`).join("")}</ul>`
        : `<p class="small muted">Nothing matches “${esc(SQ)}”. Try fewer or different words.</p>`;
    } catch (e) { box.innerHTML = `<div class="callout bad"><div>${esc(errMsg(e))}</div></div>`; }
  };
  let t; $("#sq").oninput = () => { clearTimeout(t); t = setTimeout(run, 300); };
  if (SQ) run();
  const check = async f => {
    const box = $("#cres"); box.innerHTML = `<div class="empty"><span class="spin"></span> Comparing…</div>`;
    try {
      const fd = new FormData(); fd.append("file", f, f.name);
      const r = await api.upload(`/api/check-image?${App.q()}`, fd), u = URL.createObjectURL(f), meta = Object.entries(r.meta || {});
      box.innerHTML = `<div class="row" style="gap:12px;align-items:flex-start"><img src="${u}" alt="" style="width:120px;max-height:120px;object-fit:contain;border:1px solid var(--line);border-radius:6px"><div style="min-width:0"><b>${esc(f.name)}</b><div class="tiny sub mono" style="overflow-wrap:anywhere">SHA-256 ${esc(r.sha256)}</div>${meta.length ? `<div class="tiny sub">Metadata: ${esc(meta.slice(0, 4).map(([k, v]) => `${k} ${v}`).join(" · "))}</div>` : ""}</div></div>
        ${r.results.length ? `<ul class="results" style="margin-top:10px">${r.results.map(x => `<li><span class="chip ${x.level === "possible" ? "warn" : "con"}">${x.level === "identical" ? "Identical file" : x.level === "strong" ? "Strong similarity" : "Possible similarity"}</span>
          ${x.archive ? `<a href="#/archive">Archive ${esc(x.archive.id)}</a> “${esc(x.archive.title)}”, documented ${esc(x.archive.documented_date)}` : `<a href="#/case/${esc(x.case.id)}/media">${esc(x.case.id)} · ${esc(x.media_id)}</a> “${esc(x.case.title)}” ${status(x.case.status)}`}
          <div class="tiny sub">${x.kind === "exact" ? "Same SHA-256: the same file was received before. This says nothing about its true origin." : `dHash ${x.dd}/64 + pHash ${x.pd}/64 = ${x.score} bits differ (best on ${esc(x.window)}${x.mirrored ? ", mirrored" : ""}). Lower is more alike. Not a probability.`}</div></li>`).join("")}</ul>`
          : `<div class="callout info" style="margin-top:10px"><div>No earlier copy among the records held here. This does <b>not</b> show the image is new or authentic, only that it is not in these records.</div></div>`}
        ${App.can("case.create") ? `<p class="small" style="margin-top:10px">To verify it, <a href="#/new">start a case</a> and attach this image.</p>` : ""}`;
    } catch (e) { box.innerHTML = `<div class="callout bad"><div>${esc(errMsg(e))}</div></div>`; }
  };
  $("#cpick").onclick = e => { e.stopPropagation(); $("#cfi").click(); };
  $("#cdz").onclick = () => $("#cfi").click();
  $("#cdz").onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#cfi").click(); } };
  $("#cfi").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) check(f); };
  $("#cdz").ondragover = e => { e.preventDefault(); $("#cdz").classList.add("over"); };
  $("#cdz").ondragleave = () => $("#cdz").classList.remove("over");
  $("#cdz").ondrop = e => { e.preventDefault(); $("#cdz").classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) check(f); };
}

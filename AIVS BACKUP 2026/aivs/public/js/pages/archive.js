import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, toast, fail, modal, viewer, fmtD, fmtDT, empty, status, concl } from "../ui.js";

let Q = "", TY = "";
export async function render(el) {
  crumbs(`<b>Reference archive</b>`);
  const manage = App.can("archive.manage");
  el.innerHTML = `<div class="pagehead"><div><h1>Reference archive</h1><p>Images with documented origins. New submissions are compared with every active record. A match is an investigative lead: check the record's provenance before relying on it.</p></div>
    <div class="actions">${manage ? `<a class="btn" id="expA" href="/api/archive/export?${App.q()}" download>Export bundle</a><button class="btn" id="impA">Import bundle</button><input type="file" id="impF" accept=".json,application/json" hidden><button class="btn primary" id="addA">+ Add record</button>` : ""}</div></div>
    <div class="card"><div class="hd"><input type="search" id="aq" placeholder="Search title, description, source or ID" style="max-width:340px" value="${esc(Q)}" aria-label="Search the archive">
      <select id="at" style="max-width:240px" aria-label="Record type"><option value="">All record types</option><option value="original">Documented originals</option><option value="misleading">Previously assessed misleading</option></select></div>
      <div class="bd" id="ag"><div class="empty"><span class="spin"></span></div></div></div>`;
  $("#at").value = TY;
  let t; $("#aq").oninput = e => { clearTimeout(t); t = setTimeout(() => { Q = e.target.value.trim(); load(); }, 250); };
  $("#at").onchange = e => { TY = e.target.value; load(); };
  if (manage) {
    $("#addA").onclick = add;
    $("#impA").onclick = () => $("#impF").click();
    $("#impF").onchange = async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      const b = $("#impA"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Importing…';
      try {
        const fd = new FormData(); fd.append("bundle", f, f.name);
        const r = await api.upload(`/api/archive/import?${App.q()}`, fd);
        const li = (rows, fmt) => rows.length ? `<ul class="small">${rows.map(x => `<li>${fmt(x)}</li>`).join("")}</ul>` : `<p class="small sub">None.</p>`;
        await modal("Archive import finished", `<p>${r.imported.length} imported · ${r.skipped.length} skipped · ${r.failed.length} failed. Every image was checked against its SHA-256 before it was added.</p>
          <h4>Imported</h4>${li(r.imported, x => `${esc(x.from)} → <b class="mono">${esc(x.id)}</b>`)}<h4>Skipped</h4>${li(r.skipped, x => `${esc(x.from)}: ${esc(x.reason)}`)}<h4>Failed</h4>${li(r.failed, x => `${esc(x.from)}: ${esc(x.reason)}`)}`);
        load();
      } catch (er) { fail(er); }
      b.disabled = false; b.textContent = "Import bundle";
    };
  }
  async function load() {
    const { records } = await api.get(`/api/archive?${App.q(new URLSearchParams(Object.entries({ q: Q, type: TY }).filter(([, v]) => v)).toString())}`);
    $("#ag").innerHTML = records.length ? `<div class="archgrid">${records.map(r => `<button class="arec" data-id="${esc(r.id)}"><img src="/api/media/${esc(r.media_id)}/thumb" alt="" loading="lazy"><div class="bd">
      <div class="row"><span class="mono tiny">${esc(r.id)}</span><span class="tiny sub" style="margin-left:auto">documented ${fmtD(r.documented_date)}</span></div>
      <b>${esc(r.title)}</b><div>${r.record_type === "misleading" ? `<span class="chip con">Previously assessed misleading</span>` : `<span class="chip sup">Documented original</span>`} ${r.from_case_id ? `<span class="chip info">From ${esc(r.from_case_id)}</span>` : ""}</div>
      <div class="tiny sub">Source: ${esc(r.source_ref)}${r.matched_cases ? ` · matched in ${r.matched_cases} case${r.matched_cases > 1 ? "s" : ""}` : ""}</div></div></button>`).join("")}</div>`
      : empty(Q || TY ? "No records match" : "The reference archive is empty", Q || TY ? "Try a different search." : "Add images whose origin is documented (official releases, earlier verified reports). Submissions are compared against them.", !Q && !TY && manage ? `<button class="btn primary" onclick="document.getElementById('addA').click()">Add the first record</button>` : "");
    $$(".arec").forEach(b => b.onclick = () => detail(b.dataset.id));
  }
  async function add() {
    const r = await modal("Add a reference record", `<p class="small muted">Only add material whose origin is documented. Every field is required so later analysts can trace it.</p>
      <label class="f" for="nf">Image <span class="req">*</span></label><input type="file" id="nf" accept="image/*">
      <label class="f" for="nt">Title <span class="req">*</span></label><input type="text" id="nt" placeholder="What the image shows">
      <label class="f" for="nd">Origin and context <span class="req">*</span></label><textarea id="nd" rows="3" placeholder="Where and when it was first published, by whom, and what it actually shows"></textarea>
      <div class="grid g2"><div><label class="f" for="ndt">Documented date <span class="req">*</span></label><input type="date" id="ndt"></div><div><label class="f" for="nty">Record type</label><select id="nty"><option value="original">Documented original</option><option value="misleading">Previously assessed misleading item</option></select></div></div>
      <label class="f" for="nr">Source reference <span class="req">*</span></label><input type="text" id="nr" placeholder="Publication, URL, file reference or report ID">
      ${App.training ? `<div class="callout train" style="margin-top:12px"><div>This will be a training record (TA-…), used only with training cases.</div></div>` : ""}`,
      [{ label: "Cancel", value: null }, { label: "Add record", kind: "primary", validate: async el => {
        const f = $("#nf", el).files[0]; if (!f) return "Choose the image.";
        const fd = new FormData(); fd.append("file", f, f.name);
        for (const [k, id] of [["title", "nt"], ["description", "nd"], ["documented_date", "ndt"], ["record_type", "nty"], ["source_ref", "nr"]]) fd.append(k, $("#" + id, el).value.trim());
        fd.append("is_training", App.training ? "1" : "0");
        try { const x = await api.upload("/api/archive", fd); toast(`Record ${x.id} added and indexed.`); } catch (e) { return e.message; }
      }, value: true }]);
    if (r.value) load();
  }
  async function detail(id) {
    const d = await api.get(`/api/archive/${id}`), a = d.record, m = d.media[0];
    const r = await modal(`${a.id} · ${a.title}`, `<div class="split"><div><img src="/api/media/${esc(m.id)}/thumb" alt="" style="width:100%;border-radius:6px;cursor:zoom-in" id="dimg">
        <dl class="kv small" style="margin-top:10px"><dt>SHA-256</dt><dd class="mono tiny">${esc(m.sha256)}</dd><dt>dHash / pHash</dt><dd class="mono tiny">${esc(m.dhash)} / ${esc(m.phash)}</dd><dt>Size</dt><dd>${m.width}×${m.height}</dd></dl></div>
      <div><dl class="kv"><dt>Type</dt><dd>${a.record_type === "misleading" ? "Previously assessed misleading" : "Documented original"}</dd><dt>Documented</dt><dd>${fmtD(a.documented_date)}</dd><dt>Origin</dt><dd>${esc(a.description)}</dd><dt>Source</dt><dd>${esc(a.source_ref)}</dd>${a.from_case_id ? `<dt>From case</dt><dd><a href="#/case/${esc(a.from_case_id)}">${esc(a.from_case_id)}</a></dd>` : ""}<dt>Status</dt><dd>${a.active ? "Active" : "Withdrawn"}</dd></dl>
        <h4 style="margin-top:14px">Source history</h4><ul class="mini">${d.history.map(h => `<li><span class="tiny sub" style="width:120px;flex:none">${fmtDT(h.at)}</span><span class="small">${esc(h.action)} · ${esc(h.user || "")}</span></li>`).join("")}</ul>
        <h4 style="margin-top:14px">Cases that matched this record</h4>${d.cases.length ? `<ul class="mini">${d.cases.map(c => `<li><a href="#/case/${esc(c.id)}">${esc(c.id)}</a><span class="small" style="flex:1">${esc(c.title)}</span>${status(c.status)} ${concl(c.conclusion)}</li>`).join("")}</ul>` : `<p class="small muted">None yet.</p>`}</div></div>`,
      [...(manage && a.active ? [{ label: "Withdraw", kind: "danger", value: "withdraw" }, { label: "Edit", value: "edit" }] : []), { label: "Close", value: null }], { wide: true, onOpen: el => ($("#dimg", el).onclick = () => viewer(`/api/media/${m.id}/content`, a.title)) });
    if (r.value === "edit") edit(a); else if (r.value === "withdraw") withdraw(a);
  }
  async function edit(a) {
    const r = await modal(`Edit ${a.id}`, `<label class="f" for="et">Title</label><input type="text" id="et" value="${esc(a.title)}"><label class="f" for="ed">Origin and context</label><textarea id="ed" rows="3">${esc(a.description)}</textarea>
      <div class="grid g2"><div><label class="f" for="edt">Documented date</label><input type="date" id="edt" value="${esc(a.documented_date.slice(0, 10))}"></div><div><label class="f" for="ety">Type</label><select id="ety"><option value="original" ${a.record_type === "original" ? "selected" : ""}>Documented original</option><option value="misleading" ${a.record_type === "misleading" ? "selected" : ""}>Previously assessed misleading</option></select></div></div>
      <label class="f" for="er">Source reference</label><input type="text" id="er" value="${esc(a.source_ref)}"><label class="f" for="ere">Reason for the change <span class="req">*</span></label><input type="text" id="ere" placeholder="Recorded in the source history">`,
      [{ label: "Cancel", value: null }, { label: "Save", kind: "primary", validate: async el => { try { await api.patch(`/api/archive/${a.id}`, { title: $("#et", el).value, description: $("#ed", el).value, documented_date: $("#edt", el).value, record_type: $("#ety", el).value, source_ref: $("#er", el).value, reason: $("#ere", el).value }); } catch (e) { return e.message; } }, value: true }]);
    if (r.value) { toast("Record updated."); load(); }
  }
  async function withdraw(a) {
    const r = await modal(`Withdraw ${a.id}`, `<p class="small">Withdrawn records stop matching new submissions but stay on file with their history.</p><label class="f" for="wr">Reason <span class="req">*</span></label><input type="text" id="wr">`,
      [{ label: "Cancel", value: null }, { label: "Withdraw", kind: "danger", validate: async el => { try { await api.patch(`/api/archive/${a.id}`, { active: false, reason: $("#wr", el).value }); } catch (e) { return e.message; } }, value: true }]);
    if (r.value) { toast("Record withdrawn."); load(); }
  }
  await load();
}

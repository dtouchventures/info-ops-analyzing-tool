// Dataset registry: published fact-checks and research datasets with their licence, review and measured baseline.
import { api } from "../api.js";
import { App, crumbs } from "../app.js";
import { $, $$, esc, toast, fail, confirmBox, fmtDT, empty, errMsg, modal, ASSESS } from "../ui.js";

const STAT = { pending: ["Waiting for approval", "warn"], approved: ["Approved: searched", "sup"], retired: ["Retired", "grey"] };
const FMT = { "google-factcheck": "Google Fact Check Tools JSON", claimreview: "schema.org ClaimReview", fever: "FEVER (JSON Lines)", liar: "LIAR (TSV)", multifc: "MultiFC (TSV)", "aivs-csv": "AIVS CSV template", "aivs-json": "JSON list" };
const pct = x => (x == null ? "—" : `${Math.round(x * 100)}%`);

export async function render(el, [id]) { return id ? detail(el, id) : list(el); }

async function list(el) {
  crumbs("<b>Datasets</b>");
  const { datasets } = await api.get("/api/kb/datasets"), canImport = App.can("archive.manage");
  el.innerHTML = `<div class="pagehead"><div><h1>Datasets and knowledge base</h1><p>Collections of published fact-checks and research datasets. Once approved, AIVS searches them for every claim and offers matches as suggestions, with the publisher's verdict and link.</p></div></div>
    <div class="callout info" style="margin-bottom:14px"><div><b>Retrieval, not training.</b> AIVS looks records up and cites them; it does not train or change any AI model with them. Each dataset's licence is recorded before use, and a second person must approve it.</div></div>
    <div class="split"><div class="stack"><div class="card"><div class="hd"><h3>Datasets</h3><span class="chip grey right">${datasets.length}</span></div>
      ${datasets.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Dataset</th><th class="n">Records</th><th>Licence</th><th>Status</th></tr></thead><tbody>${datasets.map(d => `<tr class="click" data-ds="${d.id}"><td><b>${esc(d.name)}</b> <span class="tiny sub">v${d.version}</span>${d.is_synthetic ? ` <span class="chip train">synthetic</span>` : ""}<div class="tiny sub">${esc(FMT[d.format] || d.format || "")} · imported by ${esc(d.imported_by_name || "—")} ${fmtDT(d.imported_at)}</div></td><td class="n">${d.records.toLocaleString()}</td><td class="small">${esc(d.license)}</td><td><span class="chip ${STAT[d.status][1]}">${STAT[d.status][0]}</span></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="bd">${empty("No datasets yet", "Import a file of published fact-checks, or load the synthetic practice set.")}</div>`}</div></div>
    <div class="stack">${canImport ? `<div class="card"><div class="hd"><h3>Import a dataset</h3></div><div class="bd">
      <label class="f" for="kf" style="margin-top:0">File <span class="req">*</span></label><input type="file" id="kf" accept=".csv,.json,.jsonl,.tsv,.txt">
      <div class="hint">Recognised automatically: Google Fact Check Tools JSON, schema.org ClaimReview, FEVER, LIAR, MultiFC, or a CSV with columns <span class="mono">claim, label, url, publisher, date, language</span>. <a href="/kb-template.csv" download>Download the template</a>.</div>
      <label class="f" for="kn">Name <span class="req">*</span></label><input type="text" id="kn" maxlength="200" placeholder="e.g. Africa Check fact-checks 2024">
      <label class="f" for="kl">Licence <span class="req">*</span></label><input type="text" id="kl" maxlength="300" placeholder="e.g. CC BY 4.0; or publisher permission dated …">
      <label class="f" for="kp">What the licence permits <span class="req">*</span></label><input type="text" id="kp" maxlength="500" placeholder="e.g. internal reference and research; no redistribution">
      <div class="grid g2"><div><label class="f" for="ku">Source link</label><input type="url" id="ku" placeholder="https://…"></div><div><label class="f" for="kg">Languages</label><input type="text" id="kg" placeholder="en, sw"></div></div>
      <label class="f" for="kx">Known limitations</label><textarea id="kx" rows="2" placeholder="e.g. US-centred topics; 2016–2018 only; English only"></textarea>
      <div id="kerr" class="callout bad" style="margin-top:10px" hidden></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="kgo">Import</button><button class="btn" id="ksample">Load synthetic practice set</button></div>
      <div class="hint">Check the licence before importing. Many fact-checkers allow reading and linking but not bulk reuse; ask them for permission or use their ClaimReview data through Google Fact Check Tools instead.</div></div></div>` : ""}</div></div>`;
  $$("[data-ds]").forEach(r => r.onclick = () => App.go(`#/datasets/${r.dataset.ds}`));
  if (!canImport) return;
  $("#ksample").onclick = async () => { try { const r = await api.post("/api/kb/sample"); toast(`Synthetic set imported (${r.imported} records). A second person must approve it.`); App.go(`#/datasets/${r.id}`); } catch (e) { fail(e); } };
  $("#kgo").onclick = async () => {
    const f = $("#kf").files[0], err = $("#kerr"); err.hidden = true;
    const miss = [!f && "a file", !$("#kn").value.trim() && "a name", !$("#kl").value.trim() && "the licence", !$("#kp").value.trim() && "what the licence permits"].filter(Boolean);
    if (miss.length) { err.hidden = false; err.textContent = `Add ${miss.join(", ")}.`; return; }
    const fd = new FormData(); fd.append("file", f); for (const [k, v] of [["name", "#kn"], ["license", "#kl"], ["permitted_use", "#kp"], ["source_url", "#ku"], ["languages", "#kg"], ["limitations", "#kx"]]) fd.append(k, $(v).value.trim());
    const b = $("#kgo"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Importing…';
    try { const r = await api.upload("/api/kb/datasets", fd); toast(`${r.imported.toLocaleString()} records imported (${r.duplicates} duplicates, ${r.unmapped_labels} labels not recognised).`); App.go(`#/datasets/${r.id}`); }
    catch (e) { err.hidden = false; err.textContent = errMsg(e); b.disabled = false; b.textContent = "Import"; }
  };
}

async function detail(el, id) {
  const qp = new URLSearchParams(location.hash.split("?")[1] || ""), f = { q: qp.get("q") || "", split: qp.get("split") || "", review: qp.get("review") || "", label: qp.get("label") || "" };
  const D = await api.get(`/api/kb/datasets/${encodeURIComponent(id)}?${new URLSearchParams({ ...f, limit: 100 })}`), d = D.dataset, C = D.counts, can = App.can("archive.manage"), ev = D.evaluations[0];
  crumbs(`<a href="#/datasets">Datasets</a> / <b>${esc(d.name)}</b>`);
  const go = (k, v) => { const p = { ...f, [k]: v }; App.go(`#/datasets/${d.id}?${new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([, x]) => x)))}`); };
  el.innerHTML = `<div class="casehead">${d.is_synthetic ? `<div class="callout train" style="margin-bottom:10px"><div><b>Synthetic practice data.</b> Invented claims; used only for training cases.</div></div>` : ""}
      <div class="top"><div><div class="id">Dataset ${d.id} · version ${d.version} · ${esc(FMT[d.format] || d.format || "")} · SHA-256 ${esc(d.file_sha256.slice(0, 12))}…</div><h1 style="margin-top:2px">${esc(d.name)}</h1></div>
        <div class="acts">${can && d.status === "pending" ? (d.imported_by === App.me.id ? `<span class="chip warn" title="Separation of duties">Waiting for a second person to approve</span>` : `<button class="btn primary" id="kap">Approve for search</button>`) : ""}${can && d.status === "approved" ? `<button class="btn" id="kret">Retire</button>` : ""}${can ? `<button class="btn" id="kev">Measure accuracy</button>` : ""}<a class="btn ghost" href="/api/kb/datasets/${d.id}/records.csv">Export CSV</a></div></div>
      <div class="facts"><span><span class="chip ${STAT[d.status][1]}">${STAT[d.status][0]}</span></span><span>Licence: <b>${esc(d.license)}</b></span><span>Permitted use: <b>${esc(d.permitted_use)}</b></span>${d.languages ? `<span>Languages: <b>${esc(d.languages)}</b></span>` : ""}${d.source_url ? `<span><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Source</a></span>` : ""}
        <span>Imported by <b>${esc(d.imported_by_name || "—")}</b>${d.approved_at ? ` · approved by <b>${esc(d.approved_by_name || "—")}</b> ${fmtDT(d.approved_at)}` : ""}</span></div>
      ${d.limitations ? `<div class="small" style="margin-top:8px"><b>Known limitations:</b> ${esc(d.limitations)}</div>` : ""}</div>
    <div class="kpis" style="margin-top:14px">
      <div class="kpi"><div class="l">Records</div><div class="v">${d.records.toLocaleString()}</div><div class="tiny sub">${C.duplicates} duplicate(s) of earlier records</div></div>
      <div class="kpi"><div class="l">Split</div><div class="v" style="font-size:18px">${C.splits.train || 0} / ${C.splits.validation || 0} / ${C.splits.test || 0}</div><div class="tiny sub">training / validation / test, fixed by text</div></div>
      <div class="kpi"><div class="l">Labels</div><div class="tiny" style="margin-top:6px">${Object.entries(C.labels).map(([k, n]) => `<a href="#" data-label="${esc(k)}" class="chip ${ASSESS[k]?.[1] || "grey"}">${esc(ASSESS[k]?.[0] || "not recognised")} ${n}</a>`).join(" ")}</div></div>
      <div class="kpi"><div class="l">Reviewed</div><div class="v">${(C.review.confirmed || 0) + (C.review.corrected || 0) + (C.review.removed || 0)}</div><div class="tiny sub">${C.review.corrected || 0} corrected · ${C.review.removed || 0} removed</div></div></div>
    ${ev ? `<div class="card" style="margin-top:14px"><div class="hd"><h3>Measured accuracy (retrieval baseline)</h3><span class="small sub right">${fmtDT(ev.at)} · ${ev.metrics.test_records} test records</span></div><div class="bd small">
      <div class="row" style="gap:24px"><div><div class="label">Coverage</div><b style="font-size:20px">${pct(ev.metrics.coverage)}</b><div class="tiny sub">test claims with a close match</div></div><div><div class="label">Correct when matched</div><b style="font-size:20px">${pct(ev.metrics.accuracy_when_predicting)}</b></div><div><div class="label">Correct overall</div><b style="font-size:20px">${pct(ev.metrics.accuracy_overall)}</b></div></div>
      <div class="tablewrap" style="margin-top:10px"><table class="t"><thead><tr><th>Verdict</th><th class="n">Test records</th><th class="n">Precision</th><th class="n">Recall</th><th class="n">F1</th></tr></thead><tbody>${Object.entries(ev.metrics.per_class).map(([k, m]) => `<tr><td>${esc(ASSESS[k]?.[0] || k)}</td><td class="n">${m.support}</td><td class="n">${pct(m.precision)}</td><td class="n">${pct(m.recall)}</td><td class="n">${pct(m.f1)}</td></tr>`).join("")}</tbody></table></div>
      <div style="margin-top:8px">By language: ${Object.entries(ev.metrics.by_language).map(([l, x]) => `<b>${esc(l)}</b> ${x.n} records, ${pct(x.predicted / x.n)} matched, ${pct(x.predicted ? x.correct / x.predicted : null)} correct when matched`).join(" · ")}</div>
      <div class="hint">${esc(ev.metrics.note)}</div></div></div>` : ""}
    <div class="card" style="margin-top:14px"><div class="hd"><h3>Records</h3><span class="small sub right">${D.total.toLocaleString()} matching${D.total > D.records.length ? `, first ${D.records.length} shown` : ""}</span></div><div class="bd">
      <div class="row"><input type="search" id="rq" value="${esc(f.q)}" placeholder="Search claims or publishers" style="flex:1;min-width:200px"><select id="rs" style="width:auto"><option value="">All splits</option>${["train", "validation", "test"].map(x => `<option ${f.split === x ? "selected" : ""}>${x}</option>`).join("")}</select><select id="rr" style="width:auto"><option value="">Any review</option>${["unreviewed", "confirmed", "corrected", "removed"].map(x => `<option ${f.review === x ? "selected" : ""}>${x}</option>`).join("")}</select><button class="btn sm" id="rgo">Filter</button>${Object.values(f).some(Boolean) ? `<a class="btn sm ghost" href="#/datasets/${d.id}">Clear</a>` : ""}</div>
      <div class="tablewrap" style="margin-top:10px"><table class="t"><thead><tr><th>Claim</th><th>Published verdict</th><th>Publisher</th><th>Split</th><th>Review</th>${can ? "<th></th>" : ""}</tr></thead><tbody>${D.records.map(r => `<tr><td class="small">${esc(r.claim)}${r.dup_of ? `<div class="tiny sub">duplicate of KB-${r.dup_of}</div>` : ""}</td><td class="small"><span class="chip ${ASSESS[r.label]?.[1] || "grey"}">${esc(ASSESS[r.label]?.[0] || "not recognised")}</span><div class="tiny sub">“${esc(r.label_raw || "")}”</div></td>
        <td class="small">${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(r.publisher || "link")}</a>` : esc(r.publisher || "—")}${r.published_at ? `<div class="tiny sub">${esc(r.published_at)}</div>` : ""}</td><td class="small">${esc(r.split)}</td><td class="small">${esc(r.review_status)}${r.review_note ? `<div class="tiny sub">${esc(r.review_note)}</div>` : ""}</td>
        ${can ? `<td><button class="btn sm ghost" data-rev="${r.id}">Review</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="6">No records match.</td></tr>`}</tbody></table></div></div></div>`;
  $$("[data-label]").forEach(a => a.onclick = e => { e.preventDefault(); go("label", a.dataset.label); });
  $("#rgo").onclick = () => App.go(`#/datasets/${d.id}?${new URLSearchParams(Object.fromEntries(Object.entries({ q: $("#rq").value.trim(), split: $("#rs").value, review: $("#rr").value }).filter(([, x]) => x)))}`);
  $("#rq").onkeydown = e => e.key === "Enter" && $("#rgo").click();
  if ($("#kap")) $("#kap").onclick = async () => { if (await confirmBox("Approve this dataset?", `You confirm the licence (${d.license}) permits this use. From now on its records are searched for every claim and offered as suggestions.${d.is_synthetic ? " Synthetic data is offered on training cases only." : ""}`, "Approve")) { try { await api.post(`/api/kb/datasets/${d.id}/approve`, {}); toast("Approved."); detail(el, id); } catch (e) { fail(e); } } };
  if ($("#kret")) $("#kret").onclick = async () => { if (await confirmBox("Retire this dataset?", "Its records stop being searched. Evidence already accepted in cases keeps its citation.", "Retire")) { try { await api.post(`/api/kb/datasets/${d.id}/retire`, {}); detail(el, id); } catch (e) { fail(e); } } };
  if ($("#kev")) $("#kev").onclick = async () => { const b = $("#kev"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Measuring…'; try { await api.post(`/api/kb/datasets/${d.id}/evaluate`, {}); toast("Accuracy measured."); detail(el, id); } catch (e) { fail(e); b.disabled = false; b.textContent = "Measure accuracy"; } };
  $$("[data-rev]").forEach(b => b.onclick = async () => {
    const r = await modal("Review record", `<p class="small">${esc(D.records.find(x => String(x.id) === b.dataset.rev).claim)}</p><label class="f" for="rv">Decision</label><select id="rv"><option value="confirmed">Confirmed: label is right</option><option value="corrected">Corrected: label is wrong</option><option value="removed">Removed: do not use this record</option></select>
      <label class="f" for="rl">Corrected label</label><select id="rl">${Object.entries(ASSESS).filter(([k]) => k !== "unassessed").map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select><label class="f" for="rn">Reason</label><input type="text" id="rn" maxlength="300" placeholder="Required when correcting or removing">`,
      [{ label: "Cancel", value: null }, { label: "Save", kind: "primary", value: m => ({ review_status: $("#rv", m).value, label: $("#rl", m).value, note: $("#rn", m).value }) }]);
    if (r.value) { try { await api.patch(`/api/kb/records/${b.dataset.rev}`, r.value); toast("Saved."); detail(el, id); } catch (e) { fail(e); } }
  });
}

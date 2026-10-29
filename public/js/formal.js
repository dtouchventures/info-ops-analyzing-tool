// Formal one-page report (UNIT: STRATEGIC COMMUNICATION / ) for a case or a dataset:
// Generate Report → edit → print preview → Download Word / Download PDF / Print Report.
// The server measures the text against one A4 page; downloads and printing open only when it fits and every
// required field is filled.
import { api } from "./api.js";
import { $, esc, toast, fail, confirmBox, fmtDT } from "./ui.js";

const FIELDS = [["purpose", "1. Purpose", 3], ["background", "2. Background", 4], ["analysis", "3. Analysis", 8], ["assessment", "5. Assessment", 4]];

export async function formalPanel(box, kind, id) {
  const base = `/api/formal/${kind}/${encodeURIComponent(id)}`;
  let R = await api.get(base), dirty = false;
  const draw = () => {
    const c = R.content, ed = R.can_edit, L = R.layout;
    const status = !R.saved ? `<span class="chip grey">Not generated</span>` : R.ready ? `<span class="chip sup">Ready to print</span>` : `<span class="chip warn">Not ready</span>`;
    box.innerHTML = `<div class="card frm"><div class="hd"><h3>Formal report (one A4 page)</h3>${status}</div><div class="bd">
      <p class="small muted" style="margin-top:0">UNIT: STRATEGIC COMMUNICATION format, . The draft is written only from the ${kind === "case" ? "case's claims, verdicts, accepted evidence and review decision" : "dataset's stored analysis"}; anything not recorded is marked as needing verification. Edit every part before printing.</p>
      ${!R.saved ? (ed ? `<button class="btn primary" id="frGen" type="button">Generate Report</button>` : `<p class="small">A reviewer, administrator or the assigned analyst prepares this report.</p>`) : `
      <div class="frm-grid"><div>
        <label class="f" for="fr_date">Date-time group <span class="req">*</span></label><input type="text" id="fr_date" maxlength="40" value="${esc(c.date || "")}" placeholder="281430Z OCT 26" ${ed ? "" : "disabled"}>
        <div class="hint">Military date-time group, printed at the top right: day, hour and minute, time zone letter (Z = UTC, C = East Africa Time), month, year.</div>
        <label class="f" for="fr_subject">Subject <span class="req">*</span></label><input type="text" id="fr_subject" maxlength="200" value="${esc(c.subject)}" ${ed ? "" : "disabled"}>
        ${FIELDS.map(([k, l, rows]) => `<label class="f" for="fr_${k}">${l} <span class="req">*</span></label><textarea id="fr_${k}" rows="${rows}" ${ed ? "" : "disabled"}>${esc(c[k])}</textarea>${k === "assessment" ? '<div class="hint">One assessment point per line. Points are lettered (a), (b), (c) in the report.</div>' : ""}`).join("")}
        <label class="f" for="fr_recs">6. Recommendations <span class="req">*</span></label><textarea id="fr_recs" rows="5" ${ed ? "" : "disabled"}>${esc(c.recommendations.join("\n"))}</textarea>
        <div class="hint">One recommendation per line. They are lettered (a), (b), (c) when printed.</div>
        <label class="f" for="fr_conclusion">7. Conclusion <span class="req">*</span></label><textarea id="fr_conclusion" rows="3" ${ed ? "" : "disabled"}>${esc(c.conclusion)}</textarea>
        <div class="fgrid" style="margin-top:4px"><div><label class="f" for="fr_rank">Rank</label><input type="text" id="fr_rank" maxlength="120" value="${esc(c.preparer.rank)}" ${ed ? "" : "disabled"}></div>
          <div><label class="f" for="fr_name">Name</label><input type="text" id="fr_name" maxlength="120" value="${esc(c.preparer.name)}" ${ed ? "" : "disabled"}></div>
          <div><label class="f" for="fr_appt">Appointment</label><input type="text" id="fr_appt" maxlength="120" value="${esc(c.preparer.appointment)}" ${ed ? "" : "disabled"}></div></div>
        <div class="hint">Prepared by: left blank, to be completed by hand on the printed copy. Type in these fields only if you want them printed.</div>
      </div><div>
        <div id="frState">${state()}</div>
        <div class="row" style="margin:10px 0">${ed ? `<button class="btn" id="frGen" type="button">Generate Report</button><button class="btn primary" id="frSave" type="button">Save</button>` : ""}
          <a class="btn" id="frDocx" href="${base}/report.docx">Download Word</a><a class="btn ghost" id="frPdf" href="${base}/report.pdf">PDF</a><button class="btn" id="frPrint" type="button">Print Report</button></div>
        <div class="frm-prev"><iframe id="frPrev" title="Print preview" src="${base}/report.html?r=${R.revision}"></iframe></div>
        <div class="hint">Print preview at reduced size. Revision ${R.revision}, saved ${fmtDT(R.updated_at)}.</div>
      </div></div>`}</div></div>`;
    wire();
  };
  const state = () => {
    const L = R.layout, P = R.problems || [];
    return `${L ? (L.fits ? `<div class="callout good"><div><b>Fits on one A4 page</b> (measured): Arial ${L.size} pt, margins ${L.marginCm} cm${L.adjusted ? " (spacing or size reduced to fit)" : ""}.</div></div>` : `<div class="callout bad"><div><b>Longer than one A4 page</b> by about ${L.over_lines} line(s) at the smallest readable settings. Shorten the text; nothing is cut automatically.</div></div>`) : ""}
      ${P.length ? `<div class="callout warn" style="margin-top:8px"><div>${P.map(esc).join("<br>")}</div></div>` : ""}
      ${dirty ? `<div class="callout info" style="margin-top:8px"><div>Unsaved changes: save before downloading or printing.</div></div>` : ""}`;
  };
  const collect = () => ({ date: $("#fr_date").value, subject: $("#fr_subject").value, ...Object.fromEntries(FIELDS.map(([k]) => [k, $(`#fr_${k}`).value])), recommendations: $("#fr_recs").value.split("\n"), conclusion: $("#fr_conclusion").value,
    preparer: { rank: $("#fr_rank").value, name: $("#fr_name").value, appointment: $("#fr_appt").value } });
  const gate = () => { const ok = R.saved && R.ready && !dirty; for (const s of ["#frDocx", "#frPdf", "#frPrint"]) { const b = $(s, box); if (!b) continue; b.classList.toggle("disabled", !ok); b.setAttribute("aria-disabled", String(!ok)); if (b.tagName === "BUTTON") b.disabled = !ok; } if ($("#frState", box)) $("#frState", box).innerHTML = state(); };
  async function generate() {
    if (R.saved && !(await confirmBox("Generate the report again?", "Purpose, background, analysis, assessment, recommendations and conclusion are rewritten from the current records. Your subject and Prepared-by details are kept. Earlier versions stay on record.", "Generate"))) return;
    try { R = await api.post(`${base}/generate`, {}); dirty = false; draw(); toast(R.ready ? "Report generated. It fits on one A4 page." : "Report generated. Complete the missing fields before printing."); } catch (e) { fail(e); }
  }
  function wire() {
    if ($("#frGen", box)) $("#frGen", box).onclick = generate;
    if (!R.saved) return;
    box.querySelectorAll("input, textarea").forEach(x => x.addEventListener("input", () => { dirty = true; gate(); }));
    if ($("#frSave", box)) $("#frSave", box).onclick = (async () => { try { R = await api.put(base, { revision: R.revision, content: collect() }); dirty = false; draw(); toast(R.ready ? "Saved. Ready to print." : "Saved. Not ready to print yet: see the notes beside the preview."); } catch (e) { fail(e); } });
    for (const s of ["#frDocx", "#frPdf"]) $(s, box).addEventListener("click", e => { if ($(s, box).classList.contains("disabled")) { e.preventDefault(); toast(dirty ? "Save your changes first." : "Not ready: see the notes beside the preview.", "err"); } });
    $("#frPrint", box).onclick = (async () => {
      const f = $("#frPrev", box); if (!f?.contentWindow) return;
      try { f.contentWindow.focus(); f.contentWindow.print(); await api.post(`${base}/printed`, {}); } catch (e) { fail(e); }
    });
    gate();
  }
  draw();
}

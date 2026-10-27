// Head of Department approval of AIVS reports (1.32).
//
//   AI draft → analyst review (revise if needed) → submitted, pending HOD approval → HOD review → approved | returned | rejected
//
// Rules, enforced here on the server:
//   - only a user with the "hod" role who is the assigned approver may decide; never the analyst who submitted the report or who
//     started the investigation; an administrator has no approval authority unless also given the hod role;
//   - the HOD decides on exactly the content that was submitted (its SHA-256 is checked); a material change after submission or
//     approval sends the report back to draft and the earlier approval no longer counts;
//   - only an approved report is released as the final PDF, which is generated at approval time, stored unchanged, and carries
//     the HOD's name, designation, the approval date and reference and a verification code (HMAC of the approved content);
//   - every step is written to a hash-chained event log and to the audit log; the AI never approves anything.
import crypto from "node:crypto";
import { nowISO } from "./db.js";
import { HttpError, can } from "./auth.js";

export const STATUS_LABEL = { draft: "AI draft — analyst review", pending: "Pending HOD approval", returned: "Returned for revision", rejected: "Rejected", approved: "Approved" };
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
// the material content of a report: what the HOD approves
export const contentOf = a => ({ background: a.background, analysis: a.analysis, assessment: a.assessment, recommendations: a.recommendations, verdict: a.verdict_label, confidence: a.strength,
  references: (a.references || []).map(f => ({ n: f.n, url: f.url, publisher: f.publisher, title: f.title })) });
export const contentHash = a => sha(JSON.stringify(contentOf(a)));
const eat = iso => { const d = new Date(Date.parse(iso) + 3 * 3600e3), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], p = n => String(n).padStart(2, "0"); return `${p(d.getUTCDate())} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}hrs EAT`; };

export function makeApprovals(db, { audit, storage, config, notify = null }) {
  // the secret behind verification codes: AIVS_REPORT_SECRET, or one generated once and kept in the database
  const secret = () => { if (config.reportSecret) return config.reportSecret; let r = db.prepare("SELECT value FROM settings WHERE key = 'report_verification_secret'").get();
    if (!r) { db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('report_verification_secret', ?)").run(crypto.randomBytes(32).toString("hex")); r = db.prepare("SELECT value FROM settings WHERE key = 'report_verification_secret'").get(); } return r.value; };
  const codeFor = (ref, hash, at) => crypto.createHmac("sha256", secret()).update(`${ref}|${hash}|${at}`).digest("hex").slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, "$1-");
  const getRow = (kind, refId) => db.prepare("SELECT * FROM report_approvals WHERE kind = ? AND ref_id = ?").get(kind, String(refId));
  const userName = id => id ? db.prepare("SELECT display_name, designation FROM users WHERE id = ?").get(id) : null;

  const linkOf = r => r.kind === "investigation" ? `#/investigate/${r.ref_id}` : "#/reports";
  function event(row, action, user, { from, to, note = null, hash = null } = {}) {
    const prev = db.prepare("SELECT hash FROM report_approval_events WHERE approval_id = ? ORDER BY id DESC LIMIT 1").get(row.id)?.hash || "GENESIS", at = nowISO();
    const rec = { approval_id: row.id, action, from_status: from ?? row.status, to_status: to ?? row.status, version: row.version, content_sha256: hash ?? row.content_sha256, by_user: user?.id ?? null, by_name: user?.display_name || "system", at, note };
    const h = sha(`${prev}|${JSON.stringify(rec)}`);
    db.prepare("INSERT INTO report_approval_events(approval_id,action,from_status,to_status,version,content_sha256,by_user,by_name,at,note,prev_hash,hash) VALUES (@approval_id,@action,@from_status,@to_status,@version,@content_sha256,@by_user,@by_name,@at,@note,@prev,@hash)").run({ ...rec, prev, hash: h });
    audit(user, `Report ${action}`, row.kind === "investigation" ? "investigation" : "monitor_report", row.ref_id, { report: row.report_ref, from: rec.from_status, to: rec.to_status, version: row.version, sha256: rec.content_sha256, note: note ? String(note).slice(0, 300) : undefined });
  }
  function ensure(kind, refId, reportRef, createdBy) {
    let r = getRow(kind, refId); if (r) return r;
    const now = nowISO();
    db.prepare("INSERT OR IGNORE INTO report_approvals(kind,ref_id,report_ref,status,version,created_by,created_at,updated_at) VALUES (?,?,?,'draft',1,?,?,?)").run(kind, String(refId), reportRef, createdBy ?? null, now, now);
    return getRow(kind, refId);
  }
  // what the report shows: "APPROVED BY HEAD OF DEPARTMENT" only for a current approval of exactly this content
  function info(kind, refId, a) {
    const r = getRow(kind, refId); if (!r) return { approved: false, status: "draft", label: STATUS_LABEL.draft };
    const valid = r.status === "approved" && (!a || contentHash(a) === r.approved_sha256);
    if (valid) return { approved: true, status: "approved", label: "Approved", name: r.approver_name, designation: r.approver_designation, at: r.decided_at, at_text: eat(r.decided_at), ref: r.approval_ref, code: r.verify_code, verify_path: "/verify-report", pdf_sha256: r.pdf_sha256 };
    return { approved: false, status: r.status, label: r.status === "approved" ? "approval no longer valid: the report changed" : STATUS_LABEL[r.status] };
  }
  function hods(exceptIds = []) { return db.prepare("SELECT id, display_name, designation FROM users WHERE role = 'hod' AND active = 1 ORDER BY display_name").all().filter(u => !exceptIds.includes(u.id)); }
  function snapshot(row, a, user, reason) {
    const c = contentOf(a), h = sha(JSON.stringify(c));
    db.prepare("INSERT INTO report_versions(approval_id,version,content_json,content_sha256,changed_by,changed_at,reason) VALUES (?,?,?,?,?,?,?)").run(row.id, row.version, JSON.stringify(c), h, user?.id ?? null, nowISO(), reason);
    return h;
  }

  // the analyst submits the report (as it stands now) to a Head of Department
  function submit(user, kind, refId, a, { reportRef, createdBy, hodId, note = "", ready = true, auto = false }) {
    if (!can(user, "report.submit")) throw new HttpError(403, "Your role cannot submit reports for approval.");
    if (!ready) throw new HttpError(409, "There is no report to submit yet: the investigation has no content or has not finished.");
    const row = ensure(kind, refId, reportRef, createdBy);
    if (!["draft", "returned"].includes(row.status)) throw new HttpError(409, row.status === "pending" ? "The report is already waiting for HOD approval." : row.status === "approved" ? "The report is approved. Revise it first if it must be submitted again." : "A rejected report cannot be submitted again; start a new investigation.");
    const list = hods([user.id, createdBy].filter(Boolean));
    // automatic submission (1.33): the active Head of Department with the fewest reports waiting is assigned
    const load = id => db.prepare("SELECT COUNT(*) n FROM report_approvals WHERE status = 'pending' AND assigned_hod = ?").get(id).n;
    const hod = hodId ? list.find(u => u.id === +hodId) : list.length === 1 ? list[0] : auto && list.length ? list.map(u => [u, load(u.id)]).sort((x, y) => x[1] - y[1] || x[0].id - y[0].id)[0][0] : null;
    if (!list.length) throw new HttpError(409, "No Head of Department approver is set up. An administrator assigns the Head of Department role to the approver in Settings › Users.");
    if (!hod) throw new HttpError(400, hodId ? "Choose an active Head of Department other than yourself." : "Choose the Head of Department who should approve this report.");
    const h = contentHash(a), now = nowISO();
    db.prepare("UPDATE report_approvals SET status = 'pending', content_sha256 = ?, submitted_by = ?, submitted_at = ?, submit_note = ?, assigned_hod = ?, decided_by = NULL, decided_at = NULL, decision_note = NULL, updated_at = ? WHERE id = ?")
      .run(h, user.id, now, String(note || "").slice(0, 1000) || null, hod.id, now, row.id);
    const cur = getRow(kind, refId); snapshot(cur, a, user, "submitted for HOD approval");
    event(cur, auto ? "submitted automatically for HOD approval" : "submitted for HOD approval", user, { from: row.status, to: "pending", note: `assigned to ${hod.display_name}${auto ? " (automatic assignment)" : ""}${note ? `: ${note}` : ""}`, hash: h });
    notify?.send(hod.id, { kind: "approval_pending", title: `Report ${cur.report_ref} is waiting for your approval`, body: `${auto ? "Submitted automatically by AIVS" : `Submitted by ${user.display_name}`} for Head of Department approval.`, link: linkOf(cur), ref: cur.report_ref });
    return state(kind, refId);
  }
  // the Head of Department decides; approval also produces the final PDF (render(approvalInfo) → Buffer) and stores it
  async function decide(user, kind, refId, a, { action, note = "" }, render, owners = {}) {
    if (!can(user, "report.hod")) throw new HttpError(403, "Only a Head of Department can approve, reject or return reports.");
    const row = getRow(kind, refId); if (!row || row.status !== "pending") throw new HttpError(409, "The report is not waiting for HOD approval.");
    if (row.assigned_hod !== user.id) throw new HttpError(403, "This report is assigned to another Head of Department.");
    if ([row.submitted_by, row.created_by, owners.createdBy].includes(user.id)) throw new HttpError(403, "You cannot decide on a report you prepared or submitted.");
    if (contentHash(a) !== row.content_sha256) throw new HttpError(409, "The report changed after it was submitted. It must be submitted again.");
    note = String(note || "").trim().slice(0, 1000);
    const now = nowISO();
    if (action === "return" || action === "reject") {
      if (!note) throw new HttpError(400, action === "return" ? "Say what must be revised." : "Give the reason for rejecting the report.");
      const to = action === "return" ? "returned" : "rejected";
      db.prepare("UPDATE report_approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?").run(to, user.id, now, note, now, row.id);
      event(row, action === "return" ? "returned for revision" : "rejected", user, { from: "pending", to, note });
      notify?.send([row.submitted_by, row.created_by], { kind: `approval_${to}`, title: `Report ${row.report_ref} was ${action === "return" ? "returned for revision" : "rejected"} by the Head of Department`, body: note, link: linkOf(row), ref: row.report_ref });
      return state(kind, refId);
    }
    if (action !== "approve") throw new HttpError(400, "Choose approve, return or reject.");
    const u = db.prepare("SELECT display_name, designation FROM users WHERE id = ?").get(user.id);
    const day = new Date(Date.parse(now) + 3 * 3600e3).toISOString().slice(0, 10); // the approval date in East Africa Time
    const n = db.prepare("INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get(`apr-${day}`).value;
    const ref = `APR-${day.replace(/-/g, "")}-${String(n).padStart(3, "0")}`, code = codeFor(ref, row.content_sha256, now);
    const ap = { approved: true, status: "approved", label: "Approved", name: u.display_name, designation: u.designation || "Head of Department", at: now, at_text: eat(now), ref, code, verify_path: "/verify-report" };
    const pdf = await render(ap); const stored = await storage.putBuffer(pdf, "application/pdf");
    db.prepare("UPDATE report_approvals SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, approval_ref = ?, approved_sha256 = ?, pdf_sha256 = ?, verify_code = ?, approver_name = ?, approver_designation = ?, updated_at = ? WHERE id = ?")
      .run(user.id, now, note || null, ref, row.content_sha256, stored.sha256, code, ap.name, ap.designation, now, row.id);
    event(getRow(kind, refId), "approved by the Head of Department", user, { from: "pending", to: "approved", note: `${ref}${note ? `: ${note}` : ""}` });
    notify?.send([row.submitted_by, row.created_by], { kind: "approval_approved", title: `Report ${row.report_ref} was approved by ${u.display_name}`, body: `Approval reference ${ref}. The final approved PDF is available.`, link: linkOf(row), ref: row.report_ref });
    return state(kind, refId);
  }
  // a material change (the analyst edits the report, or the investigation is re-run): back to draft; an approval stops counting
  function changed(user, kind, refId, a, reason) {
    const row = getRow(kind, refId); if (!row) return null;
    const h = contentHash(a); if (h === row.content_sha256 && row.status !== "approved") return state(kind, refId);
    if (row.status === "approved" && h === row.approved_sha256) return state(kind, refId);
    const from = row.status, to = ["pending", "approved"].includes(from) ? "draft" : from === "rejected" ? "rejected" : from;
    db.prepare("UPDATE report_approvals SET status = ?, version = version + 1, content_sha256 = ?, updated_at = ? WHERE id = ?").run(to, h, nowISO(), row.id);
    const cur = getRow(kind, refId); snapshot(cur, a, user, reason);
    event(cur, from === "approved" ? "approval invalidated by a material change" : from === "pending" ? "withdrawn from approval by a material change" : "revised", user, { from, to, note: reason, hash: h });
    return state(kind, refId);
  }
  function state(kind, refId) {
    const r = getRow(kind, refId); if (!r) return { status: "draft", label: STATUS_LABEL.draft, events: [], versions: [] };
    return { id: r.id, kind: r.kind, ref_id: r.ref_id, report_ref: r.report_ref, status: r.status, label: STATUS_LABEL[r.status], version: r.version, content_sha256: r.content_sha256,
      submitted_by: userName(r.submitted_by)?.display_name || null, submitted_by_id: r.submitted_by, submitted_at: r.submitted_at, submit_note: r.submit_note,
      assigned_hod: r.assigned_hod, assigned_hod_name: userName(r.assigned_hod)?.display_name || null, decided_by: userName(r.decided_by)?.display_name || null, decided_at: r.decided_at, decision_note: r.decision_note,
      approval_ref: r.approval_ref, approver_name: r.approver_name, approver_designation: r.approver_designation, pdf_sha256: r.pdf_sha256,
      events: db.prepare("SELECT action, from_status, to_status, version, by_name, at, note, hash FROM report_approval_events WHERE approval_id = ? ORDER BY id").all(r.id),
      versions: db.prepare("SELECT version, content_sha256, changed_at, reason FROM report_versions WHERE approval_id = ? ORDER BY id").all(r.id) };
  }
  // the final approved PDF, exactly as stored at approval (only while the approval is current)
  function finalPdf(kind, refId, a) {
    const r = getRow(kind, refId); if (!r || r.status !== "approved" || !r.pdf_sha256 || (a && contentHash(a) !== r.approved_sha256)) return null;
    return storage.read(r.pdf_sha256);
  }
  // the approval dashboard: drafts, pending, approved, returned, rejected; each role sees what concerns it
  function list(user, { status = "" } = {}) {
    const w = [], P = [];
    if (status && STATUS_LABEL[status]) { w.push("a.status = ?"); P.push(status); }
    if (can(user, "report.hod") && !can(user, "users.manage") && !can(user, "report.submit")) { w.push("(a.assigned_hod = ? OR a.decided_by = ?)"); P.push(user.id, user.id); }
    else if (!can(user, "audit.read") && !can(user, "users.manage")) { w.push("(a.created_by = ? OR a.submitted_by = ?)"); P.push(user.id, user.id); }
    const rows = db.prepare(`SELECT a.*, cu.display_name created_by_name, su.display_name submitted_by_name, hu.display_name hod_name FROM report_approvals a LEFT JOIN users cu ON cu.id = a.created_by
      LEFT JOIN users su ON su.id = a.submitted_by LEFT JOIN users hu ON hu.id = a.assigned_hod ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY a.updated_at DESC LIMIT 300`).all(...P);
    const subj = r => r.kind === "investigation" ? db.prepare("SELECT subject, case_id FROM investigations WHERE id = ?").get(r.ref_id) : db.prepare("SELECT s.query subject FROM monitor_reports m LEFT JOIN monitor_searches s ON s.id = m.search_id WHERE m.id = ?").get(+r.ref_id);
    const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM report_approvals GROUP BY status").all().map(x => [x.status, x.n]));
    return { counts, reports: rows.map(r => ({ id: r.id, kind: r.kind, ref_id: r.ref_id, report_ref: r.report_ref, status: r.status, label: STATUS_LABEL[r.status], subject: subj(r)?.subject || null, analyst: r.submitted_by_name || r.created_by_name,
      hod: r.hod_name, submitted_at: r.submitted_at, decided_at: r.decided_at, approval_ref: r.approval_ref, version: r.version, can_decide: r.status === "pending" && r.assigned_hod === user.id && can(user, "report.hod") && ![r.created_by, r.submitted_by].includes(user.id) })) };
  }
  // public verification of a released PDF: only whether the code is genuine and current, never the content of the report
  function verify(ref, code) {
    const r = db.prepare("SELECT * FROM report_approvals WHERE approval_ref = ?").get(String(ref || "").trim().toUpperCase());
    const ok = !!r && r.verify_code && String(code || "").trim().toUpperCase() === r.verify_code && codeFor(r.approval_ref, r.approved_sha256, r.decided_at) === r.verify_code;
    if (!ok) return { valid: false, message: "No approved AIVS report matches this reference and verification code." };
    return { valid: r.status === "approved", approval_ref: r.approval_ref, report_ref: r.report_ref, status: r.status === "approved" ? "Approved and current" : "This approval is no longer valid: the report was revised after approval", approved_at: r.decided_at, approved_by: r.approver_name, designation: r.approver_designation };
  }
  // the hash chain of a report's approval events is intact (every event links to the one before)
  function chainIntact(kind, refId) {
    const r = getRow(kind, refId); if (!r) return true; let prev = "GENESIS";
    for (const e of db.prepare("SELECT * FROM report_approval_events WHERE approval_id = ? ORDER BY id").all(r.id)) {
      const rec = { approval_id: e.approval_id, action: e.action, from_status: e.from_status, to_status: e.to_status, version: e.version, content_sha256: e.content_sha256, by_user: e.by_user, by_name: e.by_name, at: e.at, note: e.note };
      if (e.prev_hash !== prev || sha(`${prev}|${JSON.stringify(rec)}`) !== e.hash) return false; prev = e.hash;
    }
    return true;
  }
  return { ensure, info, hods, submit, decide, changed, state, finalPdf, list, verify, chainIntact, STATUS_LABEL };
}

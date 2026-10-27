// In-app notifications (1.33): the assigned Head of Department is told when a report reaches the approval queue, the analyst
// when the HOD decides, and administrators when an investigation needs technical review. Nothing is sent outside AIVS.
import { nowISO } from "./db.js";
import { HttpError } from "./auth.js";

export function makeNotify(db) {
  const ins = db.prepare("INSERT INTO notifications(user_id,kind,title,body,link,ref,created_at) VALUES (?,?,?,?,?,?,?)");
  function send(userIds, { kind, title, body = null, link = null, ref = null }) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))], now = nowISO();
    for (const id of ids) ins.run(id, kind, String(title).slice(0, 200), body ? String(body).slice(0, 1000) : null, link, ref, now);
    return ids.length;
  }
  const admins = () => db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all().map(u => u.id);
  function list(user, { all = false, limit = 30 } = {}) {
    const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${all ? "" : "AND read_at IS NULL"} ORDER BY id DESC LIMIT ?`).all(user.id, Math.min(+limit || 30, 100));
    return { unread: db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(user.id).n, items: rows };
  }
  function read(user, id) {
    if (id === "all") { db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(nowISO(), user.id); return; }
    const r = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL").run(nowISO(), +id, user.id);
    if (!r.changes && !db.prepare("SELECT 1 FROM notifications WHERE id = ? AND user_id = ?").get(+id, user.id)) throw new HttpError(404, "No such notification.");
  }
  return { send, admins, list, read };
}

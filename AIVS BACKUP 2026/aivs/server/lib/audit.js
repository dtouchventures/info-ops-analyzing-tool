// Append-only, hash-chained audit log. Each entry's hash covers the previous hash, so any edit or
// deletion of an earlier row breaks verification (see verifyChain / `npm run verify-audit`).
import crypto from "node:crypto";
import { nowISO } from "./db.js";

const GENESIS = "0".repeat(64);
const digest = e => crypto.createHash("sha256").update([e.prev_hash, e.at, e.user_id ?? "", e.username ?? "", e.action, e.entity ?? "", e.entity_id ?? "", e.details ?? ""].join("␟")).digest("hex");

export function makeAudit(db) {
  const last = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const ins = db.prepare("INSERT INTO audit_log(at,user_id,username,action,entity,entity_id,details,prev_hash,hash) VALUES (@at,@user_id,@username,@action,@entity,@entity_id,@details,@prev_hash,@hash)");
  const write = db.transaction(e => { e.prev_hash = last.get()?.hash || GENESIS; e.hash = digest(e); ins.run(e); return e; });
  return function audit(user, action, entity = null, entityId = null, details = null) {
    return write({ at: nowISO(), user_id: user?.id ?? null, username: user?.username ?? "system", action, entity, entity_id: entityId, details: details == null ? null : typeof details === "string" ? details : JSON.stringify(details) });
  };
}

export function verifyChain(db) {
  let prev = GENESIS, n = 0;
  for (const e of db.prepare("SELECT * FROM audit_log ORDER BY id").iterate()) {
    if (e.prev_hash !== prev || digest(e) !== e.hash) return { ok: false, checked: n, brokenAt: e.id };
    prev = e.hash; n++;
  }
  return { ok: true, checked: n };
}

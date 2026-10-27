// Reset a user's password from the command line on the AIVS computer (for example when the only administrator is locked out).
// Usage:  npm run reset-password -- <username>
// A new one-time password is shown once in this window; the user must change it at the next sign-in.
// Existing sign-ins of that user are ended, and the reset is written to the audit log.
import crypto from "node:crypto";
import path from "node:path";
import { config } from "../server/config.js";
import { openDb } from "../server/lib/db.js";
import { makeAudit } from "../server/lib/audit.js";
import { hashPassword } from "../server/lib/auth.js";

const username = process.argv[2];
if (!username) { console.error("Usage: npm run reset-password -- <username>"); process.exit(1); }
const db = openDb(path.join(config.dataDir, "aivs.db"));
const u = db.prepare("SELECT id, username, role, active FROM users WHERE username = ? COLLATE NOCASE").get(username);
if (!u) {
  console.error(`No user called "${username}". Users: ${db.prepare("SELECT username FROM users ORDER BY id").all().map(x => x.username).join(", ")}`);
  process.exit(1);
}
const pw = crypto.randomBytes(9).toString("base64url") + "7";
db.transaction(() => {
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, active = 1 WHERE id = ?").run(hashPassword(pw), u.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
})();
makeAudit(db)(null, "Password reset from command line", "user", String(u.id), { username: u.username });
console.log(`\nPassword reset for ${u.username} (${u.role}).`);
console.log(`One-time password: ${pw}`);
console.log("Sign in with it now; AIVS will ask you to choose a new password. Do not share this window or a photo of it.\n");
db.close();

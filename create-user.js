// Usage: npm run create-user -- <username> "<Display Name>" <admin|reviewer|analyst|viewer>
import crypto from "node:crypto";
import path from "node:path";
import { config } from "../server/config.js";
import { openDb, nowISO } from "../server/lib/db.js";
import { makeAudit } from "../server/lib/audit.js";
import { hashPassword, ROLES } from "../server/lib/auth.js";
const [username, name, role] = process.argv.slice(2);
if (!username || !name || !ROLES.includes(role)) { console.error('Usage: npm run create-user -- <username> "<Display Name>" <admin|reviewer|analyst|viewer>'); process.exit(1); }
const db = openDb(path.join(config.dataDir, "aivs.db"));
const pw = crypto.randomBytes(9).toString("base64url") + "7";
db.prepare("INSERT INTO users(username,display_name,role,password_hash,must_change_password,created_at) VALUES (?,?,?,?,1,?)").run(username, name, role, hashPassword(pw), nowISO());
makeAudit(db)(null, "User created from command line", "user", username, { role });
console.log(`Created ${username} (${role}). Temporary password: ${pw}`);

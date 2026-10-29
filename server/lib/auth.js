// Passwords (scrypt), server-side sessions (hashed tokens in httpOnly cookies), role permissions.
import crypto from "node:crypto";
import { nowISO } from "./db.js";

export const ROLES = ["admin", "reviewer", "analyst", "hod", "viewer"];
export const ROLE_LABELS = { admin: "Administrator", reviewer: "Reviewer", analyst: "Analyst", hod: "Head of Department (report approval)", viewer: "Viewer (read-only)" };

// permission -> roles allowed. Case-level ownership rules are applied in canEditCase().
export const PERMISSIONS = {
  "case.read":       { roles: ["admin", "reviewer", "analyst", "hod", "viewer"], label: "View cases, evidence and reports" },
  "report.submit":   { roles: ["admin", "reviewer", "analyst"], label: "Review AIVS draft reports, revise them and submit them for Head of Department approval" },
  "report.hod":      { roles: ["hod"], label: "Approve, reject or return reports assigned to them (Head of Department; never their own reports). Administrators do not have this by default" },
  "case.create":     { roles: ["admin", "reviewer", "analyst"], label: "Create cases and upload media" },
  "case.edit":       { roles: ["admin", "reviewer", "analyst"], label: "Edit claims, evidence and findings (analysts: own or assigned cases)" },
  "case.assign":     { roles: ["admin", "reviewer"], label: "Assign cases to analysts" },
  "case.approve":    { roles: ["admin", "reviewer"], label: "Approve or return assessments (never their own analysis)" },
  "case.archive":    { roles: ["admin", "reviewer"], label: "Archive approved cases; open new revisions" },
  "note.write":      { roles: ["admin", "reviewer", "analyst"], label: "Write case notes for the team (internal, never in reports)" },
  "ai.request":      { roles: ["admin", "reviewer", "analyst"], label: "Send case content to the configured AI service" },
  "io.import":       { roles: ["admin", "reviewer", "analyst"], label: "Import and analyse post datasets in the information operations monitor" },
  "watch.manage":    { roles: ["admin", "reviewer"], label: "Create, preview, activate and pause mention watchlists (activating starts paid or quota-limited collection)" },
  "watch.keywords":  { roles: ["admin", "reviewer", "analyst"], label: "Add, edit, delete, enable and disable the keywords of watchlists (an active watchlist keeps running with the new keywords)" },
  "watch.triage":    { roles: ["admin", "reviewer", "analyst"], label: "Work the mention alert queue: acknowledge, dismiss, assign to self, convert to a case" },
  "archive.manage":  { roles: ["admin", "reviewer"], label: "Add and edit reference archive records" },
  "audit.read":      { roles: ["admin", "reviewer"], label: "Read the full audit log" },
  "users.manage":    { roles: ["admin"], label: "Manage user accounts and roles" },
  "settings.manage": { roles: ["admin"], label: "Manage settings, integrations and training data" }
};
export const can = (user, perm) => !!user && PERMISSIONS[perm]?.roles.includes(user.role);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = stored.split("$");
    if (alg !== "scrypt") return false;
    const k = Buffer.from(key, "base64");
    const d = crypto.scryptSync(pw, Buffer.from(salt, "base64"), k.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(d, k);
  } catch { return false; }
}
export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 12) return "Use at least 12 characters.";
  if (!/[a-z]/i.test(pw) || !/[0-9]/.test(pw)) return "Use both letters and numbers.";
  return null;
}
const sha = t => crypto.createHash("sha256").update(t).digest("hex");

export function makeSessions(db, config) {
  const COOKIE = "aivs_session";
  const getS = db.prepare("SELECT s.*, u.id AS uid, u.username, u.display_name, u.role, u.active, u.must_change_password, u.ui_mode, u.rank, u.appointment FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?");
  const touch = db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?");
  const del = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const cookieOpts = maxAge => `Path=/; HttpOnly; SameSite=Strict${config.cookieSecure ? "; Secure" : ""}; Max-Age=${maxAge}`;

  function create(res, user, req) {
    const token = crypto.randomBytes(32).toString("base64url"), now = new Date();
    const exp = new Date(now.getTime() + config.sessionHours * 3600e3);
    db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at,ip,user_agent) VALUES (?,?,?,?,?,?,?)")
      .run(sha(token), user.id, now.toISOString(), exp.toISOString(), now.toISOString(), req.ip, String(req.headers["user-agent"] || "").slice(0, 200));
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; ${cookieOpts(config.sessionHours * 3600)}`);
  }
  function tokenOf(req) { const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || ""); return m ? m[1] : null; }
  function destroy(req, res) { const t = tokenOf(req); if (t) del.run(sha(t)); res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieOpts(0)}`); }
  function load(req, _res, next) {
    const t = tokenOf(req);
    if (t) {
      const s = getS.get(sha(t));
      if (s && s.active && new Date(s.expires_at) > new Date()) {
        req.user = { id: s.uid, username: s.username, display_name: s.display_name, role: s.role, must_change_password: !!s.must_change_password, ui_mode: s.ui_mode || "guided", rank: s.rank || "", appointment: s.appointment || "" };
        if (Date.now() - new Date(s.last_seen_at).getTime() > 60e3) touch.run(nowISO(), s.token_hash);
      } else if (s) del.run(s.token_hash);
    }
    next();
  }
  return { create, destroy, load, revokeUser: uid => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(uid) };
}

// login throttling: 5 failures per username+IP in 15 minutes
const fails = new Map();
export function throttled(key) { const f = fails.get(key); return !!f && f.n >= 5 && Date.now() - f.t < 15 * 60e3; }
export function noteFailure(key) { const f = fails.get(key); if (!f || Date.now() - f.t > 15 * 60e3) fails.set(key, { n: 1, t: Date.now() }); else f.n++; }
export function clearFailures(key) { fails.delete(key); }

export class HttpError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
export const requireUser = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, "Please sign in."));
  if (req.user.must_change_password && !/^\/api\/(auth|me)/.test(req.originalUrl)) return next(new HttpError(403, "Change your temporary password before continuing."));
  next();
};
export const requirePerm = perm => (req, _res, next) => can(req.user, perm) ? next() : next(new HttpError(403, `Your role (${ROLE_LABELS[req.user?.role] || "none"}) cannot do this.`));

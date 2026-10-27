import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/lib/auth.js";
import { nowISO } from "../server/lib/db.js";

export const PW = "correct-horse-42";
export async function startServer(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-test-"));
  const config = { port: 0, host: "127.0.0.1", dataDir, cookieSecure: false, trustProxy: false, sessionHours: 2, maxUploadMb: 50, allowSelfApproval: false,
    ai: { provider: "", apiKey: "", model: "", baseUrl: "", timeoutMs: 5000, maxImages: 6 }, isTest: true, ...extra };
  const { app, ctx } = createApp(config);
  for (const [u, role] of [["admin", "admin"], ["rev", "reviewer"], ["rev2", "reviewer"], ["ana", "analyst"], ["ana2", "analyst"], ["view", "viewer"]])
    ctx.db.prepare("INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?)").run(u, u.toUpperCase(), role, hashPassword(PW), nowISO());
  const server = await new Promise(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, ctx, config, close: () => new Promise(ok => server.close(ok)), dataDir };
}
export async function login(base, username, password = PW) {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-aivs": "1" }, body: JSON.stringify({ username, password }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  const call = async (method, url, body, { form, headers = {} } = {}) => {
    // CPU-heavy checks share this process with the server and can outlive its keep-alive timeout.
    // Isolate requests so an expired socket cannot leak between otherwise independent checks.
    const opts = { method, headers: { cookie, "x-aivs": "1", connection: "close", ...headers } };
    if (form) opts.body = form; else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
    const res = await fetch(base + url, opts).catch(error => { throw new Error(`${method} ${url}: ${error.message}`, { cause: error }); }), ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : await res.text(), headers: res.headers };
  };
  return { status: r.status, cookie, get: u => call("GET", u), post: (u, b, o) => call("POST", u, b, o), patch: (u, b, o) => call("PATCH", u, b, o), put: (u, b) => call("PUT", u, b), del: u => call("DELETE", u) };
}
export const file = (p, name) => { const fd = new FormData(); fd.append("files", new Blob([fs.readFileSync(p)]), name || path.basename(p)); return fd; };
export const T = f => path.resolve("training", f);
// Re-open an existing data directory (simulates a server restart: same database and object store).
export async function reopenServer(dataDir, extra = {}) {
  const config = { port: 0, host: "127.0.0.1", dataDir, cookieSecure: false, trustProxy: false, sessionHours: 2, maxUploadMb: 50, allowSelfApproval: false,
    ai: { provider: "", apiKey: "", model: "", baseUrl: "", timeoutMs: 5000, maxImages: 6 }, isTest: true, ...extra };
  const { app, ctx } = createApp(config);
  const server = await new Promise(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, ctx, config, dataDir, close: () => new Promise(ok => { server.close(ok); }).then(() => ctx.db.close()) };
}

// Start the AIVS server. On first start with no accounts, a one-time administrator password is
// generated, printed once and written to data/FIRST-LOGIN.txt (delete the file after signing in).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { hashPassword } from "./lib/auth.js";
import { nowISO } from "./lib/db.js";

const { app, admin, ctx } = createApp(config);
const { db, audit } = ctx;
if (!db.prepare("SELECT COUNT(*) n FROM users").get().n) {
  const pw = crypto.randomBytes(9).toString("base64url") + "7";
  db.prepare("INSERT INTO users(username,display_name,role,password_hash,must_change_password,created_at) VALUES ('admin','Administrator','admin',?,1,?)").run(hashPassword(pw), nowISO());
  audit(null, "First administrator account created", "user", "admin");
  const f = path.join(config.dataDir, "FIRST-LOGIN.txt");
  fs.writeFileSync(f, `AIVS first sign-in\nUsername: admin\nTemporary password: ${pw}\nYou must choose a new password at first sign-in. Delete this file afterwards.\n`, { mode: 0o600 });
  console.log(`\n  FIRST RUN\n  Username: admin\n  Temporary password: ${pw}\n  (also saved in ${f}; you will choose a new password at first sign-in)\n`);
}
const url = `http://${config.host === "0.0.0.0" || config.host === "127.0.0.1" ? "localhost" : config.host}:${config.port}`;
// AIVS_OPEN_BROWSER=1 (set by start-windows.bat) opens the app once the server is actually listening
const openBrowser = () => { if (process.env.AIVS_OPEN_BROWSER !== "1") return; import("node:child_process").then(({ spawn }) => {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch {} }); };
const server = app.listen(config.port, config.host, () => {
  console.log(`AIVS running at ${url}  (keep this window open while you use it)`);
  // network mode: show (and save) the addresses other computers on the same network should open
  const netFile = path.join(path.dirname(config.dataDir), "network-address.txt");
  if (config.host === "0.0.0.0") {
    const addrs = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).filter(a => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")).map(a => ({ name, url: `http://${a.address}:${config.port}` })));
    console.log(addrs.length ? `\n  NETWORK MODE: reviewers on the same Wi-Fi or office network open\n${addrs.map(a => `     ${a.url}    (${a.name})`).join("\n")}\n  Only use this on a trusted private network.\n` : "\n  NETWORK MODE: no network connection found. Connect to Wi-Fi and restart.\n");
    try { fs.writeFileSync(netFile, `AIVS network addresses (${new Date().toISOString()})\n${addrs.map(a => `${a.url}  (${a.name})`).join("\n") || "none found"}\n`); } catch {}
  } else { try { fs.rmSync(netFile, { force: true }); } catch {} }
  openBrowser();
  console.log(`Data directory: ${config.dataDir}`);
  admin.schedule();
  ctx.transcriber.resume();
  ctx.watchCollector.start();
  ctx.live.start();
  // the default KDF watchlist is created once (then edited from the dashboard); AI analysis of discovered items runs from a queue
  // that waits while the Ollama server cannot be reached; emerging topics are checked every 10 minutes
  try { const d = ctx.keywords.ensureDefault(ctx.live.systemUser()); if (d) console.log(`  Default watchlist “KDF and Kenya Defence Forces Monitoring”: ${d.status}`); } catch (e) { console.warn("[monitor] default watchlist:", e.message); }
  setInterval(() => ctx.keywords.aiTick().catch(e => console.warn("[monitor] AI queue:", e.message)), 60e3).unref();
  setInterval(() => { try { ctx.keywords.emergingTick(); } catch (e) { console.warn("[monitor] emerging topics:", e.message); } }, 10 * 60e3).unref();
  // a daily draft monitoring report for each active watchlist with new items (07:00 EAT by default)
  setInterval(() => ctx.keywords.daily(ctx.live.systemUser(), Number(process.env.MONITOR_DAILY_REPORT_HOUR || 7)).catch(e => console.warn("[monitor] daily report:", e.message)), 10 * 60e3).unref();
  { const o = ctx.live.overview(); console.log(`  Live Facebook monitoring: ${o.facebook.configured ? `${o.sources.filter(x => x.platform === "facebook" && x.enabled).length} Page(s), every ${o.scheduler.interval_minutes} min` : "off (META_PAGE_ACCESS_TOKEN not set)"} · Instagram: ${o.instagram.status}`); }
  { const w = ctx.watchCollector.status(), act = ctx.watch.list().filter(x => x.status === "active").length; console.log(`  Mention watch: ${act} active watchlist(s); X search ${w.sources.find(s => s.key === "x_search").state}, X stream ${w.sources.find(s => s.key === "x_stream").state}, YouTube ${w.sources.find(s => s.key === "youtube").state}`); }
  if (config.transcribe?.url) ctx.transcriber.checkHealth({ force: true }).then(h => console.log(`  Speech-to-text: ${h.state === "ok" ? `available (${h.engine} ${h.model}, ${h.cpu_threads} threads)` : h.state}${h.error ? ` — ${h.error}` : ""}`)).catch(() => {});
  if (config.ai.provider) {
    const say = h => console.log(`  AI (${config.ai.provider}, ${config.ai.model}): ${h.state === "ok" ? `available, answered in ${h.latency_ms} ms` : h.state}${h.error ? ` — ${h.error}` : ""}`);
    ctx.ai.health({ force: true }).then(say).catch(() => {});
    // while the AI is unreachable, check again every 2 minutes and say so when it answers
    let last = null;
    setInterval(() => { const st = ctx.ai.status().health?.state; if (st === "ok" && last === "ok") return; ctx.ai.health({ force: st !== "ok" }).then(h => { if (h.state !== last && (h.state === "ok" || last === "ok")) say(h); last = h.state; }).catch(() => {}); }, 120e3).unref();
  }
  if (!config.backupDisabled) console.log(`Backups: daily, kept in ${admin.backupDir()}`);
  const ai = ctx.ai.status();
  console.log(ai.configured ? `AI assistance: ${ai.provider} / ${ai.model}` : `AI assistance: ${ai.reason}`);
});
server.on("error", e => {
  if (e.code === "EADDRINUSE") { console.log(`\n  Port ${config.port} is already in use. If AIVS is already running, use ${url}.\n  Otherwise set PORT=8090 (or another free port) in a .env file and start again.\n`); openBrowser(); }
  else console.error("AIVS could not start:", e.message);
  process.exitCode = 1;
});

// Live check of Facebook monitoring with the REAL Meta Graph API and the settings in your .env (META_PAGE_ACCESS_TOKEN,
// META_PAGE_IDS, and the evidence and AI services). It starts a temporary, separate copy of AIVS with an empty
// database in a temporary folder (your real cases, posts and reports are not touched), then checks the ten points:
//   1 the Meta connection authenticates          6 a watchlist match creates an alert
//   2 real posts are retrieved                   7 verification results keep their evidence
//   3 new posts are saved                        8 reports are generated and exported (PDF one page, Word, HTML)
//   4 duplicate posts are ignored                9 API failures are handled safely (refused token, unreachable server)
//   5 AI analysis runs automatically            10 the dashboard figures equal the database
// Nothing is simulated: every post comes from Meta. The token is never printed.
// Usage:  npm run check:facebook            Results: on screen, in data/facebook-check.txt, reports in data/facebook-check/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT } from "../server/config.js";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/lib/auth.js";
import { nowISO } from "../server/lib/db.js";
import { makeLiveMonitor } from "../server/lib/livemonitor.js";

const lines = [], log = s => { console.log(s); lines.push(s); }, res = [];
const check = (name, pass, detail = "") => { res.push(pass); log(`  ${pass === null ? "N/A " : pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
const T = config.live?.pageToken || "";
const safe = s => String(s ?? "").split(T || "\u0000").join("[token]");
log(`AIVS live Facebook monitoring check ${nowISO()} (version ${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version}; Graph API ${config.live.graphVersion})`);
if (!T || !config.live.pageIds) { log("META_PAGE_ACCESS_TOKEN and META_PAGE_IDS must both be set in the .env file (see .env.example). Nothing was checked."); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-fb-check-")), out = path.join(config.dataDir, "facebook-check");
fs.mkdirSync(out, { recursive: true });
const { app, ctx } = createApp({ ...config, dataDir: tmp, backupDisabled: true, port: 0, host: "127.0.0.1", live: { ...config.live, tickSeconds: 3600 }, watch: { ...config.watch, enabled: false } });
ctx.db.prepare("INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?)").run("fb-check", "Facebook check", "reviewer", hashPassword("fb-check-temporary-1"), nowISO());
const server = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";
const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { cookie, "x-aivs": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
cookie = ((await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-aivs": "1" }, body: JSON.stringify({ username: "fb-check", password: "fb-check-temporary-1" }) })).headers.get("set-cookie") || "").split(";")[0];
const L = ctx.live, db = ctx.db;
try {
  L.ensureSources();
  const sources = db.prepare("SELECT * FROM social_sources WHERE platform = 'facebook'").all();
  log(`Pages to read: ${sources.map(s => s.external_id).join(", ")}`);
  // 1
  const tok = await L.checkToken({ force: true });
  check("1 Meta connection authenticates and can read the Page(s)", tok.state === "valid" && tok.page_ok !== false, tok.state === "valid" ? `token belongs to “${tok.subject_name}” (${tok.subject_id}); ${(tok.pages || []).map(p => `${p.name || p.page_id}: ${p.ok ? "readable" : "NOT readable"} (${p.how})`).join("; ")}; expiry ${tok.expiry_known ? tok.expires_at : "not known (set META_APP_ID and META_APP_SECRET to read it)"}${tok.scopes ? `; permissions ${tok.scopes.join(", ")}` : ""}` : safe(tok.error || tok.needs));
  if (tok.page_ok === false) log("      To fix: run  npm run meta:token  (it turns a manager's token into the Page's token and saves it in .env), or generate a Page access token in Graph API Explorer.");
  // 2 and 3
  const first = [];
  for (const s of sources) first.push({ s, r: await L.sync(s.id, { kind: "manual" }) });
  const fetched = first.reduce((a, x) => a + (x.r.fetched || 0), 0), saved = db.prepare("SELECT COUNT(*) n FROM social_posts").get().n;
  check("2 real Facebook posts are retrieved", fetched > 0, first.map(x => x.r.error ? `${x.s.external_id}: ${safe(x.r.error)}` : `${x.s.external_id}: ${x.r.fetched} post(s)${x.r.note ? ` (${x.r.note})` : ""}`).join("; "));
  check("3 new posts are saved in the database", saved > 0 && saved === first.reduce((a, x) => a + (x.r.new_posts || 0), 0), `${saved} stored; ${db.prepare("SELECT COUNT(*) n FROM social_posts WHERE image_sha256 IS NOT NULL").get().n} image(s) stored; engagement ${db.prepare("SELECT fields_level f FROM social_sources LIMIT 1").get()?.f === "basic" ? "not available with this token (basic fields)" : "counts read"}`);
  for (const p of db.prepare("SELECT post_id, created_time, substr(coalesce(message,''),1,90) m FROM social_posts ORDER BY created_time DESC LIMIT 5").all()) log(`      ${p.created_time}  ${p.post_id}  ${p.m.replace(/\s+/g, " ")}`);
  // 6 (set up before the second run, which also checks that existing posts are not matched twice)
  const words = new Map(); for (const p of db.prepare("SELECT message FROM social_posts WHERE message IS NOT NULL").all()) for (const w of new Set(p.message.toLowerCase().match(/\p{L}{6,}/gu) || [])) words.set(w, (words.get(w) || 0) + 1);
  const term = [...words.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  let wlId = null;
  if (term) { wlId = (await call("POST", "/api/watch/lists", { name: "Facebook check (temporary)", definition: { terms: [term], sources: ["fb_live"], alert_mode: "every_post" }, authorisation: "Own Page, Page access token (check run)" })).body.id;
    await call("POST", `/api/watch/lists/${wlId}/preview`, {}); await call("POST", `/api/watch/lists/${wlId}/status`, { status: "active" }); }
  // 4: a second run reads the same posts again; none may be stored twice. The newest stored post is removed first so the run has one real new post to match.
  const newest = db.prepare("SELECT id FROM social_posts WHERE message LIKE ? ORDER BY created_time DESC LIMIT 1").get(`%${term || ""}%`);
  if (newest) { db.prepare("DELETE FROM live_alert_events WHERE alert_id IN (SELECT id FROM live_alerts WHERE post_id = ?)").run(newest.id); db.prepare("DELETE FROM live_alerts WHERE post_id = ?").run(newest.id); db.prepare("DELETE FROM social_post_metrics WHERE post_id = ?").run(newest.id); db.prepare("DELETE FROM social_posts WHERE id = ?").run(newest.id); db.prepare("UPDATE social_sources SET checkpoint_time = NULL").run(); }
  const second = []; for (const s of sources) second.push(await L.sync(s.id, { kind: "manual" }));
  const dup = second.reduce((a, r) => a + (r.duplicates || 0), 0), again = second.reduce((a, r) => a + (r.new_posts || 0), 0);
  check("4 duplicate posts are ignored", dup > 0 && db.prepare("SELECT COUNT(*) n FROM social_posts").get().n === saved && again === (newest ? 1 : 0), `${dup} post(s) already stored were skipped; ${again} new`);
  const wa = wlId ? (await call("GET", "/api/watch/alerts?limit=50")).body.alerts.filter(a => a.watchlist_id === wlId) : [];
  check("6 a watchlist match creates an alert", term ? wa.length > 0 : null, term ? `term “${term}” (taken from the collected posts): ${wa.length} alert(s)` : "no post text to build a term from");
  // 5 and 7
  const t0 = Date.now();
  for (;;) { await L.work(); const busy = db.prepare("SELECT COUNT(*) n FROM social_posts WHERE analysis_status IN ('pending','analysing','verifying')").get().n; if ((!busy && ctx.investigations.idle()) || Date.now() - t0 > 30 * 60e3) break; await new Promise(r => setTimeout(r, 3000)); }
  const st = Object.fromEntries(db.prepare("SELECT analysis_status s, COUNT(*) n FROM social_posts GROUP BY s").all().map(r => [r.s, r.n]));
  const invs = db.prepare("SELECT result_json FROM investigations WHERE status = 'done' AND origin = 'live'").all().map(r => JSON.parse(r.result_json));
  check("5 AI analysis runs automatically on every new post", (st.done || 0) + (st.skipped || 0) === db.prepare("SELECT COUNT(*) n FROM social_posts").get().n, `${JSON.stringify(st)} in ${Math.round((Date.now() - t0) / 1000)} s; AI model ${invs.some(r => r.ai?.used) ? `used (${invs.find(r => r.ai?.used).ai.model})` : `not used (${invs[0]?.ai?.reason || "no AI configured"}): rule-based analysis only`}`);
  const ver = Object.fromEntries(db.prepare("SELECT coalesce(verification,'pending') v, COUNT(*) n FROM social_posts GROUP BY v").all().map(r => [r.v, r.n]));
  const ev = invs.reduce((a, r) => a + r.evidence.length, 0), withEv = db.prepare("SELECT COUNT(*) n FROM evidence e JOIN investigations i ON i.case_id = e.case_id WHERE i.origin = 'live'").get().n;
  check("7 verification results keep their evidence", invs.length && ev ? withEv >= ev : null, `${invs.length} investigation(s); statuses ${JSON.stringify(ver)}; ${ev} evidence item(s) compared, ${withEv} kept with the cases; sources searched: ${[...new Set(invs.flatMap(r => r.search.filter(s => s.status === "ok" || s.status === "partial").map(s => s.label)))].join(", ") || "none"}`);
  // 8
  const one = db.prepare("SELECT id, report_id FROM investigations WHERE status = 'done' AND origin = 'live' ORDER BY completed_at DESC LIMIT 1").get();
  if (one) {
    const pdf = await call("GET", `/api/investigations/${one.id}/report.pdf`), docx = await call("GET", `/api/investigations/${one.id}/report.docx`), html = await call("GET", `/api/investigations/${one.id}/report.html`);
    const pages = (pdf.body.toString("latin1").match(/\/Type \/Page\b/g) || []).length; fs.writeFileSync(path.join(out, `${one.report_id}-assessment.pdf`), pdf.body);
    check("8 reports are generated and exported", pdf.status === 200 && pages === 1 && docx.status === 200 && html.status === 200, `${one.report_id}: PDF ${pages} page(s), Word ${docx.body.length} bytes, HTML ${html.body.length} bytes`);
  } else check("8 reports are generated and exported", false, "no investigation finished");
  // 9
  const bad = makeLiveMonitor(db, { config: { ...config, live: { ...config.live, pageToken: "INVALID-TOKEN-FOR-THE-CHECK-0000" } }, investigations: ctx.investigations, watch: ctx.watch, storage: ctx.storage, audit: ctx.audit });
  const br = await bad.sync(sources[0].id, { kind: "manual" });
  const down = makeLiveMonitor(db, { config: { ...config, live: { ...config.live, graphBase: "http://127.0.0.1:9", timeoutMs: 3000 } }, investigations: ctx.investigations, watch: ctx.watch, storage: ctx.storage, audit: ctx.audit });
  db.prepare("UPDATE social_sources SET backoff_until = NULL WHERE id = ?").run(sources[0].id); const nr = await down.sync(sources[0].id, { kind: "manual" });
  const leak = JSON.stringify([db.prepare("SELECT * FROM social_api_errors").all(), db.prepare("SELECT * FROM social_syncs").all(), db.prepare("SELECT * FROM audit_log").all(), db.prepare("SELECT * FROM live_alerts").all()]).includes(T);
  check("9 API failures are handled safely", br.kind === "token" && nr.kind === "network" && !leak, `refused token: ${br.kind} (“${safe(br.error).slice(0, 120)}”); unreachable server: ${nr.kind}; token found in stored records: ${leak ? "YES" : "no"}`);
  db.prepare("UPDATE social_sources SET status = 'ok', backoff_until = NULL, failures = 0").run(); await L.checkToken({ force: true });
  // 10
  const ov = (await call("GET", "/api/live/overview")).body, n = sql => db.prepare(sql).get().n;
  const same = ov.counts.total_posts === n("SELECT COUNT(*) n FROM social_posts WHERE is_training = 0") && ov.counts.completed_reports === n("SELECT COUNT(*) n FROM investigations WHERE is_training = 0 AND status = 'done'") && ov.counts.awaiting_analysis === n("SELECT COUNT(*) n FROM social_posts WHERE analysis_status IN ('pending','analysing','verifying')");
  check("10 the dashboard shows the database figures", same, `posts ${ov.counts.total_posts}, today ${ov.counts.posts_today}, awaiting ${ov.counts.awaiting_analysis}, analysed ${ov.counts.completed_analyses}, alerts ${ov.counts.new_alerts}, reports ${ov.counts.completed_reports}; connection: ${ov.facebook.connection.label}`);
  log(`Instagram: ${ov.instagram.status} (${ov.instagram.reason || ""})`);
} catch (e) { check("the check ran to the end", false, safe(e.stack || e.message)); }
const passed = res.filter(x => x === true).length, failed = res.filter(x => x === false).length;
log(`\n${passed} passed, ${failed} failed, ${res.filter(x => x === null).length} not applicable.`);
log(`Reports: ${out}`);
fs.writeFileSync(path.join(config.dataDir, "facebook-check.txt"), lines.join("\n"));
await ctx.investigations.close(); server.close(); ctx.db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

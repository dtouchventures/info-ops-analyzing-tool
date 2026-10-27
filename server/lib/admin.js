// Administration: usage and estimated cost of external services, storage figures, recent failures, backups
// (consistent SQLite snapshot + content-addressed file store, kept on this computer) and retention review.
// Nothing is deleted without an administrator's explicit choice, and every deletion is audited.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HttpError } from "./auth.js";
import { nowISO } from "./db.js";

const dirSize = dir => { let n = 0, files = 0; const walk = d => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { n += fs.statSync(p).size; files++; } catch {} } } }; walk(dir); return { bytes: n, files }; };
const SERVICE = { factcheck: "Google Fact Check Tools", web: "Brave web search", official: "Brave (official sources)", gemini: "Google Gemini", ollama: "Ollama (local)", anthropic: "Anthropic", openai: "OpenAI-compatible", mock: "Test AI double", x_embed: "X public embed", youtube_embed: "YouTube public embed", tiktok_embed: "TikTok public embed", telegram_embed: "Telegram post preview", meta_embed: "Meta oEmbed (Facebook/Instagram)" };

export function makeAdmin(db, { config, audit, storage }) {
  const setting = (k, d) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value ?? d;
  const setSetting = (k, v) => db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));

  // ---------------------------------------------------------------- usage, storage, failures
  function usage({ days = 90 } = {}) {
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const byService = db.prepare(`SELECT service, COUNT(*) calls, SUM(status = 'ok') ok, SUM(status != 'ok') failed, ROUND(SUM(COALESCE(est_cost_usd,0)),4) cost, MAX(at) last FROM api_usage WHERE at >= ? GROUP BY service ORDER BY calls DESC`).all(since).map(r => ({ ...r, label: SERVICE[r.service] || r.service }));
    const byMonth = db.prepare(`SELECT substr(at,1,7) month, service, COUNT(*) calls, ROUND(SUM(COALESCE(est_cost_usd,0)),4) cost FROM api_usage WHERE at >= ? GROUP BY month, service ORDER BY month`).all(since);
    const failures = [
      ...db.prepare("SELECT at, 'Evidence search' AS what, connector AS detail, error FROM retrievals WHERE status != 'ok' ORDER BY id DESC LIMIT 15").all(),
      ...db.prepare("SELECT at, 'Research assistant' AS what, provider AS detail, error FROM assistant_messages WHERE status = 'error' ORDER BY id DESC LIMIT 15").all(),
      ...db.prepare("SELECT started_at AS at, 'AI assistance' AS what, provider AS detail, COALESCE(error, validation_errors) AS error FROM ai_runs WHERE status IN ('failed','rejected') ORDER BY started_at DESC LIMIT 15").all(),
      ...db.prepare("SELECT updated_at AS at, 'Case analysis' AS what, id AS detail, analysis_error AS error FROM cases WHERE status = 'analysis_failed' ORDER BY updated_at DESC LIMIT 15").all()
    ].filter(f => f.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 25);
    return { days, byService, byMonth, failures, note: "Costs are estimates from the per-request prices configured on the server (for example BRAVE_USD_PER_REQUEST). Free services show 0. Check the provider's own billing page for the real figure." };
  }
  function storageInfo() {
    const dbFiles = ["aivs.db", "aivs.db-wal"].map(f => { try { return fs.statSync(path.join(config.dataDir, f)).size; } catch { return 0; } }).reduce((a, b) => a + b, 0);
    const objects = dirSize(path.join(config.dataDir, "objects")), backups = dirSize(backupDir());
    const n = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    return { database_bytes: dbFiles, files_bytes: objects.bytes, files: objects.files, backups_bytes: backups.bytes, backup_dir: backupDir(),
      counts: { cases: n("cases"), media: n("media"), evidence: n("evidence"), reports: n("reports"), users: n("users"), audit_entries: n("audit_log"), io_datasets: n("io_datasets"), io_posts: n("io_posts"), kb_datasets: n("kb_datasets"), kb_records: n("kb_records"), assistant_messages: n("assistant_messages") } };
  }

  // ---------------------------------------------------------------- backups
  function backupDir() { return config.backupDir || path.join(path.dirname(config.dataDir), "backups"); }
  const keep = () => Math.max(1, Number(setting("backup_keep", config.backupKeep || 7)) || 7);
  function listBackups() {
    const d = backupDir(); if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter(n => /^aivs-\d{8}-\d{6}$/.test(n)).sort().reverse().map(n => {
      let m = {}; try { m = JSON.parse(fs.readFileSync(path.join(d, n, "manifest.json"), "utf8")); } catch {}
      return { name: n, ...m };
    });
  }
  let running = null;
  async function backupNow(user, reason = "manual") {
    if (running) return running;
    running = (async () => {
      const d = backupDir(), stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15), dir = path.join(d, `aivs-${stamp}`), store = path.join(d, "objects");
      fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(store, { recursive: true });
      const t0 = Date.now();
      await db.backup(path.join(dir, "aivs.db"));                       // consistent snapshot while AIVS keeps running
      // files are content-addressed and never change: copy each once into a shared store used by every backup
      let copied = 0, present = 0;
      for (const { sha256 } of db.prepare("SELECT sha256 FROM objects").all()) {
        const src = storage.pathOf(sha256), dest = path.join(store, sha256.slice(0, 2), sha256);
        if (fs.existsSync(dest)) { present++; continue; }
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); copied++;
      }
      const dbSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "aivs.db"))).digest("hex");
      const manifest = { created_at: nowISO(), reason, by: user?.username || "scheduled", database_sha256: dbSha, database_bytes: fs.statSync(path.join(dir, "aivs.db")).size, files_copied: copied, files_already_backed_up: present, duration_ms: Date.now() - t0,
        restore: "Stop AIVS. Rename the current data folder (keep it). Create a new data folder, copy aivs.db from this backup into it, and copy the backups/objects folder to data/objects arranged as objects/ab/cd/<sha256> (see README, Backups). Start AIVS." };
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
      const all = listBackups(); for (const old of all.slice(keep())) fs.rmSync(path.join(d, old.name), { recursive: true, force: true });   // keep the newest N snapshots
      setSetting("backup_last", manifest.created_at);
      audit(user || null, "Backup created", "backup", path.basename(dir), { reason, database_sha256: dbSha, files_copied: copied, kept: keep() });
      return { name: path.basename(dir), ...manifest };
    })();
    try { return await running; } finally { running = null; }
  }
  let timer = null;
  function schedule() {
    if (config.backupDisabled || config.isTest) return;
    const check = () => { const last = setting("backup_last", null); if (!last || Date.now() - Date.parse(last) > 24 * 3600e3) backupNow(null, "daily").catch(e => console.error("Backup failed:", e.message)); };
    setTimeout(check, 60e3).unref?.(); timer = setInterval(check, 3 * 3600e3); timer.unref?.();
  }

  // ---------------------------------------------------------------- retention (review, then explicit deletion)
  const RET = { io_days: ["retention_io_days", "Post datasets in the IO monitor"], assistant_days: ["retention_assistant_days", "Research assistant conversations"], watch_days: ["retention_watch_days", "Mention watch posts (except posts behind open alerts or alerts turned into cases)"] };
  function retention() {
    const s = Object.fromEntries(Object.entries(RET).map(([k, [key]]) => [k, Number(setting(key, 0)) || 0]));
    const cutoff = d => new Date(Date.now() - d * 864e5).toISOString();
    const due = {
      io: s.io_days ? db.prepare("SELECT id, name, posts, imported_at FROM io_datasets WHERE imported_at < ? ORDER BY imported_at").all(cutoff(s.io_days)) : [],
      assistant: s.assistant_days ? db.prepare("SELECT case_id, COUNT(*) messages, MAX(at) last FROM assistant_messages GROUP BY case_id HAVING MAX(at) < ? ORDER BY last").all(cutoff(s.assistant_days)) : [],
      // mention watch: posts first detected before the cutoff, unless an open alert or a case depends on them
      watch: s.watch_days ? db.prepare(`SELECT COUNT(*) n, MIN(first_detected_at) oldest FROM watch_posts p WHERE first_detected_at < ? AND NOT EXISTS (SELECT 1 FROM watch_alerts a WHERE a.status IN ('new','acknowledged','converted') AND a.post_id = p.id) AND NOT EXISTS (SELECT 1 FROM watch_alerts a, json_each(a.detail_json, '$.post_ids') j WHERE a.kind = 'repeated' AND a.status IN ('new','acknowledged','converted') AND j.value = p.id)`).get(cutoff(s.watch_days)) : { n: 0 },
      tmp_files: (() => { try { return fs.readdirSync(storage.tmpDir).filter(f => Date.now() - fs.statSync(path.join(storage.tmpDir, f)).mtimeMs > 864e5).length; } catch { return 0; } })()
    };
    return { settings: s, labels: Object.fromEntries(Object.entries(RET).map(([k, [, l]]) => [k, l])), due,
      note: "Cases, evidence, reports and the audit log are never deleted by retention: they are the record of what was decided and why. 0 days means keep indefinitely." };
  }
  function setRetention(user, b) {
    for (const [k, [key]] of Object.entries(RET)) if (b[k] !== undefined) { const v = Math.max(0, Math.min(3650, Math.floor(Number(b[k]) || 0))); setSetting(key, v); }
    if (b.backup_keep !== undefined) setSetting("backup_keep", Math.max(1, Math.min(60, Math.floor(Number(b.backup_keep) || 7))));
    audit(user, "Retention settings changed", "settings", "retention", b);
  }
  function applyRetention(user, { io_ids = [], assistant_case_ids = [], tmp = false, watch = false }) {
    const r = retention(), okIo = new Set(r.due.io.map(x => x.id)), okA = new Set(r.due.assistant.map(x => x.case_id)), out = { io: 0, assistant: 0, tmp: 0, watch: 0 };
    if (watch && r.settings.watch_days) db.transaction(() => {
      const cutoff = new Date(Date.now() - r.settings.watch_days * 864e5).toISOString();
      const ids = db.prepare(`SELECT id FROM watch_posts p WHERE first_detected_at < ? AND NOT EXISTS (SELECT 1 FROM watch_alerts a WHERE a.status IN ('new','acknowledged','converted') AND a.post_id = p.id) AND NOT EXISTS (SELECT 1 FROM watch_alerts a, json_each(a.detail_json, '$.post_ids') j WHERE a.kind = 'repeated' AND a.status IN ('new','acknowledged','converted') AND j.value = p.id)`).all(cutoff).map(x => x.id);
      for (const id of ids) {
        for (const a of db.prepare("SELECT id FROM watch_alerts WHERE post_id = ?").all(id)) { db.prepare("DELETE FROM watch_alert_events WHERE alert_id = ?").run(a.id); db.prepare("DELETE FROM watch_alerts WHERE id = ?").run(a.id); }
        for (const t of ["watch_metrics", "watch_matches"]) db.prepare(`DELETE FROM ${t} WHERE post_id = ?`).run(id);
        db.prepare("DELETE FROM watch_posts WHERE id = ?").run(id); out.watch++;
      }
      if (out.watch) audit(user, "Retention: mention watch posts deleted", "settings", "retention", { posts: out.watch, older_than_days: r.settings.watch_days });
    })();
    for (const id of io_ids.map(Number)) { if (!okIo.has(id)) throw new HttpError(409, `Dataset ${id} is not past its retention period.`); }
    for (const id of assistant_case_ids) { if (!okA.has(id)) throw new HttpError(409, `The conversation on case ${id} is not past its retention period.`); }
    db.transaction(() => {
      for (const id of io_ids.map(Number)) { const d = db.prepare("SELECT name, posts FROM io_datasets WHERE id = ?").get(id); for (const t of ["io_posts", "io_topics", "io_claims"]) db.prepare(`DELETE FROM ${t} WHERE dataset_id = ?`).run(id); db.prepare("DELETE FROM io_datasets WHERE id = ?").run(id); out.io++; audit(user, `Retention: post dataset deleted: ${d.name}`, "io_dataset", String(id), { posts: d.posts }); }
      for (const id of assistant_case_ids) { const n = db.prepare("DELETE FROM assistant_messages WHERE case_id = ?").run(id).changes; out.assistant++; audit(user, "Retention: assistant conversation deleted", "case", id, { messages: n }); }
    })();
    if (tmp) { for (const f of fs.readdirSync(storage.tmpDir)) { const p = path.join(storage.tmpDir, f); try { if (Date.now() - fs.statSync(p).mtimeMs > 864e5) { fs.rmSync(p, { force: true, recursive: true }); out.tmp++; } } catch {} } if (out.tmp) audit(user, "Retention: temporary upload files removed", "settings", "retention", { files: out.tmp }); }
    return out;
  }
  return { usage, storageInfo, listBackups, backupNow, schedule, retention, setRetention, applyRetention, backupDir };
}

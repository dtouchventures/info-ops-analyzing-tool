// Administration (AIVS 1.9): usage and estimated cost, storage figures, backups (consistent, restorable, pruned)
// and retention (review first, explicit confirmation, audited; cases are never deleted).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { startServer, login, file, T } from "./helpers.js";

let S, admin, ana, bdir;
before(async () => { bdir = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-bk-")); S = await startServer({ backupDir: bdir }); [admin, ana] = await Promise.all([login(S.base, "admin"), login(S.base, "ana")]); });
after(async () => { await S.close(); });
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

test("usage and storage: per-service calls, failures and estimated cost; administrators only", async () => {
  const ins = S.ctx.db.prepare("INSERT INTO api_usage(at,service,operation,units,unit,est_cost_usd,status) VALUES (?,?,?,?,?,?,?)");
  ins.run(new Date().toISOString(), "web", "web/search", 1, "request", 0.005, "ok"); ins.run(new Date().toISOString(), "web", "web/search", 1, "request", 0.005, "error"); ins.run(new Date().toISOString(), "factcheck", "claims:search", 1, "request", 0, "ok");
  assert.equal((await ana.get("/api/admin/usage")).status, 403);
  const u = (await admin.get("/api/admin/usage")).body, web = u.byService.find(x => x.service === "web");
  assert.equal(web.calls, 2); assert.equal(web.failed, 1); assert.equal(web.cost, 0.01); assert.equal(web.label, "Brave web search");
  const st = (await admin.get("/api/admin/storage")).body; assert.ok(st.database_bytes > 0); assert.equal(st.backup_dir, bdir); assert.ok("cases" in st.counts);
});

test("backups: consistent database copy plus files, restorable, incremental, pruned to the newest N", async () => {
  const c = await ana.post("/api/cases", { claim_text: "Backup test case with a picture of a convoy." }); await ana.post(`/api/cases/${c.body.id}/media`, undefined, { form: file(T("images/case_convoy.jpg")) });
  const b1 = await admin.post("/api/admin/backups", {}); assert.equal(b1.status, 201, JSON.stringify(b1.body)); assert.ok(b1.body.files_copied >= 1);
  const snap = path.join(bdir, b1.body.name, "aivs.db"); assert.ok(fs.existsSync(snap));
  const copy = new Database(snap, { readonly: true }); assert.equal(copy.prepare("SELECT COUNT(*) n FROM cases WHERE id = ?").get(c.body.id).n, 1, "the case is in the backup");
  const sha = copy.prepare("SELECT sha256 FROM media WHERE case_id = ?").get(c.body.id).sha256; copy.close();
  assert.ok(fs.existsSync(path.join(bdir, "objects", sha.slice(0, 2), sha)), "the picture is in the backup's file store");
  await sleep(1100); const b2 = (await admin.post("/api/admin/backups", {})).body; assert.equal(b2.files_copied, 0, "files already backed up are not copied again");
  await admin.put("/api/admin/retention", { backup_keep: 2 }); await sleep(1100); await admin.post("/api/admin/backups", {});
  const list = (await admin.get("/api/admin/backups")).body.backups; assert.equal(list.length, 2, "only the newest 2 are kept"); assert.ok(!list.some(x => x.name === b1.body.name));
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'Backup created'").get().n >= 3);
  assert.equal((await ana.post("/api/admin/backups", {})).status, 403);
});

test("retention: lists what is past its period; deletes only on explicit confirmation; audited", async () => {
  const fd = new FormData(); fd.append("file", new Blob(["account,posted_at,text\na,2026-01-01T00:00:00Z,some words here today\n"]), "p.csv"); for (const [k, v] of Object.entries({ name: "Old posts", source: "test", authorisation: "test" })) fd.append(k, v);
  const io = (await ana.post("/api/io/datasets", undefined, { form: fd })).body.id;
  const fresh = (await (async () => { const f2 = new FormData(); f2.append("file", new Blob(["account,posted_at,text\nb,2026-01-01T00:00:00Z,other words here today\n"]), "q.csv"); for (const [k, v] of Object.entries({ name: "New posts", source: "test", authorisation: "test" })) f2.append(k, v); return ana.post("/api/io/datasets", undefined, { form: f2 }); })()).body.id;
  S.ctx.db.prepare("UPDATE io_datasets SET imported_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 864e5).toISOString(), io);
  let r = (await admin.get("/api/admin/retention")).body; assert.equal(r.due.io.length, 0, "0 days means keep indefinitely");
  r = (await admin.put("/api/admin/retention", { io_days: 30 })).body; assert.deepEqual(r.due.io.map(x => x.id), [io]);
  assert.equal((await admin.post("/api/admin/retention/apply", { io_ids: [io] })).status, 400, "confirmation is required");
  assert.equal((await admin.post("/api/admin/retention/apply", { confirm: true, io_ids: [fresh] })).status, 409, "a dataset not past its period cannot be deleted this way");
  const done = await admin.post("/api/admin/retention/apply", { confirm: true, io_ids: [io] }); assert.equal(done.body.io, 1);
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM io_datasets WHERE id = ?").get(io).n, 0); assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM io_datasets WHERE id = ?").get(fresh).n, 1);
  assert.equal(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'Retention: post dataset deleted%'").get().n, 1);
  assert.equal((await ana.get("/api/admin/retention")).status, 403);
});

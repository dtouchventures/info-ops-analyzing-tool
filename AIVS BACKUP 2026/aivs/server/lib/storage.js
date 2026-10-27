// Private content-addressed object store: data/objects/ab/cd/<sha256>. Files are written once and
// never modified; identical uploads share one object. Nothing here is under the public web root.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nowISO } from "./db.js";

export function makeStorage(db, dataDir) {
  const base = path.join(dataDir, "objects"), tmp = path.join(dataDir, "tmp");
  fs.mkdirSync(base, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  const pathOf = sha => path.join(base, sha.slice(0, 2), sha.slice(2, 4), sha);
  async function hashFile(file) {
    const h = crypto.createHash("sha256");
    await new Promise((ok, no) => fs.createReadStream(file).on("data", d => h.update(d)).on("end", ok).on("error", no));
    return h.digest("hex");
  }
  // move an uploaded temp file into the store; returns { sha256, existed }
  async function putFile(tmpFile, mime) {
    const sha256 = await hashFile(tmpFile), dest = pathOf(sha256);
    const existed = fs.existsSync(dest);
    if (existed) fs.rmSync(tmpFile, { force: true });
    else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(tmpFile, dest); fs.chmodSync(dest, 0o440); }
    db.prepare("INSERT OR IGNORE INTO objects(sha256,size,mime,stored_at) VALUES (?,?,?,?)").run(sha256, fs.statSync(dest).size, mime, nowISO());
    return { sha256, existed };
  }
  async function putBuffer(buf, mime) {
    const t = path.join(tmp, crypto.randomBytes(8).toString("hex")); fs.writeFileSync(t, buf); return putFile(t, mime);
  }
  // re-hash a stored object (integrity check)
  const verify = async sha => fs.existsSync(pathOf(sha)) && (await hashFile(pathOf(sha))) === sha;
  return { pathOf, putFile, putBuffer, verify, tmpDir: tmp, read: sha => fs.readFileSync(pathOf(sha)) };
}

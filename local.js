// ---------------------------------------------------------------- no-install edition: browser-only platform
// Replaces the claude.ai capabilities with local equivalents so the same application runs from a file:
//   db        -> IndexedDB "aivs-local", store "docs" (path -> record); other open tabs are kept in sync
//   assets    -> IndexedDB store "blobs" (original bytes, unchanged); shown through object URLs
//   user      -> one local profile with a typed name. It is NOT a verified identity, and the interface says so.
//   downloads -> an ordinary browser download
//   sample    -> not available (no server to keep an API key), so the AI features show "AI not configured"
const LOCAL = true;
const LOCALAPI = (() => {
  const DBN = "aivs-local", BLOB = "aivsblob:";
  let idb = null, profile = null;
  const docs = new Map(), subs = new Map(), urlOf = new Map(), idOf = new Map();
  const chan = (() => { try { return new BroadcastChannel("aivs-local"); } catch { return null; } })();
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const done = t => new Promise((ok, no) => { t.oncomplete = () => ok(); t.onerror = () => no(t.error); t.onabort = () => no(t.error || new Error("Storage transaction aborted.")); });
  const storageErr = e => Object.assign(new Error(/quota/i.test(String(e?.name) + e?.message) ? "The browser's storage for AIVS is full. Export a backup, then remove old cases or free disk space." : `Saving in this browser failed: ${e?.message || e}`), { code: "storage" });
  // object URLs are only valid in this page, so stored records carry "aivsblob:<id>" instead
  const walk = (v, f) => typeof v === "string" ? f(v) : Array.isArray(v) ? v.map(x => walk(x, f)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)])) : v;
  const toStored = v => walk(v, s => (idOf.has(s) ? BLOB + idOf.get(s) : s));
  const toLive = v => walk(v, s => (s.startsWith(BLOB) && urlOf.has(s.slice(BLOB.length)) ? urlOf.get(s.slice(BLOB.length)) : s));
  const addBlob = (id, blob) => { const u = URL.createObjectURL(blob); urlOf.set(id, u); idOf.set(u, id); return u; };
  const snap = path => { const has = docs.has(path); return { id: path.split("/").pop(), exists: has, data: () => (has ? toLive(structuredClone(docs.get(path))) : undefined), metadata: { hasPendingWrites: false, fromCache: false } }; };
  const notify = path => (subs.get(path) || []).forEach(f => setTimeout(() => f(snap(path)), 0));
  async function write(path, value) {
    const stored = value === undefined ? undefined : toStored(structuredClone(value)), t = idb.transaction("docs", "readwrite");
    if (stored === undefined) t.objectStore("docs").delete(path); else t.objectStore("docs").put(stored, path);
    try { await done(t); } catch (e) { throw storageErr(e); }
    if (stored === undefined) docs.delete(path); else docs.set(path, stored);
    chan?.postMessage({ path, stored }); notify(path);
  }
  if (chan) chan.onmessage = e => { const { path, stored } = e.data || {}; if (!path) return; if (stored === undefined) docs.delete(path); else docs.set(path, stored); notify(path); };
  const doc = path => ({ id: path.split("/").pop(), path,
    get: async () => snap(path), set: v => write(path, v), update: v => write(path, { ...(docs.get(path) ? toLive(structuredClone(docs.get(path))) : {}), ...v }), delete: () => write(path, undefined),
    onSnapshot(fn) { const a = subs.get(path) || []; a.push(fn); subs.set(path, a); setTimeout(() => fn(snap(path)), 0); return () => subs.set(path, (subs.get(path) || []).filter(x => x !== fn)); } });
  const coll = (path, where = []) => ({ doc: k => doc(`${path}/${k}`), where: (f, op, v) => { if (op !== "==") throw new Error("Only == filters are supported."); return coll(path, [...where, [f, v]]); },
    get: async () => ({ docs: [...docs.keys()].filter(k => k.startsWith(path + "/") && k.split("/").length === path.split("/").length + 1).filter(k => where.every(([f, v]) => docs.get(k)?.[f] === v)).map(snap) }) });
  const db = { doc, collection: p => coll(p) };
  const user = {
    me: async () => ({ id: profile.id, name: profile.name, email: null, isOwner: true, local: true }), id: async () => profile.id, isOwner: async () => true, canEdit: async () => true, can: async () => true,
    profiles: async ids => Object.fromEntries(ids.map(i => [i, { id: i, name: i === profile.id ? profile.name : "", isMe: i === profile.id }])), search: async () => []
  };
  const assets = {
    async upload(blob) {
      if (blob.size > 400 * 1024 * 1024) throw new Error("Files over 400 MB are not supported in the no-install edition.");
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""), t = idb.transaction("blobs", "readwrite");
      t.objectStore("blobs").put(blob, id); try { await done(t); } catch (e) { throw storageErr(e); }
      return { id, url: addBlob(id, blob), sizeBytes: blob.size, contentType: blob.type };
    },
    async list() { const est = await navigator.storage?.estimate?.().catch(() => null); return { assets: [...urlOf.keys()].map(id => ({ id })), usage: { bytes: est?.usage ?? null, quota: est?.quota ?? null } }; }
  };
  const downloads = { async save({ filename, data }) { const b = data instanceof Blob ? data : new Blob([data]); const u = URL.createObjectURL(b), a = Object.assign(document.createElement("a"), { href: u, download: filename }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); return { saved: true }; } };
  async function boot() {
    if (!window.indexedDB) throw new Error("This browser does not allow AIVS to store data (IndexedDB unavailable). Use a current Chrome, Edge or Firefox outside private browsing.");
    const r = indexedDB.open("aivs-local", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("docs"); r.result.createObjectStore("blobs"); };
    idb = await req(r);
    const t = idb.transaction(["docs", "blobs"]), ds = t.objectStore("docs"), bs = t.objectStore("blobs");
    const [dk, dv, bk, bv] = await Promise.all([req(ds.getAllKeys()), req(ds.getAll()), req(bs.getAllKeys()), req(bs.getAll())]);
    dk.forEach((k, i) => docs.set(k, dv[i])); bk.forEach((k, i) => addBlob(k, bv[i]));
    profile = docs.get("local/profile") || null;
    if (!docs.has("config/app")) await write("config/app", { members: {}, defaultRole: "admin", allowSelfApproval: true, ownerId: null });
    try { LOCALAPI.persisted = await navigator.storage?.persist?.(); } catch {}
    window.claude = { use: async n => ({ db, user, assets, downloads })[n] || null };
  }
  async function setName(name) {
    const n = String(name || "").trim().slice(0, 80); if (!n) throw new Error("Enter the name to show on your work.");
    profile = { id: profile?.id || `local-${Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("")}`, name: n, set_at: new Date().toISOString() };
    await write("local/profile", profile);
  }
  // full backup: every record and every stored file, in one JSON file
  async function backup() {
    const t = idb.transaction("blobs"), bs = t.objectStore("blobs"), [bk, bv] = await Promise.all([req(bs.getAllKeys()), req(bs.getAll())]), blobs = [];
    for (let i = 0; i < bk.length; i++) { const buf = new Uint8Array(await bv[i].arrayBuffer()); let s = ""; for (let j = 0; j < buf.length; j += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(j, j + 0x8000)); blobs.push({ id: bk[i], type: bv[i].type, size: buf.length, sha256: await sha256Hex(buf.buffer), data_base64: btoa(s) }); }
    return { format: "aivs-local-backup", version: 1, exported_at: new Date().toISOString(), docs: [...docs.entries()], blobs };
  }
  async function restore(file) {
    let b; try { b = JSON.parse(await file.text()); } catch { throw new Error("That file is not valid JSON."); }
    if (b?.format !== "aivs-local-backup" || b.version !== 1 || !Array.isArray(b.docs) || !Array.isArray(b.blobs)) throw new Error("That file is not an AIVS no-install backup (version 1).");
    const files = [];
    for (const x of b.blobs) {
      const bin = atob(x.data_base64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      if (x.sha256 && (await sha256Hex(u.buffer)) !== x.sha256) throw new Error(`Stored file ${x.id} does not match its SHA-256. The backup is damaged; nothing was restored.`);
      files.push([x.id, new Blob([u], { type: x.type || "" })]);
    }
    const t = idb.transaction(["docs", "blobs"], "readwrite"), ds = t.objectStore("docs"), bs = t.objectStore("blobs");
    ds.clear(); bs.clear(); for (const [k, v] of b.docs) ds.put(v, k); for (const [k, v] of files) bs.put(v, k);
    try { await done(t); } catch (e) { throw storageErr(e); }
    return { records: b.docs.length, files: files.length };
  }
  return { boot, setName, backup, restore, get profile() { return profile; }, persisted: null };
})();

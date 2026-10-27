// Live check of automatic investigations with the REAL services in .env (internet, evidence search, Ollama, optional
// reverse-image search). It starts a temporary, separate copy of AIVS (empty database in a temporary folder: your cases
// and reports are not touched), signs in as a temporary analyst, submits each link exactly as the Verify Information page
// does, waits for the result and checks: text extracted, images extracted, claims detected, evidence retrieved from real
// sources, AI used, report saved and downloadable (PDF, Word, HTML). Nothing is simulated.
// Usage:  npm run check:investigate                (a default set of public links)
//         npm run check:investigate -- <link> <link> ...
// Results: on screen, in data/investigate-check.txt, and the PDF reports in data/investigate-check/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT } from "../server/config.js";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/lib/auth.js";
import { nowISO } from "../server/lib/db.js";

// public pages that normally stay online; replace them with any links you want to test
const DEFAULT = ["https://www.bbc.com/news/world/africa", "https://en.wikipedia.org/wiki/Kenya", "https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://x.com/WHO/status/1849000000000000000"];
const links = process.argv.slice(2).filter(a => /^https?:\/\//i.test(a)); if (!links.length) links.push(...DEFAULT);
const lines = [], log = s => { console.log(s); lines.push(s); }, res = [];
const check = (name, pass, detail = "") => { res.push(pass); log(`  ${pass === null ? "N/A " : pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-inv-check-")), out = path.join(config.dataDir, "investigate-check");
fs.mkdirSync(out, { recursive: true });
const { app, ctx } = createApp({ ...config, dataDir: tmp, backupDisabled: true, port: 0, host: "127.0.0.1" });
ctx.db.prepare("INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?)").run("inv-check", "Investigation check", "analyst", hashPassword("inv-check-temporary-1"), nowISO());
const server = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";
const call = async (method, url, body, form) => {
  const o = { method, headers: { cookie, "x-aivs": "1" } };
  if (form) o.body = form; else if (body !== undefined) { o.body = JSON.stringify(body); o.headers["content-type"] = "application/json"; }
  const r = await fetch(base + url, o), ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const lr = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-aivs": "1" }, body: JSON.stringify({ username: "inv-check", password: "inv-check-temporary-1" }) });
cookie = (lr.headers.get("set-cookie") || "").split(";")[0];

log(`AIVS automatic investigation check ${nowISO()} (version ${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version})`);
const sv = (await call("GET", "/api/investigations/services")).body;
log(`Evidence sources configured: ${sv.evidence.filter(s => s.configured).map(s => s.label).join(", ") || "none"}`);
log(`AI: ${sv.ai.configured ? `${sv.ai.model}${sv.ai.local ? " (own network)" : " (outside the network: not used automatically)"}` : `not configured (${sv.ai.reason})`}`);
if (sv.ai.configured) { const h = await call("GET", "/api/ai/health"); log(`AI health check: ${h.body?.state || h.status}${h.body?.error ? ` — ${h.body.error}` : ""}`); }
log(`Reverse-image search: ${sv.reverse_search.configured ? sv.reverse_search.service : `not configured (${sv.reverse_search.needs})`}`);
log(`AI image description: ${sv.ai_vision.configured ? sv.ai_vision.model : `not configured (${sv.ai_vision.needs})`}`);

for (const link of links) {
  log(`\n${link}`);
  const fd = new FormData(); fd.append("url", link);
  const st = await call("POST", "/api/investigations", undefined, fd);
  if (st.status !== 202) { check("submitted", false, JSON.stringify(st.body).slice(0, 200)); continue; }
  let inv; const t0 = Date.now();
  for (;;) { inv = (await call("GET", `/api/investigations/${st.body.id}`)).body; if (["done", "failed"].includes(inv.status) || Date.now() - t0 > 20 * 60e3) break; await new Promise(r => setTimeout(r, 2000)); }
  log(`  ${inv.report_id} · ${inv.status} in ${Math.round((Date.now() - t0) / 1000)} s · stages: ${inv.stages.map(s => `${s.key}=${s.status}`).join(", ")}`);
  if (inv.status !== "done") { check("investigation completed", false, inv.error); continue; }
  const r = inv.result, p = inv.preview || {};
  check("text extracted", (p.text || "").length >= 40, `${(p.text || "").length} characters; access ${r.source.access}${r.source.notes.length ? `; ${r.source.notes[0]}` : ""}`);
  check("headline / title extracted", p.title ? true : null, p.title || "none on this page");
  check("images extracted from the link", (p.images || []).length ? true : null, `${(p.images || []).length} image(s)${(p.images || []).length ? ": " + p.images.map(i => i.source).join(", ") : ""}`);
  check("author or publication date found", p.author || p.published_at ? true : null, [p.author, p.published_at].filter(Boolean).join(" · ") || "not stated by the source");
  check("claims detected automatically", r.claims.length > 0, `${r.claims.length} claim(s), ${r.assessments.filter(a => a.verdict !== "not_verifiable").length} checkable`);
  const real = r.search.filter(s => !["kb", "holdings"].includes(s.key));
  check("evidence searched in real outside sources", real.some(s => s.status === "ok" || s.status === "partial"), real.map(s => `${s.label}: ${s.status === "ok" || s.status === "partial" ? `${s.results} result(s)` : s.status}${s.errors?.length ? ` (${s.errors[0].slice(0, 80)})` : ""}`).join("; ") || (r.claims.length ? "no outside source configured" : "not searched: no claim was extracted"));
  check("evidence items retrieved", r.evidence.length > 0, `${r.evidence.length} item(s) from ${[...new Set(r.evidence.map(e => e.domain))].length} site(s)`);
  check("AI used", r.ai.used ? true : sv.ai.configured ? false : null, r.ai.used ? r.ai.model : r.ai.reason);
  check("images verified", r.media.images.length ? true : null, r.media.images.map(i => `${i.observations.length} observation(s)`).join(", ") || "no image");
  log(`  Verdict: ${r.overall.label} (strength of the evidence: ${r.overall.strength_label})${r.overall.note ? ` — ${r.overall.note}` : ""}`);
  for (const fmt of ["pdf", "docx", "html"]) {
    const f = await call("GET", `/api/investigations/${inv.id}/report.${fmt}`);
    const okFile = f.status === 200 && f.body.length > 500; check(`report downloads as ${fmt.toUpperCase()}`, okFile, `${f.body.length} bytes`);
    if (fmt === "pdf" && okFile) fs.writeFileSync(path.join(out, `${inv.report_id}.pdf`), f.body);
  }
  check("report saved in Reports", (await call("GET", "/api/investigations")).body.investigations.some(x => x.id === inv.id));
}
const passed = res.filter(x => x === true).length, failed = res.filter(x => x === false).length;
log(`\n${passed} passed, ${failed} failed, ${res.filter(x => x === null).length} not applicable (the source does not offer it, or the service is not configured).`);
log(`PDF reports: ${out}`);
fs.writeFileSync(path.join(config.dataDir, "investigate-check.txt"), lines.join("\n"));
await ctx.investigations.close(); server.close(); ctx.db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

// Live check of Verify Information with REAL links and the settings in your .env (Meta tokens, search keys, the organisation's
// Ollama server). A temporary, separate copy of AIVS (empty database in a temporary folder: your records are not touched) runs a
// full investigation of each link and shows every stage, every extraction method tried and its result, the AI's part, the verdict
// and the one-page report. Nothing is simulated: a link that cannot be read is reported as such.
// Usage:  npm run check:verify-url -- <link> [<link> ...]
//   e.g.  npm run check:verify-url -- https://www.nation.africa/... https://www.facebook.com/<Page>/posts/<id> https://www.instagram.com/p/<code>/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT } from "../server/config.js";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/lib/auth.js";
import { nowISO } from "../server/lib/db.js";

const links = process.argv.slice(2).filter(a => /^https?:\/\//i.test(a));
if (!links.length) { console.log("Give one or more links: npm run check:verify-url -- https://…"); process.exit(2); }
const lines = [], log = s => { console.log(s); lines.push(s); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-verify-check-"));
const { ctx } = createApp({ ...config, dataDir: tmp, backupDisabled: true, watch: { ...config.watch, enabled: false }, live: { ...config.live, tickSeconds: 3600 } });
ctx.db.prepare("INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES ('verify-check','Verify check','analyst',?,?)").run(hashPassword("verify-check-temporary-1"), nowISO());
const user = ctx.db.prepare("SELECT * FROM users WHERE username = 'verify-check'").get();
log(`AIVS Verify Information check ${nowISO()} (version ${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version})`);
const h = await ctx.ai.health({ force: true });
log(`AI: ${config.ai.provider || "not configured"} ${config.ai.model || ""} at ${config.ai.baseUrl || "-"} — ${h.state === "ok" ? `READY (answered in ${h.latency_ms} ms)` : `NOT READY: ${h.error || h.state}`}`);
const vc = await ctx.investigations.visionCheck(); log(`Image understanding: ${vc.supported ? "available (the model reports the vision capability)" : `not used — ${vc.reason}`}`);
log(`Meta: oEmbed token ${config.social.metaToken ? "set" : "not set"}, Page token ${config.live?.pageToken ? "set" : "not set"}; web search ${config.search?.braveKey ? "Brave set" : "Brave not set"}, fact-checks ${config.search?.factcheckKey ? "set" : "not set"}`);
let failed = 0;
for (const url of links) {
  log(`\n=== ${url}`);
  try {
    const st = ctx.investigations.start(user, { url });
    for (let i = 0; i < 900; i++) { const g = ctx.investigations.get(st.id); if (["done", "failed"].includes(g.status)) break; await new Promise(r => setTimeout(r, 1000)); }
    const inv = ctx.investigations.get(st.id), r = inv.result;
    for (const s of inv.stages) log(`  ${s.status.toUpperCase().padEnd(8)} ${s.label}${s.detail ? ` — ${String(s.detail).slice(0, 220)}` : ""}`);
    if (inv.status === "failed") { failed++; log(`  FAILED: ${inv.error}`); continue; }
    const att = r.blocked?.attempts || r.source.extraction_attempts || [];
    if (att.length) log(`  Extraction methods tried:\n${att.map(a => `    - ${a.method}: ${a.result}${a.detail ? ` (${String(a.detail).slice(0, 200)})` : ""}`).join("\n")}`);
    log(`  Method used: ${r.source.method}`);
    if (r.blocked) { log(`  RESULT: content not available automatically — ${r.blocked.reason.slice(0, 300)}`); if (r.references) log(`  Independent references: ${r.references.note}${(r.references.results || []).map(x => `\n    - ${x.title} ${x.url}`).join("")}`); continue; }
    log(`  Content (${r.content.length} characters): ${r.content.replace(/\s+/g, " ").slice(0, 200)}`);
    log(`  Claims: ${r.claims.length} · evidence compared: ${r.evidence.length} · images: ${r.media.images.length}`);
    const a = r.ai.content; log(`  AI: ${r.ai.used ? `used (${r.ai.model})` : `not used — ${r.ai.reason}`}${a ? ` · language ${a.language} · ${a.narratives.length} narrative(s) · ${a.misleading.length} possibly misleading claim(s) · gaps: ${a.gaps.join("; ").slice(0, 160)}` : ""}`);
    log(`  Verdict: ${r.overall.label} (evidence strength: ${r.overall.strength_label})`);
    log(`  One-page report (${r.io_assessment.written_by === "ai" ? "AI-drafted, checked" : "rule-based"}):\n    Background: ${String(r.io_assessment.background).slice(0, 300)}\n    Assessment: ${String(r.io_assessment.assessment).slice(0, 300)}`);
  } catch (e) { failed++; log(`  ERROR: ${e.message}`); }
}
fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(path.join(config.dataDir, "verify-url-check.txt"), lines.join("\n"));
log(`\nSaved in ${path.join(config.dataDir, "verify-url-check.txt")}`);
await ctx.investigations.close(); ctx.db.close(); fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

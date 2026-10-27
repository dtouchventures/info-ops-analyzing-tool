// Live check of keyword search with the REAL sources configured in your .env. It starts a temporary, separate copy of
// AIVS (empty database in a temporary folder: your records are not touched), searches the keyword you give across every
// source, and reports which platforms are operational, with the actual items they returned. Nothing is simulated.
// Usage:  npm run check:search -- "Kenya Army"          (any keyword, phrase or combination, e.g. "KDF AND Lamu -football")
// Results: on screen, in data/search-check.txt, and the draft report in data/search-check/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT } from "../server/config.js";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/lib/auth.js";
import { nowISO } from "../server/lib/db.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) { console.log('Give a keyword: npm run check:search -- "Kenya Army"'); process.exit(2); }
const lines = [], log = s => { console.log(s); lines.push(s); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-search-check-")), out = path.join(config.dataDir, "search-check");
fs.mkdirSync(out, { recursive: true });
const { app, ctx } = createApp({ ...config, dataDir: tmp, backupDisabled: true, port: 0, host: "127.0.0.1", watch: { ...config.watch, enabled: false }, live: { ...config.live, tickSeconds: 3600 } });
for (const [u, role] of [["search-check", "reviewer"], ["search-check-2", "reviewer"]]) ctx.db.prepare("INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?)").run(u, u, role, hashPassword("search-check-temporary-1"), nowISO());
const user = ctx.db.prepare("SELECT * FROM users WHERE username = 'search-check'").get();
log(`AIVS keyword search check ${nowISO()} (version ${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version})`);
log(`Keyword entered: ${query}`);
try {
  if (config.live?.pageToken) { ctx.live.ensureSources(); for (const s of ctx.db.prepare("SELECT id FROM social_sources").all()) await ctx.live.sync(s.id, { kind: "manual" }); }
  const st = ctx.keywords.start(user, { query, max: 20, from: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10) });
  log(`Interpreted as: ${st.description}`);
  for (let i = 0; i < 900 && ctx.keywords.get(st.id).status === "running"; i++) await new Promise(r => setTimeout(r, 1000));
  const s = ctx.keywords.get(st.id), r = ctx.keywords.results(st.id, { limit: 500 });
  log(`\nSource by source (last 7 days, at most 20 per source):`);
  for (const p of s.per_source) log(`  ${p.state === "ok" ? (p.matched ? "OPERATIONAL   " : "OPERATIONAL, 0") : p.state === "not_configured" ? "NOT CONFIGURED" : p.state === "restricted" ? "RESTRICTED    " : "UNAVAILABLE   "}  ${p.label}: ${p.state === "ok" ? `${p.fetched} returned, ${p.matched} matching, ${p.duplicates} duplicate(s)` : p.error}`);
  log(`\n${r.total} item(s) found${r.by_source.length ? ` (${r.by_source.map(b => `${b.platform} ${b.n}`).join(", ")})` : ""}. First items:`);
  for (const it of r.items.slice(0, 12)) log(`  ${it.posted_at ? it.posted_at.slice(0, 16).replace("T", " ") : "no date        "}  ${it.platform.padEnd(14)} ${it.account || ""} — ${it.text.replace(/\s+/g, " ").slice(0, 90)}\n      ${it.url || "no link"}${it.has_image ? "  [image]" : ""}${it.duplicate_of ? "  [duplicate]" : ""}`);
  const first = r.items.find(i => !i.duplicate_of && i.url);
  if (first) {
    const v = ctx.keywords.verify(user, first.id); log(`\nVerification of the first item started: ${v.report_id || v.investigation_id}`);
    for (let i = 0; i < 900 && !ctx.investigations.idle(); i++) await new Promise(x => setTimeout(x, 1000));
    const it = ctx.keywords.item(first.id); log(`  verification status: ${it.verification.label}`);
  }
  const rep = await ctx.keywords.report(user, { searchId: st.id });
  const pdf = await ctx.keywords.reportFile(rep.id, "pdf"); fs.writeFileSync(path.join(out, `${rep.report_id}.pdf`), pdf.body); fs.writeFileSync(path.join(out, `${rep.report_id}.html`), (await ctx.keywords.reportFile(rep.id, "html")).body);
  log(`\nDraft report ${rep.report_id}: text ${rep.written_by === "ai" ? `drafted by the AI model (${rep.report.ai_model}) and checked` : "rule-based"}${rep.report.ai_notes?.length ? ` (${rep.report.ai_notes.join(" ")})` : ""}.`);
  log(`  narratives ${rep.situation.narratives.length}, repeated wording ${rep.situation.repeated.length}, contradictions ${rep.situation.contradictions.length}, gaps: ${rep.situation.gaps.join(" ") || "none"}`);
  const src = ctx.keywords.sources().sources;
  log(`\nPlatform status: ${["Connected", "Configured, not yet tested", "Restricted", "Unavailable", "Not configured"].map(c => `${c}: ${src.filter(x => x.category === c).map(x => x.platform).join(", ") || "none"}`).join(" | ")}`);
} catch (e) { log(`The check stopped: ${e.stack || e.message}`); }
log(`Reports: ${out}`);
fs.writeFileSync(path.join(config.dataDir, "search-check.txt"), lines.join("\n"));
await ctx.investigations.close(); ctx.db.close(); fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);

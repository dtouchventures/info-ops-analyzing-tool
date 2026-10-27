// Live check of the default watchlist "KDF and Kenya Defence Forces Monitoring" with the REAL sources configured in your .env.
// A temporary, separate copy of AIVS (empty database in a temporary folder: your records are not touched) creates the default
// watchlist, runs every one of its connected sources once (as the scheduler does), and lists the genuine matches with their date,
// link, image and matched keywords, the items held because only an ambiguous keyword (such as CDF) matched, and the source
// errors. It then tries the AI analysis queue once with your Ollama server, and runs an immediate search for a keyword you give.
// Nothing is simulated: a source that returns nothing is reported as returning nothing.
// Usage:  npm run check:kdf-watchlist                     (immediate search for "Kenya Army")
//         npm run check:kdf-watchlist -- "Majeshi Yetu"   (immediate search for another keyword)
// Results: on screen and in data/kdf-watchlist-check.txt
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT } from "../server/config.js";
import { createApp } from "../server/app.js";
import { nowISO } from "../server/lib/db.js";
import { WATCH_SOURCES } from "../server/lib/watch.js";

const query = process.argv.slice(2).join(" ").trim() || "Kenya Army";
const lines = [], log = s => { console.log(s); lines.push(s); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-kdf-check-"));
const { ctx } = createApp({ ...config, dataDir: tmp, backupDisabled: true, watch: { ...config.watch, enabled: false }, live: { ...config.live, tickSeconds: 3600 } });
const day = iso => (iso ? iso.slice(0, 16).replace("T", " ") : "no date given   ");
log(`AIVS default watchlist check ${nowISO()} (version ${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version})`);
let failed = false;
try {
  const sys = ctx.live.systemUser(), d = ctx.keywords.ensureDefault(sys), wl = ctx.watch.get(d.id);
  log(`Watchlist “${wl.name}”: ${wl.status}. Keywords: ${wl.definition.terms.join(", ")}. Ambiguous (need context): ${(wl.definition.contextual || []).map(c => c.term).join(", ")}.`);
  log(`\nSources of the watchlist, each run once now:`);
  for (const s of wl.definition.sources) {
    const label = WATCH_SOURCES[s]?.label || s;
    if (!ctx.watchCollector.sourcesReady(s)) { log(`  NOT CONFIGURED  ${label}: ${ctx.watchCollector.sourceState(s).needs || "not set up"}`); continue; }
    const t0 = Date.now(), r = await ctx.watchCollector.runSource(ctx.watch.get(wl.id), s, { kind: "manual" });
    const run = ctx.db.prepare("SELECT * FROM watch_runs WHERE watchlist_id = ? AND source = ? ORDER BY id DESC LIMIT 1").get(wl.id, s) || {};
    if (r.error) { failed = true; log(`  FAILED          ${label}: ${r.error.slice(0, 300)}`); continue; }
    log(`  ${r.matched ? "OPERATIONAL   " : "OPERATIONAL, 0"}  ${label}: ${run.fetched ?? r.fetched ?? 0} item(s) read, ${r.matched} genuine match(es), ${r.ambiguous || 0} held as ambiguous, ${r.not_confirmed} without a keyword (${Math.round((Date.now() - t0) / 1000)} s)${run.note ? ` — ${String(run.note).slice(0, 200)}` : ""}`);
  }
  const feed = ctx.keywords.feed({ watchlist: wl.id, limit: 500 }), amb = ctx.keywords.feed({ watchlist: wl.id, quality: "ambiguous", limit: 50 });
  log(`\n${feed.total} genuine result(s)${feed.by_source.length ? ` (${feed.by_source.map(b => `${b.platform} ${b.n}`).join(", ")})` : ""}. Newest first:`);
  for (const it of feed.items.slice(0, 15)) log(`  ${day(it.posted_at)}  ${it.platform} · ${it.account || "source not named"}${it.has_image ? " · image" : ""}\n      ${it.text.replace(/\s+/g, " ").slice(0, 140)}\n      matched: ${it.matched_terms.join(", ") || "(keyword in the full article)"}${it.quality === "contextual" ? ` — contextual, with ${it.disambiguated_by.join(", ")}` : ""}\n      ${it.url || "no link"}`);
  log(`\n${amb.total} item(s) held because only an ambiguous keyword matched (an analyst decides in Discovered items › Ambiguous keywords):`);
  for (const it of amb.items.slice(0, 5)) log(`  ${day(it.posted_at)}  ${it.text.replace(/\s+/g, " ").slice(0, 120)}`);
  const em = ctx.keywords.emerging(wl.id); log(`\nEmerging topics in the last 6 hours: ${em.length ? em.map(t => `${t.topic} (${t.items} items, ${t.sources} sources)`).join("; ") : "none"}`);
  log(`\nAI analysis queue (organisation's Ollama server ${config.ai.baseUrl || "(not set)"}):`);
  const a1 = await ctx.keywords.aiTick(), q = ctx.keywords.aiQueueCounts();
  log(a1.waiting ? `  WAITING: ${String(a1.reason).replace(/\.+$/, "")}. ${q.pending} item(s) stored and queued; they are analysed when the server answers.` : `  ${a1.analysed} item(s) analysed now, ${q.pending} still queued (a few a minute when AIVS runs).`);
  const done = ctx.keywords.feed({ watchlist: wl.id, limit: 50 }).items.find(i => i.ai?.status === "done");
  if (done) log(`  Example: “${done.text.slice(0, 80)}” → about the subject: ${done.ai.result.about_subject}; ${done.ai.result.summary}`);
  log(`\nImmediate search for the analyst-entered keyword “${query}” across every connected source (last 3 days):`);
  const st = ctx.keywords.start(sys, { query, max: 20, from: new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10) });
  for (let i = 0; i < 900 && ctx.keywords.get(st.id).status === "running"; i++) await new Promise(r => setTimeout(r, 1000));
  const s = ctx.keywords.get(st.id), r = ctx.keywords.results(st.id, { limit: 100 });
  for (const p of s.per_source) log(`  ${p.state === "ok" ? "OK            " : p.state === "not_configured" ? "NOT CONFIGURED" : p.state.toUpperCase().padEnd(14)}  ${p.label}: ${p.state === "ok" ? `${p.fetched} read, ${p.matched} matching${p.ambiguous ? `, ${p.ambiguous} ambiguous` : ""}` : (p.error || "").slice(0, 160)}`);
  log(`  ${r.total} result(s). ${r.items.slice(0, 5).map(i => `\n    ${day(i.posted_at)} ${i.platform}: ${i.text.replace(/\s+/g, " ").slice(0, 100)} — ${i.url || ""}`).join("")}`);
} catch (e) { failed = true; log(`The check stopped: ${e.stack || e.message}`); }
fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(path.join(config.dataDir, "kdf-watchlist-check.txt"), lines.join("\n"));
log(`\nSaved in ${path.join(config.dataDir, "kdf-watchlist-check.txt")}`);
await ctx.investigations.close(); ctx.db.close(); fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

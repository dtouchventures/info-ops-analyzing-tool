// Live check of Verify Information with Facebook links, using the REAL Graph API and the token in your .env. A temporary,
// separate copy of AIVS (empty database in a temporary folder) collects your authorised Page's recent posts, then verifies:
//   1 a collected post by its own link            → read from the database (no further Meta request)
//   2 the same post in another link form          → matched to the same record
//   3 a Facebook share link (optional argument)    → resolved through Facebook's redirect, then read
//   4 a post of a Page that is not authorised      → refused without requesting it ("Extraction blocked")
// Usage:  npm run check:verify-facebook                      (checks 1, 2 and 4)
//         npm run check:verify-facebook -- <share link>      (also check 3, e.g. https://www.facebook.com/share/p/xxxx/)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.js";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/lib/auth.js";
import { nowISO } from "../server/lib/db.js";

const share = process.argv.slice(2).find(a => /^https?:\/\//.test(a));
const lines = [], log = s => { console.log(s); lines.push(s); }, res = [];
const check = (name, pass, detail = "") => { res.push(pass); log(`  ${pass === null ? "N/A " : pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
if (!config.live?.pageToken || !config.live?.pageIds) { log("META_PAGE_ACCESS_TOKEN and META_PAGE_IDS must be set in .env. Nothing was checked."); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-fbverify-check-"));
const { ctx } = createApp({ ...config, dataDir: tmp, backupDisabled: true, watch: { ...config.watch, enabled: false }, live: { ...config.live, tickSeconds: 3600 } });
ctx.db.prepare("INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES ('fbv-check','Facebook verify check','analyst',?,?)").run(hashPassword("fbv-check-temporary-1"), nowISO());
const user = ctx.db.prepare("SELECT * FROM users WHERE username = 'fbv-check'").get();
const verify = async url => { const inv = ctx.investigations.start(user, { url }); for (let i = 0; i < 900; i++) { const g = ctx.investigations.get(inv.id); if (["done", "failed"].includes(g.status)) return g; await new Promise(r => setTimeout(r, 1000)); } return ctx.investigations.get(inv.id); };
log(`AIVS Verify Information — Facebook check ${nowISO()}`);
try {
  ctx.live.ensureSources(); const tok = await ctx.live.checkToken({ force: true });
  log(`Token: ${tok.state}${tok.subject_name ? ` (${tok.subject_name})` : ""}${tok.error ? ` — ${tok.error}` : ""}`);
  for (const s of ctx.db.prepare("SELECT id FROM social_sources").all()) await ctx.live.sync(s.id, { kind: "manual" });
  const p = ctx.db.prepare("SELECT * FROM social_posts WHERE message IS NOT NULL AND permalink_url IS NOT NULL ORDER BY created_time DESC").get();
  if (!p) { check("a collected post to verify", false, "no post with text was collected from the authorised Page"); }
  else {
    log(`Post used: ${p.post_id} (${p.created_time}) ${p.message.replace(/\s+/g, " ").slice(0, 80)}\n  ${p.permalink_url}`);
    let inv = await verify(p.permalink_url);
    const ext = s => s.stages.map(x => `${x.key}=${x.status}`).join(", ");
    check("1 a collected post is read from the Live Monitoring database", inv.status === "done" && inv.result.source.facebook?.from === "database" && inv.result.content.includes(p.message.slice(0, 40)), `${inv.result?.overall?.label} · ${inv.result?.claims?.length} claim(s) · AI ${inv.result?.ai?.used ? `used (${inv.result.ai.model})` : `not used (${inv.result?.ai?.reason})`} · stages ${ext(inv)}`);
    const [owner, post] = p.post_id.split("_");
    inv = await verify(`https://m.facebook.com/story.php?story_fbid=${post}&id=${owner}`);
    check("2 the same post in another link form is matched", inv.status === "done" && inv.result.source.facebook?.from === "database", inv.result?.source?.facebook?.status);
  }
  if (share) {
    const inv = await verify(share), f = inv.result?.source?.facebook;
    check("3 a Facebook share link is resolved and read", inv.status === "done" && !!f?.resolved_url && !inv.result.blocked, `${f?.status}: ${f?.resolved_url || inv.result?.blocked?.reason || ""} · attempts: ${(f?.attempts || []).map(a => `${a.method} ${a.result}`).join("; ")}`);
  } else check("3 a Facebook share link is resolved and read", null, "give a share link: npm run check:verify-facebook -- https://www.facebook.com/share/p/…");
  const other = await verify("https://www.facebook.com/KenyaDefenceForces/posts/1000000000000001");
  check("4 a post of a Page that is not authorised is refused, not requested", other.result?.overall?.verdict === "extraction_blocked", other.result?.blocked?.reason?.slice(0, 200));
} catch (e) { check("the check ran to the end", false, e.stack || e.message); }
log(`\n${res.filter(x => x === true).length} passed, ${res.filter(x => x === false).length} failed, ${res.filter(x => x === null).length} not applicable.`);
fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(path.join(config.dataDir, "verify-facebook-check.txt"), lines.join("\n"));
await ctx.investigations.close(); ctx.db.close(); fs.rmSync(tmp, { recursive: true, force: true });
process.exit(res.includes(false) ? 1 : 0);

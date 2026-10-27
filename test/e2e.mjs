// End-to-end browser test of the main workflow. Usage: npm run test:e2e  (needs Playwright + Chromium)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, login, PW } from "./helpers.js";

const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null; if (shots) fs.mkdirSync(shots, { recursive: true });
// a stand-in for X's public embed service, so the post lookup can be tested without the internet
const http = (await import("node:http")).default;
const fakeX = http.createServer((req, res) => { const u = new URL(req.url, "http://x"); const ok = (u.searchParams.get("url") || "").endsWith("1849000000000000000");
  res.writeHead(ok ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(ok ? { author_name: "Practice Desk", author_url: "https://twitter.com/practice_desk", html: '<blockquote class="twitter-tweet"><p lang="en">The water project funds have disappeared, demand answers now. Share before they delete this!</p>&mdash; Practice Desk (@practice_desk) <a href="#">October 23, 2024</a></blockquote>' } : { error: "not found" })); });
await new Promise(ok => fakeX.listen(0, "127.0.0.1", ok));
const S = await startServer({ social: { timeoutMs: 3000, bases: { x: `http://127.0.0.1:${fakeX.address().port}` } } });
const rev = await login(S.base, "rev");
{ const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync("training/images/archive_convoy.jpg")]), "convoy-2018.jpg");
  for (const [k, v] of Object.entries({ title: "Convoy crossing a flooded track, 2018", description: "Documented convoy crossing during seasonal rains; all vehicles completed it.", documented_date: "2018-10-14", source_ref: "Unit media release 2018/994", record_type: "original" })) fd.append(k, v);
  await rev.post("/api/archive", null, { form: fd }); }

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = 0; const errors = [];
const check = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };
// the original workflow checks below use Advanced mode (every tool visible); the guided four-step flow has its own block
async function session(user, mode = "advanced") {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }), p = await ctx.newPage();
  p.on("pageerror", e => errors.push(`${user}: ${e.message}`)); p.on("console", m => m.type() === "error" && !/401|Failed to load resource/.test(m.text()) && errors.push(`${user}: ${m.text()}`));
  await p.goto(S.base); await p.fill("#lu", user); await p.fill("#lp", PW); await p.click("#lb"); await p.waitForSelector(".shell");
  if (mode === "advanced") { await p.click('[data-mode="advanced"]'); await p.waitForSelector('[data-mode="advanced"].on'); }
  return p;
}
// switch Guided/Advanced the way the toggle does (saved per user), then reload the app
const setMode = async (p, m) => { await p.evaluate(async m => { await fetch("/api/me/preferences", { method: "PATCH", headers: { "content-type": "application/json", "x-aivs": "1" }, body: JSON.stringify({ ui_mode: m }) }); }, m); await p.reload(); await p.waitForSelector(".shell"); };
const shot = async (p, n) => shots && p.screenshot({ path: path.join(shots, n + ".png"), fullPage: true });

// ---- analyst
const a = await session("ana");
await a.waitForSelector(".svc");
check("the main menu has the six services", JSON.stringify(await a.$$eval(".nav > a span:first-of-type", x => x.map(e => e.textContent))) === JSON.stringify(["Dashboard", "Verify Information", "Social Media Analysis", "AI Watchlist", "Reports", "Settings"]));
check("the dashboard shows three service cards with server figures, recent investigations and recent alerts", (await a.$$(".svc")).length === 3 && (await a.textContent("#page")).includes("Recent investigations") && (await a.textContent("#page")).includes("No alerts"));
await shot(a, "00a-dashboard-home");
await a.goto(S.base + "/#/status"); await a.waitForSelector(".module");
check("start page lists the eight modules with honest statuses", (await a.$$(".module")).length === 8 && (await a.textContent(".modules")).includes("Available") && (await a.textContent(".modules")).includes("Partly available"));
await shot(a, "00-start");
await a.click(`a[href="#/dashboard"]`); await a.waitForFunction(() => document.querySelector("#crumbs")?.textContent.startsWith("Dashboard") && !document.querySelector("#page .spin") && document.querySelector(".kpis, #page .empty, #page"));
await a.waitForFunction(() => /No cases yet/.test(document.querySelector("#page")?.textContent || ""));
check("dashboard shows empty state with no invented figures", (await a.textContent("#page")).includes("No cases yet"));
await shot(a, "01-dashboard-empty");
await a.click('a[href="#/new"]');
await a.waitForSelector("#su");
await a.fill("#su", "https://x.com/someaccount/status/1849000000000000000"); await a.waitForTimeout(500);
check("a link fills platform, account and posting time automatically", (await a.inputValue("#sp")) === "X (Twitter)" && (await a.inputValue("#sa")) === "@someaccount" && (await a.inputValue("#pa")).startsWith("2024-10-23"));
await a.evaluate(() => { document.querySelector("#more").open = true; });
await a.fill("#t", "Flooded convoy photo on X");
await a.fill("#cl", "BREAKING: Several KDF supply trucks were abandoned in floodwater along the Garissa-Modika road last night. Soldiers were forced to retreat on foot.");
await a.fill("#sp", "X (Twitter)"); await a.fill("#ea", "2026-10-14T23:00"); await a.fill("#eb", "Post says “last night”");
await shot(a, "02-new-case");
await a.click("#n1"); await a.waitForSelector("#dz");
await a.setInputFiles("#fi", "training/images/case_convoy.jpg");
await a.waitForSelector("text=Stored as", { timeout: 30000 });
check("upload shows SHA-256 on receipt", /SHA-256 [0-9a-f]{16}/.test(await a.textContent("#ul")));
await a.click("#n2"); await a.click("#go");
await a.waitForSelector(".casehead"); await a.waitForSelector("text=Prepare conclusion", { timeout: 30000 });
const caseId = (await a.textContent(".casehead .id")).split(" ")[0];
check("analysis completes into analyst review", (await a.textContent(".stepper .cur")).includes("Under investigation"), caseId);
await shot(a, "03-case-overview");
check("timeline flags timing conflict", (await a.textContent("#tabBody")).includes("Timing conflict"));
await a.click(`a[href="#/case/${caseId}/media"]`); await a.waitForSelector(".match");
check("strong archive similarity is shown with distance explanation", (await a.textContent(".match")).includes("Strong similarity") && (await a.textContent(".match")).includes("not a probability"));
await a.click('[data-mode="Differences"]'); await a.waitForSelector(".cmpbox img.single", { timeout: 30000 });
check("difference map renders", /% of the submitted image differs/.test(await a.textContent(".cmpbox")));
await a.click('[data-mode="Matched region"]'); await a.waitForSelector(".cmpbox img.single");
await shot(a, "04-media-matches");
// OCR (local, English)
await a.selectOption('[data-ocrlang]', "eng"); await a.click("[data-ocr]");
await a.waitForSelector("[data-ocrtext]", { timeout: 120000 });
check("local OCR runs and stores an original extraction", (await a.$$("[data-ocrtext]")).length === 1);
// claims
await a.click(`a[href="#/case/${caseId}/evidence"]`); await a.waitForSelector(".ev.sugg");
const arcLead = a.locator(".ev.sugg", { hasText: "Archive context" });
check("archive lead suggests contradicting the timing claim", (await arcLead.locator("select").evaluateAll(s => s.map(x => x.value))).includes("contradicts"));
await shot(a, "05-evidence");
for (let k = 0; k < 20 && await a.$("[data-acc]"); k++) {
  const before = await a.$$eval("[data-acc]", x => x.length);
  await a.locator("[data-acc]").first().click();
  try { await a.waitForFunction(n => document.querySelectorAll("[data-acc]").length < n, before, { timeout: 8000 }); }
  catch { break; }
}
await a.fill("#nt", "The unit's movement log lists the vehicles in the photo as KDF logistics trucks."); await a.fill("#nr", "Movement log 4B/2018 (consulted 15 Oct 2026)");
await a.selectOption("#nk", "source_claim");
const firstSel = a.locator('[data-ln="new"]').first(); await firstSel.selectOption("supports");
await a.click("#addEv"); await a.waitForSelector("text=Evidence added");
// correct the analyst's own evidence: earlier wording must stay visible
{ const ev = a.locator(".ev", { hasText: "movement log lists" }).first();
  await ev.locator("[data-fix]").click(); await a.waitForSelector(".modal #ceT");
  await a.fill(".modal #ceT", "The unit's movement log (entry 4B) lists the vehicles in the photo as KDF logistics trucks."); await a.fill(".modal #ceD", "2018-10-14");
  await a.click(".modal .btn.primary"); await a.waitForSelector("text=updated.");
  const t = await a.locator(".ev", { hasText: "entry 4B" }).first().textContent();
  check("evidence correction keeps earlier wording and source date", t.includes("Corrected 1 time") && t.includes("Source dated 2018-10-14")); }
// visible validation: empty evidence form explains what is missing
await a.click("#addEv"); await a.waitForSelector("#evErr:not([hidden])");
check("missing evidence fields show a visible message", (await a.textContent("#evErr")).includes("reference"));
await a.click(`a[href="#/case/${caseId}/claims"]`); await a.waitForSelector(".claim");
const n = await a.$$eval(".claim", x => x.length);
for (let i = 0; i < n; i++) {
  const claim = a.locator(".claim").nth(i), txt = await claim.locator("[data-ctext]").inputValue();
  const v = i === 0 ? "supported" : /are recent|attached media/.test(txt) ? "contradicted" : "insufficient";
  await claim.locator("[data-rat]").fill("Assessed in the end-to-end test.");
  await claim.locator(`[data-v="${v}"]`).click(); await a.waitForLoadState("networkidle"); await a.waitForTimeout(150);
}
// the media claim needs contradicting evidence too: link the archive lead
// link the archive lead as contradicting the media claim, through the "Link evidence" dialog
const mi = await a.$$eval("[data-ctext]", t => t.findIndex(x => /attached media/.test(x.value)));
if (mi >= 0) {
  await a.locator(".claim").nth(mi).locator("[data-link]").click(); await a.waitForSelector(".modal");
  for (const o of await a.$$(".modal .ev")) if ((await o.textContent()).includes("Archive context")) await (await o.$("select")).selectOption("contradicts");
  await a.click(".modal .btn.primary"); await a.waitForSelector("text=Links saved");
}
await shot(a, "06-claims");
check("four verdicts offered per claim (plus not assessed)", (await a.locator(".claim").first().locator("[data-v]").count()) === 5 && !(await a.textContent(".claim")).includes("Misleading context") && !(await a.textContent(".claim")).includes("Partially supported"));
check("evidence strength shown for a claim with accepted evidence", /(Weak|Moderate|Strong) evidence/.test(await a.textContent("#tabBody")));
check("mixed findings expected from claims", (await a.textContent("#tabBody")).includes("Mixed findings"));
await a.click(`a[href="#/case/${caseId}/report"]`); await a.waitForSelector("#cc");
await a.selectOption("#cc", "mixed"); await a.fill("#cr", "The trucks are KDF vehicles, but the photograph was documented in 2018, so the claim that it shows last night's floods is false."); await a.fill("#cu", "No independent report on current road conditions.");
await a.click("#draftB"); await a.click("#saveC"); await a.waitForSelector("text=Ready.", { timeout: 10000 });
await shot(a, "07-conclusion");
await a.click("#submitA"); await a.click(".modal .btn.primary"); await a.waitForSelector("text=Reviewer decision");
check("submitted case is locked and waiting", (await a.textContent(".stepper .cur")).includes("Awaiting review"));
// ---- reviewer
const r = await session("rev");
await r.click('a[href="#/review"]'); await r.waitForSelector("table.t");
await shot(r, "08-review-queue");
await r.click(`a[href="#/case/${caseId}/report"]`); await r.waitForSelector("#appr");
check("reviewer can approve, ask for more evidence or reject", !!(await r.$("#ret")) && !!(await r.$("#rej")) && (await r.textContent("#ret")).includes("Needs additional evidence"));
await r.click("#appr"); await r.click(".modal .btn.primary"); await r.waitForSelector("text=Approved reports");
check("reviewer approval freezes a report", (await r.textContent("#tabBody")).includes(`R-${caseId}-r1`));
{ const pr = await r.request.get(S.base + `/api/reports/R-${caseId}-r1.pdf`), body = await pr.body();
  check("approved report downloads as PDF", pr.status() === 200 && (pr.headers()["content-type"] || "").includes("application/pdf") && body.slice(0, 5).toString() === "%PDF-");
  const cr = await r.request.get(S.base + `/api/reports/R-${caseId}-r1.csv`);
  const ct = await cr.text(); check("approved report downloads as CSV", cr.status() === 200 && ct.includes('"claim"') && ct.includes('"conclusion"')); }
await r.goto(S.base + "/#/review?s=approved"); await r.waitForSelector(`tr[data-id="${caseId}"]`, { timeout: 10000 });
check("review queue lists cases by review status", (await r.textContent("nav.tabs")).includes("Needs additional evidence") && (await r.textContent("nav.tabs")).includes("Rejected"));
await r.click('a[href="#/reports"]'); await r.waitForSelector("table.t");
await shot(r, "09-reports");
await r.click('a[href="#/archive"]'); await r.waitForSelector(".arec"); await shot(r, "10-archive");
await r.click('a[href="#/dashboard"]'); await r.waitForSelector(".kpis"); await shot(r, "11-dashboard");
check("dashboard counts come from records", (await r.textContent(".kpis")).includes("Approved") && /\b1\b/.test(await r.textContent(".kpi:last-child .v")));
// ---- admin
const ad = await session("admin");
await ad.click('.nav a[href="#/settings"]'); await ad.waitForSelector('a[href="#/status"]'); check("Settings lists the hidden tools and links to administration", (await ad.textContent("#page")).includes("Other tools") && (await ad.textContent("#page")).includes("Reference archive"));
await ad.click('#page a[href="#/models"]'); await ad.waitForSelector("table.cm");
check("AI models shows the trained classifier with its data source, test scores, baselines and confusion matrix", (await ad.textContent("#page")).includes("TweetEval") && (await ad.textContent("#page")).includes("Word list used before") && (await ad.$$("table.cm td")).length === 9);
await ad.fill("form[data-try] textarea", "The new hospital is wonderful and the nurses were so kind"); await ad.click("form[data-try] button"); await ad.waitForFunction(() => /positive/.test(document.querySelector(".tryout")?.textContent || ""));
check("the model can be tried on any sentence and explains which words weighed most", (await ad.textContent(".tryout")).includes("Words that pushed"));
await shot(ad, "12a-ai-models");
await ad.goto(S.base + "/#/settings"); await ad.waitForSelector('#page a[href="#/admin"]');
await ad.click('#page a[href="#/admin"]'); await ad.waitForSelector("text=User accounts"); await shot(ad, "12-admin-users");
await ad.click('a[href="#/admin/integrations"]'); await ad.waitForSelector("text=AI not configured"); await shot(ad, "13-admin-integrations");
check("integrations show AI not configured", true);
await ad.click('a[href="#/admin/audit"]'); await ad.click("#vb"); await ad.waitForSelector("text=Intact");
check("audit chain verifies in the UI", true);
await ad.click('a[href="#/admin/usage"]'); await ad.waitForSelector("text=Database"); await shot(ad, "13b-admin-usage");
await ad.click('a[href="#/admin/backups"]'); await ad.click("#bkNow"); await ad.waitForSelector("text=new file(s)");
check("administrator can make a backup from the UI", (await ad.textContent("#page")).includes("aivs-"));
await shot(ad, "13c-admin-backups");
await ad.click('a[href="#/admin/training"]'); await ad.click("#seed"); await ad.waitForSelector("text=already loaded");
await ad.click('[data-scope="training"]'); await ad.waitForSelector(".trainbar");
await ad.goto(S.base + "/#/cases"); await ad.waitForSelector("table.t");
check("training cases are listed separately", (await ad.textContent("table.t")).includes("TR-0001") && !(await ad.textContent("table.t")).includes(caseId));
await shot(ad, "14-training-cases");
await ad.setViewportSize({ width: 390, height: 900 }); await ad.click('a[href="#/dashboard"]'); await ad.waitForSelector(".kpis");
check("no horizontal scroll at phone width", (await ad.evaluate(() => document.documentElement.scrollWidth)) <= 392);
await shot(ad, "15-mobile");
// ---- refresh recovery, notes, filtered dashboard tiles, archive bundle UI, button audit
await a.goto(S.base + `/#/case/${caseId}/notes`); await a.waitForSelector("#nb");
await a.fill("#nb", "Handover: press office contacted at 10:40, reply pending."); await a.click("#nbAdd"); await a.waitForSelector("text=Note added");
await a.reload(); await a.waitForSelector(".note-item");
check("refresh restores the case, tab and saved note", (await a.textContent(".casehead")).includes(caseId) && (await a.textContent(".tabs .on")).includes("Notes") && (await a.textContent(".notes")).includes("press office contacted"));
await r.goto(S.base + `/#/case/${caseId}/notes`); await r.waitForSelector(".note-item");
check("reviewer sees the analyst's note under the analyst's account name", (await r.textContent(".note-item")).includes("ANA"));
await shot(r, "16-notes");
await r.goto(S.base + "/#/dashboard"); await r.waitForSelector(".kpis");
check("dashboard shows recently updated cases", (await r.textContent("#page")).includes("Recently updated cases"));
await r.click(".kpi >> text=Open cases"); await r.waitForSelector("#fs");
check("dashboard tile opens the matching filtered list", (await r.inputValue("#fs")).startsWith("draft,analysing"));
await r.goto(S.base + "/#/archive"); await r.waitForSelector("#impA");
const bundle = await r.evaluate(async () => { const x = await fetch("/api/archive/export?training=0"); return { status: x.status, cd: x.headers.get("content-disposition"), text: await x.text() }; });
check("archive export downloads a bundle", bundle.status === 200 && /attachment/.test(bundle.cd) && JSON.parse(bundle.text).records.length >= 1);
await r.setInputFiles("#impF", { name: "aivs-archive.json", mimeType: "application/json", buffer: Buffer.from(bundle.text) });
await r.waitForSelector("text=Archive import finished");
check("archive import reports duplicates instead of re-adding them", (await r.textContent(".modal")).includes("same image already in the archive"));
await shot(r, "17-archive-import"); await r.click(".modal [data-x]");
// ---- Phase 1: Verify Information, guided mode, search & check, privacy
await a.goto(S.base + "/#/verify"); await a.waitForSelector("#vi");
await a.click("#vgo"); await a.waitForSelector("#verr:not([hidden])");
check("empty verify input shows a visible message", (await a.textContent("#verr")).includes("Paste"));
await a.fill("#vi", "example.org/news/story"); await a.click("#vgo"); await a.waitForSelector("#verr:not([hidden])");
check("a bare web address is explained, not silently treated as text", (await a.textContent("#verr")).includes("https://"));
await a.evaluate(() => { const d = [...document.querySelectorAll("details")].find(x => x.textContent.includes("practice text")); d.open = true; }); await a.click('[data-sample="2"]'); await a.click("#vgo"); await a.waitForSelector("#vres .claimlist", { timeout: 30000 });
const vtxt = await a.textContent("#vres");
check("pasted text becomes a case with claims and opinion/prediction hints", /Case C-\d{4}-\d{4} created/.test(vtxt) && vtxt.includes("opinion") && vtxt.includes("prediction"));
await shot(a, "18-verify");
await a.goto(S.base + "/#/verify"); await a.waitForSelector("#vi"); await a.fill("#vi", "http://127.0.0.1:9/private"); await a.click("#vgo"); await a.waitForSelector("#verr:not([hidden])", { timeout: 20000 });
check("links to local addresses are refused with an explanation", (await a.textContent("#verr")).includes("private or local network"));
await a.click('[data-mode="guided"]'); await a.waitForSelector('[data-mode="guided"].on');
await a.goto(S.base + "/#/verify"); await a.waitForSelector("#vi"); await a.evaluate(() => { const d = [...document.querySelectorAll("details")].find(x => x.textContent.includes("practice text")); d.open = true; }); await a.click('[data-sample="0"]'); await a.click("#vgo"); await a.waitForSelector("#vres a.btn.primary", { timeout: 30000 });
await a.click("#vres a.btn.primary"); await a.waitForSelector(".gsteps");
check("guided mode shows the case in four steps with one main action", (await a.$$(".gsteps li")).length === 4 && (await a.$$(".gnav .btn.primary")).length === 1 && /\/step2$/.test(await a.evaluate(() => location.hash)));
{ const vid = (await a.evaluate(() => location.hash)).match(/C-\d{4}-\d{4}/)[0];
  await a.goto(S.base + `/#/case/${vid}/claims`); await a.waitForSelector("#srchAll"); await a.click("#srchAll"); await a.waitForSelector(".modal", { timeout: 20000 });
  const mt = await a.textContent(".modal");
  check("evidence search reports unconfigured services instead of inventing results", mt.includes("AIVS knowledge base") && mt.includes("Earlier AIVS investigations") && !/https?:\/\//.test(mt));
  await shot(a, "19c-evidence-search"); await a.click(".modal .btn.primary");
  await a.goto(S.base + `/#/case/${vid}/evidence`); await a.waitForSelector(".ev");
  check("red-flag leads explain which official source to check", /official|Ministry of Health|health\.go\.ke/i.test(await a.textContent("#tabBody")));
  await a.goto(S.base + `/#/case/${vid}`); await a.waitForSelector(".gsteps"); }
{ const sid = vtxt.match(/Case (C-\d{4}-\d{4}) created/)[1]; await a.goto(S.base + `/#/case/${sid}/claims`); await a.waitForSelector(".claim");
  const ct = await a.textContent("#tabBody");
  check("opinion and prediction claims carry an explanation", ct.includes("Looks like an opinion") && ct.includes("Looks like a prediction"));
  await shot(a, "19b-claim-types"); await a.goBack(); await a.waitForSelector(".gsteps"); }
await shot(a, "19-guided-case");
await a.click('[data-mode="advanced"]'); await a.waitForSelector('[data-mode="advanced"].on');
await a.waitForSelector(".tabs");
check("advanced mode shows every tool instead of the steps and keeps the setting", !(await a.$(".gsteps")) && (await a.evaluate(async () => (await (await fetch("/api/me")).json()).user.ui_mode)) === "advanced");
await a.goto(S.base + "/#/search?q=malaria"); await a.waitForSelector("#sr .results", { timeout: 10000 });
check("search finds the verified text", (await a.textContent("#sr")).includes("malaria"));
await a.setInputFiles("#cfi", "training/images/case_convoy.jpg"); await a.waitForSelector("#cres .results, #cres .callout", { timeout: 20000 });
check("image check reports earlier copies without creating a case", (await a.textContent("#cres")).includes("Identical file"));
await shot(a, "20-search-check");
await a.goto(S.base + "/#/privacy"); await a.waitForSelector(".prose");
check("privacy notice explains what leaves the server", (await a.textContent(".prose")).includes("What leaves the server"));
// information operations monitor: synthetic sample, signals, network
await a.goto(S.base + "/#/monitor"); await a.waitForSelector("#ioSample"); await shot(a, "21-monitor-empty");
await a.click("#ioSample"); await a.waitForSelector(".kpis", { timeout: 30000 });
const ioId = (await a.evaluate(() => location.hash)).match(/monitor\/(\d+)/)[1];
check("dataset opens on the analysis overview", (await a.textContent(".kpis")).includes("Coordination indicators") && (await a.textContent("#fbar")).includes("Apply filters"));
await a.click(`a[href="#/monitor/${ioId}/summary"]`); await a.waitForFunction(() => /What to look at first/.test(document.querySelector("#tabBody")?.textContent || ""));
check("monitor finds the planted synchronised message", /Synchronised messages\s*1(?!\d)/.test(await a.textContent(".kpis")) && (await a.textContent("#tabBody")).includes("What to look at first"));
await shot(a, "22-monitor-summary");
await a.goto(S.base + `/#/monitor/${ioId}/messages`); await a.waitForSelector(".quote");
check("repeated messages show synchronisation and platforms", (await a.textContent("#tabBody")).includes("synchronised") && (await a.textContent("#tabBody")).includes("SampleNet"));
await shot(a, "23-monitor-messages");
await a.goto(S.base + `/#/monitor/${ioId}/network`); await a.waitForSelector("svg circle");
check("network diagram draws the linked accounts", (await a.$$eval("svg circle", c => c.length)) === 14);
await shot(a, "24-monitor-network");
await a.goto(S.base + `/#/monitor/${ioId}/hashtags`); await a.waitForSelector("table.t");
check("hashtag bursts are listed", (await a.textContent("#tabBody")).includes("#samplewaterscandal"));
await a.goto(S.base + `/#/monitor/${ioId}/posts?account=newvoice_01`); await a.waitForSelector("table.t tbody tr");
check("posts can be filtered by account", (await a.$$eval("table.t tbody tr", r => r.length)) === 2);
// screenshots of posts: make two post pictures, read them, check the rows, import
{ const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-shots-")), pg = await a.context().newPage();
  const card = (name, when, text) => `<html><body style="margin:0;background:#fff;font:22px Arial"><div style="width:620px;padding:24px"><div style="font-weight:bold">${name}</div><div style="color:#555;font-size:18px">${when}</div><p>${text}</p><div style="color:#555;font-size:18px">Like &nbsp; Comment &nbsp; Share</div></div></body></html>`;
  const files = [];
  for (const [i, n, w, t] of [[1, "Kenya News Updates", "October 21 at 3:45 PM", "The water project funds have disappeared, demand answers now"], [2, "County Voices", "October 21 at 3:47 PM", "The water project funds have disappeared, demand answers now"]]) {
    await pg.setContent(card(n, w, t)); const f = path.join(shotDir, `post${i}.png`); await pg.screenshot({ path: f, clip: { x: 0, y: 0, width: 668, height: 220 } }); files.push(f); }
  await pg.close();
  await a.goto(S.base + "/#/monitor"); await a.waitForSelector("#iof");
  await a.setInputFiles("#iof", files); await a.fill("#ion", "Screenshots test"); await a.fill("#ios", "Screenshots collected by analyst"); await a.fill("#ioa", "Public posts, test");
  await a.click("#ioGo"); await a.waitForSelector("#shotGo", { timeout: 120000 });
  const acc = await a.inputValue("#a0"), txt = await a.inputValue("#x0"), at = await a.inputValue("#t0");
  check("screenshots: account, time and text are read for checking", /kenya news/i.test(acc) && /water project/i.test(txt) && /-10-21T15:45/.test(at), `${acc} | ${at} | ${txt.slice(0, 40)}`);
  await shot(a, "25-monitor-screenshots");
  await a.click("#shotGo"); await a.waitForSelector(".kpis", { timeout: 30000 });
  check("checked screenshot posts become a dataset", (await a.textContent(".kpis .kpi .v")).trim() === "2" && (await a.textContent(".casehead")).includes("Screenshots test"));
  check("a small dataset explains that there is too little to compare", (await a.textContent("#tabBody")).includes("Too few posts"));
  // add a third screenshot to the same dataset: three accounts within minutes become a signal
  const pg2 = await a.context().newPage(); await pg2.setContent(card("Nairobi Daily", "October 21 at 3:46 PM", "The water project funds have disappeared, demand answers now")); const f3 = path.join(shotDir, "post3.png"); await pg2.screenshot({ path: f3, clip: { x: 0, y: 0, width: 668, height: 220 } }); await pg2.close();
  await a.click("#addPosts"); await a.waitForSelector("#apf"); await a.setInputFiles("#apf", [f3, files[0]]); await a.click(".modal .btn.primary");
  await a.waitForSelector("#shotGo", { timeout: 120000 }); await a.click("#shotGo"); await a.waitForSelector(".kpis", { timeout: 30000 }); await a.waitForTimeout(500);
  const addedId = (await a.evaluate(() => location.hash)).match(/monitor\/(\d+)/)[1]; const posts3 = (await a.textContent(".kpis .kpi .v")).trim();
  await a.goto(S.base + `/#/monitor/${addedId}/summary`); await a.waitForFunction(() => /What to look at first/.test(document.querySelector("#tabBody")?.textContent || ""));
  check("posts can be added to a dataset; duplicates are skipped and the signal appears", posts3 === "3" && /Synchronised messages\s*1(?!\d)/.test(await a.textContent("#tabBody .kpis")));
  await shot(a, "26-monitor-added");
}
// ---- Social media analysis dashboard: synthetic discussion sample, filters, tabs, claims, report
let discId;
{ await a.goto(S.base + "/#/monitor"); await a.waitForSelector("#ioDisc");
  check("dashboard shows collection status and local AI status honestly", (await a.textContent("#page")).includes("Pending access") && (await a.textContent("#page")).includes("Local AI (Ollama)") && (await a.textContent("#page")).includes("Not configured"));
  await shot(a, "27-social-list");
  await a.click("#ioDisc"); await a.waitForSelector("#fbar", { timeout: 60000 }); discId = (await a.evaluate(() => location.hash)).match(/monitor\/(\d+)/)[1];
  const all = +(await a.textContent(".kpis .kpi .v")).replace(/\D/g, "");
  check("overview: posts, tone, claims and themes from stored records", all > 150 && (await a.textContent("#page")).includes("Growing late in the period") && (await a.textContent("#page")).includes("Security and defence"));
  await shot(a, "28-social-overview");
  await a.selectOption("#ff_platform", "SampleTube"); await a.click("#fbar button[type=submit]"); await a.waitForFunction(() => /platform=SampleTube/.test(location.hash) && document.querySelector("#fbar"));
  await a.waitForSelector("#fbar .sub"); const some = +(await a.textContent(".kpis .kpi .v")).replace(/\D/g, "");
  check("a platform filter updates the figures", some > 0 && some < all && (await a.textContent("#fbar")).includes(`of ${all.toLocaleString()} posts match`), `${some} of ${all}`);
  await a.click(`nav.tabs a[href^="#/monitor/${discId}/sentiment"]`); await a.waitForSelector("#evalLink");
  check("sentiment tab keeps the filter and shows tone over time", (await a.evaluate(() => location.hash)).includes("platform=SampleTube") && (await a.$$("#tabInner svg rect")).length > 5);
  await a.click("#evalLink"); await a.waitForSelector(".modal"); check("measured accuracy of the tone estimate is shown with its caveat", (await a.textContent(".modal")).includes("optimistic")); await a.click(".modal .btn");
  await shot(a, "29-social-sentiment");
  await a.goto(S.base + `/#/monitor/${discId}/topics`); await a.waitForSelector("#cmpGo"); await a.click("#cmpGo"); await a.waitForSelector("#cmpOut table");
  check("topics: themes, keyword clusters and a working comparison", (await a.textContent("#tabInner")).includes("Topics found in this dataset") && (await a.$$("#cmpOut polyline")).length === 2);
  await shot(a, "30-social-topics");
  await a.goto(S.base + `/#/monitor/${discId}/engagement`); await a.waitForSelector("#engChart");
  check("engagement: totals, top content and the unusual-engagement indicator", (await a.textContent("#tabInner")).includes("Content with the most engagement") && /1 post has engagement/.test(await a.textContent("#tabInner")));
  await a.goto(S.base + `/#/monitor/${discId}/geography`); await a.waitForSelector("#gmap svg");
  check("geography separates data-field, self-reported and text locations", (await a.textContent("#tabInner")).includes("Self-reported profile") && (await a.textContent("#tabInner")).includes("Places named in the text"));
  await a.click('[data-gb="text"]'); await shot(a, "31-social-geography");
  await a.goto(S.base + `/#/monitor/${discId}/claims?status=needs_review`); await a.waitForSelector("[data-cc]");
  check("claims needing review are listed with their red flags", (await a.textContent("#tabInner")).includes("Red flags") && (await a.textContent("#tabInner")).includes("Needs review"));
  await shot(a, "32-social-claims");
  await a.click("[data-cc]"); await a.waitForSelector(".modal"); await a.click(".modal .btn.primary"); await a.waitForFunction(() => /#\/case\/TR-/.test(location.hash));
  check("a claim opens a training verification case", /TR-\d{4}/.test(await a.evaluate(() => location.hash)));
  await a.goto(S.base + `/#/monitor/${discId}/report`); await a.waitForSelector('[data-rf="pdf"]');
  const pdfHref = await a.getAttribute('[data-rf="pdf"]', "href"), resp = await a.request.get(S.base + pdfHref);
  check("report downloads as PDF from stored records", resp.status() === 200 && (await resp.body()).subarray(0, 4).toString() === "%PDF");
  await a.goto(S.base + `/#/monitor/${discId}/overview`); await a.waitForSelector("#fbar"); await a.goto(S.base + `/#/monitor/${discId}/report`); await a.waitForSelector('[data-rf="pdf"]');
  check("generated reports are listed for download again", /#\d+/.test(await a.textContent("#tabInner")) && (await a.textContent("#tabInner")).includes("SHA-256"));
  await a.goto(S.base + `/#/monitor/${discId}/posts?sentiment=negative`); await a.waitForSelector("table.t tbody tr");
  check("posts list honours the tone filter and shows provenance", (await a.$$eval("table.t tbody tr", r => r.every(x => x.textContent.includes("Negative")))) && (await a.textContent("#tabInner")).includes("Provenance"));
}
// ---- Social media analysis: one post, from a link (public embed) and from a screenshot
{ await a.goto(S.base + "/#/verify"); await a.waitForSelector("#vi");
  await a.fill("#vi", "https://x.com/practice_desk/status/1849000000000000000"); await a.waitForSelector("#toPost");
  check("Verify explains that a social link is a post, not a web page", (await a.textContent("#vhint")).includes("Check it as a social media post"));
  await a.click("#vgo"); await a.waitForSelector("#pst .callout", { timeout: 20000 }); await a.waitForFunction(() => !document.querySelector("#pst .spin"));
  check("post link: looked up through the public embed and the fields filled in", (await a.inputValue("#ptx")).startsWith("The water project funds") && (await a.inputValue("#pa")) === "@practice_desk" && (await a.inputValue("#pp")) === "X (Twitter)" && (await a.inputValue("#pt")).startsWith("2024-10-23") && (await a.textContent("#pst")).includes("Post found"));
  await shot(a, "26b-post-lookup");
  await a.click("#pgo"); await a.waitForSelector("#vres .claimlist", { timeout: 30000 });
  const pr = await a.textContent("#vres");
  check("post case: source, archived embed answer and dataset comparison shown", /Case C-\d{4}-\d{4} created/.test(pr) && pr.includes("X public embed (oEmbed)") && pr.includes("archived") && pr.includes("Account and message in your post datasets") && /from \d+ accounts?/.test(pr));
  await shot(a, "26c-post-case");
  // a deleted post: the failure is shown and nothing is filled in as if it were found
  await a.click("#vagain"); await a.waitForSelector("#pu"); check("“Verify something else” starts an empty post form", (await a.inputValue("#ptx")) === "" && (await a.inputValue("#pu")) === "");
  await a.fill("#pu", "https://x.com/practice_desk/status/1849000000000000000"); await a.click("#plook"); await a.waitForFunction(() => /Post found/.test(document.querySelector("#pst")?.textContent || ""), null, { timeout: 20000 });
  await a.fill("#pu", "https://x.com/someone/status/1849000000000000999"); await a.click("#plook");
  await a.waitForFunction(() => document.querySelector("#pst .callout") && !document.querySelector("#pst .spin"), null, { timeout: 20000 });
  check("a post the platform cannot return is reported, with no invented text", (await a.textContent("#pst")).includes("could not be retrieved") && (await a.inputValue("#ptx")) === "" && (await a.inputValue("#pa")) === "@someone", `${await a.textContent("#pst")} | ${await a.inputValue("#ptx")} | ${await a.inputValue("#pa")}`);
  await a.click("#pgo"); await a.waitForSelector("#perr:not([hidden])");
  check("a post without words is not submitted", (await a.textContent("#perr")).includes("words of the post"));
  // Facebook without a Meta token: the lookup is shown as not configured
  await a.fill("#pu", "https://www.facebook.com/somepage/posts/123"); await a.waitForTimeout(200);
  check("Facebook lookup is shown as not configured, with what it needs", (await a.textContent("#pav")).includes("Not configured") && (await a.textContent("#pav")).includes("META_OEMBED_TOKEN") && await a.isDisabled("#plook"));
  // a screenshot only: the words, account and time are read in the browser
  await a.goto(S.base + "/#/status"); await a.waitForSelector(".module"); await a.click('.module[data-mod="social"] a[href="#/verify/post"]'); await a.waitForSelector("#pdz");
  const sDir = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-post-")), spg = await a.context().newPage(), sf = path.join(sDir, "post.png");
  await spg.setContent(`<html><body style="margin:0;background:#fff;font:22px Arial"><div style="width:620px;padding:24px"><div style="font-weight:bold">Kenya News Updates</div><div style="color:#555;font-size:18px">October 21 at 3:45 PM</div><p>The water project funds have disappeared, demand answers now</p><div style="color:#555;font-size:18px">Like &nbsp; Comment &nbsp; Share</div></div></body></html>`);
  await spg.screenshot({ path: sf, clip: { x: 0, y: 0, width: 668, height: 220 } }); await spg.close();
  await a.setInputFiles("#pfi", sf); await a.waitForFunction(() => /Text read/.test(document.querySelector("#pul")?.textContent || ""), null, { timeout: 120000 });
  check("post screenshot: words, account and time read for checking", /water project/i.test(await a.inputValue("#ptx")) && /kenya news/i.test(await a.inputValue("#pa")) && /-10-21T15:45/.test(await a.inputValue("#pt")));
  await a.click("#pgo"); await a.waitForSelector("#vres .claimlist", { timeout: 30000 });
  const sr = await a.textContent("#vres");
  check("screenshot post case: file stored, OCR named as the source, account found in the dataset", sr.includes("1 file stored unchanged") && sr.includes("OCR") && /has \d+ posts? in/.test(sr));
  await shot(a, "26d-post-screenshot-case");
}
// documents in a case: a text PDF and a scanned PDF (read with OCR in the browser)
{ const dDir = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-docs-")), { default: PDFDocument } = await import("pdfkit");
  const mk = (file, fn, info = {}) => new Promise(ok => { const d = new PDFDocument({ info }), w = fs.createWriteStream(file); d.pipe(w); fn(d); d.end(); w.on("finish", ok); });
  await mk(path.join(dDir, "circular.pdf"), d => d.fontSize(13).text("MINISTRY OF DEFENCE\nRECRUITMENT NOTICE\nThe Kenya Defence Forces will recruit 5,000 youths on 30 October 2026. Applicants must send KSh 1,500 via M-Pesa to 0712 345 678 to register."), { Author: "John Doe", Creator: "Microsoft Word 2016", CreationDate: new Date(Date.UTC(2026, 0, 2)) });
  const pg = await a.context().newPage(); await pg.setContent(`<body style="margin:0;background:#fff"><div style="width:800px;padding:40px;font:28px Arial">COUNTY NOTICE<br><br>All schools in Garissa will close on Monday because of floods.</div></body>`);
  const png = path.join(dDir, "scan.png"); await pg.screenshot({ path: png, clip: { x: 0, y: 0, width: 880, height: 260 } }); await pg.close();
  await mk(path.join(dDir, "scanned.pdf"), d => d.image(png, 40, 40, { width: 520 }));
  const did = await a.evaluate(async () => (await (await fetch("/api/cases", { method: "POST", headers: { "content-type": "application/json", "x-aivs": "1" }, body: JSON.stringify({ claim_text: "A circular says KDF is recruiting and applicants must pay a fee." }) })).json()).id);
  await a.goto(S.base + `/#/case/${did}/media`); await a.waitForSelector("#fi", { state: "attached" });
  await a.setInputFiles("#fi", [path.join(dDir, "circular.pdf"), path.join(dDir, "scanned.pdf")]); await a.waitForSelector(".docicon", { timeout: 30000 }); await a.waitForTimeout(800);
  const mt = await a.textContent("#tabBody");
  check("documents show their properties and text", mt.includes("John Doe") && mt.includes("RECRUITMENT NOTICE") && mt.includes("Microsoft Word 2016"));
  check("a scanned PDF is recognised and offers OCR", mt.includes("looks like a scanned document") && !!(await a.$("[data-dococr]")));
  await a.click("[data-dococr]"); await a.waitForSelector("[data-ocrtext]", { timeout: 180000 });
  check("scanned pages are read with OCR", /schools in Garissa/i.test(await a.inputValue("[data-ocrtext]")));
  await shot(a, "27-case-documents");
  await a.click("[data-docclaims]"); await a.waitForTimeout(1200);
  await a.goto(S.base + `/#/case/${did}/claims`); await a.waitForSelector(".claim");
  check("claims can be proposed from a document", /M-Pesa|recruit/i.test(await a.textContent("#tabBody")));
  // research assistant: rule-based answers with record links; AI disabled when not configured
  await a.goto(S.base + `/#/case/${did}/assistant`); await a.waitForSelector("#askGo");
  check("assistant: AI is shown as unavailable when not configured", await a.$eval('[data-mode="ai"]', b => b.disabled));
  await a.click('[data-q="What is missing?"]'); await a.waitForSelector(".am.bot .amtext", { timeout: 15000 });
  check("assistant: rule-based answer with links to the cited records", (await a.textContent(".am.bot")).includes("What is missing") && (await a.$$(".am.bot a.chip")).length > 0);
  await a.fill("#aq", "Kinakosekana nini katika kesi hii?"); await a.click("#askGo"); await a.waitForFunction(() => document.querySelectorAll(".am.bot").length >= 2, null, { timeout: 15000 });
  check("assistant: answers in Kiswahili when asked in Kiswahili", (await a.$$eval(".am.bot", x => x.at(-1).textContent)).includes("Kinachokosekana"));
  await shot(a, "28-assistant");
  // New case: take the text from a document instead of pasting; the document is attached automatically
  await a.goto(S.base + "/#/new"); await a.waitForSelector("#ff", { state: "attached" });
  await a.setInputFiles("#ff", path.join(dDir, "circular.pdf")); await a.waitForFunction(() => /RECRUITMENT NOTICE/.test(document.querySelector("#cl").value), null, { timeout: 30000 });
  check("new case: text can be taken from a document", (await a.textContent("#ffNote")).includes("Text taken from circular.pdf"));
  await a.click("#n1"); await a.waitForSelector(".uplist .st b", { timeout: 30000 });
  check("new case: the document is attached automatically", (await a.textContent(".uplist")).includes("Stored as"));
  // if the server cannot read a PDF, the browser reads it instead
  await a.route("**/api/extract-text", r => r.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "The PDF could not be read (simulated server failure)." }) }));
  await a.goto(S.base + "/#/status"); await a.waitForSelector(".module"); await a.goto(S.base + "/#/new"); await a.waitForSelector("#ff", { state: "attached" });
  await a.setInputFiles("#ff", path.join(dDir, "circular.pdf")); await a.waitForFunction(() => /RECRUITMENT NOTICE/.test(document.querySelector("#cl").value) || /could not|rror|failed/i.test(document.querySelector("#ffNote").textContent), null, { timeout: 30000 });
  check("new case: a PDF the server cannot read is read in the browser", (await a.textContent("#ffNote")).includes("Read in your browser"));
  await a.unroute("**/api/extract-text");
}
// datasets: synthetic practice set, approval by a second person, records and measurement
await a.goto(S.base + "/#/datasets"); await a.waitForSelector("#ksample").catch(() => {});
if (await a.$("#ksample")) { check("analysts cannot import datasets (button hidden)", false); }
{ const rp = await session("rev"); await rp.goto(S.base + "/#/datasets"); await rp.waitForSelector("#ksample"); await rp.click("#ksample"); await rp.waitForSelector(".kpis");
  const kid = (await rp.evaluate(() => location.hash)).match(/datasets\/(\d+)/)[1];
  check("dataset shows licence, splits and labels", /Synthetic data created by AIVS/.test(await rp.textContent(".casehead")) && /training \/ validation \/ test/.test(await rp.textContent(".kpis")));
  check("a new dataset waits for a second person's approval", (await rp.textContent(".casehead")).includes("Waiting for a second person") && !(await rp.$("#kap")) && (await rp.textContent(".casehead")).includes("Imported by REV"));
  await shot(rp, "29-dataset"); await rp.close();
  const ap = await session("admin"); await ap.goto(S.base + `/#/datasets/${kid}`); await ap.waitForSelector("#kap"); await ap.click("#kap"); await ap.click(".modal .btn.primary"); await ap.waitForSelector("#kret");
  check("a second person approves the dataset for search", (await ap.textContent(".casehead")).includes("Approved: searched")); await ap.close(); }
// every visible, enabled button must be wired to an action
// ---- research assistant on Ollama (a stand-in server answering in the required format), then the same server stopped
{ let up = true;
  const fo = http.createServer(async (req, res) => { let body = ""; for await (const c of req) body += c; const js = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!up) { req.socket.destroy(); return; }
    if (req.url === "/api/tags") return js(200, { models: [{ name: "qwen3:4b-instruct" }] });
    const j = JSON.parse(body); if (!j.format) return js(200, { message: { content: "OK" } });
    const ids = [...j.messages.at(-1).content.matchAll(/<source id="([^"]+)"/g)].map(m => m[1]), c0 = ids[0], e0 = ids.find(i => i.startsWith("E-")) || c0;
    js(200, { model: j.model, message: { content: JSON.stringify({ answer: `The post announces a road closure [${c0}].`, facts: [{ text: "The post says the road closes on 3 March", sources: [c0] }, { text: "An invented ministry confirmation", sources: ["E-999999"] }], missing: [{ text: "No independent confirmation yet" }], suggestions: [{ text: "Call the county roads office", sources: [] }], timeline: [] }) }, prompt_eval_count: 900, eval_count: 120, total_duration: 3e9 }); });
  await new Promise(ok => fo.listen(0, "127.0.0.1", ok));
  const SA = await startServer({ ai: { provider: "ollama", baseUrl: `http://127.0.0.1:${fo.address().port}`, model: "qwen3:4b-instruct", timeoutMs: 3000, healthTimeoutMs: 3000, numCtx: 4096, trainingOnly: true, maxImages: 6 } });
  const ax = await login(SA.base, "ana"), cid = (await ax.post("/api/cases", { claim_text: "PUBLIC NOTICE: the Garissa road will be closed for repairs from 3 March 2025. Share widely." })).body.id;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }), p = await ctx.newPage();
  p.on("pageerror", e => errors.push(`assistant: ${e.message}`));
  await p.goto(SA.base); await p.fill("#lu", "ana"); await p.fill("#lp", PW); await p.click("#lb"); await p.waitForSelector(".shell");
  await p.goto(SA.base + `/#/case/${cid}/assistant`); await p.waitForSelector("#aiChip .chip.sup", { timeout: 20000 });
  check("assistant shows AI available only after a real connection check", (await p.textContent("#aiChip")).includes("AI available") && (await p.textContent("#aiHealth")).includes("the model answered"));
  await p.fill("#aq", "Summarise the evidence"); await p.click("#askGo"); await p.waitForSelector(".am.bot .amtext", { timeout: 20000 });
  const t = await p.textContent("#chat");
  check("an AI answer separates facts from suggestions and links its citations", t.includes("Facts from the case records") && t.includes("suggestions, not findings") && (await p.$$(".am.bot a.chip.info")).length >= 1);
  check("a fact citing a record that does not exist is removed and explained", t.includes("Removed by AIVS checks") && !/- An invented ministry/.test(await p.innerText(".am.bot .amtext")));
  await shot(p, "33-assistant-ollama");
  up = false; await p.click("#aiCheck"); await p.waitForSelector("#aiChip .chip.con", { timeout: 20000 });
  check("when the Ollama server stops, the assistant says AI is unavailable and why", (await p.textContent("#aiHealth")).includes("Connection check failed"));
  await p.click('[data-mode="rules"]'); await p.fill("#aq", "What is missing?"); await p.click("#askGo"); await p.waitForFunction(() => document.querySelectorAll(".am.bot").length >= 2, null, { timeout: 20000 });
  check("rule-based answers keep working without the AI", (await p.textContent("#chat")).includes("What is missing"));
  await shot(p, "34-assistant-unavailable");
  const home = await (await p.goto(SA.base + "/#/status"), p.waitForSelector('.module[data-mod="assistant"]'));
  check("start page does not show the assistant as available after a failed check", (await p.textContent('.module[data-mod="assistant"]')).includes("Partly available"));
  await ctx.close(); await SA.close(); fo.close();
}
// ---- evidence coverage (1.14): per-claim view, exact locations, recorded gaps, suggestions, Kiswahili, small screens
{ const PDFDocument = (await import("pdfkit")).default;
  const pdfBuf = await new Promise(ok => { const d = new PDFDocument(), out = []; d.on("data", x => out.push(x)); d.on("end", () => ok(Buffer.concat(out))); d.text("SYNTHETIC bulletin page one: the crossing remained open."); d.addPage().text("SYNTHETIC page two: one lane closes for two days."); d.end(); });
  const tone = (() => { const n = 16000 * 4, data = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * 4000), i * 2);
    const fmt = Buffer.alloc(24); fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
    const dh = Buffer.alloc(8); dh.write("data", 0); dh.writeUInt32LE(data.length, 4); const body = Buffer.concat([Buffer.from("WAVE"), fmt, dh, data]), head = Buffer.alloc(8); head.write("RIFF", 0); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]); })();
  const ax = await login(S.base, "ana"), up = async (buf, name) => { const fd = new FormData(); fd.append("files", new Blob([buf]), name); return (await ax.post(`/api/cases/${cid}/media`, null, { form: fd })).body.media[0]; };
  const cid = (await ax.post("/api/cases", { title: "SYNTHETIC coverage e2e", claim_text: "SYNTHETIC: The bridge collapsed. Schools were closed.", source_platform: "WhatsApp" })).body.id;
  const doc = await up(pdfBuf, "bulletin.pdf"), aud = await up(tone, "voice.wav");
  await ax.post(`/api/cases/${cid}/analyse?wait=1`, {});
  const g = (await ax.get(`/api/cases/${cid}`)).body; for (const e of g.evidence.filter(x => x.status === "suggested")) await ax.patch(`/api/evidence/${e.id}`, { status: "dismissed" });
  for (const c of g.claims.filter(c => !c.removed)) await ax.del(`/api/claims/${c.id}`);
  const c1 = (await ax.post(`/api/cases/${cid}/claims`, { text: "SYNTHETIC: The bridge collapsed." })).body.id, c2 = (await ax.post(`/api/cases/${cid}/claims`, { text: "SYNTHETIC: Schools were closed." })).body.id;
  await ax.post(`/api/cases/${cid}/evidence`, { kind: "source_claim", text: "SYNTHETIC: Bulletin page 2 describes a lane closure only.", reference: "Bulletin p2", media_id: doc.id, loc_page: 2, links: [{ claim_id: c1, stance: "contradicts" }] });
  await ax.post(`/api/cases/${cid}/evidence`, { kind: "lead", text: "SYNTHETIC: Recording mentions schools at 0:01.", reference: "Recording", media_id: aud.id, loc_start_s: 1.5, loc_end_s: 3, links: [{ claim_id: c2, stance: "context" }] });
  await ax.post(`/api/cases/${cid}/evidence`, { kind: "inference", text: "SYNTHETIC: Schools often close in floods.", reference: "Analyst note", links: [{ claim_id: c2, stance: "context" }] });
  await ax.patch(`/api/claims/${c1}`, { assessment: "contradicted", rationale: "Bulletin." }); await ax.patch(`/api/claims/${c2}`, { assessment: "supported", rationale: "Assumed." });
  await a.setViewportSize({ width: 1440, height: 950 });
  await setMode(a, "guided");
  await a.goto(S.base + `/#/case/${cid}/step3`); await a.waitForSelector(".gclaim");
  check("guided step 3 says beside the claim that its verdict is not backed by evidence", (await a.textContent(".gbody")).includes("is marked supported but no accepted evidence supports it"));
  await a.click('a:has-text("Next: Review and export")'); await a.waitForSelector(".gfix li");
  const fixRow = a.locator(".gfix li", { hasText: "no accepted evidence supports it" });
  check("step 4 lists what blocks submission, each with a link to fix it", (await fixRow.count()) === 1 && (await a.$eval("#gSubmit", b => b.disabled)));
  await fixRow.locator("a").click(); await a.waitForSelector(".gclaim.gflash");
  check("a fix link opens step 3 at the claim concerned", /\/step3$/.test(await a.evaluate(() => location.hash)));
  await setMode(a, "advanced");
  await a.goto(S.base + `/#/case/${cid}/overview`); await a.waitForSelector(".tabs");
  check("the Evidence coverage tab shows how many claims block submission", (await a.textContent(`.tabs a[href="#/case/${cid}/coverage"]`)).includes("1"));
  await a.click(`.tabs a[href="#/case/${cid}/coverage"]`); await a.waitForSelector("#covOverview");
  const ov = await a.textContent("#covOverview");
  check("case overview: submission blocked, with the approval rules' own reasons and the claims needing attention", ov.includes("Submission is blocked") && ov.includes("is marked supported but no accepted evidence supports it") && ov.includes("Claims that need attention"));
  check("a claim marked supported without supporting evidence stays visibly flagged", (await a.$$(".covclaim.flagged")).length === 1 && (await a.textContent(".covclaim.flagged")).includes("Flagged"));
  await shot(a, "38-coverage");
  await a.click("[data-page]"); await a.waitForSelector(".modal pre");
  check("a document reference opens the cited page's text", (await a.textContent(".modal pre")).includes("one lane closes for two days"));
  await a.click(".modal [data-x]");
  await a.click("[data-play]"); await a.waitForSelector("#covPlayer"); await a.waitForFunction(() => document.querySelector("#covPlayer").currentTime >= 1.4, null, { timeout: 8000 }).catch(() => {});
  check("an audio reference opens the player at the cited time", await a.$eval("#covPlayer", p => p.currentTime >= 1.4 && p.currentTime < 3.5));
  await a.click(".modal [data-x]");
  check("evidence without an exact location says so", (await a.textContent(`#cov-${c2}`)).includes("Exact location not recorded"));
  await a.fill(`[data-addtext="${c2}"]`, "SYNTHETIC: Ask the county education office whether schools closed."); await a.selectOption(`[data-addkind="${c2}"]`, "next_step"); await a.click(`[data-add="${c2}"]`);
  await a.waitForSelector(`#cov-${c2} .covgap`);
  check("an analyst records a next step, shown with author", (await a.textContent(`#cov-${c2} .covgap`)).includes("ANA") && (await a.textContent(`#cov-${c2} .covgap`)).includes("Ask the county education office"));
  const nSug = (await a.$$(`#cov-${c1} [data-sacc]`)).length;
  await a.click(`#cov-${c1} [data-sacc]`); await a.waitForFunction(n => document.querySelectorAll(`[id^="cov-"] .covgap`).length >= 2, nSug, { timeout: 8000 });
  check("a rule-based suggestion is recorded only when accepted, then labelled as such", (await a.textContent(`#cov-${c1}`)).includes("accepted rule-based suggestion"));
  check("AI suggestions are disabled with the reason when AI is not configured", await a.isDisabled("#covAi") && (await a.textContent("#covOverview")).includes("not configured"));
  await a.click('[data-lang="sw"]'); await a.waitForFunction(() => document.querySelector("#tabBody h3")?.textContent === "Ushahidi kwa kila dai");
  check("labels switch to Kiswahili, including the approval rules", (await a.textContent("#covOverview")).includes("Uwasilishaji umezuiwa") && (await a.textContent("#covOverview")).includes("hakuna ushahidi uliokubaliwa unaoliunga mkono"));
  await shot(a, "39-coverage-sw");
  await a.click('[data-lang="en"]'); await a.waitForFunction(() => document.querySelector("#tabBody h3")?.textContent === "Evidence coverage");
  await a.setViewportSize({ width: 390, height: 844 }); await a.waitForTimeout(300);
  const wide = await a.evaluate(() => [...document.querySelectorAll("#tabBody *")].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map(e => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`));
  check("usable on a phone-sized screen (no sideways scrolling)", await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), wide.join(" | "));
  await shot(a, "40-coverage-phone");
  await a.setViewportSize({ width: 1440, height: 950 });
  const vp = await session("view"); await vp.goto(S.base + `/#/case/${cid}/coverage`); await vp.waitForSelector("#covOverview");
  check("viewers can read coverage but not record items", (await vp.$$("[data-add]")).length === 0 && (await vp.$$("[data-sacc]")).length === 0 && (await vp.textContent("#tabBody")).includes("You can read this view"));
  await vp.context().close();
}
// ---- account location (1.15): read from a screenshot's text, confirmed by the analyst, shown with its source
{ const ax = await login(S.base, "ana");
  const id = (await ax.post("/api/cases", { title: "SYNTHETIC Facebook page post", claim_text: "SYNTHETIC: post from a Facebook page.", source_platform: "Facebook", source_account: "Synthetic Page" })).body.id;
  const fd = new FormData(); fd.append("files", new Blob([fs.readFileSync("training/images/case_notice.jpg")]), "transparency.jpg");
  const m = (await ax.post(`/api/cases/${id}/media`, null, { form: fd })).body.media[0];
  await ax.post(`/api/media/${m.id}/ocr`, { engine: "test", lang: "eng", confidence: 90, text: "Page transparency\nPeople who manage this Page are primarily located in: Kenya" });
  await a.goto(S.base + `/#/case/${id}/overview`); await a.waitForSelector("#alCard");
  check("Facebook cases explain where the platform states the account location", (await a.textContent("#alCard")).includes("Page transparency"));
  await a.click("#alFind"); await a.waitForSelector("[data-aluse]");
  check("the location is found in the screenshot text and offered for confirmation", (await a.textContent("#alOut")).includes("Kenya"));
  await a.click("[data-aluse]"); await a.waitForFunction(() => document.querySelector("#alCard b")?.textContent === "Kenya");
  check("the confirmed location is shown with its source and caveat", (await a.textContent("#alCard")).includes("Facebook Page transparency") && (await a.textContent("#alCard")).includes("Not verified"));
  await shot(a, "41-account-location");
  const html = (await ax.get(`/api/cases/${id}/report.html`)).body;
  check("the report shows the account location with its source", html.includes("Account location:</b> Kenya"));
}
// ---- speech-to-text against a stand-in for the AIVS transcription service (same API as transcriber/aivs_transcribe.py)
{ const wav = (seconds = 8) => { const n = 16000 * seconds, data = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * 6000), i * 2);
    const fmt = Buffer.alloc(24); fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
    const dh = Buffer.alloc(8); dh.write("data", 0); dh.writeUInt32LE(data.length, 4); const body = Buffer.concat([Buffer.from("WAVE"), fmt, dh, data]), head = Buffer.alloc(8); head.write("RIFF", 0); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]); };
  const SEG = [{ start: 0.4, end: 3.2, text: "The county road will close on Monday.", confidence: 0.82, no_speech_prob: 0.02, unclear: false, reasons: [] }, { start: 3.6, end: 6.1, text: "Motorists should use the bypass.", confidence: 0.79, no_speech_prob: 0.03, unclear: false, reasons: [] },
    { start: 6.5, end: 7.4, text: "Thank you for watching.", confidence: 0.31, no_speech_prob: 0.4, unclear: true, reasons: ["low confidence", "typical text produced from noise"] }];
  const polls = new Map();
  const ft = http.createServer(async (req, res) => { for await (const _ of req); const js = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/health") return js(200, { ok: true, engine: "faster-whisper", model: "small", max_minutes: 120 });
    if (req.headers.authorization !== "Bearer e2e-token") return js(401, { detail: "Missing or wrong token." });
    if (req.method === "POST") { const id = `j${polls.size + 1}`; polls.set(id, 0); return js(202, { id, status: "queued", duration_s: 8 }); }
    const m = /^\/v1\/jobs\/([\w-]+)$/.exec(req.url); if (!m || !polls.has(m[1])) return js(404, { detail: "No such job." });
    if (req.method === "DELETE") return js(200, { ok: true });
    const n = polls.get(m[1]) + 1; polls.set(m[1], n);
    if (n < 4) return js(200, { status: "running", progress: n / 4 });
    js(200, { status: "done", progress: 1, result: { language: "en", language_probability: 0.94, language_basis: "detected automatically (94% likely)", engine: "faster-whisper", model: "small", segments: SEG, speech_found: true, dropped_non_speech: 0, processing_s: 2.4 } });
  });
  await new Promise(ok => ft.listen(0, "127.0.0.1", ok));
  const ST = await startServer({ transcribe: { url: `http://127.0.0.1:${ft.address().port}`, token: "e2e-token", pollMs: 400, timeoutMs: 30000 } });
  const ax = await login(ST.base, "ana"), cid = (await ax.post("/api/cases", { claim_text: "Voice note on WhatsApp: the county road will close on Monday." })).body.id;
  await ax.post(`/api/cases/${cid}/claims`, { text: "The county road will close on Monday." }); await ax.get("/api/transcribe/health");
  const wf = path.join(os.tmpdir(), `aivs-e2e-voice-${process.pid}.wav`); fs.writeFileSync(wf, wav());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }), p = await ctx.newPage();
  p.on("pageerror", e => errors.push(`transcribe: ${e.message}`)); p.on("console", m => m.type() === "error" && !/401|Failed to load resource/.test(m.text()) && errors.push(`transcribe: ${m.text()}`));
  await p.goto(ST.base); await p.fill("#lu", "ana"); await p.fill("#lp", PW); await p.click("#lb"); await p.waitForSelector(".shell");
  await p.goto(ST.base + "/#/status"); await p.waitForSelector('.module[data-mod="upload"]');
  check("start page shows Upload files as available only after the transcription service passed its check", (await p.textContent('.module[data-mod="upload"]')).includes("Available") && (await p.textContent('.module[data-mod="upload"]')).includes("machine transcripts"));
  await p.goto(ST.base + `/#/case/${cid}/media`); await p.waitForSelector("#utl");
  await p.selectOption("#utl", "auto"); await p.setInputFiles("#fi", wf);
  // the stand-in finishes in about 2 s, so the page may show the running job or already the finished transcript
  await p.waitForSelector(".tpanel", { timeout: 20000 });
  check("an uploaded voice note starts a background transcription", /T-0000\d\d/.test(await p.textContent(".tpanel")));
  await p.waitForSelector(".tpanel .progress, .tpanel .tseg", { timeout: 20000 });
  check("a progress indicator is shown while transcribing", (await p.$(".tpanel .progress")) !== null || (await p.$$(".tseg")).length > 0);
  await shot(p, "35-transcribing");
  await p.waitForSelector(".tseg", { timeout: 30000 });
  const tp = await p.textContent(".tpanel");
  check("the transcript is labelled machine-generated, with timestamps and unclear passages marked", tp.includes("Machine-generated transcript") && tp.includes("0:00.4 – 0:03.2") && tp.includes("unclear: low confidence") && (await p.$$("audio[id^=aud-]")).length === 1);
  await p.click('[data-seek="3.6"]'); await p.waitForTimeout(400);
  check("a timestamp moves the player to that moment", await p.$eval("audio[id^=aud-]", a => Math.abs(a.currentTime - 3.6) < 0.5));
  await shot(p, "36-transcript");
  const sid = await p.$eval(".tseg", e => e.dataset.sid);
  await p.fill(`[data-ttext="${sid}"]`, "The county road will close on Monday 3 March."); await p.click(`[data-tsave="${sid}"]`);
  await p.waitForSelector(`text=corrected by`, { timeout: 10000 });
  check("an analyst correction is saved and the machine text kept", (await p.textContent(".tpanel")).includes("Machine text: “The county road will close on Monday.”"));
  const mid = await p.$eval("[data-tpanel]", e => e.dataset.tpanel);
  await p.fill(`#tq-${mid}`, "bypass"); await p.waitForFunction(() => document.querySelectorAll(".tseg").length === 1, null, { timeout: 5000 });
  check("search narrows the transcript to matching segments", (await p.$$(".tseg")).length === 1);
  await p.fill(`#tq-${mid}`, ""); await p.waitForFunction(() => document.querySelectorAll(".tseg").length === 3, null, { timeout: 5000 });
  const hrefs = await p.$$eval(".tpanel a[download]", x => x.map(a => a.getAttribute("href")));
  const txt = await (await ctx.request.get(ST.base + hrefs.find(h => h.endsWith(".txt")))).text();
  check("TXT, SRT, VTT and JSON downloads, labelled machine-generated", hrefs.length === 4 && txt.startsWith("MACHINE-GENERATED TRANSCRIPT") && txt.includes("[corrected by analyst]"));
  const boxes = await p.$$("[data-tsel]"); await boxes[0].check(); await boxes[1].check(); await p.click("[data-tev]");
  await p.waitForSelector("#tevc"); await p.selectOption("#tevc", { index: 1 }); await p.selectOption("#tevs", "supports"); await p.click(".modal .mf .btn.primary");
  await p.waitForSelector("text=Added as evidence", { timeout: 10000 });
  await p.goto(ST.base + `/#/case/${cid}/evidence`); await p.waitForSelector(".ev");
  const evt = await p.textContent("#tabBody");
  check("selected segments become evidence with timestamps and a machine-transcript caveat", evt.includes("at 0:00.4–0:06.1") && evt.includes("Machine-generated transcript"));
  await shot(p, "37-transcript-evidence");
  fs.rmSync(wf, { force: true }); await ctx.close(); await ST.close(); ft.close();
}
const audit = async (p, where) => (await p.evaluate(() => [...document.querySelectorAll("button, a.btn")].filter(b => b.offsetParent !== null && !b.disabled && !b.closest(".modal-bg"))
  .filter(b => b.tagName === "A" ? !b.getAttribute("href") : !(b.onclick || (b.form && b.type === "submit")))
  .map(b => `${b.id || b.className}:${b.textContent.trim().slice(0, 30)}`))).map(x => `${where} ${x}`);
// ---- Guided mode (1.19): one clearly labelled SYNTHETIC case through the four steps, analyst then a different reviewer
let guidedDead = [], guidedSeen = 0;
{ const g = await session("ana2", "guided");
  check("guided menu shows the six services and no secondary tools", (await g.$$(".nav > a")).length === 6 && !(await g.$("#navMore")) && !(await g.isVisible('a[href="#/dashboard"]')));
  await g.click('.nav a[data-nav="verify"]'); await g.waitForSelector("#igo");
  check("Verify Information opens the one-click page, with sub-tabs for analysis, cases and the review queue", (await g.$$eval(".subnav a", x => x.map(e => e.textContent))).join("|") === "Analyze information|Cases|Review queue" && (await g.textContent("#igo")).trim() === "Analyse Automatically" && (await g.getAttribute("#iv", "placeholder")) === "https://example.com/news/article");
  await g.click('a[href="#/start"]'); await g.waitForSelector("#sGo");
  await g.click("#sGo"); await g.waitForSelector("#siMiss:not([hidden])");
  check("step 1 explains missing content beside the field", (await g.textContent("#siMiss")).includes("Paste the text or a link"));
  await g.fill("#si", "https://x.com/practice_desk/status/1849000000000000000"); await g.waitForFunction(() => document.querySelector("#pt")?.value.includes("water project funds"), null, { timeout: 10000 });
  check("a post link fills in the words of the post automatically, with their source", (await g.textContent("#ptMsg")).includes("Filled in from X public embed"));
  check("the platform is detected and the preview shows the author, date, source link and text status", (await g.textContent("#sDet")).includes("X (Twitter) link detected") && (await g.textContent("#xPrev")).includes("Content retrieved")
    && (await g.textContent("#xPrev")).includes("Practice Desk") && (await g.textContent("#xPrev")).includes("Full text") && !!(await g.$('#xPrev a[href^="https://x.com/practice_desk/status/"][rel~="noopener"]')));
  await g.fill("#pt", "Edited: the water project funds have disappeared."); check("the extracted words can be edited before analysis", (await g.inputValue("#pt")).startsWith("Edited:"));
  await g.fill("#si", "https://www.facebook.com/share/p/18j15o3bDz/"); await g.waitForFunction(() => /META_OEMBED_TOKEN/.test(document.querySelector("#xPrev")?.textContent || ""), null, { timeout: 10000 });
  check("when the platform shares no words, the preview says why and which setting would help", (await g.textContent("#xPrev")).includes("Content not retrieved") && (await g.textContent("#xPrev")).includes("FACEBOOK_ACCESS_TOKEN") && (await g.textContent("#xPrev")).includes("No text"));
  check("typed words are kept when the link changes", (await g.inputValue("#pt")).startsWith("Edited:"));
  await g.click("#xRetry"); await g.waitForFunction(() => /Content not retrieved/.test(document.querySelector("#xPrev")?.textContent || ""));
  check("Retry asks the platform again", true);
  await g.fill("#pt", ""); await g.click("#sGo"); await g.waitForFunction(() => /needs the words/.test(document.querySelector("#ptMsg")?.textContent || ""));
  check("the screenshot fallback is offered beside the words field", (await g.textContent("#ptMsg")).includes("screenshot"));
  await shot(g, "47-extract-facebook");
  check("starting without the words is stopped beside the words field", await g.evaluate(() => document.activeElement?.id === "pt"));
  await g.fill("#si", "");
  await g.click("#sEx"); await g.waitForFunction(() => document.querySelector("#si")?.value.startsWith("SYNTHETIC PRACTICE CASE"));
  check("the synthetic example is labelled and becomes a training case", (await g.inputValue("#si")).includes("invented, not a real post") && !!(await g.$(".trainbar")));
  check("the main button reads Analyze content", (await g.textContent("#sGo")).trim() === "Analyze content");
  await g.uncheck('#sAuto'); // Exercise the existing guided workflow; automatic reports have their own browser test.
  await g.click("#sGo"); await g.waitForFunction(() => /\/step2$/.test(location.hash), null, { timeout: 30000 }); await g.waitForSelector(".gbody .card");
  await g.waitForFunction(() => /What the source shows/.test(document.querySelector("#gCAbd")?.textContent || ""), null, { timeout: 10000 });
  { const t = await g.textContent("#gCAbd"); check("step 2 content analysis keeps source facts, unverified claims, estimates and missing evidence apart", ["What the source shows", "Claims: unverified until assessed", "Automatic estimate", "Not available", "Tone:", "Garissa", "never proof of coordination"].every(x => t.includes(x)), t.slice(0, 200)); }
  const gid = (await g.evaluate(() => location.hash)).match(/TR-\d{4}/)[0];
  check("starting opens the case at step 2 with the claims, warnings and suggestions", (await g.textContent(".gbody")).includes("Claims to check") && (await g.textContent(".gbody")).includes("Warnings") && (await g.textContent(".gsteps li.cur")).includes("Review findings"));
  await shot(g, "43-guided-step2");
  check("suggested evidence is not counted until accepted", (await g.$$(".ev.sugg")).length >= 1 && (await g.textContent(".gbody")).includes("Accepted evidence") && (await g.$$(".gbody ul.mini li")).length === 0);
  const sels = await g.$$(".ev.sugg select[data-ln]"); await sels.at(-1).selectOption("context");
  await g.click(".ev.sugg [data-acc]"); await g.waitForSelector("text=accepted.");
  await g.click('.gnav a:has-text("Back")'); await g.waitForFunction(() => /\/step1$/.test(location.hash) && /Kept unchanged/.test(document.querySelector(".gbody")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
  check("Back goes to the previous step and the content is shown as received", (await g.textContent(".gbody")).includes("SYNTHETIC PRACTICE CASE") && (await g.textContent(".gbody")).includes("Kept unchanged"));
  await g.goBack(); await g.waitForFunction(() => /\/step2$/.test(location.hash)); await g.waitForSelector(".gbody .card");
  check("the browser's back button also works between steps", true);
  await g.click('.gnav a:has-text("Next: Record conclusion")'); await g.waitForSelector("#overall");
  const ids = await g.$$eval(".gclaim", x => x.map(e => e.id.slice(3)));
  check("step 3 says what is missing beside each claim", (await g.$$eval(".gclaim .gmiss", x => x.filter(e => e.textContent.includes("Choose a verdict")).length)) === ids.length);
  for (const [i, cid2] of ids.entries()) {
    await g.click(`[data-assess="${cid2}"][data-v="${i === 2 ? "not_verifiable" : "insufficient"}"]`); await g.waitForSelector(`[data-assess="${cid2}"][data-v="${i === 2 ? "not_verifiable" : "insufficient"}"].on`);
    await g.fill(`#r-${cid2}`, i === 2 ? "SYNTHETIC: a call to share, not a factual statement." : "SYNTHETIC: no independent source confirms or contradicts this."); await g.locator(`#r-${cid2}`).blur(); await g.waitForSelector(`#sv-r-${cid2}:has-text("Saved")`);
  }
  await g.click("#gUseExp"); await g.waitForSelector("#gcc"); await g.waitForFunction(() => document.querySelector("#gcc").value === "insufficient");
  await g.fill("#gcr", "SYNTHETIC: none of the claims can be confirmed; the text is invented for practice."); await g.locator("#gcr").blur(); await g.waitForSelector('#sv-gcr:has-text("Saved")');
  await g.reload(); await g.waitForSelector("#overall");
  check("progress is saved automatically (still there after reloading the page)", (await g.inputValue("#gcr")).includes("invented for practice") && (await g.inputValue(`#r-${ids[0]}`)).includes("no independent source"));
  await shot(g, "44-guided-step3");
  await g.click('.gnav a:has-text("Next: Review and export")'); await g.waitForSelector(".gfix li");
  const fixes = await g.$$eval(".gfix li", x => x.map(e => e.textContent));
  check("step 4 shows exactly what blocks submission, with a direct link", fixes.length === 1 && fixes[0].includes("uncertainties") && (await g.$eval("#gSubmit", b => b.disabled)));
  await g.click(".gfix li a"); await g.waitForSelector("#gcu:focus");
  check("the fix link opens step 3 at the missing field", /\/step3$/.test(await g.evaluate(() => location.hash)));
  await g.fill("#gcu", "SYNTHETIC: whether any such event happened is unknown."); await g.locator("#gcu").blur(); await g.waitForSelector('#sv-gcu:has-text("Saved")');
  await g.click('.gnav a:has-text("Next: Review and export")'); await g.waitForSelector("#gSubmit:not([disabled])");
  await shot(g, "45-guided-step4");
  await g.click("#gSubmit"); await g.waitForSelector("text=Submitted for approval");
  check("submitting needs no extra dialog and leaves the case waiting for a different person", !(await g.$(".modal-bg")) && /Waiting for a reviewer|different reviewer must decide/.test(await g.textContent(".gbody")) && (await g.textContent(".ghead")).includes("Awaiting review"), (await g.textContent(".ghead")).slice(0, 200));
  check("the analyst who submitted cannot approve", !(await g.$("#gAppr")));
  for (const n of [1, 2, 3, 4]) { await g.goto(S.base + `/#/case/${gid}/step${n}`); await g.waitForSelector(".gbody > *"); await g.waitForTimeout(300); guidedDead = guidedDead.concat(await audit(g, `step${n}`)); guidedSeen += await g.$$eval("button, a.btn", x => x.filter(b => b.offsetParent !== null).length); }
  await g.click(".moretools > summary"); check("More tools lists the case tools and automatic report, without the secondary assistant tools", (await g.$$(".mt-menu a")).length === 9 && !!(await g.$('.mt-menu a[href$="/automatic"]')));
  await g.click('.mt-menu a[href$="/history"]'); await g.waitForSelector(".gback");
  check("a tool page in Guided mode has a way back to the steps", await g.isVisible('.gback a:has-text("Back to the steps")'));
  const rv = await session("rev2", "guided"); await rv.click('[data-scope="training"]'); await rv.goto(S.base + `/#/case/${gid}`); await rv.waitForSelector("#gAppr");
  check("the reviewer lands on step 4 with the decision", /\/step4$/.test(await rv.evaluate(() => location.hash)));
  await rv.click("#gAppr"); await rv.click(".modal .btn.primary"); await rv.waitForSelector("text=Approved. The report is frozen.");
  await rv.waitForSelector(".callout.good");
  const pdf = await rv.evaluate(async id => { const r = await fetch(`/api/cases/${id}/report.pdf?download=1`); return { status: r.status, type: r.headers.get("content-type"), size: (await r.arrayBuffer()).byteLength }; }, gid);
  check("after independent approval the report downloads", pdf.status === 200 && /pdf/.test(pdf.type) && pdf.size > 1000 && (await rv.textContent(".gbody")).includes("Approved"));
  const hist = await rv.evaluate(async id => (await (await fetch(`/api/cases/${id}/audit`)).json()).entries.map(e => e.action), gid);
  check("the audit history records each step", ["Case created", "Submitted for approval"].every(x => hist.some(h => h.includes(x))) && hist.some(h => /Approved/i.test(h)));
  await shot(rv, "46-guided-approved");
  await rv.setViewportSize({ width: 390, height: 844 }); await rv.goto(S.base + `/#/case/${gid}/step3`); await rv.waitForSelector("#overall");
  check("the steps fit a phone screen", await rv.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
}
// ---- KDF Mention Watch (1.16): template, examples, preview before activation, collection from a stand-in X API, the alert queue and its actions
let watchDead = [], watchSeen = 0;
{ const fx = http.createServer((req, res) => { const u = new URL(req.url, "http://x"); res.writeHead(200, { "content-type": "application/json" });
    if (u.pathname !== "/2/tweets/search/recent") return res.end("{}");
    const t = (id, text, user, m) => ({ id, text, author_id: user, created_at: new Date(Date.now() - m * 60e3).toISOString(), lang: "en", public_metrics: { like_count: 12, reply_count: 3, retweet_count: 4, quote_count: 1, impression_count: 2100 } });
    res.end(JSON.stringify({ data: [t("3001", "KDF soldiers rebuilt the Garissa bridge after the floods, residents say", "amina", 12), t("3002", "Recruitment message claims Kenya Defence Forces are hiring through WhatsApp, pay a fee to apply", "brian", 30), t("3003", "Opening my KDF file in the editor fails", "carol", 40)],
      includes: { users: [{ id: "amina", username: "amina_k" }, { id: "brian", username: "brian_o" }, { id: "carol", username: "carol_w" }] }, meta: { newest_id: "3003" } })); });
  await new Promise(ok => fx.listen(0, "127.0.0.1", ok));
  const SW = await startServer({ collect: { xBearer: "e2e-token", timeoutMs: 3000, maxItems: 100, bases: { x: `http://127.0.0.1:${fx.address().port}` } }, watch: { enabled: false, metricsRefreshMinutes: 0 } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }), p = await ctx.newPage();
  p.on("pageerror", e => errors.push(`watch: ${e.message}`)); p.on("console", m => m.type() === "error" && !/401|Failed to load resource/.test(m.text()) && errors.push(`watch: ${m.text()}`));
  await p.goto(SW.base); await p.fill("#lu", "rev"); await p.fill("#lp", PW); await p.click("#lb"); await p.waitForSelector(".shell");
  check("AI Watchlist is one of the six services in the menu", await p.isVisible('.nav a[href="#/watch"]'));
  await p.click('.nav a[href="#/watch"]'); await p.waitForSelector(".wkpis");
  check("AI Watchlist opens on an overview that explains how to start when no watchlist exists", (await p.textContent("#wb")).includes("Start in three steps") && (await p.textContent("#wb")).includes("How alerts are decided"));
  await p.click('nav.tabs a[href="#/watch/alerts"]'); await p.waitForSelector("#qf");
  check("the alert queue says no watchlist exists yet", (await p.textContent("#wb")).includes("No watchlists yet"));
  await p.click('nav.tabs a[href="#/watch/lists"]'); await p.click("#nw"); await p.waitForSelector("#wt");
  check("the KDF template fills English and Kiswahili terms and exclusions", (await p.inputValue("#wt")).includes("Kenya Defence Forces") && (await p.inputValue("#wt")).includes("Vikosi vya Ulinzi vya Kenya") && (await p.inputValue("#wx")).includes("kdf file"));
  check("activation is unavailable before a preview", await p.$eval("#wAct", b => b.disabled));
  await p.fill("#ex", "KDF trucks seen in Garissa\nMy KDF file will not open"); await p.waitForSelector("#exr .chip");
  const exr = await p.textContent("#exr"); check("examples show whether they would match and why", exr.includes("would match") && exr.includes("excluded by “kdf file”"));
  await p.fill("#wa", "X API terms; unit IO policy (e2e)"); await p.click("#wf button[type=submit]"); await p.waitForSelector("text=Saved.");
  await p.waitForSelector("#pv"); await p.fill("#ex", "Kenya Defence Forces statement on floods"); await p.click("#pv"); await p.waitForSelector("#pvDone");
  check("preview reports matches without collecting anything", (await p.textContent("#pvr")).includes("1 of 1 stored posts and examples match"));
  await shot(p, "38-watch-editor-preview");
  await p.click("#pvDone"); await p.waitForSelector("#wAct:not([disabled])"); await p.click("#wAct"); await p.waitForSelector('.toast:has-text("Activated.")');
  await p.waitForSelector('[data-run="x_search"]'); await p.click('[data-run="x_search"]'); await p.waitForSelector("text=matching posts");
  await p.waitForSelector("#mp .covsug");
  check("a run stores matching posts and leaves out the excluded one", (await p.textContent("#mcount")) === "2 posts" && !(await p.textContent("#mp")).includes("KDF file"));
  await p.click('a[href^="#/watch/alerts"]'); await p.waitForSelector(".walert");
  const q1 = await p.textContent("#al");
  check("alerts show text, platform, link, publication and detection times, reason and observed counts", (await p.$$(".walert")).length === 2 && q1.includes("X (Twitter)") && q1.includes("Published") && q1.includes("Detected") && q1.includes("Why this alert") && q1.includes("Reach is not estimated") && (await p.$$(".walert mark")).length >= 2 && !!(await p.$('.walert a[href="https://x.com/amina_k/status/3001"]')));
  await shot(p, "39-watch-queue");
  const card = n => `.walert:has-text("${n}")`;
  await p.click(`${card("Garissa bridge")} [data-act=acknowledge]`); await p.waitForSelector("text=Alert acknowledged.");
  await p.click(`${card("Garissa bridge")} [data-act=dismiss]`); await p.click(".modal .btn.primary"); await p.waitForSelector(".merr");
  check("dismissing needs a reason", (await p.textContent(".merr")).includes("Give a reason"));
  await p.fill("#dn", "Routine engineering news, no action"); await p.click(".modal .btn.primary"); await p.waitForSelector("text=Alert dismissed.");
  await p.click(`${card("Recruitment message")} [data-act=assign]`); await p.click(".modal .btn.primary"); await p.waitForSelector("text=Assignment saved.");
  await p.click(`${card("Recruitment message")} [data-act=details]`); await p.waitForSelector(".modal h3");
  const det = await p.textContent(".modal"); check("details show observed counts per collection and the alert history", det.includes("Observed engagement") && det.includes("2,100") && det.includes("assigned"));
  await shot(p, "40-watch-details"); await p.click(".modal [data-x]");
  await p.click(`${card("Recruitment message")} [data-act=convert]`); await p.waitForSelector("#cc"); await p.click(".modal .btn.primary"); await p.waitForSelector(".ghead, .casehead");
  const conv = await p.evaluate(async () => { const id = decodeURIComponent(location.hash.split("/")[2]); const r = await fetch(`/api/cases/${id}`).then(x => x.json()); return { id, claim: r.case.claim_text, url: r.case.source_url, platform: r.case.source_platform }; });
  check("converting an alert opens a case with the post's text, link and platform", /^C-\d{4}-\d{4}$/.test(conv.id) && conv.claim.startsWith("Recruitment message claims Kenya Defence Forces") && conv.url === "https://x.com/brian_o/status/3002" && conv.platform === "X (Twitter)", JSON.stringify(conv));
  await p.goto(SW.base + "/#/watch/sources"); await p.waitForSelector("text=Not covered");
  const srcT = await p.textContent("#wb"); check("sources page shows unsupported platforms, limits and today's usage", srcT.includes("TikTok") && srcT.includes("WhatsApp") && srcT.includes("X posts read") && srcT.includes("not guaranteed"));
  const capRows = await p.$$eval(".wcap tbody tr", rs => rs.map(r => r.innerText));
  check("capability table lists every platform with its status, access and live-verification state", capRows.length === 13 && capRows.some(r => /LinkedIn[\s\S]*unavailable/.test(r)) && capRows.some(r => /Facebook[\s\S]*restricted/.test(r)) && capRows.some(r => /X \(Twitter\)[\s\S]*working/.test(r)) && capRows.some(r => /not verified live \(simulated tests only\)/.test(r)), capRows.map(r => r.split("\n")[0] + ":" + (r.match(/working|needs configuration|restricted|unavailable/) || [""])[0]).join(", "));
  await shot(p, "41-watch-sources");
  await p.goto(SW.base + "/#/watch/lists"); await p.click("#wb table a[href^='#/watch/list/']"); await p.waitForSelector("#slGo");
  await p.fill("#slu", "https://www.tiktok.com/@someone/video/7300000000000000099"); await p.fill("#slt", "Clip claims KDF trucks crossed into Somalia last night"); await p.click("#slGo"); await p.waitForSelector('.toast:has-text("Added (TikTok")');
  await p.waitForSelector("#mp .covsug"); check("a submitted public link is added and labelled as submitted by an analyst", (await p.textContent("#mp")).includes("Public link submitted by an analyst"));
  const wid = (await p.evaluate(() => fetch("/api/watch/overview").then(r => r.json()))).watchlists[0].id;
  // ---- AI Watchlist on an imported dataset (1.21): create → activate → import → alerts → verify a claim
  await p.goto(SW.base + "/#/watch/lists"); await p.click("#nwb"); await p.waitForSelector("#nn");
  await p.fill("#nn", "Election Misinformation"); await p.fill("#nd", "Election claims in imported datasets"); await p.fill("#nt", "election\nIEBC\nvoting\nballot");
  await p.click(".modal .btn.primary"); await p.waitForSelector("#pv");
  const ewid = Number((await p.evaluate(() => location.hash)).match(/list\/(\d+)/)[1]);
  check("a new watchlist monitors all imported datasets with a 10-posts-per-hour rule", await p.isChecked("#wall") && (await p.inputValue("#t_count_min_posts")) === "10" && (await p.inputValue("#t_count_window_min")) === "60");
  await p.click("#pv"); await p.waitForSelector("#pvDone"); await p.click("#pvDone"); await p.waitForSelector("#wAct:not([disabled])"); await p.click("#wAct"); await p.waitForSelector('.toast:has-text("Activated.")');
  await p.goto(SW.base + "/#/watch/overview"); await p.waitForSelector("#wDemo"); await p.click("#wDemo"); await p.waitForSelector('.toast:has-text("imported (")', { timeout: 60000 });
  const tst = await p.textContent('.toast:has-text("imported (")'); check("importing a dataset is checked by the active watchlist straight away and raises alerts", /active watchlist\(s\) checked it: [1-9]\d* new alert/.test(tst), tst);
  await p.waitForSelector(".wkpis"); check("the overview shows the monitored posts, open alerts and the dataset check", (await p.textContent("#wb")).includes("checked “SYNTHETIC: election discussion"));
  await shot(p, "41a-watch-overview");
  await p.goto(SW.base + `/#/watch/alerts?watchlist=${ewid}&status=all`); await p.waitForSelector(".walert");
  const eq = await p.textContent("#al");
  check("alerts cover a keyword threshold, an unusual spike, an emerging narrative, repeated messages and a coordination indicator, with severity and recommended action",
    ["Keyword threshold exceeded", "Unusual posting spike", "Emerging narrative", "Repeated-message activity", "Potential coordination indicator", "High severity", "Recommended action", "Historical dataset"].every(x => eq.includes(x)), eq.slice(0, 200));
  await shot(p, "41b-watch-dataset-alerts");
  await p.click('.walert:has-text("Potential coordination indicator") [data-act=details]'); await p.waitForSelector(".modal h3");
  check("coordination details list the accounts, the minutes and the shared hashtag, and call it a signal", (await p.textContent(".modal")).includes("12 accounts within") && (await p.textContent(".modal")).includes("#electiontruth") && (await p.textContent(".modal")).includes("not evidence of coordinated manipulation"));
  await p.click(".modal [data-x]");
  await p.click('.walert:has-text("Unusual posting spike") >> nth=0 >> [data-act=convert]'); await p.waitForSelector("#cc");
  await p.click(".modal [data-copy] >> nth=0"); const chosen = await p.inputValue("#cc"); await p.click(".modal .btn.primary"); await p.waitForSelector(".ghead, .casehead");
  const vc = await p.evaluate(async () => { const id = decodeURIComponent(location.hash.split("/")[2]); const r = await fetch(`/api/cases/${id}`).then(x => x.json()); return { claim: r.case.claim_text, lead: r.evidence.find(e => /AI Watchlist alert/.test(e.text)) }; });
  check("a claim chosen from a spike alert's supporting posts goes to Information Verification with the alert as a suggested lead", vc.claim === chosen && !!chosen && vc.lead?.status === "suggested");
  await p.goto(SW.base + `/#/watch/list/${ewid}`); await p.waitForSelector("#wanb .wtrend");
  const an = await p.textContent("#wanb");
  check("the watchlist page shows posting trends, spikes, sentiment, top keywords, narratives and alert history from the data", (await p.$$("#wanb .wtrend")).length === 2 && (await p.$$("#wanb .wsent span")).length >= 2 && an.includes("Top keywords") && an.includes("Recurring narratives") && an.includes("Alert history"));
  await shot(p, "41c-watch-analysis");
  for (const h of ["#/watch/overview", "#/watch/alerts?status=all", "#/watch/lists", `#/watch/list/${wid}`, "#/watch/sources"]) { await p.goto(SW.base + "/" + h); await p.waitForSelector("#wb > :not(.empty)"); await p.waitForTimeout(400); watchDead = watchDead.concat(await audit(p, h)); watchSeen += await p.$$eval("button, a.btn", x => x.filter(b => b.offsetParent !== null).length); }
  await p.setViewportSize({ width: 390, height: 844 }); await p.goto(SW.base + "/#/watch/alerts?status=all"); await p.waitForSelector(".walert");
  check("alert queue fits a phone screen", await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot(p, "42-watch-phone");
  await ctx.close(); await SW.close(); fx.close();
}
// ---- 1.21.1: the Dashboard's AI Watchlist figures on a fresh server. 0 active / 0 alerts → create → activate (1 / 0)
// → import the labelled SYNTHETIC dataset → alerts > 0 equal to the saved alerts; the monitoring line reports the analysis.
{ const SD = await startServer({ watch: { enabled: false, metricsRefreshMinutes: 0 } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }), p = await ctx.newPage();
  p.on("pageerror", e => errors.push(`dash: ${e.message}`)); p.on("console", m => m.type() === "error" && !/401|Failed to load resource/.test(m.text()) && errors.push(`dash: ${m.text()}`));
  await p.goto(SD.base); await p.fill("#lu", "rev"); await p.fill("#lp", PW); await p.click("#lb"); await p.waitForSelector(".shell");
  const figs = async () => { await p.goto(SD.base + "/#/home"); await p.waitForSelector('.svc[data-svc=watch] [data-fig="open alerts"] b');
    return { active: await p.textContent('.svc[data-svc=watch] [data-fig="active watchlists"] b'), open: await p.textContent('.svc[data-svc=watch] [data-fig="open alerts"] b'), mon: await p.textContent(".svc[data-svc=watch] .wmon") }; };
  let f = await figs();
  check("dashboard on a fresh server: 0 active watchlists, 0 open alerts, and says nothing is monitored", f.active === "0" && f.open === "0" && /No watchlist is active/.test(f.mon), JSON.stringify(f));
  check("no version warning when the server and pages match", !(await p.$("#verBanner")));
  await p.goto(SD.base + "/#/watch/lists"); await p.click("#nwb"); await p.waitForSelector("#nn");
  await p.fill("#nn", "TEST Election watchlist"); await p.fill("#nt", "election\nIEBC\nvoting\nballot"); await p.click(".modal .btn.primary"); await p.waitForSelector("#pv");
  f = await figs(); check("a saved draft watchlist is not counted as active", f.active === "0" && f.open === "0", JSON.stringify(f));
  await p.goBack(); await p.waitForSelector("#pv");
  await p.click("#pv"); await p.waitForSelector("#pvDone"); await p.click("#pvDone"); await p.waitForSelector("#wAct:not([disabled])"); await p.click("#wAct"); await p.waitForSelector('.toast:has-text("Activated.")');
  f = await figs(); check("after activation the dashboard shows 1 active watchlist and still 0 open alerts", f.active === "1" && f.open === "0", JSON.stringify(f));
  check("the monitoring line says a data source is still needed", /no data source/.test(f.mon), f.mon);
  await p.goto(SD.base + "/#/watch/overview"); await p.waitForSelector("#wDemo"); await p.click("#wDemo"); await p.waitForSelector('.toast:has-text("imported (")', { timeout: 60000 });
  await p.waitForSelector("#wMon.ok"); check("the AI Watchlist overview shows monitoring active with the last analysis and posts checked", /Monitoring active.*last successful analysis .*1,000 posts checked/.test(await p.textContent("#wMon")), await p.textContent("#wMon"));
  const saved = (await p.evaluate(() => fetch("/api/watch/alerts?status=all&limit=200").then(r => r.json()))).alerts.filter(a => ["new", "acknowledged"].includes(a.status)).length;
  f = await figs(); check("after importing matching posts with a spike, open alerts rise to the number of saved alerts", f.active === "1" && Number(f.open) > 0 && Number(f.open) === saved, `${JSON.stringify(f)} saved=${saved}`);
  check("the dashboard reports the last analysis time and 1,000 posts checked", /Monitoring active.*last analysis .*1,000 posts checked/.test(f.mon), f.mon);
  await shot(p, "01b-dashboard-watchlist-after-import");
  await ctx.close(); await SD.close();
}
// ---- 1.22: one-click automatic investigation (no evidence service is configured in this test server, so the
// report must say the evidence is insufficient and why), on a desktop and on a phone-sized screen
{ await a.goto(S.base + "/#/investigate"); await a.waitForSelector("#igo");
  await a.click("#igo"); await a.waitForSelector("#ierr:not([hidden])"); check("Analyze Information without input explains what is missing", (await a.textContent("#ierr")).includes("Paste a link or some text"));
  await a.fill("#iv", "PRACTICE: The Ministry of Health confirmed 12 new cholera cases in Garissa County on 20 October 2026. Share this before it is deleted!");
  await a.click("#igo"); await a.waitForSelector("#istages li", { timeout: 10000 });
  check("the seven processing stages are shown, including the image checks", (await a.$$("#istages li")).length === 7 && (await a.textContent("#istages")).includes("Extracting the content") && (await a.textContent("#istages")).includes("Checking images and media"));
  await a.waitForSelector("#invOut:not([hidden])", { timeout: 60000 });
  const rep = a.frameLocator("#irep"), body = await rep.locator("body").innerText(), body0 = await a.textContent("#ires");
  check("the one-page Information Operations Assessment appears automatically with its four sections", body.toUpperCase().includes("INFORMATION OPERATIONS ASSESSMENT REPORT") && ["1. BACKGROUND", "2. ANALYSIS", "3. ASSESSMENT", "4. RECOMMENDATIONS", "KEY REFERENCES", "LIMITATIONS", "REPORT STATUS"].every(h => body.toUpperCase().includes(h)), body.slice(0, 200));
  check("the assessment is labelled AI-generated and not reviewed, dated in EAT, and not presented as an official KDF document", /AI-Generated \(not reviewed\)/.test(body) && /EAT/.test(body) && /not an official KDF intelligence document/.test(body));
  check("without evidence sources the assessment says the evidence is insufficient (nothing invented)", /Insufficient evidence/i.test(body) && /Seek corroboration/.test(body));
  { const h = await a.getAttribute("#idet", "href"), pg = await a.context().newPage(); await pg.goto(S.base + h); const dt = await pg.textContent("body");
    check("the supporting evidence and investigation details stay available separately", /SUPPORTING EVIDENCE AND INVESTIGATION DETAILS/.test(dt) && /A\. Background/i.test(dt), dt.slice(0, 120));
    await pg.goto(S.base + h.replace(/details\.html$/, "report.html")); const pp = await pg.pdf({ format: "A4" }), np = (pp.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
    check("printed from the browser, the HTML assessment fits one A4 page (same as the PDF)", np === 1, `${np} page(s)`); await pg.close(); }
  check("the results show the verdict, the claims with their evidence, the evidence sources and next steps", ["Overall preliminary verdict", "Claims and evidence", "Evidence sources", "Recommended next steps"].every(t => body0.includes(t)), body0.slice(0, 200));
  check("the extracted content and the detected claims are shown", (await a.textContent("#iprev")).includes("Ministry of Health") && (await a.textContent("#iprev")).includes("Detected claims"));
  check("PDF and Word downloads are offered", !!(await a.$('#iacts a[href$="report.pdf"]')) && !!(await a.$('#iacts a[href$="report.docx"]')));
  const pdf = await a.evaluate(async () => { const h = document.querySelector('#iacts a[href$="report.pdf"]').getAttribute("href"); const r = await fetch(h); return [r.status, (await r.text()).slice(0, 4)]; });
  check("the PDF report downloads", pdf[0] === 200 && pdf[1] === "%PDF", JSON.stringify(pdf));
  await shot(a, "40-automatic-report");
  await a.goto(S.base + "/#/reports"); await a.waitForSelector("#rauto table"); check("Reports lists the automatic report by date", (await a.textContent("#rauto")).includes("AIVS-"));
  const t = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); await a.fill("#rfrom", "2020-01-01"); await a.fill("#rto", "2020-01-02"); await a.click("#rfilt button"); await a.waitForFunction(() => /No automatic reports/.test(document.querySelector("#rauto").textContent));
  await a.fill("#rfrom", t); await a.fill("#rto", t); await a.click("#rfilt button"); await a.waitForSelector("#rauto table"); check("the date filter narrows the automatic reports", true);
  await a.goto(S.base + "/#/home"); await a.waitForSelector(".svcs"); check("the dashboard shows recent automatic reports", (await a.textContent("#page")).includes("Recent automatic reports") && (await a.textContent("#page")).includes("AIVS-"));
  const ph = await (await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true })).newPage();
  ph.on("pageerror", e => errors.push(`phone: ${e.message}`));
  await ph.goto(S.base); await ph.fill("#lu", "ana"); await ph.fill("#lp", PW); await ph.click("#lb"); await ph.waitForSelector(".shell");
  await ph.goto(S.base + "/#/investigate"); await ph.waitForSelector("#igo"); await ph.fill("#iv", "PRACTICE: A new steel bridge in Marsabit town was opened last night.");
  await ph.click("#igo"); await ph.waitForSelector("#invOut:not([hidden])", { timeout: 60000 });
  check("on a phone the page fits the screen and shows the report", (await ph.evaluate(() => document.documentElement.scrollWidth)) <= 380 && /BACKGROUND/i.test(await ph.frameLocator("#irep").locator("body").innerText()));
  await shot(ph, "41-automatic-report-phone"); await ph.context().close();
}
let dead = [], seen = 0;
for (const [p, routes] of [[a, ["#/home", "#/investigate", "#/status", "#/settings", "#/models", "#/start", "#/verify", "#/verify/post", "#/search", "#/privacy", "#/dashboard", "#/cases", "#/new", "#/review", "#/archive", "#/reports", "#/datasets", "#/monitor", ...["summary", "messages", "hashtags", "network", "links", "accounts", "posts"].map(t => `#/monitor/${ioId}/${t}`), ...["overview", "sentiment", "topics", "engagement", "claims", "geography", "posts", "report"].map(t => `#/monitor/${discId}/${t}`), ...["overview", "media", "claims", "evidence", "coverage", "ai", "report", "notes", "history"].map(t => `#/case/${caseId}/${t}`)]],
  [ad, ["#/admin/users", "#/admin/permissions", "#/admin/integrations", "#/admin/usage", "#/admin/backups", "#/admin/audit", "#/admin/training", "#/archive", "#/reports"]]]) {
  if (p === ad) await ad.setViewportSize({ width: 1440, height: 950 });
  for (const h of routes) { await p.goto(S.base + "/" + h); await p.waitForSelector("#page > :not(.empty)"); await p.waitForTimeout(400); dead = dead.concat(await audit(p, h)); seen += await p.$$eval("button, a.btn", x => x.filter(b => b.offsetParent !== null).length); }
}
dead = dead.concat(watchDead, guidedDead); seen += watchSeen + guidedSeen;
check("every visible button is wired to an action", dead.length === 0 && seen > 100, dead.length ? dead.join(" | ") : `${seen} visible buttons checked`);
check("no browser errors", errors.length === 0, errors.join(" | "));
await browser.close(); await S.close(); fakeX.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nAll end-to-end checks passed");
process.exit(failed ? 1 : 0);

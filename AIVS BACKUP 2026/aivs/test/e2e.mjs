// End-to-end browser test of the main workflow. Usage: npm run test:e2e  (needs Playwright + Chromium)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, login, PW } from "./helpers.js";

const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null; if (shots) fs.mkdirSync(shots, { recursive: true });
const S = await startServer();
const rev = await login(S.base, "rev");
{ const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync("training/images/archive_convoy.jpg")]), "convoy-2018.jpg");
  for (const [k, v] of Object.entries({ title: "Convoy crossing a flooded track, 2018", description: "Documented convoy crossing during seasonal rains; all vehicles completed it.", documented_date: "2018-10-14", source_ref: "Unit media release 2018/994", record_type: "original" })) fd.append(k, v);
  await rev.post("/api/archive", null, { form: fd }); }

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = 0; const errors = [];
const check = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };
async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }), p = await ctx.newPage();
  p.on("pageerror", e => errors.push(`${user}: ${e.message}`)); p.on("console", m => m.type() === "error" && !/401|Failed to load resource/.test(m.text()) && errors.push(`${user}: ${m.text()}`));
  await p.goto(S.base); await p.fill("#lu", user); await p.fill("#lp", PW); await p.click("#lb"); await p.waitForSelector(".shell");
  return p;
}
const shot = async (p, n) => shots && p.screenshot({ path: path.join(shots, n + ".png"), fullPage: true });

// ---- analyst
const a = await session("ana");
await a.waitForSelector(".module");
check("start page lists the eight modules with honest statuses", (await a.$$(".module")).length === 8 && (await a.textContent(".modules")).includes("Available") && (await a.textContent(".modules")).includes("Partly available"));
await shot(a, "00-start");
await a.click(`a[href="#/dashboard"]`); await a.waitForFunction(() => document.querySelector("#crumbs")?.textContent.startsWith("Dashboard") && !document.querySelector("#page .spin"));
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
check("six verdicts offered per claim", (await a.locator(".claim").first().locator("[data-v]").count()) === 7 && (await a.textContent(".claim")).includes("Misleading context"));
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
await ad.click('a[href="#/admin"]'); await ad.waitForSelector("text=User accounts"); await shot(ad, "12-admin-users");
await ad.click('a[href="#/admin/integrations"]'); await ad.waitForSelector("text=AI not configured"); await shot(ad, "13-admin-integrations");
check("integrations show AI not configured", true);
await ad.click('a[href="#/admin/audit"]'); await ad.click("#vb"); await ad.waitForSelector("text=Intact");
check("audit chain verifies in the UI", true);
await ad.click('a[href="#/admin/training"]'); await ad.click("#seed"); await ad.waitForSelector("text=already loaded");
await ad.click('[data-scope="training"]'); await ad.waitForSelector(".trainbar");
await ad.click('a[href="#/cases"]'); await ad.waitForSelector("table.t");
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
await a.goto(S.base + "/#/verify"); await a.waitForSelector("#vi"); await a.evaluate(() => { const d = [...document.querySelectorAll("details")].find(x => x.textContent.includes("practice text")); d.open = true; }); await a.click('[data-sample="0"]'); await a.click("#vgo"); await a.waitForSelector("#vres a.btn.primary", { timeout: 30000 });
await a.click("#vres a.btn.primary"); await a.waitForSelector(".nextstep");
check("guided mode shows one next step on the case", (await a.textContent(".nextstep")).includes("Next step"));
{ const vid = (await a.evaluate(() => location.hash)).match(/C-\d{4}-\d{4}/)[0];
  await a.goto(S.base + `/#/case/${vid}/claims`); await a.waitForSelector("#srchAll"); await a.click("#srchAll"); await a.waitForSelector(".modal", { timeout: 20000 });
  const mt = await a.textContent(".modal");
  check("evidence search reports unconfigured services instead of inventing results", mt.includes("AIVS knowledge base") && mt.includes("Earlier AIVS investigations") && !/https?:\/\//.test(mt));
  await shot(a, "19c-evidence-search"); await a.click(".modal .btn.primary");
  await a.goto(S.base + `/#/case/${vid}/evidence`); await a.waitForSelector(".ev");
  check("red-flag leads explain which official source to check", /official|Ministry of Health|health\.go\.ke/i.test(await a.textContent("#tabBody")));
  await a.goto(S.base + `/#/case/${vid}`); await a.waitForSelector(".nextstep"); }
{ const sid = vtxt.match(/Case (C-\d{4}-\d{4}) created/)[1]; await a.goto(S.base + `/#/case/${sid}/claims`); await a.waitForSelector(".claim");
  const ct = await a.textContent("#tabBody");
  check("opinion and prediction claims carry an explanation", ct.includes("Looks like an opinion") && ct.includes("Looks like a prediction"));
  await shot(a, "19b-claim-types"); await a.goBack(); await a.waitForSelector(".nextstep"); }
await shot(a, "19-guided-case");
await a.click('[data-mode="advanced"]'); await a.waitForSelector('[data-mode="advanced"].on');
check("advanced mode hides the guide and keeps the setting", !(await a.$(".nextstep")) && (await a.evaluate(async () => (await (await fetch("/api/me")).json()).user.ui_mode)) === "advanced");
await a.click('[data-mode="guided"]'); await a.waitForSelector('[data-mode="guided"].on');
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
  check("posts can be added to a dataset; duplicates are skipped and the signal appears", (await a.textContent(".kpis .kpi .v")).trim() === "3" && /Synchronised messages\s*1(?!\d)/.test(await a.textContent(".kpis")));
  await shot(a, "26-monitor-added");
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
  await a.goto(S.base + "/#/home"); await a.waitForSelector(".module"); await a.goto(S.base + "/#/new"); await a.waitForSelector("#ff", { state: "attached" });
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
const audit = async (p, where) => (await p.evaluate(() => [...document.querySelectorAll("button, a.btn")].filter(b => b.offsetParent !== null && !b.disabled && !b.closest(".modal-bg"))
  .filter(b => b.tagName === "A" ? !b.getAttribute("href") : !(b.onclick || (b.form && b.type === "submit")))
  .map(b => `${b.id || b.className}:${b.textContent.trim().slice(0, 30)}`))).map(x => `${where} ${x}`);
let dead = [], seen = 0;
for (const [p, routes] of [[a, ["#/home", "#/verify", "#/search", "#/privacy", "#/dashboard", "#/cases", "#/new", "#/review", "#/archive", "#/reports", "#/datasets", "#/monitor", ...["summary", "messages", "hashtags", "network", "links", "accounts", "posts"].map(t => `#/monitor/${ioId}/${t}`), ...["overview", "media", "claims", "evidence", "ai", "report", "notes", "history"].map(t => `#/case/${caseId}/${t}`)]],
  [ad, ["#/admin/users", "#/admin/permissions", "#/admin/integrations", "#/admin/audit", "#/admin/training", "#/archive", "#/reports"]]]) {
  if (p === ad) await ad.setViewportSize({ width: 1440, height: 950 });
  for (const h of routes) { await p.goto(S.base + "/" + h); await p.waitForSelector("#page > :not(.empty)"); await p.waitForTimeout(400); dead = dead.concat(await audit(p, h)); seen += await p.$$eval("button, a.btn", x => x.filter(b => b.offsetParent !== null).length); }
}
check("every visible button is wired to an action", dead.length === 0 && seen > 100, dead.length ? dead.join(" | ") : `${seen} visible buttons checked`);
check("no browser errors", errors.length === 0, errors.join(" | "));
await browser.close(); await S.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nAll end-to-end checks passed");
process.exit(failed ? 1 : 0);

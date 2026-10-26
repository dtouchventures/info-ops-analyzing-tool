// Account location (AIVS 1.15): read from an analyst's screenshot text (Facebook Page transparency, Instagram
// "About this account", profile intro), confirmed by the analyst, shown in the reports with its source and caveat.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, login, file, T } from "./helpers.js";
import { detectAccountLocation, country } from "../shared/account-location.js";

test("detection from screenshot text: Facebook transparency, Instagram, profile intro; nothing invented", () => {
  const fb = detectAccountLocation("Page transparency\nFacebook is showing information to help you understand the purpose of this Page.\nPrimary country/region location for people who manage this Page includes:\nKenya (4)\nUganda (1)\nSee all");
  assert.deepEqual(fb.map(x => [x.location, x.source, x.recognised]), [["Kenya", "facebook_transparency", true], ["Uganda", "facebook_transparency", true]]);
  assert.deepEqual(detectAccountLocation("People who manage this Page are primarily located in: Tanzania.").map(x => x.location), ["Tanzania"]);
  const ig = detectAccountLocation("About this account\nDate joined\nMarch 2019\nAccount based in\nUnited States\nFormer usernames 2");
  assert.deepEqual(ig.map(x => [x.location, x.source]), [["United States", "instagram_about"]]);
  assert.equal(detectAccountLocation("Account based in Kenia")[0].recognised, false, "an OCR misspelling is offered but flagged");
  const p = detectAccountLocation("Intro\nLives in Nairobi, Kenya\nFrom Mombasa");
  assert.deepEqual(p.map(x => [x.location, x.source, x.country]), [["Nairobi, Kenya", "profile_self_reported", "Kenya"], ["Mombasa", "profile_self_reported", null]]);
  assert.deepEqual(detectAccountLocation("BREAKING: soldiers in Garissa retreated on foot. Share widely!"), [], "ordinary post text gives nothing");
  assert.equal(country("USA"), "United States"); assert.equal(country("turkey"), "Türkiye"); assert.equal(country("Narnia"), null);
});

let S, ana, view, rev;
before(async () => { S = await startServer(); [ana, view, rev] = await Promise.all(["ana", "view", "rev"].map(u => login(S.base, u))); });
after(async () => S.close());

test("analyst finds the location in a screenshot, confirms it, and it appears in the HTML, JSON and PDF reports with its source", async () => {
  const id = (await ana.post("/api/cases", { claim_text: "SYNTHETIC: post from a Facebook page.", source_platform: "Facebook", source_account: "Synthetic Page" })).body.id;
  const m = (await ana.post(`/api/cases/${id}/media`, null, { form: file(T("images/case_notice.jpg"), "transparency.jpg") })).body.media[0];
  let c = (await ana.get(`/api/cases/${id}/account-location/candidates`)).body; assert.equal(c.candidates.length, 0); assert.equal(c.images_without_text[0].id, m.id, "unread screenshots are listed");
  await ana.post(`/api/media/${m.id}/ocr`, { engine: "test", lang: "eng", confidence: 90, text: "Page transparency\nPrimary country/region location for people who manage this Page includes:\nKenya (3)" });
  c = (await ana.get(`/api/cases/${id}/account-location/candidates`)).body; assert.equal(c.candidates.length, 1); assert.equal(c.candidates[0].location, "Kenya"); assert.equal(c.candidates[0].media_id, m.id);
  // nothing is recorded until the analyst confirms
  assert.equal((await ana.get(`/api/cases/${id}`)).body.case.account_location, null);
  // validation and permissions
  assert.equal((await ana.put(`/api/cases/${id}/account-location`, { location: "Kenya", source: "guess" })).status, 400);
  assert.equal((await ana.put(`/api/cases/${id}/account-location`, { location: "Kenya", source: "other" })).status, 400, "a basis is needed without a screenshot");
  assert.equal((await ana.put(`/api/cases/${id}/account-location`, { location: "Kenya", source: "facebook_transparency", media_id: "M-999999" })).status, 400);
  assert.equal((await view.put(`/api/cases/${id}/account-location`, { location: "Kenya", source: "facebook_transparency", media_id: m.id })).status, 403);
  const x = c.candidates[0];
  assert.equal((await ana.put(`/api/cases/${id}/account-location`, { location: x.location, source: x.source, media_id: x.media_id, basis: `Read from screenshot ${x.media_id}: “${x.quote}”` })).status, 200);
  const agg = (await ana.get(`/api/cases/${id}`)).body.case; assert.equal(agg.account_location, "Kenya"); assert.equal(agg.account_location_source, "facebook_transparency");
  assert.ok(S.ctx.db.prepare("SELECT 1 FROM audit_log WHERE entity_id = ? AND action LIKE 'Account location recorded: Kenya%'").get(id));
  const json = (await ana.get(`/api/cases/${id}/report.json`)).body, al = (typeof json === "string" ? JSON.parse(json) : json).case.source.account_location;
  assert.equal(al.location, "Kenya"); assert.match(al.source_label, /Facebook Page transparency/); assert.equal(al.screenshot_media_id, m.id); assert.match(al.note, /not verified/); assert.equal(al.recorded_by, "ANA");
  const html = (await ana.get(`/api/cases/${id}/report.html`)).body; assert.match(html, /Account location:<\/b> Kenya — Facebook Page transparency/); assert.match(html, /does not show where any post was made/);
  const pdf = await fetch(`${S.base}/api/cases/${id}/report.pdf`, { headers: { cookie: ana.cookie, "x-aivs": "1" } }); assert.equal(pdf.status, 200);
  // change and removal keep history
  assert.equal((await ana.put(`/api/cases/${id}/account-location`, { clear: true })).status, 200);
  assert.equal((await ana.get(`/api/cases/${id}`)).body.case.account_location, null);
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM case_versions WHERE case_id = ? AND reason LIKE 'Account location%'").get(id).n >= 2);
});

test("cases without a recorded location show nothing in the report", async () => {
  const id = (await ana.post("/api/cases", { claim_text: "SYNTHETIC: a WhatsApp forward." })).body.id;
  const json = (await ana.get(`/api/cases/${id}/report.json`)).body; assert.equal((typeof json === "string" ? JSON.parse(json) : json).case.source.account_location, null);
  assert.doesNotMatch((await ana.get(`/api/cases/${id}/report.html`)).body, /Account location/);
});

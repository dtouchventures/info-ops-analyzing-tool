// Generates the SYNTHETIC social media screenshots used by test/screenshot.test.js (AIVS 1.34).
// Every picture is an invented mock-up of a post, labelled TEST FIXTURE, rendered in Chromium with Playwright.
// They imitate the layout of Facebook, Instagram and X posts only so that the layout rules can be tested; they
// show no real accounts or events. Usage: node scripts/make-screenshot-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const OUT = path.resolve("test/fixtures/screenshots");
fs.mkdirSync(OUT, { recursive: true });
// an invented "photograph": a busy texture (SVG turbulence), so the picture contains an image region without text
const photo = (h = 260, seed = 3) => `<svg width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg"><filter id="n${seed}"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="4" seed="${seed}"/><feColorMatrix values="0.6 0.3 0.1 0 0.05  0.2 0.6 0.2 0 0.08  0.1 0.3 0.5 0 0.1  0 0 0 0 1"/></filter><rect width="100%" height="100%" filter="url(#n${seed})"/></svg>`;
const css = `body{margin:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif;color:#050505} .card{background:#fff;width:640px;margin:16px auto;border-radius:8px;padding:14px 16px;box-shadow:0 1px 2px #0002}
.hdr{display:flex;gap:10px;align-items:center}.av{width:40px;height:40px;border-radius:50%;background:#1877f2}.nm{font-weight:bold;font-size:16px}.tm{color:#65676b;font-size:14px}
.txt{font-size:18px;line-height:1.45;margin:12px 0}.eng{color:#65676b;font-size:15px;display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding:8px 0}
.act{display:flex;justify-content:space-around;color:#65676b;font-weight:bold;font-size:16px;padding:8px 0;border-bottom:1px solid #ddd}.cm{background:#f0f2f5;border-radius:14px;padding:8px 12px;margin:8px 0;font-size:15px}
.x .nm{font-size:17px}.x .tm{font-size:16px}.mute{color:#536471;font-size:16px}`;
const shots = {
  "facebook-post.png": `<div class="card"><div class="hdr"><div class="av"></div><div><div class="nm">Kenya Daily Updates</div><div class="tm">2h · Public</div></div></div>
    <div class="txt">TEST FIXTURE: KDF recruitment is now open. Applicants must pay KSh 2,000 registration fee through M-Pesa before Friday. Share this with every young person you know! #KDFRecruitment @KDFInfo</div>
    ${photo(240, 3)}
    <div class="eng"><span>1.2K reactions</span><span>345 comments · 89 shares</span></div>
    <div class="act"><span>Like</span><span>Comment</span><span>Share</span></div>
    <div class="tm" style="margin-top:8px">Most relevant</div>
    <div class="cm"><b>Jane Wanjiru</b><br>Is this true? My brother wants to apply.</div>
    <div class="cm"><b>Otieno Peter</b><br>This looks like a scam, recruitment is free.</div></div>`,
  "instagram-post.png": `<div class="card"><div class="hdr"><div class="av" style="background:#c13584"></div><div class="nm">kdf_news_ke</div><div class="tm" style="margin-left:auto">Follow</div></div>
    <div style="margin-top:10px">${photo(300, 7)}</div>
    <div class="nm" style="margin-top:10px">Liked by mwangi_j and 1,234 others</div>
    <div class="txt"><b>kdf_news_ke</b> TEST FIXTURE: Soldiers deployed to Lamu County today after floods damaged the main road. #KDF #Lamu</div>
    <div class="tm">View all 56 comments</div><div class="tm">2 hours ago</div><div class="tm">Add a comment...</div></div>`,
  "x-post.png": `<div class="card x"><div class="hdr"><div class="av" style="background:#111"></div><div><div class="nm">Defence Watch KE</div><div class="tm">@defwatch_ke</div></div></div>
    <div class="txt">TEST FIXTURE: The Ministry of Defence confirmed that 120 new recruits graduated at Moi Barracks in Eldoret on 25 October 2026. Details: https://example.test/kdf-pass-out #KDF</div>
    <div class="mute">12:45 PM · Oct 27, 2026 · 3,456 Views</div>
    <div class="eng"><span>12 Reposts</span><span>3 Quotes</span><span>450 Likes</span><span>8 Bookmarks</span></div>
    <div class="act"><span>Reply</span><span>Repost</span><span>Like</span><span>Share</span></div>
    <div class="cm"><b>Amina H. @amina_h</b> · 1h<br>Congratulations to all the graduates.</div></div>`,
  "x-post-image.png": `<div class="card x"><div class="hdr"><div class="av" style="background:#111"></div><div><div class="nm">Coast Alerts</div><div class="tm">@coast_alerts · 3h</div></div></div>
    <div class="txt">TEST FIXTURE: Photo shows KDF trucks carrying relief food to flood victims in Garissa this morning.</div>
    ${photo(280, 11)}
    <div class="eng"><span>40 Reposts</span><span>210 Likes</span></div>
    <div class="act"><span>Reply</span><span>Repost</span><span>Like</span></div></div>`,
  "incomplete-metadata.png": `<div class="card"><div class="txt">TEST FIXTURE: Breaking news, the Kenya Army has closed the Nairobi to Mombasa highway for three days because of a military exercise.</div></div>`,
  "multiple-posts.png": `<div class="card"><div class="hdr"><div class="av"></div><div><div class="nm">Nairobi Buzz</div><div class="tm">5h · Public</div></div></div>
    <div class="txt">TEST FIXTURE: KDF has announced free medical camps in Isiolo County next week for all residents.</div>
    <div class="eng"><span>230 reactions</span><span>14 comments</span></div><div class="act"><span>Like</span><span>Comment</span><span>Share</span></div></div>
    <div class="card"><div class="hdr"><div class="av" style="background:#e4405f"></div><div><div class="nm">Shop Deals Kenya</div><div class="tm">Sponsored</div></div></div>
    <div class="txt">TEST FIXTURE: Big discounts on phones this weekend only. Visit our store today.</div>
    <div class="act"><span>Like</span><span>Comment</span><span>Share</span></div></div>
    <div class="card"><div class="hdr"><div class="av" style="background:#2d8"></div><div><div class="nm">Eldoret Today</div><div class="tm">1d · Public</div></div></div>
    <div class="txt">TEST FIXTURE: Residents report a new road built by army engineers near Eldoret town.</div>
    <div class="eng"><span>88 reactions</span><span>9 comments</span></div><div class="act"><span>Like</span><span>Comment</span><span>Share</span></div></div>`
};
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 720, height: 600 }, deviceScaleFactor: 1 });
for (const [name, body] of Object.entries(shots)) {
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`);
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log("written", name);
}
// a WebP copy (supported format) and a GIF-like file with a .png name (refused: wrong format)
await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${shots["x-post.png"]}</body></html>`);
fs.writeFileSync(path.join(OUT, "x-post.webp"), await (await import("sharp")).default(await page.screenshot({ fullPage: true })).webp({ quality: 92 }).toBuffer());
fs.writeFileSync(path.join(OUT, "not-an-image.png"), "GIF89a this is not a supported screenshot");
await browser.close();

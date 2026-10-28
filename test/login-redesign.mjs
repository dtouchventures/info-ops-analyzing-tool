import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer, PW } from './helpers.js';
const s = await startServer();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(s.base); await page.locator('#lf').waitFor();
  assert.equal(await page.inputValue('#lu'), ''); assert.equal(await page.inputValue('#lp'), '');
  assert.equal(await page.locator('#lerr').isVisible(), false);
  assert.match(await page.locator('.art').innerText(), /Academic \/ unofficial/);
  for (const img of await page.locator('.login img').all()) assert.ok(await img.evaluate(i => i.complete && i.naturalWidth > 0));
  await page.fill('#lu', 'ana'); await page.fill('#lp', 'incorrect');
  await page.click('#loginReveal'); assert.equal(await page.locator('#lp').getAttribute('type'), 'text');
  await page.click('#lb'); await page.locator('#lerr:visible').waitFor();
  assert.equal(await page.inputValue('#lp'), ''); assert.equal(await page.locator('#lb').isEnabled(), true);
  await page.screenshot({ path: '../../outputs/login-desktop.png', fullPage: true });
  await page.fill('#lp', PW); await page.click('#lb'); await page.locator('.shell').waitFor();
  await page.reload(); await page.locator('.shell').waitFor();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('aivs:signedout')));
  await page.locator('#lf').waitFor(); assert.match(await page.locator('#lerr').innerText(), /session ended/);
  await page.evaluate(async () => fetch('/api/auth/logout', { method: 'POST', headers: { 'x-aivs': '1', 'content-type': 'application/json' }, body: '{}' }));
  await page.reload(); await page.locator('#lf').waitFor();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '../../outputs/login-mobile.png', fullPage: true });
  console.log('PASS: assets, empty credentials, failed/successful login, password toggle, session persistence/expiry, logout, widths 320–1440');
} finally { await browser.close(); await s.close(); s.ctx.db.close(); }


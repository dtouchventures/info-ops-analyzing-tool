import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const { startServer, PW } = await import(process.env.AIVS_TEST_HELPERS || './helpers.js');
const s = await startServer();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  let unavailable = false;
  await page.route('**/api/watch/overview', route => route.fulfill({ status: unavailable ? 503 : 200, json: unavailable ? { error: 'Test outage' } : { watchlists: [{ status: 'active' }], alert_counts: {}, stats: { monitoring: { active_watchlists: 1, datasets: 0, live_sources_connected: ['Test scheduled feed'], failed_checks: 0, last_successful_analysis: null, posts_checked: 0, posts_matched: 0 } } } }));
  await page.goto(s.base); await page.fill('#lu', 'ana'); await page.fill('#lp', PW); await page.click('#lb');
  await page.locator('.svc').first().waitFor();
  assert.match(await page.locator('.brand').innerText(), /JICHO AI/);
  assert.equal(await page.title(), 'JICHO AI · Information Operations Analysis');
  assert.match(await page.locator('[data-svc="watch"]').innerText(), /Awaiting first analysis/);
  assert.ok(!(await page.locator('[data-svc="watch"]').innerText()).includes('Monitoring active'));
  for (const width of [390, 768, 1024, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
  }
  await page.screenshot({ path: '../../outputs/jicho-dashboard.png', fullPage: true });
  unavailable = true;
  await page.reload(); await page.locator('.dashboard-load-warning').waitFor();
  assert.deepEqual(await page.locator('[data-svc="watch"] .svc-figs b').allTextContents(), ['—', '—']);
  console.log('PASS: dashboard branding, unrun monitoring state, unavailable totals, responsive widths 390–1366');
} finally { await browser?.close(); await s.close(); s.ctx.db.close(); }

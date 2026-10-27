import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { startServer, PW } from './helpers.js';

const S = await startServer();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage(); const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(S.base); await page.fill('#lu', 'ana'); await page.fill('#lp', PW); await page.click('#lb');
  await page.waitForSelector('.shell');
  async function start() { await page.goto(S.base + '/#/start'); await page.waitForSelector('#sGo'); }
  async function report() {
    await page.click('#sGo');
    await page.waitForURL(/\/automatic$/, { timeout: 60000 });
    await page.waitForSelector('a[href$="automatic-report.html"]', { timeout: 60000 });
    assert.ok((await page.textContent('#autoState')).includes('Preliminary'));
    const href = await page.getAttribute('a[href$="automatic-report.html"]', 'href');
    const response = await page.request.get(S.base + href);
    assert.equal(response.status(), 200);
    const html = await response.text();
    for (const heading of ['Background', 'Analysis', 'Assessment', 'Recommendations', 'Citations']) assert.ok(html.includes(`<h2>${heading}</h2>`));
    const id = (await page.url()).match(/case\/([^/]+)/)[1];
    return S.ctx.cases.aggregate(id);
  }
  await start(); await page.fill('#si', 'The city council opened three public libraries in Nairobi yesterday.');
  let agg = await report(); assert.equal(agg.case.conclusion, null);
  console.log('PASS text -> automatic dated report without analyst comments');

  await start();
  await page.setInputFiles('#sfi', { name: 'public-claim.txt', mimeType: 'text/plain', buffer: Buffer.from('The city council opened three public libraries in Nairobi yesterday.') });
  await page.waitForFunction(() => document.querySelector('#si').value.includes('three public libraries'));
  agg = await report(); assert.equal(agg.media[0].kind, 'document');
  console.log('PASS document upload -> extraction -> automatic report, original file preserved');

  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1500; c.height = 230; const x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0,0,c.width,c.height); x.fillStyle = 'black'; x.font = '38px Arial'; x.fillText('The city council opened three public libraries', 30, 85); x.fillText('in Nairobi yesterday.',30,150); return c.toDataURL('image/png').split(',')[1]; });
  await start(); await page.fill('#si', 'The city council opened three public libraries in Nairobi yesterday.');
  await page.setInputFiles('#sfi', { name: 'public-post.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  agg = await report(); assert.equal(agg.media[0].kind, 'image'); assert.ok(agg.ocr.length > 0, 'automatic OCR must be recorded');
  assert.match(agg.ocr[0].current_text, /public libraries/i);
  console.log('PASS screenshot -> local OCR -> saved text -> automatic report');
  const scanned = await new Promise(resolve => {
    const doc = new PDFDocument({ size: [750, 250] }), chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.image(Buffer.from(png, 'base64'), 0, 0, { width: 750 }); doc.end();
  });
  await start();
  await page.setInputFiles('#sfi', { name: 'scanned-public-post.pdf', mimeType: 'application/pdf', buffer: scanned });
  try { await page.waitForFunction(() => /public libraries/i.test(document.querySelector('#si').value) || !document.querySelector('#siMiss').hidden && document.querySelector('#siMiss').className === 'gmiss', null, { timeout: 60000 }); assert.match(await page.inputValue('#si'), /public libraries/i, await page.textContent('#siMiss')); }
  catch (error) { console.log('PDF extraction state:', await page.textContent('#siMiss'), 'Progress:', await page.textContent('#sprog'), 'Browser errors:', errors); throw error; }
  agg = await report(); assert.equal(agg.media[0].kind, 'document'); assert.ok(agg.ocr.length > 0);
  assert.match(agg.ocr[0].engine, /1\/1 pages/);
  console.log('PASS scanned PDF only -> page OCR -> extracted claims -> automatic report');
  assert.deepEqual(errors, []);
} finally { await browser.close(); await S.close(); S.ctx.db.close(); }

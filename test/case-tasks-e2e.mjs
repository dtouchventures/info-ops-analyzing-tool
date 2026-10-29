import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer, PW } from './helpers.js';

const S = await startServer();
let browser, release;
const gate = new Promise(r => release = r);
let failOnce = true;
S.ctx.tasks.register('collection', async (_u, _id, input) => {
  if (input.injected_failure && failOnce) { failOnce = false; throw new Error('Injected test failure'); }
  if (!input.injected_failure) await gate;
  return { connectors: [] };
});
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(S.base); await page.fill('#lu', 'ana'); await page.fill('#lp', PW); await page.click('#lb'); await page.locator('.shell').waitFor();
  const post = async (url, data) => { const r = await page.request.post(S.base + url, { headers: { 'x-aivs': '1' }, data }); assert.ok(r.ok(), `${url}: ${r.status()}`); return r.json(); };
  await page.click('[data-mode="advanced"]'); await page.locator('[data-mode="advanced"].on').waitFor();
  const c = await post('/api/cases', { claim_text: 'The council built a library. The school enrolled fifty pupils.' });
  await page.goto(`${S.base}/#/case/${c.id}/claims`); await page.locator('#nc').waitFor();
  await page.fill('#nc', 'The council built a library.'); await page.click('#ncAdd');
  await page.locator('.claim').first().waitFor();
  await page.fill('#nc', 'The school enrolled fifty pupils.'); await page.click('#ncAdd');
  await page.waitForFunction(() => document.querySelectorAll('.claim').length === 2);
  assert.equal(await page.locator('#ncAdd').count(), 0);
  assert.match(await page.locator('#page').innerText(), /Claims: 2\/2/);
  assert.match(await page.locator('#page').innerText(), /This case has reached the maximum limit of two claims\./);
  await page.click('#srchAll');
  const draft = 'An analyst can keep editing while collection runs.';
  await page.locator('[data-ctext]').first().fill(draft);
  await page.waitForTimeout(1800);
  assert.equal(await page.locator('[data-ctext]').first().inputValue(), draft, 'background polling must not discard active typing');
  await page.locator('h1').click();
  await page.locator('.nav a[href="#/settings"]').click(); await page.locator('#setPw').waitFor();
  await page.reload(); await page.locator('#setPw').waitFor();
  let tasks = await (await page.request.get(S.base + '/api/tasks')).json();
  assert.equal(tasks.tasks[0].status, 'processing');
  await page.waitForTimeout(200); assert.equal(await page.locator('h1').innerText(), 'Settings');
  release();
  await page.locator('.nav a[href="#/tasks"]').click();
  await page.getByText('Completed', { exact: true }).first().waitFor();
  await page.goto(`${S.base}/#/case/${c.id}/claims`); await page.locator('.claim').first().waitFor();
  assert.equal(await page.locator('.claim').count(), 2);
  await post('/api/cases/' + c.id + '/tasks', { kind: 'collection', input: { injected_failure: true } });
  await page.locator('.nav a[href="#/tasks"]').click(); await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-retry]'));
  await post('/api/auth/logout', {}); await page.reload(); await page.locator('#lf').waitFor();
  await page.fill('#lu', 'ana'); await page.fill('#lp', PW); await page.click('#lb'); await page.locator('.shell').waitFor();
  await page.goto(`${S.base}/#/case/${c.id}/claims`); await page.locator('.claim').first().waitFor();
  assert.match(await page.locator('#page').innerText(), /Claims: 2\/2/);
  for (const width of [390, 768, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).filter(e => !e.closest(".tabs,.nav")).slice(0, 12).map(e => [e.tagName, e.className, e.getBoundingClientRect().width]));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `case overflow at ${width}: ${JSON.stringify(overflow)}`);
  }
  const reportTask = await post(`/api/cases/${c.id}/tasks`, { kind: 'report', input: {} });
  await page.goto(S.base + '/#/tasks'); await page.locator('#taskList article').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('#taskList article')].some(x => x.textContent.includes('Report generation') && x.textContent.includes('Completed')));
  const report = await (await page.request.get(`${S.base}/api/cases/${c.id}/automatic-report.json`)).json();
  assert.equal(report.assessment.claims.length, 2);
  assert.ok(reportTask.id);
  await page.click('[data-mode="guided"]'); await page.locator('[data-mode="guided"].on').waitFor();
  const fastCase = await post('/api/cases', { claim_text: 'An office opened a public library. A school enrolled twelve new pupils.' });
  await page.goto(`${S.base}/#/case/${fastCase.id}/step1`); await page.locator('#gRun').waitFor();
  await page.click('#gRun'); await page.waitForURL(/\/step2$/, { timeout: 15000 });
  // A legacy case retains all historical rows, but needs an explicit two-claim
  // selection. Its failed report then retries using the same task record.
  const user = S.ctx.db.prepare("SELECT * FROM users WHERE username='ana'").get();
  const legacyId = S.ctx.cases.create(user, { claim_text: 'A historical case with three saved statements.' });
  const trigger = S.ctx.db.prepare("SELECT sql FROM sqlite_master WHERE name='claims_case_limit_insert'").get().sql;
  S.ctx.db.exec('DROP TRIGGER claims_case_limit_insert');
  for (let n = 1; n <= 3; n++) S.ctx.db.prepare("INSERT INTO claims(id,case_id,seq,text,origin,kind,created_by,created_at) VALUES (?,?,?,?,'analyst','statement',?,?)").run(`CL-ui-legacy-${n}`, legacyId, n, `Historical statement ${n}`, user.id, new Date().toISOString());
  S.ctx.db.exec(trigger);
  await page.goto(`${S.base}/#/case/${legacyId}/automatic`); await page.locator('#autoRun').waitFor();
  await page.click('#autoRun'); await page.getByRole('button', { name: 'Retry failed task', exact: true }).waitFor();
  const failedReport = (await (await page.request.get(S.base + '/api/tasks')).json()).tasks.find(t => t.case_id === legacyId);
  await page.goto(`${S.base}/#/case/${legacyId}/claims`); await page.locator('[data-legacy-claim]').first().waitFor();
  await page.locator('[data-legacy-claim]').nth(0).check(); await page.locator('[data-legacy-claim]').nth(1).check(); await page.click('#selectLegacyClaims');
  await page.waitForFunction(() => !document.querySelector('#selectLegacyClaims'));
  await page.goto(`${S.base}/#/case/${legacyId}/automatic`); await page.getByRole('button', { name: 'Retry failed task', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry failed task', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#autoState')?.textContent.includes('2 claims'));
  assert.equal(S.ctx.db.prepare('SELECT COUNT(*) n FROM claims WHERE case_id=?').get(legacyId).n, 3);
  assert.equal((await (await page.request.get(`${S.base}/api/tasks/${failedReport.id}`)).json()).status, 'completed');
  await page.goto(S.base + '/#/tasks'); await page.locator('#taskList article').first().waitFor();
  await page.screenshot({ path: '../../outputs/jicho-background-tasks.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: two-claim UI, navigation during processing, refresh, results on return, retry, logout/login, report scope, mobile layout, active typing preserved, legacy selection/report retry, no browser errors');
} finally {
  release(); await browser?.close();
  for (let i = 0; i < 100 && !S.ctx.tasks.idle(); i++) await new Promise(r => setTimeout(r, 50));
  S.ctx.tasks.close(); await S.close(); S.ctx.db.close();
}

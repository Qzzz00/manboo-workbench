/** Production App/main + saved genuine product task state. No API/room response fixtures. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.COLLAB_1C_BROWSER_ROOT;
assert(root, 'COLLAB_1C_BROWSER_ROOT required');
const { chromium } = await import(process.env.COLLAB_1C_PLAYWRIGHT ?? '/tmp/collab-mobile-verify/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ headless: true, executablePath: process.env.COLLAB_1C_CHROME ?? '/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
const pairing = JSON.parse(readFileSync(join(root, 'registered-source/browser-session.json'), 'utf8'));
const original = JSON.parse(readFileSync(join(root, 'registered-source/tasks.json'), 'utf8')).tasks.find(t => t.id === 't-0cedf22c');
assert(original?.links?.some(l => l.agent === 'codex'), 'real saved source required');
const link = original.links.find(l => l.agent === 'codex');
const checks = [], responses = [], errors = [];
const check = (name, ok) => { assert(ok, name); checks.push(name); console.log('PASS', name); };
mkdirSync(join(root, 'screens'), { recursive: true });
let page;
try {
  for (const width of [375, 430]) {
    const context = await browser.newContext({ viewport: { width, height: 812 }, deviceScaleFactor: 1 });
    await context.addInitScript(p => {
      localStorage.setItem('CapacitorStorage.butler.pairing', JSON.stringify(p));
      localStorage.setItem('CapacitorStorage.butler.settings', JSON.stringify({ voiceEnabled: false, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit', ringStandby: false }));
    }, pairing);
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', async res => {
      const url = new URL(res.url());
      if (url.pathname.startsWith('/sessions/') || /^\/butler\/item\/[^/]+\/continue$/.test(url.pathname)) responses.push({ width, path: url.pathname + url.search, status: res.status(), body: await res.json().catch(() => null) });
    });
    await page.goto(process.env.COLLAB_1C_APP_URL ?? 'http://127.0.0.1:9695/', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('打字说给事务官').waitFor();
    check(`${width} homepage fits`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(root, 'screens', `home-${width}.png`) });
    const open = () => page.getByRole('button', { name: /^打开「修改代码任务的验收/ }).click();
    await open();
    await page.getByRole('button', { name: '查看原会话：codex 的会话' }).click();
    const readback = page.getByRole('region', { name: '原会话回读' });
    await readback.getByText(/原件验收真实执行已经收到\./).waitFor();
    check(`${width} exact registered transcript rendered`, (await readback.innerText()).includes(original.dispatch.reply));
    const digest = await page.evaluate(async ({ p, id }) => {
      const res = await fetch(`http://${p.host}:${p.port}/sessions/digest?agent=codex&id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${p.token}` } });
      return { status: res.status, body: await res.json() };
    }, { p: pairing, id: link.session_id });
    check(`${width} same session digest contains actual reply`, digest.status === 200 && digest.body.session_id === link.session_id && JSON.stringify(digest.body.rounds).includes(original.dispatch.reply));
    check(`${width} sheet fits`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(root, 'screens', `original-${width}.png`) });
    await page.setViewportSize({ width, height: 430 });
    const draft = page.getByLabel('接着说');
    await draft.focus(); await draft.scrollIntoViewIfNeeded();
    const box = await draft.boundingBox();
    check(`${width} reduced viewport composer reachable`, box && box.y >= 0 && box.y + box.height <= 431);
    await page.screenshot({ path: join(root, 'screens', `keyboard-viewport-${width}.png`) });
    await page.setViewportSize({ width, height: 812 });
    await context.setOffline(true);
    await draft.fill(`1c 原件离线草稿 ${width}`);
    await page.waitForFunction(text => Object.keys(localStorage).some(key => key.startsWith('wb.continue.draft.') && localStorage.getItem(key)?.includes(text)), `1c 原件离线草稿 ${width}`);
    await page.screenshot({ path: join(root, 'screens', `offline-draft-${width}.png`) });
    await context.setOffline(false);
    await page.reload({ waitUntil: 'domcontentloaded' }); await open();
    await page.waitForFunction(text => document.querySelector('textarea[aria-label="接着说"]')?.value === text, `1c 原件离线草稿 ${width}`);
    check(`${width} offline draft survives actual reload`, await page.getByLabel('接着说').inputValue() === `1c 原件离线草稿 ${width}`);
    await context.close();
  }
  check('no uncaught production browser errors', errors.length === 0);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(root, 'screens/failure.png') }); writeFileSync(join(root, 'browser-failure.txt'), await page.locator('body').innerText()); }
  throw error;
} finally {
  writeFileSync(join(root, 'registered-browser.json'), JSON.stringify({ original: { task_id: original.id, session_id: link.session_id, cwd: original.dispatch.cwd, reply: original.dispatch.reply }, checks, responses, errors, boundary: 'Actual production App in Chrome for Testing. Reduced viewport is not an OS keyboard or physical phone. Digest was requested by the browser; transcript was rendered by the production original-source button.' }, null, 2));
  await browser.close();
}

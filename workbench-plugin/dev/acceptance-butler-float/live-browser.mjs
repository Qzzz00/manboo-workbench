import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.COLLAB_1C_BROWSER_ROOT; assert(root);
const session = JSON.parse(readFileSync(process.env.COLLAB_1C_DESKTOP_SESSION ?? join(root, 'decision-source/browser-session.json'), 'utf8'));
const pairing = session.pairing ?? session;
const { chromium } = await import('/tmp/collab-mobile-verify/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ headless: true, executablePath: '/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
const checks = [], posts = [], errors = [];
let page;
try {
  for (const size of [{ width: 560, height: 730 }, { width: 1475, height: 812 }]) {
    const context = await browser.newContext({ viewport: size });
    await context.addInitScript(p => { window.__collab1cPairing = p; }, pairing);
    page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', e => errors.push(e.message));
    page.on('response', async res => { if (new URL(res.url()).pathname === '/butler/say' && res.request().method() === 'POST') posts.push({ size, request: res.request().postDataJSON(), status: res.status(), body: await res.json() }); });
    await page.goto(`${process.env.COLLAB_1C_DESKTOP_APP ?? 'http://127.0.0.1:9694/live.html'}?full=${size.width > 1000 ? 1 : 0}`, { waitUntil: 'domcontentloaded' });
    const field = page.getByLabel('交给事务官一件事'); await field.waitFor();
    const before = posts.length;
    await field.fill(`记一下${size.width}窄浮窗确认验收，建之前先跟我确认一下`);
    await page.getByRole('button', { name: '交给事务官', exact: true }).click();
    const end = Date.now() + 20_000; while (posts.length === before && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    const got = posts.at(-1); assert(posts.length > before && got.status === 200 && got.body.ask?.ask_id, JSON.stringify(got));
    await page.getByText(got.body.say.screen, { exact: true }).first().waitFor();
    const fieldBox = await field.boundingBox(); const button = page.getByRole('button', { name: '否定', exact: true });
    await button.scrollIntoViewIfNeeded(); const cardBox = await button.boundingBox();
    assert(fieldBox && cardBox && fieldBox.y >= cardBox.y + cardBox.height && fieldBox.y + fieldBox.height <= size.height, JSON.stringify({ fieldBox, cardBox }));
    checks.push({ size, screen: got.body.say.screen, fieldBox, cardBox });
    await page.screenshot({ path: join(root, 'screens', `desktop-${size.width}.png`) });
    const actionBefore = posts.length;
    await button.click();
    const actionEnd = Date.now() + 20_000; while (posts.length === actionBefore && Date.now() < actionEnd) await new Promise(r => setTimeout(r, 100));
    const action = posts.at(-1); assert(posts.length > actionBefore && action.status === 200 && action.request.ctx.confirmed.choice === 'no' && !action.body.items?.some(item => item.card_id));
    await page.getByText(action.body.say.screen, { exact: true }).first().waitFor();
    console.log('PASS real desktop geometry / ask / refusal', size.width);
    await context.close();
  }
  assert(errors.length === 0, JSON.stringify(errors));
} catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: join(root, 'screens/desktop-failure.png') }); writeFileSync(join(root, 'desktop-failure.txt'), await page.locator('body').innerText()); } throw error; }
finally { writeFileSync(join(root, 'desktop-browser.json'), JSON.stringify({ checks, posts, errors }, null, 2)); await browser.close(); }

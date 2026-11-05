/** Read the actual option-dispatched original after a normal saved-product-state reload. No new CLI call. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.COLLAB_1C_BROWSER_ROOT; assert(root);
const p = JSON.parse(readFileSync(join(root, 'option-reader/browser-session.json'), 'utf8'));
const state = JSON.parse(readFileSync(join(root, 'option-reader/tasks.json'), 'utf8'));
const task = state.tasks.find(t => t.id === 't-18d28421');
assert(task.dispatch.reply === 'QA_1C_SUGGEST_REAL');
const link = task.links.find(l => l.agent === 'codex' && l.session_id === task.dispatch.session_id); assert(link);
const { chromium } = await import('/tmp/collab-mobile-verify/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ headless: true, executablePath: '/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
let page; const evidence = { task_id: task.id, session_id: link.session_id, sameCard: task.assignee, reply: task.dispatch.reply };
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addInitScript(p => { localStorage.setItem('CapacitorStorage.butler.pairing', JSON.stringify(p)); localStorage.setItem('CapacitorStorage.butler.settings', JSON.stringify({ voiceEnabled: false, onboarding: 'done', stage: 'particles', callProvider: 'livekit', ringStandby: false })); }, p);
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('response', async res => { if (new URL(res.url()).pathname === '/sessions/transcript') evidence.transcript = { status: res.status(), body: await res.json() }; });
  await page.goto('http://127.0.0.1:9695/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '记录', exact: true }).click();
  await page.getByRole('button', { name: '事项', exact: true }).click();
  await page.getByRole('tab', { name: /^等你/ }).click();
  await page.getByText(task.title, { exact: true }).click();
  await page.getByRole('button', { name: '查看原会话：codex 的会话' }).click();
  const readback = page.getByRole('region', { name: '原会话回读' });
  await readback.getByText(/QA_1C_SUGGEST_REAL/).last().waitFor();
  evidence.uiReadback = await readback.innerText();
  assert(evidence.uiReadback.includes(task.dispatch.reply));
  await readback.locator('.ba-rounds__reply').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, 'screens/option-original-product-readback.png') });
  evidence.digest = await page.evaluate(async ({ p, id }) => { const res = await fetch(`http://${p.host}:${p.port}/sessions/digest?agent=codex&id=${id}`, { headers: { authorization: `Bearer ${p.token}` } }); return { status: res.status, body: await res.json() }; }, { p, id: link.session_id });
  evidence.digestHasReply = evidence.digest.status === 200 && evidence.digest.body.session_id === link.session_id && JSON.stringify(evidence.digest.body.rounds).includes(task.dispatch.reply);
  console.log('PASS actual production App exact option original transcript', task.id, link.session_id);
  console.log('Fresh service same-session digest contains actual reply:', evidence.digestHasReply);
  assert(evidence.digestHasReply, 'Keep the original digest reply assertion; never fabricate a digest from transcript');
} catch (error) { evidence.error = String(error); if (page) await page.screenshot({ path: join(root, 'screens/option-original-last.png') }); throw error; }
finally { writeFileSync(join(root, 'option-original-browser.json'), JSON.stringify(evidence, null, 2)); await browser.close(); }

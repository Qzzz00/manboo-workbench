/** Genuine user QA choices -> production learning -> API decisions -> production App -> real Codex. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.COLLAB_1C_BROWSER_ROOT; assert(root);
const source = join(root, 'decision-source');
const pairing = JSON.parse(readFileSync(join(source, 'browser-session.json'), 'utf8'));
const { cardId } = JSON.parse(readFileSync(join(source, 'actions-ready.json'), 'utf8'));
const evidence = existsSync(join(root, 'decision-actions.json')) ? JSON.parse(readFileSync(join(root, 'decision-actions.json'), 'utf8')) : [];
const save = (stage, data) => { evidence.push({ stage, ...data }); writeFileSync(join(root, 'decision-actions.json'), JSON.stringify(evidence, null, 2)); console.log(stage, JSON.stringify(data)); };
const base = `http://${pairing.host}:${pairing.port}`;
async function api(path, body) {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const data = await res.json(); assert(res.ok, `${path} HTTP ${res.status}: ${JSON.stringify(data)}`); return data;
}
async function receipt(id) {
  const end = Date.now() + 150_000;
  while (Date.now() < end) {
    const state = await api('/state'); const task = state.tasks?.tasks.find(t => t.id === id);
    if (task?.dispatch?.status === 'done' || task?.dispatch?.status === 'failed' || task?.dispatch_block) return task;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`No genuine receipt: ${id}`);
}
// Two actual distinct choices are the product's documented minimum; never seed behavior/habit files.
for (const marker of ['A', 'B']) {
  const prior = evidence.find(row => row.stage === 'genuine-training-receipt' && row.task?.title.startsWith(`修改代码运输反馈${marker}。`));
  if (prior) { const actual = await receipt(prior.task.id); assert(actual.dispatch?.status === 'done' && actual.dispatch.session_id === prior.task.dispatch.session_id); console.log('REUSE genuine choice', actual.id); continue; }
  const task = await api('/task/create', { title: `修改代码运输反馈${marker}。只回复 QA_1C_PICK_${marker}。不要使用工具、读写仓库、报告统筹状态或另起代理。`, assignee: cardId, status: 'todo' });
  const choices = await api(`/dispatch/choices?item=${task.id}`);
  save('genuine-choice', { id: task.id, default: choices.default, options: choices.options });
  assert(choices.default && choices.default !== 'codex', 'Need genuine recommendation difference; do not fabricate learning');
  const run = await api('/dispatch/run', { item_id: task.id, app: 'codex', kind: 'code', source: 'ui' });
  assert(run.ok, JSON.stringify(run));
  const actual = await receipt(task.id); save('genuine-training-receipt', { task: actual });
  assert(actual.dispatch?.status === 'done' && actual.dispatch.reply?.includes(`QA_1C_PICK_${marker}`) && actual.links?.some(l => l.agent === 'codex' && l.session_id === actual.dispatch.session_id));
}
let learned;
for (let i = 0; i < 40; i++) {
  learned = await api('/habits');
  if ([...(learned.trial ?? []), ...(learned.kept ?? [])].some(h => h.kind === 'dispatch' && h.id === '分派:写代码的活→codex')) break;
  await new Promise(r => setTimeout(r, 250));
}
save('production-learned-default', { learned });
assert([...(learned.trial ?? []), ...(learned.kept ?? [])].some(h => h.kind === 'dispatch' && h.id === '分派:写代码的活→codex'), 'Real feedback must produce default');
const { chromium } = await import(process.env.COLLAB_1C_PLAYWRIGHT ?? '/tmp/collab-mobile-verify/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ headless: true, executablePath: process.env.COLLAB_1C_CHROME ?? '/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
let page;
try {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await ctx.addInitScript(p => { localStorage.setItem('CapacitorStorage.butler.pairing', JSON.stringify(p)); localStorage.setItem('CapacitorStorage.butler.settings', JSON.stringify({ voiceEnabled: false, onboarding: 'done', stage: 'particles', callProvider: 'livekit', ringStandby: false })); }, pairing);
  page = await ctx.newPage(); page.setDefaultTimeout(20_000);
  const priorPosts = evidence.filter(row => ['production-app-decided', 'production-app-suggestion', 'production-app-option-action'].includes(row.stage));
  if (priorPosts.length) await page.route('**/butler/say', async route => {
    const input = route.request().postDataJSON();
    // Genuine duplicate replay: only re-use the exact original request, never an invented response.
    const prior = priorPosts.find(row => row.request.text === input.text);
    await route.continue(prior ? { postData: JSON.stringify(prior.request) } : {});
  });
  const posts = [];
  page.on('response', async res => { if (new URL(res.url()).pathname === '/butler/say' && res.request().method() === 'POST') posts.push({ request: res.request().postDataJSON(), status: res.status(), body: await res.json() }); });
  await page.goto('http://127.0.0.1:9695/', { waitUntil: 'domcontentloaded' });
  async function waitPost(before) { const end = Date.now() + 30_000; while (posts.length === before && Date.now() < end) await new Promise(r => setTimeout(r, 100)); assert(posts.length > before, 'production App response timeout'); return posts.at(-1); }
  async function send(text) { const before = posts.length; await page.getByLabel('打字说给事务官').fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); return waitPost(before); }
  const decided = await send('安排代码运输验收甲'); save('production-app-decided', decided);
  assert(decided.status === 200 && decided.body.decided?.[0]?.decided_id && decided.body.items?.[0]?.card_id);
  const first = decided.body.items[decided.body.decided[0].item_index];
  await page.getByRole('button', { name: '记录', exact: true }).click();
  await page.getByText(`原件：${first.title} · 事项 ID ${first.card_id}`, { exact: true }).waitFor();
  const actualDecided = await receipt(first.card_id); save('decided-real-item', { task: actualDecided });
  assert(actualDecided.assignee === cardId && actualDecided.dispatch?.reply?.includes('QA_1C_DECIDED_REAL'));
  await page.screenshot({ path: join(root, 'screens/decided-real-item.png') });
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const suggestion = await send('建议代码运输验收乙'); save('production-app-suggestion', suggestion);
  assert(suggestion.body.suggest?.suggest_id && suggestion.body.suggest.options.some(o => o.id === 'codex'));
  const suggestionCard = suggestion.body.items[0].card_id;
  const before = posts.length;
  await page.getByRole('button', { name: '记录', exact: true }).click();
  await page.getByRole('region', { name: '事务官处理结果' }).getByRole('button', { name: 'codex', exact: true }).click();
  await waitPost(before);
  const choice = posts.at(-1); save('production-app-option-action', choice);
  assert.deepEqual(choice.request.ctx.suggest, { suggest_id: suggestion.body.suggest.suggest_id, choice: 'codex' });
  assert(choice.body.items[0].card_id === suggestionCard && choice.body.items[0].status === 'done');
  await page.getByText(choice.body.say.screen, { exact: true }).first().waitFor();
  const actualSuggestion = await receipt(suggestionCard); save('suggestion-real-receipt', { task: actualSuggestion });
  assert(actualSuggestion.assignee === cardId && actualSuggestion.dispatch?.reply?.includes('QA_1C_SUGGEST_REAL'));
  await page.screenshot({ path: join(root, 'screens/suggest-real-option.png') });
  const link = actualSuggestion.links.find(l => l.agent === 'codex' && l.session_id === actualSuggestion.dispatch.session_id);
  assert(link);
  for (const kind of ['transcript', 'digest']) { const data = await api(`/sessions/${kind}?agent=codex&id=${encodeURIComponent(link.session_id)}`); save(`natural-${kind}`, { data }); assert(data.session_id === link.session_id && JSON.stringify(data).includes('QA_1C_SUGGEST_REAL')); }
  save('complete', { genuineExecutions: JSON.parse(readFileSync(join(source, 'executions.json'), 'utf8')), modelBoundary: 'Only understanding plans are explicit fixtures. All four Codex executions, learning evidence, links, decisions, actions and replies are actual production services.' });
} catch (error) { if (page) { await page.screenshot({ path: join(root, 'screens/decision-failure.png') }); save('failure-ui', { text: await page.locator('body').innerText() }); } throw error; }
finally { await browser.close(); }

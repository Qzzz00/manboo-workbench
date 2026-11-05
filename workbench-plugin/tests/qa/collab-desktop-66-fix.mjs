/** Fixed-66 review delta. Real UI/HTTP, isolated copy of prior natural receipts; no execution engine. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
export async function concentratedAcceptance(ctx) {
  const { dir, plugin, primary, peer, api, record, startChild, until, closePeer, browser, evaluate, input, click, shown } = ctx
  const initial = await api(primary, '/state')
  const card = initial.tasks.agent_cards.find(one => one.name === 'QA Codex 只读核验')
  const nativeParent = initial.tasks.tasks.find(one => one.title === '协作核验原事项')
  const nativeChild = initial.tasks.tasks.find(one => one.id === nativeParent.children[0])
  assert.match(nativeChild.receipt.text, /89/)
  assert(primary.jobLog.events(nativeChild.id).some(one => one.step === 'replied'))
  const goal = await api(primary, '/collab/goal/create', { title: '集中修复能力目标', project_id: 'qa-shared-project' })
  const other = await api(primary, '/collab/goal/create', { title: '跨目标子事范围', project_id: 'qa-shared-project' })
  const make = async (title, goalId = goal.id) => ({ title, ...await api(primary, '/task/create', { title, acceptance: ['能在生产 UI 定位本事项，准确保留动作与关系事实'], status: 'todo', assignee: 'me', goal_id: goalId, project_id: 'qa-shared-project', from: { kind: 'said', quote: '原66独审定向负例与修复验证' } }) })
  const retry = await make('集中修复重试事项')
  const parent = await make('集中修复父组')
  const child = await make('集中修复第二层')
  const grand = await make('集中修复第三层')
  const cross = await make('集中修复跨目标子事', other.id)
  await api(primary, '/task/update', { id: parent.id, children: [child.id, cross.id] })
  await api(primary, '/task/update', { id: child.id, children: [grand.id] })
  const conditionNames = ['读取真实受控输入', '交回复核命令', '按回执接续修改']
  for (const text of conditionNames) await api(primary, '/collab/goal/condition/save', { goal_id: goal.id, text, task_id: nativeChild.id, evidence: ['原自然 CLI 回执 89 / 对应 started,replied 记录（只读保全副本）'] })
  const require = createRequire(import.meta.url)
  const vite = join(dirname(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json')), 'bin/vite.js')
  startChild(process.execPath, [vite, '--config', 'dev/collab-board/vite.config.mjs', '--port', '9991', '--strictPort'], { cwd: plugin })
  await until(() => fetch('http://127.0.0.1:9991/desktop-test.html').then(r => r.ok).catch(() => false), Boolean, 'Vite ready')
  const client = await browser()
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__qaPosted = []; window.__qaFault = {};
    const qaFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      const hit = String(url).endsWith('/collab/note/message') && init?.method === 'POST';
      if (hit) window.__qaPosted.push(JSON.parse(init.body));
      const response = await qaFetch(url, init);
      if (hit && window.__qaFault.drop) { window.__qaFault.drop = false; throw new TypeError('QA: server processed, response lost'); }
      if (hit && window.__qaFault.hold) { window.__qaFault.hold = false; return await new Promise(resolve => { window.__qaRelease = () => resolve(response); window.__qaHeld = true; }); }
      return response;
    };
  ` })
  const url = `http://127.0.0.1:9991/desktop-test.html?live=1&view=goals&api=${encodeURIComponent(primary.url)}`
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await client.send('Page.navigate', { url })
  const press = async (name, root = 'document') => { await shown(`Array.from((${root}).querySelectorAll('button')).some(b => (b.textContent.trim() === ${JSON.stringify(name)} || b.getAttribute('aria-label') === ${JSON.stringify(name)}) && !b.disabled)`); await evaluate(`Array.from((${root}).querySelectorAll('button')).find(b => (b.textContent.trim() === ${JSON.stringify(name)} || b.getAttribute('aria-label') === ${JSON.stringify(name)}) && !b.disabled).click()`) }
  const talk = "document.querySelector('.ben-cl__talk')"
  const reload = async () => {
    const previous = await evaluate('performance.timeOrigin')
    await client.send('Page.reload')
    await shown(`performance.timeOrigin !== ${previous} && document.readyState === 'complete' && !!document.querySelector('.ben-cl__reading')`)
  }
  const cardSelector = id => `[data-note-id="${id}"]`
  const open = async id => {
    await shown(`!!document.querySelector(${JSON.stringify(`${cardSelector(id)} .ben-cl__note-title`)})`)
    await evaluate(`document.querySelector(${JSON.stringify(`${cardSelector(id)} .ben-cl__note-title`)}).click()`)
    await shown(`!!document.querySelector('.ben-cl__dialog [aria-label="留一句"]')`)
  }
  const close = () => evaluate(`document.querySelector('button[aria-label="关上"]')?.click(); document.querySelector('button[aria-label="关上速览"]')?.click()`)
  const shot = async (name, selector) => { if (selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`); await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))') } const value = await client.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(dir, `${name}.png`), Buffer.from(value.data, 'base64')) }
  const stateTask = async id => (await api(primary, '/state')).tasks.tasks.find(one => one.id === id)

  // R1: actual record is persisted by server, then its response is deliberately dropped.
  await open(retry.id)
  await input('留一句', `@${card.name} 只记这次检查，不派活`)
  await evaluate('window.__qaFault.drop = true')
  await press('只留记录', talk)
  await shown(`document.querySelector('[aria-label="待确认动作"]')?.textContent.includes('没应答')`)
  const recordBody = await evaluate('window.__qaPosted.at(-1)')
  assert.equal(recordBody.intent, 'record')
  await press('重发', talk)
  await shown(`!document.querySelector('[aria-label="待确认动作"]')`)
  assert.deepEqual(await evaluate('window.__qaPosted.at(-1)'), recordBody)
  const recorded = await stateTask(retry.id)
  assert.equal(recorded.messages.filter(one => one.client_msg_id === recordBody.client_msg_id).length, 1)
  assert.equal(recorded.children?.length ?? 0, 0)
  writeFileSync(join(dir, 'R1-recorded-task.json'), JSON.stringify(recorded, null, 2))
  record('R1_actual_record_response_lost_retry_same_body_no_child', { request: recordBody, messageCount: 1, childCount: 0 })

  // R2: actual ask creates one child, no engine is registered; it cannot execute a model.
  await shown(`document.querySelector('[aria-label="事项活动"] button') !== null`)
  await press('回复', `document.querySelector('[aria-label="事项活动"]')`)
  await input('留一句', `@${card.name} 定向重试检查`)
  await evaluate('window.__qaFault.drop = true')
  await press('请 TA 处理', talk)
  await shown(`document.querySelector('[aria-label="待确认动作"]')?.textContent.includes('没应答')`)
  const askBody = await evaluate('window.__qaPosted.at(-1)')
  await close()
  await shown(`!!document.querySelector(${JSON.stringify(`${cardSelector(retry.id)} .ben-cl__note-talk`)})`)
  await evaluate(`document.querySelector(${JSON.stringify(`${cardSelector(retry.id)} .ben-cl__note-talk`)}).click()`)
  await shown(`!!document.querySelector('.ben-cl__quickview [aria-label="待确认动作"]')`)
  await press('打开详情')
  await shown(`!!document.querySelector('.ben-cl__dialog [aria-label="待确认动作"]')`)
  await reload()
  await open(retry.id)
  await shown(`document.querySelector('[aria-label="回复对象与原文"]')?.textContent.includes(${JSON.stringify(askBody.reply_to)})`)
  await press('重发', talk)
  await shown(`!document.querySelector('[aria-label="待确认动作"]')`)
  assert.deepEqual(await evaluate('window.__qaPosted.at(-1)'), askBody)
  const asked = await stateTask(retry.id)
  assert.equal(asked.messages.filter(one => one.client_msg_id === askBody.client_msg_id).length, 1)
  assert.equal(asked.children.length, 1)
  writeFileSync(join(dir, 'R2-asked-task.json'), JSON.stringify(asked, null, 2))
  record('R2_actual_ask_quick_detail_reload_preserves_id_reply_body_one_child', { request: askBody, messageCount: 1, childCount: 1, modelExecutions: 0 })

  // R2: A response resolves after the original component unmounts and B is written.
  await input('留一句', '迟到 A，只记')
  await evaluate('window.__qaFault.hold = true')
  await press('留言', talk)
  await shown('window.__qaHeld === true')
  record('R2_late_A_held')
  await close()
  await shown(`!!document.querySelector(${JSON.stringify(`${cardSelector(retry.id)} .ben-cl__note-talk`)})`)
  await evaluate(`document.querySelector(${JSON.stringify(`${cardSelector(retry.id)} .ben-cl__note-talk`)}).click()`)
  await shown(`!!document.querySelector('.ben-cl__quickview [aria-label="留一句"]')`)
  await input('留一句', '后写 B，必须保留')
  record('R2_B_written')
  await evaluate('window.__qaRelease()')
  await shown(`!document.querySelector('[aria-label="待确认动作"]') && document.querySelector('[aria-label="留一句"]').value === '后写 B，必须保留'`)
  await reload()
  await open(retry.id)
  assert.equal(await evaluate(`document.querySelector('[aria-label="留一句"]').value`), '后写 B，必须保留')
  writeFileSync(join(dir, 'R2-restored-composer.json'), await evaluate(`localStorage.getItem('ben-wb.note-draft.${retry.id}')`))
  await shot('R2-restored-B', '[aria-label="留一句"]')
  record('R2_late_A_response_cannot_clear_B_across_components_and_reload')
  await close()

  // R3: reply to an actual prior native receipt, exact stable author, explicit action without @.
  await open(nativeParent.id)
  await press('回复回执', talk)
  await shown(`document.querySelector('[aria-label="回复对象与原文"]')?.textContent.includes(${JSON.stringify(card.id)})`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="回复对象与原文"]').textContent.includes('89')`), true)
  await input('留一句', '请按这条原回执重新核对第二行')
  await shot('R3-explicit-receipt-reply', '[aria-label="回复对象与原文"]')
  await press('请 TA 处理', talk)
  await shown(`!document.querySelector('[aria-label="待确认动作"]')`)
  const replyBody = await evaluate('window.__qaPosted.at(-1)')
  assert.equal(replyBody.intent, 'ask')
  assert.deepEqual(replyBody.mentions, [card.id])
  assert.match(replyBody.text, /89/)
  assert.match(replyBody.text, /回执/)
  writeFileSync(join(dir, 'R3-reply-task.json'), JSON.stringify(await stateTask(nativeParent.id), null, 2))
  record('R3_real_receipt_explicit_ask_exact_author_without_at', { request: replyBody, modelExecutions: 0 })
  await close()

  // R4/5: real API group graph, unique cards in correct goal, nested collapse and parent constraints.
  for (const one of [parent, child, grand, cross]) await shown(`document.querySelectorAll(${JSON.stringify(cardSelector(one.id))}).length === 1`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(cardSelector(cross.id))}).closest('section').id`), `ben-cl-goal-${other.id}`)
  await press(`收起子事 · ${parent.title}`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(cardSelector(grand.id))}).closest('[hidden]') !== null`), true)
  await press(`展开子事 · ${parent.title}`)
  await open(parent.id)
  assert.equal(await evaluate(`document.querySelector('.ben-cl__dialog .ben-cl__stamp').disabled`), true)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.ben-cl__dialog button')).find(b => b.textContent.trim() === '通过').disabled`), true)
  await shot('R4-R5-parent-detail', '.ben-cl__dlg-block[aria-label="留言"]')
  await close()
  await press(`收起子事 · ${parent.title}`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('本轮剩余')).click()`)
  await press(`定位: ${grand.title}`)
  await shown(`document.querySelector(${JSON.stringify(cardSelector(grand.id))}).closest('[hidden]') === null`)
  await shown(`document.querySelector('.ben-cl__dialog')?.textContent.includes(${JSON.stringify(grand.title)})`)
  await close()
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('本轮剩余')).click()`)
  await evaluate(`document.querySelector('[data-group="${parent.id}"]').scrollIntoView({ block: 'start' })`)
  await shot('R4-recursive-reading-group')
  writeFileSync(join(dir, 'R4-group-tasks.json'), JSON.stringify(await Promise.all([parent, child, grand, cross].map(one => stateTask(one.id))), null, 2))
  record('R4_R5_actual_cross_goal_three_level_collapse_parent_detail_readonly', { ids: [parent.id, child.id, grand.id, cross.id] })

  // R6: real board projection remains outside task scroll and reacts to real verify/deliver.
  await evaluate(`(() => { const el = document.querySelector('[aria-label="当前目标"]'); el.value = ${JSON.stringify(goal.id)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  await shown(`document.querySelector('[aria-label="当前目标能力摘要"]')?.textContent.includes('剩余条件 3')`)
  const before = await api(primary, `/collab/goal/board?goal_id=${goal.id}`)
  writeFileSync(join(dir, 'R6-board-before.json'), JSON.stringify(before, null, 2))
  const condition = before.summary.conditions.items[0]
  await api(primary, '/collab/goal/condition/verify', { goal_id: goal.id, condition_id: condition.id, pass: true, by: 'me', note: '对照保全的真实自然回执与受控输入总和89；本次只验摘要消费' })
  await api(primary, '/collab/goal/condition/deliver', { goal_id: goal.id, condition_id: condition.id })
  await shown(`document.querySelector('[aria-label="当前目标能力摘要"]')?.textContent.includes('剩余条件 2')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="当前目标能力摘要"]').closest('.ben-cl__reading, .ben-cl__board') === null`), true)
  const after = await api(primary, `/collab/goal/board?goal_id=${goal.id}`)
  writeFileSync(join(dir, 'R6-board-after.json'), JSON.stringify(after, null, 2))
  await shot('R6-fixed-capability-summary')
  record('R6_fixed_real_goal_board_remaining_updates_outside_scroll', { before: before.summary.conditions.by_state, after: after.summary.conditions.by_state })

  // Full screen / canvas sibling route keeps both group and fixed-summary constraints.
  await client.send('Page.navigate', { url: `${url}&full=1` })
  await shown(`!!document.querySelector('.react-flow') && !!document.querySelector(${JSON.stringify(cardSelector(parent.id))})`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${cardSelector(parent.id)} .ben-cl__stamp`)}).disabled`), true)
  await evaluate(`(() => { const el = document.querySelector('[aria-label="当前目标"]'); el.value = ${JSON.stringify(goal.id)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  await shown(`document.querySelector('[aria-label="当前目标能力摘要"]')?.textContent.includes('剩余条件 2')`)
  await shot('R5-R6-full-canvas')
  record('R5_R6_fullscreen_canvas_parent_readonly_fixed_summary')
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
  await press('阅读')
  await shown(`!!document.querySelector('.ben-cl__reading')`)
  const summaryTop = await evaluate(`document.querySelector('[aria-label="当前目标能力摘要"]').getBoundingClientRect().top`)
  await evaluate(`document.querySelector(${JSON.stringify(cardSelector(grand.id))}).scrollIntoView({ block: 'center' })`)
  await shown(`(() => { const r = document.querySelector(${JSON.stringify(cardSelector(grand.id))}).getBoundingClientRect(); return r.top >= 0 && r.bottom <= 900 })()`)
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 1024'), true)
  assert(Math.abs(await evaluate(`document.querySelector('[aria-label="当前目标能力摘要"]').getBoundingClientRect().top`) - summaryTop) < 1)
  await shot('R4-R6-reading-1024-fixed-summary')
  record('R4_R6_1024_located_grandchild_visible_summary_stays_fixed')


  // R7/R8: true paired local peer first online then stopped; long report uses existing kind.
  const projectId = 'qa-shared-project'
  const pair = async (from, to) => { const p = await api(to, '/pair/start', {}); const who = (await api(to, '/collab/lan/identity')).identity; await api(from, '/collab/lan/connect', { host: '127.0.0.1', port: to.port, member_id: who.member_id, code: p.pairing.code }); return who }
  const peerIdentity = await pair(primary, peer)
  const primaryIdentity = await pair(peer, primary)
  await api(primary, '/collab/lan/members?refresh=1')
  const original = await api(primary, '/collab/lan/channel/send', { project_id: projectId, text: '集中修复长报告阅读检查', recipients: [peerIdentity.member_id] })
  const long = '做完: 定向长报告阅读。\n' + '已核对保全原始回执与实际输入；这段只检查阅读、引用和回执，不声称新模型执行。\n'.repeat(30) + '长报告尾部标记'
  await api(peer, '/collab/lan/channel/send', { project_id: projectId, kind: 'report', reply_to: original.message.id, text: long, recipients: [primaryIdentity.member_id] })
  await click('频道')
  await shown(`!!document.querySelector('.ben-cl__lan-member[data-reachable="true"]')`)
  await press('展开报告')
  await shown(`document.querySelector('[aria-label="局域网项目频道"]').textContent.includes('长报告尾部标记')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="局域网项目频道"] a') !== null`), true)
  await shot('R8-long-report-expanded', '[aria-label="局域网消息"] > li:last-child')
  await press('收回报告')
  assert.equal(await evaluate(`document.querySelector('[aria-label="局域网项目频道"]').textContent.includes('长报告尾部标记')`), false)
  await closePeer()
  await press('查重并保存')
  await shown(`document.querySelector('.ben-cl__lan-note')?.textContent.includes('未知')`)
  assert.equal(await evaluate(`document.querySelector('.ben-cl__lan-member[data-reachable="true"]') === null`), true)
  writeFileSync(join(dir, 'R7-members-after-refresh.json'), JSON.stringify(await api(primary, '/collab/lan/members'), null, 2))
  writeFileSync(join(dir, 'R8-lan-channel.json'), JSON.stringify(await api(primary, `/collab/lan/channel?project_id=${projectId}`), null, 2))
  await shot('R7-offline-member', '.ben-cl__lan-members')
  record('R7_R8_actual_lan_refresh_offline_and_long_report_expand_collapse', { reportLength: long.length, physicalMachines: false })
  const originalIds = new Set(initial.tasks.tasks.map(one => one.id))
  const added = (await api(primary, '/state')).tasks.tasks.filter(one => !originalIds.has(one.id))
  assert(added.every(one => !primary.jobLog.events(one.id).some(event => event.step === 'started' || event.step === 'replied')))
  record('delta_has_no_new_native_execution', { checkedNewTasks: added.length, engineConnected: false })
  const errors = await evaluate('window.__errs')
  assert.deepEqual(errors, [])
  record('fixed_66_browser_errors', { errors, newModelExecutions: 0 })
}

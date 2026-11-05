/** Original F delta. Real controlled HTTP feed -> FeedService -> scoped publisher -> paired LAN -> production React.
 * The injected Sunday/Monday clock makes actual QA-created tasks eligible for complete-period reports.
 * No job log append, model, CLI, external/private source or production fixture is involved.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
export async function createFSourceFixture({ dir, createFeedService }) {
  let clock = Date.parse('2026-10-18T12:00:00+08:00'), base
  let requests = 0, originClosed = false
  const origin = createServer((req, res) => {
    requests++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/notice' ? { title: '本次受控公告源正在服务', requests, clock: new Date(clock).toISOString() } : { report: { date: '2026-10-19', sections: [{ label: '本次真实 HTTP 公告', items: [{ title: '受控项目公告可读取', summary: '本次隔离 HTTP 服务实际返回此公告，仅用于核验来源链路。'.repeat(14), publishedAt: '2026-10-19', source: { name: '受控公告发布者' }, links: { original: base + '/notice' } }] }] } }))
  })
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${origin.address().port}`
  const feed = createFeedService({ file: join(dir, 'feed.json'), configFile: join(dir, 'feed-config.json'), projects: async () => [], now: () => clock, aihotDaily: async () => (await fetch(base + '/daily')).json() })
  await feed.load(); await feed.setConfig({ podcast: false })
  return { feed, now: () => clock, monday: () => { clock = Date.parse('2026-10-19T10:00:00+08:00') }, base, requests: () => requests, close: async () => { if (originClosed) return; originClosed = true; await new Promise((resolve, reject) => origin.close(error => error ? reject(error) : resolve())) } }
}
export async function fSourceAcceptance({ dir, plugin, primary, peer, fixture, api, record, startChild, until, browser, evaluate, shown, closePeer, restartPeer }) {
  const projectId = 'aihot-daily'
  const channel = `/collab/lan/channel?project_id=${projectId}`
  const initial = []
  for (const server of [primary, peer]) {
    const goal = await api(server, '/collab/goal/create', { title: '原 F 受控真实来源', project_id: projectId })
    const task = await api(server, '/task/create', { title: '本次 API 实际登记的受控项目事项', project_id: projectId, goal_id: goal.id, status: 'todo', assignee: 'me', from: { kind: 'said', quote: '原 F 隔离验收：本次真实 API 登记的项目材料' }, acceptance: ['正式来源报告准确引用本事项且不声称模型执行'] })
    initial.push({ goal, task })
  }
  const peerId = (await api(peer, '/collab/lan/identity')).identity.member_id
  const primaryId = (await api(primary, '/collab/lan/identity')).identity.member_id
  const code = (await api(peer, '/pair/start', {})).pairing.code
  await api(primary, '/collab/lan/connect', { host: '127.0.0.1', port: 9994, member_id: peerId, code })
  const reverseCode = (await api(primary, '/pair/start', {})).pairing.code
  await api(peer, '/collab/lan/connect', { host: '127.0.0.1', port: 9993, member_id: primaryId, code: reverseCode })
  fixture.monday()
  const run = await fixture.feed.run()
  assert.equal(run.added, 1)
  assert(fixture.requests() > 0)
  await api(primary, '/collab/lan/channel/source-policy', { project_id: projectId, enabled: true, recipients: [peerId], categories: ['news', 'daily', 'weekly'], expected_version: 0 })
  const published = await api(primary, '/collab/lan/channel/publish', { project_id: projectId })
  assert.equal(published.ok, true)
  const received = await api(peer, channel)
  assert.deepEqual(received.messages.map(one => one.category).sort(), ['daily', 'news', 'weekly'])
  const news = received.messages.find(one => one.category === 'news')
  const daily = received.messages.find(one => one.category === 'daily')
  const filters = []
  for (const query of ['category=news', `topic_id=${encodeURIComponent(news.topic.id)}`, `source_id=${encodeURIComponent(news.source.id)}`]) {
    const filtered = await api(peer, channel + '&' + query)
    assert.deepEqual(filtered.messages.map(one => one.id), [news.id]); filters.push({ query, messageIds: filtered.messages.map(one => one.id) })
  }
  assert.equal(received.source_scope.news, 'unwired')
  assert.equal(news.author.member_id, primaryId)
  assert(daily.refs.some(ref => ref.id === initial[0].task.id))
  assert(published.messages.every(one => one.deliveries[0].status === 'delivered'))
  assert.match(daily.text, /实际开工\/完成未知/)
  const notice = await fetch(news.source.url).then(response => response.json())
  const legacy = await api(primary, '/collab/lan/channel/send', { project_id: projectId, text: '日报 这些字仍只是旧未分类消息', recipients: [peerId], client_msg_id: 'f-old-message' })
  const reply = await api(peer, '/collab/lan/channel/send', { project_id: projectId, text: '做完:本次 HTTP 公告已读回，引用原公告保留核对记录', kind: 'report', reply_to: news.id, recipients: [primaryId], client_msg_id: 'f-old-report' })
  assert.equal(reply.message.deliveries[0].status, 'delivered')
  record('real_feed_report_lan_source_published', { published, received, notice, clock: 'injected Sunday actual API create -> Monday source publish; not user history', tasks: initial.map(one => one.task.id), newModelTasks: 0, physicalMachines: false })
  writeFileSync(join(dir, 'F-source-ingress-and-receipts.json'), JSON.stringify({ sourceFeed: fixture.feed.view(), published, received, notice, initial, legacy, reply, filters }, null, 2))
  const require = createRequire(import.meta.url)
  const vite = join(dirname(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json')), 'bin/vite.js')
  startChild(process.execPath, [vite, '--config', 'dev/collab-board/vite.config.mjs', '--port', '9991', '--strictPort'], { cwd: plugin })
  await until(() => fetch('http://127.0.0.1:9991/desktop-test.html').then(r => r.ok).catch(() => false), Boolean, 'Vite')
  const client = await browser()
  const url = `http://127.0.0.1:9991/desktop-test.html?live=1&view=channel&api=${encodeURIComponent(peer.url)}`
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await client.send('Page.navigate', { url })
  const lan = `document.querySelector('[aria-label="局域网项目频道"]')`
  const press = async name => {
    await shown(`Array.from(${lan}.querySelectorAll('button')).some(b => b.textContent.trim() === ${JSON.stringify(name)})`)
    await evaluate(`Array.from(${lan}.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(name)}).click()`)
  }
  const select = async (label, value) => evaluate(`(() => { const el = ${lan}.querySelector('[aria-label="${label}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  const shot = async name => { const result = await client.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(dir, name + '.png'), Buffer.from(result.data, 'base64')) }
  await shown(`${lan}?.textContent.includes('受控公告发布者') && ${lan}.textContent.includes('本机资讯来源未接入')`)
  assert.equal(await evaluate(`${lan}.querySelector('textarea, input:not([type=hidden])') !== null`), false)
  await select('局域网消息分类', 'daily')
  await press('展开报告')
  await shown(`${lan}.textContent.includes('实际开工/完成未知') && ${lan}.textContent.includes('发送成员原件，只读引用')`)
  assert.equal(await evaluate(`${lan}.querySelector('.ben-cl__msg-ref a') !== null`), false)
  await evaluate(`${lan}.querySelector('.ben-cl__msg').scrollIntoView({ block: 'start' }); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await shot('F-daily-expanded-1440')
  await press('收回报告')
  await select('局域网消息分类', 'weekly')
  await press('展开报告')
  await shown(`${lan}.textContent.includes('报告时期：') && ${lan}.textContent.includes('周报')`)
  await select('局域网消息分类', 'news')
  await shown(`${lan}.textContent.includes('发表时间：未知') && ${lan}.textContent.includes('配对来源声明')`)
  assert.equal(await evaluate(`${lan}.querySelector('a[target="_blank"]').href`), news.source.url)
  await select('局域网消息话题', news.topic.id)
  await shot('F-news-1440')
  await select('局域网消息分类', 'unknown')
  await shown(`${lan}.textContent.includes('日报 这些字仍只是旧未分类消息') && !${lan}.textContent.includes('受控公告发布者')`)
  await select('局域网消息分类', 'all')
  // Full-screen/component use the same production component; no new route or fake data.
  await client.send('Page.navigate', { url: url + '&full=1' })
  await shown(`${lan}?.textContent.includes('受控公告发布者') && document.body.textContent.includes('退出全屏')`)
  await shot('F-channel-full-1440')
  await client.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`${lan}.scrollIntoView({block:'start'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const geometry = await evaluate(`Array.from(${lan}.querySelectorAll('.ben-cl__msg, .ben-cl__message-source, .ben-cl__source-scope')).map(el => ({ width: el.clientWidth, scroll: el.scrollWidth }))`)
  assert(geometry.length && geometry.every(one => one.scroll <= one.width + 1), JSON.stringify(geometry))
  await shot('F-channel-520')
  record('production_react_F_readonly_filters_reports_refs_narrow', { geometry, senderId: primaryId, receiverId: peerId, note: 'real production source fields, no fetch fixture' })
  // A real server outage preserves the rendered snapshot. Reopen the same persisted isolated server.
  const before = await api(peer, channel)
  await closePeer()
  await shown(`${lan}.textContent.includes('局域网频道此刻读不到') && ${lan}.textContent.includes('上次已知本机来源范围')`)
  assert(await evaluate(`${lan}.textContent.includes('受控公告发布者')`))
  await shot('F-channel-real-offline')
  peer = await restartPeer()
  await shown(`!${lan}.textContent.includes('局域网频道此刻读不到') && ${lan}.textContent.includes('受控公告发布者')`)
  const after = await api(peer, channel)
  assert.deepEqual(after.messages, before.messages)
  await api(primary, '/collab/lan/members?refresh=1')
  const identity = (await api(primary, '/collab/lan/identity')).identity
  await api(primary, '/collab/lan/identity', { name: '改名后的受控发布事务官', expected_version: identity.version })
  const afterRename = await api(peer, channel)
  assert.deepEqual(afterRename.messages, before.messages)
  assert.equal((await api(primary, '/collab/lan/identity')).identity.member_id, primaryId)
  record('production_real_outage_restart_snapshot_and_rename_stable', { messageIds: after.messages.map(one => one.id), sourceSnapshotsUnchanged: true })
  await api(primary, '/feed/config', { enabled: false })
  await client.send('Page.navigate', { url: url.replace(encodeURIComponent(peer.url), encodeURIComponent(primary.url)) + '&full=1' })
  await shown(`${lan}?.textContent.includes('本机资讯来源已知为空') && ${lan}.textContent.includes('受控公告发布者')`)
  await shot('F-source-disabled-history-kept')
  await api(primary, '/feed/config', { enabled: true })
  await fixture.close()
  await api(primary, '/feed/run', {})
  await shown(`${lan}.textContent.includes('本机资讯来源状态未知') && ${lan}.textContent.includes('受控公告发布者')`)
  const failedSource = await api(primary, channel)
  assert.equal(failedSource.source_scope.news, 'unknown')
  assert(failedSource.messages.some(one => one.id === news.id))
  writeFileSync(join(dir, 'F-source-closed-history-readback.json'), JSON.stringify(failedSource, null, 2))
  await shot('F-source-real-unavailable-history-kept')
  record('production_real_source_disabled_then_origin_closed_history_kept', { sourceScope: failedSource.source_scope, originalMessageId: news.id })
  assert.deepEqual(await evaluate('window.__errs'), [])
}

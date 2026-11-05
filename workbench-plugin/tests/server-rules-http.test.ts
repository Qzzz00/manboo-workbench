// @vitest-environment node
/**
 * 规矩表接进来以后的那几条路(2026-09-24 晚,卡 K;docs/设计-全局自进化-2026-09-24.md 二.2)。
 *
 * 钉这几件(全在临时目录,**一行都不碰 ~/.dsh**):
 * 1. 没接规矩表:`/butler/rules*` 一律 404,老路一字不变;
 * 2. 设置里加一条 → 当场生效、AGENTS.md 的「规矩」段写上;改、删、恢复都同步;
 * 3. 电话里 `wb_remember_preference` → 进规矩表(不再只写「通话偏好」段);称呼那一支照旧;
 * 4. 他打字「以后界面都不要蓝」→ 规矩当场记下,事项照建;新开的那条会话之前 AGENTS.md 已经写好;
 * 5. 派活:`/dispatch/client` 送进窗口的话末尾带「这件活要守的规矩」,做界面的带「不要蓝」;回包带规矩 id;
 * 6. 交回来:`/butler/item/dispatch` 报 done + 带蓝的文件 → review.pass=false、打回原话点名那家;
 *    会话答完这件活**不进「等我确认」**(heldBack);重新派了 → 清掉;不带蓝 → 过;
 * 7. `/butler/rules/brief`:派活那一段按事项原文挑块;
 * 8. 电话人设:规矩段进系统提示(说话那几条全文、其余短名里有「不要蓝」);
 * 9. 需求卡「打回」两件不同的活都说同一处 → 一条试用规矩。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperChannel, HelperRequest } from '../src/server/helperChannel.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createRulesService, type RulesService } from '../src/server/rules.ts'
import { buildChannelSystemMessage, createChannelService } from '../src/server/channel.ts'
import { createButlerLifecycle } from '../src/server/butlerLifecycle.ts'
import { OBSERVATIONS } from './fixtures/rulesObservations.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-24T13:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function fakeHelper() {
  const requests: HelperRequest[] = []
  const helper = {
    attach() {},
    view: () => ({ connected: true, authorized: true }),
    connected: () => true,
    request: (req: HelperRequest) => { requests.push(req); return Promise.resolve({ ok: true, result: { method: 'ax_value' } }) },
    onChange() {},
    onEvent() {},
  } as unknown as HelperChannel
  return { helper, requests }
}

/** 一张真规矩表(落在临时目录);AGENTS.md 那一段写进内存里,看得见写了什么。 */
function rulesService(dir: string, memory?: string): { rules: RulesService, agents: { body: string | undefined } } {
  const agents: { body: string | undefined } = { body: undefined }
  const rules = createRulesService({
    file: join(dir, 'rules.json'),
    agents: {
      apply: async (body) => { agents.body = body; return { ok: true } },
      revert: async () => { agents.body = undefined; return { ok: true } },
    },
    ...(memory === undefined ? {} : { observations: async () => memory }),
  })
  return { rules, agents }
}

async function serve(options: { withRules?: boolean, memory?: string, helper?: HelperChannel } = {}) {
  const dir = tempDir('wb-rules-http-')
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const sent: string[] = []
  const { rules, agents } = rulesService(dir, options.memory)
  if (options.withRules !== false) await rules.load()
  // 2026-10-29 入口归一:/butler/item 进理解中枢 —— 假模型按各句的原语义回命令。
  const model = fakeHubModel({
    '以后界面都不要蓝': [{ name: 'remember', text: '以后界面都不要蓝', scope: 'global' }, { name: 'note', title: '以后界面都不要蓝', status: 'todo' }],
    '帮我看看首页为什么是蓝的': [{ name: 'note', title: '看看首页为什么是蓝的', status: 'todo' }],
  })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    model: model.service as never,
    fetchImpl: model.fetchImpl,
    runCommand: () => Promise.resolve({ ok: true, stdout: '"pid"=123' }),
    butlerSession: {
      open: async (firstMessage: string) => { sent.push(firstMessage); return `s-${sent.length}` },
    },
    /*
     * ★ 2026-10-02(卡「引擎接线与删复制品」):`/dispatch/client` 后面是**一条引擎**
     * (窗口那条通道骑在这一份假壳上),所以给了壳就顺手接一条引擎;没给壳照旧没有送话那条能力。
     */
    ...(options.helper === undefined
      ? {}
      : (() => {
          const engine = engineHarness({ helper: options.helper as never })
          return { helper: options.helper, engine: engine.engine, engineRegistry: engine.registry }
        })()),
    ...(options.withRules === false ? {} : { rules }),
  })
  started.push(server)
  return { url: server.url, tasks, sent, rules, agents, dir }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}
async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, any> }
}

describe('没接规矩表', () => {
  it('/butler/rules* 一律 404', async () => {
    const { url } = await serve({ withRules: false })
    expect((await get(url, '/butler/rules')).status).toBe(404)
    expect((await post(url, '/butler/rules', { text: '不要蓝' })).status).toBe(404)
    expect((await post(url, '/butler/rules/check', { text: 'x' })).status).toBe(404)
  })
})

describe('一张表:加、改、删、恢复,每次都同步 AGENTS.md', () => {
  it('「观察」不再一次性导成规矩(2026-10-09 卡「学风格」:改走风格候选,在习惯服务里);没接习惯 → 404,表里一条没加', async () => {
    const { url, agents } = await serve({ memory: OBSERVATIONS })
    const imported = await post(url, '/butler/rules/import', { from: 'observations' })
    expect(imported.status).toBe(404)
    const view = await get(url, '/butler/rules')
    expect(view.body.rules).toHaveLength(0)
    expect(agents.body).toBeUndefined()
  })

  it('设置里加一条 → 当场生效;改字;删了留底;恢复', async () => {
    const { url, agents } = await serve()
    const added = await post(url, '/butler/rules', { text: '以后派活先截图给我看', channel: 'settings' })
    expect(added.status).toBe(200)
    expect(added.body.rule.status).toBe('active')
    expect(agents.body).toContain('以后派活先截图给我看')
    const id = added.body.rule.id as string
    expect((await post(url, '/butler/rules/update', { id, text: '派活之前先截图给我看' })).body.rule.text).toBe('派活之前先截图给我看')
    expect(agents.body).toContain('派活之前先截图给我看')
    await post(url, '/butler/rules/remove', { id })
    const view = await get(url, '/butler/rules')
    expect(view.body.rules).toHaveLength(0)
    expect(view.body.retired).toHaveLength(1)
    expect(agents.body).toBeUndefined()
    await post(url, '/butler/rules/restore', { id })
    expect((await get(url, '/butler/rules')).body.rules).toHaveLength(1)
  })

  it('空的、太长的、系统写的字 → 400,表不动', async () => {
    const { url } = await serve()
    expect((await post(url, '/butler/rules', { text: '  ' })).status).toBe(400)
    expect((await post(url, '/butler/rules', { text: '长'.repeat(300) })).status).toBe(400)
    expect((await post(url, '/butler/rules', { text: '时长:4 秒。' })).status).toBe(400)
    expect((await get(url, '/butler/rules')).body.rules).toHaveLength(0)
  })
})

describe('所有渠道进同一张表', () => {
  it('★电话里 wb_remember_preference → 进规矩表(不写「通话偏好」段);称呼那一支不走这里', async () => {
    const { url, rules } = await serve()
    const res = await post(url, '/butler/memory/preference', { text: '以后别念文件路径' })
    expect(res.status).toBe(200)
    expect(res.body.block).toBe('规矩')
    expect(rules.view().rules[0]).toMatchObject({ text: '以后别念文件路径', area: 'say' })
    expect(rules.view().rules[0]?.evidence[0]?.channel).toBe('call')
  })

  it('★打字「以后界面都不要蓝」→ 中枢 remember 进同一张规矩表、事项照建;AGENTS.md 同步带上它', async () => {
    const { url, tasks, rules, agents, sent } = await serve()
    const res = await post(url, '/butler/item', { text: '以后界面都不要蓝' })
    expect(res.status).toBe(200)
    expect((await tasks.list()).tasks).toHaveLength(1)
    expect(rules.view().rules.map(one => one.text)).toEqual(['以后界面都不要蓝'])
    expect(agents.body).toContain('以后界面都不要蓝')
    // 入口归一:会话不再随建卡自开(旧路「记规矩那句照旧往下走、顺便开会话」随 /butler/item 旧路删除)。
    expect(sent).toHaveLength(0)
  })

  it('一句普通的活不记规矩', async () => {
    const { url, rules } = await serve()
    await post(url, '/butler/item', { text: '帮我看看首页为什么是蓝的' })
    expect(rules.view().rules).toHaveLength(0)
  })
})

describe('派活:指令末尾带「这件活要守的规矩」', () => {
  it('★做界面的活:送进 Codex 窗口的话里有「不要蓝」;回包带规矩 id;记一条「派出去了」', async () => {
    const { helper, requests } = fakeHelper()
    const { url, tasks, rules } = await serve({ helper, memory: OBSERVATIONS })
    await rules.importObservations(OBSERVATIONS)
    const task = { id: (await tasks.create({ title: '[派活测试] 做一个登录按钮的小网页', direction: 'mine' })).id as string }
    const res = await post(url, '/dispatch/client', { app: 'codex', text: '做一个登录按钮的小网页,放在 /tmp/x 里', item_id: task.id, source: 'item' })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.rules)).toBe(true)
    const typed = JSON.stringify(requests)
    expect(typed).toContain('【他的规矩:这件活要守的')
    expect(typed).toContain('不要蓝(球的「完成」色也不要)')
    expect(typed).not.toContain('电话每轮不超过两句')
    expect(rules.view().rules.length).toBeGreaterThan(0)
  })

  it('/butler/rules/brief:按事项原文挑块(命令行那只手她自己贴这一段)', async () => {
    const { url, tasks, rules } = await serve({ memory: OBSERVATIONS })
    await rules.importObservations(OBSERVATIONS)
    const ui = { id: (await tasks.create({ title: '把设置页的按钮改好看', direction: 'mine' })).id as string }
    const plain = { id: (await tasks.create({ title: '把 README 的错别字改一下', direction: 'mine' })).id as string }
    expect((await get(url, `/butler/rules/brief?for=dispatch&item=${ui.id}`)).body.text).toContain('不要蓝')
    expect((await get(url, `/butler/rules/brief?for=dispatch&item=${plain.id}`)).body.text).not.toContain('不要蓝')
    expect((await get(url, '/butler/rules/brief?for=nope')).status).toBe(400)
  })
})

describe('交回来:先按规矩自查,不合格先打回,合格才叫他', () => {
  function workdir(html: string): string {
    const dir = tempDir('wb-rules-result-')
    mkdirSync(join(dir, 'site'), { recursive: true })
    writeFileSync(join(dir, 'site', 'index.html'), html)
    return dir
  }

  it('★带蓝的结果:review.pass=false,打回原话点名 Codex;会话答完也不进「等我确认」;重新派了清掉', async () => {
    const { url, tasks, rules } = await serve({ memory: OBSERVATIONS })
    await rules.importObservations(OBSERVATIONS)
    const task = { id: (await tasks.create({ title: '[派活测试] 做一个登录按钮的小网页', direction: 'mine', conversation: { agent: 'dsh', session_id: 's-9' }, acceptance: ['按钮能点'] })).id as string }
    await tasks.move(task.id, 'doing')
    const cwd = workdir('<style>\nbutton { background: #1677ff; color: #fff }\n</style>')
    await post(url, '/butler/item/dispatch', { id: task.id, family: 'codex', status: 'running', cwd, hand: 'cli' })
    const done = await post(url, '/butler/item/dispatch', {
      id: task.id, family: 'codex', status: 'done', cwd, hand: 'cli', note: '做完了', result: '按钮做好了', files: ['site/index.html'],
    })
    expect(done.status).toBe(200)
    expect(done.body.review.pass).toBe(false)
    expect(done.body.review.violations[0].why).toContain('site/index.html 第 2 行 #1677ff 是蓝色')
    expect(done.body.review.reject_text).toContain('Codex,这一版按他的规矩不能交')
    expect(done.body.rules_note).toContain('这时别叫他')

    // 会话答完:不进「等我确认」,卡上换成那一句。
    const lifecycle = createButlerLifecycle({ tasks, heldBack: id => rules.heldBack(id) })
    await lifecycle.handleSessionEnd('s-9', { kind: 'done', ts: NOW_SEC + 100 } as never)
    const after = (await tasks.list()).tasks.find(one => one.id === task.id)
    expect(after?.status).toBe('doing')
    expect(after?.note).toContain('按他的规矩自查没过')

    // 重新派了 → 清掉;改好了(不带蓝)→ 过,会话答完照常进「等我确认」。
    await post(url, '/butler/item/dispatch', { id: task.id, family: 'codex', status: 'running', cwd, hand: 'cli' })
    expect(rules.heldBack(task.id)).toBeUndefined()
    writeFileSync(join(cwd, 'site', 'index.html'), '<style>\nbutton { background: #f2f2f2; color: #111 }\n</style>')
    const fixed = await post(url, '/butler/item/dispatch', { id: task.id, family: 'codex', status: 'done', cwd, hand: 'cli', files: ['site/index.html'] })
    expect(fixed.body.review.pass).toBe(true)
    expect(fixed.body.rules_note).toContain('可以叫他验收')
    await lifecycle.handleSessionEnd('s-9', { kind: 'done', ts: NOW_SEC + 200 } as never)
    expect((await tasks.list()).tasks.find(one => one.id === task.id)?.status).toBe('confirm')
  })

  it('/butler/rules/check:cwd 外的路径一律跳过,不读', async () => {
    const { url, rules } = await serve({ memory: OBSERVATIONS })
    await rules.importObservations(OBSERVATIONS)
    const cwd = workdir('<style>a { color: #fff }</style>')
    const res = await post(url, '/butler/rules/check', { cwd, files: ['../etc/passwd', '/etc/hosts', 'site/index.html'], text: '做好了' })
    expect(res.body.pass).toBe(true)
    expect(res.body.skipped).toEqual(['../etc/passwd', '/etc/hosts'])
  })
})

describe('他的把关也是反馈', () => {
  it('需求卡「打回」两件不同的活都说同一处 → 一条试用规矩', async () => {
    const { url, rules } = await serve()
    await post(url, '/butler/rules/feedback', { kind: 'revise', where: 't-1', text: '按钮颜色太跳了,换成灰色', channel: 'review' })
    const second = await post(url, '/butler/rules/feedback', { kind: 'revise', where: 't-2', text: '按钮颜色太跳,换灰色', channel: 'review' })
    expect(second.body.adopted).toBe(1)
    expect(rules.view().rules[0]?.status).toBe('trial')
    expect((await post(url, '/butler/rules/feedback', { kind: 'nope', where: 't-1' })).status).toBe(400)
  })
})

describe('他点「完成」= 通过:试用的规矩靠它验', () => {
  it('★两件活打回同一处 → 试用;第三件派出去、他在「等我确认」点完成 → 留下', async () => {
    const { url, tasks, rules } = await serve()
    await post(url, '/butler/rules/feedback', { kind: 'revise', where: 't-a', text: '按钮颜色太跳了,换成灰色', area: 'ui' })
    await post(url, '/butler/rules/feedback', { kind: 'revise', where: 't-b', text: '按钮颜色太跳,换灰色', area: 'ui' })
    expect(rules.view().rules[0]?.status).toBe('trial')
    const id = (await tasks.create({ title: '[派活测试] 把设置页的按钮改好看', direction: 'mine', acceptance: ['按钮是灰色'] })).id as string
    await tasks.move(id, 'doing')
    const cwd = tempDir('wb-rules-pass-')
    await post(url, '/butler/item/dispatch', { id, family: 'codex', status: 'running', cwd, hand: 'cli' })
    await tasks.move(id, 'confirm')
    const moved = await post(url, '/task/move', { id, status: 'done' })
    expect(moved.status).toBe(200)
    expect(rules.view().rules[0]?.status).toBe('kept')
  })
})

describe('电话人设', () => {
  it('★规矩段进系统提示:说话那几条全文,其余短名里有「不要蓝」', async () => {
    const dir = tempDir('wb-rules-persona-')
    const { rules } = rulesService(dir, OBSERVATIONS)
    await rules.load()
    await rules.importFromMemory()
    const message = buildChannelSystemMessage({
      rememberTool: 'wb_remember_item', doingTool: 'wb_list_doing', handTool: 'wb_hand_to_butler',
      ...(rules.brief('say').text === undefined ? {} : { rulesBlock: rules.brief('say').text as string }),
    })
    expect(message).toContain('【他立的规矩')
    expect(message).toContain('电话每轮不超过两句')
    expect(message).toMatch(/还要照做的:.*不要蓝/u)
    // 规矩段排在「说话的规矩」之前(对语气与做法的修订,写在前面才管得住后面)。
    expect(message.indexOf('【他立的规矩')).toBeLessThan(message.indexOf('【说话的规矩】'))
  })

  it('★GET /channel/persona 那一份:规矩段 + max_sentences=2(工人据此在流上掐);删了那条就没有上限', async () => {
    const dir = tempDir('wb-rules-persona2-')
    const { rules } = rulesService(dir, OBSERVATIONS)
    await rules.load()
    await rules.importFromMemory()
    const channel = createChannelService({
      agentsFile: join(dir, 'AGENTS.md'),
      readFileImpl: async () => '我叫 拓麻鸽子。\n',
      env: {},
      configFile: join(dir, 'channel.json'),
      rememberTool: 'wb_remember_item',
      doingTool: 'wb_list_doing',
      rulesBlock: () => rules.brief('say').text,
      sayLimit: () => rules.sayLimit(),
    })
    const persona = await channel.persona()
    expect(persona.system_message).toContain('电话每轮不超过两句')
    expect(persona.system_message).toMatch(/还要照做的:.*不要蓝/u)
    expect(persona.max_sentences).toBe(2)
    const limitRule = rules.view().rules.find(one => one.text.startsWith('电话每轮不超过两句'))
    await rules.remove(limitRule?.id as string)
    expect((await channel.persona()).max_sentences).toBeUndefined()
  })
})

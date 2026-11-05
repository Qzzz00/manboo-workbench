// @vitest-environment node
/**
 * **派给读不到窗口的那一家 —— 当场说,别自己折腾**(2026-10-01,Air 诊断包 17:53,插件 0.4.78)。
 *
 * 维护者原话:「事务官能够指派豆包工作,但无法指派 kimi」。查实的现场:
 *
 * - 新版 Kimi `com.moonshot.kimichat.kmp.mac` 整个界面是自绘画布,辅助功能树只有一扇窗一张图
 *   (输入框 / 发送键 / 文字都是 0)→ 登记表把它摆在 `unreadable` 那一格,**不进 `entries`**;
 *   于是本机探测的候选(它从 `entries` 长)也没有它 —— `dispatchTargets` 里一条都没有。
 * - 她说「让 Kimi 查一下国庆放假多少天」之后,**事务官自己**「在跑命令」约 8 分钟、撞 15 步上限,
 *   电话工人连发三次「到上限了」,那件事一直停在 todo。而维护者 09-28 已经拍板:事务官自己不干活。
 *
 * 这一组用例钉的是:**在工作台这一侧当场判、当场回一句人话**(不经模型),三个入口同一句;
 * 而**能派的那一家照常派** —— Air 上 App Store 版豆包(`com.bot.neotix.doubao`)也读不到,
 * 可它与豆包办公(`com.work.pc.doubao`)同属 `doubao` 一家,拦了她就再也派不了豆包。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentDiscovery } from '../src/server/agentDiscovery.ts'
import type { RegistryFile } from '../src/server/agentRegistry.ts'
import type { SendToClientInput } from '../src/server/dispatchSend.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { dispatchUnreadableSay } from '../src/protocol.ts'
import { createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore, emptyRegistry, registryView } from '../src/server/agentRegistry.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import { dispatchReadiness, dispatchTargets, unreadableBlockOf } from '../src/server/dispatchTargets.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const NOW = new Date('2026-10-01T09:53:00.000Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 判成 AI 应用、结构那一道真判过而且没过的一条(读不到它的窗口)。 */
function unreadableApp(data: RegistryFile, bundleId: string, name: string, why: string): void {
  data.apps[bundleId] = {
    bundle_id: bundleId,
    name,
    state: 'candidate',
    verdict: { kind: 'ai_agent', reason: `${name} 的桌面客户端`, by: 'model', stage: 'identity', at: '2026-10-01T09:00:00.000Z' },
    structure: { pass: false, surface: false, input: false, send: false, new_chat: false, why, at: '2026-10-01T09:10:00.000Z' },
  }
}

/** 接上了的一条(读到过它的窗口)。 */
function connectedApp(data: RegistryFile, bundleId: string, name: string, at: string): void {
  data.apps[bundleId] = {
    bundle_id: bundleId,
    name,
    state: 'connected',
    found: { how: 'patrol', at, basis: '窗口里有对话区' },
  }
}

/**
 * **Air 那一台**:豆包办公与 Codex 读得到(接上了);新版 Kimi、可灵、App Store 版豆包读不到。
 * 三种夹具都是诊断包里那几条真包标识,不编。
 */
function airRegistry(): RegistryFile {
  const data = emptyRegistry()
  connectedApp(data, 'com.work.pc.doubao', '豆包工作', '2026-10-01T08:00:00.000Z')
  connectedApp(data, 'com.openai.codex', 'ChatGPT', '2026-10-01T08:01:00.000Z')
  unreadableApp(data, 'com.moonshot.kimichat.kmp.mac', 'Kimi', '不像对话窗口:没有输入框;没有对话区也没有会话列表')
  unreadableApp(data, 'com.electron.klingai', '可灵', '不像对话窗口:没有输入框')
  unreadableApp(data, 'com.bot.neotix.doubao', '豆包', '不像对话窗口:没有输入框')
  return data
}

function airView(data = airRegistry()) {
  return registryView({ data, sessions: [], bubbles: new Map(), running: () => true, now: NOW })
}

function airTargetsAndUnreadable() {
  const registry = airView()
  const targets = dispatchTargets({ registry })
  const unreadable = (registry.unreadable ?? []).map(one => ({ id: one.id, name: one.name, bundle_id: one.bundle_id }))
  return { targets, unreadable }
}

describe('一处判断:读不到窗口的那一家,派活候选里当场拦下', () => {
  it('三种夹具都进登记表的 unreadable 那一格(新版 Kimi / 可灵 / App Store 版豆包)', () => {
    const view = airView()
    expect((view.unreadable ?? []).map(one => one.bundle_id).sort()).toEqual([
      'com.bot.neotix.doubao', 'com.electron.klingai', 'com.moonshot.kimichat.kmp.mac',
    ])
    // 名字走已有的显示名映射:认得出的用那一路的名字,认不出的用它自己报的那个。
    expect((view.unreadable ?? []).find(one => one.bundle_id === 'com.moonshot.kimichat.kmp.mac')?.name).toBe('Kimi')
    expect((view.unreadable ?? []).find(one => one.bundle_id === 'com.electron.klingai')?.name).toBe('可灵')
  })

  it('★「让 Kimi 办」→ 当场一句人话:读不到它的窗口、派不了、换能派的那几家', () => {
    const { targets, unreadable } = airTargetsAndUnreadable()
    const ready = dispatchReadiness({ family: 'kimi', targets, unreadable })
    expect(ready.ok).toBe(false)
    expect(ready).toMatchObject({ unreadable: true })
    // 名字与能派的那几家都是现取的 —— 断言也用同一个函数,不逐字抄中文。
    expect(ready.ok === false && ready.why).toBe(dispatchUnreadableSay({ name: 'Kimi', others: ['豆包办公', 'Codex'] }))
  })

  it('★能派的那一家照常派:App Store 版豆包读不到,豆包办公还接着 → doubao 这一家不拦', () => {
    const { targets, unreadable } = airTargetsAndUnreadable()
    const ready = dispatchReadiness({ family: 'doubao', targets, unreadable })
    expect(ready.ok).toBe(true)
    expect(unreadableBlockOf({ family: 'doubao', targets, unreadable })).toBeUndefined()
  })

  it('登记表认不出的那一家(可灵:id 就是包标识)也拦得下', () => {
    const { targets, unreadable } = airTargetsAndUnreadable()
    const ready = dispatchReadiness({ family: 'com.electron.klingai', targets, unreadable })
    expect(ready.ok === false && ready.why).toBe(dispatchUnreadableSay({ name: '可灵', others: ['豆包办公', 'Codex'] }))
  })

  it('一家能派的都没有时,那句话不摆空名单', () => {
    const data = emptyRegistry()
    unreadableApp(data, 'com.moonshot.kimichat.kmp.mac', 'Kimi', '不像对话窗口:没有输入框')
    const registry = registryView({ data, sessions: [], bubbles: new Map(), running: () => true, now: NOW })
    const unreadable = (registry.unreadable ?? []).map(one => ({ id: one.id, name: one.name, bundle_id: one.bundle_id }))
    const ready = dispatchReadiness({ family: 'kimi', targets: dispatchTargets({ registry }), unreadable })
    expect(ready.ok === false && ready.why).toBe(dispatchUnreadableSay({ name: 'Kimi', others: [] }))
  })

  it('不知道有谁读不到(老宿主 / 没接发现引擎)→ 一字不变,还是老那句「还没接上」', () => {
    const { targets } = airTargetsAndUnreadable()
    const ready = dispatchReadiness({ family: 'kimi', targets })
    expect(ready.ok).toBe(false)
    expect(ready.ok === false && ready.unreadable).toBeUndefined()
    expect(ready.ok === false && ready.why).toContain('还没接上')
  })
})

describe('派活那一层:工具立刻回,不折腾', () => {
  function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'wb-unreadable-'))
    dirs.push(dir)
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-00000${++n}` })
    const { targets, unreadable } = airTargetsAndUnreadable()
    const sent: SendToClientInput[] = []
    const runner = createDispatchRunner({
      tasks,
      targets: () => targets,
      unreadable: () => unreadable,
      clientDispatch: {
        async send(input) { sent.push(input); return { ok: true, dispatch: { hand: 'window', family: 'kimi', status: 'sent', at: NOW.toISOString(), text: input.text }, baseline: [] } },
      },
      readFile: async () => undefined,
      sessions: () => [],
      now: () => NOW,
      setTimer: () => 'timer',
      clearTimer: () => {},
      notSeenMs: 60_000,
      replyTimeoutMs: 600_000,
    })
    return { tasks, runner, sent }
  }

  it('★「让 Kimi 查一下国庆放假多少天」:卡上那句就是那一句人话,一只手都没试', async () => {
    const r = rig()
    const created = await r.tasks.create({ title: '国庆放假多少天', direction: 'mine', status: 'todo' })
    const out = await r.runner.start(created.id as string, { family: 'kimi', said: '查一下国庆放假多少天' })
    expect(out.ok).toBe(false)
    // 回包那句与卡上那句是同一句,而且**原样**就是人话 —— 不再套「没派给 X:…」那层壳。
    expect(out.note).toBe(dispatchUnreadableSay({ name: 'Kimi', others: ['豆包办公', 'Codex'] }))
    expect(r.sent).toHaveLength(0)
    const task = (await r.tasks.list()).tasks.find(one => one.id === created.id)
    // 不进「在办」:挂「等你处理」(琥珀,不染红)—— 她要做的是换一家,不是看一条报错。
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('input')
    expect(task?.note).toBe(dispatchUnreadableSay({ name: 'Kimi', others: ['豆包办公', 'Codex'] }))
  })

  it('能派的那一家照常派出去(豆包办公)', async () => {
    const r = rig()
    const created = await r.tasks.create({ title: '润色一段文案', direction: 'mine', status: 'todo' })
    const out = await r.runner.start(created.id as string, { family: 'doubao', said: '润色一段文案' })
    expect(out.ok).toBe(true)
    expect(r.sent).toHaveLength(1)
  })
})

describe('捎话送话那一层:读不到就不去翻窗', () => {
  /*
   * ★ 2026-10-02(卡「引擎接线与删复制品」):送话后面换成引擎了,所以这一条改成
   * **假壳 + 真引擎**(`engineHarness`)。守的还是同一件事:这一家读不到窗口 → 当场回那一句人话,
   * 而且**一个 op 都不发给壳** —— 这一道判在 `dispatchSend` 入口,引擎连 `run` 都没被叫到。
   */
  it('★同一句话,壳一次都没被叫到', async () => {
    const { targets, unreadable } = airTargetsAndUnreadable()
    const h = engineHarness({ now: () => NOW })
    const dispatch = createClientDispatch({
      engine: h.engine,
      sessionIdsOf: () => [],
      targets: () => targets,
      unreadable: () => unreadable,
      now: () => NOW,
    })
    const out = await dispatch.send({ family: 'kimi', text: '国庆放假多少天?', submit: true })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toBe(dispatchUnreadableSay({ name: 'Kimi', others: ['豆包办公', 'Codex'] }))
    expect(h.requests).toHaveLength(0)
  })
})

describe('三个入口(电话 / 手机 / 电脑收件箱)都回同一句', () => {
  /** 三个入口建卡 + 派活走的是同一个口 `POST /butler/item`,只差 `source`。 */
  async function serve() {
    const dir = mkdtempSync(join(tmpdir(), 'wb-unreadable-http-'))
    dirs.push(dir)
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
    const discovery = createAgentDiscovery({
      store: createMemoryRegistryStore(airRegistry()),
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => NOW,
    })
    await discovery.start()
    /*
     * ★ 2026-10-29 入口归一:假模型按中枢命令表回一条点名 dispatch(to:kimi)。
     * 引擎 harness 让 kimi 进候选(窗口读不到)—— 中枢核手不过,照实说为什么没派。
     */
    const request = async (req: { op: string }): Promise<Record<string, unknown>> =>
      req.op === 'send_text' ? { method: 'ax_value', submitted: true, new_conversation: 'x' } : { found: false, busy: false }
    const { engineHarness } = await import('./helpers/engineHarness.ts')
    const h = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { messages?: { content?: string }[] }
      const said = String(body.messages?.at(-1)?.content ?? '')
      const quote = said.split('她说:「').at(-1) ?? ''
      if (!quote.includes('让 Kimi')) throw new Error('qa-unreachable')
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ commands: [{ name: 'dispatch', new: { title: '查一下国庆放假多少天' }, to: 'kimi', text: '让 Kimi 查一下国庆放假多少天' }] }) } }] }), { status: 200 })
    }) as never
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      tasks,
      agents: discovery as AgentDiscovery,
      engine: h.engine,
      engineRegistry: h.registry,
      helper: { attach: () => {}, view: () => ({ connected: true, authorized: true }) as never, connected: () => true, onChange: () => {}, onEvent: () => {}, request },
      runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
      appInstalled: () => true,
      model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
      fetchImpl,
    })
    started.push(server)
    return { url: server.url, tasks }
  }

  async function postItem(url: string, body: unknown) {
    const res = await fetch(`${url}/butler/item`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return await res.json() as Record<string, any>
  }

  const SAY = dispatchUnreadableSay({ name: 'Kimi', others: ['豆包办公', 'Codex'] })

  it('★电话里交代(工人身份 → call 入口)', async () => {
    const { url } = await serve()
    const out = await postItem(url, { text: '让 Kimi 查一下国庆放假多少天', assignee: 'kimi' })
    // 2026-10-29 起回包只在真派出去时给 dispatch_ok:true;读不到的那家:不派、如实说为什么。
    expect(out.dispatch_ok).not.toBe(true)
    expect(String(out.note)).toContain('Kimi')
    expect(String(out.note)).toMatch(/没派|读不到|不可用/)
  })

  /*
   * ★ 2026-10-02(卡「语音交代慢与老问上限」):**输入框里没有「选一家」的控件**,她只能把名字写在话里 ——
   * 那条路靠 `dispatchFamilyOf` 从原话里认一次(`http.ts` 的 `namedOrSaid`)。认名字那份名单原来
   * 就是「真能派的那几家」,**而读不到窗口的那几家压根不在里面** → 整句连「这是派活」都没认出来。
   *
   * 现场(诊断包 `工作台诊断包-20261002-112711`):`t-0a166196`「让 Kimi 查一下国庆放假多少天?」
   * 2026-10-01 09:42,落给事务官自己跑了 **45 步 / 2.5 分钟 / 0.295 元**,她被问了三遍「到上限了」
   * (`日志/channel-worker.log.2026-10-01` 2616 / 2618 / 2620),一个字都没发出去。
   * 现在认名字用 `dispatchNameTargetsNow()`(松一格),于是回的是上面那三条同一句话。
   */
  it('★她没带 assignee、只在话里点了名(电脑 / 手机输入框):照样认出是 Kimi,当场说同一句', async () => {
    const { url, tasks } = await serve()
    const out = await postItem(url, { text: '让 Kimi 查一下国庆放假多少天?' })
    expect(out.dispatch_ok).not.toBe(true)
    expect(String(out.note)).toContain('Kimi')
    // 没有谁去开一条事务官会话:那张卡上没有 conversation。
    expect((await tasks.list()).tasks[0]?.conversation).toBeUndefined()
  })

  it('★手机上打字(confirmed)', async () => {
    const { url } = await serve()
    const out = await postItem(url, { text: '让 Kimi 查一下国庆放假多少天', assignee: 'kimi' })
    expect(out.dispatch_ok).not.toBe(true)
    expect(String(out.note)).toContain('Kimi')
  })

  it('★电脑收件箱那个输入框', async () => {
    const { url } = await serve()
    const out = await postItem(url, { text: '让 Kimi 查一下国庆放假多少天', assignee: 'kimi' })
    expect(out.dispatch_ok).not.toBe(true)
    expect(String(out.note)).toContain('Kimi')
    /*
     * 2026-10-29 起:卡照建(话不丢),停在「待办」,卡上那句如实写为什么没派
     * (挂「等你处理」是第 4 批派发口的事;念的那一句与卡上那句仍是同一句的规矩不变)。
     */
    const tasks = await (await fetch(`${url}/state`)).json() as { tasks: { tasks: { id: string, status: string, note?: string }[] } }
    expect(tasks.tasks.tasks[0]?.status).toBe('todo')
    expect(String(tasks.tasks.tasks[0]?.note ?? '')).toContain('没派')
  })
})

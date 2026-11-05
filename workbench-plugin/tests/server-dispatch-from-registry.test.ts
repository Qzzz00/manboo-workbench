// @vitest-environment node
/**
 * **派活候选 / 能力体检 / 额度都读 Agent 登记表**(2026-09-25,卡 Z;设计第一节第 1、6、7 条)。
 *
 * 维护者 09-25:「要是写死了就很糟糕了,这次不能说你把写死的范围增加到 6 个,你得想个机制,
 * 后面检测到是 Agent,有会话窗口的这种都得能有气泡和会话状态、标题、内容」。卡 Q 把界面改成读登记表之后,
 * 还剩派活候选、能力体检、额度三处读写死的名单(`AGENT_DISPATCH_FAMILIES` / `CLIENT_DISPATCH_FAMILIES` /
 * `CLIENT_DISPATCH_OPEN_COMMANDS`)。这一份用例就是那三处的**机制本身**:
 *
 * 1. 运行时发现的一家(「Foo AI」,一扇模拟的对话窗)**不改一行代码**就出现在派活候选、能力体检、额度区;
 * 2. 那一家只有窗口那只手(没为它写过命令行 / 接口),拉起它按包标识(`open -b`),名字与颜色是登记表给的;
 * 3. 额度读不到就明说 —— 不空着、不假装有数。★ 2026-09-26(卡 QO)起这一条有了下一步:
 *    那一格给「读一下」,他打开那家自己的用量页再点一下,**通用正则 + 模型判词**就把数读回来
 *    (机制本身在 `server-open-quota.test.ts`,这里钉的是整条线在 HTTP 上真的通);
 * 4. 他说一句「这不是 Agent」→ **三处都没有它**,壳那边也当场不再放行往它窗口里送话;
 * 5. 他在电话里说「让 Foo AI 说一句」认得出那一家(名字从登记表来);
 * 6. 真派活那道门按登记表把关,认不得的名字当场报得出这台电脑上认得哪几家。
 *
 * 壳与模型都是假的(`tests/fixtures/agentWorld.ts`):一扇真窗口、一次真模型请求都没有。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentCapsView, AgentQuotaView, WorkbenchState } from '../src/protocol.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { createAgentCaps } from '../src/server/agentCaps.ts'
import { createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createWindowQuotaReader, forgetQuotaMemory } from '../src/server/agentQuota.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import { capTargetsFor } from '../src/server/dispatchTargets.ts'
import { KLING_BUNDLE } from '../src/server/klingStep.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
/**
 * 「上次读到的那个数」记在 `agentQuota` 模块里(卡 QS,故意的:读到过的数不因为一会儿没刷新就翻成「没接上」)。
 * 用例之间要清零 —— 不清的话上一条读到的 62% 会顶进下一条「读不到」的用例里。
 */
beforeEach(() => { forgetQuotaMemory() })
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}
async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, any> }
}
async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

/** 一台只有「Foo AI」这一家 Agent 的假 Mac:它那扇窗长得像对话窗口,事务官判它回话的是 AI。 */
async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-registry-'))
  dirs.push(dir)
  const shell = fakeShell([{
    bundle_id: 'com.example.fooai',
    name: 'Foo AI',
    category: 'public.app-category.productivity',
    running: true,
    icon: '#3355cc',
    probe: chatProbe(),
    read: () => chatRead({ answer: '好的,这是本周周报的草稿。' }),
  }])
  // 开集额度那一问(卡 QO):这个假模型认出用量页上那一句,判词带**原话引用**(照抄摘到的那一段)。
  const model = fakeModel({ 'Foo AI': 'ai_agent' }, {},
    '{"kind":"numbers","quote":"已使用 38%","evidence":"Usage","measure":"used_pct","value":38,"reason":"用量页上写着已使用 38%"}')
  const service = createWorkbenchService({})
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const agents = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: shell.helper,
    judge: model.judge,
    remainingCny: async () => 4,
    inCall: () => false,
    sessions: () => service.getState().sessions,
    setInterval: () => 1,
    clearInterval: () => {},
  })
  /**
   * 体检哪几家:**与 `src/index.ts` 的接线走同一个函数**(`capTargetsFor`)—— 两处各拼一遍迟早会漂。
   * 这台假 Mac 上「装没装」那一路一律说没装:于是体检表上有谁,全凭登记表。
   */
  const caps = createAgentCaps({
    families: () => capTargetsFor({ registry: agents.view(), installed: () => false }),
    // 装没装:**登记表里有这一条就是装着的**(同 `src/index.ts` 的接线);按 App 名去 stat 一律说没装。
    installed: family => agents.view().entries.some(one => one.id === family),
    helper: () => ({ connected: true, authorized: true, newConversation: true, readReply: true }),
    cliFound: () => false,
    cliLogin: async () => ({ login: 'unknown' }),
    now: () => new Date('2026-09-25T15:00:00Z'),
    setTimer: () => 1,
    clearTimer: () => {},
  })
  /**
   * 壳:发现那三个只读原语用 fixture 那一份;这张卡多两条自己接
   * (`agent_allow` = 服务端报「登记表里接上了的那几家」;`send_text` = 真派活那一下,回一份成了的结果)。
   */
  const calls: HelperRequest[] = []
  /**
   * 开集额度那条路(卡 QO):这扇假窗上此刻**摆着哪几小段字**。缺省一段都没有(= 他还没打开用量页);
   * `showUsagePage()` 把它换成一页真的用量页。壳只回正则命中的那一小段,这里照那个形状给。
   */
  let onScreen: readonly { id: string, text: string }[] = []
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    calls.push(req)
    if (req.op === 'agent_allow') return { ok: true, result: { count: req.bundle_ids.length } }
    if (req.op === 'send_text') return { ok: true, result: { method: 'ax', submitted: req.submit === true, new_conversation: 'menu' } }
    if (req.op === 'read_texts') {
      const ids = new Set(req.patterns.map(one => one.id))
      return {
        ok: true,
        result: {
          windows: [{ index: 0, w: 1200, h: 800 }],
          matches: onScreen.filter(one => ids.has(one.id)).map(one => ({ ...one, x: 300, y: 200, window: 0 })),
        },
      }
    }
    return await shell.helper.request(req)
  }
  /**
   * 开集的额度读法(2026-09-26,卡 QO):判「这一页上有没有用量」走的是**同一支手**(这里同一份假模型),
   * 记账记在**同一份**登记表的每日上限上(`agents.judgeBudget`)—— 卡 QO:「别另起一套模型调用与记账」。
   */
  const windowQuota = createWindowQuotaReader({
    request,
    helper: () => ({ connected: true, authorized: true, readTexts: true }),
    judgeQuota: model.judge,
    judgeBudget: agents.judgeBudget,
  })
  /*
   * ★ 2026-10-02:派活送话后面是**一条引擎**(窗口那条通道骑在这一份假壳上)。
   * 「有哪几家、每家能做什么」照旧由登记表与探测说话 —— 这一份用例守的就是那一条。
   */
  const engine = engineHarness({
    helper: { connected: () => true, supports: () => true, request },
    installed: () => undefined,
  })
  /*
   * ★ 2026-10-29 入口归一:这句话与其它话一样进理解中枢 —— 模型出点名 dispatch(to = 登记表那家的 id),
   * 登记表的家在候选里(【手】一节,名字与 id 都是登记表给的),受控替身按命令表回意图。
   */
  const hubModel = fakeHubModel({
    '让 Foo AI 用一句话说说中秋节': [{ name: 'dispatch', new: { title: '用一句话说说中秋节' }, to: 'com.example.fooai', text: '让 Foo AI 用一句话说说中秋节' }],
  })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    agents,
    model: hubModel.service as never,
    fetchImpl: hubModel.fetchImpl,
    agentCaps: caps,
    windowQuota,
    appInstalled: () => false,
    engine: engine.engine,
    engineRegistry: engine.registry,
    helper: {
      attach: () => {},
      view: () => ({ connected: true, authorized: true }) as never,
      connected: () => true,
      onChange: () => {},
      onEvent: () => {},
      supports: () => true,
      request,
    } as never,
    // 拉起那家 App 那一步:lsappinfo 说它在跑(这台假 Mac 上它本来就开着)。
    runCommand: async () => ({ ok: true, stdout: '"pid" = 123' }),
    dispatchRun: { runCli: () => ({ pid: 1, exited: new Promise(() => {}) }), alive: () => true, readFile: async () => undefined, resultDir: dir },
  })
  started.push(server)
  return {
    url: server.url,
    agents,
    shell,
    tasks,
    calls,
    /** 他在 Foo AI 里打开了那家自己的用量页(卡 QO)。 */
    showUsagePage: () => { onScreen = [{ id: 'page', text: 'Usage' }, { id: 'used', text: '已使用 38%' }] },
  }
}

/** 派活候选里这一家那一条(`/dispatch/choices` 的 options)。 */
async function optionFor(url: string, text: string, family: string) {
  const view = await post(url, '/dispatch/choices', { text })
  return { view: view.body, option: (view.body.options as any[]).find(one => one.family === family) }
}

describe('派活候选来自 Agent 登记表(2026-09-25,卡 Z)', () => {
  it('★运行时发现的一家:不改一行代码就出现在派活候选,默认窗口那只手,名字与颜色是登记表给的', async () => {
    const { url, agents } = await serve()
    await agents.tick()
    const { view, option } = await optionFor(url, '用一句话说说中秋节', 'com.example.fooai')
    expect(option).toMatchObject({ family: 'com.example.fooai', title: 'Foo AI', ok: true, hand: 'window' })
    // 这台假 Mac 上「装没装」一律说没装 —— 它出现在候选里,只可能是登记表说它接上了。
    // 卡 BS2(2026-09-28):选项表里只有别家,「事务官自己做」那一项拿掉了。
    expect((view.options as any[]).map(one => one.family)).toEqual(['com.example.fooai'])
    // 确认点那一句里就是它自己的名字与额度那一格,没有空白。
    expect(view.line).toContain('Foo AI(没接上:还没读过它窗口上的用量)')
  })

  /**
   * ★ 2026-09-30 维护者拍板把「带我过去」全删(见 `docs/决策记录.md` 末尾那一条)。
   * 原来这一行挂一颗那样的键,「打开它显示用量/额度的那一页」写在键旁边、还只在桌面端画得出来;
   * 键没了,那句人话并进 `line` —— 电脑与手机读的于是是同一句(手机那边本来就一颗键都不画)。
   */
  it('★额度区也读登记表:多一行 Foo AI,还没读过就说清先打开哪一页(不摆键,2026-09-30 维护者拍板全删)', async () => {
    const { url, agents } = await serve()
    await agents.tick()
    const rows = ((await state(url)).agent_quota ?? []) as readonly AgentQuotaView[]
    expect(rows.map(one => one.id)).toEqual(['com.example.fooai'])
    expect(rows[0]).toMatchObject({
      id: 'com.example.fooai',
      title: 'Foo AI',
      state: 'unconnected',
      line: '没接上:还没读过它窗口上的用量 —— 打开它显示用量/额度的那一页,切走时工作台会自己读一次',
    })
    expect(rows[0]?.fix).toBeUndefined()
    // GET /agents/quota 与 /state 是同一份。
    const direct = await get(url, '/agents/quota')
    expect((direct.body.agents as AgentQuotaView[]).map(one => one.id)).toEqual(['com.example.fooai'])
  })

  /**
   * ★ **2026-09-26(卡 QO)整条线:他打开那家自己的用量页 → 点「读一下」→ 那一格成了一个真数字。**
   *
   * 维护者原话:「要有机制」。这一例走的全是真接线:HTTP 那颗键(`/agents/quota/check`)→ 读数器 →
   * 壳 `read_texts`(通用正则,只回命中的那一小段)→ 按窗分组 → 模型判词(带原话引用)→ 采信 → `/state`。
   * 从头到尾没有一处写着「com.example.fooai」。
   */
  it('★他打开用量页、点「读一下」→ 那一格从「没读过」变成「还剩约 62%」,出处写着原话', async () => {
    const { url, agents, showUsagePage } = await serve()
    await agents.tick()
    await state(url)
    showUsagePage()
    const said = await post(url, '/agents/quota/check', { family: 'com.example.fooai' })
    expect(said.status).toBe(200)
    // ★ 卡 MQ3(2026-09-26):那颗键底下说的那一句**从回包里来**,照这一格此刻的话说 ——
    // 界面原来写死「读过了,这一格会跟着变」,读没读到都这一句。
    expect(said.body.note).toBe('读到了:还剩约 62%')
    const rows = ((await state(url)).agent_quota ?? []) as readonly AgentQuotaView[]
    expect(rows[0]).toMatchObject({ id: 'com.example.fooai', title: 'Foo AI', state: 'numbers', level: 'ok', left_pct: 62, line: '还剩约 62%' })
    // 出处照原话写(几点在谁的窗口上读到的、那一句是什么)—— 不编、不折算。
    expect(rows[0]?.source).toMatch(/^\d\d:\d\d 在 Foo AI 的窗口上读到的:「已使用 38%」$/)
    // 派活确认点那一行读的是同一份。
    const { view } = await optionFor(url, '用一句话说说中秋节', 'com.example.fooai')
    expect(view.line).toContain('Foo AI(还剩约 62%)')
  })

  it('★用量页不在窗口上时不瞎猜:说清卡在哪一步(卡 AG 改);不摆键(2026-09-30 维护者拍板全删)', async () => {
    const { url, agents } = await serve()
    await agents.tick()
    await state(url)
    const said = await post(url, '/agents/quota/check', { family: 'com.example.fooai' })
    // 读了、没读到:那一行也照实说(卡 MQ3),不承诺「这一格会跟着变」。
    // ★ 卡 AG(2026-09-27):短的那一句说**哪一步**(不再是笼统的「这页上没看见用量」);
    // 长的那一句在额度那一行里,带着读了几扇窗、看了几段字。
    expect(said.body.note).toBe('读了,用量那一页没开着')
    const rows = ((await state(url)).agent_quota ?? []) as readonly AgentQuotaView[]
    expect(rows[0]).toMatchObject({ state: 'unconnected', short: '没接上:用量那一页没开着' })
    expect(rows[0]?.fix).toBeUndefined()
    expect(rows[0]?.line).toContain('读过 Foo AI 的窗口')
    expect(rows[0]?.line).toContain('一条用量数字、一句用量页的界面字都没读到')
  })

  it('★能力体检也读登记表:多一行 Foo AI,「能改本机文件」那一格是灰的(没有,不是坏了)', async () => {
    const { url, agents } = await serve()
    await agents.tick()
    const caps = (await get(url, '/agents/caps')).body as unknown as AgentCapsView
    expect(caps.agents.map(one => one.family)).toEqual(['com.example.fooai'])
    expect(caps.agents[0]).toMatchObject({ title: 'Foo AI' })
    expect(caps.agents[0]?.cells.chat.state).toBe('ok')
    expect(caps.agents[0]?.cells.edit).toMatchObject({ state: 'na' })
    expect(caps.agents[0]?.cells.edit.fix).toBeUndefined()
  })

  it('★壳那道送话门:服务端把登记表里接上了的那几家报过去(agent_allow),运行时新发现的一家才送得进', async () => {
    const { url, agents, calls } = await serve()
    await agents.tick()
    await state(url)
    const allow = calls.filter(one => one.op === 'agent_allow')
    expect(allow.length).toBeGreaterThan(0)
    // 可灵(2026-10-12,演示卡「出图进可灵」):接力接满(看板 + 壳 + runCommand 都在)时它常驻放行名单,不是登记表里的家 —— 名单按字典序。
    expect((allow.at(-1) as unknown as { bundle_ids: readonly string[] }).bundle_ids).toEqual([KLING_BUNDLE, 'com.example.fooai'].sort())
  })

  it('★他说「这不是 Agent」→ 派活候选、体检、额度三处都没有它;壳那边也当场不再放行', async () => {
    const { url, agents, calls } = await serve()
    await agents.tick()
    await state(url)
    expect(await post(url, '/agents/not-agent', { id: 'com.example.fooai' })).toMatchObject({ status: 200 })
    await state(url)
    const { view } = await optionFor(url, '用一句话说说中秋节', 'com.example.fooai')
    expect((view.options as any[]).map(one => one.family)).toEqual([])
    expect(((await state(url)).agent_quota ?? []).length).toBe(0)
    const caps = (await get(url, '/agents/caps')).body as unknown as AgentCapsView
    expect(caps.agents).toEqual([])
    // 壳收到的最后一份是空的:它不再往那扇窗里送话(壳侧 SendTextPolicy 有自己那一半的用例)。
    const allow = calls.filter(one => one.op === 'agent_allow')
    // 登记表空了,名单里只剩常驻的可灵(同上)。
    expect((allow.at(-1) as unknown as { bundle_ids: readonly string[] }).bundle_ids).toEqual([KLING_BUNDLE])
  })

  it('★电话里说「让 Foo AI 说一句」:名字从登记表认(不改代码),落成那一家的负责人', async () => {
    const { url, agents, tasks } = await serve()
    await agents.tick()
    await state(url)
    const created = await post(url, '/butler/item', { text: '让 Foo AI 用一句话说说中秋节' })
    expect(created.status).toBe(200)
    expect((await tasks.list()).tasks[0]?.assignee).toBe('com.example.fooai')
  })

  it('真派活那道门按登记表把关:认不得的名字 400,而且报得出这台电脑上认得哪几家', async () => {
    const { url, agents, tasks } = await serve()
    await agents.tick()
    await state(url)
    await tasks.create({ title: '写三个标题', status: 'todo' })
    const bad = await post(url, '/dispatch/run', { item_id: 't-1', app: 'gemini' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('com.example.fooai')
    // 登记表里那一家照样派得出去(送进它的窗口)。
    const ok = await post(url, '/dispatch/run', { item_id: 't-1', app: 'com.example.fooai', text: '用一句话说说中秋节' })
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    const sent = (await tasks.list()).tasks.find(one => one.id === 't-1')?.client_dispatch
    expect(sent).toMatchObject({ family: 'com.example.fooai', hand: 'window' })
  })
})

describe('★候选名单只许有一份出处:引擎登记处(2026-10-02,卡「引擎接线与删复制品」)', () => {
  /** 引擎登记处报回来的一条(形状与 `src/index.ts` / `http.ts` 两处接法逐字相同)。 */
  function engineTarget(here: 'package' | 'channel' | 'unknown') {
    return {
      family: 'codex',
      name: 'Codex',
      bundle_id: 'com.openai.codex',
      can: { open: true, send: true, read: true, press: false, approve: false, writeAsk: false, stop: true, openSession: true },
      here,
    }
  }

  it('装着、从没启动过(发现引擎里一条都没有)→ 能力体检照样有它', () => {
    /*
     * 从前这一处只问发现引擎(`registryNow()`),而登记表是**从正在跑的 App 里**长出来的 ——
     * 于是一台装着 Codex、没开过的机器上,能力体检里整家缺席,界面上那几格空着。
     * 派活候选、@ 候选、认家名那三处已经读引擎登记处了,这一处是最后一个。
     */
    const ids = capTargetsFor({ installed: () => false, engineTargets: [engineTarget('package')] }).map(one => one.id)
    expect(ids).toContain('codex')
  })

  it('★`here:\'unknown\'`(目录认识它、这台探不出装没装)不进候选 —— 查不到不许冒充有', () => {
    const ids = capTargetsFor({ installed: () => false, engineTargets: [engineTarget('unknown')] }).map(one => one.id)
    expect(ids).not.toContain('codex')
  })
})

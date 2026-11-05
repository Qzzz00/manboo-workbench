// @vitest-environment node
/**
 * ★ 派活走**真的** helperChannel(2026-09-25,真机上查出来的病根)。
 *
 * 09-24 22:53 统筹在真系统上派给 Kimi:Kimi 那边其实已经收到、也答完了,卡上却写
 * 「派给 Kimi 没派出去:窗口:壳没说为什么,只说没送成」。病根:`helperChannel.request()` 的约定是
 * **壳回 ok:true 时 resolve 的是 `result` 本身**(不带 `ok`),壳回 ok:false 时 reject 一个带原话的 Error;
 * 派活这一层却按"resolve 的是整包 `{ok, result}`"读,于是每一次送成了都被判成没送成。
 * 之前的用例全用假壳、而且假壳照那个错的形状回,所以一条都没红。
 *
 * 这份用例**不用假的 helper**:起真的 `createHelperChannel()`,再用一个 WebSocket 客户端扮演壳 ——
 * 回包的形状与 `workbench-app/Sources/HelperSocket.swift` 逐字一样(`{kind:'res', id, ok, result|error}`)。
 * 这样通道那一层的约定改了,这里会红。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):`/butler/item` 那条派活现在**走引擎**
 * (`http.ts` 的 `/dispatch/client` 从「要 `helper`」改成「要 `engine`」:没传 engine 就整条能力缺席)。
 * 所以这一份在 `serve()` 里**真接一条引擎**(`createEngineWiring`,窗口那条通道直接骑在真的
 * `helperChannel` 上),壳那一头一个字没动 —— 回包形状的约定照旧由这一份钉着。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { engineJobKey } from '../src/server/engine/engine.ts'
import { createEngineWiring } from '../src/server/engine/wire.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { helperOutcome, humanizeFailure } from '../src/server/dispatchClient.ts'
/** 壳「没应声」那句原话:判据一处在 `helperChannel`,用例取导出的那一份(2026-10-13,卡 N)。 */
import { HELPER_TIMEOUT_REASON } from '../src/server/helperChannel.ts'
import { fakeHubModel, type FakeHubCommands } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const sockets: WebSocket[] = []
const dirs: string[] = []

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

type ShellReply = (msg: Record<string, unknown>) => Record<string, unknown>

/** 一个"壳":连 /helper、报 hello(带 caps)、收 req 按 `reply` 回 —— 回包形状同 HelperSocket.swift。 */
async function shell(port: number, reply: ShellReply, caps: readonly string[] = ['new_conversation', 'read_reply']): Promise<{ ops: Record<string, unknown>[] }> {
  const ops: Record<string, unknown>[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/helper`)
  sockets.push(ws)
  await new Promise(resolve => ws.on('open', resolve))
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>
    if (msg.kind !== 'req') return
    ops.push(msg)
    ws.send(JSON.stringify({ ...reply(msg), kind: 'res', id: msg.id }))
  })
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1', caps }))
  return { ops }
}

async function serve(extra: { bringToFront?: (bundleId: string) => Promise<{ ok: boolean }>, answers?: FakeHubCommands } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-real-helper-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}0000000` })
  const helper = createHelperChannel()
  /**
   * ★ **真的一条引擎**(2026-10-02):窗口那条通道骑在上面那个真 `helperChannel` 上 ——
   * 壳回 ok:true 时 resolve 的是 `result` 本身、ok:false 时 reject 一个带原话的 Error,
   * 这两种形状从此由**引擎与窗口适配器**收住(`helperOutcome` + `withWindowWake`),
   * 而这一份从头到尾过的就是生产那条路。
   *
   * 闸与账在这儿现造一份(生产是 `index.ts` 那一份,全进程一本):`phaseOf` 一律「查不出」= 放行。
   */
  const jobLog = createJobLog({ warn: () => {} })
  const gate = createActionGate({
    phaseOf: () => 'unknown',
    log: jobLog,
    now: () => new Date(),
    /*
     * 盯窗那一样闸上有「两拍至少隔 3 秒」(`GATE_LIMITS.reply_watch`:真机的节拍是 4 秒一拍,
     * 落在那个数以内)。这一份用例按**毫秒**轮着等结果,所以把那个间隔压成 0 ——
     * 真机那个数在 `GATE_LIMITS` 里,`action-gate-pipelines.test.ts` 钉着。
     */
    limits: { reply_watch: { tries: 1000, minIntervalMs: 0 } },
  })
  const wiring = createEngineWiring({
    gate,
    log: jobLog,
    sleep: () => Promise.resolve(),
    warn: () => {},
    /*
     * 「这条通道会什么」**每回现查**(生产里留 5 秒:候选名单每打一个字就问一次,不该每次碰壳)。
     * 这一份里服务器先起、壳后连 —— 留着那 5 秒就会把「壳还没连上 → 什么都不会」缓存住,
     * 于是刚连上那几秒派活会被说成「没有一条能送话的通道」。用例要的是**此刻的事实**,所以关掉。
     */
    registry: { capsTtlMs: 0 },
    window: {
      helper: {
        connected: () => helper.connected(),
        supports: cap => helper.supports?.(cap) ?? false,
        request: (req, timeoutMs) => helper.request(req, timeoutMs),
      },
      ...(extra.bringToFront === undefined ? {} : { bringToFront: extra.bringToFront }),
      gate,
      gateJobOf: job => engineJobKey(job),
      sleep: () => Promise.resolve(),
      settleMs: 0,
      wakeWaitMs: 0,
      now: () => new Date(),
    },
  })
  // 2026-10-29 入口归一:/butler/item 进理解中枢 —— 假模型按「说:「…」」里的原话回点名 dispatch;
  // 派活本身走的就是这份用例要钉的那条真通道(真 helperChannel → 引擎 → 窗口适配器)。
  // 只有打进中枢的用例才接模型:接了模型 = 接口那只手存在,会直接派活(dispatchItem)那几条
  // 「窗口失败即定局」的语义会被 fallback 到接口手改掉(回包里多出一段接口手的原话)。
  const model = fakeHubModel(extra.answers ?? {})
  const withModel = Object.keys(extra.answers ?? {}).length === 0
    ? {}
    : { model: model.service as never, fetchImpl: model.fetchImpl }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    ...withModel,
    helper,
    engine: wiring.engine,
    engineRegistry: wiring.registry,
    actionGate: gate,
    jobLog,
    // 「那家在跑」:lsappinfo 那一问回一个 pid(假的,一个进程都不起)。
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    // 「那家装了」:一律当装着(不看这台机器的 /Applications —— 维护者卸了 Manus 这几条就红过,用例得与机器无关)。
    appInstalled: () => true,
    dispatchRun: { pollMs: 30, resultDir: dir },
  })
  started.push(server)
  const waitHelper = async (): Promise<void> => {
    for (let i = 0; i < 200 && !helper.connected(); i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  }
  return { server, tasks, helper, waitHelper, jobLog }
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, tries = 300): Promise<T> {
  let value = await read()
  for (let i = 0; i < tries && !ok(value); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
    value = await read()
  }
  return value
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

describe('真的 helperChannel:壳回 ok:true 时 resolve 的是 result 本身', () => {
  it('★送成了就是送成了:卡「进行中」、等回答;读到回答就收回来、挪「等我确认」', async () => {
    const said = '[派活测试] 让 Kimi 用一句话回答:一年有几个季节?'
    const { server, tasks, waitHelper, jobLog } = await serve({
      answers: { [said]: [{ name: 'dispatch', new: { title: said }, to: 'kimi', text: said }] },
    })
    let marker = ''
    const { ops } = await shell(server.port, (msg) => {
      if (msg.op === 'send_text') {
        marker = String(msg.text).slice(1, String(msg.text).indexOf('】'))
        return { ok: true, result: { method: 'paste', submitted: true, submit_method: 'send_button', new_conversation: '新聊天' } }
      }
      if (msg.op === 'read_reply') {
        return { ok: true, result: { found: true, busy: false, texts: [`【${marker}】一年有几个季节?`, '22:53', '一年有四个季节,分别是春、夏、秋、冬。', '复制'] } }
      }
      return { ok: false, error: `这个假壳不认 ${String(msg.op)}` }
    })
    await waitHelper()
    const created = await post(server.url, '/butler/item', { text: said, assignee: 'kimi', source: 'call' })
    expect(created.status).toBe(200)
    const task = await waitFor(async () => (await tasks.list()).tasks[0], one => one?.status === 'confirm' || one?.status === 'blocked')
    expect(task?.note ?? '').not.toContain('壳没说为什么')
    expect(task?.status).toBe('confirm')
    /*
     * ★ 2026-10-02:卡上**不再有 `new_conversation`**(壳报的那个菜单项名字:`新聊天` / `single_thread`)。
     * 契约里 `JobResult` 没有这一格,`dispatchSend` 也就不往卡上写了。
     * 「开了新对话」这件事照旧查得到 —— 壳收到的那条 `send_text` 带着 `new_conversation:true`(见下面那条断言)。
     */
    expect(task?.client_dispatch).toMatchObject({ status: 'sent', family: 'kimi', submitted: true, reply_state: 'done' })
    /*
     * ★ 2026-10-02 补回来的那一格:「新开一条」那一下壳到底怎么开的(菜单项的名字 / `single_thread`)。
     * 卡上那句话据此说 —— Muse 那种只有一条对话的 App 开不出新的,不能对她说「新开了一条对话」。
     */
    expect(task?.client_dispatch?.new_conversation).toBe('新聊天')
    expect(task?.client_dispatch?.reply).toBe('一年有四个季节,分别是春、夏、秋、冬。')
    const send = ops.find(one => one.op === 'send_text')
    expect(send).toMatchObject({ bundle_id: 'com.moonshot.kimichat', submit: true, new_conversation: true })
    /*
     * ★ **账只许有一个记的人**(2026-10-02 真机那一跑查出来的)。
     *
     * 这一条链路从前记四行:引擎记的 `assigned`(带动作与包标识)+ 投递那一格,
     * 外面派活那一层又手记了一遍 `assigned` + `sent`(没有动作、没有包标识)。
     * `GET /jobs/<id>/trace` 的「指派」那一格于是指着一条压根不知道是什么动作的记录。
     * 现在送话那两步只有引擎记,派活那一层只管它自己知道的事(看见了 / 回了 / 超时 / 读不到)。
     */
    const steps = jobLog.events(task?.id as string).map(one => one.step)
    expect(steps.filter(one => one === 'assigned')).toHaveLength(1)
    const assigned = jobLog.events(task?.id as string).find(one => one.step === 'assigned')
    expect(assigned).toMatchObject({ action: 'dispatch_send', bundle_id: 'com.moonshot.kimichat' })
    // 闸放行(闸自己记的)+ 指派 + 送出那一下的投递格 + 盯窗看见了 + 它回了 —— 一步不少、一步不重。
    expect(new Set(steps)).toEqual(new Set(['gate_pass', 'assigned', 'sent', 'seen', 'replied']))
  })

  it('★壳回 ok:false → 卡上写的就是壳的原话(不是「壳没说为什么」)', async () => {
    const said = '[派活测试] 让 Kimi 说一句话'
    const { server, tasks, waitHelper } = await serve({
      answers: { [said]: [{ name: 'dispatch', new: { title: said }, to: 'kimi', text: said }] },
    })
    await shell(server.port, msg => msg.op === 'send_text'
      ? { ok: false, error: '没送:com.moonshot.kimichat 的输入框里有你没发出去的字,覆盖掉就找不回来了(要覆盖得明着说 overwrite)' }
      : { ok: true, result: {} })
    await waitHelper()
    await post(server.url, '/butler/item', { text: said, assignee: 'kimi', source: 'call' })
    const task = await waitFor(async () => (await tasks.list()).tasks[0], one => one?.status === 'blocked')
    expect(task?.status).toBe('blocked')
    expect(task?.note).toContain('输入框里有你没发出去的字')
    expect(task?.client_dispatch).toMatchObject({ status: 'failed' })
    expect(task?.client_dispatch?.reason).toContain('输入框里有你没发出去的字')
  })

  it('★壳回 ok:false 却没带原因 → 也说得出回包里有什么,绝不写一句空话', async () => {
    const said = '[派活测试] 让 Manus 说一句话'
    const { server, tasks, waitHelper } = await serve({
      answers: { [said]: [{ name: 'dispatch', new: { title: said }, to: 'manus', text: said }] },
    })
    await shell(server.port, msg => msg.op === 'send_text' ? { ok: false, attempt: 2 } : { ok: true, result: {} })
    await waitHelper()
    await post(server.url, '/butler/item', { text: said, assignee: 'manus', source: 'call' })
    const task = await waitFor(async () => (await tasks.list()).tasks[0], one => one?.status === 'blocked')
    expect(task?.note).toContain('没带原因')
    expect(task?.note).toContain('attempt')
    expect(task?.note ?? '').not.toContain('壳没说为什么')
  })

  it('旧壳(hello 里没报 caps)→ 不送,说清是工作台 App 太旧', async () => {
    const said = '[派活测试] 让 Kimi 说一句话'
    const { server, tasks, waitHelper } = await serve({
      answers: { [said]: [{ name: 'dispatch', new: { title: said }, to: 'kimi', text: said }] },
    })
    const { ops } = await shell(server.port, () => ({ ok: true, result: {} }), [])
    await waitHelper()
    await post(server.url, '/butler/item', { text: said, assignee: 'kimi', source: 'call' })
    const task = await waitFor(async () => (await tasks.list()).tasks[0], one => one?.status === 'blocked')
    expect(task?.note).toContain('工作台 App 还是旧版')
    expect(ops.filter(one => one.op === 'send_text')).toEqual([])
  })
})

/**
 * 窗口槽(卡 C 把各家认领进槽之后)。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」)这一组的**接法**变了,守的两条没变:
 * 「叫台前在送字之前」「叫不到台前不挡送字」。
 *
 * 变的那一处:**「键按 bundle id 反查」(`registry.keyFor` → `dock.switchTo('c-muse')`)
 * 不在 `http.ts` 里了** —— 叫台前是窗口适配器的一格 `bringToFront`,生产里由 `index.ts` 的
 * `bringAgentToFront` 接(先 `registry.keyFor` 查槽里的键、切不过去再 `open -b`)。
 * 所以从 `startWorkbenchServer` 这一头**够不到那一段反查**,这一组改成注入 `bringToFront`
 * 直接钉次序。那一段反查此刻**没有用例守着**(交接里要写明:它在 `index.ts`,要配一条用例)。
 */
describe('窗口槽(卡 C 把各家认领进槽之后)', () => {
  it('★送之前先把那一家叫到台前,叫完才送字(中间还先读一眼她那句在不在对话区里)', async () => {
    const said = '[派活测试] 让 Muse 用一句话回答:一分钟有几秒?'
    const order: string[] = []
    const { server, tasks, waitHelper } = await serve({
      bringToFront: async (bundleId: string) => { order.push(`front:${bundleId}`); return { ok: true } },
      answers: { [said]: [{ name: 'dispatch', new: { title: said }, to: 'muse', text: said }] },
    })
    await shell(server.port, (msg) => {
      order.push(String(msg.op))
      return msg.op === 'send_text'
        ? { ok: true, result: { method: 'paste', submitted: true, new_conversation: 'single_thread' } }
        : { ok: true, result: { found: false, busy: false } }
    })
    await waitHelper()
    await post(server.url, '/butler/item', { text: said, assignee: 'muse', source: 'call' })
    await waitFor(async () => (await tasks.list()).tasks[0], one => one?.client_dispatch !== undefined)
    // 叫到台前之后、送字之前,先读一眼她那句在不在对话区里(2026-09-28 Air 维护包;送前后比那一档的底子)
    expect(order.slice(0, 3)).toEqual(['front:com.meta.endo', 'read_reply', 'send_text'])
  })

  it('那一格切不过去(不在槽里 / 摆不成)不挡送字 —— 壳自己会把那扇窗翻出来再送', async () => {
    const said = '[派活测试] 让豆包用一句话回答:一小时有几分钟?'
    const { server, tasks, waitHelper } = await serve({
      bringToFront: async () => ({ ok: false }),
      answers: { [said]: [{ name: 'dispatch', new: { title: said }, to: 'doubao', text: said }] },
    })
    await shell(server.port, msg => msg.op === 'send_text'
      ? { ok: true, result: { method: 'ax_value', submitted: true, new_conversation: '新对话' } }
      : { ok: true, result: { found: false, busy: false } })
    await waitHelper()
    await post(server.url, '/butler/item', { text: said, assignee: 'doubao', source: 'call' })
    const task = await waitFor(async () => (await tasks.list()).tasks[0], one => one?.client_dispatch !== undefined)
    expect(task?.client_dispatch).toMatchObject({ status: 'sent', reply_state: 'waiting' })
  })
})

/**
 * ★ **壳这一送没应声:再核一眼窗口再定,别直接判「没派出去」**(2026-10-13,卡 N)。
 *
 * 现场:17:40:55 `open -b` 豆包 → 17:42:05 `send_text` **整 60 秒没回**(`WINDOW_OP_TIMEOUT_MS.send_text`)
 * → 卡 blocked「派给 豆包办公 没派出去:窗口:壳响应超时」→ 接力第一步 failed → 来电念了「壳响应超时」。
 * 而豆包窗口里那句「【工作台派活 c43a90】…」**明明送进去了,图也出了**:贴完字之后壳在核对(读 AX)
 * 那一步被正在出图的豆包渲染进程卡住了。
 *
 * **为什么这一份不真等 60 秒**:真超时那一下 `helperChannel` reject 的是 `new Error(HELPER_TIMEOUT_REASON)`;
 * 假壳回 `{ok:false, error: HELPER_TIMEOUT_REASON}` 之后通道 reject 出来的是**同一个 Error**
 * (`kind:'res'` 那一段,见 `helperChannel.ts`)—— 适配器这一侧一个字的差别都没有。
 * 真的那 60 秒由 `WINDOW_OP_TIMEOUT_MS` 那张表定,这一份不碰它。
 */
describe('壳这一送没应声:再核一眼窗口再定(卡 N)', () => {
  /** 一扇正常的窗(`agent_read` 的回包形状同 `HelperSocket.swift`):`tail` 里给什么就看得见什么。 */
  function windowRead(tail: readonly string[]): Record<string, unknown> {
    return {
      ok: true,
      result: {
        running: true,
        window: { w: 1000, h: 800 },
        input: { x: 100, y: 700, w: 800, h: 60 },
        tail: tail.map((t, i) => ({ t, x: 120, y: 200 + i * 30, w: 600, h: 20 })),
        side: [],
        stop: [],
      },
    }
  }

  /**
   * 一个「贴完字就不应声」的壳。`landed` = 字其实进去了(窗口里看得见这一单的标记行);
   * `readBroken` = 连读那一眼也不应声(读不到**不许**当成看见了)。
   */
  async function quietShell(port: number, options: { landed: boolean, readBroken?: boolean }) {
    let marker = ''
    return await shell(port, (msg) => {
      if (msg.op === 'send_text') {
        marker = String(msg.text).slice(1, String(msg.text).indexOf('】'))
        return { ok: false, error: HELPER_TIMEOUT_REASON }
      }
      if (options.readBroken === true) return { ok: false, error: HELPER_TIMEOUT_REASON }
      // 豆包一家 `read_reply` 常认不出 → 退到读整扇窗(`readRelayEvidence` 里那条退路)。
      if (msg.op === 'read_reply') return { ok: true, result: { found: false, busy: false } }
      if (msg.op === 'agent_read') return windowRead(options.landed && marker !== '' ? [`【${marker}】春丽在踢腿`] : [])
      return { ok: true, result: {} }
    })
  }

  /** 卡上那句 note 里**念给她听的那半句**(嘴那一侧 `plainFailureWhy` 只取第一个分号之前、再去掉「窗口:」)。 */
  function spokenHalf(note: string | undefined): string {
    return ((note ?? '').split(';')[0] ?? '').replace('窗口:', '')
  }

  it('★壳没应声、可它窗口里有这一单的标记行 → 按送到了记,接力第一步照常', async () => {
    const { server, tasks, waitHelper } = await serve()
    const { ops } = await quietShell(server.port, { landed: true })
    await waitHelper()
    const created = await tasks.create({ title: '[派活测试] 给我生成一个春丽在踢腿的视频', direction: 'mine', status: 'todo' })
    const started = await server.dispatchItem?.(created.id as string, { family: 'doubao', text: '请帮我生成一张图片:春丽在踢腿' })
    // 接力(`videoChain.start`)第一步看的就是这一格。
    expect(started).toMatchObject({ ok: true, hand: 'window' })
    expect(started?.note ?? '').not.toContain(HELPER_TIMEOUT_REASON)
    const task = (await tasks.list()).tasks.find(one => one.id === created.id)
    expect(task?.status).toBe('doing')
    expect(task?.client_dispatch).toMatchObject({ status: 'sent', family: 'doubao', submitted: true })
    // 「它窗口里看见了」那一格(卡上 `seen_at`)—— 这一下的凭据就是它。
    expect(task?.client_dispatch?.seen_at).toBeDefined()
    // 一个字都没再往那扇窗里送(只多读了几眼),一个包都没换。
    expect(ops.filter(one => one.op === 'send_text')).toHaveLength(1)
  })

  it('★壳没应声、它窗口里也没有那一行 → 如实没派出去,念给她的那半句是人话', async () => {
    const { server, tasks, waitHelper } = await serve()
    const { ops } = await quietShell(server.port, { landed: false })
    await waitHelper()
    const created = await tasks.create({ title: '[派活测试] 让豆包说一句话', direction: 'mine', status: 'todo' })
    const started = await server.dispatchItem?.(created.id as string, { family: 'doubao', text: '说一句话' })
    expect(started?.ok).toBe(false)
    expect(spokenHalf(started?.note)).toContain(humanizeFailure(HELPER_TIMEOUT_REASON, 'doubao'))
    // 「壳」「超时」这种内部口径不许落在念出去那半句里。
    expect(spokenHalf(started?.note)).not.toContain(HELPER_TIMEOUT_REASON)
    // 原因照旧留在卡上(后半句)。
    expect(started?.note).toContain(HELPER_TIMEOUT_REASON)
    const task = (await tasks.list()).tasks.find(one => one.id === created.id)
    expect(task?.status).toBe('blocked')
    expect(task?.client_dispatch).toMatchObject({ status: 'failed' })
    expect(ops.filter(one => one.op === 'send_text')).toHaveLength(1)
  })

  it('★读那扇窗也没应声 → 照旧没派出去(读不到不当成看见了)', async () => {
    const { server, tasks, waitHelper } = await serve()
    const { ops } = await quietShell(server.port, { landed: true, readBroken: true })
    await waitHelper()
    const created = await tasks.create({ title: '[派活测试] 让豆包说一句话', direction: 'mine', status: 'todo' })
    const started = await server.dispatchItem?.(created.id as string, { family: 'doubao', text: '说一句话' })
    expect(started?.ok).toBe(false)
    expect(spokenHalf(started?.note)).toContain(humanizeFailure(HELPER_TIMEOUT_REASON, 'doubao'))
    const task = (await tasks.list()).tasks.find(one => one.id === created.id)
    expect(task?.status).toBe('blocked')
    expect(ops.filter(one => one.op === 'send_text')).toHaveLength(1)
  })
})

describe('helperOutcome:两种形状都认', () => {
  it('真通道 resolve 的 result(不带 ok)= 成了', () => {
    expect(helperOutcome({ method: 'paste', submitted: true })).toEqual({ ok: true, result: { method: 'paste', submitted: true } })
  })
  it('老的整包形状照它说的', () => {
    expect(helperOutcome({ ok: true, result: { found: true } })).toEqual({ ok: true, result: { found: true } })
    expect(helperOutcome({ ok: false, error: '输入框没找到' })).toEqual({ ok: false, error: '输入框没找到' })
  })
  it('★失败没带原因 → 写出回包里有哪几格', () => {
    const got = helperOutcome({ ok: false, attempt: 2 })
    expect(got.ok).toBe(false)
    expect(got.ok === false && got.error).toContain('attempt')
  })
})

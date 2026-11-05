// @vitest-environment node
/**
 * 失败恢复的闭环(2026-10-27 三批,卡 `t-bd1c04ed`;任务书「失败之后必须有人负责恢复」)。
 *
 * 场景(全部走既有正式入口,隔离 8791,故障由测试注入,不碰真实服务):
 *   ① 派发通道失效 → 卡如实挂阻塞,**未结责任保留在卡上**(负责人不动、原因在账);
 *   ② 恢复动作沿**同一事项**记账:同事项补充(continue)把处置办法送进事务官会话,
 *      卡的留言留痕 —— 不靠某个统筹私有 state 记得;
 *   ③ 授权内备用路径:原因解除后 /dispatch/run 重派,真实成功(假壳这回送回成功);
 *   ④ 交回 → 验收通过 → 卡 done:恢复后的产物照样过验收,不把中断扩成整体停止。
 *
 * 受控替身范围:壳(engine helper)与会话通道(butlerSession)是假的;路由、状态账、
 * 回执与验收判定全是真产品代码。真机窗口 / 真模型不在本用例范围,交回里如实写。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const PAGE = { origin: 'http://127.0.0.1:3080' }
/** 建事项那一句(打进理解中枢;假模型按它路由回点名 dispatch)。 */
const ITEM_SAID = '把周报版式调成三栏'

/** 受控假模型:这句回点名 dispatch 给豆包(与真的入口同一命令形状)。 */
function hubModel() {
  const model = fakeHubModel({
    [ITEM_SAID]: [{ name: 'dispatch', new: { title: '把周报版式调成三栏' }, to: 'doubao', text: ITEM_SAID }],
  })
  return { model: model.service as never, fetchImpl: model.fetchImpl }
}

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-recovery-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const helperCalls: HelperRequest[] = []
  const said: { session: string, text: string }[] = []
  // 第一道门失败(窗口送不进去),其余照常 —— 注入「通道失效」。
  let firstSendFails = true
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    helperCalls.push(req)
    if (req.op === 'send_text') {
      if (firstSendFails) {
        firstSendFails = false
        return { method: 'ax_value', submitted: false, lock_queued: false, failed: true }
      }
      return { method: 'ax_value', submitted: req.submit === true, new_conversation: '新聊天' }
    }
    return { found: false, busy: false }
  }
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    engine: engine.engine,
    engineRegistry: engine.registry,
    helper: {
      attach: () => {},
      view: () => ({ connected: true, authorized: true }) as never,
      connected: () => true,
      onChange: () => {},
      onEvent: () => {},
      request,
    },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    appInstalled: () => true,
    butlerSession: {
      open: async () => 'sess-recover',
      say: async (session: string, text: string) => { said.push({ session, text }); return true },
    },
    // 2026-10-29 入口归一:建事项这一步进理解中枢 —— 假模型按原语义回点名 dispatch(电话档直接派)。
    ...hubModel(),
  })
  started.push(server)
  return { url: server.url, server, tasks, said, helperCalls }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...PAGE }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

describe('派发通道失效 → 同事项内恢复 → 备用路径重派 → 验收(同一事项闭环)', () => {
  it('① 失败如实挂阻塞,未结责任保留;② 恢复动作沿同事项记账;③ 重派真实成功;④ 验收通过', async () => {
    const h = await serve()

    // 建事项并直派(电话档,直接派)—— 这句进理解中枢,假模型回点名 dispatch。
    const made = await post(h.url, '/butler/item', { text: ITEM_SAID, assignee: 'doubao', source: 'call' })
    expect(made.status).toBe(200)
    const id = String(made.body.id)
    // 等派活那一层把失败写回卡。直派那一支是后台接着派的(接口不阻塞),但服务器登记了
    // 在途派发 —— drain 到落定再读卡,不靠轮询时长碰运气(机器负载高时异步层跑不完,
    // 固定预算的轮询会先超时)。失败写卡 await 在派活那个 promise 链里,落定即已落账。
    await h.server.drainDispatches()
    const card = (await h.tasks.list()).tasks.find(one => one.id === id)
    // ① 失败在账:有阻塞/说明,卡的负责人(未结责任)没丢。(回执未确认那一档也是如实账。)
    expect(String(card?.dispatch_block?.why ?? card?.note ?? '')).not.toBe('')
    expect(card?.status).not.toBe('done')

    // ② 恢复动作沿同一事项记账:同事项补充把处置办法送进事务官会话(NoteDialog 同一入口)。
    await h.tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-recover' } })
    const sup = await post(h.url, '/butler/item/continue', { id, text: '通道恢复了,按原样再派一次' })
    expect(sup.status).toBe(200)
    expect(sup.body).toMatchObject({ ok: true, fact: 'sent' })
    expect(h.said).toContainEqual({ session: 'sess-recover', text: '通道恢复了,按原样再派一次' })

    // ③ 授权内备用路径:同一卡重派(第二道门这回送回成功 —— 发送证据在 helperCalls)。
    const rerun = await post(h.url, '/dispatch/run', { item_id: id, app: 'doubao' })
    expect(rerun.status).toBe(200)
    expect(rerun.body.ok).toBe(true)
    const sends = h.helperCalls.filter(one => one.op === 'send_text')
    expect(sends.length).toBeGreaterThanOrEqual(2)
    expect(sends[sends.length - 1]).toMatchObject({ op: 'send_text', bundle_id: 'com.bot.pc.doubao' })

    // ④ 交回 → 验收:恢复后的产物照样过验收,中断没有扩成整体停止。
    const pass = await post(h.url, '/task/comment', { id, text: '版式对,通过', verdict: 'pass' })
    expect(pass.status).toBe(200)
    const moved = await post(h.url, '/task/move', { id, status: 'done' })
    expect(moved.status).toBe(200)
    const done = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(done?.status).toBe('done')
  })
})

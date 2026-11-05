// @vitest-environment node
/**
 * `/state` 不等中转那一趟(2026-10-21 急修「8791 空转」)。
 *
 * 0.4.143 的引导三件事每拍 `/state` 都问一次「模型接没接上」(`firstUseReadiness`),走的是 `model.status()`。
 * 中转模式有令牌时,它每 15 秒要现场去中转查一次今天的用量 —— 那一趟**没有超时**、也不单飞:
 * 中转一慢,碰上的那一拍 `/state` 就跟着挂(引导会话的隔离实例上一次 28.5 秒),之后每秒的 `/state` 又各发一趟。
 * 「接没接上」只看配置(自己的钥匙 / 中转令牌在不在),跟今天用了多少无关。
 *
 * 钉四件事:
 *   ① 查中转用量有超时,到点回「连不上」,不挂着;
 *   ② `status()` 并发时只查一趟;
 *   ③ `ready()` 只看配置,一趟网络都不走;
 *   ④ `/state` 在 `status()` 挂死时照样回(引导那一格读 `ready()`);
 *   ⑤ 领设备令牌(`registerRelayDevice`)同样有超时 —— 取通道凭据前「没令牌先补一张」走它,
 *      中转不回话时电话工人那条 30 秒一次的拉起循环原来会一直挂在这一趟上。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createBehaviorLog } from '../src/server/behaviorLog.ts'
import { createFirstUseService } from '../src/server/firstUse.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { fetchRelayUsage, registerRelayDevice } from '../src/server/modelConfig.ts'
import { createModelService } from '../src/server/modelService.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 一个不回话的中转:请求一直挂着,直到被掐断(signal)或手动放行。 */
function hangingRelay() {
  const seen: string[] = []
  const waiting: (() => void)[] = []
  const impl: typeof fetch = async (url, init) => {
    seen.push(String(url))
    await new Promise<void>((resolve, reject) => {
      waiting.push(resolve)
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
    })
    return new Response(JSON.stringify({ day: '2026-10-21', used_tokens: 1, daily_token_limit: 10, remaining_tokens: 9 }), { status: 200 })
  }
  return { impl, seen, release: () => { for (const go of waiting.splice(0)) go() } }
}

async function relayBox() {
  const root = mkdtempSync(join(tmpdir(), 'wb-model-nowait-'))
  dirs.push(root)
  await mkdir(join(root, 'workbench'), { recursive: true })
  const modelFile = join(root, 'workbench', 'model.json')
  await writeFile(modelFile, JSON.stringify({ mode: 'relay', relay_url: 'http://relay.test', relay_token: 'wb_test', device_id: 'd1' }))
  return { root, modelFile, credentialFile: join(root, 'workbench', 'credentials.json') }
}

describe('查中转用量有超时', () => {
  it('★中转不回话 → 到点回「连不上」,不挂着', async () => {
    const relay = hangingRelay()
    const started = performance.now()
    const result = await fetchRelayUsage({ relayUrl: 'http://relay.test', token: 'wb_test', fetchImpl: relay.impl, timeoutMs: 50 })
    expect(result.ok).toBe(false)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('领设备令牌有超时', () => {
  it('★中转不回话 → 到点回「连不上」,不挂着', async () => {
    const relay = hangingRelay()
    const started = performance.now()
    const result = await registerRelayDevice({ relayUrl: 'http://relay.test', account: 'a', deviceId: 'd1', fetchImpl: relay.impl, timeoutMs: 50 })
    expect(result.ok).toBe(false)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('模型服务:并发只查一趟;ready() 不走网络', () => {
  it('★status() 并发三次只查一趟中转;ready() 一趟都不走', async () => {
    const box = await relayBox()
    const relay = hangingRelay()
    const model = createModelService({ modelFile: box.modelFile, credentialFile: box.credentialFile, fetchImpl: relay.impl })
    expect(await model.ready()).toBe(true)
    expect(relay.seen).toHaveLength(0)
    const all = Promise.all([model.status(), model.status(), model.status()])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(relay.seen.filter(url => url.includes('usage'))).toHaveLength(1)
    relay.release()
    const views = await all
    expect(views.every(view => view.ready)).toBe(true)
  })
})

describe('/state 不等中转那一趟', () => {
  it('★status() 挂死时 /state 照样回,引导那一格按配置算「模型接上了」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-state-nowait-'))
    dirs.push(dir)
    const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
    const firstUse = createFirstUseService({ file: join(dir, 'first-use.json'), behaviorLog })
    const model = {
      status: () => new Promise<never>(() => {}),
      ready: async () => true,
    }
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService(),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      behaviorLog,
      firstUse,
      model: model as never,
    })
    started.push(server)
    const res = await fetch(`${server.url}/state`, { signal: AbortSignal.timeout(5000) })
    expect(res.status).toBe(200)
    const state = await res.json() as WorkbenchState
    expect(state.first_use).toBeDefined()
  }, 10_000)
})

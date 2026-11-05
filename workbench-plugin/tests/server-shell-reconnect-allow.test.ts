// @vitest-environment node
/**
 * **壳重连时重发允许名单**(2026-09-30,止血第 5 条;设计-重构 根子 4 末尾那一条)。
 *
 * 服务端把「登记表里接上了的那几家」报给壳(`agent_allow`),壳据此放行往那扇窗里送话。
 * 那一发有一道去重(名单没变就不发)—— 而**壳重启之后名单在壳那一侧是空的**:
 * 它自己什么都不记得,服务端这边却因为「名单没变」一个字都不再报。
 * 现象:工作台 App 重启一次,派活就再也送不进那几家的窗口,而两边都没有错误。
 *
 * 这一条钉的是:壳从「断开」回到「连上」的那一拍,去重清零、名单原样再报一次。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { KLING_BUNDLE } from '../src/server/klingStep.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-shell-reconnect-'))
  dirs.push(dir)
  const shell = fakeShell([{
    bundle_id: 'com.example.fooai',
    name: 'Foo AI',
    category: 'public.app-category.productivity',
    running: true,
    icon: '#3355cc',
    probe: chatProbe(),
    read: () => chatRead({ answer: '好的。' }),
  }])
  const model = fakeModel({ 'Foo AI': 'ai_agent' })
  const service = createWorkbenchService({})
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
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
  const calls: HelperRequest[] = []
  /** 这一拍壳连着没有。断开/连上都由用例自己摆。 */
  let connected = true
  const listeners: (() => void)[] = []
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    agents,
    tasks,
    appInstalled: () => false,
    helper: {
      attach: () => {},
      view: () => ({ connected, authorized: connected }) as never,
      connected: () => connected,
      onChange: (listener: () => void) => { listeners.push(listener) },
      onEvent: () => {},
      supports: () => true,
      request: async (req: HelperRequest) => {
        calls.push(req)
        if (req.op === 'agent_allow') return { ok: true, result: { count: req.bundle_ids.length } }
        return await shell.helper.request(req)
      },
    } as never,
    runCommand: async () => ({ ok: true, stdout: '"pid" = 123' }),
  })
  started.push(server)
  return {
    url: server.url,
    agents,
    calls,
    allow: () => calls.filter(one => one.op === 'agent_allow'),
    /** 壳掉线 / 重新连上(壳自己重启过,它那一侧什么都不记得)。 */
    setConnected: (value: boolean) => { connected = value; for (const listener of listeners) listener() },
  }
}

/** 问一次派活候选:服务端顺手把允许名单报给壳(`tellShellWhoIsAnAgent` 就长在那条路上)。 */
async function choices(url: string): Promise<void> {
  await fetch(`${url}/dispatch/choices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '用一句话说说中秋节' }),
  })
}

describe('壳重连:允许名单重发(2026-09-30)', () => {
  it('★壳断开又连上:去重清零,名单原样再报一次(名单一个字没变也要报)', async () => {
    const { url, agents, allow, setConnected } = await serve()
    await agents.tick()
    await choices(url)
    const before = allow()
    expect(before.length).toBeGreaterThan(0)
    // 可灵(2026-10-12,演示卡「出图进可灵」):接力接满(看板 + 壳 + runCommand 都在)时它常驻放行名单,不是登记表里的家 —— 名单按字典序。
    expect((before.at(-1) as unknown as { bundle_ids: readonly string[] }).bundle_ids).toEqual([KLING_BUNDLE, 'com.example.fooai'].sort())

    // 名单没变,再问几次 /state 也不会重复发 —— 去重照旧管用。
    await choices(url)
    expect(allow()).toHaveLength(before.length)

    // 壳重启:先断,再连上。
    setConnected(false)
    setConnected(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    const after = allow()
    expect(after.length).toBe(before.length + 1)
    expect((after.at(-1) as unknown as { bundle_ids: readonly string[] }).bundle_ids).toEqual([KLING_BUNDLE, 'com.example.fooai'].sort())
  })

  it('壳一直连着(只是报了一次状态变化):不重复发', async () => {
    const { url, agents, allow, setConnected } = await serve()
    await agents.tick()
    await choices(url)
    const before = allow().length
    setConnected(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(allow()).toHaveLength(before)
  })
})

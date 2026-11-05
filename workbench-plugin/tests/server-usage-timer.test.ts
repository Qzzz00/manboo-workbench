// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

function fakeUsage() {
  let calls = 0
  return {
    refresh: async () => { calls += 1 },
    view: () => ({ error: '测试桩' }),
    count: () => calls,
  }
}

/**
 * 2026-08-31 真机定性(标签时灵时不灵一案):用量刷新原来挂在 1 秒 tick 上,
 * "一轮没跑完就跳过"在真机上等于一轮接一轮连轴转——~/.codex/sessions 已 4.6GB,
 * 磁盘被持续打满,叠上每 30 秒的项目区 git 扫描,把 /dock/switch 拖到 3–15 秒。
 * 用量面板的数字迟一分钟无所谓(Ben 拍板),刷新降到独立的分钟级定时器。
 */
describe('用量刷新定时器(2026-08-31 风暴修复)', () => {
  it('不再跟着 1 秒 tick 连轴转:tick 快跑 250ms,refresh 仍只有启动那一次', async () => {
    const usage = fakeUsage()
    const service = createWorkbenchService({ now: () => 1_755_500_000 })
    const server = await startWorkbenchServer({
      port: 0, service, tickIntervalMs: 50, heartbeatMs: 0, usage,
    })
    started.push(server)

    await new Promise(resolve => setTimeout(resolve, 250))
    expect(usage.count()).toBe(1) // 只有启动时那一次,tick 跳了四五拍也不带它
  })

  it('usageIntervalMs 是它自己的节拍:60ms 一轮,250ms 内至少再刷一次', async () => {
    const usage = fakeUsage()
    const service = createWorkbenchService({ now: () => 1_755_500_000 })
    const server = await startWorkbenchServer({
      port: 0, service, tickIntervalMs: 0, heartbeatMs: 0, usage, usageIntervalMs: 60,
    })
    started.push(server)

    await new Promise(resolve => setTimeout(resolve, 250))
    expect(usage.count()).toBeGreaterThanOrEqual(2) // 启动一次 + 定时器至少一轮
  })
})

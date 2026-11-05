// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { watchCodexSessions } from '../src/quota/codexWatch.ts'

const dirs: string[] = []
const stops: (() => void)[] = []

afterEach(() => {
  while (stops.length) stops.pop()?.()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function codexHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-watch-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'sessions', '2026', '08', '20'), { recursive: true })
  return dir
}

/** 等一个条件成立，最多等 ms 毫秒。文件事件是异步的，不能同步断言。 */
async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return check()
}

describe('watchCodexSessions', () => {
  it('Codex 写入新记录时立刻回调——这才是"及时"，不是等下一个五分钟', async () => {
    const home = codexHome()
    let hits = 0
    const stop = watchCodexSessions(home, () => { hits += 1 }, { debounceMs: 30 })
    stops.push(stop)
    // macOS 的 recursive watch 走 FSEvents，注册到真正开始收事件之间有延迟；
    // 不等这一下，紧跟着的写入会漏掉（本地实测偶发）。
    await new Promise(resolve => setTimeout(resolve, 400))

    writeFileSync(join(home, 'sessions', '2026', '08', '20', 'rollout-a.jsonl'), '{"x":1}\n')

    expect(await until(() => hits > 0)).toBe(true)
  })

  it('连续写入合并成一次回调——Codex 一轮会写很多行，不该触发几十次采集', async () => {
    const home = codexHome()
    let hits = 0
    const stop = watchCodexSessions(home, () => { hits += 1 }, { debounceMs: 120 })
    stops.push(stop)
    await new Promise(resolve => setTimeout(resolve, 400))

    const file = join(home, 'sessions', '2026', '08', '20', 'rollout-b.jsonl')
    for (let i = 0; i < 10; i += 1) writeFileSync(file, `{"line":${i}}\n`)

    await until(() => hits > 0)
    await new Promise(resolve => setTimeout(resolve, 400))
    // 断言的是"远少于写入次数"而不是恰好 1 次：FSEvents 的投递时机不受我们控制，
    // 10 次写入偶尔会跨过防抖窗口分成两批。要保证的是不会变成几十次采集。
    expect(hits).toBeLessThanOrEqual(3)
  })

  it('stop 之后不再回调——插件卸载时别留一个监听在后台', async () => {
    const home = codexHome()
    let hits = 0
    const stop = watchCodexSessions(home, () => { hits += 1 }, { debounceMs: 20 })
    stop()

    writeFileSync(join(home, 'sessions', '2026', '08', '20', 'rollout-c.jsonl'), '{"x":1}\n')
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(hits).toBe(0)
  })

  it('目录不存在时不抛——他可能压根没装 Codex', () => {
    expect(() => watchCodexSessions('/nowhere/at/all', () => {})()).not.toThrow()
  })
})

// @vitest-environment node
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { watchClaudeDesktopUsage } from '../src/quota/claudeDesktopWatch.ts'

const dirs: string[] = []
const stops: (() => void)[] = []

afterEach(() => {
  while (stops.length) stops.pop()?.()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function usageFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-watch-'))
  dirs.push(dir)
  return join(dir, 'plan-usage-history.json')
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

/**
 * 桌面端的真实写法：先写 `.plan-usage-history.json.<pid>.<rand>.tmp` 再 rename 顶上。
 * 2026-08-21 在真机上抓到的事件序列就是这样，inode 每次都变——
 * 所以这个测试才是这份实现存在的理由。
 */
function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.85618.hre7yw.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

describe('watchClaudeDesktopUsage', () => {
  it('桌面端落新样本时立刻回调——不必等采集循环的下一个五分钟', async () => {
    const file = usageFile()
    writeFileSync(file, '{"version":2,"samples":[]}')
    let hits = 0
    const stop = watchClaudeDesktopUsage(file, () => { hits += 1 }, { debounceMs: 30 })
    stops.push(stop)
    await new Promise(resolve => setTimeout(resolve, 200))

    atomicWrite(file, '{"version":2,"samples":[{"t":1,"u":{"fh":1,"sd":1}}]}')

    expect(await until(() => hits > 0)).toBe(true)
  })

  it('连着两次原子写都收得到——盯着文件的监听在这里会哑掉，因为 rename 换了 inode', async () => {
    const file = usageFile()
    writeFileSync(file, '{"version":2,"samples":[]}')
    let hits = 0
    const stop = watchClaudeDesktopUsage(file, () => { hits += 1 }, { debounceMs: 30 })
    stops.push(stop)
    await new Promise(resolve => setTimeout(resolve, 200))

    atomicWrite(file, '{"a":1}')
    expect(await until(() => hits >= 1)).toBe(true)

    atomicWrite(file, '{"a":2}')
    expect(await until(() => hits >= 2)).toBe(true)
  })

  it('同目录里别人的写入不触发采集——那个目录里 Cookies、leveldb 每秒都在写', async () => {
    const file = usageFile()
    writeFileSync(file, '{"version":2,"samples":[]}')
    let hits = 0
    const stop = watchClaudeDesktopUsage(file, () => { hits += 1 }, { debounceMs: 30 })
    stops.push(stop)
    await new Promise(resolve => setTimeout(resolve, 200))

    for (let i = 0; i < 5; i += 1) writeFileSync(join(file, '..', `Cookies-${i}`), `${i}`)
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(hits).toBe(0)
  })

  it('一次原子写只采一轮——rename 会连着报好几个事件', async () => {
    const file = usageFile()
    writeFileSync(file, '{"version":2,"samples":[]}')
    let hits = 0
    const stop = watchClaudeDesktopUsage(file, () => { hits += 1 }, { debounceMs: 120 })
    stops.push(stop)
    await new Promise(resolve => setTimeout(resolve, 200))

    atomicWrite(file, '{"a":1}')
    await until(() => hits > 0)
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(hits).toBe(1)
  })

  it('stop 之后不再回调——插件卸载时别留一个监听在后台', async () => {
    const file = usageFile()
    writeFileSync(file, '{"version":2,"samples":[]}')
    let hits = 0
    const stop = watchClaudeDesktopUsage(file, () => { hits += 1 }, { debounceMs: 20 })
    stop()

    atomicWrite(file, '{"a":1}')
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(hits).toBe(0)
  })

  it('目录不存在时不抛——他可能压根没装 Claude 桌面端', () => {
    expect(() => watchClaudeDesktopUsage('/nowhere/at/all/plan-usage-history.json', () => {})()).not.toThrow()
  })
})

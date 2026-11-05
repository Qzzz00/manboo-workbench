// @vitest-environment node
/**
 * **登记表里没有的会话,点开时按 id 去找**(2026-10-13 夜,卡 W)。
 *
 * 真机:维护者手机上要接着「查询 GoSim 深圳活动日期」那条 Codex 会话说,「一开始还有输入框,现在输入框都没有了,
 * 说这个会话没有开着」。查实:工作台 23:24 / 23:26 两次发版重启,登记表只在内存、启动不回放、Codex 只登记两小时内
 * 有动静的,那条最后一次动在 21:07 → 不在表里 → `view` 回 undefined → 路由 404「读不到这条会话的记录」→ 手机收掉输入框。
 * 记录文件本身读得好好的(离线读 17 毫秒)。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionDigestService } from '../src/server/sessionDigestService.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const line = (row: unknown) => JSON.stringify(row)
const TRANSCRIPT = [
  line({ type: 'user', sessionId: 'd1', cwd: '/tmp/p', timestamp: '2026-10-12T04:03:17.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '我们入围了,活动具体哪天?' } }),
  line({ type: 'assistant', sessionId: 'd1', timestamp: '2026-10-12T04:05:00.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '活动在 10 月 25 日。' }] } }),
].join('\n')

function fileIn(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-digest-locate-'))
  dirs.push(dir)
  const file = join(dir, 'd1.jsonl')
  writeFileSync(file, TRANSCRIPT)
  return file
}

describe('★登记表里没有 → 按 id 找、找到就登记', () => {
  it('没登记过、locate 找得到 → 读得出来,而且之后 fileOf 也认得', async () => {
    const file = fileIn()
    let asked = 0
    const digest = createSessionDigestService({
      sessions: () => [],
      locate: async (agent, id) => { asked += 1; return agent === 'claude' && id === 'd1' ? { file, format: 'claude-transcript', name: '查活动日期' } : undefined },
    })
    const view = await digest.view('claude', 'd1')
    expect(view).toBeDefined()
    expect(view?.rounds.length).toBeGreaterThanOrEqual(1)
    expect(view?.title).toBe('查活动日期')
    expect(digest.fileOf?.('claude', 'd1')).toBe(file)
    // 登记过了:第二次不再去找。
    await digest.view('claude', 'd1')
    expect(asked).toBe(1)
  })

  it('locate 也找不到 / 没传 locate / locate 抛错 → 照旧 undefined(路由照旧 404)', async () => {
    const none = createSessionDigestService({ sessions: () => [], locate: async () => undefined })
    expect(await none.view('codex', 'x')).toBeUndefined()
    const old = createSessionDigestService({ sessions: () => [] })
    expect(await old.view('codex', 'x')).toBeUndefined()
    const bad = createSessionDigestService({ sessions: () => [], locate: async () => { throw new Error('目录读不了') } })
    expect(await bad.view('codex', 'x')).toBeUndefined()
  })

  it('登记过的照旧不问 locate', async () => {
    const file = fileIn()
    let asked = 0
    const digest = createSessionDigestService({ sessions: () => [], locate: async () => { asked += 1; return undefined } })
    digest.note('claude', 'd1', file, 'claude-transcript')
    expect(await digest.view('claude', 'd1')).toBeDefined()
    expect(asked).toBe(0)
  })
})

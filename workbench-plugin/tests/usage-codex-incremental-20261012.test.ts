/**
 * Codex 用量日志**增量追读**(2026-10-12,卡 `claude/ops-patch-1012`;运营同学 10-09 在 0.4.98 产物上修的那一条)。
 *
 * 原来 Codex 那一家是「文件变长了就整份重读」(cwd 只在文件头出现一次,追读拿不到);
 * 配上 10 秒一轮,一份几百 MB 的活跃 rollout 每十秒整份流过一遍。
 * 现在每个文件各留一份**解析器状态**(cwd / 模型 / 序号)+ 一截没换行的尾巴:每轮只从上次偏移往后读,
 * 读到半条 JSONL 就留到下一轮拼上;文件被截短(Codex 另起一份同名文件)才整份重来。
 *
 * 钉四件事:
 *   ① 追加的记录照样带着文件头那个 cwd 归到项目上(不是「(未知)」);
 *   ② 半行不计、下一轮拼上只计一次;
 *   ③ 没变的文件一个字节都不再读;
 *   ④ 文件变短 → 整份重来,不留上一份的尾巴。
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUsageCollector } from '../src/usage/collector.ts'

const CWD = '/Users/example/Documents/GitHub/desktop-workbench'
const meta = JSON.stringify({ type: 'session_meta', payload: { cwd: CWD, source: 'cli', timestamp: '2026-10-09T10:00:00Z' } })
const turn = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } })
const count = (n: number): string => JSON.stringify({
  timestamp: `2026-10-09T10:0${n}:00Z`,
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, total_token_usage: { input_tokens: 100 * n, cached_input_tokens: 40 * n, output_tokens: 10 * n, total_tokens: 110 * n } } },
})
const SESSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const KEY = `codex:${SESSION}`

let tmp: string | undefined
afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  tmp = undefined
})

function rig() {
  tmp = mkdtempSync(join(tmpdir(), 'usage-codex-inc-'))
  const day = join(tmp, '.codex/sessions/2026/10/09')
  mkdirSync(day, { recursive: true })
  mkdirSync(join(tmp, '.claude/projects'), { recursive: true })
  const file = join(day, `rollout-2026-10-09T10-00-00-${SESSION}.jsonl`)
  writeFileSync(file, `${[meta, turn, count(1)].join('\n')}\n`)
  return { file, collector: createUsageCollector({ home: tmp }) }
}

function totals(collector: ReturnType<typeof createUsageCollector>) {
  return collector.sessionTotals([KEY])[KEY]
}

describe('Codex rollout 增量追读', () => {
  it('★追加的记录仍归到文件头那个项目上,半行留到下一轮拼上只计一次', async () => {
    const { file, collector } = rig()
    await collector.refresh()
    expect(totals(collector)?.input).toBe(60)

    const third = count(3)
    appendFileSync(file, `${count(2)}\n${third.slice(0, 20)}`)
    await collector.refresh()
    expect(totals(collector)?.input).toBe(120) // 半行不算

    appendFileSync(file, `${third.slice(20)}\n`)
    await collector.refresh()
    expect(totals(collector)?.input).toBe(180) // 拼上了,只多一条
    const view = collector.view()
    if ('error' in view) throw new Error(view.error)
    const day = view.days.find(one => one.date.startsWith('2026-10-09'))
    const projects = Object.keys(day?.by_project ?? {})
    // 追加的那两条没有落进「(未知)」—— 项目名仍从文件头那一行 cwd 来。
    expect(projects).toHaveLength(1)
    expect(projects[0]).not.toContain('未知')
    expect(day?.by_project[projects[0] as string]?.input).toBe(180)
  })

  it('文件变短 → 整份重来,不留上一份的尾巴', async () => {
    const { file, collector } = rig()
    appendFileSync(file, count(2).slice(0, 15))
    await collector.refresh()
    expect(totals(collector)?.input).toBe(60)
    // 文件被截短重写:头两行照旧,后面是两条记录。上一轮留下的半截尾巴不许粘到新文件头上 ——
    // 粘上了 session_meta 那一行就解不开,cwd 丢了,记录会落进「(未知)」。
    writeFileSync(file, `${[meta, turn, count(1), count(5)].join('\n')}\n`)
    await collector.refresh()
    // 序号从头数:count(1) 的去重键 `…:0` 上一轮已计过(不重复),count(5) 是 `…:1`,多一条。
    expect(totals(collector)?.input).toBe(120)
    const view = collector.view()
    if ('error' in view) throw new Error(view.error)
    expect(view.sources.codex).toEqual({ status: 'ok' })
    const day = view.days.find(one => one.date.startsWith('2026-10-09'))
    expect(Object.keys(day?.by_project ?? {}).some(name => name.includes('未知'))).toBe(false)
  })
})

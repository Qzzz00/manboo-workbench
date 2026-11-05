import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUsageCollector } from '../src/usage/collector.ts'
import { parseKimiWireLine, kimiFamilyOf } from '../src/usage/kimi.ts'

/**
 * Kimi 用量采集(2026-10-27 重新接上,任务书 `docs/任务书-Kimi用量接进消耗面板-2026-10-27.md`)。
 *
 * 数据源是两棵 layout 相同的树:
 * - 命令行:`~/.kimi-code/sessions/<wd_xxx>/<session_xxx>/agents/<agent>/wire.jsonl`
 * - 桌面版本机 Agent:`~/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions/…`
 *
 * 每行一个 JSON,`type == "usage.record"` 且 `usageScope == "turn"` 的才算数
 * (`"session"` 是累计值,加了会重复);模型按 **model 分家**:Kimi 模型归 `kimi`,
 * `volcengine-coding-plan/deepseek-v4-flash` 归 `dsh`(DeepSeek 合计多出火山那一份)。
 */
const T0 = 1789468206067 // 与 usage-dsh-collector.test.ts 同源,本机时区下是 2026-09-15

/** 造一行 wire 用量记录。 */
const wire = (model: string, usageScope: string, io: number, cr: number, cc: number, out: number, time = T0): string =>
  JSON.stringify({ type: 'usage.record', time, model, usageScope, usage: { inputOther: io, inputCacheRead: cr, inputCacheCreation: cc, output: out } })

const CLI_SESSIONS = join('.kimi-code', 'sessions')
const DESKTOP_HOME = join('Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home')
const DESKTOP_SESSIONS = join(DESKTOP_HOME, 'sessions')

let tmp: string | undefined
function home(): string {
  tmp = mkdtempSync(join(tmpdir(), 'usage-kimi-'))
  mkdirSync(join(tmp, '.claude/projects'), { recursive: true })
  mkdirSync(join(tmp, '.codex/sessions'), { recursive: true })
  mkdirSync(join(tmp, '.dsh/sessions'), { recursive: true })
  // 注意不建 .kimi-code —— 「没装 Kimi」那一个用例就靠它缺席
  return tmp
}
/** 造一棵 sessions 树并写 workspaces.json;返回 wire 文件路径。 */
function wireFile(root: string, wd: string, session: string, agent: string, lines: string[]): string {
  const dir = join(root, wd, session, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'wire.jsonl')
  writeFileSync(path, lines.map(line => `${line}\n`).join(''))
  return path
}
function workspaces(root: string, map: Record<string, string>): void {
  mkdirSync(join(root, '..'), { recursive: true })
  writeFileSync(join(root, '..', 'workspaces.json'), JSON.stringify({ version: 1, workspaces: Object.fromEntries(Object.entries(map).map(([id, rootPath]) => [id, { root: rootPath, name: rootPath.split('/').pop() ?? rootPath }])) }))
}
afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  tmp = undefined
})

async function refreshed(root: string) {
  const collector = createUsageCollector({ home: root })
  await collector.refresh()
  const view = collector.view()
  if ('error' in view) throw new Error(view.error)
  return { collector, view }
}

describe('Kimi wire 解析器(parseKimiWireLine)', () => {
  const ctx = { path: '/x/wire.jsonl', lineNo: 3, session: 'session_s', project: 'desktop-workbench' }

  it('只认 usageScope == "turn";session 累计值、别的 type 一律跳过', () => {
    expect(parseKimiWireLine(wire('kimi-code/kimi-for-coding', 'turn', 100, 1000, 0, 10), ctx))
      .toMatchObject({ ts: new Date(T0).toISOString(), project: 'desktop-workbench', model: 'kimi-code/kimi-for-coding', source: 'kimi', input: 100, cache_read: 1000, cache_write: 0, output: 10, session: 'session_s', key: 'kimi:/x/wire.jsonl:3' })
    // "session" 是累计值,加了会重复 —— 一个字都不计
    expect(parseKimiWireLine(wire('k3-agent', 'session', 999, 999, 999, 999), ctx)).toBeUndefined()
    expect(parseKimiWireLine(JSON.stringify({ type: 'something.else', time: T0 }), ctx)).toBeUndefined()
    expect(parseKimiWireLine('this is not json', ctx)).toBeUndefined()
  })

  it('按 model 分家:Kimi 模型归 kimi,火山 deepseek 归 dsh', () => {
    expect(kimiFamilyOf('kimi-code/kimi-for-coding')).toBe('kimi')
    expect(kimiFamilyOf('kimi-for-coding')).toBe('kimi')
    expect(kimiFamilyOf('k3-agent')).toBe('kimi')
    expect(kimiFamilyOf('k3-agent-swarm')).toBe('kimi')
    expect(kimiFamilyOf('k2d6-agent')).toBe('kimi')
    expect(kimiFamilyOf('k2d8-preview')).toBe('kimi')
    expect(kimiFamilyOf('volcengine-coding-plan/deepseek-v4-flash')).toBe('dsh')
    // 认不出的新 Kimi 模型(如将来的 k4-*)归 kimi —— 这是 Kimi 引擎的 wire 日志
    expect(kimiFamilyOf('k4-agent')).toBe('kimi')
    expect(parseKimiWireLine(wire('volcengine-coding-plan/deepseek-v4-flash', 'turn', 50, 5, 1, 5), ctx)?.source).toBe('dsh')
  })

  it('缺字段/坏时刻不猜:四个用量字段缺了按 0,time 认不出整条不计', () => {
    const sparse = parseKimiWireLine(JSON.stringify({ type: 'usage.record', time: T0, model: 'k3-agent', usageScope: 'turn', usage: { inputOther: 7 } }), ctx)
    expect(sparse).toMatchObject({ input: 7, cache_read: 0, cache_write: 0, output: 0 })
    expect(parseKimiWireLine(JSON.stringify({ type: 'usage.record', time: 'not-a-time', model: 'k3-agent', usageScope: 'turn', usage: {} }), ctx)).toBeUndefined()
    expect(parseKimiWireLine(JSON.stringify({ type: 'usage.record', time: T0, usageScope: 'turn', usage: {} }), ctx)).toBeUndefined()
  })
})

describe('Kimi 用量采集(scanKimi)', () => {
  it('两个根都读:turn 才计、子 agent 也读、按 model 分家、项目经 workspaces 映射归拢', async () => {
    const root = home()
    workspaces(join(root, CLI_SESSIONS), {
      'wd_w1': '/Users/example/Documents/GitHub/desktop-workbench',
    })
    // 命令行侧:main + 子 agent 各一条 turn;外加一条 session 累计值(必须跳过)和一行非用量记录
    wireFile(join(root, CLI_SESSIONS), 'wd_w1', 'session_s1', 'main', [
      wire('kimi-code/kimi-for-coding', 'turn', 100, 1000, 0, 10),
      wire('kimi-code/kimi-for-coding', 'session', 999, 999, 999, 999),
      JSON.stringify({ type: 'message', text: 'hello' }),
    ])
    wireFile(join(root, CLI_SESSIONS), 'wd_w1', 'session_s1', 'sub1', [
      wire('k3-agent', 'turn', 7, 70, 0, 1),
    ])
    wireFile(join(root, CLI_SESSIONS), 'wd_w1', 'session_s2', 'main', [
      wire('volcengine-coding-plan/deepseek-v4-flash', 'turn', 50, 5, 2, 5),
    ])
    // 桌面版侧
    mkdirSync(join(root, DESKTOP_SESSIONS), { recursive: true })
    workspaces(join(root, DESKTOP_SESSIONS), {
      'wd_d1': '/Users/example/Documents/GitHub/Echo/echo',
    })
    wireFile(join(root, DESKTOP_SESSIONS), 'wd_d1', 'conv-c1', 'main', [
      wire('k3-agent-swarm', 'turn', 9, 90, 1, 2),
    ])

    const { collector, view } = await refreshed(root)
    expect(view.sources.kimi).toEqual({ status: 'ok' })
    const day = view.days.find(d => d.date === '2026-09-15')
    // Kimi 模型之和:100+7(命令行)+9(桌面)=116 入;火山 deepseek 单独归 dsh
    expect(day?.by_source.kimi).toEqual({ input: 116, output: 13, cache_read: 1160, cache_write: 1 })
    expect(day?.by_source.dsh).toEqual({ input: 50, output: 5, cache_read: 5, cache_write: 2 })
    expect(day?.by_project['desktop-workbench'])
      .toEqual({ input: 157, output: 16, cache_read: 1075, cache_write: 2 })
    expect(day?.by_project.Echo).toEqual({ input: 9, output: 2, cache_read: 90, cache_write: 1 })
    // 模型名原样保留(带 provider 前缀),模型页按它列行
    expect(day?.by_model['kimi-code/kimi-for-coding']?.input).toBe(100)
    expect(day?.by_model['volcengine-coding-plan/deepseek-v4-flash']?.input).toBe(50)
    // 会话键:同一会话目录下 main 与子 agent 并成一条
    expect(collector.sessionTotals(['kimi:session_s1'])).toEqual({
      'kimi:session_s1': { input: 107, output: 11, cache_read: 1070, cache_write: 0 },
    })
  })

  it('增量追读:连跑两轮数不变,追加了只记新增的;截短重扫靠 路径+行号 去重不计双份', async () => {
    const root = home()
    workspaces(join(root, CLI_SESSIONS), { 'wd_w1': '/Users/example/Documents/GitHub/desktop-workbench' })
    const path = wireFile(join(root, CLI_SESSIONS), 'wd_w1', 'session_s1', 'main', [
      wire('k3-agent', 'turn', 100, 10, 0, 10),
    ])
    const collector = createUsageCollector({ home: root })
    const totals = () => {
      const view = collector.view()
      if ('error' in view) throw new Error(view.error)
      return view.days.find(d => d.date === '2026-09-15')?.by_source.kimi
    }
    await collector.refresh()
    expect(totals()).toEqual({ input: 100, output: 10, cache_read: 10, cache_write: 0 })
    // 第二轮:文件没变,一行都不重读,数不变(验收要求)
    await collector.refresh()
    expect(totals()).toEqual({ input: 100, output: 10, cache_read: 10, cache_write: 0 })

    appendFileSync(path, `${wire('k3-agent', 'turn', 1000, 100, 0, 100)}\n`)
    await collector.refresh()
    expect(totals()).toEqual({ input: 1100, output: 110, cache_read: 110, cache_write: 0 })

    // 文件被截短(nextCursor rescan):同内容按去重键(路径+行号)认出,不重复计入。
    // (「截短后追加」不承保:旧文件同位置若换过内容,位置键分不出来 —— 与 Codex 同一个
    //  append-only 假设;wire.jsonl 由 Kimi 引擎只追加写,验收也只要求增量轮次间不重复。)
    writeFileSync(path, `${wire('k3-agent', 'turn', 100, 10, 0, 10)}\n`)
    await collector.refresh()
    expect(totals()).toEqual({ input: 1100, output: 110, cache_read: 110, cache_write: 0 })
  })

  it('末尾没换行的整行 JSON 当轮照计;补换行追加后下一轮不重复', async () => {
    const root = home()
    workspaces(join(root, CLI_SESSIONS), { 'wd_w1': '/Users/example/Documents/GitHub/desktop-workbench' })
    const path = wireFile(join(root, CLI_SESSIONS), 'wd_w1', 'session_s1', 'main', [])
    writeFileSync(path, wire('k3-agent', 'turn', 42, 4, 0, 2)) // 没有结尾换行
    const collector = createUsageCollector({ home: root })
    const totals = () => {
      const view = collector.view()
      if ('error' in view) throw new Error(view.error)
      return view.days.find(d => d.date === '2026-09-15')?.by_source.kimi
    }
    await collector.refresh()
    expect(totals()).toEqual({ input: 42, output: 2, cache_read: 4, cache_write: 0 })
    appendFileSync(path, '\n') // 下一行是空行,不得把上一条再算一遍
    await collector.refresh()
    expect(totals()).toEqual({ input: 42, output: 2, cache_read: 4, cache_write: 0 })
  })

  it('wd 还原不了:命令行侧归 (未知),桌面侧归 Kimi 桌面;不猜一个路径', async () => {
    const root = home()
    workspaces(join(root, CLI_SESSIONS), {})
    wireFile(join(root, CLI_SESSIONS), 'wd_nope', 'session_s1', 'main', [
      wire('k3-agent', 'turn', 3, 0, 0, 1),
    ])
    mkdirSync(join(root, DESKTOP_SESSIONS), { recursive: true })
    workspaces(join(root, DESKTOP_SESSIONS), {})
    wireFile(join(root, DESKTOP_SESSIONS), 'wd_nope2', 'conv-c1', 'main', [
      wire('k3-agent', 'turn', 4, 0, 0, 1),
    ])
    const { view } = await refreshed(root)
    const day = view.days.find(d => d.date === '2026-09-15')
    expect(day?.by_project['(未知)']).toEqual({ input: 3, output: 1, cache_read: 0, cache_write: 0 })
    expect(day?.by_project['Kimi 桌面']).toEqual({ input: 4, output: 1, cache_read: 0, cache_write: 0 })
  })

  it('两棵 Kimi 树都不在(没装)时 sources 里压根不放 kimi 键 —— 名册不摆、异常行不提', async () => {
    const root = home()
    const { view } = await refreshed(root)
    expect(view.sources.kimi).toBeUndefined()
    expect(Object.keys(view.sources).sort()).toEqual(['claude', 'codex', 'dsh'])
  })

  it('单份 wire 读不了只让 kimi 标 partial 并计数,其余照常入账', async () => {
    const root = home()
    workspaces(join(root, CLI_SESSIONS), { 'wd_w1': '/Users/example/Documents/GitHub/desktop-workbench' })
    wireFile(join(root, CLI_SESSIONS), 'wd_w1', 'session_s1', 'main', [
      wire('k3-agent', 'turn', 100, 10, 0, 10),
    ])
    const locked = wireFile(join(root, CLI_SESSIONS), 'wd_w1', 'session_s2', 'main', [
      wire('k3-agent', 'turn', 50, 5, 0, 5),
    ])
    chmodSync(locked, 0o000)
    const { view } = await refreshed(root)
    expect(view.sources.kimi?.status).toBe('partial')
    expect(view.sources.kimi?.note).toMatch(/1 份/)
    expect(view.days[0]?.by_source.kimi).toEqual({ input: 100, output: 10, cache_read: 10, cache_write: 0 })
    chmodSync(locked, 0o644)
  })
})

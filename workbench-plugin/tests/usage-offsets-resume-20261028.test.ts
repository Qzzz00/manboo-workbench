/**
 * 8791 热点第五轮(2026-10-28,任务书 `docs/交接-1028-8791热点第五轮-用量采集首轮全量扫描.md`):
 * 已读偏移落盘 + 首轮限速。
 *
 * 原来每个文件的已读偏移只在内存里,DSH(工作台插件)每次重启首轮都把
 * `~/.codex/sessions`(真机 9.5 GB、1189 份)逐份 `indexOf` 全扫一遍找用量标记,
 * 一扫一分多钟满 CPU(第四轮取样:起后 25 秒 `ingestCodexFile` 家族 42%)。
 *
 * 这里钉三件事(全 mkdtemp,不碰真机 ~/.codex / ~/.dsh;读了几字节用 collector 的
 * onRead 探针钉,vi.mock 替 node 内置模块对本仓的具名导入不生效,别走那条路):
 *   用例 1:两份 Codex 扫过后**新建采集器实例(同一账本目录)** → 一个字节不读,
 *      结果与全新扫描逐字一致;文件追加后新实例只读新增字节;截断后整文件重扫;
 *      Claude 与 DSH 两条路同样零重读。
 *   用例 2:账本缺失、30 个文件 → 首轮只扫 20 个(默认上限),第二轮扫剩下的,
 *      第三轮零读取;每轮有字节上限;合计与全新扫描一致。
 *   用例 3:DSH 会话(zstd 多帧)同样续读:没变的会话一个字节不读,追加只重读那一份。
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createUsageCollector, type UsageReadProbe, type UsageScanDiagnostic } from '../src/usage/collector.ts'

const CWD = '/Users/example/Documents/GitHub/desktop-workbench'
const meta = (cwd: string): string => JSON.stringify({ type: 'session_meta', payload: { cwd } })
const turn = (model = 'gpt-5.6'): string => JSON.stringify({ type: 'turn_context', payload: { model } })
const count = (stamp: string, n: number): string => JSON.stringify({
  timestamp: `${stamp}:00Z`,
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, total_token_usage: { input_tokens: 100 * n, cached_input_tokens: 40 * n, output_tokens: 10 * n, total_tokens: 110 * n } } },
})
const claudeCall = (stamp: string, requestId: string): string => JSON.stringify({ timestamp: `${stamp}:00Z`, cwd: CWD, requestId, message: { model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 3 } } })
const dshHeader = (cwd: string): string => JSON.stringify({ type: 'session', version: 0, id: 'session-x', createdAt: 1789468204357, cwd })
const dshMessage = (seq: number, input: number, output: number, id = `m${seq}`): string => JSON.stringify({
  type: 'assistant/message',
  seq,
  time: 1789468206067 + seq,
  data: { turn: 1, step: seq, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, id }, usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: 0, reasoningTokens: 0 } },
})
const frames = (...chunks: string[]): Buffer => Buffer.concat(chunks.map(chunk => zstdCompressSync(Buffer.from(chunk, 'utf8'))))

/** 收集某一实例的读探针,按轮分桶(refresh 之间取一次快照)。 */
function probeCollector(home: string, extra: { onDiagnostic?: (row: UsageScanDiagnostic) => void } = {}) {
  const probes: UsageReadProbe[][] = []
  let current: UsageReadProbe[] = []
  const collector = createUsageCollector({
    home,
    onRead: row => current.push(row),
    ...(extra.onDiagnostic === undefined ? {} : { onDiagnostic: extra.onDiagnostic }),
  })
  return {
    collector,
    /** 从建实例到现在读了几字节(分来源,跨轮合计)。 */
    snapshot(): Record<string, number> {
      const out: Record<string, number> = {}
      for (const row of probes.flat()) out[row.source] = (out[row.source] ?? 0) + row.bytes
      return out
    },
    fileCounts(): Record<string, number> {
      const out: Record<string, number> = {}
      for (const row of probes.flat()) out[row.source] = (out[row.source] ?? 0) + 1
      return out
    },
    async refresh(): Promise<void> {
      current = []
      await collector.refresh()
      probes.push(current)
    },
  }
}

let tmp: string | undefined
afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  tmp = undefined
})

/** 造一份固定形态的家目录:2 份 Codex + 1 份 Claude + 1 份 DSH(2026-10-28 第五轮用例)。 */
function buildHome(): { home: string, codex1: string, codex2: string, claudeFile: string, dshPath: string } {
  tmp = mkdtempSync(join(tmpdir(), 'usage-offsets-'))
  const home = tmp
  const day = join(home, '.codex/sessions/2026/10/28')
  mkdirSync(day, { recursive: true })
  const codex1 = join(day, 'rollout-2026-10-28T10-00-00-11111111-1111-1111-1111-111111111111.jsonl')
  const codex2 = join(day, 'rollout-2026-10-28T11-00-00-22222222-2222-2222-2222-222222222222.jsonl')
  writeFileSync(codex1, `${[meta(CWD), turn(), count('2026-10-28T10:00', 1)].join('\n')}\n`)
  writeFileSync(codex2, `${[meta(CWD), turn(), count('2026-10-28T11:00', 1)].join('\n')}\n`)
  const project = join(home, '.claude/projects/-Users-ben-Documents-GitHub-desktop-workbench')
  mkdirSync(project, { recursive: true })
  const claudeFile = join(project, '33333333-3333-3333-3333-333333333333.jsonl')
  writeFileSync(claudeFile, `${[claudeCall('2026-10-28T10:00', 'r-1'), claudeCall('2026-10-28T10:01', 'r-2')].join('\n')}\n`)
  const dshDir = join(home, '.dsh/sessions/--Users-ben-Documents-GitHub-desktop-workbench--/session-4444')
  mkdirSync(dshDir, { recursive: true })
  const dshPath = join(dshDir, 'session.jsonl.zstd')
  writeFileSync(dshPath, frames(`${dshHeader(CWD)}\n${dshMessage(1, 100, 10)}\n`))
  return { home, codex1, codex2, claudeFile, dshPath }
}

async function daysOf(collector: ReturnType<typeof createUsageCollector>): Promise<string> {
  const view = collector.view()
  if ('error' in view) throw new Error(view.error)
  return JSON.stringify(view.days)
}

function inputOf(daysJson: string, source: string): number {
  const days = JSON.parse(daysJson) as { by_source: Record<string, { input: number }> }[]
  return days.reduce((acc, d) => acc + (d.by_source[source]?.input ?? 0), 0)
}

describe('已读偏移落盘与首轮限速(8791 第五轮)', () => {
  it('用例 1:两份文件扫过后新建实例(同一账本目录)零重读、与全新扫描逐字一致;追加只读新增字节;截断整文件重扫', async () => {
    const { home, codex1, claudeFile } = buildHome()
    const first = probeCollector(home)
    await first.refresh()
    const baseline = await daysOf(first.collector)
    // 基线本身要数对:codex 2×60 + claude 2×7 + dsh 100
    expect(inputOf(baseline, 'codex')).toBe(120)
    expect(inputOf(baseline, 'claude')).toBe(14)
    expect(inputOf(baseline, 'dsh')).toBe(100)

    // 同一账本目录的新实例:三家的日志一个字节都不读,结果与上一实例逐字一致
    const restarted = probeCollector(home)
    await restarted.refresh()
    expect(restarted.snapshot()).toEqual({})
    expect(await daysOf(restarted.collector)).toBe(baseline)

    // 全新扫描对照(同样的文件、没有账本)——逐字一致
    const twin = buildHome()
    const fresh = probeCollector(twin.home)
    await fresh.refresh()
    expect(await daysOf(fresh.collector)).toBe(baseline)

    // 追加:codex 与 claude 各加一条;新实例只读新增的那几字节
    const codexAppend = `${count('2026-10-28T10:02', 2)}\n`
    const claudeAppend = `${claudeCall('2026-10-28T10:02', 'r-3')}\n`
    appendFileSync(codex1, codexAppend)
    appendFileSync(claudeFile, claudeAppend)
    const afterAppend = probeCollector(home)
    await afterAppend.refresh()
    expect(afterAppend.snapshot()).toEqual({ codex: Buffer.byteLength(codexAppend), claude: Buffer.byteLength(claudeAppend) })
    const grown = await daysOf(afterAppend.collector)
    expect(inputOf(grown, 'codex')).toBe(180)
    expect(inputOf(grown, 'claude')).toBe(21)
    expect(inputOf(grown, 'dsh')).toBe(100)

    // 截断:size 小于账本偏移 → 新实例整文件重扫(读到的就是新尺寸那一份)
    truncateSync(codex1, 30)
    const diag: UsageScanDiagnostic[] = []
    const truncated = probeCollector(home, { onDiagnostic: row => diag.push(row) })
    await truncated.refresh()
    expect(truncated.snapshot()).toEqual({ codex: 30 })
    expect(diag[0]?.rewinds).toBe(1)
    expect(statSync(codex1).size).toBe(30)
  }, 30_000)

  it('用例 2:账本缺失、30 个文件 → 首轮只扫 20 个,第二轮扫剩下的,第三轮零读取,每轮有上限', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'usage-budget-'))
    const home = tmp
    const day = join(home, '.codex/sessions/2026/10/28')
    mkdirSync(day, { recursive: true })
    mkdirSync(join(home, '.claude/projects'), { recursive: true })
    const totalBytes: number[] = []
    for (let i = 0; i < 30; i++) {
      // 时刻要合法且唯一:i≥24 的小时数会越界,挪到半小时位上
      const stamp = `2026-10-28T${String(i % 24).padStart(2, '0')}:${String(Math.floor(i / 24) * 30).padStart(2, '0')}`
      const text = `${[meta(CWD), turn(), count(stamp, 1)].join('\n')}\n`
      writeFileSync(join(day, `rollout-2026-10-28T${String(i).padStart(2, '0')}-00-00-${String(i).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl`), text)
      totalBytes.push(Buffer.byteLength(text))
    }
    const diag: UsageScanDiagnostic[] = []
    const rig = probeCollector(home, { onDiagnostic: row => diag.push(row) })

    const durations: number[] = []
    for (let round = 1; round <= 3; round++) {
      const started = performance.now()
      await rig.refresh()
      durations.push(performance.now() - started)
    }
    expect(durations.every(ms => ms < 3000)).toBe(true)
    // 首轮最多 20 份(默认上限),第二轮把剩下 10 份扫完,第三轮零读取
    expect(rig.fileCounts()).toEqual({ codex: 30 })
    expect(diag.map(row => row.changed)).toEqual([20, 10, 0])
    expect(diag.map(row => row.bytes)).toEqual([
      totalBytes.slice(0, 20).reduce((a, b) => a + b, 0),
      totalBytes.slice(20).reduce((a, b) => a + b, 0),
      0,
    ])
    expect(diag[0]?.bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(diag[1]?.bytes).toBeLessThanOrEqual(64 * 1024 * 1024)

    // 合计与全新扫描一致(30 × 60 input)
    expect(inputOf(await daysOf(rig.collector), 'codex')).toBe(30 * 60)
  }, 30_000)

  it('用例 2b:字节上限同样生效(3 份 30MB、上限 64MB → 2 份 + 1 份)', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'usage-budget-bytes-'))
    const home = tmp
    const day = join(home, '.codex/sessions/2026/10/28')
    mkdirSync(day, { recursive: true })
    mkdirSync(join(home, '.claude/projects'), { recursive: true })
    const filler = 'A'.repeat(30 * 1024 * 1024)
    for (let i = 0; i < 3; i++) {
      const bigLine = JSON.stringify({ timestamp: '2026-10-28T10:00:00Z', type: 'response_item', payload: { type: 'function_call_output', output: filler } })
      writeFileSync(join(day, `rollout-2026-10-28T1${i}-00-00-${String(i).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl`), `${[meta(CWD), turn(), count('2026-10-28T10:00', 1), bigLine].join('\n')}\n`)
    }
    const diag: UsageScanDiagnostic[] = []
    const rig = probeCollector(home, { onDiagnostic: row => diag.push(row) })
    await rig.refresh()
    await rig.refresh()
    expect(diag.map(row => row.changed)).toEqual([2, 1])
    expect(diag[0]?.bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(inputOf(await daysOf(rig.collector), 'codex')).toBe(3 * 60)
  }, 60_000)

  it('用例 3:DSH 会话(zstd 多帧)同样续读:没变的零重读,追加只重读那一份', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'usage-dsh-resume-'))
    const home = tmp
    mkdirSync(join(home, '.claude/projects'), { recursive: true })
    mkdirSync(join(home, '.codex/sessions'), { recursive: true })
    const dirA = join(home, '.dsh/sessions/--Users-ben-Documents-GitHub-desktop-workbench--/session-aaaa')
    const dirB = join(home, '.dsh/sessions/--Users-ben-Documents-GitHub-DouDou--/session-bbbb')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    const pathA = join(dirA, 'session.jsonl.zstd')
    const pathB = join(dirB, 'session.jsonl.zstd')
    writeFileSync(pathA, frames(`${dshHeader(CWD)}\n${dshMessage(1, 100, 10)}\n`))
    writeFileSync(pathB, frames(`${dshHeader('/Users/example/Documents/GitHub/DouDou')}\n${dshMessage(1, 50, 5)}\n`))

    const first = probeCollector(home)
    await first.refresh()
    const baseline = await daysOf(first.collector)

    const restarted = probeCollector(home)
    await restarted.refresh()
    expect(restarted.snapshot()).toEqual({})
    expect(await daysOf(restarted.collector)).toBe(baseline)

    // 只追加 session-aaaa:新实例整份重解析这一份(dsh 按 message.id 去重,不重复计入),
    // session-bbbb 一个字节不读
    appendFileSync(pathA, frames(`${dshMessage(2, 200, 20)}\n`))
    const after = probeCollector(home)
    await after.refresh()
    expect(after.snapshot()).toEqual({ dsh: statSync(pathA).size })
    const grown = await daysOf(after.collector)
    expect(inputOf(grown, 'dsh')).toBe(350)
    expect(JSON.parse(grown).reduce((acc: number, d: { by_source: Record<string, { output: number }> }) => acc + (d.by_source.dsh?.output ?? 0), 0)).toBe(35)
  }, 30_000)
})

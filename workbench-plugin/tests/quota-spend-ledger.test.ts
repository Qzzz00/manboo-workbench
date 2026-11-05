// @vitest-environment node
/**
 * 今日消耗账本的落盘(2026-09-09)。
 *
 * 为什么要有:日结在早 9 点生成**昨天**的报告,而账本只活在采集循环的内存里、跨天即清零,
 * 中途重启更是一了百了——不落盘的话"昨天的 DeepSeek 花在高峰还是低谷"永远拿不到,
 * 日结那两笔只能空着。落盘之后才有得报;仍然拿不到时按纪律留空,绝不编数。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { trackDailySpend } from '../src/quota/dailySpend.ts'
import { createSpendLedger, defaultSpendLedgerFile } from '../src/quota/spendLedger.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-spend-'))
  dirs.push(dir)
  return join(dir, 'spend.json')
}

/** 造一份"当天采过两次"的账本:总 8.40,其中高峰 8.40。 */
function twoReadings(day: string) {
  let state = trackDailySpend(undefined, '218.40', day, 'peak')
  state = trackDailySpend(state, '210.00', day, 'peak')
  return state
}

describe('消耗账本落盘', () => {
  it('落在 ~/.dsh/workbench/spend.json', () => {
    expect(defaultSpendLedgerFile('/Users/example')).toBe('/Users/example/.dsh/workbench/spend.json')
  })

  it('记一天再读回来:总数与两笔都在', async () => {
    const file = tempFile()
    const first = createSpendLedger({ file })
    await first.load()
    first.record(twoReadings('2026-09-08'))
    await first.flush()

    const second = createSpendLedger({ file })
    await second.load()
    expect(second.get('2026-09-08')).toEqual({ spent: '8.40', peak: '8.40' })
  })

  it('没记过的那天回 undefined——日结据此留空,不编数', async () => {
    const svc = createSpendLedger({ file: tempFile() })
    await svc.load()
    expect(svc.get('2026-09-08')).toBeUndefined()
  })

  it('重启后当天的账本能接着记:基线与已累计的数都不丢', async () => {
    const file = tempFile()
    const before = createSpendLedger({ file })
    await before.load()
    before.record(twoReadings('2026-09-09'))
    await before.flush()

    const after = createSpendLedger({ file })
    await after.load()
    const resumed = after.resume('2026-09-09')
    expect(resumed?.spent).toBe('8.40')
    // 接着来一次读数:从 210.00 继续减,而不是重新建基线。
    const next = trackDailySpend(resumed, '208.00', '2026-09-09', 'offpeak')
    expect(next.spent).toBe('10.40')
    expect(next.offpeak).toBe('2.00')
  })

  it('昨天的账本不给今天当基线——跨天必须重新建线', async () => {
    const file = tempFile()
    const svc = createSpendLedger({ file })
    await svc.load()
    svc.record(twoReadings('2026-09-08'))
    expect(svc.resume('2026-09-09')).toBeUndefined()
  })

  it('只留最近 7 天,不让文件无限长', async () => {
    const file = tempFile()
    const svc = createSpendLedger({ file, keepDays: 3 })
    await svc.load()
    for (const day of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) {
      svc.record(twoReadings(day))
    }
    await svc.flush()

    const reread = createSpendLedger({ file, keepDays: 3 })
    await reread.load()
    expect(reread.get('2026-09-01')).toBeUndefined()
    expect(reread.get('2026-09-04')).toBeDefined()
  })

  it('文件写坏了按空账本兜底,不拦采集', async () => {
    const file = tempFile()
    writeFileSync(file, 'not json', 'utf8')
    const svc = createSpendLedger({ file })
    await svc.load()
    expect(svc.get('2026-09-08')).toBeUndefined()
    svc.record(twoReadings('2026-09-08'))
    await svc.flush()
    expect(svc.get('2026-09-08')?.spent).toBe('8.40')
  })

  it('还报不出数的账本(当天第一次读数)不落盘——不写 0,也不留一条空记录', async () => {
    const file = tempFile()
    const svc = createSpendLedger({ file })
    await svc.load()
    svc.record(trackDailySpend(undefined, '218.40', '2026-09-09', 'peak'))
    await svc.flush()
    expect(svc.get('2026-09-09')).toBeUndefined()
  })
})

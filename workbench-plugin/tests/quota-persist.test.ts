// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentId, QuotaEntry } from '../src/protocol.ts'
import { forgetLastQuota, loadLastQuota, saveLastQuota } from '../src/quota/persist.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-quota-'))
  dirs.push(dir)
  return join(dir, 'nested', 'last-quota.json')
}

const claude: QuotaEntry = {
  kind: 'quota',
  windows: [{ label: '5h', left_pct: 76.5, reset_at: '2026-08-20T10:00:00.000Z' }],
  // 2026-10-02(卡 QA):落盘那一份**必须带截至时刻** —— 没有它,重启顶回界面的数就没有年纪了,
  // 载入那一侧会直接丢掉它(`loadLastQuota`,见 tests/quota-as-of.test.ts)。
  as_of: '2026-08-20T05:30:00.000Z',
}

describe('最后已知额度落盘', () => {
  it('存下来能读回——DSH 重启不该把 Claude 那格清零', async () => {
    const file = tempFile()

    await saveLastQuota(file, { claude } as Partial<Record<AgentId, QuotaEntry>>)

    expect((await loadLastQuota(file)).claude).toEqual(claude)
  })

  it('只存推送型的那些。拉取型的下一轮就重采，存了反而可能盖住新值', async () => {
    const file = tempFile()

    await saveLastQuota(file, {
      claude,
      dsh: { kind: 'balance', currency: 'CNY', total: '9.51', available: true },
    } as Partial<Record<AgentId, QuotaEntry>>)

    const back = await loadLastQuota(file)
    expect(back.claude).toEqual(claude)
    expect(back.dsh).toBeUndefined()
  })

  it('文件不存在时返回空，不抛——第一次跑本来就没有', async () => {
    expect(await loadLastQuota(tempFile())).toEqual({})
  })

  it('文件写坏了返回空而不是把服务带崩', async () => {
    const file = tempFile()
    await saveLastQuota(file, { claude } as Partial<Record<AgentId, QuotaEntry>>)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ 半行坏 JSON')

    expect(await loadLastQuota(file)).toEqual({})
  })

  it('unknown 不落盘——"未接入"没有保存价值，还会盖掉重启后的正确初始说明', async () => {
    const file = tempFile()

    await saveLastQuota(file, { claude: { kind: 'unknown', note: '等上报' } } as Partial<Record<AgentId, QuotaEntry>>)

    expect(await loadLastQuota(file)).toEqual({})
  })
})

/**
 * 凭据被清空那一刻,落盘那份里同一家的记录也要一起没(2026-09-18)。
 *
 * 不然重启之后它又被 `loadLastQuota` 顶上来 —— 那正是「凭据都删了,余额还在」
 * 最难查的一种变体:界面上的数字来自一个已经不存在的文件里的一把已经不存在的 Key。
 */
describe('作废某一家的落盘记录', () => {
  it('删掉指定那一家,文件里就不再有它', async () => {
    const file = tempFile()
    await saveLastQuota(file, { claude } as Partial<Record<AgentId, QuotaEntry>>)

    await forgetLastQuota(file, 'claude')

    expect(await loadLastQuota(file)).toEqual({})
  })

  it('文件本来就不在 → 什么都不做,也不抛(第一次用本来就没有这个文件)', async () => {
    await expect(forgetLastQuota(tempFile(), 'dsh')).resolves.toBeUndefined()
  })
})

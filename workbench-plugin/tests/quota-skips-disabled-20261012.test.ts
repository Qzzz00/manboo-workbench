// @vitest-environment node
/**
 * 她从窗口槽清单里删掉的那几家,额度这一路也不碰(2026-10-12,卡 `claude/ops-patch-1012`;运营同学 10-09「停用 Muse 自动弹窗」那一条)。
 *
 * 他查到的根因:Muse 已在 `apps.json.disabled` 里,窗口槽、派活清单都不列它了,可额度采集器有自己的 `windowSpecs` 登记表,
 * 数一过线就 `open -g -b com.meta.endo` 把 Muse 后台拉起来 —— 她退掉的 App 每隔一阵又自己回来。
 * 他在产物上的修法是把 Muse 从登记表里删掉;源码里的正解是**采集器认 apps.json 的禁用表**:删掉哪一家都一样,不写死 Muse。
 *
 * 钉三件事:① 禁用的那一家一条 read_texts 都不发、一次 open 都不跑、格子一个字不改;② 没禁用的照读;③ 禁用表问不出来当一家都没删。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { WindowQuotaSpec } from '../src/server/agentQuota.ts'
import { createWindowQuotaReader, forgetQuotaMemory } from '../src/server/agentQuota.ts'

const NOW = new Date('2026-10-12T06:00:00Z')

function spec(id: string, bundleId: string): WindowQuotaSpec {
  return {
    bundleId,
    patterns: [{ id: 'used', regex: '^剩 [0-9]+%$' }],
    parse: last => (last.matches.some(one => one.id === 'used')
      ? { id, title: id, state: 'numbers', line: '还剩约 62%', left_pct: 62, read_at: last.at }
      : undefined),
  }
}

function world(input: { disabled?: () => Promise<ReadonlySet<string>>, running?: readonly string[] }) {
  const sent: { op: string, bundle_id?: string }[] = []
  const ran: (readonly string[])[] = []
  const logs: string[] = []
  const specs = new Map([['muse', spec('muse', 'com.example.muse')], ['doubao', spec('doubao', 'com.example.doubao')]])
  const reader = createWindowQuotaReader({
    request: async (req) => {
      sent.push(req as never)
      const op = (req as { op: string }).op
      if (op === 'running_apps') return { ok: true, result: { apps: (input.running ?? ['com.example.muse', 'com.example.doubao']).map(bundle_id => ({ bundle_id, hidden: true })) } }
      if (op === 'read_texts') return { ok: true, result: { matches: [{ id: 'used', text: '剩 62%', x: 10, y: 10, window: 0 }], windows: [{ index: 0, w: 1200 }], window_count: 1, text_nodes: 1 } }
      return { ok: true, result: {} }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true }),
    now: () => NOW,
    wait: async () => {},
    runCommand: async (cmd) => { ran.push(cmd); return { ok: true } },
    log: line => { logs.push(line) },
    specs,
    ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
  })
  return { reader, sent, ran, logs }
}

beforeEach(() => { forgetQuotaMemory() })

describe('额度采集认 apps.json 的禁用表', () => {
  it('★Muse 在禁用表里 → 不读它、不起它、格子不写;豆包照读', async () => {
    const w = world({ disabled: async () => new Set(['muse']), running: ['com.example.doubao'] })
    await w.reader.refresh()
    const reads = w.sent.filter(one => one.op === 'read_texts')
    expect(reads.map(one => one.bundle_id)).toEqual(['com.example.doubao'])
    // Muse 没在跑、数又从没读到过 —— 原来这一下会 `open -g -b` 把它拉起来;现在一次都不跑。
    expect(w.ran.some(cmd => cmd.includes('com.example.muse'))).toBe(false)
    expect(w.reader.readings().muse).toBeUndefined()
    expect(w.reader.readings().doubao?.attempt?.found).toBe(true)
    expect(w.logs.join('\n')).toContain('muse')
  })

  it('没禁用 → 两家都读(行为与原来一字不差)', async () => {
    const w = world({ disabled: async () => new Set() })
    await w.reader.refresh()
    expect(w.sent.filter(one => one.op === 'read_texts').map(one => one.bundle_id).sort()).toEqual(['com.example.doubao', 'com.example.muse'])
  })

  it('禁用表问不出来 / 没接 → 当一家都没删', async () => {
    const broken = world({ disabled: async () => { throw new Error('apps.json 读不了') } })
    await broken.reader.refresh()
    expect(broken.sent.filter(one => one.op === 'read_texts')).toHaveLength(2)
    const none = world({})
    await none.reader.refresh()
    expect(none.sent.filter(one => one.op === 'read_texts')).toHaveLength(2)
  })
})

/**
 * 读到过的窗口额度要熬过重启(2026-09-26,维护者:「刚才有一个版本 Muse 是能读取到额度的了,但是更新之后又不行了」)。
 * 每装一次插件服务就重启一次;原来读数只在内存里,重启后那一格翻回「没接上」。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWindowQuotaReader, quotaFor, windowQuotaFileStore } from '../src/server/agentQuota.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const MUSE_PAGE = [
  { id: 'page', text: '使用情况', x: 400, y: 100 },
  { id: 'used', text: '3% used', x: 900, y: 180 },
]

function reader(file: string, matches: typeof MUSE_PAGE) {
  return createWindowQuotaReader({
    request: async (req) => (req.op === 'read_texts' && req.bundle_id === 'com.meta.endo' ? { ok: true, result: { matches } } : { ok: true, result: { matches: [] } }),
    helper: () => ({ connected: true, authorized: true, readTexts: true }),
    wait: async () => {},
    store: windowQuotaFileStore(file),
  })
}

describe('窗口额度读数落盘', () => {
  it('★读到过 → 重启(新建一份读取器)后那一格仍是有数,带几点读到的', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wq-')); dirs.push(dir)
    const file = join(dir, 'window-quota.json')
    const first = reader(file, MUSE_PAGE)
    await first.refresh(['muse'])
    expect(quotaFor('muse', { quota: {}, now: new Date(), window: first.readings() } as never)).toMatchObject({ state: 'numbers', left_pct: 97 })

    // 重启:新的一份,这会儿 Muse 不在那一页(读不到),上次那个数照样顶着。
    const second = reader(file, [])
    expect(quotaFor('muse', { quota: {}, now: new Date(), window: second.readings() } as never)).toMatchObject({ state: 'numbers', left_pct: 97 })
    await second.refresh(['muse'])
    expect(quotaFor('muse', { quota: {}, now: new Date(), window: second.readings() } as never)).toMatchObject({ state: 'numbers', left_pct: 97 })
  })

  it('落盘的只有命中的小段与时刻;文件坏了当没有', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wq-')); dirs.push(dir)
    const file = join(dir, 'window-quota.json')
    await reader(file, MUSE_PAGE).refresh(['muse'])
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.version).toBe(1)
    expect(saved.lasts.muse.matches.map((m: { text: string }) => m.text)).toEqual(['使用情况', '3% used'])
    expect(windowQuotaFileStore(join(dir, 'nope.json')).load()).toBeUndefined()
  })
})

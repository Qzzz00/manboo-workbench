// @vitest-environment node
/**
 * 手机交代一次、电脑只办一次(2026-10-12,卡「手机交代只执行一次」):请求号台账本身。
 * 同一台设备、同一条路、同一个号 —— 第二次回第一次的结果;第一次还在办时第二次等它;
 * 第一次没办成(5xx / 断了没回)就不记,下一次照常办。台账落盘,电脑重启也认得。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clientKeyOf, createClientKeyLedger, CLIENT_KEY_KEEP } from '../src/server/clientKeys.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-client-keys-'))
  dirs.push(dir)
  return join(dir, 'client-keys.json')
}

describe('clientKeyOf', () => {
  it('只认 body 里非空的 client_key 字符串,截到 100 字', () => {
    expect(clientKeyOf('{"text":"a","client_key":" k-1 "}')).toBe('k-1')
    expect(clientKeyOf(`{"client_key":"${'x'.repeat(300)}"}`)).toHaveLength(100)
    expect(clientKeyOf('{"client_key":""}')).toBeUndefined()
    expect(clientKeyOf('{"client_key":3}')).toBeUndefined()
    expect(clientKeyOf('不是 JSON')).toBeUndefined()
    expect(clientKeyOf('')).toBeUndefined()
  })
})

describe('请求号台账', () => {
  it('第一次 fresh;办完之后同一个号回第一次的结果', async () => {
    const ledger = createClientKeyLedger({ file: file() })
    const first = await ledger.begin('dev-1 /butler/item', 'k-1')
    expect(first.kind).toBe('fresh')
    if (first.kind !== 'fresh') return
    first.finish(200, '{"ok":true,"id":"t-1"}')
    const second = await ledger.begin('dev-1 /butler/item', 'k-1')
    expect(second).toEqual({ kind: 'replay', status: 200, body: '{"ok":true,"id":"t-1"}' })
  })

  it('换一台设备、换一条路、换一个号都不算同一条', async () => {
    const ledger = createClientKeyLedger({ file: file() })
    const first = await ledger.begin('dev-1 /butler/item', 'k-1')
    if (first.kind === 'fresh') first.finish(200, '{}')
    expect((await ledger.begin('dev-2 /butler/item', 'k-1')).kind).toBe('fresh')
    expect((await ledger.begin('dev-1 /sessions/relay', 'k-1')).kind).toBe('fresh')
    expect((await ledger.begin('dev-1 /butler/item', 'k-2')).kind).toBe('fresh')
  })

  it('第一次还在办,第二次等它办完、回同一个结果(直连与房间同时到的那种)', async () => {
    const ledger = createClientKeyLedger({ file: file() })
    const first = await ledger.begin('dev-1 /butler/item', 'k-1')
    const secondP = ledger.begin('dev-1 /butler/item', 'k-1')
    if (first.kind === 'fresh') first.finish(200, '{"id":"t-1"}')
    expect(await secondP).toEqual({ kind: 'replay', status: 200, body: '{"id":"t-1"}' })
  })

  it('第一次 5xx:不记,第二次照常办(明示失败=真没办成,语义不变)', async () => {
    const ledger = createClientKeyLedger({ file: file() })
    const again = await ledger.begin('s', 'k-2')
    if (again.kind === 'fresh') again.finish(500, '{"error":"x"}')
    expect((await ledger.begin('s', 'k-2')).kind).toBe('fresh')
  })

  it('4xx 也记(第一次就是这么答的,换个时候再问还是这句)', async () => {
    const ledger = createClientKeyLedger({ file: file() })
    const first = await ledger.begin('s', 'k-1')
    if (first.kind === 'fresh') first.finish(400, '{"error":"事项内容不能为空"}')
    expect(await ledger.begin('s', 'k-1')).toEqual({ kind: 'replay', status: 400, body: '{"error":"事项内容不能为空"}' })
  })

  it('落盘:换一份台账(电脑重启)也认得', async () => {
    const path = file()
    const a = createClientKeyLedger({ file: path })
    const first = await a.begin('s', 'k-1')
    if (first.kind === 'fresh') first.finish(200, '{"id":"t-1"}')
    await a.flush()
    const b = createClientKeyLedger({ file: path })
    expect(await b.begin('s', 'k-1')).toEqual({ kind: 'replay', status: 200, body: '{"id":"t-1"}' })
  })

  it(`只留最近 ${CLIENT_KEY_KEEP} 条;超过保留期的也忘掉`, async () => {
    let now = 1_000_000
    const ledger = createClientKeyLedger({ file: file(), now: () => now, keepMs: 1000 })
    for (let i = 0; i < CLIENT_KEY_KEEP + 5; i += 1) {
      const got = await ledger.begin('s', `k-${i}`)
      if (got.kind === 'fresh') got.finish(200, '{}')
    }
    expect((await ledger.begin('s', 'k-0')).kind).toBe('fresh')
    expect((await ledger.begin('s', `k-${CLIENT_KEY_KEEP + 4}`)).kind).toBe('replay')
    now += 2000
    expect((await ledger.begin('s', `k-${CLIENT_KEY_KEEP + 4}`)).kind).toBe('fresh')
  })
})

describe('断开宽限释放(2026-10-24 运输去重,独审 Major):abort 不等于没办', () => {
  it('★断线后 handler 仍办到底:同号在宽限内等第一次办完、拿同一回放;不是 fresh 双执行', async () => {
    const ledger = createClientKeyLedger({ file: file(), abortReleaseMs: 60_000 })
    const first = await ledger.begin('s', 'k-1')
    const waiting = ledger.begin('s', 'k-1')
    let waitingResolved: string | 'pending' = 'pending'
    void waiting.then(w => { waitingResolved = w.kind })
    if (first.kind === 'fresh') first.abort()          // 客户端 3 秒断开
    await new Promise(r => setTimeout(r, 20))
    expect(waitingResolved, '宽限内:等着,不许放成 fresh').toBe('pending')
    if (first.kind === 'fresh') first.finish(200, '{"id":"t-1"}')   // handler 照办到底,回包照记
    expect(await waiting).toEqual({ kind: 'replay', status: 200, body: '{"id":"t-1"}' })
  })

  it('★V2:宽限到期原 handler 仍未完结 → 不放 fresh 赌它死了;同号拿 409「还在办」(内存态,重启即失)', async () => {
    const ledger = createClientKeyLedger({ file: file(), abortReleaseMs: 30 })
    const first = await ledger.begin('s', 'k-1')
    const waiting = ledger.begin('s', 'k-1')
    if (first.kind === 'fresh') first.abort()
    const got = await waiting
    expect(got.kind).toBe('replay')
    expect(got.kind === 'replay' && got.status).toBe(409)
    // 后续同号也拿同一句 409,不放 fresh 二次执行。
    const again = await ledger.begin('s', 'k-1')
    expect(again.kind).toBe('replay')
    expect(again.kind === 'replay' && again.status).toBe(409)
  })
})

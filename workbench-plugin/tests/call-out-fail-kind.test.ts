// @vitest-environment node
/**
 * 来电台账里的 `failed` 拆开(2026-10-12,卡「没办完的事项说清楚」第 3 条;运营同学 10-12:200 条里 28 条 `failed`,
 * 混着她停铃、她已经答了无需再打)。`failed` 这一状态照旧(老手机 / 老工人认得),另记一格 `fail_kind`:
 * 技术失败 / 她停了铃 / 已无需再打 / 不明。**统计与界面只把技术失败算作失败。**
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallOutEntry, WorkbenchState } from '../src/protocol.ts'
import { CALL_OUT_FAIL_KIND_TITLES, callOutFailKindOf, isCallOutTechFailure } from '../src/protocol.ts'
import { callOutLine } from '../src/client/callOutLine.ts'
import {
  CALL_OUT_MOOT_ASK_ERROR,
  CALL_OUT_RING_STALE_MS,
  CALL_OUT_STOP_RING_ERROR,
  CALL_OUT_WORKER_SILENT_ERROR,
  createCallOutService,
  loadCallOutFile,
} from '../src/server/callOut.ts'

const dirs: string[] = []
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-call-fail-kind-'))
  dirs.push(dir)
  return join(dir, 'call-out.json')
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function entry(patch: Partial<CallOutEntry> = {}): CallOutEntry {
  return { id: 'c1', reason: 'ask', item_id: 'a', title: '甲', at: '', state: 'failed', silent: false, queued_at: '2026-10-10T06:00:00.000Z', due_at: '', ended_at: '2026-10-10T06:01:00.000Z', ...patch }
}

describe('按证据认是哪一种', () => {
  it('台账里那几句原话各认一种;认不出的标「不明」;不是 failed 的不给', () => {
    expect(callOutFailKindOf(entry({ error: CALL_OUT_MOOT_ASK_ERROR }))).toBe('moot')
    expect(callOutFailKindOf(entry({ error: CALL_OUT_STOP_RING_ERROR }))).toBe('declined')
    expect(callOutFailKindOf(entry({ error: CALL_OUT_WORKER_SILENT_ERROR }))).toBe('tech')
    expect(callOutFailKindOf(entry({ error: '和房间断开了,这一通没打成' }))).toBe('tech')
    expect(callOutFailKindOf(entry({ error: '工人要退出了,这一通没打成' }))).toBe('tech')
    expect(callOutFailKindOf(entry({ error: '这一通取消了' }))).toBe('tech')
    expect(callOutFailKindOf(entry({ error: '谁也不知道' }))).toBe('unknown')
    expect(callOutFailKindOf(entry({}))).toBe('unknown')
    expect(callOutFailKindOf(entry({ state: 'missed', error: CALL_OUT_STOP_RING_ERROR }))).toBeUndefined()
    // 写下时就记了的,以记的为准。
    expect(callOutFailKindOf(entry({ error: '谁也不知道', fail_kind: 'tech' }))).toBe('tech')
  })

  it('只有技术失败算失败', () => {
    expect(isCallOutTechFailure(entry({ fail_kind: 'tech' }))).toBe(true)
    for (const kind of ['declined', 'moot', 'unknown'] as const) expect(isCallOutTechFailure(entry({ fail_kind: kind }))).toBe(false)
    expect(isCallOutTechFailure(entry({ state: 'missed' }))).toBe(false)
  })
})

describe('老台账:读回来时按证据补上', () => {
  it('能认的补上那一种,认不出的标「不明」;别的状态不带这一格', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({
      version: 1,
      seen: [],
      log: [
        entry({ id: 'm', error: CALL_OUT_MOOT_ASK_ERROR }),
        entry({ id: 's', error: CALL_OUT_STOP_RING_ERROR }),
        entry({ id: 'w', error: '和房间断开了,这一通没打成' }),
        entry({ id: 'u', error: '' }),
        { ...entry({ id: 'x', state: 'answered' }), fail_kind: 'tech' },
        { ...entry({ id: 'bad', error: CALL_OUT_MOOT_ASK_ERROR }), fail_kind: '乱写的' },
      ],
    }))
    const loaded = await loadCallOutFile(file)
    const kinds = Object.fromEntries(loaded.log.map(one => [one.id, one.fail_kind]))
    expect(kinds).toEqual({ m: 'moot', s: 'declined', w: 'tech', u: 'unknown', x: undefined, bad: 'moot' })
  })
})

describe('写的时候就记上', () => {
  it('她答了撤掉的 → 已无需再打;工人领了没回话的通知 → 技术失败;工人回的 failed 按它说的', async () => {
    let clock = Date.parse('2026-10-12T10:00:00+08:00')
    const service = createCallOutService({ file: tmpFile(), now: () => clock })
    await service.load()
    await service.request({ reason: 'ask', item_id: 'a', title: '甲' })
    await service.drop({ reason: 'ask', item_id: 'a' })
    expect(service.view().entries[0]).toMatchObject({ state: 'failed', fail_kind: 'moot' })

    await service.request({ reason: 'failed', item_id: 'b', title: '乙' })
    const [ringing] = await service.claim()
    await service.ack({ id: ringing!.id, result: 'failed', error: '和房间断开了,这一通没打成', fail_kind: 'tech' })
    expect(service.view().entries.find(one => one.id === ringing!.id)).toMatchObject({ fail_kind: 'tech' })

    await service.request({ reason: 'failed', item_id: 'c', title: '丙' })
    const [stopped] = await service.claim()
    await service.ack({ id: stopped!.id, result: 'failed', error: CALL_OUT_STOP_RING_ERROR })
    expect(service.view().entries.find(one => one.id === stopped!.id)).toMatchObject({ fail_kind: 'declined' })

    // 接了的那一通不带这一格。
    await service.request({ reason: 'failed', item_id: 'd', title: '丁' })
    const [answered] = await service.claim()
    await service.ack({ id: answered!.id, result: 'answered', fail_kind: 'tech' })
    expect(service.view().entries.find(one => one.id === answered!.id)?.fail_kind).toBeUndefined()

    // 只发通知的那一条,工人领了没回话。
    clock = Date.parse('2026-10-12T23:30:00+08:00')
    await service.request({ reason: 'failed', item_id: 'e', title: '戊' })
    const [silent] = await service.claim()
    expect(silent?.silent).toBe(true)
    clock += CALL_OUT_RING_STALE_MS + 1000
    await service.pump()
    expect(service.view().entries.find(one => one.id === silent!.id)).toMatchObject({ state: 'failed', fail_kind: 'tech', error: CALL_OUT_WORKER_SILENT_ERROR })
  })
})

describe('界面那一行', () => {
  const stateWith = (entries: CallOutEntry[]) => ({ call_out: { config: {}, entries, missed: 0 } }) as unknown as WorkbenchState
  it('技术失败才说「没打出去」;她停了铃 / 已无需再打 / 不明各说各的,都不说「打过电话」', () => {
    expect(callOutLine(stateWith([entry({ fail_kind: 'tech' })]), 'a')).toContain('没打出去')
    for (const kind of ['declined', 'moot', 'unknown'] as const) {
      const text = callOutLine(stateWith([entry({ fail_kind: kind })]), 'a') ?? ''
      expect(text).toContain(CALL_OUT_FAIL_KIND_TITLES[kind])
      expect(text).not.toContain('打过电话')
      expect(text).not.toContain('没打出去')
    }
  })
})

describe('接缝:电话工人那一侧', () => {
  it('★工人取消那一通时报的是技术失败,原话与这边认的对得上(读源文件比对)', () => {
    // 取消那一通的回执(`failed` + `fail_kind: 'tech'`)自 M6 起在 twoRooms.ts 的 ackOf 里拼;原话仍在 agent.ts。
    const twoRooms = readFileSync(resolve(process.cwd(), '../channel-worker/src/twoRooms.ts'), 'utf8')
    expect(twoRooms).toContain("fail_kind: 'tech'")
    const agent = readFileSync(resolve(process.cwd(), '../channel-worker/src/agent.ts'), 'utf8')
    for (const text of ['和房间断开了,这一通没打成', '工人要退出了,这一通没打成']) expect(agent).toContain(text)
    const worker = readFileSync(resolve(process.cwd(), '../channel-worker/src/callOut.ts'), 'utf8')
    expect(worker).toContain("'这一通取消了'")
    const client = readFileSync(resolve(process.cwd(), '../channel-worker/src/workbench.ts'), 'utf8')
    expect(client).toContain("fail_kind?: 'tech'")
  })
})

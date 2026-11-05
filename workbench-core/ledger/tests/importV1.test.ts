import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importFromJobsJsonl, importFromTasksJson, openLedger, type Ledger } from '../index.ts'
import { tmpDb } from './helpers.ts'

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url))
const IMPORTER = { device: 'mac-a', person: 'alice' }
const T2 = '8f0c2a7e-0000-4000-8000-000000000002'
const T3 = '8f0c2a7e-0000-4000-8000-000000000003'

let ledger: Ledger
let dir: string
let cleanup: () => void

beforeEach(() => {
  const db = tmpDb()
  dir = db.dir
  cleanup = db.cleanup
  ledger = openLedger(db.path, { origin: 'mac-a' })
})
afterEach(() => {
  ledger.close()
  cleanup()
})

function copyFixture(name: string): { path: string; bytes: string; mtimeMs: number } {
  const path = join(dir, name)
  copyFileSync(join(FIX, name), path)
  return { path, bytes: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs }
}

describe('importFromTasksJson(只做形状映射)', () => {
  it('每张卡一个对象(legacy_id = 原 id),dispatch / client_dispatch 各成一条委派;原文件不动', () => {
    const src = copyFixture('tasks.v2.json')
    const out = importFromTasksJson(ledger, src.path, { owner: 'alice', actor: IMPORTER })
    expect(out).toEqual({ objects_created: 3, deliveries_created: 3, skipped: 0 })
    expect(readFileSync(src.path, 'utf8')).toBe(src.bytes)
    expect(statSync(src.path).mtimeMs).toBe(src.mtimeMs)

    // 对得上的口径:对象数 = 卡数
    expect(ledger.stats()).toMatchObject({ objects: 3, deliveries: 3 })

    const t2 = ledger.objects.byLegacyId(T2)
    expect(t2).toMatchObject({ owner: 'alice', owner_epoch: 1, status: 'doing', legacy_id: T2 })
    expect(t2?.data).toMatchObject({ title: '修登录页', project_id: 'p-app', assignee: 'codex', created_at: '2026-10-19T07:55:00.000Z' })
    expect(t2?.data).not.toHaveProperty('id')
    // v1 的卡原样留在 data(下一张卡「投影回 v1 文件」要用),委派视图是它的路由投影
    const original = JSON.parse(src.bytes).tasks[1]
    expect(t2?.data.dispatch).toEqual(original.dispatch)
    const created = ledger.objectEvents(t2?.object_id as string)[0]
    expect(created?.ts).toBe(Date.parse('2026-10-19T07:55:00.000Z'))

    const d2 = ledger.deliveries.ofObject(t2?.object_id as string)
    expect(d2).toHaveLength(1)
    expect(d2[0]).toMatchObject({ n: 1, family: 'codex', channel: 'cli', status: 'running', attempt_id: 1, target: { family: 'codex', session_id: 'thr-1' } })

    const t3 = ledger.objects.byLegacyId(T3)
    const d3 = ledger.deliveries.ofObject(t3?.object_id as string)
    expect(d3.map((d) => [d.n, d.family, d.channel, d.status])).toEqual([
      [1, 'claude', 'api', 'done'],
      [2, 'claude', 'window', 'replied'],
    ])
    expect(d3[1]?.target).toEqual({ family: 'claude', session_id: 'sess-9', turn_id: 'turn-3' })
    // 委派视图只放路由,她的原话与回话不进委派
    for (const d of d3) {
      expect(JSON.stringify(d.data)).not.toContain('片头要不要换')
      expect(JSON.stringify(d.data)).not.toContain('建议换')
    }
  })

  it('再导一次:按 legacy_id 跳过,一条事件都不多写;也接受已解析的对象', () => {
    const src = copyFixture('tasks.v2.json')
    importFromTasksJson(ledger, src.path, { owner: 'alice', actor: IMPORTER })
    const seq = ledger.maxSeq()
    const parsed = JSON.parse(readFileSync(src.path, 'utf8'))
    expect(importFromTasksJson(ledger, parsed, { owner: 'alice', actor: IMPORTER })).toEqual({ objects_created: 0, deliveries_created: 0, skipped: 3 })
    expect(ledger.maxSeq()).toBe(seq)
  })

  it('形状不对就抛,不当空看板', () => {
    expect(() => importFromTasksJson(ledger, { version: 2 } as never, { owner: 'alice', actor: IMPORTER })).toThrow(/tasks/)
  })
})

describe('importFromJobsJsonl(只做形状映射)', () => {
  it('能对上卡的进对象事件(job.<step>),对不上的进 job 话题;读不懂的行数得出;原文件不动;再导不重', () => {
    importFromTasksJson(ledger, copyFixture('tasks.v2.json').path, { owner: 'alice', actor: IMPORTER })
    const src = copyFixture('jobs.v1.jsonl')
    const out = importFromJobsJsonl(ledger, src.path, { actor: IMPORTER })
    expect(out).toEqual({ appended: 4, orphans: 1, unreadable: 1, skipped: 0 })
    expect(readFileSync(src.path, 'utf8')).toBe(src.bytes)

    const t2 = ledger.objects.byLegacyId(T2)?.object_id as string
    const jobEvents = ledger.objectEvents(t2).filter((e) => e.kind.startsWith('job.'))
    expect(jobEvents.map((e) => e.kind)).toEqual(['job.assigned', 'job.sent'])
    expect(jobEvents[0]).toMatchObject({ topic: 'object', ts: Date.parse('2026-10-19T08:00:00.000Z'), evidence: 'v1-import', actor: { ...IMPORTER, family: 'codex' }, payload: { job: T2, family: 'codex', via: 'protocol', kind: 'code' } })

    const orphan = ledger.events(0).find((e) => e.topic === 'job')
    expect(orphan).toMatchObject({ object_id: null, object_version: null, kind: 'job.seen', payload: { job: 'relay-light-7', why: '只盯不发' } })

    const seq = ledger.maxSeq()
    expect(importFromJobsJsonl(ledger, src.path, { actor: IMPORTER })).toEqual({ appended: 0, orphans: 0, unreadable: 1, skipped: 5 })
    expect(ledger.maxSeq()).toBe(seq)
  })

  it('是合法 JSON 但不是一条记录的行(null、数字、字符串、数组)只记读不懂,不让整次导入中断', () => {
    const path = join(dir, 'jobs.odd.jsonl')
    writeFileSync(path, [
      'null',
      '42',
      '"just a string"',
      '[]',
      '{"at":"2026-10-19T10:00:00.000Z","job":"relay-light-9","step":"seen"}',
    ].join('\n'))
    expect(importFromJobsJsonl(ledger, path, { actor: IMPORTER })).toEqual({ appended: 0, orphans: 1, unreadable: 4, skipped: 0 })
  })
})

// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReadMarks, defaultReadMarksFile } from '../src/server/readMarks.ts'

const dirs: string[] = []
// 2026-09-09:整机负载高时原子写的临时文件可能还没落定,rmSync 偶发 ENOTEMPTY(0907/0909 各见一次)。
// 让删除自己重试几拍,而不是把用例判红——用例断言本身从没错过。
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-read-'))
  dirs.push(dir)
  return join(dir, 'nested', 'read-marks.json')
}

const T0 = 1_788_300_000

/**
 * 已读状态落盘(2026-09-02 Ben 点名):会话表只活在 DSH 进程内存里,
 * **每次重启,他看过的完成会话又变回未读蓝点**——当天重启了七八次,这条格外刺眼。
 * 会话本身不该落盘(它随 agent 生灭),但"我已经看过它了"是**用户的判断**,该留住。
 */
describe('已读标记落盘', () => {
  it('defaultReadMarksFile 落在 ~/.dsh/workbench/read-marks.json', () => {
    expect(defaultReadMarksFile('/Users/example')).toBe('/Users/example/.dsh/workbench/read-marks.json')
  })

  it('★标过已读的会话,重建实例后仍然认得(这就是重启不再变回未读的根据)', async () => {
    const file = tempFile()
    const marks = createReadMarks({ file, now: () => T0 })
    expect(marks.has('codex', 's1')).toBe(false)
    marks.add('codex', 's1')
    expect(marks.has('codex', 's1')).toBe(true)
    await marks.flush()

    const again = createReadMarks({ file, now: () => T0 })
    await again.load()
    expect(again.has('codex', 's1')).toBe(true)
    expect(again.has('codex', 's2')).toBe(false)
  })

  it('按 agent 隔离:同名 session_id 分属两家互不影响', async () => {
    const file = tempFile()
    const marks = createReadMarks({ file, now: () => T0 })
    marks.add('codex', 'same')
    expect(marks.has('claude', 'same')).toBe(false)
  })

  it('★过期条目自动清掉,文件不会无限长', async () => {
    const file = tempFile()
    const old = createReadMarks({ file, now: () => T0, keepMs: 86_400_000 })
    old.add('codex', 'ancient')
    await old.flush()

    // 两天后再开:超过保留期的条目在 load 时被丢掉,并不再认它
    const later = createReadMarks({ file, now: () => T0 + 172_800, keepMs: 86_400_000 })
    await later.load()
    expect(later.has('codex', 'ancient')).toBe(false)
  })

  it('文件不存在/写坏了 → 当作空表,不抛(D13)', async () => {
    const marks = createReadMarks({ file: join(tmpdir(), '绝不存在-read-marks.json'), now: () => T0 })
    await marks.load()
    expect(marks.has('codex', 'x')).toBe(false)
  })
})

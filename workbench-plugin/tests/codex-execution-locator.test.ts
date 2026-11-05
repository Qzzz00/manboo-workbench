// @vitest-environment node
// Codex 执行定位 hint:稳态跳过 realpath/64KB 元数据读;index 换路径、文件追加、cwds 变化、命中失败都回到全量校验。
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCodexExecutionLocator, locateCodexCliSession } from '../src/server/cliSessionRead.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const SESSION_ID = '019a0000-0000-7000-8000-0000000000c1'

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-locator-'))); dirs.push(home)
  const cwd = join(home, 'qa-project'); mkdirSync(cwd)
  const dir = join(home, 'sessions', '2026', '10', '28'); mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-10-28T01-00-00-${SESSION_ID}.jsonl`)
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: SESSION_ID, cwd } }) + '\n')
  return { home, cwd, file }
}

it('hint 命中不再全量校验;文件追加、index 换路径、cwds 变化下一拍重新全量校验', async () => {
  const f = fixture()
  const fullLocate = vi.fn((input: Parameters<typeof locateCodexCliSession>[0]) => locateCodexCliSession(input))
  const locator = createCodexExecutionLocator(f.home, { fullLocate })

  const prepared = await locator.prepare()
  const input = { sessionId: SESSION_ID, cwds: [f.cwd] as readonly string[] }
  const first = await prepared({ ...input, registeredFile: f.file })
  expect(first).toMatchObject({ agent: 'codex', format: 'codex-rollout', file: realpathSync(f.file) })
  expect(fullLocate).toHaveBeenCalledTimes(1)

  // 稳态:同一登记文件、cwds 没变、文件没动 → 不再碰 realpath/64KB 元数据读。
  for (let n = 0; n < 3; n++) expect(await prepared({ ...input, registeredFile: f.file })).toEqual(first)
  expect(fullLocate).toHaveBeenCalledTimes(1)

  // 追加(rollout 长尾巴)→ 下一拍全量校验,新事实仍可见。
  appendFileSync(f.file, JSON.stringify({ type: 'event_msg', timestamp: '2026-10-28T01:01:00Z', payload: { type: 'task_started', turn_id: 'r-1' } }) + '\n')
  expect(await prepared({ ...input, registeredFile: f.file })).toEqual(first)
  expect(fullLocate).toHaveBeenCalledTimes(2)
  // 之后的稳态拍又回 hint。
  expect(await prepared({ ...input, registeredFile: f.file })).toEqual(first)
  expect(fullLocate).toHaveBeenCalledTimes(2)

  // index / 登记解析出的路径换了 → 全量校验走新文件。
  const moved = join(f.home, 'sessions', '2026', '10', '28', `relocated-${SESSION_ID}.jsonl`)
  writeFileSync(moved, JSON.stringify({ type: 'session_meta', payload: { id: SESSION_ID, cwd: f.cwd } }) + '\n')
  const afterMove = await prepared({ ...input, registeredFile: moved })
  expect(afterMove?.file).toBe(realpathSync(moved))
  expect(fullLocate).toHaveBeenCalledTimes(3)
  // 旧路径的 hint 不再被新路径命中(文件内容相同也不行 —— hint 认路径)。
  expect(await prepared({ ...input, registeredFile: moved })).toEqual(afterMove)
  expect(fullLocate).toHaveBeenCalledTimes(3)

  // 项目路径移动(cwds 串变)→ 全量校验,项目门如实拦。
  const other = join(f.home, 'other-project'); mkdirSync(other)
  expect(await prepared({ sessionId: SESSION_ID, cwds: [other], registeredFile: moved })).toBeUndefined()
  expect(fullLocate).toHaveBeenCalledTimes(4)
  // 拦完那一拍 hint 作废,回到正确 cwds 重建。
  expect(await prepared({ ...input, registeredFile: moved })).toEqual(afterMove)
  expect(fullLocate).toHaveBeenCalledTimes(5)
  expect(await prepared({ ...input, registeredFile: moved })).toEqual(afterMove)
  expect(fullLocate).toHaveBeenCalledTimes(5)
})

it('未登记走 index 查找时,hint 按解析出的路径同样生效与失效', async () => {
  const f = fixture()
  const dbFile = join(f.home, 'state_5.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(SESSION_ID, f.file); db.close()
  const fullLocate = vi.fn((input: Parameters<typeof locateCodexCliSession>[0]) => locateCodexCliSession(input))
  const locator = createCodexExecutionLocator(f.home, { fullLocate })
  const prepared = await locator.prepare()
  const input = { sessionId: SESSION_ID, cwds: [f.cwd] as readonly string[] }
  expect(await prepared(input)).toMatchObject({ file: realpathSync(f.file) })
  expect(fullLocate).toHaveBeenCalledTimes(1)
  expect(await prepared(input)).toMatchObject({ file: realpathSync(f.file) })
  expect(fullLocate).toHaveBeenCalledTimes(1)
  // index 换路径(UPDATE threads)→ 下一拍全量校验,反映新文件。
  const moved = join(f.home, 'sessions', '2026', '10', '28', `idx-moved-${SESSION_ID}.jsonl`)
  writeFileSync(moved, JSON.stringify({ type: 'session_meta', payload: { id: SESSION_ID, cwd: f.cwd } }) + '\n')
  const db2 = new DatabaseSync(dbFile)
  db2.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(moved, SESSION_ID); db2.close()
  expect((await prepared(input))?.file).toBe(realpathSync(moved))
  expect(fullLocate).toHaveBeenCalledTimes(2)
})

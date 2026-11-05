// @vitest-environment node
/**
 * **开得早的 Codex 对话今天接着用,工作台看不见**(2026-10-08 真机)。
 *
 * 她 19:3x 在「调研宝可梦日蚀」里派活 —— 那条对话 08-20 开,Codex 一直往
 * `sessions/2026/08/20/rollout-…jsonl` 里接着写;发现路径只翻最近 30 天的日期目录,于是整条看不见,
 * 气泡和事务官卡片一起没有(维护者:「codex 都没了几次了」)。
 * Codex 自己有一张对话总表(`state_<N>.sqlite` 的 `threads`:`rollout_path` / `updated_at_ms`),
 * 按它找「最近有动静的对话」,不再按开始那天的目录猜。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { codexActiveRollouts } from '../src/server/codexThreadIndex.ts'
import { defaultCodexSessionFeedDeps } from '../src/server/codexSessionFeed.ts'

const homes: string[] = []
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }) })

function codexHome(rows: { id: string, path: string, updatedMs: number, archived?: number }[], dbName = 'state_5.sqlite'): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-index-'))
  homes.push(home)
  const db = new DatabaseSync(join(home, dbName))
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0)`)
  const ins = db.prepare('INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, archived) VALUES (?, ?, ?, ?, ?)')
  for (const r of rows) ins.run(r.id, r.path, Math.floor(r.updatedMs / 1000), r.updatedMs, r.archived ?? 0)
  db.close()
  return home
}

const NOW = Date.parse('2026-10-08T11:38:00Z')

describe('Codex 对话总表:最近有动静的对话在哪个文件', () => {
  it('★08-20 开、今天还在更新的那条 → 找得到;两天前就没动的、归档了的 → 不要', () => {
    const home = codexHome([
      { id: 'a', path: '/x/sessions/2026/08/20/rollout-a.jsonl', updatedMs: NOW - 60_000 },
      { id: 'b', path: '/x/sessions/2026/09/01/rollout-b.jsonl', updatedMs: NOW - 3 * 86_400_000 },
      { id: 'c', path: '/x/sessions/2026/10/08/rollout-c.jsonl', updatedMs: NOW - 1000, archived: 1 },
    ])
    expect(codexActiveRollouts({ codexHome: home, sinceMs: NOW - 2 * 86_400_000 })).toEqual(['/x/sessions/2026/08/20/rollout-a.jsonl'])
  })

  it('认版本号最大的那份库(state_5 之后换成 state_6 也认)', () => {
    const home = codexHome([{ id: 'a', path: '/x/a.jsonl', updatedMs: NOW }], 'state_6.sqlite')
    writeFileSync(join(home, 'state_4.sqlite'), '')
    expect(codexActiveRollouts({ codexHome: home, sinceMs: NOW - 1000 })).toEqual(['/x/a.jsonl'])
  })

  it('没有库、库坏了、表的样子不对 → 空(照旧按日期目录找),不抛', () => {
    const empty = mkdtempSync(join(tmpdir(), 'codex-index-')); homes.push(empty)
    expect(codexActiveRollouts({ codexHome: empty, sinceMs: 0 })).toEqual([])
    writeFileSync(join(empty, 'state_5.sqlite'), 'not a database')
    expect(codexActiveRollouts({ codexHome: empty, sinceMs: 0 })).toEqual([])
    const odd = mkdtempSync(join(tmpdir(), 'codex-index-')); homes.push(odd)
    const db = new DatabaseSync(join(odd, 'state_5.sqlite')); db.exec('CREATE TABLE threads (id TEXT)'); db.close()
    expect(codexActiveRollouts({ codexHome: odd, sinceMs: 0 })).toEqual([])
  })

  it('★发现路径把总表里那条老目录的对话也列出来', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-index-')); homes.push(home)
    const old = join(home, 'sessions', '2026', '08', '20', 'rollout-old.jsonl')
    mkdirSync(join(home, 'sessions', '2026', '08', '20'), { recursive: true })
    writeFileSync(old, '')
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0)`)
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0)').run('old', old, Math.floor(Date.now() / 1000), Date.now())
    db.close()
    const found = await defaultCodexSessionFeedDeps(home).listRecentRollouts?.() ?? []
    expect(found).toContain(old)
  })
})

describe('手机「各家最近会话」里 Codex 那条的会话号', () => {
  it('★新版文件名 rollout-<时刻>-<对话号>_<另一个号>.jsonl 取前面那个', async () => {
    const mod = await import('../src/server/sessionHistory.ts') as Record<string, unknown>
    const re = mod.CODEX_ID_RE as RegExp | undefined
    if (re === undefined) return
    expect(re.exec('rollout-2026-10-08T10-43-46-01a0cc34-02b4-7ec1-b47c-4b3e68232414_01a11965-3803-7940-b0dc-45b314d638eb.jsonl')?.[1]).toBe('01a0cc34-02b4-7ec1-b47c-4b3e68232414')
    expect(re.exec('rollout-2026-08-20T11-44-33-01a01d45-41c1-7c21-b41f-b75ca3bcc007.jsonl')?.[1]).toBe('01a01d45-41c1-7c21-b41f-b75ca3bcc007')
  })
})

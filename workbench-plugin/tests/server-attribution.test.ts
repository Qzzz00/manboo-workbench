// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { attributeCwd, clusterKey, clusterPending, codexSessionCwds, normalizeDir } from '../src/server/attribution.ts'

const HOME = '/Users/example'
const REPOS = ['/Users/example/Documents/GitHub/Aiboo', '/Users/example/Documents/GitHub/Echo']

describe('归属(spec D5/D7)', () => {
  it('cwd 在仓库(含子目录/worktree)内自动归', () => {
    expect(attributeCwd('/Users/example/Documents/GitHub/Aiboo/.claude/worktrees/x', REPOS, []))
      .toEqual({ kind: 'repo', repoPath: '/Users/example/Documents/GitHub/Aiboo' })
  })
  it('目录规则一次生效,优先于 pending', () => {
    const rule = { dir: '/users/ben/multica_workspaces', action: 'not_mine' as const }
    expect(attributeCwd('/Users/example/multica_workspaces/505232f2/x', REPOS, [rule]))
      .toEqual({ kind: 'rule', rule })
  })
  it('推不出就是 pending,绝不猜(D5)', () => {
    expect(attributeCwd('/Users/example/Documents/ChatGPT/abc', REPOS, [])).toEqual({ kind: 'pending' })
  })
})

describe('待归档按目录聚类', () => {
  it('home 下取前两段作组;计数与时间范围正确', () => {
    expect(clusterKey('/Users/example/multica_workspaces/505232f2/deep/x', HOME))
      .toBe('/Users/example/multica_workspaces/505232f2')
    const groups = clusterPending([
      { cwd: '/Users/example/Documents/Codex/2026-06-01/a', at: '2026-06-01' },
      { cwd: '/Users/example/Documents/Codex/2026-08-04/b', at: '2026-08-04' },
      { cwd: '/Users/example/Documents/ChatGPT/x' },
    ], HOME)
    expect(groups[0]).toEqual({ dir: '/Users/example/Documents/Codex', count: 2, first_at: '2026-06-01', last_at: '2026-08-04' })
  })
})

describe('Codex 会话源', () => {
  it('读首行 payload.cwd;坏行计入 errors 不带崩(D13)', async () => {
    const deps = {
      listFiles: async () => ['/x/a.jsonl', '/x/b.jsonl'],
      readFirstLine: async (f: string) => f.endsWith('a.jsonl')
        ? JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/example/Documents/Codex/2026-06-01/a', timestamp: '2026-06-01T00:00:00Z', source: 'cli' } })
        : '{broken',
    }
    expect(await codexSessionCwds('/x', deps)).toEqual({
      items: [{ cwd: '/Users/example/Documents/Codex/2026-06-01/a', at: '2026-06-01T00:00:00Z' }],
      errors: 1,
    })
  })

  it('历史计数只保留 interactive 顶层 thread，不把 subagent/guardian/exec 算进去', async () => {
    const rows = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'top', cwd: '/repo/top', source: 'cli' } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'child', cwd: '/repo/child', source: { subagent: { thread_spawn: { parent_thread_id: 'top' } } } } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'guardian', cwd: '/repo/guardian', source: { subagent: { other: 'guardian' } } } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'exec', cwd: '/repo/exec', source: 'exec' } }),
    ]
    const result = await codexSessionCwds('/x', {
      listFiles: async () => rows.map((_, i) => `/x/${i}.jsonl`),
      readFirstLine: async file => rows[Number(file.match(/(\d+)\.jsonl$/)?.[1] ?? -1)] ?? '',
    })

    expect(result).toEqual({ items: [{ cwd: '/repo/top' }], errors: 0 })
  })
})

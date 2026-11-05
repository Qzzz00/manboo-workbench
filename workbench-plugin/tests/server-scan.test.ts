// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { idleDays, parseWorktreePorcelain, scanRepo } from '../src/server/scan.ts'

const MAIN = '/Users/example/Documents/GitHub/Aiboo'
// git worktree list --porcelain 的真实格式:块间空行,主仓第一块
const PORCELAIN = [
  `worktree ${MAIN}`, 'HEAD c60d28a8', 'branch refs/heads/feat/perf-p0-render-bypass', '',
  `worktree ${MAIN}/.claude/worktrees/hum-world-v2`, 'HEAD 3419223a', 'branch refs/heads/feat/hum-world-v2', '',
  `worktree ${MAIN}/.claude/worktrees/goofy-murdock-88efe5`, 'HEAD 88f7cfac', 'branch refs/heads/claude/goofy-murdock-88efe5', '',
  'worktree /private/tmp/claude-501/x/scratchpad/wt-011ff7d', 'HEAD 011ff7d', 'detached', 'prunable gitdir file points to non-existent location', '',
].join('\n')

describe('worktree 折叠(spec D14)', () => {
  it('主仓不计;claude/* 随机名归可清理;prunable 与临时目录剔除', () => {
    expect(parseWorktreePorcelain(PORCELAIN, MAIN)).toEqual({ active: 1, cleanup: 1 })
  })
})

describe('闲置天数', () => {
  it('按日历日差,不足一天算 0', () => {
    const now = Math.floor(Date.parse('2026-08-20T12:00:00Z') / 1000)
    expect(idleDays('2026-08-10T09:00:00+08:00', now)).toBe(10)
    expect(idleDays(undefined, now)).toBe(0)
  })
})

describe('scanRepo', () => {
  it('git 命令失败返回 error 而不是编数(D13)', async () => {
    const exec = async (args: readonly string[], cwd: string) => ({ ok: false, stdout: '' })
    expect(await scanRepo('/tmp/broken', exec)).toEqual({ path: '/tmp/broken', error: 'git rev-parse 失败' })
  })
  it('四条 git 命令拼出 RepoInfo', async () => {
    const answers: Record<string, string> = {
      'rev-parse': 'main\n',
      'status': ' M a.ts\n?? b.ts\n',
      'log': '2026-08-18T20:00:00+08:00\n',
      'worktree': `worktree /r\nHEAD abc\nbranch refs/heads/main\n`,
    }
    const exec = async (args: readonly string[], cwd: string) =>
      ({ ok: true, stdout: answers[args[0]!] ?? '' })
    expect(await scanRepo('/r', exec)).toEqual({
      path: '/r', name: 'r', branch: 'main', dirtyCount: 2,
      worktreesActive: 0, cleanupCount: 0, lastCommitAt: '2026-08-18T20:00:00+08:00',
    })
  })
})

describe('scanRepo:无提交的仓库(unborn HEAD)', () => {
  it('rev-parse 失败但 symbolic-ref 能给分支名时按正常行返回,不带 lastCommitAt', async () => {
    const exec = async (args: readonly string[], cwd: string) => {
      if (args[0] === 'rev-parse') return { ok: false, stdout: '' }
      if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'main\n' }
      if (args[0] === 'status') return { ok: true, stdout: '?? app.json\n' }
      if (args[0] === 'log') return { ok: false, stdout: '' }
      return { ok: true, stdout: '' }
    }
    expect(await scanRepo('/wx/miniprogram-3', exec)).toEqual({
      path: '/wx/miniprogram-3', name: 'miniprogram-3', branch: 'main', dirtyCount: 1,
      worktreesActive: 0, cleanupCount: 0,
    })
  })
  it('rev-parse 与 symbolic-ref 都失败才算未接入', async () => {
    const exec = async () => ({ ok: false, stdout: '' })
    expect(await scanRepo('/x', exec)).toEqual({ path: '/x', error: 'git rev-parse 失败' })
  })
})

/**
 * 本地分支清单(2026-09-09 任务卡挂交付物:「交付物 = 分支」那一格从下拉里挑)。
 * 与其余「算」行同一条纪律:每次扫描重算,取不到就缺席,不落盘。
 */
describe('scanRepo:本地分支清单', () => {
  it('for-each-ref 给的分支名逐行进 branches(worktree 的分支共用 refs,自然在内)', async () => {
    const answers: Record<string, string> = {
      'rev-parse': 'main\n',
      'status': '',
      'log': '2026-08-18T20:00:00+08:00\n',
      'worktree': `worktree /r\nHEAD abc\nbranch refs/heads/main\n`,
      'for-each-ref': 'main\nclaude/heuristic-noyce-41b305\nfeat/x\n',
    }
    const exec = async (args: readonly string[]) => ({ ok: true, stdout: answers[args[0]!] ?? '' })
    const info = await scanRepo('/r', exec)
    expect('branches' in info ? info.branches : undefined).toEqual(['main', 'claude/heuristic-noyce-41b305', 'feat/x'])
  })

  it('for-each-ref 失败或没有分支时字段缺席,其余信号照常(不因为这一条把整行判失败)', async () => {
    const exec = async (args: readonly string[]) => (
      args[0] === 'for-each-ref' ? { ok: false, stdout: '' } : { ok: true, stdout: args[0] === 'rev-parse' ? 'main\n' : '' }
    )
    const info = await scanRepo('/r', exec)
    expect(info).not.toHaveProperty('error')
    expect(info).not.toHaveProperty('branches')
  })
})

describe('窗口内提交次数(2026-09-09 排期风险)', () => {
  const base: Record<string, string> = {
    'rev-parse': 'main\n',
    'status': '',
    'log': '2026-08-18T20:00:00+08:00\n',
    'worktree': '',
  }
  const execWith = (extra: Record<string, string>, ok = true) =>
    async (args: readonly string[]) => {
      const answer = { ...base, ...extra }[args[0]!]
      if (args[0] === 'rev-list' && !ok) return { ok: false, stdout: '' }
      return { ok: true, stdout: answer ?? '' }
    }

  it('rev-list --count 的结果进 recentCommits', async () => {
    const info = await scanRepo('/r', execWith({ 'rev-list': '17\n' }), 14)
    expect(info).toMatchObject({ recentCommits: 17 })
  })

  it('按窗口天数问 git,不写死', async () => {
    const seen: string[][] = []
    const exec = async (args: readonly string[]) => {
      seen.push([...args])
      return { ok: true, stdout: base[args[0]!] ?? '0\n' }
    }
    await scanRepo('/r', exec, 30)
    expect(seen.some(args => args[0] === 'rev-list' && args.includes('--since=30 days ago'))).toBe(true)
  })

  it('rev-list 失败就缺省,不填 0(D13)——0 次提交和问不出来是两回事', async () => {
    const info = await scanRepo('/r', execWith({}, false), 14)
    expect(info).not.toHaveProperty('recentCommits')
  })

  it('回的不是数字也缺省', async () => {
    const info = await scanRepo('/r', execWith({ 'rev-list': 'fatal: bad revision\n' }), 14)
    expect(info).not.toHaveProperty('recentCommits')
  })

  it('真的是 0 次提交时如实回 0', async () => {
    expect(await scanRepo('/r', execWith({ 'rev-list': '0\n' }), 14)).toMatchObject({ recentCommits: 0 })
  })
})

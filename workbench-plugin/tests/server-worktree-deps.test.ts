// @vitest-environment node
/**
 * 开出来的工作树软链依赖(2026-10-23,卡「派活给名片的四处」②)。
 *
 * 钉住:
 * - 凡主检出里存在 `<子目录>/node_modules` 的,工作树里同位置软链过去;主检出没有的子目录不链;
 * - 软链用**相对路径**(主检出挪位置也不断;与 README 手摆那条同方向);
 * - 链过的写进 `info/exclude`(已有的行不重复追加);一处都没链就不动 exclude;
 * - `prepareSelfBranch` 新开 worktree 那一拍才链(`created:false` / 开失败都不链);
 * - 真 git 集成:linked worktree 的 `.git` 是文件,`info/exclude` 经 `git rev-parse --git-path` 解析。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSelfBranch } from '../src/server/selfShip.ts'
import { linkWorktreeNodeModules, nodeWorktreeDepsIo, type WorktreeDepsIo } from '../src/server/worktreeDeps.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** 假件:一份「主检出」布局 + 记下每次调用。 */
function fakeIo(layout: Record<string, string[]>, existingLinks: string[] = []) {
  const calls: { symlink: { target: string, path: string }[], appended: { file: string, lines: readonly string[] }[] } = { symlink: [], appended: [] }
  const links = new Set(existingLinks)
  const io: WorktreeDepsIo = {
    topDirs: async () => Object.keys(layout).map(one => one.split('/').pop() as string),
    hasNodeModules: async dir => (layout[dir] ?? []).includes('node_modules'),
    linkExists: async path => links.has(path),
    symlink: async (target, path) => { calls.symlink.push({ target, path }); links.add(path) },
    infoExcludePath: async () => '/main/.git/info/exclude',
    appendLines: async (file, lines) => { calls.appended.push({ file, lines }) },
  }
  return { io, calls }
}

describe('linkWorktreeNodeModules(卡「派活给名片的四处」②)', () => {
  it('主检出里有的 <子目录>/node_modules:工作树同位置软链(相对路径)+ 写进 info/exclude', async () => {
    const { io, calls } = fakeIo({ '/repo/a': ['node_modules'], '/repo/b': ['src'] })
    const got = await linkWorktreeNodeModules(io, { projectPath: '/repo', worktree: '/repo/.claude/worktrees/x' })
    expect(got.linked).toEqual(['a'])
    expect(calls.symlink).toEqual([{ target: '../../../../a/node_modules', path: '/repo/.claude/worktrees/x/a/node_modules' }])
    expect(calls.appended).toEqual([{ file: '/main/.git/info/exclude', lines: ['a/node_modules'] }])
  })

  it('目标位置已经有 node_modules(那家自己装过):不盖,但仍记进 exclude', async () => {
    const { io, calls } = fakeIo({ '/repo/a': ['node_modules'] }, ['/wt/a/node_modules'])
    const got = await linkWorktreeNodeModules(io, { projectPath: '/repo', worktree: '/wt' })
    expect(got.linked).toEqual(['a'])
    expect(calls.symlink).toEqual([])
    expect(calls.appended).toEqual([{ file: '/main/.git/info/exclude', lines: ['a/node_modules'] }])
  })

  it('一处都没有(不是「顶层子目录各自一套依赖」的布局):不链、不动 exclude,照常回空表', async () => {
    const { io, calls } = fakeIo({ '/repo/a': ['src'], '/repo/b': ['docs'] })
    const got = await linkWorktreeNodeModules(io, { projectPath: '/repo', worktree: '/wt' })
    expect(got.linked).toEqual([])
    expect(calls.symlink).toEqual([])
    expect(calls.appended).toEqual([])
  })
})

describe('nodeWorktreeDepsIo 真 git 集成(linked worktree 的 .git 是文件,exclude 走 rev-parse)', () => {
  it('真 init + worktree add:链上真软链、exclude 真有这一行、再跑一遍不重复', async () => {
    const main = mkdtempSync(join(tmpdir(), 'wb-deps-main-'))
    dirs.push(main)
    execFileSync('git', ['init', '-q', main])
    execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    mkdirSync(join(main, 'pkg', 'node_modules'), { recursive: true })
    writeFileSync(join(main, 'pkg', 'node_modules', 'marker.txt'), 'x')
    const wt = join(main, '.claude', 'worktrees', '试一刀')
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', wt, '-b', 'kimi/试一刀'])

    const io = nodeWorktreeDepsIo()
    const first = await linkWorktreeNodeModules(io, { projectPath: main, worktree: wt })
    expect(first.linked).toEqual(['pkg'])
    const link = join(wt, 'pkg', 'node_modules')
    expect(existsSync(join(link, 'marker.txt'))).toBe(true)
    expect(readFileSync(join(link, 'marker.txt'), 'utf8')).toBe('x')
    // 相对路径,不是绝对路径。
    expect(readlinkSync(link)).toBe('../../../../pkg/node_modules')
    const exclude = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n')).toContain('pkg/node_modules')
    // 幂等:再跑一遍不重复追加、也不报错。
    const second = await linkWorktreeNodeModules(io, { projectPath: main, worktree: wt })
    expect(second.linked).toEqual(['pkg'])
    const again = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')
    expect(again.split('\n').filter(one => one === 'pkg/node_modules')).toHaveLength(1)
  })
})

describe('prepareSelfBranch:afterCreate 钩子(新开那一拍才软链)', () => {
  it('worktree add 成功:调 afterCreate(主检出 + 新工作树路径)', async () => {
    const seen: { projectPath: string, worktree: string }[] = []
    const run = async ({ args }: { cmd: string, args: string[] }) => ({
      code: 0,
      out: args[0] === 'worktree' && args[1] === 'list' ? '' : '',
    })
    const got = await prepareSelfBranch(
      { run: run as never, afterCreate: async (input) => { seen.push(input) } },
      { projectPath: '/repo', branch: 'kimi/x', worktree: '/repo/.claude/worktrees/x' },
    )
    expect(got).toMatchObject({ ok: true, created: true })
    expect(seen).toEqual([{ projectPath: '/repo', worktree: '/repo/.claude/worktrees/x' }])
  })

  it('分支已 checkout(created:false)与开失败:都不调', async () => {
    const seen: unknown[] = []
    const listed = async ({ args }: { cmd: string, args: string[] }) => ({
      code: 0,
      out: args[1] === 'list' ? 'worktree /repo/.claude/worktrees/x\nbranch refs/heads/kimi/x' : '',
    })
    const existing = await prepareSelfBranch(
      { run: listed as never, afterCreate: async (input) => { seen.push(input) } },
      { projectPath: '/repo', branch: 'kimi/x', worktree: '/repo/.claude/worktrees/x' },
    )
    expect(existing.created).toBe(false)
    const failed = await prepareSelfBranch(
      { run: async () => ({ code: 1, out: 'fatal' }), afterCreate: async (input: { projectPath: string, worktree: string }) => { seen.push(input) } } as never,
      { projectPath: '/repo', branch: 'kimi/y', worktree: '/repo/.claude/worktrees/y' },
    )
    expect(failed.ok).toBe(false)
    expect(seen).toEqual([])
  })
})

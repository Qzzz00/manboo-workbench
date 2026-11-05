import { describe, expect, it } from 'vitest'
import { rollupProject } from '../src/usage/rollup.ts'

describe('rollupProject', () => {
  it('把 worktree 归拢回所属仓库', () => {
    expect(rollupProject('/Users/example/Documents/GitHub/desktop-workbench/.claude/worktrees/gracious-bose-b9c075'))
      .toBe('desktop-workbench')
  })

  it('把仓库子目录归拢回仓库', () => {
    expect(rollupProject('/Users/example/Documents/GitHub/desktop-workbench/workbench-plugin'))
      .toBe('desktop-workbench')
  })

  /**
   * 回归(2026-08-26 真机):Codex 的 worktree 布局是 `~/.codex/worktrees/<hash>/<仓库名>`
   * ——仓库名在 hash **后面**。原来的剥尾巴正则把整段剥光,348M token 全部落进
   * 名叫「~/.codex」的假项目里,其中就有工作台的 Codex 会话。
   */
  it('Codex worktree(hash 在前、仓库名在后)归拢回仓库', () => {
    expect(rollupProject('/Users/example/.codex/worktrees/d7dd/desktop-workbench'))
      .toBe('desktop-workbench')
    expect(rollupProject('/Users/example/.codex/worktrees/fabf/KOUKOU/sub/dir'))
      .toBe('KOUKOU')
  })

  /**
   * 新旧仓库名归并(2026-08-26,Ben 口径):ben-dsh-workbench 是工作台的作废前身,
   * 与 desktop-workbench 是同一个项目,历史用量并到现名下,不留分裂的两行。
   */
  it('作废旧仓库名 ben-dsh-workbench 归并到 desktop-workbench', () => {
    expect(rollupProject('/Users/example/Documents/GitHub/ben-dsh-workbench'))
      .toBe('desktop-workbench')
    expect(rollupProject('/Users/example/Documents/GitHub/ben-dsh-workbench/.claude/worktrees/objective-wu-14f912'))
      .toBe('desktop-workbench')
  })

  it('Codex 按日期分层时取日期的下一级,不能出现名叫日期的项目', () => {
    expect(rollupProject('/Users/example/Documents/Codex/2026-08-20/rang/work'))
      .toBe('rang')
  })

  it('认不出的路径退回 ~ 缩写,不抛错', () => {
    expect(rollupProject('/Users/example/somewhere/else')).toBe('~/somewhere/else')
  })

  it('空路径给出稳定占位,不抛错', () => {
    expect(rollupProject('')).toBe('(未知)')
  })
})

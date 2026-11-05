// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveCodexProject } from '../src/server/codexProject.ts'

describe('Codex project attribution', () => {
  it('maps a repository subdirectory to the verified repository project', async () => {
    const result = await resolveCodexProject('/repos/KOUKOU/src', {
      gitCommonRoot: async () => '/repos/KOUKOU',
      projectNameForRoot: async root => root === '/repos/KOUKOU' ? 'KOUKOU' : undefined,
    })

    expect(result).toBe('KOUKOU')
  })

  it('maps a Codex worktree back to the main repository project', async () => {
    const result = await resolveCodexProject('/Users/example/.codex/worktrees/d7dd/KOUKOU', {
      gitCommonRoot: async () => '/Users/example/Documents/GitHub/KOUKOU',
      projectNameForRoot: async root => root === '/Users/example/Documents/GitHub/KOUKOU' ? 'KOUKOU' : undefined,
    })

    expect(result).toBe('KOUKOU')
  })

  it('uses an existing directory rule when cwd is not a Git repository', async () => {
    const result = await resolveCodexProject('/Users/example/multica_workspaces/slot-1', {
      gitCommonRoot: async () => undefined,
      projectNameForRoot: async root => root === '/Users/example/multica_workspaces/slot-1' ? '临时项目' : undefined,
    })

    expect(result).toBe('临时项目')
  })

  it('returns undefined when neither Git nor a directory rule proves ownership', async () => {
    const result = await resolveCodexProject('/Users/example/unknown/cwd', {
      gitCommonRoot: async () => undefined,
      projectNameForRoot: async () => undefined,
    })

    expect(result).toBeUndefined()
  })

  it('does not throw when Git lookup fails', async () => {
    const result = await resolveCodexProject('/Users/example/unknown/cwd', {
      gitCommonRoot: async () => { throw new Error('not a repository') },
      projectNameForRoot: async () => undefined,
    })

    expect(result).toBeUndefined()
  })
})

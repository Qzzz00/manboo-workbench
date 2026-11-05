// @vitest-environment node
/**
 * 路径可配之「改了要生效」(2026-09-17 卡 C):扫描根 projectsService 每次真扫都现问一遍,
 * 改完下一次扫描就用新根(不用重启)。
 *
 * 这条是"读的时候现问",而不是"起服务时取一次存起来"——后者正是改造前的样子,
 * 也正是"改了没反应"这类 bug 的出处。
 */
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProjectsService } from '../src/server/projectsService.ts'
import type { ScanRoot } from '../src/server/scan.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-17T09:00:00Z') / 1000)

/** 假的目录树:key 是目录,value 是它下面的绝对路径;isRepo 认带 .git 标记的那些。 */
function fakeFs(tree: Record<string, string[]>, repos: readonly string[]) {
  return {
    listDir: async (dir: string) => tree[dir] ?? [],
    isRepo: async (dir: string) => repos.includes(dir),
  }
}

describe('扫描根改了,下一次扫描就用新的', () => {
  async function svcWith(roots: { current: readonly ScanRoot[] }) {
    const store = await mkdtemp(join(tmpdir(), 'wb-scanroot-'))
    const { listDir, isRepo } = fakeFs(
      { '/old': ['/old/a'], '/new': ['/new/b'] },
      ['/old/a', '/new/b'],
    )
    return createProjectsService({
      file: join(store, 'projects.json'),
      exec: async () => ({ ok: false, stdout: '' }),
      listDir,
      isRepo,
      codexHome: join(store, 'codex-nope'),
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/home',
      now: () => NOW_SEC,
      scanMinIntervalSec: 0,
      // 现问一遍,不是起服务时取一次:这正是「改了就生效」的全部机关。
      scanRoots: () => roots.current,
    })
  }

  it('换根之后,作废缓存,下一次扫描扫的是新根', async () => {
    const roots = { current: [{ path: '/old', depth: 1 }] as readonly ScanRoot[] }
    const svc = await svcWith(roots)
    expect((await svc.getProjectsState()).projects.map(p => p.path)).toEqual(['/old/a'])

    roots.current = [{ path: '/new', depth: 1 }]
    svc.invalidateScanCache()
    expect((await svc.getProjectsState()).projects.map(p => p.path)).toEqual(['/new/b'])
  })

  it('不传 scanRoots 时还是那三个默认根(改造前的行为一个字没动)', async () => {
    const store = await mkdtemp(join(tmpdir(), 'wb-scanroot-def-'))
    const seen: string[] = []
    const svc = createProjectsService({
      file: join(store, 'projects.json'),
      exec: async () => ({ ok: false, stdout: '' }),
      listDir: async (dir) => { seen.push(dir); return [] },
      isRepo: async () => false,
      codexHome: join(store, 'codex-nope'),
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/home',
      now: () => NOW_SEC,
    })
    await svc.getProjectsState()
    expect(seen).toEqual(['/home/Documents/GitHub', '/home/Documents/Codex', '/home/WeChatProjects'])
  })
})

describe('扫描根能配成空的', () => {
  it('一个根都不扫时项目区是空的,而不是回落到默认三个根', async () => {
    const store = await mkdtemp(join(tmpdir(), 'wb-scanroot-empty-'))
    await mkdir(join(store, 'unused'), { recursive: true })
    const svc = createProjectsService({
      file: join(store, 'projects.json'),
      exec: async () => ({ ok: false, stdout: '' }),
      listDir: async () => { throw new Error('不该扫任何目录') },
      isRepo: async () => false,
      codexHome: join(store, 'codex-nope'),
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/home',
      now: () => NOW_SEC,
      scanRoots: () => [],
    })
    expect((await svc.getProjectsState()).projects).toEqual([])
  })
})

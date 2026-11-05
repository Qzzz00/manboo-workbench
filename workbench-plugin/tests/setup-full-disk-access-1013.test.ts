// @vitest-environment node
/**
 * 「完全磁盘访问」给没给(2026-10-13,卡「手机看文件时电脑弹 node 的文件夹授权」)。
 *
 * 维护者 10-13 早原话:「现在我在手机上每次看文件,电脑上似乎都有一个授权弹窗要点,
 * 不点我就看不到文件,我记得是 node,不解决这个问题,那这个功能就废了,因为我要看文件的场景,
 * 说明我不在电脑桌前」。根治是给 `~/.dsh/node/bin/node` 一次「完全磁盘访问」,
 * 产品这一侧要做的是**探得出给没给、说得出怎么给**。
 *
 * 这份用例钉三件:
 *   ① 探针**只读、而且不会弹任何系统框**(选的那几条目录是 FDA 独占的,TCC 直接拒,不问人);
 *   ② 判法:列得动 = 给了;EPERM/EACCES = 没给;目录都不在 = 判断不了(**不许说成给了**);
 *   ③ 体检第 3 步多一格,没给时三颗键(打开那一页 / 在访达里显示那个文件 / 再核一次)。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FULL_DISK_PROBE_RELATIVE,
  FULL_DISK_WHY,
  fullDiskAccessKindOf,
  fullDiskProbePaths,
  probeFullDiskAccess,
  type FullDiskProbe,
} from '../src/server/setup/fullDiskAccess.ts'
import { nodeSetupIo, type SetupIo } from '../src/server/setup/io.ts'
import { PANE_URLS, openSetupPane } from '../src/server/setup/panes.ts'
import { createSetupStatus } from '../src/server/setup/status.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { seedLockedRuntime } from './setup/dshRuntimeFake.ts'
import type { SetupItem } from '../src/server/setup/types.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fda-home-'))
  dirs.push(dir)
  return dir
}

function probe(listed: FullDiskProbe['listed'], path = '/x'): FullDiskProbe {
  return { path, listed }
}

describe('判法(纯函数)', () => {
  it('列得动 = 给了', () => {
    expect(fullDiskAccessKindOf([probe('ok')])).toBe('ok')
  })

  it('EPERM / EACCES = 没给', () => {
    expect(fullDiskAccessKindOf([probe('denied')])).toBe('denied')
  })

  it('★目录不在就往下一条探针走 —— 不拿"不存在"当"没给"', () => {
    expect(fullDiskAccessKindOf([probe('absent'), probe('ok')])).toBe('ok')
    expect(fullDiskAccessKindOf([probe('absent'), probe('denied')])).toBe('denied')
  })

  it('★一条都探不着(都不在 / 都是别的错):判断不了,**不说成给了**', () => {
    expect(fullDiskAccessKindOf([probe('absent'), probe('error')])).toBe('unknown')
    expect(fullDiskAccessKindOf([])).toBe('unknown')
  })

  it('探针路径都在 home 底下,而且都是「文件和文件夹」那一类弹不出框的 FDA 独占目录', () => {
    const paths = fullDiskProbePaths('/Users/x')
    expect(paths.length).toBe(FULL_DISK_PROBE_RELATIVE.length)
    for (const path of paths) expect(path.startsWith('/Users/x/Library/')).toBe(true)
    // 文稿 / 桌面 / 下载是**会弹框**的那一类,一条都不许进探针(弹框正是这张卡要消掉的东西)。
    for (const path of paths) expect(/\/(Documents|Desktop|Downloads)(\/|$)/.test(path)).toBe(false)
  })
})

describe('真去探一眼(只读)', () => {
  it('列得动第一条:就是 ok,后面几条不白跑', async () => {
    const home = tempHome()
    const asked: string[] = []
    const io: SetupIo = {
      ...nodeSetupIo(),
      readdir: async (path) => { asked.push(path); return { ok: true, names: [] } },
    }
    expect(await probeFullDiskAccess(io, home)).toEqual({ kind: 'ok', path: fullDiskProbePaths(home)[0] })
    expect(asked).toEqual([fullDiskProbePaths(home)[0]])
  })

  it('★EPERM:没给;而且**一个 readdir 之外的命令都没跑**(不碰 TCC、不 tccutil)', async () => {
    const home = tempHome()
    const ran: string[][] = []
    const io: SetupIo = {
      ...nodeSetupIo(),
      readdir: async () => ({ ok: false, code: 'EPERM', message: 'EPERM: operation not permitted, scandir' }),
      exec: async (cmd) => { ran.push([...cmd]); return { ok: true, code: 0, out: '' } },
    }
    expect((await probeFullDiskAccess(io, home)).kind).toBe('denied')
    expect(ran).toEqual([])
  })

  it('第一条不存在、第二条 EPERM:没给', async () => {
    const home = tempHome()
    const first = fullDiskProbePaths(home)[0] as string
    const io: SetupIo = {
      ...nodeSetupIo(),
      readdir: async path => (path === first
        ? { ok: false, code: 'ENOENT', message: 'no such file' }
        : { ok: false, code: 'EACCES', message: 'EACCES' }),
    }
    expect((await probeFullDiskAccess(io, home)).kind).toBe('denied')
  })

  it('全都不存在:判断不了', async () => {
    const home = tempHome()
    const io: SetupIo = {
      ...nodeSetupIo(),
      readdir: async () => ({ ok: false, code: 'ENOENT', message: 'no such file' }),
    }
    expect((await probeFullDiskAccess(io, home)).kind).toBe('unknown')
  })

  it('readdir 自己抛了:判断不了,不往"给了"那边说', async () => {
    const home = tempHome()
    const io: SetupIo = {
      ...nodeSetupIo(),
      readdir: async () => { throw new Error('炸了') },
    }
    expect((await probeFullDiskAccess(io, home)).kind).toBe('unknown')
  })
})

describe('体检第 3 步那一格', () => {
  /** 摆一台能跑完体检的机器,readdir 由各条用例换掉(这一格只看 readdir)。 */
  function fixture(readdir: SetupIo['readdir']): { home: string, io: SetupIo } {
    const home = tempHome()
    const paths = setupPaths({ home, repoRoot: home, applicationsDir: join(home, 'Applications') })
    mkdirSync(join(paths.nodeBin, '..'), { recursive: true })
    writeFileSync(paths.nodeBin, '#!/bin/sh\n')
    seedLockedRuntime(paths.runtimeDir)
    return {
      home,
      io: {
        ...nodeSetupIo(),
        readdir,
        exec: async () => ({ ok: false, code: 1, out: '这条用例不跑命令' }),
        uid: () => 501,
        currentNodeBinary: () => paths.nodeBin,
      },
    }
  }

  async function itemOf(readdir: SetupIo['readdir']): Promise<{ item: SetupItem, home: string }> {
    const { home, io } = fixture(readdir)
    const status = await createSetupStatus({
      io,
      paths: setupPaths({ home, repoRoot: home, applicationsDir: join(home, 'Applications') }),
      pluginVersion: '9.9.9',
      scanRoots: async () => [],
      repoRoot: home,
      now: () => Date.parse('2026-10-13T01:00:00Z'),
    }).check()
    const item = status.items.find(one => one.key === 'full_disk_access')
    if (item === undefined) throw new Error('体检里没有 full_disk_access 这一格')
    return { item, home }
  }

  it('★没给:等你 + 三颗键(打开那一页 / 在访达里显示那个文件 / 再核一次)', async () => {
    const { item, home } = await itemOf(async () => ({ ok: false, code: 'EPERM', message: 'EPERM' }))
    expect(item.step).toBe(3)
    expect(item.state).toBe('needs_user')
    expect(item.action).toEqual({ kind: 'open_pane', pane: 'all_files', label: '打开系统设置那一页' })
    expect(item.extras).toEqual([
      { kind: 'open_pane', pane: 'node_binary', label: '在访达里显示要加的那个文件' },
      { kind: 'recheck', label: '再核一次' },
    ])
    // 要加进去的是那条 node,不是「工作台」那个 App —— 授权认二进制。
    expect(item.fix).toContain(join(home, '.dsh/node/bin/node'))
    // ★「加完一般不用重启」:按 10-13 的 TCC 日志量过(见 fullDiskAccess.ts 文件头)。
    // 这一条钉着**不许**把那句话写成"必须重启" —— 多一步她多一次白做。
    expect(item.fix).toContain('不用重启')
    expect(item.fix).not.toContain('才生效')
  })

  it('给过了:绿灯,没有按钮', async () => {
    const { item } = await itemOf(async () => ({ ok: true, names: ['TCC.db'] }))
    expect(item.state).toBe('ok')
    expect(item.action).toBeUndefined()
  })

  it('★判断不了:照「等你」说,detail 里写明是判断不了 —— 不给绿灯(D13)', async () => {
    const { item } = await itemOf(async () => ({ ok: false, code: 'ENOENT', message: 'no such file' }))
    expect(item.state).toBe('needs_user')
    expect(item.detail).toContain('判断不了')
  })

  it('这一格是可选的:没给不该让初始化页天天自己弹出来(主路不靠它)', async () => {
    const { item } = await itemOf(async () => ({ ok: false, code: 'EPERM', message: 'EPERM' }))
    expect(item.optional).toBe(true)
  })

  it('那句人话里说清为什么要它:手机看电脑上的文件', async () => {
    expect(FULL_DISK_WHY).toContain('手机')
    expect(FULL_DISK_WHY).toContain('文件')
  })
})

describe('两颗键背后那一下', () => {
  it('「打开系统设置那一页」= open 完全磁盘访问那一页', async () => {
    const ran: string[][] = []
    const io: SetupIo = { ...nodeSetupIo(), exec: async (cmd) => { ran.push([...cmd]); return { ok: true, code: 0, out: '' } } }
    expect(await openSetupPane(io, 'all_files', '/Users/x/.dsh/node/bin/node')).toEqual({ ok: true })
    expect(ran).toEqual([['open', PANE_URLS.all_files]])
    expect(PANE_URLS.all_files).toContain('Privacy_AllFiles')
  })

  it('★「在访达里显示要加的那个文件」= open -R 那条 node(`.dsh` 是隐藏目录,她自己选不到)', async () => {
    const ran: string[][] = []
    const io: SetupIo = { ...nodeSetupIo(), exec: async (cmd) => { ran.push([...cmd]); return { ok: true, code: 0, out: '' } } }
    expect(await openSetupPane(io, 'node_binary', '/Users/x/.dsh/node/bin/node')).toEqual({ ok: true })
    expect(ran).toEqual([['open', '-R', '/Users/x/.dsh/node/bin/node']])
  })

  it('不知道那条 node 在哪:如实回一句,不瞎 open 一个路径', async () => {
    const ran: string[][] = []
    const io: SetupIo = { ...nodeSetupIo(), exec: async (cmd) => { ran.push([...cmd]); return { ok: true, code: 0, out: '' } } }
    const result = await openSetupPane(io, 'node_binary')
    expect(result.ok).toBe(false)
    expect(ran).toEqual([])
  })
})

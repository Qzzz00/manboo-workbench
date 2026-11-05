// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyProjectsFile, isStale, loadProjectsFile, saveProjectsFile } from '../src/server/projects.ts'
import type { WorkbenchLayout } from '../src/protocol.ts'
import { createProjectsService } from '../src/server/projectsService.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-proj-'))
  dirs.push(dir)
  return join(dir, 'nested', 'projects.json')
}

describe('持久化', () => {
  it('存了能读回;文件不存在/损坏返回 empty 不抛(D13)', async () => {
    const file = tempFile()
    const data = emptyProjectsFile()
    data.projects.push({ id: 'aiboo', name: 'Aiboo', stage: 'MVP 开发', repoPath: '/r/Aiboo', links: [] })
    await saveProjectsFile(file, data)
    expect((await loadProjectsFile(file)).projects[0]?.id).toBe('aiboo')
    expect(await loadProjectsFile(join(tmpdir(), '不存在.json'))).toEqual(emptyProjectsFile())
  })
})

describe('陈旧判定(spec D3)', () => {
  it('状态早于最后提交 → stale;无状态不算 stale', () => {
    expect(isStale('2026-08-10T00:00:00Z', '2026-08-18T00:00:00Z')).toBe(true)
    expect(isStale('2026-08-19T00:00:00Z', '2026-08-18T00:00:00Z')).toBe(false)
    expect(isStale(undefined, '2026-08-18T00:00:00Z')).toBe(false)
  })
})

function fakeService(file: string) {
  return createProjectsService({
    file,
    exec: async (args) => args[0] === 'rev-parse'
      ? { ok: true, stdout: 'main\n' }
      : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' },
    listDir: async (d: string) => d === '/roots/gh' ? ['/roots/gh/Aiboo'] : [],
    isRepo: async (d: string) => d === '/roots/gh/Aiboo',
    codexHome: '/x',
    codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
    home: '/Users/example',
    now: () => Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000),
    // scanRoots 作为 opts 传入,不依赖生产默认值,测试才不会跟着 home 目录实况漂移
    scanRoots: [{ path: '/roots/gh', depth: 1 }],
  })
}

describe('projectsService · single-flight（2026-08-21 真机实测补的）', () => {
  it('冷启动时并发 getProjectsState 只触发一轮 build，不是各扫各的', async () => {
    // 2026-08-21 真机实测：重启后展示台 1 秒轮询 /state，首个请求超过 5 秒才响应——
    // 根因是 cache"扫完才写入"，冷启动那几个并发请求各自发现 cache 是空的、各自起一轮
    // findRepos/git/codexSessionCwds 全量扫描。用 listDir 的调用次数当探针：一轮 build
    // 对这份固定 scanRoots 会调 listDir 恰好一次；并发两次 getProjectsState 应该也只有一次。
    let listDirCalls = 0
    const file = tempFile()
    const svc = createProjectsService({
      file,
      exec: async (args) => args[0] === 'rev-parse'
        ? { ok: true, stdout: 'main\n' }
        : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' },
      listDir: async (d: string) => {
        listDirCalls += 1
        return d === '/roots/gh' ? ['/roots/gh/Aiboo'] : []
      },
      isRepo: async (d: string) => d === '/roots/gh/Aiboo',
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000),
      scanRoots: [{ path: '/roots/gh', depth: 1 }],
    })

    // 不等第一个 getProjectsState() 落地就发第二个——模拟冷启动那几个并发 GET /state。
    const [s1, s2] = await Promise.all([svc.getProjectsState(), svc.getProjectsState()])

    expect(listDirCalls).toBe(1) // 只扫了一轮，不是两轮
    expect(s2).toEqual(s1)
  })
})

describe('projectsService', () => {
  it('未登记仓库以待整理出现;confirmStatus 落盘并盖当天日期(验收 §9.5)', async () => {
    const file = tempFile()
    const svc = fakeService(file)
    const s1 = await svc.getProjectsState()
    expect(s1.projects[0]?.stage).toBe('待整理')
    expect(s1.projects[0]?.status).toBeUndefined()
    expect(await svc.confirmStatus(s1.projects[0]!.id, '性能分支收尾')).toBe(true)
    const s2 = await svc.getProjectsState()
    expect(s2.projects[0]?.status).toEqual({
      text: '性能分支收尾', review: 'confirmed', author: '你',
      updated_at: '2026-08-20T00:00:00.000Z', stale: false,
    })
    // 重建服务读同一文件 → 状态还在(持久化生效)
    expect((await fakeService(file).getProjectsState()).projects[0]?.status?.text).toBe('性能分支收尾')
  })

  it('扫描根读不到 → scan_errors 有名有因,其余仓库照常返回(D13)', async () => {
    const file = tempFile()
    const svc = createProjectsService({
      file,
      exec: async (args) => args[0] === 'rev-parse'
        ? { ok: true, stdout: 'main\n' }
        : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' },
      listDir: async (d: string) => {
        if (d === '/roots/gh') throw new Error('权限不足')
        if (d === '/roots/wx') return ['/roots/wx/Echo']
        return []
      },
      isRepo: async (d: string) => d === '/roots/wx/Echo',
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000),
      scanRoots: [{ path: '/roots/gh', depth: 1 }, { path: '/roots/wx', depth: 1 }],
    })
    const state = await svc.getProjectsState()
    expect(state.scan_errors).toEqual([{ root: '/roots/gh', reason: 'Error: 权限不足' }])
    expect(state.projects.map(p => p.id)).toEqual(['echo'])
  })
})

describe('I2(review 修复):getLayout() 读路径过滤旧布局残留的幽灵模块 id', () => {
  it('落盘的布局里带一条 A3 退休掉的 {id:"sessions"} → getLayout() 返回时已经被过滤掉', async () => {
    const file = tempFile()
    const staleLayout = {
      modules: [
        { id: 'sessions', order: 0, basis_pct: 20 },
        { id: 'projects', order: 1, basis_pct: 34 },
        { id: 'slot', order: 2, basis_pct: 54 },
      ],
      butler: { corner: 'br', min: false },
    } as unknown as WorkbenchLayout
    const data = emptyProjectsFile()
    data.layout = staleLayout
    await saveProjectsFile(file, data)

    const svc = fakeService(file)
    const layout = await svc.getLayout()

    expect(layout?.modules.map(m => m.id)).toEqual(['projects', 'slot'])
    expect(layout?.butler).toEqual({ corner: 'br', min: false }) // butler 原样透传,过滤只动 modules
  })

  it('没有落盘过布局 → getLayout() 仍然缺省(undefined),不会因为过滤逻辑变出一个空对象', async () => {
    const file = tempFile()
    const svc = fakeService(file)

    expect(await svc.getLayout()).toBeUndefined()
  })
})

describe('仓库 id 消歧(重名仓库不许静默撞车)', () => {
  it('两个扫描根下同名仓库分配不同 id;confirmStatus 只改动对应那个仓库', async () => {
    const file = tempFile()
    const svc = createProjectsService({
      file,
      exec: async (args) => args[0] === 'rev-parse'
        ? { ok: true, stdout: 'main\n' }
        : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' },
      listDir: async (d: string) => {
        if (d === '/roots/gh') return ['/roots/gh/Echo']
        if (d === '/roots/wx') return ['/roots/wx/Echo']
        return []
      },
      isRepo: async (d: string) => d === '/roots/gh/Echo' || d === '/roots/wx/Echo',
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000),
      scanRoots: [{ path: '/roots/gh', depth: 1 }, { path: '/roots/wx', depth: 1 }],
    })

    const s1 = await svc.getProjectsState()
    const ghProject = s1.projects.find(p => p.path === '/roots/gh/Echo')!
    const wxProject = s1.projects.find(p => p.path === '/roots/wx/Echo')!
    expect(ghProject.id).not.toBe(wxProject.id)
    expect(ghProject.id).toBe('echo') // 按路径排序后靠前的那个保留最短形式
    expect(wxProject.id).toBe('echo-wx') // 撞车后并入父目录名消歧

    expect(await svc.confirmStatus(wxProject.id, '企业微信那份收尾')).toBe(true)

    const stored = await loadProjectsFile(file)
    expect(stored.projects).toHaveLength(1)
    expect(stored.projects[0]?.repoPath).toBe('/roots/wx/Echo') // 落盘的是撞车的那一个,不是 gh 那份

    // gh/Echo 不受影响:重新汇总后依旧待整理、无状态。
    const s2 = await svc.getProjectsState()
    const ghAfter = s2.projects.find(p => p.path === '/roots/gh/Echo')!
    expect(ghAfter.status).toBeUndefined()
    expect(ghAfter.stage).toBe('待整理')
  })

  it('扫描根传入顺序反过来,id 分配结果不变(排序消除 readdir 顺序依赖)', async () => {
    const file = tempFile()
    const svc = createProjectsService({
      file,
      exec: async (args) => args[0] === 'rev-parse'
        ? { ok: true, stdout: 'main\n' }
        : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' },
      listDir: async (d: string) => {
        if (d === '/roots/gh') return ['/roots/gh/Echo']
        if (d === '/roots/wx') return ['/roots/wx/Echo']
        return []
      },
      isRepo: async (d: string) => d === '/roots/gh/Echo' || d === '/roots/wx/Echo',
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000),
      // 与上一条用例相反的顺序:wx 先于 gh 被扫到(模拟 readdir 顺序不稳定)
      scanRoots: [{ path: '/roots/wx', depth: 1 }, { path: '/roots/gh', depth: 1 }],
    })

    const state = await svc.getProjectsState()
    const ghProject = state.projects.find(p => p.path === '/roots/gh/Echo')!
    const wxProject = state.projects.find(p => p.path === '/roots/wx/Echo')!
    // 结果应与「传入顺序 gh→wx」那条用例一致:排序按路径而非扫描到达顺序。
    expect(ghProject.id).toBe('echo')
    expect(wxProject.id).toBe('echo-wx')
  })
})

describe('节流到期的读不等重扫(2026-08-31 风暴修复)', () => {
  it('过期后立即返回旧缓存,后台扫完下一次读拿到新结果;stale 期间只起一轮扫描', async () => {
    // 2026-08-31 真机定性(标签时灵时不灵一案):GET /state 会干等 build() 的那轮
    // findRepos+逐仓 git+codexSessionCwds,真机一轮 ~6 秒——页面每 30 秒瞎 6 秒。
    // 改成 stale-while-revalidate:节流到期的读立即回旧缓存,重扫放后台;
    // 冷启动(无缓存)和写路径 invalidate 之后仍然等真数据,那两处语义不动。
    let nowSec = Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000)
    let repos = ['/roots/gh/Aiboo']
    let gateOpen: Promise<void> = Promise.resolve() // 第一轮不拦
    let listDirCalls = 0
    const file = tempFile()
    const svc = createProjectsService({
      file,
      exec: async (args) => args[0] === 'rev-parse'
        ? { ok: true, stdout: 'main\n' }
        : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' },
      listDir: async (d: string) => {
        listDirCalls += 1
        await gateOpen
        return d === '/roots/gh' ? [...repos] : []
      },
      isRepo: async (d: string) => repos.includes(d),
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => nowSec,
      scanRoots: [{ path: '/roots/gh', depth: 1 }],
    })

    const s1 = await svc.getProjectsState()
    expect(s1.projects.map(p => p.path)).toEqual(['/roots/gh/Aiboo'])
    expect(listDirCalls).toBe(1)

    // 节流过期,世界也变了(多一个仓库),而且这轮扫描被闸门拦住——模拟真机那 6 秒。
    nowSec += 31
    repos = ['/roots/gh/Aiboo', '/roots/gh/Echo']
    let openGate!: () => void
    gateOpen = new Promise<void>((resolve) => { openGate = resolve })

    const raced = await Promise.race([
      svc.getProjectsState(),
      new Promise<'还在等扫描'>(resolve => setTimeout(() => resolve('还在等扫描'), 100)),
    ])
    if (raced === '还在等扫描') throw new Error('节流到期的读被慢扫描拖住了,没有立即返回旧缓存')
    expect(raced.projects.map(p => p.path)).toEqual(['/roots/gh/Aiboo']) // 回的是旧缓存

    // stale 期间再读两次:都该立即回旧缓存,并且共享同一轮后台扫描(总账在下面数)。
    await svc.getProjectsState()
    await svc.getProjectsState()

    openGate()
    const deadline = Date.now() + 1000
    for (;;) {
      const s = await svc.getProjectsState()
      if (s.projects.length === 2) break
      if (Date.now() > deadline) throw new Error('后台刷新没有落地:一直读不到新仓库')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    // 总账:第一轮 1 次 + 后台这轮 1 次。stale 期间的三四次读没有各起各的扫描
    // (listDir 的第一步在 build 里位于文件读取之后,只能在落地后数才不与时序赛跑)。
    expect(listDirCalls).toBe(2)
  })
})

describe('并发写不丢更新', () => {
  it('同时对两个不同项目 confirmStatus,完成后两条状态都落盘(写队列生效)', async () => {
    const file = tempFile()
    const svc = createProjectsService({
      file,
      exec: async (args) => args[0] === 'rev-parse'
        ? { ok: true, stdout: 'main\n' }
        : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' },
      listDir: async (d: string) => d === '/roots/gh' ? ['/roots/gh/Aiboo', '/roots/gh/Echo'] : [],
      isRepo: async (d: string) => d === '/roots/gh/Aiboo' || d === '/roots/gh/Echo',
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000),
      scanRoots: [{ path: '/roots/gh', depth: 1 }],
    })

    const before = await svc.getProjectsState()
    const aiboo = before.projects.find(p => p.path === '/roots/gh/Aiboo')!
    const echo = before.projects.find(p => p.path === '/roots/gh/Echo')!

    const [ok1, ok2] = await Promise.all([
      svc.confirmStatus(aiboo.id, 'Aiboo 状态'),
      svc.confirmStatus(echo.id, 'Echo 状态'),
    ])
    expect(ok1).toBe(true)
    expect(ok2).toBe(true)

    const stored = await loadProjectsFile(file)
    expect(stored.projects).toHaveLength(2)
    expect(stored.projects.find(p => p.id === aiboo.id)?.status?.text).toBe('Aiboo 状态')
    expect(stored.projects.find(p => p.id === echo.id)?.status?.text).toBe('Echo 状态')
  })
})

describe('projectsService · 扫描进度与按名字找(2026-09-23 引导先问交哪一个)', () => {
  function svcWith(exec: Parameters<typeof createProjectsService>[0]['exec'], execCalls: { n: number }) {
    return createProjectsService({
      file: tempFile(),
      exec: async (args, cwd) => { execCalls.n += 1; return exec(args, cwd) },
      listDir: async (d: string) => d === '/roots/gh' ? ['/roots/gh/Aiboo', '/roots/gh/desktop-workbench', '/roots/gh/notes'] : [],
      isRepo: async (d: string) => d === '/roots/gh/Aiboo' || d === '/roots/gh/desktop-workbench',
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000),
      scanRoots: [{ path: '/roots/gh', depth: 1 }],
    })
  }
  const okExec: Parameters<typeof createProjectsService>[0]['exec'] = async args => args[0] === 'rev-parse'
    ? { ok: true, stdout: 'main\n' }
    : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' }

  it('扫描进度:没扫时 scanning=false;扫的时候能看到 repos 阶段的 done/total/current;扫完记 finished_at', async () => {
    const seen: unknown[] = []
    const calls = { n: 0 }
    let svc: ReturnType<typeof createProjectsService> | undefined
    svc = svcWith(async (args, cwd) => {
      if (args[0] === 'rev-parse') seen.push(svc?.scanProgress?.())
      return okExec(args, cwd)
    }, calls)
    expect(svc.scanProgress?.()).toEqual({ scanning: false, done: 0 })
    // E(2026-09-23):项目区自己的扫描不推进这一份进度 —— 引导页不该因为项目区刷新就显示「在扫」。
    await svc.getProjectsState()
    expect(seen.every(item => (item as { scanning: boolean }).scanning === false)).toBe(true)
    expect(svc.scanProgress?.()).toEqual({ scanning: false, done: 0 })
    seen.length = 0
    // 引导里她主动发起的那一次才算。
    await svc.scanForOnboarding?.()
    expect(seen[0]).toMatchObject({ scanning: true, phase: 'repos', total: 2, done: 0, current: 'Aiboo' })
    expect(seen.at(-1)).toMatchObject({ scanning: true, phase: 'repos', total: 2, done: 1, current: 'desktop-workbench' })
    const after = svc.scanProgress?.()
    expect(after).toMatchObject({ scanning: false, done: 2, total: 2 })
    expect(after?.finished_at).toBeDefined()
  })

  it('locate:按目录名找(不分大小写、忽略 - _ 空格),不跑任何 git;路径直接认;找不到回空', async () => {
    const calls = { n: 0 }
    const svc = svcWith(okExec, calls)
    expect((await svc.locate?.('Desktop Workbench'))?.matches).toEqual([{ name: 'desktop-workbench', path: '/roots/gh/desktop-workbench' }])
    expect((await svc.locate?.('aiboo'))?.matches.map(m => m.name)).toEqual(['Aiboo'])
    expect((await svc.locate?.('notes'))?.matches).toEqual([])
    expect((await svc.locate?.('/roots/gh/Aiboo/'))?.matches).toEqual([{ name: 'Aiboo', path: '/roots/gh/Aiboo' }])
    expect(calls.n).toBe(0)
    expect(svc.scanProgress?.().scanning).toBe(false)
  })
})

/**
 * D/N(2026-09-23 统筹从零重装自跑):新机器一起服务项目区就把扫描根下 13 个仓库全扫了,
 * 引导最后录的「工作台」与自动建的 desktop-workbench 在索引里是两行。
 */
describe('projectsService · 门关着不扫;引导的那一次不写项目区缓存;引导录的项目就是那一行', () => {
  function gated(file: string, gate: { note: string | undefined }, probe: { listDir: number, exec: number }) {
    return createProjectsService({
      file,
      exec: async (args) => {
        probe.exec += 1
        return args[0] === 'rev-parse'
          ? { ok: true, stdout: 'main\n' }
          : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' }
      },
      listDir: async (d: string) => { probe.listDir += 1; return d === '/roots/gh' ? ['/roots/gh/Aiboo', '/roots/gh/desktop-workbench'] : [] },
      isRepo: async (d: string) => d === '/roots/gh/Aiboo' || d === '/roots/gh/desktop-workbench',
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000),
      scanRoots: [{ path: '/roots/gh', depth: 1 }],
      scanGate: () => gate.note,
    })
  }

  it('门关着:一个目录都不列、一条 git 都不跑、一条都不自动建,如实带 scan_blocked;门一开当场扫', async () => {
    const gate = { note: '还没授权看你的项目目录。' as string | undefined }
    const probe = { listDir: 0, exec: 0 }
    const svc = gated(tempFile(), gate, probe)
    const blocked = await svc.getProjectsState()
    expect(blocked.scan_blocked).toBe('还没授权看你的项目目录。')
    expect(blocked.projects).toEqual([])
    expect(probe).toEqual({ listDir: 0, exec: 0 })
    // 引导里她主动发起的那一次不看这道门(授权门在 http 层),但**不写项目区缓存**。
    const forOnboarding = await svc.scanForOnboarding?.()
    expect(forOnboarding?.projects.map(p => p.name)).toEqual(['Aiboo', 'desktop-workbench'])
    expect(svc.scanProgress?.()).toMatchObject({ scanning: false, done: 2, total: 2 })
    expect((await svc.getProjectsState()).scan_blocked).toBeDefined()
    // 门开了:不等 30 秒节流,下一次读就是真扫。
    gate.note = undefined
    const open = await svc.getProjectsState()
    expect(open.scan_blocked).toBeUndefined()
    expect(open.projects.map(p => p.name)).toEqual(['Aiboo', 'desktop-workbench'])
  })

  it('adopt:引导录的「工作台」按路径认领扫到的那一条 —— 同一个 id,项目区里一行,名字是他说的', async () => {
    const gate = { note: undefined as string | undefined }
    const probe = { listDir: 0, exec: 0 }
    const file = tempFile()
    const svc = gated(file, gate, probe)
    const scannedId = (await svc.getProjectsState()).projects.find(p => p.path === '/roots/gh/desktop-workbench')?.id
    expect(scannedId).toBe('desktop-workbench')
    expect(await svc.adopt?.({ name: '工作台', path: '/roots/gh/desktop-workbench/' })).toEqual({ id: 'desktop-workbench' })
    const after = await svc.getProjectsState()
    expect(after.projects.filter(p => p.path === '/roots/gh/desktop-workbench')).toEqual([
      expect.objectContaining({ id: 'desktop-workbench', name: '工作台' }),
    ])
    expect(after.projects).toHaveLength(2)
    // 门关着时也照样列出他亲口交的这一条(不列别的)。
    gate.note = '还没授权看你的项目目录。'
    svc.invalidateScanCache()
    const blocked = await svc.getProjectsState()
    expect(blocked.projects).toEqual([expect.objectContaining({ id: 'desktop-workbench', name: '工作台', path: '/roots/gh/desktop-workbench' })])
    // 再认领一次同一个路径:不新建。
    await svc.adopt?.({ name: '工作台', path: '/roots/gh/desktop-workbench' })
    expect((await loadProjectsFile(file)).projects).toHaveLength(1)
  })
})

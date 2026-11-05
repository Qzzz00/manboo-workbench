// @vitest-environment node
/**
 * 布局快照(2026-09-10,docs/设计-事务官记忆系统.md §一·五「工作台长什么样」那一族)。
 *
 * 三层各自的用例:
 * - 纯函数 renderLayoutSnapshot:同一份 state 渲两次逐字相同(不读时钟、不读盘);
 * - 路由 GET /snapshot/layout.md|.html:200 + 正确 content-type,只读;
 * - 落盘服务:到「下班」时刻落一份 layout-YYYY-MM-DD.{md,html},过期的清掉。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DockTab, ProjectsState, SceneView, WorkbenchLayout } from '../src/protocol.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { LayoutSnapshotInput } from '../src/server/layoutSnapshot.ts'
import {
  createLayoutSnapshotService,
  defaultLayoutSnapshotsDir,
  renderLayoutSnapshot,
} from '../src/server/layoutSnapshot.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-layout-snap-'))
  dirs.push(dir)
  return dir
}

/** 固定 state:模块两行三列 + 一个收起的、事务官浮窗拉过尺寸、叠里三枚标签、两个场景。 */
const LAYOUT: WorkbenchLayout = {
  modules: [
    { id: 'projects', order: 0, basis_pct: 34, row: 0, col: 0, width_pct: 60 },
    { id: 'usage', order: 1, basis_pct: 22, row: 0, col: 1, width_pct: 40 },
    { id: 'quota', order: 2, basis_pct: 12, row: 0, col: 1, width_pct: 40 },
    { id: 'slot', order: 3, basis_pct: 42, row: 1 },
    { id: 'notes', order: 4, basis_pct: 24, row: 2, width_pct: 40, hidden: true },
    { id: 'files', order: 5, basis_pct: 24, row: 2, width_pct: 60 },
  ],
  butler: { corner: 'br', min: true, size: { w_px: 250, h_px: 1130.46875 } },
  projects_view: 'board',
  board_axis: 'status-columns',
}

const STACK: readonly DockTab[] = [
  { key: 'claude', label: 'Claude', running: true, current: true },
  { key: 'kimi', label: 'Kimi', running: false, current: false },
  { key: 'wecom', label: '企业微信', running: true, current: false, im: 'wecom', dual: true },
]

const SCENES: readonly SceneView[] = [
  { id: 's1', name: '写代码', app_count: 3, saved_at: '2026-09-09T20:00:00+08:00' },
  { id: 's2', name: '开会', app_count: 0 },
]

function input(over: Partial<LayoutSnapshotInput> = {}): LayoutSnapshotInput {
  return {
    date: '2026-09-10',
    layout: LAYOUT,
    dock: { stack: STACK },
    apps: [{ key: 'claude', label: 'Claude' }, { key: 'finder', label: 'Finder' }],
    scenes: SCENES,
    ...over,
  }
}

describe('renderLayoutSnapshot(纯函数:固定 state → 固定 markdown/html)', () => {
  it('同一份 state 渲两次逐字相同——不读时钟、不读盘,日期只来自入参', () => {
    const first = renderLayoutSnapshot(input())
    const second = renderLayoutSnapshot(input())
    expect(second.markdown).toBe(first.markdown)
    expect(second.html).toBe(first.html)
    expect(first.markdown).toContain('2026-09-10')
  })

  it('markdown:模块表按 order 自上而下,带行/列/显隐/宽高,收起的如实标「收起」', () => {
    const { markdown } = renderLayoutSnapshot(input())
    const rows = markdown.split('\n').filter(line => line.startsWith('| ') && line.includes('`'))
    expect(rows.map(line => line.split('|')[1]?.trim())).toEqual([
      '项目区 (`projects`)',
      '消耗数据 (`usage`)',
      '余额 / 额度 (`quota`)',
      '窗口槽 (`slot`)',
      '随手记 (`notes`)',
      '系统文件夹 (`files`)',
    ])
    expect(rows[0]).toContain('| 60 |')
    expect(rows[0]).toContain('| 34 |')
    // 窗口槽那行独占一行、没有列号:两处都写「—」,不编 0。
    expect(rows[3]).toContain('| 1 | — |')
    expect(rows[4]).toContain('收起')
    expect(rows[5]).toContain('显示')
  })

  it('markdown:两个视图开关、事务官浮窗几何、叠、注册表、场景各一节', () => {
    const { markdown } = renderLayoutSnapshot(input())
    expect(markdown).toContain('`board`')
    expect(markdown).toContain('`status-columns`')
    expect(markdown).toContain('角落 `br`')
    expect(markdown).toContain('收起=是')
    expect(markdown).toContain('250×1130 px')
    expect(markdown).toContain('Claude, Kimi, 企业微信')
    expect(markdown).toContain('企业微信(双窗)')
    expect(markdown).toContain('Finder')
    expect(markdown).toContain('写代码(3 个应用')
    expect(markdown).toContain('开会(还没存过内容)')
    // 字段来源写在文件末尾(记忆纪律:每条都要有依据)。
    expect(markdown.trimEnd().split('\n## ').at(-1)).toContain('字段来源')
    expect(markdown).toContain('/state.layout')
  })

  it('html:骨架而已——顶栏 + grid 里的模块盒子 + 底栏,不是真实渲染', () => {
    const { html } = renderLayoutSnapshot(input())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('display:grid')
    for (const id of ['projects', 'usage', 'quota', 'slot', 'files']) {
      expect(html).toContain(`data-id='${id}'`)
    }
    // 收起的模块不占 grid 位,但要在底栏点名(否则「长什么样」少一块)。
    expect(html).toContain('已收起:随手记')
    expect(html).toContain('不是真实渲染')
    expect(html).toContain('Claude, Kimi, 企业微信')
  })

  it('layout 缺席(没存过自定义布局)时如实说明,不编默认值也不抛', () => {
    const { markdown, html } = renderLayoutSnapshot({ date: '2026-09-10' })
    expect(markdown).toContain('/state 里没有 layout')
    expect(markdown).toContain('(还没存过场景)')
    expect(html).toContain('/state 里没有 layout')
  })

  it('html 转义:场景名里的尖括号不破坏骨架', () => {
    const { html } = renderLayoutSnapshot(input({
      scenes: [{ id: 's3', name: '<script>x</script>', app_count: 1 }],
    }))
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

/** 假项目区服务:只为让 /state.layout 有东西,别的路径不该被这组用例走到。 */
function fakeProjects(layout: WorkbenchLayout | undefined): ProjectsService {
  const empty: ProjectsState = { projects: [], pending: [], scan_errors: [], scanned_at: '2026-09-10T18:30:00+08:00' }
  return {
    getProjectsState: async () => empty,
    confirmStatus: async () => false,
    setDdl: async () => false,
    addRule: async () => {},
    getLayout: async () => layout,
    setLayout: async () => {},
    invalidateScanCache: () => {},
  }
}

describe('GET /snapshot/layout.md|.html(只读,任何来源可读)', () => {
  // 参数不给默认值:`serve(undefined)` 会命中默认值,那条「没有 layout」的用例就白测了。
  async function serve(layout: WorkbenchLayout | undefined) {
    const service = createWorkbenchService()
    const server = await startWorkbenchServer({
      port: 0,
      service,
      tickIntervalMs: 0,
      projects: fakeProjects(layout),
    })
    started.push(server)
    return server.url
  }

  it('.md 回 200 + text/markdown,内容是当下 /state 的布局', async () => {
    const url = await serve(LAYOUT)
    const res = await fetch(`${url}/snapshot/layout.md`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const text = await res.text()
    expect(text).toContain('# 工作台布局')
    expect(text).toContain('`projects`')
  })

  it('.html 回 200 + text/html', async () => {
    const url = await serve(LAYOUT)
    const res = await fetch(`${url}/snapshot/layout.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('data-id=\'projects\'')
  })

  it('没接项目区(布局取不到)也是 200,如实说明没有 layout,不 500', async () => {
    const url = await serve(undefined)
    const res = await fetch(`${url}/snapshot/layout.md`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('/state 里没有 layout')
  })
})

describe('落盘服务(每天「下班」一次,默认 18:30;请求驱动 + single-flight,不起定时器)', () => {
  const AT_1830 = Date.parse('2026-09-10T18:30:00+08:00')
  const AT_1700 = Date.parse('2026-09-10T17:00:00+08:00')

  it('defaultLayoutSnapshotsDir 落在 ~/.dsh/workbench/snapshots', () => {
    expect(defaultLayoutSnapshotsDir('/Users/example')).toBe('/Users/example/.dsh/workbench/snapshots')
  })

  async function waitForFile(dir: string, name: string, ms = 2000): Promise<string> {
    const deadline = Date.now() + ms
    for (;;) {
      try {
        return await readFile(join(dir, name), 'utf8')
      }
      catch {
        if (Date.now() > deadline) throw new Error(`${name} 没有在期限内落盘`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  }

  it('到点后一拍落两份文件,内容与纯函数一致', async () => {
    const dir = tempDir()
    const svc = createLayoutSnapshotService({ dir, now: () => AT_1830 })
    svc.pump(async () => input())
    const md = await waitForFile(dir, 'layout-2026-09-10.md')
    const html = await waitForFile(dir, 'layout-2026-09-10.html')
    const expected = renderLayoutSnapshot(input())
    expect(md).toBe(expected.markdown)
    expect(html).toBe(expected.html)
  })

  it('没到点不落盘,也不去取 state(read 一次都不该被调用)', async () => {
    const dir = tempDir()
    let reads = 0
    const svc = createLayoutSnapshotService({ dir, now: () => AT_1700 })
    svc.pump(async () => { reads += 1; return input() })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(reads).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  it('「下班」时刻可配置:配成 09:00 时早上 17 点之前那一拍就该落盘', async () => {
    const dir = tempDir()
    const svc = createLayoutSnapshotService({ dir, now: () => AT_1700, offWorkAt: '09:00' })
    svc.pump(async () => input())
    await waitForFile(dir, 'layout-2026-09-10.md')
  })

  it('single-flight + 当天只落一次:连打十拍,read 只被调用一次', async () => {
    const dir = tempDir()
    let reads = 0
    const svc = createLayoutSnapshotService({ dir, now: () => AT_1830 })
    for (let i = 0; i < 10; i += 1) {
      svc.pump(async () => {
        reads += 1
        await new Promise(resolve => setTimeout(resolve, 5))
        return input()
      })
    }
    await waitForFile(dir, 'layout-2026-09-10.md')
    for (let i = 0; i < 10; i += 1) svc.pump(async () => { reads += 1; return input() })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(reads).toBe(1)
  })

  it('重启后不重新生成:目录里已有今天的文件就认它,read 不被调用', async () => {
    const dir = tempDir()
    await writeFile(join(dir, 'layout-2026-09-10.md'), '旧的', 'utf8')
    await writeFile(join(dir, 'layout-2026-09-10.html'), '旧的', 'utf8')
    let reads = 0
    const svc = createLayoutSnapshotService({ dir, now: () => AT_1830 })
    svc.pump(async () => { reads += 1; return input() })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(reads).toBe(0)
    expect(await readFile(join(dir, 'layout-2026-09-10.md'), 'utf8')).toBe('旧的')
  })

  it('只保留 14 天:第 14 天前的清掉,边界那天留着,不认识的文件不碰', async () => {
    const dir = tempDir()
    // 保留窗口 = 今天(09-10)往前数 14 天 → 08-28 留、08-27 清。
    for (const date of ['2026-08-27', '2026-08-28', '2026-09-09']) {
      await writeFile(join(dir, `layout-${date}.md`), 'x', 'utf8')
      await writeFile(join(dir, `layout-${date}.html`), 'x', 'utf8')
    }
    await writeFile(join(dir, '别人的文件.txt'), 'x', 'utf8')
    const svc = createLayoutSnapshotService({ dir, now: () => AT_1830 })
    svc.pump(async () => input())
    await waitForFile(dir, 'layout-2026-09-10.md')
    // 清理跟在生成之后,同一条 promise 上;等到目录里不再有 08-27 为止。
    const deadline = Date.now() + 2000
    for (;;) {
      const names = await readdir(dir)
      if (!names.includes('layout-2026-08-27.md')) {
        expect(names).toContain('layout-2026-08-28.md')
        expect(names).toContain('layout-2026-08-28.html')
        expect(names).toContain('layout-2026-09-09.md')
        expect(names).toContain('别人的文件.txt')
        expect(names).not.toContain('layout-2026-08-27.html')
        break
      }
      if (Date.now() > deadline) throw new Error('过期文件没有在期限内清掉')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })

  it('取 state 失败这一拍作罢:不落半份文件,冷却后还能再试', async () => {
    const dir = tempDir()
    let reads = 0
    const svc = createLayoutSnapshotService({ dir, now: () => AT_1830, failCooldownMs: 0 })
    svc.pump(async () => { reads += 1; throw new Error('composeState 炸了') })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await readdir(dir)).toEqual([])
    svc.pump(async () => { reads += 1; return input() })
    await waitForFile(dir, 'layout-2026-09-10.md')
    expect(reads).toBe(2)
  })
})

describe('纯净模式(2026-09-11)在快照里有一行', () => {
  it('pureMode 为 true 写「纯净」,缺省/false 写「完整」——这行让下班例程知道 Ben 现在看的是哪一种', () => {
    expect(renderLayoutSnapshot(input({ layout: { ...LAYOUT, pureMode: true } })).markdown).toContain('纯净模式:`开`')
    expect(renderLayoutSnapshot(input()).markdown).toContain('纯净模式:`关`')
  })
})

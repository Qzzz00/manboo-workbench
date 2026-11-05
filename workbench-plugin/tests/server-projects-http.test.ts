// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_COMMANDS } from '../src/server/apps.ts'
import WebSocket from 'ws'
import type { LiveMessage, WorkbenchState } from '../src/protocol.ts'
import { MIN_BUTLER_H_PX, MIN_BUTLER_W_PX } from '../src/protocol.ts'
import { parseDf } from '../src/server/machine.ts'
import { createProjectsService } from '../src/server/projectsService.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const NOW_SEC = Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-proj-http-'))
  dirs.push(dir)
  return join(dir, 'projects.json')
}

/** 一个仓库(Aiboo)+ 一条 Codex 会话 cwd 落在仓库外面(会先落进 pending)。 */
function fakeProjects(file: string) {
  return createProjectsService({
    file,
    exec: async (args) => args[0] === 'rev-parse'
      ? { ok: true, stdout: 'main\n' }
      : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' },
    listDir: async (d) => d === '/roots/gh' ? ['/roots/gh/Aiboo'] : [],
    isRepo: async (d) => d === '/roots/gh/Aiboo',
    codexHome: '/x',
    codexDeps: {
      listFiles: async () => ['/x/sessions/a.jsonl'],
      readFirstLine: async () => JSON.stringify({ type: 'session_meta', payload: { id: 'top-other', cwd: '/roots/other/Something', timestamp: '2026-08-19T00:00:00Z', source: 'cli' } }),
    },
    home: '/Users/example',
    now: () => NOW_SEC,
    scanRoots: [{ path: '/roots/gh', depth: 1 }],
    scanMinIntervalSec: 0,
  })
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

/** 连上 /live 并把收到的消息攒起来，仿 server-http.test.ts 的做法。 */
async function live(url: string) {
  const ws = new WebSocket(`${url.replace('http://', 'ws://')}/live`)
  const messages: LiveMessage[] = []
  ws.on('message', raw => messages.push(JSON.parse(String(raw)) as LiveMessage))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    messages,
    close: () => ws.close(),
    async waitFor(n: number) {
      const deadline = Date.now() + 2000
      while (messages.length < n) {
        if (Date.now() > deadline) throw new Error(`只收到 ${messages.length} 条消息，期望 ${n} 条`)
        await new Promise(r => setTimeout(r, 10))
      }
      return messages
    },
  }
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const file = tempFile()
  const projects = fakeProjects(file)
  const service = createWorkbenchService({ now: () => NOW_SEC })
  const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, projects, ...extra })
  started.push(server)
  return { server, service, projects, url: server.url, file }
}

describe('GET /state 挂项目区与机器采样', () => {
  it('/state 含 projects 与 machine', async () => {
    const machine = async () => ({
      disk_pct: 99, disk_free_gb: 7.7, mem_gb: 16, cpu_idle_pct: 54.3, sampled_at: '2026-08-20T00:00:00.000Z',
    })
    const { url } = await serve({ machine })

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.projects?.projects.some(p => p.name === 'Aiboo')).toBe(true)
    expect(state.machine).toEqual({
      disk_pct: 99, disk_free_gb: 7.7, mem_gb: 16, cpu_idle_pct: 54.3, sampled_at: '2026-08-20T00:00:00.000Z',
    })
  })

  it('machine 采样命令失败时 /state.machine 为 { error }，不编数(D13)', async () => {
    const runCommand = async () => ({ ok: false, stdout: '' })
    const machine = async () => {
      const df = await runCommand()
      return df.ok ? { disk_pct: 0, disk_free_gb: 0, mem_gb: 0, cpu_idle_pct: 0, sampled_at: '' } : { error: 'df 失败' }
    }
    const { url } = await serve({ machine })

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.machine).toEqual({ error: 'df 失败' })
  })

  it('某一部分取不到不拖垮整个 /state', async () => {
    const machine = async () => { throw new Error('挂了') }
    const { url } = await serve({ machine })

    const res = await fetch(`${url}/state`)
    expect(res.status).toBe(200)
    const state = await res.json() as WorkbenchState
    expect(state.machine).toBeUndefined()
    expect(state.sessions).toEqual([])
  })
})

describe('POST /project/status', () => {
  it('写入后再 GET 可见，review=confirmed', async () => {
    const { url } = await serve()
    const before = await (await fetch(`${url}/state`)).json() as WorkbenchState
    const id = before.projects!.projects.find(p => p.name === 'Aiboo')!.id

    const res = await post(url, '/project/status', { id, text: '性能分支收尾' })
    expect(res.status).toBe(200)

    const after = await (await fetch(`${url}/state`)).json() as WorkbenchState
    const project = after.projects!.projects.find(p => p.id === id)
    expect(project?.status).toMatchObject({ text: '性能分支收尾', review: 'confirmed', author: '你' })
  })

  it('未知项目 id 返回 404', async () => {
    const { url } = await serve()
    const res = await post(url, '/project/status', { id: '不存在', text: 'x' })
    expect(res.status).toBe(404)
  })
})

describe('POST /attribution/rule', () => {
  it('规则生效后，命中的 pending 组消失', async () => {
    const { url } = await serve()

    const before = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(before.projects?.pending.some(g => g.dir.includes('other'))).toBe(true)

    const res = await post(url, '/attribution/rule', { dir: '/roots/other', action: 'ignore' })
    expect(res.status).toBe(200)

    const after = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(after.projects?.pending.some(g => g.dir.includes('other'))).toBe(false)
  })
})

describe('POST /layout', () => {
  /**
   * 回归(2026-08-25 真机故障):迁移一开始只挂在 POST /layout 的**写**路径上,
   * 而落盘的旧布局在 GET /state 是原样透传的——部署后 usage 模块根本没出现,
   * 用户不主动拖一次布局就永远补不上。这条锁住"读路径也要迁移"。
   */
  it('GET /state 读出的布局也要补齐 usage,不能只在写路径迁移', async () => {
    const { url } = await serve()
    // 先写一份不含 usage 的旧布局(模拟 2026-08-25 之前的存档)
    const legacy = {
      modules: [
        { id: 'projects', order: 0, basis_pct: 34 },
        { id: 'slot', order: 1, basis_pct: 54 },
        { id: 'notes', order: 2, basis_pct: 12 },
      ],
      butler: { corner: 'br' as const, min: false },
    }
    expect((await post(url, '/layout', { layout: legacy })).status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    const ids = state.layout?.modules.map(m => m.id) ?? []
    expect(ids).toContain('usage')
    // 补上的那条要跟项目区同行,否则不是"顶部分栏"而是独占一行
    const usage = state.layout?.modules.find(m => m.id === 'usage')
    const projects = state.layout?.modules.find(m => m.id === 'projects')
    expect(usage?.row).toBe(projects?.row)
  })

  it('写读回环', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'slot', order: 0 }, { id: 'projects', order: 1, basis_pct: 60, hidden: false }],
      butler: { corner: 'br' as const, min: false },
    }

    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    // 2026-08-25 顶部分栏:迁移会补 usage/quota 并把 projects→usage→quota 排到最前
    // (分组按"排序后相邻"做,这三个必须连续),所以**绝对 order 不再守恒**,
    // 能守的是"存进去的模块都回来了、篇幅/收起状态没被改"。
    expect(state.layout?.butler).toEqual(layout.butler)
    const returned = state.layout?.modules ?? []
    for (const saved of layout.modules) {
      const back = returned.find(m => m.id === saved.id)
      expect(back).toBeDefined()
      if (saved.basis_pct !== undefined) expect(back?.basis_pct).toBe(saved.basis_pct)
      if (saved.hidden !== undefined) expect(back?.hidden).toBe(saved.hidden)
    }
    expect(returned.map(m => m.id)).toContain('usage')
    expect(returned.map(m => m.id)).toContain('quota')
  })

  // A6:事务官浮窗可拖动——pos 是 additive 可选字段,写读回环带着它一起过。
  it('butler.pos 写读回环', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false, pos: { x_pct: 40, y_pct: 12 } },
    }

    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.butler).toEqual({ corner: 'br', min: false, pos: { x_pct: 40, y_pct: 12 } })
  })

  it('butler.pos 越界(负数或超过 95)→ 落盘时 clamp 到 0–95', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false, pos: { x_pct: -20, y_pct: 999 } },
    }

    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.butler.pos).toEqual({ x_pct: 0, y_pct: 95 })
  })

  // W4:与上面 butler.pos 的越界 clamp 是同一类防护(存档里塞越界值、服务端读路径夹回来),
  // 但语义不同——pos 的上限是固定的 95%,而 size 的**下限**之所以必须在服务端也夹,是因为
  // 它守的是不可改清单第 1 条(叫停入口不能被拉没),不是单纯的数值合法性。服务端夹不了
  // 上限(上限依赖视口,服务端不知道屏幕多大),那部分留给客户端渲染时再夹一次
  // (Butler.tsx 的 clampButlerSize)——这不是漏夹,是分工。
  it('W4:butler.size 小于下限时抬回下限——直接打 JSON 绕不过叫停入口的保护', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false, size: { w_px: 1, h_px: 1 } },
    }

    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.butler.size).toEqual({ w_px: MIN_BUTLER_W_PX, h_px: MIN_BUTLER_H_PX })
  })

  it('butler.pos 形状不对(x_pct 不是数字)→ 400,不落盘', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false, pos: { x_pct: '40', y_pct: 12 } },
    }

    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(400)
  })

  it('没有 pos(旧存档/未拖动过)→ 缺省,读回时也没有这个字段(corner 兜底)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'tl' as const, min: false },
    }

    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.butler).toEqual({ corner: 'tl', min: false })
  })

  // 终审 F1:提议自动执行链路的硬前置——服务端持久化层必须自己按合法 id 集过滤,
  // 不能只靠客户端三个纯函数(moveModule/resizeModule/toggleHidden)单方面排除。
  it('未知模块 id(比如把 butler 塞进 modules[])→ 落盘时被剔除,不进 GET /state', async () => {
    const { url } = await serve()
    const sneaky = {
      modules: [
        { id: 'projects', order: 0, basis_pct: 44 },
        { id: 'butler', order: 1, basis_pct: 10, hidden: true },
        { id: '__proto__', order: 2 },
      ],
      butler: { corner: 'br' as const, min: false },
    }

    const res = await post(url, '/layout', { layout: sneaky })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    // 脏 id 被剔除;usage 是迁移补齐项(2026-08-25 顶部分栏)。
    expect(state.layout?.modules.map(m => m.id)).toEqual(['projects', 'usage', 'quota'])
    expect(state.layout?.modules.map(m => m.id)).not.toContain('butler')
  })

  it('basis_pct 越界(超过 70 或低于 8)→ 落盘时被 clamp 到 8–70(与客户端 resizeModule 同界)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [
        { id: 'projects', order: 0, basis_pct: 10000 },
        { id: 'notes', order: 1, basis_pct: -5 },
      ],
      butler: { corner: 'br' as const, min: false },
    }

    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    const modules = state.layout?.modules ?? []
    expect(modules.find(m => m.id === 'projects')?.basis_pct).toBe(70)
    expect(modules.find(m => m.id === 'notes')?.basis_pct).toBe(8)
  })

  it('butler.corner 非法值 → 400,不落盘（早已校验，这里锁住不回退）', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'center', min: false },
    }

    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(400)
  })

  // ── 横屏分栏把手(2026-09-18)。左栏宽度与横屏浮窗落点是 landscape 分支下的两个
  //    additive 可选字段,服务端的义务跟 butler.size 那条一样:**客户端夹过的,服务端
  //    自己也要夹**——直接拼 JSON 打过来能绕开客户端,存进一个自己拖不回来的界面。
  it('横屏左栏宽度 rail_pct 原样落盘并读得回来', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
      landscape: { modules: [{ id: 'slot', order: 0 }], rail_pct: 12 },
    }

    expect((await post(url, '/layout', { layout })).status).toBe(200)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.landscape?.rail_pct).toBe(12)
  })

  it('rail_pct 越界 → 夹回 5–30(同客户端拖拽那一端,两边同一个区间)', async () => {
    const { url } = await serve()
    const base = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
    }

    await post(url, '/layout', { layout: { ...base, landscape: { modules: [], rail_pct: 900 } } })
    let state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.landscape?.rail_pct).toBe(30)

    await post(url, '/layout', { layout: { ...base, landscape: { modules: [], rail_pct: -900 } } })
    state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.landscape?.rail_pct).toBe(5)
  })

  it('rail_pct 不是有限数字 → 400,不落盘(不悄悄换成一个默认值)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
      landscape: { modules: [], rail_pct: 'wide' },
    }

    expect((await post(url, '/layout', { layout })).status).toBe(400)
  })

  it('横屏那份浮窗落点 landscape.butler_pos 跟顶层 butler.pos 同一套夹法(0–95)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false, pos: { x_pct: 10, y_pct: 10 } },
      landscape: { modules: [], butler_pos: { x_pct: -20, y_pct: 999 } },
    }

    expect((await post(url, '/layout', { layout })).status).toBe(200)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.landscape?.butler_pos).toEqual({ x_pct: 0, y_pct: 95 })
    // 竖屏那一份**没被顺手改掉**:两个方向各记各的落点。
    expect(state.layout?.butler.pos).toEqual({ x_pct: 10, y_pct: 10 })
  })

  it('两个字段都缺席(旧存档/从没在横屏上拖过)→ 照旧 200,读回时也没有这两个键', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
      landscape: { modules: [{ id: 'slot', order: 0 }] },
    }

    expect((await post(url, '/layout', { layout })).status).toBe(200)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.landscape?.rail_pct).toBeUndefined()
    expect(state.layout?.landscape?.butler_pos).toBeUndefined()
    expect(state.layout?.landscape?.modules.map(m => m.id)).toEqual(['slot'])
  })

  // ── 横屏模块挪区(2026-09-20)。region / side_pct 是 LayoutModule 上的两个 additive
  //    可选字段,规矩同上面那两条:缺席不该被拒、带了就必须形状对、数值自己再夹一遍。
  it('region=side 原样落盘并读得回来(挪到项目区下面那一格)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
      landscape: {
        modules: [
          { id: 'slot', order: 0 },
          { id: 'projects', order: 1, side_pct: 50 },
          { id: 'usage', order: 2, region: 'side', side_pct: 30 },
          { id: 'quota', order: 3, region: 'deck' },
        ],
      },
    }

    expect((await post(url, '/layout', { layout })).status).toBe(200)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    const modules = state.layout?.landscape?.modules ?? []
    expect(modules.find(m => m.id === 'usage')?.region).toBe('side')
    expect(modules.find(m => m.id === 'usage')?.side_pct).toBe(30)
    expect(modules.find(m => m.id === 'quota')?.region).toBe('deck')
  })

  it('缺 region 的旧存档照旧 200,读回来也没有这个键(= 全在底部一排)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
      landscape: { modules: [{ id: 'usage', order: 0, basis_pct: 24, width_pct: 25 }] },
    }

    expect((await post(url, '/layout', { layout })).status).toBe(200)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.landscape?.modules[0]?.region).toBeUndefined()
  })

  it('region 认不出的值 → 400,不落盘(不悄悄换成一个默认值)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
      landscape: { modules: [{ id: 'usage', order: 0, region: 'floating' }] },
    }

    expect((await post(url, '/layout', { layout })).status).toBe(400)
  })

  it('side_pct 越界 → 夹回 14–80(同客户端拖那根横把手的那一端)', async () => {
    const { url } = await serve()
    const base = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
    }

    await post(url, '/layout', {
      layout: { ...base, landscape: { modules: [{ id: 'usage', order: 0, region: 'side', side_pct: 900 }] } },
    })
    let state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.landscape?.modules[0]?.side_pct).toBe(80)

    await post(url, '/layout', {
      layout: { ...base, landscape: { modules: [{ id: 'usage', order: 0, region: 'side', side_pct: -5 }] } },
    })
    state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.landscape?.modules[0]?.side_pct).toBe(14)
  })

  it('side_pct 不是数字 → 400(同 rail_pct 那条:形状不对就明确报错)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'projects', order: 0 }],
      butler: { corner: 'br' as const, min: false },
      landscape: { modules: [{ id: 'usage', order: 0, side_pct: 'tall' }] },
    }

    expect((await post(url, '/layout', { layout })).status).toBe(400)
  })
})

describe('POST /activate', () => {
  it('已知 app 调 runCommand 一次', async () => {
    const calls: (readonly string[])[] = []
    const runCommand = async (cmd: readonly string[]) => { calls.push(cmd); return { ok: true, stdout: '' } }
    const { url } = await serve({ runCommand })

    const res = await post(url, '/activate', { app: 'claude' })
    expect(res.status).toBe(200)
    expect(calls).toEqual([APP_COMMANDS.claude])
  })

  it('未知 app 返回 404', async () => {
    const runCommand = async () => ({ ok: true, stdout: '' })
    const { url } = await serve({ runCommand })

    const res = await post(url, '/activate', { app: '不存在的app' })
    expect(res.status).toBe(404)
  })

  it('app="__proto__"（或 constructor/toString/hasOwnProperty/valueOf）不走原型链，404 而不是 500', async () => {
    const runCommand = async () => ({ ok: true, stdout: '' })
    const { url } = await serve({ runCommand })

    for (const app of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const res = await post(url, '/activate', { app })
      expect(res.status).toBe(404)
    }
  })
})

describe('POST /pause', () => {
  it('翻转 paused', async () => {
    const { url } = await serve()

    expect((await (await fetch(`${url}/state`)).json() as WorkbenchState).paused).toBe(false)

    const first = await post(url, '/pause', {})
    expect(first.status).toBe(200)
    expect((await (await fetch(`${url}/state`)).json() as WorkbenchState).paused).toBe(true)

    const second = await post(url, '/pause', {})
    expect(second.status).toBe(200)
    expect((await (await fetch(`${url}/state`)).json() as WorkbenchState).paused).toBe(false)
  })
})

describe('旧广播三处改走 composeState（否则 WS snapshot 整体替换会丢 projects/machine/paused）', () => {
  it('POST /statusline 成功后，WS 收到的快照帧仍带 projects 字段', async () => {
    const { url } = await serve()
    const client = await live(url)
    await client.waitFor(1) // 连上先收到的整份快照

    const payload = {
      session_id: 'abc123',
      cwd: '/Users/example/Documents/GitHub/desktop-workbench',
      transcript_path: '/Users/example/.claude/projects/x/abc123.jsonl',
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    }
    const res = await fetch(`${url}/statusline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)

    const messages = await client.waitFor(2)
    const pushed = messages[1]
    expect(pushed?.kind).toBe('snapshot')
    expect(pushed?.kind === 'snapshot' && pushed.state.projects?.projects.some(p => p.name === 'Aiboo')).toBe(true)
    client.close()
  })
})

describe('parseDf', () => {
  it('喂真实 df -k /System/Volumes/Data 样例(2026-08-20 实测)，换算出 pct 与 free_gb', () => {
    const sample = [
      'Filesystem   1024-blocks      Used Available Capacity iused    ifree %iused  Mounted on',
      '/dev/disk3s5   482797652 438698808   8080660    99% 4199019 80806600    5%   /System/Volumes/Data',
    ].join('\n')

    const result = parseDf(sample)
    expect(result.pct).toBe(99)
    expect(result.free_gb).toBeCloseTo(8080660 / 1024 / 1024, 3)
  })

  it('设备名太长折行时，数值挪到下一行开头，仍能按同样的方式换算出 pct 与 free_gb', () => {
    const sample = [
      'Filesystem   1024-blocks      Used Available Capacity iused    ifree %iused  Mounted on',
      '/dev/disk1s1really-long-external-volume-name-that-wraps-onto-its-own-line',
      '             482797652 438698808   8080660    99% 4199019 80806600    5%   /System/Volumes/Data',
    ].join('\n')

    const result = parseDf(sample)
    expect(result.pct).toBe(99)
    expect(result.free_gb).toBeCloseTo(8080660 / 1024 / 1024, 3)
  })
})

describe('POST /layout · pureMode(2026-09-11 纯净模式开关落盘)', () => {
  it('★pureMode 写读回环:true 存得进、读得回;缺省时字段不出现(旧存档读进来即完整模式)', async () => {
    const { url } = await serve()
    const layout = {
      modules: [{ id: 'slot', order: 0 }],
      butler: { corner: 'br' as const, min: false },
      pureMode: true,
    }
    expect((await post(url, '/layout', { layout })).status).toBe(200)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.layout?.pureMode).toBe(true)

    const { pureMode: _dropped, ...withoutFlag } = layout
    expect((await post(url, '/layout', { layout: withoutFlag })).status).toBe(200)
    const again = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(again.layout?.pureMode).toBeUndefined()
  })

  it('pureMode 不是布尔值 → 400,不悄悄丢掉一个写坏的值', async () => {
    const { url } = await serve()
    const layout = { modules: [{ id: 'slot', order: 0 }], butler: { corner: 'br', min: false }, pureMode: 'yes' }
    const res = await post(url, '/layout', { layout })
    expect(res.status).toBe(400)
    expect(String((res.body as { error: string }).error)).toContain('pureMode')
  })
})

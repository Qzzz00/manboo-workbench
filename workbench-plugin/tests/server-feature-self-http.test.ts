// @vitest-environment node
/**
 * 断点 B 与 C 那三条路由(2026-09-23):
 *
 *   /feature/result  派出去那件子事项跑完了,结果自己回到卡上
 *   /feature/branch  派活之前先开分支(只对「项目 = 这个仓库」开门)
 *   /feature/ship    验收通过之后那条闭环(八步,每一步失败就停)
 *
 * 这一份钉的性质:
 *
 * 1. **退出码不给默认值**、`cwd` 必须在项目里 —— 两样都是入口处就拒绝;
 * 2. 结果落进 `docs/需求/<名>/结果-<子事项>.md`,`/feature/docs` 里看得到摘要;
 * 3. **判据**:项目不是工作台自己时,`/feature/branch` 与 `/feature/ship` 如实回一句为什么,
 *    不是一颗按了没反应的按钮;
 * 4. **失败停下时三件事一件不少**:卡上标出、收件箱一条**带原话**、
 *    卡挂成「阻塞 · 出错」(座机那一通 `failed` 靠的就是它);
 * 5. 成功时卡推到「记录」态。
 *
 * ★ **发版脚本与 `/update/apply` 全是假的**:`selfUpdate` 那三样是注进来的,
 *   这一份里一次都没有真跑过(八步本体的真 git 在 `server-self-ship.test.ts`)。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectsState, TaskView } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'
import { taskCallOutEvent } from '../src/server/callOut.ts'
import { FEATURE_DIR_REL } from '../src/server/featureRun.ts'
import {
  EVOLUTION_LOG_REL, EVOLUTION_PENDING, PUBLISH_SCRIPT_REL, SELF_PACKAGE_NAME, SELF_PACKAGE_REL,
} from '../src/server/selfUpdate.ts'
import { APPLY_TRIGGERED_NOTE } from '../src/server/selfShip.ts'
import type { SelfShipResult } from '../src/server/selfShip.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-23T09:00:00Z') / 1000)
const NEED = '时钟大一号'
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeProjects(path: string): ProjectsService {
  const state: ProjectsState = {
    projects: [{
      id: 'p-1',
      name: '工作台',
      stage: 'dev' as never,
      path,
      links: [],
      session_count: 0,
      idle: true,
    }],
    pending: [],
    scan_errors: [],
    scanned_at: '',
  }
  return { getProjectsState: async () => state, getLayout: async () => undefined } as unknown as ProjectsService
}

interface Bag {
  url: string
  repo: string
  featureDir: string
  id: string
  tasks: ReturnType<typeof createTasksService>
  calls: string[]
  published: number
  applied: number
}

async function serve(opts: {
  /** 这个项目是不是工作台自己(判据那两个文件在不在)。 */
  self?: boolean
  /** 注不注 `runInCwd`。不注 = 「改自己」那条路整块不启用。 */
  runner?: boolean
  /** 注不注发版与热更新那三样。 */
  shipDeps?: boolean
  /** 假的八步结果(`/feature/ship` 其实跑的是真 `runSelfShip`,所以这里改的是命令的回答)。 */
  redTest?: boolean
  changed?: string[]
} = {}): Promise<Bag> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-feature-self-'))
  dirs.push(dir)
  const repo = join(dir, '她的项目')
  mkdirSync(repo, { recursive: true })
  if (opts.self !== false) {
    mkdirSync(join(repo, 'deploy'), { recursive: true })
    writeFileSync(join(repo, PUBLISH_SCRIPT_REL), '#!/usr/bin/env bash\n', 'utf8')
    mkdirSync(join(repo, 'workbench-plugin'), { recursive: true })
    writeFileSync(
      join(repo, SELF_PACKAGE_REL),
      `${JSON.stringify({ name: SELF_PACKAGE_NAME, version: '0.2.64' }, null, 2)}\n`,
      'utf8',
    )
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs/发版记录.md'), [
      '# 发版记录',
      '',
      '一版一行。',
      '',
      '| 版本 | 日期 | 你会看到什么 | 交接 |',
      '|---|---|---|---|',
      '| 0.2.64 | 09-23 | 老的那一版 | 交接-0922.md |',
      '',
    ].join('\n'), 'utf8')
  }

  const calls: string[] = []
  let published = 0
  let applied = 0
  const changed = opts.changed ?? ['workbench-plugin/src/clock.ts']

  const bag = { calls, get published() { return published }, get applied() { return applied } }

  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    projects: fakeProjects(repo),
    butlerSession: { open: async () => 'sess-1', say: async () => true },
    ...(opts.runner === false
      ? {}
      : {
          runInCwd: async (input) => {
            const key = [input.cmd, ...input.args].join(' ')
            calls.push(key)
            if (key.includes('diff --name-only')) return { code: 0, out: changed.join('\n') }
            if (key.includes('status --short')) return { code: 0, out: ' M workbench-plugin/src/clock.ts' }
            if (key.includes('diff --stat')) return { code: 0, out: ' 1 file changed' }
            if (key.startsWith('pnpm')) {
              return opts.redTest === true && key === 'pnpm vitest run'
                ? { code: 1, out: 'FAIL tests/clock.test.ts\n  1 failed' }
                : { code: 0, out: 'ok' }
            }
            if (key.startsWith('git worktree list')) return { code: 0, out: '' }
            // 这条分支还不存在(`--verify --quiet` 找不到就是非 0)—— 所以该走 `-b`。
            if (key.startsWith('git rev-parse --verify')) return { code: 1, out: '' }
            if (key.startsWith('git worktree add')) return { code: 0, out: 'Preparing worktree' }
            if (key.startsWith('npm test')) return { code: 0, out: 'Tests  3 passed' }
            // `npm version patch` 在这一份里是假的:只把 package.json 里那一行改掉。
            // 真跑 npm 会去碰网与缓存,而这一份要验的是**路由与停下来之后那三件事**。
            if (key.startsWith('npm version')) {
              const path = join(repo, SELF_PACKAGE_REL)
              writeFileSync(path, readFileSync(path, 'utf8').replace('0.2.64', '0.2.65'), 'utf8')
              return { code: 0, out: 'v0.2.65' }
            }
            return { code: 0, out: '' }
          },
        }),
    ...(opts.shipDeps === false
      ? {}
      : {
          selfUpdate: {
            publish: async () => { published += 1; return { code: 0, out: '发好了(假的)' } },
            // **回的只是"作业起来了没有"**:真那一下会把这个进程换掉,等不到结果(见 selfShip.ts)。
            applyUpdate: async () => { applied += 1; return { ok: true } },
            home: '/Users/nobody',
          },
        }),
  })
  started.push(server)

  // 显式落「待办」:/feature/* 这条闭环的失败那一步要把卡挂「阻塞」,「待排」到不了「阻塞」(转换表)。
  const created = await post(server.url, '/task/create', { title: NEED, kind: 'feature', project_id: 'p-1', status: 'todo' })
  const id = String(created.body.id)
  await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
  return {
    url: server.url,
    repo,
    featureDir: join(repo, FEATURE_DIR_REL, NEED),
    id,
    tasks,
    calls,
    get published() { return bag.published },
    get applied() { return bag.applied },
  } as Bag
}

/**
 * 「他在页面上点的那一下」。带 `Origin` 是有意的(2026-09-28,卡 BS):
 * **发版只有她本人按得动**,事务官与派出去的别家打 `/feature/ship` 一律 403
 * (`src/server/herself.ts`;专钉那道门的用例在 `tests/server-herself-gate.test.ts`)。
 */
async function post(url: string, path: string, body: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('/feature/result', () => {
  it('落一份 结果-<子事项>.md,里面有退出码、改了哪些文件、测试、「没截」', async () => {
    const bag = await serve()
    const result = await post(bag.url, '/feature/result', {
      id: bag.id,
      item: '改样式',
      exit_code: 0,
      hand: 'Codex',
      log: Array.from({ length: 220 }, (_, i) => `第 ${i + 1} 行`).join('\n'),
    })
    expect(result.status).toBe(200)
    const text = readFileSync(join(bag.featureDir, '结果-改样式.md'), 'utf8')
    expect(text).toContain('- 成没成:**成了**(退出码 0)')
    expect(text).toContain('- 谁做的:Codex')
    expect(text).toContain('workbench-plugin/src/clock.ts')
    expect(text).toContain('没截')
    // 日志只留最后 200 行,砍掉的如实说。
    expect(text).toContain('(前面还有 20 行没贴)')
    expect(text).not.toContain('第 1 行\n')
  })

  it('**退出码不给默认值**:不是整数就 400,一个字节都不落盘', async () => {
    const bag = await serve()
    const result = await post(bag.url, '/feature/result', { id: bag.id, item: '改样式' })
    expect(result.status).toBe(400)
    expect(String(result.body.error)).toContain('exit_code')
  })

  it('`cwd` 出了这个项目就 400(不给一把在任何目录里跑 git 的钥匙)', async () => {
    const bag = await serve()
    const result = await post(bag.url, '/feature/result', {
      id: bag.id, item: '改样式', exit_code: 0, cwd: '/etc',
    })
    expect(result.status).toBe(400)
    expect(String(result.body.error)).toContain('必须在这个项目里')
  })

  it('子事项名当不了文件名就 400', async () => {
    const bag = await serve()
    const result = await post(bag.url, '/feature/result', { id: bag.id, item: '../逃', exit_code: 0 })
    expect(result.status).toBe(400)
  })

  it('「验收」页签看得到那几行摘要(/feature/docs 回 results)', async () => {
    const bag = await serve()
    await post(bag.url, '/feature/result', { id: bag.id, item: '改样式', exit_code: 0 })
    await post(bag.url, '/feature/result', { id: bag.id, item: '跑测试', exit_code: 3 })
    const docs = await post(bag.url, '/feature/docs', { id: bag.id })
    const results = docs.body.results as { item: string, ok: boolean, summary: string }[]
    expect(results.map(one => one.item)).toEqual(['改样式', '跑测试'])
    expect(results[1]?.ok).toBe(false)
    expect(results[1]?.summary).toContain('退出码 3')
    // 这条需求改的是不是工作台自己,也在同一份回答里(界面据此决定画不画那颗按钮)。
    expect(docs.body.self).toBe(true)
  })
})

describe('判据:只对「项目 = 这个仓库」开门', () => {
  it('不是工作台自己时如实回一句为什么(不是一颗按了没反应的按钮)', async () => {
    const bag = await serve({ self: false })
    const branch = await post(bag.url, '/feature/branch', { id: bag.id })
    expect(branch.status).toBe(409)
    expect(String(branch.body.error)).toContain('改的不是工作台自己')
    expect(String(branch.body.error)).toContain(PUBLISH_SCRIPT_REL)

    const ship = await post(bag.url, '/feature/ship', { id: bag.id, notes: '随便' })
    expect(ship.status).toBe(409)
  })

  it('没接命令执行器 = 这条路整块不启用(404)', async () => {
    const bag = await serve({ runner: false })
    expect((await post(bag.url, '/feature/branch', { id: bag.id })).status).toBe(404)
  })

  it('没接发版与热更新 = 开得了分支,但发不了版(404)', async () => {
    const bag = await serve({ shipDeps: false })
    expect((await post(bag.url, '/feature/branch', { id: bag.id })).status).toBe(200)
    const ship = await post(bag.url, '/feature/ship', { id: bag.id, notes: '随便' })
    expect(ship.status).toBe(404)
    expect(String(ship.body.error)).toContain('没启用')
  })

  /**
   * ★ 这一条是 2026-09-23 那张接线卡的由来:上一版 `src/index.ts` 没把 `selfUpdate`
   * 传进来,于是 `/feature/ship` 在真机上**一律 404**。接上之后这条路真的可调 ——
   * 这里钉的就是"接上了就不再 404"(生产那一侧同样传了这两样,见 index.ts 的 selfUpdate)。
   */
  it('★接上发版与热更新之后,/feature/ship **不再 404**', async () => {
    const bag = await serve()
    const ship = await post(bag.url, '/feature/ship', { id: bag.id, notes: '时钟大了一号' })
    expect(ship.status).toBe(200)
    expect(ship.body.error).toBeUndefined()
    expect(ship.body.ok).toBe(true)
  })
})

describe('/feature/branch', () => {
  it('开 feat/<slug>,worktree 落 .claude/worktrees/<slug>,并记在卡上', async () => {
    const bag = await serve()
    const result = await post(bag.url, '/feature/branch', { id: bag.id })
    expect(result.status).toBe(200)
    expect(result.body.branch).toBe(`feat/${NEED}`)
    expect(result.body.worktree).toBe(join(bag.repo, '.claude/worktrees', NEED))
    expect(bag.calls).toContain(`git worktree add ${join(bag.repo, '.claude/worktrees', NEED)} -b feat/${NEED}`)

    const task = (await bag.tasks.list()).tasks.find(one => one.id === bag.id)
    expect(task?.self_ship?.status).toBe('branched')
    expect(task?.self_ship?.branch).toBe(`feat/${NEED}`)
  })
})

describe('/feature/ship', () => {
  it('人话没带时从 需求.md 的「目标」那一行取', async () => {
    const bag = await serve()
    await post(bag.url, '/feature/doc/save', {
      id: bag.id,
      tab: '需求',
      text: '# 需求\n\n- 目标:座机页的时钟大了一号\n- 边界:只改样式\n',
    })
    const result = await post(bag.url, '/feature/ship', { id: bag.id })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    const log = readFileSync(join(bag.repo, 'docs/发版记录.md'), 'utf8')
    expect(log).toContain('座机页的时钟大了一号')
  })

  it('需求.md 与 notes 两头都没有 —— 400,**一个字都不编**', async () => {
    const bag = await serve()
    const result = await post(bag.url, '/feature/ship', { id: bag.id })
    expect(result.status).toBe(400)
    expect(String(result.body.error)).toContain('不能编一个')
  })

  it('跑完之后卡推到「记录」态,发版与热更新各只发生一次', async () => {
    const bag = await serve()
    const result = await post(bag.url, '/feature/ship', { id: bag.id, notes: '时钟大了一号' })
    expect(result.body.ok).toBe(true)
    expect(bag.published).toBe(1)
    expect(bag.applied).toBe(1)
    const task = (await bag.tasks.list()).tasks.find(one => one.id === bag.id)
    expect(task?.feature_stage).toBe('记录')
    expect(task?.self_ship?.status).toBe('ok')
    expect(task?.self_ship?.version).toBe('0.2.65')
  })

  /**
   * ★ **回包不等**(2026-09-23 统筹定的那一条)。
   *
   * 第 ⑧ 步那一下会把跑着这条请求的进程换掉并重启,所以这条响应必须在**重启之前**
   * 就发出去,而且**不能**在里面等版本号 —— 等的话她按下「通过」看到的是一次超时。
   * 这里钉的就是那句话:`{ ok:true, note:'已触发热更新,重启后见' }`。
   */
  it('★热更新按下就回:`{ok:true, note:\'已触发热更新,重启后见\'}`,不等版本号', async () => {
    const bag = await serve()
    const result = await post(bag.url, '/feature/ship', { id: bag.id, notes: '时钟大了一号' })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.note).toBe(APPLY_TRIGGERED_NOTE)
    expect(result.body.version).toBe('0.2.65')
    // 记录那一步在更新之前就跑完了 —— 进化日志与决策记录此刻都已经在盘上。
    expect(existsSync(join(bag.repo, EVOLUTION_LOG_REL))).toBe(true)
    expect(readFileSync(join(bag.repo, EVOLUTION_LOG_REL), 'utf8')).toContain(`- 状态:${EVOLUTION_PENDING}`)
  })

  it('测试红 —— 卡上标出、收件箱一条**带原话**、挂成「阻塞 · 出错」(座机那一通靠它)', async () => {
    const bag = await serve({ redTest: true })
    const result = await post(bag.url, '/feature/ship', { id: bag.id, notes: '时钟大了一号' })
    expect(result.body.ok).toBe(false)
    expect(result.body.stopped_at).toBe('test')
    expect(String(result.body.note)).toContain('1 failed')
    // ① 卡上
    const task = (await bag.tasks.list()).tasks.find(one => one.id === bag.id)
    expect(task?.self_ship?.status).toBe('failed')
    expect(task?.self_ship?.stopped_at).toBe('test')
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('error')
    expect(task?.note).toContain('1 failed')
    // ② 收件箱
    const inbox = deriveButlerInbox({
      tasks: { tasks: [task as never], sprints: [], modules: [], project_meta: [] },
      sessions: [],
    })
    const one = inbox.items.find(item => item.kind === 'ship')
    expect(one?.title).toContain('全量测试')
    expect(one?.note).toContain('1 failed')
    expect(one?.wait_reason).toBe('error')
    // ③ 座机:blocked + error → 一通 failed(走既有那条路,没另造一条)
    expect(taskCallOutEvent({ ...(task as TaskView), direction: 'mine' })?.reason).toBe('failed')
    // **发版那一下一次都没发生**
    expect(bag.published).toBe(0)
    expect(bag.applied).toBe(0)
  })

  it('硬边界:分支上改了 deploy/ —— 停在第一步,测试与发版一条都没发出去', async () => {
    const bag = await serve({ changed: ['workbench-plugin/src/a.ts', 'deploy/publish-update.sh'] })
    const result = await post(bag.url, '/feature/ship', { id: bag.id, notes: '时钟大了一号' })
    expect(result.body.ok).toBe(false)
    expect(result.body.stopped_at).toBe('guard')
    expect(String(result.body.note)).toContain('deploy/publish-update.sh')
    expect(bag.calls.filter(one => one.startsWith('pnpm'))).toEqual([])
    expect(bag.calls.filter(one => one.includes('git merge'))).toEqual([])
    expect(bag.published).toBe(0)
  })

  it('硬边界:改了 ~/.dsh 下的东西也停', async () => {
    const bag = await serve({ changed: ['workbench-plugin/src/a.ts', '~/.dsh/AGENTS.md'] })
    const result = await post(bag.url, '/feature/ship', { id: bag.id, notes: 'x' })
    expect(result.body.stopped_at).toBe('guard')
    expect(String(result.body.note)).toContain('~/.dsh')
  })

  it('八步那份清单原样回给界面(卡上要画的就是它)', async () => {
    const bag = await serve({ redTest: true })
    const result = await post(bag.url, '/feature/ship', { id: bag.id, notes: 'x' })
    const steps = result.body.steps as SelfShipResult['steps']
    // ★ record 在 apply **前面**(2026-09-23 改的顺序,见 selfShip.ts 文件头)。
    expect(steps.map(one => one.id)).toEqual(['guard', 'test', 'merge', 'version', 'commit', 'publish', 'record', 'apply'])
    expect(steps[0]?.status).toBe('ok')
    expect(steps[1]?.status).toBe('failed')
    expect(steps[2]?.status).toBe('pending')
  })
})

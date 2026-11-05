// @vitest-environment node
/**
 * 整条链路走一遍:**那句话 → 复述 → 确认 → 派出去干活 → 标签出现 → 点开真能用**
 * (2026-09-21,分支 feat/custom-module-container)。
 *
 * 上面那几份用例各钉一段;这一份钉的是**接缝**——每一段的出口正好是下一段的入口。
 * 链路上任何一处改了形状(比如产出规范里的目录变了、清单不再进 /state),这一条会红,
 * 而分段的那些照样绿。
 *
 * 「那一家干活」那一步由这份用例**扮演**:它照着服务端派出去的那条产出规范,
 * 把 `docs/assets/自定义模块-样例-番茄钟/` 那两个文件抄进 `modules/<id>/` ——
 * 抄的是仓库里那份真样例,不是另写一份简化版。**规范写错了这里就抄不对**。
 *
 * 带 `WB_SHOT=<目录>` 跑时,顺带用无头 Chrome 把模块页面截一张图(交接第三节那张)。
 * 不带就跳过截图,链路照跑 —— CI 与日常全量跑不依赖这台机器上装没装 Chrome。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { DEV_TOOL_DRAFT, type WorkbenchState } from '../src/protocol.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createCustomModulesService } from '../src/server/modules.ts'
import { createDevToolStore } from '../src/server/devTool.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { createNotesService } from '../src/server/notes.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-21T04:40:00Z') / 1000)
const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE_DIR = join(HERE, '..', '..', 'docs', 'assets', '自定义模块-样例-番茄钟')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('从那句话到标签出现', () => {
  it('★一条链路走通:说一句 → 事务官复述 → 确认 → 派给能写代码的那一家 → 写盘 → 标签出现 → 页面能用', async () => {
    // ── 0. 一台干净的工作台(全部落在临时目录里,**一行都不碰 ~/.dsh**) ──
    const home = mkdtempSync(join(tmpdir(), 'wb-chain-'))
    dirs.push(home)
    const modulesDir = join(home, 'modules')
    mkdirSync(modulesDir, { recursive: true })
    const store = createDevToolStore({ file: join(home, 'dev-tools.json') })
    await store.load()
    /**
     * **派出去的那一家**收到的交代(= 产出规范)。这份用例接下来照着它干活。
     *
     * ★ 2026-10-01(设计 C2):以前这一份是从 `butlerSession.open` 收的 —— 事务官自己在
     * 她那条会话里写网页。现在事务官只写交代 + 验收,网页派给能写代码的那一家,
     * 于是交代落在**命令行那只手**的参数里(壳与命令行都是假的,一个进程都不起)。
     */
    const briefs: string[] = []
    /** 事务官自己那条会话开过没有。**这一卡之后应当永远是空的**。 */
    const butlerOpened: string[] = []
    // 命令行那只手在引擎的登记表里(2026-10-03):`http.ts` 拿下面 `dispatchRun` 那几样往这个登记处登;壳没连,写代码的活只走它。
    const engineRig = engineHarness({ connected: () => false })
    const server = await startWorkbenchServer({
      engine: engineRig.engine,
      engineRegistry: engineRig.registry,
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      tasks: createTasksService({ file: join(home, 'tasks.json'), now: () => NOW_SEC, newId: () => 't-1' }),
      notes: createNotesService({ file: join(home, 'notes.json') }),
      modules: createCustomModulesService({ dir: modulesDir }),
      // 单开来源(2026-09-22,C7):模块页面从这台端出来,不再与工作台同源。
      moduleOrigin: { port: 0 },
      devTool: { store, modulesDir },
      butlerSession: { open: async (first: string) => { butlerOpened.push(first); return 'sess-chain' } },
      // 「那家装了 / 命令行探得到」一律当真(**不看这台机器**:装没装 Codex 与这条链路无关)。
      appInstalled: () => true,
      dispatchRun: {
        runCli: (cmd) => {
          briefs.push(cmd.argv.join('\n'))
          return { pid: 4321, exited: new Promise<{ code: number | null }>(() => {}) }
        },
        resolveCli: family => ({ found: true, family, bin: `/fake/${family}`, source: 'bundled' }),
        resultDir: home,
      },
    })
    started.push(server)
    const url = server.url
    const state = async (): Promise<WorkbenchState> => await (await fetch(`${url}/state`)).json() as WorkbenchState

    // ── 1. 他点了「开发一个小工具」,接着说了一句 ──
    const said = `${DEV_TOOL_DRAFT}一个番茄钟,25 分钟一轮,走完一轮往随手记里记一笔`
    const asked = await post(url, '/butler/item', { text: said })
    expect(asked.body.ok).toBe(true)

    // ── 2. 事务官先复述,**什么都还没做** ──
    const pending = (await state()).dev_tool?.pending[0]
    expect(pending?.restate).toBe('一个番茄钟,25 分钟一轮,走完一轮往随手记里记一笔')
    expect((await state()).tasks?.tasks).toEqual([])
    expect(briefs).toEqual([])
    expect((await state()).modules).toEqual([])

    // ── 3. 他说「就这样」,起名叫「番茄钟」 ──
    const confirmed = await post(url, '/devtool/confirm', { id: pending?.id, name: '番茄钟' })
    expect(confirmed.body.ok).toBe(true)
    const moduleId = String(confirmed.body.module_id)

    // 一件事项派出去了,那一家收到的交代就是产出规范;事务官自己一条会话都没开。
    expect((await state()).tasks?.tasks[0]).toMatchObject({ title: expect.stringContaining('番茄钟') as unknown as string, status: 'doing' })
    expect(butlerOpened).toEqual([])
    expect(briefs).toHaveLength(1)
    const brief = briefs[0] as string

    // ── 4. 「派出去的那一家干活」:照着那条规范,把仓库里那份真样例抄进去 ──
    //     抄之前先拿规范**对一遍目录与文件名** —— 规范写错了这里就落错地方。
    const target = join(modulesDir, moduleId)
    expect(brief).toContain(target)
    expect(brief).toContain('index.html')
    mkdirSync(target, { recursive: true })
    const sampleHtml = readFileSync(join(SAMPLE_DIR, 'index.html'), 'utf8')
    writeFileSync(join(target, 'index.html'), sampleHtml, 'utf8')
    writeFileSync(join(target, 'module.json'), JSON.stringify({
      version: 1, id: moduleId, name: '番茄钟',
      created_at: '2026-09-21T12:40:00+08:00', source: 'dsh', entry: 'index.html',
    }, null, 2), 'utf8')

    // ── 5. 标签当场出现(没有谁通知谁,就是下一拍 /state) ──
    const after = await state()
    expect(after.modules).toMatchObject([{
      id: moduleId, name: '番茄钟', created_at: '2026-09-21T12:40:00+08:00', source: 'dsh', entry: 'index.html',
    }])

    // ── 6. 点开真能用:页面从**单开的那个来源**端出来、CSP 在、令牌注进去了 ──
    const frameUrl = after.modules?.[0]?.frame_url as string
    const moduleOrigin = server.moduleOrigin() as string
    expect(new URL(frameUrl).origin).toBe(moduleOrigin)
    expect(moduleOrigin).not.toBe(url)                       // 真的不同源
    const page = await fetch(frameUrl)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain(`connect-src ${moduleOrigin} ${url}`)
    const served = await page.text()
    // 页面内容一个字没改,只在文档头上多了容器注入的那段前言。
    expect(served).toContain(sampleHtml.slice(sampleHtml.indexOf('<style>')))
    expect(served).toContain('WB_MODULE_TOKEN')

    // 样例页面里 fetch 的那两条:换成模块身份(Origin: null + 模块令牌)照样通。
    // 注入的那把令牌就写在前言里(`var token="wbm.…"`)—— 页面拿它打接口。
    const wb = (/var token="([^"]+)"/.exec(served) as RegExpExecArray)[1] as string
    const asModule = { origin: 'null', authorization: `Bearer ${wb}` }
    expect((await (await fetch(`${url}/state`, { headers: asModule })).json() as WorkbenchState).now).toBeTruthy()
    const noted = await fetch(`${url}/note/add`, {
      method: 'POST', headers: { ...asModule, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '番茄钟:走完一轮 25 分钟' }),
    })
    expect(noted.status).toBe(200)
    expect((await state()).notes?.map(note => note.text)).toContain('番茄钟:走完一轮 25 分钟')
    // 而它打不动白名单之外的任何一条 —— 这就是 C7 那道真边界。
    expect((await fetch(`${url}/credentials`, { headers: asModule })).status).toBe(403)

    // ── 7. 后悔了:移进回收站,还拿得回来 ──
    expect((await post(url, `/modules/${moduleId}/remove`, {})).body).toEqual({ ok: true })
    expect((await state()).modules).toEqual([])
    expect((await post(url, `/modules/${moduleId}/restore`, {})).body).toEqual({ ok: true })
    expect((await state()).modules).toHaveLength(1)

    // ── 8. 截图(只在 WB_SHOT 指了目录、而且这台机器上有 Chrome 时) ──
    const shotDir = process.env.WB_SHOT
    if (shotDir !== undefined && shotDir !== '' && existsSync(CHROME)) {
      mkdirSync(shotDir, { recursive: true })
      await promisify(execFile)(CHROME, [
        '--headless', '--disable-gpu', '--hide-scrollbars',
        '--window-size=760,520',
        `--screenshot=${join(shotDir, '自定义模块-番茄钟.png')}`,
        `${url}/modules/${moduleId}/index.html`,
      ], { timeout: 60_000 })
      expect(existsSync(join(shotDir, '自定义模块-番茄钟.png'))).toBe(true)
    }
  }, 90_000)
})

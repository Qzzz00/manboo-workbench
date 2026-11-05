// @vitest-environment node
/**
 * 数据复盘的四条路由(2026-09-21):`GET /xhs`、`POST /xhs/login|refresh|peek`,
 * 以及 `/state.xhs`。
 *
 * 这一份钉三件事:
 *   ① **没接自取服务时整块 404 / 缺席** —— 展示台与手机看到的就是"这台服务没有这回事";
 *   ② **开浏览器、读后台、往盘上写文件的那三条只认回环** —— 配对过的手机也不行;
 *   ③ 自取写完盘要**广播一次快照**,界面下一拍就变(不用刷新、不用重启)。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { XhsBrowser } from '../src/server/xhsBrowser.ts'
import { XHS_DEFAULT_D7_URL, XHS_PROFILE_NAME, createXhsService } from '../src/server/xhsCreator.ts'
import { XHS_HOME_PAGE_TEXT } from './xhsPageFixtures.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-21T02:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-xhs-http-'))
  dirs.push(dir)
  return dir
}

/** 假浏览器:开窗口只记一笔,读页面回那份**数字全是假的**的夹具。 */
function stub(): XhsBrowser & { opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    openWindow: async (_dir, url) => { opened.push(url); return 9222 },
    // 切范围时桩自己说「点着了、统计周期那一行也变了」——这一份用例不测切范围本身。
    readPage: async (_dir, _url, switchTo) => ({
      href: XHS_DEFAULT_D7_URL,
      title: '创作服务平台',
      text: XHS_HOME_PAGE_TEXT,
      ...(switchTo === undefined ? {} : { switch_clicked: true, switch_confirmed: true }),
    }),
  }
}

async function serve(opts: { withXhs?: boolean } = {}) {
  const dir = tmpDir()
  // 盘上先有一个档案目录 = 「登录过一个账号」。
  mkdirSync(join(dir, XHS_PROFILE_NAME), { recursive: true })
  const browser = stub()
  const xhs = createXhsService({
    metricsFile: join(dir, 'xhs-metrics.json'),
    selectorsFile: join(dir, 'xhs-selectors.json'),
    profileRoot: dir,
    peekDir: dir,
    browser,
  })
  await xhs.load()
  const service = createWorkbenchService({ now: () => NOW_SEC })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    ...(opts.withXhs === false ? {} : { xhs }),
  })
  started.push(server)
  return { url: server.url, dir, browser }
}

const post = async (url: string, path: string) =>
  ({ status: (await fetch(`${url}${path}`, { method: 'POST' })).status })

const postJson = async (url: string, path: string) => {
  const res = await fetch(`${url}${path}`, { method: 'POST' })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('没接自取服务', () => {
  it('★四条路由一律 404「数据复盘自取未启用」,`/state.xhs` 整块缺席', async () => {
    const { url } = await serve({ withXhs: false })
    for (const path of ['/xhs', '/xhs/login', '/xhs/refresh', '/xhs/peek']) {
      const res = await fetch(`${url}${path}`, { method: path === '/xhs' ? 'GET' : 'POST' })
      expect(res.status).toBe(404)
      expect((await res.json() as { error?: string }).error).toBe('数据复盘自取未启用')
    }
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.xhs).toBeUndefined()
  })
})

describe('接上之后', () => {
  it('GET /xhs 与 /state.xhs 是同一份;一次都没取过时 ranges 是空的(**不是八项全 0**)', async () => {
    const { url } = await serve()
    const direct = await (await fetch(`${url}/xhs`)).json() as { ranges: unknown[], login: { connected: boolean } }
    expect(direct.ranges).toEqual([])
    expect(direct.login.connected).toBe(false)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.xhs?.ranges).toEqual([])
  })

  it('POST /xhs/login 开的是创作者中心,用的是那个专用档案', async () => {
    const { url, browser } = await serve()
    const { status, body } = await postJson(url, '/xhs/login')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(browser.opened).toEqual(['https://creator.xiaohongshu.com/new/home'])
  })

  it('★POST /xhs/login/new 开的是下一个序号的纯净档案(2026-09-22 多账号)', async () => {
    const { url, browser } = await serve()
    const { status, body } = await postJson(url, '/xhs/login/new')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect((body as unknown as { profile?: string }).profile).toBe('login-profile-xhs_creator-2')
    expect(browser.opened).toEqual(['https://creator.xiaohongshu.com/new/home'])
  })


  it('POST /xhs/refresh 取一轮,数字进 /state.xhs', async () => {
    const { url } = await serve()
    const { body } = await postJson(url, '/xhs/refresh')
    expect(body.ok).toBe(true)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    // 夹具里的数字全是假的(见 tests/xhsPageFixtures.ts)。
    expect(state.xhs?.ranges[0]?.metrics.find(metric => metric.key === 'impressions')?.raw).toBe('1,111')
  })

  it('★频率闸挡下来时回的是 200 + 一句人话(不是错误码) —— 界面原样上屏', async () => {
    const { url } = await serve()
    await postJson(url, '/xhs/refresh')
    const second = await postJson(url, '/xhs/refresh')
    expect(second.status).toBe(200)
    expect(second.body.ok).toBe(false)
    expect(String(second.body.message)).toContain('分钟后再来')
  })

  it('POST /xhs/peek 把页面文本导出到本地文件,回里面写着落点', async () => {
    const { url, dir } = await serve()
    const { body } = await postJson(url, '/xhs/peek')
    expect(body.ok).toBe(true)
    expect(String(body.file)).toContain(dir)
  })

  it('认不出的子路由回 404,不静默成功', async () => {
    const { url } = await serve()
    expect((await post(url, '/xhs/随便')).status).toBe(404)
  })

  it('★自取写完盘广播一次快照 —— 界面下一拍就变,不用刷新、不用重启', async () => {
    const { url } = await serve()
    const socket = new WebSocket(`${url.replace('http', 'ws')}/live`)
    const seen: LiveMessage[] = []
    socket.on('message', raw => seen.push(JSON.parse(String(raw)) as LiveMessage))
    await new Promise(done => socket.on('open', done))
    await new Promise(done => setTimeout(done, 60))
    seen.length = 0

    await postJson(url, '/xhs/refresh')
    await new Promise(done => setTimeout(done, 120))
    socket.close()

    const snapshot = seen.find((message): message is Extract<LiveMessage, { kind: 'snapshot' }> =>
      message.kind === 'snapshot')
    // 2026-09-22 起默认两个范围都接上了(近 30 日靠点那颗按钮切)。
    expect(snapshot?.state.xhs?.ranges.length).toBe(2)
  })
})

// @vitest-environment node
/**
 * 壳窗口「前台 / 桌面」两档(2026-09-18,Ben:「安装完……现在的层级已经在底部了,导致我缩小了
 * 很多应用才看到页面,用户会觉得出 bug 了。登录和引导的时候,应该是和其他应用一样,能在顶部的,
 * 现在写死是底部」)。
 *
 * 这个文件钉服务端那一截:`POST /shell/window-mode` 的三道门(回环 / 壳 UA / helper 接没接线)、
 * mode 的字面量校验、以及**最要紧的那一条** —— 辅助功能没授权时这条照样通得过去(第一次开机
 * 时授权多半还没点,而登录屏恰恰是最该被看见的那一屏)。
 *
 * 写法对齐 server-dock-http.test.ts(post 辅助 + SHELL_UA)与 server-helper-channel.test.ts
 * (真 WS 假壳),不另造一套。「非回环 → 403」那一条在 server-dock-http.test.ts 的共享清单里
 * 也加了一行 —— 那张清单是防漏机制本身,新写路由都要往那里加。
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'

const started: WorkbenchServer[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close()
  while (started.length) await started.pop()?.close()
})

/** 壳的 WKWebView 那个 UA 标记(applicationNameForUserAgent),浏览器页面伪造不了。 */
const SHELL_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 BenWorkbenchShell/1'

async function post(url: string, body: unknown, userAgent = SHELL_UA) {
  const res = await fetch(`${url}/shell/window-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, ...extra,
  })
  started.push(server)
  return server
}

/**
 * 接一个真的 WS 假壳:把收到的 req 记下来,按 authorized 报自己的授权状态,
 * 对 window_mode 回一条 res(其余 op 不管——这个文件只测这一条)。
 */
async function attachFakeShell(url: string, authorized: boolean) {
  const seen: Record<string, unknown>[] = []
  const ws = new WebSocket(`${url.replace('http', 'ws')}/helper`)
  sockets.push(ws)
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>
    if (msg.kind !== 'req') return
    seen.push(msg)
    if (msg.op === 'window_mode') {
      ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { mode: msg.mode } }))
    }
  })
  await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized, version: '1' }))
  return { ws, seen }
}

describe('POST /shell/window-mode(壳窗口前台/桌面两档)', () => {
  it('成功:front 原样转成 helper 的 window_mode op,200 {ok:true,mode}', async () => {
    const helper = createHelperChannel()
    const server = await serve({ helper })
    const shell = await attachFakeShell(server.url, true)
    await until(() => helper.view().connected)

    const res = await post(server.url, { mode: 'front', source: 'app' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, mode: 'front' })
    expect(shell.seen.map(m => ({ op: m.op, mode: m.mode }))).toEqual([{ op: 'window_mode', mode: 'front' }])
  })

  it('成功:desktop 同样转过去(回到原来那一档)', async () => {
    const helper = createHelperChannel()
    const server = await serve({ helper })
    const shell = await attachFakeShell(server.url, true)
    await until(() => helper.view().connected)

    const res = await post(server.url, { mode: 'desktop', source: 'app' })
    expect(res.body).toEqual({ ok: true, mode: 'desktop' })
    expect(shell.seen.map(m => m.mode)).toEqual(['desktop'])
  })

  /**
   * 这张卡的要害。第一次开机时「辅助功能」多半还没点过,而登录屏恰恰是最该被看见的那一屏——
   * 授权门要是把这条也拦下来,窗口就仍旧压在底下,毛病原样留着。window_mode 不碰任何别人的
   * 窗口(壳侧压根不走 AX),所以它在 helperChannel 的 AX_FREE_OPS 白名单里。
   */
  it('辅助功能未授权时照样通得过去(window_mode 不碰 AX,不该被授权门拦住)', async () => {
    const helper = createHelperChannel()
    const server = await serve({ helper })
    const shell = await attachFakeShell(server.url, false)
    await until(() => helper.view().connected)
    expect(helper.view()).toEqual({ connected: true, authorized: false, reason: '辅助功能未授权' })

    const res = await post(server.url, { mode: 'front', source: 'app' })
    expect(res.body).toEqual({ ok: true, mode: 'front' })
    expect(shell.seen.map(m => m.op)).toEqual(['window_mode'])
  })

  it('授权门仍然拦着碰别人窗口的那些 op(只放行了 window_mode 这一个)', async () => {
    const helper = createHelperChannel()
    const server = await serve({ helper })
    await attachFakeShell(server.url, false)
    await until(() => helper.view().connected)

    await expect(helper.request({ op: 'screen_info' })).rejects.toThrow('辅助功能未授权')
    await expect(helper.request({ op: 'raise_window', bundle_id: 'x', index: 0 })).rejects.toThrow('辅助功能未授权')
  })

  it('壳没连上 → 200 {ok:false, reason}(业务失败不是接口出错,先例 /snap)', async () => {
    const helper = createHelperChannel()
    const server = await serve({ helper })

    const res = await post(server.url, { mode: 'front', source: 'app' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, reason: '工作台 App 未运行' })
  })

  it('mode 只认 front / desktop 两个字面量,别的 400,不转呼', async () => {
    const helper = createHelperChannel()
    const server = await serve({ helper })
    const shell = await attachFakeShell(server.url, true)
    await until(() => helper.view().connected)

    expect((await post(server.url, { mode: 'top', source: 'app' })).status).toBe(400)
    expect((await post(server.url, { mode: 'Front', source: 'app' })).status).toBe(400)
    expect((await post(server.url, { source: 'app' })).status).toBe(400)
    expect(shell.seen).toEqual([])
  })

  /**
   * 矩形投毒案二审同款理由(/slot/rect 那条纪律):浏览器里随手开的工作台标签页也会跑同一份
   * 前端代码,但它没有壳窗口可掀——source:'app' 是页面自称,壳的 UA 标记才是伪造不了的那道。
   */
  it('缺 source 或 UA 不是壳 → 200 {ok:false, reason},不转呼', async () => {
    const helper = createHelperChannel()
    const server = await serve({ helper })
    const shell = await attachFakeShell(server.url, true)
    await until(() => helper.view().connected)

    const noSource = await post(server.url, { mode: 'front' })
    expect(noSource.body).toEqual({ ok: false, reason: '仅壳内页面可切换壳的窗口模式' })

    const browserUa = await post(server.url, { mode: 'front', source: 'app' }, 'Mozilla/5.0 (Macintosh) Chrome/131')
    expect(browserUa.body).toEqual({ ok: false, reason: '仅壳内页面可切换壳的窗口模式' })

    expect(shell.seen).toEqual([])
  })

  it('helper 没接线 → 404「窗口编排壳未接入」(不判 dock:窗口模式跟窗位叠没关系)', async () => {
    const server = await serve()

    const res = await post(server.url, { mode: 'front', source: 'app' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: '窗口编排壳未接入' })
  })
})

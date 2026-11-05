// @vitest-environment node
/**
 * `POST /dispatch/client` —— 把一段话送进那家客户端的输入框(2026-09-21)。
 *
 * 写法对齐 `server-dock-http.test.ts`:假 helper 记下发给壳的每一条 req,
 * 用例里**一次也不会激活 Ben 真的窗口**。
 *
 * 这一份钉三样:① 门(只认回环、壳没接就 404、参数校验);② 送出去的那条 req 长什么样;
 * ③ 送完记到卡上(成了记「已送出」、没成也记,原话一个字不改)。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperChannel, HelperRequest } from '../src/server/helperChannel.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

function fakeHelper(reply: Record<string, unknown> = { ok: true, result: { method: 'ax_value' } }) {
  const requests: HelperRequest[] = []
  const helper = {
    attach() {},
    view: () => ({ connected: true, authorized: true }),
    connected: () => true,
    request: (req: HelperRequest) => {
      requests.push(req)
      return Promise.resolve(reply)
    },
    onChange() {},
    onEvent() {},
  } as unknown as HelperChannel
  return { helper, requests }
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const service = createWorkbenchService()
  /*
   * ★ 2026-10-02(卡「引擎接线与删复制品」):`/dispatch/client` 后面是**一条引擎**,
   * 所以要的不再是 `helper` 而是 `engine`(没传 `engine` 照旧 404 ——「壳没接进来就别假装送得出去」
   * 那一条用例就是不传它)。引擎骑在这一份假壳上,于是发给壳的每一条 req 照旧断得到。
   */
  const engine = extra.helper === undefined
    ? undefined
    // `installed` 不给:这台假 Mac 探不出装了哪几个 → 挑包退到家族目录的主包(每一家各自的那个)。
    : engineHarness({ helper: extra.helper as never })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    // 拉起应用那一步:用例里永远说"已经在跑",一条 open 命令都不发。
    runCommand: () => Promise.resolve({ ok: true, stdout: '"pid"=123' }),
    ...(engine === undefined ? {} : { engine: engine.engine, engineRegistry: engine.registry }),
    ...extra,
  })
  started.push(server)
  return { server, url: server.url }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function tasksService() {
  const file = join(await mkdtemp(join(tmpdir(), 'dispatch-tasks-')), 'tasks.json')
  return createTasksService({ file })
}

describe('POST /dispatch/client', () => {
  it('壳没接进来就 404,不假装送得出去', async () => {
    const { url } = await serve()
    const res = await post(url, '/dispatch/client', { app: 'claude', text: '看看这个' })
    expect(res.status).toBe(404)
  })

  it('参数不对就 400', async () => {
    const { helper } = fakeHelper()
    const { url } = await serve({ helper })
    expect((await post(url, '/dispatch/client', { text: '嗨' })).status).toBe(400)
    expect((await post(url, '/dispatch/client', { app: 'claude', text: '   ' })).status).toBe(400)
  })

  it('★不认识的家 200 + ok:false,一条 req 都不发给壳', async () => {
    const { helper, requests } = fakeHelper()
    const { url } = await serve({ helper })
    const res = await post(url, '/dispatch/client', { app: 'wecom', text: '在吗' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.kind).toBe('not_allowed')
    expect(requests.filter(r => r.op === 'send_text')).toHaveLength(0)
  })

  it('送成了:req 长这样,回一句「已送到 X 窗口」', async () => {
    const { helper, requests } = fakeHelper()
    const { url } = await serve({ helper })
    const res = await post(url, '/dispatch/client', { app: 'kimi', text: '把这段整理一下' })
    expect(res.body.ok).toBe(true)
    expect(res.body.note).toBe('已送到 Kimi 窗口')
    expect(requests.find(r => r.op === 'send_text')).toMatchObject({
      op: 'send_text',
      bundle_id: 'com.moonshot.kimichat',
      text: '把这段整理一下',
      submit: false,
      restore_front: false,
    })
  })

  it('★没带 item_id 就不写任何卡', async () => {
    const { helper } = fakeHelper()
    const tasks = await tasksService()
    const { url } = await serve({ helper, tasks })
    await post(url, '/dispatch/client', { app: 'claude', text: '嗨' })
    const list = await tasks.list()
    expect(list.tasks).toHaveLength(0)
  })

  it('带了 item_id:卡上记「已送出」,原话一个字不改', async () => {
    const { helper } = fakeHelper()
    const tasks = await tasksService()
    const created = await tasks.create({ title: '把周报写了' })
    const { url } = await serve({ helper, tasks })
    const res = await post(url, '/dispatch/client', { app: 'codex', text: '把周报写了,别动别的', item_id: created.id })
    expect(res.body.ok).toBe(true)
    const task = (await tasks.list()).tasks.find(t => t.id === created.id)
    expect(task?.client_dispatch).toMatchObject({
      hand: 'window',
      family: 'codex',
      status: 'sent',
      text: '把周报写了,别动别的',
      method: 'ax_value',
    })
  })

  it('★没送成也要落到卡上(不假装成功,那句原因要看得见)', async () => {
    const { helper } = fakeHelper({ ok: false, error: '输入框没找到:com.openai.codex —— 这扇窗的 AX 树里没有任何文本输入元素' })
    const tasks = await tasksService()
    const created = await tasks.create({ title: '把周报写了' })
    const { url } = await serve({ helper, tasks })
    const res = await post(url, '/dispatch/client', { app: 'codex', text: '把周报写了', item_id: created.id })
    expect(res.body.ok).toBe(false)
    expect(res.body.note).toBeUndefined()
    const task = (await tasks.list()).tasks.find(t => t.id === created.id)
    expect(task?.client_dispatch).toMatchObject({ status: 'failed' })
    expect(task?.client_dispatch?.reason).toContain('输入框没找到')
  })

  it('★submit 只有明着传 true 才替他按回车', async () => {
    const { helper, requests } = fakeHelper()
    const { url } = await serve({ helper })
    await post(url, '/dispatch/client', { app: 'claude', text: '嗨', submit: true })
    expect(requests.find(r => r.op === 'send_text')).toMatchObject({ submit: true })
  })

  /**
   * A2(2026-09-22,Ben 定):「送话进窗口:事务官主动派的替按回车,用户手点的不按。」
   * 路由那条 `submit` 一个字没改 —— 变的是**调用方按来源传**,而来源这一格现在是路由认的。
   */
  describe('A2:按来源决定替不替他按回车', () => {
    it('事务官主动派的(事项 / 电话 / 收件箱交办)→ 替他按', async () => {
      for (const source of ['item', 'call', 'inbox']) {
        const { helper, requests } = fakeHelper()
        const { url } = await serve({ helper })
        const res = await post(url, '/dispatch/client', { app: 'claude', text: '看看登录那段', source })
        expect(res.body.ok).toBe(true)
        expect(requests.find(r => r.op === 'send_text')).toMatchObject({ submit: true })
      }
    })

    it('用户在界面上手点「送进窗口」→ 不按,回车留给他', async () => {
      const { helper, requests } = fakeHelper()
      const { url } = await serve({ helper })
      await post(url, '/dispatch/client', { app: 'claude', text: '看看登录那段', source: 'ui' })
      expect(requests.find(r => r.op === 'send_text')).toMatchObject({ submit: false })
    })

    it('没带来源照旧不按(老调用方一个字不用改)', async () => {
      const { helper, requests } = fakeHelper()
      const { url } = await serve({ helper })
      await post(url, '/dispatch/client', { app: 'claude', text: '嗨' })
      expect(requests.find(r => r.op === 'send_text')).toMatchObject({ submit: false })
    })

    it('★明着传的 submit 压过来源 —— 来源是缺省值,不是禁令', async () => {
      const { helper, requests } = fakeHelper()
      const { url } = await serve({ helper })
      await post(url, '/dispatch/client', { app: 'claude', text: '嗨', source: 'item', submit: false })
      expect(requests.find(r => r.op === 'send_text')).toMatchObject({ submit: false })
    })

    it('★认不出的来源当场 400,不悄悄按缺省 —— 传错了名字的那一方要立刻知道', async () => {
      const { helper, requests } = fakeHelper()
      const { url } = await serve({ helper })
      const res = await post(url, '/dispatch/client', { app: 'claude', text: '嗨', source: '随便' })
      expect(res.status).toBe(400)
      expect(requests.find(r => r.op === 'send_text')).toBeUndefined()
    })
  })

  it('★非回环一律 403(手机上点一下就让他的 Mac 往客户端里打字,是这类功能最吓人的行为)', async () => {
    const { helper } = fakeHelper()
    const { url } = await serve({ helper, isLoopback: () => false })
    const res = await post(url, '/dispatch/client', { app: 'claude', text: '嗨' })
    expect(res.status).toBe(403)
  })
})

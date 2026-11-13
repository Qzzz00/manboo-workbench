// @vitest-environment node
/**
 * POST /credentials/test 走真实 8791 路由(2026-11-12,首次引导「一键测试连接」)。
 *
 * 这一层要钉的是纯函数测不到的三件事:
 * ① 只认回环(这一下花的是用户自己 Key 的钱);
 * ② 一个字都不落盘 —— 测不通的 Key 不该先被存进凭据库;
 * ③ 回包只有「成没成 + 一句人话」,不含 Key、不含上游正文、不含状态码给人看。
 *
 * 上游那一次外发请求用 stub 顶掉,不真联网;本地 8791 的请求用真 fetch(在 stub 之前存好引用)。
 * 服务起法沿用仓库里既有的 http 用例(behavior-log-http-20261009)。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createBehaviorLog } from '../src/server/behaviorLog.ts'
import { createCallRecordsService } from '../src/server/callRecords.ts'
import { CREDENTIAL_TEST_COPY } from '../src/server/credentialTest.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const KEY = 'sk-draft-http-123456'

/** stub 之前先存一份真的:打本机 8791 要用它,不然会被 stub 吃掉。 */
const realFetch = globalThis.fetch

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeMdns(): MdnsAdvertiser {
  let on = false
  return { async start() { on = true }, async stop() { on = false }, active: () => on }
}

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-credtest-http-'))
  dirs.push(dir)
  const credentialFile = join(dir, 'credentials.json')
  const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    credentialFile,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    tasks,
    behaviorLog,
    callRecords: createCallRecordsService({ file: join(dir, 'calls.json'), workdir: () => dir, fallbackDir: join(dir, 'fallback') }),
    actorTokens: { butler: 'butler-token', worker: 'worker-token' },
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.0.0.2', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (
    init: { body?: unknown, raw?: string, from?: string } = {},
  ): Promise<{ status: number, text: string, body: Record<string, unknown> }> => {
    remote.address = init.from ?? LOOPBACK
    const res = await realFetch(`${server.url}/credentials/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: init.raw ?? JSON.stringify(init.body ?? { key: KEY }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, text, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return { call, credentialFile }
}

/** 把上游那一次外发请求顶掉:只给状态码,正文一律不读(实现里也确实不读)。 */
function stubUpstream(status: number): ReturnType<typeof vi.fn> {
  const upstream = vi.fn(async () => ({ status }) as Response)
  vi.stubGlobal('fetch', upstream)
  return upstream
}

describe('POST /credentials/test', () => {
  it('401 说「Key 不对或没复制全」,回包不带 Key、不落盘', async () => {
    const upstream = stubUpstream(401)
    const t = await serve()
    const res = await t.call({ body: { key: KEY } })
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe(CREDENTIAL_TEST_COPY.invalidKey);
    expect(res.text).not.toContain(KEY);
    // 回包里的 status 是给程序/单测判的,界面只显示 message —— 那一句里不许出现状态码。
    expect(String(res.body.message)).not.toContain('401');
    expect(existsSync(t.credentialFile)).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(String(init.body)).not.toContain(KEY);
  });

  it('402 说「余额不足」,和 401 不是同一句', async () => {
    stubUpstream(402)
    const t = await serve()
    const res = await t.call()
    expect(res.body.message).toBe(CREDENTIAL_TEST_COPY.noBalance);
    expect(res.body.message).not.toBe(CREDENTIAL_TEST_COPY.invalidKey);
    expect(existsSync(t.credentialFile)).toBe(false);
  });

  it('2xx 算接上', async () => {
    stubUpstream(200)
    const t = await serve()
    const res = await t.call()
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toBe(CREDENTIAL_TEST_COPY.ok);
  });

  it('连不上上游也说人话,而且不把底层错误带回来', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`boom ${KEY}`) }))
    const t = await serve()
    const res = await t.call()
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe(CREDENTIAL_TEST_COPY.network);
    expect(res.text).not.toContain(KEY);
  });

  it('不是回环 → 403,且一个请求都不往上游发', async () => {
    const upstream = stubUpstream(200)
    const t = await serve()
    const res = await t.call({ from: PHONE })
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('body 不是合法 JSON / key 不是字符串 → 400,不外发', async () => {
    const upstream = stubUpstream(200)
    const t = await serve()
    expect((await t.call({ raw: 'not json' })).status).toBe(400);
    expect((await t.call({ body: { key: 123 } })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('空 Key 不外发,只回一句「先把 Key 贴进来再试」', async () => {
    const upstream = stubUpstream(200)
    const t = await serve()
    const res = await t.call({ body: { key: '   ' } })
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe(CREDENTIAL_TEST_COPY.emptyKey);
    expect(upstream).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
/**
 * 账号的 HTTP 层(2026-09-17,决策记录「登录就是账号密码」):
 * 四条路、cookie 的几条属性、只认回环、**登录不是鉴权**(没登录时 /state 照样读得到)、
 * 以及「首次流程走完没有」那面旗子。
 *
 * 最要紧的那条在最后一个 describe 里:**回环来源仍然放行现有一切**。
 * 这一条要是哪天被改掉,壳、DSH 会话里的事务官、例程会一起哑掉,而且现场看不出原因。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAccountService } from '../src/server/account.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const T0 = 1_758_060_000_000
const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-account-http-'))
  let clock = T0
  const account = createAccountService({
    file: join(dir, 'account.json'),
    keyFile: join(dir, 'account-session.key'),
    now: () => clock,
    scryptN: 1024,
  })
  const appConfig = createAppConfig({ file: join(dir, 'app.json') })
  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(clock / 1000) }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    account,
    appConfig,
    remoteAddress: () => remote.address,
    // 来源门照旧:回环 + 热点网段。手机那条用例靠它被挡在门外之前先过来源门。
    isRemoteAllowed: () => true,
    isLoopback: () => remote.address === LOOPBACK,
  })
  started.push(server)
  /** 带上一张 cookie 罐子:这几条路的全部意义就是 cookie 传不传得回来。 */
  let jar = ''
  const call = async (path: string, init: { method?: string, body?: unknown, from?: string, cookie?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const cookie = init.cookie ?? jar
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie === '' ? {} : { cookie }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    remote.address = LOOPBACK
    const setCookie = res.headers.get('set-cookie')
    if (setCookie !== null) {
      const first = setCookie.split(';')[0] ?? ''
      jar = first.endsWith('=') ? '' : first
    }
    const text = await res.text()
    return {
      status: res.status,
      setCookie,
      body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
    }
  }
  return { call, server, jar: () => jar, tick: (ms: number) => { clock += ms } }
}

describe('GET /account', () => {
  it('没注册过:registered/logged_in 都是 false,没有别的东西', async () => {
    const { call } = await serve()
    const res = await call('/account')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ registered: false, logged_in: false })
  })

  it('没接账号服务时整块 404,界面据此照旧直接显示工作台', async () => {
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService({ now: () => 0 }), tickIntervalMs: 0, heartbeatMs: 0,
    })
    started.push(server)
    const res = await fetch(`${server.url}/account`)
    expect(res.status).toBe(404)
  })
})

describe('注册 / 登录 / 登出', () => {
  it('注册即登录,cookie 是 HttpOnly 的 30 天,回包里没有令牌', async () => {
    const { call } = await serve()
    const res = await call('/account/register', { body: { username: 'ben', password: 'hello', confirm: 'hello' } })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, username: 'ben' })
    expect(JSON.stringify(res.body)).not.toContain('ben_wb_account')
    expect(res.setCookie).toContain('HttpOnly')
    expect(res.setCookie).toContain('SameSite=Lax')
    expect(res.setCookie).toContain('Max-Age=2592000')
    expect(await call('/account')).toMatchObject({ body: { registered: true, logged_in: true, username: 'ben' } })
  })

  it('登出之后 cookie 作废,回到登录屏', async () => {
    const { call } = await serve()
    await call('/account/register', { body: { username: 'ben', password: 'hello' } })
    const out = await call('/account/logout', { method: 'POST' })
    expect(out.status).toBe(200)
    expect(out.setCookie).toContain('Max-Age=0')
    expect((await call('/account')).body).toMatchObject({ registered: true, logged_in: false })
  })

  it('重置账号:删掉账号记录、cookie 作废,之后能重新注册;只在本机', async () => {
    const { call } = await serve()
    await call('/account/register', { body: { username: 'ben', password: 'hello' } })
    const out = await call('/account/reset', { method: 'POST' })
    expect(out.status).toBe(200)
    expect(out.setCookie).toContain('Max-Age=0')
    expect((await call('/account')).body).toMatchObject({ registered: false, logged_in: false })
    const again = await call('/account/register', { body: { username: 'ben2', password: 'world' } })
    expect(again.status).toBe(200)
  })

  it('登录:错密码 401,错 5 次 429 带 locked_until', async () => {
    const { call } = await serve()
    await call('/account/register', { body: { username: 'ben', password: 'hello' } })
    await call('/account/logout', { method: 'POST' })
    for (let i = 0; i < 4; i += 1) {
      expect((await call('/account/login', { body: { username: 'ben', password: 'x' } })).status).toBe(401)
    }
    const fifth = await call('/account/login', { body: { username: 'ben', password: 'x' } })
    expect(fifth.status).toBe(429)
    expect(typeof fifth.body.locked_until).toBe('string')
    // 锁着的时候连对的密码也不放行。
    expect((await call('/account/login', { body: { username: 'ben', password: 'hello' } })).status).toBe(429)
  })

  it('登录成功之后 /account 说登录了(cookie 真的带回来了)', async () => {
    const { call } = await serve()
    await call('/account/register', { body: { username: 'ben', password: 'hello' } })
    await call('/account/logout', { method: 'POST' })
    const login = await call('/account/login', { body: { username: 'ben', password: 'hello' } })
    expect(login.status).toBe(200)
    expect((await call('/account')).body).toMatchObject({ logged_in: true, username: 'ben' })
  })

  it('body 不是 JSON:400 一句人话', async () => {
    const { server } = await serve()
    const res = await fetch(`${server.url}/account/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '不是 json',
    })
    expect(res.status).toBe(400)
  })
})

describe('改密码', () => {
  it('已登录 + 当前密码对 → 换一张新 cookie;旧的当场失效', async () => {
    const { call } = await serve()
    const first = await call('/account/register', { body: { username: 'ben', password: 'hello' } })
    const oldCookie = (first.setCookie ?? '').split(';')[0] ?? ''
    const changed = await call('/account/register', {
      body: { username: 'ben', password: 'newpass', confirm: 'newpass', current_password: 'hello' },
    })
    expect(changed.status).toBe(200)
    expect(changed.setCookie).toContain('HttpOnly')
    // 拿旧 cookie 去问:已经不是登录态了。
    expect((await call('/account', { cookie: oldCookie })).body).toMatchObject({ logged_in: false })
  })

  it('没登录时又去注册:403,不让第二个人把账号顶掉', async () => {
    const { call } = await serve()
    await call('/account/register', { body: { username: 'ben', password: 'hello' } })
    await call('/account/logout', { method: 'POST' })
    const again = await call('/account/register', { body: { username: '别人', password: 'hello2' } })
    expect(again.status).toBe(403)
  })
})

describe('门', () => {
  it('手机(非回环)碰不到账号那四条路', async () => {
    const { call } = await serve()
    expect((await call('/account', { from: PHONE })).status).toBe(403)
    expect((await call('/account/login', { body: { username: 'ben', password: 'hello' }, from: PHONE })).status).toBe(403)
    expect((await call('/first-run', { from: PHONE })).status).toBe(403)
  })

  it('**登录不是鉴权**:没登录时 /state 照样读得到,写接口照样能写', async () => {
    const { call } = await serve()
    expect((await call('/account')).body).toMatchObject({ logged_in: false })
    const state = await call('/state')
    expect(state.status).toBe(200)
    expect(typeof state.body.now).toBe('string')
    // 随便挑一条本来就只认回环的写路由:登录屏出现与否跟它无关。
    expect((await call('/pause', { body: { paused: true } })).status).toBe(200)
  })
})

describe('首次流程那面旗子', () => {
  it('没走过就是空的;写一次有 done_at;擦掉又变空', async () => {
    const { call } = await serve()
    expect((await call('/first-run')).body).toEqual({})
    const done = await call('/first-run', { body: { done: true } })
    expect(done.status).toBe(200)
    expect(typeof done.body.done_at).toBe('string')
    expect(typeof (await call('/first-run')).body.done_at).toBe('string')

    const cleared = await call('/first-run', { body: { done: false } })
    expect(cleared.body).toEqual({ ok: true })
    expect((await call('/first-run')).body).toEqual({})
  })

  it('done 不是布尔值就 400', async () => {
    const { call } = await serve()
    expect((await call('/first-run', { body: { done: '是' } })).status).toBe(400)
  })
})

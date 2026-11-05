// @vitest-environment node
/**
 * 本机账号(2026-09-17,决策记录「登录就是账号密码」)。纯服务层:
 * 注册 / 登录 / 会话令牌 / 错密码锁 / 只存哈希 / 改密作废旧 cookie。
 *
 * 全部跑在 mktemp 出来的临时目录里 —— 这个模块只认传进来的两条路径,
 * 代码里一处 `process.env.HOME` 都没有(2026-09-04 家目录事故之后的规矩)。
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_COOKIE, accountCookieHeader, checkPassword, clearedAccountCookieHeader, createAccountService,
  loadAccountFile, normalizeUsername, tokenFromCookieHeader,
} from '../src/server/account.ts'

const T0 = 1_758_060_000_000 // 2026-09-17 附近

function make(over: { now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-account-'))
  let clock = T0
  const file = join(dir, 'account.json')
  const keyFile = join(dir, 'account-session.key')
  const service = createAccountService({
    file,
    keyFile,
    now: over.now ?? (() => clock),
    // 测试里把 scrypt 调到最小档:参数本身不是被测对象,而 16384 一次 ~80ms。
    scryptN: 1024,
  })
  return { service, file, keyFile, dir, tick: (ms: number) => { clock += ms } }
}

describe('注册', () => {
  it('第一次注册就成:回用户名与一张 30 天的 cookie', async () => {
    const { service } = make()
    const result = await service.register({ username: 'ben', password: 'hello', confirm: 'hello' })
    expect(result).toMatchObject({ ok: true, username: 'ben' })
    if (!result.ok) throw new Error('unreachable')
    expect(Date.parse(result.expires_at) - T0).toBe(30 * 24 * 60 * 60 * 1000)
    expect(await service.verify(result.token)).toEqual({ username: 'ben' })
  })

  it('落盘的只有加盐哈希:文件里搜不到密码,权限是 0600', async () => {
    const { service, file, keyFile } = make()
    const result = await service.register({ username: 'ben', password: 'hunter2' })
    expect(result.ok).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('hunter2')
    const saved = await loadAccountFile(file)
    expect(saved.account?.username).toBe('ben')
    expect(saved.account?.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(saved.account?.hash).toMatch(/^[0-9a-f]{128}$/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
  })

  it('/account 的视图里没有哈希、没有 salt', async () => {
    const { service } = make()
    const result = await service.register({ username: 'ben', password: 'hello' })
    if (!result.ok) throw new Error('unreachable')
    const view = await service.view(result.token)
    expect(view).toEqual({ registered: true, logged_in: true, username: 'ben' })
    expect(JSON.stringify(view)).not.toContain('hash')
  })

  it('两次密码不一样、密码太短、用户名空 —— 各回一句人话', async () => {
    const { service } = make()
    expect(await service.register({ username: 'ben', password: 'hello', confirm: 'hell' }))
      .toMatchObject({ ok: false, status: 400, error: '两次输入的密码不一样' })
    expect(await service.register({ username: 'ben', password: 'ab' })).toMatchObject({ ok: false, status: 400 })
    expect(await service.register({ username: '  ', password: 'hello' })).toMatchObject({ ok: false, status: 400 })
  })

  it('已经有账号、又没登录:403,并告诉他忘了密码怎么办', async () => {
    const { service } = make()
    expect((await service.register({ username: 'ben', password: 'hello' })).ok).toBe(true)
    const again = await service.register({ username: '别人', password: 'hello2' })
    expect(again).toMatchObject({ ok: false, status: 403 })
    if (again.ok) throw new Error('unreachable')
    expect(again.error).toContain('重置账号')
  })
})

describe('登录', () => {
  it('对了就发 cookie,错了只说「用户名或密码不对」', async () => {
    const { service } = make()
    await service.register({ username: 'ben', password: 'hello' })
    const good = await service.login({ username: 'ben', password: 'hello' })
    expect(good).toMatchObject({ ok: true, username: 'ben' })
    const wrongPassword = await service.login({ username: 'ben', password: 'nope' })
    const wrongName = await service.login({ username: '别人', password: 'hello' })
    expect(wrongPassword).toMatchObject({ ok: false, status: 401, error: '用户名或密码不对' })
    expect(wrongName).toMatchObject({ ok: false, status: 401, error: '用户名或密码不对' })
  })

  it('还没注册过就登录:409 让他先注册', async () => {
    const { service } = make()
    expect(await service.login({ username: 'ben', password: 'hello' })).toMatchObject({ ok: false, status: 409 })
  })

  it('错 5 次锁 10 分钟,锁着时连对的密码也不放行;到点自己解开', async () => {
    const { service, tick } = make()
    await service.register({ username: 'ben', password: 'hello' })
    for (let i = 0; i < 4; i += 1) {
      expect(await service.login({ username: 'ben', password: 'x1' })).toMatchObject({ ok: false, status: 401 })
    }
    const fifth = await service.login({ username: 'ben', password: 'x1' })
    expect(fifth).toMatchObject({ ok: false, status: 429 })
    if (fifth.ok) throw new Error('unreachable')
    expect(fifth.locked_until).toBe(new Date(T0 + 10 * 60_000).toISOString())
    expect(await service.login({ username: 'ben', password: 'hello' })).toMatchObject({ ok: false, status: 429 })
    // 视图里也看得到锁(界面据此说"再等一会儿"),但仍然没有哈希。
    expect((await service.view()).locked_until).toBe(new Date(T0 + 10 * 60_000).toISOString())

    tick(10 * 60_000 + 1)
    expect(await service.login({ username: 'ben', password: 'hello' })).toMatchObject({ ok: true })
  })

  it('对一次就把错误计数清零(不会攒到第 5 次莫名其妙被锁)', async () => {
    const { service } = make()
    await service.register({ username: 'ben', password: 'hello' })
    for (let i = 0; i < 4; i += 1) await service.login({ username: 'ben', password: 'x1' })
    expect(await service.login({ username: 'ben', password: 'hello' })).toMatchObject({ ok: true })
    for (let i = 0; i < 4; i += 1) {
      expect(await service.login({ username: 'ben', password: 'x1' })).toMatchObject({ ok: false, status: 401 })
    }
  })
})

describe('会话令牌', () => {
  it('过期之后认不出来', async () => {
    const { service, tick } = make()
    const result = await service.register({ username: 'ben', password: 'hello' })
    if (!result.ok) throw new Error('unreachable')
    tick(30 * 24 * 60 * 60 * 1000 + 1)
    expect(await service.verify(result.token)).toBeUndefined()
    expect(await service.view(result.token)).toMatchObject({ registered: true, logged_in: false })
  })

  it('改一个字、少一段、换一份密钥,都认不出来', async () => {
    const { service } = make()
    const result = await service.register({ username: 'ben', password: 'hello' })
    if (!result.ok) throw new Error('unreachable')
    const parts = result.token.split('.')
    expect(await service.verify(`${parts[0]}.${parts[1]}.${parts[2]}.0000`)).toBeUndefined()
    expect(await service.verify(parts.slice(0, 3).join('.'))).toBeUndefined()
    expect(await service.verify('')).toBeUndefined()
    expect(await service.verify(undefined)).toBeUndefined()

    // 另一台服务(另一份签名密钥)签的令牌,这里不认。
    const other = make()
    const theirs = await other.service.register({ username: 'ben', password: 'hello' })
    if (!theirs.ok) throw new Error('unreachable')
    expect(await service.verify(theirs.token)).toBeUndefined()
  })
})

describe('改密码', () => {
  it('要当前密码;改完旧 cookie 当场失效,新 cookie 接着用', async () => {
    const { service } = make()
    const first = await service.register({ username: 'ben', password: 'hello' })
    if (!first.ok) throw new Error('unreachable')

    expect(await service.register({ username: 'ben', password: 'newpass', token: first.token }))
      .toMatchObject({ ok: false, status: 400, error: '改密码要先输入当前密码' })
    expect(await service.register({ username: 'ben', password: 'newpass', current_password: '错的', token: first.token }))
      .toMatchObject({ ok: false, status: 401 })

    const changed = await service.register({
      username: 'ben', password: 'newpass', confirm: 'newpass', current_password: 'hello', token: first.token,
    })
    expect(changed).toMatchObject({ ok: true, username: 'ben' })
    if (!changed.ok) throw new Error('unreachable')
    expect(await service.verify(first.token)).toBeUndefined()
    expect(await service.verify(changed.token)).toEqual({ username: 'ben' })
    expect(await service.login({ username: 'ben', password: 'hello' })).toMatchObject({ ok: false, status: 401 })
    expect(await service.login({ username: 'ben', password: 'newpass' })).toMatchObject({ ok: true })
  })
})

describe('cookie 的那几行', () => {
  it('HttpOnly、SameSite=Lax、30 天;清除那一行是 Max-Age=0', () => {
    const line = accountCookieHeader('abc', 30 * 24 * 3600)
    expect(line).toContain(`${ACCOUNT_COOKIE}=abc`)
    expect(line).toContain('HttpOnly')
    expect(line).toContain('SameSite=Lax')
    expect(line).toContain('Max-Age=2592000')
    expect(clearedAccountCookieHeader()).toContain('Max-Age=0')
  })

  it('从 Cookie 头里只挑同名的那一段', () => {
    expect(tokenFromCookieHeader(`a=1; ${ACCOUNT_COOKIE}=tok; b=2`)).toBe('tok')
    expect(tokenFromCookieHeader(`${ACCOUNT_COOKIE}_other=tok`)).toBeUndefined()
    expect(tokenFromCookieHeader(undefined)).toBeUndefined()
    expect(tokenFromCookieHeader('')).toBeUndefined()
  })
})

describe('输入校验(纯函数)', () => {
  it('用户名去空白、限长、不收空格与控制字符;中文可以', () => {
    expect(normalizeUsername('  ben  ')).toEqual({ ok: true, value: 'ben' })
    expect(normalizeUsername('小本')).toEqual({ ok: true, value: '小本' })
    expect(normalizeUsername('a b')).toMatchObject({ ok: false })
    expect(normalizeUsername('x'.repeat(33))).toMatchObject({ ok: false })
    expect(normalizeUsername(42)).toMatchObject({ ok: false })
  })

  it('密码 4–200 位', () => {
    expect(checkPassword('1234')).toEqual({ ok: true, value: '1234' })
    expect(checkPassword('123')).toMatchObject({ ok: false })
    expect(checkPassword('x'.repeat(201))).toMatchObject({ ok: false })
  })
})

describe('坏文件', () => {
  it('account.json 写坏了当成「没注册过」,而不是把人锁在门外', async () => {
    const { service, file } = make()
    await service.register({ username: 'ben', password: 'hello' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ 这不是 json')
    expect(await service.view()).toMatchObject({ registered: false, logged_in: false })
    expect(await service.register({ username: '新的', password: 'hello' })).toMatchObject({ ok: true })
  })
})

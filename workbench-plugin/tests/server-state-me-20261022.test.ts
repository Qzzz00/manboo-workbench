// @vitest-environment node
/**
 * `/state.me`(2026-10-22 新 UI 第三轮 8,维护者):协作区上写用户自己时不写「你」,写账号名 ——
 * 引导里答过称呼就用称呼,没有就用本机登录的账号用户名;两样都没有就整格缺席。
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

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

async function serve(over: { nickname?: string, withAccount?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-state-me-'))
  const account = over.withAccount === false
    ? undefined
    : createAccountService({ file: join(dir, 'account.json'), keyFile: join(dir, 'account-session.key'), scryptN: 1024 })
  const onboarding = over.nickname === undefined
    ? undefined
    : { view: () => ({ stage: 'done', done: true }), nickname: () => over.nickname } as never
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_758_060_000 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(account === undefined ? {} : { account }),
    ...(onboarding === undefined ? {} : { onboarding }),
    appConfig: createAppConfig({ file: join(dir, 'app.json') }),
    remoteAddress: () => '127.0.0.1',
    isRemoteAllowed: () => true,
    isLoopback: () => true,
  })
  started.push(server)
  const state = async () => (await (await fetch(`${server.url}/state`)).json()) as { me?: { name: string } }
  const post = async (path: string, body: unknown) => fetch(`${server.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { state, post }
}

describe('/state.me', () => {
  it('没称呼、没账号:整格缺席', async () => {
    const { state } = await serve({ withAccount: false })
    expect((await state()).me).toBeUndefined()
  })

  it('注册了账号:写账号用户名;注册那一下之后的下一拍就换上', async () => {
    const { state, post } = await serve()
    expect((await state()).me).toBeUndefined()
    const res = await post('/account/register', { username: 'xiaoben', password: 'pass-1234', confirm: 'pass-1234' })
    expect(res.status).toBe(200)
    expect((await state()).me).toEqual({ name: 'xiaoben' })
  })

  it('引导里答过称呼:称呼优先于用户名', async () => {
    const { state, post } = await serve({ nickname: '本' })
    await post('/account/register', { username: 'xiaoben', password: 'pass-1234', confirm: 'pass-1234' })
    expect((await state()).me).toEqual({ name: '本' })
  })
})

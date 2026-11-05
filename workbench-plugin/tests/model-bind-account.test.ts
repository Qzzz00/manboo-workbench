// @vitest-environment node
//
// 「房间只认账号」的电脑那一半(2026-09-27,卡 RM;根因见 docs/交接-0927-座机进错房间.md)。
//
// 这个文件盯的是**新装机器的主路径** —— 不是边角情况,是每一台新机器都会走的那一条:
//
//   装完 → 工作台起来 → modelService 先领一把令牌(引导要调模型,那时还没有账号会话)
//        → 用户这才登录 → **登录那一刻**这台机器要挂到账号下,房间跟着变成账号那一间
//
// 不做这一步的后果:电脑与扫码配对的手机在「名字」那一间,座机与按账号领令牌的设备在
// `acct:<id>` 那一间 —— 座机提机没人接,给座机换网络也发不到它头上。
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceTokenBindingOf, loadModelConfig, saveModelConfig } from '../src/server/modelConfig.ts'
import { createModelService } from '../src/server/modelService.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const ACCT = 'acct:0123456789abcdef0123456789abcdef'
const OTHER_ACCT = 'acct:ffffffffffffffffffffffffffffffff'

async function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'wb-bind-'))
  dirs.push(root)
  const dshHome = join(root, '.dsh')
  await mkdir(join(dshHome, 'workbench'), { recursive: true })
  // 用例跑的是开源缺省(构建不带中转);这里测的是接了中转的那一档,地址写进 model.json(同我们的构建 / 自建中转)。
  await writeFile(join(dshHome, 'workbench', 'model.json'), JSON.stringify({ relay_url: 'https://r.test' }))
  return {
    modelFile: join(dshHome, 'workbench', 'model.json'),
    credentialFile: join(dshHome, 'workbench', 'credentials.json'),
    accountFile: join(dshHome, 'workbench', 'account.json'),
  }
}

/**
 * 一个像真中转那样的假中转:**带了会话就把设备记在 `acct:<id>` 名下,没带就走老路**
 * (`account` = 请求体里那个名字)。回包里的 `account` 就是它记下的那一列 ——
 * 房间名由它算,所以这一项是这整张卡的支点。
 */
function fakeRelay(scopeOfSession: Record<string, string> = { 'wbs_ben': ACCT }) {
  const registrations: { account: string, session?: string, kind?: string }[] = []
  const impl: typeof fetch = async (url, init) => {
    const href = String(url)
    if (href.endsWith('/register-device')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { account?: string, kind?: string }
      const bearer = /^Bearer\s+(.+)$/.exec(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))
      const session = bearer?.[1]
      const account = session !== undefined && scopeOfSession[session] !== undefined
        ? scopeOfSession[session]
        : String(body.account)
      registrations.push({ account, ...(session === undefined ? {} : { session }), ...(body.kind === undefined ? {} : { kind: body.kind }) })
      return new Response(JSON.stringify({ token: `wb_for_${account}`, account }), { status: 201 })
    }
    if (href.includes('/usage')) {
      return new Response(JSON.stringify({
        day: '2026-09-27', used_tokens: 0, daily_token_limit: 50_000, remaining_tokens: 50_000,
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  return { impl, registrations }
}

describe('deviceTokenBindingOf(判据,纯函数)', () => {
  const base = { mode: 'relay' as const, relay_url: 'https://r.test', device_id: 'mac-1' }

  it('没登录 → 不动(legacy 令牌照样调模型,登录前的引导要用它)', () => {
    expect(deviceTokenBindingOf({ ...base, relay_token: 'wb_legacy' }, undefined))
      .toEqual({ rebind: false, reason: 'not_logged_in' })
    expect(deviceTokenBindingOf({ ...base, relay_token: 'wb_legacy' }, '   '))
      .toEqual({ rebind: false, reason: 'not_logged_in' })
  })

  it('已经是本账号的 → **一个字节都不动**(重领会把手机上正通着的那条断掉)', () => {
    expect(deviceTokenBindingOf({ ...base, relay_token: 'wb_x', relay_token_account: ACCT }, ACCT))
      .toEqual({ rebind: false, reason: 'already_bound' })
  })

  it('那一格缺席(09-27 之前装的机器)→ 重领', () => {
    expect(deviceTokenBindingOf({ ...base, relay_token: 'wb_legacy' }, ACCT))
      .toEqual({ rebind: true, reason: 'unknown' })
  })

  it('记着的是别的账号(换了人登录)→ 重领', () => {
    expect(deviceTokenBindingOf({ ...base, relay_token: 'wb_x', relay_token_account: OTHER_ACCT }, ACCT))
      .toEqual({ rebind: true, reason: 'not_this_account' })
  })

  it('压根还没令牌 → 领一把(带会话领,直接就是账号那一间)', () => {
    expect(deviceTokenBindingOf(base, ACCT)).toEqual({ rebind: true, reason: 'no_token' })
  })
})

describe('新装机器的主路径:先装、后登录', () => {
  it('装完领的是 legacy 令牌;登录之后自动重领,令牌变成账号那一把', async () => {
    const box = await sandbox()
    const relay = fakeRelay()
    let session: string | undefined
    let scope: string | undefined
    const rooms: string[] = []
    const service = createModelService({
      modelFile: box.modelFile,
      credentialFile: box.credentialFile,
      accountFile: box.accountFile,
      relaySession: async () => session,
      relayAccountScope: async () => scope,
      onRoomChanged: note => rooms.push(note),
      fetchImpl: relay.impl,
    })

    // ① 还没登录:引导要调模型,先领一把 —— 走的是老路,`account` 是个名字。
    expect((await service.ensureDeviceToken()).ok).toBe(true)
    const legacy = await loadModelConfig(box.modelFile)
    expect(legacy.relay_token).toBeDefined()
    expect(legacy.relay_token_account).not.toMatch(/^acct:/)
    expect(relay.registrations[0]?.session).toBeUndefined()

    // ② 用户登录。这一刻(modelAutoSetup.kick → autoSetup)要把这台机器挂到账号下。
    session = 'wbs_ben'
    scope = ACCT
    const bound = await service.autoSetup()
    expect(bound.ok).toBe(true)

    const after = await loadModelConfig(box.modelFile)
    expect(after.relay_token_account).toBe(ACCT)
    expect(after.relay_token).toBe(`wb_for_${ACCT}`)
    // 重领那一次是**带着会话**去的 —— 这才是「房间由账号算」的唯一来源。
    expect(relay.registrations.at(-1)?.session).toBe('wbs_ben')
    // 房间号换了要有人知道:通道凭据重取、通话工人重进房。
    expect(rooms.length).toBeGreaterThan(0)
  })

  it('已经是本账号的:再启动一次不重领,房间一动不动', async () => {
    const box = await sandbox()
    const relay = fakeRelay()
    await saveModelConfig(box.modelFile, {
      mode: 'relay',
      relay_url: 'https://r.test',
      device_id: 'mac-1',
      relay_token: 'wb_already',
      relay_token_account: ACCT,
    })
    const rooms: string[] = []
    const service = createModelService({
      modelFile: box.modelFile,
      credentialFile: box.credentialFile,
      accountFile: box.accountFile,
      relaySession: async () => 'wbs_ben',
      relayAccountScope: async () => ACCT,
      onRoomChanged: note => rooms.push(note),
      fetchImpl: relay.impl,
    })

    const result = await service.bindToAccount()
    expect(result).toEqual({ ok: true, changed: false, reason: 'already_bound' })
    expect(relay.registrations).toEqual([])
    expect(rooms).toEqual([])
    expect((await loadModelConfig(box.modelFile)).relay_token).toBe('wb_already')
  })

  it('启动时自检:令牌是 09-27 之前那种「不知道属于谁」的,登录着就重领(用户什么都不用点)', async () => {
    const box = await sandbox()
    const relay = fakeRelay()
    await saveModelConfig(box.modelFile, {
      mode: 'relay',
      relay_url: 'https://r.test',
      device_id: 'mac-1',
      account: 'ben',
      relay_token: 'wb_legacy_from_before',
    })
    const service = createModelService({
      modelFile: box.modelFile,
      credentialFile: box.credentialFile,
      accountFile: box.accountFile,
      relaySession: async () => 'wbs_ben',
      relayAccountScope: async () => ACCT,
      fetchImpl: relay.impl,
    })

    const result = await service.bindToAccount()
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.reason).toBe('unknown')
    expect((await loadModelConfig(box.modelFile)).relay_token_account).toBe(ACCT)
    // 这台电脑报的是 `mac` —— 中转按这一列往进房凭证里签 wb_kind。
    expect(relay.registrations.at(-1)?.kind).toBe('mac')
  })

  it('没登录就不动:legacy 令牌留着(引导还要拿它调模型)', async () => {
    const box = await sandbox()
    const relay = fakeRelay()
    await saveModelConfig(box.modelFile, {
      mode: 'relay', relay_url: 'https://r.test', device_id: 'mac-1', relay_token: 'wb_legacy',
    })
    const service = createModelService({
      modelFile: box.modelFile,
      credentialFile: box.credentialFile,
      accountFile: box.accountFile,
      relaySession: async () => undefined,
      relayAccountScope: async () => undefined,
      fetchImpl: relay.impl,
    })

    expect(await service.bindToAccount()).toEqual({ ok: true, changed: false, reason: 'not_logged_in' })
    expect((await loadModelConfig(box.modelFile)).relay_token).toBe('wb_legacy')
  })

  it('中转老版本不回 account:令牌照样换成带会话领的那一把,只是那一格留空(下次启动再绑一遍)', async () => {
    const box = await sandbox()
    let sawSession: string | undefined
    const impl: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/register-device')) {
        sawSession = /^Bearer\s+(.+)$/.exec(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))?.[1]
        return new Response(JSON.stringify({ token: 'wb_new' }), { status: 201 })
      }
      return new Response('{}', { status: 404 })
    }
    await saveModelConfig(box.modelFile, {
      mode: 'relay',
      relay_url: 'https://r.test',
      device_id: 'mac-1',
      relay_token: 'wb_old',
      relay_token_account: OTHER_ACCT,
    })
    const service = createModelService({
      modelFile: box.modelFile,
      credentialFile: box.credentialFile,
      accountFile: box.accountFile,
      relaySession: async () => 'wbs_ben',
      relayAccountScope: async () => ACCT,
      fetchImpl: impl,
    })

    expect((await service.bindToAccount()).changed).toBe(true)
    expect(sawSession).toBe('wbs_ben')
    const after = await loadModelConfig(box.modelFile)
    expect(after.relay_token).toBe('wb_new')
    // **上一把那句话不许留着** —— 留着等于对着一把新令牌说一句旧话,下次就漏绑了。
    expect(after.relay_token_account).toBeUndefined()
  })

  it('领不到就如实说,本机那把令牌一个字节不动(绑不上只是这会儿打不了电话)', async () => {
    const box = await sandbox()
    const impl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: '领取太频繁了,过一会儿再试。' } }), { status: 429 })
    await saveModelConfig(box.modelFile, {
      mode: 'relay', relay_url: 'https://r.test', device_id: 'mac-1', relay_token: 'wb_legacy',
    })
    const service = createModelService({
      modelFile: box.modelFile,
      credentialFile: box.credentialFile,
      accountFile: box.accountFile,
      relaySession: async () => 'wbs_ben',
      relayAccountScope: async () => ACCT,
      fetchImpl: impl,
    })

    const result = await service.bindToAccount()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('太频繁')
    expect((await loadModelConfig(box.modelFile)).relay_token).toBe('wb_legacy')
  })
})

// @vitest-environment node
/**
 * 手机配对与设备令牌(2026-09-11,设计-事务官完整材料 §2 / 第 7 节第 4 项)。
 * 纯服务层:配对码的过期/一次性/错 5 次锁、令牌只存哈希、撤销后认不出来。
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEVICE_KIND_HANDSET, createPairingService, deviceKindOf, hashToken, loadDevicesFile } from '../src/server/devices.ts'

const T0 = 1_757_580_000_000 // 2026-09-11 附近的毫秒时间戳

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'wb-devices-')), 'devices.json')
}

function make(over: { now?: () => number, code?: () => string, token?: () => string } = {}) {
  let clock = T0
  const service = createPairingService({
    file: tmpFile(),
    now: over.now ?? (() => clock),
    ...(over.code === undefined ? {} : { randomCode: over.code }),
    ...(over.token === undefined ? {} : { randomToken: over.token }),
  })
  return { service, tick: (ms: number) => { clock += ms } }
}

describe('配对码', () => {
  it('start 生成 6 位数字码,5 分钟后过期', () => {
    const { service } = make({ code: () => '004217' })
    const started = service.start()
    expect(started.code).toBe('004217')
    expect(started.expires_at).toBe(new Date(T0 + 5 * 60_000).toISOString())
    expect(service.current()).toEqual(started)
  })

  it('过期后 current 为空,claim 也不认', async () => {
    const { service, tick } = make({ code: () => '111111' })
    service.start()
    tick(5 * 60_000 + 1)
    expect(service.current()).toBeUndefined()
    const result = await service.claim({ code: '111111', device_name: '手机', platform: 'ios' })
    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it('一次性:claim 成功后同一个码再来就不认', async () => {
    const { service } = make({ code: () => '222222' })
    service.start()
    const first = await service.claim({ code: '222222', device_name: '手机', platform: 'ios' })
    expect(first.ok).toBe(true)
    expect(service.current()).toBeUndefined()
    const second = await service.claim({ code: '222222', device_name: '另一台', platform: 'android' })
    expect(second).toMatchObject({ ok: false, status: 401 })
  })

  it('再 start 一次就换码,旧码作废', async () => {
    let n = 0
    const { service } = make({ code: () => (n++ === 0 ? '333333' : '444444') })
    service.start()
    const again = service.start()
    expect(again.code).toBe('444444')
    expect((await service.claim({ code: '333333', device_name: '手机', platform: 'ios' })).ok).toBe(false)
    expect((await service.claim({ code: '444444', device_name: '手机', platform: 'ios' })).ok).toBe(true)
  })

  it('错 5 次锁 10 分钟:锁内连正确码都回 429,码被清掉;10 分钟后恢复', async () => {
    const { service, tick } = make({ code: () => '555555' })
    service.start()
    for (let i = 0; i < 4; i++) {
      const wrong = await service.claim({ code: '000000', device_name: '手机', platform: 'ios' })
      expect(wrong).toMatchObject({ ok: false, status: 401 })
    }
    const fifth = await service.claim({ code: '000000', device_name: '手机', platform: 'ios' })
    expect(fifth).toMatchObject({ ok: false, status: 429 })
    expect(service.current()).toBeUndefined()
    // 锁内重新生成码也没用,正确码照样 429。
    service.start()
    expect(await service.claim({ code: '555555', device_name: '手机', platform: 'ios' })).toMatchObject({ ok: false, status: 429 })
    tick(10 * 60_000 + 1)
    service.start()
    expect((await service.claim({ code: '555555', device_name: '手机', platform: 'ios' })).ok).toBe(true)
  })

  it('输入校验:设备名空、平台空、码不是 6 位数字都是 400,且不计入错误次数', async () => {
    const { service } = make({ code: () => '666666' })
    service.start()
    expect(await service.claim({ code: '666666', device_name: '  ', platform: 'ios' })).toMatchObject({ ok: false, status: 400 })
    expect(await service.claim({ code: '666666', device_name: '手机', platform: '' })).toMatchObject({ ok: false, status: 400 })
    expect(await service.claim({ code: '66666', device_name: '手机', platform: 'ios' })).toMatchObject({ ok: false, status: 400 })
    expect(await service.claim({ code: 'abcdef', device_name: '手机', platform: 'ios' })).toMatchObject({ ok: false, status: 400 })
    // 上面四次都不算"错码",正确码仍然能过。
    expect((await service.claim({ code: '666666', device_name: '手机', platform: 'ios' })).ok).toBe(true)
  })
})

describe('设备令牌', () => {
  it('claim 返回明文令牌一次;devices.json 只存 sha256 哈希,文件 0600', async () => {
    const file = tmpFile()
    const service = createPairingService({
      file, now: () => T0, randomCode: () => '777777', randomToken: () => 'plain-token-xyz',
    })
    service.start()
    const result = await service.claim({ code: '777777', device_name: ' Ben 的 iPhone ', platform: 'ios' })
    expect(result).toMatchObject({ ok: true, token: 'plain-token-xyz' })

    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('plain-token-xyz')
    expect(text).toContain(hashToken('plain-token-xyz'))
    expect(statSync(file).mode & 0o777).toBe(0o600)

    const data = await loadDevicesFile(file)
    expect(data.devices).toHaveLength(1)
    expect(data.devices[0]).toMatchObject({
      name: 'Ben 的 iPhone', platform: 'ios', tokenHash: hashToken('plain-token-xyz'),
      createdAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString(),
    })
    expect(data.devices[0]!.revokedAt).toBeUndefined()
  })

  it('authenticate:对的令牌认得出设备,错的、空的认不出', async () => {
    const { service } = make({ code: () => '888888', token: () => 'tok-a' })
    service.start()
    const claimed = await service.claim({ code: '888888', device_name: '手机', platform: 'ios' })
    if (!claimed.ok) throw new Error('claim 应成功')

    const device = await service.authenticate('tok-a')
    expect(device).toMatchObject({ id: claimed.device_id, name: '手机', platform: 'ios' })
    expect(await service.authenticate('tok-b')).toBeUndefined()
    expect(await service.authenticate('')).toBeUndefined()
  })

  it('authenticate 更新 lastSeenAt,但一分钟内不重复落盘', async () => {
    const { service, tick } = make({ code: () => '999999', token: () => 'tok-c' })
    service.start()
    await service.claim({ code: '999999', device_name: '手机', platform: 'ios' })
    tick(30_000)
    await service.authenticate('tok-c')
    expect((await service.list())[0]!.last_seen_at).toBe(new Date(T0).toISOString())
    tick(31_000)
    await service.authenticate('tok-c')
    expect((await service.list())[0]!.last_seen_at).toBe(new Date(T0 + 61_000).toISOString())
  })

  it('list 只给视图字段(没有哈希),撤销后不再列出;撤销后令牌认不出;撤销不存在的回 false', async () => {
    const { service } = make({ code: () => '121212', token: () => 'tok-d' })
    service.start()
    const claimed = await service.claim({ code: '121212', device_name: '手机', platform: 'ios' })
    if (!claimed.ok) throw new Error('claim 应成功')

    const listed = await service.list()
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('tokenHash')
    expect(JSON.stringify(listed)).not.toContain(hashToken('tok-d'))

    expect(await service.revoke(claimed.device_id)).toBe(true)
    expect(await service.list()).toHaveLength(0)
    expect(await service.authenticate('tok-d')).toBeUndefined()
    expect(await service.revoke(claimed.device_id)).toBe(false)
    expect(await service.revoke('nope')).toBe(false)
  })

  it('devices.json 写坏了按空表兜底,不抛', async () => {
    const file = tmpFile()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ not json')
    expect(await loadDevicesFile(file)).toEqual({ version: 1, devices: [] })
  })
})

/**
 * 设备种类(2026-09-21,座机形态:手机 + 树莓派话筒)。
 *
 * **不新存字段**,由配对时报的 platform 推 —— 所以这一组钉的是「推法」本身,
 * 以及「已经配过的手机不受影响」这件事(devices.json 的格式一个字节没变)。
 */
describe('设备种类', () => {
  it('platform 报 handset 的是话筒,别的都是手机', () => {
    expect(deviceKindOf(DEVICE_KIND_HANDSET)).toBe('handset')
    expect(deviceKindOf('HANDSET')).toBe('handset')
    expect(deviceKindOf(' handset ')).toBe('handset')
    expect(deviceKindOf('android')).toBe('phone')
    expect(deviceKindOf('ios')).toBe('phone')
    expect(deviceKindOf('')).toBe('phone')
  })

  it('树莓派配对进来之后 list 里那一台是 handset,手机还是 phone', async () => {
    const { service } = make({ code: () => '314159', token: () => 'tok-pi' })
    service.start()
    expect((await service.claim({ code: '314159', device_name: '座机话筒', platform: 'handset' })).ok).toBe(true)
    const listed = await service.list()
    expect(listed[0]!.kind).toBe('handset')
    expect(listed[0]!.platform).toBe('handset')
  })

  it('★ 老的 devices.json(里头压根没有 kind 这个字段)读出来的手机还是手机', async () => {
    const file = tmpFile()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify({
      version: 1,
      devices: [{
        id: 'd1', name: '我的手机', platform: 'android', tokenHash: hashToken('tok-old'),
        createdAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString(),
      }],
    }))
    const service = createPairingService({ file, now: () => T0 })
    expect((await service.list())[0]!.kind).toBe('phone')
    // 老令牌照常认得出来 —— 这一版没有任何迁移,也不该有。
    expect((await service.authenticate('tok-old'))?.kind).toBe('phone')
  })
})

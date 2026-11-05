// @vitest-environment node
/**
 * 工人替手机办事也算手机在线(2026-10-12,卡 `claude/ops-patch-1012`;运营同学 10-09「跨设备同步」那一条)。
 *
 * 通道工人替手机访问 8791 时只带设备 id(那条降权的头),不带令牌,走不到 authenticate,
 * 于是出门经中转那几天手机那一行一直停在最后一次局域网直连的时刻。
 * 钉三件事:① `touch(id)` 刷 lastSeenAt 并落盘;② 与 authenticate 同一个一分钟限频;③ 认不出 / 已撤销回 undefined、不写盘。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPairingService } from '../src/server/devices.ts'

const T0 = 1_760_000_000_000

function make() {
  const file = join(mkdtempSync(join(tmpdir(), 'wb-devices-touch-')), 'devices.json')
  let clock = T0
  const service = createPairingService({ file, now: () => clock, randomCode: () => '123456' })
  const stored = () => JSON.parse(readFileSync(file, 'utf8')) as { devices: { id: string, lastSeenAt: string }[] }
  return { service, file, stored, tick: (ms: number) => { clock += ms } }
}

async function paired(h: ReturnType<typeof make>): Promise<string> {
  h.service.start()
  const claimed = await h.service.claim({ code: '123456', device_name: '手机', platform: 'android' })
  if (!claimed.ok) throw new Error('配不上')
  return claimed.device_id
}

describe('touch(id)', () => {
  it('★一分钟后再 touch → lastSeenAt 刷新并落盘;一分钟内 → 不动、不写', async () => {
    const h = make()
    const id = await paired(h)
    expect(h.stored().devices[0]?.lastSeenAt).toBe(new Date(T0).toISOString())

    h.tick(30_000)
    expect((await h.service.touch?.(id))?.last_seen_at).toBe(new Date(T0).toISOString())
    expect(h.stored().devices[0]?.lastSeenAt).toBe(new Date(T0).toISOString())

    h.tick(31_000)
    expect((await h.service.touch?.(id))?.last_seen_at).toBe(new Date(T0 + 61_000).toISOString())
    expect(h.stored().devices[0]?.lastSeenAt).toBe(new Date(T0 + 61_000).toISOString())
  })

  it('认不出的 id、撤销了的设备 → undefined,文件一个字不动', async () => {
    const h = make()
    const id = await paired(h)
    const before = readFileSync(h.file, 'utf8')
    h.tick(120_000)
    expect(await h.service.touch?.('nobody')).toBeUndefined()
    expect(readFileSync(h.file, 'utf8')).toBe(before)
    await h.service.revoke(id)
    const revoked = readFileSync(h.file, 'utf8')
    expect(await h.service.touch?.(id)).toBeUndefined()
    expect(readFileSync(h.file, 'utf8')).toBe(revoked)
  })
})

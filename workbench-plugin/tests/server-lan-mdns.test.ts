// @vitest-environment node
/** 局域网地址挑选、二维码内容、mDNS 广播开关(2026-09-11 手机配对)。 */
import { describe, expect, it, vi } from 'vitest'
import { lanAddress, lanAddresses, pairQrContent } from '../src/server/lan.ts'
import { createMdnsAdvertiser, type BonjourLike } from '../src/server/mdns.ts'

describe('局域网地址', () => {
  it('优先 en0,跳过回环/内部/IPv6/链路本地地址', () => {
    const address = lanAddress({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en5: [{ address: '169.254.10.3', family: 'IPv4', internal: false }],
      en1: [{ address: '192.168.8.9', family: 'IPv4', internal: false }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '10.86.37.27', family: 'IPv4', internal: false },
      ],
    })
    expect(address).toBe('10.86.37.27')
  })

  it('没有 en0 就按名字顺序取第一个能用的;一个都没有就是 undefined(不编数)', () => {
    expect(lanAddress({
      utun3: [{ address: '100.64.0.2', family: 'IPv4', internal: false }],
      en1: [{ address: '192.168.8.9', family: 'IPv4', internal: false }],
    })).toBe('192.168.8.9')
    expect(lanAddress({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })).toBeUndefined()
    expect(lanAddress({})).toBeUndefined()
  })

  it('lanAddresses:同一把尺子的整张表(2026-10-21,`/channel/route` 用),第一项就是 lanAddress 挑的那个', () => {
    const interfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      utun3: [{ address: '100.64.0.2', family: 'IPv4', internal: false }],
      en1: [{ address: '192.168.8.9', family: 'IPv4', internal: false }, { address: '192.168.8.10', family: 4, internal: false }],
      en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '10.86.37.27', family: 'IPv4', internal: false }],
      en5: [{ address: '169.254.10.3', family: 'IPv4', internal: false }],
    }
    expect(lanAddresses(interfaces)).toEqual(['10.86.37.27', '192.168.8.9', '192.168.8.10', '100.64.0.2'])
    expect(lanAddresses(interfaces)[0]).toBe(lanAddress(interfaces))
    expect(lanAddresses({})).toEqual([])
  })

  it('二维码内容是 workbench://pair?host=&port=&code=', () => {
    expect(pairQrContent('10.86.37.27', 8791, '004217')).toBe('workbench://pair?host=10.86.37.27&port=8791&code=004217')
  })
})

function fakeBonjour() {
  const published: { name: string, type: string, port: number, txt?: Record<string, string>, stopped: boolean }[] = []
  const bonjour: BonjourLike & { destroyed: boolean } = {
    destroyed: false,
    publish(opts) {
      const record = { ...opts, stopped: false }
      published.push(record)
      return { stop(cb?: () => void) { record.stopped = true; cb?.() } }
    },
    destroy(cb?: () => void) { bonjour.destroyed = true; cb?.() },
  }
  return { bonjour, published }
}

describe('mDNS 广播', () => {
  it('start 发布 _workbench._tcp,TXT 带 port/name/v;stop 撤掉并销毁实例', async () => {
    const { bonjour, published } = fakeBonjour()
    const factory = vi.fn(() => bonjour)
    const advertiser = createMdnsAdvertiser({ bonjour: factory })
    expect(advertiser.active()).toBe(false)

    await advertiser.start({ name: 'Ben 的工作台', port: 8791, version: '0.2.15' })
    expect(advertiser.active()).toBe(true)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      name: 'Ben 的工作台', type: 'workbench', port: 8791, txt: { port: '8791', name: 'Ben 的工作台', v: '0.2.15' },
    })

    await advertiser.stop()
    expect(advertiser.active()).toBe(false)
    expect(published[0]!.stopped).toBe(true)
    expect(bonjour.destroyed).toBe(true)
  })

  it('TXT 多一格 mac_id(2026-10-21,局域网主路):设备不带令牌也先筛得出「是不是我那台」;取不到就缺席', async () => {
    const { bonjour, published } = fakeBonjour()
    const advertiser = createMdnsAdvertiser({ bonjour: () => bonjour })
    await advertiser.start({ name: '工作台', port: 8791, version: '0.4.142', macId: '3f9c0a1b22223333444455556666777a' })
    expect(published[0]?.txt).toEqual({ port: '8791', name: '工作台', v: '0.4.142', mac_id: '3f9c0a1b22223333444455556666777a' })
    await advertiser.stop()
    const second = fakeBonjour()
    const bare = createMdnsAdvertiser({ bonjour: () => second.bonjour })
    await bare.start({ name: '工作台', port: 8791, version: '0' })
    expect(second.published[0]?.txt).toEqual({ port: '8791', name: '工作台', v: '0' })
  })

  it('重复 start 不重复发布;没 start 就 stop 是空操作;start 抛错时 active 保持 false', async () => {
    const { bonjour, published } = fakeBonjour()
    const advertiser = createMdnsAdvertiser({ bonjour: () => bonjour })
    await advertiser.stop()
    await advertiser.start({ name: 'x', port: 1, version: '1' })
    await advertiser.start({ name: 'x', port: 1, version: '1' })
    expect(published).toHaveLength(1)
    await advertiser.stop()

    const broken = createMdnsAdvertiser({ bonjour: () => { throw new Error('端口被占') } })
    await expect(broken.start({ name: 'x', port: 1, version: '1' })).rejects.toThrow('端口被占')
    expect(broken.active()).toBe(false)
  })
})

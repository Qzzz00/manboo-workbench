/**
 * mDNS/Bonjour 广播 `_workbench._tcp`(2026-09-11 手机配对):手机在同一局域网里靠它找到工作台,
 * 找不到再扫码/输码。只在「允许手机在局域网访问」开着时广播,关掉即停。
 *
 * 用的是 bonjour-service 1.4.4(纯 JS,MIT;依赖树 multicast-dns / dns-packet / thunky /
 * fast-deep-equal / @leichtgewicht/ip-codec 共 6 个包,无安装脚本,除 mDNS 自身的
 * 224.0.0.251:5353 UDP 组播外没有任何出站;审计见 docs/superpowers/research/审计-bonjour-service-2026-09-11.md)。
 * 这里只包一层薄壳,把实例创建做成可注入,单测不碰网络。
 */
import Bonjour from 'bonjour-service'

export interface MdnsServiceLike { stop(cb?: () => void): void }
export interface BonjourLike {
  publish(opts: { name: string, type: string, port: number, txt?: Record<string, string> }): MdnsServiceLike
  destroy(cb?: () => void): void
}

export interface MdnsPublishOptions {
  name: string
  port: number
  version: string
  /**
   * 这台 Mac 的机器 id(2026-10-21,局域网主路;server/machineId.ts)。进 TXT 的 `mac_id`:设备在没确认过的网络上
   * 不带令牌、只看广播,先筛出「是不是我配对过的那台」—— 办公室里好几台 8791 时不把令牌发给别人的机器。不是秘密。
   */
  macId?: string
}

export interface MdnsAdvertiser {
  start(opts: MdnsPublishOptions): Promise<void>
  stop(): Promise<void>
  active(): boolean
}

export const MDNS_SERVICE_TYPE = 'workbench'

function defaultBonjour(): BonjourLike {
  return new Bonjour() as unknown as BonjourLike
}

export function createMdnsAdvertiser(deps: { bonjour?: () => BonjourLike } = {}): MdnsAdvertiser {
  const factory = deps.bonjour ?? defaultBonjour
  let running: { bonjour: BonjourLike, service: MdnsServiceLike } | undefined

  return {
    async start(opts) {
      if (running !== undefined) return
      const bonjour = factory()
      const service = bonjour.publish({
        name: opts.name,
        type: MDNS_SERVICE_TYPE,
        port: opts.port,
        txt: { port: String(opts.port), name: opts.name, v: opts.version, ...(opts.macId === undefined ? {} : { mac_id: opts.macId }) },
      })
      running = { bonjour, service }
    },
    async stop() {
      if (running === undefined) return
      const { bonjour, service } = running
      running = undefined
      // 先撤服务(发 goodbye 包),再销毁实例关掉 UDP 套接字;两步都可能没回调,不等超过一秒。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000)
        service.stop(() => { clearTimeout(timer); resolve() })
      })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000)
        bonjour.destroy(() => { clearTimeout(timer); resolve() })
      })
    },
    active() {
      return running !== undefined
    },
  }
}

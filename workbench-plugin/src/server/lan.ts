/**
 * 局域网侧的两个小工具(2026-09-11 手机配对):挑一个本机局域网 IPv4 给二维码用,
 * 以及拼二维码内容。取不到地址就返回 undefined——界面只显示数字码,**不编一个地址**。
 */
import { networkInterfaces } from 'node:os'

export interface InterfaceAddress { address: string, family: string | number, internal: boolean }

/**
 * 挑 Mac 上手机最可能够得到的那个 IPv4:en0(Wi-Fi)优先,再 en1…,其余按名字排序取第一个。
 * 跳过回环/内部地址、IPv6、169.254 链路本地(没 DHCP 时系统自己编的,手机连不上)。
 */
export function lanAddress(
  interfaces: Record<string, readonly InterfaceAddress[] | undefined> = networkInterfaces(),
): string | undefined {
  return lanAddresses(interfaces)[0]
}

/**
 * 同一把尺子挑出来的**整张表**(2026-10-21,局域网主路):`GET /channel/route` 把它交给设备更新候选地址表,
 * 工人替房里的设备续期时取第一项当本机房间的地址。顺序与 {@link lanAddress} 一样(en0 优先),第一项就是它。
 */
export function lanAddresses(
  interfaces: Record<string, readonly InterfaceAddress[] | undefined> = networkInterfaces(),
): string[] {
  const usable = (entry: InterfaceAddress): boolean =>
    !entry.internal
    && (entry.family === 'IPv4' || entry.family === 4)
    && !entry.address.startsWith('169.254.')
    && !entry.address.startsWith('127.')
  const names = Object.keys(interfaces).sort((a, b) => {
    const rank = (name: string): number => (name === 'en0' ? 0 : name.startsWith('en') ? 1 : 2)
    return rank(a) - rank(b) || a.localeCompare(b)
  })
  const out: string[] = []
  for (const name of names) {
    for (const entry of interfaces[name] ?? []) {
      if (usable(entry) && !out.includes(entry.address)) out.push(entry.address)
    }
  }
  return out
}

/** 手机扫到的内容。自定义 scheme,手机 App 与展示台都认这一种。 */
export function pairQrContent(host: string, port: number, code: string): string {
  const params = new URLSearchParams({ host, port: String(port), code })
  return `workbench://pair?${params.toString()}`
}

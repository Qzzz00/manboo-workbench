/**
 * 连接器那一行字(卡 OC2)。**全仓唯一**拼这句话的地方 —— 服务端、电脑、手机都读它,
 * 于是同一件事三端说法一字不差(同 `waiting.ts` 那条纪律:数字与说法只算一遍)。
 *
 * 刻意放在 `src/` 根而不是 `client/`:服务端也 import 它。
 * 里头没有任何 I/O、没有任何 node 依赖。
 */
import type { ConnectorView } from './protocol.ts'

export function connectorRowText(view: ConnectorView): string {
  // 「约 230MB」——报整十兆,不报精确字节(界面上说的是量级)。
  const mb = Math.round(view.downloadBytes / (1024 * 1024) / 10) * 10
  if (view.phase === 'installing') return `连接器:正在装(第一次要下载约 ${mb}MB)`
  if (view.phase === 'failed') return `连接器:没装上 —— ${view.note ?? '这次没装上。'}`
  if (!view.installed) return `连接器:还没装(开机后自己装,第一次要下载约 ${mb}MB)`
  const bits: string[] = ['连接器:已装好']
  // 取不到就整句不显示,**不写 0**(D13)。
  if (view.apps !== undefined) bits.push(`可用 ${view.apps} 家`)
  if (view.connected !== undefined) bits.push(`接了 ${view.connected} 家`)
  if (!view.running) bits.push('这会儿没在跑')
  return bits.join(' · ')
}

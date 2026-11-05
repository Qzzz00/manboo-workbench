/**
 * 局域网身份与成员(2026-10-24,协作区事实契约 §5)的**纯函数**与探测。
 *
 * 底座核查结论(如实):本机没有常驻 LAN 发现服务(也不许加)。成员 = 配对时登记的注册表 +
 * **按需**(UI 显式 `refresh=1`)逐个短超时 ping,不是后台扫描;relay 名单不冒充 LAN 成员。
 *
 * 读写 tasks.json 的那几个方法在 tasks.ts(走它的写队列,单一写口);这里只有:
 * 名归一(查重用)、对端探测(`GET /collab/lan/hello`)、注册表合并。
 */
import type { LanMember } from '../protocol.ts'

/**
 * 名归一(NFKC、casefold、去首尾、压连续空白):「小ｋ 」与「小K」是同一个名。
 * 查重按归一名比,不按原文比。
 */
export function normalizeLanName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 改名 / 登记前与已知成员查重(归一名)。重了回冲突那一员的 member_id。
 */
export function lanNameConflict(name: string, members: readonly LanMember[]): string | undefined {
  const wanted = normalizeLanName(name)
  if (wanted === '') return undefined
  const hit = members.find(one => normalizeLanName(one.name) === wanted)
  return hit?.member_id
}

/**
 * 成员列表**不完整**的判据(契约 §5):有成员从没 refresh 成功过或已失联(`reachable` 非 true),
 * 名称可用性就未知 —— 不知道远处是不是坐着一个同名的人。空注册表不拦(无成员 = 无冲突)。
 */
export const LAN_MEMBER_FRESH_MS = 2 * 60 * 1000

/** 读侧现算,不擦历史 last_seen;过期或未来时刻都不能冒当前可达。 */
export function lanMemberSnapshot(member: LanMember, nowMs = Date.now()): LanMember {
  const seen = Date.parse(member.last_seen ?? '')
  if (Number.isFinite(seen) && nowMs >= seen && nowMs - seen <= LAN_MEMBER_FRESH_MS) return member
  const { reachable: _lastResult, ...unknown } = member
  return unknown
}

export function lanMembersIncomplete(members: readonly LanMember[], nowMs = Date.now()): boolean {
  return members.some(one => lanMemberSnapshot(one, nowMs).reachable !== true)
}

/** ping 对端的那一个口(2 秒超时;这是按需触发,不是后台扫描)。通 = 对端身份,不通 = undefined。 */
export async function pingLanMember(member: Pick<LanMember, 'host' | 'port'>): Promise<{ member_id: string, name: string } | undefined> {
  try {
    const res = await fetch(`http://${member.host}:${member.port}/collab/lan/hello`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return undefined
    const body = await res.json() as Record<string, unknown>
    if (typeof body.member_id !== 'string' || typeof body.name !== 'string') return undefined
    return { member_id: body.member_id, name: body.name }
  }
  catch {
    return undefined
  }
}

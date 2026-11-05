/**
 * 本机事务官的局域网身份(2026-10-24,小K collab-desktop-1024,消费 core 契约 §5 F)。
 *
 * - 展示名(name)与稳定身份(member_id)分开:改名只改展示,关联全按 member_id,界面明说「身份不变」;
 * - 保存前**显式** refresh 成员(按需 ping,不是后台扫描):成员不完整 → 「可用性未知」,不显示「可用」、不改名;
 * - 归一重名 409 → 原话说清和谁冲突;版本冲突 409 → 保留输入、亮服务端当前副本、可按那版重试;
 * - 可达性没 ping 过 = 「可达性未知」,不说在线。
 */
import { useEffect, useState } from 'react'
import type { LanIdentity, LanMember } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { LanPeerConnect } from './LanPeerConnect.tsx'

function whenText(iso: string | undefined): string {
  if (iso === undefined) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${at.getMonth() + 1} 月 ${at.getDate()}日 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export function LanIdentityPanel({ api }: { api: CollabApi }) {
  const [identity, setIdentity] = useState<LanIdentity | undefined>(undefined)
  const [identityLive, setIdentityLive] = useState<boolean | undefined>(undefined)
  const [members, setMembers] = useState<readonly LanMember[] | undefined>(undefined)
  const [name, setName] = useState('')
  const [note, setNote] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [serverCopy, setServerCopy] = useState<LanIdentity | undefined>(undefined)

  useEffect(() => {
    let alive = true
    // 实际回包是 { identity } 一层壳;形状不对(老服务/空壳)= 没接上,不拿假身份往后续塞。
    void api.get<{ identity?: unknown }>('/collab/lan/identity').then((got) => {
      if (!alive) return
      const identity = got?.identity
      if (identity === undefined || typeof identity !== 'object' || identity === null
        || typeof (identity as LanIdentity).member_id !== 'string' || typeof (identity as LanIdentity).name !== 'string') {
        setIdentityLive(false)
        return
      }
      setIdentityLive(true)
      setIdentity(identity as LanIdentity)
      setName((identity as LanIdentity).name)
    })
    void api.get<{ members?: LanMember[], incomplete?: boolean }>('/collab/lan/members').then((got) => {
      if (alive) setMembers(got?.members ?? [])
    })
    return () => { alive = false }
  }, [api])

  const save = async (expectedVersion: number, withName: string): Promise<void> => {
    setBusy(true)
    setNote(undefined)
    setServerCopy(undefined)
    // 保存前显式查一遍成员(按需 ping,不是后台扫描);成员列表不完整就不说「可用」。
    const refreshed = await api.get<{ members?: LanMember[], incomplete?: boolean }>('/collab/lan/members?refresh=1')
    if (Array.isArray(refreshed?.members)) setMembers(refreshed.members)
    if (refreshed === undefined || !Array.isArray(refreshed.members) || refreshed.incomplete === true || refreshed.members.some(member => member.reachable !== true)) {
      setBusy(false)
      setNote('成员列表不完整,名称可用性未知 —— 没有确认「可用」,名字没改。')
      return
    }
    setMembers(refreshed.members ?? [])
    const got = await api.post('/collab/lan/identity', { name: withName, expected_version: expectedVersion })
    setBusy(false)
    const body = got.body as { ok?: boolean, error?: string, conflict_with?: string, availability?: string, identity?: LanIdentity }
    if (!got.ok || body.ok !== true) {
      if (body.availability === 'unknown') { setNote(`${body.error ?? '名称可用性未知'} —— 没有确认「可用」,名字没改。`); return }
      if (body.identity !== undefined) {
        // 并发保存冲突:保留他打的输入,亮服务端当前副本,可按那版重试。
        setServerCopy(body.identity)
        setNote(body.error ?? '保存冲突:别的窗口刚改过。')
        return
      }
      setNote(body.conflict_with !== undefined && body.error !== undefined ? `${body.error}:${body.conflict_with}` : got.error ?? body.error ?? '没存上')
      return
    }
    if (body.identity !== undefined) setIdentity(body.identity)
    setNote('名称存好了(身份不变,还是原来那个)')
  }

  if (identityLive === false) {
    return <p className="ben-cl__muted" role="status">局域网身份账还没接上(老服务);频道消息照常只读。</p>
  }
  return (
    <section className="ben-cl__lan" aria-label="本机事务官身份">
      <div className="ben-cl__lan-row">
        <label>
          本机事务官名称
          <input aria-label="本机事务官名称" value={name} onChange={(event) => { setName(event.target.value); setServerCopy(undefined) }} />
        </label>
        <button type="button" className="ben-cl__primary" disabled={busy || name.trim() === '' || identity === undefined} onClick={() => { if (identity !== undefined) void save(identity.version, name.trim()) }}>
          {busy ? '在查' : '查重并保存'}
        </button>
        {identity !== undefined && <small className="ben-cl__muted" title="稳定身份 ID,改名不换">身份 {identity.member_id.slice(0, 8)}…</small>}
      </div>
      {identity !== undefined && <LanPeerConnect api={api} memberId={identity.member_id} onConnected={() => { void api.get<{ members?: LanMember[] }>('/collab/lan/members').then(got => setMembers(got?.members ?? [])) }} />}
      {note !== undefined && <p role="status" className="ben-cl__lan-note">{note}</p>}
      {serverCopy !== undefined && (
        <p className="ben-cl__lan-conflict">
          服务端现在叫「{serverCopy.name}」(第 {serverCopy.version} 版)。
          <button type="button" className="ben-cl__secondary" onClick={() => { setName(serverCopy.name); if (identity !== undefined) void save(serverCopy.version, serverCopy.name) }}>按服务端这版重试</button>
        </p>
      )}
      <div className="ben-cl__lan-members">
        <small className="ben-cl__muted">局域网成员(保存前按需重查,不后台扫描)</small>
        {(members ?? []).map((one) => (
          <span key={one.member_id} className="ben-cl__lan-member" data-reachable={one.reachable}>
            {one.name}
            <small>
              {one.reachable === true ? `在线 · ${whenText(one.last_seen)}` : one.reachable === false ? '现在不在' : '可达性未知'}
            </small>
          </span>
        ))}
        {members !== undefined && members.length === 0 && <small className="ben-cl__muted">还没有登记过别的机器。</small>}
      </div>
    </section>
  )
}

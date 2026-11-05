import { useEffect, useState } from 'react'
import { readServiceBaseUrl } from '../../serviceOrigin.ts'
import { DEFAULT_BASE_URL } from '../useWorkbenchState.ts'
import type { PairingView } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'

/** 配对凭据只在当前表单内存中,授权与令牌保存由既有服务负责。 */
export function LanPeerConnect({ api, memberId, onConnected }: { api: CollabApi, memberId: string, onConnected: () => void }) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState(() => {
    const origin = new URL(api.baseUrl || readServiceBaseUrl(globalThis) || DEFAULT_BASE_URL)
    return origin.port || (origin.protocol === 'https:' ? '443' : '80')
  })
  const [peerId, setPeerId] = useState('')
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState<PairingView>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (pairing === undefined) return
    const remaining = Date.parse(pairing.expires_at) - Date.now()
    const timer = setTimeout(() => setPairing(undefined), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [pairing])
  return <details className="ben-cl__lan-connect" onToggle={event => { if (!event.currentTarget.open) { setPairing(undefined); setCode('') } }}>
    <summary>连接局域网协作成员</summary>
    <p className="ben-cl__muted">在对端生成一次性配对码后，填写它的局域网地址和稳定身份。双方都连接一次，才能互相交回报告。</p>
    <label>本机稳定身份<input aria-label="本机稳定身份" readOnly value={memberId} /></label>
    <button type="button" disabled={busy} onClick={() => {
      setBusy(true)
      void api.post('/pair/start', {}).then(got => {
        setBusy(false)
        const value = got.body.pairing as PairingView | undefined
        if (!got.ok || typeof value?.code !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) { setNote(got.error ?? '配对码此刻生成不了'); return }
        setPairing(value)
        setNote('配对码一次有效，过期后重新生成。')
      })
    }}>生成本机协作配对码</button>
    {pairing !== undefined && <output aria-label="本机协作配对码">{pairing.code}</output>}
    <form onSubmit={event => {
      event.preventDefault()
      setBusy(true)
      void api.post('/collab/lan/connect', { host: host.trim(), port: Number(port), member_id: peerId.trim(), code: code.trim() }).then(got => {
        setBusy(false)
        setCode('')
        if (!got.ok || got.body.ok !== true) { setNote(got.error ?? (typeof got.body.error === 'string' ? got.body.error : '配对未确认，请核对对端后再试')); return }
        setNote('协作成员已配对，可在共同项目中收发记录。')
        onConnected()
      })
    }}>
      <label>对端局域网地址<input aria-label="对端局域网地址" value={host} onChange={event => setHost(event.target.value)} placeholder="192.168.…" /></label>
      <label>对端端口<input aria-label="对端端口" type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label>
      <label>对端稳定身份<input aria-label="对端稳定身份" value={peerId} onChange={event => setPeerId(event.target.value)} /></label>
      <label>对端一次性配对码<input aria-label="对端一次性配对码" type="password" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} /></label>
      <button type="submit" disabled={busy || !host.trim() || !peerId.trim() || !code.trim() || Number(port) < 1 || Number(port) > 65535}>配对协作成员</button>
    </form>
    {note !== '' && <p role="status">{note}</p>}
  </details>
}

/**
 * 设置弹窗里的「账号」一节(2026-09-17)。三件事:用户名、改密码、退出登录。
 *
 * 为什么改密码放这里而不是登录屏:登录屏是**没登录时**的那一屏,而改密码要求已经登录
 * (服务端那条 register 就是这么分岔的)。退出登录之后界面回到登录屏 —— 上层拿 onChanged
 * 重新问一次 /account 即可,这里不自己记状态。
 */
import { useCallback, useEffect, useState } from 'react'
import { CONFIRMS, ConfirmDialog } from '../ui/index.tsx'
import { SetActions, SetBtn, SetField, SetFields, SetFold, SetMsg, SetRow, SetSection } from '../settings/setKit.tsx'
import {
  changePassword, deviceKindText, fetchDevices, lastSeenText, logoutAccount, revokeDevice,
  type AccountView, type DeviceRow,
} from './accountApi.ts'

export function AccountPanel({ baseUrl, fetchImpl, view, onChanged }: {
  baseUrl: string
  fetchImpl?: typeof fetch
  view: AccountView
  /** 改完密码 / 退出登录之后调一次:上层重新问一次 /account,由它决定回不回登录屏。 */
  onChanged: () => void
}) {
  const doFetch = fetchImpl ?? fetch
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 「退出登录」先问一句(共用确认弹层)。 */
  const [asking, setAsking] = useState(false)

  async function save(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      await changePassword(baseUrl, { current_password: current, password: next, confirm }, doFetch)
      setCurrent('')
      setNext('')
      setConfirm('')
      setOpen(false)
      setMessage('密码改好了。别的地方登录着的话,那边会退回登录屏。')
      onChanged()
    }
    catch (err) {
      // 服务端那句话原样显示(「当前密码不对」「两次输入的密码不一样」),不自己另编一套。
      setMessage(err instanceof Error ? err.message : '改密码失败')
    }
    finally {
      setBusy(false)
    }
  }

  async function logout(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      await logoutAccount(baseUrl, doFetch)
      onChanged()
    }
    catch (err) {
      setMessage(err instanceof Error ? err.message : '退出登录失败')
    }
    finally {
      setBusy(false)
    }
  }

  // 评审页 `section('account', '工作台账号', …)`:一行(账号 + 「已登录 · …」)+ 一颗动作,底下文字「退出登录」。
  // 改密码那三格在「改密码」里摊开;账号在服务器上时「我的设备」收进折叠。
  return (
    <SetSection id="ben-wb-account" title="工作台账号" className="ben-wb__account-panel">
      <SetRow
        title={view.username ?? '(没有用户名)'}
        // 缺席 = 还是本机账号,所以一律 `=== true`(同 NeedBar 那条口径)。
        sub={view.on_server === true ? '已登录 · 在工作台的服务器上' : '已登录 · 只在这台机器上'}
      >
        <SetBtn aria-expanded={open} onClick={() => { setOpen(!open); setMessage(null) }}>改密码</SetBtn>
      </SetRow>

      {open && (
        <div className="ben-wb__srow-more">
          <SetFields>
            <SetField label="当前密码" full>
              <input type="password" value={current} onChange={e => setCurrent(e.target.value)} />
            </SetField>
            <SetField label="新密码">
              <input type="password" value={next} onChange={e => setNext(e.target.value)} />
            </SetField>
            <SetField label="确认新密码">
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            </SetField>
          </SetFields>
          <SetActions>
            <SetBtn kind="outline" disabled={busy} onClick={() => { void save() }}>保存新密码</SetBtn>
          </SetActions>
        </div>
      )}

      {message !== null && <SetMsg>{message}</SetMsg>}

      <SetActions>
        <SetBtn kind="text" disabled={busy} onClick={() => setAsking(true)}>退出登录</SetBtn>
      </SetActions>

      {/* 账号在服务器上才有"我名下有哪几台" —— 本机账号谈不上这件事。 */}
      {view.on_server === true && (
        <SetFold summary="我的设备">
          <MyDevices baseUrl={baseUrl} fetchImpl={doFetch} />
        </SetFold>
      )}
      {asking && (
        <ConfirmDialog
          {...CONFIRMS.logout}
          body="退出之后这台工作台回到登录页,重新登录才能接着用。"
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); void logout() }}
        />
      )}
    </SetSection>
  )
}

/**
 * 「我的设备」(2026-09-21)。这一节回答的是**丢了手机怎么办**:
 * 哪几台、上次什么时候在线、按一下就把那台踢掉(它的设备令牌当场失效,
 * 既发不了模型请求,也签不出进房凭证)。
 *
 * 2026-10-03(卡 claude/device-revoke-complete,审计附证 A):这一下**连本机的局域网配对
 * 一起撤**。在那之前只撤了账号那一个凭据体系 —— 被移除的手机回到家里照常能用,这一节
 * 那句承诺其实只兑现了一部分。服务端那三处怎么联动,见 server/http.ts 的
 * `/account/devices/revoke` 与 server/deviceAccountGate.ts。
 *
 * 两条:
 * - 读不到**不吵**、也不空着:说一句为什么(没登录 / 服务器不可达),这两种情况
 *   用户能做的事完全不同;
 * - **移除这台电脑自己要二次确认**,而且话说清楚后果(工作台这边要重新登录)。
 */
function MyDevices({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl: typeof fetch }) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setDevices(await fetchDevices(baseUrl, fetchImpl))
      setError(null)
    }
    catch (err) {
      setError(err instanceof Error ? err.message : '读不到设备列表')
    }
  }, [baseUrl, fetchImpl])

  useEffect(() => { void load() }, [load])

  async function remove(device: DeviceRow): Promise<void> {
    const what = device.current === true
      ? '移除这台电脑?这台工作台会退回登录页,要重新登录一次。'
      // 2026-10-03(卡 claude/device-revoke-complete):这一下现在连**本机配对**一起撤 ——
      // 那台手机在家里的局域网上也连不上了。话要说准:回来的路是重新扫码配对,不是"重新登录"。
      : `移除「${device.name ?? device.device_id}」?那台设备会连不上 —— 出门在外、在家里的 Wi-Fi 上都连不上,要重新扫一次电脑上的配对二维码才能回来。`
    if (!window.confirm(what)) return
    setBusy(device.device_id)
    setError(null)
    try {
      setDevices(await revokeDevice(baseUrl, device.device_id, fetchImpl))
    }
    catch (err) {
      setError(err instanceof Error ? err.message : '移除失败')
    }
    finally {
      setBusy(null)
    }
  }

  return (
    <div className="ben-wb__account-devices">
      {error !== null && <SetMsg>{error}</SetMsg>}
      {error === null && devices === null && <SetMsg>正在读…</SetMsg>}
      {error === null && devices !== null && devices.length === 0 && <SetMsg>这个账号下还没有设备</SetMsg>}
      {devices !== null && devices.length > 0 && (
        <div role="list" aria-label="我的设备">
          {devices.map(device => (
            <SetRow
              role="listitem"
              key={device.device_id}
              title={device.name ?? device.device_id}
              sub={`${deviceKindText(device.kind)}${device.current === true ? ' · 这一台' : ''} · ${lastSeenText(device.last_seen_at, Date.now())}`}
            >
              <SetBtn kind="text" disabled={busy === device.device_id} onClick={() => { void remove(device) }}>移除</SetBtn>
            </SetRow>
          ))}
        </div>
      )}
    </div>
  )
}

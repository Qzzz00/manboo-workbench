/**
 * 设置弹窗里的「连接器」一行(卡 OC2,2026-09-27)。
 *
 * 连接器**默认装上**(维护者 09-27 11:30:「到底是装还是不装?我是让你装啊」),
 * 开机后工作台在后台自己装,所以这一屏不是一个「装不装」的开关,而是**一行状态** +
 * 一颗「卸掉」+(只在装失败时出现的)「再试一次」。
 *
 * 那句话由 `connectorRowText` 拼(服务端与这里共用**同一个函数**)—— 同一件事各处说法一致。
 * 数字纪律(D13):`/state.connector` 里没给的一律不显示,**不写 0**。
 * 服务端拒绝的话原样转达(例如「Claude Code 那边的这一条你自己改过,没覆盖它。」),不自己编一句。
 *
 * 完整的授权那几屏(要填哪几格、去哪儿申请、OAuth 走一遍)留给下一张卡;
 * 在那之前这里只如实说「接了几家」。
 */
import { useState } from 'react'
import { CONFIRMS, ConfirmDialog } from './ui/index.tsx'
import { SetActions, SetBtn, SetMsg, SetRow, SetSection } from './settings/setKit.tsx'
import type { ConnectorView } from '../protocol.ts'
import { connectorRowText } from '../connectorText.ts'

export function ConnectorPanel({ baseUrl, fetchImpl, connector }: {
  baseUrl: string
  fetchImpl?: typeof fetch
  connector: ConnectorView
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** 「卸掉连接器」先问一句,代价在那一句里说(共用确认弹层)。 */
  const [asking, setAsking] = useState(false)

  async function act(action: 'install' | 'uninstall' | 'start' | 'stop', okText: string): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await (fetchImpl ?? fetch)(`${baseUrl}/connector/${action}`, { method: 'POST' })
      const body = await res.json() as { ok?: boolean, error?: string }
      setMessage(res.ok && body.ok === true ? okText : (body.error ?? '操作失败'))
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败')
    }
    finally {
      setBusy(false)
    }
  }

  const hosts = connector.hosts.filter((h) => h.connected).map((h) => h.label).join(' / ')

  // 评审页 `section('connector', '连接器', …)`:一行「工作台连接器 / 状态」+ 一颗动作,底下文字「卸掉连接器」。
  // 每节最多一颗主动作:装砸了是「再试一次」,停着是「启动」,开着是「先停掉它」。
  return (
    <SetSection id="ben-wb-connector" title="连接器">
      <SetRow
        title="工作台连接器"
        sub={(
          <span role="status">
            {connectorRowText(connector)}
            {hosts === '' ? '' : ` 已经接给:${hosts}。`}
            {/* note 只在它自己不进那一句时才补一句(failed 那一档已经把 note 说进去了)。 */}
            {connector.note !== undefined && connector.phase !== 'failed' ? ` ${connector.note}` : ''}
          </span>
        )}
      >
        {connector.phase === 'failed'
          ? <SetBtn kind="outline" disabled={busy} onClick={() => { void act('install', '开始装了') }}>再试一次</SetBtn>
          : connector.installed && !connector.running
            ? <SetBtn kind="outline" disabled={busy} onClick={() => { void act('start', '起来了') }}>启动</SetBtn>
            : connector.installed && connector.running
              ? <SetBtn disabled={busy} onClick={() => { void act('stop', '停了') }}>先停掉它</SetBtn>
              : null}
      </SetRow>
      {connector.installed && (
        <SetActions>
          <SetBtn kind="text" disabled={busy} onClick={() => setAsking(true)}>卸掉连接器</SetBtn>
        </SetActions>
      )}
      {message !== null && <SetMsg>{message}</SetMsg>}
      {asking && (
        <ConfirmDialog
          {...CONFIRMS.removeConnector}
          body="卸掉会把各家账号的登录一起删,依赖它的那几家暂时用不了;以后要用得重新授权一遍。"
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); void act('uninstall', '卸掉了') }}
        />
      )}
    </SetSection>
  )
}

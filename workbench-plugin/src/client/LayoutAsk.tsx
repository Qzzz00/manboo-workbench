/**
 * 「我把 X 挪到 Y,对吗?」—— 待确认的布局改动那张卡(2026-09-22「用自然语言改布局」)。
 *
 * 它是这条链路上**唯一一道人做的门**(PRD §5 功能层提议 / §9 门槛②③):在他按下
 * 「就这样」之前,布局一格没动、盘上一个字节没写。
 *
 * ## 为什么复述不经模型
 *
 * 那句话是服务端**从词表里拼出来的**(`parseLayoutWords` 的 restate),一个字都不是生成的。
 * 复述最忌讳的就是复述出他没说过的意思 —— 那样这道门反而变成了误解的放大器。
 * 同 DevToolAsk 的第一条注释。
 *
 * ## 两颗按钮的字为什么是「就这样」/「不动」
 *
 * 卡里 Ben 定的就是这两个词。「不动」比「取消」准:取消听着像"这次操作没成功",
 * 而他要表达的是"布局保持现在这样"。
 *
 * ## 改完之后那一句
 *
 * 由服务端回(`note`,含「撤销」两个字)。**界面不自己编一句** —— 快照没存下时那一句
 * 会变成"改好了,但撤不回来",而只有服务端知道快照到底存没存下(D13)。
 */
import { useState } from 'react'
import type { LayoutAskView } from '../protocol.ts'

export function LayoutAsk({ ask, baseUrl, fetchImpl }: {
  ask: LayoutAskView
  baseUrl: string
  fetchImpl: typeof fetch
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const send = async (path: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ask.id }),
      })
      const payload = await res.json() as { ok?: boolean, error?: string }
      // 只有服务端说成了才算成:这张卡由下一拍 /state 撤下去,这里不本地乐观删
      // (同 DevToolAsk / DockTabBar 那条"真相在服务端"的纪律)。
      if (payload.ok !== true) setError(payload.error ?? '没办成')
    }
    catch { setError('工作台服务没应答,布局一格没动') }
    finally { setBusy(false) }
  }

  return (
    <section className="ben-wb__layoutask" aria-label="待确认的布局改动">
      <p className="ben-wb__layoutask-head">我这就改,先对一下:</p>
      <p className="ben-wb__layoutask-say">{ask.restate}</p>
      <p className="ben-wb__layoutask-note">
        {ask.orientation === 'landscape' ? '(说的是横屏这一版布局)' : '(说的是竖屏这一版布局)'}
      </p>
      <div className="ben-wb__layoutask-row">
        <button type="button" disabled={busy} onClick={() => { void send('/layout/confirm') }}>就这样</button>
        <button type="button" disabled={busy} onClick={() => { void send('/layout/cancel') }}>不动</button>
      </div>
      {error !== undefined && <p className="ben-wb__layoutask-err" role="alert">{error}</p>}
    </section>
  )
}

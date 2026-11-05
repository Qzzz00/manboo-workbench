/**
 * 「我理解的是这个,对吗?」—— 待确认的小工具需求那张卡(2026-09-21)。
 *
 * 它是这条链路上**唯一一道人做的门**(PRD §9 门槛②③):在他按下「就这样」之前,
 * 一张事项卡都没建、一个字都没派出去、盘上一个字节都没写。
 *
 * ★ 2026-10-01(设计 C2「小组件派出去」):按下去之后**不再是事务官自己写**,而是派给这台
 * 电脑上能写代码的那一家(事务官只写交代 + 验收)。一家都派不出去时服务端如实回一句,
 * 这张卡原地留着、把那句话上屏 —— 她装上一家再点一次就行。
 *
 * ## 为什么复述是他自己的原话
 *
 * 复述那段字是服务端**从他那句话里切出来的**(去掉预填的开头),一个字都不是生成的。
 * 复述最忌讳的就是复述出他没说过的意思 —— 那样这道门反而变成了误解的放大器。
 *
 * ## 草图那一行
 *
 * 草图(一句话描述界面)确实需要模型。**这一版没接**,所以这里如实写一句
 * 「这一版没有草图,照你说的做」,而不是拿一句模板话冒充(D13)。
 * 接上了(服务端的 `sketch` 端口)这一行就变成真的草图,组件一行不用改。
 *
 * ## 名字为什么在这里问
 *
 * 那是窗位叠上标签要写的字。代码替他起一个只能起出「小工具 1」这种东西;模型能起,
 * 但这一版没模型。**问一句比猜一个强** —— 而且他自己起的名字,过一个月还认得出。
 */
import { useState, type FormEvent } from 'react'
import type { DevToolProposalView } from '../protocol.ts'

export function DevToolAsk({ proposal, baseUrl, fetchImpl }: {
  proposal: DevToolProposalView
  baseUrl: string
  fetchImpl: typeof fetch
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const send = async (path: string, body: Record<string, unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const payload = await res.json() as { ok?: boolean, error?: string }
      // 只有服务端说成了才算成:界面上那条待确认由下一拍 /state 撤下去,这里不本地乐观删
      // (同 DockTabBar 那条"真相在服务端"的纪律)。
      if (payload.ok !== true) setError(payload.error ?? '没办成')
    }
    catch { setError('工作台服务没应答,这条需求还留着') }
    finally { setBusy(false) }
  }

  const confirm = (event: FormEvent): void => {
    event.preventDefault()
    void send('/devtool/confirm', { id: proposal.id, name })
  }

  return (
    <form className="ben-wb__devtool-ask" onSubmit={confirm} aria-label="待确认的小工具需求">
      <p className="ben-wb__devtool-ask-head">我把它记成了这件事,对吗?</p>
      <p className="ben-wb__devtool-ask-need">{proposal.restate}</p>
      {proposal.sketch === undefined
        ? <p className="ben-wb__devtool-ask-none">(这一版没有草图给你先看 —— 做它的那一家会照你上面这句话做)</p>
        : <p className="ben-wb__devtool-ask-sketch">草图:{proposal.sketch}</p>}
      <div className="ben-wb__devtool-ask-row">
        <input
          className="ben-wb__devtool-ask-name"
          aria-label="这个小工具叫什么"
          placeholder="给它起个名(标签上写这几个字)"
          value={name}
          onChange={event => setName(event.target.value)}
        />
        <button type="submit" disabled={busy}>就这样,派出去做</button>
        <button type="button" disabled={busy} onClick={() => { void send('/devtool/cancel', { id: proposal.id }) }}>
          不做了
        </button>
      </div>
      {error !== undefined && <p className="ben-wb__devtool-ask-err" role="alert">{error}</p>}
    </form>
  )
}

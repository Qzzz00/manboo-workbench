/**
 * 「这 3 次你都在说 X —— 要不要把它固化下来?」那张卡(2026-09-22,卡 ⑥ 进化循环)。
 *
 * 摆的位置与 `DevToolAsk` / `LayoutAsk` 一样(输入框正上方):它跟那两张是同一类东西 ——
 * **事务官替她动她的东西之前,先把自己的理解说一遍**。不同的是这一张的源头不是她刚说的
 * 一句话,而是她**反复在做的一件事**,所以卡上摆得出「我哪三次说过」。
 *
 * ## 三颗键
 *
 * 「做」/「不要」/「以后再说」—— 卡里 Ben 定的就是这三个。
 * 「不要」不是「取消」:它会被记住(`evolve.json` 的 `declined`),**以后不再提这一条**。
 * 「以后再说」只是这次撤下,下次扫到还会再提。两者的差别写在按钮底下那行小字里 ——
 * 一颗会让某件事永远消失的按钮,不说清楚就等于陷阱。
 *
 * ## 「它准备怎么做、会碰什么」
 *
 * 三条路各有一段,**由服务端从固定模板拼出来**(server/evolve.ts 的 `evolvePlan`),
 * 一个字都不是生成的。她点哪条路,就看哪一段 —— 这是她按下「做」之前唯一看得见的凭据。
 *
 * ## 技能那条路要先起个名字
 *
 * 因为它要在仓库里建一个文件 `docs/技能/固化-<名>.md`。名字由她给,服务端再过一道闸
 * (不能带 `/`、`..`,不超过 24 个字)—— 「在用户仓库里按一个候选句子建文件」是这里最该防的事。
 */
import { useState, type ReactNode } from 'react'
import { EVOLVE_WAYS, type EvolveProposalView, type EvolveWay } from '../protocol.ts'

/**
 * 服务端那几段「准备怎么做」是给进化日志(Markdown)也用的,里面带 `**先是草稿**` 这种加粗(2026-09-25:
 * 维护者看到卡上原样露着两颗星)。卡上把成对的 `**…**` 画成加粗,落单的星号照原样留着 —— 不猜。
 */
export function renderBold(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /\*\*([^*]+?)\*\*/g
  let last = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    out.push(<strong key={`b${index++}`}>{match[1]}</strong>)
    last = at + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 三条路在按钮上的字。**与服务端 EVOLVE_WAY_TITLES 同一组词**,由用例钉着。 */
const WAY_LABEL: Record<EvolveWay, string> = {
  skill: '一条技能',
  tool: '一个小组件',
  template: '模板里的固定一步',
}

export function EvolveAsk({ proposal, baseUrl, fetchImpl }: {
  proposal: EvolveProposalView
  baseUrl: string
  fetchImpl: typeof fetch
}) {
  const [way, setWay] = useState<EvolveWay>(proposal.suggested_way)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)

  const send = async (path: string, body: Record<string, unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: proposal.id, ...body }),
      })
      const payload = await res.json() as { ok?: boolean, error?: string, note?: string }
      // 真相在服务端:这张卡由下一拍 /state 撤下去,这里不本地乐观删(同 DevToolAsk / LayoutAsk)。
      if (payload.ok !== true) setError(payload.error ?? '没办成')
      else if (payload.note !== undefined) setNote(payload.note)
    }
    catch { setError('工作台服务没应答,什么都没改') }
    finally { setBusy(false) }
  }

  return (
    <section className="ben-wb__evolveask" aria-label="待确认的固化提议">
      <p className="ben-wb__evolveask-head">{renderBold(proposal.ask)}</p>
      <ul className="ben-wb__evolveask-says" aria-label="你说过的那几次">
        {proposal.says.map((say, index) => <li key={`${proposal.id}:${index}`}>{say}</li>)}
      </ul>
      <div className="ben-wb__evolveask-ways" role="radiogroup" aria-label="固化成什么">
        {EVOLVE_WAYS.map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={way === option}
            data-on={way === option}
            disabled={busy}
            onClick={() => setWay(option)}
          >
            {WAY_LABEL[option]}
          </button>
        ))}
      </div>
      <p className="ben-wb__evolveask-plan">{renderBold(proposal.plans[way])}</p>
      {way === 'skill' && (
        <label className="ben-wb__evolveask-name">
          给这条技能起个名字
          <input
            type="text"
            value={name}
            disabled={busy}
            maxLength={24}
            onChange={event => setName(event.target.value)}
          />
        </label>
      )}
      <div className="ben-wb__evolveask-row">
        <button
          type="button"
          disabled={busy || (way === 'skill' && name.trim() === '')}
          onClick={() => { void send('/evolve/accept', { way, ...(way === 'skill' ? { name: name.trim() } : {}) }) }}
        >
          做
        </button>
        <button type="button" disabled={busy} onClick={() => { void send('/evolve/decline', {}) }}>不要</button>
        <button type="button" disabled={busy} onClick={() => { void send('/evolve/later', {}) }}>以后再说</button>
      </div>
      <p className="ben-wb__evolveask-hint">「不要」= 以后不再提这一条;「以后再说」= 这次先放下,下次还会问。</p>
      {note !== undefined && <p className="ben-wb__evolveask-note" role="status">{note}</p>}
      {error !== undefined && <p className="ben-wb__evolveask-err" role="alert">{error}</p>}
    </section>
  )
}

/**
 * 设置里「各家能做什么」(2026-09-25,卡 O「派活的眼睛」;设计第 3 条)。
 *
 * 每家三格:**能聊天 / 能改本机文件 / 能把结果收回来**,每一格是查出来的(命令行登没登、工作台 App 连没连、
 * 窗口有没有被对话框挡住),不是写死的;下面再跟一行**额度**(`GET /agents/quota`,三格之一:有数 / 不限 / 没接上:原因)。
 * 2026-10-22 起设置铺满窗口槽,照评审页画成一张表(客户端 / 聊天 / 本机文件 / 收回结果 / 详情);每格凭什么与怎么修在「详情」里。哪格不行给一键修:
 * - 「登录 Claude」:开一扇窗口跑 Claude 自己的登录,账号密码在它自己的登录页上填,工作台不经手;登好了这一格自己变;
 * - 该他自己去点的那一步(「在 Claude 那扇窗上点『取消』」「把 Claude 的窗口叫出来」)**只写一句话**,
 *   不摆键(2026-09-30 维护者拍板把「叫到台前」那颗键全删了);
 * - 「去授权」「装新版工作台 App」:写清去哪。
 *
 * 下面一节是**每件事的上限**(事务官自己在办的那几件,花到这么多钱或跑了这么久就先停下来问你)。
 * 打开这一节时现查一遍(连窗口一起看:只找输入框、不送字、不抢焦点)。数据:`GET /agents/caps`、`POST /agents/caps/check`、`/butler/budget`。
 */
import { Fragment, useEffect, useState } from 'react'
import type { AgentCapsView, AgentQuotaView, CapCell, CapFixView, ItemBudgetConfig } from '../protocol.ts'
import { CAP_CELLS } from '../protocol.ts'
import { capCellTitle, capMark, clockOf } from './itemControlsModel.ts'
import { SetActions, SetBtn, SetField, SetFields, SetFold, SetMsg, SetSection, SetSource } from './settings/setKit.tsx'

function isCapsPayload(body: unknown): body is AgentCapsView {
  return typeof body === 'object' && body !== null && Array.isArray((body as { agents?: unknown }).agents)
}

function quotasOf(body: unknown): readonly AgentQuotaView[] | undefined {
  const agents = (body as { agents?: unknown } | null)?.agents
  return Array.isArray(agents) ? agents as AgentQuotaView[] : undefined
}

/** 额度那一行的字:三格各一种说法(「不限」「没接上:原因」照原话)。 */
function quotaMark(one: AgentQuotaView): string {
  if (one.state === 'unlimited') return '不限'
  if (one.state === 'unconnected') return '没接上'
  return one.level === 'empty' ? '用完了' : one.level === 'low' ? '快用完' : '有数'
}

export function AgentCapsPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const call = fetchImpl ?? fetch
  const [caps, setCaps] = useState<AgentCapsView | null>(null)
  const [quotas, setQuotas] = useState<readonly AgentQuotaView[]>([])
  const [budget, setBudget] = useState<ItemBudgetConfig | null>(null)
  const [draft, setDraft] = useState<{ cny: string, minutes: string } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 哪一家的「详情」摊开着(评审页能力表最右那一列)。 */
  const [open, setOpen] = useState<string | null>(null)

  async function loadQuotas(): Promise<void> {
    try {
      const res = await call(`${baseUrl}/agents/quota`)
      if (!res.ok) return
      const list = quotasOf(await res.json() as unknown)
      if (list !== undefined) setQuotas(list)
    }
    catch { /* 老服务没有这条路:额度那一行不画 */ }
  }

  async function check(window: boolean): Promise<void> {
    try {
      const res = await call(`${baseUrl}/agents/caps/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ window }) })
      const body = await res.json() as unknown
      if (isCapsPayload(body)) setCaps(body)
    }
    catch { /* 查不成就留着上一份 */ }
    // 连窗口一起查时服务端顺手读了窗口上的额度(Manus 积分、Muse 用量),额度那一行跟着拉一次。
    await loadQuotas()
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await call(`${baseUrl}/agents/caps`)
        if (res.ok) {
          const body = await res.json() as unknown
          if (alive && isCapsPayload(body)) setCaps(body)
        }
        const got = await call(`${baseUrl}/butler/budget`)
        if (got.ok) {
          const body = await got.json() as ItemBudgetConfig
          if (alive && typeof body.cny === 'number') { setBudget(body); setDraft({ cny: String(body.cny), minutes: String(body.minutes) }) }
        }
      }
      catch { /* 没接体检的服务:整节不出现 */ }
      // 打开这一节就现查一遍,但**不翻各家窗口**(2026-09-27,维护者:「点击设置按钮,依次闪过 manus、muse、豆包、
      // Grok bot 四个应用,才显示出设置页面」—— 连窗口一起查会把藏着的那几家一个个放出来读)。翻窗口那一遍留给「重新查一遍」。
      if (alive) await check(false)
    })()
    return () => { alive = false }
    // 依赖只列 baseUrl / fetchImpl,同 RulesPanel。
  }, [baseUrl, fetchImpl])

  // 他点了「登录 X」之后:每几秒拉一次,直到那一格变了(服务端在后台等)。
  useEffect(() => {
    if (caps?.login_wait === undefined) return undefined
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await call(`${baseUrl}/agents/caps`)
          const body = await res.json() as unknown
          if (isCapsPayload(body)) setCaps(body)
        }
        catch { /* 下一拍再拉 */ }
      })()
    }, 4000)
    return () => clearInterval(timer)
  }, [caps?.login_wait?.family, baseUrl, fetchImpl])

  if (caps === null) return null

  async function fix(one: CapFixView): Promise<void> {
    if (one.kind !== 'login_cli') { setMessage(one.hint ?? '照旁边那一句做'); return }
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/agents/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ family: one.family }),
      })
      const said = await res.json().catch(() => ({})) as { note?: string, error?: string }
      setMessage(said.error ?? said.note ?? '好了')
      const again = await call(`${baseUrl}/agents/caps`)
      const body = await again.json() as unknown
      if (isCapsPayload(body)) setCaps(body)
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  async function saveBudget(): Promise<void> {
    if (draft === null) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/butler/budget`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cny: Number(draft.cny), minutes: Number(draft.minutes) }),
      })
      const said = await res.json().catch(() => ({})) as { note?: string, error?: string, cny?: number, minutes?: number }
      if (!res.ok) setMessage(said.error ?? '没存上')
      else {
        setMessage(said.note ?? '存好了')
        if (typeof said.cny === 'number' && typeof said.minutes === 'number') setBudget({ cny: said.cny, minutes: said.minutes })
      }
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  const checkedAt = clockOf(caps.checked_at)
  // 评审页 `section('caps', '各家能做什么', …)`:一张表(客户端 / 聊天 / 本机文件 / 收回结果 / 详情),
  // 行就打勾、不行一道横线;每格凭什么、哪格怎么修、这家的额度都在「详情」里。底下一行小字几点查的。
  // 每件事的上限(钱 / 时间)稿里没有,收进「每件事的上限」折叠。
  return (
    <SetSection id="ben-wb-caps" title="各家能做什么" aside={caps.line}>
      <table className="ben-wb__scaps">
        <thead>
          <tr>
            <th>客户端</th>
            <th>聊天</th>
            <th>本机文件</th>
            <th>收回结果</th>
            <th aria-label="" />
          </tr>
        </thead>
        <tbody>
          {caps.agents.map((agent) => {
            const quota = quotas.find(one => one.id === agent.family)
            const shown = open === agent.family
            return (
              <Fragment key={agent.family}>
                <tr data-family={agent.family} data-installed={agent.installed !== false}>
                  <td>{agent.title}</td>
                  {CAP_CELLS.map((cell: CapCell) => {
                    const one = agent.cells[cell]
                    return (
                      <td key={cell} data-state={one.state} title={`${capCellTitle(cell)}:${capMark(one)}`}>
                        {one.state === 'ok' ? <CapCheck /> : one.state === 'unknown' ? '?' : '—'}
                      </td>
                    )
                  })}
                  <td>
                    <SetBtn aria-expanded={shown} onClick={() => setOpen(shown ? null : agent.family)}>详情</SetBtn>
                  </td>
                </tr>
                {shown && (
                  <tr className="ben-wb__scaps-more" data-stale={quota?.stale === true ? 'true' : undefined}>
                    <td colSpan={5}>
                      <ul role="group" aria-label={`${agent.title} 的详情`}>
                        {CAP_CELLS.map((cell: CapCell) => {
                          const one = agent.cells[cell]
                          return (
                            <li key={cell} data-state={one.state}>
                              {`${capCellTitle(cell)}:${capMark(one)} · ${one.note}`}
                              {one.fix?.hint !== undefined && ` · ${one.fix.hint}`}
                              {one.fix !== undefined && one.fix.kind === 'login_cli' && (
                                <>
                                  {' '}
                                  <SetBtn kind="text" disabled={busy} onClick={() => { void fix(one.fix as CapFixView) }}>{one.fix.label}</SetBtn>
                                </>
                              )}
                            </li>
                          )
                        })}
                        {quota !== undefined && (
                          <li data-quota={quota.state}>
                            {`额度:${quotaMark(quota)} · ${quota.state === 'unlimited' ? `不限 —— ${quota.source ?? '这家不按额度算'}` : quota.line}`}
                            {quota.fix?.hint !== undefined && ` · ${quota.fix.hint}`}
                          </li>
                        )}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      <SetActions>
        <SetSource>
          {caps.checking === true ? '正在查…' : checkedAt === undefined ? '还没查过' : `${checkedAt} 查的 · 以连接检查为准`}
          {caps.login_wait === undefined ? '' : ` · 在等你登录 ${caps.agents.find(one => one.family === caps.login_wait?.family)?.title ?? ''}(登好了这里自己变)`}
        </SetSource>
        <SetBtn kind="outline" disabled={busy || caps.checking === true} onClick={() => { void check(true) }}>重新查一遍</SetBtn>
      </SetActions>

      {budget !== null && draft !== null && (
        <SetFold summary={`每件事的上限 · ${budget.cny} 元 / ${budget.minutes} 分钟`}>
          <p>
            一件事上,事务官那条会话花到这么多钱、或者这件事跑了这么久(先到哪个算哪个),就先停下来问你:
            继续等、停掉这一件,还是换一家。钱按工作台模型服务的价目算;派给别家的活花的是那家自己的额度,那里只管时间。
            另外每件事最多走 15 步(问模型 15 次),这一条写死、不用配。
          </p>
          <SetFields>
            <SetField label="钱(元)">
              <input aria-label="每件事最多花多少元" inputMode="decimal" value={draft.cny} onChange={event => setDraft({ ...draft, cny: event.target.value })} />
            </SetField>
            <SetField label="时间(分钟)">
              <input aria-label="每件事最多跑多少分钟" inputMode="numeric" value={draft.minutes} onChange={event => setDraft({ ...draft, minutes: event.target.value })} />
            </SetField>
          </SetFields>
          <SetActions>
            <SetBtn kind="outline" disabled={busy || (draft.cny === String(budget.cny) && draft.minutes === String(budget.minutes))} onClick={() => { void saveBudget() }}>存这两个数</SetBtn>
          </SetActions>
        </SetFold>
      )}
      {message !== null && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}

/** 评审页那个勾(lucide `check`,12px)。 */
function CapCheck() {
  return (
    <svg className="ben-wb__sico" viewBox="0 0 24 24" role="img" aria-label="行">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

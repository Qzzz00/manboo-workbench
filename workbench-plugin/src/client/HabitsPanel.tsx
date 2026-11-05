/**
 * 设置里「它学到了什么」(2026-10-09,卡「它学到了什么」;docs/设计-事务官从她的行为里学-2026-10-09.md 第三节第 4 条)。
 *
 * 从行为账里学到的做法(`GET /habits`)摊成三段:正在试用 / 已经留下 / 撤掉的,每条写清依据与开始试用的时刻,
 * 试用中与留下的每条一颗「撤掉」(`POST /habits/revoke`),撤掉的每条一颗「恢复」(`POST /habits/restore`,2026-10-10)。手机设置里是同一页(butler-app/src/settings/HabitsSection.tsx)。
 *
 * - **按通用形状显示,不按种类写死**:学风格那一侧会往 `/habits` 里加新种类;种类名用接口给的 `kind_title`,缺了有兜底。
 * - **明说的规矩不在这里重摆一份**:它们在上面「记住的规矩」那一节看和改;这里只读 `GET /butler/rules` 报一句条数,
 *   同一张表不出第二个入口(同 PromptsPanel 对规矩只读、指回去)。
 * - 不露内部的东西:不显示 id、接口路径;进化日志只给摘要,`提议 id` 那几格摘掉。
 */
import { useEffect, useState } from 'react'
import type { ButlerRulesView, HabitsView, HabitView } from '../protocol.ts'
import { SetBtn, SetExplain, SetFold, SetLead, SetMsg, SetRow, SetSection, SetTally } from './settings/setKit.tsx'
import { CONFIRMS, ConfirmDialog } from './ui/index.tsx'

/** 一条都没学到时那一句。 */
export const HABITS_EMPTY_NOTE = '还没有试用的做法。'
/** 撤回前问的那一句(评审页「撤回这个做法?」弹层的正文;弹层是共用的 `ConfirmDialog`)。 */
export const HABIT_WITHDRAW_ASK = '撤回后不再继续试用,保留原来的依据记录。'

/**
 * 「依据与判据」摊开的几句(评审页 `learn-proof`:计数 / 试用 / 验证各自是什么,不相除)。
 * 每条一格的口径:计数 = 这一条依据的记录;试用 = 试用 / 留下之后真用上的次数;验证 = 验过留下记 1、还在试用记 0。
 */
export const HABITS_PROOF_LINES: readonly string[] = [
  '计数:这一条所依据的记录有几次。试用:试用以来真用上了几次。验证:验过、留下记 1,还在试用记 0。三格各自数,不相除、不算通过率。',
  '从你平时怎么派活、几点接电话、点不点头里数出来;同一种情况出现两次以上先试用,下一次同类的事你没纠正就留下,纠正了自动撤;随时能撤回。',
  '花钱、对外说的话、改你的习惯、要你亲手做的,永远先问你。',
]

/** 节名右边那一句状态(原来在组首入口行上,2026-10-22 挪到这里)。 */
export function habitsEntryLine(view: HabitsView): string {
  return `${view.trial.length} 条试用 · ${view.kept.length} 条留下`
}

/** 一条做法的三格:计数 / 试用 / 验证(口径见 `HABITS_PROOF_LINES`)。 */
export function habitTally(habit: HabitView): [number, number, number] {
  return [habit.evidence.length, typeof habit.applied === 'number' ? habit.applied : 0, habit.status === 'kept' ? 1 : 0]
}

/** 接口没给种类名时的兜底。 */
export const HABIT_KIND_FALLBACK = '别的习惯'
export const HABITS_RETIRED_NOTE = '撤掉的不会再自己学回来;撤错了点「恢复」,重新试用。'

/** 形状不对就当没拿到(并行用例里 fetch 会串台)。 */
export function isHabitsPayload(body: unknown): body is HabitsView {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Record<string, unknown>
  return Array.isArray(raw.trial) && Array.isArray(raw.kept) && Array.isArray(raw.retired)
}

export function habitKindTitle(habit: HabitView): string {
  const title = (habit as { kind_title?: unknown }).kind_title
  return typeof title === 'string' && title.trim() !== '' ? title : HABIT_KIND_FALLBACK
}

/** 本机时间 `MM-DD HH:mm`;读不懂的时刻原样截前 16 位。 */
export function habitStamp(at: string): string {
  const time = new Date(at)
  if (Number.isNaN(time.getTime())) return at.slice(0, 16)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`
}

/** 每条底下那一小行:几时开始试用、用上几次、留下 / 撤的理由。 */
export function habitSinceLine(habit: HabitView): string {
  const parts = [`${habitStamp(habit.adopted_at)} 开始试用`]
  const applied = typeof habit.applied === 'number' ? habit.applied : 0
  parts.push(applied > 0 ? `用上 ${applied} 次` : '还没用上')
  const why = habit.verdict === undefined || habit.verdict === '' ? '' : `:${habit.verdict}`
  if (habit.status === 'kept') parts.push(`留下了${why}`)
  else if (habit.status === 'removed') parts.push(`你撤掉的${why}`)
  else if (habit.status === 'reverted') parts.push(`你纠正了,自动撤了${why}`)
  return parts.join(' · ')
}

/** 规矩表那几条按来路数一数(口径与「记住的规矩」同一张表)。 */
export function rulesCountLine(view: ButlerRulesView): string {
  const said = view.rules.filter(one => one.origin === 'said' || one.origin === 'onboarding').length
  const topic = view.rules.filter(one => one.origin === 'topic').length
  const repeated = view.rules.filter(one => one.origin === 'repeated' || one.origin === 'observation').length
  const parts = [`你明说的规矩 ${said} 条`]
  if (topic > 0) parts.push(`选题上学到的偏好 ${topic} 条`)
  if (repeated > 0) parts.push(`从打回里学到的 ${repeated} 条`)
  return `${parts.join(' · ')},在上面「记住的规矩」里看和改。`
}

export interface EvolveLogDigestEntry {
  /** 那一段的标题(日期 + 做成了什么)。 */
  title: string
  /** 底下最新那一句结论(留下 / 撤了 / 她撤掉了 / 已撤);还在试用就缺席。 */
  latest?: string
}

const LOG_VERDICT = /^- \*\*(留下|撤了[^*]*|她撤掉了|她恢复了|已撤)\*\*/u
const LOG_ID = /[((]\s*(?:习惯|提议) id `[^`]*`\s*[))]/gu

/**
 * 进化日志 → 最近几段的摘要,新的在前;`提议 id` 那几格摘掉。
 * 一段底下的结论是**新的在上**(`annotateLog` 插在 id 那一行正下方),所以取第一句。
 */
export function evolveLogDigest(text: string, limit: number): EvolveLogDigestEntry[] {
  const chunks = text.split(/^## /mu).slice(1)
  return chunks.map((chunk) => {
    const lines = chunk.split('\n')
    const title = (lines[0] ?? '').trim()
    const verdict = lines.find(line => LOG_VERDICT.test(line))
    const latest = verdict?.replace(/^- /u, '').replaceAll('**', '').replace(LOG_ID, '').trim()
    return latest === undefined || latest === '' ? { title } : { title, latest }
  }).filter(one => one.title !== '').slice(-limit).reverse()
}

type LogState = { kind: 'closed' } | { kind: 'loading' } | { kind: 'ok', entries: EvolveLogDigestEntry[] } | { kind: 'none', note: string }

export function HabitsPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const [view, setView] = useState<HabitsView | null>(null)
  const [rulesLine, setRulesLine] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [log, setLog] = useState<LogState>({ kind: 'closed' })

  const call = fetchImpl ?? fetch

  async function reload(): Promise<HabitsView | null> {
    try {
      const res = await call(`${baseUrl}/habits`)
      if (!res.ok) return null
      const body = await res.json() as unknown
      return isHabitsPayload(body) ? body : null
    }
    catch { return null }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const next = await reload()
      if (alive && next !== null) setView(next)
      try {
        const res = await call(`${baseUrl}/butler/rules`)
        const body = res.ok ? await res.json() as ButlerRulesView : undefined
        if (alive && body !== undefined && Array.isArray(body.rules)) setRulesLine(rulesCountLine(body))
      }
      catch { /* 规矩表没接上:那一句缺席 */ }
    })()
    return () => { alive = false }
    // 依赖只列 baseUrl / fetchImpl,同 RulesPanel:reload 是每次渲染新建的闭包。
  }, [baseUrl, fetchImpl])

  if (view === null) return null

  async function post(path: '/habits/revoke' | '/habits/restore', id: string): Promise<void> {
    setBusy(true)
    setMessage(null)
    setConfirming(null)
    try {
      const res = await call(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      })
      const said = (await res.json().catch(() => ({}))) as { error?: string, note?: string }
      const fallback = path === '/habits/revoke' ? ['没撤成', '撤掉了。'] : ['没恢复成', '恢复了。']
      setMessage(!res.ok || said.error !== undefined ? (said.error ?? fallback[0] as string) : (said.note ?? fallback[1] as string))
      const next = await reload()
      if (next !== null) setView(next)
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  async function toggleLog(): Promise<void> {
    if (log.kind !== 'closed') { setLog({ kind: 'closed' }); return }
    setLog({ kind: 'loading' })
    try {
      const res = await call(`${baseUrl}/evolve/log`)
      if (res.status === 404) { setLog({ kind: 'none', note: '还没有进化日志:还没有哪一条开始试用过。' }); return }
      const body = res.ok ? await res.json() as { text?: unknown } : {}
      if (typeof body.text !== 'string') { setLog({ kind: 'none', note: '进化日志这会儿读不到。' }); return }
      setLog({ kind: 'ok', entries: evolveLogDigest(body.text, 8) })
    }
    catch { setLog({ kind: 'none', note: '进化日志这会儿读不到。' }) }
  }

  const live = [...view.trial, ...view.kept]
  // 评审页 `section('learn', '它学到了什么', …)`:每条一句 + 撤回,底下计数 / 试用 / 验证三格点阵;
  // 底行「一点一次 · 三类分别计数」+「依据与判据」。依据明细、进化日志、撤掉的那几条收进折叠与「依据与判据」里。
  return (
    <SetSection id="ben-wb-habits" title="它学到了什么" aside={habitsEntryLine(view)}>
      {live.length === 0 && <SetLead>{HABITS_EMPTY_NOTE}</SetLead>}
      {live.map(habit => (
        <div className="ben-wb__slearn" key={habit.id} data-habit-status={habit.status}>
          <div className="ben-wb__slearn-title">
            <p>{habit.text}</p>
            <SetBtn disabled={busy} onClick={() => setConfirming(habit.id)}>撤回</SetBtn>
          </div>
          <SetTally counts={habitTally(habit)} />
          <SetFold summary={`依据 ${habit.evidence.length} 条`}>
            <p>{`${habitKindTitle(habit)} · ${habitSinceLine(habit)}`}</p>
            {habit.evidence.length > 0 && (
              <ul aria-label="依据">
                {habit.evidence.map((one, index) => (
                  <li key={`${one.at}-${index}`}>
                    {one.what}
                    {one.said !== undefined && one.said !== '' && ` —— 你的原话「${one.said}」`}
                  </li>
                ))}
              </ul>
            )}
          </SetFold>
        </div>
      ))}

      <SetExplain label="依据与判据" source="一点一次 · 三类分别计数">
        {HABITS_PROOF_LINES.map(line => <p key={line}>{line}</p>)}
        {rulesLine !== null && <p>{rulesLine}</p>}
        <SetBtn kind="text" onClick={() => { void toggleLog() }}>
          {log.kind === 'closed' ? '看进化日志(最近几条)' : '收起进化日志'}
        </SetBtn>
        {log.kind === 'loading' && <p>在读…</p>}
        {log.kind === 'none' && <p>{log.note}</p>}
        {log.kind === 'ok' && (
          <>
            <ul aria-label="进化日志">
              {log.entries.map((entry, index) => (
                <li key={`${entry.title}-${index}`}>
                  <span>{entry.title}</span>
                  {entry.latest !== undefined && <span>{` · ${entry.latest}`}</span>}
                </li>
              ))}
            </ul>
            <p>全文在你工作目录里的「进化日志.md」。</p>
          </>
        )}
      </SetExplain>

      {view.retired.length > 0 && (
        <SetFold summary={`已撤下 ${view.retired.length} 条`}>
          <p>{HABITS_RETIRED_NOTE}</p>
          {view.retired.map(habit => (
            <SetRow key={habit.id} data-habit-status={habit.status} title={habit.text} sub={habitSinceLine(habit)}>
              <SetBtn disabled={busy} onClick={() => { void post('/habits/restore', habit.id) }}>恢复</SetBtn>
            </SetRow>
          ))}
        </SetFold>
      )}

      {message !== null && <SetMsg>{message}</SetMsg>}
      {confirming !== null && (
        <ConfirmDialog
          {...CONFIRMS.withdrawHabit}
          body={`${HABIT_WITHDRAW_ASK}也不会再自己学回来;撤错了在「已撤下」里恢复。`}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => { void post('/habits/revoke', confirming) }}
        />
      )}
    </SetSection>
  )
}

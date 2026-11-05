/**
 * 一条会话的**最近几轮**(2026-09-25,卡 P;2026-10-04 从 `SessionDigestPanel.tsx` 原样搬出来)。
 *
 * 为什么单独一份文件:「等你确认」那张卡现在也要摆最近几轮(2026-10-04,卡 `claude/ask-with-context`),
 * 而那张卡(`SessionAsk.tsx`)本来就被 `SessionDigestPanel.tsx` 里的 `ExternalSessionDetails` 用着 ——
 * 两份文件互相 import 就成了环。**搬的只是位置**:实现、文案、15 秒再读一次、「读不到就说读不到」
 * 一个字没改;`SessionDigestPanel.tsx` 照旧转出 `SessionDigestPanel`,老调用方一处都不用改。
 *
 * 搬的同时只补了一处(卡 claude/ask-with-context 交接里写明):一轮都没读出来时**照工作台那句
 * `rounds_note` 说**(2026-09-28,卡 WR 的口径;手机那一侧从那天起就是这么写的,电脑这一侧漏了)。
 * 「等你确认」里最常见的正是窗口读出来的那几条 —— 它们压根没有对话记录可读,
 * 照旧那句「还没读出能给你看的几轮」会让她以为是读坏了。`rounds_note` 缺席时那句一个字没变。
 *
 * 最近几轮是**点开时当场读**的(`GET /sessions/digest`),服务端数出来的、原样的,不经模型(C2)。
 * 不露内部的东西(维护者规矩第 3 条):没有会话 id、没有路径、没有工具名。
 */
import { useEffect, useState } from 'react'
import type { SessionDigestView } from '../protocol.ts'
import { agentTitle } from './butlerSceneModel.ts'
import { useMeName } from './meName.tsx'
import { cardTime } from './orb.ts'

/** 开着的时候多久再读一次。 */
const REFRESH_MS = 15_000

/** 在哪个项目:「未归类」说成「没认出是哪个项目」。 */
export function projectLine(project: string | undefined): string | undefined {
  if (project === undefined || project.trim() === '') return undefined
  return project === '未归类' ? '没认出是哪个项目' : `在「${project}」项目里`
}

/**
 * 读不到前面那段对话时说的那一句(2026-10-04,卡 `claude/ask-with-context`)。
 * 离线 / 走中转读不到是常事 —— **如实说一句,问题本身照样答得了**,不拿旧的凑、不编一段上下文。
 * 真正的原因紧跟在这句下面(服务端那句原话)。
 */
export const ASK_CONTEXT_NO_READ = '这会儿取不到前面的对话'

/**
 * 最近几轮。当场读,开着的时候 15 秒再读一次;读不到就说读不到(不拿旧的凑,也不写占位话)。
 *
 * `variant`(2026-10-04,卡 `claude/ask-with-context`):
 * - `panel`(默认,老样子)= 点开那条会话的那一页上的一段,项目那一行由上层画(`ExternalSessionDetails`);
 * - `ask` = 挂在「等你确认」那张卡下面的那一段 —— 多摆一行**在哪个项目**(那张卡上层没有这一行),
 *   读不到时先说 {@link ASK_CONTEXT_NO_READ} 再说原因。读的是同一条路、同一份数据,只是摆法多这两点。
 */
export function SessionDigestPanel({ agent, name: agentName, sessionId, baseUrl, fetchImpl, variant = 'panel' }: {
  /** 哪一家(按字符串,不收窄成固定几家)。 */
  agent: string
  /** 它叫什么(Agent 登记表里的名字;缺席原样用 id)。 */
  name?: string
  sessionId: string
  baseUrl: string
  fetchImpl: typeof fetch
  variant?: 'panel' | 'ask'
}) {
  const [view, setView] = useState<SessionDigestView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = await fetchImpl(`${baseUrl}/sessions/digest?agent=${encodeURIComponent(agent)}&id=${encodeURIComponent(sessionId)}`)
        const body = await res.json().catch(() => ({})) as SessionDigestView & { error?: string }
        if (!alive) return
        if (!res.ok) {
          setError(typeof body.error === 'string' && body.error !== '' ? body.error : '读不到这条会话的记录')
          return
        }
        setView(body)
        setError(undefined)
      }
      catch {
        if (alive) setError('连不上工作台,读不到这条会话')
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, REFRESH_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [agent, sessionId, baseUrl, fetchImpl])

  const name = agentName ?? agentTitle(agent)
  const meName = useMeName()
  /** 「等你确认」那张卡下面那一段多这一行:哪个项目(那张卡上层没有它)。 */
  const project = variant === 'ask' ? projectLine(view?.project) : undefined
  return <section className="ben-wb__session-digest" aria-label="最近几轮">
    <h4>最近几轮</h4>
    {project !== undefined && <small className="ben-wb__session-digest-project">{project}</small>}
    {error !== undefined && view === undefined
      ? variant === 'ask'
        // 如实说一句 + 原因(卡 claude/ask-with-context):问题本身照旧答得了,不编一段上下文。
        ? <><p className="ben-wb__session-digest-empty" role="status">{ASK_CONTEXT_NO_READ}</p><p className="ben-wb__session-digest-empty">{error}</p></>
        : <p className="ben-wb__session-digest-empty" role="status">{error}</p>
      : view === undefined
        ? <p className="ben-wb__session-digest-empty" role="status">正在读这条会话…</p>
        : view.rounds.length === 0
          ? <p className="ben-wb__session-digest-empty">{view.rounds_note ?? '这条会话里还没读出能给你看的几轮。'}</p>
          : <ol>
              {view.rounds.map((round, index) => {
                const clock = cardTime(round.at)
                return <li key={`${round.at ?? ''}-${index}`}>
                  {round.ask !== undefined && <p className="ben-wb__session-digest-ask"><small>{meName}</small>{round.ask}</p>}
                  {round.reply !== undefined && <p className="ben-wb__session-digest-reply"><small>{name}</small>{round.reply}</p>}
                  {(round.did !== undefined || clock !== undefined) && <small className="ben-wb__session-digest-did">{[round.did, clock].filter(Boolean).join(' · ')}</small>}
                </li>
              })}
            </ol>}
  </section>
}

/**
 * 左栏「它学到了什么」(2026-10-21,视觉 A「左栏与学习」)。
 *
 * 三行各自数、一点一条:计数 = 试用中与留下的做法所依据的记录条数;试用 = 正在试用的做法;验证 = 验过留下的做法。
 * 三个数不相除、不算通过率;0 照写、不画点。标题本身是键,开设置里那一节(HabitsPanel,机制解释也在那儿)。
 * 数据同那一节,`GET /habits`;取不到整块缺席(不编数)。
 */
import { useEffect, useState } from 'react'
import type { HabitsView } from '../protocol.ts'
import { isHabitsPayload } from './HabitsPanel.tsx'
import { DotTally } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'

export interface LearnTally { records: number, trial: number, kept: number }

export function learnTally(view: HabitsView): LearnTally {
  const live = [...view.trial, ...view.kept]
  return {
    records: live.reduce((sum, one) => sum + one.evidence.length, 0),
    trial: view.trial.length,
    kept: view.kept.length,
  }
}

const ROWS: readonly { key: keyof LearnTally, label: string }[] = [
  { key: 'records', label: '计数' },
  { key: 'trial', label: '试用' },
  { key: 'kept', label: '验证' },
]

export function LearnRail({ baseUrl, fetchImpl, onOpen }: { baseUrl: string, fetchImpl?: typeof fetch, onOpen: () => void }) {
  const [tally, setTally] = useState<LearnTally | null>(null)

  useEffect(() => {
    let alive = true
    const call = fetchImpl ?? fetch
    void (async () => {
      try {
        const res = await call(`${baseUrl}/habits`)
        if (!res.ok) return
        const body = await res.json() as unknown
        if (alive && isHabitsPayload(body)) setTally(learnTally(body))
      }
      catch { /* 取不到就缺席 */ }
    })()
    return () => { alive = false }
  }, [baseUrl, fetchImpl])

  if (tally === null) return null
  return (
    <section className="ben-wb__learn" aria-label="它学到了什么">
      <button type="button" className="ben-wb__learn-ttl" onClick={onOpen}>它学到了什么<Icon name="chevron-right" /></button>
      <p className="ben-wb__learn-cap">一点一次 · 分别计数</p>
      <ul className="ben-wb__learn-rows">
        {ROWS.map(row => (
          <li key={row.key} className="ben-wb__learn-row">
            <span className="ben-wb__learn-label">{row.label}</span>
            <b className="ben-wb__learn-n">{tally[row.key]}</b>
            <DotTally count={tally[row.key]} label={row.label} max={30} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 日结条(PRD 5.7,不可改清单第 4 条的那根条;2026-09-02 起从写死的占位文案变成真报告)。
 *
 * 摘要一行常驻底部条,点开是居中一张(2026-10-22 照评审页:头 + 三个大数 + 四段)。弹层限高+自滚动。它与槽位里的
 * 原生窗口打架的问题(徽章气泡同款处境:CSS 排不到操作系统窗口前面)2026-09-11 起由
 * useVeilSlot 解决:弹层点开时窗位里的窗让开,收起时回来——不再要求 Ben 先点「事务官」。
 * 报告缺席时是一句老实话占位,不摆空壳(D13)。
 */
import { useEffect, useState } from 'react'
import type { DailyReport } from '../protocol.ts'
import { coverClass, useDialogCover, useVeilSlot, type VeilTarget } from './useVeilSlot.ts'
import { DotTally } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'

/** 底部条上数的三项(2026-10-21 视觉 A):数字 + 一点一件。 */
const TALLY = [['推进', 'progress'], ['没动静', 'missing'], ['点子', 'ideas']] as const

/** `2026-10-20` → `10 月 20 日`(评审页日结条与那张的头都这么写)。 */
function dayText(date: string): string {
  const [, month, day] = date.split('-')
  return month === undefined || day === undefined ? date : `${Number(month)} 月 ${Number(day)} 日`
}

function Section({ title, lines }: { title: string, lines: readonly string[] }) {
  return (
    <div className="ben-wb__daily-sec">
      <div className="ben-wb__daily-sec-t">{title}</div>
      {lines.length === 0
        ? <p className="ben-wb__daily-line">(空)</p>
        : lines.map((line, index) => <p className="ben-wb__daily-line" key={`${index}-${line}`}>{line}</p>)}
    </div>
  )
}

export function DailyBar({ daily, veil }: {
  daily: DailyReport | undefined
  /** 弹层让开窗位(2026-09-11):弹层点开时窗位让开,收起时回来——顶部注释里"v1 接受被原生窗打架"那句到此为止。 */
  veil?: VeilTarget
}) {
  const [open, setOpen] = useState(false)
  useVeilSlot(open && daily !== undefined, veil)
  // 有窗位矩形时遮罩盖在窗位上(2026-09-14:窗让开后那块不露空白),完整日结那一张居中其中;量不到就铺满。
  const cover = useDialogCover(veil, open && daily !== undefined)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  if (daily === undefined) {
    return <span>日结 · 每天早上 9 点生成昨天的</span>
  }
  return (
    <span className="ben-wb__daily">
      {/* 整条一颗键(评审页 `.daily-strip`,10-22 拍板不带「展开完整日结」)。 */}
      <button
        type="button"
        className="ben-wb__daily-toggle"
        aria-label={`日结 ${daily.date} · 推进 ${daily.progress.length} · 没动静 ${daily.missing.length} · 点子 ${daily.ideas.length}`}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="ben-wb__daily-date">日结 <span className="ben-wb__daily-day">{dayText(daily.date)}</span></span>
        {TALLY.map(([label, key]) => (
          <span key={key} className="ben-wb__daily-count">
            <b>{daily[key].length}</b>
            <span>{label}</span>
            <DotTally count={daily[key].length} label={label} max={20} />
          </span>
        ))}
        <span className="ben-wb__daily-cap">一点一件</span>
      </button>
      {open && (
        <div className={coverClass('ben-wb__daily-veil', cover)} style={cover} onClick={() => setOpen(false)}>
          <section className="ben-wb__daily-pop" role="dialog" aria-modal="true" aria-label={`日结 ${daily.date}`} onClick={event => event.stopPropagation()}>
            <header className="ben-wb__daily-head">
              <h2>日结 · {dayText(daily.date)}</h2>
              <button type="button" aria-label="关闭日结" onClick={() => setOpen(false)}><Icon name="x" /></button>
            </header>
            <div className="ben-wb__daily-body">
              <div className="ben-wb__daily-stats">
                {TALLY.map(([label, key]) => (
                  <div key={key}>
                    <strong>{daily[key].length}</strong>
                    <span>{label}</span>
                    <DotTally count={daily[key].length} label={label} max={20} />
                  </div>
                ))}
              </div>
              <Section title="推进了什么" lines={daily.progress} />
              <Section title="什么没发生 / 被绕开" lines={daily.missing} />
              <Section title="新点子" lines={daily.ideas} />
              <Section title="提议" lines={daily.proposals} />
              {/* DeepSeek 峰谷分账(2026-09-09)。素材是余额采样差分按时段记的账;
                  那天没记过就整节不出现——不写 0,也不拿别的数顶上(D13)。
                  两笔之和可能小于总数:有一部分差值分不了时段,如实缺席,不是算错。 */}
              {daily.deepseek_spend !== undefined && (
                <Section
                  title="DeepSeek 峰谷分账"
                  lines={[
                    ...(daily.deepseek_spend.total === undefined ? [] : [`当日合计 ¥${daily.deepseek_spend.total}`]),
                    ...(daily.deepseek_spend.peak === undefined ? [] : [`高峰 ¥${daily.deepseek_spend.peak}`]),
                    ...(daily.deepseek_spend.offpeak === undefined ? [] : [`低谷 ¥${daily.deepseek_spend.offpeak}`]),
                  ]}
                />
              )}
            </div>
          </section>
        </div>
      )}
    </span>
  )
}

/**
 * 协作区共用的小件(2026-10-21,视觉 A「类型、状态与动作」)。
 *
 * - **类型标签只读**:图标 + 文字,不套按钮胶囊;
 * - **状态章可操作**:中性色、边线、下拉箭头,点开七个(走不到的灰;「领了」是已接下、尚未开始,不是领取按钮);
 * - 头像:人圆形、Agent 圆角,里面一个字(没有真头像资料时不冒充照片);
 * - 点列:一点一张便签,实心 = 已验收做完;不画进度条、不算完成率。
 * 图标是自己画的几笔线条(不引图标库)。
 */
import { useEffect, useRef, useState } from 'react'
import type { TaskStatus, WorkType } from '../../protocol.ts'
import { STAMP_TITLES } from '../../protocol.ts'
import { Icon } from '../ui/icons.tsx'
import { useWorkTypes } from './workTypes.tsx'
import type { StampChoice } from './collabModel.ts'
import { stampChoices } from './collabModel.ts'

/** 类型的图标(类型表里挑的那一枚,评审页那套线性图标)。表里没有这一类就不画。 */
export function TypeIcon({ type, size = 14 }: { type: WorkType, size?: number }) {
  const icon = useWorkTypes().find(one => one.id === type)?.icon
  if (icon === undefined) return null
  return <span className="ben-cl__ticon" aria-hidden="true"><Icon name={icon} size={size} /></span>
}

/** 类型标签(只读)。认不出类型就什么都不画(中性灰底由卡片自己给)。 */
export function TypeLabel({ type }: { type: WorkType | undefined }) {
  const title = useWorkTypes().find(one => one.id === type)?.title
  if (type === undefined || title === undefined) return null
  return <span className="ben-cl__tlabel"><TypeIcon type={type} />{title}</span>
}

const STAMP_MARK: Readonly<Record<TaskStatus, string>> = {
  backlog: '○', todo: '●', doing: '●', confirm: '●', done: '✓', blocked: '!', canceled: '–',
}

/** 状态章:点开一排七个;走不到的灰。`onPick` 拿到要走的那几步。 */
export function Stamp({ status, onPick, label }: { status: TaskStatus, onPick?: (choice: StampChoice) => void, label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (event: MouseEvent): void => { if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <span className="ben-cl__stampwrap nodrag" ref={ref}>
      <button
        type="button"
        className="ben-cl__stamp"
        data-status={status}
        aria-label={label ?? `章:${STAMP_TITLES[status]}(点一下改)`}
        aria-expanded={open}
        disabled={onPick === undefined}
        onClick={(event) => { event.stopPropagation(); setOpen(value => !value) }}
      >
        <span className="ben-cl__stamp-mark" aria-hidden="true">{STAMP_MARK[status]}</span>
        {STAMP_TITLES[status]}
        {onPick !== undefined && <span className="ben-cl__stamp-caret" aria-hidden="true">⌄</span>}
      </button>
      {open && onPick !== undefined && (
        <span className="ben-cl__stampmenu" role="group" aria-label="改成哪个章">
          {stampChoices(status).map(choice => (
            <button
              key={choice.status}
              type="button"
              className="ben-cl__stampopt"
              aria-label={choice.stamp}
              data-status={choice.status}
              aria-pressed={choice.current}
              disabled={choice.path === undefined || choice.current}
              onClick={(event) => { event.stopPropagation(); setOpen(false); onPick(choice) }}
            >
              <span aria-hidden="true">{STAMP_MARK[choice.status]}</span>{choice.stamp}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

export function Avatar({ glyph, round, color }: { glyph: string, round: boolean, color?: string | undefined }) {
  return <span className="ben-cl__avatar" data-round={round} aria-hidden="true" style={color === undefined ? undefined : { ['--cl-avatar' as string]: color }}>{glyph}</span>
}

/** 目标上的点列:一点一张便签,实心 = 已验收做完。 */
export function DotList({ total, done }: { total: number, done: number }) {
  if (total === 0) return null
  return (
    <span className="ben-cl__dots" aria-label={`${total} 张便签,做完 ${done} 张`}>
      {Array.from({ length: Math.min(total, 40) }, (_, i) => <span key={i} className="ben-cl__dot-i" data-done={i < done} />)}
      <span className="ben-cl__dots-note">一点一张 · 实心做完</span>
    </span>
  )
}

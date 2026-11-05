/**
 * 设置弹窗各节的骨架件(2026-10-22,新 UI 第二轮 · 设置六组)。
 *
 * 一件对评审页 `设计-全局UI视觉-A-2026-10-21.html`(`slot=settings`)里的一种件:
 * 节 `.setting-section`、行 `.setting-row`、折叠 `.fold`、按钮(无框 / 描边 / 文字 / 图标)、
 * 两列表单 `.fields`、动作行 `.actions`、计数三格 `.tally-grid` + 点列 `.dots`、分段 `.seg`、
 * 开关 `.toggle`、出错 `.field-error`、提醒框 `.warning-inline`。样式在 `settingsMonoStyle.ts`(独占 `ben-wb__s` 前缀)。
 * 稿里没画、我们有的东西一律用这几件收(折叠或次级入口),不另起样子。
 */
import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'

type SectionProps = Omit<HTMLAttributes<HTMLElement>, 'title' | 'id'> & {
  /** 节名的 id(`aria-labelledby` 用)。 */
  id: string
  title: ReactNode
  /** 节名右边那一句小字状态(稿里 `.section-heading .source` 的位置)。 */
  aside?: ReactNode
}

/** 一节:上一根线,节名 13 / 600,右边一句小字状态。 */
export function SetSection({ id, title, aside, className, children, ...rest }: SectionProps) {
  return (
    <section {...rest} className={className === undefined ? 'ben-wb__ss' : `ben-wb__ss ${className}`} aria-labelledby={id}>
      <div className="ben-wb__ss-head">
        <h3 id={id}>{title}</h3>
        {aside !== undefined && aside !== null && aside !== '' && <span className="ben-wb__ss-aside">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

/** 节里的一句说明(11 / 1.8 次字)。 */
export function SetLead({ children }: { children: ReactNode }) {
  return <p className="ben-wb__slead">{children}</p>
}

type RowProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title: ReactNode
  sub?: ReactNode
}

/** 一行:名字 12 / 500 + 副行 10px 弱字,右边是动作(children)。 */
export function SetRow({ title, sub, className, children, ...rest }: RowProps) {
  return (
    <div {...rest} className={className === undefined ? 'ben-wb__srow' : `ben-wb__srow ${className}`}>
      <div className="ben-wb__srow-label">
        <strong>{title}</strong>
        {sub !== undefined && sub !== null && sub !== '' && <small>{sub}</small>}
      </div>
      {children}
    </div>
  )
}

export type SetBtnKind = 'plain' | 'outline' | 'text' | 'icon' | 'primary'

/** 稿里的按钮:缺省无框(悬停 soft 底);`outline` 一圈发丝线;`text` 下划线文字;`icon` 26 见方。 */
export function SetBtn({ kind = 'plain', type, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: SetBtnKind }) {
  return <button {...rest} type={type ?? 'button'} className={className === undefined ? 'ben-wb__sbtn' : `ben-wb__sbtn ${className}`} data-kind={kind} />
}

/** 稿里那颗 ✕(lucide `x`,14px 线性)。 */
export function SetX() {
  return (
    <svg className="ben-wb__sico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

/** 动作行:靠右、间 8、上 14。 */
export function SetActions({ children, className }: { children: ReactNode, className?: string }) {
  return <div className={className === undefined ? 'ben-wb__sacts' : `ben-wb__sacts ${className}`}>{children}</div>
}

/**
 * 折叠:「已撤下 N 条 · 展开 ›」。收着的时候里面不渲染(屏上、读屏里都没有)。
 * `open` 给了就以它为准(从别处带着落点进来时要先摊开)。
 */
export function SetFold({ summary, children, defaultOpen = false, more = '展开 ›', less = '收起', className }: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  more?: string
  less?: string
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details className={className === undefined ? 'ben-wb__sfold' : `ben-wb__sfold ${className}`} open={open}>
      <summary onClick={(event) => { event.preventDefault(); setOpen(!open) }}>
        <span>{summary}</span>
        <span>{open ? less : more}</span>
      </summary>
      {open && <div className="ben-wb__sfold-body">{children}</div>}
    </details>
  )
}

/**
 * 次级入口:一颗文字按钮,点开在下面摊出说明(稿里「依据与判据」「来源与口径」那一种)。
 * `source` 是同一行左边那句小字。机制解释、代价说明这类长话都收在这里,不常驻。
 */
export function SetExplain({ label, source, children }: { label: string, source?: ReactNode, children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <SetActions>
        {source !== undefined && <SetSource>{source}</SetSource>}
        <SetBtn kind="text" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</SetBtn>
      </SetActions>
      {open && <div className="ben-wb__sexplain">{children}</div>}
    </>
  )
}

/** 两列表单(窄了一列)。 */
export function SetFields({ children }: { children: ReactNode }) {
  return <div className="ben-wb__sfields">{children}</div>
}

/** 表单里的一格:上面 11px 次字的名字,下面输入。`full` 占满两列。 */
export function SetField({ label, full = false, children }: { label: ReactNode, full?: boolean, children: ReactNode }) {
  return (
    <label className="ben-wb__sfield" data-full={full ? 'true' : undefined}>
      <span>{label}</span>
      {children}
    </label>
  )
}

/** 动作之后的回话(服务端原话)。 */
export function SetMsg({ children, role = 'status' }: { children: ReactNode, role?: 'status' | 'alert' }) {
  return <p className="ben-wb__smsg" role={role}>{children}</p>
}

/** 出错 / 要她先处理的一句(稿 `.field-error`:左边一道主字色、soft 底)。 */
export function SetErr({ children }: { children: ReactNode }) {
  return <p className="ben-wb__serr" role="alert">{children}</p>
}

/** 提醒框(稿 `.warning-inline`:一圈弱字色细框)。 */
export function SetWarn({ children, role }: { children: ReactNode, role?: 'status' | 'alert' | 'note' }) {
  return <div className="ben-wb__swarn" role={role}>{children}</div>
}

/** 来源与口径那种小字(10px 弱字、字距 .4)。 */
export function SetSource({ children }: { children: ReactNode }) {
  return <span className="ben-wb__ssrc">{children}</span>
}

/** 点列:一点一件,超过 `max` 画满、余数写 +n;0 不画点。 */
export function SetDots({ n, max = 48 }: { n: number, max?: number }) {
  const shown = Math.max(0, Math.min(n, max))
  return (
    <span className="ben-wb__sdots" aria-hidden="true">
      {Array.from({ length: shown }, (_, at) => <i key={at} />)}
      {n > max && <span>+{n - max}</span>}
    </span>
  )
}

export const TALLY_LABELS = ['计数', '试用', '验证'] as const

/** 计数 / 试用 / 验证三格,各自数、不相除;每格一个大数 + 点列。 */
export function SetTally({ counts }: { counts: readonly [number, number, number] }) {
  return (
    <div className="ben-wb__stally">
      {counts.map((value, at) => (
        <div key={TALLY_LABELS[at]} role="group" aria-label={`${TALLY_LABELS[at]} ${value}`}>
          <span className="ben-wb__stally-label">{TALLY_LABELS[at]} <strong>{value}</strong></span>
          <SetDots n={value} />
        </div>
      ))}
    </div>
  )
}

/** 分段选择(稿 `.seg`):选中那颗 soft 底、主字色。 */
export function SetSeg<T extends string>({ label, options, value, onPick, disabled }: {
  label: string
  options: readonly { value: T, label: string }[]
  value: T
  onPick: (next: T) => void
  disabled?: boolean
}) {
  return (
    <div className="ben-wb__sseg" role="group" aria-label={label}>
      {options.map(one => (
        <button key={one.value} type="button" aria-pressed={one.value === value} disabled={disabled} onClick={() => onPick(one.value)}>
          {one.label}
        </button>
      ))}
    </div>
  )
}

/**
 * 视觉 A 的常用组件(2026-10-21):各格与设置共用这一套,样式在 `uiStyle.ts`(独占 `wb-ui` 前缀,只读 `tokens.ts`)。
 * 黑白灰、卡片无描边、发丝线分隔、计数用点列代替进度条。
 */
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { coverClass, useDialogCover, useVeilSlot, type VeilTarget } from '../useVeilSlot.ts'
import { Icon } from './icons.tsx'

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'ghost'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}

/** 主按钮实心(主文字色底、反色字);次级是字段底;text 是带下划线的文字入口;ghost 只有悬停底。 */
export function Button({ variant = 'secondary', size = 'md', className, type, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type ?? 'button'}
      className={className === undefined ? 'wb-ui-btn' : `wb-ui-btn ${className}`}
      data-variant={variant}
      data-size={size}
    />
  )
}

interface FieldBase {
  label: string
  /** 标签只给读屏,不占版面(行内输入框用)。 */
  hideLabel?: boolean | undefined
  placeholder?: string | undefined
  disabled?: boolean | undefined
}

function FieldLabel({ id, label, hideLabel, children }: { id: string, label: string, hideLabel?: boolean | undefined, children: ReactNode }) {
  return (
    <label className="wb-ui-label" htmlFor={id}>
      <span className={hideLabel === true ? 'wb-ui-sr' : 'wb-ui-label-text'}>{label}</span>
      {children}
    </label>
  )
}

export function TextField({ label, hideLabel, value, onChange, placeholder, disabled, type = 'text' }: FieldBase & { value: string, onChange: (next: string) => void, type?: 'text' | 'number' | 'search' | 'password' }) {
  const id = useId()
  return (
    <FieldLabel id={id} label={label} hideLabel={hideLabel}>
      <input id={id} className="wb-ui-field" type={type} value={value} placeholder={placeholder} disabled={disabled} onChange={event => onChange(event.target.value)} />
    </FieldLabel>
  )
}

export function TextArea({ label, hideLabel, value, onChange, placeholder, disabled, rows = 3 }: FieldBase & { value: string, onChange: (next: string) => void, rows?: number }) {
  const id = useId()
  return (
    <FieldLabel id={id} label={label} hideLabel={hideLabel}>
      <textarea id={id} className="wb-ui-field wb-ui-field--area" rows={rows} value={value} placeholder={placeholder} disabled={disabled} onChange={event => onChange(event.target.value)} />
    </FieldLabel>
  )
}

export interface SelectOption { value: string, label: string }

export function Select({ label, hideLabel, value, options, onChange, disabled }: FieldBase & { value: string, options: readonly SelectOption[], onChange: (next: string) => void }) {
  const id = useId()
  return (
    <FieldLabel id={id} label={label} hideLabel={hideLabel}>
      <select id={id} className="wb-ui-field wb-ui-select" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {options.map(one => <option key={one.value} value={one.value}>{one.label}</option>)}
      </select>
    </FieldLabel>
  )
}

export function Toggle({ label, checked, onChange, disabled }: { label: string, checked: boolean, onChange: (next: boolean) => void, disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="wb-ui-toggle" onClick={() => onChange(!checked)}>
      <span className="wb-ui-toggle-knob" aria-hidden />
    </button>
  )
}

/** 只读标签:纯文字,不套按钮胶囊;`boxed` 才有一圈发丝线(状态章)。 */
export function Tag({ children, boxed = false }: { children: ReactNode, boxed?: boolean }) {
  return <span className="wb-ui-tag" data-boxed={boxed}>{children}</span>
}

export function Card({ title, aside, children, className }: { title?: ReactNode, aside?: ReactNode, children: ReactNode, className?: string }) {
  return (
    <section className={className === undefined ? 'wb-ui-card' : `wb-ui-card ${className}`}>
      {(title !== undefined || aside !== undefined) && (
        <header className="wb-ui-card-head">
          {title !== undefined && <h3 className="wb-ui-card-title">{title}</h3>}
          {aside !== undefined && <div className="wb-ui-card-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/** 列表行:标题 + 状态副行,右边动作与箭头;行与行之间一条发丝线。给了 onClick 整行就是一颗按钮。 */
export function Row({ title, sub, action, onClick, chevron }: { title: ReactNode, sub?: ReactNode, action?: ReactNode, onClick?: () => void, chevron?: boolean }) {
  const body = (
    <>
      <span className="wb-ui-row-main">
        <span className="wb-ui-row-title">{title}</span>
        {sub !== undefined && <span className="wb-ui-row-sub">{sub}</span>}
      </span>
      {action !== undefined && <span className="wb-ui-row-action">{action}</span>}
      {(chevron ?? onClick !== undefined) && <span className="wb-ui-row-chevron" aria-hidden>›</span>}
    </>
  )
  return onClick === undefined
    ? <div className="wb-ui-row">{body}</div>
    : <button type="button" className="wb-ui-row" onClick={onClick}>{body}</button>
}

/** 弹层:纸面更亮一档、发丝线、圆角 14;Esc 关。定位交给调用方(外层 position:relative)。 */
export function Popover({ open, label, onClose, children, align = 'start' }: { open: boolean, label: string, onClose: () => void, children: ReactNode, align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (open) ref.current?.focus() }, [open])
  if (!open) return null
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className="wb-ui-pop"
      data-align={align}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
    >
      {children}
    </div>
  )
}

/**
 * 居中弹层(评审页 0cf75042 \`.overlay\` / \`.modal\`):头一行标题 + ✕,身可滚,脚放动作;✕ / Esc / 点遮罩关。
 * 给了 \`veil\`:打开时窗位里的原生窗让开,遮罩只盖窗位那块、弹层居中其中(窗让开后不露空白);量不到就铺满。
 */
export function Dialog({ title, onClose, veil, actions, children }: {
  title: string
  onClose: () => void
  veil?: VeilTarget
  actions?: ReactNode
  children: ReactNode
}) {
  useVeilSlot(true, veil)
  const cover = useDialogCover(veil)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className={coverClass('wb-ui-veil', cover)} style={cover} onClick={onClose}>
      <section className="wb-ui-modal" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <header className="wb-ui-modal-head">
          <h2>{title}</h2>
          <button type="button" aria-label="关闭" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="wb-ui-modal-body">{children}</div>
        {actions !== undefined && <footer className="wb-ui-modal-actions">{actions}</footer>}
      </section>
    </div>
  )
}

/**
 * 确认一下再做(10-22 统筹定 28,评审页 0cf75042 那 8 处确认统一的样子):居中弹层,标题一问、一句后果,
 * 脚上「取消」+ 一颗线框键(次按钮)。✕ / Esc / 点遮罩 = 取消。
 */
export function ConfirmDialog({ title, body, confirm, onConfirm, onCancel, veil, busy = false }: {
  title: string
  body: ReactNode
  /** 那颗确认键上写什么(「卸掉」「撤回做法」……)。 */
  confirm: string
  onConfirm: () => void
  onCancel: () => void
  veil?: VeilTarget
  /** 正在办:确认键置灰,不重复点。 */
  busy?: boolean
}) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      {...(veil === undefined ? {} : { veil })}
      actions={(
        <>
          <Button variant="ghost" onClick={onCancel}>取消</Button>
          <Button variant="secondary" disabled={busy} onClick={onConfirm}>{confirm}</Button>
        </>
      )}
    >
      <p className="wb-ui-confirm-line">{body}</p>
    </Dialog>
  )
}

/**
 * 那 8 处确认的标题与确认键(标题照评审页;后果那一句按各处真实做了什么写,由调用处给)。
 * 顶栏「恢复布局」在本体这里接;设置里那七处由设置卡接(它们在设置面板的文件里)。
 */
export const CONFIRMS = {
  stopService: { title: '停止形象与音色服务?', confirm: '确认停止' },
  clearDemo: { title: '清理演示数据?', confirm: '清理演示' },
  revokeDevice: { title: '撤销设备连接?', confirm: '撤销连接' },
  logout: { title: '退出登录?', confirm: '退出' },
  switchLayout: { title: '切换布局?', confirm: '切换' },
  removeConnector: { title: '卸掉连接器?', confirm: '卸掉' },
  restoreLayout: { title: '恢复默认布局?', confirm: '恢复', body: '只把这一方向(横屏或竖屏)的排布换回默认,另一方向那一份不动。' },
  withdrawHabit: { title: '撤回这个做法?', confirm: '撤回做法' },
} as const

/** 空态:一句结论、一句引导、最多一个操作。 */
export function Empty({ title, hint, action, onAction }: { title: string, hint?: string, action?: string, onAction?: () => void }) {
  return (
    <div className="wb-ui-empty">
      <p className="wb-ui-empty-title">{title}</p>
      {hint !== undefined && <p className="wb-ui-empty-hint">{hint}</p>}
      {action !== undefined && onAction !== undefined && <Button size="sm" onClick={onAction}>{action}</Button>}
    </div>
  )
}

/** 计数点列:一点一件,0 不画点(数字照写),超过上限画满上限、余数写 +n。 */
export function DotTally({ count, label, max = 40, tone }: { count: number, label: string, max?: number, tone?: 'dim' }) {
  const shown = Math.max(0, Math.min(count, max))
  const rest = count - shown
  return (
    <span className="wb-ui-tally" role="img" aria-label={`${label} ${count}`} data-tone={tone}>
      {Array.from({ length: shown }, (_, at) => <i key={at} className="wb-ui-dot" />)}
      {rest > 0 && <span className="wb-ui-tally-rest">+{rest}</span>}
    </span>
  )
}

/** 刻度条每格填多少:一格 5%(缺省 20 格),最后一格按比例;越界夹住。 */
export function rungFills(percent: number, cells = 20): number[] {
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const step = 100 / cells
  return Array.from({ length: cells }, (_, at) => Math.max(0, Math.min(1, (value - at * step) / step)))
}

export function Rungs({ percent, label, cells = 20 }: { percent: number, label: string, cells?: number }) {
  return (
    <span className="wb-ui-rungs" role="img" aria-label={`${label} ${Math.round(percent)}%`}>
      {rungFills(percent, cells).map((fill, at) => (
        <i key={at} className="wb-ui-rung" style={{ ['--fill' as string]: fill }} />
      ))}
    </span>
  )
}

/**
 * 构成刻度每格归哪一份(下标):按占比分 `cells` 格,最大余数补齐;有量的份至少一格;全是 0 返回空。
 */
export function stackRungs(values: readonly number[], cells = 40): number[] {
  const total = values.reduce((sum, one) => sum + Math.max(0, one), 0)
  if (total <= 0) return []
  const exact = values.map(one => (Math.max(0, one) / total) * cells)
  const counts = exact.map((one, at) => (values[at]! > 0 ? Math.max(1, Math.floor(one)) : 0))
  let left = cells - counts.reduce((sum, one) => sum + one, 0)
  const order = exact.map((one, at) => ({ at, rest: one - Math.floor(one) })).sort((a, b) => b.rest - a.rest)
  for (let i = 0; left > 0; i = (i + 1) % order.length) {
    const at = order[i]!.at
    if (values[at]! > 0) { counts[at]! += 1; left -= 1 }
  }
  while (left < 0) {
    const at = counts.indexOf(Math.max(...counts))
    counts[at]! -= 1
    left += 1
  }
  return counts.flatMap((count, at) => Array.from({ length: count }, () => at))
}

/** 构成刻度:一排细竖格,明度依次对应各份;图例在 aria 里,界面图例由调用方写。 */
export function StackRungs({ label, parts, cells = 40 }: { label: string, parts: readonly { label: string, value: number }[], cells?: number }) {
  const total = parts.reduce((sum, one) => sum + Math.max(0, one.value), 0)
  const said = parts.filter(one => one.value > 0).map(one => `${one.label} ${Math.round((one.value / total) * 100)}%`).join(' · ')
  return (
    <span className="wb-ui-srungs" role="img" aria-label={`${label} ${said}`}>
      {stackRungs(parts.map(one => one.value), cells).map((part, at) => <i key={at} className="wb-ui-srung" data-part={Math.min(part, 2)} />)}
    </span>
  )
}

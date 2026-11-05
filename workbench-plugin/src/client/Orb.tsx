/**
 * 声纹球(2026-09-11)。**纯 CSS**:没有图片、没有 Live2D(Live2D 留给手机与展示台,
 * 设计 §5.1)。形态全由 data-state / data-amber 驱动,动效在 style.ts 里;
 * `prefers-reduced-motion` 时全部静止(同在 style.ts)。
 *
 * 给了 onClick 就是一颗按钮(纯净模式点一下展开事务官档),否则是一个 role=img——
 * 不给点的东西不画成按钮(D13 的老规矩)。
 */
import { ORB_STATE_TITLES, type OrbState } from './orb.ts'

export function Orb({ state, amber, size = 'normal', onClick }: {
  state: OrbState
  /** 有「需要你」的事:转琥珀色。跟 state 分开传——聆听时球也得是琥珀的,那是纯净模式里唯一的提示。 */
  amber: boolean
  size?: 'normal' | 'large'
  onClick?: () => void
}) {
  const label = `事务官:${ORB_STATE_TITLES[state]}`
  const inner = (
    <>
      <span className="ben-wb__orb-ring" aria-hidden="true" />
      <span className="ben-wb__orb-core" aria-hidden="true" />
    </>
  )
  if (onClick !== undefined) {
    return (
      <button
        type="button"
        className="ben-wb__orb"
        data-state={state}
        data-amber={amber}
        data-size={size}
        aria-label={`${label}(点一下展开)`}
        onClick={onClick}
      >
        {inner}
      </button>
    )
  }
  return (
    <div className="ben-wb__orb" role="img" data-state={state} data-amber={amber} data-size={size} aria-label={label}>
      {inner}
    </div>
  )
}

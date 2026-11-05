/**
 * 每个区域单独解锁 —— 画面那一半(解锁卡 + 顶上那一小行进度)。
 *
 * 两个组件都**只认已经算好的数据**(areaUnlock.ts 的纯函数),自己不判断三态、不发请求。
 * 类名一律 `ben-wb__unlock*`:这一块要跟 `ben-wb__setup*`(初始化页)、`ben-wb__setdlg`
 * (齿轮弹窗)分得清清楚楚 —— 历史上 `ben-wb__card` 撞过名。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ClientKey, QuotaStaleFix } from '../protocol.ts'
import type { UnlockAction, UnlockProgress, UnlockTarget } from './areaUnlock.ts'

export interface UnlockHandler {
  /**
   * 把他送到设置弹窗 / 初始化页,或者就地切到中转。哪一个由 areaUnlock.ts 那张表决定。
   * `client` 是**可选**的(2026-09-21):DeepSeek 那一格不属于那五家桌面客户端。
   *
   * `at` 是**设置里哪一节、哪一行**(2026-10-02,卡 QK):「读不到最新」那一格上那颗入口键
   * 带着服务端声明的去处(`stale_hint.live.fix.at`),设置弹窗据此开在那一组、点亮那一行。
   * 缺席 = 照老样子开在默认那一组(解锁卡那几颗键一个字节没变)。
   */
  (target: UnlockTarget, client?: ClientKey, at?: QuotaStaleFix['at']): void
}

/**
 * 还没接上的那一格。
 *
 * 写法上刻意跟接上了的那一格(QuotaBlock)**一样大、同一排**:它不是一个报错框,
 * 是"这一格还能再解锁一次"。所以没有红色、没有感叹号,只有一句怎么做和一到两颗按钮。
 *
 * 2026-09-21:按钮照 `actions` 画(DeepSeek 那一格有两颗)。这个组件**不再自己查表**
 * —— 有几颗、各自去哪儿、哪颗是推荐的,全在 areaUnlock.ts 里算好。
 */
export function UnlockCard({ name, how, actions, onUnlock }: {
  name: string
  how: string
  actions: readonly UnlockAction[]
  onUnlock?: UnlockHandler
}) {
  return (
    <div className="ben-wb__unlock-card" role="listitem" aria-label={`${name} 还没接上`}>
      <div className="ben-wb__unlock-head">
        <span className="ben-wb__unlock-name">{name}</span>
        <span className="ben-wb__unlock-tag">还没接上</span>
      </div>
      <p className="ben-wb__unlock-how">{how}</p>
      {onUnlock !== undefined && actions.map(action => (
        <button
          key={action.target}
          type="button"
          className="ben-wb__unlock-btn"
          // 推荐的那一颗视觉上重一点。**只是重一点** —— 另一条路不许看起来像被劝退的。
          data-primary={action.primary === true ? 'yes' : undefined}
          onClick={() => onUnlock(action.target, action.client)}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}

/**
 * 关掉之后记在这台机器的浏览器里。**记的是当时那一句话本身**,不是一个 true ——
 * 于是「又装上了一家」「终于接上了一家」这种他没见过的新消息会自己回来一次,
 * 而同一句话不会在每次刷新后再烦他一遍。换机 / 清缓存会再出现一次:这是提示,不是设置。
 */
const DISMISS_KEY = 'ben-wb__unlockHintDismissed'

function readDismissed(): string | undefined {
  // localStorage 在壳里、无痕窗口里、以及某些截图环境里会直接抛。抛了就当"没关过"。
  try { return window.localStorage.getItem(DISMISS_KEY) ?? undefined }
  catch { return undefined }
}

/**
 * 额度面板顶上那一小行(第 5 条):「已接上 2 家:DeepSeek、Kimi;Claude、Codex 装了还没接:…」。
 * 只说有额度的那几家(2026-09-25:微信、企业微信永远不在这句话里)。
 *
 * **不弹窗、不拦路、能关掉。** 它回答的是一个新用户一定会问的问题 ——
 * "为什么这里只有这几家?" —— 而不是催他去做什么。
 */
export function UnlockHint({ progress, onApplyAll }: {
  progress: UnlockProgress | undefined
  /**
   * 「全部接上」(2026-09-25)。给了、而且能一次接上的有两家以上才画那颗按钮 ——
   * 只剩一家时卡片上那颗「点一下,工作台帮你接上」就是同一件事,不画第二颗。
   */
  onApplyAll?: () => void
}) {
  const [dismissedLine, setDismissedLine] = useState<string | undefined>(() => readDismissed())
  const line = progress?.line
  const dismiss = useCallback(() => {
    if (line === undefined) return
    setDismissedLine(line)
    try { window.localStorage.setItem(DISMISS_KEY, line) }
    catch { /* 存不下就只关这一次,不影响别的 */ }
  }, [line])
  // 别的标签页 / 另一扇窗里关过 → 这边也跟着收起来,不用等刷新。
  useEffect(() => {
    const onStorage = (): void => setDismissedLine(readDismissed())
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  if (progress === undefined || line === dismissedLine) return null
  return (
    <div className="ben-wb__unlock-hint" role="status">
      <span className="ben-wb__unlock-hinttext">{progress.line}</span>
      {onApplyAll !== undefined && progress.applyAll.length >= 2 && (
        <button type="button" className="ben-wb__unlock-btn ben-wb__unlock-all" onClick={onApplyAll}>全部接上</button>
      )}
      <button type="button" className="ben-wb__unlock-hintx" aria-label="不再提示" onClick={dismiss}>×</button>
    </div>
  )
}

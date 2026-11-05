/**
 * 首次流程对话屏:「她在找你的项目」那一整段,球一直是执行中(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)。
 *
 * 维护者原话:「扫描的时候,粒子球应该变成工作的状态……」。拍板:**粒子球就是 loading** ——
 * 从她开始找项目、读仓库那一刻,到她开口说结果为止,球一直是执行中;她一开口就回到说话的样子。
 *
 * 以前这里是「最短显示 0.6 秒 + 事后补显示」:按名字找只要几十毫秒、落在两次轮询之间,界面多半事后才看到,
 * 球只闪一下,那时她已经在说结果了(补显示反而压在她说话的那一刻上)。现在:
 *   - 服务端开了窗(`turns.scan` 的 `scanning:true`,server/onboardingActivity.ts):**从动手找一直开到回合表里她的下一句**;
 *   - 这里看到窗开着就进执行中;**她的新一句出现**就收(电脑上她「开口」就是字幕换句那一刻);
 *     服务端这一段收了而且她那一轮也收场了就收;保险时限 {@link REPLY_WINDOW_MAX_MS} 到了也收;
 *   - 收了的那一段服务端还报着也不重开;老服务端(活儿做完就 scanning:false)照样撑到她开口。
 *
 * 纯函数(nextReplyWindow)+ 一个小 hook(useReplyWindow)。手机那份在 butler-app/src/onboarding/scanHold.ts
 * (那边多一格「朗读开口」的宽限),口径与文案逐条一致(两端不互相 import)。
 */
import { useEffect, useRef, useState } from 'react'
import type { ScanProgress } from './onboardingStage.ts'

/** 窗口开着、服务端多久没再说「还开着」就收(保险)。服务端自己撑 30 秒(ACTIVITY_HOLD_MAX_MS),这里略长一点。 */
export const REPLY_WINDOW_MAX_MS = 40_000

export interface ReplyWindow {
  open: boolean
  /** 服务端那一段的号(认得的话)。 */
  id?: number
  since?: number
  /** 最后一次看到服务端说「还开着」的时刻(保险时限从这儿算)。 */
  seen?: number
  /** 开窗那一刻她最后一句的记号;变了 = 她说了新的一句。 */
  herMark?: string
  /** 那一行显示的那一份。 */
  shown?: ScanProgress
  /** 收掉的那一段的号:服务端还报着它也不重开。 */
  closedId?: number
}

export const EMPTY_REPLY_WINDOW: ReplyWindow = { open: false }

export interface ReplySignals {
  /** 最近一次回合回包里的 scan(原样)。 */
  scan: ScanProgress | undefined
  /** 她最后一句的记号(最后一条事务官回合的 seq);没有就 undefined。 */
  her: string | undefined
  /** 她那一轮还在跑(回合回包的 busy)。 */
  busy: boolean
  now: number
}

/**
 * 服务端那一段收了之后,那一行该说什么:最后读的是谁就说读谁,全量扫完就说看了几个。
 * 老服务端(活儿一做完就 scanning:false)靠它把那一行留在「最后那一段」上。
 */
export function settledScanOf(scan: ScanProgress): ScanProgress | undefined {
  if (scan.lastRead !== undefined) return { scanning: true, phase: 'read', current: scan.lastRead }
  if (scan.total !== undefined) return { scanning: true, phase: 'repos', total: scan.total, ...(scan.done === undefined ? {} : { done: scan.done }) }
  return undefined
}

function closeReply(win: ReplyWindow): ReplyWindow {
  const closedId = win.id ?? win.closedId
  return { open: false, ...(closedId === undefined ? {} : { closedId }) }
}

/** 收一拍信号,回新的窗口。纯函数;同样的信号重复进来结果不变。 */
export function nextReplyWindow(prev: ReplyWindow, s: ReplySignals): ReplyWindow {
  const scan = s.scan
  if (!prev.open) {
    if (scan?.scanning !== true) return prev
    if (scan.id !== undefined && scan.id === prev.closedId) return prev
    return {
      open: true,
      since: s.now,
      seen: s.now,
      shown: scan,
      ...(scan.id === undefined ? {} : { id: scan.id }),
      ...(s.her === undefined ? {} : { herMark: s.her }),
      ...(prev.closedId === undefined ? {} : { closedId: prev.closedId }),
    }
  }
  let next: ReplyWindow = prev
  if (scan?.scanning === true) {
    const renewed = scan.id !== undefined && prev.id !== undefined && scan.id !== prev.id
    const { herMark: _dropMark, ...rest } = prev
    // 服务端换了一段(她说完一句又去找):接着开着,「她的下一句」从这一段开始算。
    next = renewed
      ? { ...rest, ...(scan.id === undefined ? {} : { id: scan.id }), seen: s.now, shown: scan, ...(s.her === undefined ? {} : { herMark: s.her }) }
      : { ...prev, seen: s.now, shown: scan, ...(prev.id === undefined && scan.id !== undefined ? { id: scan.id } : {}) }
  }
  else if (scan !== undefined) {
    // 服务端这一段收了(老服务端活儿一做完就收):那一行留在最后那一段上。
    const settled = settledScanOf(scan)
    if (settled !== undefined && next.shown?.phase !== settled.phase) next = { ...next, shown: settled }
  }
  // 她说了新的一句:她开口了,回去(电脑上她那句字幕一换,球当场做说话动作)。
  if (s.her !== next.herMark) return closeReply(next)
  // 服务端这一段收了、她那一轮也收场了:不会再有下文。
  if (scan !== undefined && scan.scanning === false && !s.busy) return closeReply(next)
  // 保险:服务端好久没说「还开着」。
  if (s.now - (next.seen ?? next.since ?? s.now) >= REPLY_WINDOW_MAX_MS) return closeReply(next)
  return next
}

/**
 * hook:每次渲染把手上的信号交进来,回此刻的窗口。保险时限到点自己重画一次。`now` 可注入(测试用假时钟)。
 */
export function useReplyWindow(signals: Omit<ReplySignals, 'now'>, now: () => number = Date.now): ReplyWindow {
  const ref = useRef<ReplyWindow>(EMPTY_REPLY_WINDOW)
  const t = now()
  ref.current = nextReplyWindow(ref.current, { ...signals, now: t })
  const win = ref.current
  const deadline = win.open ? (win.seen ?? win.since ?? t) + REPLY_WINDOW_MAX_MS : undefined
  const [, setTick] = useState(0)
  useEffect(() => {
    if (deadline === undefined) return
    const timer = setTimeout(() => setTick(n => n + 1), Math.max(0, deadline - now()) + 16)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认到点的那一刻
  }, [deadline])
  return win
}

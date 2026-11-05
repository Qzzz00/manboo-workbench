/**
 * ★ **每一家一条通道**(2026-10-21,卡「派活按家隔离」;全景地图「最脆处 · 一 堵塞与连坐」)。
 *
 * 展会两天的主要失败形状:上一件堵住,后面全完。机制是三处「一条」:派活巡检一圈里逐张卡顺序等壳读窗、
 * 捎话巡检同样逐条等、壳所有读窗一条串行队列 —— 一家读不动,所有别家的卡都没人盯;
 * 清通道只能重启插件。所以这里把「动某一家的窗」这件事收成**按家分开的通道**:
 *
 * - **同一家排队,不同家互不等**:同一家同一时刻只有一下在动它的窗(送话与读窗不会在同一扇窗上抢跑);
 * - **每一下有硬上限**:读窗 {@link LANE_READ_CAP_MS}、送话 {@link LANE_RUN_CAP_MS}。超了判「通道堵了」,
 *   **放开通道**(那一下作废,后面的照走),回一句人话(哪家、哪一步、等了多久);
 * - **堵着的那一家读窗先跳过**:一下都不发(不往壳那条队里再堆),隔 {@link LANE_PROBE_EVERY_MS} 才探一次,
 *   同一步做成了一下就清掉堵的记录;
 * - **「重置这一家」**:排着的撤掉、在跑的那一下作废(它回来了也不认)、堵的记录清掉 —— 不重启插件。
 *
 * 只管**窗口那一条通道**(引擎在 `via === 'window'` 时才走它):协议 / 命令行 / 接口各有各的连接与进程,
 * 本来就不排在一扇窗后面。
 */

/** 读一眼回话的硬上限。窗口适配器读窗那一下是 15 秒(豆包再补一下 `agent_read`,最坏 30 秒),这里取中。 */
export const LANE_READ_CAP_MS = 20_000
/**
 * 送一句话进窗口的硬上限。正常一下几秒到十几秒;最坏(每个壳 op 都到各自的超时)约两分半,
 * 那已经不是「慢」而是那扇窗不应声了。
 */
export const LANE_RUN_CAP_MS = 150_000
/** 堵着的那一家,多久探一次。 */
export const LANE_PROBE_EVERY_MS = 15_000

export type LaneStep = 'read' | 'send'

/** 卡上说「哪一步」用的人话。 */
export const LANE_STEP_TEXT: Readonly<Record<LaneStep, string>> = {
  read: '读回话',
  send: '送话',
}

export interface LaneJam {
  family: string
  step: LaneStep
  /** 那一下开始的时刻。 */
  since: string
  waitedMs: number
  say: string
}

export type LaneOutcome<T> =
  | { ok: true, value: T }
  /** `jammed` 这一下超了上限;`skipped` 堵着、还没到再探的时候(一下都没发);`reset` 被「重置这一家」撤掉了。 */
  | { ok: false, why: 'jammed' | 'skipped' | 'reset', say: string, jam?: LaneJam }

export interface LaneView {
  family: string
  busy: boolean
  /** 排在后面的几下。 */
  queued: number
  jam?: LaneJam
}

export interface FamilyLanesDeps {
  now: () => Date
  /** 家名(人话)。缺席用 id 原样。 */
  name?: (family: string) => string
  readCapMs?: number
  runCapMs?: number
  probeEveryMs?: number
  /** 判堵那一刻回调一次(记账)。 */
  onJam?: (jam: LaneJam) => void
}

export interface FamilyLanes {
  /** 在这一家的通道里做一下。**fn 自己抛的错原样往上抛**(那是那一步自己的失败,不是通道堵了)。 */
  run: <T>(family: string, step: LaneStep, fn: () => Promise<T>) => Promise<LaneOutcome<T>>
  view: (family: string) => LaneView
  /**
   * 这一家此刻放不放一下读窗出去(没堵 / 堵着但到了再探的时候)。**不改任何状态** ——
   * 引擎在过闸之前先问它:堵着的那一拍连闸都不问(不白扣次数)。
   */
  due: (family: string) => boolean
  views: () => readonly LaneView[]
  /** 重置这一家:回撤掉了几下排着的、作废了几下在跑的。 */
  reset: (family: string) => { cancelled: number, abandoned: number }
}

/** 卡上那一句。 */
export function laneJamSay(input: { who: string, step: LaneStep, waitedMs: number }): string {
  return `${input.who} 的窗口卡住了:${LANE_STEP_TEXT[input.step]}那一步等了 ${Math.round(input.waitedMs / 1000)} 秒没回应 —— 先跳过它,别家照常;点「重置这一家」可以清掉这条通道`
}

/** 撤掉的那一下说什么。 */
export function laneResetSay(who: string): string {
  return `${who} 的通道刚被重置,这一下撤了`
}

interface Waiter {
  start: () => void
  cancel: () => void
}

interface Lane {
  generation: number
  running: { abandon: () => void } | undefined
  queue: Waiter[]
  jam: LaneJam | undefined
  /** 堵着时上一次放一下出去的时刻(判堵那一刻也算)。 */
  probedMs: number | undefined
}

export function createFamilyLanes(deps: FamilyLanesDeps): FamilyLanes {
  const who = (family: string): string => deps.name?.(family) ?? family
  const capOf = (step: LaneStep): number => step === 'read'
    ? (deps.readCapMs ?? LANE_READ_CAP_MS)
    : (deps.runCapMs ?? LANE_RUN_CAP_MS)
  const probeEveryMs = deps.probeEveryMs ?? LANE_PROBE_EVERY_MS
  const lanes = new Map<string, Lane>()

  function laneOf(family: string): Lane {
    let lane = lanes.get(family)
    if (lane === undefined) {
      lane = { generation: 0, queue: [], running: undefined, jam: undefined, probedMs: undefined }
      lanes.set(family, lane)
    }
    return lane
  }

  function next(lane: Lane): void {
    lane.running = undefined
    lane.queue.shift()?.start()
  }

  function run<T>(family: string, step: LaneStep, fn: () => Promise<T>): Promise<LaneOutcome<T>> {
    const lane = laneOf(family)
    const nowMs = deps.now().getTime()
    if (lane.jam !== undefined && step === 'read') {
      if (lane.probedMs !== undefined && nowMs - lane.probedMs < probeEveryMs) {
        return Promise.resolve({ ok: false, why: 'skipped', say: lane.jam.say, jam: lane.jam })
      }
      lane.probedMs = nowMs
    }
    const generation = lane.generation
    return new Promise<LaneOutcome<T>>((resolve, reject) => {
      let settled = false
      const finish = (out: LaneOutcome<T> | { error: unknown }): void => {
        if (settled) return
        settled = true
        if ('error' in out) reject(out.error)
        else resolve(out)
      }
      const start = (): void => {
        if (lane.generation !== generation) {
          finish({ ok: false, why: 'reset', say: laneResetSay(who(family)) })
          return
        }
        const startedMs = deps.now().getTime()
        const cap = capOf(step)
        let timer: ReturnType<typeof setTimeout> | undefined
        lane.running = {
          abandon: () => {
            if (timer !== undefined) clearTimeout(timer)
            finish({ ok: false, why: 'reset', say: laneResetSay(who(family)) })
          },
        }
        timer = setTimeout(() => {
          if (settled || lane.generation !== generation) return
          const jam: LaneJam = {
            family,
            step,
            since: new Date(startedMs).toISOString(),
            waitedMs: cap,
            say: laneJamSay({ who: who(family), step, waitedMs: cap }),
          }
          lane.jam = jam
          lane.probedMs = deps.now().getTime()
          try { deps.onJam?.(jam) } catch { /* 记账坏了不连累通道 */ }
          finish({ ok: false, why: 'jammed', say: jam.say, jam })
          next(lane)
        }, cap)
        timer.unref?.()
        fn().then(
          (value) => {
            clearTimeout(timer)
            if (settled) return
            if (lane.generation === generation && lane.jam?.step === step) {
              lane.jam = undefined
              lane.probedMs = undefined
            }
            finish({ ok: true, value })
            if (lane.generation === generation) next(lane)
          },
          (error: unknown) => {
            clearTimeout(timer)
            if (settled) return
            finish({ error })
            if (lane.generation === generation) next(lane)
          },
        )
      }
      if (lane.running === undefined) start()
      else lane.queue.push({ start, cancel: () => finish({ ok: false, why: 'reset', say: laneResetSay(who(family)) }) })
    })
  }

  function view(family: string): LaneView {
    const lane = lanes.get(family)
    return {
      family,
      busy: lane?.running !== undefined,
      queued: lane?.queue.length ?? 0,
      ...(lane?.jam === undefined ? {} : { jam: lane.jam }),
    }
  }

  function due(family: string): boolean {
    const lane = lanes.get(family)
    if (lane?.jam === undefined || lane.probedMs === undefined) return true
    return deps.now().getTime() - lane.probedMs >= probeEveryMs
  }

  return {
    run,
    view,
    due,
    views: () => [...lanes.keys()].map(view),
    reset(family) {
      const lane = laneOf(family)
      lane.generation += 1
      const waiting = lane.queue.splice(0)
      for (const one of waiting) one.cancel()
      const running = lane.running
      lane.running = undefined
      running?.abandon()
      lane.jam = undefined
      lane.probedMs = undefined
      return { cancelled: waiting.length, abandoned: running === undefined ? 0 : 1 }
    },
  }
}

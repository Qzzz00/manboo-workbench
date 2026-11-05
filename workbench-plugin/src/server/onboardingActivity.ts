/**
 * 引导里「她去找 / 读你的项目」**那一整段等待**的窗口(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)。
 *
 * 维护者原话:「扫描的时候,粒子球应该变成工作的状态……」。以前的扫描进度只在**真在读目录 / 读文件**的那几十毫秒到
 * 一秒里是 `scanning:true`,两端靠轮询(1.5–2 秒一拍)去碰,多半碰不上,事后补 0.6 秒 —— 那时她已经在说结果了。
 * 真正让人等的是「找 + 读 + 模型组织话」这一整段。所以这里开一个**窗口**:
 *
 *   - **开**:`POST /onboarding/scan`、`POST /onboarding/project-brief` 过了门、真要动手的那一刻(http.ts 用 {@link OnboardingActivity.run} 包住);
 *   - **中间不断**:按名字找完紧接着读(同一个请求里两段)、DSH 那条路上她一口气 curl 两次,都算同一段;
 *   - **收**:
 *     · DSH 那条路(电脑首次流程、手机打字引导页 —— 开窗那一刻 DSH 引导会话那一轮**在跑**):
 *       活儿做完**先不收**(`held`),等回合表里**她的下一句**出来(`assistant` 回合,出错那句也算),
 *       或者这一轮收场了她一句没说(`busy` 落了),或者保险时限 {@link ACTIVITY_HOLD_MAX_MS} 到了;
 *     · 电话那条路(工人经 LiveKit 自己接话,DSH 那一轮没在跑,回合表里看不见她说话):活儿做完就收 ——
 *       「她开口」只有手机看得见(字幕 / 远端音轨),由手机本地收(butler-app/src/onboarding/scanWindow.ts)。
 *
 * 回包形状不变(`GET /onboarding/turns` 的 `scan` 与 `GET /onboarding/scan/status` 同一份,见 projectsService.ts ScanProgress),
 * 只多两格:`id`(第几段窗口,进程内从 1 数起;开过窗才有)与 `held`(活儿做完了、在等她开口)。
 * 窗口开着时 `scanning:true`;活儿在两段之间、或已做完在等她时,`phase / current / done / total` 是最后那一段的样子。
 * 一次窗口都没开过时原样交出项目区那一份(老用例与老界面一字不变)。
 *
 * 纯内存、不落盘;「收」是**读的时候现算**的(不接回合表的事件,少一条接线就少一处会漏)。
 */
import type { ScanProgress } from './projectsService.ts'

/** 活儿做完之后最多替她撑多久(DSH 那条路)。模型组织一段复述通常几秒;过了这么久还没开口,就不再装作在找。 */
export const ACTIVITY_HOLD_MAX_MS = 30_000

/** 窗口要看的回合表那几样(onboardingTurns 的一个窄口,http.ts 接)。 */
export interface ActivityTurns {
  /** DSH 引导会话那一轮此刻在不在跑(turn/start 之后、turn/end 之前)。 */
  busy: () => boolean
  /** 回合表最新的 seq;没有回合是 0。 */
  lastSeq: () => number
  /** `seq` 之后她(assistant)说过话没有。出错那句(`kind:'error'`)也算:那是替她说的一句,人已经看到了。 */
  spokeAfter: (seq: number) => boolean
}

/** 线上那一份:项目区的扫描进度 + 窗口的两格。 */
export interface ActivityWire extends ScanProgress {
  /** 第几段窗口(进程内从 1 数)。开着时是这一段;收了之后留着最后那一段的号,手机据此认「我等的那一段收了」。 */
  id?: number
  /** 活儿做完了、窗口还开着在等她开口(只在 DSH 那条路上出现)。 */
  held?: boolean
}

export interface OnboardingActivity {
  /** 在窗口里干一段活儿。窗口没开就开一个;上一段还在等她开口就接着算同一段。 */
  run: <T>(work: () => Promise<T>) => Promise<T>
  /** 此刻该交给界面的那一份(`scan`)。 */
  view: () => ActivityWire
}

export interface OnboardingActivityOptions {
  /** 项目区那一份扫描进度(projectsService.scanProgress)。 */
  progress: () => ScanProgress
  /** 引导回合表;不给 = 没有 DSH 那条路可认,活儿做完就收。 */
  turns?: ActivityTurns
  /** 毫秒钟。测试注入。 */
  now?: () => number
  /** 缺省 {@link ACTIVITY_HOLD_MAX_MS}。 */
  holdMaxMs?: number
}

interface ScanWindow {
  id: number
  startedAt: number
  /** 正在干的活儿有几段(同一时刻两个请求都算进来)。 */
  inFlight: number
  /** 开窗时 DSH 那一轮在跑:做完先不收,等她开口。 */
  hold: boolean
  /** 开窗那一刻回合表最新的 seq:这之后的 assistant 回合才算「她的下一句」。 */
  seqAtOpen: number
  /** 开窗那一刻项目区那一份的样子:做完了还一样 = 这一段没碰过它(读路径被拒之类)。 */
  openKey: string
  /** 窗口里最后一次看到的「真在干」那一份。 */
  lastLive?: ScanProgress
  /** 活儿做完的时刻;undefined = 还在干。 */
  endedAt: number | undefined
}

function keyOf(progress: ScanProgress): string {
  return JSON.stringify(progress)
}

export function createOnboardingActivity(options: OnboardingActivityOptions): OnboardingActivity {
  const now = options.now ?? (() => Date.now())
  const holdMaxMs = options.holdMaxMs ?? ACTIVITY_HOLD_MAX_MS
  let counter = 0
  let current: ScanWindow | undefined
  let lastId: number | undefined

  function close(): void {
    if (current === undefined) return
    lastId = current.id
    current = undefined
  }

  /** 活儿做完、在等她开口的那一段:看该不该收。 */
  function settle(): void {
    const open = current
    if (open === undefined || open.endedAt === undefined) return
    const turns = options.turns
    if (turns === undefined) { close(); return }
    try {
      // 回合表被清了(从头来 / 换了一条会话):等的那句不会来了。
      if (turns.lastSeq() < open.seqAtOpen) { close(); return }
      if (turns.spokeAfter(open.seqAtOpen)) { close(); return }
      if (!turns.busy()) { close(); return }
    }
    catch { close(); return }
    if (now() - open.endedAt >= holdMaxMs) close()
  }

  /** 窗口开着、手上没有「真在干」的那一份时,显示什么:最后那一段的样子。 */
  function shownWhileOpen(open: ScanWindow, base: ScanProgress): ScanProgress {
    // 这一段一次都没碰过项目区那一份(路径被拒、门后面炸了):说笼统那句「正在找你的项目…」。
    if (open.lastLive === undefined && keyOf(base) === open.openKey) return { scanning: true, done: 0 }
    if (base.last_read !== undefined) return { scanning: true, phase: 'read', done: 0, current: base.last_read }
    if (base.total !== undefined) return { scanning: true, phase: 'repos', done: base.done, total: base.total }
    if (open.lastLive !== undefined) return { ...open.lastLive, scanning: true }
    return { scanning: true, phase: 'list', done: 0 }
  }

  return {
    async run(work) {
      settle()
      if (current === undefined) {
        counter += 1
        let seqAtOpen = 0
        try { seqAtOpen = options.turns?.lastSeq() ?? 0 }
        catch { seqAtOpen = 0 }
        current = { id: counter, startedAt: now(), inFlight: 0, hold: false, seqAtOpen, openKey: keyOf(options.progress()), endedAt: undefined }
      }
      const mine = current
      mine.inFlight += 1
      mine.endedAt = undefined
      let busy = false
      try { busy = options.turns?.busy() === true }
      catch { busy = false }
      mine.hold = mine.hold || busy
      try {
        return await work()
      }
      finally {
        if (current === mine) {
          mine.inFlight = Math.max(0, mine.inFlight - 1)
          if (mine.inFlight === 0) {
            mine.endedAt = now()
            if (!mine.hold) close()
          }
        }
      }
    },

    view() {
      settle()
      const base = options.progress()
      const open = current
      if (open === undefined) return lastId === undefined ? base : { ...base, id: lastId }
      const stamp = { id: open.id, started_at: new Date(open.startedAt).toISOString() }
      if (base.scanning) {
        open.lastLive = base
        return { ...base, ...stamp }
      }
      return { ...shownWhileOpen(open, base), ...stamp, ...(open.endedAt === undefined ? {} : { held: true }) }
    },
  }
}

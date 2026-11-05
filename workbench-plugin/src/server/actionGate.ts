/**
 * ★ **一处动作闸:工作台对别家 App 的每一个自动动作都先过它**(2026-10-02,卡 AG)。
 *
 * 维护者 10-02 原话:「你不要拿着打补丁的心态,网易云是一个例子,你要有**机制上的调整**」。
 *
 * 现场(Air 运营同学,插件 0.4.85)她的原话:「我让他打开网易云音乐,事务官不能分派让 ai 去打开,
 * 只有在命令里加了【豆包】,他才会通过豆包打开,完成后每隔 10s 又自行打开网易云。。不断弹窗」。
 *
 * 机制上的病根不是哪一家:工作台有七八条管线会去动别家的窗 —— 派活送话、重派、盯窗读回话、
 * 开窗重试(`open -b` / 深链)、叫到台前、按停止、替她点选项、看 / 按权限弹框、捎话、替她答 ——
 * 而**「这件事还动不动得」这个判断散在每条路里各写一份**:
 * - 派活那条判了(`dispatchRun.waitingWindowDispatch` 看 `done` / `canceled` 就不再读);
 * - 捎话轻账那条**没判**:它只认自己那本账上的 `state`,20 分钟内每 8 秒去读那一家的窗(`relayWatch.pump`);
 * - 而且**没有一条路有「同一件事 · 同一家 · 同一种动作最多来几回」的上限** —— 开窗重试的 3 回只管一次调用,
 *   换个包、下一拍、下一条管线又是新的 3 回。
 *
 * 任何一处判漏,工作台就会在事情早已收场之后接着去碰那一家。所以判据收成**一处**:
 * ① **收场了就不再动那一家**:`phaseOf(job) === 'settled'`(办完 / 取消 / 撤了)→ 一律拦下;
 * ② **次数与间隔上限**:同一件事 · 同一家 · 同一种动作,到顶停下并**如实告诉她**(不装作做了);
 * ③ **每一次放行 / 拦下都记一行**进任务日志(`jobLog.ts`:时间、事项、哪一家、什么动作、为什么)。
 *
 * 反过来的那条同样是规矩:**管线不许自己再写一份判断**,只许问 `allow()`。
 * 哪几条管线已经接上、哪几条还没接,逐条写在 `docs/交接-1002-网易云反复弹出与不点名不派.md`
 * (那一张卡接了四条)与 `docs/交接-1002-动作闸接满与任务日志落盘.md`
 * (卡 AG2 接上了剩下的七条,接在窗口那只手那一层;还剩哪几条、为什么,在那一份第三节)。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { JobLog } from './jobLog.ts'
import { jobLogLine } from './jobLog.ts'

/**
 * 工作台会对别家 App 做的那几样自动动作。**新加一样就要加进这张表**
 * (加不进来就说明它没过闸 —— 那是要在交接里逐条写明的事)。
 */
export type GateAction =
  /** 把这段交代送进它窗口(派活第一次)。 */
  | 'dispatch_send'
  /** 重派一次(她说重做、或者上一次没送出去)。 */
  | 'dispatch_resend'
  /** 去它窗口里读回话(派活盯窗 / 捎话巡检)。 */
  | 'reply_watch'
  /** 壳说一扇标准窗口都没有 → 把它的窗开出来(`open -b` / 深链)。 */
  | 'window_wake'
  /** 把它叫到台前。 */
  | 'bring_front'
  /** 替她点它弹的那个选项。 */
  | 'press_option'
  /** 往它那一问里写字。 */
  | 'write_ask'
  /**
   * **读**它那个权限弹框上有哪几颗键(2026-10-02,卡 AG2 从 `approval` 里分出来)。
   * 为什么分两样:读一眼不按下去,而且她每打开那张卡就读一次 —— 和「真按下一颗键」共用一个
   * 三回的上限,第四次打开卡就会被拦住。两样的上限各定(见 {@link GATE_LIMITS})。
   */
  | 'approval_read'
  /** 按它的权限弹框上的一颗键。 */
  | 'approval'
  /** 按它的停止。 */
  | 'stop'
  /** 把她那句捎进它已有的那条对话。 */
  | 'relay_send'
  /** 替她答它那一问。 */
  | 'answer_send'

/** 整张表(用例靠它保证每一样都有上限、都有人话)。 */
export const GATE_ACTIONS: readonly GateAction[] = [
  'dispatch_send',
  'dispatch_resend',
  'reply_watch',
  'window_wake',
  'bring_front',
  'press_option',
  'write_ask',
  'approval_read',
  'approval',
  'stop',
  'relay_send',
  'answer_send',
]

/** 跟她说这件事时用的人话(不说 op 名、不说包标识)。 */
export const GATE_ACTION_TEXT: Readonly<Record<GateAction, string>> = {
  dispatch_send: '把这件交代送进它窗口',
  dispatch_resend: '重派',
  reply_watch: '去它窗口里看回话',
  window_wake: '把它的窗开出来',
  bring_front: '把它叫到台前',
  press_option: '替你点它弹的选项',
  write_ask: '往它那一问里写字',
  approval_read: '看它那个权限弹框上有哪几颗键',
  approval: '按它那个权限弹框上的键',
  stop: '按它的停止',
  relay_send: '把你那句捎进去',
  answer_send: '替你答它那一问',
}

/**
 * 这件事此刻的状态。
 * - `open` 还在办 —— 动得;
 * - `settled` 收场了(办完 / 取消 / 撤了)—— **一律不再动那一家**;
 * - `unknown` 查不出 —— 不当成收场,照旧放行,但次数上限照算。
 *
 * ★ 2026-10-02(卡 AG2):「不在看板上的那几条」**不再只能是 `unknown`** —— 捎话与会话那几条路
 * 现在带着键过来(有事项就是事项 id,没有就是 `jobKey.sessionJobId` 那个会话键),
 * 判法在 `jobKey.jobPhaseOf` 一处:认领了这条会话的那张卡收场了,这几条路也一起停手。
 */
export type JobPhase = 'open' | 'settled' | 'unknown'

/** 拦下的三种原因。 */
export type GateBlock = 'settled' | 'too_many' | 'too_soon'

export interface GateLimit {
  /** 同一件事 · 同一家 · 同一种动作最多放行几回。 */
  tries: number
  /** 两回之间至少隔多久(毫秒);太密的那一下拦下,**而且不算一回**。 */
  minIntervalMs: number
  /**
   * ★ **同一句话的去重开关**(2026-10-23,卡「捎话节流闸误拦」):窗口({@link minIntervalMs})内
   * 同一件事 · 同一句原话重复 = **同一回** —— 放行一次、其余静默合并(不拦、不计数、不占次数)。
   * 只开给捎话:事务官一句捎话一秒内连试几次(工具重试 / 两条路各试一次),第二、三下不该被当「太密」拦下。
   * 替她答那一路不开:两条连着重送由锁屏队的 `LOCK_DRAIN_GAP_MS` 隔开(见 `engine/lockQueue.ts`)。
   */
  dedupeText?: boolean
}

/**
 * 每一样动作的上限。定这几个数的依据:
 * - `window_wake` 3 回 = `windowWake.NO_WINDOW_WAKE_TRIES`(那一圈本来的上限,现在**跨调用也只有这 3 回**);
 * - `dispatch_send` 3 回:一家最多装两个包(卡 DP),再加一次余量;
 * - `dispatch_resend` 2 回、隔一分钟:重派是她开口才有的事,机器自己不许连着重派;
 * - `reply_watch` 1000 回、隔 3 秒:派活盯窗 45 分钟 ÷ 4 秒 ≈ 675 拍、捎话 20 分钟 ÷ 8 秒 = 150 拍,
 *   都在这个数以下 —— 这一格**不改现有节拍**,只给一个说得出的天花板;
 * - 窗口上那几只手(点选项 / 写面板 / 批准 / 停止 / 捎话 / 替她答)**30 回、隔 1.5 秒**:
 *   ★ 2026-10-02(卡 AG2 真接上这几条路时改的,原来是 3 回)。改的理由是**键变了**:
 *   这几条路上没有事项 id,键是**会话**(`jobKey.sessionJobId`)—— 一条会话活几个小时,
 *   她往同一条 Claude 会话里捎第四句话、答第四问,3 回就会在第四下被拦住,
 *   而那一下**是她点的**,拦下就是错的。这几样的上限只为挡住跑飞的循环(同一秒里按十下),
 *   所以留「30 回 + 隔 1.5 秒」:她手点不出这个密度,循环一拍就撞上。
 *   真正挡住 10-02 那一类的是**第一条**(收场了就不再动那一家),不是这个数。
 * - `approval_read` 60 回、隔 1 秒:只读一眼、不按下去,而且她每打开那张卡就读一次(手机上会来回开)。
 */
export const GATE_LIMITS: Readonly<Record<GateAction, GateLimit>> = {
  /*
   * ★ `dispatch_send` 的间隔是 **0**,不是「保险起见给一秒」:挑中的那个包没窗口时,
   * 外面那一层 `dispatchClient.send` 会**当场**换同一家另一个包再送一回(卡 DP / AX3)——
   * 那两下相隔只有几毫秒。给个间隔就会把换包那一路拦死,等于把 10-01 修好的东西又弄坏。
   * 这一样靠**次数**管够了(3 回:最多两个包 + 一次余量)。
   */
  dispatch_send: { tries: 3, minIntervalMs: 0 },
  dispatch_resend: { tries: 2, minIntervalMs: 60_000 },
  reply_watch: { tries: 1000, minIntervalMs: 3000 },
  window_wake: { tries: 3, minIntervalMs: 0 },
  bring_front: { tries: 30, minIntervalMs: 1000 },
  press_option: { tries: 30, minIntervalMs: 1500 },
  write_ask: { tries: 30, minIntervalMs: 1500 },
  approval_read: { tries: 60, minIntervalMs: 1000 },
  approval: { tries: 30, minIntervalMs: 1500 },
  stop: { tries: 30, minIntervalMs: 1500 },
  /**
   * ★ `relay_send` 的 `dedupeText`(2026-10-23,卡「捎话节流闸误拦」):同一句一秒内重试 = 同一回,
   * 放行一次、其余静默合并 —— 窗口就是上面的 `minIntervalMs`(1 秒)。理由见 {@link GateLimit.dedupeText}。
   */
  relay_send: { tries: 30, minIntervalMs: 1000, dedupeText: true },
  answer_send: { tries: 30, minIntervalMs: 1000 },
}

export interface GateRequest {
  /** 哪一件事(事项 id;捎话轻账那一条用它自己的 id)。 */
  job: string
  /** 哪一家(登记表那个 id)。 */
  family: string
  action: GateAction
  /** 真要动的那个包(只为记账说得清是哪扇窗)。 */
  bundle_id?: string
  /**
   * ★ **那一句的原话**(2026-10-23,卡「捎话节流闸误拦」):`dedupeText` 那几样靠它认「同一句」。
   * 别的动作不需要,不传就行。
   */
  text?: string
  /**
   * ★ 这一下是她亲口 / 亲手交代的(2026-10-13 夜,卡 Y;`Job.by`)。第 ① 条「收场了就不再动那一家」对它不拦 ——
   * 那一条拦的是工作台自动追着办的;她自己往办完的那条会话里再说一句是新的交代。次数与间隔(② ③)照旧算。
   */
  by?: 'user'
}

export type GateVerdict =
  | { ok: true, tried: number, deduped?: undefined }
  | { ok: true, tried: number, deduped: true }
  | { ok: false, why: GateBlock, say: string, tried: number }

/**
 * ★ **relay_send 被「太密」拦下时回事务官那一句**(2026-10-23,卡「捎话节流闸误拦」)。
 * 能念给她听,而且说清「这一句没送进去」(不能只拦不吭声)。
 */
export const RELAY_TOO_SOON_SAY = '刚捎过,这一句没送进去,过几秒再说'

/**
 * ★ **同一句重试被静默合并时回上层那一句**(2026-10-23,卡「捎话节流闸误拦」)。
 * 引擎 / sessionJobs 用它当「已按这一句办过、没再重发」的说明,一处写。
 */
export const RELAY_DEDUPED_NOTE = '这一句刚捎过,没再重发'

/** 拦下时跟她说的那一句。**一处写**(日志、回包、电话里都用它)。 */
export function gateBlockSay(why: GateBlock, input: { who: string, action: GateAction, tried: number }): string {
  const what = GATE_ACTION_TEXT[input.action]
  if (why === 'settled') return `这件已经收场了(办完 / 取消 / 撤了),我不再去${what} —— ${input.who} 那边我一下都不动了`
  if (why === 'too_many') return `同一件事我已经${what} ${input.tried} 回了,到顶了,不再来 —— 要再来一次你说一声`
  // ★ 捎话的「太密」专说那一句:说清这一句没送进去、过几秒再说(卡「捎话节流闸误拦」)。
  if (why === 'too_soon' && input.action === 'relay_send') return RELAY_TOO_SOON_SAY
  return `刚${what}过,这一下太密了,等一会儿再说`
}

/** 账上「为什么」那一格(短,给排障看)。 */
const GATE_BLOCK_WHY: Readonly<Record<GateBlock, string>> = {
  settled: '这件已经收场,不再动那一家',
  too_many: '同一件事同一家同一种动作到顶了',
  too_soon: '离上一回太密',
}

/**
 * ★ **计数留多久**(2026-10-21,卡「派活按家隔离」):同一件事 · 同一家 · 同一种动作,上一回放行之后
 * 这么久没再动它,那一格就过期清掉、从头数。六小时:派活盯窗最长 45 分钟、捎话 20 分钟,
 * 一件真在办的事跨不过它;而「卡住的那一件把那一家拦到重启」那种情形,最多拦半天,不再永久封。
 */
export const GATE_KEEP_MS = 6 * 60 * 60 * 1000

/** 落盘的一格。 */
export interface GateRecord {
  job: string
  family: string
  action: GateAction
  tried: number
  last_ms: number
}

/** 计数落在哪(与任务日志、看板同一个目录)。 */
export function defaultGateFile(home = process.env.HOME ?? ''): string {
  return join(home, '.dsh', 'workbench', 'action-gate.json')
}

export interface GateStore {
  /** 读不出 / 坏了 = 空表(不挡路)。 */
  load: () => readonly GateRecord[]
  save: (records: readonly GateRecord[]) => void
}

/** 一个 JSON 文件(写 `.tmp` 再改名,写到一半断电也不留半截)。 */
export function createGateFileStore(file: string): GateStore {
  return {
    load() {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown }
        if (!Array.isArray(raw.records)) return []
        return raw.records.flatMap((one): GateRecord[] => {
          if (typeof one !== 'object' || one === null) return []
          const r = one as Record<string, unknown>
          if (typeof r.job !== 'string' || typeof r.family !== 'string' || !GATE_ACTIONS.includes(r.action as GateAction)) return []
          if (typeof r.tried !== 'number' || !Number.isFinite(r.tried) || typeof r.last_ms !== 'number' || !Number.isFinite(r.last_ms)) return []
          return [{ job: r.job, family: r.family, action: r.action as GateAction, tried: r.tried, last_ms: r.last_ms }]
        })
      }
      catch { return [] }
    },
    save(records) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, records }))
        renameSync(`${file}.tmp`, file)
      }
      catch { /* 落不了盘:内存里照样生效,下一回再写 */ }
    },
  }
}

export interface ActionGateDeps {
  /** 这件事此刻还动不动得(实现在调用方:看板上查卡的状态)。**自己坏了就当查不出**。 */
  phaseOf: (job: string) => JobPhase
  /** 任务日志。缺席 = 不记账(闸照样生效,但就查不回来了)。 */
  log?: JobLog
  now: () => Date
  /** 家名(「豆包办公」)。缺席就用 id 原样。 */
  name?: (family: string) => string
  /** 盖掉某几样的上限(用例、以后放到设置里)。 */
  limits?: Partial<Record<GateAction, GateLimit>>
  /** ★ 计数落盘(2026-10-21)。缺席 = 只在内存(老行为)。 */
  store?: GateStore
  /** 计数留多久(缺省 {@link GATE_KEEP_MS})。 */
  keepMs?: number
  /** 改了之后多久写盘(攒一攒,盯窗每几秒一拍不必每拍都写)。缺省 2 秒。 */
  saveDelayMs?: number
}

export interface ActionGate {
  /** 这一下动得动不得。**放行就当场记一回**(调用方拿到 ok 就该去做了)。 */
  allow: (req: GateRequest) => GateVerdict
  /** 她说重来一遍:这件事的次数从头数(只清次数,账上那几行一条都不动)。 */
  forget: (job: string) => void
  /** ★ 重置这一家(2026-10-21):这一家所有事的次数从头数;回清了几格。 */
  forgetFamily: (family: string) => number
  /** 等攒着的那一次写盘写完(用例、退出前)。 */
  flush: () => Promise<void>
}

export function createActionGate(deps: ActionGateDeps): ActionGate {
  const name = deps.name ?? ((family: string) => family)
  const limitOf = (action: GateAction): GateLimit => deps.limits?.[action] ?? GATE_LIMITS[action]
  /** `事项\u0000家\u0000动作` → 放行过几回、上一回什么时候、上一回那句原话(去重那几样用)。 */
  const seen = new Map<string, { tried: number, lastMs: number, job: string, family: string, action: GateAction, lastText?: string }>()
  const keyOf = (req: GateRequest): string => `${req.job}\u0000${req.family}\u0000${req.action}`
  const keepMs = deps.keepMs ?? GATE_KEEP_MS
  const saveDelayMs = deps.saveDelayMs ?? 2000
  {
    const nowMs = deps.now().getTime()
    for (const one of deps.store?.load() ?? []) {
      if (nowMs - one.last_ms > keepMs) continue
      seen.set(keyOf(one), { tried: one.tried, lastMs: one.last_ms, job: one.job, family: one.family, action: one.action })
    }
  }
  let saving: ReturnType<typeof setTimeout> | undefined
  let saved: Promise<void> = Promise.resolve()
  function scheduleSave(): void {
    if (deps.store === undefined || saving !== undefined) return
    saved = new Promise<void>((resolve) => {
      saving = setTimeout(() => {
        saving = undefined
        const nowMs = deps.now().getTime()
        const records: GateRecord[] = []
        for (const [key, one] of seen) {
          if (nowMs - one.lastMs > keepMs) { seen.delete(key); continue }
          records.push({ job: one.job, family: one.family, action: one.action, tried: one.tried, last_ms: one.lastMs })
        }
        deps.store?.save(records)
        resolve()
      }, saveDelayMs)
      saving.unref?.()
    })
  }

  function record(req: GateRequest, step: 'gate_pass' | 'gate_block', why?: string): void {
    if (deps.log === undefined) return
    const event = deps.log.append({
      job: req.job,
      step,
      family: req.family,
      action: req.action,
      ...(req.bundle_id === undefined ? {} : { bundle_id: req.bundle_id }),
      ...(why === undefined ? {} : { why }),
    })
    // 拦下的那一行进日志(放行每拍都有,刷满一屏帮不了任何人)。
    if (step === 'gate_block') console.warn(jobLogLine(event))
  }

  function phaseOf(job: string): JobPhase {
    try { return deps.phaseOf(job) }
    catch { return 'unknown' }
  }

  function block(req: GateRequest, why: GateBlock, tried: number): GateVerdict {
    record(req, 'gate_block', GATE_BLOCK_WHY[why])
    return { ok: false, why, tried, say: gateBlockSay(why, { who: name(req.family), action: req.action, tried }) }
  }

  return {
    allow(req) {
      const nowMs = deps.now().getTime()
      const kept = seen.get(keyOf(req))
      // 过期的那一格当没有(从头数):重启不丢,也不永久封。
      const had = kept !== undefined && nowMs - kept.lastMs > keepMs ? undefined : kept
      const tried = had?.tried ?? 0
      // ① 收场了就不再动那一家 —— 这一条在次数之前,收场之后连「还没到顶」都不算理由。
      // ★ 她亲手交代的那一下例外(卡 Y):旧卡办完了不等于她不能再往那条会话里说话。
      if (req.by !== 'user' && phaseOf(req.job) === 'settled') return block(req, 'settled', tried)
      const limit = limitOf(req.action)
      /*
       * ★ **同一句重试 = 同一回**(2026-10-23,卡「捎话节流闸误拦」):`dedupeText` 那几样,
       * 窗口(`minIntervalMs`)内同一件事 · 同一句原话重复 —— 放行一次、其余**静默合并**:
       * 不拦、不计数、不占次数。事务官一句捎话一秒内连试几次(工具重试 / 两条路各试一次),
       * 第二、三下不再被当「太密」拦下。不同句照旧走下面那条「太密」。
       */
      if (limit.dedupeText === true && had !== undefined && limit.minIntervalMs > 0
        && nowMs - had.lastMs < limit.minIntervalMs && req.text !== undefined && had.lastText === req.text) {
        return { ok: true, tried, deduped: true }
      }
      // ② 到顶了。
      if (tried >= limit.tries) return block(req, 'too_many', tried)
      // ③ 太密(**拦下的这一下不算一回**:节拍快不该把额度吃掉)。不同句的那一下才到这儿。
      if (had !== undefined && limit.minIntervalMs > 0 && nowMs - had.lastMs < limit.minIntervalMs) {
        return block(req, 'too_soon', tried)
      }
      seen.set(keyOf(req), {
        tried: tried + 1,
        lastMs: nowMs,
        job: req.job,
        family: req.family,
        action: req.action,
        ...(limit.dedupeText === true && req.text !== undefined ? { lastText: req.text } : {}),
      })
      scheduleSave()
      record(req, 'gate_pass')
      return { ok: true, tried: tried + 1 }
    },
    forget(job) {
      for (const key of [...seen.keys()]) {
        if (key.startsWith(`${job}\u0000`)) seen.delete(key)
      }
      scheduleSave()
    },
    forgetFamily(family) {
      let cleared = 0
      for (const [key, one] of [...seen]) {
        if (one.family !== family) continue
        seen.delete(key)
        cleared += 1
      }
      scheduleSave()
      return cleared
    },
    async flush() { await saved },
  }
}

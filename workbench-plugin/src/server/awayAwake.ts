/**
 * ★ **「出门时电脑不睡」**(2026-10-03,卡「出门时电脑不睡」;决策记录同日
 * 「其余待拍板按统筹倾向执行」里那一条)。
 *
 * ## 前因
 *
 * 本机量过(`docs/交接-1003-锁屏时窗口型的家.md` 第四节):`displaysleep 10` +
 * `screenLock delay is immediate` —— 她离开 10 分钟屏幕就睡,**一睡立刻锁**;
 * 而锁屏时窗口型的家(豆包 / Kimi / Manus…)一扇标准窗口都列不出来,
 * 她在外面答的那句话送不进去(0.4.90 起能认出来、会排队等解锁,但那句话还是得等她回家)。
 *
 * 工作台今天那条「别让屏幕暗下去」的断言**只在它自己在最前面时按着**
 * (`workbench-app/Sources/DisplayAwakePolicy.swift`)—— 而她出门那一幕里它一定是放掉的。
 * 所以维护者拍板加一颗开关:**手机在外面连着的时候,不管工作台在不在最前面都按住**。
 *
 * ## 「出门」怎么判(**一个新心跳都不造**)
 *
 * 用现成的两份事实,一份都不新算:
 *
 *   ① **在线设备表**(`deviceDirectory.ts`):谁在房里是 LiveKit 说了算,工人在设备进出时报一份、
 *      平时每 60 秒再报一遍。这张表就是「经中转连着的有谁」—— 手机**按需进房、不常驻**
 *      (`butler-app/src/session.ts`:「回到局域网就把房间放掉」),所以**一台手机出现在这张表里,
 *      就是它这会儿在局域网外、正经中转说话**。
 *   ② **配对记录**(`devices.json` → `pairing.list()`):这台到底是**手机**还是那只树莓派话筒。
 *      这一条必须有:中转签的进房凭证一度不带 `wb_kind`,于是**一只走中转进房的话筒在上报里是
 *      `kind:'phone'`**(deviceDirectory.ts 的 `withPairedKinds` 文件头写明了这个坑)——
 *      而那只话筒就摆在她家桌上、常驻房间。按上报那一格判,她在家也会被判成出门,
 *      家里那块屏整天亮着。所以**只认配对记录里写着 `phone` 的那几台**。
 *
 * ## 三条纪律
 *
 * - **「不知道」一律按「没出门」算**(D13 的这一面):没接通道层、工人没报过、这份表旧了
 *   ({@link DevicesView.stale})、配对表读不出来 —— 都回 `undefined`,`active` 就是 false。
 *   按反了的代价是**她不在家、家里那块屏一直亮着**,而这是她自己看不见的
 *   (同 `DisplayAwakePolicy` 那句「宁可放掉也不要按着不放」)。
 * - **开关关着 = 什么都不变**:`active` 恒 false,壳那边 `shouldHold` 逐字回到 2026-10-03 之前。
 * - **变了才下发**:结论没变就不发 op(壳那头幂等,但没必要一秒一条);
 *   壳断开重连之后**要再发一次** —— 壳起来缺省是 false,它自己不知道这件事。
 */
import type { DevicesView, PairedKinds } from './deviceDirectory.ts'

/** 多久重算一次(毫秒)。在线设备表自己 60 秒一报,这里不必更密。 */
export const AWAY_AWAKE_POLL_MS = 5000

/** 配对记录里算「手机」的那一种(话筒不算 —— 它常驻房间,而且就在她家桌上)。 */
export const AWAY_PHONE_KIND = 'phone'

export interface AwayAwakeFacts {
  /** 在线设备表此刻那一份。缺席 = 没接通道层 → 不知道。 */
  devices?: DevicesView | undefined
  /** 配对记录(id → 手机 / 话筒)。缺席 = 读不出配对表 → 不知道。 */
  paired?: PairedKinds | undefined
}

/**
 * **这一刻有没有已配对的手机在外面连着**(`undefined` = 不知道)。纯函数。
 *
 * 判法见文件头:在线设备表里有一台,它的 id 在配对记录里、而且记着的是**手机**。
 */
export function phoneAwayNow(facts: AwayAwakeFacts): boolean | undefined {
  const { devices, paired } = facts
  if (devices === undefined || paired === undefined) return undefined
  // 这份表旧了(工人掉线 / 工作台刚重启)或者一次都没报过:**不知道**,不拿一份陈旧的表当实情。
  if (devices.stale) return undefined
  return devices.devices.some(one => paired.get(one.device_id) === AWAY_PHONE_KIND)
}

/**
 * 这一刻「出门时电脑不睡」成不成立 = 开关开着 **且** 真有一台已配对手机在外面连着。
 * 不知道按没出门算(见文件头第一条纪律)。
 */
export function awayAwakeActive(settingOn: boolean, away: boolean | undefined): boolean {
  return settingOn && away === true
}

/** 这一格此刻的样子(设置页那一行读它;`phone_away` 缺席 = 不知道,界面不许说成「没出门」)。 */
export interface AwayAwakeView {
  /** 设置里那颗开关(app.json 的 `away_keep_awake`,缺席 = 关)。 */
  enabled: boolean
  /** 此刻有没有已配对手机在外面连着。**缺席 = 不知道**(没接通道层 / 工人没报过 / 表旧了)。 */
  phone_away?: boolean
  /** 这一格此刻真的在起作用没有(= 壳那边 `shouldHold` 不看前台)。 */
  active: boolean
}

export interface AwayAwakeDeps {
  /** app.json 那颗开关。读不出来就按**关**算(缺省关)。 */
  settingOn: () => Promise<boolean>
  /** 在线设备表此刻那一份(`deviceDirectory.view(pairedKinds)`)。缺席 = 没接通道层。 */
  devices?: ((paired: PairedKinds | undefined) => DevicesView) | undefined
  /** 配对记录(`pairing.list()` 那一份 id → kind)。读不出来回 `undefined`。 */
  paired?: (() => Promise<PairedKinds | undefined>) | undefined
  /** 把结论下发给壳(helper 的 `away_awake` op)。**抛出来 = 没下发成**。 */
  send: (active: boolean) => Promise<void>
  /** 壳此刻连着没有。断了就把「上次发过什么」忘掉 —— 重连要再发一次。 */
  connected: () => boolean
  now?: () => number
  pollMs?: number
  /** 记一行(缺席 = 不记)。 */
  warn?: (line: string) => void
}

export interface AwayAwakeWatch {
  /** 走一拍(挂在 http 那根 1 秒节拍上;内部限频)。**绝不抛**。 */
  pump: () => Promise<void>
  /** 这一格此刻的样子(`GET /shell/away-keep-awake` 读它)。 */
  view: () => AwayAwakeView
  /**
   * 她在设置里点完那颗开关:**立刻重算并下发**(不等下一拍、不管结论变没变)。
   * 回「壳当场生效了没有」与原因 —— 没成就如实说,不谎报(同 `/shell/system-awake`)。
   */
  apply: () => Promise<{ view: AwayAwakeView, applied: boolean, reason?: string }>
  /**
   * **忘掉「上次发过什么」,下一拍必重发**。接在 `helper.onChange` 上(壳连上 / 断开 / 授权变了)。
   *
   * 为什么光靠 `pump` 里那句 `connected()` 不够:我们每 5 秒才看一眼,**壳在两拍之间
   * 断开又接上**(WS 抖一下)就被我们完全错过 —— 那时壳内存里那一格已经回到缺省的 `false`,
   * 而我们还以为「发过 `true` 了」,于是再也不发。后果正是这张卡要治的那一幕,而且是**静默**的。
   */
  forget: () => void
  /**
   * 壳那边动了一下(`helper.onChange`):**连法真变了才 {@link forget}**(2026-10-21)。
   * 那个回调不只在连上 / 断开 / 授权变了时响,壳每弹一条系统通知也响 —— 原来一律 `forget`,
   * 同一个结论一小时重发、重记三十来次。断开又连上会经过一次 `connected:false`,照样认得出来。
   */
  helperChanged: (link: { connected: boolean, authorized: boolean }) => void
}

/** 按住 / 放掉那一下记的两行(断言照常量,不逐字抄中文)。 */
export const AWAY_AWAKE_LOG_ON = '[出门] 手机在外面连着,先别让屏幕暗下去(出门时电脑不睡:开)'
export const AWAY_AWAKE_LOG_OFF = '[出门] 不按了(手机回到局域网 / 没连着,或者那颗开关关了)'

export function createAwayAwakeWatch(deps: AwayAwakeDeps): AwayAwakeWatch {
  const now = deps.now ?? (() => Date.now())
  const pollMs = deps.pollMs ?? AWAY_AWAKE_POLL_MS
  const warn = deps.warn ?? ((): void => {})
  let current: AwayAwakeView = { enabled: false, active: false }
  /** 上一次**真下发成**的那个结论。`undefined` = 还没发过 / 壳断过线。 */
  let sent: boolean | undefined
  /** 上一拍算在什么时候。`undefined` = 还没算过(**不用 0 当哨兵**:注进来的钟可以从 0 开始)。 */
  let computedAt: number | undefined
  let busy = false
  /** 上一次看见的壳的连法(`helperChanged` 拿它比)。 */
  let link: { connected: boolean, authorized: boolean } | undefined

  async function compute(): Promise<AwayAwakeView> {
    let settingOn = false
    // 读不出 app.json(文件坏了、权限没了)→ 按**关**算:缺省关的那一条在这里也成立。
    try { settingOn = await deps.settingOn() }
    catch { settingOn = false }
    let away: boolean | undefined
    if (deps.devices !== undefined && deps.paired !== undefined) {
      try {
        const paired = await deps.paired()
        away = phoneAwayNow({ devices: deps.devices(paired), paired })
      }
      catch { away = undefined }
    }
    const view: AwayAwakeView = {
      enabled: settingOn,
      // exactOptionalPropertyTypes:不知道就真的缺席,不写成 `phone_away: undefined`。
      ...(away === undefined ? {} : { phone_away: away }),
      active: awayAwakeActive(settingOn, away),
    }
    current = view
    return view
  }

  /** 下发一次。回 `undefined` = 成了;回一句话 = 没成(原话原样往上传,不改写)。 */
  async function deliver(active: boolean): Promise<string | undefined> {
    try {
      await deps.send(active)
      if (sent !== active) warn(active ? AWAY_AWAKE_LOG_ON : AWAY_AWAKE_LOG_OFF)
      sent = active
      return undefined
    }
    catch (error) {
      // **不记成发过**:下一拍还要再试(壳可能正在重启、或者是旧壳不认这个 op)。
      return error instanceof Error ? error.message : String(error)
    }
  }

  return {
    view: () => current,

    async pump() {
      if (busy) return
      const at = now()
      if (computedAt !== undefined && at - computedAt < pollMs) return
      computedAt = at
      busy = true
      try {
        const view = await compute()
        /*
         * 壳没连上:把「上次发过什么」忘掉。壳一重连(热更新换壳、崩了重起)它内存里那一格
         * 又是缺省的 false —— 不忘的话我们会觉得"已经发过 true 了"而再也不发。
         */
        if (!deps.connected()) { sent = undefined; return }
        if (sent === view.active) return
        await deliver(view.active)
      }
      catch { /* pump 绝不抛 */ }
      finally { busy = false }
    },

    forget() {
      sent = undefined
      // 也把限频清掉:她刚重连那一拍就该把结论补上,不要再等 5 秒。
      computedAt = undefined
    },

    helperChanged(next) {
      const before = link
      link = { connected: next.connected, authorized: next.authorized }
      if (before !== undefined && before.connected === next.connected && before.authorized === next.authorized) return
      sent = undefined
      computedAt = undefined
    },

    async apply() {
      const view = await compute()
      // 她刚点完开关:**不管变没变都发一次**(等下一拍最多要等 5 秒,而她正看着那句回话)。
      computedAt = now()
      if (!deps.connected()) {
        sent = undefined
        return { view, applied: false, reason: '窗口编排壳未接入,重开工作台后生效' }
      }
      const why = await deliver(view.active)
      return why === undefined ? { view, applied: true } : { view, applied: false, reason: why }
    },
  }
}

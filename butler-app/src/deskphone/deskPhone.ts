/**
 * 座机那几件只有原生做得到的事(2026-09-21)。
 *
 * ## 为什么非要一件原生插件
 *
 * 这台手机装在 3D 打印外壳里当座机。它要做的三件事,网页一件都做不到:
 *
 * 1. **屏幕常亮、不锁屏**。`navigator.wakeLock` 在 Capacitor 的 WebView 里不保证有
 *    (它要 secure context + 厂商实现),而且它只管「不熄屏」,管不了「已经锁了要亮起来」。
 * 2. **App 在后台 / 屏幕锁着的时候把来电页拉起来**。这是 Android 的
 *    `fullScreenIntent` —— 只有原生发得出来。**现成的 Capacitor 插件做不到这件事**:
 *    `@capacitor/local-notifications` 的 schedule 选项里根本没有 fullScreenIntent 这一项
 *    (它的 Android 实现走 NotificationCompat.Builder,没有 setFullScreenIntent 的入口)。
 *    社区插件有做的,但那是往供应链里再加一个 pin 不住的东西(C4)。
 *    **所以这里自己写一件小的**,代码在
 *    `android/app/src/main/java/ai/ben/butler/DeskPhonePlugin.java`,一共两百来行,
 *    不引入任何新依赖 —— 和 MicPermissionPlugin 同一条路子(2026-09-18 那件也是自己写的)。
 * 3. **震动**。`navigator.vibrate` 在 Android WebView 里**通常**可用,所以它是退路;
 *    但 App 在后台时网页压根没在跑,那时只有原生震得动。
 *
 * ## 后台 / 锁屏(2026-10-03 改)
 *
 * 收铃的是网页这一层(常驻 LiveKit 房间),所以**进程得活着、网得通着**。Android 14 起没有
 * 前台服务的后台进程几秒就被冻住,锁屏久了 Doze 还会断网 —— 一条普通常驻通知保不住它。
 * 于是原生起一个 specialUse 前台服务(RingStandbyService,状态栏一条「随时接电话」),
 * 设置里留开关、缺省开。铃声也改由原生放:后台时网页的 `<audio>` 不保证放得出来。
 *
 * ## 做不到的那一件,如实写在这儿
 *
 * **App 被彻底杀掉(多任务里划掉、重启后没打开过)之后叫不醒**。那要推送(厂商通道),这一版**不做**。
 * 划掉时那条常驻通知会改口成「已退出,收不到电话」,不装作还在待机。
 *
 * ## 插件没装上怎么办
 *
 * 和 micPermission.ts 同一条规矩:`registerPlugin` 本身不抛,**调它的方法才抛**。
 * 所以每一件都各自 try,失败就退回网页那条路(或者干脆什么都不做),并**如实回一句**
 * —— 界面据此可以说「这台机器上做不到常亮」,而不是装作开了。
 */
import { registerPlugin } from '@capacitor/core';

export interface DeskPhoneRingInput {
  callId: string;
  /** 通知上那一行(「等你确认 · 把首页文案改一版」)。 */
  title: string;
  text: string;
  /** true = 只发一条普通通知,不响铃、不拉起来电页(夜间静默时段)。 */
  silent: boolean;
}

/**
 * 铃声由原生放时插件回的那个值。**网页那段 `<audio>` 只在原生没放时才放** ——
 * 两头都放就是两个铃一起响。老包(没有这一格)回不出它,于是照旧网页放。
 */
export const NATIVE_TONE = 'native';

export interface DeskPhoneRingResult {
  ok: boolean;
  fullScreen: boolean;
  /** 谁在放铃声。`web` = 该网页那段 `<audio>` 放。 */
  tone: 'native' | 'web';
  note?: string;
}

interface DeskPhoneNative {
  /**
   * 开始响。全屏通知(fullScreenIntent)+ 震动 + 铃声(原生放,回 tone)。
   * 界面那一层由网页自己画(那样才跟得上我们的样式)。
   */
  startRinging(input: DeskPhoneRingInput): Promise<{ started?: boolean; fullScreen?: boolean; tone?: string; note?: string }>;
  /**
   * 停铃。带 `callId` 就**只停那一通**(2026-10-20,卡 E):原生自己收到的那一通铃,
   * 不许被网页解冻后为上一通补的那一下「停」顺手掐掉。不带就照旧全停(老调用方)。
   */
  stopRinging(input?: { callId?: string }): Promise<void>;
  /**
   * **原生听铃**(2026-10-20,卡 E,见 src/call/ringHandoff.ts):拿这张凭证(同一身份)进房,只听 `ring` / `ring_end`。
   * 待机服务没在跑就回 `on:false` + 一句人话 —— 那时网页别把房间让出来。凭证只在内存里,原生不存。
   */
  listenRing(input: { url: string; room: string; identity: string; token: string; expires_at: number }): Promise<{ on?: boolean; note?: string }>;
  unlistenRing(): Promise<void>;
  /**
   * 只发一条普通通知(不响、不震、不拉起来电页)。`key` 当系统通知的 tag:不同 key 各占一条,
   * 同一个 key 再发是更新那一条。老手机包没有这一件。
   */
  postNotice(input: { key: string; title: string; text: string }): Promise<{ posted?: boolean; note?: string }>;
  /** 座机模式:屏幕常亮 + 锁屏上也显示 + 来电时点亮屏幕。 */
  setDeskPhone(input: { on: boolean }): Promise<{ on?: boolean; note?: string }>;
  /** 这台机器上到底做得到哪几样(通知权限给了没有、能不能发全屏通知)。 */
  status(): Promise<{
    notifications?: boolean; banner?: boolean; fullScreen?: boolean; deskPhone?: boolean; note?: string;
    standby?: boolean; batteryUnrestricted?: boolean; vendor?: string;
    /** 原生听铃此刻的状态(卡 E;NativeRingListener.STATE_*)与原因。老包没有。 */
    nativeRing?: string; nativeRingNote?: string;
  }>;
  /** 要一次通知权限(Android 13+ 的 POST_NOTIFICATIONS)。 */
  requestNotifications(): Promise<{ granted?: boolean }>;
  /** 后台待机(前台服务)开 / 关。 */
  setStandby(input: { on: boolean }): Promise<{ on?: boolean; note?: string }>;
  /** 弹系统那个「允许在后台运行 / 忽略电池优化」的框。结果以下一次 status() 为准。 */
  requestBatteryUnrestricted(): Promise<void>;
  /** 打开厂商自己的后台设置(小米:自启动);打不开退回本应用的系统设置页。 */
  openVendorSettings(): Promise<void>;
  /** 打开「全屏通知」那一项的系统设置(Android 14+)。 */
  openFullScreenSettings(): Promise<void>;
  /** 打开通知设置:总开关关着去本应用的通知页,开着去「事务官来电」那个频道(横幅 / 悬浮通知在那儿)。 */
  openNotificationSettings(): Promise<void>;
}

const native = registerPlugin<DeskPhoneNative>('DeskPhone');

export interface DeskPhoneStatus {
  /** 通知权限给了没有。Android 13 以下恒为 true(那时压根不用要)。 */
  notifications: boolean;
  /**
   * **来电时系统顶部弹不弹得出横幅**:来电那个频道的重要程度还在「紧急」。
   * 她(或小米这类系统)把它降了,通知只进下拉栏、不往下弹 —— 后台来电就只剩铃声和震动。
   */
  banner: boolean;
  /**
   * **后台 / 锁屏时拉得起来电页吗**。Android 14 起 `USE_FULL_SCREEN_INTENT` 只对
   * 「打电话 / 闹钟」这类应用自动授予,别的要用户在设置里开 —— 开没开只有原生查得到。
   */
  fullScreen: boolean;
  /** 座机模式(常亮)这会儿开着没有。 */
  deskPhone: boolean;
  /** 一句人话:做不到的那一样为什么做不到。原样显示,不套一层。 */
  note?: string;
  /** 后台待机(前台服务)这会儿在不在跑。 */
  standby: boolean;
  /** 系统电池优化豁免了没有。豁免了,锁屏久了也不容易被断网 / 杀进程。 */
  batteryUnrestricted: boolean;
  /** 认得出来的厂商(今天只认 xiaomi —— 它的后台清理最狠,另有两项开关要她自己去开)。 */
  vendor: 'xiaomi' | null;
  /** 压根没有原生插件(浏览器里调试、或者插件没登记上)。 */
  absent: boolean;
}

/** 没有原生插件时那句话。**说清后果**:能收来电,但要 App 在前台。 */
export const DESK_PHONE_ABSENT_TEXT = '这台机器上没有座机插件(在浏览器里,或者插件没装上):App 在前台时收得到来电,锁屏或切后台时收不到';

export async function deskPhoneStatus(): Promise<DeskPhoneStatus> {
  try {
    const result = await native.status();
    return {
      notifications: result.notifications === true,
      banner: result.banner === true,
      fullScreen: result.fullScreen === true,
      deskPhone: result.deskPhone === true,
      ...(typeof result.note === 'string' && result.note !== '' ? { note: result.note } : {}),
      standby: result.standby === true,
      batteryUnrestricted: result.batteryUnrestricted === true,
      vendor: result.vendor === 'xiaomi' ? 'xiaomi' : null,
      absent: false,
    };
  } catch {
    return {
      notifications: false, banner: false, fullScreen: false, deskPhone: false, note: DESK_PHONE_ABSENT_TEXT,
      standby: false, batteryUnrestricted: false, vendor: null, absent: true,
    };
  }
}

/** 没通知权限:后台来电只有铃声和震动,顶上什么都不弹。 */
export const NO_NOTIFY_TEXT = '还没给「事务官」通知权限:在后台或锁屏时来电,顶上什么都不弹,只有铃声和震动';
/** 有权限,但来电那个频道弹不出横幅。 */
export const NO_BANNER_TEXT = '来电通知现在不会在屏幕顶部弹出来:在「事务官来电」里打开横幅(小米叫「悬浮通知」)';
/** 后台/锁屏拉不起来电页时那句话。**说清后果**,并说清去哪儿开。 */
export const NO_FULL_SCREEN_TEXT = '这台机器上还不能在锁屏时自动弹出来电页:去系统设置里给「事务官」打开「全屏通知」权限';

export interface AlertHint {
  text: string;
  action: 'notify' | 'banner' | 'fullScreen';
}

/**
 * 设置页「提醒」顶上那一行。**一次只说最要紧的那一件**:没权限时横幅、全屏都谈不上,
 * 先说权限;有权限再看横幅;横幅有了再看锁屏全屏。全做到了一行都不出。
 */
export function alertHints(status: DeskPhoneStatus): AlertHint[] {
  if (status.absent) return [];
  if (!status.notifications) return [{ text: NO_NOTIFY_TEXT, action: 'notify' }];
  if (!status.banner) return [{ text: NO_BANNER_TEXT, action: 'banner' }];
  if (!status.fullScreen) return [{ text: NO_FULL_SCREEN_TEXT, action: 'fullScreen' }];
  return [];
}

/** 开着开关、服务却没在跑。 */
export const STANDBY_OFF_TEXT = '后台待机没起来:切到别的 App 或锁屏后可能收不到电话。重开一次 App 试试';
/** 没豁免电池优化。 */
export const BATTERY_HINT_TEXT = '系统还在给「事务官」省电:锁屏久了可能断线、漏电话';
/**
 * 小米 / 红米。「自启动」和「省电策略」没有接口查得到开没开,所以只要是小米就一直挂着这一句 ——
 * 不装作查过。
 */
export const XIAOMI_HINT_TEXT = '小米手机还要两步:在「事务官」的应用设置里打开「自启动」,省电策略选「无限制」';

export interface StandbyHint {
  text: string;
  /** 这一行带一颗键:battery = 弹豁免框;vendor = 去厂商设置。 */
  action?: 'battery' | 'vendor';
}

/**
 * 设置页「后台也能接电话」下面那几行。做不到哪一样说哪一样,全做到了一行都不出。
 * 开关关着时什么都不说:不待机,豁免不豁免都叫不醒,说了只是噪音。
 */
export function standbyHints(status: DeskPhoneStatus, enabled: boolean): StandbyHint[] {
  if (status.absent || !enabled) return [];
  const hints: StandbyHint[] = [];
  if (!status.standby) hints.push({ text: STANDBY_OFF_TEXT });
  if (!status.batteryUnrestricted) hints.push({ text: BATTERY_HINT_TEXT, action: 'battery' });
  if (status.vendor === 'xiaomi') hints.push({ text: XIAOMI_HINT_TEXT, action: 'vendor' });
  return hints;
}

/**
 * 后台待机开 / 关。没有插件(浏览器里)回 `ok:false` 但**不带话**:那一句设置页上已经由
 * deskPhoneStatus 的 absent 说了,来电那一屏的 note 再说一遍只是噪音。
 */
export async function setRingStandby(on: boolean): Promise<{ ok: boolean; note?: string }> {
  try {
    const result = await native.setStandby({ on });
    return { ok: result.on === on, ...(typeof result.note === 'string' && result.note !== '' ? { note: result.note } : {}) };
  } catch {
    return { ok: false };
  }
}

export async function requestBatteryUnrestricted(): Promise<void> {
  try { await native.requestBatteryUnrestricted(); }
  catch { /* 没有插件:设置页那一行本来就不出 */ }
}

export async function openVendorSettings(): Promise<void> {
  try { await native.openVendorSettings(); }
  catch { /* 同上 */ }
}

export async function openFullScreenSettings(): Promise<void> {
  try { await native.openFullScreenSettings(); }
  catch { /* 同上 */ }
}

/**
 * 开始响。原生做不到就退回网页那条:`navigator.vibrate`(前台时够用)。
 *
 * `silent`(夜间静默那条来电、答案来找她)只发一条普通通知:走原生 `postNotice`,`callId` 当 key,
 * 各占各的一条 —— 老路那一支只有一个通知 id,新的会盖掉旧的(连座机常驻那条一起盖)。
 * 老手机包没有 `postNotice` 才退回老路。
 */
export async function startRinging(input: DeskPhoneRingInput): Promise<DeskPhoneRingResult> {
  if (input.silent) {
    try {
      const result = await native.postNotice({ key: input.callId, title: input.title, text: input.text });
      return {
        ok: result.posted !== false, fullScreen: false, tone: 'web',
        ...(typeof result.note === 'string' && result.note !== '' ? { note: result.note } : {}),
      };
    } catch { /* 老手机包:往下走老路 */ }
  }
  try {
    const result = await native.startRinging(input);
    return {
      ok: result.started !== false,
      fullScreen: result.fullScreen === true,
      tone: result.tone === NATIVE_TONE ? 'native' : 'web',
      ...(typeof result.note === 'string' && result.note !== '' ? { note: result.note } : {}),
    };
  } catch {
    vibrateInBrowser(input.silent);
    return { ok: true, fullScreen: false, tone: 'web', note: DESK_PHONE_ABSENT_TEXT };
  }
}

export async function stopRinging(callId?: string): Promise<void> {
  try { await native.stopRinging(callId === undefined || callId === '' ? undefined : { callId }); }
  catch { stopVibrateInBrowser(); }
}

/** 原生听铃回不来时那句话:多半是老手机包(没有这一件)。 */
export const NATIVE_RING_ABSENT_TEXT = '这一版手机包没有「熄屏也能接电话」那一件';

/**
 * 让原生拿这张凭证进房听铃(2026-10-20,卡 E)。凭证照原样过桥(桥上不打日志,见 capacitor.config.ts),
 * 原生只放内存里。
 */
export async function listenNativeRing(credential: { url: string; room: string; identity: string; token: string; expires_at: number }): Promise<{ ok: boolean; note?: string }> {
  try {
    const result = await native.listenRing({
      url: credential.url, room: credential.room, identity: credential.identity, token: credential.token, expires_at: credential.expires_at,
    });
    return { ok: result.on === true, ...(typeof result.note === 'string' && result.note !== '' ? { note: result.note } : {}) };
  } catch {
    return { ok: false, note: NATIVE_RING_ABSENT_TEXT };
  }
}

/** 待机服务没在跑时那句话:这时不把房间让出来。 */
export const NATIVE_RING_NOT_RUNNING_TEXT = '后台待机没在跑,熄屏后的电话没法交给系统这一侧';

/** 交之前问一句做不做得到(核查 E1):待机服务不在跑就不离房。 */
export async function nativeRingReady(): Promise<{ ok: boolean; note?: string }> {
  try {
    const status = await native.status();
    return status.standby === true ? { ok: true } : { ok: false, note: NATIVE_RING_NOT_RUNNING_TEXT };
  } catch {
    return { ok: false, note: NATIVE_RING_ABSENT_TEXT };
  }
}

/**
 * 原生听铃此刻的状态(核查 E2,交出去之后每一拍回查)。读不到(老包、没插件)回 null —— 不编一个状态。
 */
export async function nativeRingState(): Promise<{ state: string; note?: string } | null> {
  try {
    const status = await native.status();
    if (typeof status.nativeRing !== 'string' || status.nativeRing === '') return null;
    return {
      state: status.nativeRing,
      ...(typeof status.nativeRingNote === 'string' && status.nativeRingNote !== '' ? { note: status.nativeRingNote } : {}),
    };
  } catch {
    return null;
  }
}

export async function unlistenNativeRing(): Promise<void> {
  try { await native.unlistenRing(); }
  catch { /* 老包:本来就没在听 */ }
}

export async function setDeskPhoneMode(on: boolean): Promise<{ ok: boolean; note?: string }> {
  try {
    const result = await native.setDeskPhone({ on });
    return { ok: result.on === on, ...(typeof result.note === 'string' && result.note !== '' ? { note: result.note } : {}) };
  } catch {
    return { ok: false, note: DESK_PHONE_ABSENT_TEXT };
  }
}

export async function requestNotifications(): Promise<boolean> {
  try { return (await native.requestNotifications()).granted === true; }
  catch { return false; }
}

export async function openNotificationSettings(): Promise<void> {
  try { await native.openNotificationSettings(); }
  catch { /* 没有插件:设置页那一行本来就不出 */ }
}

/**
 * 要通知权限;要不到就把通知设置打开。Android 拒过两次之后**系统不再弹那个框**,
 * request 当场回「没给」—— 那时只剩她自己去设置里拨,所以直接送她过去,不让那颗键点了没反应。
 */
export async function ensureNotifications(): Promise<boolean> {
  if (await requestNotifications()) return true;
  await openNotificationSettings();
  return false;
}

/**
 * 网页那条退路的震动节奏。和原生那一份**同一个数组** —— 两处写不一样的节奏,
 * 同一台机器在前台和后台会震出两种手感。
 * 400 震 / 600 停,重复:比「嗡」一下长,听得出是在响铃而不是来了条消息。
 */
export const RING_VIBRATE_PATTERN: readonly number[] = [0, 400, 600, 400, 600, 400, 600];

function vibrateInBrowser(silent: boolean): void {
  if (silent) return;
  try { navigator.vibrate?.([...RING_VIBRATE_PATTERN]); }
  catch { /* 不支持就算了 —— 铃声那一半照样响 */ }
}

function stopVibrateInBrowser(): void {
  try { navigator.vibrate?.(0); }
  catch { /* 同上 */ }
}

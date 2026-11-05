/**
 * 录音权限(2026-09-18,Ben 真机:「没有去要录音的权限,我说话它听不到」)。
 *
 * ## 为什么要显式问,而不是靠 WebView 自己弹
 *
 * Capacitor 的 `BridgeWebChromeClient.onPermissionRequest` 确实会在网页调 `getUserMedia`
 * 时把 RECORD_AUDIO 要一遍 —— 但那是**进房、发布麦克风的那一刻**才发生的:
 * 系统弹框压在一通已经接通的电话上,开场白正说到一半。更要命的是 Android 的规矩:
 * **被拒两次之后系统再也不弹**,`getUserMedia` 从此静默失败 —— 人对着屏幕说话,她听不到,
 * 屏幕上什么都不说。那正是 Ben 看到的样子。
 *
 * 所以:**进房之前先问**,拒了就当场说清楚,并给一条「去设置里打开」的路。
 *
 * ## 两条实现,原生优先
 *
 * 1. **原生那件小插件**(`android/app/src/main/java/ai/ben/butler/MicPermissionPlugin.java`):
 *    能分清「还问得动(prompt)」和「别再问了(denied)」—— 这两句话在界面上不一样,
 *    而且只有它能把人送到系统设置那一页。
 * 2. **退路:`getUserMedia({audio:true})`**。浏览器里调试、以及万一插件没登记上时走它。
 *    它问得到权限(WebView 会转成系统弹框),但**分不清「拒了」和「没有麦克风」**,
 *    所以只在原生那条路够不着时用。拿到轨道立刻停掉:这一步只为要权限,不为录音。
 *
 * 这个文件里没有 React、没有 LiveKit:两条路都可以在测试里替换掉。
 */
import { registerPlugin } from '@capacitor/core';

/** 权限此刻的状态。**三态不合并**:「还没问过」和「问过被拒」在界面上是两句话。 */
export type MicPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown';

export interface MicPermissionResult {
  state: MicPermissionState;
  granted: boolean;
  /** 只能去系统设置里开了(被永久拒)。界面据此摆那颗「去设置里打开」。 */
  needsSettings: boolean;
  /** 走的是哪条路。写进日志/交接用,界面不显示。 */
  via: 'native' | 'getUserMedia' | 'none';
  /** 出了什么事(拿不到 mediaDevices、插件没登记上……)。原样显示,不套一层。 */
  error?: string;
}

/** 通话态上那句话。说清后果:不是「静音」那种听不到她,是**她听不见你**。 */
export const MIC_DENIED_TEXT = '没有录音权限,事务官听不到你';
/**
 * 权限给过了、麦克风却**没发出去**时那句话(2026-09-18,交接-0918-引导不理人)。
 *
 * 和上面那句**故意分成两句**:那一句的出路是「去设置里打开」,这一句的出路是重打一次 ——
 * 合成一句话就等于让人对着屏幕猜到底是哪一头。后面会跟一段原因(SDK 抛的原话)。
 */
export const MIC_PUBLISH_FAILED_TEXT = '麦克风没打开,事务官听不到你';
/** 那颗按钮上的字。 */
export const MIC_SETTINGS_LABEL = '去设置里打开';

interface MicPermissionNative {
  check(): Promise<{ state?: string; granted?: boolean }>;
  request(): Promise<{ state?: string; granted?: boolean }>;
  openSettings(): Promise<void>;
}

/**
 * 原生那件插件。**`registerPlugin` 本身不会抛** —— 没有实现时是调它的方法才抛,
 * 所以下面每一次调用都包在 try 里,拿不到就退回 getUserMedia 那条路。
 */
const NativeMicPermission = registerPlugin<MicPermissionNative>('MicPermission');

export interface MicPermissionDeps {
  /** 测试注入假的原生插件;传 null 表示这台机器上没有原生那条路。 */
  native?: MicPermissionNative | null;
  /** 测试注入假的 getUserMedia;传 null 表示这台机器上连它也没有。 */
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
}

function stateOf(raw: { state?: string; granted?: boolean } | undefined): MicPermissionState {
  if (raw?.granted === true) return 'granted';
  const text = typeof raw?.state === 'string' ? raw.state.toLowerCase() : '';
  if (text === 'granted') return 'granted';
  if (text === 'denied') return 'denied';
  if (text === 'prompt' || text === 'prompt-with-rationale') return 'prompt';
  return 'unknown';
}

function defaultGetUserMedia(): ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null {
  const devices = globalThis.navigator?.mediaDevices;
  if (devices === undefined || typeof devices.getUserMedia !== 'function') return null;
  return (constraints) => devices.getUserMedia(constraints);
}

/**
 * 问一次录音权限。**在进房之前调** —— 弹框不该压在一通已经接通的电话上。
 *
 * 绝不抛:这一步失败只是「这一通她听不到你」,不该把电话本身弄没。
 */
export async function ensureMicPermission(deps: MicPermissionDeps = {}): Promise<MicPermissionResult> {
  const native = deps.native === undefined ? NativeMicPermission : deps.native;
  if (native !== null) {
    try {
      const checked = await native.check();
      if (stateOf(checked) === 'granted') return { state: 'granted', granted: true, needsSettings: false, via: 'native' };
      const asked = await native.request();
      const state = stateOf(asked);
      return {
        state,
        granted: state === 'granted',
        // 「别再问了」才给设置那条路:还问得动的时候送人去设置页是多此一举。
        needsSettings: state === 'denied',
        via: 'native',
      };
    } catch {
      // 插件没登记上(装的是旧包、或者跑在浏览器里):退回下面那条,不在这儿放弃。
    }
  }

  const getUserMedia = deps.getUserMedia === undefined ? defaultGetUserMedia() : deps.getUserMedia;
  if (getUserMedia === null) {
    return {
      state: 'unknown',
      granted: false,
      needsSettings: false,
      via: 'none',
      error: '这台设备上取不到麦克风(没有 mediaDevices)',
    };
  }
  try {
    const stream = await getUserMedia({ audio: true });
    // 只为要权限,不为录音:拿到就停,别让红点一直亮着。
    for (const track of stream.getTracks?.() ?? []) { try { track.stop(); } catch { /* 停不掉也不影响权限 */ } }
    return { state: 'granted', granted: true, needsSettings: false, via: 'getUserMedia' };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? '';
    // NotAllowedError = 人拒了(或者系统早就不弹了);别的(没有麦克风一类)不该被说成「去设置里打开」。
    const denied = name === 'NotAllowedError' || name === 'SecurityError';
    return {
      state: denied ? 'denied' : 'unknown',
      granted: false,
      needsSettings: denied,
      via: 'getUserMedia',
      error: error instanceof Error && error.message !== '' ? error.message : '取不到麦克风',
    };
  }
}

/** 打开本应用在系统设置里的那一页。打不开就如实回一句,界面原样显示。 */
export async function openMicSettings(deps: MicPermissionDeps = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const native = deps.native === undefined ? NativeMicPermission : deps.native;
  if (native === null) return { ok: false, error: '这台设备上打不开系统设置(只有手机上的 App 能)' };
  try {
    await native.openSettings();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message !== '' ? error.message : '打不开系统设置' };
  }
}

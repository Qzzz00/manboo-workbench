/**
 * **熄屏 / 后台时把「听铃」交给原生**(2026-10-20,卡 E;实测见 docs/交接-1020-Pixel熄屏响铃实测.md)。
 *
 * 为什么:熄屏约 5 分钟后 WebView 这一页被 Chromium 冻住 —— 进程、前台服务、唤醒锁、房间信令都还在,
 * 可房间里来的 `ring` 没人读,电话一声不响。原生前台服务(RingStandbyService)不受这一条冻结管,
 * 所以由它在这段时间里进房听铃、收到就直接响(android/.../NativeRingListener.kt)。
 *
 * 为什么是「交接」而不是两条同时在房:原生用的是**同一个身份、同一张凭证**(凭证只有网页这一份,
 * 原生只在内存里借用)。LiveKit 同一身份的第二条连接会把第一条踢掉,所以:
 *
 *   熄屏 ≥ 宽限期,且只守着铃(出门时还有远程那份)→ ① 网页那条**停靠**(离房、记着持有)→ ② 原生进房;
 *   原生进不去 → 当场收回网页那条,并如实说一句;
 *   亮屏回来 / 要打电话 → ① 原生离房 → ② 网页收回进房(工人见手机进房会把还在响的那一通补发一次,
 *   原生那边对同一通**不重响**,见 DeskPhonePlugin 的 startRinging 与 RingBook.kt)。
 *
 * 不交的几种:页面看得见;通话 / 发文件 / 取文件那几份持有在(一交就把这通电话从房里拿走);
 * 界面在通话页 / 话筒通话页(busy);待机开关关着(原生没在跑,交出去就没人听);凭证没有或快过期。
 */
import type { WbchCredential } from '../channel/credentialStore';
import { WBCH_PARKABLE_HOLDERS } from '../channel/roomLink';

/**
 * 熄屏多久才交(毫秒)。实测熄屏 30 秒内网页照样响、5 分半就聋了;10 秒足够躲开
 * 「按一下电源键又点亮」那种来回,又远在冻结之前(冻结前网页的定时器还按秒走)。
 */
export const RING_HANDOFF_GRACE_MS = 10_000;

/**
 * 凭证至少还要剩多久才交(秒)。原生那一侧换不了凭证(换凭证要网页那条路),
 * 快过期的那张交过去,断线重连时就进不去了 —— 不如留在网页这边,等亮屏时续上。
 */
export const RING_HANDOFF_MIN_TOKEN_S = 30 * 60;

export interface RingHandoffInputs {
  visible: boolean;
  /** 已经看不见多久了(毫秒)。看得见时随意。 */
  hiddenForMs: number;
  /** 设置里「切到别的 App 或锁屏时也能接电话」开着。 */
  standby: boolean;
  /** 界面在通话页 / 话筒通话页。 */
  busy: boolean;
  holders: readonly string[];
  credential: WbchCredential | null;
  nowMs: number;
}

export function ringHandoffWanted(input: RingHandoffInputs): boolean {
  if (input.visible) return false;
  if (input.hiddenForMs < RING_HANDOFF_GRACE_MS) return false;
  if (!input.standby || input.busy) return false;
  if (!input.holders.includes('ring')) return false;
  if (input.holders.some((holder) => !WBCH_PARKABLE_HOLDERS.has(holder))) return false;
  const credential = input.credential;
  if (credential === null) return false;
  return credential.expires_at - input.nowMs / 1000 >= RING_HANDOFF_MIN_TOKEN_S;
}

/**
 * 交不上之后多久再试(毫秒)。离房 / 进房是真的进出房间,待机服务没在跑(Android 12+ 不许从后台起前台服务)
 * 是常有的事 —— 不退避就是熄屏期间每 2 秒进出房一次。亮一下屏再熄就清零,不必等满。
 */
export const RING_HANDOFF_RETRY_MS = 60_000;

/**
 * 刚交出去这么久之内,原生回「off」不算它没了(毫秒):listen 回来时它还在主线程上排着起,
 * 那一瞬间读到的 off 是「还没起」,不是「被停了」。
 */
export const RING_HANDOFF_STARTUP_MS = 5_000;

/** 原生听铃那几个「还活着」的状态(NativeRingListener.STATE_*):在听、在连、在重连,都算它自己会修好。 */
export const NATIVE_RING_ALIVE_STATES: ReadonlySet<string> = new Set(['connecting', 'listening', 'reconnecting', 'retrying']);

/** 原生那一头(src/deskphone/deskPhone.ts 的 listenNativeRing / unlistenNativeRing / nativeRingReady / nativeRingState)。 */
export interface NativeRingPort {
  listen(credential: WbchCredential): Promise<{ ok: boolean; note?: string }>;
  unlisten(): Promise<void>;
  /**
   * 交之前先问一句做不做得到(待机服务在不在跑)。做不到就不离房 —— 停靠是真离房。
   * 可缺:缺了就直接试 listen(交不上再收回,同样退避)。
   */
  canListen?(): Promise<{ ok: boolean; note?: string }>;
  /** 交出去之后每一拍回查:原生此刻的状态与原因。可缺:缺了就不回查。 */
  listenState?(): Promise<{ state: string; note?: string } | null>;
}

/** 房间那一层用得到的那几样(roomLink 的可缺方法,在这里是必需的)。 */
export interface ParkableLink {
  heldBy(): readonly string[];
  parked(): boolean;
  park(): Promise<void>;
  unpark(credential: WbchCredential): Promise<void>;
}

export interface RingHandoffDeps {
  link: ParkableLink;
  native: NativeRingPort;
  credential(): WbchCredential | null;
  visible(): boolean;
  standby(): boolean;
  busy(): boolean;
  now?: () => number;
  /** 交不出去时那一句(原生回的原话);交上了 / 收回来了给 null。 */
  onNote?: (text: string | null) => void;
}

export type RingHandoffMode = 'web' | 'native';

export interface RingHandoff {
  /** 看一眼该不该交 / 该不该收,该做就做。并发调用合成一次。 */
  update(): Promise<void>;
  mode(): RingHandoffMode;
  /** 页面没了:交出去的收回来。 */
  dispose(): Promise<void>;
}

/** 原生交不上时那句话的前缀。原话跟在后面。 */
export const RING_HANDOFF_FAILED_TEXT = '熄屏后的电话没交给系统那一侧,熄屏久了可能接不到';

export function createRingHandoff(deps: RingHandoffDeps): RingHandoff {
  const now = deps.now ?? (() => Date.now());
  let mode: RingHandoffMode = 'web';
  let hiddenSince: number | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  /**
   * 第一次之前先让原生放手一次:这一页可能是重开的(Activity 被系统收过、进程还在),
   * 原生那条还在房里 —— 不说一声,网页一进房就把它踢下去,中间那一下谁也不在。
   */
  let primed = false;
  /** 交不上 / 原生放弃之后,这个时刻之前不再交(见 {@link RING_HANDOFF_RETRY_MS})。看得见页面就清零。 */
  let blockedUntil = 0;
  /** 交出去的时刻(见 {@link RING_HANDOFF_STARTUP_MS})。 */
  let handedAt = 0;

  function fail(note: string | undefined): void {
    blockedUntil = now() + RING_HANDOFF_RETRY_MS;
    deps.onNote?.(`${RING_HANDOFF_FAILED_TEXT}${note === undefined || note === '' ? '' : `:${note}`}`);
  }

  async function takeBack(): Promise<void> {
    mode = 'web';
    await deps.native.unlisten().catch(() => {});
    const back = deps.credential();
    if (back !== null) await deps.link.unpark(back).catch(() => {});
  }

  async function step(): Promise<void> {
    if (!primed) {
      primed = true;
      await deps.native.unlisten().catch(() => {});
    }
    const visible = deps.visible();
    if (visible) { hiddenSince = null; blockedUntil = 0; }
    else if (hiddenSince === null) hiddenSince = now();

    // 网页那边有人自己拿回了房间(一通电话要进房):原生那一条已被同一身份踢下,这里补一句放手。
    if (mode === 'native' && !deps.link.parked()) {
      mode = 'web';
      await deps.native.unlisten().catch(() => {});
      return;
    }

    /**
     * 交出去之后回查(核查 E2):原生放弃了(被请出房间、凭证到期)或者已经没了(服务被杀),
     * 网页不能一直停靠着 —— 那样两边都聋。收回来,如实说,并退避(别立刻又交进一个修不好的原生)。
     */
    if (mode === 'native' && !visible && deps.native.listenState !== undefined) {
      const live = await deps.native.listenState().catch(() => null);
      const settled = now() - handedAt >= RING_HANDOFF_STARTUP_MS;
      if (live !== null && !NATIVE_RING_ALIVE_STATES.has(live.state) && (live.state !== 'off' || settled)) {
        await takeBack();
        fail(live.note);
        return;
      }
    }

    const credential = deps.credential();
    const want = ringHandoffWanted({
      visible,
      hiddenForMs: hiddenSince === null ? 0 : now() - hiddenSince,
      standby: deps.standby(),
      busy: deps.busy(),
      holders: deps.link.heldBy(),
      credential,
      nowMs: now(),
    });

    if (want && mode === 'web' && credential !== null && now() >= blockedUntil) {
      // 先问做不做得到:做不到就不离房(核查 E1)。
      if (deps.native.canListen !== undefined) {
        const ready = await deps.native.canListen().catch(() => ({ ok: false, note: '没有原生插件' }));
        if (!ready.ok) { fail(ready.note); return; }
      }
      // 先让出来,再让原生进:反过来会是原生把网页踢下,网页解冻后又把原生踢下。
      await deps.link.park();
      const listened = await deps.native.listen(credential).catch((error: unknown) => ({
        ok: false,
        note: error instanceof Error && error.message !== '' ? error.message : '没有原生插件',
      }));
      if (listened.ok) {
        mode = 'native';
        handedAt = now();
        deps.onNote?.(null);
        return;
      }
      await deps.link.unpark(credential).catch(() => {});
      fail(listened.note);
      return;
    }

    if (!want && mode === 'native') await takeBack();
  }

  async function update(): Promise<void> {
    if (running !== null) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await step(); } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    update,
    mode: () => mode,
    async dispose() {
      if (running !== null) await running.catch(() => {});
      if (mode !== 'native') return;
      await takeBack();
    },
  };
}

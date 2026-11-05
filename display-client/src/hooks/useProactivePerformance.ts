import { useCallback, useEffect, useRef, useState } from 'react';
import { getBaseUrl, getStoredToken, getDeviceId } from '../lib/apiClient.ts';
import { connectJourneyStream } from '../lib/journeySse.ts';
import { fetchProactiveSince, markProactiveSeen } from '../lib/proactiveApi.ts';
import { setLifeSigns, addNotification, addUnread, fetchCurrentBeat } from '../lib/journeyStore.ts';
import { applyProactiveEvent, normalizeLastSeenSeconds, runProactiveCatchUp } from '../lib/proactiveActions.ts';
import { fetchClientFlags, postCallResult } from '../lib/touchApi.ts';
import { createTouchCoordinator } from '../lib/touchCoordinator.ts';
import type { TouchEvent } from '../lib/touchRouter.ts';
import type { TouchBannerEvent } from '../components/TouchBanner.tsx';
import { getAvatarById } from '../features/live2d/avatarData.ts';
import { shouldPerformProactive, shouldTriggerCatchUpOnReady, claimPerformIfAllowed } from './proactiveVisibilityGate.ts';

/**
 * 前台 banner 是否该响一次提示音：角色配置了 notifySoundUrl（非空字符串）才播，
 * 否则静音（等价现状）。纯判定，不含播放副作用，供测试直接调用。
 */
export function shouldPlayNotifySound(url?: string): boolean {
  return typeof url === 'string' && url.length > 0;
}

// ---- ALL-439：pendingSeen 持久化 + 补演开发日志 ----
const PENDING_SEEN_KEY = 'proactive:pendingSeen';
const PROACTIVE_DEBUG_KEY = 'proactive:debug';

/**
 * 已演出但 markSeen 未成功的 proactive id（跨会话持久化）：网络失败/App 中途退出后，
 * 下次启动只对这些 id 重试 markSeen，不再重复演出。读取异常一律当空集，不阻断补拉。
 */
function readPendingSeen(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writePendingSeen(ids: string[]): void {
  try {
    localStorage.setItem(PENDING_SEEN_KEY, JSON.stringify(ids));
  } catch {
    /* 存储不可用（隐私模式/满）时降级为仅会话级去重，不阻断主流程 */
  }
}

/**
 * 补演链路开发日志：只记 id/时间戳/门状态/markSeen 结果，不记聊天正文。
 * 开发构建默认可见；生产构建需显式 localStorage `proactive:debug=1`，普通用户不可见。
 */
function logProactiveDebug(event: string, info: Record<string, unknown>): void {
  try {
    if (!(import.meta.env?.DEV || localStorage.getItem(PROACTIVE_DEBUG_KEY) === '1')) return;
    console.debug(`[proactive] ${event}`, info);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 前台 banner 提示音的一次性播放：node/测试环境无 Audio 全局，用 typeof 守卫跳过；
 * play() 的 Promise 拒绝（自动播放策略等）吞掉，不打断 banner 展示流程。
 */
function playNotifySoundIfAny(url?: string): void {
  if (!shouldPlayNotifySound(url)) return;
  if (typeof Audio === 'undefined') return;
  try {
    void new Audio(url).play().catch(() => {});
  } catch {
    /* 构造失败（非法 URL 等）静默忽略，不影响 banner */
  }
}

/**
 * 「此刻能否替用户出声」：后台标签（visibilityState !== 'visible'）或 App 演出未就绪
 * （performanceReady=false，ALL-434 冷启动/登录/切角色期间）都不 performProactive，
 * 避免后端广播到多设备时非前台的设备跟着开口、或 App 还没进聊天就提前出声。
 * 判定核心委托纯函数 shouldPerformProactive，便于单测。node/SSR 无 document 时视为可见
 * （放行），保持既有行为。只门「出声」；记录类副作用（未读/消息/refresh）在别处照常触发，
 * 不经此门。
 */
function canPerformProactiveNow(performanceReady: boolean): boolean {
  if (typeof document === 'undefined') return true;
  return shouldPerformProactive(document.visibilityState, performanceReady);
}

/** 来电浮层事件：mode 决定挂原地浮层还是全屏来电页。 */
export interface ProactiveCallEvent {
  id: string;
  avatarId: string;
  title?: string;
  mode: 'inplace' | 'fullscreen';
  portraitUrl?: string;
  ringtoneUrl?: string;
}

interface Opts {
  authUser: unknown | null;
  selectedAvatarId: string;
  /** useCall 的 callOpen —— getCtx 判定 inCall。 */
  callOpen: boolean;
  /** callSettings.enabled —— getCtx 判定 callEnabled（关则来电改回报未接）。 */
  callEnabled: boolean;
  refreshMessages: (avatarId: string) => void;
  performProactive: (content: string, emotion: string | undefined, intensity: number | undefined, messageId: string) => void;
  /**
   * 主动演出「就绪」门（ALL-434）：App 冷启动/启动页/鉴权加载/切角色过渡期间为 false，
   * 此时即使页面可见也不出声补演、不 mark seen、不推进 lastSeen；false→true 时自动补
   * 一次 catchUp。缺省 true 保持旧行为（仅可见性门控）。
   */
  performanceReady?: boolean;
}

export interface UseProactivePerformanceResult {
  /** 画外消息横幅事件（null=隐藏）。 */
  bannerEvent: TouchBannerEvent | null;
  /** 收起横幅（TouchBanner 的 onDismiss，稳定引用）。 */
  clearBanner: () => void;
  /** 来电浮层事件（null=隐藏）。 */
  callEvent: ProactiveCallEvent | null;
  /** 卸载来电 UI（接/挂/超时三路径都要调，防止复活）。 */
  clearCall: () => void;
  /** 来电落定后通知 coordinator 解除 ringing，放行后续来电。 */
  callResolved: () => void;
}

export function useProactivePerformance({
  authUser,
  selectedAvatarId,
  callOpen,
  callEnabled,
  refreshMessages,
  performProactive,
  performanceReady,
}: Opts): UseProactivePerformanceResult {
  const avatarRef = useRef(selectedAvatarId);
  avatarRef.current = selectedAvatarId;
  // 持久化 lastSeen（秒）：避免每次启动都从 since=0 重放历史 proactive。服务端 created_at
  // 是 unix 秒，这里统一秒级存取；旧版本误存的毫秒值由 normalizeLastSeenSeconds 转秒。
  // 首次无记录用 0：以「delivered + seen_at IS NULL」的未看剧情 beat 为主，不依赖
  // since=current，避免离线期间已投递未看的 beat 因毫秒/秒单位错配被跳过（ALL-432）。
  const LAST_SEEN_KEY = 'proactive:lastSeen';
  const lastSeenRef = useRef<number>(0);
  if (lastSeenRef.current === 0) {
    const stored = Number(localStorage.getItem(LAST_SEEN_KEY));
    lastSeenRef.current = normalizeLastSeenSeconds(stored);
  }
  // 会话内已演出过的 proactive 行 id：防实时 SSE 与补拉、以及重复补拉对同一行重复开口。
  const performedIdsRef = useRef<Set<string>>(new Set());
  // 补拉入口的稳定引用：visibilitychange 与「切换角色」两处都调用最新的 catchUp。
  const catchUpRef = useRef<() => void>(() => {});
  const skipInitialAvatarCatchUp = useRef(true);
  // 补拉进行中锁：挂载/登录/切角色可能并发触发 catchUp，避免同一批 beat 被演出两次。
  const catchUpInFlightRef = useRef(false);
  // 用 ref 镜像回调/上下文，避免每次 render 新引用触发 SSE 重订阅，也让 coordinator 保持稳定单例
  const performProactiveRef = useRef(performProactive);
  performProactiveRef.current = performProactive;
  const refreshMessagesRef = useRef(refreshMessages);
  refreshMessagesRef.current = refreshMessages;
  const callOpenRef = useRef(callOpen);
  callOpenRef.current = callOpen;
  const callEnabledRef = useRef(callEnabled);
  callEnabledRef.current = callEnabled;
  // ALL-434：App 演出就绪门（冷启动/登录/切角色期间 false）。ref 镜像，coordinator 与
  // SSE 回调经 canPerformProactiveNow 实时读它；缺省 true 保持旧行为（仅可见性门控）。
  const performanceReadyRef = useRef(performanceReady !== false);
  performanceReadyRef.current = performanceReady !== false;
  // ALL-434：就绪门边沿追踪（null=首次渲染），驱动下方 false→true 补拉。
  const prevPerformanceReadyRef = useRef<boolean | null>(null);
  // 应用内触达开关：登录会话建立后拉取，异步到达后写 ref（不放 state，避免重订阅）。
  const flagRef = useRef(false);

  const [bannerEvent, setBannerEvent] = useState<TouchBannerEvent | null>(null);
  const [callEvent, setCallEvent] = useState<ProactiveCallEvent | null>(null);

  // coordinator 稳定单例：sinks 只碰稳定 setter / 模块函数 / ref，getCtx 全走 ref 实时读。
  const coordRef = useRef<ReturnType<typeof createTouchCoordinator> | null>(null);
  if (!coordRef.current) {
    coordRef.current = createTouchCoordinator(
      {
        // 后台标签静默：只门「出声」，coordinator 的记录类出口（markUnread 等）在各自 sink 照常。
        // 同一 proactive 行只演出一次（ALL-432）：会话内已演出过的 id 直接跳过，防实时/补拉并发重复开口。
        perform: (e) => {
          // ALL-434：gate 关闭（后台/App 未就绪）时不演出、不占 performed，保留补演机会。
          if (!claimPerformIfAllowed(canPerformProactiveNow(performanceReadyRef.current), e.id, performedIdsRef.current)) return;
          performProactiveRef.current(e.content || '', e.emotion, e.intensity, e.id);
        },
        showBanner: (e) => {
          setBannerEvent({ avatarId: e.avatarId, title: e.title, content: e.content, portraitUrl: e.portraitUrl, notifySoundUrl: e.notifySoundUrl });
          // 提示音优先事件自带的（远端/非当前角色也带得到），缺省时回落到本地 avatar 配置。
          playNotifySoundIfAny(e.notifySoundUrl ?? getAvatarById(e.avatarId)?.notifySoundUrl);
        },
        startInplaceCall: (e) => setCallEvent({ id: e.id, avatarId: e.avatarId, title: e.title, mode: 'inplace', portraitUrl: e.portraitUrl, ringtoneUrl: e.ringtoneUrl }),
        startFullscreenCall: (e) => setCallEvent({ id: e.id, avatarId: e.avatarId, title: e.title, mode: 'fullscreen', portraitUrl: e.portraitUrl, ringtoneUrl: e.ringtoneUrl }),
        reportMissed: (e) => {
          void postCallResult(e.avatarId, e.id, 'timeout');
          refreshMessagesRef.current(e.avatarId);
        },
        markUnread: (e) => addUnread(e.avatarId),
      },
      () => ({
        flagEnabled: flagRef.current,
        currentAvatarId: avatarRef.current,
        inCall: callOpenRef.current,
        callEnabled: callEnabledRef.current,
      }),
    );
  }

  const clearBanner = useCallback(() => setBannerEvent(null), []);
  const clearCall = useCallback(() => setCallEvent(null), []);
  const callResolved = useCallback(() => coordRef.current?.callResolved(), []);

  // 随 authUser 拉 flag：hook 在登录门前就挂载，若只在挂载拉一次，新登录会话会因 401
  // 让 flag 恒 false（须重启才生效）。改为 authUser 变化即重拉；登出置回 false。
  // 失败静默返回 false（touchApi 已兜底）。
  useEffect(() => {
    let alive = true;
    if (!authUser) {
      flagRef.current = false;
      return () => { alive = false; };
    }
    void fetchClientFlags().then((f) => {
      if (alive) flagRef.current = f.inAppTouch;
    });
    return () => {
      alive = false;
    };
  }, [authUser]);

  // 卸载时解除 coordinator（重置 ringing）。单独 unmount-only effect，不随 SSE 重连一起触发。
  useEffect(() => () => coordRef.current?.dispose(), []);

  // 会话开始 / avatar 切换时拉取当前节拍并缓存。
  useEffect(() => {
    if (!authUser || !selectedAvatarId) return;
    void fetchCurrentBeat(selectedAvatarId);
  }, [authUser, selectedAvatarId]);

  useEffect(() => {
    if (!authUser) return;
    const coord = coordRef.current!;
    const deps = {
      setLifeSigns,
      addNotification,
      refreshMessages,
      // 稳定包装：SSE 回调始终调用最新的 performProactive，但不把它列入依赖数组。
      // 后台标签静默：只门「出声」；applyProactiveEvent 里的记录副作用（setLifeSigns/
      // addNotification）在此包装之外先行触发，均不受门控影响。
      // 同一 proactive 行只演出一次（ALL-432）：会话内已演出过的 messageId 直接跳过。
      performProactive: (content: string, emotion: string | undefined, intensity: number | undefined, messageId: string) => {
        // ALL-434：gate 关闭（后台/App 未就绪）时不演出、不占 performed。
        if (!claimPerformIfAllowed(canPerformProactiveNow(performanceReadyRef.current), messageId, performedIdsRef.current)) return;
        performProactiveRef.current(content, emotion, intensity, messageId);
      },
    };

    // 实时 SSE 与上线补拉共用的「主动剧情行」分发入口：flag 开启时归一成 TouchEvent
    // 交给 coordinator（由 router 决定演出/横幅/静默），关闭时走旧路径直接 perform。
    // catchUp 复用同一入口（live=true），保证「实时能说，补拉也能说」，而非只刷新列表。
    // ALL-439：返回处置结果（perform/banner/silent/ignored/...），补拉链路据此决定能否 seen。
    const dispatchProactive = (event: string, data: Record<string, unknown>) =>
      applyProactiveEvent(
        { event, data },
        avatarRef.current,
        { ...deps, flagEnabled: flagRef.current, pushTouch: (te: TouchEvent) => coord.push(te) },
        true,
      );

    const conn = connectJourneyStream({
      getBaseUrl, getToken: getStoredToken, getDeviceId,
      // flagEnabled / pushTouch 在事件触发时现读 flagRef（异步 flag 到达后即生效），
      // 不把 flag 捕进 deps 静态值 —— 避免挂载早于 flag 返回导致的路由错判。
      onEvent: (e) => dispatchProactive(e.event, e.data),
    });

    // 上线补拉：拉到当前 avatar 未 seen 的已触发剧情 beat，走主动演出路径让角色说出来。
    async function catchUp() {
      if (catchUpInFlightRef.current) return;
      catchUpInFlightRef.current = true;
      try {
        const avatarId = avatarRef.current;
        await fetchCurrentBeat(avatarId);
        await runProactiveCatchUp(avatarId, {
          fetchSince: (a, s) => fetchProactiveSince(a, s),
          markSeen: (a, ids) => markProactiveSeen(a, ids),
          // 与实时 SSE 同一表现路径：live=true 演出（内部已按可见性+就绪门控出声）。
          // ALL-439：silent（通话中被静默）/ignored（拉取后切角色的竞态）= 用户未感知，
          // 返回 false → 本次不 seen、不推进 lastSeen，保留补演机会。
          applyMessage: (m) => {
            const outcome = dispatchProactive('proactive', { ...m, avatarId });
            const perceived = outcome !== 'silent' && outcome !== 'ignored';
            logProactiveDebug('dispatch', {
              avatarId, proactiveId: m.id, beatId: m.beatId, createdAt: m.createdAt,
              lastSeen: lastSeenRef.current, readyGate: performanceReadyRef.current, outcome, perceived,
            });
            return perceived;
          },
          visibilityAllowed: () => canPerformProactiveNow(performanceReadyRef.current),
          getLastSeen: () => lastSeenRef.current,
          setLastSeen: (v) => {
            lastSeenRef.current = v;
            localStorage.setItem(LAST_SEEN_KEY, String(v));
          },
          performed: performedIdsRef.current,
          getPendingSeen: readPendingSeen,
          setPendingSeen: writePendingSeen,
          log: logProactiveDebug,
        });
      } catch { /* 网络抖动忽略，下次可见再补 */ } finally {
        catchUpInFlightRef.current = false;
      }
    }
    catchUpRef.current = catchUp;
    const onVis = () => { if (document.visibilityState === 'visible') void catchUpRef.current(); };
    document.addEventListener('visibilitychange', onVis);

    return () => { document.removeEventListener('visibilitychange', onVis); conn.close(); };
  }, [authUser, refreshMessages]); // performProactive 已通过 ref 稳定，不放入依赖数组

  // ALL-434：演出就绪门「首次满足」时补一次 catchUp（取代原先挂载即补——冷启动期
  // gate=false 时补拉会被内部自检拦下，改由这里等就绪后触发）。挂载即就绪（prev=null）
  // 也补一次，覆盖「gate 在 mount 已为 true」的登录完成场景；就绪态未变化不重复触发。
  useEffect(() => {
    const ready = performanceReady !== false;
    if (shouldTriggerCatchUpOnReady(prevPerformanceReadyRef.current, ready)) {
      void catchUpRef.current();
    }
    prevPerformanceReadyRef.current = ready;
  }, [performanceReady]);

  // 切换角色（且页面可见）时补拉该角色未 seen 的已触发 beat 并演出：
  // 满足「用户进入对应角色聊天时，角色主动说出该 beat」。首次挂载的补拉由上面的
  // 就绪门 effect 完成，这里跳过；非当前角色不会冒充当前角色开口（补拉按 avatar 隔离）。
  useEffect(() => {
    if (skipInitialAvatarCatchUp.current) {
      skipInitialAvatarCatchUp.current = false;
      return;
    }
    if (!authUser || !selectedAvatarId) return;
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void catchUpRef.current();
  }, [authUser, selectedAvatarId]);

  return { bannerEvent, clearBanner, callEvent, clearCall, callResolved };
}

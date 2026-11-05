import type { JourneyNotification, JourneyLifeSigns, CurrentBeat } from '../types/journey.ts';
import { setCurrentBeat } from './journeyStore.ts';
import type { TouchAction, TouchEvent, TouchTier } from './touchRouter.ts';
import type { ProactiveMessage } from './proactiveApi.ts';

export interface ProactiveDeps {
  setLifeSigns(ls: JourneyLifeSigns): void;
  addNotification(n: JourneyNotification): void;
  refreshMessages(avatarId: string): void;
  performProactive(content: string, emotion: string | undefined, intensity: number | undefined, messageId: string): void;
  /**
   * 应用内触达开关（client-flags 的 inAppTouch）。开启且 live 时，proactive/proactive_call
   * 事件的「可见分发」改走 coordinator（见 pushTouch）；由 router 内部决定演出/横幅/来电/静默。
   * 缺省（关闭）时下方逻辑逐字节保持旧行为，flag 语义完全由 router 承担，此处不额外包判断。
   */
  flagEnabled?: boolean;
  /** flag 开启时的分发出口 = createTouchCoordinator 的 push（返回路由动作，ALL-439）。 */
  pushTouch?(e: TouchEvent): TouchAction | void;
}

/**
 * proactive 事件的处置结果（ALL-439）：补拉链路据此判断「用户是否真的能感知到这条消息」，
 * 只有可感知（perform/banner/refresh/report-missed/call-*）才允许 markSeen；
 * 'silent'（通话中静默等）与 'ignored'（非当前角色）视为未感知，保留补演机会。
 * undefined = 非 proactive 类事件，无处置语义。
 */
export type ProactiveOutcome = TouchAction['type'] | 'refresh' | 'ignored' | undefined;

export function applyProactiveEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  e: { event: string; data: any },
  currentAvatarId: string,
  deps: ProactiveDeps,
  live = true,
): ProactiveOutcome {
  const d = e.data || {};
  const now = Math.floor(Date.now() / 1000);

  // flag 开启 + 实时事件（catchUp 的 live=false 补拉保持原样，不进 coordinator）：
  // 把 proactive / proactive_call 归一成 TouchEvent 交给 coordinator，由 router 决策四出口。
  if (deps.flagEnabled && live && deps.pushTouch) {
    if (e.event === 'proactive') {
      if (d.lifeSigns) deps.setLifeSigns(d.avatarId ? { ...d.lifeSigns, avatarId: d.avatarId } : d.lifeSigns); // 生命迹象与触达分发正交，照常更新；带上事件顶层 avatarId 供 App 跨角色过滤（ALL-425）
      const action = deps.pushTouch({
        kind: 'message',
        tier: (d.tier as TouchTier) || 'daily',
        id: d.id || `beat_${Date.now()}`,
        avatarId: d.avatarId,
        content: d.content,
        emotion: d.emotion,
        intensity: d.intensity,
        title: d.title,
        createdAt: d.createdAt,
        portraitUrl: d.portraitUrl,
        notifySoundUrl: d.notifySoundUrl,
      });
      return action ? action.type : undefined;
    }
    if (e.event === 'proactive_call') {
      const action = deps.pushTouch({
        kind: 'call',
        tier: (d.tier as TouchTier) || 'daily',
        id: d.id || `call_${Date.now()}`,
        avatarId: d.avatarId,
        title: d.title,
        createdAt: d.createdAt,
        portraitUrl: d.portraitUrl,
        ringtoneUrl: d.ringtoneUrl,
      });
      return action ? action.type : undefined;
    }
    // life_signs / ending 等其余事件照旧走下方逻辑
  }

  if (e.event === 'proactive') {
    // 写入全局 lifeSigns 槽时带上事件顶层 avatarId（ALL-425）：缺省时不补字段，保持原行为。
    if (d.lifeSigns) deps.setLifeSigns(d.avatarId ? { ...d.lifeSigns, avatarId: d.avatarId } : d.lifeSigns);
    deps.addNotification({
      id: d.id || `beat_${Date.now()}`,
      type: 'beat',
      title: d.title || '主动消息',
      body: d.content || '',
      createdAt: d.createdAt || now,
    });
    if (d.avatarId && d.avatarId === currentAvatarId) {
      if (live) {
        deps.performProactive(d.content || '', d.emotion, d.intensity, d.id || `beat_${Date.now()}`);
        return 'perform';
      }
      deps.refreshMessages(d.avatarId);
      return 'refresh';
    }
    return 'ignored';
  } else if (e.event === 'beat_change') {
    const beat = d.beat as CurrentBeat | null;
    const avatarId = d.avatarId as string | undefined;
    if (avatarId) {
      setCurrentBeat(avatarId, beat ?? null);
    }
  } else if (e.event === 'life_signs') {
    deps.setLifeSigns(d as JourneyLifeSigns);
  } else if (e.event === 'ending') {
    deps.addNotification({
      id: d.id || `ending_${Date.now()}`,
      type: 'farewell',
      title: d.title || '旅程结束',
      body: d.content || '',
      createdAt: d.createdAt || now,
    });
  }
}

// ---- 上线补拉已触发剧情 beat（ALL-432）----
// 服务端 journey_proactive_messages.created_at 是 unix 秒；旧版本客户端把 Date.now()
// 毫秒存进 proactive:lastSeen，?since=ms 与秒级 created_at 比较恒为「跳过全部历史」，
// 导致离线期间已投递未看的 beat 补不到。这里把 >1e11 的历史误存毫秒转成秒；无记录/非法
// 一律 0 —— 首次启动以服务端「delivered + seen_at IS NULL」过滤为准，不依赖 since=current。
export function normalizeLastSeenSeconds(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v > 1e11 ? Math.floor(v / 1000) : v;
}

/**
 * 积压补拉只挑一条：未 seen 的 delivered beat 多条积压时，返回「时间正序第一条」
 * （最早触发的那条）作为本次演出目标；其余留在服务端未 seen，等后续 catchUp 逐条消化，
 * 避免上线瞬间连环演出打爆用户。alreadyPerformedIds 用于跳过本会话已演出过的行（防重复）。
 */
export function pickCatchUpTarget(
  messages: ProactiveMessage[],
  alreadyPerformedIds: ReadonlySet<string>,
): ProactiveMessage | null {
  const fresh = messages
    .filter((m) => m.id && !alreadyPerformedIds.has(m.id))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return fresh[0] ?? null;
}

export interface CatchUpDeps {
  fetchSince(avatarId: string, since: number): Promise<ProactiveMessage[]>;
  markSeen(avatarId: string, ids: string[]): Promise<void>;
  /**
   * 与实时 SSE 共用同一表现入口（applyProactiveEvent live=true / coordinator）。
   * ALL-439：返回 false 表示消息未被用户感知（通话中被静默 / 切角色竞态），
   * 本次不 seen、不占 performed、不推进 lastSeen，保留补演机会；undefined 视为已感知（兼容旧实现）。
   */
  applyMessage(msg: ProactiveMessage): boolean | void;
  /** 页面可见才允许演出（true=可见）。 */
  visibilityAllowed(): boolean;
  getLastSeen(): number;
  setLastSeen(v: number): void;
  /** 会话内已演出过的行 id（去重）。 */
  performed: Set<string>;
  /**
   * ALL-439：已演出但 markSeen 未成功的行 id（跨会话持久化，调用方注入 localStorage 实现）。
   * 这些 id 不再演出（用户已看过），每次 catchUp 只重试 markSeen，成功后移出。
   */
  getPendingSeen?(): string[];
  setPendingSeen?(ids: string[]): void;
  /** ALL-439：开发日志（只含 id/时间戳/门状态，不含正文）。 */
  log?(event: string, info: Record<string, unknown>): void;
}

/** pendingSeen 持久化上限：超出丢最旧（那些行最终由服务端治理兜底），防止异常增长。 */
const PENDING_SEEN_CAP = 100;

/**
 * 上线补拉核心流程（纯异步、无 React 依赖，便于单测）：
 * - 拉到当前 avatar 未 seen 的 delivered beat 后，走共享表现路径（applyMessage），
 *   让角色主动说出这条已配置剧情 beat，而不是只静默刷新聊天记录。
 * - 一次至多演出一条（时间正序第一条），演出被用户感知后才 markSeen。
 * - ALL-439：markSeen 网络失败不再把异常抛给调用方了之——已演出的 id 落入持久化
 *   pendingSeen，下次 catchUp（含下次启动）只重试 seen 不再演出，根治「演过了但
 *   没标上，下次打开又演一遍」；lastSeen 照常推进（演出已发生）。
 * - 页面不可见/未就绪时不演出、不 seen、不推进 lastSeen（避免没看到/听到却被标记 seen）。
 */
export async function runProactiveCatchUp(avatarId: string, deps: CatchUpDeps): Promise<void> {
  const pending = new Set(deps.getPendingSeen ? deps.getPendingSeen() : []);
  const msgs = await deps.fetchSince(avatarId, deps.getLastSeen());
  deps.log?.('fetch', {
    avatarId, since: deps.getLastSeen(), count: msgs.length,
    ids: msgs.map((m) => m.id), pendingSeen: [...pending],
  });
  if (!msgs.length) {
    // 无新积压但仍有未确认的 seen（上次 markSeen 失败/已被其它设备看过）：幂等重试一次。
    if (pending.size) await settleSeen(avatarId, [...pending], deps, pending);
    return;
  }
  // App 后台不可见/演出未就绪：不演出也不 seen，等就绪后的 catchUp 再处理（pendingSeen 同样留待下次）。
  if (!deps.visibilityAllowed()) {
    deps.log?.('skip', { avatarId, reason: 'gate_closed', fetched: msgs.length });
    return;
  }

  // pendingSeen 里的 id 此前已演出过：只重试 seen，不再演出（跨会话防重复的关键）。
  const skip = new Set([...deps.performed, ...pending]);
  const target = pickCatchUpTarget(msgs, skip);
  if (!target) {
    // 积压全部已演出过（实时 SSE / 上一会话）：补 seen 全部 + 推进 lastSeen，避免下次重复拉取。
    const ids = [...new Set([...msgs.map((m) => m.id), ...pending])];
    await settleSeen(avatarId, ids, deps, pending);
    deps.setLastSeen(Math.max(...msgs.map((m) => m.createdAt || 0), deps.getLastSeen()));
    return;
  }

  const perceived = deps.applyMessage(target);
  if (perceived === false) {
    // 演出未真正发生（通话中静默/切角色竞态）：不 seen、不占 performed、不推进 lastSeen。
    deps.log?.('skip', { avatarId, reason: 'not_performed', proactiveId: target.id, beatId: target.beatId, createdAt: target.createdAt });
    return;
  }
  deps.performed.add(target.id);
  deps.log?.('perform', {
    avatarId, proactiveId: target.id, beatId: target.beatId,
    createdAt: target.createdAt, lastSeen: deps.getLastSeen(), readyGate: true,
  });
  // 顺带重试上次未确认的 pendingSeen；失败则由 settleSeen 持久化，下次只重试 seen 不再演出。
  await settleSeen(avatarId, [...new Set([...pending, target.id])], deps, pending, target);
  deps.setLastSeen(Math.max(target.createdAt || 0, deps.getLastSeen()));
}

/**
 * markSeen + pendingSeen 结算：成功→把这些 id 移出 pendingSeen；失败→并入 pendingSeen 持久化
 * （去重 + 上限截断），不抛异常——演出已经发生，seen 失败不该阻断补拉链路。
 */
async function settleSeen(
  avatarId: string,
  ids: string[],
  deps: CatchUpDeps,
  pending: ReadonlySet<string>,
  target?: ProactiveMessage,
): Promise<void> {
  try {
    await deps.markSeen(avatarId, ids);
    if (deps.setPendingSeen) deps.setPendingSeen([...pending].filter((id) => !ids.includes(id)));
    deps.log?.('mark_seen', { avatarId, ok: true, ids, proactiveId: target?.id, beatId: target?.beatId });
  } catch (err) {
    if (deps.setPendingSeen) deps.setPendingSeen([...new Set([...pending, ...ids])].slice(-PENDING_SEEN_CAP));
    deps.log?.('mark_seen', { avatarId, ok: false, ids, error: String((err as Error)?.message || err) });
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyProactiveEvent,
  normalizeLastSeenSeconds,
  pickCatchUpTarget,
  runProactiveCatchUp,
} from './proactiveActions.ts';
import { getCurrentBeat } from './journeyStore.ts';

function deps() {
  return {
    setLifeSigns: vi.fn(),
    addNotification: vi.fn(),
    refreshMessages: vi.fn(),
    performProactive: vi.fn(),
  };
}
const ev = (data: any) => ({ event: 'proactive', data });

function createLocalStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    length: 0,
    key: () => null,
  } as Storage;
}

beforeEach(() => {
  const storage = createLocalStorageMock();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyProactiveEvent', () => {
  it('live + 当前 avatar：调 performProactive 演出，不调 refreshMessages', () => {
    const d = deps();
    applyProactiveEvent(ev({ id: 'm1', avatarId: 'estella', content: '哼。', emotion: 'shy', intensity: 0.7 }), 'estella', d, true);
    expect(d.performProactive).toHaveBeenCalledWith('哼。', 'shy', 0.7, 'm1');
    expect(d.refreshMessages).not.toHaveBeenCalled();
    expect(d.setLifeSigns).not.toHaveBeenCalled(); // 无 lifeSigns
  });

  it('catch-up（live=false）：只 refreshMessages，不演出', () => {
    const d = deps();
    applyProactiveEvent(ev({ id: 'm1', avatarId: 'estella', content: '哼。', emotion: 'shy' }), 'estella', d, false);
    expect(d.refreshMessages).toHaveBeenCalledWith('estella');
    expect(d.performProactive).not.toHaveBeenCalled();
  });

  it('非当前 avatar：不演出不刷新', () => {
    const d = deps();
    applyProactiveEvent(ev({ id: 'm1', avatarId: 'yumi', content: 'x' }), 'estella', d, true);
    expect(d.performProactive).not.toHaveBeenCalled();
    expect(d.refreshMessages).not.toHaveBeenCalled();
  });

  it('live + 当前 avatar + lifeSigns：setLifeSigns 写入对象带事件顶层 avatarId', () => {
    const d = deps();
    const lifeSigns = { state_id: 's1' };
    applyProactiveEvent(
      ev({ id: 'm2', avatarId: 'estella', content: '有点累。', emotion: 'tired', intensity: 0.5, lifeSigns }),
      'estella',
      d,
      true,
    );
    // ALL-425：写入全局槽的对象必须带事件顶层 avatarId，供 App 跨角色过滤。
    expect(d.setLifeSigns).toHaveBeenCalledWith({ ...lifeSigns, avatarId: 'estella' });
    expect(d.performProactive).toHaveBeenCalled();
  });

  // ALL-425：proactive 事件携带的 lifeSigns 写入全局槽时必须带上事件顶层 avatarId，
  // 否则 App 的跨角色过滤（无 avatarId 一律放行）会把 A 的背景套到 B 的画面。
  it('proactive lifeSigns 写入时带上事件顶层 avatarId（默认路径）', () => {
    const d = deps();
    applyProactiveEvent(
      ev({ id: 'm1', avatarId: 'estella', content: 'x', lifeSigns: { background_id: 'bgA', scene_key: 'room' } }),
      'yumi',
      d,
      true,
    );
    expect(d.setLifeSigns).toHaveBeenCalledWith({ background_id: 'bgA', scene_key: 'room', avatarId: 'estella' });
  });

  it('事件顶层缺省 avatarId 时写入对象不新增 avatarId 字段（保持原行为）', () => {
    const d = deps();
    applyProactiveEvent(ev({ id: 'm1', content: 'x', lifeSigns: { background_id: 'bgA' } }), 'yumi', d, true);
    const written = d.setLifeSigns.mock.calls[0][0];
    expect(written).toEqual({ background_id: 'bgA' });
    expect(Object.prototype.hasOwnProperty.call(written, 'avatarId')).toBe(false);
  });

  it('beat_change 事件写入当前角色节拍缓存', () => {
    const d = deps();
    const beat = { id: 'b2', name: '新节拍', emotion_state: '开心', status: 'in_progress' as const };
    applyProactiveEvent(
      { event: 'beat_change', data: { avatarId: 'estella', beat } },
      'estella',
      d,
      true,
    );
    expect(getCurrentBeat('estella')).toEqual(beat);
  });

  it('beat_change 事件无 avatarId 时不写入', () => {
    const d = deps();
    applyProactiveEvent(
      { event: 'beat_change', data: { beat: { id: 'b3', name: 'x', emotion_state: 'x', status: 'in_progress' as const } } },
      'estella',
      d,
      true,
    );
    expect(getCurrentBeat('estella')).toBeNull();
  });
});

// flag 开启：分发改走 coordinator.push（router 内部再决定演出/横幅/来电）。
// flag 关闭（deps 无 flagEnabled/pushTouch）走上面的旧路径，逐字节不变。
describe('applyProactiveEvent — flag 开启路由化', () => {
  function depsOn() {
    return { ...deps(), flagEnabled: true, pushTouch: vi.fn() };
  }

  it('flag 开 + proactive(daily, 画外)：pushTouch 收到 kind=message，不走旧 perform/addNotification', () => {
    const d = depsOn();
    applyProactiveEvent(
      { event: 'proactive', data: { id: 'm1', avatarId: 'yumi', content: 'hi', emotion: 'shy', intensity: 0.3, tier: 'daily' } },
      'estella',
      d,
      true,
    );
    expect(d.pushTouch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'message', tier: 'daily', id: 'm1', avatarId: 'yumi', content: 'hi', emotion: 'shy', intensity: 0.3 }),
    );
    expect(d.performProactive).not.toHaveBeenCalled();
    expect(d.addNotification).not.toHaveBeenCalled();
  });

  it('flag 开 + proactive_call：pushTouch 收到 kind=call', () => {
    const d = depsOn();
    applyProactiveEvent(
      { event: 'proactive_call', data: { id: 'c1', avatarId: 'estella', beatId: 'b1', title: 'Estella', tier: 'heavy' } },
      'estella',
      d,
      true,
    );
    expect(d.pushTouch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'call', id: 'c1', avatarId: 'estella', title: 'Estella' }),
    );
    expect(d.performProactive).not.toHaveBeenCalled();
  });

  it('flag 开 + catch-up(live=false)：不进 coordinator，补拉保持原样', () => {
    const d = depsOn();
    applyProactiveEvent(
      { event: 'proactive', data: { id: 'm1', avatarId: 'estella', content: 'hi' } },
      'estella',
      d,
      false,
    );
    expect(d.pushTouch).not.toHaveBeenCalled();
    expect(d.refreshMessages).toHaveBeenCalledWith('estella');
  });

  // ALL-425：flag 开 + live 路径同样要在写入 lifeSigns 时带上事件顶层 avatarId。
  it('flag 开 + live + lifeSigns：setLifeSigns 写入对象带事件顶层 avatarId', () => {
    const d = depsOn();
    applyProactiveEvent(
      { event: 'proactive', data: { id: 'm1', avatarId: 'estella', content: 'x', lifeSigns: { background_id: 'bgA', scene_key: 'room' } } },
      'yumi',
      d,
      true,
    );
    expect(d.setLifeSigns).toHaveBeenCalledWith({ background_id: 'bgA', scene_key: 'room', avatarId: 'estella' });
    expect(d.pushTouch).toHaveBeenCalled(); // 分发行为不受影响
  });
});

describe('applyProactiveEvent — ALL-439 处置结果返回', () => {
  it('flag 开 + 通话中（router 判 silent）：返回 silent → 补拉链路不 seen', () => {
    const d = { ...deps(), flagEnabled: true, pushTouch: vi.fn(() => ({ type: 'silent' as const })) };
    const outcome = applyProactiveEvent(
      { event: 'proactive', data: { id: 'm1', avatarId: 'estella', content: 'hi' } },
      'estella',
      d,
      true,
    );
    expect(outcome).toBe('silent');
  });

  it('flag 开 + 演出（router 判 perform）：返回 perform', () => {
    const d = { ...deps(), flagEnabled: true, pushTouch: vi.fn(() => ({ type: 'perform' as const })) };
    const outcome = applyProactiveEvent(
      { event: 'proactive', data: { id: 'm1', avatarId: 'estella', content: 'hi' } },
      'estella',
      d,
      true,
    );
    expect(outcome).toBe('perform');
  });

  it('flag 关 + 非当前角色（切角色竞态）：返回 ignored', () => {
    const d = deps();
    const outcome = applyProactiveEvent(ev({ id: 'm1', avatarId: 'yumi', content: 'x' }), 'estella', d, true);
    expect(outcome).toBe('ignored');
  });

  it('flag 关 + 当前角色 live：返回 perform；live=false：返回 refresh', () => {
    const d = deps();
    expect(applyProactiveEvent(ev({ id: 'm1', avatarId: 'estella', content: 'x' }), 'estella', d, true)).toBe('perform');
    expect(applyProactiveEvent(ev({ id: 'm1', avatarId: 'estella', content: 'x' }), 'estella', d, false)).toBe('refresh');
  });
});

// ---- ALL-432：上线补拉已触发剧情 beat 的纯逻辑 ----
describe('normalizeLastSeenSeconds（lastSeen 秒级时间单位）', () => {
  it('无记录 / 0 / 负数 / 非法输入一律回 0（首次不依赖 since=current）', () => {
    expect(normalizeLastSeenSeconds(0)).toBe(0);
    expect(normalizeLastSeenSeconds(-1)).toBe(0);
    expect(normalizeLastSeenSeconds(NaN)).toBe(0);
    expect(normalizeLastSeenSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('秒级值原样保留', () => {
    expect(normalizeLastSeenSeconds(1_720_000_000)).toBe(1_720_000_000);
  });

  it('历史误存的毫秒值（>1e11）转秒', () => {
    expect(normalizeLastSeenSeconds(1_720_000_000_000)).toBe(1_720_000_000);
  });

  it('毫秒转秒向下取整', () => {
    expect(normalizeLastSeenSeconds(1_720_000_999_999)).toBe(1_720_000_999);
  });
});

describe('pickCatchUpTarget（积压只演一条）', () => {
  const msg = (id: string, createdAt: number) => ({ id, content: `c${id}`, createdAt });

  it('空列表 → null', () => {
    expect(pickCatchUpTarget([], new Set())).toBeNull();
  });

  it('全部已演出过 → null', () => {
    const msgs = [msg('a', 10), msg('b', 20)];
    expect(pickCatchUpTarget(msgs, new Set(['a', 'b']))).toBeNull();
  });

  it('按时间正序挑第一条（最早触发的那条）', () => {
    const msgs = [msg('a', 30), msg('b', 10), msg('c', 20)];
    expect(pickCatchUpTarget(msgs, new Set())?.id).toBe('b');
  });

  it('跳过已演出过的行（防重复）', () => {
    const msgs = [msg('a', 10), msg('b', 20)];
    expect(pickCatchUpTarget(msgs, new Set(['a']))?.id).toBe('b');
  });

  it('缺 createdAt 视为最早', () => {
    const msgs = [{ id: 'x', content: 'x' }, msg('b', 20)];
    expect(pickCatchUpTarget(msgs, new Set())?.id).toBe('x');
  });

  it('无 id 的行不参与候选', () => {
    const msgs = [{ content: 'no-id', createdAt: 5 }, msg('b', 20)] as any[];
    expect(pickCatchUpTarget(msgs, new Set())?.id).toBe('b');
  });
});

describe('runProactiveCatchUp（上线补拉演出核心）', () => {
  const msg = (id: string, createdAt: number): any => ({ id, content: `c${id}`, createdAt });

  function makeDeps(over: Partial<Parameters<typeof runProactiveCatchUp>[1]> = {}) {
    const events: string[] = [];
    const performed = new Set<string>();
    let lastSeen = 0;
    const deps: Parameters<typeof runProactiveCatchUp>[1] = {
      fetchSince: vi.fn(async () => []),
      markSeen: vi.fn(async (_a: string, ids: string[]) => { events.push(`seen:${ids.join(',')}`); }),
      applyMessage: vi.fn((m: any) => { events.push(`apply:${m.id}`); }),
      visibilityAllowed: () => true,
      getLastSeen: () => lastSeen,
      setLastSeen: (v: number) => { lastSeen = v; events.push(`lastSeen:${v}`); },
      performed,
      ...over,
    };
    return { deps, events, performed, getLastSeen: () => lastSeen };
  }

  it('可见 + 拉到一个未 seen beat：走 applyMessage 演出，演出后才 seen，lastSeen 推进', async () => {
    const { deps, events } = makeDeps({ fetchSince: vi.fn(async () => [msg('p1', 1000)]) });
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).toHaveBeenCalledWith(msg('p1', 1000));
    expect(events).toEqual(['apply:p1', 'seen:p1', 'lastSeen:1000']);
  });

  it('多条积压：只演出时间正序第一条，其余不 seen、lastSeen 不越过未演出的积压', async () => {
    const { deps, events } = makeDeps({
      fetchSince: vi.fn(async () => [msg('old', 100), msg('mid', 200), msg('new', 300)]),
    });
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).toHaveBeenCalledTimes(1);
    expect(deps.applyMessage).toHaveBeenCalledWith(msg('old', 100));
    expect(deps.markSeen).toHaveBeenCalledWith('a1', ['old']);
    expect(events).toEqual(['apply:old', 'seen:old', 'lastSeen:100']);
  });

  it('页面不可见：不演出、不 seen、不推进 lastSeen（避免没看到/听到却被标记 seen）', async () => {
    const { deps, getLastSeen } = makeDeps({
      fetchSince: vi.fn(async () => [msg('p1', 1000)]),
      visibilityAllowed: () => false,
    });
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).not.toHaveBeenCalled();
    expect(deps.markSeen).not.toHaveBeenCalled();
    expect(getLastSeen()).toBe(0);
  });

  // ALL-434：catchUp 的 visibilityAllowed 已并入「App/聊天就绪」门——冷启动/加载/切角色
  // 期间页面虽 visible 但 gate 关闭，此时补拉即使拉到 beat 也不演出、不 seen、不推进
  // lastSeen：消息留在服务端未 seen，等 gate 打开后由下一轮 catchUp 补演，不丢失。
  it('App 未就绪（gate 关闭、页面可见）：不演出、不 seen、不推进 lastSeen', async () => {
    const { deps, getLastSeen } = makeDeps({
      fetchSince: vi.fn(async () => [msg('p1', 1000)]),
      visibilityAllowed: () => false,
    });
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).not.toHaveBeenCalled();
    expect(deps.markSeen).not.toHaveBeenCalled();
    expect(getLastSeen()).toBe(0);
  });

  it('重复 catchUp 不重复演出：同一批数据第二次只补 seen 不重演', async () => {
    const { deps } = makeDeps({ fetchSince: vi.fn(async () => [msg('p1', 1000)]) });
    await runProactiveCatchUp('a1', deps);
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).toHaveBeenCalledTimes(1);
    expect(deps.markSeen).toHaveBeenCalledTimes(2);
  });

  it('多轮 catchUp 逐条消化积压：第二轮演出第二条', async () => {
    const { deps } = makeDeps({
      fetchSince: vi.fn(async () => [msg('old', 100), msg('new', 200)]),
    });
    await runProactiveCatchUp('a1', deps);
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).toHaveBeenCalledTimes(2);
    const appliedIds = (deps.applyMessage as any).mock.calls.map((c: any[]) => c[0].id);
    expect(appliedIds).toEqual(['old', 'new']);
    expect(deps.markSeen).toHaveBeenLastCalledWith('a1', ['new']);
  });

  it('全部已演出（被实时 SSE 演出过）：补 seen 全部行并推进 lastSeen，不重复演出', async () => {
    const { deps, events } = makeDeps({
      fetchSince: vi.fn(async () => [msg('p1', 100), msg('p2', 200)]),
    });
    deps.performed.add('p1');
    deps.performed.add('p2');
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).not.toHaveBeenCalled();
    expect(deps.markSeen).toHaveBeenCalledWith('a1', ['p1', 'p2']);
    expect(events).toEqual(['seen:p1,p2', 'lastSeen:200']);
  });

  it('空结果：什么都不做', async () => {
    const { deps, getLastSeen } = makeDeps();
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).not.toHaveBeenCalled();
    expect(deps.markSeen).not.toHaveBeenCalled();
    expect(getLastSeen()).toBe(0);
  });
});

// ---- ALL-439：seen 可靠性与重复补演边界 ----
describe('runProactiveCatchUp — ALL-439 pendingSeen 与演出门', () => {
  const msg = (id: string, createdAt: number): any => ({ id, content: `c${id}`, createdAt });

  function makeDeps(over: Partial<Parameters<typeof runProactiveCatchUp>[1]> = {}) {
    const performed = new Set<string>();
    let lastSeen = 0;
    let pendingSeen: string[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const deps: Parameters<typeof runProactiveCatchUp>[1] = {
      fetchSince: vi.fn(async () => []),
      markSeen: vi.fn(async () => {}),
      applyMessage: vi.fn(() => true),
      visibilityAllowed: () => true,
      getLastSeen: () => lastSeen,
      setLastSeen: (v: number) => { lastSeen = v; },
      performed,
      getPendingSeen: () => pendingSeen,
      setPendingSeen: (ids: string[]) => { pendingSeen = ids; },
      log: (e, info) => { logs.push([e, info]); },
      ...over,
    };
    return { deps, performed, logs, getLastSeen: () => lastSeen, getPendingSeen: () => pendingSeen };
  }

  it('markSeen 网络失败：不抛错、id 落 pendingSeen、lastSeen 照推进（演出已发生）', async () => {
    const { deps, getLastSeen, getPendingSeen } = makeDeps({
      fetchSince: vi.fn(async () => [msg('p1', 1000)]),
      markSeen: vi.fn(async () => { throw new Error('network down'); }),
    });
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).toHaveBeenCalledTimes(1);
    expect(getPendingSeen()).toEqual(['p1']);
    expect(getLastSeen()).toBe(1000);
  });

  it('markSeen 失败后下次 catchUp：pendingSeen 中的 id 不再演出，只重试 seen，成功后移出', async () => {
    const markSeen = vi.fn<(a: string, ids: string[]) => Promise<void>>(async () => { throw new Error('network down'); });
    const { deps, getPendingSeen } = makeDeps({
      fetchSince: vi.fn(async () => [msg('p1', 1000)]),
      markSeen,
    });
    await runProactiveCatchUp('a1', deps); // 演出 p1，seen 失败 → pendingSeen=[p1]
    expect(deps.applyMessage).toHaveBeenCalledTimes(1);

    // 模拟「下次启动」：performed 集合清空（新会话），seen 恢复
    deps.performed.clear();
    markSeen.mockImplementation(async () => {});
    await runProactiveCatchUp('a1', deps);
    expect(deps.applyMessage).toHaveBeenCalledTimes(1); // 跨会话不得重复演出已演过的行
    expect(markSeen).toHaveBeenLastCalledWith('a1', ['p1']);
    expect(getPendingSeen()).toEqual([]);
  });

  it('pendingSeen 重试持续失败：保留 pendingSeen，且不影响新 beat 演出', async () => {
    const markSeen = vi.fn<(a: string, ids: string[]) => Promise<void>>(async () => { throw new Error('down'); });
    const { deps, getPendingSeen } = makeDeps({
      fetchSince: vi.fn(async () => [msg('p1', 1000)]),
      markSeen,
    });
    await runProactiveCatchUp('a1', deps);
    deps.performed.clear();
    // 服务端又来一条新 beat；p1 仍未 seen（>= 边界会再次返回 p1）
    (deps.fetchSince as any).mockImplementation(async () => [msg('p1', 1000), msg('p2', 2000)]);
    await runProactiveCatchUp('a1', deps);
    const applied = (deps.applyMessage as any).mock.calls.map((c: any[]) => c[0].id);
    expect(applied).toEqual(['p1', 'p2']); // p1 不重演，p2 正常演出
    expect(getPendingSeen()).toEqual(['p1', 'p2']);
  });

  it('applyMessage 返回 false（通话中静默/切角色竞态）：不 seen、不占 performed、不推进 lastSeen', async () => {
    const { deps, performed, getLastSeen } = makeDeps({
      fetchSince: vi.fn(async () => [msg('p1', 1000)]),
      applyMessage: vi.fn(() => false),
    });
    await runProactiveCatchUp('a1', deps);
    expect(deps.markSeen).not.toHaveBeenCalled();
    expect(performed.has('p1')).toBe(false);
    expect(getLastSeen()).toBe(0);
  });

  it('applyMessage 返回 false 后恢复 true：同一行补演一次并正常 seen', async () => {
    const applyMessage = vi.fn(() => false);
    const { deps, getLastSeen } = makeDeps({
      fetchSince: vi.fn(async () => [msg('p1', 1000)]),
      applyMessage,
    });
    await runProactiveCatchUp('a1', deps); // 被拦（通话中）
    applyMessage.mockImplementation(() => true);
    await runProactiveCatchUp('a1', deps); // 通话结束补演
    expect(applyMessage).toHaveBeenCalledTimes(2);
    expect(deps.markSeen).toHaveBeenCalledWith('a1', ['p1']);
    expect(getLastSeen()).toBe(1000);
  });

  it('无积压但有 pendingSeen：幂等重试 seen，成功后清空', async () => {
    const { deps, getPendingSeen } = makeDeps({ fetchSince: vi.fn(async () => []) });
    deps.setPendingSeen!(['p9']);
    await runProactiveCatchUp('a1', deps);
    expect(deps.markSeen).toHaveBeenCalledWith('a1', ['p9']);
    expect(getPendingSeen()).toEqual([]);
  });

  it('演出日志含验收字段：avatarId/proactiveId/beatId/createdAt/lastSeen/readyGate/markSeen', async () => {
    const { deps, logs } = makeDeps({
      fetchSince: vi.fn(async () => [{ id: 'p1', content: '正文不应进日志', createdAt: 1000, beatId: 'b1' } as any]),
    });
    await runProactiveCatchUp('a1', deps);
    const perform = logs.find(([e]) => e === 'perform');
    expect(perform).toBeTruthy();
    expect(perform![1]).toMatchObject({
      avatarId: 'a1', proactiveId: 'p1', beatId: 'b1', createdAt: 1000, lastSeen: 0, readyGate: true,
    });
    const seen = logs.find(([e]) => e === 'mark_seen');
    expect(seen).toBeTruthy();
    expect(seen![1]).toMatchObject({ avatarId: 'a1', ok: true });
    // 日志不得含正文
    for (const [, info] of logs) {
      expect(JSON.stringify(info)).not.toContain('正文不应进日志');
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachV2ProfileBinding } from './v2ProfileBinding';
import type { V2Profile } from './v2Types';
import type { RuntimeState } from '../live2dEngine.ts';
import type { AvatarManifest } from '../avatarManifest.ts';

const engine = {
  startProfileMotion: vi.fn().mockResolvedValue(undefined),
  applyProfileExpression: vi.fn().mockResolvedValue(undefined),
  clearProfileExpression: vi.fn().mockResolvedValue(undefined),
  applyProfileCostume: vi.fn().mockResolvedValue(undefined),
  removeProfileCostume: vi.fn().mockResolvedValue(undefined),
  subscribeMotionFinished: vi.fn(),
};

vi.mock('../live2dEngine.ts', () => ({
  startProfileMotion: (...args: unknown[]) => engine.startProfileMotion(...args),
  applyProfileExpression: (...args: unknown[]) => engine.applyProfileExpression(...args),
  clearProfileExpression: (...args: unknown[]) => engine.clearProfileExpression(...args),
  applyProfileCostume: (...args: unknown[]) => engine.applyProfileCostume(...args),
  removeProfileCostume: (...args: unknown[]) => engine.removeProfileCostume(...args),
  subscribeMotionFinished: (...args: unknown[]) => engine.subscribeMotionFinished(...args),
}));

const mockProfile: V2Profile = {
  role: 'shuangsheng',
  motion: {
    role: 'shuangsheng',
    kind: 'motion',
    version: 'v2',
    items: [
      { id: 'idle', file: 'idle.motion3.json', group: 'idle', loop: true, hint: '待机' },
      { id: 'dance', file: 'dance.motion3.json', group: 'dance', loop: false, hint: '跳舞' },
      { id: 'nod', file: 'nod.motion3.json', group: 'default', loop: false, hint: '点头' },
    ],
  },
  expression: {
    role: 'shuangsheng',
    kind: 'expression',
    version: 'v2',
    items: [
      { id: 'aixin', file: 'aixin.exp3.json', category: 'emotion', hint: '爱心' },
      { id: 'lianhong', file: 'lianhong.exp3.json', category: 'emotion', hint: '脸红' },
      { id: 'baowawa', file: 'baowawa.exp3.json', category: 'costume', hint: '抱娃娃', slot: 'handheld' },
      { id: 'waitao', file: 'waitao.exp3.json', category: 'costume', hint: '外套', slot: 'outerwear' },
      { id: 'headwear', file: 'headwear.exp3.json', category: 'costume', hint: '头纱', slot: 'headwear' },
    ],
  },
};

function makeTracker(expectedEndMs: number | null) {
  return {
    noteUpcomingSpeech: vi.fn(),
    getExpectedTtsEndMs: vi.fn().mockReturnValue(expectedEndMs),
    dispose: vi.fn(),
  };
}

function makeRuntime(): RuntimeState {
  return { avatar: { id: 'shuangsheng' } } as unknown as RuntimeState;
}

function makeAvatar(): AvatarManifest {
  return { id: 'shuangsheng' } as unknown as AvatarManifest;
}

async function flushQueue() {
  // queue 内部用 await 串行；一次 resolved Promise 足够让已入队任务全部完成。
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('attachV2ProfileBinding', () => {
  let fakeTime: number;
  let motionFinishedCb: ((motionId: string) => void) | null = null;

  beforeEach(() => {
    fakeTime = 0;
    vi.clearAllMocks();
    engine.subscribeMotionFinished.mockImplementation((_runtime, cb) => {
      motionFinishedCb = cb;
      return () => { motionFinishedCb = null; };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. 触发 motion → 调用 startProfileMotion', async () => {
    const binding = attachV2ProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('dance.motion3.json');
    await flushQueue();

    expect(engine.startProfileMotion).toHaveBeenCalledTimes(1);
    expect(engine.startProfileMotion).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'dance.motion3.json');
    binding.dispose();
  });

  it('2. motion 结束 → 回到 idle', async () => {
    const binding = attachV2ProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('dance.motion3.json');
    await flushQueue();

    motionFinishedCb?.('dance.motion3.json');
    await flushQueue();

    expect(engine.startProfileMotion).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'idle.motion3.json');
    binding.dispose();
  });

  it('3. motion 结束后又触发新 motion → 不回 idle 打断新 motion', async () => {
    const binding = attachV2ProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('dance.motion3.json');
    await flushQueue();

    // 在 dance 结束检测前又触发 nod
    binding.trigger('nod.motion3.json');
    await flushQueue();

    // 此时 dance 才上报结束
    motionFinishedCb?.('dance.motion3.json');
    await flushQueue();

    // 不应再切回 idle，避免打断 nod
    expect(engine.startProfileMotion).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'nod.motion3.json');
    binding.dispose();
  });

  it('4. 快速穿外套→脱外套→穿外套，最终外套在 slot 上', async () => {
    const binding = attachV2ProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('waitao.exp3.json');
    binding.clearSlot('outerwear');
    binding.trigger('waitao.exp3.json');
    await flushQueue();

    // 最后一次 apply 应是穿外套；remove 之后不应再有遗留的 apply
    expect(engine.applyProfileCostume).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'waitao.exp3.json', 'outerwear');
    expect(engine.removeProfileCostume).toHaveBeenCalledTimes(1);
    binding.dispose();
  });

  it('5. 多个 costume 快速交替触发，最终状态与调度器一致', async () => {
    const binding = attachV2ProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('waitao.exp3.json');
    binding.trigger('headwear.exp3.json');
    binding.clearSlot('outerwear');
    binding.trigger('baowawa.exp3.json');
    await flushQueue();

    // 最终：outerwear 已清，headwear 和 handheld 存在
    expect(engine.removeProfileCostume).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'outerwear');
    expect(engine.applyProfileCostume).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'headwear.exp3.json', 'headwear');
    expect(engine.applyProfileCostume).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'baowawa.exp3.json', 'handheld');
    binding.dispose();
  });

  it('6. expression 快速交替触发，最终调用最后一个', async () => {
    const binding = attachV2ProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('aixin.exp3.json');
    binding.trigger('lianhong.exp3.json');
    binding.trigger('aixin.exp3.json');
    await flushQueue();

    expect(engine.applyProfileExpression).toHaveBeenLastCalledWith(expect.anything(), 'aixin.exp3.json');
    expect(engine.applyProfileExpression).toHaveBeenCalledTimes(3);
    binding.dispose();
  });

  it('7. 单个 action 失败不阻断后续 action', async () => {
    engine.applyProfileCostume.mockRejectedValueOnce(new Error('apply failed'));

    const binding = attachV2ProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('waitao.exp3.json');
    binding.trigger('headwear.exp3.json');
    await flushQueue();

    expect(engine.applyProfileCostume).toHaveBeenCalledTimes(2);
    expect(engine.applyProfileCostume).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'headwear.exp3.json', 'headwear');
    binding.dispose();
  });
});

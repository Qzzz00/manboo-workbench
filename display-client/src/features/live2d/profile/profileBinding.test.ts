import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachProfileBinding } from './profileBinding';
import type { RoleProfile } from './types';
import type { RuntimeState } from '../live2dEngine.ts';
import type { AvatarManifest } from '../avatarManifest.ts';
import { TriggerSchedulerConfig } from './triggerScheduler';

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

const shuangshengProfile: RoleProfile = {
  role: 'shuangsheng',
  schemaVersion: 'v1',
  motions: [
    { file: 'idle.motion3', kind: 'idle' },
    { file: 'dance.motion3', kind: 'motion', intensity: 'strong' },
  ],
  expressions: [
    { file: '爱心眼.exp3', kind: 'expr', intensity: 'strong' },
    { file: '机器人耳朵.exp3', kind: 'costume', slot: 'headwear' },
    { file: '猫爪手套.exp3', kind: 'costume', slot: 'handheld' },
  ],
  excluded: [],
};

const yumiProfile: RoleProfile = {
  role: 'yumi',
  schemaVersion: 'v1',
  idleStrategy: 'virtual_empty',
  motions: [
    { file: 'tear.motion3', kind: 'motion', intensity: 'strong' },
  ],
  expressions: [
    { file: '爱心眼.exp3', kind: 'expr', intensity: 'strong' },
    { file: '短发1.exp3', kind: 'costume', slot: 'hair' },
    { file: '短发2.exp3', kind: 'costume', slot: 'hair' },
  ],
  excluded: [],
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

describe('profileBinding', () => {
  let fakeTime: number;
  let motionFinishedCb: ((motionId: string) => void) | null = null;

  beforeEach(() => {
    fakeTime = 0;
    TriggerSchedulerConfig.defaultExprHoldMs = 3000;
    vi.clearAllMocks();
    engine.subscribeMotionFinished.mockImplementation((_runtime, cb) => {
      motionFinishedCb = cb;
      return () => { motionFinishedCb = null; };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. 单一 motion 触发 → engine.startProfileMotion 被调用', () => {
    const binding = attachProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: shuangshengProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('dance.motion3');
    expect(engine.startProfileMotion).toHaveBeenCalledTimes(1);
    expect(engine.startProfileMotion).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'dance.motion3');
    binding.dispose();
  });

  it('2. motion 结束 → return_to_idle 播 idle；virtual_empty 不播', () => {
    const binding = attachProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: shuangshengProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('dance.motion3');
    expect(engine.startProfileMotion).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'dance.motion3');

    motionFinishedCb?.('dance.motion3');
    expect(engine.startProfileMotion).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'idle.motion3');
    binding.dispose();
  });

  it('3. yumi virtual_empty：motion 结束不播 idle', () => {
    const binding = attachProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: yumiProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('tear.motion3');
    expect(engine.startProfileMotion).toHaveBeenCalledTimes(1);

    motionFinishedCb?.('tear.motion3');
    // virtual_empty：return_to_idle 的 file 为 null，不应再调 startProfileMotion
    expect(engine.startProfileMotion).toHaveBeenCalledTimes(1);
    binding.dispose();
  });

  it('4. tracker 返回 ttsEndsAtMs=now+4000 → 4500ms 后 tick 触发 clearProfileExpression', () => {
    vi.useFakeTimers();
    fakeTime = 0;
    const tracker = makeTracker(4000); // now(0) + 4000

    const binding = attachProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: shuangshengProfile,
      tracker,
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('爱心眼.exp3');
    expect(engine.applyProfileExpression).toHaveBeenCalledWith(expect.anything(), '爱心眼.exp3');
    expect(engine.clearProfileExpression).not.toHaveBeenCalled();

    fakeTime = 4499;
    vi.advanceTimersByTime(4499);
    expect(engine.clearProfileExpression).not.toHaveBeenCalled();

    fakeTime = 4500;
    vi.advanceTimersByTime(1);
    expect(engine.clearProfileExpression).toHaveBeenCalledTimes(1);

    binding.dispose();
  });

  it('5. tracker 返回 null → 兜底 defaultExprHoldMs 后清', () => {
    vi.useFakeTimers();
    fakeTime = 1000;
    TriggerSchedulerConfig.defaultExprHoldMs = 3000;

    const binding = attachProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: shuangshengProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('爱心眼.exp3');
    expect(engine.applyProfileExpression).toHaveBeenCalledWith(expect.anything(), '爱心眼.exp3');

    fakeTime = 3999;
    vi.advanceTimersByTime(2999);
    expect(engine.clearProfileExpression).not.toHaveBeenCalled();

    fakeTime = 4000;
    vi.advanceTimersByTime(1);
    expect(engine.clearProfileExpression).toHaveBeenCalledTimes(1);

    binding.dispose();
  });

  it('6. costume 同 slot 覆盖', () => {
    const binding = attachProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: yumiProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('短发1.exp3');
    expect(engine.applyProfileCostume).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), '短发1.exp3', 'hair');

    binding.trigger('短发2.exp3');
    expect(engine.applyProfileCostume).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), '短发2.exp3', 'hair');

    binding.dispose();
  });

  it('7. costume 不同 slot 并存', () => {
    const binding = attachProfileBinding({
      runtime: makeRuntime(),
      avatar: makeAvatar(),
      profile: shuangshengProfile,
      tracker: makeTracker(null),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });

    binding.trigger('机器人耳朵.exp3');
    binding.trigger('猫爪手套.exp3');

    expect(engine.applyProfileCostume).toHaveBeenCalledWith(expect.anything(), expect.anything(), '机器人耳朵.exp3', 'headwear');
    expect(engine.applyProfileCostume).toHaveBeenCalledWith(expect.anything(), expect.anything(), '猫爪手套.exp3', 'handheld');

    binding.dispose();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachNativeV2ProfileBinding } from './nativeV2ProfileBinding';
import type { V2Profile } from './v2Types';
import type { AvatarManifest } from '../avatarManifest.ts';

const nativeStage = {
  playNativeMotion: vi.fn(),
  applyNativeExpressionMix: vi.fn().mockResolvedValue(undefined),
  setNativeProfileCostumeParams: vi.fn(),
  getNativeStageState: vi.fn(),
};

vi.mock('../nativeStage.ts', () => ({
  playNativeMotion: (...args: unknown[]) => nativeStage.playNativeMotion(...args),
  applyNativeExpressionMix: (...args: unknown[]) => nativeStage.applyNativeExpressionMix(...args),
  setNativeProfileCostumeParams: (...args: unknown[]) => nativeStage.setNativeProfileCostumeParams(...args),
  getNativeStageState: (...args: unknown[]) => nativeStage.getNativeStageState(...args),
}));

const paramFlatten = {
  fetchExpressionFileParams: vi.fn(),
};

vi.mock('../paramFlatten.ts', () => ({
  fetchExpressionFileParams: (...args: unknown[]) => paramFlatten.fetchExpressionFileParams(...args),
}));

// 按 basename 命中 fixture 表情表（对齐生产 findAvatarExpressionByProfileFile 的 id/文件名双匹配）。
const fixtureExpressions: Record<string, { id: string; binding: { mode: 'file'; file: string } }> = {
  'aixin.exp3.json': { id: 'aixin', binding: { mode: 'file', file: '/assets/aixin.exp3.json' } },
  'baowawa.exp3.json': { id: 'baowawa', binding: { mode: 'file', file: '/assets/baowawa.exp3.json' } },
};

vi.mock('../live2dEngine.ts', () => ({
  findAvatarExpressionByProfileFile: (_avatar: unknown, file: string) => fixtureExpressions[file],
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
    ],
  },
  expression: {
    role: 'shuangsheng',
    kind: 'expression',
    version: 'v2',
    items: [
      { id: 'aixin', file: 'aixin.exp3.json', category: 'emotion', hint: '爱心' },
      { id: 'baowawa', file: 'baowawa.exp3.json', category: 'costume', hint: '抱娃娃', slot: 'handheld' },
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

function makeAvatar(): AvatarManifest {
  return { id: 'shuangsheng' } as unknown as AvatarManifest;
}

async function flushAsync() {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('attachNativeV2ProfileBinding', () => {
  let fakeTime: number;

  beforeEach(() => {
    fakeTime = 0;
    vi.clearAllMocks();
    nativeStage.getNativeStageState.mockReturnValue({
      paramInfo: new Map([['ParamHandheld', { def: 0.3 }]]),
    });
    paramFlatten.fetchExpressionFileParams.mockResolvedValue([{ id: 'ParamHandheld', value: 1, blend: 'Overwrite' }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function attach(trackerEndMs: number | null = null) {
    return attachNativeV2ProfileBinding({
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(trackerEndMs),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });
  }

  it('1. 触发 motion → 按 profile group 播原生动作', () => {
    const binding = attach();
    binding.trigger('dance.motion3.json');
    expect(nativeStage.playNativeMotion).toHaveBeenCalledWith('dance');
    binding.dispose();
  });

  it('2. 触发 emotion 表情 → overlay 写入清单表情 id', () => {
    const binding = attach();
    binding.trigger('aixin.exp3.json');
    expect(nativeStage.applyNativeExpressionMix).toHaveBeenCalledWith(expect.anything(), [{ key: 'aixin', weight: 1 }]);
    binding.dispose();
  });

  it('3. 表情到期（TTS 结束+500ms）→ 清空 overlay 表情', () => {
    vi.useFakeTimers();
    const binding = attach(1000);
    binding.trigger('aixin.exp3.json');
    fakeTime = 1600; // ttsEndsAt(1000)+500=1500 到期
    vi.advanceTimersByTime(60);
    expect(nativeStage.applyNativeExpressionMix).toHaveBeenLastCalledWith(expect.anything(), []);
    binding.dispose();
  });

  it('4. 触发 costume → exp3 参数进 profile persistent 通道', async () => {
    const binding = attach();
    binding.trigger('baowawa.exp3.json');
    await flushAsync();
    expect(paramFlatten.fetchExpressionFileParams).toHaveBeenCalledWith('/assets/baowawa.exp3.json');
    expect(nativeStage.setNativeProfileCostumeParams).toHaveBeenLastCalledWith({ ParamHandheld: 1 });
    expect(binding.getActiveCostumeSlots()).toEqual(['handheld']);
    binding.dispose();
  });

  it('5. clearSlot 脱装 → 参数钉回原生默认值', async () => {
    const binding = attach();
    binding.trigger('baowawa.exp3.json');
    await flushAsync();
    binding.clearSlot('handheld');
    await flushAsync();
    expect(nativeStage.setNativeProfileCostumeParams).toHaveBeenLastCalledWith({ ParamHandheld: 0.3 });
    expect(binding.getActiveCostumeSlots()).toEqual([]);
    binding.dispose();
  });

  it('6. dispose → 停 tick 并清空 profile persistent 通道', () => {
    vi.useFakeTimers();
    const binding = attach();
    binding.dispose();
    expect(nativeStage.setNativeProfileCostumeParams).toHaveBeenLastCalledWith({});
    nativeStage.applyNativeExpressionMix.mockClear();
    fakeTime = 99999;
    vi.advanceTimersByTime(200);
    expect(nativeStage.applyNativeExpressionMix).not.toHaveBeenCalled();
  });

  it('7. initialCostumes 重放 → 切角色回来恢复穿着', async () => {
    const binding = attachNativeV2ProfileBinding({
      avatar: makeAvatar(),
      profile: mockProfile,
      tracker: makeTracker(null),
      initialCostumes: new Map([['handheld', 'baowawa.exp3.json']]),
      now: () => fakeTime,
      tickIntervalMs: 50,
    });
    await flushAsync();
    expect(nativeStage.setNativeProfileCostumeParams).toHaveBeenLastCalledWith({ ParamHandheld: 1 });
    expect(binding.getActiveCostumeSlots()).toEqual(['handheld']);
    binding.dispose();
  });
});

import { describe, it, expect } from 'vitest';
import { V2TriggerScheduler } from './v2TriggerScheduler';
import type { V2Profile } from './v2Types';

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
      { id: 'baowawa', file: 'baowawa.exp3.json', category: 'costume', hint: '抱娃娃', slot: 'handheld' },
      { id: 'waitao', file: 'waitao.exp3.json', category: 'costume', hint: '外套', slot: 'outerwear' },
      { id: 'headwear', file: 'headwear.exp3.json', category: 'costume', hint: '头纱', slot: 'headwear' },
      { id: 'tousi', file: 'tousi.exp3.json', category: 'costume', hint: '头饰', slot: 'headwear', mode: 'remove' },
    ],
  },
};

function makeScheduler(now = 0) {
  return new V2TriggerScheduler(mockProfile, () => now);
}

describe('V2TriggerScheduler', () => {
  it('触发 motion 返回 play_motion', () => {
    const scheduler = makeScheduler();
    const actions = scheduler.trigger('dance.motion3.json');
    expect(actions).toEqual([{ type: 'play_motion', file: 'dance.motion3.json' }]);
    expect(scheduler.getState().motion.file).toBe('dance.motion3.json');
  });

  it('触发 emotion 返回 set_expr 并更新 expr 状态', () => {
    const scheduler = makeScheduler(1000);
    const actions = scheduler.trigger('aixin.exp3.json', { ttsEndsAtMs: 5000 });
    expect(actions).toEqual([{ type: 'set_expr', file: 'aixin.exp3.json', clearAtMs: 5500 }]);
    expect(scheduler.getState().expr).toEqual({ file: 'aixin.exp3.json', expiresAt: 5500 });
  });

  it('触发 costume 返回 set_costume 且不更新 expr 状态', () => {
    const scheduler = makeScheduler(1000);
    const actions = scheduler.trigger('waitao.exp3.json', { ttsEndsAtMs: 5000 });
    expect(actions).toEqual([{ type: 'set_costume', file: 'waitao.exp3.json', slot: 'outerwear', replaced: null }]);
    expect(scheduler.getState().expr).toEqual({ file: null, expiresAt: null });
    expect(scheduler.getState().costumes.get('outerwear')).toBe('waitao.exp3.json');
  });

  it('同 slot 的 costume 连续触发只产生 set_costume，没有 clear_expr', () => {
    const scheduler = makeScheduler();
    const first = scheduler.trigger('waitao.exp3.json');
    expect(first).toEqual([{ type: 'set_costume', file: 'waitao.exp3.json', slot: 'outerwear', replaced: null }]);

    // 同一文件再次触发：仍是 set_costume，中间不应产生 clear_expr。
    const second = scheduler.trigger('waitao.exp3.json');
    expect(second).toEqual([{ type: 'set_costume', file: 'waitao.exp3.json', slot: 'outerwear', replaced: 'waitao.exp3.json' }]);
    expect(scheduler.tick()).toEqual([]);
  });

  it('expression 匹配兼容 .json 后缀：带后缀输入返回原样 file', () => {
    const scheduler = makeScheduler(1000);
    const actions = scheduler.trigger('aixin.exp3.json', { ttsEndsAtMs: 5000 });
    expect(actions).toEqual([{ type: 'set_expr', file: 'aixin.exp3.json', clearAtMs: 5500 }]);
  });

  it('expression 匹配兼容 .json 后缀：无后缀输入同样命中', () => {
    const scheduler = makeScheduler(1000);
    const actions = scheduler.trigger('aixin.exp3', { ttsEndsAtMs: 5000 });
    expect(actions).toEqual([{ type: 'set_expr', file: 'aixin.exp3.json', clearAtMs: 5500 }]);
  });

  it('costume 匹配兼容 .json 后缀：无后缀输入命中 handheld slot', () => {
    const scheduler = makeScheduler(1000);
    const actions = scheduler.trigger('baowawa.exp3');
    expect(actions).toEqual([{ type: 'set_costume', file: 'baowawa.exp3.json', slot: 'handheld', replaced: null }]);
  });

  it('未知文件抛错并携带归一化后 key 与已注册列表', () => {
    const scheduler = makeScheduler();
    let message = '';
    try {
      scheduler.trigger('nonexistent.exp3');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('nonexistent.exp3');
    expect(message).toContain('已注册 expression:');
    expect(message).toContain('已注册 motion:');
  });

  describe('onMotionEnded', () => {
    it('motion 正常结束 → 回到 idle', () => {
      const scheduler = makeScheduler();
      scheduler.trigger('dance.motion3.json');
      expect(scheduler.getState().motion.file).toBe('dance.motion3.json');

      const actions = scheduler.onMotionEnded('dance.motion3.json');
      expect(actions).toEqual([{ type: 'return_to_idle', file: 'idle.motion3.json' }]);
      expect(scheduler.getState().motion.file).toBeNull();
    });

    it('结束回调前已被新 motion 覆盖 → 不回 idle', () => {
      const scheduler = makeScheduler();
      scheduler.trigger('dance.motion3.json');
      scheduler.trigger('nod.motion3.json');
      expect(scheduler.getState().motion.file).toBe('nod.motion3.json');

      const actions = scheduler.onMotionEnded('dance.motion3.json');
      expect(actions).toEqual([]);
      expect(scheduler.getState().motion.file).toBe('nod.motion3.json');
    });

    it('无在播 motion 时结束回调为空', () => {
      const scheduler = makeScheduler();
      expect(scheduler.onMotionEnded('dance.motion3.json')).toEqual([]);
    });
  });

  it('expr 到期后 tick 返回 clear_expr', () => {
    let now = 1000;
    const scheduler = new V2TriggerScheduler(mockProfile, () => now);
    scheduler.trigger('aixin.exp3.json', { ttsEndsAtMs: 2000 });
    now = 2499;
    expect(scheduler.tick()).toEqual([]);
    now = 2500;
    expect(scheduler.tick()).toEqual([{ type: 'clear_expr' }]);
  });

  describe('clearSlot', () => {
    it('有装饰时返回 clear_costume action 并移除状态', () => {
      const scheduler = makeScheduler();
      scheduler.trigger('baowawa.exp3.json');
      const actions = scheduler.clearSlot('handheld');
      expect(actions).toEqual([{ type: 'clear_costume', slot: 'handheld', file: 'baowawa.exp3.json' }]);
      expect(scheduler.getState().costumes.get('handheld')).toBeUndefined();
    });

    it('无装饰时返回空数组', () => {
      const scheduler = makeScheduler();
      expect(scheduler.clearSlot('handheld')).toEqual([]);
    });

    it('连续 trigger 后 clearSlot 使 slot 变空', () => {
      const scheduler = makeScheduler();
      scheduler.trigger('baowawa.exp3.json');
      expect(scheduler.getState().costumes.get('handheld')).toBe('baowawa.exp3.json');
      scheduler.clearSlot('handheld');
      expect(scheduler.getState().costumes.has('handheld')).toBe(false);
    });
  });

  describe('costume mode=remove', () => {
    it('mode=remove 且 slot 未激活时返回空数组', () => {
      const scheduler = makeScheduler();
      expect(scheduler.trigger('tousi.exp3.json')).toEqual([]);
      expect(scheduler.getState().costumes.has('headwear')).toBe(false);
    });

    it('mode=remove 且 slot 已激活时返回 clear_costume 并移除状态', () => {
      const scheduler = makeScheduler();
      scheduler.trigger('headwear.exp3.json');
      expect(scheduler.getState().costumes.get('headwear')).toBe('headwear.exp3.json');
      const actions = scheduler.trigger('tousi.exp3.json');
      expect(actions).toEqual([{ type: 'clear_costume', slot: 'headwear', file: 'headwear.exp3.json' }]);
      expect(scheduler.getState().costumes.has('headwear')).toBe(false);
    });

    it('remove B slot 不应影响已激活的 A slot', () => {
      const scheduler = makeScheduler();
      scheduler.trigger('waitao.exp3.json');
      expect(scheduler.getState().costumes.get('outerwear')).toBe('waitao.exp3.json');

      // headwear slot 未激活，remove 操作应返回空数组且不碰 outerwear
      const actions = scheduler.trigger('tousi.exp3.json');
      expect(actions).toEqual([]);
      expect(scheduler.getState().costumes.get('outerwear')).toBe('waitao.exp3.json');
      expect(scheduler.getState().costumes.has('headwear')).toBe(false);
    });
  });
});

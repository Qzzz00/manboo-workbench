import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProfileFromJson } from './loader';
import { TriggerScheduler, TriggerSchedulerConfig } from './triggerScheduler';
import type { RoleProfile } from './types';

function loadProfile(role: string): RoleProfile {
  const json = readFileSync(resolve(import.meta.dirname, `../../../../model/profiles/${role}.v1.json`), 'utf-8');
  return loadProfileFromJson(json);
}

describe('TriggerScheduler', () => {
  let fakeTime: number;
  const now = () => fakeTime;

  beforeEach(() => {
    fakeTime = 0;
    TriggerSchedulerConfig.defaultExprHoldMs = 3000;
  });

  describe('motion channel', () => {
    it('1. motion 打断 idle：初始 idle，trigger(dance.motion3) → play_motion', () => {
      const profile = loadProfile('shuangsheng-dj');
      const scheduler = new TriggerScheduler(profile, now);

      expect(scheduler.getState().motion).toEqual({ kind: 'idle', file: 'idle.motion3' });

      const actions = scheduler.trigger('dance.motion3');
      expect(actions).toEqual([{ type: 'play_motion', file: 'dance.motion3' }]);
      expect(scheduler.getState().motion).toEqual({ kind: 'motion', file: 'dance.motion3' });
    });

    it('2. motion 播完回 idle：onMotionEnded → return_to_idle(idle.motion3)', () => {
      const profile = loadProfile('shuangsheng-dj');
      const scheduler = new TriggerScheduler(profile, now);

      scheduler.trigger('dance.motion3');
      const actions = scheduler.onMotionEnded();
      expect(actions).toEqual([{ type: 'return_to_idle', file: 'idle.motion3' }]);
      expect(scheduler.getState().motion).toEqual({ kind: 'idle', file: 'idle.motion3' });
    });

    it('3. yumi virtual_empty：无 idle，trigger(tear.motion3) → play_motion，结束后回 null', () => {
      const profile = loadProfile('yumi');
      const scheduler = new TriggerScheduler(profile, now);

      expect(scheduler.getState().motion).toEqual({ kind: 'idle', file: null });

      const actions = scheduler.trigger('tear.motion3');
      expect(actions).toEqual([{ type: 'play_motion', file: 'tear.motion3' }]);

      const ended = scheduler.onMotionEnded();
      expect(ended).toEqual([{ type: 'return_to_idle', file: null }]);
      expect(scheduler.getState().motion).toEqual({ kind: 'idle', file: null });
    });

    it('4. motion 后来者覆盖 motion：连续触发两个 motion，第二次仍返回 play_motion', () => {
      const profile = loadProfile('shuangsheng-dj');
      const scheduler = new TriggerScheduler(profile, now);

      scheduler.trigger('dance.motion3');
      const actions = scheduler.trigger('nod.motion3');
      expect(actions).toEqual([{ type: 'play_motion', file: 'nod.motion3' }]);
      expect(scheduler.getState().motion).toEqual({ kind: 'motion', file: 'nod.motion3' });
    });
  });

  describe('expr channel', () => {
    it('5. expr B 方案：ttsEndsAtMs 决定 clearAtMs = ttsEndsAtMs + 500', () => {
      const profile = loadProfile('yumi');
      const scheduler = new TriggerScheduler(profile, now);

      const actions = scheduler.trigger('爱心眼.exp3', { ttsEndsAtMs: 5000 });
      expect(actions).toEqual([{ type: 'set_expr', file: '爱心眼.exp3', clearAtMs: 5500 }]);
      expect(scheduler.getState().expr).toEqual({ file: '爱心眼.exp3', expiresAt: 5500 });

      fakeTime = 5499;
      expect(scheduler.tick()).toEqual([]);

      fakeTime = 5500;
      expect(scheduler.tick()).toEqual([{ type: 'clear_expr' }]);
      expect(scheduler.getState().expr).toEqual({ file: null, expiresAt: null });
    });

    it('6. expr 后来者覆盖，尾巴重算', () => {
      const profile = loadProfile('yumi');
      const scheduler = new TriggerScheduler(profile, now);

      scheduler.trigger('星星眼.exp3', { ttsEndsAtMs: 1000 });
      fakeTime = 800;
      const actions = scheduler.trigger('爱心眼.exp3', { ttsEndsAtMs: 2000 });
      expect(actions).toEqual([{ type: 'set_expr', file: '爱心眼.exp3', clearAtMs: 2500 }]);

      fakeTime = 1500;
      expect(scheduler.tick()).toEqual([]);

      fakeTime = 2500;
      expect(scheduler.tick()).toEqual([{ type: 'clear_expr' }]);
    });

    it('7. expr 与 motion 并行：expr 不清 motion', () => {
      const profile = loadProfile('shuangsheng-dj');
      const scheduler = new TriggerScheduler(profile, now);

      scheduler.trigger('dance.motion3');
      expect(scheduler.getState().motion.kind).toBe('motion');

      scheduler.trigger('aixin.exp3', { ttsEndsAtMs: 5000 });
      expect(scheduler.getState().motion).toEqual({ kind: 'motion', file: 'dance.motion3' });
      expect(scheduler.getState().expr.file).toBe('aixin.exp3');
    });

    it('11. expr 兜底：不传 ttsEndsAtMs → clearAtMs = now + defaultExprHoldMs', () => {
      const profile = loadProfile('yumi');
      fakeTime = 1000;
      const scheduler = new TriggerScheduler(profile, now);

      const actions = scheduler.trigger('爱心眼.exp3');
      expect(actions).toEqual([{ type: 'set_expr', file: '爱心眼.exp3', clearAtMs: 4000 }]);
    });
  });

  describe('costume channel', () => {
    it('8. costume 同 slot 互斥：后触发替换前者，replaced 带旧文件名', () => {
      const profile = loadProfile('yumi');
      const scheduler = new TriggerScheduler(profile, now);

      const first = scheduler.trigger('短发1.exp3');
      expect(first).toEqual([{ type: 'set_costume', slot: 'hair', file: '短发1.exp3', replaced: null }]);

      const second = scheduler.trigger('短发2.exp3');
      expect(second).toEqual([{ type: 'set_costume', slot: 'hair', file: '短发2.exp3', replaced: '短发1.exp3' }]);
      expect(scheduler.getState().costumes.get('hair')).toBe('短发2.exp3');
    });

    it('9. costume 不打断 motion/expr：motion 播放中触发 costume 只返回 set_costume', () => {
      const profile = loadProfile('shuangsheng-dj');
      const scheduler = new TriggerScheduler(profile, now);

      scheduler.trigger('dance.motion3');
      const actions = scheduler.trigger('tousi.exp3');
      expect(actions).toEqual([{ type: 'set_costume', slot: 'headwear', file: 'tousi.exp3', replaced: null }]);
      expect(scheduler.getState().motion.kind).toBe('motion');
    });

    it('12. costume 不同 slot 并存：outfit 与 headwear 同时存在', () => {
      const profile = loadProfile('shuangsheng-dj');
      const scheduler = new TriggerScheduler(profile, now);

      scheduler.trigger('huanzhuang.exp3');
      scheduler.trigger('tousi.exp3');
      expect(scheduler.getState().costumes.get('outfit')).toBe('huanzhuang.exp3');
      expect(scheduler.getState().costumes.get('headwear')).toBe('tousi.exp3');
    });
  });

  describe('error handling', () => {
    it('10. 未知文件抛错：trigger 不存在的文件抛出异常并含文件名', () => {
      const profile = loadProfile('shuangsheng-dj');
      const scheduler = new TriggerScheduler(profile, now);

      expect(() => scheduler.trigger('不存在.motion3')).toThrow('不存在.motion3');
    });
  });
});

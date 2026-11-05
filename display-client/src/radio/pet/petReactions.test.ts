import { describe, it, expect } from 'vitest';
import { getAvatarById } from '../../features/live2d/avatarData.ts';
import { buildUnifiedActions, getAvatarAction } from '../../features/live2d/avatarManifest.ts';
import { favoriteSnackFor, petReactionFor, SNACKS, type PetEvent, type PetMood } from './petReactions.ts';
import { installTestAvatars } from '../../features/live2d/testAvatars.ts';

// 仓库不带模型(10-21),内置表是空的:这份用例拿当年那份清单当输入。
installTestAvatars();

const CALM: PetMood = { hunger: 'ok', sleepy: false, level: 3 };
const ALL_EVENTS: PetEvent[] = [
  { kind: 'tap', zone: 'head', streak: 1 }, { kind: 'tap', zone: 'head', streak: 2 },
  { kind: 'tap', zone: 'head', streak: 3 }, { kind: 'tap', zone: 'head', streak: 7 },
  { kind: 'tap', zone: 'body', streak: 1 }, { kind: 'tap', zone: 'body', streak: 3 },
  { kind: 'tap', zone: 'head', streak: 1, wake: true },
  { kind: 'feed', favorite: false, sated: false }, { kind: 'feed', favorite: true, sated: false },
  { kind: 'feed', favorite: false, sated: true },
  { kind: 'greet' },
  { kind: 'idle', behavior: 'attention' }, { kind: 'idle', behavior: 'nap' },
  { kind: 'idle', behavior: 'dance' }, { kind: 'idle', behavior: 'hungryRemind' },
];
const MOODS: PetMood[] = [
  CALM,
  { hunger: 'hungry', sleepy: false, level: 1 },
  { hunger: 'full', sleepy: true, level: 5 },
];

describe('petReactionFor：actionId/expressionId 必须真实存在于角色清单', () => {
  for (const id of ['hijiki', 'ghostpuppy'] as const) {
    it(`${id} 全事件×全心情遍历`, () => {
      const avatar = getAvatarById(id)!;
      const motionKeys = new Set(Object.keys(avatar.motions ?? {}));
      const exprIds = new Set((avatar.expressions ?? []).map((e) => e.id));
      // ★与 RadioApp 相同的富集方式钉进测试：action 通道消化端（playAction/playNativeAction）实际查询的
      // 是 getAvatarAction(enriched, id)，光「原始 motions/expressions 字典里有这个 key」不代表富集后
      // 的 actions 注册表也能查到（见 RadioApp.tsx djAvatar 的 buildUnifiedActions 富集）。
      const enriched = { ...avatar, actions: buildUnifiedActions(avatar) };
      for (const ev of ALL_EVENTS) {
        for (const mood of MOODS) {
          const re = petReactionFor(id, ev, mood);
          if (!re) continue;
          if (re.actionId) {
            expect(motionKeys.has(re.actionId) || exprIds.has(re.actionId)).toBe(true);
            expect(getAvatarAction(enriched, re.actionId)).toBeDefined();
          }
          if (re.expressionId) {
            expect(exprIds.has(re.expressionId)).toBe(true);
            expect(getAvatarAction(enriched, re.expressionId)).toBeDefined();
          }
        }
      }
    });
  }
  it('ghostie 零动作零表情：任何反应都不带 actionId/expressionId，只有 nudge/cry', () => {
    for (const ev of ALL_EVENTS) {
      for (const mood of MOODS) {
        const re = petReactionFor('ghostie', ev, mood);
        if (!re) continue;
        expect(re.actionId).toBeUndefined();
        expect(re.expressionId).toBeUndefined();
      }
    }
  });
  it('未知角色返回 null（不炸）', () => {
    expect(petReactionFor('yumi', { kind: 'greet' }, CALM)).toBeNull();
  });
});

describe('人设差异与关键规则', () => {
  it('连摸递进：猫 3 连到 cheer；连戳惹毛：猫嘟囔、狗委屈 pout+puppy_eyes、幽灵躲闪', () => {
    expect(petReactionFor('hijiki', { kind: 'tap', zone: 'head', streak: 3 }, CALM)?.actionId).toBe('cheer');
    expect(petReactionFor('hijiki', { kind: 'tap', zone: 'body', streak: 3 }, CALM)?.cry).toBe('grumble');
    const dog = petReactionFor('ghostpuppy', { kind: 'tap', zone: 'body', streak: 3 }, CALM);
    expect(dog?.actionId).toBe('pout');
    expect(dog?.expressionId).toBe('puppy_eyes');
    expect(petReactionFor('ghostie', { kind: 'tap', zone: 'body', streak: 3 }, CALM)?.nudge).toBe('dodge');
  });
  it('饿了摸头第一下是可怜叫（plead）', () => {
    const hungry: PetMood = { hunger: 'hungry', sleepy: false, level: 3 };
    expect(petReactionFor('hijiki', { kind: 'tap', zone: 'head', streak: 1 }, hungry)?.cry).toBe('plead');
  });
  it('半睡被摸=惊醒 surprised（wake 优先于连击档位）', () => {
    expect(petReactionFor('ghostpuppy', { kind: 'tap', zone: 'head', streak: 1, wake: true })?.actionId ?? '').toBe('surprised');
  });
  it('喂食全都有咀嚼与爱心；对口升档（狗 cheer+excited_full）', () => {
    const fav = petReactionFor('ghostpuppy', { kind: 'feed', favorite: true, sated: false }, CALM);
    expect(fav?.mouthPulse).toBe(true);
    expect(fav?.hearts).toBe(true);
    expect(fav?.actionId).toBe('cheer');
    expect(fav?.expressionId).toBe('excited_full');
  });
  it('随乐摇摆不叫（别对着音乐叫）；小幽灵打盹啥也不做', () => {
    expect(petReactionFor('hijiki', { kind: 'idle', behavior: 'dance' }, CALM)?.cry).toBeUndefined();
    expect(petReactionFor('ghostie', { kind: 'idle', behavior: 'nap' }, CALM)).toBeNull();
  });
  it('问候按等级升档：Lv4+ 用 cheer', () => {
    expect(petReactionFor('ghostpuppy', { kind: 'greet' }, { ...CALM, level: 2 })?.actionId).toBe('greeting');
    expect(petReactionFor('ghostpuppy', { kind: 'greet' }, { ...CALM, level: 4 })?.actionId).toBe('cheer');
  });
});

describe('零食', () => {
  it('三格零食与对口映射', () => {
    expect(SNACKS.map((s) => s.id)).toEqual(['fish', 'bone', 'candy']);
    expect(favoriteSnackFor('hijiki')).toBe('fish');
    expect(favoriteSnackFor('ghostpuppy')).toBe('bone');
    expect(favoriteSnackFor('ghostie')).toBe('candy');
    expect(favoriteSnackFor('yumi')).toBeNull();
  });
});

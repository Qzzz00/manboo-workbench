import { describe, it, expect } from 'vitest';
import { classifyProfileTriggers, inferTriggersFromProse, type LocalTriggerResult } from './localTriggerClassifier.ts';
import { loadV2Profile } from './v2Loader';
import type { V2Profile } from './v2Types.ts';

const DEFAULT_EXPRESSION_KEYWORDS: Record<string, string[]> = {
  aixin: ['爱心', '心心', '喜欢你', '我喜欢', '爱你', '么么哒', '亲亲'],
  baowawa: ['娃娃', '抱娃', '棉花', '小熊', '小兔子', '布偶'],
  changge: ['唱歌', '唱一首', '唱一段', '唱一下'],
  heilian: ['生气', '讨厌', '烦', '不理你', '哼', '无语'],
  huanzhuang: ['换装', '换衣服', '换一套'],
  jiyan: ['眼睛亮', '好棒', '好厉害', '太酷了', '崇拜'],
  lianhong: ['脸红', '害羞', '不好意思', '好害羞'],
  tousi: ['头饰', '发卡', '戴上'],
  waitao: ['外套', '穿外套', '披外套', '披上'],
  yanlei: ['哭', '眼泪', '委屈', '难过', '想哭'],
  yun: ['头晕', '晕', '转圈', '好累'],
  baisi: ['白丝', '换白丝', '丝袜'],
};

const DEFAULT_MOTION_KEYWORDS: Record<string, string[]> = {
  nod: ['好的', '嗯嗯', '是的', '明白', '知道了'],
  shake: ['不要', '不行', '不对', '才不'],
  panic: ['吓死', '好可怕', '完了', '糟糕'],
  hide_face: ['别看', '遮脸', '好害羞'],
  happy: ['开心', '高兴', '太好了', '真棒'],
  cheer: ['加油', '欢呼', '万岁'],
  dance: ['跳舞', '跳一支'],
  sleepy: ['困', '睡吧', '想睡', '打瞌睡'],
  shy: ['害羞死了', '好羞'],
};

const EXPRESSION_IDS = Object.keys(DEFAULT_EXPRESSION_KEYWORDS);
const MOTION_IDS = Object.keys(DEFAULT_MOTION_KEYWORDS);

function buildProfile(options: {
  motionIds?: string[];
  expressionIds?: string[];
  motionKeywords?: Record<string, string[]>;
  expressionKeywords?: Record<string, string[]>;
} = {}): V2Profile {
  const motionIds = options.motionIds ?? MOTION_IDS;
  const expressionIds = options.expressionIds ?? EXPRESSION_IDS;

  const costumeSlots: Record<string, 'outfit' | 'headwear' | 'outerwear' | 'legwear' | 'handheld'> = {
    baisi: 'legwear',
    baowawa: 'handheld',
    huanzhuang: 'outfit',
    tousi: 'headwear',
    waitao: 'outerwear',
  };

  return {
    role: 'shuangsheng',
    motion: {
      role: 'shuangsheng',
      kind: 'motion',
      version: 'v2',
      items: motionIds.map((id) => ({
        id,
        file: `motions/${id}.motion3.json`,
        group: 'default',
        loop: false,
        hint: '',
        keywords: options.motionKeywords?.[id] ?? DEFAULT_MOTION_KEYWORDS[id],
      })),
    },
    expression: {
      role: 'shuangsheng',
      kind: 'expression',
      version: 'v2',
      items: expressionIds.map((id) => {
        const slot = costumeSlots[id];
        return {
          id,
          file: `${id}.exp3.json`,
          category: slot ? 'costume' : 'emotion',
          hint: '',
          ...(slot ? { slot } : {}),
          ...(id === 'baisi' ? { defaultWorn: true } : {}),
          keywords: options.expressionKeywords?.[id] ?? DEFAULT_EXPRESSION_KEYWORDS[id],
        };
      }),
    },
  };
}

function resultFor(
  userText: string,
  replyText: string,
  overrides?: Parameters<typeof buildProfile>[0],
): LocalTriggerResult {
  return classifyProfileTriggers({
    userText,
    replyText,
    v2Profile: buildProfile(overrides),
  });
}

describe('classifyProfileTriggers', () => {
  it('userText="给我看看娃娃" → expressionId="baowawa"', () => {
    const result = resultFor('给我看看娃娃', '');
    expect(result.expressionId).toBe('baowawa');
  });

  it('userText="我困了想睡觉" → motionId="sleepy"', () => {
    const result = resultFor('我困了想睡觉', '');
    expect(result.motionId).toBe('sleepy');
  });

  it('userText="你真棒！" → 命中 happy 或 jiyan', () => {
    const result = resultFor('你真棒！', '');
    expect(['happy', 'jiyan']).toContain(result.motionId ?? result.expressionId);
  });

  it('userText="哼，不理你了" → expressionId="heilian" 或 motionId="shake"', () => {
    const result = resultFor('哼，不理你了', '');
    expect([result.expressionId, result.motionId]).toContain('heilian');
  });

  it('reply 命中也能触发 expressionId="lianhong"', () => {
    const result = resultFor('抱抱我', '（脸红了）好的');
    expect(result.expressionId).toBe('lianhong');
  });

  it('userText="你好"（无关键词）→ 两个 slot 都 undefined', () => {
    const result = resultFor('你好', '');
    expect(result.motionId).toBeUndefined();
    expect(result.expressionId).toBeUndefined();
    expect(result.reasons.filter((r) => r.intent === 'set')).toHaveLength(0);
  });

  it('profile 里没有 dance 时，即使用户说"跳舞"也不输出 dance', () => {
    const result = resultFor('跳舞', '', { motionIds: MOTION_IDS.filter((id) => id !== 'dance') });
    expect(result.motionId).not.toBe('dance');
    expect(result.motionId).toBeUndefined();
  });

  it('同一 tag user + reply 都命中 → score 累加正确', () => {
    const result = resultFor('爱心', '心心', {
      expressionIds: ['aixin'],
    });
    expect(result.expressionId).toBe('aixin');
    const reason = result.reasons.find((r) => r.slot === 'expression' && r.id === 'aixin');
    expect(reason).toBeDefined();
    expect(reason!.score).toBe(4);
    expect(reason!.hitKeywords).toEqual(expect.arrayContaining(['爱心', '心心']));
  });

  it('userText 命中 A、replyText 命中 B → user 权重 3 > reply 1，输出 A', () => {
    const result = resultFor('好的', '加油');
    expect(result.motionId).toBe('nod');
  });

  it('reasons 数组包含命中的 keyword 与 fromUser 标记', () => {
    const result = resultFor('娃娃', '');
    const reason = result.reasons.find((r) => r.id === 'baowawa');
    expect(reason).toBeDefined();
    expect(reason!.hitKeywords).toContain('娃娃');
    expect(reason!.fromUser).toBe(true);
  });

  it('profile item 没有 keywords 字段 → 该 id 永远不命中', () => {
    const result = resultFor('娃娃', '', {
      expressionKeywords: { ...DEFAULT_EXPRESSION_KEYWORDS, baowawa: [] },
    });
    expect(result.expressionId).not.toBe('baowawa');
    expect(result.expressionId).toBeUndefined();
  });

  it('profile 里新出现的 motion 关键词能命中（good_morning）', () => {
    const result = resultFor('早安', '', {
      motionIds: ['good_morning'],
      motionKeywords: { good_morning: ['早安', '早上好', '早'] },
    });
    expect(result.motionId).toBe('good_morning');
  });

  it('"脱下外套" → 清除 outerwear，无 expressionId', () => {
    const result = resultFor('脱下外套', '');
    expect(result.clearSlots).toEqual(['outerwear']);
    expect(result.expressionId).toBeUndefined();
    expect(result.reasons.some((r) => r.intent === 'clear' && r.slot === 'outerwear')).toBe(true);
  });

  it('"放下娃娃" → 清除 handheld', () => {
    const result = resultFor('放下娃娃', '');
    expect(result.clearSlots).toEqual(['handheld']);
    expect(result.expressionId).toBeUndefined();
    expect(result.reasons.some((r) => r.intent === 'clear' && r.slot === 'handheld')).toBe(true);
  });

  it('"脱掉外套后放下娃娃" → clearSlots 含 outerwear 与 handheld', () => {
    const result = resultFor('脱掉外套后放下娃娃', '');
    expect(result.clearSlots?.sort()).toEqual(['handheld', 'outerwear']);
    expect(result.expressionId).toBeUndefined();
  });

  it('"穿上外套" → clearSlots 为空，expressionId 为 waitao', () => {
    const result = resultFor('穿上外套', '');
    expect(result.clearSlots).toEqual([]);
    expect(result.expressionId).toBe('waitao');
    expect(result.reasons.some((r) => r.intent === 'set' && r.expressionId === 'waitao')).toBe(true);
  });

  it('"脱下外套穿新外套" → clearSlots 含 outerwear，expressionId 仍为 waitao（回文折中）', () => {
    const result = resultFor('脱下外套穿新外套', '');
    expect(result.clearSlots).toEqual(['outerwear']);
    expect(result.expressionId).toBe('waitao');
  });

  it('"穿上外套抱着娃娃" → 两个 slot 都触发 set，clearSlots 为空', () => {
    const result = resultFor('穿上外套抱着娃娃', '');
    expect(result.clearSlots).toEqual([]);
    expect(['waitao', 'baowawa']).toContain(result.expressionId);
  });

  it('用户输入与回复文本同时检查', () => {
    const noClear = classifyProfileTriggers({
      userText: '今天好热',
      replyText: '她轻轻脱下外套',
      v2Profile: buildProfile(),
    });
    expect(noClear.clearSlots).toEqual([]);

    const withClear = classifyProfileTriggers({
      userText: '帮我脱掉外套',
      replyText: '她轻轻脱下外套',
      v2Profile: buildProfile(),
    });
    expect(withClear.clearSlots).toEqual(['outerwear']);
  });

  it('扩展动词"收起来"作用在 keyword 后 → 触发 clear', () => {
    const result = classifyProfileTriggers({
      userText: '把娃娃收起来',
      replyText: '',
      v2Profile: buildProfile(),
    });
    expect(result.clearSlots).toEqual(['handheld']);
    expect(
      result.reasons.some((r) => r.intent === 'clear' && r.slot === 'handheld' && r.verb === '收起来'),
    ).toBe(true);
  });

  it('扩展动词"收起"作用在 keyword 前 → 触发 clear', () => {
    const result = classifyProfileTriggers({
      userText: '收起娃娃',
      replyText: '',
      v2Profile: buildProfile(),
    });
    expect(result.clearSlots).toEqual(['handheld']);
  });

  it('无明确指代但 activeCostumeSlots 有值 + CLEAR_VERB → 清除所有已激活 slot', () => {
    const result = classifyProfileTriggers({
      userText: '把它收起来',
      replyText: '',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['handheld'],
    });
    expect(result.clearSlots).toEqual(['handheld']);
    const fallback = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'handheld');
    expect(fallback).toBeDefined();
    expect(fallback!.verb).toBe('收起来');
    expect(fallback!.source).toBe('user');
  });

  it('多件在身时无指代兜底不猜测（ALL-297）', () => {
    const result = classifyProfileTriggers({
      userText: '都放下吧',
      replyText: '',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['handheld', 'outerwear'],
    });
    expect(result.clearSlots).toEqual([]);
  });

  it('多件在身 + 最近刚设置某 slot + 无指代 CLEAR_VERB → 只清最近设置的 slot', () => {
    const result = classifyProfileTriggers({
      userText: '放下吧',
      replyText: '',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit', 'handheld'],
      recentSetCostumeSlots: ['handheld', 'outfit'],
    });
    expect(result.clearSlots).toEqual(['handheld']);
    const fallback = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'handheld');
    expect(fallback).toBeDefined();
    expect(fallback!.verb).toBe('放下');
    expect(fallback!.source).toBe('user');
  });

  it('无指代 CLEAR_VERB 且最近设置 slot 已不在身 → 不猜测', () => {
    const result = classifyProfileTriggers({
      userText: '放下吧',
      replyText: '',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit', 'outerwear'],
      recentSetCostumeSlots: ['handheld'],
    });
    expect(result.clearSlots).toEqual([]);
  });

  it('兜底不会触发：keyword-matched clear 已经命中时', () => {
    const result = classifyProfileTriggers({
      userText: '放下娃娃',
      replyText: '',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outerwear'],
    });
    // 已经通过 keyword "娃娃" + "放下" 命中 handheld，不再把 outerwear 拉进来。
    expect(result.clearSlots).toEqual(['handheld']);
  });

  it('兜底不会触发：activeCostumeSlots 为空', () => {
    const result = classifyProfileTriggers({
      userText: '把它收起来',
      replyText: '',
      v2Profile: buildProfile(),
      activeCostumeSlots: [],
    });
    expect(result.clearSlots).toEqual([]);
  });

  it('兜底不会触发：没有 CLEAR_VERB', () => {
    const result = classifyProfileTriggers({
      userText: '好呀',
      replyText: '',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['handheld'],
    });
    expect(result.clearSlots).toEqual([]);
  });

  it('复穿请求时忽略回复文本里的清除叙述，避免误清', () => {
    const result = classifyProfileTriggers({
      userText: '再看看',
      replyText: '我把娃娃放下了',
      v2Profile: buildProfile(),
      activeCostumeSlots: [],
    });
    expect(result.clearSlots).toEqual([]);
    expect(result.expressionId).toBeUndefined();
  });

  it('非复穿请求时回复文本仍可按原有逻辑清 slot', () => {
    const noClear = classifyProfileTriggers({
      userText: '今天好热',
      replyText: '她轻轻脱下外套',
      v2Profile: buildProfile(),
    });
    expect(noClear.clearSlots).toEqual([]);

    const withClear = classifyProfileTriggers({
      userText: '帮我脱掉外套',
      replyText: '她轻轻脱下外套',
      v2Profile: buildProfile(),
    });
    expect(withClear.clearSlots).toEqual(['outerwear']);
  });

  it('无明确物品名 + 复穿意图 + 最近脱下过该 slot → 重新触发 costume', () => {
    const result = classifyProfileTriggers({
      userText: '再看看',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: [],
      recentClearedCostumeSlots: ['handheld'],
    });
    expect(result.expressionId).toBe('baowawa');
    expect(result.clearSlots).toEqual([]);
  });

  it('复穿意图只在没有激活 slot 时触发', () => {
    const result = classifyProfileTriggers({
      userText: '再看看',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outerwear'],
      recentClearedCostumeSlots: ['handheld'],
    });
    expect(result.expressionId).toBeUndefined();
    expect(result.clearSlots).toEqual([]);
  });

  it('复穿意图按 recency 取最近脱下的 slot', () => {
    const result = classifyProfileTriggers({
      userText: '再穿一次',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: [],
      recentClearedCostumeSlots: ['outerwear', 'handheld'],
    });
    expect(result.expressionId).toBe('waitao');
    expect(result.clearSlots).toEqual([]);
  });

  it('"换装回去"按 keyword 只清 outfit slot，不再触发 huanzhuang', () => {
    const result = classifyProfileTriggers({
      userText: '换装回去',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit'],
    });
    expect(result.clearSlots).toEqual(['outfit']);
    expect(result.expressionId).toBeUndefined();
  });

  it('"换回去"无具体 keyword 时按最近设置 slot 还原', () => {
    const result = classifyProfileTriggers({
      userText: '换回去',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit', 'outerwear'],
      recentSetCostumeSlots: ['outerwear', 'outfit'],
    });
    expect(result.clearSlots).toEqual(['outerwear']);
    expect(result.expressionId).toBeUndefined();
  });

  it('"换回去"最近设置 slot 不 active 时回退到清所有 active slot', () => {
    const result = classifyProfileTriggers({
      userText: '换回去',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit', 'outerwear'],
      recentSetCostumeSlots: ['handheld'],
    });
    expect(result.clearSlots?.sort()).toEqual(['outerwear', 'outfit']);
    expect(result.expressionId).toBeUndefined();
  });

  it('"把衣服换回去"只清衣物 slot，不动手持道具', () => {
    const result = classifyProfileTriggers({
      userText: '把衣服换回去吧',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit', 'handheld'],
    });
    expect(result.clearSlots).toEqual(['outfit']);
    expect(result.expressionId).toBeUndefined();
  });

  it('"换回睡衣"清除 active 的衣物 slot（回到默认装扮）', () => {
    const result = classifyProfileTriggers({
      userText: '换回睡衣',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit', 'outerwear'],
    });
    expect(result.clearSlots?.sort()).toEqual(['outerwear', 'outfit']);
    expect(result.expressionId).toBeUndefined();
  });

  it('"换回常服"只清 active 的衣物 slot，不动手持道具', () => {
    const result = classifyProfileTriggers({
      userText: '换回常服吧',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit', 'handheld'],
    });
    expect(result.clearSlots).toEqual(['outfit']);
    expect(result.expressionId).toBeUndefined();
  });

  describe('defaultWorn legwear（baisi）：默认穿白丝，expression 表脱掉', () => {
    it('"脱掉白丝" → 应用 baisi expression（脱掉白丝）', () => {
      const result = classifyProfileTriggers({
        userText: '脱掉白丝',
        replyText: '',
        v2Profile: buildProfile(),
        activeCostumeSlots: [],
      });
      expect(result.expressionId).toBe('baisi');
      expect(result.clearSlots).toEqual([]);
    });

    it('"去掉丝袜" → 应用 baisi expression', () => {
      const result = classifyProfileTriggers({
        userText: '去掉丝袜',
        replyText: '',
        v2Profile: buildProfile(),
        activeCostumeSlots: [],
      });
      expect(result.expressionId).toBe('baisi');
      expect(result.clearSlots).toEqual([]);
    });

    it('"白丝" → 应用 baisi expression', () => {
      const result = classifyProfileTriggers({
        userText: '白丝',
        replyText: '',
        v2Profile: buildProfile(),
        activeCostumeSlots: [],
      });
      expect(result.expressionId).toBe('baisi');
      expect(result.clearSlots).toEqual([]);
    });

    it('"穿上白丝"且 legwear 已激活 → 清除 slot（恢复默认穿白丝）', () => {
      const result = classifyProfileTriggers({
        userText: '穿上白丝',
        replyText: '',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['legwear'],
      });
      expect(result.expressionId).toBeUndefined();
      expect(result.clearSlots).toEqual(['legwear']);
    });

    it('"穿上白丝"且 legwear 未激活 → 无操作', () => {
      const result = classifyProfileTriggers({
        userText: '穿上白丝',
        replyText: '',
        v2Profile: buildProfile(),
        activeCostumeSlots: [],
      });
      expect(result.expressionId).toBeUndefined();
      expect(result.clearSlots).toEqual([]);
    });
  });

  it('"换回原来的样子"清所有激活 slot', () => {
    const result = classifyProfileTriggers({
      userText: '还是换回原来的样子吧',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outerwear'],
    });
    expect(result.clearSlots).toEqual(['outerwear']);
    expect(result.expressionId).toBeUndefined();
  });

  it('"外套换回来"按 keyword 只清 outerwear', () => {
    const result = classifyProfileTriggers({
      userText: '外套换回来',
      replyText: '好的',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['outfit', 'outerwear'],
    });
    expect(result.clearSlots).toEqual(['outerwear']);
    expect(result.expressionId).toBeUndefined();
  });

  it('kind="disabled" 的 item 即使 keywords 匹配也不命中', () => {
    const profile = buildProfile({
      motionIds: ['dance'],
      motionKeywords: { dance: ['跳舞'] },
      expressionIds: ['aixin'],
      expressionKeywords: { aixin: ['跳舞'] },
    });
    profile.motion.items[0].kind = 'disabled';
    profile.expression.items[0].kind = 'disabled';

    const result = classifyProfileTriggers({
      userText: '跳舞',
      replyText: '',
      v2Profile: profile,
    });
    expect(result.motionId).toBeUndefined();
    expect(result.expressionId).toBeUndefined();
  });

  it('kind="pending" 的 item 不参与触发', () => {
    const profile = buildProfile({
      expressionIds: ['baowawa'],
      expressionKeywords: { baowawa: ['娃娃'] },
    });
    profile.expression.items[0].kind = 'pending';

    const result = classifyProfileTriggers({
      userText: '娃娃',
      replyText: '',
      v2Profile: profile,
    });
    expect(result.expressionId).toBeUndefined();
  });

  it('triggerEnabled=false 的 costume 不参与 set/clear', () => {
    const profile = buildProfile();
    const waitaoItem = profile.expression.items.find((item) => item.id === 'waitao');
    expect(waitaoItem).toBeDefined();
    waitaoItem!.triggerEnabled = false;

    const setResult = classifyProfileTriggers({
      userText: '穿上外套',
      replyText: '',
      v2Profile: profile,
    });
    expect(setResult.expressionId).toBeUndefined();

    const clearResult = classifyProfileTriggers({
      userText: '脱下外套',
      replyText: '',
      v2Profile: profile,
    });
    expect(clearResult.clearSlots).toEqual([]);
  });

  it('无指代兜底只从 userText 命中，source 标为 user（ALL-297）', () => {
    const result = classifyProfileTriggers({
      userText: '（悄悄放下了）',
      replyText: '',
      v2Profile: buildProfile(),
      activeCostumeSlots: ['handheld'],
    });
    expect(result.clearSlots).toEqual(['handheld']);
    const fallback = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'handheld');
    expect(fallback?.source).toBe('user');
  });

  describe('T9: 本地兜底触发收紧（ALL-297）', () => {
    it('Bug 3-a: 单件在身 + 无指代 userText → 清该 slot', () => {
      const result = classifyProfileTriggers({
        userText: '把它收起来',
        replyText: '好的',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['outerwear'],
      });
      expect(result.clearSlots).toEqual(['outerwear']);
      const fallback = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'outerwear');
      expect(fallback).toBeDefined();
      expect(fallback!.verb).toBe('收起来');
      expect(fallback!.source).toBe('user');
    });

    it('Bug 3-b: 多件在身 + 无指代 userText → 不清', () => {
      const result = classifyProfileTriggers({
        userText: '把它收起来',
        replyText: '好的',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['outerwear', 'handheld'],
      });
      expect(result.clearSlots).toEqual([]);
    });

    it('Bug 3-c: 回复里的 keyword+verb 不再误清（用户已提及其他 costume）', () => {
      const result = classifyProfileTriggers({
        userText: '看看娃娃',
        replyText: '我把外套放下',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['outerwear'],
      });
      expect(result.clearSlots).toEqual([]);
    });

    it('Bug 2-a: userText 优先 clear，忽略 replyText 中的其它 slot', () => {
      const result = classifyProfileTriggers({
        userText: '放下外套',
        replyText: '我把娃娃放下',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['outerwear', 'handheld'],
      });
      expect(result.clearSlots).toEqual(['outerwear']);
      const reason = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'outerwear');
      expect(reason?.source).toBe('user');
    });

    it('Bug 2-b: 用户提到其它装扮时，回复里的 clear 动词不误触发', () => {
      const result = classifyProfileTriggers({
        userText: '看看娃娃',
        replyText: '我把外套挂好',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['outerwear', 'handheld'],
      });
      expect(result.clearSlots).toEqual([]);
    });

    it('Bug 1-a: 全局回到基态短语清掉所有 active slot', () => {
      const result = classifyProfileTriggers({
        userText: '换回原来的样子',
        replyText: '',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['outerwear', 'handheld'],
      });
      expect(result.clearSlots?.sort()).toEqual(['handheld', 'outerwear']);
      expect(result.motionId).toBeUndefined();
      expect(result.expressionId).toBeUndefined();
    });

    it('Bug 1-b: 句中命中全局回到基态短语也全清', () => {
      const result = classifyProfileTriggers({
        userText: '今天要恢复原样吗',
        replyText: '',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['outerwear'],
      });
      expect(result.clearSlots).toEqual(['outerwear']);
      expect(result.motionId).toBeUndefined();
      expect(result.expressionId).toBeUndefined();
    });
  });

  describe('CLEAR_VERBS 扩展（ALL-298）', () => {
    describe('移除类动词', () => {
      it.each([
        { text: '把外套移除', slot: 'outerwear', verb: '移除' },
        { text: '取消外套', slot: 'outerwear', verb: '取消' },
        { text: '脱下外套', slot: 'outerwear', verb: '脱下' },
      ])('"$text" → 清除 $slot', ({ text, slot, verb }) => {
        const result = classifyProfileTriggers({
          userText: text,
          replyText: '',
          v2Profile: buildProfile(),
        });
        expect(result.clearSlots).toEqual([slot]);
        const reason = result.reasons.find((r) => r.intent === 'clear' && r.slot === slot);
        expect(reason).toBeDefined();
        expect(reason!.verb).toBe(verb);
      });
    });

    describe('放置类动词', () => {
      it.each([
        { text: '把娃娃放一边', slot: 'handheld', verb: '放一边' },
        { text: '把外套搁在一边', slot: 'outerwear', verb: '搁在一边' },
        { text: '娃娃丢了', slot: 'handheld', verb: '丢了' },
      ])('"$text" → 清除 $slot', ({ text, slot, verb }) => {
        const result = classifyProfileTriggers({
          userText: text,
          replyText: '',
          v2Profile: buildProfile(),
        });
        expect(result.clearSlots).toEqual([slot]);
        const reason = result.reasons.find((r) => r.intent === 'clear' && r.slot === slot);
        expect(reason).toBeDefined();
        expect(reason!.verb).toBe(verb);
      });
    });

    describe('无指代兜底：单件在身 + 新 CLEAR_VERB → 清该 slot', () => {
      it.each([
        { text: '把它移除', verb: '移除' },
        { text: '把它取消', verb: '取消' },
        { text: '把它脱下', verb: '脱下' },
        { text: '把它放一边', verb: '放一边' },
        { text: '把它搁在一边', verb: '搁在一边' },
        { text: '把它丢了', verb: '丢了' },
      ])('"$text" + activeCostumeSlots=[handheld] → 清 handheld', ({ text, verb }) => {
        const result = classifyProfileTriggers({
          userText: text,
          replyText: '',
          v2Profile: buildProfile(),
          activeCostumeSlots: ['handheld'],
        });
        expect(result.clearSlots).toEqual(['handheld']);
        const reason = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'handheld');
        expect(reason).toBeDefined();
        expect(reason!.verb).toBe(verb);
        expect(reason!.source).toBe('user');
      });
    });

    it('无指代兜底：多件在身 + 新 CLEAR_VERB → 不触发（ALL-297 收紧仍生效）', () => {
      const result = classifyProfileTriggers({
        userText: '把它移除',
        replyText: '',
        v2Profile: buildProfile(),
        activeCostumeSlots: ['handheld', 'outerwear'],
      });
      expect(result.clearSlots).toEqual([]);
    });
  });
});

describe('shuangsheng v3 classifier acceptance', () => {
  async function loadProfile(): Promise<V2Profile> {
    const profile = await loadV2Profile('shuangsheng');
    if (!profile) throw new Error('shuangsheng profile 加载失败');
    return profile;
  }

  it('输入 "生气" → 命中 heilian，且不再命中 pout', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '生气', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBe('heilian');
    expect(result.motionId).not.toBe('pout');
  });

  it('输入 "娃娃" → 命中 baowawa（hand_prop）', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '娃娃', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBe('baowawa');
    const baowawa = profile.expression.items.find((item) => item.id === 'baowawa');
    expect(baowawa?.slot).toBe('hand_prop');
  });

  it('输入 "戴上头饰" → 不命中 tousi（keywords 为空）', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '戴上头饰', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBeUndefined();
    expect(result.motionId).toBeUndefined();
    expect(result.reasons.filter((r) => r.intent === 'set')).toHaveLength(0);
  });

  it('输入 "换白丝" → 命中 baisi', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '换白丝', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBe('baisi');
  });

  describe('disabled 忽略回归（T7）', () => {
    it('输入 "生气了" → 命中 heilian，且不再命中 pout', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '生气了', replyText: '', v2Profile: profile });
      expect(result.expressionId).toBe('heilian');
      expect(result.motionId).not.toBe('pout');
      const heilian = profile.expression.items.find((item) => item.id === 'heilian');
      expect(heilian?.kind).toBe('emotion_expr');
      expect(heilian?.emotion).toBe('angry');
    });

    it('输入 "困了、想睡" → 不命中 sleepy（disabled）', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '困了、想睡', replyText: '', v2Profile: profile });
      expect(result.motionId).not.toBe('sleepy');
      expect(result.motionId).toBeUndefined();
      expect(result.expressionId).toBeUndefined();
      expect(result.reasons.filter((r) => r.intent === 'set')).toHaveLength(0);
    });

    it('输入 "遮脸、别看" → 不命中 hide_face（disabled）', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '遮脸、别看', replyText: '', v2Profile: profile });
      expect(result.motionId).not.toBe('hide_face');
      expect(result.motionId).toBeUndefined();
      expect(result.expressionId).toBeUndefined();
      expect(result.reasons.filter((r) => r.intent === 'set')).toHaveLength(0);
    });

    it('greeting 项保持可触发：输入 "你好" → 命中 greeting', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '你好', replyText: '', v2Profile: profile });
      expect(result.motionId).toBe('greeting');
      const greeting = profile.motion.items.find((item) => item.id === 'greeting');
      expect(greeting?.kind).toBe('greeting');
    });
  });

  describe('tousi 触发禁用回归（T7）', () => {
    it('tousi 项 keywords 为空且 triggerEnabled=false', async () => {
      const profile = await loadProfile();
      const tousi = profile.expression.items.find((item) => item.id === 'tousi');
      expect(tousi?.keywords).toEqual([]);
      expect(tousi?.triggerEnabled).toBe(false);
    });

    it.each(['头饰', '发卡', '戴上', '戴上头饰'])('输入 "%s" → 不命中 tousi', async (text) => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: text, replyText: '', v2Profile: profile });
      expect(result.expressionId).not.toBe('tousi');
      expect(result.expressionId).toBeUndefined();
      expect(result.motionId).toBeUndefined();
      expect(result.reasons.filter((r) => r.intent === 'set')).toHaveLength(0);
    });
  });

  describe('hint 语义改写后的关键词矛盾回归（T7）', () => {
    it('输入 "不要" → 不再命中 shake', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '不要', replyText: '', v2Profile: profile });
      expect(result.motionId).not.toBe('shake');
      expect(result.motionId).toBeUndefined();
      expect(result.expressionId).toBeUndefined();
      const shakeReason = result.reasons.find((r) => r.id === 'shake' && r.intent === 'set');
      expect(shakeReason).toBeUndefined();
    });

    it('输入 "开心" → 不再命中 happy motion（现语义为 pose）', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '开心', replyText: '', v2Profile: profile });
      expect(result.motionId).not.toBe('happy');
      const happy = profile.motion.items.find((item) => item.id === 'happy');
      expect(happy?.kind).toBe('pose');
      const happyReason = result.reasons.find((r) => r.id === 'happy' && r.intent === 'set');
      expect(happyReason).toBeUndefined();
    });

    it('输入 "被吓一跳" → 命中 think（surprised/medium）', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '被吓一跳', replyText: '', v2Profile: profile });
      expect(result.motionId).toBe('think');
      const think = profile.motion.items.find((item) => item.id === 'think');
      expect(think?.emotion).toBe('surprised');
      expect(think?.intensity).toBe('medium');
    });
  });

  describe('ALL-280 三处保护回归（shuangsheng v3 fixture）', () => {
    it('"把外套脱了" → clear intent，slot=outerwear，无 expressionId', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '把外套脱了', replyText: '', v2Profile: profile });
      expect(result.clearSlots).toEqual(['outerwear']);
      expect(result.expressionId).toBeUndefined();
      const clearReason = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'outerwear');
      expect(clearReason).toBeDefined();
      expect(clearReason?.verb).toBe('脱');
      expect(clearReason?.source).toBe('user');
    });

    it('"把它收起来"（activeCostumeSlots=[legwear]）→ clear intent，slot=legwear', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({
        userText: '把它收起来',
        replyText: '',
        v2Profile: profile,
        activeCostumeSlots: ['legwear'],
      });
      expect(result.clearSlots).toEqual(['legwear']);
      const clearReason = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'legwear');
      expect(clearReason).toBeDefined();
      expect(clearReason?.verb).toBe('收起来');
      expect(clearReason?.source).toBe('user');
    });

    it('"外套脱掉又披上" → 冲突消解按 clear 处理', async () => {
      const profile = await loadProfile();
      const result = classifyProfileTriggers({ userText: '外套脱掉又披上', replyText: '', v2Profile: profile });
      expect(result.clearSlots).toEqual(['outerwear']);
      expect(result.expressionId).toBeUndefined();
      const clearReason = result.reasons.find((r) => r.intent === 'clear' && r.slot === 'outerwear');
      expect(clearReason).toBeDefined();
      expect(clearReason?.verb).toBe('脱掉');
    });
  });
});

describe('estella v3 classifier acceptance', () => {
  async function loadProfile(): Promise<V2Profile> {
    const profile = await loadV2Profile('estella');
    if (!profile) throw new Error('estella profile 加载失败');
    return profile;
  }

  it('输入 "变小" → 命中 Get smaller', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '变小', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBe('Get smaller');
  });

  it('输入 "钱！" → 命中 money（excited/medium）', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '钱！', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBe('money');
    const money = profile.expression.items.find((item) => item.id === 'money');
    expect(money?.emotion).toBe('excited');
    expect(money?.intensity).toBe('medium');
  });

  it('输入 "戴帽子" → 不命中 Hat1/Hat2（triggerEnabled: false）', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '戴帽子', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBeUndefined();
    expect(result.motionId).toBeUndefined();
    expect(result.reasons.filter((r) => r.intent === 'set')).toHaveLength(0);
  });
});

describe('rattan v3 classifier acceptance', () => {
  async function loadProfile(): Promise<V2Profile> {
    const profile = await loadV2Profile('rattan');
    if (!profile) throw new Error('rattan profile 加载失败');
    return profile;
  }

  it('输入 "汗死了" → 不命中 exp12（disabled）', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '汗死了', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBeUndefined();
    expect(result.motionId).toBeUndefined();
    expect(result.reasons.filter((r) => r.intent === 'set')).toHaveLength(0);
  });

  it('输入 "生气" → 命中 exp5（脸黑，angry/medium）', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '生气', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBe('exp5');
    const exp5 = profile.expression.items.find((item) => item.id === 'exp5');
    expect(exp5?.kind).toBe('emotion_expr');
    expect(exp5?.emotion).toBe('angry');
    expect(exp5?.intensity).toBe('medium');
  });

  it('输入 "摘掉马尾" → 不命中 exp18（triggerEnabled: false）', async () => {
    const profile = await loadProfile();
    const result = classifyProfileTriggers({ userText: '摘掉马尾', replyText: '', v2Profile: profile });
    expect(result.expressionId).toBeUndefined();
    expect(result.clearSlots).toEqual([]);
    expect(result.reasons.filter((r) => r.intent === 'set' || r.intent === 'clear')).toHaveLength(0);
  });
});

describe('inferTriggersFromProse', () => {
  it('舞台指示（脸红）→ 命中 lianhong expression', () => {
    const profile = buildProfile();
    const result = inferTriggersFromProse('（脸红了）那个...', profile);
    expect(result.expressionId).toBe('lianhong');
  });

  it('舞台指示（点点头）→ 命中 nod motion', () => {
    const profile = buildProfile({
      motionKeywords: { ...DEFAULT_MOTION_KEYWORDS, nod: ['点头', '好的'] },
    });
    const result = inferTriggersFromProse('（点点头）好的', profile);
    expect(result.motionId).toBe('nod');
  });

  it('全文未命中舞台指示时，扫全文兜底', () => {
    const profile = buildProfile();
    const result = inferTriggersFromProse('我脸红了', profile);
    expect(result.expressionId).toBe('lianhong');
  });

  it('舞台指示与全文冲突时，舞台指示优先', () => {
    const profile = buildProfile();
    const result = inferTriggersFromProse('（害羞了）我生气了', profile);
    // lianhong 对应 "害羞/脸红"，heilian 对应 "生气"
    expect(result.expressionId).toBe('lianhong');
  });

  it('loop=true 的 motion 不参与推断', () => {
    const profile = buildProfile();
    const dance = profile.motion.items.find((item) => item.id === 'dance');
    expect(dance).toBeDefined();
    dance!.loop = true;
    const result = inferTriggersFromProse('（跳舞）', profile);
    expect(result.motionId).toBeUndefined();
  });

  it('kind="disabled" 的 expression 不参与推断', () => {
    const profile = buildProfile();
    const lianhongItem = profile.expression.items.find((item) => item.id === 'lianhong');
    expect(lianhongItem).toBeDefined();
    lianhongItem!.kind = 'disabled';
    const result = inferTriggersFromProse('（脸红了）', profile);
    expect(result.expressionId).toBeUndefined();
  });

  it('无命中时返回空对象', () => {
    const profile = buildProfile();
    const result = inferTriggersFromProse('今天天气不错', profile);
    expect(result).toEqual({});
  });
});

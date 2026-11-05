import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadV2Profile, parseExpressionProfile, parseMotionProfile } from './v2Loader';

describe('v2Loader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('加载 shuangsheng v3 profile：motion / expression 条目与 v3_final 一致', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const profile = await loadV2Profile('shuangsheng');
    expect(profile).not.toBeNull();
    expect(profile!.role).toBe('shuangsheng');
    expect(profile!.motion.version).toBe('v3');
    expect(profile!.expression.version).toBe('v3');
    expect(profile!.motion.items.length).toBe(24);
    expect(profile!.expression.items.length).toBe(12);

    const motionIds = profile!.motion.items.map((item) => item.id);
    expect(motionIds).toContain('think');
    expect(motionIds).toContain('idle');
    expect(motionIds).toContain('blow_kiss');

    const expressionIds = profile!.expression.items.map((item) => item.id);
    expect(expressionIds).toContain('baowawa');
    expect(expressionIds).toContain('aixin');

    const disabledMotions = profile!.motion.items.filter((item) => item.kind === 'disabled');
    expect(disabledMotions.length).toBe(10);
    expect(disabledMotions.every((item) => item.keywords?.length === 0)).toBe(true);

    const costumeItems = profile!.expression.items.filter((item) => item.category === 'costume');
    expect(costumeItems.every((item) => item.slot !== undefined)).toBe(true);

    const baowawa = profile!.expression.items.find((item) => item.id === 'baowawa');
    expect(baowawa?.slot).toBe('hand_prop');

    const tousi = profile!.expression.items.find((item) => item.id === 'tousi');
    expect(tousi?.triggerEnabled).toBe(false);
    expect(tousi?.keywords).toEqual([]);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('加载 rattan v3 profile：22 个 expression / 1 个 motion，无 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const profile = await loadV2Profile('rattan');
    expect(profile).not.toBeNull();
    expect(profile!.role).toBe('rattan');
    expect(profile!.motion.version).toBe('v3');
    expect(profile!.expression.version).toBe('v3');
    expect(profile!.motion.items.length).toBe(1);
    expect(profile!.motion.items[0].id).toBe('idle');
    expect(profile!.expression.items.length).toBe(22);

    const expressionKinds = profile!.expression.items.reduce(
      (acc, item) => {
        const kind = item.kind ?? 'unknown';
        acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    expect(expressionKinds['prop']).toBe(11);
    expect(expressionKinds['emotion_expr']).toBe(3);
    expect(expressionKinds['disabled']).toBe(3);
    expect(expressionKinds['costume']).toBe(5);

    const costumeItems = profile!.expression.items.filter((item) => item.category === 'costume');
    expect(costumeItems.length).toBe(5);
    expect(costumeItems.every((item) => item.mode === 'remove' && item.triggerEnabled === false)).toBe(true);
    expect(costumeItems.map((item) => item.slot).sort()).toEqual([
      'chest_cover',
      'earwear',
      'hair',
      'headwear',
      'headwear',
    ]);

    const disabledExpressions = profile!.expression.items.filter((item) => item.kind === 'disabled');
    expect(disabledExpressions.length).toBe(3);
    expect(disabledExpressions.every((item) => item.keywords?.length === 0)).toBe(true);

    const exp5 = profile!.expression.items.find((item) => item.id === 'exp5');
    expect(exp5?.kind).toBe('emotion_expr');
    expect(exp5?.emotion).toBe('angry');
    expect(exp5?.intensity).toBe('medium');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('不存在的角色返回 null', async () => {
    const profile = await loadV2Profile('not-a-role');
    expect(profile).toBeNull();
  });

  it('costume 条目缺少 slot 时应 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    parseExpressionProfile({
      role: 'test-role',
      kind: 'expression',
      version: 'v2',
      items: [
        { id: 'c1', file: 'c1.exp3.json', category: 'costume', hint: '缺 slot' },
        { id: 'c2', file: 'c2.exp3.json', category: 'costume', hint: '非法 slot', slot: 'invalid-slot' },
        { id: 'e1', file: 'e1.exp3.json', category: 'emotion', hint: '正常 emotion' },
      ],
    });

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      '[v2 profile] costume expression 缺少或包含非法 slot',
      expect.objectContaining({ role: 'test-role', id: 'c1', category: 'costume', slot: '(missing)' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[v2 profile] costume expression 缺少或包含非法 slot',
      expect.objectContaining({ role: 'test-role', id: 'c2', category: 'costume', slot: 'invalid-slot' }),
    );
  });

  describe('v3 schema 兼容', () => {
    it('加载 version: "v3" motion profile 成功', () => {
      const profile = parseMotionProfile({
        role: 'test-role',
        kind: 'motion',
        version: 'v3',
        items: [
          {
            id: 'dance',
            file: 'dance.motion3.json',
            group: 'default',
            loop: false,
            hint: '开心蹦跶',
            kind: 'dance',
            emotion: 'happy',
            intensity: 'light',
            keywords: ['跳舞'],
          },
        ],
      });
      expect(profile.version).toBe('v3');
      expect(profile.items[0].kind).toBe('dance');
      expect(profile.items[0].emotion).toBe('happy');
      expect(profile.items[0].intensity).toBe('light');
    });

    it('加载 version: "v3" expression profile 成功', () => {
      const profile = parseExpressionProfile({
        role: 'test-role',
        kind: 'expression',
        version: 'v3',
        items: [
          {
            id: 'baisi',
            file: 'baisi.exp3.json',
            category: 'costume',
            hint: '白丝',
            slot: 'legwear',
            kind: 'costume',
            mode: 'add',
            triggerEnabled: true,
            keywords: ['白丝'],
          },
          {
            id: 'exp13',
            file: 'exp/13.exp3.json',
            category: 'costume',
            hint: '去掉耳环',
            slot: 'earwear',
            kind: 'costume',
            mode: 'remove',
            triggerEnabled: false,
          },
        ],
      });
      expect(profile.version).toBe('v3');
      expect(profile.items[0].mode).toBe('add');
      expect(profile.items[0].triggerEnabled).toBe(true);
      expect(profile.items[1].mode).toBe('remove');
      expect(profile.items[1].triggerEnabled).toBe(false);
    });

    it('未知 kind 触发 warn 且降级为 pending，加载不 throw', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const profile = parseMotionProfile({
        role: 'test-role',
        kind: 'motion',
        version: 'v3',
        items: [
          {
            id: 'weird',
            file: 'weird.motion3.json',
            group: 'default',
            loop: false,
            hint: '未知 kind',
            kind: 'not-a-kind',
          },
        ],
      });

      expect(profile.items[0].kind).toBe('pending');
      expect(warnSpy).toHaveBeenCalledWith(
        '[v2 profile] 未知 kind "not-a-kind"，降级为 pending',
        expect.objectContaining({ where: 'motion profile.items[0].kind', channel: 'motion' }),
      );
    });

    it('非白名单的 kind + 通道组合报 warn 并降级', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const profile = parseExpressionProfile({
        role: 'test-role',
        kind: 'expression',
        version: 'v3',
        items: [
          {
            id: 'weird-expr',
            file: 'weird.exp3.json',
            category: 'emotion',
            hint: 'emotion 通道放 motion kind',
            kind: 'dance',
          },
        ],
      });

      expect(profile.items[0].kind).toBe('pending');
      expect(warnSpy).toHaveBeenCalledWith(
        '[v2 profile] 未知 kind "dance"，降级为 pending',
        expect.objectContaining({ where: 'expression profile.items[0].kind', channel: 'expression' }),
      );
    });

    it('v2 老 profile（无 kind 字段）加载后 kind 被 loader 推断填充', () => {
      const motion = parseMotionProfile({
        role: 'test-role',
        kind: 'motion',
        version: 'v2',
        items: [
          {
            id: 'dance',
            file: 'dance.motion3.json',
            group: 'default',
            loop: false,
            hint: '跳舞',
          },
        ],
      });
      expect(motion.items[0].kind).toBe('emotion_motion');

      const expression = parseExpressionProfile({
        role: 'test-role',
        kind: 'expression',
        version: 'v2',
        items: [
          { id: 'heilian', file: 'heilian.exp3.json', category: 'emotion', hint: '黑脸' },
          { id: 'aixin', file: 'aixin.exp3.json', category: 'prop', hint: '爱心' },
          { id: 'baisi', file: 'baisi.exp3.json', category: 'costume', hint: '白丝', slot: 'legwear' },
        ],
      });
      expect(expression.items[0].kind).toBe('emotion_expr');
      expect(expression.items[1].kind).toBe('prop');
      expect(expression.items[2].kind).toBe('costume');
    });

    it('kind="disabled" 且 keywords 非空时打 warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      parseMotionProfile({
        role: 'test-role',
        kind: 'motion',
        version: 'v3',
        items: [
          {
            id: 'blow_kiss',
            file: 'blow_kiss.motion3.json',
            group: 'default',
            loop: false,
            hint: '剔除',
            kind: 'disabled',
            keywords: ['飞吻'],
          },
        ],
      });

      expect(warnSpy).toHaveBeenCalledWith(
        '[v2 profile] disabled 项不应挂 keywords',
        expect.objectContaining({ role: 'test-role', channel: 'motion', id: 'blow_kiss' }),
      );
    });
  });

  it('加载 estella v3 profile：1 motion + 40 expressions，无 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const profile = await loadV2Profile('estella');
    expect(profile).not.toBeNull();
    expect(profile!.role).toBe('estella');
    expect(profile!.motion.version).toBe('v3');
    expect(profile!.expression.version).toBe('v3');
    expect(profile!.motion.items.length).toBe(1);
    expect(profile!.expression.items.length).toBe(40);

    const motionIds = profile!.motion.items.map((item) => item.id);
    expect(motionIds).toContain('scene1');

    const expressionIds = profile!.expression.items.map((item) => item.id);
    expect(expressionIds).toContain('Get smaller');
    expect(expressionIds).toContain('money');

    const costumeItems = profile!.expression.items.filter((item) => item.category === 'costume');
    expect(costumeItems.length).toBe(21);
    // 21 个穿戴项已全部启用并带中文关键词（猫耳/眼镜/发型等可触发）。
    expect(costumeItems.every((item) => item.triggerEnabled !== false)).toBe(true);
    expect(costumeItems.every((item) => (item.keywords?.length ?? 0) > 0)).toBe(true);

    const getSmaller = profile!.expression.items.find((item) => item.id === 'Get smaller');
    expect(getSmaller?.kind).toBe('prop');
    expect(getSmaller?.emotion).toBe('neutral');
    expect(getSmaller?.intensity).toBe('light');

    const money = profile!.expression.items.find((item) => item.id === 'money');
    expect(money?.emotion).toBe('excited');
    expect(money?.intensity).toBe('medium');

    const wave = profile!.expression.items.find((item) => item.id === 'Wave');
    expect(wave?.hint).toBe('招手（无对应 motion，仅表情）');

    const discoloration = profile!.expression.items.find((item) => item.id === 'discoloration');
    expect(discoloration?.hint).toBe('瞳孔变黑');

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

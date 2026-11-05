import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  speciesForAvatar, voiceModeFor, ackClipsFor, allVoiceClipsFor, planAck, CRY_EXCLUDE_PREFIX, planPetCry,
} from './radioVoicePack.ts';
import { RADIO_DJ_OPTIONS } from './radioDjAvatar.ts';

/** 依次吐出给定序列的伪随机源（用完循环），让 planAck 的编排完全可预测。 */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

/** 取 samples 档的编排（cry 档没有 clips），断言用。 */
const samplePlan = (id: string, exclude?: string | null, rand?: () => number) => {
  const p = planAck(id, exclude, rand)!;
  if (p.kind !== 'samples') throw new Error(`${id} 不是 samples 档`);
  return p;
};

describe('radioVoicePack 角色→物种→发声方式', () => {
  it('电台清单里的每只 DJ 都有物种和发声方式（否则它就是个哑巴）', () => {
    for (const opt of RADIO_DJ_OPTIONS) {
      expect(speciesForAvatar(opt.id), `${opt.id} 没配物种`).not.toBeNull();
      expect(voiceModeFor(opt.id), `${opt.id} 没配发声方式`).not.toBeNull();
      expect(planAck(opt.id, null), `${opt.id} 编排不出应答`).not.toBeNull();
    }
  });

  it('★发声方式按美术风格分：写实黑猫用素材，两只卡通角色用合成', () => {
    expect(voiceModeFor('hijiki')).toBe('samples');   // 写实画风
    expect(voiceModeFor('ghostpuppy')).toBe('cry');   // 卡通造型
    expect(voiceModeFor('ghostie')).toBe('cry');
  });

  it('不认识的角色 → 全部安全回落，不抛', () => {
    expect(speciesForAvatar('nobody')).toBeNull();
    expect(voiceModeFor('nobody')).toBeNull();
    expect(ackClipsFor('nobody')).toEqual([]);
    expect(planAck('nobody', null)).toBeNull();
  });
});

describe('radioVoicePack 合成档（卡通角色）', () => {
  it('返回 cry 编排，且不需要任何素材（预热清单为空）', () => {
    for (const id of ['ghostpuppy', 'ghostie']) {
      const p = planAck(id, null, seq(0.5))!;
      expect(p.kind).toBe('cry');
      // 合成不占素材体积，也没有东西要预热
      expect(ackClipsFor(id)).toEqual([]);
      expect(allVoiceClipsFor(id)).toEqual([]);
    }
  });

  it('★变化的主体是"挑哪种叫法"：随机能覆盖到全部变体，不是永远同一条', () => {
    for (const id of ['ghostpuppy', 'ghostie']) {
      const seen = new Set<number>();
      // 扫一遍 [0,1) 应当覆盖到该音色的所有变体
      for (let k = 0; k < 40; k += 1) {
        const p = planAck(id, null, seq(k / 40))!;
        if (p.kind !== 'cry') throw new Error('应为 cry 档');
        seen.add(p.variant);
      }
      expect(seen.size, `${id} 只挑得出 ${seen.size} 种叫法——Ben 反馈过"就一两条"`)
        .toBeGreaterThanOrEqual(5);
    }
  });

  it('不会连着两次用同一种叫法（exclude 记的是变体下标）', () => {
    for (const id of ['ghostpuppy', 'ghostie']) {
      for (let v = 0; v < 5; v += 1) {
        for (const r of [0, 0.2, 0.5, 0.8, 0.999]) {
          const p = planAck(id, `${CRY_EXCLUDE_PREFIX}${v}`, seq(r))!;
          if (p.kind !== 'cry') throw new Error('应为 cry 档');
          expect(p.variant).not.toBe(v);
        }
      }
    }
  });

  it('每次的音高/时长都有随机偏移——这是"不重复"的来源', () => {
    for (const id of ['ghostpuppy', 'ghostie']) {
      for (const r of [0, 0.5, 0.999]) {
        const p = planAck(id, null, seq(r))!;
        if (p.kind !== 'cry') throw new Error('应为 cry 档');
        // 偏移要有，但不能大到听着像另一只动物
        expect(p.pitch).toBeGreaterThanOrEqual(0.94 - 1e-9);
        expect(p.pitch).toBeLessThanOrEqual(1.06 + 1e-9);
        expect(p.speed).toBeGreaterThanOrEqual(0.92 - 1e-9);
        expect(p.speed).toBeLessThanOrEqual(1.08 + 1e-9);
      }
    }
  });
});

describe('radioVoicePack 素材档（写实黑猫）', () => {
  it('猫池只留 Ben 试听后点名的三条（尖锐的 meow-short/meow-kitten/mwa 已剔除）', () => {
    const cat = ackClipsFor('hijiki').map((u) => u.split('/').pop());
    expect(cat.sort()).toEqual(['meow-demand.ogg', 'mew-purr.ogg', 'mew-soft.ogg']);
  });

  it('预热清单 == 应答池（否则第一声要现场解码 ~175ms）', () => {
    expect(allVoiceClipsFor('hijiki')).toEqual(ackClipsFor('hijiki'));
    expect(ackClipsFor('hijiki').length).toBeGreaterThan(0);
  });

  it('猫只叫一声，三个数组等长，首声间隔恒为 0', () => {
    for (const r of [0, 0.4, 0.99]) {
      const p = samplePlan('hijiki', null, seq(r));
      expect(p.clips).toHaveLength(1);
      expect(p.gaps).toHaveLength(1);
      expect(p.rates).toHaveLength(1);
      expect(p.gaps[0]).toBe(0);
    }
  });

  it('变速永远在 ±7% 内——超出会明显走音，不再像同一只猫', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      for (const rate of samplePlan('hijiki', null, seq(r)).rates) {
        // 1e-9 容差：1-0.07 在浮点里是 0.9299999999999999，卡死边界会假红
        expect(rate).toBeGreaterThanOrEqual(0.93 - 1e-9);
        expect(rate).toBeLessThanOrEqual(1.07 + 1e-9);
      }
    }
  });

  it('不会连着两次以同一声开头（exclude 生效）', () => {
    for (const prev of ackClipsFor('hijiki')) {
      for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.999]) {
        expect(samplePlan('hijiki', prev, seq(r)).clips[0]).not.toBe(prev);
      }
    }
  });

  it('排除一个不在池里的值时全池仍可选（不会挑空）', () => {
    const plan = samplePlan('hijiki', '/不存在的.ogg', seq(0));
    expect(ackClipsFor('hijiki')).toContain(plan.clips[0]);
  });
});

describe('radioVoicePack 素材落地', () => {
  it('应答池引用的每个音频文件都真的在 public/ 下存在', () => {
    const missing: string[] = [];
    for (const opt of RADIO_DJ_OPTIONS) {
      for (const url of ackClipsFor(opt.id)) {
        const abs = resolve(process.cwd(), 'public', url.replace(/^\//, ''));
        if (!existsSync(abs)) missing.push(url);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe('planPetCry', () => {
  it('幽灵狗（cat 音色）按心情点名变体：撒娇=5、疑问=3、嘟囔=4、着急=6、招呼=7', () => {
    const rand = () => 0; // 池首
    expect(planPetCry('ghostpuppy', 'happy', rand)).toMatchObject({ kind: 'cry', voice: 'cat', variant: 5 });
    expect(planPetCry('ghostpuppy', 'curious', rand)).toMatchObject({ variant: 3 });
    expect(planPetCry('ghostpuppy', 'grumble', rand)).toMatchObject({ variant: 4 });
    expect(planPetCry('ghostpuppy', 'plead', rand)).toMatchObject({ variant: 6 });
    expect(planPetCry('ghostpuppy', 'greet', rand)).toMatchObject({ variant: 7 });
  });
  it('小幽灵（ghost 音色 5 变体）变体不越界', () => {
    for (const mood of ['happy', 'delight', 'curious', 'grumble', 'plead', 'greet'] as const) {
      for (const r of [0, 0.5, 0.99]) {
        const p = planPetCry('ghostie', mood, () => r);
        expect(p).not.toBeNull();
        if (p?.kind === 'cry') expect(p.variant).toBeLessThan(5);
      }
    }
  });
  it('黑猫（素材档）：单声 + 心情定基准变速（嘟囔低落 0.85 附近）', () => {
    const p = planPetCry('hijiki', 'grumble', () => 0.5);
    expect(p?.kind).toBe('samples');
    if (p?.kind === 'samples') {
      expect(p.clips).toHaveLength(1);
      expect(p.clips[0]).toContain('/radio/voices/cat/');
      expect(p.rates[0]).toBeGreaterThan(0.8);
      expect(p.rates[0]).toBeLessThan(0.9);
    }
  });
  it('没有音库的角色返回 null', () => {
    expect(planPetCry('yumi', 'happy')).toBeNull();
  });
});

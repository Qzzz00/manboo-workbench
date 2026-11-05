import { describe, expect, it } from 'vitest';
import {
  paramNameToSemanticAction,
  buildSemanticBindings,
  classifyExp3,
  seedEmotionsForExp3,
  exp3FileToNativeUnit,
  canonicalEmotionUnits,
} from './bootstrapRules.mjs';

// ──────────────────────────────────────────────────────────────────────────
// 参数名 → SemanticAction 正则映射
// ──────────────────────────────────────────────────────────────────────────
describe('paramNameToSemanticAction', () => {
  it('映射标准 Live2D 眼睛/眉毛/嘴/头参数', () => {
    expect(paramNameToSemanticAction('ParamEyeLOpen')).toBe('eye.open.left');
    expect(paramNameToSemanticAction('ParamEyeROpen')).toBe('eye.open.right');
    expect(paramNameToSemanticAction('ParamEyeBallX')).toBe('eye.gaze.x');
    expect(paramNameToSemanticAction('ParamEyeBallY')).toBe('eye.gaze.y');
    expect(paramNameToSemanticAction('ParamMouthOpenY')).toBe('mouth.open');
    expect(paramNameToSemanticAction('ParamMouthForm')).toBe('mouth.smile');
    expect(paramNameToSemanticAction('ParamBrowLY')).toBe('brow.height.left');
    expect(paramNameToSemanticAction('ParamBrowRY')).toBe('brow.height.right');
    expect(paramNameToSemanticAction('ParamAngleX')).toBe('head.yaw');
    expect(paramNameToSemanticAction('ParamAngleY')).toBe('head.pitch');
    expect(paramNameToSemanticAction('ParamAngleZ')).toBe('head.roll');
  });

  it('EyeLSmile/EyeRSmile 归到 mouth.smile 辅助', () => {
    expect(paramNameToSemanticAction('ParamEyeLSmile')).toBe('mouth.smile');
    expect(paramNameToSemanticAction('ParamEyeRSmile')).toBe('mouth.smile');
  });

  it('大小写不敏感（容忍模型作者命名差异）', () => {
    expect(paramNameToSemanticAction('PARAMEYELOPEN')).toBe('eye.open.left');
    expect(paramNameToSemanticAction('parammouthopeny')).toBe('mouth.open');
  });

  it('容忍 L/R 后缀在词尾的命名变体（ParamEyeOpenL / ParamBrowYL）', () => {
    // yumi 模型采用后缀式命名
    expect(paramNameToSemanticAction('ParamEyeOpenL')).toBe('eye.open.left');
    expect(paramNameToSemanticAction('ParamEyeOpenR')).toBe('eye.open.right');
    expect(paramNameToSemanticAction('ParamEyeSmileL')).toBe('mouth.smile');
    expect(paramNameToSemanticAction('ParamEyeSmileR')).toBe('mouth.smile');
    expect(paramNameToSemanticAction('ParamBrowYL')).toBe('brow.height.left');
    expect(paramNameToSemanticAction('ParamBrowYR')).toBe('brow.height.right');
  });

  it('ParamMouthX → mouth.x', () => {
    expect(paramNameToSemanticAction('ParamMouthX')).toBe('mouth.x');
  });

  it('未命中的参数返回 null（物理/身体/数字枚举参数跳过）', () => {
    expect(paramNameToSemanticAction('ParamBodyAngleX')).toBeNull();
    expect(paramNameToSemanticAction('Param27')).toBeNull();
    expect(paramNameToSemanticAction('胸物理y1')).toBeNull();
    expect(paramNameToSemanticAction('ParamBreath')).toBeNull();
  });
});

describe('buildSemanticBindings', () => {
  it('从参数名清单生成 semanticBindings，命中即绑定 paramId+linear curve', () => {
    const params = ['ParamEyeLOpen', 'ParamMouthForm', 'ParamBodyAngleX', 'Param27'];
    const bindings = buildSemanticBindings(params);
    expect(bindings['eye.open.left']).toEqual({ paramId: 'ParamEyeLOpen', curve: 'linear' });
    expect(bindings['mouth.smile']).toEqual({ paramId: 'ParamMouthForm', curve: 'linear' });
    // 跳过未命中
    expect(Object.keys(bindings)).toHaveLength(2);
  });

  it('mouth.smile 优先用主参 ParamMouthForm（即便 EyeSmile 在参数清单更靠前）', () => {
    // EyeSmile 是 auxiliary；MouthForm 是主参 → 不论顺序，主参胜出
    expect(buildSemanticBindings(['ParamMouthForm', 'ParamEyeLSmile'])['mouth.smile']?.paramId).toBe(
      'ParamMouthForm',
    );
    expect(buildSemanticBindings(['ParamEyeLSmile', 'ParamMouthForm'])['mouth.smile']?.paramId).toBe(
      'ParamMouthForm',
    );
  });

  it('只有 EyeSmile（无 MouthForm）时退而用 EyeSmile 作 mouth.smile', () => {
    expect(buildSemanticBindings(['ParamEyeLSmile'])['mouth.smile']?.paramId).toBe('ParamEyeLSmile');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// exp3 文件名分类：emotion / apparel / morph
// ──────────────────────────────────────────────────────────────────────────
describe('classifyExp3', () => {
  it('形态类（变小/变大/chibi）归 morph', () => {
    expect(classifyExp3('Get smaller.exp3.json')).toBe('morph');
    expect(classifyExp3('giant.exp3.json')).toBe('morph');
    expect(classifyExp3('chibi_form.exp3.json')).toBe('morph');
  });

  it('服饰类（帽子/猫耳/眼镜/发型）归 apparel', () => {
    expect(classifyExp3('Hat1.exp3.json')).toBe('apparel');
    expect(classifyExp3('Cat ears.exp3.json')).toBe('apparel');
    expect(classifyExp3('Glasses.exp3.json')).toBe('apparel');
    expect(classifyExp3('Hairstyle3.exp3.json')).toBe('apparel');
    expect(classifyExp3('headband.exp3.json')).toBe('apparel');
  });

  it('情绪/通用表情归 emotion', () => {
    expect(classifyExp3('angry.exp3.json')).toBe('emotion');
    expect(classifyExp3('cry.exp3.json')).toBe('emotion');
    expect(classifyExp3('Wink.exp3.json')).toBe('emotion');
    expect(classifyExp3('loving eyes.exp3.json')).toBe('emotion');
  });

  // —— 中文 / 拼音分类 ——
  it('中文/拼音形态名归 morph', () => {
    expect(classifyExp3('变小.exp3.json')).toBe('morph');
    expect(classifyExp3('正太.exp3.json')).toBe('morph');
    expect(classifyExp3('bianxiao.exp3.json')).toBe('morph');
    expect(classifyExp3('xiaohai.exp3.json')).toBe('morph');
  });

  it('中文/拼音服饰名归 apparel（发型/眼罩/外套/换装/丝袜）', () => {
    expect(classifyExp3('短发1.exp3.json')).toBe('apparel');
    expect(classifyExp3('眼罩.exp3.json')).toBe('apparel');
    expect(classifyExp3('换装.exp3.json')).toBe('apparel');
    expect(classifyExp3('waitao.exp3.json')).toBe('apparel'); // 外套
    expect(classifyExp3('huanzhuang.exp3.json')).toBe('apparel'); // 换装
    expect(classifyExp3('baisi.exp3.json')).toBe('apparel'); // 白丝
    expect(classifyExp3('duanfa.exp3.json')).toBe('apparel'); // 短发
  });

  it('中文/拼音一次性动作名归 gesture（抬手/拿话筒/俯身/按键/挥手/点头/唱歌）', () => {
    expect(classifyExp3('抬手左.exp3.json')).toBe('gesture');
    expect(classifyExp3('拿话筒.exp3.json')).toBe('gesture');
    expect(classifyExp3('俯身按键.exp3.json')).toBe('gesture');
    expect(classifyExp3('挥手.exp3.json')).toBe('gesture');
    expect(classifyExp3('点头.exp3.json')).toBe('gesture');
    expect(classifyExp3('changge.exp3.json')).toBe('gesture'); // 唱歌
    expect(classifyExp3('fushen.exp3.json')).toBe('gesture'); // 俯身
  });

  it('英文 Wave 归 gesture（不再误当 apparel/emotion）', () => {
    expect(classifyExp3('Wave.exp3.json')).toBe('gesture');
    expect(classifyExp3('raise_hand.exp3.json')).toBe('gesture');
  });

  it('中文口型/眼型若无明确语义仍归 emotion（猫猫嘴不被裸「猫」误判 apparel）', () => {
    expect(classifyExp3('猫猫嘴.exp3.json')).toBe('emotion');
    expect(classifyExp3('歪嘴.exp3.json')).toBe('emotion');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// exp3 文件名 → 情绪播种
// ──────────────────────────────────────────────────────────────────────────
describe('seedEmotionsForExp3', () => {
  it('happy* → {happy:0.8}', () => {
    expect(seedEmotionsForExp3('happy.exp3.json')).toEqual({ happy: 0.8 });
    expect(seedEmotionsForExp3('happy_big.exp3.json')).toEqual({ happy: 0.8 });
  });

  it('angry* → {angry:0.8}', () => {
    expect(seedEmotionsForExp3('angry.exp3.json')).toEqual({ angry: 0.8 });
  });

  it('cry/sad* → {sad:0.8}', () => {
    expect(seedEmotionsForExp3('cry.exp3.json')).toEqual({ sad: 0.8 });
    expect(seedEmotionsForExp3('sad.exp3.json')).toEqual({ sad: 0.8 });
  });

  it('wink/smile/loving* → {happy:0.6}', () => {
    expect(seedEmotionsForExp3('Wink.exp3.json')).toEqual({ happy: 0.6 });
    expect(seedEmotionsForExp3('smile.exp3.json')).toEqual({ happy: 0.6 });
    expect(seedEmotionsForExp3('loving eyes.exp3.json')).toEqual({ happy: 0.6 });
  });

  it('shy* → {shy:0.7}', () => {
    expect(seedEmotionsForExp3('shy.exp3.json')).toEqual({ shy: 0.7 });
  });

  it('surprise* → {surprised:0.8}', () => {
    expect(seedEmotionsForExp3('surprise.exp3.json')).toEqual({ surprised: 0.8 });
    expect(seedEmotionsForExp3('stars.exp3.json')).toEqual({ surprised: 0.8 });
  });

  it('命不中给 {neutral:0.3} 占位待人工调', () => {
    expect(seedEmotionsForExp3('dizzy.exp3.json')).toEqual({ neutral: 0.3 });
    expect(seedEmotionsForExp3('money.exp3.json')).toEqual({ neutral: 0.3 });
  });

  // —— 中文 / 拼音情绪播种 ——
  it('中文/拼音强情绪：开心/笑→happy:0.8，生气/怒→angry:0.8，哭→sad:0.8', () => {
    expect(seedEmotionsForExp3('开心.exp3.json')).toEqual({ happy: 0.8 });
    expect(seedEmotionsForExp3('大笑.exp3.json')).toEqual({ happy: 0.8 });
    expect(seedEmotionsForExp3('生气.exp3.json')).toEqual({ angry: 0.8 });
    expect(seedEmotionsForExp3('怒.exp3.json')).toEqual({ angry: 0.8 });
    expect(seedEmotionsForExp3('哭.exp3.json')).toEqual({ sad: 0.8 });
  });

  it('中文/拼音 sad：泪汪汪/眼泪/泪→sad:0.8（yanlei）', () => {
    expect(seedEmotionsForExp3('泪汪汪.exp3.json')).toEqual({ sad: 0.8 });
    expect(seedEmotionsForExp3('眼泪.exp3.json')).toEqual({ sad: 0.8 });
    expect(seedEmotionsForExp3('yanlei.exp3.json')).toEqual({ sad: 0.8 });
  });

  it('中文/拼音 surprised：星星眼/星星/惊讶/吃惊→surprised:0.8', () => {
    expect(seedEmotionsForExp3('星星眼.exp3.json')).toEqual({ surprised: 0.8 });
    expect(seedEmotionsForExp3('惊讶.exp3.json')).toEqual({ surprised: 0.8 });
    expect(seedEmotionsForExp3('吃惊.exp3.json')).toEqual({ surprised: 0.8 });
  });

  it('中文/拼音 shy：害羞/脸红→shy:0.7（lianhong），且不被黑脸/heilian 误判为 angry', () => {
    expect(seedEmotionsForExp3('害羞.exp3.json')).toEqual({ shy: 0.7 });
    expect(seedEmotionsForExp3('脸红.exp3.json')).toEqual({ shy: 0.7 });
    expect(seedEmotionsForExp3('lianhong.exp3.json')).toEqual({ shy: 0.7 });
  });

  it('中文/拼音 gentle/excited：温柔→gentle:0.7，兴奋→excited:0.8', () => {
    expect(seedEmotionsForExp3('温柔.exp3.json')).toEqual({ gentle: 0.7 });
    expect(seedEmotionsForExp3('wenrou.exp3.json')).toEqual({ gentle: 0.7 });
    expect(seedEmotionsForExp3('兴奋.exp3.json')).toEqual({ excited: 0.8 });
  });

  it('中文/拼音弱信号：爱心眼/爱心→happy:0.6(aixin)，眨眼/挤眼→happy:0.6', () => {
    expect(seedEmotionsForExp3('爱心眼.exp3.json')).toEqual({ happy: 0.6 });
    expect(seedEmotionsForExp3('aixin.exp3.json')).toEqual({ happy: 0.6 });
    expect(seedEmotionsForExp3('眨眼.exp3.json')).toEqual({ happy: 0.6 });
    expect(seedEmotionsForExp3('jiyan.exp3.json')).toEqual({ happy: 0.6 }); // 挤眼
  });

  it('黑脸→angry:0.6（heilian，弱怒，区别于生气/怒的 0.8）', () => {
    expect(seedEmotionsForExp3('黑脸.exp3.json')).toEqual({ angry: 0.6 });
    expect(seedEmotionsForExp3('heilian.exp3.json')).toEqual({ angry: 0.6 });
  });

  it('微笑→happy:0.6（不被「笑」的 0.8 规则吞掉，weixiao）', () => {
    expect(seedEmotionsForExp3('微笑.exp3.json')).toEqual({ happy: 0.6 });
    expect(seedEmotionsForExp3('weixiao.exp3.json')).toEqual({ happy: 0.6 });
  });

  it('无明确语义的中文/拼音名仍给 {neutral:0.3} 占位（晕/蚊香眼）', () => {
    expect(seedEmotionsForExp3('yun.exp3.json')).toEqual({ neutral: 0.3 }); // 晕
    expect(seedEmotionsForExp3('蚊香眼.exp3.json')).toEqual({ neutral: 0.3 });
  });

  it('情绪值只用 8 个合法情绪枚举，不含 Ekman 专属(fear/disgust)', () => {
    const seeds = ['happy', 'angry', 'cry', 'sad', 'wink', 'shy', 'surprise', 'dizzy'].map((n) =>
      seedEmotionsForExp3(`${n}.exp3.json`),
    );
    const valid = new Set(['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy', 'gentle', 'excited']);
    for (const s of seeds) {
      for (const k of Object.keys(s)) expect(valid.has(k)).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// exp3 → NativeExpressionUnit（含 apparel/morph 标记，跳过情绪播种）
// ──────────────────────────────────────────────────────────────────────────
describe('exp3FileToNativeUnit', () => {
  it('情绪类 exp3 产出含 emotions 的 native unit', () => {
    const unit = exp3FileToNativeUnit('angry.exp3.json', ['ParamBrowLY', 'ParamMouthForm']);
    expect(unit.id).toBe('native:angry');
    expect(unit.nativeRef).toBe('angry.exp3.json');
    expect(unit.category).toBeUndefined();
    expect(unit.emotions).toEqual({ angry: 0.8 });
    // region 由 exp3 touch 的参数推导
    expect(unit.regions).toEqual(expect.arrayContaining(['brow', 'mouth']));
  });

  it('apparel exp3 标 category=apparel 且不播种情绪', () => {
    const unit = exp3FileToNativeUnit('Hat1.exp3.json', ['Param40']);
    expect(unit.category).toBe('apparel');
    expect(unit.emotions).toEqual({});
  });

  it('morph exp3 标 category=morph 且不播种情绪', () => {
    const unit = exp3FileToNativeUnit('Get smaller.exp3.json', ['ParamBodyAngleX']);
    expect(unit.category).toBe('morph');
    expect(unit.emotions).toEqual({});
  });

  it('名字认不出 + 不碰任何面部参数 → 归 prop 不播种（rattan「向下移动消失」根因）', () => {
    // rattan 的 "5.exp3.json" 只把自定义 Param87 设成 1，是参数开关不是表情。
    const unit = exp3FileToNativeUnit('5.exp3.json', ['Param87']);
    expect(unit.category).toBe('prop');
    expect(unit.emotions).toEqual({});
    // loli/大Q 同理（名字没进 morph 词表 + 只碰自定义参数）→ prop，不会被 solver 当情绪挑中
    expect(exp3FileToNativeUnit('loli.exp3.json', ['Param120', 'Param127']).category).toBe('prop');
  });

  it('名字认不出但碰面部参数 → 仍按情绪占位，不误降 prop', () => {
    const unit = exp3FileToNativeUnit('99.exp3.json', ['ParamMouthForm']);
    expect(unit.category).toBeUndefined();
    expect(unit.emotions).toEqual({ neutral: 0.3 });
  });
});

describe('canonicalEmotionUnits', () => {
  // rattan 实绑的标准面部动作（左右 + 单侧）
  const rattanActions = new Set([
    'eye.open.left', 'eye.open.right', 'mouth.smile', 'mouth.open',
    'eye.gaze.x', 'eye.gaze.y', 'brow.height.left', 'brow.height.right', 'mouth.x',
  ]);

  it('为绑定了面部参数的角色生成 7 种情绪语义单元(neutral 除外)，各带相关性', () => {
    const units = canonicalEmotionUnits(rattanActions);
    const emotions = units.map((u) => Object.keys(u.emotions)[0]);
    expect(units.length).toBe(7);
    expect(new Set(emotions)).toEqual(
      new Set(['happy', 'sad', 'angry', 'surprised', 'shy', 'gentle', 'excited']),
    );
    for (const u of units) {
      expect(u.type).toBe('semantic');
      expect(Object.values(u.emotions)[0]).toBe(0.9);
      expect(u.targets.length).toBeGreaterThan(0);
    }
  });

  it('base 动作(eye.open/brow.height)展开为角色实际绑定的 .left/.right', () => {
    const happy = canonicalEmotionUnits(rattanActions).find((u) => u.emotions.happy);
    const actions = happy!.targets.map((t) => t.action);
    // happy 含 eye.open → 应展开成 eye.open.left + eye.open.right
    expect(actions).toContain('eye.open.left');
    expect(actions).toContain('eye.open.right');
    expect(actions).toContain('mouth.smile');
  });

  it('所有 target 值钳在 SemanticAction 合法范围内且 min<=max', () => {
    for (const u of canonicalEmotionUnits(rattanActions)) {
      for (const t of u.targets) {
        expect(t.min).toBeLessThanOrEqual(t.max);
        const lo = t.action.startsWith('eye.open') || t.action === 'mouth.open' ? 0 : -1;
        expect(t.min).toBeGreaterThanOrEqual(lo);
        expect(t.max).toBeLessThanOrEqual(1);
      }
    }
  });

  it('未绑定任何所需动作 → 跳过该情绪(不产空 target 单元)', () => {
    const units = canonicalEmotionUnits(new Set(['head.yaw'])); // 只绑头部,无面部
    expect(units).toEqual([]);
  });

  it('gesture exp3（中文）标 category=gesture 且不播种情绪', () => {
    const unit = exp3FileToNativeUnit('拿话筒.exp3.json', ['ParamBodyAngleX']);
    expect(unit.category).toBe('gesture');
    expect(unit.emotions).toEqual({});
  });

  it('apparel exp3（中文短发）标 category=apparel 且不播种情绪', () => {
    const unit = exp3FileToNativeUnit('短发1.exp3.json', ['Param40']);
    expect(unit.category).toBe('apparel');
    expect(unit.emotions).toEqual({});
  });

  it('情绪类 exp3（中文星星眼）产出含 emotions 的 native unit', () => {
    const unit = exp3FileToNativeUnit('星星眼.exp3.json', ['ParamEyeLOpen']);
    expect(unit.category).toBeUndefined();
    expect(unit.emotions).toEqual({ surprised: 0.8 });
  });

  it('含子目录的 exp3 引用：nativeRef 保留完整相对路径，id/分类用 basename', () => {
    const unit = exp3FileToNativeUnit('exp/happy.exp3.json', ['ParamMouthForm']);
    expect(unit.nativeRef).toBe('exp/happy.exp3.json');
    expect(unit.id).toBe('native:happy');
    expect(unit.emotions).toEqual({ happy: 0.8 });
  });
});

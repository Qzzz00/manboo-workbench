import { describe, it, expect } from 'vitest';
import { isEmotionDomainParam, filterEmotionParams } from './emotionDomain.ts';

describe('isEmotionDomainParam', () => {
  it('接受眉/眼/头/脸颊/嘴角形状', () => {
    for (const id of ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBrowLY', 'ParamBrowRY',
      'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthForm',
      'ParamCheek', 'ParamBodyAngleX', 'ParamBodyAngleZ']) {
      expect(isEmotionDomainParam(id)).toBe(true);
    }
  });
  // shuangsheng.profile.json 实际使用的 target id，之前被白名单遗漏(11/25)，
  // 导致 filterEmotionParams 静默丢弃了最强的情绪线索(笑眼/挑眉/腮红/眼泪/呼吸)。
  it('接受 shuangsheng.profile.json 实际使用但曾被遗漏的 target id', () => {
    for (const id of [
      'ParamEyeLSmile', 'ParamEyeRSmile',
      'ParamBrowLAngle', 'ParamBrowRAngle',
      'ParamBrowLForm', 'ParamBrowRForm',
      'Param54', 'Param55', // 腮红
      'Param52', 'Param88', // 眼泪
      'ParamBreath',
    ]) {
      expect(isEmotionDomainParam(id)).toBe(true);
    }
  });
  it('拒绝口型开合与换装参数', () => {
    for (const id of ['ParamMouthOpenY', 'ParamMouthOpen', 'Param67', 'ParamHairFront']) {
      expect(isEmotionDomainParam(id)).toBe(false);
    }
  });
  it('数字命名参数用精确匹配，换装 Param67 绝不能被数字白名单误放行', () => {
    // 回归护栏：防止未来把 SHUANGSHENG_NUMBERED_EMOTION_PARAM_IDS 换成 /^Param\d+$/ 之类宽正则。
    expect(isEmotionDomainParam('Param67')).toBe(false);
  });
});

describe('filterEmotionParams', () => {
  it('保留情绪域、剔除非情绪域，并报告与保留区的冲突', () => {
    const params = { ParamAngleX: 10, ParamMouthOpenY: 0.8, Param67: 1, ParamBrowLY: 0.5 };
    const { kept, conflicts } = filterEmotionParams(params, { costumeIds: ['Param67'], mouthIds: ['ParamMouthOpenY'] });
    expect([...kept.entries()]).toEqual([['ParamAngleX', 10], ['ParamBrowLY', 0.5]]);
    expect(conflicts).toEqual([]);
  });
  it('若情绪域参数与保留区撞车，计入 conflicts 且不保留', () => {
    // 假设某误配 profile 把 ParamAngleX 也列为 costume
    const { kept, conflicts } = filterEmotionParams({ ParamAngleX: 10 }, { costumeIds: ['ParamAngleX'], mouthIds: [] });
    expect(kept.has('ParamAngleX')).toBe(false);
    expect(conflicts).toEqual(['ParamAngleX']);
  });
});

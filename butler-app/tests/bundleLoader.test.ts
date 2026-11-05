import { describe, expect, it } from 'vitest';
import { rewriteModelSettings, manifestFromBundle, pickAvatar } from '../src/live2d/bundleLoader';

const files = new Map<string, string>([
  ['hijiki/hijiki.model3.json', 'blob:model'],
  ['hijiki/hijiki.moc3', 'blob:moc'],
  ['hijiki/hijiki.2048/texture_00.png', 'blob:tex0'],
  ['hijiki/hijiki.physics3.json', 'blob:phy'],
  ['hijiki/expressions/happy.exp3.json', 'blob:happy'],
  ['hijiki/motions/idle.motion3.json', 'blob:idle'],
  ['hijiki/motions/wave.motion3.json', 'blob:wave'],
]);

const settings = {
  Version: 3,
  FileReferences: {
    Moc: 'hijiki.moc3',
    Textures: ['hijiki.2048/texture_00.png'],
    Physics: 'hijiki.physics3.json',
    Expressions: [{ Name: 'happy', File: 'expressions/happy.exp3.json' }],
    Motions: {
      Idle: [{ File: 'motions/idle.motion3.json' }],
      TapBody: [{ File: 'motions/wave.motion3.json', Sound: 'missing.wav' }],
    },
  },
  Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] }],
};

describe('rewriteModelSettings:把 model3.json 里的相对路径换成包内文件的 blob URL', () => {
  it('Moc / Textures / Physics / Expressions / Motions 都换;包里没有的原样留着', () => {
    const out = rewriteModelSettings(settings, 'hijiki/hijiki.model3.json', files);
    const refs = out.FileReferences as Record<string, unknown>;
    expect(refs.Moc).toBe('blob:moc');
    expect(refs.Textures).toEqual(['blob:tex0']);
    expect(refs.Physics).toBe('blob:phy');
    expect(refs.Expressions).toEqual([{ Name: 'happy', File: 'blob:happy' }]);
    expect((refs.Motions as Record<string, Array<Record<string, string>>>).TapBody[0]).toEqual({ File: 'blob:wave', Sound: 'missing.wav' });
    expect(out.Groups).toEqual(settings.Groups);
  });
  it('不改传入的对象', () => {
    rewriteModelSettings(settings, 'hijiki/hijiki.model3.json', files);
    expect(settings.FileReferences.Moc).toBe('hijiki.moc3');
  });
});

describe('manifestFromBundle:凑一份引擎能吃的 AvatarManifest', () => {
  it('modelJson 指向重写后的 settings 的 blob;表情与动作从 settings 里抽;transform 用后端给的', () => {
    const rewritten = rewriteModelSettings(settings, 'hijiki/hijiki.model3.json', files);
    const manifest = manifestFromBundle({
      avatar: { id: 'hijiki', name: '小黑', summary: '猫', transform: { scaleMultiplier: 1.2, verticalOffset: 0.1, headAnchorY: 0.2 } },
      settings: rewritten,
      settingsUrl: 'blob:settings',
    });
    expect(manifest.id).toBe('hijiki');
    expect(manifest.name).toBe('小黑');
    expect(manifest.modelJson).toBe('blob:settings');
    expect(manifest.scaleMultiplier).toBe(1.2);
    expect(manifest.verticalOffset).toBe(0.1);
    expect(manifest.headAnchorY).toBe(0.2);
    expect(manifest.expressions).toEqual([{ id: 'happy', label: 'happy', kind: 'emotion', prompt: 'happy', binding: { mode: 'file', file: 'blob:happy' } }]);
    expect(manifest.motions).toEqual({ Idle: { file: 'blob:idle' }, TapBody: { file: 'blob:wave' } });
    expect(manifest.transformDefaults).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });
  it('transform 缺省 → 1 / 0;没有表情动作也不抛', () => {
    const manifest = manifestFromBundle({ avatar: { id: 'a', name: 'A' }, settings: { FileReferences: {} }, settingsUrl: 'blob:s' });
    expect(manifest.scaleMultiplier).toBe(1);
    expect(manifest.expressions).toEqual([]);
    expect(manifest.motions).toBeUndefined();
  });
});

describe('pickAvatar:形象取第一个已发布的;记住的那个还在就用它', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  it('没记过 → 第一个', () => { expect(pickAvatar(list, null)?.id).toBe('a'); });
  it('记过且还在 → 记的那个', () => { expect(pickAvatar(list, 'b')?.id).toBe('b'); });
  it('记的那个没了 → 第一个;列表空 → undefined', () => {
    expect(pickAvatar(list, 'zzz')?.id).toBe('a');
    expect(pickAvatar([], 'a')).toBeUndefined();
  });
});

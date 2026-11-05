import { describe, expect, it } from 'vitest';
import { BEAT, LOOP, joinUrl, withPackMotions } from './packModel';

describe('形象包的模型设置', () => {
  it('路径逐段编码(包里有中文文件名),保留斜杠;base 补斜杠', () => {
    expect(joinUrl('./avatars/sanhuamao', '三花猫.model3.json')).toBe('./avatars/sanhuamao/%E4%B8%89%E8%8A%B1%E7%8C%AB.model3.json');
    expect(joinUrl('http://localhost/x/', 'motions/idle.motion3.json')).toBe('http://localhost/x/motions/idle.motion3.json');
  });
  it('★动作以目录为准:模型自己没登记的(29 海边阳台)、新写的 pack-motions 都塞进去,原有的别的设置不动', () => {
    const item = { id: 'a', name: 'A', base: './', entry: 'a.model3.json', subject: { x0: 0, y0: 0, x1: 1, y1: 1 }, backdrop: null, idle: { loop: ['motions/idle.motion3.json'], beats: ['pack-motions/heart.motion3.json'], muteMouth: false } };
    const out = withPackMotions({ Version: 3, FileReferences: { Moc: 'a.moc3', Motions: { old: [] } } }, item, 'URL') as { url: string; FileReferences: Record<string, unknown> };
    expect(out.url).toBe('URL');
    expect(out.FileReferences.Moc).toBe('a.moc3');
    expect(out.FileReferences.Motions).toEqual({ [LOOP]: [{ File: 'motions/idle.motion3.json' }], [BEAT]: [{ File: 'pack-motions/heart.motion3.json' }] });
  });
  it('★目录没给待机动作(上传的形象包):模型自己登记的动作原样留着,不清空成两组空的', () => {
    const item = { id: 'm1', name: 'M', base: './', entry: 'm.model3.json', subject: { x0: 0, y0: 0, x1: 1, y1: 1 }, backdrop: null, idle: { loop: [], beats: [], muteMouth: false } };
    const own = { Idle: [{ File: 'motions/idle.motion3.json' }], TapBody: [{ File: 'motions/tap.motion3.json' }] };
    const out = withPackMotions({ FileReferences: { Moc: 'm.moc3', Motions: own } }, item, 'URL') as { url: string; FileReferences: Record<string, unknown> };
    expect(out.url).toBe('URL');
    expect(out.FileReferences.Motions).toEqual(own);
  });
});

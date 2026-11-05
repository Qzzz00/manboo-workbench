import { describe, expect, it } from 'vitest';
import { romBaseName, romDir, saveCandidates } from './saveFile.ts';

describe('romBaseName', () => {
  it('砍掉扩展名', () => {
    expect(romBaseName('/storage/emulated/0/GBA/空之花神.gba')).toBe('空之花神');
  });

  it('名字里本来就带点时只砍最后一段', () => {
    // 汉化组的文件名长这样：口袋妖怪改版 空之花神 补完汉化完结版(8.23)2.2.gba
    expect(romBaseName('/GBA/口袋妖怪改版 空之花神 补完汉化完结版(8.23)2.2.gba'))
      .toBe('口袋妖怪改版 空之花神 补完汉化完结版(8.23)2.2');
  });

  it('没有扩展名就原样返回', () => {
    expect(romBaseName('/GBA/rom')).toBe('rom');
  });

  it('全名就是扩展名时不砍成空串', () => {
    expect(romBaseName('.gba')).toBe('.gba');
  });
});

describe('romDir', () => {
  it('取目录', () => {
    expect(romDir('/storage/emulated/0/GBA/a.gba')).toBe('/storage/emulated/0/GBA');
  });

  it('没有目录时回落到外部存储根', () => {
    expect(romDir('a.gba')).toBe('/storage/emulated/0');
  });
});

describe('saveCandidates', () => {
  const c = saveCandidates('/storage/emulated/0/GBA/空之花神.gba');

  it('先找 RetroArch 的存档目录，再找 ROM 同级', () => {
    expect(c.map((x) => x.dir)).toEqual([
      '/storage/emulated/0/RetroArch/saves',
      '/storage/emulated/0/GBA',
    ]);
  });

  it('两种命名都找：去扩展名的与整个文件名加 .srm 的', () => {
    expect(c[0].names).toEqual(['空之花神.srm', '空之花神.gba.srm']);
  });

  it('都要扫一层子目录（RetroArch 可能按核心名分目录）', () => {
    expect(c.every((x) => x.scanSubdirs)).toBe(true);
  });

  it('不去 states 目录找——那里是即时存档，跟 .srm 无关', () => {
    expect(c.some((x) => x.dir.endsWith('/states'))).toBe(false);
  });

  it('没有 ROM 路径时给空清单，而不是去猜一个', () => {
    expect(saveCandidates('')).toEqual([]);
  });
});

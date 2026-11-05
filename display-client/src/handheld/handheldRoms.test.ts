import { describe, it, expect } from 'vitest';
import { romDisplayName, launchTargetForRom, sortRoms, ROM_SOURCES } from './handheldRoms.ts';

const rom = (fileName: string, path = `/storage/emulated/0/GBA/${fileName}`) => ({
  path,
  fileName,
  sizeBytes: 1024,
});

describe('romDisplayName', () => {
  // 掌机上真实的 7 个文件名（2026-07-29 实测）。这些名字直接显示会很难看，
  // 但**过度清洗会把游戏名本身洗掉**，所以只砍确定无意义的部分。
  it('去掉扩展名', () => {
    expect(romDisplayName(rom('Metal Slug Advance (C).gba'))).toBe('Metal Slug Advance');
  });

  it('去掉汉化组/版本尾巴，保留游戏名', () => {
    expect(romDisplayName(rom('口袋妖怪改版 决心汉化版beta1.0.gba'))).toBe('口袋妖怪改版 决心');
    expect(romDisplayName(rom('口袋妖怪 漆黑的魅影 5.0EX 无尽混沌 BW.gba')))
      .toBe('口袋妖怪 漆黑的魅影 5.0EX 无尽混沌 BW');
  });

  it('去掉方括号标签与体积标注', () => {
    expect(romDisplayName(rom('召唤之夜 - 铸剑物语 2[啪嗒啪嗒](v1.0) [简](JP)(136.31Mb).gba')))
      .toBe('召唤之夜 - 铸剑物语 2');
  });

  it('前缀 gba 与年份/版本噪音', () => {
    expect(romDisplayName(rom('gba矿石镇2013完美汉化2021.11最终修正版.gba'))).toBe('矿石镇');
  });

  // ★兜底比好看重要：洗到空了就把原文件名还回去，绝不能显示一个空格子。
  it('洗成空则回落原名（去扩展名）', () => {
    expect(romDisplayName(rom('汉化版.gba'))).toBe('汉化版');
    expect(romDisplayName(rom('[简].gba'))).toBe('[简]');
  });
});

describe('launchTargetForRom', () => {
  it('.gba → RetroArch + mGBA 核心', () => {
    expect(launchTargetForRom(rom('x.gba'))).toEqual({ app: 'retroarch', core: 'mgba_libretro_android.so' });
  });
  it('.gb / .gbc 也走 mGBA（它同时支持 GB/GBC）', () => {
    expect(launchTargetForRom(rom('x.gbc'))).toEqual({ app: 'retroarch', core: 'mgba_libretro_android.so' });
  });
  // PS1 归 DuckStation：Ben 指定，且他的画面配置与存档都在 DuckStation 那边。
  it('.bin / .cue / .chd → DuckStation', () => {
    for (const f of ['x.bin', 'x.cue', 'x.chd']) {
      expect(launchTargetForRom(rom(f)), f).toEqual({ app: 'duckstation' });
    }
  });
  // NDS 归 DraStic：它自己声明了 ACTION_VIEW + *.nds filter，走标准「打开文件」。
  it('.nds → DraStic', () => {
    expect(launchTargetForRom(rom('x.nds'))).toEqual({ app: 'drastic' });
  });
  // PSP 归 PPSSPP：它同样自己声明了 ACTION_VIEW + *.iso/*.cso filter。
  it('.iso / .cso → PPSSPP', () => {
    for (const f of ['x.iso', 'x.cso']) {
      expect(launchTargetForRom(rom(f, `/storage/emulated/0/PSP/ISO/${f}`)), f)
        .toEqual({ app: 'ppsspp' });
    }
  });
  // ★.chd 两边都吃（PPSSPP 也支持），但归属只能有一个：留给 PS1/DuckStation。
  // 真要放 PSP 的 chd 再改成「按来源目录判」，那是另一次改动（Ben 2026-07-31 拍板）。
  it('.chd 仍归 DuckStation，不被 PSP 抢走', () => {
    expect(launchTargetForRom(rom('x.chd', '/storage/emulated/0/PSP/ISO/x.chd')))
      .toEqual({ app: 'duckstation' });
  });
  it('未知扩展名返回 null，调用侧应忽略而不是瞎开', () => {
    expect(launchTargetForRom(rom('x.txt'))).toBeNull();
  });
});

describe('ROM_SOURCES（扫哪些目录）', () => {
  it('包含 PSP（ROM 在 /PSP/ISO 下，maxDepth=2 正好够到）', () => {
    const psp = ROM_SOURCES.find((s) => s.dir === 'PSP');
    expect(psp?.extensions).toContain('iso');
  });

  // ★真护栏：加了目录却忘了加扩展名映射，桌面上会出现一个点了没反应的格子
  // （launchTargetForRom 返回 null → HandheldGameGrid 的 launch() 直接 return）。
  it('每个源目录声明的扩展名都能解析出模拟器，不会列出点不开的格子', () => {
    for (const src of ROM_SOURCES) {
      for (const ext of src.extensions) {
        const target = launchTargetForRom({
          path: `/storage/emulated/0/${src.dir}/x.${ext}`,
          fileName: `x.${ext}`,
          sizeBytes: 1,
        });
        expect(target, `${src.dir}/*.${ext}`).not.toBeNull();
      }
    }
  });
});

describe('sortRoms', () => {
  it('按显示名排序，不改动入参', () => {
    const input = [rom('b.gba'), rom('a.gba')];
    const copy = [...input];
    expect(sortRoms(input).map((r) => r.fileName)).toEqual(['a.gba', 'b.gba']);
    expect(input).toEqual(copy);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  coverCandidates,
  groupByPlatform,
  loadSelectedPlatform,
  saveSelectedPlatform,
  type RomItem,
} from './handheldCovers.ts';

function installLocalStorageStub() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

const item = (platform: string, fileName: string, rootDir: string): RomItem => ({
  path: `${rootDir}/${fileName}`,
  fileName,
  sizeBytes: 1,
  platform,
  rootDir,
});

describe('coverCandidates（封面图放哪）', () => {
  // 约定：封面放在**平台根目录**的 covers/ 下，与 ROM 同名（不含扩展名）。
  it('ROM 与封面同名，封面在平台根目录的 covers/ 下', () => {
    const rom = item('GBA', '矿石镇.gba', '/storage/emulated/0/GBA');
    expect(coverCandidates(rom)[0]).toBe('/storage/emulated/0/GBA/covers/矿石镇.png');
  });

  // ★PSP 的 ROM 在 /PSP/ISO/ 里，封面仍归 /PSP/covers/——按平台根目录而不是 ROM 所在目录，
  // 否则每个子文件夹都得建一个 covers（PS1 一游戏一文件夹时更荒唐）。
  it('ROM 在子目录里时，封面仍在平台根目录下', () => {
    const rom: RomItem = {
      path: '/storage/emulated/0/PSP/ISO/战神.iso',
      fileName: '战神.iso',
      sizeBytes: 1,
      platform: 'PSP',
      rootDir: '/storage/emulated/0/PSP',
    };
    expect(coverCandidates(rom)[0]).toBe('/storage/emulated/0/PSP/covers/战神.png');
  });

  // png 找不到再试 jpg：我推图时统一转 png，但 Ben 自己丢图不该被格式卡住。
  it('png 之后回落 jpg', () => {
    const rom = item('GBA', 'x.gba', '/storage/emulated/0/GBA');
    expect(coverCandidates(rom)).toEqual([
      '/storage/emulated/0/GBA/covers/x.png',
      '/storage/emulated/0/GBA/covers/x.jpg',
    ]);
  });

  it('文件名含多个点时只去掉最后一段扩展名', () => {
    const rom = item('GBA', '决心汉化版beta1.0.gba', '/storage/emulated/0/GBA');
    expect(coverCandidates(rom)[0]).toBe('/storage/emulated/0/GBA/covers/决心汉化版beta1.0.png');
  });
});

describe('groupByPlatform（顶部 tab 的数据）', () => {
  const roms: RomItem[] = [
    item('GBA', 'a.gba', '/storage/emulated/0/GBA'),
    item('PSP', 'b.iso', '/storage/emulated/0/PSP'),
    item('GBA', 'c.gba', '/storage/emulated/0/GBA'),
  ];

  it('按平台聚起来并带计数', () => {
    expect(groupByPlatform(roms)).toEqual([
      { platform: 'GBA', roms: [roms[0], roms[2]] },
      { platform: 'PSP', roms: [roms[1]] },
    ]);
  });

  // 没游戏的平台不该占一个 tab——空 tab 点进去是空屏，纯噪音。
  it('没有游戏的平台不出现', () => {
    expect(groupByPlatform([roms[1]]).map((g) => g.platform)).toEqual(['PSP']);
  });

  it('保持传入顺序（= ROM_SOURCES 的顺序），不按数量排', () => {
    const reordered = [roms[1], roms[0]];
    expect(groupByPlatform(reordered).map((g) => g.platform)).toEqual(['PSP', 'GBA']);
  });
});

describe('选中的平台 tab（下次进来还在上次那个）', () => {
  beforeEach(() => installLocalStorageStub());

  it('存了能读回来', () => {
    saveSelectedPlatform('PSP');
    expect(loadSelectedPlatform(['GBA', 'PSP'])).toBe('PSP');
  });

  it('没存过 → 第一个可用平台', () => {
    expect(loadSelectedPlatform(['GBA', 'PSP'])).toBe('GBA');
  });

  // ★存着 NDS 但这次 NDS 目录读不到/被清空了 → 不能停在一个不存在的 tab 上（空屏）。
  it('存的平台这次没有游戏 → 回落第一个可用平台', () => {
    saveSelectedPlatform('NDS');
    expect(loadSelectedPlatform(['GBA', 'PSP'])).toBe('GBA');
  });

  it('一个平台都没有 → null，调用侧显示空态', () => {
    expect(loadSelectedPlatform([])).toBeNull();
  });
});

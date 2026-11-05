// 游戏格的封面与平台分组。全是纯函数 + 一个 localStorage 读写，可测。
//
// 封面约定：`/<平台根目录>/covers/<与 ROM 同名>.png`（找不到再试 .jpg）。
// ★没有「扫一遍封面目录」这一步：路径直接算出来交给 <img>，加载失败就 onError 回落色块。
//   这样零原生改动、也不多一次 IO——有图自动亮，没图不难看。

import type { RomEntry } from './handheldRoms.ts';

/** ROM + 它来自哪个平台源（listRoms 只返回文件本身，平台是前端按 ROM_SOURCES 打的标）。 */
export type RomItem = RomEntry & {
  /** 平台显示名，如 "GBA"。同时是 tab 文案与分组键。 */
  platform: string;
  /** 平台根目录绝对路径（listRoms 返回的 dir），如 "/storage/emulated/0/PSP"。 */
  rootDir: string;
};

const KEY_SELECTED = 'aiboo:handheld-platform-tab';

function baseName(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i < 0 ? fileName : fileName.slice(0, i);
}

/**
 * 该 ROM 的封面候选路径，按优先级排列（.png → .jpg）。
 * ★按**平台根目录**而不是 ROM 所在目录：PSP 的 ROM 在 /PSP/ISO/ 下、PS1 常一游戏一文件夹，
 * 若跟着 ROM 走就得在每个子文件夹里建 covers，投放和维护都荒唐。
 */
export function coverCandidates(rom: RomItem): string[] {
  const base = baseName(rom.fileName);
  return [`${rom.rootDir}/covers/${base}.png`, `${rom.rootDir}/covers/${base}.jpg`];
}

export type PlatformGroup = { platform: string; roms: RomItem[] };

/**
 * 按平台聚成分组（顶部 tab 的数据源）。
 * 保持传入顺序 = ROM_SOURCES 的顺序，不按数量排：tab 位置固定，肌肉记忆才成立。
 * 没有游戏的平台不会出现——空 tab 点进去是空屏，纯噪音。
 */
export function groupByPlatform(roms: RomItem[]): PlatformGroup[] {
  const out: PlatformGroup[] = [];
  const byName = new Map<string, PlatformGroup>();
  for (const rom of roms) {
    let g = byName.get(rom.platform);
    if (!g) {
      g = { platform: rom.platform, roms: [] };
      byName.set(rom.platform, g);
      out.push(g);
    }
    g.roms.push(rom);
  }
  return out;
}

export function saveSelectedPlatform(platform: string): void {
  try {
    localStorage.setItem(KEY_SELECTED, platform);
  } catch {
    /* 存不了只是下次回到第一个 tab，不值得打断 */
  }
}

/**
 * 上次选中的平台 tab；不可用时回落第一个。
 * ★必须拿 available 校验：存着 NDS 但这次 NDS 目录读不到，直接用会停在一个空 tab 上。
 */
export function loadSelectedPlatform(available: string[]): string | null {
  if (available.length === 0) return null;
  try {
    const saved = localStorage.getItem(KEY_SELECTED);
    if (saved && available.includes(saved)) return saved;
  } catch {
    /* 读不到就当没存过 */
  }
  return available[0];
}

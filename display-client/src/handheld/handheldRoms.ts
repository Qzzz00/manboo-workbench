// 掌机桌面的 ROM 处理：文件名清洗、核心选择、排序。全是纯函数，可测。
//
// 设计取向：**宁可留噪音，也不能把游戏名洗掉**。这些文件名来自各路汉化组，
// 花样无穷（`gba矿石镇2013完美汉化2021.11最终修正版.gba`），想洗干净必然过度匹配。
// 所以只砍确定无意义的部分，且洗成空就回落原名——桌面上出现一个空格子比留着噪音糟得多。

export type RomEntry = {
  /** ROM 绝对路径，直接交给 RetroArch。 */
  path: string;
  fileName: string;
  sizeBytes: number;
};

/**
 * 扩展名 → 用哪个模拟器开。
 * 不同平台归不同 App：GBA 走 RetroArch（该机装了 gpSP 与 mGBA 两个核心，选 mGBA 兼容性更好），
 * PS1 走 DuckStation（Ben 指定，且它的画面/存档配置都在那边）。
 */
export type LaunchTarget =
  | { app: 'retroarch'; core: string }
  | { app: 'duckstation' }
  | { app: 'drastic' }
  | { app: 'ppsspp' };

const TARGET_BY_EXT: Record<string, LaunchTarget> = {
  gba: { app: 'retroarch', core: 'mgba_libretro_android.so' },
  gb: { app: 'retroarch', core: 'mgba_libretro_android.so' },
  gbc: { app: 'retroarch', core: 'mgba_libretro_android.so' },
  // NDS 归 DraStic（Ben 指定）。它有正规的 ACTION_VIEW + *.nds filter，不用猜 extra。
  nds: { app: 'drastic' },
  // PS1 光盘镜像的几种常见容器
  bin: { app: 'duckstation' },
  cue: { app: 'duckstation' },
  chd: { app: 'duckstation' },
  img: { app: 'duckstation' },
  pbp: { app: 'duckstation' },
  // PSP 归 PPSSPP。它也自己声明了 ACTION_VIEW + *.iso/*.cso（+*.chd）filter。
  // ★.chd/.pbp 两边都吃，这里归属给 PS1——本函数只看扩展名、不看来自哪个目录，
  //   一个扩展名只能有一个归属。Ben 的 PSP 游戏都是 .iso，真出现 PSP 的 chd 再改成
  //   「按来源目录判」（要改本函数签名 + 调用侧，是另一次改动）。
  iso: { app: 'ppsspp' },
  cso: { app: 'ppsspp' },
};

/**
 * 要扫的 ROM 目录（相对外部存储根）。加平台就在这里加一行，
 * 并确保新扩展名在 TARGET_BY_EXT 里有归属（handheldRoms.test.ts 有一致性护栏）。
 *
 * ★maxDepth=2（本层 + 一层子目录，见 HandheldPlugin.listRoms）：三种摆法都得支持——
 *   /GBA/xxx.gba            扁平（Ben 的 GBA）
 *   /PS1/猫犬协奏曲/xxx.bin  一游戏一文件夹（PS1 光盘镜像常这么放）
 *   /PSP/ISO/xxx.iso        PPSSPP 自己建的固定目录结构（还有 SAVEDATA/TEXTURES 等兄弟目录，
 *                           里面没有 iso/cso，白走一趟无害）
 */
export const ROM_SOURCES: { dir: string; extensions: string[] }[] = [
  { dir: 'GBA', extensions: ['gba', 'gb', 'gbc'] },
  { dir: 'PS1', extensions: ['bin', 'cue', 'chd', 'img', 'pbp'] },
  { dir: 'NDS', extensions: ['nds'] },
  { dir: 'PSP', extensions: ['iso', 'cso'] },
];

function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase();
}

/** ROM 该用哪个模拟器开；未知扩展名返回 null（调用侧应忽略而不是瞎开）。 */
export function launchTargetForRom(rom: RomEntry): LaunchTarget | null {
  return TARGET_BY_EXT[extensionOf(rom.fileName)] ?? null;
}

// 确定无意义、砍掉不会伤到游戏名的片段。顺序有讲究：先砍括号块，再砍尾巴词。
const NOISE_PATTERNS: RegExp[] = [
  /\[[^\]]*\]/g,                      // [啪嗒啪嗒] [简]
  /\([^)]*\)/g,                       // (C) (JP) (136.31Mb) (v1.0)
  /（[^）]*）/g,                        // 全角括号同理
  // ★长词必须排在短词前面：`汉化` 那条会把 `完美汉化` 拆成 `完美`，
  //   再轮到 `完美汉化` 时已经匹配不上了（实测踩过）。
  /补完汉化完结版/g,
  /完美汉化/g,
  /汉化版?(beta)?[\d.]*/gi,            // 汉化 / 汉化版 / 汉化版beta1.0
  /最终修正版|修正版|完结版|测试版/g,
  /\bv?\d+(\.\d+)+\b/g,               // 2021.11 / v1.0
];

/**
 * 文件名 → 显示名。
 * ★洗到空就回落「去扩展名的原文件名」：桌面上一个空格子比一堆噪音糟得多。
 */
export function romDisplayName(rom: RomEntry): string {
  const ext = extensionOf(rom.fileName);
  const base = ext ? rom.fileName.slice(0, -(ext.length + 1)) : rom.fileName;

  let s = base;
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  // 常见的平台前缀（`gba矿石镇…`），只在紧贴开头时砍，免得误伤名字里含 gba 的游戏
  s = s.replace(/^(gba|gbc|gb|nds|snes|nes)\s*/i, '');
  // 年份噪音：4 位数字且不像游戏名的一部分。
  // ★前导字符要捕获再放回（$1），不能直接吞——`矿石镇2013` 的 `镇` 会被一起吃掉（实测踩过）。
  // 用捕获组而非后行断言 (?<=...)：项目里禁用后行断言，老 WebView(Chrome 61) 会整个模块 SyntaxError。
  s = s.replace(/(^|[^A-Za-z0-9])(19|20)\d{2}(?![A-Za-z0-9])/g, '$1 ');
  s = s.replace(/\s+/g, ' ').trim();
  // 收尾残留的连接符
  s = s.replace(/^[-–—·]\s*/, '').replace(/\s*[-–—·]$/, '').trim();

  return s.length > 0 ? s : base;
}

/** 按显示名排序。返回新数组，不改动入参。泛型是为了不丢调用侧加挂的字段（如 RomItem.platform）。 */
export function sortRoms<T extends RomEntry>(roms: T[]): T[] {
  return [...roms].sort((a, b) => romDisplayName(a).localeCompare(romDisplayName(b)));
}

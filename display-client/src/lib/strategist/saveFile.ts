// RetroArch 存档（.srm）在掌机上到底摆在哪 —— 候选路径推导。
//
// ★为什么是「候选 + 挑最新的」而不是一条写死的路径：存档目录是 RetroArch 的配置项
// （savefile_directory / sort_savefiles_enable），真值写在
// /storage/emulated/0/Android/data/com.retroarch.aarch64/files/retroarch.cfg 里，
// 而 Android 11+ 起**别的 App 读不到 Android/data 下别人的目录**（File 与 SAF 都不行）。
// 所以我们读不到那份配置，只能在几个已知的常见落点里找。
// 找不到就是找不到——原生侧如实回 found:false，军师退回「没有进度」的老行为，不猜。
//
// 逻辑放在 TS 而不是 Kotlin：文件名推导（去扩展名、名字里本来就带点、
// RetroArch 有时会用整个文件名加 .srm）是纯逻辑，值得单测；
// 原生那边只做「按这份清单去磁盘上找，返回最新的那个」的笨活。

export type SaveCandidate = {
  /** 绝对目录 */
  dir: string;
  /** 该目录下要找的文件名（多个，按可能性排序） */
  names: string[];
  /**
   * true = 连它的**一层**子目录一起找。
   * RetroArch 开了 sort_savefiles_enable 时会按核心名分子目录（saves/mGBA/xxx.srm）；
   * 核心名不确定（该机装了 gpSP 与 mGBA 两个），所以扫一层而不是猜名字。
   */
  scanSubdirs?: boolean;
};

const EXTERNAL_ROOT = '/storage/emulated/0';

/** ROM 路径 → 存档基名。`口袋妖怪 空之花神 2.2.gba` → `口袋妖怪 空之花神 2.2` */
export function romBaseName(romPath: string): string {
  const file = romPath.split('/').pop() ?? romPath;
  const dot = file.lastIndexOf('.');
  // 只砍最后一段扩展名，且名字里全是点（`.gba`）时不砍成空串
  return dot > 0 ? file.slice(0, dot) : file;
}

export function romDir(romPath: string): string {
  const i = romPath.lastIndexOf('/');
  return i > 0 ? romPath.slice(0, i) : EXTERNAL_ROOT;
}

/**
 * 按「最可能」到「最不可能」排出候选。原生侧会把所有命中的都 stat 一遍、取 mtime 最新的，
 * 所以顺序只影响并列时谁赢，不影响正确性。
 */
export function saveCandidates(romPath: string): SaveCandidate[] {
  if (!romPath) return [];
  const base = romBaseName(romPath);
  const file = romPath.split('/').pop() ?? romPath;
  // 两种命名都见过：去扩展名的（RetroArch 默认）与整个文件名后缀 .srm 的
  const names = [`${base}.srm`, `${file}.srm`];
  return [
    { dir: `${EXTERNAL_ROOT}/RetroArch/saves`, names, scanSubdirs: true },
    // ROM 同级：savefile_directory 留空时 RetroArch 就把存档写在内容旁边。
    // 该机 /GBA 下还有个模拟器自建的 mGBA 目录（见 handheldRoms.ts 的注释），一并扫。
    { dir: romDir(romPath), names, scanSubdirs: true },
  ];
  // ★刻意**不**去找 RetroArch/states：那里放的是即时存档（.state），是模拟器私有格式
  // 且与 .srm 无关。把它列进来只是在装作多找了一处。
}

// 节目单(program)时间线：把「按时段分块、块内循环」的日程序，按当前时刻（距本地零点的毫秒）
// 解析成「该播哪个 item、从多深处起播、多久后重算」。纯函数，便于单测，不碰 DOM/时钟。
//
// 模型：一天分若干时段(daypart)，各时段一个节目块(items 串成时间线)；块时长 < 时段长则块内循环
// 填满该时段。客户端进入电台时按 wall-clock 算「当前时段 + 块内偏移」，从对应 item 半路起播。

export type ProgramItemKind = 'track' | 'tts';

export interface ProgramItem {
  id: string;
  kind: ProgramItemKind;
  duration_ms: number;
  offset_ms: number; // 在所属时段块内的起始偏移（items 从 0 起无缝排布）
  // track:
  ncm_id?: string;
  title?: string;
  artist?: string;
  pic_url?: string; // 网易云专辑封面
  // tts:
  audio_url?: string;
  text?: string;
  role?: string;
}

export interface Daypart {
  key: string;
  name: string;
  start_ms: number; // 距本地零点，[0, DAY_MS)
  end_ms: number; // 不含；最后一个时段 end_ms = DAY_MS
  block_duration_ms: number; // 块总时长(循环长度) = Σ item.duration_ms
  items: ProgramItem[]; // 按 offset_ms 升序
}

export interface DayProgram {
  date: string; // YYYY-MM-DD（本地）
  generated_at?: string;
  dayparts: Daypart[];
}

export interface ProgramPosition {
  daypart: Daypart;
  item: ProgramItem;
  seekMs: number; // 从 item 的这个位置起播
  nextResolveInMs: number; // 多久后重新解析（item 播完 或 时段切换，取先到者）
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Date → 距本地零点的毫秒，[0, DAY_MS)。 */
export function msSinceLocalMidnight(now: Date): number {
  return (
    now.getHours() * 3600000 +
    now.getMinutes() * 60000 +
    now.getSeconds() * 1000 +
    now.getMilliseconds()
  );
}

function findDaypart(program: DayProgram, msOfDay: number): Daypart | null {
  for (const dp of program.dayparts) {
    if (msOfDay >= dp.start_ms && msOfDay < dp.end_ms) return dp;
  }
  return null;
}

/**
 * 解析当前应播位置。
 * @param msOfDay 距本地零点毫秒 [0, DAY_MS)
 * @returns null 表示当前时刻无可播内容（节目单空 / 该时段无 item），调用方应进入待机并稍后重算。
 */
export function resolveProgramPosition(
  program: DayProgram | null | undefined,
  msOfDay: number,
): ProgramPosition | null {
  if (!program || !Array.isArray(program.dayparts) || program.dayparts.length === 0) return null;

  const dp = findDaypart(program, msOfDay);
  if (!dp) return null;

  const untilDaypartEnd = dp.end_ms - msOfDay;
  const items = dp.items || [];
  const blockMs =
    dp.block_duration_ms || items.reduce((sum, it) => sum + (it.duration_ms || 0), 0);
  if (items.length === 0 || blockMs <= 0) {
    // 该时段无内容：待机，到时段结束再重算
    return null;
  }

  // 块内位置（循环）
  let p = (msOfDay - dp.start_ms) % blockMs;
  if (p < 0) p += blockMs;

  // 找覆盖 p 的 item（items 按 offset_ms 升序、连续无缝）
  let chosen = items[0];
  for (const it of items) {
    if (p >= it.offset_ms && p < it.offset_ms + it.duration_ms) {
      chosen = it;
      break;
    }
  }

  const seekMs = Math.max(0, p - chosen.offset_ms);
  const untilItemEnd = Math.max(0, chosen.duration_ms - seekMs);
  const nextResolveInMs = Math.max(0, Math.min(untilItemEnd, untilDaypartEnd));

  return { daypart: dp, item: chosen, seekMs, nextResolveInMs };
}

// ---- 顺序点播模型（新版 useDj 用）：只判「当前在哪个时段」，不做循环/半路 seek ----

/**
 * 当前时刻落在哪个时段。
 *
 * ★缝隙回落（fallbackToNearest）：后端生成的节目单**会留空档**——实测 2026-08-19 的
 * focus 单是 00-06 / 06-11 / 14-18 / 18-22 / 22-24，**11:00–14:00 整段没有时段**。
 * 严格按墙钟判定时这三小时 resolveCurrentDaypart 返回 null，电台直接进 idle：
 * 界面停在「电台准备中」、一声不响，而且看不出是坏了还是本来就没节目。
 * 常驻桌面电台每天哑三小时是缺陷不是设计，所以允许回落到**最近的一个时段**
 * （优先取已经过去的那个，没有就取后面最近的）。
 * 不改后端节目单结构，纯客户端兜底。
 */
export function resolveCurrentDaypart(
  program: DayProgram | null | undefined,
  msOfDay: number,
  options: { fallbackToNearest?: boolean } = {},
): Daypart | null {
  if (!program || !Array.isArray(program.dayparts)) return null;
  for (const dp of program.dayparts) {
    if (msOfDay >= dp.start_ms && msOfDay < dp.end_ms) return dp;
  }
  if (options.fallbackToNearest !== true) return null;

  const withItems = program.dayparts.filter((dp) => Array.isArray(dp.items) && dp.items.length > 0);
  if (withItems.length === 0) return null;
  // 先找「已经结束、离现在最近」的那个：缝隙里接着刚播完的时段最自然。
  const past = withItems.filter((dp) => dp.end_ms <= msOfDay);
  if (past.length > 0) {
    return past.reduce((best, dp) => (dp.end_ms > best.end_ms ? dp : best));
  }
  // 现在还早于所有时段（例如凌晨空档）：取最先开始的那个。
  return withItems.reduce((best, dp) => (dp.start_ms < best.start_ms ? dp : best));
}

/**
 * 把一个时段拆成「开场口播 + 歌曲列表」。
 * intro 取第一条 role='intro' 的口播，没有则取第一条口播；歌曲保持原顺序。
 * 顺序点播模型只在「该时段当天首次打开」时播 intro，之后只顺播歌曲。
 */
export function splitDaypart(daypart: Daypart | null | undefined): {
  intro: ProgramItem | null;
  tracks: ProgramItem[];
} {
  const items = (daypart && daypart.items) || [];
  const tracks = items.filter((i) => i.kind === 'track');
  const intro =
    items.find((i) => i.kind === 'tts' && i.role === 'intro') ||
    items.find((i) => i.kind === 'tts') ||
    null;
  return { intro, tracks };
}

/**
 * 引导里「她在找你的项目」那一行字与球的执行中样子(2026-09-24;傍晚按维护者拍板改成「整段等待」,
 * 卡 fix/scan-orb-working-whole-wait)。
 *
 * 维护者原话:「扫描的时候,粒子球应该变成工作的状态……」。拍板:**粒子球就是 loading** ——
 * 从她开始找项目、读仓库那一刻,到她开口说结果为止,球一直是执行中样子;她一开口就回到说话的样子。
 * 那一行小灰字(「正在找你的项目…」「正在读 X 的说明…」)保留作补充;只有全量扫描时带「已看 N/M」。
 *
 * 数据:`GET /onboarding/turns` 回包里的 `scan`(服务端 onboardingActivity.ts 的窗口 view):
 *   `{ scanning, phase: 'list'|'repos'|'read', done, total?, current?, started_at?, finished_at?, last_read?, id?, held? }`。
 *   `scanning:true` = 窗口开着:DSH 那条路(本页与电脑首次流程)从动手找一直开到**回合表里她的下一句**;
 *   `id` = 第几段窗口(收了之后留着最后那一段的号);`held` = 活儿做完了、在等她开口。
 *   read = 她拿到点头之后读那个项目的说明和最近记录,`current` 是项目名;认不得的 phase 照「正在找你的项目… <current>」显示。
 *
 * 这个文件管两件事:
 *   1. 那一行字怎么说(scanLineOf / scanReadLine,与电脑端 onboardingStage.ts 逐字一致);
 *   2. **文字引导页**(DSH 那条路)的「等她开口」窗口 {@link nextReplyWindow} / {@link useReplyWindow}:
 *      看到服务端窗口开着就进执行中;**她的新一句出现**(并且朗读开了口,或者不朗读)就收;
 *      服务端窗口收了而且她那一轮也收场了就收;保险时限到了也收。收了的那一段服务端还报着也不重开。
 * 引导**通话**页走的是工人的工具信号(当场进、她开口就收),见 scanWindow.ts。
 *
 * 与电脑端 workbench-plugin/src/client/firstrun/scanHold.ts + onboardingStage.ts 口径、文案逐条一致(两端不互相 import)。
 */
import { useEffect, useRef, useState } from 'react';
import type { StageMode } from '../swarm/orbState';

export interface ScanProgress {
  scanning: boolean;
  /** list = 在扫描根里找有哪些仓库(总数未知);repos = 逐个读仓库;read = 读一个项目的说明和最近记录(2026-09-24)。 */
  phase?: 'list' | 'repos' | 'read';
  done?: number;
  total?: number;
  /** 此刻在看的目录(路径或名字);read 阶段是项目名。 */
  current?: string;
  /** 上一次扫描结束的时刻(ms,服务端 finished_at)。 */
  finishedAt?: number;
  /** 上一轮读完的那个项目(服务端 last_read)。 */
  lastRead?: string;
  /** 服务端第几段窗口(2026-09-24 傍晚;老服务端没有)。 */
  id?: number;
  /** 活儿做完了、窗口还开着在等她开口。 */
  held?: boolean;
}

/** 服务端回包里 scan 的原样形状。 */
export interface ScanWire {
  scanning: boolean;
  phase?: 'list' | 'repos' | 'read';
  last_read?: string;
  done?: number;
  total?: number;
  current?: string;
  started_at?: string;
  finished_at?: string;
  id?: number;
  held?: boolean;
}

export const SCAN_LINE = '正在找你的项目…';
export const SCAN_LIST_LINE = '正在看有哪些文件夹…';
/**
 * read 阶段那一句(与电脑端 onboardingStage.ts scanReadLine 同一句)。
 * 2026-09-24 统筹:375 宽的屏上要整句看得见 —— 收短成「正在读 <名> 的说明…」,名字太长(显示宽度 > {@link SCAN_READ_NAME_MAX},
 * 中文算 2)就只说「正在读它的说明…」;样式那一条(.ba-onboarding__scan / .ba-call__scan)另外允许折成最多两行。
 */
export const SCAN_READ_NAME_MAX = 24;
export const SCAN_READ_FALLBACK = '正在读它的说明…';
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return width;
}
export function scanReadLine(name?: string): string {
  const trimmed = name?.trim() ?? '';
  if (trimmed === '' || displayWidth(trimmed) > SCAN_READ_NAME_MAX) return SCAN_READ_FALLBACK;
  return `正在读 ${trimmed} 的说明…`;
}
/** 引导通话里拿扫描进度的轮询间隔(只负责补字:找的是谁、读的是谁、全量进度)。 */
export const CALL_SCAN_POLL_MS = 1_500;
/**
 * 文字引导页:她的新一句出来之后,最多等朗读开口多久(2026-09-24 傍晚)。朗读要先去合成(半秒到两秒),
 * 这一段球不该先闪回待命再变说话;朗读没开成(没配 / 网断)就到点收。
 */
export const REPLY_VOICE_GRACE_MS = 4_000;
/** 窗口开着、服务端多久没再说「还在」就收(保险)。服务端自己撑 30 秒(ACTIVITY_HOLD_MAX_MS),这里略长一点。 */
export const REPLY_WINDOW_MAX_MS = 40_000;

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** 从回包读扫描进度:认 `{ scan: {...} }` 与顶层 `{ scanning, ... }`;认不出回 undefined(= 没给信号)。 */
export function scanProgressOf(raw: unknown): ScanProgress | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const inner = typeof record.scan === 'object' && record.scan !== null ? record.scan as Record<string, unknown> : record;
  if (typeof inner.scanning !== 'boolean') return undefined;
  const done = finite(inner.done), total = finite(inner.total), id = finite(inner.id);
  const current = typeof inner.current === 'string' && inner.current.trim() !== '' ? inner.current.trim() : undefined;
  // 认不得的 phase(更新的服务端)不当错:缺席,那一行照「正在找你的项目… <current>」显示。
  const phase = inner.phase === 'list' || inner.phase === 'repos' || inner.phase === 'read' ? inner.phase : undefined;
  const finishedAt = typeof inner.finished_at === 'string' ? Date.parse(inner.finished_at) : Number.NaN;
  const lastRead = typeof inner.last_read === 'string' && inner.last_read.trim() !== '' ? inner.last_read.trim() : undefined;
  return {
    scanning: inner.scanning,
    ...(phase === undefined ? {} : { phase }),
    ...(done === undefined ? {} : { done }),
    ...(total === undefined ? {} : { total }),
    ...(current === undefined ? {} : { current }),
    ...(Number.isFinite(finishedAt) ? { finishedAt } : {}),
    ...(lastRead === undefined ? {} : { lastRead }),
    ...(id === undefined ? {} : { id }),
    ...(inner.held === true ? { held: true } : {}),
  };
}

/** 路径只留最后两段,家目录写成 ~(屏上不出现 /Users/名字)。 */
export function shortPath(path: string): string {
  const home = path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  const parts = home.split('/').filter((part) => part !== '');
  if (parts.length <= 2) return home;
  return `…/${parts.slice(-2).join('/')}`;
}

/** 那一行:「正在找你的项目… 已看 12/40 · …/GitHub/foo」;list 阶段「正在看有哪些文件夹…」。 */
export function scanLineOf(scan: ScanProgress | undefined): string {
  if (scan === undefined) return SCAN_LINE;
  if (scan.phase === 'list') return SCAN_LIST_LINE;
  if (scan.phase === 'read') return scanReadLine(scan.current);
  const rest: string[] = [];
  if (scan.total !== undefined && scan.total > 0) rest.push(`已看 ${Math.min(scan.done ?? 0, scan.total)}/${scan.total}`);
  else if (scan.done !== undefined && scan.done > 0) rest.push(`已看 ${scan.done} 个`);
  if (scan.current !== undefined) rest.push(shortPath(scan.current));
  return rest.length === 0 ? SCAN_LINE : `${SCAN_LINE} ${rest.join(' · ')}`;
}

/**
 * 服务端那一段收了之后,那一行该说什么:最后读的是谁就说读谁,全量扫完就说看了几个。
 * 老服务端(活儿一做完就 scanning:false)与电话那条路(活儿做完就收)都靠它把那一行留在「最后那一段」上。
 */
export function settledScanOf(scan: ScanProgress): ScanProgress | undefined {
  if (scan.lastRead !== undefined) return { scanning: true, phase: 'read', current: scan.lastRead };
  if (scan.total !== undefined) return { scanning: true, phase: 'repos', total: scan.total, ...(scan.done === undefined ? {} : { done: scan.done }) };
  return undefined;
}

/**
 * 找项目那一整段球的样子:窗口开着且嘴上没在说 → 在办(working)。
 * **说话优先**(她真在出声就是说话的样子,拍板「说话 > 其他 的优先级不动」);其余(在想 / 在听 / 待命)都让给执行中。
 */
export function withScanMode(mode: StageMode, scanning: boolean): StageMode {
  return scanning && mode !== 'speaking' ? 'working' : mode;
}

/* ———————————————————————— 文字引导页:等她开口的窗口 ———————————————————————— */

export interface ReplyWindow {
  open: boolean;
  /** 服务端那一段的号(认得的话)。 */
  id?: number;
  /** 开窗的时刻。 */
  since?: number;
  /** 最后一次看到服务端说「还开着」的时刻(保险时限从这儿算)。 */
  seen?: number;
  /** 开窗那一刻她最后一句的记号;变了 = 她说了新的一句。 */
  herMark?: string;
  /** 注意到她新的一句的时刻(朗读开口的宽限从这儿算)。 */
  heardAt?: number;
  /** 那一行显示的那一份。 */
  shown?: ScanProgress;
  /** 收掉的那一段的号:服务端还报着它也不重开。 */
  closedId?: number;
}

export const EMPTY_REPLY_WINDOW: ReplyWindow = { open: false };

export interface ReplySignals {
  /** 最近一次回合回包里的 scan(原样)。 */
  scan: ScanProgress | undefined;
  /** 她最后一句的记号(页面上最后一条事务官的话的 key);没有就 undefined。 */
  her: string | undefined;
  /** 她那一轮还在跑(回合回包的 busy)。 */
  busy: boolean;
  /** 她在出声(朗读中)。 */
  speaking?: boolean;
  /** 这一页会朗读她的话(开了语音、没判定成不可用)。不朗读 = 新的一句一出现就算她开了口。 */
  voice?: boolean;
  now: number;
}

function closeReply(win: ReplyWindow): ReplyWindow {
  const closedId = win.id ?? win.closedId;
  return { open: false, ...(closedId === undefined ? {} : { closedId }) };
}

/** 收一拍信号,回新的窗口。纯函数;同样的信号重复进来结果不变。 */
export function nextReplyWindow(prev: ReplyWindow, s: ReplySignals): ReplyWindow {
  const scan = s.scan;
  if (!prev.open) {
    if (scan?.scanning !== true) return prev;
    if (scan.id !== undefined && scan.id === prev.closedId) return prev;
    return {
      open: true,
      since: s.now,
      seen: s.now,
      shown: scan,
      ...(scan.id === undefined ? {} : { id: scan.id }),
      ...(s.her === undefined ? {} : { herMark: s.her }),
      ...(prev.closedId === undefined ? {} : { closedId: prev.closedId }),
    };
  }
  let next: ReplyWindow = prev;
  if (scan?.scanning === true) {
    const renewed = scan.id !== undefined && prev.id !== undefined && scan.id !== prev.id;
    const { heardAt: _dropHeard, herMark: _dropMark, ...rest } = prev;
    // 服务端换了一段(她说完一句又去找):接着开着,「她的下一句」从这一段开始算。
    next = renewed
      ? { ...rest, ...(scan.id === undefined ? {} : { id: scan.id }), seen: s.now, shown: scan, ...(s.her === undefined ? {} : { herMark: s.her }) }
      : { ...prev, seen: s.now, shown: scan, ...(prev.id === undefined && scan.id !== undefined ? { id: scan.id } : {}) };
  }
  else if (scan !== undefined) {
    // 服务端这一段收了(老服务端活儿一做完就收):那一行留在最后那一段上。
    const settled = settledScanOf(scan);
    if (settled !== undefined && next.shown?.phase !== settled.phase) next = { ...next, shown: settled };
  }
  // 她说了新的一句:记下这一刻;朗读开了口(或者这一页不朗读 / 等够了)就收。等朗读的这一小会儿只看朗读,
  // 不因为「她那一轮收场了」先收 —— 不然球会先闪回待命、再变说话。
  if (s.her !== next.herMark && next.heardAt === undefined) next = { ...next, heardAt: s.now };
  if (next.heardAt !== undefined) {
    const spoke = s.voice !== true || s.speaking === true || s.now - next.heardAt >= REPLY_VOICE_GRACE_MS;
    return spoke ? closeReply(next) : next;
  }
  // 服务端这一段收了、她那一轮也收场了:不会再有下文。
  if (scan !== undefined && scan.scanning === false && !s.busy) return closeReply(next);
  // 保险:服务端好久没说「还开着」。
  if (s.now - (next.seen ?? next.since ?? s.now) >= REPLY_WINDOW_MAX_MS) return closeReply(next);
  return next;
}

/**
 * hook:每次渲染把手上的信号交进来,回此刻的窗口。朗读宽限 / 保险时限到点自己重画一次。`now` 可注入(测试用假时钟)。
 */
export function useReplyWindow(signals: Omit<ReplySignals, 'now'>, now: () => number = Date.now): ReplyWindow {
  const ref = useRef<ReplyWindow>(EMPTY_REPLY_WINDOW);
  const t = now();
  ref.current = nextReplyWindow(ref.current, { ...signals, now: t });
  const win = ref.current;
  const deadline = !win.open ? undefined : Math.min(
    win.heardAt === undefined ? Number.POSITIVE_INFINITY : win.heardAt + REPLY_VOICE_GRACE_MS,
    (win.seen ?? win.since ?? t) + REPLY_WINDOW_MAX_MS,
  );
  const [, setTick] = useState(0);
  useEffect(() => {
    if (deadline === undefined || !Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, deadline - now()) + 16);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认到点的那一刻
  }, [deadline]);
  return win;
}

/**
 * 引导**通话**页:「她在找你的项目」那一整段,球一直是执行中样子(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)。
 *
 * 维护者拍板:从她开始找项目、读仓库那一刻,到她开口说结果为止,粒子球一直是「执行中」;她一开口就回到说话的样子。
 *
 * 为什么不能再靠轮询:按名字找只要几十毫秒、读仓库约 1 秒,1.5 秒一拍的轮询多半**事后**才看到,
 * 球只闪一下,而那时她已经在说结果了。真正的等待是「找 + 读 + 模型组织话」一整段。所以这一页:
 *
 *   - **开:工人的工具信号当场进**。工人在 `scan_projects` / `read_project` 开跑那一刻往房里广播
 *     `{type:'filler', kind:'tool', tool}`(缓冲语那条通道,手机本来就收得到),收到就进执行中与那一行字;
 *   - **活儿做完 ≠ 收**:工人在「工具跑完、而且她跑之前说的那几句也放完了」那一刻再发一条 `kind:'tool_done'`
 *     (channel-worker/src/filler.ts toolsDone)。从这一刻起她**下一次开口**就是在说结果 ——
 *     模型常常先说一句「我看一下」再去找,这句和工具同时在跑,不能拿它当「她开口了」;
 *   - **收:她开口**(工人推来她的一条字幕,或者远端音轨起声 —— 手机本地垫的那句不算);
 *   - 轮询(`GET /onboarding/turns` 的 `scan`)只负责**补字**:找的是谁、读的是谁、全量进度;
 *     信号丢了 / 老工人不发 `tool_done` 时它兜底:看到服务端在干就进,看到这一段收了就当活儿做完;
 *   - 保险:{@link CALL_SCAN_IDLE_MAX_MS} 里一点「还在干」的动静都没有就收。
 *
 * 纯函数(事件进、窗口出),时间由事件带进来;接线在 call/useCall.ts。
 */
import { settledScanOf, type ScanProgress } from './scanHold';

/** 算「找项目」的那两件工具(工人 onboarding.ts 的 TOOL_SCAN_PROJECTS / TOOL_READ_PROJECT)。 */
export const CALL_SCAN_TOOLS: readonly string[] = ['scan_projects', 'read_project'];

/** 窗口开着、这么久没有一点「还在干」的动静就收(保险)。全量扫描时轮询每 1.5 秒续一次命。 */
export const CALL_SCAN_IDLE_MAX_MS = 20_000;

export interface CallScanWindow {
  open: boolean;
  /** 活儿做完了(工人说 tool_done / 服务端这一段收了):她下一次开口就收。 */
  armed: boolean;
  since?: number;
  /** 最后一次有「还在干」动静的时刻(保险时限从这儿算)。 */
  seen?: number;
  /** 那一行显示的那一份。 */
  shown?: ScanProgress;
  /** 服务端对应这一段活儿的窗口号(轮询认出来的)。 */
  id?: number;
  /** 这一段活儿开始时服务端最新的窗口号 / finished_at:之后出现更新的,就是这一段的。 */
  idAtStart?: number;
  finishedAtStart?: number;
  /** 最近一次轮询看到的服务端窗口号 / finished_at(关着的时候也记)。 */
  latestId?: number;
  latestFinishedAt?: number;
  /** 本地收掉的那一段:服务端还报着它也不重开。 */
  closedId?: number;
}

export type CallScanEvent =
  | { kind: 'tool'; tool: string; state: 'start' | 'done'; at: number }
  | { kind: 'poll'; scan: ScanProgress | undefined; at: number }
  /** 她开口:工人推来她的一条字幕,或者远端音轨起声。 */
  | { kind: 'her'; at: number }
  | { kind: 'tick'; at: number }
  /** 这一通不再是接通着的引导(挂了、没接通):从头来。 */
  | { kind: 'reset' };

export const EMPTY_CALL_SCAN: CallScanWindow = { open: false, armed: false };

/** 信号刚到、轮询还没补字时那一行:找 → 「正在找你的项目…」;读 → 「正在读它的说明…」。 */
function toolShown(tool: string): ScanProgress {
  return tool === 'read_project' ? { scanning: true, phase: 'read' } : { scanning: true };
}

function close(prev: CallScanWindow): CallScanWindow {
  const newer = prev.latestId !== undefined && (prev.idAtStart === undefined || prev.latestId > prev.idAtStart) ? prev.latestId : undefined;
  const closedId = prev.id ?? newer ?? prev.closedId;
  return {
    open: false,
    armed: false,
    ...(prev.latestId === undefined ? {} : { latestId: prev.latestId }),
    ...(prev.latestFinishedAt === undefined ? {} : { latestFinishedAt: prev.latestFinishedAt }),
    ...(closedId === undefined ? {} : { closedId }),
  };
}

/** 这一段活儿从现在算:服务端那边的窗口号 / finished_at 以此为界。 */
function startWork(prev: CallScanWindow): Pick<CallScanWindow, 'idAtStart' | 'finishedAtStart'> {
  return {
    ...(prev.latestId === undefined ? {} : { idAtStart: prev.latestId }),
    ...(prev.latestFinishedAt === undefined ? {} : { finishedAtStart: prev.latestFinishedAt }),
  };
}

export function nextCallScan(prev: CallScanWindow, event: CallScanEvent): CallScanWindow {
  switch (event.kind) {
    case 'reset':
      return EMPTY_CALL_SCAN;
    case 'tool': {
      if (!CALL_SCAN_TOOLS.includes(event.tool)) return prev;
      if (event.state === 'done') return prev.open ? { ...prev, armed: true, seen: event.at } : prev;
      // 开跑:当场进执行中。已经开着(找完接着读)就接着开着,这一段活儿重新算。
      const { id: _id, idAtStart: _idAtStart, finishedAtStart: _finishedAtStart, ...rest } = prev;
      return {
        ...rest,
        open: true,
        armed: false,
        since: prev.open && prev.since !== undefined ? prev.since : event.at,
        seen: event.at,
        shown: toolShown(event.tool),
        ...startWork(prev),
      };
    }
    case 'poll': {
      const scan = event.scan;
      if (scan === undefined) return prev;
      let next: CallScanWindow = {
        ...prev,
        ...(scan.id === undefined ? {} : { latestId: scan.id }),
        ...(scan.finishedAt === undefined ? {} : { latestFinishedAt: scan.finishedAt }),
      };
      if (scan.scanning) {
        if (!next.open) {
          // 兜底:信号丢了 / 老工人。只认**真在干**的那一段(held 是活儿做完在等别人开口,不是这一通的事);
          // 本地收掉的那一段不重开。
          if (scan.held === true || (scan.id !== undefined && scan.id === next.closedId)) return next;
          return { ...next, open: true, armed: false, since: event.at, seen: event.at, shown: scan, ...(scan.id === undefined ? {} : { id: scan.id }) };
        }
        if (next.id !== undefined && scan.id !== undefined && scan.id < next.id) return next;
        const newer = next.id !== undefined && scan.id !== undefined && scan.id > next.id;
        next = {
          ...next,
          seen: event.at,
          shown: scan,
          ...(scan.id === undefined ? {} : { id: scan.id }),
          // 服务端换了一段(新的活儿):先当它还没做完。
          ...(newer ? { armed: false } : {}),
        };
        if (scan.held === true) next = { ...next, armed: true };
        return next;
      }
      if (!next.open) return next;
      // 服务端这一段收了(电话那条路:活儿做完就收)—— 是不是**这一段活儿**的那一段?
      const ours = scan.id !== undefined
        ? scan.id !== next.closedId && (next.id !== undefined ? scan.id === next.id : next.idAtStart === undefined || scan.id > next.idAtStart)
        : scan.finishedAt !== undefined && scan.finishedAt !== next.finishedAtStart;
      if (!ours) return next;
      const settled = settledScanOf(scan);
      return { ...next, armed: true, seen: event.at, ...(scan.id === undefined ? {} : { id: scan.id }), ...(settled === undefined ? {} : { shown: settled }) };
    }
    case 'her':
      // 活儿还没做完时她说的那句(「我看一下」)不算:她还在找。
      return prev.open && prev.armed ? close(prev) : prev;
    case 'tick':
      return prev.open && event.at - (prev.seen ?? prev.since ?? event.at) >= CALL_SCAN_IDLE_MAX_MS ? close(prev) : prev;
    default:
      return prev;
  }
}

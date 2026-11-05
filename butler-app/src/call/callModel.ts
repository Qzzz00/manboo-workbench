/**
 * 通话模式的纯逻辑(2026-09-17)。Ben:「点一下说一声的方式还是一半,不如做 RTC 通话模式吧」。
 *
 * 这里只有文本进文本出的函数:状态机怎么走、球画成什么样、屏幕上那句话说什么、字幕怎么攒。
 * 真正连火山的那一段在 rtcCall.ts,连工作台的在 api/call.ts——那两处都要真环境,这里不要。
 */
import type { StageMode } from '../swarm/orbState';

/**
 * 一通电话的五个阶段。**「在查」单独一态**:没配供应商时界面要灰掉并说人话,
 * 不能先进「接通中」再弹一个错误栈(那是 Ben 明确不要的)。
 */
export type CallPhase = 'idle' | 'connecting' | 'connected' | 'ending' | 'ended' | 'error';

/** 电话里的一句话。谁说的必须分得清,否则纪要没法读。 */
export interface CallUtterance {
  who: 'me' | 'butler';
  text: string;
}

/** 没配供应商时的那句人话(Mac 上配,手机只能提示)。 */
export const CALL_UNAVAILABLE_TEXT = '电脑上还没配通话供应商';

/** 通话入口按钮上的字。 */
export const CALL_ENTRY_LABEL = '通话';

/** 「03:25」。通话时长要一眼看懂,分秒补零,超过一小时就前面再加小时。 */
export function formatCallElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 攒字幕。火山的定稿字幕(definite)每句来一条,但同一句偶尔会重复推送;
 * **只挡「紧挨着的同一个人说了同一句」**——真的连说两遍同样的话不该被吞掉太多,
 * 所以不做全局去重,只看上一条。空白一律不收。
 */
export function appendUtterance(list: readonly CallUtterance[], entry: CallUtterance): CallUtterance[] {
  const text = entry.text.trim();
  if (text === '') return [...list];
  const last = list[list.length - 1];
  if (last !== undefined && last.who === entry.who && last.text === text) return [...list];
  return [...list, { who: entry.who, text }];
}

/**
 * 通话里粒子球画成什么样。复用主界面那五态(orbState.ts 同一套语义):
 * 她在说 → speaking;你在说 → listening;还没接通 → working(在忙,不是在待命);
 * 接通了但两边都没出声 → idle(等着)。
 */
export function callStageMode(input: { phase: CallPhase, botSpeaking: boolean, micSpeaking: boolean }): StageMode {
  if (input.phase === 'connecting') return 'working';
  if (input.phase !== 'connected') return 'idle';
  if (input.botSpeaking) return 'speaking';
  if (input.micSpeaking) return 'listening';
  return 'idle';
}

/**
 * 屏幕上那一行状态字。**出错时说的是原话**(服务端给的那句),不套一层「未知错误」——
 * 他要能照着这句话知道去哪儿修。
 */
export function callStatusText(phase: CallPhase, error?: string): string {
  switch (phase) {
    case 'connecting': return '正在接通…';
    case 'connected': return '通话中';
    case 'ending': return '正在挂断…';
    case 'ended': return '已挂断';
    case 'error': return error !== undefined && error !== '' ? error : '通话没接通';
    default: return '';
  }
}

/** 挂断后交回工作台的那份纪要。时长拿不到就整个缺席(不编数,也不写 0)。 */
export interface CallSummary {
  durationSeconds?: number;
  transcript: readonly CallUtterance[];
}

/**
 * 从进房到挂断的秒数。两个时刻缺一个就不给数——宁可工作台上写「时长没记下来」,
 * 也不要一个看起来很确定其实是猜的数字。
 */
export function callDurationSeconds(startedAt: number | undefined, endedAt: number): number | undefined {
  if (startedAt === undefined || !Number.isFinite(startedAt) || endedAt < startedAt) return undefined;
  return Math.round((endedAt - startedAt) / 1000);
}

/**
 * 他拨出去的这一通的编号(2026-10-22,通话落成记录)。拨号时编一个,交给工人(`start` 带上)、
 * 挂断报记录时也带上 —— 工作台据此把手机与工人报的并成一份。来电那一通用台账上的 id,不用它。
 */
export function newCallId(): string {
  try {
    const uuid: string | undefined = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid !== '') return `ph-${uuid.replace(/-/g, '').slice(0, 12)}`;
  } catch { /* 老 WebView 没有 randomUUID */ }
  return `ph-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

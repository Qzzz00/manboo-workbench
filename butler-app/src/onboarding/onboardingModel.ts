/**
 * 引导页的状态(纯函数,便于单测)。真相在工作台(阶段、已答项);这里只管「屏幕上现在该画什么」:
 * - 进页面先看全貌:做完了 → 复述卡;做到一半 → 「引导还没做完」+ 正在哪一步(2026-09-24 维护者 0923 定:续接不问「上次到哪」,直接接着问没答的那一题);没开始 → 直接开。
 * - 对话流 = 种子句(手机自己摆的,见下)+ 工作台回的回合(seq 递增)+ 本机刚发出、还没被回合表回显的那几句(pending)。
 * - 八段小点 = plan 里 done 之前的阶段;当前阶段几就亮到几。
 *
 * 种子句(2026-09-16 开场体验):每个阶段的种子句本来就是事务官的话(开场那句 Ben 亲笔,一字不改),
 * 所以开会话成功、阶段推进的那一刻手机就把它当事务官的一句摆出来(并朗读),不等模型十几秒。
 * 模型随后照念的那条(工作台标 kind:seed,或去空白与标点后逐字相同)合并进这句,不重复显示;模型补充的话接在后面。
 */
import type { OnboardingDetail, OnboardingTurn, TurnsResult } from './onboardingApi';
import { STAGE_TITLES } from './onboardingApi';

export type OnboardingPhase = 'loading' | 'resume' | 'starting' | 'chatting' | 'done' | 'unavailable';

/** 手机自己摆出来的种子句:排在 seq ≤ afterSeq 的回合之后;merged = 已吸收了模型照念的那条(seq)。 */
export interface SeedLine { key: string; stage: string; text: string; afterSeq: number; merged?: number }

/** 回合表的一条,多一个 merged:被种子句吸收了,不显示不朗读。 */
export type ThreadTurn = OnboardingTurn & { merged?: true };

export interface OnboardingModel {
  phase: OnboardingPhase;
  stage: string;
  plan: readonly string[];
  done: boolean;
  turns: ThreadTurn[];
  /** 已发出、回合表还没回显的用户句子。 */
  pending: string[];
  /** 手机自己摆出来的种子句(每阶段一条)。 */
  seeds: SeedLine[];
  /** 当前阶段的种子句(从全貌 next.seed / 回合表 seed 来);done 时没有。 */
  seed?: string;
  /** 当前阶段已答了几项(续做时判断要不要再摆种子句)。 */
  stageAnswered: number;
  /** 工作台开过引导会话(有 askedAt):进页面要先把历史回合摆出来。 */
  opened: boolean;
  lastSeq: number;
  busy: boolean;
  ended: boolean;
  recap?: string;
  nickname?: string;
  /** 做到一半时那一句:正在哪一步、答了几项(中性,不问「上次到哪」)。 */
  resumeLine?: string;
  error?: string;
}

export const ONBOARDING_UNAVAILABLE_TEXT = '工作台没开引导:Mac 上要配 WORKBENCH_BUTLER_CWD(记忆所在仓库)。';
export const SESSION_NOT_OPEN_TEXT = '工作台没开出引导会话(DSH 还没接上),等一会儿再点。';
export const AFTERWARDS_TEXT = '以后我先开口。';

export const SLOW_TEXT = '事务官反应慢了,再等等或重试';
/** 等这么久还没有新回合就提示「反应慢了」。 */
export const SLOW_AFTER_MS = 30_000;

export function emptyModel(): OnboardingModel {
  return { phase: 'loading', stage: 'opening', plan: [], done: false, turns: [], pending: [], seeds: [], stageAnswered: 0, opened: false, lastSeq: 0, busy: false, ended: false };
}

/** 「同一句话」的比较键:去掉所有空白与标点(全角半角都算)。与工作台 onboardingTurns.ts 的 speechKey 逐字同源。 */
export function speechKey(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 进度:done 之前的阶段列表与当前下标(找不到当前阶段就 -1)。 */
export function progressOf(model: Pick<OnboardingModel, 'plan' | 'stage' | 'done'>): { steps: readonly string[]; index: number } {
  const steps = model.plan.filter((s) => s !== 'done');
  if (model.done) return { steps, index: steps.length };
  return { steps, index: steps.indexOf(model.stage) };
}

export function stageTitle(stage: string): string {
  return STAGE_TITLES[stage] ?? stage;
}

/** 全貌 → 进页面时的模型。 */
export function fromDetail(detail: OnboardingDetail): OnboardingModel {
  const answered = Object.values(detail.answered).reduce((n, keys) => n + keys.length, 0);
  const base: OnboardingModel = {
    ...emptyModel(),
    stage: detail.stage,
    plan: detail.plan,
    done: detail.done,
    ...(detail.recap === undefined ? {} : { recap: detail.recap }),
    ...(detail.nickname === undefined ? {} : { nickname: detail.nickname }),
    ...(detail.next === undefined ? {} : { seed: detail.next.seed }),
    stageAnswered: detail.answered[detail.stage]?.length ?? 0,
    opened: detail.askedAt !== undefined,
  };
  if (detail.done) return { ...base, phase: 'done' };
  const started = detail.askedAt !== undefined && (answered > 0 || detail.stage !== detail.plan[0]);
  if (started) {
    return { ...base, phase: 'resume', resumeLine: `正在「${stageTitle(detail.stage)}」${answered > 0 ? `,已经答了 ${answered} 项` : ''}。` };
  }
  return { ...base, phase: 'starting' };
}

/**
 * 把一个阶段的种子句当事务官的一句摆出来(排在现有回合之后)。同一阶段已经摆过就不重复。
 * afterSeq 缺省 = 现有回合的最后一个 seq;推进那一拍里模型已经照念了就传那条的前一个 seq,让种子句排在它前面。
 */
export function withSeed(model: OnboardingModel, stage: string, text: string, afterSeq?: number): OnboardingModel {
  const line = text.trim();
  if (line === '' || model.seeds.some((s) => s.stage === stage)) return model;
  const seed: SeedLine = { key: `seed:${stage}:${model.seeds.length}`, stage, text: line, afterSeq: afterSeq ?? model.lastSeq };
  return { ...model, seeds: [...model.seeds, seed] };
}

/**
 * 续做(工作台说 resumed)时要不要再摆种子句:这一阶段一项都没答、而且屏幕上(历史回合)还没有这句——
 * 典型是称呼没答就退回主页又点「接着引导」;工作台这时不再让模型念开场白,手机得自己摆着。
 * 答过东西的续做不摆:模型第一句直接接着问没答的那一题。
 */
export function needsSeedOnResume(model: OnboardingModel, seed: string): boolean {
  if (model.stageAnswered > 0) return false;
  const key = speechKey(seed);
  if (model.turns.some((t) => t.role === 'assistant' && (t.kind === 'seed' || speechKey(t.text) === key))) return false;
  return !model.seeds.some((s) => s.stage === model.stage);
}

/**
 * 模型照念的种子句并进种子行:标了 kind:seed 的,或去空白与标点后逐字相同的;每条种子句只吸收一条。
 * 种子句屏幕上已经有了(种子行,或之前的回合里已经显示过这句)再来一条同样的也不显示——
 * 一句种子句只渲染一次(2026-09-16 真机:回主页再「接着引导」后开场白显示了三遍)。别的话重复不管。
 */
function mergeSeeds(model: Pick<OnboardingModel, 'seeds' | 'turns' | 'seed'>, fresh: OnboardingTurn[]): { seeds: SeedLine[]; turns: ThreadTurn[] } {
  const next = model.seeds.map((s) => ({ ...s }));
  const shown = new Set<string>();
  for (const s of next) shown.add(speechKey(s.text));
  for (const t of model.turns) if (t.role === 'assistant' && t.merged !== true) shown.add(speechKey(t.text));
  const stageSeedKey = model.seed === undefined ? undefined : speechKey(model.seed);
  const turns: ThreadTurn[] = fresh.map((turn) => {
    if (turn.role !== 'assistant') return turn;
    const key = speechKey(turn.text);
    const target = next.find((s) => s.merged === undefined && speechKey(s.text) === key)
      ?? (turn.kind === 'seed' ? [...next].reverse().find((s) => s.merged === undefined) : undefined);
    if (target !== undefined) {
      target.merged = turn.seq;
      return { ...turn, merged: true };
    }
    const isSeed = turn.kind === 'seed' || key === stageSeedKey;
    if (isSeed && shown.has(key)) return { ...turn, merged: true };
    shown.add(key);
    return turn;
  });
  return { seeds: next, turns };
}

/** 回合表的一拍并进来:新回合追加、pending 里被回显的删掉、busy / ended / stage / done 跟着走;阶段推进就先摆新阶段的种子句。 */
export function applyTurns(model: OnboardingModel, result: TurnsResult): OnboardingModel {
  const fresh = result.turns.filter((t) => t.seq > model.lastSeq);
  let pending = model.pending;
  for (const turn of fresh) {
    if (turn.role === 'user') {
      const i = pending.indexOf(turn.text);
      if (i >= 0) pending = [...pending.slice(0, i), ...pending.slice(i + 1)];
    }
  }
  const lastSeq = fresh.length > 0 ? fresh[fresh.length - 1]!.seq : model.lastSeq;
  const done = result.done;
  let next: OnboardingModel = {
    ...model,
    busy: result.busy,
    ended: result.ended,
    stage: result.stage,
    done,
    ...(result.seed === undefined ? {} : { seed: result.seed }),
    phase: done ? 'done' : model.phase === 'starting' || model.phase === 'chatting' ? 'chatting' : model.phase,
  };
  // 阶段推进(会话开着时):先摆新阶段的种子句。模型这一拍已经照念了就排在那条之前,否则排在这一拍所有回合之后。
  const advanced = result.seed !== undefined && !done && result.stage !== model.stage && (model.phase === 'chatting' || model.phase === 'starting');
  if (advanced) {
    const seedKey = speechKey(result.seed!);
    const recited = fresh.find((t) => t.role === 'assistant' && (t.kind === 'seed' || speechKey(t.text) === seedKey));
    next = withSeed(next, result.stage, result.seed!, recited === undefined ? lastSeq : recited.seq - 1);
  }
  const merged = mergeSeeds(next, fresh);
  return {
    ...next,
    seeds: merged.seeds,
    turns: merged.turns.length > 0 ? [...model.turns, ...merged.turns] : model.turns,
    pending,
    lastSeq,
  };
}

export function withPending(model: OnboardingModel, text: string): OnboardingModel {
  return { ...model, pending: [...model.pending, text] };
}

export function withoutPending(model: OnboardingModel, text: string): OnboardingModel {
  const i = model.pending.indexOf(text);
  return i < 0 ? model : { ...model, pending: [...model.pending.slice(0, i), ...model.pending.slice(i + 1)] };
}

/** 屏幕上的对话流:种子句与回合按位置交错(被吸收的回合不出现)+ 尾部挂着还没回显的句子。 */
export interface ThreadLine { key: string; role: 'user' | 'assistant'; text: string; pending?: true; kind?: 'seed' }

export function threadOf(model: OnboardingModel): ThreadLine[] {
  const lines: ThreadLine[] = [];
  const seeds = [...model.seeds].sort((a, b) => a.afterSeq - b.afterSeq);
  let si = 0;
  const flushSeeds = (upTo: number) => {
    while (si < seeds.length && seeds[si]!.afterSeq <= upTo) {
      const s = seeds[si++]!;
      lines.push({ key: s.key, role: 'assistant', text: s.text, kind: 'seed' });
    }
  };
  for (const t of model.turns) {
    flushSeeds(t.seq - 1);
    if (t.merged === true) continue;
    lines.push({ key: `t${t.seq}`, role: t.role, text: t.text });
  }
  flushSeeds(Number.POSITIVE_INFINITY);
  model.pending.forEach((text, i) => lines.push({ key: `p${i}:${text}`, role: 'user', text, pending: true }));
  return lines;
}

/**
 * 等待态:事务官该说话而还没说——开会话中;工作台说它在想(busy);我说了一句(发送中或已回显)它还没回。
 * 种子句刚摆出来、轮到用户答的时候不算等;做完了不算等。
 */
export function isWaiting(model: OnboardingModel): boolean {
  if (model.phase === 'starting') return model.error === undefined;
  if (model.phase !== 'chatting' || model.done) return false;
  if (model.busy) return true;
  const thread = threadOf(model);
  const last = thread[thread.length - 1];
  return last !== undefined && last.role === 'user';
}

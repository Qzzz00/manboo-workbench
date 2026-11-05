/**
 * 引导页的数据层:全貌 → (做到一半:接着聊 / 从头来)→ 开会话 → 种子句先摆出来 → 轮询回合 → 说话 → 做完。
 * 阶段推进由工作台做,这里只显示。轮询 1.5 秒一拍(只在会话开着时),不另接 /live。
 * 会话被 DSH 收掉(say 409)就自动再开一次接着说,还不行才把错误摆出来。
 * 等待态(2026-09-16 开场体验):该事务官说话而还没说(isWaiting)超过 slowMs(缺省 30 秒)没有新回合 → slow,页面提示「反应慢了」;
 * retry:开会话中就再开一次,聊着就把最后那句再说一遍。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../session';
import { createOnboardingApi, type OnboardingApi } from './onboardingApi';
import { scanProgressOf, type ScanProgress } from './scanHold';
import {
  applyTurns, emptyModel, fromDetail, isWaiting, needsSeedOnResume, ONBOARDING_UNAVAILABLE_TEXT, SESSION_NOT_OPEN_TEXT, SLOW_AFTER_MS, threadOf, withPending, withSeed, withoutPending,
  type OnboardingModel,
} from './onboardingModel';

export interface OnboardingHandle {
  model: OnboardingModel;
  /** 「接着」/ 第一次进来自动开。 */
  start(): Promise<void>;
  /** 「从头来」:restart all 再开。 */
  restart(): Promise<void>;
  say(text: string): Promise<void>;
  /** 「反应慢了」之后的重试:开会话中就再开;聊着就把最后那句再说一遍。 */
  retry(): Promise<void>;
  /** 回合表里比它小的 seq 不朗读(进页面时已经在屏幕上的那些)。 */
  spokenBaseline: number;
  /** 「从头来」一次加一:回合表与种子句都从头编号,朗读记录也要清。 */
  epoch: number;
  /** 该事务官说话而还没说:球进说话准备态、气泡三点。 */
  waiting: boolean;
  /** 等了 slowMs 还没有新回合。 */
  slow: boolean;
  /** 最近一次回合回包里的扫描进度(原样,没做最短显示);undefined = 服务端没给。 */
  scan?: ScanProgress;
}

export function useOnboarding(session: Session, options: { api?: OnboardingApi; pollMs?: number; slowMs?: number } = {}): OnboardingHandle {
  const api = useMemo(() => options.api ?? createOnboardingApi(session.client), [options.api, session.client]);
  const pollMs = options.pollMs ?? 1500;
  const slowMs = options.slowMs ?? SLOW_AFTER_MS;
  const [model, setModel] = useState<OnboardingModel>(emptyModel);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [spokenBaseline, setSpokenBaseline] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** 回合回包里的扫描进度(2026-09-24):扫描中球进工作态 + 一行进度。 */
  const [scan, setScan] = useState<ScanProgress | undefined>(undefined);

  const update = useCallback((next: OnboardingModel | ((m: OnboardingModel) => OnboardingModel)) => {
    if (!alive.current) return;
    setModel((cur) => (typeof next === 'function' ? next(cur) : next));
  }, []);

  const pollOnce = useCallback(async () => {
    const r = await api.turns(modelRef.current.lastSeq);
    if (!r.ok) return;
    if (alive.current) setScan(scanProgressOf(r.data));
    update((m) => applyTurns(m, r.data));
  }, [api, update]);

  /** 全貌 → 模型;回的是进页面时该处于的 phase(调用方据此决定要不要直接开会话)。 */
  const load = useCallback(async (): Promise<OnboardingModel['phase'] | undefined> => {
    const r = await api.detail();
    if (!alive.current) return undefined;
    if (!r.ok) {
      update((m) => ({ ...m, phase: 'unavailable', error: r.status === 404 ? ONBOARDING_UNAVAILABLE_TEXT : r.error }));
      return 'unavailable';
    }
    const next = fromDetail(r.data);
    if (next.opened || next.phase === 'done') {
      // 开过会话:把已有的回合先摆出来(它们不朗读)。称呼没答就退回主页再进来也算——
      // 否则屏幕是空的,而工作台这次不会再让模型念开场白(2026-09-16 真机:开场白念了三遍)。
      const t = await api.turns(0);
      if (!alive.current) return undefined;
      if (t.ok) setScan(scanProgressOf(t.data));
      const withHistory = t.ok ? applyTurns({ ...next, phase: next.phase }, { ...t.data, done: next.done }) : next;
      setSpokenBaseline(withHistory.lastSeq);
      update({ ...withHistory, phase: next.phase });
      return next.phase;
    }
    update(next);
    return next.phase;
  }, [api, update]);

  const start = useCallback(async () => {
    const wasResume = modelRef.current.phase === 'resume';
    update((m) => ({ ...m, phase: 'starting', error: undefined } as OnboardingModel));
    const r = await api.session();
    if (!alive.current) return;
    if (!r.ok) {
      if (r.status === 409) { await load(); return; }
      update((m) => ({ ...m, phase: r.status === 404 ? 'unavailable' : m.phase, error: r.status === 404 ? ONBOARDING_UNAVAILABLE_TEXT : r.error }));
      return;
    }
    if ('note' in r.data) {
      update((m) => ({ ...m, phase: 'starting', error: SESSION_NOT_OPEN_TEXT }));
      return;
    }
    // 开会话成功:阶段种子句(开场是 Ben 亲笔那句)立刻当事务官的第一句摆出来,不等模型。
    // 接着上次做的不摆——模型第一句直接接着问没答的那一题。老工作台没回 seed 就用全貌里的 next.seed。
    const resumed = r.data.resumed ?? (wasResume || modelRef.current.opened);
    const opened = r.data;
    update((m) => {
      const next = { ...m, phase: 'chatting', stage: opened.stage, error: undefined, opened: true, ...(opened.seed === undefined ? {} : { seed: opened.seed }) } as OnboardingModel;
      const seed = opened.seed ?? m.seed;
      if (seed === undefined) return next;
      // 续做:工作台不再让模型念种子句;这一阶段还一项没答、屏幕上也没这句时手机自己摆。
      if (resumed) return needsSeedOnResume(next, seed) ? withSeed(next, opened.stage, seed) : next;
      return withSeed(next, opened.stage, seed);
    });
    void pollOnce();
  }, [api, load, pollOnce, update]);

  const restart = useCallback(async () => {
    const r = await api.restart('all');
    if (!alive.current) return;
    if (!r.ok) { update((m) => ({ ...m, error: r.error })); return; }
    update({ ...emptyModel(), phase: 'starting' });
    setSpokenBaseline(0);
    setEpoch((e) => e + 1);
    await start();
  }, [api, start, update]);

  const say = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (text === '') return;
    update((m) => withPending(m, text));
    let r = await api.say(text);
    if (!r.ok && r.status === 409 && !modelRef.current.done) {
      // 会话被收掉了(DSH 重启 / 超时):再开一次接着说。
      const reopened = await api.session();
      if (reopened.ok && !('note' in reopened.data)) r = await api.say(text);
    }
    if (!alive.current) return;
    if (!r.ok) {
      update((m) => ({ ...withoutPending(m, text), error: r.error }));
      return;
    }
    update((m) => ({ ...m, phase: m.done ? 'done' : 'chatting', error: undefined } as OnboardingModel));
    void pollOnce();
  }, [api, pollOnce, update]);

  const retry = useCallback(async () => {
    const m = modelRef.current;
    if (m.phase === 'starting' || m.phase === 'resume') { await start(); return; }
    if (m.phase !== 'chatting') return;
    const lines = threadOf(m);
    const last = [...lines].reverse().find((l) => l.role === 'user');
    if (last === undefined) { await start(); return; }
    if (last.pending === true) update((cur) => withoutPending(cur, last.text));
    await say(last.text);
  }, [say, start, update]);

  // 等待态:该它说话而还没说;等了 slowMs 还没有新回合就 slow。新回合(lastSeq 变)或不再等就清。
  const waiting = isWaiting(model);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) { setSlow(false); return; }
    setSlow(false);
    const timer = setTimeout(() => { if (alive.current) setSlow(true); }, slowMs);
    return () => clearTimeout(timer);
  }, [waiting, model.lastSeq, model.seeds.length, model.pending.length, slowMs]);

  // 进页面:先看全貌;没开始过就直接开。
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void load().then((phase) => { if (alive.current && phase === 'starting') void start(); });
  }, [load, start]);

  // 会话开着就轮询回合;做完了等事务官把最后一句说完(busy 变 false)再停——
  // 真机实测:阶段机在模型回话中途就把 done 置真,这时停了会漏掉「以后我先开口」那句,球也停在在办态。
  useEffect(() => {
    if (!(model.phase === 'chatting' || (model.phase === 'done' && model.busy))) return;
    const timer = setInterval(() => { void pollOnce(); }, pollMs);
    return () => clearInterval(timer);
  }, [model.phase, model.busy, pollMs, pollOnce]);

  // 做完了:补一次全貌拿 recap(收尾时阶段机算的复述清单)。
  const recapFetched = useRef(false);
  useEffect(() => {
    if (model.phase !== 'done' || model.recap !== undefined || recapFetched.current) return;
    recapFetched.current = true;
    void api.detail().then((r) => { if (r.ok && alive.current) update((m) => ({ ...m, ...(r.data.recap === undefined ? {} : { recap: r.data.recap }), ...(r.data.nickname === undefined ? {} : { nickname: r.data.nickname }) })); });
  }, [model.phase, model.recap, api, update]);

  return { model, start, restart, say, retry, spokenBaseline, epoch, waiting, slow, ...(scan === undefined ? {} : { scan }) };
}

// src/radio/pet/usePetPlay.ts
/**
 * 宠物玩法唯一接线 hook：触摸/投喂/调度 tick → 反应桌 → RadioApp 现有触发通道。
 * 逻辑全在纯函数模块（petState/petHitZones/petReactions/petSchedule），这里只做：
 * 事件捕获、React 状态、param 轻推动画（rAF）、咀嚼脉冲、爱心粒子生命周期。
 * greetEnabled/idleEnabled 是分期开关（P2/P4 各自打开），不是长期配置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParameterOverride } from '../../features/live2d/avatarManifest.ts';
import type { ModelBounds } from '../../features/live2d/live2dEngine.ts';
import { planPetCry, type AckPlan } from '../radioVoicePack.ts';
import {
  applyCall, applyFeed, applyTap, derivePet, loadPet, savePet, tryGreet,
  type PetDerived, type PetPersist,
} from './petState.ts';
import { DESIGN_H, DESIGN_W, petZoneAt, petZoneRects, toDesignSpace, toStageSpace } from './petHitZones.ts';
import { favoriteSnackFor, petReactionFor, type PetMood, type PetReaction, type SnackId } from './petReactions.ts';
import { decideIdle, initSchedule, markReaction, type ScheduleState } from './petSchedule.ts';

const REACTION_COOLDOWN_MS = 800;
const STREAK_WINDOW_MS = 5000;
const EXPRESSION_DELAY_MS = 150;
const GREET_DELAY_MS = 1500;
const TICK_MS = 30_000;
const HEART_TTL_MS = 1200;
const CHOMP_LEVELS = [0.7, 0.15, 0.75, 0.2, 0.8, 0];
const CHOMP_STEP_MS = 180;
// nudge rAF 每帧都会重算 setPetParamOverrides，原生桥/整树重渲扛不住逐帧 setState（口型通道同款
// 66ms 节流，见 nativeStage.ts:380 注释）。rAF 循环本身不降频（时间基准要连续），只降低 setState 频率。
const NUDGE_THROTTLE_MS = 66;

// 小幽灵的参数轻推谱（衰减包络 × 正弦 + 常量偏移）。写在这不写引擎——只是普通 overrides。
const NUDGE_SPECS: Record<string, { dur: number; params: { id: string; amp: number; hz: number; base?: number; phase?: number }[] }> = {
  'sway-small': { dur: 700, params: [{ id: 'ParamAngleZ', amp: 8, hz: 2.2 }] },
  'sway-big': { dur: 900, params: [{ id: 'ParamAngleZ', amp: 14, hz: 1.8 }, { id: 'ParamAngleX', amp: 10, hz: 1.8, phase: Math.PI / 2 }] },
  'dodge': { dur: 500, params: [{ id: 'ParamAngleX', amp: 3, hz: 3, base: -18 }] },
  'blush': { dur: 700, params: [{ id: 'ParamAngleY', amp: 3, hz: 2.5, base: 8 }, { id: 'ParamAngleZ', amp: 5, hz: 2.5 }] },
};

export type PetHeart = { id: number; x: number; y: number };
export type PetFlight = { snack: SnackId; x: number; y: number };

export type PetPlayApi = {
  persist: PetPersist; derived: PetDerived;
  panelOpen: boolean; setPanelOpen: (v: boolean) => void;
  bubble: string | null;
  petAction: { id: string; nonce: number } | null;
  petParamOverrides: ParameterOverride[];
  hearts: PetHeart[];
  flight: PetFlight | null;
  onScreenTap: (clientX: number, clientY: number) => void;
  onModelBounds: (b: ModelBounds) => void;
  onVoiceHeard: () => void;
  tapFeedSnack: (snack: SnackId, sourceEl: { getBoundingClientRect: () => DOMRect }) => void;
};

export function usePetPlay(opts: {
  djId: string;
  headAnchorY?: number;
  headSizeNorm?: number;
  page: 'radio' | 'home';
  djReady: boolean;
  overlayOpen: boolean;
  inCall: boolean;
  barking: boolean;
  playing: boolean;
  greetEnabled: boolean;
  idleEnabled: boolean;
  screenRef: React.RefObject<HTMLDivElement | null>;
  playCry: (plan: AckPlan) => void;
  setMouthLevel: (v: number) => void;
}): PetPlayApi {
  const { djId, page, djReady, screenRef, playCry, setMouthLevel } = opts;

  const [persist, setPersist] = useState<PetPersist>(() => loadPet(djId));
  const [panelOpen, setPanelOpen] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [petAction, setPetAction] = useState<{ id: string; nonce: number } | null>(null);
  const [petParamOverrides, setPetParamOverrides] = useState<ParameterOverride[]>([]);
  const [hearts, setHearts] = useState<PetHeart[]>([]);
  const [flight, setFlight] = useState<PetFlight | null>(null);
  const [minuteTick, setMinuteTick] = useState(0); // 让 hunger/sleepy 不靠互动也会自然更新

  const boundsRef = useRef<ModelBounds | null>(null);
  const nonceRef = useRef(0);
  const heartIdRef = useRef(0);
  const lastFireAtRef = useRef(0);
  const streakRef = useRef<{ zone: 'head' | 'body'; count: number; at: number } | null>(null);
  const scheduleRef = useRef<ScheduleState>(initSchedule(Date.now()));
  const nudgeRafRef = useRef(0);
  const nudgeLastSetAtRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const flightSeqRef = useRef(0);      // 换角色/连点作废在飞零食用
  const flightActiveRef = useRef(false); // 一次只飞一只，防连点叠飞
  // 调度 tick 要读「最新」的门控值，全走 ref，interval 不反复重建
  const liveRef = useRef(opts);
  liveRef.current = opts;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const pushTimer = (id: ReturnType<typeof setTimeout>) => { timersRef.current.push(id as unknown as number); };

  // 换角色：读新档案、清连击/冷却/调度/临时态
  useEffect(() => {
    setPersist(loadPet(djId));
    streakRef.current = null;
    lastFireAtRef.current = 0;
    scheduleRef.current = initSchedule(Date.now());
    setPetAction(null);
    setPetParamOverrides([]);
    setBubble(null);
    setPanelOpen(false);
    setFlight(null);
    flightSeqRef.current += 1; // 在飞零食作废（落地回调看 seq 不结算）
    flightActiveRef.current = false;
  }, [djId]);

  useEffect(() => {
    const id = setInterval(() => setMinuteTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const mutatePersist = useCallback((fn: (p: PetPersist) => PetPersist) => {
    setPersist((prev) => {
      const next = fn(prev);
      if (next !== prev) savePet(djId, next);
      return next;
    });
  }, [djId]);

  const derived: PetDerived = useMemo(
    () => derivePet(persist, Date.now()),
    // minuteTick 故意入列：时间流逝本身会改变饿/困，1min 粒度足够
    [persist, minuteTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const moodOf = useCallback((): PetMood => {
    const d = derivePet(persistRef.current, Date.now());
    return { hunger: d.hunger, sleepy: d.sleepy, level: d.level };
  }, []);

  const showBubble = useCallback((text: string, ms: number) => {
    setBubble(text);
    pushTimer(setTimeout(() => setBubble(null), ms));
  }, []);

  const runNudge = useCallback((kind: keyof typeof NUDGE_SPECS) => {
    cancelAnimationFrame(nudgeRafRef.current);
    const spec = NUDGE_SPECS[kind];
    const start = performance.now();
    nudgeLastSetAtRef.current = 0; // 强制新一轮 nudge 的第一帧立即推一次，不等节流窗口
    const step = (t: number) => {
      const el = t - start;
      if (el >= spec.dur) { setPetParamOverrides([]); nudgeRafRef.current = 0; return; }
      if (t - nudgeLastSetAtRef.current >= NUDGE_THROTTLE_MS) {
        nudgeLastSetAtRef.current = t;
        const k = 1 - el / spec.dur; // 线性衰减包络
        setPetParamOverrides(spec.params.map((p) => ({
          id: p.id,
          value: (Math.sin((el / 1000) * p.hz * Math.PI * 2 + (p.phase ?? 0)) * p.amp + (p.base ?? 0)) * k,
        })));
      }
      nudgeRafRef.current = requestAnimationFrame(step);
    };
    nudgeRafRef.current = requestAnimationFrame(step);
  }, []);

  const runChomp = useCallback(() => {
    CHOMP_LEVELS.forEach((lv, i) => {
      pushTimer(setTimeout(() => { if (!liveRef.current.barking) setMouthLevel(lv); }, i * CHOMP_STEP_MS));
    });
  }, [setMouthLevel]);

  const spawnHearts = useCallback((x: number, y: number) => {
    const batch: PetHeart[] = Array.from({ length: 4 }, (_, i) => ({
      id: ++heartIdRef.current,
      x: x + (i - 1.5) * 16,
      y: y - i * 6,
    }));
    setHearts((prev) => [...prev, ...batch]);
    pushTimer(setTimeout(() => {
      setHearts((prev) => prev.filter((h) => !batch.some((b) => b.id === h.id)));
    }, HEART_TTL_MS));
  }, []);

  const fireReaction = useCallback((re: PetReaction | null, at?: { x: number; y: number }, force = false) => {
    if (!re) return;
    const now = Date.now();
    if (!force && now - lastFireAtRef.current < REACTION_COOLDOWN_MS) return;
    lastFireAtRef.current = now;
    scheduleRef.current = markReaction(scheduleRef.current, now);
    if (re.actionId) setPetAction({ id: re.actionId, nonce: ++nonceRef.current });
    if (re.expressionId) {
      const exprId = re.expressionId;
      pushTimer(setTimeout(() => setPetAction({ id: exprId, nonce: ++nonceRef.current }), EXPRESSION_DELAY_MS));
    }
    if (re.cry) {
      const plan = planPetCry(djId, re.cry);
      if (plan) playCry(plan);
    }
    if (re.nudge) runNudge(re.nudge);
    if (re.mouthPulse) runChomp();
    if (re.hearts && at) spawnHearts(at.x, at.y);
  }, [djId, playCry, runNudge, runChomp, spawnHearts]);

  const isNativeStage = () => document.documentElement.classList.contains('native-live2d');

  const onScreenTap = useCallback((clientX: number, clientY: number) => {
    const el = screenRef.current;
    const b = boundsRef.current;
    const { headAnchorY, headSizeNorm } = liveRef.current;
    if (!el || !b || page !== 'radio') return;
    const rect = el.getBoundingClientRect();
    const pt = toStageSpace(clientX, clientY, rect, isNativeStage());
    const rects = petZoneRects(b, headAnchorY ?? 0.16, headSizeNorm ?? 0.18);
    const zone = petZoneAt(rects, pt.x, pt.y);
    if (zone === 'none') return;
    const now = Date.now();
    const prev = streakRef.current;
    const streak = prev && prev.zone === zone && now - prev.at < STREAK_WINDOW_MS ? prev.count + 1 : 1;
    streakRef.current = { zone, count: streak, at: now };
    const wake = scheduleRef.current.napping;
    mutatePersist((p) => applyTap(p, zone, now));
    fireReaction(
      petReactionFor(djId, { kind: 'tap', zone, streak, wake }, moodOf()),
      toDesignSpace(clientX, clientY, rect),
    );
  }, [djId, page, screenRef, mutatePersist, fireReaction, moodOf]);

  const onModelBounds = useCallback((b: ModelBounds) => { boundsRef.current = b; }, []);

  const onVoiceHeard = useCallback(() => {
    const now = Date.now();
    mutatePersist((p) => applyCall(p, now));
    scheduleRef.current = markReaction(scheduleRef.current, now);
  }, [mutatePersist]);

  // ——喂食（点一下直接喂）：拖拽在 3.5 寸真机上双输——触摸流被 .radio-root 的 pan-y 抢走
  // （CDP 实测 2 个 move 后 pointercancel），且 emoji 藏在指腹下根本看不见（Ben 点名）。
  // 改成 tap → 零食自己飞到嘴边（.pet-drag-ghost 的 CSS transition 接管）→ 落地结算喂食。
  const FLIGHT_MS = 450;
  const tapFeedSnack = useCallback((snack: SnackId, sourceEl: { getBoundingClientRect: () => DOMRect }) => {
    const el = screenRef.current;
    if (!el || flightActiveRef.current) return;
    const rect = el.getBoundingClientRect();
    const sr = sourceEl.getBoundingClientRect();
    const start = toDesignSpace((sr.left + sr.right) / 2, (sr.top + sr.bottom) / 2, rect);
    // 终点=嘴点（bounds 空间→设计坐标：原生 bounds 是容器真实 px 要除缩放，Pixi 本来就是设计 px）
    const b = boundsRef.current;
    const { headAnchorY, headSizeNorm } = liveRef.current;
    let end = { x: DESIGN_W / 2, y: DESIGN_H * 0.66 }; // bounds 未就绪的兜底落点
    if (b && rect.width > 0 && rect.height > 0) {
      const m = petZoneRects(b, headAnchorY ?? 0.16, headSizeNorm ?? 0.18).mouth;
      end = isNativeStage()
        ? { x: m.x * (DESIGN_W / rect.width), y: m.y * (DESIGN_H / rect.height) }
        : { x: m.x, y: m.y };
    }
    flightActiveRef.current = true;
    const seq = ++flightSeqRef.current;
    setPanelOpen(false);
    setFlight({ snack, x: start.x, y: start.y });
    // 下一拍再切终点：同一帧连设两次会被合并成瞬移，30ms 足够首帧样式落地
    pushTimer(setTimeout(() => {
      if (flightSeqRef.current === seq) setFlight({ snack, x: end.x, y: end.y });
    }, 30));
    pushTimer(setTimeout(() => {
      flightActiveRef.current = false;
      if (flightSeqRef.current !== seq) return; // 换角色等已作废
      setFlight(null);
      const now = Date.now();
      const favorite = favoriteSnackFor(djId) === snack;
      const sated = derivePet(persistRef.current, now).hunger === 'full';
      mutatePersist((p) => applyFeed(p, { favorite, sated }, now).next);
      fireReaction(
        petReactionFor(djId, { kind: 'feed', favorite, sated }, moodOf()),
        end,
        true, // 投喂是郑重操作，不吃 800ms 冷却
      );
    }, FLIGHT_MS + 60));
  }, [djId, screenRef, mutatePersist, fireReaction, moodOf]);

  // ——每日问候（greetEnabled=P2 开）——
  // ★判定挪出 setState updater：updater 内的 eager-state 优化只在「无其他挂起更新」时同步跑，
  // 一旦撞上并发的 tap/feed 更新，greeted 标志会被推迟到下个微任务，本函数已经 `if (!greeted) return`
  // 提前退出——问候被静默吞掉（lastGreetDay 已经写盘，动作/气泡再也不会补发）。改成用 persistRef.current
  // （恒为最新值，非 React state）先纯判定要不要问候，再落盘；mutatePersist 里用最新 p 重算保持幂等
  // （同日重入是 no-op），不会与并发 tap/feed 更新互相踩写。
  useEffect(() => {
    if (!liveRef.current.greetEnabled || !djReady || page !== 'radio') return;
    const now = Date.now();
    // ★读 loadPet(djId) 而非 persistRef.current：djId 刚变的这一轮，reset effect 的 setPersist 尚未提交，
    // persistRef.current 还是上一只角色的档案；loadPet 直接读磁盘拿到当前 djId 的真档案。
    const r = tryGreet(loadPet(djId), now);
    if (!r.greeted) return;
    mutatePersist((p) => tryGreet(p, now).next);
    pushTimer(setTimeout(() => {
      fireReaction(petReactionFor(djId, { kind: 'greet' }, moodOf()), undefined, true);
      showBubble('来啦！', 4000);
    }, GREET_DELAY_MS));
  }, [djReady, djId, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // ——挂机调度（idleEnabled=P4 开）：30s tick，全靠 liveRef 读最新门控——
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  useEffect(() => {
    if (!djReady) return;
    const id = setInterval(() => {
      const live = liveRef.current;
      if (!live.idleEnabled) return;
      const d = derivePet(persistRef.current, Date.now());
      const { behavior, next } = decideIdle(scheduleRef.current, {
        now: Date.now(),
        page: live.page,
        blocked: live.overlayOpen || panelOpenRef.current || live.inCall || live.barking,
        playing: live.playing,
        hunger: d.hunger,
        sleepy: d.sleepy,
        level: d.level,
        boredMs: d.boredMs,
        avatarId: live.djId,
      });
      scheduleRef.current = next;
      if (!behavior) return;
      if (behavior === 'hungryRemind') showBubble('有点饿了…', 5000);
      fireReaction(petReactionFor(live.djId, { kind: 'idle', behavior }, { hunger: d.hunger, sleepy: d.sleepy, level: d.level }));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [djReady, fireReaction, showBubble]);

  // 卸载清理
  useEffect(() => () => {
    cancelAnimationFrame(nudgeRafRef.current);
    for (const id of timersRef.current) clearTimeout(id);
    timersRef.current = [];
  }, []);

  return {
    persist, derived, panelOpen, setPanelOpen, bubble,
    petAction, petParamOverrides, hearts, flight,
    onScreenTap, onModelBounds, onVoiceHeard, tapFeedSnack,
  };
}

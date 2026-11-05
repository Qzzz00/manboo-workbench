/**
 * 手机上的串联:登录 / 配对成功那一刻,黑洞里的粒子飞出来,聚成舞台页(或引导页)上事务官的粒子球。
 * 与电脑端 workbench-plugin/src/client/brand/brandHandoff.ts 同一套分镜、同一个 runHandoff(blackhole.js),
 * 区别只在终点:手机的球是 `.ba-particles__canvas`,参数用核心默认外观(Mac 那份外观要登录之后才拿得到)
 * 经 phoneOrbSettings(光团关)—— 与欢迎屏以前那颗球同一份。
 *
 * 起点:欢迎屏上那份黑洞(handleRef);扫码页 / 账号页上没有黑洞时,在屏幕上部现造一份
 * (fallbackRect,与欢迎屏黑洞同一块位置),同样淡出、飞走 —— 这一下不因为走了哪条路登录而缺席。
 *
 * **不拦人**:overlay pointer-events:none,App 照常换屏、照常能点;动画出任何错都吞掉。
 * 「减少动效」:只淡出淡入 0.6 秒。没有 2D 画布:什么都不做。
 *
 * **去卡顿(2026-09-24 维护者真机:「无论是电脑端还是手机端,粒子从黑洞变成球的过程都是先卡住的」)**:
 * 手机上真走的几乎都是「屏上没有黑洞」那条(配对在扫码页、账号在账号页),原来配对成功那一下同步
 * 「另造画家 + 画一整帧黑洞(带光环、柔光)+ 扫 20440 颗 + 造终点核心预热 60 步」,WebView 上是几百毫秒的冻结。
 * 现在登录流程一挂上(LoginPage)就在空闲时间里把这些全做好(prepareBrandHandoff),配对成功只剩贴图起飞;
 * 飞几颗按这台手机画黑洞的实际耗时降级(adaptiveHandoffCount)。
 */
import { adaptiveHandoffCount, handoffPlan, onHandoffPerf, orbTargets, prepareHandoff, runHandoff, type HandoffHandle, type HandoffPerf, type PreparedHandoff, type SwarmLike } from './blackhole.js';
import { SwarmV4 } from '../swarm/core.js';
import { defaultPreset } from '../swarm/appearance';
import { phoneOrbSettings } from '../swarm/orbState';
import type { HeroHandle } from './BlackholeHero';

export type HandoffMode = 'none' | 'fade' | 'fly';

export function handoffMode(env: { canvas: boolean; reduced: boolean }): HandoffMode {
  if (!env.canvas) return 'none';
  return env.reduced ? 'fade' : 'fly';
}

/** 手机上飞几颗:比电脑少(手机 CPU、屏小)。 */
export const PHONE_HANDOFF_COUNT = 480;

/** 没有黑洞在屏上时,起点摆在哪儿:屏幕上部,与欢迎屏黑洞同一块。 */
export function fallbackHeroRect(width: number, height: number): { left: number; top: number; width: number; height: number } {
  return { left: 0, top: height * 0.04, width, height: Math.min(height * 0.34, width * 0.8) };
}

export function findOrbCanvas(root: ParentNode = document): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null, area = 0;
  root.querySelectorAll<HTMLCanvasElement>('.ba-particles__canvas').forEach((canvas) => {
    const rect = canvas.getBoundingClientRect(), size = rect.width * rect.height;
    if (size > area) { best = canvas; area = size; }
  });
  return best;
}

/** 手机上现造的那份黑洞每几颗画一颗(与欢迎屏 HERO_STRIDE 同)。 */
const PHONE_SOURCE_STRIDE = 5;

let prepared: PreparedHandoff | null = null;

/**
 * 登录流程挂上时调(LoginPage):空闲时间里预热终点核心、画好「屏上没有黑洞」时的起点、造好飞行层画布;
 * 欢迎屏上有黑洞时也按它挑候选。返回取消函数。没有画布 / 减少动效:什么都不做。
 */
export function prepareBrandHandoff(hero: { readonly current: HeroHandle | null }): () => void {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (handoffMode({ canvas: canvasAvailable(), reduced }) !== 'fly') return () => {};
  try {
    const job = prepareHandoff({
      SwarmClass: SwarmV4 as unknown as new (count: number) => SwarmLike,
      settings: phoneOrbSettings(defaultPreset().settings, 'idle'),
      count: PHONE_HANDOFF_COUNT,
      painter: () => (hero.current?.canvas.isConnected ? hero.current.painter : null),
      clock: () => hero.current?.clock() ?? 12,
      fallbackRect: () => fallbackHeroRect(window.innerWidth, window.innerHeight),
      fallbackStride: PHONE_SOURCE_STRIDE,
    });
    prepared = job;
    return () => { job.cancel(); if (prepared === job) prepared = null; };
  } catch { return () => {}; }
}

function canvasAvailable(): boolean {
  if (typeof CanvasRenderingContext2D === 'undefined' || typeof document === 'undefined') return false;
  try { return document.createElement('canvas').getContext('2d') !== null; } catch { return false; }
}

export function startBrandHandoff(hero: HeroHandle | null): HandoffHandle | null {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const rect = hero?.canvas.isConnected ? hero.canvas.getBoundingClientRect() : null;
  const from = hero && rect && rect.width > 0 ? { painter: hero.painter, rect, clock: hero.clock() } : null;
  const paintMs = from?.painter.paintMs ?? prepared?.source()?.painter.paintMs ?? 0;
  // 这台手机上黑洞一帧就画很久:一开始就不飞粒子,走淡入淡出(2026-09-24 第五轮)。
  const mode = handoffMode({ canvas: canvasAvailable(), reduced: reduced || handoffPlan(paintMs) === 'fade' });
  if (mode === 'none') return null;
  // 3 秒打点:配对 / 登录那一刻还没有能说话的通道,先存着,会话开起来后由 App 送走(setHandoffPerfSender)。
  const stop = onHandoffPerf(perf => { stop(); keepHandoffPerf(perf); });
  try {
    const ready = mode === 'fly' ? prepared : null;
    return runHandoff({
      from,
      fallbackRect: fallbackHeroRect(window.innerWidth, window.innerHeight),
      findOrb: () => findOrbCanvas(),
      ...(mode === 'fly' ? { targets: ready?.targets() ?? orbTargets(SwarmV4 as unknown as new (count: number) => SwarmLike, phoneOrbSettings(defaultPreset().settings, 'idle'), PHONE_HANDOFF_COUNT) } : {}),
      candidates: from ? ready?.candidates() ?? null : null,
      surface: ready?.surface() ?? null,
      source: ready?.source() ?? null,
      stride: PHONE_SOURCE_STRIDE,
      ink: [255, 255, 255],
      reduced: mode === 'fade',
      count: adaptiveHandoffCount(PHONE_HANDOFF_COUNT, paintMs),
      side: 'phone',
      gate: true,
    });
  } catch {
    document.documentElement.removeAttribute('data-brand-handoff');
    document.documentElement.style.removeProperty('--brand-handoff-orb');
    return null;
  }
}

// ─── 真机打点回报(2026-09-24 第五轮):手机经会话的 client 送 `POST /perf/handoff`,进电脑 8791 日志 ───
let unsentPerf: HandoffPerf | null = null;
let perfSender: ((perf: HandoffPerf) => void) | null = null;
function keepHandoffPerf(perf: HandoffPerf): void {
  if (perfSender) { try { perfSender(perf); } catch { /* 不吵 */ } return; }
  unsentPerf = perf;
}
/** 会话开起来时挂上发送器(有攒着的一份就立刻送);会话拆掉时传 null。 */
export function setHandoffPerfSender(send: ((perf: HandoffPerf) => void) | null): void {
  perfSender = send;
  if (send && unsentPerf) { const perf = unsentPerf; unsentPerf = null; try { send(perf); } catch { /* 不吵 */ } }
}

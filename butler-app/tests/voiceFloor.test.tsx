/**
 * 通话页底边的声音光「常驻、不闪」(2026-09-24,卡 `fix/onboarding-call-same-as-call`,确认点 5)。
 *
 * 维护者:「引导的环节,底部的光效果似乎不是流动的,是贴图?反正不是很稳定,并且会闪烁」。
 * 查实的病因之一:每句话之后光落到 0 就把库卸掉、他再开口再装上 —— 重建画布、重放淡入 = 闪;
 * 接通前那道扫光在接通时一帧切掉;下降到后段落不下去(0.16 上下一直亮着、rAF 空转)。
 *
 * 这里把库换成一个会记「挂了几次、卸了几次、最后收到什么」的壳(只认我们交给它的东西),
 * rAF 换成手摇的时钟,按时间轴每 100ms 取样 `data-fx-shown` / 不透明度 / 库在不在,钉住:
 *   1. 两句话之间库不重挂(同一个节点,挂 1 次卸 0 次);没人说时停住(paused)而不是卸掉;
 *   2. 接通前扫光淡出,不一帧归零;
 *   3. 光一定落得到 0,落到就停(不空转);她开口时残光快落;
 *   4. 页面藏起来停住;不在通话整个不画(那时才卸);
 *   5. 交给库的参数:扭曲关、待机呼吸关、线的颜色灰阶、mono。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { FxVoiceFloor } from '../src/fx/Fx';
import { callVoice, VOICE_BAND_COLORS, VOICE_ME, type CallVoice } from '../src/fx/fxModel';

interface BeamProps {
  processing?: boolean;
  paused?: boolean;
  level?: number | (() => number);
  distortion?: number;
  idle?: number;
  colorVariant?: string;
  bandColors?: Record<string, string>;
  children?: unknown;
}

const beam = vi.hoisted(() => ({ mounts: 0, unmounts: 0, last: undefined as unknown }));

vi.mock('voice-glow', () => ({
  VoiceBeam: (props: BeamProps) => {
    beam.last = props;
    useEffect(() => {
      beam.mounts += 1;
      return () => { beam.unmounts += 1; };
    }, []);
    return (
      <div data-testid="voice-beam" data-processing={String(props.processing === true)} data-paused={String(props.paused === true)}>
        {props.children as never}
      </div>
    );
  },
}));

/** 手摇的 rAF:advance(ms) 按 16ms 一帧往前走,每 100ms 回调一次 onSample。 */
let queue: { id: number; cb: FrameRequestCallback }[] = [];
let clock = 0;
let nextId = 1;
function advance(ms: number, onSample?: (at: number) => void): void {
  const end = clock + ms;
  let sampledAt = Math.floor(clock / 100);
  while (clock < end) {
    clock += 16;
    const due = queue;
    queue = [];
    act(() => { for (const one of due) one.cb(clock); });
    const bucket = Math.floor(clock / 100);
    if (onSample !== undefined && bucket !== sampledAt) { sampledAt = bucket; onSample(clock); }
  }
}

beforeEach(() => {
  queue = []; clock = 0; nextId = 1;
  beam.mounts = 0; beam.unmounts = 0; beam.last = undefined;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; queue.push({ id, cb }); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue = queue.filter((one) => one.id !== id); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

const connecting = callVoice({ phase: 'connecting', talk: 'working', micOff: false });
const quiet = callVoice({ phase: 'connected', talk: 'idle', micOff: false });
const me = callVoice({ phase: 'connected', talk: 'listening', micOff: false });
const her = callVoice({ phase: 'connected', talk: 'speaking', micOff: false });
const ended = callVoice({ phase: 'ending', talk: 'idle', micOff: false });

function mount(voice: CallVoice) {
  const view = render(<FxVoiceFloor voice={voice} />);
  const floor = () => view.container.querySelector<HTMLElement>('[data-fx=voice]');
  const shown = () => Number(floor()?.getAttribute('data-fx-shown') ?? 'NaN');
  const opacity = () => Number(floor()?.style.opacity ?? 'NaN');
  const node = () => view.container.querySelector('[data-testid=voice-beam]');
  const set = (next: CallVoice) => view.rerender(<FxVoiceFloor voice={next} />);
  return { view, floor, shown, opacity, node, set };
}

describe('常驻:不因谁说话挂上又卸下', () => {
  it('他说 → 停 → 再说:库一直是同一个节点,只挂过一次;停下落到 0 时停住(paused)而不是卸掉', () => {
    const ui = mount(quiet);
    const first = ui.node();
    expect(first).not.toBeNull();
    expect(first?.getAttribute('data-paused')).toBe('true');
    ui.set(me);
    advance(600);
    expect(ui.shown()).toBe(VOICE_ME);
    expect(ui.node()?.getAttribute('data-paused')).toBe('false');
    ui.set(quiet);
    const timeline: { at: number; shown: number; opacity: number; present: boolean }[] = [];
    advance(3200, (at) => timeline.push({ at, shown: ui.shown(), opacity: ui.opacity(), present: ui.node() !== null }));
    // 一路往下、没有一次跳回去(闪),而且真的落到 0。
    for (let i = 1; i < timeline.length; i += 1) expect(timeline[i]!.shown).toBeLessThanOrEqual(timeline[i - 1]!.shown);
    expect(timeline[timeline.length - 1]).toMatchObject({ shown: 0, opacity: 0, present: true });
    expect(timeline.every((row) => row.present)).toBe(true);
    expect(ui.node()?.getAttribute('data-paused')).toBe('true');
    ui.set(me);
    advance(200);
    expect(ui.shown()).toBeGreaterThan(0.3);
    expect(ui.node()).toBe(first);
    expect(beam.mounts).toBe(1);
    expect(beam.unmounts).toBe(0);
  });

  it('追到就停:落到 0 之后没有一帧还排着(不在后台空转)', () => {
    const ui = mount(me);
    ui.set(quiet);
    advance(3200);
    expect(ui.shown()).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it('库每帧自己来取高度(level 是取值函数):不为每一帧重渲染整个库', () => {
    const ui = mount(quiet);
    ui.set(me);
    advance(48);
    const props = beam.last as BeamProps;
    expect(typeof props.level).toBe('function');
    const read = props.level as () => number;
    expect(read()).toBeGreaterThan(0);
    advance(600);
    expect(read()).toBe(VOICE_ME);
  });
});

describe('接通前那道扫光:淡出,不一帧切掉', () => {
  it('接通那一刻库收到 processing=false(自己收拢扫光),底板按时间轴一路淡下去,约 1 秒内落净', () => {
    const ui = mount(connecting);
    expect(ui.opacity()).toBe(1);
    expect(ui.node()?.getAttribute('data-processing')).toBe('true');
    ui.set(quiet);
    expect(ui.node()?.getAttribute('data-processing')).toBe('false');
    const samples: number[] = [];
    advance(1200, () => samples.push(ui.opacity()));
    // 第一个 100ms 取样时还亮着一大半(不是一帧归零),之后单调往下,最后 0。
    expect(samples[0]!).toBeGreaterThan(0.4);
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
    expect(samples[samples.length - 1]).toBe(0);
    expect(beam.mounts).toBe(1);
    expect(beam.unmounts).toBe(0);
  });
});

describe('她说话时底边一点光都不留', () => {
  it('他刚说完、残光还在时她开口:0.4 秒内落净;她说的整段时间光都是 0', () => {
    const ui = mount(me);
    advance(200);
    ui.set(quiet);
    advance(800);
    expect(ui.opacity()).toBeGreaterThan(0);
    ui.set(her);
    advance(400);
    expect(ui.shown()).toBe(0);
    expect(ui.opacity()).toBe(0);
    const during: number[] = [];
    advance(2000, () => during.push(ui.opacity()));
    expect(Math.max(...during)).toBe(0);
    expect(ui.floor()?.getAttribute('data-fx-level')).toBe('0');
  });
});

describe('看不见时不画', () => {
  it('页面藏起来:库停住(不卸);回来接着走', () => {
    const ui = mount(me);
    advance(200);
    expect(ui.node()?.getAttribute('data-paused')).toBe('false');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(ui.node()?.getAttribute('data-paused')).toBe('true');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(ui.node()?.getAttribute('data-paused')).toBe('false');
    expect(beam.mounts).toBe(1);
  });

  it('挂断中 / 没在通话:整个不画(这时才卸)', () => {
    const ui = mount(me);
    ui.set(ended);
    expect(ui.floor()).toBeNull();
    expect(beam.unmounts).toBe(1);
  });
});

describe('交给库的参数', () => {
  it('扭曲层关、待机呼吸关、mono、线的颜色灰阶', () => {
    mount(me);
    const props = beam.last as BeamProps;
    expect(props.distortion).toBe(0);
    expect(props.idle).toBe(0);
    expect(props.colorVariant).toBe('mono');
    expect(props.bandColors).toEqual(VOICE_BAND_COLORS);
  });
});

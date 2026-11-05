import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PARTICLE_DEGRADED_PREFIX, ParticleStage } from '../src/swarm/ParticleStage';
import { TUNING_DEFAULTS } from '../src/swarm/core.js';
import { ANSWER_LABEL, IncomingCallPage } from '../src/call/IncomingCallPage';
import type { IncomingCall } from '../src/call/incomingModel';

// jsdom 没有 canvas / WebGL:保留真实的粒子动力学(SwarmV4),只把画的那一层换成记录桩。
vi.mock('../src/swarm/core.js', async (importOriginal) => {
  const core = await importOriginal<typeof import('../src/swarm/core.js')>();
  return {
    ...core,
    SwarmRenderer: class {
      cloud = { gl: null };
      constructor(private canvas: HTMLCanvasElement, public swarm: { mode: string; settings: Record<string, number> }) {}
      resize() {}
      setColor(_theme: string, notice: string) { this.canvas.dataset.color = notice; }
      paint() { this.canvas.dataset.paints = String(Number(this.canvas.dataset.paints ?? 0) + 1); this.canvas.dataset.swarmMode = this.swarm.mode; this.canvas.dataset.count = String(this.swarm.settings.count); this.canvas.dataset.cloud = String(this.swarm.settings.cloudSize); this.canvas.dataset.spin = String(this.swarm.settings.spinSpeed); }
    },
  };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function stubCanvas() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('CanvasRenderingContext2D', class {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (f: number) => { frames.delete(f); });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  /** 像真的 rAF 一样:回调跑之前先从队列里拿掉。 */
  const runFrame = (at: number) => { const [first] = [...frames.entries()]; frames.delete(first![0]); first![1](at); };
  return Object.assign(frames, { runFrame });
}

describe('ParticleStage(与电脑端同一份核心)', () => {
  it('五态映射到核心的 mode;需要你 = 球不变 + 琥珀色(2026-09-18:不再变成笑脸);参数(数量)照传进来的用', () => {
    const frames = stubCanvas();
    const settings = { ...TUNING_DEFAULTS, count: 1800 };
    const view = render(<ParticleStage mode="idle" settings={settings} />);
    const canvas = view.container.querySelector('canvas')!;
    expect(canvas.dataset.running).toBe('true');
    expect(frames.size).toBe(1);
    for (const [mode, notice] of [['listening', 'neutral'], ['working', 'neutral'], ['speaking', 'neutral'], ['acknowledging', 'confirmation']] as const) {
      view.rerender(<ParticleStage mode={mode} notice={notice} settings={settings} />);
      expect(canvas.dataset.mode).toBe(mode);
      expect(canvas.dataset.color).toBe(notice);
    }
    // 跑一帧:画出来的就是当前 mode 与数量。
    frames.runFrame(16);
    expect(canvas.dataset.swarmMode).toBe('idle');
    expect(canvas.dataset.count).toBe('1800');
    expect(view.getByRole('img', { name: '事务官:需要你' })).toBeTruthy();
  });
  it('中心光团一律关(2026-09-23 维护者:舞台页「中间还有一团光」,不要);不改传进来的参数', () => {
    const frames = stubCanvas();
    const settings = { ...TUNING_DEFAULTS };
    const view = render(<ParticleStage mode="idle" settings={settings} scene="onboarding" />);
    const canvas = view.container.querySelector('canvas')!;
    frames.runFrame(16);
    expect(canvas.dataset.cloud).toBe('0');
    expect(settings.cloudSize).toBe(TUNING_DEFAULTS.cloudSize);
    // 平时的舞台(不传场景)、说话时也一样没有光团。
    view.rerender(<ParticleStage mode="speaking" settings={settings} />);
    frames.runFrame(32);
    expect(canvas.dataset.cloud).toBe('0');
    expect(canvas.dataset.swarmMode).toBe('speaking');
  });
  /**
   * 2026-09-24 傍晚(卡 fix/scan-orb-working-whole-wait):维护者「只是不要中间的光团……就用莫比乌斯环,但是没有光团的版本」。
   * 在办交核心原版的 working 形、光团关、节奏照用户那一份;在想(preparing)保持待命形 + 转快。
   */
  it('在办:核心原版的 working 形(莫比乌斯环),没有光团;在想:核心照跑待命(球形),自转与漂移提上去', () => {
    const frames = stubCanvas();
    const settings = { ...TUNING_DEFAULTS, spinSpeed: 0.3, drift: 1 };
    const view = render(<ParticleStage mode="working" settings={settings} />);
    const canvas = view.container.querySelector('canvas')!;
    frames.runFrame(16);
    expect(canvas.dataset.mode).toBe('working');
    expect(canvas.dataset.swarmMode).toBe('working');
    expect(canvas.dataset.cloud).toBe('0');
    expect(canvas.dataset.spin).toBe('0.3');
    view.rerender(<ParticleStage mode="idle" settings={settings} />);
    frames.runFrame(24);
    expect(canvas.dataset.swarmMode).toBe('idle');
    expect(canvas.dataset.spin).toBe('0.3');
    view.rerender(<ParticleStage mode="preparing" settings={settings} />);
    frames.runFrame(32);
    expect(canvas.dataset.swarmMode).toBe('idle');
    expect(canvas.dataset.spin).toBe('1');
    expect(canvas.dataset.cloud).toBe('0');
  });
  it('换了 Mac 的参数 → 数量跟着变;paused / 页面隐藏时停帧', () => {
    const frames = stubCanvas();
    const view = render(<ParticleStage mode="idle" settings={{ ...TUNING_DEFAULTS, count: 1800 }} />);
    const canvas = view.container.querySelector('canvas')!;
    view.rerender(<ParticleStage mode="idle" settings={{ ...TUNING_DEFAULTS, count: 600 }} />);
    frames.runFrame(16);
    expect(canvas.dataset.count).toBe('600');
    view.rerender(<ParticleStage mode="idle" settings={{ ...TUNING_DEFAULTS, count: 600 }} paused />);
    expect(canvas.dataset.running).toBe('false');
    expect(frames.size).toBe(0);
    view.rerender(<ParticleStage mode="idle" settings={{ ...TUNING_DEFAULTS, count: 600 }} />);
    expect(canvas.dataset.running).toBe('true');
    expect(frames.size).toBe(1);
  });
  it('画不了 canvas → 退回声纹球,不白屏', () => {
    const view = render(<ParticleStage mode="working" settings={TUNING_DEFAULTS} note="x" />);
    expect(view.container.querySelector('.ba-orb[data-mode="working"]')).toBeTruthy();
  });

  /**
   * 2026-09-22:**退级要说得出原因**。以前这里 `catch { setFailed(true) }` 把原因吞了,
   * 于是真机上只剩「球看起来不一样」这一个症状 —— Ben 那句「中间的来电显示不是粒子球」
   * 查起来第一步就是排除「是不是降级了」,而当时没有任何一条日志回答得了它。
   */
  it('★退回声纹球时说得出为什么(回调 + 一行 console.warn),而且只说一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reasons: string[] = [];
    const view = render(<ParticleStage mode="idle" settings={TUNING_DEFAULTS} onDegraded={r => reasons.push(r)} />);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBeTruthy();
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith(PARTICLE_DEGRADED_PREFIX))).toHaveLength(1);
    view.rerender(<ParticleStage mode="listening" settings={TUNING_DEFAULTS} onDegraded={r => reasons.push(r)} />);
    expect(reasons).toHaveLength(1);
  });
});

/**
 * ——— 来电页中间那颗球(2026-09-22,Ben 真机:「中间的来电显示不是粒子球」)———
 *
 * 09-21 那一版来电页画的是轻的那颗声纹球,理由写的是「锁屏上拉起来时 WebGL 不一定活着」。
 * 那条理由不成立:粒子核心画在 2D canvas 上,而且它**自己带降级**。
 * 这两条用例钉的就是「画得了就是粒子球、画不了才退回声纹球」。
 */
describe('来电页中间是同一颗粒子球', () => {
  const call: IncomingCall = {
    call_id: 'c1', reason: 'done', item_id: 'task-1', title: '下班待办',
    at: '2026-09-22T10:00:00.000Z', until: Date.now() + 60_000,
  };

  it('★画得了 canvas → 中间是粒子球(和主界面同一份核心),不是那颗轻的声纹球', () => {
    stubCanvas();
    const view = render(<IncomingCallPage call={call} onAnswer={() => {}} onLater={() => {}} />);
    const slot = view.container.querySelector('.ba-incoming__orb')!;
    expect(slot.querySelector('.ba-particles')).toBeTruthy();
    expect(slot.querySelector('canvas')).toBeTruthy();
    // 「完成」这一类是绿的那一档;颜色跟舞台页同一套 StageNotice,不为来电页新造一档。
    expect(slot.querySelector('.ba-particles')?.getAttribute('data-notice')).toBe('completed');
    // 三颗键仍然在,而且和球是兄弟节点(球不该把它们包进去)。
    expect(view.getByText(ANSWER_LABEL)).toBeTruthy();
    expect(slot.contains(view.getByText(ANSWER_LABEL))).toBe(false);
  });

  it('画不了 canvas → 退回声纹球(铃响着不能白屏),并把原因交出去', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reasons: string[] = [];
    const view = render(
      <IncomingCallPage call={call} onAnswer={() => {}} onLater={() => {}} onOrbDegraded={r => reasons.push(r)} />,
    );
    expect(view.container.querySelector('.ba-incoming__orb .ba-orb')).toBeTruthy();
    expect(reasons).toHaveLength(1);
  });
});

/**
 * 动效配角(手机端,2026-09-23):状态 → 效果的映射,一屏一种强效果,录音让路,通话页声音光。
 * 设计见 docs/设计-动效配角-2026-09-23.md。认我们自己包的那一层 `.ba-fx[data-fx]`,不认库内部结构。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  BEAM, beamSize, beamTuneCss, callVoice, isStrong, smoothVoiceLevel, stageCardFx, stageStrong, stepVoiceFloor, VOICE_BAND_COLORS, VOICE_FALL_MS, VOICE_HER,
  VOICE_HER_FALL_MS, VOICE_ME, VOICE_SWEEP_FADE_MS, voiceBeamPaused, voiceFloorOpacity, voiceFloorSettled, type CallVoice, type VoiceFloorShown,
} from '../src/fx/fxModel';
import { FxBeam, FxVoiceFloor } from '../src/fx/Fx';
import { StageCards } from '../src/stage/StageCards';
import type { WorkbenchState } from '../src/api/protocol';

describe('映射(纯函数)', () => {
  it('首页强效果最多一个:录音中谁都不亮 > 那句在路上 → 输入框 > 在办 → 「正在办」那块卡(2026-09-25)', () => {
    expect(stageStrong({ recording: true, sending: true, working: true })).toBeNull();
    expect(stageStrong({ recording: false, sending: true, working: true })).toBe('composer');
    expect(stageStrong({ recording: false, sending: false, working: true })).toBe('doing');
    expect(stageStrong({ recording: false, sending: false, working: false })).toBeNull();
  });

  it('卡片:等你确认有东西就呼吸;「正在办」只在强效果归它且有行时走光;别的卡不挂', () => {
    expect(stageCardFx({ id: 'confirm', lines: 2 }, null)).toEqual({ beam: 'confirm', active: true });
    expect(stageCardFx({ id: 'confirm', lines: 0 }, 'doing')).toEqual({ beam: 'confirm', active: false });
    expect(stageCardFx({ id: 'doing', lines: 3 }, 'doing')).toEqual({ beam: 'doing', active: true });
    expect(stageCardFx({ id: 'doing', lines: 3 }, 'composer')).toEqual({ beam: 'doing', active: false });
    expect(stageCardFx({ id: 'doing', lines: 0 }, 'doing')).toEqual({ beam: 'doing', active: false });
    expect(stageCardFx({ id: 'today', lines: 3 }, 'doing')).toEqual({ beam: null, active: false });
    expect(stageCardFx({ id: 'feed', lines: 1 }, 'doing')).toEqual({ beam: null, active: false });
  });

  it('通话声音光(2026-09-24 翻过来):你说话时升起;她说话不升;麦克风关着不升;没人说不亮;接通前来回扫;没通话不画', () => {
    expect(callVoice({ phase: 'connecting', talk: 'working', micOff: false })).toEqual({ on: true, level: 0, processing: true, hers: false });
    expect(callVoice({ phase: 'connected', talk: 'listening', micOff: false })).toEqual({ on: true, level: VOICE_ME, processing: false, hers: false });
    expect(callVoice({ phase: 'connected', talk: 'speaking', micOff: false })).toEqual({ on: true, level: 0, processing: false, hers: true });
    expect(callVoice({ phase: 'connected', talk: 'listening', micOff: true })).toEqual({ on: true, level: 0, processing: false, hers: false });
    expect(callVoice({ phase: 'connected', talk: 'idle', micOff: false })).toEqual({ on: true, level: 0, processing: false, hers: false });
    for (const phase of ['idle', 'ending', 'ended', 'error'] as const) {
      expect(callVoice({ phase, talk: 'idle', micOff: false }).on).toBe(false);
    }
    expect(VOICE_HER).toBe(0);
    expect(VOICE_ME).toBeGreaterThan(0);
  });

  it('光跟的是「谁在出声」,不是球的样子:talk 只认 listening(你)/ speaking(她),在办的球不影响(找项目时 useCall 给的是 talkMode)', () => {
    // talk 本身不会是 working(那是球被按成在办);就算传进来也只当「都没说」,不会把光点亮或按灭成别的样子。
    expect(callVoice({ phase: 'connected', talk: 'working', micOff: false })).toEqual({ on: true, level: 0, processing: false, hers: false });
  });

  it('声音光平滑:上升快(0.2 秒内接近满)、下降慢(停顿 0.2 秒只略降),不在 0 与高值之间跳', () => {
    const run = (from: number, target: number, ms: number) => {
      let v = from;
      for (let t = 0; t < ms; t += 16) v = smoothVoiceLevel(v, target, 16);
      return v;
    };
    expect(run(0, VOICE_ME, 200)).toBeGreaterThan(VOICE_ME * 0.85);
    const afterPause = run(VOICE_ME, 0, 200);
    expect(afterPause).toBeGreaterThan(VOICE_ME * 0.65);
    expect(run(VOICE_ME, 0, VOICE_FALL_MS * 6)).toBe(0);
    // 说 / 听每 150ms 来回切(真机上 VAD 抖):屏幕上的值始终在一个窄带里,不会掉到底又弹满。
    let v = 0; const seen: number[] = [];
    for (let t = 0; t < 3000; t += 16) {
      const target = Math.floor(t / 150) % 2 === 0 ? VOICE_ME : 0;
      v = smoothVoiceLevel(v, target, 16);
      if (t > 600) seen.push(v);
    }
    expect(Math.max(...seen) - Math.min(...seen)).toBeLessThan(VOICE_ME * 0.35);
    // 页面藏起来很久又回来:一大步也不越过目标。
    expect(smoothVoiceLevel(0.1, VOICE_ME, 100000)).toBe(VOICE_ME);
    expect(smoothVoiceLevel(0.3, 0.3, 16)).toBe(0.3);
  });

  it('底板不透明度跟着光与扫光:没人说且扫光淡完 = 0(不留底光),接通前扫光全亮', () => {
    expect(voiceFloorOpacity(0, 0)).toBe(0);
    expect(voiceFloorOpacity(VOICE_ME, 0)).toBe(1);
    expect(voiceFloorOpacity(0, 1)).toBe(1);
    expect(voiceFloorOpacity(0.06, 0)).toBeCloseTo(0.5);
    expect(voiceFloorOpacity(0, 0.4)).toBeCloseTo(0.4);
  });

  const connecting: CallVoice = callVoice({ phase: 'connecting', talk: 'working', micOff: false });
  const quiet: CallVoice = callVoice({ phase: 'connected', talk: 'idle', micOff: false });
  const me: CallVoice = callVoice({ phase: 'connected', talk: 'listening', micOff: false });
  const her: CallVoice = callVoice({ phase: 'connected', talk: 'speaking', micOff: false });
  /** 按 16ms 一帧往前走 ms,每 100ms 记一次底板不透明度。 */
  const play = (from: VoiceFloorShown, voice: CallVoice, ms: number) => {
    let v = from; const samples: number[] = [];
    for (let t = 16; t <= ms; t += 16) {
      v = stepVoiceFloor(v, voice, 16);
      if (t % 96 === 0) samples.push(voiceFloorOpacity(v.level, v.sweep));
    }
    return { v, samples };
  };

  it('接通那一刻扫光淡出,不一帧切掉:第一帧还几乎全亮,之后一路往下,约 1 秒内落净', () => {
    const first = stepVoiceFloor({ level: 0, sweep: 1 }, quiet, 16);
    expect(first.sweep).toBeGreaterThan(0.9);
    const { v, samples } = play({ level: 0, sweep: 1 }, quiet, 1200);
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
    expect(samples[0]!).toBeGreaterThan(0.5);
    expect(v).toEqual({ level: 0, sweep: 0 });
    expect(voiceFloorSettled(v, quiet)).toBe(true);
    // 淡出的时间常数就是这一条(约 0.6 秒看不见)。
    expect(VOICE_SWEEP_FADE_MS).toBeGreaterThanOrEqual(150);
    expect(VOICE_SWEEP_FADE_MS).toBeLessThanOrEqual(300);
    // 接通前:扫光一出来就全亮(库自己有淡入),光的高度 0。
    expect(stepVoiceFloor({ level: 0, sweep: 0 }, connecting, 16)).toEqual({ level: 0, sweep: 1 });
  });

  it('她开口时底边一点光都不留:他刚说完的残光按快档落,0.4 秒内落净(平时下降仍是慢档)', () => {
    // 他说满,停 1 秒:平时慢慢落,这时还剩一点。
    let v: VoiceFloorShown = { level: VOICE_ME, sweep: 0 };
    v = play(v, quiet, 1000).v;
    expect(v.level).toBeGreaterThan(0.05);
    // 她一开口:快档。
    const after = play(v, her, 400).v;
    expect(after.level).toBe(0);
    expect(voiceFloorOpacity(after.level, after.sweep)).toBe(0);
    expect(VOICE_HER_FALL_MS).toBeLessThan(VOICE_FALL_MS / 3);
    // 不是一帧切掉:第一帧之后还看得见一点。
    expect(stepVoiceFloor(v, her, 16).level).toBeGreaterThan(0);
  });

  it('一定落得到 0、追到就停:从满格起慢档下降,3 秒内正好是 0(以前卡在 0.16 上下一直空转)', () => {
    const { v } = play({ level: VOICE_ME, sweep: 0 }, quiet, 3000);
    expect(v).toEqual({ level: 0, sweep: 0 });
    expect(voiceFloorSettled(v, quiet)).toBe(true);
    // 上升也追得到目标本身(不停在差一点的地方)。
    expect(play({ level: 0, sweep: 0 }, me, 600).v.level).toBe(VOICE_ME);
  });

  it('库停住的时机:底板全透明(没人说、扫光淡完)或页面藏起来;停住不等于卸掉', () => {
    expect(voiceBeamPaused({ level: 0, sweep: 0 }, false)).toBe(true);
    expect(voiceBeamPaused({ level: 0.2, sweep: 0 }, false)).toBe(false);
    expect(voiceBeamPaused({ level: 0, sweep: 0.3 }, false)).toBe(false);
    expect(voiceBeamPaused({ level: 0.2, sweep: 0 }, true)).toBe(true);
  });

  it('线上沿那圈色散一律灰阶(mono 不残留红蓝,2026-09-24 全局去蓝)', () => {
    for (const color of Object.values(VOICE_BAND_COLORS)) {
      const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
      expect(m).not.toBeNull();
      expect(new Set(m!.slice(1)).size).toBe(1);
    }
    expect(Object.keys(VOICE_BAND_COLORS).sort()).toEqual(['above', 'below', 'core', 'mid']);
  });

  it('强弱:走的光是强效果,呼吸是弱效果', () => {
    expect(isStrong(BEAM.composer.kind)).toBe(true);
    expect(isStrong(BEAM.doingCard.kind)).toBe(true);
    expect(isStrong(BEAM.confirmCard.kind)).toBe(false);
    expect(beamSize('pulse')).toBe('pulse-inner');
    // 2026-09-24 全局去蓝:每一处光都是黑白灰(mono),关色相漂移。
    for (const spec of Object.values(BEAM)) expect([spec.tone, spec.staticColors]).toEqual(['mono', true]);
  });
});

describe('组件', () => {
  it('FxBeam 挂着 border-beam;亮灭切换不重建里面的东西', () => {
    const { container, rerender } = render(<FxBeam name="t" spec={BEAM.composer} active={false}><button type="button">框</button></FxBeam>);
    const button = screen.getByRole('button', { name: '框' });
    expect(container.querySelector('.ba-fx[data-fx=t] [data-beam]')).not.toBeNull();
    rerender(<FxBeam name="t" spec={BEAM.composer} active><button type="button">框</button></FxBeam>);
    expect(screen.getByRole('button', { name: '框' })).toBe(button);
    expect(container.querySelector('.ba-fx[data-fx=t]')?.getAttribute('data-fx-active')).toBe('true');
  });

  it('声音光:不在通话时整个不画;在通话时是一层不接点击的底板', () => {
    const { container, rerender } = render(<FxVoiceFloor voice={{ on: false, level: 0, processing: false, hers: false }} />);
    expect(container.querySelector('[data-fx=voice]')).toBeNull();
    rerender(<FxVoiceFloor voice={{ on: true, level: VOICE_ME, processing: false, hers: false }} />);
    const floor = container.querySelector('[data-fx=voice]')!;
    expect(floor.getAttribute('aria-hidden')).toBe('true');
    expect(floor.getAttribute('data-fx-level')).toBe(String(VOICE_ME));
  });

  const state = {
    agents: [], quota: {}, stale: false, now: '2026-09-23T12:00:00Z',
    sessions: [{ agent: 'dsh', session_id: 's', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v' }],
    tasks: { tasks: [{ id: 'a', title: '写登录页', status: 'doing', direction: 'mine', source: { kind: 'manual' }, created_at: '', updated_at: '' }], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [{ id: 'i', kind: 'confirm', title: '验收报告', at: '2026-09-23T11:00:00Z' }] },
  } as unknown as WorkbenchState;

  it('首页卡片:「正在办」在强效果归它时走光、等你确认呼吸;旧数据展开时都不亮', () => {
    const running = { ...state, tasks: { ...(state.tasks as object), tasks: [{ id: 'a', title: '写登录页', status: 'doing', direction: 'mine', conversation: { agent: 'dsh', session_id: 's' }, source: { kind: 'manual' }, created_at: '', updated_at: '' }] } } as unknown as WorkbenchState;
    const { container, rerender } = render(<StageCards state={running} strong="doing" />);
    const active = () => [...container.querySelectorAll('.ba-fx[data-fx-active=true]')].map((one) => one.getAttribute('data-fx'));
    expect(active()).toEqual(['card-doing', 'card-confirm']);
    rerender(<StageCards state={running} strong="composer" />);
    expect(active()).toEqual(['card-confirm']);
    rerender(<StageCards state={running} strong="doing" stale={{ label: '上次的数据', open: true, onToggle() {} }} />);
    expect(active()).toEqual([]);
  });

  it('光的三层分开抬(与电脑端同一组数);「正在办」与电脑上在办那张卡同一套', () => {
    expect(BEAM.doingCard.tune).toEqual({ stroke: 6, bloom: 4, inner: 1.5 });
    expect(beamTuneCss(BEAM.doingCard.tune)).toBe('[data-beam="{id}"]{--beam-stroke-opacity:6;--beam-bloom-opacity:4;--beam-inner-opacity:1.5}');
    expect(beamTuneCss(undefined)).toBeUndefined();
  });
});

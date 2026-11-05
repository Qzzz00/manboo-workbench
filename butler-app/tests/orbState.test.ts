import { describe, expect, it } from 'vitest';
import { signalsFromState, stageModeOf } from '../src/swarm/orbState';
import { emptyState } from '../src/api/protocol';

describe('粒子球五态映射', () => {
  it('优先级:说话 > 聆听 > 在办(颜色随需要你 / 出错)> 需要你 > 待命', () => {
    const base = { speaking: false, listening: false, working: false, attention: false };
    expect(stageModeOf(base)).toEqual({ mode: 'idle', notice: 'neutral' });
    expect(stageModeOf({ ...base, working: true })).toEqual({ mode: 'working', notice: 'neutral' });
    // 2026-10-01 维护者:「有运行中的卡片时候,粒子球应该是旋转的莫比乌斯环」—— 在跑时形状不让位,等你 / 出错只换颜色。
    expect(stageModeOf({ ...base, working: true, attention: true })).toEqual({ mode: 'working', notice: 'confirmation' });
    expect(stageModeOf({ ...base, working: true, attention: true, failed: true })).toEqual({ mode: 'working', notice: 'failed' });
    expect(stageModeOf({ ...base, attention: true })).toEqual({ mode: 'acknowledging', notice: 'confirmation' });
    expect(stageModeOf({ ...base, attention: true, listening: true })).toEqual({ mode: 'listening', notice: 'neutral' });
    expect(stageModeOf({ ...base, listening: true, speaking: true })).toEqual({ mode: 'speaking', notice: 'neutral' });
  });
  it('说话准备(事务官在想):低于在办、需要你与聆听', () => {
    const base = { speaking: false, listening: false, working: false, attention: false };
    expect(stageModeOf({ ...base, thinking: true })).toEqual({ mode: 'preparing', notice: 'neutral' });
    // 2026-10-01「只要有东西在做有卡在运行就是莫比乌斯环」:在想不再压过在办(电脑那边打字才变,没有「在想」这一档)。
    expect(stageModeOf({ ...base, thinking: true, working: true })).toEqual({ mode: 'working', notice: 'neutral' });
    expect(stageModeOf({ ...base, thinking: true, attention: true }).mode).toBe('acknowledging');
    expect(stageModeOf({ ...base, thinking: true, listening: true }).mode).toBe('listening');
  });
  it('从 /state 来的信号:有会话在跑 = 在办;收件箱有东西 = 需要你', () => {
    const state = { ...emptyState(), stale: false, sessions: [{ agent: 'dsh' as const, session_id: 's', project: '', status: 'running' as const, elapsed_sec: 1, unread: false, updated_at: '' }], butler_inbox: { items: [] } };
    expect(signalsFromState(state, { speaking: false, listening: false })).toEqual({ speaking: false, listening: false, working: true, attention: false, failed: false });
    expect(signalsFromState({ ...state, butler_inbox: { items: [{ id: 'i', kind: 'confirm' as const, title: 'x' }] } }, { speaking: false, listening: true }).attention).toBe(true);
  });
  /**
   * 2026-09-25(统筹转维护者:「codex 和 Claude 都有会话在跑,它说 0 执行」):各家客户端有一条在跑也算在办,
   * 与电脑首页同一个口径;电脑没连上(快照旧)时不凭旧数据说在办。
   */
  it('★Codex 那边有一条在跑也算在办;快照旧的时候不算', () => {
    const codex = { agent: 'codex' as const, session_id: 'cx', project: '', status: 'running' as const, elapsed_sec: 1, unread: false, updated_at: '' };
    expect(signalsFromState({ ...emptyState(), stale: false, sessions: [codex] }, { speaking: false, listening: false }).working).toBe(true);
    expect(signalsFromState({ ...emptyState(), stale: true, sessions: [codex] }, { speaking: false, listening: false }).working).toBe(false);
  });
  /** 2026-10-01「全平台都是一致的」:在办认服务端那一个数 `running.count`(电脑首页球下「执行 n」同源);老工作台没有才自己数。 */
  it('★在办认 /state.running.count:事项在执行也算;它说 0 就不算;快照旧不算', () => {
    const st = (over: Record<string, unknown>) => ({ ...emptyState(), stale: false, ...over }) as unknown as import('../src/api/protocol').WorkbenchState;
    const run = { agent: 'claude', session_id: 's', project: '', status: 'running', elapsed_sec: 1, unread: false, updated_at: '' };
    expect(signalsFromState(st({ running: { count: 1, items: [] } }), { speaking: false, listening: false }).working).toBe(true);
    expect(signalsFromState(st({ running: { count: 0, items: [] }, sessions: [run] }), { speaking: false, listening: false }).working).toBe(false);
    expect(signalsFromState(st({ stale: true, running: { count: 2, items: [] } }), { speaking: false, listening: false }).working).toBe(false);
    expect(signalsFromState(st({ running: { items: [] }, sessions: [run] }), { speaking: false, listening: false }).working).toBe(true);
  });
  it('★登记表里在跑的会话(窗口型那几家、新家)也算在办;没接上的那家不算', () => {
    const reg = (status: string, gaps: Record<string, string> = {}) => ({
      ...emptyState(), stale: false,
      agent_registry: { entries: [{ id: 'muse', name: 'Muse', status, gaps, sessions: [{ agent: 'muse', session_id: 'm', status: 'running' }], counts: { running: 1, waiting: 0, unread: 0 } }] },
    }) as unknown as import('../src/api/protocol').WorkbenchState;
    expect(signalsFromState(reg('running'), { speaking: false, listening: false }).working).toBe(true);
    expect(signalsFromState(reg('unknown'), { speaking: false, listening: false }).working).toBe(false);
    expect(signalsFromState(reg('running', { status: '读不到' }), { speaking: false, listening: false }).working).toBe(false);
  });
});

describe('signalsFromState 的「需要你」(2026-09-18)', () => {
  const state = (items: { kind: string }[]) => ({ sessions: [], butler_inbox: { items } }) as unknown as import('../src/api/protocol').WorkbenchState;
  it('只有等拍板 / 风险两类才算需要你;会话卡与例程汇报不算', () => {
    expect(signalsFromState(state([{ kind: 'session' }, { kind: 'sentinel' }]), { speaking: false, listening: false }).attention).toBe(false);
    expect(signalsFromState(state([{ kind: 'confirm' }]), { speaking: false, listening: false }).attention).toBe(true);
    expect(signalsFromState(state([{ kind: 'risk' }]), { speaking: false, listening: false }).attention).toBe(true);
    expect(signalsFromState(state([]), { speaking: false, listening: false }).attention).toBe(false);
  });
});

describe('sceneSettings(中心光团在手机上一律关,2026-09-23 第二轮从零重装)', () => {
  it('任何场景都把 cloudSize 归零,别的不动;已经是 0 就原样同一引用', async () => {
    const { sceneSettings } = await import('../src/swarm/orbState');
    const { TUNING_DEFAULTS } = await import('../src/swarm/core.js');
    const settings = { ...TUNING_DEFAULTS };
    expect(TUNING_DEFAULTS.cloudSize).toBeGreaterThan(0);
    expect(sceneSettings(settings, 'onboarding')).toEqual({ ...settings, cloudSize: 0 });
    expect(sceneSettings(settings)).toEqual({ ...settings, cloudSize: 0 });
    expect(sceneSettings(settings, 'workbench')).toEqual({ ...settings, cloudSize: 0 });
    expect(settings.cloudSize).toBe(TUNING_DEFAULTS.cloudSize);
    const off = { ...settings, cloudSize: 0 };
    expect(sceneSettings(off)).toBe(off);
  });
});

/**
 * 2026-09-24 傍晚(卡 fix/scan-orb-working-whole-wait):维护者澄清 09-23 那次「只是不要中间的光团……就用莫比乌斯环,
 * 但是没有光团的版本」—— 在办恢复核心原版的 working 形,光团照关;在想(preparing)那一档保持现状。
 */
describe('phoneOrbSettings / CORE_MODE(在办 = 莫比乌斯环、没有光团;在想保持球形转快)', () => {
  it('在办交核心的 working 形;在想走待命(球形),不交核心的 speaking 形', async () => {
    const { CORE_MODE } = await import('../src/swarm/orbState');
    expect(CORE_MODE.working).toBe('working');
    expect(CORE_MODE.preparing).toBe('idle');
    expect(CORE_MODE.speaking).toBe('speaking');
    expect(CORE_MODE.listening).toBe('listening');
    expect(CORE_MODE.acknowledging).toBe('idle');
  });
  it('在办:只关光团,节奏照用户那一份(莫比乌斯环本身在动,不再额外提速)', async () => {
    const { phoneOrbSettings } = await import('../src/swarm/orbState');
    const { TUNING_DEFAULTS } = await import('../src/swarm/core.js');
    const settings = { ...TUNING_DEFAULTS, spinSpeed: 0.3, drift: 1 };
    expect(TUNING_DEFAULTS.cloudSize).toBeGreaterThan(0);
    expect(phoneOrbSettings(settings, 'working')).toEqual({ ...settings, cloudSize: 0 });
  });
  it('在想:自转拉到上限、方向跟用户那一项,漂移至少 1.8 倍,光团关;不改入参', async () => {
    const { phoneOrbSettings, BUSY_SPIN, BUSY_DRIFT } = await import('../src/swarm/orbState');
    const { TUNING_DEFAULTS } = await import('../src/swarm/core.js');
    const settings = { ...TUNING_DEFAULTS, spinSpeed: 0.3, drift: 1 };
    const out = phoneOrbSettings(settings, 'preparing');
    expect(out.spinSpeed).toBe(BUSY_SPIN);
    expect(out.drift).toBe(BUSY_DRIFT);
    expect(out.cloudSize).toBe(0);
    expect(phoneOrbSettings({ ...settings, spinSpeed: -0.2 }, 'preparing').spinSpeed).toBe(-BUSY_SPIN);
    expect(phoneOrbSettings({ ...settings, drift: 2.5 }, 'preparing').drift).toBe(2.5);
    expect(settings.spinSpeed).toBe(0.3);
    expect(settings.drift).toBe(1);
  });
  it('待命 / 说话 / 聆听 / 需要你:只关光团,节奏照用户那一份', async () => {
    const { phoneOrbSettings } = await import('../src/swarm/orbState');
    const { TUNING_DEFAULTS } = await import('../src/swarm/core.js');
    const settings = { ...TUNING_DEFAULTS, spinSpeed: 0.3, drift: 1 };
    for (const mode of ['idle', 'speaking', 'listening', 'acknowledging'] as const) {
      expect(phoneOrbSettings(settings, mode)).toEqual({ ...settings, cloudSize: 0 });
    }
  });
});

describe('说话时只有轻微的亮度起伏(光团关了之后,2026-09-23)', () => {
  async function css(): Promise<string> {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    return readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
  }

  it('styles.css:说话态整颗球 0.86–1 明暗,减少动效时不动', async () => {
    const text = await css();
    // 幅度 .14:最暗 0.86、最亮 1(起伏 --ba-orb-wave 在 0 与 1 之间,1.4 秒一个来回)。
    expect(text).toContain('(1 - .14 * var(--ba-orb-speak) * var(--ba-orb-wave))');
    expect(text).toMatch(/@keyframes ba-particles-speak \{ 0%, 100% \{ --ba-orb-wave: 0; \} 50% \{ --ba-orb-wave: 1; \} \}/);
    expect(text).toMatch(/animation: ba-particles-speak 1\.4s ease-in-out infinite/);
    expect(text).toMatch(/prefers-reduced-motion: reduce\) \{ \.ba-particles \.ba-particles__canvas \{ animation: none; \}/);
  });

  it('不因切换重启(2026-09-24):起伏一直挂着,说不说话只改幅度且慢慢过渡;不在说时停在原处', async () => {
    const text = await css();
    // 旧写法(说话态才挂动画、一离开就摘 —— 每次切换从头来、亮度一跳)不能再出现。
    expect(text).not.toMatch(/\.ba-particles\[data-mode="speaking"\] \.ba-particles__canvas \{ animation: ba-particles-speak/);
    expect(text).toContain('.ba-particles[data-mode="speaking"] { --ba-orb-speak: 1; }');
    expect(text).toContain('.ba-particles[data-mode="speaking"] .ba-particles__canvas { animation-play-state: running; }');
    expect(text).toMatch(/transition: --ba-orb-speak \.5s ease/);
    for (const name of ['--ba-orb-speak', '--ba-orb-prep', '--ba-orb-wave']) {
      expect(text).toContain(`@property ${name} { syntax: '<number>';`);
    }
    // 在想(preparing)的收光也走同一条,离开时不再一跳回 1。
    expect(text).toContain('.ba-particles[data-mode="preparing"] { --ba-orb-prep: 1; }');
    expect(text).not.toContain('.ba-particles[data-mode="preparing"] .ba-particles__canvas { opacity: .85;');
  });

  it('打字引导页上半的舞台是纯底色:那片底部发亮的静止渐变去掉了(光只有一套)', async () => {
    const text = await css();
    const rule = /\.ba-chat__stage \{[^}]*\}/.exec(text)?.[0] ?? '';
    expect(rule).toContain('background: var(--ba-bg)');
    expect(rule).not.toContain('gradient');
  });
});

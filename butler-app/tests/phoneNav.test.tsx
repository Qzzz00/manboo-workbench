/**
 * 手机导航:首页是唯一主页、下一级靠返回回来(2026-09-24,卡 fix/phone-nav-back,维护者拍板)。
 *
 * 维护者原话:「这个逻辑也很奇怪啊,首页平时看不到底部栏,我是从设置进入的,从屏幕触发返回上一级无效,
 * 反而要点击底部栏?」(已拍板五条见 docs/决策记录.md 同日那一节。)
 *
 * 这一份钉三层:
 *   1. 返回那一条链(nav/backStack.ts,纯的):档位、后开先收、没人接交给兜底;
 *   2. 壳那一层怎么接(nav/navModel.ts,纯的):下一级 → 首页;来电 / 已接 / 话筒那一通 → 接住不动;
 *      座机页 → 回舞台;哪几格此刻看得见(折叠屏上事项一直在);
 *   3. 整个 App 挂起来、模拟 Capacitor 的 backButton:标签栏不再渲染;每个下一级页顶上一条返回头;
 *      下一级 → 首页、首页 → minimizeApp;详情 / 记录页开着先收它;引导打字页 → 首页、横幅还在。
 * 通话中不挂断、会议录着不走、抽屉先收这几条在 tests/phoneNavLayers.test.tsx。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { App } from '../src/App';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';
import { BACK_LAYER, BACK_PAGE, createBackStack } from '../src/nav/backStack';
import { BackProvider, BackScope, useBackHandler, useSystemBack, type SystemBackDeps } from '../src/nav/back';
import { paneShown, shellBackOf, type ShellScreen } from '../src/nav/navModel';

const system = vi.hoisted(() => ({
  listener: null as null | (() => void),
  minimize: vi.fn(async () => {}),
}));
vi.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: async () => ({ url: '' }),
    addListener: async (event: string, cb: () => void) => {
      if (event === 'backButton') system.listener = cb;
      return { remove: async () => { if (event === 'backButton' && system.listener === cb) system.listener = null; } };
    },
    minimizeApp: system.minimize,
  },
}));
vi.mock('capacitor-zeroconf', () => ({ ZeroConf: { watch: async () => { throw new Error('web'); }, unwatch: async () => {}, close: async () => {} } }));

beforeEach(() => { system.listener = null; system.minimize.mockClear(); });
afterEach(() => { try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ } });

// ————————————————————————————————— 1. 返回那一条链 —————————————————————————————————

describe('返回那一条链(纯的)', () => {
  it('谁都没登记:dispatch 回 false,交给兜底', () => {
    expect(createBackStack().dispatch()).toBe(false);
  });

  it('同一档里后登记的先接(后打开的盖在上面);撤掉之后轮到下面那层', () => {
    const stack = createBackStack();
    const seen: string[] = [];
    stack.push(() => seen.push('详情'));
    const off = stack.push(() => seen.push('抽屉'));
    expect(stack.dispatch()).toBe(true);
    off();
    off(); // 撤两次无害
    expect(stack.dispatch()).toBe(true);
    expect(seen).toEqual(['抽屉', '详情']);
    expect(stack.size()).toBe(1);
  });

  it('壳那一层是最低档:哪怕它后登记,页里开着的那一层也先接', () => {
    const stack = createBackStack();
    const seen: string[] = [];
    stack.push(() => seen.push('详情'), BACK_LAYER);
    stack.push(() => seen.push('回首页'), BACK_PAGE);
    stack.dispatch();
    expect(seen).toEqual(['详情']);
  });
});

describe('壳那一层怎么接(纯的)', () => {
  const base: ShellScreen = { incoming: 'idle', meeting: false, onboarding: false, page: 'stage' };

  it('首页:壳不接(→ 退到后台);下一级:回首页', () => {
    expect(shellBackOf(base)).toBe('none');
    for (const page of ['inbox', 'news', 'settings'] as const) expect(shellBackOf({ ...base, page })).toBe('home');
  });

  it('★来电 / 已接 / 话筒那一通:接住、什么都不做 —— 不管此刻在哪一页', () => {
    for (const incoming of ['ringing', 'answered', 'handset'] as const) {
      expect(shellBackOf({ ...base, incoming })).toBe('stay');
      expect(shellBackOf({ ...base, incoming, page: 'settings' })).toBe('stay');
      expect(shellBackOf({ ...base, incoming, meeting: true })).toBe('stay');
    }
  });

  it('会议页、引导:壳不接,它们自己接', () => {
    expect(shellBackOf({ ...base, meeting: true })).toBe('none');
    expect(shellBackOf({ ...base, onboarding: true, page: 'settings' })).toBe('none');
  });

  // 2026-09-25:座机页整个去掉了(卡 feat/first-look-orb-top),它那三条返回规矩跟着去掉。

  it('哪几格看得见:手机上只有当前那一页;折叠屏上事项一直在左栏,在事项页时舞台也露着', () => {
    expect(paneShown('settings', 'settings', false)).toBe(true);
    expect(paneShown('stage', 'settings', false)).toBe(false);
    expect(paneShown('inbox', 'stage', false)).toBe(false);
    expect(paneShown('inbox', 'stage', true)).toBe(true);
    expect(paneShown('stage', 'inbox', true)).toBe(true);
    expect(paneShown('stage', 'settings', true)).toBe(false);
    expect(paneShown('news', 'stage', true)).toBe(false);
  });
});

describe('接到 React 这一侧', () => {
  function Layer({ name, open, seen }: { name: string; open: boolean; seen: string[] }) {
    useBackHandler(open, () => seen.push(name));
    return null;
  }

  it('开着才登记;所在那一格藏起来就撤下,再露出来又登记回来', () => {
    const stack = createBackStack();
    const seen: string[] = [];
    const view = render(
      <BackProvider stack={stack}>
        <BackScope active={true}><Layer name="设置里那一层" open={true} seen={seen} /></BackScope>
        <Layer name="关着的" open={false} seen={seen} />
      </BackProvider>,
    );
    expect(stack.size()).toBe(1);
    view.rerender(
      <BackProvider stack={stack}>
        <BackScope active={false}><Layer name="设置里那一层" open={true} seen={seen} /></BackScope>
        <Layer name="关着的" open={false} seen={seen} />
      </BackProvider>,
    );
    expect(stack.size()).toBe(0);
    expect(stack.dispatch()).toBe(false);
    view.unmount();
    expect(stack.size()).toBe(0);
  });

  it('按下去调的是最新那一个回调,而且不会因为重画就挪到「最后打开」', () => {
    const stack = createBackStack();
    const seen: string[] = [];
    function Counter() {
      const [n, setN] = useState(0);
      useBackHandler(true, () => seen.push(`第 ${n} 次画的`));
      return <button type="button" onClick={() => setN((v) => v + 1)}>加一</button>;
    }
    render(<BackProvider stack={stack}><Layer name="后开的" open={true} seen={seen} /><Counter /></BackProvider>);
    // Counter 后登记,盖在上面
    fireEvent.click(screen.getByRole('button', { name: '加一' }));
    act(() => { stack.dispatch(); });
    expect(seen).toEqual(['第 1 次画的']);
  });

  it('系统返回:有人接就交给它;谁都不接才退到后台', async () => {
    const stack = createBackStack();
    let press: (() => void) | undefined;
    const minimize = vi.fn(async () => {});
    const deps: SystemBackDeps = { listen: async (onBack) => { press = onBack; return { remove: () => { press = undefined; } }; }, minimize };
    function Root({ open }: { open: boolean }) {
      useSystemBack(stack, deps);
      return <Layer name="详情" open={open} seen={seen} />;
    }
    const seen: string[] = [];
    const view = render(<BackProvider stack={stack}><Root open={true} /></BackProvider>);
    await waitFor(() => expect(press).toBeDefined());
    act(() => { press!(); });
    expect(seen).toEqual(['详情']);
    expect(minimize).not.toHaveBeenCalled();
    view.rerender(<BackProvider stack={stack}><Root open={false} /></BackProvider>);
    act(() => { press!(); });
    expect(minimize).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(press).toBeUndefined();
  });
});

// ————————————————————————————————— 3. 整个 App —————————————————————————————————

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const STATE = {
  now: '2026-09-24T18:00:00+08:00',
  stale: false,
  sessions: [],
  tasks: { tasks: [{ id: 't-1', title: '写口播稿', status: 'doing', direction: 'mine', created_at: '2026-09-24T09:00:00Z', updated_at: '2026-09-24T09:30:00Z' }] },
  butler_inbox: { items: [] },
};

/** 已经配过对的一台手机。`onboarding: 'pending'` + `openOnboarding` = 引导页开着(配对成功那一刻写的那面旗子)。 */
async function mountApp(opts: { onboarding?: 'done' | 'pending'; openOnboarding?: boolean } = {}) {
  const kv = memory();
  kv.data.set('butler.pairing', JSON.stringify({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' }));
  const settings = memory();
  settings.data.set('butler.settings', JSON.stringify({ voiceEnabled: true, avatarId: null, onboarding: opts.onboarding ?? 'done', stage: 'particles', callProvider: 'livekit' }));
  if (opts.openOnboarding === true) sessionStorage.setItem('butler.onboardingOpen', '1');
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/state')) return jsonRes(200, STATE);
    if (url.endsWith('/call/log')) return jsonRes(200, { missed: 0, config: { enabled: true, done_call: true }, entries: [] });
    return jsonRes(503, { error: '没配' });
  });
  render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(settings)} fetchImpl={fetchImpl as unknown as typeof fetch} />);
  await waitFor(() => expect(system.listener, 'App 应该装好了系统返回键的监听').not.toBeNull(), { timeout: 3000 });
}

async function home(): Promise<void> {
  await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });
}

/** 模拟 Android 的系统返回(手势 / 返回键):Capacitor 的 backButton。 */
async function pressBack(): Promise<void> {
  await act(async () => { system.listener!(); });
}

function pane(name: 'stage' | 'inbox' | 'news' | 'settings'): HTMLElement {
  return document.querySelector<HTMLElement>(`.ba-pane--${name}`)!;
}

/** 此刻看得见的是不是首页(舞台那一格没藏、记录页没开)。 */
function onHome(): boolean {
  return !pane('stage').hidden && document.querySelector('.ba-scene__log') === null
    && (['inbox', 'news', 'settings'] as const).every((one) => pane(one).hidden);
}

async function openFromLog(entry: '事项' | '资讯' | '会议'): Promise<void> {
  await act(async () => { screen.getByRole('button', { name: '记录' }).click(); });
  await act(async () => { screen.getByRole('button', { name: entry }).click(); });
}

describe('App:底部标签栏拿掉了', () => {
  it('★首页、设置页上都没有那条「事务官 | 事项 | 资讯 | 设置」', async () => {
    await mountApp();
    await home();
    expect(document.querySelector('.ba-tabs')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(pane('settings').hidden).toBe(false);
    expect(document.querySelector('.ba-tabs')).toBeNull();
    expect(screen.queryByRole('button', { name: '事务官' })).toBeNull();
  });
});

describe('App:首页上按返回 = 退到后台', () => {
  it('★首页按返回:minimizeApp,人还在首页(不退出登录、不清状态)', async () => {
    await mountApp();
    await home();
    await pressBack();
    expect(system.minimize).toHaveBeenCalledTimes(1);
    expect(onHome()).toBe(true);
  });
});

describe('App:下一级页 —— 左上角「‹」与系统返回都回首页', () => {
  it('★设置:顶上「‹ 设置」;系统返回回首页,不退后台', async () => {
    await mountApp();
    await home();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const settings = pane('settings');
    expect(within(settings).getByRole('heading', { name: '设置' })).toBeTruthy();
    expect(within(settings).getByRole('button', { name: '返回' }).textContent).toBe('‹');
    await pressBack();
    expect(onHome()).toBe(true);
    expect(system.minimize).not.toHaveBeenCalled();
    // 再按一次才退到后台
    await pressBack();
    expect(system.minimize).toHaveBeenCalledTimes(1);
  });

  it('★设置:点左上角「‹」回首页', async () => {
    await mountApp();
    await home();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(within(pane('settings')).getByRole('button', { name: '返回' }));
    expect(onHome()).toBe(true);
  });

  it('★对话记录:整页、顶上「‹ 对话记录」;系统返回先收它,再按才退后台', async () => {
    await mountApp();
    await home();
    await act(async () => { screen.getByRole('button', { name: '记录' }).click(); });
    const log = document.querySelector<HTMLElement>('.ba-scene__log')!;
    expect(within(log).getByRole('heading', { name: '对话记录' })).toBeTruthy();
    await pressBack();
    expect(document.querySelector('.ba-scene__log')).toBeNull();
    expect(system.minimize).not.toHaveBeenCalled();
    await pressBack();
    expect(system.minimize).toHaveBeenCalledTimes(1);
  });

  it('★事项:从记录页进,顶上「‹ 事项」;系统返回回首页(不回记录页)', async () => {
    await mountApp();
    await home();
    await openFromLog('事项');
    expect(pane('inbox').hidden).toBe(false);
    expect(within(pane('inbox')).getByRole('heading', { name: '事项' })).toBeTruthy();
    await pressBack();
    expect(onHome()).toBe(true);
    expect(system.minimize).not.toHaveBeenCalled();
  });

  it('★事项:点开一条的详情时,系统返回先收详情,再按一次才回首页', async () => {
    await mountApp();
    await home();
    await openFromLog('事项');
    fireEvent.click(await within(pane('inbox')).findByRole('button', { name: /写口播稿/ }));
    expect(screen.getByRole('dialog', { name: '事项详情' })).toBeTruthy();
    await pressBack();
    expect(screen.queryByRole('dialog', { name: '事项详情' })).toBeNull();
    expect(pane('inbox').hidden).toBe(false);
    await pressBack();
    expect(onHome()).toBe(true);
  });

  /**
   * 2026-10-03 傍晚(方案 B):「今天要做」那张卡收成了球下那一排里的一颗图标,
   * 这一条改点**「正在办」整张卡**(它照旧在主列上、照旧去事项页)—— 钉的意图没变:
   * 首页卡片整张点下去进得了事项页,「‹」回首页。那颗图标的那一条在 tests/homeRail.test.tsx。
   */
  it('★事项:首页卡片整张点下去也进得来(2026-09-25 起整张卡就是那颗键),「‹」回首页', async () => {
    await mountApp();
    await home();
    await waitFor(() => expect(screen.getByRole('button', { name: '打开「正在办」' })).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: '打开「正在办」' }));
    expect(pane('inbox').hidden).toBe(false);
    fireEvent.click(within(pane('inbox')).getByRole('button', { name: '返回' }));
    expect(onHome()).toBe(true);
  });

  it('★资讯:从记录页进,顶上「‹ 资讯」;系统返回回首页', async () => {
    await mountApp();
    await home();
    await openFromLog('资讯');
    expect(pane('news').hidden).toBe(false);
    expect(within(pane('news')).getByRole('heading', { name: '资讯' })).toBeTruthy();
    await pressBack();
    expect(onHome()).toBe(true);
    expect(system.minimize).not.toHaveBeenCalled();
  });

  /*
   * 会议的第一条路(2026-10-04,卡「首页会议图标」):首页那一排上最后一颗。
   * 维护者:「再开张卡,把会议模式一样拿出来到右边的侧边栏上」—— 记录面板那条路要先拉开记录、
   * 再进对话记录页、再在顶上那排小链接里找,藏了三层。下面那一条(从记录面板进)照旧留着。
   */
  it('★会议:首页那一排上那颗点下去就是会议页;系统返回回首页', async () => {
    await mountApp();
    await home();
    await act(async () => { screen.getByRole('button', { name: '打开「会议」' }).click(); });
    const meeting = await waitFor(() => { const el = document.querySelector<HTMLElement>('.ba-meeting'); expect(el).toBeTruthy(); return el!; });
    expect(within(meeting).getByRole('heading', { name: '会议' })).toBeTruthy();
    await pressBack();
    expect(document.querySelector('.ba-meeting')).toBeNull();
    await home();
    expect(onHome()).toBe(true);
    expect(system.minimize).not.toHaveBeenCalled();
  });

  it('★会议(没在录):顶上「‹ 会议」;系统返回回首页', async () => {
    await mountApp();
    await home();
    await openFromLog('会议');
    const meeting = await waitFor(() => { const el = document.querySelector<HTMLElement>('.ba-meeting'); expect(el).toBeTruthy(); return el!; });
    expect(within(meeting).getByRole('heading', { name: '会议' })).toBeTruthy();
    expect(within(meeting).getByRole('button', { name: '返回' })).toBeTruthy();
    await pressBack();
    expect(document.querySelector('.ba-meeting')).toBeNull();
    await home();
    expect(onHome()).toBe(true);
    expect(system.minimize).not.toHaveBeenCalled();
  });
});

describe('App:引导打字页', () => {
  it('★系统返回 → 回首页;进度在工作台,首页横幅还在、能接着聊', async () => {
    // 这一份假后端没配通话,引导退回打字那一版(OnboardingCall 自己分流)。
    await mountApp({ onboarding: 'pending', openOnboarding: true });
    await waitFor(() => expect(document.querySelector('.ba-onboarding')).toBeTruthy(), { timeout: 3000 });
    await pressBack();
    await home();
    expect(document.querySelector('.ba-onboarding')).toBeNull();
    expect(system.minimize).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('butler.onboardingOpen')).toBeNull();
    // 横幅一句话,点它就接着聊
    const banner = screen.getByRole('region', { name: '引导' });
    fireEvent.click(within(banner).getAllByRole('button')[0]!);
    await waitFor(() => expect(document.querySelector('.ba-onboarding')).toBeTruthy(), { timeout: 3000 });
  });

  it('★从设置里「打开引导页」:返回落在首页,不落回设置', async () => {
    await mountApp();
    await home();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    // 2026-09-27(卡 SZ2):「引导」在「关于与更新」那一组里。
    fireEvent.click(within(pane('settings')).getByText('关于与更新'));
    fireEvent.click(within(pane('settings')).getByRole('button', { name: '打开引导页' }));
    await waitFor(() => expect(document.querySelector('.ba-onboarding')).toBeTruthy(), { timeout: 3000 });
    await pressBack();
    await home();
    expect(onHome()).toBe(true);
  });
});

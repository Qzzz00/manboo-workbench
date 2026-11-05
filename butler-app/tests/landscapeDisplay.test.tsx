/**
 * **横屏就是展示台**(2026-09-22,Ben 真机上「横屏展示台没了」之后拍的板)。
 *
 * 09-21「选题池」那张卡把横屏从 display-client 那个展示台 iframe 改成了同一个舞台页的横排,
 * 并把「要不要留一条路回去」写进交接等他点头。他点的是**回去**:
 * 转成横屏就回到 `display/DisplayPage.tsx`,竖屏那套「球 + 卡片」一个字不动。
 *
 * 这一份钉四件:
 *
 * 1. **横屏 + 舞台标签 = 展示台那个 iframe**,竖屏 = 舞台页;转屏当场换,不用重开 App。
 * 2. **横屏不是早退**。它现在是舞台那一格里的一个三目,于是来电页 / 已接通话 / 话筒那一通 /
 *    会议页 / 引导这些**整屏页**天然压得过它(座机页 2026-09-25 去掉了) —— 这一条最要紧的是会议:
 *    转屏把 MeetingPage 卸载掉,它那个 cleanup 会把录音停掉,一场会就这么没了。
 * 3. **别的标签横屏时照旧**:事项 / 资讯 / 设置不受横屏影响,而且展示台那个 iframe
 *    **压根不挂**(藏在别的页背后空转的是 Live2D + WebGL + 一条自己的 /live)。
 * 4. **没登录时横屏也是登录流程**,不是一块连不上的展示台。
 *
 * 用真 DOM 能验到的都用真 DOM。只有「来电三态」验不到 —— 那要一条真的房间通道
 * (`useIncoming` 吃的是 `session.channel`,而 `App` 不收注入的通道)。所以那三页改成
 * 钉**结构不变量**:App.tsx 里没有任何 `if (landscape) return …`。只要这条成立,
 * 任何写在它前面的整屏早退都压得过横屏 —— 靠的是结构,不是"谁排在谁前面"这种约定。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App } from '../src/App';
import { DISPLAY_AVATAR } from '../src/display/displayUrl';
import { DESKTOP_ONBOARDING_NOTE } from '../src/onboarding/OnboardingCall';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';
import { DISPLAY_STYLE_KEY, DisplayStyleProvider, createDisplayStyleStore, type DisplayStyleStore } from '../src/display/displayStyle';

vi.mock('@capacitor/app', () => ({
  App: { getLaunchUrl: async () => ({ url: '' }), addListener: async () => ({ remove: async () => {} }) },
}));
vi.mock('capacitor-zeroconf', () => ({ ZeroConf: { watch: async () => { throw new Error('web'); }, unwatch: async () => {}, close: async () => {} } }));

/**
 * App.tsx 的源码,**注释整个剥掉**再看 —— 注释里到处写着 `if (landscape)` 这几个字
 * (那正是这一版拿掉的东西,得写下来给下一个人看),不剥会被自己的注释判红。
 * 同 tests/missedLandscape.test.tsx 读 CSS 前那一下。
 */
const APP_SRC = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

const STATE = {
  now: '2026-09-22T10:00:00+08:00',
  stale: false,
  sessions: [],
  tasks: { tasks: [{ id: 't-1', title: '写口播稿', status: 'doing', direction: 'mine', created_at: 'a', updated_at: 'b' }] },
  butler_inbox: { items: [] },
};

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 已经配过对、引导做完的一台手机(同 stageLayout.test.tsx 那一份)。 */
function stores(opts: { onboarding?: 'done' | 'todo'; paired?: boolean } = {}) {
  const kv = memory();
  if (opts.paired !== false) kv.data.set('butler.pairing', JSON.stringify({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' }));
  const settings = memory();
  settings.data.set('butler.settings', JSON.stringify({
    voiceEnabled: true, avatarId: null, onboarding: opts.onboarding ?? 'done', stage: 'particles', callProvider: 'livekit',
  }));
  return { tokenStore: createTokenStore(kv), settingsStore: createSettingsStore(settings) };
}

/**
 * **能转的** matchMedia。
 *
 * 别处那一份(stageLayout / missedLandscape)是一次性的:装好方向再挂 App。
 * 这一份的监听是真的 —— `useLandscape` 挂上去的回调存下来,`rotate()` 改了值再叫它们一遍。
 * 「开着会转屏」这类事只有这样才验得到:会议页那个状态在 Shell 里,重挂就没了。
 */
let landscapeNow = false;
const listeners = new Set<() => void>();
function installMatchMedia(): void {
  landscapeNow = false;
  listeners.clear();
  window.matchMedia = ((query: string) => {
    const orientation = query.includes('landscape');
    return {
      get matches() { return orientation && landscapeNow; },
      media: query,
      onchange: null,
      addEventListener(_type: string, cb: () => void) { if (orientation) listeners.add(cb); },
      removeEventListener(_type: string, cb: () => void) { listeners.delete(cb); },
      addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    };
  }) as unknown as typeof window.matchMedia;
}
async function rotate(landscape: boolean): Promise<void> {
  landscapeNow = landscape;
  await act(async () => { [...listeners].forEach(cb => cb()); });
}

async function mountApp(opts: { landscape?: boolean; onboarding?: 'done' | 'todo'; paired?: boolean; style?: DisplayStyleStore } = {}) {
  installMatchMedia();
  landscapeNow = opts.landscape ?? false;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/state')) return jsonRes(200, STATE);
    if (url.endsWith('/call/log')) return jsonRes(200, { missed: 0, config: { enabled: true, done_call: true }, entries: [] });
    return jsonRes(503, { error: '没配' });
  });
  const app = <App {...stores(opts)} fetchImpl={fetchImpl as unknown as typeof fetch} />;
  render(opts.style === undefined ? app : <DisplayStyleProvider store={opts.style}>{app}</DisplayStyleProvider>);
  await act(async () => {});
  return fetchImpl;
}

/** 展示台那个 iframe(没有就是 null)。 */
function frame(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>('.ba-display__frame');
}

afterEach(() => {
  landscapeNow = false;
  listeners.clear();
  try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ }
});

describe('横屏 = 展示台,竖屏 = 球 + 卡片', () => {
  it('★横屏 + 舞台标签:渲染展示台,**不渲染舞台页**', async () => {
    await mountApp({ landscape: true });
    await waitFor(() => expect(frame()).toBeTruthy(), { timeout: 3000 });
    expect(document.querySelector('.ba-scene')).toBeNull();
    // 竖屏那套「球 + 卡片」在横屏下一个都不该在。
    expect(document.querySelector('.ba-cards')).toBeNull();
  });

  it('★展示台的地址:?feed=host,令牌不进地址栏(2026-09-30 起状态由手机壳递进去)', async () => {
    await mountApp({ landscape: true });
    await waitFor(() => expect(frame()).toBeTruthy(), { timeout: 3000 });
    const url = new URL(frame()!.getAttribute('src')!, 'http://localhost/');
    expect(url.pathname).toBe('/display/display.html');
    expect(url.searchParams.get('feed')).toBe('host');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('★展示台说「我好了」,手机壳当场把手上那份 /state 递进去(Agent 不再因为另连不上而全灰)', async () => {
    await mountApp({ landscape: true });
    await waitFor(() => expect(frame()).toBeTruthy(), { timeout: 3000 });
    const inner = frame()!.contentWindow!;
    const posted = vi.spyOn(inner, 'postMessage');
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'butler-display', kind: 'ready' }, source: inner, origin: window.location.origin }));
    });
    await waitFor(() => expect(posted).toHaveBeenCalled(), { timeout: 3000 });
    const snapshot = posted.mock.calls.map(c => c[0] as { kind?: string; state?: { tasks?: unknown } }).find(m => m.kind === 'snapshot');
    expect(snapshot?.state?.tasks).toEqual(STATE.tasks);
    expect(posted.mock.calls.some(c => (c[0] as { kind?: string }).kind === 'appearance')).toBe(true);
  });

  /** 展示台样式(2026-10-01):设置里选了「环绕」,横屏那个 iframe 的地址就带 layout=orbit;没选过 = 原来那套,不带。 */
  it('★展示台样式:选了「环绕」地址带 layout=orbit,缺省不带', async () => {
    const kv = memory();
    kv.data.set(DISPLAY_STYLE_KEY, 'orbit');
    await mountApp({ landscape: true, style: createDisplayStyleStore(kv) });
    await waitFor(() => expect(new URL(frame()!.getAttribute('src')!, 'http://localhost/').searchParams.get('layout')).toBe('orbit'), { timeout: 3000 });
  });

  /**
   * 形象位(2026-09-22 Ben 拍板):默认粒子球,所以地址里**不带** `?avatar=`;
   * 以后 Ben 给了 Live2D 模型,把 `DISPLAY_AVATAR` 填成形象 id,这条会要求地址带上它。
   * 一条用例同时钉住这两种情况,换回 Live2D 时不用改测试。
   */
  it('★形象位:DISPLAY_AVATAR 是空串(粒子球)就不带 ?avatar=,填了形象 id 就带上', async () => {
    await mountApp({ landscape: true });
    await waitFor(() => expect(frame()).toBeTruthy(), { timeout: 3000 });
    const url = new URL(frame()!.getAttribute('src')!, 'http://localhost/');
    if (DISPLAY_AVATAR === '') expect(url.searchParams.has('avatar')).toBe(false);
    else expect(url.searchParams.get('avatar')).toBe(DISPLAY_AVATAR);
  });

  it('★竖屏:还是舞台页(球 + 四块卡片),没有 iframe', async () => {
    await mountApp({ landscape: false });
    await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });
    expect(document.querySelector('.ba-scene__body .ba-cards')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('★转屏当场换,两个方向来回都对(不用重开 App)', async () => {
    await mountApp({ landscape: false });
    await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });

    await rotate(true);
    await waitFor(() => expect(frame()).toBeTruthy(), { timeout: 3000 });
    expect(document.querySelector('.ba-scene')).toBeNull();
    expect(document.querySelector('.ba-shell')?.getAttribute('data-landscape')).toBe('true');

    await rotate(false);
    await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });
    expect(frame()).toBeNull();
    expect(document.querySelector('.ba-shell')?.getAttribute('data-landscape')).toBe('false');
  });
});

describe('横屏只顶掉舞台那一格,别的页照旧', () => {
  it('★横屏时在事项页:事项页照常,**展示台连挂都不挂**', async () => {
    await mountApp({ landscape: false });
    await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });
    // 「事项」在对话记录那一页里(横屏下没有舞台页可点,所以先在竖屏切好再转屏)。
    await act(async () => { screen.getByRole('button', { name: '记录' }).click(); });
    await act(async () => { screen.getByRole('button', { name: '事项' }).click(); });
    await rotate(true);

    expect(document.querySelector('.ba-pane--inbox')?.hasAttribute('hidden')).toBe(false);
    // 舞台那一格是 hidden 的,而 `hidden` 挡不住里面的 iframe 继续加载 —— 所以那一支压根不挂。
    expect(document.querySelector('iframe')).toBeNull();
    // 2026-09-24 起没有标签栏了:左上角那颗「‹」还在,横屏下照样回得去。
    expect(screen.getByRole('button', { name: '返回' })).toBeTruthy();
    expect(document.querySelector('.ba-tabs')).toBeNull();
  });

  it('★从事项页按「‹」回首页,展示台这才挂上', async () => {
    await mountApp({ landscape: false });
    await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });
    await act(async () => { screen.getByRole('button', { name: '记录' }).click(); });
    await act(async () => { screen.getByRole('button', { name: '事项' }).click(); });
    await rotate(true);
    expect(frame()).toBeNull();

    await act(async () => { screen.getByRole('button', { name: '返回' }).click(); });
    await waitFor(() => expect(frame()).toBeTruthy(), { timeout: 3000 });
  });
});

describe('整屏页压得过横屏', () => {
  /**
   * 最要紧的那一条:**开着会转屏**。会议页被卸载时那个 cleanup 会把录音停掉,
   * 而屏幕上显示的是展示台、什么都不说 —— 一场会就这么没了。
   */
  it('★开着会转成横屏:会议页还在,展示台不许冒出来', async () => {
    await mountApp({ landscape: false });
    await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });
    // 会议在记录面板里:先拉开记录,再点「会议」。
    await act(async () => { screen.getByRole('button', { name: '记录' }).click(); });
    await act(async () => { screen.getByRole('button', { name: '会议' }).click(); });
    await waitFor(() => expect(document.querySelector('.ba-meeting')).toBeTruthy(), { timeout: 3000 });

    await rotate(true);
    expect(document.querySelector('.ba-meeting')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('★引导没做完:横屏进来也是引导,不是展示台', async () => {
    // 引导页开着这件事记在 sessionStorage 上(配对成功那一刻写的那面旗子,Shell 重挂也还在)。
    sessionStorage.setItem('butler.onboardingOpen', '1');
    await mountApp({ landscape: true, onboarding: 'todo' });
    // 这一份假后端没配通话,引导退回打字那一版(OnboardingCall 自己分流)。
    await waitFor(
      () => expect(screen.getByText(new RegExp(DESKTOP_ONBOARDING_NOTE))).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(document.querySelector('iframe')).toBeNull();
    // 壳那一层根本没挂(引导是整屏早退),于是也不存在"藏在后面的展示台"。
    expect(document.querySelector('.ba-shell')).toBeNull();
  });

  it('★没配对(还没登录):横屏也是登录流程,不是一块连不上的展示台', async () => {
    await mountApp({ landscape: true, paired: false });
    await waitFor(() => expect(document.querySelector('.ba-login')).toBeTruthy(), { timeout: 3000 });
    expect(document.querySelector('iframe')).toBeNull();
  });

  /**
   * 来电三态(`ringing` / `answered` / `handset`)验不到真 DOM:它们由 `useIncoming` 从
   * `session.channel` 上收,而 `App` 不收注入的通道。所以钉的是**结构**:
   * 横屏不是早退,于是写在它前面的整屏早退全都压得过它 —— 不靠"谁排在谁前面"这种约定。
   */
  it('★App.tsx 里没有 `if (landscape) return …` —— 横屏不是早退,任何整屏页都压得过它', () => {
    expect(APP_SRC).not.toMatch(/if\s*\(\s*landscape\s*\)/);
    expect(APP_SRC).not.toMatch(/landscape\s*&&\s*return/);
    // 横屏那个三目**长在舞台那一格里**:它后面才是 `<StagePage`,前面是那一格的 `<section`。
    const pane = APP_SRC.indexOf('ba-pane ba-pane--stage');
    // (2026-09-24 起那个状态叫 `page`,不再叫 `tab`:底部标签栏拿掉了,见卡 fix/phone-nav-back。)
    const ternary = APP_SRC.indexOf('landscape ? (page === \'stage\'');
    expect(pane).toBeGreaterThan(-1);
    expect(ternary).toBeGreaterThan(pane);
  });

  // 座机页那一个早退 2026-09-25 整个去掉了(卡 feat/first-look-orb-top:维护者「手机的不要这个座机页面,就显示首页」)。
  it('★来电 / 已接 / 话筒 / 会议 / 引导这五个早退,都排在壳的普通渲染之前;座机页那个早退没有了', () => {
    const shell = APP_SRC.indexOf('function Shell()');
    const body = APP_SRC.slice(shell);
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, `没找到:${needle}`).toBeGreaterThan(-1);
      return i;
    };
    const normal = at('<div className="ba-shell"');
    for (const needle of [
      "incoming.state.kind === 'ringing'",
      "incoming.state.kind === 'answered'",
      "incoming.state.kind === 'handset'",
      'if (meeting || meetingActive) return',
      'if (onboarding) return',
    ]) {
      expect(at(needle)).toBeLessThan(normal);
    }
    expect(APP_SRC).not.toMatch(/deskScreen|DeskPhonePage/);
  });

  /**
   * 来电压过会议页(2026-10-09,卡「会后真机走通」):来电三态照旧排在会议页前面(电话压得过一切),
   * 可会议页被卸下时**录音不能停** —— 录音挂在会话的会议控制器上;挂断后会议页靠控制器那一格回来。
   * 钉两头:会议页里没有「卸载就停录」的 cleanup;Shell 的会议早退认控制器 `active()`。
   */
  it('★电话一响录音不停:会议页没有卸载停录;挂断后靠控制器回到会议页', () => {
    const page = readFileSync(resolve(__dirname, '../src/meeting/MeetingPage.tsx'), 'utf8');
    expect(page).not.toMatch(/useEffect\(\(\) => \(\) => \{[^}]*stop\(\)/);
    expect(page).not.toContain('recordingRef');
    expect(APP_SRC).toContain('const meetingActive = useMeetingActive(session.meeting)');
  });
});

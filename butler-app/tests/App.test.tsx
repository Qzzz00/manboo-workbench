/**
 * 壳 + 登录(2026-09-17 Ben:「手机上也需要有登录」)。
 * 没有账号体系,登录 = 确认电脑端就绪 → 配对 → 引导:没配过进欢迎屏,配好了进引导或舞台,
 * 退出登录 / 401 回欢迎屏,电脑关机只是「不在线」,不掉登录。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react';
import { App, TOKEN_EXPIRED_NOTICE } from '../src/App';
import { SIGNED_OUT_NOTICE } from '../src/login/loginModel';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';

vi.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: async () => ({ url: '' }),
    addListener: async () => ({ remove: async () => {} }),
  },
}));
vi.mock('capacitor-zeroconf', () => ({ ZeroConf: { watch: async () => { throw new Error('web'); }, unwatch: async () => {}, close: async () => {} } }));

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const STATE = { now: 'x', stale: false, sessions: [], tasks: { tasks: [] }, butler_inbox: { items: [] } };

/** 已经登录过的一台手机。 */
function paired(): KeyValueStore & { data: Map<string, string> } {
  const kv = memory();
  kv.data.set('butler.pairing', JSON.stringify({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' }));
  return kv;
}

/** 引导已经做完(不然登录成功就进引导页)。 */
function onboarded(): KeyValueStore & { data: Map<string, string> } {
  const kv = memory();
  kv.data.set('butler.settings', JSON.stringify({ voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit' }));
  return kv;
}

afterEach(() => { try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ } });

describe('App 壳 · 登录', () => {
  it('没配过 → 欢迎屏(不是一上来就一张扫码页)', async () => {
    render(<App tokenStore={createTokenStore(memory())} settingsStore={createSettingsStore(memory())} />);
    expect(await screen.findByText('电脑端装好了吗?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '扫码登录' })).toBeNull();
  });

  it('地址栏 #workbench://pair?…&code= 直接去 claim;登录成功、引导没做完 → 进引导开场', async () => {
    window.location.hash = '#workbench://pair?host=10.0.0.9&port=8795&code=123456';
    const kv = memory();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/pair/claim')) return jsonRes(200, { ok: true, token: 'T', device_id: 'd1' });
      if (url.endsWith('/state')) return jsonRes(200, STATE);
      if (url.includes('/butler/proxy/')) return jsonRes(503, { error: '没配' });
      return jsonRes(404, {});
    });
    render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(memory())} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    // 设计-引导流程 v2:配对成功的那一刻事务官在手机上开口。
    await waitFor(() => expect(document.querySelector('.ba-onboarding')).toBeTruthy(), { timeout: 3000 });
    expect(JSON.parse(kv.data.get('butler.pairing')!)).toEqual({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' });
    window.location.hash = '';
  });

  it('已登录 + 引导做完 → 直接进舞台页(不变)', async () => {
    const kv = paired();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/state')) return jsonRes(200, STATE);
      return jsonRes(503, { error: '没配' });
    });
    render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(onboarded())} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    // 舞台上没有标签栏,认右上角的「记录」icon。
    expect(await screen.findByLabelText('记录', {}, { timeout: 3000 })).toBeTruthy();
    expect(document.querySelector('.ba-scene')).toBeTruthy();
    // 平时不显示对话记录:一个气泡都没有。
    expect(document.querySelector('.ba-msg')).toBeNull();
    // 底部就一个撑满的输入框(2026-09-24):通话键收在它右下角,按住说话是它左边那颗麦克风键。
    // 2026-10-03 傍晚(方案 B)球下那一排里也有一颗叫「最近一次通话」的图标,所以这里认输入框里那一颗
    //(`.ba-scene__dock` 里的那个),不再用 /通话/ 模糊找。
    expect(document.querySelector('.ba-scene__dock textarea')).toBeTruthy();
    expect(within(document.querySelector<HTMLElement>('.ba-scene__dock')!).getByLabelText(/通话/)).toBeTruthy();
    expect(screen.getByLabelText('按住说话')).toBeTruthy();
    expect(document.querySelector('.ba-scene__orb .ba-particles, .ba-scene__orb .ba-orb')).toBeTruthy();
    expect(document.querySelector('.ba-stage')).toBeNull();
  });

  it('令牌被撤销(401)→ 回欢迎屏,并给一句人话', async () => {
    const kv = paired();
    const fetchImpl = vi.fn(async () => jsonRes(401, { error: '需要设备令牌:先在工作台设置里配对' }));
    render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(onboarded())} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    expect(await screen.findByText(TOKEN_EXPIRED_NOTICE)).toBeTruthy();
    expect(screen.getByText('电脑端装好了吗?')).toBeTruthy();
    await act(async () => {});
    expect(kv.data.has('butler.pairing')).toBe(false);
  });

  it('电脑关机(连不上)→ 先说「正在连接电脑…」,连续连不上满 10 秒才说「电脑不在线」;不回欢迎屏、不清令牌', async () => {
    // 2026-09-30:维护者「一上来先显示电脑不在线,每次都以为坏了」—— 还在连的时候不许说不在线。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const kv = paired();
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(onboarded())} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    expect((await screen.findAllByText('正在连接电脑…', {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    expect(screen.queryByText('电脑不在线')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect((await screen.findAllByText('电脑不在线', {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    vi.useRealTimers();
    expect(screen.queryByText('电脑端装好了吗?')).toBeNull();
    expect(kv.data.has('butler.pairing')).toBe(true);
  });

  it('设置里「退出登录」→ 清掉本机令牌,回欢迎屏并说一句', async () => {
    const kv = paired();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/state')) return jsonRes(200, STATE);
      return jsonRes(503, { error: '没配' });
    });
    render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(onboarded())} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    fireEvent.click(await screen.findByLabelText('设置', {}, { timeout: 3000 }));
    // 2026-09-27(卡 SZ2):设置首屏只剩八行分组,「登录」在「我的电脑」那一组里;
    // 而拿不到电脑的名字时那一行**不再退回地址**(以前写的是「已登录:工作台 · 10.0.0.9」)。
    fireEvent.click(await screen.findByText('我的电脑'));
    expect(await screen.findByText('已登录:你的电脑')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确定退出' })); });
    expect(await screen.findByText('电脑端装好了吗?')).toBeTruthy();
    expect(screen.getByText(SIGNED_OUT_NOTICE)).toBeTruthy();
    expect(kv.data.has('butler.pairing')).toBe(false);
  });
});

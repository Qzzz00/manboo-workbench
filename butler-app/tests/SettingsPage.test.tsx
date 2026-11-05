import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { apkSizeText, OFFICIAL_SITE, SettingsPage } from '../src/settings/SettingsPage';
import { resetPhoneBuildStampCache } from '../src/update/buildStamp';
import { SessionContext, type Session } from '../src/session';
import { createLargeTextStore, LARGE_TEXT_ATTR, LARGE_TEXT_KEY, LargeTextProvider } from '../src/settings/largeText';
import { createSettingsStore } from '../src/settings/settingsStore';
import type { KeyValueStore } from '../src/api/tokenStore';
import type { FeedSnapshot } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { SETTINGS_TITLES } from '../src/settings/settingsNav';
import type { ApiClient } from '../src/api/client';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

// useSyncExternalStore 要求快照引用稳定,否则会无限刷新。
const APPEARANCE_LOADING = { status: 'loading' as const, preset: { kind: 'butler-swarm-v4' as const, version: 1 as const, settings: {}, svg: '', fill: false } };

function fakeSession(stateOver: Record<string, unknown> = {}): Session {
  const snap: FeedSnapshot = { state: { now: 'x', stale: false, sessions: [], tasks: { tasks: [] }, ...stateOver } as unknown as FeedSnapshot['state'], connected: true, error: undefined };
  return {
    pairing: { token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' },
    /**
     * 2026-09-21:这一页上多了「资讯偏好」(feed/NewsSettings.tsx),它一挂上就 GET /feed。
     * 所以这份假 client 不能再是空对象 —— 回一个 404「资讯未启用」,那一节就如实说
     * 「这台工作台还没接资讯」,这一页别的断言一条不受影响。
     */
    client: fakeRouted({
      baseUrl: 'http://10.0.0.9:8795',
      json: async () => ({ ok: false, status: 404, kind: 'http', error: '资讯未启用' }),
      blob: async () => ({ ok: false, status: 404, kind: 'http', error: '资讯未启用' }),
    } as unknown as ApiClient),
    direct: {} as ApiClient,
    channel: fakeChannel(),
    feed: { get: () => snap, subscribe: () => () => {}, refresh: async () => {}, stop() {} },
    voice: {} as Session['voice'],
    call: {} as Session['call'],
    // 外观(2026-09-16):设置页会读它;这里给一份「还没拉到」的。
    appearance: { get: () => APPEARANCE_LOADING, subscribe: () => () => {}, refresh: async () => {}, notice() {} },
    settings: createSettingsStore(memory()),
    unpair: async () => {},
  };
}

describe('设置页 · 大字', () => {
  it('有「大字」开关,默认关;打开后 <html> 立刻带 data-ba-text 并落盘', async () => {
    document.documentElement.removeAttribute(LARGE_TEXT_ATTR);
    const kv = memory();
    render(
      <LargeTextProvider store={createLargeTextStore(kv)}>
        <SessionContext.Provider value={fakeSession()}><SettingsPage avatars={[]} /></SessionContext.Provider>
      </LargeTextProvider>,
    );
    await act(async () => {});
    // 2026-09-27(卡 SZ2):设置首屏只剩八行分组,「大字」在「声音与形象」那一组里。
    await act(async () => { fireEvent.click(screen.getByText(SETTINGS_TITLES.voiceLook)); });
    const box = screen.getByLabelText('大字') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText('显示')).toBeTruthy();
    await act(async () => { fireEvent.click(box); });
    expect(box.checked).toBe(true);
    expect(document.documentElement.getAttribute(LARGE_TEXT_ATTR)).toBe('large');
    expect(kv.data.get(LARGE_TEXT_KEY)).toBe('1');
    document.documentElement.removeAttribute(LARGE_TEXT_ATTR);
  });
});

/**
 * 手机包那一节(2026-09-18 热更新 → 2026-09-28 卡 UP 并成一节 → **2026-10-03 改成应用内更新**)。
 *
 * 09-28 定的「一节、一个动作、屏上不出现 apk 直链」没改;换的是那个动作:
 * 从「打开官网」变成「下载并安装」(整块在 update/PhoneUpdateSection.tsx,那一份用例更细)。
 * 这里只钉**接到这一页上**之后的样子:在哪一组里、一节还是两节、官网还在不在。
 */
const SHA = 'a'.repeat(64);
const APK = { version: '0.4.91', url: 'https://api.aibooo.cn/updates/0.4.91/app.apk', size: 33_554_432, sha256: SHA };

/**
 * build.json 在不在,决定「本机是哪一版」答得出答不出。
 * jsdom 里没有原生桥(`ApkUpdate.info()` 一律抛),所以这一页上那个版本号只能从它来。
 */
function stubBuildStamp(version: string | null) {
  resetPhoneBuildStampCache();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (`${String(input)}`.includes('build.json')) {
      return version === null
        ? new Response('', { status: 404 })
        : new Response(JSON.stringify({ butler_app_tree: 'c'.repeat(40), built_at: '2026-10-03T06:08:50.842Z', dirty: false, version, version_code: 1 }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; resetPhoneBuildStampCache(); };
}

describe('设置页 · 顶上那一行(这个包是哪一版)', () => {
  it('★读 build.json:版本 + 构建于什么时候', async () => {
    const restore = stubBuildStamp('0.4.91');
    render(
      <LargeTextProvider store={createLargeTextStore(memory())}>
        <SessionContext.Provider value={fakeSession()}><SettingsPage avatars={[]} /></SessionContext.Provider>
      </LargeTextProvider>,
    );
    await act(async () => {});
    expect(screen.getByText(/^版本 0\.4\.91 · 构建于 /)).toBeTruthy();
    restore();
  });

  it('读不到 build.json(浏览器里、10-03 之前打的老包):整行不出现,不编一个版本号', async () => {
    const restore = stubBuildStamp(null);
    render(
      <LargeTextProvider store={createLargeTextStore(memory())}>
        <SessionContext.Provider value={fakeSession()}><SettingsPage avatars={[]} /></SessionContext.Provider>
      </LargeTextProvider>,
    );
    await act(async () => {});
    expect(screen.queryByText(/^版本 /)).toBeNull();
    restore();
  });
});

describe('设置页 · 手机包(一节一个动作,动作是在 App 里更新)', () => {
  let restore = () => undefined as void;
  beforeEach(() => { restore = stubBuildStamp('0.4.90'); });
  afterEach(() => { restore(); });

  /** 2026-09-27(卡 SZ2):手机包那一节在「关于与更新」那一组里,先进那一组。 */
  function renderWith(stateOver: Record<string, unknown>) {
    render(
      <LargeTextProvider store={createLargeTextStore(memory())}>
        <SessionContext.Provider value={fakeSession(stateOver)}><SettingsPage avatars={[]} /></SessionContext.Provider>
      </LargeTextProvider>,
    );
  }

  async function openAbout() {
    await act(async () => { fireEvent.click(screen.getByText(SETTINGS_TITLES.about)); });
  }

  it('电脑还没查过(这一格缺席)时整节不出现 —— 不编一个"已经是最新"出来', async () => {
    renderWith({});
    await act(async () => {});
    await openAbout();
    expect(screen.queryByText('手机端有新版')).toBeNull();
    expect(screen.queryByText('手机包')).toBeNull();
    // 那一节不出现时,官网那行小字也不该单独挂在这一页上。
    expect(document.body.textContent).not.toContain(OFFICIAL_SITE);
  });

  it('★有新包:版本、大小,和一个动作 —— 在 App 里下载并安装(不是跳官网,也没有 apk 直链)', async () => {
    renderWith({ phone_apk: APK });
    await act(async () => {});
    await openAbout();
    expect(screen.getByText('手机端有新版')).toBeTruthy();
    expect(document.body.textContent).toContain('0.4.91');
    expect(document.body.textContent).toContain('32.0 MB');
    expect(screen.getByRole('button', { name: /下载并安装/ })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('.apk');
    // 09-28 那颗「打开官网」的键没了,官网降成一行小字里的链接。
    expect(screen.queryByText(`打开 ${OFFICIAL_SITE}`)).toBeNull();
    const link = screen.getByText(OFFICIAL_SITE) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`https://${OFFICIAL_SITE}`);
  });

  it('两格都在时也只出一节、一条官网链接 —— 一屏不摆两条一样的', async () => {
    renderWith({ update_available_apk: { version: APK.version, url: APK.url, size: APK.size }, phone_apk: APK });
    await act(async () => {});
    await openAbout();
    expect(screen.getAllByText('手机端有新版')).toHaveLength(1);
    expect(screen.getAllByText(OFFICIAL_SITE)).toHaveLength(1);
  });
});

describe('apkSizeText', () => {
  it('MB 与 KB 两档,给人看的', () => {
    expect(apkSizeText(33_554_432)).toBe('32.0 MB');
    expect(apkSizeText(5_000)).toBe('5 KB');
  });
});

/**
 * 设置页的分组与子页(2026-09-27,卡 SZ2;梳理见 docs/梳理-0927-手机设置页.md)。
 *
 * 维护者原话:「手机上的现在设置页面的逻辑非常混乱……我自己用都用不利索了」。
 * 这一份盯住四件(梳理第五节的 A–D):
 *   A 首屏只剩八行分组,点一行进子页;
 *   B 地址、端口、设备号、房间、服务器地址**不上屏** —— 只在「高级」里;
 *   C 屏上不出现 `**` 与反引号;
 *   D 「添加座机」「给座机换网络」是**真的独立子页**:有「‹ 返回」,系统返回键接得住
 *     (以前按返回直接弹回首页,六步白走)。
 */
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SettingsPage } from '../src/settings/SettingsPage';
import { SETTINGS_GROUPS, SETTINGS_TITLES } from '../src/settings/settingsNav';
import { SessionContext, type Session } from '../src/session';
import { createLargeTextStore, LargeTextProvider } from '../src/settings/largeText';
import { createSettingsStore } from '../src/settings/settingsStore';
import { BackProvider, useBackHandler } from '../src/nav/back';
import { BACK_PAGE, createBackStack } from '../src/nav/backStack';
import type { KeyValueStore } from '../src/api/tokenStore';
import type { FeedSnapshot } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import type { ApiClient } from '../src/api/client';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

const APPEARANCE_LOADING = { status: 'loading' as const, preset: { kind: 'butler-swarm-v4' as const, version: 1 as const, settings: {}, svg: '', fill: false } };

/** 假工作台:这一页上所有请求都回 404(资讯没接、主动来电没接),别的断言一条不受影响。 */
function fakeSession(stateOver: Record<string, unknown> = {}): Session {
  const snap: FeedSnapshot = { state: { now: 'x', stale: false, sessions: [], tasks: { tasks: [] }, ...stateOver } as unknown as FeedSnapshot['state'], connected: true, error: undefined };
  return {
    pairing: { token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'aeb88b97-dead-beef' },
    client: fakeRouted({
      baseUrl: 'http://10.0.0.9:8795',
      json: async () => ({ ok: false, status: 404, kind: 'http', error: '没接' }),
      blob: async () => ({ ok: false, status: 404, kind: 'http', error: '没接' }),
    } as unknown as ApiClient),
    direct: {} as ApiClient,
    channel: fakeChannel(),
    feed: { get: () => snap, subscribe: () => () => {}, refresh: async () => {}, stop() {} },
    voice: {} as Session['voice'],
    call: {} as Session['call'],
    appearance: { get: () => APPEARANCE_LOADING, subscribe: () => () => {}, refresh: async () => {}, notice() {} },
    settings: createSettingsStore(memory()),
    unpair: async () => {},
  };
}

/** 壳那一层:返回落到它身上就算「弹回首页」了 —— 用例靠 `home` 有没有被加过来判。 */
function Shell({ onHome, children }: { onHome: () => void; children: ReactNode }) {
  useBackHandler(true, onHome, BACK_PAGE);
  return <>{children}</>;
}

function mount(stateOver: Record<string, unknown> = {}) {
  const stack = createBackStack();
  const homes: number[] = [];
  render(
    <LargeTextProvider store={createLargeTextStore(memory())}>
      <SessionContext.Provider value={fakeSession(stateOver)}>
        <BackProvider stack={stack}>
          <Shell onHome={() => homes.push(1)}>
            <SettingsPage avatars={[]} onBack={() => homes.push(1)} />
          </Shell>
        </BackProvider>
      </SessionContext.Provider>
    </LargeTextProvider>,
  );
  return { stack, homes, systemBack: () => act(() => { stack.dispatch(); }) };
}

/** 点首屏上那一行分组。 */
async function open(name: string) {
  await act(async () => { fireEvent.click(screen.getByText(name)); });
}

describe('设置页 · 首屏是八行分组(A)', () => {
  it('首屏只有八组的名字,以前那些节标题一个都不在首屏上', async () => {
    mount();
    await act(async () => {});
    for (const group of SETTINGS_GROUPS) expect(screen.getByText(SETTINGS_TITLES[group.key])).toBeTruthy();
    expect(SETTINGS_GROUPS.length).toBe(8);
    // 这几节以前一上来就露着,现在都在子页里。
    for (const gone of ['登录', '语音', '外观', '显示', '引导', '远程通道', '通话']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it('点一行进子页:顶上写的是那一组的名字,里面是原来那一节的内容;返回回到八行', async () => {
    mount();
    await act(async () => {});
    await open(SETTINGS_TITLES.voiceLook);
    expect(screen.getByText('语音')).toBeTruthy();
    expect(screen.getByLabelText('大字')).toBeTruthy();
    // 「‹ 返回」回到分组列表,不回首页。
    await act(async () => { fireEvent.click(screen.getByLabelText('返回')); });
    expect(screen.getByText(SETTINGS_TITLES.about)).toBeTruthy();
    expect(screen.queryByLabelText('大字')).toBeNull();
  });

  it('系统返回键在子页里接得住:回八行,不弹回首页', async () => {
    const m = mount();
    await act(async () => {});
    await open(SETTINGS_TITLES.voiceLook);
    m.systemBack();
    expect(m.homes.length).toBe(0);
    expect(screen.getByText(SETTINGS_TITLES.about)).toBeTruthy();
    // 再按一下才回首页(首屏这一层归壳管)。
    m.systemBack();
    expect(m.homes.length).toBe(1);
  });
});

describe('设置页 · 内部的东西不上屏(B)', () => {
  it('地址、端口、设备号、房间、服务器地址只在「高级」里出现', async () => {
    mount();
    await act(async () => {});
    const body = () => document.body.textContent ?? '';
    expect(body()).not.toContain('10.0.0.9');
    expect(body()).not.toContain('aeb88b97');
    await open(SETTINGS_TITLES.computer);
    expect(body()).not.toContain('10.0.0.9');
    expect(body()).not.toContain('aeb88b97');
    expect(body()).not.toContain('8795');
    await act(async () => { fireEvent.click(screen.getByLabelText('返回')); });
    await open(SETTINGS_TITLES.advanced);
    expect(body()).toContain('10.0.0.9');
    expect(body()).toContain('aeb88b97');
  });
});

describe('设置页 · 屏上不出现 ** 与反引号(C)', () => {
  it('八组走一遍,一处都没有', async () => {
    mount({ update_available_apk: { version: '0.4.22', url: 'https://x/a.apk', size: 33_554_432 } });
    await act(async () => {});
    const clean = () => {
      const text = document.body.textContent ?? '';
      expect(text).not.toContain('**');
      expect(text).not.toContain('`');
    };
    clean();
    for (const group of SETTINGS_GROUPS) {
      await open(SETTINGS_TITLES[group.key]);
      clean();
      await act(async () => { fireEvent.click(screen.getByLabelText('返回')); });
    }
  });
});

describe('设置页 · 两条配座机的流程是真的独立子页(D)', () => {
  it('「添加座机」进的是自己那一页:顶上写「添加座机」、有返回;系统返回回到「座机」,不弹回首页', async () => {
    const m = mount();
    await act(async () => {});
    await open(SETTINGS_TITLES.handset);
    await open('添加座机(实体话筒)');
    expect(screen.getByText('第 1 步,共 6 步')).toBeTruthy();
    // 顶上那一条写的是它自己的名字,不再是「设置」。
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SETTINGS_TITLES.addHandset);
    expect(screen.getByLabelText('返回')).toBeTruthy();
    m.systemBack();
    expect(m.homes.length).toBe(0);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SETTINGS_TITLES.handset);
  });

  it('「给座机换网络」同样是一整页', async () => {
    const m = mount();
    await act(async () => {});
    await open(SETTINGS_TITLES.handset);
    await open('给座机换网络');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SETTINGS_TITLES.switchNetwork);
    m.systemBack();
    expect(m.homes.length).toBe(0);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SETTINGS_TITLES.handset);
  });
});

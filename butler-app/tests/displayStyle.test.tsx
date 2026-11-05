/**
 * 展示台样式(2026-10-01,维护者:「在设置里面新增一个展示台样式的选项,一个是现在这个,另一个是 Codex 新做的那个,
 * 选中哪个,横屏就显示哪个」)。
 *
 * 这是**这台手机的显示偏好**:存在手机本地(同「大字」,单独一个键),不经 8791、不改接缝。
 * 钉四件:缺省是现在这套;选了就进展示台地址;切换当场生效、重开还记得;设置里看得见、点得动。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  DISPLAY_STYLE_KEY, DISPLAY_STYLES, DisplayStyleProvider, createDisplayStyleStore, useDisplayStyle,
} from '../src/display/displayStyle';
import { displayUrl, iconsMessage, HOST_MESSAGE_TYPE } from '../src/display/displayUrl';
import { SettingsPage } from '../src/settings/SettingsPage';
import { SETTINGS_TITLES } from '../src/settings/settingsNav';
import { SessionContext, type Session } from '../src/session';
import { createSettingsStore } from '../src/settings/settingsStore';
import type { KeyValueStore } from '../src/api/tokenStore';
import type { ApiClient } from '../src/api/client';
import type { FeedSnapshot } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

const APPEARANCE_LOADING = { status: 'loading' as const, preset: { kind: 'butler-swarm-v4' as const, version: 1 as const, settings: {}, svg: '', fill: false } };

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

describe('存取', () => {
  it('缺省 = 现在这套;存 orbit 读回 orbit;坏值、读不了都当现在这套', async () => {
    const kv = memory();
    const store = createDisplayStyleStore(kv);
    expect(await store.load()).toBe('classic');
    await store.save('orbit');
    expect(kv.data.get(DISPLAY_STYLE_KEY)).toBe('orbit');
    expect(await store.load()).toBe('orbit');
    kv.data.set(DISPLAY_STYLE_KEY, 'neon');
    expect(await store.load()).toBe('classic');
    const broken: KeyValueStore = { async get() { throw new Error('x'); }, async set() { throw new Error('x'); }, async remove() {} };
    expect(await createDisplayStyleStore(broken).load()).toBe('classic');
    await expect(createDisplayStyleStore(broken).save('orbit')).resolves.toBeUndefined();
  });

  it('两套,现在这套排第一', () => {
    expect(DISPLAY_STYLES.map((s) => s.key)).toEqual(['classic', 'orbit']);
  });
});

describe('★进展示台地址', () => {
  it('新的这套带 layout=orbit;现在这套不带(与改之前一字不差)', () => {
    expect(new URL(displayUrl(undefined, 'orbit'), 'http://localhost/').searchParams.get('layout')).toBe('orbit');
    expect(displayUrl(undefined, 'classic')).toBe(displayUrl());
    expect(new URL(displayUrl(), 'http://localhost/').searchParams.has('layout')).toBe(false);
  });
});

describe('各家 logo 递进展示台', () => {
  it('只递手上已经有的那几张(data:image),没有的不递', () => {
    expect(iconsMessage({ claude: 'data:image/png;base64,AA', kimi: undefined })).toEqual({ type: HOST_MESSAGE_TYPE, kind: 'icons', icons: { claude: 'data:image/png;base64,AA' } });
  });
});

function Probe() {
  const { style, set } = useDisplayStyle();
  return <button type="button" onClick={() => { void set(style === 'orbit' ? 'classic' : 'orbit'); }}>样式:{style}</button>;
}

describe('Provider', () => {
  it('启动读盘;切换当场生效并落盘;重开还记得', async () => {
    const kv = memory();
    const first = render(<DisplayStyleProvider store={createDisplayStyleStore(kv)}><Probe /></DisplayStyleProvider>);
    await act(async () => {});
    expect(screen.getByText('样式:classic')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('样式:classic')); });
    expect(screen.getByText('样式:orbit')).toBeTruthy();
    expect(kv.data.get(DISPLAY_STYLE_KEY)).toBe('orbit');
    first.unmount();
    render(<DisplayStyleProvider store={createDisplayStyleStore(kv)}><Probe /></DisplayStyleProvider>);
    await act(async () => {});
    expect(screen.getByText('样式:orbit')).toBeTruthy();
  });
});

function fakeSession(): Session {
  const snap = { state: { now: 'n', stale: false, sessions: [] }, connected: true } as unknown as FeedSnapshot;
  return {
    client: fakeRouted({
      baseUrl: 'http://10.0.0.9:8795',
      json: async () => ({ ok: false, status: 404, kind: 'http', error: '未启用' }),
      blob: async () => ({ ok: false, status: 404, kind: 'http', error: '未启用' }),
    } as unknown as ApiClient),
    direct: {} as ApiClient,
    channel: fakeChannel(),
    feed: { get: () => snap, subscribe: () => () => {}, refresh: async () => {}, stop() {} },
    voice: {} as Session['voice'],
    call: {} as Session['call'],
    appearance: { get: () => APPEARANCE_LOADING, subscribe: () => () => {}, refresh: async () => {}, notice() {} },
    settings: createSettingsStore(memory()),
    unpair: async () => {},
  } as unknown as Session;
}

describe('设置 › 声音与形象 › 展示台样式', () => {
  it('★二选一,缺省选中现在这套;点新的那套当场选中并落盘', async () => {
    const kv = memory();
    render(
      <DisplayStyleProvider store={createDisplayStyleStore(kv)}>
        <SessionContext.Provider value={fakeSession()}><SettingsPage avatars={[]} /></SessionContext.Provider>
      </DisplayStyleProvider>,
    );
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByText(SETTINGS_TITLES.voiceLook)); });
    expect(screen.getByText('横屏展示台样式')).toBeTruthy();
    const [classic, orbit] = DISPLAY_STYLES.map((s) => screen.getByLabelText(s.label) as HTMLInputElement);
    expect(classic!.checked).toBe(true);
    expect(orbit!.checked).toBe(false);
    await act(async () => { fireEvent.click(orbit!); });
    expect(orbit!.checked).toBe(true);
    expect(classic!.checked).toBe(false);
    expect(kv.data.get(DISPLAY_STYLE_KEY)).toBe('orbit');
  });
});

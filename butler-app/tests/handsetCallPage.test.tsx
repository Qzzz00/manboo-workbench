/**
 * **座机提机进的是同一张通话页**(2026-09-28)。维护者原话:
 * 「打电话的页面是统一的,但是我发现座机拿起来的通话页面和我正常从首页打出去的那套 UI 不一样,
 * 因为座机……根本没有粒子球。」更正:「准确的说,只有座机打出去的页面不是同一套。」
 *
 * 在这之前座机那一路进的是另一张页(`call/HandsetCallPage.tsx`):自己排版、自己一颗轻的声纹球、
 * 自己一颗挂断键。这一份钉的就是「**只有一张通话页**」:
 *
 *   1. 座机提机 → 渲染的是舞台页的通话态(`.ba-scene[data-call="true"]`),球那一格里有球;
 *   2. 球是**主界面那一颗**(`ParticleStage`;jsdom 画不了 canvas 会退回声纹球,所以这里同时
 *      钉「用的组件就是 ParticleStage」这条源码约定,见最后一条);
 *   3. 底部是同一条 dock、同一组键(挂断 + 字幕),字幕点开才有 —— 和首页打出去那一通一样;
 *   4. **唯一的形态差异**:没有麦克风键,并明写声音在哪一台机器上、这台是哑的;
 *   5. **一路麦克风、一次进房都没有**:`useCall` 根本不激活(传进去的假通话客户端一次都没被要过)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StagePage } from '../src/stage/StagePage';
import {
  HANDSET_BANNER,
  HANDSET_CALL_STATUS,
  HANDSET_CALL_STATUS_OTHER_PHONE,
  HANDSET_BANNER_OTHER_PHONE,
  HANDSET_MUTED_TEXT,
  handsetStatusText,
} from '../src/call/handsetCall';
import type { IncomingCall } from '../src/call/incomingModel';
import { SessionContext, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import type { WbchCaption } from '../src/channel/channelProtocol';
import type { KeyValueStore } from '../src/api/tokenStore';
import type { CallClient } from '../src/call/rtcCall';
import { fakeChannel, fakeRouted } from './wbchFakes';

afterEach(() => { cleanup(); try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ } });

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function fakeFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: { ...emptyState(), now: '2026-09-28T14:03:00+08:00' } as WorkbenchState, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

const CALL: IncomingCall = { call_id: 'c1', reason: 'confirm', item_id: 't1', title: '把首页文案改一版', at: '', until: 0 };

interface MountOptions {
  call?: IncomingCall;
  by?: 'handset' | 'phone';
  since?: number;
}

function mount(options: MountOptions = {}) {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async () => new Response(JSON.stringify({ configured: true, checked: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  /** 字幕:用例自己往里推(工人广播的那条 `wb.rpc` 的 `{type:'caption'}`)。 */
  const captions = new Set<(caption: WbchCaption) => void>();
  const channel = fakeChannel({
    onCaption: (listener) => { captions.add(listener); return () => captions.delete(listener); },
  });
  /** 这一路**一次都不该被要**:座机形态里说话的是话筒,不是这台手机。 */
  const createCallClient = vi.fn((): CallClient => { throw new Error('座机那一路不许进房'); });
  const onHangup = vi.fn();
  const session: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel,
    appearance: createAppearanceFeed(client),
    settings: createSettingsStore(memory()),
    unpair: async () => {},
  };
  const view = render(
    <SettingsContext.Provider value={{ settings: { ...DEFAULT_SETTINGS, stage: 'particles' }, update: async () => {} }}>
      <SessionContext.Provider value={session}>
        <StagePage
          callTickMs={10}
          createCallClient={createCallClient}
          handset={{
            ...(options.call === undefined ? {} : { call: options.call }),
            ...(options.by === undefined ? {} : { by: options.by }),
            ...(options.since === undefined ? {} : { since: options.since }),
            onHangup,
          }}
        />
      </SessionContext.Provider>
    </SettingsContext.Provider>,
  );
  const push = (caption: Omit<WbchCaption, 'type'>) => {
    act(() => { for (const l of [...captions]) l({ type: 'caption', ...caption }); });
  };
  return { view, onHangup, push, createCallClient, channel };
}

describe('座机提机:同一张通话页', () => {
  it('★ 渲染的是舞台页的通话态,球在正中 —— 不是另一套页面', async () => {
    mount({ call: CALL, by: 'handset', since: Date.parse('2026-09-28T14:03:00+08:00') });
    await act(async () => {});
    const scene = document.querySelector('.ba-scene')!;
    expect(scene).toBeTruthy();
    expect(scene.getAttribute('data-call')).toBe('true');
    expect(scene.getAttribute('data-handset')).toBe('true');
    // 球那一格里有球(jsdom 画不了 canvas,粒子自己退回声纹球;两者都算球)。
    expect(document.querySelector('.ba-scene__orb .ba-particles, .ba-scene__orb .ba-orb')).toBeTruthy();
    // 那张旧页**整个没了**:没有 .ba-handset 这一套。
    expect(document.querySelector('.ba-handset')).toBeNull();
  });

  it('★ 球用的就是主界面那颗粒子球(ParticleStage),不是另画一颗轻的', () => {
    // jsdom 里粒子核心起不来会退回声纹球,所以这一条钉的是**源码里的那条约定**:
    // 通话页那一格挂的是 ParticleStage;座机那一路走的就是这一格(上一条已钉)。
    const page = readFileSync(resolve(__dirname, '../src/stage/StagePage.tsx'), 'utf8');
    const orbAt = page.indexOf('ba-scene__orb');
    expect(orbAt).toBeGreaterThan(-1);
    expect(page.slice(orbAt, orbAt + 800)).toContain('<ParticleStage');
  });

  it('★ 底部是同一条 dock、同一组键:挂断 + 字幕,**没有麦克风键**', async () => {
    const h = mount({ call: CALL, by: 'handset' });
    await act(async () => {});
    const dock = document.querySelector('.ba-call__dock')!;
    expect(dock).toBeTruthy();
    const keys = [...dock.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(keys).toEqual(['挂断', '显示字幕']);
    // 挂断按得动,而且只报一次(连点不许打两遍)。
    fireEvent.click(within(dock as HTMLElement).getByRole('button', { name: '挂断' }));
    fireEvent.click(within(dock as HTMLElement).getByRole('button', { name: '挂断' }));
    expect(h.onHangup).toHaveBeenCalledOnce();
  });

  it('★ 和手机打出去那一页一样只写「通话中」:不再摆「话筒接起来了」「这台手机不出声」「从几点起」那几句(维护者 09-28 19:1x「页面上那些乱七八糟的提示语」);事项那一行照旧', async () => {
    mount({ call: CALL, by: 'handset', since: 1_700_000_000_000 });
    await act(async () => {});
    expect(screen.queryByText(HANDSET_BANNER)).toBeNull();
    expect(screen.queryByText(HANDSET_MUTED_TEXT)).toBeNull();
    expect(screen.queryByText(handsetStatusText('handset', 1_700_000_000_000))).toBeNull();
    expect(screen.getByText(HANDSET_CALL_STATUS)).toBeTruthy();
    expect(document.querySelector('.ba-call__banner')).toBeNull();
    expect(screen.getByText('等你确认 · 把首页文案改一版')).toBeTruthy();
  });

  it('房里另一台设备接的:那一行改口,不说「话筒」', async () => {
    mount({ call: CALL, by: 'phone' });
    await act(async () => {});
    expect(screen.getByText(HANDSET_CALL_STATUS_OTHER_PHONE)).toBeTruthy();
    expect(screen.queryByText(HANDSET_BANNER_OTHER_PHONE)).toBeNull();
  });

  it('他自己提机拨出去的那一通没有事项:照画这一页,只是少那一行(不编一个事项)', async () => {
    mount({ by: 'handset' });
    await act(async () => {});
    expect(screen.getByText(HANDSET_CALL_STATUS)).toBeTruthy();
    expect(document.querySelector('.ba-call__note')).toBeNull();
  });

  it('★ 字幕走同一颗键、同一个面板:点开才有,工人推的那一句就在里面', async () => {
    const h = mount({ call: CALL, by: 'handset' });
    await act(async () => {});
    h.push({ role: 'butler', text: '这一版改完了,要不要发?', final: true });
    // 点开之前屏幕上没有这一句(和首页那一通同一条规矩)。
    expect(screen.queryByText(/这一版改完了/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '显示字幕' }));
    expect(screen.getByText(/这一版改完了,要不要发\?/)).toBeTruthy();
    // 说到一半那句也照画,带省略号、淡一点。
    h.push({ role: 'me', text: '先别发', final: false });
    expect(document.querySelector('.ba-call__subtitle[data-interim="true"]')).toBeTruthy();
  });

  it('★ 一路麦克风、一次进房都没有:useCall 根本不激活', async () => {
    const h = mount({ call: CALL, by: 'handset' });
    await act(async () => {});
    expect(h.createCallClient).not.toHaveBeenCalled();
  });

  it('★ 话筒那一通,这台手机的喇叭是关的:进页就 setSpeakerEnabled(false),一次都不开(2026-10-13 晚真机:提起话筒手机也出声)', async () => {
    const h = mount({ call: CALL, by: 'handset' });
    await act(async () => {});
    const log = (h.channel.link as unknown as { speakerLog: boolean[] }).speakerLog;
    expect(log).toContain(false);
    expect(log).not.toContain(true);
  });
});

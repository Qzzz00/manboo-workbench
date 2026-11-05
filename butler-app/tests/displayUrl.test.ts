/**
 * 展示台那个 iframe 的地址,以及「这份配对到底连不连得上」。
 *
 * 2026-09-22 复核(横屏回到展示台那张卡):账号搬服务器(0.2.52)之后 `Pairing` 的形状没变,
 * 工作台那一侧 `/live` 也照旧认 `?token=`。**变的是多出一种配对** ——
 * 只用账号登录、没跟电脑配过对的手机拿到的是 `relayOnlyPairing()`:令牌空串、地址 127.0.0.1:1。
 * 那种手机上展示台连不上,界面要**如实说**,而不是摆一个永远转圈的 iframe。
 */
import { describe, expect, it } from 'vitest';
import { DISPLAY_AVATAR, HOST_MESSAGE_TYPE, displayUrl, hostMessages, readyFromDisplay } from '../src/display/displayUrl';

describe('展示台地址', () => {
  /**
   * 2026-09-30(维护者:「Agent 显示都是下线状态」):展示台不再自己连 /live,状态由手机壳递进去
   * (`?feed=host`)。**令牌和电脑地址都不再进 iframe 的地址栏**。
   */
  it('★?feed=host:状态由手机壳递进去;令牌与电脑地址都不进地址', () => {
    const url = new URL(displayUrl(), 'http://localhost/');
    expect(url.pathname).toBe('/display/display.html');
    expect(url.searchParams.get('feed')).toBe('host');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.has('workbench')).toBe(false);
  });

  /**
   * 2026-09-22 Ben:「把 Live2D 形象换成旋转的粒子吧」。地址里**不带** `?avatar=`(展示台那侧默认粒子球);
   * 形象由壳递进 iframe(`avatars` 消息),10-21 起只来自电脑上传的形象包。
   */
  it('★形象位默认粒子球:地址里没有 ?avatar=', () => {
    const url = new URL(displayUrl(), 'http://localhost/');
    expect(DISPLAY_AVATAR).toBe('');
    expect(url.searchParams.has('avatar')).toBe(false);
  });
});

describe('递进 iframe 的那两句(与 display-client/src/display/hostFeed.ts 同一份约定)', () => {
  const state = { now: 'n', stale: false, agents: [], sessions: [] };
  it('快照 = 手机手上那份 /state 原样;外观 = Mac 那份粒子参数', () => {
    const [snap, look] = hostMessages(state as never, { count: 3600, cloudSize: 0.5 } as never);
    expect(snap).toEqual({ type: HOST_MESSAGE_TYPE, kind: 'snapshot', state });
    expect(look).toEqual({ type: HOST_MESSAGE_TYPE, kind: 'appearance', settings: { count: 3600, cloudSize: 0.5 } });
  });
  it('★电脑没连上时快照照递,但 stale 如实为真(展示台写「和电脑断开了」)', () => {
    const [snap] = hostMessages({ ...state, stale: false } as never, {} as never, false);
    expect((snap as { state: { stale: boolean } }).state.stale).toBe(true);
  });
  it('认得出展示台那句「我好了」;别的不认', () => {
    expect(readyFromDisplay({ type: HOST_MESSAGE_TYPE, kind: 'ready' })).toBe(true);
    expect(readyFromDisplay({ type: HOST_MESSAGE_TYPE, kind: 'snapshot' })).toBe(false);
    expect(readyFromDisplay('ready')).toBe(false);
  });
});

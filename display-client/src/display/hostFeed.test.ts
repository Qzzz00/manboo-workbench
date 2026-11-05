/**
 * 手机横屏里:展示台的状态由手机壳递进来(2026-09-30)。
 *
 * 维护者:「Agent 显示都是下线状态」。展示台原来在 iframe 里**自己另开一条** `ws://<电脑局域网地址>:8791/live`;
 * 手机不在同一个 Wi-Fi、走房间(或只用账号登录过)时那条连不上,会话区就是一排灰灯 + 「Agent 掉线」,
 * 而手机壳自己手上明明有一份新鲜的 /state(局域网直连或经房间,routedClient 自己挑路)。
 */
import { describe, expect, it } from 'vitest';
import { HOST_MESSAGE_TYPE, acceptHostEvent, avatarSelectMessage, isHostFeed, parseHostMessage } from './hostFeed';

describe('?feed=host 才走手机壳递进来的那一份', () => {
  it('查询串带 feed=host = 走手机壳;不带 = 老样子自己连 /live(那台 1200×800 的展示台)', () => {
    expect(isHostFeed('?feed=host')).toBe(true);
    expect(isHostFeed('?workbench=ws://a:1/live&feed=host')).toBe(true);
    expect(isHostFeed('')).toBe(false);
    expect(isHostFeed('?workbench=ws://a:1/live&token=T')).toBe(false);
  });
});

describe('认手机壳递进来的消息', () => {
  const state = { agents: [], sessions: [], quota: {}, now: '2026-09-30T13:00:00Z', stale: false };
  it('快照:带着整份 /state', () => {
    expect(parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'snapshot', state })).toEqual({ type: HOST_MESSAGE_TYPE, kind: 'snapshot', state });
  });
  it('外观:只收数字参数', () => {
    expect(parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'appearance', settings: { count: 3600, cloudSize: 0.5 } }))
      .toEqual({ type: HOST_MESSAGE_TYPE, kind: 'appearance', settings: { count: 3600, cloudSize: 0.5 } });
    expect(parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'appearance', settings: { count: 'x' } })).toBeNull();
  });
  it('认不得的一律不收(别的页面、别的插件发来的 postMessage 不许改展示台)', () => {
    expect(parseHostMessage(null)).toBeNull();
    expect(parseHostMessage('snapshot')).toBeNull();
    expect(parseHostMessage({ kind: 'snapshot', state })).toBeNull();
    expect(parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'snapshot', state: { sessions: [] } })).toBeNull();
    expect(parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'ring' })).toBeNull();
  });
  it('★只收父窗口、同源发来的:别的来源同样的内容也不收', () => {
    const parent = {};
    const data = { type: HOST_MESSAGE_TYPE, kind: 'snapshot', state };
    const env = { parent, origin: 'http://localhost' };
    expect(acceptHostEvent({ source: parent, origin: 'http://localhost', data }, env)).not.toBeNull();
    expect(acceptHostEvent({ source: {}, origin: 'http://localhost', data }, env)).toBeNull();
    expect(acceptHostEvent({ source: parent, origin: 'http://evil.example', data }, env)).toBeNull();
  });
});

describe('形象队列(2026-10-01)', () => {
  const item = { id: 'moxi', name: '九尾狐', base: 'http://localhost/_capacitor_file_/x/', entry: 'moxi.model3.json', subject: { x0: 0, y0: 0, x1: 1, y1: 1 }, backdrop: null, idle: { loop: ['a'], beats: [], muteMouth: false } };
  it('壳递进来「队列 + 当前选择」', () => {
    const m = parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'avatars', items: [item], current: 'moxi' });
    expect(m).toEqual({ type: HOST_MESSAGE_TYPE, kind: 'avatars', items: [item], current: 'moxi' });
  });
  it('缺地址 / 缺入口的条目丢掉;current 不是字符串整条不收', () => {
    const m = parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'avatars', items: [item, { id: 'x' }], current: 'moxi' });
    expect(m && m.kind === 'avatars' ? m.items.map((i) => i.id) : null).toEqual(['moxi']);
    expect(parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'avatars', items: [item] })).toBeNull();
  });
  it('展示台回给壳:用户滑到 / 点了哪个', () => {
    expect(avatarSelectMessage('ougen_5')).toEqual({ type: HOST_MESSAGE_TYPE, kind: 'avatar-select', id: 'ougen_5' });
  });
});

describe('各家图标(2026-10-01,第二套展示台「环绕」要各家真 logo)', () => {
  it('只收 data:image/ 的图;别的地址一律丢掉(展示台不替壳去取网络上的东西)', () => {
    const icons = { claude: 'data:image/png;base64,AAAA', codex: 'https://evil.example/x.png', kimi: 3 };
    expect(parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'icons', icons }))
      .toEqual({ type: HOST_MESSAGE_TYPE, kind: 'icons', icons: { claude: 'data:image/png;base64,AAAA' } });
    expect(parseHostMessage({ type: HOST_MESSAGE_TYPE, kind: 'icons', icons: null })).toBeNull();
  });
});

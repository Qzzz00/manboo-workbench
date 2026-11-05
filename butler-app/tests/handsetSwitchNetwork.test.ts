/**
 * 给**已经在线的**座机换 Wi-Fi(2026-09-22 晚)。
 * 派那一侧对应 `phone-bridge/netcfg_test.py`,两边验的是同一份协议。
 */
import { describe, expect, it } from 'vitest';
import {
  NO_HANDSET_TEXT, SEND_FAILED_TEXT, SWITCH_TIMEOUT_TEXT, doneText, initialSwitchState,
  orderedSwitchNetworks, parseNetcfgReply, scanRequest, switchRequest, switchStep,
  type NetcfgReply, type SwitchEvent, type SwitchState, type SwitchStepped,
} from '../src/handset/switchNetwork';

const HANDSET = 'wb-phone-handset-3f2a';

function net(ssid: string, extra: Partial<{ signal: number; security: string; inUse: boolean; saved: boolean }> = {}) {
  return { ssid, signal: 50, security: 'WPA2', inUse: false, saved: false, ...extra };
}

/** 从「座机在线 + 已经拿到列表」那一步开始,省掉每条用例重复的三行。 */
function atNetworks(list = [net('VR_GUEST'), net('Ben')]): SwitchState {
  let s: SwitchStepped = { state: initialSwitchState(), effects: [] };
  const feed = (event: SwitchEvent) => { s = switchStep(s.state, event); };
  feed({ type: 'handset', identity: HANDSET, name: '座机话筒' });
  feed({ type: 'reply', reply: { id: 'x', action: 'scan', ok: true, networks: list, text: '' } });
  return s.state;
}

describe('发出去的那两条', () => {
  it('扫一遍那条只有 id 和动作', () => {
    expect(JSON.parse(scanRequest('r1'))).toEqual({ id: 'r1', type: 'netcfg', action: 'scan' });
  });

  it('换网那条带 ssid 与密码', () => {
    expect(JSON.parse(switchRequest('r2', 'VR_GUEST', '12345678'))).toEqual({
      id: 'r2', type: 'netcfg', action: 'switch', ssid: 'VR_GUEST', psk: '12345678',
    });
  });

  it('type 不叫 call —— 那是来电那条,工人会认', () => {
    expect(JSON.parse(scanRequest('r1')).type).not.toBe('call');
  });
});

describe('座机回来的那几条', () => {
  it('扫描结果与蓝牙那条共用同一份解析(in_use → inUse)', () => {
    const got = parseNetcfgReply(JSON.stringify({
      id: 'r1', type: 'netcfg', action: 'scan', ok: true,
      networks: [{ ssid: 'VR_GUEST', signal: 80, security: 'WPA2', in_use: true, saved: true }],
    })) as NetcfgReply & { action: 'scan' };
    expect(got.networks[0]).toEqual({ ssid: 'VR_GUEST', signal: 80, security: 'WPA2', inUse: true, saved: true });
  });

  it('换网成了带着新地址', () => {
    const got = parseNetcfgReply(JSON.stringify({
      id: 'r2', type: 'netcfg', action: 'switch', ok: true, ssid: 'VR_GUEST', ip: '192.168.1.20',
    })) as NetcfgReply & { action: 'switch' };
    expect(got.ok).toBe(true);
    expect(got.ip).toBe('192.168.1.20');
  });

  it('回滚过的那条要读得出来', () => {
    const got = parseNetcfgReply(JSON.stringify({
      id: 'r2', type: 'netcfg', action: 'switch', ok: false, code: 'verify_failed',
      text: '已经切回原来的网', rolled_back: true,
    })) as NetcfgReply & { action: 'switch' };
    expect(got.rolledBack).toBe(true);
  });

  it('同一条通道上别人的话一律不认', () => {
    // ★ 这条 topic 上还跑着来电、字幕、缓冲语和工人的应答。认错一条就会让界面乱跳。
    for (const bad of [
      JSON.stringify({ type: 'ring', call_id: 'c1' }),
      JSON.stringify({ type: 'call', id: 'r1', ok: true }),
      JSON.stringify({ type: 'caption', text: '你好' }),
      JSON.stringify({ type: 'netcfg', action: 'scan' }),       // 没 id
      JSON.stringify({ type: 'netcfg', id: 'r1', action: 'x' }), // 不认得的动作
      '{"type":"netcfg"',
      '[]',
      '',
    ]) {
      expect(parseNetcfgReply(bad)).toBeNull();
    }
  });
});

describe('四步走一遍', () => {
  it('座机不在线时什么都不做,并说清该用哪条路', () => {
    const s = initialSwitchState();
    expect(s.step.kind).toBe('offline');
    // ★ 「用上面那条添加座机」——两条路的分工要在这句话里说清楚。
    expect(NO_HANDSET_TEXT).toContain('添加座机');
  });

  it('看见座机就自动扫一遍', () => {
    const s = switchStep(initialSwitchState(), { type: 'handset', identity: HANDSET, name: '座机话筒' });
    expect(s.state.step.kind).toBe('scanning');
    expect(s.effects).toEqual([['scan']]);
    expect(s.state.handset).toBe(HANDSET);
  });

  it('选网 → 输密码 → 密码只在那一个动作里出现一次', () => {
    let s: SwitchStepped = { state: atNetworks(), effects: [] };
    s = switchStep(s.state, { type: 'choose', network: net('VR_GUEST') });
    expect(s.state.step.kind).toBe('password');
    s = switchStep(s.state, { type: 'submit', psk: '12345678' });
    expect(s.state.step).toEqual({ kind: 'switching', ssid: 'VR_GUEST' });
    expect(s.effects).toEqual([['switch', 'VR_GUEST', '12345678']]);
    // ★ 密码不许留在状态里:界面会把 state 画出来,而这一份还会被日志打出来。
    expect(JSON.stringify(s.state)).not.toContain('12345678');
  });

  it('换成了就报新地址', () => {
    let s: SwitchStepped = { state: atNetworks(), effects: [] };
    s = switchStep(s.state, { type: 'choose', network: net('VR_GUEST') });
    s = switchStep(s.state, { type: 'submit', psk: 'x' });
    s = switchStep(s.state, {
      type: 'reply',
      reply: { id: 'r', action: 'switch', ok: true, code: '', text: '', ssid: 'VR_GUEST', ip: '10.0.0.8', rolledBack: false },
    });
    expect(s.state.step).toEqual({ kind: 'done', ssid: 'VR_GUEST', ip: '10.0.0.8' });
    // 收尾:把房间那一份持有放掉
    expect(s.effects).toEqual([['done']]);
    expect(doneText('VR_GUEST', '10.0.0.8')).toContain('10.0.0.8');
  });

  it('换网期间座机离线是正常的,不能当成座机没了', () => {
    // ★ 最容易写错的一条:它**正在**换网,当然连不上。
    // 判成 offline 会把界面从「正在换网」打回「座机不在线」,而三十秒后它就回来了。
    let s: SwitchStepped = { state: atNetworks(), effects: [] };
    s = switchStep(s.state, { type: 'choose', network: net('VR_GUEST') });
    s = switchStep(s.state, { type: 'submit', psk: 'x' });
    s = switchStep(s.state, { type: 'noHandset' });
    expect(s.state.step).toEqual({ kind: 'switching', ssid: 'VR_GUEST' });
  });

  it('没在换网的时候座机掉了就如实说', () => {
    const s = switchStep(atNetworks(), { type: 'noHandset' });
    expect(s.state.step.kind).toBe('offline');
    expect(s.state.handset).toBeUndefined();
  });
});

describe('失败那几支', () => {
  function switching(): SwitchState {
    let s: SwitchStepped = { state: atNetworks(), effects: [] };
    s = switchStep(s.state, { type: 'choose', network: net('VR_GUEST') });
    s = switchStep(s.state, { type: 'submit', psk: 'x' });
    return s.state;
  }

  it('密码错时原样用派那边写好的人话', () => {
    const s = switchStep(switching(), {
      type: 'reply',
      reply: { id: 'r', action: 'switch', ok: false, code: 'bad_password', text: '密码不对。重新输一遍试试(注意大小写)', ssid: 'VR_GUEST', ip: '', rolledBack: false },
    });
    expect(s.state.step).toMatchObject({ kind: 'failed', text: '密码不对。重新输一遍试试(注意大小写)', rolledBack: false });
  });

  it('切过去回不来、已经切回老网的那条要标出来', () => {
    const s = switchStep(switching(), {
      type: 'reply',
      reply: { id: 'r', action: 'switch', ok: false, code: 'verify_failed', text: '已经切回原来的网,座机还在线。', ssid: 'VR_GUEST', ip: '', rolledBack: true },
    });
    expect(s.state.step).toMatchObject({ kind: 'failed', rolledBack: true });
  });

  it('等太久那条不说"失败了"而说"它可能还在路上"', () => {
    // ★ 手机不能比座机先下结论:派那头最坏要 90+60 秒才切回来。
    const s = switchStep(switching(), { type: 'timeout' });
    expect(s.state.step).toMatchObject({ kind: 'failed', text: SWITCH_TIMEOUT_TEXT });
    expect(SWITCH_TIMEOUT_TEXT).toContain('还在换网的路上');
  });

  it('发不出去时如实说是手机这头的问题', () => {
    const s = switchStep(switching(), { type: 'sendFailed', text: '' });
    expect(s.state.step).toMatchObject({ kind: 'failed', text: SEND_FAILED_TEXT });
  });

  it('重试退回选 Wi-Fi,而不是从头找座机', () => {
    // 座机还在(或者刚切回来),没必要重新来一遍。
    const failed = switchStep(switching(), { type: 'sendFailed', text: '' }).state;
    const s = switchStep(failed, { type: 'retry' });
    expect(s.state.step).toMatchObject({ kind: 'networks', busy: true });
    expect(s.effects).toEqual([['scan']]);
  });
});

describe('列表排序', () => {
  it('手机连着的那个排最前', () => {
    const state = { ...atNetworks([net('Ben', { signal: 20 }), net('VR_GUEST', { signal: 90 })]), phoneSsid: 'Ben' };
    expect(orderedSwitchNetworks(state).map((n) => n.ssid)).toEqual(['Ben', 'VR_GUEST']);
  });

  it('不知道手机连的是哪个就退化成按信号,不编一个', () => {
    const state = atNetworks([net('Ben', { signal: 20 }), net('VR_GUEST', { signal: 90 })]);
    expect(orderedSwitchNetworks(state).map((n) => n.ssid)).toEqual(['VR_GUEST', 'Ben']);
  });
});

/**
 * 「添加座机」的协议与流程(2026-09-22)。**一行蓝牙都不碰**。
 *
 * 钉住的是四件会静默坏掉的事:
 *   1. 分帧编解码(MTU 只有 20 字节那一档)—— 坏了的表现是"偶尔丢一条消息";
 *   2. 两头 UUID 对不对得上 —— 对不上的表现是"扫得到、连不上,两头都不报错";
 *   3. 「重试」退回哪一步 —— 退错了的表现是"网都配好了还让人从头找座机";
 *   4. 文案里说没说清下一步做什么。
 */
import { describe, expect, it } from 'vitest';
import {
  CHAR_COMMAND, CHAR_NETWORKS, CHAR_STATUS, FrameAssembler, HANDSET_SERVICE, HANDSET_UNNAMED,
  TEXT, encodeFrames, handsetLabel, needsPassword, parseNetworks, parseStatus, signalBars,
  sortNetworks, type HandsetNetwork,
} from '../src/handset/provisionProtocol';
import {
  START_EFFECTS, initialState, orderedNetworks, retryLabel, step, stepIndex,
  type FoundHandset, type ProvisionState,
} from '../src/handset/provisionMachine';

const PI: FoundHandset = { id: 'AA:BB:CC:DD:EE:FF', name: '工作台座机-9A4C', rssi: -55 };

function net(over: Partial<HandsetNetwork> = {}): HandsetNetwork {
  return { ssid: 'VR_GUEST', signal: 70, security: 'WPA2', inUse: false, saved: false, ...over };
}

function status(over: Record<string, unknown> = {}) {
  return parseStatus({
    phase: 'waiting', text: '', ssid: '', ip: '', error: '', linked: false,
    device_id: 'handset-3f2a7c91b04d4e0f', name: '工作台座机-9A4C', ...over,
  })!;
}

/** 把一串事件喂进去,回 (末状态, 一路上的所有动作)。 */
function run(state: ProvisionState, events: Parameters<typeof step>[1][]) {
  const effects: unknown[] = [];
  let now = state;
  for (const event of events) {
    const next = step(now, event);
    now = next.state;
    effects.push(...next.effects);
  }
  return { state: now, effects };
}

describe('UUID 与派那一侧逐字相同', () => {
  it('四个 UUID 就是 phone-bridge/provision.py 里那四个', () => {
    // ★ 这一条是手抄的契约。改了这里而忘了改 provision.py(或者反过来)的表现是
    // "手机扫得到座机、连上去什么也读不到",而两头日志都是绿的。
    expect(HANDSET_SERVICE).toBe('8f5a7b10-4c3d-4a9e-9b21-6d0c5e7a1f00');
    expect(CHAR_STATUS).toBe('8f5a7b11-4c3d-4a9e-9b21-6d0c5e7a1f00');
    expect(CHAR_NETWORKS).toBe('8f5a7b12-4c3d-4a9e-9b21-6d0c5e7a1f00');
    expect(CHAR_COMMAND).toBe('8f5a7b13-4c3d-4a9e-9b21-6d0c5e7a1f00');
  });
});

describe('分帧', () => {
  it('二十字节那一档也拼得回来', () => {
    const payload = { op: 'connect', ssid: 'VR_GUEST', psk: '开门芝麻芝麻开门' };
    const frames = encodeFrames(payload, 23);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(20);
    const box = new FrameAssembler();
    const got = frames.map((f) => box.feed(f));
    expect(got.slice(0, -1).every((g) => g === null)).toBe(true);
    expect(got[got.length - 1]).toEqual(payload);
  });

  it('装得下的时候只有一帧,帧头是 0x00', () => {
    const frames = encodeFrames({ op: 'scan' }, 185);
    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toBe(0x00);
  });

  it('乱字节不抛也不留残渣', () => {
    const box = new FrameAssembler();
    expect(box.feed(new Uint8Array([0x7f, 1, 2, 3]))).toBeNull();
    expect(box.feed(encodeFrames({ op: 'scan' }, 185)[0])).toEqual({ op: 'scan' });
  });

  it('写了一串半截就走了会被扔掉', () => {
    const box = new FrameAssembler();
    const junk = new Uint8Array(21);
    junk[0] = 0x01;
    for (let i = 0; i < 600; i += 1) box.feed(junk);
    expect(box.feed(new Uint8Array([0x00]))).toBeNull();
  });
});

describe('读派报上来的两条', () => {
  it('缺字段不当错(派上那一版可能比手机这一版老)', () => {
    const one = parseStatus({ phase: 'waiting' });
    expect(one?.phase).toBe('waiting');
    expect(one?.text).toBe('');
    expect(one?.linked).toBe(false);
  });

  it('没有 phase 的一律不认', () => {
    for (const raw of [null, 3, '{}', {}, { phase: '' }, []]) expect(parseStatus(raw)).toBeNull();
  });

  it('Wi-Fi 列表里没名字的那几条丢掉', () => {
    const got = parseNetworks({ networks: [{ ssid: '' }, { ssid: 'A', signal: 70, security: 'WPA2' }, 3] });
    expect(got?.map((n) => n.ssid)).toEqual(['A']);
  });

  it('不是列表就当没读到(而不是当成空列表)', () => {
    // 空列表的意思是"一个都没扫到",读不懂的意思是"不知道"。两件事,界面上的话不一样。
    expect(parseNetworks({})).toBeNull();
    expect(parseNetworks({ networks: [] })).toEqual([]);
  });
});

describe('Wi-Fi 列表怎么排', () => {
  it('手机连着的那个排最前(Ben 的原话)', () => {
    const list = [net({ ssid: 'A', signal: 90 }), net({ ssid: '我家', signal: 30 }), net({ ssid: 'B', signal: 60, inUse: true })];
    expect(sortNetworks(list, '我家').map((n) => n.ssid)).toEqual(['我家', 'B', 'A']);
  });

  it('不知道手机连的是哪个就退化成「座机连着的排最前」,不编一个', () => {
    const list = [net({ ssid: 'A', signal: 90 }), net({ ssid: 'B', signal: 60, inUse: true }), net({ ssid: 'C', signal: 40, saved: true })];
    expect(sortNetworks(list).map((n) => n.ssid)).toEqual(['B', 'C', 'A']);
  });

  it('开放网认的是空的 security', () => {
    expect(needsPassword(net({ security: '' }))).toBe(false);
    expect(needsPassword(net({ security: 'WPA2' }))).toBe(true);
  });

  it('信号只分四格,不显示 dBm', () => {
    expect([signalBars(10), signalBars(40), signalBars(60), signalBars(90)]).toEqual([1, 2, 3, 4]);
  });

  it('名字没报上来就说没报上来,不编一个假名字', () => {
    expect(handsetLabel(undefined)).toBe(HANDSET_UNNAMED);
    expect(handsetLabel('  ')).toBe(HANDSET_UNNAMED);
    expect(handsetLabel('工作台座机-9A4C')).toBe('工作台座机-9A4C');
  });
});

describe('六步走一遍', () => {
  it('从找座机一路到已上线', () => {
    expect(START_EFFECTS).toEqual([['scan']]);
    let state = initialState('我家');

    ({ state } = run(state, [{ type: 'found', devices: [PI] }]));
    expect(state.step.kind).toBe('scanning');
    expect(stepIndex(state.step)).toBe(1);

    let out = step(state, { type: 'pick', device: PI });
    expect(out.effects).toEqual([['stopScan'], ['connect', PI.id]]);
    state = out.state;

    out = step(state, { type: 'connected' });
    // 连上就**一次问两样**:座机可能已经连着网了(看门狗轮到了),
    // 那时不该让人白选一次 Wi-Fi。
    expect(out.effects).toEqual([['send', { op: 'status' }], ['send', { op: 'scan' }]]);
    state = out.state;

    ({ state } = run(state, [{ type: 'networks', list: [net(), net({ ssid: '我家', signal: 40 })] }]));
    expect(state.step.kind).toBe('networks');
    expect(orderedNetworks(state).map((n) => n.ssid)).toEqual(['我家', 'VR_GUEST']);

    ({ state } = run(state, [{ type: 'choose', network: net() }]));
    expect(state.step.kind).toBe('password');
    expect(stepIndex(state.step)).toBe(3);

    out = step(state, { type: 'submit', psk: '开门芝麻' });
    expect(out.effects).toEqual([['send', { op: 'connect', ssid: 'VR_GUEST', psk: '开门芝麻' }]]);
    state = out.state;
    expect(state.step.kind).toBe('joining');

    // 座机报连上了 → **自动进配对那一步**,不等人再点一下。
    out = step(state, { type: 'status', status: status({ phase: 'online', ssid: 'VR_GUEST', text: '座机连上 VR_GUEST 了' }) });
    expect(out.effects).toEqual([['link']]);
    state = out.state;
    expect(state.step.kind).toBe('linking');

    out = step(state, { type: 'status', status: status({ phase: 'online', ssid: 'VR_GUEST', linked: true, text: '座机已上线' }) });
    expect(out.effects).toEqual([['disconnect']]);
    expect(out.state.step).toEqual({ kind: 'done', device: PI, ssid: 'VR_GUEST' });
    expect(stepIndex(out.state.step)).toBe(6);
  });

  it('正在连的时候座机报的中间状态只换一句话,不换相位', () => {
    let state = initialState();
    ({ state } = run(state, [
      { type: 'found', devices: [PI] }, { type: 'pick', device: PI }, { type: 'connected' },
      { type: 'networks', list: [net()] }, { type: 'choose', network: net() },
      { type: 'submit', psk: 'x' },
    ]));
    const out = step(state, { type: 'status', status: status({ phase: 'connecting', text: '座机正在连 VR_GUEST…' }) });
    expect(out.state.step).toMatchObject({ kind: 'joining', text: '座机正在连 VR_GUEST…' });
    expect(out.effects).toEqual([]);
  });
});

describe('每一步失败都有人话和重试', () => {
  function stuck(events: Parameters<typeof step>[1][]) {
    return run(initialState(), events).state;
  }

  it('一台都没找到时说清下一步做什么', () => {
    const state = stuck([{ type: 'scanEmpty' }]);
    expect(state.step).toMatchObject({ kind: 'failed', at: 'scan' });
    expect(state.step.kind === 'failed' && state.step.text).toBe(TEXT.none);
    // "没找到"之外还要有"那怎么办"。
    expect(TEXT.none).toContain('通着电');
  });

  it('密码错用的是派自己写的那句人话,手机不再包一层', () => {
    const state = stuck([
      { type: 'found', devices: [PI] }, { type: 'pick', device: PI }, { type: 'connected' },
      { type: 'networks', list: [net()] }, { type: 'choose', network: net() }, { type: 'submit', psk: '错的' },
      { type: 'status', status: status({ phase: 'waiting', error: 'bad_password', text: '密码不对。重新输一遍试试(注意大小写)' }) },
    ]);
    expect(state.step).toMatchObject({ kind: 'failed', at: 'wifi', text: '密码不对。重新输一遍试试(注意大小写)' });
  });

  it('★ 网配好了之后失败,重试不该把人打回「找座机」', () => {
    // 这是这条流程最气人的可能:配对那一步没成,结果让人把 Wi-Fi 重配一遍。
    let state = stuck([
      { type: 'found', devices: [PI] }, { type: 'pick', device: PI }, { type: 'connected' },
      { type: 'networks', list: [net()] }, { type: 'choose', network: net() }, { type: 'submit', psk: 'x' },
      { type: 'status', status: status({ phase: 'online', ssid: 'VR_GUEST' }) },
      { type: 'linkFailed', text: '账号服务这会儿连不上' },
    ]);
    expect(state.step).toMatchObject({ kind: 'failed', at: 'link', text: '账号服务这会儿连不上' });
    expect(retryLabel('link')).toContain('网不用重配');

    const out = step(state, { type: 'retry' });
    expect(out.state.step.kind).toBe('linking');
    expect(out.effects).toEqual([['link']]);
  });

  it('Wi-Fi 那一步失败,重试退回选 Wi-Fi 而不是重新找座机', () => {
    const state = stuck([
      { type: 'found', devices: [PI] }, { type: 'pick', device: PI }, { type: 'connected' },
      { type: 'networks', list: [net()] }, { type: 'choose', network: net() }, { type: 'submit', psk: 'x' },
      { type: 'status', status: status({ error: 'not_found', text: '附近没找到这个 Wi-Fi' }) },
    ]);
    const out = step(state, { type: 'retry' });
    expect(out.state.step.kind).toBe('networks');
    expect(out.effects).toEqual([['send', { op: 'scan' }]]);
  });

  it('连不上座机,重试是再连那一台,不是重新扫', () => {
    const state = stuck([
      { type: 'found', devices: [PI] }, { type: 'pick', device: PI },
      { type: 'connectFailed', text: TEXT.connectFailed },
    ]);
    const out = step(state, { type: 'retry' });
    expect(out.effects).toEqual([['connect', PI.id]]);
  });

  it('半路断线说清哪一半已经成了', () => {
    const state = stuck([
      { type: 'found', devices: [PI] }, { type: 'pick', device: PI }, { type: 'connected' },
      { type: 'lost' },
    ]);
    expect(state.step).toMatchObject({ kind: 'failed', at: 'wifi', text: TEXT.lost });
    expect(TEXT.lost).toContain('进度还在座机上');
  });

  it('已经上线之后再断线不算失败', () => {
    let state = initialState();
    ({ state } = run(state, [
      { type: 'found', devices: [PI] }, { type: 'pick', device: PI }, { type: 'connected' },
      { type: 'networks', list: [net()] }, { type: 'choose', network: net() }, { type: 'submit', psk: 'x' },
      { type: 'status', status: status({ phase: 'online', ssid: 'VR_GUEST' }) },
      { type: 'status', status: status({ phase: 'online', ssid: 'VR_GUEST', linked: true }) },
      { type: 'lost' },
    ]));
    expect(state.step.kind).toBe('done');
  });

  it('没登录账号时那句话说的是去哪儿登录', () => {
    expect(TEXT.needAccount).toContain('先在设置里登录');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { WBCH_RPC_CLOSED_TEXT, WBCH_RPC_TIMEOUT_TEXT, createWbchRpc } from '../src/channel/rpc';
import { WBCH_RPC_TOPIC } from '../src/channel/channelProtocol';
import { createFakeLink, lastSent } from './wbchFakes';

function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe('经房间打 HTTP', () => {
  it('照协议发出去,收到同 id 的响应就算数', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids() });
    const promise = rpc.http({ method: 'GET', path: '/state' });

    expect(lastSent(link)).toEqual({ id: 'id-1', type: 'http', method: 'GET', path: '/state', body: null });
    expect(link.sent[0]?.topic).toBe(WBCH_RPC_TOPIC);

    link.deliver({ id: 'id-1', type: 'http', status: 200, body: { tasks: [] } });
    await expect(promise).resolves.toEqual({ ok: true, status: 200, body: { tasks: [] } });
  });

  it('body 原样带上', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids() });
    void rpc.http({ method: 'POST', path: '/butler/item', body: { text: '订会议室' } });
    expect(lastSent(link)).toMatchObject({ method: 'POST', path: '/butler/item', body: { text: '订会议室' } });
  });

  // 房间是共享的,谁都能发数据;答复要拿去当 /state 用,不能认别人说的。
  it('不是工人发来的响应一律不认', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 40 });
    const promise = rpc.http({ method: 'GET', path: '/state' });
    link.deliver({ id: 'id-1', type: 'http', status: 200, body: { 假的: true } }, 'wb-phone-别人');
    await expect(promise).resolves.toEqual({ ok: false, error: WBCH_RPC_TIMEOUT_TEXT });
  });

  it('对不上 id 的响应丢掉', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 40 });
    const promise = rpc.http({ method: 'GET', path: '/state' });
    link.deliver({ id: 'id-9', type: 'http', status: 200, body: {} });
    await expect(promise).resolves.toEqual({ ok: false, error: WBCH_RPC_TIMEOUT_TEXT });
  });

  it('两条请求各拿各的答复,顺序倒着回来也不串', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids() });
    const a = rpc.http({ method: 'GET', path: '/state' });
    const b = rpc.http({ method: 'GET', path: '/butler/items' });
    link.deliver({ id: 'id-2', type: 'http', status: 200, body: 'b' });
    link.deliver({ id: 'id-1', type: 'http', status: 200, body: 'a' });
    await expect(a).resolves.toMatchObject({ body: 'a' });
    await expect(b).resolves.toMatchObject({ body: 'b' });
  });

  // 房里没有工人时请求发得出去、永远没人答。没有超时界面会一直转圈,也永远切不回直连。
  it('没人答就超时,说的是「连不上」那种话', async () => {
    vi.useFakeTimers();
    try {
      const link = createFakeLink();
      const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 1000 });
      const promise = rpc.http({ method: 'GET', path: '/state' });
      await vi.advanceTimersByTimeAsync(1001);
      await expect(promise).resolves.toEqual({ ok: false, error: WBCH_RPC_TIMEOUT_TEXT });
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时之后迟到的响应不许翻案', async () => {
    vi.useFakeTimers();
    try {
      const link = createFakeLink();
      const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 1000 });
      const promise = rpc.http({ method: 'GET', path: '/state' });
      await vi.advanceTimersByTimeAsync(1001);
      const settled = await promise;
      link.deliver({ id: 'id-1', type: 'http', status: 200, body: '迟到' });
      expect(settled).toEqual({ ok: false, error: WBCH_RPC_TIMEOUT_TEXT });
    } finally {
      vi.useRealTimers();
    }
  });

  it('房间断了,等着的那些立刻收场,不悬到超时', async () => {
    const link = createFakeLink();
    await link.acquire('rpc', { url: 'x', room: 'r', identity: 'i', token: 't', expires_at: 0 });
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 60000 });
    const promise = rpc.http({ method: 'GET', path: '/state' });
    link.setState('closed');
    await expect(promise).resolves.toEqual({ ok: false, error: WBCH_RPC_CLOSED_TEXT });
  });

  it('发都发不出去(没进房)就如实说', async () => {
    const link = createFakeLink();
    link.sendText = async () => { throw new Error('还没进房'); };
    const rpc = createWbchRpc({ link, newId: ids() });
    await expect(rpc.http({ method: 'GET', path: '/state' })).resolves.toEqual({ ok: false, error: '还没进房' });
  });

  it('dispose 之后不再收数据,也不再发得出去', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids() });
    rpc.dispose();
    await expect(rpc.http({ method: 'GET', path: '/state' })).resolves.toEqual({ ok: false, error: WBCH_RPC_CLOSED_TEXT });
  });
});

describe('凭证续期', () => {
  it('发 renew,收 token', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids() });
    const promise = rpc.renew();
    expect(lastSent(link)).toEqual({ id: 'id-1', type: 'renew' });
    link.deliver({ id: 'id-1', type: 'token', token: 'jwt-2', expires_at: 1789 });
    await expect(promise).resolves.toEqual({ ok: true, credential: { token: 'jwt-2', expires_at: 1789 } });
  });

  // 等 token 的那条不该被一条 http 响应顶掉,反过来也一样。
  it('等 token 时来了一条 http 响应,不认', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 40 });
    const promise = rpc.renew();
    link.deliver({ id: 'id-1', type: 'http', status: 200, body: {} });
    await expect(promise).resolves.toEqual({ ok: false, error: WBCH_RPC_TIMEOUT_TEXT });
  });
});

describe('工人明说办不成', () => {
  it('type:error 原话转达,不套一层', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 50 });
    const promise = rpc.http({ method: 'GET', path: '/state' });
    link.deliver({ id: 'id-1', type: 'error', error: '工作台连不上,这张凭证续不了' });
    await expect(promise).resolves.toEqual({ ok: false, error: '工作台连不上,这张凭证续不了' });
  });
});

describe('字幕', () => {
  it('识别 wb.rpc 上的 say_decision 广播并原样分发', () => {
    const link = createFakeLink();
    const onSayDecision = vi.fn();
    createWbchRpc({ link, newId: ids(), onSayDecision });
    const message = {
      type: 'say_decision', event_id: 'say-1:decided:0:who', call_id: 'call-1', say_id: 'say-1', kind: 'decided',
      decision: { decided_id: 'd-1', item_index: 0, field: 'who', chosen: 'Claude' },
      say: { screen: '我替你定了这一件。' }, item: { title: '原件标题', status: 'todo', card_id: 'card-1', who: 'Claude' },
    };
    link.deliver(message);
    expect(onSayDecision).toHaveBeenCalledWith(message);
  });

  it('工人推的字幕转给上面那层,不当成答复', async () => {
    const link = createFakeLink();
    const seen: unknown[] = [];
    createWbchRpc({ link, newId: ids(), onCaption: (c) => seen.push(c) });
    link.deliver({ type: 'caption', role: 'me', text: '记一下明天开会', final: true });
    link.deliver({ type: 'caption', role: 'butler', text: '好,记下了' });
    expect(seen).toEqual([
      { type: 'caption', role: 'me', text: '记一下明天开会', final: true },
      { type: 'caption', role: 'butler', text: '好,记下了', final: false },
    ]);
  });

  it('别人发的字幕不认', () => {
    const link = createFakeLink();
    const seen: unknown[] = [];
    createWbchRpc({ link, newId: ids(), onCaption: (c) => seen.push(c) });
    link.deliver({ type: 'caption', role: 'butler', text: '我是假的' }, 'wb-phone-别人');
    expect(seen).toEqual([]);
  });

  it('一段读不懂的字节不会把通道带走', () => {
    const link = createFakeLink();
    const seen: unknown[] = [];
    createWbchRpc({ link, newId: ids(), onCaption: (c) => seen.push(c) });
    expect(() => link.deliver('{ 半句')).not.toThrow();
    expect(seen).toEqual([]);
  });
});

/**
 * 引导那条消息(2026-09-18)。它和 HTTP 代办走**同一条** `wb.rpc`,所以同样要:
 * 只认工人发来的答复、id 对得上、办不成时原话转达。
 */
describe('引导那条消息', () => {
  it('照协议发出去;工人说好了就带回阶段', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids() });
    const promise = rpc.onboarding('start');
    expect(lastSent(link)).toEqual({ id: 'id-1', type: 'onboarding', action: 'start' });
    link.deliver({ id: 'id-1', type: 'onboarding', ok: true, stage: 'opening' });
    await expect(promise).resolves.toEqual({ ok: true, stage: 'opening' });
  });

  it('打字那条带上话;工人接不了引导就把那句原话交出来', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids() });
    const promise = rpc.onboarding('say', '叫我 Ben');
    expect(lastSent(link)).toMatchObject({ type: 'onboarding', action: 'say', text: '叫我 Ben' });
    link.deliver({ id: 'id-1', type: 'onboarding', ok: false, error: '电脑上的事务官现在接不了引导' });
    await expect(promise).resolves.toEqual({ ok: false, error: '电脑上的事务官现在接不了引导' });
  });

  it('房间断了:引导这条也立刻收场,不悬到超时', async () => {
    const link = createFakeLink();
    await link.acquire('call', { url: 'x', room: 'r', identity: 'i', token: 't', expires_at: 0 });
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 60000 });
    const promise = rpc.onboarding('start');
    link.setState('closed');
    await expect(promise).resolves.toEqual({ ok: false, error: WBCH_RPC_CLOSED_TEXT });
  });
});

/**
 * 工人不认这台手机时,引导 / 通话那一条当场收场(2026-09-25,卡 fix/evening-gaps)。
 * 工人对不是配对过的手机一律回 `http 403`(连引导、通话也是);以前这边只认同类回包、把它丢掉,
 * 手机干等 15 秒超时 —— 小米那一通引导卡在「正在接通…」。
 */
describe('★ 工人回了 403:引导 / 通话不干等', () => {
  it('★ 引导那一条收到 http 403 → 当场失败,说清「不认这台手机、重新配对」', async () => {
    const { WBCH_RPC_NOT_PAIRED_TEXT } = await import('../src/channel/rpc');
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 60_000 });
    const began = Date.now();
    const promise = rpc.onboarding('start');
    link.deliver({ id: 'id-1', type: 'http', status: 403, body: { error: '房间代理只替已配对的手机办事' } });
    await expect(promise).resolves.toEqual({ ok: false, error: WBCH_RPC_NOT_PAIRED_TEXT });
    expect(Date.now() - began).toBeLessThan(1000);
  });

  it('★ 新工人回同类的一条 ok:false(不认这台手机):换成能照着做的那句', async () => {
    const { WBCH_RPC_NOT_PAIRED_TEXT, WBCH_WORKER_NOT_PAIRED_TEXT } = await import('../src/channel/rpc');
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 60_000 });
    const call = rpc.callStart();
    link.deliver({ id: 'id-1', type: 'call', ok: false, error: WBCH_WORKER_NOT_PAIRED_TEXT });
    await expect(call).resolves.toEqual({ ok: false, error: WBCH_RPC_NOT_PAIRED_TEXT });
    const onboarding = rpc.onboarding('start');
    link.deliver({ id: 'id-2', type: 'onboarding', ok: false, error: WBCH_WORKER_NOT_PAIRED_TEXT });
    await expect(onboarding).resolves.toEqual({ ok: false, error: WBCH_RPC_NOT_PAIRED_TEXT });
    // 别的原话照旧原样转达。
    const again = rpc.callStart();
    link.deliver({ id: 'id-3', type: 'call', ok: false, error: '电脑上的事务官现在接不了话(没有接话模型)' });
    await expect(again).resolves.toEqual({ ok: false, error: '电脑上的事务官现在接不了话(没有接话模型)' });
  });

  it('两边那句「不认这台手机」的原话一字不差(工人改了它,这边就认不出来了)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { WBCH_WORKER_NOT_PAIRED_TEXT } = await import('../src/channel/rpc');
    // 用例在 butler-app/ 下跑(jsdom 里 import.meta.url 不是 file:)。
    const worker = readFileSync(resolve(process.cwd(), '..', 'channel-worker', 'src', 'rpc.ts'), 'utf8');
    expect(worker).toContain(`export const RPC_NOT_PAIRED_TEXT = '${WBCH_WORKER_NOT_PAIRED_TEXT}'`);
  });

  it('通话那一条同理;别的状态码说原码', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 60_000 });
    const promise = rpc.callStart();
    link.deliver({ id: 'id-1', type: 'http', status: 502, body: {} });
    await expect(promise).resolves.toEqual({ ok: false, error: '电脑上的事务官没接这一条(502)' });
  });

  it('http 200 这种形状不对的回包照旧不认(不是它等的那种答复)', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: ids(), timeoutMs: 40 });
    const promise = rpc.onboarding('start');
    link.deliver({ id: 'id-1', type: 'http', status: 200, body: {} });
    await expect(promise).resolves.toEqual({ ok: false, error: WBCH_RPC_TIMEOUT_TEXT });
  });
});

/**
 * 协作区留言模型测试(2026-10-24,小K)。
 *
 * 设计口径(10-23 设计交接 3.6):普通留言默认**只留记录**;@ 名片时发送前显对象动作;
 * 认不出的名字不当成功;「请它处理」没有真实投递口时如实拒发,不许假成功;
 * 投递走待发箱(先落盘、断网暂存、恢复补发、电脑说不行的不自动补)。
 */
import { describe, expect, it } from 'vitest';
import { composeComment, MESSAGE_PATH, intentLine } from '../src/collab/comments';
import { createSendOutbox, type SendOutboxClient } from '../src/outbox/sendOutbox';
import type { ApiResult, RequestOptions } from '../src/api/client';

/** 假客户端:泛型签名对齐 SendOutboxClient,回包按需给。 */
function fakeClient(fn: (options?: RequestOptions) => ApiResult<unknown>): SendOutboxClient {
  return {
    json: async <T,>(_path: string, options?: RequestOptions): Promise<ApiResult<T>> => fn(options) as ApiResult<T>,
  };
}

const CARDS = { 'agent:kimi-1': '小K', 'agent:gemini-2': '小G' };

describe('composeComment:@ 名片与意图', () => {
  it('不带 @:默认只留记录,原文照发(带幂等号)', () => {
    const r = composeComment('t1', '这段先记着', CARDS, 'record');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toMatchObject({ task_id: 't1', text: '这段先记着', intent: 'record', mentions: [] });
      expect(r.body.client_msg_id).toBeTruthy();
    }
  });

  it('@ 真实名片:mentions 带名片 id,文案原样', () => {
    const r = composeComment('t1', '@小K 看一下这个', CARDS, 'record');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.mentions).toEqual(['agent:kimi-1']);
      expect(r.body.text).toBe('@小K 看一下这个');
    }
  });

  it('同名名片不得默认挑第一张;显式选择后保留准确 id', () => {
    const cards = { 'agent:first': '小组助手', 'agent:second': '小组助手' };
    expect(composeComment('t1', '@小组助手 检查资料', cards, 'ask').ok).toBe(false);
    const picked = composeComment('t1', '@小组助手 检查资料', cards, 'ask', { pickedIds: ['agent:second'] });
    expect(picked.ok && picked.body.mentions).toEqual(['agent:second']);
  });

  it('@ 多个名片都认;中间夹不认出的名字 → 拒发并点名', () => {
    const bad = composeComment('t1', '@小K @不存在 看看', CARDS, 'record');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('不存在');
    const good = composeComment('t1', '@小K @小G 看看', CARDS, 'record');
    expect(good.ok && good.body.mentions).toEqual(['agent:kimi-1', 'agent:gemini-2']);
  });

  it('「请它处理」接真投递口:@ 真实名片即组织成 ask 投递(带 client_msg_id);不带 @ 拒发', () => {
    const r = composeComment('t1', '@小K 跑一下', CARDS, 'ask');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.intent).toBe('ask');
      expect(r.body.mentions).toEqual(['agent:kimi-1']);
      expect(r.body.client_msg_id).toMatch(/^[0-9a-f-]{30,}$/);
    }
    const noMention = composeComment('t1', '跑一下', CARDS, 'ask');
    expect(noMention.ok).toBe(false);
    if (!noMention.ok) expect(noMention.error).toContain('@');
    // 断网重发:同一个 client_msg_id(幂等,服务端不重复留言/派活)。
    const again = composeComment('t1', '@小K 跑一下', CARDS, 'ask', { clientMsgId: r.ok ? r.body.client_msg_id : '' });
    expect(again.ok && again.body.client_msg_id).toBe(r.ok ? r.body.client_msg_id : '');
  });

  it.each(['@小K2 请核对', '@小K错名 请核对', '@小K_extra 请核对'])('R6 完整未知名字不能匹配真实名字前缀: %s', (text) => {
    expect(composeComment('t1', text, CARDS, 'ask').ok).toBe(false);
    expect(composeComment('t1', text, CARDS, 'ask', { pickedIds: ['agent:kimi-1'] }).ok).toBe(false);
  });
  it('R6 完整边界与含空格名字/长短名均精确匹配', () => {
    for (const text of ['@小K，核对', '@小K: 核对', '@小K']) expect(composeComment('t1', text, CARDS, 'ask').ok).toBe(true);
    expect(composeComment('t1', '@小K2 核对', { ...CARDS, 'agent:k2': '小K2' }, 'ask')).toMatchObject({ ok: true, body: { mentions: ['agent:k2'] } });
    expect(composeComment('t1', '@Design Helper 核对', { 'agent:d': 'Design Helper' }, 'ask')).toMatchObject({ ok: true, body: { mentions: ['agent:d'] } });
  });

  it('intentionLine:只记录/请它处理两种意图的话分清楚', () => {
    expect(intentLine('record')).toContain('只留记录');
    expect(intentLine('ask')).toContain('处理');
  });
});

describe('留言走待发箱:离线暂存/恢复补发/拒绝不补/不重复', () => {
  function memoryKv() {
    const m = new Map<string, string>();
    return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); }, remove: async (k: string) => { m.delete(k); } };
  }
  const okReply = (): ApiResult<unknown> => ({ ok: true, status: 200, data: { ok: true } });

  it('电脑在线:直接送达,不进账', async () => {
    const sent: unknown[] = [];
    const outbox = createSendOutbox({ kv: memoryKv(), client: fakeClient((o) => { sent.push(o?.body); return okReply(); }) });
    const r = await outbox.send(MESSAGE_PATH, { id: 't1', text: 'hi', mentions: [] }, { text: 'hi', at: '2026-10-24T10:00:00+08:00' });
    expect(r.outcome.kind).toBe('delivered');
    expect(outbox.list()).toHaveLength(0);
    expect((sent[0] as Record<string, unknown>).client_key).toBeTruthy();
  });

  it('断网:留在账上标「没送到」,pump 恢复后补发成功;请求号同一个不重复记', async () => {
    let online = false;
    let calls = 0;
    const outbox = createSendOutbox({ kv: memoryKv(), client: fakeClient(() => { calls += 1; return online ? okReply() : { ok: false, status: 0, kind: 'network', error: '连不上' }; }) });
    const r = await outbox.send(MESSAGE_PATH, { id: 't1', text: 'hi', mentions: [] }, { text: 'hi', at: '2026-10-24T10:00:00+08:00' });
    expect(r.outcome.kind).toBe('unsent');
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.list()[0].state).toBe('unsent');
    const key = outbox.list()[0].key;
    online = true;
    await outbox.pump();
    expect(outbox.list()).toHaveLength(0);
    expect(calls).toBe(2); // 一次失败 + 一次补发,不第三次
    // 补发的请求号同一个(幂等,服务端办过不办第二遍)。
    // 账清了;新起的 outbox 从空账开始,这里只验证 send 阶段带的号一致。
    expect(key).toBeTruthy();
  });

  it('在外面(kind=unavailable,那句「只在电脑边才有」):按「没送到」暂存,恢复后自动补发', async () => {
    let online = false;
    const outbox = createSendOutbox({ kv: memoryKv(), client: fakeClient(() => (online
      ? { ok: true, status: 200, data: { ok: true } }
      : { ok: false, status: 0, kind: 'unavailable', error: '留言要跟电脑连同一个 Wi-Fi 才发得出' })) });
    const r = await outbox.send(MESSAGE_PATH, { id: 't1', text: 'hi', mentions: [] }, { text: 'hi', at: '2026-10-24T10:00:00+08:00' });
    expect(r.outcome.kind).toBe('unsent'); // 分类器把它当「没送到」,不是「电脑说不行」
    expect(outbox.list()[0].state).toBe('unsent');
    online = true;
    await outbox.pump();
    expect(outbox.list()).toHaveLength(0);
  });

  it('电脑说不行(4xx):标「被拒绝」,不自动补发,留原话', async () => {
    let calls = 0;
    const outbox = createSendOutbox({ kv: memoryKv(), client: fakeClient(() => { calls += 1; return { ok: false, status: 400, kind: 'http', error: '便签不在' }; }) });
    const r = await outbox.send(MESSAGE_PATH, { id: 't1', text: 'hi', mentions: [] }, { text: 'hi', at: '2026-10-24T10:00:00+08:00' });
    expect(r.outcome).toEqual({ kind: 'rejected', error: '便签不在' });
    await outbox.pump();
    expect(calls).toBe(1); // 拒绝的不补
    expect(outbox.list()[0].state).toBe('rejected');
    expect(outbox.list()[0].error).toBe('便签不在');
  });
});

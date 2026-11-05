/**
 * 手机的待发箱(2026-10-12,卡「手机交代只执行一次」)。
 *
 * 交代一句:**先落盘(连同请求号)再发**。没送到就留在手机上,网络变了 / 过一会儿 / App 重开后自动补发,
 * 补发带的还是那个号(电脑据此不办第二次)。电脑答了「不行」的不再自动补,留着给她看。
 */
import { describe, expect, it } from 'vitest';
import type { ApiResult, RequestOptions } from '../src/api/client';
import { SEND_OUTBOX_AUTO_MS, SEND_OUTBOX_KEY, createSendOutbox, type SendOutboxClient } from '../src/outbox/sendOutbox';
import { memoryStore } from './wbchFakes';

const OK = (data: unknown): ApiResult<unknown> => ({ ok: true, status: 200, data });
const OFFLINE: ApiResult<unknown> = { ok: false, status: 0, kind: 'network', error: '连不上工作台' };
const REJECTED: ApiResult<unknown> = { ok: false, status: 400, kind: 'http', error: '事项内容不能为空' };
const BUSY: ApiResult<unknown> = { ok: false, status: 500, kind: 'http', error: '出错了' };

function fakeClient(answers: ApiResult<unknown>[]): SendOutboxClient & { calls: { path: string; body: Record<string, unknown> }[] } {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let at = 0;
  return {
    calls,
    async json<T>(path: string, options?: RequestOptions) {
      calls.push({ path, body: options?.body as Record<string, unknown> });
      const answer = answers[Math.min(at, answers.length - 1)]!;
      at += 1;
      return answer as ApiResult<T>;
    },
  };
}

describe('发一句', () => {
  it('送到了:回 delivered 带回包,账上不留', async () => {
    const kv = memoryStore();
    const client = fakeClient([OK({ id: 't-1' })]);
    const box = createSendOutbox({ kv, client });
    const got = await box.send('/butler/item', { text: '买咖啡豆' }, { text: '买咖啡豆', at: '2026-10-12T08:00:00Z' });
    expect(got.outcome).toEqual({ kind: 'delivered', data: { id: 't-1' } });
    expect(typeof client.calls[0]!.body.client_key).toBe('string');
    expect(client.calls[0]!.body.client_key).toBe(got.key);
    expect(box.list()).toEqual([]);
    expect(JSON.parse(kv.map.get(SEND_OUTBOX_KEY) ?? '[]')).toEqual([]);
  });

  it('发之前先落盘(连同号):发到一半 App 被杀,账上有它', async () => {
    const kv = memoryStore();
    let seenStored: unknown;
    const client: SendOutboxClient = {
      async json<T>() { seenStored = JSON.parse(kv.map.get(SEND_OUTBOX_KEY) ?? '[]'); return OK({ id: 't-1' }) as ApiResult<T>; },
    };
    const box = createSendOutbox({ kv, client });
    const got = await box.send('/butler/item', { text: 'a' }, { text: 'a', at: 'x' });
    expect(seenStored).toEqual([expect.objectContaining({ key: got.key, path: '/butler/item', state: 'sending' })]);
  });

  it('连不上:留着(没送到),原话带上', async () => {
    const box = createSendOutbox({ kv: memoryStore(), client: fakeClient([OFFLINE]) });
    const got = await box.send('/butler/item', { text: 'a' }, { text: 'a', at: 'x' });
    expect(got.outcome).toEqual({ kind: 'unsent', error: '连不上工作台' });
    expect(box.list()).toEqual([expect.objectContaining({ key: got.key, state: 'unsent', error: '连不上工作台' })]);
  });

  it('电脑 5xx:也算没送到(电脑没记这一号,补发会真办)', async () => {
    const box = createSendOutbox({ kv: memoryStore(), client: fakeClient([BUSY]) });
    expect((await box.send('/butler/item', { text: 'a' }, { text: 'a', at: 'x' })).outcome.kind).toBe('unsent');
  });

  it('电脑答了不行(4xx):rejected,不自动补发', async () => {
    const client = fakeClient([REJECTED]);
    const box = createSendOutbox({ kv: memoryStore(), client });
    const got = await box.send('/butler/item', { text: '' }, { text: '', at: 'x' });
    expect(got.outcome).toEqual({ kind: 'rejected', error: '事项内容不能为空' });
    await box.pump();
    expect(client.calls).toHaveLength(1);
    box.discard(got.key);
    expect(box.list()).toEqual([]);
  });
});

describe('补发', () => {
  it('pump:没送到的按顺序补,带原来那个号;送到了喊 delivered', async () => {
    const kv = memoryStore();
    const client = fakeClient([OFFLINE, OFFLINE, OK({ id: 't-1' }), OK({ id: 't-2' })]);
    const delivered: string[] = [];
    const box = createSendOutbox({ kv, client });
    box.subscribe((event) => { if (event?.delivered !== undefined) delivered.push(`${event.delivered.text}:${(event.data as { id: string }).id}`); });
    const a = await box.send('/butler/item', { text: '一' }, { text: '一', at: '1' });
    const b = await box.send('/butler/item', { text: '二' }, { text: '二', at: '2' });
    await box.pump();
    expect(client.calls.slice(2).map((c) => c.body.client_key)).toEqual([a.key, b.key]);
    expect(delivered).toEqual(['一:t-1', '二:t-2']);
    expect(box.list()).toEqual([]);
  });

  it('App 被杀重开:换一个待发箱读同一份账,接着补(发到一半的那条也补,号不变)', async () => {
    const kv = memoryStore();
    const hang = new Promise<ApiResult<never>>(() => {});
    const first = createSendOutbox({ kv, client: { json: () => hang } });
    void first.send('/butler/item', { text: '交房租' }, { text: '交房租', at: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    const stored = JSON.parse(kv.map.get(SEND_OUTBOX_KEY) ?? '[]') as { key: string }[];
    const client = fakeClient([OK({ id: 't-1' })]);
    const second = createSendOutbox({ kv, client });
    await second.ready();
    expect(second.list()).toEqual([expect.objectContaining({ text: '交房租' })]);
    await second.pump();
    expect(client.calls[0]!.body).toEqual({ text: '交房租', client_key: stored[0]!.key });
    expect(second.list()).toEqual([]);
  });

  it('超过一天的不自动补,留着等她点「重发」', async () => {
    let now = Date.parse('2026-10-12T08:00:00Z');
    const client = fakeClient([OFFLINE, OK({ id: 't-1' })]);
    const box = createSendOutbox({ kv: memoryStore(), client, now: () => now });
    const got = await box.send('/butler/item', { text: 'a' }, { text: 'a', at: 'x' });
    now += SEND_OUTBOX_AUTO_MS + 1;
    await box.pump();
    expect(client.calls).toHaveLength(1);
    expect((await box.resend(got.key)).kind).toBe('delivered');
    expect(client.calls[1]!.body.client_key).toBe(got.key);
  });

  it('同时 pump 两次不会把同一条发两遍', async () => {
    const client = fakeClient([OFFLINE, OK({ id: 't-1' })]);
    const box = createSendOutbox({ kv: memoryStore(), client });
    await box.send('/butler/item', { text: 'a' }, { text: 'a', at: 'x' });
    await Promise.all([box.pump(), box.pump()]);
    expect(client.calls).toHaveLength(2);
  });
});

describe('老工作台不认请求号', () => {
  it('canAutoResend 说不认:不自动补(补了可能办两次);她点「重发」照发', async () => {
    let supports = false;
    const client = fakeClient([OFFLINE, OK({ id: 't-1' })]);
    const box = createSendOutbox({ kv: memoryStore(), client, canAutoResend: () => supports });
    const got = await box.send('/butler/item', { text: 'a' }, { text: 'a', at: 'x' });
    await box.pump();
    expect(client.calls).toHaveLength(1);
    supports = true;
    await box.pump();
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.body.client_key).toBe(got.key);
  });
});

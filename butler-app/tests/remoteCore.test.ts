/**
 * **核心几件用「远程模式」真走一遍**(2026-09-25,卡 S「手机在哪都能用」)。
 *
 * 维护者放假只带手机(「通过事务官去下发、通过事务官去验收,这样子的话我其实放不放假没区别」):
 * 发消息、答提问、批准、派活、识别、取文件 —— 这几件在外面必须都走得通。
 *
 * 这里的「在外面」是一整套真代码:直连一律连不上(LTE 上够不着家里的局域网地址),手机的通道层(channel.ts)、
 * 房间代理(rpc.ts)、两条路怎么选(routedClient.ts)、识别那条专门的路(channelClient.ts)、各页调的那几个函数都是真的;
 * 只有房间对面那台电脑是假的 —— 它按**工人真的白名单**(从 channel-worker/src/rpc.ts 原文读)判放不放,
 * 放了才交给一台假 8791;识别照工人的做法:`{type:'asr'}` 与 `wb.asr` 字节流按编号对上,再交给 8791 的 `/butler/proxy/api/asr`。
 * 于是:白名单里少了哪一条、手机这边哪一件在外面其实走不通,这里都会红。
 *
 * 卡 M 的「答提问」(`POST /questions/answer`)合进来那一刻,tests/remoteParity.test.ts 先红了 —— 它不在工人白名单里,
 * 在外面答不了。白名单那一行由维护者另起的会话加上了(main 50081931),下面「答提问」那一条在外面真走一遍。
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createWbchChannel } from '../src/channel/channel';
import { WBCH_ASR_ID_ATTRIBUTE, WBCH_ASR_TOPIC, WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import { WBCH_CREDENTIAL_KEY, createWbchCredentialStore } from '../src/channel/credentialStore';
import { lanOnlyReason } from '../src/channel/remoteParity';
import { createWbchRoutedClient } from '../src/channel/routedClient';
import { useSendItem } from '../src/chat/useSendItem';
import { answerApproval } from '../src/composer/composerApi';
import { answerQuestion } from '../src/asks/asksApi';
import { itemBody } from '../src/composer/composerModel';
import { createFeatureApi } from '../src/feature/featureApi';
import { pullFileOffer } from '../src/files/fileFetch';
import { loadHistory } from '../src/items/sessionHistory';
import { SESSION_HISTORY_PER_FAMILY } from '../src/api/protocol';
import { attachmentFull } from '../src/items/attachments/attachmentsApi';
import { createOnboardingApi } from '../src/onboarding/onboardingApi';
import type { Session } from '../src/session';
import { createFakeLink, memoryStore } from './wbchFakes';
import { workerAllows, workerWhitelist } from './remoteParityScan';
import { WBCH_BLOB_UNSUPPORTED_TEXT } from '../src/channel/channelClient';

/** 在 LTE 上够不着家里那台电脑的局域网地址:每一条都是「连不上」。 */
const LTE_ONLY: ApiResult<never> = { ok: false, status: 0, kind: 'network', error: '连不上工作台:确认手机和 Mac 在同一局域网' };

const CREDENTIAL = { url: 'wss://lk.example.test', room: 'workbench', identity: 'wb-phone-d1', token: 'jwt-1', expires_at: 2_000_000_000 };

/** 一段 1 秒的 16k WAV(静音)。 */
function wav(): Blob {
  const samples = 16000;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i += 1) v.setUint8(at + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, samples * 2, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * 在外面的那一整套:假房间里坐着一台「照工人规矩办事」的假电脑。
 * `seen` 是那台假 8791 收到的每一条(`POST /butler/item`…);手机往房里发了什么在 `link.sent` / `link.bytes`。
 */
function outside(options: { now?: () => number } = {}) {
  const link = createFakeLink();
  const rules = workerWhitelist();
  const seen: { method: string; path: string; body: unknown }[] = [];
  const routes: Record<string, (body: unknown) => { status: number; body: unknown }> = {
    'GET /state': () => ({ status: 200, body: { tasks: { tasks: [] } } }),
    'POST /butler/item': () => ({ status: 200, body: { id: 't-1', status: 'todo' } }),
    'POST /butler/say': () => ({ status: 200, body: { say_id: 's-1', items: [], say: { screen: '记下了。', spoken: '记下了。' } } }),
    'POST /onboarding/say': () => ({ status: 200, body: { ok: true, session_id: 's-1' } }),
    'POST /approvals/answer': () => ({ status: 200, body: { ok: true } }),
    'POST /questions/answer': () => ({ status: 200, body: { ok: true } }),
    'POST /task/move': () => ({ status: 200, body: { ok: true } }),
    'POST /feature/run': () => ({ status: 200, body: { ok: true, note: '交给事务官推进了' } }),
    // 手机读对话(2026-10-01):列表、完整对话、附件一块。
    'GET /sessions/history': () => ({ status: 200, body: { items: [{ agent: 'claude', session_id: 'c1', title: '统筹交接', last_at: '2026-10-01T00:00:00.000Z' }], days: 7, read_at: '2026-10-01T09:00:00.000Z' } }),
    'GET /sessions/transcript': () => ({ status: 200, body: { agent: 'claude', session_id: 'c1', entries: [{ k: 'ask', text: '看这张', attachments: [{ ref: '10~b~message.content.0', name: '图片 1.png', kind: 'image', from: 'you' }] }], before: '10', read_at: '2026-10-01T09:00:00.000Z' } }),
    'GET /sessions/attachment': () => ({ status: 200, body: { ref: '10~b~message.content.0', view: 'full', part: 0, parts: 1, mime: 'image/png', data: 'iVBORw0K' } }),
    'POST /butler/proxy/api/asr': (body) => ({ status: 200, body: { text: body instanceof Uint8Array && body.byteLength > 1000 ? '把首页的时钟调大一号' : '' } }),
  };
  const reply = (value: unknown) => { queueMicrotask(() => link.deliver(value)); };
  const to8791 = (method: string, path: string, body: unknown) => {
    seen.push({ method, path, body });
    return routes[`${method} ${path.split('?')[0]}`]?.(body) ?? { status: 404, body: { error: '没有这条路' } };
  };
  // 识别:宣告与录音谁先到都行(与工人的信箱同一个规矩),对上了才交给 8791。
  const announced = new Set<string>();
  const audio = new Map<string, Uint8Array>();
  const tryAsr = (id: string) => {
    const bytes = audio.get(id);
    if (!announced.has(id) || bytes === undefined) return;
    announced.delete(id); audio.delete(id);
    const done = to8791('POST', '/butler/proxy/api/asr', bytes);
    reply({ id, type: 'http', status: done.status, body: done.body });
  };

  const sendText = link.sendText.bind(link);
  link.sendText = async (text, topic, to) => {
    await sendText(text, topic, to);
    const msg = JSON.parse(text) as { id: string; type: string; method?: string; path?: string; body?: unknown; offer?: string };
    if (msg.type === 'http') {
      const path = msg.path ?? '';
      // 工人的第一道门:白名单(真的那一份)。不在里头一律 403,和工人说的同一句。
      if (!workerAllows(msg.method ?? '', path.split('?')[0] ?? '', rules)) {
        reply({ id: msg.id, type: 'http', status: 403, body: { error: `${msg.method} ${path} 不在房间代理的白名单里` } });
        return;
      }
      const done = to8791(msg.method ?? '', path, msg.body);
      reply({ id: msg.id, type: 'http', status: done.status, body: done.body });
      return;
    }
    if (msg.type === 'asr') { announced.add(msg.id); tryAsr(msg.id); return; }
    if (msg.type === 'file_pull') {
      reply({ id: msg.id, type: 'file_pull', ok: true, name: '产品说明.md', bytes: 9 });
      queueMicrotask(() => link.deliverFile('产品说明.md', '# 产品说明'));
      return;
    }
    reply({ id: msg.id, type: 'error', error: `不认识这种请求:${msg.type}` });
  };
  const sendBytes = link.sendBytes!.bind(link);
  link.sendBytes = async (data, topic, to, options = {}) => {
    await sendBytes(data, topic, to, options);
    const id = options.attributes?.[WBCH_ASR_ID_ATTRIBUTE];
    if (topic === WBCH_ASR_TOPIC && to === WBCH_WORKER_IDENTITY && id !== undefined) { audio.set(id, data); tryAsr(id); }
  };

  let directCalls = 0;
  const direct: ApiClient = {
    baseUrl: 'http://192.168.1.9:8791',
    async json() { directCalls += 1; return LTE_ONLY; },
    async blob() { directCalls += 1; return LTE_ONLY; },
    async download() { directCalls += 1; return LTE_ONLY; },
  };
  const channel = createWbchChannel({
    direct,
    store: createWbchCredentialStore(memoryStore({ [WBCH_CREDENTIAL_KEY]: JSON.stringify(CREDENTIAL) })),
    onUnauthorized: () => {},
    link,
    workerGraceMs: 10,
  });
  const client = createWbchRoutedClient({ direct, remote: () => channel.remote(), directProbeMs: 20, ...(options.now === undefined ? {} : { now: options.now }) });
  const session = {
    client,
    direct,
    channel,
    voice: createVoiceApi(client),
    feed: { refresh: async () => {}, get: () => ({ state: {}, connected: true }), subscribe: () => () => {}, stop: () => {} },
  } as unknown as Session;
  return { link, seen, session, client, channel, directCalls: () => directCalls };
}

describe('在外面(只有 LTE):核心几件都走得通', () => {
  it('发消息:一句话建成一条事项(经房间,直连只试了那一下)', async () => {
    const world = outside();
    const { result } = renderHook(() => useSendItem(world.session));
    await expect(result.current.send('明天九点提醒我开会')).resolves.toEqual({ ok: true });
    expect(world.seen).toEqual([{ method: 'POST', path: '/butler/say', body: expect.objectContaining({ text: '明天九点提醒我开会' }) }]);
    expect(world.client.mode()).toBe('remote');
  });

  it('答提问:引导里她问一句、他打字答', async () => {
    const world = outside();
    await expect(createOnboardingApi(world.client).say('我在做自媒体运营')).resolves.toMatchObject({ ok: true });
    expect(world.seen.map((one) => `${one.method} ${one.path}`)).toEqual(['POST /onboarding/say']);
  });

  it('答提问:「等你确认」里事务官问的那一句(卡 M)在外面答得上', async () => {
    const world = outside();
    await expect(answerQuestion(world.session, 'q-1', [{ question: '先做哪一个?', answer: '先做导出 PDF' }] as never)).resolves.toBeUndefined();
    expect(world.seen.map((one) => `${one.method} ${one.path}`)).toEqual(['POST /questions/answer']);
  });

  it('白名单不放的(以后哪一条又漏了):在外面说一句兜底的人话,不露「白名单」原话,也不假装办成了', async () => {
    const world = outside();
    const said = await world.client.json('/some/new/route', { method: 'POST', body: {} });
    expect(said).toEqual({ ok: false, status: 403, kind: 'unavailable', error: WBCH_BLOB_UNSUPPORTED_TEXT });
    expect(world.seen).toEqual([]);
  });

  it('批准:「先问我」那一步点允许;座机页那颗「批准」(挪一格)', async () => {
    const world = outside();
    await expect(answerApproval(world.session, 'ap-1', true)).resolves.toBeUndefined();
    await expect(world.client.json('/task/move', { method: 'POST', body: { id: 't-1', status: 'done' } })).resolves.toMatchObject({ ok: true });
    expect(world.seen.map((one) => `${one.method} ${one.path}`)).toEqual(['POST /approvals/answer', 'POST /task/move']);
  });

  it('派活:点名交给某一家(输入框选了 Kimi);需求卡上「让事务官推进这一步」', async () => {
    const world = outside();
    const { result } = renderHook(() => useSendItem(world.session));
    const body = itemBody({ text: '[派活测试] 让 Kimi 用一句话回答:一年有几个季节?', agent: { family: 'kimi' }, attachments: [], refs: [] } as never);
    const { text, ...extra } = body as { text: string };
    await expect(result.current.send(text, extra)).resolves.toEqual({ ok: true });
    await expect(createFeatureApi(world.client).run('f-1', '先出方案')).resolves.toMatchObject({ ok: true });
    expect(world.seen[0]?.body).toMatchObject({ assignee: 'kimi' });
    expect(world.seen.map((one) => `${one.method} ${one.path}`)).toEqual(['POST /butler/item', 'POST /feature/run']);
  });

  it('识别:按住说完那段录音经 wb.asr 只交给工人,电脑上的识别回字', async () => {
    const world = outside();
    await expect(world.session.voice.asr(wav())).resolves.toEqual({ ok: true, text: '把首页的时钟调大一号' });
    expect(world.link.bytes.map((one) => [one.topic, one.to])).toEqual([[WBCH_ASR_TOPIC, WBCH_WORKER_IDENTITY]]);
    expect(world.seen.map((one) => `${one.method} ${one.path}`)).toEqual(['POST /butler/proxy/api/asr']);
    expect(world.client.mode()).toBe('remote');
  });

  it('取文件:让电脑经房间推过来,字节从 wb.file 到', async () => {
    const world = outside();
    const files: string[] = [];
    world.channel.onFile((file) => { files.push(`${file.name} ${new TextDecoder().decode(file.bytes)}`); });
    world.client.subscribe(() => {});
    await world.client.json('/state');
    const outcome = await pullFileOffer(
      { offer: 'offer-1', name: '产品说明.md' } as never,
      { mode: () => world.client.mode(), direct: world.session.direct, pullViaRoom: (offer) => world.channel.pullOffer!(offer) },
    );
    expect(outcome).toEqual({ via: 'room', ok: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(files).toEqual(['产品说明.md # 产品说明']);
    await world.channel.releasePull?.();
  });

  it('读对话:「最近的对话」、往上翻的完整对话、对话里的图(一块一块要)在外面都走得通', async () => {
    const out = outside();
    const history = await loadHistory(out.client);
    expect(history.ok && history.view.items.map((one) => one.title)).toEqual(['统筹交接']);
    /*
     * 固定入口那一档(2026-10-03,卡「手机各家最近会话固定入口」)**也要在外面走得通**:
     * 房间工人的白名单按 path 比、query 原样转发(channel-worker/src/rpc.ts splitPath),
     * 所以多一个参数不用动工人 —— 这一条就是钉住它。
     */
    const grouped = await loadHistory(out.client, { perFamily: SESSION_HISTORY_PER_FAMILY });
    expect(grouped.ok).toBe(true);
    expect(out.seen[out.seen.length - 1]?.path).toBe(`/sessions/history?per_family=${SESSION_HISTORY_PER_FAMILY}`);
    const transcript = await out.client.json<{ entries: unknown[]; before?: string }>('/sessions/transcript?agent=claude&id=c1&before=&from=');
    expect(transcript.ok && transcript.data?.before).toBe('10');
    const full = await attachmentFull(out.client, { agent: 'claude', sessionId: 'c1', ref: '10~b~message.content.0' }, 1, 'image/png');
    expect(full.ok && full.value.size).toBe(6);
    expect(out.seen.map((one) => one.path.split('?')[0])).toEqual(['/sessions/history', '/sessions/history', '/sessions/transcript', '/sessions/attachment']);
    expect(out.seen[3]?.path).toContain('view=full');
  });

  it('只在局域网的那几条:在外面当场说表里那一句(不露白名单),一条都不往房间里发', async () => {
    const world = outside();
    await world.client.json('/state');
    const before = world.link.sent.length;
    const result = await world.client.json('/feed/run', { method: 'POST' });
    expect(result).toEqual({ ok: false, status: 0, kind: 'unavailable', error: lanOnlyReason('POST', '/feed/run') });
    expect(world.link.sent.length).toBe(before);
  });

  it('在外面待了半分钟以上:按住说话不先去试家里的地址(那一下在 LTE 上要挂几十秒),直接走房间', async () => {
    let clock = 1_000;
    const world = outside({ now: () => clock });
    await world.client.json('/state');
    clock += 31_000;
    const tried = world.directCalls();
    await expect(world.session.voice.asr(wav())).resolves.toMatchObject({ ok: true });
    expect(world.directCalls()).toBe(tried);
    // 回头探直连的是下一条 GET(首页每 3 秒一条 /state),不是这一段录音。
    await world.client.json('/state');
    expect(world.directCalls()).toBe(tried + 1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  asr,
  chatStream,
  createSession,
  hotwords,
  resolvePack,
  tts,
  uploadSaveState,
} from './strategistClient.ts';

const EP = { baseUrl: 'http://127.0.0.1:8080', deviceToken: 'tok' };

/** 把若干 SSE 文本片段拼成一个可读流 Response（片段边界可以切在帧中间，用来验粘包处理）。 */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 跑一轮 chatStream，收集事件顺序与拼出来的文本。 */
function runChat(
  req: Parameters<typeof chatStream>[1],
  fetchImpl: typeof fetch,
): Promise<{ seen: string[]; text: string; errCode: string | null }> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    let text = '';
    let errCode: string | null = null;
    chatStream(
      EP,
      req,
      {
        onMeta: () => seen.push('meta'),
        onDelta: (t) => {
          seen.push('delta');
          text += t;
        },
        onAction: () => seen.push('action'),
        onSources: () => seen.push('sources'),
        onDone: () => {
          seen.push('done');
          resolve({ seen, text, errCode });
        },
        onError: (c) => {
          seen.push('error');
          errCode = c;
          resolve({ seen, text, errCode });
        },
      },
      { fetchImpl },
    );
  });
}

describe('resolvePack', () => {
  it('带 X-Device-Token 并把 rom 文件名发出去', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ matched: true, pack_id: 'konghua', game_title: '空之花神' }), {
        status: 200,
      }),
    );
    const r = await resolvePack(EP, '口袋妖怪改版 空之花神.gba', { fetchImpl });

    expect(r.matched).toBe(true);
    expect(r.pack_id).toBe('konghua');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/v1/packs/resolve');
    expect((init.headers as Record<string, string>)['X-Device-Token']).toBe('tok');
    expect(JSON.parse(init.body as string).rom_filename).toBe('口袋妖怪改版 空之花神.gba');
  });

  it('未命中时把 candidates 原样带回来（前端要拿它挑最高分）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ matched: false, candidates: [{ pack_id: 'a', game_title: 'A', score: 0.7 }] }),
        { status: 200 },
      ),
    );
    const r = await resolvePack(EP, 'x.gba', { fetchImpl });

    expect(r.matched).toBe(false);
    expect(r.candidates?.[0].pack_id).toBe('a');
  });
});

describe('createSession', () => {
  it('返回 session_id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ session_id: 'sid-1' }), { status: 200 }));

    await expect(
      createSession(EP, { deviceId: 'd', packId: 'konghua', romFilename: 'x.gba' }, { fetchImpl }),
    ).resolves.toBe('sid-1');
  });
});

describe('uploadSaveState', () => {
  it('把存档发到会话的 save-state 端点，带上写入时间', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ applied: true, player_state: { badges: [1] } }), { status: 200 }),
      );

    const r = await uploadSaveState(EP, 'sid-1', { saveBase64: 'QUJD', savedAtMs: 1_700_000_000_000 }, { fetchImpl });

    expect(r.applied).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${EP.baseUrl}/v1/sessions/sid-1/save-state`);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toEqual({
      save_base64: 'QUJD',
      saved_at_ms: 1_700_000_000_000,
    });
    // 设备鉴权走 X-Device-Token（不是 Bearer——真机上栽过一次）
    expect(fetchImpl.mock.calls[0][1].headers['X-Device-Token']).toBe(EP.deviceToken);
  });

  it('包里没有存档解读表时不是错误，只是 applied=false', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ applied: false, reason: '没有 progress.json' }), { status: 200 }));

    const r = await uploadSaveState(EP, 'sid-1', { saveBase64: 'QUJD' }, { fetchImpl });
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('progress.json');
  });

  it('服务端拒绝时抛 HTTP_ 码，调用方据此静默降级', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad save', { status: 400 }));
    await expect(
      uploadSaveState(EP, 'sid-1', { saveBase64: 'zzz' }, { fetchImpl }),
    ).rejects.toThrow('HTTP_400');
  });
});

describe('chatStream', () => {
  it('按顺序分发 meta/delta/action/sources/done', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        'event: meta\ndata: {"intent":"walkthrough","confidence":"high","fallback_used":false}\n\n',
        'event: delta\ndata: {"text":"你现在"}\n\n',
        'event: delta\ndata: {"text":"在道馆里"}\n\n',
        'event: action\ndata: {"emotion":"happy"}\n\n',
        'event: sources\ndata: {"items":[{"type":"doc","chapter":"第一章"}]}\n\n',
        'event: done\ndata: {"latency_ms":1830}\n\n',
      ]),
    );

    const { seen, text } = await runChat({ sessionId: 'sid', message: '' }, fetchImpl);

    expect(seen).toEqual(['meta', 'delta', 'delta', 'action', 'sources', 'done']);
    expect(text).toBe('你现在在道馆里');
  });

  it('一帧被切成两个 chunk 也能拼回来（粘包）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse(['event: delta\ndata: {"te', 'xt":"半截"}\n\n', 'event: done\ndata: {}\n\n']));

    const { text } = await runChat({ sessionId: 'sid', message: '' }, fetchImpl);

    expect(text).toBe('半截');
  });

  it('quick_action=stuck 与截图一起发出去', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(['event: done\ndata: {}\n\n']));

    await runChat(
      { sessionId: 'sid', message: '', quickAction: 'stuck', screenshotBase64: 'AAA' },
      fetchImpl,
    );

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.quick_action).toBe('stuck');
    expect(body.screenshot_base64).toBe('AAA');
  });

  it('普通提问时 quick_action/screenshot 是 null，不发空串', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(['event: done\ndata: {}\n\n']));

    await runChat({ sessionId: 'sid', message: '拉鲁拉丝在哪抓' }, fetchImpl);

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.quick_action).toBeNull();
    expect(body.screenshot_base64).toBeNull();
  });

  it('HTTP 非 2xx 走 onError，不静默', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));

    const { errCode } = await runChat({ sessionId: 'sid', message: '' }, fetchImpl);

    expect(errCode).toBe('HTTP_401');
  });

  it('服务端 error 事件透传 code', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse(['event: error\ndata: {"code":"UPSTREAM_TIMEOUT","message":"慢"}\n\n']));

    const { errCode } = await runChat({ sessionId: 'sid', message: '' }, fetchImpl);

    expect(errCode).toBe('UPSTREAM_TIMEOUT');
  });

  it('流断了却没收到 done：报 STREAM_TRUNCATED，不能让 UI 永远停在「想想…」', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(['event: delta\ndata: {"text":"半句"}\n\n']));

    const { errCode, text } = await runChat({ sessionId: 'sid', message: '' }, fetchImpl);

    expect(text).toBe('半句');
    expect(errCode).toBe('STREAM_TRUNCATED');
  });

  it('abort 之后不再回调（用户再点一次角色 = 打断上一轮）', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"开头"}\n\n'));
        // 不 close：流一直挂着，等 abort
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));

    const calls: string[] = [];
    const h = chatStream(
      EP,
      { sessionId: 'sid', message: '' },
      {
        onMeta: () => calls.push('meta'),
        onDelta: () => calls.push('delta'),
        onAction: () => calls.push('action'),
        onSources: () => calls.push('sources'),
        onDone: () => calls.push('done'),
        onError: () => calls.push('error'),
      },
      { fetchImpl },
    );

    await new Promise((r) => setTimeout(r, 20));
    h.abort();
    await new Promise((r) => setTimeout(r, 20));

    expect(cancelled).toBe(true);
    // abort 是用户主动打断，不该冒出 error 回调去污染 UI
    expect(calls).not.toContain('error');
    expect(calls).not.toContain('done');
  });
});

describe('asr / tts（走 Aiboo 后台，不是军师服务端）', () => {
  const AIBOO = { baseUrl: 'http://your-aiboo-host:3456', token: 'jwt', deviceId: 'dev-1' };
  const spy = vi.fn();
  beforeEach(() => spy.mockReset());

  it('asr 打 Aiboo 的 /ai/asr，带 Bearer 与设备头', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: '这里怎么过' }), { status: 200 }));

    const t = await asr(AIBOO, { pcmBase64: 'AAAA', sampleRate: 16000 }, { fetchImpl });

    expect(t).toBe('这里怎么过');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://your-aiboo-host:3456/ai/asr');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer jwt');
    expect(h['X-Device-Id']).toBe('dev-1'); // 内测模式的设备绑定校验要这个头
  });

  // ★真机回归：掌机是启动器、没有用户 JWT，token 是设备共享密钥。服务端
  // deviceOrUserAuth **只从 X-Device-Token 读它**，只发 Bearer 会被当成 JWT 去验
  // → 每个语音请求 401，真机上表现为「token 不对」。两个头都发才两种凭证都能用。
  it.each([
    ['asr', () => asr(AIBOO, { pcmBase64: 'A', sampleRate: 16000 }, { fetchImpl: spy })],
    ['tts', () => tts(AIBOO, { text: '探针' }, { fetchImpl: spy })],
  ])('%s 必须同时带 X-Device-Token（只发 Bearer 服务端认不出设备）', async (_n, call) => {
    spy.mockResolvedValue(
      new Response(JSON.stringify({ text: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await call().catch(() => {}); // tts 解析音频会失败，这里只关心请求头
    const h = spy.mock.calls[0][1].headers as Record<string, string>;
    expect(h['X-Device-Token']).toBe('jwt');
    expect(h.Authorization).toBe('Bearer jwt');
  });

  it('tts 带 avatarId —— 后端据它查音色绑定，角色说话才是她自己的声音', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const clip = await tts(AIBOO, { text: '你在道馆里。', avatarId: 'shuangsheng' }, { fetchImpl });

    expect(clip.mime).toBe('audio/mpeg');
    expect(atob(clip.audioBase64)).toBe('\x01\x02\x03');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body).toEqual({ text: '你在道馆里。', avatarId: 'shuangsheng' });
  });

  it('tts 返回的是音频字节流不是 JSON，几百 KB 也不能爆栈', async () => {
    const big = new Uint8Array(300_000).fill(65);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(big, { status: 200, headers: { 'content-type': 'audio/wav' } }));

    const clip = await tts(AIBOO, { text: '长音频' }, { fetchImpl });

    expect(clip.audioBase64.length).toBeGreaterThan(100_000);
  });

  it('语音端点失败带 HTTP_ 码（前端要据此降级成只显示文字）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 401 }));
    await expect(asr(AIBOO, { pcmBase64: 'A', sampleRate: 16000 }, { fetchImpl })).rejects.toThrow('HTTP_401');
  });
});

describe('hotwords', () => {
  it('把军师服务端选好的词带进 /ai/asr 的请求体', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: '鬼斯通怎么进化' }),
    });
    await asr(
      { baseUrl: 'https://aiboo', token: 't' },
      { pcmBase64: 'AAA', sampleRate: 16000, hotwords: ['鬼斯通', '佩雷市'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.hotwords).toEqual(['鬼斯通', '佩雷市']);
  });

  it('没有热词时不发这个字段（纯增量参数，别给后端塞空数组）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'x' }) });
    await asr(
      { baseUrl: 'https://aiboo', token: 't' },
      { pcmBase64: 'AAA', sampleRate: 16000, hotwords: [] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('hotwords');
  });

  it('取热词失败不该让语音这条挂掉——返回空数组', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('网络断了'));
    const got = await hotwords(
      { baseUrl: 'https://js', deviceToken: 'd' },
      'sid',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(got).toEqual([]);
  });

  it('服务端返回非数组时也不炸', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const got = await hotwords(
      { baseUrl: 'https://js', deviceToken: 'd' },
      'sid',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(got).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../src/api/client';
import { createWbchRoutedClient } from '../src/channel/routedClient';

function stub(name: string, answers: ApiResult<unknown>[]): ApiClient & { calls: string[] } {
  const calls: string[] = [];
  let at = 0;
  const next = (path: string): ApiResult<unknown> => {
    calls.push(`${name} ${path}`);
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    if (answer === undefined) throw new Error('用例没给答案');
    return answer;
  };
  return {
    calls,
    baseUrl: `http://${name}`,
    async json(path) { return next(path) as ApiResult<never>; },
    async blob(path) { return next(path) as ApiResult<Blob>; },
  };
}

const OK: ApiResult<unknown> = { ok: true, status: 200, data: { 好: true } };
const OFFLINE: ApiResult<unknown> = { ok: false, status: 0, kind: 'network', error: '连不上工作台:确认手机和 Mac 在同一局域网' };
const NOT_FOUND: ApiResult<unknown> = { ok: false, status: 404, kind: 'http', error: '没有这个事项' };

describe('两条路怎么选', () => {
  it('直连通就走直连,压根不碰房间', async () => {
    const direct = stub('direct', [OK]);
    const remote = vi.fn();
    const client = createWbchRoutedClient({ direct, remote: remote as never });
    await expect(client.json('/state')).resolves.toEqual(OK);
    expect(client.mode()).toBe('direct');
    expect(remote).not.toHaveBeenCalled();
  });

  // 「工作台答了 404」和「连不上」是两回事:换条路问 404 还是 404,切过去只是白等一轮。
  it('直连回了 404 就用它,不切房间', async () => {
    const direct = stub('direct', [NOT_FOUND]);
    const remote = vi.fn();
    const client = createWbchRoutedClient({ direct, remote: remote as never });
    await expect(client.json('/butler/item/x')).resolves.toEqual(NOT_FOUND);
    expect(remote).not.toHaveBeenCalled();
    expect(client.mode()).toBe('direct');
  });

  it('直连连不上就自动切房间,状态变「远程」', async () => {
    const direct = stub('direct', [OFFLINE]);
    const room = stub('room', [OK]);
    const seen: string[] = [];
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: room }) });
    client.subscribe((m) => seen.push(m));
    await expect(client.json('/state')).resolves.toEqual(OK);
    expect(client.mode()).toBe('remote');
    expect(seen).toEqual(['remote']);
    expect(room.calls).toEqual(['room /state']);
  });

  it('切过去之后不再每条都试直连(直连那边只被打了一次)', async () => {
    const direct = stub('direct', [OFFLINE]);
    const room = stub('room', [OK]);
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: room }), recheckMs: 30000, now: () => 1000 });
    await client.json('/state');
    await client.json('/state');
    await client.json('/state');
    expect(direct.calls).toHaveLength(1);
    expect(room.calls).toHaveLength(3);
  });

  it('待够了 recheckMs 就拿下一条请求回头试直连,通了切回来', async () => {
    const direct = stub('direct', [OFFLINE, OK]);
    const room = stub('room', [OK]);
    let clock = 1000;
    const seen: string[] = [];
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: room }), recheckMs: 30000, now: () => clock });
    client.subscribe((m) => seen.push(m));
    await client.json('/state');
    expect(client.mode()).toBe('remote');
    clock += 30001;
    await expect(client.json('/state')).resolves.toEqual(OK);
    expect(client.mode()).toBe('direct');
    expect(seen).toEqual(['remote', 'direct']);
  });

  it('两条都不通 = 未连接;说的是直连那句话(它最具体)', async () => {
    const direct = stub('direct', [OFFLINE]);
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: false, error: '还没有房间凭证' }) });
    await expect(client.json('/state')).resolves.toEqual(OFFLINE);
    expect(client.mode()).toBe('offline');
  });

  it('房间进得去但工人不答,也是未连接', async () => {
    const direct = stub('direct', [OFFLINE]);
    const room = stub('room', [{ ok: false, status: 0, kind: 'network', error: '没人答' }]);
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: room }) });
    const result = await client.json('/state');
    expect(result).toEqual(OFFLINE);
    expect(client.mode()).toBe('offline');
  });

  it('blob 也走同一套选路', async () => {
    const direct = stub('direct', [OFFLINE]);
    const room = stub('room', [{ ok: false, status: 0, kind: 'unavailable', error: '远程模式下取不到' }]);
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: room }) });
    const result = await client.blob('/butler/proxy/api/tts');
    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(room.calls).toEqual(['room /butler/proxy/api/tts']);
  });

  it('baseUrl 还是直连那个(设置页上显示的是工作台地址)', () => {
    const direct = stub('direct', [OK]);
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: false, error: 'x' }) });
    expect(client.baseUrl).toBe('http://direct');
  });
});

describe('回到局域网就把房间放掉(按需进房,不常驻)', () => {
  it('切回直连那一下叫一次 onBackToDirect,不是每条请求都叫', async () => {
    const direct = stub('direct', [OFFLINE, OK]);
    const room = stub('room', [OK]);
    let clock = 1000;
    const released: number[] = [];
    const client = createWbchRoutedClient({
      direct,
      remote: async () => ({ ok: true, client: room }),
      onBackToDirect: () => released.push(clock),
      recheckMs: 30000,
      now: () => clock,
    });
    await client.json('/state');          // 直连挂 → 远程
    expect(released).toEqual([]);
    clock += 30001;
    await client.json('/state');          // 回到直连 → 放房间
    expect(released).toHaveLength(1);
    await client.json('/state');          // 还在直连 → 不再叫
    expect(released).toHaveLength(1);
  });

  it('一直是直连(从没进过房)就一次都不叫', async () => {
    const direct = stub('direct', [OK]);
    const released: number[] = [];
    const client = createWbchRoutedClient({
      direct,
      remote: async () => ({ ok: false, error: 'x' }),
      onBackToDirect: () => released.push(1),
    });
    await client.json('/state');
    await client.json('/state');
    expect(released).toEqual([]);
  });
});

/**
 * 出了局域网,POST 不当探子(2026-09-25,卡 S「手机在哪都能用」)。
 * 探直连那一下在外面常常挂到系统超时(几十秒)才失败;GET 到点就掐,POST 不掐(怕办两遍)——
 * 以前远程模式下每 30 秒轮到的那条 POST(按住说话、发一句话)就这么干等。
 */
describe('只拿 GET 当探子', () => {
  it('远程模式下待够了 recheckMs:POST 直接走房间,不碰直连;下一条 GET 才回头探', async () => {
    const direct = stub('direct', [OFFLINE, OK]);
    const room = stub('room', [OK]);
    let clock = 1000;
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: room }), recheckMs: 30000, now: () => clock });
    await client.json('/state');
    expect(client.mode()).toBe('remote');
    clock += 30001;
    await expect(client.json('/butler/proxy/api/asr', { method: 'POST', body: new Blob(['x']), idempotent: true })).resolves.toEqual(OK);
    expect(direct.calls).toEqual(['direct /state']);
    expect(room.calls).toEqual(['room /state', 'room /butler/proxy/api/asr']);
    await client.json('/state');
    expect(direct.calls).toEqual(['direct /state', 'direct /state']);
    expect(client.mode()).toBe('direct');
  });

  it('直连还没确认时:标了 idempotent 的 POST(识别)到点就掐断改走房间;普通 POST 照旧等(怕办两遍)', async () => {
    const hanging: ApiClient = {
      baseUrl: 'http://direct',
      json: (_path, options) => new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(OFFLINE as ApiResult<never>));
      }),
      blob: async () => OFFLINE as ApiResult<Blob>,
    };
    const room = stub('room', [OK]);
    const asr = createWbchRoutedClient({ direct: hanging, remote: async () => ({ ok: true, client: room }), directProbeMs: 20 });
    await expect(asr.json('/butler/proxy/api/asr', { method: 'POST', idempotent: true })).resolves.toEqual(OK);
    expect(asr.mode()).toBe('remote');

    const plain = createWbchRoutedClient({ direct: hanging, remote: async () => ({ ok: true, client: room }), directProbeMs: 20 });
    const raced = await Promise.race([plain.json('/butler/item', { method: 'POST', body: { text: 'x' } }), new Promise((done) => setTimeout(() => done('还在等'), 80))]);
    expect(raced).toBe('还在等');
  });
});

/**
 * 刚出家门那一下(2026-09-25,卡 S):在家直连通过之后,手机从 Wi-Fi 切到移动网络。以前「直连通过过」一直算数,
 * 首页那条 GET 与按住说话都按「不掐」去打家里的地址,在 LTE 上挂到系统超时(几十秒)才转房间。
 * 现在网络一变,家里的地址回到「没确认」:GET 与识别最多等 directProbeMs 就改走房间。
 */
describe('网络变了:家里的地址回到「没确认」', () => {
  it('在家通过之后切了网:下一条 GET 到点就掐断、改走房间;识别(idempotent)也一样', async () => {
    let online = true;
    const direct: ApiClient = {
      baseUrl: 'http://direct',
      json: (_path, options) => (online
        ? Promise.resolve(OK as ApiResult<never>)
        : new Promise((resolve) => { options?.signal?.addEventListener('abort', () => resolve(OFFLINE as ApiResult<never>)); })),
      blob: async () => OFFLINE as ApiResult<Blob>,
    };
    const room = stub('room', [OK]);
    let fire: () => void = () => {};
    const client = createWbchRoutedClient({
      direct,
      remote: async () => ({ ok: true, client: room }),
      directProbeMs: 20,
      networkChanges: (listener) => { fire = listener; return () => {}; },
    });
    await expect(client.json('/state')).resolves.toEqual(OK);
    expect(client.mode()).toBe('direct');
    // 出门:Wi-Fi 断了,系统发了「网络变了」。
    online = false;
    fire();
    await expect(client.json('/state')).resolves.toEqual(OK);
    expect(client.mode()).toBe('remote');
    expect(room.calls).toEqual(['room /state']);
  });

  it('没接网络变化(老调用方):在家通过之后照旧不掐', async () => {
    let online = true;
    const direct: ApiClient = {
      baseUrl: 'http://direct',
      json: () => (online ? Promise.resolve(OK as ApiResult<never>) : new Promise(() => {})),
      blob: async () => OFFLINE as ApiResult<Blob>,
    };
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: stub('room', [OK]) }), directProbeMs: 20 });
    await client.json('/state');
    online = false;
    const raced = await Promise.race([client.json('/state'), new Promise((done) => setTimeout(() => done('还在等'), 80))]);
    expect(raced).toBe('还在等');
  });
});

// ———————————————————————— 2026-09-30:直连慢就同时走房间,谁先通用谁 ————————————————————————
// 维护者:「手机一上来先显示电脑不在线,每次都以为坏了」。在外面时,以前要白等直连探测 5 秒才去房间。
// 现在直连 raceAfterMs(缺省 1.2 秒)还没答,就同时开始走房间;在家直连零点几秒就回来,房间一下都不碰(省电,老规矩不变)。
describe('直连慢就同时走房间', () => {
  function slow(result: ApiResult<unknown>, ms: number): ApiClient & { calls: string[] } {
    const calls: string[] = [];
    const answer = () => new Promise<ApiResult<never>>((resolve) => { setTimeout(() => resolve(result as ApiResult<never>), ms); });
    return { calls, baseUrl: 'http://slow', async json(path) { calls.push(path); return answer(); }, async blob(path) { calls.push(path); return answer() as never; } };
  }

  it('★在外面:直连要 5 秒才失败,房间 2 秒就答了 → 不等直连,用房间的', async () => {
    vi.useFakeTimers();
    const direct = slow(OFFLINE, 5000);
    const room = stub('room', [OK]);
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: room }), raceAfterMs: 1200 });
    let done: ApiResult<unknown> | undefined;
    void client.json('/state').then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(1300);
    expect(done).toEqual(OK);
    expect(client.mode()).toBe('remote');
    vi.useRealTimers();
  });

  it('在家:直连 1.2 秒以内就答了 → 房间一下都不碰', async () => {
    vi.useFakeTimers();
    const direct = slow(OK, 300);
    const remote = vi.fn();
    const client = createWbchRoutedClient({ direct, remote: remote as never, raceAfterMs: 1200 });
    const got = client.json('/state');
    await vi.advanceTimersByTimeAsync(400);
    await expect(got).resolves.toEqual(OK);
    expect(remote).not.toHaveBeenCalled();
    expect(client.mode()).toBe('direct');
    vi.useRealTimers();
  });

  it('直连慢但先答上了 → 用直连,顺手把已经进了的房间放掉', async () => {
    vi.useFakeTimers();
    const direct = slow(OK, 2000);
    const room: ApiClient = { baseUrl: 'room', json: () => new Promise((resolve) => { setTimeout(() => resolve(OK as never), 5000); }), blob: async () => OK as never };
    const back = vi.fn();
    const client = createWbchRoutedClient({ direct, remote: async () => ({ ok: true, client: room }), raceAfterMs: 1200, onBackToDirect: back });
    const got = client.json('/state');
    await vi.advanceTimersByTimeAsync(2100);
    await expect(got).resolves.toEqual(OK);
    expect(client.mode()).toBe('direct');
    await vi.advanceTimersByTimeAsync(10);
    expect(back).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('POST 不抢跑(换条路再发一遍可能重复办事)', async () => {
    vi.useFakeTimers();
    const direct = slow(OK, 2000);
    const remote = vi.fn();
    const client = createWbchRoutedClient({ direct, remote: remote as never, raceAfterMs: 1200 });
    const got = client.json('/butler/item', { method: 'POST', body: {} });
    await vi.advanceTimersByTimeAsync(2100);
    await expect(got).resolves.toEqual(OK);
    expect(remote).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

/**
 * 按路线选直连(2026-10-21,局域网 M4):路线驱动说了「此刻直连哪个地址 / 不直连」,routedClient 照它走,
 * 不再自己拿局域网地址去碰运气(4G 上那一下常常要挂到系统超时)。
 */
describe('按路线选直连(局域网 M4)', () => {
  it('驱动说不在家(没有直连地址):直接走房间,直连一下都不碰', async () => {
    const direct = stub('direct', [OK]);
    const room = stub('room', [OK]);
    const client = createWbchRoutedClient({
      direct,
      remote: async () => ({ ok: true, client: room }),
      directBase: () => ({ url: null, settled: true }),
    });
    await expect(client.json('/state')).resolves.toEqual(OK);
    expect(direct.calls).toEqual([]);
    expect(room.calls).toEqual(['room /state']);
    expect(client.mode()).toBe('remote');
  });

  it('驱动说在家:直连;房间那条一下都不碰', async () => {
    const direct = stub('direct', [OK]);
    const remote = vi.fn();
    const client = createWbchRoutedClient({ direct, remote: remote as never, directBase: () => ({ url: 'http://10.0.0.5:8791', settled: true }) });
    await expect(client.json('/state')).resolves.toEqual(OK);
    expect(remote).not.toHaveBeenCalled();
    expect(client.mode()).toBe('direct');
  });

  it('第一次判定还没落地:先等它(最多一小会儿),再按它说的走', async () => {
    const direct = stub('direct', [OK]);
    const room = stub('room', [OK]);
    let base: { url: string | null; settled: boolean } = { url: null, settled: false };
    let release!: () => void;
    const settled = new Promise<void>((r) => { release = r; });
    const client = createWbchRoutedClient({
      direct,
      remote: async () => ({ ok: true, client: room }),
      directBase: () => base,
      settled: () => settled,
    });
    const pending = client.json('/state');
    await Promise.resolve();
    expect(direct.calls).toEqual([]);
    base = { url: 'http://10.0.0.5:8791', settled: true };
    release();
    await expect(pending).resolves.toEqual(OK);
    expect(direct.calls).toEqual(['direct /state']);
    expect(room.calls).toEqual([]);
  });

  it('在家但直连这一下慢(1.2 秒没答):照旧同时走房间,并告诉驱动复查一次', async () => {
    vi.useFakeTimers();
    try {
      let answer!: (r: ApiResult<unknown>) => void;
      const direct: ApiClient = {
        baseUrl: 'http://10.0.0.5:8791',
        json: () => new Promise((r) => { answer = r as never; }),
        blob: async () => OFFLINE as ApiResult<Blob>,
      };
      const room = stub('room', [OK]);
      const slow = vi.fn();
      const client = createWbchRoutedClient({
        direct,
        remote: async () => ({ ok: true, client: room }),
        directBase: () => ({ url: 'http://10.0.0.5:8791', settled: true }),
        onSlowDirect: slow,
      });
      const pending = client.json('/state');
      await vi.advanceTimersByTimeAsync(1300);
      expect(slow).toHaveBeenCalledTimes(1);
      await expect(pending).resolves.toEqual(OK);
      answer(OFFLINE);
    } finally {
      vi.useRealTimers();
    }
  });
});

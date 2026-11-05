// 火山 TTS 的串行队列 + 并发超限退避重试(2026-09-20,决策记录「②补」)。
//
// 铁证(Ben 那台 `~/.dsh/logs/butler.stderr.log`,连着七条):
//   volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency
// 通道层的工人把一段回复按句切开之后是并发送来合成的 —— 四小块 = 同一瞬间四条 /api/tts。
// 工人那边已经自己排了队,但这台服务不止一个调用方,所以门要设在离火山最近的地方。
//
// 钉四件:① 真的串行;② 先到先得;③ **只对「上游忙」重试**(音色不存在重试一百次也是一样的答案);
// ④ 退避那几百毫秒里名额占着不放(放开只会让后面的人立刻再去撞一次)。
import { describe, expect, it } from 'vitest';
import { require } from './_setup.mjs';

const { createTtsQueue, isBusyError, DEFAULT_LIMIT, DEFAULT_RETRIES } = require('../server/services/ttsQueue.cjs');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('isBusyError', () => {
  it('认得出火山那几种「等一下再来会不一样」的错', () => {
    expect(isBusyError(new Error('volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency'))).toBe(true);
    expect(isBusyError(new Error('volcengine TTS HTTP 429'))).toBe(true);
    expect(isBusyError(new Error('volcengine TTS failed (code=3003)'))).toBe(true);
    expect(isBusyError(new Error('volcengine TTS failed (code=3005)'))).toBe(true);
    expect(isBusyError(new Error('45000000 quota exceeded'))).toBe(true);
  });

  it('别的一律不重试 —— 重试一百次也是一样的答案,白让人多等', () => {
    expect(isBusyError(new Error('volcengine TTS HTTP 403'))).toBe(false);
    expect(isBusyError(new Error('volcengine TTS failed (code 3050)'))).toBe(false); // 音色不存在
    expect(isBusyError(new Error('volcengine TTS: appid/accessToken missing'))).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
    expect(isBusyError(new Error(''))).toBe(false);
  });
});

describe('串行', () => {
  it('四条同时来,同一时刻只有一条在跑', async () => {
    const queue = createTtsQueue({ limit: 1 });
    let active = 0;
    let peak = 0;
    const job = async () => {
      active += 1; peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return 'ok';
    };
    await Promise.all([queue.run(job), queue.run(job), queue.run(job), queue.run(job)]);
    expect(peak).toBe(1);
    expect(queue.stats().active).toBe(0);
  });

  it('先到先得', async () => {
    const queue = createTtsQueue({ limit: 1 });
    const order = [];
    await Promise.all([1, 2, 3].map((n) => queue.run(async () => { order.push(n); await tick(); })));
    expect(order).toEqual([1, 2, 3]);
  });

  it('配成 2 就真能并到 2(闸是真的在管事)', async () => {
    const queue = createTtsQueue({ limit: 2 });
    let active = 0;
    let peak = 0;
    const job = async () => { active += 1; peak = Math.max(peak, active); await tick(); active -= 1; };
    await Promise.all([job, job, job, job].map((f) => queue.run(f)));
    expect(peak).toBe(2);
  });

  it('配了 0 / 负数 / 乱七八糟的按 1 处理,不把整台服务锁死', () => {
    expect(createTtsQueue({ limit: 0 }).limit).toBe(1);
    expect(createTtsQueue({ limit: -3 }).limit).toBe(1);
    expect(createTtsQueue({ limit: 'abc' }).limit).toBe(1);
    expect(createTtsQueue().limit).toBe(DEFAULT_LIMIT);
  });

  it('一次失败不会把后面的人永远堵住', async () => {
    const queue = createTtsQueue({ limit: 1, retries: 0 });
    await expect(queue.run(async () => { throw new Error('volcengine TTS HTTP 403'); })).rejects.toThrow('403');
    await expect(queue.run(async () => 'ok')).resolves.toBe('ok');
    expect(queue.stats().active).toBe(0);
  });
});

describe('并发超限退避重试', () => {
  it('撞上 429 就等一下再来,第二次成了就当没事发生', async () => {
    const waited = [];
    const queue = createTtsQueue({ limit: 1, retries: 2, backoffMs: [300, 800], sleep: async (ms) => { waited.push(ms); } });
    let attempts = 0;
    const got = await queue.run(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency');
      return '音频';
    });
    expect(got).toBe('音频');
    expect(attempts).toBe(2);
    expect(waited).toEqual([300]);
    expect(queue.stats().busyRetries).toBe(1);
  });

  it('重试用完了就如实抛出去(不假装成功,也不无限重试)', async () => {
    const waited = [];
    const queue = createTtsQueue({ limit: 1, retries: 2, backoffMs: [300, 800], sleep: async (ms) => { waited.push(ms); } });
    let attempts = 0;
    await expect(queue.run(async () => {
      attempts += 1;
      throw new Error('volcengine TTS HTTP 429 quota exceeded for types: concurrency');
    })).rejects.toThrow('concurrency');
    expect(attempts).toBe(3); // 一次 + 两次重试
    expect(waited).toEqual([300, 800]);
  });

  it('不是「忙」的错一次都不重试', async () => {
    const queue = createTtsQueue({ limit: 1, retries: 2, sleep: async () => {} });
    let attempts = 0;
    await expect(queue.run(async () => { attempts += 1; throw new Error('volcengine TTS failed (code 3050)'); }))
      .rejects.toThrow('3050');
    expect(attempts).toBe(1);
  });

  it('退避的那几百毫秒里名额占着不放 —— 放开只会让后面的人立刻再去撞一次', async () => {
    let releaseSleep;
    const queue = createTtsQueue({
      limit: 1,
      retries: 1,
      sleep: () => new Promise((resolve) => { releaseSleep = resolve; }),
    });
    let second = false;
    const first = queue.run(async () => { throw new Error('HTTP 429 quota exceeded for types: concurrency'); });
    const queued = queue.run(async () => { second = true; return 'ok'; });
    await tick();
    await tick();
    // 第一条正在退避等待,第二条**还没开始**。
    expect(second).toBe(false);
    releaseSleep();
    await expect(first).rejects.toThrow('429');
    await expect(queued).resolves.toBe('ok');
    expect(second).toBe(true);
  });

  it('默认重试两次', () => {
    expect(createTtsQueue().retries).toBe(DEFAULT_RETRIES);
    expect(DEFAULT_RETRIES).toBe(2);
  });
});

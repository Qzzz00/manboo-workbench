/**
 * 缓冲语跟着当前音色走(2026-09-22)。
 *
 * 卡上点名要覆盖的两件:**缓存键**(里头必须带音色名,换了音色不许命中旧的)
 * 与**兜底**(问不出音色、合不出来、8792 没跑,都还剩包里那七句)。
 *
 * 这一份里没有网络、没有 `<audio>`:合成、缓存、objectURL 三样全注入 ——
 * 和 fillerAudio.ts 一样,这个文件要能在假手机里原样跑。
 */
import { describe, expect, it, vi } from 'vitest';
/**
 * 2026-10-02:按音色对齐的那一份从 `FILLER_LINES`(整张表)换成 `FILLER_VOICE_LINES`
 * (垫场那两类)—— 应声那几声刻意不进来,理由见 src/call/ackAudio.ts 的文件头。
 * 这一组的口径一个字没改,只是「那几句」现在有了一个名字。
 */
import { FILLER_VOICE_LINES as FILLER_LINES, fillerAssetUrl } from '../src/call/fillerAudio';
import { createFillerVoiceCache, fillerCacheKey, type FillerBlobStore } from '../src/call/fillerVoiceCache';
import type { FillerTrimmer } from '../src/call/fillerTrim';

/** 一份假的缓存:记着谁读过、谁写过。 */
function memoryStore(): FillerBlobStore & { data: Map<string, Blob>; gets: string[]; puts: string[] } {
  const data = new Map<string, Blob>();
  const gets: string[] = [];
  const puts: string[] = [];
  return {
    data,
    gets,
    puts,
    async get(key) { gets.push(key); return data.get(key); },
    async put(key, blob) { puts.push(key); data.set(key, blob); },
  };
}

function blob(text: string): Blob {
  return new Blob([text], { type: 'audio/mpeg' });
}

interface Harness {
  synth: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof memoryStore>;
  urls: string[];
}

function cacheWith(options: {
  voice?: string | undefined;
  fail?: (text: string) => boolean;
  store?: FillerBlobStore | null;
  trim?: FillerTrimmer | null;
} = {}) {
  const store = options.store === undefined ? memoryStore() : options.store;
  const urls: string[] = [];
  const synth = vi.fn(async (text: string) => {
    if (options.fail?.(text) === true) throw new Error('8792 回了 503');
    return blob(`audio:${text}`);
  });
  let made = 0;
  const cache = createFillerVoiceCache({
    currentVoice: async () => options.voice,
    synthesize: synth,
    store,
    // 缺省 null:jsdom 里本来就没有 OfflineAudioContext,写明白免得读的人以为这儿在掐。
    trim: options.trim ?? null,
    objectUrl: () => { made += 1; const url = `blob:u${made}`; urls.push(url); return url; },
    revokeUrl: () => {},
  });
  return { cache, harness: { synth, store: store as ReturnType<typeof memoryStore>, urls } as Harness };
}

describe('缓存键', () => {
  it('键里带音色名,而且音色在 id 前面', () => {
    expect(fillerCacheKey('zh_female_shuangkuaisisi', 'think-1')).toBe('filler/zh_female_shuangkuaisisi/think-1');
  });

  it('★换了音色就是另一套键 —— 不许命中旧嗓子那一份', () => {
    expect(fillerCacheKey('A', 'think-1')).not.toBe(fillerCacheKey('B', 'think-1'));
  });

  it('音色名里的斜杠要编码掉(一个带斜杠的名字能把键写成另一条路径)', () => {
    expect(fillerCacheKey('a/b', 'think-1')).toBe('filler/a%2Fb/think-1');
  });

  it('★第一次进房:七句全合成并落进缓存,键上都带着这个音色', async () => {
    const { cache, harness } = cacheWith({ voice: 'V1' });
    const result = await cache.refresh();

    expect(result.voice).toBe('V1');
    expect(result.synthesized).toBe(FILLER_LINES.length);
    expect(result.bundled).toBe(0);
    expect(harness.store.puts).toEqual(FILLER_LINES.map(line => fillerCacheKey('V1', line.id)));
    // 放的是缓存里那一份,不是包里那一份。
    expect(cache.urlFor('think-1')).toMatch(/^blob:/);
  });

  it('★第二次进房(同一个音色):缓存命中,一次都不合成', async () => {
    const store = memoryStore();
    const first = cacheWith({ voice: 'V1', store });
    await first.cache.refresh();
    first.cache.dispose();

    const second = cacheWith({ voice: 'V1', store });
    const result = await second.cache.refresh();
    expect(result.cached).toBe(FILLER_LINES.length);
    expect(result.synthesized).toBe(0);
    expect(second.harness.synth).not.toHaveBeenCalled();
  });

  it('★换了音色再进房:按新键重新合成,旧键那一份原样留着(换回去时不用再合一遍)', async () => {
    const store = memoryStore();
    const old = cacheWith({ voice: 'V1', store });
    await old.cache.refresh();
    old.cache.dispose();

    const next = cacheWith({ voice: 'V2', store });
    const result = await next.cache.refresh();
    expect(result.synthesized).toBe(FILLER_LINES.length);
    expect(store.data.has(fillerCacheKey('V1', 'think-1'))).toBe(true);
    expect(store.data.has(fillerCacheKey('V2', 'think-1'))).toBe(true);
  });
});

describe('兜底:包里那七句', () => {
  it('★问不出音色(8792 没跑 / 解析不出来):一句都不合成,七句全用包里那一份', async () => {
    const { cache, harness } = cacheWith({ voice: undefined });
    const result = await cache.refresh();

    expect(result.voice).toBeUndefined();
    expect(result.bundled).toBe(FILLER_LINES.length);
    expect(harness.synth).not.toHaveBeenCalled();
    expect(cache.urlFor('think-1')).toBe(fillerAssetUrl('think-1'));
  });

  it('★一句合不出来只影响那一句:它回落到包里那一份,别的照用新嗓子', async () => {
    const { cache } = cacheWith({ voice: 'V1', fail: text => text === FILLER_LINES[0]?.text });
    const result = await cache.refresh();

    expect(result.bundled).toBe(1);
    expect(result.synthesized).toBe(FILLER_LINES.length - 1);
    expect(cache.urlFor(FILLER_LINES[0]!.id)).toBe(fillerAssetUrl(FILLER_LINES[0]!.id));
    expect(cache.urlFor(FILLER_LINES[1]!.id)).toMatch(/^blob:/);
  });

  it('★问音色这一下抛了也不许把这一通电话带走:当成问不出来', async () => {
    const cache = createFillerVoiceCache({
      currentVoice: async () => { throw new Error('连不上 8791'); },
      synthesize: async () => blob('x'),
      store: null,
      objectUrl: () => 'blob:x',
      revokeUrl: () => {},
    });
    const result = await cache.refresh();
    expect(result.voice).toBeUndefined();
    expect(cache.urlFor('think-1')).toBe(fillerAssetUrl('think-1'));
  });

  it('这台手机没有 Cache Storage:照样合成、照样放,只是下次进房要再合一遍', async () => {
    const { cache, harness } = cacheWith({ voice: 'V1', store: null });
    const result = await cache.refresh();
    expect(result.synthesized).toBe(FILLER_LINES.length);
    expect(harness.synth).toHaveBeenCalledTimes(FILLER_LINES.length);
    expect(cache.urlFor('think-1')).toMatch(/^blob:/);
  });

  it('没对齐过的时候 urlFor 就是包里那一份 —— 任何时候都给得出一个地址', () => {
    const { cache } = cacheWith({ voice: 'V1' });
    for (const line of FILLER_LINES) expect(cache.urlFor(line.id)).toBe(fillerAssetUrl(line.id));
  });
});

describe('音色变了:只记一笔,下次进房才重取', () => {
  it('★通话中收到 filler_voice_changed 不当场重合成(七条 TTS 一起打出去就是 09-20 那次 502)', async () => {
    const { cache, harness } = cacheWith({ voice: 'V1' });
    await cache.refresh();
    harness.synth.mockClear();

    cache.markStale('V2');
    expect(cache.stale()).toBe(true);
    expect(harness.synth).not.toHaveBeenCalled();
    // 这一通电话剩下的时间里照旧放 V1 那一套(手上有什么放什么)。
    expect(cache.urlFor('think-1')).toMatch(/^blob:/);

    // 下次进房才重取,而且按广播里那个音色去取。
    await cache.refresh();
    expect(harness.synth).toHaveBeenCalledTimes(FILLER_LINES.length);
    expect(cache.voice()).toBe('V2');
    expect(cache.stale()).toBe(false);
  });

  it('广播里没带音色名:下次进房自己去问一遍', async () => {
    const { cache } = cacheWith({ voice: 'V9' });
    cache.markStale();
    const result = await cache.refresh();
    expect(result.voice).toBe('V9');
  });
});

/**
 * 合完就掐头尾静音(2026-09-22 第二张卡)。掐的算法本身在 tests/fillerTrim.test.ts 里,
 * 这里只钉**接线**:掐在哪一步、掐不了怎么办、缓存命中的会不会白掐一遍。
 */
describe('合完就掐头尾静音', () => {
  /** jsdom 的 Blob 没有 text()/arrayBuffer(),用 FileReader 读(源码里那一份也是这么退的)。 */
  async function readText(one: Blob): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { resolve(String(reader.result)); };
      reader.onerror = () => { reject(reader.error ?? new Error('读不出来')); };
      reader.readAsText(one);
    });
  }

  /** 一个假的「掐」:把 blob 换成一份 audio/wav,并报掐掉了多少。 */
  function fakeTrim(headMs = 200, tailMs = 100): FillerTrimmer {
    return async (input) => ({
      blob: new Blob([`trimmed:${await readText(input)}`], { type: 'audio/wav' }),
      trimmedHeadMs: headMs,
      trimmedTailMs: tailMs,
      trimmed: true,
    });
  }

  it('★存进缓存的就是掐过的那一份 —— 下次进房直接放,不必再解一次码', async () => {
    const { cache, harness } = cacheWith({ voice: 'V1', trim: fakeTrim() });
    const result = await cache.refresh();

    expect(result.synthesized).toBe(FILLER_LINES.length);
    const stored = harness.store.data.get(fillerCacheKey('V1', FILLER_LINES[0]!.id))!;
    expect(stored.type).toBe('audio/wav');
    expect(await readText(stored)).toMatch(/^trimmed:/);
    // 七句各掐掉 300ms。
    expect(result.trimmedMs).toBe(FILLER_LINES.length * 300);
  });

  it('★缓存命中的不再掐一遍(里头躺的本来就是掐过的)', async () => {
    const store = memoryStore();
    let times = 0;
    const counted: FillerTrimmer = async (input) => { times += 1; return await fakeTrim()(input); };

    await cacheWith({ voice: 'V1', store, trim: counted }).cache.refresh();
    expect(times).toBe(FILLER_LINES.length);

    const second = cacheWith({ voice: 'V1', store, trim: counted });
    const result = await second.cache.refresh();
    expect(result.cached).toBe(FILLER_LINES.length);
    expect(times).toBe(FILLER_LINES.length); // 一次都没多掐
    expect(result.trimmedMs).toBe(0);
  });

  it('★掐不了(老 WebView 解不开)只是晚一点开口:用原样那一份,**不许降级成包里那一句**', async () => {
    const lines: string[] = [];
    const store = memoryStore();
    const cache = createFillerVoiceCache({
      currentVoice: async () => 'V1',
      synthesize: async text => blob(`audio:${text}`),
      store,
      trim: async () => { throw new Error('EncodingError'); },
      objectUrl: () => 'blob:u',
      revokeUrl: () => {},
      log: line => lines.push(line),
    });
    const result = await cache.refresh();

    expect(result.synthesized).toBe(FILLER_LINES.length);
    expect(result.bundled).toBe(0);
    expect(result.trimmedMs).toBe(0);
    // 存进去的还是 8792 原样给的那一份。
    expect(await readText(store.data.get(fillerCacheKey('V1', FILLER_LINES[0]!.id))!)).toMatch(/^audio:/);
    expect(lines.join('')).toContain('EncodingError');
    // 放的还是合成的那一份,不是包里那一句。
    expect(cache.urlFor(FILLER_LINES[0]!.id)).toBe('blob:u');
  });

  it('这台 WebView 没有 OfflineAudioContext(trim = null):整个不掐,行为退回上一版', async () => {
    const { cache, harness } = cacheWith({ voice: 'V1', trim: null });
    const result = await cache.refresh();
    expect(result.trimmedMs).toBe(0);
    expect(await readText(harness.store.data.get(fillerCacheKey('V1', FILLER_LINES[0]!.id))!)).toMatch(/^audio:/);
  });
});

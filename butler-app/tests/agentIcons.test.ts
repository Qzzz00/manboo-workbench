/**
 * 手机上各家 logo 的取法与缓存(2026-09-26,卡 LG3)。
 *
 * 钉住的是三件事:
 *   ① **先问清单、etag 没变就一个图片请求都不发**(开 App 那一下从九次十几 KB 变成一次几百字节);
 *   ② **本地存着的那一张,重开 App 第一帧就在**(不用等网络);
 *   ③ **取不到就是取不到**:清单问不到 / 那一张取不到,`url()` 回 undefined(界面色点),而且不会一直重试。
 */
import { describe, expect, it } from 'vitest';
import {
  ICON_PER_TICK, ICON_RETRY_MS, ICON_TTL_MS,
  bytesToBase64, cachedIconKey, createAgentIconStore, iconDataUrl, iconsToFetch,
  manifestRows, parseCachedIcon, type AgentIconRow, type SyncStore,
} from '../src/agents/agentIcons';

/** 测试用的一份内存 localStorage。 */
function memStore(seed: Record<string, string> = {}): SyncStore & { map: Map<string, string>; writes: number } {
  const map = new Map(Object.entries(seed));
  const store = {
    map,
    writes: 0,
    getItem: (key: string) => map.get(key) ?? null,
    setItem(key: string, value: string) { store.writes += 1; map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
  return store;
}

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

interface Harness {
  manifestCalls: number;
  pngCalls: string[];
}

function harness(options: {
  rows?: readonly AgentIconRow[];
  manifestOk?: boolean;
  /** 这台工作台压根没有清单那条路(0.4.13 及更早):回 404 那一档。 */
  manifestAbsent?: boolean;
  pngOk?: boolean;
  /** 只有这几家取得到图,别的 404(直取那条路上 404 = 它没有图)。 */
  pngOnly?: readonly string[];
  store?: SyncStore;
  clock?: { t: number };
}) {
  const log: Harness = { manifestCalls: 0, pngCalls: [] };
  const clock = options.clock ?? { t: 1_000_000 };
  const store = createAgentIconStore({
    async manifest() {
      log.manifestCalls += 1;
      if (options.manifestAbsent === true) return { ok: false, absent: true };
      if (options.manifestOk === false) return { ok: false };
      return { ok: true, rows: options.rows ?? [{ id: 'claude', etag: '"a1"' }, { id: 'muse', etag: '"b2"' }] };
    },
    async png(id) {
      log.pngCalls.push(id);
      if (options.pngOk === false) return { ok: false };
      if (options.pngOnly !== undefined && !options.pngOnly.includes(id)) return { ok: false };
      return { ok: true, bytes: BYTES };
    },
    ...(options.store === undefined ? {} : { store: options.store }),
    now: () => clock.t,
  });
  return { store, log, clock };
}

describe('纯函数', () => {
  it('清单洗一遍:少一格 / 类型不对 / 空串的那一行扔掉', () => {
    expect(manifestRows({ icons: [{ id: 'claude', etag: '"a"', bytes: 17_593 }] })).toEqual([{ id: 'claude', etag: '"a"' }]);
    expect(manifestRows({ icons: [{ id: 'claude' }, { etag: '"a"' }, { id: '', etag: '"a"' }, { id: 'x', etag: '' }, 7, null] })).toEqual([]);
    // 不是那个形状(旧工作台回了别的、回了一段 HTML)一律空,不抛。
    expect(manifestRows(undefined)).toEqual([]);
    expect(manifestRows({ icons: 'nope' })).toEqual([]);
    expect(manifestRows('<html>')).toEqual([]);
  });

  it('本地那一条:存坏了 / 少一格 → 当没存过', () => {
    expect(parseCachedIcon(JSON.stringify({ etag: '"a"', base64: 'QQ==', at: 5 }))).toEqual({ etag: '"a"', base64: 'QQ==', at: 5 });
    expect(parseCachedIcon('{')).toBeUndefined();
    expect(parseCachedIcon(null)).toBeUndefined();
    expect(parseCachedIcon(JSON.stringify({ etag: '"a"', base64: 'QQ==' }))).toBeUndefined();
    expect(parseCachedIcon(JSON.stringify({ etag: 7, base64: 'QQ==', at: 5 }))).toBeUndefined();
    expect(parseCachedIcon(JSON.stringify({ etag: '"a"', base64: '', at: 5 }))).toBeUndefined();
    // etag 空串是合法的:直取那条路(老工作台)存的就是它。
    expect(parseCachedIcon(JSON.stringify({ etag: '', base64: 'QQ==', at: 5 }))).toEqual({ etag: '', base64: 'QQ==', at: 5 });
  });

  it('etag 一样就不取;清单里没有那一家也不取', () => {
    const rows = [{ id: 'claude', etag: '"a1"' }, { id: 'muse', etag: '"b2"' }];
    const cached = (id: string) => (id === 'claude' ? '"a1"' : undefined);
    expect(iconsToFetch(['claude', 'muse', 'doubao'], rows, cached)).toEqual(['muse']);
    // 内容变了(他换了一版客户端)→ 重取
    expect(iconsToFetch(['claude'], [{ id: 'claude', etag: '"a2"' }], cached)).toEqual(['claude']);
  });

  it('分段 btoa:两万字节也不抛(安卓 WebView 上摊开参数会 RangeError)', () => {
    const big = new Uint8Array(20_000).fill(7);
    expect(() => bytesToBase64(big)).not.toThrow();
    expect(bytesToBase64(new Uint8Array([65, 66, 67]))).toBe('QUJD');
    expect(iconDataUrl('QUJD')).toBe('data:image/png;base64,QUJD');
  });
});

describe('取一趟', () => {
  it('★清单一趟、要的那几家各一张;图进内存也进本地', async () => {
    const local = memStore();
    const { store, log } = harness({ store: local });
    expect(store.url('claude')).toBeUndefined();
    store.want('claude');
    store.want('muse');
    await store.idle();
    expect(log.manifestCalls).toBe(1);
    expect(log.pngCalls.sort()).toEqual(['claude', 'muse']);
    expect(store.url('claude')).toBe(iconDataUrl(bytesToBase64(BYTES)));
    expect(parseCachedIcon(local.getItem(cachedIconKey('muse')))?.etag).toBe('"b2"');
  });

  it('★重开 App:本地存着的那一张第一帧就在,一个请求都不发', () => {
    const local = memStore({ [cachedIconKey('claude')]: JSON.stringify({ etag: '"a1"', base64: 'QUJD', at: 999_000 }) });
    const { store, log } = harness({ store: local });
    // 还没 want、还没到任何一趟网络,url() 已经给得出来 —— 这就是「不挡渲染」。
    expect(store.url('claude')).toBe('data:image/png;base64,QUJD');
    expect(log.manifestCalls).toBe(0);
  });

  it('★存着的 etag 与清单一样:清单问一趟,图一张都不取', async () => {
    const local = memStore({ [cachedIconKey('claude')]: JSON.stringify({ etag: '"a1"', base64: 'QUJD', at: 999_000 }) });
    const { store, log } = harness({ store: local });
    store.want('claude');
    await store.idle();
    expect(log.manifestCalls).toBe(1);
    expect(log.pngCalls).toEqual([]);
    expect(store.url('claude')).toBe('data:image/png;base64,QUJD');
  });

  it('一拍最多取 ICON_PER_TICK 张,剩下的接着下一拍', async () => {
    const rows: AgentIconRow[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, etag: `"${id}"` }));
    const { store, log } = harness({ rows });
    for (const row of rows) store.want(row.id);
    await store.idle();
    expect(log.pngCalls.length).toBe(rows.length);
    // 不是一口气五张:分了几拍(清单也就跟着多问了几趟,每趟几百字节)
    expect(log.manifestCalls).toBeGreaterThan(1);
    expect(ICON_PER_TICK).toBe(3);
  });
});

describe('取不到的时候', () => {
  it('★清单问不到(连不上 / 旧工作台 / 在外面被挡):url 是 undefined,而且不会一直重问', async () => {
    const { store, log, clock } = harness({ manifestOk: false });
    store.want('claude');
    await store.idle();
    expect(store.url('claude')).toBeUndefined();
    expect(log.manifestCalls).toBe(1);
    // 界面每一拍都会再叫一次 want:隔一会儿之前不再问
    store.want('claude');
    await store.idle();
    expect(log.manifestCalls).toBe(1);
    clock.t += ICON_RETRY_MS + 1;
    store.want('claude');
    await store.idle();
    expect(log.manifestCalls).toBe(2);
  });

  it('★清单里没有这一家(没装 / 渲不出 / 壳是旧版):记成没有,不再为它发请求', async () => {
    const { store, log } = harness({ rows: [{ id: 'claude', etag: '"a1"' }] });
    store.want('doubao');
    await store.idle();
    expect(store.missing('doubao')).toBe(true);
    expect(store.url('doubao')).toBeUndefined();
    expect(log.pngCalls).toEqual([]);
    const before = log.manifestCalls;
    store.want('doubao');
    await store.idle();
    expect(log.manifestCalls).toBe(before);
  });

  it('图那一条取不到(在外面走不了图片那条路):不当「这一家没有图」,回了家自己就补上', async () => {
    const { store, log } = harness({ pngOk: false, rows: [{ id: 'claude', etag: '"a1"' }] });
    store.want('claude');
    await store.idle();
    expect(store.url('claude')).toBeUndefined();
    expect(store.missing('claude')).toBe(false);
    expect(log.pngCalls).toEqual(['claude']);
  });

  it('本地存不了(隐私模式 / 满了):内存里照样画得出来,不抛', async () => {
    const angry: SyncStore = {
      getItem: () => { throw new Error('站点数据被关了'); },
      setItem: () => { throw new Error('满了'); },
      removeItem: () => {},
    };
    // 连读都抛的那一种:store 缺席就是它的等价情形,这里用一个只在写时抛的
    const { store } = harness({ store: { ...angry, getItem: () => null } });
    store.want('claude');
    await store.idle();
    expect(store.url('claude')).toBe(iconDataUrl(bytesToBase64(BYTES)));
  });

  it('一小时之后回头对一次清单(与服务端 max-age=3600 同一个数)', async () => {
    const local = memStore({ [cachedIconKey('claude')]: JSON.stringify({ etag: '"a1"', base64: 'QUJD', at: 999_000 }) });
    const { store, log, clock } = harness({ store: local, rows: [{ id: 'claude', etag: '"a1"' }] });
    store.want('claude');
    await store.idle();
    expect(log.manifestCalls).toBe(1);
    store.want('claude');
    await store.idle();
    expect(log.manifestCalls).toBe(1);
    clock.t += ICON_TTL_MS + 1;
    store.want('claude');
    await store.idle();
    expect(log.manifestCalls).toBe(2);
  });

  it('取到了新的一张就叫一声(那几处重画)', async () => {
    let told = 0;
    const { store } = harness({});
    const off = store.subscribe(() => { told += 1; });
    store.want('claude');
    await store.idle();
    expect(told).toBeGreaterThan(0);
    off();
    const was = told;
    store.want('muse');
    await store.idle();
    expect(told).toBe(was);
  });
});

/**
 * **这台工作台没有清单那条路**(0.4.13 及更早只有 `/agents/icon/:id`)。手机包与插件不是一起装的 ——
 * 先装了新手机包的那几天,图照样要有。这几条钉住那条退路。
 */
describe('老工作台(没有 /agents/icons):退到直取', () => {
  it('★清单 404 之后直取每一家,取到的照样画、照样存本地', async () => {
    const local = memStore();
    const { store, log } = harness({ manifestAbsent: true, store: local });
    store.want('claude');
    store.want('muse');
    await store.idle();
    expect(log.pngCalls.sort()).toEqual(['claude', 'muse']);
    expect(store.url('claude')).toBe(iconDataUrl(bytesToBase64(BYTES)));
    expect(parseCachedIcon(local.getItem(cachedIconKey('claude')))?.base64).toBe(bytesToBase64(BYTES));
  });

  it('★清单那条路只问一趟就记住了(不每一拍白问一次)', async () => {
    const { store, log, clock } = harness({ manifestAbsent: true });
    store.want('claude');
    await store.idle();
    expect(log.manifestCalls).toBe(1);
    clock.t += ICON_TTL_MS + 1;
    store.want('muse');
    await store.idle();
    // 清单还是只问过那一趟;图该取的取了(claude 手上那一张过了一小时,回头又取了一张)。
    expect(log.manifestCalls).toBe(1);
    expect([...new Set(log.pngCalls)].sort()).toEqual(['claude', 'muse']);
  });

  it('★直取那条路上 404 = 这一家没有图:记住,不再反复取', async () => {
    const { store, log } = harness({ manifestAbsent: true, pngOnly: ['claude'] });
    store.want('claude');
    store.want('doubao');
    await store.idle();
    expect(store.url('claude')).toBeTruthy();
    expect(store.missing('doubao')).toBe(true);
    const was = log.pngCalls.length;
    store.want('doubao');
    await store.idle();
    expect(log.pngCalls.length).toBe(was);
  });

  it('★存着的那一张一小时之内不重取,过了才回头取一张(没有 etag 可对)', async () => {
    const local = memStore({ [cachedIconKey('claude')]: JSON.stringify({ etag: '', base64: 'QUJD', at: 1_000_000 }) });
    const { store, log, clock } = harness({ manifestAbsent: true, store: local, clock: { t: 1_000_000 } });
    store.want('claude');
    await store.idle();
    expect(log.pngCalls).toEqual([]);
    expect(store.url('claude')).toBe('data:image/png;base64,QUJD');
    clock.t += ICON_TTL_MS + 1;
    store.want('claude');
    await store.idle();
    expect(log.pngCalls).toEqual(['claude']);
  });
});

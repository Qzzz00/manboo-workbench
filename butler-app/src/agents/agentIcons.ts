/**
 * 手机上各家的 **logo**(2026-09-26,卡 LG3)。维护者原话:「每家的 logo-icon 要显示在手机客户端上,
 * 我发现你一边做一边漏」—— 卡 LG 在电脑上把图标接上了(窗口槽标签、顶栏小灯、「N 家 Agent 客户端」),
 * 手机上一处都没有。这一份是手机这一侧那张图的来处。
 *
 * ## 为什么手机不能照电脑那样写一个 `<img src="/agents/icon/claude">`
 *
 * 电脑上页面与 8791 同源,`<img>` 直接就取到了,ETag / 304 / 一小时的缓存全是浏览器替你做的。
 * 手机不是:每一条请求都要带设备令牌(`Authorization: Bearer …`,见 api/client.ts),`<img>` 设不了请求头。
 * 所以图得**自己取、自己缓存**:
 *
 *   - **内存一份**:取到的那一张按登记表 id 记住(同一张图在首页、事项页、设置页出现十几次,只有一份字节);
 *   - **本地一份**(localStorage):关掉 App 再开,图**第一帧就在**,不用等一趟网络。图标几乎不变,
 *     这是它值得存的原因。存坏了、存不下(隐私模式、清过数据)一律当没有 —— 每一处读写都包着 try/catch。
 *   - **对 etag、一小时**:与服务端那条 `Cache-Control: max-age=3600, must-revalidate` 同一个数。
 *     手机上的做法比 304 更省:先问一次**清单**(`GET /agents/icons`,九家不到 1 KB 的 JSON),
 *     etag 没变的那几张**一个图片请求都不发**;变了的那几家才取一张 PNG。
 *
 * ## 三条硬规矩
 *
 * 1. **取不到就退回色点,不算出错**。没装那个 App、壳是旧版、工作台是旧版、人在外面(图片走不了房间那条路)——
 *    界面上就是卡 Q 那颗色点(颜色也来自它自己的图标),名字照样在旁边。一个错误提示都不弹。
 * 2. **不挡渲染**。`url()` 是同步的纯读:内存里有就给,本地存着就给,没有就 `undefined`。
 *    取图在背后走,取到了叫一声让那几处重画 —— 「图标晚到就晚到」。
 * 3. **存着的那一张过期了照样先画**,一边在背后对清单。图标不是会过时的事实(它就是那个 App 的图标),
 *    为了「新鲜」先空一格再补上,只会让人看见闪一下。
 */

/** 与服务端 `Cache-Control: max-age=3600` 同一个数:存着的这几张超过一小时就回头对一次清单。 */
export const ICON_TTL_MS = 60 * 60_000;

/** 清单问失败了(连不上、在外面、旧工作台)之后,最少隔这么久再问一次 —— 界面每重画一次就问一次会把网打满。 */
export const ICON_RETRY_MS = 30_000;

/** 一拍最多取几张图(同电脑那侧的 `ICON_PER_TICK`):九家一起挂上来时别一口气占满连接。 */
export const ICON_PER_TICK = 3;

/** localStorage 里的键前缀。一家一条 —— 一条存坏了不会带走别家。 */
export const ICON_CACHE_PREFIX = 'butler.agenticon.';

/**
 * 一张图 base64 之后超过这么大就不往本地存(内存里照样用)。
 * 壳渲的是 128×128 的 PNG,实测 9.7–22 KB,base64 之后 13–30 KB;40 万给的余量足够,
 * 又拦住「工作台那边哪天改成 512×512」把 localStorage 撑爆这种事。
 */
export const ICON_MAX_BASE64 = 400_000;

/** 本地最多存这么多家。超了先扔最久的那几条(登记表通常九家上下)。 */
export const ICON_CACHE_MAX = 24;

/** 清单里的一行:这一家有图,内容指纹是这个。 */
export interface AgentIconRow {
  id: string;
  etag: string;
}

/** 本地存着的一张。`at` = 存下来的时刻(毫秒),用来判要不要回头对一次清单。 */
export interface CachedIcon {
  etag: string;
  base64: string;
  at: number;
}

/** localStorage 那三个方法(测试塞一个内存实现;取不到 localStorage 时整个缺席)。 */
export interface SyncStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function cachedIconKey(id: string): string {
  return `${ICON_CACHE_PREFIX}${id}`;
}

/** `data:` URL(一张图只拼一次,由 store 记住 —— 同一个字符串给十几处 `<img>`,浏览器只解一次)。 */
export function iconDataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

/**
 * 服务端回的清单洗一遍(`{ icons: [{ id, etag, bytes }] }`)。
 * 少一格、类型不对、id 或 etag 是空串的那一行**直接扔掉**:清单是给「要不要重取」用的,
 * 宁可当它没有(那就重取一张,最多多一趟)也不要拿半条数据去比。
 */
export function manifestRows(body: unknown): AgentIconRow[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { icons?: unknown }).icons;
  if (!Array.isArray(list)) return [];
  const out: AgentIconRow[] = [];
  for (const raw of list as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const one = raw as { id?: unknown; etag?: unknown };
    if (typeof one.id !== 'string' || one.id === '') continue;
    if (typeof one.etag !== 'string' || one.etag === '') continue;
    out.push({ id: one.id, etag: one.etag });
  }
  return out;
}

/** 本地存着的那一条读出来。存坏了 / 不是这个形状 → undefined(当没存过)。 */
export function parseCachedIcon(raw: string | null): CachedIcon | undefined {
  if (raw === null || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const one = parsed as { etag?: unknown; base64?: unknown; at?: unknown };
    // etag **空串是合法的**:直取那条路(老工作台没有清单)存下来的就没有 etag —— 拿它跟清单比永远不等,
    // 也就是「下次照样重取一张」,正是想要的。图的字节空了才是坏了。
    if (typeof one.etag !== 'string') return undefined;
    if (typeof one.base64 !== 'string' || one.base64 === '') return undefined;
    if (typeof one.at !== 'number' || !Number.isFinite(one.at)) return undefined;
    return { etag: one.etag, base64: one.base64, at: one.at };
  } catch {
    return undefined;
  }
}

/**
 * 清单回来了:界面上要的这几家里,哪几家的图要去取。
 * 存着的 etag 与清单一样 → 一个请求都不发;不一样 / 没存过 → 取;清单里没有这一家(它没有图)→ 不取。
 */
export function iconsToFetch(
  wanted: readonly string[],
  rows: readonly AgentIconRow[],
  cachedEtag: (id: string) => string | undefined,
): string[] {
  const byId = new Map(rows.map((row) => [row.id, row.etag]));
  const out: string[] = [];
  for (const id of wanted) {
    const etag = byId.get(id);
    if (etag === undefined) continue;
    if (cachedEtag(id) === etag) continue;
    out.push(id);
  }
  return out;
}

/**
 * 字节 → base64。**分段 btoa**:`String.fromCharCode(...bytes)` 一次摊开两万个参数,
 * 在有的安卓 WebView 上直接抛 RangeError(图标十几 KB 就在门槛附近)。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x2000;
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step));
  }
  return btoa(binary);
}

/** 拿真的 localStorage 当本地那一份。用不了(隐私模式、站点数据被关、没有 window)→ undefined,只剩内存那一份。 */
export function localIconStore(): SyncStore | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    // 真写一次再删掉:安卓上「有这个对象但一写就抛」是真事(站点数据被关掉)。
    const probe = `${ICON_CACHE_PREFIX}probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return undefined;
  }
}

export interface AgentIconStore {
  /**
   * 此刻这一家能画的那张图(`data:` URL)。没有 → `undefined`,界面退回色点。
   * **同步、不发请求、不抛**:它在渲染里被调,挡不得。
   */
  url(id: string): string | undefined;
  /** 界面上出现了这一家:该取的去取(去重、限流、失败有间隔)。在 effect 里调,别在渲染里调。 */
  want(id: string): void;
  /** 有新的图取到了就叫一声(那几处重画一次)。 */
  subscribe(listener: () => void): () => void;
  /** 问过清单,这一家确实没有图(没装 / 渲不出 / 壳是旧版):界面不再等它。 */
  missing(id: string): boolean;
  /** 用例用:等此刻这一拍取完。生产代码不调。 */
  idle(): Promise<void>;
}

export interface AgentIconStoreDeps {
  /**
   * `GET /agents/icons`。
   *   - `ok: true` → 清单;按 etag 决定哪几张要重取(省下不变的那几张)。
   *   - `absent: true` → **这台工作台没有这条路**(0.4.13 及更早只有 `/agents/icon/:id`)。
   *     这时退到「直取」:界面上要的每一家直接取一张图,本地存着的一小时之内不再取。
   *     这条退路是有意留的 —— 手机包与插件不是一起装的,先装了新手机包的那几天图照样有。
   *   - `ok: false` → 这一趟没问到(连不上、在外面被挡)。隔一会儿再说,界面照旧色点。
   */
  manifest(): Promise<{ ok: true; rows: readonly AgentIconRow[] } | { ok: false; absent?: boolean }>;
  /** `GET /agents/icon/:id` 那一张的字节。取不到 → ok:false。 */
  png(id: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
  /** 本地那一份。缺席 = 只有内存一份(每次开 App 重取一趟)。 */
  store?: SyncStore | undefined;
  now?: () => number;
}

/** 内存里一家的一条。 */
interface Slot {
  url: string;
  etag: string;
  /** 本地那一条是几点存下的(内存里刚取到的就是此刻)。 */
  at: number;
}

export function createAgentIconStore(deps: AgentIconStoreDeps): AgentIconStore {
  const now = deps.now ?? (() => Date.now());
  const slots = new Map<string, Slot>();
  /** 本地那一份问过一次的那几家(没存过的不再反复解 JSON)。 */
  const probed = new Set<string>();
  /** 界面上出现过的那几家。 */
  const wanted = new Set<string>();
  /** 清单说它没有图:不再等。 */
  const missing = new Set<string>();
  const listeners = new Set<() => void>();
  /**
   * 上一次问到清单的时刻。**一开始是负无穷**,不是 0 —— 写 0 的话在时钟小于一小时的场合
   * (用例里的假时钟、开机后不久的手机)会被当成「刚问过」,开 App 那一趟清单就整个不发了。
   */
  let manifestAt = Number.NEGATIVE_INFINITY;
  let nextTryAt = 0;
  /**
   * 这台工作台没有清单那条路(0.4.13 及更早)→ 退到「直取」,一趟之后就记住,不再白问。
   * 手机包与插件不是一起装的,这条退路让先装了新手机包的那几天图照样有。
   */
  let noManifest = false;
  let running: Promise<void> | undefined;
  /** 已经排上、还没开跑的那一拍(见 kick)。 */
  let scheduled: Promise<void> | undefined;
  let again = false;

  /** 内存里这一家的那一条;没有就从本地读一次(只读一次)。 */
  function peek(id: string): Slot | undefined {
    const hit = slots.get(id);
    if (hit !== undefined) return hit;
    if (probed.has(id)) return undefined;
    probed.add(id);
    const local = parseCachedIcon(deps.store?.getItem(cachedIconKey(id)) ?? null);
    if (local === undefined) return undefined;
    const slot: Slot = { url: iconDataUrl(local.base64), etag: local.etag, at: local.at };
    slots.set(id, slot);
    return slot;
  }

  function notify(): void {
    for (const listener of listeners) {
      try { listener(); } catch { /* 一个订阅者抛了不该带走别人 */ }
    }
  }

  function writeLocal(id: string, icon: CachedIcon): void {
    const store = deps.store;
    if (store === undefined || icon.base64.length > ICON_MAX_BASE64) return;
    try {
      store.setItem(cachedIconKey(id), JSON.stringify(icon));
      // 存的家数超上限:把除了这一次写的之外最久的那几条扔掉(只动我们自己的键)。
      const older = [...slots.entries()].filter(([other]) => other !== id).sort((a, b) => a[1].at - b[1].at);
      for (let over = slots.size - ICON_CACHE_MAX; over > 0; over -= 1) {
        const gone = older.shift();
        if (gone === undefined) break;
        try { store.removeItem(cachedIconKey(gone[0])); } catch { /* 删不掉就算了 */ }
        slots.delete(gone[0]);
      }
    } catch {
      // 满了 / 不让写:内存里那一份照样能画,下次开 App 重取一趟就是了。
    }
  }

  /** 要不要走一拍:有想要还没有的,或者存着的那几张该回头对一次清单了。 */
  function due(at: number): boolean {
    if (at < nextTryAt) return false;
    for (const id of wanted) {
      if (!missing.has(id) && peek(id) === undefined) return true;
    }
    return wanted.size > 0 && at - manifestAt >= ICON_TTL_MS;
  }

  async function tick(): Promise<void> {
    if (!due(now())) return;
    const asked = [...wanted];
    /** 这一拍要取的那几家,以及各自取到之后记哪个 etag(直取那条路上没有 etag)。 */
    let todo: string[];
    let etagOf: (id: string) => string;
    /** 取不到那一张时算不算「这一家就是没有图」(直取那条路上 404 就是这个意思)。 */
    let failIsMissing = false;

    if (noManifest) {
      // 直取(老工作台):要的每一家没有就取一张;存着的过了一小时回头再取一张。
      const at = now();
      todo = asked.filter((id) => {
        if (missing.has(id)) return false;
        const slot = peek(id);
        return slot === undefined || at - slot.at >= ICON_TTL_MS;
      });
      etagOf = () => '';
      failIsMissing = true;
      manifestAt = at;
    } else {
      const list = await deps.manifest();
      if (!list.ok) {
        if (list.absent === true) {
          // 这台工作台没有清单那条路:换直取,这一拍接着走完(别让他多等一拍才看见图)。
          noManifest = true;
          again = true;
          return;
        }
        // 问不到清单:隔一会儿再说。存着的那几张照样画着 —— 这不是「坏了」。
        nextTryAt = now() + ICON_RETRY_MS;
        return;
      }
      manifestAt = now();
      const have = new Set(list.rows.map((row) => row.id));
      // 清单里没有这一家 = 它没有图(没装 / 渲不出 / 壳是旧版)→ 不再等它。
      for (const id of asked) {
        if (have.has(id)) missing.delete(id);
        else missing.add(id);
      }
      todo = iconsToFetch(asked, list.rows, (id) => peek(id)?.etag);
      etagOf = (id) => list.rows.find((row) => row.id === id)?.etag ?? '';
    }

    let got = false;
    for (const id of todo.slice(0, ICON_PER_TICK)) {
      const one = await deps.png(id);
      if (!one.ok) {
        // 清单那条路上:这一张取不到(在外面走不了图片那条路 / 刚好被撤了)**不**记成没有图 ——
        // 清单已经说了它有图,下一拍还会试。直取那条路上没有清单可问,404 就是「它没有图」。
        if (failIsMissing) missing.add(id);
        continue;
      }
      let base64: string;
      try { base64 = bytesToBase64(one.bytes); }
      catch { continue; }
      slots.set(id, { url: iconDataUrl(base64), etag: etagOf(id), at: manifestAt });
      probed.add(id);
      missing.delete(id);
      writeLocal(id, { etag: etagOf(id), base64, at: manifestAt });
      got = true;
    }
    if (got) notify();
    // 一拍没取完(超过 ICON_PER_TICK 张):接着下一拍。
    if (todo.length > ICON_PER_TICK) again = true;
  }

  /**
   * 走一拍,但**先让这一轮渲染里的 want 全都报上名**(排到一个微任务之后再动)。
   * 首页一屏上十几处图标,React 一次提交里每一处都叫一次 `want` —— 不等一下的话第一处就把清单问掉了,
   * 剩下十几家在下一拍才轮到,白问好几趟清单。
   */
  function kick(): void {
    if (running !== undefined) { again = true; return; }
    if (scheduled !== undefined) return;
    scheduled = Promise.resolve().then(() => {
      scheduled = undefined;
      running = (async () => {
        try { await tick(); }
        catch { /* 取图绝不带走界面 */ }
        running = undefined;
        if (again) { again = false; kick(); }
      })();
    });
  }

  return {
    url: (id) => (id === '' ? undefined : peek(id)?.url),
    want(id) {
      if (id === '') return;
      const fresh = !wanted.has(id);
      wanted.add(id);
      // 新的一家一定走一拍;老的那几家只在真该走时走(界面每拍都会叫一次 want)。
      if (fresh || due(now())) kick();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    missing: (id) => missing.has(id),
    // 排着的那一拍与正在跑的那一拍都等掉(接着又排上一拍的话继续等;循环有上限,免得写错了在用例里挂死)。
    async idle() {
      for (let guard = 0; guard < 200; guard += 1) {
        if (scheduled !== undefined) { await scheduled; continue; }
        if (running !== undefined) { await running; continue; }
        return;
      }
    },
  };
}

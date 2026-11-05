/**
 * 缓冲语跟着**当前音色**走(2026-09-22,补 09-20 那一版留下的洞)。
 *
 * ## 为什么要有这个文件
 *
 * 09-20 那一版把那七句话**在构建时**合成好打进安装包(66.2 KB,`public/filler/*.m4a`)。
 * 那一版的交接第六节第 1 条如实写着一个洞:
 *
 * > **换了音色不会自己重新生成。** 那七句是打进安装包的;在工作台里换了事务官音色之后,
 * > 电话里会有两个嗓子(缓冲语是旧的,她自己的回答是新的),直到有人重跑脚本、重新打包。
 *
 * 根子在于:**音色不是构建期的东西**。它是 8792 按「形象在 chat 场景的绑定」现解析的,
 * 人在 Mac 的配置后台里随时能改。拿构建期的产物去追一个运行期的设置,永远慢一步。
 *
 * 所以这一版把合成挪到**运行期**:手机进房时问一句「现在是哪个音色」,
 * 按音色去合成那七句、**缓存在手机本地**,以后每一通电话直接拿缓存。
 * **包里那七句仍然在,当兜底** —— 第一次进房、合成失败、8792 没跑、离线,都还是它们。
 *
 * ## 走哪条路(卡上要求写清)
 *
 *   1. **哪个音色**:`GET /butler/status` → `voice`。这条路**本来就在手机的白名单里**
 *      (channel-worker/src/rpc.ts 那张表),不新开门。8792 没跑 / 解析不出音色时它缺席 ——
 *      **那就一句都不合成**(不知道嗓子是谁的时候去合成,等于给缓存起一个假名字)。
 *   2. **音频**:`POST /butler/proxy/api/tts`,**走现成的 routedClient.blob** ——
 *      在局域网里是直连 8791 的普通 HTTP,出了局域网自动改走房间的 byte stream 由工人代理。
 *      两条路都不必在这里区分:`client.blob` 就是为这件事存在的。
 *      **不新开 TTS 接口、不绕过 8791**:令牌在代理那一层,手机这边碰不到。
 *
 * ## 三条纪律
 *
 *   1. **缓存键里带音色名**({@link fillerCacheKey})。换了音色就是另一套键,
 *      旧的那一套原样留着 —— 他换回去的时候不用再合成一遍。
 *   2. **一句失败只影响那一句**:那一句回落到包里那一份,别的照用缓存。
 *      **不做成"有一句合不出来就整套用包里的"** —— 那是拿六句的新嗓子换一句的一致性。
 *   3. **通话中不重新合成**。音色变了只**记一笔**,下次进房才重取:
 *      通话中去合七句 = 七条 `/api/tts` 撞火山的并发配额,而那正是 09-20 那次 502 的病根。
 *   4. **合完就掐头尾静音**(2026-09-22 第二张卡,`call/fillerTrim.ts`)。
 *      火山给的 mp3 前面有 166–392ms 空白 —— 打进包里那七句在构建时被 ffmpeg 掐过,
 *      运行期这一份原先没掐,于是**换了音色之后缓冲语反而比包里那份晚 0.2–0.4 秒开口**。
 *      掐**在存进缓存之前**(缓存里躺的就该是能直接放的);**掐不了就原样**,
 *      退回上一版的行为。为什么在手机上掐而不是在 8792 上掐:见 `call/fillerTrim.ts` 的头注释。
 */
import type { FillerLine } from './fillerAudio';
import { fillerAssetUrl, FILLER_SCENE, FILLER_VOICE_LINES } from './fillerAudio';
import { createWebAudioTrimmer, type FillerTrimmer } from './fillerTrim';

/**
 * 缓存键。**音色名在里面**,而且在 id 前面 —— 换了音色就是另一套键,
 * 旧那一套原样留着(他换回去时不必再合成一遍)。
 *
 * 音色 id 是 8792 给的字符串(`zh_female_…`),不保证只有安全字符,所以整段编码一次:
 * 一个带斜杠的音色名能把缓存键写成另一条路径。
 */
export function fillerCacheKey(voice: string, id: string): string {
  return `filler/${encodeURIComponent(voice)}/${encodeURIComponent(id)}`;
}

/**
 * 缓存放在哪。默认那一份用浏览器的 Cache Storage;拿不到就整个不缓存(照样能用包里那七句)。
 *
 * **桶名 2026-09-22 从 `wb-filler-v1` 换成 `wb-filler-v2`**:v1 里躺的是**没掐静音**的那一份,
 * 而缓存命中之后不会再掐(掐在写进去之前)。v1 那一版从没上过任何一台真手机
 * (0922 交接第六节第 1 条),所以现实中没有旧桶要清;换个名字只是保险,
 * 万一哪台开发机缓存过,它也不会拿一份旧的冒充。
 */
export interface FillerBlobStore {
  get: (key: string) => Promise<Blob | undefined>;
  put: (key: string, blob: Blob) => Promise<void>;
}

/**
 * Android WebView(Chrome)里的 Cache Storage。**没有它就返回 null** ——
 * 调用方据此只用包里那七句,而不是每通电话重新合成七次。
 */
export function createCacheStorageStore(name = 'wb-filler-v2'): FillerBlobStore | null {
  const store = (globalThis as { caches?: CacheStorage }).caches;
  if (store === undefined) return null;
  return {
    async get(key) {
      try {
        const cache = await store.open(name);
        const hit = await cache.match(key);
        return hit === undefined ? undefined : await hit.blob();
      }
      catch { return undefined; }
    },
    async put(key, blob) {
      try {
        const cache = await store.open(name);
        await cache.put(key, new Response(blob, { headers: { 'content-type': blob.type || 'audio/mpeg' } }));
      }
      catch { /* 存不下就下次再说:缓存不上不该影响这一通电话 */ }
    },
  };
}

export interface FillerVoiceCacheDeps {
  /** 现在是哪个音色。拿不到就 undefined —— 那就一句都不合成。 */
  currentVoice: () => Promise<string | undefined>;
  /** 合成一句(`POST /butler/proxy/api/tts`)。失败就抛,这里按句兜底。 */
  synthesize: (text: string, scene: string) => Promise<Blob>;
  /** 缓存。不给就用 Cache Storage;那个也没有就不缓存。 */
  store?: FillerBlobStore | null;
  /**
   * 合完**就掐掉头尾静音**(2026-09-22 第二张卡)。不给就用 WebAudio 那一份;
   * `null` 或者这台 WebView 没有 `OfflineAudioContext` 时**整个不掐**
   * —— 那就是上一版的行为:照样能放,只是晚 0.2–0.4 秒开口。
   *
   * **只掐新合成的那一份**:缓存里躺着的本来就是掐过的,再掐一遍是白解一次码。
   */
  trim?: FillerTrimmer | null;
  /** Blob → 能塞进 `<audio>` 的地址。测试注入。 */
  objectUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  /**
   * 要按音色对齐哪几句。缺省是垫场那几句(`thinking` / `tool`)——
   * **应声那几声(`ack`)刻意不在内**(2026-10-02,卡「声音与形象跟着话走」第 5 件):
   * 它们各自两三百毫秒,换了音色也听不出;而把它们加进来会让进房时一次打出十一条
   * `/api/tts`,那正是 09-20 那次 502 的病根。理由全文在 call/ackAudio.ts 的文件头。
   */
  lines?: readonly FillerLine[];
  scene?: string;
  log?: (line: string) => void;
}

/** 一次对齐的结果。**每个数都是数出来的**,给日志与用例看。 */
export interface FillerWarmResult {
  /** 这一趟按哪个音色对的。undefined = 没问出来,全用包里那七句。 */
  voice?: string;
  /** 缓存里现成的。 */
  cached: number;
  /** 这一趟真去合成的。 */
  synthesized: number;
  /** 回落到包里那一份的(合不出来、或者压根没问出音色)。 */
  bundled: number;
  /** 这一趟一共掐掉多少毫秒的静音(只算新合成的那几句)。给日志与用例看。 */
  trimmedMs: number;
}

export interface FillerVoiceCache {
  /** 这一句该放哪个地址。**没有缓存就是包里那一份** —— 永远给得出一个地址。 */
  urlFor: (id: string) => string;
  /** 这会儿手上这一套是哪个音色的。undefined = 包里那一套。 */
  voice: () => string | undefined;
  /** 音色变了(工人广播的那一条)。**只记一笔**,不当场重合成 —— 下次进房才重取。 */
  markStale: (voice?: string) => void;
  /** 有没有欠一次重取。 */
  stale: () => boolean;
  /** 进房时对齐一次。**永不抛**:对不上就还是包里那七句。 */
  refresh: () => Promise<FillerWarmResult>;
  dispose: () => void;
}

export function createFillerVoiceCache(deps: FillerVoiceCacheDeps): FillerVoiceCache {
  const lines = deps.lines ?? FILLER_VOICE_LINES;
  const scene = deps.scene ?? FILLER_SCENE;
  const store = deps.store === undefined ? createCacheStorageStore() : deps.store;
  const makeUrl = deps.objectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revoke = deps.revokeUrl ?? ((url: string) => { URL.revokeObjectURL(url); });
  const log = deps.log ?? (() => {});
  const trim = deps.trim === undefined ? createWebAudioTrimmer({ log }) : deps.trim;

  /** id → 这一套音色下的地址。**没有的那几个不进这张表** —— 查不到就回包里那一份。 */
  let urls = new Map<string, string>();
  let voice: string | undefined;
  let staleVoice: string | undefined;
  let dirty = false;
  let running: Promise<FillerWarmResult> | undefined;

  function dropUrls(): void {
    for (const url of urls.values()) { try { revoke(url); } catch { /* 撤不掉不影响什么 */ } }
    urls = new Map();
  }

  async function align(): Promise<FillerWarmResult> {
    const want = staleVoice ?? await deps.currentVoice().catch(() => undefined);
    staleVoice = undefined;
    dirty = false;
    if (want === undefined || want === '') {
      // 不知道嗓子是谁的时候**一句都不合成**:缓存键里那个名字会是假的,
      // 而一个起错名字的缓存比没有缓存糟得多(换回来的时候它还在那儿冒充)。
      log('[filler] 没问出当前音色,这一通用包里那七句');
      return { cached: 0, synthesized: 0, bundled: lines.length, trimmedMs: 0 };
    }
    if (want === voice && urls.size === lines.length) {
      return { voice, cached: lines.length, synthesized: 0, bundled: 0, trimmedMs: 0 };
    }
    if (want !== voice) { dropUrls(); voice = want; }

    let cached = 0;
    let synthesized = 0;
    let bundled = 0;
    let trimmedMs = 0;
    for (const line of lines) {
      if (urls.has(line.id)) { cached += 1; continue; }
      const key = fillerCacheKey(want, line.id);
      let blob = store === null ? undefined : await store.get(key);
      if (blob !== undefined) { cached += 1; }
      else {
        try {
          blob = await deps.synthesize(line.text, scene);
          synthesized += 1;
          // ★ 合完就掐头尾静音(call/fillerTrim.ts)。火山给的 mp3 前面有 166–392ms 空白,
          //   那一段会**原样变成延迟**,而这几句存在的理由就是快。掐不了就是原样那一份。
          //   **掐在存进缓存之前**:缓存里躺的就该是能直接放的那一份,不必每通电话再解一次码。
          if (trim !== null) {
            // 单独一个 try:**掐不掉不该把这一句降级成包里那一份** —— 合成已经成了,
            //   原样的那一份除了晚 0.2–0.4 秒开口以外一切正常(就是上一版的行为)。
            try {
              const cut = await trim(blob);
              blob = cut.blob;
              trimmedMs += cut.trimmedHeadMs + cut.trimmedTailMs;
            }
            catch (error) {
              log(`[filler] 「${line.text}」没掐成静音:${error instanceof Error ? error.message : String(error)},用原样那一份`);
            }
          }
          if (store !== null) await store.put(key, blob);
        }
        catch (error) {
          // 一句合不出来只影响这一句:它回落到包里那一份,别的照用新嗓子。
          log(`[filler] 「${line.text}」这一句没合成:${error instanceof Error ? error.message : String(error)},用包里那一份`);
          bundled += 1;
          continue;
        }
      }
      try { urls.set(line.id, makeUrl(blob)); }
      catch { bundled += 1; }
    }
    return { voice: want, cached, synthesized, bundled, trimmedMs };
  }

  return {
    urlFor: id => urls.get(id) ?? fillerAssetUrl(id),
    voice: () => voice,
    markStale(next) {
      dirty = true;
      staleVoice = next === undefined || next === '' ? undefined : next;
    },
    stale: () => dirty,
    async refresh() {
      // 同一时刻只对齐一趟:进房与「音色变了」有可能前后脚到。
      if (running !== undefined) return await running;
      running = align().catch((error) => {
        log(`[filler] 对齐音色没成:${error instanceof Error ? error.message : String(error)},用包里那七句`);
        return { cached: 0, synthesized: 0, bundled: lines.length, trimmedMs: 0 };
      });
      try { return await running; }
      finally { running = undefined; }
    },
    dispose() {
      dropUrls();
      voice = undefined;
      staleVoice = undefined;
      dirty = false;
    },
  };
}

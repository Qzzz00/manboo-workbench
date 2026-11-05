/**
 * 掐掉缓冲语的头尾静音(2026-09-22,补 `交接-0922-缓冲语运行期生成.md` 第六节第 2 条那个洞)。
 *
 * ## 要治的是什么
 *
 * 火山给回来的 mp3 **前面有 166–392ms 的空白**(09-20 第三节 F 的实测),那一段会
 * **原样变成延迟** —— 而这几句话存在的理由就是快(700ms 那道门后面本来一毫秒都不该多)。
 * 打进包里的那七句是构建时用 ffmpeg 掐过的;**运行期按当前音色现合的那一份没掐**,
 * 所以换了音色之后,缓冲语会比包里那一份晚 0.2–0.4 秒开口。
 *
 * ## 为什么在手机上掐,而不是在 8792 上掐
 *
 * 卡上给了两条路,选了手机这一条。理由逐条(可推翻):
 *
 *   1. **8792 今天一个外部可执行文件都不用。** `butler-server/server/` 里没有任何
 *      `child_process` / `execFile` / `spawn`(`/api/tts` 只是 HTTP 转 HTTP)。
 *      在那里掐就得新引入 ffmpeg 这个二进制依赖,而且是引在**每次合成都要过**的热路上。
 *   2. **`deploy/bootstrap.sh` 不装 ffmpeg**(它只 `brew install node@24`)。
 *      Ben 这台有 `/opt/homebrew/bin/ffmpeg`,目标用户的 Mac 不一定有,而目标用户
 *      「不懂代码、不走命令行」。于是 8792 那条路会**在 Ben 的验收里是好的、在用户机器上是哑的**
 *      —— 这是最坏的一种修法:它把问题藏起来,而不是解决掉。
 *   3. **就算 8792 掐了,这一份兜底还是要有**(没有 ffmpeg 的机器上还得靠它)。
 *      既然它必须存在而且**在所有机器上都成立**,再加一份 8792 的就是两处逻辑、两套阈值。
 *   4. `/api/tts` **不止一个调用方**(通道层工人拿它做实时说话,`channel-worker/src/tts/butlerTts.ts`)。
 *      在那一层掐会连带改掉别人的字节,要么加开关要么多一条岔路 —— 都是这件小事不值当的面积。
 *
 * ## 说好的「WebAudio 会不会不走媒体音量」这件事:**绕开了**
 *
 * 09-20 选普通 `<audio>` 是为了**跟系统媒体音量走**(交接-0920 第二节第 5 条)。
 * 这一份**只拿 WebAudio 解码**({@link createWebAudioTrimmer} 里那一次 `decodeAudioData`),
 * 掐完**重新封成 WAV**,**放还是那个 `<audio>`** —— 播放路径一个字节都没改,
 * 所以「WebAudio 在 Android WebView 里走哪路音量」这个问题在这里**根本不需要有答案**。
 * `decodeAudioData` 是 `BaseAudioContext` 上的一个纯解码函数,和播放无关;
 * 这里用的是 `OfflineAudioContext`,它连输出设备都不碰,也不受自动播放策略约束。
 *
 * WAV(16 位 PCM)在 Android 上从 API 1 起就是必解格式,`<audio>` 放它没有 minSdk 问题
 * (m4a/opus 那一堆考虑见 `scripts/render-filler-audio.mjs` 的头注释)。
 * 代价是**体积**:一句 1.1 秒的话,mp3 ≈ 7.7KB,24kHz 单声道 WAV ≈ 53KB;
 * 七句一套从 ~200KB 变成 ~420KB。装的是 Cache Storage,一套多出 200KB 换 0.2–0.4 秒开口,
 * 这笔账划算(缓存清理那条照旧没做,见 0922 交接第六节第 3 条)。
 *
 * ## 这个文件里什么是纯的
 *
 * {@link findTrimRange} / {@link encodeWav} / {@link trimSamplesToWav} **全是纯函数**,
 * 用例直接喂样本数组。只有 {@link createWebAudioTrimmer} 碰 `OfflineAudioContext`,
 * 而它**拿不到就返回 null** —— 那时整个不掐,行为退回到今天这一版(照样能放,只是晚一点开口)。
 */

/** 低于这个响度就算静音。−45dB 和构建脚本里那道 ffmpeg 滤镜是**同一个数**:再狠会啃掉第一个字的辅音。 */
export const FILLER_TRIM_THRESHOLD_DB = -45;

/** 开头留多少静音。20ms —— 和构建脚本的 `start_silence=0.02` 对齐。 */
export const FILLER_TRIM_HEAD_KEEP_MS = 20;

/** 结尾留多少静音。50ms —— 和构建脚本那道 `areverse` 后的 `start_silence=0.05` 对齐。 */
export const FILLER_TRIM_TAIL_KEEP_MS = 50;

/**
 * **最多掐多少**(两端各自算)。1.5 秒是个「这不对劲」的闸:
 * 火山那一段空白实测 166–392ms,真掐掉超过 1.5 秒,多半是阈值判错了(整句录得很轻),
 * 与其大胆下刀,不如只掐到这儿 —— 剩下的那点延迟远好过啃掉半句话。
 */
export const FILLER_TRIM_MAX_HEAD_MS = 1500;
export const FILLER_TRIM_MAX_TAIL_MS = 1500;

/**
 * **掐完不能空**:留下的不足这么长就**整段不掐**,原样用。
 * 这几句话最短的一句 862ms(think-5),200ms 以下必定是判错了 —— 那时宁可不快,也不能放一段空气。
 */
export const FILLER_TRIM_MIN_KEEP_MS = 200;

export interface FillerTrimOptions {
  sampleRate: number;
  thresholdDb?: number;
  headKeepMs?: number;
  tailKeepMs?: number;
  maxHeadMs?: number;
  maxTailMs?: number;
  minKeepMs?: number;
}

/** 掐到哪儿。`[start, end)` 是**样本下标**;`trimmed*Ms` 是给日志与用例看的数。 */
export interface FillerTrimRange {
  start: number;
  end: number;
  trimmedHeadMs: number;
  trimmedTailMs: number;
  /** 有没有真掐。false = 判不准或没必要,原样。 */
  trimmed: boolean;
}

function msToSamples(ms: number, sampleRate: number): number {
  return Math.max(0, Math.round((ms / 1000) * sampleRate));
}

/**
 * 头尾各该掐到哪儿。**纯函数**,喂一串 [-1,1] 的样本就行。
 *
 * 判不准的时候一律「原样不掐」,而不是大胆下刀 —— 这条贯穿全函数:
 *   - 整段都在阈值以下(全静音 / 全是底噪)→ 不掐;
 *   - 整段本来就比 {@link FILLER_TRIM_MIN_KEEP_MS} 短 → 不掐(短到这个地步先怀疑自己);
 *   - 掐完剩下的不足那么长 → 不掐。
 *
 * `NaN` 与 `Infinity` 当成静音:一个坏样本不该把整段的起点拽到 0。
 */
export function findTrimRange(samples: ArrayLike<number>, options: FillerTrimOptions): FillerTrimRange {
  const n = samples.length;
  const rate = options.sampleRate;
  const untrimmed: FillerTrimRange = { start: 0, end: n, trimmedHeadMs: 0, trimmedTailMs: 0, trimmed: false };
  if (n === 0 || !Number.isFinite(rate) || rate <= 0) return untrimmed;

  const minKeep = msToSamples(options.minKeepMs ?? FILLER_TRIM_MIN_KEEP_MS, rate);
  // 整段本来就比「最少留多少」还短:不掐。这种输入先怀疑是解码出了岔子。
  if (n < minKeep) return untrimmed;

  const amplitude = 10 ** ((options.thresholdDb ?? FILLER_TRIM_THRESHOLD_DB) / 20);
  const loud = (i: number): boolean => {
    const value = samples[i];
    return Number.isFinite(value) && Math.abs(value) >= amplitude;
  };

  let first = -1;
  for (let i = 0; i < n; i += 1) { if (loud(i)) { first = i; break; } }
  // 一整段都没过阈值:不掐。掐了就是一段空气 —— 「掐完不能空」的第一道。
  if (first < 0) return untrimmed;
  let last = first;
  for (let i = n - 1; i > first; i -= 1) { if (loud(i)) { last = i; break; } }

  const headKeep = msToSamples(options.headKeepMs ?? FILLER_TRIM_HEAD_KEEP_MS, rate);
  const tailKeep = msToSamples(options.tailKeepMs ?? FILLER_TRIM_TAIL_KEEP_MS, rate);
  const maxHead = msToSamples(options.maxHeadMs ?? FILLER_TRIM_MAX_HEAD_MS, rate);
  const maxTail = msToSamples(options.maxTailMs ?? FILLER_TRIM_MAX_TAIL_MS, rate);

  // 两端都掐,但各自有上限:掐过头多半是阈值判错,宁可留一点空白。
  const start = Math.min(Math.max(0, first - headKeep), maxHead);
  const end = Math.max(Math.min(n, last + 1 + tailKeep), n - maxTail);

  if (end - start < minKeep) return untrimmed;
  if (start === 0 && end === n) return untrimmed;

  return {
    start,
    end,
    trimmedHeadMs: (start / rate) * 1000,
    trimmedTailMs: ((n - end) / rate) * 1000,
    trimmed: true,
  };
}

/**
 * 多声道压成单声道(逐样本取平均)。缓冲语本来就是单声道
 * (构建脚本 `-ac 1`,火山大模型那条路也是单声道),这里只是**万一**:
 * 多一条声道就多一倍体积,而这几句话里没有一个字是立体声的。
 */
export function downmixToMono(channels: readonly ArrayLike<number>[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const first = channels[0];
  if (channels.length === 1) return first instanceof Float32Array ? first : Float32Array.from(first as ArrayLike<number>);
  const n = first.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (const channel of channels) {
      const value = channel[i];
      sum += Number.isFinite(value) ? value : 0;
    }
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * 封一个 16 位 PCM 的 WAV。**纯函数**。
 *
 * 为什么是 WAV 而不是原样的 mp3:掐静音必须先解码,解完手上是一串 PCM ——
 * 再编回 mp3 需要一个编码器(手机上没有),而 WAV 就是「加 44 字节的头」。
 */
export function encodeWav(samples: ArrayLike<number>, sampleRate: number): ArrayBuffer {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) {
    const value = samples[i];
    const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    // 负半轴 32768、正半轴 32767:不这么分,满幅的 1.0 会绕回成 -32768(一声「咔」)。
    // **要四舍五入**:setInt16 自己是向零截断,那会让每个样本系统性地少 1 个 LSB
    //(解码时是 /32768、编码时是 *32767,截断会把 117 变成 116 —— 一遍一遍地把波形往下削)。
    view.setInt16(44 + i * 2, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
  }
  return buffer;
}

export interface FillerTrimmedAudio {
  wav: ArrayBuffer;
  trimmedHeadMs: number;
  trimmedTailMs: number;
  trimmed: boolean;
}

/** 掐 + 封 WAV。纯函数,合成 {@link findTrimRange} 与 {@link encodeWav}。 */
export function trimSamplesToWav(samples: ArrayLike<number>, options: FillerTrimOptions): FillerTrimmedAudio {
  const range = findTrimRange(samples, options);
  const all = samples instanceof Float32Array ? samples : Float32Array.from(samples as ArrayLike<number>);
  const kept = range.trimmed ? all.slice(range.start, range.end) : all;
  return {
    wav: encodeWav(kept, options.sampleRate),
    trimmedHeadMs: range.trimmedHeadMs,
    trimmedTailMs: range.trimmedTailMs,
    trimmed: range.trimmed,
  };
}

/** 掐过之后的那一份。`trimmed=false` 时 `blob` 就是原来那个对象(一个字节都没动)。 */
export interface FillerTrimResult {
  blob: Blob;
  trimmedHeadMs: number;
  trimmedTailMs: number;
  trimmed: boolean;
}

export type FillerTrimmer = (blob: Blob) => Promise<FillerTrimResult>;

/** 解一次码。默认那一份用 `OfflineAudioContext`;测试注入假的。 */
export interface DecodedAudio {
  channels: readonly ArrayLike<number>[];
  sampleRate: number;
}
export type FillerAudioDecoder = (bytes: ArrayBuffer) => Promise<DecodedAudio>;

/** 解码用哪个采样率。24kHz 是火山那条路本来的采样率(构建脚本也是 `-ar 24000`),重采样等于没发生。 */
export const FILLER_DECODE_SAMPLE_RATE = 24000;

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => {
  decodeAudioData: (
    bytes: ArrayBuffer,
    ok?: (buffer: AudioBuffer) => void,
    fail?: (error: unknown) => void,
  ) => Promise<AudioBuffer> | undefined;
};

/**
 * `OfflineAudioContext` 那一份解码器。**没有它就返回 null** —— 调用方据此整个不掐。
 *
 * 用 offline 而不是 `new AudioContext()` 有两个实在的理由:
 *   - 它**不碰输出设备**,也就不受自动播放策略的「必须有用户手势」约束;
 *   - 它的采样率是我们指定的,解出来的长度是确定的(`AudioContext` 的率随设备变)。
 */
export function createOfflineDecoder(sampleRate = FILLER_DECODE_SAMPLE_RATE): FillerAudioDecoder | null {
  const ctor = (globalThis as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor })
    .OfflineAudioContext
    ?? (globalThis as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext;
  if (ctor === undefined) return null;
  return async (bytes) => {
    const context = new ctor(1, 1, sampleRate);
    const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      // 老 WebView 的 decodeAudioData 只有回调式,新的回 Promise —— 两样都接着。
      let settled = false;
      const ok = (buffer: AudioBuffer): void => { if (!settled) { settled = true; resolve(buffer); } };
      const fail = (error: unknown): void => {
        if (!settled) { settled = true; reject(error instanceof Error ? error : new Error('解码失败')); }
      };
      try {
        const maybe = context.decodeAudioData(bytes, ok, fail);
        if (maybe !== undefined && typeof maybe.then === 'function') void maybe.then(ok, fail);
      }
      catch (error) { fail(error); }
    });
    const channels: ArrayLike<number>[] = [];
    for (let i = 0; i < decoded.numberOfChannels; i += 1) channels.push(decoded.getChannelData(i));
    return { channels, sampleRate: decoded.sampleRate };
  };
}

export interface WebAudioTrimmerDeps {
  decode?: FillerAudioDecoder | null;
  options?: Omit<FillerTrimOptions, 'sampleRate'>;
  log?: (line: string) => void;
}

/**
 * 「合完就掐」的那一步。**永不抛** —— 掐不了就把原来那个 blob 原样还回去,
 * 行为退回到 0922 那一版(照样能放,只是晚 0.2–0.4 秒开口)。
 *
 * 解不开的情况是真会有的:老 WebView 不认某种容器、blob 是半截的、
 * 8792 因为某种原因回了别的东西。这几种都**不该带走一通电话**。
 */
/**
 * blob → 字节。**老 WebView(Chrome < 76)的 `Blob` 没有 `arrayBuffer()`**,
 * 那时退回 `FileReader`(它从一开始就在)。jsdom 里也走这一条,所以用例跑的是同一份代码。
 */
async function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return await blob.arrayBuffer();
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(reader.result as ArrayBuffer); };
    reader.onerror = () => { reject(reader.error ?? new Error('读不出这一份音频')); };
    reader.readAsArrayBuffer(blob);
  });
}

export function createWebAudioTrimmer(deps: WebAudioTrimmerDeps = {}): FillerTrimmer | null {
  const decode = deps.decode === undefined ? createOfflineDecoder() : deps.decode;
  if (decode === null) return null;
  const log = deps.log ?? (() => {});
  return async (blob) => {
    const untouched: FillerTrimResult = { blob, trimmedHeadMs: 0, trimmedTailMs: 0, trimmed: false };
    try {
      if (blob.size === 0) return untouched;
      const bytes = await readBytes(blob);
      if (bytes.byteLength === 0) return untouched;
      const decoded = await decode(bytes);
      const mono = downmixToMono(decoded.channels);
      if (mono.length === 0) return untouched;
      const result = trimSamplesToWav(mono, { ...deps.options, sampleRate: decoded.sampleRate });
      if (!result.trimmed) return untouched;
      return {
        blob: new Blob([result.wav], { type: 'audio/wav' }),
        trimmedHeadMs: result.trimmedHeadMs,
        trimmedTailMs: result.trimmedTailMs,
        trimmed: true,
      };
    }
    catch (error) {
      log(`[filler] 掐静音没成:${error instanceof Error ? error.message : String(error)},用原样那一份`);
      return untouched;
    }
  };
}

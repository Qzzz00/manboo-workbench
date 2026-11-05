/**
 * 会议录音器(2026-09-21)。**两条实现,原生优先**,和 `call/micPermission.ts` 同一套路数。
 *
 * ## 为什么必须有原生那条
 *
 * Ben 要的是「开会时手机录音」—— 开会的人会把手机扣在桌上、屏幕会灭。
 * 而 Android 一旦锁屏,WebView 里的 `MediaRecorder` 会被系统连同整个页面一起冻住:
 * 定时器停、`ondataavailable` 不再来,**录出来的是一段几十秒的残片**,
 * 而且页面上什么都不说。这不是"体验差一点",是整场会没了。
 *
 * 唯一的出路是 Android 的**前台服务**(带一条常驻通知 + `foregroundServiceType="microphone"`):
 * 系统据此判定这个进程还在替用户干活,于是不冻它。这件事**现成的 Capacitor 插件做不了**:
 * 官方 `@capacitor/*` 里没有录音;社区那几个录音插件(capacitor-voice-recorder 一类)
 * 录的是一整段、没有前台服务、也不分段。所以这里自己写了一件,照 `MicPermissionPlugin` 的先例
 * (`android/app/src/main/java/ai/ben/butler/MeetingRecorderPlugin.java` + `MeetingRecorderService.java`)。
 *
 * ## 退路:WebView 的 MediaRecorder
 *
 * 浏览器里调试、以及万一原生那件没登记上(装的是旧包)时走它。**它锁屏就停**,
 * 所以界面上那句话必须换成 {@link MEETING_NO_BACKGROUND_TEXT} —— 不能让人以为扣着屏幕也在录。
 *
 * ## 分段为什么是「停一个、起一个」
 *
 * `MediaRecorder.start(timeslice)` 给出来的分片**不是各自完整的文件**:webm 只有第一片带头,
 * m4a 的 moov 在最后。拿这种分片去解码,第二片起全是垃圾。所以每到十分钟就
 * **stop 当前这个、立刻 start 下一个**,代价是两段之间有几十毫秒的空档(交接第三节记着)。
 */
import { registerPlugin } from '@capacitor/core';
import { SEGMENT_MS, type RecordedSegment } from './meetingModel';

export interface MeetingRecorderStart {
  /** 一段多长。缺省 {@link SEGMENT_MS};测试调小。 */
  segmentMs?: number;
  /** 一段录完了(或者「结束」时把最后一段吐出来)。**同步收好**,别在这里 await 网络。 */
  onSegment: (segment: RecordedSegment) => void;
  /** 出事了,一句人话。录音已经停了。 */
  onError: (message: string) => void;
}

export interface MeetingRecording {
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** 停,并把最后一段吐出来(经 onSegment)。**幂等**。 */
  stop: () => Promise<void>;
  /** 此刻的音量(0~1)。界面按帧读它,不走 setState。 */
  level: () => number;
  /** 走的是哪条。界面据此说「屏幕可以关」还是「别锁屏」。 */
  readonly via: 'native' | 'webview';
  /** 原生那条落盘的目录(待传箱记着它,App 重开时补认没报上来的段)。WebView 那条没有。 */
  readonly dir?: string;
}

/* ——— 原生那条 ——— */

interface NativeSegmentEvent { seq?: number; path?: string; ms?: number; mimeType?: string }

/** 前台服务此刻的样子(2026-10-09):App 被划掉 / 被杀又重开时,看它还在不在录。 */
export interface NativeRecorderStatus { recording?: boolean; paused?: boolean; seq?: number; dir?: string }

interface MeetingRecorderNative {
  start(options: { segmentMs: number }): Promise<{ dir?: string }>;
  /** 10-09 之前的包没有它(调它就抛)。 */
  status(): Promise<NativeRecorderStatus>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  level(): Promise<{ level?: number }>;
  addListener(event: 'segment', handler: (data: NativeSegmentEvent) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(event: 'error', handler: (data: { message?: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

/** `registerPlugin` 本身不抛;没实现是**调它的方法**才抛,所以每一次调用都包着。 */
const NativeMeetingRecorder = registerPlugin<MeetingRecorderNative>('MeetingRecorder');

export interface MeetingRecorderDeps {
  /** 测试注入假的原生插件;传 null = 这台设备上没有原生那条。 */
  native?: MeetingRecorderNative | null;
  /** 测试注入假的 getUserMedia;传 null = 连它也没有。 */
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  /** 测试注入假的 MediaRecorder 构造器。 */
  mediaRecorder?: typeof MediaRecorder | null;
  /** 测试注入假的 AudioContext(算电平用)。传 null = 不算电平(电平条不动,录音照旧)。 */
  audioContext?: (new () => AudioContext) | null;
  /** `stop()` 等最后一段多久(毫秒)。缺省 {@link STOP_GRACE_MS};测试调小。 */
  stopGraceMs?: number;
}

/**
 * `stop()` 之后等最后一段多久。
 *
 * **最后一段是 `stop()` 触发的**,而它要从原生那边过一趟 Capacitor 的桥(WebView 那条要把字节读出来);
 * 不等就返回的话,上层以为"都传完了"于是去 `finish()`,**结果电脑那边少了最后十分钟**
 * —— 那是这条链路上最难查的一种错(纪要看着是完整的,就是结尾没了)。
 * 所以 `stop()` **一定要等到最后那一段真的交到 onSegment 手里**才返回。
 */
export const STOP_GRACE_MS = 1500;

/**
 * 开录。**绝不抛**:起不来就是一次 `onError` + 返回 null,由界面说清楚。
 */
export async function startMeetingRecording(
  input: MeetingRecorderStart,
  deps: MeetingRecorderDeps = {},
): Promise<MeetingRecording | null> {
  const segmentMs = input.segmentMs ?? SEGMENT_MS;
  const native = deps.native === undefined ? NativeMeetingRecorder : deps.native;
  if (native !== null) {
    const started = await startNative(native, { ...input, segmentMs }, deps);
    if (started !== null) return started;
    // 原生那条没接上(装的是旧包、或者跑在浏览器里):退回下面那条,不在这儿放弃。
  }
  return await startWeb({ ...input, segmentMs }, deps);
}

async function startNative(
  native: MeetingRecorderNative,
  input: MeetingRecorderStart & { segmentMs: number },
  deps: MeetingRecorderDeps,
): Promise<MeetingRecording | null> {
  return await wireNative(native, input, deps, async () => (await native.start({ segmentMs: input.segmentMs })).dir);
}

/**
 * **App 重开时接回还在录的前台服务**(2026-10-09)。从最近任务里划掉 App、或者系统回收了网页那一半,
 * 前台服务可能还在录;重开之后这里接上监听(不再 start 一遍),会议页回到「在录」。
 * 服务没在录、旧包没有 `status`、根本没有原生那条,都回 null。
 */
export async function attachMeetingRecording(
  input: MeetingRecorderStart,
  deps: MeetingRecorderDeps = {},
): Promise<{ recording: MeetingRecording; status: { paused: boolean; seq?: number; dir?: string } } | null> {
  const native = deps.native === undefined ? NativeMeetingRecorder : deps.native;
  if (native === null) return null;
  let status: NativeRecorderStatus;
  try { status = await native.status(); } catch { return null; }
  if (status.recording !== true) return null;
  const recording = await wireNative(native, { ...input, segmentMs: input.segmentMs ?? SEGMENT_MS }, deps, async () => status.dir);
  if (recording === null) return null;
  return {
    recording,
    status: {
      paused: status.paused === true,
      ...(typeof status.seq === 'number' ? { seq: status.seq } : {}),
      ...(typeof status.dir === 'string' ? { dir: status.dir } : {}),
    },
  };
}

/** 挂上两条监听,再 `begin`(开录或者只是接回)。起不来回 null。 */
async function wireNative(
  native: MeetingRecorderNative,
  input: MeetingRecorderStart & { segmentMs: number },
  deps: MeetingRecorderDeps,
  begin: () => Promise<string | undefined>,
): Promise<MeetingRecording | null> {
  const grace = deps.stopGraceMs ?? STOP_GRACE_MS;
  /** 报上来几段了。`stop()` 等它多一个(最后那一段),不然最后一段会丢。 */
  let delivered = 0;
  let segmentSub: { remove: () => Promise<void> } | undefined;
  let errorSub: { remove: () => Promise<void> } | undefined;
  let dir: string | undefined;
  try {
    segmentSub = await native.addListener('segment', (data) => {
      const seq = typeof data.seq === 'number' ? data.seq : 0;
      const path = typeof data.path === 'string' ? data.path : '';
      if (seq < 1 || path === '') return;
      delivered += 1;
      // 只交路径:文件已经在 App 的文件目录里了,待传箱要传时才读(一段几 MB,不当场读进内存)。
      input.onSegment({ seq, path, mimeType: data.mimeType ?? 'audio/mp4', ms: typeof data.ms === 'number' ? data.ms : 0 });
    });
    errorSub = await native.addListener('error', (data) => { input.onError(data.message ?? '录音出错了'); });
    dir = await begin();
  } catch {
    void segmentSub?.remove().catch(() => {});
    void errorSub?.remove().catch(() => {});
    return null;
  }

  let stopped = false;
  let level = 0;
  const timer = setInterval(() => {
    void native.level().then((res) => { level = typeof res.level === 'number' ? res.level : 0; }).catch(() => { level = 0; });
  }, 120);

  return {
    via: 'native',
    ...(dir === undefined ? {} : { dir }),
    async pause() { try { await native.pause(); } catch { /* 暂停不了就还在录,界面下一拍会看出来 */ } },
    async resume() { try { await native.resume(); } catch { /* 同上 */ } },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const before = delivered;
      try { await native.stop(); } catch { /* 停不掉也别抛:最后一段可能已经吐出来了 */ }
      // 等最后那一段过桥(见 STOP_GRACE_MS)。它一到就不用再等满这段时间。
      const waited = Date.now();
      while (delivered === before && Date.now() - waited < grace) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      void segmentSub?.remove().catch(() => {});
      void errorSub?.remove().catch(() => {});
    },
    level: () => level,
  };
}

/* ——— WebView 那条退路 ——— */

/** 选 MediaRecorder 的格式:优先 mp4(aac)—— macOS 自带的 afconvert 解得开它,webm 只有 ffmpeg 解得开。 */
export function pickMeetingMimeType(MR: { isTypeSupported(t: string): boolean } | undefined): string | undefined {
  if (MR === undefined) return undefined;
  for (const candidate of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    try { if (MR.isTypeSupported(candidate)) return candidate; }
    catch { /* 有的实现对没见过的串会抛 */ }
  }
  return undefined;
}

async function startWeb(
  input: MeetingRecorderStart & { segmentMs: number },
  deps: MeetingRecorderDeps,
): Promise<MeetingRecording | null> {
  const getUserMedia = deps.getUserMedia === undefined
    ? (globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices) ?? null)
    : deps.getUserMedia;
  if (getUserMedia === null) { input.onError('这台设备上取不到麦克风'); return null; }
  const Recorder = deps.mediaRecorder === undefined
    ? (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder
    : (deps.mediaRecorder ?? undefined);
  if (Recorder === undefined) { input.onError('这台设备上没有录音能力(没有 MediaRecorder)'); return null; }

  let stream: MediaStream;
  try { stream = await getUserMedia({ audio: true }); }
  catch (err) {
    input.onError(err instanceof Error && err.name === 'NotAllowedError' ? '没有录音权限,会议录不了' : '打不开麦克风');
    return null;
  }

  const Make = Recorder;
  const mimeType = pickMeetingMimeType(Make as unknown as { isTypeSupported(t: string): boolean });
  let seq = 0;
  let recorder: MediaRecorder | undefined;
  let chunks: Blob[] = [];
  let segmentStart = Date.now();
  let stopped = false;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  /** 还在「读字节」路上的那几段。`stop()` 要等它们(同原生那条的理由,见 STOP_GRACE_MS)。 */
  const reading: Promise<void>[] = [];

  const meter = startMeter(stream, deps);

  /**
   * 把攒下的分片封成一段。**整个函数绝不抛** —— 它是从 `recorder.onstop` 里调的,
   * 而那一层又是从 `recorder.stop()` 里同步调的:这里抛一下,轮换就断在半路,
   * 后面整场会都不再录(jsdom 里就踩到过:那一版没有 `Blob.arrayBuffer`)。
   */
  function flush(): void {
    if (chunks.length === 0) return;
    let blob: Blob;
    try { blob = new Blob(chunks, mimeType === undefined ? {} : { type: mimeType }); }
    catch { input.onError('这一段封不起来'); chunks = []; return; }
    const ms = Date.now() - segmentStart;
    chunks = [];
    seq += 1;
    const at = seq;
    reading.push(blobBytes(blob).then((bytes) => {
      input.onSegment({ seq: at, bytes, mimeType: blob.type === '' ? 'audio/webm' : blob.type, ms });
    }).catch(() => { input.onError(`第 ${at} 段读不出来`); }));
  }

  function startOne(): void {
    if (stopped) return;
    try {
      recorder = new Make(stream, mimeType === undefined ? undefined : { mimeType });
    } catch {
      input.onError('起不了录音(这台设备不支持要的格式)');
      return;
    }
    chunks = [];
    segmentStart = Date.now();
    recorder.ondataavailable = (event: BlobEvent) => { if (event.data.size > 0) chunks.push(event.data); };
    recorder.onerror = () => { input.onError('录音出错了'); };
    // 每到十分钟 stop 一次再起一个:这样每一段都是**各自完整**的文件(见文件头)。
    // 包一层:`onstop` 是同步从 `recorder.stop()` 里调的,这里抛一下会让轮换断在半路。
    recorder.onstop = () => { try { flush(); } catch { input.onError('这一段封不起来'); } if (!stopped) startOne(); };
    try { recorder.start(); }
    catch { input.onError('起不了录音'); return; }
    rotation = setTimeout(() => { try { recorder?.stop(); } catch { /* 已经停了 */ } }, input.segmentMs);
  }

  startOne();

  return {
    via: 'webview',
    async pause() {
      if (rotation !== undefined) clearTimeout(rotation);
      try { recorder?.pause(); } catch { /* 有的 WebView 没有 pause:那就还在录,如实由界面显示 */ }
    },
    async resume() {
      try { recorder?.resume(); } catch { /* 同上 */ }
      // 续上剩下的那点时间太啰嗦,直接重新计一整段:多录一会儿不会丢东西。
      rotation = setTimeout(() => { try { recorder?.stop(); } catch { /* 已经停了 */ } }, input.segmentMs);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (rotation !== undefined) clearTimeout(rotation);
      meter.stop();
      try {
        if (recorder !== undefined && recorder.state !== 'inactive') recorder.stop();
        else flush();
      } catch { flush(); }
      // 等最后那一段的字节真的读出来再返回(见 STOP_GRACE_MS)。
      await Promise.allSettled(reading);
      for (const track of stream.getTracks?.() ?? []) { try { track.stop(); } catch { /* 停不掉不影响 */ } }
    },
    level: () => meter.level(),
  };
}

/**
 * Blob → 字节。`arrayBuffer()` 是首选,没有它(老 WebView、jsdom)就退回 FileReader。
 * 两条都没有才算真失败 —— 失败的后果是**这一段传不上去**,所以退路值得写。
 */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then(buffer => new Uint8Array(buffer));
  }
  const Reader = (globalThis as unknown as { FileReader?: typeof FileReader }).FileReader;
  if (Reader === undefined) return Promise.reject(new Error('这台设备上读不出录音字节'));
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
      else reject(new Error('读出来的不是字节'));
    };
    reader.onerror = () => reject(new Error('读录音字节失败'));
    reader.readAsArrayBuffer(blob);
  });
}

/** 电平表。算不出来就一直是 0 —— 电平条不动,**录音照旧**(它只是好看)。 */
function startMeter(stream: MediaStream, deps: MeetingRecorderDeps): { level: () => number; stop: () => void } {
  const Ctx = deps.audioContext === undefined
    ? (globalThis as unknown as { AudioContext?: new () => AudioContext }).AudioContext
    : (deps.audioContext ?? undefined);
  if (Ctx === undefined) return { level: () => 0, stop: () => {} };
  let value = 0;
  let ctx: AudioContext;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    // 用 setInterval 而不是 rAF:这一页在后台时 rAF 完全不跑,而电平条本来就该在那时候停。
    timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = ((buf[i] ?? 128) - 128) / 128; sum += v * v; }
      value = Math.sqrt(sum / buf.length);
    }, 100);
  } catch {
    return { level: () => 0, stop: () => {} };
  }
  return {
    level: () => value,
    stop: () => { if (timer !== undefined) clearInterval(timer); try { void ctx.close(); } catch { /* 关不掉也无所谓 */ } },
  };
}

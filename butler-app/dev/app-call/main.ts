/**
 * 真 App 的通话代码在无头 Chrome 里打一通电话(2026-09-25,卡 fix/evening-gaps 返工)。
 *
 * 统筹 0.2.95 真机:小米点「通话」一直「正在接通…」,工人一条开始通话的记录都没有。
 * 压测工具原来那台假手机(rtc-node)是照着协议**另写**的一台手机,手机包里的接通顺序它一行都没跑 ——
 * 这一页跑的是 `src/` 里原样那几份:
 *   - 通道层 `createWbchChannel`(凭证、核对房间、通话持有);
 *   - 房间连接 `createWbchRoomLink` + 真的 livekit-client;
 *   - 通话状态机 `createWbchCallClient`(问权限 → 进房 → 等工人 → 请工人接起 → 接通 → 开麦 → 挂断;
 *     0.2.95 那一版是「开麦」排在「请工人接起」之前)。
 * 只有三样是假的:8791(load-call 起的假工作台,凭证由它签)、麦克风(AudioContext 放一段录好的话)、
 * 凭证存储(内存)。
 *
 * 由 channel-worker/dev/load-call.ts --phone app 起,经 CDP 调 `window.__app`;不单独用。
 * 配置在地址的 `#` 后面(JSON):见 {@link HarnessConfig}。
 */
// `app-src` = butler-app/src(缺省);量「改前」时 load-call 用 --app-src 指到解出来的另一份(见 vite.config.mjs)。
import { createApiClient } from 'app-src/api/client';
import { createWbchChannel } from 'app-src/channel/channel';
import type { WbchCredential } from 'app-src/channel/credentialStore';
import { createWbchRoomLink, type WbchRoomLink } from 'app-src/channel/roomLink';
import { createWbchCallClient } from 'app-src/call/livekitCall';
import type { CallEvents } from 'app-src/call/rtcCall';

interface HarnessConfig {
  /** 假 8791 的地址(`host` / `port`),凭证与那段录好的话都从它拿。 */
  wb: { host: string; port: number };
  /** 设备令牌(假 8791 不查,只看有没有)与设备号(进房身份 = wb-phone-<deviceId>)。 */
  deviceToken: string;
  deviceId: string;
  /**
   * 麦克风:
   *   - `fake`(缺省):一路 AudioContext,`speak()` 往里放那段录好的话,平时是静的;
   *   - `silent-suspended`:统筹真机那一招 —— getUserMedia 换成一个**没有手势就建的** AudioContext 的静音轨道
   *     (无头 Chrome 不带自动播放开关时它是 suspended,和 Android WebView 里从调试口建的一样)。
   */
  gum?: 'fake' | 'silent-suspended';
  /** 首页常驻房间(App 冷启动后 useIncoming 就 holdForRing)。缺省 true。 */
  hold?: boolean;
  /**
   * 模拟「发布麦克风卡住」:`setMicrophoneEnabled(true)` 永远不回(网络慢时 livekit 自己的协商重试能拖一分多钟,
   * 这里干脆不回)。量 0.2.95 小米那一种「一直正在接通…、工人一条开始通话的记录都没有」。
   */
  stallMic?: boolean;
}

const config = JSON.parse(decodeURIComponent(location.hash.slice(1))) as HarnessConfig;
const out = document.getElementById('out') as HTMLElement;

// ———————————————————————— 时间线:每一步什么时候开始、什么时候回来 ————————————————————————

const trace: { at: number; what: string }[] = [];
function mark(what: string): void {
  trace.push({ at: Date.now(), what });
  out.textContent = trace.slice(-40).map(row => `${new Date(row.at).toISOString().slice(11, 23)} ${row.what}`).join('\n');
}
function short(value: unknown): string {
  if (value === undefined) return '';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? '' : text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch { return String(value); }
}
/** 给一个对象上的方法套一层「开始 / 回来 / 抛了」的记号。**不改行为**:原样调、原样回、原样抛。 */
function traced(target: Record<string, unknown>, name: string, label: string): void {
  const original = target[name];
  if (typeof original !== 'function') return;
  const bound = (original as (...a: unknown[]) => unknown).bind(target);
  target[name] = (...argv: unknown[]) => {
    mark(`${label} …`);
    let result: unknown;
    try { result = bound(...argv); }
    catch (error) { mark(`${label} 抛了:${(error as Error)?.message ?? String(error)}`); throw error; }
    if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).then(
        (value) => { mark(`${label} 回了 ${short(value)}`); return value; },
        (error: unknown) => { mark(`${label} 抛了:${(error as Error)?.message ?? String(error)}`); throw error; },
      );
    }
    mark(`${label} 回了 ${short(result)}`);
    return result;
  };
}

// ———————————————————————— 假麦克风 ————————————————————————

let micContext: AudioContext | null = null;
let micSink: MediaStreamAudioDestinationNode | null = null;
let utterance: AudioBuffer | null = null;
/** 发出去的麦克风轨道(看挂断之后它停没停)。 */
const micTracks: MediaStreamTrack[] = [];

async function loadUtterance(): Promise<void> {
  if (micContext === null) return;
  const res = await fetch(`http://${config.wb.host}:${config.wb.port}/__utterance.wav`);
  utterance = await micContext.decodeAudioData(await res.arrayBuffer());
}

if (navigator.mediaDevices === undefined) throw new Error('这个浏览器没有 mediaDevices');
if ((config.gum ?? 'fake') === 'fake') {
  micContext = new AudioContext({ sampleRate: 48000 });
  micSink = micContext.createMediaStreamDestination();
  navigator.mediaDevices.getUserMedia = async () => {
    mark('getUserMedia(假麦克风)');
    await micContext?.resume();
    const [base] = (micSink as MediaStreamAudioDestinationNode).stream.getAudioTracks();
    if (base === undefined) throw new Error('假麦克风没有轨道');
    const track = base.clone();
    micTracks.push(track);
    return new MediaStream([track]);
  };
} else {
  navigator.mediaDevices.getUserMedia = async () => {
    mark('getUserMedia(统筹那一招:没有手势就建的 AudioContext 静音轨道)');
    const context = new AudioContext();
    mark(`  那个 AudioContext 是 ${context.state}`);
    const stream = context.createMediaStreamDestination().stream;
    for (const track of stream.getAudioTracks()) micTracks.push(track);
    return stream;
  };
}

/** 往麦克风里放那段录好的话;回的是放完那一刻。 */
async function speak(): Promise<number> {
  if (micContext === null || micSink === null || utterance === null) throw new Error('这一种麦克风放不了话');
  const source = micContext.createBufferSource();
  source.buffer = utterance;
  source.connect(micSink);
  const ended = new Promise<void>(resolve => { source.onended = () => resolve(); });
  source.start();
  mark('他开口(假麦克风放那段录好的话)');
  await ended;
  mark('他说完');
  return Date.now();
}

// ———————————————————————— 她的声音:远端音轨上量能量 ————————————————————————

const voice = { speaking: false, lastLoudAt: 0, loudStarts: [] as number[] };
let voiceContext: AudioContext | null = null;
function listenTo(element: HTMLMediaElement): void {
  const stream = (element as HTMLMediaElement & { srcObject: MediaStream | null }).srcObject;
  if (stream === null || stream.getAudioTracks().length === 0) return;
  voiceContext = voiceContext ?? new AudioContext();
  void voiceContext.resume();
  const analyser = voiceContext.createAnalyser();
  analyser.fftSize = 512;
  voiceContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let loud = 0;
  let quiet = 0;
  setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const x of samples) sum += x * x;
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    if (rms > 0.01) {
      loud += 1; quiet = 0; voice.lastLoudAt = now;
      if (!voice.speaking && loud >= 3) { voice.speaking = true; voice.loudStarts.push(now - 20); mark('她出声了(远端音轨有能量)'); }
    } else {
      quiet += 1; loud = 0;
      if (voice.speaking && quiet >= 80) { voice.speaking = false; mark('她停了'); }
    }
  }, 10);
}

// ———————————————————————— 通道层 + 通话:src/ 里那几份原样 ————————————————————————

const link: WbchRoomLink = createWbchRoomLink({
  // 与 App 缺省那一份同样挂到页面上(roomLink 的 defaultAttach),多一步:量她的声音。
  attachAudio: (element) => {
    element.setAttribute('data-wbch', 'remote-audio');
    (element as HTMLAudioElement).autoplay = true;
    document.body.appendChild(element);
    if (!element.muted) void element.play?.().catch(() => {});
    listenTo(element);
  },
  detachAudio: (element) => { element.remove(); },
});
if (config.stallMic === true) {
  const original = link.setMicrophoneEnabled.bind(link);
  link.setMicrophoneEnabled = (enabled: boolean) => {
    if (!enabled) return original(false);
    mark('(模拟)发布麦克风卡住:这一下永远不回');
    return new Promise<boolean>(() => {});
  };
}
for (const name of ['acquire', 'release', 'switchRoom', 'setMicrophoneEnabled', 'stopMicrophone', 'setSpeakerEnabled', 'sendText']) {
  traced(link as unknown as Record<string, unknown>, name, `房间.${name}`);
}
link.listen({
  onWorker: (present) => mark(`房里的工人 ${present ? '在' : '不在'}`),
  onState: (state) => mark(`房间连接 ${state}`),
});

let saved: WbchCredential | null = null;
const direct = createApiClient({
  pairing: { token: config.deviceToken, host: config.wb.host, port: config.wb.port, deviceId: config.deviceId },
  onUnauthorized: () => mark('8791 说设备令牌失效'),
});
const channel = createWbchChannel({
  direct,
  store: {
    load: async () => saved,
    save: async (next: WbchCredential) => { saved = next; },
    clear: async () => { saved = null; },
  },
  onUnauthorized: () => mark('通道层说设备令牌失效'),
  expectedIdentity: `wb-phone-${config.deviceId}`,
  link,
});
for (const name of ['holdForRing', 'acquireCall', 'releaseCall', 'recheckRoom', 'callStart', 'hangupCall', 'onboarding']) {
  traced(channel as unknown as Record<string, unknown>, name, `通道.${name}`);
}
channel.onCaption((caption) => { if (caption.final) mark(`字幕(${caption.role === 'me' ? '他' : '她'}):${caption.text}`); });

const call = createWbchCallClient({
  channel,
  createFiller: () => null,
  createVoiceCache: () => null,
  // 通话状态机自己记的那几行(2026-09-25 返工后才有;老版本不认这个参数)。
  trace: (line: string) => mark(`[通话] ${line}`),
} as Parameters<typeof createWbchCallClient>[0]);

const state = {
  phase: 'idle' as string,
  error: undefined as string | undefined,
  lines: [] as { who: string; text: string }[],
  connectedAt: undefined as number | undefined,
  /** 通话页上「麦克风没打开 / 没有录音权限」那一行(没有就是 null)。 */
  micNotice: null as string | null,
};
const events: CallEvents = {
  onPhase: (phase, detail) => {
    state.phase = phase;
    state.error = detail?.error;
    if (phase === 'connected') state.connectedAt = Date.now();
    mark(`界面:${phase === 'connecting' ? '正在接通…' : phase === 'connected' ? '接通了' : phase === 'error' ? `接不通 ——「${detail?.error ?? ''}」` : phase}`);
  },
  onUtterance: (entry) => { state.lines.push(entry); },
  onInterim: () => {},
  onBotSpeaking: () => {},
  onMicSpeaking: () => {},
  onMicPermission: (result) => { state.micNotice = result.granted ? null : (result.text ?? '没有录音权限'); mark(`麦克风那一行:${result.granted ? '(没有,权限给了)' : result.text ?? '没有录音权限'}`); },
  onLeader: (leader) => mark(`引导归${leader === 'phone' ? '手机' : '电脑'}`),
  onRemoteHangup: () => mark('电脑那边挂了'),
};

declare global {
  interface Window { __app: unknown }
}

window.__app = {
  ready: true,
  async hold() {
    if (config.hold === false) return { ok: true, skipped: true };
    return channel.holdForRing();
  },
  /** 点「通话」。**不等接通**:接通与否看 state()。 */
  start(kind: 'normal' | 'onboarding') {
    mark(`点「${kind === 'onboarding' ? '引导' : '通话'}」`);
    void call.start(kind === 'onboarding' ? { onboarding: { resume: true } } : {}, events);
    return true;
  },
  async speak() { return speak(); },
  /** 打字问一句(通话页的输入框;普通电话没有这个框,只有引导那一通有)。 */
  async say(text: string) {
    mark(`他打字:${text}`);
    const sent = await call.sayText?.(text);
    return sent ?? { ok: false, error: '这一通不能打字' };
  },
  async hangup() {
    mark('点「挂断」');
    const result = await call.hangup();
    mark(`挂断完了(${result.durationSeconds ?? '?'} 秒)`);
    return { durationSeconds: result.durationSeconds ?? null };
  },
  state() {
    return {
      phase: state.phase,
      error: state.error ?? null,
      connectedAt: state.connectedAt ?? null,
      lines: state.lines,
      mic_tracks: micTracks.map(track => track.readyState),
      mic_notice: state.micNotice,
      voice: { speaking: voice.speaking, lastLoudAt: voice.lastLoudAt, loudStarts: voice.loudStarts },
    };
  },
  trace() { return trace; },
};

void loadUtterance().then(() => mark('页面好了')).catch((error: unknown) => mark(`那段录好的话没取到:${String(error)}`));

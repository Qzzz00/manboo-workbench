/**
 * 会议控制器(2026-10-09,卡「会后真机走通」)。
 *
 * 09-21 那一版的录音、分段队列都挂在会议页上:页面一卸载(来电页压上来、转屏、Shell 重挂),
 * cleanup 就把录音停了 —— 电话一响,会就不录了。现在**录音的生命挂在会话上**(session.ts 建一个),
 * 会议页只是它的一张脸:
 *
 * - 来电照常响、照常接,会议页被卸下,这里照录、分段照传;挂断后 Shell 看 `active()` 回到会议页,还是同一场;
 * - 分段一到先记进待传箱(meetingOutbox.ts,落在 Preferences),在家直连、出门攒着(她这一场同意才走中转);
 * - App 被划掉 / 被杀又重开:`boot()` 先看前台服务还在不在录 —— 在,就接回同一场(同一个编号、同一个开录时刻),
 *   顺手补认重开前录完却没报上来的段;不在,就是「录到一半断了」,录到的段收尾传完再整理。
 *
 * 不碰 React、不碰真的录音器与网络:那几样都从 deps 进来(生产的接法在 session.ts 的 meetingControllerFor)。
 */
import type { MeetingOutbox, OutboxView } from './meetingOutbox';
import type { RecordedSegment } from './meetingModel';
import { SEGMENT_MS } from './meetingModel';
import type { MeetingRecorderStart, MeetingRecording } from './recorder';

export type MeetingControllerPhase =
  | { kind: 'idle' }
  /** 正在问权限 / 起录音。 */
  | { kind: 'starting' }
  | { kind: 'recording' }
  | { kind: 'paused' }
  /** 按了「结束」,还有段没传上去(或者电脑那边还没收尾)。 */
  | { kind: 'uploading' }
  /** 电脑在转写 / 梳理(会议页轮询它)。 */
  | { kind: 'working'; serverId: string }
  /** 上次录到一半,App 连同前台服务一起没了。录到的段都在手机上,等她点「收尾」。 */
  | { kind: 'interrupted' }
  | { kind: 'failed'; error: string; micFix?: boolean };

export interface MeetingUploadState {
  pending: number;
  sent: number;
  /** 够不着电脑(在外面)。会议页据此摆「现在经服务器传」。 */
  offline: boolean;
  /** 这一场她点过「现在经服务器传」。 */
  viaRelay: boolean;
  error?: string;
}

export interface MeetingControllerState {
  phase: MeetingControllerPhase;
  /** 手机给这一场编的号(待传箱的 key)。 */
  key?: string;
  title: string;
  /** 开录那一刻(毫秒)。 */
  startedAt?: number;
  via?: 'native' | 'webview';
  /** 一句话(录音器报的错之类)。 */
  note?: string;
  upload: MeetingUploadState;
}

export interface MeetingControllerDeps {
  outbox: MeetingOutbox;
  startRecording: (input: MeetingRecorderStart) => Promise<MeetingRecording | null>;
  /** 接回还在录的前台服务(recorder.ts 的 attachMeetingRecording)。 */
  attachRecording: (input: MeetingRecorderStart) => Promise<{ recording: MeetingRecording; status: { paused: boolean; seq?: number; dir?: string } } | null>;
  ensureMic: () => Promise<{ granted: boolean; needsSettings?: boolean; error?: string }>;
  /** WebView 退路给的字节写成手机上的文件,回它的路径。 */
  saveSegment: (key: string, segment: RecordedSegment & { bytes: Uint8Array }) => Promise<string>;
  /** 原生落盘目录里有哪些文件(只要文件名)。读不了回空。 */
  listDir: (dir: string) => Promise<string[]>;
  newKey: () => string;
  now?: () => number;
  segmentMs?: number;
  /** 有没传完的,隔多久再试一次。0 = 不起定时器(测试)。缺省 30 秒。 */
  retryEveryMs?: number;
  /** 网络变了喊一声(回家了就马上传)。 */
  networkChanges?: (listener: () => void) => () => void;
}

export interface MeetingController {
  get: () => MeetingControllerState;
  subscribe: (listener: () => void) => () => void;
  /** 读账、接回 / 认出上一场、起重试。幂等。 */
  boot: () => Promise<void>;
  /** 开录。`planId` = 会前登记过的那一场(2026-10-10),录音接到同一个会议对象上。 */
  begin: (title: string, planId?: string) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** 「结束」(录到一半断了那一场的「收尾」也是它)。 */
  finish: (title: string) => Promise<void>;
  retryUpload: () => Promise<void>;
  /** 「现在经服务器传」:这一场之后的段走中转。 */
  allowRelay: () => Promise<void>;
  /** 会议页关掉时:整理中 / 失败那一场从这张脸上放下(电脑收件箱还有它),下次进来是一场新的。 */
  release: () => void;
  /** 录了多久(扣掉暂停)。 */
  elapsed: () => number;
  level: () => number;
  /** 这一场还占着会议页(在录 / 暂停 / 在传 / 断了没收尾):Shell 据此挂断后回到会议页、重开后直接进会议页。 */
  active: () => boolean;
  /** 待传箱的账变了(待传箱的 onChange 接这里)。 */
  sync: () => void;
}

const DEFAULT_RETRY_MS = 30_000;

/** `03.m4a` → 3。认不出来回 undefined。 */
function seqOfFile(name: string): number | undefined {
  const match = /^(\d+)\.(m4a|mp4|webm|wav)$/i.exec(name);
  if (match === null) return undefined;
  const seq = Number(match[1]);
  return Number.isInteger(seq) && seq > 0 ? seq : undefined;
}

export function createMeetingController(deps: MeetingControllerDeps): MeetingController {
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let state: MeetingControllerState = { phase: { kind: 'idle' }, title: '', upload: { pending: 0, sent: 0, offline: false, viaRelay: false } };
  let recording: MeetingRecording | null = null;
  let pausedMs = 0;
  let pausedAt: number | undefined;
  /** WebView 那几段还在写文件的路上。「结束」要等它们写完才收尾,不然最后一段进不了账。 */
  let saving: Promise<void>[] = [];
  let booted: Promise<void> | undefined;

  function set(patch: Partial<MeetingControllerState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) { try { listener(); } catch { /* 一张脸抛不该拦住录音 */ } }
  }

  function uploadOf(view: OutboxView | undefined): MeetingUploadState {
    if (view === undefined) return { pending: 0, sent: 0, offline: false, viaRelay: false };
    return { pending: view.pending, sent: view.sent, offline: view.offline, viaRelay: view.viaRelay, ...(view.error === undefined ? {} : { error: view.error }) };
  }

  function sync(): void {
    const key = state.key;
    if (key === undefined) return;
    const view = deps.outbox.view(key);
    const patch: Partial<MeetingControllerState> = { upload: uploadOf(view) };
    // 电脑那边也收尾了:这一场传完,会议页转去轮询整理进度。
    if (view?.finished === true && view.serverId !== undefined && (state.phase.kind === 'uploading' || state.phase.kind === 'interrupted')) {
      patch.phase = { kind: 'working', serverId: view.serverId };
    }
    set(patch);
  }

  function pump(): Promise<void> {
    return deps.outbox.pump().catch(() => undefined);
  }

  /** 一段到了:有路径直接记账;只有字节(WebView 退路)先写成文件。然后试着传。 */
  function take(key: string, segment: RecordedSegment): void {
    const job = (async () => {
      let path = segment.path;
      if (path === undefined) {
        if (segment.bytes === undefined || segment.bytes.length === 0) return;
        try { path = await deps.saveSegment(key, { ...segment, bytes: segment.bytes }); }
        catch (err) { set({ note: `第 ${segment.seq} 段存不到手机上:${err instanceof Error ? err.message : '没说原因'}` }); return; }
      }
      await deps.outbox.addSegment(key, { seq: segment.seq, path, ms: segment.ms, mimeType: segment.mimeType });
      void pump();
    })();
    saving.push(job);
    void job.finally(() => { saving = saving.filter(one => one !== job); });
  }

  function recorderInput(key: string): MeetingRecorderStart {
    return {
      segmentMs: deps.segmentMs ?? SEGMENT_MS,
      onSegment: segment => take(key, segment),
      onError: message => set({ note: message }),
    };
  }

  /** 原生落盘目录里,账上没有、又已经录完的那几段补认上(重开前报上来时没人收)。 */
  async function reconcile(view: OutboxView, liveSeq: number | undefined): Promise<void> {
    const dir = view.nativeDir;
    if (dir === undefined) return;
    let names: string[] = [];
    try { names = await deps.listDir(dir); } catch { return; }
    for (const name of names) {
      const seq = seqOfFile(name);
      // 还在录的那一段不碰:文件还没写完(m4a 的 moov 在最后)。
      if (seq === undefined || (liveSeq !== undefined && seq >= liveSeq)) continue;
      await deps.outbox.addSegment(view.key, { seq, path: `${dir.replace(/\/+$/, '')}/${name}`, ms: 0, mimeType: name.endsWith('.webm') ? 'audio/webm' : 'audio/mp4' });
    }
  }

  async function bootOnce(): Promise<void> {
    await deps.outbox.load();
    const latest = deps.outbox.latest();
    if (latest !== undefined && !latest.finished) {
      const base = { key: latest.key, title: latest.title, startedAt: Date.parse(latest.startedAt) };
      if (latest.ended) {
        set({ ...base, phase: { kind: 'uploading' } });
      } else {
        const attached = await deps.attachRecording(recorderInput(latest.key)).catch(() => null);
        if (attached !== null) {
          recording = attached.recording;
          if (attached.status.paused) pausedAt = now();
          set({ ...base, via: attached.recording.via, phase: { kind: attached.status.paused ? 'paused' : 'recording' } });
          await reconcile(latest, attached.status.seq);
        } else {
          set({ ...base, phase: { kind: 'interrupted' } });
          await reconcile(latest, undefined);
        }
      }
      sync();
    }
    void pump();
    const every = deps.retryEveryMs ?? DEFAULT_RETRY_MS;
    if (every > 0) setInterval(() => { if (deps.outbox.busy()) void pump(); }, every);
    deps.networkChanges?.(() => { void pump(); });
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    boot() {
      booted ??= bootOnce().catch(() => undefined);
      return booted;
    },

    async begin(title, planId) {
      if (state.phase.kind === 'recording' || state.phase.kind === 'paused' || state.phase.kind === 'starting') return;
      set({ phase: { kind: 'starting' }, title, upload: uploadOf(undefined) });
      const { note: _drop, ...rest } = state;
      state = rest;
      // 权限**在开录之前问**(同 call/micPermission 的理由):弹框不该压在一场已经开始的会上。
      const mic = await deps.ensureMic();
      if (!mic.granted) {
        set({ phase: { kind: 'failed', error: mic.error ?? '没有录音权限', ...(mic.needsSettings === true ? { micFix: true } : {}) } });
        return;
      }
      const key = deps.newKey();
      const startedAt = now();
      // 录音先起来,账后记:起不来就不在待传箱里留一场空会(不然电脑上会多一场什么都没有的会议)。
      // 起来之后、记账之前到的段(不会,一段至少几秒)也排在 `begun` 后面。
      let markBegun: () => void = () => {};
      const begun = new Promise<void>((resolve) => { markBegun = resolve; });
      const input = recorderInput(key);
      const started = await deps.startRecording({ ...input, onSegment: (segment) => { void begun.then(() => input.onSegment(segment)); } });
      if (started === null) { set({ phase: { kind: 'failed', error: state.note ?? '录音起不来' } }); return; }
      recording = started;
      pausedMs = 0;
      pausedAt = undefined;
      await deps.outbox.begin({ key, title, startedAt: new Date(startedAt).toISOString(), ...(started.dir === undefined ? {} : { nativeDir: started.dir }), ...(planId === undefined ? {} : { planId }) });
      markBegun();
      set({ key, startedAt, via: started.via, phase: { kind: 'recording' } });
      sync();
      // 当场补开电脑那边的一场:在家马上就开上;在外面连不上也不拦录音(待传箱记着,回家再开)。
      void pump();
    },

    async pause() {
      if (state.phase.kind !== 'recording') return;
      await recording?.pause();
      pausedAt = now();
      set({ phase: { kind: 'paused' } });
    },

    async resume() {
      if (state.phase.kind !== 'paused') return;
      await recording?.resume();
      if (pausedAt !== undefined) pausedMs += now() - pausedAt;
      pausedAt = undefined;
      set({ phase: { kind: 'recording' } });
    },

    async finish(title) {
      const key = state.key;
      if (key === undefined) return;
      const kind = state.phase.kind;
      if (kind !== 'recording' && kind !== 'paused' && kind !== 'interrupted' && kind !== 'uploading') return;
      set({ phase: { kind: 'uploading' }, ...(title.trim() === '' ? {} : { title }) });
      // `stop()` 已经等到最后那一段交到手里(recorder.ts 的 STOP_GRACE_MS);再等它写进账。
      await recording?.stop();
      recording = null;
      await Promise.allSettled([...saving]);
      await deps.outbox.end(key, title.trim() === '' ? state.title : title);
      sync();
      await pump();
      sync();
    },

    async retryUpload() {
      await pump();
      sync();
    },

    async allowRelay() {
      const key = state.key;
      if (key === undefined) return;
      await deps.outbox.allowRelay(key);
      sync();
      await pump();
      sync();
    },

    release() {
      if (state.phase.kind === 'working' || state.phase.kind === 'failed' || state.phase.kind === 'idle') {
        state = { phase: { kind: 'idle' }, title: '', upload: uploadOf(undefined) };
        for (const listener of [...listeners]) { try { listener(); } catch { /* 同上 */ } }
      }
    },

    elapsed() {
      if (state.startedAt === undefined) return 0;
      const pausedNow = pausedAt === undefined ? 0 : now() - pausedAt;
      return Math.max(0, now() - state.startedAt - pausedMs - pausedNow);
    },

    level: () => recording?.level() ?? 0,

    active() {
      const kind = state.phase.kind;
      return kind === 'starting' || kind === 'recording' || kind === 'paused' || kind === 'uploading' || kind === 'interrupted';
    },

    sync,
  };
}

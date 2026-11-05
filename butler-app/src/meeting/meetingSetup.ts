/**
 * 会议控制器的生产接法(2026-10-09,卡「会后真机走通」)。session.ts 建会话时叫一次;
 * 会议页的用例也走这里(只把录音器、权限、文件读写换成假的)。
 *
 * 文件读写走 @capacitor/filesystem:原生那条的段已经在 App 的文件目录里(绝对路径,`getFilesDir()/meetings/<开录毫秒>/`),
 * WebView 退路的段由这里写进 App 的数据目录(`meetings-web/<这场的编号>/`)。**这里没有删文件的能力**。
 */
import type { ApiClient } from '../api/client';
import type { KeyValueStore } from '../api/tokenStore';
import { ensureMicPermission, type MicPermissionDeps } from '../call/micPermission';
import type { WbchMode } from '../channel/channelProtocol';
import { createMeetingApi } from './meetingApi';
import { createMeetingController, type MeetingController, type MeetingControllerDeps } from './meetingController';
import { MEETING_MIC_DENIED_TEXT, type RecordedSegment } from './meetingModel';
import { createMeetingOutbox } from './meetingOutbox';
import { attachMeetingRecording, startMeetingRecording, type MeetingRecorderDeps } from './recorder';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(out);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function readSegmentFile(path: string): Promise<Uint8Array> {
  const { Filesystem } = await import('@capacitor/filesystem');
  const read = await Filesystem.readFile({ path }) as { data: unknown };
  if (typeof read.data === 'string') return fromBase64(read.data);
  if (read.data instanceof Blob) return new Uint8Array(await read.data.arrayBuffer());
  throw new Error('读出来的不是字节');
}

async function saveSegmentFile(key: string, segment: RecordedSegment & { bytes: Uint8Array }): Promise<string> {
  const { Directory, Filesystem } = await import('@capacitor/filesystem');
  const ext = segment.mimeType.includes('webm') ? 'webm' : 'm4a';
  const written = await Filesystem.writeFile({
    path: `meetings-web/${key}/${String(segment.seq).padStart(2, '0')}.${ext}`,
    data: toBase64(segment.bytes),
    directory: Directory.Data,
    recursive: true,
  });
  return written.uri;
}

async function listSegmentDir(dir: string): Promise<string[]> {
  const { Filesystem } = await import('@capacitor/filesystem');
  const listed = await Filesystem.readdir({ path: dir });
  return listed.files.map(file => (typeof file === 'string' ? file : file.name));
}

function newMeetingKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface MeetingControllerInput {
  kv: KeyValueStore;
  /** 只直连的那一份(session.direct)。 */
  direct: ApiClient;
  /** 选好路的那个(session.client)。 */
  routed: ApiClient & { mode?: () => WbchMode; subscribe?: (listener: (mode: WbchMode) => void) => () => void };
  networkChanges?: (listener: () => void) => () => void;
  /** 下面几样只有用例换。 */
  recorderDeps?: MeetingRecorderDeps;
  micDeps?: MicPermissionDeps;
  segmentMs?: number;
  retryEveryMs?: number;
  overrides?: Partial<Pick<MeetingControllerDeps, 'saveSegment' | 'listDir' | 'newKey' | 'now'>> & { readSegment?: (path: string) => Promise<Uint8Array> };
}

export function createMeetingControllerFor(input: MeetingControllerInput): MeetingController {
  const api = createMeetingApi({ direct: input.direct, routed: input.routed });
  const holder: { controller?: MeetingController } = {};
  const outbox = createMeetingOutbox({
    kv: input.kv,
    readSegment: input.overrides?.readSegment ?? readSegmentFile,
    start: async body => await api.start(body),
    upload: async (serverId, segment, how) => await api.sendSegment(serverId, segment, how),
    finish: async (serverId, title) => await api.finish(serverId, title),
    onChange: () => holder.controller?.sync(),
  });
  const controller = createMeetingController({
    outbox,
    startRecording: start => startMeetingRecording(start, input.recorderDeps ?? {}),
    attachRecording: start => attachMeetingRecording(start, input.recorderDeps ?? {}),
    ensureMic: async () => {
      const mic = await ensureMicPermission(input.micDeps ?? {});
      return mic.granted
        ? { granted: true }
        : { granted: false, needsSettings: mic.needsSettings, error: mic.error === undefined ? MEETING_MIC_DENIED_TEXT : `${MEETING_MIC_DENIED_TEXT}(${mic.error})` };
    },
    saveSegment: input.overrides?.saveSegment ?? saveSegmentFile,
    listDir: input.overrides?.listDir ?? listSegmentDir,
    newKey: input.overrides?.newKey ?? newMeetingKey,
    ...(input.overrides?.now === undefined ? {} : { now: input.overrides.now }),
    ...(input.segmentMs === undefined ? {} : { segmentMs: input.segmentMs }),
    ...(input.retryEveryMs === undefined ? {} : { retryEveryMs: input.retryEveryMs }),
    // 网络变了、或者选路那边切回了直连(回到家里的网):马上传一遍,不等下一个三十秒。
    networkChanges: (listener) => {
      const offNet = input.networkChanges?.(listener) ?? (() => {});
      const offMode = input.routed.subscribe?.((mode) => { if (mode === 'direct') listener(); }) ?? (() => {});
      return () => { offNet(); offMode(); };
    },
  });
  holder.controller = controller;
  return controller;
}

export { createMeetingApi };

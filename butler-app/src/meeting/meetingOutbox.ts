/**
 * 会议的「待传箱」(2026-10-09,卡「会后真机走通」)。
 *
 * 09-21 那一版的分段队列只在内存里:App 被杀,没传上去的那几段就再也不会传了(文件还在手机上,可没人记得)。
 * 现在分段**先落在手机上**(原生那条本来就落在 App 的文件目录里;WebView 退路由上层写成文件),
 * 这里只记账 ——「哪一场、电脑那边编号是什么、哪几段、传了没有、结束了没有、这一场准不准走中转」——
 * 记在 Preferences 里。App 重开、网络变了、过一会儿,上层叫一次 `pump()` 就接着传。
 *
 * 三条规矩,每一条都是为了不丢录音:
 * 1. **严格按 seq 传**,一段没上去就不传下一段 —— 电脑那边靠 seq 拼时间戳;
 * 2. **失败不丢**,原话留着,下次 pump 再来;
 * 3. **一个字节都不删**:这里没有删文件的能力,传完的会也只是从账上划掉(文件留在手机上)。
 *
 * 走哪条路不在这里定:upload 那一头拿到 `viaRelay` 自己选(在家直连;出门只有这一场她点过
 * 「现在经服务器传」才走中转,见 meetingApi.ts)。这里只把她那一下记住。
 */
import type { ApiResult } from '../api/client';
import type { KeyValueStore } from '../api/tokenStore';
import type { MeetingSegment } from './meetingModel';

/** 账记在 Preferences 的哪一格。改格式就换一个名字,不在原地猜旧格式。 */
export const MEETING_OUTBOX_KEY = 'wb.meeting.outbox.v1';

/** 传完的会在账上留几场(会议页要拿最近那一场的电脑编号去看纪要)。 */
const FINISHED_KEEP = 3;

export interface OutboxSegmentInput {
  seq: number;
  /** 这一段在手机上的文件。 */
  path: string;
  ms: number;
  mimeType: string;
}

interface OutboxSegment extends OutboxSegmentInput {
  sent?: true;
}

interface OutboxMeeting {
  /** 手机给这场会编的号(电脑那边的 client_key)。 */
  key: string;
  title: string;
  startedAt: string;
  /** 原生录音落盘的目录(重开时据此补认没报上来的段)。 */
  nativeDir?: string;
  /** 会前登记的那一场(2026-10-10):补开时带上,电脑把录音接到同一个会议对象上。 */
  planId?: string;
  /** 电脑那边的编号。补开成功之前缺席。 */
  serverId?: string;
  segments: OutboxSegment[];
  /** 按了「结束」(带着那一刻的标题)。 */
  ended?: { title: string; at: string };
  /** 电脑那边也结束了(finish 成功):这一场传完了。 */
  finished?: true;
  /** 她这一场点过「现在经服务器传」。 */
  viaRelay?: true;
  /** 最近一次没办成的原话。办成一次就清掉。 */
  error?: string;
  /** 最近一次没办成是因为够不着电脑(在外面)。界面据此摆「现在经服务器传」。 */
  offline?: true;
}

export type OutboxUpload = { ok: true } | { ok: false; error: string; offline?: boolean };

export interface MeetingOutboxDeps {
  kv: KeyValueStore;
  /** 把手机上那一段读成字节。 */
  readSegment: (path: string) => Promise<Uint8Array>;
  start: (input: { title: string; client_key: string; started_at: string; plan_id?: string }) => Promise<ApiResult<{ ok?: boolean; id?: string }>>;
  upload: (serverId: string, segment: MeetingSegment, how: { viaRelay: boolean }) => Promise<OutboxUpload>;
  finish: (serverId: string, title: string) => Promise<ApiResult<unknown>>;
  /** 账变了喊一声。 */
  onChange?: () => void;
}

export interface OutboxView {
  key: string;
  title: string;
  startedAt: string;
  nativeDir?: string;
  serverId?: string;
  /** 还没传上去几段。 */
  pending: number;
  sent: number;
  /** 收到过的最大段号(重开时接着编)。 */
  lastSeq: number;
  ended: boolean;
  finished: boolean;
  viaRelay: boolean;
  offline: boolean;
  error?: string;
}

export interface MeetingOutbox {
  load: () => Promise<void>;
  begin: (input: { key: string; title: string; startedAt: string; nativeDir?: string; planId?: string }) => Promise<void>;
  addSegment: (key: string, segment: OutboxSegmentInput) => Promise<void>;
  end: (key: string, title: string) => Promise<void>;
  allowRelay: (key: string) => Promise<void>;
  /** 能传的都传一遍。同一时刻只跑一遍,再叫就等那一遍(之后再补跑一遍)。 */
  pump: () => Promise<void>;
  view: (key: string) => OutboxView | undefined;
  /** 账上最近那一场(会议页重开时看它)。 */
  latest: () => OutboxView | undefined;
  /** 还有没传完的吗(上层据此决定要不要隔一会儿再 pump)。 */
  busy: () => boolean;
}

function networkLike(result: { kind?: string }): boolean {
  return result.kind === 'network';
}

export function createMeetingOutbox(deps: MeetingOutboxDeps): MeetingOutbox {
  let meetings: OutboxMeeting[] = [];
  let running: Promise<void> | undefined;
  let again = false;

  async function save(): Promise<void> {
    try { await deps.kv.set(MEETING_OUTBOX_KEY, JSON.stringify({ meetings })); }
    catch { /* 写不进 Preferences:这一拍的账只在内存里,下一次改动再写 —— 文件本身不受影响 */ }
    try { deps.onChange?.(); } catch { /* 订阅者抛不该拦住记账 */ }
  }

  function find(key: string): OutboxMeeting | undefined {
    return meetings.find(m => m.key === key);
  }

  function viewOf(m: OutboxMeeting): OutboxView {
    const pending = m.segments.filter(s => s.sent !== true).length;
    return {
      key: m.key,
      title: m.ended?.title ?? m.title,
      startedAt: m.startedAt,
      ...(m.nativeDir === undefined ? {} : { nativeDir: m.nativeDir }),
      ...(m.serverId === undefined ? {} : { serverId: m.serverId }),
      pending,
      sent: m.segments.length - pending,
      lastSeq: m.segments.reduce((max, s) => Math.max(max, s.seq), 0),
      ended: m.ended !== undefined,
      finished: m.finished === true,
      viaRelay: m.viaRelay === true,
      offline: m.offline === true,
      ...(m.error === undefined ? {} : { error: m.error }),
    };
  }

  function failed(m: OutboxMeeting, error: string, offline: boolean): void {
    m.error = error;
    if (offline) m.offline = true; else delete m.offline;
  }

  function cleared(m: OutboxMeeting): void {
    delete m.error;
    delete m.offline;
  }

  /** 一场能往前推多少推多少。回 false = 卡住了(这一场后面的会也先不动,保持先来后到)。 */
  async function advance(m: OutboxMeeting): Promise<boolean> {
    if (m.finished === true) return true;
    if (m.serverId === undefined) {
      let started: Awaited<ReturnType<MeetingOutboxDeps['start']>>;
      try { started = await deps.start({ title: m.title, client_key: m.key, started_at: m.startedAt, ...(m.planId === undefined ? {} : { plan_id: m.planId }) }); }
      catch (err) { started = { ok: false, status: 0, kind: 'network', error: err instanceof Error ? err.message : '连不上' }; }
      if (!started.ok) { failed(m, started.error, networkLike(started)); await save(); return false; }
      const id = started.data?.id;
      if (typeof id !== 'string' || id === '') { failed(m, '工作台没给这场会议一个编号', false); await save(); return false; }
      m.serverId = id;
      cleared(m);
      await save();
    }
    for (const segment of [...m.segments].sort((a, b) => a.seq - b.seq)) {
      if (segment.sent === true) continue;
      let bytes: Uint8Array;
      try { bytes = await deps.readSegment(segment.path); }
      catch (err) {
        failed(m, `第 ${segment.seq} 段读不回来(录音文件还在手机上):${err instanceof Error ? err.message : '没说原因'}`, false);
        await save();
        return false;
      }
      let result: OutboxUpload;
      try {
        result = await deps.upload(m.serverId, { seq: segment.seq, bytes, mimeType: segment.mimeType, ms: segment.ms, path: segment.path }, { viaRelay: m.viaRelay === true });
      } catch (err) {
        result = { ok: false, error: err instanceof Error && err.message !== '' ? err.message : '传不上去' };
      }
      if (!result.ok) { failed(m, result.error, result.offline === true); await save(); return false; }
      segment.sent = true;
      cleared(m);
      await save();
    }
    if (m.ended === undefined) return true;
    let done: ApiResult<unknown>;
    try { done = await deps.finish(m.serverId, m.ended.title); }
    catch (err) { done = { ok: false, status: 0, kind: 'network', error: err instanceof Error ? err.message : '连不上' }; }
    if (!done.ok) { failed(m, done.error, networkLike(done)); await save(); return false; }
    m.finished = true;
    cleared(m);
    await save();
    return true;
  }

  async function runOnce(): Promise<void> {
    for (const m of [...meetings]) {
      if (!(await advance(m))) break;
    }
  }

  return {
    async load() {
      try {
        const raw = await deps.kv.get(MEETING_OUTBOX_KEY);
        const parsed = raw === null ? undefined : (JSON.parse(raw) as { meetings?: unknown });
        meetings = Array.isArray(parsed?.meetings) ? (parsed.meetings as OutboxMeeting[]).filter(m => typeof m?.key === 'string' && Array.isArray(m.segments)) : [];
      } catch {
        // 账读坏了:当空账。**文件都还在手机上**,丢的只是「传了没有」这本账。
        meetings = [];
      }
    },

    async begin(input) {
      if (find(input.key) !== undefined) return;
      // 传完的老会只留最近几场;没传完的一场都不划。
      const finished = meetings.filter(m => m.finished === true);
      const drop = new Set(finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP)).map(m => m.key));
      meetings = meetings.filter(m => !drop.has(m.key));
      meetings.push({
        key: input.key,
        title: input.title,
        startedAt: input.startedAt,
        ...(input.nativeDir === undefined ? {} : { nativeDir: input.nativeDir }),
        ...(input.planId === undefined ? {} : { planId: input.planId }),
        segments: [],
      });
      await save();
    },

    async addSegment(key, segment) {
      const m = find(key);
      if (m === undefined) return;
      const at = m.segments.findIndex(s => s.seq === segment.seq);
      if (at >= 0) {
        // 同一段又报一次(重开时补认):路径一样就不动,免得把「传过了」冲掉。
        if (m.segments[at]?.path === segment.path) return;
        m.segments[at] = { ...segment };
      } else {
        m.segments.push({ ...segment });
      }
      m.segments.sort((a, b) => a.seq - b.seq);
      await save();
    },

    async end(key, title) {
      const m = find(key);
      if (m === undefined || m.ended !== undefined) return;
      m.ended = { title: title.trim() === '' ? m.title : title, at: new Date().toISOString() };
      await save();
    },

    async allowRelay(key) {
      const m = find(key);
      if (m === undefined || m.viaRelay === true) return;
      m.viaRelay = true;
      await save();
    },

    async pump() {
      if (running !== undefined) { again = true; await running; return; }
      running = (async () => {
        try {
          do { again = false; await runOnce(); } while (again);
        } finally {
          running = undefined;
        }
      })();
      await running;
    },

    view(key) {
      const m = find(key);
      return m === undefined ? undefined : viewOf(m);
    },

    latest() {
      const m = meetings[meetings.length - 1];
      return m === undefined ? undefined : viewOf(m);
    },

    busy() {
      return meetings.some(m => m.finished !== true && (m.ended !== undefined || m.segments.some(s => s.sent !== true) || m.serverId === undefined));
    },
  };
}

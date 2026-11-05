/**
 * 会议模式对 8791 说的那几句话(2026-09-21;2026-10-09 卡「会后真机走通」改了路)。
 *
 * ## 各走哪条路
 *
 * - **只有文字的**(开 / 结束 / 看纪要 / 建事项 / 重新来):走选好路的那个客户端(`session.client`),
 *   在家直连、出门经房间代理 —— 和别的事项文字一样。
 * - **录音分段**:09-27 已拍板「录音不出两台设备」,10-09 维护者定了出门怎么办:
 *   **默认只走直连**;出门(选路那边已经知道直连不通)就不发,回 `offline`,攒在手机上等回家
 *   (meetingOutbox.ts 记账,网络一变 / 隔一会儿自己再试)。
 *   **她这一场点过「现在经服务器传」**才交给选好路的那个 —— 出门就经她自己那台 LiveKit 房间的
 *   `wb.meeting` 字节流,工人只转不存(channel/channelClient.ts、channel-worker/src/meetingRelay.ts)。
 *   注意:routedClient 自己在直连失败时会改走房间,所以没同意的那一场**绝不能**交给它。
 */
import type { ApiClient, ApiResult } from '../api/client';
import type { WbchMode } from '../channel/channelProtocol';
import type { MeetingSegment } from './meetingModel';
import type { OutboxUpload } from './meetingOutbox';
import type { MeetingPrepQuestionId, MeetingPrepView, MeetingTimelineMark } from '../api/protocol';

/** 一条待办(和电脑端 protocol.ts 的 MeetingTodoView 同形)。 */
export interface MeetingTodo {
  id: string;
  what: string;
  who?: string;
  due?: string;
  task_id?: string;
}

export interface MeetingDetail {
  id: string;
  title: string;
  date: string;
  status: 'planned' | 'recording' | 'transcribing' | 'summarizing' | 'done' | 'failed';
  segments: number;
  transcribed?: number;
  seconds?: number;
  dir?: string;
  summary?: string;
  todos: MeetingTodo[];
  unsure: string[];
  error?: string;
  /** 能「重新来」(电脑端 MeetingView.retryable)。缺席就不摆那颗键。 */
  retryable?: true;
  /** 会前画像与预案卡(2026-10-10)。会前登记过的那一场才有。 */
  prep?: MeetingPrepView;
  /**
   * 会中那一段:转写里的时间戳摆成的一条线(2026-10-13)。
   * **不是现场记号** —— 会中「记一下」这一版还没有,所以这里只有转写自己带的时间。
   */
  timeline?: readonly MeetingTimelineMark[];
  /** 演示用那一场(电脑上一键放进来的虚构样例)。 */
  demo?: true;
  /** 会后她回过的「定下来没有」。 */
  outcome?: { settled: 'yes' | 'partly' | 'no'; said?: string; at: string };
}

/** 会前那几条的回包:那一场此刻的样子 + 该跟她说的那一句。 */
export interface MeetingPlanReply {
  ok?: boolean;
  meeting?: MeetingDetail;
  note?: string;
}

/** 出门、这一场没点过「经服务器传」时那句话(录音在手机上攒着)。 */
export const MEETING_AWAY_TEXT = '在外面:录音先存在手机上,回到家里的网会自动传给电脑';

/** 直连传一段最多等多久。局域网里几 MB 几秒;刚出门那一下够不着局域网地址,别挂到系统超时。 */
export const MEETING_DIRECT_UPLOAD_MS = 90_000;

export interface MeetingApi {
  start: (input: { title: string; client_key: string; started_at: string; plan_id?: string }) => Promise<ApiResult<{ ok?: boolean; id?: string; dir?: string }>>;
  sendSegment: (id: string, segment: MeetingSegment, how: { viaRelay: boolean }) => Promise<OutboxUpload>;
  finish: (id: string, title: string) => Promise<ApiResult<{ ok: boolean }>>;
  get: (id: string) => Promise<ApiResult<MeetingDetail>>;
  apply: (id: string, todoIds: readonly string[]) => Promise<ApiResult<{ ok: boolean; created: string[] }>>;
  retry: (id: string) => Promise<ApiResult<{ ok: boolean }>>;
  /** 会前(2026-10-10):答一问 / 再做预案卡(proceed = 目的没说清也先照现在的准备)/ 撤掉登记 / 会后那一句。 */
  answer: (id: string, question: MeetingPrepQuestionId, answer: string) => Promise<ApiResult<MeetingPlanReply>>;
  card: (id: string, proceed: boolean) => Promise<ApiResult<MeetingPlanReply>>;
  drop: (id: string) => Promise<ApiResult<{ ok: boolean }>>;
  outcome: (id: string, settled: 'yes' | 'partly' | 'no', said?: string) => Promise<ApiResult<{ ok: boolean }>>;
}

export interface MeetingApiDeps {
  /** 只直连 8791 的那一份(session.direct)。 */
  direct: ApiClient;
  /** 选好路的那个(session.client)。`mode()` 缺席时当在家。 */
  routed: ApiClient & { mode?: () => WbchMode };
}

export function createMeetingApi(deps: MeetingApiDeps): MeetingApi {
  const { direct, routed } = deps;
  return {
    async start(input) {
      return await routed.json('/meeting/start', { method: 'POST', body: input });
    },
    async sendSegment(id, segment, how) {
      // 出门、没同意:选路那边已经知道直连不通,这一下连试都不试(在 LTE 上试局域网地址要干等几十秒)。
      if (!how.viaRelay && routed.mode?.() === 'remote') return { ok: false, offline: true, error: MEETING_AWAY_TEXT };
      // 裸二进制 POST:base64 会多 33% 的流量与内存,而这一段唯一的去处就是落到电脑硬盘上。
      const blob = new Blob([segment.bytes as unknown as BlobPart], { type: segment.mimeType });
      const path = `/meeting/segment?id=${encodeURIComponent(id)}&seq=${segment.seq}&ms=${Math.max(0, Math.round(segment.ms))}`;
      const request = { method: 'POST' as const, body: blob, headers: { 'content-type': segment.mimeType } };
      if (how.viaRelay) {
        const result = await routed.json<{ ok?: boolean }>(path, request);
        return result.ok ? { ok: true } : { ok: false, error: result.error, offline: result.kind === 'network' };
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), MEETING_DIRECT_UPLOAD_MS);
      try {
        const result = await direct.json<{ ok?: boolean }>(path, { ...request, ...(controller === undefined ? {} : { signal: controller.signal }) });
        if (result.ok) return { ok: true };
        return result.kind === 'network' ? { ok: false, offline: true, error: MEETING_AWAY_TEXT } : { ok: false, error: result.error };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async finish(id, title) {
      return await routed.json('/meeting/finish', { method: 'POST', body: { id, title } });
    },
    async get(id) {
      return await routed.json<MeetingDetail>(`/meeting?id=${encodeURIComponent(id)}`);
    },
    async apply(id, todoIds) {
      // `todos` 不给 = 全建(那颗「都建」)。
      return await routed.json('/meeting/apply', { method: 'POST', body: { id, ...(todoIds.length === 0 ? {} : { todos: [...todoIds] }) } });
    },
    async retry(id) {
      return await routed.json('/meeting/retry', { method: 'POST', body: { id } });
    },
    async answer(id, question, answer) {
      return await routed.json('/meeting/answer', { method: 'POST', body: { id, question, answer } });
    },
    async card(id, proceed) {
      return await routed.json('/meeting/card', { method: 'POST', body: { id, ...(proceed ? { proceed: true } : {}) } });
    },
    async drop(id) {
      return await routed.json('/meeting/drop', { method: 'POST', body: { id } });
    },
    async outcome(id, settled, said) {
      return await routed.json('/meeting/outcome', { method: 'POST', body: { id, settled, ...(said === undefined || said.trim() === '' ? {} : { said: said.trim() }) } });
    },
  };
}

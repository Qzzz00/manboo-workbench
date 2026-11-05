/**
 * 出了局域网的会议分段(2026-10-09,卡「会后真机走通」)。
 *
 * 在家时手机直连 8791 `POST /meeting/segment` 传一段录音;出了门直连够不着。维护者 10-09 拍:
 * **默认不经服务器**(录音攒在手机上、回家自动补传);她在会议页上**这一场**点了「现在经服务器传」,
 * 才走这一条 —— 经她自己那台 LiveKit 房间转到这台电脑,**只转不存**(工人只在内存里过一下,不落盘)。
 *
 * ## 一段怎么走(同「按住说话」那条,asrRelay.ts)
 *
 *   手机 ──wb.rpc──▶ `{ id, type:'meeting_segment', meeting_id, seq, ms }`
 *   手机 ──wb.meeting──▶ 字节流,**只发给工人**,流上属性 `wb_meeting_seg = id`(一段十分钟的 m4a 约 4.7MB)
 *   工人:信箱按「谁发的 + id」对上 → 以**那台手机的身份**(`X-Workbench-Channel-Device`)
 *        POST 8791 的 `/meeting/segment?id&seq&ms` —— 与在家直连同一条路、同一道门、同样按 seq 去重
 *   工人 ──wb.rpc──▶ `{ id, type:'http', status, body }`
 *
 * 和识别那条的差别只有尺寸与耐心:一段几 MB,在外面的上行可能要传一两分钟,所以等得久、上限大;
 * 信箱、读流、只认配对过的手机、只有第一台电脑收,全用 asrRelay.ts 那一套。
 */
import type { RpcMeetingPort } from './rpc.ts'
import { createAsrMailbox, createAsrStreamHandler, readAsrStream, type AsrMailbox, type AsrStreamReader } from './asrRelay.ts'
import { CHANNEL_DEVICE_HEADER } from './workbench.ts'

/** 分段那条字节流的 topic(手机那一侧是 butler-app/src/channel/channelProtocol.ts 的 WBCH_MEETING_TOPIC)。 */
export const MEETING_TOPIC = 'wb.meeting'

/** 流上带编号的属性名。同上,两端逐字一样。 */
export const MEETING_ID_ATTRIBUTE = 'wb_meeting_seg'

/** 交给 8791 的那条路 —— 与在家直连打的是同一条。 */
export const MEETING_SEGMENT_PATH = '/meeting/segment'

/**
 * 一段最多多少字节。十分钟 64kbps 的 m4a 约 4.7MB;WebView 退路录的 webm 码率可能翻倍。
 * 给到 24MB,比 8791 自己的 50MB 小 —— 工人要在内存里攒整段,不收离谱的大小。
 */
export const MEETING_SEGMENT_MAX_BYTES = 24 * 1024 * 1024

/** 请求到了、录音还没收齐:最多等多久。几 MB 在外面的上行(0.5~1Mbps)要一两分钟,给五分钟。 */
export const MEETING_STREAM_WAIT_MS = 5 * 60_000

/** 交给 8791 之后等多久。它只是落盘记账,本机几百毫秒。 */
export const MEETING_BACKEND_TIMEOUT_MS = 60_000

export const MEETING_AUDIO_MISSING_TEXT = '这一段录音没传到电脑上(网可能慢),等会儿会再传'
export const MEETING_BACKEND_DOWN_TEXT = '电脑上的工作台没接这一段(连不上)'

export function createMeetingMailbox(): AsrMailbox {
  // 没人来取的那一份留久一点(一段几 MB,手机那条请求可能晚到);同一台手机一次只传一段,压两份足够。
  return createAsrMailbox({ keepMs: MEETING_STREAM_WAIT_MS, maxPerSender: 2 })
}

export type MeetingPoster = (input: { deviceId: string, meetingId: string, seq: number, ms?: number, audio: Uint8Array, mime: string, signal: AbortSignal }) => Promise<{ status: number, body: unknown }>

/** 以那台手机的身份把一段交给 8791。**原样的字节**,content-type 是手机报的那个。 */
export function workbenchMeetingPoster(input: { workbenchUrl: string, fetchImpl?: typeof fetch }): MeetingPoster {
  const doFetch = input.fetchImpl ?? fetch
  const base = input.workbenchUrl.replace(/\/+$/, '')
  return async ({ deviceId, meetingId, seq, ms, audio, mime, signal }) => {
    const query = `id=${encodeURIComponent(meetingId)}&seq=${seq}${ms === undefined ? '' : `&ms=${Math.max(0, Math.round(ms))}`}`
    const res = await doFetch(`${base}${MEETING_SEGMENT_PATH}?${query}`, {
      method: 'POST',
      headers: { [CHANNEL_DEVICE_HEADER]: deviceId, 'content-type': mime },
      body: audio,
      signal,
    })
    const raw = await res.text()
    let body: unknown = {}
    try { body = raw === '' ? {} : JSON.parse(raw) }
    catch { body = { error: '工作台回了一段读不懂的内容' } }
    return { status: res.status, body }
  }
}

/** `wb.rpc` 那条 `type:'meeting_segment'` 的实现。**绝不抛**;日志只记大小与耗时,不碰内容。 */
export function createMeetingRelay(deps: {
  mailbox: AsrMailbox
  post: MeetingPoster
  streamWaitMs?: number
  backendTimeoutMs?: number
  log?: (line: string) => void
  now?: () => number
}): RpcMeetingPort {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  return {
    async segment({ id, deviceId, identity, meetingId, seq, ms }) {
      const started = now()
      const audio = await deps.mailbox.take(identity, id, deps.streamWaitMs ?? MEETING_STREAM_WAIT_MS)
      if (audio === undefined) {
        log(`[channel-worker] 会议分段代传 ← ${identity}:第 ${seq} 段等了 ${now() - started}ms 没到 → 408`)
        return { status: 408, body: { error: MEETING_AUDIO_MISSING_TEXT } }
      }
      if (!audio.ok) {
        log(`[channel-worker] 会议分段代传 ← ${identity}:第 ${seq} 段没收成(${audio.error})→ ${audio.status}`)
        return { status: audio.status, body: { error: audio.error } }
      }
      const posted = now()
      try {
        const result = await deps.post({
          deviceId, meetingId, seq, ...(ms === undefined ? {} : { ms }), audio: audio.bytes, mime: audio.mime,
          signal: AbortSignal.timeout(deps.backendTimeoutMs ?? MEETING_BACKEND_TIMEOUT_MS),
        })
        log(`[channel-worker] 会议分段代传 ← ${identity}:第 ${seq} 段 · ${Math.round(audio.bytes.byteLength / 1024)}KB · 传 ${posted - started}ms · 落盘 ${now() - posted}ms → ${result.status}`)
        return result
      }
      catch {
        log(`[channel-worker] 会议分段代传 ← ${identity}:第 ${seq} 段 · 连不上工作台 → 502`)
        return { status: 502, body: { error: MEETING_BACKEND_DOWN_TEXT } }
      }
    },
  }
}

/** `wb.meeting` 字节流的接法(agent.ts 注册它)。规矩同 asrRelay.ts 的 createAsrStreamHandler,只换编号属性与上限。 */
export function createMeetingStreamHandler(deps: {
  mailbox: AsrMailbox
  primary: boolean
  deviceOf: (identity: string) => string | undefined
  log?: (line: string) => void
}): (reader: AsrStreamReader, participant: { identity: string }) => void {
  return createAsrStreamHandler({ ...deps, idAttribute: MEETING_ID_ATTRIBUTE, maxBytes: MEETING_SEGMENT_MAX_BYTES })
}

export { readAsrStream as readMeetingStream }

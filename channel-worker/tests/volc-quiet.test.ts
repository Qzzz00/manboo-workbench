/**
 * 挂断即断火山(2026-09-25,卡 fix/evening-gaps 第 1 条:计费)。
 *
 * 以前火山连接只有「10 秒没有音频进来」才收;常驻房间的手机挂断后那条静音轨道一直出帧,
 * 连接就一直开着 —— 火山这个 resource 按时长计费。现在工人的收音闸一关就调 `quiet()`:
 *   ① 开着的那条连接当场断(finish + close),回「收掉了几条」;
 *   ② 没听完的那一截丢掉 —— 下一通不补发上一通的尾巴;
 *   ③ 流本身还活着:下一通第一帧进来,照常开一条新连接;
 *   ④ 没开连接时 quiet() 什么都不做、回 0;流结束之后不再登记。
 */
import { AudioFrame } from '@livekit/rtc-node'
import { describe, expect, it } from 'vitest'
import type { OpenVolcAsrInput, VolcAsrSession } from '../src/asr/volcSession.ts'
import { VolcStreamingStt } from '../src/asr/volcStt.ts'

const CREDS = { appId: 'app', accessToken: 'tok', resourceId: 'volc.bigasr.sauc.duration' }

interface FakeSession { input: OpenVolcAsrInput, pushes: Buffer[], finished: boolean, closed: boolean }

function harness() {
  const sessions: FakeSession[] = []
  const stt = new VolcStreamingStt({
    url: 'ws://不用连',
    creds: CREDS,
    onNote: () => {},
    onError: () => {},
    openSession: (input): VolcAsrSession => {
      const entry: FakeSession = { input, pushes: [], finished: false, closed: false }
      sessions.push(entry)
      return {
        push: (pcm) => { entry.pushes.push(Buffer.from(pcm)) },
        finish: () => { entry.finished = true },
        close: () => { if (entry.closed) return; entry.closed = true; input.handlers.onClose?.() },
      }
    },
  })
  return { stt, stream: stt.stream(), sessions }
}

function frame(loud: boolean, marker = 0): AudioFrame {
  const data = new Int16Array(320)
  if (loud) data.fill(8000)
  data[1] = marker
  return new AudioFrame(data, 16000, 1, 320)
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`等「${what}」超时`)
}

function markers(session: FakeSession | undefined): number[] {
  const all = Buffer.concat(session?.pushes ?? [])
  const out: number[] = []
  for (let offset = 0; offset + 640 <= all.length; offset += 640) out.push(all.readInt16LE(offset + 2))
  return out
}

describe('挂断:火山那条连接当场断', () => {
  it('★ 开着一条 → quiet() 当场 finish + close,回 1', async () => {
    const h = harness()
    for (let i = 1; i <= 3; i += 1) h.stream.pushFrame(frame(false, i))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 3, '连接收到三帧')
    expect(h.stt.quiet()).toBe(1)
    expect(h.sessions[0]?.finished).toBe(true)
    expect(h.sessions[0]?.closed).toBe(true)
    h.stream.close()
  })

  it('★ 挂断前他话说到一半:下一通**不补发**上一通的尾巴(挂了的电话不补)', async () => {
    const h = harness()
    for (let i = 1; i <= 4; i += 1) h.stream.pushFrame(frame(true, i))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 4, '第一通收到四帧')
    // 火山那头恰好报过一次错(会让「下一条连接补发」置位)——挂断要把它一起清掉。
    h.sessions[0]?.input.handlers.onError?.('火山 ASR 错误(45000081):等包超时')
    expect(h.stt.quiet()).toBe(1)
    h.stream.pushFrame(frame(true, 9))
    await waitFor(() => h.sessions.length === 2 && markers(h.sessions[1]).length === 1, '下一通开了新连接')
    expect(markers(h.sessions[1])).toEqual([9])
    h.stream.close()
  })

  it('流还活着:下一通第一帧进来照常开一条新连接', async () => {
    const h = harness()
    h.stream.pushFrame(frame(false, 1))
    await waitFor(() => h.sessions.length === 1, '第一条连接')
    h.stt.quiet()
    h.stream.pushFrame(frame(false, 2))
    await waitFor(() => h.sessions.length === 2, '第二条连接')
    expect(h.sessions[1]?.closed).toBe(false)
    h.stream.close()
  })

  it('没开连接时什么都不做,回 0;流结束之后不再登记', async () => {
    const h = harness()
    expect(h.stt.quiet()).toBe(0)
    h.stream.pushFrame(frame(false, 1))
    await waitFor(() => h.sessions.length === 1, '开了一条')
    h.stream.close()
    await waitFor(() => h.sessions[0]?.closed === true, '流结束时连接也断了')
    expect(h.stt.quiet()).toBe(0)
  })
})

/**
 * 火山识别断了不丢话、换上下文不丢话(2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * 09-24 晚引导:这台 Mac 忙到工人主线程卡了半分钟,火山回 45000081(等包超时)断开;
 * 卡住那半分钟里他说的话,在主线程缓过来时一股脑推进了那条已经死了的连接 —— 全丢了。
 * 这里钉住:
 *   ① 连接**因为出错**断了,下一条新连接开场先补发「上一次判停之后」推过的音频;
 *   ② 那一截全是静音就不补(火山按时长计费);判停过的那一截不补(已经听完了);
 *   ③ 换对话上下文(问称呼那一段)= 换一条带新上下文的连接,没听完的那一截带过去;
 *      上下文没变就什么都不做。
 */
import { AudioFrame } from '@livekit/rtc-node'
import { describe, expect, it } from 'vitest'
import type { OpenVolcAsrInput, VolcAsrSession } from '../src/asr/volcSession.ts'
import { VolcStreamingStt } from '../src/asr/volcStt.ts'

const CREDS = { appId: 'app', accessToken: 'tok', resourceId: 'volc.bigasr.sauc.duration' }

interface FakeSession {
  input: OpenVolcAsrInput
  pushes: Buffer[]
  closed: boolean
}

function harness() {
  const sessions: FakeSession[] = []
  const notes: string[] = []
  const stt = new VolcStreamingStt({
    url: 'ws://不用连',
    creds: CREDS,
    onNote: line => notes.push(line),
    onError: () => {},
    openSession: (input): VolcAsrSession => {
      const entry: FakeSession = { input, pushes: [], closed: false }
      sessions.push(entry)
      return {
        push: (pcm) => { entry.pushes.push(Buffer.from(pcm)) },
        finish: () => {},
        close: () => { if (entry.closed) return; entry.closed = true; input.handlers.onClose?.() },
      }
    },
  })
  const stream = stt.stream()
  return { stt, stream, sessions, notes }
}

/** 一帧 20ms。`loud` 为真时是他在说话(峰值远过判「有人声」的线),否则是静音。 */
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

/** 第 i 条连接收到的音频里,按 marker 读出是哪几帧(每 640 字节一帧,marker 在第 2 个采样)。 */
function markers(session: FakeSession | undefined): number[] {
  const all = Buffer.concat(session?.pushes ?? [])
  const out: number[] = []
  for (let offset = 0; offset + 640 <= all.length; offset += 640) out.push(all.readInt16LE(offset + 2))
  return out
}

describe('连接因为出错断了:没听完的那一截补给新连接', () => {
  it('他正说着话时火山回了 45000081 → 新连接开场先补发断之前那几帧,再接着推', async () => {
    const h = harness()
    for (let i = 1; i <= 5; i += 1) h.stream.pushFrame(frame(true, i))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 5, '第一条连接收到五帧')
    h.sessions[0]?.input.handlers.onError?.('火山 ASR 错误(45000081):等包超时')
    h.sessions[0]?.input.handlers.onClose?.()
    h.stream.pushFrame(frame(true, 6))
    await waitFor(() => h.sessions.length === 2 && markers(h.sessions[1]).length === 6, '新连接收到补发 + 新的一帧')
    expect(markers(h.sessions[1])).toEqual([1, 2, 3, 4, 5, 6])
    expect(h.notes.join('\n')).toContain('补发')
    h.stream.close()
  })

  it('那一截全是静音 → 不补(火山按时长计费,补静音是白花钱)', async () => {
    const h = harness()
    for (let i = 1; i <= 5; i += 1) h.stream.pushFrame(frame(false, i))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 5, '第一条连接收到五帧')
    h.sessions[0]?.input.handlers.onError?.('火山 ASR 错误(45000081)')
    h.sessions[0]?.input.handlers.onClose?.()
    h.stream.pushFrame(frame(false, 6))
    await waitFor(() => h.sessions.length === 2 && markers(h.sessions[1]).length >= 1, '新连接收到新的一帧')
    expect(markers(h.sessions[1])).toEqual([6])
    h.stream.close()
  })

  it('判停过的那一截已经听完了 → 只补判停之后的', async () => {
    const h = harness()
    for (let i = 1; i <= 3; i += 1) h.stream.pushFrame(frame(true, i))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 3, '收到三帧')
    h.sessions[0]?.input.handlers.onFinal?.('叫我 Ben 就可以了')
    for (let i = 4; i <= 5; i += 1) h.stream.pushFrame(frame(true, i))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 5, '又收到两帧')
    h.sessions[0]?.input.handlers.onError?.('火山 ASR 连接失败:read ECONNRESET')
    h.sessions[0]?.input.handlers.onClose?.()
    h.stream.pushFrame(frame(true, 6))
    await waitFor(() => h.sessions.length === 2 && markers(h.sessions[1]).length === 3, '新连接收到补发 + 新的一帧')
    expect(markers(h.sessions[1])).toEqual([4, 5, 6])
    h.stream.close()
  })

  it('空闲收掉(不是出错)→ 不补', async () => {
    const h = harness()
    for (let i = 1; i <= 3; i += 1) h.stream.pushFrame(frame(true, i))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 3, '收到三帧')
    // 服务端正常收尾(没有 onError)。
    h.sessions[0]?.input.handlers.onClose?.()
    h.stream.pushFrame(frame(true, 4))
    await waitFor(() => h.sessions.length === 2 && markers(h.sessions[1]).length >= 1, '新连接收到新的一帧')
    expect(markers(h.sessions[1])).toEqual([4])
    h.stream.close()
  })
})

describe('换对话上下文(问称呼那一段)', () => {
  it('带上问话 → 换一条带上下文的连接,他正说到一半的那几帧带过去;撤掉 → 再换回来', async () => {
    const h = harness()
    h.stream.pushFrame(frame(true, 1))
    h.stream.pushFrame(frame(true, 2))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 2, '第一条连接收到两帧')
    expect(h.sessions[0]?.input.dialog).toBeUndefined()

    expect(h.stt.setDialogContext(['你希望我怎么称呼你?'])).toBe(true)
    h.stream.pushFrame(frame(true, 3))
    await waitFor(() => h.sessions.length === 2 && markers(h.sessions[1]).length === 3, '换了一条,补发 + 新的一帧')
    expect(h.sessions[0]?.closed).toBe(true)
    expect(h.sessions[1]?.input.dialog).toEqual(['你希望我怎么称呼你?'])
    expect(markers(h.sessions[1])).toEqual([1, 2, 3])

    h.sessions[1]?.input.handlers.onFinal?.('叫我 Ben')
    expect(h.stt.setDialogContext(undefined)).toBe(true)
    h.stream.pushFrame(frame(false, 4))
    await waitFor(() => h.sessions.length === 3, '撤掉上下文又换了一条')
    expect(h.sessions[2]?.input.dialog).toBeUndefined()
    expect(h.notes.join('\n')).toContain('带上对话上下文')
    expect(h.notes.join('\n')).toContain('撤掉对话上下文')
    h.stream.close()
  })

  it('火山不认上下文(带着它开的连接一个结果没回就报参数错)→ 以后不带了,没听完的照样补发', async () => {
    const h = harness()
    h.stt.setDialogContext(['你希望我怎么称呼你?'])
    h.stream.pushFrame(frame(true, 1))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 1, '带上下文的那条收到一帧')
    expect(h.sessions[0]?.input.dialog).toEqual(['你希望我怎么称呼你?'])
    h.sessions[0]?.input.handlers.onError?.('火山 ASR 错误(45000001):请求参数无效(缺必需字段 / 值非法 / 重复请求)')
    h.sessions[0]?.input.handlers.onClose?.()
    h.stream.pushFrame(frame(true, 2))
    await waitFor(() => h.sessions.length === 2 && markers(h.sessions[1]).length === 2, '新连接收到补发 + 新的一帧')
    expect(h.sessions[1]?.input.dialog).toBeUndefined()
    expect(markers(h.sessions[1])).toEqual([1, 2])
    expect(h.notes.join('\n')).toContain('火山不认')
    h.stream.close()
  })

  it('等包超时这种错不算「不认上下文」(那是这台 Mac 卡了,不是参数错)', async () => {
    const h = harness()
    h.stt.setDialogContext(['你希望我怎么称呼你?'])
    h.stream.pushFrame(frame(true, 1))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 1, '收到一帧')
    h.sessions[0]?.input.handlers.onError?.('火山 ASR 错误(45000081):等包超时')
    h.sessions[0]?.input.handlers.onClose?.()
    h.stream.pushFrame(frame(true, 2))
    await waitFor(() => h.sessions.length === 2, '重开了一条')
    expect(h.sessions[1]?.input.dialog).toEqual(['你希望我怎么称呼你?'])
    h.stream.close()
  })

  it('上下文没变 → 什么都不做(不白白换连接)', async () => {
    const h = harness()
    expect(h.stt.setDialogContext(undefined)).toBe(false)
    h.stt.setDialogContext(['问话'])
    expect(h.stt.setDialogContext(['问话'])).toBe(false)
    h.stream.pushFrame(frame(true, 1))
    h.stream.pushFrame(frame(true, 2))
    await waitFor(() => (h.sessions[0]?.pushes.length ?? 0) === 2, '一条连接收到两帧')
    expect(h.sessions).toHaveLength(1)
    expect(h.sessions[0]?.input.dialog).toEqual(['问话'])
    h.stream.close()
  })
})

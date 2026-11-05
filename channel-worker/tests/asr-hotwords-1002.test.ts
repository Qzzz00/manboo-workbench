/**
 * **耳朵配词表**(2026-10-02,卡 claude/voice-alive 第 5 条)。
 *
 * Air 那一通里「Codex」被火山听成 to death / 泄露 / Cold death,来回**五轮**:
 * 「没听清,你说的是哪个额度?」「两个名字都撞上了,我听不准……」。维护者点的根子是
 * 「耳朵不认识她的词」(docs/分析-和事务官说话为什么费劲-2026-10-02.md 第二节第 4 条)。
 *
 * 查过了:**两条识别路 09-25 起就收热词**(火山流式 `request.corpus.hotwords`、
 * 8792 `/api/asr` 的 `hotwords`),`createAsr({ hotwords })` 这一格也早就在 ——
 * **但从来没有一个调用方给过它**(改之前 `grep -rn hotwords channel-worker/src/*.ts` 一行都没有)。
 * 所以这张卡接的是那一格:8791 的 `GET /channel/persona` 算好下发(workbench-plugin 的
 * `channelHotwords`),工人交给识别,**每通电话现取人设时跟着换**。
 *
 * 这一份钉三件:起点那一份进开场帧、换了会换连接、分段兜底那一路下一句就算数。
 */
import { AudioFrame } from '@livekit/rtc-node'
import { describe, expect, it } from 'vitest'
import type { OpenVolcAsrInput, VolcAsrSession } from '../src/asr/volcSession.ts'
import { VolcStreamingStt } from '../src/asr/volcStt.ts'
import { SegmentedStt } from '../src/asr/segmentedStt.ts'
import { buildCorpus, buildStartFrame } from '../src/asr/volcProtocol.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

const CREDS = { appId: 'app', accessToken: 'tok', resourceId: 'volc.bigasr.sauc.duration' }

interface FakeSession { input: OpenVolcAsrInput, closed: boolean }

function harness(hotwords?: readonly string[]) {
  const sessions: FakeSession[] = []
  const stt = new VolcStreamingStt({
    url: 'ws://不用连',
    creds: CREDS,
    ...(hotwords === undefined ? {} : { hotwords }),
    onNote: () => {},
    onError: () => {},
    openSession: (input): VolcAsrSession => {
      const entry: FakeSession = { input, closed: false }
      sessions.push(entry)
      return {
        push: () => {},
        finish: () => {},
        close: () => { if (entry.closed) return; entry.closed = true; input.handlers.onClose?.() },
      }
    },
  })
  return { stt, stream: stt.stream(), sessions }
}

function frame(): AudioFrame {
  const data = new Int16Array(320)
  data.fill(8000)
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

describe('★★ 火山流式:热词进开场帧', () => {
  it('构造时那一份进第一条连接(改之前这一格永远是空的)', async () => {
    const h = harness(['Codex', 'Manus', '豆包办公'])
    h.stream.pushFrame(frame())
    await waitFor(() => h.sessions.length === 1, '第一条连接开出来')
    expect(h.sessions[0]?.input.hotwords).toEqual(['Codex', 'Manus', '豆包办公'])
    h.stream.close()
  })

  it('一个热词都没给 → 这一格缺席(行为与这一版之前一字不差)', async () => {
    const h = harness()
    h.stream.pushFrame(frame())
    await waitFor(() => h.sessions.length === 1, '第一条连接开出来')
    expect(h.sessions[0]?.input.hotwords).toBeUndefined()
    h.stream.close()
  })

  it('★ 换热词(每通电话现取人设)→ 下一帧换一条带新热词的连接', async () => {
    const h = harness(['Codex'])
    h.stream.pushFrame(frame())
    await waitFor(() => h.sessions.length === 1, '第一条连接开出来')
    expect(h.stt.setHotwords(['Codex', '小笨蛋'])).toBe(true)
    h.stream.pushFrame(frame())
    await waitFor(() => h.sessions.length === 2, '换了一条新连接')
    expect(h.sessions[1]?.input.hotwords).toEqual(['Codex', '小笨蛋'])
    h.stream.close()
  })

  it('和现在一样就什么都不做(不白换一条连接)', () => {
    const h = harness(['Codex'])
    expect(h.stt.setHotwords(['Codex'])).toBe(false)
    expect(h.stt.setHotwords(undefined)).toBe(true)
    expect(h.stt.hotwords).toBeUndefined()
    h.stream.close()
  })
})

describe('★ 分段兜底那一路:下一句就算数', () => {
  it('换了之后 8792 那条请求带的是新的一份', async () => {
    const bodies: Record<string, unknown>[] = []
    const stt = new SegmentedStt({
      butlerUrl: 'http://127.0.0.1:8792',
      hotwords: ['Codex'],
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ text: '好' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    const long = new AudioFrame(new Int16Array(16000).fill(4000), 16000, 1, 16000)
    await stt.recognize(long)
    expect(bodies[0]?.hotwords).toEqual(['Codex'])
    expect(stt.setHotwords(['Codex', 'Manus'])).toBe(true)
    await stt.recognize(long)
    expect(bodies[1]?.hotwords).toEqual(['Codex', 'Manus'])
  })
})

describe('热词 → corpus 那一层的两条分寸(09-25 就有,这里一并钉住)', () => {
  it('单字热词一律跳过(会把同音字一起拉偏)', () => {
    const corpus = buildCorpus(['好', 'Codex', '豆包办公'])
    expect(corpus).not.toBeUndefined()
    const parsed = JSON.parse(String(corpus?.context)) as { hotwords?: { word: string }[] }
    expect(parsed.hotwords).toEqual([{ word: 'Codex' }, { word: '豆包办公' }])
  })

  it('一个都不剩就整格缺席(别发一个空 corpus 过去)', () => {
    expect(buildCorpus(['好', '的'])).toBeUndefined()
    expect(buildCorpus([])).toBeUndefined()
  })

  it('开场帧里带着它(与对话上下文同一格)', () => {
    // payload 是压缩过的,所以不逐字找那个词:带了热词的那一帧**比不带的长**,
    // 而 corpus 是这两帧之间唯一的差别(见 buildStartFrame)。
    expect(buildStartFrame(['Codex', '豆包办公']).length).toBeGreaterThan(buildStartFrame([]).length)
  })
})

describe('★ 工作台下发的那一份:工人收得住', () => {
  /** 一份 `GET /channel/persona` 的假回包。 */
  function client(persona: Record<string, unknown>) {
    const impl = (async () => new Response(JSON.stringify(persona), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    return createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl })
  }

  const base = { system_message: '你就是事务官。', welcome: '喂,我在,你说。' }

  it('热词原样收下', async () => {
    const got = await client({ ...base, hotwords: ['Codex', '豆包办公', '小笨蛋'] }).persona()
    expect(got.hotwords).toEqual(['Codex', '豆包办公', '小笨蛋'])
  })

  it('★ 老工作台没有这一格 → 缺席(不带热词,和这一版之前一字不差)', async () => {
    expect((await client(base).persona()).hotwords).toBeUndefined()
  })

  it('形状不对的挑掉:单字、空白、不是字符串的一个都不留;一个不剩就整格缺席', async () => {
    const got = await client({ ...base, hotwords: ['Codex', '好', '  ', 42, null] }).persona()
    expect(got.hotwords).toEqual(['Codex'])
    expect((await client({ ...base, hotwords: ['好', 1] }).persona()).hotwords).toBeUndefined()
    expect((await client({ ...base, hotwords: '不是数组' }).persona()).hotwords).toBeUndefined()
  })
})

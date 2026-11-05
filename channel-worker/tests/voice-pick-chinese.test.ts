/**
 * **换音色只挑会说中文的**(2026-09-28,卡 VC)。
 *
 * ## 真机那一晚(维护者本机 19:2x–19:4x,`~/.dsh/workbench/logs/channel-worker.log` 搜 wb_set_voice)
 *
 * 他在电话里换音色:「给我换客服类的」→ 爽朗少年 →「换」→ 小何 →「换」→ 小天 →
 * **「只要女生的再换」** → 工人换成了**英文女声 Dacey**(`en_female_dacey_uranus_bigtts`),
 * 后来又到 **Stokie**。从此每一句中文都是:
 *
 *     volcengine TTS HTTP 400 code=3011 TTSInvalidText: unsupported language
 *
 * 开场白预合成 10 趟全失败,他打过去**一直没声音**,以为 TTS 坏了。
 *
 * ## 这一组钉三件
 *
 *   ① **候选只给会念中文的** —— 「只要女生的」挑出来的不许有英文女声;
 *      他点名要那个英文音色**才给**,而且先说一句「这个只会念英文,中文会没声音」;
 *   ② **换上之前先试一句** —— 8792 回「念不了中文」时,工人如实说,音色一个字没动
 *      (那一句探针在 butler-server/server/services/voiceLanguage.cjs,这里只钉工人怎么说);
 *   ③ **兜底** —— 当前音色连着按语种哑掉,自动退回上一个能用的(或默认 vivi),
 *      记日志、说一句人话,**绝不让整通电话没声音**。
 */
import { describe, expect, it } from 'vitest'
import {
  createVoiceClient,
  parseVoiceList,
  parseWant,
  pickByDescription,
  sampleLine,
  speaksChinese,
} from '../src/voice.ts'
import { DEFAULT_VOICE_ID, RESCUE_AFTER, createVoiceRescue, pickRescueVoice } from '../src/voiceRescue.ts'
import { TOOL_VOICE, createChannelTools } from '../src/tools.ts'
import { ButlerTts } from '../src/tts/butlerTts.ts'
import type { WorkbenchClient } from '../src/workbench.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

/**
 * 8792 `GET /api/voices` 那一份的形状,**带 09-28 新加的 speaks_chinese**。
 * 三个英文的就是真机换到的那几个(Tim / Dacey / Stokie)。
 */
const CATALOG = {
  provider_type: 'volcengine',
  current: { id: 'vv', name: 'vivi 2.0', gender: '女', lang: '中文', speaks_chinese: true, verified: true },
  sample_text: '老板你好,我是你的事务官,平时就用这个声音跟你说话。',
  voices: [
    { id: 'vv', name: 'vivi 2.0', gender: '女', lang: '中文', speaks_chinese: true, verified: true },
    { id: 'can', name: '知性灿灿', gender: '女', styles: ['知性'], lang: '中文', speaks_chinese: true, verified: true },
    { id: 'kea', name: '可爱女生', gender: '女', age: '青年', lang: '中文', speaks_chinese: true, verified: true },
    { id: 'chen', name: '高冷沉稳', gender: '男', styles: ['沉稳'], lang: '中文', speaks_chinese: true, verified: true },
    { id: 'dacey', name: 'Dacey', gender: '女', lang: '英文', accent: '英语', speaks_chinese: false, verified: true },
    { id: 'stokie', name: 'Stokie', gender: '女', lang: '英文', accent: '英语', speaks_chinese: false, verified: true },
    { id: 'tim', name: 'Tim', gender: '男', lang: '英文', accent: '英语', speaks_chinese: false, verified: true },
    // 复刻音色:一格语种都没有 → **「不知道」不是「不会」**,照挑。
    { id: 'S_clone', name: '他自己的嗓子', gender: '男', verified: true },
  ],
}

const list = parseVoiceList(CATALOG)

function stubFetch(reply: (path: string, method: string, body: unknown) => { status: number, body: unknown }) {
  const calls: { path: string, method: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ path, method, body })
    const { status, body: out } = reply(path, method, body)
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl }
}

const NO_WORKBENCH = {} as unknown as WorkbenchClient

// ———————————————————— ① 候选只给会念中文的 ————————————————————

describe('会不会念中文', () => {
  it('8792 说了就照它;没这一格(复刻音色)是「不知道」,**不是「不会」**', () => {
    expect(speaksChinese(list.voices.find(one => one.id === 'vv')!)).toBe(true)
    expect(speaksChinese(list.voices.find(one => one.id === 'dacey')!)).toBe(false)
    expect(speaksChinese(list.voices.find(one => one.id === 'S_clone')!)).toBeUndefined()
  })

  it('老 8792 没有这一格时,按 lang / accent 自己认一遍(英文的认出来)', () => {
    expect(speaksChinese({ id: 'x', lang: '英文', accent: '英语' })).toBe(false)
    expect(speaksChinese({ id: 'y', lang: '中文', accent: '普通话' })).toBe(true)
    expect(speaksChinese({ id: 'z' })).toBeUndefined()
  })
})

describe('挑候选', () => {
  it('★「只要女生的再换」:一个英文女声都不进候选 —— 真机那一晚就是这句话换出 Dacey 的', () => {
    const picked = pickByDescription(list, { want: parseWant('只要女生的再换'), count: 9 })
    expect(picked.map(one => one.id)).not.toContain('dacey')
    expect(picked.map(one => one.id)).not.toContain('stokie')
    // 会念中文的女声排在最前面(英文那两个本来分最高——同性别、生面孔——现在根本不进池子)。
    expect(picked.slice(0, 2).map(one => one.id)).toEqual(['can', 'kea'])
  })

  it('★把库翻到底也不会翻出英文音色', () => {
    const picked = pickByDescription(list, { want: parseWant(''), count: 99 })
    expect(picked.map(one => one.id)).toEqual(expect.not.arrayContaining(['dacey', 'stokie', 'tim']))
    // 「不知道会不会」的复刻音色照在池子里。
    expect(picked.map(one => one.id)).toContain('S_clone')
  })

  it('★他点名要那个英文的才给(「要 Stokie」)', () => {
    expect(pickByDescription(list, { want: parseWant('要 Stokie') })[0]?.id).toBe('stokie')
  })

  it('★他明说要英文音色也给', () => {
    expect(pickByDescription(list, { want: parseWant('要个英文的女声'), count: 9 }).map(one => one.id)).toContain('dacey')
  })

  it('★念样音那一段里先说清「这个只会念英文,中文会没声音」', () => {
    const line = sampleLine({ voice: list.voices.find(one => one.id === 'stokie')!, index: 0, total: 1 })
    expect(line).toContain('只会念英文')
    expect(line).toContain('中文会没声音')
  })
})

// ———————————————————— ② 换上之前先试一句 ————————————————————

describe('wb_set_voice 碰上英文音色', () => {
  it('★他点名要 Stokie:第一次只说那句实话,**音色一个字没动**(没发 PUT)', async () => {
    const { calls, impl } = stubFetch(path => path === '/api/voices'
      ? { status: 200, body: CATALOG }
      : { status: 200, body: { ok: true, voice: { id: 'stokie', name: 'Stokie' } } })
    const tools = createChannelTools({
      workbench: NO_WORKBENCH,
      voice: createVoiceClient({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl: impl }),
    })
    const out = await toolOf(tools, TOOL_VOICE).execute({ which: 'Stokie' }, undefined as never) as string
    expect(out).toContain('只会念英文')
    expect(out).toContain('中文会没声音')
    expect(calls.some(one => one.method === 'PUT')).toBe(false)
  })

  it('★他听完还是要:再说一次就真换(换不成由 8792 说为什么)', async () => {
    const { calls, impl } = stubFetch((path, method) => {
      if (path === '/api/voices') return { status: 200, body: CATALOG }
      if (method === 'PUT') {
        return {
          status: 400,
          body: { code: 'voice_cannot_speak_chinese', error: '「stokie」念不了中文(这个音色念不了这段文字),没换,还用「vivi 2.0」。' },
        }
      }
      return { status: 200, body: { ok: true } }
    })
    const tools = createChannelTools({
      workbench: NO_WORKBENCH,
      voice: createVoiceClient({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl: impl }),
    })
    const tool = toolOf(tools, TOOL_VOICE)
    await tool.execute({ which: 'Stokie' }, undefined as never)
    const again = await tool.execute({ which: 'Stokie' }, undefined as never) as string
    // 8792 那句实话原样传给模型 —— 「念不了中文」「还用原来那个」。
    expect(again).toContain('念不了中文')
    expect(calls.filter(one => one.method === 'PUT')).toHaveLength(1)
  })
})

// ———————————————————— ③ 兜底:连着按语种哑掉就退回去 ————————————————————

describe('pickRescueVoice', () => {
  it('★优先退回指定的那一个(上一个真出过声的)', () => {
    expect(pickRescueVoice(list, 'chen')?.id).toBe('chen')
  })

  it('★没有指定就退回默认 vivi', () => {
    const withDefault = parseVoiceList({
      ...CATALOG,
      current: { id: 'stokie', name: 'Stokie', speaks_chinese: false },
      voices: [...CATALOG.voices, { id: DEFAULT_VOICE_ID, name: 'vivi 2.0', lang: '中文', speaks_chinese: true, verified: true }],
    })
    expect(pickRescueVoice(withDefault)?.id).toBe(DEFAULT_VOICE_ID)
  })

  it('★退回去的那个自己必须会念中文,而且不是现在这个', () => {
    const broken = parseVoiceList({ ...CATALOG, current: { id: 'stokie', speaks_chinese: false } })
    const target = pickRescueVoice(broken, 'dacey')
    expect(target?.id).not.toBe('dacey')
    expect(target?.id).not.toBe('stokie')
    expect(speaksChinese(target!)).not.toBe(false)
  })

  it('一张单子上一个会念中文的都没有 → undefined(不硬塞一个)', () => {
    const onlyEnglish = parseVoiceList({ voices: [{ id: 'stokie', speaks_chinese: false }] })
    expect(pickRescueVoice(onlyEnglish)).toBeUndefined()
  })
})

describe('createVoiceRescue', () => {
  function make(replies?: (path: string, method: string) => { status: number, body: unknown }) {
    const said: string[] = []
    const logs: string[] = []
    const { calls, impl } = stubFetch(replies ?? ((path, method) => path === '/api/voices'
      ? { status: 200, body: { ...CATALOG, current: { id: 'stokie', name: 'Stokie', speaks_chinese: false } } }
      : { status: 200, body: { ok: true, voice: { id: method === 'PUT' ? 'chen' : 'vv', name: '高冷沉稳' } } }))
    const rescue = createVoiceRescue({
      voice: createVoiceClient({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl: impl }),
      say: text => said.push(text),
      log: text => logs.push(text),
    })
    return { rescue, said, logs, calls }
  }

  it('★哑一句不动手(偶尔一句不值得惊动他)', async () => {
    const { rescue, calls, said } = make()
    await rescue.languageMismatch()
    expect(calls).toHaveLength(0)
    expect(said).toEqual([])
  })

  it('★连着哑够两句:自动换回上一个真出过声的,并说一句人话', async () => {
    const { rescue, calls, said, logs } = make()
    rescue.noteSwitched('chen')
    rescue.noteSpoken()
    rescue.noteSwitched('stokie')
    for (let i = 0; i < RESCUE_AFTER; i += 1) await rescue.languageMismatch()
    const put = calls.find(one => one.method === 'PUT')
    expect((put?.body as { voice_id?: string } | undefined)?.voice_id).toBe('chen')
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('念不了中文')
    expect(logs.join('\n')).toContain('chen')
  })

  it('★一轮只救一次:救完归零,不会每一句都去换一遍音色', async () => {
    const { rescue, calls } = make()
    for (let i = 0; i < RESCUE_AFTER * 2; i += 1) await rescue.languageMismatch()
    expect(calls.filter(one => one.method === 'PUT')).toHaveLength(1)
  })

  it('★中间出了一句声音就归零 —— 攒下的那一笔不能跨过一句好声音', async () => {
    const { rescue, calls } = make()
    await rescue.languageMismatch()
    rescue.noteSpoken()
    await rescue.languageMismatch()
    expect(calls.filter(one => one.method === 'PUT')).toHaveLength(0)
  })

  it('★8792 连不上 / 换不回去:只记日志,**不抛**(兜底失手不该再掀翻通话)', async () => {
    const { rescue, logs, said } = make(() => ({ status: 503, body: { error: '她暂时开不了口' } }))
    for (let i = 0; i < RESCUE_AFTER; i += 1) await rescue.languageMismatch()
    expect(logs.join('\n')).toContain('没换回')
    expect(said).toEqual([])
  })
})

describe('ButlerTts 把「念不了这段字」那一类单独报出来', () => {
  /** 8792 的 502 回包,cause.kind = text_rejected(真机那一晚每一句都是这个)。 */
  const failing = (async () => new Response(
    JSON.stringify({
      code: 'tts_failed',
      error: '这个音色念不了这段文字',
      cause: { kind: 'text_rejected', human: '这个音色念不了这段文字(多半是语种对不上)' },
      detail: 'volcengine TTS HTTP 400 code=3011 TTSInvalidText: unsupported language',
    }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch

  async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of stream) { /* 这一组不关心帧 */ }
  }

  it('★每一句这样的失败都通报一次(数几句由兜底那头管)', async () => {
    let mismatched = 0
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: failing,
      stream: false,
      onLanguageMismatch: () => { mismatched += 1 },
    })
    await drain(tts.synthesize('一'))
    await drain(tts.synthesize('二'))
    expect(mismatched).toBe(2)
  })

  it('别的原因(没开通)不当成语种的事', async () => {
    let mismatched = 0
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      stream: false,
      fetchImpl: (async () => new Response(
        JSON.stringify({ error: 'x', cause: { kind: 'not_granted', human: '没开通' }, detail: 'd' }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
      onLanguageMismatch: () => { mismatched += 1 },
    })
    await drain(tts.synthesize('一'))
    expect(mismatched).toBe(0)
  })
})

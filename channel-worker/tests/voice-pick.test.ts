/**
 * 换音色:**按描述挑 + 逐个播样音**(2026-09-23 第二版)。
 *
 * Ben 13:00 的原话:
 *   「用户不大可能直接告诉你用哪个音色,要么就是你先播给他听,要么就是他模糊的描述,
 *     然后你去音色库里挑。」
 * 当天真机:她念了三个名字(知性灿灿 / 可爱女生 / 调皮公主)让他挑,他说 **「怎么都是女的」**
 * —— 三个全是女声、他一个都没听见过。
 *
 * 这一组钉四件事(卡上点名的四条用例):
 *   ① 打分与挑选 —— 「沉稳一点的男声」挑出来的必须是男声;他不要过的往后排;
 *   ② 样音 —— **先真换过去再念**,而且念的是 8792 给的那一句(缓存就是按它存的),下一个提前预热;
 *   ③ 序数与模糊指代 —— 「第二个」「那个男的」「那个沉稳的」都对得上,撞了两个就问;
 *   ④ 「换一批」不重复 —— 念过的不再出现,库翻完了如实说。
 *
 * **向 8792 合成样音在这里全是假的**(stubFetch)。真的缓存在真机第一次播样音时生成。
 */
import { describe, expect, it } from 'vitest'
import {
  askWhichLine,
  createVoiceClient,
  describeVoice,
  matchSpoken,
  parseVoiceList,
  parseWant,
  pickByDescription,
  sampleLine,
  scoreVoice,
  voiceLabel,
  wantOtherThan,
} from '../src/voice.ts'
import { TOOL_VOICE, createChannelTools } from '../src/tools.ts'
import type { WorkbenchClient } from '../src/workbench.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

/** 一个记账的假 fetch(照抄 tests/call-native.test.ts 那一份)。 */
function stubFetch(reply: (path: string, method: string) => { status: number, body: unknown }) {
  const calls: { path: string, method: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    calls.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    const { status, body } = reply(path, method)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl }
}

/** 一张带标签的小目录。形状与 8792 `GET /api/voices` 回的那一份逐字对应。 */
const CATALOG = {
  provider_type: 'volcengine',
  current: { id: 'vv', name: 'vivi 2.0', gender: '女', age: '未标', styles: ['未标'], verified: true },
  sample_text: '老板你好,我是你的事务官,平时就用这个声音跟你说话。',
  voices: [
    { id: 'vv', name: 'vivi 2.0', gender: '女', age: '未标', styles: ['未标'], blurb: '中文女声。', verified: true },
    { id: 'can', name: '知性灿灿', gender: '女', age: '未标', styles: ['知性', '角色感'], blurb: '中文女声,知性。', verified: true },
    { id: 'kea', name: '可爱女生', gender: '女', age: '青年', styles: ['活泼'], blurb: '中文女声,青年感、活泼。', verified: true },
    { id: 'tia', name: '调皮公主', gender: '女', age: '青年', styles: ['活泼', '角色感'], blurb: '中文女声,青年感、活泼。', verified: true },
    { id: 'chen', name: '高冷沉稳', gender: '男', age: '未标', styles: ['沉稳', '高冷'], blurb: '中文男声,沉稳、高冷。', verified: true },
    { id: 'ruy', name: '儒雅青年', gender: '男', age: '青年', styles: ['知性'], blurb: '中文男声,青年感、知性。', verified: true },
    { id: 'hao', name: '东方浩然', gender: '男', age: '未标', styles: ['沉稳'], blurb: '中文男声,沉稳。', verified: true },
    { id: 'xiao', name: '开朗学长', gender: '男', age: '青年', styles: ['活泼'], blurb: '中文男声,青年感、活泼。', verified: true },
    { id: 'ghost', name: '没验过的', gender: '男', age: '未标', styles: ['沉稳'], verified: false },
  ],
}

const list = parseVoiceList(CATALOG)

// ———————————————————————— ① 打分与挑选 ————————————————————————

describe('他那句模糊的描述 → 挑哪几个', () => {
  it('★「沉稳一点的男声」:挑出来的**一个女声都没有**(Ben:「怎么都是女的」那一通)', () => {
    const picked = pickByDescription(list, { want: parseWant('沉稳一点的男声') })
    expect(picked).toHaveLength(3)
    expect(picked.every(one => one.gender === '男')).toBe(true)
    // 沉稳那两个必须在前面 —— 这就是「按描述挑」而不是「按清单顺序取前三」。
    expect(picked.slice(0, 2).map(one => one.name)).toEqual(['高冷沉稳', '东方浩然'])
  })

  it('★「年轻的、活泼的」:年龄感与风格都对上的排第一', () => {
    const picked = pickByDescription(list, { want: parseWant('年轻的、活泼的') })
    expect(picked[0]?.name).toBe('可爱女生')
  })

  it('★性别对不上扣得比风格加得多 —— 一个「沉稳的女声」不会因为沉稳就挤进男声前三', () => {
    const want = parseWant('沉稳的男声')
    const she = { id: 'x', name: '沉稳女', gender: '女', styles: ['沉稳'] }
    const he = { id: 'y', name: '男的', gender: '男', styles: [] }
    expect(scoreVoice(she, want)).toBeLessThan(scoreVoice(he, want))
  })

  it('★正在用的那个不挑 —— 他要的是「换一个」', () => {
    expect(pickByDescription(list, { want: parseWant('') }).map(one => one.id)).not.toContain('vv')
  })

  it('★他什么方向都没给:按「和现在不同性别」挑(现在是女声 → 给三个男声)', () => {
    const picked = pickByDescription(list, { want: wantOtherThan(list.current) })
    expect(picked.every(one => one.gender === '男')).toBe(true)
  })

  it('★他不要过的往后排,但**不是拉黑**(库就这么大,拉黑几轮就没得挑了)', () => {
    const withHistory = parseVoiceList({ ...CATALOG, history: { picked: [], passed: ['chen', 'hao'] } })
    const picked = pickByDescription(withHistory, { want: parseWant('沉稳的男声') })
    expect(picked[0]?.name).not.toBe('高冷沉稳')
    // 仍然在池子里 —— 只是排到后面去了。
    expect(pickByDescription(withHistory, { want: parseWant('沉稳的男声'), count: 9 }).map(one => one.id)).toContain('chen')
  })

  it('★账号清单里查不到的(未验)排在后面 —— 换过去可能根本出不了声', () => {
    const want = parseWant('沉稳的男声')
    const ghost = list.voices.find(one => one.id === 'ghost')
    const hao = list.voices.find(one => one.id === 'hao')
    expect(scoreVoice(ghost!, want)).toBeLessThan(scoreVoice(hao!, want))
  })

  it('他原话里带名字就按名字走(「要那个灿灿」)', () => {
    expect(pickByDescription(list, { want: parseWant('灿灿') })[0]?.name).toBe('知性灿灿')
  })

  it('没标的那两格不加分也不扣分 —— 「未标」是一个真答案,不是 0 分的标签', () => {
    expect(scoreVoice({ id: 'q', gender: '未标', age: '未标', styles: ['未标'] }, parseWant('沉稳的男声'))).toBe(0)
  })

  it('念给他听的简介:有 blurb 就用它;什么都没标就直说「没标」,**不编**', () => {
    expect(describeVoice(list.voices.find(one => one.id === 'chen')!)).toContain('沉稳')
    expect(describeVoice({ id: 'q', gender: '未标', styles: ['未标'] })).toContain('没标')
  })

  it('没有名字的条目退回念 id,不编一个中文名', () => {
    expect(voiceLabel({ id: 'bad' })).toBe('bad')
  })

  it('读不懂的条目挑掉,不抛', () => {
    expect(parseVoiceList({ voices: [{ name: '没有 id' }, 'x', null] }).voices).toEqual([])
    expect(parseVoiceList(undefined).voices).toEqual([])
  })
})

// ———————————————————————— ③ 序数与模糊指代 ————————————————————————

describe('他说的那个是哪一个', () => {
  const offered = [
    list.voices.find(one => one.id === 'chen')!,
    list.voices.find(one => one.id === 'kea')!,
    list.voices.find(one => one.id === 'ruy')!,
  ]

  it('★序数:第二个 / 最后那个', () => {
    expect(matchSpoken(offered, '第二个')).toEqual({ kind: 'one', voice: offered[1] })
    expect(matchSpoken(offered, '就第二个吧')).toEqual({ kind: 'one', voice: offered[1] })
    expect(matchSpoken(offered, '最后那个')).toEqual({ kind: 'one', voice: offered[2] })
  })

  it('★模糊指代:「那个女的」在这一批里只有一个 → 对上', () => {
    expect(matchSpoken(offered, '那个女的')).toEqual({ kind: 'one', voice: offered[1] })
  })

  it('★「那个沉稳的」对上标签,不是对名字', () => {
    expect(matchSpoken(offered, '要那个沉稳的')).toEqual({ kind: 'one', voice: offered[0] })
  })

  it('★撞了两个就问他一句,**绝不挑一个顶上**(换错嗓子他一耳朵听得出来)', () => {
    const matched = matchSpoken(offered, '那个男的')
    expect(matched.kind).toBe('many')
    const said = askWhichLine(matched.kind === 'many' ? matched.voices : [])
    expect(said).toContain('高冷沉稳')
    expect(said).toContain('儒雅青年')
    expect(said).not.toContain('chen')
  })

  it('★名字压过标签:他说得出名字就是指那一个', () => {
    expect(matchSpoken(offered, '知性灿灿', list.voices)).toEqual({ kind: 'one', voice: list.voices.find(one => one.id === 'can') })
    expect(matchSpoken(offered, '灿灿', list.voices).kind).toBe('one')
  })

  it('★一句都对不上就回 none,由调用方去问', () => {
    expect(matchSpoken(offered, '海豚叫', list.voices)).toEqual({ kind: 'none' })
    expect(matchSpoken(offered, '  ')).toEqual({ kind: 'none' })
  })

  it('这一批只有两个,他说「第三个」→ none,不绕回第一个', () => {
    expect(matchSpoken(offered.slice(0, 2), '第三个')).toEqual({ kind: 'none' })
  })
})

// ———————————————————————— ② 样音那一句 ————————————————————————

describe('念样音的那段话', () => {
  const chen = list.voices.find(one => one.id === 'chen')!

  it('★样句**一字不差**照 8792 给的那一句(盘上的缓存就是按它的 sha1 存的)', () => {
    const said = sampleLine({ voice: chen, index: 0, total: 3, sampleText: CATALOG.sample_text })
    expect(said).toContain(CATALOG.sample_text)
    expect(said).toContain('一字不差')
  })

  it('★念的是名字与人话简介,**没有 id**', () => {
    const said = sampleLine({ voice: chen, index: 0, total: 3, because: '沉稳一点的男声' })
    expect(said).toContain('高冷沉稳')
    expect(said).toContain('沉稳')
    expect(said).not.toContain('chen')
  })

  it('8792 没给样句就用兜底那一句,不留空', () => {
    expect(sampleLine({ voice: chen, index: 1, total: 3 })).toContain('事务官')
  })

  it('★未验的那一个:先说一句「这个我没验过」', () => {
    const said = sampleLine({ voice: list.voices.find(one => one.id === 'ghost')!, index: 0, total: 3 })
    expect(said).toContain('没验过')
  })

  it('最后一个要说清是最后一个 —— 免得他等第四个', () => {
    expect(sampleLine({ voice: chen, index: 2, total: 3 })).toContain('最后一个')
  })
})

// ———————————————————————— 工具:一整轮走下来 ————————————————————————

describe('wb_set_voice:挑 → 逐个播 → 他定下来', () => {
  function made(catalog: unknown = CATALOG) {
    const stub = stubFetch((path, method) => {
      if (method === 'PUT') {
        const want = String((stub.calls.at(-1)?.body as { voice_id?: string })?.voice_id ?? '')
        const hit = CATALOG.voices.find(one => one.id === want)
        return { status: 200, body: { ok: true, voice: hit ?? { id: want } } }
      }
      if (path === '/api/voices/passed' || path === '/api/voices/sample') return { status: 200, body: { ok: true } }
      return { status: 200, body: catalog }
    })
    const voice = createVoiceClient({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl: stub.impl })
    return { stub, tool: toolOf(createChannelTools({ workbench: {} as WorkbenchClient, voice }), TOOL_VOICE) }
  }

  const puts = (stub: { calls: { path: string, method: string, body: unknown }[] }) =>
    stub.calls.filter(one => one.method === 'PUT').map(one => (one.body as { voice_id: string }).voice_id)

  it('★第一次:按描述挑,**当场就换成第一个**(不换他就听不见),而且带 preview', async () => {
    const { stub, tool } = made()
    const text = String(await tool.execute({ like: '沉稳一点的男声' }, {} as never))
    expect(text).toContain('高冷沉稳')
    expect(text).toContain(CATALOG.sample_text)
    expect(puts(stub)).toEqual(['chen'])
    expect(stub.calls.find(one => one.method === 'PUT')?.body).toMatchObject({ preview: true })
  })

  it('★播第一个的时候,**第二个已经在 8792 那边合了**(样音缓存,下一个秒播)', async () => {
    const { stub, tool } = made()
    await tool.execute({ like: '沉稳一点的男声' }, {} as never)
    const warm = stub.calls.find(one => one.path === '/api/voices/sample')
    expect(warm?.body).toEqual({ voice_id: 'hao' })
  })

  it('★「听下一个」:什么都不填再调一次 → 换成第二个,不重挑一批', async () => {
    const { stub, tool } = made()
    await tool.execute({ like: '沉稳一点的男声' }, {} as never)
    const text = String(await tool.execute({}, {} as never))
    expect(text).toContain('第二个')
    expect(text).toContain('东方浩然')
    expect(puts(stub)).toEqual(['chen', 'hao'])
  })

  it('★他说「第二个」:定下来,并把没要的那两个记一笔(下次别再推同一批)', async () => {
    const { stub, tool } = made()
    await tool.execute({ like: '沉稳一点的男声' }, {} as never)
    const text = String(await tool.execute({ which: '第二个' }, {} as never))
    expect(text).toContain('定了')
    expect(text).toContain('东方浩然')
    // 定下来那一次**不带 preview** —— 8792 才会把它记进「他挑过的」。
    const last = stub.calls.filter(one => one.method === 'PUT').at(-1)
    expect(last?.body).toEqual({ voice_id: 'hao' })
    const passed = stub.calls.find(one => one.path === '/api/voices/passed')
    expect((passed?.body as { voice_ids: string[] }).voice_ids.sort()).toEqual(['chen', 'ruy'])
  })

  it('★「那个男的」在这一批里撞了两个:问他一句,**音色一个字没动**', async () => {
    const { stub, tool } = made()
    // 这一批三个全是男声(他要的就是男声)—— 「那个男的」在这里指不出一个来。
    await tool.execute({ like: '年轻的男声' }, {} as never)
    const before = puts(stub).length
    const text = String(await tool.execute({ which: '那个男的' }, {} as never))
    expect(text).toContain('都对得上')
    expect(puts(stub)).toHaveLength(before)
  })

  it('★「换一批」:三个全记成他不要的,新的三个**一个都不重复**', async () => {
    const { stub, tool } = made()
    await tool.execute({ like: '沉稳一点的男声' }, {} as never)
    const first = puts(stub)[0]
    const text = String(await tool.execute({ action: 'again' }, {} as never))
    expect(text).not.toContain('高冷沉稳')
    expect(puts(stub).at(-1)).not.toBe(first)
    const passed = stub.calls.filter(one => one.path === '/api/voices/passed')
    expect((passed[0]?.body as { voice_ids: string[] }).voice_ids).toEqual(['chen', 'hao', 'ruy'])
  })

  it('★一直「换一批」到库翻完:如实说没有了,**不回头把老的再念一遍**', async () => {
    const { tool } = made()
    await tool.execute({ like: '沉稳一点的男声' }, {} as never)
    let text = ''
    for (let i = 0; i < 5; i += 1) text = String(await tool.execute({ action: 'again' }, {} as never))
    expect(text).toContain('都念过一遍了')
  })

  it('★这一批三个都播完了:问他挑哪个,**不自己接着往下翻**', async () => {
    const { tool } = made()
    await tool.execute({ like: '沉稳一点的男声' }, {} as never)
    await tool.execute({}, {} as never)
    await tool.execute({}, {} as never)
    const text = String(await tool.execute({}, {} as never))
    expect(text).toContain('都播过了')
    expect(text).toContain('换一批')
  })

  it('★「算了」:换回他原来那个', async () => {
    const { stub, tool } = made()
    await tool.execute({ like: '沉稳一点的男声' }, {} as never)
    const text = String(await tool.execute({ action: 'cancel' }, {} as never))
    expect(text).toContain('换回原来那个')
    expect(puts(stub).at(-1)).toBe('vv')
  })

  it('★8792 换不了 → 如实说没换成,**不许说换好了**', async () => {
    const stub = stubFetch((path, method) => (
      method === 'PUT'
        ? { status: 400, body: { error: '这个供应商没有这个音色' } }
        : { status: 200, body: CATALOG }
    ))
    const voice = createVoiceClient({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl: stub.impl })
    const tool = toolOf(createChannelTools({ workbench: {} as WorkbenchClient, voice }), TOOL_VOICE)
    const text = String(await tool.execute({ like: '男声' }, {} as never))
    expect(text).toContain('没换成')
    expect(text).not.toContain('换好了')
  })

  it('★记一笔失败不影响换音色 —— 它是「挑得更顺手」,不是功能本身', async () => {
    const stub = stubFetch((path, method) => {
      if (path === '/api/voices/passed') return { status: 500, body: { error: '写不动' } }
      if (method === 'PUT') return { status: 200, body: { ok: true, voice: { id: 'hao', name: '东方浩然' } } }
      return { status: 200, body: CATALOG }
    })
    const voice = createVoiceClient({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl: stub.impl })
    const tool = toolOf(createChannelTools({ workbench: {} as WorkbenchClient, voice }), TOOL_VOICE)
    await tool.execute({ like: '沉稳一点的男声' }, {} as never)
    expect(String(await tool.execute({ which: '第二个' }, {} as never))).toContain('定了')
  })

  it('没接上 8792:这件工具压根不给模型 —— 有一件调不通的比没有更糟', () => {
    const tools = createChannelTools({ workbench: {} as WorkbenchClient })
    expect((tools as Record<string, unknown>)[TOOL_VOICE]).toBeUndefined()
  })
})

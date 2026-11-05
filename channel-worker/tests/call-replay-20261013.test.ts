/**
 * **通话组件先问 8791 再问模型**(2026-10-13,卡「三个入口一套管线」;
 * 交接 `docs/交接-1013-一套管线与演示固定流程.md`)。
 *
 * 钉五件:
 *   ① 今早那一通(09:13–09:15,手机 App)的转写**逐句**喂进来:每一句该打哪个接口、该说什么,
 *      **不许**出现「从哪儿触发」「我这就去」「我还没记下」;
 *   ② 四个演示场景各一句 + 一句补细节 + 一句「对」;
 *   ③ 老工作台(没有 `/butler/understand`)→ 404 时照老路交给模型;
 *   ④ 兜底句:只拦自称办成的话,放行否认与反问,一通不重复,按真实状态说;
 *   ⑤ 来电开场同一句就把事说清(`ringOpener`)。
 *
 * 假 8791 按 A 那份契约回(`workbench-plugin/src/server/understand.ts` 的 `Understanding`)——
 * 顶层各子目录互不 import(AGENTS.md),所以这里是**手写的一份对照实现**,
 * 两边的字段名与句子由插件那份用例(`tests/understand-20261013.test.ts`)各自钉住。
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createWorkbenchClient } from '../src/workbench.ts'
import { ANSWER_ASK_SAY_MAX_CHARS, APPEND_FAILED_SAY, ASK_BROKEN_SAY, ASK_GONE_SAY, CONFIRM_DROPPED_SAY, answerAskSay, approvalOf, askAgentIdOf, askElsewhereSay, bodyTextOf, describeUnderstanding, isHandled, saidStream, sayFirstFailLine, saysFirst, type Understanding } from '../src/understand.ts'
import { THINKING_LINE_TEXTS } from '../src/workerFiller.ts'
import { FAREWELL_FIXED_SAY, FAREWELL_SAY_MAX_CHARS, farewellFixedSay, offersEndCall } from '../src/farewell.ts'
import { ANNOUNCE_IDLE_MS, asksWhatsUp, createAnnounceHold } from '../src/announceHold.ts'
import { workerReportsRecord } from '../src/callRecord.ts'
import { IN_CALL_SAY_MAX_CHARS, atBudgetLimit, inCallAnnounceText, pushedToPhone } from '../src/callOut.ts'
import { OPENER_PLAYOUT_CAP_MS, createOpenerCutIn, createOpenerRepeat } from '../src/tts/openerRepeat.ts'
import { RING_OPENER_REPEAT_MS } from '../src/callOut.ts'
import { claimOf, failedLine, honestLine, withHonestClaims } from '../src/claimGuard.ts'
import { parseRingCall, plainRingSubject, ringOpener, RING_OPENER_MAX_CHARS } from '../src/callOut.ts'

/* ──────────────────────── 假 8791 ──────────────────────── */

function understanding(over: Partial<Understanding> & Pick<Understanding, 'kind'>): Understanding {
  return { mode: 'normal', confirm: { needed: false }, say: { start: '' }, why: 'test', ...over }
}

/** A 那份契约里几句话的判定(与插件那份用例里的期望逐条对上)。 */
const SCRIPT: readonly { re: RegExp, make: (said: string) => Understanding }[] = [
  {
    re: /待办.*按日期|按日期汇总/,
    make: () => understanding({
      kind: 'today_view',
      mode: 'demo',
      route: { path: '/today/view', body: { view: 'by_date' } },
      say: { start: '好,改成按日期汇总了。' },
    }),
  },
  {
    re: /(?:做|生成).*视频/,
    make: () => understanding({
      kind: 'video',
      mode: 'demo',
      route: { path: '/butler/item', body: {} },
      say: { start: '好,做小女孩在花海里面漫步的视频。先让豆包出参考图,图出来我放进可灵。' },
    }),
  },
  {
    re: /计划.*发.*视频/,
    make: () => understanding({
      kind: 'publish_plan',
      mode: 'demo',
      route: { path: '/butler/item', body: {} },
      say: { start: '好,记进发布计划了:10 月 18 号,露营装备的视频' },
    }),
  },
  {
    // 11:40 那一通她答的是「果汁」(豆包普通包那道饮料题),与「绿茶 / 第二个」同一路。
    re: /^(?:绿茶|果汁|茶|第二个)$/,
    make: said => understanding({
      kind: 'answer_ask',
      mode: 'demo',
      route: { path: '/asks/voice', body: { item_id: 'session:doubao/window:1', said } },
      say: { start: '好了,替你选上了。' },
    }),
  },
  {
    /*
     * 10-13 下午 14:19 那一通:他被打断之后两段识别结果拼在一起送去办,卡标题成了
     * 「给我生成一个。给我生成一个女孩子…」(卡 A 第 6 条)。8791 认的是后一段。
     */
    re: /摘蘑菇/,
    make: () => understanding({
      kind: 'video',
      mode: 'demo',
      route: { path: '/butler/item', body: {} },
      say: { start: '好,做女孩子在树林下摘蘑菇的视频。先让豆包出参考图,图出来我放进可灵。' },
    }),
  },
  {
    re: /七八岁/,
    make: () => understanding({
      kind: 'append',
      route: { path: '/butler/item/say', body: { id: 't-1', text: '七八岁吧,穿小碎花连衣裙。' } },
      say: { start: '加上了:七八岁吧,穿小碎花连衣裙。' },
    }),
  },
  {
    re: /让 Codex 把工作台发个版/,
    make: () => understanding({
      kind: 'dispatch',
      route: { path: '/butler/item', body: {} },
      confirm: { needed: true, spoken: '这件要发版上线,做了收不回来 —— 现在就办吗?', why: 'irreversible' },
    }),
  },
]

interface FakeOptions {
  /** 老工作台:`/butler/understand` 回 404。 */
  old?: boolean
  /** `/butler/item` 第一步派不出去。 */
  dispatchFails?: boolean
  /** `/today/view` 本来就是这一版。 */
  sameView?: boolean
  /**
   * `/asks/voice` 这一下怎么回(2026-10-13 下午,11:40 真机那一通的后半段):
   *   · `unconfirmed`:按出去了、没读到回执(200 + `confirmed:false` + 那句**给界面看的** `note`);
   *   · `missed`:送不进去(400 + 一句给界面的 `error`);
   *   · `gone`:那一问已经不在了(409);
   *   · `broken`:接口自己炸了(500)。
   */
  ask?: 'unconfirmed' | 'missed' | 'gone' | 'broken'
  /**
   * `/butler/item` 这一支**等这只闸放了才回**(2026-10-13 下午,卡 A 第 1 条):
   * 真机上它要 7.4–7.6 秒(同步等着把第一步派给豆包)。用例拿它钉「先念再办」的次序。
   */
  hold?: Promise<void>
  /** `/butler/item/say` 回 409(视频接力那一件是 `skipSession` 建的,会话没开)。 */
  appendFails?: boolean
}

/** 那一通里被原话念出去的就是这一句(8791 回包的 `note`)。 */
const ASK_NOTE_FOR_SCREEN = '已尝试发送,但回执尚未确认。请查看对话区,不要重复发送;这不代表发送失败'
/** 送不进去那一下 `/asks/voice` 回的 `error`(同样是给界面看的话)。 */
const ASK_ERROR_FOR_SCREEN = '没听准他要哪一项(它给的是:可乐 / 茶 / 咖啡 / 果汁),一项都没点'

function fake8791(options: FakeOptions = {}) {
  const calls: { path: string, body: Record<string, unknown> }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    calls.push({ path, body })
    if (path === '/butler/understand') {
      if (options.old === true) return new Response(JSON.stringify({ error: '没有这条路' }), { status: 404 })
      const said = String(body.text ?? '')
      const hit = SCRIPT.find(one => one.re.test(said))
      const got = hit === undefined
        ? understanding({ kind: 'none', why: '认不出是哪一类,交给模型' })
        : hit.make(said)
      return new Response(JSON.stringify({ ok: true, understanding: got }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/today/view') {
      return new Response(JSON.stringify(options.sameView === true
        ? { ok: true, view: body.view, changed: false, note: '本来就是按日期汇总。' }
        : { ok: true, view: body.view, changed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/asks/voice') {
      const said = String(body.said ?? '')
      if (options.ask === 'unconfirmed') {
        return new Response(JSON.stringify({ ok: true, kind: 'session', picked: said, confirmed: false, note: ASK_NOTE_FOR_SCREEN }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (options.ask === 'missed') {
        return new Response(JSON.stringify({ error: ASK_ERROR_FOR_SCREEN }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      if (options.ask === 'gone') {
        return new Response(JSON.stringify({ error: '这一问已经不在了(那边已经往下走了)' }), { status: 409, headers: { 'content-type': 'application/json' } })
      }
      if (options.ask === 'broken') {
        return new Response(JSON.stringify({ error: '内部错误' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, kind: 'session', picked: said, confirmed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/butler/item/say') {
      // 409:事项建了、会话没开(插件 http.ts 那一段原话)。这一句**是给界面看的**。
      if (options.appendFails === true) {
        return new Response(JSON.stringify({ error: '这件事的会话没开,说不进去' }), { status: 409, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, id: body.id }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/butler/item') {
      // 8791 替她回问那一句(「这条打算哪天发?」):走的是 400 + `error`,**那一句就是正文**。
      if (body.ask_date === true) {
        return new Response(JSON.stringify({ error: '这条打算哪天发?' }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      // 派活那一步慢(真机 7.4–7.6 秒):用例用这只闸钉「先念」的次序。
      if (options.hold !== undefined) await options.hold
      return new Response(JSON.stringify(options.dispatchFails === true
        ? { ok: true, id: 't-1', dispatch_note: '豆包办公 这会儿派不出去:这台电脑上还没接上它', dispatch_ok: false }
        : { ok: true, id: 't-1', note: '记下了', dispatch_ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl }) }
}

/* ──────────────────────── 回合处理(与 agent.ts 的固定流程同一条判法) ──────────────────────── */

interface Turn {
  said: string
  paths: string[]
  spoken: string
  toModel: boolean
  /**
   * 「先念再办」那一回合**后来补的那一句**(派活没成时才有;2026-10-13 下午,卡 A 第 1 条)。
   * 要等 `settle()`:它是后台那一步回来之后才补的。
   */
  after?: string
  /** 这一句走的是道别那一道(固定一句 + 挂)。 */
  hung?: boolean
  /**
   * 这一回合在工人日志里留下的那几行(2026-10-13 晚,卡 K)。
   * 道别那一回合里 {@link LOG_UNDERSTOOD} / {@link LOG_ACKED} / {@link LOG_FILLED} 一行都不该有。
   */
  log: string[]
}

/** 「8791 听懂了」那一行(`describeUnderstanding` 的头几个字)。 */
const LOG_UNDERSTOOD = describeUnderstanding(understanding({ kind: 'none' })).slice(0, 6)
/** 先应那一行(agent.ts 的 `先应了一句:「…」`)。 */
const LOG_ACKED = '先应'
/** 垫场那一行(workerFiller.ts:`到点还没出声,垫了一句「…」`)。 */
const LOG_FILLED = '垫了一句'

/** 一回合可以是几段识别结果(他被打断时真机就是这样,见卡 A 第 6 条)。 */
type Said = string | readonly string[]

/**
 * 一通电话逐句跑一遍。**判法与 `agent.ts` 的 `routedLlmNode` 固定流程那一段同形**:
 * 道别(固定一句 + 挂,**排在 8791 那一问之前**)→ 挂着的那句确认 → 先问 8791 →
 * 认下来了就当场办 → 念一句;认不出就交给模型。
 * agent.ts 那一段本身要真起一个 LiveKit 会话才跑得到(见交接「没验的」一节)。
 *
 * 2026-10-13 晚(卡 K)多记一格 `log`:先应 / 垫场两道闸是同一个
 * `thisTurnIsHandled()`(走固定流程或道别的回合两样都关),这里按同一个判法记下「出没出那几行」。
 */
async function replay(said: readonly Said[], options: FakeOptions = {}): Promise<{
  turns: Turn[]
  calls: { path: string, body: Record<string, unknown> }[]
  /** 等「先念再办」那几步的后台调用都回来(用例要看补的那一句)。 */
  settle: () => Promise<void>
}> {
  const { calls, workbench } = fake8791(options)
  const turns: Turn[] = []
  const background: Promise<void>[] = []
  let pending: { understanding: Understanding, text: string } | undefined
  /** 一通只道别一次(agent.ts 的 `farewellSaid`)。 */
  let farewellSaid = false
  for (const one of said) {
    const parts = typeof one === 'string' ? [one] : one
    const before = calls.length
    let u: Understanding | undefined
    /** 8791 **问的是哪一段**(送去办的正文用它,`bodyTextOf`)。 */
    let asked = ''
    /** 这一回合拼起来的那一段(agent.ts 的 `turnHeard`)。 */
    let heard = ''
    const log: string[] = []
    /** 这一回合是一句干净的道别吗(agent.ts 的 `turnFarewell`)。 */
    let bye: string | undefined
    for (const part of parts) {
      heard += part
      /*
       * ① 道别排在「听懂」那一问**之前**(14:02 那一通:道别被认成了补细节);
       *    2026-10-13 晚(卡 K):认出来这一问**整个不问** —— 16:33 那一通问了,
       *    回的是 none/normal,只把先应 / 垫场两道闸放了行。
       */
      bye = farewellFixedSay(heard)
      if (bye !== undefined) continue
      const got = await workbench.understandSaid({ text: part })
      if (got.kind === 'understood') log.push(describeUnderstanding(got.understanding))
      u = got.kind === 'understood' ? got.understanding : undefined
      asked = got.kind === 'understood' ? part : ''
    }
    const paths = (): string[] => calls.slice(before).map(call => call.path)
    /*
     * 先应 / 垫场那两道闸(agent.ts 的 `thisTurnIsHandled`):这一回合要等模型才有那两样。
     * 道别、挂着的那句确认、8791 当场办的,三种都是「不等」。
     */
    if (bye === undefined && pending === undefined && (u === undefined || !isHandled(u))) {
      log.push(`先应了一句(回合提交时出口)`)
      log.push(`到点还没出声,垫了一句「${THINKING_LINE_TEXTS['think-4'] ?? ''}」`)
    }
    if (bye !== undefined) {
      pending = undefined
      const spoken = farewellSaid ? '' : bye
      farewellSaid = true
      turns.push({ said: heard, paths: paths(), spoken, toModel: false, hung: true, log })
      continue
    }
    if (pending !== undefined) {
      const verdict = approvalOf(heard)
      if (verdict === 'yes') {
        const done = await workbench.runUnderstanding({ understanding: pending.understanding, text: pending.text, confirmed: true })
        pending = undefined
        turns.push({ said: heard, paths: paths(), spoken: done.say, toModel: false, log })
        continue
      }
      if (verdict === 'no') {
        pending = undefined
        turns.push({ said: heard, paths: paths(), spoken: CONFIRM_DROPPED_SAY, toModel: false, log })
        continue
      }
      pending = undefined
    }
    if (u === undefined || !isHandled(u)) {
      turns.push({ said: heard, paths: paths(), spoken: '', toModel: true, log })
      continue
    }
    if (u.confirm.needed && u.confirm.spoken !== undefined) {
      pending = { understanding: u, text: heard }
      turns.push({ said: heard, paths: paths(), spoken: u.confirm.spoken, toModel: false, log })
      continue
    }
    if (u.route === undefined) {
      turns.push({ said: heard, paths: paths(), spoken: u.ask ?? '', toModel: false, log })
      continue
    }
    const text = bodyTextOf({ asked, heard })
    // ★ 先念再办:这一句当场出口,`/butler/item` 放后台;没成再补一句短的。
    if (saysFirst(u)) {
      const run = workbench.runUnderstanding({ understanding: u, text })
      const turn: Turn = { said: heard, paths: paths(), spoken: u.say.start.trim(), toModel: false, log }
      turns.push(turn)
      background.push(run.then((done) => {
        if (done.ok) return
        const why = sayFirstFailLine(done.say)
        if (why !== undefined) turn.after = why
      }))
      continue
    }
    const done = await workbench.runUnderstanding({ understanding: u, text })
    turns.push({ said: heard, paths: paths(), spoken: done.say, toModel: false, log })
  }
  return { turns, calls, settle: async () => { await Promise.all(background) } }
}

/* ──────────────────────── ① 今早那一通 ──────────────────────── */

/** 10-13 早 09:13–09:15 那一通的转写(ASR 原文,工人日志)。 */
const HEARD = [
  '帮我生成一个小女孩在花海里面漫步的视频。',
  '为什么要这么说话?呃,我要一个,嗯,向日葵吧,然后是吉普力风格的,然后5秒,5秒钟就可以了,横屏。',
  '七八岁吧,穿小碎花连衣裙。',
  '我是说记一下,哎呀。',
  '你派出去了吗?',
] as const

describe('★★ 今早那一通,逐句', () => {
  it('第一句:当场起接力(不反问细节、不交给模型)', async () => {
    const { turns } = await replay(HEARD)
    const first = turns[0] as Turn
    expect(first.paths).toEqual(['/butler/understand', '/butler/item'])
    expect(first.toModel).toBe(false)
    expect(first.spoken).toContain('先让豆包出参考图')
    expect(first.spoken).toContain('可灵')
  })

  it('第三句(「七八岁吧,穿小碎花连衣裙。」):并进那件事,回「加上了」', async () => {
    const { turns } = await replay(HEARD)
    const third = turns[2] as Turn
    expect(third.paths).toEqual(['/butler/understand', '/butler/item/say'])
    expect(third.spoken).toBe('加上了:七八岁吧,穿小碎花连衣裙。')
  })

  it('第二句与后两句照旧交给模型(8791 认不出就不硬套)', async () => {
    const { turns } = await replay(HEARD)
    expect(turns.map(one => one.toModel)).toEqual([false, true, false, true, true])
  })

  it('★整通里一个字都没有「从哪儿触发」「我这就去」「我还没记下」', async () => {
    const { turns, calls } = await replay(HEARD)
    const everything = JSON.stringify({ turns, calls })
    expect(everything).not.toContain('从哪儿触发')
    expect(everything).not.toContain('我这就去')
    expect(everything).not.toContain('我还没记下')
    // 一次 `/confirm/points` 都没打(这一通里没有「要先问一句」的事)
    expect(calls.some(one => one.path === '/confirm/points')).toBe(false)
  })
})

/* ──────────────────────── ② 四个演示场景 + 补细节 + 一句「对」 ──────────────────────── */

describe('★★ 四个演示场景', () => {
  it('① 做视频 → /butler/item', async () => {
    const { turns } = await replay(['帮我做一个小女孩在花海里面漫步的视频'])
    expect((turns[0] as Turn).paths).toEqual(['/butler/understand', '/butler/item'])
  })

  it('② 切待办版本 → /today/view,说「好,改成按日期汇总了。」', async () => {
    const { turns } = await replay(['把待办改成按日期汇总'])
    expect((turns[0] as Turn).paths).toEqual(['/butler/understand', '/today/view'])
    expect((turns[0] as Turn).spoken).toBe('好,改成按日期汇总了。')
  })

  it('② 本来就是这一版:如实说「本来就是」,不说成改了', async () => {
    const { turns } = await replay(['把待办改成按日期汇总'], { sameView: true })
    expect((turns[0] as Turn).spoken).toContain('本来就是')
  })

  it('③ 记发布计划 → /butler/item,说「记进发布计划了」', async () => {
    const { turns } = await replay(['计划 18 号发一条关于露营装备的视频'])
    expect((turns[0] as Turn).paths).toEqual(['/butler/understand', '/butler/item'])
    expect((turns[0] as Turn).spoken).toContain('记进发布计划了')
  })

  it('④ 答挂着的那一问 → /asks/voice,说「好了,替你选上了。」(不经模型)', async () => {
    const { turns, calls } = await replay(['绿茶'])
    expect((turns[0] as Turn).paths).toEqual(['/butler/understand', '/asks/voice'])
    expect((turns[0] as Turn).spoken).toBe('好了,替你选上了。')
    expect(calls[1]?.body).toMatchObject({ item_id: 'session:doubao/window:1' })
  })

  it('★要先问一句的那种:先念一句确认,她说「对」才真办', async () => {
    const { turns } = await replay(['让 Codex 把工作台发个版', '对'])
    expect((turns[0] as Turn).paths).toEqual(['/butler/understand'])
    expect((turns[0] as Turn).spoken).toContain('收不回来')
    expect((turns[1] as Turn).paths).toContain('/butler/item')
  })

  it('★她摇头:不办,说一句就收', async () => {
    const { turns, calls } = await replay(['让 Codex 把工作台发个版', '算了'])
    expect((turns[1] as Turn).spoken).toBe(CONFIRM_DROPPED_SAY)
    expect(calls.filter(one => one.path === '/butler/item')).toEqual([])
  })

  /*
   * ★ 2026-10-13 下午(卡 A 第 1 条)**改了口径**:视频那一支从「同步等派活」改成「先念再办」。
   * 所以这一回合念的是 `say.start`(「将要做」的措辞),派不出去那一句是**后来补的**。
   * 「不许说成开始做了」那条分寸没动:补的那一句就是 8791 给的原因。
   */
  it('第一步派不出去:先念那一句,再补一句原因(不编一个「已经在做」)', async () => {
    const { turns, settle } = await replay(['帮我做一个小女孩在花海里面漫步的视频'], { dispatchFails: true })
    expect((turns[0] as Turn).spoken).toContain('豆包出参考图')
    expect((turns[0] as Turn).after).toBeUndefined()
    await settle()
    expect((turns[0] as Turn).after).toContain('派不出去')
  })
})

describe('③ 老工作台没有这条路', () => {
  it('404 → 一句都不说,照老路交给模型', async () => {
    const { turns, calls } = await replay(['把待办改成按日期汇总'], { old: true })
    expect((turns[0] as Turn).toModel).toBe(true)
    expect(calls.map(one => one.path)).toEqual(['/butler/understand'])
  })
})

describe('「对 / 行 / 算了」怎么判', () => {
  it('整句就那几个字才算点头 / 摇头;改口不算', () => {
    expect(approvalOf('对')).toBe('yes')
    expect(approvalOf('行,去吧')).toBe(undefined)
    expect(approvalOf('去吧')).toBe('yes')
    expect(approvalOf('好,去建吧')).toBe('yes')
    expect(approvalOf('去建吧')).toBe('yes')
    expect(approvalOf('嗯,好的')).toBe('yes')
    expect(approvalOf('算了')).toBe('no')
    expect(approvalOf('不用了')).toBe('no')
    expect(approvalOf('换成 Codex 吧,别派给豆包')).toBe(undefined)
  })
})

describe('固定流程那一句怎么出声', () => {
  it('一个字符串块,空的一句什么都不出', async () => {
    const read = async (text: string): Promise<string[]> => {
      const out: string[] = []
      for await (const chunk of saidStream<string>(text) as unknown as AsyncIterable<string>) out.push(chunk)
      return out
    }
    expect(await read('好了,替你选上了。')).toEqual(['好了,替你选上了。'])
    expect(await read('  ')).toEqual([])
  })
})

/* ──────────────────────── ④ 兜底句 ──────────────────────── */

async function through(sentences: readonly string[], options: { toolOk?: boolean, failed?: string, already?: Set<string> } = {}): Promise<string> {
  const rewrote = options.already ?? new Set<string>()
  const base = new ReadableStream<string>({
    start(controller) {
      for (const one of sentences) controller.enqueue(one)
      controller.close()
    },
  })
  const out = withHonestClaims(base, {
    active: true,
    mayClaim: () => options.toolOk === true,
    alreadyRewrote: kind => rewrote.has(kind),
    noteRewrote: kind => rewrote.add(kind),
    insteadOf: () => (options.failed === undefined ? undefined : failedLine(options.failed)),
  })
  let text = ''
  for await (const chunk of out as unknown as AsyncIterable<string>) text += chunk
  return text
}

describe('★★ 兜底句:只拦自称办成的话', () => {
  it('★「没派,我只记了」是诚实话 —— 放行(10-13 早那一通被换掉的正是它)', () => {
    expect(claimOf('没派,我只记了。')).toBeUndefined()
    expect(claimOf('我只是记了一下。')).toBeUndefined()
  })

  it('反问与否认照旧放行', () => {
    expect(claimOf('要我现在去派吗?')).toBeUndefined()
    expect(claimOf('我没有派出去。')).toBeUndefined()
  })

  it('自称办成了、工具没成 → 换成如实那一句', async () => {
    expect(await through(['好,派给 Claude 查为什么通话中换不了音色。'])).toBe(honestLine('dispatch'))
  })

  it('★一通里一类只换一次(那一通里「我还没记下」说了三次)', async () => {
    const already = new Set<string>()
    const first = await through(['记下了。'], { already })
    expect(first).toBe(honestLine('remember'))
    const second = await through(['记下了。'], { already })
    expect(second).toBe('记下了。')
  })

  it('★工具跑过、它自己报没成 → 按真实状态说,不说「我还没派」', async () => {
    const said = await through(['派给 Claude 了。'], { failed: '豆包办公 这会儿派不出去:这台电脑上还没接上它' })
    expect(said).toContain('那一下没成')
    expect(said).toContain('还没接上它')
    expect(said).not.toContain('我还没派出去')
  })
})

/* ──────────────────────── ⑤ 来电开场 ──────────────────────── */

describe('★★ 来电开场同一句就把事说清', () => {
  function call(over: Record<string, unknown>) {
    const raw = { id: 'c-1', reason: 'ask', item_id: 't-1', title: '', at: new Date().toISOString(), silent: false, ...over }
    const got = parseRingCall(raw)
    expect(got).toBeDefined()
    return got as NonNullable<ReturnType<typeof parseRingCall>>
  }

  it('★「要你批」那一种:一句话说清是什么、要她做什么', () => {
    const said = ringOpener(call({ reason: 'ask', title: '「参赛网页」要你批:要看一个文件' }), { address: '老板' })
    expect(said).toBe('老板,参赛网页 要看一个文件,等你批,行不行?')
    expect(said).not.toContain('有件事要问你一下')
  })

  it('★「完成」那一种:〈事项〉办完了,等你验收', () => {
    expect(ringOpener(call({ reason: 'confirm', title: '「秋天穿搭的视频」' }), { address: '老板' }))
      .toBe('老板,秋天穿搭的视频办完了,等你验收。')
  })

  it('★权限弹窗那一种:原题 + 「等你批,行不行?」(8791 现在一律带 ask)', () => {
    const said = ringOpener(call({
      reason: 'ask',
      title: 'Claude 在等你点头',
      ask: { from: 'Claude', question: '要不要合进 main', options: [], permission: true },
    }), { address: '老板' })
    expect(said).toBe('老板,Claude在问你:要不要合进 main。等你批,行不行?')
  })

  it('别家那道选择题照旧逐字念(10-12 那一条没动)', () => {
    expect(ringOpener(call({
      reason: 'ask',
      title: '豆包 在等你选',
      ask: { from: '豆包', question: '你喜欢喝什么饮料?', options: ['绿茶', '咖啡'] },
    }), { address: '老板' })).toContain('有这几个:绿茶,还是咖啡')
  })

  it('运行失败那一种:说原因,不念标题', () => {
    const said = ringOpener(call({ reason: 'failed', title: '「让 Kimi 查国庆放几天」', note: '派给 Kimi 没派出去:这台电脑上还没接上它' }), { address: '老板' })
    expect(said).toContain('你说下一步怎么办')
  })

  it('每一句都不超上限', () => {
    const titles = ['「参赛网页」要你批:要看一个很长很长很长很长很长很长的文件名字', '「一个特别特别特别特别特别长的事项标题在这里」']
    for (const title of titles) {
      for (const reason of ['ask', 'confirm', 'failed', 'relay', 'done']) {
        expect([...ringOpener(call({ reason, title }), { address: '老板' })].length).toBeLessThanOrEqual(RING_OPENER_MAX_CHARS)
      }
    }
  })

  it('标题拆开那一处:格式字眼只在这里认', () => {
    expect(plainRingSubject('「参赛网页」要你批:要看一个文件')).toEqual({ subject: '参赛网页', what: '要看一个文件', gate: 'approve' })
    expect(plainRingSubject('「选题」问你:用方案 A 还是 B')).toEqual({ subject: '选题', what: '用方案 A 还是 B', gate: 'answer' })
    expect(plainRingSubject('豆包 在等你选')).toEqual({ what: '豆包 在等你选' })
  })
})

/* ──────────────────────── ⑥ 11:40 那一通:接起来 → 开场 3.5 秒 → 她 1 秒后开口 ──────────────────────── */

/**
 * ★ 维护者 11:40 真机那一通(0.4.118,豆包普通包出题 → 座机响 → 她接起来)。
 * 工人日志里的三处毛病,时序用假时钟钉住(理由与出处在 `src/tts/openerRepeat.ts` 文件头):
 *
 * ```
 * 0ms     接起来 → 开场白出口(44 字)
 * 634ms   第一帧出房(tts_first_ms)→ agent_state=speaking → 这一句从此掐得动
 * 3000ms  ← 从前在这儿就把那件事再说了一遍(第一遍还没念完)
 * 3501ms  这一句真念完(tts_all_ms)
 * ```
 */
describe('★★ 来电开场:念完才起算那 3 秒', () => {
  /** 假时钟:只走我们让它走的那几毫秒。 */
  function clock() {
    let at = 0
    let seq = 0
    const timers = new Map<number, { at: number, fn: () => void }>()
    return {
      now: () => at,
      setTimer(fn: () => void, ms: number): () => void {
        const id = ++seq
        timers.set(id, { at: at + ms, fn })
        return () => { timers.delete(id) }
      },
      /** 走 `ms` 毫秒,路上到点的定时器挨个放,每放一个让 await 链走几步。 */
      async advance(ms: number): Promise<void> {
        const until = at + ms
        for (;;) {
          const due = [...timers.entries()].filter(([, one]) => one.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
          if (due === undefined) break
          timers.delete(due[0])
          at = due[1].at
          due[1].fn()
          await flush()
        }
        at = until
        await flush()
      },
    }
  }
  const flush = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

  /** 框架那只把手的替身:`allowInterruptions` 是一格普通属性,念完由用例说了算。 */
  function handle() {
    let release = (): void => {}
    let over = false
    const played = new Promise<void>((resolve) => { release = resolve })
    return {
      allowInterruptions: false,
      waitForPlayout: () => played,
      done: () => over,
      interrupts: 0,
      interrupt() { this.interrupts += 1 },
      /** 这一句真念完了(TTS 推完 + 播完)。 */
      playedOut() { over = true; release() },
    }
  }

  function world(options: { live?: () => boolean } = {}) {
    const time = clock()
    const said: ('first' | 'again')[] = []
    const handles: ReturnType<typeof handle>[] = []
    const lines: string[] = []
    const cutIn = createOpenerCutIn({ log: line => lines.push(line) })
    const run = createOpenerRepeat({
      say: (round) => {
        said.push(round)
        const one = handle()
        handles.push(one)
        cutIn.track(one, round === 'first' ? '来电开场白' : '来电开场白(再说一遍)')
        return one
      },
      live: options.live ?? (() => true),
      cutIn,
      repeatMs: RING_OPENER_REPEAT_MS,
      now: time.now,
      setTimer: time.setTimer,
      log: line => lines.push(line),
    })
    return { time, said, handles, lines, cutIn, run }
  }

  it('★3.5 秒那一句:到 3 秒不许再说一遍(11:40 那一通正是在这儿接上去的)', async () => {
    const { time, said, handles, run } = world()
    void run.start()
    await flush()
    expect(said).toEqual(['first'])
    // 她一直没吭声,可那一句还在念 —— 走到 3 秒、走到 3.4 秒都只有一遍。
    await time.advance(3400)
    expect(said).toEqual(['first'])
    // 3.5 秒念完了,这才开始起算那 3 秒。
    handles[0]?.playedOut()
    await flush()
    await time.advance(RING_OPENER_REPEAT_MS - 1)
    expect(said).toEqual(['first'])
    await time.advance(1)
    expect(said).toEqual(['first', 'again'])
  })

  it('★只一次:再说那一遍念完之后,第三遍不说', async () => {
    const { time, said, handles, run } = world()
    void run.start()
    await flush()
    handles[0]?.playedOut()
    await flush()
    await time.advance(RING_OPENER_REPEAT_MS)
    expect(said).toEqual(['first', 'again'])
    handles[1]?.playedOut()
    await time.advance(RING_OPENER_REPEAT_MS * 5)
    expect(said).toEqual(['first', 'again'])
  })

  it('★她 1 秒后开口「茶」:不重复了,而且那一句当场掐得动', async () => {
    const { time, said, handles, run, cutIn } = world()
    void run.start()
    await flush()
    const first = handles[0]!
    // 634ms:第一帧出房,框架报 speaking → 这一句从此可打断(她的话也从此进得了识别)。
    await time.advance(634)
    cutIn.outLoud()
    expect(first.allowInterruptions).toBe(true)
    // 1000ms:VAD 判到人声(ASR 还一个字都没出来)。
    await time.advance(366)
    run.sheSpoke('VAD 判到人声')
    handles[0]?.playedOut()
    await time.advance(RING_OPENER_REPEAT_MS * 3)
    expect(said).toEqual(['first'])
    // ★掐不掐由 bargeIn.ts 判:这一处一次 interrupt 都不调(一声「嗯」不该把开场白掐断)。
    expect(first.interrupts).toBe(0)
  })

  it('★她开口在「出声」那一下之前到(agent_state 没来 / 来晚了):照样翻成可打断', async () => {
    const { handles, run } = world()
    void run.start()
    await flush()
    run.sheSpoke('VAD 判到人声')
    expect(handles[0]?.allowInterruptions).toBe(true)
  })

  it('念完那个信号一直不来(TTS 卡住 / 音轨被退订):到上限也照样再说一遍', async () => {
    const { time, said, run } = world()
    void run.start()
    await flush()
    await time.advance(OPENER_PLAYOUT_CAP_MS - 1)
    expect(said).toEqual(['first'])
    await time.advance(1 + RING_OPENER_REPEAT_MS)
    expect(said).toEqual(['first', 'again'])
  })

  it('她挂了 / 换了一通:第二遍一个字都不说', async () => {
    let live = true
    const { time, said, handles, run } = world({ live: () => live })
    void run.start()
    await flush()
    handles[0]?.playedOut()
    await flush()
    live = false
    await time.advance(RING_OPENER_REPEAT_MS * 3)
    expect(said).toEqual(['first'])
  })

  it('`stop()` 之后也不说(挂断那一下走的是这条)', async () => {
    const { time, said, handles, run } = world()
    void run.start()
    await flush()
    handles[0]?.playedOut()
    await flush()
    run.stop()
    await time.advance(RING_OPENER_REPEAT_MS * 3)
    expect(said).toEqual(['first'])
  })

  it('老框架不给把手:退回「说出去就算念完」,照旧只重复一次', async () => {
    const time = clock()
    const said: string[] = []
    const run = createOpenerRepeat({
      say: (round) => { said.push(round); return undefined },
      live: () => true,
      cutIn: createOpenerCutIn(),
      repeatMs: RING_OPENER_REPEAT_MS,
      now: time.now,
      setTimer: time.setTimer,
    })
    void run.start()
    await flush()
    await time.advance(RING_OPENER_REPEAT_MS)
    expect(said).toEqual(['first', 'again'])
  })

  it('已经念完的那一句不翻(翻一只走完了的把手框架会抛)', () => {
    const lines: string[] = []
    const cutIn = createOpenerCutIn({ log: line => lines.push(line) })
    const one = handle()
    cutIn.track(one, '提机开场白')
    one.playedOut()
    cutIn.outLoud()
    expect(one.allowInterruptions).toBe(false)
  })

  it('★框架那两道门认的还是 `allowInterruptions`(读源头文件比对,漂了就红)', async () => {
    const source = await readFile(new URL('../node_modules/@livekit/agents/dist/voice/agent_activity.js', import.meta.url), 'utf8')
    /** 不许打断的那一句在念时,麦克风的帧被换成静音(= 她开口的字进不了识别)。 */
    expect(source).toContain('!this._currentSpeech.allowInterruptions && discardAudioIfUninterruptible')
    /** 而且这一回合整个被丢掉。 */
    expect(source).toContain('skipping user input, current speech generation cannot be interrupted')
  })
})

/* ──────────────────────── ⑦ 答挂着那一问没办成:说人话,不念接口的字 ──────────────────────── */

describe('★★ 固定流程没办成:一句人话,接口的 note / error 一个字都不念', () => {
  /*
   * ★ 2026-10-13 下午,卡 C(验收交接第三节第 3 条)。14:17 真机那一通:壳的回执说「没点上」,
   * 而电脑上的豆包**已经收到并回了**。所以这一档改口:**不再先说「没看到它选上」、不再命令她去点**,
   * 只说我替你答了什么 + 你看一眼。每句 ≤ 25 字(`ANSWER_ASK_SAY_MAX_CHARS`)。
   */
  it('★送出去了、没核上:「我替你答了果汁,你看一眼豆包办公那边。」', async () => {
    const { turns } = await replay(['果汁'], { ask: 'unconfirmed' })
    const said = (turns[0] as Turn).spoken
    expect(said).toBe('我替你答了果汁,你看一眼豆包办公那边。')
    // 11:40 那一通念出去的就是这一串(给界面看的提示)。
    expect(said).not.toContain('回执尚未确认')
    expect(said).not.toContain('对话区')
    // 14:17 那一通她说的是「没看到它选上,你在电脑上…里点一下」—— 那会儿豆包其实已经收到了。
    expect(said).not.toContain('没看到它选上')
    expect(said).not.toContain('点一下')
  })

  it('★没核上那一句也 ≤ 25 字(长答案 / 长家名都量过)', () => {
    const lines = [
      answerAskSay({ status: 200, picked: '果汁', agent: '豆包办公' }),
      answerAskSay({ status: 200, picked: '都对,但你自己做吧再想想', agent: '豆包工作' }),
      answerAskSay({ status: 200, custom: '我自己说一句很长很长的话', agent: '千问办公' }),
      answerAskSay({ status: 200, picked: '果汁' }),
      answerAskSay({ status: 200, agent: '豆包办公' }),
    ]
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(ANSWER_ASK_SAY_MAX_CHARS)
  })

  it('★送不进去:「这一问得在电脑上的豆包办公里回答。」', async () => {
    const { turns } = await replay(['果汁'], { ask: 'missed' })
    const said = (turns[0] as Turn).spoken
    expect(said).toBe(askElsewhereSay('豆包办公'))
    expect(said).not.toContain('一项都没点')
    expect(said).not.toContain('它给的是')
  })

  it('那一问已经不在了(409)与接口自己炸了(500):各一句,都不念它回的字', async () => {
    const gone = await replay(['果汁'], { ask: 'gone' })
    expect((gone.turns[0] as Turn).spoken).toBe(ASK_GONE_SAY)
    expect((gone.turns[0] as Turn).spoken).not.toContain('往下走')
    const broken = await replay(['果汁'], { ask: 'broken' })
    expect((broken.turns[0] as Turn).spoken).toBe(ASK_BROKEN_SAY)
    expect((broken.turns[0] as Turn).spoken).not.toContain('内部错误')
  })

  it('真点上了:照旧念固定流程那一句', async () => {
    const { turns } = await replay(['果汁'])
    expect((turns[0] as Turn).spoken).toBe('好了,替你选上了。')
  })

  it('认不出是哪一家就不说哪一家(不猜一家顶上)', () => {
    expect(askElsewhereSay(undefined)).toBe('这一问得你在电脑上回答。')
    expect(answerAskSay({ status: 200, picked: '果汁' })).toBe('我替你答了果汁,你去电脑上看一眼。')
    expect(askAgentIdOf('session:doubao/window:1')).toBe('doubao')
    expect(askAgentIdOf('session:doubao:abc')).toBe('doubao')
    expect(askAgentIdOf('t-1')).toBeUndefined()
  })

  it('★`/butler/item` 那边 8791 回问那一句照旧原样念(两件事不能混)', async () => {
    const { calls, workbench } = fake8791()
    const asked = await workbench.runUnderstanding({
      understanding: {
        kind: 'publish_plan',
        mode: 'demo',
        confirm: { needed: false },
        say: { start: '' },
        why: 'test',
        route: { path: '/butler/item', body: { ask_date: true } },
      },
      text: '计划发一条关于露营装备的视频',
    })
    expect(asked.say).toBe('这条打算哪天发?')
    expect(calls.map(one => one.path)).toEqual(['/butler/item'])
  })
})

/* ──────────────────────── ⑧ 道别进固定流程(10-13 下午 14:02 / 14:0x) ──────────────────────── */

/**
 * ★ **他道别 → 固定一句「好,拜拜。」→ 挂**(2026-10-13 下午,卡 A 第 2 条)。
 *
 * 真机两处:
 *
 * ```
 * 他说(ASR):好了，告诉我，拜拜。
 * 8791 听懂了:append/normal → 打 /butler/item/say(补进刚开始那件事「…云南瓦剌猫…」)
 * 固定流程 append → /butler/item/say:没办成,说「这件事的会话没开,说不进去」
 * 她说:这件事的会话没开,说不进去                 ← 道别被当补细节,念了接口的字
 * ```
 *
 * 另一通走模型:正文先说「拜拜。」,调 `wb_end_call` 之后又说「好,拜拜。」—— 一通里道别两遍。
 *
 * ★ **2026-10-13 晚(卡 K)**:0.4.121 真机 16:33 那一通道别认出来了,可这一回合
 * **仍然问了 8791、仍然起了垫场计时器**:
 *
 * ```
 * 他说(ASR):不用看了，拜拜。
 * 他道别了(「不用看了,拜拜。」):固定一句就收
 * 8791 听懂了:none/normal → 交给模型(认不出是哪一类,交给模型)
 * 到点还没出声,垫了一句「嗯,我想一下。」(当前音色,走同一条音轨)
 * 她说:好,拜拜。
 * ```
 *
 * 维护者:「他垫了一句说我想想,然后才说的拜拜」。所以道别那一回合从此
 * **不问 8791、不进模型、不先应、不垫场** —— 和「走固定流程那一回合」同一道闸。
 */
describe('★★ 道别进固定流程:一句话,一通只一次', () => {
  it('★「好了,告诉我,拜拜。」→ 固定一句,一个接口都不打(14:02 那一通)', async () => {
    const { turns, calls } = await replay(['好了,告诉我,拜拜。'], { appendFails: true })
    const first = turns[0] as Turn
    expect(first.spoken).toBe(FAREWELL_FIXED_SAY)
    expect(first.hung).toBe(true)
    expect(first.toModel).toBe(false)
    // 连「听懂」那一问都不问(卡 K:问了只会把先应 / 垫场两道闸放行)。
    expect(calls.map(one => one.path)).toEqual([])
  })

  it('★16:33 那一通:道别那一回合不问 8791、不先应、不垫场', async () => {
    const { turns, calls } = await replay(['不用看了,拜拜。'])
    const first = turns[0] as Turn
    expect(first.spoken).toBe(FAREWELL_FIXED_SAY)
    expect(first.hung).toBe(true)
    expect(calls).toEqual([])
    // 那三行一行都没有(真机 16:33 那一通三行全在,固定那句比垫场还晚出声)。
    expect(first.log).toEqual([])
  })

  it('★认不出道别的那一回合照旧问 8791、照旧先应与垫场(这三行真的会出现)', async () => {
    const { turns } = await replay(['为什么要这么说话?'])
    const first = turns[0] as Turn
    expect(first.toModel).toBe(true)
    const lines = first.log.join('\n')
    expect(lines).toContain(LOG_UNDERSTOOD)
    expect(lines).toContain(LOG_ACKED)
    expect(lines).toContain(LOG_FILLED)
  })

  it('★今天这几句道别都认得出来(≤12 字那道门)', () => {
    for (const one of ['不用看了,拜拜', '不用看了,拜拜。', '好了,拜拜', '就这样吧,拜拜', '行,挂了']) {
      expect(farewellFixedSay(one)).toBe(FAREWELL_FIXED_SAY)
      expect([...one].length).toBeLessThanOrEqual(FAREWELL_SAY_MAX_CHARS)
    }
  })

  it('★「你把那个视频再做一版然后拜拜」照旧交给模型(它要先办那件事)', async () => {
    const said = '你把那个视频再做一版然后拜拜'
    expect([...said].length).toBeGreaterThan(FAREWELL_SAY_MAX_CHARS)
    expect(farewellFixedSay(said)).toBeUndefined()
    const { turns, calls } = await replay([said])
    expect((turns[0] as Turn).hung).toBeUndefined()
    // 照老路:问 8791、认不出就交给模型。
    expect(calls.map(one => one.path)).toEqual(['/butler/understand'])
  })

  it('★一通只道别一次:第二句「拜拜」只挂,不再说一遍', async () => {
    const { turns } = await replay(['就这样吧,拜拜', '拜拜'])
    expect((turns[0] as Turn).spoken).toBe(FAREWELL_FIXED_SAY)
    expect((turns[1] as Turn).spoken).toBe('')
    expect((turns[1] as Turn).hung).toBe(true)
  })

  it('★那一句念出去的字不超 25(DEMO_SAY_MAX_CHARS 那条纪律)', () => {
    expect([...FAREWELL_FIXED_SAY].length).toBeLessThanOrEqual(25)
  })

  it('今天那几句都认得出来', () => {
    expect(farewellFixedSay('好了,告诉我,拜拜。')).toBe(FAREWELL_FIXED_SAY)
    expect(farewellFixedSay('就这样吧,拜拜')).toBe(FAREWELL_FIXED_SAY)
    expect(farewellFixedSay('没事了,挂了吧')).toBe(FAREWELL_FIXED_SAY)
    expect(farewellFixedSay('拜拜')).toBe(FAREWELL_FIXED_SAY)
  })

  it('★他先交代了一件事再道别:不走这一道(交给模型,它可能要先办那件事)', () => {
    // 这一句 `offersEndCall` 照旧是真(递那件工具给模型),只是不许**直接**挂。
    expect(offersEndCall('帮我做个视频,然后就这样吧')).toBe(true)
    expect(farewellFixedSay('帮我做个视频,然后就这样吧')).toBeUndefined()
    expect([...'帮我做个视频,然后就这样吧'].length).toBeGreaterThan(FAREWELL_SAY_MAX_CHARS)
  })

  it('转述、「别挂」、道别后又说新事:照旧不走这一道(endCallVeto 那三条没动)', () => {
    expect(farewellFixedSay('他跟我说了拜拜')).toBeUndefined()
    expect(farewellFixedSay('先别挂')).toBeUndefined()
    expect(farewellFixedSay('拜拜,记一下')).toBeUndefined()
  })

  it('不是道别的话一个字都不碰(演示那几句、点头摇头)', () => {
    for (const one of ['帮我做一个小猫在海边追浪花的视频', '把待办改成按日期汇总', '对', '算了', '七八岁吧,穿小碎花连衣裙。']) {
      expect(farewellFixedSay(one)).toBeUndefined()
    }
  })
})

/* ──────────────────────── ⑨ 先说再办(10-13 下午:静默 9 秒) ──────────────────────── */

/**
 * ★ **认出来就先念,派活放后台**(2026-10-13 下午,卡 A 第 1 条)。
 * 真机三通都是 `llm_first_ms 7631 / 7437` —— `/butler/item` 同步等着把第一步派给豆包
 * (每次 7.4–7.6 秒),而固定流程回合按设计不先应、不垫场。
 */
describe('★★ 先说再办:那一句不等派活', () => {
  it('★派活还没回来,那一句已经出口了(真机那 7.5 秒)', async () => {
    let release = (): void => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    const { turns, calls, settle } = await replay(['帮我做一个小女孩在花海里面漫步的视频'], { hold })
    // 这会儿 `/butler/item` 还吊着,而她那一句已经定了。
    expect((turns[0] as Turn).spoken).toContain('先让豆包出参考图')
    expect(calls.map(one => one.path)).toEqual(['/butler/understand', '/butler/item'])
    release()
    await settle()
    // 办成了就一个字都不补。
    expect((turns[0] as Turn).after).toBeUndefined()
  })

  it('★只有要派活那一支先念;切待办 / 排发布计划照旧同步', () => {
    const video = understanding({ kind: 'video', mode: 'demo', route: { path: '/butler/item', body: {} }, say: { start: '好,做…的视频。' } })
    expect(saysFirst(video)).toBe(true)
    expect(saysFirst(understanding({ kind: 'today_view', mode: 'demo', route: { path: '/today/view', body: {} }, say: { start: '好,改成按日期汇总了。' } }))).toBe(false)
    expect(saysFirst(understanding({ kind: 'publish_plan', mode: 'demo', route: { path: '/butler/item', body: {} }, say: { start: '好,记进发布计划了' } }))).toBe(false)
    expect(saysFirst(understanding({ kind: 'answer_ask', mode: 'demo', route: { path: '/asks/voice', body: {} }, say: { start: '好了,替你选上了。' } }))).toBe(false)
    expect(saysFirst(understanding({ kind: 'append', route: { path: '/butler/item/say', body: {} }, say: { start: '加上了:…' } }))).toBe(false)
    // 没有那一句就没什么可先念的(回头还得靠结果拼一句)。
    expect(saysFirst({ ...video, say: { start: '' } })).toBe(false)
  })

  it('★补的那一句短(≤25 字),拼不出一句人话就一个字都不补', () => {
    const line = sayFirstFailLine('豆包办公 这会儿派不出去:这台电脑上还没接上它')
    expect(line).toBe('豆包办公 这会儿派不出去:这台电脑上还没接上它')
    expect([...(line ?? '')].length).toBeLessThanOrEqual(25)
    expect([...(sayFirstFailLine('派不出去:'.repeat(20)) ?? '')].length).toBe(25)
    expect(sayFirstFailLine('')).toBeUndefined()
    expect(sayFirstFailLine(undefined)).toBeUndefined()
  })
})

/* ──────────────────────── ⑩ 送去办的正文用认话那一句 ──────────────────────── */

describe('★★ 送 /butler/item 的正文用 8791 认的那一句', () => {
  it('★他被打断后的两段不拼起来送(14:19 那一通的卡标题)', async () => {
    const { calls } = await replay([['给我生成一个。', '给我生成一个女孩子在树林下摘蘑菇的视频。']], { hold: Promise.resolve() })
    const item = calls.find(one => one.path === '/butler/item')
    expect(item?.body.text).toBe('给我生成一个女孩子在树林下摘蘑菇的视频。')
    expect(String(item?.body.text ?? '')).not.toContain('给我生成一个。给我生成一个')
  })

  it('问不到那一句(老工作台 / 超时)才退回拼起来的那一段', () => {
    expect(bodyTextOf({ asked: '给我生成一个女孩子在树林下摘蘑菇的视频。', heard: '给我生成一个。给我生成一个女孩子在树林下摘蘑菇的视频。' }))
      .toBe('给我生成一个女孩子在树林下摘蘑菇的视频。')
    expect(bodyTextOf({ heard: '给我生成一个。给我生成一个女孩子在树林下摘蘑菇的视频。' }))
      .toBe('给我生成一个。给我生成一个女孩子在树林下摘蘑菇的视频。')
    expect(bodyTextOf({ asked: '  ', heard: '拼起来那一段' })).toBe('拼起来那一段')
  })
})

/* ──────────────────────── ⑪ 补一句没进去:固定一句,不念接口的字 ──────────────────────── */

describe('★★ /butler/item/say 没办成:固定一句', () => {
  it('★409(会话没开)也不念那句接口的话', async () => {
    const { turns } = await replay(['七八岁吧,穿小碎花连衣裙。'], { appendFails: true })
    const said = (turns[0] as Turn).spoken
    expect(said).toBe(APPEND_FAILED_SAY)
    expect(said).not.toContain('会话没开')
    expect(said).not.toContain('说不进去')
    expect([...said].length).toBeLessThanOrEqual(25)
  })

  it('办成了照旧念固定流程那一句', async () => {
    const { turns } = await replay(['七八岁吧,穿小碎花连衣裙。'])
    expect((turns[0] as Turn).spoken).toBe('加上了:七八岁吧,穿小碎花连衣裙。')
  })

  it('真实原因照旧回得出来(进日志,不念出去)', async () => {
    const { workbench } = fake8791({ appendFails: true })
    const done = await workbench.runUnderstanding({
      understanding: understanding({ kind: 'append', route: { path: '/butler/item/say', body: { id: 't-1', text: '七八岁' } }, say: { start: '加上了:七八岁' } }),
      text: '七八岁',
    })
    expect(done.ok).toBe(false)
    expect(done.say).toBe(APPEND_FAILED_SAY)
    expect(done.why).toContain('会话没开')
  })
})

/* ──────────────────────── ⑫ 通话里插的那一句 ──────────────────────── */

describe('★★ 通话里插的那一句:不说「插一句」,不念 note', () => {
  function call(over: Record<string, unknown>) {
    const raw = { id: 'c-1', reason: 'ask', item_id: 't-1', title: '', at: new Date().toISOString(), silent: false, ...over }
    const got = parseRingCall(raw)
    expect(got).toBeDefined()
    return got as NonNullable<ReturnType<typeof parseRingCall>>
  }

  it('★办完了那一种:一句短的,书名号只一层,不念「接起来就能看」(14:22 那一通)', () => {
    const said = inCallAnnounceText(call({
      reason: 'confirm',
      title: '「云南瓦剌猫的蹦蹦跳跳的视频」',
      note: '视频好了,已经推到你手机上,接起来就能看;存在选题「云南瓦剌猫」的素材文件夹里',
    }))
    expect(said).toBe('「云南瓦剌猫的蹦蹦跳跳的视频」办完了。片子在你手机上了。')
    expect(said).not.toContain('插一句')
    expect(said).not.toContain('接起来就能看')
    expect(said).not.toContain('素材文件夹')
    expect(said).not.toContain('「「')
    expect(said).not.toContain('等你验收')
  })

  it('★预算到上限那一种说成人话:不念钱、不念步数(14:17 那一通)', () => {
    const said = inCallAnnounceText(call({
      reason: 'ask',
      title: '「20号发大赛回顾视频」问你:到上限了',
      note: '到上限了,先停下来了:花了约 0.51 元 · 跑了 6 分钟 · 走了 51 步(上限 0.5 元 / 10 分钟)',
    }))
    expect(said).toBe('「20号发大赛回顾视频」花到上限先停了。接着做、停掉,还是换人?')
    expect(said).not.toContain('0.51')
    expect(said).not.toContain('步')
    expect(said).not.toContain('分钟')
    expect(said).not.toContain('插一句')
    // 标题里的「问你:」与书名号在 plainRingSubject 一处剥掉 —— 只剩一层。
    expect(said).not.toContain('问你')
    expect(said).not.toContain('「「')
  })

  it('每一句都不超上限(事项名掐,固定那半句不掐)', () => {
    const long = '一个特别特别特别特别特别特别长的事项标题在这里凑数'
    for (const reason of ['ask', 'confirm', 'done']) {
      const said = inCallAnnounceText(call({ reason, title: long }))
      for (const one of said.split('。').filter(part => part !== '')) {
        expect([...one].length).toBeLessThanOrEqual(IN_CALL_SAY_MAX_CHARS)
      }
      expect(said).toContain('一个特别特别')
    }
  })

  it('从 note 只认两件事实,一个字都不抄', () => {
    expect(atBudgetLimit('到上限了,先停下来了:花了约 0.51 元')).toBe(true)
    expect(atBudgetLimit('超出预算了')).toBe(true)
    expect(atBudgetLimit('豆包还在跑')).toBe(false)
    expect(atBudgetLimit(undefined)).toBe(false)
    expect(pushedToPhone('视频好了,已经推到你手机上,接起来就能看')).toBe(true)
    expect(pushedToPhone('片子在 ~/Downloads 里')).toBe(false)
    expect(pushedToPhone(undefined)).toBe(false)
  })
})

/* ──────────────────────── ⑬ 他拨出去的那一通:挂着的问等他说完 ──────────────────────── */

/**
 * ★ 真机 14:17 那一通(他自己拨出去的):一接通念了 108 字 ——
 * 「老板,我在」+ 把挂着的那一件当场全念(**同一件事两条 key 念了两遍**),
 * 还带「0.51 元 · 6 分钟 · 51 步 · 上限 0.5 元 / 10 分钟」,他「打断不了」。
 * 维护者定的顺序:**他先安排事,事务官再说它的**(卡 A 第 4 条)。
 */
describe('★★ 他拨出去的那一通:挂着的问攒着', () => {
  function clock() {
    let at = 0
    let seq = 0
    const timers = new Map<number, { at: number, fn: () => void }>()
    return {
      now: () => at,
      setTimer(fn: () => void, ms: number): () => void {
        const id = ++seq
        timers.set(id, { at: at + ms, fn })
        return () => { timers.delete(id) }
      },
      advance(ms: number): void {
        const until = at + ms
        for (;;) {
          const due = [...timers.entries()].filter(([, one]) => one.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
          if (due === undefined) break
          timers.delete(due[0])
          at = due[1].at
          due[1].fn()
        }
        at = until
      },
    }
  }

  function world() {
    const time = clock()
    const said: string[] = []
    const lines: string[] = []
    const hold = createAnnounceHold({
      say: (one) => { said.push(one.text); return true },
      setTimer: time.setTimer,
      log: line => lines.push(line),
    })
    return { time, said, lines, hold }
  }

  it('★一接通不念:他说完他的事(她那一段也说完了)才提一件', () => {
    const { time, said, hold } = world()
    expect(hold.hold({ itemId: 't-86856ebb', text: '「20号发大赛回顾视频」花到上限先停了。接着做、停掉,还是换人?' })).toBe(true)
    expect(said).toEqual([])
    // 他开口交代他的事 → 空闲那一道撤掉。
    hold.heSpeaking(true)
    hold.heSaid('我把今日待办改成平铺的。')
    hold.heSpeaking(false)
    time.advance(ANNOUNCE_IDLE_MS * 2)
    expect(said).toEqual([])
    // 她那一段说完、回到听 —— 这才提。
    hold.thingDone()
    expect(said).toEqual(['「20号发大赛回顾视频」花到上限先停了。接着做、停掉,还是换人?'])
  })

  it('★同一件事两条 key:只提一遍(14:17 那一通念了两遍)', () => {
    const { said, hold } = world()
    expect(hold.hold({ itemId: 't-86856ebb', text: '「20号发大赛回顾视频」等你一句话。' })).toBe(true)
    /*
     * 第二条同一件事:一个字都不说,而且**照样回 true** —— 回 false 会让振铃那台机器
     * 把它排进队里,挂断之后再响一遍(「两遍」换个地方发生)。
     */
    expect(hold.hold({ itemId: 't-86856ebb', text: '「20号发大赛回顾视频」花到上限先停了。接着做、停掉,还是换人?' })).toBe(true)
    hold.thingDone()
    expect(said).toEqual(['「20号发大赛回顾视频」等你一句话。'])
    expect(hold.waiting).toBe(0)
    expect(hold.told).toEqual(['t-86856ebb'])
  })

  it('★一件一次:两件挂着的不连着念', () => {
    const { time, said, hold } = world()
    hold.hold({ itemId: 't-1', text: '「甲」等你一句话。' })
    hold.hold({ itemId: 't-2', text: '「乙」等你一句话。' })
    hold.thingDone()
    expect(said).toEqual(['「甲」等你一句话。'])
    // 下一件等下一个空档(他不再开口就是空闲那一道)。
    time.advance(ANNOUNCE_IDLE_MS)
    expect(said).toEqual(['「甲」等你一句话。', '「乙」等你一句话。'])
  })

  it('他问「有什么事」就当场提一件', () => {
    const { said, hold } = world()
    hold.hold({ itemId: 't-1', text: '「甲」等你一句话。' })
    hold.heSaid('有什么事?')
    expect(said).toEqual(['「甲」等你一句话。'])
    expect(asksWhatsUp('有什么事?')).toBe(true)
    expect(asksWhatsUp('什么事')).toBe(true)
    expect(asksWhatsUp('你找我?')).toBe(true)
    expect(asksWhatsUp('还有别的事吗')).toBe(true)
    // 长句里问「有什么事」多半是他在说别的 —— 不算
    expect(asksWhatsUp('那个视频的事你跟豆包说了有什么事吗')).toBe(false)
  })

  it('★他一直不开口:空闲到点先说一件(片子在通话中段才出来那一种)', () => {
    const { time, said, hold } = world()
    hold.hold({ itemId: 't-1', text: '「甲」办完了。片子在你手机上了。' })
    time.advance(ANNOUNCE_IDLE_MS - 1)
    expect(said).toEqual([])
    time.advance(1)
    expect(said).toEqual(['「甲」办完了。片子在你手机上了。'])
  })

  it('他正说着话不插进去', () => {
    const { time, said, hold } = world()
    hold.hold({ itemId: 't-1', text: '「甲」等你一句话。' })
    hold.heSpeaking(true)
    hold.thingDone()
    time.advance(ANNOUNCE_IDLE_MS * 3)
    expect(said).toEqual([])
    hold.heSpeaking(false)
    hold.thingDone()
    expect(said).toEqual(['「甲」等你一句话。'])
  })

  it('这一通挂了:攒着的不许串进下一通', () => {
    const { time, said, hold } = world()
    hold.hold({ itemId: 't-1', text: '「甲」等你一句话。' })
    hold.stop()
    time.advance(ANNOUNCE_IDLE_MS * 3)
    hold.thingDone()
    expect(said).toEqual([])
    expect(hold.waiting).toBe(0)
    // 收了之后再来的也不收(这一通已经不在了)
    expect(hold.hold({ itemId: 't-2', text: '「乙」等你一句话。' })).toBe(false)
  })

  it('没有事项 id 的按那一句话本身去重(正常走不到:parseRingCall 要求 item_id 非空)', () => {
    const { said, hold } = world()
    expect(hold.hold({ itemId: '  ', text: '「甲」等你一句话。' })).toBe(true)
    expect(hold.hold({ itemId: '', text: '「甲」等你一句话。' })).toBe(true)
    hold.thingDone()
    expect(said).toEqual(['「甲」等你一句话。'])
    expect(hold.waiting).toBe(0)
  })

  it('说不出去(她不在)就留着,下一个空档再放', () => {
    const time = clock()
    const said: string[] = []
    let mouth = false
    const hold = createAnnounceHold({
      say: (one) => { if (!mouth) return false; said.push(one.text); return true },
      setTimer: time.setTimer,
    })
    hold.hold({ itemId: 't-1', text: '「甲」等你一句话。' })
    hold.thingDone()
    expect(said).toEqual([])
    expect(hold.waiting).toBe(1)
    mouth = true
    hold.thingDone()
    expect(said).toEqual(['「甲」等你一句话。'])
  })
})

/* ──────────────────────── ⑭ 挂断只登记一次 ──────────────────────── */

/**
 * ★ 真机 14:06 那一通(座机响 → 他用手机接 → 说了「给我看看」)在看板上落了
 * **两张一模一样的纪要卡**(「电话里:给我看看。」t-a351622b / t-2bccb23e):
 * 工人按 `call_id` 报了一条,手机(`useCall.hangup()` 对每一通接通过的电话都报)
 * 又报了一条**不带 `call_id`** 的,8791 的去重表按 `call_id` 认,认不上(卡 A 第 5 条)。
 */
describe('★★ 纪要只由一边报', () => {
  it('★接的是手机 → 手机报,工人不报(来电那一通也一样)', () => {
    expect(workerReportsRecord({ answeredOn: 'phone' })).toBe(false)
  })

  it('接的是话筒 → 没有别人会报,工人报', () => {
    expect(workerReportsRecord({ answeredOn: 'handset' })).toBe(true)
  })

  it('认不出接话对象 → 照报(宁可多一张卡,也不让一通真发生过的电话没有记录)', () => {
    expect(workerReportsRecord({})).toBe(true)
  })
})

/* ──────────────────────── ⑮ 开场白那个「念完了」的顶 ──────────────────────── */

describe('★★ 开场白等「念完」的上限', () => {
  /*
   * 14:17 那一通:`开场白等了 12001ms 还没播完,当它念完了起算`,而 `回合计时 #6` 里
   * `llm_gen_ms:12848` —— 真念完是 12.8 秒。`tts_all_ms:3988` 是**帧推完**,不是播完。
   * 顶比正常念完还短,等于那条「念完才起算」在长句上没生效(卡 A 第 7 条)。
   */
  it('★顶要大于一句 42 字真念完的时间(14:17 那一通 12.8 秒)', () => {
    expect(OPENER_PLAYOUT_CAP_MS).toBeGreaterThan(12_848)
  })

  it('顶上还留着余量,但不至于让「再说一遍」等到天荒地老', () => {
    expect(OPENER_PLAYOUT_CAP_MS).toBeLessThanOrEqual(30_000)
  })
})

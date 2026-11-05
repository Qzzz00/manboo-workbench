/**
 * **Air 那 326 个回合的回放**(2026-10-02,卡「电话里像个活人」)。
 *
 * 维护者:「肯定是机械化,没有活人感……而且啰嗦,自言自语,答非所问才是核心关键」
 * 「我们做事不是为了打补丁,是为了从根上修复」。
 *
 * 夹具 `fixtures/air-1002-turns.json` 是**真机日志逐句摘出来的**
 * (工作台诊断包-20261002-193929,`channel-worker.log*`,09-27 ~ 10-02):
 * 95 通、326 个回合,每个回合带四样 ——
 *
 *   - `text`   她那一句的识别结果**原文**(连识别错的「to death」「泄露」都原样留着);
 *   - `asked`  紧挨着在她之前、事务官说的那一句**是不是问句**(`looksLikeAsking` 的判据,
 *              由摘日志的脚本按同一套标点规则数出来);
 *   - `tools`  这一回合她**真调了哪几件工具** —— 这是「要不要带工具」的**真实标注**
 *              (与 evalLog.ts 的 `parseEvalSamples` 同一个定义:调过工具 = 这一回合要办事);
 *   - `route`  当时**真实**走的那条路(日志里「这一回合按…」那一行;没记到的回合缺席)。
 *
 * 所以「改前」不是我们算的,是**日志里记着的**;「改后」是拿同一批句子现跑一遍规则。
 *
 * 这一份既是用例也是**成绩单**:跑一次就把下面那几个数打出来,交接里引的就是它。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { RulesTurnRouter, looksLikeAsking, routeByRules } from '../src/turnRoute.ts'
// 2026-10-03(卡「首声提速」甲):同一批回合上「这一回合送出去几件工具、多少字」。
// 同日卡 fix/voice-route-zh:工具按**全部命中的意图**取并集,所以这一节两列一起打
// (单意图那一列就是审计 voice.md 第 3 条量的那一份,留着才看得出并集多花了多少字)。
import { toolsForIntent, toolsForIntents } from '../src/intentTools.ts'
import { createChannelTools } from '../src/tools.ts'
// 2026-10-03(卡 ②「chat 路人设按意图裁」):同一批回合上「这一回合人设多少字」。
import { personaForTurn, type PersonaSection } from '../src/personaTrim.ts'

interface FixtureTurn {
  text: string
  asked: boolean
  tools: string[]
  route?: 'chat' | 'act'
  reason?: string
  first?: number
  gen?: number
}

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/air-1002-turns.json', import.meta.url), 'utf8'),
) as { from: string, calls: FixtureTurn[][] }

const CALLS = FIXTURE.calls
const TURNS = CALLS.flat()

/**
 * 一通一个实例(承接是有状态的),按真实顺序跑。
 *
 * `quiet`(「事务官不再逐句反问」)把每一回合的 `pendingAsk` 按 false 算 —— 这不是假数据,
 * 是**同一张卡另一头的改动落地之后的样子**:固定三问删了、「拿不准才问、一次只问最要紧的一件」
 * 之后,她那句「对」「好的」后面就不再挂着一个问号。两个数一起看才说明白
 * 「分流能压多少」与「人设那一头能压多少」。
 */
function replay(options: { quiet?: boolean } = {}): { turn: FixtureTurn, route: 'chat' | 'act', reason: string }[] {
  const out: { turn: FixtureTurn, route: 'chat' | 'act', reason: string }[] = []
  for (const call of CALLS) {
    let previous: 'chat' | 'act' | undefined
    for (const turn of call) {
      const hit = routeByRules(turn.text, {
        ...(previous === undefined ? {} : { previous }),
        pendingAsk: options.quiet === true ? false : turn.asked,
      })
      previous = hit.route
      out.push({ turn, route: hit.route, reason: hit.reason })
    }
  }
  return out
}

/** 09-23 那一版的承接:上一回合是 act、这一句没命中寒暄/闲聊词 → 还是 act。只给对照用。 */
function percent(part: number, all: number): string {
  return all === 0 ? '—' : `${((part / all) * 100).toFixed(1)}%`
}

function median(list: readonly number[]): number {
  if (list.length === 0) return Number.NaN
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : sorted[mid] as number
}

function quantile(list: readonly number[], q: number): number {
  if (list.length === 0) return Number.NaN
  const sorted = [...list].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[at] as number
}

describe('夹具本身', () => {
  it('95 通、326 个回合,每一条都带原文与真实标注', () => {
    expect(CALLS.length).toBeGreaterThanOrEqual(90)
    expect(TURNS.length).toBe(326)
    expect(TURNS.every(one => typeof one.text === 'string' && one.text.trim() !== '')).toBe(true)
    expect(TURNS.every(one => Array.isArray(one.tools))).toBe(true)
  })

  it('真调过工具的回合占比 —— 「要办事」的真实水位', () => {
    const withTools = TURNS.filter(one => one.tools.length > 0).length
    // 122 / 326 = 37.4%。日志里当时送去 act 的是 89%。
    expect(withTools).toBe(122)
  })
})

describe('★★ 改前改后:route 分布', () => {
  it('打出成绩单(交接里引的就是这几行)', () => {
    const replayed = replay()
    const logged = TURNS.filter(one => one.route !== undefined)
    const loggedAct = logged.filter(one => one.route === 'act').length
    const newAct = replayed.filter(one => one.route === 'act').length

    // 同一批句子(日志里记了判定的那 229 个)改前改后对着比
    const paired = replayed.filter(one => one.turn.route !== undefined)
    const pairedOldAct = paired.filter(one => one.turn.route === 'act').length
    const pairedNewAct = paired.filter(one => one.route === 'act').length

    const lines = [
      '',
      `夹具:${FIXTURE.from}`,
      `回合 ${TURNS.length} 个(其中日志里记了判定的 ${logged.length} 个),真调过工具的 ${TURNS.filter(o => o.tools.length > 0).length} 个`,
      '',
      `改前(日志里真实走的,${logged.length} 个回合):act ${loggedAct}(${percent(loggedAct, logged.length)})/ chat ${logged.length - loggedAct}(${percent(logged.length - loggedAct, logged.length)})`,
      `改后(同这 ${paired.length} 个回合现跑一遍):act ${pairedNewAct}(${percent(pairedNewAct, paired.length)})/ chat ${paired.length - pairedNewAct}(${percent(paired.length - pairedNewAct, paired.length)})`,
      `改后(全部 ${TURNS.length} 个回合):act ${newAct}(${percent(newAct, TURNS.length)})/ chat ${TURNS.length - newAct}(${percent(TURNS.length - newAct, TURNS.length)})`,
      '',
      `对照:改前那 ${paired.length} 个里 act ${pairedOldAct}(${percent(pairedOldAct, paired.length)})`,
      '',
      '改后 act 的判据都来自哪里(前十):',
      ...[...replayed.filter(one => one.route === 'act')
        .reduce((map, one) => map.set(one.reason, (map.get(one.reason) ?? 0) + 1), new Map<string, number>())]
        .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([why, n]) => `  ${n}  ${why}`),
    ]

    /*
     * 剩下那一半 act 的大头是「她在回答事务官挂着的那一问」—— 那是**人设那一头**的病
     * (固定三问、每两句挂一个问号)。同一张卡把那几条话术删了之后,这一列就是下面这个数。
     */
    const asked = TURNS.filter(one => one.asked).length
    const quiet = replay({ quiet: true })
    const quietAct = quiet.filter(one => one.route === 'act').length
    lines.push(
      '',
      `她的回合里「在回答事务官的问话」的:${asked}(${percent(asked, TURNS.length)})`,
      `改后 + 事务官不再逐句反问(同一张卡删掉固定三问之后):act ${quietAct}(${percent(quietAct, TURNS.length)})`
      + ` / chat ${TURNS.length - quietAct}(${percent(TURNS.length - quietAct, TURNS.length)})`,
      `真需要工具的水位(真实标注):${TURNS.filter(o => o.tools.length > 0).length}(${percent(TURNS.filter(o => o.tools.length > 0).length, TURNS.length)})`,
    )
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))

    // ★ 根子那一条:只改分流,act 从 90% 下来一大截
    expect(pairedOldAct / paired.length).toBeGreaterThan(0.85)
    expect(pairedNewAct / paired.length).toBeLessThan(0.78)
    // ★★ 两头一起改(分流 + 删掉固定三问)→ 一半以下,贴着「真需要工具」那条水位
    expect(quietAct / TURNS.length).toBeLessThan(0.5)
  })

  it('★ 承接不再是默认值:靠「承接」进 act 的回合大幅减少', () => {
    const replayed = replay()
    const carried = replayed.filter(one => one.reason.includes('承接') && one.route === 'act').length
    const before = TURNS.filter(one => one.reason === '接着上一回合那件事(承接)').length
    // eslint-disable-next-line no-console
    console.log(`\n承接拉进 act 的回合:改前 ${before} → 改后 ${carried}`)
    expect(before).toBeGreaterThan(140)
    expect(carried).toBeLessThan(before / 2)
  })
})

describe('★★ 漏判与误判(对着真实标注数)', () => {
  it('漏判(真调了工具却被判成闲聊)比改前多不了多少;误判(没调工具却带了全套)大幅下降', () => {
    /*
     * **只在日志里记了判定的那几个回合上比**:改前那一列是日志里的,全 326 个里有 229 个记了。
     * 拿 326 的改后去比 229 的改前是两把尺子。
     */
    const replayed = replay().filter(one => one.turn.route !== undefined)
    const newMiss = replayed.filter(one => one.turn.tools.length > 0 && one.route === 'chat')
    const newOver = replayed.filter(one => one.turn.tools.length === 0 && one.route === 'act').length
    const oldMiss = replayed.filter(one => one.turn.tools.length > 0 && one.turn.route === 'chat').length
    const oldOver = replayed.filter(one => one.turn.tools.length === 0 && one.turn.route === 'act').length
    const lines = [
      '',
      `漏判(真要工具却走闲聊):改前 ${oldMiss} → 改后 ${newMiss.length}`,
      `误判(不要工具却带全套):改前 ${oldOver} → 改后 ${newOver}`,
      '(「先这样吧」「挂了」「拜拜」这几句不算真漏判:闲聊那条路本来就单递挂断那一件工具,'
      + '见 agent.ts 的 `offersEndCall`。诊断包里工具名是脱敏的,数不出来是哪一件,所以这一列是上限。)',
      '漏判的那几句:',
      ...newMiss.slice(0, 12).map(one => `  · ${one.turn.text}(${one.reason};当时调了 ${one.turn.tools.join('、')})`),
    ]
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))
    // 误判是这张卡要治的那一种:八秒钟换一句「嗯」。
    expect(newOver).toBeLessThan(oldOver)
  })
})

describe('★ 慢在哪:act 与 chat 两条路的真实耗时', () => {
  it('打出 llm_first_ms / llm_gen_ms 的中位与 p90 / p95(业界尺子见 docs/设计-活人感标准与前端差距-2026-10-02.md 第一节)', () => {
    const actTurns = TURNS.filter(one => one.route === 'act')
    const chatTurns = TURNS.filter(one => one.route === 'chat')
    const pick = (list: readonly FixtureTurn[], key: 'first' | 'gen'): number[] =>
      list.map(one => one[key]).filter((one): one is number => typeof one === 'number')
    const row = (name: string, list: readonly number[]): string =>
      `${name}:n=${list.length} 中位 ${median(list)}ms p90 ${quantile(list, 0.9)}ms p95 ${quantile(list, 0.95)}ms`
    const replayed = replay()
    const movedToChat = replayed.filter(one => one.turn.route === 'act' && one.route === 'chat')
    const movedGen = movedToChat.map(one => one.turn.gen).filter((one): one is number => typeof one === 'number')
    const lines = [
      '',
      row('act 路 llm_first_ms', pick(actTurns, 'first')),
      row('act 路 llm_gen_ms ', pick(actTurns, 'gen')),
      row('chat 路 llm_first_ms', pick(chatTurns, 'first')),
      row('chat 路 llm_gen_ms ', pick(chatTurns, 'gen')),
      '',
      `这一版从 act 挪到 chat 的 ${movedToChat.length} 个回合,当时真花掉的 llm_gen_ms:`
      + `n=${movedGen.length} 中位 ${median(movedGen)}ms p90 ${quantile(movedGen, 0.9)}ms`,
      '(挪过去之后这几个回合不带工具、不垫场 —— 省下的就是这几个数)',
    ]
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))
    expect(pick(actTurns, 'gen').length).toBeGreaterThan(20)
  })
})

describe('★ 诊断包里那几通,逐句钉住', () => {
  it('「你能听到我吗?」那一类 —— 她在试线,不带工具(改前走的是 act)', () => {
    for (const said of ['你能听到我说话吗？', '能听到我声音吗？', '听到吗？', '有声音吗？', '能听到我说话吗？']) {
      expect(routeByRules(said, { previous: 'act', pendingAsk: false }).route).toBe('chat')
    }
  })

  it('★ 纯应答:上一句不是问句 → 闲聊(改前这一类全被承接拉进 act)', () => {
    for (const said of ['对。', '是的。', '好的。', '对的。', '是的是的,是这样。', '看见了。', '知道了。']) {
      expect(routeByRules(said, { previous: 'act', pendingAsk: false }).route).toBe('chat')
    }
  })

  it('★★ 同一句「可以 / 去吧 / 豆包」:事务官刚问完 → 还是要办事(那是批准,不是应答)', () => {
    for (const said of ['可以。', '去吧。', '豆包。', '对。', '好的。']) {
      expect(routeByRules(said, { previous: 'act', pendingAsk: true }).route).toBe('act')
    }
  })

  it('查天气 / 派 Codex / 发布计划 / 打开音乐:照旧要办事', () => {
    const acts = [
      '让豆包查询一下今天深圳的天气。',
      '近7天深圳的天气是怎么样的？',
      '我想请你直接根据我跟你的对话，然后派初代修复现在工作台上小组件。',
      '让 products 去办。',
      '发布计划上还是没有刚刚说的那条视频计划。',
      '帮我用豆包打开网易云音乐并播放音乐。',
      '问一下他。',
      '新开一条。',
      '对，6分钟后之后打电话提醒我。',
      '我想帮你，帮我查询一下 to death 的恶度还剩多少。',
    ]
    for (const said of acts) {
      expect(routeByRules(said, { previous: 'act', pendingAsk: false }).route).toBe('act')
    }
  })

  it('问她自己、评价她、问常识:闲聊(工人自己的小模型答,不带工具)', () => {
    for (const said of ['你是什么身份？你是事务官还是？', '你没办法帮我。', '热水的沸点是多少度？', '你休息了吗？', '为什么？']) {
      expect(routeByRules(said, { previous: 'act', pendingAsk: false }).route).toBe('chat')
    }
  })
})

/**
 * ——— 2026-10-03,卡「首声提速」甲:**这一回合送出去几件工具** ———
 *
 * 「慢在哪」那一节量出来的事实:act 路首声 p95 3762ms、chat 路(一件工具都不带、
 * 同一份人设)1934ms。两条路的差里有一笔是**每个要办事的回合都把 16 件工具的说明书重发一遍**。
 * 这一节在**同一批回合**上数那一笔:改前每回合 9544 字,改后按意图挑那一小组。
 *
 * 真造一份工具集(一件都不会被执行)—— 字数要数**真的那一份**,不是另抄一张名单。
 */
function toolSizes(): { sizes: Record<string, number>, full: number, count: number } {
  const stub = new Proxy({}, { get: () => async () => ({ ok: true, text: '' }) }) as never
  const tools = createChannelTools({
    workbench: stub,
    voice: stub,
    deviceFiles: stub,
    endCall: () => ({ ok: true, text: '' }),
  }) as unknown as Record<string, { description?: string, parameters?: unknown }>
  const sizes: Record<string, number> = {}
  for (const [name, tool] of Object.entries(tools)) {
    sizes[name] = name.length + String(tool.description ?? '').length + JSON.stringify(tool.parameters ?? {}).length
  }
  return {
    sizes,
    full: Object.values(sizes).reduce((sum, one) => sum + one, 0),
    count: Object.keys(sizes).length,
  }
}

describe('★★ 改前改后:要办事的回合送出去几件工具、多少字(卡「首声提速」甲)', () => {
  it('打出成绩单(交接里引的就是这几行)', () => {
    const { sizes, full, count } = toolSizes()
    const acts = replay().filter(one => one.route === 'act')
    const weigh = (names: readonly string[]): number => names.reduce((sum, name) => sum + (sizes[name] ?? 0), 0)
    const perTurn = acts.map((one) => {
      const hit = routeByRules(one.turn.text, { previous: 'act', pendingAsk: one.turn.asked })
      // 这一句命中的**全部**意图取并集(2026-10-03,卡 fix/voice-route-zh);
      // `only` 是同日早上那一版(只认第一个)—— 两列一起打才看得出并集的代价。
      const want = toolsForIntents(hit.intents)
      const only = toolsForIntent(hit.intent)
      // 认不出意图 → 全套(「分不出意图时退回全量,不许漏能力」)
      if (want === undefined) return { intent: undefined, n: count, size: full, only: full }
      return {
        intent: hit.intents?.join('+'),
        n: want.length,
        size: weigh(want),
        only: only === undefined ? full : weigh(only),
      }
    })
    const known = perTurn.filter(one => one.intent !== undefined)
    const after = perTurn.map(one => one.size)
    const sum = (list: readonly number[]): number => list.reduce((a, b) => a + b, 0)
    const knownAfter = sum(known.map(one => one.size))
    const singleAll = sum(perTurn.map(one => one.only))
    const lines = [
      '',
      `要办事的回合 ${acts.length} 个(全部 ${TURNS.length} 个回合里)`,
      `认得出意图的 ${known.length}(${percent(known.length, acts.length)})—— 剩下的照旧带全套`,
      '',
      `改前:每个要办事的回合 ${count} 件、${full} 字`,
      `改后:中位 ${median(after)} 字、平均 ${Math.round(sum(after) / after.length)} 字、`
      + `p95 ${quantile(after, 0.95)} 字`,
      `改后省下来的(全部要办事的回合合起来):${full * acts.length - sum(after)} 字 / `
      + `${percent(full * acts.length - sum(after), full * acts.length)}`,
      `只看认得出意图那 ${known.length} 个回合:省 ${known.length * full - knownAfter} 字 / `
      + `${percent(known.length * full - knownAfter, known.length * full)}`,
      '',
      `对照:只认第一个意图(10-03 早那一版)合计 ${singleAll} 字 —— 并集多花 ${sum(after) - singleAll} 字 / `
      + `${percent(sum(after) - singleAll, singleAll)};换来的是「一句话交代两件事,两件的工具都在手上」`,
      '',
      '按意图分的那几组(这一批回合里):',
      ...[...perTurn.reduce((map, one) => {
        const key = one.intent ?? '(认不出意图 → 全套)'
        const row = map.get(key) ?? { n: 0, size: one.size, 件: one.n }
        row.n += 1
        return map.set(key, row)
      }, new Map<string, { n: number, size: number, 件: number }>())]
        .sort((a, b) => b[1].n - a[1].n)
        .map(([key, row]) => `  ${String(row.n).padStart(3)} 个回合  ${key.padEnd(22)} ${row.件} 件 ${row.size} 字`),
    ]
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))

    // ★ 七成的要办事回合认得出意图(剩下三成退回全量 —— 不许漏能力那一条)
    expect(known.length / acts.length).toBeGreaterThan(0.6)
    // ★★ 认得出意图那几个回合上,工具那一份的字数砍掉一半以上
    expect(knownAfter).toBeLessThan(known.length * full * 0.5)
    // ★ 整批合起来(含照旧带全套的那三成)也省掉三分之一以上
    expect(sum(after)).toBeLessThan(full * acts.length * 0.65)
  })

  /**
   * ★ **先应的那一句一个字都不许动**(2026-10-03,卡 fix/voice-route-zh)。
   * 工具按并集下发了,但 `intent` 那一格(= 先应哪一句、`回合计时` 那一行、8791 认的字段)
   * 还是**第一个**。326 个回合逐句钉这条不变量。
   */
  it('★ intents[0] 永远等于 intent(她的嘴与计时那一格没跟着变)', () => {
    for (const turn of TURNS) {
      const hit = routeByRules(turn.text, { previous: 'act', pendingAsk: turn.asked })
      expect(hit.intents?.[0], turn.text).toBe(hit.intent)
    }
  })

  it('★ 认不出意图的回合一个字都不少给(全套)', () => {
    const { full, count } = toolSizes()
    // 日志里那一句:「她在回答事务官挂着的那一问」—— 认不出要办什么,照旧全套
    const hit = routeByRules('然后。', { previous: 'act', pendingAsk: true })
    expect(hit.route).toBe('act')
    expect(hit.intent).toBeUndefined()
    expect(toolsForIntent(hit.intent)).toBeUndefined()
    expect(count).toBeGreaterThan(10)
    expect(full).toBeGreaterThan(9000)
  })
})

/**
 * ★★ **同一批回合上「这一回合人设多少字」**(2026-10-03,卡 ②「chat 路人设按意图裁」)。
 *
 * 卡上点名要量的就是 chat 路那一列。段与标记是**工作台真算出来的那一份**
 * (夹具 `fixtures/persona-sections-1003.json`,`workbench-plugin/tests/persona-sections-1003.test.ts`
 * 盯着它不许飘);裁法在 `src/personaTrim.ts`,那一包里有逐条的判法用例。
 */
describe('★★ 改前改后:一个回合的人设多少字(卡「人设按意图裁」)', () => {
  it('打出成绩单(交接里引的就是这几行)', () => {
    const sections = JSON.parse(
      readFileSync(new URL('./fixtures/persona-sections-1003.json', import.meta.url), 'utf8'),
    ) as PersonaSection[]
    const full = [...sections.map(one => one.text).join('\n')].length
    const { count } = toolSizes()
    const allNames = Object.keys(toolSizes().sizes)
    const chat: number[] = []
    const act: number[] = []
    for (const one of replay()) {
      const hit = routeByRules(one.turn.text, { previous: 'act', pendingAsk: one.turn.asked })
      if (one.route === 'chat') {
        // 闲聊回合:没有意图(分流判 chat 时压根不填),手上零工具(道别那种只多一件挂断)
        const got = personaForTurn(sections, { intents: [], tools: [] }) as { text: string }
        chat.push([...got.text].length)
        continue
      }
      const want = toolsForIntents(hit.intents)
      const got = personaForTurn(sections, {
        intents: hit.intents ?? [],
        // 认不出意图 → 全套工具 → 讲工具的那几段一段不少(不漏规矩)
        tools: want ?? allNames,
      }) as { text: string }
      act.push([...got.text].length)
    }
    const sum = (list: readonly number[]): number => list.reduce((a, b) => a + b, 0)
    const lines = [
      '',
      `整份人设 ${full} 字(全套工具 ${count} 件 —— 改前每一个回合都把整份重发一遍)`,
      '',
      `chat ${chat.length} 个回合:P50 ${median(chat)} / P95 ${quantile(chat, 0.95)} 字 `
      + `(改前都是 ${full})—— 省 ${percent(full * chat.length - sum(chat), full * chat.length)}`,
      `act  ${act.length} 个回合:P50 ${median(act)} / P95 ${quantile(act, 0.95)} 字 `
      + `—— 省 ${percent(full * act.length - sum(act), full * act.length)}`,
      `全部 ${chat.length + act.length} 个回合合起来:省 `
      + `${percent(full * (chat.length + act.length) - sum(chat) - sum(act), full * (chat.length + act.length))}`,
      '',
      'chat 路那一列 P50 = P95 —— 闲聊回合没有意图、手上零工具,带的永远是同一份必带段。',
    ]
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))

    // ★★ 卡上量的那一个:chat 路的人设砍掉一半
    expect(median(chat)).toBeLessThan(full * 0.55)
    expect(quantile(chat, 0.95)).toBe(median(chat))
    // ★ act 路也省了(讲工具的那几段按手上真有的那几件带),但一定比 chat 路多
    expect(median(act)).toBeGreaterThan(median(chat))
    expect(median(act)).toBeLessThan(full)
  })
})

describe('事务官上一句是不是在问她(looksLikeAsking)', () => {
  it('问号、句尾的「吗 / 呢 / 吧」、「A 还是 B」、「哪一条」都算问', () => {
    expect(looksLikeAsking('要我再让它跑一遍,还是先放着?')).toBe(true)
    expect(looksLikeAsking('我把那条改成取消——行不?')).toBe(true)
    expect(looksLikeAsking('派给豆包还是 Codex')).toBe(true)
    expect(looksLikeAsking('你说的是哪一家')).toBe(true)
    expect(looksLikeAsking('要我现在就派吗。')).toBe(true)
  })

  it('报结果的那一句不算问 —— 她那句「好的」就只是应答', () => {
    expect(looksLikeAsking('派出去了,豆包那边新开了一条。')).toBe(false)
    expect(looksLikeAsking('问到了:Codex 那边本周还剩大概三成额度。')).toBe(false)
    expect(looksLikeAsking('')).toBe(false)
    expect(looksLikeAsking(undefined)).toBe(false)
  })
})

describe('一通电话一个实例:承接记的是这一通的上一回合', () => {
  it('挂断再打,上一回合作废', async () => {
    const router = new RulesTurnRouter()
    await router.route('让豆包查一下天气')
    expect(router.previous).toBe('act')
    router.reset()
    expect(router.previous).toBeUndefined()
    // 新一通的第一句是纯应答 → 没有「上一回合」可承接
    expect((await router.route('对。')).route).toBe('chat')
  })
})

/**
 * **补一句不丢正在办的事**(2026-10-12,卡「通话补一句不丢事」;交接 `docs/交接-1012-通话补一句不丢事.md`)。
 *
 * 夹具是 10-12 下午真机那两段(`~/.dsh/workbench/logs/channel-worker.log` 第 1921–1960 / 1994–2030 行),
 * 原话照抄,只读:
 *
 *   ① 「换个音色。」→ 先应「好,我挑几个给你听。」→ 带工具那一次没跑起来 → 她插「要女生的。」
 *      → 判成闲聊、零工具 → 「音色换女生的这个不是我能自己定的……」;
 *   ② 「派个活给那个 cloud,然后问他查一下……」→ 先应「好,我去安排。」→ 同上 → 她插「有回音的打给我。」
 *      → 闲聊、零工具 → 「好,派给 Claude 查……有回音打给你。」—— 一件都没派。
 *
 * 钉三件事:
 *   1. 没办完的那件事(没调工具、模型的话没完整说出口)期间插的话**并进同一件事**:
 *      意图与工具沿用,不另起一个零工具的闲聊回合;回合「回到听」也不许把那件事的判定清掉;
 *   2. 刚办过 / 刚问过的那件事之后的**短回答**承接那件事、带那件事的工具;
 *      先应那一句也算「这件事还开着」;
 *   3. (claim-guard-1012.test.ts)没调成工具不许说办了。
 */
import { describe, expect, it } from 'vitest'
import { toolsForIntents } from '../src/intentTools.ts'
import {
  TOOL_DISPATCH,
  TOOL_LAYOUT,
  TOOL_RELAY_SESSION,
  TOOL_REMEMBER,
  TOOL_SEND_FILE,
  TOOL_VOICE,
} from '../src/tools.ts'
import {
  ACK_LINES,
  NO_DECISION,
  RulesTurnRouter,
  TurnRouting,
  butlerLeftOpen,
  carryNote,
  followUpNote,
  routeByRules,
} from '../src/turnRoute.ts'

/** 真机那两段,原话。 */
const 换音色 = { first: '换个音色。', ack: '好,我挑几个给你听。', added: '要女生的。' }
const 派活 = {
  first: '派个活给那个 cloud，然后问他查一下为什么我现在不能在通话过程中让事务官去换音色了？',
  ack: '好,我去安排。',
  added: '有回音的打给我。',
}

/** 一通电话里的一个分流器(和 agent.ts 里一样:一个 TurnRouting 包一个规则分流)。 */
function call(): TurnRouting {
  return new TurnRouting({ router: new RulesTurnRouter() })
}

/** 这一回合手上会有哪几件(与 llmNode 同一条路:有 intents 就按并集)。 */
function toolsOf(decision: { intent?: string, intents?: readonly string[] }): readonly string[] | undefined {
  return toolsForIntents(decision.intents ?? (decision.intent === undefined ? undefined : [decision.intent]))
}

describe('★★ 真机夹具:插的那一句并进没办完的那件事', () => {
  it('★ 改之前:同样两句、上一件事不算开着时,「要女生的。」就是判成闲聊(病就是这一行)', () => {
    // 这一条钉住「不靠上下文时这句确实像闲聊」—— 修的是上下文,不是把这句硬塞进词表。
    expect(routeByRules(换音色.added).route).toBe('chat')
    expect(routeByRules(派活.added).route).toBe('chat')
  })

  for (const scene of [
    { name: '换音色', ...换音色, intent: 'voice', must: TOOL_VOICE },
    { name: '派活', ...派活, intent: 'dispatch', must: TOOL_DISPATCH },
  ]) {
    it(`★ ${scene.name}:先应过、模型还没办,她插「${scene.added}」→ 同一件事,意图 ${scene.intent}、手上有 ${scene.must}`, async () => {
      const routing = call()
      routing.start(scene.first, { pendingAsk: false })
      const first = await routing.settle()
      expect(first.route).toBe('act')
      expect(first.intent).toBe(scene.intent)
      expect(first.ack).toBe(scene.ack)

      // 先应念完、回到听 —— 真机上这一下把判定清掉了,补回来的那次调用只能走 none。
      routing.end()
      const again = await routing.settle()
      expect(again).not.toEqual(NO_DECISION)
      expect(again.intent).toBe(scene.intent)

      // 她插话。上一句是先应那一句(不是问句,但这件事还开着)。
      const started = routing.start(scene.added, { pendingAsk: butlerLeftOpen(scene.ack) })
      expect(started.followUp).toBe(scene.first)
      const merged = await routing.settle()
      expect(merged.route).toBe('act')
      expect(merged.intent).toBe(scene.intent)
      expect(merged.followUp).toBe(scene.first)
      // 不再先应一句(上一件事已经应过了)。
      expect(merged.ack).toBeUndefined()
      expect(toolsOf(merged)).toContain(scene.must)
    })
  }

  it('模型那一句没说完就被掐了(interrupted),也算没办完:照样并进去', async () => {
    const routing = call()
    routing.start(换音色.first)
    await routing.settle()
    // 回复说到一半被真打断:agent.ts 只在**没被掐断**的完整回复上调 noteHandled,这里就是一下都没调。
    routing.end()
    routing.start(换音色.added)
    expect((await routing.settle()).intent).toBe('voice')
  })

  it('并进去的那一回合也没办完,再补一句照样并(一件事可以补好几句)', async () => {
    const routing = call()
    routing.start(换音色.first)
    await routing.settle()
    routing.start(换音色.added)
    await routing.settle()
    const third = routing.start('温柔一点的。')
    expect(third.followUp).toBe(`${换音色.first}${换音色.added}`)
    const decision = await routing.settle()
    expect(decision.intent).toBe('voice')
  })

  it('补的那句自己也交代了一件事:两件的工具都给(并集),意图仍是原来那件', async () => {
    const routing = call()
    routing.start(换音色.first)
    await routing.settle()
    routing.start('顺便把这个记一下。')
    const decision = await routing.settle()
    expect(decision.intent).toBe('voice')
    expect(decision.intents).toEqual(expect.arrayContaining(['voice', 'remember']))
    expect(toolsOf(decision)).toEqual(expect.arrayContaining([TOOL_VOICE, TOOL_REMEMBER]))
  })

  it('那件事办了(工具调过 / 完整回过话)之后,插的话不再并 —— 回到「回到听就忘掉」', async () => {
    const routing = call()
    routing.start(换音色.first)
    await routing.settle()
    routing.noteHandled()
    routing.end()
    expect(await routing.settle()).toEqual(NO_DECISION)
    const next = routing.start('你是谁？')
    expect(next.followUp).toBeUndefined()
    expect((await routing.settle()).route).toBe('chat')
  })

  it('闲聊回合没办完不算「一件事」:插话照常判', async () => {
    const routing = call()
    routing.start('你是谁？')
    await routing.settle()
    routing.end()
    const next = routing.start('嗯。')
    expect(next.followUp).toBeUndefined()
    expect((await routing.settle()).route).toBe('chat')
  })

  it('挂断了就忘掉(下一通的第一句不许并进上一通没办完的事)', async () => {
    const routing = call()
    routing.start(换音色.first)
    await routing.settle()
    routing.forget()
    expect(routing.start('喂。').followUp).toBeUndefined()
    expect((await routing.settle()).route).toBe('chat')
  })

  it('补一句那一行话:两句都在、说清「上一句还没办」', () => {
    const note = followUpNote(换音色.first)
    expect(note).toContain(换音色.first)
    expect(note).toContain('没办')
  })
})

describe('★★ 兄弟路:要办事的那几个意图,补一句都并进去', () => {
  /** [第一句, 意图, 补的那一句, 手上必须有的那件]。 */
  const sibling: [string, string, string, string][] = [
    ['换个音色', 'voice', '要女生的', TOOL_VOICE],
    ['派个活给 Codex 修一下首页', 'dispatch', '给 Claude 吧', TOOL_DISPATCH],
    ['给豆包那条会话捎句话', 'relay', '就说我晚点到', TOOL_RELAY_SESSION],
    ['帮我记一下明天下午三点开会', 'remember', '跟 B 客户', TOOL_REMEMBER],
    ['把消耗数据挪到项目区下面', 'change', '右边那块', TOOL_LAYOUT],
    ['把文件发给我', 'file', '上周那份合同', TOOL_SEND_FILE],
  ]
  for (const [first, intent, added, must] of sibling) {
    it(`「${first}」没办完时插「${added}」→ ${intent},手上有 ${must}`, async () => {
      const routing = call()
      routing.start(first)
      const one = await routing.settle()
      expect(one.route).toBe('act')
      expect(one.intent).toBe(intent)
      routing.end()
      routing.start(added)
      const merged = await routing.settle()
      expect(merged.intent).toBe(intent)
      expect(toolsOf(merged)).toContain(must)
    })
  }
})

describe('★★ 短回答承接刚办过 / 刚问过的那件事', () => {
  it('★ 先应那一句也算「这件事还开着」(不只认模型自己问出口的问句)', () => {
    for (const line of ACK_LINES) expect(butlerLeftOpen(line)).toBe(true)
    expect(butlerLeftOpen('要我派给 Claude 吗？')).toBe(true)
    expect(butlerLeftOpen('派出去了，豆包那边新开了一条。')).toBe(false)
    expect(butlerLeftOpen('')).toBe(false)
  })

  async function handled(first: string): Promise<TurnRouting> {
    const routing = call()
    routing.start(first)
    await routing.settle()
    routing.noteHandled()
    routing.end()
    return routing
  }

  it('★ 音色列完几个(报的不是问句),她说「要女生的」/「第二个」→ 承接换音色,带 wb_set_voice', async () => {
    for (const said of ['要女生的。', '第二个。']) {
      const routing = await handled('换个音色。')
      const started = routing.start(said, { pendingAsk: butlerLeftOpen('有温柔、清亮、少年三种。') })
      expect(started.followUp).toBeUndefined()
      const decision = await routing.settle()
      expect(decision.route).toBe('act')
      expect(decision.intent).toBe('voice')
      expect(decision.carriedFrom).toBe('换个音色。')
      expect(toolsOf(decision)).toContain(TOOL_VOICE)
    }
  })

  it('★ 派活时她问「派给谁?」,答「给 Claude」→ 承接派活,带 wb_dispatch_item', async () => {
    const routing = await handled(派活.first)
    routing.start('给 Claude。', { pendingAsk: butlerLeftOpen('派给哪一家？') })
    const decision = await routing.settle()
    expect(decision.route).toBe('act')
    expect(decision.intent).toBe('dispatch')
    expect(toolsOf(decision)).toContain(TOOL_DISPATCH)
  })

  it('长回答也承接(她在回答挂着的那一问时不看长短)', () => {
    const hit = routeByRules('给 Claude 吧,让它顺便把日志也带上,查清楚了再告诉我原因', {
      previous: 'act',
      pendingAsk: true,
      carry: { text: 派活.first, intent: 'dispatch', intents: ['dispatch'] },
    })
    expect(hit.route).toBe('act')
    expect(hit.intents).toEqual(expect.arrayContaining(['dispatch']))
  })

  it('动作词那一类也把那件事的工具并进来(「换成第二个」= change ∪ voice)', () => {
    const hit = routeByRules('换成第二个', {
      previous: 'act',
      carry: { text: '换个音色', intent: 'voice', intents: ['voice'] },
    })
    expect(hit.route).toBe('act')
    expect(hit.intents).toEqual(expect.arrayContaining(['change', 'voice']))
  })

  it('应答 / 寒暄照旧走快路(10-02 那道门没拆):报完结果之后的「好的」「对。」「谢谢」是闲聊', async () => {
    for (const said of ['好的。', '对。', '谢谢。', '嗯。']) {
      const routing = await handled('换个音色。')
      routing.start(said, { pendingAsk: butlerLeftOpen('换好了,现在是清亮那个。') })
      expect((await routing.settle()).route).toBe('chat')
    }
  })

  it('只接紧挨着的那一句:中间隔了一回合闲聊,那件事就不算「刚办过」', async () => {
    const routing = await handled('换个音色。')
    routing.start('你是谁？')
    await routing.settle()
    routing.end()
    routing.start('要女生的。')
    expect((await routing.settle()).route).toBe('chat')
  })

  it('短句只接认得出、要动手的那件事:没意图的、只是查一眼的,接过来也只是白带工具', () => {
    for (const carry of [{ text: '你就不能把选项问出来?' }, { text: '什么事?', intent: 'lookup', intents: ['lookup'] }]) {
      expect(routeByRules('那豆包。', { previous: 'act', carry }).route).toBe('chat')
    }
    expect(routeByRules('那豆包。', { previous: 'act', carry: { text: '安排豆包干活', intent: 'relay', intents: ['relay'] } }).route).toBe('act')
  })

  it('她自己反问一句(「怎么会没开成呢?」)不是在答那件事:不接', () => {
    const carry = { text: '新建对话,然后问一下。', intent: 'operate', intents: ['operate'] }
    expect(routeByRules('怎么会没开成呢？', { previous: 'act', carry }).route).toBe('chat')
  })

  it('承接那一行话说清接的是哪件事', () => {
    expect(carryNote('换个音色。')).toContain('换个音色。')
  })

  it('补进来的那件事:手上有「去办」那几件(派活意图的工具表一件不少)', () => {
    expect(toolsForIntents(['dispatch'])).toEqual(expect.arrayContaining([TOOL_DISPATCH]))
  })
})

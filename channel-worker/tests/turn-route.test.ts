/**
 * 回合分流(2026-09-23,Ben 真机 0.2.68:「现在不管说什么都要说『我想想』……
 * 我问他是谁,也要想想」)。
 *
 * 这份用例钉四件事:
 *   ① **规则表**:他 09-23 12:37 那一通里说的**每一句**都在下面,一句一条,原话照抄
 *      (来源:`~/.dsh/workbench/logs/channel-worker.log` 的「他说(ASR)」行,只读);
 *   ② **分流决定工具集与垫不垫场**:闲聊回合不带工具、不垫场;
 *   ③ **判不出来一律按要办事**(超时、出错、没判过);
 *   ④ **垫场那一句轮着来**,连着两回合不是同一条。
 */
import { describe, expect, it, vi } from 'vitest'
import type { FillerSignal } from '../src/filler.ts'
import { FillerSignaller, THINKING_LINE_IDS, applyAgentState, fillerGateVerdict } from '../src/filler.ts'
import type { TurnDecision, TurnRouter } from '../src/turnRoute.ts'
import {
  ACK_LINES,
  ACT_INTENTS,
  ACT_WORDS,
  NO_DECISION,
  RulesTurnRouter,
  TurnRouting,
  ackedNote,
  createTurnRouter,
  describeDecision,
  routeByRules,
  withAckedTurn, INTRO_INTENT } from '../src/turnRoute.ts'

describe('规则表:他 09-23 那一通里的每一句', () => {
  /** 闲聊那一半(当时她一件工具都没调)。 */
  const chat: [string, string][] = [
    ['Hello.', '洋文的招呼'],
    ['喂。', '一个字的招呼'],
    ['你是谁？', 'Ben 点名说的那一句 —— 问她是谁不该想'],
    ['先这样吧，挂了。', '收场'],
    ['你讲。', '让她说'],
    ['明白，就是现在还是主要测通话呗。', '应答'],
    ['不是的，不是的。', '否定'],
  ]
  for (const [text, why] of chat) {
    it(`「${text}」→ 闲聊(${why})`, () => {
      expect(routeByRules(text).route).toBe('chat')
    })
  }

  /** 要办事那一半(当时她真调了工具)。 */
  const act: [string, string][] = [
    ['什么事啊？', '问她手上有什么事 —— 真机上她当场调了 wb_list_doing'],
    ['可以了，是通的，我们验下一个吧？你能不能换音色？', '换音色'],
    ['好吧？把这个事情记下来就尽量的。', '记下来'],
    ['那你给我拍个摄像单吧？就是把音色这个事情也改成可以配置的，而且是我可以跟你在电话通话中能够改的，你能派单吗？', '派单'],
  ]
  for (const [text, why] of act) {
    it(`「${text.slice(0, 16)}…」→ 要办事(${why})`, () => {
      expect(routeByRules(text).route).toBe('act')
    })
  }

  it('「什么事啊?」是短句才算问事;同样三个字埋在点评长句里不算', () => {
    expect(routeByRules('什么事啊？').route).toBe('act')
    const 点评 = '我发现你的回答基本上非常套公式啊。先说有什么事要我确认，然后把标题念了一遍。'
    // 这一句里的「什么事」只是半截定语 —— 它不该把工具拉进来。
    expect(routeByRules(点评, { fallback: 'chat' }).route).toBe('chat')
  })

  /*
   * ——— 承接 2026-10-02 收窄(卡「电话里像个活人」)———
   *
   * 09-23 那一版:上一回合是 act、这一句没命中寒暄词 → 还是 act。Air 那 326 个回合里
   * **158 个**是这么进 act 的,一大半是「对。」「是的。」—— 承接从例外变成了默认值。
   * 这一版要**这一句自己要求做一件新的动作**(FOLLOW_ACT_WORDS),
   * 或者**她正在回答事务官挂着的那一问**(pendingAsk)。
   */
  it('承接:上一回合在办事,这一句也真要动手 → 还是办事', () => {
    // 真机那一句:她念完三个音色名之后他挑了一个。「给我来个」就是那个动作。
    const hit = routeByRules('怎么都是女的？那给我来个调皮公主。', { previous: 'act', fallback: 'chat' })
    expect(hit.route).toBe('act')
    expect(hit.carried).toBe(true)
  })

  it('★ 承接:上一回合在办事,但这一句什么动作都没要求 → 闲聊(2026-10-02 改)', () => {
    const hit = routeByRules('怎么都是女的？', { previous: 'act', fallback: 'chat' })
    expect(hit.route).toBe('chat')
    expect(hit.carried).toBeUndefined()
  })

  it('★★ 承接:同一句认不出来的话,事务官刚问完一句 → 还是办事(那是批准/回答,不是闲聊)', () => {
    const hit = routeByRules('怎么都是女的？', { previous: 'act', pendingAsk: true, fallback: 'chat' })
    expect(hit.route).toBe('act')
    expect(hit.carried).toBe(true)
  })

  it('承接管不着寒暄:上一回合在办事,他说「好的」还是闲聊', () => {
    expect(routeByRules('明白。', { previous: 'act', fallback: 'chat' }).route).toBe('chat')
  })

  it('★ 一个词都没命中:短句走闲聊,长句才按要办事(2026-10-02 改;以前一律 act)', () => {
    const 短 = '想这么久。'
    expect(routeByRules(短).route).toBe('chat')
    const 长 = '想这么久啊,我这边其实还有另外一件事情想跟你说一下的呢。'
    expect(routeByRules(长).route).toBe('act')
    expect(routeByRules(长, { fallback: 'chat' }).route).toBe('chat')
  })

  it('空的识别结果当没说话', () => {
    expect(routeByRules('   ').route).toBe('chat')
  })
})

describe('RulesTurnRouter', () => {
  it('记得上一回合走的哪条路(承接那一格靠它)', async () => {
    const router = new RulesTurnRouter({ fallback: 'chat' })
    expect((await router.route('把这件事记下来')).route).toBe('act')
    expect(router.previous).toBe('act')
    // 2026-10-02:接下来那一句要**自己**要求做一件新的动作才接得上;接上了,判据那一行里写着「承接」
    expect((await router.route('那给我来个调皮公主。')).reason).toContain('承接')
    router.reset()
    expect((await router.route('那给我来个调皮公主。')).reason).not.toContain('承接')
  })

  it('判定里带着凭据:谁判的、凭什么、花了多久', async () => {
    const decision = await new RulesTurnRouter().route('你是谁？')
    expect(decision).toMatchObject({ route: 'chat', router: 'rules', ms: 0 })
    expect(decision.reason).toContain('你是谁')
    expect(describeDecision(decision)).toContain('不带工具')
  })
})

/** 一件说变就变的假分流:测 TurnRouting 用。 */
function fakeRouter(): { router: TurnRouter, settle: (decision: Partial<TurnDecision>) => void, calls: string[] } {
  const calls: string[] = []
  let resolve: ((decision: TurnDecision) => void) | undefined
  const router: TurnRouter = {
    name: 'fake',
    route(text) {
      calls.push(text)
      return new Promise<TurnDecision>((done) => { resolve = done })
    },
  }
  return {
    router,
    calls,
    settle: (decision) => { resolve?.({ route: 'chat', router: 'fake', reason: '假的', ms: 1, ...decision }) },
  }
}

describe('TurnRouting:一回合的判定', () => {
  it('没开判过 → 按要办事(开场白那种没有识别结果的回合)', async () => {
    const routing = new TurnRouting({ router: new RulesTurnRouter() })
    expect(await routing.settle()).toEqual(NO_DECISION)
    expect(NO_DECISION.route).toBe('act')
  })

  it('判完之前 settle 会等它;判完之后一回合只判一次', async () => {
    const fake = fakeRouter()
    const routing = new TurnRouting({ router: fake.router })
    routing.start('你是谁？')
    const waiting = routing.settle()
    expect(routing.decision).toBeUndefined()
    fake.settle({ route: 'chat' })
    expect((await waiting).route).toBe('chat')
    // 模型调完工具会再回到 llmNode:那时用的必须还是同一个判定,不能重新判。
    expect((await routing.settle()).route).toBe('chat')
    expect(fake.calls).toHaveLength(1)
  })

  it('判定超时 → 按要办事,并说清是超时', async () => {
    const fake = fakeRouter()
    const fired: (() => void)[] = []
    const routing = new TurnRouting({ router: fake.router, budgetMs: 300, setTimer: fn => fired.push(fn) })
    routing.start('随便一句')
    const waiting = routing.settle()
    fired[0]?.()
    const decision = await waiting
    expect(decision.route).toBe('act')
    expect(decision.reason).toContain('300ms')
  })

  it('判定抛了 → 按要办事,并记一行', async () => {
    const lines: string[] = []
    const router: TurnRouter = { name: 'boom', route: () => Promise.reject(new Error('网断了')) }
    const routing = new TurnRouting({ router, log: line => lines.push(line) })
    routing.start('随便一句')
    const decision = await routing.settle()
    expect(decision.route).toBe('act')
    expect(lines.join('\n')).toContain('网断了')
  })

  it('回合结束就忘掉:下一个没有识别结果的回合不沿用上一回合的路', async () => {
    const routing = new TurnRouting({ router: new RulesTurnRouter() })
    routing.start('你是谁？')
    expect((await routing.settle()).route).toBe('chat')
    routing.end()
    expect((await routing.settle()).route).toBe('act')
  })

  it('他又说了一句:迟到的判定不许叫醒上一回合', async () => {
    const fake = fakeRouter()
    const routing = new TurnRouting({ router: fake.router })
    routing.start('第一句')
    const seq = routing.seq
    const heard: TurnDecision[] = []
    routing.whenDecided(seq, decision => heard.push(decision))
    routing.start('第二句')
    fake.settle({ route: 'chat' })
    await Promise.resolve()
    await Promise.resolve()
    expect(heard).toHaveLength(0)
  })
})

describe('single-center phone turns', () => {
  it('advances the local turn counter without asking the legacy business router', () => {
    const fake = fakeRouter()
    const routing = new TurnRouting({ router: fake.router })
    const started = routing.startExternal()
    expect(started.seq).toBe(1)
    expect(fake.calls).toEqual([])
    expect(routing.decision).toBeUndefined()
    expect(routing.settle()).resolves.toEqual(NO_DECISION)
  })
})

describe('分流决定垫不垫场', () => {
  function collector() {
    const sent: FillerSignal[] = []
    const signaller = new FillerSignaller({ send: signal => sent.push(signal) })
    return { sent, signaller }
  }

  it('闲聊回合:一个字都不垫', async () => {
    const { sent, signaller } = collector()
    const routing = new TurnRouting({ router: new RulesTurnRouter() })
    routing.start('你是谁？')
    applyAgentState(signaller, 'thinking', emit => routing.whenDecided(routing.seq, (d) => { if (d.route === 'act') emit() }))
    await new Promise(done => setTimeout(done, 0))
    expect(sent).toHaveLength(0)
  })

  it('要办事的回合:照旧垫一句', async () => {
    const { sent, signaller } = collector()
    const routing = new TurnRouting({ router: new RulesTurnRouter() })
    routing.start('把这件事记下来')
    applyAgentState(signaller, 'thinking', emit => routing.whenDecided(routing.seq, (d) => { if (d.route === 'act') emit() }))
    await new Promise(done => setTimeout(done, 0))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'thinking', round: 1 })
  })

  it('闸门自己坏了不许把回合带走', () => {
    const { sent, signaller } = collector()
    expect(() => applyAgentState(signaller, 'thinking', () => { throw new Error('闸门坏了') })).not.toThrow()
    expect(sent).toHaveLength(0)
  })

  it('没有闸门就是老样子(引导与来电那一通走的就是这条)', () => {
    const { sent, signaller } = collector()
    applyAgentState(signaller, 'thinking')
    expect(sent).toHaveLength(1)
  })
})

describe('垫场那一句轮着来(Ben:不管说什么都要说「我想想」)', () => {
  it('连着几回合点名的不是同一条,一圈走完才回头', () => {
    const sent: FillerSignal[] = []
    const signaller = new FillerSignaller({ send: signal => sent.push(signal) })
    for (let i = 0; i < THINKING_LINE_IDS.length + 1; i += 1) {
      signaller.thinking()
      applyAgentState(signaller, 'listening')
    }
    const lines = sent.map(one => one.line)
    expect(lines.slice(0, THINKING_LINE_IDS.length)).toEqual([...THINKING_LINE_IDS])
    // 一圈之后回到第一条 —— 但中间从来没有连着两条一样的。
    expect(lines[THINKING_LINE_IDS.length]).toBe(THINKING_LINE_IDS[0])
    for (let i = 1; i < lines.length; i += 1) expect(lines[i]).not.toBe(lines[i - 1])
  })

  it('同一轮里的第二条 thinking 不再点名(它压根不发)', () => {
    const sent: FillerSignal[] = []
    const signaller = new FillerSignaller({ send: signal => sent.push(signal) })
    signaller.thinking()
    signaller.thinking()
    expect(sent).toHaveLength(1)
  })

  it('句子表给空的就不点名(认不得这一格的那一端照旧自己挑)', () => {
    const sent: FillerSignal[] = []
    const signaller = new FillerSignaller({ send: signal => sent.push(signal), thinkingLines: [] })
    signaller.thinking()
    expect(sent[0]?.line).toBeUndefined()
  })
})

describe('用哪一件实现', () => {
  it('缺省是规则法', async () => {
    expect((await createTurnRouter({ env: {} })).name).toBe('rules')
  })

  it('选了 jev 但环境里没有 key → 退回规则法,并如实说一句', async () => {
    const lines: string[] = []
    const router = await createTurnRouter({ env: { WORKBENCH_CHANNEL_TURN_ROUTER: 'jev' }, log: line => lines.push(line) })
    expect(router.name).toBe('rules')
    expect(lines.join('\n')).toContain('JEV_API_KEY')
  })

  it('有 key 就真装上 Jev(凭据只从环境变量来)', async () => {
    const router = await createTurnRouter({ env: { WORKBENCH_CHANNEL_TURN_ROUTER: 'jev', JEV_API_KEY: 'sk-测试' } })
    expect(router.name).toBe('jev')
  })

  it('不认识的名字 → 规则法', async () => {
    const lines: string[] = []
    const router = await createTurnRouter({ env: { WORKBENCH_CHANNEL_TURN_ROUTER: '玄学' }, log: line => lines.push(line) })
    expect(router.name).toBe('rules')
    expect(lines.join('\n')).toContain('玄学')
  })

  it('兜底那一边可以用环境变量翻过来', async () => {
    const chat = await createTurnRouter({ env: { WORKBENCH_CHANNEL_TURN_ROUTER_FALLBACK: 'chat' } })
    expect((await chat.route('认不出来的一句话')).route).toBe('chat')
    const act = await createTurnRouter({ env: {} })
    // 2026-10-02:兜底只管长句(短句什么都不沾的走闲聊),所以这里要一句长的
    expect((await act.route('认不出来的一句话,长得过了那条二十四个字的线才算交代事情')).route).toBe('act')
  })
})

describe('接线的那两处例外(引导 / 来电)', () => {
  it('这两处按的是同一个开关:不分流 = 照旧带全套工具、照旧垫场', () => {
    // 这一条钉的是意图:agent.ts 里 llmNode 与垫场闸门用的是同一个条件
    // (onboardingOn || ring?.answered())。真接线要起一个 LiveKit 会话才跑得到,
    // 这里只把「为什么」留在用例里:引导那一套的 record_answer、来电那一通的 wb_decide_item
    // 被收走,后果分别是「他答的话没人记」和「他说了可以而卡没动」。
    const 引导里他答的话 = '我叫 Ben，做产品的。'
    expect(routeByRules(引导里他答的话, { fallback: 'chat' }).route).toBe('chat')
    const 来电里他批的那一句 = '可以了。'
    expect(routeByRules(来电里他批的那一句, { fallback: 'chat' }).route).toBe('chat')
    // ↑ 两句单看都是闲聊 —— 正因为如此,那两处才一律不分流。
  })
})

describe('describeDecision', () => {
  it('一句人话说清这一回合怎么判的', () => {
    const line = describeDecision({ route: 'act', router: 'jev', reason: 'Jev 判「要办事」', ms: 312, confidence: 0.91 })
    expect(line).toContain('要办事')
    expect(line).toContain('312ms')
    expect(line).toContain('0.91')
  })
})

describe('不许偷偷变慢', () => {
  it('规则法判一千句用不了几毫秒(它在等待路径上)', () => {
    const router = new RulesTurnRouter()
    const began = performance.now()
    for (let i = 0; i < 1000; i += 1) void router.route('把这件事记下来,明天提醒我')
    expect(performance.now() - began).toBeLessThan(100)
  })

  it('判定不会把没人接的 rejection 扔出来', async () => {
    const onUnhandled = vi.fn()
    process.once('unhandledRejection', onUnhandled)
    const routing = new TurnRouting({ router: { name: 'boom', route: () => Promise.reject(new Error('炸了')) } })
    routing.start('一句话')
    await new Promise(done => setTimeout(done, 10))
    expect(onUnhandled).not.toHaveBeenCalled()
    process.off('unhandledRejection', onUnhandled)
  })
})

describe('★ 办事回合按意图先应一句(维护者 2026-09-23 14:20:「我说我想换音色,她还是说了『我想想』」)', () => {
  /** 意图表就是关键词表 —— **同一份词**,不是另抄一份。 */
  it('ACT_WORDS 是 ACT_INTENTS 摊平出来的,顺序一个字没动(顺序就是判据)', () => {
    expect(ACT_WORDS).toEqual([
      '记下', '记一下', '记住', '记着', '记录一下', '记个',
      // 2026-10-13 下午(卡 B′):「记到日历 / 记进发布计划」也归「记一笔」这一组(那一组手上有 wb_publish_plan)。
      '记到日历', '记进日历', '记在日历', '加到日历', '记到月历', '记进发布计划', '排进发布计划', '记到发布计划',
      '派单', '派个', '派一张', '派给', '需求卡', '开一张', '建一张', '建个事项', '加一张',
      '换音色', '换个音色', '换一个音色', '换个声音', '换一个声音', '换嗓子', '换个嗓子',
      '交给事务官', '告诉事务官', '让事务官', '问事务官',
      '发给我', '找一下文件', '把文件',
    ])
    expect(ACT_WORDS).toEqual(ACT_INTENTS.flatMap(one => [...one.words]))
  })

  const 应: [string, string, string][] = [
    ['你能不能换音色?', 'voice', '好,我挑几个给你听。'],
    ['换个声音吧', 'voice', '好,我挑几个给你听。'],
    ['派一张需求卡,加个导出 PDF', 'dispatch', '好,我去安排。'],
    ['这件事交给事务官', 'dispatch', '好,我去安排。'],
  ]
  for (const [text, intent, ack] of 应) {
    it(`「${text}」→ ${intent},先应「${ack}」`, () => {
      const hit = routeByRules(text)
      expect(hit.route).toBe('act')
      expect(hit.intent).toBe(intent)
      expect(hit.ack).toBe(ack)
    })
  }

  it('记一笔、问事马上能答,不先应(2026-10-12,电话先应收窄;问进度那张词表 A2 拆了)', () => {
    for (const [text, intent] of [
      ['把这个事情记下来', 'remember'],
      ['你记住,我不喜欢这个', 'remember'],
      ['什么事啊?', 'lookup'],
      ['有什么要我确认的?', 'lookup'],
    ]) {
      const hit = routeByRules(text!)
      expect(hit.route).toBe('act')
      expect(hit.intent).toBe(intent)
      expect(hit.ack).toBeUndefined()
      expect(hit.quick).toBe(true)
    }
  })

  it('★ 认不出意图就一个字都不应(退回原来的垫场「我想想」)', () => {
    // 兜底那一条:一个词都没命中,长句(2026-10-02:短句什么都不沾的走闲聊)
    const fallback = routeByRules('这个东西我可能要给你换一桶,我也说不太清到底该怎么弄才好')
    expect(fallback.route).toBe('act')
    expect(fallback.ack).toBeUndefined()
    // 承接那一条:上一回合是 act,她在回答事务官挂着的那一问,这一句自己认不出是要办什么
    const carried = routeByRules('人性更智能一点', { previous: 'act', pendingAsk: true })
    expect(carried.carried).toBe(true)
    expect(carried.ack).toBeUndefined()
    // 文件那一组故意没有应答句(维护者 只点了四类,这里不替他编一句)
    const file = routeByRules('把文件发给我')
    expect(file.intent).toBe('file')
    expect(file.ack).toBeUndefined()
  })

  it('闲聊回合没有意图、也没有应答句', () => {
    const hit = routeByRules('不是的,不是的。')
    expect(hit.route).toBe('chat')
    expect(hit.intent).toBeUndefined()
    expect(hit.ack).toBeUndefined()
  })

  it('★ 问她自己(2026-10-13 夜,卡 V)带 intro 意图,但**不先应**(它不在 ACT_INTENTS 里,没有应答句)', () => {
    const hit = routeByRules('你是谁?')
    expect(hit.route).toBe('chat')
    expect(hit.intent).toBe(INTRO_INTENT)
    expect(hit.ack).toBeUndefined()
  })

  it('要预合成的就那几句,去重过(「好,我去安排。」两组共用)', () => {
    expect(ACK_LINES).toEqual(['好,我去安排。', '好,我挑几个给你听。', '我看一眼。'])
    expect(new Set(ACK_LINES).size).toBe(ACK_LINES.length)
  })

  it('判定把意图与应答句原样带出来(日志、体检页、agent.ts 读的都是它)', async () => {
    const decision = await new RulesTurnRouter().route('你能不能换个音色')
    expect(decision.intent).toBe('voice')
    expect(decision.ack).toBe('好,我挑几个给你听。')
    expect(describeDecision(decision)).toContain('先应「好,我挑几个给你听。」')
    expect(describeDecision(decision)).toContain('意图 voice')
  })
})

describe('★ 应过了就别再应一次(带进模型上下文的那一行)', () => {
  it('那一行里点着原话,而且明说别再应一次、别说「我想想」', () => {
    const note = ackedNote('好,我挑几个给你听。')
    expect(note).toContain('好,我挑几个给你听。')
    expect(note).toContain('不要再应一次')
    expect(note).toContain('我想想')
  })

  /** 一份十行的假上下文:这个文件不认识 LiveKit,用例也不该认识。 */
  class FakeCtx {
    items: { role: string, content: string }[] = []
    copy(): FakeCtx {
      const next = new FakeCtx()
      next.items = [...this.items]
      return next
    }

    addMessage(params: { role: 'system', content: string }): unknown {
      this.items.push({ role: params.role, content: params.content })
      return params
    }
  }

  it('★ 加在副本上:原来那一份一个字不动(对话历史里不许多一条)', () => {
    const ctx = new FakeCtx()
    ctx.addMessage({ role: 'system', content: '人设' })
    const next = withAckedTurn(ctx, '好,我记一下。')
    expect(ctx.items).toHaveLength(1)
    expect(next).not.toBe(ctx)
    expect(next.items).toHaveLength(2)
    expect(next.items[1]?.content).toContain('好,我记一下。')
  })

  it('没应过就原样返回(没应过的回合不该凭空多一句「你已经应过了」)', () => {
    const ctx = new FakeCtx()
    expect(withAckedTurn(ctx, '   ')).toBe(ctx)
  })
})

describe('★ 应过一句的回合不再垫场(两句话打架)', () => {
  it('闲聊不垫、应过不垫、认不出意图的办事回合照垫', () => {
    expect(fillerGateVerdict('chat').fill).toBe(false)
    expect(fillerGateVerdict('act').fill).toBe(true)
    const acked = fillerGateVerdict('act', { acked: '好,我挑几个给你听。' })
    expect(acked.fill).toBe(false)
    expect(acked.why).toContain('好,我挑几个给你听。')
    // 空的「应过」当没应过(那一回合就是没应出去)
    expect(fillerGateVerdict('act', { acked: '  ' }).fill).toBe(true)
  })
})

/* ──────── ★ 问她自己 → 闲聊路 + 「介绍自己」意图(2026-10-13 夜,卡 V)──────── */

describe('★问她自己:闲聊路、带 intro 意图(人设里【介绍自己】那一段跟着带)', () => {
  it('「能介绍一下自己吗 / 你是谁 / 你能做什么」→ chat + intents [intro],零工具', () => {
    for (const said of ['能介绍一下自己吗?', '介绍下你自己。', '你是谁?', '你能做什么?', '你是干什么的?', '做个自我介绍吧']) {
      const got = routeByRules(said)
      expect(got.route, said).toBe('chat')
      expect(got.intents, said).toEqual([INTRO_INTENT])
      expect(got.reason, said).toContain('介绍自己')
    }
  })

  it('别的闲聊与要办事不带 intro;「介绍」别的东西也不算', () => {
    expect(routeByRules('拜拜。').intents).toBeUndefined()
    expect(routeByRules('帮我把待办改成卡片。').intents ?? []).not.toContain(INTRO_INTENT)
    expect(routeByRules('给我介绍一下这个项目的进展。').intents ?? []).not.toContain(INTRO_INTENT)
  })
})

/* ──────── ★ 介绍模式里接着问她自己(2026-10-14 凌晨,卡 Z)──────── */

describe('★介绍模式里接着问她自己:闲聊 + intro,不被动作词 / 长句兜底拽去办事路', () => {
  // 0.4.129 真机那一通的三句原话。
  const FOLLOWUPS = [
    '记什么？我们不是在让你介绍你自己吗？',
    '你是通过什么样的机制去学习和我协作的？',
    '那你跟其他家的那种智能体有什么区别？听上去都一样。',
    '没听懂，你能帮我做到什么？',
  ]
  it('介绍模式里这几句都是闲聊 + [intro]', () => {
    for (const said of FOLLOWUPS) {
      const got = routeByRules(said, { introMode: true })
      expect(got.route, said).toBe('chat')
      expect(got.intents, said).toEqual([INTRO_INTENT])
      expect(got.ack, said).toBeUndefined()
    }
  })
  it('不在介绍模式里,「让你介绍你自己」照旧被「让」拽去办事路(这就是 0.4.129 那一通的样子)', () => {
    expect(routeByRules('记什么？我们不是在让你介绍你自己吗？').route).toBe('act')
  })
  it('介绍模式里真要办事的句子照旧办事(弱记号「你能」遇上动作词不算问她)', () => {
    expect(routeByRules('帮我把待办改成卡片。', { introMode: true }).route).toBe('act')
    expect(routeByRules('你能帮我派给豆包做个视频吗？', { introMode: true }).route).toBe('act')
  })
})


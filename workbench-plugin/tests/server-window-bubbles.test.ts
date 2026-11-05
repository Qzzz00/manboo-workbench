// @vitest-environment node
/**
 * 窗口型各家**假气泡乱跳、真在跑的那条没气泡**(2026-09-27,卡 BB)。
 *
 * 维护者 11:47 原话:「豆包办公突然弹出执行中的气泡,然后蓝了然后又白了又蓝了,muse 也是突然出现了
 * 一个蓝色的气泡,接着是 manus、antigravity,然后这几家的气泡就都消失了,**实际上正在运行的 codex
 * 却没有气泡**。」
 *
 * 那一刻真机上的四件事,这个文件一条一条钉住(夹具全用日志与 `/state` 里的原话):
 * 1. **重启那一拍**:`agents.json` 里存着几十分钟前的指纹,起来第一拍一比「不一样」→ 九家一起冒「回了」;
 * 2. **来回晃**:「Manus 开始跑了 / Manus 回了:What can I do for you?」成对刷了四轮 —— 那扇窗在两份内容之间来回;
 * 3. **界面字漏过去**:「对话摘要」(豆包办公窗上那格面板的标牌)、「Context automatically compacting」
 *    (Codex 的状态条)、「Thursday 20:17」(消息头上的时间戳);
 * 4. **Codex**:`/state.agent_registry` 里 `status: running` 而 `counts.running: 0` ——
 *    认不出当前那条对话的名字,那条会话就被整个扔掉了,坞上的白点按会话数画,于是一颗都没有。
 */
import { describe, expect, it } from 'vitest'
import type { WindowAgentState } from '../src/server/agentWindowModel.ts'
import { isNotTalk, nextWindowState, parseRead, summarizeRead } from '../src/server/agentWindowModel.ts'
import { windowConversations } from '../src/server/agentRegistry.ts'
import { windowTitleOnly } from '../src/server/agentSources.ts'
import { createWindowQuotaReader } from '../src/server/agentQuota.ts'

function read(over: Record<string, unknown> = {}) {
  return parseRead({
    running: true,
    windows: 1,
    window: { w: 1200, h: 800 },
    title: 'Foo AI',
    active: false,
    input: { x: 380, y: 700, w: 760, h: 60 },
    sidebar: { x: 0, y: 0, w: 300, h: 800 },
    stop: [],
    tail: [
      { t: '帮我查一下这条报错', x: 700, y: 200, w: 300, h: 20 },
      { t: '查到了:是端口被占了,先把旧的那个进程停掉。', x: 400, y: 300, w: 600, h: 60 },
    ],
    side: [
      { t: '这条报错', sel: true, x: 20, y: 110, w: 260, h: 30 },
      { t: '旅行计划', x: 20, y: 150, w: 260, h: 30 },
    ],
    ...over,
  })
}

const t0 = new Date('2026-09-27T03:40:00.000Z')
const at = (sec: number): Date => new Date(t0.getTime() + sec * 1000)

/** 上一次存下来的那一份(重启后从 `agents.json` 读回来的就长这样)。 */
function stored(over: Partial<WindowAgentState> = {}): WindowAgentState {
  return { status: 'idle', since: t0.toISOString(), at: t0.toISOString(), changed_at: t0.toISOString(), titles: [], unread: false, gaps: {}, ...over }
}

describe('界面字:那三句原话不算它说的话(开集,按形状不按品牌)', () => {
  it('★「对话摘要」是豆包办公窗上那格面板的标牌 —— 不算话', () => {
    expect(isNotTalk('对话摘要', '豆包办公', ['豆包'])).toBe(true)
    // 真话不受影响:他让它写一份摘要那一句照旧算话。
    expect(isNotTalk('帮我写一个对话摘要,三条就行', '豆包办公', ['豆包'])).toBe(false)
  })

  it('★「Context automatically compacting」是 Codex 的状态条 —— 不算话(按形状:2–4 个词、没标点、以 ing 结尾、没代词)', () => {
    expect(isNotTalk('Context automatically compacting', 'Codex', ['ChatGPT'])).toBe(true)
    expect(isNotTalk('Summarizing conversation', 'Codex')).toBe(true)
    // 一句真话里几乎一定有代词或标点。
    expect(isNotTalk("I'm compacting the context now.", 'Codex')).toBe(false)
    expect(isNotTalk('这条我正在压缩上下文,稍等', 'Codex')).toBe(false)
  })

  it('★「Thursday 20:17」是消息头上的时间戳 —— 不算话(剥完星期、数字、分隔符什么都不剩)', () => {
    expect(isNotTalk('Thursday 20:17', 'Codex')).toBe(true)
    expect(isNotTalk('昨天 09:12', 'Codex')).toBe(true)
    expect(isNotTalk('Sep 25, 17:21', 'Codex')).toBe(true)
    // 带话的那一行照旧算话。
    expect(isNotTalk('周四 20:17 之前给我', 'Codex')).toBe(false)
  })

  it('★这三句都不进最新一句、也不进指纹', () => {
    const summary = summarizeRead(read({
      title: 'ChatGPT',
      side: [],
      tail: [
        { t: 'Thursday 20:17', x: 400, y: 260, w: 200, h: 20 },
        { t: 'Context automatically compacting', x: 400, y: 300, w: 400, h: 20 },
      ],
    }), 'Codex', ['ChatGPT'])
    expect(summary.latest).toBeUndefined()
    expect(summary.signature).toBeUndefined()
    expect(summary.lines).toBe(0)
  })
})

describe('重启 / 断过之后的第一拍:只重新起算,不当成「它回了一句」', () => {
  it('★★重启那一拍:盘上那一份指纹与这一拍不一样 —— 不冒气泡、不记未读、不判成在跑', () => {
    // agentDiscovery.ensureLoaded 把从盘上读回来的每一份都标成 stale。
    const prev = stored({ signature: 'deadbeef', latest: '上次读到的那句', stale: true })
    const next = nextWindowState(prev, summarizeRead(read(), 'Foo AI'), { now: at(30), active: false, name: 'Foo AI' })
    expect(next.bubble).toBeUndefined()
    expect(next.state.unread).toBe(false)
    expect(next.state.status).toBe('idle')
    expect(next.state.stale).toBeUndefined()
    // 「最近在做什么」的时刻不许改到现在(这一拍没看见它变)。
    expect(next.state.changed_at).toBe(t0.toISOString())
  })

  it('★重新起算那一拍窗口里真有停止键:照旧算在跑(那不是比出来的,是当场看见的)', () => {
    const prev = stored({ signature: 'deadbeef', stale: true })
    const busy = nextWindowState(prev, summarizeRead(read({ stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(30), active: false, name: 'Foo AI' })
    expect(busy.state.status).toBe('running')
    // 状态是从 idle 翻到 running 的,可这一拍比不得 —— 气泡要等下一拍真看见转折。
    expect(busy.bubble).toBeUndefined()
  })

  it('★★读不到窗口那一拍之后:恢复的第一拍也只重新起算(藏起来了、辅助功能没读到都走这条)', () => {
    const one = nextWindowState(undefined, summarizeRead(read(), 'Foo AI'), { now: t0, active: false, name: 'Foo AI' })
    const lost = nextWindowState(one.state, summarizeRead(parseRead({ running: true, windows: 0 }), 'Foo AI'), { now: at(30), active: false, name: 'Foo AI' })
    expect(lost.state.status).toBe('unknown')
    expect(lost.state.stale).toBe(true)
    const back = nextWindowState(lost.state, summarizeRead(read({ tail: [
      { t: '帮我查一下这条报错', x: 700, y: 200, w: 300, h: 20 },
      { t: '换了一份内容:端口的事我改好了', x: 400, y: 300, w: 600, h: 60 },
    ] }), 'Foo AI'), { now: at(40), active: false, name: 'Foo AI' })
    expect(back.bubble).toBeUndefined()
    expect(back.state.unread).toBe(false)
    expect(back.state.status).toBe('idle')
  })

  /*
   * **卡 GB 改了这一条的口径**(原来写的是「下一拍内容变了就照旧冒『回了』」):内容变了不再算在跑、
   * 也不再起气泡 —— 那一支正是幽灵气泡的出处。这道闸没把真话挡掉,现在靠的是**停止键**那一对转折。
   */
  it('★重新起算之后,下一拍真跑起来(看得见停止键):照旧冒「开始跑了 / 回了」(这道闸没把真话一起挡掉)', () => {
    const prev = stored({ signature: 'deadbeef', stale: true })
    const base = nextWindowState(prev, summarizeRead(read(), 'Foo AI'), { now: at(30), active: false, name: 'Foo AI' })
    const grown = read({ stop: [{ x: 1100, y: 720, w: 30, h: 30 }], tail: [
      { t: '帮我查一下这条报错', x: 700, y: 200, w: 300, h: 20 },
      { t: '查到了:是端口被占了,先把旧的那个进程停掉。', x: 400, y: 300, w: 600, h: 60 },
    ] })
    const out = nextWindowState(base.state, summarizeRead(grown, 'Foo AI'), { now: at(45), active: false, name: 'Foo AI' })
    expect(out.bubble?.kind).toBe('started')
    // 停止键没了那一拍 = 它说完了 →「回了」并记成未读。
    const done = read({ tail: [
      { t: '帮我查一下这条报错', x: 700, y: 200, w: 300, h: 20 },
      { t: '查到了:是端口被占了,先把旧的那个进程停掉。', x: 400, y: 300, w: 600, h: 60 },
      { t: '顺手把旧进程也停了,你看一下还有没有别的', x: 400, y: 380, w: 600, h: 40 },
    ] })
    const replied = nextWindowState(out.state, summarizeRead(done, 'Foo AI'), { now: at(80), active: false, name: 'Foo AI' })
    expect(replied.bubble?.kind).toBe('replied')
    expect(replied.state.unread).toBe(true)
  })
})

describe('来回晃不算变:回到几拍前见过的那一份,不是它又说了一句', () => {
  /** 真机 Manus:一扇窗上只有开场白,另一份内容是它侧栏 / 另一扇窗上的旧对话。 */
  const greeting = read({ title: 'Manus', side: [], tail: [
    { t: '你上次让我查的那条已经好了', x: 700, y: 200, w: 300, h: 20 },
    { t: 'What can I do for you?', x: 400, y: 300, w: 300, h: 20 },
  ] })
  const other = read({ title: 'Manus', side: [], tail: [
    { t: '你上次让我查的那条已经好了', x: 700, y: 200, w: 300, h: 20 },
    { t: '好的,我把那条的结论写在这儿了', x: 400, y: 300, w: 400, h: 20 },
  ] })

  it('★★A → B → A:第三拍不冒气泡、不判成在跑(日志上那四轮「开始跑了 / 回了」就是这么来的)', () => {
    const one = nextWindowState(undefined, summarizeRead(greeting, 'Manus'), { now: t0, active: false, name: 'Manus' })
    const two = nextWindowState(one.state, summarizeRead(other, 'Manus'), { now: at(10), active: false, name: 'Manus' })
    // 头一次换内容照旧算「变了」(那时候还说不上是晃),但**变了不算在跑**(卡 GB 改口径:只认停止键)。
    expect(two.state.changed_at).toBe(at(10).toISOString())
    expect(two.state.status).toBe('idle')
    expect(two.bubble).toBeUndefined()
    const three = nextWindowState(two.state, summarizeRead(greeting, 'Manus'), { now: at(20), active: false, name: 'Manus' })
    expect(three.bubble).toBeUndefined()
    expect(three.state.status).toBe('idle')
    expect(three.state.unread).toBe(false)
    const four = nextWindowState(three.state, summarizeRead(other, 'Manus'), { now: at(30), active: false, name: 'Manus' })
    expect(four.bubble).toBeUndefined()
    expect(four.state.unread).toBe(false)
  })

  /*
   * **卡 GB 改了这一条的口径**:晃过之后「冒出一句没见过的新话」本身不再起气泡(内容变了不算在跑),
   * 真跑一趟(停止键起落)照旧冒 —— 这道闸没把真的那一趟挡掉。
   */
  it('★晃过之后真跑一趟(停止键起落):照旧冒「开始跑了 / 回了」', () => {
    const one = nextWindowState(undefined, summarizeRead(greeting, 'Manus'), { now: t0, active: false, name: 'Manus' })
    const two = nextWindowState(one.state, summarizeRead(other, 'Manus'), { now: at(10), active: false, name: 'Manus' })
    const three = nextWindowState(two.state, summarizeRead(greeting, 'Manus'), { now: at(20), active: false, name: 'Manus' })
    const busy = read({ title: 'Manus', side: [], stop: [{ x: 1100, y: 720, w: 30, h: 30 }], tail: [
      { t: '你上次让我查的那条已经好了', x: 700, y: 200, w: 300, h: 20 },
      { t: 'What can I do for you?', x: 400, y: 300, w: 300, h: 20 },
    ] })
    const news = read({ title: 'Manus', side: [], tail: [
      { t: '你上次让我查的那条已经好了', x: 700, y: 200, w: 300, h: 20 },
      { t: '这条我刚跑完,三个结论都在下面', x: 400, y: 300, w: 400, h: 20 },
    ] })
    const fresh = nextWindowState(three.state, summarizeRead(busy, 'Manus'), { now: at(40), active: false, name: 'Manus' })
    expect(fresh.bubble?.kind).toBe('started')
    const settled = nextWindowState(fresh.state, summarizeRead(news, 'Manus'), { now: at(80), active: false, name: 'Manus' })
    expect(settled.bubble?.kind).toBe('replied')
    expect(settled.state.unread).toBe(true)
  })
})

describe('Codex:认不出当前那条对话的名字,在跑的那一条也得在(坞上、顶栏的白点按会话数画)', () => {
  /** 真机 11:53 `/state`:codex 那一家 title 缺席、侧栏里八条别的对话,状态 running。 */
  const titles = ['掌机本地 ROM 抽取攻略', '寻找Logo设计Skill并分析未来字标', '调研宝可梦日蚀', '检测树莓派连接']

  it('★★在跑:当前那一条排在最前(没名字也在),于是数得出一条在跑', () => {
    const state = stored({ status: 'running', titles, latest: '我查到一个关键变化……' })
    const list = windowConversations(state)
    expect(list[0]?.current).toBe(true)
    expect(list[0]?.title).toBeUndefined()
    expect(list).toHaveLength(titles.length + 1)
  })

  it('★有他没看过的回话时也在(那颗蓝点也是挂在这一条上的)', () => {
    const state = stored({ status: 'idle', titles, unread: true, latest: '写完了' })
    expect(windowConversations(state)[0]?.current).toBe(true)
  })

  it('★空闲又没有未读:照旧不摆那张没名字的卡(09-26 晚刚收掉的乱不许回来)', () => {
    const state = stored({ status: 'idle', titles })
    const list = windowConversations(state)
    expect(list.every(one => !one.current)).toBe(true)
    expect(list.map(one => one.title)).toEqual(titles)
  })

  it('★侧栏一条都认不出来时照旧回当前那一条(不能回空数组:那样这一家在坞上会整个消失)', () => {
    expect(windowConversations(stored({ status: 'idle' }))).toEqual([{ id: expect.any(String), current: true }])
  })
})

describe('读额度那一路与会话状态两条路分开(卡 AG 的重读不许冒气泡)', () => {
  it('★★读一家的窗口额度之前与之后都跟登记表那一路说一声(那几家下一拍只重新起算)', async () => {
    const touched: string[][] = []
    const reader = createWindowQuotaReader({
      request: async () => ({ ok: true, result: { matches: [{ id: 'page', text: '使用情况', x: 400, y: 100 }, { id: 'used', text: '3% used', x: 900, y: 180 }] } }),
      helper: () => ({ connected: true, authorized: true, readTexts: true }),
      wait: async () => {},
      onWindowTouched: ids => { touched.push([...ids]) },
    })
    await reader.refresh(['muse'])
    // 读之前一次(readOne)、读完一次(refresh 收尾 —— 读完把藏着的家藏回去,窗上的字还会再换一次)。
    expect(touched.length).toBeGreaterThanOrEqual(2)
    expect(touched.flat()).toContain('com.meta.endo')
  })

  it('★说过一声之后那一拍:内容整页换了也不冒气泡(额度页翻过去又翻回来就是这样)', () => {
    const talk = read({ title: 'Muse', side: [] })
    const one = nextWindowState(undefined, summarizeRead(talk, 'Muse'), { now: t0, active: false, name: 'Muse' })
    // agentDiscovery.windowTouched 就是往这一份上盖这一格。
    const marked: WindowAgentState = { ...one.state, stale: true }
    const usagePage = read({ title: 'Muse', side: [], tail: [
      { t: '使用情况', x: 400, y: 100, w: 200, h: 20 },
      { t: '3% used', x: 900, y: 180, w: 100, h: 20 },
    ] })
    const after = nextWindowState(marked, summarizeRead(usagePage, 'Muse'), { now: at(10), active: false, name: 'Muse' })
    expect(after.bubble).toBeUndefined()
    expect(after.state.unread).toBe(false)
    // 翻回对话那一页也不冒(这一拍又是「只重新起算」之后的第一拍比出来的差)。
    const back = nextWindowState({ ...after.state, stale: true }, summarizeRead(talk, 'Muse'), { now: at(20), active: false, name: 'Muse' })
    expect(back.bubble).toBeUndefined()
  })
})

/**
 * ─────────────────────────── 卡 BB2(2026-09-27 下午)───────────────────────────
 *
 * 维护者 12:50 原话:「codex 只有白色呼吸气泡,完成后没有转为蓝色,我点过去一看其实已经完成有一阵子了;
 * 刚才 muse 又弹了白色气泡,我点击过去之后,发现什么都没有,然后白色气泡就没了。」
 *
 * 只读地量了真机(`curl 127.0.0.1:8791/state` 连着两分半、`~/.dsh/workbench/agents.json`、
 * `~/.dsh/logs/web.stdout.log`),量到的是:
 *
 * | 那一家 | 真机读回来的 | 说明什么 |
 * |---|---|---|
 * | Codex | `status: running` 连着 **422 秒**,`activity.at`(= `changed_at`)停在 210 秒前没动过 | 「变了才算在跑」那一路早就不成立,撑着它的只有当场看见的那个**停止键** —— 那扇窗上的停止键一直在,于是它永远不 idle,`justAnswered` 永不触发,白点只会一直呼吸 |
 * | Codex | `latest: "Context automatically compacted"` | 同一条状态条的**过去式**,卡 BB 的 `-ing` 判据漏过去了 |
 * | Claude | 日志 `[agents] Claude 回了:Background tasks` | 那扇窗上那格面板的**标牌**,它谁也没回 |
 * | Muse | `latest` 是它那张「我把 release notes 翻一遍,给你一份…」的建议卡 | 对话区翻到别的一页 → 指纹一变 → 判在跑 → 白气泡;他点过去,那一页上什么都没有 |
 */
describe('卡 BB2:停止键一直在,不能就一直算在跑(真机 Codex:422 秒在跑、210 秒没出一个字)', () => {
  const busyRead = (over: Record<string, unknown> = {}) => read({ stop: [{ x: 1100, y: 720, w: 30, h: 30 }], ...over })

  it('★★停止键在那儿、对话区又一直没变 —— 撑过三分钟就不算在跑,并且把「回了」那颗蓝点补上', () => {
    const one = nextWindowState(undefined, summarizeRead(busyRead(), 'Codex'), { now: t0, active: false, name: 'Codex' })
    expect(one.state.status).toBe('running')
    expect(one.state.busy_since).toBe(t0.toISOString())
    // 一家被看见在跑之后读得密(十几秒一拍,真机就是这样)—— 一拍一拍走到三分钟。
    let state = one.state
    for (let sec = 15; sec <= 165; sec += 15) {
      const tick = nextWindowState(state, summarizeRead(busyRead(), 'Codex'), { now: at(sec), active: false, name: 'Codex' })
      // 三分钟以内:照旧算在跑(它可能真在想,宁可让白点多呼吸一会儿)。
      expect(tick.state.status).toBe('running')
      expect(tick.bubble).toBeUndefined()
      state = tick.state
    }
    const waiting = { state }
    // 真机上那 422 秒:停止键还在,可字一个都没变 —— 撑过三分钟这一拍起不算在跑,「回了」与未读补上。
    const stalled = nextWindowState(waiting.state, summarizeRead(busyRead(), 'Codex'), { now: at(185), active: false, name: 'Codex' })
    expect(stalled.state.status).toBe('idle')
    expect(stalled.bubble).toMatchObject({ kind: 'replied' })
    expect(stalled.state.unread).toBe(true)
    // 再读几拍:不再一遍遍冒同一句(转折只有那一次)。
    const again = nextWindowState(stalled.state, summarizeRead(busyRead(), 'Codex'), { now: at(200), active: false, name: 'Codex' })
    expect(again.state.status).toBe('idle')
    expect(again.bubble).toBeUndefined()
  })

  it('★这中间真出了字:那道三分钟的闸从出字那一刻重新算(它真在跑就不许被判成空闲)', () => {
    const one = nextWindowState(undefined, summarizeRead(busyRead(), 'Codex'), { now: t0, active: false, name: 'Codex' })
    const grown = busyRead({ tail: [
      { t: '帮我查一下这条报错', x: 700, y: 200, w: 300, h: 20 },
      { t: '查到了:是端口被占了,先把旧的那个进程停掉。', x: 400, y: 300, w: 600, h: 60 },
      { t: '顺手把旧进程也停了', x: 400, y: 380, w: 600, h: 40 },
    ] })
    const moved = nextWindowState(one.state, summarizeRead(grown, 'Codex'), { now: at(15), active: false, name: 'Codex' })
    expect(moved.state.status).toBe('running')
    expect(moved.state.changed_at).toBe(at(15).toISOString())
    // 从出字那一刻起重新数三分钟:这一拍(离出字 170 秒)照旧算在跑。
    const still = nextWindowState(moved.state, summarizeRead(grown, 'Codex'), { now: at(185), active: false, name: 'Codex' })
    expect(still.state.status).toBe('running')
  })

  it('★★空闲的那几家 6 分钟才读一次 —— 隔那么久读一拍,不敢说那个键卡住了(它可能在跑一件不出字的长活)', () => {
    let state = nextWindowState(undefined, summarizeRead(busyRead(), 'Codex'), { now: t0, active: false, name: 'Codex' }).state
    for (let sec = 360; sec <= 360 * 5; sec += 360) {
      const tick = nextWindowState(state, summarizeRead(busyRead(), 'Codex'), { now: at(sec), active: false, name: 'Codex' })
      expect(tick.state.status).toBe('running')
      expect(tick.bubble).toBeUndefined()
      state = tick.state
    }
  })

  it('★停止键一消失就照老样子办(那一格清掉,转折照旧是「回了」)', () => {
    const one = nextWindowState(undefined, summarizeRead(busyRead(), 'Codex'), { now: t0, active: false, name: 'Codex' })
    const gone = nextWindowState(one.state, summarizeRead(read(), 'Codex'), { now: at(10), active: false, name: 'Codex' })
    expect(gone.state.busy_since).toBeUndefined()
    expect(gone.state.status).toBe('idle')
    expect(gone.bubble).toMatchObject({ kind: 'replied' })
  })
})

describe('卡 BB2:整页换掉不是「它又说了一句」(真机 Muse:对话区翻到它那张建议卡)', () => {
  /** 读满三段的一扇窗(真机上一条正常对话就这样)。 */
  const chat = read({ tail: [
    { t: '这条报错你看一下', x: 700, y: 160, w: 300, h: 20 },
    { t: '是端口被占了,先把旧的那个进程停掉。', x: 400, y: 240, w: 600, h: 60 },
    { t: '好,我停了,再看一眼', x: 700, y: 330, w: 300, h: 20 },
  ] })
  /** 十几秒后同一扇窗上三段全换了 —— 那是翻到了别的一页(建议卡 / 面板 / 另一条对话)。 */
  const flipped = read({ tail: [
    { t: '你 SuperGrok 试用开到第二天了,Grok 4.7 到底值不值得拿来做 vibe coding', x: 400, y: 160, w: 600, h: 40 },
    { t: '我把它的 release notes 和公开 issue 翻一遍,只留下对你写代码有影响的变化', x: 400, y: 240, w: 600, h: 40 },
    { t: '给你一份「值得跟」的清单', x: 400, y: 330, w: 600, h: 40 },
  ] })

  it('★★十几秒里三段一段都不剩 —— 不冒气泡、不判成在跑(那颗白气泡点过去什么都没有)', () => {
    const one = nextWindowState(undefined, summarizeRead(chat, 'Muse'), { now: t0, active: false, name: 'Muse' })
    expect(one.state.psigs?.length).toBe(3)
    const flip = nextWindowState(one.state, summarizeRead(flipped, 'Muse'), { now: at(10), active: false, name: 'Muse' })
    expect(flip.bubble).toBeUndefined()
    expect(flip.state.status).toBe('idle')
    expect(flip.state.unread).toBe(false)
    // 「最近在做什么」的时刻也不许改到现在(这一拍没看见它变)。
    expect(flip.state.changed_at).toBe(t0.toISOString())
  })

  /*
   * **卡 GB 改了这一条的口径**:「算变」只剩「最近在做什么」的时刻与读得密不密那两件事 ——
   * 判在跑与起气泡都只认停止键了。这一条要钉的还是那道翻页闸没把**真往后长**的那一拍误判成翻页。
   */
  it('★真的往后长了一段(前面几段还在):照旧算变(「最近在做什么」的时刻跟着走)', () => {
    const one = nextWindowState(undefined, summarizeRead(chat, 'Muse'), { now: t0, active: false, name: 'Muse' })
    const grown = read({ tail: [
      { t: '是端口被占了,先把旧的那个进程停掉。', x: 400, y: 240, w: 600, h: 60 },
      { t: '好,我停了,再看一眼', x: 700, y: 330, w: 300, h: 20 },
      { t: '现在起来了,三个端口都在听', x: 400, y: 410, w: 600, h: 40 },
    ] })
    const out = nextWindowState(one.state, summarizeRead(grown, 'Muse'), { now: at(10), active: false, name: 'Muse' })
    expect(out.state.changed_at).toBe(at(10).toISOString())
    // 窗上没有停止键 —— 卡 GB 起,这一路一个气泡都不冒(宁可少,不可假)。
    expect(out.state.status).toBe('idle')
    expect(out.bubble).toBeUndefined()
  })

  /* **卡 GB 改了这一条的口径**:「算它答完了」原来是一颗蓝气泡,现在只是「最近在做什么」跟着走。 */
  it('★隔了三分钟才读一次的那一家:三段全换了照旧算变(慢节奏下整轮问答就是这样,不算翻页)', () => {
    const one = nextWindowState(undefined, summarizeRead(chat, 'Muse'), { now: t0, active: false, name: 'Muse' })
    const out = nextWindowState(one.state, summarizeRead(flipped, 'Muse'), { now: at(180), active: false, name: 'Muse' })
    expect(out.state.changed_at).toBe(at(180).toISOString())
    expect(out.bubble).toBeUndefined()
  })

  it('★只看得见一两段的窗上不算翻页(他问一句、它答一句就能把那一两段全换掉)', () => {
    const one = nextWindowState(undefined, summarizeRead(read(), 'Muse'), { now: t0, active: false, name: 'Muse' })
    const both = read({ tail: [
      { t: '再帮我改一版', x: 700, y: 200, w: 300, h: 20 },
      { t: '改好了,这版短了一半', x: 400, y: 300, w: 600, h: 60 },
    ] })
    const out = nextWindowState(one.state, summarizeRead(both, 'Muse'), { now: at(10), active: false, name: 'Muse' })
    // 卡 GB 起:这一条钉的是「算不算变」(时刻跟着走),不再是「算不算在跑」。
    expect(out.state.changed_at).toBe(at(10).toISOString())
  })
})

describe('卡 BB2:今天日志上那两句界面字', () => {
  it('★★「Context automatically compacted」—— 同一条状态条的过去式,照旧不算它说的话', () => {
    expect(isNotTalk('Context automatically compacted', 'Codex', ['ChatGPT'])).toBe(true)
    expect(isNotTalk('Context automatically compacting', 'Codex', ['ChatGPT'])).toBe(true)
    // 真话不受影响:有代词、有标点、词全大写开头的都照旧算话。
    expect(isNotTalk('I have finished', 'Codex', ['ChatGPT'])).toBe(false)
    expect(isNotTalk('Initiating A New Conversation', 'Antigravity')).toBe(false)
  })

  it('★★「Background tasks」是 Claude 那格面板的标牌 —— 不算话(日志上那句「Claude 回了:Background tasks」)', () => {
    expect(isNotTalk('Background tasks', 'Claude')).toBe(true)
    expect(isNotTalk('后台任务', 'Claude')).toBe(true)
    // 整行恰好是它才算。
    expect(isNotTalk('我把它挂到后台任务里跑了,大概十分钟', 'Claude')).toBe(false)
  })
})

/**
 * ─────────────────────────── 卡 GB(2026-09-27 下午,幽灵气泡)───────────────────────────
 *
 * 维护者 13:25:「现在是不是就有一些气泡会跑出来,一闪而过很诡异」;
 * 13:45:「你得关注我后面提的关于幽灵气泡……的部分,是否已经处理了」。
 *
 * 装上卡 BB + BB2 之后,13:33–13:47 的日志里仍有这些(全是界面字 / 面板标牌 / 状态条,一句话都不是它回的):
 * `Kimi 回了:工作区正在准备中`、`Kimi 回了:Beta`、`Kimi 开始跑了`、`Claude 回了:Bash 2m 09s`、
 * `Grok Bot 回了:Routines are recurring tasks this Bot ru…`、`Codex 回了:Edited 2 files+15-6`、
 * `Grok Bot 开始跑了`×3、`Manus 开始跑了`×2、`豆包办公 开始跑了`。
 *
 * **逐句补界面字追不完**(BB、BB2 已经补了两轮)。改成机制(统筹 13:5x 定):
 * 1. 窗口型的「在跑」**只认形式信号** —— 这一拍看得见停止键才算在跑;**内容变了不再算在跑**;
 *    「开始跑了」只在停止键从无到有那一拍冒,「回了」与蓝点只在停止键从有到无那一拍冒;
 * 2. **有文件型会话源的那几家**(Claude / Codex / Kimi:`/state.sessions` 那一路)窗口读法**只补标题**,
 *    不冒任何气泡、不改状态 —— 它们的在跑 / 做完以会话文件为准;
 * 3. 停止键认不出的家(没有停止键的 App)就**不显示在跑、也不冒气泡** —— 宁可少,不可假(D13)。
 */
describe('卡 GB:窗口型的「在跑」只认停止键,内容变了不再算在跑', () => {
  /** 日志上那两句 Grok Bot 的原话(那是它面板上的说明文字,谁也没回)。 */
  const routines = read({ title: 'Grok Bot', side: [], tail: [
    { t: '把这条 routine 关掉', x: 700, y: 160, w: 300, h: 20 },
    { t: 'Routines are recurring tasks this Bot runs for you', x: 400, y: 240, w: 600, h: 40 },
  ] })
  const routinesMore = read({ title: 'Grok Bot', side: [], tail: [
    { t: '把这条 routine 关掉', x: 700, y: 160, w: 300, h: 20 },
    { t: 'Routines are recurring tasks this Bot runs for you every day', x: 400, y: 240, w: 600, h: 40 },
  ] })
  const stop = [{ x: 1100, y: 720, w: 30, h: 30 }]

  it('★★内容变了、没有停止键:不算在跑、不冒「开始跑了」(日志上 Grok Bot / Manus / 豆包办公那几句就是这么来的)', () => {
    const one = nextWindowState(undefined, summarizeRead(routines, 'Grok Bot'), { now: t0, active: false, name: 'Grok Bot' })
    const two = nextWindowState(one.state, summarizeRead(routinesMore, 'Grok Bot'), { now: at(10), active: false, name: 'Grok Bot' })
    expect(two.state.status).toBe('idle')
    expect(two.bubble).toBeUndefined()
    // 内容确实变了(「最近在做什么」照旧按它算)—— 变了只是变了,不等于在跑。
    expect(two.state.changed_at).toBe(at(10).toISOString())
  })

  it('★★内容变完又不变了:不冒「回了」、不记蓝点(`Grok Bot 回了:Routines are recurring tasks…`不该再有)', () => {
    const one = nextWindowState(undefined, summarizeRead(routines, 'Grok Bot'), { now: t0, active: false, name: 'Grok Bot' })
    const two = nextWindowState(one.state, summarizeRead(routinesMore, 'Grok Bot'), { now: at(10), active: false, name: 'Grok Bot' })
    const three = nextWindowState(two.state, summarizeRead(routinesMore, 'Grok Bot'), { now: at(40), active: false, name: 'Grok Bot' })
    expect(three.bubble).toBeUndefined()
    expect(three.state.unread).toBe(false)
    expect(three.state.status).toBe('idle')
  })

  it('★★停止键从无到有那一拍才冒「开始跑了」', () => {
    const one = nextWindowState(undefined, summarizeRead(read(), 'Foo AI'), { now: t0, active: false, name: 'Foo AI' })
    const busy = nextWindowState(one.state, summarizeRead(read({ stop }), 'Foo AI'), { now: at(10), active: false, name: 'Foo AI' })
    expect(busy.state.status).toBe('running')
    expect(busy.bubble).toMatchObject({ kind: 'started', text: 'Foo AI 开始跑了' })
    // 停止键还在的那几拍不再冒第二次。
    const still = nextWindowState(busy.state, summarizeRead(read({ stop }), 'Foo AI'), { now: at(25), active: false, name: 'Foo AI' })
    expect(still.bubble).toBeUndefined()
  })

  it('★★停止键从有到无那一拍才冒「回了:…」+ 蓝点', () => {
    const one = nextWindowState(undefined, summarizeRead(read({ stop }), 'Foo AI'), { now: t0, active: false, name: 'Foo AI' })
    const answer = read({ tail: [
      { t: '帮我写一份周报', x: 700, y: 200, w: 300, h: 20 },
      { t: '周报写好了,一共三段。', x: 400, y: 420, w: 600, h: 40 },
    ] })
    const done = nextWindowState(one.state, summarizeRead(answer, 'Foo AI'), { now: at(20), active: false, name: 'Foo AI' })
    expect(done.state.status).toBe('idle')
    expect(done.bubble).toMatchObject({ kind: 'replied', text: 'Foo AI 回了:周报写好了,一共三段。' })
    expect(done.state.unread).toBe(true)
    // 再往后几拍不重复冒。
    const again = nextWindowState(done.state, summarizeRead(answer, 'Foo AI'), { now: at(50), active: false, name: 'Foo AI' })
    expect(again.bubble).toBeUndefined()
  })

  it('★停止键没了、可最后一句是界面字:一个气泡都不冒(latest 缺席 = 没有它说的话)', () => {
    const one = nextWindowState(undefined, summarizeRead(read({ title: 'ChatGPT', side: [], stop }), 'Codex', ['ChatGPT']), { now: t0, active: false, name: 'Codex' })
    const chrome = read({ title: 'ChatGPT', side: [], tail: [
      { t: 'Thursday 20:17', x: 400, y: 260, w: 200, h: 20 },
      { t: 'Context automatically compacting', x: 400, y: 300, w: 400, h: 20 },
    ] })
    const done = nextWindowState(one.state, summarizeRead(chrome, 'Codex', ['ChatGPT']), { now: at(20), active: false, name: 'Codex' })
    expect(done.bubble).toBeUndefined()
    expect(done.state.unread).toBe(false)
  })

  it('★停止键没了、可这扇窗上还没有一来一回(只读到一段话):不冒(`Kimi 回了:Beta`不该再有)', () => {
    const only = (t: string) => read({ title: 'Kimi', side: [], tail: [{ t, x: 400, y: 300, w: 600, h: 40 }] })
    const one = nextWindowState(undefined, summarizeRead(only('Beta', ), 'Kimi'), { now: t0, active: false, name: 'Kimi' })
    const busy = nextWindowState(one.state, summarizeRead(read({ title: 'Kimi', side: [], stop, tail: [{ t: 'Beta', x: 400, y: 300, w: 600, h: 40 }] }), 'Kimi'), { now: at(10), active: false, name: 'Kimi' })
    expect(busy.state.status).toBe('running')
    const done = nextWindowState(busy.state, summarizeRead(only('工作区正在准备中'), 'Kimi'), { now: at(20), active: false, name: 'Kimi' })
    expect(done.bubble).toBeUndefined()
    expect(done.state.unread).toBe(false)
  })

  it('★★停止键认不出的那一家(窗上从来没有停止键):从头到尾不显示在跑、一个气泡都没有 —— 宁可少,不可假', () => {
    let state = nextWindowState(undefined, summarizeRead(routines, 'Grok Bot'), { now: t0, active: false, name: 'Grok Bot' }).state
    for (const [sec, t] of [[15, '第一版给你了'], [30, '第一版给你了,再改一句'], [45, '第二版好了'], [90, '第二版好了']] as const) {
      const tick = nextWindowState(state, summarizeRead(read({ title: 'Grok Bot', side: [], tail: [
        { t: '帮我改一版', x: 700, y: 160, w: 300, h: 20 },
        { t, x: 400, y: 240, w: 600, h: 40 },
      ] }), 'Grok Bot'), { now: at(sec), active: false, name: 'Grok Bot' })
      expect(tick.state.status, `${sec}s`).toBe('idle')
      expect(tick.bubble, `${sec}s`).toBeUndefined()
      state = tick.state
    }
    expect(state.unread).toBe(false)
  })
})

describe('卡 GB:有文件型会话源的那几家,窗口读法只补标题', () => {
  const stop = [{ x: 1100, y: 720, w: 30, h: 30 }]

  it('★★Claude / Codex / Kimi(有 `/state.sessions` 那一路)= 只补标题;别的几家照旧按窗口判', () => {
    expect(windowTitleOnly('com.anthropic.claudefordesktop')).toBe(true)
    expect(windowTitleOnly('com.openai.codex')).toBe(true)
    expect(windowTitleOnly('com.moonshot.kimichat')).toBe(true)
    expect(windowTitleOnly('com.meta.endo')).toBe(false)
    expect(windowTitleOnly('im.manus.desktop')).toBe(false)
    expect(windowTitleOnly('com.bot.pc.doubao')).toBe(false)
    // 运行时新发现的那一家(Grok Bot / Antigravity)没有专门读法 —— 照旧按窗口判。
    expect(windowTitleOnly('com.anysphere.sand')).toBe(false)
    expect(windowTitleOnly('com.google.antigravity')).toBe(false)
  })

  it('★★只补标题那几家:标题与最新一句照读,状态说不清、一个气泡都不冒(`Codex 回了:Edited 2 files+15-6`不该再有)', () => {
    const edited = read({ title: 'ChatGPT', side: [
      { t: '制作参赛网页', sel: true, x: 20, y: 110, w: 260, h: 30 },
    ], tail: [
      { t: '把那两处改一下', x: 700, y: 160, w: 300, h: 20 },
      { t: 'Edited 2 files+15-6', x: 400, y: 240, w: 600, h: 40 },
    ] })
    const one = nextWindowState(undefined, summarizeRead(read({ title: 'ChatGPT', side: [{ t: '制作参赛网页', sel: true, x: 20, y: 110, w: 260, h: 30 }], stop }), 'Codex', ['ChatGPT']), { now: t0, active: false, name: 'Codex', titleOnly: true })
    // 停止键就在那儿也不算在跑:这一家的在跑以它的会话文件为准。
    expect(one.state.status).toBe('unknown')
    const done = nextWindowState(one.state, summarizeRead(edited, 'Codex', ['ChatGPT']), { now: at(20), active: false, name: 'Codex', titleOnly: true })
    expect(done.bubble).toBeUndefined()
    expect(done.state.status).toBe('unknown')
    expect(done.state.unread).toBe(false)
    // 标题(与最新一句)照旧补上 —— 登记表上那一家缺标题时退回读窗口读到的就是它。
    expect(done.state.title).toBe('制作参赛网页')
    expect(done.state.latest).toBe('Edited 2 files+15-6')
    // 为什么说不清,说人话(设置里那一行、卡上的缺口都读它)。
    expect(done.state.gaps.status).toContain('会话')
  })

  it('★只补标题那几家:上一拍存着的蓝点也灭掉(那是老判法记下的)', () => {
    const prev = stored({ status: 'idle', unread: true, latest: 'Bash 2m 09s' })
    const next = nextWindowState(prev, summarizeRead(read({ title: 'Claude', side: [] }), 'Claude'), { now: at(20), active: false, name: 'Claude', titleOnly: true })
    expect(next.state.unread).toBe(false)
    expect(next.bubble).toBeUndefined()
  })
})

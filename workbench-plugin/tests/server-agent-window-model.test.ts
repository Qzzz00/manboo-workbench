// @vitest-environment node
/**
 * 通用的窗口读法里下判断的那一半(卡 Q,`server/agentWindowModel.ts`):状态、标题、最新一句、气泡。
 * 壳读回来的样子与 workbench-app/Sources/AgentWindow.swift 的 `agent_read` 逐字段一致(相对窗口左上角的矩形)。
 */
import { describe, expect, it } from 'vitest'
import type { WindowAgentState } from '../src/server/agentWindowModel.ts'
import {
  LATEST_MAX, conversationTitles, isChromeLine, isNotTalk, isSideControl, nextWindowState, parseRead, summarizeRead, titleFromWindow,
} from '../src/server/agentWindowModel.ts'

function read(over: Record<string, unknown> = {}) {
  return parseRead({
    running: true, windows: 1, window: { w: 1200, h: 800 }, title: 'Foo AI', active: false,
    input: { x: 380, y: 700, w: 760, h: 60 },
    sidebar: { x: 0, y: 0, w: 300, h: 800 },
    stop: [],
    tail: [
      { t: '帮我写一份周报', x: 700, y: 200, w: 300, h: 20 },
      { t: '好的,这是本周周报的草稿:一、完成了登记表;二、……', x: 400, y: 300, w: 600, h: 60 },
      { t: '复制', x: 400, y: 370, w: 30, h: 20, ctl: true },
      { t: '10:42', x: 400, y: 390, w: 40, h: 16 },
      { t: 'Foo AI can make mistakes. Check important info.', x: 400, y: 770, w: 400, h: 16 },
    ],
    side: [
      { t: '今天', x: 20, y: 80, w: 200, h: 20 },
      { t: '周报怎么写', sel: true, x: 20, y: 110, w: 260, h: 30 },
      { t: '旅行计划', x: 20, y: 150, w: 260, h: 30 },
      { t: '新对话', x: 20, y: 40, w: 260, h: 30 },
    ],
    ...over,
  })
}

describe('summarizeRead:读一次 → 四样', () => {
  it('标题 = 侧栏里选中的那一条;最新一句 = 对话区最后一行不是界面字的;侧栏标题去掉分组与导航', () => {
    const summary = summarizeRead(read(), 'Foo AI')
    expect(summary.ok).toBe(true)
    expect(summary.busy).toBe(false)
    expect(summary.title).toBe('周报怎么写')
    expect(summary.latest).toBe('好的,这是本周周报的草稿:一、完成了登记表;二、……')
    expect(summary.titles).toEqual(['周报怎么写', '旅行计划'])
    expect(summary.gaps).toEqual({})
    expect(summary.signature).toMatch(/^[0-9a-f]{8}$/)
  })

  it('「停止」键在对话区 / 输入区 = 在跑;侧栏里挂着的「停止」不算(那是别的会话)', () => {
    expect(summarizeRead(read({ stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI').busy).toBe(true)
    expect(summarizeRead(read({ stop: [{ x: 30, y: 300, w: 80, h: 20 }] }), 'Foo AI').busy).toBe(false)
    // 认不出侧栏时不按位置猜:哪里的停止键都算。
    expect(summarizeRead(read({ sidebar: undefined, stop: [{ x: 30, y: 300, w: 80, h: 20 }] }), 'Foo AI').busy).toBe(true)
  })

  it('没有选中的一条就用窗口标题(去掉 App 名);窗口标题就是 App 名时明说认不出', () => {
    const noSel = read({ side: [{ t: '旅行计划', x: 20, y: 150, w: 260, h: 30 }], title: 'Foo AI — 周报怎么写' })
    expect(summarizeRead(noSel, 'Foo AI').title).toBe('周报怎么写')
    const bare = summarizeRead(read({ side: [], title: 'Foo AI' }), 'Foo AI')
    expect(bare.title).toBeUndefined()
    expect(bare.gaps.title).toContain('认不出 Foo AI 当前那条对话的标题')
  })

  it('读屏播报「Response complete: …」取出里面那段回答;最新一句截断', () => {
    const long = '很'.repeat(300)
    const summary = summarizeRead(read({ tail: [{ t: `Response complete: ${long}`, x: 400, y: 300, w: 600, h: 60 }] }), 'Foo AI')
    expect([...(summary.latest ?? '')].length).toBe(LATEST_MAX + 1)
    expect(summary.latest?.endsWith('…')).toBe(true)
    expect(summary.latest?.startsWith('很很')).toBe(true)
  })

  it('★一句话画成好几块(加粗、行内代码、换行各一块):拼成一段再取最新一句;对话区里靠左的一小块不当侧栏丢掉', () => {
    const summary = summarizeRead(read({ tail: [
      { t: '帮我算一下', x: 800, y: 200, w: 200, h: 20 },
      { t: '一天有', x: 400, y: 300, w: 60, h: 20 },
      { t: '24', x: 460, y: 300, w: 20, h: 20 },
      { t: '个小时,', x: 480, y: 300, w: 60, h: 20 },
      { t: '也就是 1440 分钟。', x: 400, y: 322, w: 160, h: 20 },
      { t: 'Copy', x: 400, y: 350, w: 30, h: 20, ctl: true },
    ] }), 'Foo AI')
    expect(summary.latest).toBe('一天有24个小时,也就是 1440 分钟。')
  })

  it('对话区里没字(新开的空对话):明说,不编', () => {
    const summary = summarizeRead(read({ tail: [] }), 'Foo AI')
    expect(summary.latest).toBeUndefined()
    expect(summary.gaps.latest).toContain('没读到字')
  })

  it('没开 / 没窗口 / 辅助功能读不到:四样都说清为什么', () => {
    expect(summarizeRead(parseRead({ running: false }), 'Foo AI').gaps.status).toBe('Foo AI 没开')
    expect(summarizeRead(parseRead({ running: true, windows: 0 }), 'Foo AI').gaps.title).toContain('一扇窗都没有')
    expect(summarizeRead(parseRead({ running: true, windows: 0, ax_err: -25204 }), 'Foo AI').gaps.latest).toContain('-25204')
  })

  it('界面字认得出:时间、复制、Thinking、免责声明;正常的一句话不算', () => {
    for (const line of ['10:42', '下午 3:05', '复制', 'Copy', 'Thinking', 'Worked for 19s', '已深度思考(用时 12 秒)', 'AI can make mistakes', '内容由 AI 生成']) {
      expect(isChromeLine(line), line).toBe(true)
    }
    for (const line of ['一年有四个季节。', 'Copy the file to the repo.', '好']) {
      expect(isChromeLine(line), line).toBe(line === '好')
    }
    expect(titleFromWindow('ChatGPT - 一年有几个季节', 'ChatGPT')).toBe('一年有几个季节')
  })
})

describe('nextWindowState:前后两次 → 状态与气泡', () => {
  const t0 = new Date('2026-09-25T10:00:00Z')
  const at = (sec: number) => new Date(t0.getTime() + sec * 1000)
  const first = nextWindowState(undefined, summarizeRead(read(), 'Foo AI'), { now: t0, active: false, name: 'Foo AI' })

  it('第一次读不冒气泡(变没变说不清)', () => {
    expect(first.bubble).toBeUndefined()
    expect(first.state.status).toBe('idle')
    expect(first.state.unread).toBe(false)
  })

  /*
   * **卡 GB(2026-09-27)改了这一条的口径**:原来「停止键没了、可这一拍字还在变」要再等一拍才算说完
   * (那一拍按 `changed && recent` 算在跑)。现在在跑只认停止键 —— **停止键一没了那一拍就是「回了」**。
   */
  it('开始跑 → 「X 开始跑了」;停止键没了那一拍 → 「X 回了:…」并记成没看过', () => {
    const running = nextWindowState(first.state, summarizeRead(read({ stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(60), active: false, name: 'Foo AI' })
    expect(running.state.status).toBe('running')
    expect(running.bubble).toMatchObject({ kind: 'started', text: 'Foo AI 开始跑了' })
    // 一来一回:他问的那一句 + 它答的那一句。两段都在 —— 卡 ST 起气泡也要过这一道(见下面 Manus 那一条)。
    const asked = { t: '帮我写一份周报', x: 700, y: 200, w: 300, h: 20 }
    const answer = { t: '周报写好了,一共三段。', x: 400, y: 420, w: 600, h: 40 }
    const done = nextWindowState(running.state, summarizeRead(read({ tail: [asked, answer] }), 'Foo AI'), { now: at(65), active: false, name: 'Foo AI' })
    expect(done.state.status).toBe('idle')
    expect(done.bubble).toMatchObject({ kind: 'replied', text: 'Foo AI 回了:周报写好了,一共三段。' })
    expect(done.state.unread).toBe(true)
    // 再读几拍:同一句不重复冒。
    const again = nextWindowState(done.state, summarizeRead(read({ tail: [asked, answer] }), 'Foo AI'), { now: at(70), active: false, name: 'Foo AI' })
    expect(again.bubble).toBeUndefined()
  })

  /*
   * **卡 GB 把这一条翻过来了**(原来:「没看到停止键,但隔几秒两次读到的内容不一样 = 还在出字」)。
   * 维护者 13:25:「现在是不是就有一些气泡会跑出来,一闪而过很诡异」—— 窗上的字会变的缘由太多
   * (面板标牌、额度行、状态条、滚动、他自己翻页),拿「变了」当「在跑」就是幽灵气泡的出处。
   */
  it('★没看到停止键、只是字变了:不算在跑、不冒气泡(「最近在做什么」的时刻照旧跟着走)', () => {
    const grow = nextWindowState(first.state, summarizeRead(read({ tail: [{ t: '周报写', x: 400, y: 300, w: 600, h: 60 }] }), 'Foo AI'), { now: at(4), active: false, name: 'Foo AI' })
    expect(grow.state.status).toBe('idle')
    expect(grow.bubble).toBeUndefined()
    expect(grow.state.changed_at).toBe(at(4).toISOString())
  })

  /* **卡 GB 把这一条翻过来了**(原来:「内容变了就冒『回了』」)—— 这就是那条已知代价,写在交接里。 */
  it('★两次读之间它已经答完了、一次都没赶上看见停止键:这一回不冒(宁可少,不可假)', () => {
    const later = nextWindowState(first.state, summarizeRead(read({ tail: [{ t: '再帮我改一版', x: 700, y: 200, w: 300, h: 20 }, { t: '新的回答', x: 400, y: 300, w: 600, h: 60 }] }), 'Foo AI'), { now: at(300), active: false, name: 'Foo AI' })
    expect(later.state.status).toBe('idle')
    expect(later.bubble).toBeUndefined()
    expect(later.state.unread).toBe(false)
  })

  it('★他正看着那个 App(在前台)时不冒气泡,也不记没看过', () => {
    const seen = nextWindowState(first.state, summarizeRead(read({ stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(60), active: true, name: 'Foo AI' })
    expect(seen.bubble).toBeUndefined()
    expect(seen.state.unread).toBe(false)
  })

  it('读不到窗口:四样沿用上一次读到的,状态说不清', () => {
    const lost = nextWindowState(first.state, summarizeRead(parseRead({ running: true, windows: 0 }), 'Foo AI'), { now: at(60), active: false, name: 'Foo AI' })
    expect(lost.state.status).toBe('unknown')
    expect(lost.state.title).toBe('周报怎么写')
    expect(lost.state.at).toBe(first.state.at)
  })

  /**
   * 「最新那句是它刚说完的回话」(2026-09-26,卡 WS)。判「在等你」只判它刚说完的那句 ——
   * 他自己在那扇窗里说的话不该被判成「它在问你」。
   */
  describe('answered:最新那句是它刚说完的回话吗', () => {
    /**
     * 一来一回:他问的那一句 + 它答的那一句。**两段都得在** —— 只读到一段话的那扇窗是
     * 开场白 / 空对话(见下面 Manus 那一条),不算「它刚答完」。
     */
    const exchange = (reply: string, over: Record<string, unknown> = {}) => read({
      tail: [
        { t: '帮我查一下这条报错', x: 700, y: 200, w: 300, h: 20 },
        { t: reply, x: 400, y: 420, w: 600, h: 40 },
      ],
      ...over,
    })

    it('第一次读不算(变没变说不清,同气泡那条)', () => {
      expect(first.state.answered).toBeUndefined()
    })

    it('★在跑的那一拍一定不算(它正在出字,那句话是半截旁白)', () => {
      const running = nextWindowState(first.state, summarizeRead(read({ stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(60), active: false, name: 'Foo AI' })
      expect(running.state.status).toBe('running')
      expect(running.state.answered).toBeUndefined()
    })

    it('★跑完了那一拍算;内容没再变时一直算着(每一拍都要判得出同一个结论)', () => {
      const asking = exchange('两个方案你选哪个?回个数字就行')
      const running = nextWindowState(first.state, summarizeRead(read({ stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(60), active: false, name: 'Foo AI' })
      const settling = nextWindowState(running.state, summarizeRead(asking, 'Foo AI'), { now: at(65), active: false, name: 'Foo AI' })
      const done = nextWindowState(settling.state, summarizeRead(asking, 'Foo AI'), { now: at(70), active: false, name: 'Foo AI' })
      expect(done.state.answered).toBe(true)
      // 又读一拍、什么都没变:照旧算(否则那一问会一拍在、一拍不在)。
      const again = nextWindowState(done.state, summarizeRead(asking, 'Foo AI'), { now: at(120), active: false, name: 'Foo AI' })
      expect(again.state.answered).toBe(true)
    })

    /* 卡 GB 起,这一格也只认停止键那一对转折 —— 夹具里先让它真跑一拍(原来靠内容变了)。 */
    it('★★他正看着那扇窗时照记:气泡不冒、没看过不记,但「它刚答完」是事实 —— 判「在等你」要的是这个', () => {
      const busy = nextWindowState(first.state, summarizeRead(exchange('这版能不能先合?', { stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(280), active: false, name: 'Foo AI' })
      const seen = nextWindowState(busy.state, summarizeRead(exchange('这版能不能先合?'), 'Foo AI'), { now: at(300), active: true, name: 'Foo AI' })
      expect(seen.bubble).toBeUndefined()
      expect(seen.state.unread).toBe(false)
      expect(seen.state.answered).toBe(true)
    })

    it('★它又跑起来 → 这一格翻掉(那一问跟着撤)', () => {
      const busy0 = nextWindowState(first.state, summarizeRead(exchange('要不要我顺手把旧的删了?', { stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(280), active: false, name: 'Foo AI' })
      const asked = nextWindowState(busy0.state, summarizeRead(exchange('要不要我顺手把旧的删了?'), 'Foo AI'), { now: at(300), active: false, name: 'Foo AI' })
      expect(asked.state.answered).toBe(true)
      const busy = nextWindowState(asked.state, summarizeRead(exchange('要不要我顺手把旧的删了?', { stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(320), active: false, name: 'Foo AI' })
      expect(busy.state.answered).toBeUndefined()
    })

    it('★★这扇窗里还没有一来一回(只读到一段话)→ 不算:真机 09-26 Manus 那扇新窗上只有一句「What can I do for you?」', () => {
      const greeting = { t: 'What can I do for you?', x: 400, y: 300, w: 600, h: 40 }
      const empty = read({ tail: [greeting], side: [] })
      const firstLook = nextWindowState(undefined, summarizeRead(empty, 'Foo AI'), { now: t0, active: false, name: 'Foo AI' })
      // 他开了一条新对话:内容变了、又不在跑 —— 老判据会说「它刚答完」,而它谁也没在问。
      const opened = nextWindowState(firstLook.state, summarizeRead(read({ tail: [{ ...greeting, t: 'What can I do for you today?' }], side: [] }), 'Foo AI'), { now: at(60), active: false, name: 'Foo AI' })
      expect(summarizeRead(empty, 'Foo AI').lines).toBe(1)
      expect(opened.state.answered).toBeUndefined()
      /*
       * 气泡这一档 2026-09-26 **由卡 ST 收紧**(卡 WS 原来写的是「气泡照旧,那是卡 Q 定的」)。
       * 维护者 19:45:「一堆蓝色气泡,我点过了也不消失,是在做什么测试吗」—— 18:50 生产上五家全是蓝 1,
       * 气泡原话是额度页的字、窗口标题、App 标牌。一扇还没有一来一回的窗照样会一路冒「X 回了:…」
       * 并记成未读,他点掉下一拍又亮。所以气泡与 `answered` 现在同一道闸。
       */
      expect(opened.bubble).toBeUndefined()
      expect(opened.state.unread).toBe(false)
    })

    it('读不到窗口这一拍:沿用上一次(这一拍什么都没看见,不该把上一拍的事实抹掉)', () => {
      const busy0 = nextWindowState(first.state, summarizeRead(exchange('你选哪个?', { stop: [{ x: 1100, y: 720, w: 30, h: 30 }] }), 'Foo AI'), { now: at(280), active: false, name: 'Foo AI' })
      const asked = nextWindowState(busy0.state, summarizeRead(exchange('你选哪个?'), 'Foo AI'), { now: at(300), active: false, name: 'Foo AI' })
      const lost = nextWindowState(asked.state, summarizeRead(parseRead({ running: true, windows: 0 }), 'Foo AI'), { now: at(360), active: false, name: 'Foo AI' })
      expect(lost.state.status).toBe('unknown')
      expect(lost.state.answered).toBe(true)
    })
  })

  it('★只存需要的:标题、最新一句(截断)、时间、状态、侧栏标题 —— 没有整段对话', () => {
    const keys = Object.keys(first.state).sort()
    // `seen` = 侧栏里每条对话上次被选中时的样子(卡 ST;只有时刻、在不在跑、最后一句那一截)。
    // `sigs` = 最近几拍的指纹(卡 BB;判「来回晃」用,只有哈希、不含内容)。
    // `psigs` = 这一拍每一段各自的指纹(卡 BB2;判「整页换掉」用,同样只有哈希)。
    expect(keys).toEqual(['at', 'changed_at', 'gaps', 'latest', 'psigs', 'seen', 'signature', 'sigs', 'since', 'status', 'title', 'titles', 'unread'])
    // 段数只是个数(判「这扇窗里还没有一来一回」用),不落到存下来的那一份里。
    expect(keys).not.toContain('lines')
    const state: WindowAgentState = first.state
    expect(JSON.stringify(state)).not.toContain('帮我写一份周报')
  })
})

/**
 * ───────── 卡 ST(2026-09-26):侧栏里哪几行是对话、什么才算「它回了一句」 ─────────
 * 下面两组用的字全是 09-26 从生产 `/state` 与壳探针只读量来的**真原话**。
 */
describe('侧栏那几行哪几行是对话(卡 ST,真机 09-26 19:10)', () => {
  it('★界面字、分区入口、快捷键、播报、时间、升级条全剔掉;对话名一条不少', () => {
    // 左边这一堆是真机上混在 `titles` 里的界面字(维护者 19:10:「我发的任务大部分没变成卡片」的另一半 ——
    // 不剔掉,台上会摆出一张叫「Marketplace」的卡)。右边这一堆是他真发过的事。
    const chrome = [
      'Toggle compact sidebar', 'Marketplace', 'Update — a new version is available',
      'Grok Bot asked: 看完后想怎么用?', 'Conversation History', 'Scheduled Tasks', 'Conversations',
      'Pin conversation', 'Archive conversation', 'Stop execution', 'now', 'Quick chat', 'Pull requests',
      'Scheduled', 'Plugins', 'Projects', 'Settings', 'New', 'Agent', 'Skills', '⌘⇧O',
      '返回', '收起导航', '账号与安全', '通知', '新建任务', '看板', '插件', '定时任务', '在资源库中显示', '新旁聊',
    ]
    const talks = [
      'Initiating A New Conversation', '主要聊天', '旁聊', '完成 Pen.dev 安装',
      'Claude Opus5.5 周额度消耗过快', '询问 Grok4.7 桌面客户端', '把虚拟形象改为鲸鱼',
      '调研宝可梦日蚀', '检测树莓派连接', '检测小米X08A智慧屏连接', '设计未来实验室文字Logo',
    ]
    expect(conversationTitles([...chrome, ...talks])).toEqual(talks)
    /**
     * 「新旁聊」**一个人待着也算按钮**(2026-09-28,卡 WR 改了这一条)。
     * 卡 ST 那会儿只在「旁聊」也在同一份侧栏里时才认(不猜断句),代价是统筹 09-28 早真机上
     * 豆包办公的「新工作任务」、Muse 的「New side chat」都被当成了对话。现在多一路:
     * 「新」后面剩下的那一截**本来就是一段对话的通名**时算按钮(见 `GENERIC_CHAT_NOUN`)。
     */
    expect(conversationTitles(['新旁聊'])).toEqual([])
  })

  /** ───────── 卡 WR(2026-09-28):统筹真机上还漏进来的五种界面字 ───────── */
  it('★统筹 09-28 早真机漏进来的伪对话:新建键、一排标签、分组标题、无冒号播报', () => {
    // 这五条是统筹 09-28 早从 `/state.agent_registry` 里逐字抄下来的。
    expect(conversationTitles([
      '新工作任务', '连接器 · 技能 · 伙伴', 'Side chats', 'New side chat', 'Grok Bot replied',
    ])).toEqual([])
    // 同一份侧栏里他真的那几条对话一条不少(单数的「Main chat」不是分组标题)。
    expect(conversationTitles([
      'Main chat', 'Token Factory', 'Cassetta', 'DramaWise', 'Initiating A New Conversation', '人类与AI',
    ])).toEqual(['Main chat', 'Token Factory', 'Cassetta', 'DramaWise', 'Initiating A New Conversation', '人类与AI'])
  })

  /**
   * 统筹 09-28 10:07 真机:「登记表把 Manus 的 Projects 当成对话」——
   * Manus 侧栏两段:`Projects` 底下是项目文件夹,`Tasks` 底下才是一条条对话。
   */
  it('★分组标题管着它底下那几行:Projects 底下的项目文件夹不是对话,Tasks 底下的才是', () => {
    const summary = summarizeRead(read({
      title: 'Manus',
      side: [
        { t: 'Projects', x: 20, y: 80, w: 200, h: 20 },
        { t: 'Token Factory', x: 20, y: 110, w: 260, h: 28 },
        { t: 'Cassetta', x: 20, y: 140, w: 260, h: 28 },
        { t: 'DramaWise', x: 20, y: 170, w: 260, h: 28 },
        { t: 'Tasks', x: 20, y: 210, w: 200, h: 20 },
        { t: '派活测试任务管理', sel: true, x: 20, y: 240, w: 260, h: 28 },
        { t: '查询中秋节农历日期', x: 20, y: 270, w: 260, h: 28 },
      ],
    }), 'Manus')
    expect(summary.titles).toEqual(['派活测试任务管理', '查询中秋节农历日期'])
    expect(summary.title).toBe('派活测试任务管理')
  })

  it('★认不出是哪种分组就全留(多数家的侧栏没有分组标题):一条都不许因为这条丢掉', () => {
    const summary = summarizeRead(read({
      title: 'Foo AI',
      side: [
        { t: '做一版参赛网页', x: 20, y: 110, w: 260, h: 28 },
        { t: '检测树莓派连接', x: 20, y: 140, w: 260, h: 28 },
      ],
    }), 'Foo AI')
    expect(summary.titles).toEqual(['做一版参赛网页', '检测树莓派连接'])
  })

  it('★这几条只认形状、不写死品牌:像它的真话一条都不许被剔', () => {
    // 一排标签那一条要 3 段以上、每段都短:他真的对话名切不成这样。
    expect(isSideControl('连接器 · 技能 · 伙伴')).toBe(true)
    expect(isSideControl('参赛网页 · 首屏改版')).toBe(false)
    expect(isSideControl('做个 PDF 导出 / 顺手把标题也改了')).toBe(false)
    // 无冒号播报那一条要恰好收在播报动词上。
    expect(isSideControl('Grok Bot replied')).toBe(true)
    expect(isSideControl('Grok Bot replied 的那条我还没看')).toBe(false)
    // 「新 X」那一路只认通名。
    expect(conversationTitles(['新的运营方案', 'New pricing page'])).toEqual(['新的运营方案', 'New pricing page'])
  })

  it('★动作那两条只对短行生效:对话名常常也是动宾短语,不能按开头那个动词一律剔', () => {
    expect(isSideControl('收起导航')).toBe(true)
    expect(isSideControl('在资源库中显示')).toBe(true)
    // 他真发过的事(中文长句、英文长句)一条都不许被当成按钮。
    expect(isSideControl('检测小米X08A智慧屏连接')).toBe(false)
    expect(isSideControl('把虚拟形象改为鲸鱼')).toBe(false)
    expect(isSideControl('Initiating A New Conversation')).toBe(false)
  })
})

describe('什么才算「它回了一句」(卡 ST,维护者 19:45「一堆蓝色气泡,我点过了也不消失」)', () => {
  /** 真机 09-26 18:50 那几句蓝气泡的原文,喂回读窗口那一路。 */
  const usage = { t: 'Code 0% 09-25 17:21 后重置', x: 400, y: 300, w: 300, h: 20 }
  const label = { t: 'Codex App', x: 400, y: 340, w: 200, h: 20 }

  it('★额度页的字与 App 标牌不算它说的话:不进最新一句,也不进指纹', () => {
    const summary = summarizeRead(read({ title: 'Codex', side: [], tail: [usage, label] }), 'Codex')
    expect(summary.ok).toBe(true)
    // 以前这里是「Codex 回了:Codex App」「Kimi 回了:Code 0% 09-25 17:21 后重置」。
    expect(summary.latest).toBeUndefined()
    expect(summary.signature).toBeUndefined()
    expect(summary.lines).toBe(0)
  })

  it('★整格就是一个百分比(真机 Grok Bot 22:11「5%」)也不算它说的话(卡 QG)', () => {
    // 那是它 Usage & Billing 页上右边那一格,额度面板正照它算已用 5%;
    // 以前 isUsageLine 要「数字 + 用量那类词」同行才算,单独一个「5%」不认,于是漏进了对话:
    // 生产 `/state.agent_registry` 上 Grok Bot 那条的 latest 就是「5%」。
    const bare = { t: '5%', x: 1205, y: 280, w: 40, h: 20 }
    const summary = summarizeRead(read({ title: 'Grok Bot', side: [], tail: [bare] }), 'Grok Bot')
    expect(summary.latest).toBeUndefined()
    expect(summary.signature).toBeUndefined()
    expect(summary.lines).toBe(0)
    // 「3/5」那种分数写法同理;真话(里头带数的一句)不受影响。
    const talk = { t: '我按 5% 的折扣算了一遍,你看行不行', x: 400, y: 300, w: 600, h: 20 }
    expect(summarizeRead(read({ title: 'Grok Bot', side: [], tail: [talk] }), 'Grok Bot').lines).toBe(1)
  })

  it('★只有额度那几个数字变了 → 指纹不变 → 不冒「回了」、不记未读', () => {
    const talk = { t: '这是本周的三条结论,你看一下要不要照着做。', x: 400, y: 260, w: 600, h: 40 }
    const before = summarizeRead(read({ title: 'Kimi', side: [], tail: [talk, usage] }), 'Kimi')
    const after = summarizeRead(read({ title: 'Kimi', side: [], tail: [talk, { ...usage, t: 'Code 7% 09-26 18:50 后重置' }] }), 'Kimi')
    expect(after.signature).toBe(before.signature)
    const prev: WindowAgentState = { status: 'idle', since: '', titles: [], at: '2026-09-26T10:40:00.000Z', unread: false, gaps: {}, ...(before.signature === undefined ? {} : { signature: before.signature }) }
    const next = nextWindowState(prev, after, { now: new Date('2026-09-26T10:50:00.000Z'), active: false, name: 'Kimi' })
    expect(next.bubble).toBeUndefined()
    expect(next.state.unread).toBe(false)
  })

  it('★这扇窗里还没有一来一回(只读到一段话):不冒「回了」、不记未读', () => {
    // 真机 Manus 那扇新窗上只有一句开场白「What can I do for you?」。
    const summary = summarizeRead(read({ title: 'Manus', side: [], tail: [{ t: 'What can I do for you?', x: 400, y: 300, w: 300, h: 20 }] }), 'Manus')
    expect(summary.lines).toBe(1)
    const prev: WindowAgentState = { status: 'running', since: '', titles: [], at: '2026-09-26T10:40:00.000Z', unread: false, gaps: {} }
    const next = nextWindowState(prev, summary, { now: new Date('2026-09-26T10:50:00.000Z'), active: false, name: 'Manus' })
    expect(next.bubble).toBeUndefined()
    expect(next.state.unread).toBe(false)
  })

  it('★真有一来一回、它刚答完:照旧冒「回了」并记成未读(这一档没被收窄掉)', () => {
    const summary = summarizeRead(read(), 'Foo AI')
    expect(summary.lines).toBe(2)
    const prev: WindowAgentState = { status: 'running', since: '', titles: [], at: '2026-09-26T10:40:00.000Z', unread: false, gaps: {} }
    const next = nextWindowState(prev, summary, { now: new Date('2026-09-26T10:50:00.000Z'), active: false, name: 'Foo AI' })
    expect(next.bubble?.kind).toBe('replied')
    expect(next.state.unread).toBe(true)
  })

  it('★侧栏里每条对话上次被选中时的样子记着(别的对话卡上那句就是它)', () => {
    const first = nextWindowState(undefined, summarizeRead(read(), 'Foo AI'), { now: new Date('2026-09-26T10:40:00.000Z'), active: false, name: 'Foo AI' })
    expect(first.state.seen).toMatchObject({ 周报怎么写: { status: 'idle', latest: expect.stringContaining('本周周报的草稿') } })
    // 他切到「旅行计划」那条:上一条的那一句还记着,新的一条记上自己的。
    const moved = summarizeRead(read({ side: [
      { t: '周报怎么写', x: 20, y: 110, w: 260, h: 30 },
      { t: '旅行计划', sel: true, x: 20, y: 150, w: 260, h: 30 },
    ], tail: [
      { t: '去哪儿玩', x: 700, y: 200, w: 300, h: 20 },
      { t: '给你排了三天的行程。', x: 400, y: 300, w: 600, h: 20 },
    ] }), 'Foo AI')
    const second = nextWindowState(first.state, moved, { now: new Date('2026-09-26T10:50:00.000Z'), active: false, name: 'Foo AI' })
    expect(Object.keys(second.state.seen ?? {})).toEqual(['周报怎么写', '旅行计划'])
    expect(second.state.seen?.旅行计划?.latest).toBe('给你排了三天的行程。')
  })
})

/**
 * 额度页里**不带百分比**的那一行(2026-09-26,卡 AC)。
 *
 * 维护者 21:38 看生产 `/state`:豆包办公的坞上蓝点还亮着,它的「回话」写着「10月2日 16:02 重置」——
 * 那是额度页的重置行,行里一个 % 都没有,老判据(要有 % 或 x/y)放它过去了,于是每读一拍那个时刻
 * 一变就判成「它回了一句」。
 */
describe('额度页那一行:带不带百分比都算界面字(卡 AC)', () => {
  it('★真机豆包办公那一行:「10月2日 16:02 重置」不算它说的话', () => {
    expect(isNotTalk('10月2日 16:02 重置', '豆包')).toBe(true)
    expect(isNotTalk('10月2日16:02重置', '豆包')).toBe(true)
    // 带栏目名的那一路(真机 Kimi),去掉 % 也还是额度行。
    expect(isNotTalk('Code 09-25 17:21 后重置', 'Kimi')).toBe(true)
    expect(isNotTalk('Code 0% 09-25 17:21 后重置', 'Kimi')).toBe(true)
    // 英文写法。
    expect(isNotTalk('Resets Oct 2, 16:02', 'Doubao')).toBe(true)
    expect(isNotTalk('3 天后重置', '豆包')).toBe(true)
  })

  /**
   * 2026-09-26 深夜(统筹真壳自核):卡 QG 让「5%」不再算话之后,Grok Bot 那扇停在 Usage & Billing 页的窗,
   * 「它最后一句」从「5%」换成了「Weekly Usage」—— 一变就判成「它回了一句」,台上冒出一张「做完 · 未读」、坞上一颗蓝点。
   * 逐行补词是追不完的(下一句是「Billed through Cursor」「Manage Billing」):**那扇窗停在用量 / 账单页上时,整页都不是对话**。
   */
  it('★窗停在用量页上:整页一句都不算它说的话(真机 Grok Bot 那 9 段原话)', () => {
    const lines = ['Usage & Billing', 'Usage', 'Weekly Usage', 'Resets in 7 days', '5%', 'On-demand monthly limit', 'Billed through Cursor', 'None', 'Manage Billing']
    const summary = summarizeRead(read({
      title: 'Grok Bot',
      side: [],
      tail: lines.map((t, i) => ({ t, x: 650, y: 90 + i * 30, w: 300, h: 20 })),
    }), 'Grok Bot')
    expect(summary.latest).toBeUndefined()
    expect(isNotTalk('Weekly Usage', 'Grok Bot')).toBe(true)
  })

  it('★真话里出现「重置」不被误伤(这一条是为了不把它说的话吃掉)', () => {
    expect(isNotTalk('我把密码重置了,你再登一次看看。', '豆包')).toBe(false)
    expect(isNotTalk('9月30日之前帮我把那台机器重置一下,别动数据。', '豆包')).toBe(false)
    expect(isNotTalk('这些目录已永久删除;需要时可通过重新安装依赖恢复。', 'Codex')).toBe(false)
    expect(isNotTalk('要不要我把"缺惊艳案例"这条记下来,反馈给 Muse 团队?', 'Muse')).toBe(false)
  })

  it('★对话区里只有那一行 → 没有「它说的话」→ 那颗蓝点跟着灭(老数据里记下的假未读也灭)', () => {
    const summary = summarizeRead(read({
      title: '介绍自身功能 - 豆包',
      side: [],
      tail: [{ t: '10月2日 16:02 重置', x: 400, y: 300, w: 300, h: 20 }],
    }), '豆包')
    expect(summary.latest).toBeUndefined()
    // 上一拍按老判法记下的那颗假蓝点:这一拍读得到窗口、一句它说的话都没剩下 → 灭。
    const prev: WindowAgentState = {
      status: 'idle', since: '', titles: [], at: '2026-09-26T10:40:00.000Z',
      latest: '10月2日 16:02 重置', unread: true, gaps: {},
    }
    const next = nextWindowState(prev, summary, { now: new Date('2026-09-26T10:50:00.000Z'), active: false, name: '豆包办公' })
    expect(next.state.unread).toBe(false)
    expect(next.bubble).toBeUndefined()
  })

  it('★读不到窗口那一拍不抹掉未读(那一拍什么都没看见)', () => {
    const prev: WindowAgentState = {
      status: 'idle', since: '', titles: [], at: '2026-09-26T10:40:00.000Z',
      latest: '这版能不能先合?', unread: true, gaps: {},
    }
    const lost = nextWindowState(prev, summarizeRead(parseRead({ running: true, windows: 0 }), '豆包'), { now: new Date('2026-09-26T10:50:00.000Z'), active: false, name: '豆包办公' })
    expect(lost.state.unread).toBe(true)
  })
})

/**
 * App 自己那个名字不许当成一条对话的标题(2026-09-26,卡 AC)。
 *
 * 真机 21:55 的登记表:Codex 当前那条对话的卡叫「ChatGPT」、豆包那条叫「介绍自身功能 - 豆包」。
 * 界面上我们叫它「Codex」「豆包办公」,它的窗口标题写的是「ChatGPT」「…- 豆包」——
 * 只认显示名就剥不掉,于是 App 名变成了台上一张卡。两个名字都认之后就没了。
 */
describe('它自己那个 App 名也要认(卡 AC)', () => {
  it('★窗口标题整个就是它的 App 名 → 认不出标题(不拿 App 名当一条对话)', () => {
    // 只给显示名:剥不掉,「ChatGPT」就成了标题(这就是真机上那张卡)。
    expect(titleFromWindow('ChatGPT', 'Codex')).toBe('ChatGPT')
    // 把它自己那个 App 名一起给:认不出标题。
    expect(titleFromWindow('ChatGPT', 'Codex', ['ChatGPT'])).toBeUndefined()
    expect(titleFromWindow('ChatGPT App', 'Codex', ['ChatGPT'])).toBeUndefined()
  })

  it('★标题两头的 App 名都剥掉,真标题留着', () => {
    expect(titleFromWindow('介绍自身功能 - 豆包', '豆包办公', ['豆包'])).toBe('介绍自身功能')
    expect(titleFromWindow('ChatGPT - 一年有几个季节', 'Codex', ['ChatGPT'])).toBe('一年有几个季节')
    // 显示名那一路照旧管用(没有别名也不退步)。
    expect(titleFromWindow('Foo AI - 周报怎么写', 'Foo AI')).toBe('周报怎么写')
  })

  it('★整行就是它的 App 名 → 不算它说的话', () => {
    expect(isNotTalk('ChatGPT', 'Codex', ['ChatGPT'])).toBe(true)
    expect(isNotTalk('豆包', '豆包办公', ['豆包'])).toBe(true)
    // 别名里没有的正常话不受影响。
    expect(isNotTalk('ChatGPT 说得对,就这么办。', 'Codex', ['ChatGPT'])).toBe(false)
  })

  it('★整条读下来:标题认不出时明说为什么,不编一个', () => {
    const summary = summarizeRead(read({ title: 'ChatGPT', side: [] }), 'Codex', ['ChatGPT'])
    expect(summary.title).toBeUndefined()
    expect(summary.gaps.title).toContain('Codex')
  })
})

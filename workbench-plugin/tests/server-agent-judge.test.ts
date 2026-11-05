// @vitest-environment node
/**
 * 「这是不是一家 Agent」的两道判(卡 Q,`server/agentJudge.ts`):结构像不像对话窗口、模型那一问怎么问怎么解、花费上限。
 */
import { describe, expect, it } from 'vitest'
import type { WindowProbe } from '../src/server/agentJudge.ts'
import {
  JUDGE_DAILY_CALLS, JUDGE_RESERVE_CNY, budgetGate, chromeSummary, estimateCallCny, identityPrompt, judgeStructure,
  AX_DETAIL_MAX, looksSelfDrawn, parseAxDetail, parseIdentityVerdicts, parseProbe, parseWindowVerdict, spend,
  wantsAxDetail, windowPrompt,
} from '../src/server/agentJudge.ts'

/** 一扇像对话窗口的窗:左边一列会话、对话区、底下输入框 + 发送、菜单里有「新对话」。 */
function chatLike(over: Partial<WindowProbe> = {}): WindowProbe {
  return parseProbe({
    running: true, windows: 1, window: { w: 1200, h: 800 },
    inputs: [{ role: 'AXTextArea', settable: true, ph: '有问题,尽管问', x: 380, y: 700, w: 760, h: 60 }],
    send: [{ label: '发送', x: 1100, y: 720, w: 30, h: 30 }],
    stop: [],
    new_chat: { menu: ['新对话'], buttons: [] },
    lists: [], left_links: 10,
    texts: { total: 30, left: 10, above_input: 14 },
    toolbar: ['深度思考', '联网搜索'],
    menus: ['文件', '编辑', '窗口'],
    ...over,
  } as unknown as Record<string, unknown>)
}

describe('judgeStructure:窗口像不像对话窗口', () => {
  it('对话区 + 输入框 + 发送 / 新对话 → 像', () => {
    const verdict = judgeStructure(chatLike())
    expect(verdict.pass).toBe(true)
    expect(verdict.why).toContain('输入框')
    expect(verdict.why).toContain('新对话')
  })

  it('只有一条长期对话、没有「新对话」入口,但输入区那颗按钮写着发送 → 也像', () => {
    const verdict = judgeStructure(chatLike({
      inputs: [{ role: 'AXButton', settable: false, composer: '消息 附加文件 语音输入一条消息 发送', x: 100, y: 700, w: 1000, h: 60 }],
      send: [],
      new_chat: { menu: [], buttons: [] },
      left_links: 0,
      texts: { total: 20, left: 0, above_input: 18 },
    }))
    expect(verdict.pass).toBe(true)
    expect(verdict.send).toBe(true)
    expect(verdict.new_chat).toBe(false)
  })

  it('空着的新对话:发送键要打了字才出现,但有会话列表和「新对话」入口 → 像', () => {
    const verdict = judgeStructure(chatLike({ send: [], texts: { total: 12, left: 12, above_input: 0 } }))
    expect(verdict.pass).toBe(true)
  })

  it('★一整块编辑区不是聊天输入框(笔记、编辑器):不像', () => {
    const verdict = judgeStructure(chatLike({
      inputs: [{ role: 'AXTextArea', settable: true, x: 300, y: 60, w: 880, h: 720 }],
      send: [],
      new_chat: { menu: [], buttons: [] },
    }))
    expect(verdict.pass).toBe(false)
    expect(verdict.why).toContain('输入框不像聊天输入框')
  })

  it('顶上的搜索框不算输入框', () => {
    const verdict = judgeStructure(chatLike({ inputs: [{ role: 'AXTextField', settable: true, ph: '搜索', x: 20, y: 20, w: 240, h: 28 }] }))
    expect(verdict.pass).toBe(false)
  })

  it('没有发送、也没有「新对话」一类的入口:不像', () => {
    const verdict = judgeStructure(chatLike({ send: [], new_chat: { menu: [], buttons: [] } }))
    expect(verdict.pass).toBe(false)
    expect(verdict.why).toContain('没有发送键,也没有「新对话」一类的入口')
  })

  it('读不到窗口 / 没窗口 / 没开:不像,并说清为什么', () => {
    expect(judgeStructure(parseProbe({ running: false })).why).toBe('它没开')
    expect(judgeStructure(parseProbe({ running: true, windows: 0 })).why).toContain('没有窗口')
    expect(judgeStructure(parseProbe({ running: true, windows: 0, ax_err: -25211 })).why).toContain('-25211')
  })

  /*
   * ★ 自绘界面那一档(2026-10-02,卡「适配自绘界面的 Kimi」)。夹具的数照抄 Air 诊断包
   * 20261002-193929 的 `快照/agents.json`:登录之后的官网 Kimi、以及被它带出来的几个兄弟。
   */
  describe('自绘界面:读得到字、输入框认不出 → 放行成「写入靠粘贴」那一档', () => {
    /** 官网 Kimi `com.moonshot.kimichat.kmp.mac`,10-02 19:20 登录后真机那一份。 */
    const kimiKmp = (): WindowProbe => parseProbe({
      running: true, windows: 1, hidden: true, window: { w: 1200, h: 800 },
      roles: { AXGroup: 4, AXScrollArea: 6, AXUnknown: 32, AXButton: 4, AXWindow: 1, AXScrollBar: 5, AXStaticText: 23 },
      inputs: [], send: [], stop: [], new_chat: { menu: [], buttons: [] }, lists: [], left_links: 0,
      texts: { total: 23, left: 11, above_input: 12 }, toolbar: [], menus: ['Kimi', '编辑'], visited: 75, ax_manual: true,
    } as unknown as Record<string, unknown>)

    it('Kimi(kmp):对话区读得到、输入框一个标准角色都没有 → 过,档位是 paste_only', () => {
      const verdict = judgeStructure(kimiKmp())
      expect(verdict.pass).toBe(true)
      expect(verdict.mode).toBe('paste_only')
      expect(verdict.surface).toBe(true)
      expect(verdict.input).toBe(false)
      expect(verdict.why).toContain('自绘界面')
      expect(verdict.why).toContain('粘贴')
      expect(looksSelfDrawn(kimiKmp())).toBe(true)
    })

    it('★没登录时那一份(只有一扇窗一张图)照旧不过 —— 不许把登录页当对话窗', () => {
      const verdict = judgeStructure(parseProbe({
        running: true, windows: 1, window: { w: 1200, h: 800 },
        roles: { AXWindow: 1, AXImage: 1 },
        inputs: [], send: [], stop: [], new_chat: { menu: [], buttons: [] }, lists: [], left_links: 0,
        texts: { total: 0, left: 0, above_input: 0 }, toolbar: [], menus: [], visited: 2, ax_manual: true,
      } as unknown as Record<string, unknown>))
      expect(verdict.pass).toBe(false)
      expect(verdict.mode).toBeUndefined()
    })

    it('★兄弟一:Kimi 安装器(三颗键、两块字、没有滚动区)照旧不过', () => {
      const verdict = judgeStructure(parseProbe({
        running: true, windows: 1, window: { w: 751, h: 218 },
        roles: { AXButton: 3, AXBusyIndicator: 1, AXStaticText: 2, AXWindow: 1 },
        inputs: [], send: [], stop: [], new_chat: { menu: [], buttons: [] }, lists: [], left_links: 0,
        texts: { total: 2, left: 0, above_input: 2 }, toolbar: [], menus: ['Kimi 安装器'], visited: 7, ax_manual: true,
      } as unknown as Record<string, unknown>))
      expect(verdict.pass).toBe(false)
      expect(verdict.why).toContain('没有输入框')
    })

    it('★兄弟二:有标准输入框、只是认不出(顶上的搜索框 / 一整块编辑区)不走这条路', () => {
      const verdict = judgeStructure(chatLike({
        inputs: [{ role: 'AXTextField', settable: true, ph: '搜索', x: 20, y: 20, w: 240, h: 28 }],
        send: [], new_chat: { menu: [], buttons: [] },
        roles: { AXTextField: 1, AXUnknown: 40, AXScrollArea: 3, AXStaticText: 30 },
      }))
      expect(verdict.pass).toBe(false)
      expect(verdict.mode).toBeUndefined()
    })

    it('★兄弟三:Electron 的树还没建好(只有窗口壳那几个节点)不算自绘', () => {
      const probe = parseProbe({
        running: true, windows: 1, window: { w: 1400, h: 900 },
        roles: { AXWindow: 1, AXGroup: 12, AXWebArea: 1 },
        inputs: [], send: [], stop: [], new_chat: { menu: [], buttons: [] }, lists: [], left_links: 0,
        texts: { total: 6, left: 0, above_input: 6 }, toolbar: [], menus: ['文件'], visited: 20, ax_manual: true,
      } as unknown as Record<string, unknown>)
      expect(looksSelfDrawn(probe)).toBe(false)
      expect(judgeStructure(probe).pass).toBe(false)
    })

    it('★老壳不报 roles → 这一档永不触发(老行为一字不变)', () => {
      const { roles: _drop, ...noRoles } = kimiKmp()
      const probe = { ...noRoles } as WindowProbe
      expect(looksSelfDrawn(probe)).toBe(false)
      expect(judgeStructure(probe).pass).toBe(false)
    })

    it('★藏在窗口槽里那一支先回(不许当成自绘放行)', () => {
      const verdict = judgeStructure(parseProbe({ running: true, windows: 0, hidden: true,
        roles: { AXUnknown: 32, AXScrollArea: 6 } } as unknown as Record<string, unknown>))
      expect(verdict.pass).toBe(false)
      expect(verdict.hidden).toBe(true)
    })
  })

  it('壳回来的坏字段当没有,不抛', () => {
    const probe = parseProbe({ running: true, windows: 1, window: { w: 'x', h: 800 }, inputs: [null, 3, { role: 5 }], send: 'no', texts: null })
    expect(probe.inputs).toHaveLength(1)
    expect(probe.send).toEqual([])
    expect(judgeStructure(probe).pass).toBe(false)
  })
})

/*
 * ★ 诊断包里那份树的明细(2026-10-02,卡「适配自绘界面的 Kimi」第 1 条)。
 * 要紧的是两件事:**一个字的内容都进不来**(哪天壳变了也进不来),以及**大不到发不出去**。
 */
describe('parseAxDetail / wantsAxDetail:输入框认不出的那几家才收明细,只收结构与字数', () => {
  const at = '2026-10-02T11:39:29.000Z'

  it('收下角色、层数、位置、动作、可写属性、焦点与字数', () => {
    const detail = parseAxDetail({
      running: true, windows: 1, window: { w: 1200, h: 800 }, visited: 75,
      elements: [
        { role: 'AXWindow', d: 0, x: 0, y: 0, w: 1200, h: 800 },
        { role: 'AXUnknown', sub: 'AXContentList', d: 7, x: 300, y: 700, w: 760, h: 56,
          act: ['AXPress'], set: ['AXFocused'], foc: true, vl: 0, dl: 4 },
      ],
    }, at)
    expect(detail.at).toBe(at)
    expect(detail.window).toEqual({ w: 1200, h: 800 })
    expect(detail.visited).toBe(75)
    expect(detail.elements).toHaveLength(2)
    expect(detail.elements[1]).toEqual({
      role: 'AXUnknown', sub: 'AXContentList', d: 7, x: 300, y: 700, w: 760, h: 56,
      act: ['AXPress'], set: ['AXFocused'], foc: true, dl: 4, vl: 0,
    })
  })

  it('★一个字的内容都进不来:壳哪天多回了一格字,这道门也扔掉它', () => {
    const detail = parseAxDetail({
      elements: [{
        role: 'AXStaticText', d: 3, x: 10, y: 20, w: 300, h: 18,
        // 下面这几格都是「不该来的」:正文、标题、提示字、一句中文的动作名。
        t: '一周有七天', title: '与 Kimi 的对话', ph: '有问题,尽管问',
        act: ['AXPress', '发送这一句'], set: ['AXValue', 'cookie=abc'],
      }],
    }, at)
    const row = detail.elements[0] as unknown as Record<string, unknown>
    expect(row.t).toBeUndefined()
    expect(row.title).toBeUndefined()
    expect(row.ph).toBeUndefined()
    expect(row.act).toEqual(['AXPress'])
    expect(row.set).toEqual(['AXValue'])
    expect(JSON.stringify(detail)).not.toContain('一周有七天')
    expect(JSON.stringify(detail)).not.toContain('cookie')
  })

  it('★大不到发不出去:行数封顶,截过的如实说', () => {
    const many = Array.from({ length: AX_DETAIL_MAX + 40 }, (_unused, i) => ({ role: 'AXGroup', d: 1, x: 0, y: i, w: 10, h: 10 }))
    const detail = parseAxDetail({ elements: many }, at)
    expect(detail.elements).toHaveLength(AX_DETAIL_MAX)
    expect(detail.capped).toBe(true)
  })

  it('坏字段当没有,不抛;角色读不出来的那一行整行不收', () => {
    const detail = parseAxDetail({ elements: [null, 3, { role: 5 }, { d: 1 }, { role: 'AXButton', d: 'x', w: 'y' }], window: 'no' }, at)
    expect(detail.elements).toEqual([{ role: 'AXButton', d: 0, x: 0, y: 0, w: 0, h: 0 }])
    expect(detail.window).toBeUndefined()
    expect(parseAxDetail({}, at).elements).toEqual([])
  })

  it('只对「输入框没认出来」的那几家收:结构没过的收、自绘那一档收、认得出输入框的不收', () => {
    expect(wantsAxDetail(judgeStructure(chatLike()))).toBe(false)
    expect(wantsAxDetail(judgeStructure(chatLike({ send: [], new_chat: { menu: [], buttons: [] } })))).toBe(true)
    // 藏在窗口槽里那一下什么都没看见 —— 不收(等它露面再说,别把一份空树写进诊断包)。
    expect(wantsAxDetail(judgeStructure(parseProbe({ running: true, windows: 0, hidden: true } as unknown as Record<string, unknown>)))).toBe(false)
    expect(wantsAxDetail({ pass: true, mode: 'paste_only', surface: true, input: false, send: false, new_chat: false, why: '' })).toBe(true)
  })
})

describe('模型那一问', () => {
  const apps = [
    { bundle_id: 'com.example.fooai', name: 'Foo AI', category: 'public.app-category.productivity', vendor: '© Foo Inc.' },
    { bundle_id: 'com.example.chatter', name: 'Chatter|坏名字\n换行', category: 'public.app-category.social-networking' },
  ]

  it('一批问:一行一个 App,名字里的分隔符与换行不许拆坏清单', () => {
    const prompt = identityPrompt(apps)
    expect(prompt).toContain('1|Foo AI|com.example.fooai|productivity|© Foo Inc.')
    expect(prompt).toContain('2|Chatter 坏名字 换行|com.example.chatter|social-networking|')
    expect(prompt).toContain('human_chat')
    // 判断标准里不点任何一家的名字:哪一家算 Agent 是判出来的,不是写死的。
    expect(prompt).not.toMatch(/ChatGPT|Claude|Kimi|豆包|Manus|Muse|微信/)
  })

  it('解回答:按序号对上包标识;回坏了 / 没回的那一家不在结果里(不替它编)', () => {
    const verdicts = parseIdentityVerdicts('好的:\n```json\n[{"n":1,"kind":"ai_agent","reason":"AI 助手"},{"n":2,"kind":"unknown"},{"n":9,"kind":"other"}]\n```', apps)
    expect(verdicts.get('com.example.fooai')).toEqual({ kind: 'ai_agent', reason: 'AI 助手' })
    expect(verdicts.has('com.example.chatter')).toBe(false)
    expect(parseIdentityVerdicts('我不知道', apps).size).toBe(0)
  })

  it('带上界面字再判一次:只有按钮名、菜单名、输入框提示,没有聊天内容', () => {
    const probe = chatLike()
    const summary = chromeSummary(probe)
    expect(summary).toContain('提示字「有问题,尽管问」')
    expect(summary).toContain('深度思考')
    const prompt = windowPrompt(apps[0] as never, probe)
    expect(prompt).toContain('没有任何聊天内容')
    expect(parseWindowVerdict('{"kind":"human_chat","reason":"跟真人聊天"}')).toEqual({ kind: 'human_chat', reason: '跟真人聊天' })
    expect(parseWindowVerdict('{"kind":"maybe"}')).toBeUndefined()
  })
})

describe('花费上限(计入每日额度)', () => {
  const budget = { day: '2026-09-25', calls: 0, cny: 0 }

  it('每天次数有上限;跨天清零', () => {
    const full = { day: '2026-09-25', calls: JUDGE_DAILY_CALLS, cny: 0.01 }
    expect(budgetGate({ budget: full, today: '2026-09-25', estimate: 0.001 }).ok).toBe(false)
    expect(budgetGate({ budget: full, today: '2026-09-26', estimate: 0.001 }).ok).toBe(true)
  })

  it('中转那边今天剩得少了就不判(留给通话和事务官)', () => {
    const gate = budgetGate({ budget, today: '2026-09-25', estimate: 0.001, remainingCny: JUDGE_RESERVE_CNY - 0.01 })
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.why).toContain('留给通话和事务官')
    expect(budgetGate({ budget, today: '2026-09-25', estimate: 0.001, remainingCny: 4.2 }).ok).toBe(true)
  })

  it('估价往高了估,记一笔跨天清零', () => {
    expect(estimateCallCny(1000, 500)).toBeGreaterThan(0.005)
    expect(spend(budget, '2026-09-25', 0.01)).toEqual({ day: '2026-09-25', calls: 1, cny: 0.01 })
    expect(spend({ day: '2026-09-24', calls: 9, cny: 0.2 }, '2026-09-25', 0.01)).toEqual({ day: '2026-09-25', calls: 1, cny: 0.01 })
  })
})

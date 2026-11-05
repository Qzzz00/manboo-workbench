// @vitest-environment node
/**
 * 陌生程序的侧栏只收真正的会话列表项(2026-10-08,卡「陌生程序侧栏」)。
 *
 * 维护者新加的千问办公(cn.qwenwork.desktop.mac)走读窗口那一路,`/state` 里它的 `titles` 是
 * 「关闭侧边栏」「搜索任务或会话内容」「姚桑」「个人免费版」—— 侧栏按钮、搜索键、她的账号名、套餐标;
 * 真对话一条都没进来。`latest` 读成「暂无产物」(右边那格面板的标牌)。
 *
 * 不加词表:按壳回来的 AX 角色判。夹具全是 10-08 真机 `probe agent-read` 的原样数字。
 */
import { describe, expect, it } from 'vitest'
import { parseRead, summarizeRead } from '../src/server/agentWindowModel.ts'

/** 千问办公,新壳(列表项是 AXCheckBox/AXToggleButton;账号区是一颗 AXPopUpButton,壳整枝不看)。 */
function qwenNew() {
  return parseRead({
    running: true,
    windows: 1,
    window: { w: 1395, h: 1105 },
    title: '起草众筹发货邮件',
    input: { x: 306, y: 979, w: 747, h: 44 },
    sidebar: { x: 0, y: 0, w: 280, h: 1105 },
    stop: [],
    tail: [
      { t: '所以你想线上拿到的话,实际动作是:官网 reserve 留个邮箱排队。要我把这条问话写短一点吗?', x: 312, y: 786, w: 711, h: 43 },
      { t: '内容由 AI 生成,请注意核实', x: 599, y: 1081, w: 151, h: 15 },
      { t: '任务监控', x: 1091, y: 14, w: 56, h: 18 },
      { t: '暂无产物', x: 1091, y: 157, w: 48, h: 15 },
      { t: '长期记忆', x: 1115, y: 317, w: 52, h: 16, ctl: true },
    ],
    side: [
      { t: '关闭侧边栏', r: 'AXButton', x: 82, y: 8, w: 32, h: 32 },
      { t: '搜索任务或会话内容', r: 'AXButton', x: 114, y: 8, w: 32, h: 32 },
      { t: '新任务', r: 'AXButton', x: 12, y: 56, w: 78, h: 26 },
      { t: '新任务', r: 'AXButton', x: 38, y: 102, w: 196, h: 24 },
      { t: '扩展', r: 'AXButton', x: 38, y: 136, w: 230, h: 24 },
      { t: '专家套件', r: 'AXButton', x: 38, y: 170, w: 218, h: 24 },
      { t: '我的网页', r: 'AXButton', x: 38, y: 303, w: 222, h: 24 },
      { t: '置顶', r: 'AXButton', x: 8, y: 432, w: 264, h: 24 },
      { t: '项目', r: 'AXButton', x: 8, y: 478, w: 264, h: 24 },
      { t: '新建项目', r: 'AXButton', x: 244, y: 478, w: 24, h: 24 },
      { t: '管理任务,高效无忧', x: 81, y: 531, w: 118, h: 16 },
      { t: '最近', r: 'AXButton', x: 8, y: 626, w: 264, h: 24 },
      { t: '新建任务', r: 'AXButton', x: 244, y: 626, w: 24, h: 24 },
      { t: '起草众筹发货邮件', r: 'AXCheckBox', x: 8, y: 654, w: 260, h: 32 },
      { t: '审阅会议逐字稿', r: 'AXCheckBox', x: 8, y: 687, w: 260, h: 32 },
      { t: '总结一下', r: 'AXCheckBox', x: 8, y: 720, w: 260, h: 32 },
    ],
  })
}

describe('千问办公:侧栏只收会话列表项', () => {
  it('★★新壳:titles 只剩那三条对话,按钮 / 搜索键 / 账号名 / 套餐标一个都不进', () => {
    const s = summarizeRead(qwenNew(), '千问办公', ['QwenWorkCN'])
    expect(s.titles).toEqual(['起草众筹发货邮件', '审阅会议逐字稿', '总结一下'])
    expect(s.title).toBe('起草众筹发货邮件')
  })

  it('★★旧壳(账号区的两块字没带角色、列表项没读到):账号名、套餐标、图标键照样不当会话', () => {
    const s = summarizeRead(parseRead({
      ...qwenNew(),
      side: [
        { t: '关闭侧边栏', r: 'AXButton', x: 82, y: 8, w: 32, h: 32 },
        { t: '搜索任务或会话内容', r: 'AXButton', x: 114, y: 8, w: 32, h: 32 },
        { t: '最近', r: 'AXButton', x: 8, y: 626, w: 264, h: 24 },
        { t: '姚桑', x: 55, y: 1058, w: 28, h: 17 },
        { t: '个人免费版', x: 55, y: 1075, w: 60, h: 15 },
        { t: 'Settings', r: 'AXButton', x: 240, y: 1060, w: 28, h: 28 },
      ],
    }), '千问办公', ['QwenWorkCN'])
    // 图标键按宽窄认得出;那两块光秃秃的字旧壳没给角色,判不了 —— 只要求图标键那两条不再进来。
    expect(s.titles).not.toContain('关闭侧边栏')
    expect(s.titles).not.toContain('搜索任务或会话内容')
  })

  it('★★最新一句不读右边那格面板(整块落在输入框右沿以外)——「暂无产物」不是它说的话', () => {
    const s = summarizeRead(qwenNew(), '千问办公', ['QwenWorkCN'])
    expect(s.latest).toContain('要我把这条问话写短一点吗')
  })
})

describe('图标键:按宽窄认,不按字', () => {
  it('★侧栏里窄窄一颗键(不到侧栏宽的四成)不是会话,不管上面写什么', () => {
    const s = summarizeRead(parseRead({
      ...qwenNew(),
      side: [
        { t: '整理一下需求文档', r: 'AXButton', x: 200, y: 100, w: 28, h: 28 },
        { t: '整理一下需求文档的初稿', r: 'AXButton', x: 8, y: 140, w: 260, h: 32 },
      ],
    }), '千问办公')
    expect(s.titles).toEqual(['整理一下需求文档的初稿'])
  })

  it('★一颗开关(只露出一条 AXCheckBox)不算一份列表:按钮画的会话照收', () => {
    const s = summarizeRead(parseRead({
      ...qwenNew(),
      side: [
        { t: '只看星标', r: 'AXCheckBox', x: 8, y: 60, w: 200, h: 24 },
        { t: '整理一下需求文档的初稿', r: 'AXButton', x: 8, y: 140, w: 260, h: 32 },
      ],
    }), '千问办公')
    expect(s.titles).toContain('整理一下需求文档的初稿')
  })

  it('★光秃秃一块字不按宽窄判(字的宽就是字的长,短标题照留)', () => {
    const s = summarizeRead(parseRead({
      ...qwenNew(),
      side: [{ t: '一周天数', x: 38, y: 825, w: 56, h: 18 }],
    }), '千问办公')
    expect(s.titles).toEqual(['一周天数'])
  })
})

describe('Manus:列表项是 AXCheckBox(字在里面),导航与账号名是可点的普通块', () => {
  /** 10-08 真机,新壳:列表项里的字带 `in: AXCheckBox`;导航、账号名不在任何一种键里。 */
  function manus() {
    return parseRead({
      running: true,
      windows: 1,
      window: { w: 1496, h: 971 },
      title: 'Manus',
      input: { x: 501, y: 861, w: 742, h: 22 },
      sidebar: { x: 0, y: 0, w: 240, h: 971 },
      stop: [],
      tail: [],
      side: [
        { t: 'New task', x: 38, y: 61, w: 60, h: 18 },
        { t: 'Computers', x: 38, y: 94, w: 72, h: 18 },
        { t: 'Agents', x: 38, y: 127, w: 46, h: 18 },
        { t: 'Projects', in: 'AXCheckBox', x: 14, y: 339, w: 51, h: 16 },
        { t: 'Token Factory', in: 'AXCheckBox', x: 38, y: 373, w: 91, h: 17 },
        { t: 'More projects', x: 38, y: 548, w: 90, h: 17 },
        { t: 'Tasks', in: 'AXCheckBox', x: 14, y: 595, w: 35, h: 16 },
        { t: '派活流程和规则遵循指导', in: 'AXCheckBox', x: 38, y: 627, w: 153, h: 18 },
        { t: '一周天数', in: 'AXCheckBox', x: 38, y: 825, w: 56, h: 18 },
        { t: '姚岱楠', x: 46, y: 940, w: 41, h: 17 },
      ],
    })
  }

  it('★★侧栏露出了列表项:只收列表项 ——「Computers」导航、她的账号名都不进', () => {
    const s = summarizeRead(manus(), 'Manus')
    expect(s.titles).toEqual(['派活流程和规则遵循指导', '一周天数'])
  })

  it('★旧壳(字都没带 in):照老样子全留,一条真会话都不能少', () => {
    const old = manus()
    const s = summarizeRead({ ...old, side: old.side.map(({ in: _in, ...row }) => row) }, 'Manus')
    expect(s.titles).toContain('派活流程和规则遵循指导')
    expect(s.titles).toContain('一周天数')
  })
})

describe('兄弟家不因此少了真会话', () => {
  it('★Muse(全是 AXButton、没有列表项):左边图标栏的窄键不收,215 宽的会话行照收', () => {
    const s = summarizeRead(parseRead({
      running: true,
      windows: 1,
      window: { w: 1395, h: 1105 },
      input: { x: 472, y: 1031, w: 769, h: 58 },
      sidebar: { x: -1, y: -1, w: 343, h: 1106 },
      stop: [],
      tail: [],
      side: [
        { t: 'Chat', r: 'AXLink', sel: true, x: 0, y: 280, w: 78, h: 56 },
        { t: '编辑器对比 Demo', r: 'AXButton', x: 0, y: 632, w: 78, h: 56 },
        { t: 'Side chats', r: 'AXButton', x: 91, y: 96, w: 187, h: 36 },
        { t: 'New side chat', r: 'AXButton', x: 278, y: 102, w: 24, h: 24 },
        { t: 'Pokemon Eclipse Riolu evolution guide', r: 'AXButton', sel: true, x: 91, y: 132, w: 215, h: 36 },
        { t: '完成 Pen.dev 安装', r: 'AXButton', x: 91, y: 243, w: 215, h: 36 },
      ],
    }), 'Muse')
    expect(s.titles).toEqual(['Pokemon Eclipse Riolu evolution guide', '完成 Pen.dev 安装'])
    expect(s.title).toBe('Pokemon Eclipse Riolu evolution guide')
  })

  it('★Antigravity(会话是 AXLink):Pin / Archive / Toggle Sidebar 那几颗小键不收,会话照收', () => {
    const s = summarizeRead(parseRead({
      running: true,
      windows: 1,
      window: { w: 1496, h: 971 },
      input: { x: 497, y: 886, w: 759, h: 40 },
      sidebar: { x: 0, y: 0, w: 256, h: 971 },
      stop: [],
      tail: [],
      side: [
        { t: 'Toggle Sidebar', r: 'AXButton', x: 88, y: 6, w: 28, h: 28 },
        { t: 'Conversations', r: 'AXButton', x: 16, y: 229, w: 99, h: 16 },
        { t: 'Gemini 4 Model Availability', r: 'AXLink', x: 8, y: 249, w: 240, h: 32 },
        { t: 'Pin conversation', r: 'AXButton', x: 194, y: 253, w: 24, h: 24 },
        { t: 'Gemini 4 Pro Release Date', r: 'AXLink', x: 8, y: 282, w: 240, h: 32 },
      ],
    }), 'Antigravity')
    expect(s.titles).toEqual(['Gemini 4 Model Availability', 'Gemini 4 Pro Release Date'])
  })

  it('★对话区:右边落在输入框里的那几段照读(用户那一侧右对齐的气泡也在输入框横向范围内)', () => {
    const s = summarizeRead(parseRead({
      ...qwenNew(),
      tail: [
        { t: '帮我起草一封发货邮件', x: 800, y: 600, w: 240, h: 20 },
        { t: '好的,这是草稿。', x: 312, y: 700, w: 300, h: 20 },
      ],
    }), '千问办公')
    expect(s.latest).toBe('好的,这是草稿。')
    expect(s.lines).toBe(2)
  })
})

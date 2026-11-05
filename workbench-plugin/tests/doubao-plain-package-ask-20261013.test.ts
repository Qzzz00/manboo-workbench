// @vitest-environment node
/**
 * **普通包豆包(`com.bot.pc.doubao`)窗口里的那道选择题认不出:主区标记那一行**(2026-10-13)。
 *
 * 维护者 09:18 在普通包里让豆包出选择题,面板出来三分钟没来电。两份真机读数并排看:
 * - 维护包 `com.work.pc.doubao`(`fixtures/doubao-read-asking-20260928.json`):主区有一行逐字「正在询问用户」;
 * - 普通包 `com.bot.pc.doubao`(`fixtures/doubao-read-asking-20261013.json`,侧栏里与本题无关的对话标题
 *   已改成「对话 N」,见那份夹具的 `_note`):同一个位置写的是**工具调用的人话名**「询问用户饮品偏好」。
 *
 * 标记从「逐字一个词」放宽成「逐字那一个词,或者以『询问用户』开头的那一行」;侧栏「待确认」、问号行、
 * 成组短行这三条一个没松,正文里碰巧以「询问用户」开头、后面没有问号行或没有成组短行的,照旧不算。
 *
 * 放宽之后还露出第二处:四个选项里的「茶」只有一个字,`isChromeLine` 把一个字的行一律当界面字 ——
 * 题认出来了,念出来、能按的却只剩三项(「第二个」还会错位)。所以问题底下那一片不按那一条筛。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SessionAskView } from '../src/protocol.ts'
import { ASK_MARKER_PREFIX, ASK_MARKER_PROCESSED, ASK_MARKER_TEXT, doubaoVisibleForm, isAskMarkerLine, isChromeLine, parseRead, type WindowRead } from '../src/server/agentWindowModel.ts'

const readFixture = (name: string): WindowRead =>
  parseRead(JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>)

/** 普通包那一刻的真机读数(2026-10-13 09:18)。 */
const PLAIN = readFixture('doubao-read-asking-20261013.json')
/** 维护包那一刻的真机读数(2026-09-28),放宽标记后它必须一个字不差地照旧认出来。 */
const MAINTENANCE = readFixture('doubao-read-asking-20260928.json')

/** 普通包主区那一行标记:工具调用的人话名。 */
const PLAIN_MARKER = '询问用户饮品偏好'
/** 普通包第二份真读数(2026-10-13 11:3x):工具名换成了「发起饮料偏好提问」,靠它上面「已处理 N 分 N 秒」那行认。 */
const PLAIN_B = readFixture('doubao-read-asking-20261013b.json')

describe('认标记那一行(isAskMarkerLine)', () => {
  it('★逐字那一个词认,以「询问用户」开头的工具名也认', () => {
    expect(isAskMarkerLine(ASK_MARKER_TEXT)).toBe(true)
    expect(isAskMarkerLine(`  ${ASK_MARKER_TEXT}  `)).toBe(true)
    expect(isAskMarkerLine(PLAIN_MARKER)).toBe(true)
    expect(PLAIN_MARKER.startsWith(ASK_MARKER_PREFIX)).toBe(true)
  })

  it('别的话不认(「用户询问…」这种反着写的、别的工具名)', () => {
    expect(isAskMarkerLine('用户询问饮品偏好')).toBe(false)
    expect(isAskMarkerLine('正在写入文件')).toBe(false)
    expect(isAskMarkerLine('已处理 7 分 2 秒')).toBe(true) // 10-13 第二份读数起:这一行也算标记
  })
})

describe('普通包那一刻的真窗口:认出题与四个选项', () => {
  it('★标记是工具名也认出来:问题是问号那一行,四个选项是标签', () => {
    const ask = doubaoVisibleForm(PLAIN, undefined, 'now', '豆包')
    expect(ask?.question).toBe('我最想喝哪种饮料？')
    expect(ask?.options?.map(one => one.label)).toEqual(['可乐', '茶', '咖啡', '果汁'])
    expect(ask).toMatchObject({ by: 'form', kind: 'choose', since: 'now', press: true, write: true, where: '豆包正在等你选择' })
  })

  it('★选项只取标签那一行,每项下面那行描述不混进来(替她选时按标签点)', () => {
    const labels = doubaoVisibleForm(PLAIN, undefined, 'now')?.options?.map(one => one.label) ?? []
    // 描述行同 x,但矮 2 像素(h=15 对标签的 h=17),同 x 同高那一筛把它们筛掉。
    const descriptions = PLAIN.tail.filter(row => row.h === 15 && row.x === 347).map(row => row.t)
    expect(descriptions.length).toBe(4)
    for (const one of descriptions) expect(labels).not.toContain(one)
  })

  it('★一个字的选项不许丢:「茶」在 isChromeLine 眼里是界面字,问题底下那一片不按那一条筛', () => {
    expect(isChromeLine('茶')).toBe(true)
    expect(doubaoVisibleForm(PLAIN, undefined, 'now')?.options?.map(one => one.label)).toContain('茶')
  })

  it('同一道题沿用上一次的 since(电话一件只打一次靠它)', () => {
    const first = doubaoVisibleForm(PLAIN, undefined, 'now') as SessionAskView
    expect(doubaoVisibleForm(PLAIN, first, 'later')?.since).toBe('now')
  })
})

describe('维护包那份老读数照旧绿', () => {
  it('★逐字「正在询问用户」那一份一个字没变:三个选项照旧', () => {
    const ask = doubaoVisibleForm(MAINTENANCE, undefined, 'now')
    expect(ask?.options?.map(one => one.label)).toEqual(['选购/对比月饼', '写文案/做海报', '其他想法'])
    expect(ask?.question).toContain('你具体想让我做什么')
  })
})

describe('放宽标记但不误认', () => {
  const withMarker = (rows: { t: string, x: number, y: number, w: number, h: number }[]): WindowRead => ({
    running: true,
    window: { w: 1400, h: 1043 },
    input: { x: 317, y: 938, w: 826, h: 24 },
    sidebar: { x: 0, y: 0, w: 280, h: 1043 },
    stop: [],
    side: [{ t: '一条对话 待确认', x: 9, y: 535, w: 262, h: 32, r: 'AXLink' }],
    tail: [{ t: '询问用户某件事', x: 317, y: 265, w: 112, h: 17 }, ...rows],
  })

  it('★正文以「询问用户」开头、后面没有问号行 → 不算', () => {
    expect(doubaoVisibleForm(withMarker([
      { t: '我按你说的办了', x: 317, y: 400, w: 200, h: 18 },
      { t: '第一件', x: 347, y: 440, w: 60, h: 17 },
      { t: '第二件', x: 347, y: 470, w: 60, h: 17 },
    ]), undefined, 'now')).toBeUndefined()
  })

  it('★有问号行、但后面没有成组的短行 → 不算', () => {
    expect(doubaoVisibleForm(withMarker([
      { t: '你要我接着往下做吗？', x: 317, y: 400, w: 200, h: 18 },
      { t: '那我就接着做了', x: 317, y: 440, w: 200, h: 18 },
    ]), undefined, 'now')).toBeUndefined()
  })

  it('★侧栏没有那个「待确认」→ 不算(标记放宽不碰这一条)', () => {
    expect(doubaoVisibleForm({ ...PLAIN, side: [] }, undefined, 'now')).toBeUndefined()
  })

  it('★主区一行标记都没有 → 不算', () => {
    expect(doubaoVisibleForm({ ...PLAIN, tail: PLAIN.tail.filter(row => !isAskMarkerLine(row.t)) }, undefined, 'now')).toBeUndefined()
  })
})

describe('工具名是模型现起的:靠「已处理 N 分 N 秒」那行认(2026-10-13 第二份读数)', () => {
  it('「已处理 3 分 44 秒」「已处理 12 秒」算标记;「已处理」「已处理很久」不算', () => {
    expect(ASK_MARKER_PROCESSED.test('已处理 3 分 44 秒')).toBe(true)
    expect(isAskMarkerLine('已处理 3 分 44 秒')).toBe(true)
    expect(isAskMarkerLine('已处理 12 秒')).toBe(true)
    expect(isAskMarkerLine('已处理')).toBe(false)
    expect(isAskMarkerLine('已处理很久')).toBe(false)
  })

  it('★第二份真读数(工具名「发起饮料偏好提问」)认出题与四个选项', () => {
    expect(PLAIN_B.tail.some(row => row.t.includes('发起饮料偏好提问'))).toBe(true)
    expect(PLAIN_B.tail.some(row => row.t.startsWith(ASK_MARKER_PREFIX))).toBe(false)
    const ask = doubaoVisibleForm(PLAIN_B, undefined, 'now', '豆包')
    expect(ask?.question).toBe('你最想喝哪种饮料？')
    expect(ask?.options?.map(one => one.label)).toEqual(['可乐', '茶', '咖啡', '果汁'])
  })
})

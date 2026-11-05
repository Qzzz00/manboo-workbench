/**
 * **「要在这台电脑上动手」的活:没点名也得挑一家,不许默不作声**(2026-10-02,卡 AG)。
 *
 * 现场(Air 运营同学,0.4.85)她的原话:「我让他打开网易云音乐,**事务官不能分派让 ai 去打开**,
 * 只有在命令里加了【豆包】,他才会通过豆包打开」。
 *
 * 机制上的病根:活只分两类 —— `code`(改文件)与 `chat`(回一段字)。
 * 「打开网易云音乐」被认成 `chat`,而 `chat` 没点名时 `dispatchChoices` **故意挑不出**
 * (`default` 整格缺席、`line` 说「这一件事务官自己答,不用派」)。可这一件事务官**答不了** ——
 * 它不是一句话能回的事,是要在这台电脑上点、开、关的事,而「事务官自己不干活」(09-28 拍板)。
 * 于是她那句话落进了空档:不派,也不说。
 *
 * 机制上的改法(**不许写「网易云 → 豆包」这种映射**):多一类活 `desk`,
 * 选家按**能力**来 —— 这台电脑上有本机窗口、送得进话的那几家(`handsFor(target,'desk')` 非空)。
 * 挑出一家当默认项,`line` 复述一句让她点头(点头那一道在确认点里,见 `confirmPoints.ts`)。
 */
import { describe, expect, it } from 'vitest'
import { JOB_KIND_TITLES } from '../src/protocol.ts'
import { DESK_NO_HAND_WHY, choiceLine, dispatchChoices, divisionOfText, divisionRuleText, handsFor, jobKindOf } from '../src/server/dispatchChoice.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'

const DOUBAO: DispatchTarget = {
  id: 'doubao', title: '豆包办公', bundle_id: 'com.work.pc.doubao', hands: ['window'], aliases: [], from_registry: true,
} as unknown as DispatchTarget
const KIMI: DispatchTarget = {
  id: 'kimi', title: 'Kimi', bundle_id: 'com.moonshot.kimichat.kmp.mac', hands: ['window'], aliases: [], from_registry: true,
} as unknown as DispatchTarget
/** 只走接口的那一家(今天 = GPT):它在云上,**动不了她这台电脑**。 */
const GPT: DispatchTarget = {
  id: 'gpt', title: 'GPT', hands: ['api'], aliases: [], from_registry: true,
} as unknown as DispatchTarget

function choicesFor(text: string, targets: readonly DispatchTarget[], named?: 'doubao' | 'kimi') {
  return dispatchChoices({
    text,
    targets,
    quota: {},
    installed: () => true,
    ...(named === undefined ? {} : { named }),
  })
}

describe('认活:要在这台电脑上动手的那一类', () => {
  it('她那几句原话都认得出', () => {
    expect(jobKindOf('打开网易云音乐').kind).toBe('desk')
    expect(jobKindOf('帮我打开网易云音乐').kind).toBe('desk')
    expect(jobKindOf('让豆包帮我关掉网易云的音乐').kind).toBe('desk')
    expect(jobKindOf('在网易云音乐播放音乐').kind).toBe('desk')
  })

  it('同一类的别的说法也认得出(举例 = 一整类,不是只认音乐)', () => {
    expect(jobKindOf('把微信打开').kind).toBe('desk')
    expect(jobKindOf('退出 Chrome').kind).toBe('desk')
    expect(jobKindOf('把屏幕调亮一点').kind).toBe('desk')
    expect(jobKindOf('帮我截个图').kind).toBe('desk')
    expect(jobKindOf('音量调小一点').kind).toBe('desk')
  })

  it('改代码、回一段字还是原来那两类(认活的次序没被挤掉)', () => {
    expect(jobKindOf('修一下首页球的显示问题').kind).toBe('code')
    expect(jobKindOf('打开 settings.tsx 把那个按钮改成深色').kind).toBe('code')
    expect(jobKindOf('写一段小红书文案').kind).toBe('chat')
    expect(jobKindOf('用一句话回答:一年有几个季节?').kind).toBe('chat')
    expect(jobKindOf('打开话题:国庆选题怎么排').kind).toBe('chat')
  })

  it('明说了就按明说的', () => {
    expect(jobKindOf('打开网易云音乐', { explicit: 'chat' }).kind).toBe('chat')
  })

  it('这一类有自己的说法', () => {
    expect(JOB_KIND_TITLES.desk).not.toBe('')
    expect(JOB_KIND_TITLES.desk).not.toBe(JOB_KIND_TITLES.chat)
  })
})

describe('选家:按能力挑,不认哪一家的名字', () => {
  it('只有本机窗口那只手算数 —— 云上那一家动不了她的电脑', () => {
    expect(handsFor(DOUBAO, 'desk')).toEqual(['window'])
    expect(handsFor(GPT, 'desk')).toEqual([])
  })

  it('没点名也挑得出一家,而且挑的是能动这台电脑的那一家', () => {
    const view = choicesFor('帮我打开网易云音乐', [DOUBAO, GPT])
    expect(view.kind).toBe('desk')
    expect(view.default).toBe('doubao')
    expect(view.line).toContain('豆包办公')
  })

  it('换成别家一样挑得出 —— 代码里没有「网易云 → 豆包」这种映射', () => {
    const view = choicesFor('帮我打开网易云音乐', [KIMI])
    expect(view.default).toBe('kimi')
    const two = choicesFor('帮我打开网易云音乐', [KIMI, DOUBAO])
    expect(two.options.map(one => one.family)).toEqual(['kimi', 'doubao'])
  })

  it('一家能动电脑的都没有:如实说,不派、也不自己顶上', () => {
    const view = choicesFor('帮我打开网易云音乐', [GPT])
    expect(view.default).toBeUndefined()
    expect(view.default_why).toContain(DESK_NO_HAND_WHY)
    expect(view.line).toContain(DESK_NO_HAND_WHY)
  })

  it('她点了名就听她的(0.4.85 她加【豆包】才派得出去那一路一字不变)', () => {
    const view = choicesFor('帮我打开网易云音乐', [DOUBAO, KIMI], 'doubao')
    expect(view.default).toBe('doubao')
    expect(view.default_why).toContain('点名')
  })

  it('那一句是复述给她点头的:说清这件要在电脑上动手、派给谁、还能派谁', () => {
    const view = choicesFor('帮我打开网易云音乐', [DOUBAO, KIMI])
    expect(view.line).toContain(JOB_KIND_TITLES.desk)
    expect(view.line).toContain('豆包办公')
    expect(view.line).toContain('Kimi')
  })

  it('没有默认项时那一句的头一截也说得出话', () => {
    expect(choiceLine('desk', undefined, [])).toContain(DESK_NO_HAND_WHY)
  })
})

describe('规矩表:这一类也能定分工', () => {
  it('「在电脑上动手的活派 Kimi」读得出来', () => {
    const division = divisionOfText('派活默认分工:在电脑上动手的活派 Kimi', [KIMI])
    expect(division?.desk).toBe('kimi')
  })

  it('读出来的分工写回规矩表那一条字里', () => {
    expect(divisionRuleText({ desk: 'kimi', projects: [] })).toContain('Kimi')
  })

  it('分工里定了谁,没点名时就按它派', () => {
    const view = dispatchChoices({
      text: '帮我打开网易云音乐',
      targets: [DOUBAO, KIMI],
      quota: {},
      installed: () => true,
      division: { desk: 'kimi', projects: [] },
    })
    expect(view.default).toBe('kimi')
    expect(view.default_why).toContain('按规矩')
  })
})

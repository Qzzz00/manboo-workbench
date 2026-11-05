/**
 * 「协助梳理」而不是「问卷 + 总结」(2026-09-20,Ben 真机那通 10:47–10:54)。
 *
 * 那通里她连问八题(是干什么的 / 做到什么样算成 / 现在到哪 / 截止 / 参赛要求 / 谁一起做 /
 * 下一步 / 还有什么功能),每答一条 `record_answer` 一条,**没有一句复述结构、没有一句提议**;
 * 他说「我叫本」被记成「Java」,纠正时后端回 409,她只好说「这个名字的改动我这会儿没能记上」。
 *
 * 这一组钉五件(交接里那张「五条对照表」逐条对应):
 *   ① 复述:提示词里「第一句永远是复述」要在,而且排在清单前面;
 *   ② 边界:「你没有依据的事不替他估」要在;
 *   ③ 日历:简报有日历就进提示词,而且带一句「别自己心算」;
 *   ④ 排方案:「先问目前的安排」「你来排、念给他听」要在;
 *   ⑤ 称呼:记下当场复述确认、听错随时能改,而且**「改不了」这三个字不许出现**。
 */
import { describe, expect, it } from 'vitest'
import {
  TOOL_CORRECT_ANSWER,
  TOOL_COUNT_WORKDAYS,
  TOOL_RECORD_ANSWER,
  buildOnboardingInstructions,
  coerceAnswerValue,
  correctResultText,
  createOnboardingTools,
  parseOnboardingBrief,
  workdaysResultText,
  type OnboardingBrief,
} from '../src/onboarding.ts'

type Deps = Parameters<typeof createOnboardingTools>[0]

function brief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return {
    stage: 'projects',
    label: '②′ 项目',
    done: false,
    speak_seed: false,
    goals: ['这个项目是什么、给谁用'],
    keys: [
      { name: 'project', kind: 'project', desc: '项目的一项或几项', required: false },
      { name: 'plan', kind: 'plan', desc: '你排出来、他点过头的方案', required: false },
      { name: 'done', kind: 'bool', desc: '聊完了', required: true },
    ],
    answered: { opening: ['nickname'] },
    nickname: 'Java',
    ...over,
  }
}

/** ① 开场那一段:还没答过称呼,所以 `nickname` 整格缺席(不是 undefined,是没有这个键)。 */
function openingBrief(): OnboardingBrief {
  const { nickname, ...rest } = brief({ stage: 'opening', label: '① 开场', answered: {} })
  void nickname
  return { ...rest, keys: [{ name: 'nickname', kind: 'string', desc: '称呼', required: true }] }
}

describe('系统提示:协助梳理的五条', () => {
  it('① 复述 —— 「第一句永远是复述」在,而且排在「要弄清的东西」前面', () => {
    const text = buildOnboardingInstructions({ brief: brief() })
    expect(text).toContain('你是来帮他梳理的,不是来做问卷的')
    expect(text).toContain('第一句永远是复述')
    expect(text).toContain('一轮最多问一个问题')
    expect(text.indexOf('第一句永远是复述')).toBeLessThan(text.indexOf('【这一段要弄清的东西】'))
  })

  it('② 边界 —— 不替他估别人的工作量,要判断先说成猜测', () => {
    const text = buildOnboardingInstructions({ brief: brief() })
    expect(text).toContain('你不知道的事不替他估')
    expect(text).toContain('这件大概要多久')
    expect(text).toContain('我猜')
  })

  it('③ 日历 —— 简报给了就进提示词,并且带一句「别自己心算」', () => {
    const withCalendar = buildOnboardingInstructions({
      brief: brief({ calendar: '今天是 2026-09-20(周日)。\n接下来 90 天里的法定假期:国庆节 2026-10-01 到 2026-10-03(确定)。' }),
    })
    expect(withCalendar).toContain('【日历】')
    expect(withCalendar).toContain('2026-10-01')
    expect(withCalendar).toContain(TOOL_COUNT_WORKDAYS)
    expect(withCalendar).toContain('别自己心算')

    // 老工作台没有这一格:整段不出现,**不自己编一份日历**。
    const without = buildOnboardingInstructions({ brief: brief() })
    expect(without).not.toContain('【日历】')
  })

  it('④ 排方案 —— 先问目前的安排,收齐了你来排、念给他听', () => {
    const text = buildOnboardingInstructions({ brief: brief() })
    expect(text).toContain('别让他从零排时间')
    expect(text).toContain('你目前的安排是什么')
    expect(text).toContain('你看行不行')
    // 「你下一步打算做什么」只许以**反例**的身份出现 —— 那正是早上那通里她问的那一句。
    expect(text).toContain('不是反过来问他「你下一步打算做什么」')
  })

  it('⑤ 称呼 —— 任何阶段都写着「照改」,而且「改不了」是明令禁止的一句话', () => {
    const later = buildOnboardingInstructions({ brief: brief() })
    expect(later).toContain(TOOL_CORRECT_ANSWER)
    expect(later).toContain('他现在叫「Java」')
    expect(later).toContain('「我这会儿改不了」这种话一个字都不要说')

    const opening = buildOnboardingInstructions({
      brief: openingBrief(),
    })
    // 2026-09-23(统筹第三轮 U / V):称呼他一说就直接用,不再「我叫你 X,对吗?」;纠正照样当场改。
    expect(opening).toContain('他说了就**直接用**')
    expect(opening).toContain('不再问「我叫你 X,对吗?」')
    expect(opening).toContain(`当场 ${TOOL_CORRECT_ANSWER} 改`)
  })

  it('这几条不是把清单换个地方念:提示词里没有「挨个问」的意思', () => {
    const text = buildOnboardingInstructions({ brief: brief() })
    expect(text).toContain('清单是拿来对照「还差什么」的,不是拿来挨个念的')
    expect(text).toContain('不回头补问')
  })
})

describe('correct_answer', () => {
  it('真去调工作台;改好了回一句「跟他确认一下」,并让工人换提示词(称呼变了)', async () => {
    const calls: unknown[] = []
    let refreshed = 0
    const workbench = {
      onboardingCorrect: async (input: unknown) => {
        calls.push(input)
        return { status: 200, body: { ok: true, also: '记忆文件改名了:用户-Java.md → 用户-本.md(内容一个字没丢)' } }
      },
    } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief, onAnswered: () => { refreshed += 1 } })
    const text = String(await tools[TOOL_CORRECT_ANSWER].execute({ stage: 'opening', key: 'nickname', value: '本' }, {} as never))
    expect(calls).toEqual([{ stage: 'opening', key: 'nickname', value: '本' }])
    expect(text).toContain('改好了')
    expect(text).toContain('用户-本.md')
    expect(refreshed).toBe(1)
  })

  it('那一项还没记过(404):把出路说出来,**不是一句「改不了」**', () => {
    const text = correctResultText({ status: 404, body: { error: '「① 开场」的 nickname 还没答过,没有可改的。第一次记用 /onboarding/answer。' } })
    expect(text.ok).toBe(false)
    expect(text.text).toContain(TOOL_RECORD_ANSWER)
    expect(text.text).toContain('别告诉他改不了')
  })

  it('工作台连不上:如实说没改上,不假装改好了', async () => {
    const workbench = { onboardingCorrect: async () => { throw new Error('连不上') } } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief })
    const text = String(await tools[TOOL_CORRECT_ANSWER].execute({ stage: 'opening', key: 'nickname', value: '本' }, {} as never))
    expect(text).toContain('没改上')
    expect(text).not.toContain('改好了')
  })

  it('缺 stage / key 时不发请求', async () => {
    let called = 0
    const workbench = { onboardingCorrect: async () => { called += 1; return { status: 200, body: {} } } } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief })
    expect(String(await tools[TOOL_CORRECT_ANSWER].execute({ stage: '', key: 'nickname', value: '本' }, {} as never))).toContain('没改上')
    expect(called).toBe(0)
  })
})

describe('count_workdays', () => {
  it('Ben 那一条:到 10 月 4 号,回话里带「那天是什么日子」与工作日数', async () => {
    const workbench = {
      onboardingWorkdays: async () => ({
        status: 200,
        body: {
          from: '2026-09-20', to: '2026-10-04', days: 15, workdays: 7, uncertain: true,
          text: '2026-09-20 到 2026-10-04 一共 15 天,中间有中秋节、国庆节,实际工作日 7 天(调休安排我这儿没有官方通知,没算进去 —— 真放起来可能比这个还少一两天)',
          target: { date: '2026-10-04', weekday: '周日', workday: false, why: '周末', uncertain: true },
        },
      }),
    } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief })
    const text = String(await tools[TOOL_COUNT_WORKDAYS].execute({ to: '2026-10-04' }, {} as never))
    expect(text).toContain('2026-10-04 是周日')
    expect(text).toContain('实际工作日 7 天')
    expect(text).toContain('别自己再算一遍')
  })

  it('算不成就说算不成,并且明令「别自己心算」', () => {
    const text = workdaysResultText({ status: 400, body: { error: '算不出来:to=十月四号' } })
    expect(text.ok).toBe(false)
    expect(text.text).toContain('别自己心算')
  })

  it('没给日期时不发请求', async () => {
    let called = 0
    const workbench = { onboardingWorkdays: async () => { called += 1; return { status: 200, body: {} } } } as unknown as Deps['workbench']
    const tools = createOnboardingTools({ workbench, brief })
    expect(String(await tools[TOOL_COUNT_WORKDAYS].execute({ to: '  ' }, {} as never))).toContain('你说的是几号')
    expect(called).toBe(0)
  })
})

describe('plan 这一项', () => {
  it('简报里的 calendar 读得出来;plan 的值当 JSON 还原', () => {
    const parsed = parseOnboardingBrief({ stage: 'projects', calendar: '今天是 2026-09-20', keys: [] })
    expect(parsed?.calendar).toBe('今天是 2026-09-20')
    expect(parseOnboardingBrief({ stage: 'projects', keys: [] })?.calendar).toBeUndefined()

    const value = coerceAnswerValue('plan', '{"project":"工作台","confirmed":true,"items":[{"title":"先跑通全流程"}]}')
    expect(value).toEqual({ project: '工作台', confirmed: true, items: [{ title: '先跑通全流程' }] })
  })
})

/**
 * 2026-09-21:②′ 多一问「各家客户端里记的东西,要不要拷一份过来」。
 *
 * 通话模式这边**一行代码都没改** —— 这一组用例就是来钉住"不用改"这件事的:
 * 要问什么从简报的 goals 来、值怎么写从 keys 来、答过了不再问从 answered 来,
 * 三样都是通用通道。哪天有人把它们改成白名单,这几条会当场红。
 */
describe('②′ 那一问「拷不拷各家的记忆」在电话里走得通', () => {
  const withImport = (): OnboardingBrief => brief({
    goals: [
      '这个项目是什么、给谁用',
      '最后再问一句:「你电脑上 Claude、Codex、Kimi 这几个里头,它们各自记着一些东西。'
      + '要不要我拷一份到我这边?我只读它们的,一个字都不改。」——答可以就把 import_memories 记成 true',
    ],
    keys: [
      { name: 'import_memories', kind: 'bool', desc: '各家客户端自己记的那些东西,拷不拷一份到事务官这边', required: false },
      { name: 'done', kind: 'bool', desc: '聊完了', required: true },
    ],
  })

  it('那一句话与那一项都进了系统提示(说得出来,也记得下)', () => {
    const text = buildOnboardingInstructions({ brief: withImport() })
    expect(text).toContain('要不要我拷一份到我这边')
    expect(text).toContain('import_memories')
    expect(text).toContain(TOOL_RECORD_ANSWER)
  })

  it('他说「不用了」:bool 认得出这是 false', () => {
    expect(coerceAnswerValue('bool', '否')).toBe(false)
    expect(coerceAnswerValue('bool', '不可以')).toBe(false)
    expect(coerceAnswerValue('bool', 'false')).toBe(false)
    expect(coerceAnswerValue('bool', '可以')).toBe(true)
  })

  it('答过了就不再问第二遍(answered 里有它,提示词里写着「不要再问一遍」)', () => {
    const answered = { ...withImport(), answered: { projects: ['import_memories'] } }
    const text = buildOnboardingInstructions({ brief: answered })
    expect(text).toContain('已经答过的(**不要再问一遍**)')
    expect(text).toContain('projects(import_memories)')
  })
})

/**
 * 「等你确认」那一条带上前因后果(2026-10-04,卡 `claude/ask-with-context`)。
 *
 * 维护者原话:「麻烦的是每次要确认内容的信息都很短,我都不知道发生了什么,还得自己去最近的会话找上下文,这个不好」。
 *
 * 这一份只管**问的是什么**那一半:`SessionAskView.question` 是洗过、截到 60 字的一句人话
 * (来电里念的、卡面上那一行、球下那一区的抬头都是它,一个字没改);新加的 `full` 是**那家弹窗里的原字**,
 * 点开那一条时摆给她看。原文只有弹窗那一问读得到(`by:'form'`),按内容判出来的那几条**缺席 ——
 * 不拿洗过的那句冒充原文**(「取不到就缺席,不编」)。
 *
 * 「它刚才在干什么」那一半不在这里:那是复用现有的 `GET /sessions/digest`(最近几轮)与
 * `GET /sessions/transcript`(整段对话),一条新接口都没加,所以用例在两端的界面上(见
 * tests/client-ask-context.test.tsx 与 butler-app/tests/askWithContext.test.tsx)。
 */
import { describe, expect, it } from 'vitest'
import { turnsOf } from '../src/server/sessionDigest.ts'
import { askViewOf, judgeWaiting } from '../src/server/waitingForYou.ts'

const SID = 'd9991aac-0000-4000-8000-000000000042'
const lines = (...rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n')
const human = (text: string, at: string) => ({
  type: 'user', sessionId: SID, cwd: '/Users/example/Documents/GitHub/desktop-workbench', timestamp: at,
  origin: { kind: 'human' }, message: { role: 'user', content: text },
})
const said = (text: string, at: string, stop: 'end_turn' | 'tool_use' = 'end_turn') => ({
  type: 'assistant', sessionId: SID, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop },
})
const toolUse = (id: string, name: string, input: Record<string, unknown>, at: string) => ({
  type: 'assistant', sessionId: SID, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
})
function claude(...rows: unknown[]) {
  const text = lines(...rows)
  return turnsOf('claude-transcript', { head: text, tail: text })
}

/**
 * 真机上那一问的形状(内容换成假的):**一百多字**的问句 + 带长说明的选项。
 * 洗过、截到 60 字之后她看见的就是开头那一截 —— 这正是维护者说的「信息很短,我都不知道发生了什么」。
 */
const LONG_QUESTION = [
  '导出 PDF 这件事有两条路:一条是在工作台里自己排版(字体、页边距都要自己定,好处是以后改样式不用动别人的东西);',
  '另一条是调系统的打印那一路(样子跟她在浏览器里按 ⌘P 一样,坏处是页眉页脚改不了)。',
  '你要哪一条?选完我就按这一条往下做,中途不再回来问你。',
].join('')
const LONG_NOTE = '自己排版:第一版大约两天,之后换字体换页边距都在工作台设置里点,不用等我改代码;缺点是她那台机器上没装的字体会退回默认那一个,拿到别人电脑上打开也可能换一个样子。'

describe('问的是什么:短的那一句照旧,原文全文另起一格(卡 claude/ask-with-context)', () => {
  it('弹窗那一问:question 照旧洗过截到 60 字,full 带原文全文与选项原字', () => {
    const turns = claude(
      human('加个导出 PDF', '2026-10-04T09:00:00.000Z'),
      toolUse('toolu_q', 'AskUserQuestion', {
        questions: [{
          question: LONG_QUESTION,
          header: '导出 PDF 走哪一条',
          multiSelect: false,
          options: [
            { label: '自己排版', description: LONG_NOTE },
            { label: '调系统打印那一路', description: '一天就能出第一版,页眉页脚改不了。' },
          ],
        }],
      }, '2026-10-04T09:01:00.000Z'),
    )
    const verdict = judgeWaiting(turns, { status: 'waiting', waiting_for: 'input needed', agent_name: 'Claude' })
    expect(verdict).toMatchObject({ waiting: true, kind: 'choose', by: 'form', rule: 'form:question' })

    // ① 那一句人话一个字没变:还是洗过、最多 60 字(来电念的、卡面那一行、球下抬头都认它)。
    expect(Array.from(verdict.question ?? '').length).toBeLessThanOrEqual(60)
    expect(verdict.question).not.toBe(LONG_QUESTION)

    // ② 原文全文在 full 里,一个字不少。
    expect(verdict.full?.question).toBe(LONG_QUESTION)
    expect(verdict.full?.header).toBe('导出 PDF 走哪一条')

    // ③ 选项也是原字:短的那一份 label 截 40 / note 截 60,full 里 LONG_NOTE 一个字不少。
    expect(verdict.options?.[0]?.note).not.toBe(LONG_NOTE)
    expect(verdict.full?.options).toEqual([
      { label: '自己排版', note: LONG_NOTE },
      { label: '调系统打印那一路', note: '一天就能出第一版,页眉页脚改不了。' },
    ])
  })

  it('askViewOf 把 full 原样带到 /state 那一格上(手机与电脑读的就是这一格)', () => {
    const turns = claude(
      human('加个导出 PDF', '2026-10-04T09:00:00.000Z'),
      toolUse('toolu_q', 'AskUserQuestion', {
        questions: [{ question: LONG_QUESTION, options: [{ label: '自己排版', description: LONG_NOTE }] }],
      }, '2026-10-04T09:01:00.000Z'),
    )
    const verdict = judgeWaiting(turns, { status: 'waiting', waiting_for: 'input needed' })
    const view = askViewOf(verdict, '2026-10-04T09:05:00.000Z', { reply: 'desk', where: '这一问得在电脑上的 Claude 里回答', press: true })
    expect(view?.full?.question).toBe(LONG_QUESTION)
    expect(view?.full?.options).toEqual([{ label: '自己排版', note: LONG_NOTE }])
    // 短的那一句照旧在 question 上(两格并存,谁也不顶谁)。
    expect(Array.from(view?.question ?? '').length).toBeLessThanOrEqual(60)
  })

  it('没有 header、选项是光秃秃的字符串:有的带上、没有的缺席,不补一个', () => {
    const turns = claude(
      human('菜系定一下', '2026-10-04T11:00:00.000Z'),
      toolUse('toolu_q', 'AskUserQuestion', { questions: [{ question: '晚饭吃哪一种?', options: ['川菜', '粤菜'] }] }, '2026-10-04T11:01:00.000Z'),
    )
    const verdict = judgeWaiting(turns, { status: 'waiting', waiting_for: 'input needed' })
    expect(verdict.full?.question).toBe('晚饭吃哪一种?')
    expect(verdict.full?.header).toBeUndefined()
    expect(verdict.full?.options).toEqual([{ label: '川菜' }, { label: '粤菜' }])
  })

  it('按内容判出来的那一条:full 缺席 —— 不拿洗过那句冒充原文', () => {
    const turns = claude(
      human('额度那边你看着办', '2026-10-04T08:40:00.000Z'),
      said([
        '剩下一件要你定:中转每天的额度上限,今天下午已经用掉 8.6 元。要不要提?三个选项:',
        '',
        '1. **提到 30 元**',
        '2. 保持 10 元',
        '3. 按天看',
        '',
        '你选哪个?回个数字就行。',
      ].join('\n'), '2026-10-04T09:02:11.000Z'),
    )
    const verdict = judgeWaiting(turns, { status: 'done', now: '2026-10-04T09:10:00.000Z', agent_name: 'Claude' })
    expect(verdict).toMatchObject({ waiting: true, by: 'rules' })
    expect(verdict.full).toBeUndefined()
    expect(askViewOf(verdict, '2026-10-04T09:10:00.000Z')?.full).toBeUndefined()
    // 依据那一句照旧在 quote 上(09-25 那条规矩:「它的原话」收着,点开才看)。
    expect(verdict.quote).toBeDefined()
  })

  it('等他批计划那一条:计划原文也算原文全文(她点开要看的就是那份计划)', () => {
    const turns = claude(
      human('先出个计划', '2026-10-04T06:00:00.000Z'),
      toolUse('toolu_p', 'ExitPlanMode', { plan: '## 计划\n1. 先读登记表\n2. 再改界面\n3. 最后补用例' }, '2026-10-04T06:02:00.000Z'),
    )
    const verdict = judgeWaiting(turns, {})
    expect(verdict).toMatchObject({ waiting: true, kind: 'approve', rule: 'form:plan' })
    expect(verdict.full?.question).toBe('## 计划\n1. 先读登记表\n2. 再改界面\n3. 最后补用例')
  })
})

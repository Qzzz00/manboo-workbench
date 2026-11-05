// @vitest-environment node
/**
 * **事务官在电话里介绍自己**(2026-10-13 夜,卡 V;维护者经工作台捎话:要加知识库、不能太自由发挥、通话中触发)。
 *
 * 这一包钉三件:① 人设里真有那一段、只标「介绍自己」那一个意图(闲聊回合默认不带、问她自己时才带);
 * ② 材料只有事实、带着边界(不是完全离线、不绕过询问),没有版本号 / 日期这种会过期的数;③ 不超上限。
 */
import { describe, expect, it } from 'vitest'
import { channelPersonaSections, PERSONA_CHAT_INTENTS } from '../src/server/channel.ts'
import { INTRO_INTENT, INTRO_KNOWLEDGE_LINES, INTRO_KNOWLEDGE_MAX_CHARS, INTRO_RULES_LINES, INTRO_SECTION_NAME, INTRO_THOUGHT_LINES } from '../src/server/introKnowledge.ts'

const INPUT = { rememberTool: 'wb_remember_item', doingTool: 'wb_list_doing', handTool: 'wb_hand_to_butler', inboxName: '收件' }
const chars = (text: string): number => [...text].length

describe('★介绍自己那一段', () => {
  it('人设里有它,只标 intro 这一个意图(不是必带、不按工具)', () => {
    const one = channelPersonaSections(INPUT).find(section => section.name === INTRO_SECTION_NAME)
    expect(one).toBeDefined()
    expect(one?.intents).toEqual([INTRO_INTENT])
    expect(one?.always).toBeUndefined()
    expect(one?.tool).toBeUndefined()
    expect(PERSONA_CHAT_INTENTS).toContain(INTRO_INTENT)
    expect(INTRO_SECTION_NAME).toBe('【介绍自己】')
    for (const line of [...INTRO_KNOWLEDGE_LINES, ...INTRO_THOUGHT_LINES, ...INTRO_RULES_LINES]) expect(one?.text).toContain(line)
  })

  /** ★ 官网 blog「事务官手记」六篇(卡 AA,维护者:「那是我专门准备用来显示我们的思考和产品哲学的」):一篇一条,题目带着,设想的标明还是设想。 */
  it('★「我们的想法」六条,一篇一条,题目在;设想类的明写还是设想 / 还在验证;没有日期', () => {
    const titles = ['AI 越来越快,人的时间去了哪里', '让 AI 从共同做事中学会分担', '桌上这部电话是怎么来的', '毕业以后,还能在哪里学会做事', 'AI 时代,为什么还是人在学习软件', '一个人做不了的事,能不能一起接下来']
    expect(INTRO_THOUGHT_LINES).toHaveLength(6)
    for (const title of titles) expect(INTRO_THOUGHT_LINES.some(line => line.includes(`《${title}》`)), title).toBe(true)
    const text = INTRO_THOUGHT_LINES.join('\n')
    expect(text).toMatch(/还是设想|还在验证|还在这条路上|不是成熟的体系/)
    expect(text).not.toMatch(/20\d\d/)
    expect(INTRO_RULES_LINES.join('\n')).toContain('我们的想法')
  })

  it('材料里有主句、给谁、三个入口、边界;没有版本号 / 日期 / 包办承诺', () => {
    const text = INTRO_KNOWLEDGE_LINES.join('\n')
    for (const must of ['桌上多一部电话', '独立工作者', '听筒', '手机', '电脑', '不是完全离线', '不会绕过', '随时接手或收回', '智能音箱', '小透明', '还在往这儿做']) {
      expect(text).toContain(must)
    }
    expect(text).not.toMatch(/0\.4\.\d+|20\d\d-\d\d|永不上传|你只做判断/)
    // 「完全离线」只许以「不是完全离线」的样子出现(AGENTS.md 的事实与数据边界)。
    expect(text.replace(/不是完全离线/g, '')).not.toContain('完全离线')
    expect(INTRO_RULES_LINES.join('\n')).toContain('只用上面这份材料')
  })

  it('整份不超上限(它每回合整份重发)', () => {
    expect(chars([...INTRO_KNOWLEDGE_LINES, ...INTRO_THOUGHT_LINES, ...INTRO_RULES_LINES].join('\n'))).toBeLessThanOrEqual(INTRO_KNOWLEDGE_MAX_CHARS)
  })
})

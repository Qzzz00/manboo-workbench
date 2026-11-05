/**
 * 对话屏字幕取哪一句(2026-09-24,维护者真机:称呼问了两遍)。见 src/client/firstrun/chatHerLine.ts。
 */
import { describe, expect, it } from 'vitest'
import { chatHerLine } from '../src/client/firstrun/chatHerLine.ts'

const OPENING = '你好,很高兴认识你,我是你的专属事务官。我能够帮助你更轻松、更有条理的经营你的事业,为了后面的工作能顺利开展,我需要对你和你正在做的事有一些了解,首先,你希望我怎么称呼你?'
const PROJECTS = '你想先把哪个项目交给我?说个名字就行,我先只录这一个。'

describe('chatHerLine', () => {
  it('★按钮流交过称呼与分岔后进对话屏:最后一句是开场问称呼(照念的种子句)→ 显示当前阶段的种子句,不再问一遍', () => {
    const turns = [{ seq: 1, role: 'assistant', text: OPENING, kind: 'seed' }]
    expect(chatHerLine(turns, PROJECTS)).toBe(PROJECTS)
  })

  it('模型照念时改了标点、没标上 seed:只要是问称呼那一问,当前阶段又不是问称呼,也算过去了', () => {
    const turns = [{ seq: 1, role: 'assistant', text: '你好!我是你的专属事务官。首先 —— 你希望我怎么称呼你?' }]
    expect(chatHerLine(turns, PROJECTS)).toBe(PROJECTS)
  })

  it('还在问称呼那一段(手机那条路、或还没答):照常显示那一句', () => {
    const turns = [{ seq: 1, role: 'assistant', text: OPENING, kind: 'seed' }]
    expect(chatHerLine(turns, OPENING)).toBe(OPENING)
  })

  it('模型已经接着说了新的一句(不是种子句):显示它', () => {
    const turns = [
      { seq: 1, role: 'assistant', text: OPENING, kind: 'seed' },
      { seq: 2, role: 'user', text: '叫我 Ben' },
      { seq: 3, role: 'assistant', text: '好,Ben。你想先把哪个项目交给我?' },
    ]
    expect(chatHerLine(turns, PROJECTS)).toBe('好,Ben。你想先把哪个项目交给我?')
  })

  it('一条事务官回合都没有 → 当前种子句;出错那条不算她说的', () => {
    expect(chatHerLine([], PROJECTS)).toBe(PROJECTS)
    expect(chatHerLine([{ seq: 1, role: 'assistant', text: '模型没接上', kind: 'error' }], PROJECTS)).toBe(PROJECTS)
    expect(chatHerLine([], undefined)).toBeUndefined()
  })

  it('照念的是当前阶段的种子句 → 就是它', () => {
    expect(chatHerLine([{ seq: 4, role: 'assistant', text: PROJECTS, kind: 'seed' }], PROJECTS)).toBe(PROJECTS)
  })
})

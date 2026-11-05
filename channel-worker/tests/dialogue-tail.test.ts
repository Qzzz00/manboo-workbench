/**
 * 通话里最近几句话的尾巴(2026-09-23):交引导答案时带给工作台的 heard 从这里取。
 * 取法与工作台回合表那一侧(onboardingConsent.lastExchange)同源。
 */
import { describe, expect, it } from 'vitest'
import { createDialogueTail } from '../src/dialogueTail.ts'

describe('createDialogueTail', () => {
  it('他还没开口 → undefined;他最后连着说的几句是 reply,那之前她最后一句是 asked', () => {
    const tail = createDialogueTail()
    expect(tail.heard()).toBeUndefined()
    tail.add('butler', '那我先给你摆成产品研发那一套,对吗?')
    tail.add('me', '对')
    expect(tail.heard()).toEqual({ asked: '那我先给你摆成产品研发那一套,对吗?', reply: '对' })
    tail.add('butler', '你现在是已经有在做的事,还是想从一个新点子开始?')
    tail.add('me', '嗯')
    tail.add('me', '已经有在做的')
    expect(tail.heard()).toEqual({ asked: '你现在是已经有在做的事,还是想从一个新点子开始?', reply: '嗯\n已经有在做的' })
    // 先说后记:她先应一句再交答案,不影响那一问一答。
    tail.add('butler', '好,已有项目的路子。')
    expect(tail.heard()).toEqual({ asked: '你现在是已经有在做的事,还是想从一个新点子开始?', reply: '嗯\n已经有在做的' })
  })
  it('她一问拆成几句说:asked 是他开口前她连着说的所有句子(09-23 真机连 409 六次)', () => {
    const tail = createDialogueTail()
    tail.add('me', '对的')
    tail.add('butler', '好,那我就记「工作台」这个项目。')
    tail.add('butler', '为了找到它,我得看一眼你放代码的那个目录,')
    tail.add('butler', '只看名字,可以吗?')
    tail.add('me', '可以啊,你看吧。')
    expect(tail.heard()).toEqual({
      asked: '好,那我就记「工作台」这个项目。\n为了找到它,我得看一眼你放代码的那个目录,\n只看名字,可以吗?',
      reply: '可以啊,你看吧。',
    })
  })
  it('只留最近几句;空白不收;reset 清空', () => {
    const tail = createDialogueTail(3)
    tail.add('butler', '问一')
    tail.add('me', '  ')
    tail.add('me', '答一')
    tail.add('me', '答二')
    tail.add('me', '答三')
    expect(tail.heard()).toEqual({ asked: '', reply: '答一\n答二\n答三' })
    tail.reset()
    expect(tail.heard()).toBeUndefined()
  })
})

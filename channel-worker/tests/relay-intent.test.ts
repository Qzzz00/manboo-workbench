/**
 * **电话里哪一句算她授权「盖掉草稿」「新开一条」**(2026-09-28,Air 维护包回源码;原脚本测试搬过来)。
 *
 * 只认她**这一句**明说的:疑问、否定、沾边的词(「新开餐厅」)一律不算授权。
 */
import { describe, expect, it } from 'vitest'
import { relayIntent } from '../src/relayIntent.ts'

describe('盖掉草稿:只认她明说', () => {
  it.each(['盖掉', '覆盖', '里面没有字，你盖掉。', '我都说盖掉了，你给我盖掉，让我给他发出去'])('「%s」→ 算', (said) => {
    expect(relayIntent(said).overwrite).toBe(true)
  })
  it.each(['不要盖掉', '别覆盖草稿', '能不能盖掉？', '覆盖是什么意思', '里面没有字'])('「%s」→ 不算', (said) => {
    expect(relayIntent(said).overwrite).toBe(false)
  })
})

describe('新开一条:只认她明说', () => {
  it.each(['新开一条', '新开一个窗口', '给豆包新建对话', '新开一个工作任务，新开一个绘画，再问一次。', '我让你新开', '点击那个新工作任务', '新开一条会话'])('「%s」→ 算', (said) => {
    expect(relayIntent(said).newConversation).toBe(true)
  })
  it.each(['不要新开一条', '新开餐厅', '看一下窗口', '不要新开', '我没让你新开', '别新开一个工作任务'])('「%s」→ 不算', (said) => {
    expect(relayIntent(said).newConversation).toBe(false)
  })
})

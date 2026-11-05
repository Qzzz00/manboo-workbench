/**
 * **没调成工具,不许说办了**(2026-10-12,卡「通话补一句不丢事」第 3 条;纪律同 D13:不说没发生的事)。
 *
 * 夹具是 10-12 真机那一句(`channel-worker.log` 第 2026 行前后,原话):
 *
 *   他:「有回音的打给我。」→ 闲聊、零工具 → 她:「[平静]好,派给 Claude 查为什么通话中换不了音色。有回音打给你。」
 *   jobs.jsonl 里 15:59 之后一条派活都没有。
 *
 * 判子在 claimGuard.ts(纯的),流上那一层也在那儿;agent.ts 只告诉它「这一回合有没有一件工具办成了」。
 */
import { describe, expect, it } from 'vitest'
import {
  claimOf,
  guardsTurn,
  honestLine,
  withHonestClaims,
} from '../src/claimGuard.ts'

const 真机那一句 = '[平静]好,派给 Claude 查为什么通话中换不了音色。有回音打给你。'

describe('★★ 哪一句是在说「办了」', () => {
  const claims: [string, string][] = [
    ['好,派给 Claude 查为什么通话中换不了音色。', 'dispatch'],
    ['有回音打给你。', 'callout'],
    ['派好了。', 'dispatch'],
    ['已经派给 Claude 了。', 'dispatch'],
    ['我这就派给 Claude。', 'dispatch'],
    ['换好了,现在是女声。', 'voice'],
    ['给你换成清亮那个了。', 'voice'],
    ['记下了。', 'remember'],
    ['好的,我把这条记下来了。', 'remember'],
    ['文件发给你了。', 'file'],
    ['话已经捎过去了。', 'relay'],
    ['挪到项目区下面了。', 'layout'],
  ]
  for (const [said, kind] of claims) {
    it(`「${said}」→ 说办了(${kind})`, () => {
      expect(claimOf(said)?.kind).toBe(kind)
    })
  }

  const honest: [string, string][] = [
    ['要我现在派给 Claude 吗？', '问句'],
    ['派给 Claude 还是 Codex?', '选择问'],
    ['我还没派出去。', '否定'],
    ['音色换女生的这个不是我能自己定的,得问你要哪种。', '真机那一句,没说办了'],
    ['换不了,这台没配音色服务。', '换不了'],
    ['刚才已经派给 Claude 了,还没回音。', '说的是之前的事'],
    ['好,我去安排。', '先应那一句'],
    ['好,我记一下。', '先应那一句'],
    ['好,我挑几个给你听。', '先应那一句'],
    ['如果要换的话,我先挑几个给你听。', '假设'],
    ['好。', '只是应一声'],
    ['', '空的'],
  ]
  for (const [said, why] of honest) {
    it(`「${said}」→ 不算(${why})`, () => {
      expect(claimOf(said)).toBeUndefined()
    })
  }
})

describe('★★ 改成如实的那一句', () => {
  it('★ 派活:还没派,问要不要现在派', () => {
    const line = honestLine('dispatch')
    expect(line).toContain('还没派')
    expect(line).toMatch(/[?？]$/u)
  })

  it('每一类都有一句,而且都是问句(她下一句「好」就是批准,分流会带工具)', () => {
    for (const kind of ['dispatch', 'relay', 'voice', 'remember', 'file', 'callout', 'layout'] as const) {
      expect(honestLine(kind)).toMatch(/还没.*[?？]$/u)
    }
  })
})

describe('★★ 哪些回合要拦', () => {
  it('闲聊回合拦(手上一件工具都没有,说办了一定是假的)', () => {
    expect(guardsTurn({ route: 'chat' })).toBe(true)
  })
  it('要办事的回合拦;认不出意图(全套工具)也拦', () => {
    expect(guardsTurn({ route: 'act', intents: ['dispatch'] })).toBe(true)
    expect(guardsTurn({ route: 'act', intents: ['lookup', 'voice'] })).toBe(true)
    expect(guardsTurn({ route: 'act' })).toBe(true)
  })
  it('只是查一眼 / 问状态的回合不拦(那里的「已经派了」是在报以前的事)', () => {
    expect(guardsTurn({ route: 'act', intents: ['lookup'] })).toBe(false)
    expect(guardsTurn({ route: 'act', intents: ['status', 'find'] })).toBe(false)
  })
})

/** 把一串块喂进去,收回来的全部字(字符串块与 delta.content 都算)与有没有工具块。 */
async function run(chunks: unknown[], options: { mayClaim?: boolean, active?: boolean } = {}) {
  const rewrites: [string, string][] = []
  const base = new ReadableStream<unknown>({
    start(controller) {
      for (const one of chunks) controller.enqueue(one)
      controller.close()
    },
  })
  const out = withHonestClaims(base, {
    active: options.active ?? true,
    mayClaim: () => options.mayClaim ?? false,
    onRewrite: (said, instead) => rewrites.push([said, instead]),
  })
  const got: unknown[] = []
  const reader = out.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    got.push(value)
  }
  const text = got.map((one) => {
    if (typeof one === 'string') return one
    const content = (one as { delta?: { content?: unknown } }).delta?.content
    return typeof content === 'string' ? content : ''
  }).join('')
  const tools = got.some(one => Array.isArray((one as { delta?: { toolCalls?: unknown[] } })?.delta?.toolCalls))
  return { text, tools, rewrites, got }
}

describe('★★ 流上那一层', () => {
  it('★ 真机那一句:没调工具 → 改成如实的一句,后面那句「有回音打给你」也不念', async () => {
    const { text, rewrites } = await run(['[平静]好,派给 Claude', ' 查为什么通话中换不了音色。', '有回音打给你。'])
    expect(text).not.toContain('派给 Claude 查')
    expect(text).not.toContain('打给你')
    expect(text).toContain('还没派')
    // 语气标签留着(手机拿它驱动表情)。
    expect(text.startsWith('[平静]')).toBe(true)
    expect(rewrites).toHaveLength(1)
    expect(rewrites[0]?.[0]).toContain('派给 Claude')
  })

  it('★ 同一步里跟着工具调用(「好,我派给 Claude。」+ 调 wb_dispatch_item)→ 原样放', async () => {
    const call = { id: 'c1', delta: { role: 'assistant', toolCalls: [{ name: 'wb_dispatch_item' }] } }
    const { text, tools, rewrites } = await run([
      { id: 'c1', delta: { role: 'assistant', content: '好,我这就派给 Claude。' } },
      call,
    ])
    expect(text).toBe('好,我这就派给 Claude。')
    expect(tools).toBe(true)
    expect(rewrites).toHaveLength(0)
  })

  it('这一回合已经有一件工具办成了 → 原样放(那是在报结果)', async () => {
    const { text, rewrites } = await run([真机那一句], { mayClaim: true })
    expect(text).toBe(真机那一句)
    expect(rewrites).toHaveLength(0)
  })

  it('不说办了的话一个字不动、不憋着(逐句放)', async () => {
    const { text, got } = await run(['你要哪一种?', '温柔还是清亮?'])
    expect(text).toBe('你要哪一种?温柔还是清亮?')
    expect(got).toHaveLength(2)
  })

  it('前面那句如实、后面那句说办了:前面照放,从说办了那句起换掉', async () => {
    const { text } = await run(['收到。', '记下了。', '回头提醒你。'])
    expect(text.startsWith('收到。')).toBe(true)
    expect(text).toContain('还没记下')
    expect(text).not.toContain('记下了')
  })

  it('关着(这一回合不拦)就原样返回那一条流', async () => {
    const { text } = await run([真机那一句], { active: false })
    expect(text).toBe(真机那一句)
  })

  it('最后半句没有句号也照样判', async () => {
    const { text } = await run(['好,派给 Claude 了'])
    expect(text).toContain('还没派')
  })
})

/* ──────── ★ 介绍自己那一回合不拦(2026-10-14 凌晨,卡 Z)──────── */

describe('★介绍自己那一回合不进「没办成不许说办了」那道闸', () => {
  it('intents 里有 intro → 不拦;别的闲聊 / 办事回合照旧', () => {
    expect(guardsTurn({ route: 'chat', intents: ['intro'] })).toBe(false)
    expect(guardsTurn({ route: 'chat' })).toBe(true)
    expect(guardsTurn({ route: 'act', intents: ['dispatch'] })).toBe(true)
  })
})


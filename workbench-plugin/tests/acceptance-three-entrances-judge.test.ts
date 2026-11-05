// @vitest-environment node
/**
 * 三入口验收脚本的判定器与句子集(2026-10-22,第 0 步「验收成制度」)。
 * 句子集是数据文件(`dev/acceptance-three-entrances/sentences.json`),判定器只认它的形状与观察记录;
 * 跑起实例、打三个入口的那一半不在这里(要真实例),见同目录 README。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type CardFact,
  type Observation,
  ENTRANCES,
  judge,
  loadSentences,
  looksLikeAsk,
  parseSentences,
  renderReport,
} from '../dev/acceptance-three-entrances/judge.ts'

const sentences = loadSentences()
const byId = (id: string) => {
  const one = sentences.find(s => s.id === id)
  if (one === undefined) throw new Error(`句子集里没有 ${id}`)
  return one
}

function card(over: Partial<CardFact> & { title: string }): CardFact {
  return { id: `t-${over.title}`, status: 'todo', session: false, dispatched: false, ...over }
}

function obs(sentence: string, entrance: Observation['entrance'], over: Partial<Observation> = {}): Observation {
  return { sentence, entrance, turns: [], newCards: [], ...over }
}

describe('句子集', () => {
  it('八句,id 不重,三个入口之外的不认', () => {
    expect(sentences.map(s => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])
    for (const s of sentences) {
      expect(s.turns.length).toBeGreaterThan(0)
      expect(s.expect.cards.length).toBeGreaterThan(0)
      for (const e of s.entrances) expect(ENTRANCES).toContain(e)
    }
  })

  it('旁人插话那一句只有电话入口,带着插进来的那段话', () => {
    const s7 = byId('s7')
    expect(s7.entrances).toEqual(['call'])
    expect(s7.bystander?.say).toBeTruthy()
    expect(s7.bystander?.asrMixed).toContain('充电器')
    // 电话那一路按「她说半句 → 旁人插一句 → 她说完」拼音频:断在哪要真在她那句里
    expect(s7.turns[0]).toContain(s7.bystander!.splitAfter)
  })

  it('形状不对就说清哪一句哪一格', () => {
    const raw = JSON.parse(readFileSync(new URL('../dev/acceptance-three-entrances/sentences.json', import.meta.url), 'utf8')) as { sentences: unknown[] }
    const broken = { ...raw, sentences: [{ id: 'x1', name: '缺 turns', entrances: ['desk'], expect: { rounds: 1, pushBacks: 0, cards: [] } }] }
    expect(() => parseSentences(broken)).toThrow(/x1.*turns/)
    const badEntrance = { ...raw, sentences: [{ id: 'x2', name: '入口写错', turns: ['a'], entrances: ['fax'], expect: { rounds: 1, pushBacks: 0, cards: [{ type: 'todo', must: ['a'] }] } }] }
    expect(() => parseSentences(badEntrance)).toThrow(/x2.*fax/)
  })
})

describe('推回认法', () => {
  it('问句、等她批都算推回;陈述句不算', () => {
    expect(looksLikeAsk('这件做了收不回来——现在就办吗?')).toBe(true)
    expect(looksLikeAsk('派给哪个?Claude 还是 Codex')).toBe(true)
    expect(looksLikeAsk('要我现在就派人去办吗')).toBe(true)
    // 工人的回话用全角问号(10-22 基线那一句)
    expect(looksLikeAsk('你说的是「周四下午把样片发给客户」吧？要让我按周四下午这条记进日历吗？')).toBe(true)
    expect(looksLikeAsk('要记进日历吗。')).toBe(true)
    expect(looksLikeAsk('记下了,周四下午把样片发给客户。')).toBe(false)
    expect(looksLikeAsk('好吧,记下了')).toBe(false)
    // 句中带「要不要」但整句是陈述(10-22 基线电话那一句)
    expect(looksLikeAsk('这件事只是记着,没人去办;到时候要不要真发,你说了算。')).toBe(false)
  })
})

describe('判定:记一笔(s1)', () => {
  const s1 = byId('s1')

  it('一张干净的待办、没派、回一句记下了 → 过', () => {
    const v = judge(s1, obs('s1', 'desk', {
      turns: [{ said: s1.turns[0]!, reply: '记下了,周四下午把样片发给客户。' }],
      newCards: [card({ title: '周四下午 把样片发给客户' })],
    }))
    expect(v.status).toBe('pass')
    expect(v.reasons).toEqual([])
  })

  it('10-22 那一下:反问收不收得回、一张卡没建 → 不过,先说没建成', () => {
    const v = judge(s1, obs('s1', 'call', {
      turns: [{ said: s1.turns[0]!, reply: '这件做了收不回来——现在就办吗?' }],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons[0]).toMatch(/没建成/)
    expect(v.reasons.join(';')).toMatch(/推回 1 次/)
    expect(v.reasons.join(';')).toMatch(/收不回/)
  })

  it('标题带原话前缀 → 不过,指出是哪几个字', () => {
    const v = judge(s1, obs('s1', 'desk', {
      turns: [{ said: s1.turns[0]!, reply: '已建下,记下了,没派给谁 —— 要谁去办再说一句。' }],
      newCards: [card({ title: '帮我记一件事:周四下午把样片发给客户' })],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons[0]).toMatch(/标题.*「帮我」/)
  })

  it('被派出去办了(在办、开了会话)→ 不过', () => {
    const v = judge(s1, obs('s1', 'call', {
      turns: [{ said: s1.turns[0]!, reply: '记下了,周四下午发样片给客户' }],
      newCards: [card({ title: '周四下午把样片发给客户', status: 'doing', session: true, dispatched: true })],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons[0]).toMatch(/派出去/)
  })

  it('等她批的单子也算推回', () => {
    const v = judge(s1, obs('s1', 'desk', {
      turns: [{ said: s1.turns[0]!, reply: '已建下,记下了样片那件', approvalsAdded: 1 }],
      newCards: [card({ title: '周四下午把样片发给客户' })],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons.join(';')).toMatch(/推回 1 次/)
  })

  it('回话没说记下、也没提样片(手机只显示「会话未开」)→ 不过', () => {
    const v = judge(s1, obs('s1', 'phone', {
      turns: [{ said: s1.turns[0]!, reply: '会话未开' }],
      newCards: [card({ title: '周四下午把样片发给客户' })],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons[0]).toMatch(/回话/)
  })

  it('跑的时候出了错:单独一档,不混进不过', () => {
    const v = judge(s1, obs('s1', 'desk', { error: '8893 没应答' }))
    expect(v.status).toBe('error')
    expect(v.reasons[0]).toMatch(/8893/)
  })
})

describe('判定:一句几件(s4 / s5 / s6)', () => {
  it('s4 三件各自落地:一张待办 + 一件派给 Claude + 换成女声 → 过', () => {
    const s4 = byId('s4')
    const v = judge(s4, obs('s4', 'call', {
      turns: [{ said: s4.turns[0]!, reply: '记下了周四发样片的待办,样片派给 Claude 剪一版了,换成女声了。' }],
      newCards: [
        card({ title: '周四下午给客户发样片' }),
        card({ title: '样片剪一版', assignee: 'claude', status: 'doing', dispatched: true }),
      ],
      voice: { before: 'zh_male_a', after: 'zh_female_b' },
    }))
    expect(v.status).toBe('pass')
  })

  it('s4 整句建成一张卡、音色没动 → 不过,先说张数', () => {
    const s4 = byId('s4')
    const v = judge(s4, obs('s4', 'desk', {
      turns: [{ said: s4.turns[0]!, reply: '已建下' }],
      newCards: [card({ title: '帮我建一个待办:周四下午给客户发样片,再把样片派…', status: 'doing', session: true, dispatched: true })],
      voice: { before: 'zh_male_a', after: 'zh_male_a' },
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons[0]).toMatch(/要 2 张.*1 张/)
    expect(v.reasons.join(';')).toMatch(/音色没变/)
  })

  it('s4 派给了别家不算', () => {
    const s4 = byId('s4')
    const v = judge(s4, obs('s4', 'call', {
      turns: [{ said: s4.turns[0]!, reply: '记下了待办,派给 Claude 了,换成女声了' }],
      newCards: [
        card({ title: '周四下午给客户发样片' }),
        card({ title: '样片剪一版', assignee: 'codex', status: 'doing', dispatched: true }),
      ],
      voice: { before: 'zh_male_a', after: 'zh_female_b' },
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons.join(';')).toMatch(/claude/)
  })

  it('s4 音色读不到 → 不过,说读不到(不当成换了)', () => {
    const s4 = byId('s4')
    const v = judge(s4, obs('s4', 'call', {
      turns: [{ said: s4.turns[0]!, reply: '记下了待办,派给 Claude 了,换成女声了' }],
      newCards: [card({ title: '周四下午给客户发样片' }), card({ title: '样片剪一版', assignee: 'claude', status: 'doing', dispatched: true })],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons.join(';')).toMatch(/音色读不到/)
  })

  it('s4 音色前后一样(本来就是女声):判「音色没变」,不当成换了', () => {
    const s4 = byId('s4')
    const v = judge(s4, obs('s4', 'call', {
      turns: [{ said: s4.turns[0]!, reply: '记下了待办,派给 Claude 了,换成女声了' }],
      newCards: [card({ title: '周四下午给客户发样片' }), card({ title: '样片剪一版', assignee: 'claude', status: 'doing', dispatched: true })],
      voice: { before: 'vivi 2.0·女·zh_female_vv', after: 'vivi 2.0·女·zh_female_vv' },
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons.join(';')).toMatch(/音色没变/)
  })

  it('同一张卡对不上好几张期望时,同一句原因只说一遍', () => {
    const s5 = byId('s5')
    const v = judge(s5, obs('s5', 'desk', {
      turns: [{ said: s5.turns[0]!, reply: '事项已建下' }],
      newCards: [card({ title: '记三条:周四发样片、周五交发票、下周一约 B 客户', status: 'doing', session: true, dispatched: true })],
    }))
    const dispatched = v.reasons.filter(r => r.includes('被派出去办了'))
    expect(dispatched).toHaveLength(1)
  })

  it('s5 三张各自干净 → 过;三条塞进一张 → 不过', () => {
    const s5 = byId('s5')
    const reply = '记下了三条。'
    const ok = judge(s5, obs('s5', 'phone', {
      turns: [{ said: s5.turns[0]!, reply }],
      newCards: [card({ title: '周四发样片' }), card({ title: '周五交发票' }), card({ title: '下周一约 B 客户' })],
    }))
    expect(ok.status).toBe('pass')
    const one = judge(s5, obs('s5', 'phone', {
      turns: [{ said: s5.turns[0]!, reply }],
      newCards: [card({ title: '记三条:周四发样片、周五交发票、下周一约 B 客户' })],
    }))
    expect(one.status).toBe('fail')
    expect(one.reasons[0]).toMatch(/要 3 张.*1 张/)
  })

  it('标题里的空格不算差别(「B 客户」与「B客户」)', () => {
    const s5 = byId('s5')
    const v = judge(s5, obs('s5', 'call', {
      turns: [{ said: s5.turns[0]!, reply: '记好了三条' }],
      newCards: [card({ title: '周四 发样片' }), card({ title: '周五交发票' }), card({ title: '下周一约B客户' })],
    }))
    expect(v.status).toBe('pass')
  })

  it('标题比对不分大小写(识别把「B 客户」转成了「b 客户」)', () => {
    const s5 = byId('s5')
    const v = judge(s5, obs('s5', 'call', {
      turns: [{ said: s5.turns[0]!, reply: '记好了三条' }],
      newCards: [card({ title: '周四发样片' }), card({ title: '周五交发票' }), card({ title: '下周一约 b 客户' })],
    }))
    expect(v.status).toBe('pass')
  })

  it('s6 说一半补一件:两张 → 过', () => {
    const s6 = byId('s6')
    const v = judge(s6, obs('s6', 'desk', {
      turns: [{ said: s6.turns[0]!, reply: '记下了两件:周四发样片、周五交发票' }],
      newCards: [card({ title: '周四发样片' }), card({ title: '周五交发票' })],
    }))
    expect(v.status).toBe('pass')
  })
})

describe('判定:挂着一句确认(s3)', () => {
  const s3 = byId('s3')

  it('先问一句、她说「好,去建吧」才建 → 过', () => {
    const v = judge(s3, obs('s3', 'call', {
      turns: [
        { said: s3.turns[0]!, reply: '周四下午给客户发样片,记成一条待办,对吗?' },
        { said: s3.turns[1]!, reply: '好,记下了。' },
      ],
      newCards: [card({ title: '周四下午给客户发样片' })],
    }))
    expect(v.status).toBe('pass')
  })

  it('铺垫那句没先问就建了,「好,去建吧」又建成一张 → 不过', () => {
    const v = judge(s3, obs('s3', 'desk', {
      turns: [
        { said: s3.turns[0]!, reply: '已建下,记下了,没派给谁' },
        { said: s3.turns[1]!, reply: '已建下' },
      ],
      newCards: [card({ title: '周四下午给客户发样片' }), card({ title: '好,去建吧' })],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons.join(';')).toMatch(/铺垫那句没先问/)
    expect(v.reasons.join(';')).toMatch(/要 1 张.*2 张/)
  })

  it('问了,但短句没被认下(什么都没建)→ 不过', () => {
    const v = judge(s3, obs('s3', 'call', {
      turns: [
        { said: s3.turns[0]!, reply: '记成一条待办,对吗?' },
        { said: s3.turns[1]!, reply: '' },
      ],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons[0]).toMatch(/没建成/)
  })
})

describe('判定:旁人插话(s7)', () => {
  const s7 = byId('s7')

  it('文字入口不适用 → n/a', () => {
    const v = judge(s7, obs('s7', 'desk'))
    expect(v.status).toBe('na')
  })

  it('拿不准问一句、没建卡 → 过', () => {
    const v = judge(s7, obs('s7', 'call', {
      turns: [{ said: s7.bystander!.asrMixed, reply: '刚才那句里混进了别人的话,你要记的是周四发样片那件吗?' }],
    }))
    expect(v.status).toBe('pass')
  })

  it('把别人的话也记成了卡 → 不过', () => {
    const v = judge(s7, obs('s7', 'call', {
      turns: [{ said: s7.bystander!.asrMixed, reply: '记下了' }],
      newCards: [card({ title: '周四下午把样片哎你们谁看见我充电器了…' })],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons.join(';')).toMatch(/别人的话/)
  })

  it('不问也不建 → 不过', () => {
    const v = judge(s7, obs('s7', 'call', { turns: [{ said: s7.bystander!.asrMixed, reply: '嗯' }] }))
    expect(v.status).toBe('fail')
  })
})

describe('判定:「发给客户」只在内容里(s8)', () => {
  it('问收不收得回 → 不过', () => {
    const s8 = byId('s8')
    const v = judge(s8, obs('s8', 'call', {
      turns: [{ said: s8.turns[0]!, reply: '这件要替你发出去,做了收不回来——现在就办吗?' }],
    }))
    expect(v.status).toBe('fail')
    expect(v.reasons.join(';')).toMatch(/收不回/)
  })
})

describe('结果表', () => {
  it('句 × 三入口,格子里是过 / 不过 + 一句原因;下面逐格细节', () => {
    const s1 = byId('s1')
    const s7 = byId('s7')
    const results = [
      { sentence: s1, entrance: 'desk' as const, observation: obs('s1', 'desk', { turns: [{ said: s1.turns[0]!, reply: '记下了周四发样片' }], newCards: [card({ title: '周四下午把样片发给客户' })] }) },
      { sentence: s1, entrance: 'call' as const, observation: obs('s1', 'call', { turns: [{ said: s1.turns[0]!, reply: '这件做了收不回来——现在就办吗?' }] }) },
      { sentence: s7, entrance: 'desk' as const, observation: obs('s7', 'desk') },
    ]
    const md = renderReport({ title: '验收 · 三入口同一组句子 · 测试', meta: ['提交 abc1234'], sentences: [s1, s7], results })
    expect(md).toMatch(/\| 句 \| 电脑对话框 \| 手机文字 \| 电话 \|/)
    expect(md).toMatch(/\| s1 记一件事.*\| ✔ 过 \| — 没跑 \| ✘ 没建成/)
    expect(md).toMatch(/\| s7 .*\| n\/a/)
    expect(md).toMatch(/### s1 · 电话/)
    expect(md).toContain('这件做了收不回来——现在就办吗?')
    // 格子里不能有竖线(会把表撑坏)
    for (const line of md.split('\n').filter(l => l.startsWith('| s'))) expect(line.split('|').length).toBe(6)
  })

  it('电话再打一遍文字口:多一列「电话·文字口」,判法与电话那一列相同', () => {
    const s1 = byId('s1')
    const results = [
      { sentence: s1, entrance: 'call' as const, observation: obs('s1', 'call', { turns: [{ said: s1.turns[0]!, reply: '' }] }) },
      { sentence: s1, entrance: 'call' as const, column: 'callText' as const, observation: obs('s1', 'call', { turns: [{ said: s1.turns[0]!, reply: '记下了,周四下午把样片发给客户' }], newCards: [card({ title: '周四下午把样片发给客户' })] }) },
    ]
    const md = renderReport({ title: 't', meta: [], sentences: [s1], results })
    expect(md).toMatch(/\| 句 \| 电脑对话框 \| 手机文字 \| 电话 \| 电话·文字口 \|/)
    expect(md).toMatch(/\| s1 .*\| ✘ 没建成卡 \| ✔ 过 \|$/m)
    expect(md).toMatch(/### s1 · 电话·文字口/)
  })
})

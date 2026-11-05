// @vitest-environment node
/**
 * **豆包问出一道题 → 座机响 → 开场就是那道题**(2026-10-12,周三演示那条路)。
 *
 * 夹具沿用 `fixtures/doubao-read-asking-20260928.json`(Air 上豆包那一刻的真机读数);
 * 这里换着包标识喂进去 —— 豆包 / 豆包办公 / 豆包工作 一律按「豆包」这一家认,判断里不写包名。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CallOutEntry, SessionAskView } from '../src/protocol.ts'
import { bundleIdsOf, bindingFor, familyAsksInWindow } from '../src/server/agentSources.ts'
import { doubaoVisibleForm, parseRead, transcriptRows } from '../src/server/agentWindowModel.ts'
import { askLanded } from '../src/server/askLanded.ts'
import { planCallOuts, promoteLiveAsks, type CallOutEvent } from '../src/server/callOut.ts'
import { readRelayEvidence, writeAskAllowed } from '../src/server/engine/adapters/window.ts'
import { sessionAskCallOutEvents } from '../src/server/sessionAskCalls.ts'

const RAW = JSON.parse(readFileSync(new URL('./fixtures/doubao-read-asking-20260928.json', import.meta.url), 'utf8')) as Record<string, unknown>
const READ = parseRead(RAW)
const DOUBAO_PACKAGES = bundleIdsOf(bindingFor('doubao'))

describe('豆包一家多包:按家族认「窗口里摆着的那道题」', () => {
  it('★三个包(豆包 / 豆包工作 / App Store 版)都认,别家不认', () => {
    expect(DOUBAO_PACKAGES.length).toBeGreaterThanOrEqual(3)
    for (const bundle of DOUBAO_PACKAGES) expect(familyAsksInWindow(bundle)).toBe(true)
    expect(familyAsksInWindow('im.manus.desktop')).toBe(false)
    expect(familyAsksInWindow('com.openai.codex')).toBe(false)
  })

  it('★写进它那个提问面板:三个包都开着,别家关着', () => {
    for (const bundle of DOUBAO_PACKAGES) expect(writeAskAllowed(bundle)).toBe(true)
    expect(writeAskAllowed('im.manus.desktop')).toBe(false)
  })

  it('★read_reply 认不出时读整扇窗再找:三个包都走这条退路', async () => {
    for (const bundle of DOUBAO_PACKAGES) {
      const helper = { request: async (req: { op: string }) => req.op === 'read_reply' ? { ok: true, result: { found: false } } : RAW }
      const got = await readRelayEvidence(helper, bundle, '中秋节月饼的事情')
      expect(got.ok && got.result.found).toBe(true)
    }
  })

  it('「在哪儿等你」那一句用这一家的名字,不写死「豆包办公」', () => {
    expect(doubaoVisibleForm(READ, undefined, 'now', '豆包')?.where).toBe('豆包正在等你选择')
  })
})

describe('来电带着原题与选项(开场逐字念那一句的出处)', () => {
  const ask = doubaoVisibleForm(READ, undefined, '2026-10-12T02:00:00.000Z', '豆包办公') as SessionAskView

  it('★事件里有完整问题(不截断)与每个选项', () => {
    const [event] = sessionAskCallOutEvents({ sessions: [{ agent: 'doubao', name: '豆包办公', session_id: 'window:月饼', ask }] })
    expect(event?.ask).toEqual({ from: '豆包办公', question: ask.question, options: ['选购/对比月饼', '写文案/做海报', '其他想法'] })
    expect(event?.item_id).toContain('window:月饼')
  })

  it('★排出来的那一通也带着它(工人领到的就是台账那一条)', () => {
    const [event] = sessionAskCallOutEvents({ sessions: [{ agent: 'doubao', name: '豆包办公', session_id: 'window:月饼', ask }] })
    const plan = planCallOuts({ events: [event as CallOutEvent], seen: new Set(), waiting: [], now: Date.parse('2026-10-12T02:00:01Z'), quiet: { from: '23:00', to: '08:00' }, newId: () => 'c1' })
    expect(plan.created[0]?.ask?.question).toBe(ask.question)
    expect(plan.created[0]?.silent).toBe(false)
  })
})

describe('新的一问领开场:排着还没响的旧一问不抢', () => {
  const NOW = Date.parse('2026-10-12T10:00:00Z')
  const old: CallOutEntry = {
    id: 'old', key: 'ask:session:window:旧:2026-10-12T08:00:00.000Z', reason: 'ask', item_id: 'session:codex/旧', title: 'Codex 在等你选:午饭吃什么',
    at: '2026-10-12T08:00:00.000Z', state: 'queued', silent: false, queued_at: '2026-10-12T08:00:00.000Z', due_at: '2026-10-12T08:00:00.000Z',
  }
  const fresh: CallOutEvent = {
    key: 'ask:session:window:饮料:2026-10-12T09:59:58.000Z', reason: 'ask', item_id: 'session:doubao/window:饮料', title: '豆包 在等你选:你喜欢喝什么饮料？',
    at: '2026-10-12T09:59:58.000Z', ask: { from: '豆包', question: '你喜欢喝什么饮料？', options: ['可乐', '茶', '咖啡'] },
  }

  it('★旧那一通还排着(房里一直没手机)→ 新的这一问当主角,旧的排到后面', () => {
    const plan = planCallOuts({ events: [fresh], seen: new Set(), waiting: [old], now: NOW, quiet: { from: '23:00', to: '08:00' } })
    expect(plan.merged).toEqual([{ id: 'old', event: fresh, lead: true }])
  })

  it('旧那一通已经在响(她正听着)→ 照旧并进去,不改正在说的那件', () => {
    const plan = planCallOuts({ events: [fresh], seen: new Set(), waiting: [{ ...old, state: 'ringing' }], now: NOW, quiet: { from: '23:00', to: '08:00' } })
    expect(plan.merged).toEqual([{ id: 'old', event: fresh }])
  })

  it('★主角那一问没了、并进来的那一问还在 → 让还在的那一问当主角(不拿一句假话开场)', () => {
    const entry: CallOutEntry = { ...old, merged: [{ item_id: fresh.item_id, title: fresh.title }] }
    const out = promoteLiveAsks([entry], [fresh])
    expect(out).toEqual([{ ...entry, key: fresh.key, item_id: fresh.item_id, title: fresh.title, at: fresh.at, ask: fresh.ask, merged: [] }])
    expect('note' in (out[0] as CallOutEntry)).toBe(false)
  })

  it('主角还在 / 已在响 / 没有并进来的 → 一条都不动', () => {
    expect(promoteLiveAsks([old], [fresh])).toEqual([])
    expect(promoteLiveAsks([{ ...old, merged: [{ item_id: fresh.item_id, title: fresh.title }] }], [fresh, { ...fresh, key: old.key as string, item_id: old.item_id }])).toEqual([])
    expect(promoteLiveAsks([{ ...old, state: 'ringing', merged: [{ item_id: fresh.item_id, title: fresh.title }] }], [fresh])).toEqual([])
  })
})

describe('电话里说「第二个」也认得出是哪一项', () => {
  const options = [{ label: '可乐' }, { label: '绿茶' }, { label: '美式咖啡' }]
  it('★第几个 / 最后一个 → 那一项', async () => {
    const { spokenOptionOf } = await import('../src/server/butlerAsks.ts')
    expect(spokenOptionOf(options, '第二个')?.label).toBe('绿茶')
    expect(spokenOptionOf(options, '选第一个吧。')?.label).toBe('可乐')
    expect(spokenOptionOf(options, '第3个')?.label).toBe('美式咖啡')
    expect(spokenOptionOf(options, '最后一个')?.label).toBe('美式咖啡')
  })
  it('说的就是选项原话 → 照旧按原话认;超出范围 / 听不出 → 不替她挑', async () => {
    const { spokenOptionOf } = await import('../src/server/butlerAsks.ts')
    expect(spokenOptionOf(options, '绿茶')?.label).toBe('绿茶')
    expect(spokenOptionOf(options, '第五个')).toBeUndefined()
    expect(spokenOptionOf(options, '都行')).toBeUndefined()
    expect(spokenOptionOf([{ label: '第一个方案' }, { label: '第二个方案' }], '第二个方案')?.label).toBe('第二个方案')
  })
})

/* ───────── 替她答完「到底办成了没有」:看窗口里新冒出来的行(2026-10-13 下午,卡 C)───────── */

describe('★★ 替她答完按「新冒出来的行」判,不看壳的回执', () => {
  const PLAIN = JSON.parse(readFileSync(new URL('./fixtures/doubao-read-asking-20261013.json', import.meta.url), 'utf8')) as Record<string, unknown>
  /** 10-13 09:18 普通包那一刻的真窗口 = 「送之前」那一份底子。 */
  const before = transcriptRows(parseRead(PLAIN))

  it('★主对话区那几行读得出来:题、四个选项都在;右边那一栏与输入框里的字不算', () => {
    expect(before).toContain('我最想喝哪种饮料？')
    for (const label of ['可乐', '茶', '咖啡', '果汁']) expect(before).toContain(label)
    // 右侧摘要那一栏(x 在输入框右边)一行都不收
    expect(before).not.toContain('对话摘要')
    expect(before).not.toContain('最近文件')
  })

  it('★★ 答案词送之前就在屏上当选项 —— 所以按「有没有」判一定成立,必须按**新冒出来的行**判', () => {
    // 送之前「咖啡」已经出现在三行里(对话标题、她那句出题的话、选项标签)
    expect(before.filter(line => line.includes('咖啡')).length).toBeGreaterThan(1)
    // 什么都没变 → 不算办成(这正是壳那三档里「送后才出现」成立不了的同一个原因)
    expect(askLanded({ before, after: before, answer: '咖啡' }).landed).toBe(false)
  })

  it('★打字回退之后它那边冒出「收到:咖啡」→ 算办成了,带回那一行', () => {
    const after = [...before, '咖啡', '收到:咖啡']
    const got = askLanded({ before, after, answer: '咖啡' })
    expect(got.landed).toBe(true)
    expect(got.lines).toEqual(['咖啡', '收到:咖啡'])
    expect(got.before).toBe(3)
    expect(got.after).toBe(5)
  })

  it('只多出她自己那一句(它还没回)也算送进去了 —— 那一句就在对话区里', () => {
    expect(askLanded({ before, after: [...before, '咖啡'], answer: '咖啡' }).landed).toBe(true)
  })

  it('一个字的选项同样算得清(「茶」)', () => {
    expect(askLanded({ before, after: [...before, '收到:茶'], answer: '茶' }).landed).toBe(true)
    expect(askLanded({ before, after: before, answer: '茶' }).landed).toBe(false)
  })

  it('并过空白与标点再比(「收到: 咖啡 」与「收到:咖啡」算同一行)', () => {
    expect(askLanded({ before, after: [...before, '收到: 咖啡 '], answer: '咖 啡' }).landed).toBe(true)
  })

  it('★读不到就如实说不知道:没量到底子 / 送完那一下读不到 / 答案是空的 —— 一律不算办成', () => {
    const after = [...before, '收到:咖啡']
    expect(askLanded({ after, answer: '咖啡' }).landed).toBe(false)
    expect(askLanded({ before, answer: '咖啡' }).landed).toBe(false)
    expect(askLanded({ before, after, answer: '  ' }).landed).toBe(false)
    for (const one of [askLanded({ after, answer: '咖啡' }), askLanded({ before, answer: '咖啡' })]) {
      expect(one.why).not.toBe('')
    }
  })

  it('它那边回的是别的事(没提到答案)→ 不算办成', () => {
    expect(askLanded({ before, after: [...before, '我先去查一下天气'], answer: '咖啡' }).landed).toBe(false)
  })
})

/* ───── 16:33 那一通判漏的两处:按条数算 + 面板收起来(2026-10-13 傍晚,卡 J)───── */

describe('★★ 判漏之一:答完面板收起来了 —— 提到答案的行反而变少', () => {
  const PLAIN = JSON.parse(readFileSync(new URL('./fixtures/doubao-read-asking-20261013.json', import.meta.url), 'utf8')) as Record<string, unknown>
  /** 送之前:题、四个选项行 + 四段说明都摆在屏上。 */
  const before = transcriptRows(parseRead(PLAIN))
  /** 那个提问面板在窗口里画着的九行(答完就整块没了)。 */
  const PANEL_ROWS = [
    '我最想喝哪种饮料？',
    '可乐', '冰爽气泡，刺激过瘾',
    '茶', '清香回甘，解腻提神',
    '咖啡', '醇厚提神，工作好搭档',
    '果汁', '鲜甜自然，健康清爽',
  ]
  /** 面板那几行的记号 = 四个选项 + 它那一句原话(`askPanelMarksOf` 给的就是这一份)。 */
  const PANEL = ['可乐', '茶', '咖啡', '果汁', '我最想喝哪种饮料？']
  /** 答完那一刻:面板整块没了,她那句「咖啡」成了对话里的一个气泡(豆包还没回话)。 */
  const afterPanelGone = [...before.filter(one => !PANEL_ROWS.includes(one)), '咖啡']

  it('★提到答案的行一条没多(送之前 3 行、送完还是 3 行),可那个面板没了 → 照样算办成', () => {
    const got = askLanded({ before, after: afterPanelGone, answer: '咖啡', panel: PANEL })
    expect(got.before).toBe(3)
    expect(got.after).toBe(3)
    expect(got.landed).toBe(true)
    expect(got.by).toBe('panel_gone')
    expect(got.why).toContain('面板')
  })

  it('★面板那几行还摆着、也没新行 → 照旧不算办成,why 说清面板还在', () => {
    const got = askLanded({ before, after: before, answer: '咖啡', panel: PANEL })
    expect(got.landed).toBe(false)
    expect(got.why).toContain('没多出来')
    expect(got.why).toContain('面板')
  })

  it('面板只走丢一行(滚动 / 读数抖一下)→ 不算答掉了', () => {
    const scrolled = before.filter(one => one !== '可乐')
    expect(askLanded({ before, after: scrolled, answer: '咖啡', panel: PANEL }).landed).toBe(false)
  })

  it('答案那一项本身不算凭据(她那句气泡照样画着「咖啡」)—— 别的几项全没了才算', () => {
    // 只剩「咖啡」那一行(= 她的气泡),别的三项与题都没了 → 算答掉了
    expect(askLanded({ before, after: [...before.filter(one => !PANEL_ROWS.includes(one)), '咖啡'], answer: '咖啡', panel: PANEL }).by).toBe('panel_gone')
    // 反过来:只有「咖啡」那一行没了(她的气泡还没画出来),别的三项还摆着 → 不算
    expect(askLanded({ before, after: before.filter(one => one !== '咖啡'), answer: '咖啡', panel: PANEL }).landed).toBe(false)
  })

  it('★新冒出来的行按**集合差**算,不按条数:面板带走一行、它回了一行 → 条数没变也算办成', () => {
    const got = askLanded({ before, after: [...afterPanelGone, '收到:咖啡'], answer: '咖啡', panel: PANEL })
    expect(got.landed).toBe(true)
    expect(got.by).toBe('new_line')
    expect(got.lines).toEqual(['收到:咖啡'])
  })

  it('它回的那一行以「收到」开头、认不出答案原字 → 照样算办成', () => {
    expect(askLanded({ before, after: [...afterPanelGone, '收到:第三个'], answer: '咖啡', panel: PANEL }).landed).toBe(true)
  })

  it('没带面板那一份记号时 → 只按新冒出来的行判,why 一个字不提面板', () => {
    const got = askLanded({ before, after: before, answer: '咖啡' })
    expect(got.landed).toBe(false)
    expect(got.why).not.toContain('面板')
  })
})

describe('普通包工作模式「没找到「咖啡」这一项」:读数里查得到的凭据', () => {
  const PLAIN = JSON.parse(readFileSync(new URL('./fixtures/doubao-read-asking-20261013.json', import.meta.url), 'utf8')) as Record<string, unknown>

  it('★四个选项标签既没有 `r` 也没有 `ctl` —— 它们不在 Button / PopUp / Menu / Link 底下', () => {
    const rows = (PLAIN.tail as readonly Record<string, unknown>[]).filter(row => ['可乐', '茶', '咖啡', '果汁'].includes(String(row.t ?? '').trim()))
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.ctl).toBeUndefined()
      expect(row.r).toBeUndefined()
    }
  })

  it('题认得出、四项齐全(认法这一头没有问题)—— 没点上的原因只能在壳那一侧', () => {
    const ask = doubaoVisibleForm(parseRead(PLAIN), undefined, '2026-10-13T01:18:00.000Z', '豆包')
    expect(ask?.options?.map(one => one.label)).toEqual(['可乐', '茶', '咖啡', '果汁'])
    expect(ask?.press).toBe(true)
  })
})

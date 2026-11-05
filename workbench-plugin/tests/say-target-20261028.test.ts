// @vitest-environment node
/**
 * 「这句话指哪张卡、要对它做什么」的单一解析器(2026-10-28,卡「机制退修任务书-接续对题与改派语义」)。
 * 09:30–09:40 三处断点同根:接续不按对题、卡号不认、「改派」被当改名。这里钉解析器本身;
 * 三入口重放走 server-say-directives-1028.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { namesDispatchable } from '../src/server/sayCards.ts'
import {
  ambiguousSayLine, cardIdMentioned, continuationOf,
  missingCardSayLine, noMatchSayLine, reassignSayLine,
  resolveSayCardTarget,
  type SayTargetLedgerEntry, type SayTargetTask,
} from '../src/server/sayTarget.ts'

const NOW = Date.parse('2026-10-28T09:40:00.000Z')
const BOARD: SayTargetTask[] = [
  { id: 't-c323ffa6', title: '查工作台 8791 进程的空转热点', status: 'doing', assignee: 'agent:g1' },
  { id: 't-ea1e8702', title: '修手机 App 远程连回电脑时 LiveKit 重连竞态', status: 'blocked', assignee: 'agent:g1' },
]
/** 账里最新的是 8791 热点(t-c323ffa6),「手机 App」那张在它前面 —— 对题与最近的考题就在这。 */
const LEDGER: SayTargetLedgerEntry[] = [
  { at: NOW - 5 * 60_000, items: [{ kind: '办', title: '修手机 App 远程连回电脑时 LiveKit 重连竞态', card_id: 't-ea1e8702' }] },
  { at: NOW - 1 * 60_000, items: [{ kind: '办', title: '查工作台 8791 进程的空转热点', card_id: 't-c323ffa6' }] },
]
const GOALS = [
  { id: 'g-1023dev', title: '周五(10-23)把仓库交接给研发', status: 'open' as const },
]

describe('卡号', () => {
  it('认 t-xxxxxxxx,大写归一,后面还拖着十六进制的不认', () => {
    expect(cardIdMentioned('t-c323ffa6 的标题改回「查工作台 8791 进程的空转热点」')).toBe('t-c323ffa6')
    expect(cardIdMentioned('把 T-EA1E8702 标成达成')).toBe('t-ea1e8702')
    expect(cardIdMentioned('t-c323ffa6789 不是卡号')).toBeUndefined()
    expect(cardIdMentioned('没有卡号')).toBeUndefined()
  })

  it('有卡号就按卡号定位,不翻 say 账「上一件」', () => {
    const target = resolveSayCardTarget({ said: 't-ea1e8702 负责人换成小K、重新派出去', tasks: BOARD, ledger: LEDGER, nowMs: NOW })
    expect(target).toMatchObject({ kind: 'card', via: 'card_id' })
  })

  it('卡号找不到 = missing_card(「没拿着卡」,不说「上一件没拿着」)', () => {
    const target = resolveSayCardTarget({ said: '把 t-deadbeef 改派给小K', tasks: BOARD, ledger: LEDGER, nowMs: NOW })
    expect(target).toMatchObject({ kind: 'missing_card', id: 't-deadbeef' })
    expect(missingCardSayLine('t-deadbeef')).toContain('t-deadbeef')
  })
})

describe('接续对题,不按最近', () => {
  it('摘话题:「刚才手机 App 那件」→ 手机 App;光秃回指只有 cue', () => {
    expect(continuationOf('刚才手机 App 那件,小G 的额度用完了,改派给小K')).toMatchObject({ cue: true, topic: '手机 App' })
    expect(continuationOf('上一件改一下')).toEqual({ cue: true })
    expect(continuationOf('记一下周四发样片')).toEqual({ cue: false })
  })

  it('账里最新的是 8791 热点,可「手机 App」对题落到 LiveKit 那张(09:35 的修法)', () => {
    const target = resolveSayCardTarget({ said: '刚才手机 App 那件,小G 的额度用完了,改派给小K', tasks: BOARD, ledger: LEDGER, nowMs: NOW })
    expect(target).toMatchObject({ kind: 'card', via: 'topic', task: { id: 't-ea1e8702' } })
  })

  it('对多张 = ambiguous,回候选,不猜;对不上 = no_match,不拿最近顶', () => {
    const ledgerBoth: SayTargetLedgerEntry[] = [{
      at: NOW - 1_000,
      items: [
        { kind: '办', title: '修手机 App 远程连回电脑时 LiveKit 重连竞态', card_id: 't-ea1e8702' },
        { kind: '办', title: '手机 App 首页离线排查', card_id: 't-c323ffa6' },
      ],
    }]
    const ambiguous = resolveSayCardTarget({ said: '刚才手机 App 那件改派给小K', tasks: BOARD, ledger: ledgerBoth, nowMs: NOW })
    expect(ambiguous.kind).toBe('ambiguous')
    if (ambiguous.kind === 'ambiguous') {
      expect(ambiguous.candidates).toHaveLength(2)
      expect(ambiguousSayLine(ambiguous.topic, ambiguous.candidates)).toContain('你说卡号')
    }
    const none = resolveSayCardTarget({ said: '刚才不存在的那个改派给小K', tasks: BOARD, ledger: LEDGER, nowMs: NOW })
    expect(none.kind).toBe('no_match')
    if (none.kind === 'no_match') expect(noMatchSayLine(none.topic)).toContain(none.topic)
  })

  it('光秃「刚才那件」退回账里最后一件带卡的(旧行为,一字不变)', () => {
    const target = resolveSayCardTarget({ said: '刚才那件改一下', tasks: BOARD, ledger: LEDGER, nowMs: NOW })
    expect(target).toMatchObject({ kind: 'card', via: 'last', task: { id: 't-c323ffa6' } })
  })

  it('超出 10 分钟窗的账不算数(窗口由调用方传,不第二份定义)', () => {
    const stale: SayTargetLedgerEntry[] = [{ at: NOW - 11 * 60_000, items: [{ kind: '办', title: '修手机 App 远程连回电脑时 LiveKit 重连竞态', card_id: 't-ea1e8702' }] }]
    const target = resolveSayCardTarget({ said: '刚才手机 App 那件改派给小K', tasks: BOARD, ledger: stale, nowMs: NOW, ledgerWindowMs: 10 * 60_000 })
    expect(target.kind).toBe('no_match')
  })
})

describe('回话模板(断言同源,不逐字抄)', () => {
  it('改派那句:卡号 + 已改派给谁 + 原来那次已停', () => {
    expect(reassignSayLine('t-ea1e8702', '小K', '小G', true)).toBe('t-ea1e8702 已改派给小K,原来小G那次已停。')
    expect(reassignSayLine('t-ea1e8702', '小K', undefined, false)).toBe('t-ea1e8702 已改派给小K。')
  })

})

describe('点名识别(抱怨句式不压过点名;调用方只传名片,家名不算——09-28 拍板不冲突)', () => {
  const ENTRIES = [
    { id: 'agent:k1', title: '小K(重生版)' },
    { id: 'agent:c1', title: 'Codex' },
  ]
  it('点名了名片 = 认得出(大小写、括号前那一段都算)', () => {
    expect(namesDispatchable('让小K把事务官窗里『在跑的事项』显示 0 的问题修了', ENTRIES)).toBe('小K(重生版)')
    expect(namesDispatchable('让 codex 去查一下', ENTRIES)).toBe('Codex')
    expect(namesDispatchable('事务官窗里『在跑的事项』显示 0,修一下', ENTRIES)).toBeUndefined()
  })
  it('单字不认(太泛)', () => {
    expect(namesDispatchable('小K', [{ id: 'agent:k1', title: '小K(重生版)' }])).toBe('小K(重生版)')
    expect(namesDispatchable('只看一个字的', [{ id: 'k', title: 'K' }])).toBeUndefined()
  })
})

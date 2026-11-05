// @vitest-environment node
/**
 * 工作台自己的提议:PRD §9 的三条强制门槛(W4)。
 *
 * 这三条是**代码层门槛**,不是文案约定——系统具备自我迭代能力,提议流程必须够不着
 * 这三条。今天没有提议源,门槛的输入恒为空,但门槛本身要能被单测穷举。
 */
import { describe, expect, it } from 'vitest'
import { admissibleProposals, type Proposal } from '../src/client/proposals.ts'

const TODAY = '2026-08-25'

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    layer: 'feature',
    module_id: 'projects',
    text: '把项目区默认排序改成按 DDL',
    evidence_days: ['2026-08-23', '2026-08-24', '2026-08-25'],
    preview: '预览:排序从「最近活跃」改为「DDL 最近」',
    adopted: false,
    ...over,
  }
}

describe('admissibleProposals(PRD §9 三条门槛)', () => {
  it('今天没有提议源:空进空出', () => {
    expect(admissibleProposals([], TODAY)).toEqual([])
  })

  it('功能层 + 连续 3 天同向 + 有预览 → 可提', () => {
    expect(admissibleProposals([proposal()], TODAY)).toHaveLength(1)
  })

  it('门槛①:证据不足 3 天 → 不可提', () => {
    expect(admissibleProposals([proposal({ evidence_days: ['2026-08-24', '2026-08-25'] })], TODAY)).toEqual([])
  })

  it('门槛①:3 天但不连续 → 不可提(同向行为要连着)', () => {
    expect(admissibleProposals([proposal({ evidence_days: ['2026-08-21', '2026-08-23', '2026-08-25'] })], TODAY)).toEqual([])
  })

  it('门槛①:证据是陈年旧账、不含今天 → 不可提', () => {
    expect(admissibleProposals([proposal({ evidence_days: ['2026-08-01', '2026-08-02', '2026-08-03'] })], TODAY)).toEqual([])
  })

  it('门槛②:没有预览 → 不可提', () => {
    // 仓库开了 exactOptionalPropertyTypes:true,「没有预览」要表达成"键不存在",
    // 不是"键存在但值为 undefined"——两者语义不同,前者才是真实数据形态(JSON 解析
    // 产不出显式 undefined,代码里构造对象也是直接省略键)。用解构省略键,而不是
    // 传 `preview: undefined`,类型上天然合法,不需要放宽 Proposal.preview 的类型。
    const { preview: _omit, ...noPreview } = proposal()
    expect(admissibleProposals([noPreview], TODAY)).toEqual([])
  })

  it('门槛③:已采纳的不再出现在待提议里(采纳是显式动作,不是自动执行)', () => {
    expect(admissibleProposals([proposal({ adopted: true })], TODAY)).toEqual([])
  })

  it('事务层不受证据门槛约束(门槛①只管功能层),但仍要有预览', () => {
    const tx = proposal({ layer: 'transaction', evidence_days: [], preview: '预览:提醒你 Aiboo 停了 5 天' })
    expect(admissibleProposals([tx], TODAY)).toHaveLength(1)
    // 同上:表达"没有预览"用解构省略键,不传 `preview: undefined`(exactOptionalPropertyTypes)。
    const { preview: _omitTx, ...txNoPreview } = tx
    expect(admissibleProposals([txNoPreview], TODAY)).toEqual([])
  })
})

// 修复轮 1(Important 2,评审):以下几条此前零覆盖的分支——评审举的具体反例是
// 有人把 hasContinuousEvidence 的 Set 成员判断"简化"成 `days.length >= 3`,
// 原来的 8 条用例一条都不会红。这里补的每一条都专门守住一个会被"简化"悄悄改错
// 的角落。红绿验证结果见 task-8-report.md。
describe('门槛分支补漏(修复轮 1 · Important 2)', () => {
  it('门槛②:预览是空字符串(不是 undefined)→ 不可提,功能层', () => {
    expect(admissibleProposals([proposal({ preview: '' })], TODAY)).toEqual([])
  })

  it('门槛②:预览是空字符串 → 不可提,事务层同样不例外', () => {
    const tx = proposal({ layer: 'transaction', evidence_days: [], preview: '' })
    expect(admissibleProposals([tx], TODAY)).toEqual([])
  })

  it('门槛①:证据里有重复日期,实际只覆盖 2 天 → 不可提(守住"数 Set 成员"而不是数组长度)', () => {
    // 4 条记录,但去重后只有 08-25 与 08-24 两天——如果判定被"简化"成数组长度
    // >= 3,这里会被误判为"够 3 天"而放行。
    const dup = proposal({ evidence_days: ['2026-08-25', '2026-08-25', '2026-08-24', '2026-08-24'] })
    expect(admissibleProposals([dup], TODAY)).toEqual([])
  })

  it('门槛①:跨月/闰年边界(2024 是闰年,2 月有 29 天)→ 日期回退算对,可提', () => {
    const leap = proposal({
      evidence_days: ['2024-03-01', '2024-02-29', '2024-02-28'],
    })
    expect(admissibleProposals([leap], '2024-03-01')).toHaveLength(1)
  })

  it('门槛③:事务层 + 已采纳 → 同样不可提(采纳门槛对两层都无条件生效)', () => {
    const tx = proposal({ layer: 'transaction', evidence_days: [], adopted: true })
    expect(admissibleProposals([tx], TODAY)).toEqual([])
  })
})

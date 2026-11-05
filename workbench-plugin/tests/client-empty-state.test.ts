/**
 * 第一次用:「首次」判定与各模块空态的取数(2026-09-18)。
 *
 * 这一份钉的是**判断本身**,不是界面长什么样(那在 client-empty-modules.test.tsx)。
 * 三条最要紧的规矩各有一条 ★ 用例:跳过也算首次、引导做完即退场、有数据就显示数据。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView, QuotaEntry } from '../src/protocol.ts'
import { claudeDesktopGoneNote } from '../src/protocol.ts'
import type { EmptyStateInput } from '../src/client/emptyState.ts'
import { emptyStateFor, isFirstTime } from '../src/client/emptyState.ts'
import { forgetQuotaMemory, quotaFor } from '../src/server/agentQuota.ts'

/** 裸机的样子:引导还没做完,窗位叠接上了但里面一个都没有。 */
const FIRST: EmptyStateInput = { onboarding: { done: false }, dock: { stack: [] } }
const AFTER: EmptyStateInput = { onboarding: { done: true }, dock: { stack: [] } }

describe('isFirstTime:引导没做完就是第一次', () => {
  it('★点了「跳过」照样算第一次 —— 判定压根不看 first_run_done_at', () => {
    // 跳过那一下写的是 app.json 的 first_run_done_at,这个函数连这个字段都不认识:
    // 传进来也不影响结论。Ben 正是跳过之后才看见一屏残留的。
    const skipped = { ...FIRST, first_run_done_at: '2026-09-18T09:00:00+08:00' } as EmptyStateInput
    expect(isFirstTime(skipped)).toBe(true)
  })

  it('引导做完 → 不是第一次', () => {
    expect(isFirstTime(AFTER)).toBe(false)
  })

  it('★这台服务没接引导(onboarding 整格缺席)→ 不是第一次,一个字都不改', () => {
    // 展示台、手机、既有那一大批用例走的都是这一支:没查过不等于没有。
    expect(isFirstTime({})).toBe(false)
    expect(emptyStateFor('slot', {})).toBeUndefined()
    expect(emptyStateFor('projects', {})).toBeUndefined()
  })
})

describe('每个模块的空态:首次 + 这一格没东西', () => {
  it('窗口槽:一句「把常用的应用拖进这块槽里」,没有按钮', () => {
    const view = emptyStateFor('slot', FIRST)
    expect(view?.line).toBe('把常用的应用从屏幕上拖进这块槽里,它就会出现在这排标签里。')
    expect(view?.action).toBeUndefined()
  })

  it('★这台服务没接窗位叠(dock 整格缺席)→ 不出那一句:屏幕上根本没有落点可拖', () => {
    expect(emptyStateFor('slot', { onboarding: { done: false } })).toBeUndefined()
    // 引导做完那一档也一样:缺席就是"不归这一格管",跟首不首次无关。
    expect(emptyStateFor('slot', { onboarding: { done: true } })).toBeUndefined()
  })

  it('★引导做完了、叠里还是一个应用都没有 → 那一句照旧在(2026-09-20 去预置场景)', () => {
    // 预置的「干活 / 沟通」删掉之后,没有任何东西会替他把应用放进窗位;这句提醒要是
    // 跟着引导一起退场,跳过引导的人就只剩一块什么都不说的空槽。
    expect(emptyStateFor('slot', AFTER)?.line).toContain('拖进这块槽里')
  })

  it('项目区:一句话 + 唯一一颗「开始引导」按钮', () => {
    const view = emptyStateFor('projects', FIRST)
    expect(view?.title).toBe('还没有项目')
    expect(view?.line).toBe('引导里会帮你扫描已有的,或者从零建第一个。')
    expect(view?.action?.label).toBe('开始引导')
  })

  it('事务官:没配手机时只说"打字说第一句",不提手机', () => {
    const view = emptyStateFor('butler', FIRST)
    expect(view?.line).toContain('打字说第一句')
    expect(view?.line).toContain('配对手机之后')
  })

  it('事务官:配过手机就把"手机上也可以"这条路说出来', () => {
    const view = emptyStateFor('butler', { ...FIRST, devices: [{ id: 'd1' }] })
    expect(view?.line).toContain('手机上也可以')
  })

  it('消耗数据 / 余额额度 / 随手记:各一句', () => {
    // 10-22 拍板 23:每格「图标 + 标题 + 一句」,文案照评审页的例子
    expect(emptyStateFor('usage', FIRST)).toMatchObject({ title: '还没有消耗记录', icon: 'calendar-days', line: '接入一家的记录后,这里开始显示每日用量。' })
    expect(emptyStateFor('quota', FIRST)).toMatchObject({ title: '还没有接上额度', action: { label: '连接账号' } })
    expect(emptyStateFor('notes', FIRST)).toMatchObject({ title: '想法先留在这里', line: '不用先想好归到哪个项目。' })
  })
  // 2026-10-23(卡「系统文件夹改成Graphify图谱」):「图谱」那一格不再有服务端空态 ——
  // 三档状态(未装 / 未生成 / 已生成)由 GraphView 自己问、自己说,emptyState 里不再有 files 这一项。
})

describe('★有数据就显示数据 —— 空态只在真的什么都没有时出现', () => {
  it('窗位叠里认领过窗 → 没有空态(不能把他的东西藏起来)', () => {
    expect(emptyStateFor('slot', { ...FIRST, dock: { stack: [{ key: 'claude' }] } })).toBeUndefined()
  })

  it('有项目、或者只有看板上一张卡 → 项目区没有空态', () => {
    expect(emptyStateFor('projects', { ...FIRST, projects: { projects: [{ id: 'p1' }] } })).toBeUndefined()
    expect(emptyStateFor('projects', { ...FIRST, tasks: { tasks: [{ id: 't1' }] } })).toBeUndefined()
  })

  it('有残留事项、或者有会话在跑 → 事务官那一格没有空态', () => {
    expect(emptyStateFor('butler', { ...FIRST, butler_inbox: { items: [{ id: 'i1' }] } })).toBeUndefined()
    expect(emptyStateFor('butler', { ...FIRST, sessions: [{ session_id: 's1' }] })).toBeUndefined()
  })

  it('消耗账本里有一天的数 → 消耗数据没有空态', () => {
    expect(emptyStateFor('usage', { ...FIRST, usage: { days: [{ date: '2026-09-17' }] } })).toBeUndefined()
  })

  it('用量取不到({ error })→ 那就是"没有数据",照样出空态', () => {
    expect(emptyStateFor('usage', { ...FIRST, usage: { error: '未接入' } })?.title).toBe('还没有消耗记录')
  })

  it('随手记同理', () => {
    expect(emptyStateFor('notes', { ...FIRST, notes: [{ id: 'n1' }] })).toBeUndefined()
  })
})

describe('余额 / 额度那一格:什么才叫"有数"', () => {
  it('接上了一家、拿到真余额 → 照画,没有空态', () => {
    const state: EmptyStateInput = {
      ...FIRST,
      quota: { dsh: { kind: 'balance', currency: 'CNY', total: '218.40', available: true } },
    }
    expect(emptyStateFor('quota', state)).toBeUndefined()
  })

  it('★「未接入」绝不当成 0:available:false / kind:unknown 都算没有数', () => {
    const notAvailable: EmptyStateInput = {
      ...FIRST,
      quota: {
        dsh: { kind: 'balance', currency: 'CNY', total: '--', available: false },
        claude: { kind: 'unknown', note: '还没实测通' },
        codex: { kind: 'quota', windows: [] },
      },
    }
    expect(emptyStateFor('quota', notAvailable)?.title).toBe('还没有接上额度')
  })

  it('走工作台自家中转(relay)→ 那一格本来就有今日用量可说,不出空态', () => {
    expect(emptyStateFor('quota', { ...FIRST, model_mode: 'relay' })).toBeUndefined()
  })
})

/**
 * 上次读到的那个数也算「有数」(2026-09-26,卡 SM;卡 QS 交接第八节第 2 条)。
 *
 * 卡 QS 之后,这一轮读不到新的、以前真读到过的那一家在 `/state.agent_quota` 里仍是「有数」,
 * 额度区照旧摆着那个数 —— 而这一格原来只看 `/state.quota`,于是屏幕上摆着「本周还剩约 69%」
 * 的同时,整块压上一句「还没接上任何一家的凭据」。这里钉住两处都看。
 */
describe('上次读到的数也算有数(卡 QS 顶上来的那一格)', () => {
  beforeEach(() => { forgetQuotaMemory() })

  /** 昨夜 20:42 读到 69%、今天中午读不到 —— 卡 QS 那一幕,`/state.agent_quota` 里仍是「有数」。 */
  function claudeKept(): AgentQuotaView {
    const week: QuotaEntry = { kind: 'quota', windows: [{ label: '周', left_pct: 69 }] }
    // ★ 2026-10-03:那句话改由 protocol.ts 的 claudeDesktopGoneNote 拼,这里跟着读常量。
    const missed: QuotaEntry = { kind: 'unknown', note: claudeDesktopGoneNote(918 * 60_000) }
    quotaFor('claude', { quota: { claude: week }, now: new Date(2026, 8, 25, 20, 42, 0) })
    return quotaFor('claude', { quota: { claude: missed }, now: new Date(2026, 8, 26, 12, 0, 0) })
  }

  it('★老四格一格数都没有、只有 Claude 顶着昨晚读到的那个数 → 不说「还没接上」', () => {
    const kept = claudeKept()
    // 先钉住前提:卡 QS 那一格真的还是「有数」,而 /state.quota 那一格已经没数了。
    expect(kept.state).toBe('numbers')
    // 2026-10-02(卡 QA):过了 2 小时那条线就不出百分比了(原来这里查的是「69%」)——
    // 但它**仍然是「有数」**,所以这一条钉的那件事(空态不说「还没接上」)一个字没变。
    expect(kept.line).toContain('读不到最新的,上次昨晚 20:42')
    const state: EmptyStateInput = {
      ...FIRST,
      quota: { claude: { kind: 'unknown', note: '这次没取到' } },
      agent_quota: [kept],
    }
    expect(emptyStateFor('quota', state)).toBeUndefined()
  })

  it('那几家也都说没接上 → 照旧那一句(空态没被这一改弄丢)', () => {
    const state: EmptyStateInput = {
      ...FIRST,
      agent_quota: [{ id: 'manus', title: 'Manus', state: 'unconnected', line: '没接上:Manus 没开着' }],
    }
    expect(emptyStateFor('quota', state)?.title).toBe('还没有接上额度')
  })

  it('「不限」不算接上 —— 一台什么都没接的机器上豆包也写「不限」,拿它当有数会让这句指路的话永远不出现', () => {
    const state: EmptyStateInput = {
      ...FIRST,
      agent_quota: [{ id: 'doubao', title: '豆包', state: 'unlimited', line: '不限', source: '普通对话和联网搜索不限次数' }],
    }
    expect(emptyStateFor('quota', state)?.title).toBe('还没有接上额度')
  })

  it('agent_quota 整格缺席(老宿主 / 展示台那份副本)→ 判法与卡 QS 之前逐字相同', () => {
    expect(emptyStateFor('quota', FIRST)?.title).toBe('还没有接上额度')
    expect(emptyStateFor('quota', { ...FIRST, agent_quota: [] })?.title).toBe('还没有接上额度')
  })
})

describe('★退场', () => {
  it('引导做完那一刻,各格空态一起退场(窗位槽除外,见上面那条)', () => {
    for (const module of ['projects', 'butler', 'usage', 'quota', 'notes'] as const) {
      expect(emptyStateFor(module, FIRST), `${module} 首次该有空态`).toBeDefined()
      expect(emptyStateFor(module, AFTER), `${module} 引导做完该退场`).toBeUndefined()
    }
  })

  it('某一格的数据先到,就只有那一格先退 —— 其余照旧空着', () => {
    const state: EmptyStateInput = { ...FIRST, notes: [{ id: 'n1' }] }
    expect(emptyStateFor('notes', state)).toBeUndefined()
    expect(emptyStateFor('slot', state)).toBeDefined()  // 认领第一个应用才退,见上
    expect(emptyStateFor('projects', state)).toBeDefined()
  })
})

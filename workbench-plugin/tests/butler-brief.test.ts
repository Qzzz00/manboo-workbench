/**
 * 第一条消息里**先把工作台已经知道的事实摆上**(2026-10-02,卡「事务官为什么要跑这么多步」)。
 *
 * 用例里那几个问题不是想出来的,是从本机真实会话记录(`~/.dsh/sessions/…/session.v4.jsonl.zstd`)
 * 里一步一步数出来的 —— 事务官为了回答它们烧掉的步数见 `docs/交接-1002-事务官为什么要跑这么多步.md`:
 *
 * | 会话 | 她说的 | 步 | 工具 | 其中在干活 |
 * |---|---|---|---|---|
 * | `9c37bdd9` | 「来来来。」 | 6 | 9 | **0** |
 * | `10e74661` | 「给 Minus 发个信息,让 Minus 去做:问他国庆节…」 | 13 | 25 | **0** |
 *
 * 两条会话 34 次工具调用,一次都不在干活:全在回答「这张卡写的什么」「这台机器上有谁能派」
 * 「工作台的口在哪」「技能正文在哪」—— **四个问题工作台这一侧全都已经有答案**。
 * 所以这一份用例的判据是:**那四个问题,第一条消息里就答了**。
 */
import { describe, expect, it } from 'vitest'
import {
  BUTLER_BRIEF_NO_SEARCH, butlerBriefBlock, butlerSkillForItem,
} from '../src/server/butlerBrief.ts'
import { butlerFirstMessage } from '../src/server/butlerItem.ts'

/** Air 上那台此刻的样子(诊断包 `工作台诊断包-20261002-112711` 的 `快照/agents.json`)。 */
const AIR = {
  itemId: 't-0a166196',
  title: '让 Kimi 查一下国庆放假多少天?',
  baseUrl: 'http://127.0.0.1:8791',
  dispatchable: [
    { id: 'codex', title: 'Codex' },
    { id: 'claude', title: 'Claude' },
    { id: 'doubao', title: '豆包办公' },
  ],
  unreadable: [{ id: 'kimi', name: 'Kimi' }],
} as const

describe('butlerBriefBlock:四个问题当场答掉', () => {
  it('① 这张卡写的什么 —— 标题与 id 都在,不用再去 curl 一次', () => {
    const brief = butlerBriefBlock(AIR)
    expect(brief).toContain(AIR.itemId)
    expect(brief).toContain(AIR.title)
    // 9c37bdd9 第 1 步干的就是这一下(curl /butler/item?id=…,而且那个口根本不存在)。
    expect(brief).toContain('工作台已经建好了')
  })

  it('② 这台机器上有谁能派 —— 能派的与读不到的两份名单都在', () => {
    const brief = butlerBriefBlock(AIR)
    for (const one of AIR.dispatchable) expect(brief).toContain(one.title)
    // 10e74661 为了回答这一个问题跑了 12 步:grep ~/.dsh、ls /Applications、ps aux、list_mcp_resources。
    expect(brief).toContain('Kimi')
    expect(brief).toContain('读不到')
  })

  it('③ 工作台的口在哪 —— 地址与这件事要用的口都在', () => {
    const brief = butlerBriefBlock({ ...AIR, endpoints: ['POST /dispatch/run'] })
    expect(brief).toContain('http://127.0.0.1:8791')
    expect(brief).toContain('POST /dispatch/run')
  })

  it('④ 技能正文在哪 —— 点名了别家就直接给那一份的路径', () => {
    const brief = butlerBriefBlock({ ...AIR, skill: { name: '派活给别家Agent', file: '/Users/example/.dsh/workbench/技能/派活给别家Agent.md' } })
    expect(brief).toContain('派活给别家Agent')
    expect(brief).toContain('/Users/example/.dsh/workbench/技能/派活给别家Agent.md')
    expect(brief).toContain('只读这一份')
  })

  it('末尾明说「不用再翻盘、翻目录、试接口」,记忆照旧按需', () => {
    const brief = butlerBriefBlock(AIR)
    expect(brief).toContain(BUTLER_BRIEF_NO_SEARCH)
    expect(brief).toContain('.dsh/skills/记忆/SKILL.md')
    expect(brief).toContain('别为它把记忆通读一遍')
    // 老那条已经撤掉的前置指令不许回来(2026-09-23 12:39 那一通)。
    expect(brief).not.toContain('动手之前')
    expect(brief).not.toContain('读一遍记忆')
  })

  it('★ 工作台不知道的那一行就不出现 —— 一个字都不编(D13)', () => {
    const bare = butlerBriefBlock({ itemId: 't-1', title: '随手记一条' })
    expect(bare).toContain('t-1')
    expect(bare).not.toContain('能派')
    expect(bare).not.toContain('读不到')
    expect(bare).not.toContain('undefined')
    // 地址没给就不写一个猜的(卡 SP 那一处的病:写死 8791 打到了别人家的服务上)。
    expect(bare).not.toContain('127.0.0.1')
    expect(bare).not.toContain('项目')
  })

  it('一家都派不了时如实说「一家都派不了」,不留一句空名单', () => {
    const brief = butlerBriefBlock({ itemId: 't-2', title: '让 Kimi 查', dispatchable: [], unreadable: [{ id: 'kimi', name: 'Kimi' }] })
    expect(brief).toContain('一家都派不了')
    expect(brief).toContain('Kimi')
  })
})

describe('butlerSkillForItem:这件事归哪一条技能(纯判断,不经模型)', () => {
  const skillFile = (name: string): string => `/Users/example/.dsh/workbench/技能/${name}.md`

  it('点名了别家 → 派活那一条,带正文路径', () => {
    expect(butlerSkillForItem({ assignee: 'codex', skillFile })).toEqual({
      name: '派活给别家Agent',
      file: '/Users/example/.dsh/workbench/技能/派活给别家Agent.md',
    })
  })

  it('没点名 / 它自己办 / 负责人是人 → 不点名任何一条(不猜)', () => {
    expect(butlerSkillForItem({ skillFile })).toBeUndefined()
    expect(butlerSkillForItem({ assignee: 'dsh', skillFile })).toBeUndefined()
    expect(butlerSkillForItem({ assignee: 'me', skillFile })).toBeUndefined()
  })

  it('★ 不知道正文落在哪(老宿主)→ 不点名,也不写一个猜的路径', () => {
    expect(butlerSkillForItem({ assignee: 'codex' })).toBeUndefined()
  })
})

describe('butlerFirstMessage 带上事实之后', () => {
  it('原话照旧在最前面,事实接在后面', () => {
    const message = butlerFirstMessage('让 Codex 做', 't-9', 'codex', undefined, {
      itemId: 't-9',
      title: '让 Codex 做',
      baseUrl: 'http://127.0.0.1:8791',
      dispatchable: [{ id: 'codex', title: 'Codex' }],
    })
    expect(message.startsWith('让 Codex 做')).toBe(true)
    expect(message).toContain('http://127.0.0.1:8791')
    expect(message).toContain(BUTLER_BRIEF_NO_SEARCH)
  })

  it('★ 没给事实 = 老实现,一个字不变(老宿主 / 既有用例)', () => {
    const old = butlerFirstMessage('把展示台的黄历接上', 't-1')
    expect(old).toContain('.dsh/skills/记忆/SKILL.md')
    expect(old).toContain('t-1')
    expect(old).not.toContain(BUTLER_BRIEF_NO_SEARCH)
  })

  it('点名那一句照旧(派活给别家Agent 那一节)', () => {
    const message = butlerFirstMessage('让 Codex 做', 't-9', 'codex', undefined, { itemId: 't-9', title: '让 Codex 做' })
    expect(message).toContain('派活给别家Agent')
  })
})

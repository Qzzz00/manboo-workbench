// @vitest-environment node
/**
 * **前后对照:同样那几件事,现在还要跑几步**(2026-10-02,卡「事务官为什么要跑这么多步」)。
 *
 * 「前」不是估的,是从本机真实会话记录里逐步数出来的
 * (`~/.dsh/sessions/--Users-ben-Documents-~5DE5~4F5C~53F0--` 下每条会话的 `session.v4.jsonl.zstd`,
 * 逐步表在 `docs/交接-1002-事务官为什么要跑这么多步.md` 第一节)。
 *
 * 「后」这一侧没法在用例里真跑一条 DSH 会话,所以钉的是**它当时每一次工具调用去问的那个问题,
 * 现在第一条消息里有没有现成答案**。答案都在手上 = 那一步不必再走。
 * 真机重放怎么验写在交接第五节。
 */
import { describe, expect, it } from 'vitest'
import { BASE_SKILLS, opsSkillIndexEntry } from '../src/server/opsSkills.ts'
import { skillBodyFile } from '../src/server/bundledSkills.ts'
import { butlerSkillForItem } from '../src/server/butlerBrief.ts'
import { butlerFirstMessage } from '../src/server/butlerItem.ts'
import type { TaskAssignee } from '../src/protocol.ts'

const HOME = '/Users/example'
const BASE_URL = 'http://127.0.0.1:8791'

/** 这台机器此刻的样子(诊断包 `工作台诊断包-20261002-112711` 的 `快照/agents.json`)。 */
const CAN = [
  { id: 'codex', title: 'Codex' },
  { id: 'claude', title: 'Claude' },
  { id: 'doubao', title: '豆包办公' },
]
const UNREADABLE = [{ id: 'kimi', name: 'Kimi' }]

function firstMessageNow(input: { said: string, itemId: string, assignee?: TaskAssignee }): string {
  const skill = butlerSkillForItem({
    ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
    skillFile: (name: string) => skillBodyFile(HOME, name),
  })
  return butlerFirstMessage(input.said, input.itemId, input.assignee, undefined, {
    itemId: input.itemId,
    title: input.said.slice(0, 40),
    dispatchable: CAN,
    unreadable: UNREADABLE,
    baseUrl: BASE_URL,
    ...(skill === undefined ? {} : { skill, endpoints: ['POST /dispatch/run', `GET /dispatch/choices?item=${input.itemId}`] }),
  })
}

interface ReplayCase {
  /** 哪一条真会话。 */
  session: string
  said: string
  itemId: string
  assignee?: TaskAssignee
  /** 当时真跑了几步、调了几次工具、其中几次在干活(数出来的)。 */
  before: { steps: number, calls: number, working: number }
  /** 当时每一步去问机器的那个问题 → 现在第一条消息里的哪一句答了它。 */
  answered: readonly { asked: string, nowIn: string }[]
}

const CASES: readonly ReplayCase[] = [
  {
    // 09-26 16:40,她在电话里喊了一声。
    session: 'session-9c37bdd9-42b3-43d0-a538-8fc8cf8ca946',
    said: '来来来。',
    itemId: 't-13a68d85',
    before: { steps: 6, calls: 9, working: 0 },
    answered: [
      // 第 1 / 2 / 3 步:curl /butler/item?id=…(不存在)、挨个试探 13 个口、grep 卡 id。
      { asked: '这张卡写的什么', nowIn: 't-13a68d85' },
      { asked: '这张卡的标题', nowIn: '来来来。' },
      { asked: '工作台的口在哪', nowIn: BASE_URL },
      // 第 4 / 5 / 6 步:ls ~/.dsh、读 ~/.dsh/workbench/tasks.json 找这张卡。
      { asked: '卡在哪个文件里', nowIn: '工作台已经建好了' },
      { asked: '还要不要自己去翻', nowIn: '不用再翻盘、翻目录、试接口' },
    ],
  },
  {
    // 09-27 21:17,她要派活给一个这台机器上没有的家。
    session: 'session-10e74661-e11c-47ca-b4a2-7cc034cc3990',
    said: '给 Codex 发个信息,让 Codex 去做:问他国庆节中国法定节日是放几天,他回了告诉我',
    itemId: 't-a81c7ec9',
    assignee: 'codex',
    before: { steps: 13, calls: 25, working: 0 },
    answered: [
      // 第 2–12 步:grep -rni minus 遍 workspace、遍 ~/.dsh、ls /Applications、ps aux、list_mcp_resources。
      { asked: '这台机器上能派谁', nowIn: 'Codex' },
      { asked: '那几家读不到窗口', nowIn: 'Kimi' },
      // 第 1 / 5 / 7 步:curl /state、/dispatch/choices 试形状。
      { asked: '派活调哪个口', nowIn: 'POST /dispatch/run' },
      // 第 4 步:read .dsh/skills/记忆/SKILL.md;第 1 / 2 步 ls 技能目录找正文。
      { asked: '派活那一条技能正文在哪', nowIn: skillBodyFile(HOME, '派活给别家Agent') },
      { asked: '要不要把别的技能也读一遍', nowIn: '别的技能正文跟这件事无关' },
    ],
  },
]

describe('前后对照:它当时一步一步去问的,现在第一条消息里都有', () => {
  for (const one of CASES) {
    it(`${one.session.slice(8, 16)}「${one.said.slice(0, 16)}…」:当时 ${String(one.before.steps)} 步 / ${String(one.before.calls)} 次工具 / 干活 ${String(one.before.working)} 次`, () => {
      const first = firstMessageNow(one)
      for (const { asked, nowIn } of one.answered) {
        expect(first, `${asked} —— 还是得自己去查`).toContain(nowIn)
      }
      // 原话照旧在最前面(那是她要说的话)。
      expect(first.startsWith(one.said)).toBe(true)
    })

    it(`${one.session.slice(8, 16)}:那 ${String(one.before.calls)} 次工具调用里,0 次是在干活 —— 所以这几步全是可以不走的`, () => {
      expect(one.before.working).toBe(0)
    })
  }
})

describe('说明书那一侧:不再每条会话注 2.7 万字', () => {
  /**
   * 10-01 那条真会话里 `agent-instructions` 注进去 **27239 字**(9 段、149 处接口说明);
   * 维护者那台做产品模板量到 18736~21120 字。索引之后一段不到 300 字。
   */
  it('六段基础技能的索引加起来不到 2000 字(原来单「派活给别家Agent」一段就 5839 字)', () => {
    const total = BASE_SKILLS
      .map(skill => opsSkillIndexEntry(skill, skillBodyFile(HOME, skill.name)))
      .reduce((sum, entry) => sum + entry.length, 0)
    expect(total).toBeLessThan(2000)
  })

  it('索引里一条接口路径都没有(留一行 POST /x 它就会照着那一行直接动手)', () => {
    for (const skill of BASE_SKILLS) {
      const entry = opsSkillIndexEntry(skill, skillBodyFile(HOME, skill.name))
      // `summary` 里历史上带过路径(比如「调一次 /dispatch/run」),那是一句人话的一部分、不是一行命令;
      // 这里钉的是**索引自己不长出一行接口说明来**:没有 `POST` / `GET` / `curl` 开头的那种行。
      for (const line of entry.split('\n')) {
        expect(line.trimStart()).not.toMatch(/^(POST|GET|PUT|DELETE|curl|```)/)
      }
    }
  })
})

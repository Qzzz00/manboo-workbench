// @vitest-environment node
/**
 * **先认家、再在这家里认对话**(2026-09-28,卡 FX)。
 *
 * 统筹 2026-09-28 早在维护者本机(main 5956320e 已装)实测 `GET /sessions/lookup?who=`,
 * 当时 `/state.sessions` 里 4 条:codex 1 条、claude 3 条;本机装着 8 家。五个输入的实际输出:
 *
 * | 他说的 | 当时答的 | 该答的 |
 * |---|---|---|
 * | `Codex` | codex 那条「整理 Sportlight…」 ✓ | 同 |
 * | `Kimi`  | **claude** 的「Fix flaky client-dock.test.tsx…」✗ | Kimi 这会儿没有在跑的对话 |
 * | `minus` | **claude** 那条 ✗ | 先认成 Manus,再说 Manus 没有在跑的对话 |
 * | `Manus` | 「没认出他说的是哪一条会话(这会儿有 4 条)」✗ | Manus 这会儿没有在跑的对话 |
 * | `豆包`  | 同上 ✗ | 豆包办公 这会儿没有在跑的对话 |
 *
 * 这一份钉的是:
 * 1. ★★ **点了名的那一家,绝不答别家的对话**(Kimi / minus / Manus / 豆包 四条);
 * 2. ★★ 认出的家没有在跑 / 在等的对话 → 照实说这一句(有过的就补最近那条叫什么、多久前);
 * 3. ★★ 认出家之后**只在这一家里按标题挑**;
 * 4. ★ 认不出是哪一家、也不像任何标题 → 才走「念几条问他」;
 * 5. ★ 捎话 `/sessions/relay` 那条路认人**同一套**(卡 MS/LK 的口径);
 * 6. ★ 两端(插件 / channel-worker)对同一组名字认出同一家 —— 判据是两份实现,用例是同一组。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { lookupSession } from '../src/server/sessionLookup.ts'
import { matchRelaySession } from '../src/server/sessionRelay.ts'
import { matchSpokenFamily, spokenFamilies } from '../src/server/spokenFamily.ts'

const NOW = '2026-09-28T08:40:00+08:00'

/** 他本机装着的 8 家(2026-09-27 卡 HC 的真机探测:两家运行时发现的 id 就是包标识)。 */
const INSTALLED = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude' },
  { id: 'kimi', name: 'Kimi' },
  { id: 'doubao', name: '豆包办公' },
  { id: 'muse', name: 'Muse' },
  { id: 'manus', name: 'Manus' },
  { id: 'com.google.antigravity', name: 'Antigravity' },
  { id: 'com.anysphere.sand', name: 'Grok Bot' },
] as const

/**
 * `agent` 按**字符串**收(卡 P 的规矩:登记表里的家名是开集,`manus` / `doubao` 不在
 * `AgentId` 那四家的闭集里,真机 `/state.sessions` 里却照样有它们)。
 */
function session(one: Omit<Partial<SessionView>, 'agent'> & { agent: string, session_id: string }): SessionView {
  return {
    project: 'desktop-workbench',
    status: 'running',
    elapsed_sec: 600,
    last_output_sec: 60,
    unread: false,
    updated_at: '2026-09-28T08:38:00+08:00',
    ...one,
    agent: one.agent as SessionView['agent'],
  }
}

/** 那一刻的 4 条(codex 1、claude 3)。 */
const SESSIONS: readonly SessionView[] = [
  session({
    agent: 'codex',
    session_id: '01a0e239-ea79-7ad1-8bc1-f9fbad3a15bc',
    project: 'Echo',
    title: '整理 Sportlight 参赛材料与网页',
    activity: { line: '在写参赛说明那一段', at: '2026-09-28T08:38:00+08:00' },
  }),
  session({
    agent: 'claude',
    session_id: 'c-1',
    title: 'Fix flaky client-dock.test.tsx 里那一条',
    activity: { line: '在跑 client-dock 那一支测试', at: '2026-09-28T08:37:00+08:00' },
  }),
  session({ agent: 'claude', session_id: 'c-2', title: '统筹会话交接', status: 'waiting' }),
  session({ agent: 'claude', session_id: 'c-3', title: '座机记账号由电脑代办' }),
]

const NAMES: Readonly<Record<string, string>> = {
  codex: 'Codex', claude: 'Claude', kimi: 'Kimi', doubao: '豆包办公', muse: 'Muse', manus: 'Manus',
}
const agentName = (agent: string): string => NAMES[agent] ?? agent

const families = spokenFamilies({ installed: INSTALLED, agents: SESSIONS.map(one => one.agent) })

function look(who: string, sessions: readonly SessionView[] = SESSIONS): ReturnType<typeof lookupSession> {
  return lookupSession({ sessions, who, agentName, now: NOW, families })
}

describe('★★ 真机那五个输入', () => {
  it('Codex → codex 那条在跑的(这一条本来就对,别修坏)', () => {
    const found = look('Codex')
    expect(found.kind).toBe('one')
    if (found.kind !== 'one') return
    expect(found.agent).toBe('codex')
    expect(found.title).toBe('整理 Sportlight 参赛材料与网页')
  })

  it('Kimi → 「Kimi 这会儿没有在跑的对话」,绝不答 claude 那条', () => {
    const found = look('Kimi')
    expect(found.kind).toBe('none')
    expect(found.line).toContain('Kimi')
    expect(found.line).toContain('没有在跑的对话')
    expect(found.line).not.toContain('client-dock')
    expect(found.line).not.toContain('Claude')
  })

  it('minus(ASR 听错的 Manus)→ 先认成 Manus,再说 Manus 没有在跑的对话', () => {
    const found = look('minus')
    expect(found.kind).toBe('none')
    expect(found.line).toBe('Manus 这会儿没有在跑的对话。')
  })

  it('Manus → 同一句;不再念「没认出他说的是哪一条会话(这会儿有 4 条)」', () => {
    const found = look('Manus 现在在干什么')
    expect(found.kind).toBe('none')
    expect(found.line).toBe('Manus 这会儿没有在跑的对话。')
    expect(found.line).not.toContain('念几条')
  })

  it('豆包 → 认成豆包办公,答它没有在跑的对话', () => {
    const found = look('豆包现在什么状态')
    expect(found.kind).toBe('none')
    expect(found.line).toContain('豆包办公')
    expect(found.line).toContain('没有在跑的对话')
  })
})

describe('★★ 这一家有过别的会话时,补一句最近那条', () => {
  it('Manus 只有一条三天前做完的 → 说没有在跑的,再说最近那条叫什么、多久前', () => {
    const withOld = [...SESSIONS, session({
      agent: 'manus', session_id: 'm-1', status: 'done', title: '查国庆放几天',
      updated_at: '2026-09-25T08:40:00+08:00',
    })]
    const found = look('minus', withOld)
    expect(found.kind).toBe('none')
    expect(found.line).toBe('Manus 这会儿没有在跑的对话。最近一条是「查国庆放几天」,三天前。')
  })
})

describe('★★ 认出家之后只在这一家里挑', () => {
  it('豆包办公有一条在跑的 → 认得出,答的是它那条', () => {
    const withDoubao = [...SESSIONS, session({
      agent: 'doubao', session_id: 'd-1', title: '写小红书封面文案',
      activity: { line: '在改第二版标题', at: '2026-09-28T08:39:00+08:00' },
    })]
    const found = look('豆包在干什么', withDoubao)
    expect(found.kind).toBe('one')
    if (found.kind !== 'one') return
    expect(found.agent).toBe('doubao')
    expect(found.line).toContain('写小红书封面文案')
  })

  it('他说了家名 + 标题词 → 在这一家里按标题挑那一条', () => {
    const found = look('Claude 那条统筹交接到哪了')
    expect(found.kind).toBe('one')
    if (found.kind !== 'one') return
    expect(found.session_id).toBe('c-2')
  })

  it('claude 有 3 条、他只说了家名 → 在**这一家的 3 条里**问他是哪一条,一条别家的都不掺', () => {
    const found = look('Claude')
    expect(found.kind).toBe('many')
    if (found.kind !== 'many') return
    expect(found.candidates.map(one => one.agent)).toEqual(['claude', 'claude', 'claude'])
  })
})

describe('★ 认不出是哪一家时照旧', () => {
  it('不像任何一家、也不像任何标题 → 念几条问他', () => {
    const found = look('那个什么东西')
    expect(found.kind).toBe('none')
    expect(found.line).toContain('念几条')
  })

  it('不像任何一家、但像某条标题 → 照标题认出来(不问)', () => {
    const found = look('座机记账号那条')
    expect(found.kind).toBe('one')
    if (found.kind !== 'one') return
    expect(found.session_id).toBe('c-3')
  })
})

describe('★ 捎话认人同一套', () => {
  it('给 Kimi 捎话:Kimi 没有会话 → 说 Kimi 没有,不往 claude 那条里送', () => {
    const match = matchRelaySession({ sessions: SESSIONS, who: 'Kimi', agentName, now: NOW, families })
    expect(match.kind).toBe('none')
    if (match.kind !== 'none') return
    expect(match.family?.id).toBe('kimi')
    expect(match.line).toContain('Kimi')
  })

  it('给 minus 捎话与看一眼 minus 认出的是同一家', () => {
    const match = matchRelaySession({ sessions: SESSIONS, who: 'minus', agentName, now: NOW, families })
    expect(match.kind).toBe('none')
    if (match.kind !== 'none') return
    expect(match.family?.id).toBe('manus')
  })

  it('给 Codex 捎话 → 还是那条在跑的', () => {
    const match = matchRelaySession({ sessions: SESSIONS, who: 'Codex', agentName, now: NOW, families })
    expect(match.kind).toBe('one')
    if (match.kind !== 'one') return
    expect(match.target.agent).toBe('codex')
  })
})

describe('★ 候选只取本机真装的家', () => {
  it('本机没装 Muse 时,「mu si」不认成 Muse', () => {
    const only = spokenFamilies({ installed: INSTALLED.filter(one => one.id !== 'muse'), agents: [] })
    expect(matchSpokenFamily('mu si', only).kind).toBe('none')
    expect(matchSpokenFamily('mu si', families)).toEqual({ kind: 'one', id: 'muse', title: 'Muse' })
  })

  it('探测那一格缺席时退回知识表(查不到不等于没有)', () => {
    const fallback = spokenFamilies({})
    expect(matchSpokenFamily('minus', fallback)).toEqual({ kind: 'one', id: 'manus', title: 'Manus' })
  })

  it('有会话的家永远在候选里(gpt 连 App 都没有)', () => {
    const withGpt = spokenFamilies({ installed: INSTALLED, agents: ['gpt'] })
    expect(withGpt.some(one => one.id === 'gpt')).toBe(true)
  })
})

/**
 * ★ **两端认出来必是同一家**(卡 MS 的口径)。判据是两份实现(顶层子目录互不 import),
 * 所以这一组输入在 `channel-worker/tests/agent-name.test.ts` 里有逐字相同的一份。
 */
describe('★ 两端同一组用例', () => {
  const cases: readonly [string, string | undefined][] = [
    ['Codex', 'codex'],
    ['Kimi', 'kimi'],
    ['minus', 'manus'],
    ['Manus 现在在干什么', 'manus'],
    ['豆包现在什么状态', 'doubao'],
    ['豆包办公', 'doubao'],
    ['克劳德在跑什么', 'claude'],
    ['那个什么东西', undefined],
  ]
  for (const [said, id] of cases) {
    it(`「${said}」→ ${id ?? '认不出'}`, () => {
      const match = matchSpokenFamily(said, families)
      expect(match.kind === 'one' ? match.id : undefined).toBe(id)
    })
  }
})

// 2026-09-30 Air 真机:「问一下 GPT 近 7 天深圳的天气」—— Air 上那个 App 叫 ChatGPT,就是 Codex(com.openai.codex)。
// 以前「ChatGPT」这个说法挂在那一家「只走接口」的 GPT 上,点名「GPT」在 Codex 身上认不出 → 「没新开」。
describe('「GPT / ChatGPT」认成 Codex 那个 App', () => {
  it('★只装了 Codex:说 GPT、ChatGPT 都认成它', async () => {
    const { matchSpokenFamily, spokenFamilies } = await import('../src/server/spokenFamily.ts')
    const families = spokenFamilies({ installed: [{ id: 'codex', name: 'Codex' }, { id: 'doubao', name: '豆包办公' }] })
    expect(matchSpokenFamily('问一下 GPT 近7天深圳的天气', families)).toMatchObject({ kind: 'one', id: 'codex' })
    expect(matchSpokenFamily('让 ChatGPT 查一下', families)).toMatchObject({ kind: 'one', id: 'codex' })
  })
})

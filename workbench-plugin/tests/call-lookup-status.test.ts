// @vitest-environment node
/**
 * 会话动静跟着文件走 + 「看一眼」那一句(2026-09-27,卡 LK)。
 *
 * 现场(维护者 21:2x,他自己的 Mac,电话里):「你告诉我现在 Codex 现在是什么状态?」
 * 事务官答「那条在跑,但已经 226 分钟没动静了」→ 他:「我刚才跟他聊天怎么可能……那是 4 个小时啊」。
 *
 * 统筹当场取证:`/state.sessions` 里那条 codex `updated_at` = 2026-09-27T09:38:59Z(本地 17:38),
 * 而 `~/.codex/sessions/2026/09/27/rollout-2026-09-27T17-37-21-….jsonl`(23MB)21:28 还在写。
 * 17:38 正是那份 rollout **开头**那一刻 —— 头尾拼读时,最后一条 `task_started` 落在中间那一大段
 * (离文件尾 4.1MB),拿到的是**头上**那一条。
 *
 * 这一份钉的是:
 * 1. ★★ **「最后一次动静」跟任何一条新记录走**,不跟生命周期事件走(`lastTs` → `output_ts`);
 * 2. ★★ **缺口前捡来的状态不算数**:沿用上一次已知的那个(`eventFromHead`);
 * 3. ★★ 文件一长,下一拍 `updated_at` 就跟上(会话表那一层);
 * 4. ★ 时长说人话:228 分钟 → 「快四个小时前」,不念分钟数;
 * 5. ★ 「看一眼 X」认的是**那一家此刻在跑的那条对话**,不是看板上的旧事项;
 * 6. ★ Kimi 的 `blocked` 以会话记录为准 —— 记录里最后一条是它在干活就不说「在等你」。
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionView, WorkbenchEvent } from '../src/protocol.ts'
import { agoSpokenLabel } from '../src/protocol.ts'
import { ROLLOUT_GAP_LINE, parseCodexRollout } from '../src/server/codexRollout.ts'
import { applyEvent, emptySessionStore, toSessionViews } from '../src/server/sessions.ts'
import { resolveKimiStatus, startKimiSessionFeed } from '../src/server/kimiSessionFeed.ts'
import { lookupSession } from '../src/server/sessionLookup.ts'
import { startCodexSessionFeed } from '../src/server/codexSessionFeed.ts'
import type { CodexSessionFeedDeps } from '../src/server/codexSessionFeed.ts'

/** 他那条真文件的形状(只留骨架:一条 session_meta、几条 task_started、一串 item_completed)。 */
const ID = '01a0e239-ea79-7ad1-8bc1-f9fbad3a15bc'
const CWD = '/Users/example/Documents/GitHub/Echo'

function meta(): string {
  return JSON.stringify({
    timestamp: '2026-09-27T09:38:59.162Z',
    type: 'session_meta',
    payload: { id: ID, cwd: CWD, source: 'appServer', thread_source: 'user', originator: 'Codex Desktop' },
  })
}

function ev(timestamp: string, type: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type, ...payload } })
}

/** 头一段(开头那条 task_started 就在这儿)+ 缺口 + 尾一段(全是 item_completed,一条生命周期事件都没有)。 */
function spliced(tailAt: string): string {
  return [
    meta(),
    ev('2026-09-27T09:38:59.165Z', 'task_started'),
    ROLLOUT_GAP_LINE,
    ev(tailAt, 'item_completed', { item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'pnpm test'] } }),
  ].join('\n')
}

describe('★★ 最后一次动静跟着文件走', () => {
  it('头尾拼读:状态还是头上那条,但「最后一次动静」是尾巴那一刻,并明说状态是从头上捡的', () => {
    const snapshot = parseCodexRollout(spliced('2026-09-27T13:30:12.492Z'))
    expect(snapshot?.id).toBe(ID)
    expect(snapshot?.event?.type).toBe('running')
    // 生命周期事件停在 09:38:59(这正是维护者看到的 17:38 本地)……
    expect(snapshot?.event?.ts).toBe(Math.floor(Date.parse('2026-09-27T09:38:59.165Z') / 1000))
    // ……而文件最后一次被写是 13:30:12(本地 21:30)。
    expect(snapshot?.lastTs).toBe(Math.floor(Date.parse('2026-09-27T13:30:12.492Z') / 1000))
    // 中间那一大段没读 → 这个状态不可靠,明说出来。
    expect(snapshot?.eventFromHead).toBe(true)
  })

  it('缺口之后又读到生命周期事件时,不再标「从头上捡的」', () => {
    const text = [
      meta(),
      ev('2026-09-27T09:38:59.165Z', 'task_started'),
      ROLLOUT_GAP_LINE,
      ev('2026-09-27T13:30:12.492Z', 'task_complete'),
    ].join('\n')
    const snapshot = parseCodexRollout(text)
    expect(snapshot?.event?.type).toBe('done')
    expect(snapshot?.eventFromHead).toBeUndefined()
  })

  it('会话表:报了 output_ts 就按它算「多久没动静」,「跑了多久」照旧从状态那一刻算', () => {
    const started = Math.floor(Date.parse('2026-09-27T09:38:59Z') / 1000)
    const moved = Math.floor(Date.parse('2026-09-27T13:30:12Z') / 1000)
    const event: WorkbenchEvent = {
      agent: 'codex', session_id: ID, project: 'Echo', type: 'running', ts: started, output_ts: moved,
    }
    const view = toSessionViews(applyEvent(emptySessionStore(), event, moved), moved + 60)[0]
    expect(view?.updated_at).toBe(new Date(moved * 1000).toISOString())
    expect(view?.last_output_sec).toBe(60)
    // 「跑了多久」还是从 09:38:59 起算(近四个小时)。
    expect(view?.elapsed_sec).toBe(moved + 60 - started)
  })
})

describe('★★ 文件一长,下一拍就跟上', () => {
  it('增长中的 rollout:第二拍 updated_at 与最新一句都往前走,状态沿用上一次已知的', async () => {
    vi.useFakeTimers()
    try {
      const home = '/home/.codex'
      const file = `${home}/sessions/2026/09/27/rollout-x.jsonl`
      let text = spliced('2026-09-27T13:00:00.000Z')
      let listener: ((type: string, name: string | null) => void) | undefined
      const deps: CodexSessionFeedDeps = {
        watch: (_dir, l) => { listener = l; return { close: () => {} } },
        readRollout: async () => text,
        readSessionIndex: async () => `${JSON.stringify({ id: ID, thread_name: '整理 Sportlight 参赛材料与网页' })}\n`,
      }
      const events: WorkbenchEvent[] = []
      const feed = startCodexSessionFeed(deps, {
        codexHome: home,
        applyEvent: event => events.push(event),
        now: () => Math.floor(Date.parse('2026-09-27T13:31:00Z') / 1000),
      })

      listener?.('change', '2026/09/27/rollout-x.jsonl')
      await vi.advanceTimersByTimeAsync(600)
      const first = events.at(-1)
      expect(first?.title).toBe('整理 Sportlight 参赛材料与网页')
      expect(first?.type).toBe('running')
      expect(first?.output_ts).toBe(Math.floor(Date.parse('2026-09-27T13:00:00Z') / 1000))

      // 文件又长了一截(尾巴上多一条,生命周期事件仍然一条都没有)。
      events.length = 0
      text = spliced('2026-09-27T13:30:12.492Z')
      listener?.('change', '2026/09/27/rollout-x.jsonl')
      await vi.advanceTimersByTimeAsync(600)
      const second = events.at(-1)
      expect(second?.output_ts).toBe(Math.floor(Date.parse('2026-09-27T13:30:12Z') / 1000))
      // 状态照旧是上一次已知的「在跑」,不是从头上重新捡一次。
      expect(second?.type).toBe('running')
      feed.stop()
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('★ 时长说人话', () => {
  it('228 分钟念成「快四个小时前」,不念分钟数', () => {
    const now = '2026-09-27T21:30:00+08:00'
    expect(agoSpokenLabel('2026-09-27T17:42:00+08:00', now)).toBe('快四个小时前')
    expect(agoSpokenLabel('2026-09-27T21:18:00+08:00', now)).toBe('12 分钟前')
    expect(agoSpokenLabel('2026-09-27T21:00:00+08:00', now)).toBe('半小时前')
    expect(agoSpokenLabel('2026-09-27T19:00:00+08:00', now)).toBe('两个多小时前')
    expect(agoSpokenLabel('2026-09-27T18:25:00+08:00', now)).toBe('三个小时前')
    expect(agoSpokenLabel('2026-09-27T21:29:30+08:00', now)).toBe('刚刚')
  })
})

describe('★ 「看一眼 X」认的是此刻在跑的那条对话', () => {
  const now = '2026-09-27T21:30:00+08:00'
  const sessions: SessionView[] = [
    {
      agent: 'codex', session_id: 'old-1', project: 'desktop-workbench', status: 'done',
      elapsed_sec: 200_000, last_output_sec: 200_000, unread: false,
      updated_at: '2026-09-25T14:27:00+08:00', title: '参赛网页架构收尾',
    },
    {
      agent: 'codex', session_id: ID, project: 'Echo', status: 'running',
      elapsed_sec: 14_000, last_output_sec: 120, unread: false,
      updated_at: '2026-09-27T21:28:00+08:00', title: '整理 Sportlight 参赛材料与网页',
      activity: { line: '在跑 create-tea 那一段', at: '2026-09-27T21:28:00+08:00' },
    },
  ]
  const agentName = (agent: string): string => (agent === 'codex' ? 'Codex' : agent)

  it('他只说「Codex 现在什么状态」时,答的是在跑那条,不是看板上那条旧的', () => {
    const found = lookupSession({ sessions, who: 'Codex 现在是什么状态', agentName, now })
    expect(found.kind).toBe('one')
    if (found.kind !== 'one') return
    expect(found.session_id).toBe(ID)
    expect(found.line).toContain('还在跑')
    expect(found.line).toContain('最后一次动静是2 分钟前')
    expect(found.line).toContain('在跑 create-tea 那一段')
    // 不念分钟数那件事在时长那一档管;这里只钉住没把秒数抖出来。
    expect(found.line).not.toContain('120')
  })

  it('他念得出标题时照标题认', () => {
    const found = lookupSession({ sessions, who: '整理 Spotlight 参赛材料与网页', agentName, now })
    expect(found.kind === 'one' && found.session_id).toBe(ID)
  })

  it('他明说「做完那条」时才答做完的那条', () => {
    const found = lookupSession({ sessions, who: 'Codex 那条参赛网页架构收尾做完了没', agentName, now })
    expect(found.kind === 'one' && found.session_id).toBe('old-1')
  })

  it('读不到它在做什么就说读不到,不编一句', () => {
    // `exactOptionalPropertyTypes`:这一格要的是**整格缺席**,不是 `activity: undefined`(那过不了类型检查)。
    const noActivity = sessions.map(({ activity: _activity, ...rest }) => rest)
    const found = lookupSession({ sessions: noActivity, who: 'Codex', agentName, now })
    expect(found.kind === 'one' && found.line).toContain('读不到它在做什么')
  })

  it('一条别家的会话都没有时如实说', () => {
    expect(lookupSession({ sessions: [], who: 'Codex', agentName, now }).kind).toBe('none')
  })
})

describe('★ Kimi 的 blocked 以会话记录为准', () => {
  it('记录里最后一条是它在干活 → 在跑,不说「在等你」', () => {
    expect(resolveKimiStatus('waiting', { format: 'kimi-wire', rounds: [], mark: 'working' })).toBe('running')
  })

  it('记录里明写着在问他 / 等他批 → 真的在等你', () => {
    expect(resolveKimiStatus('waiting', { format: 'kimi-wire', rounds: [], mark: 'working', formal_wait: 'question' })).toBe('waiting')
    expect(resolveKimiStatus('waiting', { format: 'kimi-wire', rounds: [], mark: 'asked', formal_wait: 'approval' })).toBe('waiting')
  })

  it('读不到记录、认不出最后一条 → 不当「等你确认」,按做完未读摆(2026-09-28 卡 KM 收紧:blocked 要证据)', () => {
    expect(resolveKimiStatus('waiting', undefined)).toBe('done')
    expect(resolveKimiStatus('waiting', { format: 'kimi-wire', rounds: [] })).toBe('done')
  })

  it('真机形状:statuses 说 blocked、记录里它还在干活 → 报的是在跑,时刻跟着记录走', async () => {
    vi.useFakeTimers()
    try {
      const nowSec = Math.floor(Date.parse('2026-09-27T13:31:44Z') / 1000)
      const key = 'agent:main:main:conversation:14243c38-4310-4ec5-ba1d-9d2ca9fd20a9'
      const lastAt = '2026-09-27T13:31:40.000Z'
      const applied: WorkbenchEvent[] = []
      const feed = startKimiSessionFeed({
        readStatuses: async () => ({ [key]: 'blocked' }),
        // 用量那一份停在 5 分钟前(它不跟着每一步走);记录文件 4 秒前还在写。
        readContextUsage: async () => ({ [key]: { updatedAt: '2026-09-27T13:26:00.000Z' } }),
        readConversations: () => new Map([[key, { title: 'lapis参加Sportlight 2026深圳赛讨论', records: '/tmp/wire.jsonl' }]]),
        readDigest: async () => ({
          format: 'kimi-wire' as const,
          rounds: [],
          mark: 'working' as const,
          last_at: lastAt,
          activity: { line: '在读那几篇稿子', at: lastAt },
        }),
      }, { applyEvent: event => applied.push(event), now: () => nowSec })
      await vi.advanceTimersByTimeAsync(0)
      feed.stop()

      expect(applied).toHaveLength(1)
      expect(applied[0]?.type).toBe('running')
      expect(applied[0]?.output_ts).toBe(Math.floor(Date.parse(lastAt) / 1000))
      expect(applied[0]?.activity?.line).toBe('在读那几篇稿子')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('running / completed 不碰', () => {
    expect(resolveKimiStatus('running', { format: 'kimi-wire', rounds: [], mark: 'asked' })).toBe('running')
    expect(resolveKimiStatus('done', { format: 'kimi-wire', rounds: [], mark: 'working' })).toBe('done')
  })
})

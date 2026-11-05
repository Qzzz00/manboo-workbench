// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInteractiveCodexSource, parseCodexRollout } from '../src/server/codexRollout.ts'
import { DISCOVER_DAYS, defaultCodexSessionFeedDeps } from '../src/server/codexSessionFeed.ts'

function sessionMeta(source: unknown, id = '019b-parent-1234', cwd = '/Users/example/project'): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd, source },
  })
}

function eventLine(timestamp: string, type: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type, ...payload },
  })
}

describe('Codex rollout canonical thread boundary', () => {
  it.each([
    ['vscode', true],
    ['cli', true],
    ['appServer', true],
    ['exec', false],
    [{ subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } }, false],
    [{ subagent: { other: 'guardian' } }, false],
    [undefined, false],
  ])('source %j is interactive=%j', (source, expected) => {
    expect(isInteractiveCodexSource(source)).toBe(expected)
    expect(parseCodexRollout(sessionMeta(source))).toEqual(expected
      ? { id: '019b-parent-1234', cwd: '/Users/example/project' }
      : undefined)
  })

  it('uses the last explicit lifecycle event and its ISO timestamp', () => {
    expect(parseCodexRollout([
      sessionMeta('cli'),
      eventLine('2026-08-24T01:02:03.000Z', 'task_started'),
      eventLine('2026-08-24T01:03:04.000Z', 'task_complete'),
    ].join('\n'))).toEqual({
      id: '019b-parent-1234',
      cwd: '/Users/example/project',
      event: { type: 'done', ts: 1787533384 },
      // 「最后一次动静」另记一格(2026-09-27,卡 LK):任何一条带时刻的记录都算,不只生命周期事件。
      lastTs: 1787533384,
    })
  })

  it('maps task_started to running', () => {
    expect(parseCodexRollout([
      sessionMeta('vscode'),
      eventLine('2026-08-24T01:02:03.000Z', 'task_started'),
    ].join('\n'))).toEqual({
      id: '019b-parent-1234',
      cwd: '/Users/example/project',
      event: { type: 'running', ts: 1787533323 },
      lastTs: 1787533323,
    })
  })

  it('maps turn_aborted to an interrupted error', () => {
    expect(parseCodexRollout([
      sessionMeta('appServer'),
      eventLine('2026-08-24T01:02:03.000Z', 'turn_aborted'),
    ].join('\n'))).toEqual({
      id: '019b-parent-1234',
      cwd: '/Users/example/project',
      event: { type: 'error', reason: 'interrupted', ts: 1787533323 },
      lastTs: 1787533323,
    })
  })

  it('keeps a later task_started after completion as running', () => {
    expect(parseCodexRollout([
      sessionMeta('cli'),
      eventLine('2026-08-24T01:02:03.000Z', 'task_started'),
      eventLine('2026-08-24T01:03:04.000Z', 'task_complete'),
      eventLine('2026-08-24T01:04:05.000Z', 'task_started'),
    ].join('\n'))?.event).toEqual({ type: 'running', ts: 1787533445 })
  })

  it('uses the first non-empty user message as an 80-character single-line fallback title', () => {
    const message = '第一行\n第二行 ' + 'x'.repeat(100)
    expect(parseCodexRollout([
      sessionMeta('cli'),
      eventLine('2026-08-24T01:02:03.000Z', 'user_message', { message }),
    ].join('\n'))).toEqual({
      id: '019b-parent-1234',
      cwd: '/Users/example/project',
      fallbackTitle: '第一行 第二行 ' + 'x'.repeat(72),
      lastTs: 1787533323,
    })
  })

  it('ignores malformed lines and leaves event absent when no lifecycle event exists', () => {
    expect(parseCodexRollout([
      '{not-json',
      sessionMeta('cli'),
      eventLine('2026-08-24T01:02:03.000Z', 'not_a_lifecycle_event'),
    ].join('\n'))).toEqual({
      id: '019b-parent-1234',
      cwd: '/Users/example/project',
      // 认不出种类的记录照旧不给状态,但它的时刻仍然算一次动静(卡 LK)。
      lastTs: 1787533323,
    })
  })

  it('bounds a large rollout read while retaining metadata and its trailing lifecycle event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'))
    const file = join(dir, 'rollout.jsonl')
    const fullText = [
      sessionMeta('cli'),
      'x'.repeat(600_000),
      eventLine('2026-08-24T01:03:04.000Z', 'task_complete'),
    ].join('\n')
    writeFileSync(file, fullText)

    try {
      const rollout = await defaultCodexSessionFeedDeps('/unused').readRollout(file)
      expect(rollout.length).toBeLessThan(fullText.length)
      expect(parseCodexRollout(rollout)).toEqual({
        id: '019b-parent-1234',
        cwd: '/Users/example/project',
        event: { type: 'done', ts: 1787533384 },
        lastTs: 1787533384,
      })
    }
    finally {
      // The production reader is the behavior under test; cleanup is test-only lifecycle.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})

/**
 * 等待原因分类(2026-09-09 傍晚拍板第 4 条):Codex 没有等待态,
 * 唯一的 error 是 turn_aborted(已中断)——四种原因一种都判不出,**不填**(D13)。
 */
describe('Codex rollout · wait_reason', () => {
  it('turn_aborted / task_complete / task_started 都不带 wait_reason', () => {
    for (const type of ['turn_aborted', 'task_complete', 'task_started']) {
      const snapshot = parseCodexRollout([sessionMeta('cli'), eventLine('2026-08-24T01:02:03.000Z', type)].join('\n'))
      expect(snapshot?.event).toBeDefined()
      expect(snapshot?.event).not.toHaveProperty('wait_reason')
    }
  })
})

/**
 * Codex Desktop 新版的会话文件形状(2026-09-27,卡 CX)。
 *
 * 夹具是 09-27 真机 `~/.codex/sessions/2026/09/27/` 那 5 个文件的**形状**(字段名与取值形状),
 * 内容全是编的:4 个 `thread_source: 'guardian_review'` 的审查子会话(`source` 是对象、有父对话),
 * 1 个 `thread_source: 'user'` 的他自己那条对话。维护者当时说「应该是两条」,
 * 另一条是 09-23 开、当天还在写的那份(同样 `thread_source: 'user'`)。
 */
describe('Codex rollout · 他自己的一条对话 vs 审查子会话(卡 CX)', () => {
  function desktopMeta(payload: Record<string, unknown>): string {
    return JSON.stringify({
      timestamp: '2026-09-27T05:05:53.000Z',
      type: 'session_meta',
      payload: {
        session_id: 'thread-1',
        id: 'thread-1',
        cwd: '/Users/example/Documents/GitHub/desktop-workbench',
        originator: 'Codex Desktop',
        cli_version: '0.0.0',
        ...payload,
      },
    })
  }

  it('他自己那条对话(source 仍是字符串、thread_source=user、没有父对话)照旧认', () => {
    expect(parseCodexRollout(desktopMeta({ source: 'vscode', thread_source: 'user', parent_thread_id: null })))
      .toEqual({ id: 'thread-1', cwd: '/Users/example/Documents/GitHub/desktop-workbench', lastTs: Math.floor(Date.parse('2026-09-27T05:05:53.000Z') / 1000) })
  })

  it('审查子会话(source 是对象、thread_source=guardian_review、指向父对话)不算一条对话', () => {
    expect(parseCodexRollout(desktopMeta({
      source: { subagent: { other: 'guardian' } },
      thread_source: 'guardian_review',
      parent_thread_id: 'thread-parent',
    }))).toBeUndefined()
  })

  it('source 写法认不出、但 thread_source 明说是他自己那条 → 认(不再靠撞上对象形状来排除)', () => {
    expect(parseCodexRollout(desktopMeta({ source: { app: { desktop: true } }, thread_source: 'user' })))
      .toEqual({ id: 'thread-1', cwd: '/Users/example/Documents/GitHub/desktop-workbench', lastTs: Math.floor(Date.parse('2026-09-27T05:05:53.000Z') / 1000) })
  })

  it('source 是老的字符串、可指着父对话 → 还是子会话,不算一条', () => {
    expect(parseCodexRollout(desktopMeta({ source: 'vscode', parent_thread_id: 'thread-parent' })))
      .toBeUndefined()
  })

  it('两条 user 线程各算一条(维护者 13:15:「现在应该是两条」)', () => {
    const ids = ['thread-a', 'thread-b'].map(id => parseCodexRollout(JSON.stringify({
      type: 'session_meta',
      payload: { id, cwd: '/Users/example/p', source: 'vscode', thread_source: 'user', parent_thread_id: null },
    }))?.id)
    expect(ids).toEqual(['thread-a', 'thread-b'])
  })

  // 10-08 真机:她从 ChatGPT 接过来的那条(chatgpt_handoff)与 Codex「另开一条」开出来的
  // (agent_created_thread)都是没父对话的顶层对话,原来只认 'user' 整条消失。
  it.each(['chatgpt_handoff', 'agent_created_thread', 'some_future_kind'])(
    '顶层对话不管 thread_source 写 %s 都认',
    (threadSource) => {
      expect(parseCodexRollout(desktopMeta({ source: 'vscode', thread_source: threadSource, parent_thread_id: null }))?.id)
        .toBe('thread-1')
    },
  )

  it.each(['guardian_review', 'subagent'])('thread_source=%s 即使没写父对话也不算一条', (threadSource) => {
    expect(parseCodexRollout(desktopMeta({ source: 'vscode', thread_source: threadSource }))).toBeUndefined()
  })

  it('source 是 subagent 对象、没写父对话 → 还是子会话', () => {
    expect(parseCodexRollout(desktopMeta({ source: { subagent: { thread_spawn: {} } }, thread_source: 'user' })))
      .toBeUndefined()
  })
})

/**
 * 发现路径要看得见「开在几天前、今天还在写」的那条对话(2026-09-27,卡 CX 的根因)。
 * rollout 按**会话开始那一天**落目录,只列今天和昨天就等于看不见它。
 */
describe('defaultCodexSessionFeedDeps.listRecentRollouts(卡 CX)', () => {
  function dayDir(home: string, dayOffset: number): string {
    const d = new Date(Date.now() - dayOffset * 86_400_000)
    return join(home, 'sessions', String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  }

  it('列出 4 天前目录里的 rollout(他那条 09-23 开、09-27 还在写的对话)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-discover-'))
    try {
      const old = join(dayDir(home, 4), 'rollout-old.jsonl')
      const today = join(dayDir(home, 0), 'rollout-today.jsonl')
      for (const file of [old, today]) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, sessionMeta('vscode'))
      }
      writeFileSync(join(dayDir(home, 0), 'notes.txt'), 'x')
      const found = await defaultCodexSessionFeedDeps(home).listRecentRollouts?.() ?? []
      expect([...found].sort()).toEqual([old, today].sort())
    }
    finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it(`回看窗口就是 ${DISCOVER_DAYS} 天:更早的目录不扫(sweep 的 stat 成本有界)`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-discover-'))
    try {
      const tooOld = join(dayDir(home, DISCOVER_DAYS + 1), 'rollout-ancient.jsonl')
      mkdirSync(dirname(tooOld), { recursive: true })
      writeFileSync(tooOld, sessionMeta('vscode'))
      expect(await defaultCodexSessionFeedDeps(home).listRecentRollouts?.()).toEqual([])
    }
    finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})

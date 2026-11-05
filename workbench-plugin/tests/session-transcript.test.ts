// @vitest-environment node
/**
 * 完整对话(2026-10-01,手机读对话卡 B;维护者:「只有最近一轮我说的和一轮 AI 说的,往上就没了」)。
 *
 * ① 从最新往前按轮分页,带游标往上翻,一直翻到开头;拼起来不重不漏;
 * ② 文字不截断(原来她那句截 80、AI 那句截 120);
 * ③ 工具调用连着的几步折成一条,一行人话 + 展开看说明与文件名,**不给原始输出**;
 * ④ 系统注入(system-reminder、工具结果、元记录)不出现;
 * ⑤ 报错 / 被打断如实一行;⑥ 坏游标 400、认不出的会话 404;⑦ 一行几 MB 的截图记录不拖垮。
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionTranscriptEntry, SessionTranscriptView } from '../src/protocol.ts'
import type { SessionFileRef } from '../src/server/sessionHistory.ts'
import { createSessionTranscript } from '../src/server/sessionTranscript.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const line = (row: unknown) => JSON.stringify(row)
const at = (minute: number) => new Date(Date.parse('2026-09-30T13:00:00Z') + minute * 60_000).toISOString()
const LONG = `这是一段很长的回答。${'第二段里有很多字,'.repeat(40)}最后一句。`

function ask(i: number, text: string, extra: Record<string, unknown> = {}) {
  return line({ type: 'user', sessionId: 's', timestamp: at(i * 10), origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra })
}
function say(i: number, text: string, stop = 'end_turn') {
  return line({ type: 'assistant', sessionId: 's', timestamp: at(i * 10 + 5), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } })
}

function write(rows: string[]): { file: string, ref: SessionFileRef } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-transcript-'))
  dirs.push(dir)
  const file = join(dir, 's.jsonl')
  writeFileSync(file, `${rows.join('\n')}\n`)
  return { file, ref: { agent: 'claude', session_id: 's', file, format: 'claude-transcript' } }
}

function reader(ref: SessionFileRef | undefined) {
  return createSessionTranscript({ locate: async (agent, id) => (ref !== undefined && agent === ref.agent && id === ref.session_id ? ref : undefined), now: () => new Date('2026-10-01T09:00:00Z') })
}

async function page(t: ReturnType<typeof reader>, before?: string): Promise<SessionTranscriptView> {
  const got = await t.read({ agent: 'claude', id: 's', ...(before === undefined ? {} : { before }) })
  if (!got.ok) throw new Error(got.error)
  return got.value
}

const texts = (entries: readonly SessionTranscriptEntry[]) => entries.map(entry => (entry.k === 'steps' ? `[${entry.line}]` : entry.text))

describe('完整对话:往上翻到开头', () => {
  it('★十轮对话:每页四轮,往上翻三次到开头;拼起来不重不漏,长回答不截断', async () => {
    const rows: string[] = []
    for (let i = 1; i <= 10; i++) rows.push(ask(i, `第 ${i} 句`), say(i, i === 5 ? LONG : `回答 ${i}`))
    const { ref } = write(rows)
    const t = reader(ref)
    const first = await page(t)
    expect(texts(first.entries)).toEqual(['第 7 句', '回答 7', '第 8 句', '回答 8', '第 9 句', '回答 9', '第 10 句', '回答 10'])
    expect(first.before).toBeDefined()
    expect(first.entries[1]).toMatchObject({ k: 'reply', final: true, at: at(75) })
    const second = await page(t, first.before)
    expect(texts(second.entries)).toEqual(['第 3 句', '回答 3', '第 4 句', '回答 4', '第 5 句', LONG, '第 6 句', '回答 6'])
    const third = await page(t, second.before)
    expect(texts(third.entries)).toEqual(['第 1 句', '回答 1', '第 2 句', '回答 2'])
    expect(third.before).toBeUndefined()
  })

  it('标题取会话自己的名(custom-title 写在文件尾巴上也认)', async () => {
    const rows: string[] = [ask(1, '请做一支不超过 60 秒的样片')]
    for (let i = 0; i < 400; i++) rows.push(say(1, `过程 ${i} ${'字'.repeat(200)}`, 'tool_use'))
    rows.push(line({ type: 'custom-title', customTitle: 'Spotlight 参赛视频样片', sessionId: 's' }))
    const view = await page(reader(write(rows).ref))
    expect(view.title).toBe('Spotlight 参赛视频样片')
  })

  it('开头那几条(他第一句之前的元记录、标题)不会让第一页之前多出一页空的', async () => {
    const { ref } = write([
      line({ type: 'summary', summary: '旧摘要' }),
      ask(1, '只有一句'),
      say(1, '好'),
      line({ type: 'custom-title', customTitle: '一句话的会话', sessionId: 's' }),
    ])
    const view = await page(reader(ref))
    expect(texts(view.entries)).toEqual(['只有一句', '好'])
    expect(view.before).toBeUndefined()
    expect(view.title).toBe('一句话的会话')
  })

  it('★系统注入不出现:夹在她那句里的 system-reminder 剥掉;工具结果、isMeta、子任务回报整条不算', async () => {
    const { ref } = write([
      ask(1, '帮我看看<system-reminder>这是注入的</system-reminder>这个问题'),
      line({ type: 'user', isMeta: true, timestamp: at(11), message: { role: 'user', content: 'Caveat: 元记录' } }),
      line({ type: 'user', timestamp: at(12), origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>子任务</task-notification>' } }),
      line({ type: 'user', timestamp: at(13), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET-OUTPUT 原始大输出' }] } }),
      say(1, '看完了'),
    ])
    const view = await page(reader(ref))
    expect(texts(view.entries)).toEqual(['帮我看看 这个问题', '看完了'])
    expect(JSON.stringify(view)).not.toMatch(/SECRET-OUTPUT|注入|Caveat|子任务/)
  })

  it('★工具调用连着的几步折成一条:一行人话,展开看说明与文件名,不给原始输出', async () => {
    const { ref } = write([
      ask(1, '修一下'),
      line({ type: 'assistant', timestamp: at(11), message: { role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'text', text: '我先看一下。' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/Users/example/x/src/a.ts' } },
      ] } }),
      line({ type: 'user', timestamp: at(12), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RAW-FILE-CONTENT' }] } }),
      line({ type: 'assistant', timestamp: at(13), message: { role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/Users/example/x/src/a.ts', old_string: 'OLD-CODE', new_string: 'NEW-CODE' } },
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pnpm vitest run', description: '跑一遍测试' } },
      ] } }),
      line({ type: 'user', timestamp: at(14), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'RAW-TEST-OUTPUT' }] } }),
      say(1, '修好了。'),
    ])
    const view = await page(reader(ref))
    expect(view.entries.map(entry => entry.k)).toEqual(['ask', 'reply', 'steps', 'reply'])
    const steps = view.entries[2]
    expect(steps).toMatchObject({
      k: 'steps',
      line: '做了 3 步:改了 1 个文件、跑了 1 次测试、看了 1 个文件',
      steps: [
        { line: '看文件', files: ['a.ts'] },
        { line: '改文件', files: ['a.ts'] },
        { line: '跑测试', detail: '跑一遍测试' },
      ],
    })
    expect(JSON.stringify(view)).not.toMatch(/RAW-|OLD-CODE|NEW-CODE|pnpm vitest|\/Users\/ben/)
  })

  it('报错、被打断如实一行', async () => {
    const { ref } = write([
      ask(1, '你好'),
      line({ type: 'assistant', isApiErrorMessage: true, error: 'authentication_failed', timestamp: at(11), message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }),
    ])
    const view = await page(reader(ref))
    expect(view.entries[1]).toMatchObject({ k: 'note', tone: 'fail' })
    expect((view.entries[1] as { text: string }).text).toMatch(/登录/)
  })

  it('Codex 记录:新版同一句话出现两遍只认一份', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-transcript-'))
    dirs.push(dir)
    const file = join(dir, 'rollout.jsonl')
    writeFileSync(file, [
      line({ type: 'session_meta', timestamp: at(0), payload: { id: 'cx', cwd: '/x', source: 'vscode' } }),
      line({ type: 'response_item', timestamp: at(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>注入</environment_context>' }] } }),
      line({ type: 'response_item', timestamp: at(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '做参赛网页' }] } }),
      line({ type: 'event_msg', timestamp: at(2), payload: { type: 'user_message', message: '做参赛网页' } }),
      line({ type: 'event_msg', timestamp: at(3), payload: { type: 'agent_message', message: '好,先搭骨架', phase: 'commentary' } }),
      line({ type: 'response_item', timestamp: at(3), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好,先搭骨架' }] } }),
      line({ type: 'event_msg', timestamp: at(4), payload: { type: 'task_complete' } }),
    ].join('\n'))
    const t = createSessionTranscript({ locate: async () => ({ agent: 'codex', session_id: 'cx', file, format: 'codex-rollout' }) })
    const got = await t.read({ agent: 'codex', id: 'cx' })
    expect(got.ok && texts(got.value.entries)).toEqual(['做参赛网页', '好,先搭骨架'])
  })

  it('坏游标 400(不是数、超出文件、不在一行开头);认不出的会话 404', async () => {
    const { ref, file } = write([ask(1, '一'), say(1, '二'), ask(2, '三'), say(2, '四')])
    const t = reader(ref)
    for (const before of ['abc', '-1', String(statSync(file).size + 10), '3']) {
      const got = await t.read({ agent: 'claude', id: 's', before })
      expect(got.ok ? 200 : got.status, before).toBe(400)
    }
    const none = await t.read({ agent: 'claude', id: 'nope' })
    expect(none.ok ? 200 : none.status).toBe(404)
  })

  it('一行几 MB 的截图记录:照读,不把图的字节塞进回包', async () => {
    const big = 'A'.repeat(3 * 1024 * 1024)
    const { ref } = write([
      ask(1, '前一句'),
      say(1, '嗯'),
      line({ type: 'user', timestamp: at(20), origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }, { type: 'text', text: '看这张截图' }] } }),
      say(2, '看到了'),
    ])
    const view = await page(reader(ref))
    expect(texts(view.entries)).toEqual(['前一句', '嗯', '看这张截图', '看到了'])
    expect(JSON.stringify(view).length).toBeLessThan(20_000)
  })
})

describe('开着的对话还在长:只刷新最新那一段', () => {
  it('★from=最新一页的起点 → 那一行到末尾的全部(新出来的几轮接在后面),与翻上去的那几页接得上', async () => {
    const rows: string[] = []
    for (let i = 1; i <= 6; i++) rows.push(ask(i, `第 ${i} 句`), say(i, `回答 ${i}`))
    const { ref, file } = write(rows)
    const t = reader(ref)
    const first = await page(t)
    expect(texts(first.entries)[0]).toBe('第 3 句')
    // 她看着的时候又说了两轮
    writeFileSync(file, `${[...rows, ask(7, '第 7 句'), say(7, '回答 7'), ask(8, '第 8 句'), say(8, '回答 8')].join('\n')}\n`)
    const fresh = await t.read({ agent: 'claude', id: 's', from: first.before })
    expect(fresh.ok && texts(fresh.value.entries)).toEqual(['第 3 句', '回答 3', '第 4 句', '回答 4', '第 5 句', '回答 5', '第 6 句', '回答 6', '第 7 句', '回答 7', '第 8 句', '回答 8'])
    expect(fresh.ok && fresh.value.before).toBe(first.before)
    const older = await page(t, first.before)
    expect(texts(older.entries)).toEqual(['第 1 句', '回答 1', '第 2 句', '回答 2'])
    const all = await t.read({ agent: 'claude', id: 's', from: '0' })
    expect(all.ok && all.value.before).toBeUndefined()
  })
})

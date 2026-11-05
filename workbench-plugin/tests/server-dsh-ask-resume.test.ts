// @vitest-environment node
/**
 * DSH 会话里那一问跨不过重启 —— **让事务官重新问一遍**(2026-09-26,卡 SM 第四件)。
 *
 * 卡 U8 交接第四节第 2 条:`ask_user_question` 那一路等的是**那一轮 agent 的 Promise**,
 * 重启之后那一轮早没了。把那一行原样摆回界面上是更糟的谎(他答了,答案落进一个没人在等的
 * Promise)。所以做对的样子是:**外层不挂回那一问**,而是跟那条会话说一句,让她自己再问一次。
 *
 * 这一份钉三样(卡上点名要的):
 * 1. **判据** —— 什么叫「断了」:最后那一次 `ask_user_question` 一条 `tool/result` 都没有;
 *    有着落的(答了 / 她自己撤了 / 出错了)一律不碰(宁可少问一次,不冤枉一次);
 * 2. **去重** —— 我们那一句本身会落进同一份日志,所以「催过没有」的账就在日志里:
 *    那一次 call 之后出现过带记号的一条 `user/message` 就不再催(**又重启一次也不会再说一遍**);
 * 3. **只问一次** —— `resume()` 叫第二次是空操作;一条会话一趟最多一句。
 *
 * 会话日志的形状照 `tests/fixtures/dsh-session-v4/`(上游自己的编码器生成的那一份):
 * `tool/call {callId,name,arguments}` / `tool/result {message:{toolCallId}}` / `user/message {content:[{text}]}`。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import {
  candidateSessions, createDshAskResume, danglingAskOf, pickLogName, RE_ASK_LINE, RE_ASK_MARK,
} from '../src/server/dshAskResume.ts'
import { createQuestionBroker } from '../src/server/butlerAsks.ts'

const PREFIX = join(tmpdir(), 'wb-ask-resume-')
const boxes: string[] = []
afterEach(() => {
  while (boxes.length) {
    const box = boxes.pop() as string
    // 只删自己 mkdtemp 出来的那一棵(0904 家目录事故铁律)。
    if (!box.startsWith(PREFIX) || box.slice(PREFIX.length).includes('/')) throw new Error(`拒绝删除:${box}`)
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const AT = 1789468212357

/** 一行日志。 */
function row(type: string, data: Record<string, unknown>, time = AT): string {
  return JSON.stringify({ type, seq: 1, time, data })
}

/** 她问他一问(`ask_user_question` 的 tool/call)。 */
function ask(callId: string, question = '派活前对一遍', time = AT): string {
  return row('tool/call', {
    turn: 1, step: 1, callId, name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', header: '确认', question, options: [{ label: '都对,开工' }] }] }),
  }, time)
}

/** 他答了(那一次调用有了结果)。 */
function answered(callId: string): string {
  return row('tool/result', {
    turn: 1, step: 1,
    message: { id: 'msg-tool-1', role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: '{"answers":[{"id":"q1","selected":["都对,开工"]}]}' }] },
  })
}

/** 一条人说的话。 */
function said(text: string): string {
  return row('user/message', { id: 'msg-user-1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
}

const HEADER = JSON.stringify({ type: 'session', version: 4, id: 'session-1', createdAt: AT - 9000, cwd: '/Users/example/x', delegationDepth: 0 })

function log(...lines: string[]): string {
  return `${[HEADER, ...lines].join('\n')}\n`
}

describe('判据:什么叫「那一问断了」', () => {
  it('★有 ask_user_question 的 tool/call、一条 tool/result 都没有 → 断了(带 callId、问出来那一刻、正文)', () => {
    const found = danglingAskOf(log(said('把小头像修一下'), ask('call-9')))
    expect(found).toEqual({ call_id: 'call-9', at_ms: AT, question: '派活前对一遍' })
  })

  it('他答了(那一次调用有结果)→ 不是断了,一个字都不催', () => {
    expect(danglingAskOf(log(ask('call-9'), answered('call-9')))).toBeUndefined()
  })

  it('结果只带 source.callId(没有 toolCallId)→ 照样算有着落', () => {
    const result = row('tool/result', { message: { role: 'tool', source: { kind: 'tool', callId: 'call-9' }, content: [] } })
    expect(danglingAskOf(log(ask('call-9'), result))).toBeUndefined()
  })

  it('结果不是 `{answers}`(她自己关掉了 / 出错了)→ **也算有着落**:宁可少问一次,不冤枉一次', () => {
    const errored = row('tool/result', {
      message: { role: 'tool', toolCallId: 'call-9', content: [{ type: 'text', text: 'ask_user_question was aborted before the user answered' }] },
    })
    expect(danglingAskOf(log(ask('call-9'), errored))).toBeUndefined()
  })

  it('别的工具调用没结果不算(只认她问他那一种)', () => {
    const write = row('tool/call', { callId: 'call-w', name: 'write', arguments: '{"file_path":"/x"}' })
    expect(danglingAskOf(log(write))).toBeUndefined()
  })

  it('★问过好几轮:只认最后那一次 —— 前面那次答了、最后那次断了 → 催;反过来 → 不催', () => {
    expect(danglingAskOf(log(ask('c1'), answered('c1'), ask('c2', '要不要派给 Codex'))))
      .toMatchObject({ call_id: 'c2', question: '要不要派给 Codex' })
    expect(danglingAskOf(log(ask('c1'), ask('c2'), answered('c2')))).toBeUndefined()
  })

  it('坏行、截断的最后一行、空行:跳过,绝不抛', () => {
    const text = `${HEADER}\n{"type":"tool/ca\n\n${ask('call-9')}\n{"type":"tool/res`
    expect(danglingAskOf(text)).toMatchObject({ call_id: 'call-9' })
    expect(danglingAskOf('')).toBeUndefined()
    expect(danglingAskOf('不是 JSON')).toBeUndefined()
  })

  it('没有 callId / 正文的那一次调用不认(催了也说不清是哪一问)', () => {
    expect(danglingAskOf(log(row('tool/call', { name: 'ask_user_question' })))).toBeUndefined()
    // 正文取不出来时只是缺那一格,照样认得出「断了」。
    expect(danglingAskOf(log(row('tool/call', { callId: 'c3', name: 'ask_user_question', arguments: '不是 JSON' }))))
      .toEqual({ call_id: 'c3', at_ms: AT })
  })
})

describe('去重:催过没有的账就在日志里', () => {
  it('★那一次 call 之后有我们那一句(带记号)→ 不再催(又重启一次也不会再说一遍)', () => {
    expect(danglingAskOf(log(ask('call-9'), said(RE_ASK_LINE)))).toBeUndefined()
  })

  it('我们那一句在那一次 call **之前**(上一轮催的)→ 这一次照样算断了', () => {
    expect(danglingAskOf(log(said(RE_ASK_LINE), ask('call-10')))).toMatchObject({ call_id: 'call-10' })
  })

  it('他自己随便说的一句不算「催过」(只认那一句里的记号)', () => {
    expect(danglingAskOf(log(ask('call-9'), said('在吗')))).toMatchObject({ call_id: 'call-9' })
    // 记号就是这一句里那几个字 —— 改它等于把账本换了。
    expect(RE_ASK_LINE).toContain(RE_ASK_MARK)
    expect(RE_ASK_MARK).toBe('因为工作台重启断了')
  })
})

describe('挑哪一份日志、看哪几条会话', () => {
  it('一个会话目录里挑**数字最高的那一代**;同一代里取压缩那份', () => {
    expect(pickLogName(['session.jsonl', 'session.v4.jsonl'])).toEqual({ name: 'session.v4.jsonl', compressed: false })
    expect(pickLogName(['session.v4.jsonl', 'session.v4.jsonl.zstd'])).toEqual({ name: 'session.v4.jsonl.zstd', compressed: true })
    expect(pickLogName(['session.jsonl'])).toEqual({ name: 'session.jsonl', compressed: false })
    expect(pickLogName(['session.lock', 'session.v4.jsonl.tmp', 'session.v0.jsonl'])).toBeUndefined()
    expect(pickLogName([])).toBeUndefined()
  })

  it('候选只有看板上**还活着**的事项底下那几条会话,去重', () => {
    const tasks = [
      task('t-1', 'doing', 's-1'),
      task('t-2', 'todo', 's-1'),
      task('t-3', 'done', 's-2'),
      task('t-4', 'canceled', 's-3'),
      task('t-5', 'doing', undefined),
    ]
    expect(candidateSessions(tasks)).toEqual(['s-1'])
  })
})

function task(id: string, status: string, sessionId: string | undefined): TaskView {
  return {
    id, title: id, status, direction: 'mine', source: { kind: 'manual' }, created_at: '', updated_at: '',
    ...(sessionId === undefined ? {} : { conversation: { agent: 'dsh', session_id: sessionId } }),
  } as unknown as TaskView
}

/** 一台机器:`<box>/.dsh/sessions/<项目目录>/<会话 id>/session.v4.jsonl`(真形态,真去找)。 */
function box(): { sessionsDir: string, put: (sessionId: string, text: string, project?: string) => string } {
  const root = mkdtempSync(PREFIX)
  boxes.push(root)
  const sessionsDir = join(root, '.dsh', 'sessions')
  return {
    sessionsDir,
    put(sessionId, text, project = '-Users-ben-Documents-GitHub-x') {
      const dir = join(sessionsDir, project, sessionId)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'session.v4.jsonl')
      writeFileSync(file, text)
      return file
    },
  }
}

/** 真的 io(node fs):文件在哪、挑哪一代、读得出来,这一路是真走的。 */
const io = {
  readdir: async (dir: string) => { try { return await readdir(dir) } catch { return [] } },
  readLog: async (file: string) => { try { return await readFile(file, 'utf8') } catch { return undefined } },
}

function rig(options: {
  sessionsDir: string
  tasks: readonly TaskView[]
  pending?: readonly { session_id: string }[]
  accept?: boolean
  ready?: () => boolean
}) {
  const saidTo: { session: string, text: string }[] = []
  const resume = createDshAskResume({
    sessionsDir: options.sessionsDir,
    io,
    tasks: async () => options.tasks,
    pending: () => options.pending ?? [],
    say: async (session, text) => { saidTo.push({ session, text }); return options.accept ?? true },
    ...(options.ready === undefined ? {} : { ready: options.ready }),
    wait: async () => {},
    readyTries: 2,
    readyGapMs: 0,
  })
  return { resume, saidTo }
}

describe('resume():重启后跟那条会话说一句', () => {
  it('★真目录形态:认出断了的那一问 → 往那条会话说一句「再问我一次」;外层一问都没挂', async () => {
    const machine = box()
    machine.put('session-1', log(said('把小头像修一下'), ask('call-9')))
    const questions = createQuestionBroker()
    // 经纪人是真的那一个,而且**是空的** —— 重启后本来就是空的(它只在内存里)。
    const { resume, saidTo } = rig({ sessionsDir: machine.sessionsDir, tasks: [task('t-1', 'doing', 'session-1')], pending: questions.list() })
    const report = await resume.resume()
    expect(report).toMatchObject({ ready: true, looked: 1, asked: ['session-1'], failed: [] })
    expect(saidTo).toEqual([{ session: 'session-1', text: RE_ASK_LINE }])
    // **外层不挂回那一问**:经纪人里一条都没有(那一问已经没人在等了,摆出来他答了也没人收)。
    expect(questions.list()).toEqual([])
  })

  it('★只问一次:`resume()` 叫第二次是空操作', async () => {
    const machine = box()
    machine.put('session-1', log(ask('call-9')))
    const { resume, saidTo } = rig({ sessionsDir: machine.sessionsDir, tasks: [task('t-1', 'doing', 'session-1')] })
    await resume.resume()
    const again = await resume.resume()
    expect(again).toMatchObject({ looked: 0, asked: [] })
    expect(saidTo).toHaveLength(1)
  })

  it('★又重启一次:日志里已经有我们那一句 → 不再催', async () => {
    const machine = box()
    machine.put('session-1', log(ask('call-9'), said(RE_ASK_LINE)))
    const { resume, saidTo } = rig({ sessionsDir: machine.sessionsDir, tasks: [task('t-1', 'doing', 'session-1')] })
    expect((await resume.resume()).asked).toEqual([])
    expect(saidTo).toEqual([])
  })

  it('经纪人里挂着这条会话的一问(**活的**,这一趟之前刚问的)→ 不去催', async () => {
    const machine = box()
    machine.put('session-1', log(ask('call-9')))
    const { resume, saidTo } = rig({
      sessionsDir: machine.sessionsDir,
      tasks: [task('t-1', 'doing', 'session-1')],
      pending: [{ session_id: 'session-1' }],
    })
    expect(await resume.resume()).toMatchObject({ looked: 0, asked: [] })
    expect(saidTo).toEqual([])
  })

  it('答过了 / 事项已经完成 / 那条会话没有日志:各自安静跳过', async () => {
    const machine = box()
    machine.put('session-1', log(ask('c1'), answered('c1')))
    machine.put('session-2', log(ask('c2')))
    const { resume, saidTo } = rig({
      sessionsDir: machine.sessionsDir,
      // session-2 那一问真断了,但它那件事已经完成 —— 不再问(同「同类的都允许」作废那条)。
      tasks: [task('t-1', 'doing', 'session-1'), task('t-2', 'done', 'session-2'), task('t-3', 'doing', 'session-没有日志')],
    })
    expect(await resume.resume()).toMatchObject({ looked: 2, asked: [], failed: [] })
    expect(saidTo).toEqual([])
  })

  it('那一句说不进去(会话在 DSH 里真没了)→ 记一笔 failed,不当成催过了', async () => {
    const machine = box()
    machine.put('session-1', log(ask('call-9')))
    const { resume } = rig({ sessionsDir: machine.sessionsDir, tasks: [task('t-1', 'doing', 'session-1')], accept: false })
    expect(await resume.resume()).toMatchObject({ asked: [], failed: ['session-1'] })
  })

  it('会话通道还没接上(等了几拍还是没有)→ 这一趟什么都不做,不报错;**这一枪没用掉**', async () => {
    const machine = box()
    machine.put('session-1', log(ask('call-9')))
    let up = false
    const { resume, saidTo } = rig({ sessionsDir: machine.sessionsDir, tasks: [task('t-1', 'doing', 'session-1')], ready: () => up })
    expect(await resume.resume()).toEqual({ ready: false, looked: 0, asked: [], failed: [] })
    expect(saidTo).toEqual([])
    // 一句话都没说的空跑不算「问过了」:通道后来接上了,再叫一次照样催得动。
    up = true
    expect((await resume.resume()).asked).toEqual(['session-1'])
    expect(saidTo).toHaveLength(1)
  })

  it('两条会话各断了一问:各说一句,一条会话最多一句', async () => {
    const machine = box()
    machine.put('session-1', log(ask('c1')), '-Users-ben-a')
    machine.put('session-2', log(ask('c2'), ask('c3')), '-Users-ben-b')
    const { resume, saidTo } = rig({
      sessionsDir: machine.sessionsDir,
      tasks: [task('t-1', 'doing', 'session-1'), task('t-2', 'blocked', 'session-2')],
    })
    expect((await resume.resume()).asked).toEqual(['session-1', 'session-2'])
    expect(saidTo).toHaveLength(2)
  })
})

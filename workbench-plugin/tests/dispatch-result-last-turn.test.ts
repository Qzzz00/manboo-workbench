// @vitest-environment node
/**
 * 派活收回结果要取**最后那一段交代**,而且**一件事一条**(2026-09-28,卡 RC)。
 *
 * 现场(09-28 10:2x,维护者本机 0.4.51):他在手机上批了「验证自我迭代能力」派给 Claude(窗口那只手)。
 * Claude 做完之后工作台的样子是 ——
 * - 事项 t-eade4c97 `confirm`「办完了,等你确认」,收回的结果是**中途那句**「所有核心自我迭代相关的测试全过。再快速扫一眼整套…」;
 * - 「等你」里另有一条孤立的「Claude 在等你点头:落在哪(她的工作目录还是 )需要你拍板后另开一张卡」——
 *   括号里还被脱敏挖空了。
 *
 * 三条判据(fixture 用的就是真形状:中途句 + 最后那句问句):
 * ① 结果取最后一个回合的完整回答;② 事项 = 阻塞·等你输入,要他定的那一句写在卡上,「等你」里只剩一条;
 * ③ 脱敏给人看的那一路换成可读占位,不把句子挖空。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskClientDispatch, WorkbenchState } from '../src/protocol.ts'
import type { ClientDispatch } from '../src/server/dispatchSend.ts'
import { extractReply } from '../src/server/dispatchReply.ts'
import { dispatchResultOf, lastAssistantTurn, sessionByMarker } from '../src/server/dispatchResult.ts'
import type { DispatchSessionLike } from '../src/server/dispatchRun.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import { askedItemNote, askedQuestion, replyAsksHim } from '../src/server/replyAsks.ts'
import { pathPlaceholder, speakable } from '../src/server/waitingForYou.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { waitingOnHim } from '../src/waiting.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** 真形状:Claude 中途那一条过程话 + 最后那一段交代(在问他)。 */
const MID = '所有核心自我迭代相关的测试全过。再快速扫一眼整套以确认没有破损。'
const LAST = '落在哪(`/Users/example/Documents/GitHub/desktop-workbench` 还是她的工作目录)需要你拍板后另开一张卡?'

describe('① 结果取最后那一段交代', () => {
  it('★Claude 桌面版:一个回合里几条消息就有几行「Claude responded:」,取最后那一行(以前取第一行 = 中途句)', () => {
    const prompt = '【工作台派活 eade4c】验证自我迭代能力'
    const got = extractReply([
      prompt,
      `Claude responded: ${MID}`,
      '复制',
      `Claude responded: ${LAST}`,
      '复制',
    ], { family: 'claude', prompt })
    expect(got.text).toBe(LAST)
    expect(got.text).not.toContain('测试全过')
  })

  it('会话文件那一份优先:最后一个回合的完整回答顶掉窗口里读到的中途句', () => {
    const turns = [
      { role: 'user', text: '【工作台派活 eade4c】验证自我迭代能力' },
      { role: 'assistant', text: MID },
      { role: 'assistant', text: LAST },
    ]
    expect(lastAssistantTurn(turns)).toBe(LAST)
    expect(dispatchResultOf({ windowReply: MID, turns })).toEqual({ text: LAST, from: 'session' })
    // 读不到会话就照实用窗口那一段(不编)。
    expect(dispatchResultOf({ windowReply: MID })).toEqual({ text: MID, from: 'window' })
    expect(dispatchResultOf({ windowReply: MID, turns: [{ role: 'user', text: '在?' }] }).from).toBe('window')
  })

  it('按记号认会话:派出去那条对话里带着「工作台派活 xxxxxx」;两条都带就不认', () => {
    const ours = { session_id: 's-ours', turns: [{ role: 'user', text: '**【工作台派活 eade4c】** 验证自我迭代能力' }] }
    const his = { session_id: 's-his', turns: [{ role: 'user', text: '顺手看个别的' }] }
    expect(sessionByMarker('工作台派活 eade4c', [his, ours])).toBe('s-ours')
    expect(sessionByMarker('工作台派活 eade4c', [his])).toBeUndefined()
    expect(sessionByMarker('工作台派活 eade4c', [ours, { ...ours, session_id: 's-two' }])).toBeUndefined()
  })
})

describe('③ 脱敏不许把句子挖空', () => {
  it('★路径换成可读的占位(末段目录名),不是删成空', () => {
    expect(pathPlaceholder('/Users/example/Documents/GitHub/desktop-workbench')).toBe('「desktop-workbench」')
    expect(pathPlaceholder('~/')).toBe('你的某个文件夹')
    const said = speakable(LAST, 60) as string
    expect(said).toContain('desktop-workbench')
    expect(said).not.toContain('/Users')
    // 09-28 现场那一句的病:括号里被挖空。
    expect(said).not.toMatch(/[((]\s*[))]/)
    expect(said).not.toMatch(/还是\s*[))]/)
  })
})

describe('② 一件事一条', () => {
  it('那段回答在问他 → 要他定的那一句从他自己的话里取,写在事项上', () => {
    expect(replyAsksHim(LAST)).toBeDefined()
    expect(askedQuestion(MID)).toBeUndefined()
    const question = askedQuestion(LAST) as string
    expect(question).toContain('落在哪')
    const note = askedItemNote({ who: 'Claude', what: '她最后那一句是在问你', text: LAST })
    expect(note).toBe(`Claude 做完了,但要你定一件事:${question}`)
    // 取不出问句就退回那句概括,不编一个问题。
    expect(askedItemNote({ who: 'Claude', what: '她列了几条要你确认', text: '`a.ts`?' })).toContain('在等你回话')
  })

  it('★「等你」里只有一条:事项那一条(带要他定的那句话),同一条会话的 ask 不再另算', () => {
    const note = 'Claude 做完了,但要你定一件事:落在哪(「desktop-workbench」还是她的工作目录)'
    const state = {
      tasks: {
        tasks: [{
          id: 't-eade4c97', title: '验证自我迭代能力', status: 'blocked', block_reason: 'input', note,
          client_dispatch: { session_id: 's-ours' },
        }],
      },
      sessions: [{ agent: 'claude', session_id: 's-ours', ask: { kind: 'approve', question: '落在哪', since: '2026-09-28T02:20:00Z' } }],
    } as unknown as Parameters<typeof waitingOnHim>[0]
    const view = waitingOnHim(state)
    expect(view.count).toBe(1)
    expect(view.items[0]?.task_id).toBe('t-eade4c97')
    expect(view.items[0]?.text).toContain('「验证自我迭代能力」')
    expect(view.items[0]?.text).toContain('要你定一件事')
    expect(view.items.some(one => one.kind === 'session')).toBe(false)
  })

  it('别人家的那条会话照旧算一条(没有哪件事把它认走)', () => {
    const state = {
      sessions: [{ agent: 'codex', session_id: 's-other', ask: { kind: 'choose', question: '用方案 A 还是 B', since: '2026-09-28T02:20:00Z' } }],
    } as unknown as Parameters<typeof waitingOnHim>[0]
    expect(waitingOnHim(state).count).toBe(1)
  })
})

describe('端到端:派给有会话文件的那一家,收回来的是最后那一段,卡进「等你输入」', () => {
  it('★中途句不当结果;事项 = 阻塞·等你输入,卡上写着要他定的那一句;不进「等我确认」', async () => {
    const clock = Date.parse('2026-09-28T02:20:00Z')
    const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-last-turn-'))
    dirs.push(dir)
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => 't-eade4c9' })
    const sessions: DispatchSessionLike[] = []
    const turns = new Map<string, { role: string, text: string }[]>()
    /**
     * ★ 2026-10-02(卡「引擎接线与删复制品」):盯窗那一拍从「自己拿壳 + 自己 `extractReply`」
     * 换成了 `engine.read` —— 那一下**不送、不点、不叫台前、不开窗**,`reply_watch` 那道闸在引擎里面。
     * 所以这里排的不再是壳的 `read_reply` 回包,而是**引擎读到的那一段**(窗口里只看得见中途那句)。
     */
    const reads: { reply?: string, busy?: boolean }[] = []
    const clientDispatch: ClientDispatch = {
      async send(input) {
        const dispatch: TaskClientDispatch = {
          hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
          at: new Date(clock).toISOString(), text: input.text, submitted: true, method: 'ax_value',
          baseline: sessions.map(one => one.session_id), new_conversation: '新聊天',
        }
        return { ok: true, dispatch, baseline: dispatch.baseline ?? [] }
      },
    }
    const runner = createDispatchRunner({
      tasks,
      engine: {
        read: async () => {
          const one = reads.shift()
          // 读不到就如实说读不到(**不编一个「它还没回」**,与适配器那一处同一口径)。
          if (one === undefined) return { via: 'window', evidence: 'none', why: '这会儿读不到它的窗口' }
          return {
            via: 'window',
            evidence: 'window',
            ...(one.reply === undefined ? {} : { reply: one.reply }),
            ...(one.busy === true ? { busy: true } : {}),
          }
        },
      },
      clientDispatch,
      readFile: async () => undefined,
      sessions: () => sessions,
      turnsOf: id => turns.get(id),
      now: () => new Date(clock),
      setTimer: () => 'timer',
      clearTimer: () => {},
      notSeenMs: 60_000,
      replyTimeoutMs: 600_000,
    })
    const created = await tasks.create({ title: '验证自我迭代能力', direction: 'mine', status: 'todo' })
    const id = created.id as string
    await runner.start(id, { family: 'kimi', said: '验证自我迭代能力' })
    const prompt = (await tasks.list()).tasks.find(one => one.id === id)?.client_dispatch?.text as string
    // 他自己同时也开了一条(差集认不准那一种):按记号认得出我们派的是哪一条。
    sessions.push({ agent: 'kimi', session_id: 's-his', status: 'running' })
    sessions.push({ agent: 'kimi', session_id: 's-ours', status: 'running' })
    turns.set('s-his', [{ role: 'user', text: '顺手问个别的' }])
    turns.set('s-ours', [{ role: 'user', text: prompt }, { role: 'assistant', text: MID }, { role: 'assistant', text: LAST }])
    // 窗口里读回来的只有中途那句(真机上就是这样),连着两次一样 = 窗口那边"稳住了"。
    reads.push({ reply: MID })
    reads.push({ reply: MID })
    await runner.tick()
    await runner.tick()
    const task = (await tasks.list()).tasks.find(one => one.id === id)
    expect(task?.client_dispatch?.session_id).toBe('s-ours')
    expect(task?.client_dispatch?.reply).toBe(LAST)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('input')
    expect(task?.note).toContain('要你定一件事')
    expect(task?.note).toContain('落在哪')
    expect(task?.note).not.toContain('/Users')
    expect(task?.deliverables?.some(one => one.ref === LAST)).toBe(true)
  })
})

/** 用不上,只是让 WorkbenchState 这个类型在上面的 as 里有出处。 */
export type _State = WorkbenchState

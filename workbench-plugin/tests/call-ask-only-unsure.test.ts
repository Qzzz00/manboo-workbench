// @vitest-environment node
/**
 * **电话里只在拿不准时先确认**(2026-10-12,维护者拍板;交接 `docs/交接-1012-电话只在拿不准时确认.md`)。
 *
 * 维护者:「跟事务官电话好啰嗦,是因为她每次都要和我确认一遍,即使很清晰很简单的需求也要复述一遍」。
 * 规则:说清了就直接办;只在三种情况先问一句 ——
 *   ① 没说派给谁、又有几家都能做;② 撤不回或对外的事(发版、删东西、替她发消息、花钱);③ 这句话明显有两种理解。
 * 她说「先跟我确认」照旧问。
 *
 * 判断只在一处(`callAsk.ts`,词表 + 有没有点名 + 可派家数),由 `POST /confirm/points` 的 `call` 那一格带给电话那头;
 * 家数从派活挑手那张选项表(`dispatchChoices`)来,不另写一张表。判不准按「问」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CALL_ASK_WHY, callAskVerdict } from '../src/server/callAsk.ts'
import type { CallAskPick } from '../src/server/callAsk.ts'
import { buildChannelSystemMessage } from '../src/server/channel.ts'
import { dispatchChoices } from '../src/server/dispatchChoice.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const TWO_CAN: CallAskPick = {
  kind: 'code',
  default: 'claude',
  default_from: 'fallback',
  options: [
    { family: 'claude', title: 'Claude', ok: true },
    { family: 'codex', title: 'Codex', ok: true },
  ],
}

describe('callAskVerdict:说清了就直接办', () => {
  it('★★ 点了名的派活 → 不问', () => {
    const got = callAskVerdict({ for: 'dispatch', text: '让 Codex 把首页那个球的显示问题修一下', named: true })
    expect(got).toEqual({ ask: false, why: CALL_ASK_WHY.clear })
  })

  it('★ 没点名,但只有一家能做 → 不问', () => {
    const one: CallAskPick = { ...TWO_CAN, options: [TWO_CAN.options[0]!, { family: 'codex', title: 'Codex', ok: false }] }
    expect(callAskVerdict({ for: 'dispatch', text: '修一下首页球的显示问题', pick: one }).ask).toBe(false)
  })

  it('★ 没点名,但她的规矩 / 学出来的默认分派已经说了归谁 → 不问', () => {
    for (const from of ['rule', 'project_rule', 'learned'] as const) {
      expect(callAskVerdict({ for: 'dispatch', text: '修一下首页球的显示问题', pick: { ...TWO_CAN, default_from: from } }).ask).toBe(false)
    }
  })

  it('★ 没点名的聊天活(事务官自己答,不派)→ 不问', () => {
    expect(callAskVerdict({ for: 'dispatch', text: '查一下明天北京天气', pick: { kind: 'chat', options: TWO_CAN.options } }).ask).toBe(false)
  })

  it('★ 这台工作台不派活(没接派活 / 只出方案档)→ 不按家数问', () => {
    expect(callAskVerdict({ for: 'dispatch', text: '修一下首页球的显示问题', pick: 'none' }).ask).toBe(false)
  })

  it('「发布计划」是一格的名字,不算发版', () => {
    expect(callAskVerdict({ for: 'dispatch', text: '让 Claude 把这期选题放进发布计划', named: true }).ask).toBe(false)
  })

  it('她说「不用跟我确认」不是要她先确认', () => {
    expect(callAskVerdict({ for: 'dispatch', text: '让 Codex 改一下按钮颜色', said: '让 Codex 改一下按钮颜色,不用跟我确认', named: true }).ask).toBe(false)
  })
})

describe('callAskVerdict:三种情况先问一句', () => {
  it('★★ ① 没点名、又有几家都能做 → 问派给谁,带上默认那一家', () => {
    const got = callAskVerdict({ for: 'dispatch', text: '修一下首页球的显示问题', pick: TWO_CAN })
    expect(got.ask).toBe(true)
    expect(got.why).toBe(CALL_ASK_WHY.unassigned)
    expect(got.spoken).toContain('Claude')
    expect(got.spoken).toContain('Codex')
    expect(got.spoken).toContain('我先按 Claude')
  })

  it('★ ① 没点名、选项表拿不到 → 判不准,按问', () => {
    const got = callAskVerdict({ for: 'dispatch', text: '修一下首页球的显示问题' })
    expect(got.ask).toBe(true)
    expect(got.why).toBe(CALL_ASK_WHY.unsure)
  })

  it('★★ ② 发版 / 删东西 / 替她发消息 / 花钱 → 点了名也先问', () => {
    const cases: [string, string][] = [
      ['让 Claude 发个版', '发版'],
      ['让 Codex 把旧的分支都删掉', '删'],
      ['让豆包替我回复一下客户的邮件', '替你发出去'],
      ['让 Manus 帮我买一张明天去上海的票', '花钱'],
    ]
    for (const [text, word] of cases) {
      const got = callAskVerdict({ for: 'dispatch', text, named: true })
      expect(got.ask, text).toBe(true)
      expect(got.why, text).toBe(CALL_ASK_WHY.irreversible)
      expect(got.spoken, text).toContain(word)
    }
  })

  it('★ ③ 明显有两种理解 → 问那一处', () => {
    const got = callAskVerdict({ for: 'dispatch', text: '让 Claude 把那个东西改一下', named: true })
    expect(got.ask).toBe(true)
    expect(got.why).toBe(CALL_ASK_WHY.ambiguous)
    expect(got.hint).toContain('那个东西')
  })

  it('★★ 她说「先跟我确认」→ 问(她原话里说的也算,不只看模型填的那句)', () => {
    expect(callAskVerdict({ for: 'dispatch', text: '让 Codex 改一下按钮颜色,先跟我确认', named: true }).why).toBe(CALL_ASK_WHY.asked)
    const got = callAskVerdict({ for: 'dispatch', text: '让 Codex 改一下按钮颜色', said: '让 Codex 改一下按钮颜色,先问我一下再动手', named: true })
    expect(got.ask).toBe(true)
    expect(got.why).toBe(CALL_ASK_WHY.asked)
  })
})

describe('兄弟路各管哪几条', () => {
  it('需求卡 / 给在办的事补一句:不看家数,只看 ② ③ 与「先跟我确认」', () => {
    expect(callAskVerdict({ for: 'feature', text: '加一个导出 PDF 的按钮' }).ask).toBe(false)
    expect(callAskVerdict({ for: 'hand', text: '顺便把导出也做了' }).ask).toBe(false)
    expect(callAskVerdict({ for: 'feature', text: '做完直接发版上线' }).why).toBe(CALL_ASK_WHY.irreversible)
    expect(callAskVerdict({ for: 'hand', text: '顺便把那个东西也改了' }).why).toBe(CALL_ASK_WHY.ambiguous)
  })

  it('改版面 / 传文件给她自己的设备:撤得回、不对外,只在她说「先跟我确认」时问', () => {
    expect(callAskVerdict({ for: 'layout', text: '把「随手记」藏起来' }).ask).toBe(false)
    expect(callAskVerdict({ for: 'file', text: '把 README.md 发到你手机' }).ask).toBe(false)
    expect(callAskVerdict({ for: 'layout', text: '把「随手记」藏起来', said: '把随手记藏起来,先跟我确认' }).why).toBe(CALL_ASK_WHY.asked)
  })
})

describe('派活选项表带上「默认那家从哪来」', () => {
  const CLAUDE = { id: 'claude', title: 'Claude', hands: ['cli'], aliases: [], from_registry: true } as unknown as DispatchTarget
  const CODEX = { id: 'codex', title: 'Codex', hands: ['cli'], aliases: [], from_registry: true } as unknown as DispatchTarget
  const base = { text: '修一下首页球的显示问题', targets: [CLAUDE, CODEX], quota: {}, installed: () => true }

  it('点了名 → named', () => {
    expect(dispatchChoices({ ...base, named: 'codex' }).default_from).toBe('named')
  })
  it('规矩里写着写代码的活归谁 → rule', () => {
    expect(dispatchChoices({ ...base, division: { code: 'codex', projects: [] } }).default_from).toBe('rule')
  })
  it('行为账学出来的默认分派 → learned', () => {
    expect(dispatchChoices({ ...base, learned: () => ({ family: 'codex', why: '这类事你改派过两次 Codex' }) }).default_from).toBe('learned')
  })
  it('什么都没有、只是挑了第一家能改文件的 → fallback', () => {
    expect(dispatchChoices(base).default_from).toBe('fallback')
  })
})

describe('POST /confirm/points 带上 call 那一格', () => {
  const started: WorkbenchServer[] = []
  const dirs: string[] = []
  afterEach(async () => {
    while (started.length) await started.pop()?.close()
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  async function serve() {
    const dir = mkdtempSync(join(tmpdir(), 'wb-call-ask-'))
    dirs.push(dir)
    const tasks = createTasksService({ file: join(dir, 'tasks.json') })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({}),
      tickIntervalMs: 0,
      tasks,
      // 这台电脑上装着 Claude 与 Codex:写代码的活两家都能做。
      appInstalled: family => family === 'claude' || family === 'codex',
    })
    started.push(server)
    return server.url
  }

  async function ask(url: string, body: unknown) {
    const res = await fetch(`${url}/confirm/points`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return await res.json() as { ok: boolean, spoken: string, call?: { ask: boolean, why: string, spoken?: string } }
  }

  it('★★ 点了名、说得清 → call.ask = false', async () => {
    const url = await serve()
    const got = await ask(url, { text: '修一下首页球的显示问题', who: 'codex', for: 'dispatch' })
    expect(got.call).toMatchObject({ ask: false, why: CALL_ASK_WHY.clear })
  })

  it('★★ 没点名、两家都能做 → call.ask = true,spoken 问派给谁', async () => {
    const url = await serve()
    const got = await ask(url, { text: '修一下首页球的显示问题', for: 'dispatch' })
    expect(got.call?.ask).toBe(true)
    expect(got.call?.why).toBe(CALL_ASK_WHY.unassigned)
    expect(got.call?.spoken).toContain('派给哪个')
  })

  it('★ 她原话里说「先跟我确认」(said)→ 问,念的是确认点那一句', async () => {
    const url = await serve()
    const got = await ask(url, { text: '修一下首页球的显示问题', who: 'codex', for: 'dispatch', said: '让 Codex 修一下首页球,先跟我确认' })
    expect(got.call?.ask).toBe(true)
    expect(got.call?.why).toBe(CALL_ASK_WHY.asked)
    expect(got.call?.spoken).toBe(got.spoken)
  })

  it('不带 for 的老调用方 → 照旧只拿确认点,没有 call 那一格', async () => {
    const url = await serve()
    const got = await ask(url, { text: '修一下首页球的显示问题' })
    expect(got.call).toBeUndefined()
  })
})

describe('电话人设(8791 下发那一份)同步改', () => {
  const persona = buildChannelSystemMessage({ rememberTool: 'wb_remember_item', doingTool: 'wb_list_doing', handTool: 'wb_hand_to_butler' })
  it('★ 派活 / 需求卡:听清了就直接调,问不问由工具回话说了算', () => {
    expect(persona).toContain('别先问「对吗」')
    expect(persona).toContain('要不要先问由它回话说了算')
  })
  it('人设里不再教「先复述再确认」', () => {
    expect(persona).not.toMatch(/先复述|我理解的是/)
  })
})

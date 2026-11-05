// @vitest-environment node
/**
 * /state.questions、POST /questions/answer、「这件事里同类的都允许」(2026-09-25,卡 M)。
 * 会话是注入桩,不起 DSH。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createApprovalGrants, createQuestionBroker } from '../src/server/butlerAsks.ts'
import { createApprovalBroker } from '../src/server/composer.ts'
import { createCallOutService } from '../src/server/callOut.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import type { HelperChannel, HelperEvent, HelperRequest } from '../src/server/helperChannel.ts'
import { askNotice } from '../src/server/butlerAsks.ts'
import { BUDGET_ASK_ID } from '../src/server/itemBudget.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeHelper() {
  const requests: HelperRequest[] = []
  let listener: ((event: HelperEvent) => void) | undefined
  const helper = {
    attach() {},
    view: () => ({ connected: true, authorized: true }),
    connected: () => true,
    request: (req: HelperRequest) => { requests.push(req); return Promise.resolve({ ok: true, result: { shown: true } }) },
    onChange() {},
    onEvent(fn: (event: HelperEvent) => void) { listener = fn },
  } as unknown as HelperChannel
  return { helper, requests, emit: (event: HelperEvent) => listener?.(event) }
}

async function serve(helper?: HelperChannel, extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-asks-http-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const approvals = createApprovalBroker()
  const approvalGrants = createApprovalGrants()
  const questions = createQuestionBroker()
  let opened = 0
  // 2026-10-29 入口归一:POST /butler/item 不再有词表快路径,一律进理解中枢 ——
  // 这里的「交代一件事」接假模型按原话回 note(建卡),asks/voice、questions 账那些口不受影响。
  const noteOf = (text: string) => [{ name: 'note', title: text, status: 'todo' }] as Record<string, unknown>[]
  const model = fakeHubModel({
    '这个有点问题,你看安排谁做一下': noteOf('这个有点问题,你看安排谁做一下'),
    '修小头像': noteOf('修小头像'),
    '20 号发大赛回顾视频': noteOf('20 号发大赛回顾视频'),
    '试一下': noteOf('试一下'),
  })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    tasks,
    approvals,
    approvalGrants,
    questions,
    butlerSession: { open: async () => `sess-${++opened}` },
    model: model.service as never,
    fetchImpl: model.fetchImpl,
    ...(helper === undefined ? {} : { helper }),
    ...extra,
  })
  started.push(server)
  return { url: server.url, tasks, approvals, approvalGrants, questions }
}

/**
 * 「他在页面上点的那一下」。
 *
 * 带 `Origin` 是有意的(2026-09-28,卡 BS):「等你确认」那几个口现在只认她本人 ——
 * 页面 / 壳(有浏览器痕迹)、配对设备(设备令牌)、电话工人(进程令牌)。
 * 不带任何身份的那一条是「认不出来的程序」,照口径会被 403 挡掉(下面有一组用例专钉这个)。
 */
async function post(url: string, path: string, body: unknown, headers: Record<string, string> = { origin: 'http://127.0.0.1:3080' }) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

const QUESTION = {
  id: 'confirm_avatar_clip',
  header: '派活前对一遍',
  question: '**哪条不对**说一下,都对就开工。',
  options: [{ label: '都对,开工 (Recommended)', description: '我按上面的默认理解派 Codex 去修。' }, { label: '都对,但你自己做' }, { label: '有不对的,我来说' }],
}

/**
 * 入口归一(2026-10-29)后,中枢 note 建的卡不自己开事务官会话 —— 「那件事的那条会话」由用例显式挂上。
 * asks/voice、questions 账、/butler/item/:id/turns、「刚动过手」这些口都按卡上的 conversation 找那件事。
 */
async function linkSession(tasks: ReturnType<typeof createTasksService>, id: unknown, sessionId = 'sess-1') {
  await tasks.update(String(id), { conversation: { agent: 'dsh', session_id: sessionId } })
}

describe('她问的话在外层', () => {
  it('挂上 → /state.questions 看得见(配上卡、字收拾好)→ 答 → 交回去、两端消失 → 再答 409', async () => {
    const { url, questions, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '这个有点问题,你看安排谁做一下' })
    await linkSession(tasks, created.body.id)
    const asked = questions.ask({ sessionId: 'sess-1', questions: [QUESTION] })
    const before = await state(url)
    expect(before.questions).toHaveLength(1)
    const [view] = before.questions ?? []
    expect(view).toMatchObject({ id: asked.id, task_id: created.body.id, task_title: '这个有点问题,你看安排谁做一下' })
    expect(view?.questions[0]).toMatchObject({ header: '派活前对一遍', question: '哪条不对说一下,都对就开工。', multi: false })
    expect(view?.questions[0]?.options[0]).toEqual({ label: '都对,开工 (Recommended)', text: '都对,开工(推荐)', note: '我按上面的默认理解派 Codex 去修。' })
    // 「等你」那一堆(卡 M 追加):服务端算好放进 /state.waiting,手机只读它;这一问就在里面。
    expect(before.waiting).toEqual({ count: 1, items: [{ key: `question:${asked.id}`, kind: 'question', verb: '答', text: '「这个有点问题,你看安排谁做一下」问你:派活前对一遍', task_id: created.body.id }] })

    const answered = await post(url, '/questions/answer', { id: asked.id, answers: [{ id: 'confirm_avatar_clip', selected: ['都对,开工 (Recommended)'] }] })
    expect(answered).toEqual({ status: 200, body: { ok: true } })
    expect(await asked.answer).toEqual({ kind: 'answer', answers: [{ id: 'confirm_avatar_clip', selected: ['都对,开工 (Recommended)'] }] })
    const after = await state(url)
    expect(after.questions).toEqual([])
    expect(after.waiting).toEqual({ count: 0, items: [] })
    expect((await post(url, '/questions/answer', { id: asked.id, answers: [{ id: 'confirm_avatar_clip', custom: '再来' }] })).status).toBe(409)
  })

  it('「我自己说」:他打的那句原样交回去', async () => {
    const { url, questions } = await serve()
    const asked = questions.ask({ sessionId: 'sess-9', questions: [QUESTION] })
    expect((await post(url, '/questions/answer', { id: asked.id, answers: [{ id: 'confirm_avatar_clip', custom: '你自己能修吗,这其实属于你自己的界面' }] })).status).toBe(200)
    expect(await asked.answer).toEqual({ kind: 'answer', answers: [{ id: 'confirm_avatar_clip', selected: [], custom: '你自己能修吗,这其实属于你自己的界面' }] })
  })

  it('答法不对 400(那一问还挂着);没带 id 400', async () => {
    const { url, questions } = await serve()
    const asked = questions.ask({ sessionId: 'sess-1', questions: [QUESTION] })
    expect((await post(url, '/questions/answer', { id: asked.id, answers: [{ id: 'confirm_avatar_clip', selected: ['编的'] }] })).status).toBe(400)
    expect((await post(url, '/questions/answer', { answers: [] })).status).toBe(400)
    expect((await state(url)).questions).toHaveLength(1)
  })
})

describe('这件事里同类的都允许', () => {
  const kind = { key: 'repo:/r/desktop-workbench', title: '改「desktop-workbench」这个仓库' }

  it('点一次:这一条放行、同一件事里同类的还挂着的也放行、记下来;别的事、别的类不动', async () => {
    const { url, approvals, approvalGrants } = await serve()
    const first = approvals.ask({ sessionId: 's-1', tool: 'bash', detail: { say: '要在「desktop-workbench」这个仓库里跑一条命令', kind } })
    const second = approvals.ask({ sessionId: 's-1', tool: 'bash', detail: { say: '同上', kind } })
    const otherKind = approvals.ask({ sessionId: 's-1', tool: 'bash', detail: { say: '开浏览器', kind: { key: 'browser', title: '开看不见的浏览器截图' } } })
    const otherItem = approvals.ask({ sessionId: 's-2', tool: 'bash', detail: { say: '别的事', kind } })

    const res = await post(url, '/approvals/answer', { id: first.id, allow: true, scope: 'kind' })
    expect(res).toEqual({ status: 200, body: { ok: true, granted: '改「desktop-workbench」这个仓库', merged: 1 } })
    expect(await first.answer).toBe('allowed-once')
    expect(await second.answer).toBe('allowed-once')
    expect(approvals.list().map(one => one.id).sort()).toEqual([otherKind.id, otherItem.id].sort())
    expect(approvalGrants.granted({ sessionId: 's-1' }, kind.key)).toBe(true)
    expect(approvalGrants.granted({ sessionId: 's-2' }, kind.key)).toBe(false)
    const view = await state(url)
    expect(view.approval_grants).toEqual([expect.objectContaining({ session_id: 's-1', key: kind.key, title: kind.title, allowed: 1 })])
    expect(view.approvals?.[0]).toMatchObject({ say: expect.any(String), kind: expect.objectContaining({ key: expect.any(String) }) })

    expect((await post(url, '/approvals/grant/revoke', { session_id: 's-1', key: kind.key })).status).toBe(200)
    expect(approvalGrants.granted({ sessionId: 's-1' }, kind.key)).toBe(false)
    expect((await post(url, '/approvals/grant/revoke', { session_id: 's-1', key: kind.key })).status).toBe(409)
  })

  it('★挂在事项上的那条会话(卡 M 追加):记在那件事上;那件事取消了,/state 里那一条就作废', async () => {
    const { url, approvals, approvalGrants, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '修小头像' })
    await linkSession(tasks, created.body.id)
    const asked = approvals.ask({ sessionId: 'sess-1', tool: 'bash', detail: { say: '要在「desktop-workbench」这个仓库里跑一条命令', kind } })
    expect((await post(url, '/approvals/answer', { id: asked.id, allow: true, scope: 'kind' })).status).toBe(200)
    expect(approvalGrants.list()).toEqual([expect.objectContaining({ session_id: 'sess-1', task_id: created.body.id, key: kind.key })])
    // 这件事换了一条会话接着办:照样认
    expect(approvalGrants.granted({ sessionId: 'sess-new', taskId: created.body.id as string }, kind.key)).toBe(true)
    expect((await state(url)).approval_grants).toEqual([expect.objectContaining({ task_id: created.body.id })])
    expect((await post(url, '/task/move', { id: created.body.id, status: 'canceled' })).status).toBe(200)
    expect((await state(url)).approval_grants).toEqual([])
    expect(approvalGrants.list()).toEqual([])
  })

  it('分不出类的那一条不收「同类的都允许」(400),照旧一条条批', async () => {
    const { url, approvals } = await serve()
    const asked = approvals.ask({ sessionId: 's-1', tool: 'bash', reason: 'escalate sandbox to danger-full-access: rm -rf dist' })
    expect((await post(url, '/approvals/answer', { id: asked.id, allow: true, scope: 'kind' })).status).toBe(400)
    expect((await post(url, '/approvals/answer', { id: asked.id, allow: true })).status).toBe(200)
    expect(await asked.answer).toBe('allowed-once')
  })
})

describe('壳不在前台时弹系统通知(卡 M)', () => {
  it('新的一问 / 一条要批的各弹一次(同一张不重弹);答掉之后再来新的照样弹', async () => {
    const { helper, requests } = fakeHelper()
    const { questions, approvals } = await serve(helper)
    const first = questions.ask({ sessionId: 'sess-1', questions: [QUESTION] })
    await vi.waitFor(() => expect(requests.filter(r => r.op === 'notify')).toHaveLength(1))
    expect(requests.find(r => r.op === 'notify')).toMatchObject({ op: 'notify', key: `question:${first.id}`, title: '事务官有话问你' })
    approvals.ask({ sessionId: 'sess-1', tool: 'bash', detail: { say: '要跑一条命令' } })
    await vi.waitFor(() => expect(requests.filter(r => r.op === 'notify')).toHaveLength(2))
    expect(requests.filter(r => r.op === 'notify')[1]).toMatchObject({ title: '事务官要你批一件事', body: '要跑一条命令' })
    // 同一张不重弹:再挂一条无关的变化,notify 还是两条 + 新的那一条。
    questions.ask({ sessionId: 'sess-2', questions: [{ ...QUESTION, id: 'other' }] })
    await vi.waitFor(() => expect(requests.filter(r => r.op === 'notify' && r.clear !== true)).toHaveLength(3))
    // 答掉了:通知中心里那一条收掉。
    questions.answer(first.id, [{ id: 'confirm_avatar_clip', custom: '好' }])
    await vi.waitFor(() => expect(requests.find(r => r.op === 'notify' && r.clear === true)).toMatchObject({ key: `question:${first.id}` }))
  })

  it('通知上写什么:哪种、哪件事、要什么;不念底层原话', () => {
    expect(askNotice({ kind: 'approval', view: { task_title: '修小头像', tool: 'bash', reason: 'escalate sandbox to danger-full-access: x' } })).toEqual({ title: '事务官要你批一件事', body: '「修小头像」要跑一条命令' })
  })
})

describe('电话里答(POST /asks/voice,卡 M)', () => {
  it('那件事有一问在等:说中选项就选它,交上去、那一问消失', async () => {
    const { url, questions, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '修小头像' })
    await linkSession(tasks, created.body.id)
    const asked = questions.ask({ sessionId: 'sess-1', questions: [QUESTION] })
    const res = await post(url, '/asks/voice', { item_id: created.body.id, said: '都对,但你自己做吧' })
    expect(res).toEqual({ status: 200, body: { ok: true, kind: 'question', picked: '都对,但你自己做' } })
    expect(await asked.answer).toEqual({ kind: 'answer', answers: [{ id: 'confirm_avatar_clip', selected: ['都对,但你自己做'] }] })
  })

  it('要批的:听出批 / 不批才交;听不出 400;那件事没在等 404', async () => {
    const { url, approvals, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '修小头像' })
    await linkSession(tasks, created.body.id)
    const asked = approvals.ask({ sessionId: 'sess-1', tool: 'bash', detail: { say: '要跑一条命令' } })
    expect((await post(url, '/asks/voice', { item_id: created.body.id, said: '嗯我想想' })).status).toBe(400)
    expect((await post(url, '/asks/voice', { item_id: created.body.id, said: '行,批吧' })).body).toEqual({ ok: true, kind: 'approval', allow: true })
    expect(await asked.answer).toBe('allowed-once')
    expect((await post(url, '/asks/voice', { item_id: created.body.id, said: '行' })).status).toBe(404)
  })

  /*
   * ★ 2026-10-13 下午,卡 C(验收交接第三节第 19 条)。
   *
   * 14:3x 那一通:卡 t-86856ebb 撞上限,挂着一问「继续、停掉、还是换 Claude」;他说「看见了,嗯」
   * → `/asks/voice` 把这句话当「我自己说」交上去 → 200 ok → 她说「好了,替你选上了」,
   * 而那张卡仍然 blocked / paused(`budgetChoiceOf` 认不出这句话,一个动作都没发生)。
   *
   * 这种**只能选一项**的问(今天只有「到上限了」那一问,见 `CHOICE_ONLY_ASK_IDS`):
   * 听不出是哪一个就 400,**绝不回 ok**。
   */
  it('★只能选一项的那一问(到上限了):听不出是哪一个 → 400、那一问还挂着;说中了才交上去', async () => {
    const { url, questions, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '20 号发大赛回顾视频' })
    await linkSession(tasks, created.body.id)
    const asked = questions.ask({
      sessionId: 'sess-1',
      questions: [{ id: BUDGET_ASK_ID, header: '到上限了', question: '这件到上限了,继续、停掉,还是换一家?', options: [{ label: '继续' }, { label: '停掉这一件' }, { label: '换 Claude 来做' }] }],
    })
    const vague = await post(url, '/asks/voice', { item_id: created.body.id, said: '看见了,嗯' })
    expect(vague.status).toBe(400)
    expect((await state(url)).questions).toHaveLength(1)
    const picked = await post(url, '/asks/voice', { item_id: created.body.id, said: '停掉' })
    expect(picked).toEqual({ status: 200, body: { ok: true, kind: 'question', picked: '停掉这一件' } })
    expect(await asked.answer).toEqual({ kind: 'answer', answers: [{ id: BUDGET_ASK_ID, selected: ['停掉这一件'] }] })
  })

  it('别的问照旧收「我自己说」(这一收紧只对只能选一项的那一种)', async () => {
    const { url, questions, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '修小头像' })
    await linkSession(tasks, created.body.id)
    const asked = questions.ask({ sessionId: 'sess-1', questions: [QUESTION] })
    expect((await post(url, '/asks/voice', { item_id: created.body.id, said: '你自己能修吗' })).status).toBe(200)
    expect(await asked.answer).toEqual({ kind: 'answer', answers: [{ id: 'confirm_avatar_clip', selected: [], custom: '你自己能修吗' }] })
  })

  /*
   * ★ 挂着的那一问**带着它的选项**下发给 `understand()`(卡 C):判「她这一句是在答那一问」
   * 要对着选项比,否则随口一句都会被当成答案。
   */
  it('★/butler/understand:挂着一问时,说中选项才算答那一问;应答不算', async () => {
    const { url, questions, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '20 号发大赛回顾视频' })
    await linkSession(tasks, created.body.id)
    questions.ask({
      sessionId: 'sess-1',
      questions: [{ id: BUDGET_ASK_ID, header: '到上限了', question: '这件到上限了,继续、停掉,还是换一家?', options: [{ label: '继续' }, { label: '停掉这一件' }] }],
    })
    const understood = async (said: string) => {
      const res = await post(url, '/butler/understand', { text: said, source: 'call' })
      return res.body.understanding as { kind: string, route?: { path: string } }
    }
    expect((await understood('看见了,嗯')).kind).toBe('none')
    const real = await understood('继续')
    expect(real.kind).toBe('answer_ask')
    expect(real.route?.path).toBe('/asks/voice')
  })

  it('还有下一问(卡 M 追加:接连几问只响一次,电话里一问一问答下去):回话里带上下一问,答完最后一问就不带', async () => {
    const { url, questions, approvals, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '修小头像' })
    await linkSession(tasks, created.body.id)
    questions.ask({ sessionId: 'sess-1', questions: [QUESTION] })
    approvals.ask({ sessionId: 'sess-1', tool: 'bash', detail: { say: '要开一个看不见的浏览器,把页面截下来看' } })
    const first = await post(url, '/asks/voice', { item_id: created.body.id, said: '都对,开工' })
    expect(first.body).toMatchObject({ ok: true, kind: 'question', next: { item_id: created.body.id, title: '「修小头像」要你批:要开一个看不见的浏览器,把页面截下来看' } })
    const second = await post(url, '/asks/voice', { item_id: created.body.id, said: '可以' })
    expect(second.body).toEqual({ ok: true, kind: 'approval', allow: true })
  })
})

describe('给他看的字只有一个出口(卡 M 补:「**B**」不许原样露出)', () => {
  it('事项对话里她说的那几句洗掉记号,他自己说的原样;/state 里事项的「回答」也洗过', async () => {
    const turns = [
      { role: 'user', text: '选 **A** 还是 B?', at: 'x' },
      { role: 'assistant', text: '收到,选 **B**。', at: 'y' },
    ]
    const { url, tasks } = await serve(undefined, { sessionTurns: () => turns as never })
    const created = await post(url, '/butler/item', { text: '试一下' })
    await linkSession(tasks, created.body.id)
    const res = await fetch(`${url}/butler/item/${created.body.id as string}/turns`)
    const body = await res.json() as { turns: { role: string, text: string }[] }
    expect(body.turns.map(turn => turn.text)).toEqual(['选 **A** 还是 B?', '收到,选 B。'])
    await tasks.update(created.body.id as string, { deliverables: [{ kind: 'reply', ref: '收到,选 **B**。' }] })
    const view = await state(url)
    expect(view.tasks?.tasks.find(task => task.id === created.body.id)?.deliverables).toEqual([{ kind: 'reply', ref: '收到,选 B。' }])
  })
})

describe('他刚动过手,几分钟里不为这件事打电话(卡 M 补:点完选项手机马上又响)', () => {
  it('★交代一件事、答一问、批一条、点确认:都记一笔「刚动过手」(按事项)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-touch-'))
    dirs.push(dir)
    const callOut = createCallOutService({ file: join(dir, 'call-out.json') })
    await callOut.load()
    const touched: string[] = []
    const original = callOut.touch!
    callOut.touch = (id, at) => { touched.push(id); original(id, at) }
    const { url, questions, approvals, tasks } = await serve(undefined, { callOut })
    const created = await post(url, '/butler/item', { text: '修小头像' })
    const itemId = created.body.id as string
    await linkSession(tasks, itemId)
    expect(touched).toEqual([itemId])
    const asked = questions.ask({ sessionId: 'sess-1', questions: [QUESTION] })
    await post(url, '/questions/answer', { id: asked.id, answers: [{ id: 'confirm_avatar_clip', selected: ['都对,开工 (Recommended)'] }] })
    const approval = approvals.ask({ sessionId: 'sess-1', tool: 'bash', detail: { say: '要跑一条命令' } })
    await post(url, '/approvals/answer', { id: approval.id, allow: true })
    await post(url, '/task/move', { id: itemId, status: 'canceled' })
    expect(touched).toEqual([itemId, itemId, itemId, itemId])
  })
})

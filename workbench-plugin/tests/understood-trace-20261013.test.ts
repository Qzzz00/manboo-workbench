// @vitest-environment node
/**
 * **固定流程办掉的那几件,在事务官那里留一行**(2026-10-13,卡「固定流程办的事留痕」)。
 *
 * 维护者 10-13 原话:「场景二我也没看到事务官那里有什么记录啊」—— 她在手机 / 电脑 / 电话里说
 * 「把待办改成按日期汇总」,屏幕上那一格真换了,可事务官面板 / 收件箱 / 记录里一行字都没有。
 *
 * 钉四件:
 *   ① 那一行怎么拼(`understoodTrace`:「你说(来源):原话」+「办了什么」),办不成就缺席;
 *   ② 留在**现成那本回答账**(`/state.answers`)—— 协议没改、两端都已经在读它、**不建事项卡**;
 *   ③ 2026-10-29 删规矩第一批:交代框那条路(/butler/item)已进理解中枢,不再走 switchTodayView —— 留痕只剩电话那条路在这钉;
 *   ④ 她自己在设置里点那两颗键 **不留痕**;同一句重复说 **不重复记**。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnswersView, WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { demoTodayViewSay } from '../src/server/demoPlaybook.ts'
import { UNDERSTOOD_TRACE_ASK, UNDERSTOOD_TRACE_SAID_MAX, UNDERSTOOD_TRACE_WHERE, understoodTrace } from '../src/server/understoodTrace.ts'
import { understand } from '../src/server/understand.ts'

const SAID = '把待办改成按日期汇总'

describe('① 那一行怎么拼', () => {
  it('「你说(来源):原话」+「办了什么」;来源三个字与行为账同一组词', () => {
    expect(understoodTrace({ kind: 'today_view', said: SAID, done: '改成按日期汇总了。', where: 'call' })).toEqual({
      id: `understood:today_view:${SAID}`,
      question: `${UNDERSTOOD_TRACE_ASK}(${UNDERSTOOD_TRACE_WHERE.call as string}):${SAID}`,
      answer: '改成按日期汇总了。',
    })
    expect(understoodTrace({ kind: 'today_view', said: SAID, done: '改好了', where: 'phone' })?.question)
      .toContain(UNDERSTOOD_TRACE_WHERE.phone as string)
    expect(understoodTrace({ kind: 'today_view', said: SAID, done: '改好了', where: 'desk' })?.question)
      .toContain(UNDERSTOOD_TRACE_WHERE.desk as string)
    // 来源认不出(别的几档不是她说话的入口)→ 不写来源,也不编一个。
    expect(understoodTrace({ kind: 'today_view', said: SAID, done: '改好了', where: 'settings' })?.question)
      .toBe(`${UNDERSTOOD_TRACE_ASK}:${SAID}`)
  })

  it('没办成 / 取不到原话 / 不是要留痕的那几件 → 一律缺席,不编一行「办了」', () => {
    expect(understoodTrace({ kind: 'today_view', said: SAID, done: '  ', where: 'call' })).toBeUndefined()
    expect(understoodTrace({ kind: 'today_view', said: ' ', done: '改好了', where: 'call' })).toBeUndefined()
    // 答挂着那一问、登记一场会、派活…各有各的落处,不在这本账里重复一遍。
    expect(understoodTrace({ kind: 'answer_ask', said: '绿茶', done: '替你选上了。', where: 'call' })).toBeUndefined()
    expect(understoodTrace({ kind: 'none', said: SAID, done: '办好了', where: 'call' })).toBeUndefined()
  })

  it('同一句话标点不同算同一句(id 一样);太长的原话截尾显示', () => {
    const a = understoodTrace({ kind: 'today_view', said: SAID, done: '改好了', where: 'call' })
    const b = understoodTrace({ kind: 'today_view', said: `${SAID}。`, done: '改好了', where: 'phone' })
    expect(b?.id).toBe(a?.id)
    const long = '一'.repeat(UNDERSTOOD_TRACE_SAID_MAX + 5)
    expect(understoodTrace({ kind: 'today_view', said: long, done: '改好了', where: 'call' })?.question)
      .toBe(`${UNDERSTOOD_TRACE_ASK}(电话):${'一'.repeat(UNDERSTOOD_TRACE_SAID_MAX)}…`)
  })

  it('留痕的那几件就是「办掉了却不建卡」的那几件', () => {
    for (const kind of ['today_view', 'publish_plan', 'video', 'append']) {
      expect(understoodTrace({ kind, said: SAID, done: '办好了', where: 'call' })).not.toBeUndefined()
    }
  })
})

describe('② understand() 把原话带上那条路(工人一个字都不用改)', () => {
  it('切待办版本那条路带 said;补细节那条路带 append', () => {
    const view = understand(SAID, { nowMs: Date.parse('2026-10-13T02:00:00Z'), source: 'call' })
    expect(view.route).toEqual({ path: '/today/view', body: { view: 'by_date', said: SAID } })
    const append = understand('七八岁吧,穿小碎花连衣裙。', {
      nowMs: 1_000_000,
      source: 'call',
      open: { item_id: 't-1', said: '做一个视频', at_ms: 1_000_000 - 5_000 },
    })
    expect(append.route).toEqual({ path: '/butler/item/say', body: { id: 't-1', text: '七八岁吧,穿小碎花连衣裙。', append: true } })
  })
})

const NOW_SEC = Math.floor(Date.parse('2026-10-13T02:00:00.000Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 她在电脑上点的(壳里的页面)。 */
const SHELL = { 'user-agent': 'BenWorkbenchShell/1.0' }
/** 电话工人(回环 + 进程令牌)。 */
const WORKER = { 'x-workbench-actor': 'worker-token' }

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-understood-trace-'))
  dirs.push(dir)
  let saved: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(saved),
    writeLayout: (next) => { saved = next; return Promise.resolve() },
  })
  await template.load()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    template,
    tasks,
    projects: {
      getProjectsState: () => Promise.resolve({ projects: [], pending: [], scan_errors: [], scanned_at: new Date(NOW_SEC * 1000).toISOString() }),
      confirmStatus: () => Promise.resolve(false),
      setDdl: () => Promise.resolve(false),
      addRule: () => Promise.resolve(),
      getLayout: () => Promise.resolve(saved),
      setLayout: (next: WorkbenchLayout) => { saved = next; return Promise.resolve() },
      invalidateScanCache: () => {},
    },
    actorTokens: { butler: 'butler-token', worker: 'worker-token' },
    paths: { home: dir },
  } as never)
  started.push(server)
  const post = async (path: string, body: unknown, headers: Record<string, string> = SHELL) => {
    const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const state = async () => await (await fetch(`${server.url}/state`)).json() as WorkbenchState
  const answers = async (): Promise<AnswersView> => (await state()).answers ?? { items: [], unseen: 0 }
  return { url: server.url, post, state, answers, layout: () => saved }
}

describe('③ 三个入口留的是同一行', () => {
  it('电话那条路(/today/view 带 said):账上多一行「你说(电话):… → 改成按日期汇总了。」,**一张卡都不多**', async () => {
    const t = await serve()
    const res = await t.post('/today/view', { view: 'by_date', said: SAID }, WORKER)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, changed: true })
    const view = await t.answers()
    expect(view.items).toHaveLength(1)
    expect(view.items[0]).toMatchObject({
      question: `${UNDERSTOOD_TRACE_ASK}(${UNDERSTOOD_TRACE_WHERE.call as string}):${SAID}`,
      answer: demoTodayViewSay('by_date'),
      where: 'call',
    })
    // 指不回去的就不给点:切版面不是一件事,没有卡。
    expect(view.items[0]!.task_id).toBeUndefined()
    expect((await t.state()).tasks?.tasks ?? []).toHaveLength(0)
    expect(view.unseen).toBe(1)
  })

})

describe('④ 什么时候不留痕', () => {
  it('设置里那两颗键(不带 said)一行都不留', async () => {
    const t = await serve()
    expect((await t.post('/today/view', { view: 'by_date' })).status).toBe(200)
    expect(t.layout()?.today_view).toBe('by_date')
    expect((await t.answers()).items).toHaveLength(0)
  })

  it('本来就是这一版(什么都没换)不留痕', async () => {
    const t = await serve()
    expect((await t.post('/today/view', { view: 'flat', said: '待办改回不汇总' })).body).toMatchObject({ changed: false })
    expect((await t.answers()).items).toHaveLength(0)
  })

  it('同一句重复说不重复记;换了一句(改回去)就是新的一行', async () => {
    const t = await serve()
    await t.post('/today/view', { view: 'by_date', said: SAID }, WORKER)
    const first = (await t.answers()).items[0]!
    // 先切回去再说同一句(不然第二次是「本来就是这一版」)。
    await t.post('/today/view', { view: 'flat' })
    await t.post('/today/view', { view: 'by_date', said: `${SAID}。` }, WORKER)
    const after = await t.answers()
    expect(after.items.filter(one => one.id === first.id)).toHaveLength(1)
    expect(after.items.find(one => one.id === first.id)?.at).toBe(first.at)

    await t.post('/today/view', { view: 'flat', said: '待办改回不汇总' }, WORKER)
    const both = await t.answers()
    expect(both.items).toHaveLength(2)
    expect(both.items[0]).toMatchObject({ answer: demoTodayViewSay('flat') })
  })
})

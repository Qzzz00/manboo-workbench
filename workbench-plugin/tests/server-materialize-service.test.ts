// @vitest-environment node
/**
 * 引导落地的 I/O 那一半:预览 → 落地 → 重跑不重复建 → 第一件走现有派活链路(卡 feat/onboarding-materialize)。
 *
 * 看板是真的 tasks 服务(临时文件,里面是维护者 09-24 晚那份 tasks.json 的副本);项目区、例程、免打扰、资讯是桩;
 * 事务官会话是桩(记下第一条消息)。不碰 ~/.dsh,不连模型。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MaterializeArchive } from '../src/server/materialize.ts'
import type { MaterializeServiceOptions } from '../src/server/materializeService.ts'
import { createMaterializeService, dispatchExistingItem, modelInputHash, resultLine } from '../src/server/materializeService.ts'
import { extractWithModel, parseJsonReply } from '../src/server/materializeModel.ts'
import { createTasksService } from '../src/server/tasks.ts'

const archive = JSON.parse(readFileSync(new URL('./fixtures/materialize/onboarding-0924.json', import.meta.url), 'utf8')) as MaterializeArchive
const tasksFixture = readFileSync(new URL('./fixtures/materialize/tasks-0924.json', import.meta.url), 'utf8')
const NOW = new Date('2026-09-24T12:30:00.000Z')
const WB = '/Users/example/Documents/GitHub/desktop-workbench'
const ECHO = '/Users/example/Documents/GitHub/Echo'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function harness(over: Partial<MaterializeServiceOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-materialize-'))
  dirs.push(root)
  writeFileSync(join(root, 'tasks.json'), tasksFixture)
  let n = 0
  const tasks = createTasksService({ file: join(root, 'tasks.json'), now: () => Math.floor(NOW.getTime() / 1000), newId: () => `m-${++n}` })
  const stored: { id: string, name: string, repoPath?: string, ddl?: { date: string, title: string }, status?: string }[] = [{ id: 'desktop-workbench', name: 'desktop-workbench', repoPath: WB }]
  const repos = [{ id: 'desktop-workbench', name: 'desktop-workbench', path: WB }, { id: 'echo', name: 'Echo', path: ECHO }]
  let routines = { morning: {} as { at?: string }, evening: { at: '18:30' } as { at?: string } }
  let quiet = { quiet_from: '23:00', quiet_to: '08:00' }
  let feed = { podcast: true, interests: [
    { project_id: 'desktop-workbench', project_name: 'desktop-workbench', keywords: [] as string[] },
    { project_id: 'echo', project_name: 'Echo', keywords: [] as string[] },
    { project_id: 'aiboo', project_name: 'Aiboo', keywords: [] as string[] },
  ] }
  const opened: string[] = []
  const imported: number[] = []
  const applied: unknown[] = []
  let changed = 0
  const service = createMaterializeService({
    file: join(root, 'materialize.json'),
    now: () => NOW,
    readArchive: async () => archive,
    tasks,
    projects: {
      stored: async () => stored.map(one => ({ ...one })),
      repos: async () => repos,
      adopt: async ({ name, path }) => {
        const have = stored.find(one => one.repoPath === path)
        if (have !== undefined) { have.name = name; return { id: have.id } }
        const id = repos.find(one => one.path === path)?.id ?? name.toLowerCase()
        stored.push({ id, name, repoPath: path })
        return { id }
      },
      setDdl: async (id, ddl) => { const have = stored.find(one => one.id === id); if (have === undefined) return false; if (ddl === null) delete have.ddl; else have.ddl = ddl; return true },
      confirmStatus: async (id, text) => { const have = stored.find(one => one.id === id); if (have === undefined) return false; have.status = text; return true },
    },
    routines: { config: () => routines, setConfig: async (patch) => { const p = patch as typeof routines; routines = { morning: { ...routines.morning, ...(p.morning ?? {}) }, evening: { ...routines.evening, ...(p.evening ?? {}) } }; return routines } },
    quiet: { config: () => quiet, setConfig: async (patch) => { quiet = { ...quiet, ...(patch as typeof quiet) }; return quiet } },
    feed: { config: () => feed, setConfig: async (patch) => { feed = { ...feed, ...(patch as typeof feed) }; return feed } },
    apps: { enabled: async () => ['claude', 'codex', 'kimi', 'wechat', 'wecom'] },
    memories: { importNow: async () => { imported.push(1); return { ok: true, note: '拷了 Claude 12 份、Codex 1 份;Kimi 没找到' } } },
    readClientFiles: async () => '可以',
    version: async () => '0.2.83',
    codexThread: async query => (query.includes('参赛网页') ? { id: '01a0ccd1-5e62-7eb2-a0af-224d9d844cfd', title: '制作参赛网页' } : undefined),
    dispatch: input => dispatchExistingItem({ tasks, opener: { open: async (message) => { opened.push(message); return 'sess-first' } } }, input),
    onApplied: async (input) => { applied.push(input) },
    onChanged: () => { changed += 1 },
    ...over,
  })
  return { service, tasks, stored, opened, imported, applied, root, get routines() { return routines }, get quiet() { return quiet }, get feed() { return feed }, get changed() { return changed } }
}

describe('预览', () => {
  it('维护者那份存档:两个项目、十件事、撤掉七条,电话里那一句;/state 里有一份不带数据的', async () => {
    const h = harness()
    await h.service.load()
    const got = await h.service.preview()
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.plan.counts).toEqual({ projects: 2, tasks: 10, cancel: 7 })
    expect(got.plan.line).toBe('都摆好了,两个项目、十件事,屏幕上有张单子;第一件交给 Codex 接着做参赛网页,行吗?')
    const view = h.service.view()
    expect(view).toMatchObject({ id: got.plan.id, status: 'pending', source: 'rules' })
    expect(view?.rows.every(row => !('data' in row))).toBe(true)
    expect(h.service.brief()).toEqual({ pending: true, id: got.plan.id, line: got.plan.line })
    // 预览不写看板。
    expect((await h.tasks.list()).tasks).toHaveLength(7)
  })

  it('同样的存档、同样的现状再预览一次:回同一张单子(reused)', async () => {
    const h = harness()
    const first = await h.service.preview()
    const again = await h.service.preview()
    expect(first.ok && again.ok && again.reused && again.plan.id === first.plan.id).toBe(true)
  })

  it('还没引导过:404,不编一张单子', async () => {
    const h = harness({ readArchive: async () => undefined })
    expect(await h.service.preview()).toMatchObject({ ok: false, status: 404 })
  })
})

describe('落地', () => {
  it('照单子落:项目、冲刺与两栏、十张卡、例程、免打扰、资讯、补拷记忆、撤掉七条、第一件派给事务官(点名 Codex)', async () => {
    const h = harness()
    const got = await h.service.preview()
    if (!got.ok) throw new Error(got.error)
    const done = await h.service.apply({ id: got.plan.id })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.result.line).toBe('派出去了,做完叫你。')
    expect(done.result.rows.filter(row => !row.ok)).toEqual([])

    // 项目:工作台改了显示名、截止日;Lapis 认领了 Echo 那个仓库、负责人 Kimi。
    // 项目区那一行状态:还没写过,照他的话写一句(倒计时由 DDL 那一行现算,不写死)。
    expect(h.stored).toEqual([
      { id: 'desktop-workbench', name: '工作台', repoPath: WB, ddl: { date: '2026-10-04', title: 'Spotlight 报名截止' }, status: '冲刺 Spotlight,10/4 截止;参赛网页架构基本快弄完(Codex 在跑)' },
      { id: 'echo', name: 'Lapis', repoPath: ECHO },
    ])
    const board = await h.tasks.list()
    expect(board.project_meta).toEqual([{ project_id: 'echo', assignee: 'kimi' }])
    expect(board.sprints.map(one => [one.project_id, one.name, one.ends_at])).toEqual([['desktop-workbench', 'Spotlight 参赛 · 10-04', '2026-10-04']])
    expect(board.modules.map(one => one.name)).toEqual(['参赛材料', '核心能力与打磨'])

    // 卡:照他的话,挂在工作台、挂在对应的栏;「定核心体验流程」进等你确认;第一件在办、挂着事务官那条会话。
    // 负责人是真的(2026-09-25,卡 N):你 / 同事 / 别人落进负责人那一格(以前只写在描述里、这一格缺席)。
    const made = board.tasks.filter(task => task.source.ref === '引导落地')
    expect(made.map(task => [task.title, task.status, task.assignee ?? '-'])).toEqual([
      ['参赛网页架构收尾', 'doing', 'codex'],
      ['参赛视频', 'todo', 'other'],
      ['参赛文案', 'todo', 'colleague'],
      ['9/28 把材料整理好放同事桌上', 'todo', 'me'],
      ['手机远程派单 + 汇报 / 进度评估准确', 'todo', 'claude'],
      ['定核心体验流程(四段)', 'confirm', 'me'],
      ['验证自我迭代能力', 'todo', 'claude'],
      ['打磨自媒体布局', 'todo', 'claude'],
      ['服务器与手机版本同步', 'todo', 'claude'],
      ['额度显示 / 会话读取', 'todo', 'claude'],
    ])
    expect(made.every(task => task.project_id === 'desktop-workbench' && task.module_id !== undefined)).toBe(true)
    expect(made.find(task => task.title === '9/28 把材料整理好放同事桌上')?.due).toBe('2026-09-28')
    expect(made.find(task => task.title === '参赛文案')?.desc).toContain('负责:同事(9/29 回来写)')
    expect(made.find(task => task.title === '参赛文案')?.assignee_note).toBe('9/29 回来写')
    expect(made.find(task => task.title === '手机远程派单 + 汇报 / 进度评估准确')?.priority).toBe('high')
    const web = made.find(task => task.title === '参赛网页架构收尾')
    expect(web?.conversation).toEqual({ agent: 'dsh', session_id: 'sess-first' })
    // 只有第一件是「他交给事务官的」(手机对话里那一句是他点头的原话);其余是看板上的卡,不冒充他说过的话、不配「会话未开」。
    expect(made.filter(task => task.direction === 'mine').map(task => task.title)).toEqual(['参赛网页架构收尾'])
    // 卡 A 的 TaskOrigin:引导落地建的卡一律标 onboarding(不当成他亲口说的话去数)。
    expect(made.every(task => task.origin === 'onboarding')).toBe(true)
    expect(web?.desc).toBe('第一条:让 Codex 把参赛网页的架构剩下的补完(Spotlight 报名 10-04 截止)')

    // 第一件:现有链路,给事务官的第一条消息里点名 Codex、写清接着那条会话。
    expect(h.opened).toHaveLength(1)
    expect(h.opened[0]).toContain('接着「制作参赛网页」那条会话的工作')
    expect(h.opened[0]).toContain(`(工作台事项 ${web?.id as string})`)
    expect(h.opened[0]).toContain('他点名要 Codex 做这件事')

    // 撤掉的七条:改成取消,一条没删;已经「完成」的那三条也是取消。
    const canceled = board.tasks.filter(task => task.status === 'canceled').map(task => task.id).sort()
    expect(canceled).toEqual(['t-26ad64dc', 't-886ba5d8', 't-991441d1', 't-af2d79df', 't-b5302d3f', 't-d19da779', 't-fe044617'])
    expect(board.tasks).toHaveLength(7 + 10)

    // 每天、资讯、记忆。
    expect(h.routines).toEqual({ morning: { enabled: true, at: '08:30' }, evening: { enabled: true, at: '20:30' } })
    expect(h.quiet).toEqual({ quiet_from: '21:00', quiet_to: '08:30' })
    expect(h.feed.interests).toEqual([
      { project_id: 'desktop-workbench', project_name: '工作台', keywords: ['Spotlight 比赛', 'AI 事务官', 'Agent 调度', '远程派单', '会议录音转待办'] },
      { project_id: 'echo', project_name: 'Lapis', keywords: ['Spotlight 比赛'] },
      { project_id: 'aiboo', project_name: 'Aiboo', keywords: [] },
    ])
    expect(h.imported).toHaveLength(1)
    expect(h.applied).toEqual([{ background: { project: 'desktop-workbench', text: '9/29 起远程(只带 Pad);中秋 9/25-9/27,国庆 10/1 起' }, rows: expect.any(Array) }])

    // /state:落过了。
    expect(h.service.view()).toMatchObject({ status: 'applied', result: { ok: true, line: '派出去了,做完叫你。' } })
    expect(h.service.brief()).toMatchObject({ pending: false, applied: true })
  })

  it('同一份存档重跑:再预览只剩「已经有了」,再落什么都不多', async () => {
    const h = harness()
    const first = await h.service.preview()
    if (!first.ok) throw new Error(first.error)
    await h.service.apply({ id: first.plan.id })
    const count = (await h.tasks.list()).tasks.length
    const again = await h.service.preview()
    if (!again.ok) throw new Error(again.error)
    expect(again.plan.id).not.toBe(first.plan.id)
    const live = again.plan.rows.filter(row => row.checked && row.done !== true && row.placeholder === undefined).map(row => row.key)
    // 补拷记忆那一行:存档里还没有「拷过了」的记号(引导 recordMaterialized 才记),所以还勾着 —— 再拷一次也只是覆盖同样的文件。
    expect(live).toEqual(['memories'])
    const done = await h.service.apply({ id: again.plan.id, uncheck: ['memories'] })
    expect(done.ok).toBe(true)
    expect((await h.tasks.list()).tasks).toHaveLength(count)
    expect(h.opened).toHaveLength(1)
  })

  it('免打扰到几点在「改一下」里改了:照他改的落;写得不像时刻的不认', async () => {
    const h = harness()
    const got = await h.service.preview()
    if (!got.ok) throw new Error(got.error)
    const quiet = got.plan.rows.find(row => row.kind === 'quiet')
    expect(quiet?.time).toEqual({ from: '21:00', to: '08:30' })
    const done = await h.service.apply({ id: got.plan.id, edits: { [quiet?.key as string]: { to: '08:00' } } })
    expect(done.ok && done.result.rows.find(row => row.key === quiet?.key)?.title).toBe('晚上 9 点到早上 8 点不打扰')
    expect(h.quiet).toEqual({ quiet_from: '21:00', quiet_to: '08:00' })
    const again = harness()
    const plan2 = await again.service.preview()
    if (!plan2.ok) throw new Error(plan2.error)
    await again.service.apply({ id: plan2.plan.id, edits: { quiet: { to: '8点' } } })
    expect(again.quiet).toEqual({ quiet_from: '21:00', quiet_to: '08:30' })
  })

  it('项目区那一行状态他写过了:单子上不提、落的时候不盖', async () => {
    const h = harness()
    h.stored[0]!.status = '他自己写的一句'
    const got = await h.service.preview()
    if (!got.ok) throw new Error(got.error)
    const row = got.plan.rows.find(one => one.kind === 'project' && one.title.startsWith('工作台'))
    expect(row?.detail).not.toContain('状态写')
    await h.service.apply({ id: got.plan.id })
    expect(h.stored[0]?.status).toBe('他自己写的一句')
  })

  it('他勾掉的不做、改过的照改;勾掉第一件那张卡就不派', async () => {
    const h = harness()
    const got = await h.service.preview()
    if (!got.ok) throw new Error(got.error)
    const key = (title: string): string => got.plan.rows.find(row => row.title === title)?.key as string
    const done = await h.service.apply({
      id: got.plan.id,
      uncheck: [key('参赛网页架构收尾'), key('查 0.2.80 真机聚球还卡不卡')],
      edits: { [key('打磨自媒体布局')]: { title: '打磨自媒体布局(新电脑上)', owner: 'codex' } },
    })
    expect(done.ok).toBe(true)
    const board = await h.tasks.list()
    expect(board.tasks.some(task => task.title === '参赛网页架构收尾')).toBe(false)
    expect(board.tasks.find(task => task.title === '打磨自媒体布局(新电脑上)')?.assignee).toBe('codex')
    expect(board.tasks.find(task => task.id === 't-b5302d3f')?.status).toBe('todo')
    expect(h.opened).toHaveLength(0)
    if (done.ok) expect(done.result.line).toBe('摆好了。')
  })

  it('单子换过了还拿旧 id 来点:旧的五份以内照样认;认不得的 404', async () => {
    const h = harness()
    const got = await h.service.preview()
    if (!got.ok) throw new Error(got.error)
    expect(await h.service.apply({ id: 'nope' })).toMatchObject({ ok: false, status: 404 })
  })

  it('事务官会话开不起来:卡照建、第一件如实说没派出去', async () => {
    let tasksRef: ReturnType<typeof createTasksService> | undefined
    const h = harness({ dispatch: input => dispatchExistingItem({ tasks: tasksRef as ReturnType<typeof createTasksService>, opener: { open: async () => undefined } }, input) })
    tasksRef = h.tasks
    const got = await h.service.preview()
    if (!got.ok) throw new Error(got.error)
    const done = await h.service.apply({ id: got.plan.id })
    if (!done.ok) throw new Error(done.error)
    expect(done.result.line).toBe('摆好了;交给 Codex 的那件没派出去:事务官那条会话没开起来。')
    const web = (await h.tasks.list()).tasks.find(task => task.title === '参赛网页架构收尾')
    expect(web?.note).toBe('会话未开')
    expect(web?.assignee).toBe('codex')
  })
})

describe('模型那一份', () => {
  it('缓存按「项目答案 + 其它」的指纹:收尾那几项变了不重问', async () => {
    let asked = 0
    const h = harness({
      extract: async () => { asked += 1; return { ok: true, value: { cards: [{ title: '给评委准备演示账号', owner: 'claude', status: 'todo', quote: '评委要能登进来看' }], projects: [], keywords: {} } } },
    })
    const first = await h.service.preview()
    expect(first.ok && first.plan.source === 'model+rules').toBe(true)
    expect(first.ok && first.plan.rows.some(row => row.title === '给评委准备演示账号')).toBe(true)
    await h.service.preview()
    expect(asked).toBe(1)
    const changed = { ...archive, answers: { ...archive.answers, wrapup: { ...archive.answers.wrapup, evening_routine: '21:00' } } }
    expect(modelInputHash(changed)).toBe(modelInputHash(archive))
  })

  it('模型失败:照规则表那一份,单子上记下原因', async () => {
    const h = harness({ extract: async () => ({ ok: false, why: '模型超时(25 秒)' }) })
    const got = await h.service.preview()
    expect(got.ok && got.plan.source === 'rules' && got.plan.model_note === '模型超时(25 秒)').toBe(true)
  })

  it('问模型:同一套地址与钥匙、json_object、事务官的默认模型;上游不认 response_format 就去掉再问', async () => {
    const calls: Record<string, unknown>[] = []
    const reply = { cards: [{ title: '参赛网页架构收尾', owner: 'codex', status: 'doing', quote: '参赛主件是网页' }] }
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization, ...body })
      if (calls.length === 1) return new Response('{"error":"bad"}', { status: 400 })
      return new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const got = await extractWithModel(archive, '2026-09-24', {
      endpoint: async () => ({ ready: true, baseUrl: 'https://relay.example/v1', key: 'tok' }),
      model: () => 'deepseek-v4-flash',
      fetchImpl,
    })
    expect(got.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ url: 'https://relay.example/v1/chat/completions', auth: 'Bearer tok', model: 'deepseek-v4-flash', response_format: { type: 'json_object' } })
    expect(calls[1]?.response_format).toBeUndefined()
    const user = ((calls[0]?.messages as { content: string }[])[1] as { content: string }).content
    expect(user).toContain('参赛主件是网页')
    expect(user).not.toContain('第一条:让 Codex')
  })

  it('own 档他自己填的模型名照用,不挑 deepseek 前缀(2026-10-23,卡「事务官换Key」)', async () => {
    const calls: Record<string, unknown>[] = []
    const reply = { cards: [{ title: '参赛网页架构收尾', owner: 'codex', status: 'doing', quote: '参赛主件是网页' }] }
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const got = await extractWithModel(archive, '2026-09-24', {
      endpoint: async () => ({ ready: true, baseUrl: 'https://ark.example/api/plan/v3', key: 'tok' }),
      model: () => 'his-own-model',
      fetchImpl,
    })
    expect(got.ok).toBe(true)
    expect(calls[0]).toMatchObject({ model: 'his-own-model' })
  })

  it('模型没接上 / 超时 / 回的不是 JSON:回原因,不抛', async () => {
    expect(await extractWithModel(archive, '2026-09-24', { endpoint: async () => ({ ready: false, baseUrl: '' }) })).toEqual({ ok: false, why: '模型服务还没接上' })
    const slow = (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error) })
    })) as unknown as typeof fetch
    expect(await extractWithModel(archive, '2026-09-24', { endpoint: async () => ({ ready: true, baseUrl: 'x' }), fetchImpl: slow, timeoutMs: 20 })).toEqual({ ok: false, why: '模型超时(0 秒)' })
    const prose = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '好的,我来整理' } }] }), { status: 200 })) as unknown as typeof fetch
    expect(await extractWithModel(archive, '2026-09-24', { endpoint: async () => ({ ready: true, baseUrl: 'x' }), fetchImpl: prose })).toEqual({ ok: false, why: '模型回的不是 JSON' })
    expect(parseJsonReply('前面一句 {"a":1} 后面一句')).toEqual({ a: 1 })
  })
})

describe('落完那一句', () => {
  it('派出去了才说派出去了;有几样没落上就照实说', () => {
    expect(resultLine([{ key: 'x', title: 'x', ok: true }], { task_id: 't', ok: true }, undefined)).toBe('派出去了,做完叫你。')
    expect(resultLine([{ key: 'task:a', title: 'a', ok: false, note: '看板没建成' }], undefined, undefined)).toBe('摆好了。有 1 样没落上,屏幕上写着是哪几样。')
  })
})

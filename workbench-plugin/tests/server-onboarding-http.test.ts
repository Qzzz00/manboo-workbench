// @vitest-environment node
/**
 * 引导流程的 HTTP 半边:/onboarding/session、/onboarding/answer、/onboarding/restart、/onboarding/project、
 * GET /onboarding、/state.onboarding,以及授权表在三处写接口上的 403。
 *
 * 会话是注入桩;记忆写进临时 git 仓库;AGENTS.md 是临时文件。不碰 ~/.dsh。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { FULL_PLAN } from '../src/server/onboardingStages.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-15T01:00:00Z') / 1000)

/** 程序来源:没有 Origin、不是壳 UA(事务官在会话里 curl 就是这样)。 */
async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
/** 页面来源:浏览器 fetch 会带 Origin。 */
const asPage = { origin: 'http://127.0.0.1:8791' }

async function getJson(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

interface ServeOptions {
  withOnboarding?: boolean
  withAuthorization?: boolean
  open?: (message: string) => Promise<string | undefined>
}

async function serve(options: ServeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-http-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n\n原文一行。\n')
  const authorization = createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') })
  let n = 0
  const tasks = createTasksService({ file: join(root, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'), repoRoot: repo, agentsFile, authorization, tasks,
    now: () => new Date(NOW_SEC * 1000),
  })
  await onboarding.load()
  const sent: string[] = []
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    ...(options.withOnboarding === false ? {} : { onboarding }),
    ...(options.withAuthorization === false ? {} : { authorization }),
    ...(options.open === undefined ? {} : { butlerSession: { open: async (message: string) => { sent.push(message); return options.open?.(message) } } }),
  })
  started.push(server)
  return { url: server.url, root, repo, agentsFile, authorization, sent, onboarding }
}

describe('/onboarding/*', () => {
  it('开会话:第一条消息带阶段与清单,会话 id 记回;/state.onboarding 有了 askedAt', async () => {
    const { url, sent } = await serve({ open: async () => 'sess-ob' })
    const before = (await getJson(url, '/state')).body as unknown as WorkbenchState
    // 2026-09-18 起这一份还带着只读进度要用的 label / step / steps;askedAt 仍然「没问过就没有」。
    // 2026-09-21:多了 ①′ 布局那一步,共 9 步。
    expect(before.onboarding).toMatchObject({ stage: 'opening', done: false, label: '① 开场', step: 1, steps: 9 })
    expect(before.onboarding?.askedAt).toBeUndefined()

    const opened = await post(url, '/onboarding/session', {})
    expect(opened.status).toBe(200)
    expect(opened.body).toMatchObject({ ok: true, stage: 'opening', session_id: 'sess-ob' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('[引导 · ① 开场]')
    expect(sent[0]).toContain('你好,很高兴认识你,我是你的专属事务官')
    expect(sent[0]).toContain(`POST ${url.replace('localhost', '127.0.0.1')}/onboarding/answer`)
    expect(sent[0]).toContain('"stage":"opening"')

    const after = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(after.onboarding).toMatchObject({ stage: 'opening', done: false, askedAt: '2026-09-15T01:00:00.000Z' })
  })

  it('没接会话通道 → 事项照旧:200 + note 会话未开,第一条消息照样回给前台', async () => {
    const { url } = await serve()
    const opened = await post(url, '/onboarding/session', {})
    expect(opened.status).toBe(200)
    expect(opened.body).toMatchObject({ ok: true, note: '会话未开' })
    expect(typeof opened.body.first_message).toBe('string')
  })

  it('answer:合法推进 200,带下一阶段;跳阶段 409;坏 key 400;坏 JSON 400', async () => {
    const { url } = await serve()
    const named = await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Ben' })
    expect(named.status).toBe(200)
    // 2026-09-23:开场答完先到 ② 分岔(布局排在分岔之后)。
    expect(named.body).toMatchObject({ ok: true, stage: 'branch', advanced: true, done: false })
    expect((named.body.next as { label: string }).label).toBe('② 分岔')
    expect((named.body.commit as { ok: boolean }).ok).toBe(true)
    // 分岔还没答就答布局:409。
    const early = await post(url, '/onboarding/answer', { stage: 'template', key: 'template', value: 'product' })
    expect(early.status).toBe(409)

    const jump = await post(url, '/onboarding/answer', { stage: 'persona', key: 'persona', value: '傲娇' })
    expect(jump.status).toBe(409)
    expect(jump.body.error).toContain('② 分岔')

    const badKey = await post(url, '/onboarding/answer', { stage: 'branch', key: 'nickname', value: 'x' })
    expect(badKey.status).toBe(400)

    const badJson = await fetch(`${url}/onboarding/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(badJson.status).toBe(400)

    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.onboarding).toMatchObject({ stage: 'branch', done: false, label: '② 分岔', step: 2 })
    const detail = await getJson(url, '/onboarding')
    expect(detail.body).toMatchObject({ stage: 'branch', nickname: 'Ben', answered: { opening: ['nickname'] } })
  })

  it('restart:scope 白名单;persona 只走那一段', async () => {
    const { url } = await serve()
    expect((await post(url, '/onboarding/restart', { scope: 'everything' })).status).toBe(400)
    const restarted = await post(url, '/onboarding/restart', { scope: 'persona' })
    expect(restarted.status).toBe(200)
    expect(restarted.body).toEqual({ ok: true, stage: 'persona' })
    const detail = await getJson(url, '/onboarding')
    expect(detail.body.plan).toEqual(['persona', 'done'])
  })

  it('project:补问新项目只在引导做完之后排队;做完之前如实回空', async () => {
    const { url } = await serve()
    const early = await post(url, '/onboarding/project', { name: 'X' })
    expect(early.status).toBe(200)
    expect(early.body).toEqual({ ok: true, added: [], supplement: [] })
    expect((await post(url, '/onboarding/project', { name: '' })).status).toBe(400)
  })

  /**
   * 2026-09-21:「把各家客户端里记的东西拷一份给事务官」那一条路由。
   * 这个 serve() 没接 memories 那一档,所以这里断言的是**如实说没拷** ——
   * 200 + 一句人话,绝不是一句"拷好了"(拷什么、怎么拷在 server-agent-memory 与
   * server-onboarding-import-memories 两份用例里)。
   */
  it('import-memories:200;**授权表里「读各家客户端文件」不是「可以」就不拷**,如实说一句(2026-09-22 C5)', async () => {
    const { url } = await serve()
    const blocked = await post(url, '/onboarding/import-memories', {})
    expect(blocked.status).toBe(200)
    expect(blocked.body.ok).toBe(false)
    expect(String(blocked.body.note)).toContain('没拷')
    // 没拷成就**不算答过** —— 否则他把授权改回来之后,这一问再也不会被问第二遍。
    const before = (await getJson(url, '/onboarding')).body as { answered: Record<string, string[]> }
    expect(before.answered.projects ?? []).not.toContain('import_memories')

    // 授权到位之后照旧记成答过了(这台服务没接「拷记忆」那一档,所以还是「没拷」,但理由变了)。
    for (const step of [
      ['opening', 'nickname', 'Ben'], ['branch', 'mode', 'existing'], ['template', 'template', 'product'],
      ['projects', 'read_client_files', true],
    ] as const) {
      expect((await post(url, '/onboarding/answer', { stage: step[0], key: step[1], value: step[2] })).status).toBe(200)
    }
    const done = await post(url, '/onboarding/import-memories', {})
    expect(done.body.ok).toBe(true)
    expect(String(done.body.note)).toContain('没拷')
    const detail = (await getJson(url, '/onboarding')).body as { answered: Record<string, string[]> }
    expect(detail.answered.projects).toContain('import_memories')
  })

  /**
   * 2026-09-22:界面上那颗按钮先探一眼(`GET /onboarding/memories`)。
   * 这个 serve() 没接 memories 那一档,所以这里断言的是 **wired:false + 如实说一句**
   * —— 不是一张空表(空表会被读成"这台电脑上一家都没有")。
   */
  it('GET /onboarding/memories:200;没接这一档时 wired:false,并带回授权此刻是哪一档', async () => {
    const { url } = await serve()
    const probe = await getJson(url, '/onboarding/memories')
    expect(probe.status).toBe(200)
    const body = probe.body as unknown as { wired: boolean, allowed: boolean, status: string, families: unknown[], note: string }
    expect(body.wired).toBe(false)
    expect(body.families).toEqual([])
    // 缺省「要问」——「没答过」会被读成"随便读"(C5)。
    expect(body.status).toBe('要问')
    expect(body.allowed).toBe(false)
    expect(body.note).toContain('没接')
  })

  it('没接引导服务 → 404,/state 没有 onboarding 字段', async () => {
    const { url } = await serve({ withOnboarding: false })
    expect((await post(url, '/onboarding/session', {})).status).toBe(404)
    expect((await getJson(url, '/onboarding')).status).toBe(404)
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.onboarding).toBeUndefined()
  })
})

describe('授权表在写接口上的 403', () => {
  it('write_api 默认不可以:程序来源打 /task/create、/task/update、/butler/item 都 403 带人话;引导自己的路由不拦', async () => {
    const { url } = await serve()
    const create = await post(url, '/task/create', { title: '卡' })
    expect(create.status).toBe(403)
    expect(create.body.error).toContain('write_api')
    expect(create.body.error).toContain('docs/记忆/授权.md')

    const update = await post(url, '/task/update', { id: 't-1', title: '改' })
    expect(update.status).toBe(403)

    const item = await post(url, '/butler/item', { text: '看一眼' })
    expect(item.status).toBe(403)

    // 引导路由不过这道门。
    expect((await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Ben' })).status).toBe(200)
    // 什么都没建。
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.tasks?.tasks ?? []).toHaveLength(0)
  })

  it('页面来源(带 Origin)不受表管:Ben 自己点的照常', async () => {
    const { url } = await serve()
    const create = await post(url, '/task/create', { title: '卡' }, asPage)
    expect(create.status).toBe(200)
    const update = await post(url, '/task/update', { id: 't-1', title: '改' }, asPage)
    expect(update.status).toBe(200)
  })

  it('引导 A 线里授权 write_api 可以 → 程序来源放行;Ben 手改文件成「不可以」→ 立刻又拦', async () => {
    const { url, authorization } = await serve()
    // 走到授权阶段。
    for (const step of [
      ['opening', 'nickname', 'Ben'], ['branch', 'mode', 'existing'], ['template', 'template', 'product'], ['projects', 'done', true],
      ['authorization', 'write_docs', 'ask'], ['authorization', 'write_commit', 'ask'],
    ] as const) {
      const result = await post(url, '/onboarding/answer', { stage: step[0], key: step[1], value: step[2] })
      expect(result.status).toBe(200)
    }
    expect((await post(url, '/task/create', { title: '卡' })).status).toBe(403)
    expect((await post(url, '/onboarding/answer', { stage: 'authorization', key: 'write_api', value: true })).status).toBe(200)
    // 2026-09-22(C5):授权那一段多一项必答,答完它才推进到「④ 习惯偏好」。
    const granted = await post(url, '/onboarding/answer', { stage: 'authorization', key: 'read_client_files', value: 'ask' })
    expect(granted.status).toBe(200)
    expect(granted.body).toMatchObject({ stage: 'habits' })
    expect(readFileSync(authorization.file, 'utf8')).toContain('| `write_api` |')
    expect((await post(url, '/task/create', { title: '卡' })).status).toBe(200)
    expect((await post(url, '/task/update', { id: 't-1', title: '改' })).status).toBe(200)

    // Ben 在 git 里手改:mtime 变了就重读,不用重启。
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(authorization.file, readFileSync(authorization.file, 'utf8').replace('| `write_api` | 调工作台写接口(建事项 /butler/item、看板 /task/*) | 可以 |', '| `write_api` | 调工作台写接口(建事项 /butler/item、看板 /task/*) | 不可以 |'))
    expect((await post(url, '/task/create', { title: '卡' })).status).toBe(403)
  })

  /**
   * 2026-09-20(Ben:「包括它说不能改,我当时一度想要停下」)。
   * 早上那通的日志里躺着一行 `引导 opening.nickname → 409`,这几条守的就是它。
   */
  it('correct:阶段走过去了照样改得回来,而且阶段不倒退', async () => {
    const { url } = await serve()
    await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Java' })
    await post(url, '/onboarding/answer', { stage: 'template', key: 'template', value: 'product' })
    const blocked = await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: '本' })
    expect(blocked.status).toBe(409)

    const fixed = await post(url, '/onboarding/correct', { stage: 'opening', key: 'nickname', value: '本' })
    expect(fixed.status).toBe(200)
    expect(fixed.body).toMatchObject({ ok: true, stage: 'opening', key: 'nickname', current: 'branch' })
    expect(String(fixed.body.also)).toContain('用户-本.md')
    expect((await getJson(url, '/onboarding')).body).toMatchObject({ stage: 'branch', nickname: '本' })
  })

  it('correct:没答过的 404 并指路;坏 stage 400', async () => {
    const { url } = await serve()
    const missed = await post(url, '/onboarding/correct', { stage: 'opening', key: 'nickname', value: '本' })
    expect(missed.status).toBe(404)
    expect(String(missed.body.error)).toContain('/onboarding/answer')
    expect((await post(url, '/onboarding/correct', { stage: '没这个', key: 'nickname', value: '本' })).status).toBe(400)
  })

  /**
   * 2026-09-20(Ben:「10 月 4 号,智能一点就该知道这是国庆」)。
   * 这条只读、纯算 —— 表在 holidays.ts,**服务端算,模型不心算**。
   */
  it('workdays:算得出来带出处与「调休没录入」那句;算不出来 400,不回 0', async () => {
    const { url } = await serve()
    const counted = await getJson(url, '/onboarding/workdays?from=2026-09-20&to=2026-10-04')
    expect(counted.status).toBe(200)
    expect(counted.body).toMatchObject({ days: 15, workdays: 7, uncertain: true })
    expect(String(counted.body.text)).toContain('国庆')
    expect(counted.body.target).toMatchObject({ date: '2026-10-04', weekday: '周日', workday: false })

    const bad = await getJson(url, '/onboarding/workdays?to=十月四号')
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('YYYY-MM-DD')
    expect(bad.body.workdays).toBeUndefined()
  })

  it('没接授权表 → 老样子,回环即放行', async () => {
    const { url } = await serve({ withAuthorization: false })
    expect((await post(url, '/task/create', { title: '卡' })).status).toBe(200)
    expect((await post(url, '/task/update', { id: 't-1', title: '改' })).status).toBe(200)
  })
})

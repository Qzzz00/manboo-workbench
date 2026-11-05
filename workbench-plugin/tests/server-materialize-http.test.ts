// @vitest-environment node
/**
 * 引导落地的 HTTP 半边(卡 feat/onboarding-materialize):
 *   - POST /onboarding/materialize/preview → 单子上屏(/state.materialize),回电话里那一句;
 *   - POST /onboarding/materialize/apply:页面按钮(带 Origin)与手机直接落;程序调(工人 / DSH curl)带着他那句话,听着没点头 409;
 *   - GET /onboarding/brief 带 setup(工人据此留着 setup_apply);
 *   - 引导收尾最后一项交上去:回包多 setup_next,后台把单子摆上屏。
 * 另:③ 授权也收 import_memories(真机上连着两次 400);②′ 方案去重、提到旧版本的不建;落完项目背景写进项目文件。
 * 不碰 ~/.dsh:引导存档、看板、记忆仓库都在临时目录。
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
import { createMaterializeService, dispatchExistingItem } from '../src/server/materializeService.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { approvesSetup } from '../src/server/onboardingConsent.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { FULL_PLAN } from '../src/server/onboardingStages.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-24T12:30:00Z') / 1000)
const archiveText = readFileSync(new URL('./fixtures/materialize/onboarding-0924.json', import.meta.url), 'utf8')
const tasksText = readFileSync(new URL('./fixtures/materialize/tasks-0924.json', import.meta.url), 'utf8')

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
async function getJson(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
const asPage = { origin: 'http://127.0.0.1:8791' }
const WB = '/Users/example/Documents/GitHub/desktop-workbench'
const ECHO = '/Users/example/Documents/GitHub/Echo'

function gitRepo(dir: string): void {
  mkdirSync(join(dir, 'docs', '记忆', '项目'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
}

/** 维护者那份存档(已经做完)+ 那晚的看板;或者一份空的(从头走一遍引导)。 */
async function serve(options: { archive?: 'done' | 'fresh' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-materialize-http-'))
  dirs.push(root)
  const repo = join(root, 'memory')
  gitRepo(repo)
  writeFileSync(join(repo, 'docs', '记忆', '项目', 'desktop-workbench.md'), '# 项目:desktop-workbench\n\n- **一句话**:事务官\n\n## 进展\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo })
  const onboardingFile = join(root, 'onboarding.json')
  if (options.archive !== 'fresh') writeFileSync(onboardingFile, archiveText)
  writeFileSync(join(root, 'tasks.json'), tasksText)
  let n = 0
  const tasks = createTasksService({ file: join(root, 'tasks.json'), now: () => NOW_SEC, newId: () => `m-${++n}` })
  const authorization = createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const onboarding = createOnboardingService({ plan: FULL_PLAN, file: onboardingFile, repoRoot: repo, agentsFile, authorization, tasks, now: () => new Date(NOW_SEC * 1000) })
  await onboarding.load()
  const opened: string[] = []
  const stored: { id: string, name: string, repoPath?: string }[] = [{ id: 'desktop-workbench', name: 'desktop-workbench', repoPath: WB }]
  const materialize = createMaterializeService({
    file: join(root, 'materialize.json'),
    now: () => new Date(NOW_SEC * 1000),
    readArchive: async () => { try { return JSON.parse(readFileSync(onboardingFile, 'utf8')) } catch { return undefined } },
    tasks,
    // 仓库现在的版本(判「交接里的 0.2.80」过时):测试里直接给。
    version: async () => '0.2.83',
    // 项目区的桩:工作台已经录了,Echo 是扫到的仓库。
    projects: {
      stored: async () => stored.map(one => ({ ...one })),
      repos: async () => [{ id: 'desktop-workbench', name: 'desktop-workbench', path: WB }, { id: 'echo', name: 'Echo', path: ECHO }],
      adopt: async ({ name, path }) => {
        const have = stored.find(one => one.repoPath === path)
        if (have !== undefined) { have.name = name; return { id: have.id } }
        stored.push({ id: path.endsWith('/Echo') ? 'echo' : name, name, repoPath: path })
        return { id: stored.at(-1)?.id as string }
      },
      setDdl: async () => true,
    },
    dispatch: input => dispatchExistingItem({ tasks, opener: { open: async (message) => { opened.push(message); return 'sess-dsh-1' } } }, input),
    onApplied: async input => { await onboarding.recordMaterialized?.(input) },
  })
  await materialize.load()
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService({ now: () => NOW_SEC }), tickIntervalMs: 0, tasks, onboarding, authorization, materialize,
    butlerSession: { open: async () => 'sess-ob' },
  })
  started.push(server)
  return { url: server.url, tasks, opened, repo, onboarding, materialize }
}

describe('/onboarding/materialize/*', () => {
  it('预览:单子上 /state.materialize,回电话里那一句;预览不写看板', async () => {
    const { url, tasks } = await serve()
    const got = await post(url, '/onboarding/materialize/preview', {})
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ ok: true, line: '都摆好了,两个项目、十件事,屏幕上有张单子;第一件交给 Codex 接着做参赛网页,行吗?' })
    expect(String(got.body.note)).toContain('只说 line 这一句')
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.materialize).toMatchObject({ id: got.body.id, status: 'pending' })
    expect(state.materialize?.rows.some(row => row.title === '参赛网页架构收尾')).toBe(true)
    expect((await tasks.list()).tasks).toHaveLength(7)
    const view = await getJson(url, '/onboarding/materialize')
    expect(view.body.id).toBe(got.body.id)
  })

  it('页面上点「就这样」(带 Origin):落;第一件开一条事务官会话、点名 Codex;/state 变成 applied', async () => {
    const { url, tasks, opened, repo } = await serve()
    const got = await post(url, '/onboarding/materialize/preview', {})
    const done = await post(url, '/onboarding/materialize/apply', { id: got.body.id }, asPage)
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ line: '派出去了,做完叫你。' })
    const board = await tasks.list()
    expect(board.tasks.filter(task => task.source.ref === '引导落地')).toHaveLength(10)
    expect(board.tasks.filter(task => task.status === 'canceled')).toHaveLength(7)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('他点名要 Codex 做这件事')
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.materialize?.status).toBe('applied')
    // 项目背景写进了记忆里那一份项目文件,存了一个版本。
    expect(readFileSync(join(repo, 'docs', '记忆', '项目', 'desktop-workbench.md'), 'utf8')).toContain('- **背景**:9/29 起远程(只带 Pad);中秋 9/25-9/27,国庆 10/1 起(引导落地')
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: repo, encoding: 'utf8' })
    expect(log).toContain('chore(记忆): 引导·落地')
  })

  it('程序调(工人 / DSH 的 curl)带着他那句话:「等等,我再看看」→ 409 不落;「可以」→ 落', async () => {
    const { url, tasks } = await serve()
    const got = await post(url, '/onboarding/materialize/preview', {})
    const line = String(got.body.line)
    const refused = await post(url, '/onboarding/materialize/apply', { id: got.body.id, heard: { asked: line, reply: '等等,我再看看' } })
    expect(refused.status).toBe(409)
    expect(String(refused.body.error)).toContain('没点头')
    expect((await tasks.list()).tasks).toHaveLength(7)
    const ok = await post(url, '/onboarding/materialize/apply', { id: got.body.id, heard: { asked: line, reply: '可以,就这样' } })
    expect(ok.status).toBe(200)
  })

  it('电话里「视频那件不用」:skip 按标题认出来勾掉', async () => {
    const { url, tasks } = await serve()
    const got = await post(url, '/onboarding/materialize/preview', {})
    await post(url, '/onboarding/materialize/apply', { id: got.body.id, skip: ['参赛视频'], heard: { asked: '行吗?', reply: '视频那件不用,其余可以' } })
    const titles = (await tasks.list()).tasks.map(task => task.title)
    expect(titles).not.toContain('参赛视频')
    expect(titles).toContain('参赛文案')
  })

  it('简报带 setup:单子等他点头时 pending,落完不再 pending', async () => {
    const { url } = await serve()
    const got = await post(url, '/onboarding/materialize/preview', {})
    expect((await getJson(url, '/onboarding/brief')).body.setup).toMatchObject({ pending: true, id: got.body.id })
    await post(url, '/onboarding/materialize/apply', { id: got.body.id }, asPage)
    expect((await getJson(url, '/onboarding/brief')).body.setup).toMatchObject({ pending: false, applied: true })
  })
})

describe('引导收尾:做完那一刻接着摆单子', () => {
  it('收尾最后一项交上去:回包带 setup_next;后台把单子摆上屏', async () => {
    const { url, onboarding } = await serve({ archive: 'fresh' })
    const answers: [string, string, unknown][] = [
      ['opening', 'nickname', 'Ben'], ['branch', 'mode', 'existing'], ['template', 'template', 'product'],
      ['projects', 'project', { name: 'desktop-workbench', status: '参赛网页架构基本快弄完(Codex 在跑)', details: '参赛主件是网页(架构基本快弄完,Codex 在跑),视频由别人接手', deadline: '2026-10-04(Spotlight 比赛报名截止)' }],
      ['projects', 'done', true],
      ['authorization', 'write_docs', true], ['authorization', 'write_commit', true], ['authorization', 'write_api', true], ['authorization', 'read_client_files', false],
      ['habits', 'done', true], ['persona', 'persona', '傲娇'], ['persona', 'candor', 5], ['persona', 'verbosity', 3], ['naming', 'butler_name', '拓麻鸽子'],
      ['wrapup', 'morning_report', true], ['wrapup', 'evening_routine', '20:30'],
    ]
    for (const [stage, key, value] of answers) {
      const res = await post(url, '/onboarding/answer', { stage, key, value }, asPage)
      expect(res.status, `${stage}.${key}`).toBe(200)
    }
    const last = await post(url, '/onboarding/answer', { stage: 'wrapup', key: 'first_item', value: '让 Codex 把参赛网页的架构剩下的补完' }, asPage)
    expect(last.body).toMatchObject({ done: true, setup_next: true })
    expect(onboarding.view().done).toBe(true)
    // 后台那一下:等它排好。
    for (let i = 0; i < 50; i += 1) {
      const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
      if (state.materialize !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.materialize?.status).toBe('pending')
    expect(state.materialize?.rows.map(row => row.title)).toContain('参赛网页架构收尾')
  })

  it('③ 授权也收 import_memories(先 read_client_files 再 import_memories);不再 400', async () => {
    const { url } = await serve({ archive: 'fresh' })
    for (const [stage, key, value] of [
      ['opening', 'nickname', 'Ben'], ['branch', 'mode', 'existing'], ['template', 'template', 'product'],
      ['projects', 'project', { name: 'x', status: 'y' }], ['projects', 'done', true],
    ] as [string, string, unknown][]) await post(url, '/onboarding/answer', { stage, key, value }, asPage)
    expect((await post(url, '/onboarding/answer', { stage: 'authorization', key: 'read_client_files', value: true }, asPage)).status).toBe(200)
    const imported = await post(url, '/onboarding/answer', { stage: 'authorization', key: 'import_memories', value: true }, asPage)
    expect(imported.status).toBe(200)
    // 这台测试工作台没接「拷别家记忆」:如实说没拷,但答案收下了。
    expect(String(imported.body.note)).toContain('没接「拷别家记忆」')
  })
})

describe('他点头了吗', () => {
  it('可以 / 就这样 / 行 / 派吧 算点头;等等 / 先别 / 改一下 / 我再看看 不算', () => {
    for (const yes of ['可以', '就这样', '行,派吧', '好的', 'OK', '视频那件不用,其余可以']) expect(approvesSetup(yes), yes).toBe(true)
    for (const no of ['等等', '先别落', '改一下', '我再看看', '不行', '', '嗯……那个视频是谁做的?']) expect(approvesSetup(no), no).toBe(false)
  })
})

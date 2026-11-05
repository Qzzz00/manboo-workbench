// @vitest-environment node
/**
 * 第五轮引导对话与扫描(2026-09-24 11:3x,0.2.79,维护者手机语音走引导)工作台这一头的回放。
 * 原句取自工人日志与 8791 /onboarding/turns。电话那一头在 channel-worker/tests/onboarding-r5-0924.test.ts。
 *
 *   1 按名字找项目太死:「工作台」→ 没扫成;「work bench」→ 又没扫成(真仓库叫 desktop-workbench)
 *   2 切到电脑续接:两条几乎一样的「Ben,接着上次那句问一句——上次到哪,接着吗?」
 *   4 / 5 / 6 改称呼又宣告、布局复述求「对吗」、电话里太长
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { FULL_PLAN, TURN_RULES, firstMessage, stageDef } from '../src/server/onboardingStages.ts'
import { createOnboardingTurns } from '../src/server/onboardingTurns.ts'
import { createProjectsService, projectNameScore, projectQueryKeys } from '../src/server/projectsService.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-24T03:30:00Z') / 1000)
const GH = '/Users/example/Documents/GitHub'
/** 维护者那台机器上扫描根下的样子(节选)。 */
const REPOS = [`${GH}/Aiboo`, `${GH}/desktop-workbench`, `${GH}/deepseek-harness`, `${GH}/notes-site`]

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-r5-'))
  dirs.push(dir)
  return dir
}

function projectsService(repos: readonly string[] = REPOS, gitCalls = { n: 0 }) {
  return createProjectsService({
    file: join(tempDir(), 'projects.json'),
    exec: async (args, cwd) => {
      gitCalls.n += 1
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'main\n' }
      // desktop-workbench 最近在动,其余久一点。
      if (args[0] === 'log') return { ok: true, stdout: cwd?.endsWith('desktop-workbench') ? '2026-09-24T03:00:00Z\n' : '2026-08-01T00:00:00Z\n' }
      return { ok: true, stdout: '' }
    },
    listDir: async (dir: string) => dir === GH ? [...repos, `${GH}/随手记`] : [],
    isRepo: async (dir: string) => repos.includes(dir),
    codexHome: '/x',
    codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
    home: '/Users/example',
    now: () => NOW_SEC,
    scanRoots: [{ path: GH, depth: 1 }],
  })
}

async function post(url: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve(options: { projects?: ReturnType<typeof projectsService>, say?: (id: string, text: string) => Promise<boolean> } = {}) {
  const root = tempDir()
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const authorization = createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') })
  const onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'), repoRoot: repo, agentsFile, authorization,
    now: () => new Date(NOW_SEC * 1000),
  })
  await onboarding.load()
  const turns = createOnboardingTurns({ now: () => new Date(NOW_SEC * 1000) })
  const sent: string[] = []
  const said: [string, string][] = []
  let n = 0
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    onboarding,
    authorization,
    onboardingTurns: turns,
    ...(options.projects === undefined ? {} : { projects: options.projects }),
    butlerSession: {
      open: async (message: string) => { sent.push(message); return `sess-${++n}` },
      say: async (id: string, text: string) => { said.push([id, text]); return options.say === undefined ? true : options.say(id, text) },
    },
  })
  started.push(server)
  return { url: server.url, authorization, onboarding, turns, sent, said }
}

describe('1 · 按名字找项目:归一、中英对照、包含;找不到退一步念候选', () => {
  it('比较键:大小写 / 空格 / 连字符 / 引号都归一;中文说法出英文键;一句里报两个名字各算一个', () => {
    expect(projectQueryKeys('工作台')).toEqual(expect.arrayContaining(['工作台', 'workbench']))
    expect(projectQueryKeys('work bench')).toContain('workbench')
    expect(projectQueryKeys('「Work-Bench」')).toContain('workbench')
    expect(projectQueryKeys('工作台，ben-dsh-workbench')).toEqual(expect.arrayContaining(['workbench', 'bendshworkbench']))
    expect(projectNameScore('desktop-workbench', projectQueryKeys('desktop workbench'))).toBe(3)
    expect(projectNameScore('desktop-workbench', projectQueryKeys('工作台'))).toBe(2)
    expect(projectNameScore('desktop-workbench', projectQueryKeys('work bench'))).toBe(2)
    // 太短的不拿来「包含」:一个 app 不该把半个硬盘拉进来。
    expect(projectNameScore('desktop-workbench', projectQueryKeys('de'))).toBe(0)
    expect(projectNameScore('Aiboo', projectQueryKeys('工作台'))).toBe(0)
  })

  it('真机那两句:「工作台」与「work bench」都找到 desktop-workbench;不跑 git', async () => {
    const git = { n: 0 }
    const svc = projectsService(REPOS, git)
    expect((await svc.locate?.('工作台'))?.matches).toEqual([{ name: 'desktop-workbench', path: `${GH}/desktop-workbench` }])
    expect((await svc.locate?.('work bench'))?.matches).toEqual([{ name: 'desktop-workbench', path: `${GH}/desktop-workbench` }])
    expect((await svc.locate?.('Desktop Workbench'))?.matches).toEqual([{ name: 'desktop-workbench', path: `${GH}/desktop-workbench` }])
    expect(git.n).toBe(0)
  })

  it('一模一样的优先于「包含」的;都只是包含就都给(一句话念给他挑)', async () => {
    const svc = projectsService([...REPOS, `${GH}/workbench`, `${GH}/ben-dsh-workbench`])
    expect((await svc.locate?.('workbench'))?.matches.map(m => m.name)).toEqual(['workbench'])
    const two = projectsService([`${GH}/desktop-workbench`, `${GH}/ben-dsh-workbench`, `${GH}/Aiboo`])
    expect((await two.locate?.('工作台'))?.matches.map(m => m.name).sort()).toEqual(['ben-dsh-workbench', 'desktop-workbench'])
  })

  it('他报的是放仓库的那个目录(「文稿里的 GitHub」→ ~/Documents/GitHub):列它下面的仓库', async () => {
    const svc = projectsService()
    const got = await svc.locate?.('~/Documents/GitHub')
    expect(got?.matches.map(m => m.name)).toEqual(['Aiboo', 'desktop-workbench', 'deepseek-harness', 'notes-site'])
    expect((await svc.locate?.(`${GH}/desktop-workbench/`))?.matches).toEqual([{ name: 'desktop-workbench', path: `${GH}/desktop-workbench` }])
  })

  it('HTTP:按名字没找到 + 已有读目录授权 → 自己退一步扫一遍,带回最近在动的前几个(desktop-workbench 排第一),不叫他报路径', async () => {
    const svc = projectsService()
    const fx = await serve({ projects: svc })
    await fx.authorization.set('read_scan_roots', '可以', '2026-09-24')
    const got = await post(fx.url, '/onboarding/scan', { name: '拼错的名字' })
    expect(got.status).toBe(200)
    expect(got.body.located).toEqual([])
    const candidates = got.body.candidates as { name: string, path: string }[]
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    expect(candidates.length).toBeLessThanOrEqual(5)
    expect(candidates[0]!.name).toBe('desktop-workbench')
    expect(String(got.body.note)).toContain('一句话把这几个名字念给他挑')
    expect(String(got.body.note)).toContain('别让他报路径')
    // 界面据此显示扫描进度:这一趟是引导自己的那一次,进度推进过、扫完有 finished_at。
    const scan = (await (await fetch(`${fx.url}/onboarding/turns`)).json() as { scan?: Record<string, unknown> }).scan
    expect(scan).toMatchObject({ scanning: false, done: REPOS.length, total: REPOS.length })
    expect(scan?.finished_at).toBeDefined()
  })

  it('HTTP:真机那句「工作台」直接找到,回包提醒带 path', async () => {
    const fx = await serve({ projects: projectsService() })
    await fx.authorization.set('read_scan_roots', '可以', '2026-09-24')
    const got = await post(fx.url, '/onboarding/scan', { name: '工作台' })
    expect(got.body.located).toEqual([{ name: 'desktop-workbench', path: `${GH}/desktop-workbench` }])
    expect(String(got.body.note)).toContain('project.path')
    expect(got.body.candidates).toBeUndefined()
  })

  it('没授权照旧 403:退一步扫描也不绕过门', async () => {
    const git = { n: 0 }
    const fx = await serve({ projects: projectsService(REPOS, git) })
    expect((await post(fx.url, '/onboarding/scan', { name: '拼错的名字' })).status).toBe(403)
    expect(git.n).toBe(0)
  })
})

describe('2 · 切到电脑续接:同一时刻只一条,只问当前那一题', () => {
  it('第一条消息不再问「上次到哪,接着吗」,也不寒暄进度;只问还没答的那一题', () => {
    const message = firstMessage({
      stage: 'projects', mode: 'existing', baseUrl: 'http://x', resumed: true, nickname: 'Ben',
      answered: { opening: ['nickname'], branch: ['mode'], template: ['template'] },
    })
    expect(message).not.toContain('上次到哪')
    expect(message).not.toContain('接着吗')
    expect(message).not.toContain('这是接着上次做')
    expect(message).toContain('只问还没答的那一题')
    expect(message).toContain('你想先把哪个项目交给我')
  })

  it('两处几乎同时来开会话(电脑页面 + 手机挂断那一下):只往会话里说一次,第二次只交会话、不重绑回合表', async () => {
    const fx = await serve()
    await fx.onboarding.answer({ stage: 'opening', key: 'nickname', value: 'Ben' })
    const first = await post(fx.url, '/onboarding/session', {})
    expect(first.body).toMatchObject({ session_id: 'sess-1' })
    // 她还没回话,第二处又来开:只交会话。
    fx.turns.handleEvent('sess-1', { type: 'turn/start', data: {} } as never)
    const second = await post(fx.url, '/onboarding/session', {})
    expect(second.body).toMatchObject({ session_id: 'sess-1', resumed: true, quiet: true, first_message: '' })
    expect(fx.sent).toHaveLength(1)
    expect(fx.said).toHaveLength(0)
    // 没重绑:回合表里「在想」还在。
    expect((await (await fetch(`${fx.url}/onboarding/turns`)).json() as { busy: boolean }).busy).toBe(true)
  })

  it('她答过一轮之后再来开(比如过一会儿又从主页点进来):照常推一次', async () => {
    const fx = await serve()
    await fx.onboarding.answer({ stage: 'opening', key: 'nickname', value: 'Ben' })
    await post(fx.url, '/onboarding/session', {})
    fx.turns.handleEvent('sess-1', { type: 'message', data: { role: 'assistant', content: '你现在是已经有在做的事,还是想从一个新点子开始?' } } as never)
    await fx.onboarding.noteTurnEnd('sess-1', { ok: true })
    await post(fx.url, '/onboarding/session', {})
    expect(fx.said).toHaveLength(1)
    expect(fx.said[0]![1]).not.toContain('上次到哪')
  })

  it('往会话里说话失败(DSH 里那条没了)→ 忘掉防重复,下一次来开真去开一条新的', async () => {
    let alive = true
    const fx = await serve({ say: async () => alive })
    await fx.onboarding.answer({ stage: 'opening', key: 'nickname', value: 'Ben' })
    await post(fx.url, '/onboarding/session', {})
    alive = false
    expect((await post(fx.url, '/onboarding/say', { text: '工作台' })).status).toBe(409)
    const reopened = await post(fx.url, '/onboarding/session', {})
    expect(reopened.body.quiet).toBeUndefined()
    expect(reopened.body.session_id).toBe('sess-2')
  })
})

describe('4 / 5 / 6 · 称呼不再宣告;答得明确不求确认;短', () => {
  it('布局这一段:他答得明确就直接记,不复述求「对吗」;含糊才确认一次;问为什么一句话答', () => {
    const goals = stageDef('template', 'existing').goals.join('\n')
    expect(goals).toContain('他答得明确就直接记,不复述、不求确认')
    expect(goals).toContain('只有他答得含糊才确认一次')
    expect(goals).not.toContain('他点头了再记')
    expect(goals).toContain('一句话答')
  })

  it('开场这一段:纠正称呼后不宣告「那我以后就这么叫你了」,字母不拆', () => {
    const goals = stageDef('opening', undefined).goals.join('\n')
    expect(goals).toContain('不宣告')
    expect(goals).toContain('不拆成「B e n」')
  })

  it('每段第一条消息的规矩:答得明确不求确认、不替自己辩解、每次一到两句不用破折号引号括号', () => {
    const rules = TURN_RULES.join('\n')
    expect(rules).toContain('答得明确就不求确认')
    expect(rules).toContain('不再宣告「那我以后就这么叫你了」')
    expect(rules).toContain('不替自己辩解')
    expect(rules).toContain('每次回复一到两句、一个问题')
    expect(rules).toContain('别用破折号、引号、括号、省略号')
  })
})

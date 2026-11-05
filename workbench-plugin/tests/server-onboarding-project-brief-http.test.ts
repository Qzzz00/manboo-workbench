// @vitest-environment node
/**
 * 已有项目拉齐(2026-09-24,维护者 12:40)的 8791 路由:`POST /onboarding/project-brief {path}` 与
 * `POST /onboarding/scan {name}` 只找到一个时随回包带回的摘要。设计 docs/设计-已有项目拉齐-2026-09-24.md 第三、五节。
 *
 * 钉住:
 *   - 门:没授权 403(两条路由同一句人话 + 「先问后看」的用法),授权之后 200;新点子 / 运营那一支 403(授权了也不读);
 *   - 路径白名单:扫描根外拒、`..` 拒、符号链接跳出拒、不存在拒;这次找到过的(按路径找的)认、项目区录过的认;
 *   - 两条路拿到同一段 note(话术只写一处);
 *   - 扫描进度多一种 phase:'read'(current = 项目名),读完留 last_read;
 *   - 只读:不写项目区缓存、不刷被读仓库的索引;
 *   - 没接读项目:project-brief 503,scan 照老样子只回名字与路径;
 *   - 2026-09-24 下午小修(卡 fix/project-brief-polish):同一个 path 60 秒内直接回上一份(不再调 io,日志「用刚才读的」),
 *     过期重读、不同 path 各读各的、门照旧每次过;读过、他点头之后记的那几句标「读仓库说明,Ben确认」,
 *     他改了说法 / 没读过仍是「Ben口述」;两条路由回的 note 里没有「再问一遍」。
 * 全部仓库都在 mkdtemp 出来的临时目录里。
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingTurns } from '../src/server/onboardingTurns.ts'
import { BRANCH_REFUSAL, BRIEF_NOTE, READ_CONSENT_NOTE, nodeBriefIo, type BriefIo } from '../src/server/projectBrief.ts'
import { createProjectsService } from '../src/server/projectsService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { FULL_PLAN } from '../src/server/onboardingStages.ts'
import { PRODUCT_TEMPLATE, setWorkbenchTemplateSource } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

const ops = await loadStarterLayoutTemplate()
beforeAll(() => {
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE, ops],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : id === ops.id ? ops : undefined),
  })
})
afterAll(() => {
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : undefined),
  })
})

const execFileAsync = promisify(execFile)
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-24T05:00:00Z') / 1000)

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-brief-http-')))
  dirs.push(dir)
  return dir
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

function repoAt(dir: string, files: Record<string, string>, message = 'init'): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  write(dir, files)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '-m', message], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-24T03:00:00Z', GIT_COMMITTER_DATE: '2026-09-24T03:00:00Z' },
  })
  return dir
}

async function gitExec(args: readonly string[], cwd: string): Promise<{ ok: boolean, stdout: string }> {
  try { return { ok: true, stdout: (await execFileAsync('git', [...args], { cwd })).stdout } }
  catch { return { ok: false, stdout: '' } }
}

async function listDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
}

async function isRepo(dir: string): Promise<boolean> {
  try { await stat(join(dir, '.git')); return true }
  catch { return false }
}

/** 一台「他的电脑」:扫描根 GitHub 下两个仓库、一个链接跳出去的目录;扫描根外一个桌面上的小仓库。 */
function machine() {
  const box = sandbox()
  const gh = join(box, 'Documents', 'GitHub')
  const workbench = repoAt(join(gh, 'desktop-workbench'), {
    'README.md': '# 工作台 · 事务官\n\n一个记得你、替你组织工作、随叫随到的事务官。给不会写代码的半专业个体。\n',
    'docs/交接-0924-统筹会话交接.md': '# 统筹会话交接\n\n## 一、现在到哪\n- 0.2.80 已装好,停在 ②′ 项目\n\n## 二、下一步\n0. 电话引导要能读仓库\n1. 自验 0.2.80\n',
    'docs/决策记录.md': '# 决策记录\n\n## 2026-09-24 · 第五轮引导对话与扫描\n正文\n',
  }, 'docs(交接): 0924 头号需求')
  repoAt(join(gh, 'Aiboo'), { 'README.md': '# Aiboo\n\n桌面宠物。\n' })
  const outside = repoAt(join(box, 'Desktop', 'side-project'), { 'README.md': '# 副业小站\n\n一个卖手作的小网站。\n' })
  mkdirSync(join(box, 'Desktop', 'not-mine'), { recursive: true })
  symlinkSync(join(box, 'Desktop', 'side-project'), join(gh, 'evil-link'))
  return { box, gh, workbench, outside }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function getJson(url: string, path: string) {
  return await (await fetch(`${url}${path}`)).json() as Record<string, unknown>
}

async function serve(options: { brief?: false, io?: BriefIo } = {}) {
  const pc = machine()
  const memory = join(pc.box, 'workspace')
  mkdirSync(join(memory, 'docs', '记忆', '项目'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: memory })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: memory })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: memory })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: memory })
  const agentsFile = join(pc.box, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const authorization = createAuthorizationService({ file: join(memory, 'docs', '记忆', '授权.md') })
  const projectsFile = join(pc.box, 'dot-dsh', 'projects.json')
  const projects = createProjectsService({
    file: projectsFile,
    exec: gitExec,
    listDir: listDirs,
    isRepo,
    codexHome: join(pc.box, 'codex'),
    codexDeps: { listFiles: async () => [], readFirstLine: async () => '' } as never,
    home: pc.box,
    now: () => NOW_SEC,
    scanRoots: [{ path: pc.gh, depth: 1 }],
  })
  const onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file: join(pc.box, 'onboarding.json'), repoRoot: memory, agentsFile, authorization,
    now: () => new Date(NOW_SEC * 1000),
    projects: { adopt: async input => await (projects.adopt as NonNullable<typeof projects.adopt>)(input) },
  })
  await onboarding.load()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    onboarding,
    authorization,
    onboardingTurns: createOnboardingTurns({ now: () => new Date(NOW_SEC * 1000) }),
    projects,
    ...(options.brief === false ? {} : { projectBrief: { io: options.io ?? nodeBriefIo(), home: pc.box } }),
  })
  started.push(server)
  return { ...pc, url: server.url, authorization, onboarding, projects, projectsFile, memory }
}

type Fx = Awaited<ReturnType<typeof serve>>

/** 走到 ②′:称呼 → 分岔 → 布局。直接交阶段机(这一组测的是读项目,不是凭据门)。 */
async function toProjects(fx: Fx, mode: 'existing' | 'fresh' = 'existing', template: 'product' | 'ops' = 'product') {
  expect((await fx.onboarding.answer({ stage: 'opening', key: 'nickname', value: 'Ben' })).ok).toBe(true)
  expect((await fx.onboarding.answer({ stage: 'branch', key: 'mode', value: mode })).ok).toBe(true)
  expect((await fx.onboarding.answer({ stage: 'template', key: 'template', value: template })).ok).toBe(true)
  expect(fx.onboarding.detail().stage).toBe('projects')
}

async function allowRead(fx: Fx) {
  await fx.authorization.set('read_scan_roots', '可以', '2026-09-24')
}

describe('门:与 /onboarding/scan 同一道', () => {
  it('没授权 → 两条路由都 403,同一句人话 + 「先问后看」的用法;授权之后 200', async () => {
    const fx = await serve()
    await toProjects(fx)
    const scan = await post(fx.url, '/onboarding/scan', { name: '工作台' })
    const brief = await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })
    for (const got of [scan, brief]) {
      expect(got.status).toBe(403)
      expect(got.body.reason).toBe('consent')
      expect(String(got.body.error)).toContain('read_scan_roots')
      expect(got.body.note).toBe(READ_CONSENT_NOTE)
    }
    expect(scan.body.error).toBe(brief.body.error)

    await allowRead(fx)
    const ok = await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ ok: true, name: 'desktop-workbench', path: fx.workbench, note: BRIEF_NOTE })
    expect(String(ok.body.brief)).toContain('一个记得你、替你组织工作、随叫随到的事务官。')
    expect(String(ok.body.brief)).toContain('0. 电话引导要能读仓库')
    expect((ok.body.sources as { kind: string }[]).map(source => source.kind)).toEqual(['readme', 'handoff', 'decisions', 'commits'])
  })

  it('新点子那一支:授权了也 403(reason: branch),不找也不读', async () => {
    const fx = await serve()
    await toProjects(fx, 'fresh')
    await allowRead(fx)
    for (const got of [
      await post(fx.url, '/onboarding/scan', { name: '工作台' }),
      await post(fx.url, '/onboarding/project-brief', { path: fx.workbench }),
    ]) {
      expect(got.status).toBe(403)
      expect(got.body).toEqual({ error: BRANCH_REFUSAL, reason: 'branch' })
    }
    expect((await getJson(fx.url, '/onboarding/scan/status')).last_read).toBeUndefined()
  })

  it('运营那一支(布局选了自媒体运营):同样 403', async () => {
    const fx = await serve()
    await toProjects(fx, 'existing', 'ops')
    await allowRead(fx)
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })).body.reason).toBe('branch')
    expect((await post(fx.url, '/onboarding/scan', { name: 'desktop-workbench' })).body.reason).toBe('branch')
  })

  it('引导做完以后(「再加一个 XX」那条路)不按分支拦,只看授权', async () => {
    const fx = await serve()
    await allowRead(fx)
    // 没走引导的机器:阶段在开场,不是 ②′ —— 分支那道不拦,授权放行就读。
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })).status).toBe(200)
  })
})

describe('按名字只找到一个:摘要随回包带回;两条路同一段 note', () => {
  it('scan {name} 回 located + brief + sources + note;与 project-brief 读同一个,note 一字不差、摘要相同', async () => {
    const fx = await serve()
    await toProjects(fx)
    await allowRead(fx)
    const scan = await post(fx.url, '/onboarding/scan', { name: '工作台' })
    expect(scan.status).toBe(200)
    expect(scan.body.located).toEqual([{ name: 'desktop-workbench', path: fx.workbench }])
    expect(scan.body.note).toBe(BRIEF_NOTE)
    expect(String(scan.body.note)).toContain('project.path')
    expect(String(scan.body.brief)).toContain('【说明】README.md')
    const direct = await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })
    expect(direct.body.note).toBe(scan.body.note)
    expect(direct.body.brief).toBe(scan.body.brief)
    expect(direct.body.sources).toEqual(scan.body.sources)
  })

  it('几个像的:不读,note 教她念名字挑、挑中了带 path 来读', async () => {
    const fx = await serve()
    await toProjects(fx)
    await allowRead(fx)
    repoAt(join(fx.gh, 'workbench-notes'), { 'README.md': '# 笔记\n' })
    const got = await post(fx.url, '/onboarding/scan', { name: 'workbench' })
    expect((got.body.located as unknown[]).length).toBe(2)
    expect(got.body.brief).toBeUndefined()
    expect(String(got.body.note)).toContain('POST /onboarding/project-brief')
  })
})

describe('路径白名单', () => {
  it('扫描根外拒;`..` 拒;符号链接跳出扫描根拒;不存在拒;缺 path 拒', async () => {
    const fx = await serve()
    await toProjects(fx)
    await allowRead(fx)
    expect(await post(fx.url, '/onboarding/project-brief', { path: join(fx.box, 'Desktop', 'not-mine') }))
      .toMatchObject({ status: 403, body: { reason: 'outside' } })
    expect(await post(fx.url, '/onboarding/project-brief', { path: `${fx.gh}/Aiboo/../desktop-workbench` }))
      .toMatchObject({ status: 400, body: { reason: 'dotdot' } })
    expect(await post(fx.url, '/onboarding/project-brief', { path: join(fx.gh, 'evil-link') }))
      .toMatchObject({ status: 403, body: { reason: 'outside' } })
    expect(await post(fx.url, '/onboarding/project-brief', { path: join(fx.gh, 'nope') }))
      .toMatchObject({ status: 404, body: { reason: 'missing' } })
    expect(await post(fx.url, '/onboarding/project-brief', {}))
      .toMatchObject({ status: 400, body: { reason: 'invalid' } })
  })

  it('这一次按路径找到过的(扫描根外)认;项目区录过的认', async () => {
    const fx = await serve()
    await toProjects(fx)
    await allowRead(fx)
    // 扫描根外的:没找过之前拒。
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.outside })).status).toBe(403)
    // 他报了路径,按路径找到了 —— 只找到一个,顺手就读了。
    const located = await post(fx.url, '/onboarding/scan', { name: fx.outside })
    expect(located.body.located).toEqual([{ name: 'side-project', path: fx.outside }])
    expect(String(located.body.brief)).toContain('一个卖手作的小网站。')
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.outside })).status).toBe(200)

    // 项目区录过的:换一台刚起的服务(没找过),照样认。
    const fresh = await serve()
    await fresh.authorization.set('read_scan_roots', '可以', '2026-09-24')
    await (fresh.projects.adopt as NonNullable<typeof fresh.projects.adopt>)({ name: '副业', path: fresh.outside })
    expect((await post(fresh.url, '/onboarding/project-brief', { path: fresh.outside })).status).toBe(200)
  })
})

describe('扫描进度:读的那一段也算', () => {
  it('读的时候 phase:read、current 是项目名;读完 scanning:false、留 last_read', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const real = nodeBriefIo()
    const slow: BriefIo = { ...real, exec: async (args, cwd, ms) => { await gate; return await real.exec(args, cwd, ms) } }
    const fx = await serve({ io: slow })
    await toProjects(fx)
    await allowRead(fx)
    const pending = post(fx.url, '/onboarding/project-brief', { path: fx.workbench })
    let seen: Record<string, unknown> = {}
    for (let i = 0; i < 50 && seen.phase !== 'read'; i++) {
      seen = await getJson(fx.url, '/onboarding/scan/status')
      if (seen.phase !== 'read') await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(seen).toMatchObject({ scanning: true, phase: 'read', current: 'desktop-workbench' })
    expect((await getJson(fx.url, '/onboarding/turns')).scan).toMatchObject({ phase: 'read', current: 'desktop-workbench' })
    release()
    expect((await pending).status).toBe(200)
    const after = await getJson(fx.url, '/onboarding/scan/status')
    expect(after).toMatchObject({ scanning: false, last_read: 'desktop-workbench' })
    expect(after.phase).toBeUndefined()
    expect(after.finished_at).toBeDefined()
  })
})

describe('只读', () => {
  it('读项目不写项目区缓存(projects.json 不出现)、不刷被读仓库的索引、记忆仓库一个字不动', async () => {
    const fx = await serve()
    await toProjects(fx)
    await allowRead(fx)
    const index = join(fx.workbench, '.git', 'index')
    const before = statSync(index).mtimeMs
    const gitFiles = readdirSync(join(fx.workbench, '.git')).sort()
    const memoryHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.memory }).toString()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })).status).toBe(200)
    expect((await post(fx.url, '/onboarding/scan', { name: '工作台' })).status).toBe(200)
    expect(existsSync(fx.projectsFile)).toBe(false)
    expect(statSync(index).mtimeMs).toBe(before)
    expect(readdirSync(join(fx.workbench, '.git')).sort()).toEqual(gitFiles)
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.memory }).toString()).toBe(memoryHead)
  })
})

/** 数得出调了几次的 I/O(底下是真读,钟拨得动)。2026-09-24 下午小修「别读两遍」用。 */
function countingIo(clock: { ms: number }) {
  const real = nodeBriefIo()
  const calls = { n: 0 }
  const io: BriefIo = {
    readFile: async (path) => { calls.n += 1; return await real.readFile(path) },
    listDir: async (dir) => { calls.n += 1; return await real.listDir(dir) },
    realpath: async (path) => { calls.n += 1; return await real.realpath(path) },
    exec: async (args, cwd, ms) => { calls.n += 1; return await real.exec(args, cwd, ms) },
    now: () => clock.ms,
  }
  return { io, calls }
}

describe('别读两遍(2026-09-24 下午小修):同一个 path 60 秒内直接回上一份', () => {
  it('找到时顺手读过,紧接着又 project-brief 同一个:不再调 io、回同一份;日志注明「用刚才读的」', async () => {
    const clock = { ms: NOW_SEC * 1000 }
    const { io, calls } = countingIo(clock)
    const fx = await serve({ io })
    await toProjects(fx)
    await allowRead(fx)
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    try {
      const scan = await post(fx.url, '/onboarding/scan', { name: '工作台' })
      expect(scan.status).toBe(200)
      const afterFirst = calls.n
      expect(afterFirst).toBeGreaterThan(0)
      clock.ms += 59_000
      const again = await post(fx.url, '/onboarding/project-brief', { path: `${fx.workbench}/` })
      expect(again.status).toBe(200)
      expect(calls.n).toBe(afterFirst)
      expect(again.body).toMatchObject({ ok: true, name: 'desktop-workbench', path: fx.workbench, note: BRIEF_NOTE })
      expect(again.body.brief).toBe(scan.body.brief)
      expect(again.body.sources).toEqual(scan.body.sources)
      const lines = logs.filter(line => line.startsWith('[引导] 读项目 desktop-workbench → '))
      expect(lines).toHaveLength(2)
      expect(lines[0]).not.toContain('用刚才读的')
      expect(lines[1]).toContain('用刚才读的')
      expect(lines[1]).toContain('59 秒前读的')
    }
    finally { spy.mockRestore() }
  })

  it('过了 60 秒重读一遍;不同的 path 各读各的', async () => {
    const clock = { ms: NOW_SEC * 1000 }
    const { io, calls } = countingIo(clock)
    const fx = await serve({ io })
    await toProjects(fx)
    await allowRead(fx)
    const aiboo = join(fx.gh, 'Aiboo')
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })).status).toBe(200)
    const first = calls.n
    clock.ms += 60_000
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })).status).toBe(200)
    const reread = calls.n
    expect(reread).toBeGreaterThan(first)

    const other = await post(fx.url, '/onboarding/project-brief', { path: aiboo })
    expect(other.status).toBe(200)
    expect(String(other.body.brief)).toContain('桌面宠物。')
    const afterOther = calls.n
    expect(afterOther).toBeGreaterThan(reread)
    expect((await post(fx.url, '/onboarding/project-brief', { path: aiboo })).body.name).toBe('Aiboo')
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })).body.name).toBe('desktop-workbench')
    expect(calls.n).toBe(afterOther)
  })

  it('门照旧每次都过:读过之后授权收回 → 403,不回上一份', async () => {
    const fx = await serve()
    await toProjects(fx)
    await allowRead(fx)
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })).status).toBe(200)
    await fx.authorization.set('read_scan_roots', '不可以', '2026-09-24')
    const got = await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })
    expect(got.status).toBe(403)
    expect(got.body.brief).toBeUndefined()
  })
})

describe('出处写对(2026-09-24 下午小修):读过、他点头之后记的那几句', () => {
  const RECAP = '找到了,就是工作台。我读了说明和最近的交接。它是给不会写代码的半专业个体用的事务官,现在 0.2.80 已装好,是这个吗?'
  const VALUE = { name: '工作台', one_liner: '给不会写代码的半专业个体用的事务官', status: '0.2.80 已装好,停在 ②′ 项目', next_step: '电话引导要能读仓库' }
  const projectFile = (fx: Fx): string => readFileSync(join(fx.memory, 'docs', '记忆', '项目', '工作台.md'), 'utf8')

  it('找到时读过 → 带着他那句「对」记 → 一句话 / 进展 / 下一步标「读仓库说明,Ben确认」', async () => {
    const fx = await serve()
    await toProjects(fx)
    await allowRead(fx)
    expect((await post(fx.url, '/onboarding/scan', { name: '工作台' })).status).toBe(200)
    const got = await post(fx.url, '/onboarding/answer', {
      stage: 'projects', key: 'project', value: { ...VALUE, path: fx.workbench }, heard: { asked: RECAP, reply: '对' },
    })
    expect(got.status).toBe(200)
    const file = projectFile(fx)
    expect(file).toContain('- **一句话**:给不会写代码的半专业个体用的事务官(读仓库说明,Ben确认,2026-09-24)')
    expect(file).toContain('- 2026-09-24:0.2.80 已装好,停在 ②′ 项目(读仓库说明,Ben确认,2026-09-24)')
    expect(file).toMatch(/## 下一步\n- 电话引导要能读仓库\(读仓库说明,Ben确认,2026-09-24\)/)
    expect(file).not.toContain('口述')
  })

  it('他确认时改了说法 → 仍是「引导访谈,Ben口述」', async () => {
    const fx = await serve()
    await toProjects(fx)
    await allowRead(fx)
    expect((await post(fx.url, '/onboarding/scan', { name: '工作台' })).status).toBe(200)
    const got = await post(fx.url, '/onboarding/answer', {
      stage: 'projects', key: 'project', value: { ...VALUE, one_liner: '现在只有我自己在用的事务官', path: fx.workbench },
      heard: { asked: RECAP, reply: '差不多,不过现在只有我自己在用' },
    })
    expect(got.status).toBe(200)
    expect(projectFile(fx)).toContain('- **一句话**:现在只有我自己在用的事务官(引导访谈,Ben口述,2026-09-24)')
    expect(projectFile(fx)).not.toContain('读仓库说明')
  })

  it('没读过(这一次没找没读)→ 仍是「引导访谈,Ben口述」', async () => {
    const fx = await serve()
    await toProjects(fx)
    const got = await post(fx.url, '/onboarding/answer', {
      stage: 'projects', key: 'project', value: { ...VALUE, path: fx.workbench },
      heard: { asked: '这个工作台是做什么的,给谁用?', reply: '给不会写代码的半专业个体用的事务官' },
    })
    expect(got.status).toBe(200)
    expect(projectFile(fx)).toContain('- **一句话**:给不会写代码的半专业个体用的事务官(引导访谈,Ben口述,2026-09-24)')
  })
})

describe('改口重问别说过程话(2026-09-24 下午小修):两条路拿到的 note', () => {
  it('没授权(403)与读好了(200),scan 与 project-brief 回的 note 里都没有「再问一遍」', async () => {
    const fx = await serve()
    await toProjects(fx)
    const notes: unknown[] = []
    for (const got of [
      await post(fx.url, '/onboarding/scan', { name: '工作台' }),
      await post(fx.url, '/onboarding/project-brief', { path: fx.workbench }),
    ]) {
      expect(got.status).toBe(403)
      notes.push(got.body.note)
    }
    await allowRead(fx)
    for (const got of [
      await post(fx.url, '/onboarding/scan', { name: '工作台' }),
      await post(fx.url, '/onboarding/project-brief', { path: fx.workbench }),
    ]) {
      expect(got.status).toBe(200)
      notes.push(got.body.note)
    }
    expect(notes).toEqual([READ_CONSENT_NOTE, READ_CONSENT_NOTE, BRIEF_NOTE, BRIEF_NOTE])
    for (const note of notes) {
      expect(String(note)).not.toContain('再问一遍')
      expect(String(note)).toContain('直接照')
    }
  })
})

describe('没接读项目(老接线)', () => {
  it('project-brief 503;scan 只找到一个时照老样子只回名字与路径', async () => {
    const fx = await serve({ brief: false })
    await toProjects(fx)
    await allowRead(fx)
    expect((await post(fx.url, '/onboarding/project-brief', { path: fx.workbench })).status).toBe(503)
    const scan = await post(fx.url, '/onboarding/scan', { name: '工作台' })
    expect(scan.body.brief).toBeUndefined()
    expect(String(scan.body.note)).toContain('project.path')
    expect(String(scan.body.note)).not.toContain('project-brief')
  })
})

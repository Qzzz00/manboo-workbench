// @vitest-environment node
/**
 * 项目数据源(2026-09-21「项目区的数据来源从 git 换成账号」那张卡)。
 *
 * 三组:
 *   ① git 那一支**一字没改** —— 同一批假 exec 喂进去,拼出来的东西与从前逐字相同;
 *   ② 账号那一支:列账号、拼「算」行要的数、展开那几行;
 *   ③ 换数据源之后,合并层(projectsService)照样把 projects.json 里人写的状态对上。
 *
 * 第 ③ 组是这张卡最容易出事的地方:换数据源**不该**顺手换掉"人写的状态存在哪儿"。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountSource } from '../src/server/accountSource.ts'
import { createGitSource } from '../src/server/gitSource.ts'
import { createProjectsService } from '../src/server/projectsService.ts'
import { emptyProjectsFile, saveProjectsFile } from '../src/server/projects.ts'
import { writeAccount } from '../src/server/accounts.ts'
import type { ProjectSource } from '../src/server/projectSource.ts'
import { PRODUCT_TEMPLATE } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const NOW = Math.floor(Date.parse('2026-09-21T02:00:00Z') / 1000)

let work = ''
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'wb-src-')) })
afterEach(async () => { await rm(work, { recursive: true, force: true }) })

/** 与 tests/server-projects.test.ts 那一份逐字相同的假 git —— 换了数据源,答案必须一样。 */
const fakeExec = async (args: readonly string[]): Promise<{ ok: boolean, stdout: string }> =>
  args[0] === 'rev-parse'
    ? { ok: true, stdout: 'main\n' }
    : args[0] === 'log' ? { ok: true, stdout: '2026-08-18T00:00:00Z\n' } : { ok: true, stdout: '' }

function gitSource(): ProjectSource {
  return createGitSource({
    exec: fakeExec,
    listDir: async (d: string) => (d === '/roots/gh' ? ['/roots/gh/Aiboo', '/roots/gh/Zzz'] : []),
    isRepo: async (d: string) => d.startsWith('/roots/gh/'),
    scanRoots: async () => [{ path: '/roots/gh', depth: 1 }],
    recentDays: 14,
    now: () => NOW,
  })
}

// ───────────────────────────────────────────────────────────────────────────
describe('① git 数据源:搬家之后一个字没变', () => {
  it('list() 回的是扫描根下的仓库,而且按路径排过序(顺序一漂 id 消歧就跟着漂)', async () => {
    expect(await gitSource().list()).toEqual({ paths: ['/roots/gh/Aiboo', '/roots/gh/Zzz'], scan_errors: [] })
  })

  it('一个根读不出来只记那个根的错,别的根照常(D13)', async () => {
    const source = createGitSource({
      exec: fakeExec,
      listDir: async (d: string) => { if (d === '/坏根') throw new Error('EACCES'); return d === '/roots/gh' ? ['/roots/gh/Aiboo'] : [] },
      isRepo: async (d: string) => d === '/roots/gh/Aiboo',
      scanRoots: async () => [{ path: '/坏根', depth: 1 }, { path: '/roots/gh', depth: 1 }],
      recentDays: 14,
      now: () => NOW,
    })
    const listed = await source.list()
    expect(listed.paths).toEqual(['/roots/gh/Aiboo'])
    expect(listed.scan_errors[0]?.root).toBe('/坏根')
    expect(listed.scan_errors[0]?.reason).toContain('EACCES')
  })

  it('summary() 拼出来的 RepoSignals 与从前逐字相同', async () => {
    const summary = await gitSource().summary('/roots/gh/Aiboo', 'aiboo')
    expect(summary.kind).toBe('repo')
    if (summary.kind !== 'repo') throw new Error('unreachable')
    expect(summary.signals).toEqual({
      branch: 'main',
      dirty_count: 0,
      worktrees: 0,
      cleanup_count: 0,
      idle_days: 34,
      last_commit_at: '2026-08-18T00:00:00Z',
      recent_commits: 0,
    })
    expect(summary.last_activity_at).toBe('2026-08-18T00:00:00Z')
    // 34 天没提交 —— 既有口径(>= 7 天)算闲置。
    expect(summary.idle_candidate).toBe(true)
  })

  it('git rev-parse 失败 → 这一条是「未接入」,不拖垮整批', async () => {
    const source = createGitSource({
      exec: async () => ({ ok: false, stdout: '' }),
      listDir: async () => [],
      isRepo: async () => false,
      scanRoots: async () => [],
      recentDays: 14,
      now: () => NOW,
    })
    const summary = await source.summary('/r/x', 'x')
    expect(summary).toEqual({ kind: 'error', error: 'git rev-parse 失败', idle_candidate: false })
  })

  it('detail() 是空的 —— **故意的**:展开那两行(零散 / DDL)来自 projects.json,不是数据源的事', async () => {
    expect(await gitSource().detail('/roots/gh/Aiboo')).toEqual([])
  })

  it('会话归属这一层对 git 数据源是开着的', () => {
    expect(gitSource().attributes_sessions).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
function accountSource(over: Partial<Parameters<typeof createAccountSource>[0]> = {}): ProjectSource {
  return createAccountSource({ workdir: () => work, now: () => NOW, ...over })
}

describe('② 账号数据源', () => {
  it('一个账号一个文件夹,按名字列出来', async () => {
    await writeAccount(work, { name: '小食堂', fields: { 平台: '小红书' } }, { date: '2026-09-21', origin: '引导' })
    await writeAccount(work, { name: '深夜书桌', fields: { 平台: '公众号' } }, { date: '2026-09-21', origin: '引导' })
    const listed = await accountSource().list()
    expect(listed.paths).toEqual([join(work, '账号', '小食堂'), join(work, '账号', '深夜书桌')])
    expect(listed.scan_errors).toEqual([])
  })

  it('还没有账号文件夹 = 空列表,**不是**一条错误', async () => {
    expect(await accountSource().list()).toEqual({ paths: [], scan_errors: [] })
  })

  it('没配工作目录:**如实回一条错**,不静悄悄地回空(那会让界面说「还没有账号」—— 假话)', async () => {
    const listed = await accountSource({ workdir: () => undefined }).list()
    expect(listed.paths).toEqual([])
    expect(listed.scan_errors[0]?.reason).toContain('还没配工作目录')
  })

  it('summary():平台 / 最近一条笔记的日期 / 笔记条数', async () => {
    await writeAccount(work, { name: '小食堂', fields: { 平台: '小红书', 开号日期: '2025-03' } }, { date: '2026-09-21', origin: '引导' })
    const dir = join(work, '账号', '小食堂')
    await writeFile(join(dir, '笔记', '2026-09-18-番茄面.md'), 'x', 'utf8')
    await writeFile(join(dir, '笔记', '2026-09-20-煎蛋.md'), 'x', 'utf8')
    const source = accountSource()
    await source.list()
    const summary = await source.summary(dir, '小食堂')
    expect(summary.kind).toBe('account')
    if (summary.kind !== 'account') throw new Error('unreachable')
    expect(summary.account).toEqual({
      platform: '小红书',
      opened_at: '2025-03',
      note_count: 2,
      last_note_at: '2026-09-20',
      idle_days: 1,
    })
  })

  it('没接看板时 open_tasks **整个缺席**(不是 0)——「一件都没有」和「数不出来」是两回事', async () => {
    await writeAccount(work, { name: '小食堂', fields: { 平台: '小红书' } }, { date: '2026-09-21', origin: '引导' })
    const source = accountSource()
    await source.list()
    const summary = await source.summary(join(work, '账号', '小食堂'), '小食堂')
    if (summary.kind !== 'account') throw new Error('unreachable')
    expect('open_tasks' in summary.account).toBe(false)
  })

  it('接了看板就按**项目 id** 取在办事项数;那个 id 名下一件都没有才是 0', async () => {
    await writeAccount(work, { name: '小食堂', fields: {} }, { date: '2026-09-21', origin: '引导' })
    const source = accountSource({ openTasks: async () => new Map([['小食堂', 3]]) })
    await source.list()
    const hit = await source.summary(join(work, '账号', '小食堂'), '小食堂')
    const miss = await source.summary(join(work, '账号', '小食堂'), '别的 id')
    if (hit.kind !== 'account' || miss.kind !== 'account') throw new Error('unreachable')
    expect(hit.account.open_tasks).toBe(3)
    expect(miss.account.open_tasks).toBe(0)
  })

  it('一条笔记都没有:note_count 0、没有日期、没有 idle_days(不是 0 —— 那会显示成「今天有笔记」)', async () => {
    await writeAccount(work, { name: '新号', fields: { 平台: '抖音' } }, { date: '2026-09-21', origin: '引导' })
    const source = accountSource()
    await source.list()
    const summary = await source.summary(join(work, '账号', '新号'), '新号')
    if (summary.kind !== 'account') throw new Error('unreachable')
    expect(summary.account.note_count).toBe(0)
    expect(summary.account.last_note_at).toBeUndefined()
    expect(summary.account.idle_days).toBeUndefined()
    expect(summary.last_activity_at).toBeUndefined()
  })

  it('账号**永远不进闲置线** —— 刚建出来、一条笔记都没有的号不许被折成一行灰字', async () => {
    await writeAccount(work, { name: '新号', fields: {} }, { date: '2026-09-21', origin: '引导' })
    const source = accountSource()
    await source.list()
    const summary = await source.summary(join(work, '账号', '新号'), '新号')
    expect(summary.idle_candidate).toBe(false)
  })

  it('detail():账号.md 里写了的那几项,按文件里的顺序;**没写的不出现**', async () => {
    await writeAccount(
      work,
      { name: '小食堂', fields: { 定位: '一个人做饭', 平台: '小红书' } },
      { date: '2026-09-21', origin: '引导' },
    )
    expect(await accountSource().detail(join(work, '账号', '小食堂'))).toEqual([
      { label: '定位', text: '一个人做饭' },
      { label: '平台', text: '小红书' },
    ])
  })

  it('账号数据源不参与会话归属 —— 账号文件夹里不会有人开编码会话', () => {
    expect(accountSource().attributes_sessions).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('③ 合并层:换了数据源,人写的状态照样对得上', () => {
  async function serviceWith(source: ProjectSource, file: string) {
    return createProjectsService({
      file,
      exec: fakeExec,
      listDir: async () => [],
      isRepo: async () => false,
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => NOW,
      scanRoots: [],
      source: () => source,
    })
  }

  it('账号出现在项目区里,名字就是文件夹名,「算」行的数从账号数据源来', async () => {
    await writeAccount(work, { name: '小食堂', fields: { 平台: '小红书' } }, { date: '2026-09-21', origin: '引导' })
    const service = await serviceWith(accountSource(), join(work, 'projects.json'))
    const state = await service.getProjectsState()
    expect(state.projects.map(p => p.name)).toEqual(['小食堂'])
    expect(state.projects[0]?.account?.platform).toBe('小红书')
    expect(state.projects[0]?.signals).toBeUndefined()
    // 账号不进闲置线,所以它真的在列表里(不是被折进末尾那一行)。
    expect(state.projects[0]?.idle).toBe(false)
  })

  it('projects.json 里人写的状态、DDL、零散照样挂上来(合并层一个字没换)', async () => {
    await writeAccount(work, { name: '小食堂', fields: {} }, { date: '2026-09-21', origin: '引导' })
    const file = join(work, 'projects.json')
    const data = emptyProjectsFile()
    data.projects.push({
      id: '小食堂',
      name: '我的小食堂',
      stage: 'MVP 开发',
      repoPath: join(work, '账号', '小食堂'),
      links: ['一条零散'],
      status: { text: '这周补三条', review: 'confirmed', author: '你', updated_at: '2026-09-20T00:00:00Z' },
      ddl: { date: '2026-10-01', title: '国庆专题' },
    })
    await saveProjectsFile(file, data)
    const state = await (await serviceWith(accountSource(), file)).getProjectsState()
    expect(state.projects[0]?.name).toBe('我的小食堂')
    expect(state.projects[0]?.status?.text).toBe('这周补三条')
    expect(state.projects[0]?.ddl?.title).toBe('国庆专题')
    expect(state.projects[0]?.links).toEqual(['一条零散'])
  })

  it('账号数据源下「待归档」恒为空 —— 不把这台机器上所有编码会话都聚过来', async () => {
    await writeAccount(work, { name: '小食堂', fields: {} }, { date: '2026-09-21', origin: '引导' })
    const service = createProjectsService({
      file: join(work, 'projects.json'),
      exec: fakeExec,
      listDir: async () => [],
      isRepo: async () => false,
      codexHome: '/x',
      // 有一堆会话躺着,但账号数据源不认领也不聚类。
      codexDeps: {
        listFiles: async () => ['/x/a.jsonl'],
        readFirstLine: async () => JSON.stringify({ cwd: '/Users/example/Documents/GitHub/随便', timestamp: '2026-09-20T00:00:00Z' }),
      },
      home: '/Users/example',
      now: () => NOW,
      scanRoots: [],
      source: () => accountSource(),
    })
    const state = await service.getProjectsState()
    expect(state.pending).toEqual([])
    expect(state.projects[0]?.session_count).toBe(0)
  })

  it('不传 source 就是 git(现状)—— 老接线一个字都不用改', async () => {
    const service = createProjectsService({
      file: join(work, 'projects.json'),
      exec: fakeExec,
      listDir: async (d: string) => (d === '/roots/gh' ? ['/roots/gh/Aiboo'] : []),
      isRepo: async (d: string) => d === '/roots/gh/Aiboo',
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => NOW,
      scanRoots: [{ path: '/roots/gh', depth: 1 }],
    })
    const state = await service.getProjectsState()
    expect(state.projects[0]?.signals?.branch).toBe('main')
    expect(state.projects[0]?.account).toBeUndefined()
  })
})

describe('④ 模板上那个字段真的有人读', () => {
  it('两个模板各自说清自己的数据源', () => {
    expect(PRODUCT_TEMPLATE.project_source).toBe('git')
    expect(OPS_TEMPLATE.project_source).toBe('accounts')
  })

  it('运营模板建的第一个文件夹就是账号数据源要读的那个 —— 两处说的是同一件事', async () => {
    await mkdir(join(work, '账号'), { recursive: true })
    expect(OPS_TEMPLATE.folders[0]?.rel).toBe('账号')
    expect((await accountSource().list()).scan_errors).toEqual([])
  })
})

// @vitest-environment node
/**
 * 「记错了随时能改」与「排一个方案念给他听」(2026-09-20)。
 *
 * 来历是 Ben 真机那通引导(10:47–10:54)的两条:
 *   - 他说「我叫本,不是 Java」,阶段机回 409「现在在② 分岔,不能答① 开场的问题」,
 *     她只好说「这个名字的改动我这会儿没能记上」。Ben:「这对用户来说可能就已经跑了」。
 *   - 她连问八题、每答一条记一条,从头到尾没有替他排过一次时间。
 *
 * 守住的东西:
 *   ① 已经答过的任何一项**随时能改**,哪怕阶段早就走过去了,哪怕引导已经做完;
 *   ② 改称呼要把**已经写下的那份记忆**一起改(文件名、标题、AGENTS.md 的标记段),
 *      而且**不删文件**(git mv,或者留一行指路);
 *   ③ 改不**推进阶段**;没答过的不走这条(回 404 并把出路说清);
 *   ④ 方案 `confirmed` 为真才落成事项 —— 没点头一条都不建。
 *
 * 全部在临时目录里跑,**不碰 ~/.dsh 真身**。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { readMarkedBlock } from '../src/server/memoryMd.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingService, isoDateIn } from '../src/server/onboarding.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { FULL_PLAN } from '../src/server/onboardingStages.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

interface Fixture {
  repo: string
  agentsFile: string
  service: OnboardingService
  tasks: () => unknown[]
  read: (relative: string) => string
  has: (relative: string) => boolean
  commits: () => string[]
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-correct-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'docs', '记忆', '项目', '索引.md'), '# 项目索引\n\n| 项目 | 一句话 | 阶段 | 最近活动 | 路径 | 文件 |\n|---|---|---|---|---|---|\n')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')

  const agentsFile = join(root, 'dsh', 'AGENTS.md')
  mkdirSync(join(root, 'dsh'), { recursive: true })
  writeFileSync(agentsFile, '# 事务官\n\n纪律(写死):\n- 不编数。\n')
  const tasksFile = join(root, 'workbench', 'tasks.json')

  let tick = 0
  const tasks = createTasksService({ file: tasksFile, newId: () => `t-${(tick += 1)}` })
  const service = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'workbench', 'onboarding.json'),
    repoRoot: repo,
    agentsFile,
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    tasks,
    now: () => new Date(Date.UTC(2026, 8, 20, 2, 0, tick++)),
  })
  await service.load()
  return {
    repo,
    agentsFile,
    service,
    tasks: () => (existsSync(tasksFile) ? (JSON.parse(readFileSync(tasksFile, 'utf8')) as { tasks?: unknown[] }).tasks ?? [] : []),
    read: relative => readFileSync(join(repo, relative), 'utf8'),
    has: relative => existsSync(join(repo, relative)),
    commits: () => git(repo, 'log', '--format=%s').trim().split('\n'),
  }
}

async function ok(service: OnboardingService, stage: string, key: string, value: unknown) {
  const result = await service.answer({ stage, key, value })
  if (!result.ok) throw new Error(`answer ${stage}.${key} 失败:${result.error}`)
  return result
}

describe('改一项已经答过的', () => {
  it('Ben 那一条:称呼记成「Java」,走到② 分岔之后照样改得回「本」', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', 'Java')
    expect(f.service.detail().stage).toBe('branch')
    expect(f.has('docs/记忆/用户-Java.md')).toBe(true)

    // 早上那次走的是 answer —— 它现在仍然 409(阶段机的规矩没松),但**出路存在了**。
    const refused = await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    expect(refused.ok).toBe(false)

    const fixed = await f.service.correct({ stage: 'opening', key: 'nickname', value: '本' })
    expect(fixed.ok).toBe(true)
    if (!fixed.ok) return
    expect(fixed.stage).toBe('opening')
    // **阶段不倒回去**:人还在② 分岔上站着。
    expect(fixed.current).toBe('branch')
    expect(f.service.detail().stage).toBe('branch')
    expect(f.service.detail().nickname).toBe('本')
  })

  it('改称呼连记忆文件一起改:新文件在、标题改了、旧文件没了(git mv,历史留着)', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', 'Java')
    // 用户自己在文件里写过的东西,改名之后一个字都不能丢。
    const before = f.read('docs/记忆/用户-Java.md')
    writeFileSync(join(f.repo, 'docs', '记忆', '用户-Java.md'), `${before}\n## 自述\n- 我做的是一个桌面工作台。\n`)

    const fixed = await f.service.correct({ stage: 'opening', key: 'nickname', value: '本' })
    expect(fixed.ok).toBe(true)
    if (!fixed.ok) return
    expect(fixed.also).toContain('用户-Java.md')
    expect(fixed.also).toContain('用户-本.md')

    expect(f.has('docs/记忆/用户-本.md')).toBe(true)
    expect(f.has('docs/记忆/用户-Java.md')).toBe(false)
    const after = f.read('docs/记忆/用户-本.md')
    expect(after).toContain('# 用户:本')
    expect(after).not.toContain('# 用户:Java')
    expect(after).toContain('我做的是一个桌面工作台')
    // git 里看得出来这是一次改名(内容没丢)。
    expect(git(f.repo, 'log', '--format=%s').split('\n')[0]).toContain('更正')
  })

  it('AGENTS.md 的标记段里那行称呼跟着改,标记段以外一个字不动', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', 'Java')
    await ok(f.service, 'branch', 'mode', 'fresh')
    await ok(f.service, 'template', 'template', 'product')
    await ok(f.service, 'projects', 'idea', {
      name: '晨读机', one_liner: '给小学生的晨读播放器', problem: '家长早上没空陪读',
      assets: '一个点子', first_step: '先访谈 5 位家长', stage: '市场调研',
    })
    await ok(f.service, 'authorization', 'write_docs', 'ask')
    await ok(f.service, 'authorization', 'write_commit', true)
    await ok(f.service, 'authorization', 'write_api', false)
    await ok(f.service, 'authorization', 'read_client_files', 'ask')
    await ok(f.service, 'habits', 'done', true)
    await ok(f.service, 'persona', 'persona', '周到')
    await ok(f.service, 'persona', 'candor', 4)
    await ok(f.service, 'persona', 'verbosity', 3)
    const styled = readMarkedBlock(readFileSync(f.agentsFile, 'utf8'), '说话方式') as string
    expect(styled).toContain('叫他「Java」')

    await f.service.correct({ stage: 'opening', key: 'nickname', value: '本' })
    const agents = readFileSync(f.agentsFile, 'utf8')
    expect(readMarkedBlock(agents, '说话方式')).toContain('叫他「本」')
    expect(readMarkedBlock(agents, '说话方式')).not.toContain('Java')
    // 标记段以外(Ben 自己写的那几行)原样。
    expect(agents).toContain('- 不编数。')
  })

  it('没答过的不走这条:404,并且把「改调 answer」说出来', async () => {
    const f = await fixture()
    const missed = await f.service.correct({ stage: 'opening', key: 'nickname', value: '本' })
    expect(missed.ok).toBe(false)
    if (missed.ok) return
    expect(missed.status).toBe(404)
    expect(missed.error).toContain('/onboarding/answer')
  })

  it('坏 stage / 坏 key / 坏值都 400,回的是人话', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', 'Java')
    const badStage = await f.service.correct({ stage: '没这个阶段', key: 'nickname', value: '本' })
    expect(badStage.ok === false && badStage.status).toBe(400)
    const badKey = await f.service.correct({ stage: 'opening', key: '没这个键', value: '本' })
    expect(badKey.ok === false && badKey.status).toBe(400)
    const badValue = await f.service.correct({ stage: 'opening', key: 'nickname', value: '../坏名字' })
    expect(badValue.ok === false && badValue.status).toBe(400)
  })

  it('引导做完了也能改 —— 「称呼记错了」不会因为做完就不算数', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', 'Java')
    await ok(f.service, 'branch', 'mode', 'fresh')
    await ok(f.service, 'template', 'template', 'product')
    await ok(f.service, 'projects', 'idea', {
      name: '晨读机', one_liner: '给小学生的晨读播放器', problem: '家长早上没空陪读',
      assets: '一个点子', first_step: '先访谈 5 位家长', stage: '市场调研',
    })
    await ok(f.service, 'authorization', 'write_docs', 'ask')
    await ok(f.service, 'authorization', 'write_commit', true)
    await ok(f.service, 'authorization', 'write_api', false)
    await ok(f.service, 'authorization', 'read_client_files', 'ask')
    await ok(f.service, 'habits', 'done', true)
    await ok(f.service, 'persona', 'persona', '沉稳')
    await ok(f.service, 'persona', 'candor', 3)
    await ok(f.service, 'persona', 'verbosity', 2)
    await ok(f.service, 'naming', 'butler_name', '小管')
    await ok(f.service, 'wrapup', 'morning_report', true)
    await ok(f.service, 'wrapup', 'evening_routine', '18:30')
    await ok(f.service, 'wrapup', 'first_item', '先访谈 5 位家长')
    expect(f.service.detail().done).toBe(true)

    // answer 在 done 之后一律 409,correct 照样走得通。
    const refused = await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    expect(refused.ok).toBe(false)
    const fixed = await f.service.correct({ stage: 'opening', key: 'nickname', value: '本' })
    expect(fixed.ok).toBe(true)
    expect(f.service.detail().nickname).toBe('本')
    expect(f.service.detail().done).toBe(true)
  })

  it('改的不只是称呼:别的阶段的项也能改,而且不重复推进', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', '本')
    await ok(f.service, 'branch', 'mode', 'existing')
    await ok(f.service, 'template', 'template', 'product')
    const fixed = await f.service.correct({ stage: 'branch', key: 'mode', value: 'fresh' })
    expect(fixed.ok).toBe(true)
    expect(f.service.detail().mode).toBe('fresh')
    expect(f.service.detail().stage).toBe('projects')
  })
})

/**
 * 2026-09-20 本机真跑之后补的:模型在电话里一路把 stage 写成上一段的名字
 * (`branch.read_scan_roots → 409`、`opening.read_scan_roots → 409`),而那几项明明就是
 * **当前这一段**能写的。阶段名是我们的记账方式,不是他答的内容。
 */
describe('认 key,不认标签', () => {
  it('key 属于当前这一段:照收,并在 note 里如实说一句', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', '本')
    await ok(f.service, 'branch', 'mode', 'existing')
    await ok(f.service, 'template', 'template', 'product')
    // 现在在②′ 项目,模型却把 stage 写成了 branch。
    const result = await f.service.answer({ stage: 'branch', key: 'read_scan_roots', value: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.note).toContain('read_scan_roots')
    expect(result.note).toContain('②′')
    expect(f.service.detail().answered.projects).toContain('read_scan_roots')
  })

  it('key 是前面某一段记过的:409,**并且把 /onboarding/correct 写进错误里**', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', 'Java')
    await ok(f.service, 'branch', 'mode', 'existing')
    await ok(f.service, 'template', 'template', 'product')
    const blocked = await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.status).toBe(409)
    expect(blocked.error).toContain('/onboarding/correct')
    expect(blocked.error).toContain('阶段不会倒回去')
  })

  it('key 哪一段都不认:409,把「这一段能写什么」说出来', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', '本')
    const blocked = await f.service.answer({ stage: 'habits', key: 'music', value: '周杰伦' })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.status).toBe(409)
    expect(blocked.error).toContain('这一段能写的是')
    expect(blocked.error).toContain('mode')
  })
})

describe('排一个方案给他确认', () => {
  const plan = {
    project: '工作台',
    confirmed: true,
    items: [
      { title: '把手机形态的软硬件全流程跑通', when: '这两天', why: '别的都压在它后面' },
      { title: '准备参赛材料并报名', when: '10 月 4 日前', why: '报名截止' },
    ],
  }

  async function reachProjects(f: Fixture): Promise<void> {
    await ok(f.service, 'opening', 'nickname', '本')
    await ok(f.service, 'branch', 'mode', 'existing')
    await ok(f.service, 'template', 'template', 'product')
    await ok(f.service, 'projects', 'project', { name: '工作台', one_liner: '帮个体经营者在多个 AI 之间做事' })
  }

  it('他点头了(confirmed=true):方案写进项目文件,并且每条建一个事项', async () => {
    const f = await fixture()
    await reachProjects(f)
    const result = await ok(f.service, 'projects', 'plan', plan)
    expect(result.note).toContain('建了 2 条事项')
    const file = f.read('docs/记忆/项目/工作台.md')
    expect(file).toContain('把手机形态的软硬件全流程跑通')
    expect(file).toContain('10 月 4 日前')
    expect(f.tasks()).toHaveLength(2)
  })

  it('**他还没点头(confirmed=false):一条事项都不建**,但聊到哪了照样记下来', async () => {
    const f = await fixture()
    await reachProjects(f)
    const result = await ok(f.service, 'projects', 'plan', { ...plan, confirmed: false })
    expect(result.note).toContain('没有建事项')
    expect(f.read('docs/记忆/项目/工作台.md')).toContain('把手机形态的软硬件全流程跑通')
    expect(f.tasks()).toHaveLength(0)
  })

  it('confirmed 缺席就 400 —— 「他点没点头」不许靠猜', async () => {
    const f = await fixture()
    await reachProjects(f)
    const bad = await f.service.answer({ stage: 'projects', key: 'plan', value: { project: '工作台', items: plan.items } })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.status).toBe(400)
    expect(bad.error).toContain('confirmed')
  })

  it('空清单、超量、没名字都 400', async () => {
    const f = await fixture()
    await reachProjects(f)
    const empty = await f.service.answer({ stage: 'projects', key: 'plan', value: { project: '工作台', confirmed: true, items: [] } })
    expect(empty.ok === false && empty.status).toBe(400)
    const many = await f.service.answer({
      stage: 'projects',
      key: 'plan',
      value: { project: '工作台', confirmed: true, items: Array.from({ length: 13 }, (_, i) => ({ title: `第 ${i} 条` })) },
    })
    expect(many.ok === false && many.status).toBe(400)
    const nameless = await f.service.answer({ stage: 'projects', key: 'plan', value: { confirmed: true, items: plan.items } })
    expect(nameless.ok === false && nameless.status).toBe(400)
  })

  it('**同一份方案交两次不会建出两套事项** —— 本机真跑里她交了三次,看板上冒出十二条', async () => {
    const f = await fixture()
    await reachProjects(f)
    await ok(f.service, 'projects', 'plan', plan)
    expect(f.tasks()).toHaveLength(2)
    // 她换了个措辞又交了一次,其中一条是新的。
    const again = await ok(f.service, 'projects', 'plan', {
      ...plan,
      items: [...plan.items, { title: '打印件回来就装机验证', when: '到货后' }],
    })
    expect(f.tasks()).toHaveLength(3)
    expect(again.note).toContain('前面已经建过了')
  })

  it('方案落了事项之后,plan 这一项自己也能改(他改主意了)', async () => {
    const f = await fixture()
    await reachProjects(f)
    await ok(f.service, 'projects', 'plan', plan)
    const fixed = await f.service.correct({
      stage: 'projects',
      key: 'plan',
      value: { project: '工作台', confirmed: false, items: [{ title: '先只做报名材料' }], note: '他说硬件先放放' },
    })
    expect(fixed.ok).toBe(true)
    expect(f.read('docs/记忆/项目/工作台.md')).toContain('他说硬件先放放')
    // confirmed=false 的那一次不再多建事项。
    expect(f.tasks()).toHaveLength(2)
  })
})

describe('简报里的日历', () => {
  it('记下截止日之后,简报里就有「离那天还剩几个工作日」', async () => {
    const f = await fixture()
    await ok(f.service, 'opening', 'nickname', '本')
    await ok(f.service, 'branch', 'mode', 'existing')
    await ok(f.service, 'template', 'template', 'product')
    await ok(f.service, 'projects', 'project', { name: '工作台', deadline: '比赛报名 10 月 4 日截止,10 月 6 日公示' })
    const brief = await f.service.brief()
    expect(brief.calendar).toContain('2026-09-20')
    expect(brief.calendar).toContain('国庆节')
    expect(brief.calendar).toContain('工作台 的截止日')
    expect(brief.calendar).toContain('工作日 7 天')
  })

  it('一个截止日都没记过时,日历里照样有今天与接下来的假期', async () => {
    const f = await fixture()
    const brief = await f.service.brief()
    expect(brief.calendar).toContain('今天是 2026-09-20')
    expect(brief.calendar).not.toContain('离「')
  })
})

describe('从人话里抠日期', () => {
  it('认三种带年份的写法', () => {
    expect(isoDateIn('截止 2026-10-04', '2026-09-20')).toBe('2026-10-04')
    expect(isoDateIn('截止 2026/10/4', '2026-09-20')).toBe('2026-10-04')
    expect(isoDateIn('2026年10月4日报名截止', '2026-09-20')).toBe('2026-10-04')
  })

  it('不带年份的按今年;已经过去大半年的按明年', () => {
    expect(isoDateIn('10 月 4 日截止', '2026-09-20')).toBe('2026-10-04')
    expect(isoDateIn('1 月 5 日交付', '2026-09-20')).toBe('2027-01-05')
  })

  it('抠不出来就 undefined —— **不猜一个日期**', () => {
    expect(isoDateIn('下个月底之前', '2026-09-20')).toBeUndefined()
    expect(isoDateIn('无', '2026-09-20')).toBeUndefined()
    expect(isoDateIn(undefined, '2026-09-20')).toBeUndefined()
    expect(isoDateIn('2 月 30 日', '2026-09-20')).toBeUndefined()
  })
})

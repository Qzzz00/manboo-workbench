// @vitest-environment node
/**
 * 引导落地那张卡顺带修的几处(2026-09-24 晚,卡 feat/onboarding-materialize):
 *   - ②′ 按方案建事项:同一件事换个说法又交一遍不重复建;提到的版本比仓库现在旧的(照搬旧交接)不建、如实说;
 *   - 交接摘要里「下一步」提到旧版本的标「可能过时」,她先问他还要不要;仓库现在的版本 = 最近提交标题 + package.json 里最大的那个;
 *   - ④ 常用应用记完回一句「记进窗口槽清单了……别说摆好了」(卡 C 提的);
 *   - 按名字找 Codex 会话:几条都像时挑记录最新的那条,只读。
 * 全部在临时目录里跑,不碰 ~/.dsh、~/.codex。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { findCodexThread, matchThreads, parseSessionIndex } from '../src/server/codexThreads.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { LATE_ANSWER_GRACE_MS, createOnboardingService } from '../src/server/onboarding.ts'
import { handoffExcerpt, nodeBriefIo, projectVersion } from '../src/server/projectBrief.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { FULL_PLAN } from '../src/server/onboardingStages.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
}

async function onboardingAtPlan(options: { version?: string, apps?: boolean } = {}): Promise<{ svc: OnboardingService, tasks: ReturnType<typeof createTasksService>, enabled: string[][] }> {
  const root = temp('wb-ob-materialize-')
  const repo = join(root, 'memory')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  gitInit(repo)
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  let n = 0
  const tasks = createTasksService({ file: join(root, 'tasks.json'), newId: () => `t-${++n}` })
  const enabled: string[][] = []
  const svc = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'),
    repoRoot: repo,
    agentsFile: join(root, 'AGENTS.md'),
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    tasks,
    ...(options.version === undefined ? {} : { version: async () => options.version }),
    ...(options.apps === true
      ? { apps: { known: async () => [{ key: 'claude', label: 'Claude' }, { key: 'codex', label: 'Codex' }, { key: 'wechat', label: '微信' }], enable: async (keys: readonly string[]) => { enabled.push([...keys]); return { enabled: [...keys], already: [], unknown: [] } } } }
      : {}),
    now: () => new Date('2026-09-24T10:27:00Z'),
  })
  await svc.load()
  for (const [stage, key, value] of [
    ['opening', 'nickname', 'Ben'], ['branch', 'mode', 'existing'], ['template', 'template', 'product'],
    ['projects', 'project', { name: 'desktop-workbench', status: '到 0.2.83', path: '/Users/example/Documents/GitHub/desktop-workbench' }],
  ] as [string, string, unknown][]) {
    const got = await svc.answer({ stage, key, value })
    if (!got.ok) throw new Error(`${stage}.${key}:${got.error}`)
  }
  return { svc, tasks, enabled }
}

describe('②′ 按方案建事项:去重、不照搬旧交接', () => {
  it('维护者那晚的方案:两条 0.2.80 不建(仓库已经 0.2.83);「让她能自己扫仓库」换个说法再交一遍不重复建', async () => {
    const { svc, tasks } = await onboardingAtPlan({ version: '0.2.83' })
    const first = await svc.answer({ stage: 'projects', key: 'plan', value: {
      project: 'desktop-workbench',
      confirmed: true,
      items: [
        { title: '让事务官能自己扫仓库,不用口述', why: '交接里写的头号需求' },
        { title: '查 0.2.80 真机聚球还卡不卡', why: '交接里排的第二件' },
        { title: '按三层清单自验 0.2.80', why: '交接里排的第三件' },
      ],
    } })
    expect(first.ok && first.note).toContain('建了 1 条事项')
    expect(first.ok && first.note).toContain('提到的版本比仓库现在(0.2.83)旧')
    expect(first.ok && first.note).toContain('问他一句还要不要')
    const again = await svc.answer({ stage: 'projects', key: 'plan', value: {
      project: 'desktop-workbench', confirmed: true, items: [{ title: '让她能自己扫仓库,不用你口述', why: '你自己说的头号需求' }],
    } })
    expect(again.ok && again.note).toContain('没重复建')
    expect((await tasks.list()).tasks.map(task => task.title)).toEqual(['让事务官能自己扫仓库,不用口述'])
  })

  it('不知道仓库现在的版本(没接 / 读不到):照旧建,不猜', async () => {
    const { svc, tasks } = await onboardingAtPlan()
    await svc.answer({ stage: 'projects', key: 'plan', value: { project: 'desktop-workbench', confirmed: true, items: [{ title: '查 0.2.80 真机聚球还卡不卡' }] } })
    expect((await tasks.list()).tasks).toHaveLength(1)
  })
})

describe('④ 常用应用:记完别说「摆好了」', () => {
  it('回话里写清「记进窗口槽清单了……标签出来了,窗还没拉进来……别说摆好了」', async () => {
    const { svc, enabled } = await onboardingAtPlan({ apps: true })
    await svc.answer({ stage: 'projects', key: 'done', value: true })
    for (const key of ['write_docs', 'write_commit', 'write_api']) await svc.answer({ stage: 'authorization', key, value: true })
    await svc.answer({ stage: 'authorization', key: 'read_client_files', value: false })
    const got = await svc.answer({ stage: 'habits', key: 'apps', value: ['Claude', 'Codex', '微信'] })
    expect(enabled).toEqual([['claude', 'codex', 'wechat']])
    expect(got.ok && got.note).toContain('记进窗口槽清单了:Claude、Codex、微信')
    expect(got.ok && got.note).toContain('别说「摆好了」')
  })
})

describe('交接摘要:提到旧版本的「下一步」标「可能过时」', () => {
  it('现在 0.2.83:「查 0.2.80 …」「按三层清单自验 0.2.80」标上;没提版本的不动', () => {
    const text = [
      '# 统筹会话交接', '', '## 一、现在到哪', '- main 最新 = 0.2.80', '', '## 二、下一步(顺序)',
      '0. 让她能自己扫仓库,不用口述', '1. 查 0.2.80 真机聚球还卡不卡', '2. 按三层清单自验 0.2.80',
    ].join('\n')
    const out = handoffExcerpt(text, 1200, '0.2.83')
    expect(out).toContain('查 0.2.80 真机聚球还卡不卡〔可能过时:提到 0.2.80,现在已经 0.2.83〕')
    expect(out).toContain('按三层清单自验 0.2.80〔可能过时')
    expect(out).toContain('让她能自己扫仓库,不用口述\n')
    expect(handoffExcerpt(text, 1200)).not.toContain('可能过时')
  })

  it('仓库现在的版本:最近提交标题与 package.json 里最大的那个', async () => {
    const repo = temp('wb-version-')
    gitInit(repo)
    mkdirSync(join(repo, 'workbench-plugin'))
    writeFileSync(join(repo, 'workbench-plugin', 'package.json'), JSON.stringify({ version: '0.2.82' }))
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'release: 0.2.82'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'chore: 0.2.83 —— 键盘不缩球'], { cwd: repo })
    expect(await projectVersion(repo, nodeBriefIo())).toBe('0.2.83')
    expect(await projectVersion(join(repo, 'nope'), nodeBriefIo())).toBeUndefined()
  })
})

describe('按名字找 Codex 会话(只读)', () => {
  const index = [
    '{"id":"a1","thread_name":"评估项目参赛契合度","updated_at":"2026-09-14T07:08:55Z"}',
    '坏行',
    '{"id":"b2","thread_name":"完成参赛网页开发","updated_at":"2026-09-23T05:47:14Z"}',
    '{"id":"c3","thread_name":"制作参赛网页","updated_at":"2026-09-23T05:51:38Z"}',
  ].join('\n')

  it('名字里带着「参赛网页」的两条;坏行跳过', () => {
    expect(matchThreads(parseSessionIndex(index), '参赛网页').map(one => one.title)).toEqual(['完成参赛网页开发', '制作参赛网页'])
  })

  it('几条都像时挑记录文件最新的那条;一条都没有记录文件就按索引里的时间', async () => {
    const home = temp('wb-codex-')
    writeFileSync(join(home, 'session_index.jsonl'), index)
    const now = Date.parse('2026-09-24T12:00:00Z')
    const day = new Date(now)
    const dir = join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'rollout-2026-09-24T13-51-08-c3.jsonl')
    writeFileSync(file, '{}\n')
    utimesSync(file, new Date(now), new Date(now))
    expect(await findCodexThread('参赛网页', home, () => now)).toEqual({ id: 'c3', title: '制作参赛网页' })
    const bare = temp('wb-codex-bare-')
    writeFileSync(join(bare, 'session_index.jsonl'), index)
    expect(await findCodexThread('参赛网页', bare, () => now)).toEqual({ id: 'c3', title: '制作参赛网页' })
    expect(await findCodexThread('没有这个', bare, () => now)).toBeUndefined()
    expect(await findCodexThread('参赛网页', join(bare, 'nope'), () => now)).toBeUndefined()
  })
})

/**
 * 流式工具调用:模型一口气交好几项时,前一件在下一件开始吐的那一刻就开跑、最后一件要等参数吐完 ——
 * 「done 在前、project 在后」时 project 晚几秒才到,那一段已经推进了。刚收尾的那一段、一分钟内晚到的一项照收。
 */
describe('刚收尾的那一段晚到的一项:照收(done 先到了)', () => {
  async function atProjects(clock: { t: number }): Promise<{ svc: OnboardingService, root: string }> {
    const root = temp('wb-ob-late-')
    const repo = join(root, 'memory')
    mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
    gitInit(repo)
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    const svc = createOnboardingService({
    plan: FULL_PLAN,
      file: join(root, 'onboarding.json'),
      repoRoot: repo,
      agentsFile: join(root, 'AGENTS.md'),
      authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
      now: () => new Date(clock.t),
    })
    await svc.load()
    for (const [stage, key, value] of [['opening', 'nickname', 'Ben'], ['branch', 'mode', 'existing'], ['template', 'template', 'product']] as [string, string, unknown][]) {
      const got = await svc.answer({ stage, key, value })
      if (!got.ok) throw new Error(`${stage}.${key}:${got.error}`)
    }
    return { svc, root }
  }
  const archive = (root: string) => JSON.parse(readFileSync(join(root, 'onboarding.json'), 'utf8')) as { stage: string, answers: Record<string, Record<string, unknown>> }
  const lapis = { name: 'Lapis', one_liner: '仓库还叫 Echo', status: 'Kimi 在做' }

  it('done 先到推进了,project 晚几秒到:记进「项目」那一段、写项目文件,不 409、不倒退', async () => {
    const clock = { t: Date.parse('2026-09-24T10:27:00Z') }
    const { svc, root } = await atProjects(clock)
    expect(await svc.answer({ stage: 'projects', key: 'done', value: true })).toMatchObject({ ok: true, advanced: true, stage: 'authorization' })
    clock.t += 5_000
    const late = await svc.answer({ stage: 'projects', key: 'project', value: lapis })
    expect(late).toMatchObject({ ok: true, advanced: false, stage: 'authorization' })
    expect(late.ok && late.note).toContain('晚到了一步')
    expect(archive(root).stage).toBe('authorization')
    expect((archive(root).answers.projects?.project as Record<string, unknown>).Lapis).toMatchObject({ name: 'Lapis' })
    expect(readFileSync(join(root, 'memory', 'docs', '记忆', '项目', 'Lapis.md'), 'utf8')).toContain('Lapis')
    // 同一段里再晚到一个项目(按名字合并,是加一个):照收。
    expect(await svc.answer({ stage: 'projects', key: 'project', value: { ...lapis, name: 'Aiboo' } })).toMatchObject({ ok: true, advanced: false })
  })

  it('过了一分钟就不认了:照旧 409,把出路写进错误里', async () => {
    const clock = { t: Date.parse('2026-09-24T10:27:00Z') }
    const { svc } = await atProjects(clock)
    await svc.answer({ stage: 'projects', key: 'done', value: true })
    clock.t += LATE_ANSWER_GRACE_MS + 1_000
    expect(await svc.answer({ stage: 'projects', key: 'project', value: lapis })).toMatchObject({ ok: false, status: 409 })
  })

  it('收尾:最后一项到了、引导做完了,「要不要播客」晚到 —— 照收(不再 409「引导已经完成」),回包里 done 仍是 true', async () => {
    const clock = { t: Date.parse('2026-09-24T10:27:00Z') }
    const { svc, root } = await atProjects(clock)
    for (const [stage, key, value] of [
      ['projects', 'done', true],
      ['authorization', 'write_docs', true], ['authorization', 'write_commit', true], ['authorization', 'write_api', true], ['authorization', 'read_client_files', true],
      ['habits', 'done', true],
      ['persona', 'persona', '傲娇'], ['persona', 'candor', 5], ['persona', 'verbosity', 3],
      ['naming', 'butler_name', '拓麻鸽子'],
      ['wrapup', 'morning_report', true], ['wrapup', 'evening_routine', '20:30'], ['wrapup', 'first_item', '第一条:让 Codex 把参赛网页的架构剩下的补完'],
    ] as [string, string, unknown][]) {
      const got = await svc.answer({ stage, key, value })
      if (!got.ok) throw new Error(`${stage}.${key}:${got.error}`)
    }
    expect(archive(root).stage).toBe('done')
    clock.t += 3_000
    expect(await svc.answer({ stage: 'wrapup', key: 'feed_podcast', value: true })).toMatchObject({ ok: true, done: true, advanced: false })
    expect(archive(root).answers.wrapup?.feed_podcast).toBe(true)
    // 答过的单项晚到第二遍:不认(改要走 correct),照旧 409 指向 restart。
    expect(await svc.answer({ stage: 'wrapup', key: 'first_item', value: 'x' })).toMatchObject({ ok: false, status: 409 })
  })

  it('不认的:done 本身、那一段答过的单项、分岔与布局那几项、别的段的 key', async () => {
    const clock = { t: Date.parse('2026-09-24T10:27:00Z') }
    const { svc } = await atProjects(clock)
    await svc.answer({ stage: 'projects', key: 'done', value: true })
    expect(await svc.answer({ stage: 'projects', key: 'done', value: true })).toMatchObject({ ok: false, status: 409 })
    expect(await svc.answer({ stage: 'template', key: 'template', value: 'ops' })).toMatchObject({ ok: false, status: 409 })
    expect(await svc.answer({ stage: 'branch', key: 'mode', value: 'fresh' })).toMatchObject({ ok: false, status: 409 })
    expect(await svc.answer({ stage: 'projects', key: 'nickname', value: 'x' })).toMatchObject({ ok: false })
  })
})

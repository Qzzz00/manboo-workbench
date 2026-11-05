// @vitest-environment node
/**
 * 引导顺序改成 ① 称呼 → ② 分岔 → ①′ 布局 → ②′(2026-09-23 维护者第二轮真机:
 * 「为什么一开始是布局而不是从新点子或已有项目,这反了啊」)—— **断点续做**那一半。
 *
 * 老存档(plan 里布局在分岔前)升级后:已答的不丢、不重问;停在布局 / 分岔上的按新顺序接着走;
 * 老顺序下念过的、还没答的那一格种子句要重新开口。
 * 端到端(电脑回合表 / 电话 heard 两条路)在 server-onboarding-consent-http.test.ts 末尾。
 *
 * 全部在临时目录里跑,**不碰 ~/.dsh**。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { createOnboardingService, upgradeLegacyOrder } from '../src/server/onboarding.ts'
import { FULL_PLAN, LEGACY_TEMPLATE_FIRST } from '../src/server/onboardingStages.ts'
import type { OnboardingStage } from '../src/server/onboardingStages.ts'
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

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const OLD_PLAN: OnboardingStage[] = ['opening', 'template', 'branch', 'projects', 'authorization', 'habits', 'persona', 'naming', 'wrapup', 'done']

describe('upgradeLegacyOrder(纯函数)', () => {
  it('老计划里布局在分岔前:两格对调,其余一格不动', () => {
    expect(LEGACY_TEMPLATE_FIRST).toEqual(OLD_PLAN.slice(0, 3))
    const up = upgradeLegacyOrder({ stage: 'habits', plan: OLD_PLAN, mode: 'existing', template: 'product' })
    expect(up.changed).toBe(true)
    expect(up.plan).toEqual([...FULL_PLAN])
    expect(up.stage).toBe('habits')
  })

  it('停在老 ①′ 布局、分岔没答 → 停到 ② 分岔;布局的种子句划掉(老说法念过,新顺序到那格要重新开口)', () => {
    const up = upgradeLegacyOrder({ stage: 'template', plan: OLD_PLAN, spoken_seeds: ['opening', 'template'] })
    expect(up.stage).toBe('branch')
    expect(up.spoken_seeds).toEqual(['opening'])
  })

  it('停在老 ② 分岔、布局答过 → 仍停在分岔;布局的种子句留着(答过了,不会再到那一格)', () => {
    const up = upgradeLegacyOrder({ stage: 'branch', plan: OLD_PLAN, template: 'ops', spoken_seeds: ['opening', 'template', 'branch'] })
    expect(up.stage).toBe('branch')
    expect(up.spoken_seeds).toEqual(['opening', 'template'])
  })

  it('已经是新顺序、或计划里没有这两格(补问 / 重来某一段):不动', () => {
    expect(upgradeLegacyOrder({ stage: 'branch', plan: FULL_PLAN }).changed).toBe(false)
    expect(upgradeLegacyOrder({ stage: 'projects', plan: ['projects', 'done'] }).changed).toBe(false)
    expect(upgradeLegacyOrder({ stage: 'persona', plan: ['persona', 'done'] }).changed).toBe(false)
  })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** 预先写一份老存档再 load。 */
async function fromLegacy(file: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-order-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'docs', '记忆', '项目', '索引.md'), '# 项目索引\n')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 't@e.com')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const path = join(root, 'onboarding.json')
  writeFileSync(path, JSON.stringify({
    version: 1,
    plan: OLD_PLAN,
    startedAt: '2026-09-23T01:00:00.000Z',
    updatedAt: '2026-09-23T01:00:00.000Z',
    supplement: [],
    commits: [],
    history: [],
    ...file,
  }))
  const service = createOnboardingService({
    plan: FULL_PLAN,
    file: path,
    repoRoot: repo,
    agentsFile,
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  })
  await service.load()
  return { service, path }
}

describe('断点续做:老存档升级后接着走', () => {
  it('老顺序停在 ② 分岔(布局已选 ops):停在分岔,答完直接到 ②′ 账号,布局不重问', async () => {
    const { service, path } = await fromLegacy({
      stage: 'branch', nickname: '本', template: 'ops',
      answers: { opening: { nickname: '本' }, template: { template: 'ops' } },
      spoken_seeds: ['opening', 'template', 'branch'],
    })
    expect(service.view()).toMatchObject({ stage: 'branch', step: 2, steps: 9 })
    expect(service.detail().plan).toEqual([...FULL_PLAN])
    const brief = await service.brief()
    expect(brief.seed).toBe('你现在是已经有在做的事,还是想从一个新点子开始?')
    // 老顺序下念过的是运营那句「你现在做的是哪个平台」—— 分岔还没答,新说法要重新开口。
    expect(brief.speak_seed).toBe(true)

    const result = await service.answer({ stage: 'branch', key: 'mode', value: 'fresh' })
    expect(result).toMatchObject({ ok: true, stage: 'projects' })
    if (!result.ok) return
    // 运营 + 新点子:②′ 问的是一个还没开的号。
    expect(result.next?.seed).toContain('新号')
    expect(service.detail().answered).toMatchObject({ opening: ['nickname'], template: ['template'], branch: ['mode'] })
    // 落盘的已是新顺序,再起一次进程也不会再升一遍。
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { plan: string[], history: { event: string }[] }
    expect(saved.plan).toEqual([...FULL_PLAN])
    expect(saved.history.filter(item => item.event.startsWith('阶段顺序升级'))).toHaveLength(1)
  })

  it('老顺序停在 ①′ 布局(还没选):先问分岔,再问布局,两格种子句都要开口', async () => {
    const { service } = await fromLegacy({
      stage: 'template', nickname: '本',
      answers: { opening: { nickname: '本' } },
      spoken_seeds: ['opening', 'template'],
    })
    expect(service.view().stage).toBe('branch')
    expect((await service.brief()).speak_seed).toBe(true)
    const branch = await service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    expect(branch).toMatchObject({ ok: true, stage: 'template' })
    const brief = await service.brief()
    expect(brief.seed).toContain('你说的这件事')
    expect(brief.speak_seed).toBe(true)
    const tpl = await service.answer({ stage: 'template', key: 'template', value: 'product' })
    expect(tpl).toMatchObject({ ok: true, stage: 'projects' })
    expect(service.detail().answered.opening).toEqual(['nickname'])
  })

  it('老顺序已经走过这两格(停在 ④ 习惯):阶段原样,已答一项不少', async () => {
    const answers = {
      opening: { nickname: '本' }, template: { template: 'product' }, branch: { mode: 'existing' },
      projects: { done: true }, authorization: { write_docs: '可以', write_commit: '可以', write_api: '不可以', read_client_files: '要问' },
    }
    const { service } = await fromLegacy({ stage: 'habits', nickname: '本', template: 'product', mode: 'existing', answers })
    expect(service.view()).toMatchObject({ stage: 'habits', step: 6 })
    expect(service.detail().answered).toMatchObject({
      opening: ['nickname'], template: ['template'], branch: ['mode'], projects: ['done'],
    })
    expect(await service.answer({ stage: 'habits', key: 'done', value: true })).toMatchObject({ ok: true, stage: 'persona' })
  })

  it('新顺序的存档:不升级,历史里不多一条', async () => {
    const { service } = await fromLegacy({ stage: 'template', plan: [...FULL_PLAN], nickname: '本', mode: 'fresh', answers: { opening: { nickname: '本' }, branch: { mode: 'fresh' } } })
    expect(service.view().stage).toBe('template')
    expect(service.detail().commits).toEqual([])
    expect((await service.answer({ stage: 'template', key: 'template', value: 'product' }))).toMatchObject({ ok: true, stage: 'projects' })
  })
})

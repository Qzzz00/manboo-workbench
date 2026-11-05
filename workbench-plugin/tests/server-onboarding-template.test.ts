// @vitest-environment node
/**
 * 引导 ①′「你先用哪套布局」(2026-09-21 布局模板)。
 *
 * 两组:
 * - **阶段机那一半**(纯函数):新阶段在计划里的位置、值校验、两套模板下 ②/②′ 的问法不同;
 * - **服务那一半**:答完当场把布局换过去;没接模板服务时如实说一句;认不出的 id 400。
 *
 * 全部在临时目录里跑,**不碰 ~/.dsh**(同 server-onboarding.test.ts 的规矩)。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { OnboardingService, OnboardingTemplateDeps } from '../src/server/onboarding.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import {
  FULL_PLAN, STAGE_LABEL, firstMessage, keyBriefs, requiredKeys, stageDef, validateValue,
} from '../src/server/onboardingStages.ts'
import { PRODUCT_TEMPLATE, setWorkbenchTemplateSource } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

// 2026-10-23(分层二刀二):「布局要哪几个」的合法集合 = 全局模板来源认得的全部;
// 真机来源由 index.ts 注入(product + 用户层 布局/*.json),这里注入同一份(读真起步层)。
{
  const ops = await loadStarterLayoutTemplate()
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE, ops],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : id === ops.id ? ops : undefined),
  })
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('①′ 在计划里的位置', () => {
  // 2026-09-23 维护者第二轮真机:「为什么一开始是布局而不是从新点子或已有项目,这反了啊」。
  it('排在 ② 分岔之后、②′ 之前(① 称呼 → ② 分岔 → ①′ 布局 → ②′)', () => {
    expect(FULL_PLAN.slice(0, 4)).toEqual(['opening', 'branch', 'template', 'projects'])
  })

  it('整个计划就多了这一步,别的一个没动、顺序没变', () => {
    expect(FULL_PLAN.filter(stage => stage !== 'template')).toEqual([
      'opening', 'branch', 'projects', 'authorization', 'habits', 'persona', 'naming', 'wrapup', 'done',
    ])
  })

  it('有标签、有种子句、只有一个必答项', () => {
    expect(STAGE_LABEL.template).toContain('布局')
    const def = stageDef('template', undefined)
    expect(def.seed).toContain('做产品研发')
    expect(def.seed).toContain('自媒体运营')
    // 顺着他在分岔那一问里说的事问,不是凭空让他挑布局。
    expect(def.seed).toContain('你说的这件事')
    expect(def.goals.join('\n')).toContain('顺着他上一段说的那件事问')
    expect(requiredKeys('template', undefined)).toEqual(['template'])
    expect(keyBriefs('template', undefined).map(key => key.kind)).toEqual(['template'])
  })

  it('goals 里写着「两个都念出来、不推荐」,也写着「以后能换」', () => {
    const goals = stageDef('template', undefined).goals.join('\n')
    expect(goals).toContain('不推荐')
    expect(goals).toContain('设置里随时能换')
  })
})

describe('①′ 的值校验', () => {
  it('只认 product / ops', () => {
    expect(validateValue('template', 'product')).toEqual({ ok: true, value: 'product' })
    expect(validateValue('template', 'ops')).toEqual({ ok: true, value: 'ops' })
  })

  it('认不出的**不兜底成 product** —— 回一句人话,让它再问一遍', () => {
    const bad = validateValue('template', '运营')
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain('product')
    expect(bad.error).toContain('ops')
    expect(validateValue('template', 3).ok).toBe(false)
    expect(validateValue('template', undefined).ok).toBe(false)
  })
})

describe('两套模板下的问法', () => {
  it('做产品(或没选过):② 与 ②′ 跟加模板之前逐字相同', () => {
    const base = stageDef('branch', undefined)
    expect(stageDef('branch', undefined, 'product')).toEqual(base)
    expect(stageDef('projects', 'existing', 'product')).toEqual(stageDef('projects', 'existing'))
    expect(stageDef('projects', 'fresh', 'product')).toEqual(stageDef('projects', 'fresh'))
  })

  it('② 分岔在布局之前问:一句中性的,两套模板下逐字相同,不提"项目"也不提"账号"', () => {
    const neutral = stageDef('branch', undefined)
    expect(neutral.seed).toBe('你现在是已经有在做的事,还是想从一个新点子开始?')
    expect(neutral.seed).not.toMatch(/项目|账号|产品|运营|布局/)
    expect(stageDef('branch', undefined, 'ops')).toEqual(neutral)
    expect(stageDef('branch', undefined, 'product')).toEqual(neutral)
  })

  it('运营 + 新点子:②′ 还是记账号,开口换成「这个新号」,开号日期不问', () => {
    const fresh = stageDef('projects', 'fresh', 'ops')
    expect(fresh.seed).toContain('新号')
    expect(Object.keys(fresh.keys)).toContain('account')
    expect(Object.keys(fresh.keys)).not.toContain('idea')
    expect(fresh.goals.join('\n')).toContain('开号日期不问')
    expect(requiredKeys('projects', 'fresh', 'ops')).toEqual(requiredKeys('projects', 'existing', 'ops'))
    // 已经有号的那一支不受影响。
    expect(stageDef('projects', 'existing', 'ops').seed).not.toContain('新号')
  })

  it('运营:②′ 问账号定位 / 内容风格 / 目标人群 / 平台,**一个字不提扫仓库**', () => {
    const ops = stageDef('projects', 'existing', 'ops')
    const goals = ops.goals.join('\n')
    expect(goals).toContain('账号定位')
    expect(goals).toContain('内容风格')
    expect(goals).toContain('目标人群')
    expect(goals).toContain('平台')
    expect(goals).not.toContain('仓库清单')
    expect(ops.seed).not.toContain('仓库')
  })

  it('运营:②′ 把三个 read_* 键摘掉 —— 通话模式那一段「可以真去看他的仓库」才不会冒出来', () => {
    const ops = stageDef('projects', 'existing', 'ops')
    expect(Object.keys(ops.keys)).not.toContain('read_scan_roots')
    expect(Object.keys(ops.keys)).not.toContain('read_session_titles')
    // 必答项没变:摘掉的三个本来就不是必答。
    expect(requiredKeys('projects', 'existing', 'ops')).toEqual(requiredKeys('projects', 'existing'))
    expect(Object.keys(stageDef('projects', 'existing', 'product').keys)).toContain('read_scan_roots')
  })

  it('运营模板下开会话的第一条消息里没有「读你放仓库的目录」那句', () => {
    const common = {
      baseUrl: 'http://127.0.0.1:8791',
      answered: {},
      resumed: false,
      mode: 'existing' as const,
      stage: 'projects' as const,
    }
    expect(firstMessage({ ...common, template: 'product' })).toContain('仓库')
    const ops = firstMessage({ ...common, template: 'ops' })
    expect(ops).toContain('账号')
    expect(ops).not.toContain('read_scan_roots')
  })

  it('认不出的模板 id 按「没选过」处理(退回做产品那一套),不抛', () => {
    expect(stageDef('branch', undefined, '我编的')).toEqual(stageDef('branch', undefined))
  })
})

/* ───────────────── 服务那一半 ───────────────── */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

interface Fixture {
  service: OnboardingService
  repo: string
  applied: string[]
  read: (relative: string) => string
}

async function fixture(template?: Partial<OnboardingTemplateDeps> & { fail?: string }): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-tpl-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'docs', '记忆', '项目', '索引.md'), '# 项目索引\n\n| 项目 |\n|---|\n')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 't@e.com')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')

  const applied: string[] = []
  const deps: OnboardingTemplateDeps | undefined = template === null
    ? undefined
    : {
        apply: (id) => {
          applied.push(id)
          return Promise.resolve(template?.fail === undefined
            ? { ok: true, folders_made: ['账号', '素材/脚本'], apps_note: '已放进窗位清单:codex' }
            : { ok: false, reason: template.fail })
        },
        currentId: () => applied[applied.length - 1] ?? 'product',
      }

  const service = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'),
    repoRoot: repo,
    agentsFile,
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    ...(deps === undefined ? {} : { template: deps }),
    now: () => new Date('2026-09-21T02:00:00.000Z'),
  })
  await service.load()
  return { service, repo, applied, read: rel => readFileSync(join(repo, rel), 'utf8') }
}

/** 不接模板服务的那一档。 */
async function fixtureWithout(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-tpl0-'))
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
  const service = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'),
    repoRoot: repo,
    agentsFile,
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    now: () => new Date('2026-09-21T02:00:00.000Z'),
  })
  await service.load()
  return { service, repo, applied: [], read: rel => readFileSync(join(repo, rel), 'utf8') }
}

describe('答完 ①′ 当场换布局', () => {
  it('选 ops:调了 apply,note 里带着建了哪几个文件夹', async () => {
    const f = await fixture()
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    const result = await f.service.answer({ stage: 'template', key: 'template', value: 'ops' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(f.applied).toEqual(['ops'])
    expect(result.stage).toBe('projects')
    expect(result.note).toContain('布局已经换过去了')
    expect(result.note).toContain('账号')
    expect(result.note).toContain('窗位清单')
  })

  it('选完之后 ②′ 当场按运营线走 —— 下一段问的是账号', async () => {
    const f = await fixture()
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    const result = await f.service.answer({ stage: 'template', key: 'template', value: 'ops' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.next?.seed).toContain('账号')
    expect(result.next?.seed).not.toContain('项目')
  })

  it('选 product:②′ 按分岔的答案走产品线(已有 → 问交哪个项目)', async () => {
    const f = await fixture()
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    const result = await f.service.answer({ stage: 'template', key: 'template', value: 'product' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.next?.seed).toContain('你想先把哪个项目交给我')
  })

  it('记忆文件与复述里各留一行「布局模板」', async () => {
    const f = await fixture()
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    await f.service.answer({ stage: 'template', key: 'template', value: 'ops' })
    expect(f.read(join('docs', '记忆', '用户-本.md'))).toContain('自媒体运营')
    expect(f.service.detail().stage).toBe('projects')
  })

  it('apply 失败:答案照记,note 里如实说没换成,**不假装换好了**', async () => {
    const f = await fixture({ fail: '工作目录没配' })
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    const result = await f.service.answer({ stage: 'template', key: 'template', value: 'ops' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.note).toContain('布局没换成')
    expect(result.note).toContain('工作目录没配')
  })

  it('没接模板服务:答得进去,但如实说一句界面没换', async () => {
    const f = await fixtureWithout()
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    const result = await f.service.answer({ stage: 'template', key: 'template', value: 'ops' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.note).toContain('没接布局模板服务')
    expect(result.stage).toBe('projects')
  })

  it('认不出的 id:400,一个字都不落、也不调 apply', async () => {
    const f = await fixture()
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    const bad = await f.service.answer({ stage: 'template', key: 'template', value: '运营' })
    expect(bad).toMatchObject({ ok: false, status: 400 })
    expect(f.applied).toEqual([])
    expect(f.service.detail().stage).toBe('template')
  })

  it('分岔还没答就答布局:409(阶段只能顺着走,先问分岔)', async () => {
    const f = await fixture()
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    expect(await f.service.answer({ stage: 'template', key: 'template', value: 'ops' }))
      .toMatchObject({ ok: false, status: 409 })
    expect(f.applied).toEqual([])
  })

  it('改主意:correct 改得回来(同称呼那条路)', async () => {
    const f = await fixture()
    await f.service.answer({ stage: 'opening', key: 'nickname', value: '本' })
    await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    await f.service.answer({ stage: 'template', key: 'template', value: 'ops' })
    const fixed = await f.service.correct({ stage: 'template', key: 'template', value: 'product' })
    expect(fixed.ok).toBe(true)
    expect(f.applied).toEqual(['ops', 'product'])
  })
})

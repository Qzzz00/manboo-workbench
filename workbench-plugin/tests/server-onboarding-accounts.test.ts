// @vitest-environment node
/**
 * 引导 ②′ 运营线:问完账号,**当场落成工作目录下的一个文件夹**(2026-09-21)。
 *
 * 上一版(布局模板那张卡)只换了这一段的问法 —— 问的是账号,记下来的却还是 `project`,
 * 落进记忆仓库的 `docs/记忆/项目/<名>.md`,工作台的项目区里什么都不会多出来。
 * 这一份钉的就是那根线接上了:
 *
 *   record_answer(account) → `<工作目录>/账号/<名>/账号.md` → 账号数据源读得到 → 项目区有它
 *
 * 全部在临时目录里跑,**不碰 ~/.dsh**(同 server-onboarding.test.ts 的规矩)。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { createAccountSource } from '../src/server/accountSource.ts'
import { readAccountFields, writeAccount } from '../src/server/accounts.ts'
import { FULL_PLAN, keyBriefs, requiredKeys, stageDef, validateValue } from '../src/server/onboardingStages.ts'
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

// ───────────────────────────────────────────────────────────────────────────
describe('① ②′ 这一段在运营模板下记的是账号', () => {
  it('做产品(与没选过)记的还是 project —— 一个字没变', () => {
    expect(Object.keys(stageDef('projects', 'existing', 'product').keys)).toContain('project')
    expect(Object.keys(stageDef('projects', 'existing').keys)).toContain('project')
  })

  it('运营记的是 account,不是 project', () => {
    const keys = Object.keys(stageDef('projects', 'existing', 'ops').keys)
    expect(keys).toContain('account')
    expect(keys).not.toContain('project')
    expect(keyBriefs('projects', 'existing', 'ops').find(k => k.name === 'account')?.kind).toBe('account')
  })

  it('运营这一支没有「从零立项」:新点子也记账号,keys 与必答项同已有号那一支,只换开口那句(2026-09-23 分岔先问)', () => {
    const fresh = stageDef('projects', 'fresh', 'ops')
    const existing = stageDef('projects', 'existing', 'ops')
    expect(fresh.keys).toEqual(existing.keys)
    expect(fresh.writes).toEqual(existing.writes)
    expect(fresh.seed).toContain('新号')
  })

  it('必答项还是只有 done;2026-09-23 起先录一个账号,不追问还有没有别的,以后说「再加一个」就能加', () => {
    expect(requiredKeys('projects', 'existing', 'ops')).toEqual(['done'])
    expect(stageDef('projects', 'existing', 'ops').keys.done?.desc).toContain('不追问还有没有别的')
    const goals = stageDef('projects', 'existing', 'ops').goals.join('\n')
    expect(goals).toContain('先录一个账号')
    expect(goals).toContain('再加一个')
  })

  it('writes 里写明了落点是工作目录下的账号文件夹,不是记忆仓库', () => {
    const writes = stageDef('projects', 'existing', 'ops').writes.join('\n')
    expect(writes).toContain('账号/<账号名>/账号.md')
    expect(writes).toContain('笔记/')
  })
})

describe('② account 这一项的校验', () => {
  it('名字会拿去建文件夹,所以路径分隔符 / `..` / 点开头一律拒', () => {
    for (const name of ['a/b', '../x', '.隐藏', '']) {
      expect(validateValue('account', { name, platform: '小红书' }).ok).toBe(false)
    }
  })

  it('只有名字、一项内容都没有 → 拒(不建一个空壳文件夹)', () => {
    expect(validateValue('account', { name: '小食堂' }).ok).toBe(false)
  })

  it('一项就够,不必一次填全;空白字段拒', () => {
    expect(validateValue('account', { name: '小食堂', platform: '小红书' })).toEqual({
      ok: true, value: { name: '小食堂', platform: '小红书' },
    })
    expect(validateValue('account', { name: '小食堂', platform: '   ' }).ok).toBe(false)
  })

  it('开号日期**原样收他说的那句**,不强行解析成日期 —— 解析不出来就得猜', () => {
    const result = validateValue('account', { name: '小食堂', opened_at: '去年三月' })
    expect(result).toEqual({ ok: true, value: { name: '小食堂', opened_at: '去年三月' } })
  })
})

// ───────────────────────────────────────────────────────────────────────────
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

interface Fixture {
  service: OnboardingService
  /** 工作目录 = 记忆仓库(生产里 butler_cwd 同时是这两样,见 index.ts)。 */
  work: string
  invalidated: number
}

/** `wired: false` = 这台工作台没配工作目录,那一档不启用。 */
async function fixture(wired = true): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-acc-'))
  dirs.push(root)
  const work = join(root, 'repo')
  mkdirSync(join(work, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(work, 'docs', '记忆', '项目', '索引.md'), '# 项目索引\n\n| 项目 |\n|---|\n')
  git(work, 'init', '-q')
  git(work, 'config', 'user.email', 't@e.com')
  git(work, 'config', 'user.name', 't')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'init')
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')

  const box = { invalidated: 0 }
  const service = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'),
    repoRoot: work,
    agentsFile,
    authorization: createAuthorizationService({ file: join(work, 'docs', '记忆', '授权.md') }),
    // ①′ 那一步:把模板记成 ops(布局换不换不是这一份关心的事)。
    template: { apply: () => Promise.resolve({ ok: true }), currentId: () => 'ops' },
    ...(wired
      ? {
          accounts: {
            write: async (account) => {
              const result = await writeAccount(
                work,
                { name: account.name, fields: account.fields },
                { date: account.date, origin: '引导访谈' },
              )
              if (result.ok) box.invalidated += 1
              return result
            },
          },
        }
      : {}),
    now: () => new Date('2026-09-21T02:00:00.000Z'),
  })
  await service.load()
  return { service, work, get invalidated() { return box.invalidated } } as Fixture
}

/** 走到 ②′ 那一步(称呼 → 布局 ops → 分岔)。 */
async function toProjects(f: Fixture): Promise<void> {
  await f.service.answer({ stage: 'opening', key: 'nickname', value: 'Ben' })
  await f.service.answer({ stage: 'branch', key: 'mode', value: 'existing' })
  await f.service.answer({ stage: 'template', key: 'template', value: 'ops' })
}

describe('③ 答完当场落盘', () => {
  it('一次 record_answer(account) → 账号/<名>/账号.md 与 笔记/ 都在盘上', async () => {
    const f = await fixture()
    await toProjects(f)
    const result = await f.service.answer({
      stage: 'projects',
      key: 'account',
      value: { name: '小食堂', positioning: '一个人做饭', style: '口播 + 实拍', audience: '一人食的上班族', platform: '小红书' },
    })
    expect(result.ok).toBe(true)
    const file = join(f.work, '账号', '小食堂', '账号.md')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(f.work, '账号', '小食堂', '笔记'))).toBe(true)
    expect(readAccountFields(readFileSync(file, 'utf8'))).toEqual({
      定位: '一个人做饭', 风格: '口播 + 实拍', 人群: '一人食的上班族', 平台: '小红书',
    })
  })

  it('note 里如实说落在哪儿了(模型据此告诉他「项目区里能看到了」)', async () => {
    const f = await fixture()
    await toProjects(f)
    const result = await f.service.answer({ stage: 'projects', key: 'account', value: { name: '小食堂', platform: '小红书' } })
    if (!result.ok) throw new Error('unreachable')
    expect(result.note).toContain('小食堂')
    expect(result.note).toContain('项目区')
  })

  it('落盘之后项目区的扫描缓存作废了 —— 否则最多要等一个节流周期才看得见', async () => {
    const f = await fixture()
    await toProjects(f)
    await f.service.answer({ stage: 'projects', key: 'account', value: { name: '小食堂', platform: '小红书' } })
    expect(f.invalidated).toBe(1)
  })

  it('**当场在项目区出现**:账号数据源立刻读得到刚写的那一个', async () => {
    const f = await fixture()
    await toProjects(f)
    await f.service.answer({ stage: 'projects', key: 'account', value: { name: '小食堂', platform: '小红书' } })
    const source = createAccountSource({ workdir: () => f.work, now: () => 0 })
    const listed = await source.list()
    expect(listed.paths).toEqual([join(f.work, '账号', '小食堂')])
    const summary = await source.summary(listed.paths[0] as string, '小食堂')
    if (summary.kind !== 'account') throw new Error('unreachable')
    expect(summary.account.platform).toBe('小红书')
  })
})

describe('④ 多账号', () => {
  it('发两次 account = 两个文件夹,各写各的', async () => {
    const f = await fixture()
    await toProjects(f)
    await f.service.answer({ stage: 'projects', key: 'account', value: { name: '小食堂', platform: '小红书' } })
    await f.service.answer({ stage: 'projects', key: 'account', value: { name: '深夜书桌', platform: '公众号' } })
    const source = createAccountSource({ workdir: () => f.work, now: () => 0 })
    expect((await source.list()).paths).toEqual([
      join(f.work, '账号', '小食堂'),
      join(f.work, '账号', '深夜书桌'),
    ])
  })

  it('同一个账号发两次 = 补字段,不覆盖前一次说过的', async () => {
    const f = await fixture()
    await toProjects(f)
    await f.service.answer({ stage: 'projects', key: 'account', value: { name: '小食堂', platform: '小红书' } })
    await f.service.answer({ stage: 'projects', key: 'account', value: { name: '小食堂', audience: '上班族' } })
    const fields = readAccountFields(readFileSync(join(f.work, '账号', '小食堂', '账号.md'), 'utf8'))
    expect(fields).toEqual({ 平台: '小红书', 人群: '上班族' })
  })

  it('`later: true`(这个号稍后聊)只记不建文件夹 —— 同 project 那一支的规矩', async () => {
    const f = await fixture()
    await toProjects(f)
    await f.service.answer({ stage: 'projects', key: 'account', value: { name: '以后再说', later: true } })
    expect(existsSync(join(f.work, '账号', '以后再说'))).toBe(false)
  })
})

describe('⑤ 没配工作目录时', () => {
  it('答案照收,但**如实说一句没落盘** —— 最坏的失真是「答应了但其实没记」', async () => {
    const f = await fixture(false)
    await toProjects(f)
    const result = await f.service.answer({ stage: 'projects', key: 'account', value: { name: '小食堂', platform: '小红书' } })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.note).toContain('没落盘')
    expect(existsSync(join(f.work, '账号'))).toBe(false)
  })
})

// @vitest-environment node
/**
 * 引导 ④ 习惯多一问:「你平时最常开哪几个应用?」(2026-09-18,决策记录当天「首次空态」那条已拍板:
 * 窗位槽空态那句「或让事务官在引导里帮你选」以前是空头支票,这张卡把它兑现)。
 *
 * 守住的东西:
 * - 名字认成窗位键靠**一张明写的别名表 + 已登记的应用清单**,认不出就原样留着(`custom_apps`),
 *   绝不猜一个键出来(D13);
 * - 答完这一项,键写进 `apps.json` 的 `enabled` —— 「首次不自动认领」那条规矩下,
 *   这就是窗位清单出现的**唯一**方式,所以下一拍 `/state.apps` 就有标签;
 * - **可选**:跳过不答照样推进,apps.json 一个字不写;
 * - 简报里带「这台机器上扫到装了哪几家」,没扫过就不带(不编数)。
 *
 * 全部在临时目录里跑,不碰 ~/.dsh。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { AppsFile } from '../src/server/appsRegistry.ts'
import { BASE_KEYS, createAppsRegistry, loadAppsFile, saveAppsFile } from '../src/server/appsRegistry.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { FULL_PLAN, resolveAppKeys, validateValue } from '../src/server/onboardingStages.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-18T01:00:00Z') / 1000)
const noOsascript = async () => ({ ok: false, stdout: '' })

/** 基础七个 + 一条自定义应用,给纯函数当「已登记的清单」。 */
const KNOWN = [
  { key: 'codex', label: 'Codex' },
  { key: 'claude', label: 'Claude' },
  { key: 'kimi', label: 'Kimi' },
  { key: 'wechat', label: '微信' },
  { key: 'wecom', label: '企业微信' },
  { key: 'term', label: '终端' },
  { key: 'calendar', label: '日历' },
  { key: 'c-notion', label: 'Notion' },
]

interface Fixture {
  root: string
  repo: string
  appsFile: string
  stateFile: string
  service: OnboardingService
  enabled: () => Promise<string[]>
  slots: () => Promise<string[]>
  read: (relative: string) => string
  saved: () => { answers: Record<string, Record<string, unknown>>, custom_apps?: string[] }
}

/**
 * 引导阶段机 + 真的 apps registry(临时 apps.json),两边像生产里那样接起来。
 * `installed` 传 undefined = 这台机器还没扫过(简报里那一格该缺席)。
 */
async function fixture(options: { installed?: readonly string[], withApps?: boolean } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-apps-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })

  const appsFile = join(root, 'apps.json')
  const stateFile = join(root, 'onboarding.json')
  const authorization = createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') })
  let onboarding: OnboardingService | undefined
  const registry = createAppsRegistry({
    file: appsFile,
    runOsascript: noOsascript,
    // 首次:基础键默认一个都不出现 —— 只有他亲手加过的(enabled)才有。生产里接的是同一条闭包。
    firstRun: () => onboarding !== undefined && !onboarding.view().done,
  })
  let tick = 0
  onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file: stateFile,
    repoRoot: repo,
    agentsFile: join(root, 'AGENTS.md'),
    authorization,
    now: () => new Date(Date.UTC(2026, 8, 18, 1, 0, tick++)),
    ...(options.withApps === false
      ? {}
      : {
          apps: {
            known: () => registry.listAll(),
            enable: keys => registry.enable(keys),
            ...(options.installed === undefined ? {} : { installed: () => options.installed }),
          },
        }),
  })
  await onboarding.load()
  return {
    root,
    repo,
    appsFile,
    stateFile,
    service: onboarding,
    enabled: async () => (await loadAppsFile(appsFile)).enabled,
    slots: async () => (await registry.list()).map(app => app.key),
    read: relative => readFileSync(join(repo, relative), 'utf8'),
    saved: () => JSON.parse(readFileSync(stateFile, 'utf8')) as never,
  }
}

async function ok(service: OnboardingService, stage: string, key: string, value: unknown) {
  const result = await service.answer({ stage, key, value })
  if (!result.ok) throw new Error(`answer ${stage}.${key} 失败:${result.error}`)
  return result
}

/** 走到 ④ 习惯(B 线最短的一条路)。 */
async function toHabits(service: OnboardingService): Promise<void> {
  await ok(service, 'opening', 'nickname', '阿本')
  // 2026-09-21:引导多了 ①′ 布局这一步(在开场与分岔之间);走 product = 现状那一套。
  await ok(service, 'branch', 'mode', 'fresh')
  await ok(service, 'template', 'template', 'product')
  await ok(service, 'projects', 'idea', {
    name: '晨读机', one_liner: '给小学生的每日晨读播放器', problem: '家长早上没空陪读',
    assets: '一个点子', first_step: '先访谈 5 位家长', stage: '市场调研',
  })
  await ok(service, 'authorization', 'write_docs', 'ask')
  await ok(service, 'authorization', 'write_commit', true)
  await ok(service, 'authorization', 'write_api', false)
  await ok(service, 'authorization', 'read_client_files', 'ask')
}

describe('resolveAppKeys:应用名 → 窗位键', () => {
  it('中文名、英文名、大小写、多余空格都认得出', () => {
    expect(resolveAppKeys(['Claude', '微信'], KNOWN)).toEqual({ keys: ['claude', 'wechat'], custom: [] })
    expect(resolveAppKeys([' claude ', 'WeChat', '企业微信', '终端'], KNOWN))
      .toEqual({ keys: ['claude', 'wechat', 'wecom', 'term'], custom: [] })
  })

  it('别名表:ChatGPT 认成 codex(那个 App 里就是 Codex),日程认成日历', () => {
    expect(resolveAppKeys(['ChatGPT', '日程'], KNOWN)).toEqual({ keys: ['codex', 'calendar'], custom: [] })
  })

  it('自定义应用按 apps.json 里的展示名认(c-notion)', () => {
    expect(resolveAppKeys(['Notion'], KNOWN)).toEqual({ keys: ['c-notion'], custom: [] })
  })

  it('认不出的原样留在 custom,绝不猜一个键出来', () => {
    expect(resolveAppKeys(['飞书', 'Claude'], KNOWN)).toEqual({ keys: ['claude'], custom: ['飞书'] })
    // iTerm 不是 Terminal:名字像不算认得出。
    expect(resolveAppKeys(['iTerm'], KNOWN)).toEqual({ keys: [], custom: ['iTerm'] })
  })

  it('去重,顺序按他说的来', () => {
    expect(resolveAppKeys(['微信', 'Claude', 'wechat', '飞书', '飞书'], KNOWN))
      .toEqual({ keys: ['wechat', 'claude'], custom: ['飞书'] })
  })

  it('没有已登记清单时,基础七个照样靠别名表认得出', () => {
    expect(resolveAppKeys(['微信', 'Notion'], [])).toEqual({ keys: ['wechat'], custom: ['Notion'] })
  })
})

describe('apps 这个值的校验', () => {
  it('要一个非空字符串数组,空的 / 不是数组都回一句人话', () => {
    expect(validateValue('apps', [])).toEqual({ ok: false, error: expect.stringContaining('至少') })
    expect(validateValue('apps', 'Claude')).toEqual({ ok: false, error: expect.any(String) })
    expect(validateValue('apps', ['Claude', ''])).toEqual({ ok: false, error: expect.any(String) })
  })

  it('规整:去空白、原样留名字(认键是下一步的事)', () => {
    expect(validateValue('apps', [' Claude ', '微信'])).toEqual({ ok: true, value: ['Claude', '微信'] })
  })
})

describe('registry.enable:把键记成「他亲手加的」', () => {
  it('基础键写进 enabled,并从 disabled 里摘掉', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-apps-enable-'))
    dirs.push(root)
    const file = join(root, 'apps.json')
    const seed: AppsFile = { version: 1, apps: [], disabled: ['wechat'], enabled: [] }
    await saveAppsFile(file, seed)
    const registry = createAppsRegistry({ file, runOsascript: noOsascript, firstRun: () => true })
    expect(await registry.enable(['claude', 'wechat'])).toEqual({ enabled: ['claude', 'wechat'], already: [], unknown: [] })
    const data = await loadAppsFile(file)
    expect(data.enabled).toEqual(['claude', 'wechat'])
    expect(data.disabled).toEqual([])
    expect((await registry.list()).map(app => app.key)).toEqual(['claude', 'wechat'])
  })

  it('已经加过的算 already;不认识的键回 unknown,文件一个字不写', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-apps-enable2-'))
    dirs.push(root)
    const file = join(root, 'apps.json')
    await saveAppsFile(file, { version: 1, apps: [{ key: 'c-notion', label: 'Notion', name: 'Notion', bundle_id: 'notion.id' }], disabled: [], enabled: ['claude'] })
    const registry = createAppsRegistry({ file, runOsascript: noOsascript })
    const result = await registry.enable(['claude', 'c-notion', '飞书'])
    expect(result).toEqual({ enabled: [], already: ['claude', 'c-notion'], unknown: ['飞书'] })
    expect((await loadAppsFile(file)).enabled).toEqual(['claude'])
  })

  it('listAll 给出全部登记过的应用(不看 disabled / enabled / 首次)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-apps-listall-'))
    dirs.push(root)
    const file = join(root, 'apps.json')
    await saveAppsFile(file, { version: 1, apps: [{ key: 'c-notion', label: 'Notion', name: 'Notion', bundle_id: 'notion.id' }], disabled: ['calendar'], enabled: [] })
    const registry = createAppsRegistry({ file, runOsascript: noOsascript, firstRun: () => true })
    expect(await registry.list()).toEqual([{ key: 'c-notion', label: 'Notion' }])
    expect((await registry.listAll()).map(app => app.key))
      .toEqual([...BASE_KEYS, 'c-notion'])
  })
})

describe('④ 习惯:答「Claude、微信」', () => {
  it('两个键写进 apps.json 的 enabled,下一拍窗位清单就有这两项', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    expect(await fx.slots()).toEqual([])

    const result = await ok(fx.service, 'habits', 'apps', ['Claude', '微信'])
    // 可选项:答了不推进(这一阶段的必答项是 done)。
    expect(result).toMatchObject({ stage: 'habits', advanced: false })
    expect(await fx.enabled()).toEqual(['claude', 'wechat'])
    expect(await fx.slots()).toEqual(['claude', 'wechat'])
    expect(fx.saved().answers.habits?.apps).toEqual(['claude', 'wechat'])
  })

  it('用户文件里记一行「常用应用」,用的是展示名不是键', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    await ok(fx.service, 'habits', 'apps', ['claude', '微信'])
    const user = fx.read('docs/记忆/用户-阿本.md')
    expect(user).toContain('常用应用:Claude、微信')
  })

  it('答完还能接着答别的习惯项,done 之后照常推进', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    await ok(fx.service, 'habits', 'apps', ['Claude'])
    await ok(fx.service, 'habits', 'rhythm', '上午一段下午一段')
    expect((await ok(fx.service, 'habits', 'done', true)).stage).toBe('persona')
  })
})

describe('认不出的应用名', () => {
  it('原样进 custom_apps,不写进 enabled,note 里如实说一句', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    const result = await ok(fx.service, 'habits', 'apps', ['飞书', 'Claude'])
    expect(await fx.enabled()).toEqual(['claude'])
    expect(fx.saved().custom_apps).toEqual(['飞书'])
    expect(result.ok && result.note).toContain('飞书')
    const user = fx.read('docs/记忆/用户-阿本.md')
    expect(user).toContain('飞书')
  })

  it('一个都认不出:照样收下,窗位清单还是空的', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    await ok(fx.service, 'habits', 'apps', ['飞书', 'Notion'])
    expect(await fx.enabled()).toEqual([])
    expect(await fx.slots()).toEqual([])
    expect(fx.saved().custom_apps).toEqual(['飞书', 'Notion'])
  })
})

describe('跳过不答', () => {
  it('不影响推进,apps.json 一个字都不写', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    expect((await ok(fx.service, 'habits', 'done', true)).stage).toBe('persona')
    expect(await fx.enabled()).toEqual([])
    expect(fx.saved().answers.habits?.apps).toBeUndefined()
  })
})

describe('没接窗位清单(没传 apps 依赖)', () => {
  it('答得进去,但如实说一句没写进清单', async () => {
    const fx = await fixture({ withApps: false })
    await toHabits(fx.service)
    const result = await ok(fx.service, 'habits', 'apps', ['Claude', '微信'])
    expect(fx.saved().answers.habits?.apps).toEqual(['claude', 'wechat'])
    expect(result.ok && result.note).toContain('窗位')
    expect(await fx.enabled()).toEqual([])
  })
})

describe('给工人的简报', () => {
  it('④ 习惯这一段带「扫到装了哪几家」,用的是展示名', async () => {
    const fx = await fixture({ installed: ['claude', 'kimi', 'wechat'] })
    await toHabits(fx.service)
    const brief = await fx.service.brief()
    expect(brief.stage).toBe('habits')
    expect(brief.installed_apps).toEqual([
      { key: 'claude', label: 'Claude' },
      { key: 'kimi', label: 'Kimi' },
      { key: 'wechat', label: '微信' },
    ])
    expect(brief.keys.map(key => key.name)).toContain('apps')
  })

  it('别的阶段不带这一格', async () => {
    const fx = await fixture({ installed: ['claude'] })
    const brief = await fx.service.brief()
    expect(brief.stage).toBe('opening')
    expect(brief.installed_apps).toBeUndefined()
  })

  it('这台机器还没扫过就不带(不编数,不冒充「一家都没装」)', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    expect((await fx.service.brief()).installed_apps).toBeUndefined()
  })
})

describe('电脑那条路(DSH 会话的第一条消息)', () => {
  it('在 ④ 习惯开/续会话时,消息里也带「扫到装了哪几家」', async () => {
    const fx = await fixture({ installed: ['claude', 'wechat'] })
    await toHabits(fx.service)
    const opened = await fx.service.openSession(undefined, 'http://127.0.0.1:8791')
    expect(opened.ok).toBe(true)
    const message = opened.ok ? opened.first_message : ''
    expect(message).toContain('apps')
    expect(message).toContain('扫到装了:Claude、微信')
  })

  it('没扫过就一个名字都不提', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    const opened = await fx.service.openSession(undefined, 'http://127.0.0.1:8791')
    expect(opened.ok && opened.first_message).not.toContain('扫到装了')
  })
})

describe('端到端:/state 下一拍就有窗位标签', () => {
  it('POST /onboarding/answer 之后 /state.apps 出现 Claude 与微信', async () => {
    const fx = await fixture()
    await toHabits(fx.service)
    const appsFile = fx.appsFile
    const registry = createAppsRegistry({
      file: appsFile,
      runOsascript: noOsascript,
      firstRun: () => !fx.service.view().done,
    })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      onboarding: fx.service,
      registry,
    })
    started.push(server)
    const before = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(before.apps).toEqual([])

    const res = await fetch(`${server.url}/onboarding/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'habits', key: 'apps', value: ['Claude', '微信'] }),
    })
    expect(res.status).toBe(200)
    const after = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(after.apps).toEqual([{ key: 'claude', label: 'Claude' }, { key: 'wechat', label: '微信' }])
  })
})

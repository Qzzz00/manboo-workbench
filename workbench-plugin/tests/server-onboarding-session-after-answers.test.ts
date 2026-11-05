// @vitest-environment node
/**
 * 电脑首次流程:先记界面上答的,再开引导会话(2026-09-24,卡 fix/firstrun-session-after-answers)。
 *
 * 病(统筹 14:32 在 0.2.81 真机复现):「已经有在做的事」→ 称呼屏填 Ben →「就这么叫」→ 对话屏摆着布局那一问 →
 * 他答「产品研发」→ 她又问「我该怎么称呼你呢」。当时 onboarding.json 里称呼、分岔都记上了、阶段在布局;
 * 回合表 1 她=开场白 / 2 他=产品研发 / 3 她=问称呼。根因:页面**先**开会话(那一刻阶段在开场,第一条消息让她
 * 原样念开场白、问称呼),**后**用按钮流交称呼与分岔 —— 模型一概不知道。页面那头的顺序在 client-firstrun.test.tsx 钉着;
 * 这里钉工作台这一头:
 *
 *   ① 称呼与分岔已记、阶段在布局时开会话:第一条消息是布局那一问、带已答项(连值),不问称呼、不念开场白、不问分岔,
 *      也不让她先绕一句「你在做什么」—— 对话屏在她开口之前摆的就是那一句,两边不打架;
 *   ② 重启后预热的那条:阶段机在预热之后变了 → 不交,另开一条按现在写的;对得上 → 照旧交、不再往里说。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { FULL_PLAN, OPENING_LINE, stageDef } from '../src/server/onboardingStages.ts'
import { createOnboardingTurns } from '../src/server/onboardingTurns.ts'
import { createOnboardingWarm, type OnboardingWarm } from '../src/server/onboardingWarm.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-24T06:32:00Z') / 1000)
const TEMPLATE_SEED = stageDef('template', 'existing').seed
const BRANCH_SEED = stageDef('branch', undefined).seed

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-firstrun-session-'))
  dirs.push(dir)
  return dir
}

async function post(url: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function until(check: () => boolean): Promise<void> {
  for (let k = 0; k < 200 && !check(); k++) await new Promise(resolve => setTimeout(resolve, 10))
}

/** 预热记号的一层薄壳:看得见 noteWarmed 什么时候被调、带了什么。 */
function spiedWarm(file: string): { warm: OnboardingWarm, noted: [string, string | undefined][] } {
  const inner = createOnboardingWarm({ file, delayMs: 0 })
  const noted: [string, string | undefined][] = []
  return {
    noted,
    warm: { ...inner, noteWarmed: (id: string, mark?: string) => { noted.push([id, mark]); inner.noteWarmed(id, mark) } },
  }
}

/**
 * 一台真阶段机 + 假 DSH 会话通道(开一条记一条 sent,往会话里说记 said)。
 * `before` 在起服务之前跑(预热是起服务那一刻做的,要先把阶段摆好)。
 */
async function serve(options: {
  before?: (onboarding: ReturnType<typeof createOnboardingService>) => Promise<void>
  warm?: OnboardingWarm
} = {}) {
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
  const file = join(root, 'onboarding.json')
  const onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file, repoRoot: repo, agentsFile, authorization,
    now: () => new Date(NOW_SEC * 1000),
  })
  await onboarding.load()
  await options.before?.(onboarding)
  const turns = createOnboardingTurns({ now: () => new Date(NOW_SEC * 1000) })
  const sent: string[] = []
  const said: [string, string][] = []
  let n = 0
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    onboarding,
    authorization,
    onboardingTurns: turns,
    ...(options.warm === undefined ? {} : { onboardingWarm: options.warm }),
    butlerSession: {
      open: async (message: string) => { sent.push(message); return `sess-${++n}` },
      say: async (id: string, text: string) => { said.push([id, text]); return true },
    },
  })
  started.push(server)
  const history = async (): Promise<string[]> =>
    (JSON.parse(await readFile(file, 'utf8')) as { history: { event: string }[] }).history.map(item => item.event)
  return { url: server.url, onboarding, turns, sent, said, history }
}

/** DSH 会话里她说了一句(回合表收 `assistant/message`)。 */
function herSays(turns: ReturnType<typeof createOnboardingTurns>, sessionId: string, text: string): void {
  turns.handleEvent(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
}

describe('① 称呼与分岔已记、阶段在布局时开会话', () => {
  it('★第一条消息是布局那一问、带已答项;不问称呼、不念开场白、不问分岔', async () => {
    const fx = await serve()
    await fx.onboarding.answer({ stage: 'opening', key: 'nickname', value: 'Ben' })
    await fx.onboarding.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    const opened = await post(fx.url, '/onboarding/session', {})
    expect(opened.status).toBe(200)
    expect(opened.body).toMatchObject({ stage: 'template', session_id: 'sess-1', resumed: true, seed: TEMPLATE_SEED })
    expect(fx.sent).toHaveLength(1)
    const message = fx.sent[0] as string
    expect(message).toContain('[引导 · ①′ 布局')
    // 开口只问这一题,照种子句问。
    expect(message).toContain('只问还没答的那一题')
    expect(message).toContain(`照样子说:「${TEMPLATE_SEED}」`)
    // 已答项带着,称呼与分岔连值(这两项是他在屏幕上答的,模型没听见)。
    expect(message).toContain('已经答过:① 开场(nickname:Ben);② 分岔(mode:已经有在做的事)')
    expect(message).toContain('可以先叫他一声「Ben」')
    // 不问称呼、不重念开场白、不问分岔。
    expect(message).not.toContain('你希望我怎么称呼你')
    expect(message).not.toContain(OPENING_LINE)
    expect(message).not.toContain('开场白(Ben 亲笔,一字不改,原样说)')
    expect(message).not.toContain(BRANCH_SEED)
  })

  it('★屏上那句与她说的不打架:对话屏在她开口前摆的种子句,就是第一条消息让她照着问的那一句;也不让她先绕「你在做什么」', async () => {
    const fx = await serve()
    await fx.onboarding.answer({ stage: 'opening', key: 'nickname', value: 'Ben' })
    await fx.onboarding.answer({ stage: 'branch', key: 'mode', value: 'fresh' })
    await post(fx.url, '/onboarding/session', {})
    const message = fx.sent[0] as string
    const view = await (await fetch(`${fx.url}/onboarding/turns`)).json() as { seed?: string, stage: string, turns: unknown[] }
    // 对话屏的字幕:一条事务官回合都没有时摆的就是这一句(chatHerLine)。
    expect(view).toMatchObject({ stage: 'template', seed: TEMPLATE_SEED, turns: [] })
    expect(message).toContain(`「${view.seed}」`)
    expect(message).toContain('mode:从一个新点子开始')
    // 电脑上分岔是点按钮答的:不先另问一句「你在做什么」再绕回布局那一问(那样布局那一问前后出现两次)。
    expect(message).toContain('直接照种子句问这一题')
    expect(message).toContain('别先另问一句「你在做什么」')
    expect(message).not.toMatch(/先问一句「你在做的 \/ 想做的是件什么事/)
    // 她照念布局那一问:回合表认得(标 seed),不是拿开场那句去比。
    herSays(fx.turns, 'sess-1', TEMPLATE_SEED)
    expect(fx.turns.list(0)).toEqual([expect.objectContaining({ role: 'assistant', text: TEMPLATE_SEED, kind: 'seed' })])
  })

  it('对照:还在开场就开会话(旧顺序那一刻)—— 第一条消息让她原样念开场白、问称呼。这就是「称呼问了两遍」的病根', async () => {
    const fx = await serve()
    const opened = await post(fx.url, '/onboarding/session', {})
    expect(opened.body).toMatchObject({ stage: 'opening', resumed: false })
    expect(fx.sent[0]).toContain('开场白(Ben 亲笔,一字不改,原样说)')
    expect(fx.sent[0]).toContain(OPENING_LINE)
  })
})

describe('② 重启后预热的那条会话', () => {
  it('★预热之后阶段机变了(他在别处答了分岔):不交预热那条,另开一条按现在写的;旧那条之后说的不上屏', async () => {
    const file = join(tempDir(), 'workbench', 'onboarding-warm.json')
    await createOnboardingWarm({ file }).mark()
    const { warm, noted } = spiedWarm(file)
    const fx = await serve({
      warm,
      before: async (onboarding) => { await onboarding.answer({ stage: 'opening', key: 'nickname', value: 'Ben' }) },
    })
    // 新进程起来:按那一刻的阶段(分岔)把会话热起来。
    await until(() => noted.length > 0)
    expect(noted[0]?.[0]).toBe('sess-1')
    expect(fx.sent[0]).toContain('[引导 · ② 分岔')

    // 页面来领之前,分岔在别处答上了 —— 阶段到了布局。
    await fx.onboarding.answer({ stage: 'branch', key: 'mode', value: 'existing' })
    const claimed = await post(fx.url, '/onboarding/session', {})
    expect(claimed.status).toBe(200)
    expect(claimed.body.warmed).toBeUndefined()
    expect(claimed.body).toMatchObject({ stage: 'template', session_id: 'sess-2', seed: TEMPLATE_SEED })
    // 另开了一条,第一条消息按布局写;没往预热那条里补话。
    expect(fx.sent).toHaveLength(2)
    expect(fx.sent[1]).toContain('[引导 · ①′ 布局')
    expect(fx.sent[1]).toContain(`照样子说:「${TEMPLATE_SEED}」`)
    expect(fx.sent[1]).not.toContain(BRANCH_SEED)
    expect(fx.said).toEqual([])
    // 阶段机与回合表都认新的那条;历史里记一笔为什么换。
    expect(fx.onboarding.detail().session_id).toBe('sess-2')
    expect(fx.turns.status().session_id).toBe('sess-2')
    expect((await fx.history()).some(event => event.includes('预热的引导会话 sess-1') && event.includes('另开 sess-2'))).toBe(true)
    // 预热那条正在答它的第一条消息(问分岔):答完了也不进回合表、不上屏。
    herSays(fx.turns, 'sess-1', '好,Ben。你现在是已经有在做的事,还是想从一个新点子开始?')
    herSays(fx.turns, 'sess-2', TEMPLATE_SEED)
    expect(fx.turns.list(0).map(turn => turn.text)).toEqual([TEMPLATE_SEED])
  })

  it('预热之后阶段机没变(页面先记完称呼与分岔再开会话,正常那条路):照旧把那条交出去,不另开、不再往里说', async () => {
    const file = join(tempDir(), 'workbench', 'onboarding-warm.json')
    await createOnboardingWarm({ file }).mark()
    const { warm, noted } = spiedWarm(file)
    const fx = await serve({
      warm,
      before: async (onboarding) => {
        await onboarding.answer({ stage: 'opening', key: 'nickname', value: 'Ben' })
        await onboarding.answer({ stage: 'branch', key: 'mode', value: 'existing' })
      },
    })
    await until(() => noted.length > 0)
    // 预热那一下就是按布局写的。
    expect(fx.sent[0]).toContain(`照样子说:「${TEMPLATE_SEED}」`)
    const claimed = await post(fx.url, '/onboarding/session', {})
    expect(claimed.body).toMatchObject({ session_id: 'sess-1', warmed: true, stage: 'template' })
    expect(fx.sent).toHaveLength(1)
    expect(fx.said).toEqual([])
  })
})

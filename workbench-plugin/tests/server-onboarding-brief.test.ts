// @vitest-environment node
/**
 * 引导「简报」(2026-09-18,手机引导改通话模式):`GET /onboarding/brief` 与 `POST /onboarding/spoken`。
 *
 * 通道层的工人不进 DSH 会话,它自己接话 —— 所以要有一条路把「现在在哪个阶段、该问什么、
 * 值是什么形状、引导技能怎么说、这一阶段的种子句出过声没有」一次性交给它。
 * 阶段机不变:答案照旧只能走 `POST /onboarding/answer`。
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
import { FULL_PLAN, OPENING_LINE } from '../src/server/onboardingStages.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-18T01:00:00Z') / 1000)

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function getJson(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve(options: { skill?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-brief-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  const skillFile = join(root, 'skills', '引导', 'SKILL.md')
  if (options.skill !== undefined) {
    mkdirSync(join(root, 'skills', '引导'), { recursive: true })
    writeFileSync(skillFile, options.skill)
  }
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const authorization = createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') })
  const onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'),
    repoRoot: repo,
    agentsFile,
    authorization,
    skillFiles: [skillFile],
    now: () => new Date(NOW_SEC * 1000),
  })
  await onboarding.load()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    onboarding,
    authorization,
  })
  started.push(server)
  return { url: server.url, onboarding, root }
}

describe('GET /onboarding/brief', () => {
  it('第一次:开场阶段、开场白一字不改、种子句还没出过声、值的形状与技能全文都在', async () => {
    const { url } = await serve({ skill: '# 引导\n三条铁律……\n' })
    const got = await getJson(url, '/onboarding/brief')
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ stage: 'opening', label: '① 开场', done: false, speak_seed: true })
    expect(got.body.seed).toBe(OPENING_LINE)
    expect((got.body.keys as { name: string, kind: string, required: boolean }[])).toEqual([
      { name: 'nickname', kind: 'string', desc: expect.stringContaining('称呼'), required: true },
    ])
    // 2026-09-23(U / V):称呼他一说就直接用,不再「对吗」;**随时能改**仍写在这一段的清单里。
    expect((got.body.goals as string[]).join('\n')).toContain('不再问「对吗」')
    expect((got.body.goals as string[]).join('\n')).toContain('correct_answer')
    expect(got.body.skill).toContain('三条铁律')
    expect(got.body.skill_note).toBeUndefined()
    // 还没出过声就没有 askedAt —— 不编数。
    expect(got.body.askedAt).toBeUndefined()
  })

  it('读不到技能文件:不编一份,如实说一句', async () => {
    const { url } = await serve()
    const got = await getJson(url, '/onboarding/brief')
    expect(got.body.skill).toBeUndefined()
    expect(String(got.body.skill_note)).toContain('引导技能')
  })

  it('说过了就记下来:speak_seed 变 false,/state.onboarding 有了 askedAt;重开不重说', async () => {
    const { url } = await serve()
    const marked = await post(url, '/onboarding/spoken', { stage: 'opening' })
    expect(marked.status).toBe(200)
    expect(marked.body).toMatchObject({ ok: true, stage: 'opening', speak_seed: false })

    const again = await getJson(url, '/onboarding/brief')
    expect(again.body.speak_seed).toBe(false)
    expect(again.body.askedAt).toBe('2026-09-18T01:00:00.000Z')

    const state = await getJson(url, '/state')
    expect((state.body as { onboarding?: { askedAt?: string } }).onboarding?.askedAt).toBe('2026-09-18T01:00:00.000Z')
  })

  it('答完一项推进到下一阶段:简报换成新阶段,新阶段的种子句还没出过声', async () => {
    const { url } = await serve()
    await post(url, '/onboarding/spoken', { stage: 'opening' })
    const answered = await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Ben' })
    expect(answered.status).toBe(200)

    // 2026-09-23:开场答完之后是 ② 分岔(中性一句),再答完才到 ①′ 布局。
    const first = await getJson(url, '/onboarding/brief')
    expect(first.body).toMatchObject({ stage: 'branch', label: '② 分岔', speak_seed: true, nickname: 'Ben' })
    expect(first.body.seed).toContain('已经有在做的事')

    await post(url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'existing' })
    const got = await getJson(url, '/onboarding/brief')
    expect(got.body).toMatchObject({ stage: 'template', label: '①′ 布局(做产品 / 自媒体运营)', speak_seed: true, nickname: 'Ben' })
    expect(got.body.seed).toContain('自媒体运营')
    expect((got.body.answered as Record<string, string[]>).opening).toEqual(['nickname'])
  })

  it('B 线:值的形状按当前 mode 给(idea 而不是 project)', async () => {
    const { url } = await serve()
    await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Ben' })
    await post(url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'fresh' })
    await post(url, '/onboarding/answer', { stage: 'template', key: 'template', value: 'product' })
    const got = await getJson(url, '/onboarding/brief')
    expect(got.body.mode).toBe('fresh')
    // 2026-09-20:B 线也要「排一个方案念给他听、他点头才落事项」,所以多一项 plan。
    expect((got.body.keys as { name: string }[]).map(k => k.name)).toEqual(['idea', 'plan'])
    expect((got.body.keys as { desc: string }[])[0]?.desc).toContain('first_step')
  })

  it('坏 stage 的 spoken 400;没接引导(没配记忆仓库)两条都 404', async () => {
    const { url } = await serve()
    const bad = await post(url, '/onboarding/spoken', { stage: '没有这个阶段' })
    expect(bad.status).toBe(400)

    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({ now: () => NOW_SEC }), tickIntervalMs: 0 })
    started.push(server)
    expect((await getJson(server.url, '/onboarding/brief')).status).toBe(404)
    expect((await post(server.url, '/onboarding/spoken', { stage: 'opening' })).status).toBe(404)
  })
})

/**
 * 谁主导引导(2026-09-18,Ben:「如果手机已经扫码,优先手机的引导流程」)。
 * 服务端这一半只管**记着谁在主导、最后一次动静是什么时候**;哪一屏怎么画在浏览器侧
 * (client/firstrun/onboardingLead.ts,那边另有一份纯函数用例)。
 */
describe('POST /onboarding/leader', () => {
  it('还没人主导过:/state.onboarding 与简报里都没有 leader(不编一个默认值)', async () => {
    const { url } = await serve()
    const state = await getJson(url, '/state')
    const view = (state.body as { onboarding?: Record<string, unknown> }).onboarding
    expect(view?.leader).toBeUndefined()
    expect(view?.leader_at).toBeUndefined()
    // 只读进度那一行要的三样从一开始就有,它们是算出来的、不用谁先落笔。
    expect(view).toMatchObject({ label: '① 开场', step: 1, steps: 9 })
    expect((await getJson(url, '/onboarding/brief')).body.leader).toBeUndefined()
  })

  it('落 phone:/state.onboarding、GET /onboarding、简报三处一致', async () => {
    const { url } = await serve()
    const set = await post(url, '/onboarding/leader', { leader: 'phone' })
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ ok: true, leader: 'phone' })

    const state = await getJson(url, '/state')
    expect((state.body as { onboarding?: Record<string, unknown> }).onboarding).toMatchObject({
      leader: 'phone', leader_at: '2026-09-18T01:00:00.000Z',
    })
    expect((await getJson(url, '/onboarding')).body).toMatchObject({ leader: 'phone' })
    expect((await getJson(url, '/onboarding/brief')).body.leader).toBe('phone')
  })

  it('改回 desktop 就是 desktop;认不出来的值 400 + 一句人话', async () => {
    const { url } = await serve()
    await post(url, '/onboarding/leader', { leader: 'phone' })
    await post(url, '/onboarding/leader', { leader: 'desktop' })
    expect((await getJson(url, '/onboarding/brief')).body.leader).toBe('desktop')

    const bad = await post(url, '/onboarding/leader', { leader: '手机' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('phone / desktop')
    // 400 不该把已经落好的那一笔改掉。
    expect((await getJson(url, '/onboarding/brief')).body.leader).toBe('desktop')
  })

  it('**主导方一有动静就记时刻**:念了种子句、交了答案都算(电脑据此判断「手机那边没动静」)', async () => {
    const { url, onboarding } = await serve()
    await post(url, '/onboarding/leader', { leader: 'phone' })
    await post(url, '/onboarding/spoken', { stage: 'opening' })
    expect(onboarding.view().leader_at).toBe('2026-09-18T01:00:00.000Z')
    const answered = await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Ben' })
    expect(answered.status).toBe(200)
    expect(onboarding.view().leader_at).toBe('2026-09-18T01:00:00.000Z')
    // 主导方没变 —— 交答案不改归属,只改「最后一次动静」。
    expect(onboarding.view().leader).toBe('phone')
  })

  it('阶段推进时 step 跟着走(只读进度那一行照它显示)', async () => {
    const { url, onboarding } = await serve()
    // 2026-09-21:多了 ①′ 布局,共 9 步。
    expect(onboarding.view()).toMatchObject({ step: 1, steps: 9, label: '① 开场' })
    await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Ben' })
    expect(onboarding.view()).toMatchObject({ step: 2, label: '② 分岔' })
    await post(url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'existing' })
    expect(onboarding.view()).toMatchObject({ step: 3, label: '①′ 布局(做产品 / 自媒体运营)' })
  })
})

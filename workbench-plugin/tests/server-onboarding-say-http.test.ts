// @vitest-environment node
/**
 * 手机端引导的两条新接口(2026-09-16):POST /onboarding/say { text } 与 GET /onboarding/turns?after=。
 * 鉴权、409 的人话、去代码块、restart 清表、已配对手机能用。
 * serve() 与 server-onboarding-http.test.ts 同源,多注入 onboardingTurns 与 say 桩。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingTurns } from '../src/server/onboardingTurns.ts'
import { FULL_PLAN, OPENING_LINE } from '../src/server/onboardingStages.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-15T01:00:00Z') / 1000)

/** 程序来源:没有 Origin、不是壳 UA(事务官在会话里 curl 就是这样)。 */
async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
/** 页面来源:浏览器 fetch 会带 Origin。 */
const asPage = { origin: 'http://127.0.0.1:8791' }

async function getJson(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

interface ServeOptions {
  withOnboarding?: boolean
  withAuthorization?: boolean
  withTurns?: boolean
  withPairing?: boolean
  open?: (message: string) => Promise<string | undefined>
  say?: (sessionId: string, text: string) => Promise<boolean>
}

async function serve(options: ServeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-http-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n\n原文一行。\n')
  const authorization = createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') })
  let n = 0
  const tasks = createTasksService({ file: join(root, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'), repoRoot: repo, agentsFile, authorization, tasks,
    now: () => new Date(NOW_SEC * 1000),
  })
  await onboarding.load()
  const sent: string[] = []
  const said: [string, string][] = []
  const turns = createOnboardingTurns({ now: () => new Date(NOW_SEC * 1000) })
  let remote = '127.0.0.1'
  const pairing = createPairingService({ file: join(root, 'devices.json'), now: () => Date.now() })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    remoteAddress: () => remote,
    isRemoteAllowed: () => true,
    ...(options.withOnboarding === false ? {} : { onboarding }),
    ...(options.withAuthorization === false ? {} : { authorization }),
    ...(options.withTurns === false ? {} : { onboardingTurns: turns }),
    ...(options.withPairing === true ? { pairing } : {}),
    ...(options.open === undefined ? {} : {
      butlerSession: {
        open: async (message: string) => { sent.push(message); return options.open?.(message) },
        ...(options.say === undefined ? {} : { say: async (sessionId: string, text: string) => { said.push([sessionId, text]); return options.say!(sessionId, text) } }),
      },
    }),
  })
  started.push(server)
  return { url: server.url, root, repo, agentsFile, authorization, sent, said, onboarding, turns, pairing, setRemote: (a: string) => { remote = a } }
}

describe('POST /onboarding/say', () => {
  it('会话没开 → 409 带人话;空 text 400', async () => {
    const { url } = await serve({ open: async () => 'sess-ob', say: async () => true })
    expect(await post(url, '/onboarding/say', { text: '叫我 Ben' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('引导会话还没开') } })
    await post(url, '/onboarding/session', {})
    expect(await post(url, '/onboarding/say', { text: '   ' })).toMatchObject({ status: 400, body: { error: 'text 要是非空字符串' } })
  })
  it('会话开着 → 那句话原样排进这条会话;说不进去(会话没了)409;disposed 之后 409', async () => {
    const { url, said, turns } = await serve({ open: async () => 'sess-ob', say: async () => true })
    await post(url, '/onboarding/session', {})
    const ok = await post(url, '/onboarding/say', { text: '叫我 Ben 就好' })
    expect(ok).toMatchObject({ status: 200, body: { ok: true, session_id: 'sess-ob' } })
    expect(said).toEqual([['sess-ob', '叫我 Ben 就好']])
    turns.handleDisposed('sess-ob')
    expect(await post(url, '/onboarding/say', { text: '还在吗' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('已经结束') } })
    expect(said).toHaveLength(1)
  })
  it('会话上一轮以错误结束(2026-09-23)→ 这句话先另开一条新会话(接着上次)再说进新的那条', async () => {
    let n = 0
    const { url, sent, said, turns } = await serve({ open: async () => `sess-${++n}`, say: async () => true })
    await post(url, '/onboarding/session', {})
    turns.handleEvent('sess-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } } } })
    const view = await getJson(url, '/onboarding/turns')
    expect(view.body).toMatchObject({ failed: true, turns: [expect.objectContaining({ role: 'assistant', kind: 'error' })] })
    const ok = await post(url, '/onboarding/say', { text: '叫我 Ben' })
    expect(ok).toMatchObject({ status: 200, body: { ok: true, session_id: 'sess-2' } })
    expect(sent).toHaveLength(2)
    // F(2026-09-23):工作台这边换的会话,他那头是同一段对话 —— 不问「上次到哪」,不提断线。
    expect(sent[1]).not.toContain('上次到哪,接着吗')
    expect(sent[1]).toContain('他不知道也不用知道')
    expect(said).toEqual([['sess-2', '叫我 Ben']])
    expect(turns.status()).toMatchObject({ session_id: 'sess-2', failed: false })
  })
  it('DSH 说这条会话没了(say 回 false)→ 409「重新开一次」', async () => {
    const { url } = await serve({ open: async () => 'sess-ob', say: async () => false })
    await post(url, '/onboarding/session', {})
    expect(await post(url, '/onboarding/say', { text: 'x' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('重新 POST /onboarding/session') } })
  })
  it('通道只能开不能续(老实现没有 say)→ 409 说清楚', async () => {
    const { url } = await serve({ open: async () => 'sess-ob' })
    await post(url, '/onboarding/session', {})
    expect(await post(url, '/onboarding/say', { text: 'x' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('会话通道没接上') } })
  })
  it('没接引导 → 404;非本机没令牌 → 401;已配对手机 → 200', async () => {
    const off = await serve({ withOnboarding: false })
    expect((await post(off.url, '/onboarding/say', { text: 'x' })).status).toBe(404)
    const { url, pairing, setRemote } = await serve({ open: async () => 'sess-ob', say: async () => true, withPairing: true })
    await post(url, '/onboarding/session', {})
    const code = pairing.start().code
    setRemote('10.86.37.5')
    const claimed = await post(url, '/pair/claim', { code, device_name: '测试机', platform: 'android' })
    const token = claimed.body.token as string
    expect((await post(url, '/onboarding/say', { text: 'x' })).status).toBe(401)
    expect(await post(url, '/onboarding/say', { text: 'x' }, { authorization: `Bearer ${token}` })).toMatchObject({ status: 200, body: { ok: true } })
  })
})

describe('GET /onboarding/turns', () => {
  const assistant = (text: string) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } })
  const userMsg = (text: string) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })

  it('开会话后种子句不算回合;事务官的话去掉代码块;after 只回之后的;busy / ended / stage 随带', async () => {
    const { url, sent, turns } = await serve({ open: async () => 'sess-ob', say: async () => true })
    const empty = await getJson(url, '/onboarding/turns')
    expect(empty).toMatchObject({ status: 200, body: { turns: [], busy: false, ended: false, stage: 'opening', done: false } })
    await post(url, '/onboarding/session', {})
    turns.handleEvent('sess-ob', userMsg(sent[0]!))
    turns.handleEvent('sess-ob', { type: 'turn/start', data: { turn: 1 } })
    turns.handleEvent('sess-ob', assistant('你好,很高兴认识你,我是你的专属事务官。\n\n```bash\ncurl -s http://127.0.0.1/onboarding/answer\n```\n你希望我怎么称呼你?'))
    const first = await getJson(url, '/onboarding/turns?after=0')
    expect(first.body).toMatchObject({ session_id: 'sess-ob', busy: true, ended: false, stage: 'opening' })
    expect(first.body.turns).toEqual([{ seq: 1, role: 'assistant', text: '你好,很高兴认识你,我是你的专属事务官。\n\n你希望我怎么称呼你?', at: '2026-09-15T01:00:00.000Z' }])
    turns.handleEvent('sess-ob', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    turns.handleEvent('sess-ob', userMsg('叫我 Ben'))
    const next = await getJson(url, '/onboarding/turns?after=1')
    expect(next.body).toMatchObject({ busy: false, turns: [{ seq: 2, role: 'user', text: '叫我 Ben' }] })
    expect((await getJson(url, '/onboarding/turns?after=abc')).status).toBe(400)
  })
  it('开场体验(2026-09-16):开会话回 seed 与 resumed;turns 随带当前阶段 seed;模型照念的种子句标 kind:seed,阶段推进后换下一句', async () => {
    const { url, turns } = await serve({ open: async () => 'sess-ob', say: async () => true })
    const opened = await post(url, '/onboarding/session', {})
    expect(opened.body).toMatchObject({ ok: true, stage: 'opening', seed: OPENING_LINE, resumed: false })
    expect((await getJson(url, '/onboarding/turns')).body).toMatchObject({ seed: OPENING_LINE })
    turns.handleEvent('sess-ob', assistant('我先读一下引导技能。'))
    // 模型把亲笔那句的半角逗号念成全角:仍是种子句。
    turns.handleEvent('sess-ob', assistant(OPENING_LINE.replace(/,/g, ',')))
    turns.handleEvent('sess-ob', assistant(OPENING_LINE))
    const first = await getJson(url, '/onboarding/turns')
    expect(first.body.turns).toEqual([
      expect.objectContaining({ seq: 1, role: 'assistant', text: '我先读一下引导技能。' }),
      expect.objectContaining({ seq: 2, role: 'assistant', kind: 'seed' }),
    ])
    // 2026-09-23:开场答完先到 ② 分岔(布局排在分岔之后)。
    // 2026-09-23 起回合表绑着当前会话时,答案要有「他亲口答的」凭据;这里他没开过口,由调用方带 heard。
    expect(await post(url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Ben', heard: { asked: OPENING_LINE, reply: '叫我 Ben' } })).toMatchObject({ status: 200, body: { advanced: true, stage: 'branch' } })
    const branchSeed = '你现在是已经有在做的事,还是想从一个新点子开始?'
    expect((await getJson(url, '/onboarding/turns')).body).toMatchObject({ stage: 'branch', seed: branchSeed })
    turns.handleEvent('sess-ob', assistant('Ben,记下了。'))
    turns.handleEvent('sess-ob', assistant(branchSeed))
    expect((await getJson(url, '/onboarding/turns?after=2')).body.turns).toEqual([
      expect.objectContaining({ seq: 3, text: 'Ben,记下了。' }),
      expect.objectContaining({ seq: 4, text: branchSeed, kind: 'seed' }),
    ])
    // 续做:resumed 为真,seed 仍是当前阶段的。
    const reopened = await post(url, '/onboarding/session', {})
    expect(reopened.body).toMatchObject({ stage: 'branch', seed: branchSeed, resumed: true })
  })
  it('回归(2026-09-16 真机开场白三遍):开会话 → 模型照念 → 从主页「接着引导」再开 → 模型又照念 → 回合表里只有一条、标 kind:seed', async () => {
    const { url, sent, said, turns } = await serve({ open: async () => 'sess-ob', say: async () => true })
    const first = await post(url, '/onboarding/session', {})
    expect(first.body).toMatchObject({ session_id: 'sess-ob', resumed: false, seed: OPENING_LINE })
    turns.handleEvent('sess-ob', userMsg(sent[0]!))
    turns.handleEvent('sess-ob', assistant(OPENING_LINE.replace(/,/g, ',')))
    const again = await post(url, '/onboarding/session', {})
    expect(again.body).toMatchObject({ session_id: 'sess-ob', resumed: true, seed: OPENING_LINE })
    // 续做那条消息排进了原会话,不是新开;里面没有开场白。
    expect(sent).toHaveLength(1)
    expect(said).toHaveLength(1)
    expect(said[0]![1]).not.toContain(OPENING_LINE)
    turns.handleEvent('sess-ob', userMsg(said[0]![1]))
    turns.handleEvent('sess-ob', assistant(OPENING_LINE))
    const list = (await getJson(url, '/onboarding/turns')).body.turns as { role: string, kind?: string }[]
    expect(list).toEqual([expect.objectContaining({ seq: 1, role: 'assistant', kind: 'seed' })])
  })
  it('restart 清空回合表;没接回合表时回空数组不报错', async () => {
    const { url, turns } = await serve({ open: async () => 'sess-ob', say: async () => true })
    await post(url, '/onboarding/session', {})
    turns.handleEvent('sess-ob', assistant('一'))
    expect(((await getJson(url, '/onboarding/turns')).body.turns as unknown[]).length).toBe(1)
    await post(url, '/onboarding/restart', { scope: 'all' })
    expect((await getJson(url, '/onboarding/turns')).body).toMatchObject({ turns: [], busy: false, ended: false, stage: 'opening' })
    const bare = await serve({ open: async () => 'sess-ob', withTurns: false })
    await post(bare.url, '/onboarding/session', {})
    expect((await getJson(bare.url, '/onboarding/turns')).body).toMatchObject({ turns: [], busy: false, ended: false })
  })
})

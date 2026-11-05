// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'
import { createMcpSecrets } from '../src/server/mcpSecrets.ts'
import { createGitHubDevice, githubRepoOf } from '../src/server/githubDevice.ts'
import { createTimerRunner } from '../src/server/collabTimers.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const PAGE = { origin: 'http://127.0.0.1:3080' }

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collab-full-'))
  dirs.push(dir)
  return dir
}

/** 假 GitHub:设备码 → 第一次轮询还在等 → 第二次给令牌;/user 回登录名;PR 列表回一条。 */
function fakeGitHub() {
  let polls = 0
  const seen: string[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    seen.push(`${init?.method ?? 'GET'} ${url}`)
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
    if (url === 'https://github.com/login/device/code') return json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    if (url === 'https://github.com/login/oauth/access_token') { polls += 1; return polls === 1 ? json({ error: 'authorization_pending' }) : json({ access_token: 'gho_secret' }) }
    if (url === 'https://api.github.com/user') return json({ login: 'ben' })
    if (url.startsWith('https://api.github.com/repos/ben/workbench/pulls')) return json([{ number: 12, title: '协作区', html_url: 'https://github.com/ben/workbench/pull/12', state: 'open', user: { login: 'ben' } }])
    return json({}, 404)
  }) as typeof fetch
  return { impl, seen }
}

async function serve(opts: { clientId?: string } = {}) {
  const dir = tempDir()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const gh = fakeGitHub()
  const github = createGitHubDevice({ file: join(dir, 'github.json'), clientId: async () => opts.clientId, fetch: gh.impl, schedule: () => {} })
  const mcpSecrets = createMcpSecrets({ file: join(dir, 'mcp-secrets.json') })
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService({ now: () => NOW_SEC }), tickIntervalMs: 0, tasks,
    personalTokens: createPersonalTokens({ file: join(dir, 'pat.json') }), githubDevice: github, mcpSecrets,
    collabWorkdir: async () => join(dir, 'work'),
  })
  started.push(server)
  return { url: server.url, dir, tasks, github, gh }
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
const state = async (url: string) => await (await fetch(`${url}/state`)).json() as WorkbenchState

describe('便签时间 / 类型 / 协作 / 小队 / PR 走 /task/*', () => {
  it('建与改;null 清掉时间', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T11:00:00+08:00', work_type: 'meeting', collaborators: ['claude'] })
    expect((await state(url)).tasks?.tasks[0]).toMatchObject({ start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T11:00:00+08:00', work_type: 'meeting', collaborators: ['claude'] })
    await post(url, '/task/update', { id: 't-1', start: null, end: null, squad_id: 'sq-1' })
    const note = (await state(url)).tasks?.tasks[0]
    expect(note?.start).toBeUndefined()
    expect(note?.squad_id).toBe('sq-1')
  })
})

describe('小队', () => {
  it('建 → /state.tasks.squads;删', async () => {
    const { url } = await serve()
    const made = await post(url, '/collab/squad/save', { name: '前端组', leader: 'me', members: ['codex'] })
    expect(made.status).toBe(200)
    expect((await state(url)).tasks?.squads).toMatchObject([{ name: '前端组', leader: 'me', members: ['codex'] }])
    expect((await post(url, '/collab/squad/remove', { id: made.body.id })).status).toBe(200)
    expect((await state(url)).tasks?.squads).toEqual([])
  })
})

describe('定时派活', () => {
  it('存一条;现在跑一次 = 建一张四样齐的便签,记一次运行', async () => {
    const { url } = await serve()
    const made = await post(url, '/collab/timer/save', { name: '周报', trigger: { kind: 'cron', cron: '0 9 * * 1' }, assignee: 'me', template: { title: '写周报', acceptance: ['发到群里'] } })
    expect(made.status).toBe(200)
    const ran = await post(url, '/collab/timer/run', { id: made.body.id })
    expect(ran.status).toBe(200)
    const s = await state(url)
    expect(s.tasks?.tasks[0]).toMatchObject({ title: '写周报', acceptance: ['发到群里'], assignee: 'me', work_type: 'routine', from: { kind: 'user', ref: `timer:${String(made.body.id)}` } })
    expect(s.tasks?.timers?.[0]?.runs).toMatchObject([{ ok: true, note_id: s.tasks?.tasks[0]?.id }])
  })
  it('cron 写错 400', async () => {
    const { url } = await serve()
    expect((await post(url, '/collab/timer/save', { name: 'x', trigger: { kind: 'cron', cron: '1-5 * * * *' }, assignee: 'me', template: { title: 'a', acceptance: ['b'] } })).status).toBe(400)
  })
  it('节拍:到点那一分钟跑一次,同一分钟不重复', async () => {
    const dir = tempDir()
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
    await tasks.saveTimer({ name: '每刻', trigger: { kind: 'cron', cron: '*/15 * * * *' }, assignee: 'me', template: { title: 'x', acceptance: ['y'] } })
    let now = new Date(2026, 9, 21, 9, 15, 5)
    const runner = createTimerRunner({ tasks, now: () => now })
    await runner.pump()
    now = new Date(2026, 9, 21, 9, 15, 40)
    await runner.pump()
    now = new Date(2026, 9, 21, 9, 16, 0)
    await runner.pump()
    expect((await tasks.list()).tasks).toHaveLength(1)
  })
})

describe('工作室 MCP 库:密钥值只在本机,不回界面', () => {
  it('条目进账;填密钥后 missing 变空;盘上那份 600;值不出现在 /state', async () => {
    const { url, dir } = await serve()
    await post(url, '/collab/mcp/save', { name: 'Figma', url_template: 'https://mcp.figma.com/{FIGMA_TOKEN}', secret_names: ['FIGMA_TOKEN'] })
    expect((await state(url)).tasks?.mcp?.[0]?.missing).toEqual(['FIGMA_TOKEN'])
    expect((await post(url, '/collab/mcp/secret', { name: 'FIGMA_TOKEN', value: 'figd_very_secret' })).status).toBe(403)
    const filled = await post(url, '/collab/mcp/secret', { name: 'FIGMA_TOKEN', value: 'figd_very_secret' }, PAGE)
    expect(filled.body).toEqual({ ok: true, filled: true })
    const s = await state(url)
    expect(s.tasks?.mcp?.[0]?.missing).toEqual([])
    expect(JSON.stringify(s)).not.toContain('figd_very_secret')
    expect(statSync(join(dir, 'mcp-secrets.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, 'mcp-secrets.json'), 'utf8')).toContain('figd_very_secret')
  })
})

describe('GitHub 设备码登录', () => {
  it('没配 client id → unconfigured,如实说', async () => {
    const { url } = await serve()
    expect(await (await fetch(`${url}/collab/github`)).json()).toEqual({ state: 'unconfigured' })
  })
  it('开始 → 设备码;轮询两次连上;令牌只在本机文件,不回界面;PR 列表、挂到便签', async () => {
    const { url, dir, github, tasks } = await serve({ clientId: 'Iv1.test' })
    const started = await post(url, '/collab/github/start', {}, PAGE)
    expect(started.body).toMatchObject({ state: 'pending', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device' })
    expect(await github.poll()).toMatchObject({ state: 'pending' })
    expect(await github.poll()).toEqual({ state: 'connected', login: 'ben' })
    const view = await (await fetch(`${url}/collab/github`)).json()
    expect(JSON.stringify(view)).not.toContain('gho_secret')
    expect(statSync(join(dir, 'github.json')).mode & 0o777).toBe(0o600)
    await tasks.setProjectMeta('p1', { repos: [{ local_path: '/repo', remote_url: 'git@github.com:ben/workbench.git' }] })
    const pulls = await (await fetch(`${url}/collab/github/pulls?project_id=p1`)).json() as { pulls: { number: number }[] }
    expect(pulls.pulls).toMatchObject([{ repo: 'ben/workbench', number: 12, title: '协作区' }])
    await post(url, '/task/create', { title: 'a' })
    expect((await post(url, '/collab/github/attach', { pr: 'ben/workbench#12', note_id: 't-1' }, PAGE)).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.pull_requests).toEqual(['ben/workbench#12'])
    await post(url, '/collab/github/disconnect', {}, PAGE)
    expect(await (await fetch(`${url}/collab/github`)).json()).toEqual({ state: 'disconnected' })
  })
  it('认得 GitHub 远端地址的几种写法', () => {
    expect(githubRepoOf('https://github.com/ben/workbench.git')).toEqual({ owner: 'ben', repo: 'workbench' })
    expect(githubRepoOf('git@github.com:ben/workbench.git')).toEqual({ owner: 'ben', repo: 'workbench' })
    expect(githubRepoOf('https://gitlab.com/ben/x')).toBeUndefined()
  })
})

describe('个人访问令牌:多枚、写用途、上次用的时间', () => {
  it('不写用途不发;发两枚、列表只给用途与开头;撤一枚', async () => {
    const { url } = await serve()
    expect((await post(url, '/token/personal/issue', {}, PAGE)).status).toBe(400)
    const a = await post(url, '/token/personal/issue', { purpose: '本机脚本' }, PAGE)
    const b = await post(url, '/token/personal/issue', { purpose: 'Codex 读板' }, PAGE)
    expect(String(a.body.token)).toMatch(/^wbp_/)
    const listed = await (await fetch(`${url}/token/personal`)).json() as { tokens: { id: string, purpose: string, last_used_at?: string }[] }
    expect(listed.tokens.map(one => one.purpose)).toEqual(['本机脚本', 'Codex 读板'])
    expect(JSON.stringify(listed)).not.toContain(String(a.body.token))
    // 带着它打一条:上次用的时间记上
    await fetch(`${url}/state`, { headers: { authorization: `Bearer ${String(b.body.token)}` } })
    const after = await (await fetch(`${url}/token/personal`)).json() as { tokens: { purpose: string, last_used_at?: string }[] }
    expect(after.tokens[1]?.last_used_at).toBeDefined()
    const revoked = await post(url, '/token/personal/revoke', { id: listed.tokens[0]?.id }, PAGE)
    expect(revoked.status).toBe(200)
    expect((await (await fetch(`${url}/state`, { headers: { authorization: `Bearer ${String(a.body.token)}` } })).status)).toBe(401)
  })
})

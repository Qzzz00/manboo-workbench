// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORKBENCH_URL, USAGE, planCommand, runCli } from '../src/cli/workbench.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'

describe('命令行怎么翻成 8791 的请求(薄壳,不在本地改任何东西)', () => {
  it('note create:四样各有一个参数;--accept 可以给几次', () => {
    expect(planCommand(['note', 'create', '--title', '换铃声', '--from', 'said:换个柔和的', '--accept', '手机响一次', '--accept', '电脑也响', '--assignee', 'codex', '--goal', 'g-1'])).toEqual({
      method: 'POST', path: '/task/create',
      body: { title: '换铃声', note: true, from: { kind: 'said', quote: '换个柔和的' }, acceptance: ['手机响一次', '电脑也响'], assignee: 'codex', goal_id: 'g-1' },
    })
  })
  it('--from 的几种写法:会议 / 会话 / 证据', () => {
    expect((planCommand(['note', 'create', '--title', 'a', '--from', 'meeting:m-1']) as unknown as { body: { from: unknown } }).body.from).toEqual({ kind: 'meeting', ref: 'm-1' })
    expect((planCommand(['note', 'create', '--title', 'a', '--from', 'session:codex:abc']) as unknown as { body: { from: unknown } }).body.from).toEqual({ kind: 'session', ref: 'codex:abc' })
  })
  it('note move / receipt / comment', () => {
    expect(planCommand(['note', 'move', 't-1', 'doing'])).toEqual({ method: 'POST', path: '/task/move', body: { id: 't-1', status: 'doing' } })
    expect(planCommand(['note', 'receipt', 't-1', 'done', '做完:1 好了', '--evidence', '/tmp/a.png', '--by', 'codex'])).toEqual({
      method: 'POST', path: '/task/receipt', body: { id: 't-1', receipt: 'done', text: '做完:1 好了', evidence: ['/tmp/a.png'], by: 'codex' },
    })
    expect(planCommand(['note', 'comment', 't-1', '再暗一点'])).toEqual({ method: 'POST', path: '/task/comment', body: { id: 't-1', text: '再暗一点' } })
  })
  it('goal / agent / migrate', () => {
    expect(planCommand(['goal', 'create', '--title', '座机打通', '--why', '出门能接', '--due', '2026-10-30'])).toEqual({
      method: 'POST', path: '/collab/goal/create', body: { title: '座机打通', why: '出门能接', due: '2026-10-30' },
    })
    expect(planCommand(['goal', 'update', 'g-1', '--status', 'reached'])).toEqual({ method: 'POST', path: '/collab/goal/update', body: { id: 'g-1', status: 'reached' } })
    expect(planCommand(['agent', 'create', '--name', '代码 Agent', '--hand', 'codex', '--skills', '前端,测试'])).toEqual({
      method: 'POST', path: '/collab/agent/save', body: { name: '代码 Agent', hand: 'codex', skills: ['前端', '测试'] },
    })
    expect(planCommand(['migrate', 'rollback'])).toEqual({ method: 'POST', path: '/collab/migrate/rollback', body: {} })
    expect(planCommand(['note', 'list'])).toMatchObject({ method: 'GET', path: '/state', pick: 'notes' })
  })
  it('认不出的命令 → 用法', () => {
    expect(planCommand([])).toEqual({ help: USAGE })
    expect(planCommand(['note', 'fly'])).toMatchObject({ error: expect.stringContaining('note fly') })
  })
})

describe('真打一台本机服务:带个人访问令牌', () => {
  const started: WorkbenchServer[] = []
  const dirs: string[] = []
  afterEach(async () => {
    while (started.length) await started.pop()?.close()
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  it('建一张便签 → 回 id;不带令牌、授权表不放行时 403 原样说出来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cli-'))
    dirs.push(dir)
    const tokens = createPersonalTokens({ file: join(dir, 'pat.json') })
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0,
      tasks: createTasksService({ file: join(dir, 'tasks.json') }),
      personalTokens: tokens,
      authorization: { isAllowed: async () => false, denialMessage: () => '授权表没放开写接口' } as never,
    })
    started.push(server)
    const out: string[] = []
    const argv = ['note', 'create', '--title', '换铃声', '--from', 'said:换', '--accept', '响一次', '--assignee', 'codex']
    expect(await runCli(argv, { WORKBENCH_URL: server.url }, line => out.push(line))).toBe(1)
    expect(out.join('\n')).toContain('授权表没放开写接口')
    out.length = 0
    const token = await tokens.issue()
    expect(await runCli(argv, { WORKBENCH_URL: server.url, WORKBENCH_TOKEN: token }, line => out.push(line))).toBe(0)
    expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true })
  })

  it('默认打本机 8791', () => {
    expect(DEFAULT_WORKBENCH_URL).toBe('http://127.0.0.1:8791')
  })
})

// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { locateCodexCliSession } from '../src/server/cliSessionRead.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createSessionTranscript } from '../src/server/sessionTranscript.ts'

const dirs: string[] = []
const servers: WorkbenchServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fixture(raw?: string) {
  const home = mkdtempSync(join(tmpdir(), 'qa-codex-source-')); dirs.push(home)
  const cwd = join(home, 'qa-project'); mkdirSync(cwd)
  const sessions = join(home, 'sessions', '2026', '10', '24'); mkdirSync(sessions, { recursive: true })
  const id = '019a0000-0000-7000-8000-000000000001'
  const file = join(sessions, `rollout-2026-10-24T01-00-00-${id}.jsonl`)
  const rows = [JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'exec' } })]
  for (let n = 0; n < 15; n++) {
    rows.push(JSON.stringify({ timestamp: '2026-10-24T02:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `验收问题第${n}项` }] } }))
    rows.push(JSON.stringify({ timestamp: '2026-10-24T02:00:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `验收回答第${n}项` }] } }))
  }
  writeFileSync(file, raw === undefined ? rows.join('\n') + '\n' : rows[0] + '\n' + raw)
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(id, file, cwd); db.close()
  return { home, cwd, id, file }
}

describe('已登记 Codex CLI：精确 id、本机路径和项目匹配', () => {
  it('精确查询 index 并复用分页解析，前后页不丢原文', async () => {
    const f = fixture()
    const ref = await locateCodexCliSession({ codexHome: f.home, sessionId: f.id, cwds: [f.cwd] })
    expect(ref?.file).toBe(realpathSync(f.file))
    const reader = createSessionTranscript({ locate: async () => ref })
    const page = await reader.read({ agent: 'codex', id: f.id, rounds: 2 })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.value.entries.filter(t => t.k === 'reply').map(t => 'text' in t ? t.text : '')).toContain('验收回答第14项')
    expect(page.value.before).toBeDefined()
    const prev = await reader.read({ agent: 'codex', id: f.id, before: page.value.before, rounds: 2 })
    expect(prev.ok).toBe(true)
    if (prev.ok) expect(prev.value.entries.filter(t => t.k === 'reply').map(t => 'text' in t ? t.text : '')).not.toContain('验收回答第14项')
  })
  it('错误项目、未知 id、任意路径和缺文件不读', async () => {
    const f = fixture()
    for (const [sessionId, cwds] of [[f.id, ['/other-project']], ['../private', [f.cwd]], ['unknown-session', [f.cwd]]] as const) {
      expect(await locateCodexCliSession({ codexHome: f.home, sessionId, cwds })).toBeUndefined()
    }
    rmSync(f.file)
    expect(await locateCodexCliSession({ codexHome: f.home, sessionId: f.id, cwds: [f.cwd] })).toBeUndefined()
  })
  it('index 指错 meta id、或文件软链越过本机 Codex sessions 根均拒绝', async () => {
    const f = fixture()
    writeFileSync(f.file, JSON.stringify({ type: 'session_meta', payload: { id: 'other-session', cwd: f.cwd } }))
    expect(await locateCodexCliSession({ codexHome: f.home, sessionId: f.id, cwds: [f.cwd] })).toBeUndefined()
    rmSync(f.file)
    const outside = join(f.home, 'outside.jsonl')
    writeFileSync(outside, JSON.stringify({ type: 'session_meta', payload: { id: f.id, cwd: f.cwd } }))
    symlinkSync(outside, f.file)
    expect(await locateCodexCliSession({ codexHome: f.home, sessionId: f.id, cwds: [f.cwd] })).toBeUndefined()
  })
})


it('HTTP 已登记来源读回同 transcript/digest 契约，权限撤回/项目不符不走宽扫描', async () => {
  const f = fixture()
  let allowed = true
  const tasks = createTasksService({ file: join(f.home, 'tasks.json') })
  const created = await tasks.create({ title: 'QA Codex 原件', links: [{ agent: 'codex', session_id: f.id }] })
  if (!created.ok || created.id === undefined) throw new Error('create failed')
  await tasks.update(created.id, { dispatch: { family: 'codex', hand: 'cli', status: 'done', cwd: f.cwd, session_id: f.id, started_at: new Date().toISOString() } })
  let broadReads = 0
  const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({}), tasks, tickIntervalMs: 0,
    paths: { home: f.home, config: {} } as never,
    authorization: { isAllowed: async () => allowed, denialMessage: () => '尚未允许读客户端文件' } as never,
    sessionLibrary: { transcript: async () => { broadReads++; return { ok: false, status: 404, error: '不应走这里' } } } as never,
  })
  servers.push(server)
  // 此处 fixture home 就是 CODEX_HOME；经服务端显式路径解析，不读取个人目录。
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = f.home
  try {
    const get = (route: string) => fetch(`${server.url}/sessions/${route}?agent=codex&id=${f.id}`)
    const response = await get('transcript')
    expect(response.status).toBe(200)
    const body = await response.json() as { entries: { k: string, text?: string }[], before?: string }
    expect(body.entries.some(e => e.k === 'reply' && e.text === '验收回答第14项')).toBe(true)
    expect(body.before).toBeDefined()
    const previous = await fetch(`${server.url}/sessions/transcript?agent=codex&id=${f.id}&before=${body.before}`)
    expect(previous.status).toBe(200)
    expect((await previous.json() as { entries: { text?: string }[] }).entries.some(e => e.text === '验收回答第14项')).toBe(false)
    const digest = await get('digest')
    expect(digest.status).toBe(200)
    expect(JSON.stringify(await digest.json())).toContain('验收回答第14项')
    allowed = false
    expect((await get('transcript')).status).toBe(403)
    expect((await get('digest')).status).toBe(403)
    allowed = true
    await tasks.update(created.id, { dispatch: { family: 'codex', hand: 'cli', status: 'done', cwd: '/another-host/project', session_id: f.id, started_at: new Date().toISOString() } })
    expect((await get('transcript')).status).toBe(404)
    expect((await get('digest')).status).toBe(404)
    expect(broadReads).toBe(0)
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old }
})

it('自然执行的同一原件：已登记来源 digest 不丢仅含标识符的 final reply', async () => {
  const raw = readFileSync(new URL('./fixtures/codex-natural-final-digest.jsonl', import.meta.url), 'utf8')
  const f = fixture(raw)
  const tasks = createTasksService({ file: join(f.home, 'tasks.json') })
  const created = await tasks.create({ title: 'QA 原件读回', links: [{ agent: 'codex', session_id: f.id }] })
  if (!created.ok || created.id === undefined) throw new Error('create failed')
  await tasks.update(created.id, { dispatch: { family: 'codex', hand: 'cli', status: 'done', cwd: f.cwd, session_id: f.id, started_at: new Date().toISOString() } })
  const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({}), tasks, tickIntervalMs: 0, heartbeatMs: 0,
    authorization: { isAllowed: async () => true } as never,
  })
  servers.push(server)
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = f.home
  try {
    const transcript = await fetch(`${server.url}/sessions/transcript?agent=codex&id=${f.id}`)
    expect(transcript.status).toBe(200)
    expect((await transcript.json() as { entries: { k: string, text?: string, final?: boolean }[] }).entries)
      .toContainEqual(expect.objectContaining({ k: 'reply', text: 'QA_1C_SUGGEST_REAL', final: true }))
    const digest = await fetch(`${server.url}/sessions/digest?agent=codex&id=${f.id}`)
    expect(digest.status).toBe(200)
    expect((await digest.json() as { rounds: { reply?: string }[] }).rounds)
      .toContainEqual(expect.objectContaining({ reply: 'QA_1C_SUGGEST_REAL' }))
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old }
})

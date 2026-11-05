// @vitest-environment node
/**
 * `POST /topic/<选题名>/review`(2026-09-22 卡④):复盘自评落盘的那一条路由。
 *
 * 这一份钉的是**传输层的三种回答分得开**(同 `/task/move` 那一套口径):
 * 收不了的 400 + 原话、工作目录没配 409、写成了 200;以及那条最要紧的分寸 ——
 * **复盘落了、经验没落,仍然是 200**,原因写进 `note`。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { TOPIC_DIR } from '../src/templates.ts'
import { ACCOUNT_EXPERIENCE_FILE, ACCOUNT_FILE_NAME } from '../src/server/accounts.ts'
import { TOPIC_REVIEW_FILE } from '../src/server/topicReview.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const NOW_SEC = Math.floor(Date.parse('2026-09-22T09:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve(opts: { withCwd?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-topic-review-'))
  dirs.push(dir)
  const cwd = join(dir, '运营')
  mkdirSync(cwd, { recursive: true })
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC })
  let layout: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
    // 2026-10-23(分层二刀二):ops 模板的内容在用户层起步层,本体只剩 product —— 用例里注入这一份。
    templates: () => [OPS_TEMPLATE],
    ...(opts.withCwd === false ? {} : { butlerCwd: () => cwd }),
  })
  await template.load()
  await template.apply('ops')
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    template,
  })
  started.push(server)
  return { url: server.url, cwd }
}

async function review(url: string, name: string, body: unknown) {
  const res = await fetch(`${url}/topic/${encodeURIComponent(name)}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('POST /topic/<名>/review', () => {
  it('写成了:复盘.md 多一节,经验一句话落进账号的经验.md', async () => {
    const { url, cwd } = await serve()
    mkdirSync(join(cwd, '账号', '小食堂'), { recursive: true })
    writeFileSync(join(cwd, '账号', '小食堂', ACCOUNT_FILE_NAME), '# 小食堂\n', 'utf8')

    const res = await review(url, '露营锅具怎么选', {
      score: 4, good: '开头那句钩子', bad: '结尾没给关注理由',
      next: '结尾加一句', lesson: '封面放人脸比放锅好', account: '小食堂',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, appended: true })

    const text = readFileSync(join(cwd, TOPIC_DIR, '露营锅具怎么选', TOPIC_REVIEW_FILE), 'utf8')
    expect(text).toContain('- **自评分**:4/5')
    expect(text).toContain('- **差在哪**:结尾没给关注理由')
    const experience = readFileSync(join(cwd, '账号', '小食堂', ACCOUNT_EXPERIENCE_FILE), 'utf8')
    expect(experience).toContain('封面放人脸比放锅好(《露营锅具怎么选》复盘自评)')
  })

  it('★ 复盘落了、经验没落(没说归哪个账号)→ 仍然 200,note 里说清楚', async () => {
    const { url, cwd } = await serve()
    const res = await review(url, '露营锅具怎么选', { score: 3, lesson: '开头要快' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(String(res.body.note)).toContain('没说归哪个账号')
    expect(readFileSync(join(cwd, TOPIC_DIR, '露营锅具怎么选', TOPIC_REVIEW_FILE), 'utf8')).toContain('- **自评分**:3/5')
  })

  it('★ 五格一格都没填:400 + 原话,盘上什么都不建', async () => {
    const { url } = await serve()
    const res = await review(url, '露营锅具怎么选', {})
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('一格都没填')
  })

  it('★ 自评分不在 1–5:400 + 原话', async () => {
    const { url } = await serve()
    expect((await review(url, '露营锅具怎么选', { score: 9 })).status).toBe(400)
  })

  it('选题名带斜杠:路由根本不匹配(404),不是 400 也不是悄悄改名', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/topic/a/b/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(404)
  })

  it('★ 没配工作目录:409 + 原话,不猜一条路径', async () => {
    const { url } = await serve({ withCwd: false })
    const res = await review(url, '露营锅具怎么选', { score: 3 })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('工作目录')
  })

  it('同一份自评发两遍:第二遍 appended:false(幂等)', async () => {
    const { url } = await serve()
    const body = { score: 4, good: '开头那句钩子' }
    expect((await review(url, '露营锅具怎么选', body)).body.appended).toBe(true)
    expect((await review(url, '露营锅具怎么选', body)).body.appended).toBe(false)
  })
})

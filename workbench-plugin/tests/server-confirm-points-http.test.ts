// @vitest-environment node
/**
 * 接需求先给确认点 —— **三条路由**(2026-09-23,维护者 13:05:「不能假装自己搞懂了」)。
 *
 *   POST /confirm/points   { text }                 规则的唯一出口(电话那条链路也走它)
 *   POST /feature/confirm  { id, points? }          需求卡:先生成 → 她答完 → 写回 + 留痕 + 生成验收
 *   POST /topic/confirm    { id, name, points? }    选题卡:同一套
 *
 * 这一份钉的性质:
 *
 * 1. **没答之前不派活**:`/feature/run`(`/topic/run`)在没过确认点时,那段话里明写着不许派;
 * 2. **纠正之后写得回去**:他改的那一条原话进 `需求.md` 顶部那一节,而且段外一个字不动;
 * 3. **留痕**:`审核记录.jsonl` 里多一行 `confirm_points`,含他改了哪几条;
 * 4. **验收标准从确认点生成**,不是另写一份。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectsState, WorkbenchLayout } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { TOPIC_DIR } from '../src/templates.ts'
import { FEATURE_DIR_REL, FEATURE_DOC_FILES } from '../src/server/featureRun.ts'
import { TOPIC_DOC_FILES } from '../src/server/topicRun.ts'
import { REVIEW_LOG_NAME } from '../src/server/deckRun.ts'
import { ACCEPTANCE_SECTION_TITLE, CONFIRM_SECTION_TITLE } from '../src/server/confirmPoints.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const NOW_SEC = Math.floor(Date.parse('2026-09-23T05:00:00Z') / 1000)
/** 09-23 那一句原话。 */
const NEED = '把音色改成可配置的,而且我在电话通话中能够改'
const TITLE = '音色可配置'
const TOPIC = '露营锅具怎么选'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeButler() {
  const said: { session: string, text: string }[] = []
  return {
    said,
    port: {
      open: async () => 'sess-1',
      say: async (session: string, text: string) => { said.push({ session, text }); return true },
    },
  }
}

function fakeProjects(path: string): ProjectsService {
  const state: ProjectsState = {
    projects: [{ id: 'p-1', name: '工作台', stage: 'dev' as never, path, links: [], session_count: 0, idle: true }],
    pending: [],
    scan_errors: [],
    scanned_at: '',
  }
  return { getProjectsState: async () => state, getLayout: async () => undefined } as unknown as ProjectsService
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').split('\n').filter(one => one.trim() !== '')
    .map(one => JSON.parse(one) as Record<string, unknown>)
}

/** 需求卡那一套(项目区 + 一个临时仓库)。 */
async function serveFeature(opts: { stage?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-confirm-feature-'))
  dirs.push(dir)
  const repo = join(dir, '她的项目')
  mkdirSync(repo, { recursive: true })
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const butler = fakeButler()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    projects: fakeProjects(repo),
    butlerSession: butler.port,
    // 这一份不谈「代做」(那一条在 server-feature-deck-http 里),所以窗口编排壳不注进来。
  })
  started.push(server)
  const created = await post(server.url, '/task/create', {
    title: TITLE, desc: NEED, kind: 'feature', project_id: 'p-1',
  })
  const id = String(created.body.id)
  await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
  if (opts.stage !== undefined) await post(server.url, '/task/update', { id, feature_stage: opts.stage })
  return { url: server.url, id, butler, featureDir: join(repo, FEATURE_DIR_REL, TITLE) }
}

/** 选题卡那一套(运营模板 + 工作目录)。 */
async function serveTopic(opts: { stage?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-confirm-topic-'))
  dirs.push(dir)
  const cwd = join(dir, '运营')
  mkdirSync(cwd, { recursive: true })
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  let layout: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
    // 2026-10-23(分层二刀二):ops 模板的内容在用户层起步层,本体只剩 product —— 用例里注入这一份。
    templates: () => [OPS_TEMPLATE],
    butlerCwd: () => cwd,
  })
  await template.load()
  await template.apply('ops')
  const butler = fakeButler()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    template,
    butlerSession: butler.port,
    model: { endpoint: () => Promise.resolve({ mode: 'relay', baseUrl: 'x', key: 'y', ready: true }) } as never,
  })
  started.push(server)
  const created = await post(server.url, '/task/create', {
    title: TOPIC, desc: '我想做一期讲露营锅具怎么选的', kind: 'topic', stage: opts.stage ?? '灵感',
  })
  const id = String(created.body.id)
  await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
  return { url: server.url, id, butler, topicDir: join(cwd, TOPIC_DIR, TOPIC) }
}

/* ──────────────────────── /confirm/points ──────────────────────── */

describe('/confirm/points:规则的唯一出口', () => {
  it('★ 回来的是按他这句话挑的几条 + 成形的那两段(卡上那份 / 电话里那份)', async () => {
    const { url } = await serveFeature()
    const res = await post(url, '/confirm/points', { text: NEED })
    expect(res.status).toBe(200)
    const points = res.body.points as { ask: string, guess: string }[]
    expect(points.length).toBeGreaterThanOrEqual(2)
    expect(points.length).toBeLessThanOrEqual(4)
    expect(points[points.length - 1]?.ask).toBe('怎么算做完')
    expect(String(res.body.block)).toContain('哪条不对说一下,都对就开工。')
    // 电话里那一份最多三条(维护者第 4 条)。
    expect(String(res.body.spoken)).not.toContain('④')
  })

  it('空话 400,**不编一句需求出来**', async () => {
    const { url } = await serveFeature()
    expect((await post(url, '/confirm/points', { text: '   ' })).status).toBe(400)
  })
})

/* ──────────────────────── 需求卡 ──────────────────────── */

describe('/feature/confirm', () => {
  it('★ 不带 points = 只生成:不写盘、不留痕,confirmed 仍是 false', async () => {
    const { url, id, featureDir } = await serveFeature()
    const res = await post(url, '/feature/confirm', { id })
    expect(res.status).toBe(200)
    expect(res.body.confirmed).toBe(false)
    expect(res.body.need).toBe(NEED)
    expect((res.body.points as unknown[]).length).toBeGreaterThanOrEqual(2)
    expect(() => readFileSync(join(featureDir, FEATURE_DOC_FILES.需求), 'utf8')).toThrow()
  })

  it('★★ 她逐条答完 → 写进 需求.md 顶部那一节 + 留痕 + 按确认点生成验收标准', async () => {
    const { url, id, featureDir } = await serveFeature()
    const made = await post(url, '/feature/confirm', { id })
    const points = (made.body.points as { ask: string, guess: string }[]).map((one, index) => (
      index === 0 ? { ...one, answer: '他模糊描述、或者她播一段样音,她去库里挑' } : one
    ))
    const res = await post(url, '/feature/confirm', { id, points })
    expect(res.status).toBe(200)
    expect(res.body.confirmed).toBe(true)
    expect(res.body.changed).toEqual([1])

    // ① 产物里那一节
    const text = readFileSync(join(featureDir, FEATURE_DOC_FILES.需求), 'utf8')
    expect(text).toContain(`## ${CONFIRM_SECTION_TITLE}`)
    expect(text).toContain('已确认')
    expect(text).toContain('他模糊描述、或者她播一段样音,她去库里挑')
    // ② 验收标准由确认点生成,回包里那几行与文件里一致
    expect(text).toContain(`## ${ACCEPTANCE_SECTION_TITLE}`)
    for (const line of res.body.acceptance as string[]) expect(text).toContain(line)
    // ③ 留痕
    const log = lines(join(featureDir, REVIEW_LOG_NAME))
    expect(log).toHaveLength(1)
    expect(log[0]?.action).toBe('confirm_points')
    expect(log[0]?.changed).toEqual([1])
    expect((log[0]?.points as string[])[0]).toContain('她去库里挑')
  })

  it('★ 已有的正文**段外一个字不动**', async () => {
    const { url, id, featureDir } = await serveFeature()
    mkdirSync(featureDir, { recursive: true })
    writeFileSync(join(featureDir, FEATURE_DOC_FILES.需求), '# 音色可配置\n\n## 目标\n\n能在电话里换。\n', 'utf8')
    const made = await post(url, '/feature/confirm', { id })
    await post(url, '/feature/confirm', { id, points: made.body.points })
    const text = readFileSync(join(featureDir, FEATURE_DOC_FILES.需求), 'utf8')
    expect(text).toContain('# 音色可配置')
    expect(text).toContain('能在电话里换。')
    expect(text.indexOf(`## ${CONFIRM_SECTION_TITLE}`)).toBeLessThan(text.indexOf('## 目标'))
  })

  it('缺默认理解 / 条数出界 → 400,**一个字都不代她补**', async () => {
    const { url, id } = await serveFeature()
    expect((await post(url, '/feature/confirm', { id, points: [{ ask: 'a' }, { ask: 'b', guess: 'c' }] })).status).toBe(400)
    expect((await post(url, '/feature/confirm', { id, points: [{ ask: 'a', guess: 'b' }] })).status).toBe(400)
  })
})

describe('★★ 没答之前不派活(需求卡)', () => {
  it('未确认 + 拆解与派活 → 那段话里明写「这一次一件都不要派」', async () => {
    const { url, id, butler } = await serveFeature({ stage: '拆解与派活' })
    const res = await post(url, '/feature/run', { id })
    expect(res.status).toBe(200)
    expect(res.body.confirmed).toBeUndefined() // 回包不多一个字段;门写在话里
    const text = String(res.body.text)
    expect(text).toContain('还没过确认点')
    expect(text).toContain('这一次一件都不要派')
    expect(butler.said[0]?.text).toContain('这一次一件都不要派')
  })

  it('未确认 + 梳理 → 那段话里就是那个固定形状', async () => {
    const { url, id } = await serveFeature()
    const text = String((await post(url, '/feature/run', { id })).body.text)
    expect(text).toContain('我理解的是:')
    expect(text).toContain(NEED)
    expect(text).toContain('哪条不对说一下,都对就开工。')
  })

  it('★ 过了确认点之后,同一态那段话里不再有那道门', async () => {
    const { url, id } = await serveFeature({ stage: '拆解与派活' })
    const made = await post(url, '/feature/confirm', { id })
    await post(url, '/feature/confirm', { id, points: made.body.points })
    const text = String((await post(url, '/feature/run', { id })).body.text)
    expect(text).not.toContain('还没过确认点')
    expect(text).not.toContain('一件都不要派')
    expect(text).toContain('按 AGENTS.md 里「派活给别家Agent」那一节派')
  })
})

/* ──────────────────────── 选题卡 ──────────────────────── */

describe('/topic/confirm 与「没答之前不派活」(选题卡)', () => {
  it('★★ 她逐条答完 → 写进 框架.md 顶部那一节 + 留痕 + 验收标准', async () => {
    const { url, id, topicDir } = await serveTopic()
    const made = await post(url, '/topic/confirm', { id, name: TOPIC })
    expect(made.status).toBe(200)
    expect(made.body.confirmed).toBe(false)
    const points = (made.body.points as { ask: string, guess: string }[]).map((one, index) => (
      index === 0 ? { ...one, answer: '我自己用过三口锅,拍实物对比' } : one
    ))
    const res = await post(url, '/topic/confirm', { id, name: TOPIC, points })
    expect(res.status).toBe(200)
    expect(res.body.changed).toEqual([1])

    const text = readFileSync(join(topicDir, TOPIC_DOC_FILES.框架), 'utf8')
    expect(text).toContain(`## ${CONFIRM_SECTION_TITLE}`)
    expect(text).toContain('我自己用过三口锅,拍实物对比')
    expect(text).toContain(`## ${ACCEPTANCE_SECTION_TITLE}`)
    const log = lines(join(topicDir, REVIEW_LOG_NAME))
    expect(log[0]?.action).toBe('confirm_points')
  })

  it('未确认 + 初稿 → 那段话里明写「这一次一家都不要派」', async () => {
    const { url, id } = await serveTopic({ stage: '初稿' })
    const text = String((await post(url, '/topic/run', { id, name: TOPIC })).body.text)
    expect(text).toContain('还没过确认点')
    expect(text).toContain('这一次一家都不要派')
  })

  it('★ 过了之后同一段那段话里不再有那道门', async () => {
    const { url, id } = await serveTopic({ stage: '初稿' })
    const made = await post(url, '/topic/confirm', { id, name: TOPIC })
    await post(url, '/topic/confirm', { id, name: TOPIC, points: made.body.points })
    const text = String((await post(url, '/topic/run', { id, name: TOPIC })).body.text)
    expect(text).not.toContain('还没过确认点')
    expect(text).toContain('按《运营-给AI分发任务》派')
  })
})

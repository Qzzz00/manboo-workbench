// @vitest-environment node
/**
 * 选题那几条路由(2026-09-21):`/task/create` 多认三个字段、`/task/advance`、
 * `/topic/assets`、`/topic/open`。
 *
 * 三种回答分得清清楚楚这件事在这一份里逐条钉:枚举写错 400、卡不存在 404、
 * 这一步走不了 409 + 原话 —— 与 `/task/move` 同一套口径。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService, TOPIC_PUBLISH_DAY_FIRST } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { TOPIC_DIR } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const NOW_SEC = Math.floor(Date.parse('2026-09-21T09:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-topics-http-'))
  dirs.push(dir)
  return dir
}

/** 记下 `open -R` 打过哪些路径。真的去拉 Finder 是绝对不行的,用例里注入一个假的。 */
const revealed: string[] = []

async function serve(opts: { withCwd?: boolean } = {}) {
  const dir = tmpDir()
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
    reveal: {
      reveal: async (path: string) => { revealed.push(path); return { ok: true } },
    },
  })
  started.push(server)
  return { url: server.url, cwd, tasks }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

describe('/task/create 多认的三个字段', () => {
  it('建一条选题:三个字段进 /state,而且盘上多出 `选题/<名>/`', async () => {
    const { url, cwd } = await serve()
    const created = await post(url, '/task/create', {
      title: '露营锅具怎么选', kind: 'topic', content_type: '视频', stage: '灵感', priority: 'high',
    })
    expect(created.status).toBe(200)
    expect(created.body.dir).toBe(join(cwd, TOPIC_DIR, '露营锅具怎么选'))
    expect(existsSync(join(cwd, TOPIC_DIR, '露营锅具怎么选', '素材'))).toBe(true)
    const task = (await state(url)).tasks?.tasks[0]
    expect(task?.kind).toBe('topic')
    expect(task?.content_type).toBe('视频')
    expect(task?.stage).toBe('灵感')
  })

  it('**不传 kind 就是普通事项**,也不在盘上建任何目录', async () => {
    const { url, cwd } = await serve()
    await post(url, '/task/create', { title: '普通事项' })
    expect((await state(url)).tasks?.tasks[0]).not.toHaveProperty('kind')
    expect(existsSync(join(cwd, TOPIC_DIR, '普通事项'))).toBe(false)
  })

  it('三个字段写错各回各的 400 + 原话(不悄悄归成缺省)', async () => {
    const { url } = await serve()
    expect((await post(url, '/task/create', { title: 'x', kind: '选题' })).status).toBe(400)
    expect((await post(url, '/task/create', { title: 'x', content_type: '直播' })).status).toBe(400)
    const bad = await post(url, '/task/create', { title: 'x', stage: '发布中' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('stage')
  })
})

describe('两个发布日期那两条路(2026-09-22 两状态)', () => {
  it('建一条带计划发布日的选题:/state 里就是那一天,**没有实际发布日**', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: '露营锅具怎么选', kind: 'topic', planned_at: '2026-09-25' })
    const task = (await state(url)).tasks?.tasks[0]
    expect(task?.planned_at).toBe('2026-09-25')
    expect(task).not.toHaveProperty('published_at')
  })

  it('卡片上改两个日期:/task/update 收,传 null 清掉', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', { title: '选题', kind: 'topic', planned_at: '2026-09-25' })
    await post(url, '/task/update', { id: created.body.id, planned_at: '2026-09-28', published_at: '2026-09-27' })
    const task = (await state(url)).tasks?.tasks[0]
    expect(task?.planned_at).toBe('2026-09-28')
    expect(task?.published_at).toBe('2026-09-27')
    await post(url, '/task/update', { id: created.body.id, planned_at: null, published_at: null })
    const cleared = (await state(url)).tasks?.tasks[0]
    expect(cleared).not.toHaveProperty('planned_at')
    expect(cleared).not.toHaveProperty('published_at')
  })

  it('从日历删除单条计划：持久化清掉计划及回退日期，保留选题、素材和其他计划', async () => {
    const { url, cwd } = await serve()
    const created = await post(url, '/task/create', { title: '待撤排期', kind: 'topic', stage: '制作中', desc: '保留备注', planned_at: '2026-10-20', due: '2026-10-19' })
    const other = await post(url, '/task/create', { title: '其他内容', kind: 'topic', planned_at: '2026-10-20' })
    const asset = join(String(created.body.dir), '素材', '拍摄清单.md')
    writeFileSync(asset, '原始素材内容')
    const updated = await post(url, '/task/update', { id: created.body.id, planned_at: null, due: null })
    expect(updated.status).toBe(200)
    expect(updated.body.ok).toBe(true)
    const snapshot = (await state(url)).tasks?.tasks
    const kept = snapshot?.find(task => task.id === created.body.id)
    // 这条路的建卡缺省自 2026-10-23(卡「待排的卡不许被派出去」③)是「待排」。
    expect(kept).toMatchObject({ title: '待撤排期', kind: 'topic', stage: '制作中', desc: '保留备注', status: 'backlog' })
    expect(kept).not.toHaveProperty('planned_at')
    expect(kept).not.toHaveProperty('due')
    expect(snapshot?.find(task => task.id === other.body.id)?.planned_at).toBe('2026-10-20')
    const saved = JSON.parse(readFileSync(join(cwd, '..', 'tasks.json'), 'utf8'))
    expect(saved.tasks.find((task: { id: string }) => task.id === created.body.id)).toEqual(kept)
    expect(readFileSync(asset, 'utf8')).toBe('原始素材内容')
  })

  it('形状写错:**400 + 原话**,不悄悄归成缺省(建卡与改卡两条路都是)', async () => {
    const { url } = await serve()
    const bad = await post(url, '/task/create', { title: 'x', planned_at: '九月二十五' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('planned_at')
    expect(String(bad.body.error)).toContain('YYYY-MM-DD')
    const created = await post(url, '/task/create', { title: '选题', kind: 'topic' })
    const badUpdate = await post(url, '/task/update', { id: created.body.id, published_at: '2026-02-30' })
    expect(badUpdate.status).toBe(400)
    expect(String(badUpdate.body.error)).toContain('published_at')
  })

  it('`due` 那条路一个字没改:普通事项照常带它', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: '普通事项', due: '2026-09-25' })
    expect((await state(url)).tasks?.tasks[0]?.due).toBe('2026-09-25')
  })
})

describe('/task/advance', () => {
  it('推一步 → 200,回新的那一段,/state 里也是它', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', { title: '选题', kind: 'topic', stage: '灵感' })
    const advanced = await post(url, '/task/advance', { id: created.body.id })
    expect(advanced.status).toBe(200)
    expect(advanced.body).toMatchObject({ ok: true, stage: '初稿' })
    expect((await state(url)).tasks?.tasks[0]?.stage).toBe('初稿')
  })

  /**
   * ★ 2026-10-02(运营同学 Air 那一版):**推进一个日期都不写**,而从「发布」往「复盘」走
   * 之前实际发布日必须已经填了 —— 服务端 409 + 原话(`TOPIC_PUBLISH_DAY_FIRST`)。
   * 上一版在这里自动盖当天,等于替她断言"已经发到平台上了"。
   */
  it('★在「发布」那一段上推进:409 + 原话,卡**一个字不动**(`published_at` / `due` 都没写)', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', { title: '选题', kind: 'topic', stage: '发布' })
    const advanced = await post(url, '/task/advance', { id: created.body.id })
    expect(advanced.status).toBe(409)
    expect(String(advanced.body.error)).toBe(TOPIC_PUBLISH_DAY_FIRST)
    const task = (await state(url)).tasks?.tasks[0]
    expect(task?.stage).toBe('发布')
    expect(task).not.toHaveProperty('published_at')
    expect(task).not.toHaveProperty('due')
  })

  it('★填了实际发布日之后推得动,而且**不覆盖她填的那一天**,`due` 照旧一个字没写', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', { title: '选题', kind: 'topic', stage: '发布' })
    await post(url, '/task/update', { id: created.body.id, published_at: '2026-09-30' })
    await post(url, '/task/advance', { id: created.body.id })
    const task = (await state(url)).tasks?.tasks[0]
    expect(task?.stage).toBe('复盘')
    expect(task?.published_at).toBe('2026-09-30')
    expect(task).not.toHaveProperty('due')
  })

  it('已经到复盘:**409 + 原话**,不是 200 也不是静默', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', { title: '选题', kind: 'topic', stage: '复盘' })
    const advanced = await post(url, '/task/advance', { id: created.body.id })
    expect(advanced.status).toBe(409)
    expect(String(advanced.body.error)).toContain('复盘')
  })

  it('普通事项:409 + 原话', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', { title: '普通事项' })
    const advanced = await post(url, '/task/advance', { id: created.body.id })
    expect(advanced.status).toBe(409)
    expect(String(advanced.body.error)).toContain('选题')
  })

  it('卡不存在:404(与 409 分得开)', async () => {
    const { url } = await serve()
    expect((await post(url, '/task/advance', { id: '没有这条' })).status).toBe(404)
  })

  it('没有 id:400', async () => {
    const { url } = await serve()
    expect((await post(url, '/task/advance', {})).status).toBe(400)
  })
})

describe('/topic/assets 与 /topic/open', () => {
  it('列出这条选题的素材:自己目录里的 + 素材库里以选题名开头的', async () => {
    const { url, cwd } = await serve()
    await post(url, '/task/create', { title: '露营锅具怎么选', kind: 'topic' })
    writeFileSync(join(cwd, TOPIC_DIR, '露营锅具怎么选', '素材', '开箱.mp4'), '')
    writeFileSync(join(cwd, '素材', '图片素材', '露营锅具怎么选-封面.png'), '')
    writeFileSync(join(cwd, '素材', '图片素材', '别人的.png'), '')
    const listed = await post(url, '/topic/assets', { names: ['露营锅具怎么选'] })
    expect(listed.status).toBe(200)
    const rows = listed.body.topics as { name: string, files: { name: string }[] }[]
    expect(rows[0]?.files.map(f => f.name)).toEqual(['开箱.mp4', '露营锅具怎么选-封面.png'])
  })

  it('「素材」:把目录建出来并拉起 Finder,回的是那条绝对路径', async () => {
    const { url, cwd } = await serve()
    revealed.length = 0
    const opened = await post(url, '/topic/open', { name: '还没建过的选题' })
    expect(opened.status).toBe(200)
    expect(opened.body).toMatchObject({ ok: true, revealed: true, dir: join(cwd, TOPIC_DIR, '还没建过的选题') })
    expect(revealed).toEqual([join(cwd, TOPIC_DIR, '还没建过的选题')])
  })

  it('选题名带斜杠:400,**一个目录都不建**', async () => {
    const { url, cwd } = await serve()
    expect((await post(url, '/topic/open', { name: '../跑出去' })).status).toBe(400)
    expect(existsSync(join(cwd, '跑出去'))).toBe(false)
  })

  it('没配工作目录:409 + 一句人话,不猜一条路径', async () => {
    const { url } = await serve({ withCwd: false })
    const listed = await post(url, '/topic/assets', { names: ['甲'] })
    expect(listed.status).toBe(409)
    expect(String(listed.body.error)).toContain('工作目录')
  })
})

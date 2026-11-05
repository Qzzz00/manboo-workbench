// @vitest-environment node
/**
 * 「今天的待办」服务端那一半(2026-10-12):模板里多一格、老布局只补这一格、`/state.today_todos` 只在自媒体模板出现。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LayoutModule, WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { LAYOUT_MODULE_IDS } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { addMissingTemplateModules, createTemplateService } from '../src/server/templateStore.ts'
import { DEFAULT_MODULE_TITLES, PRODUCT_TEMPLATE } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
import { localDayOf } from '../src/todayTodos.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const NOW_SEC = Math.floor(Date.now() / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const ids = (modules: readonly LayoutModule[]): string[] => modules.map(one => one.id)

describe('模板里那一格', () => {
  it('自媒体模板横竖两份都有 today,紧跟在选题池(todo)后面;做产品模板没有', () => {
    for (const modules of [OPS_TEMPLATE.portrait, OPS_TEMPLATE.landscape]) {
      const list = ids(modules)
      expect(list.indexOf('today')).toBe(list.indexOf('todo') + 1)
    }
    expect(ids(PRODUCT_TEMPLATE.portrait)).not.toContain('today')
    expect(ids(PRODUCT_TEMPLATE.landscape)).not.toContain('today')
    expect(LAYOUT_MODULE_IDS as readonly string[]).toContain('today')
    expect(DEFAULT_MODULE_TITLES.today).toBe('今天的待办')
  })
})

describe('addMissingTemplateModules(老布局只补这一格)', () => {
  const stored: LayoutModule[] = [
    { id: 'slot', order: 0, basis_pct: 40, row: 0 },
    { id: 'todo', order: 1, basis_pct: 20, row: 1, col: 0, width_pct: 100, hidden: true },
    { id: 'publish', order: 2, basis_pct: 12, row: 1, col: 0, width_pct: 100 },
  ]

  it('缺 today:按模板给的那一格插在 todo 后面,别的格一个字不动', () => {
    const next = addMissingTemplateModules(stored, OPS_TEMPLATE.portrait)
    expect(ids(next)).toEqual(['slot', 'todo', 'today', 'publish'])
    expect(next[0]).toEqual({ ...stored[0], order: 0 })
    expect(next[1]).toEqual({ ...stored[1], order: 1 })
    expect(next[3]).toEqual({ ...stored[2], order: 3 })
    const today = OPS_TEMPLATE.portrait.find(one => one.id === 'today')
    expect(next[2]).toEqual({ ...today, order: 2 })
  })

  it('已经有了(他挪过、收起过)原样返回;没有 todo 的布局接在最后', () => {
    const had = [...stored, { id: 'today', order: 3, hidden: true }]
    expect(addMissingTemplateModules(had, OPS_TEMPLATE.portrait)).toBe(had)
    const bare: LayoutModule[] = [{ id: 'slot', order: 0 }]
    expect(ids(addMissingTemplateModules(bare, OPS_TEMPLATE.portrait))).toEqual(['slot', 'today'])
  })

  it('做产品模板没有 today,不补', () => {
    expect(addMissingTemplateModules(stored, PRODUCT_TEMPLATE.portrait)).toBe(stored)
  })
})

async function serve(templateId: 'ops' | 'product', layout?: WorkbenchLayout) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-today-'))
  dirs.push(dir)
  let saved: WorkbenchLayout | undefined = layout ?? { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(saved),
    writeLayout: (next) => { saved = next; return Promise.resolve() },
    // 2026-10-23(分层二刀二):ops 模板的内容在用户层起步层,本体只剩 product —— 用例里注入这一份。
    templates: () => [OPS_TEMPLATE],
  })
  await template.load()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    template,
    tasks,
    paths: { home: dir },
  } as never)
  started.push(server)
  if (templateId === 'ops') {
    const res = await fetch(`${server.url}/template/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ops' }) })
    expect(res.status).toBe(200)
  }
  return { url: server.url, tasks }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

describe('/state.today_todos', () => {
  it('自媒体模板:今天到期的事项在里面,日期按电脑本机那一天', async () => {
    const { url, tasks } = await serve('ops')
    const today = localDayOf(new Date(NOW_SEC * 1000))
    await tasks.create({ title: '回三条评论', due: today })
    await tasks.create({ title: '明天再说', due: '2999-01-01' })
    const view = (await state(url)).today_todos
    expect(view?.date).toBe(today)
    expect(view?.items.map(one => one.title)).toEqual(['回三条评论'])
  })

  it('做产品模板:整格缺席(产品模板不加这一格)', async () => {
    const { url, tasks } = await serve('product')
    await tasks.create({ title: '写测试', due: localDayOf(new Date(NOW_SEC * 1000)) })
    expect((await state(url)).today_todos).toBeUndefined()
  })
})

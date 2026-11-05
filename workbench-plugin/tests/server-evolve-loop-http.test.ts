// @vitest-environment node
/**
 * 自进化最小闭环**整条线**过 HTTP(2026-09-23):选题卡「做一篇内容」这条真实流程上,
 * 「跑两次同一类任务,第二次少交代」到底成不成立。
 *
 *   选题 A 初稿 → 她打回「开头太长了」            (一次临时要求,只对 A 说)
 *   选题 B 初稿 → 她打回「开头太长」              (两条选题都说过 → 记成偏好,收件箱一条)
 *   选题 C 「让事务官推进」                        (★ 话里带着「开头太长」,她一个字没交代)
 *   选题 C 她通过初稿                             (★ 验证:保留,收件箱第二条)
 *   —— 或者 ——
 *   选题 C 她又打回「开头还是太长」                (★ 验证:没见效,自动撤;选题 D 的话里不再带)
 *
 * 这一份钉的是**性质**:偏好从哪来(审核记录)、到哪去(推进的话 / 收件箱)、
 * 什么时候撤(她再打回)。判据与阈值的细节在 server-evolve-prefs.test.ts。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { createEvolveService, createEvolveStore } from '../src/server/evolve.ts'
import { readAllTopicReviews } from '../src/server/topicRun.ts'
import { TOPIC_DIR } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const NOW_SEC = Math.floor(Date.parse('2026-09-23T09:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-evolve-loop-'))
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
  const said: { session: string, text: string }[] = []
  const butler = {
    open: async () => 'sess-1',
    say: async (session: string, text: string) => { said.push({ session, text }); return true },
  }
  const files = new Map<string, string>()
  // 真的读盘上每条选题的 `审核记录.jsonl`(与 index.ts 的接线同一个函数);日志走内存 io。
  const evolve = createEvolveService({
    store: createEvolveStore({ file: join(dir, 'evolve.json') }),
    io: {
      readFile: async file => files.get(file),
      writeFile: async (file, text) => { files.set(file, text) },
      removeFile: async file => files.delete(file),
    },
    workdir: cwd,
    says: async () => [],
    reviews: async () => readAllTopicReviews(join(cwd, TOPIC_DIR)),
  })
  await evolve.load()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    template,
    butlerSession: butler,
    evolve,
  })
  started.push(server)

  /** 建一条在「初稿」段的选题,挂上会话。 */
  const topic = async (title: string): Promise<string> => {
    const created = await post(server.url, '/task/create', { title, kind: 'topic', stage: '初稿' })
    const id = String(created.body.id)
    await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
    return id
  }
  const review = (id: string, name: string, action: string, text?: string) =>
    post(server.url, '/topic/review', { id, name, tab: '初稿', action, ...(text === undefined ? {} : { text }) })
  const run = (id: string, name: string) => post(server.url, '/topic/run', { id, name })
  const state = async () => (await (await fetch(`${server.url}/state`)).json()) as Record<string, any>
  return { url: server.url, cwd, said, topic, review, run, state, logFile: join(cwd, '进化日志.md'), files }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('跑两次同一类任务', () => {
  it('★ 第一条选题上打回一次 = 临时要求:不记偏好、收件箱没提示、第二条的话里不带它', async () => {
    const h = await serve()
    const a = await h.topic('露营锅具怎么选')
    const first = await h.review(a, '露营锅具怎么选', 'revise', '开头太长了')
    expect(first.status).toBe(200)
    expect(String(first.body.evolve_note)).toContain('没有新的偏好')
    const b = await h.topic('帐篷选购避坑')
    await h.run(b, '帐篷选购避坑')
    const text = h.said.at(-1)?.text as string
    expect(text).not.toContain('她的偏好')
    expect(text).not.toContain('开头太长')
    expect((await h.state()).evolve?.preferences).toBeUndefined()
    expect(((await h.state()).butler_inbox?.items as { kind: string }[]).some(one => one.kind === 'evolve')).toBe(false)
  })

  it('★ 两条选题都打回同一处 → 记成偏好;第三条推进时话里带着它,她一个字没交代;通过了就保留', async () => {
    const h = await serve()
    const a = await h.topic('露营锅具怎么选')
    await h.review(a, '露营锅具怎么选', 'revise', '开头太长了')
    const b = await h.topic('帐篷选购避坑')
    const second = await h.review(b, '帐篷选购避坑', 'revise', '开头太长')
    expect(String(second.body.evolve_note)).toContain('记下 1 条偏好')

    // 记下了:/state 里有、收件箱一条、进化日志一条。
    let state = await h.state()
    expect(state.evolve?.preferences).toHaveLength(1)
    expect(state.evolve?.preferences?.[0]?.text).toBe('开头太长')
    expect(state.evolve?.preferences?.[0]?.status).toBe('trial')
    const inbox = (state.butler_inbox?.items as { kind: string, title: string }[]).filter(one => one.kind === 'evolve')
    expect(inbox).toHaveLength(1)
    expect(inbox[0]?.title).toContain('「开头太长」')
    expect(h.files.get(h.logFile)).toContain('记下一条偏好(试用):「开头太长」')

    // 第三条选题:她只点了「让事务官推进」,没补一个字 —— 话里已经带着那条偏好。
    const c = await h.topic('睡袋怎么挑')
    const ran = await h.run(c, '睡袋怎么挑')
    expect(ran.status).toBe(200)
    const text = h.said.at(-1)?.text as string
    expect(text).toContain('先照它做,不用她再交代')
    expect(text).toContain('「开头太长」—— 在《露营锅具怎么选》《帐篷选购避坑》上都打回过(试用中')
    expect(text).not.toContain('她这一次补了一句')

    // 她通过了初稿 → 验证:保留;收件箱第二条。
    const passed = await h.review(c, '睡袋怎么挑', 'pass')
    expect(String(passed.body.evolve_note)).toContain('验证见效,保留')
    state = await h.state()
    expect(state.evolve?.preferences?.[0]?.status).toBe('kept')
    expect(state.evolve?.preferences?.[0]?.verdict).toContain('《睡袋怎么挑》')
    const inboxAfter = (state.butler_inbox?.items as { kind: string, title: string }[]).filter(one => one.kind === 'evolve')
    expect(inboxAfter).toHaveLength(2)
    expect(inboxAfter[1]?.title).toContain('见效了,保留')
    expect(h.files.get(h.logFile)).toContain('已验证保留')
    // 盘上那三份审核记录一个字没被这条链路改过(它只读)。
    expect(readFileSync(join(h.cwd, TOPIC_DIR, '睡袋怎么挑', '审核记录.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('★ 第三条上她又打回同一处 → 没见效,自动撤;第四条的话里不再带它,日志补「已撤」', async () => {
    const h = await serve()
    const a = await h.topic('露营锅具怎么选')
    await h.review(a, '露营锅具怎么选', 'revise', '开头太长了')
    const b = await h.topic('帐篷选购避坑')
    await h.review(b, '帐篷选购避坑', 'revise', '开头太长')
    const c = await h.topic('睡袋怎么挑')
    await h.run(c, '睡袋怎么挑')
    const back = await h.review(c, '睡袋怎么挑', 'revise', '开头还是太长')
    expect(String(back.body.evolve_note)).toContain('没见效,撤了')
    const state = await h.state()
    expect(state.evolve?.preferences).toBeUndefined()
    const inbox = (state.butler_inbox?.items as { kind: string, title: string }[]).filter(one => one.kind === 'evolve')
    expect(inbox.at(-1)?.title).toContain('没见效,撤了')
    expect(h.files.get(h.logFile)).toContain('已撤(没见效)')

    const d = await h.topic('登山杖要不要买')
    await h.run(d, '登山杖要不要买')
    expect(h.said.at(-1)?.text).not.toContain('开头太长')
    // 撤了的那一条不会因为三条选题都说过就再自动记回来。
    expect((await h.state()).evolve?.preferences).toBeUndefined()
  })

  it('★ /evolve/revert 手撤 pref: 那一条;进化日志能从 /evolve/log 读到全过程', async () => {
    const h = await serve()
    const a = await h.topic('露营锅具怎么选')
    await h.review(a, '露营锅具怎么选', 'revise', '开头太长了')
    const b = await h.topic('帐篷选购避坑')
    await h.review(b, '帐篷选购避坑', 'revise', '开头太长')
    const id = String(((await h.state()).evolve?.preferences as { id: string }[])[0]?.id)
    expect(id.startsWith('pref:')).toBe(true)
    const reverted = await post(h.url, '/evolve/revert', { id })
    expect(reverted.status).toBe(200)
    expect(String(reverted.body.note)).toContain('不再带「开头太长」')
    expect((await h.state()).evolve?.preferences).toBeUndefined()
    const log = await (await fetch(`${h.url}/evolve/log`)).json() as { text: string }
    expect(log.text).toContain('记下一条偏好(试用)')
    expect(log.text).toContain('她手动撤的')
  })
})

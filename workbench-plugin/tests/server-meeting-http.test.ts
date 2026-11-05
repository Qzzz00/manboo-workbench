// @vitest-environment node
/**
 * `/meeting/*` 五条路由(2026-09-21 会议模式)。
 *
 * **没有 /meeting/delete,将来也不许有** —— 这份用例里有一条精确断言守着(同 /inbox 那条先例)。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createMeetingService } from '../src/server/meeting.ts'
import { MEETING_DEMO_CASES } from '../src/server/meetingDemoCases.ts'
import { CLAIM_KINDS, MEETING_SECTIONS, MEETING_TOPIC_FIELDS, encodeWav } from '../src/server/meetingText.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function fakeWav(seconds: number): Buffer {
  const samples = 16_000 * seconds
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(i % 2 === 0 ? 3000 : -3000, i * 2)
  return encodeWav(pcm)
}

/** 模型照《会议纪要生成规则》回的那一份(2026-10-13)。 */
const REPLY = [
  `## ${MEETING_SECTIONS.solved}`, '- 定了先做会议模式',
  `## ${MEETING_SECTIONS.topic}:会议模式`,
  `### ${MEETING_TOPIC_FIELDS.claims}`, `- [${CLAIM_KINDS[0]}] 先做`,
  `## ${MEETING_SECTIONS.keep}`, '- 先做会议模式',
  `## ${MEETING_SECTIONS.next}`, '- 小王|跑一遍转写|这周五前',
  `## ${MEETING_SECTIONS.unsure}`, '- 有个词没听清',
].join('\n')

/** 打桩的转写里要有「小王」与「这周五前」:下一步里的人名与日期要在转写里找得到才留。 */
const HEARD = '小王你这周五前跑一遍转写。'

async function serve(options: { withMeeting?: boolean, workdir?: string | undefined, chat?: (prompt: string) => Promise<string> } = {}) {
  const store = tempDir('wb-meeting-http-store-')
  const workdir = options.workdir === undefined && !('workdir' in options) ? tempDir('wb-meeting-http-repo-') : options.workdir
  const tasks = createTasksService({ file: join(store, 'tasks.json') })
  const meeting = createMeetingService({
    file: join(store, 'meetings.json'),
    workdir: () => workdir,
    transcribe: async () => HEARD,
    chat: options.chat ?? (async () => REPLY),
    tasks,
    now: () => Date.parse('2026-09-21T10:00:00.000Z'),
  })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    ...(options.withMeeting === false ? {} : { meeting }),
  })
  started.push(server)
  return { url: server.url, meeting, tasks, workdir }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('没接会议服务', () => {
  it('五条路由一律 404,并说清是「未启用」;/state.meetings 缺席但 /state 照常出', async () => {
    const { url } = await serve({ withMeeting: false })
    for (const [method, path] of [['POST', '/meeting/start'], ['POST', '/meeting/finish'], ['POST', '/meeting/apply'], ['POST', '/meeting/import'], ['GET', '/meeting']] as const) {
      const res = method === 'GET' ? await get(url, path) : await post(url, path, {})
      expect(res.status).toBe(404)
      expect(String(res.body.error)).toContain('会议模式未启用')
    }
    const snapshot = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(snapshot.meetings).toBeUndefined()
    expect(snapshot.butler_inbox).toBeDefined()
  })
})

describe('没配工作目录', () => {
  it('开不了会,回 409 + 那句人话(不猜一个路径)', async () => {
    const { url } = await serve({ workdir: undefined })
    const res = await post(url, '/meeting/start', { title: '周会' })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('工作目录')
  })
})

describe('一整条:开 → 传两段 → 结束 → 看 → 建卡', () => {
  it('走得通,而且每一步的回话都对得上硬盘上的东西', async () => {
    const { url, meeting, tasks, workdir } = await serve()

    const started = await post(url, '/meeting/start', { title: '产品周会' })
    expect(started.status).toBe(200)
    const id = String(started.body.id)
    expect(String(started.body.dir)).toBe(join(workdir ?? '', '会议', '2026-09-21-产品周会'))

    for (const seq of [1, 2]) {
      const res = await fetch(`${url}/meeting/segment?id=${encodeURIComponent(id)}&seq=${seq}&ms=10000`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: fakeWav(10) as unknown as BodyInit,
      })
      expect(res.status).toBe(200)
    }

    expect((await post(url, '/meeting/finish', { id })).status).toBe(200)
    await meeting.idle()

    const view = await get(url, `/meeting?id=${encodeURIComponent(id)}`)
    expect(view.status).toBe(200)
    expect(view.body.status).toBe('done')
    expect(view.body.segments).toBe(2)
    expect(existsSync(join(String(started.body.dir), '转写.md'))).toBe(true)
    expect(readFileSync(join(String(started.body.dir), '纪要.md'), 'utf8')).toContain('- 小王:跑一遍转写(这周五前)')

    // /state 里事务官面板那条「最近一次会议」
    const snapshot = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(snapshot.meetings?.recent[0]?.title).toBe('产品周会')
    expect(snapshot.meetings?.dir).toBe(join(workdir ?? '', '会议'))
    const entry = snapshot.butler_inbox?.items.find(item => item.kind === 'meeting')
    expect(entry?.title).toContain('产品周会')
    expect(entry?.note).toContain('1 条待办等你挑')

    const applied = await post(url, '/meeting/apply', { id })
    expect(applied.status).toBe(200)
    expect((applied.body.created as string[]).length).toBe(1)
    const board = await tasks.list()
    expect(board.tasks[0]?.title).toBe('跑一遍转写')
    expect(board.tasks[0]?.source.kind).toBe('meeting')
  })

  it('不带 id / seq 的分段上传 400;id 认不出来 400;body 空 400', async () => {
    const { url } = await serve()
    const started = await post(url, '/meeting/start', { title: '周会' })
    const id = String(started.body.id)
    const bad = await fetch(`${url}/meeting/segment?seq=1`, { method: 'POST', body: 'x' })
    expect(bad.status).toBe(400)
    const noSuch = await fetch(`${url}/meeting/segment?id=nope&seq=1`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: 'x' })
    expect(noSuch.status).toBe(400)
    const empty = await fetch(`${url}/meeting/segment?id=${id}&seq=1`, { method: 'POST', headers: { 'content-type': 'audio/wav' } })
    expect(empty.status).toBe(400)
  })

  it('GET /meeting 不带 id → 整份清单;id 不存在 → 404', async () => {
    const { url } = await serve()
    await post(url, '/meeting/start', { title: '周会' })
    const list = await get(url, '/meeting')
    expect((list.body.recent as unknown[]).length).toBe(1)
    expect((await get(url, '/meeting?id=不存在')).status).toBe(404)
  })
})

describe('手机先录、后补开;失败了重新来(2026-10-09)', () => {
  it('/meeting/start 带同一个 client_key 再来一次 → 同一场(手机没收到回包重发)', async () => {
    const { url } = await serve()
    const a = await post(url, '/meeting/start', { title: '周会', client_key: 'k1', started_at: '2026-09-21T09:00:00.000Z' })
    const b = await post(url, '/meeting/start', { title: '周会', client_key: 'k1' })
    expect(b.body.id).toBe(a.body.id)
    expect((await get(url, `/meeting?id=${String(a.body.id)}`)).body.started_at).toBe('2026-09-21T09:00:00.000Z')
  })

  it('梳理没成 → 收件箱那一档带「能重新来」;POST /meeting/retry 之后走到 done', async () => {
    let chatOk = false
    const { url, meeting } = await serve({ chat: async () => { if (!chatOk) throw new Error('中转连不上'); return REPLY } })
    const id = String((await post(url, '/meeting/start', { title: '周会' })).body.id)
    await fetch(`${url}/meeting/segment?id=${encodeURIComponent(id)}&seq=1&ms=3000`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: fakeWav(3) as unknown as BodyInit })
    await post(url, '/meeting/finish', { id })
    await meeting.idle()
    expect((await get(url, `/meeting?id=${id}`)).body.retryable).toBe(true)
    const snapshot = await (await fetch(`${url}/state`)).json() as WorkbenchState
    const entry = snapshot.butler_inbox?.items.find(item => item.kind === 'meeting')
    expect(entry?.meeting).toEqual({ id, retryable: true })

    chatOk = true
    expect((await post(url, '/meeting/retry', { id })).status).toBe(200)
    await meeting.idle()
    const view = await get(url, `/meeting?id=${id}`)
    expect(view.body.status).toBe('done')
    expect(view.body.retryable).toBeUndefined()
  })

  it('/meeting/retry:不带 id 400;干净做完的 409 + 一句话', async () => {
    const { url, meeting } = await serve()
    expect((await post(url, '/meeting/retry', {})).status).toBe(400)
    const id = String((await post(url, '/meeting/start', { title: '周会' })).body.id)
    await fetch(`${url}/meeting/segment?id=${encodeURIComponent(id)}&seq=1&ms=3000`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: fakeWav(3) as unknown as BodyInit })
    await post(url, '/meeting/finish', { id })
    await meeting.idle()
    const res = await post(url, '/meeting/retry', { id })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('已经整理好了')
  })
})

describe('没有删除这条路(将来也不许有)', () => {
  it('/meeting/delete、/meeting/remove 都不是一条路由', async () => {
    const { url } = await serve()
    for (const path of ['/meeting/delete', '/meeting/remove', '/meeting/clear']) {
      const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(res.status).toBe(404)
    }
    const source = readFileSync(new URL('../src/server/http.ts', import.meta.url), 'utf8')
    expect(source).not.toContain("'/meeting/delete'")
  })
})

describe('会前(2026-10-10):登记、一问一答、开录接到同一场、会后那一句', () => {
  it('一问一答 / 撤掉 / plan_id 开录 / 会后 outcome 都走得通', async () => {
    const { url } = await serve()
    const planned = await post(url, '/meeting/plan', { text: '明天下午三点跟 B 客户谈,要敲定报价' })
    const id = (planned.body.meeting as { id: string }).id
    const answered = await post(url, '/meeting/answer', { answer: '谈判会' })
    expect(answered.status).toBe(200)
    expect(String(answered.body.note)).toContain('谁来')
    expect((await post(url, '/meeting/answer', { id, question: 'scope', answer: '火星' })).status).toBe(409)
    const started = await post(url, '/meeting/start', { client_key: 'k1', plan_id: id })
    expect(started.body.id).toBe(id)
    expect((await post(url, '/meeting/outcome', { id, settled: 'yes' })).status).toBe(200)
    expect(((await get(url, `/meeting?id=${id}`)).body.outcome as { settled: string }).settled).toBe('yes')
    const other = await post(url, '/meeting/plan', { text: '后天上午十点组里例会' })
    expect((await post(url, '/meeting/drop', { id: (other.body.meeting as { id: string }).id })).status).toBe(200)
  })

  it('花名档案只给本机看(读得到),不上 /state', async () => {
    const { url } = await serve()
    const planned = await post(url, '/meeting/plan', { text: '明天下午三点跟 B 客户谈' })
    const id = (planned.body.meeting as { id: string }).id
    await post(url, '/meeting/answer', { id, question: 'people', answer: 'B客户拍板' })
    const people = await get(url, '/meeting/people')
    expect((people.body.people as { alias: string }[]).map(p => p.alias)).toEqual(['B客户'])
    expect((await post(url, '/meeting/people/forget', { alias: 'B客户' })).status).toBe(200)
  })
})

describe('导入现成的转写(2026-10-13):不靠现场录音也出一份纪要', () => {
  it('★ 一条 POST 出一场:转写与纪要落盘、进「最近几场」、收件箱那一档照旧说「纪要好了」', async () => {
    const { url, meeting, workdir } = await serve()
    const res = await post(url, '/meeting/import', { text: '[00:00:00] 小王你这周五前跑一遍转写。', title: '十一月选题会', from: '会议样例.md' })
    expect(res.status).toBe(200)
    const id = String(res.body.id)
    expect(String(res.body.dir)).toBe(join(workdir ?? '', '会议', '2026-09-21-十一月选题会'))
    await meeting.idle()

    const dir = String(res.body.dir)
    expect(readFileSync(join(dir, '转写.md'), 'utf8')).toContain('导入的现成文字')
    expect(readFileSync(join(dir, '纪要.md'), 'utf8')).toContain(MEETING_SECTIONS.keep)
    // 没有录音就不摆一个空的「录音」文件夹
    expect(existsSync(join(dir, '录音'))).toBe(false)

    const view = await get(url, `/meeting?id=${encodeURIComponent(id)}`)
    expect(view.body.status).toBe('done')
    expect((view.body.todos as unknown[]).length).toBe(1)

    const snapshot = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(snapshot.meetings?.recent[0]?.title).toBe('十一月选题会')
    const entry = snapshot.butler_inbox?.items.find(item => item.kind === 'meeting')
    expect(entry?.title).toContain('纪要好了')
    expect(entry?.note).toContain('1 条待办等你挑')
  })

  it('两样都没给 → 409 + 一句人话;没配工作目录也是 409', async () => {
    const { url } = await serve()
    const empty = await post(url, '/meeting/import', {})
    expect(empty.status).toBe(409)
    expect(String(empty.body.error)).toContain('转写文字')
    const noWorkdir = await serve({ workdir: undefined })
    expect((await post(noWorkdir.url, '/meeting/import', { text: '一句话' })).status).toBe(409)
  })
})

describe('放三场演示用的会(2026-10-13):一颗键,三场都进会议列表', () => {
  it('★ 一条 POST 放三场:都在 /state.meetings.recent 里、都带「演示用」、会前那一段也在', async () => {
    const { url, meeting } = await serve()
    const res = await post(url, '/meeting/seed-demo', {})
    expect(res.status).toBe(200)
    const cases = res.body.cases as { title: string, id: string, dir: string, note: string }[]
    expect(cases.map(one => one.title)).toEqual(MEETING_DEMO_CASES.map(one => one.title))
    await meeting.idle()

    const snapshot = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(snapshot.meetings?.recent.map(one => one.title).sort()).toEqual(MEETING_DEMO_CASES.map(one => one.title).sort())
    expect(snapshot.meetings?.recent.every(one => one.demo === true)).toBe(true)
    // 会前(画像与预案卡)、会中(时间线)、会后(纪要)三样都从同一条 `GET /meeting?id=` 回得来
    // (这份用例里的打桩模型只会回纪要那一种格式,所以预案卡做不成 —— 卡做成的样子在
    //  server-meeting-demo-20261013.test.ts 里验;这里只核会前画像确实接在同一场上。)
    const one = await get(url, `/meeting?id=${encodeURIComponent(cases[0]!.id)}`)
    const prep = one.body.prep as { said: string, ask?: unknown, my_role?: { value: string } }
    expect(prep.said).toBe(MEETING_DEMO_CASES[0]!.said)
    expect(prep.ask).toBeUndefined()
    expect(prep.my_role?.value).toBe(MEETING_DEMO_CASES[0]!.answers.my_role)
    expect((one.body.timeline as unknown[]).length).toBeGreaterThan(2)
    expect(String(one.body.summary)).toContain(MEETING_SECTIONS.solved)
    // 待开的会里一场都不剩(会前那一步已经过去了)
    expect(snapshot.meetings?.upcoming ?? []).toHaveLength(0)
  })

  it('再点一次都跳过;没配工作目录 409;没接会议服务 404', async () => {
    const { url, meeting } = await serve()
    await post(url, '/meeting/seed-demo', {})
    await meeting.idle()
    const again = await post(url, '/meeting/seed-demo', {})
    expect((again.body.cases as { skipped?: true }[]).every(one => one.skipped === true)).toBe(true)

    const noWorkdir = await serve({ workdir: undefined })
    expect((await post(noWorkdir.url, '/meeting/seed-demo', {})).status).toBe(409)
    const noService = await serve({ withMeeting: false })
    expect((await post(noService.url, '/meeting/seed-demo', {})).status).toBe(404)
  })

  it('这条只给本机(和导入同一道门):路由里第一道闸就是 loopback', () => {
    const source = readFileSync(new URL('../src/server/http.ts', import.meta.url), 'utf8')
    const at = source.indexOf("path === '/meeting/seed-demo'")
    expect(at).toBeGreaterThan(0)
    expect(source.slice(at, at + 300)).toContain('if (!loopback)')
  })
})

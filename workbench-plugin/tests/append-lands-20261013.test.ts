// @vitest-environment node
/**
 * **补细节那一句,没会话时也要真落下去**(2026-10-13,卡 G;周三 10-14 演示场景 1)。
 *
 * 10-13 14:02 真机那一通:她说完「帮我做一个 X 的视频」,60 秒内补一句
 * 「七八岁吧,穿小碎花连衣裙」→ 8791 认成 `append` → 工人打 `/butler/item/say` →
 * 视频接力那一件是 `skipSession` 建的、**没有会话** → 回「这件事的会话没开,说不进去」。
 * 电话那头(卡 A)没办成固定说「记下了。」—— 那句细节其实一个地方都没落,等于说了一句假话。
 *
 * 这份用例钉三件:
 *   ① 没有会话的那一件:这句话记进**卡的描述**,回 `ok:true` + `note` 说清落在哪;
 *   ② 还在豆包那一步的视频接力:同一句**并进可灵那句提示词**(插在主体之后、镜头语言之前);
 *   ③ 已经过了「写提示词」那一步:提示词一个字不动,`note` 如实只说记在卡上;
 * 外加兄弟路:有会话的照旧捎进会话(一个字不改)、不带 `append` 的两条路与收场了的卡照旧 409。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnswersView, WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { DEMO_APPEND_ON_CARD, DEMO_APPEND_ON_CARD_AND_PROMPT, DEMO_SAY_MAX_CHARS } from '../src/server/demoPlaybook.ts'
import { UNDERSTOOD_TRACE_ASK } from '../src/server/understoodTrace.ts'
import type { ChainRecord, ChainStage } from '../src/server/videoChain.ts'
import { VIDEO_PROMPT_FIRST_FRAME, VIDEO_PROMPT_MOTION, videoPromptOf } from '../src/server/videoChain.ts'

/** 她补的那一句(真机 14:02 那一句)。 */
const SAID = '七八岁吧,穿小碎花连衣裙'
const SUBJECT = '女孩子在树林下摘蘑菇'
const NOW_MS = Date.parse('2026-10-13T06:02:00.000Z')
const NOW_SEC = Math.floor(NOW_MS / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve(chain?: Partial<ChainRecord> & { stage: ChainStage }) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-append-lands-'))
  dirs.push(dir)
  // 接力记录落在家目录下那一份(`paths.home` 指到临时目录 —— 真机那份 ~/.dsh 一个字都不碰)。
  const chainFile = join(dir, '.dsh', 'workbench', 'video-chains.json')
  if (chain !== undefined) {
    mkdirSync(dirname(chainFile), { recursive: true })
    const record: ChainRecord = {
      item: 't-1', subject: SUBJECT, video_prompt: videoPromptOf(), since: NOW_MS - 30_000, ...chain,
    }
    writeFileSync(chainFile, JSON.stringify({ chains: [record] }), 'utf8')
  }
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const saidTo: { sessionId: string, text: string }[] = []
  let saved: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const request = async (): Promise<Record<string, unknown>> => ({ found: false, busy: false })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    butlerSession: {
      open: async () => 'session-1',
      say: async (sessionId: string, text: string) => { saidTo.push({ sessionId, text }); return true },
    },
    projects: {
      getProjectsState: () => Promise.resolve({ projects: [], pending: [], scan_errors: [], scanned_at: new Date(NOW_MS).toISOString() }),
      confirmStatus: () => Promise.resolve(false),
      setDdl: () => Promise.resolve(false),
      addRule: () => Promise.resolve(),
      getLayout: () => Promise.resolve(saved),
      setLayout: (next: WorkbenchLayout) => { saved = next; return Promise.resolve() },
      invalidateScanCache: () => {},
    },
    // 壳与 `runCommand` 都给了,接力那一层才接得上(可灵那一步要壳的手)。
    helper: { attach: () => {}, view: () => ({ connected: true, authorized: true }), connected: () => true, onChange: () => {}, onEvent: () => {}, request },
    runCommand: async () => ({ ok: true, stdout: '' }),
    paths: { home: dir },
  } as never)
  started.push(server)
  // `videoChain.load()` 在起服务那一拍是 `void`(不等它):读完那份小文件再往下走。
  await new Promise(resolve => setTimeout(resolve, 60))
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const card = async (id: string) => (await tasks.list()).tasks.find(one => one.id === id)
  const answers = async (): Promise<AnswersView> =>
    ((await (await fetch(`${server.url}/state`)).json() as WorkbenchState).answers ?? { items: [], unseen: 0 })
  const chainOf = (id: string): ChainRecord | undefined =>
    (JSON.parse(readFileSync(chainFile, 'utf8')) as { chains: ChainRecord[] }).chains.find(one => one.item === id)
  return { post, tasks, card, answers, chainOf, saidTo }
}

/** 接力那一件的样子:`skipSession` 建的,没有会话。 */
async function chainCard(t: Awaited<ReturnType<typeof serve>>) {
  const made = await t.tasks.create({ title: `${SUBJECT}的视频`, desc: '帮我做一个女孩子在树林下摘蘑菇的视频', direction: 'mine', status: 'doing' })
  return String(made.id)
}

describe('① 没有会话的那一件:这句话记在卡上', () => {
  it('★回 ok + note「记在卡上了」,卡的描述上多一段「她 … 补的:「…」」', async () => {
    const t = await serve()
    const id = await chainCard(t)
    const res = await t.post('/butler/item/say', { id, text: `${SAID}。`, append: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, id, note: DEMO_APPEND_ON_CARD })
    // 没有会话就没有 session_id —— 不许装成捎进了一条会话。
    expect(res.body.session_id).toBeUndefined()
    const desc = String((await t.card(id))?.desc ?? '')
    expect(desc).toContain('帮我做一个女孩子在树林下摘蘑菇的视频')
    expect(desc).toContain(`补的:「${SAID}。」`)
    expect(desc.split('\n')).toHaveLength(2)
  })

  it('念给她听的那一句在 25 字之内(工人认不出别的话时念的就是 note)', () => {
    for (const line of [DEMO_APPEND_ON_CARD, DEMO_APPEND_ON_CARD_AND_PROMPT]) {
      expect([...line].length).toBeLessThanOrEqual(DEMO_SAY_MAX_CHARS)
    }
  })

  it('事务官那本回答账上留一行(「你说(电话):…」→ 落在哪)', async () => {
    const t = await serve()
    const id = await chainCard(t)
    await t.post('/butler/item/say', { id, text: SAID, append: true })
    const view = await t.answers()
    expect(view.items).toHaveLength(1)
    expect(view.items[0]).toMatchObject({ question: `${UNDERSTOOD_TRACE_ASK}(电话):${SAID}`, answer: DEMO_APPEND_ON_CARD })
  })
})

describe('② 接力还在豆包那一步:可灵那句提示词也带上', () => {
  it('★note 说「可灵提示词也带上了」,接力记录里的 video_prompt 插在主体之后、镜头语言之前', async () => {
    const t = await serve({ stage: 'image' })
    const made = await t.tasks.create({ title: `${SUBJECT}的视频`, direction: 'mine', status: 'doing' })
    expect(made.id).toBe('t-1')
    const res = await t.post('/butler/item/say', { id: 't-1', text: `${SAID}。`, append: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, note: DEMO_APPEND_ON_CARD_AND_PROMPT })
    /*
     * ★ 2026-10-13 傍晚改口径(卡 J):可灵那句模板**不再重述主体**(首帧就是那张图),
     * 她补的那一句于是插在**首帧那一句之后、运镜之前**。
     */
    expect(t.chainOf('t-1')?.video_prompt).toBe(`${VIDEO_PROMPT_FIRST_FRAME}${SAID}。${VIDEO_PROMPT_MOTION}`)
    // 卡上那一段照样有(两处都落,不是二选一)。
    expect(String((await t.card('t-1'))?.desc ?? '')).toContain(`补的:「${SAID}。」`)
  })

  it('同一句补第二遍:提示词不接第二份', async () => {
    const t = await serve({ stage: 'image' })
    await t.tasks.create({ title: `${SUBJECT}的视频`, direction: 'mine', status: 'doing' })
    await t.post('/butler/item/say', { id: 't-1', text: SAID, append: true })
    await t.post('/butler/item/say', { id: 't-1', text: `${SAID}。`, append: true })
    const prompt = String(t.chainOf('t-1')?.video_prompt ?? '')
    expect(prompt.split(SAID)).toHaveLength(2)
  })
})

describe('③ 已经过了写提示词那一步:prompt 不动、note 如实', () => {
  it('★可灵那一步之后补的那一句只记在卡上(载入时这一档按「重启」那条规矩算没走完)', async () => {
    const t = await serve({ stage: 'video' })
    await t.tasks.create({ title: `${SUBJECT}的视频`, direction: 'mine', status: 'doing' })
    const before = t.chainOf('t-1')?.video_prompt
    const res = await t.post('/butler/item/say', { id: 't-1', text: SAID, append: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, note: DEMO_APPEND_ON_CARD })
    expect(t.chainOf('t-1')?.video_prompt).toBe(before)
    expect(String((await t.card('t-1'))?.desc ?? '')).toContain(`补的:「${SAID}」`)
  })
})

/**
 * ★ **不像描述的那一句:记在卡上,可灵那句提示词一个字不动**(2026-10-13 晚,卡 P)。
 *
 * 演示机 20:30 那一通的病根在 8791 认法那一头(卡 P 第 1 条已收紧),这里钉的是**第二道**:
 * 真有这么一句送到这条路上来,提示词也不许被它改掉 —— `note` 只说「记在卡上了」。
 */
describe('④ 不像描述的那一句:只记在卡上(卡 P)', () => {
  it('★「帮我把待办的组件改为。」进了卡的描述,video_prompt 一个字不动', async () => {
    const t = await serve({ stage: 'image' })
    await t.tasks.create({ title: `${SUBJECT}的视频`, direction: 'mine', status: 'doing' })
    const res = await t.post('/butler/item/say', { id: 't-1', text: '帮我把待办的组件改为。', append: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, id: 't-1', note: DEMO_APPEND_ON_CARD })
    expect(t.chainOf('t-1')?.video_prompt).toBe(videoPromptOf())
    expect(String((await t.card('t-1'))?.desc ?? '')).toContain('补的:「帮我把待办的组件改为。」')
  })
})

describe('兄弟路:三条照旧,一个字不改', () => {
  it('有会话的那一件:照旧捎进会话,卡的描述不动', async () => {
    const t = await serve()
    // 2026-10-29 入口归一:/butler/item 不再自己开会话 —— 这张卡直接带会话建(本条只钉 /butler/item/say 的兄弟路)。
    const made = await t.tasks.create({ title: '订机票', direction: 'mine', conversation: { agent: 'dsh', session_id: 'session-1' } })
    const id = String(made.id)
    const before = (await t.card(id))?.desc
    const res = await t.post('/butler/item/say', { id, text: SAID, append: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, session_id: 'session-1' })
    expect(t.saidTo).toContainEqual({ sessionId: 'session-1', text: SAID })
    expect((await t.card(id))?.desc).toBe(before)
  })

  it('不带 append 的那两条路(界面「推进 / 改一改」、工人 wb_hand_to_butler)照旧 409', async () => {
    const t = await serve({ stage: 'image' })
    await t.tasks.create({ title: `${SUBJECT}的视频`, direction: 'mine', status: 'doing' })
    const res = await t.post('/butler/item/say', { id: 't-1', text: '顺便把酒店也订了' })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('会话没开')
    expect(t.chainOf('t-1')?.video_prompt).toBe(videoPromptOf())
    expect((await t.card('t-1'))?.desc).toBeUndefined()
  })

  it('这件事不在了 → 404;已经收场的卡 → 照旧 409(不往收了的卡上写)', async () => {
    const t = await serve()
    expect((await t.post('/butler/item/say', { id: '不存在', text: SAID, append: true })).status).toBe(404)
    const made = await t.tasks.create({ title: '取消了的那件', direction: 'mine', status: 'canceled' })
    const res = await t.post('/butler/item/say', { id: String(made.id), text: SAID, append: true })
    expect(res.status).toBe(409)
    expect((await t.card(String(made.id)))?.desc).toBeUndefined()
  })
})

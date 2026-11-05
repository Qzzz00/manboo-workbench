// @vitest-environment node
/**
 * 进度靠证据 —— 服务那一半(2026-09-25,卡 N,`server/progress.ts`)。
 *
 * 看板用真的 tasks.json(临时目录);仓库、会话文件、模型全是注入的假件(内存里的「文件」、照 git 输出格式的假 git、
 * 回固定 JSON 的假模型)—— 一个真仓库、一次真模型调用都不碰。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROGRESS_NONE_LINE } from '../src/protocol.ts'
import type { OuterQuestionPort, ProgressModel } from '../src/server/progress.ts'
import { ACCESS_ALLOW, ACCESS_DENY, ACCESS_QUESTION, cardsToCheck, createProgressService, estimateCny, matchCards, recentOf, usageCny } from '../src/server/progress.ts'
import type { EvidenceItem } from '../src/server/progressEvidence.ts'
import type { SourceDeps } from '../src/server/progressSources.ts'
import { codexEvidence, repoEvidence } from '../src/server/progressSources.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { turnsOf } from '../src/server/sessionDigest.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const REPO = '/repo/desktop-workbench'
const CODEX = '/home/.codex'
const SITE_ROLLOUT = `${CODEX}/sessions/2026/09/23/rollout-2026-09-23T13-51-08-01a0ccd1-5e62-7eb2-a0af-224d9d844cfd.jsonl`
const LAST_ANSWER = '已整理成 参赛网页逐屏文案稿。11 屏按网页顺序排列，每屏都标清了页面标题、正文、要点、示例和折叠说明，方便你逐段看、直接圈改。'

function line(type: string, payload: Record<string, unknown>, at: string): string {
  return JSON.stringify({ timestamp: at, type, payload })
}

/** 内存里的几个文件 + 一个照 git 输出格式回话的假 git。 */
function fakeSources(files: Record<string, string>, git: Record<string, string> = {}): SourceDeps {
  const mtime = (path: string): number => (path.includes('2026/09/23') || path.includes('2026/09/25') ? Date.parse('2026-09-25T06:00:00Z') : Date.parse('2026-09-25T05:00:00Z'))
  return {
    git: async (_repo, args) => {
      const key = args.includes('--name-only') ? 'docs' : args[0] === 'show' ? `show:${args[1]}` : 'log'
      return git[key]
    },
    readDir: async (dir) => {
      const prefix = `${dir.replace(/\/+$/, '')}/`
      const names = new Set<string>()
      for (const path of Object.keys(files)) if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0] as string)
      if (names.size === 0) throw new Error('ENOENT')
      return [...names]
    },
    stat: async (path) => (files[path] === undefined ? undefined : { mtimeMs: mtime(path), size: Buffer.byteLength(files[path] as string), dir: false }),
    // 会话读法全仓一份(卡 P 的 sessionDigest):内存里的记录走同一个 turnsOf,只是不碰真盘。
    readTurns: async (ref, options) => {
      const text = files[ref.file]
      if (text === undefined) return undefined
      const tail = text.slice(Math.max(0, text.length - options.tailBytes))
      return turnsOf(ref.format, { head: text, tail, ...(ref.name === undefined ? {} : { name: ref.name }) })
    },
    readFile: async path => files[path],
  }
}

const SITE_FILES: Record<string, string> = {
  [SITE_ROLLOUT]: [
    line('session_meta', { id: '01a0ccd1-5e62-7eb2-a0af-224d9d844cfd', cwd: REPO, source: 'vscode' }, '2026-09-23T05:51:32Z'),
    line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '给我一个文档...写清楚哪个是标题，我自己先看着看看' }] } }, '2026-09-24T12:13:01Z'),
    line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: LAST_ANSWER }] } }, '2026-09-24T12:17:00Z'),
  ].join('\n'),
  [`${CODEX}/session_index.jsonl`]: JSON.stringify({ id: '01a0ccd1-5e62-7eb2-a0af-224d9d844cfd', thread_name: '制作参赛网页' }),
}

const RELEASE_MD = [
  '| 版本 | 日期 | 你会看到什么 | 交接 |',
  '|---|---|---|---|',
  '| 0.2.98 | 09-25 | 派活回答再干净一层:剥掉 Codex 答完那几秒给读屏挂的字 | `docs/交接-0925-远程派活六家.md` |',
  '| 0.2.87 | 09-24 | ① 远程派活六家:Codex、Claude、Kimi、Muse、Manus、豆包都能派、结果收回到卡上 | `docs/交接-0925-远程派活六家.md` |',
  '| 0.2.85 | 09-24 | ① 额度只列有额度的家(微信、企业微信不再算「接上」);球下「额度还差一步」卡 | `docs/交接-0925-额度与窗口槽/` |',
].join('\n')

const GIT = {
  log: 'aaaaaaaa11112222\x1f2026-09-25T02:50:00+08:00\x1f\x1ffix(dispatch): 读回答的锚点改成我们整条消息的末尾',
  docs: '\x1ebbbbbbbb\x1f2026-09-25T04:05:00+08:00\ndocs/发版记录.md\n',
  'show:bbbbbbbb:docs/发版记录.md': RELEASE_MD,
}

interface Rig {
  dir: string
  service: ReturnType<typeof createProgressService>
  tasks: ReturnType<typeof createTasksService>
  calls: { user: string, model: string, thinking: unknown }[]
}

type Access = 'allowed' | 'ask' | 'denied'
type Outcome = Awaited<ReturnType<OuterQuestionPort['ask']>['answer']>

interface RecordedAsk {
  sessionId: string
  questions: readonly unknown[]
  /** 「第一次问他是什么时候」(只有重启后挂回来的那几问带它,卡 U8)。 */
  at?: string
  resolve: (value: Outcome) => void
}

/** 一个记下每一问、等测试来答的外层提问(卡 M 那一套的形状)。 */
function recordingQuestions(): { port: OuterQuestionPort, asks: RecordedAsk[] } {
  const asks: RecordedAsk[] = []
  const port: OuterQuestionPort = {
    ask: (req) => {
      let resolve: (value: Outcome) => void = () => {}
      const answer = new Promise<Outcome>((ok) => { resolve = ok })
      asks.push({ sessionId: req.sessionId, questions: req.questions, ...(req.at === undefined ? {} : { at: req.at }), resolve })
      return { id: `q${asks.length}`, answer }
    },
  }
  return { port, asks }
}

/** 那一问的正文(记下来的那一条里第一问)。 */
function askText(one: RecordedAsk | undefined): string {
  return (one?.questions[0] as { question?: string } | undefined)?.question ?? ''
}

function rig(opts: {
  reply?: (user: string) => unknown
  budget?: number
  access?: Access | (() => Access)
  setAccess?: (allowed: boolean) => void
  model?: boolean
  /** 模型名(静态串或现取;own 档他自己填的名字,2026-10-23 卡「事务官换Key」)。 */
  modelName?: string | (() => Promise<string | undefined>)
  questions?: OuterQuestionPort
  files?: Record<string, string>
  now?: string
  /** 在**已有的**那个目录上再起一个服务(卡 U8:「重启」= 同一份 progress.json / tasks.json 上重建服务)。 */
  dir?: string
} = {}): Rig {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'wb-progress-'))
  if (opts.dir === undefined) dirs.push(dir)
  let n = 0
  const now = new Date(opts.now ?? '2026-09-25T07:10:00Z')
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(now.getTime() / 1000), newId: () => `t-0000${++n}` })
  const calls: { user: string, model: string, thinking: unknown }[] = []
  const model: ProgressModel = {
    endpoint: async () => ({ ready: true, baseUrl: 'http://model.test/v1', key: 'k' }),
    ...(opts.modelName === undefined ? {} : { model: opts.modelName }),
    fetchImpl: (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { model: string, thinking?: unknown, messages: { content: string }[] }
      const user = body.messages[1]?.content ?? ''
      calls.push({ user, model: body.model, thinking: body.thinking })
      const json = opts.reply?.(user) ?? { items: [] }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(json) } }],
        usage: { prompt_tokens: 3000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 3000, completion_tokens: 400 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch,
  }
  const service = createProgressService({
    file: join(dir, 'progress.json'),
    now: () => now,
    tasks,
    projects: async () => [{ id: 'desktop-workbench', name: '工作台', path: REPO }],
    sources: fakeSources(opts.files ?? SITE_FILES, GIT),
    codexHome: CODEX,
    sessionAccess: async () => (typeof opts.access === 'function' ? opts.access() : opts.access ?? 'allowed'),
    ...(opts.setAccess === undefined ? {} : { setSessionAccess: async (allowed: boolean) => { opts.setAccess?.(allowed) } }),
    ...(opts.model === false ? {} : { model }),
    budgetCny: async () => opts.budget ?? 0.5,
    ...(opts.questions === undefined ? {} : { questions: opts.questions }),
  })
  return { dir, service, tasks, calls }
}

/** 维护者那份看板的形状(只取评估要看的几张)。 */
async function seed(r: Rig): Promise<Record<string, string>> {
  const sprint = await r.tasks.createSprint({ projectId: 'desktop-workbench', name: 'Spotlight 参赛 · 10-04' })
  const material = await r.tasks.createModule({ sprintId: sprint.id as string, name: '参赛材料' })
  const core = await r.tasks.createModule({ sprintId: sprint.id as string, name: '核心能力与打磨' })
  const ids: Record<string, string> = {}
  const add = async (key: string, input: Parameters<typeof r.tasks.create>[0]): Promise<void> => {
    const made = await r.tasks.create({ projectId: 'desktop-workbench', origin: 'onboarding', ...input })
    ids[key] = made.id as string
  }
  await add('site', { title: '参赛网页架构收尾', assignee: 'codex', moduleId: material.id as string, desc: '第一条:让 Codex 把参赛网页的架构剩下的补完' })
  await r.tasks.update(ids.site as string, { clientDispatch: { hand: 'window', family: 'codex', status: 'sent', at: '2026-09-25T05:42:05Z', text: '【工作台派活 x】接着「制作参赛网页」那条会话的工作', reply_state: 'done', reply: '已接着原有11屏补完导航、异常回退和构建校验。\n还差文案定稿、真实界面素材和下载地址；手机真机尚未验收，视频未动。' } })
  await add('domain', { title: '注册域名', assignee: 'me', moduleId: material.id as string })
  await add('remote', { title: '手机远程派单 + 汇报 / 进度评估准确', assignee: 'claude', moduleId: core.id as string, priority: 'high' })
  await add('quota', { title: '额度显示 / 会话读取', assignee: 'claude', moduleId: core.id as string, priority: 'low' })
  return ids
}

const SITE_REPLY = (ids: Record<string, string>) => (user: string) => {
  const t = (title: string) => /T(\d+) 「([^」]+)」/g
  const map = new Map<string, string>()
  for (const match of user.matchAll(t(''))) map.set(match[2] as string, `T${match[1]}`)
  const key = (title: string) => map.get(title) ?? 'T0'
  const e = (source: string) => {
    const found = [...user.matchAll(/(E\d+) \[([^\]]+)\]/g)].find(m => (m[2] as string).startsWith(source))
    return found?.[1] ?? 'E0'
  }
  void ids
  return { items: [
    { id: key('参赛网页架构收尾'), found: true, now: '11 屏已做完,逐屏文案稿在等你审', waiting_on: 'me',
      basis: [{ e: e('Codex 里「制作参赛网页」'), quote: '11 屏按网页顺序排列，每屏都标清了页面标题' }],
      next: [
        { title: '真实界面素材', owner: 'me', e: e('Codex 交回来的话'), quote: '还差文案定稿、真实界面素材和下载地址' },
        { title: '下载地址', owner: 'unknown', e: e('Codex 交回来的话'), quote: '还差文案定稿、真实界面素材和下载地址' },
        { title: '文案定稿', owner: 'colleague', e: e('Codex 交回来的话'), quote: '还差文案定稿、真实界面素材和下载地址' },
      ] },
    { id: key('手机远程派单 + 汇报 / 进度评估准确'), found: true, now: '六家远程派活已通,读回答两次清洗(0.2.97/0.2.98)', waiting_on: 'agent',
      basis: [{ e: e('更新说明 0.2.87'), quote: '远程派活六家:Codex、Claude、Kimi、Muse、Manus、豆包都能派' }], next: [] },
    { id: key('额度显示 / 会话读取'), found: true, now: '额度只列有额度的家(0.2.85)', basis: [{ e: e('更新说明 0.2.85'), quote: '额度只列有额度的家' }], next: [] },
    // 模型硬说找到了域名的证据,摘录却是编的 —— 核不上,丢。
    { id: key('注册域名'), found: true, now: '域名注册好了', basis: [{ e: 'E1', quote: '域名已经注册好了,指向 GitHub Pages' }], next: [] },
  ] }
}

describe('看板上该核哪几张', () => {
  it('事项与引导排的;在办的与三天内办完的;通话纪要、测试留下的、选题、取消的不核', () => {
    const base = { source: { kind: 'manual' as const }, created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z' }
    const now = new Date('2026-09-25T07:00:00Z')
    const picked = cardsToCheck([
      { ...base, id: 'a', title: '参赛网页架构收尾', status: 'done', done_at: '2026-09-25T06:27:00Z', assignee: 'codex' },
      { ...base, id: 'b', title: '很久以前办完的', status: 'done', done_at: '2026-09-01T00:00:00Z', assignee: 'codex' },
      { ...base, id: 'c', title: '和事务官通了个电话(1 分)', status: 'done', direction: 'mine', origin: 'call' },
      { ...base, id: 'd', title: '[派活测试] 一天几小时', status: 'confirm', direction: 'mine', assignee: 'codex' },
      { ...base, id: 'e', title: '参赛视频', status: 'todo', origin: 'onboarding' },
      { ...base, id: 'f', title: '随手记一条', status: 'todo' },
      { ...base, id: 'g', title: '选题', status: 'todo', kind: 'topic' },
      { ...base, id: 'h', title: '取消了的', status: 'canceled', assignee: 'claude' },
    ], now)
    expect(picked.map(one => one.id).sort()).toEqual(['a', 'e'])
  })

  it('他问「XX 到哪了」认得出是哪一张', () => {
    const base = { status: 'todo' as const, source: { kind: 'manual' as const }, created_at: '', updated_at: '' }
    const tasks = [
      { ...base, id: 'site', title: '参赛网页架构收尾' },
      { ...base, id: 'video', title: '参赛视频' },
      { ...base, id: 'remote', title: '手机远程派单 + 汇报 / 进度评估准确' },
    ]
    const ctx = () => ['Spotlight 参赛 · 10-04', '参赛材料']
    expect(matchCards('参赛网页到哪了?', tasks, ctx).map(one => one.id)).toEqual(['site'])
    expect(matchCards('远程派单现在怎么样了', tasks, ctx).map(one => one.id)).toEqual(['remote'])
    expect(matchCards('今天天气', tasks, ctx)).toEqual([])
  })
})

describe('核一轮', () => {
  it('参赛网页:依据指向 Codex 那条会话的记录文件;下一步成「待排」卡;编出来的域名证据核不上 →「还没看到进展,要你说一句」', async () => {
    let ids: Record<string, string> = {}
    const r = rig({ reply: user => SITE_REPLY(ids)(user) })
    ids = await seed(r)
    const result = await r.service.evaluate({ trigger: 'manual' })
    const by = (id: string) => result.results.find(one => one.task_id === id)?.progress
    expect(by(ids.site as string)?.line).toBe('11 屏已做完,逐屏文案稿在等你审')
    expect(by(ids.site as string)?.basis[0]?.ref).toBe(SITE_ROLLOUT)
    expect(by(ids.site as string)?.waiting_on).toBe('me')
    expect(by(ids.domain as string)?.line).toBe(PROGRESS_NONE_LINE)
    expect(by(ids.domain as string)?.state).toBe('none')
    // 这一轮看了各家的对话:没看到进展时「我在哪儿找过」照它说。
    expect(by(ids.domain as string)?.read_sessions).toBe(true)
    // 出处是人话:不带文件名、路径、提交号(ref 里留着给查的人用)。
    expect(by(ids.site as string)?.basis[0]?.source).toBe('Codex 里「制作参赛网页」那段对话')
    expect(by(ids.remote as string)?.basis[0]?.source).toBe('更新说明 0.2.87')
    // 「额度显示 / 会话读取」按截比:摘录「额度只列有额度的家」只沾了「额度」一个词、没说到「额度显示」这件事 → 不算依据(宁可要你说一句)。
    expect(by(ids.quota as string)?.line).toBe(PROGRESS_NONE_LINE)
    // 「文案定稿」和看板上的……没有「参赛文案」这张时照样提;这里三条都提(一轮最多三条)。
    expect(result.proposed.map(one => one.title)).toEqual(['真实界面素材', '下载地址', '文案定稿'])
    const board = (await r.tasks.list()).tasks
    const proposed = board.find(one => one.title === '真实界面素材')
    expect(proposed?.status).toBe('backlog')
    expect(proposed?.origin).toBe('evidence')
    expect(proposed?.assignee).toBe('me')
    expect(proposed?.desc).toMatch(/^Codex 交回来的话里提到还要做这件\(\d+月\d+日 \d{2}:\d{2}\):「还差文案定稿、真实界面素材和下载地址」\n要加上就点「加上」,不要就点「不要」。$/)
    expect(board.find(one => one.title === '下载地址')?.assignee).toBeUndefined()
    // 问的是 V4 Flash、关掉「先想一遍」(不关的话两千个 token 全花在想上、正文不回 —— 真看板副本上撞到过)。
    expect(r.calls.every(call => call.model === 'deepseek-v4-flash')).toBe(true)
    expect(r.calls.every(call => JSON.stringify(call.thinking) === JSON.stringify({ type: 'disabled' }))).toBe(true)
    // 花了多少记账:缺省模型是 V4 Flash(关掉先想一遍),按 Flash 价:3000 未命中 × 2 + 400 输出 × 8(元 / 百万)一批。
    expect(result.spend_cny).toBeCloseTo((3000 * 2 + 400 * 8) / 1_000_000)
    expect(r.service.runState().today_cny).toBeCloseTo(result.spend_cny)
    // 落盘的只有核过的摘录,没有会话原文。
    const saved = readFileSync(join(r.dir, 'progress.json'), 'utf8')
    expect(saved).toContain('11 屏按网页顺序排列')
    expect(saved).not.toContain('方便你逐段看、直接圈改')
  })

  it('own 档他自己填的模型名照用(2026-10-23,卡「事务官换Key」):现取的函数,取不到才回缺省', async () => {
    let ids: Record<string, string> = {}
    const r = rig({ reply: user => SITE_REPLY(ids)(user), modelName: async () => 'his-own-model' })
    ids = await seed(r)
    await r.service.evaluate({ trigger: 'manual' })
    expect(r.calls.length).toBeGreaterThan(0)
    expect(r.calls.every(call => call.model === 'his-own-model')).toBe(true)
  })

  it('有证据的卡自己从「待办」走到「在办」、依据留在卡上,不回过头来问他(2026-09-27,卡 WY / 设计第五节 B)', async () => {
    let ids: Record<string, string> = {}
    const { port, asks } = recordingQuestions()
    const r = rig({ reply: user => SITE_REPLY(ids)(user), questions: port })
    ids = await seed(r)
    const result = await r.service.evaluate({ trigger: 'manual' })
    const board = (await r.tasks.list()).tasks
    const site = board.find(one => one.id === ids.site)
    // 证据说它在动 → 状态自己推过去;「现在到哪」与出处就是那条依据(现算进 /state 的 `task.progress`,他要撤自己拖回去)。
    expect(site?.status).toBe('doing')
    const seen = result.results.find(one => one.task_id === ids.site)
    expect(seen?.progress.state).toBe('found')
    expect(seen?.progress.basis[0]?.source).toBe('Codex 里「制作参赛网页」那段对话')
    // 这张卡不再挂「进度要你说一句」;没证据的那张(额度显示)照旧问 —— 那一问只是不再进「等你」。
    expect(asks.some(one => one.sessionId === `progress:${ids.site as string}`)).toBe(false)
    // 证据里冒出来的「待排」卡是提议,不替他推状态。
    expect(board.find(one => one.title === '真实界面素材')?.status).toBe('backlog')
  })

  it('没有候选证据的卡不问模型;证据没变的卡 24 小时内不重问(他当场问的除外)', async () => {
    let ids: Record<string, string> = {}
    const r = rig({ reply: user => SITE_REPLY(ids)(user) })
    ids = await seed(r)
    await r.service.evaluate({ trigger: 'manual' })
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]?.user.split('【证据】')[0]).not.toContain('「注册域名」')
    await r.service.evaluate({ trigger: 'manual' })
    expect(r.calls).toHaveLength(1)
    await r.service.evaluate({ trigger: 'ask', taskIds: [ids.site as string], force: true })
    expect(r.calls).toHaveLength(2)
  })

  it('到了花费上限:不问模型,按规则只摘原话,如实写一句', async () => {
    let ids: Record<string, string> = {}
    const r = rig({ budget: 0.01, reply: user => SITE_REPLY(ids)(user) })
    ids = await seed(r)
    const result = await r.service.evaluate({ trigger: 'manual' })
    expect(r.calls).toHaveLength(0)
    expect(result.by).toBe('rules')
    expect(result.note).toContain('花费到了上限')
    const site = result.results.find(one => one.task_id === ids.site)?.progress
    expect(site?.by).toBe('rules')
    // 规则那一套也认得出「球在他那儿」(会话最后:他要了文档自己先看 → Codex 交了 → 他没回话),依据是那家交东西那一句。
    expect(site?.line).toContain('参赛网页逐屏文案稿在等你审')
    expect(site?.waiting_on).toBe('me')
    expect(site?.basis[0]?.ref).toBe(SITE_ROLLOUT)
  })

  it('没接模型:只用规则;没有证据的照样是「还没看到进展,要你说一句」', async () => {
    const r = rig({ model: false })
    const ids = await seed(r)
    const result = await r.service.evaluate({ trigger: 'manual' })
    expect(result.note).toBe('模型服务没接上,这次只摘了原话,没细判')
    expect(result.results.find(one => one.task_id === ids.domain)?.progress.line).toBe(PROGRESS_NONE_LINE)
  })

  it('各家的对话要他点头(授权表「要问」):这一轮不读对话;在外层问他一次 —— 是提问不是审批,为什么要看、看了得到什么都说到;点「可以」记进授权表、再核一轮', async () => {
    let ids: Record<string, string> = {}
    let access: Access = 'ask'
    const set: boolean[] = []
    const { port, asks } = recordingQuestions()
    const r = rig({ access: () => access, setAccess: (allowed) => { set.push(allowed); access = allowed ? 'allowed' : 'denied' }, questions: port, reply: user => SITE_REPLY(ids)(user) })
    ids = await seed(r)
    const result = await r.service.evaluate({ trigger: 'manual' })
    expect(result.note).toBe('你还没点头让我看各家的对话,这次只看了项目文件夹和看板')
    expect(r.calls[0]?.user).not.toContain('制作参赛网页')
    expect(r.service.runState().sessions).toBe('ask')
    // 没看到进展的那几张:「我在哪儿找过」不说看过对话。
    expect(result.results.find(one => one.task_id === ids.domain)?.progress.read_sessions).toBe(false)
    const accessAsks = asks.filter(one => one.sessionId === 'progress:access')
    expect(accessAsks).toHaveLength(1)
    const question = accessAsks[0]?.questions[0] as { question: string, detail: string, options: { label: string, description: string }[] }
    expect(question).toEqual(ACCESS_QUESTION)
    // 为什么要看、看了得到什么、不同意会怎样、发给模型这件事,都说到;不说「会话」「授权」「证据」这些词。
    const words = JSON.stringify(question)
    expect(words).toContain('不用你一件件告诉我')
    expect(words).toContain('发给 AI 看一眼')
    expect(words).toContain('只看项目文件夹和看板')
    expect(words).not.toMatch(/会话|授权|证据|仓库/)
    expect(question.options.map(one => one.label)).toEqual([ACCESS_ALLOW, ACCESS_DENY])
    // 再核一轮不再问第二次。
    await r.service.evaluate({ trigger: 'manual' })
    expect(asks.filter(one => one.sessionId === 'progress:access')).toHaveLength(1)
    // 他点「可以,以后都这样看」:记进授权表,再核一轮就读对话了。
    const before = r.calls.length
    accessAsks[0]?.resolve({ kind: 'answer', answers: [{ id: 'access', selected: [ACCESS_ALLOW] }] })
    await vi.waitFor(() => expect(r.calls.length).toBeGreaterThan(before), { timeout: 5000 })
    expect(set).toEqual([true])
    expect(r.calls.at(-1)?.user).toContain('制作参赛网页')
    expect(r.service.runState().sessions).toBe('allowed')
  })

  it('各家的对话那一问他点「不行」:记成不可以,之后只看项目文件夹和看板,不再问', async () => {
    let access: Access = 'ask'
    const set: boolean[] = []
    const { port, asks } = recordingQuestions()
    const r = rig({ model: false, access: () => access, setAccess: (allowed) => { set.push(allowed); access = allowed ? 'allowed' : 'denied' }, questions: port })
    await seed(r)
    await r.service.evaluate({ trigger: 'manual' })
    asks.find(one => one.sessionId === 'progress:access')?.resolve({ kind: 'answer', answers: [{ id: 'access', selected: [ACCESS_DENY] }] })
    await vi.waitFor(() => expect(set).toEqual([false]), { timeout: 5000 })
    await r.service.evaluate({ trigger: 'manual' })
    expect(asks.filter(one => one.sessionId === 'progress:access')).toHaveLength(1)
    expect(r.service.runState().sessions).toBe('denied')
  })
})

describe('他说一句 / 他问一句', () => {
  it('他说一句:记成证据,那张卡当场再核一次;「不做了」→ 卡改取消(不删)', async () => {
    const r = rig({ model: false })
    const ids = await seed(r)
    const said = await r.service.said(ids.domain as string, '还没开始,等参赛网页定稿再弄')
    expect(said.ok).toBe(true)
    expect(said.progress?.line).toContain('还没开始,等参赛网页定稿再弄')
    expect(said.progress?.basis[0]?.kind).toBe('said')
    const quit = await r.service.said(ids.quota as string, '不做了')
    expect(quit.note).toContain('取消')
    expect((await r.tasks.list()).tasks.find(one => one.id === ids.quota)?.status).toBe('canceled')
  })

  it('他问「参赛网页到哪了」:当场核那一张,回一句能念的(带依据)', async () => {
    let ids: Record<string, string> = {}
    const r = rig({ reply: user => SITE_REPLY(ids)(user) })
    ids = await seed(r)
    const answer = await r.service.ask('参赛网页到哪了?')
    expect(answer.ok).toBe(true)
    // 这一句会存下来(挂在卡上、念给他听):时刻写「9月24日 20:17」,不写「昨天」。
    expect(answer.line).toMatch(/^「参赛网页架构收尾」:11 屏已做完,逐屏文案稿在等你审\(依据:Codex 里「制作参赛网页」那段对话 · \d+月\d+日 \d{2}:17\)$/)
    const miss = await r.service.ask('天气怎么样')
    expect(miss.ok).toBe(false)
  })

  it('「要你说一句」走外层提问(卡 M 那套):同一时刻最多两问;问句说人话;他答了记成口述', async () => {
    const { port: questions, asks } = recordingQuestions()
    const r = rig({ model: false, questions })
    const ids = await seed(r)
    await r.tasks.create({ title: '租服务器', assignee: 'me', projectId: 'desktop-workbench' })
    await r.service.evaluate({ trigger: 'manual' })
    expect(asks).toHaveLength(2)
    expect(asks.every(one => one.sessionId.startsWith('progress:'))).toBe(true)
    const domainAsk = asks.find(one => one.sessionId === `progress:${ids.domain}`)
    const asked = domainAsk?.questions[0] as { question: string }
    expect(asked.question).toBe('「注册域名」现在到哪了?项目文件夹、交出去的活、你跟各家 AI 的对话里,都没说到这件事做到哪了,你说一句我记下来。')
    domainAsk?.resolve({ kind: 'answer', answers: [{ id: 'said', selected: ['还没开始'] }] })
    // 他答了 → 记成口述、当场再核一次(机器忙时要多等一会儿:等到为止,不用固定的几十毫秒)。
    await vi.waitFor(() => expect(r.service.cardViews().get(ids.domain as string)?.basis[0]?.kind).toBe('said'), { timeout: 5000 })
  })
})

/**
 * 0.4.1 → 0.4.2 热更新重启之后球下的「等你」从 6 变 4,少的正是两条「进度要你说一句」
 * (交接-0924 末尾;提问经纪人只在内存里)。按「第一次用的人」看:重启不该让他之前看到的问题凭空消失。
 * 「重启」在这里就是**在同一份 progress.json / tasks.json 上重建一个服务**,同热更新那一下。
 */
describe('重启之后那几问还在(卡 U8)', () => {
  it('★挂着两问 → 重启 → 原话、第一次问的时刻原样挂回来;答掉一问 → 重启 → 只剩一问', async () => {
    const first = recordingQuestions()
    const r = rig({ model: false, questions: first.port })
    const ids = await seed(r)
    await r.tasks.create({ title: '租服务器', assignee: 'me', projectId: 'desktop-workbench' })
    await r.service.evaluate({ trigger: 'manual' })
    expect(first.asks).toHaveLength(2)
    const asked = first.asks.map(one => ({ sessionId: one.sessionId, question: askText(one) })).sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    // 挂着的那两问落在 progress.json 的 asks 里(键是事项 id,值是原话与时刻)。
    const stored = JSON.parse(readFileSync(join(r.dir, 'progress.json'), 'utf8')) as { asks: Record<string, { question: string, at: string }> }
    expect(Object.keys(stored.asks).sort()).toEqual(asked.map(one => one.sessionId.slice('progress:'.length)).sort())
    expect(Object.values(stored.asks).every(one => one.at === '2026-09-25T07:10:00.000Z')).toBe(true)

    // ── 重启:同一个目录上重建服务,只叫 resume(不核一轮 —— 一个模型都不该问)──
    const second = recordingQuestions()
    const again = rig({ dir: r.dir, model: false, questions: second.port })
    await again.service.resume()
    expect(second.asks.map(one => ({ sessionId: one.sessionId, question: askText(one) })).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual(asked)
    // 原样挂回 = 连「第一次问他是什么时候」都是原来那个,不是刚问的。
    expect(second.asks.every(one => one.at === '2026-09-25T07:10:00.000Z')).toBe(true)
    // 叫第二次是空操作(不会挂出两份)。
    await again.service.resume()
    expect(second.asks).toHaveLength(2)

    // ── 他答掉一问 ──
    const answered = second.asks.find(one => one.sessionId === `progress:${ids.domain}`) ?? second.asks[0] as RecordedAsk
    const answeredId = answered.sessionId.slice('progress:'.length)
    const keptId = second.asks.map(one => one.sessionId.slice('progress:'.length)).find(id => id !== answeredId) as string
    answered.resolve({ kind: 'answer', answers: [{ id: 'said', selected: ['在做'] }] })
    await vi.waitFor(() => {
      const now = JSON.parse(readFileSync(join(r.dir, 'progress.json'), 'utf8')) as { asks: Record<string, unknown> }
      expect(Object.keys(now.asks)).toEqual([keptId])
    }, { timeout: 5000 })

    // ── 再重启:只剩他没答的那一问 ──
    const third = recordingQuestions()
    const last = rig({ dir: r.dir, model: false, questions: third.port })
    await last.service.resume()
    expect(third.asks.map(one => one.sessionId)).toEqual([`progress:${keptId}`])
  })

  it('卡已经办完 / 取消 / 不在看板上了:那一问不再挂回来,账上也删掉', async () => {
    const first = recordingQuestions()
    const r = rig({ model: false, questions: first.port })
    const ids = await seed(r)
    await r.service.evaluate({ trigger: 'manual' })
    expect(first.asks.length).toBeGreaterThan(0)
    // 挂着问的那几张,一张挪到「完成」,另一张从看板上抹掉(账上那两条都该作废)。
    const hanging = first.asks.map(one => one.sessionId.slice('progress:'.length))
    await r.service.said(hanging[0] as string, '做完了')
    const file = join(r.dir, 'progress.json')
    const data = JSON.parse(readFileSync(file, 'utf8')) as { asks: Record<string, { question: string, at: string }> }
    // said 已经把答掉的那条划掉了;手动往账上摆一条「看板上已经没有这张卡」的,看它挂不挂。
    data.asks['t-不存在'] = { question: '「早没了」现在到哪了?', at: '2026-09-25T07:10:00.000Z' }
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)

    const second = recordingQuestions()
    const again = rig({ dir: r.dir, model: false, questions: second.port })
    await again.service.resume()
    expect(second.asks.map(one => one.sessionId)).not.toContain('progress:t-不存在')
    expect(second.asks.map(one => one.sessionId)).not.toContain(`progress:${hanging[0]}`)
    void ids
    const after = JSON.parse(readFileSync(file, 'utf8')) as { asks: Record<string, unknown> }
    expect(Object.keys(after.asks)).not.toContain('t-不存在')
  })

  it('「看各家的对话」那一问也挂回来;他已经定了「可以 / 不行」就不再问,账上那一条作废', async () => {
    let access: Access = 'ask'
    const first = recordingQuestions()
    const r = rig({ model: false, access: () => access, setAccess: () => {}, questions: first.port })
    await seed(r)
    await r.service.evaluate({ trigger: 'manual' })
    expect(first.asks.filter(one => one.sessionId === 'progress:access')).toHaveLength(1)
    const file = join(r.dir, 'progress.json')
    await vi.waitFor(() => {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { asks: Record<string, unknown> }
      expect(Object.keys(data.asks)).toContain('access')
    }, { timeout: 5000 })

    // 还是「要问」:重启后照样挂回来(他上次看到的那一问没凭空消失)。
    const second = recordingQuestions()
    const again = rig({ dir: r.dir, model: false, access: () => access, setAccess: () => {}, questions: second.port })
    await again.service.resume()
    const back = second.asks.filter(one => one.sessionId === 'progress:access')
    expect(back).toHaveLength(1)
    expect(askText(back[0])).toBe(ACCESS_QUESTION.question)
    expect(back[0]?.at).toBe('2026-09-25T07:10:00.000Z')

    // 他在设置里定了:这一问作废,不再挂,账上也删掉。
    access = 'allowed'
    const third = recordingQuestions()
    const last = rig({ dir: r.dir, model: false, access: () => access, setAccess: () => {}, questions: third.port })
    await last.service.resume()
    expect(third.asks.filter(one => one.sessionId === 'progress:access')).toHaveLength(0)
    // 别的那几问(「进度要你说一句」)不受影响,照样挂回来。
    expect(third.asks.filter(one => one.sessionId.startsWith('progress:t-')).length).toBeGreaterThan(0)
    const data = JSON.parse(readFileSync(file, 'utf8')) as { asks: Record<string, unknown> }
    expect(Object.keys(data.asks)).not.toContain('access')
  })
})

describe('早报之前:只念变了的', () => {
  it('第一轮全是变化;第二轮没变就不念;没看到进展的数一下', async () => {
    let ids: Record<string, string> = {}
    const r = rig({ reply: user => SITE_REPLY(ids)(user) })
    ids = await seed(r)
    const first = await r.service.beforeMorning()
    expect(first.lines.find(one => one.startsWith('进度有变化的'))).toContain('「参赛网页架构收尾」11 屏已做完,逐屏文案稿在等你审')
    expect(first.lines.find(one => one.startsWith('进度有变化的'))).toContain('(Codex 里「制作参赛网页」那段对话)')
    expect(first.lines.find(one => one.startsWith('对话里提到'))).toBe('对话里提到还要做的,等你点头加不加:真实界面素材、下载地址、文案定稿')
    expect(first.lines.find(one => one.startsWith('还有'))).toContain('我没看到进展,要你说一句:注册域名')
    const second = await r.service.beforeMorning()
    expect(second.lines.find(one => one.startsWith('进度有变化的'))).toBeUndefined()
  })
})

describe('读会话走卡 P 那一份读法(sessionDigest.readSessionTurns / turnsOf)', () => {
  it('尾巴 1MB 里只剩那家的话、看不到他那句 → 放大到 4MB 再读一次;标题照 session_index;子任务不算', async () => {
    const big = `${CODEX}/sessions/2026/09/25/rollout-2026-09-25T09-00-00-0badc0de-0000-4000-8000-000000000001.jsonl`
    const sub = `${CODEX}/sessions/2026/09/25/rollout-2026-09-25T10-00-00-0badc0de-0000-4000-8000-000000000002.jsonl`
    const filler = Array.from({ length: 900 }, (_, i) => line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: `在跑第 ${i} 步 ${'·'.repeat(1200)}` }] } }, '2026-09-25T01:30:00Z'))
    const files: Record<string, string> = {
      [big]: [
        line('session_meta', { id: '0badc0de-0000-4000-8000-000000000001', cwd: REPO, source: 'vscode' }, '2026-09-25T01:00:00Z'),
        line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '把参赛网页的导航补完' }] } }, '2026-09-25T01:00:01Z'),
        ...filler,
        line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: '导航补完了,构建校验过了。' }] } }, '2026-09-25T02:00:00Z'),
      ].join('\n'),
      [sub]: [
        line('session_meta', { id: '0badc0de-0000-4000-8000-000000000002', cwd: REPO, source: { subagent: { other: 'guardian' } } }, '2026-09-25T02:00:00Z'),
        line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '审一下这次改动' }] } }, '2026-09-25T02:00:01Z'),
        line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: '没问题。' }] } }, '2026-09-25T02:01:00Z'),
      ].join('\n'),
      [`${CODEX}/session_index.jsonl`]: [
        JSON.stringify({ id: '0badc0de-0000-4000-8000-000000000001', thread_name: '参赛网页导航' }),
      ].join('\n'),
    }
    expect(Buffer.byteLength(files[big] as string)).toBeGreaterThan(1_000_000)
    const reads: number[] = []
    const base = fakeSources(files)
    const deps: SourceDeps = { ...base, readTurns: async (ref, options) => { reads.push(options.tailBytes); return await base.readTurns(ref, options) } }
    const out = await codexEvidence({
      codexHome: CODEX,
      projects: [{ id: 'desktop-workbench', name: '工作台', path: REPO }],
      since: new Date('2026-09-24T00:00:00Z'),
      now: new Date('2026-09-25T07:00:00Z'),
      taskIds: [],
      deps,
      cache: new Map(),
    })
    expect(out.map(one => one.source)).toEqual(['Codex 里「参赛网页导航」那段对话'])
    expect(out[0]?.text).toContain('他说:「把参赛网页的导航补完」')
    expect(out[0]?.text).toContain('Codex 答:「导航补完了,构建校验过了。」')
    // 大文件:先 1MB,不够一来一回再 4MB;子任务那条只读一次就跳过。
    expect(reads.filter(n => n === 4_000_000)).toHaveLength(1)
  })
})

describe('读仓库:还没合进 main 的活标出来;出处说人话', () => {
  it('分支上的提交与交接,出处带「还没并进正式版」;主线上的不带;出处里没有提交号、文件名(ref 里留着)', async () => {
    const MAIN_SHA = 'a'.repeat(40)
    const BRANCH_SHA = 'b'.repeat(40)
    const DOC_SHA = 'c'.repeat(40)
    const deps: SourceDeps = {
      ...fakeSources({}),
      git: async (_repo, args) => {
        if (args[0] === 'rev-parse') return MAIN_SHA
        if (args.includes('--name-only')) return `\x1e${DOC_SHA}\x1f2026-09-25T17:50:00+08:00\ndocs/交接-0925-某张卡.md\n`
        if (args[0] === 'show') return '# 交接 0925 · 某张卡:会话读法全仓一份\n\n读 Codex 会话换成一份。'
        if (args[0] === 'log' && args[1] === 'origin/main') return `${MAIN_SHA}\n`
        if (args[0] === 'log') return [
          `${MAIN_SHA}\x1f2026-09-25T14:37:10+08:00\x1f\x1fchore: 0.2.99 —— 卡片小头像不再被切`,
          `${BRANCH_SHA}\x1f2026-09-25T17:54:58+08:00\x1f\x1frefactor: 会话读法全仓一份`,
        ].join('\n')
        return undefined
      },
    }
    const out = await repoEvidence({ id: 'desktop-workbench', name: '工作台', path: REPO }, new Date('2026-09-24T00:00:00Z'), new Date('2026-09-25T10:00:00Z'), deps)
    expect(out.find(one => one.id === `commit:${MAIN_SHA.slice(0, 8)}`)?.source).toBe('项目里的一次改动')
    expect(out.find(one => one.id === `commit:${BRANCH_SHA.slice(0, 8)}`)?.source).toBe('项目里的一次改动(还没并进正式版)')
    expect(out.find(one => one.id === `commit:${BRANCH_SHA.slice(0, 8)}`)?.ref).toBe(BRANCH_SHA.slice(0, 12))
    const handoff = out.find(one => one.kind === 'handoff')
    expect(handoff?.source).toBe('工作记录「某张卡:会话读法全仓一份」(还没并进正式版)')
    expect(handoff?.doc).toBe('handoff')
    expect(handoff?.ref).toBe('docs/交接-0925-某张卡.md')
    for (const one of out) expect(one.source).not.toMatch(/[0-9a-f]{7,}|\.md\b|\/|main|分支|提交|交接/)
  })
})

describe('花费怎么算', () => {
  it('与中转同一张价目:deepseek-chat 按 Pro 那一档,flash 按 Flash;问之前宁可多估', () => {
    expect(usageCny('deepseek-chat', { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, completion_tokens: 100 }, 0)).toBeCloseTo((400 * 0.3 + 600 * 9 + 100 * 27) / 1_000_000)
    expect(usageCny('deepseek-v4-flash', { prompt_tokens: 1000, completion_tokens: 100 }, 0)).toBeCloseTo((1000 * 2 + 100 * 8) / 1_000_000)
    expect(estimateCny('deepseek-chat', 10_000, 2000)).toBeCloseTo((8000 * 9 + 2000 * 27) / 1_000_000)
  })
})

describe('这几天的总账', () => {
  it('交接与验收记录同提交一样只看主线上的:别的卡分支上的交接不进总账(09-25 晚六个位子全被它们占了);一条主线上的都没有才全看', () => {
    const handoff = (id: string, at: string, unmerged = false): EvidenceItem => ({ id, kind: 'handoff', doc: 'handoff', source: `工作记录「${id}」`, at, text: id, ...(unmerged ? { unmerged: true as const } : {}) })
    const evidence = [handoff('branch-1', '2026-09-25T19:00:00Z', true), handoff('branch-2', '2026-09-25T18:00:00Z', true), handoff('main-1', '2026-09-25T04:00:00Z')]
    expect(recentOf(evidence, []).filter(ev => ev.kind === 'handoff').map(ev => ev.id)).toEqual(['main-1'])
    expect(recentOf(evidence.slice(0, 2), []).map(ev => ev.id)).toEqual(['branch-1', 'branch-2'])
  })
})

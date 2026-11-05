/**
 * 「反馈给开发者」(2026-09-28,卡 FB)。本体的毛病不派人改,整理成一条发回来。
 *
 * ## 走的是自动上报那条路,不另开一条
 *
 * `POST /v1/diag/report`,`kind: 'feedback'`,同一个设备令牌、同一道脱敏(`redact.ts`)、
 * 同一个每小时 20 条的闸。**不新增一条通道**的理由:多一条路就多一处要配 Caddy、多一处要
 * 防没令牌的人乱发,而这件事跟自动上报要的东西一模一样。
 *
 * ## 发什么
 *
 * 她的原话(`said`)+ 事务官一句整理(`message`)+ 当时的版本 + 当时的模板 / 布局(`context`)。
 * **不含对话全文、不含凭据**:原话只有触发这条反馈的那一句,三格都过 `redactText`。
 * 截图这一版**不发**(要在中转上另开一条带体积上限的上传路,是另一张卡);
 * 她本机那一份可以记一个路径(`shot`),但那个字段不出这台机器。
 *
 * ## 为什么不看「出错自动报告给开发者」那颗开关
 *
 * 那颗开关管的是**机器自己偷偷报的错**。这一条是她说了一句、事务官当着她的面答应
 * 「我已经反馈给开发者了」—— 答应了又因为一颗她八成忘了的开关而没发,比不答应更糟。
 * 发不出去(没登录 / 网断)就如实落 `local` 并在体检页那一行写出来。
 *
 * ## 落盘
 *
 * `~/.dsh/workbench/feedback.json`,只留最近 `MAX_KEPT` 条。要落盘是因为体检页那一行
 * 「我反馈过的问题」得跨重启看得见,而且拿不准那一条要等她下一句话才定档。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { diagCode, type DiagReportBody, type FeedbackEntryView, type FeedbackListView } from '../../diag.ts'
import { redactText } from './redact.ts'

export function defaultFeedbackFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/feedback.json`
}

/** 留最近多少条。体检页那一行是给人看的,不是台账。 */
export const MAX_KEPT = 50

/** 原话与整理各自最多多长。中转那边也会再截一次。 */
export const MAX_SAID = 500
export const MAX_CONTEXT = 300

export interface FeedbackFile {
  version: 1
  items: FeedbackEntryView[]
}

export interface FeedbackDeps {
  file: string
  version: string
  now: () => number
  /** 中转地址 + 设备令牌。没登录回 undefined(那时候只落本机)。 */
  link: () => Promise<{ relayUrl: string, token: string } | undefined>
  /** 当时的模板 / 布局那一行。取不到就缺席 —— **不编一个**。 */
  context?: () => Promise<string | undefined>
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  timeoutMs?: number
  newId?: () => string
}

export interface FeedbackService {
  /** 重读盘上那一份。**造出来的时候自己已经读过一遍了**,这个方法是给"外面改了文件"那种情况留的。 */
  load: () => Promise<void>
  list: () => Promise<FeedbackListView>
  find: (id: string) => Promise<FeedbackEntryView | undefined>
  /**
   * 记一条。`status: 'asking'` 的先不发(事务官还在问她「改本体还是做工具」);
   * 别的当场尽力发一次,发不出去落 `local`。
   */
  add: (input: { said: string, note: string, ui?: string, status?: 'asking' | 'sent' }) => Promise<FeedbackEntryView>
  /** 拿不准那一条定档:`product` = 真是本体的毛病,发出去;`hers` = 不是,这一条撤掉。 */
  settle: (id: string, to: 'product' | 'hers') => Promise<FeedbackEntryView | undefined>
}

export function createFeedbackService(deps: FeedbackDeps): FeedbackService {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 8000
  const log = deps.log ?? (() => {})
  const newId = deps.newId ?? (() => `fb-${Math.random().toString(36).slice(2, 10)}`)
  let items: FeedbackEntryView[] = []

  async function readNow(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(deps.file, 'utf8')) as Partial<FeedbackFile>
      // 文件坏了 / 没有 = 一条都没有。**不抛**:一份读不懂的 json 不该让工作台起不来(同 devTool.ts)。
      items = Array.isArray(raw.items)
        ? raw.items.filter((one): one is FeedbackEntryView =>
          typeof one?.id === 'string' && typeof one.said === 'string' && typeof one.note === 'string')
        : []
    }
    catch { items = [] }
  }

  /**
   * **造出来就开始读**,每个方法先等它。
   * 理由:这个服务是 http.ts 里跟着 diag 一起造的,那儿没有一处"启动时逐个 await load()"的地方,
   * 而体检页那一行要是在头几毫秒里读成空的,她会以为反馈没记下。
   */
  const ready: Promise<void> = readNow()

  const save = async (): Promise<void> => {
    await mkdir(dirname(deps.file), { recursive: true })
    const payload: FeedbackFile = { version: 1, items }
    await writeFile(deps.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  /** 发一条。**永远不抛** —— 反馈发不出去不该再引发一次报错。 */
  async function send(entry: FeedbackEntryView): Promise<{ ok: true } | { ok: false, why: string }> {
    const target = await deps.link().catch(() => undefined)
    if (target === undefined) return { ok: false, why: '还没连上服务器(没登录),这一条先记在本机,登录后再说一次就能发出去。' }
    const body: DiagReportBody = {
      version: entry.version,
      component: 'plugin',
      kind: 'feedback',
      code: entry.code,
      // 一句整理当正文:统筹拉列表时一眼看得出是哪一格的什么毛病。
      message: redactText(entry.note).slice(0, MAX_SAID),
      stack: [],
      log: [],
      at: entry.at,
      merged: 1,
      said: redactText(entry.said).slice(0, MAX_SAID),
      ...(entry.context === undefined ? {} : { context: redactText(entry.context).slice(0, MAX_CONTEXT) }),
    }
    try {
      const res = await fetchImpl(`${target.relayUrl}/v1/diag/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) return { ok: true }
      if (res.status === 429) return { ok: false, why: '这一小时报满了,这一条先记在本机。' }
      return { ok: false, why: `服务器没收(HTTP ${res.status}),这一条先记在本机。` }
    }
    catch (error) {
      return { ok: false, why: `发不出去:${redactText(error instanceof Error ? error.message : String(error))}` }
    }
  }

  async function push(entry: FeedbackEntryView): Promise<FeedbackEntryView> {
    const out = await send(entry)
    // 发成了就把上一次那句「为什么没发出去」擦掉 —— 留着会让体检页同时写着「已收到」和一句失败原因。
    const { why: _dropped, ...rest } = entry
    const next: FeedbackEntryView = out.ok
      ? { ...rest, status: 'sent' }
      : { ...rest, status: 'local', why: out.why }
    items = [next, ...items.filter(one => one.id !== entry.id)].slice(0, MAX_KEPT)
    await save()
    log(`[反馈] ${next.code} ${next.status === 'sent' ? '已发给开发者' : `没发出去:${next.why ?? ''}`}:${next.note}`)
    return next
  }

  return {
    load: readNow,

    async list() {
      await ready
      return { items: [...items], sent: items.filter(one => one.status === 'sent').length }
    },

    async find(id) {
      await ready
      return items.find(one => one.id === id)
    },

    async add(input) {
      await ready
      const atMs = deps.now()
      const context = await deps.context?.().catch(() => undefined)
      const entry: FeedbackEntryView = {
        id: newId(),
        code: diagCode('plugin', atMs),
        at: new Date(atMs).toISOString(),
        said: input.said.trim().slice(0, MAX_SAID),
        note: input.note,
        ...(input.ui === undefined ? {} : { ui: input.ui }),
        version: deps.version,
        ...(context === undefined || context === '' ? {} : { context: context.slice(0, MAX_CONTEXT) }),
        status: 'local',
      }
      if (input.status === 'asking') {
        items = [{ ...entry, status: 'asking' as const }, ...items].slice(0, MAX_KEPT)
        await save()
        return items[0] as FeedbackEntryView
      }
      return await push(entry)
    },

    async settle(id, to) {
      await ready
      const found = items.find(one => one.id === id)
      if (found === undefined) return undefined
      if (to === 'hers') {
        items = items.filter(one => one.id !== id)
        await save()
        return { ...found, status: 'local', why: '你说了这不是工作台本身的问题,这一条撤掉了。' }
      }
      return await push({ ...found, status: 'local' })
    },
  }
}

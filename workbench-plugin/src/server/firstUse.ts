/**
 * **三件主路成没成**(2026-10-21,卡「引导三件事」;设计 `docs/设计-拿得出手-三件事与首次引导-2026-10-15.md`,
 * 共享口径在 `src/mainPaths.ts`)。
 *
 * ## 判法:全从现成的记录里看
 *
 * 不另起一套「这件成了」的状态,也不改派活、早报、通话那几处的代码:
 *   · **早报** —— 例程那一次(`/state.routines.last.morning`)出了,且当天播客有文件(播客关着的机器只看早报);
 *   · **交代** —— 卡上的派活记录(命令行那份 `dispatch`、协议那份 `client_dispatch`)交回了话;只认协议路那两家
 *     Claude / Codex,读窗口那几家(豆包 / Kimi)不算主路;派不出去(`dispatch_block`)算没成,缺哪道门照卡上那颗键;
 *   · **电话** —— 不在这里看:电话里建卡 / 捎话那几条路当场 {@link FirstUseService.record}(没配手机的人,
 *     在电脑上对她说一句建成事项也算这一件)。
 *
 * 成与没成都记进行为账(`事:'主路'`),同一件只记一次(键见 {@link MainPathOutcome.key})。
 * 「这台机器三件事各成没成、第几天成的」= 行为账里这几条 {@link summarizeMainPaths}(`GET /first-use`)。
 *
 * ## 自检不进数
 *
 * 安装器末尾那一遍(早报一份、派一件、通话拉起来)是**我们**跑的,不是她用出来的:那张卡与那一遍早报
 * 记在 first-use.json 里,不进行为账,也不算进「第几天成的」。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  FIRST_USE_SAY,
  MAIN_PATHS,
  MAIN_PATH_LEDGER_NAMES,
  MAIN_PATH_TITLES,
  doorView,
  firstUseOrder,
  isMainPath,
  selfCheckLine,
  selfCheckSummary,
  type CallMode,
  type DoorView,
  type FirstUseDoor,
  type FirstUsePathState,
  type FirstUsePathView,
  type FirstUseView,
  type MainPath,
  type SelfCheckRow,
  type SelfCheckView,
} from '../mainPaths.ts'
import type { RoutineRun, TaskView } from '../protocol.ts'
import type { BehaviorEnd, BehaviorEntry, BehaviorLog } from './behaviorLog.ts'

/** 行为账里这一类的「事」。 */
export const MAIN_PATH_EVENT = '主路'

/** 协议路那两家(交代那一件只认它们)。 */
export const PROTOCOL_FAMILIES: readonly string[] = ['claude', 'codex']

/** 点了「试一下」之后多久算「在试」(过了还没结果就回到缺门 / 没试)。 */
export const FIRST_USE_TRYING_MS = 3 * 60_000

/** 落盘的那几笔最多留多少(行为账才是全量,这里只是给 /state 现算用的近况)。 */
const EVENTS_MAX = 300

export interface MainPathOutcome {
  /** 去重键:同一件事的成与没成各一个(`morning:<那一次开始的时刻>:ok`、`delegate:<卡>:fail`、`call:<卡>`)。 */
  key: string
  path: MainPath
  ok: boolean
  at: string
  door?: FirstUseDoor
  note?: string
  family?: string
}

export interface ObserveInput {
  morning?: RoutineRun
  /** 那一天的播客:有没有文件、没有的话那一句原因。 */
  podcast?: { date: string, file: boolean, error?: string }
  /** 播客开着没(`feed-config.json` 的 `podcast`)。关着就只看早报。 */
  podcastWanted: boolean
  tasks: readonly TaskView[]
}

/** 播客那一句原因 → 缺哪道门。 */
export function podcastDoor(error: string): FirstUseDoor {
  // 「没能写出今天的口播稿:fetch failed」= 写稿那一下连不上模型(2026-10-21 隔离实例真机),同缺模型那道门。
  if (/模型|口播稿/u.test(error)) return 'model'
  if (/语音/u.test(error)) return 'voice'
  if (/条目|资讯|搜索/u.test(error)) return 'news'
  return 'other'
}

function morningOutcomes(input: ObserveInput): MainPathOutcome[] {
  const run = input.morning
  if (run === undefined || run.status === 'skipped') return []
  const base = `morning:${run.started_at}`
  const at = run.finished_at ?? run.started_at
  if (run.status === 'failed') {
    return [{ key: `${base}:fail`, path: 'morning', ok: false, at, door: 'other', ...(run.note === undefined ? {} : { note: run.note }) }]
  }
  if (!input.podcastWanted) return [{ key: `${base}:ok`, path: 'morning', ok: true, at }]
  const podcast = input.podcast
  if (podcast === undefined || podcast.date !== run.date) return []
  if (podcast.file) return [{ key: `${base}:ok`, path: 'morning', ok: true, at }]
  if (podcast.error === undefined || podcast.error === '') return []
  return [{ key: `${base}:fail`, path: 'morning', ok: false, at, door: podcastDoor(podcast.error), note: podcast.error }]
}

function delegateOutcomes(task: TaskView): MainPathOutcome[] {
  const out: MainPathOutcome[] = []
  const cli = task.dispatch
  if (cli !== undefined && PROTOCOL_FAMILIES.includes(cli.family) && cli.stopped === undefined) {
    const answered = (cli.reply ?? '').trim() !== '' || (task.deliverables ?? []).length > 0
    if (cli.status === 'done' && answered) {
      out.push({ key: `delegate:${task.id}:ok`, path: 'delegate', ok: true, at: cli.ended_at ?? cli.started_at, family: cli.family })
    }
    else if (cli.status === 'failed') {
      out.push({
        key: `delegate:${task.id}:fail`, path: 'delegate', ok: false, at: cli.ended_at ?? cli.started_at, door: 'other', family: cli.family,
        ...(cli.note === undefined ? {} : { note: cli.note }),
      })
    }
  }
  const proto = task.client_dispatch
  if (proto !== undefined && PROTOCOL_FAMILIES.includes(proto.family)) {
    if ((proto.reply ?? '').trim() !== '') {
      out.push({ key: `delegate:${task.id}:ok`, path: 'delegate', ok: true, at: proto.reply_at ?? proto.at, family: proto.family })
    }
    else if (proto.status === 'failed') {
      out.push({
        key: `delegate:${task.id}:fail`, path: 'delegate', ok: false, at: proto.at, door: 'other', family: proto.family,
        ...(proto.reason === undefined ? {} : { note: proto.reason }),
      })
    }
  }
  const block = task.dispatch_block
  if (block !== undefined && block.unlock !== true && PROTOCOL_FAMILIES.includes(block.family)) {
    out.push({
      key: `delegate:${task.id}:fail`, path: 'delegate', ok: false, at: block.at,
      door: block.fix?.kind === 'login_cli' ? 'ai_login' : 'other', family: block.family, note: block.why,
    })
  }
  // 同一张卡两份记录都说了同一件(命令行与协议各记一笔):一个键只留第一笔。
  return out.filter((one, index) => out.findIndex(other => other.key === one.key) === index)
}

/** 现成记录里看得出来的每一笔(成 / 没成)。纯函数;去重由服务按键做。 */
export function observeOutcomes(input: ObserveInput): MainPathOutcome[] {
  return [...morningOutcomes(input), ...input.tasks.flatMap(delegateOutcomes)]
}

/** ——— 还没试就看得出来的那几道门 ——— */

export interface Readiness {
  /** 模型接上了没(`/model` 的 `ready`)。 */
  model: boolean
  /** 协议路那两家:装没装、登没登录(`unknown` = 查不出来,不许说成没登录)。整格缺席 = 这台没接派活能力表,一样不说缺。 */
  coders?: readonly { family: string, title: string, installed: boolean, login: 'yes' | 'no' | 'unknown' }[]
  /** 通话工人(`/channel/status` 的 `worker`)。 */
  worker: 'up' | 'down' | 'unknown'
  /** 语音后端(8792)在不在。查不出来缺席。 */
  voice?: boolean
}

export function readinessDoor(path: MainPath, readiness: Readiness, callMode: CallMode): DoorView | undefined {
  if (path === 'morning') {
    if (!readiness.model) return doorView('model')
    if (readiness.voice === false) return doorView('voice')
    return undefined
  }
  if (path === 'delegate') {
    if (readiness.coders === undefined) return undefined
    const installed = readiness.coders.filter(one => one.installed)
    if (installed.length === 0) return doorView('ai_missing')
    if (installed.some(one => one.login !== 'no')) return undefined
    return doorView('ai_login', { families: installed.map(one => ({ family: one.family, title: one.title })) })
  }
  if (callMode === 'desk') return undefined
  return readiness.worker === 'down' ? doorView('worker') : undefined
}

/** ——— 第几天成的 ——— */

export interface MainPathEvent {
  path: MainPath
  ok: boolean
  at: string
  door?: FirstUseDoor
}

export interface MainPathSummary {
  ok: boolean
  first_ok_at?: string
  ok_day?: number
  first_fail_at?: string
  last_door?: FirstUseDoor
  oks: number
  fails: number
}

/** 本机日期(`tzOffsetMinutes` 同 `Date#getTimezoneOffset`;缺省按这台机器)。 */
export function localDayOf(ms: number, tzOffsetMinutes: number = new Date(ms).getTimezoneOffset()): string {
  return new Date(ms - tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

function dayIndex(day0: string, at: string): number {
  const from = Date.parse(`${day0}T00:00:00Z`)
  const to = Date.parse(`${localDayOf(Date.parse(at))}T00:00:00Z`)
  return Math.round((to - from) / 86_400_000) + 1
}

export function summarizeMainPaths(events: readonly MainPathEvent[], day0: string): Record<MainPath, MainPathSummary> {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return Object.fromEntries(MAIN_PATHS.map((path) => {
    const mine = sorted.filter(one => one.path === path)
    const oks = mine.filter(one => one.ok)
    const fails = mine.filter(one => !one.ok)
    const firstOk = oks[0]
    const lastFail = fails[fails.length - 1]
    const summary: MainPathSummary = {
      ok: firstOk !== undefined,
      ...(firstOk === undefined ? {} : { first_ok_at: firstOk.at, ok_day: dayIndex(day0, firstOk.at) }),
      ...(fails[0] === undefined ? {} : { first_fail_at: fails[0].at }),
      ...(lastFail?.door === undefined ? {} : { last_door: lastFail.door }),
      oks: oks.length,
      fails: fails.length,
    }
    return [path, summary]
  })) as Record<MainPath, MainPathSummary>
}

const PATH_BY_NAME: Readonly<Record<string, MainPath>> = Object.fromEntries(MAIN_PATHS.map(path => [MAIN_PATH_LEDGER_NAMES[path], path]))
const DOORS: readonly FirstUseDoor[] = ['service', 'model', 'ai_missing', 'ai_login', 'phone', 'worker', 'voice', 'news', 'other']

/** 行为账里那几条 → 事件(认不出的跳过)。 */
export function ledgerEventsOf(entries: readonly BehaviorEntry[]): MainPathEvent[] {
  return entries.flatMap((entry): MainPathEvent[] => {
    if (entry.事 !== MAIN_PATH_EVENT) return []
    const path = PATH_BY_NAME[entry.对象]
    if (path === undefined) return []
    const door = DOORS.find(one => one === entry.类)
    return [{ path, ok: entry.结果 === '成', at: entry.at, ...(door === undefined ? {} : { door }) }]
  })
}

/** ——— 服务 ——— */

interface StoredEvent extends MainPathEvent {
  key: string
  note?: string
}

interface StoredSelfCheck {
  started_at: string
  ended_at?: string
  rows: SelfCheckRow[]
  /** 自检派出去的那张卡、那一遍早报开始的时刻:它们交回 / 出来时只更新自检那一行,不进行为账。 */
  task_id?: string
  morning_started_at?: string
}

interface FirstUseFile {
  version: 1
  day0: string
  prefer?: MainPath
  prefer_at?: string
  events: StoredEvent[]
  closed_at?: string
  trying?: Partial<Record<MainPath, string>>
  selfcheck?: StoredSelfCheck
}

export type SelfCheckMorning = { ok: true, startedAt?: string, note?: string } | { ok: false, door: FirstUseDoor, note?: string, startedAt?: string }
export type SelfCheckDelegate =
  | { started: true, taskId: string, family: string, title: string }
  | { started: false, door: FirstUseDoor, note?: string }
export type SelfCheckCall = { ok: true, note?: string } | { ok: false, door: FirstUseDoor, note?: string }

/** 自检那三样各怎么试(`http.ts` 接上真的;用例注入假的)。 */
export interface SelfCheckPorts {
  readiness: () => Promise<Readiness & { phonePaired: boolean }>
  morning: () => Promise<SelfCheckMorning>
  delegate: () => Promise<SelfCheckDelegate>
  call: () => Promise<SelfCheckCall>
}

export interface FirstUseViewInput {
  readiness: Readiness
  phonePaired: boolean
}

export interface FirstUseService {
  ready: () => Promise<void>
  setPrefer: (path: MainPath | undefined) => Promise<void>
  /** 看一眼现成记录,新出现的成 / 没成记进行为账。有新记的回 true(调用方据此广播一次)。 */
  observe: (input: ObserveInput) => Promise<boolean>
  /** 当场记一笔(电话那几条路)。键记过就不再记。 */
  record: (outcome: MainPathOutcome, end: BehaviorEnd) => Promise<boolean>
  /** 她点了「试一下」:这一件「在试」三分钟。 */
  trying: (path: MainPath) => Promise<void>
  view: (input: FirstUseViewInput) => FirstUseView
  /** 行为账里那几条的汇总(`GET /first-use` 用;行为账不在就用落盘的近况)。 */
  ledgerSummary: () => Promise<{ day0: string, paths: Record<MainPath, MainPathSummary>, source: 'ledger' | 'file' }>
  /**
   * 下一通电话人设里那一段:**只在她刚在第一次有用那一屏点了「我这就拨」之后**({@link FIRST_CALL_WINDOW_MS} 之内),
   * 且电话那一件还没成过。老用户平常打电话不会被「先介绍自己」打扰。
   */
  callBlock: () => string | undefined
  selfcheck: {
    run: (ports: SelfCheckPorts) => Promise<SelfCheckView>
    view: () => SelfCheckView | undefined
    running: () => boolean
  }
}

export interface FirstUseServiceOptions {
  file: string
  behaviorLog?: BehaviorLog
  now?: () => number
  log?: (line: string) => void
}

/** 她点了「我这就拨」之后多久之内打进来的那一通算引导里那一通。 */
export const FIRST_CALL_WINDOW_MS = 15 * 60_000

/** 电话那一件还没成过时,下一通电话人设里多的那一段。 */
export const FIRST_CALL_SECTION = '她第一次给你打电话'

function parseFile(raw: unknown, fallbackDay: string): FirstUseFile {
  const obj = (raw ?? {}) as Partial<FirstUseFile>
  const events = Array.isArray(obj.events)
    ? obj.events.filter((one): one is StoredEvent => typeof one === 'object' && one !== null && typeof one.key === 'string' && isMainPath(one.path) && typeof one.at === 'string')
    : []
  return {
    version: 1,
    day0: typeof obj.day0 === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.day0) ? obj.day0 : fallbackDay,
    ...(isMainPath(obj.prefer) ? { prefer: obj.prefer } : {}),
    ...(typeof obj.prefer_at === 'string' ? { prefer_at: obj.prefer_at } : {}),
    events,
    ...(typeof obj.closed_at === 'string' ? { closed_at: obj.closed_at } : {}),
    ...(obj.trying !== undefined && typeof obj.trying === 'object' ? { trying: obj.trying } : {}),
    ...(obj.selfcheck !== undefined && typeof obj.selfcheck === 'object' && Array.isArray(obj.selfcheck.rows) ? { selfcheck: obj.selfcheck } : {}),
  }
}

function selfCheckViewOf(stored: StoredSelfCheck): SelfCheckView {
  return {
    started_at: stored.started_at,
    ...(stored.ended_at === undefined ? {} : { ended_at: stored.ended_at }),
    rows: stored.rows,
    lines: stored.rows.map(selfCheckLine),
    summary: selfCheckSummary(stored.rows),
  }
}

export function createFirstUseService(options: FirstUseServiceOptions): FirstUseService {
  const now = options.now ?? (() => Date.now())
  const warn = options.log ?? ((line: string) => console.warn(line))
  let data: FirstUseFile = { version: 1, day0: localDayOf(now()), events: [] }
  let loaded: Promise<void> | undefined
  let chain: Promise<void> = Promise.resolve()
  let checking = false

  async function save(): Promise<void> {
    const snapshot = JSON.stringify(data, null, 2)
    chain = chain.then(async () => {
      await mkdir(dirname(options.file), { recursive: true })
      const tmp = `${options.file}.tmp-${process.pid}`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, options.file)
    }).catch((error: unknown) => {
      warn(`[workbench] first-use.json 写不进去:${error instanceof Error ? error.message : String(error)}`)
    })
    await chain
  }

  function ready(): Promise<void> {
    loaded ??= (async () => {
      let raw: string | undefined
      try { raw = await readFile(options.file, 'utf8') }
      catch { raw = undefined }
      if (raw === undefined) {
        // 第一次起来(装好 / 这一版第一次跑)那天就是第 1 天。
        await save()
        return
      }
      try { data = parseFile(JSON.parse(raw), localDayOf(now())) }
      catch { data = { version: 1, day0: localDayOf(now()), events: [] } }
    })()
    return loaded
  }

  function okPaths(): Set<MainPath> {
    return new Set(data.events.filter(one => one.ok).map(one => one.path))
  }

  function ledger(outcome: MainPathOutcome, end: BehaviorEnd): void {
    if (options.behaviorLog === undefined) return
    options.behaviorLog.record({
      端: end,
      事: MAIN_PATH_EVENT,
      对象: MAIN_PATH_LEDGER_NAMES[outcome.path],
      结果: outcome.ok ? '成' : `没成:${doorView(outcome.door ?? 'other', outcome.note === undefined ? {} : { note: outcome.note }).title}`,
      ...(outcome.ok || outcome.door === undefined ? {} : { 类: outcome.door }),
    })
  }

  /** 记一笔(不落盘;调用方最后落一次)。 */
  function add(outcome: MainPathOutcome, end: BehaviorEnd): boolean {
    if (data.events.some(one => one.key === outcome.key)) return false
    data.events.push({
      key: outcome.key, path: outcome.path, ok: outcome.ok, at: outcome.at,
      ...(outcome.door === undefined ? {} : { door: outcome.door }),
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
    })
    if (data.events.length > EVENTS_MAX) data.events = data.events.slice(-EVENTS_MAX)
    ledger(outcome, end)
    if (data.trying?.[outcome.path] !== undefined) {
      const { [outcome.path]: _done, ...rest } = data.trying
      data.trying = rest
    }
    if (data.closed_at === undefined && MAIN_PATHS.every(path => okPaths().has(path))) data.closed_at = new Date(now()).toISOString()
    return true
  }

  function selfRow(path: MainPath, row: SelfCheckRow): void {
    const stored = data.selfcheck
    if (stored === undefined) return
    stored.rows = stored.rows.map(one => (one.path === path ? row : one))
    if (stored.ended_at === undefined && stored.rows.every(one => one.state !== 'running')) stored.ended_at = new Date(now()).toISOString()
  }

  function familiesToLogin(readiness: Readiness | undefined): { family: string, title: string }[] {
    return (readiness?.coders ?? []).filter(one => one.installed && one.login !== 'yes').map(one => ({ family: one.family, title: one.title }))
  }

  return {
    ready,

    async setPrefer(path) {
      await ready()
      // 说「都行」也记下答过的时刻(不再问第二遍),只是不选哪一件。
      const { prefer: _old, ...rest } = data
      data = { ...rest, ...(path === undefined ? {} : { prefer: path }), prefer_at: new Date(now()).toISOString() }
      await save()
    },

    async observe(input) {
      await ready()
      const self = data.selfcheck
      let changed = false
      for (const outcome of observeOutcomes(input)) {
        // 自检那张卡 / 那一遍早报:只更新自检那一行。
        if (self !== undefined && outcome.path === 'delegate' && self.task_id !== undefined && outcome.key.startsWith(`delegate:${self.task_id}:`)) {
          const row = self.rows.find(one => one.path === 'delegate')
          if (row?.state === 'pending') {
            selfRow('delegate', outcome.ok
              ? { path: 'delegate', state: 'ok', ...(outcome.family === undefined ? {} : { note: `${outcome.family === 'claude' ? 'Claude' : 'Codex'} 交回了` }) }
              : { path: 'delegate', state: 'missing', door: doorView(outcome.door ?? 'other', outcome.note === undefined ? {} : { note: outcome.note }) })
            changed = true
          }
          continue
        }
        if (self?.morning_started_at !== undefined && outcome.key.startsWith(`morning:${self.morning_started_at}:`)) continue
        if (add(outcome, '电脑')) changed = true
      }
      if (changed) await save()
      return changed
    },

    async record(outcome, end) {
      await ready()
      const added = add(outcome, end)
      if (added) await save()
      return added
    },

    async trying(path) {
      await ready()
      data.trying = { ...data.trying, [path]: new Date(now()).toISOString() }
      await save()
    },

    view(input) {
      const callMode: CallMode = input.phonePaired ? 'phone' : 'desk'
      const prefer = data.prefer
      const summary = summarizeMainPaths(data.events, data.day0)
      const paths = firstUseOrder(prefer).map((path): FirstUsePathView => {
        const mine = summary[path]
        const lastFail = [...data.events].reverse().find(one => one.path === path && !one.ok)
        const triedAt = data.trying?.[path]
        const trying = triedAt !== undefined && now() - Date.parse(triedAt) < FIRST_USE_TRYING_MS
        const readinessDoorNow = readinessDoor(path, input.readiness, callMode)
        const failDoor = lastFail === undefined
          ? undefined
          : doorView(lastFail.door ?? 'other', {
              ...(lastFail.note === undefined ? {} : { note: lastFail.note }),
              families: familiesToLogin(input.readiness),
            })
        const door = readinessDoorNow ?? failDoor
        const state: FirstUsePathState = mine.ok ? 'ok' : trying ? 'trying' : door !== undefined ? 'missing' : 'todo'
        return {
          path,
          title: MAIN_PATH_TITLES[path],
          state,
          say: path === 'call' && callMode === 'desk' ? FIRST_USE_SAY.call_desk : FIRST_USE_SAY[path],
          ...(mine.ok || door === undefined ? {} : { door }),
          ...(mine.first_ok_at === undefined ? {} : { first_ok_at: mine.first_ok_at }),
          ...(mine.ok_day === undefined ? {} : { ok_day: mine.ok_day }),
          ...(mine.first_fail_at === undefined ? {} : { first_fail_at: mine.first_fail_at }),
          oks: mine.oks,
          fails: mine.fails,
        }
      })
      return {
        ...(prefer === undefined ? {} : { prefer }),
        ...(data.prefer_at === undefined ? {} : { asked_at: data.prefer_at }),
        order: firstUseOrder(prefer),
        call_mode: callMode,
        paths,
        ...(data.closed_at === undefined ? {} : { closed_at: data.closed_at }),
        day0: data.day0,
        ...(data.selfcheck === undefined ? {} : { selfcheck: selfCheckViewOf(data.selfcheck) }),
      }
    },

    async ledgerSummary() {
      await ready()
      if (options.behaviorLog === undefined) return { day0: data.day0, paths: summarizeMainPaths(data.events, data.day0), source: 'file' }
      await options.behaviorLog.flush()
      const entries = await options.behaviorLog.read({ 事: MAIN_PATH_EVENT })
      return { day0: data.day0, paths: summarizeMainPaths(ledgerEventsOf(entries), data.day0), source: 'ledger' }
    },

    callBlock() {
      if (okPaths().has('call')) return undefined
      const triedAt = data.trying?.call
      if (triedAt === undefined || now() - Date.parse(triedAt) > FIRST_CALL_WINDOW_MS) return undefined
      return [
        '',
        `【${FIRST_CALL_SECTION}】`,
        '- 这是她装好之后第一次跟你通电话(引导里三件事的第三件)。',
        '- 她一开口,先用两三句介绍你能做什么:每天早上的早报和播客、把一件事交给 Claude / Codex 去办、电话里说一句就记成事项或捎话给在办的那一家。',
        '- 介绍完问一句「有什么要我盯的?」。她说了就用记一笔那件工具记成一张事项,记下了说一声就收,别再追问。',
      ].join('\n')
    },

    selfcheck: {
      running: () => checking,
      view: () => (data.selfcheck === undefined ? undefined : selfCheckViewOf(data.selfcheck)),
      async run(ports) {
        await ready()
        checking = true
        data.selfcheck = {
          started_at: new Date(now()).toISOString(),
          rows: MAIN_PATHS.map(path => ({ path, state: 'running' as const })),
        }
        await save()
        let readiness: (Readiness & { phonePaired: boolean }) | undefined
        try { readiness = await ports.readiness() }
        catch { readiness = undefined }
        const missing = (door: FirstUseDoor, note?: string): DoorView =>
          doorView(door, { ...(note === undefined ? {} : { note }), families: familiesToLogin(readiness) })
        const failed = (error: unknown): string => (error instanceof Error ? error.message : String(error))
        try {
          await Promise.all([
            ports.morning().then((result) => {
              if (data.selfcheck !== undefined && result.startedAt !== undefined) data.selfcheck.morning_started_at = result.startedAt
              selfRow('morning', result.ok
                ? { path: 'morning', state: 'ok', ...(result.note === undefined ? {} : { note: result.note }) }
                : { path: 'morning', state: 'missing', door: missing(result.door, result.note) })
            }, (error: unknown) => selfRow('morning', { path: 'morning', state: 'missing', door: missing('other', failed(error)) })),
            ports.delegate().then((result) => {
              if (result.started) {
                if (data.selfcheck !== undefined) data.selfcheck.task_id = result.taskId
                // 卡可能在这之前就交回了(很快的那一家):那一笔留给下一次 observe 来改成「成」。
                selfRow('delegate', { path: 'delegate', state: 'pending', note: `派给 ${result.title} 了` })
              }
              else {
                selfRow('delegate', { path: 'delegate', state: 'missing', door: missing(result.door, result.note) })
              }
            }, (error: unknown) => selfRow('delegate', { path: 'delegate', state: 'missing', door: missing('other', failed(error)) })),
            ports.call().then((result) => {
              selfRow('call', result.ok
                ? { path: 'call', state: 'ok', ...(result.note === undefined ? {} : { note: result.note }) }
                : { path: 'call', state: 'missing', door: missing(result.door, result.note) })
            }, (error: unknown) => selfRow('call', { path: 'call', state: 'missing', door: missing('other', failed(error)) })),
          ])
        }
        finally {
          checking = false
          await save()
        }
        return selfCheckViewOf(data.selfcheck)
      },
    },
  }
}

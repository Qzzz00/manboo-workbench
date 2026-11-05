/**
 * **一条路线一条工人**(2026-10-22,局域网主路 M6;docs/设计-局域网主路-2026-10-21.md 第三、七节)。
 *
 * 本机房间(M1 随包的 livekit-server,或探针起的那台)一条,登录且中转配了云房间时再一条:在家的听筒与手机进本机房间,
 * 出门的手机进云房间,两间房都得有人接。先用两个进程 —— 每条各是一个 {@link createChannelWorkerService},
 * 各自退避重启、各自日志、各自进程号文件;进程环境里报自己是哪条路线({@link CHANNEL_WORKER_ROUTE_ENV}),
 * 工人取票时点名那一条(8791 只给回环点名)。
 *
 * **两间房里都叫 `wb-channel-worker`,不带后缀**:手机(`butler-app/src/channel/channelProtocol.ts`)与听筒
 * (`phone-bridge/room_link.py`)只认这个名字的回话,工人也只有不带后缀的那个才长嘴、才替设备办事(`agent.ts` 的
 * `primaryWorker` / `voiceHere`)。房间不同,同名不撞;`WORKBENCH_CHANNEL_WORKER_SUFFIX` 仍只留给「第二台电脑进同一间房」。
 *
 * 这一层只管「哪条该有、该有的在不在」:30 秒一拍问 {@link ChannelWorkerFleetDeps.routes}(`channel.workerRoutes()`),
 * 该有的起、没了的停、房间换了的那条重起;**崩了重起归那条自己的看护**(退避 / 上限 / 冷却一样不改),这一拍不插手。
 * 他点了「停」就两条都停,拍子不再拉起,直到他点「起」。
 */
import type { ChannelRoute, ChannelWorkerRouteWant, ChannelWorkerRoutes } from './channel.ts'
import { CHANNEL_ROUTES } from './channel.ts'
import type {
  ChannelWorkerActionResult,
  ChannelWorkerRouteView,
  ChannelWorkerService,
  ChannelWorkerServiceDeps,
  ChannelWorkerView,
} from './channelWorker.ts'
import { createChannelWorkerService, defaultChannelWorkerLogFile } from './channelWorker.ts'
import type { ChannelWorkerReaper } from './channelWorkerReap.ts'
import { defaultChannelWorkerPidFile } from './channelWorkerReap.ts'

/** 工人进程环境里报「我是哪条路线」的那一格(`channel-worker/src/main.ts` 读同一个名字,有对照用例)。 */
export const CHANNEL_WORKER_ROUTE_ENV = 'WORKBENCH_CHANNEL_WORKER_ROUTE'

/** 日志与人话里怎么叫这两条。 */
export const CHANNEL_ROUTE_LABELS: Record<ChannelRoute, string> = { lan: '本机房间', relay: '云房间' }

type CrashEvent = Parameters<NonNullable<ChannelWorkerServiceDeps['onCrash']>>[0]

/**
 * 起一条路线的看护:在老那一份配置上加三样 —— 进程环境报路线、日志与进程号文件按路线分开。
 * `overrides` 只给用例换掉真 spawn / 真文件。
 */
export function channelWorkerForRoute(
  route: ChannelRoute,
  base: {
    env: Record<string, string>
    home?: string
    /** 算 `~/.dsh` 在哪(`DSH_HOME` / `HOME`)。缺省 process.env。 */
    dshEnv?: Record<string, string | undefined>
    reaperFor?: (pidFile: string) => Pick<ChannelWorkerReaper, 'reap' | 'record'>
    onCrash?: (event: CrashEvent & { route: ChannelRoute }) => void
    log?: (line: string) => void
  },
  overrides: Partial<ChannelWorkerServiceDeps> = {},
): ChannelWorkerService {
  const pidFile = defaultChannelWorkerPidFile(base.dshEnv ?? process.env, route)
  const reaper = base.reaperFor?.(pidFile)
  const onCrash = base.onCrash
  return createChannelWorkerService({
    env: { ...base.env, [CHANNEL_WORKER_ROUTE_ENV]: route },
    logFile: defaultChannelWorkerLogFile(base.home, route),
    ...(base.log === undefined ? {} : { log: base.log }),
    ...(reaper === undefined ? {} : { reaper }),
    ...(onCrash === undefined ? {} : { onCrash: (event: CrashEvent) => onCrash({ ...event, route }) }),
    ...overrides,
  })
}

export interface ChannelWorkerFleet extends ChannelWorkerService {
  view: () => ChannelWorkerView & { routes: readonly ChannelWorkerRouteView[] }
  /**
   * 按此刻的路线对一遍:该有的起、没了的停、房间换了的那条重起。他点过「停」就只记路线、不起。
   * 回这一拍问到的路线(问不到 = 上一份)。并发的几拍排着队对,不起两个。
   */
  reconcile: (options?: { force?: boolean }) => Promise<ChannelWorkerRoutes | undefined>
}

export interface ChannelWorkerFleetDeps {
  /** 此刻哪几条路线要工人(`channel.workerRoutes()`)。 */
  routes: (options?: { force?: boolean }) => Promise<ChannelWorkerRoutes>
  /** 造一条路线的看护(`channelWorkerForRoute`)。第一次要那条路线时才造,造了就留着(重起、上一次退出都记在它身上)。 */
  make: (route: ChannelRoute) => ChannelWorkerService
  log?: (line: string) => void
}

function keyOf(want: { url: string, room: string }): string {
  return `${want.url} ${want.room}`
}

export function createChannelWorkerFleet(deps: ChannelWorkerFleetDeps): ChannelWorkerFleet {
  const log = deps.log ?? (() => {})
  const services = new Map<ChannelRoute, ChannelWorkerService>()
  /** 每条起的时候进的哪一间(地址 + 房间)。路线报的换了,那条重起。 */
  const startedFor = new Map<ChannelRoute, { url: string, room: string }>()
  let routes: ChannelWorkerRoutes | undefined
  /** 他点了「停」。拍子照对路线,但不起。 */
  let paused = false
  let disposed = false
  let queue: Promise<unknown> = Promise.resolve()

  function serviceOf(route: ChannelRoute): ChannelWorkerService {
    let one = services.get(route)
    if (one === undefined) {
      one = deps.make(route)
      services.set(route, one)
    }
    return one
  }

  async function startRoute(route: ChannelRoute, want: { url: string, room: string }): Promise<ChannelWorkerActionResult> {
    const one = serviceOf(route)
    const before = startedFor.get(route)
    if (one.view().running && before !== undefined && keyOf(before) !== keyOf(want)) {
      log(`[channel] ${CHANNEL_ROUTE_LABELS[route]}换了一间(${want.room}),那条工人重起`)
      await one.stop()
    }
    startedFor.set(route, { url: want.url, room: want.room })
    return one.start()
  }

  async function reconcileOnce(options?: { force?: boolean }): Promise<ChannelWorkerRoutes | undefined> {
    if (disposed) return routes
    let next: ChannelWorkerRoutes
    try { next = await deps.routes(options) }
    catch { return routes }
    if (disposed) return routes
    routes = next
    for (const route of CHANNEL_ROUTES) {
      const want = next[route]
      const one = services.get(route)
      if (want.want === 'keep') continue
      if (want.want === false) {
        const view = one?.view()
        if (one !== undefined && view !== undefined && (view.running || view.supervising || view.retry_at !== undefined)) {
          log(`[channel] ${CHANNEL_ROUTE_LABELS[route]}没了(${want.note}),停掉那条工人`)
          await one.stop()
        }
        continue
      }
      if (paused) continue
      const view = one?.view()
      // 崩了正在退避里、或撞了上限在冷却里:那条自己的看护会处理,这一拍不插手(不然退避等于没有)。
      if (view !== undefined && !view.running && (view.supervising || view.retry_at !== undefined)) continue
      const before = startedFor.get(route)
      if (view?.running === true && before !== undefined && keyOf(before) === keyOf(want)) continue
      const result = await startRoute(route, want)
      if (!result.ok) log(`[channel] ${CHANNEL_ROUTE_LABELS[route]}那条工人没拉起来:${result.error ?? '没说原因'}`)
    }
    return next
  }

  function reconcile(options?: { force?: boolean }): Promise<ChannelWorkerRoutes | undefined> {
    const run = queue.then(() => reconcileOnce(options))
    queue = run.catch(() => undefined)
    return run
  }

  /** 要的那几条(说不准的那条照旧算,只要它的看护在);路线没了、已经停下的那条不再列。 */
  function routeViews(): ChannelWorkerRouteView[] {
    return CHANNEL_ROUTES.flatMap((route) => {
      const one = services.get(route)
      const want = routes?.[route]
      const listed = want?.want === true || (one !== undefined && (want?.want === 'keep' || one.view().running))
      if (!listed) return []
      const { routes: _nested, ...own } = one?.view() ?? { running: false, supervising: false, restarts: 0, script: '', log_file: '' }
      const room = want?.want === true ? want.room : startedFor.get(route)?.room
      return [{ route, ...own, ...(room === undefined ? {} : { room }) }]
    })
  }

  function wantedRoutes(): ChannelRoute[] {
    return CHANNEL_ROUTES.filter(route => routes?.[route].want === true)
  }

  /** 一条路线都没有时那句话:两条各自为什么没有。 */
  function noRouteNote(): string {
    const known = routes
    if (known === undefined) return '还没问到这台该进哪间房'
    return CHANNEL_ROUTES.map((route) => {
      const want: ChannelWorkerRouteWant = known[route]
      return `${CHANNEL_ROUTE_LABELS[route]}:${want.want === true ? '有' : want.note}`
    }).join(';')
  }

  function joinResults(pairs: readonly [ChannelRoute, ChannelWorkerActionResult][]): ChannelWorkerActionResult {
    const failed = pairs.filter(([, result]) => !result.ok)
    const notes = pairs.flatMap(([route, result]) => (result.note === undefined ? [] : [`${CHANNEL_ROUTE_LABELS[route]}:${result.note}`]))
    if (failed.length > 0) {
      return { ok: false, error: failed.map(([route, result]) => `${CHANNEL_ROUTE_LABELS[route]}:${result.error ?? '没说原因'}`).join(';'), ...(notes.length === 0 ? {} : { note: notes.join(';') }) }
    }
    return notes.length === 0 ? { ok: true } : { ok: true, note: notes.join(';') }
  }

  return {
    reconcile,

    view() {
      const views = routeViews()
      const wanted = wantedRoutes()
      const wantedViews = views.filter(one => wanted.includes(one.route))
      // 老字段照旧给得出(体检页、诊断包、firstUse 读它们):取本机那条(局域网是主路),没有就取云房间那条。
      const primary = views[0]
      const notes = views.flatMap(one => (one.note === undefined ? [] : [`${CHANNEL_ROUTE_LABELS[one.route]}:${one.note}`]))
      return {
        running: wantedViews.length > 0 && wantedViews.every(one => one.running),
        ...(primary?.pid === undefined ? {} : { pid: primary.pid }),
        supervising: views.some(one => one.supervising),
        restarts: views.reduce((most, one) => Math.max(most, one.restarts), 0),
        ...(views.find(one => one.retry_at !== undefined)?.retry_at === undefined ? {} : { retry_at: views.find(one => one.retry_at !== undefined)?.retry_at as string }),
        script: primary?.script ?? '',
        log_file: primary?.log_file ?? '',
        ...(primary?.started_at === undefined ? {} : { started_at: primary.started_at }),
        ...(primary?.last_exit === undefined ? {} : { last_exit: primary.last_exit }),
        ...(notes.length === 0 ? (wanted.length === 0 && routes !== undefined ? { note: noRouteNote() } : {}) : { note: notes.join(';') }),
        routes: views,
      }
    },

    async start() {
      if (disposed) return { ok: false, error: '工作台正在退出,这会儿不起工人' }
      paused = false
      // 他点「起」(或刚登录完):当场重问路线,不认记着的「还没登录」。
      await reconcile({ force: true })
      const wanted = wantedRoutes()
      if (wanted.length === 0) return { ok: false, error: noRouteNote() }
      // 冷却里的那条也从头来 —— 他点一下得有反应(同单条看护的 start)。
      const pairs: [ChannelRoute, ChannelWorkerActionResult][] = []
      for (const route of wanted) {
        const want = routes?.[route]
        if (want?.want !== true) continue
        pairs.push([route, await startRoute(route, want)])
      }
      // 拍子刚起过的那几条回「本来就在跑」,不算一句要他看的话。
      return pairs.every(([, result]) => result.ok) ? { ok: true } : joinResults(pairs)
    },

    async stop() {
      paused = true
      if (services.size === 0) return { ok: true, note: '本来就没在跑' }
      const pairs: [ChannelRoute, ChannelWorkerActionResult][] = []
      for (const route of CHANNEL_ROUTES) {
        const one = services.get(route)
        if (one !== undefined) pairs.push([route, await one.stop()])
      }
      return joinResults(pairs)
    },

    async dispose() {
      disposed = true
      for (const route of CHANNEL_ROUTES) await services.get(route)?.dispose()
    },
  }
}

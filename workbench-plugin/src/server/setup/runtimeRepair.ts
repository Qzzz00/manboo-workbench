/**
 * 「运行环境还没换到这一版」这件事,从发现到补上(2026-09-26,卡 U6)。
 *
 * ## 这个文件是为哪一幕写的
 *
 * 09-26 生产切换那天,这台 Mac 从 0.3.6 点「更新」到 0.4.0。执行那趟热更新的是**旧的
 * 0.3.6 客户端**,它的步骤表里没有 `runtime` —— 于是插件换成了 0.4.0,而底下那套 DSH
 * 运行环境一个字没换(还是 0.1.2-rc.1,这一版要 0.1.7-rc.2)。换上新插件之后再点
 * 「检查更新」,那条路只比插件版本号 → 没有新版 → **运行环境从此再也装不上**。
 * 那天是统筹手工 `POST /setup/install {step:"runtime"}`、`profile`、`restart` 三条命令补上的。
 *
 * 这个服务就是把那三条命令变成机器自己会做的事:
 *
 * 1. **探**(`pump`)—— `/state` 每拍调一次,内部限频。判据不在这里写,读
 *    `dshRuntimeLock.ts` 的 `readRuntimeDrift`(体检那一项读的是同一个函数)。
 * 2. **亮**(`view`)—— `/state.update.runtime_stale`:设置里「更新」那一格显示
 *    「DSH 运行环境还没换到这一版:[装运行环境]」,事务官也看得见。
 * 3. **说**(`notify`)—— 发现的那一刻弹一条系统通知(每台机器每个锁定版本只弹一次)。
 * 4. **补**(自动跑一次 `profile` → `runtime` → `restart`)。
 *
 * ## 为什么选「自动补」而不是「只亮个按钮」
 *
 * 卡上把这一条留给实现者定。选自动,三条理由:
 *
 * - **他根本不知道要点什么**。那天的现象是「检查更新」说没有新版 —— 一个不懂代码的人
 *   看到的是"我已经是最新的了",不会去翻体检页。现在「检查更新」那条路修好了、
 *   设置里也亮出来了,但要等他哪天打开设置;而运行环境不对的那段时间里,
 *   跑着的是"新插件 + 旧 DSH"这种没人验过的组合。
 * - **这件事的形状正适合自动做**:装运行环境是**照锁定清单 npm ci**,装在
 *   `runtime-next` 里、核过版本才换名(见 install.ts 的 `runtime`),装失败旧那份一个字节没动。
 *   它没有"装坏了回不来"这一档。
 * - **代价是一次重启**,而这一趟多半就发生在开机后不久(旧客户端那趟热更新刚重启过一次,
 *   新进程一起来就探到漂移),那会儿手上没有正在跑的会话。
 *
 * 换来的风险是**循环**:补完要重启,重启之后新进程再探一次 —— 要是其实没补上,
 * 就会转起来。所以有一份账(`paths.runtimeRepairJson`):同一个锁定版本**自动最多试两次**,
 * 用完只亮按钮、不再自己动手,并且把"为什么停了"说成人话。他自己按那颗按钮不受这条限制
 * (那是他的决定,不是我们的循环)。
 *
 * ## 三条纪律
 *
 * - **失败就停在这里并说人话**,绝不自动重试第二遍;`tail` 原样留着(那是唯一能照着查的东西)。
 * - **重启排在最后**,而且发出去之前先把作业状态落成「装好了,正在重启」——
 *   那一下会把跑着这个服务的进程杀掉,后面排任何一步都没有意义(同 update/apply.ts)。
 * - **探不出来一律当没漂**。读盘报错、清单坏了(锁不出版本号)都不算发现问题 ——
 *   「没查出来」不能变成一件会去改这台机器的事。
 */
import { readRuntimeDrift, type RuntimeDriftState } from './dshRuntimeLock.ts'
import type { SetupIo } from './io.ts'
import type { SetupPaths } from './paths.ts'
import { tailLines } from './io.ts'
import type { SetupInstallStep, SetupJobView } from './types.ts'
import type { UpdateRuntimeStaleView } from '../update/types.ts'

/** 探一次运行时目录的最小间隔。它只是读十来个小 package.json,一分钟一次绰绰有余(同体检)。 */
export const RUNTIME_DRIFT_PROBE_MS = 60_000

/** 同一个锁定版本自动补几次就不再自动了。2 = 「试一次、重启后再试一次」。 */
export const RUNTIME_REPAIR_MAX_ATTEMPTS = 2

/** 补运行环境跑哪几步,按这个顺序。`restart` 那一步会把这个进程杀掉,所以它一定在最后。 */
export const RUNTIME_REPAIR_STEPS: readonly SetupInstallStep[] = ['profile', 'runtime', 'restart']

/** 界面上那颗按钮写什么。壳与手机都原样显示,不各写一份。 */
export const RUNTIME_REPAIR_LABEL = '装运行环境'

/** 系统通知那一条的 key(同一台机器上只占一格:再探到还是这一条,不会攒成一串)。 */
export const RUNTIME_DRIFT_NOTICE_KEY = 'runtime_drift'

/** 这台机器上自动补运行环境的账。**只为防循环**,不是日志。 */
export interface RuntimeRepairLedger {
  /** 这份账算的是哪一个锁定版本。锁定版本一换,账从头开始(那是另一件事了)。 */
  locked: string
  /** 自动试过几次。 */
  attempts: number
  /** 上一次自动试是什么时候(ISO)。 */
  last_at?: string
  /** 上一次为什么没成(人话)。成了就没有它。 */
  last_error?: string
}

export interface RuntimeRepairDeps {
  io: SetupIo
  paths: SetupPaths
  now: () => number
  newId: () => string
  /** 起一步一键装(生产上就是 `setup.install`)。 */
  install: (step: SetupInstallStep) => SetupJobView
  /** 等那一步跑完(`setup.waitJob`)。 */
  waitJob: (id: string) => Promise<void>
  /** 弹一条系统通知。交不到壳手上就当没弹 —— 不重试、不报错(同 notifyNewAsks)。 */
  notify?: (notice: { key: string, title: string, body: string }) => void
  /** 探一次的最小间隔。测试传 0 = 每拍都探。 */
  probeMs?: number
  /** 自动补最多试几次。测试传 0 = 一次都不自动补(只亮按钮)。 */
  maxAttempts?: number
  /**
   * 这一份实例许不许**自己动手**(缺省许)。false = 只探、只亮那一格、只弹通知,
   * 他自己按那颗按钮照样能补。
   *
   * **灰度实例必须传 false**(2026-09-26):补的最后一步是
   * `launchctl kickstart gui/<uid>/<固定 label>` —— 那个 label 不跟 HOME 走,
   * 一个跑在 scratch HOME 上的灰度实例自动补起来会把**生产那个 DSH** 重启掉。
   */
  autoRepair?: boolean
  /** 子步骤跑着的时候多久把它那句人话抄过来一次。测试传 0 = 不起定时器。 */
  subPollMs?: number
}

export interface RuntimeRepairService {
  /** 上一次探到的结论。**没探过就 undefined**(不编一个「没漂」)。 */
  drift: () => RuntimeDriftState | undefined
  /** 现探一次(「检查更新」那条路与用例用)。 */
  refresh: () => Promise<RuntimeDriftState | undefined>
  /** `/state.update.runtime_stale`。读上一次探到的结论,不现探。 */
  view: () => UpdateRuntimeStaleView | undefined
  /** `/state` 每拍调一次:限频地探,第一次探到漂移时弹通知并(按账)自动补一趟。 */
  pump: () => void
  /** 界面上那颗「装运行环境」。已经在跑就把那条作业回给你。 */
  start: () => SetupJobView | { error: string }
  job: (id: string) => SetupJobView | undefined
  /** 等那一趟补跑完。生产用不到,测试与收尾用。 */
  waitJob: (id: string) => Promise<void>
}

export function createRuntimeRepair(deps: RuntimeRepairDeps): RuntimeRepairService {
  const probeMs = deps.probeMs ?? RUNTIME_DRIFT_PROBE_MS
  const maxAttempts = deps.maxAttempts ?? RUNTIME_REPAIR_MAX_ATTEMPTS
  const subPollMs = deps.subPollMs ?? 500

  let last: RuntimeDriftState | undefined
  let probedAt: number | undefined
  let probing = false
  /** 这个进程里已经为这一次漂移弹过通知了(重复弹只是烦人)。 */
  let noticed = false
  /** 这个进程里自动补过了(不管成没成)。跨进程那一道在账上,见 ledger。 */
  let autoTried = false
  /** 自动补为什么停了(账用完 / 上一趟失败)。有它的时候界面上只亮按钮。 */
  let stopped: { says: string, attempts: number } | undefined
  const runs = new Map<string, { view: SetupJobView, done: Promise<void> }>()
  let current: { view: SetupJobView, done: Promise<void> } | undefined

  /* ───────────────────────────── 账(防循环) ───────────────────────────── */

  async function readLedger(locked: string): Promise<RuntimeRepairLedger> {
    const text = await deps.io.readFile(deps.paths.runtimeRepairJson)
    if (text === undefined) return { locked, attempts: 0 }
    let raw: unknown
    try { raw = JSON.parse(text) }
    catch { return { locked, attempts: 0 } }
    if (typeof raw !== 'object' || raw === null) return { locked, attempts: 0 }
    const row = raw as Record<string, unknown>
    // **锁定版本换了就从头算**:上一版试过两次不该拖累下一版(那是另一件要装的东西)。
    if (typeof row.locked !== 'string' || row.locked !== locked) return { locked, attempts: 0 }
    const attempts = typeof row.attempts === 'number' && Number.isFinite(row.attempts) && row.attempts > 0
      ? Math.floor(row.attempts)
      : 0
    return {
      locked,
      attempts,
      ...(typeof row.last_at === 'string' && row.last_at !== '' ? { last_at: row.last_at } : {}),
      ...(typeof row.last_error === 'string' && row.last_error !== '' ? { last_error: row.last_error } : {}),
    }
  }

  /** 写账。**写不进去就算了**:它只是一道保险,不能因为写不成把补运行环境这件事卡住。 */
  async function writeLedger(ledger: RuntimeRepairLedger): Promise<void> {
    try {
      await deps.io.mkdirp(dirOf(deps.paths.runtimeRepairJson))
      await deps.io.writeFile(deps.paths.runtimeRepairJson, `${JSON.stringify(ledger, null, 2)}\n`)
    }
    catch { /* 账写不进去照样往下走 */ }
  }

  /* ───────────────────────────── 探 ───────────────────────────── */

  async function probe(): Promise<RuntimeDriftState | undefined> {
    try {
      const state = await readRuntimeDrift(deps.io, deps.paths.runtimeDir)
      // 清单里锁不出版本号 = 这份清单坏了。**不拿它当判据**(否则会把一台好机器判成要重装)。
      if (state.locked === '') return undefined
      last = state
      probedAt = deps.now()
      if (!state.drifted) {
        // 补上了:界面那一格与"为什么停了"一起收掉。
        noticed = false
        stopped = undefined
      }
      return state
    }
    catch { return undefined }
  }

  /* ───────────────────────────── 补 ───────────────────────────── */

  function startRepair(reason: 'auto' | 'manual'): { view: SetupJobView, done: Promise<void> } {
    const id = deps.newId()
    const lines: string[] = []
    const view: SetupJobView = {
      id,
      // 借 `runtime` 这个步骤名:界面上那个进度框认的是 SetupJobView,一趟三步在它眼里就是"装运行环境"。
      step: 'runtime',
      state: 'running',
      started_at: new Date(deps.now()).toISOString(),
      tail: [],
      note: reason === 'auto' ? '正在自动装 DSH 运行环境(几十秒,装完会自动重启一次)' : '正在装 DSH 运行环境(几十秒,装完会自动重启一次)',
    }
    const log = (line: string): void => {
      lines.push(line)
      if (lines.length > 400) lines.splice(0, lines.length - 400)
      view.tail = tailLines(lines.join('\n'))
    }
    /** 子步骤跑着的时候,把它那句人话抄到这一趟上。`subPollMs=0` 就不起定时器(用例)。 */
    const watch = (sub: SetupJobView, step: SetupInstallStep): (() => void) => {
      if (subPollMs <= 0) return () => {}
      const timer = setInterval(() => {
        // 重启那一步之前状态已经落成 done 了,别再把它的 note 改回「正在…」。
        if (view.state !== 'running') return
        if (sub.note !== undefined) view.note = `${titleOf(step)}:${sub.note}`
      }, subPollMs)
      timer.unref?.()
      return () => { clearInterval(timer) }
    }

    const done = (async () => {
      const locked = last?.locked ?? ''
      try {
        if (reason === 'auto') {
          /**
           * **先记账再动手**。记晚了(比如等成功了才记)就防不住那条循环:
           * 补到一半重启 / 崩了,下一个进程看到的账还是 0,又自动补一次。
           */
          const ledger = await readLedger(locked)
          await writeLedger({ locked, attempts: ledger.attempts + 1, last_at: new Date(deps.now()).toISOString() })
        }
        for (const step of RUNTIME_REPAIR_STEPS) {
          if (step === 'restart') {
            /**
             * 重启那一下会把**跑着这段代码的进程**杀掉,所以状态先落成「好了」再发出去 ——
             * 界面一秒问一次,它得有机会看到「装好了,正在重启」这一拍(同 update/apply.ts)。
             */
            view.state = 'done'
            view.note = '运行环境装好了,正在重启工作台。几秒后页面会自己回来 —— 没回来的话把工作台窗口关掉重开一次。'
            view.finished_at = new Date(deps.now()).toISOString()
          }
          const sub = deps.install(step)
          const stop = watch(sub, step)
          try { await deps.waitJob(sub.id) }
          finally { stop() }
          for (const line of sub.tail) log(line)
          if (sub.state === 'failed') {
            throw new Error(`${titleOf(step)}没成功:${sub.error ?? '不知道为什么'}`)
          }
          if (sub.note !== undefined) log(sub.note)
        }
        if (view.state !== 'done') {
          view.state = 'done'
          view.finished_at = new Date(deps.now()).toISOString()
        }
      }
      catch (error) {
        const says = error instanceof Error ? error.message : String(error)
        view.state = 'failed'
        view.error = `${says}。运行环境没换成,你这会儿在用的那一份没有被动过,工作台照常能用。点一次「${RUNTIME_REPAIR_LABEL}」会重来一趟;还不行就把下面那几行发给维护者。`
        view.finished_at = new Date(deps.now()).toISOString()
        view.tail = tailLines(lines.join('\n'))
        // **失败就停在这里**:不自动重试第二遍。界面上那颗按钮还在,他愿意就自己按。
        stopped = { says: view.error, attempts: (await readLedger(locked)).attempts }
        if (reason === 'auto') {
          await writeLedger({ locked, attempts: stopped.attempts, last_at: new Date(deps.now()).toISOString(), last_error: says })
          deps.notify?.({
            key: `${RUNTIME_DRIFT_NOTICE_KEY}_failed`,
            title: '装 DSH 运行环境没成功',
            body: `${says}。工作台照常能用。去设置 → 更新里点一次「${RUNTIME_REPAIR_LABEL}」再试。`,
          })
        }
      }
    })()

    const run = { view, done }
    runs.set(id, run)
    current = run
    // 只留最近几条:这里不做归档,只为"刚才那次失败的输出还在不在"(同 update/service.ts)。
    while (runs.size > 5) {
      const oldest = runs.keys().next().value
      if (oldest === undefined) break
      runs.delete(oldest)
    }
    return run
  }

  /* ───────────────────────────── 门面 ───────────────────────────── */

  return {
    drift: () => last,
    refresh: probe,
    view: () => viewOf(),
    pump: () => {
      if (probing) return
      if (probedAt !== undefined && deps.now() - probedAt < probeMs) return
      probing = true
      // fire-and-forget:探得慢不该拖住 /state(同 setup.pump / update.pump 的写法)。
      void probe()
        .then(async (state) => { if (state?.drifted === true) await onDrift(state) })
        .catch(() => {})
        .finally(() => { probing = false })
    },
    start: () => {
      if (current !== undefined && current.view.state === 'running') return current.view
      if (last?.drifted !== true) return { error: '运行环境已经是这一版要的那一份了,不用再装。' }
      return startRepair('manual').view
    },
    job: id => runs.get(id)?.view,
    waitJob: async (id) => { await runs.get(id)?.done },
  }

  /** 探到漂移之后那三件事:弹通知、按账决定要不要自动补、记下"为什么不补"。 */
  async function onDrift(state: RuntimeDriftState): Promise<void> {
    const ledger = await readLedger(state.locked)
    const willAuto = deps.autoRepair !== false
      && !autoTried
      && maxAttempts > 0
      && ledger.attempts < maxAttempts
      && (current === undefined || current.view.state !== 'running')
    if (!noticed) {
      noticed = true
      deps.notify?.({
        key: RUNTIME_DRIFT_NOTICE_KEY,
        title: '工作台要装一次 DSH 运行环境',
        body: willAuto
          ? `${state.says ?? ''}正在自动装(几十秒),装完会自动重启一次。`
          : `${state.says ?? ''}去设置 → 更新里点一下「${RUNTIME_REPAIR_LABEL}」。`,
      })
    }
    if (willAuto) {
      autoTried = true
      startRepair('auto')
      return
    }
    if (ledger.attempts >= maxAttempts && stopped === undefined) {
      // 账用完了:**不再自动试**,把原因说成人话摆在那一格里(按钮还在)。
      stopped = {
        attempts: ledger.attempts,
        says: `自动装过 ${ledger.attempts} 次都没装上${ledger.last_error === undefined ? '' : `(上一次:${ledger.last_error})`},不再自动试了 —— 免得一直重启。点一下「${RUNTIME_REPAIR_LABEL}」再来一趟,或者把这句话发给维护者。`,
      }
    }
  }

  function viewOf(): UpdateRuntimeStaleView | undefined {
    const state = last
    if (state?.drifted !== true) return undefined
    const running = current !== undefined && current.view.state === 'running'
    const failed = current !== undefined && current.view.state === 'failed'
    return {
      says: state.says ?? '',
      locked: state.locked,
      ...(state.installed === undefined ? {} : { installed: state.installed }),
      action_label: RUNTIME_REPAIR_LABEL,
      ...(running
        ? { repair: { state: 'running' as const, says: current?.view.note ?? '正在装 DSH 运行环境…', ...(current === undefined ? {} : { job: current.view.id }), attempts: stopped?.attempts ?? 1 } }
        : failed
          ? { repair: { state: 'failed' as const, says: current?.view.error ?? '没装成', ...(current === undefined ? {} : { job: current.view.id }), attempts: stopped?.attempts ?? 1 } }
          : stopped === undefined
            ? {}
            : { repair: { state: 'stopped' as const, says: stopped.says, attempts: stopped.attempts } }),
    }
  }
}

/** 一趟补里每一步的人话名字。进度框里那句「正在…」用它;表里没有的就照原样说。 */
const STEP_TITLES: Partial<Record<SetupInstallStep, string>> = {
  profile: '核对工作台在 DSH 里的配置',
  runtime: '装 DSH 运行环境',
  restart: '重启工作台',
}

function titleOf(step: SetupInstallStep): string {
  return STEP_TITLES[step] ?? step
}

/** 去掉最后一段路径。`paths` 算出来的都是 posix 风格的绝对路径,不用 node:path。 */
function dirOf(file: string): string {
  const cut = file.lastIndexOf('/')
  return cut <= 0 ? '/' : file.slice(0, cut)
}

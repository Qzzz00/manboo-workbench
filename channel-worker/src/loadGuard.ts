/**
 * 通话护栏:**通话中,把这台 Mac 上正在跑的构建 / 测试调到后台档,挂断就还原**
 * (2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * ## 为什么要它
 *
 * 维护者 09-24 晚用手机走引导,统筹同时在这台 Mac 上跑两份插件全量 vitest。
 * 工人日志:VAD 落后 31 秒、火山 45000081(等包超时),她半分钟不接话。
 * 这张卡的压测(dev/load-call.ts,两份全量 vitest)复现了同一件事,而且把原因量清楚了:
 *
 *   - 不是换页:最卡的那 19 秒里工人只有 4 次换页;
 *   - 是**抢不到 CPU**:那 19 秒里工人只吃到 1.2 秒 CPU,被抢占了 16598 次。
 *     几十个 vitest 进程与工人**同一个优先级**(31),公平分下来工人跟不上实时音频,
 *     队列一攒,事件循环就一卡十几秒 —— VAD、送火山的音频、她的回话全卡在后面。
 *
 * 同一份负载改用 `taskpolicy -b` 跑,「他说完 → 她开口」中位数从 9.1 秒回到 1.8 秒
 * (交接-0925-通话抗负载与名字 那张表)。所以护栏做的就是这一件事:
 * **通话中**,把认得出的构建 / 测试进程用 `taskpolicy -b -p <pid>` 调到后台档
 * (macOS 的「后台」:只用能效核、磁盘 I/O 降级,优先级 4,工人是 31),
 * **挂断就用 `taskpolicy -B -p <pid>` 还原**。不改任何系统设置,不杀任何进程。
 *
 * ## 为什么在工人这里做,而不是只在「派活起进程的地方」做
 *
 * 派活的主力是**窗口那只手**:话送进 Codex / Claude 的桌面 App,构建与测试由那两个 App
 * 自己起 —— 它们不是我们的子进程,起的时候带不上我们的档位。能碰到它们的只有「事后调档」,
 * 而事后调档该在**通话中**做、**只在通话中**做:平时他就是要它们跑得快。
 * 工人是唯一确切知道「现在在不在通话」的地方。
 *
 * ## 边界(写死的)
 *
 *   - **只碰认得出的构建 / 测试**(见 {@link HEAVY_COMMAND_PATTERNS}):vitest / jest / tsc / tsdown / vite /
 *     esbuild / pnpm·npm·yarn·bun 的 install/test/run/build、cargo / swift / xcodebuild / clang / make、ffmpeg、whisper……
 *     别的一概不碰 —— 他正在用的 App 要跟手。
 *   - **绝不碰**:各家桌面 App 的本体与 Helper(`.app/Contents/MacOS|Frameworks/`)、工人自己和它的祖先
 *     (DSH)与子孙(解 mp3 的 ffmpeg 在她说话的路上)、DSH、8792、livekit-server。
 *   - **只碰同一个用户的**;已经在后台档的不碰(也就不「还原」它 —— 那是别人定的档)。
 *   - 还原只还原**自己调过的**那几个(命令行要对得上,pid 被复用了就不动),
 *     连同它们在通话中新起的、从它们那儿继承了后台档的子孙(vitest 一批批起的 fork)。
 *   - 一通电话最多护 90 分钟,过了先放开(防止「通话状态」卡住让构建一直慢着)。
 *   - 关:`WORKBENCH_CHANNEL_LOAD_GUARD=off`。压测用 `WORKBENCH_CHANNEL_LOAD_GUARD_ONLY_UNDER=<pid>`
 *     把范围收窄到那个进程的子孙(别把别的会话的测试也调了)。
 *
 * 纯函数(解析、挑选)与一个很薄的定时器;`ps` 与 `taskpolicy` 都由外面注入,用例不碰真进程。
 */
import { execFile, execFileSync } from 'node:child_process'

/** `ps -axo pid=,ppid=,uid=,pri=,command=` 的一行。 */
export interface PsRow {
  pid: number
  ppid: number
  uid: number
  /** 调度优先级。darwin 后台档的线程是 4;31 是缺省。 */
  pri: number
  command: string
}

/** 取进程表用的 `ps` 参数。列顺序与 {@link parsePsTable} 对应。 */
export const PS_ARGS: readonly string[] = ['-axo', 'pid=,ppid=,uid=,pri=,command=']

/** 解 `ps` 的输出。读不懂的行跳过,**不抛**(进程表随时在变,半行也是正常的)。 */
export function parsePsTable(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (match === null) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      pri: Number(match[4]),
      command: (match[5] as string).trim(),
    })
  }
  return rows
}

/**
 * 认得出的构建 / 测试 / 转码。**宁可漏认不可错认**:漏认的代价是那一个没被调档,
 * 错认的代价是他正在用的东西突然变慢。
 *
 *   ① 包里的脚本:`node …/node_modules/…/<包>/…`(pnpm 的 `.pnpm/<名@版本>/node_modules/<包>/`、
 *      `.bin/../<包>/`、带作用域的 `@esbuild/…` 都算);
 *   ② 可执行文件本身叫这个名字(路径最后一段);
 *   ③ 包管理器跑重活的那几个子命令(install / test / run / build / exec …)。
 */
export const HEAVY_COMMAND_PATTERNS: readonly RegExp[] = [
  /node_modules\S*?[/@](?:vitest|jest|jest-worker|typescript|tsdown|tsup|esbuild|rollup|webpack|vite|turbo|nx|eslint|playwright|next|swc|babel|tinypool)\//,
  /(?:^|\/)(?:vitest|jest|tsc|tsdown|tsup|esbuild|rollup|webpack|turbo|eslint|playwright|cargo|rustc|clang|clang\+\+|swift-frontend|swiftc|swift-build|xcodebuild|ld|ld64|gradle|gradlew|mvn|make|gmake|ninja|cmake|ccache|pytest|ffmpeg|whisper-cli|go)(?:\s|$)/,
  /(?:^|\/)(?:pnpm|npm|npx|pnpx|yarn|bun)(?:\.c?js)?\s+(?:install|i|ci|add|test|t|run|run-script|exec|x|dlx|build|rebuild)(?:\s|$)/,
]

/**
 * 绝不碰的。**排除优先于认出**:一条命令两边都沾就不碰。
 *   - 各家桌面 App 的本体与 Helper(界面要跟手;`Contents/Developer/` 里的编译器不在此列);
 *   - 工人自己、DSH、8792、livekit-server —— 通话的那条链。
 */
export const PROTECTED_COMMAND_PATTERNS: readonly RegExp[] = [
  /\.app\/Contents\/(?:MacOS|Frameworks)\//,
  /channel-worker\/src\/main\.ts/,
  /@deepseek-ai\/dsh\//,
  /butler-server\//,
  /livekit-server/,
]

/** 这条命令是认得出的构建 / 测试,且不在「绝不碰」里。 */
export function isHeavyCommand(command: string): boolean {
  if (PROTECTED_COMMAND_PATTERNS.some(pattern => pattern.test(command))) return false
  return HEAVY_COMMAND_PATTERNS.some(pattern => pattern.test(command))
}

/** 日志里怎么叫它(vitest、tsc、pnpm……)。认不出就叫「构建」。 */
export function toolNameOf(command: string): string {
  const names = ['vitest', 'jest', 'tsc', 'typescript', 'tsdown', 'tsup', 'esbuild', 'rollup', 'webpack', 'vite', 'turbo', 'eslint', 'playwright',
    'pnpm', 'npm', 'yarn', 'bun', 'cargo', 'rustc', 'swift', 'xcodebuild', 'clang', 'make', 'ninja', 'cmake', 'gradle', 'pytest', 'ffmpeg', 'whisper', 'go']
  for (const name of names) {
    if (new RegExp(`(?:^|[/\\s.])${name}(?:[/\\s.@-]|$)`).test(command)) return name === 'typescript' ? 'tsc' : name
  }
  return '构建'
}

export interface PickOptions {
  /** 工人自己的 pid:它、它的祖先、它的子孙都不碰。 */
  selfPid: number
  /** 只碰这个用户的。 */
  uid: number
  /** 只碰这个进程的子孙(压测用;缺省不限)。 */
  onlyUnder?: number
}

/** 从 `pid` 往上走,看能不能走到 `root`。走到 1 或走不下去就是不能。 */
function isDescendant(pid: number, root: number, parentOf: ReadonlyMap<number, number>): boolean {
  const seen = new Set<number>()
  let current: number | undefined = parentOf.get(pid)
  while (current !== undefined && current > 1 && !seen.has(current)) {
    if (current === root) return true
    seen.add(current)
    current = parentOf.get(current)
  }
  return false
}

/** 这一刻该调档的那几个。**纯函数**。 */
export function pickLoadTargets(rows: readonly PsRow[], options: PickOptions): PsRow[] {
  const parentOf = new Map(rows.map(row => [row.pid, row.ppid]))
  const ancestors = new Set<number>()
  let current: number | undefined = options.selfPid
  while (current !== undefined && current > 1 && !ancestors.has(current)) {
    ancestors.add(current)
    current = parentOf.get(current)
  }
  return rows.filter(row =>
    row.uid === options.uid
    && !ancestors.has(row.pid)
    && !isDescendant(row.pid, options.selfPid, parentOf)
    // 已经在后台档(4 及以下):那是别人定的档,不碰,也就不会去「还原」它。
    && row.pri > 4
    && isHeavyCommand(row.command)
    && (options.onlyUnder === undefined || isDescendant(row.pid, options.onlyUnder, parentOf)),
  )
}

/** 「vitest×7、tsc×1」 */
export function summarizeTools(commands: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const command of commands) {
    const name = toolNameOf(command)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => (count === 1 ? name : `${name}×${count}`)).join('、')
}

/** 一通电话最多护这么久。过了先放开,下一通再护(防止「通话状态」卡住让构建一直慢着)。 */
export const LOAD_GUARD_MAX_ACTIVE_MS = 90 * 60_000

/** 多久看一次进程表。2 秒:新起的一批 vitest 最多在正常档跑 2 秒。 */
export const LOAD_GUARD_TICK_MS = 2000

/** macOS 自带的那一个。 */
export const TASKPOLICY_BIN = '/usr/sbin/taskpolicy'

export interface LoadGuardDeps {
  /** 这一刻在不在通话(含引导那一通)。 */
  isActive: () => boolean
  log: (line: string) => void
  /** 取进程表(`ps` 的原文)。缺省跑真的 `ps`。 */
  listProcesses?: () => Promise<string>
  /** 调档:`on` = 调到后台档,`off` = 还原。回「成了没有」,**不抛**。缺省跑真的 `taskpolicy`。 */
  setBackground?: (pid: number, on: boolean) => Promise<boolean>
  /** 退出时同步还原用(进程马上就没了,等不了异步)。缺省同步跑 `taskpolicy -B`。 */
  setBackgroundSync?: (pid: number) => void
  /** 退出时同步取进程表(找压着的进程在通话中新起的子孙)。缺省同步跑 `ps`。 */
  listProcessesSync?: () => string
  selfPid?: number
  uid?: number
  onlyUnder?: number
  maxActiveMs?: number
  now?: () => number
}

function runPs(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/bin/ps', [...PS_ARGS], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 }, (err, stdout) => resolve(err === null ? stdout : ''))
  })
}

function runTaskpolicy(pid: number, on: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(TASKPOLICY_BIN, [on ? '-b' : '-B', '-p', String(pid)], { timeout: 5000 }, err => resolve(err === null))
  })
}

/**
 * 护栏本体。`tick()` 看一眼:在通话 → 把新冒出来的构建调到后台档;不在 → 把调过的还原。
 * `start()` 每 {@link LOAD_GUARD_TICK_MS} 跑一次 `tick()`;`stop()` 停下并还原。
 */
export class LoadGuard {
  readonly #deps: LoadGuardDeps
  /** 自己调过档的:pid → 当时的命令行(还原前核对,pid 被复用了就不动)。 */
  readonly #held = new Map<number, string>()
  /**
   * 调档那一刻,压着的进程名下**本来就在后台档**的子孙(别人定的档)。还原时「继承来的后台档」
   * 要把它们排除掉 —— 那一档不是从我们这儿来的。
   */
  readonly #alreadyBackground = new Set<number>()
  #activeSince: number | undefined
  /** 这一通护满 90 分钟了:放开之后这一通不再护。 */
  #expired = false
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false

  constructor(deps: LoadGuardDeps) {
    this.#deps = deps
  }

  /** 此刻压着几个(给日志与用例)。 */
  get held(): number { return this.#held.size }

  #now(): number { return (this.#deps.now ?? Date.now)() }

  async #list(): Promise<PsRow[]> {
    return parsePsTable(await (this.#deps.listProcesses ?? runPs)())
  }

  async #set(pid: number, on: boolean): Promise<boolean> {
    try { return await (this.#deps.setBackground ?? runTaskpolicy)(pid, on) }
    catch { return false }
  }

  async tick(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try { await this.#tick() }
    catch (err) { this.#deps.log(`[channel-worker] 通话护栏这一拍没走完:${(err as Error)?.message ?? '没说原因'}`) }
    finally { this.#running = false }
  }

  async #tick(): Promise<void> {
    if (!this.#deps.isActive()) {
      this.#activeSince = undefined
      this.#expired = false
      if (this.#held.size > 0) await this.release('通话结束')
      return
    }
    const now = this.#now()
    this.#activeSince ??= now
    if (this.#expired) return
    if (now - this.#activeSince > (this.#deps.maxActiveMs ?? LOAD_GUARD_MAX_ACTIVE_MS)) {
      this.#expired = true
      await this.release(`这一通护了超过 ${Math.round((this.#deps.maxActiveMs ?? LOAD_GUARD_MAX_ACTIVE_MS) / 60_000)} 分钟,先放开`)
      return
    }
    const rows = await this.#list()
    if (rows.length === 0) return
    // 走掉了的就不再记着(还原时也就不会去碰一个被复用的 pid)。
    const alive = new Set(rows.map(row => row.pid))
    for (const pid of [...this.#held.keys()]) if (!alive.has(pid)) this.#held.delete(pid)
    const targets = pickLoadTargets(rows, {
      selfPid: this.#deps.selfPid ?? process.pid,
      uid: this.#deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1),
      ...(this.#deps.onlyUnder === undefined ? {} : { onlyUnder: this.#deps.onlyUnder }),
    }).filter(row => !this.#held.has(row.pid))
    if (targets.length === 0) return
    const done: string[] = []
    const parentOf = new Map(rows.map(row => [row.pid, row.ppid]))
    for (const row of targets) {
      if (await this.#set(row.pid, true)) {
        this.#held.set(row.pid, row.command)
        done.push(row.command)
        for (const other of rows) {
          if (other.pri <= 4 && isDescendant(other.pid, row.pid, parentOf)) this.#alreadyBackground.add(other.pid)
        }
      }
    }
    if (done.length > 0) {
      this.#deps.log(`[channel-worker] 通话护栏:通话中,把 ${done.length} 个构建/测试进程调到后台档(${summarizeTools(done)});挂断后还原。现在一共压着 ${this.#held.size} 个。`)
    }
  }

  /**
   * 把调过的都还原。**命令行要对得上**才动(pid 被复用了就不碰)。
   *
   * 还有一种要一起还原:压着的进程在**通话中新起的**子孙(vitest 每跑一批就起一批 fork)——
   * 它们是从压着的那个进程继承的后台档,不在「调过的」名单里,只还原父进程的话,
   * 这批子进程会一直慢到自己退出。判据:还在后台档(优先级 ≤4)、同一个用户、祖先里有一个是压着的,
   * 而且**调档那一刻它还不在后台档**(那一刻就在后台档的是别人定的,不碰)。
   */
  async release(why: string): Promise<void> {
    if (this.#held.size === 0) return
    const rows = await this.#list()
    const { direct, inherited } = this.#restorePlan(rows)
    this.#held.clear()
    this.#alreadyBackground.clear()
    let restored = 0
    for (const pid of direct) if (await this.#set(pid, false)) restored += 1
    let children = 0
    for (const pid of inherited) if (await this.#set(pid, false)) children += 1
    this.#deps.log(`[channel-worker] 通话护栏:${why},还原了 ${restored} 个进程的档位${children > 0 ? `(连同它们通话中新起的 ${children} 个子进程)` : ''}。`)
  }

  /** 该还原哪些:自己调过、命令行对得上的(direct);它们名下继承了后台档的子孙(inherited)。 */
  #restorePlan(rows: readonly PsRow[]): { direct: number[], inherited: number[] } {
    const commandOf = new Map(rows.map(row => [row.pid, row.command]))
    const parentOf = new Map(rows.map(row => [row.pid, row.ppid]))
    const direct = [...this.#held.entries()].filter(([pid, command]) => commandOf.get(pid) === command).map(([pid]) => pid)
    const roots = new Set(direct)
    const uid = this.#deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1)
    const inherited = rows
      .filter(row => row.pri <= 4 && row.uid === uid && !roots.has(row.pid) && !this.#alreadyBackground.has(row.pid))
      .filter(row => [...roots].some(root => isDescendant(row.pid, root, parentOf)))
      .map(row => row.pid)
    return { direct, inherited }
  }

  /** 进程要退出了:同步还原(等不了异步;同步取一次进程表,连同继承了后台档的子孙一起还原)。 */
  releaseSync(): void {
    if (this.#held.size === 0) return
    let rows: PsRow[] = []
    try {
      rows = parsePsTable((this.#deps.listProcessesSync ?? (() => execFileSync('/bin/ps', [...PS_ARGS], { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }).toString('utf8')))())
    }
    catch { /* 取不到进程表:只按 pid 还原下面那几个 */ }
    const plan = rows.length === 0 ? { direct: [...this.#held.keys()], inherited: [] } : this.#restorePlan(rows)
    const set = this.#deps.setBackgroundSync ?? ((one: number) => { execFileSync(TASKPOLICY_BIN, ['-B', '-p', String(one)], { timeout: 3000, stdio: 'ignore' }) })
    for (const pid of [...plan.direct, ...plan.inherited]) {
      try { set(pid) }
      catch { /* 已经走了 */ }
    }
    this.#held.clear()
    this.#alreadyBackground.clear()
  }

  start(intervalMs = LOAD_GUARD_TICK_MS): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => { void this.tick() }, intervalMs)
    this.#timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) { clearInterval(this.#timer); this.#timer = undefined }
    await this.release('工人收场')
  }
}

/**
 * 护栏开不开、范围多大(环境变量 → 选项)。**只在 macOS 上开**:`taskpolicy` 是 macOS 的;
 * 别的平台如实说一句「没开」。
 */
export function loadGuardSettingsOf(env: Record<string, string | undefined>, platform: string = process.platform): { on: boolean, note?: string, onlyUnder?: number } {
  const raw = (env.WORKBENCH_CHANNEL_LOAD_GUARD ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return { on: false, note: '通话护栏按配置关着(WORKBENCH_CHANNEL_LOAD_GUARD=off)' }
  if (platform !== 'darwin') return { on: false, note: `通话护栏只在 macOS 上有(这台是 ${platform})` }
  const under = Number.parseInt((env.WORKBENCH_CHANNEL_LOAD_GUARD_ONLY_UNDER ?? '').trim(), 10)
  return Number.isInteger(under) && under > 1 ? { on: true, onlyUnder: under } : { on: true }
}

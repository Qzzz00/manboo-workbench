/**
 * 工作台自身的开关,落盘 ~/.dsh/workbench/app.json(2026-09-11 起;第一项是「允许手机在局域网访问」)。
 *
 * 规格与 notes.json/dock.json 一致:原子写(tmp + rename)、容错读(写坏了按默认兜底,不抛)。
 * 文件里不认识的键**原样保留**——这个文件以后还会装别的开关,不能一个 set 把别人的抹掉。
 * 只有一个用户,不做多 profile、不做环境变量覆盖。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isUpdateChannel, type UpdateChannel } from './update/types.ts'
import { EXPERIMENT_KEYS, type Audience, type ExperimentKey } from '../mainPaths.ts'

/** 一个扫描根:根目录 + 往下找几层(depth 1~3,见 scan.ts 的 findRepos)。 */
export interface AppConfigScanRoot { path: string, depth: number }

/** depth 只认 1~3:0 等于"只看根目录自己是不是仓库",4 以上在 ~/Documents 这种目录下是灾难性的全盘遍历。 */
export const APP_CONFIG_DEPTH_MIN = 1
export const APP_CONFIG_DEPTH_MAX = 3

export interface AppConfig {
  /** 允许手机在局域网访问:开着才同时监听 0.0.0.0 并广播 mDNS,关掉即回到只听 127.0.0.1。 */
  lan_access: boolean
  /**
   * 项目区扫描根(2026-09-17 卡 C)。**缺席 ≠ 空数组**:缺席是「没配过,用默认的三个根」,
   * 空数组是「一个都不要扫」——后者是 Ben 的明确选择,不该被当成没配过。
   */
  scan_roots?: AppConfigScanRoot[]
  /** 文件收件箱盯哪些目录。同上,缺席用默认(~/Downloads、~/Desktop)。 */
  inbox_dirs?: string[]
  /**
   * 事务官(与引导/授权/例程)默认开在哪个仓库。**环境变量 `WORKBENCH_BUTLER_CWD` 优先**,
   * 这里是它的落盘兜底。两处都没有就整块不接——不猜路径(见 index.ts 那段注释)。
   */
  butler_cwd?: string
  /**
   * 「注册完之后那三屏(手机 / 配对 / 事务官出场)给他看过了」的时刻(2026-09-17 引导入口)。
   * **缺席 = 还没走过**,界面据此在登录之后出一次首次流程;设置里「重新走一遍首次流程」
   * 把它擦掉(set 传空串)。与引导本身的 onboarding.json 分开:引导可以重来好几遍,
   * 而这面旗子说的是"那三屏出现过一次"。
   */
  first_run_done_at?: string
  /**
   * 「出错自动报告给开发者」(2026-09-22)。**缺席 = 开**,与上面几项相反,而且是故意的:
   * 老机器上那个文件里没有这一格,而这张卡的前提正是「Ben 那台新 Mac 脱机跑,
   * 出了错统筹得看得见」。默认开、首次进体检页时把那段说明显著地摆一次
   * (`diag_notice_seen_at`)、旁边就是关掉它的开关。
   *
   * 读的时候一律写 `!== false`,**不要写 `=== true`** —— 那会把"没配过"读成关着。
   */
  diag_report?: boolean
  /** 那段说明给他看过了的时刻(ISO)。缺席 = 还没看过。 */
  diag_notice_seen_at?: string
  /**
   * 「工作台开着时电脑不睡」(2026-09-28,卡 AW)。**缺席 = 开**(同 diag_report,故意的)。
   *
   * 壳据此按住一条 `PreventUserIdleSystemSleep`:工作台在运行期间整台电脑不因空闲睡眠
   * (屏幕照样会黑、会锁)。维护者 09-28 早的现场:新 Air 不插电,电脑自己睡过去,
   * 手机上立刻变成「找不到你的电脑」—— 而她只是没在用电脑而已。
   *
   * 读的时候一律写 `!== false`,**不要写 `=== true`** —— 那会把「没配过」读成关着。
   */
  system_awake_while_running?: boolean
  /**
   * 「出门时电脑不睡」(2026-10-03,卡「出门时电脑不睡」)。**缺席 = 关**
   * —— 和上面那颗(缺席 = 开)正好相反,而且是故意的。
   *
   * 开着的时候:只要**有一台已配对手机经中转连着**(= 她出门了),壳就按住那条
   * 「别让显示器因为闲着而暗 / 睡」—— 不管工作台在不在最前面。为什么要这一颗:本机
   * `displaysleep 10` + `screenLock delay is immediate`,她离开 10 分钟屏幕就睡、一睡立刻锁,
   * 而锁屏时窗口型的家(豆包 / Kimi / Manus…)一扇窗都列不出来,她在外面答的那句话送不进去
   * (`docs/交接-1003-锁屏时窗口型的家.md` 第四节)。
   *
   * 代价是**她不在家的时候家里那块屏一直亮着**,而这是她自己看不见的 —— 所以缺省关,
   * 由她在设置里自己开,那句代价写在开关旁边。
   *
   * 读的时候一律写 `=== true`,**不要写 `!== false`**(缺席是关,不是开)。
   */
  away_keep_awake?: boolean
  /**
   * 这台机器收哪条更新通道(2026-10-21,内测发版底座;两条的说法见 `update/types.ts`)。
   * **缺席 = 稳定版**;写成认不出的值同样当没配 —— 读不懂一份配置不该让体验的人收到热修。
   */
  update_channel?: UpdateChannel
  /**
   * 实验开关(2026-10-21,卡「引导三件事」;四样见 `src/mainPaths.ts` 的 `EXPERIMENT_KEYS`)。
   * **缺席的那一样按 {@link audience} 定默认**(内部开、外部关),存了的照存的。只认真正的布尔。
   */
  experiments?: Partial<Record<ExperimentKey, boolean>>
  /** 这台机器算内部还是外部(只决定实验开关的默认)。缺席 = 环境变量 / 有没有源码仓库来判(`audienceOf`)。 */
  audience?: Audience
}

export interface AppConfigFile extends AppConfig {
  version: 1
  [key: string]: unknown
}

export function defaultAppConfigFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/app.json`
}

function defaults(): AppConfigFile {
  return { version: 1, lan_access: false }
}

export async function loadAppConfigFile(file: string): Promise<AppConfigFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return defaults()
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | null
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaults()
    const next: AppConfigFile = { ...parsed, version: 1, lan_access: parsed.lan_access === true }
    // 三项路径:形状不对的**整条丢掉**,不夹一个猜出来的值进去(D13)。
    // 整项的类型就不对(butler_cwd 写成了数字)时要把这个键**删掉**,不能让 `...parsed`
    // 带进来的脏值原样留在视图里——那会一路漏到 effective,变成一个谁都解释不了的路径。
    delete next.scan_roots
    delete next.inbox_dirs
    delete next.butler_cwd
    delete next.first_run_done_at
    delete next.diag_report
    delete next.diag_notice_seen_at
    delete next.system_awake_while_running
    delete next.away_keep_awake
    delete next.update_channel
    delete next.experiments
    delete next.audience
    return {
      ...next,
      ...readScanRoots(parsed.scan_roots),
      ...readInboxDirs(parsed.inbox_dirs),
      ...readButlerCwd(parsed.butler_cwd),
      ...readFirstRunDoneAt(parsed.first_run_done_at),
      ...readDiagReport(parsed.diag_report),
      ...readDiagNoticeSeenAt(parsed.diag_notice_seen_at),
      ...readSystemAwake(parsed.system_awake_while_running),
      ...readAwayKeepAwake(parsed.away_keep_awake),
      ...(isUpdateChannel(parsed.update_channel) ? { update_channel: parsed.update_channel } : {}),
      ...readExperiments(parsed.experiments),
      ...readAudience(parsed.audience),
    }
  }
  catch {
    return defaults()
  }
}

function readScanRoots(raw: unknown): { scan_roots?: AppConfigScanRoot[] } {
  if (!Array.isArray(raw)) return {}
  const out: AppConfigScanRoot[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { path, depth } = entry as { path?: unknown, depth?: unknown }
    if (typeof path !== 'string' || path === '') continue
    if (typeof depth !== 'number' || !Number.isInteger(depth)) continue
    if (depth < APP_CONFIG_DEPTH_MIN || depth > APP_CONFIG_DEPTH_MAX) continue
    out.push({ path, depth })
  }
  return { scan_roots: out }
}

function readInboxDirs(raw: unknown): { inbox_dirs?: string[] } {
  if (!Array.isArray(raw)) return {}
  return { inbox_dirs: raw.filter((entry): entry is string => typeof entry === 'string' && entry !== '') }
}

function readButlerCwd(raw: unknown): { butler_cwd?: string } {
  return typeof raw === 'string' && raw !== '' ? { butler_cwd: raw } : {}
}

function readFirstRunDoneAt(raw: unknown): { first_run_done_at?: string } {
  return typeof raw === 'string' && raw !== '' ? { first_run_done_at: raw } : {}
}

/**
 * 「出错自动报告给开发者」。**只认真正的布尔**:写成 `"false"`(字符串)那种脏值一律当没配,
 * 而没配 = 开。写成关的唯一办法是那颗开关写进去的 `false`。
 */
function readDiagReport(raw: unknown): { diag_report?: boolean } {
  return typeof raw === 'boolean' ? { diag_report: raw } : {}
}

function readDiagNoticeSeenAt(raw: unknown): { diag_notice_seen_at?: string } {
  return typeof raw === 'string' && raw !== '' ? { diag_notice_seen_at: raw } : {}
}

/**
 * 「工作台开着时电脑不睡」。同 diag_report:**只认真正的布尔**,写成 `"false"` 那种脏值
 * 一律当没配,而没配 = 开。壳那边(SystemAwakePolicy.settingOn)是逐字同一条规矩。
 */
function readSystemAwake(raw: unknown): { system_awake_while_running?: boolean } {
  return typeof raw === 'boolean' ? { system_awake_while_running: raw } : {}
}

/**
 * 「出门时电脑不睡」。同上**只认真正的布尔**,写成 `"true"`(字符串)那种脏值一律当没配 ——
 * 而没配 = **关**(与上面那颗相反:读不懂一份配置不该让她家里那块屏整天亮着)。
 */
function readAwayKeepAwake(raw: unknown): { away_keep_awake?: boolean } {
  return typeof raw === 'boolean' ? { away_keep_awake: raw } : {}
}

/** 实验开关:只留认得的那几样、只认真正的布尔;一样都没留下就整项缺席(= 全按默认)。 */
function readExperiments(raw: unknown): { experiments?: Partial<Record<ExperimentKey, boolean>> } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const kept = Object.fromEntries(EXPERIMENT_KEYS.flatMap((key) => {
    const value = (raw as Record<string, unknown>)[key]
    return typeof value === 'boolean' ? [[key, value]] : []
  })) as Partial<Record<ExperimentKey, boolean>>
  return Object.keys(kept).length === 0 ? {} : { experiments: kept }
}

function readAudience(raw: unknown): { audience?: Audience } {
  return raw === 'internal' || raw === 'external' ? { audience: raw } : {}
}

export async function saveAppConfigFile(file: string, data: AppConfigFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

export interface AppConfigService {
  get(): Promise<AppConfig>
  set(patch: Partial<AppConfig>): Promise<AppConfig>
}

function view(data: AppConfigFile): AppConfig {
  return {
    lan_access: data.lan_access,
    // exactOptionalPropertyTypes:缺席要真的缺席,不能写成 `key: undefined`。
    ...(data.scan_roots === undefined ? {} : { scan_roots: data.scan_roots }),
    ...(data.inbox_dirs === undefined ? {} : { inbox_dirs: data.inbox_dirs }),
    ...(data.butler_cwd === undefined ? {} : { butler_cwd: data.butler_cwd }),
    ...(data.first_run_done_at === undefined ? {} : { first_run_done_at: data.first_run_done_at }),
    ...(data.diag_report === undefined ? {} : { diag_report: data.diag_report }),
    ...(data.diag_notice_seen_at === undefined ? {} : { diag_notice_seen_at: data.diag_notice_seen_at }),
    ...(data.system_awake_while_running === undefined ? {} : { system_awake_while_running: data.system_awake_while_running }),
    ...(data.away_keep_awake === undefined ? {} : { away_keep_awake: data.away_keep_awake }),
    ...(data.experiments === undefined ? {} : { experiments: data.experiments }),
    ...(data.audience === undefined ? {} : { audience: data.audience }),
  }
}

export function createAppConfig(opts: { file: string }): AppConfigService {
  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    async get() {
      return view(await loadAppConfigFile(opts.file))
    },
    set(patch) {
      return enqueueWrite(async () => {
        const data = await loadAppConfigFile(opts.file)
        const next: AppConfigFile = {
          ...data,
          ...(patch.lan_access === undefined ? {} : { lan_access: patch.lan_access }),
          ...(patch.scan_roots === undefined ? {} : { scan_roots: patch.scan_roots }),
          ...(patch.inbox_dirs === undefined ? {} : { inbox_dirs: patch.inbox_dirs }),
          ...(patch.butler_cwd === undefined ? {} : { butler_cwd: patch.butler_cwd }),
          ...(patch.first_run_done_at === undefined ? {} : { first_run_done_at: patch.first_run_done_at }),
          ...(patch.diag_report === undefined ? {} : { diag_report: patch.diag_report }),
          ...(patch.diag_notice_seen_at === undefined ? {} : { diag_notice_seen_at: patch.diag_notice_seen_at }),
          ...(patch.system_awake_while_running === undefined ? {} : { system_awake_while_running: patch.system_awake_while_running }),
          ...(patch.away_keep_awake === undefined ? {} : { away_keep_awake: patch.away_keep_awake }),
          // 实验开关一样一样地改:合进已存的那几样,不把别的几样抹回默认。
          ...(patch.experiments === undefined ? {} : { experiments: { ...data.experiments, ...patch.experiments } }),
          ...(patch.audience === undefined ? {} : { audience: patch.audience }),
        }
        // 空串 = 「清掉这一项」(退回环境变量 / 退回默认),落盘里就不该再留一个空值。
        if (patch.butler_cwd === '') delete next.butler_cwd
        if (patch.first_run_done_at === '') delete next.first_run_done_at
        await saveAppConfigFile(opts.file, next)
        return view(next)
      })
    },
  }
}

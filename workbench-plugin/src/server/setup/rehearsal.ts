/**
 * 新机器演练(2026-10-21,内测发版底座;10-15 方案第五节)。**判法与报告都在这里**,
 * `scripts/rehearse.ts` 只负责挂安装包、起安装器内核、跑体检、落报告(同 install-from-bundle.ts 的分法)。
 *
 * 每个稳定版发出去之前,在一个隔离的 home 里**照安装包从零装一遍**:装 → 体检 → 一份 Markdown 报告
 * (成 / 没成 / 缺哪道门 / 用时)。发版脚本 `--channel stable` 先跑它,红了就不发。
 *
 * ## 不碰这台真机
 *
 * 隔离 home 是 mktemp 出来的;安装器内核带 `--no-launch`(一条 launchctl 都不跑)、并且**不跑「整理桌面」**
 * 那一步(它 `defaults write` 的是这台机器上真用户的程序坞与菜单栏,不跟 HOME 走)。再加一道:
 * `REHEARSAL_SHIMMED_COMMANDS` 那几条命令在演练的 PATH 最前面换成只记一行、退 1 的假脚本(同引导卡的规矩:
 * 同一个用户下 launchd 的服务名是共用的,隔离实例想登记 / 重启的正是真机那几项)—— 哪天安装器
 * 多了一步会改系统的,演练也不会顺手把维护者这台改了。
 *
 * ## 体检怎么判
 *
 * 两份自检都跑:现有的五步体检(`createSetupStatus().check()`),加引导卡的「装完自检三件」只看本机那一版
 * (`installSelfCheck.ts` 的 `readOfflineFacts → offlineSelfCheck → rehearseRowsOf`,经 `checkRowsFromSelfChecks`)。
 * 演练不起服务,三件那一版只写得出缺哪道门、写不出「成」,所以它们只会落在「缺的门」。每一项归四档:
 *
 * - **都在**;
 * - **没成**:新装的机器上本该有、却没有(`REHEARSAL_MUST_HAVE`)—— 这是安装包的毛病,**整趟变红**;
 * - **缺的门**:要她自己点授权、填钥匙、登录别家、装别家 App 的 —— 新机器的常态,**照实列出来,不算红**;
 * - **演练里不判**:开机自启(不装载)与网页登录态(不起服务),说清为什么。
 */
import { redactText } from '../diagnostics/redact.ts'
import type { InstallerEvent } from './installer.ts'
import type { SetupItem } from './types.ts'

/** 演练里不跑的安装步骤:改的是这台真机上的东西,不跟 HOME 走。 */
export const REHEARSAL_SKIPPED_STEPS = ['desktop'] as const

/** 演练的 PATH 最前面换成假脚本的命令(会改登录会话或系统设置的那几条)。 */
export const REHEARSAL_SHIMMED_COMMANDS = ['launchctl', 'defaults', 'killall', 'osascript', 'tccutil'] as const

/** 新装的机器上**本该有**的几样:少一样就是安装包的毛病。 */
export const REHEARSAL_MUST_HAVE = ['node', 'runtime', 'profile', 'dsh_start', 'shell_app', 'butler_cwd'] as const

/** 演练里不判的体检项,各一句为什么。 */
export const REHEARSAL_NOT_JUDGED: Readonly<Record<string, string>> = {
  launchd_dsh: '演练不装载开机自启(安装器带 --no-launch);装载那一下由发版时的本机闸在真机上验。',
  web_cookie: '要工作台真起来过一次才有;演练不起服务。',
}

export interface TimedInstallerEvent { at: number, event: InstallerEvent }

export interface RehearsalStepRow {
  key: string
  title: string
  state: 'ok' | 'skip' | 'fail' | 'not_run'
  ms?: number
  detail?: string
}

export type RehearsalCheckState = 'ok' | 'red' | 'gate' | 'skip'

export interface RehearsalCheckRow {
  key: string
  title: string
  state: RehearsalCheckState
  detail: string
}

/** 引导卡「装完自检三件」每一件的形状(2026-10-21 与 onboarding-3 对过)。 */
export interface SelfCheckRow {
  key: string
  title: string
  ok: boolean
  /** 没成时缺的是哪道门(没登录哪家、缺钥匙、手机没配对)。缺席 = 不是门的事,是真没成。 */
  gate?: string
  detail: string
}

export interface RehearsalResult {
  version: string
  startedAt: number
  finishedAt: number
  pkg: { kind: 'dmg' | 'resources', path: string, sha256?: string, built?: boolean }
  /** 隔离 home 所在的那个目录。 */
  box: string
  /** 演练完留着没删(`--keep`)。 */
  kept: boolean
  /** 安装器内核的退出码。`null` = 没起来 / 被杀了(看 `installerError`)。 */
  installerExit: number | null
  installerError?: string
  steps: readonly RehearsalStepRow[]
  checkSource: 'five_step' | 'self_check'
  checks: readonly RehearsalCheckRow[]
  /** 引导卡三件自检(只看本机那一版)。缺席 = 没跑。 */
  selfChecks?: readonly RehearsalCheckRow[]
  /** 没成时安装日志的尾巴(已脱敏)。 */
  logTail: readonly string[]
}

/**
 * 事件流 → 每一步的结局与用时。一步从它的 `step` 事件开始,到下一步开始 / `done` / 收尾时刻为止。
 * 计划里有、却没走到的那几步标 `not_run`(停在前面某一步了)。
 */
export function installStepsOf(
  events: readonly TimedInstallerEvent[],
  planned: readonly { key: string, title: string }[],
  endedAt: number,
): RehearsalStepRow[] {
  const starts = new Map<string, number>()
  const order: string[] = []
  const failed = new Map<string, { at: number, error: string }>()
  const skipped = new Map<string, { at: number, why: string }>()
  let doneAt: number | undefined
  for (const { at, event } of events) {
    if (event.t === 'step') { starts.set(event.key, at); order.push(event.key) }
    else if (event.t === 'fail') failed.set(event.key, { at, error: event.error })
    else if (event.t === 'skip') skipped.set(event.key, { at, why: event.why })
    else if (event.t === 'done') doneAt = at
  }
  const endOf = (key: string): number => {
    const next = order[order.indexOf(key) + 1]
    if (next !== undefined) return starts.get(next) ?? endedAt
    return failed.get(key)?.at ?? doneAt ?? endedAt
  }
  return planned.map(({ key, title }) => {
    const start = starts.get(key)
    if (start === undefined) return { key, title, state: 'not_run' as const }
    const ms = endOf(key) - start
    const fail = failed.get(key)
    if (fail !== undefined) return { key, title, state: 'fail' as const, ms, detail: fail.error }
    const skip = skipped.get(key)
    if (skip !== undefined) return { key, title, state: 'skip' as const, ms, detail: skip.why }
    return { key, title, state: 'ok' as const, ms }
  })
}

/** 五步体检的结果 → 四档。 */
export function checkRowsFromSetup(items: readonly SetupItem[]): RehearsalCheckRow[] {
  const mustHave: readonly string[] = REHEARSAL_MUST_HAVE
  return items.map((item) => {
    const notJudged = REHEARSAL_NOT_JUDGED[item.key]
    if (notJudged !== undefined) return { key: item.key, title: item.label, state: 'skip', detail: notJudged }
    if (item.state === 'ok') return { key: item.key, title: item.label, state: 'ok', detail: item.detail }
    const detail = item.fix === undefined ? item.detail : `${item.detail} —— ${item.fix}`
    return { key: item.key, title: item.label, state: mustHave.includes(item.key) ? 'red' : 'gate', detail }
  })
}

/** 引导卡三件自检的结果 → 同一套四档。 */
export function checkRowsFromSelfChecks(rows: readonly SelfCheckRow[]): RehearsalCheckRow[] {
  return rows.map((row) => {
    if (row.ok) return { key: row.key, title: row.title, state: 'ok', detail: row.detail }
    if (row.gate !== undefined) return { key: row.key, title: row.title, state: 'gate', detail: `${row.gate}(${row.detail})` }
    return { key: row.key, title: row.title, state: 'red', detail: row.detail }
  })
}

/** 整趟成没成。缺的门不算;安装没走完、有一步没成、体检里有「没成」才红。 */
export function rehearsalVerdict(result: RehearsalResult): { ok: boolean, reds: string[] } {
  const reds: string[] = []
  if (result.installerExit !== 0) {
    reds.push(result.installerExit === null
      ? `安装器没跑完:${result.installerError ?? '没起来'}`
      : `安装器退出码 ${result.installerExit}(有一步没装成)`)
  }
  for (const step of result.steps) {
    if (step.state === 'fail') reds.push(`安装「${step.title}」没成:${step.detail ?? ''}`)
  }
  for (const check of [...result.checks, ...(result.selfChecks ?? [])]) {
    if (check.state === 'red') reds.push(`体检「${check.title}」(${check.key})没有:${check.detail}`)
  }
  return { ok: reds.length === 0, reds }
}

export function humanMs(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

const STATE_MARK: Record<RehearsalCheckState, string> = { ok: '成', red: '没成', gate: '缺门', skip: '不判' }

const STEP_MARK: Record<RehearsalStepRow['state'], string> = { ok: '成', skip: '跳过', fail: '没成', not_run: '没走到' }

/** 一格里的话:脱敏(路径里的用户名、钥匙的样子)、换行与竖线换掉(表格里放得下)。 */
function cell(text: string): string {
  return redactText(text).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ')
}

/** 能直接贴进交接的那一份 Markdown。 */
export function renderRehearsalReport(result: RehearsalResult): string {
  const verdict = rehearsalVerdict(result)
  const at = new Date(result.startedAt).toISOString().replace('T', ' ').slice(0, 16)
  const gates = result.checks.filter(row => row.state === 'gate')
  const lines: string[] = [
    `# 新机器演练 · ${result.version} · ${verdict.ok ? '成' : '没成'}`,
    '',
    `- 时刻:${at}(UTC),用时 ${humanMs(result.finishedAt - result.startedAt)}`,
    `- 安装包:${cell(result.pkg.path)}${result.pkg.sha256 === undefined ? '' : `(sha256 ${result.pkg.sha256.slice(0, 12)}…)`}${result.pkg.built === true ? ',这一趟临时打的' : ''}`,
    `- 隔离 home:${cell(result.box)}(${result.kept ? '留着没删' : '演练完已删'})`,
    `- 自检:${result.checkSource === 'five_step' ? '五步体检' : '引导卡的装完自检三件'}${result.selfChecks === undefined ? '' : ' + 引导卡的装完自检三件(只看本机,没起服务)'}`,
    '- 不碰这台真机:安装器带 --no-launch,「整理桌面」那一步不跑,launchctl / defaults / killall 被挡',
    '',
    '## 结论',
    '',
  ]
  if (verdict.ok) {
    lines.push(`成:安装包从零装得上,新机器上本该有的都在。缺的门 ${gates.length} 道(新机器上要她自己点、自己登录的,见下)。`)
  }
  else {
    lines.push('没成:')
    for (const red of verdict.reds) lines.push(`- ${cell(red)}`)
  }
  lines.push('', '## 安装', '', '| 步 | 结果 | 用时 | 说明 |', '|---|---|---|---|')
  for (const step of result.steps) {
    lines.push(`| ${cell(step.title)}(${step.key}) | ${STEP_MARK[step.state]} | ${step.ms === undefined ? '—' : humanMs(step.ms)} | ${cell(step.detail ?? '')} |`)
  }
  const section = (title: string, state: RehearsalCheckState): void => {
    const rows = result.checks.filter(row => row.state === state)
    lines.push('', `## ${title}`, '')
    if (rows.length === 0) { lines.push('(没有)'); return }
    for (const row of rows) lines.push(`- **${cell(row.title)}**(${row.key}):${cell(row.detail)}`)
  }
  section('没成(新装的机器上本该有却没有)', 'red')
  section('缺哪道门', 'gate')
  section('演练里不判', 'skip')
  section('都在', 'ok')
  if (result.selfChecks !== undefined) {
    lines.push('', '## 装完自检三件(只看本机,没起服务)', '')
    for (const row of result.selfChecks) lines.push(`- **${cell(row.title)}**(${STATE_MARK[row.state]}):${cell(row.detail)}`)
  }
  if (result.logTail.length > 0) {
    lines.push('', '## 安装日志的尾巴', '', '```', ...result.logTail.map(line => redactText(line)), '```')
  }
  return `${lines.join('\n')}\n`
}

export interface RehearseArgs {
  version?: string
  dmg?: string
  resources?: string
  report?: string
  keep: boolean
  /** 找不到这一版的安装包时临时打一份(打在演练的隔离目录里,不落 dist/)。 */
  build: boolean
}

export function parseRehearseArgs(argv: readonly string[]): { ok: true, args: RehearseArgs } | { ok: false, error: string } {
  const args: RehearseArgs = { keep: false, build: true }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = (): string | undefined => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) return undefined
      i += 1
      return next
    }
    if (flag === '--keep') { args.keep = true; continue }
    if (flag === '--no-build') { args.build = false; continue }
    if (flag === '--version' || flag === '--dmg' || flag === '--resources' || flag === '--report') {
      const got = value()
      if (got === undefined) return { ok: false, error: `${flag} 后面要跟一个值。` }
      args[flag.slice(2) as 'version' | 'dmg' | 'resources' | 'report'] = got
      continue
    }
    return { ok: false, error: `不认识的参数:${flag ?? ''}。能用的是 --version / --dmg / --resources / --report / --keep / --no-build。` }
  }
  if (args.dmg !== undefined && args.resources !== undefined) {
    return { ok: false, error: '--dmg 与 --resources 只给一个:一个是安装包,一个是已经解开的 Resources 目录。' }
  }
  return { ok: true, args }
}

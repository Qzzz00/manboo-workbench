/**
 * 诊断的对外门面(2026-09-22)。http.ts 只认这一个接口,不认底下那五块。
 *
 * 四件事:
 *   1. `export()`  —— 摆一棵暂存树 → 压成 zip → 落到桌面 → 在访达里选中它;
 *   1½. `send()`   —— 同一个包,传到中转的存放位、回六位编号(2026-10-21;传不上去就照样落桌面);
 *   2. `settings()` / `setReportEnabled()` —— 那颗「出错自动报告给开发者」的开关;
 *   3. `report()`   —— 四类事件的入口(插件自己、工人看护、更新、通话都往这儿送)。
 *
 * 外加一件后台活:`pump()` 里顺手收拾日志(按天轮转 + 总量封顶)并把攒着的合并上报发出去。
 * 同 setup.pump / sentinel 那条「请求驱动 + 内部限频」的老规矩 —— 不起定时器,
 * 因为这台服务本来就每秒被 /state 敲一次。
 */
import { readFile } from 'node:fs/promises'
import type { DiagComponent, DiagSendView, DiagSettingsView } from '../../diag.ts'
import { loadAppConfigFile, saveAppConfigFile } from '../appConfig.ts'
import type { SetupPaths } from '../setup/paths.ts'
import type { DiagIo } from './io.ts'
import { packNameOf, stageDiagPackage, type DiagPackDeps, type DiagPackEntry, type DiagPackSkipped } from './pack.ts'
import { createDiagReporter, type DiagEvent, type DiagReportOutcome, type DiagReporter, type DiagReporterDeps } from './report.ts'
import { rotateDiagLogs, type RotateOutcome } from './rotate.ts'

/** 收拾日志的最小间隔。一小时一次:轮转是按天的,一小时的粒度绰绰有余。 */
export const DIAG_ROTATE_MS = 3_600_000

/** 压包给多久。7 天日志几十兆,ditto 压它要几秒;给一分钟是给慢机器留的余量。 */
export const ZIP_TIMEOUT_MS = 120_000

/** 传诊断包给多久。几十兆在慢的上行上要一两分钟;超过这个数当传不上去,包留在桌面。 */
export const DIAG_SEND_TIMEOUT_MS = 180_000

export interface DiagExportResult {
  ok: true
  /** zip 的绝对路径(**没脱敏** —— 这是给本机界面显示的,不进包、不上报)。 */
  file: string
  /** 脱敏过的那一份,写进交接、贴进聊天时用这个。 */
  file_redacted: string
  bytes: number
  entries: readonly DiagPackEntry[]
  skipped: readonly DiagPackSkipped[]
  /** 在访达里选中成功了没有。失败不算整件事失败 —— 包已经在桌面上了。 */
  revealed: boolean
}

export interface DiagService {
  export: () => Promise<DiagExportResult | { ok: false, error: string }>
  settings: () => Promise<DiagSettingsView>
  setReportEnabled: (enabled: boolean) => Promise<DiagSettingsView>
  /** 「那段说明我看过了」。体检页第一次显示完就调它。 */
  markNoticeSeen: () => Promise<DiagSettingsView>
  report: (event: DiagEvent) => Promise<DiagReportOutcome>
  /** 后台活:轮转日志 + 把合并上报发出去。每拍调,内部限频。 */
  pump: () => void
  /** 上一次收拾日志的结果。体检页那一格显示"日志占了多少"。 */
  lastRotate: () => RotateOutcome | undefined
  /** 起一趟「发诊断包」,立刻回。已经在跑就回那一条(不打第二个包)。 */
  send: () => DiagSendView
  /** 最近那一趟(没发过就 undefined)。 */
  sendView: () => DiagSendView | undefined
  /** 等那一趟跑完。生产用不到,测试用。 */
  waitSend: (id: string) => Promise<void>
}

export interface DiagServiceDeps extends Omit<DiagPackDeps, 'io'>, Pick<DiagReporterDeps, 'link'> {
  io: DiagIo
  paths: SetupPaths
  /** 包落到哪。缺省 `<home>/Desktop`;测试传临时目录(**包绝不落进真桌面**)。 */
  outDir?: string
  /** 暂存目录。缺省 `<dshHome>/diagnostics`。 */
  stageRoot?: string
  /** 分钟偏移(`-new Date().getTimezoneOffset()`)。 */
  tzOffsetMinutes: number
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  rotateMs?: number
  /** 读打好的 zip(传给中转用)。缺省 node 的 readFile;`DiagIo` 只读文本,读不了二进制。 */
  readBytes?: (path: string) => Promise<Uint8Array<ArrayBuffer>>
}

export function createDiagService(deps: DiagServiceDeps): DiagService {
  const io = deps.io
  const paths = deps.paths
  const appJson = paths.appJson
  const outDir = deps.outDir ?? `${paths.home}/Desktop`
  const stageRoot = deps.stageRoot ?? `${paths.dshHome}/diagnostics`
  const rotateMs = deps.rotateMs ?? DIAG_ROTATE_MS
  const log = deps.log ?? (() => {})

  /** 「出错自动报告给开发者」。**缺席 = 开** —— 老机器上那个文件里没有这一格。 */
  async function reportEnabled(): Promise<boolean> {
    const file = await loadAppConfigFile(appJson)
    return file.diag_report !== false
  }

  const reporter: DiagReporter = createDiagReporter({
    link: deps.link,
    enabled: reportEnabled,
    version: deps.pluginVersion,
    now: deps.now,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    log,
  })

  let lastRotateAt: number | undefined
  let lastRotate: RotateOutcome | undefined
  let rotating = false

  async function viewOf(): Promise<DiagSettingsView> {
    const file = await loadAppConfigFile(appJson)
    const link = await deps.link().catch(() => undefined)
    const counts = reporter.view()
    return {
      report_enabled: file.diag_report !== false,
      notice_seen: typeof file.diag_notice_seen_at === 'string' && file.diag_notice_seen_at !== '',
      ...(link === undefined ? {} : { relay_url: link.relayUrl }),
      sent_this_hour: counts.sent_this_hour,
      hourly_limit: counts.hourly_limit,
    }
  }

  /** 改一格开关。沿用 appConfig 那条规矩:读整份、只改这一格、原子写回,别人的键原样留着。 */
  async function patch(next: { diag_report?: boolean, diag_notice_seen_at?: string }): Promise<DiagSettingsView> {
    const file = await loadAppConfigFile(appJson)
    await saveAppConfigFile(appJson, { ...file, ...next })
    return await viewOf()
  }

  /**
   * 摆暂存树 → 压成 zip 落到 `zipFile` → 删暂存树。「导出」与「发」共用这一段 ——
   * 两条路打出来的必须是同一个包(同一份白名单、同一道脱敏)。
   */
  async function buildZip(name: string, zipFile: string): Promise<
    | { ok: true, bytes: number, entries: readonly DiagPackEntry[], skipped: readonly DiagPackSkipped[] }
    | { ok: false, error: string }
  > {
    const stageDir = `${stageRoot}/${name}`
    try {
      // 暂存目录**每次现建、用完就删**。留着的话下一次导出会把上一次的东西一起打进去。
      await io.rmrf(stageDir)
      await io.mkdirp(stageDir)
      await io.mkdirp(zipFile.slice(0, zipFile.lastIndexOf('/')))
      const stage = await stageDiagPackage({ ...deps, io }, stageDir)
      // `ditto -c -k --keepParent`:macOS 自带,压出来的 zip Finder 双击就能开。
      // `--sequesterRsrc` 让资源分叉规规矩矩地待在 __MACOSX 里,免得解压出一堆 ._ 文件。
      const zipped = await io.exec(
        ['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', stageDir, zipFile],
        { timeoutMs: ZIP_TIMEOUT_MS },
      )
      if (!zipped.ok) {
        await io.rmrf(stageDir).catch(() => {})
        return { ok: false, error: `压包失败(ditto 退出码 ${zipped.code})。${zipped.out.trim().split('\n').slice(-1)[0] ?? ''}` }
      }
      const info = await io.stat(zipFile)
      // 压完就把暂存树删掉:它是整份包的明文副本,没有理由在 ~/.dsh 里长住。
      await io.rmrf(stageDir)
      return { ok: true, bytes: info?.size ?? 0, entries: stage.entries, skipped: stage.skipped }
    }
    catch (error) {
      await io.rmrf(stageDir).catch(() => {})
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const readBytes = deps.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)))
  let sending: { view: DiagSendView, done: Promise<void> } | undefined
  let lastSend: DiagSendView | undefined

  /** 传不上去:把包从暂存处挪到桌面,回「在哪」。挪不动就原地留着(也是一个找得到的地方)。 */
  async function keep(zipFile: string, name: string): Promise<NonNullable<DiagSendView['kept']>> {
    const target = `${outDir}/${name}.zip`
    await io.mkdirp(outDir)
    const moved = await io.rename(zipFile, target)
    const file = moved.ok ? target : zipFile
    return { file, file_redacted: redactHome(file), name: `${name}.zip` }
  }

  /** 中转回的错误那一句人话(OpenAI 形状 `{ error: { message } }`);读不出来就按状态码说。 */
  async function relaySays(res: Response): Promise<string> {
    try {
      const body = await res.json() as { error?: { message?: unknown } }
      if (typeof body.error?.message === 'string' && body.error.message !== '') return body.error.message
    }
    catch { /* 回的不是 JSON */ }
    return `服务器回了 HTTP ${res.status}`
  }

  async function runSend(view: DiagSendView): Promise<void> {
    const name = packNameOf(deps.now(), deps.tzOffsetMinutes)
    const zipFile = `${stageRoot}/outbox/${name}.zip`
    const finish = (patch: Partial<DiagSendView>): void => {
      Object.assign(view, { ...patch, finished_at: new Date(deps.now()).toISOString() })
    }
    const built = await buildZip(name, zipFile)
    if (!built.ok) { finish({ state: 'failed', error: `诊断包没打出来:${built.error}` }); return }
    view.bytes = built.bytes
    const link = await deps.link().catch(() => undefined)
    if (link === undefined) {
      finish({ state: 'failed', error: '这台电脑还没登录,诊断包传不上去。', kept: await keep(zipFile, name) })
      return
    }
    let res: Response
    try {
      res = await fetchImpl(`${link.relayUrl}/v1/diag/pack`, {
        method: 'POST',
        headers: {
          'content-type': 'application/zip',
          'authorization': `Bearer ${link.token}`,
          'x-workbench-version': deps.pluginVersion,
        },
        body: await readBytes(zipFile),
        signal: AbortSignal.timeout(DIAG_SEND_TIMEOUT_MS),
      })
    }
    catch {
      finish({ state: 'failed', error: '连不上服务器,诊断包传不上去(多半是这会儿没网)。', kept: await keep(zipFile, name) })
      return
    }
    if (!res.ok) {
      finish({ state: 'failed', error: `服务器没收下这个诊断包:${await relaySays(res)}`, kept: await keep(zipFile, name) })
      return
    }
    const body = await res.json().catch(() => undefined) as { code?: unknown, expires_at?: unknown } | undefined
    if (typeof body?.code !== 'string' || body.code === '') {
      finish({ state: 'failed', error: '服务器收下了,但没回编号。', kept: await keep(zipFile, name) })
      return
    }
    // 传上去了就不留本机副本:编号就是它的下落,桌面上再多一个 zip 只会让人以为还要再发一次。
    await io.rmrf(zipFile).catch(() => {})
    finish({ state: 'done', code: body.code, ...(typeof body.expires_at === 'string' ? { expires_at: body.expires_at } : {}) })
    log(`[诊断] 发了一份诊断包(编号 ${body.code},${Math.round(built.bytes / 1024)}KB)`)
  }

  return {
    async export() {
      const name = packNameOf(deps.now(), deps.tzOffsetMinutes)
      const zipFile = `${outDir}/${name}.zip`
      const built = await buildZip(name, zipFile)
      if (!built.ok) return built
      const revealed = (await io.exec(['open', '-R', zipFile], { timeoutMs: 15_000 })).ok
      log(`[诊断] 导出了一份诊断包(${built.entries.length} 项,${Math.round(built.bytes / 1024)}KB)`)
      return {
        ok: true as const,
        file: zipFile,
        file_redacted: redactHome(zipFile),
        bytes: built.bytes,
        entries: built.entries,
        skipped: built.skipped,
        revealed,
      }
    },

    settings: viewOf,
    setReportEnabled: enabled => patch({ diag_report: enabled }),
    markNoticeSeen: () => patch({ diag_notice_seen_at: new Date(deps.now()).toISOString() }),
    report: event => reporter.report(event),

    pump() {
      reporter.pump()
      if (rotating) return
      const at = deps.now()
      if (lastRotateAt !== undefined && at - lastRotateAt < rotateMs) return
      lastRotateAt = at
      rotating = true
      // fire-and-forget:收拾日志慢不慢都不该拖住 /state(同 setup.pump)。
      void rotateDiagLogs({ io, paths, now: deps.now, tzOffsetMinutes: deps.tzOffsetMinutes })
        .then((out) => {
          lastRotate = out
          for (const item of out.rotated) log(`[诊断] 日志轮转:${item.to}`)
          for (const item of out.removed) log(`[诊断] 删掉老日志:${item.file}(${item.why})`)
        })
        .catch(() => {})
        .finally(() => { rotating = false })
    },

    lastRotate: () => lastRotate,

    send() {
      if (sending !== undefined && sending.view.state === 'running') return { ...sending.view }
      const view: DiagSendView = {
        id: `send-${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        state: 'running',
        started_at: new Date(deps.now()).toISOString(),
      }
      lastSend = view
      const done = runSend(view).catch((error: unknown) => {
        Object.assign(view, {
          state: 'failed',
          error: `诊断包没发出去:${error instanceof Error ? error.message : String(error)}`,
          finished_at: new Date(deps.now()).toISOString(),
        })
      })
      sending = { view, done }
      return { ...view }
    },
    sendView: () => (lastSend === undefined ? undefined : { ...lastSend }),
    waitSend: async (id) => { if (sending?.view.id === id) await sending.done },
  }
}

/** 路径里的用户名换掉(写进交接、显示在手机上用这一份)。 */
function redactHome(file: string): string {
  return file.replace(/\/Users\/[^/]+/, '/Users/<用户>')
}

/** 四类事件的组件名,给调用方一个不用 import 整个 diag.ts 的快捷方式。 */
export type { DiagComponent, DiagEvent }

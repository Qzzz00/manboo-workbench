/**
 * 场景(spec §3/W5/W6):命名的窗口布局清单,单 Space+隐藏其他。
 *
 * 落盘 ~/.dsh/workbench/scenes.json,原子写与容错读照抄 projects.ts 的先例。
 * 保存/恢复的编排都在这里(TS 可测),壳只执行原语。
 * 恢复报告逐应用给成败,绝不整体假装成功(D13)。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HelperRect, SceneView } from '../protocol.ts'
import type { AppsRegistry } from './appsRegistry.ts'
import type { HelperChannel } from './helperChannel.ts'
import { APP_BUNDLES, ensureRunning, ensureRunningWith, isRunning } from './activation.ts'

export interface StoredSceneApp { app: string, bundle_id: string, windows: { frame: HelperRect }[] }
export interface StoredScene { id: string, name: string, apps: StoredSceneApp[], saved_at?: string }
export interface ScenesFile { version: 1, scenes: StoredScene[] }
export interface RestoreEntry { app: string, ok: boolean, reason?: string }
export interface RestoreReport { ok: boolean, apps: RestoreEntry[], reason?: string }

/** 场景名册 = APP_BUNDLES 的 8 个应用。保存只枚举名册,隐藏也只碰名册——Finder/DSH 等无关应用永远不动(W5)。 */
const SCENE_ROSTER = Object.keys(APP_BUNDLES)

export function defaultScenesFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/scenes.json`
}

/**
 * 新装/重置后一个场景都没有(2026-09-20 Ben 定,见 docs/决策记录.md「去掉预置场景」)。
 *
 * W6 原来在这里预置「干活」「沟通」两条**空**场景,等首次手排后保存。真机上它们从来没被
 * 填过:第一次进来看见两个名字、点「恢复」还是禁用的,既不知道那是什么,也不知道该往里
 * 放什么。Ben 的原话:「那两个所谓的『预置』从默认布局里删掉吧,反而是要提醒用户把常用的
 * 应用自己拖进来。」于是这里改成空清单,那句提醒交给界面的空态机制
 * (client/emptyState.ts 的 slot 那一支 + SceneBar 的空清单提示)。
 */
export function emptyScenesFile(): ScenesFile {
  return { version: 1, scenes: [] }
}

/**
 * 2026-09-20 之前装机时落下的那两条空预置的签名(id 与名字都得对得上)。
 *
 * 为什么连名字一起认、而不是只认 id:`work` / `talk` 这两个 id 用户改过名之后照旧用着
 * (rename 只改 name),那时候它已经是**他自己的场景**了,不能替他藏起来。
 */
const LEGACY_PRESETS: readonly { id: string, name: string }[] = [
  { id: 'work', name: '干活' },
  { id: 'talk', name: '沟通' },
]

/**
 * 这份清单是不是「只剩旧预置的残留」——每一条都对得上签名,而且一条都没存过内容。
 *
 * 只在**读**的时候当作没有,**绝不回写**:用户手动存过的场景一条都不动(哪怕他存进去的
 * 正好是 `work` 那一条 —— 那时 apps 非空,这里就不成立)。下一次真有写操作(create /
 * rename / remove / save)落盘的自然是「当作没有」之后的清单,残留顺手消失。
 */
function isLegacyPresetLeftover(scenes: readonly StoredScene[]): boolean {
  if (scenes.length === 0) return false
  return scenes.every((scene) => {
    const nothingSaved = !Array.isArray(scene.apps) || scene.apps.length === 0
    return nothingSaved && LEGACY_PRESETS.some(preset => preset.id === scene.id && preset.name === scene.name)
  })
}

export async function loadScenesFile(file: string): Promise<ScenesFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return emptyScenesFile()
  }
  try {
    const parsed = JSON.parse(text) as Partial<ScenesFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.scenes)) return emptyScenesFile()
    if (isLegacyPresetLeftover(parsed.scenes)) return emptyScenesFile()
    return { version: 1, scenes: parsed.scenes }
  }
  catch {
    return emptyScenesFile() // 写坏了按空清单兜底,先例见 projects.ts loadProjectsFile。
  }
}

export async function saveScenesFile(file: string, data: ScenesFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

export interface ScenesServiceOptions {
  file: string
  helper: Pick<HelperChannel, 'request'>
  runCommand: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  sleep: (ms: number) => Promise<void>
  now?: () => number
  /** 应用清单(spec S4)。传了:名册=registry.list()(基础八应用+自定义),否则退回 SCENE_ROSTER。 */
  registry?: Pick<AppsRegistry, 'list' | 'commandFor' | 'bundleFor'>
  /**
   * 程序化激活抑制(2026-09-09,dock.ts ACTIVATE_SUPPRESS_MS):restore 逐应用激活之前调一次,
   * index.ts 接成 dock.noteActivated——场景恢复也是我们自己发起的激活,已认领的应用被唤起后
   * 自摆到槽外不该被当拖出除名。可选:不传就是老行为。
   */
  onBeforeActivate?: (app: string) => Promise<void>
}

export interface ScenesService {
  list(): Promise<SceneView[]>
  save(id: string): Promise<{ ok: boolean, reason?: string }>
  create(name: string): Promise<{ ok: boolean, id?: string, reason?: string }>
  rename(id: string, name: string): Promise<boolean>
  remove(id: string): Promise<boolean>
  restore(id: string): Promise<RestoreReport>
}

interface AppInfo { running: boolean, hidden: boolean, windows: { index: number, frame: HelperRect }[] }

const WINDOW_WAIT_TRIES = 10
const WINDOW_WAIT_MS = 500

export function createScenesService(opts: ScenesServiceOptions): ScenesService {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))

  // 写队列,先例见 projectsService:load→改→save 不排队会丢更新。
  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async function appInfo(bundleId: string): Promise<AppInfo> {
    return await opts.helper.request({ op: 'app_info', bundle_id: bundleId }) as unknown as AppInfo
  }

  /** 名册(spec S4):有 registry 就是它的 list()(基础八应用+自定义),没有就是原来的 SCENE_ROSTER。 */
  async function rosterKeys(): Promise<readonly string[]> {
    if (opts.registry === undefined) return SCENE_ROSTER
    const apps = await opts.registry.list()
    return apps.map(a => a.key)
  }

  /** 激活闭环(spec S4):有 registry 就连自定义应用一起走 ensureRunningWith,没有就是原来的 ensureRunning。 */
  async function ensureRunningForApp(app: string): Promise<{ ok: boolean, reason?: string }> {
    if (opts.registry !== undefined) {
      const [cmd, bundleId] = await Promise.all([opts.registry.commandFor(app), opts.registry.bundleFor(app)])
      if (cmd === undefined || bundleId === undefined) return { ok: false, reason: `不认识这个应用:${app}` }
      return ensureRunningWith(cmd, bundleId, { runCommand: opts.runCommand, sleep: opts.sleep })
    }
    return ensureRunning(app, { runCommand: opts.runCommand, sleep: opts.sleep })
  }

  return {
    async list(): Promise<SceneView[]> {
      const data = await loadScenesFile(opts.file)
      return data.scenes.map(scene => ({
        id: scene.id,
        name: scene.name,
        app_count: scene.apps.length,
        ...(scene.saved_at === undefined ? {} : { saved_at: scene.saved_at }),
      }))
    },

    save(id: string): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadScenesFile(opts.file)
        const scene = data.scenes.find(s => s.id === id)
        if (scene === undefined) return { ok: false, reason: '没有这个场景' }

        const apps: StoredSceneApp[] = []
        for (const app of await rosterKeys()) {
          const bundleId = opts.registry !== undefined ? await opts.registry.bundleFor(app) : APP_BUNDLES[app] as string
          if (bundleId === undefined) continue // registry 名册里的键理论上总能解出 bundle id,防御性跳过。
          let info: AppInfo
          try {
            info = await appInfo(bundleId)
          }
          catch (error) {
            // helper 未接入/未授权:整个保存动作失败并透传原因,不落半份数据。
            return { ok: false, reason: error instanceof Error ? error.message : String(error) }
          }
          if (info.running && !info.hidden && info.windows.length > 0) {
            apps.push({ app, bundle_id: bundleId, windows: info.windows.map(w => ({ frame: w.frame })) })
          }
        }
        if (apps.length === 0) {
          return { ok: false, reason: '当前没有可保存的窗口(名册内应用都没开),拒绝把场景覆盖成空' }
        }
        scene.apps = apps
        scene.saved_at = new Date(now() * 1000).toISOString()
        await saveScenesFile(opts.file, data)
        return { ok: true }
      })
    },

    create(name: string): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const trimmed = name.trim()
        if (trimmed === '') return { ok: false, reason: '场景名不能为空' }
        const data = await loadScenesFile(opts.file)
        if (data.scenes.some(s => s.name === trimmed)) return { ok: false, reason: `已有同名场景:${trimmed}` }
        const id = `s-${randomUUID().slice(0, 8)}`
        data.scenes.push({ id, name: trimmed, apps: [] })
        await saveScenesFile(opts.file, data)
        return { ok: true, id }
      })
    },

    rename(id: string, name: string): Promise<boolean> {
      return enqueueWrite(async () => {
        const trimmed = name.trim()
        if (trimmed === '') return false
        const data = await loadScenesFile(opts.file)
        const scene = data.scenes.find(s => s.id === id)
        if (scene === undefined) return false
        scene.name = trimmed
        await saveScenesFile(opts.file, data)
        return true
      })
    },

    remove(id: string): Promise<boolean> {
      return enqueueWrite(async () => {
        const data = await loadScenesFile(opts.file)
        const before = data.scenes.length
        data.scenes = data.scenes.filter(s => s.id !== id)
        if (data.scenes.length === before) return false
        await saveScenesFile(opts.file, data)
        return true
      })
    },

    async restore(id: string): Promise<RestoreReport> {
      const data = await loadScenesFile(opts.file)
      const scene = data.scenes.find(s => s.id === id)
      if (scene === undefined) return { ok: false, apps: [], reason: '没有这个场景' }
      if (scene.apps.length === 0) {
        return { ok: false, apps: [], reason: '场景还没保存过内容——先手排好窗口,点「覆盖保存」' }
      }

      const report: RestoreEntry[] = []

      // 1) 逐应用复原:激活→取消隐藏→等窗→按序摆位→置前。单应用失败不拖垮其余。
      for (const stored of scene.apps) {
        try {
          await opts.onBeforeActivate?.(stored.app)
          const activated = await ensureRunningForApp(stored.app)
          if (!activated.ok) {
            report.push({ app: stored.app, ok: false, reason: activated.reason ?? '激活失败' })
            continue
          }
          await opts.helper.request({ op: 'unhide_app', bundle_id: stored.bundle_id })

          let info = await appInfo(stored.bundle_id)
          for (let i = 0; i < WINDOW_WAIT_TRIES && info.windows.length === 0; i++) {
            await opts.sleep(WINDOW_WAIT_MS)
            info = await appInfo(stored.bundle_id)
          }
          const placeable = Math.min(stored.windows.length, info.windows.length)
          for (let i = 0; i < placeable; i++) {
            await opts.helper.request({
              op: 'set_window_frame',
              bundle_id: stored.bundle_id,
              index: i,
              frame: (stored.windows[i] as { frame: HelperRect }).frame,
            })
          }
          if (placeable > 0) await opts.helper.request({ op: 'raise_window', bundle_id: stored.bundle_id, index: 0 })

          if (placeable === stored.windows.length) {
            report.push({ app: stored.app, ok: true })
          }
          else {
            report.push({
              app: stored.app,
              ok: false,
              reason: `窗口数不符:存了 ${stored.windows.length} 个,现在只有 ${info.windows.length} 个,已尽力摆`,
            })
          }
        }
        catch (error) {
          report.push({ app: stored.app, ok: false, reason: error instanceof Error ? error.message : String(error) })
        }
      }

      // 2) 隐藏「属于其他场景、不属于本场景」且在运行的应用(W5);无关应用永远不动。
      const mine = new Set(scene.apps.map(a => a.bundle_id))
      const others = new Map<string, string>() // bundle_id → app 键
      for (const other of data.scenes) {
        if (other.id === scene.id) continue
        for (const a of other.apps) {
          if (!mine.has(a.bundle_id)) others.set(a.bundle_id, a.app)
        }
      }
      for (const [bundleId, app] of others) {
        try {
          if (await isRunning(bundleId, opts.runCommand)) {
            await opts.helper.request({ op: 'hide_app', bundle_id: bundleId })
          }
        }
        catch (error) {
          report.push({ app: `隐藏 ${app}`, ok: false, reason: error instanceof Error ? error.message : String(error) })
        }
      }

      return { ok: report.every(entry => entry.ok), apps: report }
    },
  }
}

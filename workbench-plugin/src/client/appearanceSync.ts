/**
 * Mac 端的外观同步(2026-09-16,决策记录同日第 1 条「外观配置一份两端共用」;同日「外观首次播种」)。
 *
 * particleSettingsStore 仍然只认 localStorage——这层站在它旁边:
 * - 启动先 GET /butler/appearance:
 *   · 有 → 以服务端为准:preset 与 icon 都写进 store 并落 localStorage;本地原来有一份且不一样,
 *     就在外观设置里提示一次「已改用 Mac 上保存的外观(版本 n)」;
 *   · 404「还没有保存过外观」→ 本地 localStorage 有**合法的**一份(store.stored,parseTuningPreset /
 *     normalizeTuning 通过)就立刻 PUT 一次把它播上去(带 icon 与自定义 SVG),成功后本地记 seededVersion;
 *     同一份本会话里不重复播。本地没存过就**不推**——核心默认值不占服务端,手机照旧用自己的默认;
 *   · 连不上 → 什么都不做,本地照旧,不报错。
 * - 订阅 store:preset 或 icon 变了(调参 / 导入 / 恢复默认 / 选图标)防抖 1 秒 PUT 一次;失败静默,下次改了再推。
 * - /state.appearance_version 变了(不是自己刚推上去的那版)就重新拉。
 *
 * 不碰 ParticleOrb / particleScene / ParticleSettings(「粒子性能与清晰度」那张卡在改它们)。
 */
import { useEffect } from 'react'
import type { ParticleSettingsStore } from './particleSettingsStore.ts'

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>

/** 上一次把本地那份播到服务端时拿到的版本号。只是记录(给排查看),播不播看的是「这份推过没有」。 */
export const SEEDED_STORAGE_KEY = 'butler-swarm-v4:seeded'
const NOTICE = (version: number): string => `已改用 Mac 上保存的外观(版本 ${version})`

export interface AppearanceSyncOptions {
  store: ParticleSettingsStore
  baseUrl: string
  fetchImpl: typeof fetch
  storage?: StoragePort | undefined
  /** 缺省 1000 毫秒。 */
  debounceMs?: number
}

export interface AppearanceSync {
  /** 拉一次服务端;404 且本地有合法的一份时把它播上去。永不抛。 */
  start: () => Promise<void>
  /** /state.appearance_version 的最新值。与已知版本不同(且不是自己刚推的)就重新拉。 */
  notice: (version: number | undefined) => void
  /** 已知的服务端版本号(拉到的或刚推上去的)。 */
  version: () => number | undefined
  stop: () => void
}

/** 与服务端对齐用的指纹:preset 与 icon 一起算,任一变了都要推。 */
const fingerprint = (store: ParticleSettingsStore): string => {
  const { preset, icon } = store.getSnapshot()
  return JSON.stringify({ preset, icon: icon ?? null })
}

/** PUT 的 body:preset 必带,icon 选过才带(服务端把 undefined / '' 都当没有)。 */
const requestBody = (store: ParticleSettingsStore): string => {
  const { preset, icon } = store.getSnapshot()
  return JSON.stringify(icon === undefined ? { preset } : { preset, icon })
}

export function createAppearanceSync(options: AppearanceSyncOptions): AppearanceSync {
  const { store, baseUrl, fetchImpl, storage } = options
  const debounceMs = options.debounceMs ?? 1000
  const url = `${baseUrl}/butler/appearance`
  let known: number | undefined
  /** 上一次与服务端对齐过的那份(拉到的或推上去的),用来判断「变了没」。 */
  let aligned = ''
  /** 本会话里播上去过的那份:服务端再回 404 也不重复播同一份。 */
  let seeded = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 正在把服务端那份写进 store:订阅回调此时看到的变化不是用户调参,不排推送。 */
  let applying = false
  let stopped = false
  let unsubscribe: (() => void) | undefined

  const remember = (key: string, value: string): void => {
    try { storage?.setItem(key, value) } catch { /* 浏览器不让存:store 自己也会报,这里不重复 */ }
  }

  const push = async (seeding = false): Promise<void> => {
    if (stopped) return
    const text = fingerprint(store)
    if (text === aligned) return
    try {
      const res = await fetchImpl(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: requestBody(store) })
      if (!res.ok) return
      const body = await res.json() as { version?: unknown }
      if (typeof body.version === 'number') {
        known = body.version
        if (seeding) remember(SEEDED_STORAGE_KEY, String(body.version))
      }
      aligned = text
      if (seeding) seeded = text
    }
    catch {
      // 推不上去就算了:本地已经存好,下次调参再试。
    }
  }

  const schedule = (): void => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void push() }, debounceMs)
  }

  /** 正在拉的那一次:两个 ButlerInbox(普通 / 纯净)同时收到同一个版本号,只拉一次。 */
  let inflight: Promise<void> | undefined
  const pull = (): Promise<void> => {
    if (inflight === undefined) inflight = pullOnce().finally(() => { inflight = undefined })
    return inflight
  }

  const pullOnce = async (): Promise<void> => {
    if (stopped) return
    try {
      const res = await fetchImpl(url)
      if (stopped) return
      if (res.status === 404) {
        // 只认「还没有保存过外观」;「外观同步未接线」推了也是 404,不白推。
        const body = await res.json().catch(() => undefined) as { error?: unknown } | undefined
        if (body?.error !== '还没有保存过外观') return
        // 服务端还没存过:本地保存过的那份才是真相,播上去;只是默认值就不占位。
        if (!store.getSnapshot().stored) return
        if (fingerprint(store) === seeded) return
        aligned = ''
        await push(true)
        return
      }
      if (!res.ok) return
      const doc = await res.json() as { version?: unknown, preset?: unknown, icon?: unknown }
      if (stopped || typeof doc.version !== 'number' || doc.preset === undefined) return
      const own = doc.version === known
      known = doc.version
      const before = store.getSnapshot()
      const icon = typeof doc.icon === 'string' && doc.icon !== '' ? doc.icon : undefined
      const incoming = JSON.stringify({ preset: doc.preset, icon: icon ?? null })
      const differs = incoming !== fingerprint(store)
      if (differs || !before.stored) {
        // 本地原来有一份、和服务端的不一样、也不是自己刚推的:提示一次。没存过就是直接用,谈不上「改用」。
        const message = differs && before.stored && !own ? NOTICE(doc.version) : ''
        applying = true
        try { store.synchronize(JSON.stringify(doc.preset), { icon, message, persist: true }) }
        finally { applying = false }
      }
      // 以归一化之后 store 里那份为准——服务端存的可能是没归一化的,别因为格式差异又推回去。
      aligned = fingerprint(store)
    }
    catch {
      // 连不上、回的不是 JSON、测试里的假 fetch:本地照旧,不报错。
    }
  }

  return {
    async start() {
      if (unsubscribe === undefined) {
        unsubscribe = store.subscribe(() => {
          if (!applying && fingerprint(store) !== aligned) schedule()
        })
      }
      await pull()
    },
    notice(version) {
      if (stopped || version === undefined || version === known) return
      if (timer !== undefined) return // 自己正要推:推完版本自然就对上了
      void pull()
    },
    version: () => known,
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}

const shared = new Map<string, AppearanceSync>()

/** 同一个工作台地址只起一份同步(普通模式与纯净模式各有一个 ButlerInbox,共用一个 store)。 */
export function getAppearanceSync(options: AppearanceSyncOptions): AppearanceSync {
  const existing = shared.get(options.baseUrl)
  if (existing !== undefined) return existing
  let storage: StoragePort | undefined = options.storage
  if (storage === undefined) {
    try { storage = window.localStorage } catch { /* sandbox can deny persistence */ }
  }
  const sync = createAppearanceSync({ ...options, storage })
  shared.set(options.baseUrl, sync)
  void sync.start()
  return sync
}

/** 给 ButlerInbox 接的钩子:起同步,并把 /state.appearance_version 喂给它。 */
export function useAppearanceSync(options: AppearanceSyncOptions, version: number | undefined): void {
  useEffect(() => { getAppearanceSync(options).notice(version) }, [options.baseUrl, options.store, version]) // eslint-disable-line react-hooks/exhaustive-deps
}

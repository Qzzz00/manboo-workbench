import { useEffect, useSyncExternalStore } from 'react'
import { BuiltinGlyphCache, TUNING_DEFAULTS, TUNING_STORAGE_KEY, normalizeTuning, parseTuningPreset, sampleImportedSVG, sanitizeParticleSVG, type TuningPreset } from './swarm/core.js'
import type { ParticlePreview } from './ParticleOrb.tsx'
import { QUALITY_FLOOR, applyQuality } from './particleScene.ts'

/** Runtime quality: `tier` is decided by frame timing (never persisted); only the manual performance mode is saved. */
export interface ParticleQuality { tier: number; performanceMode: boolean }
export const QUALITY_STORAGE_KEY = 'butler-swarm-v4:quality'
interface ParticleSettingsState {
  preset: TuningPreset; paused: boolean; preview: ParticlePreview | undefined; error: string; message: string
  /** 当前画质档位与性能模式(2026-09-16):档位只作用于渲染有效值,不进 preset,也不同步到服务端。 */
  quality: ParticleQuality
  /** 选中的内置图标 id(2026-09-16 外观首次播种):随 preset 一起落本地、PUT / 拉服务端。没选过就缺省。 */
  icon: string | undefined
  /**
   * preset 是不是「本地保存过的」(localStorage 里有合法的一份,或本次会话里调过参 / 拉到过服务端的),
   * 而不是编出来的核心默认值。外观同步据此决定 404 时要不要把本地推上去——默认值不占服务端。
   */
  stored: boolean
}
/** 与 preset 分开存:preset 的 v1 结构由 parseTuningPreset 严格收口,图标 id 不能混进去。 */
export const ICON_STORAGE_KEY = 'butler-swarm-v4:icon'
/** 与服务端 src/server/appearance.ts 的 ICON_PATTERN 同一条。 */
const ICON_ID = /^[a-z0-9-]{1,64}$/
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const defaults = (): TuningPreset => ({ kind: 'butler-swarm-v4', version: 1, settings: { ...TUNING_DEFAULTS }, svg: '', fill: false })
export interface SynchronizeOptions {
  /** 给了这个键就以它为准(undefined 表示服务端没有选中图标,本地也清掉)。 */
  icon?: string | undefined
  /** 顺带给外观设置一行提示(比如「已改用 Mac 上保存的外观(版本 n)」)。 */
  message?: string
  /** 同时写回 localStorage(从服务端拉下来的那份要落本地;跨窗口 storage 事件来的那份本来就在本地,不用)。 */
  persist?: boolean
}
export function createParticleSettingsStore(storage?: StoragePort) {
  let preset = defaults(), initialError = '', stored = false, icon: string | undefined, performanceMode = false
  try {
    const raw = storage?.getItem(TUNING_STORAGE_KEY)
    if (raw) { preset = parseTuningPreset(raw); if (preset.svg) preset.svg = sanitizeParticleSVG(preset.svg); stored = true }
  } catch { initialError = '保存的粒子配置无法读取；原文件未覆盖，可重新导入。' }
  try { const raw = storage?.getItem(ICON_STORAGE_KEY); if (raw && ICON_ID.test(raw)) icon = raw } catch { /* 读不到就当没选过 */ }
  try { performanceMode = (JSON.parse(storage?.getItem(QUALITY_STORAGE_KEY) ?? 'null') as { performanceMode?: unknown } | null)?.performanceMode === true } catch { /* keep automatic quality */ }
  let snapshot: ParticleSettingsState = { preset, paused: false, preview: undefined, error: initialError, message: '', icon, stored, quality: { tier: performanceMode ? QUALITY_FLOOR : 0, performanceMode } }, version = 0
  const listeners = new Set<() => void>(), cache = new BuiltinGlyphCache()
  let effective: { settings: TuningPreset['settings']; tier: number; result: TuningPreset['settings'] } | undefined
  const publish = (next: Partial<ParticleSettingsState>, persist = false) => {
    snapshot = { ...snapshot, ...next }
    if (persist) {
      snapshot = { ...snapshot, stored: true }
      try { storage?.setItem(TUNING_STORAGE_KEY, JSON.stringify(snapshot.preset)) } catch { snapshot = { ...snapshot, error: '浏览器未能保存配置；可导出 JSON 备份。' } }
    }
    listeners.forEach(listener => listener())
  }
  /** Any re-tuning restarts the automatic quality evaluation from the full tier; the manual lock, icon and stored flag are untouched. */
  const retune = (next: Partial<ParticleSettingsState>, persist = false) => publish({ ...next, quality: snapshot.quality.performanceMode ? snapshot.quality : { tier: 0, performanceMode: false } }, persist)
  const persistIcon = (id: string | undefined) => { try { storage?.setItem(ICON_STORAGE_KEY, id ?? '') } catch { /* 存不下就只活在内存里;preset 那边已经报过存不了 */ } }
  const fail = (error: unknown) => publish({ error: error instanceof Error ? error.message : '导入失败，保留原配置。', message: '' })
  const importText = async (read: () => Promise<string>, kind: 'svg' | 'json', fill = snapshot.preset.fill) => {
    const op = ++version
    try {
      const text = await read()
      if (op !== version) return
      const incoming = kind === 'json' ? parseTuningPreset(text) : { ...snapshot.preset, svg: text, fill }
      let preview: ParticlePreview | undefined, message = '配置已导入'
      if (incoming.svg) {
        const result = await sampleImportedSVG(incoming.svg, { fill: incoming.fill })
        if (op !== version) return
        incoming.svg = result.svg
        preview = { mode: 'custom', glyph: result.glyph, label: 'SVG 动效预览' }
        message = result.warnings.join('；') || 'SVG 已导入 · 动效预览'
      }
      if (op === version) retune({ preset: incoming, preview, error: '', message }, true)
    } catch (error) { if (op === version) fail(error) }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setField(key: string, value: number) { version++; retune({ preset: { ...snapshot.preset, settings: normalizeTuning({ ...snapshot.preset.settings, [key]: value }) }, error: '' }, true) },
    setPaused(paused: boolean) { version++; publish({ paused }) },
    reset() { version++; retune({ preset: defaults(), preview: undefined, error: '', message: '已恢复默认' }, true) },
    /** Frame-timing verdict from the running orb. Ignored while the manual performance mode holds the floor. */
    reportTier(tier: number) {
      if (snapshot.quality.performanceMode || tier === snapshot.quality.tier) return
      publish({ quality: { tier: Math.max(0, Math.min(QUALITY_FLOOR, Math.round(tier))), performanceMode: false } })
    },
    /**
     * 「恢复完整画质」:立刻把渲染交回用户那 24 项,并让自动评估从头开始(性能模式也一并解除)。
     * 对不懂代码的人来说这颗按钮只有一个意思——现在就画全。
     */
    restoreQuality() {
      publish({ quality: { tier: 0, performanceMode: false } })
      try { storage?.setItem(QUALITY_STORAGE_KEY, JSON.stringify({ performanceMode: false })) } catch { /* 存不下也已经恢复了 */ }
    },
    setPerformanceMode(performanceMode: boolean) {
      publish({ quality: { tier: performanceMode ? QUALITY_FLOOR : 0, performanceMode } })
      try { storage?.setItem(QUALITY_STORAGE_KEY, JSON.stringify({ performanceMode })) } catch { /* the lock still applies for this session */ }
    },
    /** The values the renderer receives: user settings with the current tier applied. Stable identity per (settings, tier). */
    effectiveSettings() {
      const { settings } = snapshot.preset, { tier } = snapshot.quality
      if (!effective || effective.settings !== settings || effective.tier !== tier) effective = { settings, tier, result: tier > 0 ? applyQuality(settings, tier) : settings }
      return effective.result
    },
    preview(preview: ParticlePreview | undefined) { version++; publish({ preview, error: '', message: '' }) },
    async selectIcon(id: string) {
      const op = ++version
      try {
        const result = await cache.get(id)
        if (op !== version) return
        // 选中即记住(2026-09-16):图标 id 落本地并随 preset 同步到服务端;预览照旧只是动效预览。
        const chosen = ICON_ID.test(id) ? id : snapshot.icon
        if (chosen !== snapshot.icon) persistIcon(chosen)
        publish({ preview: { mode: /^phone(?:-|$)/.test(id) ? 'calling' : 'builtin', ...(/^phone(?:-|$)/.test(id) ? { notice: 'confirmation' as const } : {}), glyph: result.glyph, label: `图标 ${id} · 动效预览` }, error: '', message: result.warnings.join('；'), icon: chosen })
      }
      catch (error) { if (op === version) fail(error) }
    },
    importText,
    async importFile(file: File, kind: 'svg' | 'json') {
      if (file.size > (kind === 'svg' ? 262144 : 400000)) { version++; fail(new Error(kind === 'svg' ? 'SVG 文件不能超过 256KB。' : '配置文件过大（上限 400 KB）。')); return }
      await importText(() => file.text(), kind)
    },
    setFill(fill: boolean) {
      if (snapshot.preset.svg) return importText(async () => snapshot.preset.svg, 'svg', fill)
      version++; publish({ preset: { ...snapshot.preset, fill } }, true)
    },
    synchronize(raw: string | null, options: SynchronizeOptions = {}) {
      if (!raw) return
      version++
      try {
        const next = parseTuningPreset(raw); if (next.svg) next.svg = sanitizeParticleSVG(next.svg)
        const patch: Partial<ParticleSettingsState> = { preset: next, preview: undefined, error: '', message: options.message ?? '' }
        if ('icon' in options) {
          const icon = options.icon !== undefined && ICON_ID.test(options.icon) ? options.icon : undefined
          if (icon !== snapshot.icon) persistIcon(icon)
          patch.icon = icon
        }
        retune(patch, options.persist === true)
      } catch (error) { fail(error) }
    },
    exportText: () => JSON.stringify(snapshot.preset, null, 2),
  }
}
export type ParticleSettingsStore = ReturnType<typeof createParticleSettingsStore>
let shared: ParticleSettingsStore | undefined
export function getParticleSettingsStore(): ParticleSettingsStore {
  if (!shared) {
    let storage: Storage | undefined
    try { storage = window.localStorage } catch { /* sandbox can deny persistence */ }
    shared = createParticleSettingsStore(storage)
  }
  return shared
}
export function useParticleSettings(store = getParticleSettingsStore()) {
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === TUNING_STORAGE_KEY) store.synchronize(event.newValue) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [store])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

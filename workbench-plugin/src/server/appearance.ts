/**
 * 事务官外观的真相源(2026-09-16,决策记录同日第 1 条「外观配置一份两端共用」)。
 *
 * 在此之前粒子的 24 项调参只活在 Mac 浏览器的 localStorage 里,手机端拿不到。现在落
 * `~/.dsh/workbench/appearance.json`:Mac 端调参即 PUT(防抖 1 秒),手机启动 GET 直接用;
 * 版本号进 /state.appearance_version,变了前端就重新拉。
 *
 * 这里**只做结构校验**,不引入浏览器里那份 swarm 核心(它要 document / DOMParser):
 * 24 项调参的范围收口由两端的 normalizeTuning 做,SVG 的净化由两端的 sanitizeParticleSVG 做
 * (Mac 存之前净化过一遍,手机拿到再净化一遍——服务端不解析 SVG,不猜它安不安全)。
 *
 * 纪律:没文件就是「没存过」(GET 404),不摆一份编出来的默认值;坏文件当没有、不覆盖;
 * 落盘走临时文件 + rename;不删任何东西。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AppearancePreset {
  kind: 'butler-swarm-v4'
  version: 1
  settings: Record<string, number>
  svg: string
  fill: boolean
}

export interface AppearanceDoc {
  /** 从 1 起,每次 PUT 加一;/state.appearance_version 就是它。 */
  version: number
  updated_at: string
  preset: AppearancePreset
  /** 选中的内置图标 id(留位:Mac 端今天的图标选择只是动效预览,还没有持久化的「选中」)。 */
  icon?: string
}

export type AppearanceValidation =
  | { ok: true, preset: AppearancePreset, icon?: string }
  | { ok: false, error: string }

const MAX_SVG = 262144
const MAX_SETTINGS = 64
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/
const ICON_PATTERN = /^[a-z0-9-]{1,64}$/

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** PUT body → 合法的 preset(+ icon),或一句人话。 */
export function validateAppearanceInput(raw: unknown): AppearanceValidation {
  const body = asRecord(raw)
  const preset = asRecord(body?.preset)
  if (preset === undefined) return { ok: false, error: 'body 要有 preset(从粒子外观导出的那份配置)' }
  if (preset.kind !== 'butler-swarm-v4' || preset.version !== 1) return { ok: false, error: 'preset 要是 butler-swarm-v4 v1 的配置' }
  const settings = asRecord(preset.settings)
  if (settings === undefined) return { ok: false, error: 'preset.settings 要是对象' }
  const entries = Object.entries(settings)
  if (entries.length > MAX_SETTINGS) return { ok: false, error: `preset.settings 最多 ${MAX_SETTINGS} 项` }
  const clean: Record<string, number> = {}
  for (const [key, value] of entries) {
    if (!KEY_PATTERN.test(key)) return { ok: false, error: `preset.settings 的键「${key}」不合法` }
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `preset.settings.${key} 必须是有限数值` }
    clean[key] = value
  }
  const svg = preset.svg === undefined ? '' : preset.svg
  if (typeof svg !== 'string') return { ok: false, error: 'preset.svg 要是字符串' }
  if (svg.length > MAX_SVG) return { ok: false, error: 'preset.svg 里的 SVG 过大(上限 256KB)' }
  const fill = preset.fill === true
  let icon: string | undefined
  if (body?.icon !== undefined && body.icon !== null && body.icon !== '') {
    if (typeof body.icon !== 'string' || !ICON_PATTERN.test(body.icon)) return { ok: false, error: 'icon 要是内置图标 id(小写字母、数字、连字符)' }
    icon = body.icon
  }
  return { ok: true, preset: { kind: 'butler-swarm-v4', version: 1, settings: clean, svg, fill }, ...(icon === undefined ? {} : { icon }) }
}

export interface AppearanceService {
  load: () => Promise<void>
  get: () => AppearanceDoc | undefined
  version: () => number | undefined
  put: (raw: unknown) => Promise<{ ok: true, doc: AppearanceDoc } | { ok: false, error: string }>
}

export interface AppearanceServiceOptions {
  /** ~/.dsh/workbench/appearance.json */
  file: string
  now?: () => Date
}

export function defaultAppearanceFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/appearance.json`
}

export function createAppearanceService(options: AppearanceServiceOptions): AppearanceService {
  const now = options.now ?? (() => new Date())
  let doc: AppearanceDoc | undefined
  let queue: Promise<unknown> = Promise.resolve()

  async function save(next: AppearanceDoc): Promise<void> {
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(tmp, options.file)
  }

  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(options.file, 'utf8'))
        const record = asRecord(parsed)
        const checked = validateAppearanceInput({ preset: record?.preset, icon: record?.icon })
        if (!checked.ok || typeof record?.version !== 'number' || !Number.isInteger(record.version) || record.version < 1) { doc = undefined; return }
        doc = {
          version: record.version,
          updated_at: typeof record.updated_at === 'string' ? record.updated_at : now().toISOString(),
          preset: checked.preset,
          ...(checked.icon === undefined ? {} : { icon: checked.icon }),
        }
      }
      catch {
        // 没文件或读不出来:就是「没存过」。不覆盖坏文件——那可能是 Ben 手改到一半。
        doc = undefined
      }
    },
    get: () => doc,
    version: () => doc?.version,
    put(raw) {
      const run = queue.then(async () => {
        const checked = validateAppearanceInput(raw)
        if (!checked.ok) return checked
        const next: AppearanceDoc = {
          version: (doc?.version ?? 0) + 1,
          updated_at: now().toISOString(),
          preset: checked.preset,
          ...(checked.icon === undefined ? {} : { icon: checked.icon }),
        }
        await save(next)
        doc = next
        return { ok: true as const, doc: next }
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}

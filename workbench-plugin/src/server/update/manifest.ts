/**
 * 清单的解析、校验与比版本(2026-09-18)。**全是纯函数**,一条 I/O 都没有 ——
 * 所以"清单写坏了会怎样"这类事能一条一条钉成用例,不用起服务、不用联网。
 *
 * ## 为什么校验写得这么严
 *
 * 这份清单决定这台机器**下载并执行什么代码**。所以:
 *
 * 1. **sha256 必须是 64 位十六进制**,长度/字符不对当场就当清单坏了 —— 不能留一个
 *    "校验和是空字符串于是校验通过"的缝。
 * 2. **每件产物的地址必须与清单同源**(同 scheme + host + port)。发布脚本把清单和产物
 *    放在同一个目录里,同源是天然成立的;而万一哪天清单被人改了一行,他也只能指到
 *    我们自己的服务器上 —— 再加上 sha256,两道一起破才谈得上换包。
 * 3. **http 只在回环上放行**。真机走的是 https://api.aibooo.cn;而用例要在临时目录里
 *    起一个本地 http 假服务器真走一遍下载 —— 不给这个口子,那条最值钱的验收路就没了。
 */
import type { UpdateAsset, UpdateAssetKind, UpdateManifest } from './types.ts'
import { DOWNLOADED_ASSET_KINDS, isUpdateAssetKind } from './types.ts'

/** 清单读不懂时抛它。message 是人话,直接显示给 Ben。 */
export class UpdateManifestError extends Error {}

const SHA256_RE = /^[0-9a-f]{64}$/
/** 版本号的形状(以数字开头,后面只许数字、字母、点、连字符)。清单自己的 version 与 `from_version` 同一把尺。 */
const VERSION_RE = /^[0-9][0-9a-zA-Z.\-]*$/

/**
 * 版本号比大小。`0.2.41` 这种三段数字是常态,但也要认得 `0.1.2-rc.1` 这种预发布尾巴。
 *
 * 规矩照 semver 的两条最要紧的:**数字段逐段按数值比**(2 < 10,不是字符串序),
 * **带预发布尾巴的小于同号正式版**(0.3.0-rc.1 < 0.3.0)。别的花样(build metadata
 * 那种 `+xxx`)一概不认 —— 我们自己发版不会用到,认了反而多一处能悄悄比错的地方。
 *
 * 认不出来的段(字母开头)按字符串比,且**排在数字后面**。
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { main: readonly string[], pre: readonly string[] } => {
    const [core = '', ...rest] = v.trim().split('-')
    return { main: core.split('.'), pre: rest.join('-') === '' ? [] : rest.join('-').split('.') }
  }
  const cmpParts = (x: readonly string[], y: readonly string[]): number => {
    const n = Math.max(x.length, y.length)
    for (let i = 0; i < n; i += 1) {
      const xs = x[i]
      const ys = y[i]
      // 段数不一样:短的那边按 0 补。1.2 与 1.2.0 是同一版。
      if (xs === undefined) return ys === undefined ? 0 : (Number(ys) === 0 ? 0 : -1)
      if (ys === undefined) return Number(xs) === 0 ? 0 : 1
      const xn = /^\d+$/.test(xs) ? Number(xs) : undefined
      const yn = /^\d+$/.test(ys) ? Number(ys) : undefined
      if (xn !== undefined && yn !== undefined) { if (xn !== yn) return xn < yn ? -1 : 1; continue }
      // 数字段排在字母段前面(semver 也是这个方向)。
      if (xn !== undefined) return -1
      if (yn !== undefined) return 1
      if (xs !== ys) return xs < ys ? -1 : 1
    }
    return 0
  }
  const left = split(a)
  const right = split(b)
  const main = cmpParts(left.main, right.main)
  if (main !== 0) return main
  // 主版本相同:有预发布尾巴的更小(0.3.0-rc.1 < 0.3.0)。
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  return cmpParts(left.pre, right.pre)
}

/** 严格大于。「有没有新版」问的就是它 —— 相等、或者服务器上比本机还旧,都不算。 */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  }
  catch { return undefined }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/** 这条地址能不能下东西:https 一律可以,http 只在回环上可以(理由见文件头第 3 条)。 */
export function isAllowedAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)
  }
  catch { return false }
}

function parseAsset(kind: UpdateAssetKind, raw: unknown, manifestOrigin: string | undefined): UpdateAsset {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UpdateManifestError(`更新清单里「${kind}」那一条不是一个对象 —— 服务器上那份清单是坏的,先别升。`)
  }
  const item = raw as Record<string, unknown>
  const url = typeof item.url === 'string' ? item.url.trim() : ''
  const sha256 = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : ''
  const size = typeof item.size === 'number' && Number.isInteger(item.size) && item.size >= 0 ? item.size : undefined
  if (url === '' || !isAllowedAssetUrl(url)) {
    throw new UpdateManifestError(`更新清单里「${kind}」的下载地址不对(要 https,本机测试才允许 http)。`)
  }
  if (!SHA256_RE.test(sha256)) {
    throw new UpdateManifestError(`更新清单里「${kind}」没有合法的 sha256(要 64 位十六进制)。没有校验和就不下 —— 这一条不放宽。`)
  }
  if (size === undefined) {
    throw new UpdateManifestError(`更新清单里「${kind}」缺 size(字节数)。`)
  }
  const assetOrigin = originOf(url)
  if (manifestOrigin !== undefined && assetOrigin !== manifestOrigin) {
    throw new UpdateManifestError(`更新清单里「${kind}」指向别的服务器(${assetOrigin ?? '认不出来'}),跟清单本身(${manifestOrigin})不是同一处 —— 不下。`)
  }
  /**
   * 「这一格出自哪一版」(2026-09-26,卡 U8:没重打的那几样照上一版清单原样带上)。
   * **形状不对就当没有,不抛** —— 它只用来说话(那份产物是哪一版打的),下不下、装不装
   * 一概与它无关;为一句说明把整份清单判死,等于让用户因为一个字段的格式升不了级。
   */
  const fromVersion = typeof item.from_version === 'string' && VERSION_RE.test(item.from_version.trim())
    ? item.from_version.trim()
    : undefined
  return { url, sha256, size, ...(fromVersion === undefined ? {} : { from_version: fromVersion }) }
}

/**
 * 一段 JSON 文本 → 清单。**读不懂就抛人话**,绝不回一个半截的清单。
 *
 * @param manifestUrl 清单自己的地址。传了就顺带校验"产物跟清单同源";
 *                    不传(纯函数用例)只校验地址本身合法。
 */
export function parseManifest(text: string, manifestUrl?: string): UpdateManifest {
  let body: unknown
  try { body = JSON.parse(text) }
  catch { throw new UpdateManifestError('服务器上那份更新清单不是合法的 JSON,先别升(多半是发布脚本跑了一半)。') }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UpdateManifestError('更新清单的最外层不是一个对象。')
  }
  const raw = body as Record<string, unknown>
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (version === '' || !VERSION_RE.test(version)) {
    throw new UpdateManifestError('更新清单里没有像样的 version(要以数字开头,比如 0.2.42)。')
  }
  const assetsRaw = raw.assets
  if (typeof assetsRaw !== 'object' || assetsRaw === null || Array.isArray(assetsRaw)) {
    throw new UpdateManifestError('更新清单里缺 assets(要下载的产物清单)。')
  }
  const manifestOrigin = manifestUrl === undefined ? undefined : originOf(manifestUrl)
  const assets: Partial<Record<UpdateAssetKind, UpdateAsset>> = {}
  for (const [key, value] of Object.entries(assetsRaw as Record<string, unknown>)) {
    // 认不出来的种类**直接忽略**,不当成错:以后加了新产物,旧版工作台照样能升到能认它的那一版。
    if (!isUpdateAssetKind(key)) continue
    assets[key] = parseAsset(key, value, manifestOrigin)
  }
  if (assets.plugin_tgz === undefined) {
    throw new UpdateManifestError('更新清单里没有工作台本体(plugin_tgz)—— 那是唯一必须有的一样,没有它这次更新等于什么都不装。')
  }
  const notes = typeof raw.notes === 'string' && raw.notes.trim() !== '' ? raw.notes.trim() : undefined
  const releasedAt = typeof raw.released_at === 'string' && raw.released_at.trim() !== '' ? raw.released_at.trim() : undefined
  const minInstaller = typeof raw.min_installer_version === 'string' && raw.min_installer_version.trim() !== ''
    ? raw.min_installer_version.trim()
    : undefined
  return {
    version,
    ...(releasedAt === undefined ? {} : { released_at: releasedAt }),
    ...(notes === undefined ? {} : { notes }),
    assets,
    ...(minInstaller === undefined ? {} : { min_installer_version: minInstaller }),
  }
}

/** 这次要下多少字节(会下载的那几样之和;apk 不算 —— 手机自己去下)。 */
export function downloadBytesOf(manifest: UpdateManifest): number {
  let total = 0
  for (const kind of DOWNLOADED_ASSET_KINDS) {
    const asset = manifest.assets[kind]
    if (asset !== undefined) total += asset.size
  }
  return total
}

/**
 * 各家 Agent 客户端的**整张图标**(2026-09-26,卡 LG)。
 *
 * 维护者原话:「增加一个功能,就是现在电脑上有多少个 Agent 客户端,把对应的 logo 也搞上;
 * 桌面端的应用标签,也加各家的 logo icon」。
 *
 * 沿的是卡 Q 那条现成的路 —— 壳早就会读各家 App 的图标取主色(`icon_colors` + `IconColor`),
 * 这里只是不再只取一个颜色,而是把**整张图标**要过来(壳的 `app_icon`,同样只碰 NSWorkspace、
 * 一个辅助功能调用都没有),界面按 `GET /agents/icon/:id` 当一张 PNG 取。
 *
 * ## 为什么图片不落盘
 *
 * 登记表(`agents.json`)是**账本**,记的是「有哪几家、读到了什么」,一条几百字节。
 * 一张 128×128 的图标十几 KB,九家就是一百多 KB —— 塞进账本会把每一次 `saveNow()`
 * (读窗口读到新内容就写一次)变成一次一百多 KB 的整份重写。而图标**一次运行内不会变**,
 * 壳自己也缓存着:重启之后再要一次就是了。所以这份缓存**只活在内存里**,
 * 登记表里只留一格 `icon: true/false`(有没有取到),界面据此决定画图标还是退回色点。
 *
 * ## 取不到怎么办
 *
 * 没装、渲不出、壳是旧版(没有 `app_icon` 这件本事)、壳没接上 —— 一律是 `icon: false`,
 * 界面退回现在的色点(卡 Q 那一颗,颜色还是从图标主色来的)。**不出错、不空白**。
 *
 * 这个文件是纯函数 + 一份内存里的 Map;真去问壳在 `agentDiscovery.ts` 的 `refreshIcons`。
 */
import { fnv1a } from './agentWindowModel.ts'

/** 取回来的一张图标。 */
export interface AgentIcon {
  /** PNG 的字节。 */
  png: Uint8Array
  /** `GET /agents/icon/:id` 的 ETag(内容变了才变)。带引号,直接当响应头用。 */
  etag: string
  /** 什么时候取到的(ISO)。 */
  at: string
}

/** 界面上最大用到 20px 左右;64pt@2x = 128px,一张十几 KB,够清楚也不浪费。 */
export const ICON_SIDE = 64
/** 取过的多久再取一次(换图标的 App 很少;壳那边自己也缓存着)。 */
export const ICON_REFRESH_MS = 7 * 24 * 60 * 60_000
/** 没取到的那一家多久再看一眼(他刚把那个 App 装上的情形)。 */
export const ICON_MISSING_RETRY_MS = 24 * 60 * 60_000
/** 一拍最多取几张(一张十几 KB)。原来 3 张,重启后九家要三分钟才长齐,坞上一排小色点(2026-09-26 深夜,统筹)→ 12。 */
export const ICON_PER_TICK = 12
/** PNG 的头八个字节(同壳的 `AppIconPolicy.pngMagic`)。 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** 一张图标最大多少字节(壳按 64pt@2x 渲的实测十几 KB;超过这个说明拿到的不是我们要的东西)。 */
export const ICON_MAX_BYTES = 512 * 1024

/** 这串字节是不是一张 PNG(不把一串来历不明的东西当图片发给界面)。 */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length <= PNG_MAGIC.length) return false
  return PNG_MAGIC.every((byte, index) => bytes[index] === byte)
}

/**
 * 壳回的那一份 → 一张图标。**纯函数**:形状不对、不是 PNG、太大,一律 undefined(当没取到)。
 * 壳明说 `found: false` 的也是 undefined —— 那不是错误,是这台电脑上没装 / 渲不出。
 */
export function parseIconResponse(raw: Record<string, unknown>, at: string): AgentIcon | undefined {
  if (raw.found === false) return undefined
  const base64 = raw.png
  if (typeof base64 !== 'string' || base64 === '') return undefined
  let png: Uint8Array
  try { png = new Uint8Array(Buffer.from(base64, 'base64')) }
  catch { return undefined }
  if (png.length === 0 || png.length > ICON_MAX_BYTES || !isPng(png)) return undefined
  return { png, etag: iconEtag(png), at }
}

/**
 * 一张图标的 ETag。内容变了才变(同一张图标重启之后算出来还是同一个,浏览器那份缓存照旧命中)。
 * 用字节数 + 内容的 fnv1a:图标是二进制,拿它整串做 hash 比再引一个 crypto 划算。
 */
export function iconEtag(png: Uint8Array): string {
  let hash = 0x811C9DC5
  for (const byte of png) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `"${png.length.toString(16)}-${hash.toString(16).padStart(8, '0')}"`
}

/** `If-None-Match` 对上了没(允许 `W/` 前缀与多个值)。对上就回 304,省一次十几 KB 的传输。 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined || header === '') return false
  if (header.trim() === '*') return true
  return header.split(',').some((one) => {
    const value = one.trim().replace(/^W\//, '')
    return value === etag
  })
}

/** 一家此刻的图标状态(取到了 / 取过但没有 / 还没取过)。 */
type IconSlot = { icon: AgentIcon } | { icon: undefined, at: string }

/**
 * 内存里那一份(**一个进程周期**;重启之后重新取)。
 * `nowMs` 注进来:用例不靠真时钟。
 */
export interface IconCache {
  /** 取到的那一张(没取到 / 还没取过都是 undefined)。 */
  get: (bundleId: string) => AgentIcon | undefined
  /** 这一家有没有取到图标(登记表那一格 `icon` 就是它)。 */
  has: (bundleId: string) => boolean
  /** 记下这一次的结果(取到了,或者取过但没有)。 */
  set: (bundleId: string, icon: AgentIcon | undefined, at: string) => void
  /** 这一批里该去问壳的那几家(没取过的、或者过期了的)。 */
  due: (bundleIds: readonly string[], nowMs: number) => string[]
}

export function createIconCache(): IconCache {
  const slots = new Map<string, IconSlot>()
  return {
    get: bundleId => slots.get(bundleId)?.icon,
    has: bundleId => slots.get(bundleId)?.icon !== undefined,
    set: (bundleId, icon, at) => { slots.set(bundleId, icon === undefined ? { icon: undefined, at } : { icon }) },
    due: (bundleIds, nowMs) => bundleIds.filter((bundleId) => {
      const slot = slots.get(bundleId)
      if (slot === undefined) return true
      const at = slot.icon === undefined ? slot.at : slot.icon.at
      const age = nowMs - Date.parse(at)
      if (!Number.isFinite(age)) return true
      return age >= (slot.icon === undefined ? ICON_MISSING_RETRY_MS : ICON_REFRESH_MS)
    }),
  }
}

/** 一条日志里带上这一家是什么(不带图片本身)。 */
export function iconLogLine(bundleId: string, icon: AgentIcon | undefined): string {
  return icon === undefined ? `没取到 ${bundleId} 的图标` : `取到 ${bundleId} 的图标(${icon.png.length} 字节,${fnv1a(bundleId)})`
}

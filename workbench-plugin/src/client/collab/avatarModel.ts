/**
 * 名片头像的几样规矩(2026-10-21 协作区评审 ⑤)。纯函数,界面与用例共用。
 *
 * 数量与上限照视觉 A 原型里的数,**待见稿确认**;改只改这一处。
 * 头像只用在协作区的名片与标签上;顶部各家客户端的 Logo 不读这里。
 */
import { AVATAR_PHOTO_PX, AVATAR_THUMB_PX } from '../../protocol.ts'

/** 内置库每种几个(人物 / 机器人各一套)。待见稿确认。 */
export const AVATAR_PRESETS_PER_KIND = 8
/** 上传图片最大字节数。待见稿确认。 */
export const AVATAR_UPLOAD_MAX_BYTES = 5 * 1024 * 1024
/** 上传图片最短边至少多少像素。待见稿确认。 */
export const AVATAR_UPLOAD_MIN_PX = 32
/** 上传图片总像素上限(太大解码会卡)。待见稿确认。 */
export const AVATAR_UPLOAD_MAX_PIXELS = 40_000_000
export const AVATAR_UPLOAD_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']
export const AVATAR_ZOOM_MAX = 4
export { AVATAR_PHOTO_PX, AVATAR_THUMB_PX }

export type AvatarKind = 'human' | 'agent'
export interface AvatarPreset { id: string, kind: AvatarKind, label: string, n: number }

export const AVATAR_PRESETS: readonly AvatarPreset[] = (['human', 'agent'] as const).flatMap(kind =>
  Array.from({ length: AVATAR_PRESETS_PER_KIND }, (_, n) => ({ id: `${kind}-${n}`, kind, label: `${kind === 'human' ? '人物' : '机器人'} ${n + 1}`, n })))

export function presetOf(id: string): AvatarPreset | undefined {
  return AVATAR_PRESETS.find(one => one.id === id)
}

/** 选文件那一下就能挡的:格式与大小。挡下就回那一句,能用回 undefined。 */
export function checkUploadFile(file: { type: string, size: number }): string | undefined {
  if (!AVATAR_UPLOAD_TYPES.includes(file.type)) return '请选择 PNG、JPG 或 WebP 图片。'
  if (file.size > AVATAR_UPLOAD_MAX_BYTES) return `图片超过 ${AVATAR_UPLOAD_MAX_BYTES / 1024 / 1024} MB,请换一张小一些的。`
  return undefined
}

/** 解码之后才知道的:太小、太大。 */
export function checkImageSize(width: number, height: number): string | undefined {
  if (!(width > 0 && height > 0)) return '图片打不开,可能坏了,换一张试试。'
  if (Math.min(width, height) < AVATAR_UPLOAD_MIN_PX) return `图片太小了,至少 ${AVATAR_UPLOAD_MIN_PX}×${AVATAR_UPLOAD_MIN_PX}。`
  if (width * height > AVATAR_UPLOAD_MAX_PIXELS) return '图片像素太多,请换一张小一些的。'
  return undefined
}

/** 裁剪:缩放 1–4 倍,x / y 是方框在可移动范围里的位置(0–1)。 */
export interface Crop { zoom: number, x: number, y: number }
export const CROP_START: Crop = { zoom: 1, x: 0.5, y: 0.5 }

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))

export function clampCrop(crop: Crop): Crop {
  return { zoom: clamp(crop.zoom, 1, AVATAR_ZOOM_MAX), x: clamp(crop.x, 0, 1), y: clamp(crop.y, 0, 1) }
}

/** 原图上要取的那个正方形。 */
export function cropSource(width: number, height: number, crop: Crop): { sx: number, sy: number, side: number } {
  const c = clampCrop(crop)
  const side = Math.min(width, height) / c.zoom
  return { sx: (width - side) * c.x, sy: (height - side) * c.y, side }
}

/** 拖动 / 方向键挪一下:dx、dy 是预览框上的像素,换算成位置的比例(往右拖 = 看左边,方框往左走)。 */
export function nudgeCrop(crop: Crop, dx: number, dy: number, width: number, height: number, previewPx: number): Crop {
  const { side } = cropSource(width, height, crop)
  const perPx = side / previewPx
  const spanX = width - side
  const spanY = height - side
  return clampCrop({
    zoom: crop.zoom,
    x: spanX <= 0 ? 0.5 : crop.x - (dx * perPx) / spanX,
    y: spanY <= 0 ? 0.5 : crop.y - (dy * perPx) / spanY,
  })
}

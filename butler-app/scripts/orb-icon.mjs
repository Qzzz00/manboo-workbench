// 粒子球图标渲染器 —— 手机图标(butler-app)与 Mac 图标(workbench-app)共用这一份。
//
// 为什么和手机脚本并排放在 butler-app/scripts 下:它 import 的是隔壁 `butler-app/src/swarm/core.js`,
// 模块放在它渲染的那份算法旁边,路径最短、最不容易被搬散。
// (那份 core.js 与 `workbench-plugin/src/client/swarm/core.js` 逐字节相同,是同一份
//  `docs/prototypes/swarm-v4/` 的镜像,所以两个 App 的球必然是同一颗。)
//
// 粒子位置不是照着画的,是真货 —— 直接跑 SwarmV4(纯数学,不碰 DOM)的待命动画取一帧。
// 着色是 `SwarmRenderer.paint()` 待命分支(face/call/work 权重全 0)的离屏复刻:
//   · 透视 p = 4.2/(4.2-z),px = W/2 + x*R*p,R = 设计画布 400 * .32 * bodySize
//   · 颗粒边长 sizes[i]*(.34+depth*.94)*p,亮度 (.075+depth^2.1*.84)*(.88+.12*sin(...))
//   · 中心光团 = LightCloud 的 canvas 兜底路径(四层同心径向渐变),以 screen 混合、
//     globalAlpha .92 夹在 z<0 与 z>0 的粒子之间(图标默认 cloudBrightness=0,这一段不跑)
// 全是黑底白光,所以整幅图只要一条 alpha 通道:source-over 记 a+A(1-a),screen 记 a+A-aA。
// 和屏幕上那颗球唯一的差别:方块粒子按真实面积覆盖率抗锯齿,不做设备像素对齐
// (对齐是为了屏幕上锐利,图标缩放后反而会毛)。
//
// 谁在用:
//   butler-app/scripts/render-app-icon.mjs    Android mipmap
//   workbench-app/scripts/render-mac-icon.mjs macOS .icns

import { deflateSync } from 'node:zlib'
import { SwarmV4, TUNING_DEFAULTS } from '../src/swarm/core.js'

/**
 * 2026-09-17 Ben:「粒子太小了看不清,做到图标也能看明白是粒子」。
 * 图标不是舞台:3600 颗缩到 48–192px 就糊成一团灰。颗数减到 1400、颗粒放大、亮度提高、光团关掉,
 * 缩小后每一颗仍是一个看得见的方点。可用环境变量 ICON_SETTINGS(JSON)临时覆盖。
 */
export const ICON_SETTINGS = { ...TUNING_DEFAULTS, count: 1400, particleSize: 2.2, particleBrightness: 1.8, cloudBrightness: 0 }

/** 渲染器原本按 CSS 像素给颗粒定大小,所以先认一块 400 的设计画布,再整体放大到输出分辨率。 */
export const DESIGN_CANVAS = 400

/** 空跑多少秒待命动画再定格 —— 自转让每颗粒子的角度散开,斐波那契网格的螺旋纹就看不出来了。 */
export const WARMUP_SECONDS = 6

/** 读环境变量 ICON_SETTINGS(JSON)覆盖调参。 */
export function iconSettings(extra = {}) {
  return { ...ICON_SETTINGS, ...extra, ...JSON.parse(process.env.ICON_SETTINGS ?? '{}') }
}

/** 造一颗跑热了的球:configure → idle → 空跑 warmupSeconds 秒 → 定格。 */
export function warmSwarm(settings, warmupSeconds = WARMUP_SECONDS) {
  const swarm = new SwarmV4(settings.count)
  swarm.configure(settings)
  swarm.setMode('idle')
  for (let i = 0; i < Math.round(warmupSeconds * 60); i++) swarm.step(1 / 60)
  return swarm
}

// ── PNG(zlib 在 node 里自带,不引第三方) ────────────────────────────────────
const CRC = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c }
  return table
})()
function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i++) c = CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, body) {
  const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0)
  const tagged = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(tagged), 0)
  return Buffer.concat([head, tagged, tail])
}
/** @param {Uint8Array} rgba 逐像素 RGBA(直通 alpha,不预乘) */
export function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 画布:单通道 alpha(白光打在黑底上) ─────────────────────────────────────
function field(size) { return { size, data: new Float64Array(size * size) } }

/** source-over 一块白方块,按面积覆盖率抗锯齿。 */
function paintSquare(canvas, cx, cy, side, alpha) {
  if (!(alpha > 0) || !(side > 0)) return
  const half = side / 2, size = canvas.size, data = canvas.data
  const x0 = Math.max(0, Math.floor(cx - half)), x1 = Math.min(size - 1, Math.ceil(cx + half))
  const y0 = Math.max(0, Math.floor(cy - half)), y1 = Math.min(size - 1, Math.ceil(cy + half))
  for (let y = y0; y <= y1; y++) {
    const cover = Math.max(0, Math.min(y + 1, cy + half) - Math.max(y, cy - half))
    if (cover <= 0) continue
    for (let x = x0; x <= x1; x++) {
      const overlap = cover * Math.max(0, Math.min(x + 1, cx + half) - Math.max(x, cx - half))
      if (overlap <= 0) continue
      const a = alpha * overlap, k = y * size + x
      data[k] = data[k] + a * (1 - data[k])
    }
  }
}

/** LightCloud 的 canvas 兜底路径:四层径向渐变叠出一团连续的光。坐标是那 160 单位的场。 */
function cloudAlphaAt(fx, fy, time, settings) {
  const brightness = Math.max(0, Math.min(3, settings.cloudBrightness))
  const focus = Math.max(.5, Math.min(2, settings.cloudFocus))
  const halo = Math.max(0, Math.min(1, settings.cloudHalo))
  const emission = brightness // activity(对话强度)在静止图里是 0
  const r = 43 / (.7 + focus * .45)
  const x = Math.sin(time * .33) * r * .075, y = Math.cos(time * .29) * r * .06
  let out = 0
  const layer = (cx, cy, radius, stops) => {
    const d = Math.hypot(fx - cx, fy - cy) / radius
    if (d >= 1) return
    let light = stops[stops.length - 1][1]
    for (let i = 0; i < stops.length - 1; i++) {
      const [at, a] = stops[i], [to, b] = stops[i + 1]
      if (d >= at && d <= to) { const u = to === at ? 0 : (d - at) / (to - at); light = a + (b - a) * u; break }
    }
    const alpha = 1 - Math.exp(-emission * light)
    out = alpha + out * (1 - alpha)
  }
  if (halo > 0) layer(0, 0, 56, [[0, halo * .065], [.35, halo * .045], [.75, halo * .012], [1, 0]])
  layer(x, y, r, [[0, 1.05], [.25, .8], [.55, .34], [.83, .055], [1, 0]])
  layer(x + Math.cos(time * .47) * r * .18, y + Math.sin(time * .36) * r * .13, r * .66, [[0, .24], [.4, .14], [.78, .025], [1, 0]])
  layer(x - Math.sin(time * .38) * r * .2, y - Math.cos(time * .42) * r * .17, r * .58, [[0, .18], [.4, .09], [.8, .015], [1, 0]])
  return out
}

/** 一颗粒子在设计画布里的投影:中心偏移、边长、亮度(scale=1 时的量)。 */
function project(swarm, i, designCanvas) {
  const settings = swarm.settings
  const k = i * 3, x = swarm.positions[k], y = swarm.positions[k + 1], z = swarm.positions[k + 2]
  const R = designCanvas * .32 * settings.bodySize
  const p = 4.2 / (4.2 - z), depth = Math.max(0, Math.min(1, (z + 1) / 2))
  let alpha = (.075 + Math.pow(depth, 2.1) * .84) * (.88 + .12 * Math.sin(swarm.time * .8 + swarm.seeds[i] * 60))
  return {
    dx: x * R * p,
    dy: y * R * p,
    side: swarm.sizes[i] * (.34 + depth * .94) * p * settings.particleSize,
    alpha: Math.min(1, alpha * settings.particleBrightness),
  }
}

/**
 * 球的外接半径(设计画布单位,**含最外圈那颗粒子的一半边长**)。
 * 拿它算「撑满」比记一个 .66 的常数诚实:调参一改(bodySize / particleSize / count),
 * 这个数跟着变,球照样刚好贴住目标圆,不会溢出也不会缩水。
 */
export function orbRadius(swarm, designCanvas = DESIGN_CANVAS) {
  let max = 0
  for (let i = 0; i < swarm.count; i++) {
    const { dx, dy, side } = project(swarm, i, designCanvas)
    max = Math.max(max, Math.hypot(dx, dy) + side / 2)
  }
  return max
}

/** 让球的外接圆正好落在 `radius` 像素上,该用多大的 span(设计画布里映射到输出边长的那段)。 */
export function spanForRadius(swarm, size, radius, designCanvas = DESIGN_CANVAS) {
  return size * orbRadius(swarm, designCanvas) / radius
}

/**
 * 画一帧待命的粒子球。
 * @param swarm 已经跑热的 SwarmV4
 * @param size 输出边长(像素)
 * @param span 设计画布里被映射到这条边上的长度 —— 越小球越大
 */
export function renderOrb(swarm, size, span, designCanvas = DESIGN_CANVAS) {
  const canvas = field(size), settings = swarm.settings
  const scale = size / span              // 设计像素 → 输出像素,等同渲染器里的 DPR
  const center = size / 2

  // 和渲染器一样按 z 排序:后半球 → 光团 → 前半球
  const order = Array.from({ length: swarm.count }, (_, i) => i).sort((a, b) => swarm.positions[a * 3 + 2] - swarm.positions[b * 3 + 2])
  const particle = i => {
    const { dx, dy, side, alpha } = project(swarm, i, designCanvas)
    paintSquare(canvas, center + dx * scale, center + dy * scale, side * scale, alpha)
  }

  let cut = 0
  while (cut < order.length && swarm.positions[order[cut] * 3 + 2] < 0) cut++
  for (let i = 0; i < cut; i++) particle(order[i])

  if (settings.cloudSize > 0 && settings.cloudBrightness > 0) {
    const R = designCanvas * .32 * settings.bodySize
    const radius = R * 1.3 * settings.cloudSize * scale   // 光团贴图在画布上的半径
    const toField = 160 / (radius * 2)                    // 输出像素 → 160 单位的场
    const x0 = Math.max(0, Math.floor(center - radius)), x1 = Math.min(size - 1, Math.ceil(center + radius))
    const y0 = Math.max(0, Math.floor(center - radius)), y1 = Math.min(size - 1, Math.ceil(center + radius))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const a = cloudAlphaAt((x + .5 - center) * toField, (y + .5 - center) * toField, swarm.cloudTime, settings) * .92
      if (a <= 0) continue
      const k = y * size + x
      canvas.data[k] = a + canvas.data[k] - a * canvas.data[k]   // screen
    }
  }

  for (let i = cut; i < order.length; i++) particle(order[i])
  return canvas
}

/** 面积平均缩图。 */
export function downscale(canvas, size) {
  if (size === canvas.size) return canvas
  const out = field(size), ratio = canvas.size / size
  for (let y = 0; y < size; y++) {
    const sy0 = y * ratio, sy1 = (y + 1) * ratio
    for (let x = 0; x < size; x++) {
      const sx0 = x * ratio, sx1 = (x + 1) * ratio
      let sum = 0, weight = 0
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        if (wy <= 0) continue
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const w = wy * (Math.min(sx + 1, sx1) - Math.max(sx, sx0))
          if (w <= 0) continue
          sum += canvas.data[sy * canvas.size + sx] * w; weight += w
        }
      }
      out.data[y * size + x] = weight ? sum / weight : 0
    }
  }
  return out
}

const byte = v => Math.max(0, Math.min(255, Math.round(v * 255)))

/**
 * 遮罩覆盖率,带 1px 软边,省得边缘出锯齿。
 * mask:'square' | 'circle' | 'rounded'(圆角方,默认 22.5% 圆角、不留边距),
 * 或 `{ shape:'rounded', corner, inset }` —— corner 是圆角占**方块边长**的比例,
 * inset 是每边留白占**整幅图**的比例(macOS 图标要留 ≈9.8%)。
 */
export function maskCover(mask, x, y, size) {
  const spec = typeof mask === 'string' ? { shape: mask } : mask
  if (spec.shape === 'square') return 1
  const center = size / 2, edge = d => Math.max(0, Math.min(1, d + .5))
  if (spec.shape === 'circle') return edge(size * .5 - Math.hypot(x + .5 - center, y + .5 - center))
  const half = size * (1 - 2 * (spec.inset ?? 0)) / 2
  const corner = half * 2 * (spec.corner ?? .225)
  const dx = Math.abs(x + .5 - center) - (half - corner), dy = Math.abs(y + .5 - center) - (half - corner)
  return edge(corner - Math.hypot(Math.max(dx, 0), Math.max(dy, 0)))
}

/** 前景层:白色粒子 + 透明底。 */
export function foregroundPNG(canvas) {
  const size = canvas.size, rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = byte(canvas.data[i])
  }
  return encodePNG(size, size, rgba)
}

/** 合成层:黑底 + 粒子,遮罩外透明。 */
export function composedPNG(canvas, mask = 'square') {
  const size = canvas.size, rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, light = byte(canvas.data[i])
    rgba[i * 4] = light; rgba[i * 4 + 1] = light; rgba[i * 4 + 2] = light
    rgba[i * 4 + 3] = byte(maskCover(mask, x, y, size))
  }
  return encodePNG(size, size, rgba)
}

export { byte }

// 粒子黑洞图标渲染器(2026-09-23 维护者拍板:三个 App 的图标换成粒子黑洞)——
// 手机图标(render-app-icon.mjs)与 Mac 图标(workbench-app/scripts/render-mac-icon.mjs)共用这一份。
//
// 粒子不是照着画的:`../src/brand/blackhole.js` 是参赛网页原型(docs/brand/粒子黑洞-原型-2026-09-23.html)
// 顶点着色器的逐行移植,这里在某一刻(CLOCK 秒)取所有粒子的位置、大小、亮度,离线画到一张浮点亮度图上。
// 纯 node,不装任何依赖(PNG 编码、缩图、遮罩借 orb-icon.mjs 那几个现成的)。
//
// 两档画法 —— 小图上 2 万颗粒子只会糊成一团灰雾:
//   · simple(显示尺寸 ≤ 96px:Mac 16/32/64、Android 旧版 48/72/96、自适应前景 mdpi/hdpi/xhdpi)
//       亮环(上半圈满亮、下半圈淡成倒影)+ 一条地平线 + 十几颗较大的亮点(从真粒子里按角度挑最亮的)。
//       环的线宽、地平线粗细、亮点直径都有「至少 N 个目标像素」的下限,16px 上也是清楚的一道弧一条线。
//   · full(≥ 128px):接近原型的完整版 —— 拱形吸积盘、地平线、倒影、柔光;128/256 上抽稀粒子、放大颗粒。
//
// 输出都是「光」:一张 0..1 的亮度图(白光打在黑底上)。合成到什么底上由调用方决定
// (Mac 是深色圆角方,Android 前景是透明底 + 背景色 #08090b)。

import { createBlackhole, placeParticle, ringLight, pixelScale, smoothstep, RING_RADIUS, RING_SIGMA } from '../src/brand/blackhole.js'
import { byte, downscale, encodePNG, maskCover } from './orb-icon.mjs'

/** 取哪一刻的粒子。12 秒:各层都流开了,拱形两肩对称、没有大缺口(挑过几刻,这一刻最匀)。 */
export const CLOCK = Number(process.env.BLACKHOLE_CLOCK ?? 12)

/** 显示尺寸 ≤ 这个像素用 simple。 */
export const SIMPLE_MAX = 96

/**
 * 构图(单位:光环半径 = 1;y 朝上)。half 是画面半宽,centerY 是画面中心的 y。
 * full 看得见整座拱和两翼的起点;simple 拉近,环更大、翼只留一段。
 */
export const FRAMING = {
  full: { half: 2.6, centerY: .36 },
  simple: { half: 2.05, centerY: .34 },
}

function field(size) { return { size, data: new Float64Array(size * size) } }


/** 相加一个圆点(实心圆 + 1px 软边),simple 档的亮点。 */
function addDot(canvas, cx, cy, radius, light) {
  const size = canvas.size, data = canvas.data, reach = radius + 1
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(size - 1, Math.ceil(cx + reach))
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(size - 1, Math.ceil(cy + reach))
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x + .5 - cx, y + .5 - cy), cover = Math.max(0, Math.min(1, radius - d + .5))
    if (cover > 0) data[y * size + x] = Math.max(data[y * size + x], light * cover)
  }
}


/** 单位坐标 → 画布像素。 */
function projector(size, framing, zoom = 1) {
  const scale = size / 2 / framing.half * zoom
  return { scale, x: ux => size / 2 + ux * scale, y: uy => size / 2 - (uy - framing.centerY) * scale }
}

/**
 * 完整版,任意长宽(图标是正方形,安装器欢迎页的横幅是长条)。
 * width/height:主图像素(超采样后的);ss:主图像素 / 输出像素;radius、cx、cy:光环半径与圆心(主图像素);
 * detail:按多大的显示尺寸定抽稀与颗粒下限(≥ 512 就是原型原样)。
 */
export function renderScene(width, height, { radius, cx, cy, ss = 1, detail = 1024 }) {
  const bh = createBlackhole(), size = width * height
  const out = new Float64Array(size), glow = { size: 0, width, height, data: new Float64Array(size) }
  const X = ux => cx + ux * radius, Y = uy => cy - uy * radius
  const pixels = pixelScale(radius / ss) * ss      // 原型的 uPixels,按输出尺寸算再换回主图
  // 小一点的图抽稀、放大颗粒:128 上每 10 颗取 1 颗,颗粒至少 1 个输出像素。
  const stride = detail >= 512 ? 1 : detail >= 256 ? 3 : 10
  const minSide = (detail >= 512 ? .6 : 1) * ss
  const p = { x: 0, y: 0, alpha: 0, size: 0, lum: 1, kind: 0 }
  // 柔光(原型:1/3 分辨率、点径 ×7、exp(-d²·3.4)·.15,再乘 glow .55)
  for (let i = 0; i < bh.count; i++) {
    if (!placeParticle(bh, i, CLOCK, p)) continue
    const s = p.size * pixels
    addGaussRect(glow, X(p.x), Y(p.y), Math.max(1.5 * ss, s * 3.5), p.alpha * p.lum * .15 * .55 * Math.min(1, (s / ss) ** 2) * (detail >= 512 ? 1 : .6))
  }
  // 解析光环(合成着色器)+ 柔光。小一点的图(128/256)环加粗:σ 至少 0.7 个输出像素,不然缩下去是一根发丝。
  const widen = Math.max(1, .7 * ss / (RING_SIGMA * radius))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ux = (x + .5 - cx) / radius, uy = (cy - y - .5) / radius, k = y * width + x
    const d = Math.hypot(ux, uy)
    out[k] = Math.min(1, glow.data[k] + ringLight(RING_RADIUS + (d - RING_RADIUS) / widen, uy))
  }
  // 粒子(source-over)
  const canvas = { width, height, data: out }
  for (let i = 0; i < bh.count; i += stride) {
    if (!placeParticle(bh, i, CLOCK, p)) continue
    const natural = p.size * pixels * Math.sqrt(stride) ** .5
    const side = Math.max(minSide, natural)
    const cover = Math.min(1, (natural / ss) ** 2) * (natural < side ? natural / side : 1)
    // 地平线以下那片(吸积盘背面 + 倒影)在图标里压暗:小画面里它抢了光环倒影的戏。
    const below = p.y < -.04 ? (detail >= 512 ? .6 : .4) : 1
    const boost = detail >= 512 ? 1 : 1.5
    paintSquareRect(canvas, X(p.x), Y(p.y), side, Math.min(1, p.alpha * boost * below * Math.max(cover, .25)), p.lum)
  }
  return canvas
}

function addGaussRect(canvas, cx, cy, radius, light) {
  const { width, height, data } = canvas
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(width - 1, Math.ceil(cx + radius))
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(height - 1, Math.ceil(cy + radius))
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const q = Math.hypot(x + .5 - cx, y + .5 - cy) / radius
    if (q < 1) data[y * width + x] += light * Math.exp(-q * q * 3.4)
  }
}

function paintSquareRect(canvas, cx, cy, side, alpha, lum = 1) {
  if (!(alpha > 0) || !(side > 0)) return
  const { width, height, data } = canvas, half = side / 2
  const x0 = Math.max(0, Math.floor(cx - half)), x1 = Math.min(width - 1, Math.ceil(cx + half))
  const y0 = Math.max(0, Math.floor(cy - half)), y1 = Math.min(height - 1, Math.ceil(cy + half))
  for (let y = y0; y <= y1; y++) {
    const cover = Math.max(0, Math.min(y + 1, cy + half) - Math.max(y, cy - half))
    if (cover <= 0) continue
    for (let x = x0; x <= x1; x++) {
      const a = alpha * cover * Math.max(0, Math.min(x + 1, cx + half) - Math.max(x, cx - half))
      if (a <= 0) continue
      const k = y * width + x
      data[k] = data[k] * (1 - a) + lum * a
    }
  }
}

/** 完整版正方形图标。size:主图边长;outputPx:输出边长。 */
export function renderFull(size, outputPx, { framing = FRAMING.full, zoom = 1, detail = outputPx } = {}) {
  const at = projector(size, framing, zoom)
  const scene = renderScene(size, size, { radius: at.scale, cx: size / 2, cy: at.y(0), ss: size / outputPx, detail })
  return { size, data: scene.data }
}

/** 长条横幅(安装器欢迎页):width×height 输出像素,光环半径 radius、圆心 (cx, cy) 都是输出像素。 */
export function renderBanner(width, height, { radius, cx = width / 2, cy = height * .62, supersample = 3 } = {}) {
  const k = supersample
  const scene = renderScene(width * k, height * k, { radius: radius * k, cx: cx * k, cy: cy * k, ss: k, detail: 1024 })
  const out = new Float64Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) sum += scene.data[(y * k + j) * width * k + x * k + i]
    out[y * width + x] = sum / (k * k)
  }
  return { width, height, data: out }
}

/**
 * 从真粒子里挑 simple 档的亮点:只看拱形吸积盘(kind 0,前两层),按绕圆心的角度分 count 格,
 * 每格挑「亮度 × 大小」最大的那颗。再在两翼地平线上各挑一颗(wings = true 时)。确定性。
 */
export function pickDots(count = 12, wings = true) {
  const bh = createBlackhole(), p = { x: 0, y: 0, alpha: 0, size: 0, lum: 1, kind: 0 }
  const bins = Array.from({ length: count }, () => null)
  const from = 12 * Math.PI / 180, to = 168 * Math.PI / 180
  const wing = [null, null]
  for (let i = 0; i < bh.count; i++) {
    const kind = bh.data[i * 8 + 3]
    if (!placeParticle(bh, i, CLOCK, p)) continue
    const score = p.alpha * p.lum * p.size
    if (kind === 0 && p.lum > .8) {
      const angle = Math.atan2(p.y, p.x), r = Math.hypot(p.x, p.y)
      if (angle < from || angle > to || r < 1.25 || r > 1.75) continue
      const b = Math.min(count - 1, Math.floor((angle - from) / (to - from) * count))
      if (!bins[b] || score > bins[b].score) bins[b] = { x: p.x, y: p.y, score }
    } else if (wings && (kind === 6 || kind === 2) && Math.abs(p.y) < .05 && Math.abs(p.x) > 1.3 && Math.abs(p.x) < 1.6) {
      const s = p.x < 0 ? 0 : 1
      if (!wing[s] || score > wing[s].score) wing[s] = { x: p.x, y: p.y, score }
    }
  }
  return [...bins, ...wing].filter(Boolean).map(({ x, y }) => ({ x, y }))
}

/**
 * 简化版:亮环 + 地平线 + 倒影 + 亮点。size 是主图边长,displayPx 是显示边长。
 * 各笔画都有显示像素下限,换算成主图像素后画,缩下去依然是一道清楚的弧。
 */
export function renderSimple(size, outputPx, { framing = FRAMING.simple, zoom = 1, dots, detail = outputPx } = {}) {
  const displayPx = detail
  const out = field(size), at = projector(size, framing, zoom), ss = size / outputPx, r = at.scale
  // 环:线宽至少 1.3 显示像素(16px 上也是一道看得见的弧)。σ 换成单位半径。
  const ringCore = Math.max(1.3 * ss / r / 2.4, .05)
  // 地平线:至少 1 个显示像素粗,中间最亮、往两头淡。
  const lineHalf = Math.max(.55 * ss, .018 * r)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const ux = (x + .5 - size / 2) / r, uy = (size / 2 - y - .5) / r + framing.centerY
    const d = Math.hypot(ux, uy), radial = (d - 1.045) / ringCore
    const upper = smoothstep(-.03, .03, uy)
    const band = Math.exp(-.5 * radial * radial)
    const halo = .16 * Math.exp(-.5 * (radial / 3.2) ** 2)
    // 倒影:下半圈留 18%(原型是 5.5% —— 小图上会直接看不见;再亮就读成一整个圆了)
    let light = (band + halo) * (.18 + .82 * upper)
    // 地平线(环里面是黑洞,不画线)
    const dy = Math.abs((size / 2 - y - .5) - (0 - framing.centerY) * r)
    if (d > 1.02 || uy < -.02) {
      const across = Math.max(0, Math.min(1, (lineHalf - dy + .5 * ss) / ss))
      const along = Math.exp(-Math.pow(Math.max(0, Math.abs(ux) - 1.05) / 1.1, 2))
      light = Math.max(light, across * (.35 + .65 * along) * (Math.abs(ux) > 1.0 ? 1 : 0))
    }
    // 倒影底下一层很淡的光(吸积盘的回光)
    if (uy < 0 && d < 1.3) light = Math.max(light, .06 * (1 - smoothstep(.6, 1.3, d)) * smoothstep(-.9, -.1, uy))
    out.data[y * size + x] = Math.min(1, light)
  }
  // 亮点:直径至少 1.4 显示像素
  const radius = Math.max(.7 * ss, .045 * r)
  for (const dot of dots ?? pickDots(displayPx <= 20 ? 8 : 12, displayPx > 20)) addDot(out, at.x(dot.x), at.y(dot.y), radius, .92)
  return out
}

/**
 * 出一张 outputPx 见方的亮度图(超采样后面积平均缩下来)。
 * options.detail:按多大的「显示尺寸」选档(缺省 = outputPx)。Android 自适应前景画布 108dp 里只露 72dp,
 * 所以前景按 2/3 的尺寸选档。options.framing / zoom 覆盖构图。
 */
export function renderIcon(outputPx, options = {}) {
  const detail = options.detail ?? outputPx
  const simple = detail <= SIMPLE_MAX
  const supersample = options.supersample ?? (simple ? 8 : outputPx >= 1024 ? 2 : 4)
  const master = outputPx * supersample
  const light = simple
    ? renderSimple(master, outputPx, { ...options, detail, framing: options.framing?.simple ?? FRAMING.simple })
    : renderFull(master, outputPx, { ...options, detail, framing: options.framing?.full ?? FRAMING.full })
  return downscale(light, outputPx)
}

// ─────────────────────────────── 合成 ───────────────────────────────
export { downscale, encodePNG }

/** 图标底色:原型的 #08090b。Android 自适应背景层也用它(res/values/ic_launcher_background.xml)。 */
export const ICON_BACKGROUND = [8, 9, 11]

/**
 * macOS 外形:1024 画布里 824 的圆角方(圆角 22.5%),外面透明。
 * 底不是死黑:上 #1b1d22 → 下 #060708 的竖向渐变,边上一圈 1 像素 12% 白 ——
 * 深色桌面(Dock 在深色模式下接近 #1e1e1e)上也看得出方块的边,浅色桌面上它本来就是一块深色。
 */
export const MAC_SHAPE = { canvas: 1024, square: 824, corner: 185.4 / 824 }
export function composeMac(light) {
  const size = light.size, rgba = new Uint8Array(size * size * 4)
  const inset = (MAC_SHAPE.canvas - MAC_SHAPE.square) / 2 / MAC_SHAPE.canvas
  const mask = { shape: 'rounded', corner: MAC_SHAPE.corner, inset }
  const edgeWidth = Math.max(1, size / 512)
  const innerMask = { shape: 'rounded', corner: MAC_SHAPE.corner, inset: inset + edgeWidth / size }
  const top = [27, 29, 34], bottom = [6, 7, 8]
  const y0 = size * inset, y1 = size * (1 - inset)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, cover = maskCover(mask, x, y, size)
    if (cover <= 0) continue
    const v = Math.max(0, Math.min(1, (y + .5 - y0) / (y1 - y0)))
    const edge = Math.max(0, cover - maskCover(innerMask, x, y, size))
    for (let c = 0; c < 3; c++) {
      let base = top[c] + (bottom[c] - top[c]) * v
      base += (255 - base) * edge * .12
      const l = light.data[i]
      rgba[i * 4 + c] = byte((base + (255 - base) * l) / 255)
    }
    rgba[i * 4 + 3] = byte(cover)
  }
  return rgba
}

/** 满底合成(Android 旧版方/圆图标、预览):底色 bg + 光,mask 外透明。 */
export function composeFlat(light, mask = 'square', bg = ICON_BACKGROUND) {
  const size = light.size, rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, l = light.data[i]
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = byte((bg[c] + (255 - bg[c]) * l) / 255)
    rgba[i * 4 + 3] = byte(maskCover(mask, x, y, size))
  }
  return rgba
}

/** Android 自适应前景:白光 + 透明底。 */
export function composeForeground(light) {
  const size = light.size, rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = byte(light.data[i]) }
  return rgba
}

/** 把一张 RGBA 贴到另一张大图的 (ox, oy) 上(alpha 混合)。 */
export function blit(dst, dstWidth, src, srcSize, ox, oy) {
  for (let y = 0; y < srcSize; y++) for (let x = 0; x < srcSize; x++) {
    const s = (y * srcSize + x) * 4, a = src[s + 3] / 255
    if (a <= 0) continue
    const d = ((oy + y) * dstWidth + ox + x) * 4
    for (let c = 0; c < 3; c++) dst[d + c] = Math.round(dst[d + c] * (1 - a) + src[s + c] * a)
  }
}

/** 纯色底的大图。 */
export function canvasRGBA(width, height, rgb) {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255 }
  return rgba
}

/** 横幅合成:底色 #08090b + 光,不透明。 */
export function composeBanner(light, bg = ICON_BACKGROUND) {
  const { width, height, data } = light, rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = byte((bg[c] + (255 - bg[c]) * Math.min(1, data[i])) / 255)
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

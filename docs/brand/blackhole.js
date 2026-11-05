// 粒子黑洞(品牌主视觉)—— 共用核心。**三处逐字节相同**:
//   docs/brand/blackhole.js                         (源,改这里)
//   workbench-plugin/src/client/brand/blackhole.js  (电脑端登录页 + 串联)
//   butler-app/src/brand/blackhole.js               (手机登录页 + 串联;也被图标脚本 import)
// 改完跑 `node docs/brand/sync-blackhole.mjs` 同步;两边各有一条用例钉住「与源相同」。
//
// 来源:docs/brand/粒子黑洞-原型-2026-09-23.html(Codex 为参赛网页做的 WebGL 原型,feat/site e825e352)。
// 这里是它顶点着色器与合成着色器的 **JS 逐行移植**:同一个种子(230926)、同一批 26000 颗里筛出的 20440 颗、
// 同一条拱形路径、同样的分层/流速/倒影/地平线规则。区别只有三处,都是为了能在 Canvas2D 与离线图标里用:
//   1. 路径不做 16 位打包(原型为了塞进纹理才量化,这里直接用浮点);
//   2. 不画拖尾(原型的 uTrail 两趟只作用于 2% 的高光粒子,静帧里看不出);
//   3. 柔光(bloom)在 Canvas2D 里用 1/3 分辨率的离屏图 + 放大时的双线性模糊近似,离线图标里用真高斯。
//
// 坐标:以光环圆心为原点、光环半径 ≈ 1 为单位、**y 朝上**。画到屏幕上:px = cx + x·r,py = cy − y·r。
// 原型的版式是 cx = W/2、cy = 0.58·H、r = 0.08·W(窄屏 0.105·W)。
//
// 这个文件不 import 任何东西;DOM 只在 BlackholePainter / runHandoff 里用(图标脚本不碰那两个)。

const TAU = Math.PI * 2
const N = 2048
const SOURCE_COUNT = 26000
const ORBIT_SIGN = -1

/** 原型的底色 #08090b。 */
export const BH_BACKGROUND = [8, 9, 11]
/** 快速光环(合成着色器里那条解析光带)的半径与截面 σ。 */
export const RING_RADIUS = 1.045
export const RING_SIGMA = 0.030
/** 原型里整幅图往下挪 0.16 个半屏:圆心在 58% 高处。 */
export const CENTER_Y = 0.58

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v
export function smoothstep(a, b, v) { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t) }
const fract = v => v - Math.floor(v)

function cubic(a, b, c, d, t) { const u = 1 - t; return [0, 1].map(k => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k]) }
function side(t) {
  if (t < .42) return cubic([0, 1.37], [.60, 1.37], [.98, 1.08], [1.20, .66], t / .42)
  if (t < .73) return cubic([1.20, .66], [1.41, .25], [1.38, .09], [1.88, .035], (t - .42) / .31)
  return cubic([1.88, .035], [2.5, -.004], [3.1, 0], [3.45, 0], (t - .73) / .27)
}

let built = null
/**
 * 造(一次,之后复用)那 20440 颗粒子与拱形路径。完全确定:同一个种子、同一套筛法,与原型逐颗对应。
 * @returns {{count:number,data:Float32Array,path:Float64Array,coreStart:number,coreSpan:number,rate:number}}
 */
export function createBlackhole() {
  if (built) return built
  const raw = []
  for (let i = 320; i >= 0; i--) { const p = side(i / 320); raw.push([-p[0], p[1]]) }
  for (let i = 1; i <= 320; i++) raw.push(side(i / 320))
  const travel = new Float64Array(raw.length)
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i], distance = Math.hypot((a[0] + b[0]) * .5, (a[1] + b[1]) * .5)
    travel[i] = travel[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.pow(Math.max(1, distance), 1.1)
  }
  const total = travel[travel.length - 1], path = new Float64Array(N * 2)
  let cursor = 1
  for (let i = 0; i < N; i++) {
    const target = total * i / (N - 1)
    while (cursor < travel.length - 1 && travel[cursor] < target) cursor++
    const t = (target - travel[cursor - 1]) / (travel[cursor] - travel[cursor - 1])
    for (let k = 0; k < 2; k++) path[i * 2 + k] = raw[cursor - 1][k] + (raw[cursor][k] - raw[cursor - 1][k]) * t
  }
  let coreFirst = 0, coreLast = N - 1
  while (path[coreFirst * 2] < -2.15) coreFirst++
  while (path[coreLast * 2] > 2.15) coreLast--
  const coreStart = coreFirst / (N - 1), coreSpan = (coreLast - coreFirst) / (N - 1)
  let seed = 230926
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const data = new Float32Array(SOURCE_COUNT * 8)
  let count = 0
  for (let i = 0; i < SOURCE_COUNT; i++) {
    const kind = i < 11600 ? 0 : i < 13600 ? 1 : i < 17600 ? 2 : i < 20000 ? 3 : i < 21000 ? 4 : i < 23000 ? 5 : 6
    const gaussian = Math.max(-2.7, Math.min(2.7, Math.sqrt(-2 * Math.log(Math.max(.00001, random()))) * Math.cos(TAU * random())))
    const particle = [random(), gaussian, random(), kind, .70 + Math.pow(random(), 2) * 2.25, .30 + random() * .70, .9 + random() * .2, random()]
    if (kind < 1.5 && Math.floor(Math.fround(particle[2]) * 5) >= 3) continue
    data.set(particle, count++ * 8)
  }
  built = { count, data, path, coreStart, coreSpan, rate: 3.8 / (total * coreSpan) }
  return built
}

function pathAt(bh, index, out, k) { const i = Math.max(0, Math.min(N - 1, index)); out[k] = bh.path[i * 2]; out[k + 1] = bh.path[i * 2 + 1] }
const scratch = new Float64Array(8)

/**
 * 第 i 颗粒子在 clock 秒时的样子(原型顶点着色器 main() 的非拖尾分支,逐行对应)。
 * out: { x, y, alpha, size, lum, kind }。alpha 是乘粒子像素覆盖率之前的值,size 是乘 uPixels 之前的值。
 * 返回 false 表示这一帧看不见(被黑洞挡住、在尾巴上淡出等)。
 */
export function placeParticle(bh, i, clock, out, grain = .96) {
  const d = bh.data, o = i * 8
  const ox = d[o], oy = d[o + 1], oz = d[o + 2], kind = d[o + 3], lx = d[o + 4], ly = d[o + 5], lz = d[o + 6], lw = d[o + 7]
  let lum = 1, alpha = 1, size = lx * grain, px, py
  if (kind < 1.5 || (kind > 3.5 && kind < 4.5) || kind > 5.5) {
    const crossAngle = lw * TAU
    const section = Math.sin(crossAngle) * Math.sqrt(oz)
    const lane = 1 + (.5 + .5 * section) * .38
    const layer = Math.min(4, Math.floor(oz * 5))
    let flowRate = 1 / Math.pow(lane, 1.85)
    const skin = .5 + .5 * Math.sin(crossAngle) * Math.sqrt(fract(oz * 5))
    const dust = kind > .5 && kind < 1.5 && layer > 1.5 && lw > .62
    if (kind < 1.5) {
      const depthIndex = layer + skin
      flowRate = 1.55 * Math.exp(-.9 * depthIndex) * (1 - .85 * smoothstep(1.75, 3, depthIndex))
      if (dust) flowRate = .008 + .008 * ly
    }
    const wing = kind >= 5.5 ? 1 : 0
    const echo = kind > 3.5 && kind < 4.5
    if (echo) flowRate = .16 * Math.exp(-2.6 * (.5 + .5 * section))
    const direction = echo ? ORBIT_SIGN : -ORBIT_SIGN
    const phase = fract(ox + direction * clock * bh.rate * lz * (wing ? bh.coreSpan : 1) * flowRate)
    const index = (wing ? phase : bh.coreStart + phase * bh.coreSpan) * 2047, lo = Math.floor(index), f = index - lo
    pathAt(bh, lo, scratch, 0); pathAt(bh, lo + 1, scratch, 2); pathAt(bh, lo - 3, scratch, 4); pathAt(bh, lo + 3, scratch, 6)
    px = scratch[0] + (scratch[2] - scratch[0]) * f; py = scratch[1] + (scratch[3] - scratch[1]) * f
    let tx = scratch[6] - scratch[4] + .000001, ty = scratch[7] - scratch[5]
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
    const nx = -ty, ny = tx
    const body = 1 - smoothstep(.9, 2.5, Math.abs(px))
    const depth = Math.cos(crossAngle)
    alpha *= .32 + .68 * Math.pow(depth * .5 + .5, 1.25)
    size *= .66 + .34 * (depth * .5 + .5)
    if (kind < 1.5) {
      let center = -.060, halfWidth = .125, light = 1
      if (layer > .5) { center = .20; halfWidth = .165; light = .86 }
      if (layer > 1.5) { center = .51; halfWidth = .200; light = .74 }
      const crossRadius = Math.sqrt(fract(oz * 5))
      const thickness = halfWidth * (.12 + .88 * body)
      const scale = 1 + center / 1.37
      px *= scale; py *= scale
      const push = Math.sin(crossAngle) * thickness * crossRadius + oy * (.002 + .004 * body)
      px += nx * push; py += ny * push
      lum = light; alpha *= 1.9; size *= 1.14
      if (kind > .5) { alpha *= .26; size *= .70 }
      if (dust) {
        const lift = .27 + .32 * ly + .06 * Math.sin(clock * .045 + ox * TAU)
        px += nx * lift; py += ny * lift
        alpha *= 1.7; size *= 1.35
      }
    } else {
      let spread = (.008 + .23 * body) * Math.sqrt(oz)
      if (wing) spread = (.014 + .035 * body) * Math.sqrt(oz)
      const push = Math.sin(crossAngle) * spread + oy * (.006 + .018 * body)
      px += nx * push; py += ny * push
    }
    if (kind < 1.5) alpha *= smoothstep(1.17, 1.20, Math.hypot(px, py))
    const heat = 1.55 / Math.pow(Math.max(Math.hypot(px, py), 1), .85)
    alpha *= heat * (1 - smoothstep(2.6, 3.45, Math.abs(px)))
    alpha *= smoothstep(0, .13, phase) * smoothstep(0, .13, 1 - phase)
    if (echo) { py = -py * .72; alpha *= .27; size *= .77 }
    if (wing) { alpha *= smoothstep(1.4, 1.9, Math.abs(px)) * 2.1; size *= .88 }
    if (Math.hypot(px, py) < 1.055) alpha = 0
  } else if (kind < 2.5 || kind > 4.5) {
    const r = 1.02 + Math.pow(oz, 1.55) * 5.8
    const orbitSpeed = 1.5 / Math.pow(r, 2.65) * (1 - .82 * smoothstep(1.2, 6.8, r))
    const angle = ox * TAU + ORBIT_SIGN * clock * orbitSpeed * lz
    px = Math.cos(angle) * r; py = Math.sin(angle) * r * .11 + oy * .022
    if (kind > 4.5) { py = Math.sin(angle) * r * .012 + oy * .004; size *= .74; alpha *= 1.65 }
    const shadow = Math.hypot(px / 1.015, py / 1.015)
    if (py > 0 && shadow < 1) alpha = 0
    alpha *= 1.1 * Math.pow(Math.max(0, 1 - r / 7), .6)
    alpha *= .67 + .33 * Math.pow(Math.sin(r * 20 + angle * .8), 2)
    if (py > 0) { alpha *= .32; size *= .72 }
  } else {
    const angle = ox * TAU + ORBIT_SIGN * clock * 48
    const r = 1.045 + oy * .030
    px = Math.cos(angle) * r; py = Math.sin(angle) * r
    size *= .96
    alpha *= py < 0 ? .06 : .22
  }
  const highlight = lw > .982 ? 1.8 : 1
  alpha = Math.min(1, alpha * ly * highlight)
  const wingExtension = .35 * Math.max(Math.abs(px) - 1.75, 0) * (1 - smoothstep(.10, .26, Math.abs(py)))
  px += Math.sign(px) * wingExtension
  if (kind < 1.5 && Math.floor(oz * 5) > 1.5) {
    const outerDepth = .5 + .5 * Math.sin(lw * TAU) * Math.sqrt(fract(oz * 5))
    const lowWing = 1 - smoothstep(.10, .90, Math.abs(py))
    px *= 1 + (.12 + (.24 - .12) * lowWing) * smoothstep(.25, 1, outerDepth)
  }
  out.x = px; out.y = py; out.alpha = alpha; out.size = size; out.lum = lum; out.kind = kind
  return alpha > .002
}

/**
 * 合成着色器里那条解析光环(快速粒子环的曝光平均):距圆心 d(单位半径)、高度 y 处的亮度。
 * 上半圈满亮,下半圈只剩 5.5%(被吸积盘挡着 —— 这就是「下方淡倒影」里那道弧)。
 */
export function ringLight(d, y) {
  const radial = (d - RING_RADIUS) / RING_SIGMA
  const face = .055 + (1 - .055) * smoothstep(-.045, .045, y)
  return 1.35 * Math.exp(-.5 * radial * radial) * face + .12 * Math.exp(-.5 * Math.pow(radial * .36, 2)) * face
}

/** 原型的像素尺度:uPixels = dpr·max(.6, W/1200);W 与光环半径 r 的关系是 r = .08W,所以 = max(.6, r/96)。 */
export function pixelScale(radius) { return Math.max(.6, radius / 96) }

// ─────────────────────────────── Canvas2D 画法(登录页、串联) ───────────────────────────────

function spriteCanvas(side) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(side, side) : Object.assign(document.createElement('canvas'), { width: side, height: side })
  return c
}

/**
 * 在一块 canvas 上画黑洞。**底是透明的**(页面底色透上来),深色主题用「相加」混合让光叠亮,
 * 浅色主题用墨色 source-over(与粒子球在浅色下变黑是同一个口径)。
 *
 * stride:每 stride 颗取一颗(20440 颗在 Canvas2D 里每帧画不起;3 ≈ 6800 颗,颗粒按 √stride 放大补亮度)。
 */
export class BlackholePainter {
  constructor(canvas, options = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.bh = createBlackhole()
    this.stride = Math.max(1, options.stride ?? 3)
    this.ink = options.ink ?? [255, 255, 255]
    this.additive = options.additive ?? true
    this.bloom = options.bloom ?? true
    this.grain = options.grain ?? 1
    this.view = { width: 0, height: 0, dpr: 1, radius: 0, cx: 0, cy: 0 }
    this.ring = null
    this.glow = null
    this.p = { x: 0, y: 0, alpha: 0, size: 0, lum: 1, kind: 0 }
    /** 最近几帧 paint() 的耗时(毫秒,指数平均)。串联按它给这台机器定飞几颗(adaptiveHandoffCount)。 */
    this.paintMs = 0
  }
  /** 版式:CSS 像素。radius/cx/cy 不给就按原型(r = .08W,窄屏 .105W;圆心 58% 高)。 */
  layout(view) {
    const width = Math.max(1, view.width), height = Math.max(1, view.height), dpr = Math.min(view.dpr ?? 1, 2)
    const radius = view.radius ?? width * (width <= 480 ? .105 : .08)
    this.view = { width, height, dpr, radius, cx: view.cx ?? width / 2, cy: view.cy ?? height * CENTER_Y }
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr)
    this.ring = null
    return this.view
  }
  /** 柔光用的软点:原型片元着色器 exp(-d²·3.4),d 从圆心 0 到边 1。 */
  softDot() {
    if (this.dot && this.dotInk === String(this.ink)) return this.dot
    const side = 32, image = spriteCanvas(side), ctx = image.getContext('2d'), data = ctx.createImageData(side, side)
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const qx = (x + .5) / side * 2 - 1, qy = (y + .5) / side * 2 - 1, k = (y * side + x) * 4
      data.data[k] = this.ink[0]; data.data[k + 1] = this.ink[1]; data.data[k + 2] = this.ink[2]
      data.data[k + 3] = Math.round(255 * Math.exp(-(qx * qx + qy * qy) * 3.4))
    }
    ctx.putImageData(data, 0, 0)
    this.dot = image; this.dotInk = String(this.ink)
    return image
  }
  setInk(ink, additive) { if (String(ink) !== String(this.ink) || additive !== this.additive) { this.ink = ink; this.additive = additive; this.ring = null } }
  /** 光环不随时间变,按当前版式预画一张。 */
  ringImage() {
    if (this.ring) return this.ring
    const { radius, dpr } = this.view, pad = radius * .5
    const side = Math.ceil((radius * RING_RADIUS + pad) * 2 * dpr)
    const image = spriteCanvas(side), ctx = image.getContext('2d'), data = ctx.createImageData(side, side), c = side / 2
    const [r, g, b] = this.ink
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const ux = (x + .5 - c) / (radius * dpr), uy = (c - y - .5) / (radius * dpr)
      const light = Math.min(1, ringLight(Math.hypot(ux, uy), uy))
      if (light < .004) continue
      const k = (y * side + x) * 4
      data.data[k] = r; data.data[k + 1] = g; data.data[k + 2] = b; data.data[k + 3] = Math.round(light * 255)
    }
    ctx.putImageData(data, 0, 0)
    this.ring = { image, side: side / dpr }
    return this.ring
  }
  /**
   * 画一帧。opts.alpha 整体透明度;opts.ringAlpha 光环单独的透明度(串联时先暗环);
   * opts.skip(i) 为真的粒子不画(已经「飞走」的那些)。
   */
  paint(clock, opts = {}) {
    const began = nowMs()
    this.paintFrame(clock, opts)
    const spent = nowMs() - began
    this.paintMs = this.paintMs ? this.paintMs * .8 + spent * .2 : spent
  }
  paintFrame(clock, opts) {
    const { ctx, bh, view } = this, { width, height, dpr, radius, cx, cy } = view
    const alphaAll = opts.alpha ?? 1, ringAlpha = (opts.ringAlpha ?? 1) * alphaAll
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (alphaAll <= .002) return
    const blend = this.additive ? 'lighter' : 'source-over'
    const pixels = pixelScale(radius) * this.grain, boost = Math.sqrt(this.stride)
    const p = this.p, ink = `rgb(${this.ink.join(',')})`
    // 柔光:1/3 分辨率离屏,每 4 颗取一颗画软点,放大贴回来时双线性插值就是模糊。
    if (this.bloom && this.additive) {
      const gw = Math.max(1, Math.round(width / 3)), gh = Math.max(1, Math.round(height / 3))
      if (!this.glow || this.glow.width !== gw || this.glow.height !== gh) { this.glow = spriteCanvas(1); this.glow.width = gw; this.glow.height = gh }
      const g = this.glow.getContext('2d'), dot = this.softDot()
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, gw, gh); g.globalCompositeOperation = 'lighter'
      const step = this.stride * 4
      for (let i = 0; i < bh.count; i += step) {
        if (opts.skip?.(i)) continue
        if (!placeParticle(bh, i, clock, p)) continue
        // 原型:1/3 分辨率、点径 ×7、高斯 exp(-d²·3.4)·.15。每 4 颗取一颗,亮度 ×4 补回来。
        const s = Math.max(1.5, p.size * pixels * 7 / 3)
        g.globalAlpha = Math.min(1, p.alpha * p.lum * .15 * 4 * Math.min(1, (p.size * pixels) ** 2))
        g.drawImage(dot, (cx + p.x * radius) / 3 - s / 2, (cy - p.y * radius) / 3 - s / 2, s, s)
      }
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alphaAll * .55 * .9
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(this.glow, 0, 0, width, height)
    }
    if (ringAlpha > .002) {
      const ring = this.ringImage()
      ctx.globalCompositeOperation = blend; ctx.globalAlpha = ringAlpha
      ctx.drawImage(ring.image, cx - ring.side / 2, cy - ring.side / 2, ring.side, ring.side)
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = ink
    for (let i = 0; i < bh.count; i += this.stride) {
      if (opts.skip?.(i)) continue
      if (!placeParticle(bh, i, clock, p)) continue
      const size = p.size * pixels * boost ** .5
      const cover = Math.min(1, size * size)
      const s = Math.max(.6, size)
      ctx.globalAlpha = Math.min(1, p.alpha * p.lum * cover * alphaAll * (this.additive ? 1 : .85))
      ctx.fillRect(cx + p.x * radius - s / 2, cy - p.y * radius - s / 2, s, s)
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
  }
  /**
   * 串联用:取 n 颗**看得见的**粒子此刻的屏幕位置(CSS 像素,相对 canvas 左上)与切向速度。
   * 优先拱形吸积盘里亮的那些(kind 0),不够再从地平线补;按亮度挑,确定性。
   *
   * 只在**这块画布真画出来的那几颗**里挑(每 stride 颗一颗)—— 2026-09-24 去卡顿:原来扫全部 20440 颗、每颗算两遍,
   * 登录那一下在主线程上占 20ms(4 倍降速 80ms);而且挑中一颗没画出来的,「飞走」时黑洞上也不会少一颗。
   * candidates:登录页空闲时预先挑好的一批下标(candidateJob),给了就只看这几颗,点登录那一刻几乎不花时间。
   */
  snapshot(clock, n, candidates) {
    const { bh, view } = this, { radius, cx, cy } = view, p = this.p, pixels = pixelScale(radius) * this.grain
    const pool = []
    const visit = i => {
      const kind = bh.data[i * 8 + 3]
      if (kind === 3 || kind === 4) return
      if (!placeParticle(bh, i, clock, p) || p.alpha < .12) return
      const x = p.x, y = p.y, alpha = p.alpha * p.lum, size = p.size * pixels
      placeParticle(bh, i, clock + .05, p)
      pool.push({ i, x: cx + x * radius, y: cy - y * radius, vx: (p.x - x) * radius / .05, vy: -(p.y - y) * radius / .05, size: Math.max(1, size * 1.4), alpha: Math.min(1, alpha), arch: kind < 1.5 ? 1 : 0 })
    }
    if (candidates) for (const i of candidates) visit(i)
    if (!candidates || pool.length < n) {
      const seen = candidates ? new Set(candidates) : null
      for (let i = 0; i < bh.count; i += this.stride) if (!seen?.has(i)) visit(i)
    }
    pool.sort((a, b) => (b.arch - a.arch) || (b.alpha - a.alpha) || (a.i - b.i))
    return pool.slice(0, Math.min(n, pool.length))
  }
}

const nowMs = () => (typeof performance !== 'undefined' ? performance : Date).now()

/**
 * 登录页空闲时预先挑候选(2026-09-24 去卡顿):按 snapshot 同一个口径(拱形优先、亮的优先)挑 1.5n 颗,
 * 点登录那一刻 snapshot 只重算这 1.5n 颗。粒子沿拱慢慢流,候选隔几秒重挑一次(prepareHandoff 里)。
 * 生成器:每 CHUNK 颗让一次,由调用方按空闲时间片推进,不在主线程上一口气跑完。
 */
export function* candidateJob(painter, clock, n) {
  const { bh } = painter, p = { x: 0, y: 0, alpha: 0, size: 0, lum: 1, kind: 0 }, pool = []
  for (let i = 0, k = 0; i < bh.count; i += painter.stride, k++) {
    if (k % 256 === 255) yield
    const kind = bh.data[i * 8 + 3]
    if (kind === 3 || kind === 4) continue
    if (!placeParticle(bh, i, clock, p) || p.alpha < .12) continue
    pool.push([kind < 1.5 ? 1 : 0, p.alpha * p.lum, i])
  }
  pool.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (a[2] - b[2]))
  return pool.slice(0, Math.ceil(n * 1.5)).map(e => e[2])
}

// ─────────────────────────────── 串联:黑洞 → 事务官的粒子球 ───────────────────────────────

/** 总时长(毫秒)。维护者给的范围 1.5–2.5 秒。 */
export const HANDOFF_MS = 2000
/** 「减少动效」开着:不飞粒子,黑洞淡出、球淡入,0.6 秒。 */
export const HANDOFF_REDUCED_MS = 600
/** 分镜(占总时长的比例)。 */
export const HANDOFF_BEATS = Object.freeze({
  /** 0 → release:黑洞整体淡出(光环先暗),选中的粒子脱离轨道、顺着切向甩出去。 */
  release: .30,
  /** 每颗粒子起飞的错开范围;起飞后飞 flight 这么久到达球面。release·.35 + stagger + flight ≤ settle:成形前全员到齐。 */
  stagger: .22,
  flight: .45,
  /** settle → 1:粒子已在球面上跟着球转,overlay 淡出、真的球淡入(交叉淡化)。 */
  settle: .78,
})

/**
 * 新屏的重初始化(粒子球的渲染器、舞台)让到这一刻之后再做(占总时长的比例):脱离段(黑洞淡出、粒子甩出)
 * 那 0.6 秒最显眼,也是原来卡住的地方;到这时粒子都在飞,每帧只画几百个点,主线程有空。
 * 成形段(0.78)之前球必须已经在画 —— 让出去的活儿在这之后按空闲时间一件一件做,1.2 秒绰绰有余。
 */
export const HANDOFF_DEFER_UNTIL = .30

/**
 * 飞几颗(2026-09-24 去卡顿):按这台机器上登录页黑洞每帧的实际耗时降级。
 * 画一帧 ≤ 8ms 照原数;≥ 24ms(慢机器 / 老手机 WebView)只飞一半;中间线性。取整到 10。
 */
export function adaptiveHandoffCount(base, paintMs) {
  if (!(paintMs > 8)) return base
  const k = 1 - .5 * Math.min(1, (paintMs - 8) / 16)
  return Math.max(10, Math.round(base * k / 10) * 10)
}

/**
 * 串联动画的状态机(纯函数,按经过的毫秒算)。
 * phase:release(脱离)→ fly(飞行)→ settle(成形,交叉淡化)→ done;减少动效:fade → done。
 * heroAlpha:overlay 里那份黑洞的透明度;overlayAlpha:飞行粒子层的透明度;orbAlpha:真的粒子球的透明度。
 */
export function handoffFrame(elapsed, reduced = false) {
  if (reduced) {
    const t = clamp01(elapsed / HANDOFF_REDUCED_MS)
    return { phase: t >= 1 ? 'done' : 'fade', t, heroAlpha: 1 - smoothstep(0, .7, t), overlayAlpha: 0, orbAlpha: smoothstep(.3, 1, t), done: t >= 1 }
  }
  const t = clamp01(elapsed / HANDOFF_MS), b = HANDOFF_BEATS
  const phase = t >= 1 ? 'done' : t < b.release ? 'release' : t < b.settle ? 'fly' : 'settle'
  return {
    phase, t,
    heroAlpha: 1 - smoothstep(0, b.release, t),
    overlayAlpha: 1 - smoothstep(b.settle, 1, t),
    orbAlpha: smoothstep(b.settle, 1, t),
    done: t >= 1,
  }
}

/** 第 k 颗(共 n 颗)这一刻飞到了哪儿:0 = 还在黑洞里,1 = 到了球面。按起点到圆心的距离错开,里圈先走。 */
export function flightProgress(t, k, n) {
  const b = HANDOFF_BEATS, delay = n > 1 ? b.stagger * k / (n - 1) : 0
  const u = clamp01((t - b.release * .35 - delay) / b.flight)
  return u * u * (3 - 2 * u)
}

/**
 * 起点与终点配对:两边都按绕各自圆心的角度排序,一一对上 —— 粒子大体平行地飞,不交叉成一团乱麻。
 * 返回 order[k] = 终点下标,对应 sources[k]。确定性。
 */
export function pairByAngle(sources, sourceCenter, targets, targetCenter) {
  const angle = (p, c) => Math.atan2(p.y - c.y, p.x - c.x)
  const s = sources.map((p, i) => [angle(p, sourceCenter), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const d = targets.map((p, i) => [angle(p, targetCenter), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const order = new Array(sources.length)
  for (let k = 0; k < s.length; k++) order[s[k][1]] = d[Math.floor(k * d.length / s.length)][1]
  return order
}

/** 三次贝塞尔:从起点顺切向甩出,再从球外侧落回球面。 */
export function flightPoint(src, dst, dstCenter, u) {
  const lead = .35
  const p1x = src.x + (src.vx ?? 0) * lead, p1y = src.y + (src.vy ?? 0) * lead
  const ox = dst.x - dstCenter.x, oy = dst.y - dstCenter.y
  const p2x = dst.x + ox * .9, p2y = dst.y + oy * .9 - 30
  const v = 1 - u
  return {
    x: v * v * v * src.x + 3 * v * v * u * p1x + 3 * v * u * u * p2x + u * u * u * dst.x,
    y: v * v * v * src.y + 3 * v * v * u * p1y + 3 * v * u * u * p2y + u * u * u * dst.y,
  }
}

/** 终点那颗核心先空跑几步到待命态(1 秒,60 步)。 */
export const ORB_WARM_STEPS = 60

/**
 * 终点:事务官的粒子球。**用的就是她的核心**(调用方把 SwarmV4 类传进来 —— 两端各自 import 自己那份逐字同源的 core.js),
 * 同一份设置、待命态,投影公式与 SwarmRenderer.paint() 一字不差:R = min(W,H)·.32·bodySize,p = 4.2/(4.2−z)。
 * 取 n 颗均匀分布的(每 count/n 颗取一颗)。
 *
 * 预热 60 步是这里最贵的一块(3600 颗 × 60 步,4 倍降速下 90ms)。options.lazy:先不热,
 * 由 warm(deadline) 在登录页空闲时一步一步做(prepareHandoff);没热完就开跑时 runHandoff 补齐。
 */
export function orbTargets(SwarmClass, settings, n, options = {}) {
  const swarm = new SwarmClass(settings.count ?? 3600)
  swarm.configure(settings); swarm.setMode('idle')
  let warmed = 0
  const warm = (more = () => true) => {
    while (warmed < ORB_WARM_STEPS && more()) { swarm.step(1 / 60); warmed++ }
    return warmed >= ORB_WARM_STEPS
  }
  if (!options.lazy) warm()
  const every = Math.max(1, Math.floor(swarm.count / n)), picks = []
  for (let i = 0; i < swarm.count && picks.length < n; i += every) picks.push(i)
  return {
    count: picks.length,
    warm,
    get warmed() { return warmed >= ORB_WARM_STEPS },
    step(dt) { swarm.step(Math.min(.05, Math.max(0, dt)), false) },
    /** rect:球那块 canvas 的屏幕矩形(CSS 像素)。 */
    project(rect) {
      const s = swarm.settings, R = Math.min(rect.width, rect.height) * .32 * (s.bodySize ?? 1)
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
      return picks.map(i => {
        const x = swarm.positions[i * 3], y = swarm.positions[i * 3 + 1], z = swarm.positions[i * 3 + 2]
        const p = 4.2 / (4.2 - z), depth = clamp01((z + 1) / 2)
        return {
          x: cx + x * R * p, y: cy + y * R * p,
          size: swarm.sizes[i] * (.34 + depth * .94) * p * (s.particleSize ?? 1),
          alpha: Math.min(1, (.075 + depth ** 2.1 * .84) * (s.particleBrightness ?? 1)),
        }
      })
    },
    center(rect) { return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } },
  }
}

// ─────────────────────────────── 让路:串联起步那一段,新屏的重活往后排 ───────────────────────────────

const launch = { active: false, waiters: [], timer: 0, win: null }

/** 串联是不是还在「起步」(脱离段):这时新屏的重初始化应该往后让(afterHandoffLaunch)。 */
export function handoffLaunching() { return launch.active }

/**
 * 串联起步期间把 cb 往后排(2026-09-24 去卡顿):到 HANDOFF_DEFER_UNTIL 之后,**每个空闲时间片只放一件**,
 * 免得两颗球的初始化挤成一个长任务;串联提前结束 / 取消也会放行。不在串联里:当场同步调用。
 * 返回取消函数(组件卸载时调)。
 */
export function afterHandoffLaunch(cb) {
  if (!launch.active) { cb(); return () => {} }
  const waiter = { cb }
  launch.waiters.push(waiter)
  return () => { waiter.cb = null }
}

function idle(win, cb, timeout) {
  if (typeof win.requestIdleCallback === 'function') { const id = win.requestIdleCallback(cb, { timeout }); return () => win.cancelIdleCallback?.(id) }
  const id = setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: true }), 16)
  return () => clearTimeout(id)
}

function releaseWaiters() {
  if (!launch.active) return
  launch.active = false
  clearTimeout(launch.timer)
  const win = launch.win ?? (typeof window !== 'undefined' ? window : null)
  const next = () => {
    let waiter
    while ((waiter = launch.waiters.shift()) && !waiter.cb) { /* 已取消的跳过 */ }
    if (!waiter) return
    try { waiter.cb() } catch { /* 一件坏了不拦后面的 */ }
    if (launch.waiters.length && win) idle(win, next, 120); else next()
  }
  if (win) idle(win, next, 120); else next()
}

function beginLaunch(win, holdMs) {
  launch.win = win
  if (launch.active) clearTimeout(launch.timer)
  launch.active = true
  launch.timer = setTimeout(releaseWaiters, holdMs)
}

// ─────────────────────────────── 预备:登录页空闲时把重活做掉 ───────────────────────────────

/**
 * 登录页挂上之后调一次(2026-09-24 去卡顿)。在空闲时间片里:
 *   ① 造终点那颗核心并预热 60 步(原来点登录那一下同步做,4 倍降速下 90ms);
 *   ② 从登录页黑洞此刻画出来的粒子里挑候选(原来扫 20440 颗 × 2 遍);隔 refreshMs 重挑一次。
 * opts: { SwarmClass, settings, count, painter: () => BlackholePainter|null, clock: () => number, window?, refreshMs?,
 *         fallbackRect?: () => rect|null, fallbackStride? }   ③ 屏上没有黑洞时的起点也先画好(手机扫码页 / 账号页)
 * 返回 { targets(), candidates(), cancel() }:还没备好的就是 null,runHandoff 会自己补上(与改之前一样,只是慢)。
 */
export function prepareHandoff(opts) {
  const win = opts.window ?? window
  let targets = null, candidates = null, candidatesAt = -Infinity, job = null, cancelIdle = null, dead = false, surface = null, source = null
  const refreshMs = opts.refreshMs ?? 4000
  const work = deadline => {
    cancelIdle = null
    if (dead) return
    const more = () => deadline.timeRemaining() > 2
    let unfinished = false
    try {
      if (!targets) targets = orbTargets(opts.SwarmClass, opts.settings, opts.count, { lazy: true })
      if (!targets.warmed) targets.warm(more)
      // 飞行层那块全屏画布也先造好、先分配(2560×1600 的画布第一次画要几毫秒到十几毫秒)。
      if (targets.warmed && more() && !surfaceFits(surface, win)) surface = createSurface(win)
      // 屏上没有黑洞时的起点(手机扫码页 / 账号页):同一块位置、同一刻(12 秒),整份先画好。
      const fallback = opts.fallbackRect?.()
      const dpr = Math.min(win.devicePixelRatio || 1, 2)
      if (fallback && targets.warmed && more() && !(source && sameRect(source.rect, fallback) && source.dpr === dpr)) {
        source = buildSource({ rect: fallback, dpr, clock: 12, n: opts.count, stride: opts.fallbackStride ?? 3 })
      }
      unfinished = !surfaceFits(surface, win) || (!!fallback && !(source && sameRect(source.rect, fallback) && source.dpr === dpr))
      const painter = opts.painter?.()
      if (targets.warmed && painter && !job && nowMs() - candidatesAt >= refreshMs) job = candidateJob(painter, (opts.clock?.() ?? 12) + .3, opts.count)
      while (job && more()) {
        const step = job.next()
        if (step.done) { candidates = step.value; candidatesAt = nowMs(); job = null }
      }
    } catch { dead = true; return }
    // 都备好了就歇到下一次重挑;没备好接着要空闲时间。
    // 屏上没有黑洞(手机扫码页)时半秒看一眼它出来没有;有就按 refreshMs 重挑。
    const wait = !targets.warmed || job || unfinished ? 0 : !opts.painter?.() ? 500 : Math.max(50, refreshMs - (nowMs() - candidatesAt))
    if (wait === 0) cancelIdle = idle(win, work, 1000)
    else { const t = setTimeout(() => { if (!dead) cancelIdle = idle(win, work, 1000) }, wait); cancelIdle = () => clearTimeout(t) }
  }
  cancelIdle = idle(win, work, 1000)
  return {
    targets: () => targets,
    candidates: () => candidates,
    surface: () => surfaceFits(surface, win) ? surface : null,
    source: () => source,
    cancel() { dead = true; cancelIdle?.() },
  }
}

const sameRect = (a, b) => !!a && !!b && Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1

/**
 * 屏上没有黑洞时现造一份起点:一块离屏画布上的黑洞静帧(去掉要飞的那几颗)+ 要飞的那几颗(屏幕坐标)。
 * prepareHandoff 在空闲时按 fallbackRect 先造好;runHandoff 拿不到现成的才在点登录那一刻造。
 */
function buildSource({ rect, dpr, clock, n, candidates, stride = 3, ink, additive, bloom, view }) {
  const off = spriteCanvas(1); off.width = Math.max(1, Math.round(rect.width * dpr)); off.height = Math.max(1, Math.round(rect.height * dpr))
  const painter = new BlackholePainter(off, { stride, ink: ink ?? [255, 255, 255], additive: additive ?? true, bloom: bloom ?? true })
  painter.layout({ width: rect.width, height: rect.height, dpr, ...(view ? { radius: view.radius, cx: view.cx, cy: view.cy } : { radius: rect.width <= 480 ? Math.min(rect.width * .105, rect.height * .26) : Math.min(rect.width * .08, rect.height * .3) }) })
  const sources = n ? painter.snapshot(clock, n, candidates ?? undefined).map(p => ({ ...p, x: p.x + rect.left, y: p.y + rect.top })) : []
  const flying = new Set(sources.map(p => p.i))
  painter.paint(clock, { skip: i => flying.has(i) })
  return { rect, dpr, painter, sources }
}

/** 飞行层:一块盖满窗口的画布(不拦点击)。 */
function createSurface(win) {
  const doc = win.document, W = win.innerWidth, H = win.innerHeight, dpr = Math.min(win.devicePixelRatio || 1, 2)
  const canvas = doc.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.className = 'brand-handoff'
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000'
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
  const ctx = canvas.getContext('2d')
  ctx?.clearRect(0, 0, canvas.width, canvas.height)
  return { canvas, ctx, W, H, dpr }
}
function surfaceFits(surface, win) {
  return !!surface && !surface.canvas.isConnected && surface.W === win.innerWidth && surface.H === win.innerHeight && surface.dpr === Math.min(win.devicePixelRatio || 1, 2)
}

// ─────────────────────────────── 真机打点 + 起跑闸门 + 自动降级(2026-09-24 第五轮) ───────────────────────────────
//
// 维护者 0.2.79 真机:「电脑和手机的黑洞→粒子球变化,还是卡」。无头浏览器里已测不到起步段长任务,真机(Mac 壳 WKWebView、
// Android WebView)仍卡 —— 所以:① 每次串联记 3 秒的帧间隔 / 长任务(只记数字),交给两端经已有通道回报;
// ② 起跑闸门:连着两帧顺了才开始计时(新屏挂载那一下落在「静帧」上,而不是飞到一半顿住);
// ③ 真机首帧 / 起步段超标:自动退成「黑洞淡出 + 球淡入」(不飞粒子)。

/** 打点窗口:串联开始后多久(毫秒)。 */
export const PERF_WINDOW_MS = 3000
/** 起跑闸门:连着几帧、每帧不超过多少毫秒,才算「顺了」。 */
export const GATE_SMOOTH_FRAMES = 2
export const GATE_SMOOTH_MS = 34
/** 闸门最多等多久;等满还没顺 → 这台机器此刻太忙,不飞粒子(降级)。 */
export const GATE_MAX_MS = 450
/** 起步段(脱离,粒子还没飞远)里出现这么长的一帧 → 降级。 */
export const DEGRADE_GAP_MS = 120
/** 登录页黑洞一帧画这么久(指数平均)→ 一开始就不飞粒子。 */
export const SLOW_PAINT_MS = 40

/** 按登录页黑洞帧耗时定这一次飞不飞:'fly' | 'fade'。 */
export function handoffPlan(paintMs) { return paintMs >= SLOW_PAINT_MS ? 'fade' : 'fly' }

/** 帧间隔 → 摘要(纯函数)。gaps:相邻两帧的间隔(毫秒)。 */
export function summarizeFrames(gaps) {
  const sorted = gaps.slice().sort((a, b) => a - b)
  const pick = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0
  return {
    frames: gaps.length,
    maxGapMs: Math.round(sorted.length ? sorted[sorted.length - 1] : 0),
    p95GapMs: Math.round(pick(.95)),
    medianGapMs: Math.round(pick(.5)),
    over50: gaps.filter(g => g > 50).length,
    over100: gaps.filter(g => g > 100).length,
  }
}

const perf = { last: null, listeners: [] }
/** 最近一次串联的打点(没有就 null)。 */
export function lastHandoffPerf() { return perf.last }
/** 订阅打点(每次串联结束后 3 秒左右来一份)。返回取消函数。 */
export function onHandoffPerf(cb) {
  perf.listeners.push(cb)
  return () => { perf.listeners = perf.listeners.filter(one => one !== cb) }
}
function publishPerf(report) {
  perf.last = report
  for (const cb of perf.listeners.slice()) { try { cb(report) } catch { /* 回报坏了不拦别的 */ } }
}

/**
 * 串联开始时起一个探针:自己的 rAF 记 PERF_WINDOW_MS 内每帧间隔;浏览器支持就再挂 longtask 观察(Safari / WKWebView 不支持 → null)。
 * meta 里的字段(mode、count、syncMs、gateMs、firstFrameMs、degraded…)串联过程中由 runHandoff 填。
 */
function startPerfProbe(win, meta) {
  const now = () => (win.performance ?? Date).now()
  const t0 = now()
  const gaps = []
  let last = 0, frame = 0, done = false, observer = null
  const tasks = { n: 0, max: 0, total: 0, supported: false }
  try {
    const PO = win.PerformanceObserver
    if (PO && (PO.supportedEntryTypes ?? []).includes('longtask')) {
      observer = new PO(list => {
        for (const e of list.getEntries()) {
          if (e.startTime < t0 - 50) continue
          tasks.n++; tasks.total += e.duration; tasks.max = Math.max(tasks.max, e.duration)
        }
      })
      observer.observe({ type: 'longtask', buffered: true })
      tasks.supported = true
    }
  } catch { observer = null }
  const finish = () => {
    if (done) return
    done = true
    if (frame) win.cancelAnimationFrame?.(frame)
    try { observer?.disconnect() } catch { /* 无妨 */ }
    publishPerf({
      v: 1,
      at: new Date().toISOString(),
      ...meta,
      ...summarizeFrames(gaps),
      longtasks: tasks.supported ? tasks.n : null,
      longtaskMaxMs: tasks.supported ? Math.round(tasks.max) : null,
      longtaskTotalMs: tasks.supported ? Math.round(tasks.total) : null,
      viewport: `${win.innerWidth}x${win.innerHeight}@${Math.min(win.devicePixelRatio || 1, 3)}`,
    })
  }
  const tick = at => {
    frame = 0
    if (done) return
    const t = typeof at === 'number' ? at : now()
    if (last) gaps.push(t - last)
    last = t
    if (t - t0 >= PERF_WINDOW_MS) { finish(); return }
    frame = win.requestAnimationFrame(tick)
  }
  if (typeof win.requestAnimationFrame === 'function') frame = win.requestAnimationFrame(tick)
  // rAF 被节流(窗口藏起来)也按时交一份。
  setTimeout(finish, PERF_WINDOW_MS + 500)
  return { finish }
}

// ─────────────────────────────── 跑一次串联 ───────────────────────────────

/**
 * 跑一次串联(浏览器里)。**不拦任何东西**:overlay 是 pointer-events:none 的一层画布,
 * 底下的新屏照常渲染、照常能点;真的球在飞行期间透明(CSS 变量 --brand-handoff-orb),成形时淡入。
 *
 * opts:
 *   from        { painter, rect, clock } 登录页上那份黑洞(没有就在 fallbackRect 里现造一份)
 *   findOrb     () => HTMLCanvasElement | null   新屏上的球(找到之前粒子往 fallback 位置聚;找到了就一直用它,不每帧翻 DOM)
 *   targets     orbTargets(...) 的返回值(预热没做完的这里补齐)
 *   candidates  prepareHandoff 预先挑好的候选下标
 *   surface     prepareHandoff 预先造好的飞行层画布(窗口大小变了就现造)
 *   source      prepareHandoff 预先画好的起点(屏上没有黑洞时;位置对不上就现造)
 *   stride      现造起点时每几颗画一颗(默认 3;手机 5)
 *   ink         终点粒子的颜色 [r,g,b](深色 = 白),或 (orbCanvas) => [r,g,b](找到球时取一次)
 *   reduced     减少动效
 *   count       飞几颗(默认 700)
 * 返回 { cancel(), done: Promise<void> }。
 *
 * 2026-09-24 去卡顿:点登录那一下同步做的事只剩「挑 n 颗 + 在登录页那块画布上补画一帧 + 拷成静帧」,
 * 不再另造一个画家、不重画光环、不扫全部粒子;飞行前 0.2 秒粒子还没离开原位,不找球、不推核心。
 */
export function runHandoff(opts) {
  const doc = opts.document ?? document, win = doc.defaultView ?? window, root = doc.documentElement
  const now = () => (win.performance ?? Date).now()
  const called = now()
  let reduced = opts.reduced === true
  // 打点(只记数字);gate:连着两帧顺了才开始计时(两端产品代码开,用例默认关)。
  const meta = { side: opts.side ?? '', mode: reduced ? 'fade' : 'fly', count: 0, paintMs: Math.round((opts.from?.painter?.paintMs ?? 0) * 10) / 10, syncMs: 0, gateMs: 0, firstFrameMs: null, degraded: false, degradeReason: '' }
  if (opts.probe !== false) startPerfProbe(win, meta)
  let gated = opts.gate === true && !reduced, gateSmooth = 0, heroScale = 1
  const surface = opts.surface && surfaceFits(opts.surface, win) ? opts.surface : createSurface(win)
  const { canvas, ctx, W, H, dpr } = surface
  doc.body.appendChild(canvas)
  root.dataset.brandHandoff = reduced ? 'fade' : 'fly'
  root.style.setProperty('--brand-handoff-orb', '0')
  beginLaunch(win, reduced ? 0 : HANDOFF_MS * HANDOFF_DEFER_UNTIL)
  // 源:登录页那份黑洞的静帧(画进一张离屏图,之后只调透明度),加上要飞的那几颗。
  const rect = opts.from?.rect ?? opts.fallbackRect ?? { left: 0, top: 0, width: W, height: Math.min(H * .35, 320) }
  const clock = opts.from?.clock ?? 12
  const n = reduced ? 0 : (opts.count ?? 700)
  meta.count = n
  const live = opts.from?.painter
  const liveCanvas = live?.canvas
  // 登录页那块画布还在、大小对得上:直接用它的画家(光环图、柔光图都是现成的),补画一帧去掉要飞的那几颗再拷走。
  const reuse = live && liveCanvas && liveCanvas.width > 0 && Math.abs(live.view.width - rect.width) < 1 && Math.abs(live.view.height - rect.height) < 1
  // 屏上没有黑洞(手机扫码页 / 账号页):用 prepareHandoff 空闲时预先画好的那份(同一块位置、同一刻),没有才现造。
  const ready = !reuse && !live && opts.source && sameRect(opts.source.rect, rect) && opts.source.dpr === dpr ? opts.source : null
  const built = reuse || ready ? null : buildSource({ rect, dpr, clock, n, candidates: opts.candidates, stride: live?.stride ?? opts.stride ?? 3, ink: live?.ink, additive: live?.additive, bloom: live?.bloom, view: live?.view })
  const painter = reuse ? live : (ready ?? built).painter
  const sources = ready ? ready.sources.slice(0, n) : built ? built.sources : n ? painter.snapshot(clock, n, opts.candidates ?? undefined).map(p => ({ ...p, x: p.x + rect.left, y: p.y + rect.top })) : []
  const flying = new Set(sources.map(p => p.i))
  let hero = painter.canvas, repaint = 0
  if (ready && sources.length < ready.sources.length) {
    // 这次飞得比预备的少(降级了):没飞的那几颗补画回静帧里,别在黑洞上留洞。
    try { painter.paint(clock, { skip: i => flying.has(i) }) } catch { /* 留着预备的那帧 */ }
  }
  if (reuse) {
    // 登录页马上卸载,它那块画布跟着没;先原样拷一份(上一帧,含要飞的那几颗 —— 它们 0.2 秒内还在原位,叠在一起看不出)。
    // 「去掉要飞的那几颗」那一遍重画放到下一个任务里做,不和点登录挤在同一个长任务里(2026-09-24 去卡顿)。
    hero = spriteCanvas(1); hero.width = liveCanvas.width; hero.height = liveCanvas.height
    const copy = hero.getContext('2d')
    copy.drawImage(liveCanvas, 0, 0)
    if (flying.size) repaint = setTimeout(() => {
      repaint = 0
      if (finished) return
      try {
        painter.paint(clock, { skip: i => flying.has(i) })
        copy.setTransform(1, 0, 0, 1, 0, 0); copy.clearRect(0, 0, hero.width, hero.height); copy.drawImage(liveCanvas, 0, 0)
      } catch { /* 补画不成就留着原样那一帧 */ }
    }, 0)
  }
  const sourceCenter = { x: rect.left + painter.view.cx, y: rect.top + painter.view.cy }
  const sourceInk = painter.ink.slice()
  const inkOf = typeof opts.ink === 'function' ? opts.ink : () => opts.ink ?? [255, 255, 255]
  const targets = opts.targets
  if (n && targets && targets.warmed === false) targets.warm()
  const fallbackOrb = { left: sourceCenter.x - 100, top: sourceCenter.y - 100, width: 200, height: 200 }
  // 粒子最早什么时候离开原位(第 0 颗的起飞时刻);在那之前不需要终点。
  const liftOff = HANDOFF_BEATS.release * .35
  let order = null, start = now(), last = start, frame = 0, finished = false, resolveDone, firstTick = true, lastHeroAlpha = 1
  let orbEl = null, orbInk = null, lookups = 0
  const done = new Promise(r => { resolveDone = r })
  const finish = () => {
    if (finished) return
    finished = true
    if (frame) win.cancelAnimationFrame(frame)
    clearTimeout(guard); clearTimeout(repaint)
    meta.mode = meta.degraded ? 'degraded' : reduced ? 'fade' : 'fly'
    canvas.remove()
    delete root.dataset.brandHandoff
    root.style.removeProperty('--brand-handoff-orb')
    releaseWaiters()
    resolveDone()
  }
  const findOrb = () => {
    if (orbEl && orbEl.isConnected) return orbEl
    // 找不到时隔两帧再翻一次 DOM(querySelectorAll + 量尺寸会逼一次排版)。
    if (lookups++ % 2 === 0) {
      const found = opts.findOrb?.() ?? null
      if (found !== orbEl) { orbEl = found; orbInk = null }
    }
    return orbEl
  }
  // 降级:不飞粒子,从此刻起走「黑洞淡出 + 球淡入」(减少动效那条),黑洞从当前透明度接着淡,不跳回满。
  const degrade = (reason, at) => {
    if (reduced) return
    reduced = true
    meta.degraded = true; meta.degradeReason = reason
    heroScale = lastHeroAlpha
    start = at
    gated = false
    releaseWaiters()
    clearTimeout(guard)
    guard = setTimeout(finish, HANDOFF_REDUCED_MS + 800)
  }
  const tick = () => {
    frame = 0
    if (finished) return
    const at = now(), gap = at - last
    if (firstTick) { firstTick = false; meta.firstFrameMs = Math.round(at - called); if (!gated && !reduced && at - called > DEGRADE_GAP_MS) degrade('first-frame', at) }
    else if (gated) gateSmooth = gap <= GATE_SMOOTH_MS ? gateSmooth + 1 : 0
    if (gated) {
      // 闸门没开:黑洞原样摆着(静帧),不计时。顺了 → 从这一帧起算;等满还没顺 → 降级。
      if (gateSmooth >= GATE_SMOOTH_FRAMES) { gated = false; meta.gateMs = Math.round(at - called); start = at; last = at; beginLaunch(win, HANDOFF_MS * HANDOFF_DEFER_UNTIL) }
      else if (at - called >= GATE_MAX_MS) { meta.gateMs = Math.round(at - called); degrade('gate-timeout', at) }
      else start = at
    }
    else if (!reduced && at - start < HANDOFF_MS * HANDOFF_BEATS.release * .5 && gap > DEGRADE_GAP_MS) degrade('slow-frame', at)
    const elapsed = at - start, dt = Math.max(0, at - last) / 1000; last = at
    const f = handoffFrame(elapsed, reduced)
    const heroAlpha = f.heroAlpha * heroScale
    lastHeroAlpha = heroAlpha
    root.style.setProperty('--brand-handoff-orb', f.orbAlpha.toFixed(3))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H)
    if (heroAlpha > .002) { ctx.globalAlpha = heroAlpha; ctx.drawImage(hero, rect.left, rect.top, rect.width, rect.height) }
    if (n && f.overlayAlpha > .002 && targets) {
      const rgb = (to, k) => Math.round(sourceInk[k] + (to[k] - sourceInk[k]) * f.t)
      if (f.t < liftOff) {
        // 还没有一颗起飞:原位画,颜色照样往终点那头插(此刻几乎还是黑洞的颜色)。
        const to = orbInk ?? [255, 255, 255]
        ctx.fillStyle = `rgb(${rgb(to, 0)},${rgb(to, 1)},${rgb(to, 2)})`
        for (const src of sources) {
          ctx.globalAlpha = Math.min(1, src.alpha * f.overlayAlpha)
          ctx.fillRect(src.x - src.size / 2, src.y - src.size / 2, src.size, src.size)
        }
      } else {
        const el = findOrb()
        const r = el?.getBoundingClientRect?.()
        const orbRect = r && r.width > 4 && r.height > 4 ? r : fallbackOrb
        if (el && !orbInk) orbInk = inkOf(el) ?? [255, 255, 255]
        targets.step(dt)
        const points = targets.project(orbRect), center = targets.center(orbRect)
        if (!order) order = pairByAngle(sources, sourceCenter, points, center)
        const to = orbInk ?? inkOf(null) ?? [255, 255, 255]
        ctx.fillStyle = `rgb(${rgb(to, 0)},${rgb(to, 1)},${rgb(to, 2)})`
        for (let k = 0; k < sources.length; k++) {
          const src = sources[k], dst = points[order[k]]
          if (!dst) continue
          const u = flightProgress(f.t, k, sources.length)
          const pos = flightPoint(src, dst, center, u)
          const size = src.size + (dst.size - src.size) * u
          const alpha = src.alpha + (dst.alpha - src.alpha) * u
          ctx.globalAlpha = Math.min(1, alpha * f.overlayAlpha)
          ctx.fillRect(pos.x - size / 2, pos.y - size / 2, size, size)
        }
      }
    }
    ctx.globalAlpha = 1
    if (f.done) { finish(); return }
    frame = win.requestAnimationFrame(tick)
  }
  // 兜底:rAF 被节流(窗口藏起来)也保证按时收场,不留一层透明画布和一颗隐身的球。
  let guard = setTimeout(finish, (reduced ? HANDOFF_REDUCED_MS : HANDOFF_MS) + 800 + (gated ? GATE_MAX_MS : 0))
  frame = win.requestAnimationFrame(tick)
  meta.syncMs = Math.round((now() - called) * 10) / 10
  return { cancel: finish, done, canvas, perf: meta }
}

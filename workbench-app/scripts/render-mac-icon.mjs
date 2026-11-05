#!/usr/bin/env node
// 「工作台.app」与「安装工作台.app」的 Mac 图标:粒子黑洞(2026-09-23 维护者拍板,替换原来的粒子球图标)。
//
// 黑洞怎么画、两档(simple / full)怎么分,全在共用模块 `butler-app/scripts/blackhole-icon.mjs` 的头注释里
// —— 手机图标(butler-app/scripts/render-app-icon.mjs)用的是同一份,三个 App 是同一个黑洞。
// 粒子来自 `butler-app/src/brand/blackhole.js`:参赛网页原型(docs/brand/粒子黑洞-原型-2026-09-23.html)的逐行移植。
// 事务官的粒子球**不再做图标**,她仍在 App 里面(登录后那颗球)。
//
// macOS 的外形规矩(苹果的图标模板,1024 画布):
//   · 图标是一枚**圆角方**:边长 824,四周各留 100,圆角 22.5%,方块外面透明。
//   · 底是深色竖向渐变(#1b1d22 → #060708)加一圈 12% 白的细边 —— 深色桌面上也看得出方块。
//   · 16/32/64 用 simple(亮环 + 地平线 + 倒影 + 十几颗亮点),128 以上用接近原型的完整版。
//
// 重跑(只要 node + 系统自带的 iconutil,不装任何依赖):
//   node workbench-app/scripts/render-mac-icon.mjs
// 会覆盖写:
//   workbench-app/AppIcon.icns                   两个 App 共用的图标(进 git,两个 build.sh 直接 cp)
//   docs/assets/mac-app-icon-1024.png            1024 预览
//   docs/assets/mac-app-icon-128.png             128 预览(Finder 图标视图那个尺寸)
//   docs/assets/blackhole-icon-sheet.png         对照图:16/32/64/128/512/1024 × 深色 / 浅色桌面
// 中间产物 AppIcon.iconset 落在 build/(已 gitignore),留着可以一张张看。

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blit, canvasRGBA, composeMac, encodePNG, renderIcon } from '../../butler-app/scripts/blackhole-icon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')            // workbench-app/
const repo = resolve(app, '..')

/** iconutil 认的就是这十张,名字一个字都不能错。 */
const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
]
/** 对照图里摆哪几档(维护者点名的六档)。 */
const SHEET = [16, 32, 64, 128, 512, 1024]
/** 对照图的两种桌面底:深色模式 / 浅色模式。 */
const DESKTOPS = [[30, 30, 32], [236, 236, 238]]

const iconsOut = resolve(app, process.env.MAC_ICON_OUT ?? 'AppIcon.icns')
const assets = process.env.ICON_OUT ?? resolve(repo, 'docs/assets')
const iconset = resolve(app, 'build/AppIcon.iconset')

function write(path, buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buffer)
  console.log(`  ${path.replace(repo + '/', '')}  ${(buffer.length / 1024).toFixed(1)} KB`)
}

// ── 跑 ─────────────────────────────────────────────────────────────────────
const rendered = new Map()
const icon = size => {
  if (!rendered.has(size)) {
    const started = Date.now()
    rendered.set(size, composeMac(renderIcon(size)))
    console.log(`  渲染 ${size}px(${size <= 96 ? 'simple' : 'full'})${Date.now() - started}ms`)
  }
  return rendered.get(size)
}

console.log('iconset:')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
for (const [name, size] of ICONSET) write(resolve(iconset, name), encodePNG(size, size, icon(size)))

console.log('icns:')
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', iconsOut])
console.log(`  ${iconsOut.replace(repo + '/', '')}  ${(statSync(iconsOut).size / 1024).toFixed(1)} KB`)

console.log('预览图:')
write(resolve(assets, 'mac-app-icon-1024.png'), encodePNG(1024, 1024, icon(1024)))
write(resolve(assets, 'mac-app-icon-128.png'), encodePNG(128, 128, icon(128)))

{
  const gap = 32, width = SHEET.reduce((sum, size) => sum + size + gap, gap), row = 1024 + gap * 2
  const sheet = canvasRGBA(width, row * DESKTOPS.length, DESKTOPS[0])
  DESKTOPS.forEach((rgb, r) => {
    for (let y = r * row; y < (r + 1) * row; y++) for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4; sheet[k] = rgb[0]; sheet[k + 1] = rgb[1]; sheet[k + 2] = rgb[2]
    }
    let x = gap
    for (const size of SHEET) { blit(sheet, width, icon(size), size, x, r * row + gap + 1024 - size); x += size + gap }
  })
  write(resolve(assets, 'blackhole-icon-sheet.png'), encodePNG(width, row * DESKTOPS.length, sheet))
}

console.log('完事。两个 build.sh 会把 AppIcon.icns 拷进 Contents/Resources。')

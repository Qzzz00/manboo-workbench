#!/usr/bin/env node
// 事务官手机端启动图标:粒子黑洞(2026-09-23 维护者拍板,替换原来的粒子球图标)。
//
// 黑洞怎么画、两档(simple / full)怎么分,全在共用模块 `scripts/blackhole-icon.mjs` 的头注释里
// —— Mac 图标(`workbench-app/scripts/render-mac-icon.mjs`)用的是同一份。这个文件只管 Android 那几档尺寸和遮罩。
//
// Android 的规矩:
//   · 自适应图标(API 26+):前景 108dp 画布,系统按设备形状(圆 / 圆角方 / 方)裁,**只保证中间 66dp 的圆**露出来。
//     光环(连同柔边)收在这个安全区里:前景把整幅图缩到 FOREGROUND_ZOOM,环外沿 ≈ 23dp < 33dp;
//     地平线本来就是往两边延伸的,被裁掉两头反而像原型那样「伸出画面」。
//     选档按露出来的 72dp 算:mdpi(72px)用 simple,hdpi 起用 full。
//   · 背景层是纯色 #08090b(原型的底色),写在 res/values/ic_launcher_background.xml,不是图片。
//   · 旧版(API 25 及以下)ic_launcher / ic_launcher_round:黑底整图,48/72/96 用 simple,144/192 用 full。
//
// 重跑:
//   cd butler-app && node scripts/render-app-icon.mjs
// 会覆盖写:
//   android/app/src/main/res/mipmap-*/ic_launcher_foreground.png   自适应前景
//   android/app/src/main/res/mipmap-*/ic_launcher.png              旧版方形(圆角)
//   android/app/src/main/res/mipmap-*/ic_launcher_round.png        旧版圆形
//   ../docs/assets/butler-app-icon-1024.png                        1024 预览(前景 + 背景色,方形不裁)
//   ../docs/assets/butler-app-icon-192.png                         192 旧版圆形那张
//   ../docs/assets/butler-app-icon-masks.png                       圆 / 圆角方 / 方 三种裁法 + 66dp 安全区虚线

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICON_BACKGROUND, blit, canvasRGBA, composeFlat, composeForeground, encodePNG, renderIcon } from './blackhole-icon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')
const res = process.env.ICON_RES ?? resolve(app, 'android/app/src/main/res')
const assets = process.env.ICON_OUT ?? resolve(app, '../docs/assets')

/** 前景整幅缩到多少(1 = 与 Mac 同样的构图铺满 108dp)。0.78:环外沿 ≈ 23dp,亮点最高处 ≈ 31dp,都在 33dp 安全圆里。 */
const FOREGROUND_ZOOM = Number(process.env.ICON_FG_ZOOM ?? .78)
/** 前景构图:圆心比画面中心低一点点,留出上面那一圈亮点的位置。 */
const FOREGROUND_FRAMING = { simple: { half: 2.05, centerY: .3 }, full: { half: 2.6, centerY: .3 } }

const DENSITIES = [['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216], ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]]

function write(path, buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buffer)
  console.log(`  ${path.replace(resolve(app, '..') + '/', '')}  ${(buffer.length / 1024).toFixed(1)} KB`)
}

const foreground = size => renderIcon(size, { detail: size * 2 / 3, zoom: FOREGROUND_ZOOM, framing: FOREGROUND_FRAMING })

console.log('自适应图标前景(背景层 @color/ic_launcher_background = #08090b):')
for (const [density, , edge] of DENSITIES) write(resolve(res, `mipmap-${density}/ic_launcher_foreground.png`), encodePNG(edge, edge, composeForeground(foreground(edge))))

console.log('旧版 mipmap(API 25 及以下直接用这张):')
for (const [density, size] of DENSITIES) {
  const light = renderIcon(size)
  write(resolve(res, `mipmap-${density}/ic_launcher.png`), encodePNG(size, size, composeFlat(light, 'rounded')))
  write(resolve(res, `mipmap-${density}/ic_launcher_round.png`), encodePNG(size, size, composeFlat(light, 'circle')))
}

console.log('预览图:')
write(resolve(assets, 'butler-app-icon-1024.png'), encodePNG(1024, 1024, composeFlat(foreground(1024), 'square')))
write(resolve(assets, 'butler-app-icon-192.png'), encodePNG(192, 192, composeFlat(renderIcon(192), 'circle')))

// 三种裁法并排(按 108dp 画布的 72dp 可见区裁),外加 66dp 安全区的虚线圈,看环有没有出界。
{
  const tile = 288, gap = 24, width = tile * 3 + gap * 4, height = tile + gap * 2
  const rgba = canvasRGBA(width, height, [24, 26, 30])
  const layer = foreground(Math.round(tile * 108 / 72))
  const crop = Math.round(tile * 18 / 72)   // 108dp 画布四周各 18dp 不露
  const visible = { size: tile, data: new Float64Array(tile * tile) }
  for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) visible.data[y * tile + x] = layer.data[(y + crop) * layer.size + x + crop]
  ;['circle', 'rounded', 'square'].forEach((shape, index) => {
    const lit = composeFlat(visible, shape, ICON_BACKGROUND)
    const r = tile * 33 / 72, c = tile / 2   // 66dp 安全圆(虚线)
    for (let a = 0; a < 360; a += 1.5) {
      if (Math.floor(a / 6) % 2) continue
      const x = Math.round(c + Math.cos(a * Math.PI / 180) * r), y = Math.round(c + Math.sin(a * Math.PI / 180) * r)
      const k = (y * tile + x) * 4
      lit[k] = 255; lit[k + 1] = 190; lit[k + 2] = 60; lit[k + 3] = 255
    }
    blit(rgba, width, lit, tile, gap + index * (tile + gap), gap)
  })
  write(resolve(assets, 'butler-app-icon-masks.png'), encodePNG(width, height, rgba))
}

console.log('完事。背景色在 res/values/ic_launcher_background.xml。')

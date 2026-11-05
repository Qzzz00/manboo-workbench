#!/usr/bin/env node
// 安装器欢迎页顶上那条横幅:粒子黑洞主视觉(2026-09-23 维护者拍板「主视觉用在安装器欢迎页」)。
//
// 同一份黑洞(butler-app/src/brand/blackhole.js,参赛网页原型的逐行移植),同一个离线渲染器
// (butler-app/scripts/blackhole-icon.mjs 的 renderBanner),画成一张静图 —— 安装器是 AppKit 写的,
// 放一张 PNG 比塞一个 WebView 进去稳得多;它一辈子只被打开一次,静图足够。
//
// 重跑:node installer-app/scripts/render-welcome-hero.mjs
// 会覆盖写:installer-app/Resources/welcome-hero.png(@2x,1240×400;窗口里按 620×200 点摆)
// installer-app/build.sh 把它拷进 Contents/Resources;缺了它欢迎页照常,只是没有横幅。

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeBanner, encodePNG, renderBanner } from '../../butler-app/scripts/blackhole-icon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../Resources/welcome-hero.png')

/** 点尺寸 × 2(Retina)。环半径 54 点、圆心在 66% 高:拱顶离上沿 ~20 点,倒影刚好收在下沿里。 */
const SCALE = 2, WIDTH = 620, HEIGHT = 200, RADIUS = 54, CENTER_Y = .66

const light = renderBanner(WIDTH * SCALE, HEIGHT * SCALE, { radius: RADIUS * SCALE, cy: HEIGHT * SCALE * CENTER_Y })
const png = encodePNG(WIDTH * SCALE, HEIGHT * SCALE, composeBanner(light))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`  installer-app/Resources/welcome-hero.png  ${(png.length / 1024).toFixed(1)} KB`)

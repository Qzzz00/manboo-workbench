/**
 * ★ 2026-10-03:他那六格里**一个紫都不许再有**。
 *
 * 维护者原话:「话说这个紫色的点缀色真是太丑了」。换成的是工作台本体现成的那一个令牌
 * (`var(--dsw-alias-state-business-primary)`,在 `client/neutralStyle.ts` 里被重定义成
 * 主文字色),带透明度的走 `color-mix`。**用变量不写死**,所以这里钉两件:
 *
 * ① 六份源码里再也没有紫色的十六进制;
 * ② 点缀色确实是从本体那个令牌来的(不是换成了另一个写死的颜色)。
 *
 * 为什么是读源码而不是渲染后数颜色:他那几份 CSS 是整段模板字符串塞进 `<style>` 的,
 * jsdom 不算层叠、也不解 `color-mix` / `var()`,渲染后读出来的是原样那串字符。
 * 读源码比对才是这件事唯一测得到的地方。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const AIR_WIDGETS = ['review', 'notes', 'files', 'publish', 'usage', 'topics'] as const

/** 本体那一个点缀色令牌(`client/neutralStyle.ts` 把它重定义成主文字色)。 */
const ACCENT_TOKEN = 'var(--dsw-alias-state-business-primary)'

function sourceOf(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', '..', 'user-layer', '起步', '小组件', name, 'index.js'), 'utf8')
}

/** 去掉文件头那段注释 —— 换掉的那几个紫值**原样列在文件头清单里**,那是档案,不是样式。 */
function bodyOf(name: string): string {
  // 2026-10-21 搬进用户层后文件头是两段注释(搬家说明 + 原来那段档案),都去掉。
  let text = sourceOf(name).trimStart()
  while (text.startsWith('/*') || text.startsWith('//')) {
    const end = text.startsWith('/*') ? text.indexOf('*/') + 2 : text.indexOf('\n') + 1
    text = text.slice(end).trimStart()
  }
  return text
}

/** 十六进制 → HSL 的色相与饱和度(只为判"这是不是紫")。 */
function hueOf(hex: string): { hue: number, sat: number } | undefined {
  let digits = hex.slice(1)
  if (digits.length === 3) digits = [...digits].map(c => c + c).join('')
  if (digits.length < 6) return undefined
  const [r, g, b] = [0, 2, 4].map(at => parseInt(digits.slice(at, at + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min
  if (span < 0.02) return undefined
  const raw = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4
  const hue = (Math.round(raw * 60) + 360) % 360
  return { hue, sat: span / (1 - Math.abs(max + min - 1)) }
}

describe('他那六格里的点缀色', () => {
  it.each(AIR_WIDGETS)('%s.js:一个紫色十六进制都没有了', (name) => {
    const purple = [...bodyOf(name).matchAll(/#[0-9a-fA-F]{3,8}/g)]
      .map(match => match[0])
      .filter((hex) => {
        const shade = hueOf(hex)
        return shade !== undefined && shade.hue >= 230 && shade.hue <= 290 && shade.sat > 0.15
      })
    expect(purple).toEqual([])
  })

  it('点缀色读的是本体那个令牌,不是另一个写死的颜色', () => {
    // 2026-10-22 起随手记、系统文件夹照评审页重排,颜色直接读本体那套令牌(--wb-*),不再有自己的点缀色;
    // 其余四格(复盘、发布、消耗、选题)的点缀色仍读那一个令牌。
    const using = AIR_WIDGETS.filter(name => bodyOf(name).includes(ACCENT_TOKEN))
    expect(using).toEqual(['review', 'publish', 'usage', 'topics'])
    for (const name of ['notes', 'files'] as const) expect(bodyOf(name)).toContain('var(--wb-ink)')
  })

  it('带透明度的那几个走 color-mix,不写死一个半透明的颜色', () => {
    for (const name of AIR_WIDGETS) {
      const body = bodyOf(name)
      if (!body.includes('color-mix')) continue
      // 每一处 color-mix 的第一色都必须是那个令牌。
      for (const match of body.matchAll(/color-mix\(in srgb,([^ ]+) /g)) {
        expect(match[1], `${name}.js`).toBe(ACCENT_TOKEN)
      }
    }
  })
})

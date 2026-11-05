/**
 * ★ 2026-10-13:**自媒体(运营)布局里一个紫都不许再有**。
 *
 * 维护者原话:「自媒体布局的所有紫色改成和产品研发布局的黑白灰,运营同学那边也改成这个配色了」。
 *
 * 10-03 那一轮(`client-air-accent.test.ts`)只收了他交来的那六格源码;**整层黑紫皮肤**
 * (当年 `client/opsThemeStyle.ts`,2026-10-04 合入他 10-03 / 10-04 两段)一直是紫的 ——
 * 这一份钉它改完,并且钉住"改成的是本体那套黑白灰、不是另挑一个颜色"。
 *
 * 2026-10-23(分层二刀二):这一层本体不再内置,内容原样搬进用户层起步层 `布局/ops.css`;
 * 断言对象换成**那一份真文件**,逻辑一条没动:
 *
 * ① 那一层里**每一个色值都是黑 / 白 / 灰**(R=G=B),只放过点名的两档语义色(琥珀 / 红);
 * ② 换掉的那些原值(夹具表,按改前的源码逐一列出)一个都不再出现;
 * ③ 变量名 / 关键帧名里没有 violet / purple 一类的字;
 * ④ 那一层自己那几个名字(`--wb-ops-*`)的值都是**本体令牌或令牌的 color-mix**,不是写死的颜色;
 * ⑤ 那一层**不再重定义**本体那套调色令牌(`--dsw-alias-bg-*` / `label-*` / `border-*` / `button-*`)——
 *    产品研发布局用的就是那几个,复用它才叫"同一套黑白灰";
 * ⑥ 整个 `src/client` 的源码(去掉注释)里只剩一处紫:Kimi 那一家的家族色,理由见 `FAMILY_PURPLE`。
 *
 * 为什么是读源码而不是渲染后数颜色:这几层 CSS 都是整段模板字符串塞进 `<style>` 的,
 * jsdom 不算层叠、也不解 `color-mix` / `var()`,渲染后读出来的还是原样那串字符
 * (理由同 `client-air-accent.test.ts`)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STARTER_LAYOUTS_DIR } from './helpers/starterLayer.ts'

const CLIENT_DIR = join(import.meta.dirname, '..', 'src', 'client')
/** 2026-10-21 运营同学那六格搬进了用户层的起步层,守门跟着一起扫;10-23 布局皮肤(ops.css)也在这里。 */
const STARTER_DIR = join(import.meta.dirname, '..', '..', 'user-layer', '起步')
const SOURCE_FILES = (): string[] => [...walk(CLIENT_DIR), ...walk(STARTER_DIR)]
const shown = (file: string): string => relative(join(import.meta.dirname, '..', '..'), file)

/** 皮肤原文 = 用户层起步层那一份真文件(与当年内置的 OPS_THEME_STYLE 逐字相同)。 */
const OPS_THEME_STYLE = readFileSync(join(STARTER_LAYOUTS_DIR, 'ops.css'), 'utf8')
/**
 * 去注释后的正文:文件头那段大注释是档案(换掉的原值逐一列在里面),不是样式 ——
 * 当年引 OPS_THEME_STYLE 常量时天然不含它,现在先剥掉再断言(同下面整仓扫描的口径)。
 */
const OPS_BODY = withoutComments(OPS_THEME_STYLE)
/** 这一层自己那几个名字的前缀(当年引 opsThemeStyle.ts 的常量,文件删了,值不变)。 */
const OPS_THEME_NAME_PREFIX = 'wb-ops-'

/**
 * 维护者 10-04 点名留下的那两档语义色(事务官球「等你确认」= 琥珀、「失败」= 红),
 * 与全局中性色那一条同一个口径:「语义色不动」(`client/neutralStyle.ts`)。
 */
const SEMANTIC_KEEP: readonly string[] = ['#edbd65', '#ef7777', '237,189,101', '239,119,119']

/**
 * Kimi 那一家的家族色(`client/style.ts` 的 `.ben-wb__task-who[data-agent=kimi]`
 * 与同一处的筛选键)。它是**一家一色**那一套里的一个,两套布局共用;要改得连 dsh 蓝 /
 * claude 橙 / codex 绿一起改,不在这张卡里。
 */
const FAMILY_PURPLE: readonly string[] = ['#3b2b4d', '#c9a0f0']

/**
 * 改前那一层里**真的出现过**的紫(2026-10-13 按改前源码逐一数出来的:十六进制 23 个、
 * rgb 三元组 19 组)。夹具表的用处是防"换了一个色相更浅的紫回来" —— 色相尺子有阈值,
 * 原值表没有。
 */
const WAS_PURPLE_HEX: readonly string[] = [
  '#a78bfa', '#c4b5fd', '#6d28d9', '#8b5cf6', '#7c3aed', '#9f7aea',
  '#09080c', '#0d0b12', '#100b18', '#111016', '#17141f', '#201a2c',
  '#17131f', '#17151c', '#17121f', '#211b2b', '#0c0a10', '#0b0910', '#0a0810', '#160d25',
  '#f4f0fb', '#f5f1fa', '#c9c1d6', '#d9cff0', '#cfc3e6', '#8f879c', '#958da2',
]
const WAS_PURPLE_RGB: readonly string[] = [
  '139,92,246', '167,139,250', '196,181,253', '124,58,237', '109,40,217', '76,29,149',
  '155,145,190', '24,20,32', '13,11,18', '22,18,30', '22,19,28', '23,19,31', '25,20,34',
  '26,20,37', '20,17,27', '12,10,16', '11,9,15', '10,9,14', '10,9,13', '8,7,11', '7,6,10',
]

/** 紫的名字:变量名、关键帧名、类名里都不许出现。 */
const PURPLE_WORDS: readonly string[] = [
  'violet', 'purple', 'indigo', 'lavender', 'orchid', 'plum', 'magenta', 'fuchsia',
]

/** 一个色值的三个通道。认不出来(函数式颜色、`var()`)就回 undefined。 */
function channelsOf(literal: string): [number, number, number] | undefined {
  if (literal.startsWith('#')) {
    let digits = literal.slice(1)
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map(c => c + c).join('')
    if (digits.length < 6) return undefined
    return [0, 2, 4].map(at => parseInt(digits.slice(at, at + 2), 16)) as [number, number, number]
  }
  const parts = literal.replace(/^rgba?\(/, '').split(',')
  if (parts.length < 3) return undefined
  const [r, g, b] = parts.slice(0, 3).map(one => Number.parseInt(one.trim(), 10))
  if ([r, g, b].some(one => Number.isNaN(one))) return undefined
  return [r as number, g as number, b as number]
}

/** 黑 / 白 / 灰 = 三个通道一样(留 2/255 的余量给手写的近似值)。 */
function isNeutral(literal: string): boolean {
  const channels = channelsOf(literal)
  if (channels === undefined) return false
  const [r, g, b] = channels
  return Math.max(r, g, b) - Math.min(r, g, b) <= 2
}

/** 一段 CSS / 源码里所有写死的色值(十六进制与 `rgb()` / `rgba()`;`var()` 与 `color-mix()` 不算)。 */
function literalsOf(css: string): string[] {
  return [
    ...[...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(one => one[0]),
    ...[...css.matchAll(/rgba?\([^)]*\)/g)].map(one => one[0]),
    ...[...css.matchAll(/hsla?\([^)]*\)/g)].map(one => one[0]),
  ]
}

/** 去掉注释 —— 换掉的那些原值**原样列在文件头清单里**,那是档案,不是样式。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const text = line.trim()
      return !text.startsWith('//') && !text.startsWith('*')
    })
    .join('\n')
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (['.ts', '.tsx', '.js', '.css'].includes(extname(name)) && !name.endsWith('.d.ts')) yield full
  }
}

describe('自媒体布局那一层皮肤', () => {
  const literals = literalsOf(OPS_BODY)

  it('每一个色值都是黑 / 白 / 灰(点名的两档语义色除外)', () => {
    const colored = literals.filter(one => !isNeutral(one) && !SEMANTIC_KEEP.some(keep => one.includes(keep)))
    expect(colored).toEqual([])
  })

  it('改前那些紫的原值一个都不再出现', () => {
    const left = [...WAS_PURPLE_HEX, ...WAS_PURPLE_RGB].filter(one => OPS_BODY.includes(one))
    expect(left).toEqual([])
  })

  it('变量名 / 关键帧名里没有紫的字', () => {
    const lower = OPS_BODY.toLowerCase()
    expect(PURPLE_WORDS.filter(word => lower.includes(word))).toEqual([])
  })

  it('那一层自己那几个名字都从本体令牌来,不是写死的颜色', () => {
    const own = [...OPS_BODY.matchAll(/--wb-ops-[a-z-]+\s*:([^;}]+)/g)].map(one => one[1]?.trim() ?? '')
    expect(own.length).toBeGreaterThanOrEqual(3)
    for (const value of own) expect(value, value).toMatch(/var\(--|color-mix\(/)
    // 顺带钉住"这一层自己的名字都带同一个前缀"(作用域那一份断言引的就是它)。
    expect(OPS_BODY).toContain(OPS_THEME_NAME_PREFIX)
  })

  it('不再重定义本体那套调色令牌 —— 产品研发布局用的就是它们', () => {
    const redefined = [...OPS_BODY.matchAll(/(--dsw-alias-[a-z0-9-]+)\s*:/g)].map(one => one[1] ?? '')
    expect(redefined).toEqual([])
  })

  it('强调态读的是本体那个点缀色令牌(neutralStyle 里被重定义成主文字色)', () => {
    expect(OPS_BODY).toContain('var(--dsw-alias-state-business-primary)')
    expect(OPS_BODY).toContain('var(--dsw-alias-state-business-tertiary)')
  })

  it('面板底色读的是产品研发布局那套材质层变量', () => {
    expect(OPS_BODY).toContain('var(--wb-surface-card)')
    expect(OPS_BODY).toContain('var(--wb-surface-line)')
  })
})

describe('整个客户端源码(去掉注释)', () => {
  it('只剩 Kimi 那一家的家族色,别的地方一个紫都没有', () => {
    const found: string[] = []
    for (const file of SOURCE_FILES()) {
      const body = withoutComments(readFileSync(file, 'utf8'))
      for (const literal of literalsOf(body)) {
        if (FAMILY_PURPLE.includes(literal.toLowerCase())) continue
        const channels = channelsOf(literal)
        if (channels === undefined) continue
        const [r, g, b] = channels
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const span = max - min
        // 三个通道差 2/255 以内算灰(同 isNeutral 的余量);再偏一点就要说清是哪一家的色。
        if (span <= 2) continue
        const raw = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4
        const hue = (Math.round(raw * 60) + 360) % 360
        if (hue >= 230 && hue <= 300) found.push(`${shown(file)}: ${literal}`)
      }
    }
    expect(found).toEqual([])
  })

  it('紫的字(violet / purple 一类)一个都没有', () => {
    const named: string[] = []
    for (const file of SOURCE_FILES()) {
      const lower = withoutComments(readFileSync(file, 'utf8')).toLowerCase()
      for (const word of PURPLE_WORDS) if (lower.includes(word)) named.push(`${shown(file)}: ${word}`)
    }
    expect(named).toEqual([])
  })
})

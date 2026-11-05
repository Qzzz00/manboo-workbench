/**
 * ★ 2026-10-04 黑紫主题**只给自媒体(运营)布局**(维护者原话:产品研发布局一个像素都不许被它改到)。
 *
 * 2026-10-23(分层二刀二):这一层本体不再内置 —— `client/opsThemeStyle.ts` 删了,内容原样
 * 搬进用户层起步层 `布局/ops.css`,经加载口装进页面。这份用例的断言对象从
 * `OPS_THEME_STYLE` 换成**起步层那一份真文件**(逐字同一份内容),逻辑一条没动:
 *
 * ① 这一层里**没有一条**选择器能在产品研发布局上匹配 —— 逐条核对,漏一条就红;
 * ② 它确实没进总样式表(本体不内置了,总样式表里更不会有);
 * ③ 维护者 10-04 点名**不要**的那两样不在里面(青色 `working` 球、写死 `#fff` 的 neutral/completed);
 * ④ 随手记在产品研发布局下**不是紫的** —— `air/notes.js` 正文里一个紫值都没有,
 *    紫只在 ops 那一层(样式表文本断言;理由同 `client-air-accent`:jsdom 不算层叠、不解 color-mix)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STYLE } from '../src/client/style.ts'
import { STARTER_LAYOUTS_DIR } from './helpers/starterLayer.ts'

/** 皮肤原文 = 用户层起步层那一份真文件(与当年内置的 OPS_THEME_STYLE 逐字相同)。 */
const OPS_THEME_STYLE = readFileSync(join(STARTER_LAYOUTS_DIR, 'ops.css'), 'utf8')
/** 这一层的作用域。当年引 opsThemeStyle.ts 的常量,文件删了,值不变。 */
const OPS_THEME_SCOPE = '.ben-wb[data-template=ops]'
/** 这一层自己那几个名字的前缀(变量与关键帧)。 */
const OPS_THEME_NAME_PREFIX = 'wb-ops-'

/** 去注释后的正文:文件头那段大注释是档案,不是样式(当年引常量时天然不含它,先剥掉再断言)。 */
const OPS_BODY = OPS_THEME_STYLE.replace(/\/\*[\s\S]*?\*\//g, '')

/** 按**顶层**逗号切 —— `:is(a,b,c)` 里面那几个逗号不是分隔号。 */
function splitTopLevel(head: string): string[] {
  const out: string[] = []
  let depth = 0
  let at = 0
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i]
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    else if (ch === ',' && depth === 0) { out.push(head.slice(at, i)); at = i + 1 }
  }
  out.push(head.slice(at))
  return out
}

/** 这一层里出现的所有选择器(去掉注释、at-rule 的头、声明块)。 */
function selectorsOf(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const block of clean.split('}')) {
    const head = block.split('{')[0]
    if (head === undefined) continue
    for (const one of splitTopLevel(head)) {
      const text = one.trim()
      // at-rule 的头(@media / @keyframes)与关键帧里的 0% / 50% 不是选择器。
      if (text === '' || text.startsWith('@') || /^[\d.]+%$/.test(text) || text === 'from' || text === 'to') continue
      out.push(text)
    }
  }
  return out
}

describe('这一层只能落在自媒体布局上', () => {
  it('每一条选择器都从作用域起头', () => {
    const selectors = selectorsOf(OPS_THEME_STYLE)
    expect(selectors.length).toBeGreaterThan(40)
    expect(selectors.filter(one => !one.startsWith(OPS_THEME_SCOPE))).toEqual([])
  })

  it('作用域就是 /state.template.id 那一格(模板 id = ops)', () => {
    expect(OPS_THEME_SCOPE).toBe('.ben-wb[data-template=ops]')
  })

  /*
   * 两道闸,外面那一道:**这一层不在总样式表里**(2026-10-23 起本体根本没内置它,
   * 由用户层 `布局/ops.css` 经 `/user-layer/layouts/<id>/skin` 装进页面,
   * 见 client/userLayer.tsx 的 useUserLayerSkin 与 Workbench.tsx 注入点)。
   * 里面那一道就是上面逐条核对的作用域。
   */
  it('这一层不在总样式表里(不下发、不内置)', () => {
    expect(STYLE).not.toContain(OPS_THEME_SCOPE)
    // 这一层自己那几个名字(变量与关键帧)也不该漏到总样式表里。
    // 2026-10-13 去紫之前这一行核的是 `wb-violet`,那个前缀随紫一起没了。
    expect(STYLE).not.toContain(OPS_THEME_NAME_PREFIX)
  })

  it('没有一条裸的 .ben-wb{…} —— 那正是「我的都变了」的来源', () => {
    expect(OPS_BODY).not.toMatch(/(^|[\s,}])\.ben-wb\s*\{/)
  })
})

describe('维护者 10-04 点名不要的那两样', () => {
  it('不要青色 working 球(球不要蓝:执行中的颜色与形态保持现状)', () => {
    expect(OPS_BODY).not.toContain('data-notice="working"')
    expect(OPS_BODY).not.toContain('data-notice=working')
  })

  it('不把 neutral / completed 写死成 #fff(现状是本体那个令牌,写死会在浅色主题里把球弄没)', () => {
    expect(OPS_BODY).not.toContain('data-notice="neutral"')
    expect(OPS_BODY).not.toContain('data-notice="completed"')
  })

  it('琥珀 / 红那两档照他 10-04 那一版调低了,仍然在', () => {
    expect(OPS_BODY).toContain('data-notice="confirmation"')
    expect(OPS_BODY).toContain('data-notice="failed"')
  })
})

describe('随手记:产品研发布局下不是紫的', () => {
  const notes = readFileSync(join(import.meta.dirname, '..', '..', 'user-layer', '起步', '小组件', 'notes', 'index.js'), 'utf8')
  /** 文件头那两段注释是档案(换掉的那几个紫值原样列在里面),不是样式:从第一行代码起算。 */
  const body = notes.slice(notes.indexOf("require('react')"))

  it('正文里一个颜色字面量都没有了(紫的 rgba 全换成了本体令牌)', () => {
    expect(body).not.toMatch(/rgba\(\s*\d/)
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  // 2026-10-22 照评审页重排后,颜色直接读本体那套令牌(--wb-*:主字、次字、soft 底、线),不再自己配点缀色。
  it('颜色只走本体令牌', () => {
    expect(body).toContain('var(--wb-ink)')
    expect(body).toContain('var(--wb-soft)')
    expect(body).not.toContain('--cn-accent')
  })

  // 2026-10-13 去紫之后那一层也不是紫的了(见 client-ops-no-purple-20261013);
  // 这一条钉的是**只有那一层会盖它**,产品研发布局下读的还是它自己那几个中性令牌。
  it('它那几处底色只有 ops 那一层会盖', () => {
    expect(OPS_BODY).toContain(`${OPS_THEME_SCOPE} .creator-notes`)
  })
})

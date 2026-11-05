// @vitest-environment node
/**
 * 守卫:小组件接口白名单的**三处**一字不差(2026-10-01,卡「小组件派出去与改造内置」)。
 *
 * 三处分别是:
 *   ① `server/moduleOrigin.ts` 的 `MODULE_API_ROUTES` —— **真门**(白名单外 403);
 *   ② `server/devTool.ts` 的 `devToolBrief()` 正文 —— 派出去那条交代里给机器读的那一份;
 *   ③ `docs/自定义模块-接口.md` 第三节那张表 —— 给人读的那一份。
 *
 * `moduleOrigin.ts` 文件头原来就写着「两边必须一个字不差」,可**没有任何用例钉着** ——
 * 2026-10-01 往表里加两条(`POST /xhs/refresh`、`POST /files/asset-reveal`)时,
 * 加漏一处的下场是:模块作者收到一个他看不懂的 403(文档多写了),
 * 或者多出一条没人知道的口子(门多开了)。这一份就是那条守卫,**读源头文件比对**。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MODULE_API_ROUTES } from '../src/server/moduleOrigin.ts'
import { devToolBrief } from '../src/server/devTool.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DOC_REL = 'docs/自定义模块-接口.md'
const doc = readFileSync(join(REPO_ROOT, DOC_REL), 'utf8')

/** 派出去那条交代的正文(参数随便填:这一份钉的是那张表,不是这几个值)。 */
const brief = devToolBrief({
  need: '一个番茄钟',
  moduleId: 'tool-a1b2c3',
  name: '番茄钟',
  modulesDir: '/h/.dsh/workbench/modules',
  serviceOrigin: 'http://127.0.0.1:8791',
})

/** 「就这九条」里那个汉字数目。表长了就在这儿续一个,别改成阿拉伯数字(三处的文案是给人读的)。 */
const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'] as const

describe('小组件接口白名单,三处一字不差', () => {
  it('每一条都逐字写在派活交代里', () => {
    for (const route of MODULE_API_ROUTES) {
      expect(brief, `交代里少了 ${route.method} ${route.path}`).toContain(`${route.method} ${route.path}`)
    }
  })

  it('每一条都逐字写在 docs/自定义模块-接口.md 里', () => {
    for (const route of MODULE_API_ROUTES) {
      expect(doc, `${DOC_REL} 里少了 ${route.method} ${route.path}`).toContain(`${route.method} ${route.path}`)
    }
  })

  it('「就这几条」那句话里的条数,就是表的长度', () => {
    const count = CN[MODULE_API_ROUTES.length]
    expect(count, '表长到 CN 里没有的数了,去补一个').toBeDefined()
    expect(brief).toContain(`就这${count as string}条`)
    expect(doc).toContain(`就这${count as string}条`)
  })

  /**
   * 反向那一半:文档/交代里写了、而门上没有的,一条都不许有。
   *
   * 判据是**它们各自那一段里出现的 `METHOD /路径`**:门外的接口(`/credentials`、`/files/reveal`…)
   * 在两份文档里都是被点名拒绝的,所以只扫「能用的接口」那一段,不扫全文。
   */
  it('两份文档里「能用的接口」那一段,没有门上不认的路径', () => {
    const allowed = new Set(MODULE_API_ROUTES.map(one => `${one.method} ${one.path}`))
    const sections = [
      { where: 'devToolBrief', text: cut(brief, '## 它能用的接口', '**就这') },
      { where: DOC_REL, text: cut(doc, '## 三、页面能用的接口', '**就这') },
    ]
    for (const { where, text } of sections) {
      expect(text, `${where}:没找到「能用的接口」那一段`).not.toBe('')
      for (const hit of text.matchAll(/\b(GET|POST) (\/[\w/-]+)/g)) {
        expect(allowed.has(`${hit[1] as string} ${hit[2] as string}`), `${where} 里写着 ${hit[0]},而 MODULE_API_ROUTES 上没有`).toBe(true)
      }
    }
  })

  it('2026-10-01 加的那两条在门上:刷新数据复盘、只开素材文件夹', () => {
    const paths = MODULE_API_ROUTES.map(one => `${one.method} ${one.path}`)
    expect(paths).toContain('POST /xhs/refresh')
    expect(paths).toContain('POST /files/asset-reveal')
    // 任意路径的 reveal **没有**放开(门上只有那条只收文件夹名的)。
    expect(paths).not.toContain('POST /files/reveal')
  })
})

/** 从 `from` 之后截到 `to` 之前。找不到回空串(**不猜**,上面那条断言会红)。 */
function cut(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  if (start < 0) return ''
  const rest = text.slice(start + from.length)
  const end = rest.indexOf(to)
  return end < 0 ? rest : rest.slice(0, end)
}

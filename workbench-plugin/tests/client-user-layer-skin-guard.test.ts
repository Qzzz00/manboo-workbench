// @vitest-environment node
/**
 * 本体没有她的皮肤、也没有她那两格小组件的样式(2026-10-23,卡「分层第二刀(二)」,
 * 统筹第二轮验收)。
 *
 * 运营那一层皮肤(`client/opsThemeStyle.ts`)整体搬进了用户层起步层 `布局/ops.css`;
 * `monoStyle.ts` 里**只服务用户层两格小组件**(随手记 / 素材管理)的那三组规则
 * (creator-notes-* / creator-files .cf-*,含「竖屏那一条」的随记条目补丁)也搬进了
 * 各自组件渲染的 <style>。本体客户端一个字都不留。这份守卫钉:
 *
 * 1. `src/client/opsThemeStyle.ts` 不存在了;
 * 2. 皮肤的专属名字(`--wb-ops-*` / `wb-ops-*` 关键帧、`.rviz-*` / `.ct-*` / `.cp-*`
 *    皮肤 class)与两格小组件的 class(`creator-` 前缀 / `cf-` 前缀)都不出现在 src/client
 *    —— 不豁免、不排除,直接扫(`userLayer*.tsx/ts` 也不含,已核);
 * 3. monoStyle 删干净后,搬进去的位置保原相对顺序:竖屏补丁在主体规则**之后**
 *    (同一份 <style> 内,级联按顺序);
 * 4. 构建产物(`lib/client.js`)里同样没有这些名字 —— 构建后跑;lib 还没构建出来就跳过。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MONO_STYLE } from '../src/client/monoStyle.ts'
import { STARTER_LAYOUTS_DIR, STARTER_WIDGETS_DIR } from './helpers/starterLayer.ts'

const CLIENT_DIR = join(import.meta.dirname, '..', 'src', 'client')
const LIB_CLIENT = join(import.meta.dirname, '..', 'lib', 'client.js')

/** ops.css 全文(用户层起步层那一份真文件)。 */
const SKIN_CSS = readFileSync(join(STARTER_LAYOUTS_DIR, 'ops.css'), 'utf8')

/** 皮肤专属的 class 名(rviz 复盘轨道 / ct 选题卡 / cp 发布月历;小组件 DOM 不用这些)。 */
const SKIN_ONLY_CLASSES: readonly string[] = (() => {
  const out = new Set<string>()
  for (const match of SKIN_CSS.matchAll(/\.(rviz-[a-z0-9-]+|ct-[a-z0-9-]+|cp-[a-z0-9-]+)/g)) out.add(match[1] as string)
  return [...out]
})()

/** 两格小组件的 class 名(本体不许再认识;从两个组件的源里抽,读源头比对)。 */
const WIDGET_SOURCES = {
  notes: readFileSync(join(STARTER_WIDGETS_DIR, 'notes', 'index.js'), 'utf8'),
  files: readFileSync(join(STARTER_WIDGETS_DIR, 'files', 'index.js'), 'utf8'),
}
const WIDGET_CLASSES: readonly string[] = (() => {
  const out = new Set<string>()
  for (const src of Object.values(WIDGET_SOURCES)) {
    for (const match of src.matchAll(/\.(creator-[a-z0-9-]+|cf-[a-z0-9-]+)\b/g)) out.add(match[1] as string)
  }
  return [...out]
})()

const SKIN_ONLY_MARKERS: readonly string[] = [
  'wb-ops-', // 变量与关键帧的名字前缀,只在 opsThemeStyle.ts 里出现过。
  '自媒体布局 · 黑白灰', // 皮肤文件里那段头注释,本体不该带着它。
]

/** 全收 src/client 的源码(一个文件都不排除 —— 本体不该剩下她的任何 class 名)。 */
function clientSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      out.push(readFileSync(path, 'utf8'))
    }
  }
  walk(CLIENT_DIR)
  return out
}

describe('本体客户端没有她的皮肤,也没有她那两格的样式', () => {
  it('opsThemeStyle.ts 删了', () => {
    expect(existsSync(join(CLIENT_DIR, 'opsThemeStyle.ts'))).toBe(false)
  })

  it('皮肤的专属名字(wb-ops 变量/关键帧、rviz/ct/cp class)不出现在 src/client', () => {
    const sources = clientSources()
    expect(sources.length).toBeGreaterThan(10)
    for (const src of sources) {
      for (const marker of SKIN_ONLY_MARKERS) expect(src.includes(marker), `src/client 里出现了皮肤的「${marker}」`).toBe(false)
      for (const cls of SKIN_ONLY_CLASSES) expect(src.includes(`.${cls}`), `src/client 里出现了皮肤的 .${cls}`).toBe(false)
    }
  })

  it('★两格小组件的 class(creator- 前缀 / cf- 前缀)在 src/client 一个都不剩 —— 不豁免、不排除', () => {
    const sources = clientSources()
    for (const src of sources) {
      for (const cls of WIDGET_CLASSES) {
        expect(src.includes(`.${cls}`), `src/client 里出现了小组件的 .${cls}`).toBe(false)
      }
      // 连散着的 class 名前缀也扫一遍(防抽漏:注释、拼接串里露出来的)。
      const loose = [...src.matchAll(/(^|[^a-zA-Z0-9_-])\.(creator-[a-z0-9-]+|cf-[a-z0-9-]+)/g)].map(one => one[2])
      expect(loose, `散着的 ${loose.join('、')}`).toEqual([])
    }
  })

  it('monoStyle 删干净;搬进去的位置保原相对顺序(竖屏补丁在主体之后)', () => {
    expect(MONO_STYLE).not.toContain('.creator-notes')
    expect(MONO_STYLE).not.toContain('.creator-files')
    expect(MONO_STYLE).not.toContain('.cf-')
    // 场景条那条是本体通用的,留下。
    expect(MONO_STYLE).toContain('.ben-wb__scenebar')
    // 两个组件各带一份 <style>,竖屏补丁在本块主体之后(同一份里级联按顺序)。
    const notes = WIDGET_SOURCES.notes
    const main = notes.indexOf('.ben-wb .creator-notes-item{padding:10px 0!important')
    const patch = notes.indexOf('.ben-wb .creator-notes-item{border-left:0;padding-left:0}')
    expect(main).toBeGreaterThan(-1)
    expect(patch).toBeGreaterThan(main)
    expect(WIDGET_SOURCES.files).toContain('.ben-wb .creator-files .cf-tabs{gap:6px')
  })

  it('构建产物 lib/client.js 里同样没有(构建后跑)', () => {
    if (!existsSync(LIB_CLIENT)) return // lib 还没构建出来;构建三步跑完再回来就是硬断言。
    const built = readFileSync(LIB_CLIENT, 'utf8')
    for (const marker of SKIN_ONLY_MARKERS) expect(built.includes(marker), `lib/client.js 里出现了皮肤的「${marker}」`).toBe(false)
    for (const cls of SKIN_ONLY_CLASSES) expect(built.includes(`.${cls}`), `lib/client.js 里出现了皮肤的 .${cls}`).toBe(false)
    for (const cls of WIDGET_CLASSES) expect(built.includes(`.${cls}`), `lib/client.js 里出现了小组件的 .${cls}`).toBe(false)
  })
})

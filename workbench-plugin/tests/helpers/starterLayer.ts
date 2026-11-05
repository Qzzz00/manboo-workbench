/**
 * 起步层(`user-layer/起步/小组件/`,运营同学那六格)在用例里怎么拿(2026-10-21,卡「分层第一刀」)。
 *
 * 读的是**仓库里那几份真文件**,走的是**本体真的那条加载口**(`createUserLayerRegistry().install`,
 * CommonJS + 白名单 require)—— 用例里那几格与真机上从用户层目录装进来的是同一份代码、同一条路,
 * 只是省掉了 HTTP 取代码那一跳(那一跳由 client-user-layer / server-user-layer-http 两份钉着)。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentType } from 'react'
import type { UserLayerWidgetView } from '../../src/protocol.ts'
import { createUserLayerRegistry, type UserLayerRegistry } from '../../src/client/userLayer.tsx'
import { createUserLayerService, parseLayoutTemplate, type UserLayerService } from '../../src/server/userLayer.ts'
import { PRODUCT_TEMPLATE, setWorkbenchTemplateSource, type WorkbenchTemplate } from '../../src/templates.ts'

export const STARTER_LAYER_DIR = join(import.meta.dirname, '..', '..', '..', 'user-layer', '起步')
export const STARTER_WIDGETS_DIR = join(STARTER_LAYER_DIR, '小组件')
/** 起步层那一份缺省布局(2026-10-23,分层二刀二):`user-layer/起步/布局/`。 */
export const STARTER_LAYOUTS_DIR = join(STARTER_LAYER_DIR, '布局')

export function starterWidgetIds(): string[] {
  return readdirSync(STARTER_WIDGETS_DIR, { withFileTypes: true }).filter(one => one.isDirectory()).map(one => one.name).sort()
}

export function starterSource(id: string): string {
  return readFileSync(join(STARTER_WIDGETS_DIR, id, 'index.js'), 'utf8')
}

export function starterManifest(id: string): UserLayerWidgetView {
  const raw = JSON.parse(readFileSync(join(STARTER_WIDGETS_DIR, id, 'widget.json'), 'utf8')) as UserLayerWidgetView
  return { ...raw, status: 'ok', rev: 'starter00000' }
}

/** 把起步层整份装进一份登记表(缺省新建一份)。 */
export function installStarterLayer(registry: UserLayerRegistry = createUserLayerRegistry()): UserLayerRegistry {
  for (const id of starterWidgetIds()) {
    if (!registry.install(starterManifest(id), starterSource(id))) throw new Error(`起步层 ${id} 装不上:${registry.problems().get(id)}`)
  }
  return registry
}

/** 单拿一格的组件(原来 `import { X } from '../src/client/air/<名>.js'` 的那几份用例用它)。 */
export function starterWidget(id: string): ComponentType<any> {
  const registry = createUserLayerRegistry()
  const manifest = starterManifest(id)
  if (!registry.install(manifest, starterSource(id))) throw new Error(`起步层 ${id} 装不上:${registry.problems().get(id)}`)
  const hit = registry.resolve(manifest.replaces!, manifest.templates?.[0])
  if (hit.kind !== 'ready') throw new Error(`起步层 ${id} 没就绪`)
  return hit.component
}

/**
 * 起步层那一份布局模板(2026-10-23,分层二刀二):读真 `user-layer/起步/布局/<id>.json` 走
 * **本体真的 parser**(含皮肤读取)。解析不过直接 throw —— 起步层自身坏了,用例该红。
 * 原来从 templates.ts import OPS_TEMPLATE 的那些用例改用它(模块顶层 `await` 拿)。
 */
export async function loadStarterLayoutTemplate(id = 'ops'): Promise<WorkbenchTemplate> {
  const text = readFileSync(join(STARTER_LAYOUTS_DIR, `${id}.json`), 'utf8')
  const parsed = await parseLayoutTemplate(id, text, async (name) => {
    try { return readFileSync(join(STARTER_LAYOUTS_DIR, name), 'utf8') }
    catch { return undefined }
  })
  if (!parsed.ok) throw new Error(`起步层布局 ${id} 解析不过:${parsed.view.problem ?? ''}`)
  return parsed.template
}

/**
 * 真实 startup 接线(2026-10-23,整包测试夹具收口):与 `src/index.ts` 起服务那三步同款 —
 * 建**真实 UserLayer 服务**(起步层 = 仓库里那一份真文件,不在夹具里另造 ops 配置)→
 * `ensure()`(布局缺才放)→ `scan()` 给快照打底 → 把 `product + 用户层快照` 注册进全局模板
 * 来源(`templates.ts` 的 source,深调用方走的那一处)。模板服务再传
 * `templates: () => service.layoutTemplates()`(正式 provider,与全局来源同一份快照)。
 *
 * 三个服务端夹具(server-ops-skills-wire / server-modules-http / today-view-switch)共用这一个。
 * `dir` 传用例自己 mkdtemp 出来的目录;全局来源是模块级状态,**每个文件 afterEach 必须调
 * `resetStarterTemplateSource()`**,不然会串到并行用例。
 */
export async function startRealUserLayer(dir: string, opts: { starter?: boolean } = {}): Promise<UserLayerService> {
  const service = createUserLayerService(opts.starter === false ? { dir } : { dir, starterDir: STARTER_LAYER_DIR })
  await service.ensure()
  await service.scan()
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE, ...service.layoutTemplates()],
    byId: id => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : service.layoutTemplate(id)),
  })
  return service
}

/** 全局模板来源复位回「只有 product」(与 server-user-layer-layouts.test.ts 的 afterEach 同款)。 */
export function resetStarterTemplateSource(): void {
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE],
    byId: id => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : undefined),
  })
}

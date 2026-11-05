/**
 * 用户层的加载口 · 客户端那一半(2026-10-21,卡「分层第一刀」;服务端那一半 `server/userLayer.ts`)。
 *
 * 服务端在 `/state.user_layer` 里报清单(哪一份替哪一格、内容指纹、坏了的那句话);这里按指纹去
 * `GET /user-layer/widgets/<id>/code` 取入口代码,按 CommonJS 跑一遍,拿到导出的那个组件,登记到那一格上。
 * `Workbench.tsx` 画那几格时问 `UserLayerCell`:有她的就画她的,没有 / 坏了就画本体自带的那一版。
 *
 * ## 为什么是 CommonJS + 白名单 require
 *
 * 工作台自己就是这么被 DSH 装进页面的(`lib/client.js` 是一个拿 `require` 的工厂),React 由宿主给;
 * 她的代码要用**同一份** React 才能和本体的格子长在一棵树上。白名单只有三样 —— react、react/jsx-runtime、
 * `@workbench/host`(`userLayerHost.ts` 那张表)—— 本体内部别的文件她碰不到,本体重构时只要守住那张表。
 *
 * ## 坏了跳过,三处都兜着
 *
 * 清单坏(服务端判)、代码跑不起来 / 导出名不对(这里判)、画的时候抛错(那一格自己的错误边界接住)——
 * 三种都只让**那一格**退回本体那一版,问题记在 `problems()` 里,设置里那一节原样上屏。
 *
 * ## 没取到 ≠ 坏了(2026-10-28)
 *
 * 取代码那一刻超时 / 网络错 / 非 200,是工作台那会儿忙,不是她的代码坏:退避 5 → 15 → 45 秒自动重试,
 * 最多 5 次,期间那一格说「工作台这会儿忙,…稍等接上」;重试用尽才算「没装上」并给「再试一次」键;
 * 页面重新可见也会把这类失败重取一次。代码跑不起来照旧不重试 —— 等她改文件,指纹变了自己重取。
 *
 * 页内小组件和本体同权限:这条路只给她自己放进 `用户层/小组件/` 的东西走;事务官派活做的「网页小组件」
 * 永远走沙箱那条路(`CustomModuleFrame.tsx`),不经过这里。
 */
import * as React from 'react'
import { Component, createElement, useCallback, useEffect, useState, useSyncExternalStore, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import type { UserLayerStateView, UserLayerWidgetView, WidgetSlotId } from '../protocol.ts'
import { DEFAULT_TEMPLATE_ID } from '../templates.ts'
import { USER_LAYER_HOST_ID, userLayerHost } from './userLayerHost.ts'

/**
 * 取代码最多等这么久;等不到算「那一刻工作台忙」进重试,不直接算坏(2026-10-28)。
 * 跟 /state 的慢阈值一个数:8791 正忙时 /state 一次要 8 秒(见 10-28 热点第三轮交接),取代码以它为准。
 */
export const USER_LAYER_LOAD_TIMEOUT_MS = 8_000
/** 没取到(超时 / 网络 / 非 200)的自动重试上限:初取之外最多再试这么多次。 */
export const USER_LAYER_FETCH_RETRY_MAX = 5
/** 重试退避(毫秒):第 1 次等 5 秒、第 2 次等 15 秒,之后 45 秒封顶。 */
export const USER_LAYER_FETCH_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const

/** 第 `attempt` 次重试(1 起)要等的毫秒数。 */
function fetchRetryDelayMs(attempt: number): number {
  return USER_LAYER_FETCH_RETRY_DELAYS_MS[Math.min(attempt, USER_LAYER_FETCH_RETRY_DELAYS_MS.length) - 1] ?? 45_000
}

const REQUIRABLE: Readonly<Record<string, unknown>> = Object.freeze({
  'react': React,
  'react/jsx-runtime': JsxRuntime,
  [USER_LAYER_HOST_ID]: userLayerHost,
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type EvaluateResult = { ok: true, exports: unknown } | { ok: false, problem: string }

/** 按 CommonJS 跑一份入口代码。`file` 只用来在出错时与调试器里说是哪一份。 */
export function evaluateWidget(code: string, file: string): EvaluateResult {
  const module = { exports: {} as unknown }
  const require = (name: string): unknown => {
    if (Object.hasOwn(REQUIRABLE, name)) return REQUIRABLE[name]
    throw new Error(`require('${name}') 不认识 —— 只有 ${Object.keys(REQUIRABLE).join('、')} 这三样`)
  }
  try {
    // eslint-disable-next-line no-new-func -- 加载口本身就是这件事;代码来自她自己的用户层目录
    const run = new Function('require', 'module', 'exports', `${code}\n//# sourceURL=user-layer/${file}`)
    run(require, module, module.exports)
  }
  catch (error) {
    return { ok: false, problem: `${file} 运行出错:${messageOf(error)}` }
  }
  return { ok: true, exports: module.exports }
}

type Entry =
  | { widget: UserLayerWidgetView, status: 'pending' }
  | { widget: UserLayerWidgetView, status: 'ready', component: ComponentType<Record<string, unknown>>, style?: string | undefined }
  | { widget: UserLayerWidgetView, status: 'retrying', attempt: number, problem: string }
  | { widget: UserLayerWidgetView, status: 'failed', problem: string, reason: 'fetch' | 'code' }

export type SlotResolution =
  | { kind: 'ready', id: string, key: string, component: ComponentType<Record<string, unknown>>, style?: string | undefined }
  | { kind: 'pending' }
  | { kind: 'retrying', message: string }
  | { kind: 'none', problem?: string, retry?: () => void }

export type LoadedWidget = { code: string, style?: string | undefined } | string

export interface UserLayerRegistry {
  /** 直接装一份(取到代码之后走的就是它;测试也用它)。装不上回 false,问题记下。 */
  install: (widget: UserLayerWidgetView, code: string, style?: string) => boolean
  /** 按 /state.user_layer 对齐。`undefined`(没接用户层的服务)= 一样都不动。 */
  sync: (view: UserLayerStateView | undefined, load: (widget: UserLayerWidgetView) => Promise<LoadedWidget>) => void
  /**
   * 页面重新可见时调:取不到重试用尽的那几格重取一次(失败是「那一刻工作台忙」,不是她的代码坏;
   * 代码跑不起来的那几格照旧等她改文件,指纹变了 sync 自己会重取)。
   */
  refetchFailed: (load: (widget: UserLayerWidgetView) => Promise<LoadedWidget>) => void
  resolve: (slot: WidgetSlotId, templateId: string | undefined) => SlotResolution
  /** 画的时候出的错(错误边界报上来)。 */
  report: (id: string, problem: string) => void
  /** 客户端这一侧判出来的问题(代码跑不起来、导出名不对、画的时候抛错)。清单坏的在服务端那份清单里。 */
  problems: () => ReadonlyMap<string, string>
  subscribe: (listener: () => void) => () => void
  version: () => number
  /** 那一格真画出来了(错误边界里那一层挂上了)。每个指纹只报一次。 */
  mounted: (id: string) => void
  /**
   * 装得怎样往哪报(`useUserLayerSync` 设成 `POST /user-layer/report`):画好过的那一版服务端存成上一版,
   * 坏了的那一版下一拍起服务端端上一版(自愈,见 server/userLayer.ts 文件头)。
   */
  setReporter: (reporter: UserLayerReporter | undefined) => void
}

export type UserLayerReporter = (outcome: { id: string, rev: string, ok: boolean, problem?: string, style_rev?: string | undefined }) => void

export function createUserLayerRegistry(): UserLayerRegistry {
  const entries = new Map<string, Entry>()
  /** 上一次清单里坏掉的那几份(那一格据此说一句话)。 */
  let broken: readonly UserLayerWidgetView[] = []
  const listeners = new Set<() => void>()
  let ticks = 0
  let reporter: UserLayerReporter | undefined
  let lastLoad: ((widget: UserLayerWidgetView) => Promise<LoadedWidget>) | undefined
  /** 排定中的重试计时器,一格一颗;换指纹 / 撤出清单时要先掐掉,别让旧重试落到新状态上。 */
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clearRetryTimer = (id: string): void => {
    const timer = retryTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      retryTimers.delete(id)
    }
  }
  const reported = new Set<string>()
  const tell = (widget: UserLayerWidgetView, ok: boolean, problem?: string): void => {
    if (widget.rev === undefined) return
    const key = `${widget.id}@${widget.rev}@${widget.style_rev ?? ''}@${ok ? 'ok' : 'bad'}`
    if (reported.has(key)) return
    reported.add(key)
    // 样式指纹原样带上:服务端按 入口@样式 组合记坏版(2026-10-23,卡「分层自愈完善」)。
    reporter?.({ id: widget.id, rev: widget.rev, ok, ...(widget.style_rev === undefined ? {} : { style_rev: widget.style_rev }), ...(problem === undefined ? {} : { problem }) })
  }
  const changed = (): void => {
    ticks += 1
    for (const listener of listeners) listener()
  }

  const install = (widget: UserLayerWidgetView, code: string, style?: string): boolean => {
    const ran = evaluateWidget(code, `${widget.id}/index.js`)
    let entry: Entry
    if (!ran.ok) entry = { widget, status: 'failed', problem: ran.problem, reason: 'code' }
    else {
      const name = widget.export ?? 'default'
      const exported = name === 'default'
        ? ran.exports
        : (typeof ran.exports === 'object' || typeof ran.exports === 'function') && ran.exports !== null
            ? (ran.exports as Record<string, unknown>)[name]
            : undefined
      entry = typeof exported === 'function'
        ? { widget, status: 'ready', component: exported as ComponentType<Record<string, unknown>>, ...(style === undefined ? {} : { style }) }
        : { widget, status: 'failed', problem: `${widget.id}/index.js 里没有导出「${name}」(widget.json 的 export 写的是它)`, reason: 'code' }
    }
    entries.set(widget.id, entry)
    clearRetryTimer(widget.id)
    if (entry.status === 'failed') tell(widget, false, entry.problem)
    changed()
    return entry.status === 'ready'
  }

  /**
   * 取一份小组件的代码(第 `attempt` 次,0 = 初取)。取到了就装;没取到按退避排下一次重试,
   * 最多 {@link USER_LAYER_FETCH_RETRY_MAX} 次 —— 那不是她的代码坏,是工作台那一刻忙。
   */
  const fetchOnce = (widget: UserLayerWidgetView, attempt: number, load: (widget: UserLayerWidgetView) => Promise<LoadedWidget>): void => {
    const stillWanted = (): boolean => {
      const cur = entries.get(widget.id)?.widget
      return cur !== undefined && cur.rev === widget.rev && cur.style_rev === widget.style_rev
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${USER_LAYER_LOAD_TIMEOUT_MS / 1000} 秒没取到`)), USER_LAYER_LOAD_TIMEOUT_MS)
    })
    void Promise.race([load(widget), timeout]).then(
      (loaded) => {
        if (!stillWanted()) return
        if (typeof loaded === 'string') install(widget, loaded)
        else install(widget, loaded.code, loaded.style)
      },
      (error) => {
        if (!stillWanted()) return
        const problem = `读不到 ${widget.id} 的代码:${messageOf(error)}`
        if (attempt < USER_LAYER_FETCH_RETRY_MAX) {
          const next = attempt + 1
          entries.set(widget.id, { widget, status: 'retrying', attempt: next, problem })
          changed()
          const timer = setTimeout(() => {
            retryTimers.delete(widget.id)
            fetchOnce(widget, next, load)
          }, fetchRetryDelayMs(next))
          retryTimers.set(widget.id, timer)
        }
        else {
          entries.set(widget.id, { widget, status: 'failed', problem, reason: 'fetch' })
          changed()
        }
      },
    ).finally(() => clearTimeout(timer))
  }

  /** 「再试一次」键 / 页面重新可见:把取不到失败的那一格从 pending 重新起一轮。 */
  const refetchOne = (widget: UserLayerWidgetView): void => {
    if (lastLoad === undefined) return
    const current = entries.get(widget.id)
    if (current?.status !== 'failed' || current.reason !== 'fetch') return
    clearRetryTimer(widget.id)
    entries.set(widget.id, { widget: current.widget, status: 'pending' })
    changed()
    fetchOnce(current.widget, 0, lastLoad)
  }

  return {
    install,
    sync(view, load) {
      if (view === undefined) return
      lastLoad = load
      broken = view.widgets.filter(widget => widget.status !== 'ok')
      const ok = new Map(view.widgets.filter(widget => widget.status === 'ok').map(widget => [widget.id, widget]))
      for (const id of [...entries.keys()]) if (!ok.has(id)) {
        clearRetryTimer(id)
        entries.delete(id)
      }
      for (const widget of ok.values()) {
        const current = entries.get(widget.id)
        // 同一个指纹(包含代码 rev 与兼容样式 style_rev)不重取:跑不起来的那一份在她改文件(指纹变)之前一直算坏的,不每拍重试。
        if (current !== undefined && current.widget.rev === widget.rev && current.widget.style_rev === widget.style_rev && current.widget.replaces === widget.replaces) continue
        clearRetryTimer(widget.id)
        entries.set(widget.id, { widget, status: 'pending' })
        fetchOnce(widget, 0, load)
      }
      changed()
    },
    refetchFailed(load) {
      lastLoad = load
      for (const entry of [...entries.values()]) {
        if (entry.status === 'failed' && entry.reason === 'fetch') refetchOne(entry.widget)
      }
    },
    resolve(slot, templateId) {
      const template = templateId ?? DEFAULT_TEMPLATE_ID
      const fits = (widget: UserLayerWidgetView): boolean =>
        widget.replaces === slot && (widget.templates === undefined || widget.templates.includes(template))
      for (const entry of entries.values()) {
        if (!fits(entry.widget)) continue
        if (entry.status === 'ready') return {
          kind: 'ready',
          id: entry.widget.id,
          key: `${entry.widget.id}@${entry.widget.rev ?? ''}@${entry.widget.style_rev ?? ''}`,
          component: entry.component,
          ...(entry.style === undefined ? {} : { style: entry.style }),
        }
        if (entry.status === 'pending') return { kind: 'pending' }
        if (entry.status === 'retrying') {
          return { kind: 'retrying', message: `工作台这会儿忙,${entry.widget.name}稍等接上(第 ${entry.attempt} 次重试)` }
        }
        return entry.reason === 'fetch'
          ? { kind: 'none', problem: entry.problem, retry: () => refetchOne(entry.widget) }
          : { kind: 'none', problem: entry.problem }
      }
      const bad = broken.find(widget => widget.replaces === undefined ? widget.id === slot : fits(widget))
      return bad?.problem === undefined ? { kind: 'none' } : { kind: 'none', problem: bad.problem }
    },
    report(id, problem) {
      const entry = entries.get(id)
      if (entry === undefined) return
      entries.set(id, { widget: entry.widget, status: 'failed', problem, reason: 'code' })
      tell(entry.widget, false, problem)
      changed()
    },
    mounted(id) {
      const entry = entries.get(id)
      if (entry?.status === 'ready') tell(entry.widget, true)
    },
    setReporter(next) { reporter = next },
    problems() {
      const out = new Map<string, string>()
      for (const [id, entry] of entries) if (entry.status === 'failed') out.set(id, entry.problem)
      return out
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    version: () => ticks,
  }
}

/** 页面上那一份。`Workbench` 与设置里那一节缺省都用它。 */
export const userLayerRegistry = createUserLayerRegistry()

/** 跟着 /state.user_layer 去取代码。只看「哪几份、什么指纹」变没变,不每拍都对一遍。 */
export function useUserLayerSync(
  registry: UserLayerRegistry,
  view: UserLayerStateView | undefined,
  baseUrl: string,
  fetchImpl: typeof fetch,
): void {
  const signature = view === undefined
    ? undefined
    : JSON.stringify(view.widgets.map(widget => [widget.id, widget.status, widget.rev, widget.replaces, widget.export, widget.templates, widget.problem, widget.style_rev]))
  useEffect(() => {
    registry.setReporter((outcome) => {
      void fetchImpl(`${baseUrl}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(outcome) }).catch(() => undefined)
    })
    return () => registry.setReporter(undefined)
  }, [registry, baseUrl, fetchImpl])
  const load = useCallback(async (widget: UserLayerWidgetView): Promise<LoadedWidget> => {
    const [codeRes, styleRes] = await Promise.all([
      fetchImpl(`${baseUrl}/user-layer/widgets/${encodeURIComponent(widget.id)}/code?rev=${widget.rev ?? ''}`),
      widget.style_rev !== undefined
        ? fetchImpl(`${baseUrl}/user-layer/widgets/${encodeURIComponent(widget.id)}/style?rev=${widget.style_rev}`)
        : Promise.resolve(undefined),
    ])
    if (!codeRes.ok) throw new Error(`工作台服务回了 ${codeRes.status}`)
    // 清单说这一版带 style.css 而样式取不到 = 这一版没装好(按坏版报,不拿没样式的页面冒充装好)。
    if (widget.style_rev !== undefined && (styleRes === undefined || !styleRes.ok)) {
      throw new Error(`style.css 没取到(工作台服务回了 ${styleRes?.status ?? '没响应'})`)
    }
    const code = await codeRes.text()
    const style = styleRes?.ok ? await styleRes.text() : undefined
    return { code, style }
  }, [baseUrl, fetchImpl])
  useEffect(() => {
    if (view === undefined) return
    registry.sync(view, load)
    // view 本身每拍都是新对象;按签名判。
  }, [registry, signature, load])
  // 页面重新可见:取不到重试用尽的那几格重取一次(那一刻工作台忙,不是她的代码坏)。
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') registry.refetchFailed(load)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [registry, load])
}

export function useUserLayerSlot(registry: UserLayerRegistry, slot: WidgetSlotId, templateId: string | undefined): SlotResolution {
  useSyncExternalStore(registry.subscribe, registry.version, registry.version)
  return registry.resolve(slot, templateId)
}

/* ───────────────────────────── 布局模板的皮肤(2026-10-23,分层二刀二)───────────────────────────── */

/** 取过的皮肤按 `模板id@皮肤指纹` 缓存在这里:同一份不再发请求,指纹变(她改了文件)就重取。 */
const skinCache = new Map<string, { rev: string, css: string }>()

/**
 * 当前模板那一层皮肤:从 `/state.user_layer.layouts` 里找当前模板带不带皮肤,带了就去
 * `GET /user-layer/layouts/<id>/skin` 取 css 原文。**本体不内置任何模板皮肤** —— 没有
 * 皮肤(或还没取到 / 取失败)回 undefined,页面什么都不注入。取失败 / 组件卸载静默吞。
 */
export function useUserLayerSkin(
  view: UserLayerStateView | undefined,
  templateId: string | undefined,
  baseUrl: string,
  fetchImpl: typeof fetch,
): string | undefined {
  const layout = templateId === undefined ? undefined : view?.layouts?.find(one => one.id === templateId)
  const skinRev = layout?.status === 'ok' ? layout.skin_rev : undefined
  const key = skinRev === undefined || templateId === undefined ? undefined : `${templateId}@${skinRev}`
  const [fetched, setFetched] = useState<{ key: string, css: string } | undefined>(undefined)
  useEffect(() => {
    if (key === undefined) return
    if (skinCache.has(key)) return
    let mounted = true
    void (async () => {
      try {
        const id = key.slice(0, key.lastIndexOf('@'))
        const res = await fetchImpl(`${baseUrl}/user-layer/layouts/${encodeURIComponent(id)}/skin?rev=${encodeURIComponent(key.slice(key.lastIndexOf('@') + 1))}`)
        if (!res.ok) throw new Error(`工作台服务回了 ${res.status}`)
        const css = await res.text()
        skinCache.set(key, { rev: key.slice(key.lastIndexOf('@') + 1), css })
        if (mounted) setFetched({ key, css })
      }
      catch {
        // 取不到就当她没带皮肤:不注入、不嚷嚷。
      }
    })()
    return () => { mounted = false }
  }, [view, key, baseUrl, fetchImpl])
  if (key === undefined) return undefined
  return skinCache.get(key)?.css ?? (fetched?.key === key ? fetched.css : undefined)
}

/** 挂上了就报一声「这一版画好过」(渲染时抛错的那一版到不了这里)。 */
function Mounted({ onMounted, children }: { onMounted: () => void, children: ReactNode }) {
  // 只在挂上那一下报:换了指纹,外面那层错误边界按 key 整个重挂,这里跟着再报一次。
  useEffect(() => { onMounted() }, [])
  return <>{children}</>
}

class WidgetBoundary extends Component<{ onError: (error: unknown) => void, fallback: ReactNode, children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onError(error)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * 一格:有她的画她的(包在错误边界里),在取代码就画 `pending`(格子的空壳,不先闪本体那一版),
 * 取不到在退避重试就画 `retrying`(「工作台这会儿忙…」,不是「没装上」),都没有 / 坏了就画
 * `fallback`(本体自带的那一版;那一格本体没有自带的,就是一句人话;取不到重试用尽的会多给
 * 一颗「再试一次」键,点了再走 `retry`)。
 */
export function UserLayerCell({ registry = userLayerRegistry, slot, templateId, props, fallback, pending, retrying }: {
  registry?: UserLayerRegistry
  slot: WidgetSlotId
  templateId: string | undefined
  props: Record<string, unknown>
  fallback: (problem?: string, retry?: () => void) => ReactNode
  pending: ReactNode
  /** 重试中那一格画什么;缺席就退回画 `pending`。 */
  retrying?: (message: string) => ReactNode
}) {
  const hit = useUserLayerSlot(registry, slot, templateId)
  if (hit.kind === 'pending') return <>{pending}</>
  if (hit.kind === 'retrying') return <>{retrying === undefined ? pending : retrying(hit.message)}</>
  if (hit.kind === 'none') return <>{fallback(hit.problem, hit.retry)}</>
  return (
    <WidgetBoundary
      key={hit.key}
      fallback={fallback()}
      onError={(error) => { registry.report(hit.id, `画这一格时出错:${messageOf(error)}`) }}
    >
      {hit.style !== undefined && <style>{hit.style}</style>}
      <Mounted onMounted={() => registry.mounted(hit.id)}>{createElement(hit.component, props)}</Mounted>
    </WidgetBoundary>
  )
}

/**
 * 订阅工作台本地服务的状态。
 *
 * 用轮询而不是 WS：工作台界面跟服务同在一台机器上，1 秒一次的本地 HTTP 开销可以忽略，
 * 而轮询天然容忍服务重启——WS 断了要自己写重连，轮询下一拍自己就好了。
 * （展示台那边用 WS，因为它要的是即时推送而不是自己掐表。）
 *
 * PRD §2.2 的"不引入后台扫描器"说的是不去扫别人的日志/进程；
 * 读自己服务的一个快照接口不属于那一类。
 *
 * state 本身就是完整的 WorkbenchState（projects/layout/machine/badges/paused 等
 * 都在上面），这里不再另挑几个字段手填参数糊出一份假数据——闲置线以前靠调用方
 * 手填 idleProjects，现在项目区直接由服务端 projects 字段供数，这条手填通道已删。
 */
import { useEffect, useMemo, useState } from 'react'
import type { WorkbenchState } from '../protocol.ts'
import { fetchState, groupByAgent, offlineState, quotaSummary } from './sessionFeed.ts'
import { installClientErrorReporter } from './reportClientError.ts'
import { registryEntries } from './agentRegistryView.ts'

/**
 * 服务地址的**最后兜底**(2026-09-26,卡 GP 之后只剩这一个作用)。
 *
 * 正路是宿主半区按 `WORKBENCH_HOST` / `WORKBENCH_PORT` 算好、经 DSH 的 index 注入表递给页面
 * (`../serviceOrigin.ts` → `client/index.ts` 的 `serviceBaseUrlForPage`)。这个常量只在
 * **那一条路断了**的时候顶一下(注入表里没有我们那一行、或者这个 hook 被某处直接调用),
 * 并且断了的那一下 `client/index.ts` 已经在日志里说过一句「没拿到服务地址,退回 …」。
 *
 * 它也是整个页面里**唯一**允许写死 8791 的地方 —— `tests/client-service-origin.test.ts`
 * 守着这一条:`src/client/` 下再出现第二处写死的 8791,那个用例当场红。
 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8791'
const POLL_MS = 1000

export interface UseWorkbenchStateOptions {
  baseUrl?: string
  pollMs?: number
  fetchImpl?: typeof fetch
}

export function useWorkbenchState(options: UseWorkbenchStateOptions = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const pollMs = options.pollMs ?? POLL_MS
  const fetchImpl = options.fetchImpl
  // 第一帧就给 stale 空快照，界面永远有东西可渲染，不会闪白。
  const [state, setState] = useState<WorkbenchState>(offlineState)
  // S2(a)(review,真机截图实证):loaded 标出"第一次真的问过服务一次"——不管那次问到的
  // 是正常快照还是失败退回的 stale 空快照,只要问过一次就是 true,并且只在第一次成功
  // 落定那一刻(setState 同一批)一起翻,不会有"loaded 已经 true 但 state 还是上一拍"
  // 的中间态。调用方(Workbench.tsx)拿它给"槽位矩形上报"这类会造成真机可见副作用的
  // 逻辑把关——组件挂载的第一拍如果什么都不问就先动手,量出来的东西天然是"本地默认值"
  // 而不是服务端的真相,汇报出去等真相到了还得再报一次,真机上就是"贴住的窗口自己跳了
  // 一下"那类抖动的成因之一。
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    const read = async () => {
      const next = await fetchState(baseUrl, fetchImpl)
      if (!alive) return
      setState(next)
      setLoaded(true)
    }
    void read()
    if (pollMs <= 0) return () => { alive = false }
    const timer = setInterval(() => { void read() }, pollMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [baseUrl, pollMs, fetchImpl])

  /**
   * **页面上出的错报给服务端**(2026-09-25,卡 V)。09-25 晚维护者点「事务官」没反应、页面卡死,
   * 而没有任何地方记录 —— 壳是 WKWebView,那个控制台他打不开、统筹也看不到。
   * 挂在这里(而不是某个组件里):整屏只有一份 `/state` 轮询,这一份的寿命就是页面的寿命。
   * 报错这条路本身绝不抛(见 reportClientError.ts 的四条纪律)。
   */
  useEffect(() => {
    if (typeof globalThis.addEventListener !== 'function') return
    const reporter = installClientErrorReporter({ baseUrl, ...(fetchImpl === undefined ? {} : { fetchImpl }), where: 'desktop' })
    return () => reporter.dispose()
  }, [baseUrl, fetchImpl])

  // 会话分组按 Agent 登记表(2026-09-25,卡 Q):接上了的那几家各一组。
  const groups = useMemo(() => groupByAgent(registryEntries(state)), [state])
  const quotaText = useMemo(() => quotaSummary(state.quota), [state.quota])

  return { state, groups, quotaText, baseUrl, loaded }
}

import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
// 0.1.2-rc.1 起的类型合并来源(只为声明合并,不产生运行时依赖):
// - ui-workspace/client:Context.uiWorkspace(connectWorkspace 从 workspaces 搬到这里;
//   0.1.7-rc.2 起 openSession 也在这里,见下面 openSession 的注释)+ 全局标准属性 useWorkspaces
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// - ui-session/client:全局标准属性 useSessions(测试里按完整 props 传入)
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkbenchButton, WorkbenchOverlay } from './Workbench.tsx'
import { createWorkbenchStore } from './store.ts'
import { registerShellOnboardingGate } from './onboardingGate.ts'
import { installWindowDrag } from './windowDrag.ts'
import { readServiceBaseUrl } from '../serviceOrigin.ts'
import { DEFAULT_BASE_URL } from './useWorkbenchState.ts'

/**
 * 这一页该打哪台服务(2026-09-26,卡 GP)。宿主半区按 `WORKBENCH_HOST` / `WORKBENCH_PORT`
 * 算好,经 DSH 的 index 注入表递进来(整条链路与理由见 `../serviceOrigin.ts` 文件头)。
 *
 * **拿不到时退回 `DEFAULT_BASE_URL`,并且在日志里说一句**。以前这条路是全静默的:页面把
 * 8791 写死,灰度实例的页面于是一直在拿生产的服务做事,而界面上一切正常 —— 这种沉默失效
 * 只有留下一句话才查得出来。用 console.warn(不是 `/client/error` 那条上报路:那条只收真
 * 报错,而这里是"退回兜底"这一个事实),无头浏览器与 Safari 调试器里都看得见。
 *
 * @param scope 一般是 `globalThis`;用例传一个假对象。
 * @returns 注入进来的地址,拿不到就是 undefined(由调用方决定退回哪里)。
 */
export function serviceBaseUrlForPage(scope: object = globalThis): string | undefined {
  const injected = readServiceBaseUrl(scope)
  if (injected === undefined) {
    console.warn(`[工作台] 没拿到服务地址,退回 ${DEFAULT_BASE_URL}`)
  }
  return injected
}

/**
 * 0.1.7-rc.2 起不再 inject `sessions`:`ISessions` 把 `open` / `openSubagent` / `clear`
 * 删了(上游注释「导航归视图所有者」),导航一律走 `uiWorkspace`。我们只用导航,
 * 所以整条 `ctx.sessions` 依赖可以摘掉——少一条依赖,少一处升级时要盯的接触面。
 */
export const inject = ['slots', 'uiWorkspace']

/** Register Ben's full-screen portfolio and the sidebar action that restores it. */
export function apply(ctx: Context): void {
  // 全屏界面(登录屏 / 启动弹窗 / 首次引导 / 整屏密钥引导)不渲染 TopBar,没有拖拽落点。
  // 监听装在 document 上一次就够,之后界面怎么切都在;主工作台有 TopBar 时它整体让开。
  // 不在壳里(普通浏览器)消息发不出去,这一层什么也不做。
  if (typeof document !== 'undefined') installWindowDrag(document, window)
  const store = createWorkbenchStore()
  /**
   * 这一页该打哪台服务(卡 GP)。读一次、整页共用一份 —— 浮层底下每一处请求都从
   * `WorkbenchOverlay` 这一个 prop 往下传(`useWorkbenchState` 把它当 `baseUrl`,
   * 别处一律用 `feed.baseUrl`),于是"所有请求走同一个地址"是**构造上**成立的,
   * 不是靠每个调用点自己记得。
   */
  const serviceBaseUrl = serviceBaseUrlForPage()

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'ben-workbench',
    order: 0,
    store,
    inject: (actions: BoundActions<typeof store>) => ({
      // 拿不到就不传这一项:`useWorkbenchState` 那边 `?? DEFAULT_BASE_URL` 兜底(日志已经说过了)。
      ...(serviceBaseUrl === undefined ? {} : { serviceBaseUrl }),
      /**
       * 打开某条事项底下那段对话(2026-09-10 事项收件箱)。
       *
       * 两步缺一不可:`uiWorkspace.openSession` 让 DSH 切到那条会话,`actions.close()`
       * 把工作台浮层让开——浮层盖着整屏,不让开的话点完什么都看不到。回来的路是侧边栏
       * 那颗按钮(WorkbenchButton),与"进项目"那条路(openWorkspace)一模一样。
       *
       * 2026-09-25 升到 0.1.7-rc.2:原来这里调的是 `ctx.sessions.open`,0.1.7 把它从
       * `ISessions` 删了(「导航归视图所有者」),同形的那一个在 `ctx.uiWorkspace` 上,
       * 参数从 SessionId 放宽成 `SessionTarget`(SessionId | 子代理地址)。行为不变。
       *
       * **不 try/catch**:`openSession` 对不认识的 id 是 fail loud(DSH 客户端契约),
       * 而我们给它的 id 来自服务端记在卡上的那条会话——真出现"点了打不开",那正是
       * 需要在控制台看见的事实,悄悄吞掉只会变成"点了没反应"。
       */
      openSession: (sessionId: string): void => {
        // 品牌类型用 SessionTarget 而不是再 link 一个包:SessionId 住在
        // @deepseek-ai/dsh-session/types,为一个纯编译期的品牌再加一条 link 依赖不划算。
        ctx.uiWorkspace.openSession(sessionId as SessionTarget)
        actions.close()
      },
      /**
       * 进项目(2026-09-10)。0.1.7 的 `uiWorkspace` 另有一个整合好的 `openWorkspace`,
       * 我们**不用**它:它失败时会自己在上游的 workspace notice 上说话(上游的界面从我们
       * 这一层的缝里露出来,维护者明令不许),而 superseded 那一档会跳过 beforeOpen,
       * 浮层就不会让开。`connectWorkspace` + `openSession` 这两步 0.1.7 都还在,行为可控。
       */
      openWorkspace: async (workspaceId: string, projectName: string): Promise<void> => {
        try {
          const sessionId = await ctx.uiWorkspace.connectWorkspace(workspaceId as WorkspaceId)
          ctx.uiWorkspace.openSession(sessionId)
          actions.close()
        } catch {
          actions.failOpening(`无法进入 ${projectName}，请稍后重试。`)
        }
      },
    }),
  }, WorkbenchOverlay))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'ben-workbench',
    order: -100,
    store,
  }, WorkbenchButton))

  // 壳里不弹上游「内测声明」「添加一个 API Key」(2026-09-23):同一个 settings.onboarding 槽里排一步在最前面。
  // 理由与风险见 onboardingGate.ts 文件头。
  registerShellOnboardingGate(ctx.slots)
}

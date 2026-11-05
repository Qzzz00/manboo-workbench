/**
 * 壳里不弹上游的首次设置框(2026-09-23,卡 fix/onboarding-stale-session 事实二)。
 *
 * **上游怎么弹**(dsh 0.1.2-rc.1,只读核过):
 * - `dsh-client-ui-settings-models` 往 `settings.onboarding` 槽注册两步:`welcome-notice`(order -100,内测声明)
 *   与 `deepseek-official`(order 0,「添加一个 API Key」)。后者的判据 `onboardingReadiness`:
 *   有**任何一个**可用 provider 就不弹;可用 = 路由已注册且(profile 没写 `apiKeyEnv`,或写了且凭据已配)。
 *   workbench-relay 写的是 `apiKeyEnv: WORKBENCH_RELAY_TOKEN`,令牌登录后才进 `~/.dsh/.env`,
 *   所以**登录前一定弹**;弹的时候 `OnboardingModal` 把 `#root` 设成 inert —— 工作台浮层(含注册页)整页点不动。
 * - `dsh-client-ui-settings-general` 的 `SettingsRoot` 只渲染**第一个还没 complete 的那一步**
 *   (`onboardingSteps.find(step => !completedOnboarding.has(step.id))`,按 order 升序)。
 *   上游没有任何看 URL 参数的判断,所以 `?ben-workbench=app` 里照弹。
 *
 * **我们怎么拦**:用同一个扩展点排一步在最前面(order {@link GATE_ORDER})。
 * - 壳模式(`?ben-workbench=app`):这一步什么都不画、**永远不 complete** —— 后面两步排不到,一个都不弹。
 *   壳里本来就看不到 DSH 的对话界面(工作台浮层盖满、没有「返回对话」),模型与令牌由工作台自己的
 *   注册 / 模型面板管;上游那个框在壳里只会挡路。
 * - 不是壳(浏览器里直接开 3080):立刻 complete,上游照旧 —— 我们只管自己的壳。
 *
 * 不改上游代码、不藏 DOM、不认类名。**风险**:上游要是改成「几步同时画」或不再按 order 排,
 * 这一步就拦不住了;`tests/client-onboarding-gate.test.ts` 里有一条读上游源码的自检,那两处一变就红。
 *
 * ## 0.1.7-rc.2 复核(2026-09-25,升级卡 U2)
 *
 * 上面那两条判据一字未变(`onboardingSteps.find(step => !completedOnboarding.has(step.id))`、
 * `.sort((a, b) => a.order - b.order)`),上游两步的 id 与 order 也没变,所以**按顺序排**这条路照旧拦得住。
 * 0.1.7 多了两件事:
 *
 * 1. `welcome-notice` 改成只在 `!('dshDesktop' in globalThis)` 时注册 —— 官方 Electron 端不注册,
 *    网页端(我们)照旧注册,所以这一步仍要挡。
 * 2. **多了一条绕过口**:`SettingsRoot` 新增 `requestedOnboarding` —— 谁「点名要某一步」就按 id 直接找,
 *    不走 order、不看 complete,我们这一步挡不住。全仓核过:点名的唯一入口是 `settings.launcher`
 *    席位的 owner prop `openOnboarding(id)`,而全上游只有 **`ui-settings-account` 的 `AccountMenu`**
 *    调它(登录框里那句「改用 API Key」→ `openOnboarding('deepseek-official')`)。
 *    也就是说:**这条绕过口只在「账号」那套界面露出来时才存在**,挡它的地方在 profile patch
 *    (`ui-settings-account` 关掉)而不是这里 —— 上游的按钮我们没法从这一步拦。
 *    真要在壳里留账号菜单,得另想办法(那时这一步要改成「点名也拦」)。
 */
import { useEffect } from 'react'
import { inShellApp } from './shell.ts'

/** 排在上游两步(-100、0)之前。 */
export const GATE_ORDER = -1000
export const GATE_ID = 'ben-workbench-shell-gate'

export interface OnboardingStepProps {
  /** 上游 `settings.onboarding` 槽给每一步的:做完了就调它,下一步才轮得到。 */
  complete: () => void
}

export function shellGateHolds(location: { search: string, hash: string } = window.location): boolean {
  return inShellApp(location.search, location.hash)
}

/** 壳里:不画、不 complete(挡住后面的上游步骤);壳外:马上 complete。 */
export function ShellOnboardingGate({ complete }: OnboardingStepProps): null {
  const holds = shellGateHolds()
  useEffect(() => {
    if (!holds) complete()
  }, [holds, complete])
  return null
}

/**
 * 上游 `settings.onboarding` 槽的类型声明在 `dsh-client-ui-settings-general/client`,本插件没链它
 * (为一个槽名多一条 link 依赖不划算),这里只描述用到的那两个口。
 */
interface OnboardingSlotHost {
  inject: (name: 'settings.onboarding', callback: () => unknown) => unknown
  register: (options: { name: 'settings.onboarding', id: string, order: number }, component: typeof ShellOnboardingGate) => unknown
}

export function registerShellOnboardingGate(slots: unknown): void {
  const host = slots as OnboardingSlotHost
  host.inject('settings.onboarding', () => host.register({ name: 'settings.onboarding', id: GATE_ID, order: GATE_ORDER }, ShellOnboardingGate))
}

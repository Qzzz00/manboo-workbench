/**
 * `GlobalStandardProps` 里工作台用不到的那几个 hook 的空桩(2026-09-25 升到 0.1.7-rc.2,卡 U2)。
 *
 * ## 为什么集中放一处
 *
 * DSH 的席位契约规定:注册进某个席位的组件,宿主会把一套「标准属性」全部传进来,
 * 类型上是**必填**的。我们的整屏只用其中两个(`useWorkspaces`、`useSessions`),
 * 其余的必须在测试里给个桩,不然 `render(<WorkbenchOverlay {...props} />)` 编译不过。
 *
 * 这套属性**每次升 DSH 都会变**:0.1.2-rc.1 加了 `useSessionPendingInteraction`,
 * 0.1.7-rc.2 又把它拿掉、换成 `usePanelInfo` / `useSessionStatus` / `useSessionRetainInfo`。
 * 以前这些桩逐字抄在 29 个测试文件里,升一次就要改 30 处。集中到这里之后,下次只改这一个文件。
 *
 * ## 为什么写成 `Pick<GlobalStandardProps, …>`
 *
 * 光写个对象再 spread 进去,会把两边的检查都丢掉:上游**删**掉其中一个,spread 不报错
 * (多余属性检查对 spread 不生效),桩就悄悄变成死代码。标上 `Pick<…>` 之后:
 * 上游删掉某一个 → 这个文件当场红;上游**加**了新的必填属性 → 29 个调用点当场红,
 * 报的还是「缺哪个属性」。两个方向都还看得见,而要改的地方只有一处。
 *
 * 只放「我们用不到」的那些。用得到的两个(`useWorkspaces`、`useSessions`)各文件自己给真值,
 * 有些用例还对它们断言,不能在这里兜底。
 */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
// 这两条 import 只为把声明合并带进本文件的程序:GlobalStandardProps 的成员是它们合并上去的。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

/** 工作台用不到、但席位契约要求传的标准属性。 */
export const UNUSED_STANDARD_PROPS: Pick<
  GlobalStandardProps, 'usePanelInfo' | 'useSessionStatus' | 'useSessionRetainInfo'
> = {
  usePanelInfo: (() => undefined) as never,
  useSessionStatus: (() => undefined) as never,
  useSessionRetainInfo: (() => undefined) as never,
}

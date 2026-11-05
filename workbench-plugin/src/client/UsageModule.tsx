/**
 * 由 Workbench.tsx 的模块渲染循环拆出(2026-08-25 地基:六窗口并行前的接缝切分)。
 * **JSX 逐字搬运,没有改一行行为**——四块需求本来都要改同一个 1190 行文件,
 * 拆成"一个模块一个文件"之后各窗口各改各的,合并时不再互相踩。
 *
 * ★ 2026-10-03:「消耗数据」这一格**按模板分流,分叉只在这一个文件里**
 * (维护者原话:「产品研发布局改回之前的样子……主要是消耗数据,改成我自己之前在用的啊,
 * 其他的可以不改」)。另外五格两种模板都用运营同学(Air)那一版,不分流。
 *
 * ★ 2026-10-21(卡「分层第一刀」):他那一版面板搬进了用户层(`user-layer/起步/小组件/usage/`),
 * 分流从这里的 if 变成那份 widget.json 里的 `templates: ["ops"]` —— 这一格里面那块面板是
 * 用户层能替的一格(`usage-panel`),没装 / 坏了 / 不是运营模板都画本体这一版。
 */

import type { ReactNode } from 'react'
import type { TemplateStateView, WorkbenchState } from '../protocol.ts'
import { DEFAULT_TEMPLATE_ID } from '../templates.ts'
import { ModuleBox, type ModuleBoxProps } from './ModuleBox.tsx'
import { UsagePanel as ProductUsagePanel } from './UsagePanel.tsx'
import { UserLayerCell, userLayerRegistry, type UserLayerRegistry } from './userLayer.tsx'
import { EmptyState } from './EmptyState.tsx'
import type { EmptyView } from './emptyState.ts'

/**
 * 这台机器此刻该看哪一版面板。
 *
 * **非缺省模板 = 他那一版,缺省(product)及其余一律产品研发那一版** —— 包括模板整块缺席
 * (展示台、手机、一大批用例)那种情况:缺席按缺省模板算,而缺省模板是 `product`
 * (见 templates.ts 的 DEFAULT_TEMPLATE_ID),所以老客户端与没接模板服务的那些地方
 * 看到的与 0.4.89 逐字相同。
 *
 * 判据(2026-10-23,分层二刀二):模板 id 是不是缺省那个 —— 运营模板的内容搬进了用户层
 * `布局/ops.json`,本体不再认识 "ops" 这个名字;「她选过做产品之外的一套」与旧行为逐字一致
 * (那时只有 ops 这一套非缺省模板),用户层加的别的非缺省模板也用她那一版面板的同一条路。
 */
export function usesAirUsagePanel(template: TemplateStateView | undefined): boolean {
  return template !== undefined && template.id !== DEFAULT_TEMPLATE_ID
}

export function UsageModule({ box, header, headingId, feed, empty, userLayer = userLayerRegistry }: {
  box: ModuleBoxProps
  header: ReactNode
  headingId: string
  feed: { state: WorkbenchState }
  /**
   * 第一次用且一条消耗记录都没有(2026-09-18)。**给了就整块不画图表**——首次那一刻
   * 面板里只有"用量未接入""这段时间没有用量记录"几个字加一堆空轨道,那是旧样子,
   * 不是空态。Ben 原话是"这些本质上都得引导用户去处理"。
   */
  empty?: EmptyView
  userLayer?: UserLayerRegistry
}) {
  /*
   * ★ 这里就是那一处分叉。他那一版多收一个 `now` —— 按它算「今天」(按本机时区归日,
   * `usage.timezone` 是尺子),`usage.scanned_at` 是退路;产品研发那一版自己从
   * `days` 的末尾取,不收 `now`。两版的 props 就差这一个,所以不套统一门面。
   */
  /*
   * ★ 2026-10-04:他那一版还多收 `quota` / `agentQuota` —— 面板顶上那张「Codex 剩余额度」卡
   * 从这两格读真数(判据在 `client/codexQuota.ts`,取不到就照实说「暂未读取」,一个数都不推算)。
   * 产品研发那一版不收 —— 它那边额度本来就在「额度」那一格里,不在消耗数据上重复摆一张。
   */
  const panel = (
    <UserLayerCell
      registry={userLayer}
      slot="usage-panel"
      templateId={feed.state.template?.id}
      props={{
        usage: feed.state.usage,
        now: feed.state.now,
        quota: feed.state.quota,
        ...(feed.state.agent_quota === undefined ? {} : { agentQuota: feed.state.agent_quota }),
      }}
      fallback={() => <ProductUsagePanel usage={feed.state.usage} />}
      pending={null}
    />
  )
  return (
    <ModuleBox {...box}>
      <section className="ben-wb__card ben-wb__card--fill" aria-labelledby={headingId}>
        {header}
        {empty === undefined ? panel : <EmptyState view={empty} />}
      </section>
    </ModuleBox>
  )
}

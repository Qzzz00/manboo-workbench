/**
 * 连接器的**动作策略**:默认只读(卡 OC,2026-09-27)。
 *
 * 为什么要自己生成一份白名单 ——
 * open-connector 自带的 `actionPolicy` 只按**动作 id** 匹配(`service.*` 与 `*`),
 * 它**不认**「只读 / 写 / 破坏性」这个维度。但它的 catalog 里每一个动作都带
 * `operationType: 'read' | 'write' | 'destructive'`(2026-09-27 实测:18010 个动作里
 * read 12051、write 4013、destructive 1946)。所以「默认只读」这件事只能由我们
 * 在装的时候**按 catalog 算出一份 id 白名单**交给它。
 *
 * 三条硬规矩:
 * 1. **白名单制,不是黑名单**。没在单子上的一律 `action_not_allowed` ——
 *    新版本加进来的动作默认进不来,而不是默认放行。
 * 2. **没启用任何一家 = 什么都不许做**。它把「空白名单」当成「没有白名单 = 全放行」,
 *    所以空的时候必须塞一条匹配不到任何东西的哨兵。这一条漏掉就是全开,务必留着测试。
 * 3. **写 / 发布类动作不进这份单子**。要发一篇公众号,得走工作台「先问我」那一路
 *    临时放行(见 `docs/设计-连接器通用能力-2026-09-27.md` 第六节),批完即撤。
 */

/** catalog 里一个 provider 的形状,只取我们用得上的几格。 */
export interface ConnectorCatalogApp {
  service: string
  displayName?: string
  actions: readonly { id: string, name?: string, operationType?: string }[]
}

/** 读 catalog 的注入口。读不到回 `undefined` —— 不猜、不编,调用方据此说「这一家还没装上」。 */
export type ConnectorCatalogReader = (service: string) => ConnectorCatalogApp | undefined

/**
 * 空白名单的哨兵。
 *
 * 它必须是一条**永远匹配不上任何真动作**的字面量。真动作 id 一律是 `<service>.<name>`,
 * service 里不会出现 `:`,所以这一条安全。
 */
export const CONNECTOR_POLICY_SENTINEL = 'workbench:none.none'

export interface ConnectorPolicyInput {
  /** 她已经授权、并且在设置里打开了的那几家。顺序无所谓,内部会排。 */
  services: readonly string[]
  catalog: ConnectorCatalogReader
  /**
   * 临时放行的写 / 发布动作 id(工作台审批批过的那几条)。
   * 只在这一趟有效 —— 批完撤回,靠的是重算这份策略再热重启一次(实测 0.8 秒)。
   */
  approvedWrites?: readonly string[]
}

export interface ConnectorPolicy {
  /** 交给 `createConnectorRuntime({ actionPolicy })` 的那一格。 */
  allowedActions: string[]
  /** 每一家放了几条、跳过了几条,给界面与交接文档说人话用。 */
  perService: { service: string, read: number, withheld: number, missing: boolean }[]
}

/** 只读判定只认 catalog 自己标的 `operationType === 'read'`,**没标的一律当写**(往严的那边错)。 */
function isReadOnly(operationType: string | undefined): boolean {
  return operationType === 'read'
}

export function buildConnectorPolicy(input: ConnectorPolicyInput): ConnectorPolicy {
  const approved = new Set(input.approvedWrites ?? [])
  const allowed = new Set<string>()
  const perService: ConnectorPolicy['perService'] = []
  const services = [...new Set(input.services)].sort()

  for (const service of services) {
    const app = input.catalog(service)
    if (!app) {
      perService.push({ service, read: 0, withheld: 0, missing: true })
      continue
    }
    let read = 0
    let withheld = 0
    for (const action of app.actions ?? []) {
      if (!action?.id) continue
      if (isReadOnly(action.operationType)) {
        allowed.add(action.id)
        read += 1
      } else {
        withheld += 1
      }
    }
    perService.push({ service, read, withheld, missing: false })
  }

  // 审批批过的那几条:必须是**已启用那几家**里的动作,否则一律不理
  //(免得一条批文把一家没授权的平台也带进来)。
  const enabled = new Set(services)
  for (const id of [...approved].sort()) {
    const service = id.split('.')[0] ?? ''
    if (!enabled.has(service)) continue
    allowed.add(id)
  }

  const allowedActions = [...allowed].sort()
  if (allowedActions.length === 0) {
    // 空单子会被它当成「没有白名单」= 全放行。塞哨兵把它变成「什么都不许」。
    allowedActions.push(CONNECTOR_POLICY_SENTINEL)
  }
  return { allowedActions, perService }
}

/** 一句人话,摆在设置页那一行。取不到就整句不显示,**不写 0**。 */
export function describeConnectorPolicy(policy: ConnectorPolicy): string | undefined {
  const live = policy.perService.filter((s) => !s.missing)
  if (live.length === 0) return undefined
  const read = live.reduce((n, s) => n + s.read, 0)
  const withheld = live.reduce((n, s) => n + s.withheld, 0)
  return `接了 ${live.length} 家 · 放行只读 ${read} 项 · 写和发布 ${withheld} 项要先问你`
}

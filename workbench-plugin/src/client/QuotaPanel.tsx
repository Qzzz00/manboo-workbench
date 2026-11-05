/**
 * 余额 / 额度面板 —— 独立模块(Ben 反馈:不该和消耗数据挤同一块区域)。
 *
 * 渲染逻辑从 display-client/src/display/DisplayPanels.tsx 的 QuotaPanel 复制过来,
 * **展示台代码一个字节没动**;取数在 client/quotaCells.ts(同样是复制)。
 * 数据源本来就是同一套服务——工作台 /state 的 quota 字段,展示台也是从这里读的。
 */
import { useMemo } from 'react'
import type { AgentId, AgentQuotaView, ClientsView, DeepSeekPeakView, QuotaEntry, QuotaStaleFix } from '../protocol.ts'
// 老四格之外的那几家(2026-09-25,卡 O):Muse、Manus、豆包……每家三格之一(有数 / 不限 / 没接上:原因)。
import { AgentQuotaCells, extraQuotas } from './AgentQuotaCells.tsx'
import type { QuotaCell } from './quotaCells.ts'
import { formatResetAt, quotaCells, windowShort } from './quotaCells.ts'
// 每个区域单独解锁(2026-09-17):哪几格该画、画成数字还是解锁卡,全在 areaUnlock.ts 里算好。
import { deepseekProgress, quotaAreas, unlockProgress } from './areaUnlock.ts'
import { UnlockCard, UnlockHint, type UnlockHandler } from './AreaUnlock.tsx'
// 第一次用(2026-09-18):一家凭据都没接上、也没走中转时,这一格只留一句话。
import { EmptyState } from './EmptyState.tsx'
import type { EmptyModule, EmptyView } from './emptyState.ts'

/** 底部那一行:没接上的几家合并计数,展开才见详情。 */
export const QUOTA_LOCKED_LINE = (count: number): string => `暂不可用 ${count} 家`
/** 那一行右端的入口字(评审页 0cf75042 余额 / 额度:`暂不可用 2 家 · 查看详情 ›`)。 */
export const QUOTA_MORE_DETAIL = '查看详情 ›'
/** 余额之下、各家之上那句口径(评审页 0cf75042;刻度一格 5%,末格按实际比例填)。 */
export const QUOTA_SCALE_LINE = '剩余额度 · 一格 5% · 末格按实际比例填充'

/** 格脚那句里怎么写(「Kimi 5 小时额度已用完」)。 */
const WINDOW_LONG: Readonly<Record<string, string>> = { '5h': '5 小时', '周': '本周' }

/** 有一扇窗用完了(剩 0%):格脚写哪一家哪一扇、几点回来。都没用完 → undefined。 */
function exhaustedLine(cells: readonly QuotaCell[], now: Date): { what: string, when?: string } | undefined {
  for (const cell of cells) {
    if (!cell.showBar || cell.stale === true) continue
    const bar = cell.bars.find(one => one.pct <= 0)
    if (bar === undefined) continue
    const when = bar.resetAt === undefined ? undefined : formatResetAt(bar.resetAt, now)?.replace(/^今天 /, '')
    return { what: `${cell.name} ${WINDOW_LONG[bar.label] ?? bar.label}额度已用完`, ...(when === undefined ? {} : { when: `${when} 重置` }) }
  }
  return undefined
}

export interface QuotaPanelProps {
  quota: Partial<Record<AgentId, QuotaEntry>>
  /** 算「今天/明天」的基准。跟随轮询推进,否则跨午夜后会一直挂着昨天那句「明天 11:33」。 */
  now: string
  /**
   * DeepSeek 峰谷(2026-09-09):服务端每次组装 /state 现算的 deepseek_peak。
   * 缺席就没有那一行——**客户端不自己算**,判断在工作台做完(架构约束 C2)。
   */
  peak?: DeepSeekPeakView
  /**
   * 各家客户端扫到没有、接上没有(2026-09-17「每个区域单独解锁」)。
   *
   * **缺席 = 服务端还没扫过**,四格照这一版之前那样全画 —— 既有那一批只传 quota/now 的
   * 用例与展示台一行不受影响。
   */
  clients?: ClientsView
  /** 模型从哪儿来。`relay` 时 DeepSeek 那格换成「工作台提供的服务 · 今日用量」。 */
  modelMode?: 'relay' | 'own'
  /** `/state.relay_configured`(2026-10-21)。`false` 时 DeepSeek 那张卡不给「用我们的服务」。 */
  relayConfigured?: boolean
  /** 解锁卡上那颗按钮。不给就不画按钮(卡片本身照出,那句 how 已经能照做)。 */
  onUnlock?: UnlockHandler
  /**
   * 第一次用且一家都没有真数字(2026-09-18)。**给了就整块不画格子**:
   * 首次那一刻四格里全是「未接入」,四个"未接入"并排比一句"还没接上"吓人得多。
   * 判定在 emptyState.ts(那里绝不把「未接入」当成 0)。
   */
  empty?: EmptyView
  /** 空态那颗「连接账号」按下去(去设置里各家的密钥与登录)。不给就不画按钮。 */
  onEmptyAction?: (module: EmptyModule) => void
  /**
   * 能接活的每一家的额度(2026-09-25,卡 O,`/state.agent_quota`)。老四格之外的几家各画一格。
   * 缺席 = 老宿主(展示台、老服务),只画老四格(同这一版之前)。
   */
  agentQuota?: readonly AgentQuotaView[]
  /**
   * **这台电脑上真有的那几家**(2026-09-27,卡 HC):`/state.agents` 里的 id,服务端已按探测筛过。
   * 没装的一家在这一排里不出现(不显示、不催、不占位)。**缺席 = 老宿主 / 没探过** →
   * 退回这一版之前的老四格(D13:查不到不许冒充没有)。
   */
  agents?: readonly AgentId[]
  /** 那几格上剩下的那颗键(「去授权」)发请求用。不给就只画、不画按钮。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export function QuotaPanel({ quota, now, peak, clients, modelMode, relayConfigured, onUnlock, empty, onEmptyAction, agentQuota, agents, baseUrl, fetchImpl }: QuotaPanelProps) {
  const areas = useMemo(() => {
    const at = new Date(now)
    // agentQuota 也进来(2026-09-26,卡 QS):老四格这一轮取不到数时,照服务端那一格说
    // 「上次读到的是 62% · 昨晚 20:42 读到的」,而不是「未接入」。
    const cells = quotaCells(quota, {}, Number.isNaN(at.getTime()) ? new Date() : at, peak, agentQuota, agents)
    return quotaAreas(cells, clients, quota, modelMode, relayConfigured)
  }, [quota, now, peak, clients, modelMode, relayConfigured, agentQuota, agents])
  // 「已接上 N 家」只数有额度的那几家(2026-09-25):DeepSeek 的状态从 quota / model_mode 现算。
  const progress = useMemo(
    () => unlockProgress(clients, deepseekProgress(quota.dsh, modelMode)),
    [clients, quota, modelMode],
  )

  /**
   * 「读不到最新」那一格上那颗入口键(2026-10-02,卡 QK)。
   *
   * 去处由**服务端那一份声明**给(`fix.at` = 设置里哪一节、哪一行),这里一个家名都不判 ——
   * 照 areaUnlock.ts 头上那条老规矩:去处是一张表的事,不是各处 if。
   * `onUnlock` 没给就不画键(同解锁卡的先例;那两句话照说)。
   */
  const onFix = onUnlock === undefined
    ? undefined
    : (at: QuotaStaleFix['at']) => { onUnlock('settings', undefined, at) }

  // 老四格已经画过的不再画:比的是**这一轮真画出来的那几格**(卡 HC),不是写死的四家 ——
  // 不然只装了豆包办公与 Codex 的机器上,Claude / Kimi 会从上面消失又从这里冒出来。
  const extra = extraQuotas(agentQuota, agents)
  /**
   * 读不到最新的(数老了)、没接上的那几家(2026-10-22 维护者:「读不到最新的,上次 …」那几行按评审页收成最底一行计数,
   * 展开才看明细)。有数的、不限的照常在上面。
   */
  const away = (view: AgentQuotaView): boolean => view.stale === true || view.state === 'unconnected'
  const cellsOf = (quotas: readonly AgentQuotaView[]) => (quotas.length === 0 ? null : (
    <AgentQuotaCells
      quotas={quotas}
      {...(baseUrl === undefined ? {} : { baseUrl })}
      {...(fetchImpl === undefined ? {} : { fetchImpl })}
      {...(onFix === undefined ? {} : { onFix })}
    />
  ))
  const extraCells = cellsOf(extra)
  const extraHere = cellsOf(extra.filter(view => !away(view)))
  const extraAway = extra.filter(away)

  const locked = areas.flatMap(area => (area.kind === 'quota' ? [] : [area]))
  const shown = areas.flatMap(area => (area.kind === 'quota' ? [area] : []))
  const balances = shown.filter(area => !area.cell.showBar && area.cell.value.startsWith('¥'))
  const rows = shown.filter(area => !balances.includes(area))
  const used = exhaustedLine(rows.map(area => area.cell), Number.isNaN(new Date(now).getTime()) ? new Date() : new Date(now))

  if (empty !== undefined) {
    // 老四格一家都没接上时只留一句话;其余几家(豆包「不限」、Muse / Manus 各自的原因)照画 —— 每家都要有一行。
    return (
      <div className="ben-wb__scroll">
        <EmptyState view={empty} {...(onEmptyAction === undefined ? {} : { onAction: onEmptyAction })} />
        {extraCells !== null && <div className="ben-wb__usage-quotagrid" role="list" aria-label="其余几家的额度">{extraCells}</div>}
      </div>
    )
  }

  return (
    <div className="ben-wb__scroll">
      <UnlockHint
        progress={progress}
        // 「全部接上」(2026-09-25):Claude、Codex 一次看、一次点。去处照旧交给 onUnlock 那张表。
        {...(onUnlock === undefined ? {} : { onApplyAll: () => onUnlock('apply-all') })}
      />
      {/* 余额那一行在上,下面一句口径,再是各家(评审页 0cf75042 余额 / 额度)。 */}
      {balances.length > 0 && (
        <div className="ben-wb__usage-quotagrid" role="list" aria-label="余额">
          {balances.map(area => <QuotaBlock key={area.agent} cell={area.cell} {...(onFix === undefined ? {} : { onFix })} />)}
        </div>
      )}
      {(rows.some(area => area.cell.showBar) || extraHere !== null) && <p className="ben-wb__usage-qscale">{QUOTA_SCALE_LINE}</p>}
      <div className="ben-wb__usage-quotagrid" role="list" aria-label="客户端余额与额度">
        {rows.map(area => <QuotaBlock key={area.agent} cell={area.cell} {...(onFix === undefined ? {} : { onFix })} />)}
        {extraHere}
      </div>
      {used !== undefined && (
        <p className="ben-wb__usage-qfoot"><span>{used.what}</span>{used.when !== undefined && <span>{used.when}</span>}</p>
      )}
      {/* 没接上的、读不到最新的几家折到最底一行计数(评审页余额 / 额度):展开才见各自的原因与入口,0% 等真数照常在上面。 */}
      {locked.length + extraAway.length > 0 && (
        <details className="ben-wb__usage-qmore">
          <summary><span>{QUOTA_LOCKED_LINE(locked.length + extraAway.length)}</span><span>{QUOTA_MORE_DETAIL}</span></summary>
          <div className="ben-wb__usage-quotagrid" role="list" aria-label="还没接上的几家">
            {locked.map(area => (
              <UnlockCard
                key={area.agent}
                name={area.name}
                how={area.how}
                actions={area.actions}
                {...(onUnlock === undefined ? {} : { onUnlock })}
              />
            ))}
            {cellsOf(extraAway)}
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * 单家余量。沿用展示台的两条纪律:
 * - 余额型只给数字不画条(余额无分母,画条要假设"满"值,会误导)
 * - 未接入显式标出,绝不用 0 冒充
 */
function QuotaBlock({ cell, onFix }: { cell: QuotaCell, onFix?: (at: QuotaStaleFix['at']) => void }) {
  const fix = cell.fix
  return (
    <div
      className="ben-wb__usage-q"
      data-level={cell.level}
      role="listitem"
      aria-label={cell.name}
      data-kind={cell.showBar ? 'quota' : 'balance'}
      // 上次读到的、已经老了的那个数(卡 QS):这一格画淡;说明里写着几点读到的、以及「…没在跑,数字可能旧」。
      data-stale={cell.stale === true ? 'true' : undefined}
    >
      <div className="ben-wb__usage-qhead">
        <span className="ben-wb__usage-qname">{cell.name}{!cell.showBar && cell.value.startsWith('¥') && <> <span className="ben-wb__usage-qsrc">· 余额</span></>}</span>
        {!cell.showBar && <span className="ben-wb__usage-qval" data-level={cell.level}>{cell.value}</span>}
      </div>

      {cell.showBar && (
        <div className="ben-wb__usage-qbars">
          {cell.bars.map(bar => (
            <div className="ben-wb__usage-qbar" key={bar.label}>
              <span className="ben-wb__usage-qlabel">{windowShort(bar.label)}</span>
              {/* 条长 = 剩余。越短越危险,方向与余额一致。 */}
              <span className="ben-wb__usage-qtrack">
                <i data-level={bar.level} style={{ width: `${Math.max(0, Math.min(100, bar.pct))}%` }} />
              </span>
              <span className="ben-wb__usage-qpct">{bar.pct}%</span>
            </div>
          ))}
        </div>
      )}

      {/*
        上次读到的那个数(2026-09-26,卡 QS):几点读到的、以及「…没在跑,数字可能旧」**摊在明面上** ——
        他要一眼看见这个数的年纪,而不是先点开一层「说明」。别的情形照旧折着。
      */}
      {/*
        2026-10-02(卡 QK):**旧了的那一格也摊开**。卡 QA 之后老四格过线时写的是
        大字「读不到最新的」+ 小字「上次 04:27」,而小字当时还折在「▸ 说明」里 ——
        她要点开一层才看得见这个数多大年纪、为什么读不到。`stale` 与 `kept` 同一档。
      */}
      {cell.kept === true || cell.stale === true
        ? (
          <>
            <p className="ben-wb__usage-qnote" data-kept="true">{cell.note}</p>
            {cell.peak !== undefined && <p className="ben-wb__usage-qnote">{cell.peak}</p>}
          </>
        )
        : (
          <details className="ben-wb__usage-qdetails">
            <summary title={cell.peak ?? cell.note}
              data-phase={cell.peak?.startsWith('高峰') ? 'peak' : 'offpeak'}>
              {cell.peak ?? '说明'}
            </summary>
            <p className="ben-wb__usage-qnote">{cell.note}</p>
          </details>
        )}

      {/*
        「读不到最新」时那颗入口键(卡 QK):点一下去设置里那一行。去处由服务端那一份声明给,
        这里不判是哪一家。`onFix` 没给就不画(那两句话照说)。
      */}
      {fix !== undefined && onFix !== undefined && (
        <button type="button" className="ben-wb__usage-qfix" onClick={() => onFix(fix.at)}>
          {fix.label}
        </button>
      )}
    </div>
  )
}

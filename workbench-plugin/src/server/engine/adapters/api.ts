/**
 * 接口那一条通道(2026-10-03,卡「派活三只手收进引擎」;设计 `docs/设计-派活三只手收进引擎-2026-10-03.md`)。
 *
 * 从前它是 `dispatchRun` 手循环里直接调 `apiSend` 的「第三只手」(GPT / 豆包的备用):不过引擎的闸、账上没有它的行,
 * 换路由外层管。现在它是登记表里的一条通道,`via:'api'` —— 它经工作台自己的中转打到云上的模型,
 * 既不是那家 App 的协议、也不是窗口(`JobVia` 的注释)。
 *
 * 只送她的原话(`Job.brief`)+ `dispatchApi.ts` 自己那份系统提示;**不送**给窗口拼的那一整段
 * (「【工作台派活 xxx】+ 规矩」)—— 今天就是这样,这张卡不改接口上游收到的字。
 * 回答原样放进 `JobResult.reply`;自查、交付物、挪状态是 `dispatchRun` 的事。
 *
 * 「中转没配这一家」如实报不能送(`capabilities.send:false` + {@link API_NOT_CONFIGURED_WHY}),不装作有
 * (2026-09-27 卡 MS:没配的东西不该去试,更不该把「缺 RELAY_DOUBAO_KEY」写进给她看的失败原因)。
 */
import type { ApiDispatchFamily, ApiDispatchInput, ApiDispatchResult } from '../../dispatchApi.ts'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../adapter.ts'

export interface ApiAdapterDeps {
  /** 真发那一下(`dispatchApi.createApiDispatch().send`)。 */
  send: (input: ApiDispatchInput) => Promise<ApiDispatchResult>
  /**
   * 中转配了这一家没有。`false` = 确凿没配(这条通道不存在);`true` / `undefined`(没问到过)= 照旧算有 —— 不猜(D13),
   * 宁可试一次也不因为一次 /health 没通就把一条能用的路拆掉。
   */
  configured?: (family: ApiDispatchFamily) => boolean | undefined
  /** 这一家叫什么(人话;缺席 = 家名)。 */
  name?: (family: string) => string
}

/* 这几句不带「接口:」那一截:引擎接几条通道的原因时自己按通道加(`VIA_TEXT`)。 */
export const API_NOT_CONFIGURED_WHY = '中转没配这一家'
export const API_ONLY_DISPATCH_WHY = '接口那条路只接派活(往云上模型发一段话、拿一段回答)'
export function apiFailedWhy(reason: string | undefined): string {
  return reason ?? '没回来'
}

const NOTHING: AdapterCapabilities = { open: false, send: false, read: false, press: false, approve: false, writeAsk: false, stop: false, openSession: false }

export function createApiAdapter(family: ApiDispatchFamily, deps: ApiAdapterDeps): Adapter {
  const configured = (): boolean => deps.configured?.(family) !== false
  return {
    family,
    via: 'api',
    capabilities: async (): Promise<AdapterCapabilities> => ({ ...NOTHING, send: configured() }),
    unavailable: () => (configured() ? undefined : API_NOT_CONFIGURED_WHY),
    run: async (job: Job): Promise<JobResult> => {
      if (job.kind !== 'dispatch') return { delivered: 'not_sent', via: 'api', evidence: 'none', unsupported: true, why: API_ONLY_DISPATCH_WHY }
      if (!configured()) return { delivered: 'not_sent', via: 'api', evidence: 'none', why: API_NOT_CONFIGURED_WHY }
      const context = job.project === undefined && job.cwd === undefined
        ? undefined
        : { ...(job.project === undefined ? {} : { project: job.project }), ...(job.cwd === undefined ? {} : { cwd: job.cwd }) }
      const sent = await deps.send({ family, text: job.brief ?? job.text, ...(context === undefined ? {} : { context }) })
      if (sent.ok && sent.reply !== undefined && sent.reply.trim() !== '') {
        return { delivered: 'confirmed', via: 'api', evidence: 'receipt', reply: sent.reply.trim() }
      }
      return { delivered: 'not_sent', via: 'api', evidence: 'none', why: apiFailedWhy(sent.reason) }
    },
  }
}

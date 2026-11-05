/**
 * 球下面那张「额度一键接上」的卡(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * 设计(docs/设计-引导落地-引导结束后的样子-2026-09-24.md 第二节第 2、5 条):球下面只放一两张**要他处理**的卡,
 * 例如「3 家额度一键接上」。维护者 09-24:「授权要自己点就算了」—— 可以要他点,但**只点一次**。
 *
 * 这张卡只说有额度的那几家(`/state.quota_connect`,服务端算好的,微信/企业微信永远不在里面):
 *
 * - Claude、Codex 装了没接 → 「全部接上」:**就地展开**(先看两家各写什么 → 一次写入 → 每家各一颗撤回),
 *   跟额度面板那个框是同一段代码(ConnectAllFlow),只是首页上不弹窗;
 * - Kimi 没登 → 「登录 Kimi」:开一个登录窗口,**他自己登一次**(账号密码工作台不经手),以后不用再登;
 * - 「先不」:这一句先收起来(记在这台机器的浏览器里),情况变了(接上了一家、又装了一家)会自己回来。
 *
 * **什么时候不出现**:引导还没做完(那会儿这块地方归引导)、`quota_connect` 缺席(还没扫过)、
 * 没有要他处理的(全接上了 / 有额度的一家都没装)。
 *
 * 样子跟 DevToolAsk / LayoutAsk / EvolveAsk 同一种卡(虚线框),卡 A 调首页排布时挪 ButlerInbox 里那一行即可。
 */
import { useCallback, useEffect, useState } from 'react'
import type { WorkbenchState } from '../protocol.ts'
import { ConnectAllFlow } from './ConnectAllDialog.tsx'
import { fetchLoginProgress, startLogin, type LoginProgressView } from './credentials.ts'
import { isFirstTime } from './emptyState.ts'

const DISMISS_KEY = 'ben-wb__quotaAskDismissed'

function readDismissed(): string | undefined {
  // 壳里、无痕窗口里 localStorage 可能直接抛:当"没关过"(同 UnlockHint)。
  try { return window.localStorage.getItem(DISMISS_KEY) ?? undefined }
  catch { return undefined }
}

/** 卡上那一句:只说要他处理的(已经接上的不在这里报喜 —— 额度面板那一行会说)。 */
export function quotaAskLine(view: NonNullable<WorkbenchState['quota_connect']>): string | undefined {
  const names = (state: string): string[] => view.providers.filter(row => row.state === state).map(row => row.label)
  const parts: string[] = []
  const oneClick = names('one_click')
  if (oneClick.length > 0) parts.push(`${oneClick.join('、')} 点一次「全部接上」就都接上(先看要写什么,写完每家都能单独撤回)`)
  if (names('login').length > 0) parts.push(`${names('login').join('、')} 要你自己登一次(账号密码工作台不经手),登一次以后就不用再登`)
  return parts.length === 0 ? undefined : `${parts.join(';')}。`
}

/**
 * 这张卡此刻出不出来(与下面组件里的判断同一套:引导做完了、有要他处理的那一句、他没点过「先不」)。
 * 给 ButlerInbox 用(2026-09-25,卡 fix/materialize-card-fit):球下那一区摆不下时,要他处理的卡收成一行,得先知道这张在不在。
 */
export function quotaAskShown(state: WorkbenchState): boolean {
  const view = state.quota_connect
  if (view === undefined || isFirstTime(state)) return false
  const line = quotaAskLine(view)
  return line !== undefined && line !== readDismissed()
}

export function QuotaConnectAsk({ state, baseUrl, fetchImpl }: {
  state: WorkbenchState
  baseUrl: string
  fetchImpl?: typeof fetch
}) {
  const doFetch = fetchImpl ?? fetch
  const [dismissed, setDismissed] = useState<string | undefined>(() => readDismissed())
  const [flowOpen, setFlowOpen] = useState(false)
  /** 写完点了「知道了」之后,旧的那一句先别再冒出来 —— 探测要过一拍才跟上(见 http.ts 那次 invalidate)。 */
  const [settledLine, setSettledLine] = useState<string | undefined>(undefined)
  const [kimi, setKimi] = useState<LoginProgressView | undefined>(undefined)
  const [kimiError, setKimiError] = useState<string | undefined>(undefined)

  const view = state.quota_connect
  const line = view === undefined ? undefined : quotaAskLine(view)
  const kimiPending = view?.providers.some(row => row.agent === 'kimi' && row.state === 'login') === true

  // 登录窗口开着的时候每两秒问一次进展;登好了 / 失败了就停(同设置里那一栏的做法)。
  useEffect(() => {
    if (kimi?.state !== 'opening' && kimi?.state !== 'waiting') return
    const timer = setInterval(() => {
      void fetchLoginProgress(baseUrl, doFetch).then(setKimi)
    }, 2000)
    return () => clearInterval(timer)
  }, [kimi?.state, baseUrl, doFetch])

  const loginKimi = useCallback(() => {
    setKimiError(undefined)
    setKimi({ state: 'opening', message: '正在打开登录窗口' })
    void startLogin(baseUrl, 'kimi_web', doFetch).catch((error: unknown) => {
      setKimi(undefined)
      setKimiError(error instanceof Error ? error.message : String(error))
    })
  }, [baseUrl, doFetch])

  const dismiss = useCallback(() => {
    if (line === undefined) return
    setDismissed(line)
    try { window.localStorage.setItem(DISMISS_KEY, line) }
    catch { /* 存不下就只关这一次 */ }
  }, [line])

  if (view === undefined || isFirstTime(state)) return null
  // 就地展开着的时候不因为 /state 变了就把它收掉(写完那一屏要让他看完、要能撤回)。
  if (!flowOpen) {
    if (line === undefined) return null
    if (line === dismissed || line === settledLine) return null
  }

  return (
    <section className="ben-wb__quotaask" aria-label="额度还差一步">
      <p className="ben-wb__quotaask-head">额度还差一步</p>
      {!flowOpen && line !== undefined && <p className="ben-wb__quotaask-say">{line}</p>}
      {flowOpen && (
        <div className="ben-wb__quotaask-flow">
          <ConnectAllFlow
            baseUrl={baseUrl}
            fetchImpl={doFetch}
            onClose={() => {
              setFlowOpen(false)
              // 这一句先收着:接上的那几家要等探测下一拍才变,中间别让它再亮一下。
              setSettledLine(line)
            }}
          />
        </div>
      )}
      {!flowOpen && (
        <div className="ben-wb__quotaask-row">
          {view.one_click && (
            <button type="button" className="ben-wb__hookapply-btn" data-kind="primary" onClick={() => setFlowOpen(true)}>全部接上</button>
          )}
          {kimiPending && (
            <button
              type="button"
              className="ben-wb__hookapply-btn"
              disabled={kimi?.state === 'opening' || kimi?.state === 'waiting'}
              onClick={loginKimi}
            >
              登录 Kimi
            </button>
          )}
          <button type="button" className="ben-wb__hookapply-btn" onClick={dismiss}>先不</button>
        </div>
      )}
      {kimi !== undefined && kimi.state !== 'idle' && (
        <p className="ben-wb__quotaask-note" role="status">
          {kimi.state === 'done'
            ? 'Kimi 登好了,额度马上就有。'
            : kimi.state === 'failed'
              ? `Kimi 没登成:${kimi.message ?? '原因没拿到'}`
              : `登录窗口开了 —— 在那个窗口里登一次就好。${kimi.message === undefined ? '' : `(${kimi.message})`}`}
        </p>
      )}
      {kimiError !== undefined && <p className="ben-wb__quotaask-err" role="alert">{kimiError}</p>}
    </section>
  )
}

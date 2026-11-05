/**
 * 顶上那几条细横幅(2026-09-17,决策记录「三个环节分开」)。
 *
 * 09-17 拍板之后,"还差什么"不再做成向导里的一步:安装是安装包的事、登录是登录、引导是引导,
 * 而**缺授权、缺密钥都不拦路** —— 只在工作台顶上说一句,给一条去的路:
 *   ① 「还差一个授权:辅助功能」→ 调现有的 `POST /setup/open { pane: 'accessibility' }`
 *      直接打开系统设置那一页;回来(窗口重新拿到焦点)自动复查,好了这条就消失。
 *   ② 「还没填 DeepSeek 密钥」→ 打开设置弹窗那一格。**它不是登录的一部分**
 *      (09-17 早些时候"登录 = 填 API Key"那条已经作废)。2026-09-23 起**只在他自己选了
 *      「用自己的 Key」时**才出(服务端体检按 model.json 的 mode 判):默认走工作台中转的新用户
 *      一辈子看不到它,额度那一格也走中转用量。
 *   ③ 「模型服务还没接上」(2026-09-18)→ 一颗「重试」,当场再领一次令牌。
 *      这一条**只在替他自动领过、而且没领到**的时候出 —— 正常新用户一辈子看不到它。
 *   ④ 「手机看不到电脑上的文件:还差完全磁盘访问」(2026-10-13)→ 一颗「去给」,
 *      打开 `Privacy_AllFiles` 那一页。这一条出在横幅而不是只留在体检里,是因为
 *      体检那一格是**可选项**(主路不靠它),而它坏掉的那件事维护者说「功能就废了」。
 *

 * 数据来自 `/state.setup_alerts`,而那一格是两个来源**逐格**合起来的(server/http.ts):
 * 前两格读上一次体检的结论、第三格读上一次自动接模型服务的结论。
 * **每一格都可能缺席,而缺席不是 false** —— 「没查过」和「查过了、没问题」是两件事,
 * 所以这里一律写 `=== true`,不写 `!alerts.x`。
 */
import { useState } from 'react'
import { useAccessAuthorize } from './accessAuthorize.ts'
import { accessNotice, fileAccessNotice, type AccessAlertKind } from './accessNotice.ts'
import { retryModelAutoSetup } from './model.ts'

/** 只在「用自己的 Key」模式下才会出现的那一句 —— 所以话里先说「你选了」,再给一条不填的退路。 */
export const DEEPSEEK_KEY_LINE = '你选了用自己的 DeepSeek Key,但还没填(事务官接话要它;不想填就在设置里切回工作台提供的服务)'

export interface NeedBarProps {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** /state.setup_alerts。整格缺席(还没体检过、也没试过接模型服务)就什么都不画。 */
  alerts?: {
    accessibility?: boolean
    deepseek_key?: boolean
    model_service?: boolean
    accessibility_kind?: AccessAlertKind
    /** 2026-10-13:完全磁盘访问还缺着 —— 手机看不到电脑上的文件。缺席 = 没查过 / 判断不了。 */
    file_access?: boolean
  }
  /** 「去设置」:打开齿轮弹窗(密钥那一格就在里面)。 */
  onOpenSettings: () => void
}

export function NeedBar({ baseUrl, fetchImpl, alerts, onOpenSettings }: NeedBarProps) {
  const { authorize, error } = useAccessAuthorize(baseUrl, fetchImpl)
  /**
   * 说哪一句由 accessNotice 定(2026-09-18),这里不再写死「还差一个授权」——
   * 系统设置里开关开着、壳仍报未授权的那一幕要说的是另一段话,而且**跟窗位槽/
   * 系统文件夹里那行红字共用同一句**(见 accessNotice.ts 的文件头)。
   */
  const notice = accessNotice(alerts)
  /**
   * 「完全磁盘访问」那一条(2026-10-13)。与上面那一条**同一套机制、不同一页**:
   * 复用 useAccessAuthorize(含"点过才挂 focus 复查"那条纪律),只把 pane 换成 all_files。
   */
  const fileAccess = fileAccessNotice(alerts)
  const { authorize: authorizeFiles, error: filesError } = useAccessAuthorize(baseUrl, fetchImpl, 'all_files')
  /**
   * 「重试」这一颗的本地态。**只有三种**:闲着、在重试、重试完说一句。
   * 成不成由下一拍的 `/state.setup_alerts` 说了算(那一格是服务端的结论),
   * 这里不自己记一份"接上了没有" —— 两份迟早会漂,而漂掉的后果是横幅消失了但其实没接上。
   */
  const [retrying, setRetrying] = useState(false)
  const [retryNote, setRetryNote] = useState<string | null>(null)

  const retry = async (): Promise<void> => {
    setRetrying(true)
    setRetryNote(null)
    try {
      const result = await retryModelAutoSetup(baseUrl, fetchImpl ?? fetch)
      /**
       * 服务端那句人话原样显示,界面不另写一套。取**第一句**:hints 是
       * `[领令牌那一句, ...事务官那几句]`,而这条横幅问的就是"领到了没有"。
       */
      setRetryNote(result.hints[0] ?? null)
    }
    catch (failure) {
      setRetryNote(failure instanceof Error ? failure.message : '这次没能接上,过一会儿再试。')
    }
    finally {
      setRetrying(false)
    }
  }

  if (alerts === undefined) return null
  if (alerts.accessibility !== true && alerts.deepseek_key !== true && alerts.model_service !== true && alerts.file_access !== true) return null

  return (
    <div className="ben-wb__needbar" role="status">
      {notice !== undefined && (
        <div className="ben-wb__needbar-row" data-kind="accessibility" data-accessibility-kind={notice.kind}>
          <span>{notice.line}</span>
          <button type="button" className="ben-wb__needbar-go" onClick={authorize}>{notice.action}</button>
        </div>
      )}
      {fileAccess !== undefined && (
        <div className="ben-wb__needbar-row" data-kind="file_access">
          <span>{fileAccess.line}</span>
          <button type="button" className="ben-wb__needbar-go" onClick={authorizeFiles}>{fileAccess.action}</button>
        </div>
      )}
      {alerts.deepseek_key === true && (
        <div className="ben-wb__needbar-row" data-kind="deepseek">
          <span>{DEEPSEEK_KEY_LINE}</span>
          <button type="button" className="ben-wb__needbar-go" onClick={onOpenSettings}>去设置</button>
        </div>
      )}
      {alerts.model_service === true && (
        <div className="ben-wb__needbar-row" data-kind="model">
          <span>{retryNote ?? '模型服务还没接上(事务官暂时接不了话)'}</span>
          <button type="button" className="ben-wb__needbar-go" onClick={() => { void retry() }} disabled={retrying}>
            {retrying ? '正在接…' : '重试'}
          </button>
        </div>
      )}
      {error !== null && <div className="ben-wb__needbar-row" data-kind="error"><span>{error}</span></div>}
      {filesError !== null && <div className="ben-wb__needbar-row" data-kind="error"><span>{filesError}</span></div>}
    </div>
  )
}

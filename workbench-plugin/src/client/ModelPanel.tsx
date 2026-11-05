/**
 * 设置里的「模型服务」一节(2026-09-17,决策记录同日 Ben:「配置 API 是后面的步骤,要做成可选的
 * ……面向半专业用户:个体户、做副业的、电商或运营人员,不懂代码,要简单易用」)。
 *
 * ## 这一节要让人一眼看懂的三件事
 *
 * 1. **默认就能用,不用填任何东西。** 所以第一项是选中的、写着「不用填任何东西」,
 *    下面直接显示今天用了多少 —— 一个不懂代码的人在这里唯一会问的问题就是「我还能用多少」。
 * 2. **想用自己的账号也行。** 第二项写清楚去哪申请、申请完贴到哪一格,不出现「API」「endpoint」
 *    「base URL」这类词。
 * 3. **出问题时说人话。** 领不到凭证、额度看不到,都在这里用一句话说明白,并给一颗
 *    「重新领取」的按钮,而不是让人去看日志。
 *
 * ## 样子(2026-10-22 照评审页)
 *
 * 两行:「用工作台提供的服务」一颗开关、「使用自己的账号」一颗「选择」;今日用量是一格 5% 的刻度(同额度那一格)。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ModelMode, ModelStatusView } from './model.ts'
import { SetActions, SetBtn, SetErr, SetLead, SetMsg, SetRow, SetSection, SetSource } from './settings/setKit.tsx'
import { Rungs } from './ui/index.tsx'
import { submitCredential } from './credentials.ts'
import {
  EMPTY_MODEL_STATUS, fetchModelStatus, reissueModelToken, switchModelMode, tryModel, updateOwnModel,
  usageExhausted, usageLines, usagePercent,
} from './model.ts'

export interface ModelPanelProps {
  baseUrl: string
  fetchImpl?: typeof fetch
}

const OPTIONS: readonly { mode: ModelMode, name: string, hint: string }[] = [
  {
    mode: 'relay',
    name: '用工作台提供的服务',
    hint: '推荐。不用填任何东西,打开就能用。',
  },
  {
    mode: 'own',
    name: '使用自己的账号',
    // 去哪申请那条链接在「各家的登录与密钥」DeepSeek 那一行(没填时露出来),这里只说填在哪。
    hint: '密钥统一在「各家的登录与密钥」维护。',
  },
]

/** 这台没接中转(零服务器档)时模型那一节顶上那一句。 */
export const MODEL_NO_RELAY_LINE = '这台没接中转:模型用你自己的 DeepSeek 密钥,在下面「各家的登录与密钥」里 DeepSeek 那一格填。'

export function ModelPanel({ baseUrl, fetchImpl }: ModelPanelProps) {
  const [status, setStatus] = useState<ModelStatusView>(EMPTY_MODEL_STATUS)
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<string[]>([])
  // own 档那两格(地址 / 模型名)的草稿;到达之后从状态里预填。
  const [ownBase, setOwnBase] = useState('')
  const [ownModel, setOwnModel] = useState('')
  const [ownKeyDraft, setOwnKeyDraft] = useState('')
  const [tryMessage, setTryMessage] = useState<string | undefined>(undefined)
  const [trying, setTrying] = useState(false)

  const refresh = useCallback(async () => {
    setStatus(await fetchModelStatus(baseUrl, fetchImpl))
  }, [baseUrl, fetchImpl])

  useEffect(() => { void refresh() }, [refresh])
  // 状态到了(或他切过去又切回来)就把两格预填成此刻真正在用的值。
  useEffect(() => {
    setOwnBase(status.own_base_url)
    setOwnModel(status.own_model)
  }, [status.own_base_url, status.own_model])

  async function run(action: () => Promise<{ status: ModelStatusView, hints: string[] }>): Promise<void> {
    setBusy(true)
    setMessages([])
    try {
      const next = await action()
      setStatus(next.status)
      setMessages(next.hints)
    }
    catch (error) {
      setMessages([error instanceof Error ? error.message : '没能改成'])
    }
    finally {
      setBusy(false)
    }
  }

  /** 保存 own 档的地址 / 模型名(非秘密);空着没填的那一格不送(保留原来的)。 */
  function saveOwnFields(patch: { own_base_url?: string, own_model?: string }): void {
    void run(() => updateOwnModel(baseUrl, patch, fetchImpl))
  }

  /** Key 只往外送、永不回显;保存完刷一次状态(「已填 / 还没填」跟着变)。 */
  async function saveOwnKey(): Promise<void> {
    const key = ownKeyDraft.trim()
    if (key === '') return
    setBusy(true)
    setMessages([])
    try {
      await submitCredential(baseUrl, 'deepseek', key, fetchImpl)
      setOwnKeyDraft('')
      setMessages(['密钥存好了,只存在这台电脑上。'])
      await refresh()
    }
    catch (error) {
      setMessages([error instanceof Error ? error.message : '没能存好'])
    }
    finally {
      setBusy(false)
    }
  }

  /** 「试一下」:用此刻该用的端点打一句话回来,成了才算接上。 */
  async function runTry(): Promise<void> {
    setTrying(true)
    setTryMessage(undefined)
    try {
      const result = await tryModel(baseUrl, fetchImpl)
      setTryMessage(result.ok ? `接上了,它回:${result.message}` : `还没接上:${result.message}`)
    }
    catch (error) {
      setTryMessage(error instanceof Error ? error.message : '这次没能试')
    }
    finally {
      setTrying(false)
    }
  }

  // 服务端没开这一节(旧版本插件):说一句话就好,不画一堆点不动的控件。
  if (status.unavailable === true) {
    return (
      <SetSection id="ben-wb-model" title="模型服务">
        <SetLead>这台机器上的工作台还是旧版本,升级之后这里才能选。</SetLead>
      </SetSection>
    )
  }

  const usage = status.usage
  // 没接中转:「用工作台提供的服务」那一行走不通,不摆出来(服务端也会拒),只留自己的密钥那一行。
  const noRelay = status.relay_configured === false
  const relay = status.mode === 'relay' && !noRelay
  const switchTo = (mode: ModelMode): void => { void run(() => switchModelMode(baseUrl, mode, fetchImpl)) }

  // 评审页 `section('model', '模型服务', …)`:「用工作台提供的服务」一行开关、「使用自己的账号」一行描边「选择」。
  // 今日用量(一格 5% 的刻度,同额度那一格)与「重新接一次」只在选着工作台的服务时出现。
  return (
    <SetSection id="ben-wb-model" title="模型服务" aside={relay ? (status.ready ? '正在用' : '还没接上') : undefined}>
      {noRelay && <SetLead>{MODEL_NO_RELAY_LINE}</SetLead>}
      {!noRelay && (
        <SetRow
          title={OPTIONS[0]!.name}
          sub={relay ? `当前选择,无需填写自己的密钥。${status.ready ? '' : '还没接上工作台的模型服务。'}` : OPTIONS[0]!.hint}
        >
          <input type="checkbox" aria-label={OPTIONS[0]!.name} checked={relay} disabled={busy} onChange={event => switchTo(event.target.checked ? 'relay' : 'own')} />
        </SetRow>
      )}
      {relay && usage !== undefined && (
        <div className="ben-wb__srow-more">
          <div role="progressbar" aria-label="今日模型用量" aria-valuenow={usagePercent(usage)} aria-valuemin={0} aria-valuemax={100}>
            <Rungs percent={usagePercent(usage)} label="今日模型用量" />
          </div>
          <p className="ben-wb__smsg">{`${usageLines(usage).used} · ${usageLines(usage).limit}`}</p>
          {usageExhausted(usage) && <SetErr>今天的额度用完了,明天零点自动恢复。急着用的话,可以先切到自己的 DeepSeek 账号。</SetErr>}
        </div>
      )}
      {relay && status.usage_error !== undefined && <SetMsg>{status.usage_error}</SetMsg>}
      <SetRow
        title={OPTIONS[1]!.name}
        sub={status.mode === 'own'
          ? (status.own_key_configured ? '当前选择 · 密钥已填,要换一家在下面改。' : '当前选择 · 还没填密钥,在下面填完就能用了。')
          : OPTIONS[1]!.hint}
      >
        {status.mode === 'own'
          ? <SetSource>正在用</SetSource>
          : <SetBtn kind="outline" disabled={busy} onClick={() => switchTo('own')}>选择</SetBtn>}
      </SetRow>

      {/*
       * 「使用自己的账号」展开后的三格(2026-10-23,卡「事务官换Key」):地址、密钥、模型名,
       * 照评审页那一节的行样式(setKit 的 srow-more / sform,与各家的登录与密钥同一套)。
       * 地址与模型名原样保存(各家 OpenAI 兼容口路径不一样,不自动补 /v1);
       * 密钥走 /credentials(只存这一份、永不回显),这两格与「试一下」只在选了「自己的账号」时出现。
       */}
      {status.mode === 'own' && (
        <div className="ben-wb__srow-more">
          <div className="ben-wb__sform">
            <input
              aria-label="模型服务的地址"
              placeholder="模型服务的地址"
              spellCheck={false}
              value={ownBase}
              onChange={event => setOwnBase(event.target.value)}
              onBlur={() => {
                const value = ownBase.trim()
                if (value !== '' && value !== status.own_base_url) saveOwnFields({ own_base_url: value })
              }}
            />
          </div>
          <p className="ben-wb__smsg">照那一家给的地址填(像 https://api.deepseek.com/v1);不填就是 DeepSeek 官方。</p>
          <div className="ben-wb__sform">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="模型服务的密钥"
              placeholder={status.own_key_configured ? '已填(重填一串就替换掉)' : '模型服务的密钥'}
              value={ownKeyDraft}
              onChange={event => setOwnKeyDraft(event.target.value)}
            />
            <SetBtn kind="outline" disabled={busy || ownKeyDraft.trim() === ''} onClick={() => { void saveOwnKey() }}>
              保存
            </SetBtn>
          </div>
          <div className="ben-wb__sform">
            <input
              aria-label="模型服务的模型名"
              placeholder="模型服务的模型名"
              spellCheck={false}
              value={ownModel}
              onChange={event => setOwnModel(event.target.value)}
              onBlur={() => {
                const value = ownModel.trim()
                if (value !== '' && value !== status.own_model) saveOwnFields({ own_model: value })
              }}
            />
          </div>
          <p className="ben-wb__smsg">不填就用默认那个;填完点「试一下」,它回话了才算接上。</p>
          <SetActions>
            <SetBtn kind="outline" disabled={trying} onClick={() => { void runTry() }}>
              {trying ? '试的过程中…' : '试一下'}
            </SetBtn>
            {tryMessage !== undefined && <SetMsg>{tryMessage}</SetMsg>}
          </SetActions>
        </div>
      )}

      {relay && (
        <SetActions>
          <SetSource>{status.relay_token_configured ? '连接正常时这里不用动它。' : '还没接上工作台的模型服务。'}</SetSource>
          <SetBtn kind="text" disabled={busy} onClick={() => { void run(() => reissueModelToken(baseUrl, fetchImpl)) }}>
            {busy ? '请稍等…' : '重新接一次'}
          </SetBtn>
        </SetActions>
      )}

      {messages.map(message => <SetMsg key={message}>{message}</SetMsg>)}
    </SetSection>
  )
}

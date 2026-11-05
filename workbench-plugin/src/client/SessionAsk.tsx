/**
 * 别家的会话停着在等你 —— 摆在球下那一区,跟事务官的提问卡同一堆、同一种样子(2026-09-25,卡 T)。
 *
 * 维护者:「事务官不能纯按照 Agent 的会话状态来判断是否由我确认,也有可能跟你这次一样,你并没有用弹窗的形式列出问题和选项」;
 * 09-25 晚又定了规矩:「外层那张卡要用一句人话说清是哪家在等、等他做什么」「不许把对方原文整段贴出来」
 * 「答了送不回去时,那句话他看得懂吗,知道去哪里答吗?」。所以这张卡:
 *   - 抬头一句「Codex 在等你选」「Claude 在等你点头」(哪家 + 等他做什么),下面一句人话的问题(服务端洗过、截过);
 *   - 它明写的选项摆出来(送得回去就是按钮,点一个就送;送不回去就只摆字);「我自己说」;
 *   - 送不回去的写清去哪儿答(「这一问得在电脑上的 Claude 里回答」)+「去回答」把那段对话调到前面;
 *   - 它的原话收在「它的原话」里,点开才看(只有依据那一句,不是整段);
 *   - 按内容判出来的(不是弹窗)多一颗不起眼的「不用管这条」:判错了、或他知道了不想回,点一下就从「等你」里拿掉。
 *
 * 两种摆法:`card` 球下整张;`row` 收成一行(「Codex 在等你选:用方案 A 还是 B · 展开」)。
 */
import { useEffect, useState } from 'react'
import type { SessionApprovalKey, SessionView } from '../protocol.ts'
import { sessionAskHead, sessionAskRowText } from '../waiting.ts'
// 「等你」那一行的键只有一处定法(2026-10-03,卡「两条接缝」),见 server/jobKey.ts 文件头。
import { sessionJobId } from '../server/jobKey.ts'
import { answerAsk, answerSession, dismissSessionAsk, readApprovalKeys, revealSession } from './askApi.ts'
/**
 * 「它刚才在干什么」摆的就是这一段(2026-10-04,卡 `claude/ask-with-context`)——
 * 读会话最近几轮那条路**全仓只有这一份**(`GET /sessions/digest`),这张卡不另写一套。
 */
import { SessionDigestPanel } from './SessionRounds.tsx'

/**
 * 这张卡要的那一条会话。`agent` **按字符串**(卡 P 的规矩;`SessionView` 天然对得上):
 * 台上那张会话卡点开时递进来的是 `SceneSession`,它那一家可能是运行时接上的(id 是包标识,不在 `AgentId` 那四家里)。
 * `name` 是登记表里的名字,给抬头那一句用(「Grok Bot 在等你选」而不是包标识)。
 */
export type SessionAskSession = Omit<SessionView, 'agent'> & { agent: string, name?: string }

export interface SessionAskProps {
  session: SessionAskSession
  baseUrl: string
  fetchImpl: typeof fetch
  variant?: 'card' | 'row'
  onExpand?: () => void
  onReceipt?: (text: string) => void
  /**
   * **这一页自己已经摆着最近几轮了**(2026-10-04,卡 `claude/ask-with-context`)。
   * 点开那张会话卡的那一页(`ExternalSessionDetails`)底下本来就有一段 `SessionDigestPanel` ——
   * 那时候这张卡不再摆自己那一颗「它刚才在干什么」,免得同一段对话在一页上出现两回。
   * 球下那一区那几张卡没人替它摆,所以缺席(默认)时自己摆。
   */
  contextOnPage?: true
}

/**
 * 原文超过这么多字就先折起来,一颗「展开全文」摊开(2026-10-04,卡 `claude/ask-with-context`)。
 *
 * 为什么是 140:球下那一区同时要摆下好几张卡,09-25 那条「不许把对方原文整段贴出来」的规矩是为这个 ——
 * 140 字约合这张卡上三行,一眼扫得完「它到底在问什么」,又不会把别的几件顶出屏幕。
 * 比这短的不折(折起来反而多一颗键要点);她摊开过一次之后这一张就一直摊着(不替她收回去)。
 */
export const ASK_FULL_FOLD_CHARS = 140

/** 权限弹窗上那颗键底下配的一句中文(同 server/approvalKeys.ts 的 APPROVAL_DOES_TEXT;客户端不 import 服务端)。 */
const APPROVAL_DOES_TEXT: Readonly<Record<SessionApprovalKey['does'], string>> = { once: '批准这一次', deny: '不批' }

/**
 * **权限弹窗那一问:摆它弹窗上真实的那几颗键**(2026-10-01,卡 AP「手机替她批准」;手机 butler-app/src/asks/AskCards.tsx 同一件事)。
 * 维护者 10-01 午饭在外面:「输入回复内容之后,说发不出去」—— 打字批不了权限弹窗,所以这里**不摆输入框**:
 * 读过了摆键(壳读到的原字 + 一句中文);读得了还没读 → 打开就读一次;读不到 → 如实说 + 「再看一次」;
 * 这一路读不了(旧壳)→ 一句到电脑上点。按下去走 `/asks/answer`,核实过才说批了。
 */
function ApprovalKeys({ session, permission, baseUrl, fetchImpl, onReceipt, onNote }: {
  session: SessionAskSession
  permission: NonNullable<NonNullable<SessionView['ask']>['permission']>
  baseUrl: string
  fetchImpl: typeof fetch
  onReceipt?: (text: string) => void
  onNote: (text: string | undefined) => void
}) {
  const [keys, setKeys] = useState<readonly SessionApprovalKey[] | undefined>(permission.keys)
  const [reading, setReading] = useState(false)
  const [why, setWhy] = useState<string | undefined>(permission.why)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (permission.keys !== undefined) setKeys(permission.keys) }, [permission.keys])
  const read = (): void => {
    if (reading) return
    setReading(true)
    setWhy(undefined)
    void readApprovalKeys(baseUrl, fetchImpl, session.agent, session.session_id).then((result) => {
      setReading(false)
      if (result.ok) setKeys(result.keys)
      else setWhy(result.why)
    })
  }
  // 读得了、还没读过:打开这张卡就去读一次。
  useEffect(() => {
    if (permission.keys === undefined && permission.readable === true) read()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const press = (label: string): void => {
    if (busy) return
    setBusy(true)
    onNote(undefined)
    void answerAsk(baseUrl, fetchImpl, sessionJobId(session.agent, session.session_id), { choice: label }).then((result) => {
      setBusy(false)
      if (result.ok) {
        onReceipt?.(result.note ?? (result.confirmed ? `已替你按了「${label}」` : `按了「${label}」,没看到它收下`))
        if (!result.confirmed) onNote(result.note)
        return
      }
      onNote(result.where === 'desk' ? result.why : result.error)
    })
  }
  if (keys !== undefined && keys.length > 0) {
    return (
      <div className="ben-wb__qask-options" aria-label="它弹窗上的键">
        {keys.map(key => (
          <button key={key.label} type="button" className="ben-wb__qask-option" disabled={busy} onClick={() => press(key.label)}>
            <span className="ben-wb__qask-option-text">{key.label}</span>
            <span className="ben-wb__qask-option-note">{APPROVAL_DOES_TEXT[key.does]}</span>
          </button>
        ))}
      </div>
    )
  }
  if (reading) return <p className="ben-wb__sask-where">在看它弹窗上有哪几颗键…</p>
  if (why !== undefined) {
    return (
      <div className="ben-wb__sask-desk">
        <p className="ben-wb__sask-where">{why}</p>
        <button type="button" className="ben-wb__qask-send" onClick={read}>再看一次</button>
      </div>
    )
  }
  return <p className="ben-wb__sask-where">{session.ask?.where ?? '这一问得在电脑上那家的窗口里点'}</p>
}

export function SessionAsk({ session, baseUrl, fetchImpl, variant = 'card', onExpand, onReceipt, contextOnPage }: SessionAskProps) {
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [deskNow, setDeskNow] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  /** 原文摊开了没有(卡 claude/ask-with-context)。 */
  const [sayOpen, setSayOpen] = useState(false)
  /**
   * 「它刚才在干什么」摊开了没有。**默认收着,收着的时候一条请求都不发** ——
   * 球下那一区同时摆着好几张卡,一打开页面就各读一次会话记录是白花的功夫。
   */
  const [contextOpen, setContextOpen] = useState(false)
  /** 本以为送得回去、服务端却说到电脑上答:那一次回包说了能不能「去回答」。 */
  const [revealNow, setRevealNow] = useState<boolean | undefined>(undefined)
  /** 打字回来说撞上的是权限弹窗(老版工作台没给 `permission` 那一格时):那一句话,据此切到按键(卡 AP)。 */
  const [permissionNow, setPermissionNow] = useState<string | undefined>(undefined)
  const ask = session.ask

  if (variant === 'row' || ask === undefined) {
    return (
      <>
        <span className="ben-wb__askrow-text">{sessionAskRowText(session)}</span>
        {onExpand !== undefined && <button type="button" className="ben-wb__laid-link ben-wb__askrow-open" onClick={onExpand}>展开</button>}
      </>
    )
  }

  /**
   * ★ **权限弹窗那一问**(2026-10-01,卡 AP):不摆输入框、不摆选项,摆它弹窗上那几颗键(见 {@link ApprovalKeys})。
   */
  const permission = ask.permission ?? (permissionNow === undefined ? undefined : { readable: true as const })
  if (permission !== undefined) {
    return (
      <div className="ben-wb__qask ben-wb__sask" data-variant={variant} role="group" aria-label={sessionAskHead(session)}>
        <p className="ben-wb__qask-head">
          <span>{sessionAskHead(session)}</span>
          {session.title !== undefined && session.title.trim() !== '' && <><span aria-hidden="true"> · </span><strong>{session.title}</strong></>}
        </p>
        <p className="ben-wb__qask-say">{ask.question}</p>
        {permissionNow !== undefined && <p className="ben-wb__sask-where">{permissionNow}</p>}
        <ApprovalKeys session={session} permission={permission} baseUrl={baseUrl} fetchImpl={fetchImpl} {...(onReceipt === undefined ? {} : { onReceipt })} onNote={setNote} />
        {note !== undefined && <p className="ben-wb__qask-err" role="alert">{note}</p>}
        {ask.reveal === true && (
          <div className="ben-wb__sask-desk">
            <button type="button" className="ben-wb__qask-send" onClick={() => { void revealSession(baseUrl, fetchImpl, session.agent, session.session_id).then((result) => { if (!result.ok) setNote(result.why ?? '没能把那段对话调到前面,请直接打开那个 App') }) }}>去回答</button>
          </div>
        )}
      </div>
    )
  }

  const answerable = !deskNow && (ask.reply === 'window' || ask.reply === 'cli')
  const where = ask.where ?? '这一问得在电脑上那家的窗口里回答'
  /**
   * ★ **问的是什么:原文**(2026-10-04,卡 `claude/ask-with-context`)。维护者原话:
   * 「每次要确认内容的信息都很短,我都不知道发生了什么,还得自己去最近的会话找上下文」。
   *
   * `ask.question` 是服务端洗过、截到 60 字的一句人话(来电念的、球下抬头、卡面那一行都是它);
   * `ask.full.question` 是**那家弹窗里的原字**。有原文就摆原文(长了折起来),没有(按内容判出来的那几条、
   * 旧版工作台)照旧摆短的那一句 —— 两条路都不编。
   */
  const sayText = ask.full?.question ?? ask.question
  const foldable = Array.from(sayText).length > ASK_FULL_FOLD_CHARS
  const sayFolded = foldable && !sayOpen
  /**
   * 选项**看见的是原文、送回去的还是工作台给的那一颗**(卡 claude/ask-with-context)。
   * 两份一一对应(同一个 `step.options`、同一道「label 空的不算」过滤),**只在条数一样时才配对** ——
   * 条数不一样宁可摆短的那一份,不猜哪一颗对哪一颗。
   */
  const fullOptions = ask.full?.options !== undefined && ask.full.options.length === (ask.options ?? []).length ? ask.full.options : undefined
  /**
   * ★ **它弹的那个框上那几项,工作台能替他点**(2026-09-28,卡 WQ)。维护者原话:
   * 「它现在几个选项给出来了,给完之后我还不能选,我还得回那个会话窗口回……我告诉你有事,但是我帮你传不了话。」
   *
   * 打字送不进那个框(`reply:'desk'`),可**框上那几颗键点得下去**:走 `POST /asks/answer`(链上第 ⑧ 环那一个口)
   * → 壳把 Codex 叫到台前、按标签找到「川菜」按下去 → **重读一次核实那一问没了**才说「已替你答了」。
   * 核不上就照服务端那句话说(「点了,但没看到它收下」)—— 不谎报。
   */
  const pressable = !deskNow && ask.press === true && (ask.options ?? []).length > 0
  const pickable = answerable || pressable
  /**
   * ★ **她自己打的那一句也送得进去**(2026-09-28,卡 AT)。维护者原话:「做半天还是不能送进去?……
   * 你就复制黏贴我贴在框里的文字输入进去不就好了吗。」
   *
   * 壳把她那句**原文一字不改**写进那家提问面板里的自由作答框、按**面板自己**那颗发送键,再核实一次。
   * 所以弹框那一问这里也摆「我自己说」——从前那半句「要自己说一句,得在电脑上…」在新壳上不再出现。
   */
  const writable = !deskNow && ask.write === true
  /** 摆不摆「我自己说」那个框(两条路:打字送回会话 / 写进它那个面板)。 */
  const ownBox = answerable || writable
  const pressOption = (label: string): void => {
    if (busy) return
    setBusy(true)
    setNote(undefined)
    void answerAsk(baseUrl, fetchImpl, sessionJobId(session.agent, session.session_id), { choice: label }).then((result) => {
      setBusy(false)
      if (result.ok) { onReceipt?.(result.note ?? (result.confirmed ? `已替你答了:${label}` : `点了「${label}」,但没看到它收下`)); if (!result.confirmed) setNote(result.note); return }
      if (result.where === 'desk') { setDeskNow(true); setNote(result.why); setRevealNow(result.reveal); return }
      setNote(result.error)
    })
  }
  /**
   * **她自己那句话:写进它那个面板**(2026-09-28,卡 AT)。走链上第 ⑧ 环那同一个口
   * (`POST /asks/answer {key, text}`),回包里 `confirmed` 说的是核实过没有 —— 核不上照那句原话说。
   */
  const sayOwn = (text: string): void => {
    const said = text.trim()
    if (busy || said === '') return
    setBusy(true)
    setNote(undefined)
    void answerAsk(baseUrl, fetchImpl, sessionJobId(session.agent, session.session_id), { text: said }).then((result) => {
      setBusy(false)
      if (result.ok) {
        if (result.confirmed) setCustom('')
        onReceipt?.(result.note ?? (result.confirmed ? `已替你答了:${said}` : `写进去了,但没看到它收下`))
        if (!result.confirmed) setNote(result.note)
        return
      }
      if (result.where === 'desk') { setDeskNow(true); setNote(result.why); setRevealNow(result.reveal); return }
      setNote(result.error)
    })
  }
  const send = (text: string): void => {
    const said = text.trim()
    if (busy || said === '') return
    setBusy(true)
    setNote(undefined)
    void answerSession(baseUrl, fetchImpl, session.agent, session.session_id, said).then((result) => {
      setBusy(false)
      if (result.ok) { setCustom(''); onReceipt?.('送过去了,它接着办'); return }
      // 撞上的是权限弹窗(卡 AP):收起输入框,切到「批准 / 拒绝」那几颗键。
      if (result.where === 'desk' && result.permission === true) { setCustom(''); setPermissionNow(result.why); return }
      if (result.where === 'desk') { setDeskNow(true); setNote(result.why); setRevealNow(result.reveal); return }
      setNote(result.error)
    })
  }
  const dismiss = (): void => {
    void dismissSessionAsk(baseUrl, fetchImpl, session.agent, session.session_id).then((failed) => {
      if (failed !== undefined) setNote(failed)
      else onReceipt?.('好,这条不算在等你了')
    })
  }
  const reveal = (): void => {
    void revealSession(baseUrl, fetchImpl, session.agent, session.session_id).then((result) => {
      if (!result.ok) setNote(result.why ?? '没能把那段对话调到前面,请直接打开那个 App')
    })
  }

  return (
    <div className="ben-wb__qask ben-wb__sask" data-variant={variant} role="group" aria-label={sessionAskHead(session)}>
      <p className="ben-wb__qask-head">
        <span>{sessionAskHead(session)}</span>
        {session.title !== undefined && session.title.trim() !== '' && <><span aria-hidden="true"> · </span><strong>{session.title}</strong></>}
      </p>
      {/* 弹窗那一问上面那行小标题(「导出 PDF 走哪一条」):它给了才有,不替它编一个。 */}
      {ask.full?.header !== undefined && <p className="ben-wb__sask-header">{ask.full.header}</p>}
      <p className="ben-wb__qask-say ben-wb__sask-say" data-testid="sask-say" data-folded={String(sayFolded)}>{sayText}</p>
      {foldable && (
        <button type="button" className="ben-wb__sask-link" aria-expanded={sayOpen} onClick={() => setSayOpen(open => !open)}>
          {sayOpen ? '收起' : '展开全文'}
        </button>
      )}
      {ask.options !== undefined && ask.options.length > 0 && (
        pickable
          ? (
              <div className="ben-wb__qask-options" role="radiogroup" aria-label="选一个">
                {ask.options.map((option, index) => {
                  const shown = fullOptions?.[index] ?? option
                  return (
                    <button key={option.label} type="button" className="ben-wb__qask-option" disabled={busy} onClick={() => (answerable ? send(option.label) : pressOption(option.label))}>
                      <span className="ben-wb__qask-option-text">{shown.label}</span>
                      {shown.note !== undefined && <span className="ben-wb__qask-option-note">{shown.note}</span>}
                    </button>
                  )
                })}
              </div>
            )
          : (
              <ul className="ben-wb__sask-options" aria-label="它给的选项">
                {ask.options.map((option, index) => {
                  const shown = fullOptions?.[index] ?? option
                  return (
                    <li key={option.label}>
                      <span className="ben-wb__qask-option-text">{shown.label}</span>
                      {shown.note !== undefined && <span className="ben-wb__qask-option-note">{shown.note}</span>}
                    </li>
                  )
                })}
              </ul>
            )
      )}
      {ownBox && (
        <div className="ben-wb__qask-own">
          <input
            type="text"
            aria-label="我自己说"
            /* 弹框那一问:这一句是**写进它那个面板里的自由作答框**、按面板自己那颗发送键(卡 AT)。 */
            placeholder={answerable ? '我自己说:直接写一句,送回它那边' : '我自己说:直接写一句,替你写进它那个框'}
            value={custom}
            disabled={busy}
            onChange={(event) => { setCustom(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (answerable) send(custom)
              else sayOwn(custom)
            }}
          />
          <button type="button" className="ben-wb__qask-send" disabled={busy || custom.trim() === ''} onClick={() => (answerable ? send(custom) : sayOwn(custom))}>回复</button>
        </div>
      )}
      {!answerable && (
        <div className="ben-wb__sask-desk">
          {/*
            能替他点选项时这一行说的是**剩下那半件**(卡 WQ):选项我能替你点,要自己说一句才得去那家里说。
            **她那句话也送得进去了(卡 AT)之后这半句不再出现** —— 上面就摆着「我自己说」那个框。
            点 / 写出了问题时 `note` 是服务端那句原话(「点了,但没看到它收下」),照它说。
          */}
          {!writable && <p className="ben-wb__sask-where">{note ?? (pressable ? `上面那几项我能替你点;要自己说一句,${where}` : where)}</p>}
          {(revealNow ?? ask.reveal === true) && <button type="button" className="ben-wb__qask-send" onClick={reveal}>去回答</button>}
        </div>
      )}
      {ownBox && note !== undefined && <p className="ben-wb__qask-err" role="alert">{note}</p>}
      {/*
        ★ **它刚才在干什么**(2026-10-04,卡 `claude/ask-with-context`)。维护者原话:
        「我都不知道发生了什么,还得自己去最近的会话找上下文,这个不好」。
        点开摆的是那条会话的**最近几轮原文**(她说的 / 它说的,原样)+ 在哪个项目 ——
        走的是现成那条路(`GET /sessions/digest`,`SessionDigestPanel` 那一份),**不另写一套、不经模型**。
        默认收着:球下那一区同时摆着几张卡(09-25「不许整段贴出来」那条规矩),摊开是她点出来的。
      */}
      {contextOnPage !== true && (
        <div className="ben-wb__sask-context">
          <button type="button" className="ben-wb__sask-link" aria-expanded={contextOpen} onClick={() => setContextOpen(open => !open)}>
            {contextOpen ? '收起刚才那几轮' : '它刚才在干什么'}
          </button>
          {contextOpen && (
            <SessionDigestPanel
              agent={session.agent}
              {...(session.name === undefined ? {} : { name: session.name })}
              sessionId={session.session_id}
              baseUrl={baseUrl}
              fetchImpl={fetchImpl}
              variant="ask"
            />
          )}
        </div>
      )}
      <div className="ben-wb__sask-foot">
        {ask.by !== 'form' && <button type="button" className="ben-wb__sask-link" onClick={dismiss}>不用管这条</button>}
        {ask.quote !== undefined && (
          <button type="button" className="ben-wb__sask-link" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(open => !open)}>
            {quoteOpen ? '收起' : '它的原话'}
          </button>
        )}
      </div>
      {quoteOpen && ask.quote !== undefined && <p className="ben-wb__sask-quote">「{ask.quote}」</p>}
    </div>
  )
}

/** 这张卡多出来的几样(其余照事务官提问卡 ASK_STYLE)。 */
export const SESSION_ASK_STYLE = `
.ben-wb__sask-options{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.ben-wb__sask-options li{display:flex;flex-direction:column;gap:3px;padding:8px 12px;border-radius:10px;border:1px dashed var(--wb-surface-border,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-secondary)}
.ben-wb__sask-desk{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ben-wb__sask-where{margin:0;flex:1 1 180px;font-size:12px;line-height:1.6;color:#e3b76a}
.ben-wb__sask-foot{display:flex;justify-content:flex-end;gap:12px}
.ben-wb__sask .ben-wb__sask-link{border:0;background:transparent;padding:2px;font:inherit;font-size:10.5px;color:var(--dsw-alias-label-tertiary);opacity:.75;cursor:pointer}
.ben-wb__sask .ben-wb__sask-link:hover{opacity:1}
.ben-wb__sask-quote{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
/*
  那一问的原文(2026-10-04,卡 claude/ask-with-context):长了先折成三行,一颗「展开全文」摊开。
  折的是**显示**,字一个都没少 —— 读屏与查找都能拿到整段(所以不是截字符串)。
*/
.ben-wb__sask-say{overflow-wrap:anywhere;white-space:pre-wrap}
.ben-wb__sask-say[data-folded="true"]{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ben-wb__sask-header{margin:0;font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}
.ben-wb__sask-context{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.ben-wb__sask-context .ben-wb__session-digest{width:100%}
.ben-wb__session-digest-project{color:var(--dsw-alias-label-tertiary);font-size:11px}
`

/** 首次有用沿用服务端的实际结果；电脑引导只试早报与文字活，通话能力保留供之后使用。 */
import { useState } from 'react'
import {
  FIRST_TRY_ASK, FIRST_USE_SAY, MAIN_PATH_TITLES, mainPathLine,
  type DoorView, type FirstUsePathView, type FirstUseView, type MainPath,
} from '../../mainPaths.ts'
import { loginAgent, sayToButler, setFirstTry, tryFirstUse } from './firstRunApi.ts'

/** 事务官第一次开口那一句(与 `FirstRunFlow.tsx` 的 `FIRST_RUN_HELLO` 同一句;那边从这里取,免得两份)。 */
export const FIRST_RUN_HELLO = '你好,很高兴认识你,我是你的专属事务官。'

export const FIRST_USE_STYLE = `
.ben-wb__firstuse-list{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:10px;width:min(460px,100%);text-align:left}
.ben-wb__firstuse-row{display:flex;flex-direction:column;gap:6px;padding:6px 0}
.ben-wb__firstuse-row[data-current="true"]{color:var(--dsw-alias-label-primary,#ecebe6)}
.ben-wb__firstuse-head{display:flex;justify-content:space-between;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary,#ecebe6)}
.ben-wb__firstuse-state{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9890)}
.ben-wb__firstuse-row[data-state="ok"] .ben-wb__firstuse-state{color:var(--dsw-alias-state-success-primary,#7cc796)}
.ben-wb__firstuse-door{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#c9c7bf)}
.ben-wb__firstuse-row audio{width:100%;height:30px}
.ben-wb__firstuse-lead{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#9a9890)}
`

/** 五问前那一问。答了那一件排第一;「都行,你定」= 按早报 → 交代 → 电话。 */
export function FirstTryStep({ baseUrl, fetchImpl, onAnswered }: {
  baseUrl: string
  fetchImpl: typeof fetch
  onAnswered: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function pick(path: MainPath | '都行'): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await setFirstTry(baseUrl, path, fetchImpl)
      onAnswered()
    }
    catch (err) {
      setError(err instanceof Error ? err.message : '没记上')
    }
    finally {
      setBusy(false)
    }
  }
  return (
    <section className="ben-wb__firstrun-step" aria-label="想先试哪一件">
      <h1 className="ben-wb__firstrun-ttl ben-wb__onb-sr">事务官</h1>
      {/* 先打招呼再问(2026-10-21 隔离实例真机:一上来就问,像没头没脑)。 */}
      <p className="ben-wb__firstrun-say">{FIRST_RUN_HELLO}</p>
      <p className="ben-wb__firstrun-sub">{FIRST_TRY_ASK}</p>
      <div className="ben-wb__firstrun-row">
        <button type="button" className="ben-wb__firstrun-go" disabled={busy} onClick={() => { void pick('morning') }}>早报</button>
        <button type="button" className="ben-wb__firstrun-go" disabled={busy} onClick={() => { void pick('delegate') }}>交代一件事</button>
      </div>
      <button type="button" className="ben-wb__firstrun-alt" disabled={busy} onClick={() => { void pick('都行') }}>都行,你定</button>
      {error !== null && <p className="ben-wb__firstrun-err" role="alert">{error}</p>}
    </section>
  )
}

/** 这一屏的标题与底下那一行(引导的最后一步;几件通了)。 */
export const FIRST_USE_TITLE = '最后一步:三件事各试一次'
export function firstUseLead(view: FirstUseView): string {
  const ok = view.paths.filter(one => one.state === 'ok').length
  return `通了 ${ok} / ${view.paths.length}。都通了就进工作台;哪件没通,底下写着缺什么、怎么补。`
}

/** 第一次有用那一屏现在说哪一句:三样都成说收尾;否则说排在最前、还没成的那一件。 */
export const FIRST_USE_MISSING = '这件事还没做成。先补齐下面说明的条件，再重试。'
export function firstUseLine(view: FirstUseView): string {
  if (view.closed_at !== undefined) return FIRST_USE_SAY.closing
  const current = currentPath(view)
  return current?.state === 'missing' ? FIRST_USE_MISSING : current?.say ?? FIRST_USE_SAY.closing
}

/**
 * 现在轮到哪一件:先挑还没试 / 正在试的;缺一道门的那件不占着(2026-10-21 隔离实例真机:排第一的交代缺登录,
 * 早报与电话就一直点不了)。它的门与那颗键照样摆在它那一行里,门补上了它就回到「还没试」。
 * 那一句话与「当前这一件」只认这一处(真机上两处各算一遍,话说的是交代、能点的是电话)。
 */
export function currentPath(view: FirstUseView): FirstUsePathView | undefined {
  if (view.closed_at !== undefined) return undefined
  return view.paths.find(one => one.state === 'todo' || one.state === 'trying') ?? view.paths.find(one => one.state !== 'ok')
}

export function FirstUseStep({ view: sourceView, baseUrl, fetchImpl, onFinish, onPair, desktopOnly = false }: {
  view: FirstUseView
  desktopOnly?: boolean
  baseUrl: string
  fetchImpl: typeof fetch
  /** 进工作台(写旗子)。 */
  onFinish: () => void
  /** 「去配对」:回到配对那一屏,配上了再回来。缺席 = 只说一句怎么办。 */
  onPair?: () => void
}) {
  const view = desktopOnly ? { ...sourceView, paths: sourceView.paths.filter(one => one.path !== 'call') } : sourceView
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const closed = desktopOnly ? view.paths.every(one => one.state === 'ok') : view.closed_at !== undefined
  const current = currentPath(view)
  // 每件都成了、或者没成的那几件缺哪道门写清了,才给先进工作台。
  const canLeave = !closed && view.paths.every(one => one.state === 'ok' || one.state === 'missing')

  async function act(run: () => Promise<string | undefined>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const said = await run()
      setNote(said ?? null)
    }
    catch (err) {
      setError(err instanceof Error ? err.message : '这一下没成')
    }
    finally {
      setBusy(false)
    }
  }
  const tryIt = (path: MainPath, text?: string): Promise<void> => act(async () => {
    const result = await tryFirstUse(baseUrl, path, text, fetchImpl)
    if (path === 'delegate' && result.ok) setDraft('')
    return result.note
  })
  const sayIt = (): Promise<void> => act(async () => {
    const text = draft.trim()
    if (text === '') return '先说一句你要我盯的事'
    const result = await sayToButler(baseUrl, text, fetchImpl)
    setDraft('')
    return result.note ?? '记下了。'
  })

  return (
    <section className="ben-wb__firstrun-step" aria-label="第一次有用">
      <style>{FIRST_USE_STYLE}</style>
      {/* 看得见的标题(2026-10-21 维护者在预览台上:「扫码之后第一页这个是什么鬼」—— 没说这一屏在干什么)。 */}
      <h1 className="ben-wb__firstrun-ttl">{desktopOnly ? '第一次有用：在电脑上试两件事' : FIRST_USE_TITLE}</h1>
      <p className="ben-wb__firstuse-lead">{desktopOnly ? '做成的按实际结果显示；未完成的会说明原因，可稍后继续。' : firstUseLead(view)}</p>
      <p className="ben-wb__firstrun-say">{desktopOnly && closed ? '电脑上的两件事已经做成。' : desktopOnly && current === undefined ? '还没做成的项目，下面说明了原因。' : firstUseLine(view)}</p>
      <ol className="ben-wb__firstuse-list" aria-label={desktopOnly ? '电脑两件事' : '三件事'}>
        {view.paths.map(one => (
          <li key={one.path} className="ben-wb__firstuse-row" data-path={one.path} data-state={one.state} data-current={current?.path === one.path}>
            <div className="ben-wb__firstuse-head">
              <span>{MAIN_PATH_TITLES[one.path]}</span>
              <span className="ben-wb__firstuse-state">{mainPathLine(one.state, one.door)}</span>
            </div>
            {one.path === 'morning' && one.state === 'ok' && (
              // 播客能点(设计稿:卡出现、播客能放):今天那一期就在 `/feed/podcast`。
              <audio controls preload="none" src={`${baseUrl}/feed/podcast`} aria-label="今天的播客" />
            )}
            {one.state === 'missing' && one.door !== undefined && (
              <>
                <DoorRow door={one.door} busy={busy} onLogin={family => act(async () => (await loginAgent(baseUrl, family, fetchImpl)).note)} {...(onPair === undefined ? {} : { onPair })} />
                {desktopOnly && <>
                  <p className="ben-wb__firstrun-hint">可在进入工作台后，从设置补齐配置，再回来重试。</p>
                  <button type="button" className="ben-wb__firstrun-alt" disabled={busy} onClick={() => { void tryIt(one.path, one.path === 'delegate' ? draft.trim() || undefined : undefined) }}>重试</button>
                </>}
              </>
            )}
            {current?.path === one.path && one.state !== 'missing' && (
              <PathActions
                one={one}
                callMode={view.call_mode}
                busy={busy}
                draft={draft}
                onDraft={setDraft}
                onTry={(text) => { void tryIt(one.path, text) }}
                onSay={() => { void sayIt() }}
              />
            )}
          </li>
        ))}
      </ol>
      {note !== null && <p className="ben-wb__firstrun-hint" role="status">{note}</p>}
      {closed && (
        <div className="ben-wb__firstrun-row">
          <button type="button" className="ben-wb__firstrun-go" onClick={onFinish}>{desktopOnly ? '继续' : '进工作台'}</button>
        </div>
      )}
      {canLeave && (
        <button type="button" className="ben-wb__firstrun-alt" onClick={onFinish}>{desktopOnly ? '继续' : '先进工作台,没成的那件卡上接着'}</button>
      )}
      {error !== null && <p className="ben-wb__firstrun-err" role="alert">{error}</p>}
    </section>
  )
}

/** 一件主路此刻能点的那几下。 */
function PathActions({ one, callMode, busy, draft, onDraft, onTry, onSay }: {
  one: FirstUsePathView
  callMode: FirstUseView['call_mode']
  busy: boolean
  draft: string
  onDraft: (text: string) => void
  onTry: (text?: string) => void
  onSay: () => void
}) {
  const trying = one.state === 'trying'
  if (one.path === 'morning') {
    return (
      <div className="ben-wb__firstrun-row">
        <button type="button" className="ben-wb__firstrun-go" disabled={busy || trying} onClick={() => onTry()}>出一份早报</button>
        {trying && <span className="ben-wb__firstrun-hint">在整理,一分钟上下…</span>}
      </div>
    )
  }
  if (one.path === 'delegate') {
    return (
      <>
        <div className="ben-wb__firstrun-row ben-wb__onb-field">
          <input
            className="ben-wb__firstrun-input"
            aria-label="交代一件事"
            placeholder="挑一件你手上的事"
            value={draft}
            onChange={event => onDraft(event.target.value)}
          />
          <button type="button" className="ben-wb__firstrun-go" disabled={busy || draft.trim() === ''} onClick={() => onTry(draft.trim())}>交给它</button>
        </div>
        <button type="button" className="ben-wb__firstrun-alt" disabled={busy} onClick={() => onTry()}>没想好,介绍一下这个项目</button>
        {trying && <p className="ben-wb__firstrun-hint">派出去了,等它交回来(结果会写在那张卡上,手机上也看得到)。</p>}
      </>
    )
  }
  if (callMode === 'desk') {
    return (
      <div className="ben-wb__firstrun-row ben-wb__onb-field">
        <input
          className="ben-wb__firstrun-input"
          aria-label="对事务官说一句"
          placeholder="比如:周五提醒我交报销"
          value={draft}
          onChange={event => onDraft(event.target.value)}
        />
        <button type="button" className="ben-wb__firstrun-go" disabled={busy || draft.trim() === ''} onClick={onSay}>记下</button>
      </div>
    )
  }
  return (
    <>
      <p className="ben-wb__firstrun-hint">接起来我先介绍自己,再问你有什么要我盯的;你说一件,我记成一张事项。</p>
      <div className="ben-wb__firstrun-row">
        <button type="button" className="ben-wb__firstrun-go" disabled={busy} onClick={() => onTry()}>我这就拨</button>
        {trying && <span className="ben-wb__firstrun-hint">等你打过来…</span>}
      </div>
    </>
  )
}

/** 缺哪道门:一句怎么办 + 能一颗键修的给键(登录 Claude / Codex、去配对)。 */
export function DoorRow({ door, busy, onLogin, onPair }: {
  door: DoorView
  busy: boolean
  onLogin: (family: string) => void
  onPair?: () => void
}) {
  return (
    <>
      <p className="ben-wb__firstuse-door">{door.text}</p>
      {door.fixes.some(fix => fix.kind === 'login_cli' || (fix.kind === 'pair' && onPair !== undefined)) && (
        <div className="ben-wb__firstrun-row">
          {door.fixes.map(fix => fix.kind === 'login_cli' && fix.family !== undefined
            ? <button key={fix.label} type="button" className="ben-wb__firstrun-alt" disabled={busy} onClick={() => onLogin(fix.family as string)}>{fix.label}</button>
            : fix.kind === 'pair' && onPair !== undefined
              ? <button key={fix.label} type="button" className="ben-wb__firstrun-alt" disabled={busy} onClick={onPair}>{fix.label}</button>
              : null)}
        </div>
      )}
    </>
  )
}

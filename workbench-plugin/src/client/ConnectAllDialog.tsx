/**
 * 「全部接上」那个确认框(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * 维护者 09-24:「授权要自己点就算了」—— 可以要他点,但**只点一次**。原来 Claude、Codex 各一个框、
 * 各看一遍、各点一次「写入」;这里并成一个框:
 *
 *   加载中 → 先看一眼(两家各写进哪个文件、写什么 + Kimi 那一句 + 「一次写入」/「取消」)
 *          → 写完了(逐家:接上了 + 备份在哪 + 「撤回 X」;要重开会话那一句;「知道了」)
 *          → 出错了(服务端那句人话原样摆出来)
 *
 * 纪律与 HooksApplyDialog 一字不差(先看后写、写完能撤回、失败说出来),样式也是同一套
 * `ben-wb__hookapply*` —— 两个框长得一样,他不会以为这是另一种东西。撤回仍是一家一颗,
 * 走原来那条 `POST /config/hooks/revert {agent}`。
 *
 * 盖在窗位上时会被原生窗压住(CSS 排不到操作系统窗口前面),所以开着的时候让窗位让开
 * (useVeilSlot,同设置弹窗)。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConnectAllAppliedView, ConnectAllPreviewView, HooksAgent } from './hooksApply.ts'
import { HOOKS_AGENT_NAMES, applyConnectAll, connectedRowLine, loadConnectAllPreview, revertHooks, revertedLine, shortHome } from './hooksApply.ts'
import { useVeilSlot, type VeilTarget } from './useVeilSlot.ts'

type Phase =
  | { kind: 'loading' }
  | { kind: 'preview', preview: ConnectAllPreviewView }
  | { kind: 'writing', preview: ConnectAllPreviewView }
  | { kind: 'done', applied: ConnectAllAppliedView, reverted: Partial<Record<HooksAgent, string>> }
  | { kind: 'error', message: string }

export interface ConnectAllDialogProps {
  baseUrl: string
  fetchImpl?: typeof fetch
  onClose: () => void
  /** 写完 / 撤回完调一次:看板据此立刻重问一遍 /state。 */
  onChanged?: () => void
  /** 窗位让路(同设置弹窗)。不在壳里就不传。 */
  veil?: VeilTarget
}

export function ConnectAllDialog({ baseUrl, fetchImpl, onClose, onChanged, veil }: ConnectAllDialogProps) {
  useVeilSlot(true, veil)
  // Esc 关闭(同设置弹窗)。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="ben-wb__hookapply-mask" role="dialog" aria-modal="true" aria-label="Claude、Codex 一次接上">
      <div className="ben-wb__hookapply">
        <div className="ben-wb__hookapply-head">
          <span className="ben-wb__hookapply-title">全部接上</span>
          <button type="button" className="ben-wb__hookapply-x" aria-label="关掉" onClick={onClose}>×</button>
        </div>
        <ConnectAllFlow baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} onClose={onClose} {...(onChanged === undefined ? {} : { onChanged })} />
      </div>
    </div>
  )
}

/**
 * 「先看 → 一次写入 → 逐家撤回」那一整段,**不带外框**(2026-09-25)。
 *
 * 两处用:额度面板那颗「全部接上」套一个确认框(ConnectAllDialog,同单家那个框的样子);
 * 球下面那张额度卡(QuotaConnectAsk)**就地展开**它 —— 首页上不弹窗(维护者:不要弹窗感)。
 * 两处走的是同一段代码,看到的、点到的一模一样。
 */
export function ConnectAllFlow({ baseUrl, fetchImpl, onClose, onChanged }: {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 「取消」「知道了」「关掉」都走它。 */
  onClose: () => void
  onChanged?: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  /**
   * 第几次去"看"(2026-09-25,卡 R)。出错那一屏的「再试一次」把它加一,重新走一遍「先看」——
   * 服务端那一句人话就是以这颗按钮收尾的(钩子脚本没放好、磁盘满了腾出空间之后等),
   * 不叫他去改任何设置。重来一遍只是再看一次,一个字都不写,点多少次都不怕。
   */
  const [attempt, setAttempt] = useState(0)
  const doFetch = fetchImpl ?? fetch

  useEffect(() => {
    let alive = true
    setPhase({ kind: 'loading' })
    void loadConnectAllPreview(baseUrl, doFetch)
      .then((preview) => { if (alive) setPhase({ kind: 'preview', preview }) })
      .catch((error: unknown) => {
        if (alive) setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { alive = false }
  }, [baseUrl, doFetch, attempt])

  const write = useCallback((preview: ConnectAllPreviewView) => {
    setPhase({ kind: 'writing', preview })
    void applyConnectAll(baseUrl, doFetch)
      .then((applied) => {
        setPhase({ kind: 'done', applied, reverted: {} })
        onChanged?.()
      })
      .catch((error: unknown) => {
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [baseUrl, doFetch, onChanged])

  const undo = useCallback((agent: HooksAgent) => {
    void revertHooks(baseUrl, agent, doFetch)
      .then((reverted) => {
        setPhase(current => current.kind === 'done'
          ? { ...current, reverted: { ...current.reverted, [agent]: revertedLine(agent, reverted) } }
          : current)
        onChanged?.()
      })
      .catch((error: unknown) => {
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [baseUrl, doFetch, onChanged])

  return (
    <>
      {phase.kind === 'loading' && <p className="ben-wb__hookapply-line">正在看这台机器该写什么…</p>}

      {(phase.kind === 'preview' || phase.kind === 'writing') && (
        <Preview preview={phase.preview} busy={phase.kind === 'writing'} onWrite={() => write(phase.preview)} onCancel={onClose} />
      )}

      {phase.kind === 'done' && (
        <>
          {phase.applied.results.map(row => (
            <div key={row.agent} className="ben-wb__hookapply-row">
              <p className="ben-wb__hookapply-line" role="status" {...(row.ok ? {} : { 'data-tone': 'bad' })}>
                {phase.reverted[row.agent] ?? connectedRowLine(row)}
              </p>
              {row.ok && phase.reverted[row.agent] === undefined && (
                <button type="button" className="ben-wb__hookapply-btn" onClick={() => undo(row.agent)}>
                  {`撤回 ${HOOKS_AGENT_NAMES[row.agent]}`}
                </button>
              )}
            </div>
          ))}
          {phase.applied.results.length === 0 && <p className="ben-wb__hookapply-line" role="status">{phase.applied.line}</p>}
          {/* 备份在哪:不摊在第一眼上(不露路径),但要找得到 —— 他后悔了、想比对,靠的就是它。 */}
          {phase.applied.results.some(row => row.backup_path !== undefined) && (
            <details className="ben-wb__hookapply-more">
              <summary>另存的那几份在哪(看不懂也没关系)</summary>
              {phase.applied.results.filter(row => row.backup_path !== undefined).map(row => (
                <p key={row.agent} className="ben-wb__hookapply-file">{shortHome(row.backup_path ?? '')}</p>
              ))}
            </details>
          )}
          {phase.applied.restart_hint !== undefined && (
            <p className="ben-wb__hookapply-line" data-tone="dim">{phase.applied.restart_hint}</p>
          )}
          {phase.applied.kimi?.state === 'pending' && (
            <p className="ben-wb__hookapply-line" data-tone="dim">{`Kimi ${phase.applied.kimi.how ?? ''}`}</p>
          )}
          <div className="ben-wb__hookapply-btns">
            <button type="button" className="ben-wb__hookapply-btn" data-kind="primary" onClick={onClose}>知道了</button>
          </div>
        </>
      )}

      {phase.kind === 'error' && (
        <>
          <p className="ben-wb__hookapply-line" data-tone="bad" role="alert">{phase.message}</p>
          <div className="ben-wb__hookapply-btns">
            <button type="button" className="ben-wb__hookapply-btn" onClick={onClose}>关掉</button>
            {/* 一键能做的下一步(卡 R):重新看一遍。服务端那句人话就以这颗按钮收尾。 */}
            <button type="button" className="ben-wb__hookapply-btn" data-kind="primary" onClick={() => setAttempt(n => n + 1)}>再试一次</button>
          </div>
        </>
      )}
    </>
  )
}

/** 「先看一眼」那一屏:要写的几家各一段,Kimi 一句,底下一颗「一次写入」。 */
function Preview({ preview, busy, onWrite, onCancel }: {
  preview: ConnectAllPreviewView
  busy: boolean
  onWrite: () => void
  onCancel: () => void
}) {
  const writing = preview.agents.filter(row => preview.apply.includes(row.agent))
  const others = preview.agents.filter(row => !preview.apply.includes(row.agent) && row.state !== 'not_installed')
  return (
    <>
      {writing.length > 0 && (
        <p className="ben-wb__hookapply-line">
          {`工作台会往 ${writing.map(row => row.name).join('、')} 各自的配置里加几行,让它们每说完一句话就告诉工作台一声 —— 会话、额度这些才有东西可显示。`}
        </p>
      )}
      {writing.length > 0 && (
        <p className="ben-wb__hookapply-line" data-tone="dim">
          只加工作台自己的那几条;你原来配的东西一个字不动。写之前每家各另存一份,写完每家都能单独撤回。
        </p>
      )}
      {/* 文件路径与要写的内容收在「看一眼」里(2026-09-25):维护者的眼睛第 3 条「不露内部的东西(文件路径…)」;
          先看后写的"看"仍在,只是不摊在第一眼上。 */}
      {writing.map(row => (
        <div key={row.agent} className="ben-wb__hookapply-agent">
          <p className="ben-wb__hookapply-line">
            {`${row.name}:加 ${row.will?.added ?? '几'} 条${
              // 原来接过(维护者那台:旧条目指着别处)→ 说清是换掉、不会重复(卡 R)。
              (row.will?.replaced ?? 0) > 0 ? `(换掉原来那 ${row.will?.replaced} 条,不会重复)` : ''
            }${row.will?.status_line === 'kept_user' ? '(你自己配的状态栏不动)' : ''}`}
          </p>
          <details className="ben-wb__hookapply-more">
            <summary>看一眼要写什么(看不懂也没关系)</summary>
            <p className="ben-wb__hookapply-file">{shortHome(row.file)}</p>
            <pre className="ben-wb__hookapply-json" aria-label={`要写入 ${row.name} 的内容`}>{JSON.stringify(row.content, null, 2)}</pre>
          </details>
        </div>
      ))}
      {others.map(row => (
        <p key={row.agent} className="ben-wb__hookapply-line" data-tone={row.error === undefined ? 'dim' : 'bad'}>
          {row.error !== undefined ? `${row.name} 这次写不了:${row.error}` : `${row.name} 已经接上了,不用再写。`}
        </p>
      ))}
      {preview.kimi?.state === 'pending' && (
        <p className="ben-wb__hookapply-line" data-tone="dim">{`Kimi 不在这一次里:${preview.kimi.how ?? ''}`}</p>
      )}
      {writing.length === 0 && <p className="ben-wb__hookapply-line" role="status">{preview.line}</p>}
      <div className="ben-wb__hookapply-btns">
        <button type="button" className="ben-wb__hookapply-btn" onClick={onCancel}>{writing.length === 0 ? '关掉' : '取消'}</button>
        {writing.length > 0 && (
          <button type="button" className="ben-wb__hookapply-btn" data-kind="primary" disabled={busy} onClick={onWrite}>
            {busy ? '正在写…' : `一次写入(${writing.length} 家)`}
          </button>
        )}
      </div>
    </>
  )
}

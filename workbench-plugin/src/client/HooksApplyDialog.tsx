/**
 * 「点一下,工作台帮你接上」的那个小确认框(2026-09-17 Ben 拍板的第三、四条:
 * **界面上先看后写**、**能一键撤回**)。
 *
 * 四屏,一屏一件事:
 *
 *   加载中 → 先看一眼(文件路径 + 要写的内容 + 「写入」/「取消」)
 *          → 写完了(已接上 + 备份在哪 + 「要重开会话」+ 「撤回」/「知道了」)
 *          → 出错了(服务端那句人话原样摆出来 + 「关掉」)
 *
 * 文案面向不懂代码的人:整屏只出现一次 JSON(而且明说"看不懂也没关系"),
 * 其余全是"会往哪个文件里加几行、原来那份存在哪、后悔了点哪儿"。
 *
 * 类名独占 `ben-wb__hookapply*`(同 AreaUnlock 那条:`ben-wb__card` 历史上撞过名)。
 */
import { useCallback, useEffect, useState } from 'react'
import type { HooksAgent, HooksApplied, HooksPreview, HooksReverted } from './hooksApply.ts'
import { HOOKS_AGENT_NAMES, applyHooks, appliedLine, loadHooksPreview, revertHooks, revertedLine, shortHome } from './hooksApply.ts'

type Phase =
  | { kind: 'loading' }
  | { kind: 'preview', preview: HooksPreview }
  | { kind: 'writing', preview: HooksPreview }
  | { kind: 'done', preview: HooksPreview, applied: HooksApplied }
  | { kind: 'reverted', reverted: HooksReverted }
  | { kind: 'error', message: string }

export interface HooksApplyDialogProps {
  agent: HooksAgent
  baseUrl: string
  fetchImpl?: typeof fetch
  onClose: () => void
  /** 写完/撤回完调一次:看板据此立刻重问一遍 /state(不然解锁卡要等下一拍才消失)。 */
  onChanged?: () => void
}

export function HooksApplyDialog({ agent, baseUrl, fetchImpl, onClose, onChanged }: HooksApplyDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  /** 第几次去"看"。出错那一屏的「再试一次」把它加一(卡 R,同「全部接上」那个框)。 */
  const [attempt, setAttempt] = useState(0)
  const doFetch = fetchImpl ?? fetch
  const name = HOOKS_AGENT_NAMES[agent]

  // 开框就先去把"要写什么"取回来 —— 先看后写的那个"看"。
  useEffect(() => {
    let alive = true
    setPhase({ kind: 'loading' })
    void loadHooksPreview(baseUrl, agent, doFetch)
      .then((preview) => { if (alive) setPhase({ kind: 'preview', preview }) })
      .catch((error: unknown) => {
        if (alive) setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { alive = false }
  }, [agent, baseUrl, doFetch, attempt])

  const write = useCallback((preview: HooksPreview) => {
    setPhase({ kind: 'writing', preview })
    void applyHooks(baseUrl, agent, doFetch)
      .then((applied) => {
        setPhase({ kind: 'done', preview, applied })
        onChanged?.()
      })
      .catch((error: unknown) => {
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [agent, baseUrl, doFetch, onChanged])

  const undo = useCallback(() => {
    void revertHooks(baseUrl, agent, doFetch)
      .then((reverted) => {
        setPhase({ kind: 'reverted', reverted })
        onChanged?.()
      })
      .catch((error: unknown) => {
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [agent, baseUrl, doFetch, onChanged])

  return (
    <div className="ben-wb__hookapply-mask" role="dialog" aria-modal="true" aria-label={`把 ${name} 接上工作台`}>
      <div className="ben-wb__hookapply">
        <div className="ben-wb__hookapply-head">
          <span className="ben-wb__hookapply-title">{`把 ${name} 接上工作台`}</span>
          <button type="button" className="ben-wb__hookapply-x" aria-label="关掉" onClick={onClose}>×</button>
        </div>

        {phase.kind === 'loading' && <p className="ben-wb__hookapply-line">正在看这台机器该写什么…</p>}

        {(phase.kind === 'preview' || phase.kind === 'writing') && (
          <Preview
            agent={agent}
            preview={phase.preview}
            busy={phase.kind === 'writing'}
            onWrite={() => write(phase.preview)}
            onCancel={onClose}
          />
        )}

        {phase.kind === 'done' && (
          <>
            <p className="ben-wb__hookapply-line" role="status">{appliedLine(agent, phase.applied)}</p>
            <div className="ben-wb__hookapply-btns">
              <button type="button" className="ben-wb__hookapply-btn" onClick={undo}>撤回</button>
              <button type="button" className="ben-wb__hookapply-btn" data-kind="primary" onClick={onClose}>知道了</button>
            </div>
          </>
        )}

        {phase.kind === 'reverted' && (
          <>
            <p className="ben-wb__hookapply-line" role="status">{revertedLine(agent, phase.reverted)}</p>
            <div className="ben-wb__hookapply-btns">
              <button type="button" className="ben-wb__hookapply-btn" data-kind="primary" onClick={onClose}>知道了</button>
            </div>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            {/* 服务端那句人话原样摆出来 —— 它已经写得是给人看的(「备份没做成,所以这次一个字都没写」)。 */}
            <p className="ben-wb__hookapply-line" data-tone="bad" role="alert">{phase.message}</p>
            <div className="ben-wb__hookapply-btns">
              <button type="button" className="ben-wb__hookapply-btn" onClick={onClose}>关掉</button>
              {/* 一键能做的下一步(卡 R):重新看一遍。服务端那句人话就以这颗按钮收尾。 */}
              <button type="button" className="ben-wb__hookapply-btn" data-kind="primary" onClick={() => setAttempt(n => n + 1)}>再试一次</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 「先看一眼」那一屏。 */
function Preview({ agent, preview, busy, onWrite, onCancel }: {
  agent: HooksAgent
  preview: HooksPreview
  busy: boolean
  onWrite: () => void
  onCancel: () => void
}) {
  const name = HOOKS_AGENT_NAMES[agent]
  const file = preview.file
  return (
    <>
      <p className="ben-wb__hookapply-line">
        {`工作台会往 ${file === undefined ? `${name} 的配置文件` : shortHome(file)} 里加几行,让 ${name} 每说完一句话就告诉工作台一声 —— 会话区、额度这些才有东西可显示。`}
      </p>
      <p className="ben-wb__hookapply-line" data-tone="dim">
        只加工作台自己的那几条;你原来配的东西一个字不动。写之前会把原文件另存一份,后悔了点「撤回」就回去了。
      </p>
      {file !== undefined && <p className="ben-wb__hookapply-file">{file}</p>}
      <details className="ben-wb__hookapply-more">
        <summary>要写的内容(看不懂也没关系)</summary>
        <pre className="ben-wb__hookapply-json" aria-label="要写入的内容">{JSON.stringify(preview.content, null, 2)}</pre>
      </details>
      {!preview.canApply && (
        // 这台服务没接代写(老版本)。**不画一颗按不动的按钮** —— 如实说该去哪儿。
        <p className="ben-wb__hookapply-line" data-tone="bad" role="status">
          这台工作台还不会代写(版本较早)。先去「体检与修复」页照着那份内容复制一次。
        </p>
      )}
      <div className="ben-wb__hookapply-btns">
        <button type="button" className="ben-wb__hookapply-btn" onClick={onCancel}>取消</button>
        <button
          type="button"
          className="ben-wb__hookapply-btn"
          data-kind="primary"
          disabled={busy || !preview.canApply}
          onClick={onWrite}
        >
          {busy ? '正在写…' : '写入'}
        </button>
      </div>
    </>
  )
}

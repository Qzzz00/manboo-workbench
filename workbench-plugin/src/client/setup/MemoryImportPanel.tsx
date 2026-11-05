/**
 * 「把各家 Agent 的记忆拷给事务官」那一格(2026-09-22)。
 *
 * 在这之前,这件事只有两条路:电话里她问一句、或者 `curl POST /onboarding/import-memories`。
 * 而 Ben 不走命令行(docs/project-memory:用户环节不走命令行),引导又只问一次 ——
 * 于是"事后想起来要拷"这件事在界面上根本没有入口。这一格就是那个入口。
 *
 * 三条纪律,逐条对应界面上看得见的东西:
 *
 * 1. **先看见,再决定**。进来先探一眼(`GET /onboarding/memories`,只数不拷),
 *    每家一行:Claude 几份 / Codex 的 SQLite 看得见但不拷 / Kimi 未查到。
 *    **0 份写「未查到」不写「0 份记忆」** —— 那是两件事(这台机器上没有 ≠ 它没记东西)。
 * 2. **授权不到位那颗按钮按不下去**,而且旁边写清现在是哪一档、去哪放开。
 *    不做成"按下去再告诉你不行" —— 那是把一次拒绝伪装成一次操作。
 * 3. **可以重复点**。拷完显示的是**这一趟真写了哪几份**;内容一个字没变的那几份
 *    不在里面,所以第二次点会如实说「这次没有新的」,而不是再报一遍 45 份。
 *
 * 放在体检页末尾(不是设置弹窗里),与同期 `feat/diagnostics` 那张卡的体检节对齐:
 * 两边都往这一页加东西,这一格是**独立组件 + 独立一节**,合并时挪位置只动一行。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  fetchAgentMemories, importAgentMemories,
  type MemoryImportView, type MemoryProbeFamilyView, type MemoryProbeView,
} from './setupApi.ts'

/** 一家那一行右边写什么。**只翻译,不判断**:数是服务端数出来的。 */
export function familyLine(one: MemoryProbeFamilyView): string {
  const parts: string[] = []
  if (one.skip !== undefined) parts.push(one.skip)
  else if (one.count === 0) parts.push('未查到(这台电脑上没找到它记的东西)')
  else parts.push(`${one.count} 份`)
  if (one.left.length > 0) parts.push(`另有 ${one.left.length} 样看见了没拷`)
  return parts.join(' · ')
}

/** 拷完那一句。**分得开"写了几份"与"仓库里有几份"** —— 第二次点的时候这两个数不一样。 */
export function importedLine(result: MemoryImportView): string {
  if (!result.ok) return result.note
  if (result.written.length === 0) return `${result.note}(这一趟没有新的,仓库里那几份一个字节都没动)`
  const added = result.added.length
  const refreshed = result.written.length - added
  const how = [
    ...(added > 0 ? [`新增 ${added} 份`] : []),
    ...(refreshed > 0 ? [`刷新 ${refreshed} 份`] : []),
  ].join('、')
  return `${result.note}这一趟写了 ${result.written.length} 个文件(${how})。`
}

export function MemoryImportPanel({ baseUrl, fetchImpl }: {
  baseUrl: string
  fetchImpl?: typeof fetch
}) {
  const doFetch = fetchImpl ?? fetch
  const [probe, setProbe] = useState<MemoryProbeView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MemoryImportView | undefined>(undefined)

  const look = useCallback(async () => {
    setError(null)
    try { setProbe(await fetchAgentMemories(baseUrl, doFetch)) }
    catch (err) { setError(err instanceof Error ? err.message : '探不到各家的记忆') }
  }, [baseUrl, doFetch])

  useEffect(() => { void look() }, [look])

  async function copy(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const done = await importAgentMemories(baseUrl, doFetch)
      setResult(done)
      // 拷完再探一眼:这一次之后各家的数可能变了(他刚在别处改过授权也在这里露出来)。
      await look()
    }
    catch (err) { setError(err instanceof Error ? err.message : '拷不成') }
    finally { setBusy(false) }
  }

  return (
    <section className="ben-wb__setup-step" aria-label="各家 Agent 的记忆">
      <div className="ben-wb__setup-stephead">
        <span className="ben-wb__setup-steptitle">把各家 Agent 的记忆拷给事务官</span>
      </div>
      <p className="ben-wb__setup-stepsum">
        Claude、Codex、Kimi 各自记着一些关于你的东西。工作台只读它们、原样拷一份到
        docs/记忆/来自-&lt;家&gt;/,原件一个字不动。可以重复点,只补新的。
      </p>
      <div className="ben-wb__setup-items">
        {probe === undefined && error === null && <p className="ben-wb__setup-hint" role="status">在看各家有几份…</p>}
        {probe !== undefined && probe.wired && probe.families.map(one => (
          <p className="ben-wb__setup-detail" key={one.family} data-family={one.family}>
            {`${one.label}:${familyLine(one)}`}
          </p>
        ))}
        {probe !== undefined && !probe.wired && <p className="ben-wb__setup-fix">{probe.note}</p>}
        {probe !== undefined && probe.wired && (
          <div className="ben-wb__setup-item" aria-label="拷记忆">
            <div className="ben-wb__setup-itemhead">
              <span className="ben-wb__setup-itemname">{probe.allowed ? '可以拷' : `授权:${probe.status}`}</span>
              <button
                type="button"
                className="ben-wb__setup-btn"
                disabled={busy || !probe.allowed}
                onClick={() => { void copy() }}
              >
                {busy ? '拷着…' : '拷过来'}
              </button>
              <button type="button" className="ben-wb__setup-btn" disabled={busy} onClick={() => { void look() }}>
                再看一眼
              </button>
            </div>
            {/* 不是「可以」时这句话必须写清去哪放开 —— 一颗按不下去的按钮旁边只写"不行"是耍人。 */}
            <p className={probe.allowed ? 'ben-wb__setup-detail' : 'ben-wb__setup-fix'}>{probe.note}</p>
          </div>
        )}
        {result !== undefined && (
          <div className="ben-wb__setup-item" aria-label="拷的结果">
            <p className="ben-wb__setup-detail" role="status">{importedLine(result)}</p>
            {result.written.length > 0 && (
              <pre className="ben-wb__setup-tail" aria-label="写了哪几份">{result.written.join('\n')}</pre>
            )}
          </div>
        )}
        {error !== null && <p className="ben-wb__setup-fix" role="alert">{error}</p>}
      </div>
    </section>
  )
}

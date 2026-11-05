/**
 * 外层那件事的卡上「派活的眼睛」那几样(2026-09-25,卡 O;设计第 3、6 条):
 *
 * - 事务官自己在办的:**花了多少 / 上限多少**一行;
 * - 有在跑的:**「停掉这一件」**(事务官那条会话 = DSH 底层页那颗停止键;派给别家命令行的 = 杀那个进程;
 *   派进窗口的 = 不再等回答)—— 以前只能到底层 DSH 页按停止键;
 * - 到上限先停下来了:**继续 / 停掉这一件 / 换 X 来做** 三颗键(卡 M 那套外层卡接上之后,那边答也一样);
 * - 派不出去(写代码的活、Claude 命令行没登录……):**为什么** + 修法(「登录 Claude」:开它自己的登录窗口,
 *   账号密码工作台不经手)+ 能换的几家(「换 Codex 来做」;「事务官自己做」2026-09-28 拿掉了 —— 卡 BS2)。
 *
 * 数据全在 `/state` 那张卡上(`budget`、`dispatch_block`),这里只画、只发请求;回执原样说出来。
 */
import { useState } from 'react'
import type { SessionView, TaskView } from '../protocol.ts'
import { blockLine, budgetLine, pausedLine, stoppable } from './itemControlsModel.ts'

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<string> {
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const said = await res.json().catch(() => ({})) as { ok?: boolean, note?: string, error?: string }
    if (!res.ok || said.ok === false) return said.error ?? said.note ?? '没办成'
    return said.note ?? '好了'
  }
  catch { return '工作台服务没应答' }
}

export function ItemControls({ task, sessions, baseUrl, fetchImpl, desk = true }: {
  task: TaskView
  sessions: readonly SessionView[]
  baseUrl: string
  fetchImpl: typeof fetch
  /** 在这台电脑前(「登录 Claude」只有这时候画成键;该他自己去点的那一步只写一句话)。 */
  desk?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  const budget = task.budget
  const block = task.dispatch_block
  const canStop = stoppable(task, sessions)
  /*
   * 「取消事项」(2026-10-04,运营同学交回的那一版,维护者当天合入):**每一件非终态的事项**都给一颗。
   *
   * 「非终态」= 不是 `done`、不是 `canceled`(维护者原话)。走的是现成那一条改状态的路
   * `POST /task/move {status:'canceled'}` —— 状态只在那一条路上改(见 server/http.ts 那条注释,
   * 同一张七态转换表),这里不另开接口。**取消 = 收场,不是删除**:记录原样留着,
   * 事项还在「已取消」那一组里。
   */
  const canCancel = task.status !== 'done' && task.status !== 'canceled'
  if (budget === undefined && block === undefined && !canStop && !canCancel) return null

  const run = (path: string, body: unknown): void => {
    if (busy) return
    setBusy(true)
    void postJson(fetchImpl, `${baseUrl}${path}`, body).then(setReceipt).finally(() => setBusy(false))
  }
  const paused = budget?.state === 'paused'
  const fix = block?.fix
  // 卡上的备注已经说了的那一句不再念一遍(外层卡上方就是那条备注)。
  const pausedSays = pausedLine(task)
  const blockSays = blockLine(task, desk)

  return (
    <div className="ben-wb__eyes" data-testid="item-controls">
      {budget !== undefined && (
        <p className="ben-wb__eyes-budget" data-state={budget.state}>
          {budgetLine(budget)}{budget.model === undefined ? '' : ` · ${budget.model}`}
        </p>
      )}
      {pausedSays !== undefined && <p className="ben-wb__eyes-why" role="status">{pausedSays}</p>}
      {blockSays !== undefined && <p className="ben-wb__eyes-why" role="status">{blockSays}</p>}
      {fix !== undefined && desk && fix.hint !== undefined && <p className="ben-wb__eyes-hint">{fix.hint}</p>}
      <div className="ben-wb__particle-actions ben-wb__eyes-actions">
        {paused && <button type="button" disabled={busy} onClick={() => run('/butler/item/budget', { id: task.id, choice: 'continue' })}>继续</button>}
        {paused && <button type="button" disabled={busy} onClick={() => run('/butler/item/budget', { id: task.id, choice: 'stop' })}>停掉这一件</button>}
        {paused && budget?.switch_to !== undefined && (
          <button type="button" disabled={busy} onClick={() => run('/butler/item/budget', { id: task.id, choice: 'switch' })}>{`换 ${budget.switch_to} 来做`}</button>
        )}
        {canStop && <button type="button" className="ben-wb__eyes-stop" disabled={busy} onClick={() => run('/butler/item/stop', { id: task.id })}>停掉这一件</button>}
        {/* 不给它自己的配色(维护者 10-04:不要他那个红色调,也不要紫)——用这一排按钮现成那一套。 */}
        {canCancel && (
          <button type="button" disabled={busy} title="取消后保留记录，不再计入当前状态" onClick={() => run('/task/move', { id: task.id, status: 'canceled' })}>
            取消事项
          </button>
        )}
        {fix !== undefined && desk && fix.kind === 'login_cli' && (
          <button type="button" disabled={busy} onClick={() => run('/agents/login', { family: fix.family })}>{fix.label}</button>
        )}
        {(block?.alternatives ?? []).map(one => (
          <button
            type="button"
            key={one.family}
            disabled={busy}
            title={one.note}
            onClick={() => run('/dispatch/run', { item_id: task.id, app: one.family, kind: block?.kind })}
          >
            {/* 接不上的那一家先放着,给他「先交给 X 做」(统筹 09-25 设计原则)。
                「事务官自己做」那一颗 2026-09-28 拿掉了(卡 BS2、设计 C1):事务官不干活。 */}
            {`先交给 ${one.title} 做`}
          </button>
        ))}
      </div>
      {receipt !== undefined && <p className="ben-wb__eyes-hint" role="status">{receipt}</p>}
    </div>
  )
}

/**
 * 卡片弹窗里「现在到哪」那一块(2026-09-25,卡 N;设计第一节第 2、5 条)。
 *
 * 维护者:「感觉事务官对于现在实现的进展是来自我的描述,没有来自自己扫描或者确认的进度」—— 这一块只说**证据**:
 * 现在到哪 · 依据(出处 + 时刻 + 逐字那一句)· 什么时候看的。口述对不上写出来;没看到进展就照实说、请他说一句。
 * 依据只写出处与时刻,**都是人话**(「Codex 里「制作参赛网页」那段对话 · 昨天 20:17」):文件名、路径、提交号不出现
 *(在服务端 `ref` 里,给查的人用,不给他看)。没看到进展时多说一句「我在哪儿找过」(`progressNoneHint`,照实说)。
 *
 * 三颗按钮都是**可选**的:没接线的地方(手机那份精简看板、既有用例)那一颗不画 —— 一颗点了没反应的按钮比没有更坏(D13)。
 * - 「现在核一次」:当场按证据重判这一张;
 * - 「派给 X」/「交给事务官」:**先摆出那一问**「这张派给 X 开工?现在:…」(与外层卡、手机同一句,protocol.ts `dispatchAskText`),
 *   他点「派」才真派(负责人驱动的 driveNow;派之前服务端照样先按证据核)—— 统筹:「真派活前要有确认,手机和电脑同一套」;
 * - 「说一句」:证据里没有或对不上时,他说一句到哪了(记成口述证据,再核一次;「不做了」「做完了」会挪卡)。
 */
import { useState } from 'react'
import type { TaskView } from '../protocol.ts'
import { ASSIGNEE_NAMES, PROGRESS_NONE_LINE, dispatchAskText, driveLabel, friendlyWhen, progressNoneHint } from '../protocol.ts'

export interface ProgressActions {
  /** 当场按证据重判这一张。回一句给他看的回执。 */
  check?: (id: string) => Promise<string>
  /** 他说一句到哪了。 */
  say?: (id: string, text: string) => Promise<string>
  /** 派给负责人那一家 / 交给事务官(他点的这一下就是点头)。 */
  drive?: (id: string) => Promise<string>
}

export function ProgressBlock({ task, actions, now }: {
  task: TaskView
  actions?: ProgressActions | undefined
  /** /state.now:「今天 / 昨天」按它算(同一屏上两处不差一拍)。缺席按本机时钟。 */
  now?: string | undefined
}) {
  const [busy, setBusy] = useState<'check' | 'say' | 'drive' | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  const [said, setSaid] = useState('')
  /** 点了「派给 X」:先摆出那一问,等他点「派」。 */
  const [confirming, setConfirming] = useState(false)
  const progress = task.progress
  const mover = task.mover
  const drive = actions?.drive === undefined ? undefined : driveLabel(task)
  if (progress === undefined && mover === undefined && actions === undefined) return null

  const act = (kind: 'check' | 'say' | 'drive', job: () => Promise<string>): void => {
    setBusy(kind)
    setReceipt(undefined)
    void job()
      .then(text => setReceipt(text))
      .catch(() => setReceipt('工作台服务没应答,稍后再试'))
      .finally(() => setBusy(undefined))
  }
  const askSay = actions?.say !== undefined && (progress === undefined || progress.state !== 'found')

  return (
    <section className="ben-wb__item-progress" aria-label="现在到哪">
      <h4>现在到哪</h4>
      {mover !== undefined && mover.who !== 'none' && (
        <p className="ben-wb__item-mover">现在该谁动:{mover.line}</p>
      )}
      {progress === undefined
        ? <p className="ben-wb__item-line" data-state="none">还没看过这件事做到哪了</p>
        : (
            <>
              <p className="ben-wb__item-line" data-state={progress.state}>{progress.line}</p>
              {/* 没看到进展:补一句我在哪儿找过(照实说:这一轮没看各家的对话就不说看过)。 */}
              {progress.state === 'none' && <p className="ben-wb__item-when">{progressNoneHint(progress)}</p>}
              {progress.state === 'mismatch' && progress.mismatch !== undefined && (
                <p className="ben-wb__item-mismatch">和卡上写的对不上:{progress.mismatch}</p>
              )}
              {progress.basis.length > 0 && (
                <ul className="ben-wb__item-basis" aria-label="依据">
                  {progress.basis.map((one, index) => {
                    const at = friendlyWhen(one.at, now)
                    return (
                      <li key={`${one.kind}:${one.ref ?? one.source}:${index}`}>
                        依据:{one.source}{at === '' ? '' : ` · ${at}`}
                        {one.quote !== undefined && <> · <q>{one.quote}</q></>}
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="ben-wb__item-when">{friendlyWhen(progress.checked_at, now)} 看的</p>
            </>
          )}

      {(actions?.check !== undefined || drive !== undefined) && (
        <div className="ben-wb__item-acts">
          {drive !== undefined && actions?.drive !== undefined && !confirming && (
            <button
              type="button"
              data-primary="true"
              disabled={busy !== undefined}
              title={task.assignee === 'dsh' ? '交给事务官办(交之前我先看一眼它现在到哪)' : `派给 ${ASSIGNEE_NAMES[task.assignee ?? 'dsh']}(派之前我先看一眼它现在到哪,交代的话照看到的写)`}
              onClick={() => setConfirming(true)}
            >
              {busy === 'drive' ? '在派…' : drive}
            </button>
          )}
          {actions?.check !== undefined && (
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => act('check', () => (actions.check as (id: string) => Promise<string>)(task.id))}
            >
              {busy === 'check' ? '在核…' : '现在核一次'}
            </button>
          )}
        </div>
      )}

      {confirming && actions?.drive !== undefined && (
        <div className="ben-wb__item-confirm" role="group" aria-label="派活确认">
          <p>{dispatchAskText(task.assignee, task.progress, undefined, now ?? Date.now())}</p>
          <div className="ben-wb__item-acts">
            <button
              type="button"
              data-primary="true"
              disabled={busy !== undefined}
              onClick={() => {
                setConfirming(false)
                const drive = actions.drive as (id: string) => Promise<string>
                act('drive', () => drive(task.id))
              }}
            >
              {task.assignee === 'dsh' ? '交给她' : '派'}
            </button>
            <button type="button" onClick={() => setConfirming(false)}>先不派</button>
          </div>
        </div>
      )}

      {askSay && (
        <form
          className="ben-wb__item-say"
          onSubmit={(event) => {
            event.preventDefault()
            const text = said.trim()
            if (text === '' || actions?.say === undefined) return
            const say = actions.say
            act('say', async () => {
              const note = await say(task.id, text)
              setSaid('')
              return note
            })
          }}
        >
          <input
            type="text"
            aria-label="说一句到哪了"
            placeholder={progress?.line === PROGRESS_NONE_LINE || progress === undefined ? '说一句到哪了(比如:域名昨天注册好了)' : '说一句哪边对(比如:卡上写的是旧的)'}
            value={said}
            onChange={event => setSaid(event.target.value)}
          />
          <button type="submit" disabled={busy !== undefined || said.trim() === ''}>{busy === 'say' ? '在记…' : '记下'}</button>
        </form>
      )}

      {receipt !== undefined && <p className="ben-wb__item-when" role="status">{receipt}</p>}
    </section>
  )
}

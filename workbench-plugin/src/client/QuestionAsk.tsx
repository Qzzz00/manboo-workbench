/**
 * 事务官在 DSH 会话里问你的一件事 —— 摆在球下那一区(2026-09-25,卡 M;维护者点名的 bug)。
 *
 * 维护者:「对于用户来说,不应该漏出来这个底层,选项应该直接在外层事务官那里显示」。以前这一问只在 DSH 原始界面的
 * 提问面板里有(「派活前对一遍」+ 三个选项 + Type your answer / Skip this question / Submit),工作台与手机上都看不到。
 *
 * 这里:她的话原样(记号服务端已经去掉)+ 选项按钮 + 「我自己说」。只有一问、单选时点一个选项就交;
 * 多问或多选时点好了按「回复」。答完那一问从电脑与手机上同时消失(/state 里没了),她接着干。
 *
 * 三种摆法:`card` 球下整张;`row` 收成一行(「「…」问你:派活前对一遍 · 展开」);`inline` 摆在事项里那一段(不重复「「…」问你」那一行)。
 */
import { useState } from 'react'
import type { PendingQuestionItemView, PendingQuestionView, QuestionAnswerItem } from '../protocol.ts'
import { askSubject, questionRowText } from './askModel.ts'
import { answerQuestion } from './askApi.ts'

export interface QuestionAskProps {
  question: PendingQuestionView
  baseUrl: string
  fetchImpl: typeof fetch
  variant?: 'card' | 'row' | 'inline'
  /** 一行里的「展开」。 */
  onExpand?: () => void
  /** 交上去之后 / 没交上去时那一句。 */
  onReceipt?: (text: string) => void
}

export function QuestionAsk({ question, baseUrl, fetchImpl, variant = 'card', onExpand, onReceipt }: QuestionAskProps) {
  const [picked, setPicked] = useState<Record<string, readonly string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  if (variant === 'row') {
    return (
      <>
        <span className="ben-wb__askrow-text">{questionRowText(question)}</span>
        {onExpand !== undefined && <button type="button" className="ben-wb__laid-link ben-wb__askrow-open" onClick={onExpand}>展开</button>}
      </>
    )
  }

  const items = question.questions
  const quick = items.length === 1 && items[0]?.multi === false
  const submit = (answers: readonly QuestionAnswerItem[]): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void answerQuestion(baseUrl, fetchImpl, question.id, answers).then((failed) => {
      setBusy(false)
      if (failed !== undefined) { setError(failed); onReceipt?.(failed); return }
      onReceipt?.('答上了,接着办')
    })
  }
  const choose = (item: PendingQuestionItemView, label: string): void => {
    if (quick) { submit([{ id: item.id, selected: [label] }]); return }
    setPicked((prev) => {
      const now = prev[item.id] ?? []
      const next = item.multi ? (now.includes(label) ? now.filter(one => one !== label) : [...now, label]) : [label]
      return { ...prev, [item.id]: next }
    })
  }
  const collected = (): QuestionAnswerItem[] => items.map((item) => {
    const said = (custom[item.id] ?? '').trim()
    return { id: item.id, selected: said !== '' && !item.multi ? [] : [...(picked[item.id] ?? [])], ...(said === '' ? {} : { custom: said }) }
  })
  const ready = collected().some(one => one.selected.length > 0 || one.custom !== undefined)

  return (
    <div className="ben-wb__qask" data-variant={variant} role="group" aria-label={`${askSubject(question.task_title)}问你`}>
      {variant === 'card' && (
        <p className="ben-wb__qask-head">
          <span>{askSubject(question.task_title, 24)}问你</span>
          {items[0]?.header !== undefined && <><span aria-hidden="true"> · </span><strong>{items[0].header}</strong></>}
        </p>
      )}
      {items.map((item, index) => (
        <div key={item.id} className="ben-wb__qask-item">
          {(variant === 'inline' || index > 0) && item.header !== undefined && <p className="ben-wb__qask-sub">{item.header}</p>}
          <p className="ben-wb__qask-say">{item.question}</p>
          {item.detail !== undefined && <p className="ben-wb__qask-detail">{item.detail}</p>}
          {item.options.length > 0 && (
            <div className="ben-wb__qask-options" role={item.multi ? 'group' : 'radiogroup'} aria-label="选一个">
              {item.options.map(option => (
                <button
                  key={option.label}
                  type="button"
                  className="ben-wb__qask-option"
                  disabled={busy}
                  aria-pressed={(picked[item.id] ?? []).includes(option.label)}
                  data-on={(picked[item.id] ?? []).includes(option.label)}
                  onClick={() => choose(item, option.label)}
                >
                  <span className="ben-wb__qask-option-text">{option.text}</span>
                  {option.note !== undefined && <span className="ben-wb__qask-option-note">{option.note}</span>}
                </button>
              ))}
            </div>
          )}
          <div className="ben-wb__qask-own">
            <input
              type="text"
              aria-label="我自己说"
              placeholder="我自己说:不照上面几个,直接写一句"
              value={custom[item.id] ?? ''}
              disabled={busy}
              onChange={(event) => { const value = event.target.value; setCustom(prev => ({ ...prev, [item.id]: value })) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (collected().some(one => one.selected.length > 0 || one.custom !== undefined)) submit(collected())
              }}
            />
            {/* 「我自己说」这一行电脑与手机一模一样(卡 M 补,统筹真壳:「手机上那一问没有『我自己说』」):
                同一句提示、「回复」一直摆着(没写字时是灰的),一眼看得出这里能自己写。 */}
            {index === items.length - 1 && (
              <button type="button" className="ben-wb__qask-send" disabled={busy || !ready} onClick={() => submit(collected())}>回复</button>
            )}
          </div>
        </div>
      ))}
      {error !== undefined && <p className="ben-wb__qask-err" role="alert">{error}</p>}
    </div>
  )
}

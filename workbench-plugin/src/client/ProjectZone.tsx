/**
 * 项目区（v5 spec D1–D4：算/状态/零散/DDL 四层）。
 *
 * 纯展示 + 受控交互——expandedId/onToggle 由父组件（Workbench.tsx）持有，这里不自己
 * 记"哪行展开着"。状态行的编辑草稿是本组件内部的临时态，提交后不本地乐观更新（不
 * 改 row 上显示的文案），真相以服务端下一拍轮询回来的快照为准——跟 markRead 同一套
 * "失败静默、真相以服务端为准"的规矩（sessionFeed.ts markRead 的写法）。
 */
import { useState } from 'react'
import type { ProjectRow } from './portfolio.ts'

export interface ProjectZoneProps {
  rows: readonly ProjectRow[]
  /** 扫到而他没确认过的仓库(2026-09-25)。收在末尾「其他仓库(N)」里,点开才看。缺省 = 没有。 */
  otherRows?: readonly ProjectRow[]
  idleText: string
  pendingText: string
  scanErrorTexts: readonly string[]
  /** 项目区没去看目录的那句话(2026-09-23)。缺席或空串不画。 */
  blockedText?: string
  expandedId: string | null
  onToggle: (id: string) => void
  onConfirmStatus: (id: string, text: string) => void
}

/** 状态行：常显时可点进入编辑，编辑态是纯本地草稿，确认后交给父组件去发请求。 */
function ProjectStatusRow({ row, onConfirm }: {
  row: ProjectRow
  onConfirm: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.statusText ?? '')

  if (editing) {
    return (
      <form
        className="ben-wb__pj-status-edit"
        onSubmit={(event) => {
          event.preventDefault()
          const text = draft.trim()
          if (text !== '') onConfirm(text)
          setEditing(false)
        }}
      >
        <input
          className="ben-wb__inp"
          aria-label={`编辑状态:${row.name}`}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          autoFocus
        />
        <button type="submit" className="ben-wb__pj-confirm">确认</button>
      </form>
    )
  }

  return (
    <button
      type="button"
      className={`ben-wb__pj-status${row.statusStale ? ' ben-wb__pj-status--stale' : ''}`}
      onClick={() => {
        setDraft(row.statusText ?? '')
        setEditing(true)
      }}
    >
      <span>{row.statusText ?? '未写状态'}</span>
      {row.statusMeta !== undefined && <span className="ben-wb__pj-status-meta">{row.statusMeta}</span>}
      {row.statusStale && <span className="ben-wb__pj-status-meta">待日结确认</span>}
    </button>
  )
}

function ProjectRowItem({ row, expanded, onToggle, onConfirmStatus }: {
  row: ProjectRow
  expanded: boolean
  onToggle: () => void
  onConfirmStatus: (text: string) => void
}) {
  return (
    <article className="ben-wb__pj" data-tone={row.tone}>
      <button type="button" className="ben-wb__pj-head" aria-expanded={expanded} onClick={onToggle}>
        <h2 className="ben-wb__pj-name">{row.name}</h2>
        <span className="ben-wb__pj-stage">{row.stage}</span>
        {/* 排期风险(2026-09-09):等级 + 预计完成日常显在项目行上。**只陈述,不催**——
            依据(速度口径、剩几条、余几天)在 title 里,鼠标停上去才看得到。 */}
        {row.riskText !== undefined && (
          <span
            className="ben-wb__pj-risk"
            data-risk={row.riskLevel}
            title={row.riskTitle}
            aria-label={`排期风险:${row.riskText}`}
          >
            {row.riskText}
          </span>
        )}
      </button>

      <ProjectStatusRow row={row} onConfirm={onConfirmStatus} />

      {row.activityText !== '' && <p className="ben-wb__pj-activity">{row.activityText}</p>}
      {row.signalText !== '' && (
        <p className={`ben-wb__pj-calc${row.signalError ? ' ben-wb__pj-calc--error' : ''}`}>
          {row.signalText}
        </p>
      )}

      {expanded && (
        <div className="ben-wb__pj-extra">
          {/* 数据源自己多说的那几行(2026-09-21)。git 那一支恒为空,所以做产品模板下
              这里一行都不多;账号那一支是「定位 / 风格 / 人群 / 平台 / 开号日期」。
              **没写的那几项不出现** —— 摆一行「定位:—」看起来像"说过、只是没内容"。 */}
          {row.detailLines.map(line => (
            <p className="ben-wb__pj-detail" key={line.label}>{line.label}:{line.text}</p>
          ))}
          <p>零散:{row.fragmentsText !== '' ? row.fragmentsText : '暂无'}</p>
          <p>DDL:{row.ddlText ?? '暂无'}</p>
        </div>
      )}
    </article>
  )
}

/** 「其他仓库(N)」那一格叫什么。看板页签那一格用同一句(TaskBoard.tsx)。 */
export function otherReposLabel(count: number): string {
  return `其他仓库(${count})`
}

export function ProjectZone({
  rows, otherRows = [], idleText, pendingText, scanErrorTexts, blockedText, expandedId, onToggle, onConfirmStatus,
}: ProjectZoneProps) {
  const others = otherRows.length + (idleText === '' ? 0 : idleText.split(' · ').length)
  return (
    <div className="ben-wb__scroll">
      {/* 2026-09-23:没授权 / 引导没做完时项目区不看他的目录,这里如实说一句,不摆一片空白冒充「没有项目」。 */}
      {blockedText !== undefined && blockedText !== '' && <p className="ben-wb__lines" data-blocked="true">{blockedText}</p>}
      {scanErrorTexts.map(text => (
        <p className="ben-wb__pj-scanerr" key={text}>{text}</p>
      ))}

      {rows.map(row => (
        <ProjectRowItem
          key={row.id}
          row={row}
          expanded={expandedId === row.id}
          onToggle={() => onToggle(row.id)}
          onConfirmStatus={text => onConfirmStatus(row.id, text)}
        />
      ))}

      {/* 扫到而他没确认过的仓库(2026-09-25):不再与他的项目排在一起,收进这一格,点开才看。闲置那一行也在里面。 */}
      {others > 0 && (
        <details className="ben-wb__pj-others">
          <summary>{otherReposLabel(others)}</summary>
          {otherRows.map(row => (
            <ProjectRowItem
              key={row.id}
              row={row}
              expanded={expandedId === row.id}
              onToggle={() => onToggle(row.id)}
              onConfirmStatus={text => onConfirmStatus(row.id, text)}
            />
          ))}
          {idleText !== '' && <p className="ben-wb__lines">{idleText}</p>}
        </details>
      )}
      {pendingText !== '0 组 / 0 条' && <p className="ben-wb__pj-pending">待归档:{pendingText}</p>}
    </div>
  )
}

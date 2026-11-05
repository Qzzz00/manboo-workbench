/**
 * 协作区真实进展可读摘要组件 (2026-10-23 卡 D1 第一段)。
 *
 * 位于协作区顶部，固定在滚动区上方。
 * 让维护者直接看清所选目标/冲刺/筛选范围里哪些完成、哪些待做、哪些受阻和交回待验，
 * 点击展开清单并定位原事项。
 */
import { useMemo, useState } from 'react'
import type {
  CollabGoal,
  CollabPresence,
  CollabSprint,
  SessionView,
  RunSegment,
  TaskView,
} from '../../protocol.ts'
import { Icon } from '../ui/icons.tsx'
import type {
  ExecutionTruth,
  ProgressFilter,
  ProgressSummaryModel,
  TaskProgressDetail,
} from './progressModel.ts'
import {
  EXECUTION_TRUTH_TITLES,
  summarizeProgress,
} from './progressModel.ts'

export type SummaryTab = ExecutionTruth | 'remaining' | 'conditions'

export interface ProgressSummaryProps {
  runs?: readonly RunSegment[] | undefined
  tasks: readonly TaskView[]
  goals?: readonly CollabGoal[] | undefined
  sprints?: readonly CollabSprint[] | undefined
  filter?: ProgressFilter | undefined
  presence?: readonly CollabPresence[] | undefined
  sessions?: readonly SessionView[] | undefined
  serverNow?: string | undefined
  nowMs?: number | undefined
  nameOfAssignee?: ((id?: string) => string) | undefined
  onOpenTask?: ((task: TaskView) => void) | undefined
  onFlyToNote?: ((id: string) => void) | undefined
}

export function ProgressSummary({
  tasks,
  runs,
  goals = [],
  sprints = [],
  filter = {},
  presence,
  sessions,
  serverNow,
  nowMs,
  nameOfAssignee,
  onOpenTask,
  onFlyToNote,
}: ProgressSummaryProps) {
  const [activeTab, setActiveTab] = useState<SummaryTab | undefined>(undefined)

  const summary: ProgressSummaryModel = useMemo(() => summarizeProgress({
    tasks,
    runs,
    goals,
    sprints,
    filter,
    presence,
    sessions,
    serverNow,
    nowMs,
    nameOfAssignee,
  }), [tasks, runs, goals, sprints, filter, presence, sessions, serverNow, nowMs, nameOfAssignee])

  const toggleTab = (tab: SummaryTab) => {
    setActiveTab(prev => (prev === tab ? undefined : tab))
  }

  // 计算当前展开面板中要展示的条目
  const currentItems = useMemo((): TaskProgressDetail[] => {
    if (!activeTab || activeTab === 'conditions') return []
    if (activeTab === 'remaining') return summary.remainingList
    if (activeTab === 'waiting_receipt') {
      return [
        ...summary.groups.waiting_receipt,
        ...summary.groups.dispatched_queued,
        ...summary.groups.turn_ended,
      ]
    }
    return summary.groups[activeTab] ?? []
  }, [activeTab, summary])

  const activeTitle = useMemo(() => {
    if (!activeTab) return ''
    if (activeTab === 'remaining') return `本轮剩余工作 (${summary.counts.remaining} 件)`
    if (activeTab === 'conditions') {
      return `事项验收要求清单 (${summary.capabilityConditions.length} 条)`
    }
    return `${EXECUTION_TRUTH_TITLES[activeTab]} (${currentItems.length} 项)`
  }, [activeTab, summary, currentItems, filter])

  return (
    <section className="ben-cl__progress-summary" aria-label="进展可读摘要">
      {/* 顶部条：统计范围说明、快照状态与各状态分布芯片 */}
      <div className="ben-cl__ps-bar">
        <div className="ben-cl__ps-scope">
          <span className="ben-cl__ps-scope-title">{summary.scopeName}</span>
          <span className="ben-cl__ps-scope-count">共 {summary.counts.totalProduction} 项生产工作</span>
          {summary.parentGroupTasks.length > 0 && (
            <span className="ben-cl__ps-dedup-tag">
              （含 {summary.parentGroupTasks.length} 个任务组，已去重不重复计数）
            </span>
          )}
          {summary.demoCount > 0 && (
            <span className="ben-cl__ps-demo-tag">
              （已隔离 {summary.demoCount} 件演示数据）
            </span>
          )}
          {summary.snapshotStale && (
            <span className="ben-cl__ps-stale-tag" title="快照可能已落后当前时间">
              快照更新于 {summary.snapshotTimeText}（可能已陈旧）
            </span>
          )}
        </div>

        <div className="ben-cl__ps-chips" role="group" aria-label="进展状态分布">
          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'remaining'}
            aria-pressed={activeTab === 'remaining'}
            onClick={() => toggleTab('remaining')}
          >
            本轮剩余 <strong>{summary.counts.remaining}</strong> 件
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'delivered'}
            data-truth="delivered"
            aria-pressed={activeTab === 'delivered'}
            onClick={() => toggleTab('delivered')}
          >
            当前可用 <strong>{summary.counts.delivered}</strong> 项
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'accepted'}
            data-truth="accepted"
            aria-pressed={activeTab === 'accepted'}
            onClick={() => toggleTab('accepted')}
          >
            已验收待交付 <strong>{summary.counts.accepted}</strong> 项
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'review'}
            data-truth="review"
            aria-pressed={activeTab === 'review'}
            onClick={() => toggleTab('review')}
          >
            交回待验 <strong>{summary.counts.review}</strong> 项
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'running'}
            data-truth="running"
            aria-pressed={activeTab === 'running'}
            onClick={() => toggleTab('running')}
          >
            真实执行中 <strong>{summary.counts.running}</strong> 项
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'waiting_receipt'}
            data-truth="waiting_receipt"
            aria-pressed={activeTab === 'waiting_receipt'}
            onClick={() => toggleTab('waiting_receipt')}
            title="账面在做但缺实时运行证据、或处于派活排队/回合结束"
          >
            待执行回执 <strong>{summary.counts.waiting_receipt}</strong> 项
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'unstarted'}
            data-truth="unstarted"
            aria-pressed={activeTab === 'unstarted'}
            onClick={() => toggleTab('unstarted')}
          >
            未开始 <strong>{summary.counts.unstarted}</strong> 项
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'blocked'}
            data-truth="blocked"
            aria-pressed={activeTab === 'blocked'}
            onClick={() => toggleTab('blocked')}
          >
            受阻 <strong>{summary.counts.blocked}</strong> 项
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'canceled'}
            data-truth="canceled"
            aria-pressed={activeTab === 'canceled'}
            onClick={() => toggleTab('canceled')}
            title="已取消事项单列，不计入达成或剩余"
          >
            已取消 <strong>{summary.counts.canceled}</strong> 项
          </button>

          <button
            type="button"
            className="ben-cl__ps-chip"
            data-active={activeTab === 'conditions'}
            aria-pressed={activeTab === 'conditions'}
            onClick={() => toggleTab('conditions')}
            title="查看当前事项填写的验收要求,目标能力条件见各目标的「条件」"
          >
            事项验收要求 <strong>{summary.capabilityConditions.length}</strong> 条
          </button>
        </div>
      </div>

      {/* 展开的明细抽屉/面板 */}
      {activeTab !== undefined && (
        <div className="ben-cl__ps-drawer" role="region" aria-label="进展清单明细">
          <div className="ben-cl__ps-drawer-head">
            <h3 className="ben-cl__ps-drawer-title">{activeTitle}</h3>
            <button
              type="button"
              className="ben-cl__ps-close"
              aria-label="收起清单"
              onClick={() => setActiveTab(undefined)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <div className="ben-cl__ps-drawer-body">
            {activeTab === 'conditions' ? (
              summary.capabilityConditions.length === 0 ? (
                <p className="ben-cl__muted">当前范围内暂无事项验收要求。</p>
              ) : (
                <ul className="ben-cl__ps-cond-list" aria-label="事项验收要求（目标能力条件另见目标条件面板）">
                  {summary.capabilityConditions.map((cond) => (
                    <li key={cond.id} className="ben-cl__ps-cond-item">
                      <div className="ben-cl__ps-cond-main">
                        <span className="ben-cl__ps-cond-text">{cond.text}</span>
                        {cond.unassigned && (
                          <small className="ben-cl__ps-tag ben-cl__ps-tag--warn">尚未安排</small>
                        )}
                        {cond.evidence && cond.evidence.length > 0 && (
                          <div className="ben-cl__ps-evidence">
                            凭据: {cond.evidence.join('、')}
                          </div>
                        )}
                      </div>
                      <div className="ben-cl__ps-cond-side">
                        <span className="ben-cl__ps-badge" data-truth={cond.status}>{cond.statusLabel}</span>
                        <button
                          type="button"
                          className="ben-cl__ps-link-btn"
                          onClick={() => {
                            onFlyToNote?.(cond.taskId)
                            const t = tasks.find(one => one.id === cond.taskId)
                            if (t) onOpenTask?.(t)
                          }}
                          aria-label={`定位事项: ${cond.taskTitle}`}
                        >
                          {cond.taskTitle}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : currentItems.length === 0 ? (
              <p className="ben-cl__muted">该分类下暂无任务。</p>
            ) : (
              <div className="ben-cl__ps-task-list">
                {currentItems.map((item) => (
                  <article key={item.task.id} className="ben-cl__ps-item" data-truth={item.truth}>
                    <div className="ben-cl__ps-item-head">
                      <button
                        type="button"
                        className="ben-cl__ps-item-title"
                        onClick={() => {
                          onFlyToNote?.(item.task.id)
                          onOpenTask?.(item.task)
                        }}
                        aria-label={`定位: ${item.task.title}`}
                      >
                        {item.task.title}
                      </button>
                      <span className="ben-cl__ps-badge" data-truth={item.truth}>{item.truthLabel}</span>
                    </div>

                    <div className="ben-cl__ps-item-meta">
                      <span className="ben-cl__ps-assignee">负责人: {item.assigneeText}</span>
                      <span className="ben-cl__ps-time">最近记录: {item.lastRecordFormatted}</span>
                      {item.waitReason && (
                        <span className="ben-cl__ps-wait">等待/原因: {item.waitReason}</span>
                      )}
                      {item.nextMover && (
                        <span className="ben-cl__ps-mover">下一步: {item.nextMover}</span>
                      )}
                    </div>

                    {item.acceptanceConditions.length > 0 ? (
                      <div className="ben-cl__ps-item-checks">
                        <small className="ben-cl__ps-check-label">做到什么算完：</small>
                        <ul>
                          {item.acceptanceConditions.map((cond, i) => (
                            <li key={i}>{cond}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="ben-cl__ps-item-checks ben-cl__muted">
                        未声明做到什么算完（尚未安排）
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

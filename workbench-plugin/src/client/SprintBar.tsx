/**
 * 冲刺条:当前项目下的冲刺切换 + 冲刺目标 + 组成版本号 + 起止 + 进度。
 *
 * Ben 的原话:"Sprint 的要写清楚冲刺目标是什么,由哪些模块组成,这些模块分别对应的
 * 目标是什么,包含哪些功能点"。模块和功能点在下面的泳道里,这条负责前半句——
 * 目标与版本号必须**常显**,不能藏进某个要点开的抽屉:一批卡到底为了什么、算哪个
 * 版本,是看板每次打开都要回答的问题。
 *
 * 没写目标时如实显示「还没写冲刺目标」并给个入口,不替他编一句(D13 的老规矩)。
 */
import { useState } from 'react'
import type { SprintVersion, SprintView } from '../protocol.ts'
import { scheduleRiskText } from '../protocol.ts'
import { Meter } from './Meter.tsx'
import { timeProgress } from './boardModel.ts'

export interface SprintPatch {
  name?: string
  goal?: string | null
  versions?: readonly SprintVersion[]
  startsAt?: string | null
  endsAt?: string | null
}

export function SprintBar({ sprints, currentId, progress, attention, nowMs, onSelect, onCreate, onUpdate, onDelete }: {
  sprints: readonly SprintView[]
  currentId: string | undefined
  progress: { done: number, total: number }
  /**
   * 「现在有几件在等我动手」(2026-09-09 七态):等我确认几条、阻塞几条。
   * 常显在冲刺条上——这两列是唯二需要 Ben 本人做点什么的,让他挨列去数没道理。
   */
  attention: { confirm: number, blocked: number }
  nowMs: number
  onSelect: (id: string) => void
  onCreate: (name: string) => void
  onUpdate: (id: string, patch: SprintPatch) => void
  onDelete: (id: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const current = sprints.find(sprint => sprint.id === currentId)

  return (
    <div className="ben-wb__sprint">
      <div className="ben-wb__sprint-tabs" role="group" aria-label="冲刺">
        {sprints.map(sprint => (
          <button
            key={sprint.id}
            type="button"
            data-on={sprint.id === currentId}
            aria-pressed={sprint.id === currentId}
            onClick={() => onSelect(sprint.id)}
          >
            {sprint.name}
          </button>
        ))}
        {adding
          ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (newName.trim() === '') return
                  onCreate(newName.trim())
                  setNewName('')
                  setAdding(false)
                }}
              >
                <input
                  type="text"
                  aria-label="新冲刺的名字"
                  placeholder="冲刺一…"
                  value={newName}
                  onChange={event => setNewName(event.target.value)}
                />
              </form>
            )
          : <button type="button" className="ben-wb__sprint-add" onClick={() => setAdding(true)}>＋ 新冲刺</button>}
      </div>

      {current === undefined
        ? (
            <p className="ben-wb__sprint-empty">
              {sprints.length === 0
                ? '这个项目还没有冲刺。先建一个,再往里放模块和功能点。'
                : '选一个冲刺'}
            </p>
          )
        : (
            <div className="ben-wb__sprint-head">
              <div className="ben-wb__sprint-goal">
                <span className="ben-wb__sprint-tag">冲刺目标</span>
                {current.goal === undefined || current.goal === ''
                  ? <em className="ben-wb__sprint-blank">还没写冲刺目标</em>
                  : <span>{current.goal}</span>}
              </div>

              <div className="ben-wb__sprint-vers">
                <span className="ben-wb__sprint-tag">组成版本</span>
                {current.versions.length === 0
                  ? <em className="ben-wb__sprint-blank">还没填版本号</em>
                  : current.versions.map(version => (
                      <span className="ben-wb__sprint-ver" key={`${version.label}:${version.version}`}>
                        {version.label} {version.version}
                      </span>
                    ))}
              </div>

              {(current.starts_at !== undefined || current.ends_at !== undefined) && (
                <span className="ben-wb__sprint-when" title={`${current.starts_at ?? '—'} → ${current.ends_at ?? '—'}`}>
                  {/* 时间进度用中性色的条:它不是成绩,别让它看起来像"完成度很高"。
                      两头缺一个日期就没有进度可言,那时只显示日期本身,不画一根假条。 */}
                  {(() => {
                    const passed = timeProgress(current.starts_at, current.ends_at, nowMs)
                    return passed === undefined
                      ? <span>{current.starts_at ?? '—'} → {current.ends_at ?? '—'}</span>
                      : <Meter done={passed} total={100} tone="time" label={`时间 ${passed}%`} />
                  })()}
                </span>
              )}

              {/* 排期风险(2026-09-09):本冲刺按当前速度赶不赶得上 ends_at。
                  **和项目行同一口径、同一句话**(protocol.scheduleRiskText),只是范围换成
                  本冲刺的卡。服务端算不出(没排结束日)时整块不出现,不摆一个空壳。 */}
              {current.risk !== undefined && (
                <span
                  className="ben-wb__sprint-risk"
                  data-risk={current.risk.level}
                  title={current.risk.reason}
                  aria-label={`本冲刺排期风险:${scheduleRiskText(current.risk)}`}
                >
                  {scheduleRiskText(current.risk)}
                </span>
              )}

              {/* 进度是**纯计数**:几条完成 / 共几条。不算"落后多少天"、不给任何评价——
                  "落后"是一句判断,而这块界面只被允许陈述事实(不可改清单第 5 条延伸)。 */}
              <span className="ben-wb__sprint-prog" aria-label="本冲刺进度">
                <Meter done={progress.done} total={progress.total} label={`${progress.done}/${progress.total}`} />
              </span>

              {/* 纯计数,和进度条同一条纪律:只陈述"有几件",不说"该先干哪件"、
                  更不提任何清理建议(不可改清单第 5 条延伸)。两个都是 0 就整条不显示。 */}
              {(attention.confirm > 0 || attention.blocked > 0) && (
                <span className="ben-wb__sprint-attn" aria-label="本冲刺待办事项">
                  {attention.confirm > 0 && (
                    <span className="ben-wb__sprint-attn-item" data-status="confirm">
                      等我确认 {attention.confirm}
                    </span>
                  )}
                  {attention.blocked > 0 && (
                    <span className="ben-wb__sprint-attn-item" data-status="blocked">
                      阻塞 {attention.blocked}
                    </span>
                  )}
                </span>
              )}

              <button
                type="button"
                className="ben-wb__sprint-edit"
                aria-label={`编辑冲刺 ${current.name}`}
                aria-expanded={editing}
                onClick={() => setEditing(open => !open)}
              >
                {editing ? '收起' : '编辑'}
              </button>
            </div>
          )}

      {editing && current !== undefined && (
        <SprintEditor
          sprint={current}
          confirmDelete={confirmDelete}
          setConfirmDelete={setConfirmDelete}
          onUpdate={patch => onUpdate(current.id, patch)}
          onDelete={() => onDelete(current.id)}
        />
      )}
    </div>
  )
}

/**
 * 冲刺编辑面。版本号那一行按「一行一条 label + version」编辑,空行即删除该条——
 * 不做增删按钮,因为版本号总共就两三条,一个多行文本框比一排按钮更快。
 */
function SprintEditor({ sprint, confirmDelete, setConfirmDelete, onUpdate, onDelete }: {
  sprint: SprintView
  confirmDelete: boolean
  setConfirmDelete: (value: boolean) => void
  onUpdate: (patch: SprintPatch) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(sprint.name)
  const [goal, setGoal] = useState(sprint.goal ?? '')
  const [versions, setVersions] = useState(
    sprint.versions.map(version => `${version.label} ${version.version}`).join('\n'),
  )

  return (
    <div className="ben-wb__sprint-editor">
      <label>
        <span>冲刺名</span>
        <input
          type="text"
          aria-label="冲刺名"
          value={name}
          onChange={event => setName(event.target.value)}
          onBlur={() => { if (name.trim() !== '' && name.trim() !== sprint.name) onUpdate({ name: name.trim() }) }}
        />
      </label>

      <label>
        <span>冲刺目标</span>
        <textarea
          rows={2}
          aria-label="冲刺目标"
          placeholder="这一轮要把什么做成什么样"
          value={goal}
          onChange={event => setGoal(event.target.value)}
          onBlur={() => {
            const next = goal.trim()
            if (next === (sprint.goal ?? '')) return
            onUpdate({ goal: next === '' ? null : next })
          }}
        />
      </label>

      <label>
        <span>组成版本</span>
        <textarea
          rows={2}
          aria-label="组成版本号"
          placeholder={'客户端 V0.1\n后端 V0.1'}
          value={versions}
          onChange={event => setVersions(event.target.value)}
          onBlur={() => onUpdate({ versions: parseVersionLines(versions) })}
        />
      </label>

      <div className="ben-wb__sprint-when-edit">
        <label>
          <span>开始</span>
          <input
            type="date"
            aria-label="冲刺开始日期"
            value={sprint.starts_at ?? ''}
            onChange={event => onUpdate({ startsAt: event.target.value === '' ? null : event.target.value })}
          />
        </label>
        <label>
          <span>结束</span>
          <input
            type="date"
            aria-label="冲刺结束日期"
            value={sprint.ends_at ?? ''}
            onChange={event => onUpdate({ endsAt: event.target.value === '' ? null : event.target.value })}
          />
        </label>
        {confirmDelete
          ? (
              <>
                <button type="button" className="ben-wb__task-del" aria-label="确定删冲刺" onClick={onDelete}>
                  确定删?卡片会退回未归模块
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
              </>
            )
          : (
              <button
                type="button"
                className="ben-wb__task-del"
                aria-label={`删掉冲刺 ${sprint.name}`}
                onClick={() => setConfirmDelete(true)}
              >
                删掉冲刺
              </button>
            )}
      </div>
    </div>
  )
}

/**
 * 「客户端 V0.1」这样一行拆成 { label, version }:**最后一个空格之后是版本号**,
 * 前面整段是 label(标签本身可能带空格,比如「iOS 客户端 V0.1」)。
 * 拆不出两半的行整行丢掉,不留一条读不懂的版本。
 */
export function parseVersionLines(text: string): SprintVersion[] {
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    if (trimmed === '') return []
    const at = trimmed.lastIndexOf(' ')
    if (at <= 0) return []
    const label = trimmed.slice(0, at).trim()
    const version = trimmed.slice(at + 1).trim()
    return label === '' || version === '' ? [] : [{ label, version }]
  })
}

/**
 * 一家智能体的「灯」:受保护的 `AgentIcon`(状态角标)+ 悬停说明卡(此刻怎样、最近那句、备注、读了什么)。
 * 顶栏那一排与协作区「成员」那一排用的是这同一份(10-22 第三轮:接入的智能体只在一处出现,样子与说法一处定)。
 */
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EntryLamp } from './agentRegistryView.ts'
import { AgentIcon } from './AgentIcon.tsx'
import type { TopBarLamp } from './TopBar.tsx'

export function LampIcon({ lamp, baseUrl }: { lamp: TopBarLamp, baseUrl?: string | undefined }) {
  return <AgentIcon id={lamp.id} icon={lamp.icon} tint={lamp.tint} status={lamp.color as EntryLamp} baseUrl={baseUrl} dim={lamp.dim === true} />
}

/** 说明卡里那几句。这一张只说它此刻怎样,不放能撤掉一家的键(那颗只在「N 家」面板每行的「⋯」里)。 */
export function LampCardBody({ lamp }: { lamp: TopBarLamp }) {
  if (lamp.detail === undefined) return lamp.why === undefined ? null : <p className="ben-wb__lampcard-note">{lamp.why}</p>
  return (
    <>
      <p className="ben-wb__lampcard-state">{lamp.detail.state}</p>
      {lamp.detail.latest !== undefined && <p className="ben-wb__lampcard-latest">{lamp.detail.latest}</p>}
      {lamp.detail.note !== undefined && <p className="ben-wb__lampcard-note">{lamp.detail.note}</p>}
      {lamp.detail.reads !== undefined && <p className="ben-wb__lampcard-reads">{lamp.detail.reads}</p>}
    </>
  )
}

/**
 * 悬停就出说明卡的那一圈外壳(协作区成员标签用;顶栏那一排另有点开钉住与躲窗位,见 TopBar)。
 * 成员那一排是横着滑的,卡若画在里面会被裁掉:挂到工作台根上、按视口坐标摆在标签下面 6px。
 */
export function LampHover({ lamp, children }: { lamp: TopBarLamp, children: ReactNode }) {
  const [at, setAt] = useState<{ left: number, top: number, root: Element } | undefined>(undefined)
  const hasCard = lamp.detail !== undefined || lamp.why !== undefined
  return (
    <span
      className="ben-wb__lamphover"
      onMouseEnter={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        setAt({ left: box.left, top: box.bottom + 6, root: event.currentTarget.closest('.ben-wb') ?? document.body })
      }}
      onMouseLeave={() => setAt(undefined)}
    >
      {children}
      {at !== undefined && hasCard && createPortal(
        <div className="ben-wb__lampcard ben-wb__lampcard--float" role="dialog" aria-label={lamp.name} style={{ left: at.left, top: at.top }}>
          <LampCardBody lamp={lamp} />
        </div>,
        at.root,
      )}
    </span>
  )
}

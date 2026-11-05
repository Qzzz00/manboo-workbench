/**
 * 第一次用的空态 —— 画那一半(2026-09-18)。算在 emptyState.ts,这里只负责把结论摆出来。
 *
 * 视觉上只有一条要求,跟解锁卡同一条:**空态不能长得像报错**。没有红色、没有感叹号、
 * 没有加载骨架 —— 它说的是"这儿还什么都没有,来吧",不是"出事了"。
 */
import type { EmptyModule, EmptyView } from './emptyState.ts'
import { Icon } from './ui/icons.tsx'

export interface EmptyStateProps {
  view: EmptyView
  /**
   * 那颗按钮按下去。**不给就不画按钮**(那句话本身仍然照出)——同解锁卡 onUnlock 的先例:
   * 画一颗按下去什么也办不成的按钮就是骗人。
   */
  onAction?: (module: EmptyModule) => void
  /**
   * 悬浮在别人身上(窗位槽那一格用)。窗位槽的槽体是**窗位矩形的唯一来源**,它的尺寸
   * 一变服务端就会把贴住的窗重摆一次(2026-08-25 真机那条"窗口莫名往上窜")——所以那一格
   * 的空态必须 `position:absolute`、不占文档流,跟 `.ben-wb__dock-note` / `.ben-wb__slot-veiled`
   * 同一个办法。缺省 false:别的几格是正常文档流里的一段话。
   */
  overlay?: boolean
}

export function EmptyState({ view, onAction, overlay = false }: EmptyStateProps) {
  return (
    <div
      className="ben-wb__emptyfirst"
      data-module={view.module}
      data-overlay={overlay}
      role="status"
      aria-label={`${view.module} 还是空的`}
    >
      {/* 评审页 `.empty-inline`:图标 22、标题 13 / 600、一句 11 / 1.7、次按钮带 → */}
      <Icon name={view.icon} size={22} />
      <h3 className="ben-wb__emptyfirst-title">{view.title}</h3>
      <p className="ben-wb__emptyfirst-line">{view.line}</p>
      {view.action !== undefined && onAction !== undefined && (
        <button
          type="button"
          className="ben-wb__emptyfirst-btn"
          onClick={() => onAction(view.module)}
        >
          {view.action.label}
          <Icon name="arrow-right" />
        </button>
      )}
    </div>
  )
}

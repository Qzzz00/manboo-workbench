/**
 * 「图谱」格(2026-10-23,卡「系统文件夹改成Graphify图谱」;原来叫「系统文件夹」)。
 *
 * 这一格现在嵌的是 graphify 生成的图谱页面:图谱体在 GraphView.tsx(install / build /
 * iframe 那三档),这里只包 ModuleBox 与 header,外加素材那一排按钮 —— 那一排只在
 * 模板真的给了路径时才画(ops 模板的「素材管理」,做产品模板里没有素材这回事)。
 *
 * ## 旧 props 兼容(HOST_API 的 builtin.FilesModule 只增不改)
 *
 * 2026-10-23 之前这一格是 Finder 贴合 + Wiki 图谱两支,旧签名有一大摊 props
 * (view/pin/helper/bodyRef/onSwitchView/inbox/veil/empty/access/onAuthorize/accessError)。
 * 用户层里的旧小组件还会把这些传进来 —— **一律照旧收、收了不用**,不许删:
 * 删了会让装了旧小组件的机器在加载那一刻直接抛。那些 props 的类型留在下面,
 * 全部标 @deprecated。
 */
import { useEffect, useRef, type ReactNode, type Ref } from 'react'
import type { HelperView, WorkbenchProject } from '../protocol.ts'
import { ModuleBox, type ModuleBoxProps } from './ModuleBox.tsx'
import { postSilently } from './postSilently.ts'
import { GraphView } from './GraphView.tsx'
import type { VeilTarget } from './useVeilSlot.ts'
import type { EmptyView } from './emptyState.ts'
import type { AccessNotice } from './accessNotice.ts'

/** @deprecated 服务端已删的旧贴合视图,定义留在本地只为旧小组件的 props 签名兼容(收着不用)。 */
interface FilesPinView { pinned: boolean, reason?: string, intent?: boolean }
/** @deprecated 服务端收件箱已整个删掉,定义留在本地只为旧小组件的 props 签名兼容(收着不用)。 */
interface InboxView { items?: readonly unknown[], error?: string }

export function FilesModule({
  box, header, headingId, baseUrl, fetchImpl, projects, currentProjectId, assetDirs, assetFiles,
  // ── 2026-10-23 起以下旧 props 一律忽略(旧小组件还传,收了不用)──
  view: _view, pin: _pin, helper: _helper, bodyRef: _bodyRef, onSwitchView: _onSwitchView,
  inbox: _inbox, veil: _veil, empty: _empty, access: _access, onAuthorize: _onAuthorize, accessError: _accessError,
}: {
  box: ModuleBoxProps
  header: ReactNode
  headingId: string
  baseUrl: string
  fetchImpl: typeof fetch
  /** 项目锚点:带 path 的项目才有图谱;项目区展开的那个优先当当前项目。 */
  projects: readonly WorkbenchProject[]
  /** 项目区此刻展开的项目(GraphView 优先拿它当当前项目)。 */
  currentProjectId?: string | null
  /**
   * 素材那几个固定子文件夹(ops 模板)。键是文件夹名、值是**绝对路径**(服务端按
   * 工作目录拼好的)。不传 / 空 = 这一行整条不画 —— 做产品模板里没有"素材"这回事。
   */
  assetDirs?: Readonly<Record<string, string>>
  /**
   * 素材那一行里的**文件**(2026-09-21 第八格「收藏网址」),键是显示名、值是绝对路径。
   * 与 assetDirs 分开的理由只有一个:**点法不一样** —— 文件夹那几颗是"把 Finder 领到
   * 那个目录去",文件这一颗是"在 Finder 里选中这个文件"。
   */
  assetFiles?: Readonly<Record<string, string>>
  /** @deprecated 2026-10-23 起忽略:Finder/Wiki 两支已随本体删掉。 */
  view?: 'finder' | 'wiki'
  /** @deprecated 2026-10-23 起忽略:Finder 贴合已删。 */
  pin?: FilesPinView
  /** @deprecated 2026-10-23 起忽略:Finder 贴合已删。 */
  helper?: HelperView
  /** @deprecated 2026-10-23 起忽略:槽体已删。 */
  bodyRef?: Ref<HTMLDivElement>
  /** @deprecated 2026-10-23 起忽略:Finder/Wiki 切换已删。 */
  onSwitchView?: (next: 'finder' | 'wiki') => void
  /** @deprecated 2026-10-23 起忽略:服务端收件箱已整个删掉。 */
  inbox?: InboxView
  /** @deprecated 2026-10-23 起忽略:这一格不再有弹层。 */
  veil?: VeilTarget
  /** @deprecated 2026-10-23 起忽略:这一格的空态由 GraphView 自己说。 */
  empty?: EmptyView
  /** @deprecated 2026-10-23 起忽略:Finder 贴合已删,没有「贴不了 Finder」那一句了。 */
  access?: AccessNotice
  /** @deprecated 2026-10-23 起忽略。 */
  onAuthorize?: () => void
  /** @deprecated 2026-10-23 起忽略。 */
  accessError?: string | null
}) {
  /**
   * 嵌入槽位协议(2026-10-24,修旧用户层小组件高度链):header==null(被小组件嵌)时,
   * 本节可能宿在一个不参与 flex 高度链的容器里(实测旧 files 原件:外壳拖高、图区恒 2px)。
   * 本体不认识任何用户层 class(分层 skin-guard 硬门),所以用通用几何:量出所宿
   * 模块盒(.ben-wb__mod,本体自己的盒子)扣掉底边 12px 手柄与上游兄弟占高,把本节
   * 填进去 —— 宿主怎么包都行。ResizeObserver 跟手;jsdom 没有 RO,跳过(几何只在
   * 浏览器有意义)。直出本体路(header 非空)不启用。
   */
  const embedRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (header !== null) return
    if (typeof ResizeObserver === 'undefined') return
    const section = embedRef.current
    if (section === null) return
    const mod = section.closest('.ben-wb__mod')
    if (mod === null) return
    const apply = (): void => {
      const top = section.getBoundingClientRect().top - mod.getBoundingClientRect().top
      const next = Math.max(96, mod.clientHeight - 12 - top) // 12 = 模块盒底边手柄
      section.style.height = `${Math.round(next)}px`
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(mod)
    return () => { ro.disconnect() }
  }, [header])

  const content = (
    <section
      className="ben-wb__card--fill"
      aria-labelledby={headingId}
      ref={embedRef}
      {...(header === null ? { 'data-embed': 'graph' } : {})}
      style={{ flex: 1, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {header}

      {/* 素材管理(2026-09-21 运营模板):点一个在 Finder 里打开它(文件夹)或选中它(文件)。
          这一行只在模板真的给了绝对路径时才画 —— 见 assetDirs 的注释。 */}
      {((assetDirs !== undefined && Object.keys(assetDirs).length > 0)
        || (assetFiles !== undefined && Object.keys(assetFiles).length > 0)) && (
        <div className="ben-wb__assets" role="group" aria-label="素材文件夹">
          {Object.entries(assetDirs ?? {}).map(([name, path]) => (
            <button
              type="button"
              key={name}
              className="ben-wb__assets-btn"
              title={path}
              onClick={() => { void postSilently(`${baseUrl}/files/reveal`, { path }, fetchImpl) }}
            >
              {name}
            </button>
          ))}
          {/* 第八格「收藏网址」(2026-09-21)。它是一个文件:点它在 Finder 里**选中**它,
              双击就打开。**没有新开一条「替你 open 这个文件」的路子** —— 那等于给
              任何能 POST 到本机的人一条"按路径执行"的口子,而这一格换来的只是少双击一下。
              这条取舍记在决策记录里,可推翻。
              文件里一行一条,格式在文件自己的头两行写着;往里写的是事务官
              (技能 docs/技能/运营-收藏网址.md),不是这颗按钮。 */}
          {Object.entries(assetFiles ?? {}).map(([name, path]) => (
            <button
              type="button"
              key={name}
              className="ben-wb__assets-btn"
              data-kind="file"
              title={`${path}(一行一条:标题 + 链接 + 备注;点这里在 Finder 里选中它)`}
              onClick={() => { void postSilently(`${baseUrl}/files/reveal`, { path }, fetchImpl) }}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <GraphView
        baseUrl={baseUrl}
        fetchImpl={fetchImpl}
        projects={projects}
        {...(currentProjectId === undefined ? {} : { currentProjectId })}
      />
    </section>
  )

  // 当 header 为 null/undefined 时，说明是作为小组件子视图内嵌调用(如起步用户层的「整理与图谱」)，
  // 此时外层已经有小组件的 ModuleBox，不再重复套一层 ModuleBox(避免产生重复拖拽手柄并阻断高度链传递)。
  if (header === null || header === undefined) {
    return content
  }

  return (
    <ModuleBox {...box}>
      {content}
    </ModuleBox>
  )
}

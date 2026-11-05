/**
 * 窗位叠里一格自定义模块的标签(2026-09-21)。
 *
 * 看上去与应用标签同族(同一个 `.ben-wb__dock-tab` 底子),但背后的东西不一样:
 * 应用标签后面是一扇真的原生窗,这一格后面是一份网页。所以两处不同:
 *
 * - **不可拖拽**。顺序由"做出来的先后"决定(服务端按 `created_at` 排)——
 *   那是一个不会骗人的顺序。dock.stack 那套拖拽序落盘在 `dock.json` 里,
 *   自定义模块不在那份清单上,硬塞进去就是第二份要维护的顺序。
 * - **✕ 是「移除」,不是「放出」**。应用标签的 ✕ 意思是"把这扇窗还给你,清单里还留着";
 *   这里的 ✕ 是"把这个模块拿走"。两件事的份量不一样,所以**要二次确认** ——
 *   原地把标签变成一句「移除?」,不是弹 `window.confirm`:
 *   ① 窗位叠上一格的去留不值得把整个界面挡住;
 *   ② 壳里 `window.confirm` 会顶掉焦点(而且 jsdom 里它默认不存在,测不到)。
 *
 * 二次确认那一步**不设超时自动取消**:他点开确认之后转头去干别的,回来看见的应该还是
 * 那句问话,而不是一颗悄悄变回去的 ✕(那会让他以为自己点过了)。点标签本身、
 * 点「不移」都退回原状。
 */
import { useState } from 'react'
import type { CustomModuleView } from '../protocol.ts'

export function CustomModuleTab({ module, current, onSelect, onRemove }: {
  module: CustomModuleView
  current: boolean
  onSelect: () => void
  /** 不给就不画 ✕(只读的那一档:没接写路由、或者上层不想让人在这里删)。 */
  onRemove?: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <span
      className="ben-wb__dock-tab ben-wb__module-tab"
      data-current={current}
      data-module-id={module.id}
      data-confirming={confirming}
    >
      <button
        type="button"
        className="ben-wb__dock-tab-name"
        onClick={() => { setConfirming(false); onSelect() }}
        title={`${module.name}(自定义模块)`}
      >
        {module.icon !== undefined && <span className="ben-wb__module-tab-icon" aria-hidden="true">{module.icon}</span>}
        {module.name}
      </button>
      {onRemove !== undefined && (confirming
        ? (
            <>
              <button
                type="button"
                className="ben-wb__module-tab-confirm"
                onClick={() => { setConfirming(false); onRemove() }}
              >
                {/* 「移到回收站」不是「删除」:这句话本身就是那条可撤销的承诺(设置里能拿回来)。 */}
                移到回收站
              </button>
              <button
                type="button"
                className="ben-wb__module-tab-cancel"
                aria-label={`不移除 ${module.name}`}
                onClick={() => setConfirming(false)}
              >
                不移
              </button>
            </>
          )
        : (
            <button
              type="button"
              className="ben-wb__dock-tab-close ben-wb__module-tab-close"
              aria-label={`移除 ${module.name}`}
              onClick={() => setConfirming(true)}
            >
              ✕
            </button>
          ))}
    </span>
  )
}

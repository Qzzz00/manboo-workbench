/**
 * 场景条(spec W5/W6;A4 起「保存为新场景」入口下线):挂在窗口槽模块内、SlotZone 上方——
 * 命名的窗口布局清单的操作面板。
 *
 * 列表真相来自 props.scenes(下一拍 /state 轮询刷新),这里不本地乐观更新任何一行——
 * 跟 CredentialPanel 同一套规矩:点了按钮只管发请求、把服务端如实回的结果摆出来。
 * 恢复报告(RestoreReport)逐应用展示,ok:false 的行标红且带 reason 原文(D13);
 * 保存/改名/删除失败时同样以 reason/error 原文示人,不改写成别的措辞。
 * fetch 本身抛出(服务没起/网络断)也不能悄悄吞掉——同样落一行红字,不能装作什么都没发生。
 * A4:新建场景的输入框+「保存为新场景」按钮整体移除(管理面板一起下线的同一波精简);
 * 每个已有场景的「恢复/覆盖保存/删除」不受影响——`/scene/create` 路由仍在服务端,
 * 只是客户端暂时没有 UI 挂着(先例见 appsRegistry 的 add()/`/apps/add`)。
 *
 * 2026-09-20(去预置场景)一度**把新建那一颗接了回来**、并加了一句空清单提示;
 * **2026-09-21 Ben 拍板两样一起去掉**(原话:「这个部分不要有了」)——布局以后由模板
 * 带出来,这一格只做「恢复 / 覆盖保存 / 改名 / 删除」,不再是存布局的入口。于是:
 * - 「给这套布局起个名 / 存成新布局」那一行整个删掉(handleCreate 与它的两个 state 一并);
 * - 「还没存过窗口布局……」那句提示删掉。清单为空时**竖屏这条路径整条不画**(返回 null),
 *   不留一个空壳容器;窄栏那颗按钮照常在,点开只说一句「还没有窗口布局」——
 *   菜单开出来一片空白比说一句话更像坏了。
 * - `/scene/create` 路由**不删**(先例同 A4:服务端留着,客户端没 UI 挂着),模板那张卡要用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SceneView } from '../protocol.ts'
import { Icon } from './ui/icons.tsx'

export interface SceneBarProps {
  baseUrl: string
  scenes: readonly SceneView[]
  fetchImpl?: typeof fetch
  /**
   * 窄栏形态(2026-09-18)。横屏左栏定死 168px,一行放不下「名字 + 恢复 + 覆盖保存 + 删除」
   * —— Ben 的截图里它被挤成两行、名字还被截掉半个字,「删除」整颗掉到栏外面去了。
   * 为真时整条收成**一颗图标按钮**,点开才在右边弹出面板,面板里那几行一个字没改。
   * 缺省 false:竖屏那条路径(窗位槽模块内部那一份)逐字不变。
   */
  compact?: boolean
}

interface ResultLine { text: string, bad: boolean }

/** /scene/restore 的响应形状(server/scenes.ts RestoreReport,这里不引入运行时依赖,按结构取用)。 */
interface RestoreLikeResponse {
  ok?: boolean
  reason?: string
  apps?: { app: string, ok: boolean, reason?: string }[]
}

/** /scene/save、/scene/create、/scene/rename、/scene/delete 的响应形状,失败原因或走 reason 或走 error。 */
interface SimpleResponse {
  ok?: boolean
  reason?: string
  error?: string
}

export function SceneBar({ baseUrl, scenes, fetchImpl, compact = false }: SceneBarProps) {
  const [resultLines, setResultLines] = useState<readonly ResultLine[]>([])
  /** 窄栏形态下面板开着没有。非窄栏时这一格永远是 true(整条常显,跟这一版之前一样)。 */
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // 恢复中的场景 id(组件本地态,不进 store):/scene/restore 打进去到响应/异常之间禁用对应按钮,
  // 不然手快的话能重复点出好几个并发恢复。
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const post = useCallback(async (pathname: string, body: unknown): Promise<unknown> => {
    const impl = fetchImpl ?? fetch
    const res = await impl(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.json()
  }, [baseUrl, fetchImpl])

  async function handleRestore(id: string): Promise<void> {
    setRestoringId(id)
    try {
      const json = await post('/scene/restore', { id }) as RestoreLikeResponse
      const apps = json.apps ?? []
      if (apps.length > 0) {
        setResultLines(apps.map(entry => ({
          text: entry.ok ? `${entry.app} ✓` : `${entry.app}:${entry.reason}`,
          bad: !entry.ok,
        })))
      }
      else {
        setResultLines([{ text: json.reason ?? (json.ok === true ? '恢复完成' : '恢复失败'), bad: json.ok !== true }])
      }
    }
    catch (err) {
      // fetch 本身失败(服务没起、网络断)不能让结果区一片空白装作什么都没发生——D13 如实告知。
      setResultLines([{ text: `操作失败:${err instanceof Error ? err.message : String(err)}`, bad: true }])
    }
    finally {
      setRestoringId(null)
    }
  }

  /** save/create/rename/delete 共用:ok 就清空结果行,不 ok 就把 reason/error 原样摆一行;
   *  fetch 本身抛出(而非业务失败)同样要落一行,不能悄悄吞掉。 */
  async function runSimple(pathname: string, body: unknown): Promise<void> {
    try {
      const json = await post(pathname, body) as SimpleResponse
      if (json.ok === true) { setResultLines([]); return }
      setResultLines([{ text: json.reason ?? json.error ?? '操作失败', bad: true }])
    }
    catch (err) {
      setResultLines([{ text: `操作失败:${err instanceof Error ? err.message : String(err)}`, bad: true }])
    }
  }

  async function handleSave(id: string): Promise<void> {
    await runSimple('/scene/save', { id })
  }

  async function handleDelete(id: string): Promise<void> {
    await runSimple('/scene/delete', { id })
  }

  async function handleRename(id: string, name: string): Promise<void> {
    setEditingId(null)
    const trimmed = name.trim()
    if (trimmed === '') return
    await runSimple('/scene/rename', { id, name: trimmed })
  }

  /**
   * 点到别处 / 按 Esc 就收起来(只在窄栏形态、而且面板正开着时才挂这两个监听 ——
   * 面板没开的时候整个工作台上多两个全局监听是白搭的)。用 pointerdown 而不是 click:
   * 面板盖在窗位槽上,等到 click 那一拍手指早就落在下面那块区域上了。
   */
  useEffect(() => {
    if (!compact || !menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const node = menuRef.current
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [compact, menuOpen])

  const bar = (
    <div className="ben-wb__scenebar" role="group" aria-label="场景">
      {/* 清单为空时:窄栏菜单里说一句(菜单开出来一片空白比说一句话更像坏了),
          竖屏那条路径压根走不到这里(下面 compact 分叉之前就返回 null 了)。
          2026-09-21 Ben:「这个部分不要有了」——不再提「在这里保存」,布局由模板带出来。 */}
      {scenes.length === 0 && (
        <p className="ben-wb__scene-hint" role="status">还没有窗口布局</p>
      )}
      {scenes.map((scene) => {
        const unsaved = scene.app_count === 0
        return (
          <div className="ben-wb__scene-row" key={scene.id}>
            {editingId === scene.id ? (
              <input
                className="ben-wb__inp ben-wb__scene-name-input"
                aria-label={`重命名 ${scene.name}`}
                value={draft}
                autoFocus
                onChange={event => setDraft(event.target.value)}
                onBlur={() => setEditingId(null)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleRename(scene.id, draft)
                  if (event.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <button
                type="button"
                className="ben-wb__scene-name"
                onClick={() => { setEditingId(scene.id); setDraft(scene.name) }}
              >
                {scene.name}
                {unsaved && <span className="ben-wb__scene-unsaved">未保存</span>}
              </button>
            )}
            <button
              type="button"
              className="ben-wb__scene-btn"
              disabled={unsaved || restoringId === scene.id}
              aria-label={`恢复 ${scene.name}`}
              onClick={() => { void handleRestore(scene.id) }}
            >
              恢复
            </button>
            <button
              type="button"
              className="ben-wb__scene-btn"
              aria-label={`覆盖保存 ${scene.name}`}
              onClick={() => { void handleSave(scene.id) }}
            >
              覆盖保存
            </button>
            <button
              type="button"
              className="ben-wb__scene-btn"
              aria-label={`删除 ${scene.name}`}
              onClick={() => { void handleDelete(scene.id) }}
            >
              删除
            </button>
          </div>
        )
      })}

      {resultLines.length > 0 && (
        <div className="ben-wb__scene-result" role="status">
          {resultLines.map((line, index) => (
            <p key={`${index}-${line.text}`} className={line.bad ? 'ben-wb__scene-result--bad' : undefined}>
              {line.text}
            </p>
          ))}
        </div>
      )}
    </div>
  )

  /**
   * 竖屏(窗位槽模块内部那一份):一条都没存过就**整条不画**。
   * 2026-09-21 Ben 把「存成新布局」与那句提示一起去掉之后,空清单下这一格已经没有任何
   * 内容可画 —— 留一个空的 `.ben-wb__scenebar`(它自带 8px 下边距)只是在槽上方压一条
   * 看不出是什么的缝。窄栏那颗按钮照旧在(见下面),点开会说一句「还没有窗口布局」。
   */
  if (!compact) return scenes.length === 0 ? null : bar

  /**
   * 窄栏形态:一颗图标按钮 + 一块往右开的面板(见 sceneMenuStyle.ts)。
   *
   * **同一份 `bar`**,不是另画一套场景行 —— 两份行各自跑一遍 /scene/restore 的
   * 「恢复中禁用按钮」那点本地态,迟早一边禁一边没禁(先例:两份 DockTabBar 会把
   * 同一枚蓝点标两次已读,横屏那张卡为此专门加了 hoistTabs)。
   *
   * 有话要说的时候(上一次恢复/保存的结果行)按钮上挂一个 data 标记:面板收起来之后
   * 那几行就看不见了,不给个记号的话,一次失败的恢复会悄无声息地过去(D13)。
   */
  const failed = resultLines.some(line => line.bad)
  return (
    <div className="ben-wb__scenemenu" ref={menuRef}>
      <button
        type="button"
        className="ben-wb__scenemenu-trigger"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="窗口布局"
        data-has-result={resultLines.length > 0}
        data-failed={failed}
        onClick={() => setMenuOpen(open => !open)}
      >
        {/* 「窗口布局」那一格的图标:内置的线性图标(它不是一个 App,没有包可以取图),照评审页用 `layers` 14px;
            外面那格仍是 16px 宽(`ben-wb__appicon-glyph`),名字与别的格对齐。不带计数(10-22 拍板)。 */}
        <span className="ben-wb__appicon-glyph" aria-hidden="true"><Icon name="layers" /></span>
        <span className="ben-wb__scenemenu-label">窗口布局</span>
      </button>
      {menuOpen && <div className="ben-wb__scenemenu-pop" role="menu">{bar}</div>}
    </div>
  )
}

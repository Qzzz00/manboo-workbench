/**
 * 设置 →「这台电脑」→「用户层」那一节(2026-10-21,卡「分层第一刀」)。
 *
 * 四样:目录在哪(一颗「在访达中打开」—— 她不碰终端)、装了什么、哪个坏了(服务端判的清单问题 +
 * 页面上装的时候出的错,两边合在一行里说)、四族插件(现在还装在工作台里面,标出来、给出搬出顺序)。
 *
 * 规矩同 CustomModulesPanel:数据自己拉 `GET /user-layer`,不走 /state;404 = 没接 → 整节不出现;
 * 结果如实上屏,不总结成「失败」。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { SetBtn, SetFold, SetLead, SetMsg, SetRow, SetSection, SetSource } from './settings/setKit.tsx'
import type { UserLayerPayload, UserLayerWidgetView } from '../protocol.ts'
import { userLayerRegistry, type UserLayerRegistry } from './userLayer.tsx'

export function isUserLayerPayload(body: unknown): body is UserLayerPayload {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Record<string, unknown>
  return typeof raw.dir === 'string' && Array.isArray(raw.widgets) && Array.isArray(raw.plugins) && Array.isArray(raw.slots)
}

/** 本体自带一版的那几格(Workbench.tsx 里给了 fallback 组件的);别的格子没装上时只说一句原因。 */
const HAS_BUILTIN: ReadonlySet<string> = new Set(['files', 'todo', 'usage-panel'])

function statusLine(widget: UserLayerWidgetView, clientProblem: string | undefined): string {
  const problem = widget.status === 'broken' ? widget.problem : clientProblem
  if (problem === undefined && widget.rolled_back !== undefined) return `在用上一版:新改的那份坏了(${widget.rolled_back})。改的文件原样留着,改好了自动换上。`
  if (problem === undefined) return '在用'
  const then = widget.replaces !== undefined && HAS_BUILTIN.has(widget.replaces)
    ? '这一格先用工作台自带的那一版。'
    : '这一格先空着,格子里写着原因。'
  return `没装上:${problem}。${then}`
}

export function UserLayerPanel({ baseUrl, fetchImpl, registry = userLayerRegistry }: {
  baseUrl: string
  fetchImpl?: typeof fetch
  registry?: UserLayerRegistry
}) {
  const [payload, setPayload] = useState<UserLayerPayload | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState('')
  useSyncExternalStore(registry.subscribe, registry.version, registry.version)
  const clientProblems = registry.problems()
  const call = fetchImpl ?? fetch

  async function reload(): Promise<UserLayerPayload | null> {
    try {
      const res = await call(`${baseUrl}/user-layer`)
      if (!res.ok) return null
      const body = await res.json() as unknown
      return isUserLayerPayload(body) ? body : null
    }
    catch { return null }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const next = await reload()
      if (alive && next !== null) setPayload(next)
    })()
    return () => { alive = false }
    // 同 CustomModulesPanel:reload 是每次渲染新建的闭包,依赖只列 baseUrl / fetchImpl。
  }, [baseUrl, fetchImpl])

  if (payload === null) return null

  async function reveal(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/user-layer/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const said = (await res.json().catch(() => ({}))) as { ok?: boolean, error?: string }
      setMessage(said.ok === true ? '已在访达里打开。' : (said.error ?? '访达没打开'))
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  /** 自愈那条路:说一句,派一家能写代码的去改用户层(工作区只开到用户层目录)。 */
  async function fix(): Promise<void> {
    const said = ask.trim()
    if (said === '') return
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/user-layer/fix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ said }) })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean, error?: string, dispatch_note?: string }
      setMessage(body.ok === true ? (body.dispatch_note ?? '派出去了') : (body.error ?? '没派出去'))
      if (body.ok === true) setAsk('')
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  /** 选回画好过的某一版(分层自愈,2026-10-23):POST restore;成功后重新拉一遍清单。 */
  async function restore(id: string, rev: string, styleRev: string | undefined): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/user-layer/widgets/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev, ...(styleRev === undefined ? {} : { style_rev: styleRev }) }),
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean, reason?: string }
      if (body.ok === true) {
        setMessage('已选回那一版,这一格已经换上。')
        const next = await reload()
        if (next !== null) setPayload(next)
      }
      else setMessage(body.reason ?? '没选回去')
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  async function again(): Promise<void> {
    setBusy(true)
    const next = await reload()
    if (next !== null) setPayload(next)
    setBusy(false)
  }

  const slotName = (id: string | undefined): string | undefined => payload.slots.find(slot => slot.id === id)?.name

  return (
    // 评审页这一组没有「用户层」这一节;样子照同页的设置节:目录一行 + 两颗动作,每个小组件一行,一行派人去改,
    // 插件清单收进折叠。
    <SetSection id="ben-wb-user-layer" title="用户层" aside={`${payload.widgets.length} 个小组件`}>
      <SetLead>
        你自己的那一层:你加的、你改的格子放在这个目录里。工作台升级时它原地不动,不上传、不合并。
        某一格坏了只退回工作台自带的那一版,不会让整个工作台白屏。
      </SetLead>
      <SetRow title="目录" sub={payload.dir}>
        <span className="ben-wb__srow-acts">
          <SetBtn disabled={busy} onClick={() => { void reveal() }}>在访达中打开</SetBtn>
          <SetBtn disabled={busy} onClick={() => { void again() }}>重新看一遍</SetBtn>
        </span>
      </SetRow>

      <h4>小组件(替工作台的格子)</h4>
      {payload.widgets.length === 0
        ? <SetMsg>还没有。放进「小组件」目录的那一份会替掉工作台自带的那一格。</SetMsg>
        : payload.widgets.map(widget => (
            <div key={widget.id} data-widget-id={widget.id}>
              <SetRow
                data-status={widget.status === 'ok' && !clientProblems.has(widget.id) ? 'ok' : 'broken'}
                title={widget.name}
                sub={[
                  slotName(widget.replaces) === undefined ? undefined : `替「${slotName(widget.replaces)}」`,
                  widget.author,
                  statusLine(widget, clientProblems.get(widget.id)),
                ].filter(one => one !== undefined).join(' · ')}
              />
              {(widget.history?.length ?? 0) > 0 && (
                <SetFold summary={`画好过 ${widget.history?.length ?? 0} 版`} className="ben-wb__user-layer-history">
                  <div data-history>
                    {widget.history?.map(one => (
                      <SetRow
                        key={one.rev}
                        data-history-rev={one.rev}
                        title={`存于 ${new Date(one.at).toLocaleString('zh-CN', { hour12: false })}`}
                        sub={`指纹 ${one.rev}`}
                      >
                        <SetBtn disabled={busy} onClick={() => { void restore(widget.id, one.rev, one.style_rev) }}>选回这一版</SetBtn>
                      </SetRow>
                    ))}
                  </div>
                </SetFold>
              )}
            </div>
          ))}

      <h4>布局(模板)</h4>
      {(payload.layouts ?? []).length === 0
        ? <SetMsg>「布局」目录里还没有布局模板;现在用的是工作台自带的「做产品」。</SetMsg>
        : (payload.layouts ?? []).map(layout => (
            <SetRow
              key={layout.id}
              data-layout-id={layout.id}
              data-status={layout.status}
              title={layout.name}
              sub={layout.status === 'broken' ? `没装上:${layout.problem ?? ''}。这个模板退回「做产品」显示,修好或放回去就恢复。` : '在用'}
            />
          ))}

      <form className="ben-wb__sform" onSubmit={(event) => { event.preventDefault(); void fix() }}>
        <input
          aria-label="想改用户层里的什么"
          placeholder="想改哪一格,说一句(派一家能写代码的去改,只改这个目录)"
          value={ask}
          disabled={busy}
          onChange={event => setAsk(event.target.value)}
        />
        <SetBtn kind="outline" type="submit" disabled={busy || ask.trim() === ''}>派去改</SetBtn>
      </form>

      <SetFold summary={`插件 ${payload.plugins.length} 样`}>
        <div data-plugins>
          <p>下面几样是插件,将来按这个顺序搬进「插件」目录,可装可卸;现在还装在工作台里面。</p>
          {[...payload.plugins].sort((a, b) => a.order - b.order).map(plugin => (
            <SetRow key={plugin.id} data-plugin-id={plugin.id} title={`${plugin.order}. ${plugin.name}`} sub={`${plugin.where === 'built-in' ? '内置' : '在用户层'} · ${plugin.note}`} />
          ))}
        </div>
      </SetFold>

      <p className="ben-wb__smsg"><SetSource>{`「开发一个小工具」做出来的网页小组件在上面「自定义组件」那一节,文件在 ${payload.web_widgets_dir}。`}</SetSource></p>
      {message !== null && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}

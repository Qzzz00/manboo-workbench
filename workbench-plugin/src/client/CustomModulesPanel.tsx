/**
 * 设置里的「自定义模块」那一节(2026-09-21)。
 *
 * 两份清单:**在用的**(窗位叠上那几格)与**回收站**(移走了、还拿得回来)。
 * 这一节存在的唯一理由就是第二份 —— 移除那一下是在窗位叠上做的,而"我后悔了"这件事
 * 需要一个能找得到的地方。PRD §9 的「可撤销」在这里是一条看得见的路,不是一句承诺。
 *
 * 三条跟别的设置节一样的规矩(同 TemplatePanel):
 * 1. **数据自己拉 `GET /modules`,不走 /state** —— /state 里只有"在用的"那一份
 *    (标签栏要它),回收站不该每秒跟着轮询一遍。404 = 没接这块 → **整节不出现**。
 * 2. **不弹 window.confirm**:移除的二次确认在窗位叠的标签上(CustomModuleTab);
 *    这里的「恢复」是把东西**拿回来**,不是破坏性动作,不需要再确认一次。
 * 3. **结果如实上屏**:重名恢复不了、目录搬不动,服务端怎么说就怎么写,不总结成"失败"。
 */
import { useEffect, useState } from 'react'
import { SetBtn, SetFold, SetLead, SetMsg, SetRow, SetSection } from './settings/setKit.tsx'
import type { CustomModuleView } from '../protocol.ts'

export interface ModulesPayload {
  modules: readonly CustomModuleView[]
  trash: readonly CustomModuleView[]
}

/** 形状不对就当没拿到(同 TemplatePanel 的 isTemplatePayload:并行用例里 fetch 会串台)。 */
export function isModulesPayload(body: unknown): body is ModulesPayload {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Record<string, unknown>
  return Array.isArray(raw.modules) && Array.isArray(raw.trash)
}

export function CustomModulesPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const [payload, setPayload] = useState<ModulesPayload | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const call = fetchImpl ?? fetch

  async function reload(): Promise<ModulesPayload | null> {
    try {
      const res = await call(`${baseUrl}/modules`)
      if (!res.ok) return null
      const body = await res.json() as unknown
      return isModulesPayload(body) ? body : null
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
    // 依赖只列 baseUrl / fetchImpl,同 TemplatePanel:reload 是每次渲染新建的闭包。
  }, [baseUrl, fetchImpl])

  // 404 / 读不出来 = 这台服务没接自定义模块,整节不出现。
  if (payload === null) return null

  async function act(id: string, action: 'remove' | 'restore'): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/modules/${id}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      const said = (await res.json().catch(() => ({}))) as { ok?: boolean, error?: string }
      if (said.ok !== true) setMessage(said.error ?? '没办成')
      else setMessage(action === 'restore' ? '拿回来了 —— 窗位叠那一排下一拍就有它。' : '已经移进回收站,随时能拿回来。')
      const next = await reload()
      if (next !== null) setPayload(next)
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  return (
    // 评审页 `section('custom', '自定义组件', …)`:在用的那几个一行一个,回收站收进「回收站 N 个 · 展开 ›」。
    <SetSection id="ben-wb-modules" title="自定义组件" aside={`在用 ${payload.modules.length} 个`}>
      {payload.modules.length === 0
        ? <SetLead>还没有自定义组件。窗位叠上那颗「开发一个小工具」是入口。</SetLead>
        : payload.modules.map(module => (
            <SetRow key={module.id} data-module-id={module.id} title={module.name} sub={module.id}>
              <SetBtn kind="text" disabled={busy} onClick={() => { void act(module.id, 'remove') }}>移到回收站</SetBtn>
            </SetRow>
          ))}

      <SetFold summary={`回收站 ${payload.trash.length} 个`}>
        <p>跟事务官说一句「开发一个小工具」做出来的那些,每一个在窗位叠上占一格标签。移除只是移进回收站,文件一个字节都不会删。</p>
        {payload.trash.length === 0
          ? <p>回收站是空的。</p>
          : payload.trash.map(module => (
              <SetRow key={module.id} data-trash-id={module.id} title={module.name} sub={module.id}>
                <SetBtn disabled={busy} onClick={() => { void act(module.id, 'restore') }}>恢复</SetBtn>
              </SetRow>
            ))}
      </SetFold>

      {message !== null && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}

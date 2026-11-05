/**
 * 统一输入框的三条请求(2026-09-24)。拿不到就回一句人话,**绝不抛**:
 * 菜单拉不到时输入框照样能打字发送(那是它最基本的一件事)。
 */
import type { ComposerMode, ComposerOptionsView, ComposerUploadView } from '../../protocol.ts'
import { uploadName } from './composerModel.ts'

export async function fetchComposerOptions(baseUrl: string, fetchImpl: typeof fetch): Promise<ComposerOptionsView | { error: string }> {
  try {
    const res = await fetchImpl(`${baseUrl}/composer/options`)
    if (res.status === 404) return { error: '这一版工作台还没有这些菜单' }
    if (!res.ok) return { error: `菜单没拉到(${res.status})` }
    return await res.json() as ComposerOptionsView
  }
  catch {
    return { error: '工作台服务没应答' }
  }
}

export async function saveComposerChoice(
  baseUrl: string,
  fetchImpl: typeof fetch,
  choice: { mode?: ComposerMode, model?: { provider: string, id: string } },
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/composer/choice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(choice),
    })
    return res.ok
  }
  catch {
    return false
  }
}

export async function uploadComposerFile(
  baseUrl: string,
  fetchImpl: typeof fetch,
  file: File,
): Promise<{ ok: true, view: ComposerUploadView } | { ok: false, error: string }> {
  try {
    const res = await fetchImpl(`${baseUrl}/composer/upload?name=${encodeURIComponent(uploadName(file))}`, {
      method: 'POST',
      headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
      body: file,
    })
    const body = await res.json() as Partial<ComposerUploadView> & { ok?: boolean, error?: string }
    if (!res.ok || body.ok !== true || typeof body.id !== 'string') return { ok: false, error: body.error ?? '没传上' }
    return { ok: true, view: { id: body.id, name: body.name ?? body.id, type: body.type ?? '', bytes: body.bytes ?? 0, image: body.image === true } }
  }
  catch {
    return { ok: false, error: '工作台服务没应答,没传上' }
  }
}

export async function answerApproval(baseUrl: string, fetchImpl: typeof fetch, id: string, allow: boolean): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${baseUrl}/approvals/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, allow }),
    })
    if (res.ok) return undefined
    const body = await res.json() as { error?: string }
    return body.error ?? '没答上'
  }
  catch {
    return '工作台服务没应答'
  }
}

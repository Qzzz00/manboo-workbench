/**
 * 统一输入框的纯函数(2026-09-24,docs/设计-统一输入框-2026-09-24.md 第三节)。
 *
 * 维护者:「应该是同一套的不同裁剪才对」。一个组件(Composer.tsx),几种裁剪(TRIMS),
 * 一份请求体(itemBody)。**手机端 butler-app/src/composer/composerModel.ts 是同一套口径的另一份**
 * (两端不互相 import,AGENTS.md);改这里要同步那边,反过来也一样:
 *   - TRIMS 的四档与每档有哪几样;
 *   - isSendKey(回车发送、Shift+回车换行、输入法合成中不发);
 *   - atQuery(打 @ 弹候选);
 *   - itemBody(POST /butler/item 的字段)。
 */
import type { ComposerAgentView, ComposerMode, ComposerOptionsView, ComposerUploadView } from '../../protocol.ts'

/** 四种裁剪。 */
export type ComposerTrim = 'onboarding' | 'butler' | 'phone-home' | 'call'

export interface TrimSpec {
  plus: boolean
  at: boolean
  mode: boolean
  model: boolean
  /** 按住说话(只有手机)。 */
  voice: boolean
  /** 模式与模型合成一枚胶囊(手机,维护者 09-24 拍板「收紧摆」)。 */
  pillsMerged: boolean
}

export const TRIMS: Readonly<Record<ComposerTrim, TrimSpec>> = {
  onboarding: { plus: false, at: false, mode: false, model: false, voice: false, pillsMerged: false },
  butler: { plus: true, at: true, mode: true, model: true, voice: false, pillsMerged: false },
  'phone-home': { plus: true, at: true, mode: true, model: true, voice: true, pillsMerged: true },
  call: { plus: false, at: false, mode: false, model: false, voice: false, pillsMerged: false },
}

/** 回车发送;Shift+回车换行;中文输入法合成中(isComposing / keyCode 229)不发。 */
export function isSendKey(event: { key: string, shiftKey: boolean, isComposing?: boolean, keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && event.isComposing !== true && event.keyCode !== 229
}

/**
 * 光标前是不是一段「@xxx」(行首或空白之后的 @,后面没有空白)。是就回 `{start, query}`,
 * start 是 @ 的位置 —— 选中一家之后把这一段从正文里拿掉,换成一枚片。
 */
export function atQuery(text: string, caret: number): { start: number, query: string } | undefined {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return undefined
  if (at > 0 && !/\s/.test(before[at - 1] as string)) return undefined
  const query = before.slice(at + 1)
  if (/\s/.test(query) || query.length > 20) return undefined
  return { start: at, query }
}

/** 把 `@query` 那一段从正文里拿掉。 */
export function dropAtQuery(text: string, start: number, caret: number): string {
  return `${text.slice(0, start)}${text.slice(caret)}`.replace(/^\s+/, '')
}

/** 按打的字筛候选(名字里包含,大小写不敏感)。事务官自己只在没打字时出现。 */
export function filterAgents(agents: readonly ComposerAgentView[], query: string): ComposerAgentView[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...agents]
  return agents.filter(one => one.title.toLowerCase().includes(q) || one.family.includes(q))
}

/** 「后台」不说「命令行」(卡 O,09-25 维护者设计原则:界面上不出现「命令行」「CLI」)。 */
const HAND_WORDS = { window: '窗口', cli: '后台', api: '接口' } as const

/** 候选下面那一行小字:「窗口 · 后台(备用)」,不能用的写原因。 */
export function handLine(agent: ComposerAgentView): string {
  if (agent.family === 'dsh') return '不 @ 就是它'
  const ready = agent.hands.filter(one => one.ready)
  if (ready.length === 0) return agent.hands.map(one => one.why ?? `${HAND_WORDS[one.hand]}用不了`).join(';')
  return ready.map((one, index) => (index === 0 ? HAND_WORDS[one.hand] : `${HAND_WORDS[one.hand]}(备用)`)).join(' · ')
}

/** 一枚附件片。上传中没有 view,失败有 error。 */
export interface DraftAttachment {
  key: string
  name: string
  image: boolean
  /** 本地预览(图片)。 */
  preview?: string
  view?: ComposerUploadView
  error?: string
}

export interface DraftRef {
  kind: 'item' | 'project'
  id: string
  title: string
}

export interface ComposerDraft {
  text: string
  mode?: ComposerMode
  model?: { provider: string, id: string }
  agent?: { family: ComposerAgentView['family'], title: string, ready?: boolean, why?: string }
  attachments: readonly DraftAttachment[]
  refs: readonly DraftRef[]
}

export const EMPTY_DRAFT: ComposerDraft = { text: '', attachments: [], refs: [] }

/** 能不能发:有字,或者有传好的附件;有附件还在传就等一等;若选了未就绪候选(ready: false)则真实禁止发送。 */
export function canSend(draft: ComposerDraft): boolean {
  if (draft.agent?.ready === false) return false
  if (draft.attachments.some(one => one.view === undefined && one.error === undefined)) return false
  return draft.text.trim() !== '' || draft.attachments.some(one => one.view !== undefined)
}

/** Explicit composer controls and legacy payload features retain the /butler/item path. */
export function usesSayPath(draft: ComposerDraft): boolean {
  return draft.mode === undefined && draft.model === undefined && draft.agent === undefined && draft.attachments.length === 0 && draft.refs.length === 0
}

/** POST /butler/item 的请求体。**只带变了的**:没选过的档与模型不带,服务端用粘性的那一份。未就绪时不带 assignee,杜绝静默回退。 */
export function itemBody(draft: ComposerDraft, extra: {
  orientation?: 'portrait' | 'landscape'
  mode?: ComposerMode
  model?: { provider: string, id: string }
} = {}): Record<string, unknown> {
  const uploaded = draft.attachments.filter(one => one.view !== undefined).map(one => ({ id: (one.view as ComposerUploadView).id }))
  return {
    text: draft.text.trim(),
    ...(extra.orientation === undefined ? {} : { orientation: extra.orientation }),
    ...(draft.agent === undefined || draft.agent.family === 'dsh' || draft.agent.ready === false ? {} : { assignee: draft.agent.family }),
    ...(uploaded.length === 0 ? {} : { attachments: uploaded }),
    ...(draft.refs.length === 0 ? {} : { refs: draft.refs.map(ref => ({ kind: ref.kind, id: ref.id })) }),
    ...(extra.mode === undefined && draft.mode === undefined ? {} : { mode: extra.mode ?? draft.mode }),
    ...(extra.model === undefined && draft.model === undefined ? {} : { model: extra.model ?? draft.model }),
  }
}

/** 胶囊上的字:档名 / 模型短名。拿不到模型表时模型那枚不画(回 undefined)。 */
export function modeTitle(options: ComposerOptionsView | undefined, mode: ComposerMode | undefined): string {
  const id = mode ?? options?.mode ?? 'ask'
  return options?.modes.find(one => one.id === id)?.title ?? (id === 'plan' ? '只出方案' : id === 'auto' ? '自动办' : '先问我')
}

export function modelTitle(options: ComposerOptionsView | undefined, model: { provider: string, id: string } | undefined): string | undefined {
  const target = model ?? options?.model
  if (target === undefined) return undefined
  return options?.models.find(one => one.provider === target.provider && one.id === target.id)?.title ?? target.id
}

/** 这一句用的模型能不能直接看图(附件片上那一行小字用)。 */
export function modelSeesImages(options: ComposerOptionsView | undefined, model: { provider: string, id: string } | undefined): boolean {
  const target = model ?? options?.model
  if (target === undefined) return false
  return options?.models.find(one => one.provider === target.provider && one.id === target.id)?.images === true
}

/** 从剪贴板 / 拖放里拿文件。没有文件回空表(那就是一次普通的粘贴文字)。 */
export function filesOf(list: { length: number, item: (index: number) => File | null } | null | undefined): File[] {
  if (list === null || list === undefined) return []
  const out: File[] = []
  for (let i = 0; i < list.length; i += 1) {
    const file = list.item(i)
    if (file !== null) out.push(file)
  }
  return out
}

/** 截图粘进来常常叫 image.png;同一秒贴两张会重名,加上时间免得服务端挨个改名看不出是哪张。 */
export function uploadName(file: { name: string, type: string }, now: Date = new Date()): string {
  const name = file.name.trim()
  if (name !== '' && name !== 'image.png' && name !== 'image.jpg') return name
  const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : file.type === 'image/gif' ? 'gif' : 'png'
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return `截图-${stamp}.${ext}`
}

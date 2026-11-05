/**
 * 「事务官帮我在几台设备上找文件并传过来」(2026-09-21)那两件工具的**不含模型、不含房间**的那一半。
 *
 * Ben 的原话:「通勤的时候就和事务官在交流……几台授权过的设备的文件,我可以让事务官去找,
 * 并且做传输」。
 *
 * 两道闸,都在这个文件里,都能单测:
 *
 *   ① **路径白名单**。`send_file` 只认**这一通电话里搜索结果中出现过的**路径。
 *      为什么非要这一道:模型是会编的。它完全可能在没搜过的情况下说出
 *      `/Users/example/.ssh/id_rsa` 并调用 send_file —— 那就是把私钥发出去。
 *      白名单把「能传什么」钉死在「机器刚刚真的看见过什么」上。
 *      而「机器能看见什么」又被授权目录钉死(search.ts)。两层套起来才够。
 *
 *   ② **复述确认**。第一次调用 `send_file` **一定不传**,只回一句复述:
 *      「把 A 上的《X》发到 B,对吗?」。他说「对」之后模型带 `confirmed: true` 再调一次才真传。
 *      理由:传文件是发生过就改不回来的事,而电话里最容易出错的就是听岔一个名字。
 *
 * 白名单**按设备分开记**:在手机上搜到的路径不能拿去让 Mac 发 —— 那条路径在 Mac 上可能是别的东西。
 */
import type { DeviceInfo } from './devices.ts'
import type { FoundFile } from './search.ts'
import { humanSize } from './transfers.ts'

/** 一台设备上的搜索结果。 */
export interface DeviceSearchSlice {
  device: DeviceInfo
  files: readonly FoundFile[]
  total: number
  truncated: boolean
  /** 没授权 / 读不到 / 那台机器没回话时的一句人话。**原样念给他听**。 */
  note?: string
}

/** 这一通电话里「机器真的看见过」的路径。key 是设备 identity。 */
export type FoundPaths = Map<string, Set<string>>

/**
 * 搜索结果里每一条的**编号**(2026-09-25,卡 J)。电话里模型只拿编号去传,**路径根本不给它看**:
 * 给了它就可能念出来(维护者在引导里定的:永不念文件路径),也可能抄错一个字。
 * 编号 → 哪台设备上的哪条路径,这张表和白名单一样只活在这一通电话里。
 */
export interface FoundHandle {
  identity: string
  path: string
  name: string
  where?: string
  size?: number
}
export type FoundHandles = Map<string, FoundHandle>

/**
 * 记下搜到的:路径进白名单,每一条再发一个编号(接着这一通里上一次的编号往下数,不重号)。
 * 回的是这一批里每一条的编号,顺序与 slices 里的 files 一致。
 */
export function rememberFound(table: FoundPaths, slices: readonly DeviceSearchSlice[], handles?: FoundHandles): string[][] {
  const out: string[][] = []
  for (const slice of slices) {
    const set = table.get(slice.device.identity) ?? new Set<string>()
    const ids: string[] = []
    for (const file of slice.files) {
      set.add(file.path)
      if (handles !== undefined) {
        const id = String(handles.size + 1)
        handles.set(id, {
          identity: slice.device.identity,
          path: file.path,
          name: file.name,
          ...(file.where === undefined ? {} : { where: file.where }),
          size: file.size,
        })
        ids.push(id)
      }
    }
    table.set(slice.device.identity, set)
    out.push(ids)
  }
  return out
}

/** 模型填进来的编号 → 那一条。认「3」「#3」「编号3」「第3个」;认不出就 undefined。 */
export function handleOf(handles: FoundHandles, raw: unknown): FoundHandle | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const digits = /(\d+)/.exec(String(raw))?.[1]
  return digits === undefined ? undefined : handles.get(String(Number(digits)))
}

/** 这条路径是不是**这台设备**刚刚搜出来过的。没搜过就是没搜过 —— 不给任何「看起来很像」的余地。 */
export function pathAllowed(table: FoundPaths, identity: string, path: string): boolean {
  return table.get(identity)?.has(path) === true
}

/** 拒绝时那句话。说清楚为什么,让模型知道该先去搜一次,而不是换个路径再试。 */
export function pathDeniedText(path: string): string {
  return `不能传「${path}」:这一通电话里没有在任何一台设备上搜到过这条路径。`
    + '先用查找文件那件工具搜一次,再从搜到的结果里挑一个传 —— 路径不能凭记忆写。'
}

/** 发到「他正拿着打电话的这台手机」时,复述里说「你这台手机」,不念设备名(他不认得自己手机在房里叫什么)。 */
function targetWords(to: DeviceInfo, toCaller?: boolean): string {
  return toCaller === true ? '你这台手机' : to.name
}

/**
 * 复述确认那一句。工具第一次被调用时回它,**这一次不传任何东西**。
 *
 * 2026-09-25(卡 J):**念文件名、在哪台电脑、在哪个项目里就够了,永不念路径**
 * (维护者 09-24:「永不念文件路径」)。`where` 是「desktop-workbench / docs」这种给人听的一截。
 */
export function confirmText(input: { from: DeviceInfo, fileName: string, to: DeviceInfo, where?: string, toCaller?: boolean }): string {
  return `把${input.from.name}上${spokenWhere(input.where)}的「${input.fileName}」发到${targetWords(input.to, input.toCaller)},对吗?`
}

/**
 * 「desktop-workbench / docs」→「 desktop-workbench 的 docs 文件夹里」:电话里念的,**不念斜杠**
 * (合成会把「/」念成「斜杠」)。没有就是空串。
 */
export function spokenWhere(where: string | undefined): string {
  const parts = (where ?? '').split('/').map(part => part.trim()).filter(part => part !== '')
  if (parts.length === 0) return ''
  if (parts.length === 1) return ` ${parts[0]} 里`
  return ` ${parts[0]} 的 ${parts.slice(1).join(' ')} 文件夹里`
}

/** 回给模型的那一句:先复述,再等他点头。 */
export function confirmPrompt(input: { from: DeviceInfo, fileName: string, to: DeviceInfo, where?: string, toCaller?: boolean }): string {
  return `还没传。先照着这句问他一遍:「${confirmText(input)}」`
    + '他明确说对/是/发吧之后,再调用一次这件工具(file 不变)并把 confirmed 填 true;他说不对就别传,问清楚是哪一个。'
}

/**
 * 搜索结果 → 一段给模型看的话。
 *
 * 2026-09-25(卡 J):**不再把路径给模型看**。每一条带一个编号,传的时候填编号;
 * 给他听的只有文件名、在哪台电脑的哪个项目里、多大。`ids` 缺席(老调用方)时退回老格式带路径。
 */
export function spokenSearchResults(slices: readonly DeviceSearchSlice[], ids?: readonly (readonly string[])[]): string {
  const parts: string[] = []
  slices.forEach((slice, sliceIndex) => {
    const where = `${slice.device.name}(${slice.device.kind === 'mac' ? '电脑' : '手机'})`
    if (slice.note !== undefined && slice.files.length === 0) {
      parts.push(`${where}:${slice.note}`)
      return
    }
    if (slice.files.length === 0) {
      parts.push(`${where}:没找到。`)
      return
    }
    const sliceIds = ids?.[sliceIndex]
    const lines = slice.files.map((file, fileIndex) => {
      const place = file.where === undefined ? '' : `,在 ${file.where} 里`
      const id = sliceIds?.[fileIndex]
      return id === undefined
        ? `  · ${file.name}(${humanSize(file.size)}${place}) 路径 ${file.path}`
        : `  · 编号 ${id}:${file.name}(${humanSize(file.size)}${place})`
    })
    const more = slice.total > slice.files.length ? `,还有 ${slice.total - slice.files.length} 个没列出来` : ''
    const note = slice.note === undefined ? '' : `(${slice.note})`
    parts.push(`${where}:找到 ${slice.total} 个${more}${note}\n${lines.join('\n')}`)
  })
  if (parts.length === 0) return '房里此刻只有这一台设备,没有别处可找。'
  const tail = ids === undefined
    ? '（路径是给你调用「传文件」那件工具用的,**不要念给他听**;跟他说文件名和在哪台设备上就够了。）'
    : '（传的时候把**编号**填进 file。跟他说文件名、在哪台电脑的哪个项目里就够了 —— **编号和路径都不要念**。'
      + '找到不止一个时,排第一的最像(名字对得最准、离仓库最外层最近):直接拿它去复述 —— 复述里会带上在哪个文件夹,'
      + '他说不对再念后面几个让他挑,别一上来就把一串念给他。）'
  return `${parts.join('\n')}\n\n${tail}`
}

/** 传成了之后回给模型的那一句。 */
export function sentText(input: { from: DeviceInfo, to: DeviceInfo, name: string, bytes?: number, toCaller?: boolean }): string {
  const size = input.bytes === undefined ? '' : `(${humanSize(input.bytes)})`
  return `发过去了:${input.from.name}上的「${input.name}」${size} → ${targetWords(input.to, input.toCaller)}。`
    + (input.to.kind === 'phone' ? '手机上点那条「收到」就能打开,文件存在「文档 / 事务官」里。' : '电脑收在「事务官 / 收件」文件夹里。')
}

/**
 * 大文件**还在路上**时回给模型的那一句(2026-09-25,卡 J)。电话不能等着一个 40MB 的文件传完 ——
 * 工具先回这一句,文件接着传;传完手机上自己会有提示,传不过去她会在电话里说一声。
 */
export function sendingText(input: { from: DeviceInfo, to: DeviceInfo, name: string, bytes?: number, toCaller?: boolean }): string {
  const size = input.bytes === undefined ? '' : `,有 ${humanSize(input.bytes)}`
  return `开始传了:${input.from.name}上的「${input.name}」${size} → ${targetWords(input.to, input.toCaller)}。`
    + '它比较大,还在路上;传完手机上会提示,**不用等着**,接着聊别的。跟他说一句「在传了,传完手机上会提示」。'
}

/** 没传成那一句。**如实说没传成**,别让他以为办好了(D13)。 */
export function notSentText(input: { from: DeviceInfo, to: DeviceInfo, name: string, error: string }): string {
  return `没发过去:${input.from.name}上的「${input.name}」→ ${input.to.name},${input.error}。跟他如实说一声。`
}

/** 挑设备挑不着时那句话。把此刻在线的都报出来,让模型能照着问。 */
export function unknownDeviceText(query: string, devices: readonly DeviceInfo[]): string {
  const list = devices.map(device => device.name).join('、')
  return `没有哪一台在线设备叫「${query}」。此刻在线的是:${list === '' ? '一台都没有' : list}。问他是哪一台。`
}

/**
 * 设备之间那条控制通道 `wb.dev`(2026-09-21)。
 *
 * 为什么不复用 `wb.rpc`:那一条是「工人替**手机**去调 8791」,白名单、降权、只认已配对手机——
 * 一条为别的用途长起来的路。这一条问的是另一件事:「**你那台机器上有没有这个文件**」
 * 「把你那台机器上的这个文件发给他」。两件事混在一个 topic 上,白名单迟早会被谁顺手放宽。
 *
 * 形状与 `wb.rpc` 一致(一行 JSON、带 id、只回给发问的那一个),所以读起来不用换脑子。
 *
 * ## 谁能发
 *
 * 房里的**设备**(已配对的手机、同账号机器上的工人)。测试页那种 `wb-dev-*` 一条都不办 ——
 * 见 devices.ts 的 `deviceOfParticipant`。房间本身由 8791 签的凭证把着门,
 * 所以「房里的设备」这件事不需要在这一层再验一次密码。
 *
 * ## 路径白名单在**执行的那一头**
 *
 * `send` 带的 path 由**被请求的那台机器**自己核:只有它**刚刚回过**的搜索结果里的路径才认。
 * 核在请求方那头是没用的 —— 请求方正是那个可能被模型带偏的地方。
 *
 * 全是纯函数,不碰 LiveKit。
 */
import type { DeviceInfo } from './devices.ts'
import type { DeviceSearchSlice } from './deviceTools.ts'
import type { FoundFile } from './search.ts'

/** 设备之间那条控制通道的 topic。两端唯一的约定。 */
export const DEV_TOPIC = 'wb.dev'

/** 一条回包最多多大(和 wb.rpc 同一个数,理由也一样:病态的大回包会把房间带慢)。 */
export const DEV_MAX_RESPONSE_BYTES = 1024 * 1024

/** 「在你那儿找文件」。 */
export interface DevSearchRequest {
  id: string
  type: 'search'
  query: string
}

/** 「把你那儿的这个文件发给某某」。`to` 是收件人的 identity。 */
export interface DevSendRequest {
  id: string
  type: 'send'
  path: string
  to: string
}

/** 「房里此刻有哪些设备」(手机的记录面板问的就是这一条)。 */
export interface DevDevicesRequest {
  id: string
  type: 'devices'
}

/** 「这台机器上的传输记录」。 */
export interface DevTransfersRequest {
  id: string
  type: 'transfers'
}

export type DevRequest = DevSearchRequest | DevSendRequest | DevDevicesRequest | DevTransfersRequest

export interface DevSearchResponse {
  id: string
  type: 'search'
  device: DeviceInfo
  files: readonly FoundFile[]
  total: number
  truncated: boolean
  /** 没授权 / 一个根都读不到时那句人话。**原样说给他听**,不变成「没找到」。 */
  note?: string
}

export interface DevSendResponse {
  id: string
  type: 'send'
  ok: boolean
  name?: string
  bytes?: number
  error?: string
}

export interface DevDevicesResponse {
  id: string
  type: 'devices'
  devices: readonly DeviceInfo[]
}

export interface DevTransfersResponse {
  id: string
  type: 'transfers'
  records: readonly unknown[]
}

export interface DevErrorResponse {
  id: string
  type: 'error'
  error: string
}

export type DevResponse =
  | DevSearchResponse
  | DevSendResponse
  | DevDevicesResponse
  | DevTransfersResponse
  | DevErrorResponse

/** 一行 JSON → 一条请求。认不出来就说认不出来;连 id 都没有就连回都不回。 */
export function parseDevRequest(text: string): { ok: true, request: DevRequest } | { ok: false, id?: string, error: string } {
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return { ok: false, error: '不是合法 JSON' } }
  if (raw === null || typeof raw !== 'object') return { ok: false, error: '不是一个对象' }
  const message = raw as Record<string, unknown>
  const id = typeof message.id === 'string' && message.id !== '' ? message.id : undefined
  if (id === undefined) return { ok: false, error: '缺 id' }
  if (message.type === 'devices') return { ok: true, request: { id, type: 'devices' } }
  if (message.type === 'transfers') return { ok: true, request: { id, type: 'transfers' } }
  if (message.type === 'search') {
    const query = typeof message.query === 'string' ? message.query.trim() : ''
    if (query === '') return { ok: false, id, error: '搜索那条得带 query' }
    return { ok: true, request: { id, type: 'search', query } }
  }
  if (message.type === 'send') {
    const path = typeof message.path === 'string' ? message.path.trim() : ''
    const to = typeof message.to === 'string' ? message.to.trim() : ''
    if (path === '') return { ok: false, id, error: '传文件那条得带 path' }
    if (to === '') return { ok: false, id, error: '传文件那条得带 to(收件设备)' }
    return { ok: true, request: { id, type: 'send', path, to } }
  }
  return { ok: false, id, error: `不认识这种请求:${String(message.type)}` }
}

/** 回包 → 一行 JSON。太大就换成一条如实的 error,**不发半截 JSON 过去**。 */
export function encodeDevResponse(response: DevResponse): string {
  const text = JSON.stringify(response)
  if (Buffer.byteLength(text, 'utf8') <= DEV_MAX_RESPONSE_BYTES) return text
  return JSON.stringify({ id: response.id, type: 'error', error: '回包太大,这条路送不过去' })
}

/** 一行 JSON → 一条回包。解不出来就 undefined。 */
export function parseDevResponse(text: string): DevResponse | undefined {
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return undefined }
  if (raw === null || typeof raw !== 'object') return undefined
  const message = raw as Record<string, unknown>
  if (typeof message.id !== 'string' || message.id === '') return undefined
  const type = message.type
  if (type !== 'search' && type !== 'send' && type !== 'devices' && type !== 'transfers' && type !== 'error') return undefined
  return message as unknown as DevResponse
}


/**
 * 办一条 `wb.dev` 要的那几样。agent.ts 传真的进来(房间、磁盘),测试传假的。
 */
export interface DevPort {
  /** 这台机器自己。 */
  self: DeviceInfo
  /** 此刻在线的设备(含自己)。 */
  devices: () => readonly DeviceInfo[]
  /** 在**本机**按文件名找(只在授权目录里,见 search.ts)。 */
  searchHere: (query: string) => Promise<DeviceSearchSlice>
  /** 把**本机**一个文件发给房里某一台。 */
  sendLocal: (input: { path: string, to: DeviceInfo }) => Promise<
    { ok: true, name: string, bytes: number } | { ok: false, error: string }
  >
  /** 本机的传输流水(记录面板问的就是它)。 */
  recentTransfers: () => Promise<readonly unknown[]>
  /**
   * **这台机器刚刚真的搜出来过的路径**。`send` 只认它 —— 白名单在**执行的那一头**,
   * 核在请求方那边等于没核(请求方正是那个可能被模型带偏的地方)。
   */
  found: Set<string>
}

/**
 * 一条请求 → 一条回包。**绝不抛**:房里来的东西什么样都可能。
 *
 * `asker` 由调用方从参与者身份算好再传进来(不是设备就压根不会走到这里)。
 */
export async function handleDevRequest(request: DevRequest, ctx: DevPort & { asker: DeviceInfo }): Promise<DevResponse> {
  try {
    if (request.type === 'devices') {
      return { id: request.id, type: 'devices', devices: ctx.devices() }
    }
    if (request.type === 'transfers') {
      return { id: request.id, type: 'transfers', records: await ctx.recentTransfers() }
    }
    if (request.type === 'search') {
      const slice = await ctx.searchHere(request.query)
      for (const file of slice.files) ctx.found.add(file.path)
      return {
        id: request.id,
        type: 'search',
        device: ctx.self,
        files: slice.files,
        total: slice.total,
        truncated: slice.truncated,
        ...(slice.note === undefined ? {} : { note: slice.note }),
      }
    }
    // send:两道闸 —— 路径必须是我刚刚搜出来的,收件人必须此刻真的在房里。
    if (!ctx.found.has(request.path)) {
      return { id: request.id, type: 'send', ok: false, error: '这条路径不是我刚刚搜出来的,不传' }
    }
    const target = ctx.devices().find(device => device.identity === request.to)
    if (target === undefined) {
      return { id: request.id, type: 'send', ok: false, error: '那台设备此刻不在房里' }
    }
    const sent = await ctx.sendLocal({ path: request.path, to: target })
    return sent.ok
      ? { id: request.id, type: 'send', ok: true, name: sent.name, bytes: sent.bytes }
      : { id: request.id, type: 'send', ok: false, error: sent.error }
  }
  catch (err) {
    return { id: request.id, type: 'error', error: (err as Error)?.message ?? '没办成,也没说原因' }
  }
}

/**
 * 在线设备表 + 传输流水(2026-09-21,「设备间传文件」那张卡)。
 *
 * **真相在房间里**,不在这儿:谁在线是 LiveKit 说了算。工人常驻在房里,进出一有变化就往
 * `POST /channel/devices` 报一份;这个文件只是把最近那一份存着,好让**电脑端**
 * `GET /devices/online` 有东西可看(8791 自己不进房,问一次 livekit-server 要 3 秒超时,
 * 不该挂在一条界面轮询的路上)。
 *
 * 所以这份表有两条纪律:
 *   ① **带时间戳**。陈旧的表比没有表更害人 —— 读的那一头要能自己判断「这是几秒前的」。
 *      超过 {@link DEVICES_STALE_MS} 就如实标 `stale: true`,不假装还在线。
 *   ② **只存工人报上来的**。页面、手机都只能读,不能写(路由那一层把门:只认回环)。
 *
 * 传输流水同理:工人每传一次报一条,这里留最近 {@link TRANSFER_KEEP} 条。
 * **记录里不写文件内容**,只有名字、大小、两头的设备名、时间、成没成。
 */

/** 多久没报就算陈旧。工人在设备进出时报,2026-09-23 晚起平时每 60 秒也再报一遍(channel-worker `DEVICES_HEARTBEAT_MS`)。 */
export const DEVICES_STALE_MS = 5 * 60 * 1000

/** 流水最多留几条。它是给人看的最近记录,不是账本。 */
export const TRANSFER_KEEP = 200

/**
 * 设备目录里这是哪一类。2026-09-23 多了 `handset`(树莓派上那只实体话筒)——
 * 手机的座机页靠这一项判「话筒在不在线」(butler-app/src/deskphone/useHandsetOnline.ts
 * 只认 `handset`),丢掉它那一页就只能说「问不到」,而那是假的。
 */
export type DeviceKind = 'mac' | 'phone' | 'handset'

/** 配对记录里的种类(server/devices.ts 的 `deviceKindOf`),按 device_id 索引。 */
export type PairedKinds = ReadonlyMap<string, 'phone' | 'handset'>

/**
 * 用**配对记录**校正上报里的 kind(2026-09-23)。
 *
 * 为什么要这一层:工人报上来的 kind 追根到底来自进房凭证里的属性,而凭证有两条签发路径 ——
 * 本机 8791 签的那张按配对记录带 `wb_kind`,**中转签的那张没有**(中转的设备种类里
 * 一度只有 phone/other,派注册成了 other)。于是同一只话筒走中转进房就被当成手机:
 * 座机页说「座机不在线」、「换网络」按不了。
 *
 * 配对记录是**本机的真相**(devices.json 是 Ben 自己配对时写下的),凭证属性只是它的影子。
 * 所以对得上配对记录的,以配对记录为准;对不上的(工人自己、另一台电脑)原样保留 ——
 * 电脑的 device_id 是工人身份,永远匹配不到一条配对记录。
 */
export function withPairedKinds(
  devices: readonly OnlineDevice[],
  paired: PairedKinds | undefined,
): readonly OnlineDevice[] {
  if (paired === undefined || paired.size === 0) return devices
  return devices.map((device) => {
    const kind = paired.get(device.device_id)
    return kind === undefined || kind === device.kind ? device : { ...device, kind }
  })
}

export interface OnlineDevice {
  identity: string
  device_id: string
  name: string
  kind: DeviceKind
}

export interface TransferEntry {
  at: string
  direction: 'out' | 'in'
  peer: string
  name: string
  bytes: number
  ok: boolean
  error?: string
  by?: string
  /**
   * ★ **这一次传的是哪张取件单**(2026-10-04,卡 `claude/phone-file-send-loop`)。
   *
   * 「要一份文件」那一类事项的"办完"以回执为准(`fileDelivery.ts`),而出门那条路的
   * 完成事实只有工人知道(它用 `wb.file` 把字节推过去)。工人报这条记录时带上单号,
   * 8791 就能按单号认出这是哪一件事的回执。**老工人不带这一格**(缺席 = 认不出是哪一件,
   * 照旧只是一条流水,不编一个单号)。
   */
  offer?: string
}

export interface DevicesView {
  devices: readonly OnlineDevice[]
  /** 工人最后一次报是什么时候(ISO)。从没报过就缺席。 */
  reported_at?: string
  /** 这份表是不是已经旧了(工人掉线、工作台刚重启)。 */
  stale: boolean
  /** 一句人话。没有工人报过时说清楚是这一种「空」,而不是「一台设备都没有」。 */
  note?: string
}

/** 一条上报 → 一台设备。**认不出来的一律丢掉**(房里来的东西经过工人,但工人也可能是旧版)。 */
export function parseOnlineDevice(raw: unknown): OnlineDevice | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  const identity = text(item.identity)
  if (identity === undefined) return undefined
  const kind = item.kind === 'mac' || item.kind === 'phone' || item.kind === 'handset' ? item.kind : undefined
  if (kind === undefined) return undefined
  return {
    identity,
    device_id: text(item.device_id) ?? identity,
    name: text(item.name) ?? identity,
    kind,
  }
}

/** 一条上报 → 一条流水。同样**认不出来就丢**。 */
export function parseTransferEntry(raw: unknown): TransferEntry | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  if (typeof item.name !== 'string' || item.name === '') return undefined
  if (item.direction !== 'out' && item.direction !== 'in') return undefined
  const at = typeof item.at === 'string' && item.at !== '' ? item.at : new Date().toISOString()
  return {
    at,
    direction: item.direction,
    peer: typeof item.peer === 'string' && item.peer !== '' ? item.peer : '不知道是谁',
    name: item.name,
    bytes: typeof item.bytes === 'number' && Number.isFinite(item.bytes) ? item.bytes : 0,
    ok: item.ok !== false,
    ...(typeof item.error === 'string' && item.error !== '' ? { error: item.error } : {}),
    ...(typeof item.by === 'string' && item.by !== '' ? { by: item.by } : {}),
    ...(typeof item.offer === 'string' && item.offer !== '' ? { offer: item.offer } : {}),
  }
}

export interface DeviceDirectoryService {
  /**
   * 工人报一份在线设备。回的是真正收下的那几台。
   * `source`(2026-10-22,卡 M6):两条工人各在一间房,各报各的(`lan` / `relay`),表是几份合起来 —— 不带就是老工人那一份整表。
   */
  report: (devices: readonly unknown[], source?: string) => readonly OnlineDevice[]
  /**
   * 此刻这份表(带时间戳与陈旧标记)。
   * `pairedKinds` 给了就按配对记录校正每台的 kind(见 {@link withPairedKinds})。
   */
  view: (pairedKinds?: PairedKinds) => DevicesView
  /** 工人报一条传输。 */
  addTransfer: (raw: unknown) => TransferEntry | undefined
  /** 最近几条传输,**新的在前**。 */
  transfers: (limit?: number) => readonly TransferEntry[]
}

export function createDeviceDirectoryService(
  deps: { now?: () => number, staleMs?: number, keep?: number } = {},
): DeviceDirectoryService {
  const now = deps.now ?? (() => Date.now())
  const staleMs = deps.staleMs ?? DEVICES_STALE_MS
  const keep = deps.keep ?? TRANSFER_KEEP
  /** 每条工人报的那一份(键是路线;老工人不报路线 = 空串)。 */
  const reports = new Map<string, { devices: readonly OnlineDevice[], at: number }>()
  const entries: TransferEntry[] = []

  return {
    report(raw, source = '') {
      const parsed: OnlineDevice[] = []
      const seen = new Set<string>()
      for (const item of raw) {
        const device = parseOnlineDevice(item)
        if (device === undefined || seen.has(device.identity)) continue
        seen.add(device.identity)
        parsed.push(device)
      }
      reports.set(source, { devices: parsed, at: now() })
      return parsed
    },
    view(pairedKinds) {
      if (reports.size === 0) {
        return {
          devices: [],
          stale: true,
          note: '工人还没报过在线设备(它可能没起来,或者这台工作台还没接通道层)。',
        }
      }
      const at = now()
      /*
       * 几份合起来:只算还新鲜的那几份(一条工人没了,它报的那几台不该一直挂在「在线」上);
       * 全都旧了就照老样子给最近那一份并标旧。工人自己在两间房里同名,按身份去重只算一次。
       */
      const all = [...reports.values()]
      const fresh = all.filter(one => at - one.at <= staleMs)
      const newest = all.reduce((a, b) => (b.at > a.at ? b : a))
      const picked = fresh.length > 0 ? fresh : [newest]
      const seen = new Set<string>()
      const devices = picked.flatMap(one => one.devices).filter((device) => {
        if (seen.has(device.identity)) return false
        seen.add(device.identity)
        return true
      })
      const reportedAt = newest.at
      const stale = at - reportedAt > staleMs
      return {
        devices: withPairedKinds(devices, pairedKinds),
        reported_at: new Date(reportedAt).toISOString(),
        stale,
        ...(stale ? { note: '这份表已经有一会儿没更新了,工人可能掉线了。' } : {}),
      }
    },
    addTransfer(raw) {
      const entry = parseTransferEntry(raw)
      if (entry === undefined) return undefined
      entries.push(entry)
      while (entries.length > keep) entries.shift()
      return entry
    },
    transfers(limit = 50) {
      return entries.slice(-limit).reverse()
    },
  }
}

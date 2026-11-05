/**
 * 设备目录(2026-09-21,「设备间传文件」那张卡)。
 *
 * 一个房间里现在不止「一台手机 + 一个工人」了:同一个账号的每台电脑各跑一个工人,
 * 每台手机各进一次房。要把文件从 A 传到 B、要让事务官「去某台设备上找文件」,
 * 先得有一张**谁在线**的表。
 *
 * ## 身份从哪来:凭证,不是自称
 *
 * 每张进房凭证由 8791 签,里头带两样:
 *   - `metadata`:一行 JSON `{device_id, name, kind}` —— 这张卡新加的;
 *   - `attributes.wb_device_id`:老的那一样(房间代理靠它降权,见 rpc.ts)。
 *
 * 两样**持证人都改不了**(授权里没有 `canUpdateOwnMetadata`)。所以这张表不是「房里谁说自己是谁」,
 * 是「8791 签了谁是谁」。metadata 缺席(老版本的工作台签的凭证)时退回 attributes + identity 前缀,
 * 名字就只能是 identity —— **如实显示**,不编一个好看的名字。
 *
 * ## 什么算一台设备
 *
 * 只有两种:`wb-phone-*`(已配对的手机)、`wb-channel-worker*`(某台电脑上的工人)。
 * 浏览器测试页那种 `wb-dev-*` **不进表** —— 它不是设备,不该出现在「发到…」的选单里,
 * 也不该能让别的机器替它找文件。
 *
 * 这个文件里全是纯函数 + 一张 Map,不碰 LiveKit,单测里不用起房间。
 */

export type DeviceKind = 'mac' | 'phone'

/** 工人的身份前缀。第一台电脑就是这个字符串本身(手机只认它);别的电脑是 `wb-channel-worker-<后缀>`。 */
export const WORKER_IDENTITY_PREFIX = 'wb-channel-worker'

/** 手机的身份前缀(与 rpc.ts 的 PHONE_IDENTITY_PREFIX 同一个字符串)。 */
export const PHONE_IDENTITY_PREFIX = 'wb-phone-'

export interface DeviceInfo {
  /** 房里的身份。传文件时的收件人就是它。 */
  identity: string
  /** 设备 id(凭证里签的)。 */
  device_id: string
  /** 给人看的名字(「Ben 的手机」「书房 Mac」)。取不到就等于 identity,不编。 */
  name: string
  kind: DeviceKind
}

/** 这条身份是哪一类设备。两种之外一律 undefined —— **不是设备就不是设备**。 */
export function deviceKindOfIdentity(identity: string): DeviceKind | undefined {
  if (typeof identity !== 'string' || identity === '') return undefined
  if (identity.startsWith(PHONE_IDENTITY_PREFIX)) return 'phone'
  if (identity.startsWith(WORKER_IDENTITY_PREFIX)) return 'mac'
  return undefined
}

/** 一台设备 → 凭证里那行 JSON。8791 签凭证时用,工人自己进房时也用。 */
export function encodeDeviceMetadata(input: { device_id: string, name: string, kind: DeviceKind }): string {
  return JSON.stringify({ device_id: input.device_id, name: input.name, kind: input.kind })
}

/** 那行 JSON → 三个字段。**解不出来就 undefined**,一行坏 metadata 不该把整张表带走。 */
export function parseDeviceMetadata(raw: unknown): { device_id?: string, name?: string, kind?: DeviceKind } | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { return undefined }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  const kind = obj.kind === 'mac' || obj.kind === 'phone' ? obj.kind : undefined
  return {
    ...(text(obj.device_id) === undefined ? {} : { device_id: text(obj.device_id) as string }),
    ...(text(obj.name) === undefined ? {} : { name: text(obj.name) as string }),
    ...(kind === undefined ? {} : { kind }),
  }
}

export interface ParticipantLike {
  identity?: string | undefined
  metadata?: string | undefined
  attributes?: Record<string, string> | undefined
  /** 房里显示的名字(凭证里的 `name`)。metadata 缺席时的第二来源。 */
  name?: string | undefined
}

/** 凭证里带设备 id 的属性名(与 workbench-plugin/src/server/channel.ts 同一个字符串)。 */
export const DEVICE_ATTRIBUTE = 'wb_device_id'

/**
 * 一个参与者 → 一台设备。**不是设备就 undefined**(测试页、别的什么东西)。
 *
 * 取值顺序都是「签过的 > 推出来的」:
 *   device_id  metadata > attributes > identity 去掉前缀;
 *   name       metadata > 凭证里的 name > identity(**不编**);
 *   kind       metadata > identity 前缀。identity 前缀说不上来的,metadata 说了也不算 ——
 *              前缀是 LiveKit 按 `sub` 强制的,metadata 只是跟着签的一行字。
 */
export function deviceOfParticipant(participant: ParticipantLike): DeviceInfo | undefined {
  const identity = participant.identity ?? ''
  const kindByIdentity = deviceKindOfIdentity(identity)
  if (kindByIdentity === undefined) return undefined
  const meta = parseDeviceMetadata(participant.metadata)
  const signed = participant.attributes?.[DEVICE_ATTRIBUTE]
  const fromAttribute = typeof signed === 'string' && signed.trim() !== '' ? signed.trim() : undefined
  const suffix = kindByIdentity === 'phone'
    ? identity.slice(PHONE_IDENTITY_PREFIX.length)
    : identity.slice(WORKER_IDENTITY_PREFIX.length).replace(/^-/, '')
  const deviceId = meta?.device_id ?? fromAttribute ?? (suffix === '' ? identity : suffix)
  const name = meta?.name
    ?? (typeof participant.name === 'string' && participant.name.trim() !== '' ? participant.name.trim() : undefined)
    ?? identity
  return { identity, device_id: deviceId, name, kind: kindByIdentity }
}

/**
 * 按一句话挑一台设备。电话里他说的是**名字**(「发到书房那台 Mac」),不是 identity。
 *
 * 比法从严到宽:identity 全等 > device_id 全等 > 名字全等(忽略大小写与空格)>
 * 名字包含。**宽的那一档命中多于一台就当没命中** —— 传错机器比传不过去糟。
 */
export function pickDevice(devices: readonly DeviceInfo[], query: string): DeviceInfo | undefined {
  const raw = (query ?? '').trim()
  if (raw === '') return undefined
  const norm = (value: string): string => value.toLowerCase().replace(/\s+/g, '')
  const wanted = norm(raw)
  const byIdentity = devices.find(device => device.identity === raw)
  if (byIdentity !== undefined) return byIdentity
  const byId = devices.find(device => device.device_id === raw)
  if (byId !== undefined) return byId
  const exact = devices.filter(device => norm(device.name) === wanted)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return undefined
  const loose = devices.filter(device => norm(device.name).includes(wanted) || wanted.includes(norm(device.name)))
  return loose.length === 1 ? loose[0] : undefined
}

/** 一句能念出来的设备清单。电话里要用,所以不出现 identity。 */
export function spokenDeviceList(devices: readonly DeviceInfo[]): string {
  if (devices.length === 0) return '此刻房里一台设备都没有。'
  return devices.map(device => `${device.name}(${device.kind === 'mac' ? '电脑' : '手机'})`).join('、')
}

export interface DeviceDirectory {
  /** 这台机器自己。永远排在第一位。 */
  self: () => DeviceInfo
  /** 此刻在线的(含自己)。 */
  list: () => readonly DeviceInfo[]
  /** 除自己以外的。 */
  others: () => readonly DeviceInfo[]
  /** 有人进房 / 属性变了。不是设备就忽略,返回值说「收没收」。 */
  upsert: (participant: ParticipantLike) => DeviceInfo | undefined
  /** 有人走了。 */
  remove: (identity: string) => void
  /** 整屋重来(进房那一刻按 remoteParticipants 铺一遍)。 */
  reset: (participants: readonly ParticipantLike[]) => void
  find: (query: string) => DeviceInfo | undefined
}

/** 在线设备表。一张 Map 而已,写成一个对象是为了「自己永远在表里」这条不被谁忘掉。 */
export function createDeviceDirectory(self: DeviceInfo): DeviceDirectory {
  const online = new Map<string, DeviceInfo>()
  const all = (): readonly DeviceInfo[] => [self, ...online.values()]
  return {
    self: () => self,
    list: all,
    others: () => [...online.values()],
    upsert(participant) {
      const device = deviceOfParticipant(participant)
      // 自己不进 online(它已经在 all() 的第一位);不是设备的一律不收。
      if (device === undefined || device.identity === self.identity) return undefined
      online.set(device.identity, device)
      return device
    },
    remove(identity) {
      online.delete(identity)
    },
    reset(participants) {
      online.clear()
      for (const participant of participants) {
        const device = deviceOfParticipant(participant)
        if (device === undefined || device.identity === self.identity) continue
        online.set(device.identity, device)
      }
    },
    find(query) {
      return pickDevice(all(), query)
    },
  }
}

/** 报给 8791 的那一份里多一种:树莓派话筒(workbench-plugin/src/server/deviceDirectory.ts 的 `DeviceKind`)。 */
export type ReportedDevice = Omit<DeviceInfo, 'kind'> & { kind: DeviceKind | 'handset' }

/**
 * 报给 8791 的在线表(2026-09-28 真机)。
 *
 * 工人自己这张表只分电脑 / 手机(话筒的身份也是 `wb-phone-` 开头),8791 那头原先靠本机配对表把
 * 话筒纠正回来 —— 可经「添加座机」记在**账号**下的座机根本不在那台电脑的配对表里,于是一直被报成
 * 手机,手机「给座机换网络」找不到话筒、说「座机不在线」,而同一时刻座机正在通话。
 *
 * 所以报之前按**凭证里签的 `wb_kind`**(`kindOf`,即 rpc.ts 的 participantKindOf)把话筒标出来 ——
 * 与挑接话对象同一个来源,两边不会一个说在、一个说不在。电脑不看这一项。
 */
export function reportedDevices(
  devices: readonly DeviceInfo[],
  kindOf: (identity: string) => 'phone' | 'handset',
): readonly ReportedDevice[] {
  return devices.map(device => (device.kind === 'phone' && kindOf(device.identity) === 'handset'
    ? { ...device, kind: 'handset' as const }
    : device))
}

/**
 * **在线表心跳**(2026-09-23 晚,维护者真机:话筒明明在线,App 上写「话筒不在线」)。
 *
 * 以前工人只在**有人进出**时往 8791 报在线表,而 8791 超过 5 分钟没新报就把整张表标
 * `stale` 并附一句「这份表已经有一会儿没更新了」(workbench-plugin/src/server/deviceDirectory.ts
 * 的 `DEVICES_STALE_MS`)—— App 见这句附言就当「问不到」。于是话筒安安稳稳在房里放上十分钟,
 * 手机就说它不在了;8791 重启之后表是空的,直到下一次有人进出。
 *
 * 修法是最小的那一种:**定时把同一张表再报一遍**。60 秒 = 8791 那个阈值(5 分钟)的五分之一,
 * 丢一两拍也不会被标旧;8791 重启之后最多 60 秒表就回来。代价:每分钟一条本机回环 HTTP。
 */
export const DEVICES_HEARTBEAT_MS = 60_000

export interface DevicesHeartbeatDeps {
  /** 报一次(把当下那张表发给 8791)。抛了 / 拒了都吞掉,下一拍再报。 */
  report: () => unknown
  everyMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

/** 起一根心跳,返回停掉它的函数。 */
export function startDevicesHeartbeat(deps: DevicesHeartbeatDeps): () => void {
  const every = deps.everyMs ?? DEVICES_HEARTBEAT_MS
  const set = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clear = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  const handle = set(() => {
    try {
      const result = deps.report()
      if (result instanceof Promise) result.catch(() => {})
    }
    catch { /* 报不上去只是电脑端那张表旧一点,下一拍再来 */ }
  }, every)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clear(handle)
  }
}

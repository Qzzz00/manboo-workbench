/** 按需 LAN 传输:复用设备配对;凭据留在 0600 文件,频道事实走 tasks.json。 */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isIP } from 'node:net'
import type { DeviceView, LanChannelMessage, MessageDelivery } from '../protocol.ts'
import type { TasksService } from './tasks.ts'
import { parseReceipt } from './noteReceipt.ts'
import { sanitizeLanMessage } from './collabStore.ts'
import type { LanSourceMaterial } from './collabChannelSources.ts'
type Peer = { member_id: string, host: string, port: number, token: string }
const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
function localHost(v: unknown): v is string {
  if (typeof v !== 'string' || isIP(v) !== 4) return false
  const p = v.split('.').map(Number)
  return p[0] === 10 || p[0] === 127 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1]! >= 16 && p[1]! <= 31
}
export function createLanTransport(tasks: TasksService, peerFile: () => Promise<string>) {
  let writes = Promise.resolve()
  let sending = Promise.resolve()
  async function peers(): Promise<Peer[]> {
    try {
      const raw: unknown = JSON.parse(await readFile(await peerFile(), 'utf8'))
      return Array.isArray(raw) ? raw.filter((p): p is Peer => typeof p === 'object' && p !== null && localHost(p.host) && Number.isInteger(p.port) && p.port > 0 && p.port <= 65535 && typeof p.member_id === 'string' && typeof p.token === 'string') : []
    } catch { return [] }
  }
  async function remember(peer: Peer): Promise<void> {
    writes = writes.then(async () => {
      const file = await peerFile(), current = await peers()
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify([...current.filter(p => p.member_id !== peer.member_id), peer]), { mode: 0o600 })
      await rename(tmp, file); await chmod(file, 0o600)
    }); await writes
  }
  async function request(peer: Pick<Peer, 'host' | 'port'>, path: string, body?: unknown, token?: string) {
    const res = await fetch(`http://${peer.host}:${peer.port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: 'error' })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  async function knownProject(project: string): Promise<boolean> { const s = await tasks.list(); return s.tasks.some(t => t.project_id === project) || (s.goals ?? []).some(g => g.project_id === project) }
  return {
    async pairedMemberIds(): Promise<string[]> { return (await peers()).map(p => p.member_id) },
    async publishSource(material: LanSourceMaterial, recipients: readonly string[]) {
      const previous = sending
      let release!: () => void
      sending = new Promise<void>(resolve => { release = resolve })
      await previous
      try {
        const self = await tasks.lanIdentity(), old = (await tasks.lanChannel(material.project_id)).find(m => m.author.member_id === self.member_id && m.source?.id === material.source.id)
        const message = old ?? sanitizeLanMessage({ ...material, id: `lan-source-${createHash('sha256').update(JSON.stringify([self.member_id, material.project_id, material.source.id])).digest('hex').slice(0, 32)}`,
          kind: 'message', author: { member_id: self.member_id, name: self.name }, at: new Date().toISOString() })
        if (message === undefined) return { status: 409, error: '正式来源材料无效,已有内容保留' }
        const deliveries = [...(message.deliveries ?? [])]
        const todo = recipients.filter(to => !deliveries.some(d => d.to === to && (d.status === 'delivered' || d.status === 'accepted')))
        if (todo.length === 0) return { status: 200, message }
        for (const to of todo) if (!deliveries.some(d => d.to === to)) deliveries.push({ to, status: 'pending', at: new Date().toISOString() })
        if (!(await tasks.saveLanMessage({ ...message, deliveries })).ok) return { status: 409, error: '来源快照编号冲突,已有内容保留' }
        const known = await peers()
        for (const to of todo) {
          const peer = known.find(p => p.member_id === to)
          let result: MessageDelivery = { to, status: 'failed', at: new Date().toISOString(), error: '成员未配对,投递范围未知' }
          if (peer !== undefined) {
            try {
              const response = await request(peer, '/collab/lan/receive', { message }, peer.token)
              const receipt = response.body.receipt as Record<string, unknown> | undefined
              if (response.status === 200 && receipt?.message_id === message.id && receipt.member_id === to && typeof receipt.at === 'string' && Number.isFinite(Date.parse(receipt.at))) result = { to, status: 'delivered', at: receipt.at }
              else result.error = typeof response.body.error === 'string' ? response.body.error : '对端没有返回匹配的来源投递回执'
            } catch { result.error = '对端失联,是否收到未知;保留原来源快照后重试' }
          }
          const index = deliveries.findIndex(d => d.to === to)
          deliveries[index] = result
        }
        const saved = { ...message, deliveries }
        await tasks.saveLanMessage(saved)
        return { status: 200, message: saved, ...(deliveries.some(d => d.status === 'failed') ? { error: '部分来源投递失败或未知,原材料已保留' } : {}) }
      } finally { release() }
    },
    async ping(memberId: string): Promise<{ member_id: string, name: string } | undefined> {
      const peer = (await peers()).find(p => p.member_id === memberId)
      if (peer === undefined) return undefined
      try {
        const got = await request(peer, '/collab/lan/hello', undefined, peer.token)
        return got.status === 200 && got.body.member_id === memberId && typeof got.body.name === 'string' ? { member_id: memberId, name: got.body.name } : undefined
      } catch { return undefined }
    },
    async connect(body: Record<string, unknown>) {
      if (!localHost(body.host) || typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535 || text(body.code) === undefined || text(body.member_id) === undefined) return { status: 400, error: '需要局域网 IPv4、端口、配对码及对端稳定身份' }
      try {
        const self = await tasks.lanIdentity(), endpoint = { host: body.host, port: body.port }
        const claim = await request(endpoint, '/pair/claim', { code: body.code, device_name: `LAN:${self.member_id}`, platform: 'collab-peer' })
        if (claim.status !== 200 || typeof claim.body.token !== 'string') return { status: 409, error: '协作成员配对失败,请核对对端配对码' }
        const hello = await request(endpoint, '/collab/lan/hello', undefined, claim.body.token)
        if (hello.body.member_id !== body.member_id || typeof hello.body.name !== 'string') return { status: 409, error: '对端稳定身份与所选成员不符' }
        await remember({ ...endpoint, member_id: body.member_id as string, token: claim.body.token })
        await tasks.rememberLanMember({ ...endpoint, memberId: body.member_id as string, name: hello.body.name })
        return { status: 200, ok: true, member_id: body.member_id }
      } catch { return { status: 409, error: '对端未连接,配对结果未知' } }
    },
    async receive(body: Record<string, unknown>, device?: DeviceView) {
      if (device?.platform !== 'collab-peer' || !device.name.startsWith('LAN:')) return { status: 403, error: '需要已配对的协作成员身份' }
      const message = sanitizeLanMessage(body.message)
      if (message === undefined || device.name !== `LAN:${message.author.member_id}`) return { status: 403, error: '消息来源与配对身份不一致' }
      if (message.kind === 'report' && parseReceipt(message.text) === undefined) return { status: 409, error: '报告要以做完 / 有异议 / 卡住开头' }
    if (!await knownProject(message.project_id)) return { status: 409, error: '这台未加入该项目' }
      if (message.kind === 'report' && !(await tasks.lanChannel(message.project_id)).some(m => m.id === message.reply_to)) return { status: 409, error: '报告找不到同项目原消息' }
      const { deliveries: _ignored, ...incoming } = message
      const saved = await tasks.saveLanMessage(incoming, true)
      if (!saved.ok) return { status: 409, error: '同一消息编号的原文已落账,不能改写' }
      return { status: 200, ok: true, receipt: saved.receipt }
    },
    async send(body: Record<string, unknown>) {
      if (['category', 'source', 'topic', 'refs'].some(key => body[key] !== undefined)) return { status: 403, error: '正式来源只由本机来源发布器生成' }
      const previous = sending
      let release!: () => void
      sending = new Promise<void>(resolve => { release = resolve })
      await previous
      try {
        const project = text(body.project_id), said = text(body.text)
        const recipients = Array.isArray(body.recipients) ? [...new Set(body.recipients.filter((v): v is string => typeof v === 'string'))] : []
        if (project === undefined || said === undefined || recipients.length === 0) return { status: 400, error: '项目、消息和接收成员都要带' }
        if (body.kind === 'report' && parseReceipt(said) === undefined) return { status: 409, error: '报告要以做完 / 有异议 / 卡住开头' }
      if (!await knownProject(project)) return { status: 409, error: '这台未加入该项目' }
        const old = await tasks.lanChannel(project), self = await tasks.lanIdentity()
        if (body.kind === 'report' && !old.some(m => m.id === body.reply_to)) return { status: 409, error: '报告找不到同项目原消息' }
        const duplicate = text(body.client_msg_id) === undefined ? undefined : old.find(m => m.author.member_id === self.member_id && m.client_msg_id === body.client_msg_id)
        if (duplicate !== undefined) return { status: 200, ok: true, duplicated: true, message: duplicate }
        const message: LanChannelMessage = { id: text(body.id) ?? `lan-${randomUUID()}`, project_id: project, author: { member_id: self.member_id, name: self.name }, text: said, kind: body.kind === 'report' ? 'report' : 'message', at: new Date().toISOString(), ...(text(body.client_msg_id) === undefined ? {} : { client_msg_id: body.client_msg_id as string }), ...(text(body.reply_to) === undefined ? {} : { reply_to: body.reply_to as string }), deliveries: recipients.map(to => ({ to, status: 'pending', at: new Date().toISOString() })) }
        if (!(await tasks.saveLanMessage(message)).ok) return { status: 409, error: '同一消息编号的原文已落账,不能改写' }
        const known = await peers(), deliveries: MessageDelivery[] = []
        for (const to of recipients) {
          const peer = known.find(p => p.member_id === to)
          let result: MessageDelivery = { to, status: 'failed', at: new Date().toISOString(), error: '成员未配对,投递范围未知' }
          if (peer !== undefined) {
            try {
              const response = await request(peer, '/collab/lan/receive', { message }, peer.token)
              const receipt = response.body.receipt as Record<string, unknown> | undefined
              result = response.status === 200 && receipt?.message_id === message.id && receipt.member_id === to
                ? { to, status: 'delivered', at: receipt.at as string }
                : { ...result, error: typeof response.body.error === 'string' ? response.body.error : '对端没有返回匹配的投递回执' }
            } catch { result = { ...result, error: '对端失联,是否收到未知;请核对后再重试' } }
          }
          deliveries.push(result)
        }
        const saved = { ...message, deliveries }
        await tasks.saveLanMessage(saved)
        return { status: 200, ok: true, message: saved }
      } finally { release() }
    },
  }
}

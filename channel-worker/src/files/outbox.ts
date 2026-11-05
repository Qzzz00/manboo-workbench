/**
 * 发文件:**把文件放进发件目录**,工人就把它发出去。
 *
 * 为什么是一个目录,不是一条指令:
 *   - 不能让房间里的消息随便指定「发哪个本机文件」—— 那等于给房里任何人一条读任意本机文件的路;
 *   - 也不该让接话模型自己挑文件发 —— 它是听错话就会办错事的那一环。
 *   发件目录是**他自己在电脑上放进去的**,意图明确,边界也明确。
 *
 * (2026-09-21 补:事务官确实多了一条「找文件并传过去」的路,但那一条有两道闸 ——
 *  只在授权目录里找、只传**刚刚搜出来的那条路径**,而且传之前要在电话里复述确认。
 *  见 search.ts 与 tools.ts。发件目录这一条一个字都没放宽。)
 *
 * ## 发到哪一台(2026-09-21,这张卡)
 *
 * 发件目录底下,每台在线设备一个子目录:「发给-Ben的手机」「发给-书房Mac」。
 * **拖进哪个文件夹就发给哪一台** —— 他不用打一条命令,也不用记 identity。
 * 直接放在发件目录根下的,照旧**发给房里所有设备**(保持 09-17 那版的行为)。
 *
 * 发完不删,移到 `已发送/` —— 删他的文件不是工人该有的权力。移不动就留在原地并记一条,
 * 下一拍会再发一次(宁可重发也不要静默丢)。
 *
 * 这里只有纯函数 + 扫目录/建目录;真正 `sendFile` 在 agent.ts,因为那要房间。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DeviceInfo } from './devices.ts'
import { MAX_TRANSFER_BYTES } from './inbox.ts'

/** 发完的文件挪到哪。就在发件目录底下,一眼能看见「发过了」。 */
export const SENT_SUBDIR = '已发送'

/** 「发给某台设备」的子目录前缀。中文,因为它是给人在访达里认的。 */
export const TO_DEVICE_PREFIX = '发给-'

/** 发件目录里那份说明文件。他第一次打开这个文件夹时看见的就是它。 */
export const OUTBOX_README = '怎么用.txt'

/** 单个文件的上限。定义在 inbox.ts —— 收发两头必须是同一个数。 */
export { MAX_TRANSFER_BYTES } from './inbox.ts'

/** 设备名 → 子目录名。访达里不能有 `/`,别的字符原样留着(中文名字要好认)。 */
export function outboxDirNameOf(device: { name: string }): string {
  const clean = device.name.replace(/[/\\:]/g, '-').trim()
  return `${TO_DEVICE_PREFIX}${clean === '' ? '不知名设备' : clean}`
}

export interface OutboxCandidate {
  name: string
  size: number
}

/**
 * 这一拍该发哪些。规矩三条:
 *   - 点开头的不发(`.DS_Store`、编辑器的临时文件);
 *   - `已发送` 与 `发给-…` 那几个子目录、以及那份说明不发(前者是目录,后者是我们自己写的);
 *   - 空文件不发(多半是还在写的半个文件)。
 */
export function outboxPicks(entries: readonly OutboxCandidate[]): readonly string[] {
  return entries
    .filter(entry => !entry.name.startsWith('.')
      && entry.name !== SENT_SUBDIR
      && entry.name !== OUTBOX_README
      && !entry.name.startsWith(TO_DEVICE_PREFIX)
      && entry.size > 0)
    .map(entry => entry.name)
}

export interface ScanOutboxDeps {
  dir: string
  readdirImpl?: (dir: string) => Promise<readonly string[]>
  statImpl?: (path: string) => Promise<{ size: number, isFile: boolean }>
}

async function listFiles(deps: ScanOutboxDeps, dir: string): Promise<readonly OutboxCandidate[]> {
  const readdirImpl = deps.readdirImpl ?? (async (target: string) => await readdir(target))
  const statImpl = deps.statImpl ?? (async (path: string) => {
    const info = await stat(path)
    return { size: info.size, isFile: info.isFile() }
  })
  let names: readonly string[]
  try { names = await readdirImpl(dir) }
  catch { return [] }
  const candidates: OutboxCandidate[] = []
  for (const name of names) {
    try {
      const info = await statImpl(join(dir, name))
      if (!info.isFile) continue
      candidates.push({ name, size: info.size })
    }
    catch { /* 这一拍读不到就下一拍再说 */ }
  }
  return candidates
}

/** 扫一遍发件目录根(= 发给房里所有人的那些)。**绝不抛**。 */
export async function scanOutbox(deps: ScanOutboxDeps): Promise<readonly string[]> {
  return outboxPicks(await listFiles(deps, deps.dir))
}

/** 一件要发的东西:发哪个文件、发给谁(`to` 缺席 = 发给房里所有设备)。 */
export interface OutboxPick {
  /** 绝对路径。 */
  path: string
  /** 发出去时用的文件名。 */
  name: string
  size: number
  to?: DeviceInfo
}

export interface ScanOutboxTargetsDeps extends ScanOutboxDeps {
  devices: readonly DeviceInfo[]
}

/**
 * 扫一遍:根下那些(广播)+ 每个 `发给-XXX/` 里那些(点名)。
 *
 * **子目录名对不上任何一台在线设备就跳过**并不声张 —— 那多半是他给一台此刻不在线的设备
 * 准备的东西,下一拍(或者那台设备上线之后)自然会发出去,不该当成错误刷日志。
 */
export async function scanOutboxTargets(deps: ScanOutboxTargetsDeps): Promise<readonly OutboxPick[]> {
  const picks: OutboxPick[] = []
  for (const candidate of await listFiles(deps, deps.dir)) {
    if (!outboxPicks([candidate]).includes(candidate.name)) continue
    picks.push({ path: join(deps.dir, candidate.name), name: candidate.name, size: candidate.size })
  }
  for (const device of deps.devices) {
    const sub = join(deps.dir, outboxDirNameOf(device))
    for (const candidate of await listFiles(deps, sub)) {
      if (!outboxPicks([candidate]).includes(candidate.name)) continue
      picks.push({ path: join(sub, candidate.name), name: candidate.name, size: candidate.size, to: device })
    }
  }
  return picks
}

/**
 * 给每台在线设备建一个 `发给-XXX/`,顺便写一份说明。**建不出来不抛**:
 * 发件目录在只读盘上、或者他把它删了,都只是「这一拍没有点名发的路」。
 */
export async function ensureOutboxDirs(
  dir: string,
  devices: readonly DeviceInfo[],
  deps: { mkdirImpl?: (target: string) => Promise<void>, writeFileImpl?: (path: string, text: string) => Promise<void>, existsImpl?: (path: string) => boolean } = {},
): Promise<void> {
  const mkdirImpl = deps.mkdirImpl ?? (async (target: string) => { await mkdir(target, { recursive: true }) })
  const writeFileImpl = deps.writeFileImpl ?? ((path: string, text: string) => writeFile(path, text, 'utf8'))
  const existsImpl = deps.existsImpl ?? existsSync
  try {
    await mkdirImpl(dir)
    for (const device of devices) await mkdirImpl(join(dir, outboxDirNameOf(device)))
    const readme = join(dir, OUTBOX_README)
    if (!existsImpl(readme)) await writeFileImpl(readme, outboxReadmeText())
  }
  catch { /* 见函数头 */ }
}

/** 说明文件的正文。写给不看命令行的人。 */
export function outboxReadmeText(): string {
  return [
    '这是事务官的「发件」文件夹。',
    '',
    '把文件拖进 “发给-XXX” 那个文件夹,几秒钟之后它就到那台设备上了:',
    '  · 手机收在「文档 / 事务官」里;',
    '  · 电脑收在同级的「收件」文件夹里。',
    '',
    '直接放在这一层(不进任何子文件夹)的,会发给此刻在线的所有设备。',
    '',
    '发过的文件不会被删掉,只是挪进「已发送」。',
    `一个文件最大 ${Math.round(MAX_TRANSFER_BYTES / 1024 / 1024)} MB;更大的先压缩,或者用别的办法。`,
    '',
    '“发给-XXX” 文件夹是按此刻在线的设备自动建的;某台设备一直没上线,就不会有它的文件夹。',
    '',
  ].join('\n')
}

/** 发完挪走。挪不动就回 false —— 调用方据此记一条日志,不假装挪成功了。 */
export async function markSent(dirOrPath: string, name?: string): Promise<boolean> {
  // 两种叫法都认:markSent(发件目录, 文件名)(老调用方)与 markSent(绝对路径)(点名发的那些)。
  const path = name === undefined ? dirOrPath : join(dirOrPath, name)
  const fileName = basename(path)
  // `已发送/` 永远在**发件目录根**下,不在 `发给-XXX/` 里面 —— 一处就能看完发过什么。
  const parent = dirname(path)
  const root = basename(parent).startsWith(TO_DEVICE_PREFIX) ? dirname(parent) : parent
  const sentDir = join(root, SENT_SUBDIR)
  try {
    if (!existsSync(sentDir)) await mkdir(sentDir, { recursive: true })
    await rename(path, join(sentDir, fileName))
    return true
  }
  catch {
    return false
  }
}

/** 发件目录的默认位置,与收件目录并排。 */
export function defaultOutboxDir(inboxDir: string): string {
  if (/channel-inbox\/?$/.test(inboxDir)) return inboxDir.replace(/channel-inbox\/?$/, 'channel-outbox')
  return join(dirname(inboxDir), '发件')
}

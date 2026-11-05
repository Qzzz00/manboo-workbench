/**
 * 这台 Mac 的机器 id 与本机房间名(2026-10-21,局域网主路;docs/设计-局域网主路-2026-10-21.md 第二节)。
 *
 * 同一个局域网里可能有好几台 8791(一个办公室、每人一台 Mac),手机与听筒只认**配对过的那一台**:
 * `GET /channel/route` 回的 `mac_id` 不等于配对时记下的那个,就不算在家(连接规格判据 ③)。
 * 本机房间名也从它来(`wb-local-<前 8 位>`),装时定、不随登录变。
 *
 * 为什么随机生成、落在数据目录,而不是读硬件 UUID:
 *   - 删掉 `~/.dsh` 重装时 devices.json(配对记录)也没了,手机本来就要重新配对 ——
 *     机器 id 跟着换,两件事是同一个边界;
 *   - 不起子进程(`ioreg`)、不把硬件标识交给局域网里的设备。
 *
 * 不是秘密(房间名不当密码用,防人进房靠的是票的签名),但文件照 devices.json 的收法 0600。
 * 安装器(卡 M1)写 `channel.json` 的 `room` 时调同一个 {@link readOrCreateMachineId},两边不会各定一个。
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 机器 id 的样子:32 位小写十六进制。 */
export const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/

/** 本机房间名的前缀。中转那边的云房间是 `wb-<sha256(账号)前16位>`,两种名字不会撞。 */
export const LOCAL_ROOM_PREFIX = 'wb-local-'

export function defaultMachineIdFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/machine-id`
}

export function localRoomOf(machineId: string): string {
  return `${LOCAL_ROOM_PREFIX}${machineId.slice(0, 8)}`
}

function parsed(text: string): string | undefined {
  const one = text.trim().toLowerCase()
  return MACHINE_ID_PATTERN.test(one) ? one : undefined
}

async function readId(file: string): Promise<string | undefined> {
  try { return parsed(await readFile(file, 'utf8')) }
  catch { return undefined }
}

/**
 * 读这台的机器 id;没有就现定一个。**并发的几次「第一次」只定出一个**:
 * 用 `wx`(文件已在就失败)去写,写输了的那几次回头读赢家写下的那一个。
 * 文件在但内容读不懂(被写坏了)就覆盖成新的 —— 坏 id 拿去比只会永远对不上。
 *
 * 落不了盘(目录没权限)就抛:调用方据此退回「没有机器 id」,不编一个只活在内存里的 ——
 * 那样每次重启都换一台机器,手机永远判不到在家。
 */
export async function readOrCreateMachineId(file: string): Promise<string> {
  const had = await readId(file)
  if (had !== undefined) return had
  await mkdir(dirname(file), { recursive: true })
  const fresh = randomBytes(16).toString('hex')
  let exists = false
  try {
    await writeFile(file, `${fresh}\n`, { flag: 'wx', mode: 0o600 })
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    exists = true
  }
  if (!exists) {
    await chmod(file, 0o600)
    return fresh
  }
  const winner = await readId(file)
  if (winner !== undefined) return winner
  // 文件在、内容是坏的:覆盖。
  await writeFile(file, `${fresh}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return fresh
}

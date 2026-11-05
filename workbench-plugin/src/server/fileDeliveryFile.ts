/**
 * **交付回执台账落盘那两下**(2026-10-04 午后统筹定,卡 `claude/three-small-1004`)。
 *
 * 为什么要落盘:`fileDelivery.ts` 那本台账原先只在内存里 —— 工作台重启一次,
 * 「这件事还差一个回执」就忘了,收尾那一问于是答「没登记过」,那张卡又成了「办完了」。
 * 而「要一份文件」这件事往往跨着一次重启(她说一句、走开、过半天回来看)。
 *
 * 为什么另起一个文件:`fileDelivery.ts` 文件头写着「这个文件里一行 I/O 都没有」,
 * 那一条是它能被单测整条跑完的理由。读写、容错、路径全在这儿。
 *
 * ## 纪律
 *
 * - **老数据读得懂**:没有的格一律当缺席,看不懂的那一条**丢掉**(不编一个);
 *   整份文件读不出来(第一次跑、被删了、写坏了)就从空的开始,**不抛**。
 * - 写**同步**:台账一动就写一次,那是一个几 KB 的小 json;
 *   写不下去只是没落盘(`fileDelivery` 那一侧 try 住了),台账照旧在内存里管事。
 * - 与 `call-out.json` / `tasks.json` / `budget.json` 同一个目录规格:`~/.dsh/workbench/`。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FileAskView } from './fileFetch.ts'
import type { FileDeliveryFile, FileDeliveryNeed, FileDeliveryPersist } from './fileDelivery.ts'

/** 台账落在哪。 */
export function defaultFileDeliveryFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/file-delivery.json`
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 一条登记 → 一条台账。**认不出来就丢**(同 `deviceDirectory.parseTransferEntry` 的口径)。
 *
 * 必有的四格:哪张卡、她那句原话、送到哪台(id + 名字)、登记时刻。缺一格这一条就不算数 ——
 * 少了卡 id 它挂不到任何一张卡上,少了时刻过期判不了,留着只会在收尾那一问上说不清话。
 *
 * `ask`(摆在她手机上那张卡)**原样留着**:它的形状由 `fileFetch.ts` 定,这里不替它判 ——
 * 读回来的那一张只用来再摆一次,摆出去之前 `/files/pending` 那一侧还会核一遍单。
 */
export function parseFileDeliveryNeed(raw: unknown): FileDeliveryNeed | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const itemId = text(row.item_id)
  const deviceId = text(row.device_id)
  const createdAt = num(row.created_at)
  if (itemId === undefined || deviceId === undefined || createdAt === undefined) return undefined
  const request = typeof row.request === 'string' ? row.request : undefined
  if (request === undefined) return undefined
  const offers = Array.isArray(row.offers) ? row.offers.filter((one): one is string => typeof one === 'string' && one !== '') : []
  const delivered = (() => {
    if (row.delivered === null || typeof row.delivered !== 'object') return undefined
    const got = row.delivered as Record<string, unknown>
    const at = num(got.at)
    const name = text(got.name)
    if (at === undefined || name === undefined) return undefined
    return { at, name, bytes: num(got.bytes) ?? 0 }
  })()
  return {
    item_id: itemId,
    request,
    ...(text(row.query) === undefined ? {} : { query: text(row.query)! }),
    device_id: deviceId,
    device_name: text(row.device_name) ?? deviceId,
    created_at: createdAt,
    ...(text(row.what) === undefined ? {} : { what: text(row.what)! }),
    offers,
    ...(row.ask === null || typeof row.ask !== 'object' || Array.isArray(row.ask) ? {} : { ask: row.ask as FileAskView }),
    ...(delivered === undefined ? {} : { delivered }),
    ...(text(row.why) === undefined ? {} : { why: text(row.why)! }),
    ...(row.pushed === true ? { pushed: true as const } : {}),
  }
}

/** 整份文件 → 那几条。看不懂的整份当空的(**不抛**)。 */
export function parseFileDeliveryFile(raw: unknown): readonly FileDeliveryNeed[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rows = (raw as Record<string, unknown>).needs
  if (!Array.isArray(rows)) return []
  return rows.flatMap((one) => {
    const need = parseFileDeliveryNeed(one)
    return need === undefined ? [] : [need]
  })
}

export function fileDeliveryFileOf(needs: readonly FileDeliveryNeed[]): FileDeliveryFile {
  return { version: 1, needs }
}

/**
 * 真读真写那一份。给 `createFileDeliveryStore({ persist })`。
 *
 * 写走的是「先写旁边那一份、再改名盖上去」:写一半断电时原来那一份还在
 * (同 `~/.dsh/workbench/` 底下别几本的做法)。
 */
export function createFileDeliveryPersist(path: string): FileDeliveryPersist {
  return {
    load() {
      try { return parseFileDeliveryFile(JSON.parse(readFileSync(path, 'utf8'))) }
      catch { return undefined }
    },
    save(needs) {
      try { mkdirSync(dirname(path), { recursive: true }) }
      catch { /* 目录本来就在 */ }
      const tmp = `${path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(fileDeliveryFileOf(needs), null, 2)}\n`, 'utf8')
      renameSync(tmp, path)
    },
  }
}

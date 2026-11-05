/**
 * 事项类型表(2026-10-22,统筹转维护者:类型名不写死,做成设置;Agent 也能改)。
 *
 * 存在 `<工作目录>/协作区/事项类型.json`(与 `板.canvas` 同一个目录),经 8791 `GET / POST /collab/types` 读写,
 * `/state` 里 `tasks.work_types` 带着整张表。没存过 / 读不出 → 缺省四类(`DEFAULT_WORK_TYPES`)。
 * 表在内存里留一份,写的时候换;手改那份文件要重启服务才读到(写入口只有那一条)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CollabWorkTypeView } from '../protocol.ts'
import { DEFAULT_WORK_TYPES, checkWorkTypes } from '../protocol.ts'

export const WORK_TYPES_FILE = '事项类型.json'

export interface WorkTypesStore {
  read: () => Promise<readonly CollabWorkTypeView[]>
  write: (types: readonly CollabWorkTypeView[]) => Promise<void>
}

/** `canvasFile`:板的文件在哪;类型表放在它旁边。 */
export function createWorkTypesStore(canvasFile: () => Promise<string>): WorkTypesStore {
  let cached: readonly CollabWorkTypeView[] | undefined
  const fileOf = async (): Promise<string> => join(dirname(await canvasFile()), WORK_TYPES_FILE)
  return {
    async read() {
      if (cached !== undefined) return cached
      try {
        const got = checkWorkTypes((JSON.parse(await readFile(await fileOf(), 'utf8')) as { types?: unknown }).types)
        cached = got.ok ? got.types : DEFAULT_WORK_TYPES
      }
      catch { cached = DEFAULT_WORK_TYPES }
      return cached
    },
    async write(types) {
      const file = await fileOf()
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, `${JSON.stringify({ version: 1, types }, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
      cached = types
    },
  }
}

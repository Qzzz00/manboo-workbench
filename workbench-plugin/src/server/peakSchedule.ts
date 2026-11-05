/**
 * 峰谷时间表落盘(2026-09-09)。
 *
 * 时间表默认按 DeepSeek 官方的两段(quota/peakHours.ts 的 DEFAULT_PEAK_SCHEDULE),
 * Ben 可以在 SettingsDialog 里改——改完要活过重启,所以落盘
 * ~/.dsh/workbench/peak-hours.json,原子写 + 容错读(与 read-marks.json / notes.json 同规格)。
 *
 * 容错的取向是**宁可用默认表也不哑**:文件不存在、写坏了、内容不合法,一律退回官方默认两段。
 * 这一格错了顶多是"高峰/低谷显示得不对",不值得让整块额度面板出不来。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PeakSchedule } from '../quota/peakHours.ts'
import { DEFAULT_PEAK_SCHEDULE, validatePeakSchedule } from '../quota/peakHours.ts'

export interface PeakScheduleService {
  /** 从磁盘装载。失败或内容不合法都静默退回默认表。 */
  load(): Promise<void>
  get(): PeakSchedule
  /** 存一份新表。不合法就抛(由 HTTP 路由翻成 400),旧表原样保留。 */
  set(schedule: unknown): Promise<PeakSchedule>
}

export function defaultPeakScheduleFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/peak-hours.json`
}

interface PeakScheduleFile { version: 1, schedule: PeakSchedule }

export function createPeakScheduleService(options: { file: string }): PeakScheduleService {
  let current: PeakSchedule = DEFAULT_PEAK_SCHEDULE

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(options.file, 'utf8')) as PeakScheduleFile
        const checked = validatePeakSchedule(parsed?.schedule)
        if (checked.ok) current = checked.schedule
      }
      catch {
        // 不存在/写坏了都按默认表兜底,先例见 notes.ts loadNotesFile。
      }
    },
    get() {
      return current
    },
    async set(schedule) {
      const checked = validatePeakSchedule(schedule)
      if (!checked.ok) throw new Error(checked.error)

      const data: PeakScheduleFile = { version: 1, schedule: checked.schedule }
      await mkdir(dirname(options.file), { recursive: true })
      const tmp = `${options.file}.${randomUUID()}.tmp`
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      await rename(tmp, options.file)
      // 落盘成功才认:写失败时界面上还是旧表,与磁盘一致,不会出现"看着改了其实没存"。
      current = checked.schedule
      return checked.schedule
    },
  }
}

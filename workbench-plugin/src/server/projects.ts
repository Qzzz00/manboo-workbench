/**
 * 项目状态持有 + 原子写 JSON 持久化(spec §6)。
 *
 * 落盘仅四样:项目定义、目录规则、一句话状态(含 DDL)、布局。
 * 活动信号(RepoSignals,scan.ts 的「算」行)绝不落盘(spec D3)——
 * 落盘的信号会和真实 git 漂移,然后开始骗人。
 *
 * save 用 tmp 文件 + rename 原子替换:写一半崩不能留半份文件(spec §7)。
 * 仿 quota/persist.ts 的容错读法:文件缺失/损坏都返回空,不抛——第一次跑本来就没有。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DirRule, ProjectDdl, ProjectStage, WorkbenchLayout } from '../protocol.ts'
import type { ScanRoot } from './scan.ts'

/** 落盘的单个项目定义:「状态/零散/DDL」三层,不含「算」。 */
export interface StoredProject {
  id: string
  name: string
  stage: ProjectStage
  repoPath?: string
  status?: { text: string, review: 'confirmed' | 'suggested', author: string, updated_at: string }
  ddl?: ProjectDdl
  links: string[]
}

export interface ProjectsFile {
  version: 1
  projects: StoredProject[]
  rules: DirRule[]
  layout?: WorkbenchLayout
  scanRoots?: ScanRoot[]
}

export function defaultProjectsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/projects.json`
}

export function emptyProjectsFile(): ProjectsFile {
  return { version: 1, projects: [], rules: [] }
}

export async function loadProjectsFile(file: string): Promise<ProjectsFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return emptyProjectsFile()
  }

  try {
    const parsed = JSON.parse(text) as Partial<ProjectsFile> | null
    if (typeof parsed !== 'object' || parsed === null) return emptyProjectsFile()
    return {
      version: 1,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      ...(parsed.layout === undefined ? {} : { layout: parsed.layout }),
      ...(parsed.scanRoots === undefined ? {} : { scanRoots: parsed.scanRoots }),
    }
  }
  catch {
    // 写坏了就当没有。项目区会显示「待整理」重扫,那是此刻的真实状态。
    return emptyProjectsFile()
  }
}

export async function saveProjectsFile(file: string, data: ProjectsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  // tmp 名带随机后缀:同一 file 上可能有多次写入并发跑(见 projectsService 的写队列),
  // 固定 `${file}.tmp` 会互相覆盖临时文件本身——即使队列序列化了调用方,写队列之外
  // 的直接调用者仍可能并发,tmp 名不该依赖调用方守规矩。
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

/**
 * 陈旧判定(spec D3):状态写下的时刻早于最后一次真实提交 → 过期,只标记不自动改写。
 * 没有状态可比,或不知道最后提交时间,都不算陈旧——没有信息不该编成"陈旧"。
 */
export function isStale(statusUpdatedAt: string | undefined, lastCommitAt: string | undefined): boolean {
  if (statusUpdatedAt === undefined || lastCommitAt === undefined) return false
  const statusAt = Date.parse(statusUpdatedAt)
  const commitAt = Date.parse(lastCommitAt)
  if (Number.isNaN(statusAt) || Number.isNaN(commitAt)) return false
  return statusAt < commitAt
}

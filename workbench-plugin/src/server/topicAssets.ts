/**
 * 选题的「关联素材」(2026-09-21 选题池)。
 *
 * 运营同事原话:「每个选题关联对应素材,点选题可查对应 part 素材」。这里回答的就是
 * **这条选题现在有哪些素材**,以及**点「素材」要打开哪个目录**。
 *
 * ## 目录约定(这张卡定的,`feat/ops-skills` 的产物按它落)
 *
 * ```
 * <工作目录>/
 *   选题/<选题名>/            ← 一条选题一个目录,「素材」按钮打开的就是它
 *     框架.md                 ← 想法梳理 →「灵感」那一段的产物
 *     初稿.md / 定稿.md       ← 「初稿」那一段
 *     素材清单.md             ← 「准备素材」那一段
 *     发布包装.md             ← 标题 / 短文案 / 标签 / 封面建议,「发布」那一段
 *     复盘.md                 ← 「复盘」那一段
 *     素材/                   ← 这条选题自己的素材(图、视频、参考文件)
 *   素材/{选题池,脚本,图片素材,视频素材,文件素材,设计素材,成片}/
 *                             ← 白板上的七类素材库。**按文件名前缀**认领给选题
 * ```
 *
 * ## 「关联」是怎么认出来的 —— 两条,都不猜
 *
 * 1. 放在 `选题/<名>/素材/` 里的,**都是**这条选题的;
 * 2. 放在七类素材库里、**文件名以选题名开头**的(`露营锅具怎么选-封面.png`),算这条选题的。
 *
 * 没有第三条。没有"看起来像"、没有按修改时间猜、没有模糊匹配 —— 一个把别人的素材
 * 算到这条选题头上的清单,比一个空清单更糟(D13)。这条规则要写进界面,让人知道
 * 文件名该怎么起;**规则本身就是功能的一部分**,不是实现细节。
 *
 * ## 目录读不到不等于出错
 *
 * `选题/<名>/素材/` 还没建过是常态(刚建的选题、或者 `feat/ops-skills` 还没落过产物)。
 * 那一支**安静地当作"没有素材"**;只有真的出了别的错(权限之类)才把原因如实带回去,
 * 界面上原样显示 —— 不把"读不到"画成"零个"。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 选题目录在工作目录下叫什么。与 templates.ts 的 `TOPIC_DIR` 同一个字面量,由那边导出。 */
export { TOPIC_DIR, TOPIC_ASSET_SUBDIR } from '../templates.ts'
import { TOPIC_ASSET_SUBDIR } from '../templates.ts'
import { isSafeDeckName } from './deckRun.ts'

/** 一个素材文件。`from` 是它在哪儿找到的(选题自己的目录,或七类素材库里的哪一类)。 */
export interface TopicAssetFile {
  name: string
  path: string
  from: string
}

export interface TopicAssetsView {
  name: string
  /** 这条选题的目录绝对路径(「素材」按钮打开的就是它)。 */
  dir: string
  files: TopicAssetFile[]
  /** 列到上限截断了。**截断一定说出来**,不静默少给几条。 */
  truncated?: boolean
  /** 逐条读目录时的真错误(不含"目录还没建")。原样带回界面。 */
  errors?: string[]
}

/**
 * 一条选题名能不能当目录名用。**一段,不许拐弯**:带 `/`、`..`、点开头的一律不认。
 *
 * 2026-09-22 起判据本身在 `deckRun.ts` 的 `isSafeDeckName` —— 需求卡也是拿卡的标题
 * 当目录名,同一道门只该有一份(这里的名字、签名与行为一个字没变)。
 */
export function isSafeTopicName(name: string): boolean {
  return isSafeDeckName(name)
}

/** 一条选题的目录在哪。名字不合法回 undefined(**不拼一条半截路径出来**)。 */
export function topicDirOf(topicsDir: string, name: string): string | undefined {
  return isSafeTopicName(name) ? join(topicsDir, name.trim()) : undefined
}

/** 一个目录里的文件名(只要文件,不要子目录、不要点开头的)。目录不存在回 `undefined`,别的错抛出去。 */
async function filesIn(dir: string): Promise<string[] | undefined> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  }
  catch (error) {
    // 还没建过是常态,不是错。别的(权限、不是目录)要让调用方知道。
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
  return entries
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

export interface ListTopicAssetsOptions {
  /** `<工作目录>/选题` 的绝对路径。 */
  topicsDir: string
  /** 七类素材库的绝对路径,键是那一类叫什么(来自 `/state.template.asset_dirs`)。 */
  materialDirs: Readonly<Record<string, string>>
  names: readonly string[]
  /** 一条选题最多列几个文件。超了截断并说出来。 */
  maxPerTopic?: number
}

const DEFAULT_MAX_PER_TOPIC = 200

/**
 * 一批选题各自的素材。**一次问一批**:界面上十几张卡片各发一个请求,等于把一次目录扫描
 * 拆成十几次;而且它们读的是同几个目录。
 */
export async function listTopicAssets(opts: ListTopicAssetsOptions): Promise<TopicAssetsView[]> {
  const max = opts.maxPerTopic ?? DEFAULT_MAX_PER_TOPIC
  // 七类素材库只读一遍,不是每条选题读一遍。
  const library = new Map<string, string[]>()
  const libraryErrors: string[] = []
  for (const [label, dir] of Object.entries(opts.materialDirs)) {
    try {
      const names = await filesIn(dir)
      if (names !== undefined) library.set(label, names)
    }
    catch (error) {
      libraryErrors.push(`读不了「${label}」:${(error as Error).message}`)
    }
  }

  const out: TopicAssetsView[] = []
  for (const raw of opts.names) {
    const dir = topicDirOf(opts.topicsDir, raw)
    // 名字当不了目录名(带斜杠之类)。**这一条整条跳过**,不拿一个改过的名字冒充它。
    if (dir === undefined) continue
    const name = raw.trim()
    const errors = [...libraryErrors]
    const files: TopicAssetFile[] = []

    const own = join(dir, TOPIC_ASSET_SUBDIR)
    try {
      for (const file of await filesIn(own) ?? []) {
        files.push({ name: file, path: join(own, file), from: TOPIC_ASSET_SUBDIR })
      }
    }
    catch (error) {
      errors.push(`读不了这条选题的素材目录:${(error as Error).message}`)
    }

    for (const [label, names] of library) {
      for (const file of names) {
        if (!file.startsWith(name)) continue
        files.push({ name: file, path: join(opts.materialDirs[label] as string, file), from: label })
      }
    }

    const truncated = files.length > max
    out.push({
      name,
      dir,
      files: truncated ? files.slice(0, max) : files,
      ...(truncated ? { truncated: true } : {}),
      ...(errors.length === 0 ? {} : { errors }),
    })
  }
  return out
}

/**
 * 把这条选题的目录建出来(`选题/<名>/` 与它底下的 `素材/`),回绝对路径。
 *
 * 只有两个地方会调它:**建一条新选题的那一刻**,和他**点「素材」**的那一刻。
 * 两次都是他亲手点的;没有任何定时器、没有任何"顺手补齐"的扫描
 * (不可改清单第 5 条的同一条道理:系统不在他的盘上自己动手)。
 */
export async function ensureTopicDir(topicsDir: string, name: string): Promise<{ ok: true, dir: string } | { ok: false, reason: string }> {
  const dir = topicDirOf(topicsDir, name)
  if (dir === undefined) return { ok: false, reason: '选题名不能带 / 或 \\,也不能以点开头' }
  try {
    await mkdir(join(dir, TOPIC_ASSET_SUBDIR), { recursive: true })
    return { ok: true, dir }
  }
  catch (error) {
    return { ok: false, reason: `建不了这条选题的目录:${(error as Error).message}` }
  }
}

/** 选题目录里记来源的那个文件(2026-09-22 卡 ③)。 */
export const TOPIC_SOURCE_FILE = '来源.md'

/** 一条来源:哪条资讯、在哪儿、为什么当时觉得该做。 */
export interface TopicSourceEntry {
  /** 资讯原标题(**不是**选题标题 —— 这一节记的是"这条选题是从哪来的")。 */
  title: string
  url: string
  /** 站名。没有就没有,不写「未知来源」。 */
  source?: string
  /** 提炼时那一句「为什么现在做」。没有就不写。 */
  why?: string
  /** 记下来的那一天(YYYY-MM-DD)。 */
  date: string
}

/**
 * 把一条来源追加进 `选题/<名>/来源.md`(**只追加,不重写**)。
 *
 * 三条纪律:
 * 1. **同一个链接不记第二遍** —— 同一条资讯被两次「加入选题池」(同名选题)时,
 *    文件里只该有一条;重复的条目会让人以为这条选题有两份依据。
 * 2. **她自己在这个文件里写的东西一个字不碰**:读出来原文,在末尾追加一行。
 * 3. 写不进去(没配工作目录、权限)**如实回一句**,由调用方带到界面上 ——
 *    卡已经建好了,来源没记下不该让整件事看起来失败,但也不许静默吞掉(D13)。
 */
export async function appendTopicSource(
  dir: string,
  entry: TopicSourceEntry,
): Promise<{ ok: true, path: string, added: boolean } | { ok: false, reason: string }> {
  const path = join(dir, TOPIC_SOURCE_FILE)
  const line = `- ${entry.date} [${entry.title}](${entry.url})`
    + (entry.source === undefined || entry.source.trim() === '' ? '' : ` · ${entry.source.trim()}`)
    + (entry.why === undefined || entry.why.trim() === '' ? '' : ` · ${entry.why.trim()}`)
  try {
    let text: string
    try { text = await readFile(path, 'utf8') }
    catch {
      text = [
        `# 来源`,
        '',
        '> 这条选题是从哪几条资讯来的。工作台在「加入选题池」的那一刻追加一行,',
        '> 你自己写在这个文件里的东西它一个字不碰。',
        '',
      ].join('\n')
    }
    // 同一个链接已经在里头了就什么都不做(**不追加第二行**)。
    if (text.includes(`(${entry.url})`)) return { ok: true, path, added: false }
    const next = `${text.replace(/\n*$/, '')}\n${line}\n`
    await mkdir(dir, { recursive: true })
    await writeFile(path, next, 'utf8')
    return { ok: true, path, added: true }
  }
  catch (error) {
    return { ok: false, reason: `没能把来源记进 ${TOPIC_SOURCE_FILE}:${error instanceof Error ? error.message : String(error)}` }
  }
}

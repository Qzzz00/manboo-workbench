/**
 * 用户层的加载口 · 服务端那一半(2026-10-21,卡「分层第一刀」;设计 `docs/设计-分层第一刀-2026-10-21.md`)。
 *
 * 用户层 = 用户自主改动的那一层,全在她电脑上的**一个目录**里(缺省 `~/.dsh/workbench/用户层/`),
 * 本体升级时原地不动、永不上传、永不合并。本体认它的地方**只有这一个文件**(客户端那一半在
 * `client/userLayer.ts`):目录在哪、骨架怎么建、`小组件/` 里的清单怎么读、`布局/` 里的布局模板怎么解析(2026-10-23,分层二刀二:摆哪几格、叫什么、泳道、素材文件夹、附带应用、皮肤全在那一份 `<模板id>.json` 里,本体只认格式)、坏了怎么说。
 * 2026-10-26(卡「用户层切割收尾」):`采集器/`(采集器定义)与 `偏好/`(记住的规矩 / 学到的习惯 /
 * 改过的提示词)也转 live —— 真源都在用户层;老位置一次性迁进来(`migrateLegacyFilesOnce`,只拷不挪、
 * 幂等、她删过的不复活),采集器服务与偏好三文件的 default 路径各只有一处。
 *
 * ## 两种小组件,两个子目录,信任不一样
 *
 * - `小组件/<id>/`(widget.json + 一个 .js):**页内**的格子小组件,替本体开出来的某一格(`WIDGET_SLOTS`),
 *   在工作台页面里跑,和本体同权限。只放她自己(或她让人)写的东西。
 * - `网页小组件/<id>/`(module.json + index.html):「开发一个小工具」派出去做的那种,**沙箱**,
 *   单开来源 + 九条接口(`modules.ts` / `moduleOrigin.ts` 照旧管)。这里只负责把目录给它。
 *
 * 加载口**从不**把 `网页小组件/` 里的东西当页内小组件装 —— 两种信任不靠文件名区分,靠目录。
 *
 * ## 自愈(2026-10-21 统筹补的硬要求)
 *
 * 内部同学遇到问题,要能让事务官派一家能写代码的去改**他自己的用户层**:
 *   ① 目录里有一份本体写的 `契约.md`(每次起服务按本体这一版重写),agent 读了就知道能改什么、不能碰什么;
 *   ② 派这类活时工作区只开到用户层目录(`userLayerFixBrief` + http 里 `/user-layer/fix` 带 `cwd` 派,
 *      Codex 的 workspace-write / Claude 的 --add-dir 都只放行这一个目录可写);
 *   ③ 改完下一拍就换上(指纹变了客户端重装);页面画好过的那一版存进 `.上一版/`,新改的坏了就端上一版,
 *      **她(或 agent)改的那份文件一个字不动**,改好了(指纹再变)自动换回。只在用户层里,不碰本体的回滚。
 *
 * 2026-10-23(卡「分层自愈完善」)把 ③ 补成三件事:画好过的留**最近 3 份**历史(含清单/入口/样式指纹组合,
 * 坏版不进),设置里能选回(不碰她的 style.css);坏版本记进 `.上一版/坏版本.json`(键 = 入口@样式指纹,
 * 跨重启不再重试重报,文件一改自动恢复);派去改用户层的活交回来时核本体目录(`bodyDir` 指纹,记 evidence 在
 * `.修复/<itemId>/`)——被改过就拒装:窗口内用户层变过的一切原样保留(分不清是谁改的,卡的原文是
 * 「无法安全归因则保留现状、明确阻塞」),变过的小组件按指纹组合「先不装」(端上一版/标 broken,改一个码
 * 自动恢复);本体一份文件都不由这里碰,已核记录与派活前备份长留作证据。
 *
 * ## 坏了跳过
 *
 * 清单逐个读,读坏一份只把那一份标成 broken 并给一句她看得懂的话(设置 →「这台电脑」→「用户层」原样上屏),
 * 别的照装;本体那一格退回自带的那一版。**不抛**:/state 每一拍都问它。
 */
import { createHash, randomBytes } from 'node:crypto'
import { access, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { USER_LAYER_CONTRACT } from '../protocol.ts'
import type { LayoutModule, UserLayerLayoutView, UserLayerPluginView, UserLayerStateView, UserLayerWidgetView, WidgetSlotId } from '../protocol.ts'
import { PRODUCT_TEMPLATE, isSafeTemplateRel } from '../templates.ts'
import type { TemplateApp, TemplateFolder, TemplateOnboarding, WorkbenchTemplate } from '../templates.ts'

export { USER_LAYER_CONTRACT }

export function defaultUserLayerDir(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/用户层`
}

/* ─────────── 偏好与采集器的切割(2026-10-26,卡「用户层切割收尾」)─────────── */

/** 偏好的几份文件,切割后全在 `用户层/偏好/` 里(规矩与习惯 / 改过的提示词 / 派活偏好)。 */
export const USER_LAYER_PREFS_FILES = ['rules.json', 'prompt-overrides.json', 'prompt-overrides.log.jsonl', 'dispatch-prefs.json'] as const

/** 偏好目录(2026-10-26 起:散在 ~/.dsh/workbench/ 下几份 → 用户层/偏好/)。 */
export function defaultUserLayerPrefsDir(home = process.env.HOME ?? ''): string {
  return join(defaultUserLayerDir(home), '偏好')
}

/**
 * 老位置 → 新位置的一对一搬迁清单(偏好):`~/.dsh/workbench/<名>` → `用户层/偏好/<名>`。
 * 只此一处写老路径,消费方(rules.ts / promptOverrides.ts / dispatchPrefs.ts 的 default*File)各引这一份。
 */
export function legacyPrefsMoves(home: string, prefsDir: string = defaultUserLayerPrefsDir(home)): { from: string, to: string }[] {
  return USER_LAYER_PREFS_FILES.map(name => ({ from: `${home}/.dsh/workbench/${name}`, to: join(prefsDir, name) }))
}

/** 一次性迁移的持久记录(点开头,不参与扫描):每份文件一件状态,跨进程可恢复。 */
export const MIGRATION_MARKER = '.迁过'

export interface LegacyMigrationResult {
  /** 这一次才完成发布的。 */
  copied: string[]
  /**
   * 没落地的名:复制真实失败(EACCES / EIO / ENOSPC)、归属没能持久记下、或**结果不确定**(暂存丢了、
   * 目标也不在 —— 无法区分「没发布成」与「已发布被她删」)。一律如实报,由调用方说「没迁成、下次再试」;
   * 持久化失败不得报告完成,不确定绝不 done:true。
   */
  failed: string[]
  /** 没有 pending:全部终态(已发布 / 认养 / 源没有),且无不确定项。 */
  done: boolean
  /** marker 读不出来(损坏 / EACCES 那类)或写不进去、或存在不确定项时的如实说明。 */
  markerError?: string
}

/**
 * 一件迁移的持久状态(`.迁过` 的 items 里,每份文件一件):
 * - `claimed`  = 已认领:归属归新位置,还没暂存拷贝 —— 中断后按「未发布」重试;
 * - `staged`   = 已暂存,且暂存身份(`staging` 名)+ 内容指纹(`sha`)已落盘 = 发布意图。
 *   恢复时**按记录点名**找暂存(跨进程,不靠 PID 推);名或指纹对不上就不碰(那不再是我们的暂存)。
 *   暂存丢了且目标也不在 = 结果不确定:保留本状态如实报,绝不 done:true、绝不重拷;
 * - `published`= 已发布(目标对用户可见过):终态,她删过的不复活;
 * - `adopted`  = 目标处本是她的文件:终态,她的字节一个字没动,旧源永不重拷;
 * - `absent`   = 认领时源就不在(一次性:老位置后来再出现的不迁)。
 */
export interface MigrationItemState {
  stage: 'claimed' | 'staged' | 'published' | 'adopted' | 'absent'
  /** staged 专属:暂存文件名(相对迁移目录)。 */
  staging?: string
  /** staged 专属:暂存内容指纹(sha256 前 12 位);碰暂存/认目标前必须对上。 */
  sha?: string
}

interface MigrationMarker {
  _note: string
  items: Record<string, MigrationItemState>
}

type MarkerRead =
  | { kind: 'none' }
  | { kind: 'ok', items: Record<string, MigrationItemState> }
  | { kind: 'unreadable', error: string }

const MIGRATION_STAGES = new Set(['claimed', 'staged', 'published', 'adopted', 'absent'])

/**
 * 读迁移记录。**区分「没有」「读得出」「读不出」**:损坏 / EACCES 一律如实报 unreadable —— 假装没有会
 * 让「她删过」的名单丢失、旧文件复活。「没有」是干净起步,不是损坏;旧格式(数组 schema)按读不出处理。
 */
async function readMigrationMarker(path: string): Promise<MarkerRead> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' }
    return { kind: 'unreadable', error: (error as Error).message }
  }
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'unreadable', error: '内容不是一份记录' }
    const items = (raw as MigrationMarker).items
    if (typeof items !== 'object' || items === null || Array.isArray(items)) {
      return { kind: 'unreadable', error: 'items 那一条读不懂(不是 { 文件名: 状态 })' }
    }
    for (const [name, state] of Object.entries(items)) {
      if (typeof state !== 'object' || state === null || !MIGRATION_STAGES.has((state as MigrationItemState).stage)) {
        return { kind: 'unreadable', error: `「${name}」的状态读不懂` }
      }
      // staged 的 staging 后面参与 rename/rm:只许本目录单文件名(不带 / \ ..、不以点开头),
      // sha 必须 12 位十六进制 —— 坏结构一律拒读,绝不拿着它去越界碰原件。
      if ((state as MigrationItemState).stage === 'staged') {
        const { staging, sha } = state as MigrationItemState
        if (typeof staging !== 'string' || staging === '' || staging === '..' || staging.startsWith('.')
          || staging.includes('/') || staging.includes('\\')) {
          return { kind: 'unreadable', error: `「${name}」的暂存名不合规(只许本目录一份文件名)` }
        }
        if (typeof sha !== 'string' || !/^[0-9a-f]{12}$/.test(sha)) {
          return { kind: 'unreadable', error: `「${name}」缺合法的内容指纹` }
        }
      }
    }
    return { kind: 'ok', items: items as Record<string, MigrationItemState> }
  }
  catch { return { kind: 'unreadable', error: '内容不是合法 json(写一半断电那类)' } }
}

/** 同目录临时文件 + rename 原子落位,`tag` 区分各步的临时名(中断后认得出是谁的半成品)。 */
async function writeFileAtomic(path: string, data: string, tag: string): Promise<void> {
  const tmp = `${path}.part-${process.pid}-${tag}`
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, path)
  }
  finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

/**
 * 迁移专用的存在性判定(五轮返工钉死):**只有 ENOENT 算「不在」**。权限(EACCES)/ I/O 那类
 * 异常一律 'unknown' —— 来源 unknown 不许记 absent(否则永久跳过她的规矩),目标 unknown 不许
 * 盲 rename 覆盖(那可能是她刚写的文件)。
 */
async function probePath(path: string): Promise<'yes' | 'no' | 'unknown'> {
  try { await access(path); return 'yes' }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no' : 'unknown' }
}

/** 一份文件的内容指纹(sha256 前 12 位);读不出回 undefined。 */
async function hashOf(path: string): Promise<string | undefined> {
  try { return createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 12) }
  catch { return undefined }
}

/**
 * 老位置 → 用户层的一次性迁移(2026-10-26,卡「用户层切割收尾」;阶段不变量与异常转移见
 * `docs/交接-1026-用户层切割收尾.md` 第五节,与实现逐条对应)。
 *
 * 三条不变量:
 * - **I1 永不删改用户正式文件**:正式目标路径上不能证明是本次自己发布的内容,一律不删不改;
 *   恢复时目标已存在且指纹对不上 → 她的文件 → 认养(她的字节原样)。回退只碰「记录点名 + 指纹对得上」
 *   或「本进程刚创建」的暂存;
 * - **I2 跨进程可恢复**:暂存身份与指纹写进持久记录,新进程按记录点名找,不靠 PID 推、不扫用户目录;
 * - **I3 三态区分**:未发布(claimed / staged 且暂存还在)= 可重试;已发布后她删 = 不复活(终态);
 *   暂存丢了目标也不在 = **不确定**:保留 staged 如实报 done:false,绝不重拷。
 *
 * 流程(首次暴露目标之前,发布意图已持久记下;暴露之后记已发布):
 *   认领(claimed 落盘)→ 拷到登记暂存 → staged(暂存身份+指纹落盘)→ rename 发布 → published 落盘。
 */
export async function migrateLegacyFilesOnce(dir: string, moves: ReadonlyArray<{ from: string, to: string }>): Promise<LegacyMigrationResult> {
  const markerPath = join(dir, MIGRATION_MARKER)
  const read = await readMigrationMarker(markerPath)
  if (read.kind === 'unreadable') {
    // 记录存在但读不出:里面可能正记着「她删过哪几份」。一步都不许动,如实报。
    return {
      copied: [],
      failed: moves.map(move => basename(move.to)),
      done: false,
      markerError: `迁移记录 ${MIGRATION_MARKER} 读不出来(${read.error}):没有迁、没有认养,下次启动再试;修好或移除它之后才会继续`,
    }
  }
  const items: Record<string, MigrationItemState> = read.kind === 'ok' ? { ...read.items } : {}
  const copied: string[] = []
  const failed: string[] = []
  let markerError: string | undefined
  const NOTE = '老位置一次性迁移的归属记录(2026-10-26):claimed=已认领未暂存;staged=已暂存(暂存身份+指纹在案,丢了且目标不在=不确定);published=已发布(删过不复活);adopted=她的文件(认养);absent=源不在。'
  /** 原子记一次整体状态;`patch` 给出本次要改的那一件(undefined = 删除该件)。先落盘,落盘成功才改内存。 */
  const persist = async (tag: string, patch?: { name: string, state: MigrationItemState | undefined }): Promise<boolean> => {
    const next: Record<string, MigrationItemState> = { ...items }
    if (patch !== undefined) {
      if (patch.state === undefined) delete next[patch.name]
      else next[patch.name] = patch.state
    }
    try {
      await writeFileAtomic(markerPath, `${JSON.stringify({ _note: NOTE, items: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`, tag)
    }
    catch (error) {
      markerError = `迁移记录没写成(${(error as Error).message}):没有报告成已迁`
      return false
    }
    if (patch !== undefined) {
      if (patch.state === undefined) delete items[patch.name]
      else items[patch.name] = patch.state
    }
    return true
  }
  await mkdir(dir, { recursive: true })

  /** 认领 → 暂存 → 发布(claim 已持久);失败语义见各分支。 */
  const claimStagePublish = async (name: string, from: string, to: string): Promise<void> => {
    const stagingName = `${basename(to)}.migrating-${randomBytes(4).toString('hex')}`
    const stagedPath = join(dir, stagingName)
    let sha: string
    try {
      await copyFile(from, stagedPath)
      const hashed = await hashOf(stagedPath)
      if (hashed === undefined) throw new Error('暂存指纹算不出')
      sha = hashed
    }
    catch (error) {
      // 只清我们刚建的暂存;正式目标从不动。
      await rm(stagedPath, { force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!(await persist('absent', { name, state: { stage: 'absent' } }))) failed.push(name)
        return
      }
      // 真实失败:回退认领(记录删去 → 下次按未发布重试);回退记不下也如实报。
      if (!(await persist('rollback', { name, state: undefined }))) { /* 记录里仍是 claimed:按未发布重试 */ }
      failed.push(name)
      return
    }
    // 发布意图 + 暂存身份落盘(暴露目标之前的最后一道持久写);记不下:清暂存、不暴露,记录仍 claimed。
    if (!(await persist('staged', { name, state: { stage: 'staged', staging: stagingName, sha } }))) {
      await rm(stagedPath, { force: true }).catch(() => undefined)
      failed.push(name)
      return
    }
    // 发布:rename 暂存 → 正式名(此刻用户才看得见)。
    try { await rename(stagedPath, to) }
    catch { failed.push(name); return } // 记录 staged、暂存还在:下次按记录完成发布
    if (!(await persist('published', { name, state: { stage: 'published' } }))) { failed.push(name); return } // 目标已暴露、记录未落:下次按指纹补记
    copied.push(name)
  }

  for (const move of moves) {
    const name = basename(move.to)
    const current = items[name]
    if (current !== undefined && (current.stage === 'published' || current.stage === 'adopted' || current.stage === 'absent')) continue
    const target = await probePath(move.to)
    if (target === 'unknown') {
      // 目标读不准:不盲 rename 覆盖、不认养、不关闭 —— 可能是她刚写的文件,如实报。
      failed.push(name)
      markerError = markerError ?? `「${name}」的目标位置读不准(权限/I/O 异常):没有动它,下次启动再试`
      continue
    }
    if (current === undefined || current.stage === 'claimed') {
      if (target === 'yes') {
        // 她的文件(先写好的 / 恢复时长出来的):认养,一个字不动。
        if (!(await persist('adopt', { name, state: { stage: 'adopted' } }))) failed.push(name)
        continue
      }
      const source = await probePath(move.from)
      if (source === 'unknown') {
        // 来源读不准 ≠ 不存在:绝不记 absent(否则她的规矩永久跳过),如实报、不写终态。
        failed.push(name)
        markerError = markerError ?? `「${name}」的老位置读不准(权限/I/O 异常):没有当成「没有」,下次启动再试`
        continue
      }
      if (source === 'no') {
        if (!(await persist('absent', { name, state: { stage: 'absent' } }))) failed.push(name)
        continue
      }
      if (current === undefined) {
        // 先持久发布意图,再动 anything;记不下:不拷不暴露。
        if (!(await persist('claim', { name, state: { stage: 'claimed' } }))) { failed.push(name); continue }
      }
      await claimStagePublish(name, move.from, move.to)
      continue
    }
    // staged:按记录恢复(跨进程:用记录点名的暂存,不用 PID 推)。
    const stagedPath = current.staging === undefined ? undefined : join(dir, current.staging)
    const stagedOurs = stagedPath !== undefined && current.sha !== undefined && (await hashOf(stagedPath)) === current.sha
    if (target === 'yes') {
      if (current.sha !== undefined && (await hashOf(move.to)) === current.sha) {
        // 我们的目标已就位(发布过 / 她没动):补记已发布。
        if (!(await persist('published', { name, state: { stage: 'published' } }))) failed.push(name)
        continue
      }
      // 目标处是她的文件:认养;暂存若还能证明是我们的,清掉。她的字节一个字不动。
      if (stagedOurs && stagedPath !== undefined) await rm(stagedPath, { force: true }).catch(() => undefined)
      if (!(await persist('adopt', { name, state: { stage: 'adopted' } }))) failed.push(name)
      continue
    }
    if (stagedOurs && stagedPath !== undefined) {
      // 暂存还在 = 从未发布(I3 未发布可重试):完成发布。
      try { await rename(stagedPath, move.to) }
      catch { failed.push(name); continue } // 记录 staged、暂存还在:下次完成发布
      if (!(await persist('published', { name, state: { stage: 'published' } }))) { failed.push(name); continue }
      copied.push(name)
      continue
    }
    // 暂存丢了(或不再是我们那一份)、目标也不在:结果不确定 —— 保留 staged,如实报,绝不 done:true、绝不重拷。
    failed.push(name)
    markerError = markerError
      ?? `「${name}」的暂存不在、目标也不在:无法确认是没发布成还是被删过 —— 不重拷(防复活),保持待确认`
  }
  return { copied, failed: [...new Set(failed)], done: failed.length === 0, ...(markerError === undefined ? {} : { markerError }) }
}

/** 骨架。`live` = 本体此刻真的读这个目录;没接上的照样建出来,里面一份说明讲清楚现在那样东西在哪。 */
export const USER_LAYER_FOLDERS: readonly { name: string, live: boolean, what: string }[] = [
  { name: '小组件', live: true, what: '替换工作台某一格的页内小组件。一格一个目录:widget.json + 一个 .js。' },
  { name: '网页小组件', live: true, what: '「开发一个小工具」做出来的小网页(沙箱里跑,只能用九条接口)。一格一个目录:module.json + index.html。' },
  { name: '插件', live: false, what: '会议、资讯与播客、展示台、内容运营工具将来搬到这里,可装可卸。现在它们还装在工作台里面,放进来的东西暂时不生效。' },
  { name: '技能', live: true, what: '派活和事务官都从这里读技能:一件一个目录(<名>/SKILL.md),或一份扁平的 <名>.SKILL.md / <名>.md(头部带 name: 的才算);子目录(如 项目经理/)往里扫一层。放进来的即刻生效。' },
  { name: '采集器', live: true, what: '采集器定义:一格一份 <名>.json(哪一页、用哪个登录档案;格式见 契约.md)。采回来的数据还在工作目录的 数据/<名>/。建、登录、采、撤走 /collector/*,或让事务官按技能动手。' },
  { name: '布局', live: true, what: '布局模板:一格一份 <模板id>.json(格式见 契约.md),皮肤是同名可选的一份 .css。摆哪几格、叫什么、泳道、素材文件夹、附带应用都在这里改。' },
  { name: '偏好', live: true, what: '记住的规矩、学到的习惯、改过的提示词。rules.json(规矩与习惯)、prompt-overrides.json 与 prompt-overrides.log.jsonl(改过的提示词)、dispatch-prefs.json(派活偏好)。工作台读写这一份;老位置 ~/.dsh/workbench/ 下的几份在升级后第一次启动时一次性搬进来(老文件保留、不再读)。' },
]

/** 本体开出来、用户层能替的那几格。`id` 写进 widget.json 的 `replaces`;`name` 是她在界面上认得的名字。 */
export const WIDGET_SLOTS: readonly { id: WidgetSlotId, name: string }[] = [
  { id: 'notes', name: '随手记' },
  { id: 'files', name: '素材管理' },
  { id: 'todo', name: '选题池' },
  { id: 'publish', name: '发布计划' },
  { id: 'review', name: '数据复盘' },
  { id: 'usage-panel', name: '消耗数据' },
]

/**
 * 插件清单(四族)。**代码还没搬**:它们今天仍装在本体里;这里只把「它们是插件」标出来,
 * 顺序就是搬出去的顺序(理由与代价在设计稿第六节)。搬出去一族,那一行改成从 `插件/` 读。
 */
export const FAMILY_PLUGINS: readonly UserLayerPluginView[] = [
  { id: 'display', name: '展示台', where: 'built-in', order: 1, note: '已是独立目录 display-client/,只靠 /live 与 /state 读数;搬出代价最小。' },
  { id: 'feed', name: '资讯与播客', where: 'built-in', order: 2, note: '自己一组接口 /feed*;挂在早报例程与事务官提示词上,要换成插件注册。' },
  { id: 'meeting', name: '会议', where: 'built-in', order: 3, note: '/meeting/* 一组接口,另有电话工具、意图识别与手机录音三处牵连。' },
  { id: 'content-ops', name: '内容运营工具', where: 'built-in', order: 4, note: '小红书取数 / 采集 / 拆解、运营技能、出图出片;出片那条写在派活主路里,牵连最深,最后搬。' },
]

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
/** 入口只许是这个目录里的一份 .js:不带斜杠、不以点开头。 */
const ENTRY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.js$/
/** 布局皮肤只许是这个目录里的一份 .css(同 ENTRY_RE 的「不带斜杠、不以点开头」)。 */
const SKIN_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.css$/
/** 一份入口文件的上限。她那六份最大十几 KB;超了多半是放错了东西。 */
export const WIDGET_MAX_BYTES = 1024 * 1024
const MANIFEST = 'widget.json'
const README = '说明.md'
/** 本体写的那份契约。她的 `说明.md` 缺才写;这一份每次起服务按本体这一版重写。 */
export const USER_LAYER_CONTRACT_FILE = '契约.md'
/** 页面上画好过的那一版存在这里(用户层自己的隐藏目录;扫描时点开头的目录不当小组件)。 */
const LAST_GOOD_DIR = '.上一版'
/**
 * 画好过的版本历史(2026-10-23,卡「分层自愈完善」):`.上一版/历史/<id>/<指纹组合>/`,
 * 每格最多留最近 3 份,设置里能选回。坏版不进(只在 report ok 时存)。
 */
const HISTORY_DIR = '历史'
/** 坏版本小表(同一 入口指纹@样式指纹 不再重试、不再重报;跨重启靠它)。 */
const BAD_REVS_FILE = '坏版本.json'
/** 每格最多留几份可用版本。 */
export const USER_LAYER_HISTORY_LIMIT = 3
/** 派去改用户层的活,交回时越界守门留下的记录与证据(2026-10-23,卡「分层自愈完善」)。 */
const FIXES_DIR = '.修复'
/** 待核记录放超过这么久( item 一直没交回)就当孤儿清掉。已核(留了 outcome)的记录与证据长留,不清。 */
const FIX_GUARD_STALE_MS = 7 * 24 * 3600 * 1000
/**
 * 布局起步层放过一次的标记(2026-10-23,分层二刀二,见 ensure 那段注释)。**别删** ——
 * 删了等价于「重新升级」,下次启动会把起步层布局里缺的文件补回来。
 */
export const LAYOUT_SEED_MARKER = '.seeded'
/**
 * 小组件起步层/兼容样式放过一次的标记(2026-10-23,分层二刀二第三轮)。**别删** ——
 * 老机器升级时只补缺的 style.css,不覆盖用户原件;删了此标记下次启动会重新补缺。
 */
export const WIDGET_STYLE_SEED_MARKER = '.styled'

/**
 * `@workbench/host` 那张表的名字(与 `client/userLayerHost.ts` 一一对应,`tests/user-layer-host-guard.test.ts` 比对)。
 * 契约文件按它写 —— 服务端引不了客户端那份(那里带着 React 组件)。
 */
export const HOST_API: Readonly<Record<string, readonly string[]>> = {
  ui: ['ModuleBox', 'EmptyState', 'Dialog', 'Icon'],
  builtin: ['FilesModule', 'TodoModule'],
  net: ['postSilently'],
  topics: ['DEFAULT_TOPIC_STAGE', 'TOPIC_CONTENT_TYPES', 'TOPIC_STAGES', 'nextTopicStage', 'isOpen', 'isTopic', 'stageOf'],
  publish: ['PUBLISH_PLAN_SOURCE_PREFIX', 'PUBLISH_VIEWS', 'WEEKDAYS', 'isOverdue', 'monthCells', 'pad', 'publishDayOf', 'publishHoverOf', 'publishHoverText', 'shiftMonth', 'tasksByPublishDay'],
  review: ['AccountsTable', 'REVIEW_RANGES', 'reviewHasValue'],
  usage: ['formatTokens', 'formatResetAt', 'sourcesOf', 'codexQuotaOf'],
}

/** 每一格给小组件的 props(Workbench.tsx 画那一格时原样给;只增不改)。 */
export const SLOT_PROPS: Readonly<Record<WidgetSlotId, string>> = {
  'notes': 'box header headingId baseUrl fetchImpl notes draft setDraft empty? headerWith? veil?',
  'files': 'box header headingId baseUrl fetchImpl view pin helper bodyRef onSwitchView inbox projects assetDirs? assetFiles? empty? access? onAuthorize? accessError? veil? headerWith?',
  'todo': 'box header headingId baseUrl fetchImpl tasks lanes projects collectReady headerWith?',
  'publish': 'box header headingId baseUrl fetchImpl tasks now projects headerWith?',
  'review': 'box header headingId baseUrl fetchImpl xhs? headerWith?',
  'usage-panel': 'usage now quota agentQuota?',
}

/** 给 coding agent 读的契约(本体写,放在用户层目录里)。 */
export function contractText(dir: string): string {
  return [
    `# 用户层契约(第 ${USER_LAYER_CONTRACT} 版)`,
    '',
    '> 这份由工作台本体写,每次工作台启动时按本体这一版重写,改了也会被盖回去。你自己的笔记写在 说明.md。',
    '',
    '## 你能改什么',
    '',
    `- **只改这个目录**(${dir})里的文件。工作台本体(~/.dsh/profiles、插件目录、仓库源码)对你是只读的,一个文件都不改。`,
    '- `小组件/<id>/`:替工作台某一格的页内小组件。一格一个目录,里面一份 `widget.json` 加一份 `.js`(可选一份 `style.css` 补组件专属样式)。',
    '- `网页小组件/`:「开发一个小工具」做的沙箱小网页,规范另见工作台给的交代,别把页内小组件放进去。',
    '- 别动 `.上一版/`(工作台存「上一版画好过的」、版本历史和坏版本记录用的)和 `.修复/`(派活交回时守门留的证据),还有本文件。',
    '',
    '## widget.json',
    '',
    '```json',
    '{ "contract": 1, "id": "<目录名>", "name": "随手记", "replaces": "notes", "entry": "index.js", "export": "NotesModule", "templates": ["ops"] }',
    '```',
    '',
    '- `id` 必须等于目录名(小写字母、数字、连字符);`entry` 是这个目录里的一份 .js,不超过 1MB。',
    '- `templates` 可省:写了就只在那几个模板下替(模板 id:`product` 做产品、`ops` 自媒体运营)。',
    '- 2026-10-21 那版起步 files 组件(清单与代码逐字未改、没有 templates 的)按 `["ops"]` 认 —— 加载口按钉死的原文指纹识别,不写你的文件,你不用手改。',
    '',
    '## replaces:能替哪一格,工作台给它什么 props',
    '',
    ...WIDGET_SLOTS.map(slot => `- \`${slot.id}\`(${slot.name}):${SLOT_PROPS[slot.id]}`),
    '',
    '整格的小组件自己用 `ModuleBox` 包住自己(props 里的 `box` 原样摊进去);写操作用 props 里的 `baseUrl` + `fetchImpl` 打工作台接口。',
    '`headerWith(右端那一样)` 画一份头,把一颗小键(比如「3 条记录 ›」)放在标题行右端、收起键之前;不用它就照旧摆 `header`。',
    '',
    '## 入口 .js 怎么写',
    '',
    'CommonJS:`const { useState } = require(\'react\')`,文件末尾 `module.exports = { 导出名 }`。`require` 只认三样:',
    '`react`、`react/jsx-runtime`、`@workbench/host`。`@workbench/host` 里有:',
    '',
    ...Object.entries(HOST_API).map(([group, names]) => `- \`${group}\`:${names.join('、')}`),
    '',
    '## 布局模板(2026-10-23 起)',
    '',
    '- `布局/<模板id>.json`:一份模板一个文件,`<模板id>` 是小写字母、数字、连字符,**文件里的 `id` 必须和文件名一致**。模板 = 横竖两份模块布局 + 窗位应用清单 + 工作目录文件夹结构 + 看板列 + 引导问法。',
    '- 摆哪几格、叫什么、泳道、素材文件夹、附带应用、皮肤都在这里改;**改了下一拍生效,不用重启**。这一版接口只加不减:以后本体升级,旧文件照认。',
    '',
    '```json',
    '{ "contract": 1, "id": "ops", "name": "自媒体运营", "tagline": "…", "project_word": "账号", "project_empty_line": "…", "files_empty_line": "…", "project_source": "accounts", "module_titles": { "projects": "账号" }, "portrait": [ { "id": "slot", "order": 0, "row": 0, "basis_pct": 22 } ], "landscape": [ … ], "apps": [ { "kind": "web", "key": "t-kling", "label": "可灵", "url": "https://…" } ], "folders": [ { "rel": "账号", "purpose": "…" } ], "files": [ "素材/收藏网址.md" ], "board_lanes": [ "选题策划" ], "onboarding": { "projects_seed": "…", "projects_goals": [ "…" ], "scan_repos": false }, "skin": "ops.css" }',
    '```',
    '',
    '- `contract` 现在只有 1;缺省不写就当 1。',
    '- `name` 缺省用文件名;`project_word` / `project_empty_line` 不写就是「做产品」模板的样子。',
    '- `project_source` 只认 `"git"`(项目 = 仓库)或 `"accounts"`(项目 = 账号文件夹),缺省 `"git"`。',
    '- `portrait` / `landscape`:非空数组,每个模块要有 `id`(文字)、`order` / `row` / `basis_pct`(数字),可选 `col` / `width_pct` / `side_pct`(数字)、`region`(只认 `"side"` / `"deck"`)、`hidden`(true / false)。',
    '- `apps`:每个应用要有 `kind`(只认 `"native"` / `"web"`)、`key`、`label`;`"web"` 还必须有 `url`;`app_name` / `bundle_id` / `bundle_note` 可选。',
    '- `folders`:每个文件夹 `rel` 是工作目录下的相对路径(不许 `/` 开头、不许 `..`),`purpose` 是给人看的一句话。`files` 是要种进工作目录的文件(如 `素材/收藏网址.md`)。',
    '- `module_titles`:模块 id → 这个模板里那一格叫什么,只写与默认不同的那几个。',
    '- `board_lanes`:看板按哪几个环节分列(文字数组);不写就不换列。',
    '- `onboarding`:可省。`projects_seed`(引导那句种子话)、`projects_goals`(要弄清的东西,文字数组)、`scan_repos`(还扫不扫仓库,true / false)。',
    '- `skin`:可省,只能是这个目录里同名的一份 `.css`(如 `ops.css`);里面的样式自己管,惯例是每条选择器都从 `.ben-wb[data-template=<模板id>]` 起头,别的不给改到。',
    '',
    '坏了(读不出来、字段不对、皮肤文件不在):**那一个模板退回「做产品」**,原因写在 设置 →「这台电脑」→「用户层」,修好就恢复;别的模板照装。整个文件删了也是一样退回。',
    '',
    '## 采集器(2026-10-26 起)',
    '',
    '- `采集器/<名>.json`:一份采集器一个文件,定义长这样:',
    '',
    '```json',
    '{ "version": 1, "name": "店铺", "url": "https://…", "profile": "collector-短码", "created_at": "…", "note": "可选" }',
    '```',
    '',
    '- `name` 就是文件名(<=24 字,不带 / \\ ..,不以点开头);`url` 只认 https,不许带账号密码;',
    '  `profile` 是登录档案名(`login-profile-<profile>`,缺省工作台按名字算一个短码)。',
    '- 建、登录、采、撤走 `/collector/*`(或让事务官按技能动手):**采回来的数据不进用户层**,落在工作目录 `数据/<名>/`(最新.txt + 采集记录.jsonl)。',
    '- 坏了(读不出来、名字对不上文件名)的那一份不进清单、也不炸;修好下一拍就回来。',
    '- 升级(2026-10-26)前老位置是工作目录的 `采集器/`:第一次启动已经一次性拷进这里(老文件还在、不再读,`.迁过` 标记在就不会重迁)。',
    '',
    '## 偏好(2026-10-26 起)',
    '',
    '- `偏好/rules.json`:记住的规矩 + 从行为里学到的习惯(试用 / 留下 / 撤,同一套状态)。在设置里改;坏了退回「没有」,不炸。',
    '- `偏好/prompt-overrides.json`:她改过的提示词(哪一段换成什么)。坏了那一页提示词退回本体的。',
    '- `偏好/prompt-overrides.log.jsonl`:上面那张表的改动流水,别手改。',
    '- `偏好/dispatch-prefs.json`:派活偏好(哪几类办完提醒、桌面活问不问)。坏了退回缺省。',
    '- 这几份工作台读写都在这一份;升级(2026-10-26)前散在 `~/.dsh/workbench/` 下,第一次启动一次性拷进来(老文件保留、不再读)。**她删掉哪一份,工作台不再建回来** —— 删 = 清空那一类。',
    '',
    '## 改完之后',
    '',
    '- 不用重启工作台:改了文件,工作台下一拍(一两秒)自己换上。',
    '- 改坏了(清单写错、代码跑不起来、画的时候出错):那一格自动用上一版画好过的,你改的文件原样留着,改好了自动换上;',
    '  从来没画好过的那一格退回工作台自带的那一版(没有自带的就写一句原因)。原因看 设置 →「这台电脑」→「用户层」。',
    '- 画好过的最近三版存在 `.上一版/` 的历史里:在 设置 →「这台电脑」→「用户层」能选回其中一版(选回不动你的 style.css)。',
    '- 不许在这里放服务端代码、凭据、密钥;不发外网请求。',
    '',
  ].join('\n')
}

/** 派一家能写代码的去改用户层时的交代。`cwd` 由调用方设成用户层目录(见 http 里 `/user-layer/fix`)。 */
export function userLayerFixBrief(said: string, dir: string): string {
  return [
    `改用户层:${said}`,
    '',
    `这件活只在用户层目录里做:${dir}`,
    `开始前先读 ${dir}/${USER_LAYER_CONTRACT_FILE}(能改什么、清单怎么写、能用哪些接口)。`,
    '工作台本体对你只读:这个目录之外一个文件都不改,也不要装依赖、不要重启工作台。',
    '改完不用重启,工作台下一拍自己装上;回来说一句改了哪几个文件、去哪一格看。',
  ].join('\n')
}

export interface UserLayerEnsureResult {
  /** 这一次才把根目录建出来。 */
  created: boolean
  /** 这一次放进去的起步层小组件(只在 created 时可能非空)。 */
  seeded: string[]
  /**
   * 这一次放进 `布局/` 的起步层文件(2026-10-23,分层二刀二)。**一次性**:目录里那份
   * `.seeded` 标记存在过 → 一个都不放(她主动删的不恢复);标记不在 → 把缺的补上并写下标记
   * (新机器第一次建目录、或老机器删掉标记等价于重新升级)。她改过一个字不动的规矩不变 ——
   * 只拷目录里没有的文件。
   */
  seededLayouts: string[]
  movedLegacyModules: boolean
  /** 有话要说时才有(比如新老两个网页小组件目录同时在)。 */
  note?: string
}

export interface UserLayerService {
  readonly dir: string
  /** 网页小组件(沙箱)那一份目录,交给 `createCustomModulesService`。 */
  readonly webWidgetsDir: string
  ensure: () => Promise<UserLayerEnsureResult>
  scan: () => Promise<UserLayerStateView>
  /** 只端清单过了的那一份入口文件;别的一律 undefined(路由回 404)。 */
  widgetCode: (id: string) => Promise<{ code: string, rev: string } | undefined>
  /** 组件专属兼容样式(2026-10-23,分层二刀二第三轮):css 原文 + 指纹;没有回 undefined。 */
  widgetStyle: (id: string) => Promise<{ css: string, rev: string } | undefined>
  /**
   * 布局模板(2026-10-23,分层二刀二)。**同步**读最近一拍 scan() 扫到的快照 —— 全局模板
   * 来源(templates.ts 的 source)与模板服务的清单都是同步签名,而读盘是异步的:
   * 快照由每拍 scan() 刷新(真机上 /state 一秒一拍),启动时先 scan 一次打底。
   * 没有 / 坏了回 undefined;她改文件,下一拍生效。
   */
  layoutTemplate: (id: string) => WorkbenchTemplate | undefined
  /** 快照里全部 ok 的布局模板(模板服务列清单 / 全局来源用)。 */
  layoutTemplates: () => readonly WorkbenchTemplate[]
  /** 只回 ok 且带皮肤的:css 原文 + 指纹;别的一律 undefined。 */
  layoutSkin: (id: string) => { css: string, rev: string } | undefined
  /** 在访达里打开用户层目录(没有就先建)。 */
  reveal: () => Promise<{ ok: true } | { ok: false, reason: string }>
  /**
   * 页面报一格某个指纹装得怎样:`ok` = 画好过一次(这一版存进 `.上一版/`:最新一份 + 历史 3 份,
   * 坏版不进历史);不 ok = 这一版坏了(记进坏版本小表,跨重启不再重试;下一拍起有上一版就端上一版)。
   */
  report: (input: { id: string, rev: string, ok: boolean, problem?: string, style_rev?: string | undefined }) => Promise<void>
  /** 这一格存下的可用版本(新→旧,最多 3 份;从来没画好过就是空表)。 */
  widgetHistory: (id: string) => Promise<readonly UserLayerHistoryEntry[]>
  /**
   * 选回历史里的某一版(设置里点「选回这一版」):先把当前可用版也存进历史(选回可逆),
   * 再把那一版的清单与入口写回小组件目录。**style.css 一个字不动** —— 不拿旧样式盖她的新文件。
   */
  restoreWidget: (id: string, rev: string, styleRev?: string) => Promise<{ ok: true } | { ok: false, reason: string }>
  /**
   * 派去改用户层的活出门时记一笔(2026-10-23,卡「分层自愈完善」越界守门):本体目录(`bodyDir`)
   * 指纹 + 用户层整树指纹与内容备份,存进 `.修复/<itemId>/`。交回时 `finishFixGuard` 对照:
   * 本体被改过 → 拒装。**记不上不静默**:回 `{ok:false}` 由调用方落到卡上。
   */
  beginFixGuard: (itemId: string) => Promise<{ ok: true } | { ok: false, reason: string }>
  /** 还没交回核对的派活 id(挂在节拍上轮询;空的就一次 I/O 都不做)。 */
  pendingFixGuards: () => Promise<string[]>
  /** 那一家交回来了:对照派活前的快照核本体越界,按结果清理/留证。`completedAt` = 卡上回答时刻。 */
  finishFixGuard: (itemId: string, completedAt: string) => Promise<FixGuardOutcome>
}

/** 一格存下的一个可用版本(`.上一版/历史/<id>/<指纹组合>/saved.json`)。 */
export interface UserLayerHistoryEntry {
  /** 入口文件内容指纹(12 位十六进制)。 */
  rev: string
  /** 这份版本存下时的样式指纹;那一版没带 style.css 就缺席。 */
  style_rev?: string
  /** 存下时刻(ISO)。 */
  at: string
}

/**
 * `finishFixGuard` 的结果:本体没动;或本体被改(拒装 + 留证)。
 *
 * 拒装的语义(2026-10-23 独立审后退修,按卡「无法安全归因则保留现状、明确阻塞」):
 * 维修窗口内用户层变过的文件**一律原样保留、不复活、不挪走** —— mtime + 前后 diff 分不清
 * 是那家改的还是她自己改的。被改动过的那一格按指纹组合记成「先不装」(端上一版 / broken,
 * 她在设置里看得见原因;改一个码自动恢复),磁盘上的文件一份不动。
 */
export type FixGuardOutcome =
  | { kind: 'clean' }
  | {
      kind: 'out-of-bounds'
      /** 本体目录里被改过的文件(相对路径)。本体本身一份文件都不由这里回写。 */
      changed: string[]
      /** 维修窗口内变过(改/删/新建,含 symlink 替换)的用户层文件,全部保留现状、记在这里。 */
      blocked: string[]
      /** 被「先不装」的小组件目录名:这一格端上一版或标 broken,改一个码自动恢复。 */
      held_back: string[]
    }

export interface UserLayerServiceOptions {
  dir: string
  /**
   * 起步层(随安装包带来的那一份);**小组件**只在第一次建目录时整份拷进来,
   * **`布局/` 里的文件每次 ensure 都把目录里没有的补上**(缺才放,已存在的一字不动;
   * 2026-10-23,分层二刀二)。没给 / 不存在就不放。
   */
  starterDir?: string
  /** 09-21 起网页小组件的老位置 `~/.dsh/workbench/modules/`;在而新位置不在时整个搬进来。 */
  legacyModulesDir?: string
  runCommand?: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  /**
   * 本体目录(2026-10-23,卡「分层自愈完善」越界守门):插件自己的安装目录。派去改用户层的活
   * 出门前记它的指纹,交回时比对 —— 被改过就拒装用户层那一份的结果。缺省 undefined = 没接
   * (开发/测试没给就只会记用户层快照,`finishFixGuard` 按「没依据」如实说)。
   */
  bodyDir?: string
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true }
  catch { return false }
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dst)
    else if (entry.isFile()) await copyFile(src, dst)
  }
}

function readmeOf(dir: string): string {
  const rows = USER_LAYER_FOLDERS.map(folder => `- **${folder.name}/**${folder.live ? '' : '(还没接上)'}:${folder.what}`)
  return [
    '# 用户层',
    '',
    '这是你自己的那一层:你加的、你改的东西都放在这里。工作台升级时这个目录原地不动,不上传、不合并。',
    `目录在:${dir}`,
    '',
    ...rows,
    '',
    '装了什么、哪个坏了,看工作台 设置 →「这台电脑」→「用户层」。坏掉的那一格会自己退回工作台自带的那一版,不会让整个工作台白屏。',
    '',
  ].join('\n')
}

function folderNoteOf(folder: { name: string, what: string }): string {
  return `# ${folder.name}\n\n${folder.what}\n`
}

/** 转 live 之前本体写进格子里的旧版 说明.md(逐字匹配才换新,见 ensure())。 */
const STALE_FOLDER_NOTES: Readonly<Record<string, string>> = {
  '采集器': '# 采集器\n\n采集器定义。现在还在工作目录的 采集器/ 里,下一步搬过来;放进来的暂时不生效。\n',
  '偏好': '# 偏好\n\n记住的规矩、学到的习惯、改过的提示词。现在还散在 ~/.dsh/workbench/ 下几份文件里,下一步搬过来;放进来的暂时不生效。\n',
}

function slotName(id: string): string | undefined {
  return WIDGET_SLOTS.find(slot => slot.id === id)?.name
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 用户层的一件技能(2026-10-22,卡「用户层技能生效」A)。`dir` = 目录形(整目录是这件技能);
 * `file` = 扁平形(一份 .md)。`id` 派活与事务官同步时都当目录名用。
 */
export type UserLayerSkill =
  | { id: string, name: string, description?: string, dir: string }
  | { id: string, name: string, description?: string, file: string }

/** 读一份 .md 的 frontmatter(只认 `---` 开头那一份里的单行 `键: 值`;取 name / description)。 */
function skillFrontmatter(text: string): { name?: string, description?: string } | undefined {
  if (!text.startsWith('---')) return undefined
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const out: { name?: string, description?: string } = {}
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed === '---' || trimmed === '...') break
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(trimmed)
    if (match === null) continue
    const key = match[1] as string
    if (key !== 'name' && key !== 'description') continue
    const value = (match[2] as string).trim().replace(/^["']|["']$/g, '')
    if (value !== '') out[key] = value
  }
  return out
}

/** 扫一层:目录形 `<名>/SKILL.md`、扁平形 `<名>.SKILL.md` / `<名>.md`(带 frontmatter `name:` 的才算)。 */
async function scanSkillLevel(levelDir: string, into: Map<string, UserLayerSkill>): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try { entries = await readdir(levelDir, { withFileTypes: true, encoding: 'utf8' }) }
  catch { return }
  for (const entry of entries.filter(one => !one.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(levelDir, entry.name)
    if (entry.isDirectory()) {
      // 目录形:里面有 SKILL.md 就算一件;名字读它的 frontmatter,读不到用目录名。
      if (into.has(entry.name)) continue
      const skillFile = join(path, 'SKILL.md')
      let text: string
      try { text = await readFile(skillFile, 'utf8') }
      catch { continue }
      const front = skillFrontmatter(text)
      into.set(entry.name, {
        id: entry.name,
        name: front?.name ?? entry.name,
        ...(front?.description === undefined ? {} : { description: front.description }),
        dir: path,
      })
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    // SKILL.md 只属于目录形(上面已认);落单的一份不叫一件技能。
    if (entry.name === 'SKILL.md') continue
    const stem = entry.name.endsWith('.SKILL.md') ? entry.name.slice(0, -'.SKILL.md'.length) : entry.name.slice(0, -'.md'.length)
    if (stem === '' || into.has(stem)) continue
    let text: string
    try { text = await readFile(path, 'utf8') }
    catch { continue }
    const front = skillFrontmatter(text)
    // 扁平形必须有 frontmatter `name:` 才算技能(来源说明.md / 说明.md / pm-overview.md 这类跳过)。
    if (front?.name === undefined) continue
    into.set(stem, { id: stem, name: front.name, ...(front.description === undefined ? {} : { description: front.description }), file: path })
  }
}

/**
 * 读「技能」那一格(2026-10-22,卡「用户层技能生效」A):列出 `用户层/技能/` 下的技能,两种形 —
 * 目录形 `<名>/SKILL.md`;扁平形 `<名>.SKILL.md` / `<名>.md`(frontmatter 带 `name:` 的才算)。
 * 子目录(如 `项目经理/`)往下一层也扫。读不出的单个文件跳过,别的一律照扫;目录不在回空表。
 * 派活(`dispatchSkills.ts`)与事务官(`butlerSkills.ts`)用的是同一个扫描,不各写一份。
 */
export async function scanUserLayerSkills(skillsDir: string): Promise<UserLayerSkill[]> {
  const found = new Map<string, UserLayerSkill>()
  await scanSkillLevel(skillsDir, found)
  const subs: string[] = []
  try {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) subs.push(join(skillsDir, entry.name))
    }
  }
  catch { return [] }
  for (const sub of subs.sort()) await scanSkillLevel(sub, found)
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}

type Parsed =
  | { ok: true, view: Omit<UserLayerWidgetView, 'status' | 'rev'>, entry: string }
  | { ok: false, view: UserLayerWidgetView }

/** widget.json → 一条清单。纯函数:目录名、读出来的原文。 */
export function parseWidgetManifest(dirName: string, text: string | undefined): Parsed {
  const broken = (problem: string, name = dirName): Parsed => ({ ok: false, view: { id: dirName, name, status: 'broken', problem } })
  if (text === undefined) return broken(`没有 ${MANIFEST}`)
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return broken(`${MANIFEST} 读不出来,多半是哪里少了引号或逗号`) }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return broken(`${MANIFEST} 应该是一个 { … }`)
  const m = raw as Record<string, unknown>
  const name = textOf(m.name) ?? dirName
  const contract = typeof m.contract === 'number' ? m.contract : 1
  if (!Number.isInteger(contract) || contract < 1) return broken('contract 应该是 1', name)
  if (contract > USER_LAYER_CONTRACT) {
    return broken(`这一格按第 ${contract} 版接口写的,这台工作台只认到第 ${USER_LAYER_CONTRACT} 版 —— 先更新工作台`, name)
  }
  const id = textOf(m.id) ?? dirName
  if (id !== dirName) return broken(`目录名「${dirName}」和 ${MANIFEST} 里的 id「${id}」对不上,改成一样的`, name)
  const replaces = textOf(m.replaces)
  if (replaces === undefined || slotName(replaces) === undefined) {
    const names = WIDGET_SLOTS.map(slot => `${slot.name}(${slot.id})`).join('、')
    return broken(`replaces 写的「${replaces ?? '空'}」不是工作台开出来的格子。能替的是:${names}`, name)
  }
  const entry = textOf(m.entry) ?? 'index.js'
  if (!ENTRY_RE.test(entry)) return broken(`entry「${entry}」只能是这个目录里的一份 .js 文件名`, name)
  const exportName = textOf(m.export) ?? 'default'
  const templates = Array.isArray(m.templates) ? m.templates.filter((one): one is string => typeof one === 'string') : undefined
  const author = textOf(m.author)
  const version = textOf(m.version)
  return {
    ok: true,
    entry,
    view: {
      id,
      name,
      replaces: replaces as WidgetSlotId,
      export: exportName,
      contract,
      ...(templates === undefined ? {} : { templates }),
      ...(author === undefined ? {} : { author }),
      ...(version === undefined ? {} : { version }),
    },
  }
}

/**
 * 旧起步层 files 组件的升级兼容(2026-10-23,卡「系统文件夹改成Graphify图谱」第四轮)。
 *
 * 2026-10-21「分层第一刀」种进用户层的 files 小组件**没有 templates 字段**(当时替全部
 * 布局);10-23 这一卡把素材管理收缝到自媒体布局后,没动过的旧组件会把开发者布局的
 * files 格也替掉,图谱格上不去。ensure() 只在新建目录时种种子,老用户不会重种,所以
 * 在**加载口**认:清单与入口文件的逐字指纹都对得上旧起步原文的,按 `templates:["ops"]`
 * 认(只认指纹,不认「id 叫 files」——改过一个字、换过名字的都不碰,用户删掉的目录
 * 也不会因此复生)。不写用户层任何文件,纯读取时识别,重复启动幂等。
 */
export const LEGACY_STARTER_FILES_MANIFEST = '{\n  "contract": 1,\n  "id": "files",\n  "name": "素材管理",\n  "replaces": "files",\n  "entry": "index.js",\n  "export": "FilesModule",\n  "author": "运营同学",\n  "version": "2026-10-21"\n}\n'
/** 旧起步 files 入口(main@分层第一刀 那一版 index.js)的 sha256 前 12 位(revOf 同口径)。 */
export const LEGACY_STARTER_FILES_REV = '5d22aaf9f58e'

/** 清单原文 + 入口指纹都对得上旧起步 files → 按 ops-only 认。 */
export function isLegacyStarterFiles(manifestText: string | undefined, entryRev: string): boolean {
  return manifestText === LEGACY_STARTER_FILES_MANIFEST && entryRev === LEGACY_STARTER_FILES_REV
}

/* ───────────────────────────── 布局模板(2026-10-23,分层二刀二)───────────────────────────── */

export type ParsedLayout =
  | { ok: true, template: WorkbenchTemplate, /** 皮肤 css 原文;这份模板没带皮肤就是 undefined。 */ skin: string | undefined }
  | { ok: false, view: UserLayerLayoutView }

function layoutBroken(id: string, problem: string, name = id): ParsedLayout {
  return { ok: false, view: { id, name, status: 'broken', problem } }
}

function numOf(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 一个模块对象 → LayoutModule。坏在哪用一句人话指出(第几个模块、哪个字段)。 */
function parseLayoutModule(index: number, raw: unknown): { ok: true, module: LayoutModule } | { ok: false, problem: string } {
  const where = `第 ${index + 1} 个模块`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: `${where}应该是一个 { … }` }
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || m.id.trim() === '') return { ok: false, problem: `${where}没有 id(模块叫什么的那个名字)` }
  const whereId = `第 ${index + 1} 个模块(id「${m.id}」)`
  for (const key of ['order', 'row', 'basis_pct'] as const) {
    if (!numOf(m[key])) return { ok: false, problem: `${whereId}的 ${key} 应该是数字` }
  }
  for (const key of ['col', 'width_pct', 'side_pct'] as const) {
    if (m[key] !== undefined && !numOf(m[key])) return { ok: false, problem: `${whereId}的 ${key} 应该是数字` }
  }
  if (m.region !== undefined && m.region !== 'side' && m.region !== 'deck') {
    return { ok: false, problem: `${whereId}的 region 只认 "side" 或 "deck"` }
  }
  if (m.hidden !== undefined && typeof m.hidden !== 'boolean') {
    return { ok: false, problem: `${whereId}的 hidden 应该是 true / false` }
  }
  const out: LayoutModule = {
    id: m.id,
    order: m.order as number,
    row: m.row as number,
    basis_pct: m.basis_pct as number,
    ...(m.col === undefined ? {} : { col: m.col as number }),
    ...(m.width_pct === undefined ? {} : { width_pct: m.width_pct as number }),
    ...(m.side_pct === undefined ? {} : { side_pct: m.side_pct as number }),
    ...(m.region === undefined ? {} : { region: m.region as 'side' | 'deck' }),
    ...(m.hidden === undefined ? {} : { hidden: m.hidden as boolean }),
  }
  return { ok: true, module: out }
}

function parseLayoutModules(field: 'portrait' | 'landscape', raw: unknown): { ok: true, modules: LayoutModule[] } | { ok: false, problem: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, problem: `${field} 应该是一个非空数组(这一份排布里摆哪几格)` }
  const modules: LayoutModule[] = []
  for (const [index, one] of raw.entries()) {
    const parsed = parseLayoutModule(index, one)
    if (!parsed.ok) return { ok: false, problem: parsed.problem }
    modules.push(parsed.module)
  }
  return { ok: true, modules }
}

function parseLayoutApps(raw: unknown): { ok: true, apps: TemplateApp[] } | { ok: false, problem: string } {
  if (raw === undefined) return { ok: true, apps: [] }
  if (!Array.isArray(raw)) return { ok: false, problem: 'apps 应该是一个数组' }
  const apps: TemplateApp[] = []
  for (const [index, one] of (raw as unknown[]).entries()) {
    const where = `第 ${index + 1} 个应用`
    if (typeof one !== 'object' || one === null || Array.isArray(one)) return { ok: false, problem: `${where}应该是一个 { … }` }
    const app = one as Record<string, unknown>
    const label = typeof app.label === 'string' ? app.label : ''
    const whereLabel = label === '' ? where : `应用「${label}」`
    if (app.kind !== 'native' && app.kind !== 'web') return { ok: false, problem: `${whereLabel}的 kind 只认 "native" 或 "web"` }
    if (typeof app.key !== 'string' || app.key.trim() === '') return { ok: false, problem: `${whereLabel}没有 key` }
    if (label === '') return { ok: false, problem: `${where}没有 label(界面上认的那个名字)` }
    for (const key of ['app_name', 'bundle_id', 'bundle_note', 'url'] as const) {
      if (app[key] !== undefined && typeof app[key] !== 'string') return { ok: false, problem: `${whereLabel}的 ${key} 应该是一段文字` }
    }
    if (app.kind === 'web' && (typeof app.url !== 'string' || app.url.trim() === '')) {
      return { ok: false, problem: `${whereLabel}是网页型,要有 url(点「打开」去哪儿)` }
    }
    apps.push({
      kind: app.kind,
      key: app.key,
      label,
      ...(app.app_name === undefined ? {} : { app_name: app.app_name as string }),
      ...(app.bundle_id === undefined ? {} : { bundle_id: app.bundle_id as string }),
      ...(app.bundle_note === undefined ? {} : { bundle_note: app.bundle_note as string }),
      ...(app.url === undefined ? {} : { url: app.url as string }),
    })
  }
  return { ok: true, apps }
}

/**
 * `布局/<id>.json` → 一份 WorkbenchTemplate(2026-10-23,分层二刀二)。
 *
 * 纯函数:目录名(= 文件名 stem)、读出来的原文、一个可选的皮肤读取器(把皮肤文件名换成
 * css 原文;读不出来回 undefined)。坏 → broken + 一句她看得懂的话(逐条指出哪错了),
 * 与小组件清单同一句式。格式由本体定,每次起服务重写进用户层目录里的 契约.md;
 * **字段缺省的意思 = 「做产品」那一份的样子**(product_word / project_empty_line 回退 product 的值)。
 */
export async function parseLayoutTemplate(
  dirName: string,
  text: string | undefined,
  readSkin?: (name: string) => Promise<string | undefined>,
): Promise<ParsedLayout> {
  if (text === undefined) return layoutBroken(dirName, `${dirName}.json 读不出来,多半是哪里少了引号或逗号`)
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return layoutBroken(dirName, `${dirName}.json 读不出来,多半是哪里少了引号或逗号`) }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return layoutBroken(dirName, `${dirName}.json 应该是一个 { … }`)
  const m = raw as Record<string, unknown>
  const name = textOf(m.name) ?? dirName
  const contract = typeof m.contract === 'number' ? m.contract : 1
  if (!Number.isInteger(contract) || contract < 1) return layoutBroken(dirName, 'contract 应该是 1', name)
  if (contract > USER_LAYER_CONTRACT) {
    return layoutBroken(dirName, `这份布局按第 ${contract} 版接口写的,这台工作台只认到第 ${USER_LAYER_CONTRACT} 版 —— 先更新工作台`, name)
  }
  const id = textOf(m.id) ?? dirName
  if (id !== dirName) return layoutBroken(dirName, `文件名「${dirName}」和里面的 id「${id}」对不上,改成一样的`, name)
  if (m.project_source !== undefined && m.project_source !== 'git' && m.project_source !== 'accounts') {
    return layoutBroken(dirName, 'project_source 只认 "git"(项目 = 仓库)或 "accounts"(项目 = 账号文件夹)', name)
  }
  const portrait = parseLayoutModules('portrait', m.portrait)
  if (!portrait.ok) return layoutBroken(dirName, portrait.problem, name)
  const landscape = parseLayoutModules('landscape', m.landscape)
  if (!landscape.ok) return layoutBroken(dirName, landscape.problem, name)
  const apps = parseLayoutApps(m.apps)
  if (!apps.ok) return layoutBroken(dirName, apps.problem, name)

  const folders: TemplateFolder[] = []
  if (m.folders !== undefined) {
    if (!Array.isArray(m.folders)) return layoutBroken(dirName, 'folders 应该是一个数组', name)
    for (const [index, one] of (m.folders as unknown[]).entries()) {
      if (typeof one !== 'object' || one === null || typeof (one as Record<string, unknown>).rel !== 'string'
        || typeof (one as Record<string, unknown>).purpose !== 'string' || !isSafeTemplateRel((one as Record<string, unknown>).rel as string)) {
        return layoutBroken(dirName, `第 ${index + 1} 个文件夹写的不对:rel 要是工作目录下的相对路径(不许 / 开头、不许 ..),purpose 是一段文字`, name)
      }
      folders.push({ rel: (one as Record<string, unknown>).rel as string, purpose: (one as Record<string, unknown>).purpose as string })
    }
  }
  const files: string[] = []
  if (m.files !== undefined) {
    if (!Array.isArray(m.files)) return layoutBroken(dirName, 'files 应该是一个数组', name)
    for (const [index, one] of (m.files as unknown[]).entries()) {
      if (typeof one !== 'string' || one.trim() === '') return layoutBroken(dirName, `files 里第 ${index + 1} 个应该是一段文字(要种进工作目录的那个文件的相对路径)`, name)
      files.push(one)
    }
  }
  const moduleTitles: Record<string, string> = {}
  if (m.module_titles !== undefined) {
    if (typeof m.module_titles !== 'object' || m.module_titles === null || Array.isArray(m.module_titles)) {
      return layoutBroken(dirName, 'module_titles 应该是一个 { 模块id: 标题 }', name)
    }
    for (const [key, value] of Object.entries(m.module_titles as Record<string, unknown>)) {
      if (typeof value !== 'string') return layoutBroken(dirName, `module_titles 里「${key}」的标题应该是一段文字`, name)
      moduleTitles[key] = value
    }
  }
  const lanes: string[] = []
  if (m.board_lanes !== undefined) {
    if (!Array.isArray(m.board_lanes)) return layoutBroken(dirName, 'board_lanes 应该是一个数组(看板按哪几个环节分列)', name)
    for (const [index, one] of (m.board_lanes as unknown[]).entries()) {
      if (typeof one !== 'string' || one.trim() === '') return layoutBroken(dirName, `board_lanes 里第 ${index + 1} 个应该是一段文字`, name)
      lanes.push(one)
    }
  }
  const onboarding: TemplateOnboarding = {}
  if (m.onboarding !== undefined) {
    if (typeof m.onboarding !== 'object' || m.onboarding === null || Array.isArray(m.onboarding)) {
      return layoutBroken(dirName, 'onboarding 应该是一个 { … }', name)
    }
    const o = m.onboarding as Record<string, unknown>
    if (o.projects_seed !== undefined) {
      if (typeof o.projects_seed !== 'string') return layoutBroken(dirName, 'onboarding 的 projects_seed 应该是一段文字', name)
      onboarding.projects_seed = o.projects_seed
    }
    if (o.projects_goals !== undefined) {
      if (!Array.isArray(o.projects_goals) || o.projects_goals.some(one => typeof one !== 'string')) {
        return layoutBroken(dirName, 'onboarding 的 projects_goals 应该是一个文字数组', name)
      }
      onboarding.projects_goals = o.projects_goals as string[]
    }
    if (o.scan_repos !== undefined) {
      if (typeof o.scan_repos !== 'boolean') return layoutBroken(dirName, 'onboarding 的 scan_repos 应该是 true / false', name)
      onboarding.scan_repos = o.scan_repos
    }
  }

  let skin: string | undefined
  if (m.skin !== undefined) {
    if (typeof m.skin !== 'string' || !SKIN_RE.test(m.skin)) {
      return layoutBroken(dirName, `skin「${String(m.skin)}」只能是这个目录里的一份 .css 文件名`, name)
    }
    const css = readSkin === undefined ? undefined : await readSkin(m.skin)
    if (css === undefined) return layoutBroken(dirName, `皮肤文件 ${m.skin} 不在或读不出来`, name)
    skin = css
  }

  const filesEmptyLine = textOf(m.files_empty_line)
  const template: WorkbenchTemplate = {
    id,
    name,
    tagline: textOf(m.tagline) ?? '',
    // 缺省回做产品那一份的值:格式缺省 = product 的样子。
    project_word: textOf(m.project_word) ?? PRODUCT_TEMPLATE.project_word,
    project_empty_line: textOf(m.project_empty_line) ?? PRODUCT_TEMPLATE.project_empty_line,
    ...(filesEmptyLine === undefined ? {} : { files_empty_line: filesEmptyLine }),
    project_source: (m.project_source as 'git' | 'accounts' | undefined) ?? 'git',
    portrait: portrait.modules,
    landscape: landscape.modules,
    module_titles: moduleTitles,
    apps: apps.apps,
    folders,
    files,
    board_lanes: lanes,
    onboarding,
  }
  return { ok: true, template, skin }
}

export function createUserLayerService(options: UserLayerServiceOptions): UserLayerService {
  const root = options.dir
  const widgetsDir = join(root, '小组件')
  const webWidgetsDir = join(root, '网页小组件')
  const layoutsDir = join(root, '布局')
  const runCommand = options.runCommand ?? (async () => ({ ok: false, stdout: '' }))
  /** 入口文件的指纹按 (mtime, size) 缓存:/state 一秒一拍,不必每拍都重算哈希。 */
  const revCache = new Map<string, { mtimeMs: number, size: number, rev: string }>()
  const lastGoodRoot = join(root, LAST_GOOD_DIR, '小组件')
  const historyRoot = join(root, LAST_GOOD_DIR, HISTORY_DIR)
  const badRevsFile = join(root, LAST_GOOD_DIR, BAD_REVS_FILE)
  const fixesDir = join(root, FIXES_DIR)
  /**
   * 页面上坏过的那几版:`<id> → <入口指纹@样式指纹 → 那句话>`(2026-10-23 起按组合键,文件一改键就变,
   * 自动恢复)。重启后同一指纹不再重试、不再重报 —— 这份记进 `.上一版/坏版本.json`,起服务时读回来。
   */
  const badRevs = new Map<string, Map<string, string>>()

  const comboKey = (rev: string, styleRev?: string): string => `${rev}@${styleRev ?? ''}`

  /** 起服务时把坏版本小表读回来;读不出来就当空的(不连累扫描)。 */
  const loadBadRevs = (): void => {
    let raw: unknown
    try { raw = JSON.parse(readFileSync(badRevsFile, 'utf8')) }
    catch { return }
    if (typeof raw !== 'object' || raw === null) return
    for (const [id, table] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof table !== 'object' || table === null) continue
      badRevs.set(id, new Map(Object.entries(table as Record<string, string>).filter(([, v]) => typeof v === 'string') as [string, string][]))
    }
  }
  loadBadRevs()

  /** 坏版本小表写盘;读不出来下一次启动当空的,不抛。 */
  const saveBadRevs = async (): Promise<void> => {
    const out: Record<string, Record<string, string>> = {}
    for (const [id, table] of badRevs) {
      // 一格最多留 20 条,旧的先丢(指纹键的文件早就变了,留着也没用)。
      out[id] = Object.fromEntries([...table.entries()].slice(-20))
    }
    try {
      await mkdir(join(root, LAST_GOOD_DIR), { recursive: true })
      await writeFile(badRevsFile, JSON.stringify(out), 'utf8')
    }
    catch { /* 记不进去就只内存里挡这一程 */ }
  }

  const ensure = async (): Promise<UserLayerEnsureResult> => {
    const created = !(await exists(root))
    let movedLegacyModules = false
    let note: string | undefined
    await mkdir(root, { recursive: true })
    const legacy = options.legacyModulesDir
    if (legacy !== undefined && await exists(legacy)) {
      if (await exists(webWidgetsDir)) note = `老位置 ${legacy} 和新位置 ${webWidgetsDir} 都在,两边都没动;老位置里的不会显示,要用就自己挪过来`
      else {
        await rename(legacy, webWidgetsDir)
        movedLegacyModules = true
      }
    }
    for (const folder of USER_LAYER_FOLDERS) {
      const path = join(root, folder.name)
      await mkdir(path, { recursive: true })
      if (!folder.live && !(await exists(join(path, README)))) await writeFile(join(path, README), folderNoteOf(folder), 'utf8')
      // 切割收尾(2026-10-26):采集器/偏好转 live 之前,本体在格子里写过一份「还没接上」的
      // 说明.md —— 内容与旧版逐字一致才换成新版说明;她自己写过的说明一个字不动。
      const stale = STALE_FOLDER_NOTES[folder.name]
      if (stale !== undefined) {
        const notePath = join(path, README)
        try {
          if ((await readFile(notePath, 'utf8')) === stale) await writeFile(notePath, folderNoteOf(folder), 'utf8')
        }
        catch { /* 没有 / 读不动就算了 */ }
      }
    }
    if (!(await exists(join(root, README)))) await writeFile(join(root, README), readmeOf(root), 'utf8')
    await writeFile(join(root, USER_LAYER_CONTRACT_FILE), contractText(root), 'utf8')
    const seeded: string[] = []
    const starter = options.starterDir === undefined ? undefined : join(options.starterDir, '小组件')
    if (starter !== undefined && await exists(starter)) {
      const marker = join(widgetsDir, WIDGET_STYLE_SEED_MARKER)
      if (created) {
        for (const entry of await readdir(starter, { withFileTypes: true })) {
          if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue
          await copyTree(join(starter, entry.name), join(widgetsDir, entry.name))
          seeded.push(entry.name)
        }
        await writeFile(marker, '小组件起步层放过一次;删掉这个文件,下次启动会把缺的补回来。\n', 'utf8')
      } else if (!(await exists(marker))) {
        // 老机器升级(created=false):用户已有小组件目录,不覆盖已有 index.js/widget.json,
        // 只补放缺的 style.css,并写下 .styled 标记
        for (const entry of await readdir(starter, { withFileTypes: true })) {
          if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue
          const srcStyle = join(starter, entry.name, 'style.css')
          const dstWidget = join(widgetsDir, entry.name)
          const dstStyle = join(dstWidget, 'style.css')
          if ((await exists(srcStyle)) && (await exists(dstWidget)) && !(await exists(dstStyle))) {
            await copyFile(srcStyle, dstStyle)
          }
        }
        await writeFile(marker, '小组件起步层放过一次;删掉这个文件,下次启动会把缺的补回来。\n', 'utf8')
      }
    }
    // 布局模板(2026-10-23,分层二刀二):起步层 `布局/` 的 seed 是**一次性**的 ——
    // `.seeded` 标记(点开头,不参与扫描,同小组件 `.上一版/` 的先例)在,就说明这份目录
    // 接过一次起步层:她主动删的 ops.json 不恢复(下次启动不再长回来);标记不在(新机器
    // 第一次建目录、老机器删掉标记)= 该补放:缺的补上、她改过的 / 已存在的一个字不动,
    // 然后写下标记。布局文件是本体的功能缺省,老机器升级要能补出来 —— 但只补一次。
    const seededLayouts: string[] = []
    const starterLayouts = options.starterDir === undefined ? undefined : join(options.starterDir, '布局')
    if (starterLayouts !== undefined && await exists(starterLayouts)) {
      const marker = join(layoutsDir, LAYOUT_SEED_MARKER)
      if (!(await exists(marker))) {
        for (const entry of await readdir(starterLayouts, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue
          const dst = join(layoutsDir, entry.name)
          if (await exists(dst)) continue
          await copyFile(join(starterLayouts, entry.name), dst)
          seededLayouts.push(entry.name)
        }
        await writeFile(marker, '布局起步层放过一次;删掉这个文件,下次启动会把缺的补回来。\n', 'utf8')
      }
    }
    return { created, seeded: seeded.sort(), seededLayouts: seededLayouts.sort(), movedLegacyModules, ...(note === undefined ? {} : { note }) }
  }

  const revOf = async (path: string): Promise<{ rev: string } | { problem: string }> => {
    let info: Awaited<ReturnType<typeof stat>>
    try { info = await stat(path) }
    catch { return { problem: 'missing' } }
    if (!info.isFile()) return { problem: 'missing' }
    if (info.size > WIDGET_MAX_BYTES) return { problem: 'big' }
    const hit = revCache.get(path)
    if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return { rev: hit.rev }
    const rev = createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 12)
    revCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, rev })
    return { rev }
  }

  type Version = { view: Omit<UserLayerWidgetView, 'status'>, problem?: string, rev?: string, file?: string, /** 这一版带的 style.css 的路径(没带就缺席);回退期间端样式也从这份出。 */ styleFile?: string }
  /** 读一个目录里的一版(当前的,或 `.上一版/` 里的):清单、入口文件、指纹、页面有没有报过坏。 */
  const readVersion = async (base: string, dirName: string): Promise<Version> => {
    let text: string | undefined
    try { text = await readFile(join(base, dirName, MANIFEST), 'utf8') }
    catch { text = undefined }
    const parsed = parseWidgetManifest(dirName, text)
    if (!parsed.ok) {
      const { status: _status, problem, ...view } = parsed.view
      return { view, problem: problem ?? '清单没过' }
    }
    const file = join(base, dirName, parsed.entry)
    const rev = await revOf(file)
    if ('problem' in rev) {
      return { view: parsed.view, problem: rev.problem === 'big' ? `${parsed.entry} 超过 1MB,多半是放错了文件` : `找不到 ${parsed.entry}` }
    }
    // 旧起步 files 组件(逐字未改):按 ops-only 认,见文件头那段兼容说明。
    const baseView = isLegacyStarterFiles(text, rev.rev)
      ? { ...parsed.view, templates: ['ops'] as const }
      : parsed.view
    const styleFile = join(base, dirName, 'style.css')
    const styleRev = await revOf(styleFile)
    const style_rev = 'rev' in styleRev ? styleRev.rev : undefined
    const viewWithStyle = {
      ...baseView,
      ...(style_rev === undefined ? {} : { style_rev }),
    }
    // 坏版本按 入口指纹@样式指纹 记:任一份文件改一个码就是另一版,自动恢复;同键不再重试重报。
    const bad = badRevs.get(dirName)?.get(comboKey(rev.rev, style_rev))
    const withStyle = { rev: rev.rev, file, ...(style_rev === undefined ? {} : { styleFile }) }
    if (bad !== undefined) return { view: viewWithStyle, problem: bad, ...withStyle }
    return { view: viewWithStyle, ...withStyle }
  }

  const scanWithEntries = async (): Promise<{ view: UserLayerStateView, entries: Map<string, { file: string, styleFile?: string }> }> => {
    const entries = new Map<string, { file: string, styleFile?: string }>()
    let names: string[]
    try { names = (await readdir(widgetsDir, { withFileTypes: true })).filter(one => one.isDirectory()).map(one => one.name) }
    catch { names = [] }
    const widgets: UserLayerWidgetView[] = []
    const taken = new Map<string, string>()
    for (const dirName of names.filter(one => ID_RE.test(one)).sort()) {
      let current = await readVersion(widgetsDir, dirName)
      // 新改的这一版坏了(清单 / 文件,或页面报过坏)→ 有页面画好过的上一版就端上一版,她改的文件不动。
      if (current.problem !== undefined) {
        const previous = await readVersion(lastGoodRoot, dirName)
        if (previous.problem === undefined && previous.rev !== undefined) {
          current = { ...previous, view: { ...previous.view, rolled_back: current.problem } }
        }
      }
      if (current.problem !== undefined || current.rev === undefined || current.file === undefined) {
        widgets.push({ ...current.view, status: 'broken', problem: current.problem ?? '没装上' })
        continue
      }
      const { view, file, styleFile, rev: currentRev } = current
      const rev = { rev: currentRev }
      const holder = taken.get(view.replaces as string)
      if (holder !== undefined) {
        widgets.push({ ...view, status: 'broken', problem: `「${slotName(view.replaces as string)}」那一格已经由「${holder}」在替,这一份先不装` })
        continue
      }
      taken.set(view.replaces as string, view.name)
      entries.set(dirName, { file, ...(styleFile === undefined ? {} : { styleFile }) })
      widgets.push({ ...view, status: 'ok', rev: rev.rev })
    }
    return { view: { contract: USER_LAYER_CONTRACT, widgets }, entries }
  }

  type LayoutDetail = { template: WorkbenchTemplate, skin?: { css: string, rev: string } }

  /**
   * 最近一拍扫到的 ok 布局模板(含皮肤)。全局模板来源与模板服务清单是同步签名,读这份快照;
   * 由每次 scan() 刷新 —— 与「读文件每拍一次即可,不加缓存」同一条:每拍重读重解析,只是结果
   * 落在这里给同步调用方用。
   */
  let lastLayouts: LayoutDetail[] = []

  /**
   * 扫 `布局/*.json`(2026-10-23,分层二刀二)→ 清单 + 解析过的模板与皮肤。
   * 一份坏了只标那一份,别的照装,不抛。
   */
  const scanLayouts = async (): Promise<{ views: UserLayerLayoutView[], details: Map<string, LayoutDetail> }> => {
    let names: string[]
    try {
      names = (await readdir(layoutsDir, { withFileTypes: true }))
        .filter(one => one.isFile() && one.name.endsWith('.json') && ID_RE.test(one.name.slice(0, -'.json'.length)))
        .map(one => one.name)
    }
    catch { names = [] }
    const views: UserLayerLayoutView[] = []
    const details = new Map<string, LayoutDetail>()
    for (const name of names.sort()) {
      const stem = name.slice(0, -'.json'.length)
      let buffer: Buffer
      try { buffer = await readFile(join(layoutsDir, name)) }
      catch { buffer = Buffer.alloc(0) }
      let skinRev: string | undefined
      const parsed = await parseLayoutTemplate(stem, buffer.length === 0 ? undefined : buffer.toString('utf8'), async (skinName) => {
        try {
          const skinBuffer = await readFile(join(layoutsDir, skinName))
          skinRev = createHash('sha256').update(skinBuffer).digest('hex').slice(0, 12)
          return skinBuffer.toString('utf8')
        }
        catch { return undefined }
      })
      if (!parsed.ok) { views.push(parsed.view); continue }
      const rev = createHash('sha256').update(buffer).digest('hex').slice(0, 12)
      views.push({ id: stem, name: parsed.template.name, status: 'ok', rev, ...(skinRev === undefined ? {} : { skin_rev: skinRev }) })
      details.set(stem, {
        template: parsed.template,
        ...(parsed.skin === undefined || skinRev === undefined ? {} : { skin: { css: parsed.skin, rev: skinRev } }),
      })
    }
    lastLayouts = [...details.values()]
    return { views, details }
  }

  /* ─────────── 可用版本历史与选回(2026-10-23,卡「分层自愈完善」①)─────────── */

  /** 这一版在历史上的目录名:入口指纹 + 样式指纹组合(任一份文件改一个码就是另一版)。 */
  const comboDirName = (rev: string, styleRev: string | undefined): string => `${rev}--${styleRev ?? 'plain'}`

  /** 把「当前这一版」存成一份历史快照(清单 + 入口 + style.css,坏版不进 —— 只在 report ok 时调)。 */
  const saveHistoryEntry = async (id: string, current: Version): Promise<void> => {
    if (current.rev === undefined || current.file === undefined) return
    const to = join(historyRoot, id, comboDirName(current.rev, current.view.style_rev))
    await rm(to, { recursive: true, force: true })
    await mkdir(to, { recursive: true })
    await copyFile(join(widgetsDir, id, MANIFEST), join(to, MANIFEST))
    await copyFile(current.file, join(to, basename(current.file)))
    if (current.styleFile !== undefined) await copyFile(current.styleFile, join(to, 'style.css'))
    const entry: UserLayerHistoryEntry = {
      rev: current.rev,
      ...(current.view.style_rev === undefined ? {} : { style_rev: current.view.style_rev }),
      at: new Date().toISOString(),
    }
    await writeFile(join(to, 'saved.json'), JSON.stringify(entry), 'utf8')
    // 只留最近几份:按存下时刻新→旧,超了的清掉(历史目录里的快照,不是她的原件)。
    const all = await historyEntries(id)
    for (const old of all.slice(USER_LAYER_HISTORY_LIMIT)) await rm(join(historyRoot, id, old.combo), { recursive: true, force: true })
  }

  /** 历史条目(新→旧);combo 是目录名。读坏一份跳过那一份,不连累别的。 */
  const historyEntries = async (id: string): Promise<(UserLayerHistoryEntry & { combo: string })[]> => {
    let names: string[]
    try { names = await readdir(join(historyRoot, id)) }
    catch { return [] }
    const out: (UserLayerHistoryEntry & { combo: string })[] = []
    for (const combo of names.sort()) {
      let raw: unknown
      try { raw = JSON.parse(await readFile(join(historyRoot, id, combo, 'saved.json'), 'utf8')) }
      catch { continue }
      if (typeof raw !== 'object' || raw === null) continue
      const one = raw as Record<string, unknown>
      if (typeof one.rev !== 'string' || typeof one.at !== 'string') continue
      out.push({
        rev: one.rev,
        ...(typeof one.style_rev === 'string' ? { style_rev: one.style_rev } : {}),
        at: one.at,
        combo,
      })
    }
    return out.sort((a, b) => b.at.localeCompare(a.at))
  }

  /* ─────────── 修复交回越界守门(2026-10-23,卡「分层自愈完善」③)─────────── */

  /**
   * 递归算一棵目录的指纹表:相对路径(/) → 指纹。**每份文件都算内容 sha256(前 12 位)** ——
   * 等长改写(内容换了、字节数不变,连 mtime 都拨回去)也检出;本体那两份 6–10MB 的构建产物
   * 不能退化成「只比大小」。symlink 记 `link:<指向>`(不跟读:本体文件被换成 symlink、
   * symlink 指向变了,都检出;也防借 symlink 把树外的文件读进来)。
   */
  const fingerprintTree = async (base: string, skip: (name: string) => boolean): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    const walk = async (dir: string): Promise<void> => {
      let listed: import('node:fs').Dirent[]
      try { listed = await readdir(dir, { withFileTypes: true, encoding: 'utf8' }) }
      catch { return }
      for (const entry of listed) {
        if (skip(entry.name)) continue
        const path = join(dir, entry.name)
        const rel = relative(base, path).split(sep).join('/')
        try {
          if (entry.isSymbolicLink()) {
            out[rel] = `link:${await readlink(path)}`
            continue
          }
          if (entry.isDirectory()) { await walk(path); continue }
          if (!entry.isFile()) continue
          out[rel] = createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 12)
        }
        catch { /* 读单个文件失败就不记这一份 */ }
      }
    }
    await walk(base)
    return out
  }

  const diffKeys = (now: Record<string, string>, before: Record<string, string>): string[] => {
    const out: string[] = []
    for (const [key, value] of Object.entries(now)) if (before[key] !== value) out.push(key)
    for (const key of Object.keys(before)) if (!(key in now)) out.push(key)
    return out
  }

  /** 用户层整树(跳过点开头的 —— 上一版 / 修复记录 / 标记文件都是工作台自己的)。 */
  const layerTree = (): Promise<Record<string, string>> => fingerprintTree(root, name => name.startsWith('.'))
  /** 本体目录(跳过依赖与版本库;它就是发版的那份,不靠 git 在场)。 */
  const bodyTree = (): Promise<Record<string, string>> =>
    options.bodyDir === undefined ? Promise.resolve({}) : fingerprintTree(options.bodyDir, name => name === 'node_modules' || name === '.git')

  interface FixGuardRecord {
    itemId: string
    at: string
    /** 派活那一刻本体目录的指纹表;没接 bodyDir 就缺席(守门没有依据)。 */
    body?: Record<string, string>
    /** 派活那一刻用户层整树的指纹表。 */
    files: Record<string, string>
    /** 核过之后写进去(含 changed/restored/blocked/evidence);有待核记账只列没有这一格的。 */
    outcome?: unknown
  }

  const readGuardRecord = async (itemId: string): Promise<FixGuardRecord | undefined> => {
    let raw: unknown
    try { raw = JSON.parse(await readFile(join(fixesDir, itemId, 'record.json'), 'utf8')) }
    catch { return undefined }
    if (typeof raw !== 'object' || raw === null) return undefined
    const one = raw as Record<string, unknown>
    if (typeof one.at !== 'string' || typeof one.files !== 'object' || one.files === null) return undefined
    return {
      itemId,
      at: one.at,
      ...(typeof one.body === 'object' && one.body !== null ? { body: one.body as Record<string, string> } : {}),
      files: one.files as Record<string, string>,
      ...(one.outcome === undefined ? {} : { outcome: one.outcome }),
    }
  }

  /**
   * 待核记录放太久(item 一直没交回)就当孤儿清掉,免得 `.修复/` 只进不出。
   * **已核的(留了 outcome)记录与证据(派活前备份)长留** —— 那是这次越界的唯一证据,不占地方,不清。
   */
  const sweepStaleGuards = async (): Promise<void> => {
    let ids: string[]
    try { ids = await readdir(fixesDir) }
    catch { return }
    for (const id of ids) {
      const record = await readGuardRecord(id)
      if (record === undefined) continue
      if (record.outcome !== undefined) continue
      if (Date.now() - Date.parse(record.at) > FIX_GUARD_STALE_MS) await rm(join(fixesDir, id), { recursive: true, force: true })
    }
  }

  const beginFixGuard = async (itemId: string): Promise<{ ok: true } | { ok: false, reason: string }> => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(itemId)) return { ok: false, reason: `事项 id「${itemId}」不对劲,守门没记` }
    try {
      const guardDir = join(fixesDir, itemId)
      await rm(guardDir, { recursive: true, force: true })
      await mkdir(join(guardDir, '之前'), { recursive: true })
      const files = await layerTree()
      // 内容备份:窗口内的东西一律不动,这份备份是她派活前状态的唯一留存(证据)。symlink 不跟读不拷。
      for (const [rel, hash] of Object.entries(files)) {
        if (hash.startsWith('link:')) continue
        const from = join(root, ...rel.split('/'))
        let isLink = false
        try { isLink = (await lstat(from)).isSymbolicLink() }
        catch { /* 读不到就跳过这一份 */ }
        if (isLink) continue
        const to = join(guardDir, '之前', ...rel.split('/'))
        await mkdir(dirname(to), { recursive: true })
        await copyFile(from, to)
      }
      const record: FixGuardRecord = { itemId, at: new Date().toISOString(), files }
      const body = await bodyTree()
      if (options.bodyDir !== undefined) record.body = body
      await writeFile(join(guardDir, 'record.json'), JSON.stringify(record), 'utf8')
      await sweepStaleGuards()
      return { ok: true }
    }
    catch (error) {
      return { ok: false, reason: `守门记账没记成(${(error as Error).message}),交回来时没有越界核对` }
    }
  }

  const pendingFixGuards = async (): Promise<string[]> => {
    await sweepStaleGuards()
    let ids: string[]
    try { ids = await readdir(fixesDir) }
    catch { return [] }
    const out: string[] = []
    for (const id of ids.sort()) {
      // 核过的(留了 outcome 与证据)不算待核;记证据的文件留在原地,由过期清扫收。
      const record = await readGuardRecord(id)
      if (record !== undefined && record.outcome === undefined) out.push(id)
    }
    return out
  }

  /** 待核记录清完后,`.修复/` 自己如果是空的了也摘掉(有别item的记录就留着)。 */
  const dropFixesRootIfEmpty = async (): Promise<void> => {
    await rmdir(fixesDir).catch(() => undefined)
  }

  const finishFixGuard = async (itemId: string, completedAt: string): Promise<FixGuardOutcome> => {
    const guardDir = join(fixesDir, itemId)
    const record = await readGuardRecord(itemId)
    if (record === undefined) return { kind: 'clean' }
    // 没接本体目录:没有越界的判据,记录与备份没有用处了,清掉如实当干净处理。
    if (record.body === undefined) {
      await rm(guardDir, { recursive: true, force: true })
      await dropFixesRootIfEmpty()
      return { kind: 'clean' }
    }
    // 本体指纹是全量内容哈希:等长改写(连 mtime 拨回)也在这里现形。
    const changed = diffKeys(await bodyTree(), record.body).sort()
    if (changed.length === 0) {
      // 本体没动:用户层里这次改的就是正常修复结果,记录清掉。
      await rm(guardDir, { recursive: true, force: true })
      await dropFixesRootIfEmpty()
      return { kind: 'clean' }
    }
    // 本体被改了:拒装。维修窗口内用户层变过的一切(改/删/新建/换 symlink)分不清是那家还是她自己
    // 动的 —— 一律原样保留、不复活、不挪走(卡的原文:无法安全归因则保留现状、明确阻塞)。
    // 「拒装」落在装载口:变过的小组件按指纹组合记成「先不装」(端上一版/标 broken),她改一个码自动恢复;
    // 磁盘上的文件一份不动。本体一份文件都不由这里碰。
    const now = await layerTree()
    const blocked = diffKeys(now, record.files).sort()
    const heldBack: string[] = []
    const touchedWidgetDirs = new Set<string>()
    for (const rel of blocked) {
      const parts = rel.split('/')
      if (parts[0] === '小组件' && parts.length > 2 && ID_RE.test(parts[1]!)) touchedWidgetDirs.add(parts[1]!)
    }
    for (const dirName of [...touchedWidgetDirs].sort()) {
      const current = await readVersion(widgetsDir, dirName)
      if (current.rev === undefined) continue // 清单/入口已经坏了的自然不装,不用记
      const key = comboKey(current.rev, current.view.style_rev)
      const revs = badRevs.get(dirName) ?? new Map<string, string>()
      if (revs.has(key)) continue
      revs.set(key, '派去改的那一家越界动了工作台本体,这次先不装:改一个码(或在设置里选回上一版)就恢复')
      badRevs.set(dirName, revs)
      heldBack.push(dirName)
    }
    if (heldBack.length > 0) await saveBadRevs()
    await writeFile(join(guardDir, 'record.json'), JSON.stringify({ ...record, outcome: { completed_at: completedAt, changed, blocked, held_back: heldBack } }, null, 2), 'utf8')
    return { kind: 'out-of-bounds', changed, blocked, held_back: heldBack }
  }

  return {
    dir: root,
    webWidgetsDir,
    ensure,
    scan: async () => {
      const [{ view }, { views: layouts }] = await Promise.all([scanWithEntries(), scanLayouts()])
      return { ...view, layouts }
    },
    async widgetCode(id) {
      if (!ID_RE.test(id)) return undefined
      const { view, entries } = await scanWithEntries()
      const hit = entries.get(id)
      const widget = view.widgets.find(one => one.id === id)
      if (hit === undefined || widget?.rev === undefined) return undefined
      try { return { code: await readFile(hit.file, 'utf8'), rev: widget.rev } }
      catch { return undefined }
    },
    async widgetStyle(id) {
      if (!ID_RE.test(id)) return undefined
      // 与代码同源:回退期间端的是上一版快照里那份样式,不是 live 目录里她改到一半的新文件。
      const { entries } = await scanWithEntries()
      const hit = entries.get(id)
      if (hit?.styleFile === undefined) return undefined
      try {
        const css = await readFile(hit.styleFile, 'utf8')
        const rev = createHash('sha256').update(css).digest('hex').slice(0, 12)
        return { css, rev }
      }
      catch { return undefined }
    },
    layoutTemplate(id) {
      if (!ID_RE.test(id)) return undefined
      return lastLayouts.find(one => one.template.id === id)?.template
    },
    layoutTemplates() {
      return lastLayouts.map(one => one.template)
    },
    layoutSkin(id) {
      if (!ID_RE.test(id)) return undefined
      return lastLayouts.find(one => one.template.id === id)?.skin
    },
    async report({ id, rev, ok, problem, style_rev }) {
      if (!ID_RE.test(id)) return
      const key = comboKey(rev, style_rev)
      if (!ok) {
        const revs = badRevs.get(id) ?? new Map<string, string>()
        revs.set(key, problem ?? '页面上没装上')
        badRevs.set(id, revs)
        await saveBadRevs()
        return
      }
      if (badRevs.get(id)?.delete(key) === true) await saveBadRevs()
      // 画好过的正是**当前文件**那一版才存(上一版自己报 ok 不用再存一遍)。
      const current = await readVersion(widgetsDir, id)
      if (current.rev !== rev || current.file === undefined) return
      const saved = await readVersion(lastGoodRoot, id)
      if (saved.rev === rev && saved.view.style_rev === current.view.style_rev) return
      // 最新一份(自动回退端的)+ 历史 3 份(设置里选回用的;含清单/入口/样式指纹)。
      const to = join(lastGoodRoot, id)
      await rm(to, { recursive: true, force: true })
      await mkdir(to, { recursive: true })
      await copyFile(join(widgetsDir, id, MANIFEST), join(to, MANIFEST))
      await copyFile(current.file, join(to, basename(current.file)))
      if (current.styleFile !== undefined) await copyFile(current.styleFile, join(to, 'style.css'))
      await saveHistoryEntry(id, current)
    },
    async widgetHistory(id) {
      if (!ID_RE.test(id)) return []
      return (await historyEntries(id)).map(({ rev, style_rev, at }) => ({ rev, ...(style_rev === undefined ? {} : { style_rev }), at }))
    },
    async restoreWidget(id, rev, styleRev) {
      if (!ID_RE.test(id)) return { ok: false as const, reason: '没有这一格' }
      // 按指纹找:给了样式指纹就精确对;没给就取存下的这一版里最新的(指纹组合的入口部分就是它)。
      const candidates = (await historyEntries(id)).filter(one => one.rev === rev)
      const entry = styleRev === undefined ? candidates[0] : candidates.find(one => one.style_rev === styleRev)
      if (entry === undefined) return { ok: false as const, reason: '没有存下这一版' }
      const from = join(historyRoot, id, entry.combo)
      const manifestText = await readFile(join(from, MANIFEST), 'utf8')
      const parsed = parseWidgetManifest(id, manifestText)
      if (!parsed.ok) return { ok: false as const, reason: '这一版的清单读不出来' }
      // 选回可逆:把当前可用版先存进历史(当前是坏的就不存 —— 坏版不进可选回历史)。
      // 这个「存没存成」同时决定下面能不能安全清掉旧入口文件:没存成就没有快照,文件必须留着。
      const current = await readVersion(widgetsDir, id)
      const preSaved = current.rev !== undefined && current.problem === undefined && current.file !== undefined
        && comboDirName(current.rev, current.view.style_rev) !== comboDirName(rev, styleRev)
      if (preSaved) await saveHistoryEntry(id, current)
      const to = join(widgetsDir, id)
      await mkdir(to, { recursive: true })
      // 现在的清单若指向另一个入口文件(a.js),选回 b.js 后 a.js 就是脏的:按旧清单点名清掉它。
      // 但只在这一版已经存进历史(字节可捞回)的时候清 —— 当前版是坏版时不预存(坏版按设计不进
      // 可选回历史),那份在制原件没有快照,留着(脏,零丢失),不删(2026-10-23 独立审残留 Minor)。
      const beforeText = await readFile(join(to, MANIFEST), 'utf8').catch(() => undefined)
      const beforeParsed = parseWidgetManifest(id, beforeText)
      const staleEntry = beforeParsed.ok && beforeParsed.entry !== parsed.entry ? beforeParsed.entry : undefined
      await copyFile(join(from, MANIFEST), join(to, MANIFEST))
      await copyFile(join(from, parsed.entry), join(to, parsed.entry))
      if (staleEntry !== undefined && preSaved) await rm(join(to, staleEntry), { force: true }).catch(() => undefined)
      // 她的 style.css 一字不动:不拿旧样式盖她的新文件。
      return { ok: true as const }
    },
    beginFixGuard,
    pendingFixGuards,
    finishFixGuard,
    async reveal() {
      await mkdir(root, { recursive: true })
      const ran = await runCommand(['open', root])
      return ran.ok ? { ok: true } : { ok: false, reason: 'Finder 没有响应' }
    },
  }
}

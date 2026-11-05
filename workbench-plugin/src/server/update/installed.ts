/**
 * 「只下变了的」(2026-09-18,Ben 看着 0.2.44 那 128MB 说的那句「好慢」)。
 *
 * ## 一句话
 *
 * 清单里每件产物钉着 sha256;这台机器上记一份「装着的那份是哪一份」
 * (`~/.dsh/updates/installed.json`)。两个数一样 = 同一份字节 = **连下载带安装整步跳过**。
 *
 * ## 为什么用 sha 而不用版本号
 *
 * 通话组件那 108MB 一个月也未必动一次,可它跟着工作台一起 bump 版本号。按版本号比,
 * 每次发版它都"新"了一遍;按 sha 比,字节没动就是没动。反过来也成立:有人手动改过
 * `~/.dsh/channel-worker` 里的东西,版本号照样对得上 —— 而 sha 会告诉你它不是那一份了。
 *
 * ## 第一次没有记录的时候
 *
 * 这个文件是这张卡新加的,所有老机器上都没有。所以还有一道**兜底**:对本机已经存在的
 * 那份产物现算一次 sha。今天只有插件 tgz 算得出来(它原样躺在 `~/.dsh/packages/plugin.tgz`),
 * 别的几样在本机是**解开之后的一棵目录**,压回去算不出同一个 sha:
 *
 * - 工人 / 事务官后端:`~/.dsh/channel-worker`、`~/.dsh/butler-server` 是 rsync 出来的目录,
 *   tar 一遍得到的字节跟发布机上打的那份不会一样(顺序、时间戳、owner 都不同);
 * - 壳:`/Applications/工作台.app` 更是这样,而且 ditto 出来的 zip 每次都不一样。
 *   壳这一样另有一道现成的门:**designated requirement 逐字比**(apply.ts 的 `shellDecision`),
 *   它管的是"换了会不会把辅助功能授权弄掉",不是"要不要下"。
 *
 * 所以兜底算不出来的,**一律照下**。「没查出来」不能当成「没变」(D13),
 * 而多下一趟的代价只是慢,少下一趟的代价是装了个半新不旧的机器。
 *
 * ## 这个文件丢了会怎样
 *
 * 下一次更新多下一趟,仅此而已 —— 它不是状态机,只是一张备忘。所以读它一律容错:
 * 文件不在、JSON 坏了、字段写歪了,统统退化成「一条记录都没有」。
 */
import type { SetupIo } from '../setup/io.ts'
import { LIVEKIT_MIN_MACOS_MAJOR, type SetupPaths } from '../setup/paths.ts'
import { sha256Of } from './download.ts'
import type {
  InstalledAssetRecord,
  InstalledAssets,
  UpdateAssetKind,
  UpdateManifest,
  UpdatePlanItem,
  UpdatePlanView,
} from './types.ts'
import { DOWNLOADED_ASSET_KINDS, isUpdateAssetKind, UPDATE_ASSET_TITLES } from './types.ts'

const SHA256_RE = /^[0-9a-f]{64}$/

/** 空记录。读不出来、解析不了,一律回它。 */
export function emptyInstalled(): InstalledAssets {
  return { assets: {} }
}

/**
 * 一段 JSON 文本 → 记录。**任何读不懂都退化成空**,绝不抛 ——
 * 一份写坏的备忘不该让"检查更新"这件事整个失败。
 */
export function parseInstalled(text: string | undefined): InstalledAssets {
  if (text === undefined || text.trim() === '') return emptyInstalled()
  let body: unknown
  try { body = JSON.parse(text) }
  catch { return emptyInstalled() }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return emptyInstalled()
  const raw = body as Record<string, unknown>
  const assetsRaw = raw.assets
  const assets: Partial<Record<UpdateAssetKind, InstalledAssetRecord>> = {}
  if (typeof assetsRaw === 'object' && assetsRaw !== null && !Array.isArray(assetsRaw)) {
    for (const [key, value] of Object.entries(assetsRaw as Record<string, unknown>)) {
      if (!isUpdateAssetKind(key)) continue
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const item = value as Record<string, unknown>
      const sha256 = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : ''
      // sha 的形状不对就当这一条不存在 —— 不能留一个"空校验和于是判成没变"的缝。
      if (!SHA256_RE.test(sha256)) continue
      assets[key] = {
        sha256,
        version: typeof item.version === 'string' ? item.version : '',
        at: typeof item.at === 'string' ? item.at : '',
      }
    }
  }
  const version = typeof raw.version === 'string' && raw.version.trim() !== '' ? raw.version.trim() : undefined
  const updatedAt = typeof raw.updated_at === 'string' && raw.updated_at.trim() !== '' ? raw.updated_at.trim() : undefined
  return {
    ...(version === undefined ? {} : { version }),
    ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    assets,
  }
}

export function serializeInstalled(record: InstalledAssets): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

export async function readInstalled(io: SetupIo, paths: SetupPaths): Promise<InstalledAssets> {
  return parseInstalled(await io.readFile(paths.installedJson))
}

/**
 * 把这一趟装上去的那几件记下来。**只改动过的那几条**,没碰过的原样留着 ——
 * 这一版只发了插件,工人那一条("上一版装的那份")还得算数,否则下一版又要重下一趟。
 */
export async function writeInstalled(
  io: SetupIo,
  paths: SetupPaths,
  base: InstalledAssets,
  updates: Partial<Record<UpdateAssetKind, InstalledAssetRecord>>,
  meta: { version: string, at: string },
): Promise<InstalledAssets> {
  const next: InstalledAssets = {
    version: meta.version,
    updated_at: meta.at,
    assets: { ...base.assets, ...updates },
  }
  await io.writeFile(paths.installedJson, serializeInstalled(next))
  return next
}

/**
 * 没有记录时的兜底:对本机已经存在的那份产物现算一次 sha。
 *
 * **今天只有插件 tgz 有意义**(理由见文件头)。算不出来就不回 —— 调用方据此照下。
 */
export async function localShaOf(io: SetupIo, paths: SetupPaths): Promise<Partial<Record<UpdateAssetKind, string>>> {
  const out: Partial<Record<UpdateAssetKind, string>> = {}
  // 热更新装插件时是 `assets/plugin.tgz` 原样复制过去的,所以名字是定的。
  // 安装器那条路落的是 `ben-dsh-workbench-<版本>.tgz`,名字对不上,那就算不出来 —— 照下。
  const plugin = await sha256Of(io, `${paths.packagesDir}/plugin.tgz`)
  if (plugin !== undefined) out.plugin_tgz = plugin
  return out
}

/**
 * 这台电脑上**确实没有**的那几样(2026-10-21,局域网主路卡 M1)。今天只判得出本机通话服务:
 * 清单带了 `livekit_tgz`、`~/.dsh/livekit/livekit-server` 不在、系统够得上(macOS 15 起)。
 *
 * 为什么要这一条:0.4.143 及以前装的机器、以及由旧插件跑完那趟更新的机器,本机都没有这个二进制,
 * 而 `installed.json` 里也没有它那一行 —— 只看记录它是 `none`,第 ③ 档不数,版本号一样的那一趟就永远不装它。
 * 文件在不在是**事实**,不是猜。系统不够新的机器上本来就跑不了它,不算「没装」(不然每次都报一样装不上的东西)。
 * 清单没带它就不问系统版本:`/update/check` 每一趟都走这里。
 */
export async function absentKindsOf(io: SetupIo, paths: SetupPaths, manifest: UpdateManifest): Promise<UpdateAssetKind[]> {
  if (manifest.assets.livekit_tgz === undefined) return []
  if (await io.stat(paths.livekitBin) !== undefined) return []
  const macos = (await io.exec(['sw_vers', '-productVersion'])).out.trim()
  const major = Number(macos.split('.')[0])
  if (Number.isInteger(major) && major > 0 && major < LIVEKIT_MIN_MACOS_MAJOR) return []
  return ['livekit_tgz']
}

/**
 * 这一趟只办哪几件、哪几件一律重办(2026-09-26,卡 U6)。
 *
 * 缺省两样都不给 = 今天的行为(清单里会下载的全进账,按 sha 判变没变)。
 */
export interface UpdatePlanScope {
  /** 只把这几件算进这一趟。运行环境漂移那一趟是 `['runtime_tgz']`。 */
  only?: readonly UpdateAssetKind[]
  /** 这几件一律当"变了",不管 `installed.json` 里记着什么。 */
  force?: readonly UpdateAssetKind[]
  /**
   * **本机那份现算出来的 sha 胜过那条记录**(2026-10-03,「组件有变就装」那张卡)。
   *
   * 为什么要这一档:发版闸(`deploy/local-install-gate.sh`)用 `cp` + `dsh plugin add` 把
   * 新插件装到发版那台机器上,它是条 shell,**不会去改 `installed.json`** —— 于是那份备忘
   * 还记着上一版的 sha,而 `~/.dsh/packages/plugin.tgz` 已经是这一版那一份字节了。
   * 照记录判,插件会被每次发版都重装一遍、机器多重启一次;而躺在盘上的那份字节是**事实**,
   * 那条记录只是一张备忘(见文件头)——**事实与备忘冲突时按事实**。
   *
   * 只在「清单版本号与跑着的插件版本号相等」那一趟开(service.ts)。版本号真有新版那一趟
   * 一个字不改:那时候跑着的插件就是旧的,盘上那份字节碰巧对得上也不足以说"装过了"
   * (复制成了、`add` 失败,正是这种形状)。
   */
  localFirst?: boolean
}

/**
 * 这次到底下哪几件。**纯函数** —— 所有 I/O 都在外面做完了传进来。
 *
 * @param installed `installed.json` 里那份记录
 * @param localSha  没记录时现算出来的兜底 sha(`localShaOf`)
 * @param scope     这一趟的范围(缺省 = 全部,按 sha 判)
 * @param absent    这台电脑上确实没有的那几样(`absentKindsOf`)。**压过记录**:记录说装过、文件却不在,按文件
 */
export function planAssets(
  manifest: UpdateManifest,
  installed: InstalledAssets,
  localSha: Partial<Record<UpdateAssetKind, string>> = {},
  scope: UpdatePlanScope = {},
  absent: readonly UpdateAssetKind[] = [],
): UpdatePlanView {
  const items: UpdatePlanItem[] = []
  let bytes = 0
  let allBytes = 0
  let changed = 0
  for (const kind of DOWNLOADED_ASSET_KINDS) {
    const asset = manifest.assets[kind]
    if (asset === undefined) continue
    // 「这一趟只办这几件」:别的连账都不进 —— 界面上那句「几项里几项有变化」说的就是这份账,
    // 把不办的也算进去等于当场说一句不准的话。
    if (scope.only !== undefined && !scope.only.includes(kind)) continue
    const title = UPDATE_ASSET_TITLES[kind]
    allBytes += asset.size
    const recorded = installed.assets[kind]?.sha256
    const local = localSha[kind]
    let item: UpdatePlanItem
    if (scope.force?.includes(kind) === true) {
      /**
       * **一律当"变了"**。运行环境漂移那一趟要的就是这个:`installed.json` 里可能记着
       * 一份 sha 完全相同的记录(某一趟装过),而运行时目录里躺着的仍是旧那棵树 ——
       * 照 sha 判会把这一件跳过,于是那趟更新一步也不跑、漂移原地不动。
       * 判"要不要装"的是运行环境本身(`readRuntimeDrift`),不是那份记录。
       */
      item = { kind, title, size: asset.size, changed: true, source: 'none', why: `${title}:这台电脑上装着的跟这一版对不上,这一趟专门装它。` }
    }
    else if (absent.includes(kind)) {
      item = { kind, title, size: asset.size, changed: true, source: 'missing', why: `${title}:这台电脑上还没有它,这一趟装上。` }
    }
    else if (recorded !== undefined && recorded === asset.sha256) {
      item = { kind, title, size: asset.size, changed: false, source: 'record', why: `${title}:跟这台电脑上装着的那份一模一样,这次不下也不装。` }
    }
    else if (recorded === undefined && local !== undefined && local === asset.sha256) {
      item = { kind, title, size: asset.size, changed: false, source: 'local', why: `${title}:本机那份算出来的校验和跟清单里的一样,这次不下也不装。` }
    }
    else if (scope.localFirst === true && local !== undefined && local === asset.sha256) {
      /**
       * 记录说对不上,**可盘上那份字节就是这一版的那一份**(2026-10-03)。
       * 发版闸装插件时不会去改那份备忘,照记录判会白装一遍、白重启一次(见 `scope.localFirst`)。
       */
      item = { kind, title, size: asset.size, changed: false, source: 'local', why: `${title}:本机装着的那一份跟这一版的一模一样(这台电脑上那条记录陈了),这次不下也不装。` }
    }
    else if (recorded !== undefined) {
      item = { kind, title, size: asset.size, changed: true, source: 'record', why: `${title}:变了,要下一份新的。` }
    }
    else if (local !== undefined) {
      item = { kind, title, size: asset.size, changed: true, source: 'local', why: `${title}:本机那份跟清单里的对不上,要下一份新的。` }
    }
    else {
      // 没记录也算不出来。**照下** —— 没查出来不等于没变(D13)。
      item = { kind, title, size: asset.size, changed: true, source: 'none', why: `${title}:这台电脑上没记过它是哪一份,这次照下一趟(下完就记下来,以后没变就不下了)。` }
    }
    items.push(item)
    if (item.changed) { changed += 1; bytes += asset.size }
  }
  return { items, total: items.length, changed, bytes, all_bytes: allBytes }
}

/**
 * 这份账里**有凭据说明这台电脑上那一份跟这一版对不上**的那几件(2026-10-03)。
 *
 * 「有更新」的第三档(`service.ts` 的 `components_behind`)数的就是它:版本号一样,
 * 可事务官后端 / 通话组件这些还是旧的 —— 0.4.89 发完那十分钟就是这个形状。
 *
 * **为什么不是直接用 `plan.changed`**:`source: 'none'` 那几件说的是"这台电脑上没记过
 * 它是哪一份"。下载时它们照下(「没查出来」不等于「没变」,D13),但那不等于可以对人说
 * 「你这台少了 5 样」—— 刚用安装包装好的机器压根没有 `installed.json`,那样每一台新机器
 * 一打开就会被告知有一堆东西没装。**不知道就不说**(D13 的另一面)。
 */
export function behindItems(plan: UpdatePlanView): readonly UpdatePlanItem[] {
  return plan.items.filter(item => item.changed && item.source !== 'none')
}

/** 计划里这一件要不要下。`apply.ts` 与界面共用同一个判断,免得两处各说一套。 */
export function isChangedIn(plan: UpdatePlanView | undefined, kind: UpdateAssetKind): boolean {
  if (plan === undefined) return true
  const item = plan.items.find(one => one.kind === kind)
  return item === undefined ? true : item.changed
}

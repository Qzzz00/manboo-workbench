/**
 * 布局模板的落盘与切换(2026-09-21)。
 *
 * 纯定义在 `src/templates.ts`(两边共用,一行 I/O 都没有);这个文件管三件事:
 *
 * 1. **当前模板 id** 落 `~/.dsh/workbench/template.json`。读不到 / 写坏了 / 认不出的 id
 *    一律兜底成 `product` —— 它就是现状,认不出模板不该让工作台变成另一个样子。
 * 2. **切换前自动存一份可回退的备份** 到 `~/.dsh/workbench/template-backups/`。
 *    备份里是**整份 `WorkbenchLayout`**(横竖两支 + butler 位置 + 各种视图开关)加上
 *    当时的模板 id —— 回退就是把这一份原样写回去。
 * 3. **apply**:写横竖布局 + 登记窗位应用 + 在工作目录下建文件夹(**只建不删**)+
 *    记下当前模板 id。不重启工作台:界面每秒轮询一次 `/state`,下一拍就是新布局。
 *
 * ## 为什么不复用 server/layoutSnapshot.ts 那份「布局快照」
 *
 * 名字像,东西不是。那一份产出的是 markdown + html(给事务官读「工作台现在长什么样」),
 * **读不回来**:它没有存原始的 layout 对象,只存了渲染出来的表格与骨架页。要拿它回退,
 * 得写一个把 markdown 表格解析回 LayoutModule 的解析器 —— 那是把一份给人看的文档当接口用,
 * 表格里改一个字就全崩。所以这里另存一份 JSON,**两者各干各的**,决策记录里写明了这个取舍。
 *
 * ## 「不许删」贯穿全文件
 *
 * 建文件夹只 `mkdir -p`,一个文件都不删、不移、不改名(2026-09-04 那条事故纪律)。
 * 备份只在超过上限时删**自己写的**、**文件名对得上**的那几份,目录里别的东西一律不碰
 * (同 layoutSnapshot.prune 的规矩)。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LayoutModule, TemplateStateView, WorkbenchLayout } from '../protocol.ts'
import type { TemplateApp, WorkbenchTemplate } from '../templates.ts'
import {
  DEFAULT_MODULE_TITLES, DEFAULT_TEMPLATE_ID, OPS_FAVORITES_NAME, OPS_FAVORITES_REL,
  PRODUCT_TEMPLATE, allTemplates, isSafeTemplateRel, templateById,
} from '../templates.ts'
import { favoritesSeedText } from './favoriteLinks.ts'

export function defaultTemplateFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/template.json`
}

export function defaultTemplateBackupsDir(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/template-backups`
}

/**
 * 还没有工作目录、所以这个模板该建的文件夹一个都没建时,回出去的那一句(2026-09-26,卡 ZM)。
 *
 * 写成常量而不是就地拼:界面原样显示它,用例也钉它 —— 两头对着同一份字,
 * 措辞改了两边一起红(同 REVIEW_NOT_WIRED_LINE 那几句的先例)。
 *
 * 一句话里三样都要有:**没做成什么**(文件夹没建)、**为什么**(还没设工作目录)、
 * **下一步点哪儿**(设置里那一项)。不出现「butler_cwd」这种英文键名(三层清单第三节)。
 */
export const MISSING_CWD_NOTE
  = '这个模板要在工作目录下建几个文件夹,但还没有设工作目录,所以这次一个都没建 —— '
  + '在设置的「目录」那一节里填好「事务官仓库」,再切一次这个模板,文件夹就会建好。'

/** 落盘的那一行。`version` 现在只有 1;以后加字段一律 additive(旧文件不迁移)。 */
export interface TemplateFile {
  version: 1
  id: string
  applied_at?: string
}

/** 一份备份。整份 layout 原样存着,回退就是把它写回去。 */
export interface TemplateBackup {
  version: 1
  /** 存这一份的时候,当前模板是哪个。回退时连它一起还原。 */
  template_id: string
  saved_at: string
  layout: WorkbenchLayout
  /** 存这一份是为了切到哪个模板去(只给人看,回退不读它)。 */
  applying?: string
  /**
   * 存这一份是为了什么(2026-09-22「用自然语言改布局」)。切模板时是模板名,
   * 说一句话改布局时是那句复述。**只给人看**,回退不读它 —— 同 `applying`。
   */
  reason?: string
}

/** 备份文件名:`backup-<ISO 里能进文件名的那部分>-<随机 6 位>.json`。 */
const BACKUP_RE = /^backup-[0-9TZ-]+-[0-9a-f]{6}\.json$/

export interface TemplateServiceOptions {
  /** 当前模板 id 落在哪。 */
  file: string
  /** 备份目录。 */
  backupsDir: string
  /** 读此刻的布局。拿不到(项目区没接线)回 undefined —— 那就没有可备份的东西。 */
  readLayout: () => Promise<WorkbenchLayout | undefined>
  /** 写布局。 */
  writeLayout: (layout: WorkbenchLayout) => Promise<void>
  /**
   * 工作目录(butler_cwd)。**同步取值**,读的是已经算好的那一份(wbPathsEffective)。
   * 不传 / 回 undefined = 这台机器没配工作目录:**不建任何文件夹**,`asset_dirs` 整块缺席
   * (D13:没有的东西不摆空壳,更不猜一个路径去建目录)。
   */
  butlerCwd?: () => string | undefined
  /**
   * 把这几个窗位键记成「用户亲手加的」(appsRegistry.enable 那条路)。
   * 不传 = 没接窗位清单,apply 的别的几件照跑,窗位那一件如实写进结果里。
   */
  enableApps?: (keys: readonly string[]) => Promise<{ enabled: string[], already: string[], unknown: string[] }>
  /** 注册一个模板自带的原生应用(appsRegistry.addResolved)。不传即跳过。 */
  registerApp?: (info: { bundle_id: string, name: string }) => Promise<{ ok: boolean, key?: string, reason?: string }>
  /** 当前时刻。默认 Date.now,测试注入固定时钟。 */
  now?: () => number
  /** 最多留几份备份,默认 10。 */
  keepBackups?: number
  /**
   * 此刻认得的模板清单(2026-10-23,分层二刀二)。缺省走 templates.ts 的全局 source
   * (启动时由 index.ts 把用户层 `布局/*.json` 注进去);接线的服务传这个,免得每次
   * 绕模块级状态。detail() 列这里的全部,apply() 只认这里面的 id。
   */
  templates?: () => readonly WorkbenchTemplate[]
  /**
   * 切过去(或回退)之后调一下(2026-09-21)。
   *
   * 存在的理由只有一个:模板决定项目区读哪个数据源,切完要让项目区的扫描缓存当场作废 ——
   * 否则最多有一个节流周期(30 秒)的时间,界面上显示的还是上一个数据源扫出来的东西,
   * 看着像"切了没生效"。**抛了不拦切换本身**:布局已经换过去了,一次缓存没清干净
   * 不该让整件事回滚。
   */
  onApplied?: () => void
}

export interface TemplateApplyResult {
  ok: boolean
  reason?: string
  /** 这次 apply 存下的那份备份的文件名(没有可备份的布局时缺席)。 */
  backup?: string
  /** 真的建出来的文件夹(相对工作目录);工作目录没配时是空数组。 */
  folders_made: string[]
  /** 建文件夹时逐条失败的原因,如实回出去(D13),不静默吞掉。 */
  folder_errors: string[]
  /**
   * 「这个模板该建的文件夹这次一个都没建,因为还没有工作目录」那一句(2026-09-26,卡 ZM)。
   *
   * 工作目录(`butler_cwd`)没有默认值(pathConfig.ts:「事务官仓库没有默认值——不猜路径」),
   * 而 `makeFolders` 在它缺席时**直接回空**:`folders_made: []` + `folder_errors: []`。
   * 界面(TemplatePanel)只在这两个数组非空时才说话,于是切到自媒体运营模板的人看到的是
   * 一句干干净净的「已经切过去了」—— 而「账号」「选题」「素材/*」七格与「收藏网址」
   * 一个都没建出来,`/state.template.asset_dirs` 跟着整块缺席,素材管理那一行
   * (「不传 / 空 = 这一行整条不画」)也不画。**界面上一切正常,东西没了** ——
   * 与 cookie 那一行 id 写错、页面写死 8791 同一类的沉默失效。
   *
   * 所以这里不再沉默:缺工作目录时把「没建、为什么、下一步点哪儿」如实写成一句话,
   * 界面原样显示。**缺席 = 这次没有这种情况**(工作目录配着,照旧只看上面两个数组)。
   */
  folders_note?: string
  /** 窗位清单这一件的结果。没接 registry 时是一句人话。 */
  apps_note: string
}

/** `GET /template` 回的那一份。设置里两张卡片要的东西全在这儿。 */
export interface TemplateDetail {
  current: string
  has_backup: boolean
  /** 最近一份备份存于什么时候(ISO)。没有备份时缺席。 */
  last_backup_at?: string
  /**
   * 盘上记的当前模板这会儿认不出来时的一句人话(2026-10-23,分层二刀二 —— 比如她删了
   * 或改坏了 用户层/布局/ops.json,而 template.json 里记着 "ops")。设置里那张卡原样上屏;
   * 缺席 = 没有这种情况。
   */
  note?: string
  templates: readonly {
    id: string
    name: string
    tagline: string
    project_word: string
    current: boolean
    /** 这个模板会往窗位清单里放哪几个应用(给卡片上那行小字用)。 */
    apps: readonly { label: string, kind: 'native' | 'web', note?: string }[]
    /** 这个模板会在工作目录下建哪几个文件夹。 */
    folders: readonly string[]
    board_lanes: readonly string[]
  }[]
}

export interface TemplateService {
  /** 启动时调一次:把盘上的当前模板 id 读进内存。读不到就是 product。 */
  load: () => Promise<void>
  currentId: () => string
  current: () => WorkbenchTemplate
  /** 进 `/state.template` 的那一块。 */
  view: () => TemplateStateView
  detail: () => Promise<TemplateDetail>
  apply: (id: unknown) => Promise<TemplateApplyResult>
  /** 回退上一份备份。没有备份时 ok:false + 一句人话。 */
  restore: () => Promise<{ ok: boolean, reason?: string, template_id?: string }>
  /**
   * 存一份此刻布局的可回退备份(2026-09-22「用自然语言改布局」)。
   *
   * ## 为什么跟切模板**共用同一个栈**,而不是另开一份
   *
   * 两件事产出的东西是同一样:一份完整的 `WorkbenchLayout`。回退它们的动作也是同一个:
   * 把那一份原样写回去。分两个栈的后果是他点「回退上次」时要先想清楚"上次"是哪一次
   * —— 而「上一步」这个概念在他脑子里只有一个。所以:**一个栈,按时间,回退最近那一步**,
   * 不管那一步是切模板还是说了一句话。(可推翻,决策记录里记了一份。)
   *
   * 布局读不出来(项目区没接线)时回 `ok:false` —— **没有可备份的东西时不该假装存上了**,
   * 调用方据此决定要不要继续(`/layout/act` 选择继续,并在回包里如实说"这次没有快照")。
   */
  snapshotLayout: (reason: string) => Promise<{ ok: boolean, id?: string, reason?: string }>
}

/**
 * 一条模板文件夹路径合不合法。2026-10-23 起本体在 templates.ts(布局 parser 在
 * server/userLayer.ts 也要用);这里 re-export 保持老 import 不破。
 */
export { isSafeTemplateRel }

export async function loadTemplateFile(file: string): Promise<TemplateFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return { version: 1, id: DEFAULT_TEMPLATE_ID }
  }
  try {
    const parsed = JSON.parse(text) as Partial<TemplateFile> | null
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, id: DEFAULT_TEMPLATE_ID }
    /**
     * 盘上记的 id **原样保留**(2026-10-23,分层二刀二):这是用户的选择,不是本体的判断。
     * 她选的布局这会儿认不出来(用户层那份被删 / 改坏了)→ 运行期 current() 退回 product、
     * 设置里说一句,但 template.json 里的 id 不动 —— 她把 用户层/布局/X.json 修好(或放回去),
     * 下一拍 source 认得它了,current() / view() / 皮肤自己回来,不用她再切一次。
     * 读不出 / 写坏才兜底 product(只落在内存,不写回盘)。
     */
    const id = typeof parsed.id === 'string' && parsed.id.trim() !== '' ? parsed.id : DEFAULT_TEMPLATE_ID
    return {
      version: 1,
      id,
      ...(typeof parsed.applied_at === 'string' ? { applied_at: parsed.applied_at } : {}),
    }
  }
  catch {
    return { version: 1, id: DEFAULT_TEMPLATE_ID } // 写坏了按现状兜底,先例见 scenes.ts / appsRegistry.ts。
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

export async function saveTemplateFile(file: string, data: TemplateFile): Promise<void> {
  await writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}

/**
 * 把一份模板的两份排布写进布局里。
 *
 * **只换 `modules` 与 `landscape.modules` 两处**,别的字段(butler 浮窗位置与尺寸、
 * pureMode、projects_view / board_axis、landscape.rail_pct / butler_pos)
 * 一个字不动 —— 它们是"看什么"和"浮窗摆哪儿",不是"模块怎么排";换个模板把用户拖了
 * 半天的浮窗弹回右下角,是这类功能最容易犯、也最气人的错。
 *
 * 纯函数,不读盘不读时钟,给测试直接对。
 */
export function applyTemplateToLayout(layout: WorkbenchLayout, template: WorkbenchTemplate): WorkbenchLayout {
  return {
    ...layout,
    modules: template.portrait.map(module => ({ ...module })),
    landscape: {
      ...(layout.landscape ?? {}),
      modules: template.landscape.map(module => ({ ...module })),
    },
  }
}

/**
 * 模板后来才加的格子(2026-10-12 起:`today` 今天的待办)。老布局是按旧模板写的,缺它就永远看不见 ——
 * 读路径上**只补这几格**:按模板给的那一份插在它前一格后面,别的格(他挪过、拖过、收起过的)一个字不动;
 * 已经有了(哪怕收起着)原样返回。模板里没有的 id(做产品模板)不补。
 */
export const TEMPLATE_ADDED_MODULE_IDS = ['today'] as const

export function addMissingTemplateModules(
  modules: readonly LayoutModule[], templateModules: readonly LayoutModule[],
): readonly LayoutModule[] {
  let out: LayoutModule[] | undefined
  for (const id of TEMPLATE_ADDED_MODULE_IDS) {
    const list = out ?? modules
    if (list.some(one => one.id === id)) continue
    const index = templateModules.findIndex(one => one.id === id)
    if (index < 0) continue
    const before = templateModules[index - 1]?.id
    const at = before === undefined ? -1 : list.findIndex(one => one.id === before)
    const next = [...list]
    next.splice(at < 0 ? next.length : at + 1, 0, { ...(templateModules[index] as LayoutModule) })
    out = next.map((one, order) => ({ ...one, order }))
  }
  return out ?? modules
}

/** 横竖两份都按模板补(纯函数;模板缺席 = 不补)。什么都没补时原样返回同一个对象。 */
export function withTemplateModules(layout: WorkbenchLayout, template: WorkbenchTemplate | undefined): WorkbenchLayout {
  if (template === undefined) return layout
  const modules = addMissingTemplateModules(layout.modules, template.portrait)
  const landscape = layout.landscape === undefined ? undefined : addMissingTemplateModules(layout.landscape.modules, template.landscape)
  if (modules === layout.modules && landscape === layout.landscape?.modules) return layout
  return {
    ...layout,
    modules: [...modules],
    ...(layout.landscape === undefined || landscape === undefined ? {} : { landscape: { ...layout.landscape, modules: [...landscape] } }),
  }
}

/**
 * 读路径的总闸(2026-10-23,分层二刀二):她选的模板这会儿**解析不出来**(用户层那份被删 /
 * 改坏了,current() 已退回 product)→ 横竖 modules 按 product 那份**换掉**,界面回到通用样子
 * (不只补个 today 格 —— 旧网格还是运营那一套,模块标题却对不上)。模板缺席服务、或
 * current() 就是她选的那个(product 机器、模板好好的 ops 机器)→ 维持 withTemplateModules
 * 的老行为,一个字不动。
 */
export function withFallbackTemplateModules(
  layout: WorkbenchLayout,
  template: WorkbenchTemplate | undefined,
  currentId: string | undefined,
): WorkbenchLayout {
  if (template === undefined || currentId === undefined || template.id === currentId) {
    return withTemplateModules(layout, template)
  }
  return {
    ...layout,
    modules: template.portrait.map(module => ({ ...module })),
    ...(layout.landscape === undefined
      ? {}
      : { landscape: { ...layout.landscape, modules: template.landscape.map(module => ({ ...module })) } }),
  }
}

/** `/state.template` 那一块。纯函数:给一个模板 + 工作目录 + 有没有备份,拼出那份视图。 */
export function templateStateView(
  template: WorkbenchTemplate,
  opts: { butlerCwd?: string | undefined, hasBackup: boolean },
): TemplateStateView {
  const assetDirs: Record<string, string> = {}
  if (opts.butlerCwd !== undefined && opts.butlerCwd !== '') {
    for (const folder of template.folders) {
      if (!isSafeTemplateRel(folder.rel)) continue
      const name = folder.rel.split('/').pop() as string
      assetDirs[name] = `${opts.butlerCwd}/${folder.rel}`
    }
  }
  /**
   * 素材那一行的第八格「收藏网址」(2026-09-21)。它是**文件**不是文件夹,所以单独一块
   * (protocol 里 `asset_files` 的注释写了为什么不混进 asset_dirs)。
   * 只有带着这个文件的模板(现在只有运营)才有;工作目录没配时同样整块缺席。
   */
  const assetFiles: Record<string, string> = {}
  if (opts.butlerCwd !== undefined && opts.butlerCwd !== '' && template.files.includes(OPS_FAVORITES_REL)) {
    assetFiles[OPS_FAVORITES_NAME] = `${opts.butlerCwd}/${OPS_FAVORITES_REL}`
  }
  const webApps = template.apps
    .filter((app): app is TemplateApp & { url: string } => app.kind === 'web' && typeof app.url === 'string')
    .map(app => ({ key: app.key, label: app.label, url: app.url }))
  return {
    id: template.id,
    name: template.name,
    project_word: template.project_word,
    project_empty_line: template.project_empty_line,
    module_titles: { ...DEFAULT_MODULE_TITLES, ...template.module_titles },
    board_lanes: template.board_lanes,
    ...(Object.keys(assetDirs).length === 0 ? {} : { asset_dirs: assetDirs }),
    ...(Object.keys(assetFiles).length === 0 ? {} : { asset_files: assetFiles }),
    ...(webApps.length === 0 ? {} : { web_apps: webApps }),
    has_backup: opts.hasBackup,
  }
}

/**
 * 把用户自己起的模块名(`layout.titles`)盖在模板给的那一份之上(2026-09-22)。
 *
 * **纯函数**,给 composeState 用。顺序是"默认 → 模板 → 他自己起的" —— 他亲手说过的那个名字
 * 排最后,因为那是他刚刚才说的话,没有任何理由被一份内置数据盖回去。
 *
 * 布局缺席、或者他一个名字都没改过时**原样返回同一个对象**:这块代码在绝大多数机器上
 * 什么都不做,不该因此多出一次对象拷贝。
 */
export function withLayoutTitles(
  view: TemplateStateView, layout: WorkbenchLayout | undefined,
): TemplateStateView {
  const titles = layout?.titles
  if (titles === undefined || Object.keys(titles).length === 0) return view
  return { ...view, module_titles: { ...view.module_titles, ...titles } }
}

export function createTemplateService(opts: TemplateServiceOptions): TemplateService {
  const now = opts.now ?? (() => Date.now())
  const keepBackups = Math.max(1, opts.keepBackups ?? 10)
  /** 此刻认得的模板清单:product 永远打头(它是本体自带的那一份),其余来自 provider / 全局 source,按 id 去重。 */
  const listTemplates = (): readonly WorkbenchTemplate[] => {
    const seen = new Map<string, WorkbenchTemplate>()
    for (const template of [PRODUCT_TEMPLATE, ...(opts.templates?.() ?? allTemplates())]) seen.set(template.id, template)
    return [...seen.values()]
  }
  /**
   * 按 id 找一个模板:先查自己这份清单(provider / 全局 source),缺了再问 templates.ts 的
   * 全局 source。**这个服务自己解析自己列的清单** —— detail() 列得出、apply() 就切得过去,
   * 两处不再可能一份认一份不认(2026-10-23,分层二刀二:清单来自用户层,全局来源是另一处注册)。
   */
  const resolveTemplate = (id: string): WorkbenchTemplate | undefined =>
    listTemplates().find(template => template.id === id) ?? templateById(id)
  let currentId: string = DEFAULT_TEMPLATE_ID
  /** 备份文件名从新到旧。启动时从目录里捞一次,之后自己维护。 */
  let backups: string[] = []
  // 写队列,先例见 scenes.ts / appsRegistry.ts:load→改→save 不排队会丢更新。
  let writeQueue: Promise<unknown> = Promise.resolve()
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async function listBackups(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(opts.backupsDir)
    }
    catch {
      return [] // 目录还不存在(从没切过模板)—— 没什么可列的,不是错。
    }
    // 文件名里的时间戳是 ISO,字典序即时间序;倒过来就是从新到旧。
    return names.filter(name => BACKUP_RE.test(name)).sort().reverse()
  }

  async function saveBackup(layout: WorkbenchLayout, applying: string, reason?: string): Promise<string> {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const name = `backup-${stamp}-${randomUUID().slice(0, 6)}.json`
    const data: TemplateBackup = {
      version: 1,
      template_id: currentId,
      saved_at: new Date(now()).toISOString(),
      layout,
      applying,
      ...(reason === undefined ? {} : { reason }),
    }
    await writeAtomic(join(opts.backupsDir, name), `${JSON.stringify(data, null, 2)}\n`)
    backups = [name, ...backups]
    // 超了就删最旧的那几份,**只删自己写的、文件名对得上的**(目录是 ~/.dsh 下的,
    // 不是我们独占的;别人放进来的文件一律不碰,同 layoutSnapshot.prune)。
    while (backups.length > keepBackups) {
      const oldest = backups.pop()
      if (oldest === undefined) break
      try { await unlink(join(opts.backupsDir, oldest)) }
      catch { /* 删不掉这一份不拦别的,也不拦切换本身。 */ }
    }
    return name
  }

  async function makeFolders(template: WorkbenchTemplate): Promise<{ made: string[], errors: string[], note?: string }> {
    const made: string[] = []
    const errors: string[] = []
    const cwd = opts.butlerCwd?.()
    if (cwd === undefined || cwd === '') {
      // 这个模板本来就不建东西(做产品那一份 folders / files 都是空的)→ 没有"没建成"这回事,
      // 不要为了一个它压根不需要的工作目录吓唬人。
      if (template.folders.length === 0 && template.files.length === 0) return { made, errors }
      return { made, errors, note: MISSING_CWD_NOTE }
    }
    for (const folder of template.folders) {
      if (!isSafeTemplateRel(folder.rel)) {
        errors.push(`${folder.rel}:路径不合法,没建(只能是工作目录下的相对路径)`)
        continue
      }
      try {
        // mkdir -p:已经有了就什么都不做。**只建不删** —— 里面已经有的文件一个不动。
        await mkdir(join(cwd, folder.rel), { recursive: true })
        made.push(folder.rel)
      }
      catch (error) {
        errors.push(`${folder.rel}:${error instanceof Error ? error.message : String(error)}`)
      }
    }
    /**
     * 模板带的那几个**文件**(现在只有运营模板的「收藏网址」)。
     *
     * **已经有了就一个字都不动** —— 这是他的收藏,不是我们的模板产物;
     * 重新 apply 一次模板(或者切走再切回来)不该把他攒的一屏链接换成一份空模板。
     * 建不出来的如实记进 folder_errors,不静默吞掉(D13)。
     */
    for (const rel of template.files) {
      if (!isSafeTemplateRel(rel)) { errors.push(`${rel}:路径不合法,没建`); continue }
      const path = join(cwd, rel)
      try {
        await stat(path)
        // 有了。不写、不报"建了",连 made 都不进 —— 没发生的事不许写进结果。
      }
      catch {
        try {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, favoritesSeedText())
          made.push(rel)
        }
        catch (error) {
          errors.push(`${rel}:${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return { made, errors }
  }

  async function registerApps(template: WorkbenchTemplate): Promise<string> {
    const natives = template.apps.filter(app => app.kind === 'native')
    if (natives.length === 0) return '这个模板不带窗位应用。'
    if (opts.enableApps === undefined) return '没接窗位清单,应用这一件跳过了。'

    const notes: string[] = []
    // ① 带 bundle id 的:先注册(基础键会被 addResolved 认出来、直接重新启用),
    //    拿到真实的键之后再 enable 一次 —— 「他选的才开」那条规矩要的就是这一笔。
    const keys: string[] = []
    for (const app of natives) {
      if (app.bundle_id === undefined) {
        notes.push(`${app.label}:${app.bundle_note ?? '未查到 bundle id,没登记'}`)
        continue
      }
      if (opts.registerApp === undefined) { keys.push(app.key); continue }
      const registered = await opts.registerApp({ bundle_id: app.bundle_id, name: app.app_name ?? app.label })
      if (registered.ok && registered.key !== undefined) keys.push(registered.key)
      else notes.push(`${app.label}:${registered.reason ?? '登记失败'}`)
    }
    if (keys.length > 0) {
      const result = await opts.enableApps(keys)
      const ok = [...result.enabled, ...result.already]
      if (ok.length > 0) notes.unshift(`已放进窗位清单:${ok.join('、')}`)
      if (result.unknown.length > 0) notes.push(`认不出的键:${result.unknown.join('、')}`)
    }
    return notes.join(';')
  }

  return {
    async load(): Promise<void> {
      const file = await loadTemplateFile(opts.file)
      currentId = file.id
      backups = await listBackups()
    },

    currentId: () => currentId,
    // resolve 认不出(用户层那份被删 / 改坏了)→ 退回 product:认不出时最安全的落点就是现状。
    current: () => resolveTemplate(currentId) ?? PRODUCT_TEMPLATE,

    view(): TemplateStateView {
      return templateStateView(resolveTemplate(currentId) ?? PRODUCT_TEMPLATE, {
        butlerCwd: opts.butlerCwd?.(),
        hasBackup: backups.length > 0,
      })
    },

    async detail(): Promise<TemplateDetail> {
      const newest = backups[0]
      let lastAt: string | undefined
      if (newest !== undefined) {
        try {
          const parsed = JSON.parse(await readFile(join(opts.backupsDir, newest), 'utf8')) as Partial<TemplateBackup>
          if (typeof parsed.saved_at === 'string') lastAt = parsed.saved_at
        }
        catch { /* 读不出来就不说时间,不编一个(D13)。 */ }
      }
      // 盘上记的当前模板这会儿认不出来 → 说一句人话(设置里那张卡原样上屏)。
      // 「当前标记」按解析出来的实际模板打 —— 这样她删掉 ops.json 后 product 那张卡亮,
      // 而不是一个谁也点不亮的「ops」。
      const resolved = resolveTemplate(currentId)
      const unresolved = resolved === undefined
      const shownCurrent = resolved ?? PRODUCT_TEMPLATE
      return {
        current: currentId,
        has_backup: backups.length > 0,
        ...(lastAt === undefined ? {} : { last_backup_at: lastAt }),
        ...(unresolved && currentId !== PRODUCT_TEMPLATE.id
          ? { note: `原来用的「${currentId}」布局在用户层里读不出来或已不在,现在按「做产品」显示。把 用户层/布局/${currentId}.json 修复或放回去就恢复。` }
          : {}),
        templates: listTemplates().map(template => ({
          id: template.id,
          name: template.name,
          tagline: template.tagline,
          project_word: template.project_word,
          current: template.id === shownCurrent.id,
          apps: template.apps.map(app => ({
            label: app.label,
            kind: app.kind,
            ...(app.bundle_note === undefined ? {} : { note: app.bundle_note }),
          })),
          folders: template.folders.map(folder => folder.rel),
          board_lanes: template.board_lanes,
        })),
      }
    },

    apply(id: unknown): Promise<TemplateApplyResult> {
      return enqueue(async () => {
        const wanted = typeof id === 'string' ? resolveTemplate(id) : undefined
        if (wanted === undefined) {
          return {
            ok: false,
            reason: `没有这个模板:${String(id)}。现在有 ${listTemplates().map(t => t.id).join(' / ')}`,
            folders_made: [], folder_errors: [], apps_note: '',
          }
        }

        // ① 先备份 —— 在写任何东西之前。备份失败就整件作罢:一次"回不去"的切换
        //    比"没切成"糟得多(Ben 自己排了半天的布局就这么没了)。
        let backup: string | undefined
        const before = await opts.readLayout()
        if (before !== undefined) {
          try { backup = await saveBackup(before, wanted.id) }
          catch (error) {
            return {
              ok: false,
              reason: `存不下回退用的布局备份,这次没切:${error instanceof Error ? error.message : String(error)}`,
              folders_made: [], folder_errors: [], apps_note: '',
            }
          }
        }

        // ② 写布局(横竖两份)。before 缺席(项目区没接线)时用一份只有模块的骨架,
        //    别的字段交给 setLayout 那边的既有兜底。
        const base: WorkbenchLayout = before ?? { modules: [], butler: { corner: 'br', min: false } }
        await opts.writeLayout(applyTemplateToLayout(base, wanted))

        // ③ 建文件夹(只建不删)+ ④ 登记窗位应用。这两件**失败不回滚布局**:
        //    布局已经换过去了,把它再换回来只会让人看见界面闪一下又变回去,
        //    而真正的原因(没配工作目录 / 没装那个应用)在结果里如实写着。
        const folders = await makeFolders(wanted)
        const appsNote = await registerApps(wanted)

        // ⑤ 最后才记当前模板 id:前面任何一步抛了,盘上仍然是旧模板,下次打开不会
        //    出现"说是运营模板、界面却是做产品布局"这种自相矛盾的状态。
        currentId = wanted.id
        await saveTemplateFile(opts.file, { version: 1, id: wanted.id, applied_at: new Date(now()).toISOString() })
        try { opts.onApplied?.() }
        catch { /* 清缓存失败不拦切换:最坏是项目区晚一个节流周期才换过来。 */ }

        return {
          ok: true,
          ...(backup === undefined ? {} : { backup }),
          folders_made: folders.made,
          folder_errors: folders.errors,
          ...(folders.note === undefined ? {} : { folders_note: folders.note }),
          apps_note: appsNote,
        }
      })
    },

    restore(): Promise<{ ok: boolean, reason?: string, template_id?: string }> {
      return enqueue(async () => {
        const newest = backups[0]
        if (newest === undefined) return { ok: false, reason: '没有可回退的布局备份(还没切过模板、也还没改过布局)。' }
        let parsed: Partial<TemplateBackup>
        try {
          parsed = JSON.parse(await readFile(join(opts.backupsDir, newest), 'utf8')) as Partial<TemplateBackup>
        }
        catch (error) {
          return { ok: false, reason: `这份备份读不出来:${error instanceof Error ? error.message : String(error)}` }
        }
        const layout = parsed.layout
        if (typeof layout !== 'object' || layout === null || !Array.isArray((layout as WorkbenchLayout).modules)) {
          return { ok: false, reason: '这份备份里没有完整的布局,回不去。' }
        }
        await opts.writeLayout(layout as WorkbenchLayout)
        const backTo = typeof parsed.template_id === 'string' && resolveTemplate(parsed.template_id) !== undefined
          ? parsed.template_id
          : DEFAULT_TEMPLATE_ID
        currentId = backTo
        await saveTemplateFile(opts.file, { version: 1, id: backTo, applied_at: new Date(now()).toISOString() })
        try { opts.onApplied?.() }
        catch { /* 同 apply:清缓存失败不拦回退本身。 */ }
        // 用掉的那一份就地删掉:「回退上次」是一步,不是一个可以一直往回走的历史栈——
        // 留着它,连点两次会回到同一个地方,而用户以为自己又往回走了一步。
        backups = backups.slice(1)
        try { await unlink(join(opts.backupsDir, newest)) }
        catch { /* 删不掉不影响已经回退成功这件事。 */ }
        return { ok: true, template_id: backTo }
      })
    },

    /**
     * 存一份此刻布局的可回退备份(2026-09-22)。走与切模板**同一个队列、同一个栈、
     * 同一个目录** —— 详见 TemplateService.snapshotLayout 上那段注释。
     */
    snapshotLayout(reason: string): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueue(async () => {
        const before = await opts.readLayout()
        // 读不出布局 = 没有可备份的东西。**不假装存上了**:调用方要能分得开
        // 「存好了」与「这次没有快照」,否则它会承诺一个回不去的撤销。
        if (before === undefined) return { ok: false, reason: '此刻读不到布局,没有可存的快照。' }
        try {
          const name = await saveBackup(before, currentId, reason)
          return { ok: true, id: name }
        }
        catch (error) {
          return { ok: false, reason: `存不下回退用的布局快照:${error instanceof Error ? error.message : String(error)}` }
        }
      })
    },
  }
}

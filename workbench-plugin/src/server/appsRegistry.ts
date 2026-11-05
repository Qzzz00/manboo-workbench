/**
 * 窗口槽应用清单(spec S4:可增删窗口槽应用)。
 *
 * 基础七个应用(codex/claude/kimi/wechat/wecom/term/calendar)来自
 * activation.ts 的 APP_COMMANDS/APP_BUNDLES,永远存在、不可删除——这是调研实测过的
 * 命令表,删了就等于承认"我们瞎猜"。自定义应用落盘 ~/.dsh/workbench/apps.json,
 * 原子写(tmp+rename)与容错读照抄 scenes.ts 的先例。
 *
 * bundle id 解析(D13,绝不能瞎猜):只认 `osascript -e 'id of app "<name>"'` 的
 * 真实输出——查不到就直接失败,不拿"猜一个常见 bundle id"糊弄过去。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { APP_BUNDLES } from './activation.ts'
import { FAMILY_SOURCES } from './agentSources.ts'
import { APP_COMMANDS } from './apps.ts'

export interface StoredCustomApp {
  key: string
  label: string
  name: string
  bundle_id: string
}

export interface AppsFile {
  version: 1
  apps: StoredCustomApp[]
  /**
   * A5:被"删除"的基础键。基础七应用(codex/claude/...)本身是调研实测表,继续硬编码在
   * activation.ts/apps.ts 里不删——但 Ben 抱怨过"日历删不掉",管理面板下线后,删除的
   * 唯一意义就是"从清单里退出",不再是抹掉整张调研表。落这张名单而不是真的从 APP_COMMANDS
   * 删掉一行:APP_COMMANDS 依然是唯一的命令真相,disabled 只影响 list()/observeTargets()
   * 这类"清单"层面的可见性。additive 字段,旧 apps.json(没有这个键)按空数组容错。
   */
  disabled: string[]
  /**
   * 2026-09-17「每个区域单独解锁」:**用户亲手加回来的基础键**。
   *
   * 这一版起,没扫描到的那家客户端默认不出现在窗位清单里(Ben:「没装的那家不显示、不催」)。
   * 默认值随探测走 —— 但"默认"只能管默认:Ben 自己把某一家加回来过(拖窗认领 / 以后的
   * 「添加应用」),探测说什么都得听他的。`disabled` 管不了这一档,因为没装过的那家
   * 压根没进过 `disabled`,没有可摘的记录。
   *
   * 三张名单的优先级:`disabled`(他亲手删的)> `enabled`(他亲手加的)> 探测结论。
   * additive 字段,旧 apps.json 没有这个键时按空数组容错(同 `disabled` 的先例)。
   */
  enabled: string[]
}

export function defaultAppsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/apps.json`
}

export function emptyAppsFile(): AppsFile {
  return { version: 1, apps: [], disabled: [], enabled: [] }
}

export async function loadAppsFile(file: string): Promise<AppsFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return emptyAppsFile()
  }
  try {
    const parsed = JSON.parse(text) as Partial<AppsFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.apps)) return emptyAppsFile()
    // A5:disabled 是后加的字段,老 apps.json 没有这个键——容错退回空数组,不当成读坏了。
    const disabled = Array.isArray(parsed.disabled) ? parsed.disabled.filter((v): v is string => typeof v === 'string') : []
    // enabled 同样是后加的字段(2026-09-17),老 apps.json 没有这个键——空数组容错,不当读坏了。
    const enabled = Array.isArray(parsed.enabled) ? parsed.enabled.filter((v): v is string => typeof v === 'string') : []
    return { version: 1, apps: parsed.apps, disabled, enabled }
  }
  catch {
    return emptyAppsFile() // 写坏了按空清单兜底,先例见 scenes.ts loadScenesFile。
  }
}

export async function saveAppsFile(file: string, data: AppsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

/**
 * 基础应用的展示名。旧的"跟 client/Workbench.tsx 的 SLOT_APPS 常量同一份文案"已经不成立——
 * 那个常量随窗位叠 v2 收口下线了。A4(2026-08-24 UX 波)起,喂给这份文案的客户端消费者
 * (应用管理面板 AppManagePanel)也一并下线了,`list()` 的输出暂时没有 UI 挂着,但仍是
 * dockService(A2b 自愈注册、keyFor 反查)与 /apps/* 路由的服务端真相来源,不能删。
 * calendar 单列一个「日历」——它开的是系统日历 App(场景恢复要用到,APP_BUNDLES 第 8 项),
 * 跟组件条里"日历格"打开的 DDL 面板是两回事,但同属"能被贴合/纳入场景"的应用。
 */
export const BASE_APP_LABELS: Record<string, string> = {
  /**
   * AI 那几家的名字从知识表现长(2026-09-27,卡 HC)—— **界面上的名字就是它在登记表里的名字**,
   * 不在这里抄第二遍。豆包办公原来一处都不认得,正是因为它的名字只写在 `FAMILY_SOURCES` 里。
   */
  ...Object.fromEntries(
    FAMILY_SOURCES
      .filter(one => one.bundle_id !== undefined && one.bundle_id !== '')
      .map(one => [one.agent, one.name]),
  ),
  wechat: '微信',
  wecom: '企业微信',
  term: '终端',
  calendar: '日历',
}

/**
 * 基础键的顺序固定为 APP_COMMANDS 的声明顺序,不随自定义应用的增删而漂移。
 *
 * ★ 2026-09-27(卡 HC)起**导出**:AI 那几家是从知识表长出来的,用例不该再把这张表
 * 逐字抄第二遍(维护者 09-26 的原话就是「用例读显示名常量、不写死第二遍」)——
 * 抄了的话新接一家 AI 就要同时改代码与十几处断言,而那正是豆包办公漏掉的原因。
 */
export const BASE_KEYS: readonly string[] = Object.keys(APP_COMMANDS)

function isBaseKey(key: string): boolean {
  return Object.hasOwn(APP_COMMANDS, key)
}

/** key 生成:小写、非字母数字字符全砍掉,空了就退回 'app';跟已用键冲突则加数字后缀。 */
function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return slug === '' ? 'app' : slug
}

function uniqueKey(name: string, taken: ReadonlySet<string>): string {
  const base = `c-${slugify(name)}`
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * 2026-09-17「每个区域单独解锁」:探测管得着的基础键。
 *
 * `term` / `calendar` 不在里面 —— 它们是 macOS 自带的,一定装着;把它们也交给 mdfind
 * 判一次,只会在 Spotlight 抽风时把「终端」从窗位清单里弄丢。
 *
 * ★ 2026-09-27(卡 HC):AI 那几家**整批**交给探测(名单从知识表现长)。原来只有三家在这儿,
 * 加一家就要记得来改这一行 —— 于是豆包办公既没被探测管着、也没进清单。现在「装了的才出现」
 * 对每一家 AI 都成立:没装的一家不在窗位清单、不在常用应用、不在派活对象里。
 */
const SCANNED_BASE_KEYS: readonly string[] = [
  ...FAMILY_SOURCES.filter(one => one.bundle_id !== undefined && one.bundle_id !== '').map(one => one.agent),
  'wechat',
  'wecom',
]

/*
 * ★ `OPT_IN_BASE_KEYS`(卡 OB 当天加的「他点名要了才出现」那一档)**这一版撤掉了**。
 *
 * 它当时存在的**唯一理由**是:豆包办公不在客户端探测那一路(`clientScan.ts` 的五家)里,
 * 拿"探不到"当"没装"会把它抹掉,而按默认又会让没装的人也看见一格 —— 于是只好要他亲手加。
 * 卡 HC 把那个理由消掉了:`installedAgents.ts` 按包标识探**每一家 AI**(候选从知识表长),
 * 豆包办公现在真探得到。所以它回到与 Claude / Codex / Kimi 完全一样的那一档 ——
 * **装了就出现,没装就不出现**,不用他先说一句。这正是维护者要的那条:
 * 「先帮我把豆包办公和 codex 放进来吧」不该再得到「豆包办公我没认出来」。
 */

/**
 * 一个基础键这会儿该不该出现在清单里。三张名单按优先级排(见 AppsFile.enabled):
 *
 * 1. 他亲手删过(`disabled`)→ 不出现,探测说装了也不出现;
 * 2. 他亲手加过(`enabled`)→ 出现,探测说没装也出现;
 * 3. 剩下的听探测:**没扫过(installed === undefined)时一律出现** —— 退回这一版之前的行为,
 *    而不是趁"还不知道"把清单清空(同 D13:"没查过"不等于"没有")。
 */
function baseKeyVisible(
  key: string,
  data: Pick<AppsFile, 'disabled' | 'enabled'>,
  installed: ReadonlySet<string> | undefined,
  firstRun = false,
): boolean {
  if (data.disabled.includes(key)) return false
  if (data.enabled.includes(key)) return true
  // 2026-09-18「第一次用一切从空开始」:引导还没做完时,**默认一个都不出现**。
  // 这条压在探测之上(但仍然压不过上面那句 `enabled`)—— 「他亲手加过」永远最大,
  // 而"扫到装了"这条默认在第一次用的时候正是 Ben 说的「窗口槽里也什么都有了」的来源。
  // 拖一扇窗进窗位仍然认领得到:那条路走 addResolved,会当场记一笔 enabled(见下面),
  // 下一拍它就自己回到清单里 —— **是他选的才开**,不是默认就开。
  if (firstRun) return false
  if (installed === undefined) return true
  if (!SCANNED_BASE_KEYS.includes(key)) return true
  return installed.has(key)
}

export interface AppsRegistryOptions {
  file: string
  runOsascript: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  /**
   * 这会儿扫到装了的那几家(server/clientScan.ts 的 `installedKeys()`)。
   *
   * **不传 = 不启用这一档**,清单跟这一版之前一模一样 —— 既有那一大批直接造 registry 的
   * 用例不受影响,而且"扫描服务没接线"与"扫出来五家都没装"在结构上就分得开。
   * 同步取值(读的是已经缓存好的那一份),不在这条热路径上发子进程。
   */
  installedKeys?: () => ReadonlySet<string> | undefined
  /**
   * 引导还没做完(2026-09-18「第一次用」)。同步取值,读的是内存里的引导阶段
   * (`/state.onboarding.done` 的同一份真相)。
   *
   * **不传 = 不启用这一档**,清单跟这一版之前一模一样 —— 既有那一大批直接造 registry 的
   * 用例不受影响,而且"没接引导服务"与"引导做完了"在结构上就分得开(同 installedKeys 的先例)。
   */
  firstRun?: () => boolean
}

export interface AppsRegistry {
  list(): Promise<{ key: string, label: string }[]>
  /**
   * **登记过的全部应用**:基础七个 + apps.json 里的自定义应用,不看 `disabled` / `enabled` /
   * 首次那三档可见性。给「名字认成窗位键」用(引导 ④ 习惯那一问):首次期间 `list()` 本来就是空的,
   * 拿它去认名字只会一个都认不出来。
   */
  listAll(): Promise<{ key: string, label: string }[]>
  /**
   * 把这几个键记成**他亲手加的**(`enabled`),顺手从 `disabled` 里摘掉 —— 他刚说了这是常用应用,
   * 那条"他亲手删过"的旧记录已经过期(同 addResolved 里重新启用那一段)。
   *
   * 自定义应用本来就不受 `enabled` 管(它们永远在清单里),所以回 `already`,文件不写。
   * 不认识的键回 `unknown`,一个字都不落盘:窗位清单里不该冒出一个开不起来的键(D13)。
   */
  enable(keys: readonly string[]): Promise<{ enabled: string[], already: string[], unknown: string[] }>
  /**
   * **他要放进窗口槽的那几家**(2026-09-25,卡 fix/quota-and-slot-apps):apps.json 的 `enabled`
   * (引导 ④ 里他说的「那几个都放进去」、拖进来过的),摘掉 `disabled` 里的,**按 enabled 的顺序**。
   *
   * 窗口槽据此出标签:认领了的是正常标签,没认领的写「点一下拉进来」(dock.ts view 的 `pending`)。
   * 维护者 09-24:「他说把一些应用拉进去,它也没拉啊」—— 原来 enabled 只进了清单,界面上一个标签都没有。
   *
   * 可选:测试替身不实现它 = 没有这一档(窗口槽照旧只显示认领了的)。
   */
  wanted?(): Promise<{ key: string, label: string }[]>
  commandFor(key: string): Promise<readonly string[] | undefined>
  bundleFor(key: string): Promise<string | undefined>
  add(name: string, label?: string): Promise<{ ok: boolean, key?: string, reason?: string }>
  /**
   * 失败原因如实上屏(D13):未知键给一句人话,不是裸 boolean 让上层猜。
   * A5:基础键不再拒绝——改记进 disabled 名单(list()/observeTargets() 等清单类接口据此
   * 排除它),APP_COMMANDS/APP_BUNDLES 那份调研实测表本身不删一行。已经在 disabled 里的
   * 基础键、或压根没有这个键(既不是基础键也不是自定义应用)都算"没有这个应用"。
   */
  remove(key: string): Promise<{ ok: boolean, reason?: string }>
  /**
   * 反查:bundle_id → 应用键+展示名(窗位叠 v2 spec V1:壳报来的 moved 事件只带 bundle_id,
   * dockService 认领前要靠这个换回 registry 认识的键)。基础应用查 APP_BUNDLES,自定义应用查
   * 落盘数据;两边都查不到就 undefined,不瞎猜一个键出来(D13)。A5:disabled 的基础键
   * 这里也查不到(跟 list() 同一条排除规则)——被"删除"的应用不该继续被认领;重新启用
   * 走 addResolved 的自愈路径(拖进来时用同一个 bundle_id 反查 APP_BUNDLES 原始表,不经
   * 这个已过滤的 keyFor)。
   */
  keyFor(bundleId: string): Promise<{ key: string, label: string } | undefined>
  /**
   * A2(b) 自愈注册:壳报来一个 registry(keyFor)认不出的 bundle_id 时,dockService 拿壳查到的
   * 展示名直接注册一个新的自定义应用条目——不经 osascript 反查(那条路认应用名,拖进来的
   * 只有 bundle id,反而更慢、更容易撞系统弹窗),bundle-id-based 的 `open -b <bundle_id>`
   * 天生对改名免疫,不需要靠应用名字。key 生成复用 add() 同一套 uniqueKey 规则(`c-` 前缀 +
   * slug + 去重后缀)。
   * A5 联动:如果这个 bundle_id 其实是某个被 disable 过的基础键(APP_BUNDLES 原始表里查得到,
   * 只是 keyFor 因为 disabled 过滤查不到),不重复注册成一条影子自定义应用——直接从 disabled
   * 名单里摘掉,视为"重新启用",回那个基础键本身。
   */
  addResolved(info: { bundle_id: string, name: string }): Promise<{ ok: boolean, key?: string, reason?: string }>
}

export function createAppsRegistry(opts: AppsRegistryOptions): AppsRegistry {
  // 写队列,先例见 scenes.ts:load→改→save 不排队会丢更新。
  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    async list(): Promise<{ key: string, label: string }[]> {
      const data = await loadAppsFile(opts.file)
      const installed = opts.installedKeys?.()
      const firstRun = opts.firstRun?.() === true
      const base = BASE_KEYS.filter(key => baseKeyVisible(key, data, installed, firstRun)).map(key => ({ key, label: BASE_APP_LABELS[key] ?? key }))
      const custom = data.apps.map(app => ({ key: app.key, label: app.label }))
      return [...base, ...custom]
    },

    async listAll(): Promise<{ key: string, label: string }[]> {
      const data = await loadAppsFile(opts.file)
      return [
        ...BASE_KEYS.map(key => ({ key, label: BASE_APP_LABELS[key] ?? key })),
        ...data.apps.map(app => ({ key: app.key, label: app.label })),
      ]
    },

    enable(keys: readonly string[]): Promise<{ enabled: string[], already: string[], unknown: string[] }> {
      return enqueueWrite(async () => {
        const data = await loadAppsFile(opts.file)
        const enabled: string[] = []
        const already: string[] = []
        const unknown: string[] = []
        for (const key of keys) {
          if (isBaseKey(key)) {
            if (data.enabled.includes(key) && !data.disabled.includes(key)) { already.push(key); continue }
            if (!data.enabled.includes(key)) data.enabled = [...data.enabled, key]
            data.disabled = data.disabled.filter(item => item !== key)
            enabled.push(key)
            continue
          }
          if (data.apps.some(app => app.key === key)) { already.push(key); continue }
          unknown.push(key)
        }
        if (enabled.length > 0) await saveAppsFile(opts.file, data)
        return { enabled, already, unknown }
      })
    },

    async wanted(): Promise<{ key: string, label: string }[]> {
      const data = await loadAppsFile(opts.file)
      // 只认基础键(enable / addResolved 也只往 enabled 里写基础键);重复的只留第一个。
      return data.enabled
        .filter((key, index, all) => isBaseKey(key) && !data.disabled.includes(key) && all.indexOf(key) === index)
        .map(key => ({ key, label: BASE_APP_LABELS[key] ?? key }))
    },

    async commandFor(key: string): Promise<readonly string[] | undefined> {
      if (isBaseKey(key)) {
        const data = await loadAppsFile(opts.file)
        // 没装的那家也拿不到命令:`open -a Kimi` 在没装 Kimi 的机器上只会弹一个系统报错框,
        // 那比什么都不做更糟(用户以为是工作台坏了)。
        if (!baseKeyVisible(key, data, opts.installedKeys?.(), opts.firstRun?.() === true)) return undefined
        return APP_COMMANDS[key]
      }
      const data = await loadAppsFile(opts.file)
      const found = data.apps.find(app => app.key === key)
      if (found === undefined) return undefined
      // 同基础键:按包标识拉。显示名常与 .app 文件名不同(千问办公 = QwenWorkCN.app),按名字拉会「找不到应用」。
      return found.bundle_id === undefined || found.bundle_id === ''
        ? ['open', '-a', found.name]
        : ['open', '-b', found.bundle_id]
    },

    async bundleFor(key: string): Promise<string | undefined> {
      if (isBaseKey(key)) {
        const data = await loadAppsFile(opts.file)
        if (!baseKeyVisible(key, data, opts.installedKeys?.(), opts.firstRun?.() === true)) return undefined
        return Object.hasOwn(APP_BUNDLES, key) ? APP_BUNDLES[key] : undefined
      }
      const data = await loadAppsFile(opts.file)
      return data.apps.find(app => app.key === key)?.bundle_id
    },

    add(name: string, label?: string): Promise<{ ok: boolean, key?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const trimmed = name.trim()
        if (trimmed === '') return { ok: false, reason: '应用名不能为空' }

        // bundle id 只认 osascript 的真实输出,查不到就直接失败(D13:没有的能力不能装成有,不许猜)。
        const { ok, stdout } = await opts.runOsascript(['osascript', '-e', `id of app "${trimmed}"`])
        const bundleId = stdout.trim()
        if (!ok || bundleId === '') return { ok: false, reason: `找不到应用:${trimmed}` }

        const data = await loadAppsFile(opts.file)
        if (Object.values(APP_BUNDLES).includes(bundleId) || data.apps.some(app => app.bundle_id === bundleId)) {
          return { ok: false, reason: `已经添加过这个应用:${trimmed}` }
        }
        if (data.apps.some(app => app.name === trimmed)) {
          return { ok: false, reason: `已有同名应用:${trimmed}` }
        }

        const taken = new Set([...BASE_KEYS, ...data.apps.map(app => app.key)])
        const key = uniqueKey(trimmed, taken)
        data.apps.push({ key, label: label?.trim() === '' || label === undefined ? trimmed : label.trim(), name: trimmed, bundle_id: bundleId })
        await saveAppsFile(opts.file, data)
        return { ok: true, key }
      })
    },

    async keyFor(bundleId: string): Promise<{ key: string, label: string } | undefined> {
      const baseKey = BASE_KEYS.find(key => APP_BUNDLES[key] === bundleId)
      if (baseKey !== undefined) {
        // A5:disabled 的基础键不算"认得出"——跟 list() 同一条排除规则,被删除的应用
        // 不该继续被拖拽认领。重新启用走 addResolved 的自愈路径,不走这里。
        // 2026-09-17:没扫到装了的那几家走同一条路 —— 一扇窗都拖进来了说明它其实装着,
        // 交给 addResolved 记一笔 enabled,下一拍它就自己回到清单里(「装了自动出现」)。
        const data = await loadAppsFile(opts.file)
        // 2026-09-18:首次那一档也从这里漏下去 —— 交给 addResolved 记一笔 enabled,
        // 「他亲手拖进来的」从此压过一切默认。
        if (!baseKeyVisible(baseKey, data, opts.installedKeys?.(), opts.firstRun?.() === true)) return undefined
        return { key: baseKey, label: BASE_APP_LABELS[baseKey] ?? baseKey }
      }
      const data = await loadAppsFile(opts.file)
      const found = data.apps.find(app => app.bundle_id === bundleId)
      return found === undefined ? undefined : { key: found.key, label: found.label }
    },

    remove(key: string): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        // A5:基础应用不再拒绝删除——记进 disabled 名单,APP_COMMANDS/APP_BUNDLES 那份
        // 调研实测表本身不动一行(管理面板已经下线,删除的意义只是"退出清单",不是抹掉
        // 调研结论)。已经在名单里(重复删除)或压根不是基础键也不是自定义应用键,
        // 都算"没有这个应用",原因如实上屏(D13),不是裸 false 让上层猜。
        if (isBaseKey(key)) {
          const data = await loadAppsFile(opts.file)
          if (data.disabled.includes(key)) return { ok: false, reason: '没有这个应用' }
          data.disabled = [...data.disabled, key]
          // 手动加过的那一笔跟着抹掉:他刚刚亲手把它删了,"他亲手加过"这条记录已经过期。
          // (真要论优先级 disabled 本来就压过 enabled,这里只是不留一条自相矛盾的记录。)
          data.enabled = data.enabled.filter(k => k !== key)
          await saveAppsFile(opts.file, data)
          return { ok: true }
        }
        const data = await loadAppsFile(opts.file)
        const before = data.apps.length
        data.apps = data.apps.filter(app => app.key !== key)
        if (data.apps.length === before) return { ok: false, reason: '没有这个应用' }
        await saveAppsFile(opts.file, data)
        return { ok: true }
      })
    },

    addResolved(info: { bundle_id: string, name: string }): Promise<{ ok: boolean, key?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const trimmed = info.name.trim()
        const bundleId = info.bundle_id.trim()
        if (bundleId === '') return { ok: false, reason: 'bundle_id 不能为空' }

        // A5 联动:这个 bundle_id 其实是某个被 disable 过的基础键 → 重新启用,不重复注册
        // 成一条影子自定义应用(否则会跟基础键的 bundle 冲突判定打架)。
        const baseKey = BASE_KEYS.find(key => APP_BUNDLES[key] === bundleId)
        if (baseKey !== undefined) {
          const data = await loadAppsFile(opts.file)
          const wasDisabled = data.disabled.includes(baseKey)
          // 2026-09-17:同时记一笔 enabled —— 这是**用户亲手加回来的**,此后探测说没扫到
          // 也不再把它从清单里抹掉(「用户手动加过的照旧」)。mdfind 偶尔查不到一家
          // (索引没建好 / 装在外置盘)时,这一笔就是他不用再加第二次的保证。
          const needsEnable = !data.enabled.includes(baseKey)
          if (wasDisabled || needsEnable) {
            data.disabled = data.disabled.filter(key => key !== baseKey)
            if (needsEnable) data.enabled = [...data.enabled, baseKey]
            await saveAppsFile(opts.file, data)
          }
          return { ok: true, key: baseKey }
        }

        const data = await loadAppsFile(opts.file)
        // 已经注册过(自愈重试/并发拖动撞了同一个 bundle_id)→ 直接回已有的键,不重复注册,
        // 也不当失败——调用方(dock.ts)只关心"注册好了没有",不是"这是不是第一次注册"。
        const existing = data.apps.find(app => app.bundle_id === bundleId)
        if (existing !== undefined) return { ok: true, key: existing.key }

        const label = trimmed === '' ? bundleId : trimmed
        const taken = new Set([...BASE_KEYS, ...data.apps.map(app => app.key)])
        const key = uniqueKey(label, taken)
        data.apps.push({ key, label, name: label, bundle_id: bundleId })
        await saveAppsFile(opts.file, data)
        return { ok: true, key }
      })
    },
  }
}

/**
 * 钩子由工作台代写(2026-09-17,Ben:「按你建议的做」——放开「程序不写 ~/.claude/settings.json、
 * ~/.codex/hooks.json」的护栏,改成**工作台帮你接上**)。
 *
 * ## 为什么要放开这条护栏
 *
 * 目标用户是不懂代码的半专业个体(电商运营那一类)。原来那一步是「把这段 JSON **合并**进
 * `~/.claude/settings.json`」—— 对他们来说这句话里有三个陌生词(合并、JSON、那条路径),
 * 而且合并写错了**不会报错**,现象是"会话区一直没人上报",查起来极费劲。
 * 这一步不可接受,所以改成一颗按钮。
 *
 * ## 放开的同时钉死四条(拍板原文)
 *
 * 1. **只写工作台自己的那几条**。判据是命令路径指着工作台的 hook 脚本:新位置
 *    `~/.dsh/workbench/hooks/agent-hook.sh`,或者旧位置(开发仓库里的 `workbench-plugin/bin/agent-hook.sh`)
 *    —— 两种都认(卡 R,2026-09-25;见 hooksConfig.ts 的 `WB_HOOKS_COMMAND_MARKERS`)。
 *    statusLine 同理是 `claude-statusline.sh`。别人的条目 —— 他自己配的、headroom 挂的 ——
 *    **一个字不动**,连顺序都不动。
 * 2. **写前备份**。同目录 `<原名>.bak-工作台-<时间戳>`。**备份没做成就一个字都不写**:
 *    这是在写他家目录里的文件,没有退路的写入不许发生(2026-09-04 家目录被删事故之后的纪律)。
 * 3. **界面上先看后写**。这个模块只提供 `wbHooksMergeInto` 这个纯函数,渲染与预览走
 *    `GET /config/hooks`,写走 `POST /config/hooks/apply` —— 两条路吐出来的是同一份内容。
 * 4. **能一键撤回**。`wbHooksRemoveFrom` 只摘掉工作台自己的那几条,**不是**按备份整份还原:
 *    还原会把他在这中间改的别的设置一起抹掉 —— 撤回一颗按钮不该有这种副作用。
 *    (备份仍然留着,真出事时可以手工整份还原,路径在接口的返回里。)
 *
 * ## 幂等
 *
 * 每个事件下,工作台的旧条目**原地**换成新的(第一处换掉、其余几处摘掉),一处都没有才追加在末尾。于是:
 * - 重复点「接上」不会出现四条变八条;
 * - 旧位置的条目(指着开发仓库,或者搬过家的另一个 checkout)会被**换成**新位置的,而不是并存 ——
 *   两条一起挂着的话,旧那条每次会话都白跑一遍(仓库不在了就是静默失败一次)。
 *   维护者那台机器下次点「接上」就是走这一条换过去的:写前另存一份,别的内容一个字不动,能单独撤回。
 * - 位置不挪(2026-10-21):Codex 的「信任」按「第几组、第几条」记,挪一下她点过的就作废(见 `placeOurs`)。
 *   撤回躲不开这一点 —— 摘掉我们那一组,排在后面的别人的条目会往前挪,Codex 会请她把那几条再放行一次。
 *
 * ## 格式尽量不走样
 *
 * `JSON.parse` → 改 → `JSON.stringify`:字符串键的顺序在 JS 里就是插入顺序,所以既有的键
 * 顺序天然保住;缩进从原文里**认出来**(两格/四格/Tab)再照着写回去,末尾换行也照原样。
 * 注释保不住 —— 但这两个文件都是严格 JSON,本来就不该有注释(有的话 Claude Code 自己也读不了)。
 */
import { CODEX_TRUST_HOW, wbHooksMentionsOurScript, wbHooksMentionsOurStatusLine, wbHooksRender } from './hooksConfig.ts'
import type { WbHooksAgent, WbHooksGroup } from './hooksConfig.ts'
import type { SetupIo } from './setup/io.ts'
import { markers, upsertMarkedBlock } from './memoryMd.ts'
import { resolvePromptBody, withPromptPrefs } from './promptOverrides.ts'
import { ALL_SKILL_NAMES as ALL_SKILL_NAMES_DEF, opsSkillBody, opsSkillByName, opsSkillIndexEntry, opsSkillsForTemplate } from './opsSkills.ts'
import type { OpsSkillDef } from './opsSkills.ts'

/** 备份文件名的中缀。**中文是故意的**:Ben 在 Finder 里一眼认得出这是工作台留下的。 */
export const WB_HOOKS_BACKUP_TAG = 'bak-工作台'

/** 一条命令是不是工作台自己的(新位置或旧位置)。整个模块只认这一个判据(见文件头第 1 条)。 */
export function wbHooksIsOurCommand(command: unknown): boolean {
  return typeof command === 'string' && wbHooksMentionsOurScript(command)
}

/** statusLine 是不是工作台自己的那一条(新位置或旧位置)。 */
export function wbHooksIsOurStatusLine(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const command = (value as { command?: unknown }).command
  return typeof command === 'string' && wbHooksMentionsOurStatusLine(command)
}

/**
 * 从原文里认出缩进(两格 / 四格 / Tab)。认不出来按两格 —— 两个文件的既有内容都是两格。
 * 认这一下是为了**别把他的文件重排一遍**:diff 里满屏都是缩进变化时,真正改了什么就看不见了。
 */
export function wbHooksDetectIndent(text: string): string {
  const found = /\n([ \t]+)"/.exec(text)
  return found?.[1] ?? '  '
}

interface JsonObject { [key: string]: unknown }

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析一份可能不存在、可能是空文件的 JSON。空 = 空对象(第一次接上的那台机器就是这样)。 */
function parseRoot(text: string | undefined): { ok: true, root: JsonObject } | { ok: false, error: string } {
  if (text === undefined || text.trim() === '') return { ok: true, root: {} }
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch {
    return {
      ok: false,
      // 写坏了的 JSON 不许我们接着写:在坏文件上做合并,结果是一份"看着对、其实早就失效"的配置。
      error: '这个文件现在不是合法的 JSON(可能是手工改的时候少了个逗号)。工作台不敢在上面接着写 —— 先把它改回合法的 JSON,或者把它挪开让工作台重新生成一份。',
    }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: '这个文件的最外层不是一个 JSON 对象,跟工作台认识的格式对不上,这次一个字都没写。' }
  }
  return { ok: true, root: parsed }
}

/** 一个 hook 组(`{ matcher?, hooks: [...] }`)里摘掉工作台自己的命令,回剩下的和摘了几条。 */
function stripGroup(group: unknown): { group: unknown, removed: number, empty: boolean } {
  if (!isPlainObject(group)) return { group, removed: 0, empty: false }
  const inner = group.hooks
  if (!Array.isArray(inner)) return { group, removed: 0, empty: false }
  const kept = inner.filter(entry => !(isPlainObject(entry) && wbHooksIsOurCommand(entry.command)))
  const removed = inner.length - kept.length
  if (removed === 0) return { group, removed: 0, empty: false }
  // 整组都是我们的 → 整组撤掉(留一个 `{ hooks: [] }` 的空壳,别人读到会当成一条配错的规则)。
  if (kept.length === 0) return { group, removed, empty: true }
  return { group: { ...group, hooks: kept }, removed, empty: false }
}

/**
 * 一个事件下的那几组里,把工作台的那一条**原地**换成新的:原来在第几组、组里第几条,换完还在那儿;
 * 其余几处工作台的旧条目摘掉;一处都没有才追加在末尾。
 *
 * 为什么要原地:Codex 的「信任」按位置记(`hooks.json:stop:0:0` —— 第几组、第几条)。先摘再追加的话,
 * 别人的条目排在我们后面时(维护者那台 10-21:ai-memory 探针挂在第 1 组),重接一次我们就挪了位置,
 * 她点过的信任作废,别人那条还会挪到我们原来的位置、撞上我们的指纹变成「已修改」。
 */
function placeOurs(groups: readonly unknown[], fresh: WbHooksGroup): { groups: unknown[], removed: number } {
  let removed = 0
  let placed = false
  const out: unknown[] = []
  for (const group of groups) {
    const result = stripGroup(group)
    removed += result.removed
    if (result.removed === 0) { out.push(group); continue }
    if (placed) {
      if (!result.empty) out.push(result.group)
      continue
    }
    placed = true
    if (result.empty) { out.push(fresh); continue }
    // 同一组里混着别人的:只换我们那一条,位置不动,组里别的条目与 matcher 原样。
    let swapped = false
    const inner = (group as JsonObject).hooks as unknown[]
    const hooks = inner.flatMap((entry) => {
      if (!(isPlainObject(entry) && wbHooksIsOurCommand(entry.command))) return [entry]
      if (swapped) return []
      swapped = true
      return fresh.hooks
    })
    out.push({ ...(group as JsonObject), hooks })
  }
  if (!placed) out.push(fresh)
  return { groups: out, removed }
}

/** 一棵 `hooks` 里,把所有事件下工作台自己的条目摘干净。**别人的条目连顺序都不动。** */
function stripOurs(hooks: JsonObject): { hooks: JsonObject, removed: number } {
  const out: JsonObject = {}
  let removed = 0
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) { out[event] = value; continue }
    const kept: unknown[] = []
    for (const group of value) {
      const result = stripGroup(group)
      removed += result.removed
      if (!result.empty) kept.push(result.group)
    }
    // 这一项被我们摘空了 → 整项去掉(空数组留着不报错,但它是一行没有意义的噪音)。
    if (kept.length === 0 && value.length > 0) continue
    out[event] = kept
  }
  return { hooks: out, removed }
}

export interface WbHooksMergeResult {
  /** 写回去的全文(含末尾换行,与原文一致)。 */
  text: string
  /** 这次加进去了几条(hook 条目数,不含 statusLine)。 */
  added: number
  /** 摘掉了几条旧的工作台条目(幂等的那一半)。0 = 头一次接。 */
  replaced: number
  /** statusLine 这一项的下场。`kept_user` = 他自己配过一条,**没动它**。 */
  statusLine: 'added' | 'replaced' | 'kept_user' | 'none'
}

/**
 * 把工作台自己的那几条合并进一份现成的配置。**纯函数,不碰磁盘。**
 *
 * @param text 现有全文;`undefined` 或空串 = 文件还不存在。
 * @param agent claude / codex。
 * @param hooksDir 钩子脚本的固定位置(`~/.dsh/workbench/hooks` 的绝对路径;渲染出来的命令里是绝对路径)。
 */
export function wbHooksMergeInto(
  text: string | undefined,
  agent: WbHooksAgent,
  hooksDir: string,
): { ok: true, result: WbHooksMergeResult } | { ok: false, error: string } {
  const parsed = parseRoot(text)
  if (!parsed.ok) return parsed
  const root = parsed.root

  const existingHooks = root.hooks
  if (existingHooks !== undefined && !isPlainObject(existingHooks)) {
    // 见过的形状只有 `{ 事件名: [...] }`。别的形状先不猜 —— 猜错就是把他的配置弄坏。
    return { ok: false, error: '这个文件里的 hooks 不是工作台认识的那种结构,为了不弄坏它,这次一个字都没写。' }
  }

  const rendered = wbHooksRender(agent, hooksDir)
  const hooks: JsonObject = {}
  let replaced = 0
  for (const [event, value] of Object.entries(isPlainObject(existingHooks) ? existingHooks : {})) {
    const fresh = rendered.hooks[event]?.[0]
    if (fresh !== undefined && Array.isArray(value)) {
      const placed = placeOurs(value, fresh)
      hooks[event] = placed.groups
      replaced += placed.removed
      continue
    }
    // 这一回不写的事件(Claude 那份里的 Notification 之于 Codex 之类):只摘我们的,别的不动。
    const stripped = stripOurs({ [event]: value })
    replaced += stripped.removed
    if (Object.hasOwn(stripped.hooks, event)) hooks[event] = stripped.hooks[event]
  }

  let added = 0
  for (const [event, groups] of Object.entries(rendered.hooks)) {
    if (!Array.isArray(hooks[event])) hooks[event] = groups
    added += groups.reduce((sum, group) => sum + group.hooks.length, 0)
  }

  const next: JsonObject = { ...root, hooks }

  let statusLine: WbHooksMergeResult['statusLine'] = 'none'
  if (rendered.statusLine !== undefined) {
    const current = root.statusLine
    if (current === undefined) { next.statusLine = rendered.statusLine; statusLine = 'added' }
    else if (wbHooksIsOurStatusLine(current)) { next.statusLine = rendered.statusLine; statusLine = 'replaced' }
    // 他自己配过一条状态栏 → **不动**。状态栏只是显示,少了它照样收得到事件;
    // 而替掉他自己配的东西,是这整件事里最容易惹祸的一步。
    else statusLine = 'kept_user'
  }

  return {
    ok: true,
    result: {
      text: serialize(next, text),
      added,
      replaced,
      statusLine,
    },
  }
}

export interface WbHooksRemoveResult {
  text: string
  /** 摘掉了几条。0 = 本来就没有工作台的条目(撤回一件没做过的事,如实说)。 */
  removed: number
  /** statusLine 那一条是不是也摘掉了。 */
  statusLineRemoved: boolean
}

/**
 * 只摘掉工作台自己的那几条,**别的一个字不动**(撤回按钮走这条,不走"按备份整份还原")。
 */
export function wbHooksRemoveFrom(
  text: string | undefined,
): { ok: true, result: WbHooksRemoveResult } | { ok: false, error: string } {
  const parsed = parseRoot(text)
  if (!parsed.ok) return parsed
  const root = parsed.root
  const existingHooks = root.hooks
  if (existingHooks !== undefined && !isPlainObject(existingHooks)) {
    return { ok: false, error: '这个文件里的 hooks 不是工作台认识的那种结构,为了不弄坏它,这次一个字都没动。' }
  }

  const stripped = stripOurs(isPlainObject(existingHooks) ? existingHooks : {})
  const next: JsonObject = { ...root }
  // hooks 本来就没有就别凭空造一个空的出来。
  if (existingHooks !== undefined) next.hooks = stripped.hooks

  let statusLineRemoved = false
  if (wbHooksIsOurStatusLine(root.statusLine)) {
    delete next.statusLine
    statusLineRemoved = true
  }

  return { ok: true, result: { text: serialize(next, text), removed: stripped.removed, statusLineRemoved } }
}

/** 按原文的缩进与末尾换行写回去。原文不存在时用两格 + 末尾换行(与 bin/ 里那两份模板一致)。 */
function serialize(value: JsonObject, original: string | undefined): string {
  const indent = original === undefined || original.trim() === '' ? '  ' : wbHooksDetectIndent(original)
  const body = JSON.stringify(value, null, indent)
  const trailing = original === undefined || original.trim() === '' || original.endsWith('\n') ? '\n' : ''
  return `${body}${trailing}`
}

/** `20260917-214233`。本地时区 —— 这个名字是给人在 Finder 里认的,不是给程序排序的。 */
export function wbHooksBackupStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

export function wbHooksBackupPath(file: string, at: Date): string {
  return `${file}.${WB_HOOKS_BACKUP_TAG}-${wbHooksBackupStamp(at)}`
}

export interface WbHooksApplyIo {
  /**
   * `mkdirp` 是**可选**的(2026-10-02):技能正文落盘要它,老宿主给不了。
   * 缺席 = 老实现(正文整段写进 AGENTS.md),不静默丢掉正文。
   */
  io: Pick<SetupIo, 'readFile' | 'writeFile' | 'copyFile' | 'stat'> & Partial<Pick<SetupIo, 'mkdirp'>>
  now: () => Date
}

export interface WbHooksApplyOk {
  ok: true
  /** 备份在哪。**文件本来就不存在时没有备份**(没有东西可丢),这里就缺席。 */
  backup_path?: string
  added: number
  replaced: number
  statusLine: WbHooksMergeResult['statusLine']
}

export interface WbHooksRevertOk {
  ok: true
  backup_path?: string
  removed: number
  statusLineRemoved: boolean
}

export type WbHooksFail = { ok: false, error: string }

/**
 * 备份原文件。**做不成就让整件事停下**(返回 error),这是文件头第 2 条。
 *
 * 做成没做成不看 copyFile 有没有抛 —— 还要 `stat` 一下确认备份**真的落在盘上、而且字节数对得上**。
 * 磁盘满、目录只读这些场合,copy 可能"成功"返回而文件是半份的。
 *
 * 文件名撞了(时间戳只到秒,同一秒内第二次备份 —— 例如点「全部接上」后马上点一家「撤回」)
 * 就往后加序号,**不覆盖**已有备份:被盖掉的那一份才是"出事时手工还原"要用的原文。
 */
async function backup(deps: WbHooksApplyIo, file: string, original: string): Promise<{ ok: true, path: string } | WbHooksFail> {
  const base = wbHooksBackupPath(file, deps.now())
  let path = base
  for (let n = 2; await deps.io.stat(path) !== undefined; n += 1) path = `${base}-${n}`
  try { await deps.io.copyFile(file, path) }
  catch {
    return { ok: false, error: `备份没做成(写不了 ${path}),所以这次一个字都没写。原来的配置没有任何改动。` }
  }
  const info = await deps.io.stat(path)
  const expected = Buffer.byteLength(original, 'utf8')
  if (info === undefined || info.size !== expected) {
    return { ok: false, error: `备份写出来了但对不上(${path}),所以这次一个字都没写。原来的配置没有任何改动。` }
  }
  return { ok: true, path }
}

/**
 * 代写:备份 → 合并 → 写回。任何一步不对就**整件事停下**,原文件保持原样。
 *
 * `hooksDir` 由调用方给,而且调用方要先确认脚本已经在那儿(hookScripts.ts 的 `ensure`)——
 * 写进去一条指着空位置的命令,就是几条静默失败的钩子。
 */
export async function wbHooksApply(
  deps: WbHooksApplyIo,
  input: { agent: WbHooksAgent, file: string, hooksDir: string },
): Promise<WbHooksApplyOk | WbHooksFail> {
  const original = await deps.io.readFile(input.file)
  const merged = wbHooksMergeInto(original, input.agent, input.hooksDir)
  if (!merged.ok) return merged

  let backupPath: string | undefined
  if (original !== undefined) {
    const saved = await backup(deps, input.file, original)
    if (!saved.ok) return saved
    backupPath = saved.path
  }

  try { await deps.io.writeFile(input.file, merged.result.text) }
  catch {
    return {
      ok: false,
      error: `写不进 ${input.file}(可能是权限)。${backupPath === undefined ? '原来的配置没有任何改动。' : `原来那份备份在 ${backupPath}。`}`,
    }
  }
  return {
    ok: true,
    ...(backupPath === undefined ? {} : { backup_path: backupPath }),
    added: merged.result.added,
    replaced: merged.result.replaced,
    statusLine: merged.result.statusLine,
  }
}

/** 撤回:同样先备份,再只摘掉工作台自己的那几条。 */
export async function wbHooksRevert(
  deps: WbHooksApplyIo,
  input: { file: string },
): Promise<WbHooksRevertOk | WbHooksFail> {
  const original = await deps.io.readFile(input.file)
  // 文件压根不在 = 本来就没接过。这不是错误,如实回"没什么可撤的"。
  if (original === undefined) return { ok: true, removed: 0, statusLineRemoved: false }

  const stripped = wbHooksRemoveFrom(original)
  if (!stripped.ok) return stripped
  if (stripped.result.removed === 0 && !stripped.result.statusLineRemoved) {
    // 没有我们的条目 → 不写、不备份。撤回一件没做过的事,不该在他家目录里多留一个文件。
    return { ok: true, removed: 0, statusLineRemoved: false }
  }

  const saved = await backup(deps, input.file, original)
  if (!saved.ok) return saved
  try { await deps.io.writeFile(input.file, stripped.result.text) }
  catch {
    return { ok: false, error: `写不进 ${input.file}(可能是权限)。原来那份备份在 ${saved.path}。` }
  }
  return {
    ok: true,
    backup_path: saved.path,
    removed: stripped.result.removed,
    statusLineRemoved: stripped.result.statusLineRemoved,
  }
}

/**
 * 写完之后要说的那一句:**hooks 要下一次开会话才生效**。
 *
 * 不说这一句的后果是可预见的:他点完「接上」,回到正开着的那个 Claude Code 窗口敲一句,
 * 会话区依然没动静 —— 于是他以为这颗按钮没用。
 */
export function wbHooksRestartHint(agent: WbHooksAgent): string {
  // 只说"要重开"这一件事 —— "已经接上了"由调用方那句话去说,两处都说会读成车轱辘话。
  return agent === 'claude'
    ? '正开着的 Claude Code 窗口还是旧配置 —— 关掉它、重新开一个会话,工作台才收得到它的动静。'
    : `正开着的 Codex 会话还是旧配置 —— 关掉它、重新开一个。${WB_HOOKS_CODEX_TRUST_HINT}`
}

/**
 * Codex 那边还差的一步(2026-10-21):新版 Codex 对没放行过的钩子一条都不跑,写进去不等于在跑。
 * 「接上」之后那句话(单家、两家并一句)都要带上它,不然她会以为接上了。
 */
export const WB_HOOKS_CODEX_TRUST_HINT = `Codex 还要你放行一次:${CODEX_TRUST_HOW},放行之后工作台才收得到它的动静。`

// ——————————— 技能段:事务官自己的配置(派活给别家 Agent / 运营技能包,2026-09-21) ———————————

/**
 * 事务官的技能怎么进 DSH:**跟「说话方式」一模一样的机制** —— `~/.dsh/AGENTS.md` 里一个
 * 标记段,段内由工作台整段重写,**段外一个字不动**(memoryMd.ts 的 `upsertMarkedBlock`)。
 *
 * 为什么技能段跟钩子放同一个文件里:它们是同一件事的两半 —— 钩子是"工作台代写别人家的配置",
 * 技能段是"工作台代写事务官自己的配置"。两边共用同一套纪律(先备份、备份没做成就一个字不写、
 * 只动自己那一段、能撤回),共用 `backup()` 这一个实现比各写一份安全。
 *
 * 与钩子不同的一点:这里**不需要**"别人的条目连顺序都不动"那套判据 —— 标记段天然只圈住
 * 自己那一段,段外的内容连读都不用读懂。
 *
 * > 合并说明(2026-09-21,merge/sprint-3):`feat/agent-dispatch-skill` 与 `feat/ops-skills`
 * > 曾各自在这个文件末尾放了**一份逐字相同的** `wbSkillMergeInto / wbSkillRemoveFrom /
 * > wbSkillApply / wbSkillRevert`(后者是从前者抄的,它自己的交接里写明「合的时候删我的四个」)。
 * > 合并时留下的是 main 上派活卡那一份,下面这四个函数就是它;运营技能包自己的东西在
 * > `wbOpsSkillsApply` 那一段和 `server/opsSkills.ts` 里,两条接线(`/config/skill` 与
 * > `/config/ops-skills`)互不相干。
 */

/** 派活技能那一段的标记名。与 `docs/技能/派活给别家Agent.md` 的文件名对齐,免得两处对不上。 */
export const WB_SKILL_DISPATCH = '派活给别家Agent'

/**
 * 发文件技能那一段的标记名(2026-10-04,卡 `claude/phone-file-send-loop`)。
 * 与 `docs/技能/发文件到手机.md` 的文件名对齐;清单里那一条在 `opsSkills.ts` 的 `BASE_SKILLS` 里。
 */
export const WB_SKILL_SEND_FILE = '发文件到手机'

/**
 * 把一段技能正文合并进 AGENTS.md 全文。**不碰磁盘。**
 *
 * 2026-10-01(卡「设置里集中改提示词」):**写之前先问一句覆盖层** —— 她在设置里改过这一段的话
 * 写她那一份,没改过写默认那一份(`promptOverrides.ts`)。这里是所有标记段写入路的**唯一腰眼**
 * (规矩表同步、进化固化技能、「接上派活技能」、切模板与发版重写十几段、电话里追一条称呼,
 * 全从这儿出去),所以接在这儿漏不掉一条。没装覆盖层时原样回默认,之前的行为一字不变。
 *
 * 2026-10-02(卡「提示词页改成她的偏好页」):技能正文她不改了,改的是**那个环节的偏好** ——
 * 写进去那一刻由本体把偏好接在正文末尾(`withPromptPrefs`,一对注释标记、先摘后接)。
 * 接在这同一个腰眼上的理由同上:发版重写十几段也走这儿,于是**发版不冲掉偏好**。
 * 顺序要紧:先 `resolvePromptBody`(她改过的正文 —— 迁移之后只剩人话那几项),再接偏好;
 * 倒过来的话覆盖层会把"正文 + 偏好"当成一份新默认记下来。
 */
export function wbSkillMergeInto(text: string | undefined, name: string, body: string): string {
  // 文件还不存在时不造一个 H1 出来 —— 那会在引导写「我叫 X」之前先占掉首行。
  return upsertMarkedBlock(text ?? '', name, withPromptPrefs(name, resolvePromptBody(name, body)), 'end')
}

/**
 * **备份 → 写回**,给不是标记段的那一处用:AGENTS.md 首行那句「我叫 X。」
 * (设置里改名字走这条)。纪律与 `wbSkillApply` 同一份 —— 备份没做成就一个字都不写。
 */
export async function wbAgentsWrite(
  deps: WbHooksApplyIo,
  input: { file: string, next: string },
): Promise<{ ok: true, backup_path?: string } | WbHooksFail> {
  const original = await deps.io.readFile(input.file)
  if (original === input.next) return { ok: true }
  let backupPath: string | undefined
  if (original !== undefined) {
    const saved = await backup(deps, input.file, original)
    if (!saved.ok) return saved
    backupPath = saved.path
  }
  try { await deps.io.writeFile(input.file, input.next) }
  catch {
    return {
      ok: false,
      error: `写不进 ${input.file}(可能是权限)。${backupPath === undefined ? '原来的内容没有任何改动。' : `原来那份备份在 ${backupPath}。`}`,
    }
  }
  return { ok: true, ...(backupPath === undefined ? {} : { backup_path: backupPath }) }
}

/** 只摘掉这一段(撤回按钮走这条)。没有这一段就原样回。 */
export function wbSkillRemoveFrom(text: string | undefined, name: string): { text: string, removed: boolean } {
  const original = text ?? ''
  const { open, close } = markers(name)
  const start = original.indexOf(open)
  const end = original.indexOf(close)
  if (start === -1 || end === -1 || end < start) return { text: original, removed: false }
  // 段前那一个空行跟着段一起走,不然撤回几次就会在文件里堆出一串空行。
  let from = start
  while (from > 0 && original[from - 1] === '\n' && original[from - 2] === '\n') from -= 1
  const rest = original.slice(end + close.length).replace(/^\n/, '')
  return { text: `${original.slice(0, from)}${rest}`, removed: true }
}

export interface WbSkillApplyOk {
  ok: true
  /** 备份在哪。文件本来就不存在时没有备份(没有东西可丢)。 */
  backup_path?: string
  /** 这一段是新加的还是换掉了旧的。 */
  block: 'added' | 'replaced'
}

/**
 * 代写技能段:备份 → 换段 → 写回。任何一步不对就**整件事停下**,原文件保持原样。
 *
 * **`file` 由调用方给**(生产是 `~/.dsh/AGENTS.md`,用例给临时 HOME 底下的一份)——
 * 这个模块一个字都不认 `process.env.HOME`:2026-09-04 家目录被删事故之后,凡是写家目录的
 * 代码都必须把路径做成可注入参数(记忆:Swift 沙箱 HOME 陷阱同理)。
 */
export async function wbSkillApply(
  deps: WbHooksApplyIo,
  input: {
    file: string
    name: string
    body: string
    /**
     * 正文落在哪(2026-10-02,卡「事务官为什么要跑这么多步」):给了就**正文落盘、段里只留索引**
     * (与 `wbOpsSkillsApply` 同一条口径 —— 两条写路写出来的那一段必须同形,
     * 不然设置里点一次「接上」就把 5839 字的正文又塞回 AGENTS.md)。
     * **缺席 = 老实现**(她那几项人话走的就是这一支),一个字不变。
     */
    bodyFile?: string
  },
): Promise<WbSkillApplyOk | WbHooksFail> {
  const body = input.body.trim()
  // 空正文不写:写一个空的标记段等于在他的 AGENTS.md 里留两行噪音,而技能一条都没有。
  if (body === '') return { ok: false, error: '技能正文是空的(仓库里那份 docs/技能/ 文件没读到?),这次一个字都没写。' }

  const original = await deps.io.readFile(input.file)
  const had = original !== undefined && original.includes(markers(input.name).open)
  const skill = input.bodyFile === undefined ? undefined : opsSkillByName(input.name)
  // 认不出这个段名(她手写的段)→ 不敢替她换成索引,照旧整段写。
  const next = input.bodyFile !== undefined && skill !== undefined && await writeSkillBody(deps, input.bodyFile, body)
    ? upsertMarkedBlock(original ?? '', input.name, withPromptPrefs(input.name, opsSkillIndexEntry(skill, input.bodyFile)), 'end')
    : wbSkillMergeInto(original, input.name, body)
  if (original !== undefined && next === original) {
    // 一模一样就不写 —— 不写就不用备份,他的目录里也不会每次重启多一个 .bak 文件。
    return { ok: true, block: 'replaced' }
  }

  let backupPath: string | undefined
  if (original !== undefined) {
    const saved = await backup(deps, input.file, original)
    if (!saved.ok) return saved
    backupPath = saved.path
  }

  try { await deps.io.writeFile(input.file, next) }
  catch {
    return {
      ok: false,
      error: `写不进 ${input.file}(可能是权限)。${backupPath === undefined ? '原来的内容没有任何改动。' : `原来那份备份在 ${backupPath}。`}`,
    }
  }
  return { ok: true, ...(backupPath === undefined ? {} : { backup_path: backupPath }), block: had ? 'replaced' : 'added' }
}

/** 撤回技能段。同样先备份;本来就没有这一段时不写、不备份。 */
export async function wbSkillRevert(
  deps: WbHooksApplyIo,
  input: { file: string, name: string },
): Promise<{ ok: true, backup_path?: string, removed: boolean } | WbHooksFail> {
  const original = await deps.io.readFile(input.file)
  if (original === undefined) return { ok: true, removed: false }
  const stripped = wbSkillRemoveFrom(original, input.name)
  if (!stripped.removed) return { ok: true, removed: false }

  const saved = await backup(deps, input.file, original)
  if (!saved.ok) return saved
  try { await deps.io.writeFile(input.file, stripped.text) }
  catch {
    return { ok: false, error: `写不进 ${input.file}(可能是权限)。原来那份备份在 ${saved.path}。` }
  }
  return { ok: true, backup_path: saved.path, removed: true }
}

// ———————————————————————— 运营技能包:模板判断 + 一次写完 ————————————————————————

/**
 * **所有**技能段的名字(基础那几段 + 运营那十段)。摘段时按这一份挨个摘 ——
 * 摘的依据不能是"当前模板要写哪几段"(那样切走之后旧的那几段会永远留在他的 AGENTS.md 里)。
 *
 * 2026-09-22:从「八段运营」改成「全部」,因为从这一天起有了**两种模板都写**的段
 * (`BASE_SKILLS`)。判据也跟着改:不再是 `wanted.length === 0` 走摘、否则走写,
 * 而是 **`wanted` 之外的一律摘、`wanted` 之内的一律写** —— 对既有那八段逐字等价
 * (ops 下八段全在 wanted 里,做产品下八段全不在)。
 */
const ALL_SKILL_NAMES: readonly string[] = ALL_SKILL_NAMES_DEF

/**
 * 技能正文落盘。**落成了回 true**,没落成回 false(调用方退回"整段正文进 AGENTS.md")。
 *
 * 内容一模一样就不写:她的 `~/.dsh/workbench/技能/` 里不该每次重启都被重写一遍。
 * 这一份**不备份** —— 它是本体随版本走的说明书(发版重写),不是她的东西;
 * 她的东西是偏好,偏好在 AGENTS.md 的段里,那条路照旧备份。
 */
async function writeSkillBody(deps: WbHooksApplyIo, file: string, body: string): Promise<boolean> {
  const mkdirp = deps.io.mkdirp
  if (mkdirp === undefined) return false
  const dir = file.slice(0, file.lastIndexOf('/'))
  try {
    const have = await deps.io.readFile(file)
    if (have === body) return true
    if (dir !== '') await mkdirp(dir)
    await deps.io.writeFile(file, body)
    return true
  }
  catch { return false }
}

export interface WbOpsSkillsResult {
  ok: true
  /** 这次写进去的技能段名(按 OPS_SKILLS 的顺序)。 */
  written: string[]
  /** 这次摘掉的技能段名(切回做产品模板时就是这一批)。 */
  removed: string[]
  /** 仓库里读不到的那几份文件。**读不到就不写那一段**,如实回出去(D13)。 */
  missing: string[]
  /**
   * 这一次**真往盘上写了没有**(2026-09-22,卡 ①)。
   *
   * `written` 回答不了这件事:它是"这个模板下该有哪几段",幂等地重跑一次照样是满的。
   * 而界面要说的那句话在两种情况下**完全不同** —— 「已接上 11 段」与「本来就是对的,
   * 一个字没改」。少了这一格,每次重启、每次点按钮都会报一句"接上了 11 段",
   * 那是一句看着像干了活、其实什么也没说的话(D13)。
   *
   * `backup_path` 顶不了它:文件本来就不存在时写了也没有备份。
   */
  changed: boolean
  /** 备份路径。这次没写(内容一模一样)或者文件本来就不存在时缺席。 */
  backup_path?: string
}

/**
 * 技能包进 AGENTS.md。**模板闸就在第一句上**:`opsSkillsForTemplate` 回的是
 * "这个模板下该有哪几段" —— `ops` 下是基础那几段 + 运营那十条,别的模板(做产品、
 * 认不出的、没选过)只有基础那几段。于是这个函数在做产品模板下做的事是
 * **把之前写过的运营技能段摘掉、把基础那几段写上**。
 *
 * ## 为什么做产品模板下是"摘掉"而不是"不管"
 *
 * 卡里写的是「做产品模板下不写」。不写有两种做法:① 什么都不做;② 把旧的摘掉。
 * 选 ②,理由是切模板之后事务官的行为必须跟着变:AGENTS.md 里还挂着「他抛来一个想法时
 * 梳理成内容框架、落 `选题/<名>/框架.md`」的话,做产品模板下他说一句想法,
 * 事务官会去建一个 `选题/` 目录 —— 那正是"切了没生效"最难查的那一种。
 * **这条是可推翻的**(决策记录里记了一份):想留着的话把 `wanted.length === 0` 那一支改成直接返回。
 *
 * ## 八段一次算完、写一次
 *
 * 先在内存里把八段都换进去,再**备份一次、写一次**。不是八次「备份 → 写回」:
 * 那样第一次接的时候他的 `~/.dsh/` 里会一下多出七个 `.bak` 文件,而且中途失败会留下
 * 一份"写了五段"的文件。现在的后果是确定的:**要么八段都在,要么一个字都没动。**
 */
export async function wbOpsSkillsApply(
  deps: WbHooksApplyIo,
  input: {
    file: string
    /** 当前模板 id。`'ops'` 之外的一律按"摘掉"处理。 */
    templateId: string | undefined
    readDoc: (skill: OpsSkillDef) => Promise<string | undefined>
    /**
     * 这一段的正文落在哪(2026-10-02:AGENTS.md 里只留索引)。
     * **缺席 = 老实现**,正文整段写进 AGENTS.md,一个字不变。
     */
    bodyFile?: (name: string) => string
  },
): Promise<WbOpsSkillsResult | WbHooksFail> {
  const wanted = opsSkillsForTemplate(input.templateId)
  const written: string[] = []
  const removed: string[] = []
  const missing: string[] = []

  const original = await deps.io.readFile(input.file)
  let next = original ?? ''

  // ① 先摘掉"这个模板下不该有的那几段"。判据是 `wanted` 之外,不是"wanted 是空的"——
  //    2026-09-22 起有了两种模板都写的段,`wanted` 永远不空,老那条判据会漏摘。
  const wantedNames = new Set(wanted.map(skill => skill.name))
  for (const name of ALL_SKILL_NAMES) {
    if (wantedNames.has(name)) continue
    const stripped = wbSkillRemoveFrom(next, name)
    if (stripped.removed) removed.push(name)
    next = stripped.text
  }
  // ② 再写"该有的那几段"。
  for (const skill of wanted) {
    const text = await input.readDoc(skill)
    // 读不到就**跳过这一段**,不写一个空的、也不拿别的顶替。哪一份缺了如实回出去。
    if (text === undefined || text.trim() === '') { missing.push(skill.name); continue }
    const body = opsSkillBody(text)
    /**
     * **索引进 AGENTS.md、正文落盘**(2026-10-02,卡「事务官为什么要跑这么多步」)。
     * 正文落不下去(宿主老、没给 mkdirp、写不进盘)就**退回整段正文** ——
     * 宁可注 2.7 万字,也不留一个指向空位置的指针(那是一段静默失败的说明书)。
     */
    const bodyFile = input.bodyFile?.(skill.name)
    if (bodyFile !== undefined && await writeSkillBody(deps, bodyFile, body)) {
      /**
       * 这一支**不过 `resolvePromptBody`**:索引不是"她改过的正文",拿她 10-01 存的那份
       * 全文覆盖会把 2.7 万字又塞回段里。偏好照旧接在段里(`withPromptPrefs`)——
       * 那是**她的意思**,每次都该注进去;落盘那一份是机器说明书,按需读。
       */
      next = upsertMarkedBlock(next, skill.name, withPromptPrefs(skill.name, opsSkillIndexEntry(skill, bodyFile)), 'end')
    }
    else next = wbSkillMergeInto(next, skill.name, body)
    written.push(skill.name)
  }

  // 一个字都没变就不写 —— 不写就不用备份,他的目录里也不会每次重启多一个 .bak 文件。
  if (next === (original ?? '')) return { ok: true, written, removed, missing, changed: false }

  let backupPath: string | undefined
  if (original !== undefined) {
    const saved = await backup(deps, input.file, original)
    if (!saved.ok) return saved
    backupPath = saved.path
  }
  try { await deps.io.writeFile(input.file, next) }
  catch {
    return {
      ok: false,
      error: `写不进 ${input.file}(可能是权限)。${backupPath === undefined ? '原来的内容没有任何改动。' : `原来那份备份在 ${backupPath}。`}`,
    }
  }
  return { ok: true, written, removed, missing, changed: true, ...(backupPath === undefined ? {} : { backup_path: backupPath }) }
}

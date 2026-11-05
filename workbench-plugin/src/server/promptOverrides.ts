/**
 * 她改过的提示词(2026-10-01,卡「设置里集中改提示词」)。维护者原话:
 * 「我还需要有一个可以集中改提示词的地方」。
 *
 * ## 这一层是什么
 *
 * 事务官**没有**写死的总提示词:对话与电话都读 `~/.dsh/AGENTS.md`,由多处各写各的标记段
 * (引导写「说话方式」、规矩表写「规矩」、技能那几条由 `wbOpsSkillsApply` 整段重写……)。
 * 于是「集中改提示词」不能是"再写一份提示词文件"——那会立刻和发版重写打架。
 *
 * 这个文件是**用户层里的一张覆盖表**(`~/.dsh/workbench/prompt-overrides.json`):
 * 按段名存她改过的正文 + **改那一刻那份默认的指纹**。所有往 AGENTS.md 写标记段的路
 * 写之前先问一句 `resolve(段名, 默认正文)`:
 *
 * - 没覆盖 → 原样回默认(**之前的行为一字不变**);
 * - 有覆盖 → 回她那一份,并且**把这次看到的新默认记下来**;
 * - 默认变了(发版更新了那一段)而她改过 → **不冲掉**,设置页那一段标「默认版本有更新」,
 *   她可以看新默认、也可以一键换成新默认(= 清掉覆盖)。
 *
 * ## 三条纪律
 *
 * 1. **只在她这台机器上**:这张表在 `~/.dsh/workbench/` 里,永不上传、永不合并(AGENTS.md
 *    「用户层」那一条)。本体发版热更新,这张表原地不动。
 * 2. **写家目录的路径全是注入的**(2026-09-04 事故纪律):表文件、留痕文件都由调用方给,
 *    用例用临时目录。
 * 3. **表坏了 / 没有 = 一条覆盖都没有,不抛**:一份读不懂的 json 不该让工作台起不来,
 *    更不该让事务官没有提示词。
 *
 * ## 不可改清单(AGENTS.md §9)在这里是一道**代码里的门**
 *
 * 澄清环节(《需求确认点》)、回滚机制(《做产品-改工作台自己》)那几段**存不进去** ——
 * 不是界面上灰掉就算,`save()` 当场拒(界面灰掉只防手滑,挡不住别家直接打接口)。
 *
 * ## 追加式的那两段
 *
 * 「称呼」是一张轮着用的表,电话里 `POST /butler/memory/preference` 往段里**追**一条。
 * 对这种段覆盖层**不顶替**(否则她在电话里说的下一条会被一份过期的覆盖抹掉),而是
 * **跟着刷新**:写进去的那一份同时成为覆盖层里的那一份,于是两边永不打架。
 *
 * ## 2026-10-02:分两层 —— 她的意思 / 机器说明书
 *
 * 维护者 10-02:「提示词现在看似有一个汇总的地方,但是运营人员反馈太杂了」,
 * 「不要拿着打补丁的心态,要有机制上的调整」。量过维护者那台:9 段、约 2.7 万字、
 * 接口与地址 149 处 —— 把说明书原样摊给她改,本来就不是她该干的活。
 *
 * 机制改成两层:
 *
 * 1. **她的意思** = 人话那几项(它叫什么 / 怎么称呼你 / 说话方式 / 她的规矩)
 *    + **各工作环节的偏好**(选题怎么选、标题怎么起……)。偏好是**一条一句的短句**,
 *    落在这同一张表的 `prefs` 里(同一个落点、同一份留痕、同一次迁移 ——
 *    分两个文件做迁移会出现"条目写了一半、正文还占着"的半成品)。
 * 2. **机器说明书** = 技能正文。**她不再改正文**(收回 10-01 那一版的可编辑):
 *    正文由本体发版管,写进 AGENTS.md 那一刻,本体把她那一环节的偏好**接在正文末尾**
 *    (`withPromptPrefs`,带一对注释标记,幂等)。于是发版重写技能,偏好原样不动。
 *
 * **位置为什么钉在正文末尾、而不是在技能文档里留一个占位**:占位被填掉之后就没了,
 * 下一次从 AGENTS.md 读回来再写时找不着原位,位置会一次次往后漂。一对标记 + 固定在末尾
 * 是**可重入**的:读回来 → 摘掉标记那一段 → 重新接上,写多少次都一样。
 *
 * **迁移**(`migrateSkillBodies`):10-01 那一版她改过的技能正文不许静默丢 ——
 * 能和当时那份默认逐行比出"她加的那几句"就转成偏好条目;比不出来(默认没留底、
 * 或者她删过默认里的句子)就把那一段**原样留着**,照旧写进 AGENTS.md,
 * 并在页面上提示一次「这段你改过的旧内容我替你放在这里了」。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { CALL_ADDRESS_BLOCK, CALL_PREFS_BLOCK, SPEAKING_STYLE_BLOCK } from './memoryMd.ts'
import { CONFIRM_SKILL_NAME } from './confirmPoints.ts'
import { RULES_BLOCK } from './rules.ts'
import { defaultUserLayerPrefsDir } from './userLayer.ts'

/** 首行「我叫 X。」在这一页里当一段看。**它不是标记段**,写法单独一支(`applyAgentsFile`)。 */
export const PROMPT_NAME_SECTION = '名字'

/** 段外她自己想加的几句,落在一个**只有这一页会写**的标记段里。 */
export const PROMPT_EXTRA_SECTION = '我的补充'

/** 《做产品-改工作台自己》那一段的段名(不可改清单·回滚机制)。与 opsSkills.ts 里逐字相同。 */
export const PROMPT_SELF_SHIP_SECTION = '做产品-改工作台自己'

/** 一段正文最长多少字。再长就不是提示词,是一篇文档 —— 整份 AGENTS.md 会被它稀释。 */
export const PROMPT_BODY_MAX = 20_000

/** 一条偏好最长多少字。再长就不是一句偏好,是一段说明(同 `RULE_MAX_CHARS` 那条理由)。 */
export const PROMPT_PREF_LINE_MAX = 200

/** 一个环节最多几条偏好。再多就该进「记住的规矩」那张处处算数的表了。 */
export const PROMPT_PREF_LINES_MAX = 20

/** 偏好接在技能正文末尾时那一对标记。**成对**才摘得干净(见文件头「位置为什么钉在末尾」)。 */
export const PROMPT_PREF_OPEN = '<!-- 她的偏好:开始 -->'
export const PROMPT_PREF_CLOSE = '<!-- 她的偏好:结束 -->'

/** 偏好那一节的头一行(给事务官看的那一句)。 */
export const PROMPT_PREF_HEADING = '照她的偏好办(她自己说的):'

/** 迁移过来、拆不成条目的那一段旧正文,前面摆这一行 —— 不许静默丢。 */
export const PROMPT_PREF_KEPT_HEADING = '她以前在这一段里自己改过的话(原样留着):'

/** 页面上那一句提示(迁移留下旧内容时说一次)。 */
export const PROMPT_PREF_KEPT_NOTICE = '这段你改过的旧内容我替你放在这里了'

/**
 * 技能正文为什么在这一页里只读(2026-10-02)。
 *
 * 不是界面上灰一下:`store.save` 当场拒 —— 界面灰掉只防手滑,挡不住别家直接打接口。
 */
export const PROMPT_SKILL_READONLY
  = '这一段是工作台的说明书(接口、路径、步骤),由工作台发版管着,不用你改。'
  + '你想要的那几句写在上面那个环节的「你的偏好」里 —— 工作台每次重写这一段都会把它接上去。'

/** 改过的提示词的真源(2026-10-26 切割收尾):`~/.dsh/workbench/用户层/偏好/prompt-overrides.json`(老位置一次性迁进,不再读)。 */
export function defaultPromptOverridesFile(home = process.env.HOME ?? ''): string {
  return join(defaultUserLayerPrefsDir(home), 'prompt-overrides.json')
}

export function defaultPromptOverridesLogFile(home = process.env.HOME ?? ''): string {
  return join(defaultUserLayerPrefsDir(home), 'prompt-overrides.log.jsonl')
}

/** 怎么写的都算同一份:换行规整、首尾空白去掉,再取 sha256 的头 16 位。 */
export function promptFingerprint(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n').trimEnd()
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

/** 这一段的正文怎么进 AGENTS.md。 */
export type PromptSectionMode =
  /** 标记段,整段重写(绝大多数)。 */
  | 'rewrite'
  /** 标记段,别处往里**追**条目(称呼) —— 覆盖层不顶替,只跟着刷新。 */
  | 'append'
  /** 首行「我叫 X。」,不是标记段。 */
  | 'line'

export interface PromptSectionMeta {
  name: string
  /** 界面上那一行标题。缺省就是段名本身。 */
  title: string
  /** 一句说明:这一段是干什么的、谁会写它。 */
  note: string
  /** 一个例子(人话那几项每项一句说明 + 一个例子,2026-10-02)。 */
  example?: string
  mode: PromptSectionMode
  /** 只读的原因(不可改清单)。缺席 = 这一段能改。 */
  locked?: string
  /** 编辑入口在别处(同一件东西不该有两处入口),这里只读 + 指过去。 */
  elsewhere?: string
  /** 技能正文:由本体管,她改偏好不改正文(2026-10-02)。 */
  manual?: string
}

/**
 * 这一段归哪一层(2026-10-02)。
 *
 * - `basic`:人话那几项(下面 `META` 里那几段)—— 她在这一页直接改正文;
 * - `skill`:机器说明书(技能段)—— 正文只读,她改的是**偏好**。
 *
 * 判据只有一条:**在不在 `META` 里**。认不出的段名一律当技能段 ——
 * 技能是会加的(10-01 那张卡在加《改造内置小组件》),照一份清单列迟早漏。
 */
export type PromptSectionKind = 'basic' | 'skill'

export function promptSectionKind(name: string): PromptSectionKind {
  return Object.hasOwn(META, name) ? 'basic' : 'skill'
}

/**
 * 不可改清单(AGENTS.md §9「以下五项写死,任何自我迭代/提议流程不得触及」)落到段上。
 *
 * 逐项判断(交接里列了同一份):
 * - **澄清环节** → 《需求确认点》那一段(接到一句需求拿不准才问、给确认点)。改得动它,
 *   事务官就能被改成"不问就开干",而那正是清单钉死这一条的理由。**锁。**
 * - **回滚机制** → 《做产品-改工作台自己》那一段(派活前开分支、通过后才合并发版、每一步失败就停)。
 *   它就是改工作台自己那条链上「能退回去」的那套纪律。**锁。**
 * - **记忆读写规则** → 不在 AGENTS.md 的标记段里(在 `docs/记忆/README` 与段外),所以这一页
 *   本来就改不到:这一页只写标记段 + 首行 + 「我的补充」,**段外一个字不动**。
 * - **AI 悬浮窗**、**日结功能本身** → 是工作台的功能,不是提示词段;这一页里没有对应的段。
 *
 * ★ **锁的是正文,不是她的偏好**(2026-10-02 维护者拍板):这两段的正文照旧只读
 * (`save` 当场 400),但**偏好收**(`setPrefs` 放行)—— 于是做产品模板下有「需求」「验收」
 * 这两个环节。她在那两段后面加一句自己的讲究不算触及清单;清单钉死的是口径不许被改掉。
 */
export const PROMPT_LOCKED_SECTIONS: Readonly<Record<string, string>> = {
  [CONFIRM_SKILL_NAME]:
    '不可改清单·澄清环节:接到一句需求,拿不准才问、一次只问最要紧的那一件、只在四类事上问你,这一条写死。'
    + '改得动它,事务官就会不问就开干 —— 那正是这条清单钉死它的理由。',
  [PROMPT_SELF_SHIP_SECTION]:
    '不可改清单·回滚机制:改工作台自己那条链(先开分支 → 派活 → 你通过才合并发版 → 每一步失败就停)写死。'
    + '它是"改坏了能退回去"的那套纪律,不走提示词改。',
}

/**
 * 人话那几项(2026-10-02)。**每项一句说明 + 一个例子** —— 说明里不出现接口、路径、文件名:
 * 这一页是给"不会写代码的半专业个体"看的,机器说明书收在页底那一节。
 */
const META: Readonly<Record<string, Omit<PromptSectionMeta, 'name'>>> = {
  [PROMPT_NAME_SECTION]: {
    title: '它叫什么',
    note: '你怎么叫它。改完它下次自称就换了。',
    example: '比如:阿九',
    mode: 'line',
  },
  [CALL_ADDRESS_BLOCK]: {
    title: '怎么称呼你',
    note: '一行一个,它轮着叫。电话里说一句「以后叫我姚总」也会加到这里。',
    example: '比如:姚总',
    mode: 'append',
  },
  [SPEAKING_STYLE_BLOCK]: {
    title: '说话方式',
    note: '说长还是说短、什么语气、有话直说还是先铺垫。打字聊天和打电话用的是同一份。',
    example: '比如:说话短一点,别称「您」;有把握就直接给结论,不要先铺垫三句。',
    mode: 'rewrite',
  },
  [RULES_BLOCK]: {
    title: '你的规矩(要 / 不要)',
    note: '你说过一次就处处算数的那几条,它做每件事都带着。',
    example: '比如:界面不要用蓝色;没测过不许说做完了。',
    mode: 'rewrite',
    elsewhere: '这几条在上面「记住的规矩」那一节加和改 —— 同一张表不该有两处入口。',
  },
  [PROMPT_EXTRA_SECTION]: {
    title: '还想交代的几句',
    note: '上面几项装不下的话写在这儿,它每次都读。',
    example: '比如:我周三下午不在,别安排电话。',
    mode: 'rewrite',
  },
  [CALL_PREFS_BLOCK]: {
    title: '通话偏好(旧的几条)',
    note: '你以前在电话里立的几条规矩。新立的都进「记住的规矩」那张表了,这一段只剩那之前攒下的。',
    mode: 'append',
  },
}

/**
 * 这一段的身份。认不出的段名一律当「事务官的技能段」—— 技能是会加的(别的卡正在加)。
 *
 * 2026-10-02 起技能段带 `manual`:**正文她改不了**,她改的是那个环节的偏好。
 */
export function promptSectionMeta(name: string): PromptSectionMeta {
  const known = META[name]
  const locked = PROMPT_LOCKED_SECTIONS[name]
  const base: Omit<PromptSectionMeta, 'name'> = known ?? {
    title: name,
    note: '工作台干这件事的步骤说明。',
    mode: 'rewrite',
    manual: PROMPT_SKILL_READONLY,
  }
  return { name, ...base, ...(locked === undefined ? {} : { locked }) }
}

/** 这一段她能在这一页改**正文**吗。 */
export function promptSectionEditable(meta: PromptSectionMeta): boolean {
  return meta.locked === undefined && meta.elsewhere === undefined && meta.manual === undefined
}

// ───────────────────────────── 表 ─────────────────────────────

interface PromptOverrideRow {
  /** 她那一份正文。`null` = 没有覆盖(恢复默认之后仍留着这一行,好撤回)。 */
  body: string | null
  /** 她改那一刻那份默认的指纹与正文。 */
  default_fingerprint?: string
  default_body?: string
  /** 后来见到的那份默认(发版更新了这一段)。与 `default_fingerprint` 不同就是「有更新」。 */
  latest_default_fingerprint?: string
  latest_default_body?: string
  updated_at: string
  /** 上一版、上上一版……(`null` 表示那一版是"没有覆盖")。撤回从尾上取。 */
  history: (string | null)[]
}

/**
 * 一个环节的偏好(2026-10-02)。**与 `sections` 同一份文件**:同一个落点、同一份留痕、
 * 同一次迁移 —— 分两个文件做迁移会出现"条目写了一半、正文还占着"的半成品。
 */
interface PromptPrefRow {
  /** 一条一句,按她写的顺序。 */
  lines: string[]
  /** 迁移过来、拆不成条目的那一段旧正文(原样进 AGENTS.md,页面上也看得到)。 */
  kept?: string
  /** 「这段你改过的旧内容我替你放在这里了」还没点过"知道了"。 */
  notice?: boolean
  updated_at: string
  history: { lines: string[], kept?: string }[]
}

interface PromptOverridesFile {
  version: 1
  sections: Record<string, PromptOverrideRow>
  prefs: Record<string, PromptPrefRow>
}

/** 设置页那一行要的全部依据。 */
export interface PromptOverrideRowView {
  name: string
  body: string
  /** 默认那一份(她改之前的那一份),看得见才敢改回去。 */
  default_body?: string
  /** 发版之后那一段的默认变了。 */
  default_changed: boolean
  latest_default_body?: string
  updated_at: string
  /** 撤得回去吗。 */
  can_undo: boolean
}

export type PromptSaveResult = { ok: true } | { ok: false, error: string }

/** 设置页上一个环节那一行要的全部依据(2026-10-02)。 */
export interface PromptPrefView {
  lines: readonly string[]
  /** 迁移留下的那一段旧正文(只读地摆给她看)。 */
  kept?: string
  /** 还没打发过的那句「这段你改过的旧内容我替你放在这里了」。 */
  notice?: string
  can_undo: boolean
}

// ───────────────────── 偏好怎么接进技能正文(纯函数,写入路径用) ─────────────────────

/** 一行偏好进 AGENTS.md 的样子。 */
function prefLine(text: string): string {
  return `- ${text}`
}

/** 她那几条偏好拼成的那一节。一条都没有 → 空串(那就什么都不接)。 */
export function promptPrefBlock(input: { lines: readonly string[], kept?: string }): string {
  const body: string[] = []
  if (input.lines.length > 0) body.push(PROMPT_PREF_HEADING, ...input.lines.map(prefLine))
  const kept = input.kept?.trim() ?? ''
  if (kept !== '') body.push(PROMPT_PREF_KEPT_HEADING, kept)
  if (body.length === 0) return ''
  return [PROMPT_PREF_OPEN, ...body, PROMPT_PREF_CLOSE].join('\n')
}

/**
 * 把正文里那一对标记之间的东西摘掉(连着前面的空行)。**可重入**:
 * 从 AGENTS.md 读回来的正文里已经接过一次,再写之前先摘掉,才不会接出两份。
 */
export function stripPromptPrefBlock(body: string): string {
  let text = body
  for (;;) {
    const start = text.indexOf(PROMPT_PREF_OPEN)
    if (start === -1) return text
    const end = text.indexOf(PROMPT_PREF_CLOSE, start)
    if (end === -1) return text
    let from = start
    while (from > 0 && text[from - 1] === '\n') from -= 1
    const rest = text.slice(end + PROMPT_PREF_CLOSE.length).replace(/^\n+/, '')
    const head = text.slice(0, from)
    text = rest === '' ? head : `${head}\n\n${rest}`
  }
}

/** 正文 + 她那一节偏好。两头都先摘干净,写多少次都一样。 */
export function joinPromptPrefBlock(body: string, block: string): string {
  const base = stripPromptPrefBlock(body).trimEnd()
  if (block === '') return base
  return base === '' ? block : `${base}\n\n${block}`
}

export interface PromptOverrideStore {
  load: () => Promise<void>
  /** 她改过的那一份(没改过回 undefined)。 */
  get: (name: string) => { body: string, default_body?: string, default_fingerprint?: string } | undefined
  /** 她改过的那几段(设置页用)。 */
  rows: () => readonly PromptOverrideRowView[]
  /**
   * 这一段留的底:她改那一刻那份默认 + 后来见到的那份默认。
   * **恢复默认与撤回要它** —— 那两下的目标正是"此刻文件里没有的那一份"。
   */
  defaults: (name: string) => { default_body?: string, latest_default_body?: string, can_undo: boolean }
  /**
   * **写 AGENTS.md 之前问这一句**:这一段该写什么正文。同步的 —— 它只看内存里的表,
   * 不读盘;要落盘的那一点(记下新默认 / 刷新追加段)排在后台一条链上。
   */
  resolve: (name: string, defaultBody: string) => string
  /** 后台那条链都落完了。**只有用例需要它**。 */
  flush: () => Promise<void>
  save: (name: string, body: string, options?: { defaultBody?: string }) => Promise<PromptSaveResult>
  reset: (name: string) => Promise<PromptSaveResult>
  undo: (name: string) => Promise<PromptSaveResult>

  // ── 环节偏好(2026-10-02)──
  /** 这个环节她说过的那几条。 */
  prefs: (name: string) => PromptPrefView
  /** 整组替换(她在一个框里一行一条)。空数组 = 这个环节一条偏好都不要了。 */
  setPrefs: (name: string, lines: readonly string[]) => Promise<PromptSaveResult>
  undoPrefs: (name: string) => Promise<PromptSaveResult>
  /** 打发掉那句「这段你改过的旧内容我替你放在这里了」(只提示一次)。 */
  dismissPrefNotice: (name: string) => Promise<void>
  /** 写 AGENTS.md 那一刻接在技能正文末尾的那一节。没偏好 → 空串。 */
  prefBlockFor: (name: string) => string
  /**
   * 迁移 10-01 那一版她改过的**技能正文**(2026-10-02)。幂等:跑完技能段一条正文覆盖都不剩。
   * 回「哪几段转成了条目、哪几段原样留着」—— 留着的那几段页面上提示一次。
   */
  migrateSkillBodies: () => Promise<{ migrated: readonly string[], kept: readonly string[] }>
}

/** 正文拆成"一行一句"(去空行、去首尾空白、去掉行头的项目符号)。迁移与去重都按这一份。 */
function prefCandidateLines(text: string): string[] {
  return stripPromptPrefBlock(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim().replace(/^[-*•]\s*/u, '').trim())
    .filter(line => line !== '')
}

export function createPromptOverrideStore(options: {
  file: string
  logFile: string
  now?: () => Date
}): PromptOverrideStore {
  const now = options.now ?? (() => new Date())
  let data: PromptOverridesFile = { version: 1, sections: {}, prefs: {} }
  let chain: Promise<unknown> = Promise.resolve()

  async function persist(): Promise<void> {
    await mkdir(dirname(options.file), { recursive: true })
    await writeFile(options.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }

  /** 留痕:用户层里一行一条,只追加(撤回靠表里的 history,不靠改这份日志)。 */
  async function trace(entry: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(options.logFile), { recursive: true })
      await appendFile(options.logFile, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`, 'utf8')
    }
    catch {
      // 留痕写不下不该让这次保存失败(她的改动已经进表了)。
    }
  }

  /** 后台排一件要落盘的事。排成一条队:两次「读表 → 改 → 写回」交错会丢行。 */
  function queue(work: () => Promise<void>): void {
    chain = chain.then(work).catch(() => undefined)
  }

  function rowOf(name: string): PromptOverrideRow {
    const existing = data.sections[name]
    if (existing !== undefined) return existing
    const fresh: PromptOverrideRow = { body: null, updated_at: now().toISOString(), history: [] }
    data.sections[name] = fresh
    return fresh
  }

  function prefRowOf(name: string): PromptPrefRow {
    const existing = data.prefs[name]
    if (existing !== undefined) return existing
    const fresh: PromptPrefRow = { lines: [], updated_at: now().toISOString(), history: [] }
    data.prefs[name] = fresh
    return fresh
  }

  return {
    load: async () => {
      try {
        const text = await readFile(options.file, 'utf8')
        const parsed = JSON.parse(text) as unknown
        if (typeof parsed !== 'object' || parsed === null) return
        const sections = (parsed as { sections?: unknown }).sections
        const prefs: Record<string, PromptPrefRow> = {}
        const rawPrefs = (parsed as { prefs?: unknown }).prefs
        if (typeof rawPrefs === 'object' && rawPrefs !== null) {
          for (const [name, raw] of Object.entries(rawPrefs as Record<string, unknown>)) {
            if (typeof raw !== 'object' || raw === null) continue
            const one = raw as Partial<PromptPrefRow>
            prefs[name] = {
              lines: Array.isArray(one.lines) ? one.lines.filter(line => typeof line === 'string') : [],
              ...(typeof one.kept === 'string' ? { kept: one.kept } : {}),
              ...(one.notice === true ? { notice: true } : {}),
              updated_at: typeof one.updated_at === 'string' ? one.updated_at : now().toISOString(),
              history: Array.isArray(one.history)
                ? one.history.filter((item): item is { lines: string[], kept?: string } =>
                    typeof item === 'object' && item !== null && Array.isArray((item as { lines?: unknown }).lines))
                : [],
            }
          }
        }
        data = { version: 1, sections: {}, prefs }
        if (typeof sections !== 'object' || sections === null) return
        const out: Record<string, PromptOverrideRow> = {}
        for (const [name, raw] of Object.entries(sections as Record<string, unknown>)) {
          if (typeof raw !== 'object' || raw === null) continue
          const one = raw as Partial<PromptOverrideRow>
          const body = typeof one.body === 'string' ? one.body : null
          out[name] = {
            body,
            ...(typeof one.default_fingerprint === 'string' ? { default_fingerprint: one.default_fingerprint } : {}),
            ...(typeof one.default_body === 'string' ? { default_body: one.default_body } : {}),
            ...(typeof one.latest_default_fingerprint === 'string' ? { latest_default_fingerprint: one.latest_default_fingerprint } : {}),
            ...(typeof one.latest_default_body === 'string' ? { latest_default_body: one.latest_default_body } : {}),
            updated_at: typeof one.updated_at === 'string' ? one.updated_at : now().toISOString(),
            history: Array.isArray(one.history)
              ? one.history.filter(item => typeof item === 'string' || item === null) as (string | null)[]
              : [],
          }
        }
        data = { version: 1, sections: out, prefs }
      }
      catch {
        // 没有这份表、或者读不懂 = 一条覆盖都没有(文件头第 3 条)。
        data = { version: 1, sections: {}, prefs: {} }
      }
    },

    get: (name) => {
      const row = data.sections[name]
      if (row === undefined || row.body === null) return undefined
      return {
        body: row.body,
        ...(row.default_body === undefined ? {} : { default_body: row.default_body }),
        ...(row.default_fingerprint === undefined ? {} : { default_fingerprint: row.default_fingerprint }),
      }
    },

    rows: () => Object.entries(data.sections)
      .filter(([, row]) => row.body !== null)
      .map(([name, row]) => ({
        name,
        body: row.body as string,
        ...(row.default_body === undefined ? {} : { default_body: row.default_body }),
        default_changed: row.latest_default_fingerprint !== undefined
          && row.latest_default_fingerprint !== row.default_fingerprint,
        ...(row.latest_default_body === undefined ? {} : { latest_default_body: row.latest_default_body }),
        updated_at: row.updated_at,
        can_undo: row.history.length > 0,
      })),

    defaults: (name) => {
      const row = data.sections[name]
      return {
        ...(row?.default_body === undefined ? {} : { default_body: row.default_body }),
        ...(row?.latest_default_body === undefined ? {} : { latest_default_body: row.latest_default_body }),
        can_undo: (row?.history.length ?? 0) > 0,
      }
    },

    resolve: (name, defaultBody) => {
      const row = data.sections[name]
      if (row === undefined || row.body === null) return defaultBody
      const meta = promptSectionMeta(name)
      if (meta.mode === 'append') {
        // 追加式:**不顶替**,写进去的那一份同时成为覆盖层里的那一份(文件头最后一节)。
        if (row.body !== defaultBody) {
          row.body = defaultBody
          row.updated_at = now().toISOString()
          queue(persist)
        }
        return defaultBody
      }
      // 写进来的正是她那一份 → **那不是一份新默认**(设置页保存时走的就是这一支:
      // 它把她的正文交给 wbSkillApply,而真正的默认在 `default_body` 里留着底)。
      if (defaultBody === row.body) return row.body
      const seen = promptFingerprint(defaultBody)
      if (seen !== row.latest_default_fingerprint) {
        row.latest_default_fingerprint = seen
        row.latest_default_body = defaultBody
        queue(persist)
      }
      return row.body
    },

    flush: async () => { await chain },

    save: async (name, body, saveOptions) => {
      const meta = promptSectionMeta(name)
      if (meta.locked !== undefined) return { ok: false, error: meta.locked }
      if (meta.elsewhere !== undefined) return { ok: false, error: meta.elsewhere }
      // 技能正文 2026-10-02 起只读:她写的是偏好(`setPrefs`),正文归本体发版管。
      if (meta.manual !== undefined) return { ok: false, error: meta.manual }
      const next = body.replace(/\r\n/g, '\n').trimEnd()
      if (next.length > PROMPT_BODY_MAX) {
        return { ok: false, error: `这一段太长了(上限 ${String(PROMPT_BODY_MAX)} 字),写短一点。` }
      }
      if (next.trim() === '' && name !== PROMPT_EXTRA_SECTION) {
        return { ok: false, error: '这一段不能是空的 —— 空着事务官就没有这一条可照着办。想回到原来那一份就点「恢复默认」。' }
      }
      const row = rowOf(name)
      row.history.push(row.body)
      const before = row.body
      row.body = next
      row.updated_at = now().toISOString()
      const defaultBody = saveOptions?.defaultBody ?? row.default_body
      if (defaultBody !== undefined && before === null) {
        // 第一次改:记下**改那一刻**那份默认(以后比的就是它)。改过再改不重记。
        row.default_body = defaultBody
        row.default_fingerprint = promptFingerprint(defaultBody)
        row.latest_default_fingerprint = row.default_fingerprint
        row.latest_default_body = defaultBody
      }
      await persist()
      await trace({ action: 'save', name, before, after: next })
      return { ok: true }
    },

    reset: async (name) => {
      const row = data.sections[name]
      if (row === undefined || row.body === null) return { ok: true }
      row.history.push(row.body)
      const before = row.body
      row.body = null
      row.updated_at = now().toISOString()
      // 换成新默认之后,比的基准也跟着换 —— 不然下次再改会拿一份过期的默认当基准。
      if (row.latest_default_body !== undefined && row.latest_default_fingerprint !== undefined) {
        row.default_body = row.latest_default_body
        row.default_fingerprint = row.latest_default_fingerprint
      }
      await persist()
      await trace({ action: 'reset', name, before, after: null })
      return { ok: true }
    },

    undo: async (name) => {
      const row = data.sections[name]
      if (row === undefined || row.history.length === 0) {
        return { ok: false, error: '这一段没有上一版可以撤 —— 它还是第一次改之前的样子。' }
      }
      const before = row.body
      const previous = row.history.pop() ?? null
      row.body = previous
      row.updated_at = now().toISOString()
      await persist()
      await trace({ action: 'undo', name, before, after: previous })
      return { ok: true }
    },

    // ───────────────────────── 环节偏好(2026-10-02)─────────────────────────

    prefs: (name) => {
      const row = data.prefs[name]
      return {
        lines: row?.lines ?? [],
        ...(row?.kept === undefined ? {} : { kept: row.kept }),
        ...(row?.notice === true ? { notice: PROMPT_PREF_KEPT_NOTICE } : {}),
        can_undo: (row?.history.length ?? 0) > 0,
      }
    },

    setPrefs: async (name, lines) => {
      // 偏好只接在技能段(环节)的正文上。人话那几项她改的是正文本身,不该有第二个入口。
      if (promptSectionKind(name) !== 'skill') {
        return { ok: false, error: '这一项你直接改上面那一栏就行,不用在这儿写偏好。' }
      }
      /*
       * ★ **锁着的那几段也收偏好**(2026-10-02 维护者拍板「允许」)。
       *
       * 10-02 上午那一版把不可改清单那两段整段锁死、连偏好也不收,结果**做产品模板下只剩一个环节**
       * (「派活给别家」)——《需求确认点》与《做产品-改工作台自己》都在清单上。维护者的答复是
       * 「她在那两段后面加一句自己的偏好,不算触及不可改清单」。
       *
       * 分得清的是两件事:**正文仍然只读**(`save` 那一头照旧 400,门没松),
       * 她加的只是接在正文末尾的那一节偏好 —— 清单钉死的是"口径不许被改掉",
       * 不是"她不许在这一步上有自己的讲究"。
       */
      const next = lines.map(line => line.trim().replace(/^[-*•]\s*/u, '').trim()).filter(line => line !== '')
      if (next.length > PROMPT_PREF_LINES_MAX) {
        return { ok: false, error: `一个环节最多 ${String(PROMPT_PREF_LINES_MAX)} 条偏好,再多就该进「记住的规矩」那张表了。` }
      }
      const tooLong = next.find(line => [...line].length > PROMPT_PREF_LINE_MAX)
      if (tooLong !== undefined) {
        return { ok: false, error: `有一条太长了(一条最多 ${String(PROMPT_PREF_LINE_MAX)} 字),一条写一句。` }
      }
      const row = prefRowOf(name)
      row.history.push({ lines: [...row.lines], ...(row.kept === undefined ? {} : { kept: row.kept }) })
      const before = row.lines
      row.lines = next
      row.updated_at = now().toISOString()
      await persist()
      await trace({ action: 'prefs', name, before, after: next })
      return { ok: true }
    },

    undoPrefs: async (name) => {
      const row = data.prefs[name]
      const previous = row?.history.pop()
      if (row === undefined || previous === undefined) {
        return { ok: false, error: '这个环节没有上一版可以撤 —— 它还是你第一次写之前的样子。' }
      }
      const before = row.lines
      row.lines = previous.lines
      if (previous.kept === undefined) delete row.kept
      else row.kept = previous.kept
      row.updated_at = now().toISOString()
      await persist()
      await trace({ action: 'prefs-undo', name, before, after: previous.lines })
      return { ok: true }
    },

    dismissPrefNotice: async (name) => {
      const row = data.prefs[name]
      if (row === undefined || row.notice !== true) return
      delete row.notice
      await persist()
    },

    prefBlockFor: (name) => {
      if (promptSectionKind(name) !== 'skill') return ''
      const row = data.prefs[name]
      if (row === undefined) return ''
      return promptPrefBlock({ lines: row.lines, ...(row.kept === undefined ? {} : { kept: row.kept }) })
    },

    /**
     * 迁移(2026-10-02)。10-01 那一版她改过的技能正文,逐段这么处理:
     *
     * - 和**她改那一刻那份默认**逐行比:她只是**加了几句**(默认里一句没删)→ 加的那几句转成偏好条目;
     * - 比不出来(默认没留底 / 她删过默认里的句子 / 加的太多太长)→ 那一段**原样留着**
     *   (接着写进 AGENTS.md),页面上提示一次。
     *
     * 两种结果都把正文覆盖**撤掉**(进 history,撤得回去)—— 正文从此归本体,发版更新得了。
     */
    migrateSkillBodies: async () => {
      const migrated: string[] = []
      const kept: string[] = []
      for (const [name, row] of Object.entries(data.sections)) {
        if (row.body === null) continue
        if (promptSectionKind(name) !== 'skill') continue
        const hers = prefCandidateLines(row.body)
        const base = row.default_body === undefined ? undefined : prefCandidateLines(row.default_body)
        const prefRow = prefRowOf(name)
        prefRow.history.push({ lines: [...prefRow.lines], ...(prefRow.kept === undefined ? {} : { kept: prefRow.kept }) })
        let asLines: string[] | undefined
        if (base !== undefined) {
          const baseSet = new Set(base)
          const hersSet = new Set(hers)
          const added = hers.filter(line => !baseSet.has(line))
          const removed = base.filter(line => !hersSet.has(line))
          if (removed.length === 0 && added.length > 0
            && added.length <= PROMPT_PREF_LINES_MAX
            && added.every(line => [...line].length <= PROMPT_PREF_LINE_MAX)) {
            asLines = added
          }
        }
        if (asLines === undefined) {
          prefRow.kept = stripPromptPrefBlock(row.body).trim()
          prefRow.notice = true
          kept.push(name)
        }
        else {
          prefRow.lines = [...prefRow.lines, ...asLines.filter(line => !prefRow.lines.includes(line))]
          migrated.push(name)
        }
        prefRow.updated_at = now().toISOString()
        row.history.push(row.body)
        row.body = null
        row.updated_at = now().toISOString()
      }
      if (migrated.length === 0 && kept.length === 0) return { migrated, kept }
      await persist()
      await trace({ action: 'migrate-skill-bodies', migrated, kept })
      return { migrated, kept }
    },
  }
}

// ───────────────────── 装在进程里的那一份(写入路径从这里问) ─────────────────────

/**
 * **为什么是进程里一份、而不是一路参数传下去**:往 AGENTS.md 写标记段的路有六条
 * (引导重跑 / 规矩表同步 / 进化固化技能 / 「接上派活技能」/ 切模板与发版重写十几段 /
 * 电话里追一条称呼),分散在 `onboarding.ts`、`index.ts`、`http.ts` 三处。
 * 卡里要的是「**所有**写入点都要接」—— 一路传参数的做法,漏一处是静默的
 * (那一段会把她的改动冲掉,而没有任何一条用例会红)。
 *
 * 装在这里之后,waist 只有一个:`wbSkillMergeInto`(所有标记段都从它出去)+ 引导那一支。
 * 没装(既有那一大批用例)时 `resolvePromptBody` 原样回默认 —— **之前的行为一字不变**。
 */
let installed: Pick<PromptOverrideStore, 'resolve' | 'prefBlockFor'> | undefined

export function installPromptOverrides(store: Pick<PromptOverrideStore, 'resolve' | 'prefBlockFor'>): void {
  installed = store
}

/** 用例之间互不串台:`afterEach` 里调一次。 */
export function resetInstalledPromptOverrides(): void {
  installed = undefined
}

/** 写这一段之前问一句。没装覆盖层就原样回默认。 */
export function resolvePromptBody(name: string, defaultBody: string): string {
  if (installed === undefined) return defaultBody
  try { return installed.resolve(name, defaultBody) }
  catch { return defaultBody }
}

/**
 * **写技能段那一刻**把她那一环节的偏好接上去(2026-10-02)。
 *
 * 接在正文末尾、裹一对注释标记,**先摘后接**所以可重入 —— 于是:
 * - 发版重写技能正文(`wbOpsSkillsApply` 整段换新)→ 偏好原样还在;
 * - 她改一条偏好 → 这一段重写一次就带上了,电话下一通就按新的说。
 *
 * 没装覆盖层(既有那一大批用例)时原样回正文,**之前的行为一字不变**。
 */
export function withPromptPrefs(name: string, body: string): string {
  if (installed === undefined) return body
  try { return joinPromptPrefBlock(body, installed.prefBlockFor(name)) }
  catch { return body }
}

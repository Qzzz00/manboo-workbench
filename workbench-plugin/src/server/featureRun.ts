/**
 * 需求卡 = 指挥台(2026-09-22,`docs/审视-用户到底得到什么-2026-09-22.md` 第三节 + 第四节第三幕)。
 *
 * 审视第三节那张表,「做产品」这一列的缺口逐字:
 * **「需求 → 拆事项 → 派对的 Agent → 验收 → 回写文档 这条线没有一个入口」**;
 * 「决策记录靠人写(这个仓库的 docs 就是我们自己在手工做她该得到的东西)」。
 *
 * 第四节第三幕就是这个文件要做成的场景:
 * 她说「加一个导出 PDF」→ 拆成几件事(卡上看得见)→ 派给 Codex 做代码、Claude 审代码
 * → 完成待验收 → 电话叫她 → 她说「通过」→ **决策记录里多了一条,不用她写**。
 *
 * ## 与选题卡是**同一套**,不是第二套
 *
 * 读写产物、`修订/` 快照、段落级 diff、`审核记录.jsonl`、四档小标 —— 一行都没有重写,
 * 全在 `deckRun.ts`(选题卡那边现在也从那里拿)。这个文件只有需求自己的三样:
 *
 * 1. 四个页签各落哪个文件;
 * 2. 四态各该派给谁;
 * 3. 交给事务官的那段话怎么拼,以及**决策记录怎么落**。
 *
 * ## 这一层**不起任何活**(与 topicRun.ts 逐字同一条纪律)
 *
 * 「一键派出」派的不是进程:它把上下文拼成一段话,经 **`/butler/item/say` 同一个端口**
 * 交给事务官,由事务官按 AGENTS.md 里「派活给别家Agent」那一节去操作 Codex / Claude 的
 * 客户端窗口(或命令行、接口)。这一层要是也能派活,同一件事就有两条路能起进程。
 *
 * ## 目录约定
 *
 * ```
 * <项目根>/docs/需求/<需求名>/
 *   需求.md    ← 梳理:目标 / 边界 / 验收标准
 *   子事项.md  ← 拆解与派活:每件标「派给谁」
 *   验收.md    ← 验收:每件回来的结果摘要
 *   记录.md    ← 记录:要落进决策记录的那一条(日期 / 需求 / 做了什么 / 谁做的 / 遗留)
 *   审核记录.jsonl、修订/  ← 两种卡共用的那两样(deckRun.ts)
 * <项目根>/docs/决策记录.md   ← 「写进决策记录」追加到这里(路径可配)
 * ```
 *
 * **为什么落在她的项目仓库里而不是工作目录下**(与选题的 `选题/<名>/` 不同):
 * 决策记录这件事本来就是「写进**她仓库的** docs/决策记录.md」(卡里逐字)。
 * 需求、子事项、验收摘要跟着那份记录待在同一个仓库里,她 `git log` 得到、
 * 换台电脑也带得走;放进工作台的工作目录等于让代码与关于代码的决定分居两处。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  FeatureDocTab, FeatureDocView, FeatureHand, FeatureReviewEntry, FeatureStage,
} from '../protocol.ts'
import {
  DECISION_RECORD_REL, DEFAULT_FEATURE_STAGE, FEATURE_DOC_TABS, FEATURE_HAND_TITLES,
  FEATURE_STAGE_TABS, featureStageOf,
} from '../protocol.ts'
import type { SaveDeckDocResult } from './deckRun.ts'
import {
  appendDeckReview, deckConfirmed, deckDocLine, deckReviewLine, isSafeDeckName,
  lastConfirmEntry, lastRunEntry as lastDeckRunEntry, readDeckDocs, readDeckReviews, readIfThere, saveDeckDoc,
} from './deckRun.ts'
import type { ConfirmPoint } from './confirmPoints.ts'
import { buildConfirmPoints, confirmInstruction, notConfirmedWarning } from './confirmPoints.ts'

/** 需求目录在项目仓库里的相对位置。决策记录也在 `docs/` 下,两样待在一起。 */
export const FEATURE_DIR_REL = 'docs/需求'

/**
 * 页签 → 文件名。**唯一定义处**(同 `TOPIC_DOC_FILES` 的分寸:两处各写一份路径,
 * 改一处忘另一处是迟早的事)。
 */
export const FEATURE_DOC_FILES: Readonly<Record<FeatureDocTab, string>> = {
  需求: '需求.md',
  子事项: '子事项.md',
  验收: '验收.md',
  记录: '记录.md',
}

/** 这一态的产物落在哪个页签上。「让事务官推进这一步」的留痕记的就是它。 */
export const FEATURE_STAGE_TAB: Readonly<Record<FeatureStage, FeatureDocTab>> = {
  梳理: '需求',
  拆解与派活: '子事项',
  验收: '验收',
  记录: '记录',
}

/**
 * 确认点写进哪一份(2026-09-23,维护者:「不能假装自己搞懂了」)。
 *
 * 需求卡是 `需求.md` —— 它就是"这条需求到底是什么"那一份。**不是每一态各写一份**:
 * 确认点是需求本身的一部分,跟着需求走,不跟着这一步走。
 */
export const FEATURE_CONFIRM_TAB: FeatureDocTab = '需求'
export const FEATURE_CONFIRM_FILE = FEATURE_DOC_FILES[FEATURE_CONFIRM_TAB]

/** 这条需求过没过确认点。判据在 `审核记录.jsonl`(`deckConfirmed` 的注释写着为什么)。 */
export function featureConfirmed(entries: readonly FeatureReviewEntry[]): boolean {
  return deckConfirmed(entries)
}

/** 最后那一次过确认点是什么时候、他改了哪几条。 */
export function lastFeatureConfirm(entries: readonly FeatureReviewEntry[]): FeatureReviewEntry | undefined {
  return lastConfirmEntry(entries)
}

/** 按这句需求挑几条确认点。**规则只有一份**(`confirmPoints.ts`),这里只是取个名字。 */
export function featureConfirmPoints(need: string): ConfirmPoint[] {
  return buildConfirmPoints({ need })
}

/**
 * 这一态**派给谁**(第三幕逐字:「派给 Codex 做代码、Claude 审代码」)。
 *
 * - 梳理:她说一句、事务官问最多两问 —— 没有任何要派出去的活;
 * - 拆解与派活:拆是事务官自己拆,**派**才是 Codex / Claude 上场;
 * - 验收:结果回来的摘要由事务官汇总,判断是她的;
 * - 记录:写一条记录,不需要别家。
 */
export const FEATURE_STAGE_HANDS: Readonly<Record<FeatureStage, readonly FeatureHand[]>> = {
  梳理: ['butler'],
  拆解与派活: ['codex', 'claude'],
  验收: ['butler'],
  记录: ['butler'],
}

/** 这一态这一步要不要真去动别家的客户端。要 = 那几只手都不在时才谈得上「代做」。 */
export function stageNeedsHands(stage: FeatureStage): boolean {
  return FEATURE_STAGE_HANDS[stage].some(hand => hand !== 'butler')
}

/**
 * 这一态事务官该做什么(那段话里的第二句,也是卡上按钮底下那行小字)。
 * **一句话说清"点下去会发生什么"** —— 一颗不知道会干什么的按钮她不会点。
 */
export const FEATURE_STAGE_BRIEF: Readonly<Record<FeatureStage, string>> = {
  梳理: '就她那一句话,最多问两个问题,写成 需求.md:目标 / 边界 / 验收标准',
  拆解与派活: '按需求拆成几件子事项,每件标「派给谁」,然后按「派活给别家Agent」派出去',
  验收: '把每件回来的结果收成一段摘要落 验收.md,说清哪件成了、哪件没成',
  记录: '把这件事的结论写成 记录.md(日期 / 需求 / 做了什么 / 谁做的 / 遗留)',
}

/**
 * 一条需求的目录在哪。名字不合法回 undefined(**不拼一条半截路径出来**,同 `topicDirOf`)。
 *
 * `projectPath` 是**服务端自己从 `task.project_id` 查出来的项目根**,不收界面传进来的路径:
 * 一条从界面传进来的绝对路径等于一把"往任何地方写文件"的钥匙。
 */
export function featureDirOf(projectPath: string, name: string): string | undefined {
  return isSafeDeckName(name) ? join(projectPath, FEATURE_DIR_REL, name.trim()) : undefined
}

/* ──────────────────────── 读写产物(实现在 deckRun.ts)──────────────────────── */

/** 四个页签一次全读回来。 */
export async function readFeatureDocs(dir: string): Promise<FeatureDocView[]> {
  return readDeckDocs(dir, FEATURE_DOC_TABS, FEATURE_DOC_FILES)
}

/** 把一份产物写回文件(顺手存上一版、回这一轮的 diff)。 */
export async function saveFeatureDoc(input: {
  dir: string
  tab: FeatureDocTab
  text: string
  now: Date
}): Promise<SaveDeckDocResult> {
  return saveDeckDoc({ dir: input.dir, file: FEATURE_DOC_FILES[input.tab], text: input.text, now: input.now })
}

/** 往 `审核记录.jsonl` 追加一行。 */
export async function appendFeatureReview(
  dir: string, entry: FeatureReviewEntry,
): Promise<{ ok: true } | { ok: false, reason: string }> {
  return appendDeckReview(dir, entry)
}

/** 读把关记录(最近的在最后)。 */
export async function readFeatureReviews(dir: string, tail?: number): Promise<FeatureReviewEntry[]> {
  return readDeckReviews<FeatureReviewEntry>(dir, tail)
}

/** 最后一次「让事务官推进」那一条。 */
export function lastFeatureRun(entries: readonly FeatureReviewEntry[]): FeatureReviewEntry | undefined {
  return lastDeckRunEntry(entries)
}

/* ──────────────────────── 交给事务官的那段话 ──────────────────────── */

export interface FeatureRunInput {
  /** 需求名(= 卡的标题,也是目录名)。 */
  name: string
  /** 这条需求所在的看板卡 id。事务官报派活进度时要用它。 */
  taskId: string
  stage?: FeatureStage
  /** 哪个项目(名字)。没挂项目时缺席 —— **不编一个**。 */
  project?: string
  /** 项目仓库根。事务官动手改代码要知道在哪个仓库里。 */
  projectPath?: string
  /** `docs/需求/<名>/` 的绝对路径。 */
  dir: string
  /** 四个页签此刻各自有没有、多长。由 `readFeatureDocs` 给。 */
  docs: readonly FeatureDocView[]
  /** 最近几条把关记录。她说过「这里改一改」,这一次不该再问一遍。 */
  reviews: readonly FeatureReviewEntry[]
  /** 她这一次额外补的一句(可空)。 */
  note?: string
  /**
   * Codex / Claude 现在派不派得出去(窗口槽里在不在、探没探到)。
   * `false` = 这一态该派出去的活由事务官自己顶着做,并在回话里说一句「代做」。
   */
  handsReady: boolean
  /** 派不出去的原因(原话)。拼进话里让事务官知道自己为什么要顶着。 */
  handsNote?: string
  /** 决策记录最后落在哪个文件(绝对路径)。记录那一态要说清楚。 */
  recordPath?: string
  /**
   * 他那句需求的原话(卡上的 `desc`)。**只用来挑确认点** —— 拼进复述那一句里,
   * 让事务官照着复述而不是自己编一句。没有就缺席(不编一句)。
   */
  need?: string
  /**
   * 这条需求过没过确认点(2026-09-23)。`false` = 她还没逐条点过头:
   * 梳理那一态先给确认点,**别的几态一律不许派活**。
   */
  confirmed: boolean
  /**
   * 候选确认点。不给就按 `need` 现挑(`featureConfirmPoints`)——
   * 传进来是为了让调用方能把"她上次改过的那几条"带上。
   */
  confirmPoints?: readonly ConfirmPoint[]
}

function reviewLine(one: FeatureReviewEntry): string {
  return deckReviewLine(one, tab => FEATURE_DOC_FILES[tab as FeatureDocTab])
}

/**
 * 「让事务官推进这一步」送出去的那段话。**纯函数**,一行 I/O 都没有。
 *
 * 结构逐字照抄选题那一份(`buildTopicRunPrompt`)—— 五件事,每一件都对应一种
 * "她得再交代一遍"的旧毛病。差别只在措辞与第五件(派给谁):
 *
 * 1. **接着已有的产物做**,不要重新问一遍背景;
 * 2. **哪一态、该做什么、产物落哪个文件**;
 * 3. **手上已经有什么**(四个页签的现状,不塞全文);
 * 4. **她已经说过什么**(把关记录原话);
 * 5. **派给谁 / 要不要代做**,以及记录那一态要落到哪个文件。
 */
export function buildFeatureRunPrompt(input: FeatureRunInput): string {
  const stage = featureStageOf(input.stage)
  const tab = FEATURE_STAGE_TAB[stage]
  const lines: string[] = []

  lines.push(`她在需求「${input.name}」的卡上点了「让事务官推进这一步」。`)
  lines.push(`现在这一态是「${stage}」:${FEATURE_STAGE_BRIEF[stage]}。产物落 ${FEATURE_DOC_FILES[tab]}。`)
  lines.push('')

  /**
   * 确认点那一段(2026-09-23,维护者 13:05)。摆在**最前面** —— 它是"要不要往下做"的门,
   * 不是做的时候顺带看一眼的东西。
   *
   * - 还没过 + 梳理这一态 → 照固定形状先问他;
   * - 还没过 + 后面几态 → 一句硬话:**这一步不要派活**(一次被曲解的需求派出去,
   *   几家 AI 做出来的全是错的那一版);
   * - 过了 → 这一整段缺席,话与加它之前逐字相同。
   */
  if (!input.confirmed) {
    lines.push(stage === '梳理'
      ? confirmInstruction({
          file: FEATURE_CONFIRM_FILE,
          ...(input.need === undefined || input.need.trim() === '' ? {} : { need: input.need }),
          points: input.confirmPoints ?? featureConfirmPoints(input.need ?? input.name),
        })
      : notConfirmedWarning(FEATURE_CONFIRM_FILE))
    lines.push('')
  }

  lines.push('★ 接着已有的产物往下做,**不要重新问她一遍背景**。她这一次没有再交代任何事,')
  lines.push('  因为该交代的都在下面这几行里了。缺了什么再问,**梳理这一态最多问两个问题**,一轮一问。')
  lines.push('')
  lines.push(`需求目录:${input.dir}`)
  if (input.project !== undefined && input.project.trim() !== '') {
    lines.push(`项目:${input.project.trim()}`)
  }
  if (input.projectPath !== undefined && input.projectPath.trim() !== '') {
    lines.push(`代码仓库:${input.projectPath.trim()} —— 要动代码就在这个仓库里动。`)
  }
  lines.push('')
  lines.push('这条需求现在有什么:')
  for (const doc of input.docs) lines.push(deckDocLine(doc))

  const recent = input.reviews.filter(one => one.action !== 'run').slice(-8)
  lines.push('')
  if (recent.length === 0) lines.push('她还没对任何一份产物把过关。')
  else {
    lines.push('她把过的关(最近几条,原话):')
    for (const one of recent) lines.push(reviewLine(one))
  }

  const hands = FEATURE_STAGE_HANDS[stage]
  lines.push('')
  if (!stageNeedsHands(stage)) {
    lines.push('这一态没有要派出去的活,你自己办。')
  }
  else if (!input.confirmed) {
    // 「他没答之前不派活」(维护者第 1 条逐字)。这一层从来不起活,所以这句话说给事务官听 ——
    // 它才是真去操作 Codex / Claude 那只手的人。
    lines.push('这一态本该派出去,但**这条需求还没过确认点,所以这一次一件都不要派**。')
    lines.push(`  先把 ${FEATURE_CONFIRM_FILE} 顶部那一节问完、让她点头,再回来派。`)
  }
  else {
    const who = hands.map(hand => FEATURE_HAND_TITLES[hand]).join(' / ')
    lines.push(`这一态要派出去:${who} —— 按 AGENTS.md 里「派活给别家Agent」那一节派`)
    lines.push(`  (先送进客户端窗口,送不进去再退到它那条命令行),派完把每件的去向写回 ${FEATURE_DOC_FILES[tab]}。`)
    lines.push('  **子事项里标的是谁就派给谁**,不要自作主张换一家,也不要自己把代码写了。')
    if (!input.handsReady) {
      const why = input.handsNote === undefined || input.handsNote.trim() === '' ? '现在派不出去' : input.handsNote.trim()
      lines.push(`★ **这一次派不出去**(${why})。这一步**你自己顶着做**,`)
      lines.push('  做完在回话里明说一句「这一版是我代做的」—— 不要假装是它们做的。')
    }
  }

  if (stage === '记录') {
    const where = input.recordPath === undefined || input.recordPath.trim() === ''
      ? `项目根下的 ${DECISION_RECORD_REL}`
      : input.recordPath.trim()
    lines.push('')
    lines.push(`${FEATURE_DOC_FILES.记录} 按这五行写,一行一件,**一个字都不要编**:`)
    for (const field of DECISION_FIELDS) lines.push(`- ${field.label}:…`)
    lines.push(`写完告诉她去卡上点「写进决策记录」—— 工作台会把它追加进 ${where},你不用自己去改那个文件。`)
  }

  if (input.note !== undefined && input.note.trim() !== '') {
    lines.push('')
    lines.push(`她这一次补了一句:「${input.note.trim()}」`)
  }

  lines.push('')
  lines.push(`做完把产物写进文件,然后回她一句人话(做了什么、要她看哪儿)。(工作台事项 ${input.taskId})`)
  return lines.join('\n')
}

/**
 * 「改一改」那一句怎么送给事务官。**带上是哪一份**,否则它只看得到一句没有主语的意见。
 * 与选题那边同一条取舍:打回不是"推进一步",上下文该短。
 */
export function buildFeatureReviseMessage(input: {
  name: string
  taskId: string
  tab: FeatureDocTab
  text: string
}): string {
  return [
    `她在需求「${input.name}」的 ${FEATURE_DOC_FILES[input.tab]} 上点了「改一改」,她说:`,
    `「${input.text.trim()}」`,
    '',
    `照这句改那一份,改完写回同一个文件,再回她一句「改了哪儿」。(工作台事项 ${input.taskId})`,
  ].join('\n')
}

/** 一态默认铺开哪几个页签。 */
export function tabsOfFeatureStage(stage: FeatureStage): readonly FeatureDocTab[] {
  return FEATURE_STAGE_TABS[featureStageOf(stage)]
}

/* ──────────────────────── 决策记录 ──────────────────────── */

/**
 * 决策记录那一条的四行(日期由工作台盖,不问事务官要 —— 它编得出昨天)。
 * **顺序就是文件里的顺序**,`key` 是解析结果的字段名,`label` 是文件里那一行的中文。
 */
export const DECISION_FIELDS = [
  { key: 'need', label: '需求' },
  { key: 'did', label: '做了什么' },
  { key: 'who', label: '谁做的' },
  { key: 'left', label: '遗留' },
] as const

export type DecisionFieldKey = typeof DECISION_FIELDS[number]['key']

export type DecisionEntry = Readonly<Record<DecisionFieldKey, string>>

/**
 * 从 `记录.md` 里把那四行捞出来。
 *
 * 宽进:行首的 `-` / `*` / `#` / `>` 与包在标签外的 `**` 都当装饰去掉,
 * 中英文冒号都认 —— 事务官写 markdown 的习惯每家不一样,为一个星号拒绝她的记录是荒唐的。
 *
 * 严出:**缺哪一行就说缺哪一行,一个字都不代它写**(同 `topicReview.ts` 第 1 条纪律)。
 * 一条自己编出来的「遗留:无」会变成半年后没人敢信的历史。
 */
export function parseDecisionEntry(text: string): { ok: true, entry: DecisionEntry } | { ok: false, missing: string[] } {
  const found = new Map<DecisionFieldKey, string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s>*#-]+/, '').trim()
    for (const field of DECISION_FIELDS) {
      if (found.has(field.key)) continue
      const match = new RegExp(`^\\*{0,2}${field.label}\\*{0,2}\\s*[::]\\s*(.*)$`).exec(line)
      const value = match?.[1]?.trim()
      if (value !== undefined && value !== '') found.set(field.key, value)
    }
  }
  const missing = DECISION_FIELDS.filter(field => !found.has(field.key)).map(field => field.label)
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    entry: Object.fromEntries(DECISION_FIELDS.map(field => [field.key, found.get(field.key) as string])) as DecisionEntry,
  }
}

/** `YYYY-MM-DD`(本地)。决策记录上那个日期是给人读的,不是给机器排序的 ISO。 */
export function recordDay(at: Date): string {
  const pad = (one: number): string => String(one).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * 决策记录里那一节长什么样。**一条一节**,标题带日期与需求名,底下四行。
 *
 * 与本仓库 `docs/决策记录.md` 的写法对齐(一条一段);写进的是**她自己项目**的那一份,
 * 不是我们这个仓库的那一份。
 */
export function formatDecisionSection(input: { day: string, name: string, entry: DecisionEntry }): string {
  const lines = [`## ${input.day} ${input.name}`, '']
  for (const field of DECISION_FIELDS) lines.push(`- ${field.label}:${input.entry[field.key]}`)
  return `${lines.join('\n')}\n`
}

/** 决策记录文件的相对路径合不合法。**必须是相对路径、不许拐弯、必须是 .md**。 */
export function isSafeRecordRel(rel: string): boolean {
  if (typeof rel !== 'string') return false
  const trimmed = rel.trim()
  if (trimmed === '' || trimmed.length > 200) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:/.test(trimmed)) return false
  if (trimmed.split(/[/\\]/).some(part => part === '' || part === '.' || part === '..')) return false
  return trimmed.endsWith('.md')
}

export interface AppendDecisionResult {
  ok: boolean
  /** 写到哪个文件(绝对路径)。出错时也带上 —— 她要知道我们本来想写哪儿。 */
  path: string
  /** 这一次真写了没有。`false` + `ok:true` = 一模一样的一节已经在里面了。 */
  added?: boolean
  reason?: string
}

/**
 * 把一条结论追加进她项目的决策记录。
 *
 * 三条纪律(前两条逐字照 `topicReview.ts`,第三条是这张卡的):
 *
 * 1. **只追加不覆盖**。文件不在就建(连同 `docs/`),在就在末尾接一节;
 * 2. **一模一样的一节不写第二遍** —— 同一个「写进决策记录」点两下不该出现两条;
 * 3. **绝不碰我们自己仓库的那一份**。写哪儿只由调用方给的项目根决定,
 *    这个函数里没有任何默认路径可以让它漂到别处去。
 */
export async function appendDecisionRecord(input: {
  projectPath: string
  rel?: string
  day: string
  name: string
  entry: DecisionEntry
}): Promise<AppendDecisionResult> {
  const rel = input.rel === undefined || input.rel.trim() === '' ? DECISION_RECORD_REL : input.rel.trim()
  if (!isSafeRecordRel(rel)) {
    return { ok: false, path: rel, reason: '决策记录的路径要是项目里的一个相对 .md 路径,不能带 .. 也不能是绝对路径' }
  }
  const path = join(input.projectPath, rel)
  const section = formatDecisionSection({ day: input.day, name: input.name, entry: input.entry })

  let before: string | undefined
  try { before = await readIfThere(path) }
  catch (error) { return { ok: false, path, reason: `读不了 ${rel}:${(error as Error).message}` } }

  if (before !== undefined && before.includes(section.trimEnd())) {
    return { ok: true, path, added: false }
  }

  try {
    await mkdir(join(path, '..'), { recursive: true })
    if (before === undefined) {
      await writeFile(path, `# 决策记录\n\n${section}`, 'utf8')
    }
    else {
      const gap = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
      await writeFile(path, `${gap}${section}`, { encoding: 'utf8', flag: 'a' })
    }
  }
  catch (error) {
    return { ok: false, path, reason: `写不进 ${rel}:${(error as Error).message}` }
  }
  return { ok: true, path, added: true }
}

/** 读 `记录.md` 的原文。不存在回 undefined(**不是错**:那一态还没做而已)。 */
export async function readFeatureRecordDraft(dir: string): Promise<string | undefined> {
  return readFile(join(dir, FEATURE_DOC_FILES.记录), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

/** 这条需求此刻在哪一态(缺省 = 梳理)。 */
export function featureStageOfTask(stage: FeatureStage | undefined): FeatureStage {
  return stage === undefined ? DEFAULT_FEATURE_STAGE : featureStageOf(stage)
}

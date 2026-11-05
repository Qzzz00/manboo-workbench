/**
 * 选题卡 = 指挥台(2026-09-22,`docs/设计-运营事务官指挥做事-2026-09-22.md` 第一节那张表)。
 *
 * `topicAssets.ts` 回答的是"这条选题有哪些**素材**";这个文件回答另外三件事:
 *
 * 1. **产物回到卡上** —— 七个页签各自读 `选题/<名>/` 里那一份文件,能看能改(改了写回文件);
 * 2. **每一轮改了什么** —— 存一份上一版(`修订/`),段落级 diff 现算;
 * 3. **把关留痕** —— 三键各写一行 `审核记录.jsonl`,追加,永不改写。
 *
 * 外加一件不落盘的:**拼那段交给事务官的话**(`buildTopicRunPrompt`)。
 *
 * ## 2026-09-22 夜之后:上面那 1–3 已经搬进 `deckRun.ts`
 *
 * 需求卡(做产品模板)要的是**同一个东西**(审视第三节:「两条模板要的是同一个东西 ——
 * 卡 = 指挥台」)。所以读写产物、`修订/` 快照、段落级 diff、`审核记录.jsonl`
 * 这些两种卡一字不差的部分搬去了 `deckRun.ts`,这个文件**只剩选题自己那三样**:
 * 哪几个页签落哪几个文件、哪一段按哪份技能派给谁、那段话怎么拼。
 *
 * 对外的 API 与行为**一个字没变**:下面那几个函数照旧从这里导出
 * (`readTopicDocs` / `saveTopicDoc` / `appendTopicReview` / `readTopicReviews` 等),
 * 只是实现换成了调用通用那一份。
 *
 * ## 为什么「让事务官推进这一步」不在这里起任何活
 *
 * 设计第一节的规矩逐字:「指挥的入口**只有两个**:卡上的按钮,或对事务官说一句;
 * 两条路进的是**同一个口**」。所以这一层只做两件事 —— 把上下文拼成一段话,
 * 交给事务官那条会话(`/butler/item/say` 用的同一个 `butlerSession.say`)。
 *
 * 真正派给 GPT / 豆包 / Claude 是**事务官在它那条会话里**按《运营-给AI分发任务》做的事
 * (它去调 `/dispatch/api` 或窗口那只手,再 `POST /butler/item/dispatch` 报进度)。
 * 这一层要是也能派活,同一件事就有两条路能起进程了 —— 与 `createButlerItem`
 * 不在 HTTP 层 spawn 是同一条纪律。
 *
 * ## 目录约定(沿用 topicAssets.ts 文件头那一份,只多两处)
 *
 * ```
 * 选题/<选题名>/
 *   框架.md 初稿.md 定稿.md 素材清单.md 查词.md 发布包装.md 复盘.md   ← 七个页签读写的就是它们
 *   审核记录.jsonl        ← 把关留痕(一行一条 TopicReviewEntry)
 *   修订/<文件名>.<时刻>  ← 每次写回之前把上一版留一份,diff 拿它比
 *   素材/                 ← topicAssets.ts 管的那一格
 * ```
 *
 * `修订/` 与 `审核记录.jsonl` 都**不会**出现在素材清单里:`listTopicAssets` 只读
 * `选题/<名>/素材/` 与七类素材库,选题目录根上的文件它一个都不列。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  TopicDocTab, TopicDocView, TopicPhase, TopicReviewEntry, TopicStage,
} from '../protocol.ts'
import type { EvolveReviewSay } from './evolve.ts'
import {
  DEFAULT_TOPIC_STAGE, DISPATCH_FAMILY_TITLES, TOPIC_DOC_TABS, TOPIC_PHASE_TABS, topicPhaseOf,
} from '../protocol.ts'
import { TOPIC_DELIVERABLE_FILES } from '../templates.ts'
import type { SaveDeckDocResult } from './deckRun.ts'
import {
  appendDeckReview, deckConfirmed, deckDocLine, deckReviewLine, lastConfirmEntry,
  lastRunEntry as lastDeckRunEntry, readDeckDocs, readDeckReviews, saveDeckDoc,
} from './deckRun.ts'
import type { ConfirmPoint } from './confirmPoints.ts'
import { buildConfirmPoints, confirmInstruction, notConfirmedWarning } from './confirmPoints.ts'

/**
 * 通用那一半原样再导出一次(`deckRun.ts`)。**不是包一层**,是同一个符号 ——
 * 既有的调用方与用例一个字不用改,而定义仍然只有一处。
 */
export {
  DIFF_MAX_PARAGRAPHS, REVIEW_LOG_NAME, REVISIONS_DIR, REVIEW_TAIL,
  diffHasChange, diffParagraphs, revisionStamp, splitParagraphs,
} from './deckRun.ts'

/**
 * 页签 → 文件名。**六段那六个一律走 `TOPIC_DELIVERABLE_FILES`**,不在这里敲第二份字面量
 * (`tests/ops-skills-topic-files-guard.test.ts` 钉的就是"只许有一份"这件事)。
 *
 * 第七个 `合规查词` → `查词.md` 是**这里唯一的字面量**,因为它故意不在那张六段表里
 * (合规查词改一版查一次,不对应任何一段;守卫用例的白名单里写着这条理由)。
 */
export const TOPIC_DOC_FILES: Readonly<Record<TopicDocTab, string>> = {
  框架: TOPIC_DELIVERABLE_FILES.灵感,
  初稿: TOPIC_DELIVERABLE_FILES.初稿,
  定稿: TOPIC_DELIVERABLE_FILES.制作中,
  素材清单: TOPIC_DELIVERABLE_FILES.准备素材,
  合规查词: '查词.md',
  发布包装: TOPIC_DELIVERABLE_FILES.发布,
  复盘: TOPIC_DELIVERABLE_FILES.复盘,
}

/**
 * 确认点写进哪一份(2026-09-23,维护者:「不能假装自己搞懂了」)。
 *
 * 选题卡是 `框架.md` —— 「构思」那一态的产物,也是"这条选题到底要讲什么"那一份。
 * 与需求卡的 `需求.md` 同一个位置(顶部那一节),同一份规则。
 */
export const TOPIC_CONFIRM_TAB: TopicDocTab = '框架'
export const TOPIC_CONFIRM_FILE = TOPIC_DOC_FILES['框架']

/** 这条选题过没过确认点。判据在 `审核记录.jsonl`。 */
export function topicConfirmed(entries: readonly TopicReviewEntry[]): boolean {
  return deckConfirmed(entries)
}

/** 最后那一次过确认点是什么时候、她改了哪几条。 */
export function lastTopicConfirm(entries: readonly TopicReviewEntry[]): TopicReviewEntry | undefined {
  return lastConfirmEntry(entries)
}

/** 按这句想法挑几条确认点。**规则只有一份**(`confirmPoints.ts`)。 */
export function topicConfirmPoints(need: string): ConfirmPoint[] {
  return buildConfirmPoints({ need })
}

/** 这一段的产物落在哪个页签上。「让事务官推进这一步」的留痕记的就是它。 */
export const TOPIC_STAGE_TAB: Readonly<Record<TopicStage, TopicDocTab>> = {
  灵感: '框架',
  初稿: '初稿',
  准备素材: '素材清单',
  制作中: '定稿',
  发布: '发布包装',
  复盘: '复盘',
}

/**
 * 这一段按**哪一份技能**做(设计第一节那张表第二列)。名字逐字等于 `OPS_SKILLS` 里那一条
 * ——事务官的 AGENTS.md 里那个标记段就叫这个名字,拼进话里它才找得到。
 * 有一条用例钉着这七个名字在 `OPS_SKILLS` 里都找得到。
 */
export const TOPIC_STAGE_SKILL: Readonly<Record<TopicStage, string>> = {
  灵感: '运营-想法梳理与内容框架',
  初稿: '运营-初稿定稿',
  准备素材: '运营-素材准备清单',
  制作中: '运营-初稿定稿',
  发布: '运营-发布包装',
  复盘: '运营-复盘',
}

/**
 * 这一段按白板分工**派给谁**(设计第一节那张表第三列)。空数组 = 事务官自己办。
 *
 * 「发布」那一段是空的:排期与点「已发布」是她的事,没有任何一家 AI 要做的活。
 */
export const TOPIC_STAGE_HANDOFF: Readonly<Record<TopicStage, readonly ('gpt' | 'doubao' | 'claude')[]>> = {
  灵感: ['claude'],
  初稿: ['gpt', 'doubao'],
  准备素材: [],
  制作中: ['gpt', 'doubao'],
  发布: [],
  复盘: ['claude'],
}

/** 走接口那两家。发不出去时这一段的活由事务官自己顶着做,卡上标「代做」。 */
const API_FAMILIES: readonly string[] = ['gpt', 'doubao']

/** 这一段要不要经中转派给 GPT / 豆包。要 = 发不出去时才谈得上「代做」。 */
export function stageNeedsRelay(stage: TopicStage): boolean {
  return TOPIC_STAGE_HANDOFF[stage].some(family => API_FAMILIES.includes(family))
}

/* ──────────────────────── 读写产物(实现在 deckRun.ts)──────────────────────── */

/** 七个页签一次全读回来。 */
export async function readTopicDocs(dir: string): Promise<TopicDocView[]> {
  return readDeckDocs(dir, TOPIC_DOC_TABS, TOPIC_DOC_FILES)
}

export type SaveTopicDocResult = SaveDeckDocResult

/** 把一份产物写回文件(顺手存上一版、回这一轮的 diff)。 */
export async function saveTopicDoc(input: {
  dir: string
  tab: TopicDocTab
  text: string
  now: Date
}): Promise<SaveTopicDocResult> {
  return saveDeckDoc({ dir: input.dir, file: TOPIC_DOC_FILES[input.tab], text: input.text, now: input.now })
}

/* ──────────────────────── 把关留痕(实现在 deckRun.ts)──────────────────────── */

/** 往 `审核记录.jsonl` 追加一行。 */
export async function appendTopicReview(
  dir: string, entry: TopicReviewEntry,
): Promise<{ ok: true } | { ok: false, reason: string }> {
  return appendDeckReview(dir, entry)
}

/** 读把关记录(**最近的在最后**,与文件里的顺序一致)。 */
export async function readTopicReviews(dir: string, tail?: number): Promise<TopicReviewEntry[]> {
  return readDeckReviews<TopicReviewEntry>(dir, tail)
}

/** 最后一次「让事务官推进」是什么时候。卡上的「排队 / 在做」要靠它算。 */
export function lastRunEntry(entries: readonly TopicReviewEntry[]): TopicReviewEntry | undefined {
  return lastDeckRunEntry(entries)
}

/* ──────────────────────── 交给事务官的那段话 ──────────────────────── */

export interface TopicRunInput {
  /** 选题名(= 卡的标题,也是目录名)。 */
  name: string
  /** 这条选题所在的看板卡 id。事务官报派活进度时要用它。 */
  taskId: string
  stage?: TopicStage
  /** 归哪个账号(项目名)。没挂账号就缺席 —— **不编一个**。 */
  account?: string
  /** `选题/<名>/` 的绝对路径。 */
  dir: string
  /** 七个页签此刻各自有没有、多长。由 `readTopicDocs` 给。 */
  docs: readonly TopicDocView[]
  /** 最近几条把关记录。她说过「这里改一改」,这一次不该再问一遍。 */
  reviews: readonly TopicReviewEntry[]
  /** 她这一次额外补的一句(可空)。 */
  note?: string
  /**
   * GPT / 豆包现在派不派得出去。`false` = 这一段该派出去的活由事务官自己顶着做,
   * 并在回话里说一句「代做」(设计第四节第 4 条)。
   */
  relayReady: boolean
  /** 派不出去的原因(原话)。拼进话里让事务官知道自己为什么要顶着。 */
  relayNote?: string
  /**
   * 她说过不止一次的偏好,一条一行(2026-09-23,自进化最小闭环;`evolve.preferenceLines()`)。
   * **只有攒够依据的才在这里**:一条选题上说一次的意见走上面 `reviews` 那一段,只对这条选题说。
   * 空 = 这一段整段缺席,话与加它之前逐字相同。
   */
  preferences?: readonly string[]
  /**
   * 她那句原话(想法梳理那一态就是她抛来的那个想法)。**只用来挑确认点**,
   * 并拼进复述那一句里 —— 让事务官照着复述,而不是自己编一句。
   */
  need?: string
  /**
   * 这条选题过没过确认点(2026-09-23)。`false` = 她还没逐条点过头:
   * 构思那一态先给确认点,**后面几段一律不许派活**。
   */
  confirmed: boolean
  /** 候选确认点。不给就按 `need` 现挑。 */
  confirmPoints?: readonly ConfirmPoint[]
}

/** 一份产物在话里怎么点名。**不塞全文**:事务官自己会去读文件,塞全文只会把这段话撑爆。 */
const docLine = deckDocLine

/** 一条把关记录在话里怎么写。 */
function reviewLine(one: TopicReviewEntry): string {
  return deckReviewLine(one, tab => TOPIC_DOC_FILES[tab as TopicDocTab])
}

/**
 * 「让事务官推进这一步」送出去的那段话。**纯函数**,一行 I/O 都没有 —— 用例直接对着字符串断言。
 *
 * 五件事按这个顺序说,每一件都对应一种"她得再交代一遍"的旧毛病:
 *
 * 1. **接着上一段的产物做**(设计第〇节:「不要求她再交代一遍」);
 * 2. **哪一段、按哪份技能** —— 否则它会从头问三个问题;
 * 3. **手上已经有什么** —— 否则它会重写一份已经定稿的东西;
 * 4. **她已经说过什么**(把关记录)—— 否则同一处会被打回两次;
 * 5. **派给谁 / 要不要代做** —— 否则它要么不派,要么在派不出去时卡住。
 */
export function buildTopicRunPrompt(input: TopicRunInput): string {
  const stage = input.stage ?? DEFAULT_TOPIC_STAGE
  const phase: TopicPhase = topicPhaseOf(stage)
  const tab = TOPIC_STAGE_TAB[stage]
  const lines: string[] = []

  lines.push(`她在选题「${input.name}」的卡上点了「让事务官推进这一步」。`)
  lines.push(`现在这一段是「${stage}」(工作状态:${phase}),按技能《${TOPIC_STAGE_SKILL[stage]}》做,产物落 ${TOPIC_DOC_FILES[tab]}。`)
  lines.push('')

  /**
   * 确认点那一段(2026-09-23,维护者 13:05)。与需求卡逐字同一套:
   * 还没过 + 构思这一态 → 照固定形状先问;还没过 + 后面几段 → 一句硬话,不许派活;
   * 过了 → 这一整段缺席,话与加它之前逐字相同。
   */
  if (!input.confirmed) {
    lines.push(phase === '构思'
      ? confirmInstruction({
          file: TOPIC_CONFIRM_FILE,
          ...(input.need === undefined || input.need.trim() === '' ? {} : { need: input.need }),
          points: input.confirmPoints ?? topicConfirmPoints(input.need ?? input.name),
        })
      : notConfirmedWarning(TOPIC_CONFIRM_FILE))
    lines.push('')
  }

  lines.push('★ 接着已有的产物往下做,**不要重新问她一遍背景**。她这一次没有再交代任何事,')
  lines.push('  因为该交代的都在下面这几行里了。缺了什么再问,但一次只问一个问题。')
  lines.push('')
  lines.push(`选题目录:${input.dir}`)
  if (input.account !== undefined && input.account.trim() !== '') {
    lines.push(`账号:${input.account.trim()} —— 动手之前先读 账号/${input.account.trim()}/账号.md 的定位 / 风格 / 人群 / 平台。`)
  }
  lines.push('')
  lines.push('这条选题现在有什么:')
  for (const doc of input.docs) lines.push(docLine(doc))

  const recent = input.reviews.filter(one => one.action !== 'run').slice(-8)
  lines.push('')
  if (recent.length === 0) lines.push('她还没对任何一份产物把过关。')
  else {
    lines.push('她把过的关(最近几条,原话):')
    for (const one of recent) lines.push(reviewLine(one))
  }

  // 偏好那一段(2026-09-23)。摆在「她把过的关」之后、派活之前:先知道她要什么,再知道派给谁。
  const preferences = (input.preferences ?? []).filter(line => line.trim() !== '')
  if (preferences.length > 0) {
    lines.push('')
    lines.push('★ 她在不止一条选题上打回过同一处 —— 这几条是她的偏好,**先照它做,不用她再交代**:')
    for (const line of preferences) lines.push(`- ${line}`)
    lines.push('  (标「试用中」的这一次做完由她把关来验:通过就保留,又打回同一处工作台会自己撤。)')
  }

  const handoff = TOPIC_STAGE_HANDOFF[stage]
  lines.push('')
  if (handoff.length === 0) {
    lines.push('这一段没有要派出去的活,你自己办。')
  }
  else if (!input.confirmed) {
    // 「他没答之前不派活」(维护者第 1 条)。这一层从来不起活,所以这句话说给事务官听。
    lines.push('这一段本该派出去,但**这条选题还没过确认点,所以这一次一家都不要派**。')
    lines.push(`  先把 ${TOPIC_CONFIRM_FILE} 顶部那一节问完、让她点头,再回来派。`)
  }
  else {
    const who = handoff.map(family => DISPATCH_FAMILY_TITLES[family]).join(' / ')
    lines.push(`这一段白板上分给:${who} —— 按《运营-给AI分发任务》派,派完把它回的那段话落进 ${TOPIC_DOC_FILES[tab]}。`)
    if (stageNeedsRelay(stage) && !input.relayReady) {
      const why = input.relayNote === undefined || input.relayNote.trim() === '' ? '现在发不出去' : input.relayNote.trim()
      lines.push(`★ **GPT / 豆包 这一次派不出去**(${why})。这一步**你自己顶着做**,`)
      lines.push('  做完在回话里明说一句「这一版是我代做的」—— 不要假装是它们写的。')
    }
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
 *
 * 与 `buildTopicRunPrompt` 分开而不是复用它:打回不是"推进一步",上下文该短 ——
 * 它手上刚做完那一份,要的只是"哪儿不对、怎么改"。
 */
export function buildTopicReviseMessage(input: {
  name: string
  taskId: string
  tab: TopicDocTab
  text: string
}): string {
  return [
    `她在选题「${input.name}」的 ${TOPIC_DOC_FILES[input.tab]} 上点了「改一改」,她说:`,
    `「${input.text.trim()}」`,
    '',
    `照这句改那一份,改完写回同一个文件,再回她一句「改了哪儿」。(工作台事项 ${input.taskId})`,
  ].join('\n')
}

/**
 * 把**所有**选题的 `审核记录.jsonl` 读成一份跨选题的记录(2026-09-23,进化循环偏好那一截)。
 *
 * 目录不在 / 某一条读不了 → **安静跳过**(同 `readReviewLogs` 那条「读不到不等于出错」)。
 * 选题名 = 目录名。一条选题最多读 `PREF_REVIEW_TAIL` 行:偏好看的是近 30 天,再往前的行没用。
 */
export const PREF_REVIEW_TAIL = 2000

export async function readAllTopicReviews(topicsDir: string): Promise<EvolveReviewSay[]> {
  let names: string[]
  try {
    names = (await readdir(topicsDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'))
  }
  catch { return [] }
  const out: EvolveReviewSay[] = []
  for (const name of names) {
    let entries: TopicReviewEntry[]
    try { entries = await readTopicReviews(join(topicsDir, name), PREF_REVIEW_TAIL) }
    catch { continue }
    for (const one of entries) {
      out.push({ topic: name, tab: one.tab, action: one.action, at: one.at, ...(one.text === undefined ? {} : { text: one.text }) })
    }
  }
  return out
}

/** 一态默认铺开哪几个页签。界面用;放这里是为了服务端拼话时能说得出"她现在看的是哪几份"。 */
export function tabsOfPhase(phase: TopicPhase): readonly TopicDocTab[] {
  return TOPIC_PHASE_TABS[phase]
}

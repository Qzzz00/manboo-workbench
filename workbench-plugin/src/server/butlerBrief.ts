/**
 * **第一条消息里先把工作台已经知道的事实摆上**(2026-10-02,卡「事务官为什么要跑这么多步」)。
 *
 * ## 为什么有这一处(维护者 10-02:「不要从调整配置这种修补丁的角度去想,而去问为什么」)
 *
 * 把本机真实的事务官会话逐步拆开数过一遍(`~/.dsh/sessions/--Users-ben-Documents-~5DE5~4F5C~53F0--/`
 * 下的 `session.v4.jsonl.zstd`,逐步表见 `docs/交接-1002-事务官为什么要跑这么多步.md`):
 *
 * | 会话 | 她说的 | 步 | 工具 | 其中在干活 |
 * |---|---|---|---|---|
 * | `9c37bdd9`(09-26 16:40) | 「来来来。」 | 6 | 9 | **0** |
 * | `10e74661`(09-27 21:17) | 「给 Minus 发个信息,让 Minus 去做:问他国庆节…放几天」 | 13 | 25 | **0** |
 * | `c20c5ac1`(09-26 下班例程) | — | 23 | 92 | 49(43 次在找东西) |
 *
 * 两件简单事 **34 次工具调用、一次都不在干活**。拆开看,34 次全在回答同样四个问题:
 *
 * 1. **这张卡写的什么** —— 第一条消息只给了 `(工作台事项 t-13a68d85)` 一个 id。
 *    于是 `9c37bdd9` 第 1 步 `curl /butler/item?id=…`(这个口不存在)、第 2–3 步挨个试探
 *    `/item/…` `/butler/items` `/butler/state` `/api/items` `/items` `/butler/todos` `/todos`
 *    `/butler/board` `/board` `/health` `/` **13 个口**,第 4–6 步直接去读 `~/.dsh/workbench/tasks.json`。
 * 2. **这台机器上有谁能派** —— `10e74661` 为了「Minus 是哪一家」跑了 12 步:
 *    `grep -rni minus` 遍 workspace、遍 `~/.dsh`、`ls /Applications`、`ps aux`、`list_mcp_resources`,
 *    最后仍然只能猜「我先按『你说的是 Manus』理解」。而这台机器上能派谁、哪几家读不到窗口,
 *    **工作台这一侧是数出来的**(`dispatchTargetsNow()` / `unreadableAppsNow()`)。
 * 3. **工作台的口在哪** —— 见 1 的 13 次试探。
 * 4. **技能正文在哪** —— `9c37bdd9` 第 1–2 步 `ls ~/.dsh/skills`、`ls <工作目录>/.dsh/skills`、
 *    `cat …/记忆/SKILL.md`;`10e74661` 第 4–5 步同样。
 *
 * **四个问题工作台全都已经有答案**,却让模型一步一步去问机器。这不是「步数上限该调成几」的事
 * (那是 10-02 那张卡做的「自动续两档」,维护者当天就纠正了:调配置不算答案),
 * 根在**我们交代活的方式**:给的是指针,不是事实。
 *
 * ## 规矩
 *
 * - **只摆工作台数出来的**:卡的标题、项目、能派的几家、读不到的几家、这台服务真在听的地址、
 *   该读哪一份技能正文。**一个数都不编**:工作台不知道的那一行**整行不出现**(D13),
 *   不写「未知」、不写一个猜的地址(卡 SP 那一处的病正是写死 8791 打到了别人家的服务上)。
 * - **不经模型**:整段由代码从固定模板拼出。
 * - **不替它做判断**:事实摆完就完,办不办、怎么办还是它的事;「先问我」那一套规矩一个字没改。
 *
 * 这个文件**只有纯函数**:facts 从哪儿来是 `http.ts` / `materializeService.ts` 那一侧的事。
 */
import type { TaskAssignee } from '../protocol.ts'
import { isPersonAssignee } from '../protocol.ts'
import { WB_SKILL_DISPATCH, WB_SKILL_SEND_FILE } from './hooksApply.ts'

/** 能派的一家:只要名字与家名两样(别的字段摆给模型只会多出一堆它用不上的话)。 */
export interface BriefFamily {
  id: string
  title: string
}

/** 读不到窗口、派不了的一家(`dispatchTargets.ts` 的 `UnreadableApp` 的子集)。 */
export interface BriefUnreadable {
  id: string
  name: string
}

/** 该读哪一份技能正文。 */
export interface BriefSkill {
  /** 段名 / 技能名(与 AGENTS.md 里那个标记段逐字相同)。 */
  name: string
  /** 正文落在哪(绝对路径)。 */
  file: string
}

export interface ButlerBriefFacts {
  itemId: string
  /** 卡面标题(工作台刚建的那张卡,已经在手上)。 */
  title: string
  /** 这件事挂在哪个项目。工作台不知道就缺席。 */
  project?: string
  /** 此刻真派得出去的几家。缺席 = 这一侧没接上(不是"一家都没有"),整行不出现。 */
  dispatchable?: readonly BriefFamily[]
  /** 认出是 AI 应用、可那扇窗读不到、派不了的几家。 */
  unreadable?: readonly BriefUnreadable[]
  /** 这台服务真在听的地址(`serviceBaseUrl`)。**调用方必须给真地址**,这里不兜底。 */
  baseUrl?: string
  /** 这件事会用到的几个口(调用方按这件事的类型给,不在这里猜)。 */
  endpoints?: readonly string[]
  /** 该读哪一份技能正文(`butlerSkillForItem`)。 */
  skill?: BriefSkill
  /**
   * ★ **这件事要把一个文件送到她手机上**(2026-10-04,卡 `claude/phone-file-send-loop`)。
   *
   * 10-04 早那一件:她说「官网逐字稿,这份文件发到我这个手机上。」,第一条消息里**一个字都没提**
   * 「怎么把文件送到手机」—— 事务官手里也确实没有这件工具,于是它去 grep 工作台自己的源码
   * (`http.ts` / `fileFetch.ts` / `devTool.ts`),两轮十几步、都 `aborted`,第三轮把文件拷进
   * 事务官文件夹、叫她「再打一句『把官网逐字稿发我』」。
   *
   * 现在工作台有正规的那一下(`POST /butler/send-file`),所以这一行把它摆上:
   * 找什么、送到哪台、走哪个口、**不许去读工作台源码找办法**。
   */
  fileWant?: { query?: string, device: string }
}

/**
 * 末尾那一句。**明说「不用再翻」**——
 * 光把事实摆上还不够:`10e74661` 第 1 步手里已经有 `/state` 的回包了,照样又 grep 了 11 步。
 */
export const BUTLER_BRIEF_NO_SEARCH
  = '上面这些是工作台数出来的,不用再翻盘、翻目录、试接口去问一遍。'

/** 按需读记忆那一句(与 `butlerItem.ts` 的 `BUTLER_MEMORY_HINT` 同一句,不另造)。 */
export const BUTLER_BRIEF_MEMORY
  = '真缺一条背景再按 .dsh/skills/记忆/SKILL.md 查跟这件事有关的那一条,别为它把记忆通读一遍;小事直接办。'

/**
 * 这件事归哪一条技能。**只在工作台已经确定的时候点名**:
 * 她点名了别家 = 派活那一条(与 `butlerFirstMessage` 加「按那一节办」那一句同一个判据)。
 * 没点名、它自己办、负责人是人 → **不点名任何一条**(让它照 AGENTS.md 那份索引自己认,不替它猜)。
 */
export function butlerSkillForItem(input: { assignee?: TaskAssignee, skillFile?: (name: string) => string, fileWant?: boolean }): BriefSkill | undefined {
  const { assignee } = input
  // ★ 要文件那一类:这一段比"派给谁"更要紧(2026-10-04)—— 它要的就是这一下,别的技能都不沾边。
  if (input.fileWant === true) {
    const file = input.skillFile?.(WB_SKILL_SEND_FILE)
    return file === undefined ? undefined : { name: WB_SKILL_SEND_FILE, file }
  }
  if (assignee === undefined || assignee === 'dsh') return undefined
  if (isPersonAssignee(assignee)) return undefined
  const file = input.skillFile?.(WB_SKILL_DISPATCH)
  return file === undefined ? undefined : { name: WB_SKILL_DISPATCH, file }
}

/**
 * 要文件那一行。**只摆工作台数出来的**:她的原话里要找的是什么、送到哪一台、走哪个口。
 * 「不许去读工作台源码找办法」那一句不是客套 —— 10-04 那两轮 `aborted` 全花在这件事上。
 */
export function fileWantLine(want: { query?: string, device: string }): string {
  const what = want.query === undefined || want.query.trim() === '' ? '' : `要找的是「${want.query.trim()}」;`
  return `${FILE_WANT_BRIEF_HEAD}:${what}送到「${want.device}」。`
    + `只走 POST /butler/send-file {"item":"<这张卡的 id>","query":"<要找的那个名字>"} —— `
    + '它替你找文件、开取件单、把「点一下就到手」那张卡推到她手机上,回包里写清找到几个。'
    + '找不到 / 找到多份拿不准:**一次只问她一句**「是 A 还是 B」,别自己挑一个。'
    + '**不许去读工作台自己的源码找别的办法,也不许把文件拷到某个目录就算送到了** —— '
    + '没有传输回执,这件事就不算办完。'
}

/** 那一行的开头。界面与用例都用这一份(断言不逐字抄中文)。 */
export const FILE_WANT_BRIEF_HEAD = '这件事要把一个文件送到她手机上'

function familiesLine(facts: ButlerBriefFacts): string | undefined {
  const can = facts.dispatchable
  if (can === undefined) return undefined
  // 一家都派不了也要说出口 —— 留一句空名单,它就会自己去找(`10e74661` 那 12 步)。
  if (can.length === 0) return '这台电脑此刻一家都派不了(派活候选是空的)。'
  return `这台电脑此刻能派的:${can.map(one => `${one.title}(${one.id})`).join('、')}。`
}

function unreadableLine(facts: ButlerBriefFacts): string | undefined {
  const bad = facts.unreadable
  if (bad === undefined || bad.length === 0) return undefined
  return `认出是 AI 应用、可那扇窗读不到、**派不了**的:${bad.map(one => `${one.name}(${one.id})`).join('、')}。`
}

/**
 * 摆事实那一段。顺序是「这张卡 → 这台机器 → 这几个口 → 这一份正文 → 别再翻了」,
 * 与那 34 次工具调用问的四个问题一一对应。
 */
export function butlerBriefBlock(facts: ButlerBriefFacts): string {
  const lines: string[] = [
    `(工作台事项 ${facts.itemId} · 这张卡工作台已经建好了,标题「${facts.title}」,不用再去查一遍。)`,
  ]
  if (facts.project !== undefined && facts.project !== '') lines.push(`这件事挂在项目:${facts.project}。`)
  const families = familiesLine(facts)
  if (families !== undefined) lines.push(families)
  const unreadable = unreadableLine(facts)
  if (unreadable !== undefined) lines.push(unreadable)
  if (facts.baseUrl !== undefined && facts.baseUrl !== '') {
    const ports = facts.endpoints === undefined || facts.endpoints.length === 0
      ? ''
      : `,这件事会用到的口:${facts.endpoints.join('、')}`
    lines.push(`工作台在 ${facts.baseUrl}${ports}。`)
  }
  /**
   * 要文件那一类那一行(2026-10-04)。摆在"这几个口"之后、技能正文之前:
   * 口在哪已经说了,这一行说**这件事就用那一个口**,外加一条禁令。
   */
  if (facts.fileWant !== undefined) lines.push(fileWantLine(facts.fileWant))
  if (facts.skill !== undefined) {
    lines.push(`按《技能:${facts.skill.name}》办,正文在 ${facts.skill.file} —— 只读这一份,别的技能正文跟这件事无关。`)
  }
  lines.push(BUTLER_BRIEF_NO_SEARCH)
  lines.push(BUTLER_BRIEF_MEMORY)
  return lines.join('\n')
}

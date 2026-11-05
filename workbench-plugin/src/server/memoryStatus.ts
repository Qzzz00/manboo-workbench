/**
 * `来自-<家>/来源.md` 顶上那一小块「这一家到哪了」(2026-09-27,并入闭环那张卡)。
 *
 * ## 为什么要有它
 *
 * 09-26 晚上真实发生过一次:代码收了 59 份、提交了;事务官会话从 20:36 起逐份并,并到第 23 份时
 * 工作台重启、会话中途没了 —— 它的计划是「全部并完 → 最后写台账 → 最后一次 commit」,于是
 * `已并入.md` 一行都没有、并好的 6 个文件一直没提交、第二天谁也看不出发生过什么。
 *
 * 所以仓库里得有一处**看一眼就知道进度**的地方,而且**由代码写**(模型活不到最后也照样有):
 * 收了几份、并了几份、还差几份、最近一次并入是哪天。写在 `来源.md` 顶上 ——
 * 那本来就是「这一家的门口」,Ben 点进去第一眼看到的就是它。
 *
 * ## 三条纪律
 *
 * 1. **用人话**:不出现指纹、不出现英文键名。这一段是给 Ben 看的,不是给程序读的。
 * 2. **注释标记包住**:`importAgentMemories` 每次收都整篇重写 `来源.md`,靠这两行标记
 *    把上一版的状态块**接回去**(见 agentMemory.ts);状态块本身也就不怕被收覆盖。
 * 3. **「最近一次收」那一行归收的那一步管,别的行归收尾检查管。** 这不是洁癖:
 *    收尾检查每 10 分钟跑一次,它自己写 `来源.md` 会把文件 mtime 顶到现在 ——
 *    要是「最近一次收」的时刻取自 mtime,那每一轮都会算出一个新时刻、每一轮都要重写一遍,
 *    一天几十个空 commit。所以那一行**由收的那一步写死**,收尾检查原样带过去、从不改它。
 *
 * 这个模块**不引任何别的模块** —— 收(agentMemory)与收尾(memoryCloseout)两边都要用它,
 * 放在这里才不会绕出一个循环引用。
 */

/** 状态块的开头一行。手改会被下一次收尾覆盖,所以把这句话就写在标记里。 */
export const MEMORY_STATUS_BEGIN = '<!-- 工作台状态块:开始(这一段由工作台自动写,手改会被覆盖) -->'

/** 状态块的结尾一行。 */
export const MEMORY_STATUS_END = '<!-- 工作台状态块:结束 -->'

/** 状态块里那行小标题。 */
const STATUS_HEADING = '## 这一家到哪了(工作台自动写的)'

/** 「最近一次收」那一行。`at` 是本机 `YYYY-MM-DD HH:MM`。 */
export function collectedLineFor(at: string, copied: number): string {
  return `- 最近一次收:${at},拷了 ${copied} 份`
}

/** 状态块里现有的「最近一次收」那一行(原样)。没有就 undefined。 */
export function collectedLineOf(block: string | undefined): string | undefined {
  if (block === undefined) return undefined
  return block.split('\n').find(line => line.startsWith('- 最近一次收:'))
}

export interface MemoryStatusInfo {
  /** 「最近一次收」那一行,原样带过来(由收的那一步写,见纪律 3)。缺席 = 还不知道,这一行不写。 */
  collectedLine?: string
  /** 这一家目录里现在一共有多少份待并的原件(台账与来源说明不算)。 */
  total: number
  /** 其中已经并过的(台账里记着同一份同一个内容)。 */
  merged: number
  /** 台账里最新的那个日期。没有台账 / 认不出日期就写「还没有」。 */
  lastMergedDate?: string
}

/** 状态块的正文(含首尾标记)。末尾不带换行 —— 插进文档时再加。 */
export function renderMemoryStatus(info: MemoryStatusInfo): string {
  const left = Math.max(0, info.total - info.merged)
  return [
    MEMORY_STATUS_BEGIN,
    STATUS_HEADING,
    '',
    ...(info.collectedLine === undefined ? [] : [info.collectedLine]),
    `- 并入进度:已并 ${info.merged} / 共 ${info.total} 份,还差 ${left} 份`,
    `- 最近一次并入:${info.lastMergedDate ?? '还没有'}`,
    MEMORY_STATUS_END,
  ].join('\n')
}

/**
 * 状态块里的「最近一次收」换成新的那一行(收的那一步用)。
 *
 * **没有旧状态块就回 undefined** —— 收这一步算不出「并了几份」,拼不出一整块;
 * 那一块由收尾检查在 10 分钟内建起来(那时 `来源.md` 的 mtime 恰好就是这次收的时刻)。
 */
export function restampCollected(block: string | undefined, line: string): string | undefined {
  if (block === undefined) return undefined
  const lines = block.split('\n')
  const at = lines.findIndex(one => one.startsWith('- 最近一次收:'))
  if (at >= 0) return [...lines.slice(0, at), line, ...lines.slice(at + 1)].join('\n')
  // 旧块里没这一行(老版本写的):插在小标题后面那个空行之后。
  const heading = lines.findIndex(one => one.startsWith('## '))
  const insertAt = heading < 0 ? 1 : heading + 2
  return [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)].join('\n')
}

/**
 * 文档里现有的状态块(含首尾标记)。没有就 undefined。
 *
 * 标记认得**宽松**一点:只要那一行里有「工作台状态块:开始 / 结束」就算 —— 标记本身的措辞
 * 以后可能改一个字,不该因此在文件里留下两块。
 */
export function statusBlockOf(text: string | undefined): string | undefined {
  const found = locate(text)
  if (found === undefined || text === undefined) return undefined
  return text.split('\n').slice(found.begin, found.end + 1).join('\n')
}

function locate(text: string | undefined): { begin: number, end: number } | undefined {
  if (text === undefined) return undefined
  const lines = text.split('\n')
  const begin = lines.findIndex(line => line.includes('工作台状态块:开始'))
  if (begin < 0) return undefined
  const end = lines.findIndex((line, at) => at > begin && line.includes('工作台状态块:结束'))
  if (end < 0) return undefined
  return { begin, end }
}

/** 文档里的状态块摘掉(连同它后面那几个空行)。没有状态块就原样回。 */
export function stripMemoryStatus(text: string): string {
  const found = locate(text)
  if (found === undefined) return text
  const lines = text.split('\n')
  let after = found.end + 1
  while (after < lines.length && lines[after]?.trim() === '') after++
  return [...lines.slice(0, found.begin), ...lines.slice(after)].join('\n')
}

/**
 * 把状态块放到文档**顶上**:标题那一行之后、正文之前。`block` 是 undefined 就只是摘掉旧的。
 *
 * 为什么不是文件最开头:第一行 `# 来自 X 的记忆(…)` 是这份文档的名字,
 * 把一块注释顶在它前面,Markdown 预览里第一眼看到的是空白。
 */
export function withMemoryStatus(doc: string, block: string | undefined): string {
  const body = stripMemoryStatus(doc)
  if (block === undefined) return body
  const lines = body.split('\n')
  const head = lines[0] ?? ''
  if (!head.startsWith('# ')) return `${block}\n\n${body}`
  const rest = lines.slice(1)
  while (rest.length > 0 && rest[0]?.trim() === '') rest.shift()
  return [head, '', block, '', ...rest].join('\n')
}

/** 本机 `YYYY-MM-DD HH:MM`。状态块里给人看的时刻,与 routines.json 里的时刻同一口径(本机时间)。 */
export function memoryStamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`
}

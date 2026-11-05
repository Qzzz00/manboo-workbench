/**
 * 引导写记忆文件用的一把 Markdown 小刀(2026-09-15)。全是纯函数:文本进、文本出,
 * 不碰磁盘——onboarding.ts 负责读写。
 *
 * 三种手法:
 * 1. **标记段**:`<!-- 引导:X:开始 -->` … `<!-- 引导:X:结束 -->`。段内内容由代码整段重写,
 *    段外一个字不动。~/.dsh/AGENTS.md 的「说话方式」只能这么改(任务书第 4 条)。
 * 2. **字段行**:项目文件里 `- **一句话**:…` 这种固定字段,原地替换值(当场答即拍板)。
 * 3. **节内追加**:`## 进展` 这种节,在节末追加一行,不改旧条目(记忆 README 的「只追加」)。
 */

export function markers(name: string): { open: string, close: string } {
  return { open: `<!-- 引导:${name}:开始 -->`, close: `<!-- 引导:${name}:结束 -->` }
}

/**
 * 写入 / 替换一个标记段。已有就原地换;没有就按 position 插:
 * 'afterTitle' = 第一个 `# ` 标题行之后(没有标题就放最前面),'end' = 文末。
 */
export function upsertMarkedBlock(text: string, name: string, body: string, position: 'afterTitle' | 'end'): string {
  const { open, close } = markers(name)
  const block = `${open}\n${body.trimEnd()}\n${close}`
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  if (start !== -1 && end !== -1 && end > start) {
    return `${text.slice(0, start)}${block}${text.slice(end + close.length)}`
  }
  const normalized = text.endsWith('\n') || text === '' ? text : `${text}\n`
  if (position === 'end') return `${normalized}${normalized === '' ? '' : '\n'}${block}\n`
  const lines = normalized.split('\n')
  const titleIndex = lines.findIndex(line => line.startsWith('# '))
  if (titleIndex === -1) return `${block}\n\n${normalized}`
  const before = lines.slice(0, titleIndex + 1).join('\n')
  const after = lines.slice(titleIndex + 1).join('\n')
  return `${before}\n\n${block}\n${after}`
}

/** 读出某个标记段的正文(不含标记);没有就 undefined。 */
export function readMarkedBlock(text: string, name: string): string | undefined {
  const { open, close } = markers(name)
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  if (start === -1 || end === -1 || end < start) return undefined
  return text.slice(start + open.length, end).replace(/^\n/, '').trimEnd()
}

/**
 * ~/.dsh/AGENTS.md 的两处:首行「我叫 X」与「说话方式」标记段。**其余一个字不动**。
 * 首行:已有 `我叫 …` 行就替换,否则插到最前面(原来的 H1 顺次下移)。
 */
export const SPEAKING_STYLE_BLOCK = '说话方式'

/**
 * 电话里那两段(2026-09-23,Ben 第五通)。同样是 `~/.dsh/AGENTS.md` 里的标记段,
 * 由通话中那件工具经 `POST /butler/memory/preference` 写,**段外一个字不动**。
 *
 * - `称呼`:一行一个,轮着叫(「老板」「姚总」…)。他的原话:「第一次叫老板,下一次叫姚总,有点好玩」。
 * - `通话偏好`:他在电话里立的长期规矩,一行一条,带日期。
 *
 * 为什么不塞进「说话方式」那一段:那一段是引导**整段重写**的(`applyAgentsFile`),
 * 把电话里攒的条目混进去,下一次引导跑过就没了。
 */
export const CALL_ADDRESS_BLOCK = '称呼'
export const CALL_PREFS_BLOCK = '通话偏好'

/**
 * 这份文件里**有哪几个标记段**,按出现顺序(2026-10-01,设置里集中改提示词那一页要列全)。
 *
 * 为什么是扫出来的、不是照一份清单列:技能段是会加的(别的卡正在往 `BASE_SKILLS` 里加一段),
 * 而她手改过的 AGENTS.md 里也可能有工作台这一版还不认识的段 —— 照清单列会把它们藏起来,
 * 那正是"界面上看不到、事务官却照着办"最难查的一种。
 */
export function listMarkedBlockNames(text: string): readonly string[] {
  const out: string[] = []
  for (const match of text.matchAll(/<!-- 引导:(.+?):开始 -->/g)) {
    const name = match[1]
    if (name !== undefined && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * **段外**那些话(标记段整段挖掉之后剩下的)。设置页只读地摆出来 ——
 * 段外是她自己的地方,工作台一个字不写(`upsertMarkedBlock` 的那条老规矩)。
 */
export function textOutsideMarkedBlocks(text: string): string {
  let out = text
  for (const name of listMarkedBlockNames(text)) {
    const { open, close } = markers(name)
    const start = out.indexOf(open)
    const end = out.indexOf(close)
    if (start === -1 || end === -1 || end < start) continue
    out = `${out.slice(0, start)}${out.slice(end + close.length)}`
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** 首行那句「我叫 X。」里的 X(没有这一行回 undefined)。 */
export function butlerNameOf(text: string): string | undefined {
  const first = text.split('\n')[0]
  const match = first === undefined ? null : /^我叫\s*(.+?)。?\s*$/.exec(first)
  return match?.[1]?.trim()
}

/**
 * 标记段里的「一行一条」→ 数组。`- ` 开头的算一条,别的行(空行、注释)忽略。
 * 段不存在、段是空的都回空数组 —— **绝不抛**(这份文件 Ben 会手改)。
 */
export function listInMarkedBlock(text: string | undefined, name: string): readonly string[] {
  if (text === undefined) return []
  const body = readMarkedBlock(text, name)
  if (body === undefined) return []
  return body.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(line => line !== '')
}

/** 一条记录去掉末尾那个「(2026-09-23)」之后剩下的话。查重比的是它。 */
function withoutDate(line: string): string {
  return line.replace(/[((]\s*\d{4}-\d{2}-\d{2}\s*[))]\s*$/, '').trim()
}

/**
 * 往标记段末尾追一条(段不存在就在文末建一个)。**已经有一模一样的一条就不追** ——
 * 他每通电话都说一遍「以后都用第一人称」,人设里不该攒出十条同样的话。
 * 回 undefined 表示「什么都不用写」,调用方据此不落盘、不备份。
 */
export function appendToMarkedBlock(
  text: string | undefined, name: string, line: string,
): string | undefined {
  const original = text ?? ''
  const existing = listInMarkedBlock(original, name)
  const bare = withoutDate(line.replace(/^-\s*/, ''))
  if (bare === '') return undefined
  if (existing.some(one => withoutDate(one) === bare)) return undefined
  const body = [...existing.map(one => `- ${one}`), `- ${line.replace(/^-\s*/, '')}`].join('\n')
  return upsertMarkedBlock(original, name, body, 'end')
}

export function applyAgentsFile(text: string, input: { butlerName?: string, styleSection?: string }): string {
  let out = text
  if (input.butlerName !== undefined) {
    const nameLine = `我叫 ${input.butlerName}。`
    const lines = out.split('\n')
    if (lines[0]?.startsWith('我叫 ') === true) lines[0] = nameLine
    else lines.unshift(nameLine, '')
    out = lines.join('\n')
  }
  if (input.styleSection !== undefined) {
    out = upsertMarkedBlock(out, SPEAKING_STYLE_BLOCK, input.styleSection, 'end')
  }
  return out
}

/** 项目文件里 `- **字段**:值` 一行原地换值;没有这一行就在第一个 `## ` 之前补上。 */
export function upsertProjectField(text: string, field: string, value: string): string {
  const lines = text.split('\n')
  const prefix = `- **${field}**:`
  const index = lines.findIndex(line => line.startsWith(prefix))
  if (index !== -1) {
    lines[index] = `${prefix}${value}`
    return lines.join('\n')
  }
  const firstSection = lines.findIndex(line => line.startsWith('## '))
  const insertAt = firstSection === -1 ? lines.length : firstSection
  // 节前通常有一个空行,字段行插在空行之前。
  const at = insertAt > 0 && lines[insertAt - 1] === '' ? insertAt - 1 : insertAt
  lines.splice(at, 0, `${prefix}${value}`)
  return lines.join('\n')
}

/**
 * 在 `## 标题` 节里追加一行(默认节末;`top` = 节首,给「进展(倒序)」用)。节不存在就在文末新建。
 * 节里只有一条「- 待梳理」占位时把占位换掉——那不是记录,是空着的意思。
 */
export function appendUnderSection(text: string, heading: string, line: string, position: 'top' | 'bottom' = 'bottom'): string {
  const lines = text.split('\n')
  const headingLine = `## ${heading}`
  const start = lines.findIndex(item => item === headingLine || item.startsWith(`${headingLine}(`))
  if (start === -1) {
    const base = text.endsWith('\n') || text === '' ? text : `${text}\n`
    return `${base}\n${headingLine}\n${line}\n`
  }
  let end = lines.findIndex((item, index) => index > start && item.startsWith('## '))
  if (end === -1) end = lines.length
  // 去掉节末空行,再追加,再补回空行。
  let last = end
  while (last > start + 1 && lines[last - 1] === '') last -= 1
  const body = lines.slice(start + 1, last)
  const filtered = body.length === 1 && /^-\s*待梳理/.test(body[0] ?? '') ? [] : body
  // 「进展」这类倒序的节新条目放最上面;其余放最后。
  const content = position === 'top' ? [line, ...filtered] : [...filtered, line]
  const rebuilt = [...lines.slice(0, start + 1), ...content, ...(end === lines.length ? [] : ['']), ...lines.slice(end)]
  return rebuilt.join('\n')
}

/** 新项目文件的骨架,对齐 docs/记忆/项目/<名>.md 现有格式。 */
export function newProjectFile(name: string, input: { oneLiner?: string, stage?: string, path?: string, goal?: string, deadline?: string, date: string, origin: string }): string {
  return [
    `# ${name}`,
    '',
    '> 项目记忆文件。字段固定,每条带日期与依据;「待梳理」表示还没人核实过。事务官只改「进展/下一步/风险」三节并附依据;「一句话/阶段/目标」引导里当场答即拍板,之后改动要他本人拍板。',
    '',
    `- **一句话**:${input.oneLiner ?? '待梳理'}`,
    `- **阶段**:${input.stage ?? '待梳理'}(可选:市场调研 / 项目策划 / 需求梳理 / MVP 开发 / 上线 / 维护)`,
    `- **路径**:${input.path ?? '待定'}`,
    `- **目标**:${input.goal ?? '待梳理'}`,
    `- **截止日**:${input.deadline ?? '无'}`,
    '',
    '## 进展(倒序,一条一日期)',
    `- ${input.date}:建档(${input.origin})`,
    '',
    '## 当前冲刺 / 任务',
    '- 待梳理',
    '',
    '## 下一步',
    '- 待梳理',
    '',
    '## 关键文件与入口',
    '- 待梳理',
    '',
    '## 风险',
    '- 待梳理',
    '',
    '## 历史决定(指向决策记录)',
    '- 无',
    '',
  ].join('\n')
}

/** 用户文件的骨架(称呼不是 Ben 时新建)。 */
export function newUserFile(nickname: string): string {
  return [
    `# 用户:${nickname}`,
    '',
    `> 两段:「自述」只有 ${nickname} 写(引导里口述、事务官代记);「观察」由事务官追加,每条带日期与依据。私人信息只留工作需要的。`,
    '',
    '## 自述',
    '',
    '## 观察(事务官/统筹会话追加,倒序)',
    '',
  ].join('\n')
}

/** 索引表追加一行(表在文件里已经有表头时)。 */
export function appendIndexRow(text: string, row: string): string {
  const base = text.endsWith('\n') || text === '' ? text : `${text}\n`
  return `${base}${row}\n`
}

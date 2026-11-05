/**
 * 电话工人的工具表 = 理解中枢的命令表(A2,2026-10-28;设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md` 第四、六节)。
 *
 * 普通来电每句都交 `/butler/say`(8791 的理解中枢自己听懂、自己办);这张表给**工人自己那只模型还在答话**的回合
 * (引导那一通)用。每件工具只做一件事:把一条命令发给 8791 的执行口(`POST /butler/hub/execute`),
 * 拿回 `{ ok, did, why?, next? }` 念给她。派给谁、那只手能不能用、要不要先问、是不是不可改清单 ——
 * 全在 8791 的执行器与护栏里,工人一条都不判。要问的,8791 回 `ask`(带它挂的 ask_id),她答了走 {@link TOOL_HUB_CONFIRM}。
 *
 * 命令表的字段与 8791 `workbench-plugin/src/server/hub/commands.ts` 一一对应(`tests/hub-tools-sync-a2.test.ts` 读那份源码比对)。
 * `ask` 与 `chat` 两条没有工具:那是模型自己开口问 / 答。`confirm`(答 8791 挂起的那一问)对应 {@link TOOL_HUB_CONFIRM}(执行口的 confirmed 路),也不出命令工具。
 */
import { llm } from '@livekit/agents'
import type { HubExecuteOutcome, HubExecuteReply, WorkbenchClient } from './workbench.ts'

export type { HubExecuteReply } from './workbench.ts'

/** 有工具的那几条命令(命令表里除 ask / chat 之外的全部)。 */
export const HUB_TOOL_COMMANDS = [
  'dispatch', 'reassign', 'supplement', 'rename', 'cancel', 'move_status',
  'set_goal', 'goal_status', 'goal_create', 'goal_due',
  'note', 'user_layer_fix', 'remember', 'feedback', 'verify',
] as const
export type HubToolCommand = typeof HUB_TOOL_COMMANDS[number]

export const HUB_TOOL_OF: Record<HubToolCommand, string> = Object.fromEntries(HUB_TOOL_COMMANDS.map(one => [one, `wb_${one}`])) as Record<HubToolCommand, string>

/** 她答了 8791 挂的那一问(护栏要她点头的取消 / 对外 / 花钱…)。 */
export const TOOL_HUB_CONFIRM = 'wb_confirm'

/** 全部工具名(给意图对照表与垫场白名单用)。 */
export const HUB_TOOLS: readonly string[] = [...HUB_TOOL_COMMANDS.map(one => HUB_TOOL_OF[one]), TOOL_HUB_CONFIRM]

/** 卡的状态(与 8791 `TASK_STATUSES` 同一份)与目标状态(`GOAL_STATUSES`)。 */
export const HUB_TASK_STATUSES = ['backlog', 'todo', 'doing', 'confirm', 'done', 'blocked', 'canceled'] as const
export const HUB_GOAL_STATUSES = ['open', 'reached', 'dropped'] as const
export const HUB_REMEMBER_SCOPES = ['global', 'dispatch', 'content'] as const

const NO_CARD_ID = '卡号用你看得见的那张卡的 id(t-…);不知道是哪张就先问她,别编。'
const RESULT_RULE = '它回什么就照着说;说「没办成」就如实说没办成和为什么,别说办好了。'

type Params = Record<string, unknown>
interface ToolSpec { description: string, properties: Record<string, unknown>, required: string[], command: (args: Params) => Record<string, unknown> }

function text(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const one = raw.trim()
  return one === '' ? undefined : one
}

function list(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.flatMap(one => (typeof one === 'string' && one.trim() !== '' ? [one.trim()] : []))
  return out.length === 0 ? undefined : out
}

const opt = (key: string, value: unknown): Record<string, unknown> => (value === undefined ? {} : { [key]: value })

const SPECS: Record<HubToolCommand, ToolSpec> = {
  dispatch: {
    description: '派活:她要人去做一件事(「让小K把 X 修了」「叫 Claude 看看 Y」)。新活给 title;指板上已有的卡给 card_id。'
      + '她点了名(哪一家 / 哪张名片)就把她说的名字填进 to,没点名就不填 —— 挑谁、那只手能不能用由电脑那头核。'
      + 'acceptance 只摘她原话里「做到什么算完」的那几条,不编。只是记一下、不现在派,用 wb_note。' + RESULT_RULE,
    properties: {
      title: { type: 'string', description: '新活的标题(短,一句话)' },
      card_id: { type: 'string', description: `指已有的卡时填。${NO_CARD_ID}` },
      to: { type: 'string', description: '她点名的那一家或名片,用她说的名字;没点名就不填' },
      text: { type: 'string', description: '交给执行者的那段话,用她的原话' },
      goal_id: { type: 'string', description: '新活归到哪个目标下(她说了才填)' },
      acceptance: { type: 'array', items: { type: 'string' }, description: '她原话里的验收条件,逐条' },
    },
    required: ['text'],
    command: a => ({
      name: 'dispatch',
      ...(text(a.card_id) === undefined ? { new: { title: text(a.title) ?? text(a.text) ?? '', ...opt('goal_id', text(a.goal_id)) } } : { card_id: text(a.card_id) }),
      ...opt('to', text(a.to)),
      text: text(a.text) ?? text(a.title) ?? '',
      ...opt('acceptance', list(a.acceptance)),
    }),
  },
  reassign: {
    description: '改派:同一张卡换人做(「改派给小K」「换 Codex 接着做」)。永不改名。' + RESULT_RULE,
    properties: { card_id: { type: 'string', description: NO_CARD_ID }, to: { type: 'string', description: '换给谁,用她说的名字' } },
    required: ['card_id', 'to'],
    command: a => ({ name: 'reassign', card_id: text(a.card_id) ?? '', to: text(a.to) ?? '', restart: true }),
  },
  supplement: {
    description: '补话:给板上某张卡补一句(「给刚才那件补一句:…」)。先落到卡上,在跑的会话能捎就捎。' + RESULT_RULE,
    properties: { card_id: { type: 'string', description: NO_CARD_ID }, text: { type: 'string', description: '她要补的那句,原话' } },
    required: ['card_id', 'text'],
    command: a => ({ name: 'supplement', card_id: text(a.card_id) ?? '', text: text(a.text) ?? '' }),
  },
  rename: {
    description: '改名:只在她明说「改名 / 标题改成 / 标题改回」时用。' + RESULT_RULE,
    properties: { card_id: { type: 'string', description: NO_CARD_ID }, title: { type: 'string', description: '新标题' } },
    required: ['card_id', 'title'],
    command: a => ({ name: 'rename', card_id: text(a.card_id) ?? '', title: text(a.title) ?? '' }),
  },
  cancel: {
    description: '取消一张卡(「不要了 / 撤掉 / 取消掉」)。电脑那头会先问她一次。' + RESULT_RULE,
    properties: { card_id: { type: 'string', description: NO_CARD_ID } },
    required: ['card_id'],
    command: a => ({ name: 'cancel', card_id: text(a.card_id) ?? '' }),
  },
  move_status: {
    description: '挪一张卡的状态(排到待排、放回待办、标完成…)。' + RESULT_RULE,
    properties: { card_id: { type: 'string', description: NO_CARD_ID }, status: { type: 'string', enum: [...HUB_TASK_STATUSES] } },
    required: ['card_id', 'status'],
    command: a => ({ name: 'move_status', card_id: text(a.card_id) ?? '', status: text(a.status) ?? '' }),
  },
  set_goal: {
    description: '把一张卡归到某个目标下;goal_id 填空串 = 移出目标。' + RESULT_RULE,
    properties: { card_id: { type: 'string', description: NO_CARD_ID }, goal_id: { type: 'string', description: '目标 id;移出填空串' } },
    required: ['card_id', 'goal_id'],
    command: a => ({ name: 'set_goal', card_id: text(a.card_id) ?? '', goal_id: text(a.goal_id) ?? null }),
  },
  goal_status: {
    description: '目标标成达成(reached)/ 不要了(dropped)/ 重新打开(open)。' + RESULT_RULE,
    properties: { goal_id: { type: 'string' }, status: { type: 'string', enum: [...HUB_GOAL_STATUSES] } },
    required: ['goal_id', 'status'],
    command: a => ({ name: 'goal_status', goal_id: text(a.goal_id) ?? '', status: text(a.status) ?? '' }),
  },
  goal_create: {
    description: '建一个新目标。due 是截止日 YYYY-MM-DD(她说了才填)。' + RESULT_RULE,
    properties: { title: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD' } },
    required: ['title'],
    command: a => ({ name: 'goal_create', title: text(a.title) ?? '', ...opt('due', text(a.due)) }),
  },
  goal_due: {
    description: '改目标截止日(YYYY-MM-DD);填空串 = 去掉截止日。' + RESULT_RULE,
    properties: { goal_id: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD,去掉填空串' } },
    required: ['goal_id', 'due'],
    command: a => ({ name: 'goal_due', goal_id: text(a.goal_id) ?? '', due: text(a.due) ?? null }),
  },
  note: {
    description: '只记一张卡、不派人(「记一下 / 建个待办 / 先排到待排」)。一句里几件就调几次。'
      + 'status:要做的待办填 todo,只是先排着填 backlog。标题只写那件事本身,别带「帮我建一个待办」这类前缀。' + RESULT_RULE,
    properties: {
      title: { type: 'string', description: '那件事本身' },
      status: { type: 'string', enum: ['todo', 'backlog'] },
      goal_id: { type: 'string', description: '归到哪个目标下(她说了才填)' },
      acceptance: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
    command: a => ({ name: 'note', title: text(a.title) ?? '', status: a.status === 'backlog' ? 'backlog' : 'todo', ...opt('goal_id', text(a.goal_id)), ...opt('acceptance', list(a.acceptance)) }),
  },
  user_layer_fix: {
    description: '改她自己那一格(工作台上她加的小组件等「用户层」里的东西):said 填她要的改法原话。谁来改由电脑那头核。' + RESULT_RULE,
    properties: { said: { type: 'string', description: '她要的改法,原话' }, widget: { type: 'string', description: '哪一格(知道才填)' }, to: { type: 'string', description: '她点名谁来改才填' } },
    required: ['said'],
    command: a => ({ name: 'user_layer_fix', said: text(a.said) ?? '', ...opt('widget', text(a.widget)), ...opt('to', text(a.to)) }),
  },
  remember: {
    description: '记一条她明说「以后都这样」的规矩或偏好。scope:派活相关填 dispatch,内容创作相关填 content,其余 global。' + RESULT_RULE,
    properties: { text: { type: 'string', description: '那条规矩,用她的话' }, scope: { type: 'string', enum: [...HUB_REMEMBER_SCOPES] } },
    required: ['text'],
    command: a => ({ name: 'remember', text: text(a.text) ?? '', scope: (HUB_REMEMBER_SCOPES as readonly unknown[]).includes(a.scope) ? a.scope : 'global' }),
  },
  feedback: {
    description: '反馈给开发者:只在她说的是工作台本身的毛病、又没点名让谁去修时用;她点了名就是派活(wb_dispatch)。' + RESULT_RULE,
    properties: { text: { type: 'string', description: '她说的毛病,原话' } },
    required: ['text'],
    command: a => ({ name: 'feedback', text: text(a.text) ?? '' }),
  },
  verify: {
    description: '核验:她要按卡上的验收条件核一遍已交回的卡(「核一遍那张」「按条件核一下,过了结掉、不过退修」)。'
      + '只对「等你确认」的卡;卡上没条件、她这句里带了条件就逐条给 acceptance(电脑那头先落卡再核)。' + RESULT_RULE,
    properties: {
      card_id: { type: 'string', description: NO_CARD_ID },
      acceptance: { type: 'array', items: { type: 'string' }, description: '她这句里的验收条件,逐条;卡上已有的不用给' },
    },
    required: ['card_id'],
    command: a => ({ name: 'verify', card_id: text(a.card_id) ?? '', ...opt('acceptance', list(a.acceptance)) }),
  },
}

/**
 * 执行口回来的那一下 → 给模型的一句话。办成了念 8791 拼好的那句(电话版,不带卡号);
 * 要问的 → 「还没办,照这句问她」+ ask_id;没办成 → 照 why / next 说。
 */
export function hubToolText(outcome: HubExecuteOutcome): string {
  if (!outcome.ok) {
    if (outcome.old === true) return `没办:电脑上的工作台这一版还办不了这件(没有理解中枢的执行口)。如实告诉她,让她在电脑上说一句。`
    return `没办:${outcome.why}。如实告诉她这件没办成。`
  }
  const reply: HubExecuteReply = outcome.reply
  const asked = reply.results.find(one => one.ask?.ask_id !== undefined)?.ask
  if (asked?.ask_id !== undefined) {
    const options = asked.options.length === 0 ? '' : `(${asked.options.join(' / ')})`
    return `还没办。先照这句问她:「${asked.question}」${options}`
      + `她明确答了之后调 ${TOOL_HUB_CONFIRM},ask_id 填 ${asked.ask_id},choice 填她的原话;她说不要就也调它、choice 填她那句。ask_id 别念出来。`
  }
  if (reply.results.length > 0 && reply.results.every(one => !one.ok)) {
    return `没办成:${reply.say.spoken}照这句如实告诉她,别说办好了。`
  }
  return `${reply.say.spoken}(照这句告诉她;卡号别念。)`
}

export interface HubToolsDeps {
  workbench: Pick<WorkbenchClient, 'hubExecute'>
  /** 她刚亲口说的那一句(交给 8791 记 say 账、给护栏核;拿不到就用模型给的参数)。 */
  lastSaid?: () => string | undefined
  onStart?: (name: string) => void
  onUsed?: (name: string, ok: boolean, text: string) => void
}

export function createHubTools(deps: HubToolsDeps): Record<string, ReturnType<typeof llm.tool>> {
  const heard = (fallback: string): string => {
    try { return deps.lastSaid?.()?.trim() || fallback }
    catch { return fallback }
  }
  const send = async (name: string, input: { said: string, commands?: Record<string, unknown>[], confirmed?: { ask_id: string, choice: string } }): Promise<string> => {
    try { deps.onStart?.(name) }
    catch { /* 垫一句是好意,不是主线 */ }
    const outcome: HubExecuteOutcome = typeof deps.workbench.hubExecute === 'function'
      ? await deps.workbench.hubExecute(input).catch(() => ({ ok: false as const, why: '工作台连不上', unreachable: true as const }))
      : { ok: false, why: '电脑上的工作台这一版还没有理解中枢的执行口', old: true }
    const said = hubToolText(outcome)
    deps.onUsed?.(name, outcome.ok && outcome.reply.results.some(one => one.ok && one.ask === undefined), said)
    return said
  }
  const tools: Record<string, ReturnType<typeof llm.tool>> = {}
  for (const command of HUB_TOOL_COMMANDS) {
    const spec = SPECS[command]
    const name = HUB_TOOL_OF[command]
    tools[name] = llm.tool({
      description: spec.description,
      parameters: { type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false },
      execute: async (args: Params) => {
        const cmd = spec.command(args)
        return send(name, { said: heard(String(cmd.text ?? cmd.title ?? cmd.said ?? '')), commands: [cmd] })
      },
    })
  }
  tools[TOOL_HUB_CONFIRM] = llm.tool({
    description: '她答了电脑那头要她点头的那一问(取消、对外发出去、花钱…):ask_id 用那一问给的,choice 填她的原话(同意、不同意都调)。',
    parameters: {
      type: 'object',
      properties: { ask_id: { type: 'string' }, choice: { type: 'string', description: '她的原话' } },
      required: ['ask_id', 'choice'],
      additionalProperties: false,
    },
    execute: async (args: Params) => send(TOOL_HUB_CONFIRM, { said: heard(String(args.choice ?? '')), confirmed: { ask_id: String(args.ask_id ?? ''), choice: String(args.choice ?? '') } }),
  })
  return tools
}

/** 取上下文包最多等多久(引导那一通要办事的回合;取不到就不带,不挡这一回合)。 */
export const HUB_CONTEXT_TIMEOUT_MS = 800

/**
 * 上下文包同源(设计第三、六节):工人自己的模型答话的那一回合,带上 8791 现拼的那一份(与 `/butler/say` 同一个
 * buildContext + renderContext),它才看得见板上的卡、目标、手与最近的话 —— 不再凭人设里那份旧快照。
 */
export async function hubContextNote(workbench: Pick<WorkbenchClient, 'hubContext'>, said: string): Promise<string | undefined> {
  if (typeof workbench.hubContext !== 'function') return undefined
  const got = await workbench.hubContext({ entrance: 'call', said }, { timeoutMs: HUB_CONTEXT_TIMEOUT_MS }).catch(() => ({ ok: false as const }))
  if (!got.ok) return undefined
  return `【工作台上下文包】电脑那头现拼的,与电脑、手机同一份。卡号 / 目标 id 只在工具参数里用,别念出来;包里没有的就问她,别猜。\n${got.text}`
}

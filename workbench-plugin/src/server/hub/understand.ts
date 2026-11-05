/**
 * 理解中枢的「模型出命令」(设计第二节):句子 + 入口 + 上下文包 → 模型按命令表出 commands[]。
 *
 * 走与 `sayModel.ts` 同一个模型通路(`modelService.endpoint()`;key 只进请求头,不落任何地方)。
 * 没有任何一步在模型之前就地结束:认不出由模型出 `chat` / `ask`;模型接不上或回了坏结构,如实回失败,
 * 由入口照实告诉她「这句没动」,**不拿半截清单冒称听懂、也不兜底替她记一条**。
 */
import { OWN_DEFAULT_MODEL } from '../modelConfig.ts'
import { COMMAND_TABLE_TEXT, parseCommands, type HubCommand } from './commands.ts'
import { renderContext, type HubContext } from './context.ts'
import { resolveSayCardTarget } from '../sayTarget.ts'

export interface HubModelEndpoint { baseUrl: string, key: string | undefined, model?: string, ready: boolean }

export interface HubModelDeps {
  endpoint: () => Promise<HubModelEndpoint>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type HubUnderstanding =
  | { ok: true, commands: HubCommand[], rejected: { name: string, why: string }[] }
  | { ok: false, why: 'unreachable' | 'bad_output' }

export const HUB_SYSTEM_PROMPT = [
  '你是工作台事务官的「理解中枢」。她对你说了一句话。读上下文包(最近的话、板上的卡、目标、手、用户层),把这句话翻成命令表里的命令,只回 JSON:{"commands":[...]}。',
  '你不执行任何事:执行层会核手、核卡、照实回话。除了 chat,你不写回话。',
  '',
  '指哪张卡:',
  '1. 句子里出现卡号(t-xxxxxxxx)就按卡号定位,不去最近的话里找「上一件」。',
  '2. 「刚才那件 / 手机 App 那件 / 派给小K那件」:在最近的话与板上的卡里按标题、关键词、负责人对题 —— 不是取时间上最近的那张。对上唯一一张就用它;对不上或几张都像,出 ask,选项写候选卡号 + 短标题。',
  '3. 「标题是『…』的那张」按标题找。',
  '4. 上下文包里没有的卡,不编卡号,出 ask。',
  '',
  '做什么:',
  '- 改派 / 换人 / 改给 X / 让 X 接着做那件 = reassign(同一张卡换负责人)。改派永不改名;rename 只在原话明说「改名 / 标题改成 / 标题改回」时用。',
  '- 「让 / 交给 / 派 <手> + 做某事」= dispatch,即使那件事是在说工作台哪里有毛病(「让小K把 X 显示 0 的问题修了」是派活,不是反馈)。点了名就把那只手的 id(【手】一节第一格)填进 to。',
  '- 要进仓库查根因、改代码、跑用例的活:桌面 App 的窗口拿不到仓库,派给它只会把字贴进输入框、等不到结果。这一类活没点名就不给 to(执行层只在标了「能改本机文件」的手里挑);她点了名但那只手拿不到仓库,照样填 to,执行层会换能拿到的并说清;只是在窗口里问一句 / 写段文案的活不在此列。',
  '- 没点名、但明显要有人去做的活:dispatch 不给 to,由执行层挑手。只是记下 / 建待办 / 排到待排、不要现在派的 = note。',
  '- 「X 点提醒我 / 先放着回头再说 / 记一下 / 别忘了」也是 note:她要你记下一件事,标题写原话里的事与时间(如「下午 3 点提醒:…」;原话没说是什么事就照她的话写,不编)。同一句里夹着抱怨或情绪(「不要再发啦」)不改变这一条,不是闲聊。',
  '- dispatch 默认建新卡(new)。card_id 只在她明确回指一张已有的卡时给:说了卡号,或说「那张 / 那件 / 刚才那件 / 标题是…的那张」。只是话题和某张卡沾边(同一个模块、同一个端口号、同一个词)不算回指,照样 new。指着的卡正在跑:加要求用 supplement,换人用 reassign,不再 dispatch。',
  '- 一句里几件事就几条命令(「三件事:一、…二、…三、…」= 三条),每条只装一件。',
  '- 归到某个目标下:新卡用 note.goal_id 或 dispatch.new.goal_id;已有的卡用 set_goal。目标按【目标】里的标题对。',
  '- 目标标成达成 / 不要了 / 重新打开、改截止、新建目标:goal_status / goal_due / goal_create。',
  '- 取消卡 = cancel(执行层会先问她一次,你照出 cancel)。挪状态 = move_status。',
  '- 给某件补一句话 = supplement(卡按上面的规则认)。「X 补一句:…」冒号后的整句都是说给 X 的,句子里再夹的「顺带 / 另外」默认也是这同一句补话,一起进这条 supplement 的 text;只有她明说「另开一张 / 单开一张」才多出一条 dispatch(新卡)。',
  '- 「按卡上条件核一遍 / 核一下那张 / 过了结掉、不过退修」= verify:只对「等你确认」的卡,一句几张就几条命令。卡还没交回(待办 / 在跑 / 卡住 / 派发失败)时不出 verify:她说「验收 / 核 / 回写」是要有人去做这件事,出 dispatch(回指那张卡)/ supplement / reassign。卡上没条件、她这句里带了验收条件,把条件逐条给在 verify 的 acceptance(执行层先落卡再核)。',
  '- 改工作台「某一格」:那一格在【用户层】里(名字或替换的本体格对得上)= user_layer_fix;不在用户层、这台机器上有源码 = dispatch 给能改本机文件的手(没点名就不给 to);不在用户层、也没有源码 = feedback。',
  '- feedback 只在:说的是工作台本体的毛病、没点名任何手、也没有可派的人。与 dispatch 互斥。',
  '- 她明说「以后都… / 记住这条规矩」= remember。',
  '- 问进度、问事、闲聊 = chat:只按上下文包里的事实答(卡的状态、负责人、派发),不说「已派 / 已改」这类办成了的话。',
  '- 验收条件:原话里「做到什么算完 / 验收 / 要有…」逐条摘进 acceptance;原话点名了文件且【她点名的文件】里写了验收,就从文件里摘;没有就不给,不编。',
  '- 拿不准指哪张、做什么、给谁 → ask,options 给 2–4 个具体选项。不要猜。',
  '- 【挂着等她答的问】:她这句是在答其中某一问时,出 confirm:{ask_id 填那一问的,choice 照抄她选的那个选项的原话};这一句里只出 confirm 这一条,不另出别的命令。',
  '- 派活本身要花钱 / 对外发出 / 动她的账号设备时,在 dispatch 上标 risk(执行层会先问她)。',
  '',
  '例:{"commands":[{"name":"reassign","card_id":"t-ea1e8702","to":"agent:me:k1"}]}',
  '命令表(名字 {参数} —— 什么时候用):',
  COMMAND_TABLE_TEXT,
].join('\n')

/**
 * 对多张不猜(任务书第 1 条):模型出完命令之后,用「指哪张卡」那一个解析器(`sayTarget.ts`)核一遍 ——
 * 句里的接续回指(「刚才手机 App 那件」)对上了好几张、模型挑了其中一张,那条改成问一句,选项是几张候选。
 * 只在模型之后核、只把猜改成问;解析器认不出(没回指、没对上、只一张)一律不拦。
 */
export function askIfAmbiguous(said: string, ctx: HubContext, commands: readonly HubCommand[]): HubCommand[] {
  const target = resolveSayCardTarget({
    said,
    nowMs: ctx.now,
    tasks: ctx.cards,
    ledger: ctx.says.map(one => ({ at: one.at, items: one.cards.map(id => ({ card_id: id, title: ctx.cards.find(card => card.id === id)?.title ?? id })) })),
  })
  if (target.kind !== 'ambiguous') return [...commands]
  const ids = new Set(target.candidates.map(one => one.id))
  const out: HubCommand[] = []
  let asked = false
  for (const one of commands) {
    if ('card_id' in one && typeof one.card_id === 'string' && ids.has(one.card_id)) {
      if (!asked) out.push({ name: 'ask', question: `「${target.topic}」那件对上了 ${target.candidates.length} 张,你说的是哪一张?`, options: target.candidates.slice(0, 4).map(card => `${card.id} ${card.title}`) })
      asked = true
      continue
    }
    out.push(one)
  }
  return out
}

/** 指向全落空时的一问:说清哪里对不上,不空着回。 */
function askForRejected(rejected: readonly { name: string, why: string }[]): HubCommand {
  const whys = [...new Set(rejected.map(one => one.why))].slice(0, 3).join(';')
  return { name: 'ask', question: `${whys} —— 你指的是哪一张 / 哪只手?`, options: [] }
}

export async function understandCommands(said: string, ctx: HubContext, deps: HubModelDeps): Promise<HubUnderstanding> {
  let endpoint: HubModelEndpoint
  try { endpoint = await deps.endpoint() }
  catch { return { ok: false, why: 'unreachable' } }
  if (!endpoint.ready || endpoint.key === undefined) return { ok: false, why: 'unreachable' }
  const model = endpoint.model ?? OWN_DEFAULT_MODEL
  let content: unknown
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2000,
        // 与 sayModel 同:DeepSeek 默认思考会吃掉结构化正文预算;其它家不加方言。
        ...(/^deepseek-/i.test(model) ? { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: HUB_SYSTEM_PROMPT },
          { role: 'user', content: `${renderContext(ctx)}\n\n她在 ${ctx.entrance} 说:「${said}」` },
        ],
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
    })
    if (!res.ok) return { ok: false, why: 'unreachable' }
    const body = await res.json().catch(() => undefined) as { choices?: { finish_reason?: string, message?: { content?: unknown } }[] } | undefined
    const finish = body?.choices?.[0]?.finish_reason
    if (finish !== undefined && finish !== 'stop') return { ok: false, why: 'bad_output' }
    content = body?.choices?.[0]?.message?.content
  }
  catch { return { ok: false, why: 'unreachable' } }
  if (typeof content !== 'string') return { ok: false, why: 'bad_output' }
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end < start) return { ok: false, why: 'bad_output' }
  let parsed: unknown
  try { parsed = JSON.parse(content.slice(start, end + 1)) }
  catch { return { ok: false, why: 'bad_output' } }
  const { commands, rejected } = parseCommands(parsed, ctx)
  if (commands.length === 0 && rejected.length === 0) return { ok: false, why: 'bad_output' }
  if (commands.length === 0) {
    if (rejected.every(one => one.name === '?')) return { ok: false, why: 'bad_output' }
    return { ok: true, commands: [askForRejected(rejected)], rejected }
  }
  return { ok: true, commands: askIfAmbiguous(said, ctx, commands), rejected }
}

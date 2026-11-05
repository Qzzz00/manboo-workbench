/**
 * 通话模式(2026-09-17)在工作台这一侧的那一块。Ben:「点一下说一声的方式还是一半,不如做 RTC 通话模式吧」。
 *
 * **电话里说话的大脑不是事务官本尊**。手机直接和火山 RTC 的智能体(ASR + 豆包方舟接入点 + TTS)
 * 通话——那条链路是毫秒级的,DSH 事务官起一条会话要按秒算,接不了电话。事务官通过三件事参与:
 *
 *   1. **人设注入**:这通电话的 systemMessage 由工作台现拼——名字与说话方式取自 `~/.dsh/AGENTS.md`
 *      (引导真的写过的那份;docs 里的提示词草稿不是真源),再把此刻「在办 / 等我确认」的事项摘要
 *      塞进去当上下文。手机不碰人设,它只负责把声音接通。
 *   2. **工具回调**:电话里说「记一件事」时,豆包调 wb_remember_item 工具,火山把 tool_calls POST
 *      回工作台(而不是 butler-server——只有工作台认识事项),工作台建卡后把结果回填给智能体,
 *      由她在电话里亲口说「记下了」。
 *   3. **通话后摘要**:挂断时把时长与字幕写成一条事项,Mac 上能看到「和事务官通了 3 分钟电话,说了什么」。
 *
 * 这个取舍要 Ben 拍板,已记进 docs/决策记录.md 的「待拍板」。
 *
 * ⚠️ **公网回调的限制**:火山要求 ServerMessageUrl 是它能访问到的地址,本机 8791 没有公网地址。
 * 所以回调地址做成可配的 `WORKBENCH_RTC_CALLBACK_URL`——没配就**不下发工具**,并且人设里明说
 * 「这通电话记不了事项」。宁可她在电话里说一句「记不下来」,也不能答应一件根本没落下的事。
 *
 * 本文件除 createRtcCallService 外全是纯函数:文本进、文本出,不碰磁盘也不发请求。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { TasksState, TaskView } from '../protocol.ts'
import { listInMarkedBlock, readMarkedBlock } from './memoryMd.ts'
import { CALL_ADDRESS_BLOCK, CALL_PREFS_BLOCK, SPEAKING_STYLE_BLOCK } from './memoryMd.ts'

/** 火山 POST tool_calls 到 8791 的这条路径(与 http.ts 的路由同一处真相)。 */
export const RTC_CALLBACK_PATH = '/butler/rtc/callback'

/**
 * 工具名一律带 `wb_` 前缀。历史上 `ben-wb__card` / `ben-wb__inbox` 撞过名,这里同理:
 * 工具名会和火山/豆包自己的内建名共处一个命名空间,不带前缀迟早撞上。
 */
export const CALL_TOOL_REMEMBER = 'wb_remember_item'
export const CALL_TOOL_DOING = 'wb_list_doing'

/**
 * 通话上下文看这三列:交代了还没动的、正在办的、等他验收的。**「待排」不进电话**——
 * 那是还没决定要做的事,电话里念出来只会让他以为事务官在催。
 */
const CONTEXT_STATUSES = [
  { status: 'todo' as const, label: '待办' },
  { status: 'doing' as const, label: '在办' },
  { status: 'confirm' as const, label: '等我确认' },
]

/** 一列最多念几条。电话里念不完十几条,多的只说还有几条。 */
const CONTEXT_MAX = 5

// ———————————————————————— 人设:~/.dsh/AGENTS.md ————————————————————————

/**
 * 首行「我叫 X。」里的名字。引导(server/onboarding.ts)就是这么写进去的。
 * 没写过就缺席——**不给他起一个名字**,通话里退成「事务官」。
 */
export function butlerNameOf(agentsText: string | undefined): string | undefined {
  if (agentsText === undefined) return undefined
  const first = agentsText.split('\n')[0]?.trim() ?? ''
  const match = /^我叫\s*(.+?)[。.]?$/.exec(first)
  const name = match?.[1]?.trim()
  return name === undefined || name === '' ? undefined : name
}

/** 「说话方式」标记段的正文。段外一个字都不带——那些是给 DSH 读的,不是通话人设。 */
export function speakingStyleOf(agentsText: string | undefined): string | undefined {
  if (agentsText === undefined) return undefined
  const body = readMarkedBlock(agentsText, SPEAKING_STYLE_BLOCK)
  return body === undefined || body.trim() === '' ? undefined : body.trim()
}

/**
 * 「称呼」标记段(2026-09-23,Ben:「第一次叫老板,下一次叫姚总,有点好玩」)。
 * 没写过就**空表** —— 工人那边有它自己的缺省(channel-worker 的 address.ts),
 * 这里不替它编一个:两处各有一份缺省,改一处另一处不会跟着变。
 */
/**
 * 「称呼」那张表 → 一行一个称呼。**读的时候就把整句话剥成名字**(见 {@link addressNameOf})。
 *
 * ——— 为什么在读的时候也剥一遍(2026-10-02,卡「电话里像个活人」)———
 *
 * Air 那几通里开场白 22 次是「**以后叫小笨蛋**,有什么吩咐?」——
 * 她说过一句「以后叫(我)小笨蛋」,**整句**被存成了称呼。
 * 写那一头已经改成只存名字(`POST /channel/preference` 的 address 那一支),
 * 但**她机器上那张表里已经躺着的整句**不会自己变:用户层我们不去改写,
 * 所以在**读**的时候剥 —— 这就是那条「已存的整句迁移掉」。
 */
export function callAddressesOf(agentsText: string | undefined): readonly string[] {
  const out: string[] = []
  for (const one of listInMarkedBlock(agentsText, CALL_ADDRESS_BLOCK)) {
    const name = addressNameOf(one)
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 一句「以后叫我小笨蛋就行」→ 「小笨蛋」。**称呼表只存称呼本身**。
 *
 * 这是**唯一一处**判据:写进表里之前剥一遍({@link callAddressesOf} 的调用方
 * `POST /channel/preference`),读出来再剥一遍(表里已经躺着的整句)。
 * 两处同一个函数,不另抄一份 —— 抄成两份必然各自漂。
 *
 * 剥三样,**剥不动就原样返回**(宁可留一句也不要剥出一个空的):
 *   ① 句首的「(以后 / 平时 / 都)叫我 / 喊我 / 称呼我 / 我叫 / 我是」;
 *   ② 句尾的「就行 / 就可以了 / 吧 / 了」那一串(可能叠着来);
 *   ③ 逗号后面那一截(「以后叫小笨蛋,有什么吩咐」里的后半句)。
 *
 * 剥完长过 12 个字就当它不是一个称呼(回空串,调用方跳过)—— 念出来只会更怪。
 */
export const ADDRESS_MAX_CHARS = 12

export function addressNameOf(said: string): string {
  const raw = typeof said === 'string' ? said.trim() : ''
  if (raw === '') return ''
  // ③ 先切掉逗号后面那一截:称呼是一个词,不会带分句。
  let text = (raw.split(/[,,、;;]/)[0] ?? '').trim()
  // ① 句首那几种说法
  text = text.replace(/^(?:你|以后|平时|之后|往后|就|直接|都)*(?:叫我|喊我|称呼我|叫|喊|称呼|我叫|我是)/u, '').trim()
  // ② 句尾那一串语气与「就行」(叠着来的剥到剥不动为止)
  let before = ''
  while (before !== text) {
    before = text
    text = text.replace(/(?:就可以了|就可以|可以了|就行了|就行|就好了|就好|就是了|就了|吧|呀|啊|哈|哦|嘛|了|的)$/u, '').trim()
  }
  const name = text.replace(/[。.!!??]+$/u, '').trim()
  if (name === '') return raw.length <= ADDRESS_MAX_CHARS ? raw : ''
  return name.length <= ADDRESS_MAX_CHARS ? name : ''
}

/**
 * 「通话偏好」标记段(2026-09-23)。他在电话里立下的长期规矩,一行一条。
 * 这几条**直接进系统提示**:下一通电话她就照着做 —— 那正是「记住了」这三个字的全部意思。
 */
export function callPreferencesOf(agentsText: string | undefined): readonly string[] {
  return listInMarkedBlock(agentsText, CALL_PREFS_BLOCK)
}

// ———————————————————————— 上下文:他手上的事 ————————————————————————

function titlesOf(tasks: readonly TaskView[], status: TaskView['status']): string[] {
  return tasks.filter(t => t.status === status).map(t => t.title.trim()).filter(t => t !== '')
}

/**
 * 「他手上的事」那一段。三种结果各说各的,不混:
 *   - 看板整个拿不到 → 说拿不到(D13:降级如实说,不静默变成「没有」);
 *   - 拿到了但一件没有 → 说没有;
 *   - 有 → 一列最多念 5 条,多的只说还有几条。
 */
export function callContextBlock(tasks: TasksState | undefined): string {
  if (tasks === undefined) {
    return '(工作台的看板这会儿拿不到。别凭印象说他手上有什么——问他就是了。)'
  }
  const lines: string[] = []
  for (const { status, label } of CONTEXT_STATUSES) {
    const titles = titlesOf(tasks.tasks, status)
    if (titles.length === 0) {
      lines.push(`${label}:没有。`)
      continue
    }
    const shown = titles.slice(0, CONTEXT_MAX)
    const rest = titles.length - shown.length
    lines.push(`${label}:${shown.join('、')}${rest > 0 ? `,另外还有 ${rest} 条` : ''}。`)
  }
  return lines.join('\n')
}

// ———————————————————————— 通话人设 ————————————————————————

export interface CallSystemMessageInput {
  /** ~/.dsh/AGENTS.md 全文;读不到就不传。 */
  agentsText?: string
  /** 当前看板;拿不到就不传(人设里会说「拿不到」,不会说「没有」)。 */
  tasks?: TasksState
  /** 这通电话有没有工具通道(取决于 WORKBENCH_RTC_CALLBACK_URL 配没配)。 */
  toolsEnabled?: boolean
}

const DEFAULT_STYLE = '一次说一两句,像打电话那样,别念稿子。'

export function buildCallSystemMessage(input: CallSystemMessageInput): string {
  const name = butlerNameOf(input.agentsText)
  const style = speakingStyleOf(input.agentsText) ?? DEFAULT_STYLE
  const who = name === undefined ? '你是他的事务官。' : `你是他的事务官,名字叫${name}。`
  const ability = input.toolsEnabled === true
    ? [
      `- 他交代一件新的事 → 一边口头应他,一边调 ${CALL_TOOL_REMEMBER} 工具,把他的原话记成工作台上的一条事项。`,
      `- 他问「现在在办什么」「有什么等我确认」 → 调 ${CALL_TOOL_DOING} 工具现查一遍再答,别照上面那份快照背。`,
      '- 工具回来说没办成,就在电话里如实告诉他没记上,别含糊过去。',
    ].join('\n')
    : [
      '- 这通电话里你记不了事项——工作台的工具通道这会儿没开。',
      '- 他交代新的事,就说「这通电话我记不下来,挂了在手机上发我一条」,**不要**答应「我记下了」。',
    ].join('\n')

  return [
    `${who}现在他在手机上给你打电话:你说的每个字都会被念出来,他随时可以打断你。`,
    '',
    '【怎么说话】',
    style,
    '',
    '【电话里的规矩】',
    '- 一次一两句。不念清单、不念 Markdown、不念代码、不念链接和 id——那些在电话里听不懂。',
    '- 不知道就说不知道,数字拿不到就说拿不到,绝不编。',
    '- 他一开口你就停下来听。',
    '',
    '【他手上的事(工作台此刻的快照,可能已经变了)】',
    callContextBlock(input.tasks),
    '',
    '【你在这通电话里能做什么】',
    ability,
  ].join('\n')
}

/** 接通后她的第一句。短——第一句长了,人只会想快点插话。 */
export function buildCallWelcome(butlerName: string | undefined): string {
  return butlerName === undefined ? '喂,我在,你说。' : `喂,我是${butlerName},你说。`
}

// ———————————————————————— 工具 ————————————————————————

export interface CallTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: { type: 'object', properties: Record<string, unknown>, required: string[] }
  }
}

/**
 * 通话里的最小工具集。**就两件**,而且都是「他说给事务官听」这件事本身的延伸:
 * 记一件事、查在办什么。任何会改动看板状态的动作(挪列、删卡)都不在这里——
 * 电话是最容易听错的通道,不给它写状态的权力。
 */
export function buildCallTools(): readonly CallTool[] {
  return [
    {
      type: 'function',
      function: {
        name: CALL_TOOL_REMEMBER,
        description:
          '把用户在电话里交代的一件事记成工作台上的一条事项。只有他明确要你办 / 要你记的时候才调用;'
          + '闲聊、问问题、他只是在念叨,都不要调用。text 填他的原话,别替他改写。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '他交代的那件事,尽量用他的原话' } },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: CALL_TOOL_DOING,
        description: '查此刻工作台上在办与等他确认的事项。他问「现在在办什么」这类问题时调用,现查现答。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ]
}

// ———————————————————————— 回调 ————————————————————————

export interface ParsedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/**
 * 火山回调里的 Message(一串 tool_calls JSON)→ 结构化。
 * **绝不抛**:这是外面传进来的字节,解析不出来就当作没有调用——一条回调把工作台打挂是不可接受的。
 */
export function parseToolCalls(message: unknown): readonly ParsedToolCall[] {
  if (typeof message !== 'string' || message === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  }
  catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ParsedToolCall[] = []
  for (const raw of parsed) {
    const call = (raw ?? {}) as { id?: unknown, function?: { name?: unknown, arguments?: unknown } }
    const id = typeof call.id === 'string' ? call.id : ''
    const name = typeof call.function?.name === 'string' ? call.function.name : ''
    if (id === '' || name === '') continue
    let args: Record<string, unknown> = {}
    if (typeof call.function?.arguments === 'string' && call.function.arguments !== '') {
      try {
        const decoded = JSON.parse(call.function.arguments) as unknown
        if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) args = decoded as Record<string, unknown>
      }
      catch { /* arguments 是垃圾就按空参数走,让工具那边自己拒绝 */ }
    }
    out.push({ id, name, args })
  }
  return out
}

/**
 * 火山回调地址。`WORKBENCH_RTC_CALLBACK_URL` 给的是**工作台在公网上的入口**(内网穿透的地址),
 * 这里把回调路径拼上去;已经带了路径就原样用。没配 = 这台机器没有公网地址 = 不开工具。
 */
export function rtcCallbackUrlOf(env: Record<string, string | undefined>): string | undefined {
  const raw = (env.WORKBENCH_RTC_CALLBACK_URL ?? '').trim()
  if (raw === '') return undefined
  const trimmed = raw.replace(/\/+$/, '')
  return trimmed.endsWith(RTC_CALLBACK_PATH) ? trimmed : `${trimmed}${RTC_CALLBACK_PATH}`
}

// ———————————————————————— 通话纪要 ————————————————————————

/** 电话里的一句话。who 只有两种——谁说的必须分得清,否则纪要没法读。 */
export interface CallUtterance {
  who: 'me' | 'butler'
  text: string
}

/** 「3 分 5 秒」。没时长就缺席(不编数,也不写 0)。 */
export function formatCallDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  if (minutes === 0) return `${rest} 秒`
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

// ———————————————————————— 接线 ————————————————————————

/** 只要看板的「读」那一面。通话拿不到写看板的能力,这里的端口就不给写的方法。 */
export interface CallTasksPort {
  list: () => Promise<TasksState>
}

export interface CallInjection {
  systemMessage: string
  welcomeMessage: string
  butlerName?: string
  tools?: readonly CallTool[]
  functionCalling?: { serverMessageUrl: string, serverMessageSignature: string }
}

export interface RtcCallService {
  /** 这一通电话要注进 /api/rtc/start 的那几样。每次现拼——人设里带着此刻的事项快照。 */
  injection: () => Promise<CallInjection>
  /** 进程级随机签名。重启即轮换(旧通话随进程一起结束,没有遗留校验问题)。 */
  signature: () => string
  /** 回调带来的签名对不对。定长比较,不用 === 比字符串。 */
  verify: (signature: unknown) => boolean
  /** 这通电话有没有工具通道。 */
  toolsEnabled: () => boolean
}

export interface RtcCallServiceDeps {
  /** ~/.dsh/AGENTS.md(测试给临时目录)。只读,一个字都不改。 */
  agentsFile: string
  tasks?: CallTasksPort
  /** 火山能回调到的地址;没有就不开工具。 */
  callbackUrl?: string
  readFileImpl?: (file: string) => Promise<string>
  /** 测试注入固定签名;生产用进程级随机。 */
  signature?: string
}

export function createRtcCallService(deps: RtcCallServiceDeps): RtcCallService {
  const read = deps.readFileImpl ?? ((file: string) => readFile(file, 'utf8'))
  const signature = deps.signature ?? randomBytes(24).toString('hex')
  const callbackUrl = deps.callbackUrl !== undefined && deps.callbackUrl.trim() !== '' ? deps.callbackUrl.trim() : undefined
  const toolsEnabled = callbackUrl !== undefined

  async function agentsText(): Promise<string | undefined> {
    try {
      return await read(deps.agentsFile)
    }
    catch {
      // 没被引导写过、或者根本没有这个文件:照样能通话,只是没有名字与说话方式。
      return undefined
    }
  }

  async function board(): Promise<TasksState | undefined> {
    if (deps.tasks === undefined) return undefined
    try {
      return await deps.tasks.list()
    }
    catch {
      return undefined
    }
  }

  return {
    toolsEnabled: () => toolsEnabled,
    signature: () => signature,
    verify: (provided) => {
      if (typeof provided !== 'string' || provided === '') return false
      const a = Buffer.from(provided)
      const b = Buffer.from(signature)
      return a.length === b.length && timingSafeEqual(a, b)
    },
    async injection() {
      const [text, tasks] = await Promise.all([agentsText(), board()])
      const butlerName = butlerNameOf(text)
      return {
        systemMessage: buildCallSystemMessage({
          ...(text === undefined ? {} : { agentsText: text }),
          ...(tasks === undefined ? {} : { tasks }),
          toolsEnabled,
        }),
        welcomeMessage: buildCallWelcome(butlerName),
        ...(butlerName === undefined ? {} : { butlerName }),
        ...(toolsEnabled ? { tools: buildCallTools() } : {}),
        ...(callbackUrl === undefined
          ? {}
          : { functionCalling: { serverMessageUrl: callbackUrl, serverMessageSignature: signature } }),
      }
    },
  }
}

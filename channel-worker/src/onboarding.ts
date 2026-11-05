/**
 * 引导模式(2026-09-18,Ben:「引导部分的 UI 还是按住说话和打字回答,不是通话模式吗」)。
 *
 * 以前引导是跑在 DSH 会话里的一条文字对话:手机把用户的话 POST 进去,模型按秒思考,
 * 回复再走一次非流式 TTS —— 扫码到听见开场白大约十秒。现在**由房间里的工人接话**:
 * 同一条通话链路(VAD → ASR → deepseek-v4-flash → 流式 TTS),只是把「引导技能 + 当前阶段
 * 要问什么 + 值的形状」换进系统提示,并多给一件工具 `record_answer` 往阶段机交答案。
 *
 * **阶段机一个字没改**:答案还是 `POST /onboarding/answer`,推进由服务端决定,
 * 两端(电脑上的文字引导、手机上的通话)共享同一份 onboarding.json。
 *
 * 这个文件里全是纯函数 + 一个不碰 LiveKit 的工具工厂;房间那一层在 agent.ts 里接线。
 */
import { llm } from '@livekit/agents'
import type { WorkbenchClient } from './workbench.ts'

/**
 * 引导开场白(维护者亲笔,一字不改)。**与 workbench-plugin/src/server/onboardingStages.ts 的 `OPENING_LINE` 逐字相同**
 * —— 两边互不 import,用例拿那个文件的原文对一遍(tests/onboarding-polish-0923.test.ts)。
 *
 * 为什么工人这边要有一份(2026-09-23 统筹第三轮 T):手机配对后进电话引导,第一句就是它,
 * 以前每次都现合成(一百来字),接通到出声要好几秒。它是定死的一句,和提机那句「老板,有什么吩咐?」
 * 同一个道理 —— 工人启动就合好放进 GreetingCache,引导一开口直接发缓存的帧,不经模型、不等合成。
 */
export const ONBOARDING_OPENING_LINE
  = '你好,很高兴认识你,我是你的专属事务官。我能够帮助你更轻松、更有条理的经营你的事业,为了后面的工作能顺利开展,我需要对你和你正在做的事有一些了解,首先,你希望我怎么称呼你?'

/** 要预热进 GreetingCache 的引导那几句(现在只有开场白;别的段的种子句由模型接着说,不走这条路)。 */
export const ONBOARDING_PREWARM_LINES: readonly string[] = [ONBOARDING_OPENING_LINE]

/**
 * ——— 开场白切成两块:第一小句立刻出声、不可打断 ———
 *
 * ## 2026-09-27 那 34 秒是怎么来的(卡 fix/voice-onboarding-latency)
 *
 * 全新 Air、手机小米免提放在房间里进「语音引导」,34 秒才听见第一句。诊断包里的账是:
 * `tts_first_ms: 737, publish_ms: 33291` —— 第一句的音频 **0.7 秒就合好了**,
 * 然后 **33 秒没发进房**。所以慢的不是模型,也不是合成。
 *
 * 框架那一段(@livekit/agents 1.9 `agent_activity.js`):`ttsTask` 转发第一帧之前会调
 * `reconcilePlayoutPause()` —— 只要「这一句允许被打断 + 这会儿不在说话 + 用户不是静音态」,
 * 它就**先把音频播出暂停**,等「误判打断」那个定时器来放。免提摆在房间里,VAD 一直听见声音,
 * `userSilenceEvent` 一直是清的 —— 于是那句固定开场白被按在那儿,直到手机挂断才放出来。
 * (09-24 那次「引导语音听不到」大概是同一件事,当时记成了「换提示词把它截断」。)
 *
 * ## 所以怎么改
 *
 * 那一句 `allowInterruptions: false`:上面那道暂停的第一个条件就不成立,第一帧直接出门;
 * 同时它也不用再等 `userSilenceEvent`(`ttsTask` 只在允许打断时等静音)。
 *
 * **但只有第一小句这样**。整段一百来字念完要十九秒(真机 `tts_all_ms: 19381`),
 * 全程不可打断的话他想插一句「知道了」都插不进去 —— 那是另一种难受。
 * 所以切在第一个句号:「你好,很高兴认识你,我是你的专属事务官。」先出声、按住不许暂停;
 * 剩下的那一长段照旧可打断。
 */
export function openingPieces(line: string): string[] {
  const text = line.trim()
  if (text === '') return []
  // 第一个句号(中文/英文)之后就切一刀。问号叹号不切:开场白第一小句是陈述句,
  // 拿问号切会把「你希望我怎么称呼你?」那一问切成第一块,他还没听见自我介绍就被问了。
  const at = [...text].findIndex(ch => ch === '。' || ch === '.')
  const chars = [...text]
  if (at < 0 || at + 1 >= chars.length) return [text]
  return [chars.slice(0, at + 1).join(''), chars.slice(at + 1).join('')]
}

/** `session.say()` 那几个参数里这一条路用得上的。 */
export interface OpeningSayOptions {
  /** `false` = 这一句不许被打断,也**不许被那道「用户在说话」的播出暂停**按住。 */
  allowInterruptions: boolean
}

/**
 * 把开场白说出去:**第一小句不可打断(立刻出声)、剩下的照旧**。见 {@link openingPieces}。
 *
 * `say` 抛了不许把这一通带走:少半句也比一片安静强(09-27 现场就是一片安静)。
 * 纯编排 —— 不认识 LiveKit,用例注入一个记账的 `say`。
 */
export function speakOpeningLine(
  line: string,
  say: (text: string, options: OpeningSayOptions) => void,
): void {
  const pieces = openingPieces(line)
  for (const [index, piece] of pieces.entries()) {
    try { say(piece, { allowInterruptions: index > 0 }) }
    catch { /* 见上:这一句没说出去,不是这一通的死因 */ }
  }
}

/**
 * 一题一答 / 一段一段来 / 喊停就停 / 不说内部话(2026-09-23 统筹第三轮 V / Y / W / AA)。
 * 与工作台 `onboardingStages.TURN_RULES` 同义(工作台那份进 DSH 会话第一条消息,这份进电话的系统提示)。
 */
export const PHONE_TURN_RULES: readonly string[] = [
  '- **一次只问一件事**:一句话里只有一个问句。复述之后要么问「对吗」,要么问下一题,不两个都来,也不追加「另外……」。',
  '- **一段一段来**:这一段标「必答」的问完之前,不问后面几段的题(授权没问完别问作息、音乐、常用应用);他顺口说了后面的事,记在心里,到那一段再用。',
  '- **他喊停就停**:他说「没了」「下一步」「先这样」「就这些」「跳过」,这一段就收 —— 排期、假期、细节都不再追问;'
  + '没问到的可选项留空,必答项按默认记,并明说一句「X 我先按 Y 来,以后随时能改」,然后记 done 进下一段。',
  '- **不说内部话**:「按流程」「系统那边」「工作台要求」「正式问一次」「这一题要先问出口」一个字都不说;'
  + '他已经说出口的答案(称呼、名字、习惯)直接记,不用为了「问过」再问一遍。工具回话里说没记上,照它做,但别把这些规矩念给他听。',
  // 2026-09-24 真机第五轮 4 / 5:改完称呼又宣告一遍「那我以后就这么叫你了」;他答了「产品研发」她又复述求「对吗」。
  '- **答得明确就不求确认**:他答得清清楚楚(「产品研发」「叫我 Ben」),直接记、往下走,不复述一遍再问「对吗」;'
  + '只有他答得含糊、两头都沾,才确认一次。称呼确认过一次就算数,之后不再宣告「那我以后就这么叫你了」,改了称呼也只是下一句开头叫他一声新的。',
  // 2026-09-24 真机第五轮 6:好几轮十几秒才说完,解释布局那轮说了一大段。
  '- **电话里要短**:每轮**最多两句、一个问题,一般不超过 40 个字**。工具回话里给了下一题,就只问那一题,前面最多垫一个「好。」;'
  + '他问「为什么」就一句话答完,不展开讲每一套有什么。',
  // 2026-09-24 真机第五轮(统筹补的那一句):他问「你为什么问我那句对吗」,她答了一段「是我猜的,得你点头我才敢往下记 —— 记错了后面整个桌子都摆歪了」。
  '- **不替自己辩解**:他问「你为什么问这个 / 为什么说对吗」,一句话答完(或者一句「好,不问了」)就直接问下一题;'
  + '不解释你自己心里怎么想、为什么这么做(「是我猜的」「我才敢往下记」),不打比方(「桌子摆歪了」)。',
  // 2026-09-24 真机第五轮 7:「——」「「」」、括号、省略号、拆开的字母让合成的语气怪。
  '- **说的话会被合成念出来**:不用破折号、引号、书名号、括号、省略号,停顿用逗号句号;英文名写成一个词(Ben),**不拆成字母**(不写「B e n」)。',
]

/**
 * 电话里接着做引导时让她开口的那一句指示(2026-09-24 真机第五轮)。
 * 以前是「先用一句话招呼他:上次做到这儿,接着吗?」—— 0923 已定不问「上次到哪」、不念内部断线。
 */
export const ONBOARDING_RESUME_INSTRUCTION
  = '直接问他还没答的那一题,一句话、一个问句;不寒暄进度(不问做到哪了、要不要继续),不提电话断过、换了设备;问过的不再问。'

/** 手机在房间里说「我在做引导」的那条消息能带的动作。 */
export const ONBOARDING_ACTIONS = ['start', 'resume', 'say', 'stop'] as const
export type OnboardingAction = typeof ONBOARDING_ACTIONS[number]

/** 往阶段机交一项答案的工具名。 */
export const TOOL_RECORD_ANSWER = 'record_answer'

/** 去扫一遍他电脑上的仓库(2026-09-20)。 */
export const TOOL_SCAN_PROJECTS = 'scan_projects'

/**
 * 读一个项目的说明和最近的记录(2026-09-24,已有项目拉齐;维护者:「我真的很需要她能扫仓库啊,不然我还得口述一遍吗」)。
 * 他从候选里挑中了、或者后面说「你再看看」时用;只找到一个时 `scan_projects` 已经顺手读好了。
 */
export const TOOL_READ_PROJECT = 'read_project'

/**
 * 读目录的那一问(维护者 09-24 拍板:授权问一句就够,找它、读它一起问,仍记 read_scan_roots)。
 * **与 workbench-plugin/src/server/projectBrief.ts 的 `ASK_TO_READ` 逐字相同** —— 两边互不 import,
 * 用例拿那个文件的原文对一遍(tests/onboarding-project-brief.test.ts)。
 */
export const ASK_TO_READ = '为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?'

/** 改一项**已经记过**的(2026-09-20,Ben:「包括它说不能改,我当时一度想要停下」)。 */
export const TOOL_CORRECT_ANSWER = 'correct_answer'

/** 算「到那天还有几个工作日」(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」)。 */
export const TOOL_COUNT_WORKDAYS = 'count_workdays'

/**
 * 引导落地(2026-09-24 晚,卡 feat/onboarding-materialize;维护者:「结束的时候应该可以直接生成事项,然后它自己开始派活吧?」)。
 * `setup_preview`:把今天说的摆成一张单子放上屏(8791 `POST /onboarding/materialize/preview`),回话里是**唯一要说的那一句**;
 * `setup_apply`:他说「可以 / 就这样」才落(`POST /onboarding/materialize/apply`),落完只说回话里那一句(「派出去了,做完叫你。」)。
 */
export const TOOL_SETUP_PREVIEW = 'setup_preview'
export const TOOL_SETUP_APPLY = 'setup_apply'

/** 值的形状。与 workbench-plugin/src/server/onboardingStages.ts 的 KeyKind 同一串字符串。 */
export type OnboardingKeyKind
  = 'string' | 'bool' | 'tri' | 'mode' | 'persona' | 'knob' | 'time' | 'strings' | 'project' | 'idea' | 'apps' | 'plan'
  // 2026-09-21(布局模板,引导 ①′):product / ops。跟 mode / persona 一样是一个短枚举串,
  // 所以下面 coerceAnswerValue 走同一支 —— 当文字,只去引号,不 JSON.parse
  // (模型偶尔会把它写成 "product",带着引号交上去会被阶段机 400)。
  | 'template'

export interface OnboardingKeyBrief {
  name: string
  kind: OnboardingKeyKind
  desc: string
  required: boolean
}

/** `GET /onboarding/brief` 的回包。字段缺了就当没有 —— 老工作台没有这条路。 */
export interface OnboardingBrief {
  stage: string
  label: string
  done: boolean
  seed?: string
  speak_seed: boolean
  goals: readonly string[]
  keys: readonly OnboardingKeyBrief[]
  answered: Record<string, string[]>
  nickname?: string
  mode?: string
  focus?: string
  recap?: string
  /**
   * 日历(2026-09-20)。今天几号星期几、接下来的法定假期、已记下的截止日还剩几个工作日 ——
   * 工作台那边用 `holidays.ts` 算的。老工作台没有这一格,缺席时**一个日期都别自己算**。
   */
  calendar?: string
  plan?: readonly string[]
  skill?: string
  skill_note?: string
  askedAt?: string
  /**
   * 这台电脑上**扫到装了**的那几家(2026-09-18,引导 ④ 习惯那一问「你平时最常开哪几个应用」)。
   * 只有问应用的那一段才有;没扫过整格缺席 —— 缺席时**一家都别念**,不猜他装了什么。
   */
  installed_apps?: readonly { key: string, label: string }[]
  /**
   * **这台电脑上真装了、而且真有记录可读的那几家 AI**(2026-09-27,卡 OB;展示名,工作台探的)。
   *
   * 「能不能读它们记着的东西」那一问的名单**只能是这一份**:念名单里的,一家都不许自己加。
   * 空数组 = 探过了一家都没有 → **那一问整个不问**;缺席 = 老工作台没这一格,照旧(别自己编一份名单)。
   */
  memory_families?: readonly string[]
  /**
   * 这会儿引导归谁管(2026-09-18,Ben:「如果手机已经扫码,优先手机的引导流程」)。
   * `'desktop'` = 人在电脑上按了「改在电脑上做」—— 工人**一个字都不说**,
   * 手机照它显示「电脑上在做,先别说」并给一颗「改回手机」。
   * 老工作台没有这一格;缺席时按「手机」办(手机打进来本来就是要在手机上做)。
   */
  leader?: string
  /**
   * 落地单子(2026-09-24 晚):引导做完了、单子还等他点头时 `pending: true` —— 工人别急着换回平时那套,
   * 留着 setup_apply。老工作台没有这一格。
   */
  setup?: { pending: boolean, id?: string, line?: string, applied?: boolean }
}

/** 简报读不懂时的兜底:宁可不接引导,也不要拿一份猜出来的阶段去问人。 */
export function parseOnboardingBrief(body: unknown): OnboardingBrief | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const raw = body as Record<string, unknown>
  if (typeof raw.stage !== 'string' || raw.stage === '') return undefined
  const keys: OnboardingKeyBrief[] = Array.isArray(raw.keys)
    ? raw.keys.flatMap((item) => {
        const key = (item ?? {}) as Record<string, unknown>
        if (typeof key.name !== 'string' || typeof key.kind !== 'string') return []
        return [{
          name: key.name,
          kind: key.kind as OnboardingKeyKind,
          desc: typeof key.desc === 'string' ? key.desc : '',
          required: key.required === true,
        }]
      })
    : []
  return {
    stage: raw.stage,
    label: typeof raw.label === 'string' ? raw.label : raw.stage,
    done: raw.done === true,
    ...(typeof raw.seed === 'string' ? { seed: raw.seed } : {}),
    speak_seed: raw.speak_seed === true,
    goals: Array.isArray(raw.goals) ? raw.goals.filter((item): item is string => typeof item === 'string') : [],
    keys,
    answered: (raw.answered !== null && typeof raw.answered === 'object' ? raw.answered : {}) as Record<string, string[]>,
    ...(typeof raw.nickname === 'string' ? { nickname: raw.nickname } : {}),
    ...(typeof raw.mode === 'string' ? { mode: raw.mode } : {}),
    ...(typeof raw.focus === 'string' ? { focus: raw.focus } : {}),
    ...(typeof raw.recap === 'string' ? { recap: raw.recap } : {}),
    ...(typeof raw.calendar === 'string' ? { calendar: raw.calendar } : {}),
    ...(Array.isArray(raw.plan) ? { plan: raw.plan.filter((item): item is string => typeof item === 'string') } : {}),
    ...(typeof raw.skill === 'string' ? { skill: raw.skill } : {}),
    ...(typeof raw.skill_note === 'string' ? { skill_note: raw.skill_note } : {}),
    ...(typeof raw.askedAt === 'string' ? { askedAt: raw.askedAt } : {}),
    ...(typeof raw.leader === 'string' ? { leader: raw.leader } : {}),
    ...(raw.setup !== null && typeof raw.setup === 'object'
      ? (() => {
          const setup = raw.setup as Record<string, unknown>
          return {
            setup: {
              pending: setup.pending === true,
              ...(typeof setup.id === 'string' ? { id: setup.id } : {}),
              ...(typeof setup.line === 'string' ? { line: setup.line } : {}),
              ...(setup.applied === true ? { applied: true } : {}),
            },
          }
        })()
      : {}),
    ...(Array.isArray(raw.memory_families)
      ? { memory_families: raw.memory_families.filter((item): item is string => typeof item === 'string' && item !== '') }
      : {}),
    ...(Array.isArray(raw.installed_apps)
      ? {
          installed_apps: raw.installed_apps.flatMap((item) => {
            const app = (item ?? {}) as Record<string, unknown>
            if (typeof app.key !== 'string' || app.key === '') return []
            return [{ key: app.key, label: typeof app.label === 'string' && app.label !== '' ? app.label : app.key }]
          }),
        }
      : {}),
  }
}

/** 这份简报说的是「引导归电脑管」吗。缺席 = 归手机(老工作台没有这一格)。 */
export function leadsOnDesktop(brief: Pick<OnboardingBrief, 'leader'>): boolean {
  return brief.leader === 'desktop'
}

/**
 * 模型给的值 → 阶段机要的值。
 *
 * 为什么不让模型直接给 JSON 值:function calling 的参数 schema 里「任意类型」在各家实现上都不稳,
 * 所以 `value` 一律声明成字符串,由这里按**当前阶段那个 key 的形状**还原。
 * 还原不了就原样交上去 —— 阶段机会 400 并回一句人话,模型照着改,比我们在这里猜强。
 */
export function coerceAnswerValue(kind: OnboardingKeyKind | undefined, raw: string): unknown {
  const text = raw.trim()
  if (text === '') return text
  const json = (): unknown => {
    try { return JSON.parse(text) }
    catch { return undefined }
  }
  switch (kind) {
    // 文字类:一律当文字。模型把称呼答成「5」时不能变成数字 5。
    case 'string':
    case 'time':
    case 'mode':
    case 'persona':
    case 'template':
      return stripQuotes(text)
    case 'bool': {
      const parsed = json()
      if (typeof parsed === 'boolean') return parsed
      if (/^(是|对|可以|好|yes|y)$/i.test(text)) return true
      if (/^(否|不|不可以|不行|no|n)$/i.test(text)) return false
      return stripQuotes(text)
    }
    case 'tri': {
      const parsed = json()
      if (typeof parsed === 'boolean') return parsed
      if (/^(可以|yes|true)$/i.test(text)) return true
      if (/^(要问|ask|问我)$/i.test(text)) return 'ask'
      if (/^(不可以|不行|no|false)$/i.test(text)) return false
      return stripQuotes(text)
    }
    case 'knob': {
      const parsed = json()
      if (typeof parsed === 'number') return parsed
      const digits = /^-?\d+$/.exec(text)
      return digits === null ? stripQuotes(text) : Number(text)
    }
    // 应用名:电话里他一口气念好几个,模型多半交上来一串「Claude、微信」而不是 JSON 数组。
    // 这里按顿号 / 逗号 / 空格切开 —— 阶段机要的是数组,切不开的原样交上去让它回一句人话。
    case 'apps': {
      const parsed = json()
      if (Array.isArray(parsed)) return parsed
      // 只按分隔符切,**不按空格**:「Claude Code」是一个应用名,切开就认不出来了。
      const parts = text.split(/[,,、;;\/|]+/).map(item => stripQuotes(item.trim())).filter(item => item !== '')
      return parts.length === 0 ? text : parts
    }
    case 'strings':
    case 'project':
    case 'idea':
    case 'plan': {
      const parsed = json()
      return parsed === undefined ? text : parsed
    }
    default: {
      const parsed = json()
      return parsed === undefined ? text : parsed
    }
  }
}

function stripQuotes(text: string): string {
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('「') && text.endsWith('」')))) {
    return text.slice(1, -1)
  }
  return text
}

/** 阶段机回包 → 一句给模型看的话。**办不成也要有话可说**(D13:最坏的失真是「答应了但其实没记」)。 */
export function answerResultText(input: { status: number, body: unknown }): { ok: boolean, advanced: boolean, text: string } {
  const body = (input.body ?? {}) as Record<string, unknown>
  if (input.status !== 200) {
    const error = typeof body.error === 'string' ? body.error : '工作台拒绝了,没说原因'
    return {
      ok: false,
      advanced: false,
      // 409 多半是「这一项是前面某一段记过的」——那条路是改,不是重记。把它写进回话里,
      // 不然模型只会对他说一句「没记上」(2026-09-20 本机真跑里连着出现过四次)。
      text: `没记上:${error} 照这句改一遍再记;要改之前记过的那一项就用 ${TOOL_CORRECT_ANSWER}。`
        + '如实告诉他这次没记上,**别说「改不了」**,也别假装记下了。',
    }
  }
  const advanced = body.advanced === true
  const done = body.done === true
  const next = (body.next ?? undefined) as { label?: unknown, seed?: unknown } | undefined
  const note = typeof body.note === 'string' ? `(${body.note})` : ''
  // 2026-09-24 晚(维护者「结束环节的大总结听得我好累」):不再照复述清单念一遍、不念文件路径;单子摆上屏,只说一句。
  if (done && body.setup_next === true) {
    return {
      ok: true,
      advanced: true,
      text: `记下了${note}。引导记完了。**紧接着调 ${TOOL_SETUP_PREVIEW}**,把单子摆上屏;只说它回的那一句,别的不念、不复述、不念文件路径。`,
    }
  }
  if (done) return { ok: true, advanced: true, text: `记下了${note}。引导做完了。只说一句「都记好了,有事叫我。」,不复述、不念文件路径。` }
  if (!advanced) return { ok: true, advanced: false, text: `记下了${note}。这一阶段还没完,接着弄清剩下的,一次只问一件事。` }
  const label = typeof next?.label === 'string' ? next.label : '下一段'
  const seed = typeof next?.seed === 'string' ? next.seed : undefined
  return {
    ok: true,
    advanced: true,
    text: `记下了${note}。这一阶段完了,接下来是「${label}」。`
      + (seed === undefined ? '' : `**紧接着**照这个意思问他,别停下来等:「${seed}」`),
  }
}

/**
 * 更正的回包 → 一句给模型看的话(2026-09-20)。
 *
 * 404(那一项还没答过)要**把出路写出来**:改调 record_answer。不然模型只会回一句
 * 「改不了」—— 那正是 Ben 早上听到的那句「这个名字的改动我这会儿没能记上」。
 */
export function correctResultText(input: { status: number, body: unknown }): { ok: boolean, text: string } {
  const body = (input.body ?? {}) as Record<string, unknown>
  if (input.status === 404) {
    return {
      ok: false,
      text: `这一项还没记过,所以没得改:${typeof body.error === 'string' ? body.error : ''}`
        + ` 改调 ${TOOL_RECORD_ANSWER} 记一次就行,**别告诉他改不了**。`,
    }
  }
  if (input.status !== 200) {
    const error = typeof body.error === 'string' ? body.error : '工作台拒绝了,没说原因'
    return { ok: false, text: `没改成:${error}。照这句改一遍再试;如实告诉他这次没改上,别假装改好了。` }
  }
  const also = typeof body.also === 'string' ? `(${body.also})` : ''
  return {
    ok: true,
    // 2026-09-24 真机第五轮:这里原来叫她「跟他确认一句『那我以后就这么叫你了』」,她下一轮又宣告一遍。
    text: `改好了${also}。**不宣告、不求确认**(不说「那我以后就这么叫你了」「对吗」),下一句开头用新的叫他一声就行,`
      + '接着问还没答的那一题,别把问过的再问一遍。',
  }
}

/**
 * 工作日回包 → 一句给模型看的话(2026-09-20)。
 *
 * 算不出来就说算不出来:**不许自己心算一个数顶上**。日期这件事他一听就知道对不对,
 * 编一个比问一句「你说的是几号」糟得多(D13)。
 */
export function workdaysResultText(input: { status: number, body: unknown }): { ok: boolean, text: string } {
  const body = (input.body ?? {}) as Record<string, unknown>
  if (input.status !== 200) {
    const error = typeof body.error === 'string' ? body.error : `工作台回了 ${input.status}`
    return { ok: false, text: `这个日子没算成:${error}。问他一句把日期说清楚,**别自己心算一个数**。` }
  }
  const text = typeof body.text === 'string' ? body.text : undefined
  if (text === undefined) return { ok: false, text: '回包读不懂,这次没算成。问他一句,别自己心算。' }
  const target = (body.target ?? undefined) as { date?: unknown, weekday?: unknown, why?: unknown } | undefined
  const targetText = typeof target?.date === 'string'
    ? `${String(target.date)} 是${String(target.weekday ?? '')}、${String(target.why ?? '')}。`
    : ''
  return { ok: true, text: `${targetText}${text} —— 照这个说给他听,别自己再算一遍。` }
}

/** 他说可以之后该怎么办(预览回话与落地模式的提示词共用)。 */
const SETUP_NEXT = `他说可以 / 就这样 / 行 → 调 ${TOOL_SETUP_APPLY};他说哪件不要(「视频那件不用」)→ 调 ${TOOL_SETUP_APPLY},skip 填他说的那几件;`
  + '他想改别的 → 说「你在屏幕上点改一下改,改完点就这样」,别调工具;他说先不落、回头再说 → 说「好,单子放在屏幕上,你想好了点就这样」,别调工具。'

/** 预览回包 → 给模型的一段话:**只说那一句**。 */
export function setupPreviewText(input: { status: number, body: unknown }): { ok: boolean, id?: string, text: string } {
  const body = (input.body ?? {}) as Record<string, unknown>
  if (input.status === 404) {
    return { ok: false, text: '这台工作台还没有落地这一步(或者还没什么可落的):只说一句「都记好了,有事叫我。」,别念清单、别念文件路径。' }
  }
  if (input.status !== 200 || typeof body.line !== 'string' || body.line.trim() === '') {
    const error = typeof body.error === 'string' ? body.error : `工作台回了 ${input.status}`
    return { ok: false, text: `单子没摆上屏:${error}。只说一句「都记好了,单子我等会儿摆到屏幕上。」,别念清单。` }
  }
  return {
    ok: true,
    ...(typeof body.id === 'string' ? { id: body.id } : {}),
    text: `单子已经摆上屏了。**只说这一句**,别的不念、不复述、不念文件路径:「${body.line.trim()}」\n${SETUP_NEXT}`,
  }
}

/** 落地回包 → 给模型的一段话。**说到做到**:落好了才说那一句;他没点头就去问。 */
export function setupApplyText(input: { status: number, body: unknown }): { ok: boolean, text: string } {
  const body = (input.body ?? {}) as Record<string, unknown>
  const error = typeof body.error === 'string' ? body.error : `工作台回了 ${input.status}`
  if (input.status === 409) return { ok: false, text: `先别落:${error}` }
  if (input.status !== 200 || typeof body.line !== 'string') {
    return { ok: false, text: `没落成:${error}。如实说一句「没落上,你在屏幕上点一下就这样」,别说落好了。` }
  }
  const result = (body.result ?? {}) as { unmatched?: unknown }
  const unmatched = Array.isArray(result.unmatched) ? result.unmatched.filter((one): one is string => typeof one === 'string') : []
  return {
    ok: true,
    text: `落好了。**只说这一句**:「${body.line.trim()}」`
      + (unmatched.length === 0 ? '' : `\n他说不要的「${unmatched.join('、')}」我没认出是单子上哪一件,那几件照落了;问他一句是哪件,让他在屏幕上改。`),
  }
}

/** 扫回来的一个仓库。与 workbench-plugin/src/server/onboardingScan.ts 的 ScannedRepo 同一份形状。 */
export interface ScannedRepo {
  name: string
  path: string
  last_commit?: string
  summary: string
}

export interface ScanResult {
  repos: readonly ScannedRepo[]
  total: number
  more: number
  errors: readonly { root: string, reason: string }[]
}

/** 8791 的回包 → 仓库清单。读不懂就 undefined(**不编一份清单**)。 */
export function parseScanResult(body: unknown): ScanResult | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const raw = body as Record<string, unknown>
  if (!Array.isArray(raw.repos)) return undefined
  const repos: ScannedRepo[] = raw.repos.flatMap((item) => {
    const repo = (item ?? {}) as Record<string, unknown>
    if (typeof repo.name !== 'string' || repo.name === '') return []
    return [{
      name: repo.name,
      path: typeof repo.path === 'string' ? repo.path : '',
      ...(typeof repo.last_commit === 'string' ? { last_commit: repo.last_commit } : {}),
      summary: typeof repo.summary === 'string' ? repo.summary : '',
    }]
  })
  return {
    repos,
    total: typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : repos.length,
    more: typeof raw.more === 'number' && Number.isFinite(raw.more) ? raw.more : 0,
    errors: Array.isArray(raw.errors)
      ? raw.errors.flatMap((item) => {
          const entry = (item ?? {}) as Record<string, unknown>
          if (typeof entry.root !== 'string') return []
          return [{ root: entry.root, reason: typeof entry.reason === 'string' ? entry.reason : '没说原因' }]
        })
      : [],
  }
}

/**
 * 工作台回包里的那段「怎么说」(`note`)。**原样**交给模型(2026-09-24,已有项目拉齐):
 * 话术只写在工作台一处(workbench-plugin/src/server/projectBrief.ts),电话与电脑两条路照同一段说。
 * 老工作台没有就 undefined。
 */
export function noteOf(body: unknown): string | undefined {
  const note = (body as { note?: unknown } | null)?.note
  return typeof note === 'string' && note.trim() !== '' ? note : undefined
}

/**
 * 老工作台 403 不带 note 时的兜底(与工作台那段同一个意思)。
 * 改口那一问**直接照那句问**(2026-09-24 下午小修):以前写「照这句再问一遍」,她就说成「那我再问一遍确认:……」。
 */
const READ_CONSENT_FALLBACK
  = '还没有读目录的授权,所以没找也没读。**先问后看**:先问他一句'
    + `「${ASK_TO_READ}」,**等他说可以**,再把 read_scan_roots 记成 true,然后再去找、去读;没问之前一个目录都不看。`
    + '他说不可以:应一句就过去,改成问他,别再提读目录。'
    + '他后来改口说「你去看吧」:直接照这句问他,像头一回问那样,不提前面问过,也不说「确认一下」这类话;他答了可以再记、再读。'
    + '别先看了再补一句「顺手记成可以了」。'

/** 老工作台读好了却没带 note 时的兜底(同一个意思,短一些)。 */
const BRIEF_NOTE_FALLBACK
  = '先说一句读了哪几份,再用两句以内复述它做什么、给谁、现在到哪,最后只问「是这个吗?」;'
    + '他点头或纠正之后才记 project(path 原样带上)。路径、文件名、提交号别念;摘要里没有的不编。'

/**
 * 403 → 给模型的一段话。两种:
 *   - `reason:'branch'`:新点子 / 运营那一支,**不找也不读** —— 别再调、别提;
 *   - 其余(没授权;老工作台不带 reason 也按这个):工作台给的「先问后看」用法**原样**交出去,
 *     后面补一句电话里用哪件工具记、用哪件工具找。
 *
 * 403 那不是「扫不了」,那是**还没给授权**。出路是问他一句、他点头、把 `read_scan_roots` 记成 true,
 * 然后再找 —— 这条路要写在回话里,不然模型只会说一句「我没有权限」就算了。
 */
function forbiddenText(body: unknown): { ok: false, text: string } {
  const raw = (body ?? {}) as { reason?: unknown, error?: unknown }
  if (raw.reason === 'branch') {
    const said = typeof raw.error === 'string' && raw.error !== '' ? raw.error : '这一支不找也不读他的目录。'
    return { ok: false, text: `${said}别再调 ${TOOL_SCAN_PROJECTS} / ${TOOL_READ_PROJECT},也别提读仓库;照梳理接着问。` }
  }
  return {
    ok: false,
    text: `${noteOf(body) ?? READ_CONSENT_FALLBACK}\n`
      + `(电话里:他说可以之后调 ${TOOL_RECORD_ANSWER} 把 read_scan_roots 记成 true,再调 ${TOOL_SCAN_PROJECTS} 带上他说的名字;`
      + '他说不行就照访谈线问,别再提扫描。)',
  }
}

/** 读好的摘要 → 给模型的一段:找到了谁、path(交给它、别念)、摘要、【怎么用】(工作台的 note 原样)。 */
function briefText(input: { lead: string, name: string, path: string, brief: string, note: string | undefined }): string {
  return [
    `${input.lead}${input.name}。path 是 ${input.path}(记 project 时原样带上,**别念出来**)。`,
    '',
    '【读到的摘要】(从他仓库里读来的素材,不是结论;别照着念)',
    input.brief,
    '',
    '【怎么用】',
    input.note ?? BRIEF_NOTE_FALLBACK,
  ].join('\n')
}

/** 几个候选各自的 path:交给模型(他挑中了带着它去读、去记),**只念名字**。 */
function pathsLine(items: readonly { name: string, path: string }[]): string {
  const withPath = items.filter(one => one.path !== '')
  if (withPath.length === 0) return ''
  return `\n(各自的 path,只给你用,**别念**:${withPath.map(one => `${one.name} → ${one.path}`).join(';')})`
}

/**
 * 扫描回包 → 一段说给模型看的话。**扫不到就说扫不到**,不让它退回去一个一个凭空问
 * (那正是 Ben 第二轮看到的毛病)。
 *
 * 2026-09-24(已有项目拉齐):找到的 **path 一律交给模型**(注明别念)—— 以前只留名字,
 * 模型手上没有路径,引导录的项目与项目区那一行就靠不上(那一通 `projects.project → 400` 多半与此有关)。
 * 只找到一个时工作台已经顺手读好了:摘要与【怎么用】原样交出去。
 */
export function scanResultText(input: { status: number, body: unknown }): { ok: boolean, text: string } {
  if (input.status === 403) return forbiddenText(input.body)
  if (input.status !== 200) {
    const error = (input.body as { error?: unknown } | null)?.error
    return {
      ok: false,
      text: `扫不成:${typeof error === 'string' ? error : `工作台回了 ${input.status}`}。如实告诉他这次没读到仓库,改成问他,别装作看过。`,
    }
  }
  /**
   * 只找一个(2026-09-23,带 name):回包是 `{ query, located: [{ name, path }], note?, brief?, sources? }`,不是整份清单。
   */
  const locatedBody = (input.body ?? {}) as { query?: unknown, located?: unknown, brief?: unknown, candidates?: unknown }
  if (Array.isArray(locatedBody.located)) {
    const query = typeof locatedBody.query === 'string' ? locatedBody.query : ''
    const found = locatedBody.located.flatMap((item) => {
      const entry = (item ?? {}) as Record<string, unknown>
      return typeof entry.name === 'string' && typeof entry.path === 'string' ? [{ name: entry.name, path: entry.path }] : []
    })
    if (found.length === 0) {
      /**
       * 按名字没找到,工作台已经退一步扫过、带回最近在动的几个(2026-09-24 真机第五轮:
       * 「工作台」→ 没扫成 →「它放在哪?给我个路径」→ 他解释半天又没扫成,真仓库叫 desktop-workbench)。
       */
      const candidates = Array.isArray(locatedBody.candidates)
        ? locatedBody.candidates.flatMap((item) => {
            const entry = (item ?? {}) as Record<string, unknown>
            return typeof entry.name === 'string' ? [{ name: entry.name, path: typeof entry.path === 'string' ? entry.path : '' }] : []
          })
        : []
      if (candidates.length > 0) {
        const shown = candidates.slice(0, 5)
        return {
          ok: true,
          text: `按名字没找到「${query}」,我已经看了一眼,最近在动的是:${shown.map(one => one.name).join('、')}。`
            + `**一句话把这几个名字念给他挑**(「我看到最近在动的有 A、B、C,是哪一个?」),名字里的连字符念成空格或直接连读,别念路径,**别让他报路径**。`
            + `他挑中了调 ${TOOL_READ_PROJECT} 带上那一个的 path 读它,读回来照【怎么用】说;记 project 时 path 原样带上。`
            + pathsLine(shown),
        }
      }
      return {
        ok: false,
        text: `在放仓库的目录里没找到叫「${query}」的,也没扫出别的。问他一句它大概放在哪;他说了位置就把那个位置当 name 再调一次 ${TOOL_SCAN_PROJECTS}(文稿 = ~/Documents,桌面 = ~/Desktop)。`,
      }
    }
    if (found.length === 1) {
      const one = found[0]!
      const brief = typeof locatedBody.brief === 'string' && locatedBody.brief.trim() !== '' ? locatedBody.brief : undefined
      if (brief !== undefined) {
        return { ok: true, text: briefText({ lead: '找到了,也读好了:', name: one.name, path: one.path, brief, note: noteOf(input.body) }) }
      }
      // 老工作台(或说明没读成):只有名字与路径。路径交给模型,别念;要读就调 read_project。
      const note = noteOf(input.body)
      return {
        ok: true,
        text: `找到了:${one.name}。path 是 ${one.path}(记 project 时原样带上,**别念出来**)。`
          + '跟他对一句「是这个吗」,是就只聊这一个,别的一个都不提。'
          + `要读它的说明和最近的记录,调 ${TOOL_READ_PROJECT} 带上这个 path。`
          + (note === undefined ? '' : `\n工作台的话:${note}`),
      }
    }
    return {
      ok: true,
      text: `找到 ${found.length} 个像的:${found.map(one => one.name).join('、')}。一句话只念名字给他挑,路径别念;`
        + `他挑中了调 ${TOOL_READ_PROJECT} 带上那一个的 path 读它,读回来照【怎么用】说;只录他挑的那个。`
        + pathsLine(found),
    }
  }
  const result = parseScanResult(input.body)
  if (result === undefined) return { ok: false, text: '扫描回来的东西读不懂,这次当作没扫到。如实说一句,改成问他。' }
  if (result.repos.length === 0) {
    const why = result.errors.length === 0
      ? '那几个目录里一个 git 仓库都没有。'
      : `那几个目录读不到:${result.errors.map(item => `${item.root}(${item.reason})`).join(';')}。`
    return { ok: false, text: `${why}如实告诉他,改成问他手上在做什么。` }
  }
  const lines = result.repos.map(repo => `- ${repo.name}:${repo.summary}`)
  const more = result.more > 0 ? `(还有 ${result.more} 个没列出来)` : ''
  const recent = result.repos.slice(0, 2).map(repo => repo.name).join('、')
  return {
    ok: true,
    text: [
      `扫到 ${result.total} 个仓库${more},最近动过的排在前面:`,
      ...lines,
      '',
      '**只念候选让他挑**,别一条条念完:「我看到最近在动的是'
      + `${recent},是哪个?」—— **他挑中的才录,没挑的一个都不记**;挑中了调 ${TOOL_READ_PROJECT} 带上它的 path 读一遍。`,
      '清单是**素材不是结论** —— 项目是什么、做到哪、下一步,都要他亲口说了才算;'
      + '仓库里看到的和他说的对不上就指出来,以他说的为准。路径和分支名别念出来,耳朵听不懂。'
      + pathsLine(result.repos),
    ].join('\n'),
  }
}

/**
 * 读项目的回包(`POST /onboarding/project-brief`)→ 给模型的一段话(2026-09-24)。
 * 读好了:摘要 + 【怎么用】(工作台的 note 原样);没授权 / 新点子那一支:同找项目那两句;
 * 路径不认(不在扫描根下、`..`、链接跳出、不存在):如实说没读成,**别自己猜里面写了什么**。
 */
export function projectBriefText(input: { status: number, body: unknown }): { ok: boolean, text: string } {
  const body = (input.body ?? {}) as { name?: unknown, path?: unknown, brief?: unknown, error?: unknown, reason?: unknown }
  if (input.status === 200 && typeof body.brief === 'string' && body.brief.trim() !== '') {
    return {
      ok: true,
      text: briefText({
        lead: '读好了:',
        name: typeof body.name === 'string' ? body.name : '这个项目',
        path: typeof body.path === 'string' ? body.path : '',
        brief: body.brief,
        note: noteOf(input.body),
      }),
    }
  }
  if (input.status === 403 && (body.reason === undefined || body.reason === 'consent' || body.reason === 'branch')) return forbiddenText(input.body)
  const error = typeof body.error === 'string' && body.error !== '' ? body.error : `工作台回了 ${input.status}`
  if (input.status === 400 || input.status === 403 || input.status === 404) {
    return {
      ok: false,
      text: `这个没读成:${error}。path 要用找项目时回的那个原样填;实在读不到就跟他说一句没读到,改成问他,**别自己猜里面写了什么**。`,
    }
  }
  return { ok: false, text: `没读成:${error}。如实跟他说一句这次没读到,改成问他,别装作读过。` }
}

/** 日志里那一行的尾巴:读了多少字、读了哪几份(**不记内容**)。 */
function readSummary(body: unknown): string {
  const raw = (body ?? {}) as { brief?: unknown, sources?: unknown, located?: unknown, candidates?: unknown }
  const parts: string[] = []
  if (Array.isArray(raw.located)) parts.push(`找到 ${raw.located.length} 个`)
  if (Array.isArray(raw.candidates)) parts.push(`候选 ${raw.candidates.length} 个`)
  if (typeof raw.brief === 'string') {
    const labels = Array.isArray(raw.sources)
      ? raw.sources.flatMap(source => typeof (source as { label?: unknown })?.label === 'string' ? [(source as { label: string }).label] : [])
      : []
    parts.push(`读了 ${Array.from(raw.brief).length} 字${labels.length > 0 ? `(${labels.join('、')})` : ''}`)
  }
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
}

/**
 * 「记」这一步最多等多久(毫秒),超过就先回话、后台接着落(2026-09-20「先说后记」)。
 *
 * 400ms:本机往 8791 打一个回环 POST 通常几十毫秒 —— 快的时候这条路和以前**一模一样**
 * (回话里照旧带着「下一段该问什么」那句,一个字都没少)。真正慢的是阶段机推进那一下要
 * `git commit` 一次记忆文件,那会花掉一两秒;那一两秒不该让他在电话里干等着。
 */
export const RECORD_WAIT_MS = 400

/**
 * 收尾那一段多等一会儿(2026-09-24 晚):最后一项交上去,阶段机要推进、存一个版本、再告诉她「接着调 setup_preview」——
 * 那句话赶不上回话就丢了,她就不知道该把单子摆上屏。收尾是自然的停顿点,多等几秒不碍事(先说后记:她已经应过一声了)。
 */
export const WRAPUP_RECORD_WAIT_MS = 4000

/**
 * 同一批(模型一口气交好几项)的窗口(2026-09-24 晚)。真机上 `projects.done` 先于 `projects.project` 到了工作台 ——
 * 阶段推进了,后面那一项 409,她只好靠 correct_answer 自救(而没答过的项 correct 也不收)。
 *
 * **这里只能排「同一拍里到的」**:LiveKit 解析流式回复时,前一件工具在下一件**开始吐**的那一刻就开跑,
 * 最后一件要等它自己的参数吐完 —— 「done 在前、project 在后」时两件相隔的是 project 那一大段参数的生成时间(几秒),
 * 什么时间窗都接不住,而且工人不知道后面还有没有下一件。所以:
 *   - 窗口取 0(下一拍就交,不给每一项平白加延迟),同一拍里到的照 {@link answerRank} 排:`done` 放最后,
 *     `import_memories` 放在 `read_client_files` 后面(先授权再拷,工作台才肯拷);
 *   - 系统提示里明说「同一口气交几项,done 最后一个调」;
 *   - 兜底在工作台:刚收尾的那一段、一分钟内晚到的一项照收(onboarding.ts `LATE_ANSWER_GRACE_MS`)。
 */
export const RECORD_BATCH_MS = 0

/** 同一批里的先后:数小的先交。 */
export function answerRank(key: string): number {
  if (key === 'done') return 2
  if (key === 'import_memories') return 1
  return 0
}

export interface OnboardingToolsDeps {
  workbench: WorkbenchClient
  /** 此刻那份简报(工人每次刷新都换掉),用来知道值的形状。 */
  brief: () => OnboardingBrief | undefined
  /** 交完一项之后:工人据此刷新简报、换系统提示。 */
  onAnswered?: (result: { ok: boolean, advanced: boolean }) => void
  /**
   * 让她**当场说一句**(不经模型)。现在只剩一处用:「先说后记」落盘失败时补一句
   * 「刚才那条我没记上」。接的是 `session.say`。
   *
   * 去扫仓库之前那句「我看一下你的仓库」**09-20 第二版搬到手机上了**(见 {@link onStart}):
   * 那是一句定死的话,每次去火山合成一次不划算,而且它和回答排在同一条发言队列里,
   * 本机实测会迟到。这一句留下来的理由正相反 —— 它是一条**更正**,内容跟着那一次失败走。
   */
  say?: (text: string) => void
  /**
   * 一件工具**开跑了**(2026-09-20 第二版)。工人据此往房间广播一条缓冲语信号,
   * 手机拿包里预先合成好的那句垫上(`scan_projects` 有自己专用的一句)。
   *
   * 为什么是「开跑」不是「跑完」:要垫的正是它跑着的那几秒。
   */
  onStart?: (tool: string) => void
  /**
   * 她最近问出口的那句 + 他之后说的那句(2026-09-23,见 dialogueTail.ts)。交答案时原样带给工作台,
   * 工作台据此判断「这一题是不是问出口了、他是不是点了头」。缺席 = 不带(老接线)。
   */
  heard?: () => { asked: string, reply: string } | undefined
  log?: (line: string) => void
  /** 等多久就先回话。缺省 {@link RECORD_WAIT_MS};测试调小。 */
  recordWaitMs?: number
  /** 收尾那一段等多久。缺省 {@link WRAPUP_RECORD_WAIT_MS}。 */
  wrapupWaitMs?: number
  /** 同一批的窗口。缺省 {@link RECORD_BATCH_MS}。 */
  batchMs?: number
}

/** 引导模式下多出来的几件工具:交一项答案 / 改一项 / 算工作日 / 找项目 / 读项目(2026-09-24)。 */
export function createOnboardingTools(deps: OnboardingToolsDeps) {
  const say = (text: string): void => {
    try { deps.say?.(text) }
    catch (err) { deps.log?.(`[channel-worker] 这一句没说出去:${(err as Error)?.message ?? '没说原因'}`) }
  }
  /** 开跑了说一声。**这一声炸了不许把工具带走** —— 垫一句是好意,不是主线。 */
  const started = (tool: string): void => {
    try { deps.onStart?.(tool) }
    catch { /* 见上 */ }
  }

  /**
   * 交答案的队列(2026-09-24 晚):同一批里重排(见 {@link answerRank}),而且**一项一项交** —— 前一项落定了再交下一项,
   * 工作台看到的顺序就是这里排好的顺序。
   */
  let batch: { key: string, run: () => Promise<void> }[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()
  const flush = (): void => {
    flushTimer = undefined
    const items = batch
    batch = []
    items.sort((a, b) => answerRank(a.key) - answerRank(b.key))
    for (const item of items) chain = chain.then(item.run, item.run)
  }
  const inOrder = <T>(key: string, send: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    batch.push({ key, run: async () => { try { resolve(await send()) } catch (error) { reject(error) } } })
    if (flushTimer === undefined) {
      flushTimer = setTimeout(flush, deps.batchMs ?? RECORD_BATCH_MS)
      ;(flushTimer as unknown as { unref?: () => void }).unref?.()
    }
  })
  /** 最近一次预览回来的单子 id(落地时带上,工作台据此认是哪一张)。 */
  let lastPlanId: string | undefined

  return {
    [TOOL_RECORD_ANSWER]: llm.tool({
      description:
        '把**刚刚弄清的一项**记进工作台的引导记录。每弄清一项就调一次,不要攒到最后一起交。'
        + '**先口头回应他,再调这件工具** —— 记录在后台落,不用等它回来才说话。'
        + 'stage 用系统提示里写的那个阶段值;key 只能是系统提示里列出来的那几个;'
        + 'value 按那一项说的形状写(文字直接写,是/否写 true 或 false,1–5 的旋钮写数字,对象写 JSON)。'
        + '必答项都交齐了,工作台会自己推进到下一段并告诉你下一句该问什么。',
      parameters: {
        type: 'object',
        properties: {
          stage: { type: 'string', description: '阶段值,例如 opening / branch / habits' },
          key: { type: 'string', description: '这一项的 key,例如 nickname' },
          value: { type: 'string', description: '值。文字原样写;true / false;1–5 的整数;对象或数组写成 JSON 文本' },
        },
        required: ['stage', 'key', 'value'],
        additionalProperties: false,
      },
      /**
       * ——— 先说后记(2026-09-20,Ben 第 ③ 条「响应延迟有点高」) ———
       *
       * 以前这里是**等阶段机落完盘再回话**,而阶段机推进那一下要 `git commit` 一次记忆文件
       * ——他在电话里干等着那一两秒。现在最多等 {@link RECORD_WAIT_MS}:
       *   - 落得快(常态,回环几十毫秒)→ 和以前**一模一样**,回话里照旧带着「下一段问什么」;
       *   - 落得慢 → 先回一句「在后台记着,接着往下说」,落盘继续跑;
       *     **真没记上就补一句实话**(`say`),绝不让「答应了但其实没记」发生(D13)。
       */
      execute: async ({ stage, key, value }) => {
        started(TOOL_RECORD_ANSWER)
        const stageText = String(stage ?? '').trim()
        const keyText = String(key ?? '').trim()
        if (stageText === '' || keyText === '') return '缺 stage 或 key,没记上。'
        const brief = deps.brief()
        const kind = brief?.keys.find(item => item.name === keyText)?.kind
        const coerced = coerceAnswerValue(kind, String(value ?? ''))

        let settled = false
        const heard = deps.heard?.()
        const landing = (async (): Promise<{ ok: boolean, advanced: boolean, text: string }> => {
          let result: { status: number, body: unknown }
          try {
            result = await inOrder(keyText, () => deps.workbench.onboardingAnswer({ stage: stageText, key: keyText, value: coerced, ...(heard === undefined ? {} : { heard }) }))
          }
          catch {
            return { ok: false, advanced: false, text: '工作台连不上,这一项没记上。如实告诉他,别假装记下了。' }
          }
          const text = answerResultText(result)
          deps.log?.(`[channel-worker] 引导 ${stageText}.${keyText} → ${result.status}${text.advanced ? ' · 推进' : ''}`)
          deps.onAnswered?.({ ok: text.ok, advanced: text.advanced })
          return text
        })()

        // 落盘这条路**永远不许把通话带走**:接住它自己的拒绝,并在没赶上回话时补那句实话。
        void landing.then(
          (text) => {
            if (settled && !text.ok) say('刚才那条我没记上,等会儿我再记一次。')
          },
          (err: unknown) => {
            deps.log?.(`[channel-worker] 引导落盘炸了:${(err as Error)?.message ?? '没说原因'}`)
            if (settled) say('刚才那条我没记上,等会儿我再记一次。')
          },
        )

        const waitMs = stageText === 'wrapup' ? (deps.wrapupWaitMs ?? WRAPUP_RECORD_WAIT_MS) : (deps.recordWaitMs ?? RECORD_WAIT_MS)
        const raced = await Promise.race([
          landing.then(text => text.text, () => '工作台连不上,这一项没记上。如实告诉他,别假装记下了。'),
          new Promise<undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), waitMs)
            ;(timer as unknown as { unref?: () => void }).unref?.()
          }),
        ])
        if (raced !== undefined) return raced
        settled = true
        return '在后台记着了,不用等。接着往下说,一次只问一件事;真没记上我会另外告诉你。'
      },
    }),

    /**
     * ——— 改一项已经记过的(2026-09-20,Ben:「它说不能改,我当时一度想要停下」) ———
     *
     * 早上那通的日志里有一行 `引导 opening.nickname → 409`:他说「我叫本,不是 Java」,
     * 阶段机回了「现在在② 分岔,不能答① 开场的问题」,于是她只好说
     * 「这个名字的改动我这会儿没能记上」。对第一次用的人来说那就是「记岔了,而且改不回来」。
     *
     * 这件工具和 record_answer 的差别全在服务端(不看当前阶段、不推进阶段、必须先记过);
     * 这边只管把出路说清楚 —— **"改不了"这三个字从此不该出现在她嘴里**。
     */
    [TOOL_CORRECT_ANSWER]: llm.tool({
      description:
        '改一项**之前已经记过**的。他说「我刚才说错了」「不是这个」「我叫的是 X 不是 Y」时用它,'
        + '**哪怕那一项是前面某一段记的**(称呼尤其常见)。'
        + 'stage 填那一项当初属于哪个阶段(称呼是 opening),key 与 value 的写法和 record_answer 一样。'
        + '改称呼会连已经写下的记忆文件名一起改。**不要对他说「改不了」** —— 改不成也先调一次,回话里会说清楚下一步。',
      parameters: {
        type: 'object',
        properties: {
          stage: { type: 'string', description: '那一项当初属于哪个阶段,例如 opening' },
          key: { type: 'string', description: '那一项的 key,例如 nickname' },
          value: { type: 'string', description: '改成什么。写法同 record_answer' },
        },
        required: ['stage', 'key', 'value'],
        additionalProperties: false,
      },
      execute: async ({ stage, key, value }) => {
        const stageText = String(stage ?? '').trim()
        const keyText = String(key ?? '').trim()
        if (stageText === '' || keyText === '') return '缺 stage 或 key,没改上。'
        const brief = deps.brief()
        const kind = brief?.keys.find(item => item.name === keyText)?.kind
        const coerced = coerceAnswerValue(kind, String(value ?? ''))
        let result: { status: number, body: unknown }
        try { result = await deps.workbench.onboardingCorrect({ stage: stageText, key: keyText, value: coerced }) }
        catch { return '工作台连不上,这一项没改上。如实告诉他,等会儿再改一次。' }
        const text = correctResultText(result)
        deps.log?.(`[channel-worker] 引导更正 ${stageText}.${keyText} → ${result.status}${text.ok ? '' : ' · 没改成'}`)
        // 改完简报里的称呼就变了,系统提示要跟着换 —— 否则她下一句还会用旧名字叫他。
        if (text.ok) deps.onAnswered?.({ ok: true, advanced: true })
        return text.text
      },
    }),

    /**
     * ——— 日期这件事交给工作台算(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」) ———
     *
     * 节假日表在 `workbench-plugin/src/server/holidays.ts`(法定假期出自放假办法,农历那几个标「推算」,
     * 每年那份调休通知没录入也照实说)。**模型一个日期都不许自己心算** ——
     * 他一听就知道对不对,算错一次比多问一句糟得多。
     */
    [TOOL_COUNT_WORKDAYS]: llm.tool({
      description:
        '算「从今天到某一天还有几个工作日」,顺带告诉你那天是星期几、是不是法定假期。'
        + '**聊到任何一个日期(截止日、交付日、「国庆前」)都先调它再开口**,不要自己心算。'
        + 'to 写 YYYY-MM-DD;from 不填就是今天。算不出来它会告诉你,那就问他一句把日子说清楚。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '算到哪天,YYYY-MM-DD,例如 2026-10-04' },
          from: { type: 'string', description: '从哪天起算,YYYY-MM-DD。不填就是今天' },
        },
        required: ['to'],
        additionalProperties: false,
      },
      execute: async ({ to, from }) => {
        const toText = String(to ?? '').trim()
        if (toText === '') return '没给日期,没法算。问他一句「你说的是几号?」。'
        const fromText = String(from ?? '').trim()
        let result: { status: number, body: unknown }
        try { result = await deps.workbench.onboardingWorkdays({ to: toText, ...(fromText === '' ? {} : { from: fromText }) }) }
        catch { return '工作台连不上,这个日子没算成。问他一句,别自己心算。' }
        const text = workdaysResultText(result)
        deps.log?.(`[channel-worker] 引导算工作日 ${fromText === '' ? '今天' : fromText} → ${toText}:${result.status}`)
        return text.text
      },
    }),

    /**
     * ——— 真去扫一遍他的仓库(2026-09-20,Ben:「授权扫仓库,但是没去扫」) ———
     *
     * 他那一通电话的日志里只有十几条 `record_answer`,一次扫描都没有 —— 因为通话模式的工人
     * 手上只有「记一项」这一件工具,②′ 那一段它只能凭空问。这一件把「授权线」那一半接回来。
     *
     * **开口那一句不等模型**:扫描要几秒,那几秒里不能是安静的。09-20 第二版起那一句
     * 由手机拿包里预先合成好的音频放(`onStart` → 缓冲语信号),不再每次去火山合一遍。
     */
    [TOOL_SCAN_PROJECTS]: llm.tool({
      description:
        '在他电脑上放仓库的目录里找项目(只读,不改他任何东西)。'
        + '**他报了项目名就带上 name,只找这一个**(不是全量扫);**只找到一个时工作台顺手把它的说明和最近记录读好了**,回话里有摘要和【怎么用】;'
        + '**不带 name 才整个扫一遍** —— 只在他说不清在哪、或者说「你帮我找找」「全部」时才这么做。'
        + '**②′ 一开口先问他想先交哪个项目,不要先扫。**'
        + '还没给「读扫描根」授权时它会告诉你怎么办 —— 照它说的做。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '他说的项目名(或路径)。只找这一个;不填 = 整个扫一遍' },
        },
        additionalProperties: false,
      },
      execute: async (args: { name?: unknown } = {}) => {
        /**
         * 开口那一句从这里搬到手机上了(2026-09-20 第二版)。以前是
         * `say('我看一下你的仓库,大概几秒。')` —— 一句**定死的话**,每次去火山合一遍,
         * 而且和回答排在同一条发言队列里,真机上迟到过。现在只广播一个
         * `{kind:'tool', tool:'scan_projects'}`,手机拿包里那一句同样的话放出来。
         * 扫描要几秒,那几秒照旧不是安静的 —— 只是声音从手机的喇叭直接出,不绕地球一圈。
         */
        started(TOOL_SCAN_PROJECTS)
        let result: { status: number, body: unknown }
        const name = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined
        try { result = await deps.workbench.onboardingScan(name) }
        catch { return '工作台连不上,这次没读到仓库。如实告诉他,改成问他手上在做什么。' }
        const text = scanResultText(result)
        deps.log?.(`[channel-worker] 引导扫仓库 ${name ?? '(全量)'} → ${result.status}${text.ok ? '' : ' · 没扫成'}${readSummary(result.body)}`)
        return text.text
      },
    }),

    /**
     * ——— 读一个项目的说明和最近的记录(2026-09-24,已有项目拉齐) ———
     *
     * 维护者 12:40:「我真的很需要她能扫仓库啊,不然我还得口述一遍吗……已有的,得迅速拉齐到同一认知界面啊」。
     * 那一通里她只能说「我这边只能看到仓库的名字,看不到里面的说明」—— 手上缺的就是这一件。
     *
     * 只找到一个时 `scan_projects` 已经顺手读好了;这一件给「他从几个里挑中了」「他说你再看看」用。
     * 带 path 走 `POST /onboarding/project-brief`;只有名字就走按名字找(只找到一个时同样带回摘要)。
     * 读回来的【怎么用】是工作台那一段 note **原样**(话术只写一处)。慢工具:开跑报一声(filler.ts SLOW_TOOLS)。
     */
    [TOOL_READ_PROJECT]: llm.tool({
      description:
        '读一个项目的说明和最近的记录(只读,一个字都不改),回来一份摘要和【怎么用】。'
        + `只找到一个时 ${TOOL_SCAN_PROJECTS} 已经顺手读好了,**不用再调**;`
        + '他从几个里挑中了、或者后面说「你再看看」「再读一下」时用它。'
        + '优先带 path(找项目时回话里给的那个,原样填);没有 path 才带他说的 name。还没授权时它会告诉你怎么问。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '找项目时回话里给的那个 path,原样填' },
          name: { type: 'string', description: '没有 path 时,他说的项目名' },
        },
        additionalProperties: false,
      },
      execute: async (args: { path?: unknown, name?: unknown } = {}) => {
        started(TOOL_READ_PROJECT)
        const path = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
        const name = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined
        if (path === undefined && name === undefined) return '没说读哪一个。先问他是哪个项目,再带上 path(或名字)来读。'
        let result: { status: number, body: unknown }
        try {
          result = path !== undefined
            ? await deps.workbench.onboardingProjectBrief(path)
            : await deps.workbench.onboardingScan(name)
        }
        catch { return '工作台连不上,这次没读到。如实告诉他,改成问他。' }
        const text = path !== undefined ? projectBriefText(result) : scanResultText(result)
        deps.log?.(`[channel-worker] 引导读项目 ${path ?? name} → ${result.status}${text.ok ? '' : ' · 没读成'}${readSummary(result.body)}`)
        return text.text
      },
    }),

    /**
     * ——— 把今天说的摆成一张单子放上屏(2026-09-24 晚,引导落地) ———
     *
     * 维护者:「结束环节的大总结听得我好累」「结束的时候应该可以直接生成事项,然后它自己开始派活吧?」
     * 收尾那几项记完,工作台让她调这件:单子上屏,回话里是**唯一要说的那一句**。慢工具(读存档、看板,可能等一次模型)。
     */
    [TOOL_SETUP_PREVIEW]: llm.tool({
      description:
        '把他今天说的摆成一张单子放上屏幕(电脑首页球下面、手机「等你确认」):两个项目、冲刺与卡、每天几点、撤掉过时的、第一件派给谁。'
        + '收尾那几项记完就调(工具回话会提醒)。回话里有**唯一要说的那一句**,照说,别的不念、不复述、不念文件路径。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        started(TOOL_SETUP_PREVIEW)
        if (deps.workbench.onboardingMaterializePreview === undefined) return '这台工作台还没有落地这一步:只说一句「都记好了,有事叫我。」,别念清单。'
        let result: { status: number, body: unknown }
        try { result = await deps.workbench.onboardingMaterializePreview() }
        catch { return '工作台连不上,单子没摆上屏。只说一句「都记好了,单子我等会儿摆到屏幕上。」,别念清单。' }
        const text = setupPreviewText(result)
        if (text.id !== undefined) lastPlanId = text.id
        deps.log?.(`[channel-worker] 落地单子上屏 → ${result.status}${text.ok ? '' : ' · 没摆上'}`)
        return text.text
      },
    }),

    /**
     * ——— 他点头了,落(2026-09-24 晚,引导落地) ———
     *
     * 带着他刚才那句话(8791 听着不是点头就 409,别替他落);他说哪件不要就填 skip。
     * 落完告诉工人刷新简报 —— 单子不再等他了,就换回平时那套人设。
     */
    [TOOL_SETUP_APPLY]: llm.tool({
      description:
        '他看了单子说「可以 / 就这样 / 行」才调:建项目与卡、改例程与免打扰、撤掉过时的、派第一件。'
        + '他说哪几件不要,把那几件照他的说法填进 skip(用顿号隔开);他没点头别调。回话里有唯一要说的那一句,照说。',
      parameters: {
        type: 'object',
        properties: { skip: { type: 'string', description: '他说不要的那几件,照他的说法,用顿号隔开(比如「视频那件、文案那件」);都要就不填' } },
        additionalProperties: false,
      },
      execute: async (args: { skip?: unknown } = {}) => {
        started(TOOL_SETUP_APPLY)
        if (deps.workbench.onboardingMaterializeApply === undefined) return '这台工作台还没有落地这一步:如实说一句「这一步还落不了,你在屏幕上看一眼」。'
        const skip = typeof args?.skip === 'string'
          ? args.skip.split(/[、,,;;]+/).map(one => one.trim()).filter(one => one !== '')
          : []
        const heard = deps.heard?.()
        let result: { status: number, body: unknown }
        try { result = await deps.workbench.onboardingMaterializeApply({ ...(lastPlanId === undefined ? {} : { id: lastPlanId }), ...(skip.length === 0 ? {} : { skip }), ...(heard === undefined ? {} : { heard }) }) }
        catch { return '工作台连不上,没落成。如实说一句「没落上,你在屏幕上点一下就这样」。' }
        const text = setupApplyText(result)
        deps.log?.(`[channel-worker] 落地 → ${result.status}${text.ok ? '' : ' · 没落成'}`)
        if (text.ok) deps.onAnswered?.({ ok: true, advanced: true })
        return text.text
      },
    }),
  }
}

/**
 * 引导模式的系统提示。**技能全文 + 当前阶段要弄清的 + 能写的 key 与值的形状**,
 * 外加电话里的说话规矩。种子句在这里只作「该问什么」的依据 ——
 * 它出不出声由工人决定(speak_seed),不交给模型,免得念两遍。
 */
export function buildOnboardingInstructions(input: {
  brief: OnboardingBrief
  /** ~/.dsh/AGENTS.md 里那段说话方式(还没做到人设那一段时可能没有)。 */
  style?: string
  butlerName?: string
}): string {
  const { brief } = input
  const who = input.butlerName === undefined || input.butlerName === ''
    ? '你是他的事务官。'
    : `你是他的事务官,名字叫${input.butlerName}。`
  const lines: string[] = [
    `${who}你正在用电话做**引导**:第一次认识他、认识他手上的事。他在手机上跟你说话,你说的每个字都会被念出来,他随时可以打断你。`,
    '',
    '【怎么说话】',
    input.style === undefined || input.style === '' ? '一次说一两句,像打电话那样,别念稿子。' : input.style,
    '- 一次只问一件事。不念清单、不念 Markdown、不念代码、不念链接和 id —— 那些用耳朵听不懂。',
    '- 他答得含糊就顺着问一句,别追问私事;他说「稍后」就停下,进度已经落盘。',
    '- 不知道就说不知道,**不编**。',
    // 2026-09-20(Ben:「响应延迟有点高」):两轮模型是那几秒的大头 —— 先开口,记录在后台落。
    '- **先说后记**:弄清一项就先口头回应他一句,再调工具记;不要先记完再开口,他在电话那头等着。',
    '- 要去查东西(比如读他的仓库)之前先说一句「我看一下」,别让他对着一段安静猜。',
    '',
    // ——— 2026-09-20,Ben:「更多是问问题和总结,而不是协助梳理」———
    // 早上那通里她连问八题、每答一条记一条,没有一句复述、没有一句提议。这一段是那件事的正面。
    '【你是来帮他梳理的,不是来做问卷的】这一条比下面所有清单都重要。',
    '- **他说完一段,你的第一句永远是复述**,把他说的理成结构:「我听到三件事:一是…,二是…,三是…」'
    + '顺手把里头的关系和矛盾说出来(「硬件要重做,报名又卡在这个月底,这两件是挤在一起的」)。复述完了再问 ——'
    + '**复述后面只跟一个问句**:要么「对吗」,要么下一个问题,不两个都来。',
    '- **一轮最多问一个问题**,而且这个问题要从他刚说的那段话里长出来 —— 不是从你心里那张清单上取下一条。'
    + '清单是拿来对照「还差什么」的,不是拿来挨个念的。',
    '- **字段顺手摘**:他一段话里带了截止日又带了合作者,就两样一起记下来,**不回头补问**。'
    + '为了填满一个字段多问一句,那就又变成问卷了。',
    '- **有边界**:你不知道的事不替他估。别人干一件活要多久,你没有依据 —— 只能问「这件大概要多久?」,'
    + '不能自己说「来得及」或者「来不及」。要下判断先说成猜测:「我猜这一件花不了你几天,对吗?」,他点头才算数。',
    '- **别让他从零排时间**:先问「你目前的安排是什么」「手上有哪些事项」,'
    + '收齐了**你来排**一个方案念给他听(「我建议这么排:…你看行不行?」),他改就改 —— '
    + '不是反过来问他「你下一步打算做什么」。',
    '- 一轮里复述 + 一个问题就够了,**别把这几条一口气全做完** —— 那又成了念稿子。',
    '',
    '【一题一答】',
    ...PHONE_TURN_RULES,
    '',
    // 2026-09-23:分岔排在布局之前,这时还不知道他做产品还是做运营 —— 说法与工作台的分岔句一致,不说"项目"。
    `【现在到哪儿了】${brief.label}${brief.nickname === undefined ? '' : ` · 他叫${brief.nickname}`}${brief.mode === undefined ? '' : ` · ${brief.mode === 'fresh' ? '从一个新点子开始' : '已经有在做的'}`}`,
    // 2026-09-27(卡 OB):**代码算好的事实**,模型不许自己猜这两件 —— 他选了哪一支、这台电脑上有哪几家 AI。
    ...(brief.mode === 'fresh'
      ? ['【事实】他选的是「从一个新点子开始」:这台电脑上什么都还没有 —— 不提「你手上在做的事」「跟这件事相关的事项」「已经在做的」,也不扫仓库、不读记录。']
      : brief.mode === 'existing' ? ['【事实】他选的是「已经有在做的事」:按他已经在做的那件事说,别当成还没开始的新点子。'] : []),
    ...(brief.memory_families === undefined
      ? []
      : brief.memory_families.length === 0
        ? ['【事实】这台电脑上没有别家 AI 记着的东西(工作台探过了):**一个家名都别提**,也不问「要不要读它们记着的东西」。']
        : [`【事实】这台电脑上装了、而且真有记录可读的 AI 只有:${brief.memory_families.join('、')} —— 要念就只念这几个,名单外的名字都别说出口。`]),
  ]
  const answered = Object.entries(brief.answered).filter(([, keys]) => Array.isArray(keys) && keys.length > 0)
  if (answered.length > 0) {
    lines.push(`已经答过的(**不要再问一遍**):${answered.map(([stage, keys]) => `${stage}(${keys.join('、')})`).join(';')}`)
  }
  if (brief.focus !== undefined) lines.push(`这一轮只补问新项目「${brief.focus}」,别把整个引导重来。`)
  /**
   * 【记错了随时能改】(2026-09-20)。这一段**任何阶段都出**,不只开场 ——
   * 他想起「上次那个名字不对」可能是在第四段。
   */
  lines.push('')
  lines.push(`【他说记错了:照改,别说改不了】用 ${TOOL_CORRECT_ANSWER},前面几段记过的也能改(称呼最常见)。`)
  lines.push('改完**不宣告、不求确认**,下一句开头照新的叫他一声就是确认。**「我这会儿改不了」这种话一个字都不要说** —— 第一次用的人听见这句就不信这东西了。')
  if (brief.stage === 'opening' || brief.answered.opening === undefined) {
    // U / V(2026-09-23 统筹第三轮):「好,那我叫你 Ben。我先记一下——我叫你 Ben,对吗?」同一件事确认两遍;
    // 「对吗?是拼音的 Ben 吧?另外已有还是新点子?」一口气三问。称呼他一说就直接用,叫错了他自然会纠正。
    lines.push(`称呼这一项:他说了就**直接用**,下一句开头叫他一声(「好,Ben。」)紧接着问下一题 —— **不再问「我叫你 X,对吗?」**;他纠正就当场 ${TOOL_CORRECT_ANSWER} 改。`)
    lines.push('**不问多余的确认**:「是拼音吗」「是哪个字」「英文还是中文」都不问。')
    // 2026-09-25(维护者:「为什么总是第一次听名字的时候听不清」):他说 Ben,第一遍被听成「变」「编辑」;
    // 以前这里让她「请他再说一遍」—— 再说一遍还是同一个口音、同一个识别,对不对全凭运气。打出来的字是准的。
    lines.push('转出来的字不像个称呼(只有一个字、像半句话、像是英文名被听成了中文词,比如「变」「编辑」),**不要请他再说一遍,也别猜着记**:'
      + '一句话请他在手机屏幕下面的输入框里打出来(「我怕听错,你在屏幕下面把名字打一下吧。」);他打出来的就是准的,直接记。')
  }
  else if (brief.nickname !== undefined) {
    lines.push(`他现在叫「${brief.nickname}」。他要是纠正这个名字(哪怕只是念得不一样),**当场用 ${TOOL_CORRECT_ANSWER} 改 opening.nickname**。`)
  }
  if (brief.seed !== undefined) {
    lines.push('')
    lines.push(brief.speak_seed
      ? `【这一段开口就说这句】(照样子说,开场白一字不改)\n「${brief.seed}」`
      : `【这一段的问题我已经问出去了,别重复】\n「${brief.seed}」——他要是还没答,换个说法追一句就行。`)
  }
  if (brief.installed_apps !== undefined && brief.installed_apps.length > 0) {
    lines.push('')
    lines.push(`【这台电脑上扫到装了】${brief.installed_apps.map(app => app.label).join('、')}`)
    lines.push('问「你平时最常开哪几个应用」的时候可以照着念这几个名字(「我看到你装了…,都要吗?」)。'
      + '**只念这几个**,没扫到的别编;他说的别的应用照样记下来,记不进窗口槽工作台会告诉你。')
  }
  if (brief.goals.length > 0) {
    lines.push('')
    lines.push('【这一段要弄清的东西】(不是问卷,顺着聊)')
    for (const goal of brief.goals) lines.push(`- ${goal}`)
  }
  if (brief.stage === 'wrapup') {
    // 2026-09-24 晚(维护者「结束环节的大总结听得我好累」):真机上收尾念了 240 字总结,末尾还念了 docs/记忆/… 的路径。
    lines.push('')
    lines.push('【收尾这一段】每轮最多两句短话、一个问题。**不复述、不念清单、永不念文件路径**:今天说的都摆在屏幕上那张单子里。')
    lines.push(`- 收尾那几项记完,工具回话会让你调 ${TOOL_SETUP_PREVIEW}:调它把单子摆上屏,**只说它回的那一句**。`)
    lines.push(`- ${SETUP_NEXT}`)
  }
  if (brief.recap !== undefined) {
    lines.push('')
    lines.push('【今天记下的】(工作台从已答项算的,给你心里有数用,**不念、不复述**;完整的单子在他屏幕上)')
    lines.push(brief.recap)
  }
  /**
   * 【日历】(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」)。
   * 工作台算好的一小段:今天几号、接下来的法定假期、已记下的截止日还剩几个工作日。
   * 老工作台没有这一格 —— 缺席时这一整段不出现,而且**下面那句「别自己心算」照样在工具那一段里**。
   */
  if (brief.calendar !== undefined && brief.calendar !== '') {
    lines.push('')
    lines.push('【日历】(工作台算的,涉及日期照它说)')
    lines.push(brief.calendar)
    lines.push(`这一段没写到的日子用 ${TOOL_COUNT_WORKDAYS} 现算,**别自己心算**;连休到几号没录进来就别当成事实,问他一句。`)
  }
  /**
   * **这一段能扫仓库**(2026-09-20)。判据是这一阶段的 key 里有没有 `read_scan_roots` ——
   * 也就是②′(A 线)与③ 授权补全那两段。不在这两段里就一个字都不提扫描:
   * 提了模型会在开场白那一段就想去读人家的硬盘。
   */
  if (brief.keys.some(key => key.name === 'read_scan_roots')) {
    lines.push('')
    lines.push(`【这一段你可以去找、去读他的项目】工具 ${TOOL_SCAN_PROJECTS}(找)与 ${TOOL_READ_PROJECT}(读),都只读`)
    // 2026-09-24(维护者拍板,已有项目拉齐确认点 1):授权问一句就够 —— 找它、读它一起问,仍记 read_scan_roots。
    lines.push('- **先问交哪一个,不先扫**:「你想先把哪个项目交给我?」他报了名字,'
      + `调 ${TOOL_SCAN_PROJECTS} **带上 name** 只找这一个;**先问后看**:还没授权就先问「${ASK_TO_READ}」,`
      + `**他说可以**再调 ${TOOL_RECORD_ANSWER} 把 read_scan_roots 记成 true、再去找;没问之前一个目录都不看。`)
    // 确认点 2 / 3:找到唯一一个就先读,用读到的内容问「是这个吗」;复述两句以内,之后只问文档里没有的。
    lines.push(`- **只找到一个时,工作台已经顺手读好了**:回话里有摘要和【怎么用】,不用再调 ${TOOL_READ_PROJECT},**照【怎么用】说** —— `
      + '找到了哪个、读了哪几份,两句以内复述它做什么、给谁、现在到哪,再问「是这个吗」;'
      + `他点头或纠正之后才调 ${TOOL_RECORD_ANSWER} 记 project(one_liner / status / next_step 用他认可的说法,path 原样带上)。`)
    lines.push(`- 找到几个像的、或者回了候选:只念名字让他挑;挑中了调 ${TOOL_READ_PROJECT} **带上那一个的 path**。他后来说「你再看看」也调 ${TOOL_READ_PROJECT}。`)
    lines.push('- 读到了交接的:交接里写着的下一步由你念出来让他排先后,**这一段不问「你手上有哪些事」**'
      + '(上面「别让他从零排时间」那条,在这一段就是这么做);之后只问文档里没有的。')
    // 2026-09-24 真机第五轮:按名字没找到就让他报路径,他解释了半天。
    lines.push(`- name 照他的原话填(中文名、拆开念的英文都行,工作台会自己归一、做中英对照);**按名字没找到时工作台会带回最近在动的几个**,念给他挑,别让他报路径;`
      + `他主动说了位置(「文稿里的 GitHub」)就把位置当 name 填(~/Documents/GitHub)。`)
    lines.push('- 他说不清在哪 / 「你帮我找找」/「全部」才不带 name 整个扫;扫的时候她会自己说一句「我看一下你的仓库,大概几秒」,你不用重复。'
      + '说「全部」的先劝一句「全扫要一会儿,之后得一个一个过,建议先从一个开始」,他坚持再扫,扫完让他排先后、一个一个聊。')
    lines.push('- 扫完**只念候选让他挑**,别一条条念完,也别念路径和分支名 —— 耳朵听不懂;**挑中的才录,没挑的一个都不记**。')
    lines.push('- 清单和摘要是**素材不是结论**:项目是什么、做到哪、下一步,以他认可的为准;对不上就指出来,以他说的为准。摘要里没有的不编。')
    // 2026-09-24 下午小修:以前写「照上面那句再问一遍」,她就说成「那我再问一遍确认:……」—— 过程话。
    lines.push('- 他说不可以:应一句就过去,改成问他,**别再提扫描**;'
      + '他后来改口说「你去看吧」:**直接照上面那句问他**,像头一回问那样,不提前面问过,也不说「确认一下」这类话;'
      + '他答了可以再记、再找 —— 不能拿他那句顺口话直接记。')
  }
  /**
   * **这一段要问「能不能读各家客户端里的文件」**(2026-09-22,Ben 定的 C5)。
   * 判据同上:这一阶段的 key 里有没有 `read_client_files`(②′ A 线与 ③ 授权补全)。
   * 电话里这一问最容易被问成两件事,所以顺序在这里写死:**先授权,再拷**。
   */
  /*
   * 2026-09-27(卡 OB):名单以前写死成「Claude、Codex、Kimi」—— 新 Air 上只装了豆包办公与 Codex,
   * 这一问照样念了没装的两家,他只好回「我电脑上没有 Claude 和 kimi」。
   * 现在名单由工作台探(`memory_families`):空的 → **这一问整段不出现**;缺席(老工作台)→ 照旧那句。
   */
  const families = brief.memory_families
  if (brief.keys.some(key => key.name === 'read_client_files') && families?.length !== 0) {
    const names = families === undefined || families.length === 0 ? 'Claude、Codex、Kimi' : families.join('、')
    lines.push('')
    lines.push('【这一段要问一句:能不能读他电脑上那几个客户端里的文件】')
    lines.push(`- 说人话:「你电脑上${names}里头,它们各自记着一些东西。`
      + '我能不能读一读?**只读,一个字都不改**。」——**不要说 memory、目录、路径这些词**。')
    lines.push(`- **只念这几家:${names}**(工作台在这台电脑上探出来的)。名单外的一家**当这台电脑上没有它**,名字都别说出口;`
      + '他说「我没有某某」是在纠正名单、**不是拒绝** —— 别记成不可以,照名单里剩下的再说一次。')
    lines.push('- 三档照他的话记:可以 / 要问(每次动手前问他一句)/ 不可以。')
    lines.push(`- 他答「可以」而且愿意让我把那些东西拷一份过来:**先**调 ${TOOL_RECORD_ANSWER} 把 `
      + 'read_client_files 记成「可以」,**再**把 import_memories 记成 true。'
      + '**顺序不能反** —— 授权不到位工作台不会拷,会回一句「没拷」,那时你照它那句话说,别说成拷好了。')
    lines.push('- 他说不可以:应一句就过去,**别再提拷记忆**。')
  }
  if (brief.keys.length > 0) {
    lines.push('')
    lines.push(`【弄清一项就记一项】调 ${TOOL_RECORD_ANSWER},stage 填 "${brief.stage}",key 与值的形状:`)
    for (const key of brief.keys) lines.push(`- ${key.name}${key.required ? ' *(必答)' : ''}:${key.desc}`)
    lines.push('必答项交齐了工作台会自己推进,并告诉你下一句问什么。')
    lines.push('同一口气交好几项时,**done 永远最后一个调**(先交内容、再交 done),不然那一段先收了尾,后面那几项要晚一步才补进去。')
  }
  lines.push('')
  lines.push('【引导技能】')
  lines.push(brief.skill ?? brief.skill_note ?? '(没拿到引导技能全文,照上面的清单聊就行,别自己发挥流程。)')
  return lines.join('\n')
}

/**
 * 引导做完、单子还等他点头时的提示词(2026-09-24 晚,引导落地)。**只做一件事**:等他对屏幕上那张单子点头。
 * 那一句由 setup_preview 回(已经摆过的再调一次也是同一张,不会多出一张)。
 */
export function buildSetupInstructions(input: { brief: Pick<OnboardingBrief, 'setup' | 'nickname'>, style?: string, butlerName?: string }): string {
  const who = input.butlerName === undefined || input.butlerName === '' ? '你是他的事务官。' : `你是他的事务官,名字叫${input.butlerName}。`
  const line = input.brief.setup?.line
  return [
    `${who}引导刚做完:你把他今天说的摆成了一张单子,在他屏幕上(电脑首页球下面、手机「等你确认」)。他在电话里,你说的每个字都会念出来。`,
    '',
    '【怎么说话】',
    input.style === undefined || input.style === '' ? '一次说一两句,像打电话那样。' : input.style,
    '- 每轮最多两句短话。**不念清单、不复述单子、永不念文件路径。**',
    '',
    '【这一段只等他对单子点头】',
    line === undefined
      ? `- 还没说过那一句:先调 ${TOOL_SETUP_PREVIEW},只说它回的那一句。`
      : `- 还没说过那一句的话,只说这一句:「${line}」(不确定说没说过,就调 ${TOOL_SETUP_PREVIEW} 拿同一句)。`,
    `- ${SETUP_NEXT}`,
    '- 他问别的事:照平时那样一两句答完,再问一句单子行不行。',
  ].join('\n')
}

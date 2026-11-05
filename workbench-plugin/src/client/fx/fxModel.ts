/**
 * 动效配角:状态 → 效果的映射(2026-09-23,设计见 docs/设计-动效配角-2026-09-23.md)。
 *
 * 维护者拍板:**粒子球是主角**,这些效果只做配角,用在输入框、卡片、状态提示上。
 * 纪律三条,全在这个文件里落成纯函数(好单测):
 *   1. 同一屏最多一种「强效果」(光沿边流动);「弱效果」(呼吸光、20px 小球、机器人头像)不占这个名额。
 *   2. 只在看得见、而且有事的时候跑:`visible=false`(档切走了,display:none)一律关。
 *   3. 「减少动效」:库自己会画静态一帧(border-beam / thinking-orbs / bot-avatars 都认
 *      `prefers-reduced-motion`),粒子档那张样式表另有一条 `animation:none!important` 兜底。
 *
 * 效果来自 libraries.dev(MIT,作者 Jakub Antalik),npm 包原样用、版本钉死,见交接的许可结论表。
 * 手机端(butler-app/src/fx/fxModel.ts)是同一套口径的另一份 —— 两端不互相 import(AGENTS.md)。
 */
import type { AgentDispatchFamily, AgentId, SessionStatus, TaskDispatch } from '../../protocol.ts'

/** 光沿边走的三种:只走底边 / 绕整圈 / 原地呼吸(不走)。 */
export type BeamKind = 'line' | 'rotate' | 'pulse'
/**
 * 配色:2026-09-24 维护者「这个蓝色也很奇怪,改成白色底黑字吧,中性一点,这是全局的」——
 * 所有光一律 `mono`(黑白灰,关色相漂移);`ocean` / `sunset` 留在类型里只为兼容,不再使用。
 */
export type BeamTone = 'ocean' | 'sunset' | 'mono'

export interface BeamSpec {
  kind: BeamKind
  tone: BeamTone
  /** 0–1,只影响光,不影响里面的内容。 */
  strength: number
  /** 一圈几秒。缺省用库的(走一圈 1.96 秒、底边 3.1 秒、呼吸 2.3 秒)。 */
  duration?: number
  /** 不做色相漂移。琥珀那一档要开:库的漂移会把橙黄推到绿色,绿色读起来是「好了」,不是「等你」。 */
  staticColors?: boolean
  /**
   * 三层各自放大多少(2026-09-25,卡 feat/first-look-orb-top)。经库的 `css` 口子写成
   * `--beam-stroke-opacity / --beam-bloom-opacity / --beam-inner-opacity` 三个变量(库本来就留了这三个口)。
   *
   * 为什么要它:mono 在库里被压了一半(md 深色描边 0.26×0.5 = 0.13),维护者在真壳里一样光都没看到。
   * 两个引擎(无头 Chrome 与 WKWebView)对同一帧量过边框一圈的亮度:当前卡 +50、槽 +110 左右 ——
   * 库在 WebKit 下画得和 Chrome 一样,是**本来就太淡**,再加上被事务官那层 / 贴着的窗盖住。
   * 以前那个 `boost`(三层一起乘 3)把内圈也抬成一团灰,这里三层分开抬:线要亮、晕适中、内圈几乎不动。
   */
  tune?: { stroke?: number, bloom?: number, inner?: number }
}

/**
 * **一套光**(维护者 09-24「所有光效同一套」):沿边绕圈走的那一种,事项卡、要他处理的卡、拖窗进槽都是这一组数。
 * 描边 0.13×6 ≈ 0.8、外晕 0.12×4 ≈ 0.5、内圈 0.21×1.5 ≈ 0.3 —— 深色底上一眼看得见,又不是一圈霓虹。
 */
export const NEUTRAL_BEAM_TUNE = { stroke: 6, bloom: 4, inner: 1.5 } as const

/** 一份 `tune` → 库的 css 口子那一段(`{id}` 由库换成这一份 beam 的 id)。没有就不写。 */
export function beamTuneCss(tune: BeamSpec['tune']): string | undefined {
  if (tune === undefined) return undefined
  const parts: string[] = []
  if (tune.stroke !== undefined) parts.push(`--beam-stroke-opacity:${tune.stroke}`)
  if (tune.bloom !== undefined) parts.push(`--beam-bloom-opacity:${tune.bloom}`)
  if (tune.inner !== undefined) parts.push(`--beam-inner-opacity:${tune.inner}`)
  return parts.length === 0 ? undefined : `[data-beam="{id}"]{${parts.join(';')}}`
}

/** 强效果 = 光在走(line / rotate);呼吸不算。 */
export function isStrong(kind: BeamKind): boolean {
  return kind !== 'pulse'
}

/** 桌面上用到的几处,各一份参数。放一起,好对着设计文档核。 */
export const BEAM = {
  /** 事务官档输入框:交办那一下在路上。 */
  composer: { kind: 'line', tone: 'mono', strength: 0.9, staticColors: true },
  /**
   * 球下面「要你处理的」最前面那张(2026-09-25,设计「有事的卡有光沿边」):等他拍板的固化提议、布局改动、
   * 小工具需求、待批的操作,以及卡 B 的「我照你说的摆好了」。同一套光。
   */
  ask: { kind: 'rotate', tone: 'mono', strength: 1, duration: 3.2, staticColors: true, tune: NEUTRAL_BEAM_TUNE },
  /** 「待确认」那一夹:等你拍板,轻轻呼吸(弱效果,不占名额)。量过太淡(+60),抬一点。 */
  confirm: { kind: 'pulse', tone: 'mono', strength: 0.8, duration: 2.8, staticColors: true, tune: { stroke: 1.4, bloom: 1.6, inner: 1.3 } },
  /**
   * 把应用窗口拖进窗口槽、悬在槽上时(2026-09-24,维护者:「之前我们有自制的应用拖拽到窗口槽的边缘光效,
   * 也统一改成现在我提供给你那个视效库的光效」):原来是自制的虚线加粗 + 蓝色呼吸,现在是光绕槽体整圈走。
   * 3.2 秒一圈;壳的原生光圈(workbench-app HighlightWindow.swift
   * `HighlightBeam`)照这组参数重画,改这里要一起改那边。
   */
  slotHover: { kind: 'rotate', tone: 'mono', strength: 1, duration: 3.2, staticColors: true, tune: NEUTRAL_BEAM_TUNE },
  /** 引导对话屏的输入框:她在想 / 在找你的项目。 */
  onboardingInput: { kind: 'line', tone: 'mono', strength: 0.8, staticColors: true },
} as const satisfies Record<string, BeamSpec>

/** border-beam 的 `size` 参数。 */
export function beamSize(kind: BeamKind): 'line' | 'md' | 'pulse-inner' {
  return kind === 'line' ? 'line' : kind === 'rotate' ? 'md' : 'pulse-inner'
}

/**
 * 事务官档这一屏的强效果归谁。**最多一个**:交办在路上(输入框) > 有要他处理的卡(球下面最前面那张) > 没有。
 * 交办只有一两秒,那一下卡片上的光先淡出,交完再淡回来。
 *
 * 2026-09-25(维护者「那卡片的光效呢」,设计「有事的卡有光沿边」):多了 `ask` 一档。
 * 2026-09-25 卡 P 补三(维护者:「为什么只有一个有光效,另一个没有」):去掉「台上当前事项那张卡」一档 ——
 * 两张一样在跑,只有「当前」那张走一圈光,看的人分不出「当前」和「在跑」,只看到不一致。
 * 在跑的卡一个样(连线上的流光本来就一样);他点开的那张只多一个不发光的小字(ButlerTaskStage)。
 */
export type StrongFx = 'composer' | 'ask' | null
export function strongFx(signals: { visible: boolean, composerBusy: boolean, ask?: boolean }): StrongFx {
  if (!signals.visible) return null
  if (signals.composerBusy) return 'composer'
  if (signals.ask === true) return 'ask'
  return null
}

/** 「待确认」那一夹要不要呼吸:看得见、而且里面有东西。 */
export function confirmPulse(signals: { visible: boolean, count: number }): boolean {
  return signals.visible && signals.count > 0
}

/**
 * 引导对话屏:输入框那条底边光。她在想 / 在找项目 → 亮;出错 / 待命 / 说话 → 不亮
 * (说话时球本身在动,输入框再亮就是抢话)。
 *
 * **状态行前不放 20px 小球**(2026-09-23 维护者看扫描那一屏:「这里错了,上面的粒子改成工作的那个状态就行」):
 * 引导整屏只有一颗球,她的状态由主球表现,旁边再放一颗小粒子就成了两个她。
 */
export type OnboardingCue = 'idle' | 'listening' | 'thinking' | 'speaking' | 'working' | 'trouble'
export function onboardingFx(cue: OnboardingCue): { beam: boolean } {
  return { beam: cue === 'thinking' || cue === 'working' }
}

/** thinking-orbs 的九态里用到的几种。 */
export type ThinkingState = 'working' | 'searching' | 'connecting'

// ——— 机器人头像:派出去的每一家一个 ———

/** bot-avatars 的形状里挑出来的几种(各家一个,颜色是库里那个形状自带的)。 */
export type BotType = 'drop' | 'pebble' | 'mech' | 'cloud' | 'circle' | 'blob' | 'star' | 'hexagon'
export type BotState = 'default' | 'working' | 'sleeping'

/**
 * 哪一家配哪个头像。**不是各家的商标**(我们不仿别人的标),只是一家一个、形状与颜色分得开:
 * 扫一眼台上,知道这张卡是哪一家在办。事务官自己没有头像 —— 她就是那颗粒子球。
 */
export const AGENT_AVATAR: Readonly<Record<AgentId | AgentDispatchFamily, { type: BotType, label: string }>> = {
  dsh: { type: 'drop', label: 'DSH' },
  claude: { type: 'pebble', label: 'Claude' },
  codex: { type: 'mech', label: 'Codex' },
  kimi: { type: 'cloud', label: 'Kimi' },
  gpt: { type: 'circle', label: 'GPT' },
  doubao: { type: 'blob', label: '豆包办公' },
  // 2026-09-24(卡 F):Muse / Manus 从 bot-avatars 那 18 种里再挑两种没人用的,一家一个、互不相同。
  muse: { type: 'star', label: 'Muse' },
  manus: { type: 'hexagon', label: 'Manus' },
}

/** 头像能挑的那几种(bot-avatars 里的形状),登记表里新来的一家从这里按 id 算一个。 */
const AVATAR_TYPES: readonly BotType[] = ['drop', 'pebble', 'mech', 'cloud', 'circle', 'blob', 'star', 'hexagon']

/**
 * 任何一家的头像(2026-09-25,卡 Q):上面那几家照旧(换了他就认不出了);**登记表里运行时新接上的一家**
 * 按它的 id 算一个(同一个 id 永远是同一个样子),名字用登记表里的 —— 不必先改这张表才看得见它。
 */
export function avatarFor(agent: string, name?: string): { type: BotType, label: string } {
  const known = (AGENT_AVATAR as Readonly<Record<string, { type: BotType, label: string }>>)[agent]
  if (known !== undefined) return name === undefined ? known : { ...known, label: name }
  let hash = 0
  for (let i = 0; i < agent.length; i += 1) hash = (Math.imul(hash, 31) + agent.charCodeAt(i)) >>> 0
  return { type: AVATAR_TYPES[hash % AVATAR_TYPES.length] as BotType, label: name ?? agent }
}

/** 会话状态 → 头像三态:在跑 = 忙(蹦跳);等你 / 跑完 / 出错 = 醒着;离线或查不到 = 睡着。 */
export function avatarStateOfSession(status: SessionStatus | undefined): BotState {
  if (status === 'running') return 'working'
  if (status === 'waiting' || status === 'done' || status === 'error') return 'default'
  return 'sleeping'
}

/** 派活状态 → 头像三态:还在跑 = 忙;回来了 / 失败 / 取消收场 = 醒着(失败另有红标,头像不替它说话)。 */
export function avatarStateOfDispatch(status: TaskDispatch['status']): BotState {
  return status === 'running' ? 'working' : 'default'
}

/** 一组会话里取「最忙的那个」给组头的头像:有一条在跑就是忙,有一条醒着就是醒着,否则睡着。 */
export function avatarStateOfGroup(statuses: readonly SessionStatus[]): BotState {
  const states = statuses.map(avatarStateOfSession)
  if (states.includes('working')) return 'working'
  if (states.includes('default')) return 'default'
  return 'sleeping'
}

/**
 * 执行者标签是 `agent / session_id`(butlerSceneModel.ts)。取出那一家的 id(登记表里的,按字符串;
 * 2026-09-25 卡 Q 起不再只认写死的四家)。取不出就不画头像。
 */
export function agentOfExecutorLabel(label: string): string | undefined {
  const head = label.split(' / ')[0]?.trim()
  return head === undefined || head === '' || !label.includes(' / ') ? undefined : head
}

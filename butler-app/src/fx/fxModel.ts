/**
 * 动效配角:状态 → 效果的映射(手机端,2026-09-23)。设计见 docs/设计-动效配角-2026-09-23.md。
 *
 * 与电脑端 workbench-plugin/src/client/fx/fxModel.ts 同一套口径,两端不互相 import(AGENTS.md)。
 * 维护者拍板:**粒子球是主角**,这些只做配角。手机上再加两条:
 *   - 同一屏最多一种「强效果」(光在走 / 声音光);呼吸光、20px 小球不占名额;
 *   - 别掉帧:只在有事时开,录音那一下(全屏录音浮层)一律让路。
 * 「减少动效」:库自己认 `prefers-reduced-motion`(画静态一帧 / 不跑),这边不再另判。
 */
import type { CallPhase } from '../call/callModel';
import type { StageMode } from '../swarm/orbState';

export type BeamKind = 'line' | 'rotate' | 'pulse';
/** 2026-09-24 维护者「改成白色底黑字吧,中性一点,这是全局的」:光一律 mono(关色相漂移);另两种只为兼容留着。 */
export type BeamTone = 'ocean' | 'sunset' | 'mono';
export interface BeamSpec {
  kind: BeamKind; tone: BeamTone; strength: number; duration?: number;
  /** 不做色相漂移。琥珀那一档要开:库的漂移会把橙黄推到绿色,绿色读起来是「好了」,不是「等你」。 */
  staticColors?: boolean;
  /**
   * 三层各自放大多少(2026-09-25,与电脑端 `fxModel.ts` 的 `tune` 同一个口子、同一组数):经库的 `css` 口子写成
   * `--beam-stroke-opacity / --beam-bloom-opacity / --beam-inner-opacity`。mono 在库里被压了一半,原样几乎看不见。
   */
  tune?: { stroke?: number; bloom?: number; inner?: number };
}

/** 一套光(与电脑端 NEUTRAL_BEAM_TUNE 同一组数):描边 ≈0.8、外晕 ≈0.5、内圈 ≈0.3。 */
export const NEUTRAL_BEAM_TUNE = { stroke: 6, bloom: 4, inner: 1.5 } as const;

/** 一份 `tune` → 库的 css 口子那一段(`{id}` 由库换成这一份 beam 的 id)。没有就不写。 */
export function beamTuneCss(tune: BeamSpec['tune']): string | undefined {
  if (tune === undefined) return undefined;
  const parts: string[] = [];
  if (tune.stroke !== undefined) parts.push(`--beam-stroke-opacity:${tune.stroke}`);
  if (tune.bloom !== undefined) parts.push(`--beam-bloom-opacity:${tune.bloom}`);
  if (tune.inner !== undefined) parts.push(`--beam-inner-opacity:${tune.inner}`);
  return parts.length === 0 ? undefined : `[data-beam="{id}"]{${parts.join(';')}}`;
}

export function isStrong(kind: BeamKind): boolean {
  return kind !== 'pulse';
}

export function beamSize(kind: BeamKind): 'line' | 'md' | 'pulse-inner' {
  return kind === 'line' ? 'line' : kind === 'rotate' ? 'md' : 'pulse-inner';
}

export const BEAM = {
  /** 底部输入框:刚说的那句在路上(还没建下事项)。 */
  composer: { kind: 'line', tone: 'mono', strength: 0.9, staticColors: true },
  /**
   * 「正在办」那块卡(2026-09-25 起;以前是「今日要做」底边走光):有事在办时光绕整圈走。
   * 与电脑端台上那张在办的卡同一套光(3.2 秒一圈、NEUTRAL_BEAM_TUNE)。
   */
  doingCard: { kind: 'rotate', tone: 'mono', strength: 1, duration: 3.2, staticColors: true, tune: NEUTRAL_BEAM_TUNE },
  /** 「等你确认」那块卡:有东西等你拍板,轻轻呼吸(弱效果,不占名额)。量过太淡,抬一点(与电脑端 confirm 同一组数)。 */
  confirmCard: { kind: 'pulse', tone: 'mono', strength: 0.8, duration: 2.8, staticColors: true, tune: { stroke: 1.4, bloom: 1.6, inner: 1.3 } },
} as const satisfies Record<string, BeamSpec>;

/**
 * 首页这一屏的强效果归谁:录音中(全屏浮层在)→ 谁都不亮;刚说的那句在路上 → 输入框;
 * 有事在办 → 「正在办」那块卡;否则没有。
 */
export type StageStrong = 'composer' | 'doing' | null;
export function stageStrong(signals: { recording: boolean; sending: boolean; working: boolean }): StageStrong {
  if (signals.recording) return null;
  if (signals.sending) return 'composer';
  if (signals.working) return 'doing';
  return null;
}

/** 首页卡片区:哪块卡亮、亮成什么样。没有一行字的卡不亮(空卡亮着是骗人)。 */
export function stageCardFx(card: { id: string; lines: number }, strong: StageStrong): { beam: 'doing' | 'confirm' | null; active: boolean } {
  if (card.id === 'confirm') return { beam: 'confirm', active: card.lines > 0 };
  if (card.id === 'doing') return { beam: 'doing', active: strong === 'doing' && card.lines > 0 };
  return { beam: null, active: false };
}

/**
 * 通话页底边那道声音光(voice-glow)。
 *
 * 2026-09-24 维护者真机(0.2.79):「现在底部的光效是 AI 说话的时候出现,而且有点闪……
 * 我的预期是我说话的时候有光,AI 说话是粒子球动」。所以语义翻过来:
 *   - 正在接通 → 一道光来回扫(库的 processing 态),表示在连;
 *   - 接通后**你在说**(本机麦克风有声、她没在说、麦克风开着)→ 升起;
 *   - 她在说 → **不升**(由粒子球表现);没人说 → 不亮(不留库的轻呼吸,那也读成「有光」);
 *   - 没在通话 / 挂断中 / 接不通 → 整个不画。
 * 这里给的是**目标值**;屏幕上的值由 {@link stepVoiceFloor} 按帧追过去(上升快、下降慢),
 * 说一句话中间的停顿、说话 / 听的状态来回切,都不会让光一闪一闪。
 *
 * 2026-09-24 下午(卡 `fix/onboarding-call-same-as-call`,维护者:「引导环节底部的光……不是流动的,
 * 是贴图?反正不是很稳定,并且会闪烁」;确认点 5 拍板):
 *   - 这一层在通话里**常驻**,谁说话都不挂上又卸下(那一下重建画布、重放淡入就是「闪」);没人说时高度 0、底板透明;
 *   - 接通前那道扫光在接通时**淡出**({@link VOICE_SWEEP_FADE_MS}),不再一帧切掉;
 *   - **她在说时底边一点光都不留**:他刚说完的残光按快档({@link VOICE_HER_FALL_MS})落下去;
 *   - 光看的是「谁在出声」(`talk`,useCall 的 talkMode),**不看球的样子**:找项目时球被按成在办,他说话光照升。
 */
export interface CallVoice {
  /** 这一层在不在:正在接通 / 通话中就一直在(不因谁说话挂上又卸下)。 */
  on: boolean;
  /** 光的目标高度:只有你在说时是 {@link VOICE_ME}。 */
  level: number;
  /** 接通前那道来回扫的光。 */
  processing: boolean;
  /** 她在说:残光按快档落下,一点都不留。 */
  hers: boolean;
}
/** 你说话时光升到多高(只有这一种会升)。 */
export const VOICE_ME = 0.5;
/** 她说话时:不升。留着这个名字,是让「她说话 = 0」这条规矩在用例里看得见。 */
export const VOICE_HER = 0;
/**
 * `talk` 是「谁在出声」(useCall 的 talkMode:她在说 speaking / 你在说 listening / 都没说 idle),
 * **不是**球的样子 —— 球在找项目时被按成在办(working),光不能跟着一起哑掉。
 */
export function callVoice(input: { phase: CallPhase; talk: StageMode; micOff: boolean }): CallVoice {
  if (input.phase === 'connecting') return { on: true, level: 0, processing: true, hers: false };
  if (input.phase !== 'connected') return { on: false, level: 0, processing: false, hers: false };
  if (input.talk === 'speaking') return { on: true, level: VOICE_HER, processing: false, hers: true };
  if (input.talk === 'listening' && !input.micOff) return { on: true, level: VOICE_ME, processing: false, hers: false };
  return { on: true, level: 0, processing: false, hers: false };
}

/** 上升的时间常数(ms):一开口 ~0.1 秒就亮起来。 */
export const VOICE_RISE_MS = 90;
/** 下降的时间常数(ms):说完慢慢落下去;字与字之间的停顿(几百毫秒)只让它略降,不会掉到底再弹起来。 */
export const VOICE_FALL_MS = 650;
/** 她开口时残光落下的时间常数(ms):约 0.3 秒落净 —— 一点都不留,但也不是一帧切掉。 */
export const VOICE_HER_FALL_MS = 120;
/** 接通前那道扫光淡出的时间常数(ms):约 0.6 秒看不见(库自己的扫光也在这段里收拢)。 */
export const VOICE_SWEEP_FADE_MS = 200;
/** 低于这个值就当 0(不再追、不再画)。 */
export const VOICE_FLOOR = 0.01;

/**
 * 声音光按帧追目标:指数逼近,上升用 {@link VOICE_RISE_MS}、下降用 `fallMs`(缺省 {@link VOICE_FALL_MS})。
 * dt 过大(页面藏起来又回来)也不会越过目标;落到 {@link VOICE_FLOOR} 以下直接归 0,离目标很近直接到目标 ——
 * **一定追得到**,追到就停(不在后台空转)。
 */
export function smoothVoiceLevel(current: number, target: number, dtMs: number, fallMs: number = VOICE_FALL_MS): number {
  if (!(dtMs > 0)) return current;
  const tau = target > current ? VOICE_RISE_MS : fallMs;
  const next = current + (target - current) * (1 - Math.exp(-dtMs / tau));
  if (target === 0 && next < VOICE_FLOOR) return 0;
  if (Math.abs(target - next) < 0.002) return target;
  return next;
}

/** 屏幕上此刻的两样:光的高度、接通前那道扫光还剩多少(1 = 全亮,0 = 淡完)。 */
export interface VoiceFloorShown { level: number; sweep: number }

/** 目标:正在接通时扫光是 1;光的高度照 {@link callVoice}。不在通话 = 全 0。 */
export function voiceFloorTarget(voice: CallVoice): VoiceFloorShown {
  return { level: voice.on ? voice.level : 0, sweep: voice.on && voice.processing ? 1 : 0 };
}

/**
 * 按帧往目标走一步。扫光**亮起不等**(接通前那一屏一出来就在扫,库自己有 0.6 秒淡入),
 * **收起按 {@link VOICE_SWEEP_FADE_MS} 淡出**;光的高度照 {@link smoothVoiceLevel},她在说时按快档落。
 */
export function stepVoiceFloor(current: VoiceFloorShown, voice: CallVoice, dtMs: number): VoiceFloorShown {
  const target = voiceFloorTarget(voice);
  const level = smoothVoiceLevel(current.level, target.level, dtMs, voice.hers ? VOICE_HER_FALL_MS : VOICE_FALL_MS);
  let sweep = current.sweep;
  if (target.sweep >= current.sweep) sweep = target.sweep;
  else if (dtMs > 0) {
    sweep = current.sweep * Math.exp(-dtMs / VOICE_SWEEP_FADE_MS);
    if (sweep < VOICE_FLOOR) sweep = 0;
  }
  return { level, sweep };
}

/** 追到了没有(追到就停 rAF)。 */
export function voiceFloorSettled(shown: VoiceFloorShown, voice: CallVoice): boolean {
  const target = voiceFloorTarget(voice);
  return shown.level === target.level && shown.sweep === target.sweep;
}

/**
 * 底板的不透明度:跟着光的高度淡入淡出;接通前那道扫光按它还剩多少(淡出中也是平滑的)。
 * 没人说话、扫光淡完时是 0 —— 不留一层底光。
 */
export function voiceFloorOpacity(level: number, sweep: number): number {
  return Math.max(0, Math.min(1, Math.max(level / 0.12, sweep)));
}

/**
 * 库要不要停住(**停住 ≠ 卸掉**:不重建、不重放淡入,只是不再每帧画)。
 * 页面藏起来,或者底板已经全透明(没人说、扫光淡完)—— 看不见时别空转。
 */
export function voiceBeamPaused(shown: VoiceFloorShown, pageHidden: boolean): boolean {
  return pageHidden || (shown.level === 0 && shown.sweep === 0);
}

/**
 * 声音光那条线的颜色(2026-09-24 全局去蓝)。库的 `mono` 只管色块;线上沿那一圈色散
 * 用的是另一组颜色(缺省白芯 + 红 / 绿 / 蓝三道边),不设就会在灰光上沿残留一点红蓝。一律灰阶。
 */
export const VOICE_BAND_COLORS = {
  core: 'rgb(255, 255, 255)',
  above: 'rgb(214, 214, 214)',
  mid: 'rgb(186, 186, 186)',
  below: 'rgb(160, 160, 160)',
} as const;

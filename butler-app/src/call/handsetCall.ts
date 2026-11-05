/**
 * **话筒接起的那一通在手机上是同一张通话页**(2026-09-28,维护者原话:
 * 「座机拿起来的通话页面和我正常从首页打出去的那套 UI 不一样,因为座机……根本没有粒子球」;
 * 更正:「准确的说,只有座机打出去的页面不是同一套」)。
 *
 * 在这之前座机那一路进的是另一张页(`call/HandsetCallPage.tsx`,自己排版、自己一颗轻的声纹球、
 * 自己一颗挂断键),于是同一件事在两条路上长两个样。现在**只有一张通话页** ——
 * 舞台页(`stage/StagePage.tsx`)的通话态:正中那颗粒子球 + 球下字幕 + 底部那一组键,
 * 来电接起、首页拨出、座机提机三条路走的是同一份 DOM。
 *
 * 这个文件只做一件事:**把「话筒那一通」的状态摆成一份 {@link CallHandle}**,
 * 让 `CallOverlay` 拿它去画,而不需要另写一层。差异写成这份 handle 上的两格:
 *   - `elsewhere`:声音不在这台手机上 → 不摆麦克风键,并明写这台是哑的;
 *   - `note`:这一通是为哪件事打来的(他自己提机拨出去的那一通没有事项,那一格就缺席)。
 *
 * 决策记录 2026-09-21「座机形态:手机 + 树莓派话筒」照旧一个字没改:
 * > 提机 = 树莓派发 `offhook`,通话音频走树莓派的麦克风与听筒,**手机只显示字幕与按钮**。
 * 所以这一份 handle **不进房、不要麦克风权限、不推音轨、不放声音**(那全在 `useCall` 里,
 * 而座机这一路根本不激活它):这台手机这会儿不是那个说话的人,让它推一路麦克风等于
 * 房里有两只耳朵抢同一段话(工人的 `pickSpeaker` 会跟话筒走)。
 *
 * 「他把听筒放回去了」照旧由 `useIncoming` 认(工人挂机时广播 `ring_end{outcome:'hung_up'}`),
 * 这一屏自己就没了,他的手不用碰手机。那颗挂断键留着:话筒那头卡住时得有一条自己走得掉的路。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../session';
import type { StageMode } from '../swarm/orbState';
import { appendUtterance, formatCallElapsed, type CallUtterance } from './callModel';
import { clockTextOfMs, RING_REASON_TITLES, type IncomingCall } from './incomingModel';
import type { CallHandle } from './useCall';

export const HANDSET_HANGUP_LABEL = '挂断';
/** 顶上那一行。**说清此刻声音在哪一台机器上** —— 不然他会对着手机讲话。 */
export const HANDSET_BANNER = '话筒接起来了,对着话筒说就行';
/**
 * 接的是房里**另一台手机**时那一行(2026-09-22 晚,工人在 `ring_end.by` 里明说了)。
 * 老工人不带 `by`,那时照旧按话筒说 —— 座机形态下那就是事实。
 */
export const HANDSET_BANNER_OTHER_PHONE = '另一台设备接起来了,声音在那一台上';
/** 这一屏上那一行小字。**说清这台手机此刻是哑的**,不然他会以为坏了。 */
export const HANDSET_MUTED_TEXT = '这台手机这会儿不出声、也不收音 —— 谁接的电话归谁说话。';
/**
 * 顶上那一行状态(2026-09-23,Ben 12:45:「打过来和打过去都应该是显示同一个页面」)。
 * **打进与打出写的是同一句** —— 打进来那一通只是多一行事项。
 */
export const HANDSET_IN_CALL = '话筒通话中';
/** 接的是房里另一台设备时那一句(同 {@link HANDSET_BANNER_OTHER_PHONE} 的口径)。 */
export const HANDSET_IN_CALL_OTHER_PHONE = '另一台设备通话中';

/**
 * 通话页上那一行状态(2026-09-28 19:1x,维护者看着座机那一页:「你看看页面上那些乱七八糟的提示语」)。
 * **和手机打出去那一页同一句「通话中」**,时长那一行照旧在下面;「话筒接起来了」「这台手机不出声」
 * 「从几点起」不再摆 —— 他手里拿着话筒,知道声音在哪。房里另一台设备接的才改口。
 */
export const HANDSET_CALL_STATUS = '通话中';
export const HANDSET_CALL_STATUS_OTHER_PHONE = '另一台设备通话中';
export function handsetCallStatus(by?: 'handset' | 'phone'): string {
  return by === 'phone' ? HANDSET_CALL_STATUS_OTHER_PHONE : HANDSET_CALL_STATUS;
}

/** 「话筒通话中 · 从 14:03 起」。不知道从几点起就只写前半句,**不编一个时刻**。 */
export function handsetStatusText(by?: 'handset' | 'phone', since?: number): string {
  const label = by === 'phone' ? HANDSET_IN_CALL_OTHER_PHONE : HANDSET_IN_CALL;
  const time = clockTextOfMs(since);
  return time === '' ? label : `${label} · 从 ${time} 起`;
}

/** 这一通是为哪件事(球下那一行)。他自己提机拨出去的那一通没有事项 → null,那一行缺席。 */
export function handsetItemText(call?: IncomingCall): string | null {
  if (call === undefined) return null;
  return `${RING_REASON_TITLES[call.reason]} · ${call.title}`;
}

export interface UseHandsetCallInput {
  /** 通话页此刻是不是话筒那一通(false 时这份 handle 什么都不订、不计时)。 */
  active: boolean;
  /**
   * 这一通是为哪件事打来的。**他自己提机拨出去的那一通没有**(2026-09-23):
   * 那通没有铃、没有事项 —— 这一页照画,只是少一行。
   */
  call?: IncomingCall;
  /** 哪一台接的(`incomingModel` 的 `handset` 那一档)。不知道就按话筒说。 */
  by?: 'handset' | 'phone';
  /** 这一通从什么时候起(毫秒,工人报的)。不知道就不写那半句、也不摆时长。 */
  since?: number;
  /** 这台手机上按了挂断。 */
  onHangup: () => void;
  /** 时长那一行多久重算一次(测试调快)。 */
  tickMs?: number;
}

/**
 * 把「话筒那一通」摆成一份通话页认得的 handle。
 *
 * 球的形态**只按收到的字幕来**:她那条字幕到了就是她在说(`speaking`),他那条到了就是他在说
 * (`listening`)。这台手机既不收音也不放音,字幕是它手上**唯一**的真信号 —— 没有信号时
 * 停在上一档,**不假装它在收音**。
 */
export function useHandsetCall({ active, call, by, since, onHangup, tickMs = 1000 }: UseHandsetCallInput): CallHandle {
  const session = useSession();
  const [lines, setLines] = useState<readonly CallUtterance[]>([]);
  const [interim, setInterim] = useState<CallUtterance | null>(null);
  /** 最后一条字幕是谁的 —— 球的形态只按它来(见函数头)。 */
  const [talker, setTalker] = useState<'me' | 'butler' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** 挂断按一下就够了:连点、卸载与按钮同时触发都不该打两遍。 */
  const hungUp = useRef(false);
  const [ending, setEnding] = useState(false);
  /**
   * 这一句的语气(2026-10-02,卡「声音与形象跟着话走」)。**声音在话筒上,脸在这台手机上** ——
   * 字幕是这台机器手上唯一的真信号,语气就挂在它上面,所以这一通里那张脸照样跟着话走。
   * 不进 state 的理由见 {@link CallHandle.toneRef}。
   */
  const toneRef = useRef<string | null>(null);

  /**
   * **话筒那一通,这台手机的喇叭必须是关的**(2026-10-13 晚,维护者真机:「手机端提起话筒的时候,手机也在出声音」)。
   * 手机常驻房间,工人那条音轨一订上就挂了一个 `<audio>`,放不放只看 roomLink 里那个 `speaker` 开关;
   * 开关只该由手机自己那条通话路(livekitCall)打开,但哪一通没关干净、或者房间重连时沿用了旧值,
   * 下一次提机就从手机里漏出她的声音。这一通的声音在树莓派上,所以**进这张页就关**,不赌上一通关没关。
   */
  useEffect(() => {
    if (!active) return;
    try { session.channel.link.setSpeakerEnabled(false); } catch { /* 没有房间 / 已拆:本来就没声 */ }
  }, [active, session]);

  useEffect(() => {
    if (!active) return;
    return session.channel.onCaption((caption) => {
      const entry: CallUtterance = { who: caption.role === 'me' ? 'me' : 'butler', text: caption.text };
      setTalker(entry.who);
      if (entry.who === 'butler') toneRef.current = caption.tone ?? null;
      // 中间结果只画在屏幕上,不进这一份字幕列表 —— 和通话页那条链路逐字同一条规矩。
      if (!caption.final) { setInterim(entry); return; }
      setInterim(null);
      setLines((previous) => appendUtterance(previous, entry));
    });
  }, [active, session]);

  useEffect(() => {
    if (!active || since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [active, since, tickMs]);

  useEffect(() => { if (!active) { hungUp.current = false; setEnding(false); } }, [active]);

  /** 挂断那一下放 ref:调用方每次渲染给的是一个新闭包,不该让这颗键的身份跟着变。 */
  const onHangupRef = useRef(onHangup);
  useEffect(() => { onHangupRef.current = onHangup; }, [onHangup]);
  const hangup = useCallback(() => {
    if (hungUp.current) return;
    hungUp.current = true;
    // 挂断就回中性(同 useCall):最后那一句的脸不该一直挂在舞台上。
    toneRef.current = null;
    setEnding(true);
    onHangupRef.current();
  }, []);

  const itemLine = handsetItemText(call);
  const mode: StageMode = talker === 'butler' ? 'speaking' : 'listening';
  return useMemo<CallHandle>(() => ({
    phase: 'connected',
    statusText: handsetCallStatus(by),
    stageMode: mode,
    talkMode: mode,
    // 时长只有在工人报了起始时刻的时候才有。拿不到就整格空着 —— **不编一个 00:00**。
    elapsedText: since === undefined ? '' : formatCallElapsed(Math.max(0, now - since)),
    lines,
    ...(interim === null ? {} : { interim }),
    // 这台手机根本没在收音:麦克风那一格不是「关着」,是**不在这台机器上**(见 elsewhere)。
    micOff: false,
    ...(itemLine === null ? {} : { note: itemLine }),
    elsewhere: {
      banner: by === 'phone' ? HANDSET_BANNER_OTHER_PHONE : HANDSET_BANNER,
      muted: HANDSET_MUTED_TEXT,
    },
    failed: false,
    ending,
    hangup,
    // 没有麦克风键可按(CallOverlay 见 elsewhere 就不摆那颗),留一个空实现好过让类型上多一格可空。
    toggleMic: () => {},
    openSettings: async () => ({ ok: true }) as const,
    toneRef,
  }), [by, since, mode, now, lines, interim, itemLine, ending, hangup]);
}

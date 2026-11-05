/**
 * 来电界面(2026-09-21)。整屏、大字、球在正中。
 *
 * Ben 的产品形态:手机装在 3D 打印外壳里当座机。所以这一屏的取舍全冲着
 * **一臂之外看得清、不用看清也按得准**:
 *
 *   - 上面一行大字是**为什么**(等你确认 / 运行失败 / 完成),下面一行是**哪件事**。
 *     顺序不能反 —— 站起来走过去的那几步里,他只需要知道"要不要现在处理"。
 *   - 球在正中,和主界面同一颗(**不是另一颗图标**):电话是事务官打来的,
 *     屏幕上出现的就该是她。2026-09-22 起这一句是字面意思 —— 画的就是**同一颗粒子球**
 *     (swarm/ParticleStage.tsx,核心与 Mac 逐字同源),不再是那颗轻的声纹球。
 *   - 底下三颗键,左右分得很开:**接起**(绿、最大)、**稍后**、**静音**。
 *     「稍后」不是「拒接」—— 这通电话记成未接,她不会重拨,他有空自己回拨。
 *   - 还剩几秒**画成一条细线**,不写数字:一个跳动的倒计时会让人慌。
 *
 * 这一屏不持有任何状态(在 useIncoming 里),这样同一份状态既能画这一屏、
 * 也能在接起来之后交给舞台页去画通话。
 */
import { useEffect, useMemo, useState } from 'react';
import { ParticleStage } from '../swarm/ParticleStage';
import { defaultPreset } from '../swarm/appearance';
import type { Tuning } from '../swarm/core.js';
import type { StageNotice } from '../swarm/orbState';
import { RING_REASON_HINTS, RING_REASON_TITLES, type IncomingCall } from './incomingModel';

export interface IncomingCallPageProps {
  call: IncomingCall;
  onAnswer: () => void;
  onLater: () => void;
  /** 旁支消息(铃声放不出来、没有原生插件)。有就显示在最底下一行小字里。 */
  note?: string | null;
  /**
   * 粒子球那几个参数,来自 Mac(swarm/appearance.ts)。不给就用核心默认值 ——
   * 电话响着的时候**不为了一份还没拉到的参数不画球**。
   */
  settings?: Tuning;
  /** 粒子核心起不来、退回声纹球时说一句为什么。写日志用,界面上不吵。 */
  onOrbDegraded?: (reason: string) => void;
  /** 现在几点(测试注入)。 */
  now?: () => number;
}

/**
 * 为什么打 → 球的那一档颜色。和舞台页用的是同一套 `StageNotice`
 * (swarm/orbState.ts),**不为来电页新造一档颜色**。
 */
const RING_NOTICE: Record<IncomingCall['reason'], StageNotice> = {
  confirm: 'confirmation',
  failed: 'failed',
  done: 'completed',
  // 等你回答(2026-09-25,卡 M):那件事停着等他,同「等你确认」那一档琥珀。
  ask: 'confirmation',
  // 回话来了(2026-09-27,卡 CB):它只是把回话带给他,不要他决定什么 —— 同「完成」那一档。
  relay: 'completed',
};

export const ANSWER_LABEL = '接起';
export const LATER_LABEL = '稍后';
export const MUTE_LABEL = '静音';

export function IncomingCallPage({ call, onAnswer, onLater, note, settings, onOrbDegraded, now }: IncomingCallPageProps) {
  const clock = now ?? (() => Date.now());
  const fallbackSettings = useMemo(() => defaultPreset().settings, []);
  const [muted, setMuted] = useState(false);
  const [left, setLeft] = useState(() => Math.max(0, call.until - clock()));
  useEffect(() => {
    const timer = setInterval(() => setLeft(Math.max(0, call.until - clock())), 500);
    return () => clearInterval(timer);
  }, [call.until, clock]);

  /**
   * 「静音」只掐这台手机上的声音,**不改这通电话的状态** ——
   * 他把铃声按掉去开个会,电话还在响、还能接起来。掐铃的那一下在这儿做:
   * 上层那个 `<audio>` 由 useIncoming 管,这里只是不让它出声。
   */
  useEffect(() => {
    if (!muted) return;
    const audios = document.querySelectorAll('audio');
    for (const audio of audios) { try { audio.pause(); } catch { /* 拆的时候什么都可能抛 */ } }
    try { navigator.vibrate?.(0); } catch { /* 不支持就算了 */ }
  }, [muted]);

  /**
   * 这条线的总长 = **一进这一屏时还剩多久**,不是「until 减事件发生的时刻」——
   * 事件可能是十分钟前发生的(排过队、等过合并窗),拿它当分母线几乎不动。
   * 用 useState 的惰性初值:这一屏活着的时候它不变,线才是匀速的。
   */
  const [total] = useState(() => Math.max(1, call.until - clock()));
  const ratio = Math.max(0, Math.min(1, left / total));

  return (
    <div className="ba-incoming" role="dialog" aria-label="来电">
      <div className="ba-incoming__bar"><i style={{ width: `${Math.round(ratio * 100)}%` }} /></div>

      <header className="ba-incoming__head">
        <p className="ba-incoming__reason">{RING_REASON_TITLES[call.reason]}</p>
        <h1 className="ba-incoming__title">{call.title}</h1>
        {call.note !== undefined && <p className="ba-incoming__note">{call.note}</p>}
        {call.merged !== undefined && call.merged.length > 0 && (
          <p className="ba-incoming__note">另外还有 {call.merged.length} 件也完成了</p>
        )}
      </header>

      <div className="ba-incoming__orb">
        {/*
          * **和主界面同一颗粒子球**(2026-09-22 改,Ben 真机:「中间的来电显示不是粒子球」)。
          * 跑的是同一份核心(swarm/core.js,与 Mac 逐字相同),形态用 `acknowledging`
          * (琥珀色、「需要你」)—— **不新造一种形态**:一通打进来的电话正好就是那句「需要你」。
          *
          * 09-21 这里写的是轻的那一颗(声纹球 Orb),理由是「锁屏上拉起来时 WebGL 不一定活着,
          * 铃响着不能白屏」。**那条理由不成立**:粒子核心画在 2D canvas 上
          * (ParticleStage 里 `getContext('2d')`),而且它**自己带降级** ——
          * 起不来就退回同一颗声纹球。所以直接用它既不会白屏,又和主界面是同一颗球。
          * 退级的原因从这里交出去(`onOrbDegraded`),别让它只是"看起来不一样"。
          */}
        <ParticleStage
          mode="acknowledging"
          notice={RING_NOTICE[call.reason]}
          settings={settings ?? fallbackSettings}
          {...(onOrbDegraded === undefined ? {} : { onDegraded: onOrbDegraded })}
        />
      </div>

      <p className="ba-incoming__hint">{RING_REASON_HINTS[call.reason]}</p>

      <div className="ba-incoming__keys">
        <button type="button" className="ba-incoming__key ba-incoming__key--later" onClick={onLater}>{LATER_LABEL}</button>
        <button type="button" className="ba-incoming__key ba-incoming__key--answer" onClick={onAnswer}>{ANSWER_LABEL}</button>
        <button
          type="button"
          className="ba-incoming__key ba-incoming__key--mute"
          data-on={muted}
          aria-pressed={muted}
          onClick={() => setMuted(true)}
        >
          {muted ? '已静音' : MUTE_LABEL}
        </button>
      </div>

      {note !== null && note !== undefined && <p className="ba-incoming__foot">{note}</p>}
    </div>
  );
}

/**
 * 待机哼唱的唯一接线点：idle 定时器 → 防烦门 → 建计划 → 发声 → 演出参数。
 * 决策全在纯函数（humGate/humPlan）里，这里只做接线，故本文件不写单测。
 *
 * ★哼唱期间**不碰 setMouthOpen**：哼鸣是闭口鼻音，嘴不该动。
 *   演出只出 parameterOverrides（头/身摇摆 + 嘴角上扬）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ParameterOverride } from '../live2d/types.ts';
import { loadTtsEnabled } from '../../lib/ttsEnabledStore.ts';
import { acquireVoice, isVoiceBusy, releaseVoice } from '../../lib/voiceChannel.ts';
import { buildHumPlan } from './humPlan.ts';
import {
  applyHumStop, defaultHumGateState, markHumCompleted, markHumStarted,
  markInteraction, shouldHum, type HumGateState, type HumStopReason,
} from './humGate.ts';
import { humProfileFor, pickHumTune } from './humTunes.ts';
import { getHumAudioContext, renderHumPlan, type HumHandle } from './humVoice.ts';
import { shouldEmitSwayFrame, swayOverridesFor } from './humSway.ts';

/** 门检查频率：15 秒一次足够（阈值都是分钟级）。 */
const GATE_TICK_MS = 15_000;

export type UseSingingResult = {
  /** 并进 Live2DStage 的 parameterOverrides */
  swayOverrides: ParameterOverride[];
  isHumming: boolean;
  /** 用户有任何动作时调它——刷新交互时刻，并打断正在进行的哼唱 */
  noteInteraction: () => void;
};

export function useSinging(opts: { enabled: boolean; avatarId: string }): UseSingingResult {
  const { enabled, avatarId } = opts;
  const [swayOverrides, setSwayOverrides] = useState<ParameterOverride[]>([]);
  const [isHumming, setIsHumming] = useState(false);
  const gateRef = useRef<HumGateState>(defaultHumGateState(Date.now()));
  const handleRef = useRef<HumHandle | null>(null);

  const clearPerformance = useCallback(() => {
    handleRef.current = null;
    setSwayOverrides([]);
    setIsHumming(false);
    releaseVoice('singing');
  }, []);

  /**
   * 停掉正在进行的哼唱。是否计入连续打断（可能触发次日退避）由 reason 决定——
   * 判定本身在 humGate.applyHumStop 这个纯函数里，有单测钉着。
   * ★只走「被打断」这一条路——自然唱完由 renderHumPlan 的 onEnded 回调负责，
   * 两者不重叠：humVoice 的 stop() 不会触发 onEnded（见 Task 6 的 finish 注释）。
   */
  const stopHum = useCallback((reason: HumStopReason) => {
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = null;
    handle.stop();
    gateRef.current = applyHumStop(gateRef.current, reason, Date.now());
    clearPerformance();
  }, [clearPerformance]);

  /** 刷新交互时刻并停掉在哼的曲子；reason 决定这次停算不算「人不想听」。 */
  const noteActivity = useCallback((reason: HumStopReason) => {
    gateRef.current = markInteraction(gateRef.current, Date.now());
    if (handleRef.current) stopHum(reason);
  }, [stopHum]);

  const noteInteraction = useCallback(() => noteActivity('user-interaction'), [noteActivity]);

  // 用户动作 = 交互：指针按下、按键、从后台切回本页，都刷新计时并停掉哼唱。
  // ★切回本页必须算交互（spec 的「交互」定义里明写「切到本页面」）：Android 上点桌面
  //   图标回到 App **不会**产生任何 pointerdown/keydown，只有 visibilitychange。少了
  //   这条，后台待 10 分钟再切回来，下一个 15s tick 看到的就是「可见 + 已闲置 10 分钟」
  //   ——人刚回来盯着屏幕，她就开唱了，与「待机才哼」的意图恰好相反。
  // ★切回本页只刷新计时、**不**计入连续打断：用户没有做出任何「嫌吵」的动作
  //   （后台期间音频多半根本没播出来），计进去会让两次切 App 就把功能关到明早。
  useEffect(() => {
    const onAct = () => noteActivity('user-interaction');
    const onVisibility = () => {
      if (document.visibilityState === 'visible') noteActivity('app-returned');
    };
    window.addEventListener('pointerdown', onAct, { passive: true });
    window.addEventListener('keydown', onAct);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointerdown', onAct);
      window.removeEventListener('keydown', onAct);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [noteActivity]);

  // 门检查 + 起哼
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      gateRef.current = {
        ...gateRef.current,
        enabled,
        visible: document.visibilityState === 'visible',
        ttsEnabled: loadTtsEnabled(),
        voiceChannelBusy: isVoiceBusy(),
      };
      if (handleRef.current || !shouldHum(gateRef.current, now)) return;

      const ctx = getHumAudioContext();
      if (!ctx) return; // 老 WebView：静默跳过，不弹错
      void ctx.resume().catch(() => {});

      const profile = humProfileFor(avatarId);
      const plan = buildHumPlan(pickHumTune(), profile);

      gateRef.current = markHumStarted(gateRef.current, now);
      setIsHumming(true);
      // ★这个回调是「应用自己要用扬声器了」——主动消息（旅程 beat）走 performProactive
      //   → TTS → acquireVoice('tts', ...) 会同步喊到这里。而主动消息恰恰在用户闲着时
      //   才发，也正是唯一会起哼的时段：按「用户打断」计数的话，同一天来两条主动消息就
      //   把功能静默退避到明早，全程没有任何用户不满。故 reason 是 voice-preempted。
      acquireVoice('singing', () => stopHum('voice-preempted'));

      // 演出帧节流状态：每次起哼新开一份，天然随本次 renderHumPlan 的闭包生灭。
      let lastSwayEmitSec: number | null = null;

      handleRef.current = renderHumPlan(
        ctx,
        ctx.destination,
        plan,
        profile,
        ({ beatPhase, elapsedSec }) => {
          // 节流到 ~16Hz：rAF 逐帧 setState 会让 Live2DStage 的原生桥每帧过一次
          // flattenExpressionState，且引擎自带的 easeTowards 平滑本就吃不下那么高的更新率。
          if (!shouldEmitSwayFrame(lastSwayEmitSec, elapsedSec)) return;
          lastSwayEmitSec = elapsedSec;
          // 头/身随拍轻摇 + 嘴角上扬。★不写任何嘴部开合参数（swayOverridesFor 的生死线）。
          setSwayOverrides(swayOverridesFor(beatPhase));
        },
        () => {
          // 自然唱完
          handleRef.current = null;
          gateRef.current = markHumCompleted(gateRef.current);
          clearPerformance();
        },
      );
    }, GATE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled, avatarId, stopHum, clearPerformance]);

  // enabled 落下时立刻收声，而不只是「不再起新的」。
  // 门检查只在起哼那一刻看 enabled，所以来电响铃/进 DJ 模式若发生在哼唱**中途**，
  // 这一曲会继续压着铃声唱完（最长十几秒）。这是系统事件抢走场子，不是用户嫌吵，
  // 故按 voice-preempted 处理——不计入连续打断。
  useEffect(() => {
    if (!enabled) stopHum('voice-preempted');
  }, [enabled, stopHum]);

  // 卸载时收摊
  useEffect(() => () => { handleRef.current?.stop(0); releaseVoice('singing'); }, []);

  return { swayOverrides, isHumming, noteInteraction };
}

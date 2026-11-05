import { useEffect, useRef } from 'react';
import { createRingtone } from '../lib/ringtone.ts';

const DEFAULT_TIMEOUT_MS = 25000;

/**
 * 纯函数（无 React 依赖）：为一次来电事件起铃 + timeoutMs 超时计时，返回停止函数。
 * 到点自动 stop 铃声并调用 onTimeout(event)；提前调用停止函数则清掉计时器与铃声，
 * 不再触发 onTimeout —— 供 useRingingTimeout 的 effect 内部调用，也单独导出供单测
 * 直接验证计时语义（测试环境无 AudioContext，createRingtone 走 no-op，不影响计时器）。
 */
export function startRingingTimeout<E>(
  event: E,
  onTimeout: (event: E) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ringtoneUrl?: string,
): () => void {
  const ringtone = createRingtone(ringtoneUrl);
  ringtone.start();
  // 用全局 setTimeout（非 window.setTimeout）：与 lib/ringtone.ts 同惯例，跨 node/浏览器环境
  // 均可用，浏览器下等价于 window.setTimeout。
  const timer = setTimeout(() => {
    ringtone.stop();
    onTimeout(event);
  }, timeoutMs);
  return () => {
    clearTimeout(timer);
    ringtone.stop();
  };
}

/**
 * 共享 hook：event 非空时起铃 + timeoutMs（缺省 25s）计时，到点自动调用 onTimeout(event)；
 * event 变化（含从一通来电切到另一通、或置 null）时，effect cleanup 先清掉旧的一套
 * 计时器与铃声，再（若新 event 非空）起新的一套，不会叠加响铃或提前触发上一通的 onTimeout。
 *
 * onTimeout 存进 ref、每次渲染更新，effect 的 deps 只留 [event, timeoutMs, ringtoneUrl]：
 * 调用方即使每次渲染传入新的内联回调引用，也不会导致响铃被重新触发/计时器被重置——这是
 * 抽出本 hook 前 InlineCallPrompt 的已知易碎点，从根上消除。ringtoneUrl 是字符串基本值
 * （同一角色取值稳定），按值比较不会因引用变化误触发；仅当它随 event 一起真正变化
 * （换了一通不同角色的来电）时才会合理地重新起铃。
 */
export function useRingingTimeout<E>(
  event: E | null,
  onTimeout: (event: E) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ringtoneUrl?: string,
): void {
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!event) return;
    return startRingingTimeout(event, (e) => onTimeoutRef.current(e), timeoutMs, ringtoneUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, timeoutMs, ringtoneUrl]);
}

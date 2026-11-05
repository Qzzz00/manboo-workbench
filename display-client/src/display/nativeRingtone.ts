/**
 * 来电铃声的原生桥（来电链 v0）。
 *
 * 铃声必须出自展示台（Ben 拍板；话筒只管通话音频），而这台 ROM 上 WebView 的两条
 * JS 音频路都实锤走不通（<audio> currentTime 卡死；AudioContext 无手势挂起），
 * 所以铃声走原生 RingtonePlugin（MediaPlayer + res/raw 循环）。
 *
 * 失败绝不静默吞掉——src/lib/ringtone.ts 里 `.catch(() => {})` 把 mp3 路的死因
 * 藏了好几轮，这里所有结果都打进 DJTRACE，logcat 一眼可查。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { djTrace } from '../screensaver/lib/djClient';
import type { RingerLike } from './ringer';

interface RingtonePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const Ringtone = registerPlugin<RingtonePlugin>('Ringtone');

export function createNativeRinger(): RingerLike {
  if (!Capacitor.isNativePlatform()) {
    // dev 浏览器里没有原生层：不出声，但把动作打出来方便核对判定链。
    return {
      start: () => djTrace('铃声 start（非原生环境，仅记录）'),
      stop: () => djTrace('铃声 stop（非原生环境，仅记录）'),
    };
  }
  return {
    start: () => {
      Ringtone.start()
        .then(() => djTrace('铃声 start -> ok'))
        .catch((e) => djTrace('铃声 start 失败: ' + String(e)));
    },
    stop: () => {
      Ringtone.stop()
        .then(() => djTrace('铃声 stop -> ok'))
        .catch((e) => djTrace('铃声 stop 失败: ' + String(e)));
    },
  };
}

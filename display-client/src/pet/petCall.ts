// petCall：把通话数据流(音量/字幕)翻译成 Live2D 演出指令的纯逻辑控制器。
// 无后端时 startDemo() 用合成 sin 口型 + 脚本字幕自演示；真实 RTC 接上后
// 改为直接调 onBotAudioLevel/onBotUtterance，不再调 startDemo。
import type { Live2DController } from '../screensaver/lib/live2dController';
import { classifyCallEmotion } from '../lib/callEmotion';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface PetCallStage {
  subtitle: string;
  onBotAudioLevel(level: number): void;
  onBotUtterance(text: string): void;
  startDemo(): void;
  stop(): void;
  subscribe(fn: (subtitle: string) => void): () => void;
}

export function createPetCallStage(ctl: Live2DController): PetCallStage {
  let subtitle = '';
  const subs = new Set<(s: string) => void>();
  let demoRaf = 0;
  let demoTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const setSub = (s: string) => {
    subtitle = s;
    subs.forEach((f) => f(s));
  };

  const stage: PetCallStage = {
    get subtitle() {
      return subtitle;
    },
    onBotAudioLevel(level) {
      ctl.setMouth?.(clamp01(level));
    },
    onBotUtterance(text) {
      setSub(text);
      const result = classifyCallEmotion(text);
      if (result) ctl.setEmotion?.(result.emotion);
    },
    startDemo() {
      const lines = ['在的呀，怎么啦？', '嗯嗯，我在听～', '今天过得好吗？'];
      let i = 0;
      const tick = (t: number) => {
        stage.onBotAudioLevel(0.35 + 0.35 * Math.abs(Math.sin(t / 120)));
        demoRaf = requestAnimationFrame(tick);
      };
      demoRaf = requestAnimationFrame(tick);
      const speak = () => {
        if (i < lines.length) {
          stage.onBotUtterance(lines[i++]);
          demoTimer = setTimeout(speak, 2600);
        }
      };
      demoTimer = setTimeout(speak, 600);
    },
    stop() {
      if (demoRaf) cancelAnimationFrame(demoRaf);
      demoRaf = 0;
      if (demoTimer) clearTimeout(demoTimer);
      demoTimer = 0;
      ctl.setMouth?.(0);
      ctl.setEmotion?.(null);
      setSub('');
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  return stage;
}

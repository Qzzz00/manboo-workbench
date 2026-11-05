import { useCallback, useEffect, useState } from 'react';

import { Live2DScene } from './Live2DScene';
import { useBurnInShift } from './lib/burnInShift';
import { useDj } from './lib/djClient';
import { isDjModeActive } from './lib/djMode';
import { isNativeScreensaverActive, setNativeScreensaverBackground } from './lib/nativeLive2dScreensaver';
import type { Live2DController } from './lib/live2dController';
import { ClockWidget } from './widgets/ClockWidget';
import { WeatherWidget } from './widgets/WeatherWidget';
import { CalendarWidget } from './widgets/CalendarWidget';
import { NotificationsWidget } from './widgets/NotificationsWidget';
import { DjPlayerWidget } from './widgets/DjPlayerWidget';
import { BatteryWidget } from './widgets/BatteryWidget';
import { NightDim } from './widgets/NightDim';
import { useLifeSigns } from '../hooks/useLifeSigns.ts';

// 复用主 App 的家园背景图。相对文档路径，在 dev(/screensaver.html) 与真机
// (https://appassets.androidplatform.net/assets/public/screensaver.html) 下都能正确解析到
// .../backgrounds/home-bg.jpg。
const BG_URL = './backgrounds/home-bg.jpg';

export function Screensaver() {
  const [controller, setController] = useState<Live2DController | null>(null);
  const onReady = useCallback((c: Live2DController) => setController(c), []);
  // 仅当主 App 正处于 DJ 模式时联动：换装 + 电台卡片 + 实际放歌；否则未换装、无卡片、不放歌。
  const djActive = isDjModeActive();
  const dj = useDj(controller, djActive);

  // 防烧屏：只位移叠加层（静态文字/图标是烧屏风险；Live2D 自身会动，风险低）
  const shift = useBurnInShift();

  // 主动演出：背景跟随 lifeSigns.background_id（绝对 URL / 绝对路径直接用；否则拼 ./backgrounds/<id>.jpg）
  const lifeSigns = useLifeSigns();
  const bgUrl = lifeSigns.background_id
    ? (/^https?:\/\//i.test(lifeSigns.background_id) || lifeSigns.background_id.startsWith('/')
        ? lifeSigns.background_id
        : `./backgrounds/${lifeSigns.background_id}.jpg`)
    : BG_URL;

  // 低端机原生渲染：DOM 的 .ss-bg 被 html.native-live2d 隐藏，背景改由 GL 层画。
  // controller 就绪（=原生模型加载完）后下发，bgUrl 变化（lifeSigns 演出）时跟随。
  useEffect(() => {
    if (!controller || !isNativeScreensaverActive()) return;
    void setNativeScreensaverBackground(bgUrl);
  }, [controller, bgUrl]);

  return (
    <div className="ss-root">
      <div className="ss-bg" style={{ backgroundImage: `url(${bgUrl})` }} />
      <div className="ss-bg-scrim" />

      <Live2DScene onReady={onReady} />

      <div className="ss-overlay" style={{ transform: shift }}>
        <div className="ss-top">
          <div className="ss-top-left">
            <ClockWidget />
            <BatteryWidget />
          </div>
          <WeatherWidget />
        </div>

        {/* 信息卡片：靠上、靠右，填满顶部留白且避开角色面部 */}
        <div className="ss-cards">
          <CalendarWidget />
          <NotificationsWidget />
        </div>

        <div className="ss-spacer" />

        {/* 底部：AI DJ + 音乐播放器（一体）。仅在主 App 处于 DJ 模式时显示。 */}
        {djActive ? (
          <div className="ss-bottom">
            <DjPlayerWidget state={dj} />
          </div>
        ) : null}
      </div>

      <NightDim />
    </div>
  );
}

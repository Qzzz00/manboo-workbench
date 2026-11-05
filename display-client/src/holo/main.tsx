// 全息屏立牌入口：渲染「完整主 App」（聊天/DJ/通话全在），只叠一层「仅本入口加载」的
// 样式覆盖（holo.css）做到白底 + 满宽 + 无场景背景 + 无 DJ 遮罩 + 无舞台背景。
// 因为 holo.html 是独立页面，这层覆盖只作用于本页 —— 移动端主客户端(App.tsx/index.css)零影响。

// 老 WebView 兼容补丁（ResizeObserver / crypto.randomUUID）——必须最先执行
import '../polyfills-legacy';

// 锁定视口高度（照搬主入口，防键盘/转屏抖动）
function lockViewportHeight() {
  const setHeight = () => {
    document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
  };
  let lastWidth = window.innerWidth;
  setHeight();
  window.addEventListener('resize', () => {
    if (window.innerWidth !== lastWidth) {
      lastWidth = window.innerWidth;
      setHeight();
    }
  });
}
lockViewportHeight();

import { createRoot } from 'react-dom/client';
import '../index.css';
import './holo.css'; // 覆盖层：必须在 index.css 之后 import，才能压过主客户端样式
import App from '../App.tsx';
import HoloApp from './HoloApp.tsx';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { Capacitor } from '@capacitor/core';
import { applyPlatformFlags } from '../lib/platformFlags.ts';
import { setServerUrl } from '../lib/authStore';

applyPlatformFlags(document, Capacitor.isNativePlatform());

// ?server=http://your-aiboo-host:3456 指定后端地址（持久化，避免「大模型不可用」）
const serverParam = new URLSearchParams(window.location.search).get('server');
if (serverParam) {
  setServerUrl(serverParam);
  console.log('[holo] server set to %s', serverParam);
}

// 标记 holo 入口，供 holo.css 定位（body[data-holo]），确保覆盖只在本页生效。
document.documentElement.setAttribute('data-holo', '1');

// 角色构图：按 URL(?scale=大小 &head=竖向)覆盖 holo 取景目标。必须在 React 渲染(Live2DStage 读
// SURFACE_FRAMING.holo)之前下发。只影响本页(holo.html 独立运行时)，手机/DJ/屏保不受影响。
import { setHoloFraming } from '../features/live2d/live2dEngine';
import { resolveHoloFraming } from './holoStage';
setHoloFraming(resolveHoloFraming(window.location.search));

// 独立 HoloApp 已真机验收（2026-07-16 Stackchan 触摸遥控打通）→ 默认 v2；?app=v1 为逃生门回旧 App 版。
const useHoloAppV2 = new URLSearchParams(window.location.search).get('app') !== 'v1';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {useHoloAppV2 ? <HoloApp /> : <App />}
  </ErrorBoundary>,
);

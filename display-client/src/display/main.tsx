// 展示台入口（1200×800 桌面硬件）。
// 与 holo.html 并存而不是替换它：holo 那套是已经在真机上跑通的全息屏立牌，
// 这里是 PRD §6 的展示台版式。两者共用 Live2D / DJ / 黄历 链路，互不影响。

// 老 WebView 兼容补丁（ResizeObserver / crypto.randomUUID）——必须最先执行
import '../polyfills-legacy';

// 锁定视口高度（照搬 holo 入口，防转屏抖动）
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
// ★holo 的覆盖层：满宽 + 原生渲染下底色让位（否则角色被盖死）。展示台沿用同一套。
import '../holo/holo.css';
import { Capacitor } from '@capacitor/core';
import { DisplayApp } from './DisplayApp.tsx';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { applyPlatformFlags } from '../lib/platformFlags.ts';
import { setServerUrl } from '../lib/authStore';
import { setHoloFraming } from '../features/live2d/live2dEngine';
import { resolveHoloFraming } from '../holo/holoStage';

applyPlatformFlags(document, Capacitor.isNativePlatform());

// ?server=... 指定 Aiboo 后端地址（音乐/角色数据来源，持久化）
const serverParam = new URLSearchParams(window.location.search).get('server');
if (serverParam) setServerUrl(serverParam);

// 复用 holo 的取景标记与构图（Live2DStage 读 SURFACE_FRAMING.holo），必须在渲染前下发
document.documentElement.setAttribute('data-holo', '1');
setHoloFraming(resolveHoloFraming(window.location.search));

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <ErrorBoundary>
      <DisplayApp />
    </ErrorBoundary>,
  );
}

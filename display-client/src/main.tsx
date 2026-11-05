// 老 WebView 兼容补丁（ResizeObserver / crypto.randomUUID）——必须最先执行
import './polyfills-legacy';

// Lock viewport height to prevent keyboard from resizing layout
//
// 两个坑叠在一起，改这里前务必读完：
//  ① 冷启动首帧 WebView 尚未定视口，innerHeight 为 0。绝不能把 0 写进变量——CSS 的
//     var(--app-height, 100vh) 只在变量「未定义」时才走 fallback，定义成 0px 就老实用 0，
//     于是 .device-frame 高度塌 0，配合它的 overflow:hidden 把整个 UI 裁没（看起来像"只有角色"）。
//  ② 启动过程中 WebView 还会报「偏小的中间高度」（Pixel 实测先报 548，真实 986）。若拿它一锁了事，
//     画框只有半屏高，角色被压变形。
// 破法：键盘弹出只会让高度**变小**，所以「变大」一律接受（纠正中间态），「变小」一律忽略（防键盘），
// 转屏则以宽度变化为准无条件重锁。
function lockViewportHeight() {
  const root = document.documentElement;
  const apply = (h: number) => root.style.setProperty('--app-height', `${h}px`);
  const current = () => parseFloat(root.style.getPropertyValue('--app-height')) || 0;
  const grow = () => {
    const h = window.innerHeight;
    if (h > 0 && h > current()) apply(h);
  };

  let lastWidth = window.innerWidth;
  grow();

  // 启动后约 2s 内逐帧取最大值：覆盖「首帧为 0」与「中间态偏小」两种情况，且不依赖 resize 一定触发。
  let frames = 0;
  const settle = () => {
    grow();
    if (++frames < 120) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);

  window.addEventListener('resize', () => {
    const h = window.innerHeight;
    if (h <= 0) return;
    // 转屏：宽度变了，高度无论增减都以新值为准
    if (window.innerWidth !== lastWidth) {
      lastWidth = window.innerWidth;
      apply(h);
      return;
    }
    grow(); // 宽度不变：只接受变大，键盘导致的变小忽略
  });

  // 兜底：App 在锁屏后面/后台冷启动时量到的高度偏小（Pixel 实测锁屏下 896、解锁后 986），
  // 而那时上面的 rAF 观察窗早已过期。页面每次重新可见都补量一次，避免长期锁死在错误值上。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) grow();
  });
}
lockViewportHeight();

import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './call.css'; // 通话 UI 样式(从 index.css 抽出，主 App 与桌宠页共用)
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Capacitor } from '@capacitor/core';
import { applyPlatformFlags } from './lib/platformFlags.ts';

// 原生平台设置 data-native 属性，用于 CSS 选择器判断
applyPlatformFlags(document, Capacitor.isNativePlatform());

// 「电子吧唧」素材导出工具页（纯开发工具，桌面浏览器使用）：
// URL 带 ?badgeExport=1 时整页替换 App 渲染；懒加载独立 chunk，对正常 App 启动路径零影响。
const isBadgeExportTool = new URLSearchParams(window.location.search).get('badgeExport') === '1';
const BadgeExportPage = isBadgeExportTool
  ? lazy(() => import('./tools/badgeExport/BadgeExportPage.tsx'))
  : null;

import { detectRootKind } from './lib/radioLauncherPlugin.ts';

// 两个桌面根：按原生 BuildConfig.LAUNCHER_KIND（u3→radio / handheld→掌机）或
// ?radio=1 / ?handheld=1 整页替换 App；各自懒加载独立 chunk，对正常 App 启动路径零影响。
const RadioApp = lazy(() => import('./radio/RadioApp.tsx'));
const HandheldApp = lazy(() => import('./handheld/HandheldApp.tsx'));

detectRootKind()
  .catch(() => 'app' as const) // 探测失败绝不白屏：回落主 App 根（HOME 桌面白屏=致命）
  .then((rootKind) => {
  createRoot(document.getElementById('root')!).render(
    rootKind === 'radio' ? (
      <ErrorBoundary>
        <Suspense fallback={null}>
          <RadioApp />
        </Suspense>
      </ErrorBoundary>
    ) : rootKind === 'handheld' ? (
      <ErrorBoundary>
        <Suspense fallback={null}>
          <HandheldApp />
        </Suspense>
      </ErrorBoundary>
    ) : BadgeExportPage ? (
      <Suspense fallback={null}>
        <BadgeExportPage />
      </Suspense>
    ) : (
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    )
  );
});

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './aiboo/ErrorBoundary';
import { LargeTextProvider } from './settings/largeText';
import { DisplayStyleProvider } from './display/displayStyle';
import './styles.css';
import { installKeyboardViewport } from './viewport/keyboardViewport';
import { installPhoneErrorReporter } from './api/reportClientError';

// 弹键盘时粒子球不缩(2026-09-24):布局钉在没弹键盘那一档,只把输入框抬到键盘上沿。要在第一次渲染前装上。
installKeyboardViewport();

/**
 * 页面上出的错报给工作台(2026-09-25,卡 V)。**比第一次渲染还早挂上** —— 渲染本身就可能抛,
 * 而那一下正是最该记下来的。还没有能说话的客户端(没配对 / 在外面)时先攒着,
 * 客户端一就绪由 App 冲出去(`setPhoneErrorSink`)。这一路自己绝不抛(见该文件的四条纪律)。
 */
installPhoneErrorReporter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <LargeTextProvider>
        <DisplayStyleProvider>
          <App />
        </DisplayStyleProvider>
      </LargeTextProvider>
    </ErrorBoundary>
  </StrictMode>,
);

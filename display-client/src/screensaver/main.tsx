import { createRoot } from 'react-dom/client';

import { Screensaver } from './Screensaver';
import './screensaver.css';

// 不用 StrictMode：屏保是长时间运行的 WebGL 场景，StrictMode 在 dev 下双调 effect
// 会触发两次 createLive2DRuntime / WebGL 上下文创建，无谓增加风险；生产构建本就无此行为。
const rootEl = document.getElementById('screensaver-root');
if (rootEl) {
  createRoot(rootEl).render(<Screensaver />);
}

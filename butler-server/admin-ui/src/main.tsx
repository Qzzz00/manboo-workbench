// 来源:Aiboo origin/main 1f430c3f admin-ui/src/main.tsx(BrowserRouter → HashRouter)
//
// 用 HashRouter:后台托管在 butler-server 的 /admin/ 下,而 API 也在 /admin/avatars 这类路径上,
// 用 BrowserRouter 的话「刷新 /admin/avatars」会打到 API 而不是页面。hash 路由只有 /admin/ 一个入口。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from '@/app/App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
);

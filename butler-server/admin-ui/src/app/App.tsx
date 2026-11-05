// 来源:Aiboo origin/main 1f430c3f admin-ui/src/app/App.tsx(去登录;路由只留形象与设置)
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import AdminLayout from '@/app/AdminLayout';

// 路由级代码分割:Live2D 预览引擎(pixi)只在编辑页才拉。
const AvatarList = lazy(() => import('@/features/avatars/AvatarList').then((m) => ({ default: m.AvatarList })));
const AvatarUpload = lazy(() => import('@/features/avatars/AvatarUpload').then((m) => ({ default: m.AvatarUpload })));
const AvatarEdit = lazy(() => import('@/features/avatars/AvatarEdit').then((m) => ({ default: m.AvatarEdit })));
const AvatarVersionUpload = lazy(() => import('@/features/avatars/AvatarVersionUpload').then((m) => ({ default: m.AvatarVersionUpload })));
const Settings = lazy(() => import('@/features/settings/Settings').then((m) => ({ default: m.Settings })));

function RouteFallback() {
  return <p className="loading" style={{ padding: 24 }}>加载中…</p>;
}

function EditWrapper() {
  const { id } = useParams<{ id: string }>();
  return <AvatarEdit id={id!} />;
}

function UploadVersionWrapper() {
  const { id } = useParams<{ id: string }>();
  return <AvatarVersionUpload id={id!} />;
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* 本机版没有登录:butler-server 只收本机与工作台转发的请求(middleware/adminAuth.cjs)。 */}
        <Route element={<AdminLayout />}>
          <Route path="/avatars" element={<AvatarList />} />
          <Route path="/avatars/new" element={<AvatarUpload />} />
          <Route path="/avatars/:id" element={<EditWrapper />} />
          <Route path="/avatars/:id/upload" element={<UploadVersionWrapper />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="/" element={<Navigate to="/avatars" replace />} />
        <Route path="*" element={<Navigate to="/avatars" replace />} />
      </Routes>
    </Suspense>
  );
}

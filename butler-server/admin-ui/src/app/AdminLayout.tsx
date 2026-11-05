// 来源:Aiboo origin/main 1f430c3f admin-ui/src/app/AdminLayout.tsx(导航只留「形象」「音色与供应商」;去账号/退出)
import { Link, NavLink, Outlet } from 'react-router-dom';
import { Mic, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * 后台外壳:左侧竖向侧边栏(品牌 + 两项导航),右侧内容区 <Outlet/>。
 * 没有账号区:本机版无登录,唯一用户是 Ben。
 */

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/avatars', label: '形象', icon: Users },
  { to: '/settings', label: '音色与供应商', icon: Mic },
];

export default function AdminLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <Link to="/avatars" className="flex items-center gap-2 border-b border-slate-100 px-5 py-4 text-base font-semibold text-slate-800">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-100 text-violet-600">官</span>
          事务官 · 形象与音色
        </Link>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
                  isActive ? 'bg-violet-50 text-violet-700' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
          本机后端 butler-server · 只在这台 Mac 上可用
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}

// 应用抽屉：网格图标，点击拉起对应 App（返回键自然回电台桌面）。
import { useEffect, useState } from 'react';
import RadioLauncher from '../lib/radioLauncherPlugin.ts';

export interface AppEntry { pkg: string; label: string; icon: string }

/**
 * 三态展示体（加载中/空态/网格），从 hook 壳剥离成无 hooks 的纯函数，
 * 以便像 TrackListSheet 一样直调测试——useEffect 在 renderToStaticMarkup 下不执行，
 * 若把状态分支留在 AppDrawerSheet 里，空态/网格态永远测不到。
 */
export function AppDrawerBody({ apps, onLaunch }: { apps: AppEntry[] | null; onLaunch: (pkg: string) => void }) {
  if (apps === null) return <div className="radio-empty"><div>加载中…</div></div>;
  if (apps.length === 0) return <div className="radio-empty"><div>没有可打开的应用</div></div>;
  return (
    <div className="radio-appgrid">
      {apps.map((a) => (
        <button key={a.pkg} className="radio-appicon" onClick={() => onLaunch(a.pkg)}>
          <img src={a.icon} alt="" />
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  );
}

export function AppDrawerSheet({ onClose }: { onClose: () => void }) {
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  useEffect(() => {
    RadioLauncher.listApps().then((r) => setApps(r.apps as AppEntry[])).catch(() => setApps([]));
  }, []);
  return (
    <div className="radio-sheet">
      <div className="radio-sheet-head">
        <div className="radio-sheet-title">应用</div>
        <button className="radio-sheet-close" onClick={onClose}>✕</button>
      </div>
      <div className="radio-sheet-body">
        <AppDrawerBody apps={apps} onLaunch={(pkg) => void RadioLauncher.launchApp({ pkg }).catch(() => {})} />
      </div>
    </div>
  );
}

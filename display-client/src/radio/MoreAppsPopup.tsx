// 更多应用弹窗（Figma 主界面-更多应用）：磨砂罩 + 居中黑色圆角面板，网格铺真实已装应用。
// 复用原生 listApps/launchApp（与 AppDrawerSheet 同数据源），点罩层空白处关闭。
import { useEffect, useState } from 'react';
import RadioLauncher from '../lib/radioLauncherPlugin.ts';
import type { AppEntry } from './AppDrawerSheet.tsx';

export function MoreAppsPopup({ onClose }: { onClose: () => void }) {
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  useEffect(() => {
    RadioLauncher.listApps().then((r) => setApps(r.apps as AppEntry[])).catch(() => setApps([]));
  }, []);
  return (
    <div className="radio-moreapps" onClick={onClose}>
      <div className="radio-moreapps-title">更多应用</div>
      <div className="radio-moreapps-panel" onClick={(e) => e.stopPropagation()}>
        {apps === null ? (
          <div className="radio-empty">加载中…</div>
        ) : apps.length === 0 ? (
          <div className="radio-empty">没有可打开的应用</div>
        ) : (
          apps.map((a) => (
            <button
              key={a.pkg}
              className="radio-appicon"
              onClick={() => void RadioLauncher.launchApp({ pkg: a.pkg }).catch(() => {})}
            >
              <span className="radio-appicon-box">
                {a.icon ? <img src={a.icon} alt="" /> : <span>{a.label.slice(0, 4)}</span>}
              </span>
              <span>{a.label}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

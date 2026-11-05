/**
 * 更新完打开 App 那一句:「已更新到 0.4.91」(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 她刚在 App 里按过「下载并安装」、系统装完、App 重开 —— 这一句是**那一趟真的成了**的唯一回音。
 * 没有它的话,她点完按钮、过了系统安装器那几屏,回到的是一个看不出任何区别的首页。
 *
 * 判法:读这个包自己的 `build.json` 的 `version`,与**上次记下的**比。
 *   · 一样 → 一个字不说;
 *   · 从没记过(头一回装上这个功能的那台手机)→ 一个字不说,只把这一版记下来;
 *   · 读不到 build.json(10-03 之前打的老包、浏览器里调试)→ 一个字不说,**也不记一个空的**。
 * 全是数出来的,不经模型。
 *
 * 借的是首页那个 `.ba-toast` 的样子,**不新加 CSS**(避让在飞的 claude/phone-home-side-icons)。
 */
import { useEffect, useState } from 'react';
import { preferencesStore, type KeyValueStore } from '../api/tokenStore';
import { usePhoneBuildStamp } from './buildStamp';
import { justUpdatedText } from './phoneUpdate';

/** 上次打开 App 时这个包是哪一版。与设置、令牌分开存(解除配对不清它)。 */
export const PHONE_LAST_VERSION_KEY = 'butler.lastVersion';

/** 不点它的话多久自己收起来。它只是一句招呼,不是要她处理的事。 */
export const PHONE_UPDATED_TOAST_MS = 8_000;

export function UpdatedToast({ kv, fetchImpl, dismissMs }: {
  /** 测试注入;不传就用 Capacitor Preferences。 */
  kv?: KeyValueStore;
  /** 测试注入(读 build.json 那一下)。 */
  fetchImpl?: typeof fetch;
  dismissMs?: number;
}) {
  const stamp = usePhoneBuildStamp(fetchImpl);
  const [line, setLine] = useState<string | undefined>(undefined);

  const version = stamp?.version;
  useEffect(() => {
    // 读不到版本号就什么都不做 —— 连"上次是哪一版"那条记录都不动
    // (记一个空的,下一次真更新完就说不出话了)。
    if (version === undefined || version === '') return;
    const store = kv ?? preferencesStore();
    let alive = true;
    void (async () => {
      let last: string | null = null;
      try { last = await store.get(PHONE_LAST_VERSION_KEY); }
      catch { /* 读不到就当从没记过:只记一次,不说话 */ }
      if (alive) setLine(justUpdatedText({ ...(last === null ? {} : { last }), now: version }));
      if (last !== version) {
        try { await store.set(PHONE_LAST_VERSION_KEY, version); }
        catch { /* 存不了就下次再说一遍,比不说强 */ }
      }
    })();
    return () => { alive = false; };
  }, [kv, version]);

  useEffect(() => {
    if (line === undefined) return;
    const timer = setTimeout(() => setLine(undefined), dismissMs ?? PHONE_UPDATED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [line, dismissMs]);

  if (line === undefined) return null;
  return (
    <p className="ba-toast" role="status" onClick={() => setLine(undefined)}>{line}</p>
  );
}

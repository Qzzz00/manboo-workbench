/**
 * 系统返回键接到 React 这一侧(2026-09-24,卡 `fix/phone-nav-back`)。规矩在 backStack.ts。
 *
 * 三样东西:
 *   - `useSystemBack`:App 那一层装一次 Capacitor 的 `backButton`。谁都不接 → `minimizeApp()`
 *     (和一般安卓 App 一样退到后台;不退出登录、不清状态)。
 *     **只要装了监听,插件就不再自己处理返回**(见 @capacitor/app 的 AppPlugin.java),所以这里一定兜底。
 *   - `useBackHandler(active, onBack)`:开着的那一层登记自己。
 *   - `BackScope`:藏起来的那一格(`hidden` 的事项 / 资讯 / 设置 / 舞台)里的层一律不接 ——
 *     不然在首页按返回,关掉的会是藏在后面那一页里的东西。
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { BACK_LAYER, createBackStack, type BackStack } from './backStack';

interface BackScopeValue { stack: BackStack; active: boolean }

/** 没包 BackProvider 时(单测单挂一个组件)用这一份:登记照常,只是没人按。 */
const loose = createBackStack();
const BackContext = createContext<BackScopeValue>({ stack: loose, active: true });

export function BackProvider({ stack, children }: { stack: BackStack; children: ReactNode }) {
  const value = useMemo(() => ({ stack, active: true }), [stack]);
  return <BackContext.Provider value={value}>{children}</BackContext.Provider>;
}

/** 这一格此刻看不看得见。看不见时里面登记的层全部撤下,看得见了再登记回来。 */
export function BackScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parent = useContext(BackContext);
  const value = useMemo(() => ({ stack: parent.stack, active: parent.active && active }), [parent, active]);
  return <BackContext.Provider value={value}>{children}</BackContext.Provider>;
}

/**
 * 开着的一层:`active` 为真(且所在那一格看得见)时登记,按返回就调 `onBack`。
 * `onBack` 每次重画都可以是新的函数 —— 按下去时调的是最新那一个,不会因此重新登记
 * (重新登记会把它挪到「最后打开」,顺序就乱了)。
 */
export function useBackHandler(active: boolean, onBack: () => void, priority: number = BACK_LAYER): void {
  const scope = useContext(BackContext);
  const latest = useRef(onBack);
  latest.current = onBack;
  const on = active && scope.active;
  useEffect(() => {
    if (!on) return;
    return scope.stack.push(() => latest.current(), priority);
  }, [on, scope.stack, priority]);
}

/** 系统返回那一头。生产是 Capacitor;用例注入假的。 */
export interface SystemBackDeps {
  listen(onBack: () => void): Promise<{ remove(): unknown }>;
  minimize(): Promise<void>;
}

async function capacitorBack(): Promise<SystemBackDeps> {
  const { App: CapApp } = await import('@capacitor/app');
  return {
    listen: (onBack) => CapApp.addListener('backButton', () => onBack()),
    minimize: () => CapApp.minimizeApp(),
  };
}

/** 拆监听:拆不掉(同步抛 / 异步拒)都不吵。 */
function drop(handle: { remove(): unknown }): void {
  try { void Promise.resolve(handle.remove()).catch(() => undefined); } catch { /* 同上 */ }
}

/** App 那一层装一次:按返回先交给开着的那一层,谁都不接就退到后台。 */
export function useSystemBack(stack: BackStack, deps?: SystemBackDeps): void {
  useEffect(() => {
    let alive = true;
    let handle: { remove(): unknown } | null = null;
    void (async () => {
      try {
        const system = deps ?? await capacitorBack();
        const got = await system.listen(() => {
          if (stack.dispatch()) return;
          // 首页上谁都不接:退到后台。网页环境里 minimizeApp 没实现,拒掉就算了。
          void system.minimize().catch(() => undefined);
        });
        // 装好之前 App 已经卸了(StrictMode 头一遍、换配对重挂):当场拆掉,别留一个没人认的监听。
        if (!alive) { drop(got); return; }
        handle = got;
      } catch { /* 网页环境没有原生桥:浏览器自己的后退不归这里管 */ }
    })();
    return () => { alive = false; if (handle !== null) drop(handle); };
  }, [stack, deps]);
}

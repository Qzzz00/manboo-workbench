/**
 * 系统返回键 / 返回手势交给谁(2026-09-24,卡 `fix/phone-nav-back`)。
 *
 * 维护者原话:「这个逻辑也很奇怪啊,首页平时看不到底部栏,我是从设置进入的,
 * 从屏幕触发返回上一级无效,反而要点击底部栏?」
 *
 * 以前全仓没有一处接 Android 的返回:Capacitor 8 的 App 插件在**没人监听**时,
 * WebView 退不回去就什么都不做 —— 于是设置页上划返回「无效」,只能去点底部那条标签栏。
 * 从这张卡起标签栏拿掉,首页是唯一主页,别的页都是它的下一级,靠返回回来。
 *
 * 这个文件是**纯的**(不认 React、不认 Capacitor),规矩只有三条:
 *   1. 谁此刻「开着」谁登记一层(抽屉、弹层、会议页、通话……),关了就撤;
 *   2. 按一下返回只交给**一层**:先比档位(壳那一层最低,见 {@link BACK_PAGE}),
 *      同一档里**后登记的先接**(后打开的盖在上面);
 *   3. 谁都不接 → `dispatch` 回 false,交给兜底(App 那一层:在首页 = 退到后台)。
 */

/** 一层返回。接了就算数:不接的层根本不该登记(用 `active` 控制)。 */
export type BackHandler = () => void;

/**
 * 壳那一层(App.tsx 的 Shell):下一级 → 回首页、座机页 → 回舞台、来电与话筒那一通 → 不动。
 * **最低档**:页里开着的任何一层(抽屉、详情、字幕面板)都先于它 —— 不管谁先登记。
 */
export const BACK_PAGE = -1;
/** 页里开着的一层(缺省):抽屉、弹层、会议页、引导打字页、通话里的字幕面板。 */
export const BACK_LAYER = 0;

export interface BackStack {
  /** 登记一层,回一个撤掉它的函数(撤两次无害)。 */
  push(handler: BackHandler, priority?: number): () => void;
  /** 交给最该接的那一层;没有任何一层时回 false(交给兜底)。 */
  dispatch(): boolean;
  /** 此刻登记着几层(用例与排查用)。 */
  size(): number;
}

interface Layer { handler: BackHandler; priority: number; seq: number }

export function createBackStack(): BackStack {
  const layers: Layer[] = [];
  let seq = 0;
  return {
    push(handler, priority = BACK_LAYER) {
      const layer: Layer = { handler, priority, seq: ++seq };
      layers.push(layer);
      return () => {
        const at = layers.indexOf(layer);
        if (at >= 0) layers.splice(at, 1);
      };
    },
    dispatch() {
      let top: Layer | undefined;
      for (const one of layers) {
        if (top === undefined || one.priority > top.priority || (one.priority === top.priority && one.seq > top.seq)) top = one;
      }
      if (top === undefined) return false;
      top.handler();
      return true;
    },
    size: () => layers.length,
  };
}

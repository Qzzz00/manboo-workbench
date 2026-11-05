// AppDrawerSheet 渲染逻辑验证：三态展示体（加载中/空态/网格）用 T7 同款直调模式测——
// AppDrawerBody 是从 hook 壳剥离出的无 hooks 纯函数，可以像 TrackListSheet 一样直调取元素树。
// 顶层 hook 壳 AppDrawerSheet 用 renderToStaticMarkup 验证首挂载（apps=null）markup 不崩：
// React SSR 不跑 useEffect，listApps() 网络路径永远不会在此触发，无需 mock；
// U3 设备离线（Ben 拿在手里），真机点击酷狗图标/返回键跳转验证 pending（同 T7 备注）。
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { AppDrawerBody, AppDrawerSheet, type AppEntry } from './AppDrawerSheet.tsx';

type AnyEl = ReactElement<Record<string, unknown>>;

/** 递归收集元素树中满足 pred 的节点（同 TrackListSheet.test.ts 的 collect helper）。 */
function collect(node: unknown, pred: (el: AnyEl) => boolean, out: AnyEl[] = []): AnyEl[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out; }
  const el = node as AnyEl;
  if ('props' in el) {
    if (pred(el)) out.push(el);
    collect(el.props.children, pred, out);
  }
  return out;
}

const A = (pkg: string, label: string): AppEntry => ({ pkg, label, icon: `data:image/png;base64,${pkg}` });
const noop = () => {};

describe('AppDrawerBody 三态', () => {
  it('apps===null（加载中）：仅提示文案，无按钮', () => {
    const el = AppDrawerBody({ apps: null, onLaunch: noop });
    expect(renderToStaticMarkup(el)).toContain('加载中');
    expect(collect(el, (e) => e.type === 'button')).toHaveLength(0);
  });

  it('apps=[]（空态）：提示没有可打开的应用', () => {
    const el = AppDrawerBody({ apps: [], onLaunch: noop });
    expect(renderToStaticMarkup(el)).toContain('没有可打开的应用');
    expect(collect(el, (e) => e.type === 'button')).toHaveLength(0);
  });

  it('apps 非空：按传入顺序渲染 label/icon 网格', () => {
    const apps = [A('com.kugou', '酷狗音乐'), A('com.abc.via', 'Via 浏览器')];
    const el = AppDrawerBody({ apps, onLaunch: noop });
    const html = renderToStaticMarkup(el);
    expect(html).toContain('酷狗音乐');
    expect(html).toContain('Via 浏览器');
    expect(html).toContain('data:image/png;base64,com.kugou');
    const buttons = collect(el, (e) => e.type === 'button' && e.props.className === 'radio-appicon');
    expect(buttons).toHaveLength(2);
  });

  it('点击某应用图标 → onLaunch(该应用 pkg)——UI 触发入口的核心断言', () => {
    const onLaunch = vi.fn();
    const apps = [A('com.kugou', '酷狗音乐'), A('com.abc.via', 'Via 浏览器')];
    const el = AppDrawerBody({ apps, onLaunch });
    const buttons = collect(el, (e) => e.type === 'button' && e.props.className === 'radio-appicon');
    (buttons[1]!.props.onClick as () => void)();
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith('com.abc.via');
  });
});

describe('AppDrawerSheet 挂壳', () => {
  // AppDrawerSheet 自身带 hooks，不能像 TrackListSheet 那样直调取元素树断言 onClick 绑定
  // （无 dispatcher 会炸 Invalid hook call）；只能走真实 React 渲染（renderToStaticMarkup），
  // 但 SSR 只产出 HTML 字符串、不暴露可 collect() 的元素树，所以这里只断言 markup 结构，
  // 不独立验证关闭按钮的行为——它是与 TrackListSheet/RadioSettingsSheet 完全相同的
  // `<button className="radio-sheet-close" onClick={onClose}>✕</button>` 一行样板，
  // 已在两处直调用例里验证过等价写法的行为正确性。
  it('首挂载（SSR 不跑 effect，apps 仍是初始 null）：标题“应用”+ 关闭按钮 + 加载中占位，markup 不崩', () => {
    const html = renderToStaticMarkup(createElement(AppDrawerSheet, { onClose: () => {} }));
    expect(html).toContain('应用');
    expect(html).toContain('radio-sheet-close');
    expect(html).toContain('加载中');
  });
});

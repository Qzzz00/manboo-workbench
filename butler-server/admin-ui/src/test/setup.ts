// 来源:Aiboo origin/main 1f430c3f admin-ui/src/test/setup.ts(去掉登录态清理)
// React DOM act() 在 jsdom 测试环境下需要显式声明。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 未实现 scrollIntoView。
if (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = () => {};
}

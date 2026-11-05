/**
 * 用例里的页面默认装着起步层(2026-10-21,卡「分层第一刀」)—— 就像每台机器第一次启动时
 * 用户层目录里会放进那一份(`server/userLayer.ts` 的 ensure)。于是那几十份渲染整个工作台的老用例
 * 看到的那几格,与搬家之前逐字相同,它们就是「一个像素不变」的守门。
 *
 * 要测「用户层空着 / 坏了」的用例给 Workbench 传一份自己的登记表(`userLayer` 那个 prop),不碰这一份。
 * 只在 jsdom 里装:node 环境的服务端用例不需要 React 那一套。
 */
if (typeof document !== 'undefined') {
  const { userLayerRegistry } = await import('../../src/client/userLayer.tsx')
  const { installStarterLayer } = await import('../helpers/starterLayer.ts')
  installStarterLayer(userLayerRegistry)
}

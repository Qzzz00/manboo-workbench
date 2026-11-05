/**
 * jsdom 29.1.1 的样式表泄漏补丁(2026-09-21,`tests/client-dock.test.tsx` 九条"假红"的根因)。
 *
 * **现象**:同一个 jsdom 文档里反复 render / cleanup 工作台,每挂载一次
 * `document.styleSheets` 就**多一张**——DOM 里 `<style>` 早已不在,表却留着。jsdom 的
 * getComputedStyle / 选择器匹配每次都要遍历全部样式表,主样式表(style.ts)有 1100 多条
 * 规则,于是"等第一份快照落定的那次重渲"从第 1 条用例的 0.6 秒线性涨到第 12 条的 3.2 秒、
 * 第 90 条往后 10~20 秒——15 秒的 testTimeout 一到就红,红哪几条纯看当时机器多忙。
 * 取证过程见 `docs/交接-0921-client-dock假红根因.md`。
 *
 * **根因**(jsdom 29.1.1 `Node-impl.js` `_remove`):摘掉一棵子树时,它先
 * `domSymbolTree.remove(node); node._cachedRoot = null`,然后递归 `_detach()`,**最后**才清
 * 后代的 `_cachedRoot`。`HTMLStyleElement._detach` 里会重跑一次 `_updateAStyleBlock`:
 * 先把旧表从 `document.styleSheets` 摘掉,再看 `isConnected`——后代的 `_cachedRoot` 此刻
 * 还缓存着 document,`isConnected` 仍是 true,于是**又新建一张表加回去**。这张表的
 * ownerNode 已经不在树上,之后没有任何路径会再删它。`<style>` 是 body 直系子节点时
 * 不漏(它自己的 `_cachedRoot` 已经清了),嵌在任何子树里都漏——工作台的
 * `<style>{STYLE}</style>` 正是嵌在 `.ben-wb` 里。
 *
 * **为什么不换 jsdom 版本**:这台机器拉依赖会超时(见记忆「网络慢要续传」),而且 C4
 * 供应链把关要求 pin 版本、升级作为独立任务评估;等 jsdom 修了再升。
 * **为什么不在每个测试文件里各写一遍**:99 个客户端用例文件都渲染 `<style>`,漏是全局的,
 * 放 `vitest.config.ts` 的 setupFiles 一处生效。
 * **为什么 beforeEach 与 afterEach 各清一次**:清理必须跑在 Testing Library 的
 * `cleanup`(卸载)之后才有孤儿可清;各文件是自己注册 `afterEach(cleanup)` 的,
 * 与 setup 文件里的钩子谁先谁后取决于 vitest 的 `sequence.hooks`。两头各扫一次,
 * 顺序怎么排都不会把上一条的孤儿带进下一条的渲染;扫一次是遍历一个通常只有 0~3 项的列表,
 * 代价可忽略。
 *
 * **什么时候能删**:`tests/jsdom-stylesheet-leak.test.tsx` 第一条用例就是复现——
 * 它变红的那天说明 jsdom 已经修了,把这个文件、setupFiles 那一行与那条复现用例一起删掉。
 */
import { afterEach, beforeEach } from 'vitest'

/**
 * 把 `document.styleSheets` 里 ownerNode 已不在树上的孤儿样式表清掉,返回清掉的张数。
 *
 * 只用公开 DOM API:把孤儿 `<style>` 重新挂成 body 的直系子节点再摘掉——直系子节点这条路
 * jsdom 是对的(`_remove` 会先清它自己的 `_cachedRoot`,`_detach` 里 `isConnected` 为 false,
 * 旧表摘掉、不再新建)。不去碰 jsdom 的私有 `_list`:私有字段随小版本变,公开 API 不会。
 *
 * 顺带把那个 `<style>` 从它原来的(已脱离文档的)父节点里拿走了——那棵子树本来就是
 * 卸载后等 GC 的残骸,少一个子节点没有可观察的差别。
 */
export function purgeLeakedStyleSheets(doc: Document = document): number {
  let purged = 0
  for (const sheet of Array.from(doc.styleSheets)) {
    const node = sheet.ownerNode
    if (node === null || node.isConnected) continue
    doc.body.appendChild(node)
    doc.body.removeChild(node)
    purged++
  }
  return purged
}

// vitest.config.ts 把 environment 全局定成 jsdom,但守一道 typeof:万一某个文件用
// `@vitest-environment node` 覆盖了,这里不该炸。
const inDom = (): boolean => typeof document !== 'undefined' && document.body !== null

beforeEach(() => { if (inDom()) purgeLeakedStyleSheets() })
afterEach(() => { if (inDom()) purgeLeakedStyleSheets() })

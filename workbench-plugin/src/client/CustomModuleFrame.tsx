/**
 * 一个自定义模块在窗位槽里的那块 iframe(2026-09-21;2026-09-22 单开来源 + sandbox)。
 *
 * **嵌法逐字沿用事务官那一档**(W4,2026-08-26 定于 iframe / 2026-09-10 换成收件箱之后
 * 那套"盖在槽体上"的几何没变):
 *
 * - **盖住而不是替换**。槽体(`.ben-wb__slot-body`)必须一直挂在那儿 —— 它是窗位矩形的
 *   唯一来源,壳按那份矩形把原生窗摆过去。2026-08-26 那次真机事故就是"选中某一档时
 *   整个不渲染槽体",开机即钉死。这里是 `position:absolute` 铺在同一个定位上下文
 *   (`.ben-wb__slot-stack`)里,槽体一行不动。
 * - **懒挂载**。第一次真被选中之前一个 iframe 都不建 —— 建一个 iframe 就是让浏览器
 *   去加载一整份页面,没人看的时候不该付这个钱(同 SlotModule 里 `butlerEverShownRef`)。
 * - **切走保活**。挂上之后不卸载,只 `display:none`。卸载 = 番茄钟重新计时、
 *   清单里没存的那几个勾全丢 —— 一个"切过去就能用"的东西,切回来必须还是原样。
 *
 * ## 边界(2026-09-22,C7「自定义模块真边界」)
 *
 * 上一版这块 iframe 与工作台**同源**,于是那张「能用 / 不要碰」的接口表只是一份规范:
 * 页面里 `fetch('/credentials')` 照样打得通。Ben 拍板走「单开来源 + 白名单」那条
 * (决策记录 C7 / 交接-0921 第五节第 1 条的第三条路),所以这里变了两处:
 *
 * 1. **src 来自服务端**(`module.frame_url`),指向另一台监听(默认 `127.0.0.1:8794`),
 *    并签着这个模块自己那把短期令牌。前端**不拼这个地址** —— 端口与令牌都只有服务端知道。
 *    没有 `frame_url` 就一格都不挂(不退回同源那条老路)。
 * 2. **`sandbox="allow-scripts allow-forms"`**,故意**不给** `allow-same-origin`:
 *    文档因此是**不透明来源**,它发出去的每一条请求 `Origin` 都是 `null`,
 *    工作台那边据此当场降权成"模块身份",白名单之外一律 403。
 *
 *    代价说在明处:不透明来源里 `localStorage` / `sessionStorage` / IndexedDB / cookie
 *    **一律用不了**(碰就抛 SecurityError)。模块之间因此天然不共享任何浏览器存储 ——
 *    这正是想要的;而"这个小工具自己记一点东西"这件事这一版只剩内存(切走保活,
 *    所以关掉工作台才丢)。样例番茄钟本来就把 localStorage 包在 try/catch 里,照跑不误。
 *
 * ## src 为什么要冻住
 *
 * 令牌到期会换,而 `/state` 是一秒一拍的 —— src 一变这块 iframe 就重载,番茄钟当场从头
 * 开始计时(保活那条就没了)。所以第一次挂上时把 src 记下来,之后**再不跟着 /state 变**;
 * 页面里那把用来打接口的令牌由容器注入的前言自己去续(server/moduleOrigin.ts)。
 */
import { useRef } from 'react'
import type { CustomModuleView } from '../protocol.ts'

export function CustomModuleFrame({ module, active }: {
  module: CustomModuleView
  /** 这会儿是不是选中的那一档。 */
  active: boolean
}) {
  const everShownRef = useRef(false)
  /** 第一次挂上时冻住的那个 src(见上方「src 为什么要冻住」)。 */
  const srcRef = useRef<string | undefined>(undefined)
  if (active) everShownRef.current = true
  if (!everShownRef.current) return null
  if (srcRef.current === undefined) srcRef.current = module.frame_url
  const src = srcRef.current
  // 服务端没给 src = 单开来源没起来。一格都不挂,而不是挂一块打不开的白 iframe。
  if (src === undefined) return null
  return (
    <iframe
      className="ben-wb__module-frame"
      src={src}
      /**
       * 不给 `allow-same-origin`:这块 iframe 因此是不透明来源。给的两件是模块真要的 ——
       * `allow-scripts`(没有它页面就是一张死图)与 `allow-forms`(表单控件的默认提交行为;
       * 真往外提交那一步另有 CSP 的 `form-action 'none'` 挡着)。
       * 没给 `allow-popups` / `allow-top-navigation` / `allow-modals`:
       * 一个铺在窗位槽里的小工具没有理由弹窗、没有理由把整个工作台导航走。
       */
      sandbox="allow-scripts allow-forms"
      title={module.name}
      data-module-id={module.id}
      style={active ? undefined : { display: 'none' }}
    />
  )
}

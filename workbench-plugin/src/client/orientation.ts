/**
 * 方向判定(2026-09-18 横屏布局)。
 *
 * Ben 的主用屏是 1440×2560 的竖屏,工作台此前只有竖屏那一版排布;把壳窗口拖到
 * 2560×1440 的横屏上,界面一格都不重排。这个文件只回答一件事:**这块画布该按横屏
 * 还是竖屏排**。它不碰 DOM 结构、不碰布局数据,判定结果由 Workbench.tsx 落成
 * `data-orientation`,排布与持久化各自按这个值分叉。
 *
 * 判据是**两条一起成立**才算横屏:
 *   ① 宽 > 高——这是"横屏"字面上的意思;
 *   ② 宽 ≥ LANDSCAPE_MIN_WIDTH_PX——横屏排布是五个区域(左栏/中区/右栏/底部四格/日结),
 *      宽度不够时五个区域每个都只剩几十像素,比竖屏那一版更难用。
 * 只有 ① 没有 ② 的那一档(比如 1000×700 的小窗口、浏览器里随手拉出来的半屏)仍然走
 * 竖屏——竖屏排布本来就是"一列一列往下堆",窄而矮时它是更好的那个,不是将就的那个。
 */

import { useEffect, useState } from 'react'

export type Orientation = 'portrait' | 'landscape'

/**
 * 走横屏的最小宽度。1200 不是量出来的物理常数,是**按内容倒推的下限**:横屏中间那块
 * 窗位槽要贴得下一扇正常的原生窗(壳那边贴合的最小可用宽度约 640),右栏项目执行要
 * 放得下一行「项目名 + 状态 + 剩余天数」(约 320),左栏窄到只放标签(约 150),
 * 加上三处间距与边框——1200 是这几项加起来还留一点余量的整数。
 *
 * 可推翻:真机上如果 Ben 觉得 1200~1400 那一档横屏太挤,改这一个数就行,
 * 判定逻辑与排布代码都不用动。
 */
export const LANDSCAPE_MIN_WIDTH_PX = 1200

/**
 * 纯函数:给一块画布的宽高,回该走哪一版排布。
 *
 * 宽高任一非正数(元素还没排版、jsdom 里 getBoundingClientRect 恒为 0)一律判竖屏——
 * 「量不到」不是「是横屏」,而竖屏是既有的那一版,猜错的代价最小(D13 降级纪律)。
 */
export function pickOrientation(width: number, height: number): Orientation {
  if (!(width > 0) || !(height > 0)) return 'portrait'
  if (width <= height) return 'portrait'
  return width >= LANDSCAPE_MIN_WIDTH_PX ? 'landscape' : 'portrait'
}

/** 量画布用的最小接口——测试给一个普通对象就够,不必造一个真 Element。 */
export interface OrientationBox {
  width: number
  height: number
}

/**
 * 量画布 = **量视口**,不量元素。
 *
 * 一开始写成"优先量 `.ben-wb` 这个根元素,量不出面积再退回视口",跑全量用例时炸出
 * 三条与横屏毫无关系的既有用例(tests/client-dock.test.tsx 的稳定性门那一组):
 * 它们为了给窗位槽钉一个假矩形,`vi.spyOn(Element.prototype, 'getBoundingClientRect')`
 * 把**全局所有元素**的矩形都换成了同一份(1420×900),于是根元素跟着"变成"横屏,
 * 那几条用例在一个它们从没打算进入的排布里跑。
 *
 * 这不是"测试写得不好"就能糊过去的——它暴露的是"量元素"这条路的真实脆弱面:
 * 排布方向这么大的一个开关,不该取决于某一个元素此刻碰巧被谁量成了什么。而 `.ben-wb`
 * 在 style.ts 里就是 `position:absolute;inset:0`——它铺满的正是这个视口,两者按构造相等,
 * 量视口不损失任何信息,却少掉一整类"某个元素的矩形被动过手脚"的意外。
 *
 * 代价写明(可推翻):将来工作台真的被嵌进一块**比视口小**的区域里(现在没有这条路,
 * 壳的 WKWebView 与浏览器标签页都是整屏),这里要改成量那个容器。改的只有这一个函数。
 */
export function measureOrientationBox(view: OrientationBox): OrientationBox {
  return view
}

/**
 * 「这块画布现在是横是竖」的 React 钩子。挂载时量一次,之后**两条路各订一路**,
 * 回调是同一个(重读视口、重判、只在真翻档时 setState):
 *
 *   ① `window` 的 resize 事件——**这是主路**。壳窗口被拖到另一块屏后重排、用户手动拉大
 *      拉小,走的都是它。用例里驱动方向切换的也是它(tests/client-landscape.test.tsx)。
 *   ② `document.documentElement` 上的 ResizeObserver——**纯兜底**,给"视口盒子变了但
 *      resize 没来"那一类场景留的。如实记一笔:**这条没有被单独验证过**。它是在本分支
 *      验收时误判出来的——当时在无头预览里改视口后页面不重排,以为是"resize 事件不来",
 *      加了这条;后来查清真正原因是**预览面板当时是隐藏的**,隐藏页面的排版与回调本来
 *      就被节流,两条路一起都不会触发。留着它是因为它便宜(同一个回调,没有第二套行为)
 *      且确实覆盖得到那一类场景;但谁要是拿它当"已经验过的保险"就错了。
 *
 * **不去抖**:方向是个只有两档的离散值,拖动过程中绝大多数帧算出来的结果跟上一帧相同,
 * setState 传同值 React 本来就不会重渲;真正翻档的那一帧应该立刻翻,拖到横屏上还要等
 * 800 毫秒才重排是 bug 不是节流。
 *
 * RO 观察的是**根元素**、量的仍然是**视口**(回调里一个 getBoundingClientRect 都不调)——
 * 这两件事分开,正是 measureOrientationBox 那段注释里踩过的坑要求的。jsdom 没有
 * ResizeObserver,守一道 typeof(同 Workbench.tsx 槽体上报那段的先例),退化成只听 ① 。
 */
export function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>(
    () => pickOrientation(window.innerWidth, window.innerHeight),
  )

  useEffect(() => {
    const read = (): void => {
      const box = measureOrientationBox({ width: window.innerWidth, height: window.innerHeight })
      const next = pickOrientation(box.width, box.height)
      setOrientation(prev => (prev === next ? prev : next))
    }
    read()
    window.addEventListener('resize', read)
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(read)
      observer.observe(document.documentElement)
    }
    return () => {
      window.removeEventListener('resize', read)
      observer?.disconnect()
    }
  }, [])

  return orientation
}

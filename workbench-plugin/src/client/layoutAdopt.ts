/**
 * 「服务端那份布局变了,界面要不要跟着换」的判断(2026-09-27,卡 TM;2026-10-28
 * 改为按内容判,见下)。
 *
 * ## 为什么会有这个文件
 *
 * 2026-09-27 维护者原话:「在设置里切换自媒体布局,压根没有切换布局成功。」
 * 查实的根因在 `Workbench.tsx`:布局这份 state **只在第一次 `feed.loaded` 那一拍**
 * 从 `/state.layout` 取一次(`layoutInitRef` 一翻就再也不看第二眼),之后每秒轮询回来的
 * `layout` 一律丢掉。而切模板走的是**服务端**那条路(`/template/apply` → 写盘 → 下一拍
 * `/state.layout` 就是新排布)—— 服务端全做对了,页面却永远停在打开那一刻的排布:
 * 模块标题、泳道、素材那几格(它们读的是 `/state.template`,每拍都新的)全变了,
 * 只有**模块怎么排**一格没动。TemplatePanel 还照着回了一句「界面下一拍就会变」,
 * 那句话在修好之前是假的。
 *
 * 顺带一条更糟的:页面手里那份是**旧**布局,他切完模板随手拖一下任何模块,
 * 800ms 防抖一到就把这份旧布局 POST 回去 —— 刚切好的模板排布**被覆盖**,
 * 连重开页面都回不来了。
 *
 * ## 那为什么当初只取一次
 *
 * 布局是用户数据(spec D12):本地立即应用、800ms 静默后落盘。每拍都无条件套上服务端那份,
 * 会在防抖窗口里把他正在拖的那一下弹回去(服务端那份此刻还是旧的)。所以不能简单地
 * 「每拍都跟」,要分得清**这一变是谁改的**:
 *
 * - 服务端那份跟上一拍**一模一样** → 没人改,什么都不做(绝大多数拍走这条);
 * - 本地**正改着还没落盘** → 他手上那一下最新,不许被盖回去;
 * - 这一变**正是我们自己刚 POST 出去的那份** → 是回声,不是别人改的,不动
 *   (服务端会净化/夹值,原样套上去会让他刚拖的那一下跳一下);
 * - 其余(切模板、回退上次、说一句话改布局、手机端改的) → **换过去**。
 *
 * ## 2026-10-28:按内容判,不按文本判(交接-1027「12:0x 气泡」那节的治本第三条)
 *
 * 这一变之前,三样输入一律 `JSON.stringify` 成字符串再比。问题出在**回声那一条**:
 * 服务端 `POST /layout` 的 `parseLayout`(src/server/http.ts)收到布局后**按自己的
 * 字段顺序重建对象**(modules → butler → …,模块逐个 sanitize),存盘、再从 `/state`
 * 原样读出来。键序跟页面 POST 出去的那份几乎必然不同——内容一字没变,
 * `JSON.stringify` 的文本就是不相等。于是自己刚发的布局被误判成"别人改的",
 * `adopt` 把它套回 state:浮窗刚拖的那一下被顶回去、`min`/`pos` 被旧值覆盖,
 * 配合渲染时的位置回写就是 `POST → 回声 → POST` 反复开合的环(维护者:「气泡一直在
 * 打开又收起」,四步一轮、每 ~2.9 秒一轮,程序证据见那份交接)。
 *
 * 判据改成**内容相等**(键序不敏感的深比较,`layoutContentEqual`):回声无论被服务端
 * 重排成什么键序都认得出是自己人;真正变了内容(切模板、别人改了一个值)照旧 `adopt`。
 * 纯函数、放在自己的文件里给用例直接对 —— 这是「切了就要看得见」与「自己的回声别
 * 当自己人打」这两件事唯一的判据,值得有一份钉死它的用例。
 */

/**
 * 键序不敏感的深比较(布局这两份都是 JSON 树:对象、数组、原始值)。
 *
 * 原始值按 `===`,两个特判:NaN 与 NaN 相等(布局里的百分比/像素夹来夹去不该产出
 * NaN,但存档是用户数据,真混进一个也别让它把比较器点炸);`===` 天然认 0 与 -0
 * 相等(布局里不会出现这个语义差别,不额外用 Object.is 把它们拆开)。
 */
export function layoutContentEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    // 原始值:=== 认 0 与 -0 相等(布局里不会出现语义差别);NaN 单独认相等。
    return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => layoutContentEqual(item, b[index]))
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(key => (
    Object.prototype.hasOwnProperty.call(b, key)
    && layoutContentEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  ))
}

/** 判断要用到的四样。布局一律以**解析后的对象**参与比较(比内容,不比序列化文本)。 */
export interface LayoutAdoptInput {
  /** 这一拍 `/state.layout`。 */
  incoming: unknown
  /** 上一拍从服务端看到的;还没看过时 null。 */
  seen: unknown | null
  /** 我们自己最后 POST 出去的那份;没 POST 过时 null。 */
  posted: unknown | null
  /** 本地改了还没落盘(防抖窗口里)。 */
  pendingLocal: boolean
  /** 已经用服务端那份初始化过了吗。 */
  initialized: boolean
}

/**
 * - `init`:第一次,拿服务端那份当初始值(等于修之前的唯一行为);
 * - `adopt`:服务端那份被别的路改了,界面换过去;
 * - `keep`:什么都不做。
 */
export type LayoutAdoptDecision = 'init' | 'adopt' | 'keep'

export function decideLayoutAdopt(input: LayoutAdoptInput): LayoutAdoptDecision {
  if (!input.initialized) return 'init'
  if (layoutContentEqual(input.incoming, input.seen)) return 'keep'
  if (input.pendingLocal) return 'keep'
  if (layoutContentEqual(input.incoming, input.posted)) return 'keep'
  return 'adopt'
}

/**
 * 坞上**每一格**的图标(2026-09-26,卡 LG2)。
 *
 * 维护者原话(18:05,看着坞):「做事做一半,现在只有 Agent 有 logo,你看着怪不怪」。
 *
 * 卡 LG 把各家 Agent 的 logo 接上了,可坞上还有一多半不是 Agent:微信、企业微信、Notion、
 * 终端、Finder、Pen…… 它们在登记表里是 `not_agent`(判过了,确实不是 Agent),
 * 所以 `/agents/icon/:id` 那条路一辈子也给不了它们一张图 —— 那条路只认登记表里的家。
 *
 * ## 这一条走的是坞自己那份清单
 *
 * 坞上那一格的**键**(`c-wechat` / `term` / `c-finder` / `claude`……)就是这条接口的参数:
 *
 *   GET /apps/icon/<坞项的键>   → image/png
 *
 * 服务端按键去查它是哪个包(`appsRegistry.bundleFor`,基础键退回 `APP_BUNDLES`),
 * 再拿包标识问壳要整张图标(同 LG 的 `app_icon`,只碰 NSWorkspace、一个辅助功能调用都没有)。
 * **键→包的换算只在服务端做**:界面给的是一个坞上登记过的键,不是一个随手写的包标识 ——
 * 不然这条接口就成了「把这台电脑上任意一个 App 的图标念给我听」,已配对的手机也能问。
 * 白名单 = **坞与窗位清单里登记过的那几个键**,一个不多。
 *
 * ## 缓存与 LG 那一份是同一份
 *
 * 取图、内存缓存(不落盘)、ETag / 304 全沿用 `agentIcons.ts` 那一套 ——
 * 登记表里那几家与坞上这几格共用**同一个 `IconCache`**(键是包标识),
 * 所以 Claude 这样「既在登记表里、又在坞上」的家只会被渲一次、只占一份内存。
 *
 * ## 为什么没有「按 App 名字找」那一档
 *
 * 卡里提过「没 bundle_id 的用 app_name 让壳找」。真查下来**坞上不存在没有包标识的格**:
 * `dock.json` 每一条都存着 `bundle_id`;自定义应用是 `appsRegistry.add` 拿 osascript
 * 查到真包标识才登记的;模板里 `native` 那种「查不到包标识就不写」的项,
 * `templateStore.registerApps` 压根不给它登记(只在结果里记一句「未查到 bundle id,没登记」),
 * 到不了坞上。所以没给壳加一条按名字找的路(那会是一段谁也走不到、却能被人拿来试路径的代码);
 * 真冒出这样一格,这条接口 404 + 一句人话,界面画中性小方块。
 */
import { APP_BUNDLES } from './activation.ts'

/** 坞上那一格要问壳哪一个 App。 */
export interface AppIconTarget {
  /** 坞项的键(报错那一句里要带上它)。 */
  key: string
  /** 问壳用的包标识。 */
  bundle_id: string
}

/** 键→包标识查得着的那两条路(`appsRegistry` 的既有方法,不扩接口)。 */
export interface AppIconLookup {
  bundleFor: (key: string) => Promise<string | undefined>
}

/**
 * 键长什么样才收(纯函数)。坞上的键是 `appsRegistry` 生成的:基础键是 `codex` / `term` 这种,
 * 自定义应用是 `c-<slug>` / `c-<slug>-2`、模板的是 `t-<slug>` —— **一律小写字母、数字、连字符**。
 * 别的字形(路径分隔符、点、中文、空格)当场拒掉:不让一个看着像路径的东西走到查表那一步。
 */
export function isDockKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(key)
}

/**
 * 坞上那一格是哪个包(2026-09-26,卡 LG2)。
 *
 * 两步,都只查我们自己登记过的表:
 * 1. `appsRegistry.bundleFor(key)` —— 基础键查 `APP_BUNDLES`、自定义应用查 apps.json;
 * 2. 查不着而它是**基础键**时退回 `APP_BUNDLES`(基础键被「删过」/ 首次还没做完时 `bundleFor`
 *    故意不给,可 `dock.json` 里那一格还在 —— 那一格该有图,而一张我们自己表里写着的
 *    系统应用图标没有任何要瞒的)。
 *
 * 两条都不着 → undefined(接口 404 + 一句人话,界面画中性小方块)。
 */
export async function resolveDockApp(key: string, lookup: AppIconLookup): Promise<AppIconTarget | undefined> {
  const trimmed = key.trim()
  if (!isDockKey(trimmed)) return undefined
  const found = await lookup.bundleFor(trimmed)
  const bundleId = found ?? (Object.hasOwn(APP_BUNDLES, trimmed) ? APP_BUNDLES[trimmed] : undefined)
  if (bundleId === undefined || bundleId === '') return undefined
  return { key: trimmed, bundle_id: bundleId }
}

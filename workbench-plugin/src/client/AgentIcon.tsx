/**
 * 坞上、顶栏上那一张小图标(2026-09-26,卡 LG 起手,卡 LG2 补齐)。
 *
 * 卡 LG(维护者原话):「增加一个功能,就是现在电脑上有多少个 Agent 客户端,把对应的 logo 也搞上;
 * 桌面端的应用标签,也加各家的 logo icon」。
 * 卡 LG2(维护者 18:05,看着坞):「做事做一半,现在只有 Agent 有 logo,你看着怪不怪」。
 *
 * **一个组件管所有地方**:窗口槽标签(Agent 的与不是 Agent 的都算)、顶栏那一排小灯、
 * 「这台电脑上 N 家 Agent 客户端」那一条。{@link AppIcon} 是核心,{@link AgentIcon} 是
 * 「登记表里那一家」的那层壳(图从 `GET /agents/icon/<登记表 id>` 来)。
 *
 * ## 取不到画什么:分两种家
 *
 * - **Agent**(登记表里的):退回**色点** —— 卡 Q 那一颗,颜色从它图标的主色来,
 *   状态(在跑 / 等你)本来就由它说。
 * - **不是 Agent 的家**(微信、企业微信、Notion、终端、Finder、Pen……):退回一个
 *   **中性的小方块**。它们**没有状态色**,给一颗彩色圆点等于凭空发明一个语义
 *   (「微信在跑?」),而一个和图标一样大的空位至少让名字与别的格对齐。
 *
 * 退回的时机有三处:服务端说这一家没有图(登记表那一格 `icon` 是假)、这条接口 404
 * (这台电脑上没装 / 壳是旧版 / 认不出这一格)、图真的加载失败。三处都不出错、不空白、不留破图。
 *
 * ## 读屏怎么念
 *
 * 图标**不参与读屏**(`alt=""` + `aria-hidden`):名字就在它旁边,念两遍是噪音;
 * 顶栏那颗灯的可读名字("Muse 的详情")也不能被图标挤掉。
 */
import { useEffect, useState } from 'react'
import { AGENT_NEUTRAL_COLOR } from '../protocol.ts'
import type { EntryLamp } from './agentRegistryView.ts'

/** 界面上这张图多大(px)。窗口槽标签与顶栏都是 16。 */
export const AGENT_ICON_SIZE = 16

/** 一家的 logo 在哪儿(没有 baseUrl 就用相对地址 —— 页面本来就是工作台自己发的)。 */
export function agentIconSrc(id: string, baseUrl?: string): string {
  return `${baseUrl ?? ''}/agents/icon/${encodeURIComponent(id)}`
}

/**
 * 坞上那一格的图标在哪儿(2026-09-26,卡 LG2)。参数是**坞项的键**(`c-wechat` / `term` /
 * `c-finder`……);键→包标识的换算在服务端(`server/appIcons.ts`),界面不碰包标识。
 */
export function appIconSrc(key: string, baseUrl?: string): string {
  return `${baseUrl ?? ''}/apps/icon/${encodeURIComponent(key)}`
}

/** 取不到图时画什么:`dot` = 那颗色点(Agent);`square` = 中性的小方块(不是 Agent 的家)。 */
export type IconFallback = 'dot' | 'square'

/**
 * 一张小图标 + 它的退路(2026-09-26,卡 LG2:坞上每一格、顶栏每一处都是它)。
 *
 * `src` 缺席 = **连请求都不发**(服务端已经说了这一家没有图),直接画退路。
 */
export function AppIcon({ src, fallback, tint, status, size = AGENT_ICON_SIZE, dim = false }: {
  /** 图从哪儿取({@link agentIconSrc} / {@link appIconSrc})。缺席 = 不发请求,直接画退路。 */
  src?: string | undefined
  /** 取不到画什么。 */
  fallback: IconFallback
  /** 这一家自己的颜色(退回色点时那颗点的颜色;从它图标的主色来)。 */
  tint?: string | undefined
  /** 状态灯色(在跑绿 / 等你黄 / 其余灰)。给了就画:有图时叠在右下角,没图时就是那颗点本身。 */
  status?: EntryLamp | undefined
  size?: number | undefined
  /** 灰着画(「还没接上」的那几家)。 */
  dim?: boolean | undefined
}) {
  const [failed, setFailed] = useState(false)
  // 换了一格(或者服务端刚取到图)就再试一次 —— 上一格加载失败不该让下一格永远画退路。
  useEffect(() => { setFailed(false) }, [src])

  if (src === undefined || failed) {
    // 不是 Agent 的家:一个和图标一样大的中性小方块(**不给色点** —— 它们没有状态色)。
    if (fallback === 'square') {
      return <i className="ben-wb__appicon-blank" style={{ width: size, height: size }} aria-hidden="true" />
    }
    return (
      <i
        className={`ben-wb__dotmini${status === undefined ? '' : ` ben-wb__lamp--${status}`}`}
        // 没有状态灯色的地方(窗口槽标签)退回色点时用这一家自己的颜色,不是一片灰。
        {...(status === undefined ? { style: { background: tint ?? AGENT_NEUTRAL_COLOR } } : {})}
        aria-hidden="true"
      />
    )
  }
  return (
    <span className="ben-wb__agenticon" data-dim={dim ? 'true' : undefined} style={{ width: size, height: size }}>
      <img
        className="ben-wb__agenticon-img"
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        // 加载失败(服务端那一份还没取到、接口 404)→ 退回那条退路,不留一个破图。
        onError={() => setFailed(true)}
      />
      {status !== undefined && <i className={`ben-wb__dotmini ben-wb__lamp--${status} ben-wb__agenticon-dot`} aria-hidden="true" />}
    </span>
  )
}

/**
 * 登记表里那一家的 logo(卡 LG;顶栏小灯、「N 家 Agent 客户端」那一条、坞上是 Agent 的那几格)。
 * 服务端说它没有图(`icon` 不是真)就连请求都不发 —— 退回那颗色点。
 */
export function AgentIcon({ id, icon, tint, status, baseUrl, size = AGENT_ICON_SIZE, dim = false }: {
  /** 登记表里那一条的 id(图按它取)。 */
  id: string
  /** 服务端说它的 logo 取到了没(`agent_registry.entries[].icon`)。假 = 直接画色点,连请求都不发。 */
  icon?: boolean | undefined
  /** 这一家自己的颜色(退回色点时那颗点的颜色;从它图标的主色来)。 */
  tint?: string | undefined
  /** 状态灯色(在跑绿 / 等你黄 / 其余灰)。给了就画:有图时叠在右下角,没图时就是那颗点本身。 */
  status?: EntryLamp | undefined
  baseUrl?: string | undefined
  size?: number | undefined
  /** 灰着画(「还没接上」的那几家)。 */
  dim?: boolean | undefined
}) {
  return (
    <AppIcon
      {...(icon === true ? { src: agentIconSrc(id, baseUrl) } : {})}
      fallback="dot"
      tint={tint}
      status={status}
      size={size}
      dim={dim}
    />
  )
}

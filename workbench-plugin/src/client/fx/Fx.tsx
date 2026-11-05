/**
 * 动效配角的三个小组件(2026-09-23)。库是 libraries.dev 的 MIT 包,原样用:
 *   - `border-beam` 1.4.1:光沿边流动 / 呼吸;
 *   - `thinking-orbs` 0.3.2:20px 的点阵小球(她在想 / 在找 / 在连);
 *   - `bot-avatars` 0.1.1:派出去的那几家各一个小头像。
 * 它们只 import `react`(宿主给),不带 react-dom,打进 lib/client.js 不会多出第二份 React。
 *
 * 外面统一包一层 `.ben-fx`(`display: contents`,不占版面),挂着 `data-fx` / `data-fx-active`:
 * 用例与截图认的是这一层,不认库内部的结构。
 *
 * **环境不支持时只画里面的东西**:没有 `matchMedia` 的环境(jsdom、极老的 WebView)
 * border-beam 一挂就抛错,所以挂载那一刻判一次;判出来的结果整个生命周期不变 ——
 * 中途换结构会让输入框重新挂载、丢焦点。
 */
import { useState, type ReactNode } from 'react'
import { useRestMode } from '../restMode.ts'
import { BorderBeam } from 'border-beam'
import { ThinkingOrb } from 'thinking-orbs'
import { BotAvatar } from 'bot-avatars'
import { avatarFor, beamSize, beamTuneCss, type BeamSpec, type BotState, type ThinkingState } from './fxModel.ts'

/**
 * 三个库一律按深色画(2026-09-25)。以前给的是 `theme="auto"`:库自己问系统 `prefers-color-scheme`,
 * 系统是浅色时画的是**浅色那一套**(深灰的光)——而工作台 09-24 起只做深色(系统浅色也是深色底),
 * 深灰的光压在深色底上就等于没有。壳是 WKWebView,问到的正是系统外观。不再问,写死深色。
 */
export const FX_THEME = 'dark' as const

export function fxSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

function useFxSupported(): boolean {
  const [supported] = useState(fxSupported)
  return supported
}

export function FxBeam({ name, spec, active, children }: {
  /** 这一处叫什么(data-fx),用例与交接里的名字。 */
  name: string
  spec: BeamSpec
  /** 这会儿亮不亮。关掉是淡出,不是卸载 —— 里面的输入框不会丢焦点。 */
  active: boolean
  children: ReactNode
}) {
  const supported = useFxSupported()
  /**
   * 歇着(restMode.ts:切到别的 App、两分钟没动静、页面藏起来)。走的光(绕圈 / 底边)停在当前那一帧 ——
   * 靠 <html data-wb-rest>,样式在 fxStyle.ts。**呼吸光**是库用 JS 每秒 30 次改样式驱动的,样式停不住,照走
   * (真 WKWebView 里它单独占 网页 8% · GPU 11%,是弱效果)。试过歇着时让它淡出:WKWebView 里淡出之后
   * 网页进程反倒涨到 30%(同屏还有一张不亮的光时稳定复现,原因没查清),所以不做。
   */
  const resting = useRestMode()
  const tuneCss = beamTuneCss(spec.tune)
  return (
    <div className="ben-fx" data-fx={name} data-fx-kind={spec.kind} data-fx-active={active} data-fx-resting={resting}>
      {supported
        ? (
          <BorderBeam
            className="ben-fx__beam"
            size={beamSize(spec.kind)}
            colorVariant={spec.tone}
            theme={FX_THEME}
            strength={spec.strength}
            active={active}
            {...(spec.duration === undefined ? {} : { duration: spec.duration })}
            {...(spec.staticColors === true ? { staticColors: true } : {})}
            {...(tuneCss === undefined ? {} : { css: tuneCss })}
          >
            {children}
          </BorderBeam>
        )
        : children}
    </div>
  )
}

/** 20px 的点阵小球。单色,跟着明暗主题走;屏幕外、页面藏起来时库自己会停。 */
export function FxThinking({ state, label }: { state: ThinkingState, label: string }) {
  const supported = useFxSupported()
  return (
    <span className="ben-fx ben-fx__orb" data-fx="thinking" data-fx-state={state} aria-hidden="true">
      {supported && <ThinkingOrb state={state} size={20} theme={FX_THEME} aria-label={label} />}
    </span>
  )
}

/**
 * 派出去的那一家的小头像。`smooth` 着色(不走逐像素的 plastic),不跟鼠标、点了不跳 ——
 * 它是一枚徽章,不是玩具。
 */
export function FxAvatar({ agent, name, color, state, size = 18 }: {
  /** 哪一家(登记表里的 id,按字符串 —— 运行时新接上的一家也有头像)。 */
  agent: string
  /** 它叫什么(登记表里的名字;缺席用那张头像表里的)。 */
  name?: string
  /**
   * 身子的颜色(2026-09-25,卡 Q;维护者:「Claude 是橙色的,能不能配个同色系的卡通形象」):登记表里那一家的 `color`
   * (从它 App 图标的主色来)。形状照旧按家分,颜色吃这一格;不给就用形状自带的颜色(老调用方)。
   */
  color?: string
  state: BotState
  size?: number
}) {
  const supported = useFxSupported()
  const avatar = avatarFor(agent, name)
  return (
    <span className="ben-fx ben-fx__avatar" data-fx="avatar" data-fx-agent={agent} data-fx-state={state} {...(color === undefined ? {} : { 'data-fx-color': color })} aria-hidden="true">
      {supported && (
        <BotAvatar
          type={avatar.type}
          {...(color === undefined ? {} : { color })}
          state={state}
          size={size}
          shading="smooth"
          interactive={false}
          theme={FX_THEME}
          aria-label={`${avatar.label}`}
        />
      )}
    </span>
  )
}

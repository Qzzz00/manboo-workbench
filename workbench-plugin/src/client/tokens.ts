/**
 * 工作台视觉 A · Mono 的令牌(2026-10-21)。整台工作台与协作区共用这**一处**。
 *
 * 依据:全局 UI 视觉 A 最新稿(`codex/collaboration-visual-a@0cf75042` 的 `docs/设计-全局UI视觉-A-2026-10-21.md`「令牌与提示文字」,
 * 与 main 上 `设计-工作台视觉-2026-10-21.md` 有出入处以它为准):纸面、主次字、线、数据阶、圆角 16、发丝线 1px;
 * 画布 / 目标区 / 便签 / 字段与事项类型色是协作区专有的几档,取 `docs/设计-协作区视觉-A-2026-10-21.md`。
 * 卡上次字 `--wb-card-sub` 10-22 改取评审页项目区那格嵌的协作区原型 `--card-sub` #545862(说明与协作区 Pen 写的是 #5B5E66,以评审页为准);
 * 卡上主字稿是 #25262b,色相正好 230,碰到 10-13「除 Kimi 外一个紫都没有」那条检查线,照旧取 #252629(色相 225,对比度差 0.02 以内)。
 *
 * - 颜色在 `:root[data-theme=dark|light]` 上定义,没挂主题按暗版;主题由 `syncRootTheme` 跟宿主
 *   `body[data-ds-dark-theme]` 同步到根元素。字号、圆角、间距与主题无关,只写一次。
 * - 外围只用灰;颜色只给协作区的事项类型(会议杏 / 研发蓝 / 内容绿 / 例行灰,卡片浅底深字)。
 *   语义色(错误红、等你琥珀、在线绿)仍读宿主,不在这里重指。
 * - 宿主令牌(`--dsw-alias-*`)在工作台里**整组重指**到这套,散落在各格里的颜色一起换;
 *   受保护的光效(粒子球、输入框光效、会话气泡、小智能体图标、开屏与引导的光)换回宿主原值,样子一点不变。
 *   做法:`.ben-wb` 自身先把宿主值存进 `--wb-host-*`,重指写在它的子元素上,受保护的根再从 `--wb-host-*` 取回。
 */

export const MONO_DARK: Readonly<Record<string, string>> = {
  '--wb-back': '#111111',
  '--wb-canvas': '#151515',
  '--wb-paper': '#1c1c1c',
  '--wb-area': '#202020',
  '--wb-soft': '#262626',
  '--wb-pop': '#2a2a2a',
  '--wb-field': '#303030',
  '--wb-line': '#383838',
  '--wb-ink': '#eeeeee',
  '--wb-sub': '#aaaaaa',
  '--wb-faint': '#858585',
  '--wb-reverse': '#171717',
  '--wb-g0': '#303030',
  '--wb-g1': '#575757',
  '--wb-g2': '#939393',
  '--wb-g3': '#c6c6c6',
  '--wb-g4': '#efefef',
  '--wb-type-meeting': '#ebd4c1',
  '--wb-type-dev': '#d0daf0',
  '--wb-type-content': '#dce4c5',
  '--wb-type-routine': '#d7d8da',
  '--wb-card-ink': '#252629',
  '--wb-card-sub': '#545862',
}

export const MONO_LIGHT: Readonly<Record<string, string>> = {
  '--wb-back': '#dedede',
  '--wb-canvas': '#e6e6e6',
  '--wb-paper': '#f3f3f3',
  '--wb-area': '#eaeaea',
  '--wb-soft': '#e7e7e7',
  '--wb-pop': '#fafafa',
  '--wb-field': '#e3e3e3',
  '--wb-line': '#d4d4d4',
  '--wb-ink': '#1c1c1c',
  '--wb-sub': '#626262',
  '--wb-faint': '#787878',
  '--wb-reverse': '#f4f4f4',
  '--wb-g0': '#dedede',
  '--wb-g1': '#c0c0c0',
  '--wb-g2': '#999999',
  '--wb-g3': '#595959',
  '--wb-g4': '#1c1c1c',
  '--wb-type-meeting': '#fff0e3',
  '--wb-type-dev': '#eaf0ff',
  '--wb-type-content': '#eff4df',
  '--wb-type-routine': '#f0f0f1',
  '--wb-card-ink': '#252629',
  '--wb-card-sub': '#545862',
}

/** 与主题无关的尺度。字号按真实屏(横 2560×1440 / 竖 1440×2560,1×)校准,不随屏幕面积放大。 */
export const MONO_SCALE: Readonly<Record<string, string>> = {
  '--wb-font': 'Inter,"PingFang SC","Hiragino Sans GB",-apple-system,BlinkMacSystemFont,sans-serif',
  '--wb-fs-source': '10.5px',
  '--wb-fs-meta': '11.5px',
  '--wb-fs-body': '12.5px',
  '--wb-fs-title': '13px',
  '--wb-fs-head': '14px',
  '--wb-fs-name': '15px',
  '--wb-fs-detail': '18px',
  '--wb-num-s': '19px',
  '--wb-num-m': '24px',
  '--wb-num-l': '32px',
  '--wb-r-chip': '4px',
  '--wb-r-field': '8px',
  '--wb-r-note': '10px',
  '--wb-r-pop': '14px',
  '--wb-r-card': '16px',
  '--wb-r-window': '12px',
  '--wb-s1': '4px',
  '--wb-s2': '8px',
  '--wb-s3': '12px',
  '--wb-s4': '16px',
  '--wb-s5': '20px',
  '--wb-s6': '24px',
  '--wb-s7': '28px',
  '--wb-hair': '1px',
  '--wb-dot': '4px',
  '--wb-dot-gap': '5px',
  '--wb-btn-h': '28px',
  '--wb-field-h': '32px',
  // 遮罩与阴影(评审页暗亮同值):弹层 / 协作区那层遮罩、各种弹层的投影
  '--wb-veil': '#0007',
  '--wb-veil-deep': '#0008',
  '--wb-shadow-pop': '0 12px 35px #0005',
  '--wb-shadow-modal': '0 25px 90px #0005',
  '--wb-shadow-dlg': '0 24px 100px #0006',
  '--wb-shadow-toast': '0 6px 20px #0004',
  '--wb-shadow-receipt': '0 8px 30px #0005',
}

/** 宿主令牌 → 本套。语义色(state-error / warn / success)不在表里。 */
export const HOST_REMAP: Readonly<Record<string, string>> = {
  '--dsw-alias-bg-base': 'var(--wb-back)',
  '--dsw-alias-bg-layer-1': 'var(--wb-paper)',
  '--dsw-alias-bg-layer-2': 'var(--wb-soft)',
  '--dsw-alias-bg-layer-3': 'var(--wb-field)',
  '--dsw-alias-bg-l2': 'var(--wb-soft)',
  '--dsw-alias-label-primary': 'var(--wb-ink)',
  '--dsw-alias-label-secondary': 'var(--wb-sub)',
  '--dsw-alias-label-tertiary': 'var(--wb-faint)',
  '--dsw-alias-label-primary-foreground': 'var(--wb-reverse)',
  '--dsw-alias-border-l1': 'var(--wb-line)',
  '--dsw-alias-border-l2': 'var(--wb-line)',
  '--dsw-alias-separator': 'var(--wb-line)',
  '--dsw-alias-fill-l1': 'var(--wb-soft)',
  '--dsw-alias-fill-tertiary': 'var(--wb-soft)',
  '--dsw-alias-fill-quaternary': 'var(--wb-area)',
  '--dsw-alias-interactive-bg-hover': 'var(--wb-soft)',
  // 强调色早已收成主文字色(neutralStyle.ts);跟着主文字一起换
  '--dsw-alias-state-business-primary': 'var(--wb-ink)',
  '--dsw-alias-state-business-tertiary': 'color-mix(in srgb,var(--wb-ink) 10%,transparent)',
  '--dsw-alias-state-info-primary': 'var(--wb-ink)',
  // 原先那层黑白微光(surface.ts)的变量:受保护的输入框也读它们,同样换回原值
  '--wb-surface-bg': 'var(--wb-back)',
  '--wb-surface-card': 'var(--wb-paper)',
  '--wb-surface-raised': 'var(--wb-soft)',
  '--wb-surface-soft': 'var(--wb-soft)',
  '--wb-surface-hover': 'var(--wb-field)',
  '--wb-surface-line': 'var(--wb-line)',
  '--wb-surface-edge': 'var(--wb-line)',
  '--wb-surface-ink': 'var(--wb-ink)',
  '--wb-surface-muted': 'var(--wb-sub)',
  '--wb-surface-faint': 'var(--wb-faint)',
}

/** 不许改样子与动效的光效:粒子球、动效配角(气泡光 / 输入框光束 / 头像)、输入框、会话气泡、小智能体图标、开屏黑洞、引导球、老声纹球。 */
export const PROTECTED_ROOTS: readonly string[] = [
  '.ben-wb__particle-orb',
  '.ben-fx',
  '.wb-cmp',
  '.ben-wb__task-constellation',
  '.ben-wb__agenticon',
  '.ben-wb__brand-hero',
  '.ben-wb__onb-orb',
  '.ben-wb__orb',
]

/** 工作台原先的字体栈(style.ts 的 `.ben-wb`);受保护的光效照旧用它,字形宽高不变。 */
export const LEGACY_FONT = 'Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
/**
 * 宿主那份基准字号、行高、字色(宿主 body 没写字号 = 浏览器缺省 16px / normal;字色是宿主主字色)。
 * 工作台外层 10-22 改成评审页的 13px / 1.5 / 主字色;窗口槽台面照旧用这一份,受保护的光效样子一点不变。
 */
export const LEGACY_TEXT = 'font-size:medium;line-height:normal;color:var(--wb-host-dsw-alias-label-primary)'

const declarations = (set: Readonly<Record<string, string>>): string =>
  Object.entries(set).map(([name, value]) => `${name}:${value}`).join(';')

const hostName = (name: string): string => `--wb-host${name.slice(1)}`

export const TOKENS_STYLE = `
:root,:root[data-theme=dark]{${declarations(MONO_DARK)}}
:root[data-theme=light]{${declarations(MONO_LIGHT)}}
:root{${declarations(MONO_SCALE)}}
/* 存宿主原值;写成 :where 免得顶替 style.ts 里 .ben-wb 那条根规则(铺满、不透明、吃点击,见 client-upstream-seats 用例) */
:where(.ben-wb){${Object.keys(HOST_REMAP).map(name => `${hostName(name)}:var(${name})`).join(';')}}
.ben-wb>*{${declarations(HOST_REMAP)}}
.ben-wb :is(${PROTECTED_ROOTS.join(',')}){${Object.keys(HOST_REMAP).map(name => `${name}:var(${hostName(name)})`).join(';')};font-family:${LEGACY_FONT}}
/* 窗口槽台面(粒子、气泡、输入框、小智能体都在里面)照旧吃宿主那份基准字号 / 行高 / 字色:外层 10-22 改成评审页的 13px / 1.5 / 主字色,
   评审页的窗口槽里是「已有粒子、小机器人、会话气泡保留原貌」。台面里凡是自己写了字号的照旧。 */
.ben-wb .ben-wb__slot-stack{${LEGACY_TEXT}}
`

export type RootTheme = 'dark' | 'light'

/** 宿主(DSH ThemePresenter)暗色时在 body 上挂 `data-ds-dark-theme`。 */
export function hostTheme(doc: Document): RootTheme {
  return doc.body?.hasAttribute('data-ds-dark-theme') === true ? 'dark' : 'light'
}

/** 把宿主的明暗同步到 `<html data-theme>`,之后跟着换;返回停止函数。 */
export function syncRootTheme(doc: Document): () => void {
  const apply = (): void => {
    const next = hostTheme(doc)
    if (doc.documentElement.dataset.theme !== next) doc.documentElement.dataset.theme = next
  }
  apply()
  if (typeof MutationObserver === 'undefined' || doc.body === null) return () => {}
  const observer = new MutationObserver(apply)
  observer.observe(doc.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => observer.disconnect()
}

import { SURFACE_STYLE } from './surface.ts'
import { COMPOSITION_STYLE } from './composition.ts'
// 每个区域单独解锁(2026-09-17):独占 ben-wb__unlock* 前缀,单独一个文件免得跟并行的几张卡撞。
import { UNLOCK_STYLE } from './unlockStyle.ts'
// 第一次用的空态(2026-09-18):独占 ben-wb__emptyfirst* 前缀,同样单独一个文件免得跟并行的几张卡撞。
import { EMPTY_STYLE } from './emptyStyle.ts'
import { ACCESS_NOTE_STYLE } from './accessNoteStyle.ts'
import { ACTOR_NOTE_STYLE } from './actorNoteStyle.ts'
import { SCENE_MENU_STYLE } from './sceneMenuStyle.ts'
// 「开发一个小工具」那颗按钮(2026-09-20):同样独占前缀、单独一个文件,免得跟并行的几张卡撞。
import { DEV_TOOL_STYLE } from './devToolStyle.ts'
import { CUSTOM_MODULE_STYLE } from './customModuleStyle.ts'
import { TEMPLATE_STYLE } from './templateStyle.ts'
// 待确认的布局改动那张卡(2026-09-22):同样独占前缀、单独一个文件,免得跟并行的几张卡撞。
import { LAYOUT_ASK_STYLE } from './layoutAskStyle.ts'
import { MATERIALIZE_STYLE } from './materializeStyle.ts'
import { TOPIC_DECK_STYLE } from './topicDeckStyle.ts'
// 动效配角(2026-09-23):独占 ben-fx 前缀,单独一个文件(fx/fxStyle.ts),免得跟并行的几张卡撞。
import { FX_STYLE } from './fx/fxStyle.ts'
import { APPROVAL_STYLE, COMPOSER_STYLE } from './composer/composerStyle.ts'
// 全局中性色(2026-09-24):强调色令牌在 .ben-wb 上重定义成黑白灰、主按钮白底黑字。放在最后,单独一个文件。
import { NEUTRAL_STYLE } from './neutralStyle.ts'
import { ITEM_STYLE } from './itemStyle.ts'
import { PROJECT_OTHERS_STYLE } from './projectOthersStyle.ts'
import { DISPATCH_EYES_STYLE } from './dispatchEyesStyle.ts'
// 设置里「事务官的提示词」那一节(2026-10-01):同样独占前缀、单独一个文件,免得跟并行的几张卡撞。
import { PROMPTS_STYLE } from './promptsStyle.ts'
import { HABITS_STYLE } from './habitsStyle.ts'
// 视觉 A · Mono(2026-10-21):令牌在最前,组件与各格在最后。
import { TOKENS_STYLE } from './tokens.ts'
import { MONO_STYLE } from './monoStyle.ts'
// 设置六组各节的内部(2026-10-22):挂在 MONO_STYLE 之后,独占 ben-wb__s 前缀、单独一个文件。
import { SETTINGS_MONO_STYLE } from './settingsMonoStyle.ts'
// 协作区(2026-10-21):独占 ben-cl 前缀,单独一个文件(含 React Flow 的基础样式)。
import { COLLAB_STYLE } from './collab/collabStyle.ts'

/** 工作台结构与状态样式；末尾局部材质层从 DSH 主题提取明暗。 */
export const STYLE = `
${TOKENS_STYLE}
/* ── 初始化页(2026-09-17 登录台) ────────────────────────────────────────────
   整页盖在看板上,不是弹窗:九步竖排,内容多,一个小对话框装不下。类名一律
   ben-wb__setup* —— 历史上 ben-wb__card / ben-wb__inbox 都撞过名,这一块独占前缀。
   注意跟既有的 ben-wb__setdlg(齿轮弹窗)是两套东西,别看串了。 */
/* ── 登录屏与首次流程(2026-09-17 账号登录与引导入口) ──────────────────────────
   两块各自独占前缀:ben-wb__account*(登录屏与设置里那一节)、ben-wb__firstrun*(三屏 + 对话),
   顶上那两条细横幅是 ben-wb__needbar*。三者跟 ben-wb__setup* / ben-wb__setdlg 都不共用一个类。
   登录屏与首次流程都是**整屏**:第一次开机时看板上本来也没有东西可看,
   而半透明盖一层会让人以为后面那片能点。 */
.ben-wb__account,.ben-wb__firstrun{position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ben-wb__account-ttl{margin:0;font-size:19px;font-weight:650;letter-spacing:-.02em}
.ben-wb__account-sub{margin:0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.ben-wb__account-tabs{display:flex;gap:6px;margin-top:2px}
.ben-wb .ben-wb__account-tab{flex:1;padding:5px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.ben-wb .ben-wb__account-tab[data-on=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__account-field{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ben-wb .ben-wb__account-input{padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.ben-wb .ben-wb__account-input:focus{outline:0;border-color:var(--dsw-alias-state-business-primary)}
.ben-wb .ben-wb__account-reset{background:none;border:0;padding:0;font:inherit;font-size:11px;color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:underline}
.ben-wb .ben-wb__account-go{margin-top:4px;padding:7px 0;border:0;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.ben-wb .ben-wb__account-go:disabled{cursor:not-allowed;opacity:.6}
.ben-wb__account-err{margin:0;padding:7px 9px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.ben-wb__account-foot{margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.ben-wb__account-change{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.ben-wb__firstrun-step{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
.ben-wb__firstrun-ttl{margin:0;font-size:18px;font-weight:650;letter-spacing:-.02em}
.ben-wb__firstrun-say{margin:0;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.ben-wb__firstrun-sub{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ben-wb__firstrun-hint{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.ben-wb__firstrun-code{margin-left:5px;font-family:ui-monospace,Menlo,monospace;font-size:15px;letter-spacing:.2em;color:var(--dsw-alias-label-primary)}
.ben-wb__firstrun-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;width:100%}
.ben-wb .ben-wb__firstrun-go{padding:6px 14px;border:0;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.ben-wb .ben-wb__firstrun-go:disabled{cursor:not-allowed;opacity:.6}
.ben-wb .ben-wb__firstrun-alt{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.ben-wb .ben-wb__firstrun-input{flex:1;min-width:0;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.ben-wb__firstrun-err{margin:0;padding:7px 9px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.ben-wb__firstrun-chat{align-items:stretch;text-align:left}
.ben-wb__firstrun-turns{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px;max-height:42vh;overflow-y:auto}
.ben-wb__firstrun-turn{display:flex;gap:7px;font-size:13px;line-height:1.6}
.ben-wb__firstrun-who{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11.5px;padding-top:2px}
.ben-wb__firstrun-text{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.ben-wb__firstrun-turn[data-role=user] .ben-wb__firstrun-text{color:var(--dsw-alias-label-secondary)}
/* ── 引导舞台(2026-09-23,维护者:「注册之后粒子球就应该要出现了」「桌面端也很丑...不需要弹窗」)──────
   登录屏与整段首次流程:**同一片背景、一颗粒子球在上居中,没有任何卡片框/底色面板**。
   球下面是标题(18px,与对话屏她那句同一个字号)+ 一句说明 +(二维码直接放着)+ 按钮;
   对话屏(data-layout=chat)输入框贴底,其余屏整组竖直居中。手机/配对/登录三屏球小一号(data-orb=small)。
   态见 firstrun/onboardingStage.ts;「在找你的项目」那一整段是核心原版的 working 形(莫比乌斯环,中心光团关;2026-09-24 傍晚)。 */
.ben-wb__firstrun.ben-wb__onb,.ben-wb__account.ben-wb__onb{flex-direction:column;justify-content:center;gap:6px;padding:20px 16px 18px}
.ben-wb__onb[data-layout=chat]{justify-content:flex-start}
.ben-wb__onb-orb{flex:none;position:relative;width:min(520px,92vw);height:min(40vh,400px);color:var(--dsw-alias-label-primary);transition:height .5s ease}
.ben-wb__onb[data-orb=small] .ben-wb__onb-orb{height:min(24vh,200px)}
.ben-wb__onb[data-layout=chat] .ben-wb__onb-orb{height:min(44vh,440px)}
.ben-wb__onb-orb .ben-wb__particle-orb{position:relative;width:100%;height:100%;display:grid;place-items:center;pointer-events:none}
.ben-wb__onb-orb .ben-wb__particle-orb canvas{position:absolute;inset:0;display:block;width:100%;height:100%;min-width:0;min-height:0;pointer-events:none}
.ben-wb__onb-orb .ben-wb__particle-a11y{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.ben-wb__onb-orb .ben-wb__particle-busy{position:absolute;bottom:0;margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__onb-body{width:min(640px,100%);display:flex;flex-direction:column;align-items:center;gap:12px;padding:0 4px}
.ben-wb__onb[data-step=firstuse] .ben-wb__onb-body,.ben-wb__onb[data-step=config] .ben-wb__onb-body{max-height:50vh;overflow-y:auto;flex-shrink:1;min-height:0}
.ben-wb__onb[data-layout=chat] .ben-wb__onb-body{flex:1 1 auto;min-height:0}
.ben-wb__onb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.ben-wb__onb .ben-wb__firstrun-step{width:100%;gap:12px}
.ben-wb__onb .ben-wb__firstrun-ttl{font-size:18px;font-weight:500;line-height:1.6;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.ben-wb__onb .ben-wb__firstrun-say{font-size:18px;line-height:1.65;letter-spacing:-.01em;max-width:34em}
.ben-wb__onb [aria-label="在手机上继续"] .ben-wb__firstrun-say{font-size:15px;color:var(--dsw-alias-label-secondary)}
.ben-wb__onb .ben-wb__firstrun-sub{font-size:13px;max-width:34em;margin-top:-4px}
.ben-wb__onb .ben-wb__firstrun-hint{max-width:34em}
.ben-wb__onb .ben-wb__firstrun-row{margin-top:6px;gap:10px}
.ben-wb__onb .ben-wb__firstrun-go{padding:9px 20px;border-radius:999px;font-size:13.5px}
.ben-wb__onb .ben-wb__firstrun-alt{padding:9px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px}
.ben-wb__onb .ben-wb__firstrun-alt:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:3px}
.ben-wb__onb .ben-wb__firstrun-alt:disabled{cursor:not-allowed;opacity:.6}
.ben-wb__onb-qr{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:4px}
.ben-wb__onb-qr svg{border-radius:10px!important}
.ben-wb__onb-field{width:min(420px,100%);flex-wrap:nowrap}
.ben-wb__onb .ben-wb__firstrun-input{padding:9px 12px;font-size:14px;border-radius:10px}
.ben-wb__onb-field .ben-wb__firstrun-go{border-radius:10px}
.ben-wb__onb .ben-wb__firstrun-err{padding:0;border:0;background:transparent;font-size:13px;max-width:34em;text-align:center}
.ben-wb__onb-chat{flex:1 1 auto;min-height:0;height:100%;align-items:center;text-align:center;gap:10px}
.ben-wb__onb-her{margin:0;max-width:34em;font-size:18px;line-height:1.7;letter-spacing:-.01em;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);animation:ben-wb-onb-in .45s ease both}
@keyframes ben-wb-onb-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.ben-wb__onb-status{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.ben-wb__onb-bar{display:block;width:min(260px,70vw);height:3px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}
.ben-wb__onb-bar>span{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary);transition:width .4s ease}
.ben-wb__onb-trouble{margin:0;max-width:34em;color:var(--dsw-alias-state-error-primary);font-size:13.5px;line-height:1.6}
.ben-wb__onb-you{margin:0;max-width:34em;display:flex;gap:7px;justify-content:center;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.ben-wb__onb-chat .ben-wb__firstrun-turns{width:100%;max-height:30vh;text-align:left;padding:4px 0}
.ben-wb__onb-dock{margin-top:auto;width:100%;display:flex;flex-direction:column;gap:8px;padding-top:10px}
.ben-wb__onb-dock .ben-wb__firstrun-row{margin-top:0}
.ben-wb__onb-dock .ben-wb__firstrun-go{padding:9px 16px;border-radius:10px}
.ben-wb__onb-exits{display:flex;flex-direction:column;align-items:center;gap:6px}
/* 登录屏:同一个舞台,表单不套框(输入框还在)。只在 .ben-wb__onb 下改,设置里「账号」那一节的同名类不受影响。 */
.ben-wb__onb .ben-wb__account-form{width:min(340px,100%);display:flex;flex-direction:column;gap:12px}
.ben-wb__onb .ben-wb__account-ttl{text-align:center;font-size:18px;font-weight:500;letter-spacing:-.01em}
.ben-wb__onb .ben-wb__account-sub{text-align:center;font-size:13px;margin-top:-6px}
.ben-wb__onb .ben-wb__account-tabs{justify-content:center;gap:18px;margin:2px 0}
.ben-wb.ben-wb .ben-wb__onb .ben-wb__account-tab{flex:none;padding:4px 2px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;font-size:13.5px}
.ben-wb.ben-wb .ben-wb__onb .ben-wb__account-tab[data-on=true]{border-bottom-color:var(--dsw-alias-state-business-primary);background:transparent;color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__onb .ben-wb__account-input{padding:9px 12px;font-size:14px;border-radius:10px}
.ben-wb .ben-wb__onb .ben-wb__account-go{margin-top:6px;padding:10px 0;border-radius:999px;font-size:14px}
.ben-wb__onb .ben-wb__account-err{padding:0;border:0;background:transparent;font-size:12.5px;text-align:center}
.ben-wb__onb .ben-wb__account-foot{text-align:center}
/* 登录屏顶上的粒子黑洞(2026-09-23 品牌视觉,brand/BlackholeHero.tsx):占原来那颗小球的位置,画布横向铺满这一屏,
   左右与底边渐隐进页面底色,表单在它下面、不叠字。颜色跟正文色走(浅色主题是墨色)。 */
.ben-wb__brand-slot{flex:none;position:relative;width:100%;height:min(28vh,240px);color:var(--dsw-alias-label-primary);pointer-events:none}
.ben-wb__brand-hero{position:absolute;inset:0}
.ben-wb__brand-hero canvas{display:block;width:100%;height:100%;-webkit-mask-image:radial-gradient(ellipse 58% 92% at 50% 45%,#000 62%,transparent 100%);mask-image:radial-gradient(ellipse 58% 92% at 50% 45%,#000 62%,transparent 100%)}
/* 串联(brand/brandHandoff.ts):飞行期间新屏上那颗球透明,成形时随 --brand-handoff-orb 淡入。只动这一格透明度,不动球本身。 */
html[data-brand-handoff] .ben-wb__particle-orb canvas{opacity:var(--brand-handoff-orb,1)}
html[data-brand-handoff] .ben-wb__brand-hero canvas{visibility:hidden}
@media(prefers-reduced-motion:reduce){.ben-wb__onb-her,.ben-wb__onb-orb,.ben-wb__onb-bar>span{animation:none;transition:none}}
/* 顶上那两条细横幅:一行高,不抢地方,点右边那颗按钮就去该去的地方。 */
.ben-wb__needbar{display:flex;flex-direction:column;gap:3px;margin:0 0 6px}
.ben-wb__needbar-row{display:flex;align-items:center;gap:8px;padding:4px 9px;border:1px solid var(--dsw-alias-state-warning-secondary,var(--dsw-alias-border-l1));border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}
.ben-wb__needbar-row>span{flex:1;min-width:0}
.ben-wb .ben-wb__needbar-go{flex:none;padding:2px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer}
.ben-wb .ben-wb__needbar-go:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__setup{position:absolute;inset:0;z-index:40;overflow-y:auto;padding:24px 20px 48px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ben-wb__setup-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
.ben-wb__setup-ttl{margin:0;font-size:20px;font-weight:650;letter-spacing:-.02em}
.ben-wb__setup-sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px}
.ben-wb__setup-headact{display:flex;gap:8px;flex:none}
.ben-wb__setup-btn{flex:none;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.ben-wb__setup-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__setup-btn:disabled{cursor:not-allowed;opacity:.5}
.ben-wb__setup-err{margin:0 0 12px;padding:9px 11px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}
/* 报错后面那个短编号(2026-09-22)。等宽 + 可选中:Ben 要么念它,要么复制它。 */
.ben-wb__err{margin:0 0 12px;color:var(--dsw-alias-state-error-primary);font-size:12px}
.ben-wb__errcode{margin-left:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.04em;opacity:.85;user-select:all}
/* 「出错自动报告给开发者」那颗开关。跟这一页别处的按钮同一套边框语言。 */
.ben-wb__setup-switch{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ben-wb__setup-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:11px;max-width:900px}
.ben-wb__setup-step{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.ben-wb__setup-stephead{display:flex;align-items:center;gap:8px}
.ben-wb__setup-stepno{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__setup-steptitle{font-size:14px;font-weight:650}
.ben-wb__setup-steplamp{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__setup-stepsum{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.ben-wb__setup-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.ben-wb__setup-dot--ok{background:var(--dsw-alias-state-success-primary,#3fb27f)}
.ben-wb__setup-dot--busy{background:var(--dsw-alias-state-business-primary)}
.ben-wb__setup-dot--click{background:var(--dsw-alias-state-warning-primary,#d99a2b)}
.ben-wb__setup-dot--fill{background:var(--dsw-alias-state-error-primary)}
.ben-wb__setup-items{display:flex;flex-direction:column;gap:8px;margin-top:9px}
.ben-wb__setup-item{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:9px 10px;background:var(--dsw-alias-bg-base)}
.ben-wb__setup-item[data-state=ok]{opacity:.72}
.ben-wb__setup-itemhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ben-wb__setup-itemname{font-size:12.5px;font-weight:600;flex:1;min-width:0}
.ben-wb__setup-badge{flex:none;font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.ben-wb__setup-badge--ok{color:var(--dsw-alias-state-success-primary,#3fb27f)}
.ben-wb__setup-badge--missing,.ben-wb__setup-badge--stale{color:var(--dsw-alias-state-warning-primary,#d99a2b)}
.ben-wb__setup-badge--needs_user{color:var(--dsw-alias-state-error-primary)}
.ben-wb__setup-optional{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__setup-detail{margin:5px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;word-break:break-word}
.ben-wb__setup-fix{margin:4px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.ben-wb__setup-hint{margin:6px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.ben-wb__setup-job{margin-top:7px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px}
.ben-wb__setup-job[data-state=failed]{border-left-color:var(--dsw-alias-state-error-primary)}
.ben-wb__setup-jobnote{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
/* 原始输出:横向自己滚,绝不把整页撑宽。 */
.ben-wb__setup-tail{margin:5px 0 0;padding:6px 8px;max-height:180px;overflow:auto;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Menlo,monospace;font-size:10.5px;line-height:1.45;white-space:pre;color:var(--dsw-alias-label-tertiary)}

/* overflow:hidden(模块盒子化,真机反馈):不再让整页跟着内容一起长高——外层不滚动,
   滚动全部下放到各模块自己的内容区(见下面 .ben-wb__body/.ben-wb__col/.ben-wb__scroll),
   会话区行数增减因此不会再把窗口槽顶得到处跑。 */
.ben-wb{position:absolute;inset:0;overflow:hidden;pointer-events:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.ben-wb *{box-sizing:border-box}
/* 满宽自适应(真机反馈,2026-08-24):旧假设是竖屏定宽 1440,宽屏/远程屏下两侧空出大片留白——
   改成随视口撑满,只留小间距,不再夹一条 1080px 的定宽列。 */
.ben-wb__inner{width:100%;margin:0;padding:24px 20px 48px}
.ben-wb__header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}.ben-wb__eyebrow{margin:0 0 5px;color:var(--dsw-alias-state-business-primary);font-size:11px;font-weight:650;letter-spacing:.1em;text-transform:uppercase}.ben-wb h1{margin:0;font-size:22px;font-weight:650;line-height:1.25;letter-spacing:-.02em}.ben-wb__subtitle{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px}.ben-wb button{font:inherit}.ben-wb__return{border-radius:8px;cursor:pointer;padding:7px 11px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px}.ben-wb__return:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.ben-wb__alert{margin:0 0 14px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}.ben-wb__loading{padding:56px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}.ben-wb button:focus-visible,.ben-wb summary:focus-visible,.ben-wb-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.ben-wb-button{display:flex;width:100%;align-items:center;gap:10px;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.ben-wb-button:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}.ben-wb-button[data-open=true]{background:var(--dsw-specific-sidebar-nav-item-active)}.ben-wb-button__icon{display:grid;width:20px;height:20px;place-items:center;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:700}.ben-wb-button__label{font-size:13px;white-space:nowrap}
@media(max-width:820px){.ben-wb__inner{padding:16px 16px 32px}.ben-wb__header{align-items:flex-start;margin-bottom:16px}}

/* ── 三列布局（v4 布局稿）：左=过去 / 中=现在 / 右=进来的 ── */
/* height:100%(模块盒子化,真机反馈):不再是 min-height:100% 那种"至少一屏、内容多了
   随便长"的写法——.ben-wb 本身 overflow:hidden 之后,.ben-wb__inner 必须严格等于那个
   固定高度,.ben-wb__body 的 flex:1 才有一个确定的"剩余空间"可分,模块的 flex-basis
   百分比才是真的按这个固定高度算,不是按一个会长高的容器算。 */
.ben-wb__inner{display:flex;flex-direction:column;height:100%;min-height:0}
.ben-wb__topbar{display:flex;align-items:center;gap:15px;margin-bottom:11px;padding:8px 12px;border:1px solid transparent;border-bottom-color:var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
/* 标题「工作台」:原来是页头里 22px 的 h1,现在是顶栏最左边的小字(卡 TB)。
   选择器要带 .ben-wb —— 上面那条 .ben-wb h1{font-size:22px} 比裸类名更具体,不带的话它赢。 */
.ben-wb h1.ben-wb__topname{margin:0;font-size:11.5px;font-weight:600;letter-spacing:.02em;line-height:1.3;color:var(--dsw-alias-label-secondary);white-space:nowrap}
/* 从页头搬过来的「恢复默认布局」:与「纯净」同一套,只是没有开关的选中态。 */
.ben-wb__topplain{margin-left:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:1px 8px;font-size:11.5px}
.ben-wb__topplain:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ben-wb__topagent{display:inline-flex;align-items:center;gap:5px}
.ben-wb__topagent-name:not([data-shown=true]){position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* 还没接上的那几家(卡 TB2:候选家并进这一排,不再单独一排):灰着,悬停说清为什么。 */
.ben-wb__topagent[data-dim=true]{color:var(--dsw-alias-label-tertiary)!important;opacity:.6}
/* Agent 登记表(卡 Q):那一家刚冒了一句(开始跑了 / 回了),灯轻轻亮三下;说的是什么在悬停提示里。 */
.ben-wb__topagent[data-bubble] .ben-wb__dotmini{animation:ben-wb-lamp-bubble 1.4s ease-in-out 3}
@keyframes ben-wb-lamp-bubble{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}50%{box-shadow:0 0 0 3px rgba(255,255,255,.28)}}
@media(prefers-reduced-motion:reduce){.ben-wb__topagent[data-bubble] .ben-wb__dotmini{animation:none}}
.ben-wb__toplamps{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px 15px;min-width:0}
.ben-wb__topagent-slot{position:relative;display:inline-flex}
button.ben-wb__topagent{padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer}
button.ben-wb__topagent:hover,button.ben-wb__topagent[aria-expanded=true]{color:var(--dsw-alias-label-primary)}
.ben-wb__lampcard{position:absolute;top:calc(100% + 8px);left:-6px;width:290px;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:40;font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:normal}
.ben-wb__lampcard p{margin:0}
.ben-wb__lampcard-state{color:var(--dsw-alias-label-primary)}
.ben-wb__lampcard-latest{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ben-wb__lampcard-note,.ben-wb__lampcard-reads{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__lampcard .ben-wb__agent-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ben-wb__lampcard .ben-wb__agent-actions button{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 9px;font:inherit;font-size:11px;cursor:pointer}
.ben-wb__lampcard .ben-wb__agent-actions button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__tophint{display:inline-flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-state-warn-label);font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.ben-wb__tophint-btn{flex:none;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;padding:2px 8px;font:inherit;font-size:11px;cursor:pointer}
.ben-wb__tophint-err{color:var(--dsw-alias-label-tertiary)}
/* ── 各家的 logo(2026-09-26,卡 LG;维护者:「把对应的 logo 也搞上;桌面端的应用标签,也加各家的 logo icon」)。
   16px 圆角小图:窗口槽标签名字前、顶栏那一排小灯、「N 家 Agent 客户端」那一条上都是它。
   取不到 / 加载失败时画的是原来那颗 .ben-wb__dotmini(退路在 AgentIcon.tsx),这里不管。
   **一个新颜色都不加**:圆角、边框、灰度全用现成的变量与滤镜。 */
.ben-wb__agenticon{position:relative;display:inline-block;flex:none;border-radius:4px;line-height:0}
.ben-wb__agenticon-img{display:block;width:100%;height:100%;border-radius:4px;object-fit:contain}
/* 还没接上的那几家灰着画(悬停那一句说为什么)。 */
.ben-wb__agenticon[data-dim=true] .ben-wb__agenticon-img{filter:grayscale(1);opacity:.45}
/* 状态那颗点挪到图的右下角当角标 —— 在跑 / 等你的语义一点没丢。 */
.ben-wb__agenticon-dot{position:absolute;right:-2px;bottom:-2px;box-shadow:0 0 0 1.5px var(--dsw-alias-bg-layer-1)}
/* ── 坞上每一格都有图标(2026-09-26,卡 LG2;维护者 18:05:「现在只有 Agent 有 logo,你看着怪不怪」)。
   **不是 Agent 的家**(微信、企业微信、Notion、终端、Finder、Pen……)取不到图时画的是这个
   中性小方块 —— 不是色点:它们没有「在跑 / 等你」这回事,一颗彩色圆点会凭空造出一个语义。
   与图标同样大、同样圆角,名字才不会一行左一行右。**一个新颜色都不加**(边与底都用现成变量)。 */
.ben-wb__appicon-blank{display:inline-block;flex:none;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-2)}
/* 内置小图形那一格(「窗口布局」):它不是一个 App、没有哪个包可以取图,画自己的 svg,
   占位与那 16px 图标一样大。 */
.ben-wb__appicon-glyph{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;line-height:0}
/* 小灯那一排最前面那一小格「N 家」(卡 TB2:卡 LG 那条单独的排并进来了),点开是登记表那一档。
   **不画边框**:维护者 19:40「有一条奇怪的白色线框」就是原来那条排的描边;这一格只有字与悬停底色。 */
.ben-wb__agentcount{position:relative;display:inline-flex;flex:none}
.ben-wb__agentcount-btn{display:inline-flex;align-items:center;gap:7px;padding:1px 5px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;line-height:1.3;cursor:pointer;white-space:nowrap}
.ben-wb__agentcount-btn:hover,.ben-wb__agentcount-btn[aria-expanded=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ben-wb__agentcount-n{flex:none}
.ben-wb__agentcount-card{position:absolute;top:calc(100% + 8px);left:0;width:320px;max-height:60vh;overflow-y:auto;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:40;font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:normal}
.ben-wb__agentcount-title{margin:0 0 6px;color:var(--dsw-alias-label-primary)}
.ben-wb__agentcount-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
/* 一行:图标 · 名字 · 状态,行末一颗「⋯」(卡 TB2 追加:已接上的那几家默认不显「这不是 Agent」)。 */
.ben-wb__agentcount-row{display:grid;grid-template-columns:16px 1fr auto;grid-template-areas:"icon name more" ". why why" ". act act";align-items:center;gap:2px 8px}
.ben-wb__agentcount-more{grid-area:more;justify-self:end;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);padding:0 5px;font:inherit;font-size:13px;line-height:1.1;cursor:pointer;opacity:0}
.ben-wb__agentcount-row:hover .ben-wb__agentcount-more,.ben-wb__agentcount-more:focus-visible,.ben-wb__agentcount-more[aria-expanded=true]{opacity:1}
.ben-wb__agentcount-more:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__agentcount-asking{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.ben-wb__agentcount-row>.ben-wb__agenticon,.ben-wb__agentcount-row>.ben-wb__dotmini{grid-area:icon;justify-self:center}
.ben-wb__agentcount-name{grid-area:name;color:var(--dsw-alias-label-primary)}
.ben-wb__agentcount-why{grid-area:why;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__agentcount-row[data-dim=true] .ben-wb__agentcount-name{color:var(--dsw-alias-label-tertiary)}
.ben-wb__agentcount-row .ben-wb__agent-actions{grid-area:act;display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:2px}
.ben-wb__agentcount-row .ben-wb__agent-actions button{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);padding:3px 8px;font:inherit;font-size:11px;cursor:pointer}
.ben-wb__agentcount-row .ben-wb__agent-actions button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 窗口槽标签里那一张:名字前面 16px。只给图一点右边距与基线对齐,**不动那颗按钮本身的排版**
   (别的卡正在改 DockTabBar 的别处)。 */
.ben-wb__dock-tab-name .ben-wb__agenticon,.ben-wb__dock-tab-name>.ben-wb__dotmini,.ben-wb__dock-tab-name>.ben-wb__appicon-blank{margin-right:5px;vertical-align:-3px}
.ben-wb__task-children{display:block;margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ben-wb__session-children{margin:6px 0}
.ben-wb__session-children-line{display:flex;align-items:center;gap:8px;margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ben-wb__session-children-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.ben-wb__session-children-list li{display:flex;flex-direction:column;gap:1px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2)}
.ben-wb__session-children-list li[data-status=running]{border-left-color:var(--dsw-alias-label-secondary)}
.ben-wb__session-children-list li[data-status=waiting]{border-left-color:var(--dsw-alias-state-warn-label)}
.ben-wb__session-child-title{font-size:12px;color:var(--dsw-alias-label-primary)}
.ben-wb__session-children-list small{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__topclock{margin-left:auto;color:var(--dsw-alias-label-tertiary)}
.ben-wb__topstat{display:inline-flex;align-items:center;gap:5px}
.ben-wb__topstat-label{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.ben-wb__topstat-val{font-weight:600;color:var(--dsw-alias-label-primary)}
.ben-wb__topstat-val--alert{color:var(--dsw-alias-state-error-primary)}
.ben-wb__topstat-val--off{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.ben-wb__topgear{margin-left:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:1px 6px;font-size:12px}
.ben-wb__topgear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
/* 有新版那个点(2026-09-18 热更新)。齿轮右上角一枚 5px 的小圆点——**不是**告警色:
   有新版不是故障,是一件可以以后再做的事。 */
.ben-wb__topgear[data-dot=update]{position:relative}
.ben-wb__topgear-dot{position:absolute;top:-2px;right:-2px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-info-primary,#3b82f6)}

/* 设置 → 「更新」那一节(2026-09-18)。 */
.ben-wb__upd-notes{margin:6px 0 0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.ben-wb__upd-err{margin:6px 0 0;font-size:11.5px;line-height:1.4;color:var(--dsw-alias-state-error-primary)}
.ben-wb__upd-bar{margin:7px 0 0;height:4px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__upd-bar>i{display:block;height:100%;background:var(--dsw-alias-label-tertiary);transition:width .3s ease}
.ben-wb__upd-phase{margin:4px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__upd-plan{margin:6px 0 0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ben-wb__upd-rate{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ben-wb__upd-skipped{margin:6px 0 0;padding-left:16px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.ben-wb__upd-job .ben-wb__cred-row{margin-top:7px}
/* 一句话、一颗按钮(2026-09-28,卡 UP)。
   upd-head 是那一句"现在是哪一版 + 查出来什么";upd-again 是查不到时那句「再查一次」,
   **文字链接的样子**,免得跟主按钮撞脸;upd-site 是最底下那行"去官网拿安装包"的小字。 */
.ben-wb__upd-head{display:block;margin:0}
.ben-wb__upd-again{margin:6px 0 0;padding:0;border:0;background:none;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);text-decoration:underline;cursor:pointer}
.ben-wb__upd-again:disabled{cursor:default;opacity:.5}
.ben-wb__upd-channel{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px 14px}
.ben-wb__upd-channelopt{display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer}
.ben-wb__upd-site{display:block;margin:8px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
/* 「DSH 运行环境还没换到这一版」那一行(2026-09-26,卡 U6)。琥珀色左边条:
   它不是故障(工作台照常能用),但是这台机器此刻真正缺的那一件事 —— 比正文重一点、比红色轻一点。 */
.ben-wb__upd-runtime{margin:7px 0 0;padding:6px 8px;border-radius:6px;border-left:2px solid var(--dsw-alias-state-warning-primary,#d89614);background:var(--dsw-alias-bg-layer-2)}
.ben-wb__upd-runtime[data-repair="failed"]{border-left-color:var(--dsw-alias-state-error-primary)}
.ben-wb__dotmini{width:6px;height:6px;border-radius:50%;display:inline-block}
/* ── 自定义布局(spec D12,模块盒子化真机反馈修订)：分区自上而下竖排,每个模块
   flex:0 0 <basis_pct>%(不参与 grow/shrink,内容多了不撑高、少了不缩水)——拖拽调
   "高度"改走底边手柄(.ben-wb__mod-handle)实时改这个百分比,不再是"内容自然撑开"。
   overflow-y:auto 是聚合层面的安全网(万一各模块 basis_pct 之和超过 100%),真正的
   内容滚动落在各模块自己的内容区(.ben-wb__scroll/.ben-wb__col)。 */
.ben-wb__body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:11px}
/* overflow:hidden(真机截图实证——管理钮飘到下一个模块标题上、场景多了槽体压成一条缝):
   这是"内容绝不外溢"的最后一道防线,不管盒内哪层 flex 计算出什么高度,画面上都不会
   超出这个模块自己的框。跟底下 .ben-wb__mod-handle 的 6px 手柄不冲突——手柄本身就在
   这个盒子内部占自己的那一份高度,不是靠溢出显示的。 */
.ben-wb__mod{display:flex;flex-direction:column;min-height:0;flex-shrink:0;overflow:hidden}
.ben-wb__mod .ben-wb__mod{flex:1 1 100%!important;width:100%;height:100%;min-height:0}
.ben-wb__mod .ben-wb__mod>.ben-wb__mod-handle{display:none!important}
/* 图谱格(files)的合理最小高度(2026-10-24 收口,我定的可撤回):低于 ~260px,
   「(起步小组件的 cf-tabs/header 行)+ GraphView 的 tabs+项目行+图体+图注」预算装不下,
   图注会被上面 overflow:hidden 裁掉(独立审 S1/S3 矮态截图实证)。260 = 直出本体 ~172
   预算 + 起步两行,再 + 旧版用户层小组件多出来的 margin/padding(~38px,旧原件实测:
   260 处旧路径图区 ~40px 可读细带,220 处塌成 2px)。起步层 cf-advanced 的 180px 地板
   已同步撤掉,内容改随外壳 flex 收缩;拖柄向下拖到下限就停在这,向上/全屏不受影响。
   !important 是必需的:ModuleBox 给 .ben-wb__mod 内联了 minHeight:0,
   普通 CSS  min-height 敌不过内联样式。 */
.ben-wb__mod[data-module-box="files"]{min-height:220px!important}
/* 图谱格(files)的合理最小高度(2026-10-24,我定的可撤回):低于 ~220px,直出本体的
   「tabs+项目行+图体+图注」预算(≈172)再加起步小组件的 cf-tabs/header 两行就装不下,
   图注会被上面 overflow:hidden 裁掉(独立审 S1/S3 矮态截图实证;220 真浏览器逐项量过)。
   旧版用户层小组件容器不参与 flex 高度链的适配,由 FilesModule 的嵌入槽位协议
   (ref + ResizeObserver,只量本体 .ben-wb__mod 盒)解决 —— 本体样式**不认识任何
   用户层 class**(分层 skin-guard 硬门,见 tests/client-user-layer-skin-guard.test.ts)。 */
/* 并排行容器(2026-08-25 顶部分栏):同 row 的模块横排。行高由父层按该行最大
   basis_pct 定死,行内各模块用 width_pct 切宽度、高度撑满——与纵向堆叠共存,
   单模块行不套这个容器,DOM 与改造前一致。 */
.ben-wb__row{display:flex;flex-direction:row;gap:0;min-height:0;flex-shrink:0;overflow:hidden}
/* 行内竖向拖拽条(项目区 / 消耗数据 之间)。11px 热区 + 居中一根圆角竖杠,
   跟底边那根横向抓手同一套视觉语言:灰 → 悬停变亮 → 拖拽变强调色。
   它自己占掉原来 .ben-wb__row 的 gap,所以上面把 gap 改成 0,总宽不变。 */
/* 列容器(2026-08-25 右侧上下堆叠):同 row 同 col 的模块竖着摞在一列里。
   宽度由这一列统一持有,列内各模块只管自己占多高(按各自 basis 在本列总和里的占比)。 */
.ben-wb__col{display:flex;flex-direction:column;gap:11px;min-height:0;min-width:0;overflow:hidden}
.ben-wb__split{flex:none;width:11px;display:flex;align-items:center;justify-content:center;cursor:col-resize;touch-action:none;position:relative;z-index:1}

/* ── 横屏布局(2026-09-18,类名一律 ben-wb__land*) ─────────────────────────────
   只有排布,没有一条新的颜色/字号/圆角:横屏用的是跟竖屏一模一样的模块盒子与令牌,
   黑白微光那套视觉一字未动(Ben:「只参考布局就行」)。

   为什么是行内 style + 这几条类,而不是纯 CSS 媒体查询:区域的比例(中区/右栏的左右
   占比、底部一排多高)是**用户拖出来的布局数据**,要落盘、要按方向分别记——媒体查询
   里写死的百分比表达不了"Ben 昨天把项目执行那栏拖宽了一点"。方向判定本身也不走媒体
   查询(见 client/orientation.ts):它量的是容器,不是屏幕,将来工作台被嵌进一块比屏幕
   小的区域里时仍然成立。这两条类只负责"横着排还是竖着排"这种与数据无关的部分。 */
/* gap 0(2026-09-18 分栏把手):上半条与底部一排之间那 11px 现在由那根横把手占着,
   两样一起留会把中间贴窗那块再挤掉 11px,而且拖的时候会看见"把手和缝各一条"。
   横屏下 overflow-y 也改成 hidden:五个区域的高度加起来正好是这一块,允许滚动等于
   允许用户把日结条滚出视野(不可改清单第 4 条),也会让 /slot/rect 报出一个滚过之后
   就不再成立的矩形。竖屏那条(overflow-y:auto)一个字没动。 */
.ben-wb__body[data-orientation=landscape]{gap:0;overflow-y:hidden}
/* 上半条:左栏 + 中区 + 右栏。高度由行内 style 按 100-底部一排给定。 */
.ben-wb__land-band{display:flex;flex-direction:row;gap:0;min-height:0;min-width:0;flex-shrink:0;overflow:hidden}
/* ① 左侧窄栏。定宽 168px:够放一列应用名(最长的是「事务官」三个字加一枚圆点徽章),
   又不占掉中间贴窗那块地方。flex:none——它不参与中区/右栏那对零和的宽度分配,
   拖那根竖条只在中区与右栏之间倒腾,不会把应用栏挤没。
   竖排是这里唯一改的一件事:.ben-wb__dock-tabs 在竖屏是 flex-wrap 的一横排,
   横屏改成一列,标签本身的样式(圆角/底色/选中态/徽章)一个字没改。 */
/* overflow 从 auto 改成 visible(2026-09-18):场景条在这条栏里收成了一颗图标按钮,
   点开的面板要往右开到中间那块区域上去,栏自己裁剪的话面板当场被切掉。滚动改由
   下面那条挂在标签列表上 —— 真正会长的是标签,不是这条栏本身。 */
/* 2026-09-18 分栏把手:原来靠 padding-right:9px 加 border-right 跟中区隔开;现在那条
   边界上站着一根真的 11px 把手(同宽同视觉),两样一起留就是"一条灰线紧挨一根灰杠"。
   宽度:没拖过时仍是这个 168px,拖过之后由行内 flex-basis 百分比顶掉(见 Workbench.tsx)。 */
.ben-wb__land-rail{flex:none;width:168px;display:flex;flex-direction:column;gap:8px;min-height:0;overflow:visible}
.ben-wb__land-rail .ben-wb__dock-tabs{flex:0 1 auto;min-height:0;overflow-y:auto}
.ben-wb__land-rail .ben-wb__dock-tabs{flex-direction:column;flex-wrap:nowrap;align-items:stretch}
.ben-wb__land-rail .ben-wb__dock-tab{width:100%;justify-content:space-between}
.ben-wb__land-rail .ben-wb__dock-tab-name{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__land-rail .ben-wb__scenebar{margin-bottom:0}
/* ② 中间大区:窗位槽。内部模块用 flex:1 1 0 填满(renderModule 的 fill)。
   与应用栏之间的那 9px 内边距 2026-09-18 去掉了:那条边界上现在是一根 11px 的把手。 */
.ben-wb__land-stage{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
/* ③ 右侧栏:项目执行。 */
.ben-wb__land-side{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
/* ④ 底部一排:四格。宽度不写 width:25%——每格自己的 flex-grow 就是它的 width_pct
   (renderModule 的 grow),所以拖两格之间那根把手能改占比、收起其中一两格之后剩下的
   也照样自动匀开,一条规则管两件事。
   gap 从 11px 改成 0(2026-09-18):三根 11px 的把手站在四格之间,间距由它们提供,
   两样一起留会让底部一排的缝比上面那两条宽一倍。 */
.ben-wb__land-deck{display:flex;flex-direction:row;gap:0;min-height:0;min-width:0;flex-shrink:0;overflow:hidden}
/* 横屏下页头那三行字(DeepSeek Harness / Ben Workbench / 副标题)压扁成一行:
   横屏本来就矮,上面每多占一行,中间贴窗那块就少一行。只动这一处间距,字号不变。 */
.ben-wb[data-orientation=landscape] .ben-wb__inner{padding:14px 16px 16px}
.ben-wb[data-orientation=landscape] .ben-wb__header{margin-bottom:11px}
.ben-wb[data-orientation=landscape] .ben-wb__subtitle{display:none}
.ben-wb__split-grip{width:4px;height:36px;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background-color .12s ease}
.ben-wb__split:hover .ben-wb__split-grip{background:var(--dsw-alias-label-tertiary)}
.ben-wb__split[data-dragging=true] .ben-wb__split-grip{background:var(--dsw-alias-state-business-primary)}
/* 横向那一根(2026-09-18:主区 | 底部一排)。把手本体与竖向那根**同样是 11px 热区、
   同样一根 4px 圆角短杠、同样的灰→亮→强调色**,只是整套转了 90°:高度 11px、满宽、
   光标 row-resize、短杠横躺。视觉上一模一样是故意的——四条边界是同一种东西,
   不该因为朝向不同就长得不一样。 */
.ben-wb__split--h{width:auto;height:11px;cursor:row-resize;flex:none}
.ben-wb__split--h .ben-wb__split-grip{width:36px;height:4px}
/* 用量面板(2026-08-25 二轮重做)。
   首版被判"就是个线性图",根因有二:
   (1) 用了 --dsw-alias-fill-l1/l2 两个**根本不存在的令牌**(实测与瞎编的令牌返回同值),
       于是卡片没底色、进度条轨道透明,整块塌成一条条线;
   (2) 排版本身缺层级。
   现在一律用实测存在的令牌:bg-layer-2 做抬起面、border-l2 做发丝线、
   state-business-primary(rgb 103,158,254)做强调色。 */
.ben-wb__usage{display:flex;flex-direction:column;gap:10px}

/* 分段控件:选中项给一块抬起面 + 主文字色,未选中退到三级文字色。 */
.ben-wb__usage-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none}
.ben-wb__usage-seg{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb .ben-wb__usage-segbtn{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;padding:5px 10px;border-radius:6px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.ben-wb .ben-wb__usage-segbtn:hover{color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__usage-segbtn[data-on=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}

/* 主数字。一个视图只有一个,不跟其他数字抢注意力。 */
.ben-wb__usage-hero{display:flex;align-items:baseline;gap:8px;flex:none;flex-wrap:wrap}
.ben-wb__usage-hero-v{font-size:28px;font-weight:600;line-height:1.1;letter-spacing:-.02em;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ben-wb__usage-hero-l{font-size:11px;color:var(--dsw-alias-label-tertiary)}

/* 排行榜。轨道常显——看得出"占多少"而不只是"有多长";数据端 4px 圆角。 */
.ben-wb__usage-rank{display:flex;flex-direction:column;gap:9px}
.ben-wb__usage-rankhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:4px}
.ben-wb__usage-rankname{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__usage-rankval{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);flex:none;font-variant-numeric:tabular-nums}
.ben-wb__usage-rankbar{height:6px;border-radius:3px;background:var(--dsw-alias-border-l1);overflow:hidden}
.ben-wb__usage-rankfill{display:block;height:100%;border-radius:0 4px 4px 0;background:var(--dsw-alias-state-business-primary);transition:width .2s ease}
.ben-wb__usage-ranksub{font-size:10px;color:var(--dsw-alias-label-tertiary);margin:4px 0 0;font-variant-numeric:tabular-nums}
.ben-wb__usage-rest{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:2px 0 0}

/* 总消耗独占首行；次级指标用排版区分，避免吞吐与主口径竞争。 */
.ben-wb__usage-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:4px 6px}
.ben-wb__usage-tile{background:transparent;border:0;padding:4px 8px;min-width:0}
.ben-wb__usage-tile-l{font-size:11px;line-height:1.35;color:var(--dsw-alias-label-secondary);margin:0;overflow-wrap:anywhere}
.ben-wb__usage-tile-v{font-size:16px;font-weight:500;line-height:1.25;letter-spacing:-.01em;color:var(--dsw-alias-label-primary);margin:3px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.ben-wb__usage-tile--primary{grid-column:1/-1;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ben-wb__usage-tile--primary .ben-wb__usage-tile-v{font-size:28px;font-weight:600;line-height:1.15;letter-spacing:-.025em;margin-top:4px}
.ben-wb__usage-tile-sub{font-size:11px;line-height:1.35;color:var(--dsw-alias-label-secondary);margin:4px 0 0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}

/* 方格图 —— GitHub 式贡献格子图:**列 = 周,行 = 星期几**,铺开整整一年。
   grid-auto-flow:column + 固定 7 行 = 同一行永远是同一个星期几;
   grid-auto-columns:1fr 让 53 列均分整宽——这才是"铺满",不是把格子拉成长方形。
   aspect-ratio:1 保住方形;整年 53 列天然够宽,不需要拉伸单格。 */
.ben-wb__usage-heatwrap{display:flex;flex-direction:column;gap:3px}
.ben-wb__usage-heathead{display:flex;justify-content:space-between;font-size:9px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__usage-heat{display:flex;gap:4px;align-items:flex-start}
.ben-wb__usage-heatdays{display:grid;grid-template-rows:repeat(7,1fr);gap:2px;flex:none;height:100%}
.ben-wb__usage-heatdays span{font-size:8px;line-height:1;color:var(--dsw-alias-label-tertiary);text-align:right;display:flex;align-items:center;justify-content:flex-end}
.ben-wb__usage-heatgrid{flex:1;min-width:0;display:grid;grid-template-rows:repeat(7,1fr);grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px}
.ben-wb__usage-heatcell{aspect-ratio:1;border-radius:2px;background:rgba(255,255,255,.05);min-width:0}
.ben-wb__usage-heatcell[data-level="1"]{background:rgba(103,158,254,.28)}
.ben-wb__usage-heatcell[data-level="2"]{background:rgba(103,158,254,.5)}
.ben-wb__usage-heatcell[data-level="3"]{background:rgba(103,158,254,.75)}
.ben-wb__usage-heatcell[data-level="4"]{background:var(--dsw-alias-state-business-primary)}
/* 未来的日子:只画一圈边、不给填充。**必须和"过去但没用量"看得出区别**——
   把还没到的日子涂成 0 档等于在编数(D13)。留在这儿等着被一格格点亮。
   边框透明度是调过的:.05 时整片未来几乎隐形,"看着它被点亮"就没了意义(真机实证);
   .14 能看出这是一张等着填的日历,又不会盖过已点亮的格子。 */
.ben-wb__usage-heatcell[data-future=true]{background:transparent;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
/* 过去但没用量:实心极淡填充。和未来的"空心"一眼分得开——一个是"没用",一个是"还没到"。 */
.ben-wb__usage-heatcell[data-level="0"]:not([data-future=true]){background:rgba(255,255,255,.08)}


/* 余量(从展示台右下角搬来)。沿用展示台的配色语义:ok/warn/danger 三档,
   条长 = 剩余,越短越危险。余额型不画条——余额没有分母。
   flex:1 让它吃掉模块被拖高后剩下的空间,那片空白原本是纯浪费。 */
.ben-wb__usage-quota{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;margin-top:2px}
.ben-wb__usage-quotattl{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__usage-quotagrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:6px}
.ben-wb__usage-q{background:transparent;border:1px solid transparent;border-bottom-color:var(--dsw-alias-border-l1);padding:7px 9px;min-width:0}
.ben-wb__usage-qhead{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
.ben-wb__usage-qname{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ben-wb__usage-qval{font-size:16px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere;min-width:0}
.ben-wb__usage-qval[data-level=warn]{color:var(--dsw-alias-state-warn-label)}
.ben-wb__usage-qval[data-level=danger]{color:var(--dsw-alias-state-error-primary)}
.ben-wb__usage-qbars{display:flex;flex-direction:column;gap:3px;margin-top:4px}
.ben-wb__usage-qbar{display:flex;align-items:center;gap:5px}
.ben-wb__usage-qlabel{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;min-width:26px;max-width:120px;overflow:hidden;text-overflow:ellipsis}
/* 卡 AG(2026-09-27):页面上就分了组的那一家,换组那一行前面的组名小标题(「Gemini Models」)。
   比行名再小一号、再淡一点 —— 它是标题,不跟横条抢眼睛;一行放不下就省略号,鼠标停上去看得见全名。 */
.ben-wb__usage-qgroup{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:4px 0 1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__usage-qgroup:first-child{margin-top:0}
.ben-wb__usage-qtrack{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden;min-width:0}
.ben-wb__usage-qtrack i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
.ben-wb__usage-qtrack i[data-level=warn]{background:var(--dsw-alias-state-warn-label)}
.ben-wb__usage-qtrack i[data-level=danger]{background:var(--dsw-alias-state-error-primary)}
.ben-wb__usage-qpct{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
.ben-wb__usage-qnote{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:6px 0 0;overflow-wrap:anywhere}
.ben-wb__usage-qpeak{font-size:11px;line-height:1.5;margin:2px 0 0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.ben-wb__usage-qpeak[data-phase=peak]{color:var(--dsw-alias-status-warning,#c08a2e)}
/* 「读不到最新」时那颗入口键(2026-10-02,卡 QK):同「▸ 说明」那一栏的轻量写法 ——
   它不是「还差一步」那种主动作,只是「想接实时源就从这儿去」。 */
.ben-wb__usage-qfix{margin-top:6px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}
.ben-wb__usage-qfix:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* 页头右上角动作区(恢复默认布局 + 返回对话)。 */
.ben-wb__headeractions{display:flex;align-items:center;gap:8px;flex:none}

/* 模块头的三个按钮一律不换行——「收起」两个汉字曾在窄按钮里被挤成上下两行。
   现在收起用图标,这条是兜底:任何字形都不许折行。 */
.ben-wb__modbtns button{white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;line-height:1}
.ben-wb__usage-heatcell[data-level="1"]{background:rgba(103,158,254,.28)}
.ben-wb__usage-heatcell[data-level="2"]{background:rgba(103,158,254,.5)}
.ben-wb__usage-heatcell[data-level="3"]{background:rgba(103,158,254,.75)}
.ben-wb__usage-heatcell[data-level="4"]{background:var(--dsw-alias-state-business-primary)}

/* 残缺/未接入来源的注记。圆点带颜色,文字不带——身份靠旁边的色块,不靠给文字上色。 */
.ben-wb__usage-notes{display:flex;flex-direction:column;gap:2px;margin-top:2px}
.ben-wb__usage-note{display:flex;align-items:baseline;gap:5px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:0;overflow-wrap:anywhere}
.ben-wb__usage-dot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.ben-wb__usage-dot[data-tone=partial]{background:var(--dsw-alias-state-warn-label)}
.ben-wb__usage-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}
/* 底边拖拽调高手柄(真机反馈:原来 6px 纯光标区找不到,Ben 反馈"为什么还没实现")：
   12px 满宽热区,居中一根圆角短杠常显(灰→悬停变亮→拖拽变强调色)——不再是"只有
   悬停才看得出可拖"的隐形交互,常显的短杠本身就是"这里能拖"的视觉线索。
   position:relative;z-index:1 只是确保它在层叠上下文里压在模块内容之上(正常
   flex 兄弟本来就按 DOM 序在后面画,这里显式声明避免被误解成会被遮住)；
   flex:none 占自己的固定高度,body 分给这个模块的剩余空间照样先紧着 <section> 用,
   在 .ben-wb__mod 的 overflow:hidden 盒子内正常排布,不会被裁掉。 */
.ben-wb__mod-handle{flex:none;height:12px;display:flex;align-items:center;justify-content:center;cursor:row-resize;touch-action:none;position:relative;z-index:1}
.ben-wb__mod-handle-grip{width:36px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background-color .12s ease}
.ben-wb__mod-handle:hover .ben-wb__mod-handle-grip{background:var(--dsw-alias-label-tertiary)}
.ben-wb__mod-handle[data-dragging=true] .ben-wb__mod-handle-grip{background:var(--dsw-alias-state-business-primary)}
.ben-wb__col{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:11px;min-width:0}
.ben-wb__card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px;min-width:0}
.ben-wb__card--fill{flex:1;min-height:0;height:100%;display:flex;flex-direction:column}
.ben-wb__ttl{margin:0 0 9px;font-family:inherit;font-size:12px;letter-spacing:.02em;font-weight:600;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px;flex:none}
.ben-wb__ttl-r{margin-left:auto;letter-spacing:0;text-transform:none;color:var(--dsw-alias-label-tertiary)}
.ben-wb__modhead[data-widget-draggable=true]{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
.ben-wb__modhead[data-widget-draggable=true]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#d5d5d5);outline-offset:2px;border-radius:4px}
.ben-wb__modhead button,.ben-wb__modhead input{touch-action:manipulation}
.ben-wb__body[data-widget-reordering=true],.ben-wb__body[data-widget-reordering=true] *{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important}
.ben-wb__mod[data-reordering=true]{opacity:.28}
.ben-wb__widget-ghost{position:fixed;z-index:2147483000;pointer-events:none;box-sizing:border-box;overflow:hidden;border:1px solid var(--dsw-alias-state-business-primary,#d5d5d5);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#202020);box-shadow:0 16px 48px #0008;opacity:.94;will-change:transform;contain:layout paint}
.ben-wb__widget-ghost .ben-wb__mod{opacity:1}
.ben-wb__widget-drop{position:fixed;z-index:2147483001;pointer-events:none;background:var(--dsw-alias-state-business-primary,#d5d5d5);border-radius:4px;box-shadow:0 0 10px #ffffff33}
.ben-wb__widget-drop[data-full=true]{background:#ffffff12;border:2px solid var(--dsw-alias-state-business-primary,#d5d5d5);border-radius:10px}
.ben-wb__widget-drop[hidden]{display:none}

/* 模块头：标题拖拽与收起。计数条(会话区)是 h2 的旁支,不进 h2——见 ModuleHeader 注释 */
.ben-wb__modhead{display:flex;align-items:center;gap:8px;margin-bottom:9px;flex:none}
.ben-wb__modhead .ben-wb__ttl{margin:0}
.ben-wb__modbtns{display:flex;gap:4px;margin-left:auto}
.ben-wb__modbtns button{flex:none;width:22px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;display:grid;place-items:center}
.ben-wb__modbtns button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__modbtns button:disabled{opacity:.35;cursor:not-allowed}
/* 布局工具条：恢复默认 + 已收起模块的重新展开入口 */
.ben-wb__layoutbar{display:flex;align-items:center;gap:8px;margin-bottom:11px;flex-wrap:wrap}
.ben-wb__resetlayout{flex:none;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}
.ben-wb__resetlayout:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__hiddenmods{display:flex;gap:6px;flex-wrap:wrap}
.ben-wb__hiddenmod{flex:none;padding:4px 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}
.ben-wb__hiddenmod:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
/* 收起补偿(spec §4"收起必有通知")的那一叠。**顶条下那条固定通知行
   (.ben-wb__fixedalerts)2026-10-13 退休,规则一起删了** —— 理由见 client/layout.ts
   原 hoistedAlerts 那一处。下面这两条是 client/SessionFeed.tsx 的会话区版本,那个组件
   现在整个没挂在任何地方(A3 起会话区下线),留着不动:它不画在屏上。 */
.ben-wb__alerts{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;flex:none}
.ben-wb__alerts p{margin:0;padding:6px 9px;border:1px solid var(--dsw-alias-state-warn-label);border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-warn-label);font-size:11.5px}
/* 顶条下面那条琥珀描边的固定通知行 2026-10-13 退休,这两条规则跟着走 —— 理由见
   client/layout.ts 里原 hoistedAlerts 那一处。 */
/* 「人找我」chips：微信/企业微信角标(spec §3.3, D15;2026-08-22 微信双开假设作废) */
.ben-wb__chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;flex:none}
.ben-wb .ben-wb__chip{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}
.ben-wb .ben-wb__chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__chip-help{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.ben-wb__chip-badge{min-width:15px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;line-height:15px;text-align:center}
/* 窗位叠标签栏(spec 2026-08-24 窗位叠 v2 V1–V9)：current 高亮,running:false 置灰但仍可点(服务端会拉起来) */
.ben-wb__dock{display:flex;flex-direction:column;gap:6px;margin-bottom:8px;flex:none}
.ben-wb__dock-tabs{display:flex;flex-wrap:wrap;gap:6px}
/* C1(review 修复):不能再靠 overflow:hidden 裁圆角——那会把悬停气泡一起裁没(真机上
   气泡整个不可见,jsdom 的 textContent 断言测不出裁剪,只有真机能看见这个坑)。圆角
   改成两个子按钮自己各切一半(name 切左边、close 切右边),视觉效果不变。后续气泡改成
   position:fixed 之后(见 .ben-wb__dock-badge-bubble 的注释)已经不再依赖这条规则来
   逃逸裁剪了,但两个子按钮各切一半角本身没有坏处,不必改回去。 */
.ben-wb__dock-tab{display:inline-flex;align-items:center;border:1px solid transparent;background:var(--dsw-alias-bg-layer-2);transition:background-color .12s ease,box-shadow .12s ease;border-radius:7px}
.ben-wb__dock-tab[data-current=true]{background:var(--dsw-alias-state-business-tertiary);box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary)}
.ben-wb__dock-tab-name{padding:5px 9px;border:0;border-radius:6px 0 0 6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
/* 双窗态标记:一枚标签管两扇窗。比标签名小一号、用三级文字色——它是状态标注,
   不该跟标签名抢注意力,更不能被误读成未读计数(所以用「⧉」不用数字)。 */
.ben-wb__dock-tab-dual{margin-left:4px;font-size:10px;color:var(--dsw-alias-label-tertiary);vertical-align:1px}
.ben-wb__dock-tab-name:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__dock-tab[data-current=true] .ben-wb__dock-tab-name{color:var(--dsw-alias-state-business-primary);font-weight:600}
.ben-wb__dock-tab[data-running=false] .ben-wb__dock-tab-name{color:var(--dsw-alias-label-tertiary)}
.ben-wb__dock-tab-close{padding:5px 7px;border:0;border-left:1px solid transparent;border-radius:0 6px 6px 0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:10.5px;cursor:pointer}
.ben-wb__dock-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
/* W4:事务官格没有 ✕ 除名按钮,右侧内边距要补回来,否则文字贴边 */
.ben-wb__dock-tab--butler{padding-right:9px}
/* S2(a)(review,真机截图实证):dock.note 从标签栏挪进了槽体内部(SlotZone),position:
   absolute 悬浮在槽体顶端——不占 .ben-wb__slot-body 的文档流,出现/消失都不会改变
   槽体自身的盒子尺寸(那正是原来的问题:note 在文档流里占位,切换会让同一个 flex 列里
   的槽体分到的剩余高度跟着变,ResizeObserver 把这当"槽体真的变了尺寸"重新报一次矩形,
   已经贴住的窗口因此被重新摆一次位置)。z-index 比悬停提示文案(.ben-wb__slot-hover-hint,
   pointer-events:none)高一档,两者理论上不会同时出现,但顺序写清楚不留歧义。 */
.ben-wb__dock-note{position:absolute;top:0;left:0;right:0;margin:0;padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:8px 8px 0 0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11.5px;z-index:2}
/* 标签徽章圆点(spec A3,取代会话区;真机反馈追加第四档「进行中」):白=进行中(呼吸
   闪烁,见下方 keyframes)、黄=等确认、蓝=刚完成未读、红=出错、灰=IM 未读——悬停出一个
   小气泡列出该分类下的会话标题/短 id + 耗时,IM 显示"未读 N 条"。 */
/* 拖拽排序(2026-09-02):抓起来的那枚半透明,让人看清自己正在搬哪一个;
   光标用 grab/grabbing 表明"这东西能拖"——不加这两条,拖拽功能对用户是隐形的。 */
.ben-wb__dock-tab[draggable=true]{cursor:grab}
.ben-wb__dock-tab[data-dragging=true]{opacity:.4;cursor:grabbing}
.ben-wb__dock-badges{display:inline-flex;gap:3px;margin:0 2px}
.ben-wb__dock-badge{position:relative;display:inline-flex}
/* 选择器**必须带 .ben-wb 前缀**(2026-09-02 Ben 反馈"完成的图标和文字和左侧的不一致"):
   蓝色「未读完成」那档的圆点是个 button(点它标已读),而基础样式里有一条
   ".ben-wb button{font:inherit}"——font 是简写属性,会把字号/字重**整个重置成继承值**,
   且它的权重 (0,1,1) 高于不带前缀的 ".ben-wb__dock-badge-dot" (0,1,0)。结果:
   白点(span)保持 9.5px 小字,蓝点(button)的数字被拔成标签的大字号,两个并排明显不齐。
   加上 .ben-wb 前缀后权重 (0,2,0) 压过那条,button 与 span 两种圆点字号一致。
   同一个坑本文件下面第 537 行附近的注释早就记过一次,徽章这条当时漏了。

   顺带把几何也钉死:所有档共用一条**透明**的同宽边框 + box-sizing:border-box,
   有色档只覆盖 border-color——白点那圈可见边框因此不会把它撑得比别档大。 */
.ben-wb .ben-wb__dock-badge-dot{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 3px;border-radius:999px;font-size:9.5px;font-weight:700;line-height:1;color:var(--dsw-alias-label-primary-foreground);cursor:default;border:1px solid transparent;font-family:inherit}
/* 蓝色「未读完成」档的圆点是个真按钮(点击=标记已读,2026-08-26 修复)——button 的 UA
   默认样式(边框/背景/字体)已在基类里归零,这里只补上"可点"的指针形态。 */
button.ben-wb__dock-badge-dot{cursor:pointer}
/* running 档背景是纯白(不用 label-primary-foreground 这类跟主题走的别名——Ben 要的
   是"白色圆点"本身作为一档独立于其余三档的视觉标识),另加一圈细边框:纯白在浅色主题
   背景上贴着标签栏容易糊在一起,border 保证任何主题下圆点轮廓都看得清。呼吸动效只对
   opacity 做周期渐变(1→0.45→1,2s 一轮),不动 scale/color——真机反馈"幅度别太晃眼"。
   review 修复:数字的 color 不能沿用基类 .ben-wb__dock-badge-dot 的
   --dsw-alias-label-primary-foreground——那是配深色/饱和填色背景(waiting/error/done
   那几档)的浅色前景 token,盖在这里新换的纯白底上会糊成看不清。白底必须显式配一个
   不随主题变浅的深色,写死 #1d1d1f(不用 label 系语义 token——那些在暗色主题下会变浅,
   而这里的底色不随主题变,前景也不能随主题变)。 */
.ben-wb__dock-badge[data-tone=running] .ben-wb__dock-badge-dot{background:#fff;border-color:var(--dsw-alias-border-l2);color:#1d1d1f;animation:ben-wb-dock-badge-breathe 2s ease-in-out infinite}
.ben-wb__dock-badge[data-tone=waiting] .ben-wb__dock-badge-dot{background:var(--dsw-alias-state-warn-label)}
.ben-wb__dock-badge[data-tone=error] .ben-wb__dock-badge-dot{background:var(--dsw-alias-state-error-primary)}
/* 「未读的已完成」那颗用回原来的蓝(2026-09-25 维护者:「改成蓝色的,之前的那个蓝色」),好跟白色的「在跑」分开;
   全局去蓝(neutralStyle.ts)把 business-primary 改成了主文字色,所以这里写死 DSH 原来那个值,不走令牌。 */
/* 维护者 09-25 又说:「这个蓝色有点浅,但更关键是字应该还是黑的」—— 蓝深一档,数字跟「在跑」那颗一样用黑。 */
.ben-wb__dock-badge[data-tone=done] .ben-wb__dock-badge-dot{background:rgb(79,142,247);color:#1d1d1f}
.ben-wb__dock-badge[data-tone=im] .ben-wb__dock-badge-dot{background:var(--dsw-alias-label-tertiary)}
@keyframes ben-wb-dock-badge-breathe{0%,100%{opacity:1}50%{opacity:.45}}
/* 真机反馈修订(取代 C1 那版 top:100%/朝下开的方案):认领窗位的是一扇真实的原生窗口,
   壳把它摆得跟 .ben-wb__slot-body 严丝合缝——那不是网页内容,是操作系统层面盖在浏览器
   渲染表面之上的另一个窗口,气泡朝下开、落在槽体范围里,画面上被这扇原生窗口整个盖住,
   肉眼完全看不见(CSS z-index 排不到系统窗口前面,对这个问题无解)。改成 position:fixed
   (逃出 .ben-wb__dock-tab/.ben-wb__mod 两层裁剪,也不再关心祖先是不是 overflow:hidden)
   朝上开——标签栏在窗位模块顶部,往上是项目区那些普通网页内容,不会被原生窗口盖住。
   top/left 不再是静态 CSS,由 Workbench.tsx 的 DockTabBadge 在鼠标移上圆点那一刻用
   getBoundingClientRect() 现算、写成行内 style;这里只留视觉属性 + translateX(-50%)
   水平居中(锚点是圆点中心)。显隐也不再靠 CSS :hover/display:none——组件是否挂载这个
   div 本身就是"可见"的开关(React state),这里不需要那一层了。 */
/* 真机反馈(Ben):气泡在真机上偏小,加大一档——padding 6px 8px→9px 12px(约 1.5 倍),
   max-width 从(隐式的)窄气泡放宽到 260px(配合 Workbench.tsx 里同步调大的
   BUBBLE_HALF_WIDTH_ESTIMATE_PX=130),字号见下面的 p 规则(11px→13px)。
   review 修复:原来这里还留着旧版的 white-space:nowrap——那是给"气泡宽度不设上限,
   永远单行"那版设计用的规则,加了 max-width 之后两者互相矛盾:nowrap 拒绝换行,
   超长标题(running 档还拼上"上次输出"后缀,更容易超)会把文字视觉撑出 260px 的盒子,
   Workbench.tsx 算的 130px 水平夹紧半宽也就跟着失真。去掉 nowrap,交给下面 p 规则的
   overflow-wrap:anywhere 折行——max-width 才是这个气泡宽度真正生效的上限。 */
.ben-wb__dock-badge-bubble{position:fixed;transform:translateX(-50%);margin:0;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:260px;z-index:50}
.ben-wb__dock-badge-bubble p{margin:0;font-size:13px;color:var(--dsw-alias-label-primary);line-height:1.5;overflow-wrap:anywhere}
.ben-wb__dock-app-hint{position:fixed;z-index:50;box-sizing:border-box;pointer-events:none;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 20px rgba(0,0,0,.24);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;overflow-wrap:anywhere;animation:ben-wb-app-hint-in .14s ease-out both}
.ben-wb__dock-app-hint strong{display:block;font-size:12px;font-weight:600}
.ben-wb__dock-app-hint p{margin:3px 0 0;color:var(--dsw-alias-label-secondary)}
.ben-wb__dock-app-hint::before{content:"";position:absolute;left:50%;width:7px;height:7px;background:var(--dsw-alias-bg-layer-1);transform:translateX(-50%) rotate(45deg)}
.ben-wb__dock-app-hint[data-side=top]::before{bottom:-4px;border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.ben-wb__dock-app-hint[data-side=bottom]::before{top:-4px;border-left:1px solid var(--dsw-alias-border-l1);border-top:1px solid var(--dsw-alias-border-l1)}
.ben-wb .ben-wb__dock-tab-name:focus-visible{outline:1px solid var(--dsw-alias-label-secondary);outline-offset:-2px;border-radius:6px}
@keyframes ben-wb-app-hint-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.ben-wb__dock-app-hint{animation:none}}
/* 窗口槽(spec §3.4)：收起态是 28px 纯入口把手,展开态本期只做应用按钮一排。
   flex:1 0 auto(真机截图实证,模块盒子化修订):grow:1 正常情况下吃满 .ben-wb__mod
   分给它的剩余高度;shrink:0——盒子被场景条挤得太紧时,.ben-wb 不靠这里让步,让步的
   是下面 .ben-wb__slot-scroll(它才是"高度会变"的那部分)。min-height:0 只是参与
   flex 计算的常规写法,不代表真的会被压到 0——挤不下时交给外层 .ben-wb__mod 的
   overflow:hidden 兜底裁切,不会外溢到下一个模块。 */
.ben-wb__slot{display:flex;flex-direction:column;gap:8px;flex:1 0 auto;min-height:0}
/* F2(review,真机截图实证):原来这里还有一条 .ben-wb__slot-handle("收起态 28px 入口
   把手")——模块盒子化改造前的遗留,ModuleBox 统一收起/展开后这条把手早没了对应的
   交互,纯装饰色块,真机截图里是场景区空着时底部那条突兀的横条。整条规则连同 JSX
   一起删掉(Workbench.tsx 的 SlotZone),不是靠改样式藏起来。 */
/* 标签栏下方"高度会变"的那部分——场景条 + 管理面板打开时的那一长串应用行。
   flex:0 1 auto(不是 1 1 auto):平时按自己内容的自然高度显示,不额外抢 .ben-wb__slot
   的份额;盒子被挤得太紧时,shrink:1 让它先缩、先滚,槽体本身(见上面 .ben-wb__slot
   的 flex-shrink:0)优先保住。min-height:84px(真机反馈:窗位盒矮的时候这里被压到
   接近 0,场景行"整个消失"——"窗口显示不完整"):留够约两行场景的高度,盒子真的
   矮到连这个也放不下时,靠外层 .ben-wb__mod 的 overflow:hidden 兜底裁切槽体底部
   (槽体的 120px 下限最后让步——裁一点看得见的东西,好过一整块内容凭空消失)。
   F2(review,真机截图实证):这条规则现在只在有场景时才会挂到 DOM 上(调用点
   Workbench.tsx 按 scenes.length>0 判断)——没有场景时这层容器整个不渲染,不是
   靠这里的样式压到 0,那样仍然会留一条空的视觉留白。 */
.ben-wb__slot-scroll{display:flex;flex-direction:column;gap:8px;flex:0 1 auto;min-height:84px;overflow-y:auto}
.ben-wb__slot-apps{display:flex;gap:6px;flex-wrap:wrap}
.ben-wb__slot-app{flex:none;padding:5px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.ben-wb__slot-app:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 窗口槽·未接入/贴合失败横幅(spec W1–W4,D13：原样显示 reason,不改写措辞) */
.ben-wb__slot-warn{margin:0;padding:6px 9px;border:1px solid var(--dsw-alias-state-warn-label);border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-warn-label);font-size:11.5px}
/* 窗口槽·贴合成功但尺寸有偏差(F2,spec D13):不是失败,低调陈述,不用红色告警底色。 */
.ben-wb__slot-note{margin:0;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
/* C1(整分支终审)·「回到窗位落点」:叠为空且选中事务官时,标签栏只剩「事务官」一格,这是
   回到拖拽落点的路。行内文字按钮(不是块状按钮)——它是那句话的一部分,不该抢戏。 */
.ben-wb__slot-back{padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;text-decoration:underline;cursor:pointer}
/* 窗口槽·槽体：贴合矩形以它的 getBoundingClientRect() 为准，虚线边框只是占位提示。
   flex:1 1 auto;min-height:120px(真机截图实证,原来是 240px 的硬下限——场景条+管理
   面板一多,240 连同上面所有内容一起把盒子撑爆,现在缩到一个更容易在真实盒高里满足
   的下限):正常情况下 flex:1 吃满 .ben-wb__slot 的剩余高度;真被挤到底线,120px 是
   它守住的最后一点,不会被压成一条缝——再挤不下就是 .ben-wb__mod 的 overflow:hidden
   接手裁切,不会外溢。 */
.ben-wb__slot-body{position:relative;flex:1 1 auto;min-height:120px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}
.ben-wb__slot-body[data-snapped=true]{border-style:solid;border-color:var(--dsw-alias-state-business-primary)}
/* 窗口槽·拖拽悬停高亮(悬停高亮 v1)：壳侧 hover 事件经 /live 广播驱动 data-hover——
   虚线变粗变亮 + 呼吸动效,居中提示文案只在悬停时挂载(不常驻 DOM，不用另设 display:none)。
   S2(a)(review,真机截图实证):"变粗"原来是把 border-width 从 1px 改成 2px——outline
   之外的 box 模型属性(border/padding)变了会改变 ResizeObserver 默认观测的 content-box
   尺寸(哪怕 box-sizing:border-box 让 getBoundingClientRect() 的外框尺寸不变,
   ResizeObserver 默认盯的是 content-box,不是外框),每次悬停进出都会白白触发一轮
   "槽体尺寸变了"的误判,追加一次不必要的矩形上报。改用 outline(配 outline-offset
   把它画到边框内侧,视觉上还是"贴着边框变粗"的效果)——outline 从规范上就不参与
   布局盒模型,不会被任何观测布局的机制当成"尺寸变化"。 */
/* 2026-09-24:悬停的「光」换成 border-beam 绕整圈走(SlotZone 外面那层 FxBeam,fxModel BEAM.slotHover),
   这里只剩边框变实、变亮 —— 没有光的环境(极老的 WebView、减少动态效果)也看得出「悬在上面了」。 */
.ben-wb__slot-body[data-hover=true]{border-style:solid;border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 34%,transparent)}
.ben-wb__slot-hover-hint{position:absolute;inset:0;margin:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-state-business-primary);font-size:13px;font-weight:600;pointer-events:none}
/* 弹层让路占位(2026-09-14):窗位里的窗被 hide_app 让开后这块是空白,Ben 看着像坏了。
   同 hover-hint 一样 absolute 悬浮、不占文档流(槽体尺寸不变,ResizeObserver 不误触发);
   浅色小字——这不是故障,是让路,不用告警样式。 */
.ben-wb__slot-veiled{position:absolute;inset:0;margin:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:12px;pointer-events:none}
/* 场景条(spec W5/W6)：挂在窗口槽模块内、SlotZone 上方 */
.ben-wb__scenebar{display:flex;flex-direction:column;gap:6px;margin-bottom:8px;flex:none}
.ben-wb__scene-row{display:flex;align-items:center;gap:6px}
.ben-wb__scene-name{flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:4px 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__scene-name:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__scene-name-input{flex:1;min-width:0}
.ben-wb__scene-unsaved{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10px}
.ben-wb__scene-btn{flex:none;padding:4px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}
.ben-wb__scene-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__scene-btn:disabled{cursor:not-allowed;opacity:.4}
/* 一条布局都没存过时,窄栏菜单里那一句(2026-09-20 去预置场景;2026-09-21 改口:
   「存成新布局」删掉之后不再提"在这里保存",只说清单是空的)。灰色小字、不是错误样式。 */
.ben-wb__scene-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.ben-wb__scene-result{margin-top:2px;display:flex;flex-direction:column;gap:2px}
.ben-wb__scene-result p{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ben-wb__scene-result p.ben-wb__scene-result--bad{color:var(--dsw-alias-state-error-primary);font-weight:600}
.ben-wb__scroll{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}
.ben-wb__empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ben-wb__lines{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
/* ── 灯色 ── */
.ben-wb__lamp{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block}
.ben-wb__lamp--teal{background:var(--dsw-alias-state-business-primary)}
.ben-wb__lamp--amber{background:var(--dsw-alias-state-warn-label)}
.ben-wb__lamp--red{background:var(--dsw-alias-state-error-primary)}
.ben-wb__lamp--blue{background:var(--dsw-alias-state-business-primary)}
.ben-wb__lamp--off{background:var(--dsw-alias-border-l2)}
/* ── 项目区：算/状态/零散/DDL 四层（v5 spec D1–D4） ── */
.ben-wb__pj{position:relative;display:flex;flex-direction:column;gap:5px;padding:9px 11px 9px 13px;border:1px solid transparent;border-bottom-color:var(--dsw-alias-border-l1);border-left:2px solid var(--dsw-alias-border-l2);border-radius:0;background:transparent;flex:none}
.ben-wb__pj[data-tone=hot]{border-left-color:var(--dsw-alias-state-business-primary)}
.ben-wb__pj[data-tone=warn]{border-left-color:var(--dsw-alias-state-warn-label)}
.ben-wb__pj[data-tone=cold]{border-left-color:var(--dsw-alias-border-l2)}
.ben-wb__pj-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:7px;width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ben-wb__pj-name{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ben-wb__pj-stage{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10px}
.ben-wb__pj-activity{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px}
.ben-wb__pj-risk{padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ben-wb__pj-risk[data-risk=tight]{background:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-bg-layer-1)}
.ben-wb__pj-risk[data-risk=late]{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-1)}
.ben-wb__pj-calc{margin:0;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ben-wb__pj-calc--error{display:inline-block;padding:1px 6px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:4px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-weight:600}
.ben-wb .ben-wb__pj-status{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;width:100%;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;font-size:13px;line-height:1.5;overflow-wrap:anywhere;cursor:pointer}
.ben-wb .ben-wb__pj-status--stale{color:var(--dsw-alias-state-warn-label)}
.ben-wb__pj-status-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ben-wb__pj-status-edit{display:flex;gap:6px;align-items:center}
.ben-wb__pj-status-edit .ben-wb__inp{flex:1;min-width:0}
.ben-wb__pj-confirm{flex:none;height:24px;padding:0 10px;border:1px solid transparent;border-radius:6px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:11.5px;cursor:pointer}
.ben-wb__pj-confirm:hover{background:var(--dsw-alias-button-primary-hover)}
.ben-wb__pj-extra{display:flex;flex-direction:column;gap:2px;margin-top:2px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.ben-wb__pj-extra p{margin:0}
.ben-wb__pj-scanerr{margin:0;padding:6px 9px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11.5px}
.ben-wb__pj-pending{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
/* ── 会话区：按 agent 分组 ── */
.ben-wb__grp{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;flex:none}
.ben-wb__ghead{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.08em}
.ben-wb__gname{color:var(--dsw-alias-label-primary);font-weight:600}
.ben-wb__gct{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.ben-wb__gbody{padding:8px 10px;display:flex;flex-direction:column;gap:8px}
.ben-wb__sess{display:flex;gap:9px;align-items:flex-start;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:0;font:inherit}
.ben-wb__sess--clickable{cursor:pointer;border-radius:6px}
.ben-wb__sess--clickable:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__sess-bd{min-width:0;flex:1;display:flex;flex-direction:column}
.ben-wb__sess-h{font-size:13.5px;line-height:1.35;color:var(--dsw-alias-label-primary)}
.ben-wb__sess-m{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.ben-wb__sess-n{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin-top:2px}
.ben-wb__sess-q{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l1);line-height:1.45}
/* 「等你确认」用错误色底强调；「刚完成」用业务色底标未读 */
.ben-wb__sess--wait{margin:0 -10px;padding:8px 10px;background:var(--dsw-alias-interactive-bg-hover-danger)}
.ben-wb__sess--wait .ben-wb__sess-h{font-size:15px;font-weight:600}
.ben-wb__sess--fresh{margin:0 -10px;padding:8px 10px;background:var(--dsw-alias-state-business-tertiary)}
/* C1：Agent 掉线要明示，但语气是陈述不是告警 */
.ben-wb__offline{margin:0;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;flex:none}
.ben-wb__notes{margin:8px 0 0;padding-left:16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;overflow-wrap:anywhere}
/* 单条随手记(2026-08-25 落盘后可删单条):文字与 ✕ 分列两端,✕ 常显但退到三级色,
   悬停才变红——它是低频动作,不该在一列笔记里抢注意力。 */
.ben-wb__notes li{display:flex;align-items:baseline;gap:6px;justify-content:space-between}
.ben-wb__notes li button{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:10px;flex:none;padding:0 2px}
.ben-wb__notes li button:hover{color:var(--dsw-alias-state-error-primary)}
/* 仅项目状态与随手记输入，避免影响浮窗、设置或原生窗槽里的控件。 */
.ben-wb__pj-status-edit .ben-wb__inp,.ben-wb__inp[aria-label="随手记一句"]{width:100%;min-width:0;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4;transition:border-color .12s ease,background-color .12s ease}
.ben-wb__pj-status-edit .ben-wb__inp::placeholder,.ben-wb__inp[aria-label="随手记一句"]::placeholder{color:var(--dsw-alias-label-tertiary)}
.ben-wb__pj-status-edit .ben-wb__inp:focus-visible,.ben-wb__inp[aria-label="随手记一句"]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-color:var(--dsw-alias-state-business-primary)}
@media (prefers-reduced-motion: reduce){.ben-wb .ben-wb__usage-segbtn,.ben-wb__usage-rankfill,.ben-wb__dock-tab,.ben-wb__pj-status-edit .ben-wb__inp,.ben-wb__inp[aria-label="随手记一句"]{transition:none}}
/* ── 底部条 ── */
/* z-index:30(2026-09-14 弹层盖住窗位):sticky 元素自成层叠上下文,日结弹层的 z-index:30 只在
   底部条内部算数——弹层改成盖到窗位矩形上之后,会被槽体里 z-index:2 的 dock-note / 事务官档
   压住。把底部条本身抬到 30(弹层原本想要的层级),仍低于浮窗 40 / 设置遮罩 40 / 任务卡遮罩 60。 */
.ben-wb__footbar{position:sticky;bottom:0;z-index:30;display:flex;align-items:center;gap:14px;margin-top:11px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.ben-wb__footbar .ben-wb__lock{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:3px;padding:2px 9px}
/* 日结条(PRD 5.7):摘要按钮融进底部条,弹层贴着它向上开、限高自滚动(上方是槽位的
   原生窗口区,弹层压过去会被真窗盖住——徽章气泡同款处境,所以宁矮勿高)。 */
.ben-wb__usage-hint{margin:6px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ben-wb__daily{position:relative;display:inline-flex}
.ben-wb__daily-toggle{border:none;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}
.ben-wb__daily-toggle:hover{color:var(--dsw-alias-label-primary)}
.ben-wb__daily-pop{position:absolute;bottom:calc(100% + 10px);left:0;width:400px;max-height:44vh;overflow-y:auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:30}
.ben-wb__daily-sec{margin-bottom:10px}
.ben-wb__daily-sec:last-child{margin-bottom:0}
.ben-wb__daily-sec-t{font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}
.ben-wb__daily-line{margin:0 0 3px;color:var(--dsw-alias-label-secondary)}
.ben-wb__cred{margin-top:8px}
/* 她从额度那一格点过来的那一行(2026-10-02,卡 QK):点亮一下,她不必在三四行里再找一遍。
   只是一道边 —— 不是报错,也不替她填任何东西。 */
.ben-wb__cred[data-focus=true]{border-radius:9px;box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary);padding:6px}
.ben-wb__cred-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
.ben-wb__cred-name{font-size:12.5px;font-weight:600}
.ben-wb__cred-state{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10px}
.ben-wb__cred-state--on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.ben-wb__cred-row{display:flex;gap:6px}
.ben-wb__cred-row .ben-wb__inp{flex:1;min-width:0}
.ben-wb__cred-save{flex:none;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.ben-wb__cred-save:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__cred-save:disabled{cursor:not-allowed;opacity:.5}
.ben-wb__cred-msg{margin:8px 0 0;color:var(--dsw-alias-state-business-primary);font-size:11.5px}
.ben-wb__cred-hint{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.4}
/* ── 手机与设备:二维码大、居中在上,6 位码小字兜底在下(2026-09-16 扫码为主) ── */
.ben-wb__devices-pair{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:10px;text-align:center}
.ben-wb__devices-scan{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ben-wb__devices-code{flex:none}
.ben-wb__devices-digits{font-variant-numeric:tabular-nums;letter-spacing:2px;font-weight:600;color:var(--dsw-alias-label-secondary)}
/* ── 存储/性能(组件条两格，spec §3，终审 F2 补齐) ── */
.ben-wb__wgrow{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ben-wb__wg{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:7px 9px;min-width:0}
.ben-wb__wg-label{margin:0 0 2px;font-family:ui-monospace,Menlo,monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.ben-wb__wg-val{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ben-wb__wg-val--alert{color:var(--dsw-alias-state-error-primary)}
/* ── 日历入口(组件条里的一个格子) + 日历面板(借用窗口槽位置展开，spec D10) ── */
.ben-wb__cal-entry{display:flex;align-items:center;gap:7px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer}
.ben-wb__cal-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__cal-entry-icon{color:var(--dsw-alias-label-tertiary)}
/* flex:1;min-height:0;overflow-y:auto(模块盒子化):日历面板借用 slot 模块的位置展开,
   同样吃 .ben-wb__card--fill 分下来的固定高度——DDL 倒排列表长了在自己盒子里滚,
   不撑高整个模块。 */
.ben-wb__cal{display:flex;flex-direction:column;gap:9px;flex:1;min-height:0;overflow-y:auto}
.ben-wb__cal-head{display:flex;align-items:center;gap:8px}
.ben-wb__cal-head .ben-wb__ttl{margin:0}
.ben-wb__cal-collapse{margin-left:auto;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}
.ben-wb__cal-collapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.ben-wb__cal-wd{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:10px;padding:2px 0}
.ben-wb__cal-cell{display:flex;align-items:center;justify-content:center;height:24px;border-radius:5px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ben-wb__cal-cell[data-in-month=true]{color:var(--dsw-alias-label-primary)}
.ben-wb__cal-cell[data-today=true]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:700}
.ben-wb__cal-cell[data-ddl=true]{box-shadow:inset 0 -2px 0 var(--dsw-alias-state-warn-label)}
.ben-wb__cal-cell[data-system=true]{box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}
.ben-wb__cal-cell[data-ddl=true][data-system=true]{box-shadow:inset 0 -2px 0 var(--dsw-alias-state-warn-label),inset 2px 0 0 var(--dsw-alias-state-business-primary)}
.ben-wb__cal-list{display:flex;flex-direction:column;gap:5px}
.ben-wb__cal-ddl{margin:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:11.5px}
.ben-wb__cal-ddl-name{font-weight:600;color:var(--dsw-alias-label-primary)}
.ben-wb__cal-ddl-title{color:var(--dsw-alias-label-secondary)}
.ben-wb__cal-ddl-left{margin-left:auto;color:var(--dsw-alias-label-tertiary)}
.ben-wb__cal-ddl-now{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:10px}
.ben-wb__cal-error{margin:0;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px}
/* ── 事务官浮窗(spec D11，不可改清单第 1 条)：固定四角，不进 layout.modules ── */
.ben-wb__butler{position:fixed;z-index:70;display:flex;flex-direction:column;width:520px;height:680px;min-width:520px;min-height:680px;max-width:100vw;max-height:100vh;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 20px rgba(0,0,0,.25);overflow:hidden}
.ben-wb__butler[data-corner=br]{right:16px;bottom:16px}
.ben-wb__butler[data-corner=bl]{left:16px;bottom:16px}
/* 横屏默认落点(2026-09-18 决策记录「横屏事务官浮窗默认落点」):抬到**底部四格之上**。
   默认的 br 角在横屏上正好压住最后那一格(图谱)的右半边——Ben 截图里看到的就是它。
   --ben-wb-land-butler-bottom 由 Workbench.tsx 量底部那一排的上沿算出来(量不到时这条
   var 不设,fallback 回原来的 16px,不猜)。
   **只在没拖过的时候生效**:用户拖过一次之后 Butler.tsx 会写行内 bottom:auto 加 top,
   行内样式天然压过这里——"用户拖过就记用户的"这条不需要额外代码。 */
.ben-wb[data-orientation=landscape] .ben-wb__butler[data-corner=br],
.ben-wb[data-orientation=landscape] .ben-wb__butler[data-corner=bl]{bottom:var(--ben-wb-land-butler-bottom,16px)}
.ben-wb__butler[data-corner=tr]{right:16px;top:16px}
.ben-wb__butler[data-corner=tl]{left:16px;top:16px}
.ben-wb__butler[data-paused=true]{border-color:var(--dsw-alias-state-error-primary)}
.ben-wb__butler-head{display:flex;align-items:center;gap:7px;width:100%;padding:8px 11px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;text-align:left;flex:0 0 auto}
.ben-wb__butler-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__butler-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);flex:none}
.ben-wb__butler[data-paused=true] .ben-wb__butler-dot{background:var(--dsw-alias-state-error-primary)}
/* 修复轮 1(Critical,评审真实浏览器截图确认):min-height:0 是让这个 flex 列在空间
   不够时"真的能缩"的关键——没有它,flex 子项的最小高度默认等于自身内容高度,浮窗被拉到
   /读到很小的尺寸时,外层 .ben-wb__butler 的 overflow:hidden 只会把整体从底部裁掉,
   裁掉的往往正是最后一个子项——按钮行。 */
.ben-wb__butler-body{display:flex;flex-direction:column;gap:7px;padding:0 11px 11px;min-height:0;overflow:hidden}
/* "话"的容器:该缩该滚的是这一层,不是按钮行。flex:1 1 auto 占掉 body 里除按钮行之外的
   剩余空间,min-height:0 允许它缩到 0,超出部分 overflow-y:auto 卷起来——headline 变长、
   将来再加一行提示,都是这层自己吸收,不会把 .ben-wb__butler-acts 往下顶出可视区。 */
.ben-wb__butler-text{flex:1 1 auto;min-height:0;overflow-y:auto}
.ben-wb__butler-line{margin:0;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.4}
.ben-wb__butler-paused{margin:0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.4}
/* flex:0 0 auto——不可改清单第 1 条的 CSS 落地:这一行是叫停入口,永不参与收缩,
   空间不够时该让步的是上面 .ben-wb__butler-text,不是它。jsdom 测试里有一条断言锁住
   这条规则的存在(见 tests/client-butler-view.test.tsx),但那条断言只能证明规则在
   样式表字符串里,证不明真实渲染时按钮可见——可见性已用真实浏览器验证过,见 task-5-report.md。 */
.ben-wb__butler-acts{display:flex;gap:7px;flex-wrap:wrap;flex:0 0 auto}
.ben-wb__butler[data-narrow=true] .ben-wb__butler-body{padding:0 11px 9px}
.ben-wb__butler-pause{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}
.ben-wb__butler-pause:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 「现在跑一遍」在跑时这颗键灰着(2026-10-13):按下去没反应比灰着更难懂。 */
.ben-wb__butler-pause:disabled{cursor:default;opacity:.55}
.ben-wb__butler-pause:disabled:hover{background:transparent;color:var(--dsw-alias-label-secondary)}
.ben-wb__butler[data-narrow=true]{width:96px;height:96px;min-width:96px;min-height:96px;border:0;background:transparent;box-shadow:none;overflow:visible}
.ben-wb__butler-ball-btn{position:relative;width:96px;height:96px;padding:0;border:0;background:transparent;cursor:pointer;display:grid;place-items:center}
.ben-wb__butler-ball-btn:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px;border-radius:50%}
/* 球里那颗 ParticleOrb(10-22 统筹第三轮):样式真源是 PARTICLE_STYLE(particleStyle.ts),它那一条
   .ben-wb__particle-orb 的高度按窗口槽里的舞台算(clamp(110px,100cqh-150px,380px)),浮窗球这一格
   没有那么大的舞台——只改尺寸为球的直径 96,其余(画布填满、穿透点击)照真源,不另写一份粒子球样式。 */
.ben-wb__butler-ball-btn .ben-wb__particle-orb{width:96px;height:96px;max-width:none}
/* 收起的球带的状态(2026-10-27,合并稿 5.1):等你角标、两颗小点(回复 / 刚办完)、悬停卡;暂停变暗。
   z-index 70:悬浮球是事务官唯一的入口,要压过协作区全屏(58),模态确认(60 起的遮罩)仍可盖住它。 */
.ben-wb__butler-ball-btn[data-paused=true]{filter:grayscale(1) brightness(.6)}
.ben-wb__butler-ball-btn[data-stale=true]{filter:grayscale(1) brightness(.75)}
.ben-wb__butler-badge{position:absolute;top:8px;right:4px;min-width:22px;height:22px;padding:0 6px;border:1px solid var(--dsw-alias-bg-base);border-radius:11px;background:var(--dsw-alias-state-warning-primary,#e3b45c);color:#1b1406;font:700 12px/20px var(--wb-font,Inter,sans-serif);cursor:pointer;z-index:2}
.ben-wb__butler-dots{position:absolute;top:15px;right:34px;display:flex;gap:3px;z-index:2;pointer-events:none}
.ben-wb__butler-dots i{width:8px;height:8px;border-radius:50%;border:1px solid var(--dsw-alias-bg-base);background:var(--dsw-alias-label-primary)}
.ben-wb__butler-dots i[data-fresh=true]{background:var(--dsw-alias-label-secondary)}
.ben-wb__butler-hover{position:absolute;right:104px;bottom:0;width:280px;display:none;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 35px #0005;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.ben-wb__butler-hover b{color:var(--dsw-alias-label-primary);font-weight:600}
.ben-wb__butler-hover ul{margin:2px 0 0;padding-left:16px}
.ben-wb__butler-hover small{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ben-wb__butler-hover-warn{color:var(--dsw-alias-state-warning-primary,#e3b45c)}
.ben-wb__butler-ball-wrap:hover .ben-wb__butler-hover,.ben-wb__butler-ball-wrap:focus-within .ben-wb__butler-hover{display:flex}
.ben-wb__butler[data-corner=bl] .ben-wb__butler-hover,.ben-wb__butler[data-corner=tl] .ben-wb__butler-hover{right:auto;left:104px}
.ben-wb__butler-stop-popover{position:absolute;bottom:calc(100% + 8px);right:0;display:flex;gap:6px;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:50;white-space:nowrap}
.ben-wb__butler[data-corner=tr] .ben-wb__butler-stop-popover,.ben-wb__butler[data-corner=tl] .ben-wb__butler-stop-popover{bottom:auto;top:calc(100% + 8px)}
.ben-wb__butler[data-corner=bl] .ben-wb__butler-stop-popover,.ben-wb__butler[data-corner=tl] .ben-wb__butler-stop-popover{right:auto;left:0}
.ben-wb__butler-head-bar{display:flex;align-items:center;width:100%;flex:0 0 auto}
.ben-wb__butler-head-bar .ben-wb__butler-head{flex:1 1 auto;width:auto}
.ben-wb__butler-collapse{margin-left:auto;margin-right:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;padding:3px 6px;border-radius:4px;cursor:pointer}
/* 展开态身里那一页(10-22 第三轮,窗口槽里的 ButlerInbox 原样进来):那一页的根 .ben-wb__items
   是 position:absolute inset:0(为窗口槽写的),这里给它的直接包裹一个相对定位的 flex 格,
   它才能把浮窗里分到的整格填满;样式本身全是事务官页自己的(PARTICLE_STYLE 等),这一格不
   设任何字体/颜色/间距——维护者要的是「同一页自适应进来」,不是另一套样式。 */
.ben-wb__butler-page{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.ben-wb__butler-collapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__butler-runnow{display:flex;flex-direction:column;gap:5px}
.ben-wb__butler-grip{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,var(--dsw-alias-border-l2) 50%)}
/* ── 今晨快报进事务官浮窗(W4):是"话"的一部分,跟 .ben-wb__butler-text 一起被压缩/滚动,
   绝不把 .ben-wb__butler-acts 往下顶出可视区。
   终审顺带的 Minor(承自 Task 7 留档):列表原来自己带一条 overflow-y:auto——那是**死规则**,
   它的父 .ben-wb__butler-brief 没有任何高度约束,列表因此永远不会溢出自己的父,滚动条
   一次也不会出现;真正在裁切/滚动的是外层 .ben-wb__butler-text(flex:1 1 auto +
   min-height:0 + overflow-y:auto,见上面修复轮 1 那段)。留着只会让后人以为快报列表
   会自己滚,已删。 ── */
.ben-wb__butler-brief{display:flex;flex-direction:column;gap:5px;min-height:0}
.ben-wb__butler-brief-head{display:flex;align-items:center;justify-content:space-between;gap:7px}
.ben-wb__butler-brief-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;padding:2px 4px}
.ben-wb__butler-brief-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px;min-height:0}
.ben-wb__butler-brief-list li{display:flex;flex-direction:column;gap:1px}
.ben-wb__butler-brief-list a{color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1.35;text-decoration:none}
.ben-wb__butler-brief-list a:hover{text-decoration:underline}
.ben-wb__butler-brief-src{color:var(--dsw-alias-label-secondary);font-size:10px}
/* ── 「在盯着的事」(2026-09-09 哨兵):跟快报一样长在 .ben-wb__butler-text 这层里,
   空间不够时跟话一起被滚动/裁掉,绝不去挤 .ben-wb__butler-acts 那永不收缩的一行。 */
.ben-wb__butler-sentinel{display:flex;flex-direction:column;gap:5px;min-height:0}
.ben-wb__butler-sentinel-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;min-height:0}
.ben-wb__butler-sentinel-list li{display:flex;flex-direction:column;gap:1px}
.ben-wb__butler-sentinel-list li[data-done=true]{opacity:.55}
.ben-wb__butler-sentinel-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.ben-wb__butler-sentinel-note{color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1.35}
.ben-wb__butler-sentinel-target{color:var(--dsw-alias-label-tertiary);font-size:10px;word-break:break-all}
.ben-wb__butler-sentinel-change{color:var(--dsw-alias-label-secondary);font-size:10.5px}
/* ── 浮窗的对话入口(W4):放在 .ben-wb__butler-text 流里(不在 .ben-wb__butler-acts),
   跟"话"一起被压缩/滚动,不挤占永不收缩的按钮行——理由同上面 brief 那条注释 ── */
.ben-wb__butler-ask{display:flex;flex-direction:column;gap:4px}
.ben-wb__butler-ask-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:10.5px}
/* ── 事务官标签那一档:事项收件箱(2026-09-10,替换了原来内嵌 DSH 对话页的 iframe) ── */
/* 收件箱与「回到窗位落点」提示都是**盖在槽体上的浮层**(2026-08-26 真机事故后改):
   槽体必须一直挂载着才量得到矩形,而矩形是 dock.ts switchTo 的必要条件——原来"事务官在台前
   就不渲染槽体"留下了一条一开机就钉死的路。stack 是这层浮动的定位上下文。 */
.ben-wb__slot-stack{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.ben-wb__slot-note--over{position:absolute;left:0;right:0;top:0;z-index:3;margin:0}
/* 窗口槽空着时那一句(2026-10-27,事务官页不再挂在窗口槽里):居中一句话 + 两颗键。 */
.ben-wb__slot-empty{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;pointer-events:none}
.ben-wb__slot-empty p{margin:0;max-width:420px;line-height:1.6}
.ben-wb__slot-empty-acts{display:flex;gap:8px;pointer-events:auto}

/* 收件箱本体:上中下三段,只有中间那段滚动——汇报条与输入框任何时候都得看得见/够得着。 */
.ben-wb__items{position:absolute;inset:0;z-index:2;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px;min-height:0;padding:8px}
.ben-wb__items-report{margin:0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}
.ben-wb__items-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
.ben-wb__items-head{margin:6px 0 2px;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
.ben-wb__items-sub{margin:2px 0;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__items-empty{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__items-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px}
.ben-wb__items-row{margin:0;display:flex;align-items:center;gap:4px}
.ben-wb__items-confirm{flex:0 0 auto;padding:5px 8px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:6px;background:var(--dsw-alias-state-business-primary);color:#fff;font-size:11px;cursor:pointer}
/* 能点的与不能点的长得一样,差别只在光标与 hover——"点了没反应"要在按下之前就看得出来。 */
.ben-wb__items-open,.ben-wb__items-static{display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}
.ben-wb__items-open{cursor:pointer}
.ben-wb__items-open:hover{border-color:var(--dsw-alias-state-business-primary)}
.ben-wb__items-static{cursor:default}
.ben-wb__items-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__items-chip{flex:0 0 auto;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10px}
.ben-wb__items-chip[data-status=confirm],.ben-wb__items-chip[data-wait=approval]{background:var(--dsw-alias-state-business-primary);color:#fff}
.ben-wb__items-note{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.ben-wb__items-receipt{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ben-wb__items-form{display:flex;gap:6px;align-items:center}
.ben-wb__items-input{flex:1 1 auto;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}
.ben-wb__items-mic,.ben-wb__items-send{flex:0 0 auto;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;cursor:pointer}
/* 禁用态明显灰掉:语音那条通路还没做,按钮得一眼看出来点不动。 */
.ben-wb__items-mic:disabled,.ben-wb__items-send:disabled{opacity:.45;cursor:not-allowed}

/* ── 事务官档改版(2026-09-11,Ben:「留中间一个圆球,事项在旁边堆几个卡片」)── */
/* hidden 属性必须赢过各处的 display:flex(header/body/footbar/浮窗都是 flex 容器,UA 的
   [hidden]{display:none} 特异度低,会被类规则盖掉——纯净模式靠这一条把它们真的藏起来)。 */
.ben-wb [hidden]{display:none!important}
.ben-wb__items-stage{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:12px;align-items:start;overflow:hidden}
.ben-wb__items-center{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:220px;max-width:360px;padding-top:6px;overflow-y:auto;max-height:100%}
.ben-wb__orb-row{display:flex;align-items:center;gap:6px}
.ben-wb__orb-drawer-btn{border:1px solid var(--dsw-alias-border-l1);border-radius:50%;width:22px;height:22px;padding:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1}
.ben-wb__orb-drawer-btn:hover,.ben-wb__orb-drawer-btn[aria-expanded=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ben-wb__orb-counts{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.ben-wb__orb-counts--large{font-size:14px;margin-top:18px}
/*
 * 球下那条回答与「刚办完」那几条(2026-10-04,卡 claude/answer-comes-to-her)。
 * 全用现成的令牌(--dsw-alias-*),一个写死的颜色都没有 —— 浅色 / 深色、黑紫那一层都跟着走。
 * 两处都不写死高度:长回答折成三行(line-clamp),折的是显示不是字(读屏与复制拿到整段)。
 * 这一段在模板字符串里,所以**不许出现反引号**(会把整份样式表截断;2026-10-04 栽过一次)。
 */
.ben-wb__orb-answer{display:block;width:100%;max-width:520px;margin:8px auto 0;padding:8px 12px;text-align:start;border:1px solid var(--dsw-alias-separator);border-radius:10px;background:var(--dsw-alias-fill-quaternary);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.ben-wb__orb-answer:hover{background:var(--dsw-alias-fill-tertiary)}
.ben-wb__orb-answer:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:-2px}
.ben-wb__orb-answer-ask{display:block;color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:2px}
.ben-wb__orb-answer-said{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere}
.ben-wb__orb-fresh{list-style:none;margin:8px auto 0;padding:0;width:100%;max-width:520px;font-size:12px;line-height:1.5}
.ben-wb__orb-fresh>li{display:flex;align-items:baseline;gap:8px;padding:2px 0}
.ben-wb__orb-fresh-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.ben-wb__orb-fresh-note{flex:none;max-width:40%;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ben-wb__orb-fresh-seen{flex:none;padding:1px 8px;border:1px solid var(--dsw-alias-separator);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.ben-wb__orb-fresh-seen:hover{background:var(--dsw-alias-fill-tertiary)}
/* 交代后的处理结果收成的那一行(2026-10-27):与「刚办完」同一套样子 —— 一句话、件数、两颗小键。 */
.ben-wb__say-line{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin:8px auto 0;padding:0;width:100%;max-width:520px;font-size:12px;line-height:1.5}
.ben-wb__say-line-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.ben-wb__say-line-count{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ben-wb__say-line>button{flex:none;padding:1px 8px;border:1px solid var(--dsw-alias-separator);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.ben-wb__say-line>button:hover{background:var(--dsw-alias-fill-tertiary)}
/* 汇报条压成一行,可点展开(展开 = 允许折行) */
.ben-wb__items-report{display:flex;align-items:center;gap:6px;max-width:100%}
.ben-wb__items-report-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__items-report[data-open=true] .ben-wb__items-report-text{white-space:normal}
.ben-wb__items-report-toggle{flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0 2px;font-size:11px}
/* 球旁的抽屉:浮窗搬家过来的那几样 */
.ben-wb__drawer{display:flex;flex-direction:column;gap:8px;width:100%;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
/* 两堆:纵向错落,新的在上,后面每张往右(下)错开几像素(行内 margin-left 由组件按序号算) */
.ben-wb__stack{display:flex;flex-direction:column;gap:4px;min-width:0;padding:4px}
.ben-wb__stack-head{margin:0 0 2px;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
.ben-wb__stack-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0}
.ben-wb__stack-list[data-all=true]{gap:3px}
.ben-wb__stackcard{position:relative;margin-top:-2px;display:flex;align-items:center;gap:4px;min-width:0}
.ben-wb__stackcard:first-child{margin-top:0}
.ben-wb__stackcard .ben-wb__items-open,.ben-wb__stackcard .ben-wb__items-static{box-shadow:0 1px 3px rgba(0,0,0,.18);background:var(--dsw-alias-bg-layer-2)}
.ben-wb__stackcard-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2)}
.ben-wb__stackcard-dot[data-dot=white]{background:#fff}
.ben-wb__stackcard-dot[data-dot=yellow]{background:#f3c74f;border-color:#f3c74f}
.ben-wb__stackcard-dot[data-dot=blue]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.ben-wb__stackcard-dot[data-dot=gray]{background:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-label-tertiary)}
.ben-wb__stackcard-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.ben-wb__stackcard-ctx{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__stackcard-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__stackcard-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.ben-wb__stackcard-time{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ben-wb__stack-more,.ben-wb__stack-less{align-self:flex-start;margin-top:2px;padding:4px 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}
.ben-wb__stack-more:hover,.ben-wb__stack-less:hover{color:var(--dsw-alias-label-primary);border-style:solid}
/* ── 声纹球:纯 CSS,没有图片。四态用形态区分(设计-事务官完整材料 §5.1) ── */
.ben-wb__orb{position:relative;display:grid;place-items:center;width:96px;height:96px;padding:0;border:0;border-radius:50%;background:transparent;cursor:default;--orb-color:var(--dsw-alias-state-business-primary);--orb-glow:rgba(59,130,246,.35)}
.ben-wb__orb[data-size=large]{width:220px;height:220px}
.ben-wb__orb[data-amber=true]{--orb-color:#e8a23a;--orb-glow:rgba(232,162,58,.45)}
.ben-wb__orb-core{position:absolute;inset:18%;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0,var(--orb-color) 55%,color-mix(in srgb,var(--orb-color) 60%,#000) 100%);box-shadow:0 0 24px var(--orb-glow);animation:ben-wb-orb-breathe 4.5s ease-in-out infinite}
.ben-wb__orb-ring{position:absolute;inset:0;border-radius:50%;border:2px solid var(--orb-color);opacity:.35;animation:none}
/* 聆听:外圈随输入起伏(没有收音,用节律代替声纹) */
.ben-wb__orb[data-state=listening] .ben-wb__orb-ring{animation:ben-wb-orb-listen 1.1s ease-in-out infinite;opacity:.7}
/* 在办:缓慢脉动 */
.ben-wb__orb[data-state=busy] .ben-wb__orb-core{animation:ben-wb-orb-pulse 2.2s ease-in-out infinite}
/* 需要你:琥珀 + 稍强的光 */
.ben-wb__orb[data-state=needs-you] .ben-wb__orb-core{box-shadow:0 0 36px var(--orb-glow)}
button.ben-wb__orb{cursor:pointer}
button.ben-wb__orb:hover .ben-wb__orb-ring{opacity:.8}
@keyframes ben-wb-orb-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
@keyframes ben-wb-orb-pulse{0%,100%{transform:scale(.96);box-shadow:0 0 18px var(--orb-glow)}50%{transform:scale(1.06);box-shadow:0 0 34px var(--orb-glow)}}
@keyframes ben-wb-orb-listen{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}
@media (prefers-reduced-motion: reduce){.ben-wb__orb *,.ben-wb__orb-core,.ben-wb__orb-ring{animation:none!important}}
/* ── 纯净模式:整屏只有一颗球 ── */
.ben-wb__pure{flex:1 1 auto;min-height:0;position:relative;display:flex}
.ben-wb__pure .ben-wb__items{position:relative;inset:auto;flex:1 1 auto}
.ben-wb__pure-stage{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0}
.ben-wb__items[data-pure=true][data-expanded=true]{background:transparent}
.ben-wb__items[data-pure=true][data-expanded=true] .ben-wb__items-stage,.ben-wb__items[data-pure=true][data-expanded=true] .ben-wb__items-form,.ben-wb__items[data-pure=true][data-expanded=true] .ben-wb__items-receipt{position:relative;z-index:2}
.ben-wb__pure-backdrop{position:absolute;inset:0;z-index:1;background:transparent}
.ben-wb__topquota{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ben-wb__toppure{margin-left:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:1px 8px;font-size:11.5px}
.ben-wb__toppure:hover,.ben-wb__toppure[data-pure=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}

/* 齿轮弹窗(2026-08-25 版面重排):凭据从组件条收进来之后的容器。
   类名用 setdlg 而不是 dlg:看板的功能点详情弹窗已经占了 .ben-wb__dlg 与
   .ben-wb__dlg-head,两者同名同特异度,合流后靠源码顺序定胜负——留着必有一个
   弹窗被对方的宽度/内距规则改花(合并时发现,两条线各自单测都是绿的)。 */
/* 弹窗贴着右上角的齿轮往下开,不在视口正中(2026-08-26 Ben 实机反馈)。工作台窗口是
   底座层,认领进窗位的是**真的原生窗口**,它盖在网页渲染表面之上——弹窗落在视口中央
   正好是应用区那块,整个被真窗挡住,CSS z-index 对操作系统窗口无解。顶部那一条
   (项目区/消耗数据/余额)是画面上唯一不会被认领窗盖住的地方,弹窗就开在那里。
   高度封顶 + 内部滚动:那条带子本来就不高,内容长了让它自己卷,而不是往下长进应用区。 */
/* 弹层盖住窗位(2026-09-14,Ben:「要不就是它刚好覆盖窗口槽,这样就看着不像是坏了」):让路之后
   窗位那块是空白,弹层就落到那块矩形上把它填上。四处弹层(设置/任务卡/归档确认/日结)共用这一个
   修饰类:position:fixed + inline 的 left/top/width/height(useDialogCover 量窗位矩形给的),
   各自原来的 max-height/width/bottom 全放开,内容在弹层自己的滚动区里卷。z-index 不动,
   沿用各自遮罩/条的层级。量不到矩形时不挂这个类,一切照旧。 */
.ben-wb .ben-wb__dlg-cover{position:fixed;margin:0;max-width:none;max-height:none;bottom:auto;right:auto}
.ben-wb__setdlg-backdrop{position:fixed;inset:0;z-index:40;display:flex;align-items:flex-start;justify-content:flex-end;padding:52px 14px 0;background:rgba(0,0,0,.42)}
.ben-wb__setdlg{width:min(460px,92vw);max-height:min(46vh,380px);overflow:auto;display:flex;flex-direction:column;gap:11px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
/* ── 设置弹窗的分组(2026-09-28,卡 SG)。顶上一排,一次只看一组;
   选中那一颗填底 + 描边,别的是纯文字 —— 一排六颗一样重的按钮正是被抱怨的那件事。 */
.ben-wb__setnav{display:flex;flex-wrap:wrap;gap:3px;flex:none}
.ben-wb__setnav button{flex:none;padding:4px 9px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1.3;cursor:pointer}
.ben-wb__setnav button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__setnav button[aria-selected=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}
.ben-wb__setgrp{display:flex;flex-direction:column;gap:11px;min-width:0}
.ben-wb__setgrp-lead{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.45}
/* 这一组一节都没接上时才现身。:has 是 Chromium 早就有的,壳里就是 Chromium;
   量不到(老引擎 / jsdom)就一直藏着——宁可空一块,也不要凭空多一句话。 */
.ben-wb__setgrp-empty{display:none;margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.45}
.ben-wb__setgrp:not(:has(section)) .ben-wb__setgrp-empty{display:block}
/* 每一节最多一颗**主按钮**:填底、字大一号、在这一节里只此一颗。
   次要动作一律**文字链接**——这两样长得不一样,才看得出"这一节要我做的是哪件事"
   (维护者 2026-09-28:「你搞这几个按钮搞成这样,谁能理解啊」)。 */
.ben-wb__set-primary{flex:none;padding:5px 13px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:12px;line-height:1.3;cursor:pointer}
.ben-wb__set-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.ben-wb__set-primary:disabled{cursor:not-allowed;opacity:.45}
.ben-wb__set-lnk{flex:none;padding:0;border:0;background:none;color:var(--dsw-alias-state-business-primary);font-family:inherit;font-size:11.5px;line-height:1.4;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.ben-wb__set-lnk:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.ben-wb__set-lnk:disabled{cursor:not-allowed;opacity:.45;text-decoration:none}
/* 一屏之内一套字号一套间距:每一节都是「标题一行 + 一句人话 + 动作」。 */
.ben-wb__setdlg .ben-wb__card{padding:11px 13px}
.ben-wb__setdlg .ben-wb__card>h2,.ben-wb__setdlg .ben-wb__card>h3{margin:0 0 7px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ben-wb__setdlg .ben-wb__card>p:first-of-type{margin-top:0}

/* ── 哨兵新增表单(2026-09-09):设置弹窗里的第二块,行内两栏,窄了自己换行。 */
.ben-wb__sentinel{display:flex;flex-direction:column;gap:6px}
.ben-wb__sentinel-form{display:flex;flex-direction:column;gap:6px}
.ben-wb__sentinel-row{display:flex;gap:6px;flex-wrap:wrap}
.ben-wb__sentinel-row .ben-wb__inp{flex:1;min-width:120px}
.ben-wb__sentinel .ben-wb__cred-save,.ben-wb__sentinel .ben-wb__set-primary{align-self:flex-start;padding:4px 12px}
.ben-wb__setdlg-head{display:flex;align-items:center;justify-content:space-between}
.ben-wb__setdlg-head button{border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:1px 7px}

/* 图谱格(2026-10-23,卡「系统文件夹改成Graphify图谱」)。顶行:项目名(或多个项目时的
   select)+ 右侧「重建图谱」;下面吃掉剩余的是 graphify 的 graph.html(iframe)。
   白字灰线、不另加卡片框 —— 图谱自己是一份完整的深色页面。 */
.ben-wb__graph{flex:1;min-height:0;height:100%;display:flex;flex-direction:column;gap:6px}
.ben-wb__graph-tabs{flex:none;display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:4px}
.ben-wb .ben-wb__graph-tab{padding:2px 8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t4);cursor:pointer;border-radius:4px}
.ben-wb .ben-wb__graph-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb .ben-wb__graph-tab.is-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.ben-wb__graph-badge{padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px;font-family:monospace}
.ben-wb__graph-head{flex:none;display:flex;align-items:center;gap:8px;min-width:0}
.ben-wb__graph-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:var(--wb-t3);font-weight:600}
.ben-wb .ben-wb__graph-select{flex:1;min-width:0;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t4)}
.ben-wb .ben-wb__graph-expand{flex:none;padding:1px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t4);cursor:pointer}
.ben-wb .ben-wb__graph-expand:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__graph-rebuild{flex:none;margin-left:auto;padding:1px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t4);cursor:pointer}
.ben-wb .ben-wb__graph-rebuild:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__graph-rebuild:disabled{opacity:.55;cursor:default}
.ben-wb__graph-frame-wrap{flex:1 1 0;min-height:0;display:flex;flex-direction:column}
.ben-wb__graph-frame{flex:1 1 0;min-height:0;height:100%;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}
/* 太矮的图区:一句实话 + 一颗点开全屏的键(2026-10-26 视觉验收退回:细线图冒充可读不许再发生) */
.ben-wb .ben-wb__graph-collapsed{flex:1;min-height:0;width:100%;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;display:flex;align-items:center;justify-content:center;text-align:center;padding:8px 14px;font-size:var(--wb-t3)}
.ben-wb .ben-wb__graph-collapsed:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__graph-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t4)}
.ben-wb__graph-error{margin:0;padding:7px 10px;border-left:2px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary);font-size:11px;overflow-wrap:anywhere}
.ben-wb__graph-empty{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center}
.ben-wb .ben-wb__graph-install{padding:4px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.ben-wb .ben-wb__graph-install:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb .ben-wb__graph-install:disabled{opacity:.55;cursor:default}
.ben-wb__graph-modal{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:9000;padding:24px;box-sizing:border-box}
.ben-wb__graph-modal-content{width:96vw;height:92vh;max-width:1800px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6)}
.ben-wb__graph-modal-head{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.ben-wb__graph-modal-title{font-size:var(--wb-t2);font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.ben-wb .ben-wb__graph-modal-close{padding:3px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:var(--wb-t4)}
.ben-wb .ben-wb__graph-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__graph-modal-body{flex:1;min-height:0;height:100%;position:relative;display:flex}
.ben-wb__graph-modal-body iframe{flex:1 1 0;width:100%;height:100%;border:0}

/* 为什么下面这些按钮类都带 .ben-wb 祖先前缀:基础样式里有一条 .ben-wb button{font:inherit},
   特异度 (0,1,1) 压过单类选择器 (0,1,0),font 简写会把 font-size 一并重置回继承值——
   2026-08-25 实测踩过:字号表定好了,项目名/模块名/卡片标题三处全被打回 16px,
   页面看着"好像有层级"其实全靠字重撑。加个祖先前缀抬到 (0,2,0) 才真的生效。 */
/* ── 任务看板 ────────────────────────────────────────────────────────────
   排版尺度(2026-08-25 Ben:"可视化不够,不是颜色的丰富度,而是字号和各区域的大小")。
   在此之前整块看板 47 处字号里有 45 处挤在 9.5–11.5px 之间——什么都一样大就等于
   什么都不重要,一屏扫过去找不到落点。这里定死五档,所有规则只准从这五个变量取值:

     --wb-t1 15px  项目名(第一层,最大)
     --wb-t2 13.5px 冲刺目标 / 模块名(第二、三层的主标题)
     --wb-t3 12.5px 状态列头 / 卡片标题(看得最多的一档)
     --wb-t4 11px   元信息:负责人、剩余天数、版本徽章、进度数字
     --wb-t5 10px   最次要:来源小标、括号里的说明

   区域尺度同理:--wb-head 是泳道头/行头那一列的宽度,--wb-gap 是格子间距。
   区域之间的呼吸感靠这两个值统一放大,而不是每处各拍一个数。 */
.ben-wb{--wb-t1:15px;--wb-t2:13.5px;--wb-t3:12.5px;--wb-t4:11px;--wb-t5:10px}
.ben-wb__board{--wb-head:200px;--wb-gap:8px;flex:1;min-height:0;display:flex;flex-direction:column;gap:12px}
.ben-wb__viewswitch{display:flex;gap:0;margin:0 0 10px;flex:none}
.ben-wb__viewswitch button{padding:5px 14px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t3);cursor:pointer}
.ben-wb__viewswitch button:first-child{border-radius:8px 0 0 8px}
.ben-wb__viewswitch button:last-child{border-radius:0 8px 8px 0;border-left:0}
.ben-wb__viewswitch button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__viewswitch button[data-on=true]{background:var(--dsw-alias-state-business-tertiary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font-weight:600}

/* 一根细进度条(冲刺完成度 / 时间进度 / 模块完成度共用) */
.ben-wb__meter{display:inline-flex;align-items:center;gap:6px;min-width:0}
.ben-wb__meter-track{flex:none;width:64px;height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.ben-wb__meter-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary)}
.ben-wb__meter[data-tone=time] .ben-wb__meter-fill{background:var(--dsw-alias-label-tertiary)}
.ben-wb__meter-label{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t4);font-family:ui-monospace,Menlo,monospace;white-space:nowrap}

/* 优先级色块与 agent 徽章:一套颜色,卡片/标签/弹窗共用 */
.ben-wb__task-prio{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.ben-wb__task-prio[data-priority=high]{background:var(--dsw-alias-state-error-primary)}
.ben-wb__task-prio[data-priority=mid]{background:var(--dsw-alias-state-warn-label)}
.ben-wb__task-prio[data-priority=low]{background:var(--dsw-alias-state-business-primary)}
.ben-wb__task-who{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--wb-t4);white-space:nowrap}
.ben-wb__task-who[data-agent=dsh]{background:#2b3a4d;color:#8ab4f8}
.ben-wb__task-who[data-agent=claude]{background:#4a3324;color:#e8a87c}
.ben-wb__task-who[data-agent=codex]{background:#25402f;color:#7fd1a0}
.ben-wb__task-who[data-agent=kimi]{background:#3b2b4d;color:#c9a0f0}
/* 派活小标(2026-09-21)。底色跟「负责人」那颗徽章拉开:这不是"归谁管",是"此刻在谁手上跑"。
   失败那一档用红边标出来 —— 一屏扫过去要跳得出来(同 data-status 的路子)。 */
.ben-wb__task-dispatch{padding:1px 7px;border-radius:999px;border:1px solid transparent;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--wb-t4);white-space:nowrap}
.ben-wb__task-dispatch[data-state=running]{border-color:#5b7fa8;color:#8ab4f8}
.ben-wb__task-dispatch[data-state=done]{border-color:#3f6b50;color:#7fd1a0}
.ben-wb__task-dispatch[data-state=failed]{border-color:#8a4040;color:#e88a8a}
.ben-wb__task-dispatch-stop{padding:1px 7px;border-radius:999px;border:1px solid #8a4040;background:transparent;color:#e88a8a;font-size:var(--wb-t4);white-space:nowrap;cursor:pointer}

/* 第一层:项目标签。整块看板里最大的字,一屏扫过去先看到的就是它 */
.ben-wb__ptabs{display:flex;flex-wrap:wrap;gap:7px;flex:none;padding-bottom:9px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ben-wb .ben-wb__ptab{position:relative;display:flex;align-items:center;gap:9px;max-width:340px;padding:9px 14px 9px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t1);cursor:pointer;overflow:hidden}
.ben-wb .ben-wb__ptab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__ptab[data-on=true]{background:var(--dsw-alias-state-business-tertiary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.ben-wb__ptab-bar{position:absolute;left:0;top:0;bottom:0;width:4px;background:transparent}
.ben-wb__ptab-bar[data-priority=high]{background:var(--dsw-alias-state-error-primary)}
.ben-wb__ptab-bar[data-priority=mid]{background:var(--dsw-alias-state-warn-label)}
.ben-wb__ptab-bar[data-priority=low]{background:var(--dsw-alias-state-business-primary)}
.ben-wb__ptab-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 标签里的附属信息压到 t4:它们是给这个名字做注脚的,不该跟名字抢 */
.ben-wb__ptab .ben-wb__task-who,.ben-wb__ptab .ben-wb__task-due,.ben-wb__ptab .ben-wb__board-count{font-size:var(--wb-t4)}

/* 项目那一层的优先级 / 负责人 / 预期结束 */
.ben-wb__pmeta{display:flex;flex-wrap:wrap;align-items:center;gap:18px;flex:none;font-size:var(--wb-t4);color:var(--dsw-alias-label-secondary)}
.ben-wb__pmeta-item{display:flex;align-items:center;gap:8px}
.ben-wb__pmeta-tag{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__pmeta-due{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:var(--wb-t4)}
.ben-wb__pmeta-due[data-tight=true]{color:var(--dsw-alias-state-warn-label)}
.ben-wb__pmeta-due code{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__chips{display:flex;gap:4px}
.ben-wb .ben-wb__chip{padding:4px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--wb-t4);cursor:pointer;white-space:nowrap}
.ben-wb .ben-wb__chip:hover{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-secondary)}
.ben-wb .ben-wb__chip[data-on=true]{color:var(--dsw-alias-bg-base);font-weight:650}
.ben-wb .ben-wb__chip[data-priority=high][data-on=true]{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ben-wb .ben-wb__chip[data-priority=mid][data-on=true]{background:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}
.ben-wb .ben-wb__chip[data-priority=low][data-on=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.ben-wb .ben-wb__chip[data-agent=dsh][data-on=true]{background:#8ab4f8;border-color:#8ab4f8}
.ben-wb .ben-wb__chip[data-agent=claude][data-on=true]{background:#e8a87c;border-color:#e8a87c}
.ben-wb .ben-wb__chip[data-agent=codex][data-on=true]{background:#7fd1a0;border-color:#7fd1a0}
.ben-wb .ben-wb__chip[data-agent=kimi][data-on=true]{background:#c9a0f0;border-color:#c9a0f0}

/* 横排 / 竖排开关 */
.ben-wb__axis{display:flex;gap:0}
.ben-wb__axis button{padding:4px 11px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--wb-t4);cursor:pointer}
.ben-wb__axis button:first-child{border-radius:7px 0 0 7px}
.ben-wb__axis button:last-child{border-radius:0 7px 7px 0}
/* 三段式(横排/竖排/按状态):中间那些只去左边框,免得相邻两条描边叠成一条粗线 */
.ben-wb__axis button:not(:first-child){border-left:0}
.ben-wb__axis button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__axis button[data-on=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}

/* 第二层:冲刺条 */
.ben-wb__sprint{display:flex;flex-direction:column;gap:8px;flex:none;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__sprint-tabs{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.ben-wb__sprint-tabs button{padding:4px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t3);cursor:pointer}
.ben-wb__sprint-tabs button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__sprint-tabs button[data-on=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.ben-wb__sprint-tabs input{padding:4px 11px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t3)}
.ben-wb__sprint-add{color:var(--dsw-alias-label-tertiary)!important}
.ben-wb__sprint-head{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:var(--wb-t2)}
.ben-wb__sprint-goal,.ben-wb__sprint-vers{display:flex;align-items:center;gap:7px;min-width:0;color:var(--dsw-alias-label-primary)}
/* 冲刺目标是这一层的主句子,给它 t2 与正常字重;旁边的标签压到 t5 */
.ben-wb__sprint-goal>span:last-child{font-size:var(--wb-t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:460px}
.ben-wb__sprint-tag{padding:2px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5);flex:none}
.ben-wb__sprint-ver{padding:2px 8px;border-radius:5px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:var(--wb-t4);font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
.ben-wb__sprint-blank{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5);font-style:normal}
.ben-wb__sprint-when{display:flex;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t4)}
.ben-wb__sprint-risk,.ben-wb__ptab-risk{padding:1px 8px;border-radius:999px;font-size:var(--wb-t4);font-weight:600;white-space:nowrap;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.ben-wb__sprint-risk[data-risk=tight],.ben-wb__ptab-risk[data-risk=tight]{background:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-bg-layer-1)}
.ben-wb__sprint-risk[data-risk=late],.ben-wb__ptab-risk[data-risk=late]{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-1)}
.ben-wb__sprint-attn{display:inline-flex;align-items:center;gap:6px}
.ben-wb__sprint-attn-item{padding:1px 8px;border-radius:999px;font-size:var(--wb-t4);font-weight:600;white-space:nowrap}
.ben-wb__sprint-attn-item[data-status=confirm]{background:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-bg-layer-1)}
.ben-wb__sprint-attn-item[data-status=blocked]{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-1)}
.ben-wb__sprint-prog{margin-left:auto}
.ben-wb .ben-wb__sprint-edit{padding:4px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t4);cursor:pointer}
.ben-wb__sprint-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t3)}
.ben-wb__sprint-editor{display:flex;flex-direction:column;gap:7px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.ben-wb__sprint-editor label{display:flex;align-items:flex-start;gap:8px;font-size:var(--wb-t4);color:var(--dsw-alias-label-secondary)}
.ben-wb__sprint-editor label>span{flex:none;width:60px;padding-top:4px}
.ben-wb__sprint-editor input[type=text],.ben-wb__sprint-editor textarea{flex:1;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t3);resize:vertical}
.ben-wb__sprint-when-edit{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:var(--wb-t4);color:var(--dsw-alias-label-secondary)}
.ben-wb__sprint-when-edit label{display:flex;align-items:center;gap:5px}
.ben-wb__sprint-when-edit input{padding:4px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t4)}

/* 第三、四层:模块 × 状态。两个方向共用同一批类,差别只在 grid 怎么摆 */
.ben-wb__board-scroll{flex:1;min-height:0;overflow:auto}
.ben-wb__board-head,.ben-wb__board-lane{display:grid;grid-template-columns:var(--wb-head) repeat(7,minmax(150px,1fr));gap:var(--wb-gap)}
/* 竖排:行头(状态名)窄得多,列数由内联样式给(随模块数变) */
.ben-wb__board-scroll[data-axis=module-columns]{--wb-head:104px}
/* 按状态:没有泳道头那一列,七列平分(列数由内联样式给);横向放不下就左右滚,
   七列各自不再压缩到读不清 */
.ben-wb__board-scroll[data-axis=status-columns]{--wb-head:0px}
.ben-wb__board-head{position:sticky;top:0;z-index:2;padding-bottom:7px;background:var(--dsw-alias-bg-layer-1)}
.ben-wb__board-colname{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t3);font-weight:650;letter-spacing:.02em}
/* 「等我确认」「阻塞」是唯二在等 Ben 动手的两列,列名与计数都提亮 */
.ben-wb__board-colname[data-attention=true]{color:var(--dsw-alias-state-warn-label)}
.ben-wb__board-colname[data-attention=true] .ben-wb__board-count{background:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-bg-layer-1)}
/* 取消列整列压暗:它在看板上是"留个底",不该跟主干几列抢注意力(但绝不隐藏) */
.ben-wb__board-colname[data-status=canceled]{color:var(--dsw-alias-label-tertiary)}
.ben-wb__board-count{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t4);font-weight:600}
.ben-wb__board-lane{margin-bottom:var(--wb-gap)}
.ben-wb__board-lanename{display:flex;flex-direction:column;gap:4px;padding:7px 4px 0;min-width:0}
/* 竖排时泳道头是列头,坐在最上面一行,不必留顶部内距 */
.ben-wb__board-lanename[data-axis=module-columns]{padding-top:0}
.ben-wb__lane-top{display:flex;align-items:center;gap:7px;min-width:0}
.ben-wb .ben-wb__lane-title{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t2);font-weight:600;line-height:1.3;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__lane-goal{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t4);line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ben-wb__lane-editor{display:flex;flex-direction:column;gap:5px;margin-top:5px}
.ben-wb__lane-editor input,.ben-wb__lane-editor textarea,.ben-wb__lane-editor select{width:100%;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t4);resize:vertical}
.ben-wb__lane-editor button{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;font-size:var(--wb-t4);cursor:pointer}
.ben-wb__lane-new{grid-column:1/-1;padding:4px 4px 10px}
.ben-wb__lane-new input{width:240px;padding:6px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t4)}
.ben-wb__lane-new input:focus{outline:0;border-style:solid;border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-2)}
.ben-wb__board-cell{display:flex;flex-direction:column;gap:6px;min-height:68px;padding:6px;border:1px dashed transparent;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__board-cell[data-over=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.ben-wb__board-cell[data-status=confirm]{background:var(--dsw-alias-state-warn-bg,var(--dsw-alias-bg-layer-2));box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-label)}
.ben-wb__board-cell[data-status=canceled]{opacity:.72}
.ben-wb .ben-wb__board-more{align-self:flex-start;padding:3px 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t4);cursor:pointer}
.ben-wb .ben-wb__board-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ben-wb__board-new input{width:100%;padding:5px 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t4)}
.ben-wb__board-new input:hover{border-color:var(--dsw-alias-border-l2)}
.ben-wb__board-new input:focus{outline:0;border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}

/* 「从会话转卡」 */
.ben-wb__board-bar{display:flex;align-items:center;gap:10px;position:relative;margin-left:auto}
.ben-wb .ben-wb__board-pick{padding:4px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t4);cursor:pointer}
.ben-wb .ben-wb__board-pick:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__board-picklist{position:absolute;z-index:5;top:30px;right:0;display:flex;flex-direction:column;gap:3px;max-height:220px;overflow-y:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 18px rgba(0,0,0,.25)}
.ben-wb__board-picklist button{padding:6px 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:var(--wb-t3);text-align:left;cursor:pointer;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.ben-wb__board-picklist button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__board-pickempty{padding:6px 10px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t3)}
.ben-wb__board-problem{margin:0 0 8px;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:6px;font-size:var(--wb-t3)}

/* 功能点卡片:只有卡面,编辑在弹窗里 */
.ben-wb__task{display:flex;flex-direction:column;gap:5px;padding:8px 10px 8px 12px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:grab}
.ben-wb__task:active{cursor:grabbing}
.ben-wb__task[data-priority=high]{border-left-color:var(--dsw-alias-state-error-primary)}
.ben-wb__task[data-priority=mid]{border-left-color:var(--dsw-alias-state-warn-label)}
.ben-wb__task[data-priority=low]{border-left-color:var(--dsw-alias-state-business-primary)}
/* 状态在卡面上也留一道痕:阻塞的卡描边变警示色,取消的压暗并划掉标题——
   整屏扫过去时这两种跳得出来,而且都只是"看起来不一样",没有任何一处会替他清理 */
.ben-wb__task[data-status=blocked]{border-color:var(--dsw-alias-state-warn-label)}
.ben-wb__task[data-status=canceled]{opacity:.6}
.ben-wb__task[data-status=canceled] .ben-wb__task-title{text-decoration:line-through}
.ben-wb .ben-wb__task-title{width:100%;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t3);line-height:1.45;text-align:left;cursor:pointer}
.ben-wb__task-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ben-wb__task-links{display:inline-flex;align-items:center;gap:4px}
.ben-wb__link-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.ben-wb__link-dot[data-status=waiting]{background:var(--dsw-alias-state-warn-label)}
.ben-wb__link-dot[data-status=running]{background:#7fd1a0}
.ben-wb__link-dot[data-status=done]{background:var(--dsw-alias-state-business-primary)}
.ben-wb__link-dot[data-status=error]{background:var(--dsw-alias-state-error-primary)}
.ben-wb__link-dot[data-status=gone],.ben-wb__link-dot[data-status=offline]{background:var(--dsw-alias-border-l2)}
.ben-wb__task-due{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t4);font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
.ben-wb__task-due[data-tight=true]{color:var(--dsw-alias-state-warn-label)}
.ben-wb__task-block{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-state-warn-bg,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-warn-label);font-size:var(--wb-t4);white-space:nowrap}
.ben-wb .ben-wb__chip[data-block][data-on=true]{background:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-bg-base)}
.ben-wb__task-src{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb .ben-wb__task-del{color:var(--dsw-alias-state-error-primary);padding:5px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;font-size:var(--wb-t3);cursor:pointer}
.ben-wb .ben-wb__task-del:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}

/* 功能点详情弹窗。弹窗里字号整体比看板大一档:这里是"停下来读/改"的场合,
   看板那边是"扫一眼"的场合,两者不该用同一个尺度。 */
.ben-wb__dlg-scrim{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(0,0,0,.55)}
.ben-wb__dlg{display:flex;flex-direction:column;width:min(620px,100%);max-height:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px rgba(0,0,0,.45);overflow:hidden}
.ben-wb__dlg-head{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ben-wb__dlg-where{color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.ben-wb .ben-wb__dlg-close{margin-left:auto;width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:15px;cursor:pointer}
.ben-wb .ben-wb__dlg-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__dlg-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:16px;padding:16px}
.ben-wb__dlg-title{width:100%;padding:7px 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:19px;font-weight:600;line-height:1.35}
.ben-wb__dlg-title:hover{border-color:var(--dsw-alias-border-l2)}
.ben-wb__dlg-title:focus{outline:0;border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-2)}
.ben-wb__dlg-steps{display:flex;gap:0}
.ben-wb__dlg-steps button{flex:1;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-left-width:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.ben-wb__dlg-steps button:first-child{border-left-width:1px;border-radius:9px 0 0 9px}
.ben-wb__dlg-steps button:last-child{border-radius:0 9px 9px 0}
.ben-wb__dlg-steps button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__dlg-steps button[data-on=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base);font-weight:650}
.ben-wb__dlg-field{display:flex;flex-direction:column;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__dlg-note{margin:0;padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.ben-wb__dlg-field textarea,.ben-wb__dlg-field input[type=date],.ben-wb__dlg-field select{padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;resize:vertical}
.ben-wb__dlg-grid{display:flex;flex-wrap:wrap;gap:20px}
.ben-wb__dlg-grid .ben-wb__chip{font-size:12px;padding:5px 13px}
.ben-wb__dlg .ben-wb__links{display:flex;flex-wrap:wrap;gap:6px}
.ben-wb__dlg .ben-wb__link{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ben-wb__dlg .ben-wb__link code{color:var(--dsw-alias-label-primary);font-size:11px}
.ben-wb__dlg .ben-wb__link-who{color:var(--dsw-alias-label-primary)}
.ben-wb__dlg .ben-wb__link-state{color:var(--dsw-alias-label-tertiary)}
.ben-wb__dlg .ben-wb__link button{width:18px;height:18px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}
.ben-wb__dlg .ben-wb__link button:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
/* 交付物与费用(2026-09-09,待办第 5 条)。卡面上两小块:交付物件数(没有可验收的东西时
   换成一句警示色的话)与本卡消耗;弹窗里是完整清单 + 挂新的一件。 */
.ben-wb__task-deliv{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5);white-space:nowrap}
.ben-wb__task-deliv[data-empty=true]{background:transparent;border:1px dashed var(--dsw-alias-state-warn-label);color:var(--dsw-alias-state-warn-label)}
.ben-wb__task-spend{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace;font-size:var(--wb-t5);white-space:nowrap}
/* 派给那家客户端的窗口(2026-09-21)。胶囊照抄交付物那一格的形状;没送成的描红边——
   它跟"阻塞"是同一类坏消息,但不抢那一格的位置。 */
.ben-wb__task-dispatch{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5);white-space:nowrap}
.ben-wb__task-dispatch[data-status=failed]{background:transparent;border:1px dashed var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
/* 派出去了没有(2026-09-30):已送达绿、没核上琥珀、没派出去红 —— 扫一眼就知道这一件到没到那边。 */
.ben-wb__task-delivery{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5);white-space:nowrap}
.ben-wb__task-delivery[data-delivery=seen]{color:#7fd1a0}
.ben-wb__task-delivery[data-delivery=unconfirmed]{color:#d8a657}
.ben-wb__task-delivery[data-delivery=typed],.ben-wb__task-delivery[data-delivery=failed]{background:transparent;border:1px dashed var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.ben-wb__task-lane{flex-basis:100%;padding:2px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5);line-height:1.4}
.ben-wb__task-lane[data-state=jammed]{color:#d8a657;border:1px dashed #d8a657;background:transparent}
.ben-wb__dlg .ben-wb__delivs{display:flex;flex-direction:column;gap:5px}
.ben-wb__dlg .ben-wb__deliv{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ben-wb__dlg .ben-wb__deliv code{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:11px;overflow-wrap:anywhere}
.ben-wb__dlg .ben-wb__deliv-kind{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.ben-wb__dlg .ben-wb__deliv-kind[data-kind=branch]{color:#7fd1a0}
.ben-wb__dlg .ben-wb__deliv-repo{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10.5px;overflow-wrap:anywhere}
.ben-wb__dlg .ben-wb__deliv button{flex:none;width:18px;height:18px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}
.ben-wb__dlg .ben-wb__deliv button:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.ben-wb__dlg .ben-wb__deliv-add{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ben-wb__dlg .ben-wb__deliv-add input[type=text],.ben-wb__dlg .ben-wb__deliv-add select{flex:1;min-width:180px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.ben-wb__dlg .ben-wb__deliv-hint{padding:4px 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer;overflow-wrap:anywhere;text-align:left}
.ben-wb__dlg .ben-wb__deliv-hint:hover{color:var(--dsw-alias-label-primary);border-style:solid}
.ben-wb__dlg .ben-wb__link-spend{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace;font-size:10.5px}
/* 「从会话转卡」列表里那条「归到已有的卡」(2026-09-09):一行一条会话,右边跟着归卡入口。 */
.ben-wb__board-pickrow{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.ben-wb .ben-wb__board-assign{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__board-assignlist{display:flex;flex-wrap:wrap;gap:5px;width:100%;padding-left:10px}
.ben-wb .ben-wb__dlg-addlink{align-self:flex-start;display:flex;align-items:center;gap:6px;padding:5px 11px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.ben-wb .ben-wb__dlg-addlink:disabled{opacity:.5;cursor:default}
.ben-wb__dlg-foot{display:flex;align-items:center;gap:10px;padding:13px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.ben-wb__dlg-foot>button:not(.ben-wb__task-del){padding:5px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;cursor:pointer}
.ben-wb__dlg-done{margin-left:auto!important;border-color:var(--dsw-alias-state-business-primary)!important;color:var(--dsw-alias-state-business-primary)!important}

.ben-wb__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
${SURFACE_STYLE}
${COMPOSITION_STYLE}
${UNLOCK_STYLE}
${EMPTY_STYLE}
${ACCESS_NOTE_STYLE}
${ACTOR_NOTE_STYLE}
${SCENE_MENU_STYLE}
${DEV_TOOL_STYLE}
${CUSTOM_MODULE_STYLE}
${TEMPLATE_STYLE}
${LAYOUT_ASK_STYLE}
${MATERIALIZE_STYLE}
${TOPIC_DECK_STYLE}
${FX_STYLE}
${COMPOSER_STYLE}
${APPROVAL_STYLE}
${PROJECT_OTHERS_STYLE}
${DISPATCH_EYES_STYLE}
${PROMPTS_STYLE}
${HABITS_STYLE}
${COLLAB_STYLE}
${ITEM_STYLE}
${NEUTRAL_STYLE}

/* ── 壳顶上那一条(2026-09-25,卡 TB:标题栏透明、内容顶到窗顶、表头可拖)──
   放在最后:SURFACE_STYLE 那一层给顶栏上了卡片底色与圆角,在壳里这一条是**窗口的顶栏**,
   得把那层盖回去(维护者:不要卡片框)。
   ① 78px 是红绿灯的位置,与壳那侧 ShellTitleBar.trafficLightInset 同一个数,改要一起改;
      这一截底下不放任何能点的东西 —— 那里是三颗系统按键;
   ② 内容顶到窗顶:.ben-wb__inner 顶部不留内边距(横屏那支也一样);
   ③ 空白处按住就拖窗口,拖的时候不许顺手选中文字;按钮/输入框各自恢复可选中;
   ④ 高度按红绿灯那一截(28px)对齐,三颗键与这一行的字在同一条水平线上。 */
.ben-wb[data-shell=app] .ben-wb__inner{padding-top:0}
.ben-wb .ben-wb__topbar[data-shell=app]{padding:7px 12px 7px 78px;min-height:28px;border-radius:0;border-top:0;background:transparent;user-select:none;-webkit-user-select:none}
.ben-wb .ben-wb__topbar[data-shell=app] :is(button,input,select,textarea){user-select:auto;-webkit-user-select:auto}

${MONO_STYLE}
${SETTINGS_MONO_STYLE}

`

/**
 * 动效配角的样式(2026-09-23)。独占 `ben-fx` 前缀;另有几条挂在原组件类名下,只管「包了一层之后版面照旧」。
 */
export const FX_STYLE = `
/* 包一层不占版面;库的外壳撑满原来那一格。 */
.ben-fx{display:contents}
.ben-fx>.ben-fx__beam{display:block;min-width:0}
.ben-fx__orb,.ben-fx__avatar{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;flex:none}
.ben-fx__orb{width:20px;height:20px}

/* 事务官档输入框(2026-09-24 起是统一输入框):外边距与宽度在外面那一格(.ben-wb__composer-slot)上。 */
.ben-wb__items--particle .ben-wb__composer-slot{flex:none;position:relative;z-index:2;align-self:center;box-sizing:border-box;width:calc(100% - 28px);max-width:720px;margin:6px 14px 12px}
@container (max-height:260px){.ben-wb__items--particle .ben-wb__composer-slot{margin-top:3px;margin-bottom:6px}}
/* 台上的卡:光的外壳撑满那一格;头像与小球排在「谁在办」那一行最前面。 */
.ben-wb__task-constellation .ben-fx__beam{height:100%}
.ben-wb__task-constellation .ben-wb__task-agents{justify-content:flex-start;align-items:center}
.ben-wb__task-constellation .ben-wb__task-agents>span.ben-fx{display:inline-flex;margin-left:0;margin-right:2px}
/* 看板卡上的派活小标、会话区组头:头像跟字排一行。 */
.ben-wb__task-dispatch>.ben-fx__avatar,.ben-wb__ghead>.ben-fx__avatar{margin-right:4px}
/* 窗口槽:光的外壳接过槽体原来在那一列里的 flex 与下限高度,槽体撑满外壳(矩形还是以槽体为准)。 */
.ben-wb__slot>.ben-fx>.ben-fx__beam{flex:1 1 auto;min-height:120px;display:flex;flex-direction:column;border-radius:8px}
.ben-wb__slot .ben-fx__beam>.ben-wb__slot-body{flex:1 1 auto}
/* 拖着窗悬在槽上(2026-09-25):槽那一层抬到事务官档上面(事务官档 z-index 2),不接点击;
   提示字铺一层半透明底,压在事务官档的内容上也读得清。只在悬停那几秒这样,平时一个像素不变。 */
.ben-wb__slot-stack[data-hover=true]>.ben-wb__slot{position:relative;z-index:4;pointer-events:none}
.ben-wb__slot-stack[data-hover=true] .ben-wb__slot-hover-hint{z-index:5;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);font-size:15px;letter-spacing:.04em}
/* 引导对话屏(2026-09-24 起是统一输入框的 onboarding 裁剪):占满那一行。 */
.ben-wb__onb .ben-wb__firstrun-row>.wb-cmp{flex:1;min-width:0}
/* 歇着(2026-09-25,卡 fix/evening-gaps 第 6 条;restMode.ts:切到别的 App、两分钟没动静、页面藏起来):
   沿边光停在当前那一帧 —— 光还在,只是不走。选择器与 border-beam 自己「滚出屏幕就停」那一条(它的 data-paused)
   逐字同一组:只停**亮着、没在淡出**的那种,淡入淡出照走(没事了的光照样会灭)。在 WKWebView 里量过:
   一张卡沿边走的光单独就占 GPU 69%(模糊 + 遮罩每帧重画)。一动鼠标、切回来,当场接着走。 */
html[data-wb-rest=true] [data-beam][data-active]:not([data-fading]),
html[data-wb-rest=true] [data-beam][data-active]:not([data-fading])::before,
html[data-wb-rest=true] [data-beam][data-active]:not([data-fading])::after,
html[data-wb-rest=true] [data-beam][data-active]:not([data-fading]) [data-beam-bloom]{animation-play-state:paused!important}
/* 球到卡那几条线上的流光同理(带 drop-shadow,每帧重画)。 */
html[data-wb-rest=true] .ben-wb__task-connections .ben-wb__task-flow{animation-play-state:paused!important}
`

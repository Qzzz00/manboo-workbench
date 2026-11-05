/** Only the Butler surface; no selector can resize the surrounding workbench modules. */
export const BUTLER_LAYOUT_STYLE = `
/* 2026-09-25 两截:上面球的舞台固定、不随下面滚;下面「要你处理的」自己一个滚动区(见 ButlerScene.tsx)。
   2026-10-23 修复窄浮窗遮挡:粒子球与舞台弹性收缩,输入框外层与舞台分离,下面区域保证最小高度与独立纵向滚动。 */
.ben-wb__items--particle>.ben-wb__particle-scene{flex:1 1 auto;min-height:0;overflow:hidden}
.ben-wb__particle-scene{display:flex;flex-direction:column;align-items:stretch;gap:0;height:100%;min-height:0;padding:8px clamp(8px,2cqw,24px) 0;box-sizing:border-box;position:relative;z-index:2;overflow:hidden}
.ben-wb__scene-top{flex:0 0 auto;display:flex;flex-direction:column;min-height:0}
.ben-wb__scene-below{flex:1 1 auto;min-height:48px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;display:flex;flex-direction:column;gap:10px;padding:2px 2px 8px}
.ben-wb__scene-below:empty{display:none}
.ben-wb__business-execution{position:static;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px}
.ben-wb__business-execution button,.ben-wb__business-execution summary{border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;padding:4px 0}
.ben-wb__business-execution>button{font-size:14px;font-weight:500}
.ben-wb__business-execution small,.ben-wb__business-execution summary{font-size:10px;color:var(--dsw-alias-label-secondary)}
.ben-wb__business-execution details{position:relative}
.ben-wb__business-execution details[open]>ul{position:absolute;top:100%;left:0;min-width:200px;padding:12px;background:var(--dsw-alias-bg-layer-1);z-index:6}
.ben-wb__execution-panel{display:none;min-height:0;overflow:hidden;flex:1 1 0}
.ben-wb__scene-below[data-execution-open=true]{overflow:hidden}
.ben-wb__scene-below[data-execution-open=true]>.ben-wb__execution-panel{display:flex;flex-direction:column}
.ben-wb__scene-below[data-execution-open=true]>:not(.ben-wb__execution-panel){display:none}
.ben-wb__business-list{position:relative;flex:1 1 auto;min-height:0;max-height:100%;overflow-y:auto;background:var(--dsw-alias-bg-layer-1);padding:0 12px 12px;box-sizing:border-box;white-space:normal;scrollbar-width:thin}
.ben-wb__business-list header{display:flex;justify-content:space-between;gap:12px;position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1);padding:8px 0}
.ben-wb__business-list button{border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;padding:4px 0}
.ben-wb__business-list ul{list-style:none;padding:0;margin:0}
.ben-wb__business-list li{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ben-wb__business-list li>button{font-size:13px}
.ben-wb__business-list p{font-size:11px;line-height:1.7;margin:4px 0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
/* 短窗展开执行清单时,同一任务已在下方可读清单中;收起台上重复卡,免得压住粒子球。 */
@media (max-height:560px){.ben-wb__particle-scene:has(.ben-wb__scene-below[data-execution-open=true]) .ben-wb__task-constellation,.ben-wb__particle-scene:has(.ben-wb__scene-below[data-execution-open=true]) .ben-wb__task-connections{display:none}}
.ben-wb__task-stage-heading{display:flex;justify-content:space-between;align-items:center;min-height:24px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.03em;position:relative;z-index:3}
.ben-wb__task-stage-heading>span,.ben-wb__task-stage-heading nav{display:flex;align-items:center;gap:8px}.ben-wb__task-stage-heading b{font:inherit;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ben-wb__task-stage-heading .ben-wb__task-stage-tools{gap:6px}.ben-wb__task-stage-tools .ben-wb__particle-actions{gap:4px}
.ben-wb__task-stage-heading nav button{border:0;border-radius:6px;background:transparent;color:inherit;width:28px;height:25px;cursor:pointer;font-size:18px}.ben-wb__task-stage-heading nav button:disabled{opacity:.25;cursor:default}
.ben-wb__task-stage{position:relative;flex:1 1 auto;min-height:min(max(180px,32cqh),calc(100cqh - 360px));isolation:isolate}
.ben-wb__task-stage[data-portrait=true][data-many=true]{min-height:min(max(240px,40cqh),calc(100cqh - 260px))}
.ben-wb__task-connections{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;color:var(--dsw-alias-label-primary)}
.ben-wb__task-connections path{fill:none;stroke:currentColor;stroke-width:.65;opacity:.16}.ben-wb__task-connections circle{fill:currentColor;opacity:.35}
.ben-wb__task-connections [data-active=true] path{opacity:.4}.ben-wb__task-connections [data-progress-pulse]{opacity:.9}
.ben-wb__task-connections [data-executing=true] path[data-task-link]{opacity:.34}
/* 在办那几条线上的流光(2026-09-25):一段 14% 长的亮线从球顺着线流向卡,2.4 秒一趟。减少动效时整条不画(下面那条 @media)。 */
.ben-wb__task-connections .ben-wb__task-flow{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-dasharray:14 86;stroke-dashoffset:0;opacity:.9;filter:drop-shadow(0 0 3px rgb(255 255 255 / .75));animation:ben-wb__task-flow 2.4s linear infinite}
@keyframes ben-wb__task-flow{from{stroke-dashoffset:0}to{stroke-dashoffset:100}}
.ben-wb__task-connections path[data-pending=true]{stroke-dasharray:3 4;opacity:.28}.ben-wb__task-constellation li[data-pending=true]{opacity:.72}
.ben-wb__task-orb-anchor{position:absolute;transform:translate(-50%,-50%);pointer-events:none;display:grid;place-items:center}
.ben-wb__task-orb-anchor .ben-wb__particle-orb{height:100%;width:100%;max-width:none;min-height:0;flex:none}
.ben-wb__task-orb-anchor .ben-wb__orb{width:64%;height:64%}
.ben-wb__task-constellation{list-style:none;margin:0;padding:0;position:absolute;inset:0;pointer-events:none}
.ben-wb__task-constellation li{position:absolute;pointer-events:auto;box-sizing:border-box}
.ben-wb__task-constellation button{width:100%;height:100%;box-sizing:border-box;text-align:left;padding:13px 16px;border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));border-radius:15px;background:var(--wb-surface-card,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:0 8px 26px rgb(0 0 0 / .08);cursor:pointer;display:flex;flex-direction:column;gap:7px;transition:background .18s,border-color .18s,box-shadow .18s;overflow:hidden}
.ben-wb__task-constellation button:hover,.ben-wb__task-constellation [data-selected=true] button{background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent);box-shadow:0 8px 30px rgb(0 0 0 / .13)}
.ben-wb__task-constellation strong{font-size:13px;font-weight:500;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;flex:none}
/* 头像那一行(2026-09-25,卡 fix/avatar-headroom,维护者「跳起来的时候渲染的空间估计不够」):这一行**不裁、也不许被挤**。卡上那个小头像画的不是它看上去那一格 —— 库在画布上下各留了 25% 的余量(画布 = 视觉大小的 1.5 倍),给「蹦起来」用;这一行比头像矮,原来又挂着 overflow:hidden,而卡片是竖排 88px 装三行、这一行会被挤扁(实测 16px 挤到 14px)—— 挤掉的那 6.5px 正好是头顶,在跑的那几家一蹦起来头顶就被切一条(codex 那张 6.53px、Claude 3.53px)。名字那一截改由里面那个 span 自己收省略号;高度钉在头像的视觉高度,与 ButlerTaskStage 里那个 size=16 对齐。 */
.ben-wb__task-agents{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:16px;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap;flex:none;overflow:visible}
.ben-wb__task-agents>span{margin-left:auto;font-size:9px}
.ben-wb__task-agents>span.ben-wb__task-agents-name{margin-left:0;font-size:10px;min-width:0;overflow:hidden;text-overflow:ellipsis}
/* 他点开的那一张(2026-09-25 卡 P 补三):不发光,一个小字说为什么是它。在跑的卡本身一个样。 */
.ben-wb__task-current{margin-left:6px;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:500;line-height:13px}
.ben-wb__task-progress{width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.4}
/* 会话卡(2026-09-26,卡 ST)。维护者 19:10:「Grok Bot 的标题显示不全」—— 最后一句与那一问都**折两行**,不再裁成一行;
   点「展开」去掉行数上限,那张卡自己长高、浮到别的卡上面(台上的卡是绝对定位的,不长高就摊不开)。 */
.ben-wb__task-latest,.ben-wb__task-ask,.ben-wb__task-item{width:100%;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;flex:none}
.ben-wb__task-ask{color:var(--dsw-alias-label-secondary)}
.ben-wb__task-constellation li[data-session-card=ask] button{border-color:color-mix(in srgb,var(--dsw-orange-60,#e8a33d) 55%,transparent)}
.ben-wb__task-constellation li[data-session-card=failed] button{border-color:color-mix(in srgb,var(--dsw-red-60,#e2564a) 45%,transparent)}
.ben-wb__task-constellation li[data-session-card=idle] button{opacity:.86}
.ben-wb__task-constellation li[data-expanded=true]{z-index:4}
.ben-wb__task-constellation li[data-expanded=true] button{height:auto;overflow:visible}
.ben-wb__task-constellation li[data-expanded=true] strong,.ben-wb__task-constellation li[data-expanded=true] .ben-wb__task-latest,.ben-wb__task-constellation li[data-expanded=true] .ben-wb__task-ask{-webkit-line-clamp:none;display:block;overflow:visible}
/* 「展开」小键(2026-09-26 晚,统筹修):它也是 li 里的 button,上面那条卡面样式(.ben-wb__task-constellation button,0,1,1)
   原来压过了 .ben-wb__task-expand(0,1,0)—— 小键长成整张卡那么大、盖住卡的内容,台上只剩一排「展开」。
   所以这里写得比卡面样式更具体,并把宽高、底色、阴影、弹性排版一样样撤回小键自己的。 */
.ben-wb__task-constellation li>.ben-wb__task-expand{position:absolute;right:8px;bottom:6px;width:auto;height:auto;display:inline-block;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--wb-surface-card,var(--dsw-alias-bg-layer-1));box-shadow:none;color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:400;line-height:14px;cursor:pointer;z-index:1}
.ben-wb__task-constellation li>.ben-wb__task-expand:hover{background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2));box-shadow:none}
.ben-wb__particle-scene .ben-wb__items-center{display:flex;flex-direction:column;align-items:center;height:auto;max-height:none;max-width:none;width:100%;overflow:visible;flex:none;gap:3px;padding:2px 0 10px;position:relative;z-index:3}
.ben-wb__items-center>*{text-align:center}
.ben-wb__particle-scene .ben-wb__items-report{max-width:560px;width:100%;margin:0;font-size:10px;background:transparent;padding:0;color:var(--dsw-alias-label-tertiary);justify-content:center}.ben-wb__particle-mode{font-size:15px;letter-spacing:.025em}
.ben-wb__particle-actions{gap:8px}.ben-wb__particle-actions button{background:transparent;font-size:10px}
.ben-wb__particle-focus{width:100%;max-width:760px;align-self:center;overflow:visible;max-height:none;flex:none}.ben-wb__particle-focus:empty{display:none}
.ben-wb__particle-focus article{padding:18px 22px;margin:0 0 18px}.ben-wb__particle-focus article>header{display:flex;justify-content:space-between;align-items:center}.ben-wb__particle-focus h3{margin:6px 0 12px}
.ben-wb__particle-storage{width:100%;max-width:1100px;align-self:center;overflow:visible;max-height:none;flex:none}
.ben-wb__particle-storage>p{font-size:11px;text-align:center;color:var(--dsw-alias-label-tertiary);margin:4px 0 16px}
.ben-wb__result-folders,.ben-wb__secondary-folders{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}
.ben-wb__secondary-folders:empty{display:none}.ben-wb__secondary-folders{margin-bottom:12px}
.ben-wb__other-items{margin:0 0 12px}.ben-wb__other-items>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;list-style:none;font-size:10px;color:var(--dsw-alias-label-tertiary);padding:3px 0;cursor:pointer}.ben-wb__other-items>summary::-webkit-details-marker{display:none}.ben-wb__other-items[open]>.ben-wb__secondary-folders{margin:10px 0 0}
.ben-wb__particle-storage .ben-wb__result-folder{min-width:0;margin:0;border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));border-radius:15px;padding:13px 14px 10px;background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2));box-sizing:border-box;overflow:hidden}
.ben-wb__result-folder>header{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:9px}.ben-wb__particle-storage h4{margin:0;font-size:10px;letter-spacing:.055em}
.ben-wb__result-folder>header>span{font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ben-wb__particle-storage ul{gap:8px}.ben-wb__particle-storage li{border-radius:6px;background:transparent}.ben-wb__particle-storage li+li{border-top:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));padding-top:8px}
.ben-wb__particle-storage li>button{align-items:flex-start;padding:3px 0;gap:7px;border-radius:6px}.ben-wb__particle-storage li>button>span:nth-child(2){min-width:0;flex:1}
.ben-wb__particle-storage li .ben-wb__particle-dot{margin-top:6px;width:4px;height:4px}.ben-wb__particle-storage strong{font-size:12px;font-weight:450;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ben-wb__particle-storage button small{font-size:9px;line-height:1.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ben-wb__folder-unread{flex:none}
.ben-wb__result-folders .ben-wb__result-folder[data-open=false] .ben-wb__folder-context,.ben-wb__result-folders .ben-wb__result-folder[data-open=false] .ben-wb__folder-note{display:none}
.ben-wb__particle-storage .ben-wb__folder-toggle{display:flex;justify-content:space-between;align-items:center;width:100%;padding:8px 0 0;margin-top:8px;border:0;border-top:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));border-radius:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:10px;cursor:pointer}
.ben-wb__folder-empty{font-size:10px;line-height:1.8;color:var(--dsw-alias-label-tertiary);margin:0;min-height:40px}.ben-wb__result-folder[data-empty=true]{background:transparent}
.ben-wb__items--particle[data-settings=true] .ben-wb__particle-scene{width:45%;display:flex}.ben-wb__items--particle[data-settings=true] .ben-wb__task-constellation,.ben-wb__items--particle[data-settings=true] .ben-wb__task-connections,.ben-wb__items--particle[data-settings=true] .ben-wb__task-stage-heading{display:none}
.ben-wb__items--particle[data-settings=true] .ben-wb__task-stage{min-height:min(300px,calc(100cqh - 250px))}
@container (max-width:760px){.ben-wb__task-constellation button{padding:11px 12px;gap:6px;border-radius:13px}.ben-wb__task-agents{flex-wrap:wrap;flex-shrink:0}.ben-wb__task-agents>span:not([data-attention=true]){display:none}.ben-wb__result-folders,.ben-wb__secondary-folders{gap:8px}.ben-wb__particle-storage .ben-wb__result-folder{padding:11px 10px;border-radius:13px}}
@container (max-width:440px){.ben-wb__task-constellation button{padding:10px 9px}.ben-wb__task-constellation strong{font-size:12px}.ben-wb__task-progress{display:none}.ben-wb__task-agents{font-size:9px}.ben-wb__particle-storage .ben-wb__result-folder{padding:10px 8px}.ben-wb__folder-unread{display:none}.ben-wb__particle-storage strong{font-size:11px}.ben-wb__particle-storage h4{font-size:9px}}
@media(prefers-reduced-motion:reduce){.ben-wb__task-connections [data-progress-pulse],.ben-wb__task-connections .ben-wb__task-flow{display:none}}
`

export const BUTLER_COMPOSER_STYLE = `
.ben-wb__items--particle .ben-wb__composer{display:flex;flex-direction:column;align-items:stretch;gap:4px;width:calc(100% - 28px);max-width:720px;align-self:center;box-sizing:border-box;margin:6px 14px 12px;padding:14px 16px 11px;border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));border-radius:22px;background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2));box-shadow:0 8px 28px rgb(0 0 0 / .07);transition:border-color .2s,box-shadow .2s}
.ben-wb__items--particle .ben-wb__composer-slot .ben-wb__composer{width:100%;max-width:none;margin:0}
.ben-wb__items--particle .ben-wb__composer:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);box-shadow:0 5px 28px rgb(0 0 0 / .12)}
.ben-wb__composer .ben-wb__items-input{display:block;width:100%;box-sizing:border-box;flex:none;height:48px;min-height:48px;max-height:120px;resize:none;overflow-y:auto;border:0;border-radius:0;background:transparent;padding:0 2px;outline:none;font:inherit;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);box-shadow:none}
.ben-wb__composer .ben-wb__items-input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:.9}
.ben-wb__composer-bottom{display:flex;align-items:center;gap:10px;min-height:30px;min-width:0}
.ben-wb__composer-caption{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap}.ben-wb__composer-caption>span{font-size:14px}
.ben-wb__composer-hint{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:9px;white-space:nowrap;opacity:.7}
.ben-wb__composer .ben-wb__items-mic{display:grid;place-items:center;border:0;padding:0;width:28px;height:28px;background:transparent;color:var(--dsw-alias-label-tertiary)}
.ben-wb__composer .ben-wb__items-send{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);transition:opacity .2s,transform .2s}
.ben-wb__composer .ben-wb__items-send:not(:disabled):hover{transform:translateY(-1px)}.ben-wb__composer .ben-wb__items-send:disabled{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);color:var(--dsw-alias-label-tertiary);opacity:1}
.ben-wb__items--particle .ben-wb__items-receipt{padding:0 18px;align-self:center;max-width:720px}
.ben-wb__items--particle>.ben-wb__particle-settings{bottom:130px}
@container (max-width:480px){.ben-wb__composer-hint{display:none}.ben-wb__composer .ben-wb__items-mic{margin-left:auto}.ben-wb__items--particle .ben-wb__composer{padding:12px 14px 10px;border-radius:19px}}
@container (max-height:720px){.ben-wb__items--particle .ben-wb__composer-slot{margin:4px 10px 8px;width:calc(100% - 20px)}.ben-wb__items--particle .ben-wb__composer{padding:10px 12px 8px;border-radius:18px}.ben-wb__composer .ben-wb__items-input{height:36px;min-height:36px}.wb-cmp .wb-cmp__box{padding:10px 12px 8px 14px;border-radius:18px}}
@container (max-height:260px){.ben-wb__items--particle .ben-wb__composer{padding:9px 12px 7px;margin-top:3px;margin-bottom:6px;border-radius:16px}.ben-wb__composer .ben-wb__items-input{height:30px;min-height:30px}.ben-wb__composer-bottom{min-height:24px}.ben-wb__composer .ben-wb__items-send{height:25px;width:25px}.ben-wb__items--particle>.ben-wb__particle-settings{bottom:90px}}
`

/**
 * 球下面「要你处理的」那几张卡(2026-09-25,卡 feat/first-look-orb-top)。**同一种深色卡**:与台上的事项卡同一个圆角(15px,
 * 光沿边那一圈就沿着它走)、同一层底色与发丝边;按钮主次与全局一致(主按钮白底黑字,其余描边)。
 *
 * 那张「这 4 次你都在说…要不要把它固化下来?」以前一条样式都没有:浏览器默认的白底按钮、白底输入框、
 * 带圆点的列表,文案里的 `**` 原样露着。这里给它一套,并把「小工具需求」「布局改动」那两张收进同一个框里
 * (它们原来的虚线框在这一区里去掉,不然框里套框)。
 */
export const ASK_CARD_STYLE = `
.ben-wb__asks{display:flex;flex-direction:column;gap:10px;width:100%;max-width:760px;align-self:center}
.ben-wb__asks>.ben-fx>.ben-fx__beam{border-radius:15px}
.ben-wb__ask{box-sizing:border-box;border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));border-radius:15px;background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2));padding:14px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.ben-wb__ask>*{margin:0}
.ben-wb__ask .ben-wb__layoutask,.ben-wb__ask .ben-wb__devtool-ask{border:0;padding:0;margin:0}
.ben-wb__ask .ben-wb__drawer{margin:0}
.ben-wb__asks>.ben-wb__drawer{border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));border-radius:15px;padding:12px 14px}
.ben-wb__ask button{font:inherit;font-size:12px;line-height:1.2;cursor:pointer;border-radius:8px;padding:6px 12px;border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l2));background:transparent;color:var(--dsw-alias-label-secondary)}
.ben-wb__ask button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__ask button:disabled{opacity:.45;cursor:default}
.ben-wb__ask input[type=text],.ben-wb__ask input:not([type]){box-sizing:border-box;min-width:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l2));border-radius:8px;padding:6px 9px;outline:none}
.ben-wb__ask input:focus{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 35%,transparent)}
.ben-wb__evolveask{display:flex;flex-direction:column;gap:10px}
.ben-wb__evolveask-head{margin:0;font-size:14px;line-height:1.55;font-weight:500;color:var(--dsw-alias-label-primary)}
.ben-wb__evolveask-says{margin:0;padding:0;list-style:none;display:grid;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ben-wb__evolveask-says li{padding-left:10px;border-left:2px solid var(--wb-surface-border,var(--dsw-alias-border-l2))}
.ben-wb__evolveask-ways{display:flex;flex-wrap:wrap;gap:6px}
.ben-wb__ask .ben-wb__evolveask-ways button{border-radius:999px;padding:5px 11px;font-size:11px}
.ben-wb__ask .ben-wb__evolveask-ways button[data-on=true]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:transparent}
.ben-wb__evolveask-plan{margin:0;line-height:1.7}.ben-wb__evolveask-plan strong{color:var(--dsw-alias-label-primary);font-weight:550}
.ben-wb__evolveask-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ben-wb__evolveask-name input{flex:1 1 160px}
.ben-wb__evolveask-row{display:flex;gap:8px;flex-wrap:wrap}
.ben-wb__ask .ben-wb__evolveask-row button:first-child{background:var(--ben-btn-bg,#fff);color:var(--ben-btn-fg,#111);border-color:transparent;font-weight:500}
.ben-wb__ask .ben-wb__evolveask-row button:first-child:hover:not(:disabled){background:var(--ben-btn-hover,#ececec)}
.ben-wb__evolveask-hint{margin:0;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__evolveask-note{margin:0;color:var(--dsw-alias-label-primary)}.ben-wb__evolveask-err{margin:0;color:#e0908a}
.ben-wb__meetprep-portrait{margin:0;display:grid;gap:3px;font-size:12px}.ben-wb__meetprep-portrait div{display:flex;gap:8px}.ben-wb__meetprep-portrait dt{flex:0 0 72px;color:var(--dsw-alias-label-tertiary)}.ben-wb__meetprep-portrait dd{margin:0;color:var(--dsw-alias-label-primary)}.ben-wb__meetprep-portrait small,.ben-wb__meetprep-card small{margin-left:4px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.ben-wb__meetprep-ask,.ben-wb__meetprep-goal{display:flex;flex-direction:column;gap:6px}.ben-wb__meetprep-goal blockquote{margin:0;padding-left:10px;border-left:2px solid var(--wb-surface-border,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.ben-wb__meetprep-card{margin:0;padding-left:18px;display:grid;gap:8px;font-size:12px}.ben-wb__meetprep-card p{margin:0;line-height:1.6}

/* 悬浮球展开窗那一版(2026-10-27):一个滚动区,依次是状态与最近结果、待你处理、在跑的事项;输入框钉底。 */
.ben-wb__particle-scene--compact{display:flex;flex-direction:column}
.ben-wb__particle-scene--compact>.ben-wb__scene-below{flex:1 1 auto;padding:8px 4px}
.ben-wb__particle-scene--compact .ben-wb__items-center{padding:0}
.ben-wb__float-running ul{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.ben-wb__float-running li{display:flex;align-items:baseline;gap:8px;font-size:12px}
.ben-wb__float-running-title{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__float-running small{flex:none;color:var(--dsw-alias-label-tertiary)}
.ben-wb__float-running button{flex:none;padding:1px 8px;border:1px solid var(--dsw-alias-separator);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.ben-wb__float-running h4 span{color:var(--dsw-alias-label-tertiary);font-weight:400}
.ben-wb__float-tools{display:flex;justify-content:flex-end;gap:6px}
`

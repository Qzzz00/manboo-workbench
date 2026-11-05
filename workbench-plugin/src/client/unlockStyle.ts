/**
 * 每个区域单独解锁的样式(2026-09-17)。
 *
 * 单独一个文件、独占 `ben-wb__unlock*` 前缀:`style.ts` 这一版同时被好几张卡改着
 * (登录屏、设置「模型」节),把这几十行塞进那个一千行的模板串里,合并时必冲突。
 *
 * 视觉上只有一条要求:**解锁卡不能长得像报错**。它跟旁边那几格同宽同高、同一套边框,
 * 没有红色、没有感叹号 —— 它说的是"这儿还能再打开一扇门",不是"出事了"。
 */
export const UNLOCK_STYLE = `
.ben-wb__unlock-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.ben-wb__unlock-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px}
.ben-wb__unlock-name{color:var(--dsw-alias-label-primary);font-size:var(--wb-t3);font-weight:600}
.ben-wb__unlock-tag{flex:none;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__unlock-how{margin:0;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5);line-height:1.5;overflow-wrap:anywhere}
.ben-wb .ben-wb__unlock-btn{align-self:flex-start;margin-top:2px;padding:2px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__unlock-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 一张卡上两颗按钮时(DeepSeek,2026-09-21):推荐的那一颗只是**重一点**。
   不填色、不描强调色边 —— 另一条路(用自己的账号)是完全正当的一条,
   做成"一主一灰"会让人以为那条不该走。分寸同 hookapply 那颗 primary。 */
.ben-wb .ben-wb__unlock-btn[data-primary='yes']{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
/* 顶上那一小行:一条平铺的提示,不是横幅、不是气泡,关得掉。 */
.ben-wb__unlock-hint{display:flex;align-items:flex-start;gap:6px;margin:0 0 6px;padding:5px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5);line-height:1.5}
.ben-wb__unlock-hinttext{flex:1;overflow-wrap:anywhere}
/* 「全部接上」(2026-09-25):那一行里唯一的一颗按钮,跟卡片上那颗同一套样子,只是不换行。 */
.ben-wb .ben-wb__unlock-all{flex:none;align-self:center;margin-top:0;white-space:nowrap}
.ben-wb .ben-wb__unlock-hintx{flex:none;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:1.2;cursor:pointer}
.ben-wb .ben-wb__unlock-hintx:hover{color:var(--dsw-alias-label-primary)}
/* 「点一下,工作台帮你接上」那个小确认框(2026-09-17)。
   它盖在看板上,但**刻意做得小**:它只问一句"写不写",不是一页设置。 */
.ben-wb__hookapply-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.34)}
.ben-wb__hookapply{display:flex;flex-direction:column;gap:8px;width:min(520px,100%);max-height:80vh;overflow:auto;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.28)}
.ben-wb__hookapply-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ben-wb__hookapply-title{color:var(--dsw-alias-label-primary);font-size:var(--wb-t2);font-weight:600}
.ben-wb .ben-wb__hookapply-x{padding:0 4px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.ben-wb .ben-wb__hookapply-x:hover{color:var(--dsw-alias-label-primary)}
.ben-wb__hookapply-line{margin:0;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t4);line-height:1.6;overflow-wrap:anywhere}
.ben-wb__hookapply-line[data-tone='dim']{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__hookapply-line[data-tone='bad']{color:var(--dsw-alias-label-primary)}
.ben-wb__hookapply-file{margin:0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--wb-t5);overflow-wrap:anywhere}
.ben-wb__hookapply-more{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__hookapply-more>summary{cursor:pointer}
.ben-wb__hookapply-json{max-height:220px;margin:6px 0 0;overflow:auto;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--wb-t5);line-height:1.5;white-space:pre}
.ben-wb__hookapply-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.ben-wb .ben-wb__hookapply-btn{padding:3px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__hookapply-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__hookapply-btn[data-kind='primary']{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__hookapply-btn:disabled{opacity:.5;cursor:default}
/* 窗口槽里还没拉进来的那几格(2026-09-25,卡 fix/quota-and-slot-apps):虚边、字淡一档,后面一句「点一下拉进来」。
   放在这个文件而不是 style.ts:同一个"这一格还能再解锁一次"的意思(同解锁卡的虚边),也免得跟改 style.ts 的几张卡撞。
   不用强调色 —— 它不是"出事了",是"还差一下"。 */
.ben-wb__dock-tab--pending{border:1px dashed var(--dsw-alias-border-l1);background:transparent}
.ben-wb__dock-tab--pending .ben-wb__dock-tab-name{color:var(--dsw-alias-label-tertiary)}
.ben-wb__dock-tab--pending .ben-wb__dock-tab-name:hover{color:var(--dsw-alias-label-primary)}
.ben-wb__dock-tab--pending[data-busy=true]{opacity:.65}
/* 当前那一格的窗不在窗位里时,槽体里那一句 + 一颗键(2026-09-25):悬浮层,居中,不改槽体尺寸。 */
.ben-wb__slot-missing{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;z-index:2}
.ben-wb__slot-missing-line{margin:0;max-width:520px;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t4);line-height:1.6}
.ben-wb .ben-wb__slot-missing-pull{align-self:center;margin-top:0}
/* 认领过、但窗其实不在窗位里的那一格(2026-09-25,卡 fix/slot-current-empty):同一个虚边,选中态的底色照留。 */
.ben-wb__dock-tab[data-unplaced=true]{border:1px dashed var(--dsw-alias-border-l1)}
.ben-wb__land-rail .ben-wb__dock-tab[data-unplaced=true] .ben-wb__dock-tab-name{white-space:normal}
.ben-wb__land-rail .ben-wb__dock-tab[data-unplaced=true] .ben-wb__dock-tab-hint{display:block;margin-left:0;margin-top:1px}
.ben-wb__dock-tab-hint{margin-left:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* 横屏左栏那一条窄(168px):「企业微信 点一下拉进来」一行放不下会被省略号吃掉 —— 那几个字正是要他看见的,所以换到第二行。 */
.ben-wb__land-rail .ben-wb__dock-tab--pending .ben-wb__dock-tab-name{white-space:normal}
.ben-wb__land-rail .ben-wb__dock-tab--pending .ben-wb__dock-tab-hint{display:block;margin-left:0;margin-top:1px}
/* 球下面那张「额度还差一步」(2026-09-25):跟 DevToolAsk / LayoutAsk / EvolveAsk 同一种卡(虚线框、
   同样的圆角内边距,颜色数值逐字照抄 .ben-wb__devtool-ask),只是按钮用的是「全部接上」那个框的同一套。 */
.ben-wb__quotaask{border:1px dashed rgba(150,170,200,.45);border-radius:10px;padding:10px 12px;margin:8px 0;display:flex;flex-direction:column;gap:6px;font-size:12px}
.ben-wb__quotaask-head{margin:0;color:rgba(200,210,225,.75)}
.ben-wb__quotaask-say{margin:0;color:rgba(235,240,248,.95);line-height:1.5}
.ben-wb__quotaask-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ben-wb__quotaask-flow{display:flex;flex-direction:column;gap:8px}
.ben-wb__quotaask-note{margin:0;color:rgba(170,178,190,.7)}
.ben-wb__quotaask-err{margin:0;color:rgba(238,150,140,.95)}
/* 「全部接上」(2026-09-25):一个框里两家,各一段;写完逐家一行 + 各自一颗「撤回」。 */
.ben-wb__hookapply-agent{display:flex;flex-direction:column;gap:4px}
.ben-wb__hookapply-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.ben-wb__hookapply-row .ben-wb__hookapply-btn{flex:none}
`

/**
 * 她要问的话、要批的事、事项里那一段对话、DSH 原始界面上那颗「‹ 回工作台」的样子(2026-09-25,卡 M)。
 *
 * 维护者的眼睛(docs/验收-三层自验清单.md):只做深色;不要蓝;主按钮白底黑字,其余描边;不要卡片框(在球下那一区里
 * 不再自己画框 —— `.ben-wb__ask` 已经给了框与那一道光);红字只用于真错误,等他的琥珀色。
 */
export const ASK_STYLE = `
.ben-wb__qask,.ben-wb__aask{display:flex;flex-direction:column;gap:8px;min-width:0}
.ben-wb__qask-head,.ben-wb__aask-head{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.ben-wb__qask-head strong{color:var(--dsw-alias-label-secondary);font-weight:550}
.ben-wb__qask-item{display:flex;flex-direction:column;gap:8px;min-width:0}
.ben-wb__qask-item+.ben-wb__qask-item{border-top:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));padding-top:10px}
.ben-wb__qask-sub{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__qask-say{margin:0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:36vh;overflow:auto}
.ben-wb__qask[data-variant=inline] .ben-wb__qask-say{max-height:none}
/* 「要你看的 n 件」那一层自己会滚:里面不再套一层小滚动(读完她的话往下一滑就是选项)。 */
.ben-wb__asks-sheet .ben-wb__qask-say{max-height:none;overflow:visible}
.ben-wb__qask-detail{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.ben-wb__qask-options{display:flex;flex-direction:column;gap:6px}
.ben-wb__ask .ben-wb__qask-option,.ben-wb__qask-option{display:flex;flex-direction:column;align-items:flex-start;gap:3px;width:100%;text-align:left;padding:9px 12px;border-radius:10px;border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l2));background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.ben-wb__ask .ben-wb__qask-option:first-child,.ben-wb__qask-option:first-child{background:var(--ben-btn-bg,#fff);color:var(--ben-btn-fg,#111);border-color:transparent}
.ben-wb__ask .ben-wb__qask-option:first-child:hover:not(:disabled),.ben-wb__qask-option:first-child:hover:not(:disabled){background:var(--ben-btn-hover,#ececec);color:var(--ben-btn-fg,#111)}
.ben-wb__ask .ben-wb__qask-option[data-on=true],.ben-wb__qask-option[data-on=true]{outline:2px solid color-mix(in srgb,var(--dsw-alias-label-primary) 70%,transparent);outline-offset:1px}
.ben-wb__qask-option-text{font-size:12.5px;font-weight:550;line-height:1.4}
.ben-wb__qask-option-note{font-size:11px;line-height:1.45;opacity:.72}
.ben-wb__qask-own{display:flex;gap:8px;align-items:center;min-width:0}
.ben-wb__qask-own input{flex:1 1 auto;min-width:0}
.ben-wb__qask-own input{box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l2));border-radius:8px;padding:7px 10px;outline:none}
.ben-wb__ask .ben-wb__qask-send,.ben-wb__qask-send{flex:none;background:var(--ben-btn-bg,#fff);color:var(--ben-btn-fg,#111);border:0;border-radius:8px;padding:7px 14px;font:inherit;font-size:12px;font-weight:500;cursor:pointer}
.ben-wb__qask-send:disabled{opacity:.45;cursor:default}
.ben-wb__qask-err{margin:0;font-size:11px;color:#e0908a}
.ben-wb__aask-say{margin:0;font-size:13px;line-height:1.6;font-weight:500;color:var(--dsw-alias-label-primary)}
/* 派活那一问的大字第一行(卡 UX,2026-09-28):「把「…」派给 Claude?」比正文大一档、更重。 */
.ben-wb__aask-say[data-head="true"]{font-size:15px;line-height:1.5;font-weight:600}
/* 别家收起来那一行:一行字 + 「展开看额度」。 */
.ben-wb__aask-others{margin:0;display:flex;flex-wrap:wrap;gap:4px;align-items:baseline;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.ben-wb__aask-why{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ben-wb__aask-scope{margin:0;font-size:11px;line-height:1.55;color:#e3b76a}
.ben-wb__aask-acts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ben-wb__ask .ben-wb__aask-yes,.ben-wb__aask-yes{background:var(--ben-btn-bg,#fff);color:var(--ben-btn-fg,#111);border-color:transparent;font-weight:500;border-radius:999px}
.ben-wb__ask .ben-wb__aask-yes:hover:not(:disabled),.ben-wb__aask-yes:hover:not(:disabled){background:var(--ben-btn-hover,#ececec);color:var(--ben-btn-fg,#111)}
.ben-wb__aask-kind,.ben-wb__aask-no{border-radius:999px}
.ben-wb__aask button{font:inherit;font-size:12px;line-height:1.2;cursor:pointer;padding:6px 12px;border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l2));background:transparent;color:var(--dsw-alias-label-secondary)}
.ben-wb__aask .ben-wb__aask-yes{border-color:transparent;background:var(--ben-btn-bg,#fff);color:var(--ben-btn-fg,#111)}
.ben-wb__ask .ben-wb__aask-raw-toggle,.ben-wb__aask .ben-wb__aask-raw-toggle{margin-left:auto;border:0;background:transparent;padding:4px 2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);opacity:.75}
.ben-wb__aask-raw{margin:0;max-height:180px;overflow:auto;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary);background:rgba(0,0,0,.28);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-all}
.ben-wb__cask{display:flex;flex-direction:column;gap:6px;min-width:0}
.ben-wb__cask-head{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.ben-wb__cask-title{margin:0;font-size:13px;line-height:1.55;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ben-wb__cask-note{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ben-wb__cask-ask{margin:0;display:flex;flex-direction:column;gap:3px;border-left:2px solid var(--wb-surface-border,var(--dsw-alias-border-l2));padding-left:8px}
.ben-wb__cask-ask p{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ben-wb__cask-ask small{margin-right:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__cask-acts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ben-wb__cask-acts button{font:inherit;font-size:12px;line-height:1.2;cursor:pointer;padding:6px 12px;border-radius:999px;border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l2));background:transparent;color:var(--dsw-alias-label-secondary)}
.ben-wb__ask .ben-wb__cask-yes,.ben-wb__cask-acts .ben-wb__cask-yes{background:var(--ben-btn-bg,#fff);color:var(--ben-btn-fg,#111);border-color:transparent;font-weight:500}
.ben-wb__asks-extra-title{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__notify-trouble{margin:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;line-height:1.5;color:#e3b76a}
.ben-wb__ask .wb-approvals{width:100%;margin:0;gap:14px;align-self:stretch}
.wb-approvals>.ben-wb__aask+.ben-wb__aask{border-top:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));padding-top:12px}
/* 点开一件事:整张摊在这一栏上面(盖住球与球下那一区,不盖输入框),自己滚;「返回待机」收起。 */
.ben-wb__item-sheet{position:absolute;inset:0;z-index:7;overflow-y:auto;overscroll-behavior:contain;padding:6px clamp(10px,2cqw,30px) 12px;box-sizing:border-box;background:var(--wb-surface-card,var(--dsw-alias-bg-layer-1));display:flex;flex-direction:column;align-items:center}
.ben-wb__item-sheet>.ben-wb__particle-focus{width:100%;max-width:760px;max-height:none;overflow:visible;flex:none}
.ben-wb__item-sheet>.ben-wb__particle-focus article{margin:0}
.ben-wb__talk{display:flex;flex-direction:column;gap:10px;margin-top:8px;min-width:0}
.ben-wb__talk-status{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ben-wb__talk-status[data-waiting=true]{color:#e3b76a}
.ben-wb__talk-ask{padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.ben-wb__talk-ask button{font:inherit;font-size:12px;border-radius:8px}
.ben-wb__talk-grant{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__talk-turns{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;max-height:340px;overflow:auto}
.ben-wb__talk-turns li small{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__talk-turns li p{margin:2px 0 0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.ben-wb__talk-turns li[data-role=assistant] p{color:var(--dsw-alias-label-primary)}
.ben-wb__talk-note{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ben-wb__talk-raw{margin:0;text-align:right}
.ben-wb__talk-raw-link{background:none;border:0;padding:0;font:inherit;font-size:10.5px;color:var(--dsw-alias-label-tertiary);opacity:.6;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}
.ben-wb__talk-raw-link:hover{opacity:1}
`

/**
 * DSH 原始界面上那颗「‹ 回工作台」(2026-09-25,卡 M;维护者:回去的入口只有侧栏最下面一个不起眼的小图标,他没找到)。
 * 压在左上角(正好盖住上游那行「deepseek HARNESS」),白底黑字、够大;浮层那一层默认点不中,它自己把点击要回来。
 */
export const RETURN_PILL_STYLE = `
.ben-wb-return{position:fixed;top:10px;left:10px;z-index:2147483000;pointer-events:auto;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 18px 0 12px;border-radius:999px;border:0;background:#fff;color:#111;font:500 13px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);cursor:pointer}
.ben-wb-return:hover{background:#ececec}
.ben-wb-return span[aria-hidden=true]{font-size:18px;line-height:1;margin-top:-2px}
`

/**
 * 视觉 A 常用组件的样式(2026-10-21)。独占 `wb-ui` 前缀,只读 `tokens.ts` 的令牌,不写死颜色。
 * 10-22 起取 Codex 全局评审页 0cf75042(`#screen=landscape&theme=dark&slot=original`)的通用件:
 * 按钮高 28、内边距 4 / 9、圆角 6、字 12 / 400,次按钮 = 1px 线框、主按钮 = 主字色底反色字;输入 soft 底、圆角 6、内边距 7 / 9、字 12;
 * 开关 30×17;空态 图标 22、标题 13 / 600、说明 11 / 1.7;点径 4、点距 4;刻度格高 5、隔 3;构成刻度高 8、隔 3;
 * 弹层纸面底、1px 线、圆角 9、内边距 14。
 */
export const UI_STYLE = `
.wb-ui-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wb-ui-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--wb-btn-h);padding:4px 9px;border:1px solid var(--wb-line);border-radius:6px;background:transparent;color:var(--wb-ink);font:400 12px/1.5 var(--wb-font);white-space:nowrap;cursor:pointer;transition:background-color .12s ease,opacity .12s ease}
.wb-ui-btn[data-size=sm]{min-height:24px;padding:2px 7px;font-size:10.5px}
.wb-ui-btn:hover:not(:disabled){background:var(--wb-soft)}
.wb-ui-btn[data-variant=primary]{border-color:transparent;background:var(--wb-ink);color:var(--wb-reverse)}
.wb-ui-btn[data-variant=primary]:hover:not(:disabled){background:var(--wb-ink)}
.wb-ui-btn[data-variant=ghost]{border-color:transparent;background:transparent;color:var(--wb-ink)}
.wb-ui-btn[data-variant=ghost]:hover:not(:disabled){background:var(--wb-soft);color:var(--wb-ink)}
.wb-ui-btn[data-variant=text]{min-height:24px;padding:0;border:0;background:transparent;color:var(--wb-ink);text-decoration:underline;text-underline-offset:4px}
.wb-ui-btn[data-variant=text]:hover:not(:disabled){background:transparent;color:var(--wb-ink)}
.wb-ui-btn:disabled{opacity:.35;cursor:default}
.wb-ui-btn:focus-visible,.wb-ui-toggle:focus-visible,.wb-ui-row:focus-visible{outline:2px solid var(--wb-ink);outline-offset:2px}

.wb-ui-label{display:flex;flex-direction:column;gap:6px;min-width:0}
.wb-ui-label-text{color:var(--wb-sub);font:400 11px/1.5 var(--wb-font)}
.wb-ui-field{box-sizing:border-box;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:6px;background:var(--wb-soft);color:var(--wb-ink);font:400 12px/1.5 var(--wb-font);outline:0}
.wb-ui-field::placeholder{color:var(--wb-faint)}
.wb-ui-field:focus{border-color:var(--wb-faint)}
.wb-ui-field:disabled{opacity:.45}
.wb-ui-field--area{resize:vertical;min-height:64px}
.wb-ui-select{appearance:none;-webkit-appearance:none;padding-right:26px;background-image:linear-gradient(45deg,transparent 50%,var(--wb-sub) 50%),linear-gradient(135deg,var(--wb-sub) 50%,transparent 50%);background-position:calc(100% - 14px) 50%,calc(100% - 10px) 50%;background-size:4px 4px;background-repeat:no-repeat;cursor:pointer}

.wb-ui-toggle{position:relative;flex:none;width:30px;height:17px;padding:0;border:0;border-radius:99px;background:var(--wb-g1);cursor:pointer;transition:background-color .15s ease}
.wb-ui-toggle:hover:not(:disabled){background:var(--wb-faint)}
.wb-ui-toggle-knob{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--wb-paper);transition:transform .15s ease}
.wb-ui-toggle[aria-checked=true]{background:var(--wb-ink)}
.wb-ui-toggle[aria-checked=true] .wb-ui-toggle-knob{transform:translateX(13px)}
.wb-ui-toggle:disabled{opacity:.35;cursor:default}

.wb-ui-tag{display:inline-flex;align-items:center;gap:4px;color:var(--wb-sub);font:500 var(--wb-fs-source)/1.4 var(--wb-font);letter-spacing:.3px;white-space:nowrap}
.wb-ui-tag[data-boxed=true]{padding:1px 6px;border:var(--wb-hair) solid var(--wb-line);border-radius:var(--wb-r-chip)}

.wb-ui-card{display:flex;flex-direction:column;min-width:0;min-height:0;padding:var(--wb-s5) var(--wb-s7);border-radius:var(--wb-r-card);background:var(--wb-paper);color:var(--wb-ink)}
.wb-ui-card-head{display:flex;align-items:baseline;gap:var(--wb-s3);margin-bottom:var(--wb-s3)}
.wb-ui-card-title{margin:0;font:600 var(--wb-fs-title)/1.3 var(--wb-font);letter-spacing:-.26px}
.wb-ui-card-aside{margin-left:auto;color:var(--wb-sub);font:500 var(--wb-fs-source)/1.3 var(--wb-font)}

.wb-ui-row{box-sizing:border-box;display:flex;align-items:center;gap:14px;width:100%;padding:10px 0;border:0;border-bottom:var(--wb-hair) solid var(--wb-line);background:transparent;color:var(--wb-ink);font:400 12px/1.5 var(--wb-font);text-align:left}
.wb-ui-row:last-child{border-bottom:0}
button.wb-ui-row{cursor:pointer}
button.wb-ui-row:hover .wb-ui-row-action,button.wb-ui-row:hover .wb-ui-ico{flex:none}
.wb-ui-row-chevron{color:var(--wb-ink)}
.wb-ui-row-main{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.wb-ui-row-title{font:500 12px/1.5 var(--wb-font)}
.wb-ui-row-sub{color:var(--wb-faint);font:400 10px/1.65 var(--wb-font)}
.wb-ui-row-action{flex:none;color:var(--wb-ink);font:400 11px/1.5 var(--wb-font)}
.wb-ui-row-chevron{flex:none;width:12px;color:var(--wb-sub);font-size:16px;line-height:1;text-align:center}

.wb-ui-pop{position:absolute;z-index:40;top:calc(100% + 6px);left:0;min-width:200px;max-width:360px;padding:14px;border:var(--wb-hair) solid var(--wb-line);border-radius:9px;background:var(--wb-paper);color:var(--wb-ink);font:400 12px/1.6 var(--wb-font);box-shadow:var(--wb-shadow-pop);outline:0}
.wb-ui-veil{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:24px;background:var(--wb-veil)}
.wb-ui-veil.ben-wb__dlg-cover{right:auto;bottom:auto}
.wb-ui-modal{display:flex;flex-direction:column;width:min(620px,100%);max-height:100%;overflow:hidden;border-radius:var(--wb-r-window);background:var(--wb-paper);box-shadow:var(--wb-shadow-modal);color:var(--wb-ink)}
.wb-ui-modal-head{flex:none;display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:var(--wb-hair) solid var(--wb-line)}
.wb-ui-modal-head>h2{flex:1;margin:0;color:var(--wb-ink);font:600 14px/1.5 var(--wb-font)}
.wb-ui-modal-head>button{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:4px 9px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);cursor:pointer}
.wb-ui-modal-head>button:hover{background:var(--wb-soft)}
.wb-ui-modal-body{min-height:0;overflow:auto;padding:20px;font-size:12px;line-height:1.85}
.wb-ui-confirm-line{margin:0;color:var(--wb-sub);font-size:12px;line-height:1.85}
.wb-ui-modal-actions{flex:none;display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:var(--wb-hair) solid var(--wb-line)}
.wb-ui-pop[data-align=end]{left:auto;right:0}

.wb-ui-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;flex:1;min-height:95px;padding:18px 14px;text-align:center}
.wb-ui-empty-title{margin:0;color:var(--wb-ink);font:600 13px/1.5 var(--wb-font)}
.wb-ui-empty-hint{margin:0;max-width:280px;color:var(--wb-sub);font:400 11px/1.7 var(--wb-font)}

.wb-ui-tally{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px;min-height:var(--wb-dot);line-height:0}
.wb-ui-dot{display:block;width:var(--wb-dot);height:var(--wb-dot);border-radius:50%;background:var(--wb-ink)}
.wb-ui-tally[data-tone=dim] .wb-ui-dot{background:var(--wb-g2)}
.wb-ui-tally-rest{color:var(--wb-sub);font:500 var(--wb-fs-source)/1 var(--wb-font)}

.wb-ui-rungs{display:inline-flex;align-items:center;gap:3px;height:5px;min-width:30px}
.wb-ui-rung{position:relative;display:block;flex:1;min-width:1.5px;height:100%;background:var(--wb-g0);overflow:hidden}
.wb-ui-rung::after{content:"";position:absolute;inset:0 auto 0 0;width:calc(var(--fill,0) * 100%);background:var(--wb-ink)}
.wb-ui-srungs{display:inline-flex;align-items:stretch;gap:3px;height:8px;min-width:80px}
.wb-ui-srung{display:block;flex:1;min-width:1px;background:var(--wb-g1)}
.wb-ui-srung[data-part="0"]{background:var(--wb-g4)}
.wb-ui-srung[data-part="1"]{background:var(--wb-g2)}
`

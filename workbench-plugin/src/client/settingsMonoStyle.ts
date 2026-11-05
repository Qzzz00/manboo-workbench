/**
 * 设置弹窗六组各节的内部(2026-10-22,新 UI 第二轮 · 设置六组)。挂在 `MONO_STYLE` 之后、独占 `ben-wb__s` 前缀;
 * 外层(头、左栏、分组、组首、两列)归 `monoStyle.ts`,这里只管每一节里面。
 *
 * 每个值出自 Codex 全局评审页 `docs/assets/global-ui-review-2026-10-21/live/style.css` 的同名件(注释里写类名):
 * 节 `.setting-section`、`.section-heading`;行 `.setting-row`;按钮 `button` / `.outline` / `.text` / `.icon`;
 * 输入 `input,select,textarea`;`.inline-form`、`.fields`、`.actions`;折叠 `.fold`;学到的 `.learning-mini` /
 * `.tally-grid` / `.dots`;`.toggle`;`.capability-table`;`.warning-inline`;`.field-error`;`.directory-row`;
 * `.choice-grid` / `.choice`;`.seg`;`.settings-jump`;`.setting-heading`。颜色一律走令牌(值与稿同,见 `tokens.ts`)。
 * 共用件不只在设置里用(体检页里也摆着密钥与形象那两节),所以选择器挂在 `.ben-wb` 下,不限在弹窗里。
 */
export const SETTINGS_MONO_STYLE = `
/* ── 组首(组名、一句说明、?、跳转小钮)归 monoStyle.ts;这里只让每一节的外层不占盒子,两节直接排进两列。 ── */
.ben-wb .ben-wb__setsec{display:contents}
.ben-wb .ben-wb__setgrp{align-items:start}

/* ── 节(.setting-section / .section-heading) ── */
.ben-wb .ben-wb__ss{min-width:0;margin:0 0 28px;padding:16px 0 0;border:0;border-top:1px solid var(--wb-line);border-radius:0;background:transparent;box-shadow:none;color:var(--wb-ink);font:400 13px/1.5 var(--wb-font);scroll-margin-top:20px}
.ben-wb .ben-wb__ss-head{display:flex;align-items:center;gap:10px;margin:0 0 8px}
.ben-wb .ben-wb__ss-head h3{margin:0;color:var(--wb-ink);font:600 13px/1.5 var(--wb-font)}
.ben-wb .ben-wb__ss-aside{margin-left:auto;color:var(--wb-faint);font-size:10px;letter-spacing:.4px;text-align:right}
.ben-wb .ben-wb__slead{margin:0 0 12px;color:var(--wb-sub);font-size:11px;line-height:1.8}
.ben-wb .ben-wb__ss :is(h4){margin:14px 0 4px;color:var(--wb-ink);font:600 12px/1.5 var(--wb-font)}

/* ── 行(.setting-row) ── */
.ben-wb .ben-wb__srow{display:flex;align-items:center;gap:14px;min-width:0;padding:10px 0;border-bottom:1px solid var(--wb-line);font-size:12px}
.ben-wb .ben-wb__srow:last-child{border-bottom:0}
.ben-wb .ben-wb__srow-label{flex:1;min-width:0}
.ben-wb .ben-wb__srow-label strong{display:block;color:var(--wb-ink);font-size:12px;font-weight:500;overflow-wrap:anywhere}
.ben-wb .ben-wb__srow-label small{display:block;margin-top:4px;color:var(--wb-faint);font-size:10px;line-height:1.65;overflow-wrap:anywhere}
.ben-wb .ben-wb__srow>:is(button,.ben-wb__sbtn,.ben-wb__sseg,label,input[type=checkbox],.ben-wb__ssrc){flex:none}
.ben-wb .ben-wb__srow>.ben-wb__sbtn{font-size:11px}
.ben-wb .ben-wb__srow-acts{display:flex;flex:none;align-items:center;gap:4px}
.ben-wb .ben-wb__srow-acts>.ben-wb__sbtn{font-size:11px}
.ben-wb .ben-wb__srow-more{padding:0 0 12px;border-bottom:1px solid var(--wb-line)}
.ben-wb .ben-wb__srow-more:last-child{border-bottom:0}

/* ── 按钮(button / .outline / .text / .icon / .primary) ── */
.ben-wb .ben-wb__sbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:28px;padding:4px 9px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font:400 12px/1.5 var(--wb-font);white-space:nowrap;cursor:pointer;box-shadow:none;text-decoration:none}
.ben-wb .ben-wb__sbtn:hover{background:var(--wb-soft)}
.ben-wb .ben-wb__sbtn:disabled{opacity:.35;cursor:default}
.ben-wb .ben-wb__sbtn:disabled:hover{background:transparent}
.ben-wb .ben-wb__sbtn:focus-visible{outline:2px solid var(--wb-ink);outline-offset:2px}
.ben-wb .ben-wb__sbtn[data-kind=outline]{border:1px solid var(--wb-line)}
.ben-wb .ben-wb__sbtn[data-kind=text]{min-height:24px;padding:0;text-decoration:underline;text-underline-offset:4px}
.ben-wb .ben-wb__sbtn[data-kind=icon]{width:26px;min-height:26px;padding:4px}
.ben-wb .ben-wb__sbtn[data-kind=primary]{background:var(--wb-ink);color:var(--wb-reverse)}
.ben-wb .ben-wb__sico{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.ben-wb label.ben-wb__sbtn input[type=file]{display:none}

/* ── 输入(input,select,textarea):soft 底、无框、圆角 6、7 / 9、12px;聚焦弱字色框。
   .ben-wb__ss 写两遍:与外层那条 .ben-wb .ben-wb__setdlg :is(input[type=text],…) 同特异度、排在后面赢;开关那条再往后盖。 ── */
.ben-wb .ben-wb__ss.ben-wb__ss :is(input,select,textarea){box-sizing:border-box;width:100%;min-width:0;padding:7px 9px;border:1px solid transparent;border-radius:6px;outline:none;background:var(--wb-soft);color:var(--wb-ink);font:400 12px/1.5 var(--wb-font)}
.ben-wb .ben-wb__ss :is(input,select,textarea):focus{border-color:var(--wb-faint)}
.ben-wb .ben-wb__ss textarea{min-height:82px;line-height:1.7;resize:vertical}
.ben-wb .ben-wb__ss pre{margin:8px 0 0;padding:8px 10px;border-radius:6px;background:var(--wb-soft);color:var(--wb-sub);font:400 11px/1.6 var(--wb-font);white-space:pre-wrap;overflow-wrap:anywhere}
.ben-wb .ben-wb__ss code{color:var(--wb-sub);font-size:11px;overflow-wrap:anywhere}

/* ── .inline-form / .fields / .actions ── */
.ben-wb .ben-wb__sform{display:flex;align-items:center;gap:8px;margin:12px 0}
.ben-wb .ben-wb__sform>:is(input,select){flex:1}
.ben-wb .ben-wb__sform>:is(button,.ben-wb__sbtn){flex:none}
.ben-wb .ben-wb__sfields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.ben-wb .ben-wb__sfield{display:flex;flex-direction:column;gap:6px;min-width:0;color:var(--wb-sub);font-size:11px}
.ben-wb .ben-wb__sfield[data-full=true]{grid-column:1/-1}
.ben-wb .ben-wb__sacts{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px}
.ben-wb .ben-wb__sacts>.ben-wb__ssrc{margin-right:auto}

/* ── 折叠(.fold;节里 11px、上 14) ── */
.ben-wb .ben-wb__sfold{margin-top:14px;padding-top:9px;border-top:1px solid var(--wb-line);color:var(--wb-sub);font-size:11px}
.ben-wb .ben-wb__sfold>summary{display:flex;align-items:center;gap:6px;list-style:none;cursor:pointer}
.ben-wb .ben-wb__sfold>summary::-webkit-details-marker{display:none}
.ben-wb .ben-wb__sfold>summary>span:last-child{margin-left:auto}
.ben-wb .ben-wb__sfold-body{color:var(--wb-ink)}
.ben-wb .ben-wb__sfold-body>p{margin:10px 0 0;color:var(--wb-sub);font-size:11px;line-height:1.8}
.ben-wb .ben-wb__srow+.ben-wb__sfold,.ben-wb .ben-wb__srow-more+.ben-wb__sfold{margin-top:0}

/* ── 回话 / 出错 / 提醒框 / 小字 ── */
.ben-wb .ben-wb__smsg{margin:10px 0 0;color:var(--wb-sub);font-size:11px;line-height:1.7}
.ben-wb .ben-wb__serr{margin:12px 0;padding:7px 10px;border-left:2px solid var(--wb-ink);background:var(--wb-soft);color:var(--wb-ink);font-size:11px;line-height:1.7}
.ben-wb .ben-wb__swarn{margin:12px 0;padding:10px;border:1px solid var(--wb-faint);border-radius:7px;color:var(--wb-ink);font-size:11px;line-height:1.7}
.ben-wb .ben-wb__swarn .ben-wb__sacts{margin-top:8px}
.ben-wb .ben-wb__ssrc{color:var(--wb-faint);font-size:10px;letter-spacing:.4px}
.ben-wb .ben-wb__sexplain{margin-top:10px}
.ben-wb .ben-wb__sexplain :is(p,li){margin:0 0 6px;color:var(--wb-sub);font-size:11px;line-height:1.8}
.ben-wb .ben-wb__sexplain ul{margin:0;padding-left:14px}
.ben-wb .ben-wb__ss a{color:var(--wb-ink);text-decoration:underline;text-underline-offset:4px}
/* 从额度那一格带着落点进来的那一家(卡 QK「点亮那一行」):左边一道主字色,同首页引导的当前行 */
.ben-wb .ben-wb__ss [data-focus=true]>.ben-wb__srow{padding-left:10px;box-shadow:inset 2px 0 0 var(--wb-ink)}
/* 更新 / 装运行环境的进度(老样子里那道左边线与报错色换成灰阶) */
.ben-wb .ben-wb__ss .ben-wb__setup-job{margin-top:10px;padding-left:10px;border-left:2px solid var(--wb-line)}
.ben-wb .ben-wb__ss .ben-wb__setup-job[data-state=failed]{border-left-color:var(--wb-ink)}
.ben-wb .ben-wb__ss .ben-wb__setup-jobnote{color:var(--wb-sub);font-size:11px}
.ben-wb .ben-wb__ss .ben-wb__upd-bar{background:var(--wb-soft)}
.ben-wb .ben-wb__ss .ben-wb__upd-bar>i{background:var(--wb-ink)}

/* ── 学到的做法(.learning-mini / .learning-title / .tally-grid / .dots) ── */
.ben-wb .ben-wb__slearn{margin:8px 0 18px}
.ben-wb .ben-wb__slearn-title{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
.ben-wb .ben-wb__slearn-title p{max-width:360px;margin:0 0 9px;color:var(--wb-ink);font-size:12px;line-height:1.6}
.ben-wb .ben-wb__stally{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0}
.ben-wb .ben-wb__stally>div{padding-right:10px;border-right:1px solid var(--wb-line)}
.ben-wb .ben-wb__stally>div:last-child{border:0}
.ben-wb .ben-wb__stally-label{display:flex;align-items:baseline;gap:8px;color:var(--wb-sub);font-size:10px}
.ben-wb .ben-wb__stally-label strong{color:var(--wb-ink);font:800 18px/1.5 Inter,-apple-system,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:-.7px}
.ben-wb .ben-wb__sdots{display:flex;flex-wrap:wrap;align-items:center;gap:4px;max-width:90px;margin-top:4px}
.ben-wb .ben-wb__sdots>i{display:inline-block;flex:none;width:4px;height:4px;border-radius:50%;background:var(--wb-ink)}
.ben-wb .ben-wb__sdots>span{margin-left:4px;font-size:10px}

/* ── 开关(.toggle):30 × 17、全圆、关 g1 底、开主字色底;旋钮 13 纸面色 ── */
.ben-wb .ben-wb__ss input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;flex:none;box-sizing:border-box;width:30px;height:17px;margin:0;padding:0;border:0;border-radius:99px;background:var(--wb-g1);cursor:pointer}
.ben-wb .ben-wb__ss input[type=checkbox]:hover:not(:disabled){background:var(--wb-faint)}
.ben-wb .ben-wb__ss input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--wb-paper);transform:none}
.ben-wb .ben-wb__ss input[type=checkbox]:checked{background:var(--wb-ink)}
.ben-wb .ben-wb__ss input[type=checkbox]:checked::after{transform:translateX(13px)}
.ben-wb .ben-wb__ss input[type=checkbox]:disabled{opacity:.35;cursor:default}
.ben-wb .ben-wb__ss input[type=radio]{accent-color:var(--wb-ink)}

/* ── 能力表(.capability-table) ── */
.ben-wb .ben-wb__scaps{width:100%;margin-top:12px;border-collapse:collapse;font-size:11px}
.ben-wb .ben-wb__scaps :is(th,td){padding:10px 6px;border-bottom:1px solid var(--wb-line);text-align:left;vertical-align:middle}
.ben-wb .ben-wb__scaps th{color:var(--wb-sub);font-size:10px;font-weight:400}
.ben-wb .ben-wb__scaps td[data-state=bad],.ben-wb .ben-wb__scaps td[data-state=unknown]{color:var(--wb-faint)}
.ben-wb .ben-wb__scaps .ben-wb__sbtn{min-height:24px;font-size:11px}
.ben-wb .ben-wb__scaps .ben-wb__sico{width:12px;height:12px}
.ben-wb .ben-wb__scaps-more td{padding-top:0}
.ben-wb .ben-wb__scaps-more ul{margin:0;padding:0;list-style:none;color:var(--wb-sub);font-size:11px;line-height:1.7}
.ben-wb .ben-wb__scaps tr[data-stale=true]{opacity:.6}

/* ── 目录(.directory-row):名 92 | 值 | 动作 ── */
.ben-wb .ben-wb__sdir{display:grid;grid-template-columns:92px minmax(0,1fr) auto;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--wb-line);font-size:12px}
.ben-wb .ben-wb__sdir>span:first-child{color:var(--wb-ink)}
.ben-wb .ben-wb__sdir-val{display:flex;gap:8px;min-width:0}
.ben-wb .ben-wb__ss.ben-wb__ss .ben-wb__sdir-val input{flex:1}
.ben-wb .ben-wb__ss.ben-wb__ss .ben-wb__sdir-val select{width:auto;flex:none}

/* ── 两张卡(.choice-grid / .choice) ── */
.ben-wb .ben-wb__schoices{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ben-wb .ben-wb__schoice{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:6px;min-height:28px;padding:16px;border:0;border-radius:9px;background:var(--wb-soft);color:var(--wb-ink);font:400 12px/1.5 var(--wb-font);text-align:left;white-space:normal;cursor:pointer}
.ben-wb .ben-wb__schoice[aria-pressed=true]{outline:1px solid var(--wb-ink)}
.ben-wb .ben-wb__schoice:disabled{cursor:default}
.ben-wb .ben-wb__schoice strong{font-weight:700}
.ben-wb .ben-wb__schoice span{color:var(--wb-sub);font-size:10px;line-height:1.7}

/* ── 分段(.seg) ── */
.ben-wb .ben-wb__sseg{display:inline-flex;align-items:center;gap:2px}
.ben-wb .ben-wb__sseg button{min-height:24px;padding:2px 7px;border:0;border-radius:6px;background:transparent;color:var(--wb-sub);font:400 10.5px/1.5 var(--wb-font);cursor:pointer}
.ben-wb .ben-wb__sseg button:hover{background:var(--wb-soft)}
.ben-wb .ben-wb__sseg button[aria-pressed=true]{background:var(--wb-soft);color:var(--wb-ink)}

/* ── 事项类型(稿里没有;一类一行:两块底色 + 图标 + 名字;图标十六枚一排挑) ── */
.ben-wb .ben-wb__stype{display:inline-flex;align-items:center;gap:6px}
.ben-wb .ben-wb__sswatch{display:inline-block;flex:none;width:12px;height:12px;border:1px solid var(--wb-line);border-radius:3px}
.ben-wb .ben-wb__sicons{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 4px}
.ben-wb .ben-wb__sicons button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--wb-sub);cursor:pointer}
.ben-wb .ben-wb__sicons button:hover{background:var(--wb-soft)}
.ben-wb .ben-wb__sicons button[aria-checked=true]{background:var(--wb-soft);color:var(--wb-ink);box-shadow:inset 0 0 0 1px var(--wb-ink)}
.ben-wb .ben-wb__ss.ben-wb__ss input[type=color]{width:56px;height:32px;padding:3px;cursor:pointer}

/* ── 二维码那一块(稿里没有;沿用纸面上的 soft 卡) ── */
.ben-wb .ben-wb__spair{display:flex;flex-direction:column;align-items:center;gap:6px;margin:12px 0;padding:16px;border-radius:9px;background:var(--wb-soft);font-size:11px;color:var(--wb-sub)}
.ben-wb .ben-wb__spair b{color:var(--wb-ink);font:700 18px/1.5 Inter,-apple-system,sans-serif;letter-spacing:2px}

@container (max-width:680px){
  .ben-wb .ben-wb__ss{margin-bottom:22px}
  .ben-wb .ben-wb__sfields{gap:10px}
}
@container (max-width:560px){
  .ben-wb .ben-wb__sfields{grid-template-columns:1fr}
  .ben-wb .ben-wb__sfield[data-full=true]{grid-column:auto}
}
`

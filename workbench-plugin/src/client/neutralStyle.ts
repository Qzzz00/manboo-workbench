/**
 * 全局中性色(2026-09-24)。维护者原话:「这个蓝色也很奇怪,改成白色底黑字吧,中性一点,这是全局的」。
 *
 * **一处改**:工作台里所有「强调色」原先都读宿主 DSH 的 `--dsw-alias-state-business-primary`(蓝,rgb 103,158,254)
 * 及其浅底 `-tertiary`、`--dsw-alias-state-info-primary`、`--dsw-alias-button-primary-*`。宿主令牌不归我们改(C3),
 * 所以在工作台根 `.ben-wb` 上把这几个令牌**重定义成黑白灰**:登录屏、首次流程、看板、事务官档全在 `.ben-wb` 里面,
 * 一起变;宿主自己的界面不受影响。选中页签下划线、链接、进度条、焦点框、勾选框都跟着变成主文字色
 * (深色主题里是白,浅色主题里是墨)。
 *
 * **主按钮一律白底黑字**(两种主题都是):`--ben-btn-*` 这组令牌。浅色底上白按钮靠 1px 发丝边和一层很淡的投影
 * 分得出来;按下更灰一档;禁用是半透明;键盘焦点是一圈主文字色的环。
 *
 * **语义色不动**:红(错误)、琥珀(警告 / 等你)、绿(在线 / 接听)各自的令牌照旧。
 * 独占 `--ben-btn-*` / `--ben-focus` 这几个名字;这张表挂在 style.ts 的最后,同优先级时它说了算。
 */
export const NEUTRAL_STYLE = `
.ben-wb{
  --ben-btn-bg:#ffffff;
  --ben-btn-fg:#111111;
  --ben-btn-hover:#ececec;
  --ben-btn-press:#d9d9d9;
  --ben-btn-edge:rgba(0,0,0,.14);
  --ben-focus:var(--dsw-alias-label-primary);
  --dsw-alias-state-business-primary:var(--dsw-alias-label-primary);
  --dsw-alias-state-business-tertiary:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);
  --dsw-alias-state-info-primary:var(--dsw-alias-label-primary);
  --dsw-alias-button-primary-fill:var(--ben-btn-bg);
  --dsw-alias-button-primary-hover:var(--ben-btn-hover);
  accent-color:var(--dsw-alias-label-primary);
}
.ben-wb :focus-visible{outline-color:var(--ben-focus)}

/* 主按钮:白底黑字。登录「登录/注册」、首次流程每一屏的主键与「发送」、事务官档「确认」、项目区「确认」。 */
.ben-wb :is(.ben-wb__account-go,.ben-wb__firstrun-go,.ben-wb__items-confirm,.ben-wb__pj-confirm){
  background:var(--ben-btn-bg);color:var(--ben-btn-fg);border:1px solid var(--ben-btn-edge);
  box-shadow:0 1px 2px rgba(0,0,0,.18);transition:background-color .12s ease,transform .12s ease
}
.ben-wb :is(.ben-wb__account-go,.ben-wb__firstrun-go,.ben-wb__items-confirm,.ben-wb__pj-confirm):hover:not(:disabled){background:var(--ben-btn-hover)}
.ben-wb :is(.ben-wb__account-go,.ben-wb__firstrun-go,.ben-wb__items-confirm,.ben-wb__pj-confirm):active:not(:disabled){background:var(--ben-btn-press);transform:translateY(.5px)}
.ben-wb :is(.ben-wb__account-go,.ben-wb__firstrun-go,.ben-wb__items-confirm,.ben-wb__pj-confirm):disabled{background:var(--ben-btn-bg);color:var(--ben-btn-fg);opacity:.45;box-shadow:none}
.ben-wb :is(.ben-wb__account-go,.ben-wb__firstrun-go,.ben-wb__items-confirm,.ben-wb__pj-confirm):focus-visible{outline:2px solid var(--ben-focus);outline-offset:2px}

/* 实心强调底上的字:原来写死白字(蓝底白字),强调底现在跟主文字色走,字取反色。 */
.ben-wb .ben-wb__items-chip:is([data-status=confirm],[data-wait=approval]),
.ben-wb .ben-wb__chip[data-priority=low][data-on=true]{color:var(--dsw-alias-bg-base)}

/* 「等你确认」那颗点原来是蓝色实心;白点已经有别的意思,改成一圈空心环。 */
.ben-wb .ben-wb__stackcard-dot[data-dot=blue]{background:transparent;border-color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1.5px var(--dsw-alias-label-primary)}

/* 用量热力格:蓝的深浅换成主文字色的深浅。 */
.ben-wb .ben-wb__usage-heatcell[data-level="1"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}
.ben-wb .ben-wb__usage-heatcell[data-level="2"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent)}
.ben-wb .ben-wb__usage-heatcell[data-level="3"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 66%,transparent)}
/* 老的声纹球默认的光晕原来是蓝的。 */
.ben-wb .ben-wb__orb:not([data-amber=true]){--orb-glow:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent)}

`

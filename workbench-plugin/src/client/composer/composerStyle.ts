/**
 * 统一输入框的样式(2026-09-24)。独占 `wb-cmp` 前缀。
 *
 * 照参考图:深色圆角大底座;左下「+」圆钮;右下两枚细边胶囊;最右白底黑字圆形发送键。
 * **不用蓝**(维护者全局去蓝):强调一律中性黑白灰。光沿边由 FxBeam(border-beam,mono)画,
 * 这里只管「平时那一圈淡的静态细边」。手机那份(butler-app/src/composer/composer.css)是同一套数值。
 */
export const COMPOSER_STYLE = `
.wb-cmp{position:relative;display:flex;flex-direction:column;gap:6px;min-width:0;width:100%}
.wb-cmp>.ben-fx>.ben-fx__beam{border-radius:24px}
.wb-cmp__box{position:relative;display:flex;flex-direction:column;gap:8px;margin:0;padding:14px 14px 10px 16px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);border-radius:24px;background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2));box-shadow:0 8px 28px rgb(0 0 0 / .08);transition:border-color .2s,box-shadow .2s}
.wb-cmp__box:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent)}
.wb-cmp__input{display:block;width:100%;box-sizing:border-box;min-height:26px;max-height:180px;resize:none;overflow-y:auto;border:0;background:transparent;padding:2px 2px;outline:none;font:inherit;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);box-shadow:none;field-sizing:content}
.wb-cmp__input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:.9}
.wb-cmp__bar{display:flex;align-items:center;gap:8px;min-height:32px;min-width:0}
.wb-cmp__spacer{flex:1 1 auto}
.wb-cmp__plus{display:grid;place-items:center;flex:none;width:30px;height:30px;padding:0;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.wb-cmp__plus:hover,.wb-cmp__plus[aria-expanded=true]{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 34%,transparent)}
.wb-cmp__pill{display:inline-flex;align-items:center;gap:4px;flex:none;max-width:160px;height:28px;padding:0 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.wb-cmp__pill:hover,.wb-cmp__pill[aria-expanded=true]{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent)}
.wb-cmp__pill--at{border-style:dashed}
.wb-cmp__send{display:grid;place-items:center;flex:none;width:34px;height:34px;padding:0;border:1px solid rgb(0 0 0 / .14);border-radius:50%;background:#fff;color:#111;cursor:pointer;transition:opacity .2s,transform .2s}
.wb-cmp__send:not(:disabled):hover{transform:translateY(-1px)}
.wb-cmp__send:disabled{opacity:.35;cursor:default}
.wb-cmp__dots{font-size:13px;letter-spacing:1px}
.wb-cmp__note{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-cmp__chips{display:flex;flex-wrap:wrap;gap:6px}
.wb-cmp__chip{display:inline-flex;align-items:center;gap:5px;max-width:240px;height:24px;padding:0 4px 0 8px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary);font-size:11px}
.wb-cmp__chip img{width:18px;height:18px;border-radius:4px;object-fit:cover}
.wb-cmp__chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-cmp__chip-state{color:var(--dsw-alias-label-tertiary);font-size:10px}
.wb-cmp__chip[data-state=error]{background:color-mix(in srgb,#d64545 14%,transparent)}
.wb-cmp__chip button{display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;cursor:pointer}
.wb-cmp__chip button:hover{color:var(--dsw-alias-label-primary)}
.wb-cmp__menu{position:absolute;left:0;right:0;bottom:calc(100% + 8px);z-index:30;display:flex;flex-direction:column;gap:2px;max-height:300px;overflow-y:auto;padding:6px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);border-radius:16px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 36px rgb(0 0 0 / .18)}
.wb-cmp__item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:8px 10px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.wb-cmp__item:hover,.wb-cmp__item[data-active=true],.wb-cmp__item[aria-checked=true]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.wb-cmp__item:disabled{cursor:default;opacity:.55}
.wb-cmp__item[data-ready=false] .wb-cmp__item-title{color:var(--dsw-alias-label-tertiary)}
.wb-cmp__item-title{display:flex;align-items:center;gap:6px;font-size:12px}
.wb-cmp__item-hint{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.wb-cmp__tag{padding:0 5px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);font-size:9px;color:var(--dsw-alias-label-secondary)}
.wb-cmp__menu-note{margin:4px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wb-cmp__drop{position:absolute;inset:0;display:grid;place-items:center;border:1px dashed color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent);border-radius:24px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;pointer-events:none}
.wb-cmp[data-trim=onboarding] .wb-cmp__box{padding:10px 10px 10px 16px;flex-direction:row;align-items:flex-end;border-radius:22px}
.wb-cmp[data-trim=onboarding] .wb-cmp__input{flex:1;min-height:24px;max-height:120px}
.wb-cmp[data-trim=onboarding] .wb-cmp__bar{min-height:0}
.wb-cmp[data-trim=onboarding] .wb-cmp__bar .wb-cmp__spacer{display:none}
@container (max-width:480px){.wb-cmp__pill{max-width:110px;padding:0 8px}.wb-cmp__box{padding:12px 12px 9px 14px;border-radius:20px}}
@container (max-height:260px){.wb-cmp__box{padding:8px 10px 6px 12px;gap:4px;border-radius:16px}.wb-cmp__input{max-height:60px}.wb-cmp__send{width:28px;height:28px}.wb-cmp__plus{width:26px;height:26px}}
`

/** 等他批的那几行(档上,输入框正上方)。琥珀是「等你」的语义色,不是装饰。 */
export const APPROVAL_STYLE = `
.wb-approvals{display:flex;flex-direction:column;gap:6px;align-self:center;width:calc(100% - 28px);max-width:720px;margin:4px 14px 0;position:relative;z-index:2}
.wb-approvals__row{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid color-mix(in srgb,#d9a13b 45%,transparent);border-radius:14px;background:color-mix(in srgb,#d9a13b 8%,var(--dsw-alias-bg-layer-1))}
.wb-approvals__text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.wb-approvals__text strong{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wb-approvals__text span{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-approvals__yes,.wb-approvals__no{flex:none;height:28px;padding:0 12px;border-radius:999px;font:inherit;font-size:11px;cursor:pointer}
.wb-approvals__yes{border:1px solid rgb(0 0 0 / .14);background:#fff;color:#111}
.wb-approvals__no{border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);background:transparent;color:var(--dsw-alias-label-secondary)}
`

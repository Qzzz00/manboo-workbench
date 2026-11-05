import { ASK_CARD_STYLE, BUTLER_COMPOSER_STYLE, BUTLER_LAYOUT_STYLE } from './butlerLayoutStyle.ts'
/** Component-local layout. The absolute items surface never participates in SlotZone measurement. */
export const PARTICLE_STYLE = `
.ben-wb__items--particle{container-type:size;overflow:hidden;background:var(--wb-surface-card,var(--dsw-alias-bg-layer-1));isolation:isolate}
.ben-wb__particle-scroll{flex:1 1 auto;min-height:0;overflow:auto;position:relative;z-index:2;scrollbar-width:thin}
.ben-wb__particle-scene{display:grid;grid-template-columns:minmax(0,.8fr) minmax(160px,1.7fr) minmax(0,.9fr);grid-template-rows:minmax(0,1fr);gap:14px;align-items:start;height:100%;min-height:0;padding:8px 10px 14px;min-width:0}
.ben-wb__particle-scene .ben-wb__items-center{min-width:0;max-width:none;height:100%;max-height:100%;overflow:auto;padding:0;gap:7px;scrollbar-width:thin}
.ben-wb__particle-focus,.ben-wb__particle-storage{min-width:0;max-height:100%;overflow:auto;scrollbar-width:thin;font-size:12px;line-height:1.5;align-self:start;overflow-wrap:anywhere}
.ben-wb__particle-focus article{border:1px solid var(--wb-surface-border,var(--dsw-alias-border-l1));border-radius:15px;background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2));padding:14px}
.ben-wb__particle-focus h3{font-size:17px;line-height:1.45;margin:9px 0;font-weight:550;letter-spacing:-.025em}
.ben-wb__particle-focus p{margin:7px 0;color:var(--dsw-alias-label-secondary)}
.ben-wb__particle-focus small,.ben-wb__particle-storage small{color:var(--dsw-alias-label-tertiary);font-size:10px}
.ben-wb__particle-storage h4{font-size:11px;letter-spacing:.04em;font-weight:500;margin:0 0 7px;color:var(--dsw-alias-label-secondary)}
.ben-wb__particle-storage section+section{margin-top:15px}.ben-wb__particle-storage ul{list-style:none;padding:0;margin:0;display:grid;gap:5px}
.ben-wb__particle-storage li{border-radius:11px;background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2))}
.ben-wb__particle-storage li>button{border:0;background:transparent;color:inherit;width:100%;padding:10px;text-align:left;display:flex;gap:8px;align-items:center;cursor:pointer}
.ben-wb__particle-storage strong{font-weight:450;display:block;font-size:12px}.ben-wb__particle-storage button small{display:block}
.ben-wb__particle-dot{flex:none;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.45}
.ben-wb__particle-storage [data-notice=confirmation] .ben-wb__particle-dot{background:#cfab60;opacity:1}
.ben-wb__particle-storage [data-notice=completed] .ben-wb__particle-dot{background:var(--dsw-alias-label-secondary);opacity:1}
.ben-wb__particle-storage [data-notice=failed] .ben-wb__particle-dot{background:#cf7474;opacity:1}
.ben-wb__particle-orb{position:relative;width:100%;max-width:480px;height:clamp(110px,calc(100cqh - 150px),380px);display:grid;place-items:center;flex:none;pointer-events:none}
.ben-wb__particle-orb canvas{position:absolute;inset:0;display:block;width:100%;height:100%;min-width:0;min-height:0;pointer-events:none}
.ben-wb__particle-scene .ben-wb__particle-orb{flex-shrink:1;min-height:80px}
.ben-wb__particle-orb>.ben-wb__orb{pointer-events:auto}.ben-wb__particle-orb[data-large=true]{height:min(65cqh,540px);max-width:600px}
.ben-wb__particle-orb[data-notice=neutral]>.ben-wb__orb{--orb-color:var(--dsw-alias-label-primary);--orb-glow:color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent)}
.ben-wb__particle-orb[data-notice=failed]>.ben-wb__orb{--orb-color:#cf7474;--orb-glow:rgba(207,116,116,.3)}
.ben-wb__particle-orb[data-notice=completed]>.ben-wb__orb{--orb-color:var(--dsw-alias-label-primary);--orb-glow:color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent)}
.ben-wb__particle-hit{position:absolute;inset:15%;border:0;background:transparent;cursor:pointer;pointer-events:auto;border-radius:50%}
.ben-wb__particle-a11y{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.ben-wb__particle-busy{position:absolute;left:50%;bottom:4px;transform:translateX(-50%);margin:0;max-width:90%;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary);pointer-events:none;opacity:.75;animation:ben-wb__particle-busy-fade 4s ease forwards}
@keyframes ben-wb__particle-busy-fade{0%{opacity:0}12%{opacity:.75}70%{opacity:.75}100%{opacity:0}}
.ben-wb__particle-mode{margin:0;font-size:14px;font-weight:450;letter-spacing:-.02em;text-align:center}
.ben-wb__particle-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ben-wb__particle-actions button,.ben-wb__particle-focus button,.ben-wb__particle-settings button,.ben-wb__particle-scene .ben-wb__items-center>button{border:1px solid transparent;border-radius:7px;background:var(--wb-surface-soft,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);padding:5px 8px;font-size:11px;cursor:pointer}
.ben-wb__particle-actions button:hover,.ben-wb__particle-storage button:hover,.ben-wb__particle-settings button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__particle-executor{border-top:1px solid var(--dsw-alias-border-l1);margin-top:10px;padding-top:8px}
.ben-wb__session-activity{color:var(--dsw-alias-label-primary)}
.ben-wb__session-digest{border-top:1px solid var(--dsw-alias-border-l1);margin-top:10px;padding-top:8px}.ben-wb__session-digest h4{margin:0 0 6px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.ben-wb__session-digest ol{list-style:none;margin:0;padding:0;display:grid;gap:10px}.ben-wb__session-digest li{border-left:2px solid var(--dsw-alias-border-l1);padding:0 0 0 10px}
.ben-wb__session-digest p{margin:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}.ben-wb__session-digest p small{display:inline-block;min-width:3em;margin-right:6px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.ben-wb__session-digest-did{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px}.ben-wb__session-digest-empty{color:var(--dsw-alias-label-secondary)}
.ben-wb__particle-reply{border-left:2px solid var(--dsw-alias-border-l1);margin:8px 0;padding:2px 0 2px 10px}.ben-wb__particle-reply small{display:block;color:var(--dsw-alias-label-secondary);font-size:10px}.ben-wb__particle-reply p{margin:2px 0 0;white-space:pre-wrap}
.ben-wb__items--particle .ben-wb__items-form{flex:none;position:relative;z-index:2;min-width:0}.ben-wb__items--particle .ben-wb__items-input{min-width:0}
.ben-wb__items--particle .ben-wb__items-receipt{flex:none;position:relative;z-index:2;margin:0;font-size:11px}
.ben-wb__particle-settings{position:relative;z-index:2;margin:8px 10px 14px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ben-wb__particle-quality{display:flex;flex-wrap:wrap;gap:10px;align-items:center;color:var(--dsw-alias-label-primary)}.ben-wb__particle-quality label{display:inline-flex;gap:4px;align-items:center}
.ben-wb__particle-settings fieldset{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin:10px 0;padding:10px;min-width:0}.ben-wb__particle-settings legend{padding:0 6px}
.ben-wb__particle-field{display:grid;grid-template-columns:minmax(100px,1fr) minmax(65px,1.4fr) 66px;align-items:center;gap:8px;margin:7px 0}
.ben-wb__particle-settings input,.ben-wb__particle-settings textarea{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;max-width:100%;min-width:0;padding:4px}
.ben-wb__particle-settings input[type=range]{width:100%;padding:0;accent-color:var(--dsw-alias-label-secondary)}
.ben-wb__particle-settings input[type=file]{display:block;max-width:220px;font-size:10px}.ben-wb__particle-settings textarea{display:block;width:100%;height:70px;margin:8px 0}
.ben-wb__particle-icons{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px;margin-top:8px}.ben-wb__particle-icons button{display:flex;flex-direction:column;align-items:center;gap:5px}.ben-wb__particle-icons img{width:25px;height:25px;background:#ddd;border-radius:4px;padding:3px}
.ben-wb__items--particle>.ben-wb__particle-settings{position:absolute;inset:0 0 44px auto;width:55%;margin:0;padding:8px 12px;overflow:auto;z-index:3;background:var(--wb-surface-card,var(--dsw-alias-bg-layer-1));border-left:1px solid var(--dsw-alias-border-l1);border-top:0}
.ben-wb__particle-settings-head{position:sticky;top:-8px;display:flex;align-items:center;justify-content:space-between;padding:8px 0;background:var(--wb-surface-card,var(--dsw-alias-bg-layer-1));z-index:1}
.ben-wb__items--particle[data-settings=true] .ben-wb__particle-scene{width:45%;grid-template-columns:minmax(0,1fr)}
.ben-wb__items--particle[data-settings=true] .ben-wb__particle-focus,.ben-wb__items--particle[data-settings=true] .ben-wb__particle-storage{display:none}
@container (max-width:680px){.ben-wb__particle-scene{gap:7px;padding:4px;grid-template-columns:minmax(0,1fr) minmax(115px,1.15fr) minmax(0,1fr)}.ben-wb__particle-focus article{padding:8px}.ben-wb__particle-focus h3{font-size:14px}.ben-wb__particle-storage li>button{padding:7px}.ben-wb__particle-field{gap:5px;grid-template-columns:1fr 1fr 56px}}
@container (max-height:210px){.ben-wb__particle-orb{height:100px}.ben-wb__particle-scene{align-items:start;padding-top:0}.ben-wb__particle-mode{font-size:12px}}
${BUTLER_LAYOUT_STYLE}
${BUTLER_COMPOSER_STYLE}
${ASK_CARD_STYLE}
@media(prefers-reduced-motion:reduce){.ben-wb__items--particle *{animation:none!important;transition:none!important}}
`

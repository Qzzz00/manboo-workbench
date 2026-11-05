/** 黑白微光：只改工作台展示面；宿主主题、浮窗、日结与窗口测量保持原样。 */
export const SURFACE_STYLE = String.raw`
.ben-wb{
  --wb-surface-host-bg:var(--dsw-alias-bg-base,#101010);
  --wb-surface-ink:var(--dsw-alias-label-primary,#e8e8e8);
  --wb-surface-bg:color-mix(in srgb,var(--wb-surface-host-bg) 97%,#000);
  --wb-surface-card:color-mix(in srgb,var(--wb-surface-host-bg) 98%,#fff);
  --wb-surface-raised:color-mix(in srgb,var(--wb-surface-card) 98%,#fff);
  --wb-surface-soft:color-mix(in srgb,var(--wb-surface-card) 99%,#fff);
  --wb-surface-hover:color-mix(in srgb,var(--wb-surface-card) 91%,var(--wb-surface-ink));
  --wb-surface-line:color-mix(in srgb,var(--wb-surface-ink) 9%,transparent);
  --wb-surface-edge:color-mix(in srgb,var(--wb-surface-ink) 18%,transparent);
  --wb-surface-muted:color-mix(in srgb,var(--wb-surface-ink) 76%,var(--wb-surface-card));
  --wb-surface-faint:color-mix(in srgb,var(--wb-surface-ink) 64%,var(--wb-surface-card));
  --wb-surface-shadow:0 6px 24px #00000016,inset 0 1px 0 var(--wb-surface-line);
  background:var(--wb-surface-bg);
}
/* Extract neutral lightness from real host tokens. Fallbacks above still follow host contrast. */
@supports (color:hsl(from white h s l)){
  .ben-wb{
    --wb-surface-host-bg:hsl(from var(--dsw-alias-bg-base,#101010) h 0% l);
    --wb-surface-ink:hsl(from var(--dsw-alias-label-primary,#e8e8e8) h 0% l);
  }
}

/* Existing boxes retain their dimensions. Edge/shadow/color are the only material changes. */
.ben-wb .ben-wb__body .ben-wb__card{
  background:var(--wb-surface-card);border-color:var(--wb-surface-line);box-shadow:var(--wb-surface-shadow);
}
.ben-wb .ben-wb__topbar{background:var(--wb-surface-card);border-color:transparent;border-radius:8px;color:var(--wb-surface-muted)}
.ben-wb .ben-wb__body .ben-wb__modhead .ben-wb__ttl,.ben-wb .ben-wb__topagent{color:var(--wb-surface-muted)}
.ben-wb .ben-wb__eyebrow{color:var(--wb-surface-ink)}
.ben-wb .ben-wb__return{background:var(--wb-surface-soft);border-color:var(--wb-surface-edge);color:var(--wb-surface-muted)}
.ben-wb .ben-wb__return:hover{background:var(--wb-surface-hover);color:var(--wb-surface-ink)}
.ben-wb .ben-wb__topstat-val:not(.ben-wb__topstat-val--alert):not(.ben-wb__topstat-val--off){color:var(--wb-surface-ink)}
.ben-wb :is(.ben-wb__topclock,.ben-wb__topstat-label,.ben-wb__topstat-val--off){color:var(--wb-surface-faint)}
.ben-wb :is(.ben-wb__mod-handle-grip,.ben-wb__split-grip){background:var(--wb-surface-edge)}
.ben-wb :is(.ben-wb__mod-handle:hover,.ben-wb__mod-handle[data-dragging=true]) .ben-wb__mod-handle-grip,
.ben-wb :is(.ben-wb__split:hover,.ben-wb__split[data-dragging=true]) .ben-wb__split-grip{background:var(--wb-surface-muted)}

/* Quiet surface, bright project name, supporting sentence, then metadata. */
.ben-wb .ben-wb__pj{background:var(--wb-surface-soft);border-color:var(--wb-surface-line);border-left-color:var(--wb-surface-edge);border-radius:9px}
.ben-wb .ben-wb__pj[data-tone=hot]{border-left-color:var(--wb-surface-ink)}
.ben-wb .ben-wb__pj[data-tone=warn]{border-left-color:var(--dsw-alias-state-warn-label)}
.ben-wb .ben-wb__pj-name{color:var(--wb-surface-ink)}
.ben-wb .ben-wb__pj-status:not(.ben-wb__pj-status--stale){color:var(--wb-surface-muted)}
.ben-wb :is(.ben-wb__pj-stage,.ben-wb__pj-risk:not([data-risk=tight]):not([data-risk=late])){background:var(--wb-surface-raised);color:var(--wb-surface-faint)}
.ben-wb :is(.ben-wb__pj-activity,.ben-wb__pj-calc:not(.ben-wb__pj-calc--error),.ben-wb__pj-extra){color:var(--wb-surface-muted)}
.ben-wb :is(.ben-wb__pj-status-meta,.ben-wb__pj-pending){color:var(--wb-surface-faint)}
.ben-wb .ben-wb__pj-extra{border-color:var(--wb-surface-line)}

/* Ordinary controls share a neutral selection; semantic priority marks retain their colors. */
.ben-wb :is(.ben-wb__viewswitch,.ben-wb__axis,.ben-wb__sprint-tabs) button,
.ben-wb :is(.ben-wb__ptab,.ben-wb__board .ben-wb__chip,.ben-wb__sprint-edit,.ben-wb__board-pick){
  background:var(--wb-surface-soft);border-color:var(--wb-surface-edge);color:var(--wb-surface-muted);
}
.ben-wb :is(.ben-wb__viewswitch,.ben-wb__axis,.ben-wb__sprint-tabs) button[data-on=true],
.ben-wb .ben-wb__ptab[data-on=true],
.ben-wb .ben-wb__board .ben-wb__chip[data-on=true]{
  background:var(--wb-surface-hover);border-color:var(--wb-surface-edge);color:var(--wb-surface-ink);box-shadow:inset 0 -1px 0 var(--wb-surface-ink);
}
.ben-wb .ben-wb__board .ben-wb__chip[data-priority=high][data-on=true]{color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 -1px 0 currentColor}
.ben-wb .ben-wb__board .ben-wb__chip[data-priority=mid][data-on=true],
.ben-wb .ben-wb__board .ben-wb__chip[data-block][data-on=true]{color:var(--dsw-alias-state-warn-label);box-shadow:inset 0 -1px 0 currentColor}
.ben-wb :is(.ben-wb__viewswitch,.ben-wb__axis,.ben-wb__sprint-tabs) button:hover:not(:disabled),
.ben-wb :is(.ben-wb__ptab,.ben-wb__board .ben-wb__chip,.ben-wb__sprint-edit,.ben-wb__board-pick):hover:not(:disabled){background:var(--wb-surface-hover);border-color:var(--wb-surface-muted)}
.ben-wb .ben-wb__ptabs{border-color:var(--wb-surface-line)}
.ben-wb .ben-wb__ptab-name{color:var(--wb-surface-ink)}
.ben-wb :is(.ben-wb__ptab-bar[data-priority=low],.ben-wb__task-prio[data-priority=low]){background:var(--wb-surface-muted)}
.ben-wb .ben-wb__board .ben-wb__task-who{background:var(--wb-surface-raised);color:var(--wb-surface-muted)}
.ben-wb :is(.ben-wb__pmeta,.ben-wb__sprint-editor label){color:var(--wb-surface-muted)}
.ben-wb :is(.ben-wb__pmeta-tag,.ben-wb__sprint-when,.ben-wb__sprint-blank,.ben-wb__board-pickempty){color:var(--wb-surface-faint)}
.ben-wb .ben-wb__sprint{background:var(--wb-surface-soft);border-color:var(--wb-surface-line);box-shadow:inset 0 1px 0 var(--wb-surface-line)}
.ben-wb :is(.ben-wb__sprint-goal,.ben-wb__sprint-vers){color:var(--wb-surface-ink)}
.ben-wb :is(.ben-wb__sprint-ver,.ben-wb__sprint-tag){background:var(--wb-surface-raised);color:var(--wb-surface-muted)}
.ben-wb .ben-wb__sprint-editor{border-color:var(--wb-surface-line)}
.ben-wb .ben-wb__meter-track{background:var(--wb-surface-edge)}
.ben-wb .ben-wb__meter-fill{background:var(--wb-surface-ink)}
.ben-wb .ben-wb__meter[data-tone=time] .ben-wb__meter-fill{background:var(--wb-surface-muted)}
.ben-wb .ben-wb__meter-label{color:var(--wb-surface-faint)}
.ben-wb .ben-wb__board-head{background:var(--wb-surface-card)}
.ben-wb .ben-wb__board-colname:not([data-attention=true]){color:var(--wb-surface-muted)}
.ben-wb .ben-wb__board-count{background:var(--wb-surface-raised);color:var(--wb-surface-faint)}
.ben-wb .ben-wb__board-colname[data-attention=true] .ben-wb__board-count{background:var(--dsw-alias-state-warn-label);color:var(--wb-surface-card)}
.ben-wb .ben-wb__board-cell{background:var(--wb-surface-soft)}
.ben-wb .ben-wb__board-cell[data-status=confirm]{background:color-mix(in srgb,var(--dsw-alias-state-warn-label) 5%,var(--wb-surface-soft))}
.ben-wb .ben-wb__board-cell[data-over=true]{background:var(--wb-surface-hover);border-color:var(--wb-surface-ink)}
.ben-wb .ben-wb__task{background:var(--wb-surface-raised);border-color:var(--wb-surface-line);border-left-color:var(--wb-surface-edge);box-shadow:0 3px 12px #00000010}
.ben-wb .ben-wb__task[data-priority=high]{border-left-color:var(--dsw-alias-state-error-primary)}
.ben-wb .ben-wb__task[data-priority=mid]{border-left-color:var(--dsw-alias-state-warn-label)}
.ben-wb .ben-wb__task[data-status=blocked]{border-color:var(--dsw-alias-state-warn-label)}
.ben-wb .ben-wb__task-title{color:var(--wb-surface-ink)}
.ben-wb .ben-wb__task:hover{background:var(--wb-surface-hover)}
.ben-wb :is(.ben-wb__task-src,.ben-wb__task-deliv:not([data-empty=true])){background:var(--wb-surface-soft);color:var(--wb-surface-muted)}
.ben-wb :is(.ben-wb__task-due:not([data-tight=true]),.ben-wb__task-spend){color:var(--wb-surface-faint)}
.ben-wb .ben-wb__board-picklist{background:var(--wb-surface-raised);border-color:var(--wb-surface-edge);box-shadow:var(--wb-surface-shadow)}
.ben-wb .ben-wb__board-picklist button{color:var(--wb-surface-ink)}
.ben-wb .ben-wb__lane-title{color:var(--wb-surface-ink)}
.ben-wb :is(.ben-wb__lane-goal,.ben-wb__board-more){color:var(--wb-surface-faint)}
.ben-wb :is(.ben-wb__lane-editor,.ben-wb__lane-new) :is(input,textarea,select,button){background:var(--wb-surface-soft);border-color:var(--wb-surface-edge);color:var(--wb-surface-ink)}
/* Task details remain inside the board; these never target the day-end or floating dialogs. */
.ben-wb .ben-wb__board .ben-wb__dlg{background:var(--wb-surface-card);border-color:var(--wb-surface-edge);box-shadow:var(--wb-surface-shadow)}
.ben-wb .ben-wb__board :is(.ben-wb__dlg-head,.ben-wb__dlg-foot){border-color:var(--wb-surface-line)}
.ben-wb .ben-wb__board :is(.ben-wb__dlg-title,.ben-wb__dlg-close){color:var(--wb-surface-ink)}
.ben-wb .ben-wb__board :is(.ben-wb__dlg-where,.ben-wb__dlg-field){color:var(--wb-surface-faint)}
.ben-wb .ben-wb__board :is(.ben-wb__dlg-field,.ben-wb__deliv-add) :is(input,textarea,select),
.ben-wb .ben-wb__board :is(.ben-wb__dlg-steps button,.ben-wb__link,.ben-wb__deliv,.ben-wb__dlg-addlink){background:var(--wb-surface-soft);border-color:var(--wb-surface-edge);color:var(--wb-surface-muted)}
.ben-wb .ben-wb__board .ben-wb__dlg-steps button[data-on=true]{background:var(--wb-surface-hover);border-color:var(--wb-surface-edge);color:var(--wb-surface-ink);box-shadow:inset 0 -1px 0 var(--wb-surface-ink)}
.ben-wb .ben-wb__board .ben-wb__dlg-done{border-color:var(--wb-surface-edge)!important;color:var(--wb-surface-ink)!important}

/* Consumption: neutral numeric hierarchy, five monotonic intensities in either host theme. */
.ben-wb .ben-wb__usage-seg{background:var(--wb-surface-soft);box-shadow:inset 0 0 0 1px var(--wb-surface-line)}
.ben-wb .ben-wb__usage-segbtn{color:var(--wb-surface-muted)}
.ben-wb .ben-wb__usage-segbtn[data-on=true]{background:var(--wb-surface-hover);color:var(--wb-surface-ink);box-shadow:inset 0 -1px 0 var(--wb-surface-ink)}
.ben-wb .ben-wb__usage-tile{background:var(--wb-surface-soft);border-radius:6px}
.ben-wb .ben-wb__usage-tile--primary{background:transparent;border-color:var(--wb-surface-line)}
.ben-wb .ben-wb__usage-tile-v{color:var(--wb-surface-muted)}
.ben-wb :is(.ben-wb__usage-tile--primary .ben-wb__usage-tile-v,.ben-wb__usage-hero-v){color:var(--wb-surface-ink)}
.ben-wb :is(.ben-wb__usage-tile-l,.ben-wb__usage-hero-l,.ben-wb__usage-heathead,.ben-wb__usage-heatdays span,.ben-wb__usage-ranksub,.ben-wb__usage-rest){color:var(--wb-surface-faint)}
.ben-wb :is(.ben-wb__usage-hint,.ben-wb__usage-rankname,.ben-wb__usage-note){color:var(--wb-surface-muted)}
.ben-wb .ben-wb__usage-rankval{color:var(--wb-surface-ink)}
.ben-wb :is(.ben-wb__usage-rankbar,.ben-wb__usage-qtrack){background:var(--wb-surface-edge)}
.ben-wb .ben-wb__usage-rankfill{background:var(--wb-surface-ink)}
.ben-wb .ben-wb__usage-q{background:var(--wb-surface-soft);border-color:var(--wb-surface-line);border-radius:8px}
.ben-wb :is(.ben-wb__usage-qname,.ben-wb__usage-qlabel,.ben-wb__usage-qpct,.ben-wb__usage-qnote,.ben-wb__usage-qpeak:not([data-phase=peak])){color:var(--wb-surface-muted)}
.ben-wb .ben-wb__usage-quotattl{color:var(--wb-surface-faint)}
.ben-wb .ben-wb__usage-qval:not([data-level=warn]):not([data-level=danger]){color:var(--wb-surface-ink)}
.ben-wb .ben-wb__usage-qtrack i:not([data-level=warn]):not([data-level=danger]){background:var(--wb-surface-ink)}
.ben-wb .ben-wb__usage-heatcell[data-level="0"]:not([data-future=true]){background:color-mix(in srgb,var(--wb-surface-ink) 9%,var(--wb-surface-card))}
.ben-wb .ben-wb__usage-heatcell[data-level="1"]{background:color-mix(in srgb,var(--wb-surface-ink) 25%,var(--wb-surface-card))}
.ben-wb .ben-wb__usage-heatcell[data-level="2"]{background:color-mix(in srgb,var(--wb-surface-ink) 45%,var(--wb-surface-card))}
.ben-wb .ben-wb__usage-heatcell[data-level="3"]{background:color-mix(in srgb,var(--wb-surface-ink) 68%,var(--wb-surface-card))}
.ben-wb .ben-wb__usage-heatcell[data-level="4"]{background:var(--wb-surface-ink)}
.ben-wb .ben-wb__usage-heatcell[data-future=true]{background:transparent;box-shadow:inset 0 0 0 1px var(--wb-surface-line)}
/* The legend fits inside the existing single text line, without altering heatmap height. */
.ben-wb .ben-wb__usage-heatlegend{display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
.ben-wb .ben-wb__usage-heatlegend .ben-wb__usage-heatcell{display:inline-block;width:7px;height:7px}

/* Window tabs only: no SlotZone box or native window lifecycle rules. */
.ben-wb .ben-wb__dock-tab{background:var(--wb-surface-soft);border-color:var(--wb-surface-line)}
.ben-wb .ben-wb__dock-tab[data-current=true]{background:var(--wb-surface-hover);box-shadow:inset 0 -1px 0 var(--wb-surface-ink)}
.ben-wb .ben-wb__dock-tab-name{color:var(--wb-surface-muted)}
.ben-wb .ben-wb__dock-tab[data-current=true] .ben-wb__dock-tab-name{color:var(--wb-surface-ink)}
.ben-wb .ben-wb__dock-tab[data-running=false] .ben-wb__dock-tab-name,
.ben-wb :is(.ben-wb__dock-tab-close,.ben-wb__dock-tab-dual){color:var(--wb-surface-faint)}
.ben-wb .ben-wb__dock-tab-close:hover{color:var(--dsw-alias-state-error-primary)}

/* File/note tools and module controls. No global button, input or descendant recoloring. */
.ben-wb :is(.ben-wb__filesbar,.ben-wb__modbtns) button,
.ben-wb :is(.ben-wb__topgear,.ben-wb__wiki-search,.ben-wb__inbox-undo,.ben-wb__inbox-backfill,.ben-wb__wiki-card-reveal){background:var(--wb-surface-soft);color:var(--wb-surface-muted);border-color:var(--wb-surface-edge)}
.ben-wb .ben-wb__filesbar button[aria-pressed=true]{background:var(--wb-surface-hover);color:var(--wb-surface-ink);box-shadow:inset 0 -1px 0 var(--wb-surface-ink)}
.ben-wb :is(.ben-wb__pj-status-edit .ben-wb__inp,.ben-wb__inp[aria-label="随手记一句"],.ben-wb__sprint-editor input,.ben-wb__sprint-editor textarea,.ben-wb__sprint-tabs input,.ben-wb__board-new input){background:var(--wb-surface-soft);color:var(--wb-surface-ink);border-color:var(--wb-surface-edge)}
.ben-wb :is(.ben-wb__pj-status-edit .ben-wb__inp,.ben-wb__inp[aria-label="随手记一句"],.ben-wb__wiki-search)::placeholder{color:var(--wb-surface-faint)}
.ben-wb .ben-wb__pj-confirm{background:var(--wb-surface-ink);color:var(--wb-surface-bg)}
.ben-wb .ben-wb__pj-confirm:hover{background:var(--wb-surface-muted)}
.ben-wb .ben-wb__notes{color:var(--wb-surface-muted)}
.ben-wb .ben-wb__wiki-card{background:var(--wb-surface-raised);border-color:var(--wb-surface-edge);box-shadow:var(--wb-surface-shadow)}
.ben-wb .ben-wb__wiki-node{stroke:var(--wb-surface-edge)}
.ben-wb .ben-wb__wiki-node[data-kind=file]{fill:var(--wb-surface-soft)}
.ben-wb .ben-wb__wiki-node[data-kind=collapsed]{fill:var(--wb-surface-edge)}
.ben-wb .ben-wb__wiki-node:is([data-lit=true],[data-match=true],[data-focused=true]){stroke:var(--wb-surface-ink)}
.ben-wb .ben-wb__wiki-node:is([data-selected=true],[data-flashing=true]){fill:var(--wb-surface-ink)}
.ben-wb .ben-wb__wiki-label{fill:var(--wb-surface-faint)}
.ben-wb .ben-wb__wiki-label:is([data-kind=project],[data-kind=dir]){fill:var(--wb-surface-muted)}
.ben-wb .ben-wb__body :is(.ben-wb__empty,.ben-wb__lines,.ben-wb__wiki-notes,.ben-wb__wiki-hits,.ben-wb__inbox-count){color:var(--wb-surface-faint)}
.ben-wb :is(.ben-wb__filesbar,.ben-wb__modbtns) button:hover:not(:disabled),
.ben-wb :is(.ben-wb__usage-segbtn,.ben-wb__dock-tab-name,.ben-wb__topgear):hover:not(:disabled){background:var(--wb-surface-hover);color:var(--wb-surface-ink)}
/* Scope focus to the permitted controls; original danger and disabled states stay meaningful. */
.ben-wb :is(.ben-wb__board,.ben-wb__viewswitch,.ben-wb__usage,.ben-wb__filesbar,.ben-wb__modbtns,.ben-wb__dock-tabs,.ben-wb__pj,.ben-wb__wiki) :is(button,input,textarea,select):focus-visible,
.ben-wb :is(.ben-wb__inp[aria-label="随手记一句"],.ben-wb__topgear):focus-visible{outline:2px solid var(--wb-surface-ink);outline-offset:2px;border-color:var(--wb-surface-muted)}
@media(prefers-reduced-motion:reduce){
  .ben-wb :is(.ben-wb__usage-segbtn,.ben-wb__usage-rankfill,.ben-wb__dock-tab,.ben-wb__wiki-node,.ben-wb__mod-handle-grip,.ben-wb__split-grip),
  .ben-wb .ben-wb__filesbar button,.ben-wb .ben-wb__pj-status-edit .ben-wb__inp,.ben-wb .ben-wb__inp[aria-label="随手记一句"]{transition:none}
}
`

/** Reading-first composition, scoped to module interiors. No host tokens or slot geometry. */
export const COMPOSITION_STYLE = `
/* Quiet controls: selection uses tone, never an underline or side stripe. */
.ben-wb :is(.ben-wb__viewswitch,.ben-wb__axis,.ben-wb__sprint-tabs) button,
.ben-wb :is(.ben-wb__ptab,.ben-wb__usage-segbtn,.ben-wb__board .ben-wb__chip,.ben-wb__board .ben-wb__dlg-steps button){border:0;box-shadow:none;border-radius:5px;white-space:nowrap}
.ben-wb :is(.ben-wb__viewswitch,.ben-wb__axis,.ben-wb__sprint-tabs) button[data-on=true],
.ben-wb :is(.ben-wb__ptab,.ben-wb__usage-segbtn,.ben-wb__board .ben-wb__chip,.ben-wb__board .ben-wb__dlg-steps button)[data-on=true]{box-shadow:none;border:0;background:var(--wb-surface-hover)}
.ben-wb .ben-wb__board .ben-wb__chip[data-on=true],
.ben-wb .ben-wb__board .ben-wb__chip[data-priority][data-on=true],
.ben-wb .ben-wb__board .ben-wb__chip[data-block][data-on=true]{box-shadow:none}
.ben-wb .ben-wb__ptab-bar{display:none}
.ben-wb .ben-wb__usage-seg{box-shadow:none}
.ben-wb .ben-wb__dock-tab[data-current=true]{box-shadow:none}
.ben-wb .ben-wb__filesbar button[aria-pressed=true]{box-shadow:none}

/* The project canvas can scroll even when its settings exceed a short module. */
.ben-wb .ben-wb__board{gap:10px;overflow:auto;overscroll-behavior:contain;container-type:inline-size;--wb-head:170px;--wb-gap:6px}
.ben-wb .ben-wb__board-scroll{min-height:160px}
.ben-wb .ben-wb__viewswitch{gap:3px;margin-bottom:9px;align-self:flex-start}
.ben-wb .ben-wb__viewswitch button{padding:5px 11px;font-size:12px}
.ben-wb .ben-wb__ptabs{flex-wrap:nowrap;overflow-x:auto;gap:4px;border:0;padding:0 0 3px}
.ben-wb .ben-wb__ptab{flex:none;gap:6px;max-width:300px;padding:6px 9px;font-size:12px;background:transparent}
.ben-wb .ben-wb__ptab:not([data-on=true]) :is(.ben-wb__task-who,.ben-wb__task-due){display:none}
.ben-wb .ben-wb__ptab .ben-wb__task-who{background:transparent;padding:0}
.ben-wb .ben-wb__ptab-name{font-weight:500}
.ben-wb .ben-wb__ptab[data-on=true] .ben-wb__ptab-name{font-weight:650}
.ben-wb .ben-wb__pmeta{gap:8px 16px;align-items:center}
.ben-wb .ben-wb__project-title{display:flex;flex:1 1 170px;min-width:0;align-items:baseline;gap:9px;flex-wrap:wrap}
.ben-wb .ben-wb__project-title h2{font-size:22px;font-weight:600;line-height:1.2;letter-spacing:-.025em;margin:0;color:var(--wb-surface-ink);overflow-wrap:anywhere}
.ben-wb .ben-wb__project-title>span{font-size:11px;color:var(--wb-surface-faint);white-space:nowrap}
.ben-wb .ben-wb__project-title>span[data-priority=high]{color:var(--dsw-alias-state-error-primary)}
.ben-wb .ben-wb__project-title>span[data-priority=mid]{color:var(--dsw-alias-state-warn-label)}
.ben-wb .ben-wb__board-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0;min-width:0}
.ben-wb .ben-wb__board-bar>button{border:0;border-radius:5px;padding:5px 8px;font-size:11px;background:var(--wb-surface-soft);color:var(--wb-surface-muted);white-space:nowrap;cursor:pointer}
.ben-wb .ben-wb__board-bar>button:hover{background:var(--wb-surface-hover);color:var(--wb-surface-ink)}
.ben-wb .ben-wb__axis button{padding:5px 8px;font-size:11px}
.ben-wb .ben-wb__project-settings{order:3;flex-basis:100%;display:flex;flex-wrap:wrap;gap:10px 18px;padding:10px 0;border-top:1px solid var(--wb-surface-line)}
.ben-wb .ben-wb__pmeta-item{flex-wrap:wrap;gap:6px}
.ben-wb .ben-wb__pmeta-tag{white-space:nowrap}
.ben-wb .ben-wb__pmeta-due{flex-wrap:wrap}
.ben-wb .ben-wb__project-settings .ben-wb__chip{padding:5px 8px;border-radius:4px}
.ben-wb .ben-wb__sprint{padding:9px 0 10px;gap:7px;border:0;border-bottom:1px solid var(--wb-surface-line);border-radius:0;background:transparent;box-shadow:none}
.ben-wb .ben-wb__sprint-tabs{gap:3px}
.ben-wb .ben-wb__sprint-tabs button{padding:4px 8px;font-size:11px}
.ben-wb .ben-wb__sprint-head{gap:7px 14px;font-size:12px}
.ben-wb .ben-wb__sprint-goal{flex:1 1 100%;align-items:baseline}
.ben-wb .ben-wb__sprint-goal>span:last-child{max-width:none;white-space:normal;overflow:visible;font-size:14px;line-height:1.45}
.ben-wb .ben-wb__sprint-vers{flex-wrap:wrap;gap:6px}
.ben-wb :is(.ben-wb__sprint-tag,.ben-wb__sprint-ver){background:transparent;padding:0;white-space:nowrap}
.ben-wb .ben-wb__sprint-tag{font-size:10px;color:var(--wb-surface-faint)}
.ben-wb .ben-wb__sprint-edit{padding:3px 7px;border:0;background:var(--wb-surface-soft)}
.ben-wb .ben-wb__task{padding:10px;box-shadow:none;border-radius:7px}
.ben-wb .ben-wb__task-title{font-size:14px;line-height:1.5;font-weight:500}
.ben-wb .ben-wb__board-colname{padding:6px 4px;font-size:11px}
.ben-wb .ben-wb__board-count{background:transparent;padding:0 3px}
.ben-wb .ben-wb__board-coltitle{white-space:nowrap}
.ben-wb .ben-wb__board-cell-heading{display:none}

/* Narrow modules read vertically using the same cells and callbacks. No duplicated cards,
   no axis preference writes, no automatic scroll. Empty states remain reachable drop targets. */
@container (max-width:1100px){
  .ben-wb .ben-wb__board-scroll{display:flex;flex-direction:column;gap:10px;overflow-x:hidden}
  .ben-wb .ben-wb__board-head,.ben-wb .ben-wb__board-lane{display:flex;flex-direction:column;gap:6px;min-width:0;flex:none}
  .ben-wb .ben-wb__board-scroll:not([data-axis=module-columns]) .ben-wb__board-head{flex-direction:row;flex-wrap:wrap;gap:6px 12px;order:-2}
  .ben-wb .ben-wb__board-lane:has(.ben-wb__task){order:-1}
  .ben-wb .ben-wb__board-head{position:static;flex:none}
  .ben-wb .ben-wb__board-corner{display:none}
  .ben-wb .ben-wb__board-lanename{width:auto;min-width:0;padding:8px 0;order:-2;flex:none}
  .ben-wb .ben-wb__board-cell{min-height:0;padding:6px;flex:none;gap:6px}
  .ben-wb .ben-wb__board-cell:has(.ben-wb__task){order:-1}
  .ben-wb .ben-wb__board-cell-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;line-height:1.5;color:var(--wb-surface-faint)}
  .ben-wb .ben-wb__board-cell[data-status=confirm] .ben-wb__board-cell-heading,.ben-wb .ben-wb__board-cell[data-status=blocked] .ben-wb__board-cell-heading{color:var(--dsw-alias-state-warn-label)}
  .ben-wb .ben-wb__board-scroll[data-axis=module-columns] .ben-wb__board-head{order:-2}
  .ben-wb .ben-wb__board-colname{flex:none}
}
@container (min-width:600px) and (max-width:1100px){
  .ben-wb .ben-wb__board-lane{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))!important;align-items:start}
  .ben-wb .ben-wb__board-lane>.ben-wb__board-lanename,.ben-wb .ben-wb__board-lane>.ben-wb__board-colname{grid-column:1/-1;order:-2}
  .ben-wb .ben-wb__board-scroll[data-axis=module-columns] .ben-wb__board-head{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))!important}
}

/* Overview: name, status sentence, evidence metadata. */
.ben-wb .ben-wb__pj{padding:14px 2px;gap:7px;border:0;border-bottom:1px solid var(--wb-surface-line);border-radius:0;background:transparent}
.ben-wb .ben-wb__pj-name{font-size:18px;line-height:1.3;font-weight:600}
.ben-wb .ben-wb__pj-stage{background:transparent;padding:0;font-size:10px;white-space:nowrap}
.ben-wb .ben-wb__pj-status{font-size:14px;line-height:1.5}
.ben-wb .ben-wb__pj-activity{margin:0;font-size:11px;color:var(--wb-surface-faint)}
.ben-wb .ben-wb__pj-calc{margin:0;font-size:11px;line-height:1.5}

/* A large primary number; supporting facts use whitespace, not eleven boxes. */
.ben-wb .ben-wb__usage{gap:16px;container-type:inline-size}
.ben-wb .ben-wb__usage-bar{flex-wrap:wrap;gap:8px;flex:none}
.ben-wb .ben-wb__usage-seg{flex:none;max-width:100%}
.ben-wb .ben-wb__usage-segbtn{flex:none;padding:5px 9px;white-space:nowrap}
.ben-wb .ben-wb__usage-tiles{display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap;flex:none}
.ben-wb .ben-wb__usage-tile{padding:0;border:0;background:transparent;border-radius:0;min-width:0}
.ben-wb .ben-wb__usage-tile--primary{flex:1 1 170px;padding:0}
.ben-wb .ben-wb__usage-tile--primary .ben-wb__usage-tile-v,.ben-wb .ben-wb__usage-hero-v{font-size:44px;line-height:1.12;font-weight:550;letter-spacing:-.045em;margin:5px 0 0}
.ben-wb .ben-wb__usage-tile-l{font-size:11px;line-height:1.45;overflow-wrap:normal;word-break:keep-all}
.ben-wb .ben-wb__usage-tile-v{font-size:18px;font-weight:500;line-height:1.35;margin-top:3px}
.ben-wb .ben-wb__usage-group{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px;flex:none}
.ben-wb .ben-wb__usage-group h3{grid-column:1/-1;margin:0;font-size:11px;font-weight:500;color:var(--wb-surface-faint)}
.ben-wb .ben-wb__usage-activity{gap:18px;padding-bottom:3px}
.ben-wb .ben-wb__usage-activity .ben-wb__usage-tile-v{font-size:23px;color:var(--wb-surface-ink)}
.ben-wb .ben-wb__usage-heatwrap{margin:0;padding:12px 0;flex:none;border-top:1px solid var(--wb-surface-line);border-bottom:1px solid var(--wb-surface-line)}
.ben-wb .ben-wb__usage-heathead{flex-wrap:wrap;gap:7px;font-size:10px}
.ben-wb .ben-wb__usage-habits .ben-wb__usage-tile{display:flex;flex-wrap:wrap;gap:3px 10px;align-items:baseline}
.ben-wb .ben-wb__usage-habits .ben-wb__usage-tile-v{font-size:12px;margin:0;white-space:normal;overflow-wrap:anywhere}
.ben-wb .ben-wb__usage-method{flex:none;font-size:11px;color:var(--wb-surface-faint)}
.ben-wb .ben-wb__usage-method summary{cursor:pointer;white-space:nowrap;padding:3px 0}
.ben-wb .ben-wb__usage-method summary:focus-visible{outline:2px solid var(--wb-surface-ink);outline-offset:2px}
.ben-wb .ben-wb__usage-hint{line-height:1.7;margin:8px 0 0}
/* 没有用量来源的那几家(2026-10-02;2026-10-03 随产品研发那一版面板一起接回来):
   那一格里写的是一句话,不是一个数 —— 所以字号按「使用习惯」那一组的说法走,
   不摆成 18px 的大数字冒充有数。 */
.ben-wb .ben-wb__usage-unwired .ben-wb__usage-tile-v{font-size:13px;white-space:normal;overflow-wrap:anywhere;color:var(--wb-surface-faint)}
.ben-wb .ben-wb__usage-unwired .ben-wb__usage-hint{grid-column:1/-1;margin:4px 0 0}
@container (min-width:480px){.ben-wb .ben-wb__usage-cache{grid-template-columns:repeat(4,minmax(0,1fr))}.ben-wb .ben-wb__usage-habits{grid-template-columns:repeat(2,minmax(0,1fr))}}

/* Every provider has the same name/value/notes columns. Balances have no meter. */
.ben-wb .ben-wb__usage-quotagrid{display:flex;flex-direction:column;gap:0}
.ben-wb .ben-wb__usage-q{display:grid;grid-template-columns:64px minmax(0,1fr) auto;column-gap:10px;row-gap:0;padding:3px 0;background:transparent;border:0;border-bottom:1px solid var(--wb-surface-line);border-radius:0;align-items:center}
.ben-wb .ben-wb__usage-qhead{display:contents}
.ben-wb .ben-wb__usage-qname{grid-column:1;grid-row:1;font-size:12px;white-space:nowrap;align-self:baseline;color:var(--wb-surface-ink)}
.ben-wb .ben-wb__usage-qval{grid-column:2;grid-row:1;font-size:20px;line-height:1.2}
.ben-wb .ben-wb__usage-qbars{grid-column:2;grid-row:1;margin:0;gap:3px}
.ben-wb .ben-wb__usage-qbar{display:grid;grid-template-columns:34px minmax(16px,1fr) 36px;gap:7px}
.ben-wb .ben-wb__usage-qtrack{height:5px}
.ben-wb .ben-wb__usage-qlabel{white-space:nowrap;font-size:10px}
.ben-wb .ben-wb__usage-qnote,.ben-wb .ben-wb__usage-qpeak{grid-column:2;margin:0;font-size:10px;line-height:1.6}
.ben-wb .ben-wb__usage-qdetails{grid-column:3;grid-row:1;min-width:0;max-width:110px;font-size:11px;color:var(--wb-surface-faint)}
.ben-wb .ben-wb__usage-qdetails summary{max-width:110px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;line-height:1.5}
.ben-wb .ben-wb__usage-qdetails summary[data-phase=peak]{color:var(--dsw-alias-state-warn-label)}
.ben-wb .ben-wb__usage-qdetails[open]{grid-column:1/-1;grid-row:2;max-width:none;padding:5px 0}
.ben-wb .ben-wb__usage-qdetails[open] summary{max-width:none;white-space:normal}
.ben-wb .ben-wb__usage-qdetails .ben-wb__usage-qnote{font-size:11px;margin-top:4px}
.ben-wb .ben-wb__usage-qdetails summary:focus-visible{outline:2px solid var(--wb-surface-ink);outline-offset:2px}
`

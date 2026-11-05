/**
 * 新 UI 第二轮(2026-10-22):维护者点的几处,值取 Codex 全局评审页 0cf75042
 * `设计-全局UI视觉-A-2026-10-21.html#screen=landscape&theme=dark&slot=original&group=agents`(统筹 10-22 转维护者:以这一屏为准,
 * 工作台 Pen 那四张整屏是「旧稿 · 待逐格修订」,不作依据)。每条断言写着值出自这一屏的哪一处;对照表见 `docs/交接-1022-新UI第二轮.md`。
 */
import { describe, expect, it } from 'vitest'
import { COLLAB_STYLE } from '../src/client/collab/collabStyle.ts'
import { MONO_STYLE } from '../src/client/monoStyle.ts'
import { STYLE } from '../src/client/style.ts'
import { MONO_DARK, MONO_LIGHT, MONO_SCALE } from '../src/client/tokens.ts'

/** 取选择器恰好是 `selector` 的那一条规则的声明块。 */
function rule(selector: string, css = MONO_STYLE): string {
  const at = css.indexOf(`${selector}{`)
  expect(at, `样式里没有 ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(at + selector.length + 1, css.indexOf('}', at))
}

describe('① 窗口槽、项目区的头挪到卡外一行(10-22 拍板 8 / 9 / 11,评审页 `.slot-tabs`)', () => {
  it('高 27、间 6、与卡隔 7;标题 10px 弱字、字距 .4', () => {
    expect(rule('.ben-wb .ben-wb__modhead--outside')).toBe('flex:none;display:flex;align-items:center;gap:6px;height:27px;margin:0 0 7px;padding:0;font-size:10px')
    expect(rule('.ben-wb .ben-wb__body .ben-wb__modhead--outside .ben-wb__ttl')).toBe('margin:0;color:var(--wb-faint);font-size:10px;font-weight:400;line-height:1.5;letter-spacing:.4px')
  })
  it('「事务官 / 设置」11px、高 24、内边距 2 / 8,当前那一档纸面底', () => {
    expect(rule('.ben-wb .ben-wb__slotmodes button')).toContain('min-height:24px;padding:2px 8px')
    expect(rule('.ben-wb .ben-wb__slotmodes button')).toContain('font:400 11px/1.5 var(--wb-font)')
    expect(rule('.ben-wb .ben-wb__slotmodes button[aria-pressed=true]')).toBe('background:var(--wb-paper)')
  })
  it('卡里那一份头的老规则退场', () => {
    expect(MONO_STYLE).not.toContain('.ben-wb__mod[data-module-box=slot]>.ben-wb__card--fill>.ben-wb__modhead')
  })
  it('竖屏那一排横标签(稿里没有)排在卡顶:上 10、左右 20', () => {
    expect(rule('.ben-wb .ben-wb__mod[data-module-box=slot]>.ben-wb__card--fill>.ben-wb__dock')).toBe('padding:10px 20px 0')
  })
})

describe('③ 标签:照左栏 `.app-rail`,选中不反色', () => {
  it('一行高 30、圆角 6;名字 12 / 400 主字色、内边距 4 / 9、图标隔 6', () => {
    const tab = rule('.ben-wb .ben-wb__dock-tab')
    expect(tab).toContain('min-height:30px')
    expect(tab).toContain('border-radius:6px')
    const name = rule('.ben-wb .ben-wb__dock-tab .ben-wb__dock-tab-name,.ben-wb .ben-wb__dock-tab .ben-wb__dock-tab-name:hover:not(:disabled)')
    for (const one of ['gap:6px', 'padding:4px 9px', 'background:transparent', 'color:var(--wb-ink)', 'font-size:12px', 'font-weight:400']) expect(name).toContain(one)
  })
  it('选中 = 纸面底 + 600;不再是主字色底反色字', () => {
    expect(rule('.ben-wb .ben-wb__dock-tab[data-current=true]')).toBe('background:var(--wb-paper)')
    expect(rule('.ben-wb .ben-wb__dock-tab[data-current=true] .ben-wb__dock-tab-name,.ben-wb .ben-wb__dock-tab[data-current=true] .ben-wb__dock-tab-name:hover:not(:disabled)')).toBe('font-weight:600')
    expect(MONO_STYLE).not.toContain('var(--wb-reverse);font-weight:600')
    expect(MONO_STYLE).not.toMatch(/dock-tab\[data-current=true\][^{]*\{[^}]*background:var\(--wb-ink\)/)
  })
  it('名字那半的悬停压得住 surface.ts 那条 (0,4,0) 悬停底 —— 不再出现一半灰一半白', () => {
    expect(MONO_STYLE).toContain('.ben-wb .ben-wb__dock-tab .ben-wb__dock-tab-name:hover:not(:disabled)')
  })
  // 10-22 第三轮 7(维护者):除「在跑」呼吸那颗外,各档徽章的底色都要回来(0.4.142 那一套);新消息绿底白字(维护者定);
  // 评审页的计数只画了灰字,这里以维护者为准:语义底色保留。尺寸 15 高、圆角满、字 10 / 700。
  it('各档徽章有底色:新消息绿底白字、已完成蓝底黑字、等你琥珀、出错红;「在跑」白底呼吸照 0.4.142', () => {
    expect(MONO_STYLE).not.toContain('.ben-wb__dock-badge:not([data-tone=running]) .ben-wb__dock-badge-dot{min-width:0;padding:0 2px;background:transparent')
    expect(rule('.ben-wb .ben-wb__dock-badge .ben-wb__dock-badge-dot')).toBe('min-width:15px;height:15px;padding:0 4px;border-radius:999px;font-size:10px;font-weight:700')
    expect(rule('.ben-wb .ben-wb__dock-badge[data-tone=im] .ben-wb__dock-badge-dot')).toBe('background:var(--dsw-alias-state-success-primary,#3fb27f);border-color:transparent;color:#fff')
    expect(rule('.ben-wb__dock-badge[data-tone=done] .ben-wb__dock-badge-dot', STYLE)).toBe('background:rgb(79,142,247);color:#1d1d1f')
    expect(rule('.ben-wb__dock-badge[data-tone=waiting] .ben-wb__dock-badge-dot', STYLE)).toBe('background:var(--dsw-alias-state-warn-label)')
    expect(rule('.ben-wb__dock-badge[data-tone=error] .ben-wb__dock-badge-dot', STYLE)).toBe('background:var(--dsw-alias-state-error-primary)')
    expect(rule('.ben-wb__dock-badge[data-tone=running] .ben-wb__dock-badge-dot', STYLE)).toContain('background:#fff')
  })
  it('竖屏横排在纸面卡片里:选中底用同一页「纸面上的选中 = soft」', () => {
    expect(rule('.ben-wb .ben-wb__mod[data-module-box=slot] .ben-wb__dock-tab[data-current=true]')).toBe('background:var(--wb-soft)')
  })
})

describe('④ 协作区「设置」是盖在上面的一层(项目区那格的协作区组件,点 ⚙ 之后)', () => {
  it('遮罩 #0008、内边距 24;弹层圆角 12、宽至多 900', () => {
    const veil = rule('.ben-wb .ben-cl__setveil')
    expect(veil).toContain('padding:24px')
    expect(veil).toContain('background:var(--wb-veil-deep)')
    expect(MONO_SCALE['--wb-veil-deep']).toBe('#0008')
    const dlg = rule('.ben-wb .ben-cl__setdlg')
    expect(dlg).toContain('width:min(900px,100%)')
    expect(dlg).toContain('border-radius:var(--wb-r-window)')
  })
  it('头 14 / 20、标题 13 / 700;身 22;左栏 155、一组 12px 高 30、当前那组 field 底', () => {
    expect(rule('.ben-wb .ben-cl__setdlg-head')).toContain('padding:14px 20px')
    expect(rule('.ben-wb .ben-cl__setdlg-head>strong')).toContain('font-size:13px;font-weight:700')
    expect(rule('.ben-wb .ben-cl__setdlg-body')).toContain('padding:22px')
    expect(rule('.ben-wb .ben-cl__settings>nav')).toContain('width:155px')
    const item = rule('.ben-wb .ben-cl__settings>nav>button')
    expect(item).toContain('min-height:30px')
    expect(item).toContain('font-size:12px')
    expect(rule('.ben-wb .ben-cl__settings>nav>button[aria-pressed=true]')).toContain('background:var(--cl-field)')
  })
})

describe('⑥ 时间线事项卡的字(评审页项目区那格嵌的协作区原型 `.event`)', () => {
  it('卡上次字 #545862(原型 `--card-sub`;协作区 Pen 是 #5B5E66,以评审页为准);主字稿是 #25262b,色相 230 碰「不许紫」线,取 #252629', () => {
    for (const set of [MONO_DARK, MONO_LIGHT]) {
      expect(set['--wb-card-ink']).toBe('#252629')
      expect(set['--wb-card-sub']).toBe('#545862')
    }
  })
  it('已发生的会话 / 经过(透明底虚线框,稿里没有这一档):字落在纸面上,用纸面上的主次字,不用浅底卡的深字', () => {
    expect(rule('.ben-cl .ben-cl__tcard[data-type=past] .ben-cl__tcard-title', COLLAB_STYLE)).toBe('color:var(--cl-fg)')
    expect(rule('.ben-cl__tcard[data-type=past] :is(.ben-cl__tcard-owner,.ben-cl__past-tag)', COLLAB_STYLE)).toBe('color:var(--cl-fg2)')
  })
})

describe('协作区便签 / 会议详情的外框(原型 `.overlay` / `.dialog`;里面怎么排待拍板 27)', () => {
  it('遮罩 #0008、内边距 24、居中;框纸面底、1px 线、圆角 12、宽至多 900、影 0 24px 100px #0006;会议不另加顶条', () => {
    expect(rule('.ben-cl__dialog-veil', COLLAB_STYLE)).toBe('position:absolute;inset:0;z-index:10;background:var(--wb-veil-deep);display:flex;justify-content:center;align-items:center;padding:24px;overflow:auto')
    const dlg = rule('.ben-cl__dialog', COLLAB_STYLE)
    for (const one of ['width:min(900px,100%)', 'max-height:calc(100% - 48px)', 'overflow:auto', 'background:var(--cl-paper)', 'border:var(--wb-hair) solid var(--cl-line)', 'border-radius:var(--wb-r-window)', 'box-shadow:var(--wb-shadow-dlg)']) expect(dlg).toContain(one)
    expect(COLLAB_STYLE).not.toContain('.ben-cl__dialog[data-type=meeting]{border-top')
  })
})

describe('外层弹层照评审页 `.overlay` / `.modal`(功能点详情、Wiki、接上 Claude / Codex)', () => {
  it('遮罩 #0007、内边距 24;框纸面底、无边、圆角 12、宽 620、影 0 25px 90px #0005', () => {
    expect(rule('.ben-wb .ben-wb__dlg-scrim,.ben-wb .ben-wb__hookapply-mask')).toBe('padding:24px;background:var(--wb-veil)')
    expect(MONO_SCALE['--wb-veil']).toBe('#0007')
    expect(rule('.ben-wb .ben-wb__dlg,.ben-wb .ben-wb__board .ben-wb__dlg,.ben-wb .ben-wb__hookapply')).toBe('width:min(620px,100%);border:0;border-radius:var(--wb-r-window);background:var(--wb-paper);box-shadow:var(--wb-shadow-modal)')
  })
  it('头 16 / 20、隔 12、下一根线;正文 20、12 / 1.85', () => {
    expect(rule('.ben-wb .ben-wb__dlg-head')).toBe('gap:12px;padding:16px 20px;border-bottom:var(--wb-hair) solid var(--wb-line)')
    expect(rule('.ben-wb .ben-wb__dlg-body')).toBe('padding:20px;font-size:12px;line-height:1.85')
    expect(rule('.ben-wb .ben-wb__hookapply-title')).toBe('font-size:14px;font-weight:600')
  })
})

describe('「没办成」那一句(10-22 拍板 24:形状照评审页 `.field-error`,颜色保留语义红)', () => {
  it('左 2px 线、soft 底、内边距 7 / 10、字 11;线与字都是宿主的错误红', () => {
    const at = MONO_STYLE.indexOf('.ben-wb__pj-calc--error,')
    const body = MONO_STYLE.slice(MONO_STYLE.indexOf('{', at) + 1, MONO_STYLE.indexOf('}', at))
    for (const one of ['padding:7px 10px', 'border-left:2px solid var(--dsw-alias-state-error-primary)', 'background:var(--wb-soft)', 'color:var(--dsw-alias-state-error-primary)', 'font-size:11px']) expect(body).toContain(one)
  })
})

describe('协作区的回执(原型 `#toast`)', () => {
  it('主字色底、纸面字,内边距 10 / 16、圆角 7、最宽 90%,离底 20,影 0 8px 30px #0005', () => {
    expect(rule('.ben-cl__receipt', COLLAB_STYLE)).toBe('position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:9;margin:0;background:var(--cl-fg);color:var(--cl-paper);border-radius:7px;padding:10px 16px;max-width:90%;box-shadow:var(--wb-shadow-receipt)')
    expect(MONO_SCALE['--wb-shadow-receipt']).toBe('0 8px 30px #0005')
  })
})

describe('⑤ 年历:方格明暗五档,不靠大小', () => {
  it('方格圆角 2、格间 3;0–4 档依次 g0–g4', () => {
    expect(rule('.ben-wb .ben-wb__usage-heatgrid')).toBe('gap:3px')
    expect(rule('.ben-wb .ben-wb__usage .ben-wb__usage-heatcell,.ben-wb .ben-wb__usage-heatcell[data-level]')).toContain('border-radius:2px;background:var(--wb-g0)')
    for (const level of [1, 2, 3, 4]) expect(rule(`.ben-wb .ben-wb__usage-heatcell[data-level="${level}"]`)).toBe(`background:var(--wb-g${level})`)
    expect(MONO_STYLE).not.toContain('radial-gradient')
  })
  it('还没到的日子只描 1px 线、整体 .3', () => {
    expect(rule('.ben-wb .ben-wb__usage-heatcell[data-future=true]')).toBe('background:transparent;border:var(--wb-hair) solid var(--wb-line);box-shadow:none;opacity:.3')
  })
  it('图例 5px 圆点', () => {
    expect(rule('.ben-wb .ben-wb__usage-heatlegend .ben-wb__usage-heatcell')).toContain('width:5px;height:5px;border-radius:50%')
  })
})

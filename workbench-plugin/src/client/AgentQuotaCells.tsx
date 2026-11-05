/**
 * 额度区里老四格(DeepSeek、Claude、Codex、Kimi)之外的那几家(2026-09-25,卡 O;统筹:「额度/余额要覆盖派活名单里的
 * 每一家 —— Muse、Manus、豆包现在额度那里什么都没有」)。
 *
 * 数据是 `/state.agent_quota`(服务端 `agentQuota.ts` 的 `quotaFor` 一处算好),每家**只落在三格之一**:
 * 有数 / 不限 / 没接上。
 *
 * ★ 2026-09-26(卡 QU;维护者看着面板:「他们(Muse、豆包办公、Manus、Grok Bot、Antigravity)的样式,
 * 和上面的 3 家可以说完全不一样,只有文字…你能不能统一一下」)。
 *
 * 原来这几家是**另一种东西**:左名字、右一个 20px 大字,长句直接铺在行下。老四格是 `名字 | 横条 | ▸ 说明`。
 * 一个面板里两套骨架,他一眼就看出来了。现在**这几家整份改成老四格那一副骨架**——
 * 老四格(`QuotaPanel.tsx` 的 `QuotaBlock`)的样式、间距、字号一个字节没动,是这几家往它靠:
 *
 *   名字 │ ▁▁▁▁▁▁▁▁ 62% │ ▸ 说明        ← 与老四格的每个窗口一行逐像素同一套类名
 *
 * - 横条(老四格是 5h / 周 / 总各一条):服务端顶上来一个数的就一条;**窗口型额度的那几家一扇窗一条**
 *   —— 豆包办公的「当前时段 / 近 7 天」就是 Claude 的「5h / 周」(2026-09-26,卡 QD,`AgentQuotaView.windows`);
 * - 值写在横条右端那一栏(老四格写百分比的地方),**不再是行右边那个大字**;
 * - 出处 / 原因 / 修法那句话收进「▸ 说明」里(老四格一直是这样),不再铺在行下 ——
 *   只有「上次读到的那个数已经老了」那一种例外:那句「昨晚 20:42 读到的」照卡 QS 的口径摊在明面上。
 *
 * 三格各画成什么见 `quotaBar`。**每格右端先写一个字**(百分比 / 「不限」/「没接上」),不靠颜色分 ——
 * 同 dispatchEyesStyle.ts 头上那条老规矩。
 */
import { Fragment, useState } from 'react'
import type { AgentQuotaView, QuotaStaleFix } from '../protocol.ts'
import { AGENT_IDS } from '../protocol.ts'
// 大字与下面那一行的说法(2026-09-26 卡 QS 起与老四格共用一处:老四格取不到数时也照这一格说)。
import { quotaNote, quotaValue, windowShort } from './quotaCells.ts'

/**
 * 老四格已经画过的不再画(它们有自己的解锁卡与进度条)。
 *
 * ★ 2026-09-27(卡 HC):比的是**上面那一排真画出来的那几家**(`drawn`,= `/state.agents` 的 id),
 * 不再是写死的 `AGENT_IDS`。只装了豆包办公与 Codex 的机器上,Claude / Kimi 已经从上面那一排
 * 消失了 —— 拿写死的四家去减,它们会从这里再冒出来一次。`drawn` 缺席就退回 `AGENT_IDS`(老行为)。
 */
export function extraQuotas(
  list: readonly AgentQuotaView[] | undefined,
  drawn: readonly string[] = AGENT_IDS,
): AgentQuotaView[] {
  return (list ?? []).filter(one => !drawn.includes(one.id))
}

function levelOf(view: AgentQuotaView): 'ok' | 'warn' | 'danger' {
  if (view.state !== 'numbers') return 'ok'
  return view.level === 'empty' ? 'danger' : view.level === 'low' ? 'warn' : 'ok'
}

/**
 * 那一条横条画成什么(2026-09-26,卡 QU)。**四种,和三格一一对得上**:
 *
 * - `pct`  有数、而且有分母 → 按 `left_pct` 填,长度 = 剩余(方向与老四格一致:条短了就该慌);
 * - `open` 有数、但**没有分母**(Manus 的积分:壳只能从它首页右上角读到「剩多少」,它自己没有
 *          任何地方写着「总共多少」)→ 只画轨道、不画填充。**这是老四格那条老纪律**:
 *          余额没有分母,画条要先假设一个「满」值,那是编的(`quotaCells.ts` 头上「余额型不画条」)。
 *          右端照实写「2,690 积分」—— 数是真的,只有那根填充是假的,所以省掉填充、留下骨架;
 * - `full` 不限(查实过的:豆包的官方说法、Manus 限时免费期的「∞」)→ 整条实心、淡色;
 * - `none` 没接上 → 只画轨道(空心)。
 *
 * `open` 与 `none` 都只有轨道,分辨靠**右端那个字**(「2,690 积分」对「没接上」),不靠颜色;
 * 样式上再给 `none` 一道空心边,是锦上添花,不是唯一线索。
 */
export type QuotaBarFill =
  | { kind: 'pct', pct: number }
  | { kind: 'open' }
  | { kind: 'full' }
  | { kind: 'none' }

export function quotaBar(view: AgentQuotaView): QuotaBarFill {
  if (view.state === 'unlimited') return { kind: 'full' }
  if (view.state === 'unconnected') return { kind: 'none' }
  if (view.left_pct === undefined) return { kind: 'open' }
  return { kind: 'pct', pct: Math.max(0, Math.min(100, view.left_pct)) }
}

/** 一行里的一条横条:那一栏写什么(窗口名 / 空)、怎么填、右端那个字。 */
export interface QuotaBarRow {
  label: string
  fill: QuotaBarFill
  right: string
  /**
   * 这一条归哪一组(2026-09-27,卡 AG)。页面上就分了组的那几家才有 ——
   * Antigravity 的「Gemini Models」/「Claude and GPT models」,组名是从它页面上读回来的原话。
   * 界面在**换组的那一行前面**插一条小标题;缺席的照旧一条一行,老四格一个像素都没动。
   */
  group?: string
}

/**
 * 这一行画几条(2026-09-26,卡 QD)。
 *
 * **窗口型额度的那几家照老四格画:一扇窗一条** —— 豆包办公的「当前时段 / 近 7 天」就是 Claude 的
 * 「5h / 周」,同一种东西该长同一个样(`AgentQuotaView.windows`,形状也是老四格那份 `QuotaWindow`)。
 * 服务端只顶上来一个数的照旧一条、标签留空:撤掉那个空标签,横条就往左跑、与老四格错开(卡 QU)。
 *
 * 为什么不是「只画最紧那一条」:两扇窗是两件事,「5 小时快没了」和「这周还多着」得同时看得见 ——
 * 老四格从第一天起就是这么画的。那一句 `line`(派活确认点、手机上读的)仍然只说最紧的那一扇。
 */
export function quotaBarRows(view: AgentQuotaView): QuotaBarRow[] {
  const windows = view.state === 'numbers' ? view.windows ?? [] : []
  if (windows.length === 0) return [{ label: '', fill: quotaBar(view), right: quotaValue(view) }]
  return windows.map((one) => {
    const pct = Math.max(0, Math.min(100, Math.round(one.left_pct)))
    return { label: one.label, fill: { kind: 'pct', pct } as QuotaBarFill, right: `${pct}%`, ...(one.group === undefined ? {} : { group: one.group }) }
  })
}

export function AgentQuotaCells({ quotas, baseUrl, fetchImpl, onFix }: {
  quotas: readonly AgentQuotaView[]
  baseUrl?: string
  fetchImpl?: typeof fetch
  /**
   * 「读不到最新」那一格上那颗入口键(2026-10-02,卡 QK):点一下去设置里那一行。
   * 去处由服务端那一份声明给(`stale_hint.live.fix.at`),这里不判是哪一家。
   * 缺席就不画键 —— 那两句话照说(同解锁卡 `onUnlock` 的先例)。
   */
  onFix?: (at: QuotaStaleFix['at']) => void
}) {
  const [said, setSaid] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const call = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)

  async function post(id: string, path: string, body: unknown, done: string): Promise<void> {
    if (call === undefined || baseUrl === undefined) return
    setBusy(true)
    try {
      const res = await call(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const got = await res.json().catch(() => ({})) as { note?: string, error?: string }
      setSaid(prev => ({ ...prev, [id]: got.error ?? got.note ?? (res.ok ? done : '没办成') }))
    }
    catch { setSaid(prev => ({ ...prev, [id]: '工作台服务没应答' })) }
    finally { setBusy(false) }
  }

  return (
    <>
      {quotas.map((view) => {
        const level = levelOf(view)
        const fix = view.fix
        /**
         * **数读到了、还不旧**:那两颗键不摆在行上(2026-09-26 晚,卡 QG;维护者 22:40:
         * 「muse 和豆包办公都已经取到了,为什么还有那两个按钮啊?」)。
         * 收进「▸ 说明」里,只留一颗「再读一次」——他想立刻再读一次照样点得到,
         * 可那一行不再像「还差一步」。什么时候算「不用催他」由服务端一处定(`fix.quiet`)。
         */
        const quiet = fix?.quiet === true
        const rows = quotaBarRows(view)
        const note = quotaNote(view)
        const hint = fix?.hint
        return (
          <div
            className="ben-wb__usage-q ben-wb__agentq"
            key={view.id}
            role="listitem"
            aria-label={view.title}
            data-kind="agent"
            data-state={view.state}
            data-level={level}
            // 上次读到的、已经老了的那个数(卡 QS):这一格画淡;那一句里已经写着几点读到的。
            data-stale={view.stale === true ? 'true' : undefined}
          >
            <div className="ben-wb__usage-qhead">
              <span className="ben-wb__usage-qname">{view.title}</span>
            </div>

            {/*
              老四格那一副骨架(类名逐字相同,样式因此自动一致):一条横条 + 右端那个字。
              窗口型额度的那几家一扇窗一条(豆包办公的「当前时段 / 近 7 天」,卡 QD),其余照旧一条。
            */}
            <div className="ben-wb__usage-qbars">
              {rows.map((row, at) => (
                <Fragment key={row.label === '' ? `bar-${at}` : `${row.group ?? ''}/${row.label}`}>
                {/*
                  ★ 卡 AG(2026-09-27):页面上就分了组的那一家,**换组的那一行前面**摆一条组名小标题
                  ——「照它页面怎么列就怎么列」。组名是原话(「Gemini Models」「Claude and GPT models」),
                  不缩写、不翻译;没有组的那几家这一条压根不出现,老四格的骨架一个像素没动。
                */}
                {row.group !== undefined && row.group !== rows[at - 1]?.group && (
                  <div className="ben-wb__usage-qgroup" title={row.group}>{row.group}</div>
                )}
                <div className="ben-wb__usage-qbar">
                  {/*
                    老四格这一栏写的是**哪个窗口**(5h / 周 / 总)—— 有窗口就照写(豆包办公两条)。
                    只有一条的那几家这里空着:摆一个编出来的词是噪音,而这个空栏占着同样的 34px,
                    横条的起点才和老四格对得齐(统一的就是这个对齐)。
                  */}
                  <span className="ben-wb__usage-qlabel">{windowShort(row.label)}</span>
                  <span className="ben-wb__usage-qtrack" data-fill={row.fill.kind}>
                    {row.fill.kind === 'pct' && <i data-level={level} style={{ width: `${row.fill.pct}%` }} />}
                    {row.fill.kind === 'full' && <i data-fill="full" style={{ width: '100%' }} />}
                  </span>
                  {/* 右端那个字:百分比 / 「2,690 积分」/「不限」/「没接上」。位置 = 老四格写百分比的那一栏。 */}
                  <span className="ben-wb__usage-qpct" data-level={level}>{row.right}</span>
                </div>
                </Fragment>
              ))}
            </div>

            {/*
              「▸ 说明」—— 老四格一直有的那个入口,这几家现在也是同一个(同一个类名、同一栏)。
              展开就是那几句话:出处 / 原因(`quotaNote`:有数写整句带时刻,不限写出处,没接上写原因)+ 修法那句 `fix.hint`。
              数已经老了的那一格例外:那句话已经摊在上面了,「说明」里只剩修法(没有修法就不出这个入口)。
            */}
            {(
              <details className="ben-wb__usage-qdetails">
                {/* 收起时鼠标停上去也看得见那句话 —— 老四格的 summary 一直带着这个 title。 */}
                <summary title={note}>说明</summary>
                <p className="ben-wb__usage-qnote">{note}</p>
                {hint !== undefined && <p className="ben-wb__agentq-hint">{hint}</p>}
              </details>
            )}

            {/*
              行上只剩「去授权」这一颗(2026-09-30 维护者拍板:把那家叫到台前的那颗键全删了 ——
              该他自己去打开哪一页,服务端如实写在那一句话里,「▸ 说明」里照旧看得到)。
              「读一下」2026-09-27 撤了(维护者:「读一下这个东西就不要了吧,不止交互,包括功能」):他切走那家时自己会读。
            */}
            {fix !== undefined && !quiet && baseUrl !== undefined && fix.kind === 'grant_ax' && (
              <div className="ben-wb__agentq-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { void post(view.id, '/setup/open', { pane: 'accessibility' }, '系统设置打开了') }}
                >
                  {fix.label}
                </button>
              </div>
            )}
            {/*
              「读不到最新」时那颗入口键(2026-10-02,卡 QK)。只有这一家**声明过**「还有一条更实时的
              来源、缺一样东西」时才有 —— 今天从窗口上读的那几家一个都没有,所以这一行照旧什么都不多。
              那两句话本来就在 `view.line` / 「▸ 说明」里,键只是把她送到设置那一行。

              ★ 2026-10-03(卡「不让用户知道什么叫 setup-token」):**「没接上」那一档也画**。
              维护者原话是「你不说我咋知道要咋弄啊」—— 一格写着「没接上」却连一颗能按的键都没有,
              正是那一幕。声明过的那一家(今天 = Claude:一颗「接上」就能授权)在这两档都该有入口;
              没声明过的那几家两档都照旧一个字不多(D13:不凭空长出一颗按钮)。
            */}
            {(view.stale === true || view.state === 'unconnected') && view.stale_hint?.live?.fix !== undefined && onFix !== undefined && (
              <div className="ben-wb__agentq-actions">
                <button
                  type="button"
                  onClick={() => { onFix((view.stale_hint?.live?.fix as QuotaStaleFix).at) }}
                >
                  {view.stale_hint.live.fix.label}
                </button>
              </div>
            )}
            {said[view.id] !== undefined && <p className="ben-wb__agentq-hint" role="status">{said[view.id]}</p>}
          </div>
        )
      })}
    </>
  )
}

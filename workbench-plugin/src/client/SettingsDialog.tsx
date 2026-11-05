/**
 * 齿轮弹窗(2026-08-25 版面重排,设计稿 §3.1;2026-09-28 卡 SG 整理成分组)。
 *
 * ## 2026-09-28:一条长滚动 → 六个分组(维护者:「现在桌面端的设置页面乱的要死」)
 *
 * 在这之前,这一屏是十几节从上堆到下的一条长滚动 —— 每一节都是历年各张卡往里加的,
 * 顺序、按钮样式、说明文字长短全不统一(见 docs/设计-设置页整理-2026-09-28.md 的盘点表)。
 * 现在改成**按「她来设置页是想干什么」分六组**,顶上一排切换,一次只看一组:
 *
 * 1. `SETTINGS_GROUPS` 是唯一的那张单子(哪一组、叫什么、里面有哪几节),
 *    新加一节就往这张单子对应的那一组里放,**不再往末尾堆**。
 * 2. 她几乎不会碰的(目录、峰谷时段、连接器、体检)全收进最后一组「高级」——
 *    它不是默认组,所以默认就是收起来的。
 * 3. 每一节的骨架统一(2026-10-22 起照 Codex 全局评审页,件在 `settings/setKit.tsx`):节名一行(状态小字在右)、
 *    一行一件事、**最多一颗主动作**(描边),次要动作是文字键;稿里没画的已上线功能收进折叠或文字次级入口。
 *    「最多一颗主按钮」是卡 UP 在「更新」那一节上定下来的口径。
 * 4. **一节都没少**:每节原来的数据来源、没接线时整节不出现的规矩照旧。
 *
 * 组件条(widgets)整块退休,原来挤在里面的"配置类"东西收进这里。凭据是第一件:
 * 余额与额度已经在「消耗数据」下面有了自己的常显模块(QuotaPanel,另一条线 2026-08-25
 * 上线),同一个数字不该在两处各说一遍——Ben 2026-08-25 定的口径。0.1.49 那版设计稿里
 * "额度余额也收进齿轮"那句是在余额还没有落脚点时写的,现在前提没了。
 *
 * 2026-09-09 起多一件:哨兵的「新增监视项」——同样是"配一次就不用再看"的东西,
 * 配完的列表在事务官浮窗那一栏(SentinelForm.tsx 顶部注释说明了为什么分两处)。
 *
 * 弹窗是纯运行态,不进 layout:它不是布局偏好,是"这会儿要不要填个 Key"。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { SetupReopenRow } from './setup/SetupPage.tsx'
import { UpdatePanel } from './update/UpdatePanel.tsx'
import type { UpdateRuntimeStaleView } from '../server/update/types.ts'
import { AccountPanel } from './account/AccountPanel.tsx'
import type { AccountView } from './account/accountApi.ts'
import type { ButlerView, ConnectorView, DeepSeekPeakView, DeviceView, LanView, PairingView } from '../protocol.ts'
import { CONFIRMS, ConfirmDialog, Popover } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'
import { ButlerPanel } from './ButlerPanel.tsx'
import { ConnectorPanel } from './ConnectorPanel.tsx'
import { CredentialPanel } from './CredentialPanel.tsx'
import { ModelPanel } from './ModelPanel.tsx'
import { PairQr } from './PairQr.tsx'
import { SentinelForm } from './SentinelForm.tsx'
import { TemplatePanel } from './TemplatePanel.tsx'
import { TodayViewPicker } from './TodayModule.tsx'
import type { TodayViewStyle } from '../protocol.ts'
import { CustomModulesPanel } from './CustomModulesPanel.tsx'
import { UserLayerPanel } from './UserLayerPanel.tsx'
import { RulesPanel } from './RulesPanel.tsx'
import { DispatchPrefsPanel } from './DispatchPrefsPanel.tsx'
import { HabitsPanel } from './HabitsPanel.tsx'
import { MeetingImportPanel } from './MeetingImportPanel.tsx'
import { DemoDataPanel } from './DemoDataPanel.tsx'
import { ExperimentsPanel } from './ExperimentsPanel.tsx'
import type { ExperimentsView } from '../mainPaths.ts'
import { PromptsPanel } from './PromptsPanel.tsx'
import { AgentCapsPanel } from './AgentCapsPanel.tsx'
import { PersonalTokenPanel } from './PersonalTokenPanel.tsx'
import { ItemTypesPanel } from './ItemTypesPanel.tsx'
import { coverClass, useDialogCover, useVeilSlot, type VeilTarget } from './useVeilSlot.ts'
import { SetActions, SetBtn, SetExplain, SetLead, SetMsg, SetRow, SetSection } from './settings/setKit.tsx'
import { postSilently } from './postSilently.ts'

/** 「手机与设备」那一节要的三样,都来自 /state(lan / pairing / devices);pairing 只有本机来源的 /state 才有。 */
export interface DevicesSection {
  lan: LanView
  pairing?: PairingView
  devices: readonly DeviceView[]
}

export type SettingsGroupId = 'butler' | 'devices' | 'agents' | 'machine' | 'update' | 'advanced'

/**
 * 六个分组(2026-09-28,卡 SG)。**这是唯一的那张单子**;`desc` 是组名下那一句(评审页 0cf75042,10-22 拍板照稿),
 * `lead` 是那颗 ? 点开的长说明 —— 顺序就是顶上那一排的顺序,
 * 第一条是默认打开的那一组。
 *
 * 分法不是按「这东西是谁写的」,是按**她来设置页是想干什么**:
 * 想让事务官改一句话 / 想把手机连上 / 想看哪家能干活还剩多少 / 想动这台电脑上的东西 / 想升个级。
 * 剩下那些「配一次十年不动」的(目录、峰谷时段、连接器、体检与修复)全进最后一组「高级」。
 *
 * 默认停在「事务官的规矩」:那是 09-24 卡 K 盘过的"他最常回来改的一节",这次没有推翻它。
 */
export const SETTINGS_GROUPS: readonly { id: SettingsGroupId, label: string, desc: string, lead: string }[] = [
  { id: 'butler', label: '事务官的规矩', desc: '规矩、学到的做法,以及你想交代的事。', lead: '他记住了你说过的哪些话、从你平时的做法里学到了什么、替你盯着什么、长什么样、什么声音。' },
  { id: 'devices', label: '手机与座机', desc: '管理设备连接与电脑唤醒。', lead: '手机和话筒怎么连上这台电脑,以及别让这台电脑睡过去。' },
  { id: 'agents', label: '各家 AI 与账号', desc: '先看能做什么,再管理账号和额度来源。', lead: '哪几家现在能干活、用谁的账号、还剩多少额度。' },
  { id: 'machine', label: '这台电脑', desc: '账号、布局和你自己的组件。', lead: '登录这台工作台的账号、在用的模板、你自己的那一层(用户层)、让人做出来的那些格子,和事项分哪几类。' },
  { id: 'update', label: '更新', desc: '查看当前版本与更新状态。', lead: '这台电脑上装的是哪一版,有没有新的。' },
  { id: 'advanced', label: '高级', desc: '目录、连接器和诊断入口。', lead: '配一次就不用再看的东西,和出了事才来的地方。平时不用点开。' },
]

/** 「这一组这会儿一节都没有」时说的那句话。用 :has() 判,组里真有 section 就自己藏起来。 */
export const SETTINGS_EMPTY_LINE = '这一组这会儿没有可设置的东西 —— 相关的服务还没在这台电脑上接起来。'

/**
 * 每组顶上那一排跳转小钮(评审页 0cf75042 `.settings-jump`,10-22 拍板照稿):只写节名,点一下跳到下面那一节。
 * 顺序与下面各节一致;`id` 也是那一节外层的锚点(`ben-wb-setsec-<id>`)。没接线的节(由 props 判)不列;
 * 自己拉数据、拉不到就整节不出现的那几节,小钮由样式按「那一节在不在」一起藏(`SETTINGS_ENTRY_STYLE`)。
 * 稿里只画了「事务官的规矩」那一排(第三颗写「交代与偏好」,照稿);别的组照同样的样子列各节节名。
 * 原来入口行上那一句状态挪到了各节标题右边的小字。
 */
export interface SettingsEntry { id: string, title: string }

export const SETTINGS_ENTRIES: Record<SettingsGroupId, readonly SettingsEntry[]> = {
  butler: [
    { id: 'rules', title: '记住的规矩' },
    { id: 'habits', title: '它学到了什么' },
    { id: 'prompts', title: '交代与偏好' },
    { id: 'dispatch-prefs', title: '派活与提醒' },
    { id: 'sentinel', title: '哨兵' },
    { id: 'butler', title: '形象与音色' },
    { id: 'meetings', title: '会议转写' },
    { id: 'demo', title: '演示数据' },
  ],
  devices: [
    { id: 'devices', title: '已连接设备' },
    { id: 'awake', title: '电脑保持唤醒' },
    { id: 'lan', title: '连接状态' },
  ],
  agents: [
    { id: 'caps', title: '各家能做什么' },
    { id: 'model', title: '模型服务' },
    { id: 'credentials', title: '各家的登录与密钥' },
    { id: 'token', title: '个人访问令牌' },
  ],
  machine: [
    { id: 'account', title: '工作台账号' },
    { id: 'template', title: '工作布局' },
    { id: 'today', title: '待办显示' },
    { id: 'modules', title: '自定义组件' },
    { id: 'userlayer', title: '用户层' },
    { id: 'itemtypes', title: '事项类型' },
  ],
  update: [
    { id: 'update', title: '应用更新' },
  ],
  advanced: [
    { id: 'paths', title: '目录' },
    { id: 'peak', title: '峰谷时段' },
    { id: 'connector', title: '连接器' },
    { id: 'setup', title: '体检与引导' },
    { id: 'experiments', title: '实验开关' },
  ],
}

/** 小钮跟着那一节藏:那一节没渲染出 section(没接线、拉不到),那一颗也不出。 */
export const SETTINGS_ENTRY_STYLE = Object.values(SETTINGS_ENTRIES).flat()
  .map(one => `.ben-wb__setgrp:not(:has([data-sec=${one.id}] section)) [data-entry=${one.id}]{display:none}`).join('\n')

// 两句状态的口径在各自那一节里(显示在节名右边);这里转出去,老入口照旧认得。
export { rulesEntryLine } from './RulesPanel.tsx'
export { habitsEntryLine } from './HabitsPanel.tsx'

/** 一节的外层:跳转的锚点。样式上是 `display:contents`,里面的一节(或两节)直接排进两列。 */
function Sec({ id, children }: { id: string, children: ReactNode }) {
  return <div className="ben-wb__setsec" id={`ben-wb-setsec-${id}`} data-sec={id}>{children}</div>
}

const jumpTo = (id: string): void => {
  const holder = document.getElementById(`ben-wb-setsec-${id}`)
  ;(holder?.querySelector('section') ?? holder)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

export function SettingsDialog({
  baseUrl, fetchImpl, onClose, peak, butler, connector, veil, devices, onOpenSetup, account, onAccountChanged, onReplayFirstRun, onRedoOnboarding,
  currentVersion, runtimeStale, xhs, collect, openAt, todayView, meetings, experiments, relayConfigured,
}: {
  baseUrl: string
  /** 这台接没接中转(`/state.relay_configured`,2026-10-21)。`false` 时「出门时」那一行说这台没接中转。缺席 = 不知道。 */
  relayConfigured?: boolean
  /** 实验开关此刻各开没开(2026-10-21,卡「引导三件事」;`/state.experiments`)。缺席 = 这台没接,那一节不出现。 */
  experiments?: ExperimentsView
  /** 「今天的待办」此刻用哪一版(`/state.today_todos.style`)。缺席 = 这台没有那一格,救场键整行不出现。 */
  todayView?: TodayViewStyle
  fetchImpl?: typeof fetch
  onClose: () => void
  /** 体检与修复(2026-09-17):点了关掉设置、打开那一页。没传就不显示那一节。 */
  onOpenSetup?: () => void
  /** 本机账号(2026-09-17)。没接账号服务时整节不出现。 */
  account?: AccountView
  /** 改完密码 / 退出登录之后调一次:上层重新问一次 /account。 */
  onAccountChanged?: () => void
  /** 「重新走一遍首次流程」:擦掉 first_run_done_at,那三屏再来一次。 */
  onReplayFirstRun?: () => void
  /** 设置里那颗「重新做一遍引导」(2026-09-27,卡 OB):擦首次旗子 + 把引导进度重置到开头。 */
  onRedoOnboarding?: () => void
  /** DeepSeek 峰谷(2026-09-09):当前时段与生效中的时间表,后者用来回填输入框。 */
  peak?: DeepSeekPeakView
  /**
   * 连接器(open-connector,卡 OC2)。**缺席 = 这台服务没接连接器**,那一行整块不出现
   * (不画一行说不出话的状态)。
   */
  connector?: ConnectorView
  /**
   * 数据复盘的小红书登录态(2026-09-21)。**缺席 = 这台服务没接自取**,
   * 「额度凭据」那一节里就不出现那一栏(不画一颗点了没用的按钮)。
   */
  xhs?: {
    connected: boolean
    nickname?: string
    /** 每个账号一个浏览器档案(2026-09-22)。 */
    accounts?: readonly { profile: string, index: number, name: string, connected: boolean }[]
  }
  /**
   * 采集类(2026-09-22)。**缺席 = 这台服务没接采集** —— 那一段承诺整块不出现。
   * 从 `/state.xhs_collect` 来。
   */
  collect?: {
    today: number
    daily_max: number
    workdir_ready: boolean
    tools?: { ffmpeg: boolean, whisper: boolean, model: boolean, note: string }
  }
  /** 事务官本机后端(2026-09-11):没接线时这一节整块不出现。 */
  butler?: ButlerView
  /**
   * 会议(2026-10-13):`/state.meetings`。**整格缺席 = 这台没接会议模式**,
   * 「用现成的转写出纪要」那一节整块不出现(不画一行说不出话的状态)。
   */
  meetings?: { dir?: string }
  /** 弹层让开窗位(2026-09-11):弹窗在右上角,常与窗位重叠——挂载即让路,卸载即回来。不在壳里不传。 */
  veil?: VeilTarget
  /** 手机与设备(2026-09-11):不传就是没接配对服务,这一节整块不渲染。 */
  devices?: DevicesSection
  /**
   * 热更新(2026-09-18):/state.update.current。只用来在人还没点「检查更新」之前
   * 先把版本号显示出来 —— 不传也照常有这一节,只是第一行说"还不知道是哪一版"。
   */
  currentVersion?: string
  /**
   * 「DSH 运行环境还没换到这一版」(2026-09-26,卡 U6):/state.update.runtime_stale。
   * 原样传给「更新」那一节 —— 这里不判、不改写。
   */
  runtimeStale?: UpdateRuntimeStaleView
  /**
   * **这一次开在哪一节、哪一行**(2026-10-02,卡 QK)。
   *
   * 额度那一格「读不到最新」时那颗入口键带着它来(去处由服务端那一份声明给,
   * 见 `quota/liveSources.ts`)——弹窗开在那一组、把那一行点亮,她不必在六组里找。
   * 认不出的组名就当没给(照默认那一组开);缺席 = 顶栏那颗齿轮与解锁卡那几颗键的老行为。
   */
  openAt?: { group: string, row?: string }
}) {
  useVeilSlot(true, veil)
  const atGroup = SETTINGS_GROUPS.find(one => one.id === openAt?.group)?.id
  const [group, setGroup] = useState<SettingsGroupId>(atGroup ?? SETTINGS_GROUPS[0]?.id ?? 'butler')
  // 弹层盖住窗位(2026-09-14):让路之后窗位那块是空白,Ben 看着像坏了——弹窗就落在窗位矩形上,
  // 内容在里面滚。量不到矩形(窗位收起/纯净模式/不在壳里)照旧贴右上角开。
  const cover = useDialogCover(veil)
  // 由 props 判得出「没接线」的那几节,小钮直接不列。
  const present: Record<string, boolean> = {
    butler: butler !== undefined, meetings: meetings !== undefined, devices: devices !== undefined, lan: devices !== undefined, peak: peak !== undefined,
    connector: connector !== undefined, setup: onOpenSetup !== undefined, experiments: experiments !== undefined, account: account !== undefined, today: todayView !== undefined,
  }
  const entries = SETTINGS_ENTRIES[group].filter(one => present[one.id] !== false)
  const here = SETTINGS_GROUPS.find(one => one.id === group)
  const [groupHelp, setGroupHelp] = useState(false)
  // 带着落点来的(左栏「查看与撤回」、额度那一格的入口键):开在那一组,跳到那一节。上面几节拉完数据会把它往下推,隔一会儿再对一次。
  useEffect(() => {
    const row = openAt?.row
    if (atGroup === undefined || row === undefined) return undefined
    jumpTo(row)
    const again = setTimeout(() => jumpTo(row), 500)
    return () => clearTimeout(again)
  }, [atGroup, openAt?.row])
  // Esc 关闭:弹窗是临时态,键盘要能退出来。挂在 window 上而不是容器上——焦点这会儿
  // 可能在凭据输入框里,挂容器会漏掉一部分场景。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 设置里弹出的确认框先收那一层(它自己在 document 上收 Esc),设置本身不跟着关。
      if (document.querySelector('.ben-wb__setdlg .wb-ui-veil') !== null) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="ben-wb__setdlg-backdrop" onClick={onClose}>
      {/* 点内容区不该关掉弹窗(正在输入的 Key 会白填一遍)——只有点遮罩才关。 */}
      <div
        className={coverClass('ben-wb__setdlg', cover)}
        style={cover}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={event => event.stopPropagation()}
      >
        <div className="ben-wb__setdlg-head">
          <h2 className="ben-wb__ttl">设置</h2>
          <span className="ben-wb__setdlg-sub">事务官座机</span>
          <button type="button" aria-label="关闭设置" onClick={onClose}>✕</button>
        </div>

        {/* 顶上那一排分组(2026-09-28,卡 SG)。一次只看一组 —— 在这之前是十几节一条长滚动,
            维护者在真壳里「从上翻到下」找不到东西。 */}
        <div className="ben-wb__setbody">
        <div className="ben-wb__setside">
        <div className="ben-wb__setnav" role="tablist" aria-label="设置分组" aria-orientation="vertical">
          {SETTINGS_GROUPS.map(one => (
            <button
              key={one.id}
              type="button"
              role="tab"
              id={`ben-wb-setnav-${one.id}`}
              aria-selected={one.id === group}
              aria-controls="ben-wb-setgrp"
              onClick={() => setGroup(one.id)}
            >
              {one.label}
            </button>
          ))}
        </div>
        <p className="ben-wb__setnav-foot">按 Esc 关闭</p>
        </div>

        <div
          className="ben-wb__setgrp"
          id="ben-wb-setgrp"
          role="tabpanel"
          aria-labelledby={`ben-wb-setnav-${group}`}
        >
          {/* 组首(评审页 `.setting-heading`):组名 + 一句说明,右边一颗 ? 点开长说明;下面一排跳转小钮(`.settings-jump`),只写节名。 */}
          <div className="ben-wb__setgrp-head">
            <div>
              <h2 className="ben-wb__setgrp-ttl">{here?.label}</h2>
              <p className="ben-wb__setgrp-desc">{here?.desc}</p>
            </div>
            <span className="ben-wb__setgrp-help">
              <button type="button" aria-label="这一组管什么" aria-expanded={groupHelp} onClick={() => setGroupHelp(open => !open)}><Icon name="circle-help" /></button>
              <Popover open={groupHelp} label="这一组管什么" align="end" onClose={() => setGroupHelp(false)}>{here?.lead}</Popover>
            </span>
          </div>
          <nav className="ben-wb__setjump" aria-label="这一组有什么">
            {entries.map(one => (
              <button key={one.id} type="button" data-entry={one.id} onClick={() => jumpTo(one.id)}>{one.title}</button>
            ))}
          </nav>
          <style>{SETTINGS_ENTRY_STYLE}</style>

          {group === 'butler' && (
            <>
              {/* 记住的规矩(2026-09-24 晚,卡 K):他说过一次就处处算数的那张表,看全、随手删改。
                  这一组的第一节,也是整屏默认停的地方:这是他最常回来改的一节。
                  数据自己拉 GET /butler/rules,没接规矩表时整节不出现。 */}
              <Sec id="rules">
                <RulesPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 它学到了什么(2026-10-09):从行为账里数出来的做法,试用中 / 留下 / 撤掉的,每条能撤。
                  紧跟在「记住的规矩」后面、与它并列不合并:那一节是她明说的(能改字、能写一条),
                  这一节是数出来的(只能撤);明说的规矩在这里只报条数、指回上面,不摆第二份。
                  数据自己拉 GET /habits,没接就整节不出现。 */}
              <Sec id="habits">
                <HabitsPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 事务官的提示词(2026-10-01):AGENTS.md 里每一段摆在一起,看全文、改、恢复默认。
                  紧跟在「记住的规矩」后面 —— 规矩是"她说过一次就算数的那几条",这一节是"它读的那整份交代",
                  同一族,而规矩那一段在这一页里只读并指回上面那一节(同一张表不该有两处入口)。
                  数据自己拉 GET /butler/prompts,没接就整节不出现。 */}
              <Sec id="prompts">
                <PromptsPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 派活与办完提醒(2026-10-23,卡「分层第二刀一」):哪几类事项办完要告诉她、桌面那一类不问就派。
                  紧跟在「交代与偏好」后面:那一节是"它读的那整份交代",这一节是"办完怎么告诉你、哪类活直接派"的两颗开关。
                  数据自己拉 GET /dispatch/prefs,没接就整节不出现。 */}
              <Sec id="dispatch-prefs">
                <DispatchPrefsPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 哨兵(2026-09-09):新增监视项在这里配,列表在事务官浮窗那一栏——
                  配置一次的东西不常驻视野,"现在在盯什么"才常驻。
                  2026-09-28 从「模板」前面挪到这里:它说的是"让事务官替我盯着什么",与规矩同族。 */}
              <Sec id="sentinel">
                <SentinelForm baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 事务官 · 形象与音色(2026-09-11):本机后端的状态、打开配置后台、启停。
                  配置本身在后端自己的页面里,这里不重画。 */}
              {butler !== undefined && (
                <Sec id="butler">
                  <ButlerPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} butler={butler} />
                </Sec>
              )}

              {/* 会议 · 用现成的转写出纪要(2026-10-13):开会没录上、或者别处已经有一份转写时的那条路。
                  摆在这一组:它说的是「把一件事交给事务官去办」,与上面几节同族;
                  纪要出来之后在事务官收件箱那一档与手机会议页上看,这里不重画。
                  没接会议模式(/state.meetings 缺席)就整节不出现。 */}
              {meetings !== undefined && (
                <Sec id="meetings">
                  <MeetingImportPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} meetings={meetings} />
                </Sec>
              )}

              {/* 演示数据(2026-10-13,卡「演示数据一键放进去」):开演前一键放、演完一键清。
                  摆在会议那一节后面、这一组的最后:它与上面几节同族(都是「替我把一件事办了」),
                  但它碰的是看板与任务账,所以自己一节、自己一套收拾的法子。
                  放好之后在哪儿看照旧(看板、今天的待办、发布计划月历、收件箱),这里不重画。 */}
              <Sec id="demo">
                <DemoDataPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>
            </>
          )}

          {group === 'devices' && (
            <>
              {/* 手机与设备(2026-09-11,设计-事务官完整材料 §2:配对先于账号)。
                  手机配对页的提示写的正是「设置 → 手机与座机 → 添加」,首次流程之后要配第二台手机只有这一个入口。
                  评审页这一组三节:已连接设备 / 电脑保持唤醒 / 连接状态。 */}
              {devices !== undefined && (
                <Sec id="devices">
                  <DevicesPanel baseUrl={baseUrl} fetchImpl={fetchImpl ?? fetch} section={devices} />
                </Sec>
              )}

              {/* 电脑保持唤醒(2026-09-28 卡 AW「工作台开着时电脑不睡」+ 10-03「出门时电脑不睡」)。评审页把两颗收成一节两行:
                  她在手机上「找不到你的电脑」十次里有九次是这台电脑睡过去了;一颗管整机、一颗管屏幕,挨着看才分得清。
                  两行各自拉 GET /shell/system-awake、/shell/away-keep-awake,哪一行没接就那一行不出现。 */}
              <Sec id="awake">
                <AwakePanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} noRelay={relayConfigured === false} />
              </Sec>

              {/* 连接状态:局域网那颗开关与地址(原来在「手机与设备」最上面)。 */}
              {devices !== undefined && (
                <Sec id="lan">
                  <LanPanel baseUrl={baseUrl} fetchImpl={fetchImpl ?? fetch} lan={devices.lan} />
                </Sec>
              )}
            </>
          )}

          {group === 'agents' && (
            <>
              {/* 各家能做什么(2026-09-25,卡 O):六家各三格(能聊天 / 能改本机文件 / 能把结果收回来),查出来的;
                  哪格不行给一键修(「登录 Claude」开它自己的登录页,账号密码不经手)。下面带每件事的上限。没接体检时整节不出现。 */}
              <Sec id="caps">
                <AgentCapsPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 模型服务(2026-09-17):默认「用工作台提供的服务」,用户什么都不用填;
                  想用自己的 DeepSeek 账号就切第二项,那串密钥仍然填在下面「各家的密钥与登录」那一格
                  (不在这里再画一个输入框——同一件东西不该有两处入口)。
                  放在密钥那一节**之前**:先说清楚「默认不用填」,再让他看到可以填的地方。 */}
              <Sec id="model">
                <ModelPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 各家的密钥与登录(原名「额度凭据」):DeepSeek 与 Kimi 要填了才取得到数。
                  填完服务端立刻重采并推给展示台,抬头就能看到数字变化。
                  2026-09-21:数据复盘的「登录小红书创作者中心」也落在这一节里 —— Ben 的卡写的是
                  「设置 → 额度凭证 旁边」。它与上面那几家的根本不同是**一个凭据都不取**
                  (见 CredentialPanel.tsx 里 openXhsLogin 那段)。 */}
              <Sec id="credentials">
                <CredentialPanel
                  baseUrl={baseUrl}
                  {...(fetchImpl === undefined ? {} : { fetchImpl })}
                  {...(xhs === undefined ? {} : { xhs })}
                  {...(collect === undefined ? {} : { collect })}
                  {...(atGroup === undefined || openAt?.row === undefined
                    ? {}
                    // 额度那一格那颗入口键指的就是这一节里的某一行(卡 QK):点亮它,她不必再找。
                    : { focusRow: openAt.row })}
                />
              </Sec>

              {/* 个人访问令牌(2026-10-21 协作区):给命令行 workbench 与她的脚本用;明文只在发的那一下显示一次。没接整节不出现。
                  评审页这一组没有它(只画了能力 / 模型 / 密钥三节),排在最后,样子同那三节。 */}
              <Sec id="token">
                <PersonalTokenPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>
            </>
          )}

          {group === 'machine' && (
            <>
              {/* 账号(2026-09-17):用户名、改密码、退出登录。退出之后界面回登录屏。 */}
              {account !== undefined && (
                <Sec id="account">
                  <AccountPanel
                    baseUrl={baseUrl}
                    {...(fetchImpl === undefined ? {} : { fetchImpl })}
                    view={account}
                    onChanged={() => { onAccountChanged?.() }}
                  />
                </Sec>
              )}

              {/* 模板(2026-09-21):两张卡片,点「切换」二次确认。
                  数据自己拉 GET /template,没接模板服务时整节不出现。 */}
              <Sec id="template">
                <TemplatePanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 今天的待办那一格换显示(2026-10-12 周三演示的救场:电话里没切成就在这儿点)。
                  两颗键的字就是 `TODAY_VIEW_TITLES`(10-13 起是「卡片 / 列表」)。 */}
              {todayView !== undefined && (
                <Sec id="today">
                  <TodayViewPicker baseUrl={baseUrl} fetchImpl={fetchImpl ?? fetch} current={todayView} />
                </Sec>
              )}

              {/* 自定义组件(2026-09-21):在用的 + 回收站。模板管的是"工作台自带那些格子怎么排",这一节管的是
                  "我自己让人做出来的那些格子";**切模板不动自定义组件**。没接自定义模块服务时整节不出现(组件自己判)。 */}
              <Sec id="modules">
                <CustomModulesPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 用户层(2026-10-21,卡「分层第一刀」):目录在哪、装了什么、哪个坏了、四族插件。
                  评审页这一组画的是 账号 / 工作布局 / 待办显示 / 自定义组件 四节;用户层是稿里没有的,排在最后。
                  没接用户层(GET /user-layer 404)时整节不出现。 */}
              <Sec id="userlayer">
                <UserLayerPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* 事项类型(2026-10-22 拍板:类型表做成设置,团队自配名字 / 图标 / 两套底色,事务官经 8791 也能改)。
                  读写 GET / POST /collab/types,本机这一份;工作室共用一张表是另一张卡。没接就整节不出现。 */}
              <Sec id="itemtypes">
                <ItemTypesPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>
            </>
          )}

          {group === 'update' && (
            /* 更新(2026-09-18,Ben:「能加热更新的按钮吗,更新完之后重启」;09-28 卡 UP 收成一句话一颗按钮)。
               它自己一组:这一组打开就已经在查了,屏上除了一句话什么都不欠。 */
            <Sec id="update">
              <UpdatePanel
                baseUrl={baseUrl}
                {...(fetchImpl === undefined ? {} : { fetchImpl })}
                {...(currentVersion === undefined ? {} : { currentVersion })}
                {...(runtimeStale === undefined ? {} : { runtimeStale })}
              />
            </Sec>
          )}

          {group === 'advanced' && (
            <>
              {/* 目录(2026-09-17 卡 C):扫描根、收件箱目录、事务官仓库。
                  数据不走 /state —— 它不是"看板上的状态"而是配置,自己拉自己的 GET /config/paths。 */}
              <Sec id="paths">
                <PathsPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
              </Sec>

              {/* DeepSeek 峰谷时段(2026-09-09)。默认按官方两段,Ben 可改;
                  改完落盘 ~/.dsh/workbench/peak-hours.json,重启不丢。 */}
              {peak !== undefined && (
                <Sec id="peak">
                  <PeakHoursPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} peak={peak} />
                </Sec>
              )}

              {/* 连接器(卡 OC2):默认装上,开机后自己装。这里只有一行状态 + 卸掉。 */}
              {connector !== undefined && (
                <Sec id="connector">
                  <ConnectorPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} connector={connector} />
                </Sec>
              )}

              {/* 体检与修复(2026-09-17 改名并降级):`setup_required` 不再让它自己弹,入口只剩这一行;
                  旁边那颗「重新走一遍首次流程」擦掉 first_run_done_at。
                  **这三个入口在「不可改清单」旁边,一个都不能丢** —— 只是从长滚动的最末挪进「高级」。 */}
              {onOpenSetup !== undefined && (
                <Sec id="setup">
                  <SetupReopenRow
                    onOpen={() => { onClose(); onOpenSetup() }}
                    {...(onReplayFirstRun === undefined ? {} : { onReplayFirstRun: () => { onClose(); onReplayFirstRun() } })}
                    {...(onRedoOnboarding === undefined ? {} : { onRedoOnboarding: () => { onClose(); onRedoOnboarding() } })}
                  />
                </Sec>
              )}
              {/* 实验开关(2026-10-21):视频链、会议录音、座机听筒、读窗派活到豆包 / Kimi。
                  评审页这一组画的是 目录 / 峰谷时段 / 连接器 / 体检与引导;实验开关是稿里没有的,排在最后。 */}
              {experiments !== undefined && (
                <Sec id="experiments">
                  <ExperimentsPanel view={experiments} baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
                </Sec>
              )}
            </>
          )}

          {/* 整组都没接线时才看得见(CSS :has 判的),省得留一块解释不了的空白。 */}
          <p className="ben-wb__setgrp-empty">{SETTINGS_EMPTY_LINE}</p>
        </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 「电脑保持唤醒」一节两行(评审页 `section('awake', '电脑保持唤醒', …)`):
 *
 * - **工作台开着时电脑不睡**(2026-09-28,卡 AW)。维护者 09-28 早:「电脑自己会锁屏,…一锁屏小米上就显示找不到你的电脑。」
 *   真相是睡过去才有关系(锁屏不碍事),所以工作台在运行期间按住「整机别因为闲着而睡」。**默认开**。
 * - **出门时电脑不睡**(2026-10-03,**缺省关**):锁屏的时候窗口型的那几家(豆包 / Kimi / Manus…)一扇窗都列不出来,
 *   她在外面答的那句话送不进去(`docs/交接-1003-锁屏时窗口型的家.md`)。上面那一颗管整机,这一颗管屏幕。
 *
 * 两颗各自拉 GET /shell/system-awake、/shell/away-keep-awake(它们是配置,不走 /state);404(旧版插件)那一行不出现,
 * 两行都没有整节不出现。点完以回包为准:`applied` 说的是「壳当场生效了没有」,壳没接上时**如实**说要重开工作台。
 * 代价那两段话(不插电更费电、家里那块屏一直亮着)收在「代价与说明」里,一点就开。
 */
function useAwakeSwitch(baseUrl: string, fetchImpl: typeof fetch | undefined, path: string) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [phoneAway, setPhoneAway] = useState<boolean | undefined>(undefined)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await (fetchImpl ?? fetch)(`${baseUrl}${path}`)
        if (!res.ok || !alive) return
        const body = await res.json() as unknown
        const said = (body ?? {}) as { enabled?: unknown, phone_away?: unknown }
        // 回一个 200 + 空 body 的中间层照样当「没接」(同 PathsPanel 那条)。
        if (typeof said.enabled !== 'boolean') return
        setEnabled(said.enabled)
        setPhoneAway(typeof said.phone_away === 'boolean' ? said.phone_away : undefined)
      }
      catch {
        // 读不到就那一行不出现:这一屏里每节各自独立。
      }
    })()
    return () => { alive = false }
  }, [baseUrl, fetchImpl, path])

  async function toggle(next: boolean): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const res = await (fetchImpl ?? fetch)(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const body = await res.json() as unknown
      const said = (body ?? {}) as { enabled?: unknown, phone_away?: unknown, applied?: unknown, reason?: unknown, error?: unknown }
      if (!res.ok) { setNote(typeof said.error === 'string' ? said.error : '改不了这个开关'); return }
      if (typeof said.enabled === 'boolean') setEnabled(said.enabled)
      setPhoneAway(typeof said.phone_away === 'boolean' ? said.phone_away : undefined)
      setNote(said.applied === true
        ? '已经生效'
        : `已保存,重开工作台后生效${typeof said.reason === 'string' && said.reason !== '' ? `(${said.reason})` : ''}`)
    }
    catch (error) {
      setNote(error instanceof Error ? error.message : '改不了这个开关')
    }
    finally {
      setBusy(false)
    }
  }

  return { enabled, phoneAway, note, busy, toggle }
}

function AwakePanel({ baseUrl, fetchImpl, noRelay = false }: { baseUrl: string, fetchImpl?: typeof fetch, noRelay?: boolean }) {
  const system = useAwakeSwitch(baseUrl, fetchImpl, '/shell/system-awake')
  const away = useAwakeSwitch(baseUrl, fetchImpl, '/shell/away-keep-awake')
  if (system.enabled === null && away.enabled === null) return null
  return (
    <SetSection id="ben-wb-system-awake" title="电脑保持唤醒">
      {system.enabled !== null && (
        <SetRow title={SYSTEM_AWAKE_LABEL} sub={system.note ?? SYSTEM_AWAKE_SUB}>
          <input
            type="checkbox"
            aria-label={SYSTEM_AWAKE_LABEL}
            checked={system.enabled}
            disabled={system.busy}
            onChange={event => { void system.toggle(event.target.checked) }}
          />
        </SetRow>
      )}
      {away.enabled !== null && (
        <SetRow title={AWAY_AWAKE_LABEL} sub={away.note ?? AWAY_AWAKE_SUB}>
          <input
            type="checkbox"
            aria-label={AWAY_AWAKE_LABEL}
            checked={away.enabled}
            disabled={away.busy}
            onChange={event => { void away.toggle(event.target.checked) }}
          />
        </SetRow>
      )}
      <SetExplain label="代价与说明">
        {system.enabled !== null && <p>{systemAwakeHint(system.enabled)}</p>}
        {away.enabled !== null && <p>{awayAwakeHint(away.enabled)}</p>}
        {away.enabled !== null && <p>{noRelay ? AWAY_NO_RELAY_LINE : awayAwakePhoneLine(away.phoneAway)}</p>}
      </SetExplain>
    </SetSection>
  )
}

/** 两行的名字与副行照评审页。 */
export const SYSTEM_AWAKE_LABEL = '工作台开着时,电脑不睡眠'
export const SYSTEM_AWAKE_SUB = '方便手机在远处继续连接。'
export const AWAY_AWAKE_LABEL = '出门时,屏幕保持唤醒'
export const AWAY_AWAKE_SUB = '默认关闭,按需要单独打开。'

/** 这台没接中转(零服务器档)时那一句:出门的手机够不着这台电脑,不是「问不到」。 */
export const AWAY_NO_RELAY_LINE = '这台没接中转:手机出了家里的 Wi-Fi 就连不上这台电脑,出门那一路用不上;在家照常。'

/**
 * 「代价与说明」里那一句。两句都要说清**代价**与**边界**:
 * 屏幕照样会黑会锁(她真正在意的"锁屏"没被改掉)、合盖照样睡、不插电更费电。
 * 不写「电源断言」「idle sleep」这种内部词 —— 她不是程序员。
 */
export function systemAwakeHint(enabled: boolean): string {
  return enabled
    ? '工作台开着的时候,电脑不会因为闲着自己睡过去 —— 你在外面用手机才找得到它。屏幕照样会黑、会锁,合上盖子照样睡;不插电时比平时更费电。'
    : '电脑闲着会照系统设置自己睡过去。一睡,手机上就连不上它了(手机会说"电脑睡着了")。'
}

/**
 * 出门那一颗的说明。开着 → 你不在家的时候那块屏一直亮着(她看不见,所以必须写出来);
 * 关着 → 屏幕照系统设置睡,一睡就锁,那几家这会儿送不进去,得等她回来解锁。
 */
export function awayAwakeHint(enabled: boolean): string {
  return enabled
    ? '你带着手机出门、手机还连着这台电脑的时候,屏幕就不会自己暗下去 —— 屏幕一睡就锁屏,而锁了屏,豆包、Kimi 这类要开窗口才说得上话的,你在外面答的那句话就送不进去,只能等你回家解锁。代价说清:你不在家的时候,家里那块屏是一直亮着的,也更费电。'
    : '屏幕照系统设置该暗就暗,一睡就锁屏。锁着屏的时候,豆包、Kimi 这类要开窗口才说得上话的,你在外面说的那句话送不进去 —— 工作台会替你排着,等你回家解锁再送。'
}

/**
 * 「这会儿手机在不在外面」那一行。**不知道就说不知道**(没接通道层、工人掉线、这台还没报过)——
 * 显示成「没在外面」会让她以为开关坏了,而真相是我们问不到。
 */
export function awayAwakePhoneLine(phoneAway: boolean | undefined): string {
  if (phoneAway === undefined) return '这会儿手机在不在外面:问不到(这台电脑上的通道还没接上,或者刚重启、还没报过)。'
  return phoneAway
    ? '这会儿:手机在外面连着 —— 开着这颗开关的话,屏幕正被按着不让它睡。'
    : '这会儿:手机没在外面连着(在同一个 Wi-Fi 里,或者没连)—— 屏幕照平时那样。'
}

/**
 * 已连接设备(2026-09-11;2026-09-16 起以扫码为主;评审页 `section('devices', '已连接设备', …)`)。
 *
 * 每台一行:名字、种类 · 最近连接,「改名」「撤销连接」;底下一颗「添加手机或座机」(= 生成二维码,POST /pair/start)。
 * 数据全从 /state 来(父组件每拍轮询),这里不自己拉:点完不改本地状态,等下一拍 /state 把真相带回来。
 * 配对码本身是钥匙:服务端只对本机来源的 /state 返回,这里不做任何缓存。二维码大、居中;6 位码只是扫不了时的兜底。
 * 局域网那颗开关挪到「连接状态」那一节(`LanPanel`)。
 */
function DevicesPanel({ baseUrl, fetchImpl, section }: {
  baseUrl: string
  fetchImpl: typeof fetch
  section: DevicesSection
}) {
  const { pairing, devices } = section
  return (
    <SetSection id="ben-wb-devices" title="已连接设备" className="ben-wb__devices">
      {devices.length === 0
        ? <SetLead>还没有配对的设备。</SetLead>
        : (
            <div className="ben-wb__device-list" role="list" aria-label="已配对设备">
              {devices.map(device => (
                <DeviceRow key={device.id} device={device} baseUrl={baseUrl} fetchImpl={fetchImpl} />
              ))}
            </div>
          )}

      {pairing !== undefined && (
        <div className="ben-wb__spair ben-wb__devices-pair">
          {pairing.qr !== undefined
            ? (
                <>
                  <PairQr text={pairing.qr} px={240} />
                  <p className="ben-wb__devices-scan">用手机上的「事务官」扫这个</p>
                  <p className="ben-wb__devices-code">
                    扫不了就在手机上手输:<b className="ben-wb__devices-digits">{pairing.code}</b>
                  </p>
                </>
              )
            : (
                <>
                  <p>没有局域网地址就没有二维码。</p>
                  <p className="ben-wb__devices-code">
                    在手机上手输:<b className="ben-wb__devices-digits">{pairing.code}</b>
                  </p>
                </>
              )}
          <p>{`到 ${clock(pairing.expires_at)} 前有效 · 用一次就作废;错 5 次锁 10 分钟。`}</p>
        </div>
      )}

      <SetActions>
        <SetBtn kind="outline" onClick={() => { void postSilently(`${baseUrl}/pair/start`, {}, fetchImpl) }}>
          添加手机或座机
        </SetBtn>
      </SetActions>
      <SetExplain label="没看到座机?">
        <p>{DEVICES_ACCOUNT_HINT}</p>
      </SetExplain>
    </SetSection>
  )
}

/**
 * 连接状态(评审页 `section('connections', '连接状态', …)`):局域网一行 —— 开关 + 现在在哪个地址等手机、广没广播。
 * 稿里还有「远程连接」一行,这里没有那份数据(/state 不报中转连没连上),不编。
 */
function LanPanel({ baseUrl, fetchImpl, lan }: { baseUrl: string, fetchImpl: typeof fetch, lan: LanView }) {
  const address = lan.host === undefined ? undefined : `${lan.host}:${lan.port}`
  return (
    <SetSection id="ben-wb-lan" title="连接状态">
      <SetRow
        title="局域网"
        sub={lan.enabled
          ? `工作台在 ${address ?? '(取不到本机的局域网地址)'} 等手机;${lan.advertising ? '正在局域网内广播,手机 App 会自动发现' : '没有在广播,手机要扫码或输码'}。`
          : '开关关着时,手机连不上工作台;打开后同时监听局域网并广播,关掉即回到只本机。'}
      >
        <input
          type="checkbox"
          aria-label="允许手机在局域网访问"
          checked={lan.enabled}
          onChange={event => { void postSilently(`${baseUrl}/lan`, { enabled: event.target.checked }, fetchImpl) }}
        />
      </SetRow>
    </SetSection>
  )
}

/**
 * 解除配对前问的那一句。**说清它到底撤了什么**(2026-09-28,卡 HR)。
 *
 * 以前写的是「解除之后这台话筒要重新扫码才能连回来」,两处都是假的:
 *   ① 座机没有摄像头,它这辈子没扫过码(入口是手机上「设置 → 座机 → 添加座机」的蓝牙那一路);
 *   ② 更要紧的是,它压根没「断」—— 这条路只把本机 `devices.json` 里那条记录标成已撤销
 *      (server/devices.ts 的 revoke),账号那边那把中转设备令牌一个字节都没碰。
 *      于是维护者 2026-09-28 在另一台 Air 上解除之后以为座机丢了,而那只话筒还在账号房间里,
 *      提机照样有人接(实情见 docs/交接-0928-座机解除后找回.md)。
 *
 * 所以这句话现在只说真的那三件:撤的是这台电脑的信任、账号那把钥匙不动、想连回这台电脑怎么做。
 * 「彻底不认这个账号」是另一条路(设置 → 工作台账号 → 我的设备),这里指过去、不代办。
 */
export function revokeConfirmText(device: DeviceView): string {
  // 怎么连回这台电脑:座机走手机上那条蓝牙流程,别的设备走二维码。
  const back = device.kind === 'handset'
    ? '要它重新连回这台电脑,在手机上「设置 → 座机 → 添加座机」再走一次'
    : '要它连回这台电脑,在手机上重新扫一次码'
  return `撤销「${device.name}」的连接,只撤这台电脑对它的信任 ——`
    + `它记在账号下的那把钥匙不动,${device.kind === 'handset' ? '提机照样有人接' : '它照样进得了账号房间'}。`
    + `${back};要它彻底离开这个账号,去「账号 → 我的设备」里移除。`
}

/**
 * 设备列表底下那一句(2026-09-28,卡 HR)。
 *
 * 维护者就是在这一屏上「找不到座机」的:这一节列的只有**这台电脑**的配对记录,
 * 而座机真正靠的是账号下那把令牌。列表里没有它不等于它丢了 —— 这句话省掉的正是
 * 「以为座机没了 → 想办法重置派」那一整条弯路。**一台都没配对时也照样说**。
 */
export const DEVICES_ACCOUNT_HINT
  = '座机没列在这儿不等于丢了:这一节只管这台电脑的配对,座机记在账号下那把钥匙不受它影响 —— 提起听筒就能试。'
    + '要看账号名下有哪几台,去「账号 → 我的设备」。'

/**
 * 已配对设备的一行(2026-09-25,卡 fix/evening-gaps 第 2 条):名字、种类、在线;**改名**(就地改,回车存、Esc 放弃)
 * 与**撤销连接**(先问一句,共用确认弹层;以前一点就撤,没有回头路)。
 * 改名走 POST /pair/rename(只认回环),结果以下一拍 /state 为准。
 */
function DeviceRow({ device, baseUrl, fetchImpl }: { device: DeviceView, baseUrl: string, fetchImpl: typeof fetch }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(device.name)
  const [note, setNote] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    const name = draft.trim()
    if (name === '' || name === device.name) { setEditing(false); setNote(null); return }
    try {
      const res = await fetchImpl(`${baseUrl}/pair/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: device.id, name }),
      })
      if (res.ok) { setEditing(false); setNote(null); return }
      setNote('没改成:工作台没接这一条,等一会儿再试')
    }
    catch { setNote('没改成:连不上工作台') }
  }
  // 撤销之前先问一句,话说清它到底撤了什么(`revokeConfirmText`);共用确认弹层(10-22 统筹定 28)。
  const [asking, setAsking] = useState(false)
  return (
    <>
      <SetRow
        role="listitem"
        title={editing
          ? (
              <input
                aria-label={`给「${device.name}」改名`}
                value={draft}
                maxLength={64}
                autoFocus
                onChange={event => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void save() }
                  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); setDraft(device.name); setNote(null) }
                }}
              />
            )
          : device.name}
        sub={`${deviceKindText(device)} · ${deviceSeenText(device)}`}
      >
        {editing
          ? (
              <span className="ben-wb__srow-acts">
                <SetBtn aria-label={`保存「${device.name}」的新名字`} onClick={() => { void save() }}>保存</SetBtn>
                <SetBtn aria-label={`不改「${device.name}」的名字`} onClick={() => { setEditing(false); setDraft(device.name); setNote(null) }}>取消</SetBtn>
              </span>
            )
          : (
              <span className="ben-wb__srow-acts">
                <SetBtn aria-label={`改名:${device.name}`} onClick={() => { setDraft(device.name); setEditing(true) }}>改名</SetBtn>
                <SetBtn kind="text" onClick={() => setAsking(true)}>撤销连接</SetBtn>
              </span>
            )}
      </SetRow>
      {note !== null && <SetMsg>{note}</SetMsg>}
      {asking && (
        <ConfirmDialog
          {...CONFIRMS.revokeDevice}
          body={revokeConfirmText(device)}
          onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); void postSilently(`${baseUrl}/pair/revoke`, { id: device.id }, fetchImpl) }}
        />
      )}
    </>
  )
}

/**
 * 「这台是什么」(2026-09-21,座机形态:手机 + 树莓派话筒)。
 *
 * `kind` 由服务端按配对时报的 platform 推(server/devices.ts 的 deviceKindOf)。
 * **缺省显示 platform 原文**:老工作台的回包里没有 kind,那时照旧显示 `android`,
 * 而不是凭空把一台设备说成「手机」。
 */
export function deviceKindText(device: DeviceView): string {
  if (device.kind === 'handset') return '话筒(树莓派)'
  if (device.kind === 'phone') return '手机'
  return device.platform
}

/**
 * 在线算多久(毫秒)。两分钟 —— 派每 60 秒向 8791 报一次到(phone-bridge 的 HEARTBEAT_SEC),
 * 留一拍的余量,不至于因为一次丢包就闪成离线。
 */
export const DEVICE_ONLINE_MS = 2 * 60_000

/**
 * 在线 / 离线那一行。**「在线」在这儿的意思很窄:最近两分钟向 8791 报过到。**
 *
 * 出了局域网(或者 Mac 睡着)报不到,这里就会显示离线 —— 而那台设备可能正在房间里
 * 好好待着。**不粉饰**:与其显示一个猜出来的「在线」,不如显示一个口径明确的
 * 「最近连接 X」。要真的知道房里有谁,那在 /channel/status 里(另一件事)。
 */
export function deviceSeenText(device: DeviceView, now: number = Date.now()): string {
  const at = Date.parse(device.last_seen_at)
  if (Number.isNaN(at)) return `最近连接 ${clock(device.last_seen_at)}`
  return now - at <= DEVICE_ONLINE_MS ? '在线' : `离线 · 最近连接 ${clock(device.last_seen_at)}`
}

/** ISO 时刻 → 本地「MM-DD HH:mm」。解析不了就原样给,不编。 */
function clock(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}

/**
 * 峰谷时段设置(2026-09-09,借 dsh-save-money 的时间窗语义)。
 *
 * 只改「哪几段算高峰」。**不做"高峰自动暂停"那类开关**——那是 save-money 的主功能,
 * 我们的纪律是只给意识、不替 Ben 做决定(设计-借鉴功能落位与资产区 §二)。
 *
 * 校验在服务端(quota/peakHours.ts 的 validatePeakSchedule),这里只把它的话原样显示:
 * 两处各写一份校验迟早会不一致,而不一致的那次一定是界面放过了服务端要拒的东西。
 */
function PeakHoursPanel({ baseUrl, fetchImpl, peak }: {
  baseUrl: string
  fetchImpl?: typeof fetch
  peak: DeepSeekPeakView
}) {
  const [rows, setRows] = useState<{ start: string, end: string }[]>(
    () => peak.periods.map(period => ({ ...period })),
  )
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function edit(index: number, field: 'start' | 'end', value: string): void {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  async function save(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await (fetchImpl ?? fetch)(`${baseUrl}/peak-schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ periods: rows }),
      })
      const body = await res.json() as { error?: string }
      // 服务端的话是说给人听的(「第 2 段的起点要早于终点」),原样转达,不自己编一句。
      setMessage(res.ok ? '已保存' : (body.error ?? '保存失败'))
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <SetSection id="ben-wb-peak" title="峰谷时段">
      <SetLead>
        {`DeepSeek 现在是${peak.phase === 'peak' ? '高峰' : '低谷'} · ${peak.next_switch} 转${peak.next_phase === 'peak' ? '高峰' : '低谷'}。只用于显示与日结分账,不会自动暂停任何任务。`}
      </SetLead>

      {/* 稿里是「低谷开始 / 结束」两格;我们存的是几段高峰,一段一行(名 | 开始 结束 | 删),同目录那一节的行。 */}
      {rows.map((row, index) => (
        <div className="ben-wb__sdir" key={index}>
          <span>{`高峰第 ${index + 1} 段`}</span>
          <span className="ben-wb__sdir-val">
            <input
              aria-label={`第 ${index + 1} 段高峰开始`}
              value={row.start}
              onChange={event => edit(index, 'start', event.target.value)}
            />
            <input
              aria-label={`第 ${index + 1} 段高峰结束`}
              value={row.end}
              onChange={event => edit(index, 'end', event.target.value)}
            />
          </span>
          <SetBtn aria-label={`删掉第 ${index + 1} 段`} onClick={() => setRows(prev => prev.filter((_, i) => i !== index))}>删</SetBtn>
        </div>
      ))}

      <SetActions>
        <SetBtn kind="text" onClick={() => setRows(prev => [...prev, { start: '', end: '' }])}>加一段</SetBtn>
        <SetBtn kind="outline" disabled={busy} onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存时段'}
        </SetBtn>
      </SetActions>

      {message !== null && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}

/**
 * 目录(2026-09-17 卡 C 第 6 条;设计-电脑端登录台梳理 §四 + Ben §八④拍板)。
 *
 * 三样东西改在一处:项目区扫哪几个根、收件箱盯哪几个目录、事务官默认开在哪个仓库。
 * 交互语言照抄这一屏里已有的两节(CredentialPanel 的行式输入 + PeakHoursPanel 的加/删/保存):
 * 同一个弹窗里不该出现第三种手感。
 *
 * ## 三条纪律
 *
 * 1. **校验只在服务端**。这里一条都不重写——两处各写一份迟早不一致,而不一致的那次
 *    一定是界面放过了服务端要拒的东西(PeakHoursPanel 顶部同一条)。
 * 2. **服务端说什么就显示什么**。「收件箱目录 /nope 不存在」这种话比"保存失败"有用一万倍。
 * 3. **要重启就说要重启**。事务官仓库那一条改完 restart_required 是 true,
 *    那就不能说"已经生效"——说了 Ben 会以为好了,然后引导整块继续 404(D13)。
 *
 * 没配过时把**默认值**填进输入框当底稿:空表单看着像"什么都没在扫",而实际上那三个默认根
 * 一直在扫。同时用一句话说明"这是默认值,还没配过"。
 */
interface PathsScanRoot { path: string, depth: number }
interface PathsPayload {
  scan_roots: PathsScanRoot[] | null
  inbox_dirs: string[] | null
  butler_cwd: string | null
  defaults: { scan_roots: PathsScanRoot[], inbox_dirs: string[] }
  effective: {
    scan_roots: PathsScanRoot[]
    inbox_dirs: string[]
    butler_cwd: string | null
    butler_cwd_source: 'env' | 'app.json' | 'none'
  }
}

const PATHS_DEPTHS = [1, 2, 3] as const

/**
 * 回包是不是真的那个形状。
 *
 * 为什么要判:这一节是"接口在就出现、不在就整节消失"。判据不能只看 HTTP 200——
 * 旧版插件、或者任何把 200 当默认值的中间层,都会回一个 200 + 空 body,
 * 那时候直接 `payload.effective.xxx` 会当场把整个设置弹窗炸掉(实测:并行跑时
 * 别的用例的 fetch 桩正是回 `{}`,一炸就是整个文件红)。**没有就当没接**。
 */
function isPathsPayload(body: unknown): body is PathsPayload {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Partial<PathsPayload>
  return Array.isArray(raw.defaults?.scan_roots)
    && Array.isArray(raw.defaults?.inbox_dirs)
    && Array.isArray(raw.effective?.scan_roots)
    && Array.isArray(raw.effective?.inbox_dirs)
    && typeof raw.effective?.butler_cwd_source === 'string'
}

function PathsPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const [payload, setPayload] = useState<PathsPayload | null>(null)
  const [roots, setRoots] = useState<PathsScanRoot[]>([])
  const [dirs, setDirs] = useState<string[]>([])
  const [repo, setRepo] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await (fetchImpl ?? fetch)(`${baseUrl}/config/paths`)
        // 404 = 这台服务没接路径配置(旧版插件)。整节不出现,不摆一个点不动的空表单。
        if (!res.ok || !alive) return
        const body = await res.json() as unknown
        if (!alive || !isPathsPayload(body)) return
        setPayload(body)
        // 底稿取 effective:没配过时它就是默认值,配过就是配的那一份。
        setRoots(body.effective.scan_roots.map(root => ({ ...root })))
        setDirs([...body.effective.inbox_dirs])
        setRepo(body.butler_cwd ?? '')
      }
      catch {
        // 读不到就整节不出现(同上)。这一屏里其它节各自独立,不该被它拖垮。
      }
    })()
    return () => { alive = false }
  }, [baseUrl, fetchImpl])

  if (payload === null) return null

  const neverConfigured = payload.scan_roots === null && payload.inbox_dirs === null && payload.butler_cwd === null
  const envPinned = payload.effective.butler_cwd_source === 'env'

  async function save(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await (fetchImpl ?? fetch)(`${baseUrl}/config/paths`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scan_roots: roots, inbox_dirs: dirs, butler_cwd: repo.trim() }),
      })
      const body = await res.json() as unknown
      const said = (body ?? {}) as { error?: string, hint?: string, restart_required?: boolean }
      if (!res.ok) { setMessage(said.error ?? '保存失败'); return }
      if (isPathsPayload(body)) setPayload(body)
      // 要重启就把服务端那句话原样转达;不用重启才敢说"已经生效"。
      setMessage(said.restart_required === true ? (said.hint ?? '已保存,要重启工作台才生效') : '已保存,已经生效')
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <SetSection id="ben-wb-paths" title="目录">
      <SetLead>
        {neverConfigured
          ? '还没配过,下面填的是默认值。改完保存:扫描根与收件箱目录当场生效,事务官仓库要重启。'
          : '扫描根与收件箱目录改完当场生效;事务官仓库改完要重启工作台。'}
      </SetLead>

      {/* 一行一个目录(评审页 `.directory-row`:名 92 | 值 | 动作);稿里值是只读字 + 「选择」,我们是能直接改的框。 */}
      {roots.map((root, index) => (
        <div className="ben-wb__sdir" key={`root-${index}`}>
          <span>{index === 0 ? '扫描根目录' : ''}</span>
          <span className="ben-wb__sdir-val">
            <input
              aria-label={`第 ${index + 1} 个扫描根`}
              value={root.path}
              spellCheck={false}
              onChange={event => setRoots(prev => prev.map((r, i) => (i === index ? { ...r, path: event.target.value } : r)))}
            />
            <select
              aria-label={`第 ${index + 1} 个扫描根的层数`}
              title="从这个目录往下找几层仓库(1 就是只看它的直接子目录)"
              value={String(root.depth)}
              onChange={event => setRoots(prev => prev.map((r, i) => (i === index ? { ...r, depth: Number(event.target.value) } : r)))}
            >
              {PATHS_DEPTHS.map(depth => <option key={depth} value={depth}>{`${depth} 层`}</option>)}
            </select>
          </span>
          <SetBtn aria-label={`删掉第 ${index + 1} 个扫描根`} onClick={() => setRoots(prev => prev.filter((_, i) => i !== index))}>删</SetBtn>
        </div>
      ))}
      {dirs.map((dir, index) => (
        <div className="ben-wb__sdir" key={`dir-${index}`}>
          <span>{index === 0 ? '收件箱' : ''}</span>
          <span className="ben-wb__sdir-val">
            <input
              aria-label={`第 ${index + 1} 个收件箱目录`}
              value={dir}
              spellCheck={false}
              onChange={event => setDirs(prev => prev.map((d, i) => (i === index ? event.target.value : d)))}
            />
          </span>
          <SetBtn aria-label={`删掉第 ${index + 1} 个收件箱目录`} onClick={() => setDirs(prev => prev.filter((_, i) => i !== index))}>删</SetBtn>
        </div>
      ))}
      <div className="ben-wb__sdir">
        <span>事务官仓库</span>
        <span className="ben-wb__sdir-val">
          <input
            aria-label="事务官仓库目录"
            value={repo}
            spellCheck={false}
            placeholder="留空 = 不配(引导与授权那一块就不接)"
            onChange={event => setRepo(event.target.value)}
          />
        </span>
        <span />
      </div>
      <p className="ben-wb__smsg">
        {envPinned
          ? `这台电脑上另外指定了工作目录(${payload.effective.butler_cwd ?? ''}),它压过这里填的值 —— 想改得先把那一处去掉。`
          : '事务官会话、引导、授权表、日常例程都开在这个仓库里。改完要重启工作台才全部切过去。'}
      </p>

      <SetActions>
        <SetBtn kind="text" onClick={() => setRoots(prev => [...prev, { path: '', depth: 1 }])}>加一个扫描根</SetBtn>
        <SetBtn kind="text" onClick={() => setDirs(prev => [...prev, ''])}>加一个收件箱目录</SetBtn>
        <SetBtn kind="outline" disabled={busy} onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存目录'}
        </SetBtn>
      </SetActions>
      {message !== null && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}

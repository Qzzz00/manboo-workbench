/**
 * 设置里的「模板」那一节(2026-09-21 布局模板)。
 *
 * 两张卡片(名字 + 一句话 + 当前标记),点「切换」二次确认,确认之后 apply;旁边一颗
 * 「回退上次」。
 *
 * ## 三条跟别的设置节一样的规矩
 *
 * 1. **数据自己拉,不走 /state**:模板清单是配置不是看板状态,而 /state 是每秒轮询的东西
 *    (同 PathsPanel 那一节的理由)。`GET /template` 404 = 这台服务没接模板 → **整节不出现**,
 *    不摆一个点不动的空表单。
 * 2. **二次确认不是弹 window.confirm**:弹原生框在壳的 WKWebView 里是另一套外观,
 *    而且用例里要 stub 它。用工作台共用的确认弹层(`ConfirmDialog`,2026-10-22 起设置里七处确认同一个样子)。
 * 3. **结果如实上屏**:建了哪几个文件夹、哪个应用没查到 bundle id,服务端怎么回就怎么写,
 *    不总结成一句「成功」(D13)。
 *
 * ## 切完为什么不用刷新页面
 *
 * 工作台每秒 `GET /state` 一次,apply 写完盘就广播了一次快照 —— 下一拍布局就是新的。
 * 全仓没有 `location.reload()` 这条路(页面 reload 是壳在**插件版本变了**之后自己做的,
 * 跟切模板没关系)。所以这一节切完只说一句「已经切过去了」,不催人刷新、更不重启。
 */
import { useEffect, useState } from 'react'
import { SetActions, SetBtn, SetExplain, SetMsg, SetRow, SetSection, SetSource } from './settings/setKit.tsx'
import { CONFIRMS, ConfirmDialog } from './ui/index.tsx'

/**
 * 切成了之后那一句(2026-09-27,卡 TM)。
 *
 * 修之前这里写的是「界面下一拍就会变,不用刷新、也不用重启」—— 而页面只在打开那一刻
 * 读一次 `/state.layout`,那句话是**假的**(根因见 client/layoutAdopt.ts)。页面那一头修好了,
 * 这句话才第一次成立;同时补上他真正的下一步:**这扇设置窗盖在工作台上,关掉才看得见**。
 */
export const TEMPLATE_APPLIED_LINE
  = '已经切过去了 —— 关掉这扇设置窗就能看见新排布(界面自己换,不用刷新、也不用重启)。'

/**
 * 「服务端回了 ok,但再问一次它还停在原来那个模板」时那一句(2026-09-27,卡 TM)。
 *
 * 切完本来就要重新拉一次 `/template`(当前标记要跟着换过去)。那一拉既然已经在做,
 * 就顺手把它当成**验收**:标记没换过去 = 这次其实没切成,不许让界面停在一句
 * 「已经切过去了」上等他自己发现。三样都要有:没成什么、哪一步没成、下一步做什么。
 */
export const TEMPLATE_NOT_SWITCHED_LINE
  = '但再问一次服务端,它仍然停在原来那个模板 —— 这次没真的切过去。'
  + '请再点一次那张卡;还是这样,就把这句话原样告诉维护者(是服务端没写成,不是界面没刷新)。'

export interface TemplateCard {
  id: string
  name: string
  tagline: string
  project_word: string
  current: boolean
  apps: readonly { label: string, kind: 'native' | 'web', note?: string }[]
  folders: readonly string[]
  board_lanes: readonly string[]
}

export interface TemplatePayload {
  current: string
  has_backup: boolean
  last_backup_at?: string
  /**
   * 盘上记的当前模板这会儿认不出来时的一句人话(2026-10-23,分层二刀二 —— 比如她删了
   * 或改坏了 用户层/布局/<id>.json)。在卡片区原样上屏;缺席 = 没有这种情况。
   */
  note?: string
  templates: readonly TemplateCard[]
}

/**
 * 形状不对就当没拿到(同 PathsPanel 的 isPathsPayload):并行跑用例时这条 fetch 偶尔会
 * 拿到别的节的 mock 响应,直接 `payload.templates.map` 会把整个设置弹窗炸掉。
 */
export function isTemplatePayload(body: unknown): body is TemplatePayload {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Record<string, unknown>
  return typeof raw.current === 'string' && Array.isArray(raw.templates)
}

/** `GET /config/ops-skills` 回的那一份里,这一行状态用得上的几格。 */
export interface OpsSkillsPayload {
  template: string | null
  file: string
  attached: {
    ok: boolean
    expected: readonly string[]
    attached: readonly string[]
    absent: readonly string[]
    stray: readonly string[]
  }
  skills: readonly { name: string, summary: string, found: boolean, attached: boolean }[]
}

/** 同 isTemplatePayload:形状不对就当没拿到,不让一条串了的 mock 把整个设置弹窗炸掉。 */
export function isOpsSkillsPayload(body: unknown): body is OpsSkillsPayload {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Record<string, unknown>
  const attached = raw.attached as Record<string, unknown> | undefined
  if (typeof attached !== 'object' || attached === null) return false
  return typeof attached.ok === 'boolean' && Array.isArray(attached.expected) && Array.isArray(attached.absent)
}

/**
 * 「运营技能:已接上 n 条 / 没接上」那一行(2026-09-22,卡 ①)。
 *
 * ## 它为什么必须存在
 *
 * 在这之前,十份运营技能写好了、接口也有了,但**界面上没有任何一处说得出"接上了没有"** ——
 * 切了运营模板的人,事务官其实一条技能都不知道,而她无从发现。切模板现在会自动接一次
 * (`/template/apply` 里那一下),这一行是**那一下到底成没成的唯一去处**,外加一颗手动的。
 *
 * ## 三条与这一屏别处一致的规矩
 *
 * 1. **数据自己拉**:同 TemplatePanel 本身,`/config/ops-skills` 404(这台服务没接代写)
 *    = 整行不出现,不摆一个点不动的状态。
 * 2. **如实说**:缺哪几段就说缺哪几段(D13),不总结成一句"未就绪"。
 * 3. **接完要说"新开一条会话才读得到"**:技能段跟钩子一样要下一次开会话才生效,
 *    不说这一句她会以为这颗按钮没用(hooksApply 的 `wbHooksRestartHint` 同款教训)。
 */
export function OpsSkillsRow({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const [payload, setPayload] = useState<OpsSkillsPayload | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const call = fetchImpl ?? fetch

  async function reload(): Promise<OpsSkillsPayload | null> {
    try {
      const res = await call(`${baseUrl}/config/ops-skills`)
      if (!res.ok) return null
      const body = await res.json() as unknown
      return isOpsSkillsPayload(body) ? body : null
    }
    catch {
      return null
    }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const next = await reload()
      if (alive && next !== null) setPayload(next)
    })()
    return () => { alive = false }
    // 依赖只列这两样:reload 是每次渲染新建的闭包(同 TemplatePanel 那条 effect)。
  }, [baseUrl, fetchImpl])

  if (payload === null) return null

  async function apply(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/config/ops-skills/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const said = (await res.json().catch(() => ({}))) as {
        error?: string, note?: string, restart_hint?: string
      }
      if (!res.ok) { setMessage(said.error ?? '没接上'); return }
      setMessage([said.note, said.restart_hint].filter(one => one !== undefined && one !== '').join(' '))
      const next = await reload()
      if (next !== null) setPayload(next)
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '没接上')
    }
    finally {
      setBusy(false)
    }
  }

  const state = payload.attached
  const ops = payload.template === 'ops'
  return (
    <div data-ops-skills data-ok={state.ok}>
      <SetRow
        title="运营技能"
        sub={(
          <span role="status">
            <span data-testid="ops-skills-state">
              {state.ok
                ? `已接上 ${state.attached.length} 条`
                : `没接上(该有 ${state.expected.length} 条,现在 ${state.attached.length} 条)`}
            </span>
            {!ops && <span>{' · 当前不是自媒体运营模板,这里本来就只写基础那几条'}</span>}
            {state.absent.length > 0 && <span>{` · 缺:${state.absent.join('、')}`}</span>}
            {state.stray.length > 0 && <span>{` · 上个模板剩下的还没摘:${state.stray.join('、')}`}</span>}
            <span>{` · 写进 ${payload.file} 的标记段,段外一个字不动,写前先备份。`}</span>
          </span>
        )}
      >
        <SetBtn disabled={busy} onClick={() => { void apply() }}>重新接上</SetBtn>
      </SetRow>
      {message !== null && <SetMsg>{message}</SetMsg>}
    </div>
  )
}

export function TemplatePanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const [payload, setPayload] = useState<TemplatePayload | null>(null)
  /** 正在二次确认的那个模板 id(null = 没在确认)。 */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const call = fetchImpl ?? fetch

  async function reload(): Promise<TemplatePayload | null> {
    try {
      const res = await call(`${baseUrl}/template`)
      if (!res.ok) return null
      const body = await res.json() as unknown
      return isTemplatePayload(body) ? body : null
    }
    catch {
      return null
    }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const next = await reload()
      if (alive && next !== null) setPayload(next)
    })()
    return () => { alive = false }
    // 依赖只列 baseUrl / fetchImpl:`reload` 是每次渲染新建的闭包,放进去这条 effect
    // 每一拍都会重跑一次(而它内部读到的也只有这两样)。同 PathsPanel 那一节的写法。
  }, [baseUrl, fetchImpl])

  // 404 / 读不出来 = 这台服务没接模板服务,整节不出现。
  if (payload === null) return null

  async function post(path: string, body: Record<string, unknown>, wantId?: string): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const said = (await res.json().catch(() => ({}))) as {
        error?: string, reason?: string, ok?: boolean
        folders_made?: string[], folder_errors?: string[], folders_note?: string, apps_note?: string
      }
      if (!res.ok) { setMessage(said.error ?? '没切成'); return }
      if (said.ok === false) { setMessage(said.reason ?? '没切成'); return }
      const parts: string[] = [TEMPLATE_APPLIED_LINE]
      if ((said.folders_made ?? []).length > 0) parts.push(`工作目录下建好了:${(said.folders_made ?? []).join('、')}`)
      if ((said.folder_errors ?? []).length > 0) parts.push(`没建成的:${(said.folder_errors ?? []).join(';')}`)
      /**
       * 「一个都没建,因为还没有工作目录」那一句(2026-09-26,卡 ZM)。
       *
       * 上面两行都只在**数组非空**时说话,而服务端在没有工作目录时回的正是两个空数组 ——
       * 于是切到自媒体运营模板的人只看见「已经切过去了」,「账号 / 选题 / 素材」七格
       * 一个都没建出来却一个字都不说。服务端现在把原因写成 `folders_note`,这里原样显示。
       */
      if (said.folders_note !== undefined && said.folders_note !== '') parts.push(said.folders_note)
      if (said.apps_note !== undefined && said.apps_note !== '') parts.push(said.apps_note)
      const next = await reload()
      if (next !== null) setPayload(next)
      // 验收:重新拉回来的那一份里,当前模板真的是他要的那个吗(见 TEMPLATE_NOT_SWITCHED_LINE)。
      // 拉不回来(null)时不说这句 —— 「没问到」不等于「没切成」,不编一个结论(D13)。
      if (wantId !== undefined && next !== null && next.current !== wantId) {
        parts.push(TEMPLATE_NOT_SWITCHED_LINE)
      }
      setMessage(parts.join(' '))
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '没切成')
    }
    finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  return (
    // 评审页 `section('template', '工作布局', …)`:两张卡(名字 + 一句),现用那张一圈主字色细框;底下小字「切换布局不删除自定义组件。」
    // 切之前问一句(共用确认弹层);一套布局里有什么、回退上次、运营技能接没接上,收进「一套布局里有什么」与底下一行。
    <SetSection id="ben-wb-template" title="工作布局">
      <div className="ben-wb__schoices">
        {payload.templates.map(card => (
          <button
            type="button"
            className="ben-wb__schoice"
            key={card.id}
            data-current={card.current}
            data-tpl={card.id}
            aria-pressed={card.current}
            disabled={busy}
            onClick={() => { if (!card.current) { setMessage(null); setConfirming(card.id) } }}
          >
            <strong>{card.name}</strong>
            <span>{card.tagline}</span>
          </button>
        ))}
      </div>

      {/*
        盘上记的当前模板这会儿认不出来(她删了 / 改坏了 用户层/布局/<id>.json)→ 服务端
        在 detail 里带一句人话,这里原样上屏:她要知道为什么界面退回「做产品」、怎么恢复
        (2026-10-23,分层二刀二)。缺席 = 没有这种情况,一行都不多。
      */}
      {payload.note !== undefined && payload.note !== '' && <SetMsg>{payload.note}</SetMsg>}

      <p className="ben-wb__smsg"><SetSource>切换布局不删除自定义组件。</SetSource></p>

      <SetActions>
        {/* 2026-09-22(用自然语言改布局):备份栈现在**切模板与说一句话改布局共用**,
            所以这句话不能再说「还没切过模板」—— 他可能一次模板都没切过,却刚说了一句「把随手记藏起来」。 */}
        <SetSource>{payload.has_backup && payload.last_backup_at !== undefined ? `上一份备份存于 ${payload.last_backup_at}` : payload.has_backup ? '' : '还没有可回退的布局备份。'}</SetSource>
        <SetBtn kind="text" disabled={!payload.has_backup || busy} onClick={() => { void post('/template/restore', {}) }}>回退上次</SetBtn>
      </SetActions>

      <SetExplain label="一套布局里有什么">
        <p>
          一个模板是一整套:横竖两份模块排布、窗位里放哪几个应用、工作目录下建哪几个文件夹、
          待办按哪几个环节分列,以及引导里怎么问你。切换会重排布局,原来的排布会自动备份。
        </p>
        {payload.templates.map(card => (
          <p key={card.id}>
            {`${card.name}:「项目」在这里叫「${card.project_word}」`}
            {card.apps.length > 0 && ` · 窗位:${card.apps.map(app => app.label).join('、')}`}
            {card.board_lanes.length > 0 && ` · 待办分 ${card.board_lanes.length} 个环节`}
            {card.apps.filter(app => app.note !== undefined).map(app => ` · ${app.label}:${app.note}`).join('')}
          </p>
        ))}
      </SetExplain>

      {/* 切模板会自动把事务官的技能接上(2026-09-22,卡 ①);这一行是"接上了没有"的去处。 */}
      <OpsSkillsRow baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />

      {message !== null && <SetMsg>{message}</SetMsg>}
      {confirming !== null && (
        <ConfirmDialog
          {...CONFIRMS.switchLayout}
          body={`切到「${payload.templates.find(card => card.id === confirming)?.name ?? confirming}」会重排布局,原布局已备份可回退;自定义组件不动。`}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => { void post('/template/apply', { id: confirming }, confirming) }}
        />
      )}
    </SetSection>
  )
}

/**
 * 协作区的设置(2026-10-21,视觉 A 第 7–14 屏)。按需进入,不常驻板上;表单保留表单布局,不硬塞进日历。
 *
 * 本机能做的都接真接口:小队、定时派活、项目仓库与资源 + GitHub 设备码、工作室 MCP 库、个人令牌。
 * 跨机那几样(工作室与邀请、频道、共享 Agent、webhook 地址、企业微信机器人)走本机 `/collab/relay/*`(见 RelaySections),
 * 没登录中转 / 连不上 / 没加入都照实说,不摆假数据、不假装加入了。密钥值、令牌明文(发的那一下除外)、GitHub 凭据一律不出现在界面上。
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type {
  AgentCard, AgentEntryView, CollabGitHubView, CollabPullRequest, CollabTimer, DispatchSkillLibraryView, WorkbenchState,
} from '../../protocol.ts'
import { assigneeName, CARD_MODEL_OPTIONS, hasCodeCli } from '../../protocol.ts'
import { PersonalTokenPanel } from '../PersonalTokenPanel.tsx'
import type { CollabApi } from './collabApi.ts'
import { cardFamilyOf, type RailCard } from './collabModel.ts'
import { StudioSection, WebhookButton, WecomSection, useRelayStudio } from './RelaySections.tsx'

export type SettingsTab = 'cards' | 'squads' | 'timers' | 'repos' | 'mcp' | 'studio' | 'wecom' | 'tokens'
export const SETTINGS_TABS: readonly { key: SettingsTab, title: string }[] = [
  { key: 'cards', title: 'Agent 名片' },
  { key: 'squads', title: '小队' },
  { key: 'timers', title: '定时派活' },
  { key: 'repos', title: '仓库与资源' },
  { key: 'mcp', title: '工作室 MCP 库' },
  { key: 'studio', title: '工作室' },
  { key: 'wecom', title: '企业微信机器人' },
  { key: 'tokens', title: '个人令牌与命令行' },
]

interface Props {
  state: WorkbenchState
  api: CollabApi
  cards: readonly RailCard[]
  entries: readonly AgentEntryView[]
  baseUrl: string
  fetchImpl: typeof fetch
  onReceipt: (text: string) => void
  initialTab?: SettingsTab
  /** 改已有名片时,名字旁那颗「换头像」走它(打开更换头像对话框;板上由 AvatarEditor 那一层接)。 */
  onEditAvatar?: (id: string) => void
  /** 关掉这一层、回到板上:右上 ✕、Esc、点遮罩都走它(评审页协作区组件的「设置」弹层)。 */
  onClose: () => void
}

export function CollabSettings(props: Props) {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'cards')
  const { onClose } = props
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="ben-cl__setveil" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="ben-cl__setdlg" role="dialog" aria-modal="true" aria-label="设置">
        <div className="ben-cl__setdlg-head">
          <strong>设置</strong>
          <button type="button" aria-label="关闭设置" title="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="ben-cl__setdlg-body">
          <div className="ben-cl__settings">
            <nav aria-label="设置">
              {SETTINGS_TABS.map(one => <button key={one.key} type="button" aria-pressed={tab === one.key} onClick={() => setTab(one.key)}>{one.title}</button>)}
            </nav>
            <div className="ben-cl__setbody">
              {tab === 'cards' && <AgentCardsSection {...props} onGoMcp={() => setTab('mcp')} />}
              {tab === 'squads' && <SquadsSection {...props} />}
              {tab === 'timers' && <TimersSection {...props} />}
              {tab === 'repos' && <ReposSection {...props} />}
              {tab === 'mcp' && <McpSection {...props} />}
              {tab === 'studio' && <StudioSection api={props.api} tick={relayTick(props.state)} notes={props.state.tasks?.tasks ?? []} onReceipt={props.onReceipt} />}
              {tab === 'wecom' && <WecomSection api={props.api} tick={relayTick(props.state)} onReceipt={props.onReceipt} />}
              {tab === 'tokens' && (
                <section className="ben-cl__setsec" aria-label="个人令牌与命令行">
                  <PersonalTokenPanel baseUrl={props.baseUrl} fetchImpl={props.fetchImpl} />
                  <h3>命令行</h3>
                  <pre className="ben-cl__muted">{'export WORKBENCH_TOKEN=<发的那一枚>\nworkbench note create --title "换铃声" --from said:换个柔和的 \\\n  --accept "手机上响一次" --assignee codex\nworkbench note receipt <id> done "做完:1 好了"'}</pre>
                </section>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

/** 中转那边有变化,座机服务就把这个数 +1;界面拿它当重读的信号。 */
export function relayTick(state: WorkbenchState): number {
  return state.tasks?.relay_tick ?? 0
}

/** 谁能被选成组长 / 成员 / 派给:你、本机几家、登记过的名片。 */
function whoOptions(cards: readonly RailCard[]): { id: string, name: string }[] {
  return cards.map(card => ({ id: card.id, name: card.name }))
}

/**
 * Agent 名片登记 / 编辑(第 7 屏)按六段排(2026-10-22,卡「名片编辑表单重排」):
 * 1 名字(改已有名片时,名字旁多一颗「换头像」);2 哪一家(只列体检通过的;体检那一行的小字说装没装、
 * 登没登,没装给「去装」、没登给「去登录」;**不再选哪只手** —— 窗口还是命令行按家自动定,存的时候推出);
 * 3 怎么干活(**只有命令行家显示**):仓库(本地路径,带「选文件夹」)/ 模型(下拉)/
 * 强度(缺省/低/中/高)/ 智能体文件(带「打开」);4 擅长什么;5 带哪些技能(本体/我的两组)+ 分配哪些 MCP
 * (库里没有给一行小字和「去工作室 MCP 库加」);6 共享(共享给谁/能动哪些仓库/每天上限,折叠段,缺省折着)。
 *
 * `hand` 由家自动推出(协议 `AgentCard.hand`):命令行家且体检 edit 格 ok-via-cli = 'cli',否则 'window'。
 * 一只体检通过的手都没有时整页只有一句话和「去体检」。指定成员要等工作室接上才有人可选。
 */
function AgentCardsSection({ state, api, entries, onReceipt, onEditAvatar, onGoMcp }: Props & { onEditAvatar?: (id: string) => void, onGoMcp?: () => void }) {
  const cards = state.tasks?.agent_cards ?? []
  const mcp = state.tasks?.mcp ?? []
  const healthy = entries.filter(entry => entry.self !== true && entry.id !== 'dsh' && entry.status !== 'unknown')
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [name, setName] = useState('')
  // 哪一家(= 存的 runtime.family);hand 不选了,提交时由它与体检推出。
  const [family, setFamily] = useState('')
  const [goodAt, setGoodAt] = useState('')
  // 带哪些技能(2026-10-22,卡「用户层技能生效」B):勾选列表,两组 —— 本体(随版本那几件)/ 我的(用户层 技能/ 里那几件)。
  // 数据来自 GET /dispatch/skills;服务没接(回的不是那一份)就两组都空,表单照常能用。
  const [skillLibrary, setSkillLibrary] = useState<DispatchSkillLibraryView>({ builtin: [], mine: [] })
  const [pickedSkills, setPickedSkills] = useState<string[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [share, setShare] = useState<'none' | 'workspace' | 'members'>('none')
  // 段6 共享:折叠段,缺省折着(照板上「未排时间」的摆法:aria-expanded + 条件渲染)。
  const [shareOpen, setShareOpen] = useState(false)
  const [repos, setRepos] = useState('')
  const [budget, setBudget] = useState('')
  const [members, setMembers] = useState<string[]>([])
  // 段3 怎么干活(只有命令行家显示,2026-10-22 卡「名片补四样与Kimi命令行手」):仓库/模型与强度/智能体文件。
  // 空着不提交 = 这一格不动(老卡一字不变)。
  const [repo, setRepo] = useState('')
  const [modelName, setModelName] = useState('')
  const [effort, setEffort] = useState('')
  const [agentFile, setAgentFile] = useState('')
  // 时长上限(分钟)(2026-10-23 卡「派活给名片的四处」③):命令行那件活到这一档先停下来问;
  // 缺省 120,选命令行家时预填进格子,清空 = 不提交(不动老卡那一格;没写派活按缺省 120)。
  const [budgetMinutes, setBudgetMinutes] = useState('')
  const dirRef = useRef<HTMLInputElement>(null)
  const { studio } = useRelayStudio(api, relayTick(state))
  const studioMembers = studio?.state === 'joined' ? (studio.members ?? []).filter(one => one.account_id !== studio.me?.account_id) : []
  useEffect(() => {
    let alive = true
    void api.get<DispatchSkillLibraryView>('/dispatch/skills').then((got) => {
      if (!alive || got === undefined || typeof got !== 'object') return
      setSkillLibrary({
        builtin: Array.isArray(got.builtin) ? got.builtin.filter((one): one is string => typeof one === 'string') : [],
        mine: Array.isArray(got.mine)
          ? got.mine.filter((one): one is { id: string, name: string, description?: string } =>
              typeof one === 'object' && one !== null && typeof (one as { id?: unknown }).id === 'string' && typeof (one as { name?: unknown }).name === 'string')
          : [],
      })
    })
    return () => { alive = false }
  }, [api])
  const check = (): void => { void api.post('/agents/caps/check', {}).then(got => onReceipt(got.ok ? '体检跑了一遍,结果回到名片栏' : got.error ?? '体检没跑成')) }
  // 段2 旁那一行:体检里对应家的一整句(装没装、登没登);caps 整份缺席(老宿主)时小字与键都不出现。
  const capRow = family === '' ? undefined : state.agent_caps?.agents.find(one => one.family === family)
  // 段3 只在命令行家显示(与体检 edit 格 na 判法同源:protocol 的 hasCodeCli)。
  const showCli = hasCodeCli(family)
  // 「那家能用的模型」没有现成数据源:只列仓库里有据可查的几项(CARD_MODEL_OPTIONS);老卡存的模型名不在
  // 表内时追加成一个 option(值不丢)。
  const knownModels: readonly string[] = showCli ? CARD_MODEL_OPTIONS[family] : []
  const modelOptions = modelName.trim() !== '' && !knownModels.includes(modelName.trim()) ? [...knownModels, modelName.trim()] : knownModels
  const loginOrInstall = (): void => {
    void api.post('/agents/login', { family }).then(got => onReceipt(got.ok ? (typeof got.body.note === 'string' ? got.body.note : '好了') : got.error ?? '没开成'))
  }
  const onDirPicked = (event: ChangeEvent<HTMLInputElement>): void => {
    // Chromium 现成能力(webkitdirectory):拿第一个文件的相对路径推出目录;选不出来(空)不动。
    const rel = event.target.files?.[0]?.webkitRelativePath
    if (typeof rel === 'string' && rel.includes('/')) setRepo(rel.split('/').slice(0, -1).join('/'))
    event.target.value = ''
  }
  const openAgentFile = (): void => {
    const root = repo.trim().replace(/\/+$/, '')
    const rel = agentFile.trim() === '' ? 'docs/卡/agents/kimi-coder.md' : agentFile.trim()
    void (async () => {
      const full = `${root}/${rel}`
      const got = await api.post('/files/reveal', { path: full })
      if (got.ok) { onReceipt('在访达里打开了'); return }
      // 文件可能还不存在:开它所在目录(复用素材管理那一排走的现成口,不新造)。
      const dir = full.split('/').slice(0, -1).join('/')
      const second = dir === '' || dir === full ? got : await api.post('/files/reveal', { path: dir })
      onReceipt(second.ok ? '在访达里打开了它所在目录' : second.error ?? got.error ?? '没开成')
    })()
  }
  const load = (id: string): void => {
    const card = cards.find(one => one.id === id)
    if (card === undefined) return
    setEditing(id); setName(card.name); setFamily(cardFamilyOf(card) ?? ''); setGoodAt(card.good_at ?? ''); setPickedSkills([...(card.skills ?? [])])
    setPicked([...(card.mcp ?? [])]); setShare(card.shared.to); setShareOpen(card.shared.to !== 'none'); setRepos((card.shared.repos ?? []).join('\n'))
    setBudget(card.shared.budget_per_day === undefined ? '' : String(card.shared.budget_per_day))
    setMembers([...(card.shared.members ?? [])])
    setRepo(card.project?.repo ?? '')
    setModelName(card.model?.name ?? ''); setEffort(card.model?.effort ?? ''); setAgentFile(card.instructions ?? '')
    const fam = cardFamilyOf(card) ?? ''
    setBudgetMinutes(card.budget?.minutes === undefined ? (hasCodeCli(fam) ? '120' : '') : String(card.budget.minutes))
  }
  if (healthy.length === 0) {
    return (
      <section className="ben-cl__setsec" aria-label="Agent 名片">
        <h3>Agent 名片</h3>
        <p>这台电脑上一只体检通过的手都没有,先体检一遍再登记。</p>
        <div><button type="button" className="ben-cl__primary" onClick={check}>去体检</button></div>
      </section>
    )
  }
  const list = (text: string, sep: RegExp): string[] => text.split(sep).map(one => one.trim()).filter(one => one !== '')
  const familyNameOf = (card: AgentCard): string => {
    const fam = cardFamilyOf(card)
    return fam === undefined ? '' : entries.find(one => one.id === fam)?.name ?? fam
  }
  return (
    <section className="ben-cl__setsec" aria-label="Agent 名片">
      <h3>Agent 名片</h3>
      {cards.map(card => (
        <div key={card.id} className="ben-cl__setrow">
          <b>{card.name}</b><span>{familyNameOf(card)}</span>
          {(card.runtime?.family !== undefined || card.model?.name !== undefined) && (
            <span className="ben-cl__muted">{[card.runtime?.family, card.model?.name].filter(one => one !== undefined).join(' · ')}</span>
          )}
          <span className="ben-cl__muted">{card.shared.to === 'workspace' ? '给全工作室' : card.shared.to === 'members' ? '给指定成员' : '只自己'}</span>
          <button type="button" onClick={() => load(card.id)}>改</button>
          {/* 从「登记到工作室」这条路进来的意图就是共享:顺手把共享段展开(其他入口照旧缺省折着)。 */}
          {studio?.state === 'joined' && card.shared.to !== 'none' && (
            <button type="button" onClick={() => { setShareOpen(true); void api.post('/collab/relay/agents/share', { card_id: card.id }).then(got => onReceipt(got.ok ? `「${card.name}」登记到工作室了` : got.error ?? '没登记上')) }}>登记到工作室</button>
          )}
        </div>
      ))}
      <form
        className="ben-cl__form"
        aria-label="登记一张 Agent 名片"
        onSubmit={(event) => {
          event.preventDefault()
          const repoList = list(repos, /\n/)
          const money = Number(budget)
          const minutesNum = Number(budgetMinutes)
          // hand 由家自动推出(协议 AgentCard.hand):命令行家且体检 edit 格 ok-via-cli = cli,否则 window。
          const editCell = capRow?.cells.edit
          const hand = showCli && editCell?.state === 'ok' && editCell.via === 'cli' ? 'cli' : 'window'
          void api.post('/collab/agent/save', {
            ...(editing === undefined ? {} : { id: editing }),
            name, hand, good_at: goodAt, skills: [...new Set(pickedSkills)], mcp: picked,
            runtime: { family },
            // 段3(2026-10-22):空着不提交 = 不动那一格(与 goodAt 同写法,null 清除在「改」里做)。
            ...(repo.trim() === '' ? {} : { project: { repo: repo.trim() } }),
            ...(modelName.trim() === '' && effort === '' ? {} : { model: { ...(modelName.trim() === '' ? {} : { name: modelName.trim() }), ...(effort === '' ? {} : { effort }) } }),
            ...(agentFile.trim() === '' ? {} : { instructions: agentFile.trim() }),
            // 时长上限(分钟)(2026-10-23 卡③):命令行家填了才带;清空/不合形状 = 不动那一格。
            ...(showCli && budgetMinutes.trim() !== '' && Number.isInteger(minutesNum) && minutesNum >= 1 && minutesNum <= 1440 ? { budget: { minutes: minutesNum } } : {}),
            shared: { to: share, ...(share === 'members' ? { members } : {}), ...(repoList.length === 0 ? {} : { repos: repoList }), ...(budget !== '' && Number.isFinite(money) && money > 0 ? { budget_per_day: money } : {}) },
          }).then((got) => {
            onReceipt(got.ok ? `名片「${name}」存好了` : got.error ?? '没存成')
            if (got.ok) { setEditing(undefined); setName(''); setFamily(''); setGoodAt(''); setPickedSkills([]); setPicked([]); setShareOpen(false); setRepos(''); setBudget(''); setMembers([]); setRepo(''); setModelName(''); setEffort(''); setAgentFile(''); setBudgetMinutes('') }
          })
        }}
      >
        {/* 1 名字;改已有名片时,头像键就在名字旁(打开更换头像对话框) */}
        <label htmlFor="cl-card-name">名字</label>
        <span>
          <input id="cl-card-name" value={name} onChange={event => setName(event.target.value)} />
          {editing !== undefined && onEditAvatar !== undefined && (
            <button type="button" style={{ marginLeft: 10 }} onClick={() => onEditAvatar(editing)}>换头像</button>
          )}
        </span>
        {/* 2 哪一家:只列体检通过的;体检那一行的小字说装没装、登没登,没装「去装」、没登「去登录」 */}
        <label htmlFor="cl-card-family">哪一家</label>
        <span>
          <select id="cl-card-family" value={family} onChange={event => {
            const next = event.target.value
            setFamily(next)
            // 选到命令行家:时长上限缺省 120 预填进格子(清空不提交,老卡不动那一格)。
            if (hasCodeCli(next) && budgetMinutes.trim() === '') setBudgetMinutes('120')
          }}>
            <option value="">选一家</option>
            {healthy.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          {capRow !== undefined && (
            <>
              {' '}
              <span className="ben-cl__muted">{capRow.line}</span>
              {capRow.installed === false && (family === 'claude' || family === 'codex') && <button type="button" style={{ marginLeft: 10 }} onClick={loginOrInstall}>去装</button>}
              {capRow.cells.edit.fix?.kind === 'login_cli' && <button type="button" style={{ marginLeft: 10 }} onClick={loginOrInstall}>去登录</button>}
            </>
          )}
        </span>
        {/* 3 怎么干活(只有命令行家显示) */}
        {showCli && (
          <>
            <label htmlFor="cl-card-repo">仓库(本地路径)</label>
            <span>
              <input id="cl-card-repo" value={repo} onChange={event => setRepo(event.target.value)} placeholder="/Users/…/项目" />
              <button type="button" style={{ marginLeft: 10 }} onClick={() => dirRef.current?.click()}>选文件夹</button>
              <input ref={dirRef} type="file" aria-label="选文件夹" style={{ display: 'none' }} onChange={onDirPicked} {...({ webkitdirectory: '' } as Record<string, unknown>)} />
            </span>
            <label htmlFor="cl-card-model">模型</label>
            <select id="cl-card-model" value={modelName} onChange={event => setModelName(event.target.value)}>
              <option value="">缺省,由那家自己定</option>
              {modelOptions.map(one => <option key={one} value={one}>{one}</option>)}
            </select>
            <label htmlFor="cl-card-effort">强度</label>
            <select id="cl-card-effort" value={effort} onChange={event => setEffort(event.target.value)}>
              <option value="">缺省</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
            <label htmlFor="cl-card-instructions">智能体文件</label>
            <span>
              <input id="cl-card-instructions" value={agentFile} onChange={event => setAgentFile(event.target.value)} placeholder="docs/卡/agents/kimi-coder.md" />
              <button type="button" style={{ marginLeft: 10 }} disabled={repo.trim() === ''} onClick={openAgentFile}>打开</button>
            </span>
            <label htmlFor="cl-card-budget-minutes">时长上限(分钟)</label>
            <input id="cl-card-budget-minutes" inputMode="numeric" value={budgetMinutes} onChange={event => setBudgetMinutes(event.target.value)} placeholder="120" />
          </>
        )}
        {/* 4 擅长什么 */}
        <label htmlFor="cl-card-good">擅长什么</label><input id="cl-card-good" value={goodAt} onChange={event => setGoodAt(event.target.value)} />
        {/* 5 带哪些技能(本体/我的两组)+ 分配哪些 MCP */}
        <span>带哪些技能</span>
        <span>
          <span className="ben-cl__muted">本体 · </span>
          {skillLibrary.builtin.length === 0
            ? <span className="ben-cl__muted">没有</span>
            : skillLibrary.builtin.map(one => (
              <label key={one} style={{ marginRight: 10 }}><input type="checkbox" checked={pickedSkills.includes(one)} onChange={event => setPickedSkills(event.target.checked ? [...pickedSkills, one] : pickedSkills.filter(id => id !== one))} />{one}</label>
            ))}
          {'　'}
          <span className="ben-cl__muted">我的 · </span>
          {skillLibrary.mine.length === 0
            ? <span className="ben-cl__muted">用户层 技能/ 里还没有</span>
            : skillLibrary.mine.map(one => (
              <label key={one.id} style={{ marginRight: 10 }} title={one.description}><input type="checkbox" checked={pickedSkills.includes(one.id)} onChange={event => setPickedSkills(event.target.checked ? [...pickedSkills, one.id] : pickedSkills.filter(id => id !== one.id))} />{one.name}</label>
            ))}
          {pickedSkills.filter(one => !skillLibrary.builtin.includes(one) && !skillLibrary.mine.some(m => m.id === one)).length > 0 && (
            <span className="ben-cl__muted">(库里已经没有:{pickedSkills.filter(one => !skillLibrary.builtin.includes(one) && !skillLibrary.mine.some(m => m.id === one)).join('、')})</span>
          )}
        </span>
        <span>分配哪些 MCP</span>
        <span>{mcp.length === 0 ? (
          <>
            <span className="ben-cl__muted">库里还没有,</span>
            {onGoMcp !== undefined && <button type="button" style={{ marginLeft: 10 }} onClick={onGoMcp}>去工作室 MCP 库加</button>}
          </>
        ) : mcp.map(one => (
          <label key={one.id} style={{ marginRight: 10 }}><input type="checkbox" checked={picked.includes(one.id)} onChange={event => setPicked(event.target.checked ? [...picked, one.id] : picked.filter(id => id !== one.id))} />{one.name}</label>
        ))}</span>
        {/* 6 共享(折叠段,缺省折着;照板上「未排时间」的摆法) */}
        <span />
        <span>
          <button type="button" aria-expanded={shareOpen} onClick={() => setShareOpen(open => !open)}>共享</button>
        </span>
        {shareOpen && (
          <>
            <span>共享给谁</span>
            <span>
              <label><input type="radio" name="cl-card-share" checked={share === 'none'} onChange={() => setShare('none')} />只自己</label>{' '}
              <label><input type="radio" name="cl-card-share" checked={share === 'workspace'} onChange={() => setShare('workspace')} />全工作室</label>{' '}
              <label><input type="radio" name="cl-card-share" checked={share === 'members'} disabled={studioMembers.length === 0} onChange={() => setShare('members')} />指定成员</label>
              {studioMembers.length === 0 && <span className="ben-cl__muted"> (加入工作室、有别的成员之后才能指定)</span>}
              {share === 'members' && studioMembers.map(one => (
                <label key={one.account_id} style={{ marginLeft: 10 }}><input type="checkbox" checked={members.includes(one.account_id)} onChange={event => setMembers(event.target.checked ? [...members, one.account_id] : members.filter(id => id !== one.account_id))} />{one.nick}</label>
              ))}
            </span>
            <label htmlFor="cl-card-repos">能动哪些仓库</label><textarea id="cl-card-repos" rows={2} value={repos} onChange={event => setRepos(event.target.value)} placeholder="一行一个本机路径" />
            <label htmlFor="cl-card-budget">每天上限(元)</label><input id="cl-card-budget" inputMode="decimal" value={budget} onChange={event => setBudget(event.target.value)} placeholder="别人用时算你的" />
          </>
        )}
        <span />
        <button type="submit" className="ben-cl__primary" disabled={name.trim() === '' || family === ''}>存名片</button>
      </form>
    </section>
  )
}

function SquadsSection({ state, api, cards, onReceipt }: Props) {
  const squads = state.tasks?.squads ?? []
  const [name, setName] = useState('')
  const [leader, setLeader] = useState('me')
  const [members, setMembers] = useState<string[]>([])
  const who = whoOptions(cards)
  const nameOf = (id: string): string => who.find(one => one.id === id)?.name ?? assigneeName(id)
  const evaluated = (state.tasks?.tasks ?? []).filter(task => task.squad_id !== undefined && task.evaluation !== undefined)
  return (
    <section className="ben-cl__setsec" aria-label="小队">
      <h3>小队</h3>
      <p className="ben-cl__muted">几个人加几只 Agent 一组。派给小队 = 派给组长,组长分下去、对每张便签记一句评估。</p>
      {squads.length === 0 && <p className="ben-cl__muted">还没有小队。</p>}
      {squads.map(squad => (
        <div key={squad.id} className="ben-cl__setrow">
          <b>{squad.name}</b>
          <span>组长 · {nameOf(squad.leader)}</span>
          <span className="ben-cl__muted">成员 · {squad.members.length === 0 ? '没有' : squad.members.map(nameOf).join('、')}</span>
          <button type="button" onClick={() => { void api.post('/collab/squad/remove', { id: squad.id }).then(got => onReceipt(got.ok ? '小队拆了(便签一张不动)' : got.error ?? '没拆成')) }}>拆掉</button>
        </div>
      ))}
      {evaluated.length > 0 && (
        <>
          <h3>组长评估</h3>
          {evaluated.map(task => <div key={task.id} className="ben-cl__setrow"><b>{task.title}</b><span>{task.evaluation?.text}</span><span className="ben-cl__muted">{nameOf(task.evaluation?.by ?? '')}</span></div>)}
        </>
      )}
      <form
        className="ben-cl__form"
        aria-label="建一个小队"
        onSubmit={(event) => {
          event.preventDefault()
          void api.post('/collab/squad/save', { name, leader, members }).then((got) => {
            onReceipt(got.ok ? `小队「${name}」建好了` : got.error ?? '没建成')
            if (got.ok) { setName(''); setMembers([]) }
          })
        }}
      >
        <label htmlFor="cl-squad-name">名字</label><input id="cl-squad-name" value={name} onChange={event => setName(event.target.value)} />
        <label htmlFor="cl-squad-leader">组长</label>
        <select id="cl-squad-leader" value={leader} onChange={event => setLeader(event.target.value)}>{who.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}</select>
        <span>成员</span>
        <span>{who.filter(one => one.id !== leader).map(one => (
          <label key={one.id} style={{ marginRight: 10 }}>
            <input type="checkbox" checked={members.includes(one.id)} onChange={event => setMembers(event.target.checked ? [...members, one.id] : members.filter(m => m !== one.id))} />{one.name}
          </label>
        ))}</span>
        <span />
        <button type="submit" className="ben-cl__primary" disabled={name.trim() === ''}>建小队</button>
      </form>
    </section>
  )
}

function triggerText(timer: CollabTimer): string {
  return timer.trigger.kind === 'cron' ? `定时 · ${timer.trigger.cron}` : timer.trigger.url === undefined ? 'webhook · 还没有地址' : `webhook · ${timer.trigger.url}`
}

function TimersSection({ state, api, cards, onReceipt }: Props) {
  const timers = state.tasks?.timers ?? []
  const goals = state.tasks?.goals ?? []
  const who = whoOptions(cards).filter(one => one.id !== 'me')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'cron' | 'webhook'>('cron')
  const [cron, setCron] = useState('0 9 * * *')
  const [assignee, setAssignee] = useState(who[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [accept, setAccept] = useState('')
  const [open, setOpen] = useState<string | undefined>(undefined)
  return (
    <section className="ben-cl__setsec" aria-label="定时派活">
      <h3>定时派活</h3>
      {timers.length === 0 && <p className="ben-cl__muted">还没有定时派活。</p>}
      {timers.map((timer) => {
        const last = timer.runs.at(-1)
        return (
          <div key={timer.id}>
            <div className="ben-cl__setrow">
              <b>{timer.name}</b>
              <span>{triggerText(timer)}</span>
              <span>派给 · {who.find(one => one.id === timer.assignee)?.name ?? assigneeName(timer.assignee)}</span>
              <span className="ben-cl__muted">{last === undefined ? '还没跑过' : `上次 ${last.at.slice(5, 16).replace('T', ' ')} · ${last.ok ? '建了便签' : `没成:${last.why ?? ''}`}`}</span>
              {timer.trigger.kind === 'webhook' && <WebhookButton api={api} timerId={timer.id} hasUrl={timer.trigger.url !== undefined} onReceipt={onReceipt} />}
              <button type="button" onClick={() => setOpen(open === timer.id ? undefined : timer.id)}>运行记录</button>
              <button type="button" onClick={() => { void api.post('/collab/timer/run', { id: timer.id }).then(got => onReceipt(got.ok ? '跑了一次' : got.error ?? '没跑成')) }}>现在跑一次</button>
              <button type="button" onClick={() => { void api.post('/collab/timer/remove', { id: timer.id }).then(got => onReceipt(got.ok ? '删了这条定时' : got.error ?? '没删成')) }}>删掉</button>
            </div>
            {open === timer.id && (
              <ul aria-label={`${timer.name} 的运行记录`}>
                {timer.runs.length === 0 ? <li className="ben-cl__muted">没有记录。</li> : [...timer.runs].reverse().map(run => <li key={run.at}>{run.at.slice(0, 16).replace('T', ' ')} · {run.ok ? `建了便签 ${run.note_id ?? ''}` : `没成:${run.why ?? ''}`}</li>)}
              </ul>
            )}
          </div>
        )
      })}
      <form
        className="ben-cl__form"
        aria-label="新建定时派活"
        onSubmit={(event) => {
          event.preventDefault()
          void api.post('/collab/timer/save', {
            name, trigger: kind === 'cron' ? { kind: 'cron', cron } : { kind: 'webhook' }, assignee,
            template: { title, ...(goal === '' ? {} : { goal_id: goal }), acceptance: accept.split('\n').map(one => one.trim()).filter(one => one !== '') },
            enabled: true,
          }).then((got) => {
            onReceipt(got.ok ? `定时「${name}」存好了` : got.error ?? '没存成')
            if (got.ok) { setName(''); setTitle(''); setAccept('') }
          })
        }}
      >
        <label htmlFor="cl-timer-name">名字</label><input id="cl-timer-name" value={name} onChange={event => setName(event.target.value)} />
        <span>触发</span>
        <span>
          <label><input type="radio" name="cl-timer-kind" checked={kind === 'cron'} onChange={() => setKind('cron')} />定时</label>{' '}
          <label><input type="radio" name="cl-timer-kind" checked={kind === 'webhook'} onChange={() => setKind('webhook')} />webhook</label>
        </span>
        {kind === 'cron'
          ? (<><label htmlFor="cl-timer-cron">cron</label><input id="cl-timer-cron" value={cron} onChange={event => setCron(event.target.value)} /></>)
          : (<><span>地址</span><span className="ben-cl__muted">存好后在这条定时上点「要一个地址」,由中转发、可以更换(要先加入工作室)。</span></>)}
        <label htmlFor="cl-timer-who">派给</label>
        <select id="cl-timer-who" value={assignee} onChange={event => setAssignee(event.target.value)}>{who.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}</select>
        <label htmlFor="cl-timer-title">便签标题</label><input id="cl-timer-title" value={title} onChange={event => setTitle(event.target.value)} />
        <label htmlFor="cl-timer-goal">目标</label>
        <select id="cl-timer-goal" value={goal} onChange={event => setGoal(event.target.value)}>
          <option value="">未归目标</option>{goals.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
        </select>
        <span>来源</span><span className="ben-cl__muted">定时派活(固定)</span>
        <label htmlFor="cl-timer-accept">做到什么算完</label><textarea id="cl-timer-accept" rows={3} value={accept} onChange={event => setAccept(event.target.value)} placeholder="一行一条,1–3 条" />
        <span />
        <button type="submit" className="ben-cl__primary" disabled={name.trim() === '' || title.trim() === '' || assignee === '' || accept.trim() === ''}>存这条定时</button>
      </form>
    </section>
  )
}

function ReposSection({ state, api, onReceipt }: Props) {
  const projects = state.projects?.projects ?? []
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const meta = state.tasks?.project_meta.find(one => one.project_id === projectId)
  const [github, setGithub] = useState<CollabGitHubView | undefined>(undefined)
  const [pulls, setPulls] = useState<readonly CollabPullRequest[] | undefined>(undefined)
  const [attachTo, setAttachTo] = useState('')
  const notes = (state.tasks?.tasks ?? []).filter(task => task.project_id === projectId || projectId === '')
  useEffect(() => {
    let alive = true
    const read = (): void => { void api.get<CollabGitHubView>('/collab/github').then((got) => { if (alive) setGithub(got) }) }
    read()
    // 设备码那一轮:等他在浏览器里点「允许」,每 5 秒问一次。
    const timer = github?.state === 'pending' ? setInterval(read, 5000) : undefined
    return () => { alive = false; if (timer !== undefined) clearInterval(timer) }
  }, [api, github?.state])
  useEffect(() => {
    if (github?.state !== 'connected' || projectId === '') return
    let alive = true
    void api.get<{ pulls?: CollabPullRequest[] }>(`/collab/github/pulls?project_id=${encodeURIComponent(projectId)}`).then((got) => { if (alive) setPulls(got?.pulls ?? []) })
    return () => { alive = false }
  }, [api, github?.state, projectId])
  return (
    <section className="ben-cl__setsec" aria-label="仓库与资源">
      <h3>仓库与资源</h3>
      {projects.length === 0 ? <p className="ben-cl__muted">还没有项目。</p> : (
        <label>项目 <select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}</select></label>
      )}
      <h3>仓库</h3>
      {(meta?.repos ?? []).length === 0 && <p className="ben-cl__muted">这个项目还没连仓库。</p>}
      {(meta?.repos ?? []).map(repo => <div key={repo.local_path} className="ben-cl__setrow"><code>{repo.local_path}</code><span className="ben-cl__muted">{repo.remote_url ?? '没写远端'}</span><span className="ben-cl__muted">{repo.branch ?? ''}</span></div>)}
      <h3>资源</h3>
      {(meta?.resources ?? []).length === 0 && <p className="ben-cl__muted">还没有资源。</p>}
      {(meta?.resources ?? []).map(res => <div key={res.ref} className="ben-cl__setrow"><span>{res.kind === 'doc' ? '文档' : res.kind === 'url' ? '网址' : '路径'}</span><b>{res.title}</b><code>{res.ref}</code></div>)}
      <h3>GitHub</h3>
      {github === undefined && <p className="ben-cl__muted">GitHub 那一格没接上。</p>}
      {github?.state === 'unconfigured' && <p className="ben-cl__muted">这台没配 GitHub 应用的 client id,设备码登录要它(app.json 的 github_client_id)。</p>}
      {github?.state === 'disconnected' && (
        <div className="ben-cl__setrow">
          <button type="button" className="ben-cl__primary" onClick={() => { void api.post('/collab/github/start', {}).then((got) => { if (!got.ok) onReceipt(got.error ?? '没连上'); else setGithub(got.body as unknown as CollabGitHubView) }) }}>连接 GitHub</button>
          <span className="ben-cl__muted">凭据只存这台电脑,不经过中转。</span>
          {github.error !== undefined && <span role="alert" className="ben-cl__rail-note">{github.error}</span>}
        </div>
      )}
      {github?.state === 'pending' && (
        <div className="ben-cl__setrow" role="status">
          <span>在 {github.verification_uri ?? 'github.com/login/device'} 输入</span>
          <span className="ben-cl__code" aria-label="设备码">{github.user_code}</span>
          <span className="ben-cl__muted">等你点「允许」</span>
        </div>
      )}
      {github?.state === 'connected' && (
        <>
          <div className="ben-cl__setrow">
            <span>已连接 · {github.login ?? ''}</span>
            <button type="button" onClick={() => { void api.post('/collab/github/disconnect', {}).then((got) => { onReceipt(got.ok ? '断开了,本机的凭据删了' : got.error ?? '没断开'); setGithub(undefined) }) }}>断开</button>
          </div>
          {pulls === undefined ? <p className="ben-cl__muted">在读 PR……</p> : pulls.length === 0 ? <p className="ben-cl__muted">这个项目的 GitHub 仓库没有开着的 PR(或者项目没连 GitHub 远端)。</p> : (
            <>
              <label>关联到哪张便签 <select value={attachTo} onChange={event => setAttachTo(event.target.value)}><option value="">选一张</option>{notes.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}</select></label>
              {pulls.map(pr => (
                <div key={`${pr.repo}#${pr.number}`} className="ben-cl__setrow">
                  <span>#{pr.number}</span><b>{pr.title}</b><span className="ben-cl__muted">{pr.repo}{pr.author === undefined ? '' : ` · ${pr.author}`}</span>
                  <button type="button" disabled={attachTo === ''} onClick={() => { void api.post('/collab/github/attach', { pr: `${pr.repo}#${pr.number}`, note_id: attachTo }).then(got => onReceipt(got.ok ? '关联上了' : got.error ?? '没关联上')) }}>关联到便签</button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </section>
  )
}

function McpSection({ state, api, onReceipt }: Props) {
  const entries = state.tasks?.mcp ?? []
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [secrets, setSecrets] = useState('')
  const [filling, setFilling] = useState<{ id: string, key: string } | undefined>(undefined)
  const [value, setValue] = useState('')
  return (
    <section className="ben-cl__setsec" aria-label="工作室 MCP 库">
      <h3>工作室 MCP 库</h3>
      <p className="ben-cl__muted">库里只记名字、地址模板和要哪些密钥的名字;密钥值只填在这台电脑上,不进库、不显示。</p>
      {entries.length === 0 && <p className="ben-cl__muted">库里还没有 MCP。</p>}
      {entries.map(entry => (
        <div key={entry.id} className="ben-cl__setrow">
          <b>{entry.name}</b><code>{entry.url_template}</code>
          <span className="ben-cl__muted">要 {entry.secret_names.length === 0 ? '不要密钥' : entry.secret_names.join('、')}</span>
          {(entry.missing ?? []).length === 0
            ? <span>本机可用</span>
            : (entry.missing ?? []).map(key => <button key={key} type="button" className="ben-cl__secondary" onClick={() => { setFilling({ id: entry.id, key }); setValue('') }}>填 {key}</button>)}
          <button type="button" onClick={() => { void api.post('/collab/mcp/remove', { id: entry.id }).then(got => onReceipt(got.ok ? '从库里拿掉了' : got.error ?? '没拿掉')) }}>拿掉</button>
        </div>
      ))}
      {filling !== undefined && (
        <form
          className="ben-cl__timeform"
          aria-label="填密钥"
          onSubmit={(event) => {
            event.preventDefault()
            void api.post('/collab/mcp/secret', { id: filling.id, name: filling.key, value }).then((got) => {
              onReceipt(got.ok ? `${filling.key} 填好了(只在这台电脑上)` : got.error ?? '没填上')
              setFilling(undefined); setValue('')
            })
          }}
        >
          <label>{filling.key} <input type="password" autoComplete="off" value={value} onChange={event => setValue(event.target.value)} /></label>
          <button type="submit" className="ben-cl__primary" disabled={value === ''}>存在本机</button>
          <button type="button" onClick={() => setFilling(undefined)}>算了</button>
        </form>
      )}
      <form
        className="ben-cl__form"
        aria-label="加一条 MCP"
        onSubmit={(event) => {
          event.preventDefault()
          void api.post('/collab/mcp/save', { name, url_template: url, secret_names: secrets.split(/[,,\s]+/).filter(one => one !== '') }).then((got) => {
            onReceipt(got.ok ? `「${name}」进库了` : got.error ?? '没加上')
            if (got.ok) { setName(''); setUrl(''); setSecrets('') }
          })
        }}
      >
        <label htmlFor="cl-mcp-name">名字</label><input id="cl-mcp-name" value={name} onChange={event => setName(event.target.value)} />
        <label htmlFor="cl-mcp-url">地址模板</label><input id="cl-mcp-url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…/{{TOKEN}}" />
        <label htmlFor="cl-mcp-secrets">要哪些密钥(名字)</label><input id="cl-mcp-secrets" value={secrets} onChange={event => setSecrets(event.target.value)} placeholder="GITHUB_TOKEN" />
        <span />
        <button type="submit" className="ben-cl__primary" disabled={name.trim() === '' || url.trim() === ''}>加进库</button>
      </form>
    </section>
  )
}

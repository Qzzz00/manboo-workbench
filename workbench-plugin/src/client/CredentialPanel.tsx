/**
 * 工作台里配额度凭据的那一块（PRD §8.2 的前置条件）。
 *
 * 三家三种形态，因为它们能给的东西不一样：
 * - **DeepSeek**：只有官方 API Key 这一条路，官方就开放了 `/user/balance` 一个口子。
 * - **Kimi**：`sk-kimi-` 那个 Coding Plan Key 只覆盖 Code 部分的窗口，
 *   拿不到「Kimi + Code 合并」的总量——而总量才是先见底的那个。所以走网页登录态。
 * - **Claude**：`claude setup-token` 签发的长期 token。**不填也能显示额度**——
 *   那时退回桌面端那份本地用量记录，数字一样准，只是慢一个采样间隔；
 *   填了才实时（见 quota/claudeHeaders.ts）。网页登录态那条走不通，
 *   claude.ai 的服务端重放会吃反机器人验证页（交接文档已排除第 7 条）。
 *
 * 登录不让他去开发者工具里复制 Cookie：点一下按钮，工作台开一个**独立 profile**
 * 的浏览器窗口，他自己登，登完工作台把**长期凭据**（refresh token）取回来。
 * 全程不碰他日常的浏览器配置。
 *
 * ★取的不是 cookie、也不是请求头上的 authorization。前者在 kimi.com 上压根不存在鉴权项；
 * 后者是只活 15 分钟的 access token——存它的那一版，现象就是「重登后好几分钟又失效」。
 *
 * 保管规矩三家一致（AGENTS.md：不展示或写入凭据）：只存 0600 的本地文件、
 * **永不回显**、不进日志与错误信息、只能在本机填/登录。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClaudeConnectView, CredentialProvider, CredentialStatusView, LoginProgressView } from './credentials.ts'
// 去哪拿密钥那一处地址与首次引导 / 首页入口同源(2026-11-12):三处都只认这一个常量,改一处不漂。
import { DEEPSEEK_API_KEYS_URL } from './apiKeyGate.ts'
import { SetActions, SetBtn, SetErr, SetFold, SetMsg, SetRow, SetSection, SetWarn } from './settings/setKit.tsx'
import {
  cancelClaudeConnect, cancelLogin, captureLoginNow, EMPTY_CREDENTIAL_STATUS, fetchClaudeConnect, fetchCredentialStatus,
  fetchLoginProgress, startClaudeConnect, startLogin, submitCredential,
} from './credentials.ts'

type LoginProvider = 'kimi_web'

/**
 * ★ Claude 那一格的「一键接上」(2026-10-03,卡「不让用户知道什么叫 setup-token」)。
 *
 * 维护者 15:0x:额度里 Claude 那格一直「未接入」,统筹查出要先在终端跑一条命令、再把密钥粘进这里;
 * 他照做接上了,然后说:「**你得考虑产品化啊,你不说我咋知道要咋弄啊。**」
 *
 * 所以这一行的主角是一颗键:按下去工作台自己去开浏览器,她用自己的 Claude 账号授权一次就完事
 * (账号密码工作台一个字都不经手)。界面上**不出现终端、不出现那条命令的名字**。
 * 粘密钥那个框留着 —— 它是这条路接不上时的退路(她手上真有一串的时候也用得到),不再是主路。
 */
export const CLAUDE_CONNECT_INVITE = '点一下,会打开浏览器让你用 Claude 账号授权一次;授权完这一格就是实时的'
export const CLAUDE_CONNECT_BUTTON = '接上'
/** 已经接上时那颗键:换一把(密钥快到期、或者换了账号)。 */
export const CLAUDE_RECONNECT_BUTTON = '换一把'
/** 已经接上时那一行。到期日**读到才说**(命令没打印就只剩这两个字,不编一个日子)。 */
export const CLAUDE_LIVE_LINE = '实时'

/**
 * 2026-09-28(卡 SG):界面上不说「API Key」「setup-token」这类词 —— 用户是不写代码的半专业个体。
 * 一律叫**密钥**,并说清楚「去哪拿」。拿法本身写在 hint 里,不写命令行那一串。
 *
 * 2026-10-03:多了两样 ——
 * - `where`:「去哪拿」那条链接(卡里第 4 条「凡是没接上都必须有一颗能按的键或一句能照做的话」:
 *   DeepSeek 原来只有一句话,没有能点的地方);
 * - `connect`:这一家有「一键接上」(今天只有 Claude)。那时上面多一颗键,粘密钥退成退路。
 */
const KEY_ROWS: readonly {
  provider: CredentialProvider
  name: string
  hint: string
  where?: { label: string, url: string }
  connect?: true
  /** 这一行的「配了 / 没配」各写什么。缺省是「已配置 / 未填」。 */
  states?: readonly [string, string]
  /** 自带的钥匙(不是哪一家 AI):不算进「暂不可用 N 家」,另收一折(见 OWN_KEYS_SUMMARY)。 */
  ownKey?: true
}[] = [
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    hint: '在 DeepSeek 开放平台上生成的那串密钥',
    where: { label: '去 DeepSeek 开放平台拿一串', url: DEEPSEEK_API_KEYS_URL },
  },
  // 2026-10-03:这一行的主路是上面那颗「接上」(见 CLAUDE_CONNECT_INVITE)。
  // 不接也能看到 Claude 额度,只是慢一个采样间隔(退回桌面端那份本地文件);接上才实时
  // —— 见 quota/claudeHeaders.ts 与 quota/claudeSetupToken.ts。
  {
    provider: 'claude_api',
    name: 'Claude',
    hint: '接不上的时候:把一串密钥粘进来',
    connect: true,
    states: ['实时', '未接入'],
  },
  // 2026-10-21(零服务器档):没接中转的这台,资讯现搜与电话里听懂说话靠这三格。接了中转的不填也行,填了就先用自己的。
  {
    provider: 'bocha',
    name: '博查搜索',
    hint: '资讯里「现搜」用的那串密钥',
    where: { label: '去博查开放平台拿一串', url: 'https://open.bochaai.com' },
    ownKey: true,
  },
  {
    provider: 'volc_asr_app_id',
    name: '火山识别 · App ID',
    hint: '电话里听懂你说话用的:火山引擎语音应用的 App ID',
    where: { label: '去火山引擎的语音控制台拿', url: 'https://console.volcengine.com/speech/app' },
    ownKey: true,
  },
  {
    provider: 'volc_asr_access_token',
    name: '火山识别 · Access Token',
    hint: '同一个应用下的那串 Access Token',
    ownKey: true,
  },
]

/** 自带钥匙那一折的标题(零服务器档靠它们;接了中转的不填也行)。 */
export const OWN_KEYS_SUMMARY = '自带的钥匙 · 搜索与电话识别'

const LOGIN_ROWS: readonly { provider: LoginProvider, name: string, hint: string }[] = [
  { provider: 'kimi_web', name: 'Kimi', hint: '登录一次长期有效，取数时自动续期' },
  // Claude 不在这里：它不走浏览器登录态，走上面那栏的 setup-token。
  // 2026-08-21 试过网页登录这条路：claude.ai 的接口是真的，但服务端重放会吃
  // 403 + 反机器人验证页，而绕它是不做的事（详见交接文档已排除第 7 条）。
  // Kimi 这条登录一次即可：存的是 refresh token，采集器每轮自动换新的 access token。
]

/** 采集类那一段的标题。 */
export const COLLECT_PROMISE_TITLE = '采集别人的笔记与评论'

/**
 * ★ 采集类的承诺,**逐字写在设置界面上**(2026-09-22)。
 *
 * 它与上面数据复盘那一段**是两段,一个字都不共用** —— 这是预研第 3.1 节的结论:
 * 那一段里「读你自己的后台页面」在这里是**假的**。采集类读的是**别人的笔记和别人的评论**,
 * 技术动作像,性质不像,所以话必须重写。
 *
 * 每一句都对应代码里的一道闸,不是漂亮话:
 *
 * | 这句话 | 落在哪 |
 * |---|---|
 * | 用你自己的登录、你自己的电脑 | `xhsNoteBrowser`:同一个专用 Chrome 档案,没有第二个浏览器 |
 * | 只从你给的链接进 | `xhsNoteText.parseNoteLink` 只认一条笔记的详情地址;代码里没有关键词搜索、没有批量翻页 |
 * | 不点任何东西 | 这条路只发 `Page.navigate` 与 `Runtime.evaluate`,**没有 `Input.` 域** |
 * | 滚动是唯一让页面动的动作 | `NOTE_EXPRESSIONS.scroll` 那一句,而且滚了几下**写进记录给你看** |
 * | 不伪装 | 没装 stealth、没改 `navigator.webdriver`、没换 UA、没用代理池 |
 * | 不过验证码 | 见到验证码就停下如实说,当场结束 |
 * | 每天有上限 | `xhsCollect.checkGates`:同一条 10 分钟内不重采,一天默认 30 条 |
 * | 不经服务器 | 采下来的东西只写在你自己的工作目录里,没有任何一条把它往外发的路 |
 */
export const COLLECT_PROMISE_LINES: readonly string[] = [
  '用的是你自己的登录、你自己的电脑,打开的是你自己给我的那一条链接。',
  '只从你给的链接进:我不会去搜关键词、不会去翻某个博主的全部笔记 —— 那是爬,不是帮你记。',
  '不点任何东西:不点赞、不收藏、不关注、不评论、不发布。这些动作的代码一行都没有。',
  '唯一让页面动的动作是往下滚(评论不滚就不加载),滚了几下会写进记录给你看。',
  '不做任何伪装:不改浏览器指纹、不换身份、不用代理。就是你本人在用你自己的浏览器。',
  '遇到验证码或风控页就停下如实告诉你 —— 我不会替你过验证码,一次都不会。',
  '每天有上限(默认 30 条),同一条链接 10 分钟内不重采。',
  '采下来的笔记与评论只落在你自己电脑的工作目录里,不经过任何服务器,也不用于任何别的地方。',
  '要说清楚的一点:采评论要读这一页里浏览器已经下载好的那份数据,比「页面上看得见的字」多一点 —— 但仍然只是读,没有调它的任何接口。',
]

export interface CredentialPanelProps {
  baseUrl: string
  fetchImpl?: typeof fetch
  /**
   * 数据复盘的小红书登录态(2026-09-21)。**缺席 = 这台服务没接自取** ——
   * 那一栏整块不出现,而不是画一颗点了没用的按钮。
   */
  xhs?: {
    connected: boolean
    nickname?: string
    /**
     * 每个账号一个浏览器档案(2026-09-22)。**缺席 / 空 = 还没登过任何一个**。
     * 一个账号一行,底下那颗「再登录一个账号」开下一个纯净档案。
     */
     accounts?: readonly { profile: string, index: number, name: string, connected: boolean }[]
  }
  /**
   * **点亮哪一行**(2026-10-02,卡 QK)。额度那一格「读不到最新」时那颗入口键
   * (「去设置里配」)指的就是这一节里的某一行 —— 她点过来之后那一行该自己站出来,
   * 而不是让她在三四行里再找一遍。值就是那一行的 provider(如 `claude_api`),
   * 由服务端那一份声明给(`quota/liveSources.ts`),这里不写死是哪一家。
   *
   * **只点亮、只滚到,不碰那一行的值**:密钥永不回显(本文件头上那条老纪律),
   * 点亮一行不等于替她填一个字。
   */
  focusRow?: string
  /**
   * 整页摊开(2026-10-22):体检与修复那一页是「一步一步把东西填上」,这一节在那里不折叠 ——
   * 没接上的几家照样一行一行列着、填密钥的框常显、两段规矩原话常显。缺省(设置里)照评审页:
   * 没接上的收进「暂不可用 N 家」,框收在「管理 / 去填」里,规矩原话收进折叠。
   */
  expanded?: boolean
  /**
   * 采集类(2026-09-22)。**缺席 = 这台服务没接采集**,那一段整块不出现。
   * 承诺这种话只该在功能真的在这台机器上时才说 —— 说了做不到比不说糟得多。
   */
  collect?: {
    today: number
    daily_max: number
    workdir_ready: boolean
    tools?: { ffmpeg: boolean, whisper: boolean, model: boolean, note: string }
  }
}

const EMPTY_STATUS: CredentialStatusView = EMPTY_CREDENTIAL_STATUS

export function CredentialPanel({ baseUrl, fetchImpl, xhs, collect, focusRow, expanded = false }: CredentialPanelProps) {
  const [status, setStatus] = useState<CredentialStatusView>(EMPTY_STATUS)
  // 每家一个草稿。**不能共用一个**：KEY_ROWS 现在有两行（DeepSeek 和 Claude），
  // 共用的话在一个框里打字，另一个框会跟着变——而且保存时可能把别家的 Key 提交上去。
  const [drafts, setDrafts] = useState<Partial<Record<CredentialProvider, string>>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [login, setLogin] = useState<LoginProgressView>({ state: 'idle' })
  /** 小红书那一栏最近一次动作的回话。凭据不在这里 —— 这条路**一个凭据都不取**。 */
  const [xhsSaid, setXhsSaid] = useState<string | null>(null)
  /**
   * Claude 那颗「接上」(2026-10-03)。**`undefined` = 这台服务没接这条路** → 整颗键不画,
   * 只剩粘一串密钥那条退路(不摆一颗点了没用的按钮,同小红书那一栏的老规矩)。
   */
  const [connect, setConnect] = useState<ClaudeConnectView | undefined>(undefined)
  /** 哪一家的「管理」摊开着(填密钥那一格收在里面);从额度那一格带着落点进来的,先摊开那一家。 */
  const [editing, setEditing] = useState<string | null>(focusRow ?? null)

  /**
   * 被点名那一行**滚进视野**(2026-10-02,卡 QK)。
   *
   * 用 ref 回调而不是 useEffect 里按 id 查 DOM:只有被点名那一行拿得到这个回调,拿到即滚,
   * 不必知道这一节有几行、也不必起一个 id 约定。jsdom 里没有 `scrollIntoView`,所以先问一句
   * —— 用例断言的是那一行上的记号,不是滚了没有。
   */
  const focusInto = useCallback((node: HTMLFormElement | null) => {
    node?.scrollIntoView?.({ block: 'center' })
  }, [])

  const refreshStatus = useCallback(async () => {
    setStatus(await fetchCredentialStatus(baseUrl, fetchImpl))
  }, [baseUrl, fetchImpl])

  useEffect(() => { void refreshStatus() }, [refreshStatus])

  /** 这台服务接了「一键接上」吗 + 上一次走到哪了(进程重启后这一问会回「没在接」)。 */
  useEffect(() => { void fetchClaudeConnect(baseUrl, fetchImpl).then(setConnect) }, [baseUrl, fetchImpl])

  /**
   * 接的过程里才轮询。她在浏览器里授权要几十秒到几分钟,界面得看得出它还在等
   * (同下面 Kimi 那条登录路的 2 秒一拍)。接上了就顺手把「配了没有」重读一遍 ——
   * 那一行据此从「未接入」变「实时」。
   */
  const connecting = connect?.state === 'opening' || connect?.state === 'waiting'
  useEffect(() => {
    if (!connecting) return
    const timer = window.setInterval(() => {
      void fetchClaudeConnect(baseUrl, fetchImpl).then(async (next) => {
        if (next === undefined) return
        setConnect(next)
        if (next.state === 'done') await refreshStatus()
      })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [connecting, baseUrl, fetchImpl, refreshStatus])

  // 登录期间才轮询进度：登录要花几十秒到几分钟，界面得能看出它还在等。
  const pending = login.state === 'opening' || login.state === 'waiting'
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      void fetchLoginProgress(baseUrl, fetchImpl).then(async (next) => {
        setLogin(next)
        if (next.state === 'done') await refreshStatus()
      })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [pending, baseUrl, fetchImpl, refreshStatus])

  async function saveKey(provider: CredentialProvider): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      setStatus(await submitCredential(baseUrl, provider, (drafts[provider] ?? '').trim(), fetchImpl))
      // 立刻清空这一家：Key 不在 state 里多留一秒。别家的草稿不动。
      setDrafts(prev => ({ ...prev, [provider]: '' }))
      setMessage('已保存，正在取数')
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    }
    finally {
      setBusy(false)
    }
  }

  /** 按「接上」/「换一把」。重复点会顶掉上一次(服务端那边杀干净再起),不把人锁死。 */
  async function openConnect(): Promise<void> {
    setMessage(null)
    try {
      setConnect(await startClaudeConnect(baseUrl, fetchImpl))
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '没能开始')
    }
  }

  /** 放弃这一次:服务端把子进程杀干净,这里回到「还没接」。 */
  async function giveUpConnect(): Promise<void> {
    await cancelClaudeConnect(baseUrl, fetchImpl)
    setConnect({ state: 'idle', message: '' })
  }

  async function openLogin(provider: LoginProvider): Promise<void> {
    setMessage(null)
    try {
      // 重复点击会顶掉上一次，不再报"已经有一个窗口打开"把人锁死。
      await startLogin(baseUrl, provider, fetchImpl)
      setLogin({ state: 'opening', message: '正在打开登录窗口' })
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '打开登录窗口失败')
    }
  }

  /** 自动判定读不到时的兜底：他自己说"我登好了"。 */
  async function captureNow(): Promise<void> {
    setMessage(null)
    try {
      const next = await captureLoginNow(baseUrl, fetchImpl)
      setLogin(next)
      if (next.state === 'done') await refreshStatus()
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '抓取失败')
    }
  }

  /**
   * 打开小红书创作者中心的登录窗口。
   *
   * ★ 与上面 Kimi 那一栏**根本的不同**:Kimi 那条路要把 refresh_token 取回来存进
   * credentials.json;小红书这条路**什么都不取**。登录态自始至终只在那个专用 Chrome
   * 档案目录里,我们连 cookie 的键名都没问过。所以这一栏不在 `status` 里,
   * 它的「已接上」来自 `/state.xhs.login`(一个布尔加一个昵称)。
   */
  async function openXhsLogin(which?: number | 'new'): Promise<void> {
    setXhsSaid(null)
    try {
      // 2026-09-22 多账号:不传 = 第一个档案(与上一版逐字相同);
      // 'new' = 再开一个纯净的;数字 = 重登第 N 个。
      const path = which === 'new' ? '/xhs/login/new' : '/xhs/login'
      const response = await (fetchImpl ?? fetch)(`${baseUrl}${path}`, {
        method: 'POST',
        ...(typeof which === 'number'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: which }) }
          : {}),
      })
      const result = await response.json() as { message?: string }
      setXhsSaid(typeof result.message === 'string' ? result.message : '已经打开登录窗口')
    }
    catch (error) {
      setXhsSaid(error instanceof Error ? error.message : '打不开登录窗口')
    }
  }

  async function giveUp(): Promise<void> {
    await cancelLogin(baseUrl, fetchImpl)
    setLogin({ state: 'idle' })
  }

  const xhsAccounts = xhs?.accounts ?? []
  const xhsLine = xhs === undefined
    ? ''
    : xhs.connected
      ? (xhsAccounts.length > 1
          ? `已接上 ${xhsAccounts.filter(item => item.connected).length}/${xhsAccounts.length} 个账号`
          : `已接上${xhs.nickname === undefined ? '' : ` · ${xhs.nickname}`}`)
      : '未登录'

  /** 一家填密钥的那一家:一行 + 「管理 / 去填」,摊开是密码框与「保存」(+ Claude 的「接上」)。 */
  function keyRow({ provider, name, hint, where, connect: oneClick, states }: typeof KEY_ROWS[number]) {
    const on = status[provider]
    const open = expanded || editing === provider
    const live = oneClick === true && connect !== undefined
    return (
      <div key={provider} data-cred={provider} data-focus={provider === focusRow ? 'true' : undefined}>
        <SetRow
          title={name}
          sub={live && on
            ? `${CLAUDE_LIVE_LINE}${connect.expires_at === undefined ? '' : ` · 密钥到 ${connect.expires_at}`}`
            : live ? `${states?.[1] ?? '未填'} · ${CLAUDE_CONNECT_INVITE}` : (on ? (states?.[0] ?? '已配置') : (states?.[1] ?? '未填'))}
        >
          <span className="ben-wb__srow-acts">
            {live && (
              <SetBtn disabled={connecting} onClick={() => { void openConnect() }}>
                {on ? CLAUDE_RECONNECT_BUTTON : CLAUDE_CONNECT_BUTTON}
              </SetBtn>
            )}
            {!expanded && <SetBtn aria-expanded={open} onClick={() => setEditing(open ? null : provider)}>{on ? '管理' : '去填'}</SetBtn>}
          </span>
        </SetRow>
        {live && connect.state !== 'idle' && connect.message !== '' && (
          <p className="ben-wb__smsg" role="status">
            {connect.message}
            {connecting && <SetBtn kind="text" onClick={() => { void giveUpConnect() }}>取消</SetBtn>}
          </p>
        )}
        {open && (
          <form
            className="ben-wb__srow-more"
            ref={provider === focusRow ? focusInto : undefined}
            onSubmit={(event) => { event.preventDefault(); void saveKey(provider) }}
          >
            {where !== undefined && !on && (
              <p className="ben-wb__smsg"><a href={where.url} target="_blank" rel="noreferrer">{where.label}</a></p>
            )}
            <div className="ben-wb__sform">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={`${name} 的密钥`}
                placeholder={on ? '重填一串就替换掉(留空再保存 = 清掉)' : hint}
                value={drafts[provider] ?? ''}
                onChange={event => setDrafts(prev => ({ ...prev, [provider]: event.target.value }))}
              />
              <SetBtn kind="outline" type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</SetBtn>
            </div>
            <p className="ben-wb__smsg">密钥只存在这台电脑上、只存一份、永不回显,也不会跟着任何东西发出去。</p>
          </form>
        )}
      </div>
    )
  }

  /** 登录那一家(Kimi):一行 + 「登录 ↗ / 重新登录 ↗」。 */
  function loginRow({ provider, name, hint }: typeof LOGIN_ROWS[number]) {
    return (
      <div key={provider} data-cred={provider}>
        <SetRow title={name} sub={`${status[provider] ? '已登录' : '未登录'} · ${hint}`}>
          <SetBtn onClick={() => { void openLogin(provider) }}>{status[provider] ? '重新登录 ↗' : '登录 ↗'}</SetBtn>
        </SetRow>
      </div>
    )
  }

  /** 小红书创作者中心(数据复盘自取):一行 + 每个账号一行;风控那段原话收进「取数规矩」。 */
  function xhsRow() {
    if (xhs === undefined) return null
    return (
      <div key="xhs" data-cred="xhs">
        <SetRow title="小红书创作者中心" sub={`${xhsLine} · 数据复盘那一格的数从这里来。登完不要关那个窗口。`}>
          <SetBtn onClick={() => { void openXhsLogin(xhsAccounts.length === 0 ? undefined : 'new') }}>
            {xhsAccounts.length === 0 ? '登录 ↗' : '再登录一个账号 ↗'}
          </SetBtn>
        </SetRow>
        {xhsAccounts.map(account => (
          <SetRow key={account.profile} title={account.name} sub={account.connected ? '已接上' : '未登录或登录态过期'}>
            <SetBtn onClick={() => { void openXhsLogin(account.index) }}>{account.connected ? '重新登录' : '登录'}</SetBtn>
          </SetRow>
        ))}
        <Folded on={!expanded} summary="取数规矩">
          <p>
            这是用你自己的登录、在你自己电脑上、读你自己的后台页面,不经过任何服务器。
            登录在一个只给它用的浏览器档案里完成,**登录信息不存进工作台的任何文件**,
            也不发给任何人。取数只读页面上看得见的数字:每天早报前一次,
            加上你自己点「刷新」那一次,两次之间至少隔 10 分钟。
          </p>
        </Folded>
        {xhsSaid !== null && <SetMsg>{xhsSaid}</SetMsg>}
      </div>
    )
  }

  // 评审页 `section('credentials', '各家的登录与密钥', …)`:接上的每家一行(名字 + 状态 + 一颗动作),
  // 没接上的收进底部「暂不可用 N 家 · 展开 ›」。填密钥的框收在每家的「管理 / 去填」里。
  const ownKeys = KEY_ROWS.filter(row => row.ownKey === true)
  const rows = [
    ...KEY_ROWS.filter(row => row.ownKey !== true).map(row => ({ on: status[row.provider], id: row.provider as string, node: keyRow(row) })),
    ...LOGIN_ROWS.map(row => ({ on: status[row.provider], id: row.provider as string, node: loginRow(row) })),
    ...(xhs === undefined ? [] : [{ on: xhs.connected, id: 'xhs', node: xhsRow() }]),
  ]
  const off = expanded ? [] : rows.filter(row => !row.on)
  return (
    <SetSection id="ben-wb-cred" title="各家的登录与密钥">
      {rows.filter(row => expanded || row.on).map(row => row.node)}

      {/* ── 采集类(2026-09-22)。★ 与上面小红书那段**分开写**,一个字都不共用 ── */}
      {collect !== undefined && (
        <div data-cred="collect">
          <SetRow title={COLLECT_PROMISE_TITLE} sub={`今天 ${collect.today} / ${collect.daily_max} 条`} />
          {!collect.workdir_ready && <SetErr>还没配「工作目录」(事务官仓库),采下来的东西没地方落 —— 这一块现在用不了。</SetErr>}
          {collect.tools !== undefined && <SetMsg>{collect.tools.note}</SetMsg>}
          <Folded on={!expanded} summary="采集的规矩">
            <p>{COLLECT_PROMISE_LINES.map(line => <span key={line}>{line}<br /></span>)}</p>
          </Folded>
        </div>
      )}

      {off.length > 0 && (
        <SetFold summary={`暂不可用 ${off.length} 家`} defaultOpen={off.some(row => row.id === focusRow)}>
          {off.map(row => row.node)}
        </SetFold>
      )}

      {expanded
        ? ownKeys.map(row => keyRow(row))
        : (
            <SetFold summary={OWN_KEYS_SUMMARY} defaultOpen={ownKeys.some(row => row.provider === focusRow)}>
              {ownKeys.map(row => keyRow(row))}
            </SetFold>
          )}

      {pending && (
        <SetWarn role="status">
          <span>{login.message ?? '正在等待登录'}</span>
          <SetActions>
            <SetBtn onClick={() => { void giveUp() }}>取消</SetBtn>
            <SetBtn kind="outline" onClick={() => { void captureNow() }}>我已登录，现在抓取</SetBtn>
          </SetActions>
        </SetWarn>
      )}
      {login.state === 'failed' && <SetMsg>{login.message ?? '登录失败'}</SetMsg>}
      {message !== null && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}

/** 设置里收进折叠,整页摊开时原样摆着(两段规矩原话)。 */
function Folded({ on, summary, children }: { on: boolean, summary: string, children: ReactNode }) {
  return on ? <SetFold summary={summary}>{children}</SetFold> : <div className="ben-wb__sfold-body">{children}</div>
}

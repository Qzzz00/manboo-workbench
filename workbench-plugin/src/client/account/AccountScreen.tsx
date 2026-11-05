/**
 * 登录屏(2026-09-17,决策记录「登录就是账号密码」)。Ben 原话:
 * 「登录就是登录自己的账号密码啊,现在可以随便注册,自己记得住就行。」
 *
 * 形态:**整屏**,上面只有「登录 / 注册」两个切换和三个输入框。
 * 2026-09-23 起(维护者:「桌面端也很丑...不需要弹窗」)**不再是一张浮在空白里的卡**:
 * 与首次流程同一个舞台,下面是没有框的表单。
 * 同日晚(维护者拍板品牌视觉):顶上那一块换成**粒子黑洞**(产品的主视觉,brand/BlackholeHero.tsx),
 * 位置就是原来那颗小球的位置;登录成功那一刻,黑洞里的粒子飞出来,聚成下一屏同一位置上事务官的球(brand/brandHandoff.ts)。
 * 它是装完之后第一次打开看到的第一屏 —— 所以这一屏上不出现任何"还要装什么、还差什么授权"
 * (那些是横幅与「体检与修复」的事,09-17 拍板「三个环节分开」)。
 *
 * 一条纪律:**这一屏不猜**。服务端说什么就显示什么(「用户名或密码不对」「密码连续错 5 次…」),
 * 界面自己不另写一套校验话术 —— 两处各写一份,不一致的那次一定是界面放过了服务端要拒的东西。
 */
import { useEffect, useRef, useState } from 'react'
import { BlackholeHero, type HeroHandle } from '../brand/BlackholeHero.tsx'
import { prepareBrandHandoff, reportHandoffPerf, startBrandHandoff } from '../brand/brandHandoff.ts'
import {
  COOKIE_BLOCKED_HINT, loginAccount, probeAccount, registerAccount, type AccountView, resetAccount } from './accountApi.ts'

export interface AccountScreenProps {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 这会儿服务端说的状态:注册过没有(决定默认落在哪个页签)。 */
  view: AccountView
  /** 登录/注册成功(并且 cookie 真的种上了)之后调一次。 */
  onLoggedIn: (view: AccountView) => void
  /** 重置账号之后:上层重新问一次 /account(registered 变 false)。 */
  onReset?: () => void
}

type Tab = 'login' | 'register'

/**
 * 卡底下那一行「账号存在哪」(2026-09-23 从零重装验收第 4 件)。
 *
 * 以前一律写「账号只存在这台电脑上,不会传到任何地方」—— 09-21 账号搬到服务器之后,
 * `~/.dsh/workbench/account-server.json` 明明在(账号在服务器上),这一句还照写。**这一行要与事实一致**:
 *   - `on_server`:账号在工作台的服务器上;这台电脑只记着登录状态,密码哈希已经抹掉(serverAccount.ts 的 clearLocalSecret);
 *   - 注册过、但不在服务器上(还没迁移的老机器 / 服务器没有账号服务时退回的本机账号):那一句仍然是真的;
 *   - 还没注册:注册时先去服务器;服务器没有账号服务 / 连不上才退回本机(serverAccount.ts 的 register)。
 */
/** 这台没接中转(零服务器档)时登录台底下那一行:账号只在这台电脑上,不提服务器。 */
export const ACCOUNT_NO_RELAY_FOOT = '这台没接中转:账号只在这台电脑上,不会传到任何地方。'

export function accountFootText(view: Pick<AccountView, 'registered' | 'on_server'>): string {
  if (view.on_server === true) return '账号在工作台的服务器上,换电脑、手机都用它登录;这台电脑只记着登录状态,不存你的密码。'
  if (view.registered) return '账号只存在这台电脑上,不会传到任何地方。'
  return '注册的账号存在工作台的服务器上,换电脑、手机都能登录;连不上服务器时先只存在这台电脑上。'
}

/** 「重置账号」确认框那一句。账号在服务器上时它的意思是"这台电脑不登了",不是删账号。 */
export function accountResetConfirmText(view: Pick<AccountView, 'on_server'>): string {
  return view.on_server === true
    ? '重置账号?这台电脑会退出这个账号(服务器上的账号不删,以后还能用它登录),然后你可以重新注册一个。事项、记忆、设置都不会动。'
    : '重置账号?这台电脑上的账号会删掉,你要重新注册一个。事项、记忆、设置都不会动。'
}

export function AccountScreen({ baseUrl, fetchImpl, view, onLoggedIn, onReset }: AccountScreenProps) {
  const doFetch = fetchImpl ?? fetch
  // 还没注册过就直接落在「注册」:第一次开机的人不该先看到一张填不了的登录表。
  const [tab, setTab] = useState<Tab>(view.registered ? 'login' : 'register')
  const [username, setUsername] = useState(view.username ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const hero = useRef<HeroHandle | null>(null)
  useEffect(() => () => { mounted.current = false }, [])
  // 串联的重活(终点核心预热、挑粒子)趁他在输密码时的空闲做掉,点登录那一下不再卡(2026-09-24)。
  useEffect(() => prepareBrandHandoff(hero), [])

  async function resetAndRegister(): Promise<void> {
    if (busy) return
    if (!window.confirm(accountResetConfirmText(view))) return
    setBusy(true)
    setError(null)
    try {
      await resetAccount(baseUrl, doFetch)
      if (!mounted.current) return
      setTab('register')
      setPassword('')
      setConfirm('')
      onReset?.()
    }
    catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '出错了')
    }
    finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function submit(event: { preventDefault: () => void }): Promise<void> {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (tab === 'register') await registerAccount(baseUrl, { username, password, confirm }, doFetch)
      else await loginAccount(baseUrl, { username, password }, doFetch)
      /**
       * 立刻再问一次 /account。两个理由:
       * ① 拿到服务端认下来的用户名,交给上层;
       * ② **cookie 有没有真的种上**只有这一问能知道。跨站打开(localhost:3080 → 127.0.0.1:8791)
       *    时 SameSite=Lax 的 cookie 带不回来,表现是"登录成功但一刷新又回登录屏" ——
       *    与其让人反复输密码,不如在这里当场说清楚该换哪个地址。
       */
      const probe = await probeAccount(baseUrl, doFetch)
      if (!mounted.current) return
      if (!probe.enabled || !probe.view.logged_in) {
        setError(COOKIE_BLOCKED_HINT)
        return
      }
      setPassword('')
      setConfirm('')
      // 串联:黑洞里的粒子飞出来聚成她的球(brand/brandHandoff.ts)。先起动画再换屏 —— 动画不拦换屏,坏了也不拦。
      startBrandHandoff(hero.current, { report: perf => { void reportHandoffPerf(baseUrl, perf, doFetch) } })
      onLoggedIn(probe.view)
    }
    catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '出错了')
    }
    finally {
      if (mounted.current) setBusy(false)
    }
  }

  const registering = tab === 'register'
  return (
    <div className="ben-wb__account ben-wb__onb" role="dialog" aria-modal="true" aria-label="登录" data-orb="small">
      {/*
        2026-09-23 起顶上是产品的主视觉(粒子黑洞),不再是事务官的球 —— 她在登录成功那一下从黑洞里「飞出来」。
        提交时黑洞流得快一点(busy)。整块只占原来那颗小球的位置,画布左右铺满、底下渐隐,表单不被压。
      */}
      <div className="ben-wb__brand-slot">
        <BlackholeHero busy={busy} handleRef={hero} />
      </div>
      <form className="ben-wb__account-form" onSubmit={submit}>
        <h1 className="ben-wb__account-ttl">工作台</h1>
        <p className="ben-wb__account-sub">
          {view.registered
            ? '用你自己的账号密码登录。'
            : '这台机器还没有账号 —— 随便注册一个,自己记得住就行。'}
        </p>

        <div className="ben-wb__account-tabs" role="tablist" aria-label="登录或注册">
          <button
            type="button"
            role="tab"
            aria-selected={!registering}
            data-on={!registering}
            className="ben-wb__account-tab"
            onClick={() => { setTab('login'); setError(null) }}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={registering}
            data-on={registering}
            className="ben-wb__account-tab"
            onClick={() => { setTab('register'); setError(null) }}
          >
            注册
          </button>
        </div>

        <label className="ben-wb__account-field">
          <span>用户名</span>
          <input
            className="ben-wb__account-input"
            value={username}
            autoComplete="username"
            onChange={event => setUsername(event.target.value)}
          />
        </label>
        <label className="ben-wb__account-field">
          <span>密码</span>
          <input
            className="ben-wb__account-input"
            type="password"
            value={password}
            autoComplete={registering ? 'new-password' : 'current-password'}
            onChange={event => setPassword(event.target.value)}
          />
        </label>
        {registering && (
          <label className="ben-wb__account-field">
            <span>确认密码</span>
            <input
              className="ben-wb__account-input"
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={event => setConfirm(event.target.value)}
            />
          </label>
        )}

        {error !== null && <p className="ben-wb__account-err" role="alert">{error}</p>}
        {view.locked_until !== undefined && error === null && (
          <p className="ben-wb__account-err" role="alert">密码连续错 5 次,10 分钟内不再接受登录。</p>
        )}

        <button type="submit" className="ben-wb__account-go" disabled={busy}>
          {busy ? '请稍等…' : (registering ? '注册' : '登录')}
        </button>
        <p className="ben-wb__account-foot">
          {view.relay_configured === false ? ACCOUNT_NO_RELAY_FOOT : accountFootText(view)}
          {view.registered && !registering && (
            <>
              {' '}忘了密码?
              <button type="button" className="ben-wb__account-reset" disabled={busy} onClick={() => void resetAndRegister()}>重置账号,重新注册</button>
              。你的事项和记忆都还在,只是换个账号。
            </>
          )}
        </p>
      </form>
    </div>
  )
}

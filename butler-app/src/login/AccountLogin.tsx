/**
 * 手机上的账号登录屏(2026-09-21)。
 *
 * 在这之前,手机上的「登录」只有扫码配对一条路,于是「换手机」「重装」「电脑不在手边」
 * 这三件很常见的事都做不了。这一屏把它们补上。
 *
 * 一条纪律与电脑端那一屏一样:**这一屏不猜**。服务器说什么就显示什么
 * (「邮箱/手机号或密码不对」「密码连续错 5 次…」),界面自己不另写一套校验话术 ——
 * 两处各写一份,不一致的那次一定是界面放过了服务端要拒的东西。
 *
 * 密码框里的东西只进那一次请求。**不存、不打日志、不进任何错误消息**。
 */
import { useState } from 'react';
import type { AccountRecord, AccountStore } from '../account/accountStore';
import { phoneAccountLogin } from '../account/phoneLogin';

export interface AccountLoginProps {
  relayUrl: string;
  deviceId: string;
  deviceName?: string;
  store: AccountStore;
  fetchImpl?: typeof fetch;
  onLoggedIn(account: AccountRecord): void;
  onBack(): void;
}

type Tab = 'login' | 'register';

export function AccountLogin(props: AccountLoginProps) {
  const [tab, setTab] = useState<Tab>('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await phoneAccountLogin({
      relayUrl: props.relayUrl,
      identifier,
      password,
      mode: tab,
      deviceId: props.deviceId,
      store: props.store,
      ...(props.deviceName === undefined ? {} : { deviceName: props.deviceName }),
      ...(props.fetchImpl === undefined ? {} : { fetchImpl: props.fetchImpl }),
    });
    // 不管成没成,密码这就从内存里去掉。
    setPassword('');
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    props.onLoggedIn(result.account);
  }

  return (
    <section className="ba-login__body" data-screen="account">
      <h1 className="ba-login__title ba-login__title--sm">用账号登录</h1>
      <p className="ba-login__say">
        登录之后这台手机就是你账号下的一台设备:出门在外也连得上电脑上的事务官,不用先回到家里的 Wi-Fi。
      </p>

      <div className="ba-login__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'login'}
          className={`ba-btn ba-btn--ghost${tab === 'login' ? ' is-on' : ''}`}
          onClick={() => { setTab('login'); setError(null); }}
        >
          登录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'register'}
          className={`ba-btn ba-btn--ghost${tab === 'register' ? ' is-on' : ''}`}
          onClick={() => { setTab('register'); setError(null); }}
        >
          注册
        </button>
      </div>

      <form className="ba-login__form" onSubmit={(e) => { void submit(e); }}>
        <label className="ba-login__field">
          <span>邮箱或手机号</span>
          <input
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="email"
            value={identifier}
            onChange={e => setIdentifier(e.target.value)}
          />
        </label>
        <label className="ba-login__field">
          <span>密码</span>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        {error !== null && <p className="ba-notice" role="status">{error}</p>}
        <button type="submit" className="ba-btn ba-btn--big" disabled={busy}>
          {busy ? '请稍等…' : tab === 'register' ? '注册并登录' : '登录'}
        </button>
      </form>

      <button type="button" className="ba-btn ba-btn--ghost ba-login__alt" onClick={props.onBack}>返回</button>
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import { guestLogin, registerOrLogin, setServerUrl, loginAsLocalGuest, getAuthConfig, type UserInfo } from '../lib/authStore.ts';
import { ApiError, ApiNetworkError } from '../lib/apiClient.ts';
import { LoginLive2D } from '../features/live2d/LoginLive2D.tsx';

// 这些错误码后端已给出中文 message，直接透传比通用文案更准确。
const PASSTHROUGH_ERROR_CODES = new Set([
  'invite_required', 'invite_invalid', 'invite_used_up', 'invite_revoked', 'invite_expired',
  'device_required', 'device_not_bound',
]);

const PROMO_TRANSFORM = { scale: 1, offsetX: 0, offsetY: -0.18 };

type LoginPageProps = {
  onLogin: (user: UserInfo) => void;
  /** 为 false 时不渲染内置角色（由 App 的常驻 Live2D 层提供，移动端共享实例） */
  showCharacter?: boolean;
};

function formatLoginError(e: unknown, inviteOnly: boolean): string {
  if (e instanceof ApiNetworkError) {
    return '无法连接到服务器，请检查网络或服务器地址';
  }
  if (e instanceof ApiError) {
    if (e.code && PASSTHROUGH_ERROR_CODES.has(e.code)) return e.message || '操作失败';
    // 内测下邀请码即登录凭证：登录不匹配(401)＝手机号或邀请码不对。
    if (e.status === 401) return inviteOnly ? '手机号或邀请码不正确，请重新输入' : '账号或密码不正确，请重新输入';
    if (e.status === 400) return inviteOnly ? '请检查手机号和邀请码' : '手机号至少 2 位、密码至少 4 位';
    if (e.status === 429) return '服务器繁忙，请稍后再试';
    if (e.status >= 500) return '服务器繁忙，请稍后再试';
    return e.message || '操作失败';
  }
  if (e instanceof Error) {
    return e.message || '操作失败';
  }
  return '操作失败';
}

const AGREEMENT_TEXT = '我已阅读并同意《用户协议》《隐私政策》';

export function LoginPage({ onLogin, showCharacter = true }: LoginPageProps) {
  const [step, setStep] = useState<'entry' | 'phone'>('entry');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [inviteOnly, setInviteOnly] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [agreementChecked, setAgreementChecked] = useState(false);
  const [agreementPromptOpen, setAgreementPromptOpen] = useState(false);

  // 内测开关：决定是否要求邀请码、是否禁用游客一键登录。
  useEffect(() => {
    let alive = true;
    getAuthConfig().then((cfg) => {
      if (alive) setInviteOnly(cfg.inviteOnly);
    });
    return () => {
      alive = false;
    };
  }, []);

  function ensureAgreement(): boolean {
    if (!agreementChecked) {
      setAgreementPromptOpen(true);
      return false;
    }
    return true;
  }

  // 连点三下标题 → 纯本地游客模式（后端挂掉时直接进主页调 UI）
  const titleClickRef = useRef(0);
  const titleTimerRef = useRef<number | null>(null);
  function handleTitleClick() {
    titleClickRef.current += 1;
    if (titleTimerRef.current) window.clearTimeout(titleTimerRef.current);
    if (titleClickRef.current >= 3) {
      titleClickRef.current = 0;
      onLogin(loginAsLocalGuest());
      return;
    }
    titleTimerRef.current = window.setTimeout(() => { titleClickRef.current = 0; }, 800);
  }

  async function runAuth(action: () => Promise<UserInfo>) {
    setError('');
    setLoading(true);
    try {
      const user = await action();
      onLogin(user);
    } catch (e: unknown) {
      setError(formatLoginError(e, inviteOnly));
    } finally {
      setLoading(false);
    }
  }

  function handleGuestLogin() {
    setError('');
    if (inviteOnly) {
      // 内测期间不开放游客一键登录，引导走邀请码注册。
      setError('内测期间需邀请码注册，请点「手机号登录」并填写邀请码');
      setStep('phone');
      return;
    }
    if (!ensureAgreement()) return;
    void runAuth(() => guestLogin());
  }

  function goPhone() {
    setError('');
    setStep('phone');
  }

  function handlePhoneSubmit() {
    setError('');
    if (!ensureAgreement()) return;
    if (!phone.trim()) {
      setError('请输入手机号');
      return;
    }
    if (inviteOnly) {
      // 内测：手机号 + 邀请码。邀请码同时作为该手机号的登录凭证(password)。
      const inv = inviteCode.trim();
      if (!inv) {
        setError('请输入邀请码');
        return;
      }
      void runAuth(() => registerOrLogin(phone.trim(), inv, inv));
      return;
    }
    // 非内测(未来开放注册)：手机号 + 密码。
    if (!code.trim()) {
      setError('请输入密码');
      return;
    }
    void runAuth(() => registerOrLogin(phone.trim(), code));
  }

  const agreementRow = (
    <label className="login-agreement">
      <input
        type="checkbox"
        checked={agreementChecked}
        onChange={(event) => setAgreementChecked(event.target.checked)}
      />
      <span className="login-agreement-box" aria-hidden="true" />
      <span>{AGREEMENT_TEXT}</span>
    </label>
  );

  return (
    <div className="login-page">
      <div className="login-nav">
        <div className="login-camera-bar">
          {step === 'phone' ? (
            <button className="login-back" onClick={() => { setStep('entry'); setError(''); }} aria-label="返回">
              ‹
            </button>
          ) : null}
        </div>
      </div>

      {step === 'entry' && showCharacter ? (
        <LoginLive2D avatarId="shuangsheng" transform={PROMO_TRANSFORM} motionName="idle" />
      ) : null}

      {step === 'entry' ? (
        <img className="login-logo" src="/logo-aboo.svg" alt="Aiboo" />
      ) : null}

      {step === 'entry' ? (
        <div className="login-card login-card--entry">
          <div className="login-copy">
            <h2 className="login-title" onClick={handleTitleClick} style={{ userSelect: 'none' }}>终于等到你～</h2>
            <p className="login-subtitle">登录后即可邂逅你的专属伙伴！</p>
          </div>

          {error ? <p className="login-error">{error}</p> : null}

          <button className="login-btn" onClick={handleGuestLogin} disabled={loading}>
            {loading ? '请稍候...' : '一键登录'}
          </button>
          <button className="login-secondary-btn" onClick={goPhone} disabled={loading}>
            手机号登录
          </button>

          {agreementRow}

          {/* 服务器地址仅在开发(浏览器 dev)下可见；打包 APK 隐藏，测试用户一律连生产。 */}
          {import.meta.env.DEV ? (
            <>
              <button className="login-server-toggle" onClick={() => setShowServer(!showServer)}>
                {showServer ? '收起' : '服务器设置'}
              </button>
              {showServer ? (
                <input
                  className="login-input login-server-input"
                  type="text"
                  placeholder="服务器地址 (默认 your-aiboo-host:3456)"
                  onChange={e => { if (e.target.value) setServerUrl(e.target.value); }}
                />
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <div className="login-card login-card--phone">
          <h2 className="login-bigtitle">登录</h2>
          {inviteOnly ? (
            <p className="login-subtitle">内测期间：手机号 + 邀请码即可进入，邀请码就是你之后的登录凭证</p>
          ) : null}

          <div className="login-field-stack">
            <div className="login-phone-field">
              <span className="login-phone-prefix">+86</span>
              <input
                className="login-bare-input"
                type="tel"
                inputMode="numeric"
                placeholder="请输入手机号"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                autoComplete="username"
              />
            </div>
            {inviteOnly ? (
              <div className="login-code-field">
                <input
                  className="login-bare-input"
                  type="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="请输入邀请码"
                  value={inviteCode}
                  onChange={e => setInviteCode(e.target.value.toUpperCase())}
                />
              </div>
            ) : (
              <div className="login-code-field">
                <input
                  className="login-bare-input"
                  type="password"
                  placeholder="请输入密码"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
            )}
          </div>

          {error ? <p className="login-error">{error}</p> : null}

          <button className="login-btn" onClick={handlePhoneSubmit} disabled={loading}>
            {loading ? '请稍候...' : '登录'}
          </button>

          {agreementRow}
        </div>
      )}

      {agreementPromptOpen ? (
        <div className="login-agreement-mask">
          <div className="login-agreement-dialog" role="dialog" aria-modal="true" aria-labelledby="agreement-title">
            <h3 id="agreement-title">用户协议和隐私政策</h3>
            <p>为保障您的权益，请阅读并同意《用户协议》和《隐私政策》</p>
            <div className="login-agreement-actions">
              <button type="button" onClick={() => setAgreementPromptOpen(false)}>
                不同意
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setAgreementChecked(true);
                  setAgreementPromptOpen(false);
                }}
              >
                同意
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

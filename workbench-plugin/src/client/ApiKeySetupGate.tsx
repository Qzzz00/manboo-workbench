/**
 * 首次安装后的整屏密钥引导(2026-11-11 建屏,2026-11-12 改三步向导)。
 *
 * ## 一屏只做一件事
 *
 *   第 1 步 去登录 → 第 2 步 完成实名 → 第 3 步 回来贴 Key
 *
 * 前两步的**主按钮就是那扇门**:点一下直接把 DeepSeek 开放平台的 API Keys 页交给系统浏览器
 * (壳里 `target=_blank` / 点外链会走 WebPolicy.openExternally),用户不用再找「入口在哪」。
 * 点完顺手把进度推到下一步,等他从浏览器复制完 Key 回来,正好落在「贴 Key」那一屏。
 *
 * ## 第 3 步的四件小事
 *
 * - **剪贴板识别**:窗口重新拿到焦点 / 页面重新可见时静默读一次剪贴板,是 sk- 开头的串
 *   就提示「检测到 Key,一键填入」;另有显式的「从剪贴板粘贴」(用户手势,WKWebView 里
 *   权限最稳)与 onPaste 兜底。读不到一律静默降级,不弹错、不挡人。
 * - **自动填参**:服务地址与模型名只读展示(服务端 own 档缺省就是这两个值,见
 *   modelConfig.ts 的 OWN_DEFAULT_*),界面上只有一格要填,就是 Key。
 * - **一键测试连接**:拿草稿里那把还没保存的 Key 打一次,401 / 402 由服务端翻成人话。
 * - **保存**:只走现成的 `submitCredential`,不新造写入口。
 *
 * ## 纪律(AGENTS.md / credentials.ts)
 *
 * - 密钥只在内存里的 input 草稿 / 剪贴板草稿,提交完立刻清空;不进 localStorage、不进错误话术。
 * - 服务端 GET 只回「配了没有」,这里也只认那个布尔,从不显示密钥本身(检测提示也不显示串内容)。
 * - 底层错误可能把请求体(含密钥)带出来,一律换成自己的话。
 *
 * 视觉:与登录屏 / 首次流程同一舞台(粒子黑洞 + 无框表单),令牌走 --wb-*,跟随系统亮暗。
 */
import { useEffect, useState, type ClipboardEvent, type FormEvent } from 'react'
import { BlackholeHero } from './brand/BlackholeHero.tsx'
import {
  API_KEY_GATE_COPY, API_KEY_SETUP_STEPS, DEEPSEEK_API_KEYS_URL, DEEPSEEK_PRESET,
  looksLikeDeepSeekKey, stepNumber, type ApiKeySetupStep,
} from './apiKeyGate.ts'
import { submitCredential, testCredentialConnection, type CredentialTestView } from './credentials.ts'

export interface ApiKeySetupGateProps {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 密钥存好、服务端确认 configured 之后调一次——上层据此放行。 */
  onSaved: () => void
  /** 点「稍后再说」:本次会话放行,但**不写任何持久旗子**,下次启动再提醒。 */
  onSkip: () => void
  /** 从首页「配置 AI 来源」重新唤起时,直接落到「贴 Key」那一步(前两件事在浏览器里已做完)。 */
  initialStep?: ApiKeySetupStep
  /** 剪贴板读取口,测试可注入;缺省走 navigator.clipboard.readText()。 */
  readClipboard?: () => Promise<string>
}

/** 缺省的剪贴板读取。WKWebView 里可能没有这个 API / 会拒权限,调用方一律 catch 后静默降级。 */
async function defaultReadClipboard(): Promise<string> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) throw new Error('clipboard unavailable')
  return navigator.clipboard.readText()
}

export function ApiKeySetupGate({
  baseUrl, fetchImpl, onSaved, onSkip, initialStep = 'login', readClipboard,
}: ApiKeySetupGateProps) {
  const doFetch = fetchImpl ?? fetch
  const read = readClipboard ?? defaultReadClipboard
  const [step, setStep] = useState<ApiKeySetupStep>(initialStep)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 检测到但还没填进去的那串。只在内存里,界面只说「检测到 Key」,不显示内容。 */
  const [clipboardKey, setClipboardKey] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<CredentialTestView | undefined>(undefined)

  const n = stepNumber(step)

  /** Key 变了,上一次测试结果就不算数了。 */
  const clearTest = (): void => { setTestResult(undefined) }
  const onDraftChange = (value: string): void => {
    setDraft(value)
    setError(null)
    clearTest()
  }

  /**
   * 从浏览器复制完 Key 回到客户端:窗口 focus / 页面重新可见时静默探一次剪贴板。
   * 读不到权限不是错误 —— WKWebView 的 clipboard API 常要用户手势,所以另备了
   * 显式的「从剪贴板粘贴」按钮与 onPaste 兜底。这里只负责「回来就自动看见」。
   */
  useEffect(() => {
    if (step !== 'paste') return
    let alive = true
    const probe = (): void => {
      void read()
        .then((text) => { if (alive && looksLikeDeepSeekKey(text)) setClipboardKey(text.trim()) })
        .catch(() => { /* 权限/API 缺席都静默,不打扰 */ })
    }
    probe()
    window.addEventListener('focus', probe)
    document.addEventListener('visibilitychange', probe)
    return () => {
      alive = false
      window.removeEventListener('focus', probe)
      document.removeEventListener('visibilitychange', probe)
    }
  }, [step, read])

  /** 显式的用户手势路径:读作 Key 就直接填,读不到给一句能照着做的话。 */
  const pasteFromClipboard = async (): Promise<void> => {
    try {
      const text = await read()
      if (!looksLikeDeepSeekKey(text)) {
        setError(API_KEY_GATE_COPY.clipboardReadFailed)
        return
      }
      setDraft(text.trim())
      setClipboardKey(null)
      setError(null)
      clearTest()
    }
    catch {
      setError(API_KEY_GATE_COPY.clipboardReadFailed)
    }
  }

  /** 兜底:他直接按 ⌘V / Ctrl+V 时,顺手把首尾空白去掉,免得复制带空格导致 401。 */
  const onPaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text')
    if (!looksLikeDeepSeekKey(text)) return
    event.preventDefault()
    onDraftChange(text.trim())
    setClipboardKey(null)
  }

  /** 「一键测试连接」:测的是草稿里那把 Key,没测通的一个字都不落盘。 */
  const runTest = async (): Promise<void> => {
    const key = draft.trim()
    if (key === '' || testing) return
    setTesting(true)
    setTestResult(undefined)
    setError(null)
    try {
      setTestResult(await testCredentialConnection(baseUrl, key, doFetch))
    }
    catch {
      setTestResult({ ok: false, message: API_KEY_GATE_COPY.testFailedFallback })
    }
    finally {
      setTesting(false)
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const key = draft.trim()
    if (key === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await submitCredential(baseUrl, 'deepseek', key, doFetch)
      // 服务端回话里那个布尔才是"配上了没有"的真相;不看本地输入长度、不自己判。
      setDraft('')
      if (status.deepseek === true) onSaved()
      else setError(API_KEY_GATE_COPY.saveFailed)
    }
    catch {
      // 底层错误可能把请求体(含密钥)带出来,一律换成自己的话。
      setError(API_KEY_GATE_COPY.saveFailed)
    }
    finally {
      setBusy(false)
    }
  }

  /** 点主 CTA:链接自己会把外链交给系统浏览器,这里只推进进度(不 preventDefault)。 */
  const advance = (to: ApiKeySetupStep): void => { setStep(to); setError(null) }

  return (
    <main className="ben-wb ben-wb__akey" aria-label="配置密钥">
      <style>{GATE_STYLE}</style>
      <div className="ben-wb__akey-hero"><BlackholeHero /></div>
      <div className="ben-wb__akey-body">
        {/* 进度指示:三段 + 「第 N 步 / 共 3 步」,一屏一件事 */ }
        <div className="ben-wb__akey-progress" role="progressbar"
          aria-label="配置进度" aria-valuemin={1} aria-valuemax={API_KEY_SETUP_STEPS.length} aria-valuenow={n}>
          {API_KEY_SETUP_STEPS.map((one, index) => (
            <span key={one.id} className="ben-wb__akey-progress-seg"
              data-state={index + 1 < n ? 'done' : index + 1 === n ? 'current' : 'todo'} />
          ))}
        </div>
        <div className="ben-wb__akey-progress-text">
          {API_KEY_GATE_COPY.progress(n)} · {API_KEY_SETUP_STEPS[n - 1]!.label}
        </div>

        <div className="ben-wb__akey-kicker">{API_KEY_GATE_COPY.kicker}</div>

        {step === 'login' && (
          <section className="ben-wb__akey-step" aria-label="去登录">
            <h1 className="ben-wb__akey-title">{API_KEY_GATE_COPY.login.title}</h1>
            <p className="ben-wb__akey-lead">{API_KEY_GATE_COPY.login.lead}</p>
            <a className="ben-wb__akey-primary" href={DEEPSEEK_API_KEYS_URL}
              target="_blank" rel="noreferrer noopener"
              onClick={() => { advance('verify') }}>
              {API_KEY_GATE_COPY.login.primary}
            </a>
            <button className="ben-wb__akey-alt" type="button" onClick={() => { advance('verify') }}>
              {API_KEY_GATE_COPY.login.alt}
            </button>
          </section>
        )}

        {step === 'verify' && (
          <section className="ben-wb__akey-step" aria-label="完成实名">
            <h1 className="ben-wb__akey-title">{API_KEY_GATE_COPY.verify.title}</h1>
            <p className="ben-wb__akey-lead">{API_KEY_GATE_COPY.verify.lead}</p>
            <a className="ben-wb__akey-primary" href={DEEPSEEK_API_KEYS_URL}
              target="_blank" rel="noreferrer noopener"
              onClick={() => { advance('paste') }}>
              {API_KEY_GATE_COPY.verify.primary}
            </a>
            <button className="ben-wb__akey-alt" type="button" onClick={() => { advance('paste') }}>
              {API_KEY_GATE_COPY.verify.alt}
            </button>
          </section>
        )}

        {step === 'paste' && (
          <section className="ben-wb__akey-step" aria-label="回来贴 Key">
            <h1 className="ben-wb__akey-title">{API_KEY_GATE_COPY.paste.title}</h1>
            <p className="ben-wb__akey-lead">{API_KEY_GATE_COPY.paste.lead}</p>

            {clipboardKey !== null && (
              <div className="ben-wb__akey-clip" role="status">
                <span>{API_KEY_GATE_COPY.clipboardFound}</span>
                <button type="button" onClick={() => { onDraftChange(clipboardKey); setClipboardKey(null) }}>
                  {API_KEY_GATE_COPY.clipboardFill}
                </button>
              </div>
            )}

            <form className="ben-wb__akey-form" onSubmit={(event) => { void save(event) }}>
              <label className="ben-wb__akey-label" htmlFor="ben-wb-akey-key">{API_KEY_GATE_COPY.fieldLabel}</label>
              <input
                id="ben-wb-akey-key"
                className="ben-wb__akey-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={API_KEY_GATE_COPY.placeholder}
                value={draft}
                disabled={busy}
                onChange={(event) => { onDraftChange(event.target.value) }}
                onPaste={onPaste}
              />
              <div className="ben-wb__akey-preset">
                <div className="ben-wb__akey-preset-title">{API_KEY_GATE_COPY.presetTitle}</div>
                <div className="ben-wb__akey-preset-row">
                  <span>{API_KEY_GATE_COPY.presetBaseLabel}</span><code>{DEEPSEEK_PRESET.baseUrl}</code>
                </div>
                <div className="ben-wb__akey-preset-row">
                  <span>{API_KEY_GATE_COPY.presetModelLabel}</span><code>{DEEPSEEK_PRESET.model}</code>
                </div>
              </div>

              <div className="ben-wb__akey-actions">
                <button className="ben-wb__akey-alt ben-wb__akey-alt--inline" type="button"
                  disabled={busy || testing} onClick={() => { void pasteFromClipboard() }}>
                  {API_KEY_GATE_COPY.clipboardRead}
                </button>
                <button className="ben-wb__akey-test" type="button"
                  disabled={busy || testing || draft.trim() === ''} onClick={() => { void runTest() }}>
                  {testing ? API_KEY_GATE_COPY.testing : API_KEY_GATE_COPY.test}
                </button>
              </div>

              {testResult !== undefined && (
                <div className={testResult.ok ? 'ben-wb__akey-test-ok' : 'ben-wb__akey-error'} role="status">
                  {testResult.ok ? API_KEY_GATE_COPY.testPassed : testResult.message}
                </div>
              )}
              {error !== null && <div className="ben-wb__akey-error" role="alert">{error}</div>}

              <button className="ben-wb__akey-save" type="submit" disabled={busy || draft.trim() === ''}>
                {busy ? API_KEY_GATE_COPY.saving
                  : testResult?.ok === true ? API_KEY_GATE_COPY.testSave : API_KEY_GATE_COPY.save}
              </button>
            </form>
          </section>
        )}

        {n > 1 && (
          <button className="ben-wb__akey-back" type="button" disabled={busy}
            onClick={() => { advance(API_KEY_SETUP_STEPS[n - 2]!.id) }}>
            ← {API_KEY_GATE_COPY.back}
          </button>
        )}
        <button className="ben-wb__akey-skip" type="button" onClick={onSkip} disabled={busy}>
          {API_KEY_GATE_COPY.skip}
        </button>
        <p className="ben-wb__akey-privacy">{API_KEY_GATE_COPY.privacy}</p>
      </div>
    </main>
  )
}

/**
 * 样式自包含,全部挂在 `.ben-wb__akey` 下,不漏到工作台本体。令牌取 --wb-*——
 * 与工作台同一个主题根,系统亮暗切换时这一屏跟着变(与登录屏、首次流程同一套)。
 */
const GATE_STYLE = `
.ben-wb__akey{position:relative;min-height:100vh;background:var(--wb-back);color:var(--wb-ink);display:flex;flex-direction:column;align-items:center;overflow:auto}
.ben-wb__akey-hero{position:absolute;inset:0 0 auto 0;height:46vh;min-height:240px;pointer-events:none;opacity:.9}
.ben-wb__akey-body{position:relative;z-index:1;width:min(440px,calc(100% - 40px));margin:auto 0;padding:calc(46vh - 40px) 0 48px;display:flex;flex-direction:column}
.ben-wb__akey-progress{display:flex;gap:6px;margin-bottom:8px}
.ben-wb__akey-progress-seg{height:3px;flex:1;border-radius:2px;background:var(--wb-line)}
.ben-wb__akey-progress-seg[data-state="done"]{background:var(--wb-sub)}
.ben-wb__akey-progress-seg[data-state="current"]{background:var(--wb-ink)}
.ben-wb__akey-progress-text{font-size:12px;letter-spacing:.04em;color:var(--wb-faint);margin-bottom:22px}
.ben-wb__akey-kicker{font-size:12px;letter-spacing:.18em;color:var(--wb-faint);margin-bottom:10px}
.ben-wb__akey-title{font-size:26px;line-height:1.35;font-weight:600;margin:0 0 14px;color:var(--wb-ink)}
.ben-wb__akey-lead{font-size:14px;line-height:1.7;color:var(--wb-sub);margin:0 0 26px}
.ben-wb__akey-primary{display:block;box-sizing:border-box;width:100%;text-align:center;padding:14px 18px;font-size:15px;font-weight:600;color:var(--wb-reverse);background:var(--wb-ink);border:none;border-radius:12px;text-decoration:none;cursor:pointer}
.ben-wb__akey-primary:hover{opacity:.88}
.ben-wb__akey-alt{display:block;width:100%;margin-top:12px;padding:12px 18px;font-size:14px;color:var(--wb-sub);background:none;border:1px solid var(--wb-line);border-radius:12px;cursor:pointer}
.ben-wb__akey-alt:hover{border-color:var(--wb-ink);color:var(--wb-ink)}
.ben-wb__akey-alt:disabled{opacity:.5;cursor:default}
.ben-wb__akey-form{display:flex;flex-direction:column;gap:10px}
.ben-wb__akey-label{font-size:13px;color:var(--wb-sub)}
.ben-wb__akey-input{width:100%;box-sizing:border-box;padding:13px 14px;font-size:15px;color:var(--wb-ink);background:var(--wb-field);border:1px solid var(--wb-line);border-radius:12px;outline:none}
.ben-wb__akey-input:focus{border-color:var(--wb-g2)}
.ben-wb__akey-input::placeholder{color:var(--wb-faint)}
.ben-wb__akey-clip{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;padding:10px 12px;font-size:13px;color:var(--wb-ink);background:var(--wb-field);border:1px solid var(--wb-g2);border-radius:12px}
.ben-wb__akey-clip button{flex:none;padding:6px 12px;font-size:13px;color:var(--wb-reverse);background:var(--wb-ink);border:none;border-radius:8px;cursor:pointer}
.ben-wb__akey-preset{margin:4px 0 2px;padding:12px 14px;background:var(--wb-field);border:1px solid var(--wb-line);border-radius:12px}
.ben-wb__akey-preset-title{font-size:12px;color:var(--wb-faint);margin-bottom:8px}
.ben-wb__akey-preset-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:1.9;color:var(--wb-sub)}
.ben-wb__akey-preset-row code{font-size:12px;color:var(--wb-ink);word-break:break-all;text-align:right}
.ben-wb__akey-actions{display:flex;gap:10px;align-items:center}
.ben-wb__akey-alt--inline{margin-top:0;flex:1;padding:11px 12px;font-size:13px}
.ben-wb__akey-test{flex:1;padding:11px 12px;font-size:13px;color:var(--wb-ink);background:none;border:1px solid var(--wb-line);border-radius:12px;cursor:pointer}
.ben-wb__akey-test:disabled{opacity:.5;cursor:default}
.ben-wb__akey-test:hover:not(:disabled){border-color:var(--wb-ink)}
.ben-wb__akey-error{font-size:13px;color:#e08b8b;line-height:1.5}
.ben-wb__akey-test-ok{font-size:13px;line-height:1.5;color:var(--wb-ink)}
.ben-wb__akey-save{margin-top:8px;padding:14px 18px;font-size:15px;font-weight:600;color:var(--wb-reverse);background:var(--wb-ink);border:none;border-radius:12px;cursor:pointer}
.ben-wb__akey-save:disabled{opacity:.5;cursor:default}
.ben-wb__akey-back{align-self:flex-start;margin-top:20px;padding:6px 0;font-size:13px;color:var(--wb-faint);background:none;border:none;cursor:pointer}
.ben-wb__akey-back:hover{color:var(--wb-sub)}
.ben-wb__akey-skip{align-self:flex-start;margin-top:18px;padding:6px 0;font-size:13px;color:var(--wb-faint);background:none;border:none;cursor:pointer}
.ben-wb__akey-skip:hover{color:var(--wb-sub)}
.ben-wb__akey-skip:disabled{opacity:.5;cursor:default}
.ben-wb__akey-privacy{font-size:12px;line-height:1.6;color:var(--wb-faint);margin:24px 0 0}
@media (prefers-reduced-motion: reduce){.ben-wb__akey-hero{opacity:.5}}
`

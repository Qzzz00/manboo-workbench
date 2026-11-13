/**
 * 启动时的「检测到未配置大模型api key」弹窗(2026-11-13)。
 *
 * 启动顺序上它**挡在图一之前**:登录完、首次流程还没开始,先问一句「有没有配 AI 来源」。
 * 没配就弹这一层,3 秒后自动带人去 DeepSeek 密钥那一屏(首次流程的 `config` 步,图二)。
 *
 * 一屏只做一件事:告知 + 倒计时。不收 Key、不读剪贴板、不联网、不写任何持久化状态 ——
 * 真正填 Key 在既有配置界面里,这里只是把人送到门口。
 *
 * 纪律(AGENTS.md / credentials.ts):
 * - 弹窗上不出现任何密钥串,也没有输入框;底层错误不显示。
 * - 「稍后再说」与自动跳转都是**本次启动**的事,不写旗子,下次启动重新问。
 * - 计时器在卸载时收干净;回调引用变了不重置倒计时(ref 存最新),也不重复触发(settled)。
 *
 * 视觉:与登录屏 / 首次流程 / 整屏密钥引导同一舞台(粒子黑洞 + 无框卡片),
 * 令牌走 --wb-*,跟随系统亮暗。
 */
import { useEffect, useRef, useState } from 'react'
import { BlackholeHero } from './brand/BlackholeHero.tsx'
import { API_KEY_STARTUP_COPY, API_KEY_STARTUP_DELAY_MS } from './apiKeyStartup.ts'

export interface ApiKeyStartupNoticeProps {
  /** 倒计时走完 / 点「立即去配置」:去 DeepSeek 密钥配置那一屏。 */
  onGo: () => void
  /** 点「稍后再说」:关掉这一层,按原流程进图一。 */
  onSkip: () => void
  /** 倒计时时长,测试可注入;缺省 3 秒。 */
  delayMs?: number
}

export function ApiKeyStartupNotice({
  onGo, onSkip, delayMs = API_KEY_STARTUP_DELAY_MS,
}: ApiKeyStartupNoticeProps) {
  const [seconds, setSeconds] = useState(Math.max(1, Math.ceil(delayMs / 1000)))
  /** 回调引用每拍都可能变;用 ref 存最新,计时 effect 只依赖 delayMs,不因父组件重渲染而重置。 */
  const goRef = useRef(onGo)
  const skipRef = useRef(onSkip)
  useEffect(() => { goRef.current = onGo }, [onGo])
  useEffect(() => { skipRef.current = onSkip }, [onSkip])
  /** 一次启动只结算一次:手动点了,到点就不再重复跳。 */
  const settled = useRef(false)

  const settle = (action: 'go' | 'skip'): void => {
    if (settled.current) return
    settled.current = true
    if (action === 'go') goRef.current()
    else skipRef.current()
  }

  useEffect(() => {
    if (delayMs <= 0) {
      settle('go')
      return
    }
    const timer = window.setTimeout(() => { settle('go') }, delayMs)
    const tick = window.setInterval(() => {
      setSeconds(previous => Math.max(1, previous - 1))
    }, 1000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(tick)
    }
    // settle 每次渲染都是新函数,但只作为这次计时的结算口;依赖刻意只有 delayMs。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delayMs])

  return (
    <div className="ben-wb__akstart" role="dialog" aria-modal="true" aria-label="未配置大模型密钥">
      <style>{NOTICE_STYLE}</style>
      <div className="ben-wb__akstart-hero"><BlackholeHero /></div>
      <div className="ben-wb__akstart-card">
        <div className="ben-wb__akstart-kicker">{API_KEY_STARTUP_COPY.kicker}</div>
        <h1 className="ben-wb__akstart-title">{API_KEY_STARTUP_COPY.title}</h1>
        <p className="ben-wb__akstart-lead">{API_KEY_STARTUP_COPY.lead}</p>
        <p className="ben-wb__akstart-count" role="status" aria-live="polite">
          {API_KEY_STARTUP_COPY.countdown(seconds)}
        </p>
        <button className="ben-wb__akstart-go" type="button" onClick={() => { settle('go') }}>
          {API_KEY_STARTUP_COPY.go}
        </button>
        <button className="ben-wb__akstart-skip" type="button" onClick={() => { settle('skip') }}>
          {API_KEY_STARTUP_COPY.skip}
        </button>
      </div>
    </div>
  )
}

/**
 * 样式自包含,全部挂在 `.ben-wb__akstart` 下,不漏到工作台本体。
 * 半透明底色让后面的粒子球透出来,与首次流程同一片舞台。
 */
const NOTICE_STYLE = `
.ben-wb__akstart{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--wb-back) 88%,transparent);color:var(--wb-ink)}
.ben-wb__akstart-hero{position:absolute;inset:0;pointer-events:none;opacity:.55}
.ben-wb__akstart-card{position:relative;z-index:1;box-sizing:border-box;width:min(460px,calc(100% - 40px));padding:36px 34px 30px;background:var(--wb-field);border:1px solid var(--wb-line);border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,.45)}
.ben-wb__akstart-kicker{font-size:12px;letter-spacing:.18em;color:var(--wb-faint);margin-bottom:12px}
.ben-wb__akstart-title{font-size:22px;line-height:1.45;font-weight:600;margin:0 0 12px;color:var(--wb-ink)}
.ben-wb__akstart-lead{font-size:14px;line-height:1.75;color:var(--wb-sub);margin:0 0 22px}
.ben-wb__akstart-count{font-size:13px;color:var(--wb-faint);margin:0 0 18px}
.ben-wb__akstart-go{display:block;box-sizing:border-box;width:100%;padding:14px 18px;font-size:15px;font-weight:600;color:var(--wb-reverse);background:var(--wb-ink);border:none;border-radius:12px;cursor:pointer}
.ben-wb__akstart-go:hover{opacity:.88}
.ben-wb__akstart-skip{display:block;width:100%;margin-top:10px;padding:10px 18px;font-size:13px;color:var(--wb-faint);background:none;border:none;cursor:pointer}
.ben-wb__akstart-skip:hover{color:var(--wb-sub)}
@media (prefers-reduced-motion: reduce){.ben-wb__akstart-hero{opacity:.3}}
`

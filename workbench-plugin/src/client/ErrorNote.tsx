/**
 * 带编号的错误提示(2026-09-22)。
 *
 * ## 这个组件为什么存在
 *
 * 在这之前,每个面板各自维护一个 `error: string | null` 然后渲一段
 * `<p role="alert">{error}</p>` —— 十来处,长得都不一样,而且**屏幕上那句话与日志里那一行
 * 之间没有任何东西能把它们连起来**。Ben 是 PM、不看日志、不走命令行;他能做的是
 * 打电话说「红字写着什么什么」。统筹这头只能靠猜。
 *
 * 加一个短编号就把这件事变简单了:界面上显示 `WB-123456`,他念六个数字,
 * 统筹在 `~/.dsh/logs/web.stdout.log` 里 grep 一下就落到现场;自动上报开着的话,
 * 中转那边同一个编号也躺着一条(`GET /v1/diag/reports`)。
 *
 * ## 编号哪儿来
 *
 * **服务端给的**(`sendCodedError` 回的 `{ error, code }`),不是前端自己编的。
 * 理由:编号要跟"服务端日志里那一行"对上,而只有服务端知道那一行是什么时候写的。
 * 服务端没给(老版本、纯前端的错)就不显示编号 —— 编一个出来会让"念编号"这件事
 * 从此不可信(D13:没有就是没有)。
 *
 * ## 范围
 *
 * 这一版只在体检与修复、热更新这两处用它。看板那一大片是 `postSilently` 的地盘
 * (失败了等下一拍轮询,故意不弹错),在那里加编号等于造一个没人看的号。
 */
import type { ReactNode } from 'react'

export interface ErrorNoteProps {
  /** 那句人话。`null` / 空串 = 不显示(缺省即无)。 */
  text: string | null | undefined
  /** 服务端给的短编号。没有就不显示那一小截。 */
  code?: string | undefined
  /** 外层类名,沿用各页自己那一套(`ben-wb__setup-err` / `ben-wb__upd-err`)。 */
  className?: string
  /** 编号后面还想说一句(比如「已经报给开发者」)。 */
  children?: ReactNode
}

export function ErrorNote({ text, code, className, children }: ErrorNoteProps) {
  if (text === null || text === undefined || text === '') return null
  return (
    <p className={className ?? 'ben-wb__err'} role="alert">
      {text}
      {code !== undefined && code !== '' && (
        <span className="ben-wb__errcode" aria-label={`错误编号 ${code}`}>
          {`  编号 ${code}`}
        </span>
      )}
      {children}
    </p>
  )
}

/**
 * 服务端回的 `{ error, code }` → 一个带编号的 Error。
 *
 * 为什么要自定义一个 Error 而不是把编号塞进 message:塞进 message 的话,
 * 每一处 `catch (err) { setError(err.message) }` 都会把编号当成句子的一部分显示,
 * 换个措辞就漂了。分成两格,显示的规矩只在 `ErrorNote` 一处。
 */
export class CodedError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'CodedError'
    this.code = code
  }
}

/** 从任意一个 catch 到的东西里取出那两格。取不到编号就 undefined,不编。 */
export function codedOf(error: unknown, fallback: string): { text: string, code?: string } {
  if (error instanceof CodedError) {
    return { text: error.message, ...(error.code === undefined ? {} : { code: error.code }) }
  }
  if (error instanceof Error) return { text: error.message }
  return { text: fallback }
}

/**
 * 壳窗口「前台 / 桌面」两档的判断(2026-09-18)。
 *
 * Ben 的原话:「安装完……现在的层级已经在底部了,导致我缩小了很多应用才看到页面,用户会
 * 觉得出 bug 了。登录和引导的时候,应该是和其他应用一样,能在顶部的,现在写死是底部。」
 *
 * 壳按 spec 是**桌面级**窗口:平时压在所有原生窗之下,贴合编排把认领的窗口摆到它的窗位槽上
 * (那些窗口必须永远浮在它上面)。日常这是对的,但第一次打开时屏幕上既没有窗位也没有认领的
 * 窗口 —— 压在底下的唯一后果就是人看不见它。
 *
 * **判断放在网页这一侧,是因为只有网页知道此刻屏上是哪一屏。** 服务端不知道浏览器渲染到哪
 * 一步,壳更不知道。所以这个文件只做一件事:把 Workbench 已经拿在手上的两格状态,折成
 * 「该是哪一档」。折出来的结论由 postWindowMode 送到服务端,再由服务端转给壳。
 *
 * 判定与**渲染**严格一一对应(Workbench 底部那两处整屏早退):
 *   - 登录屏在屏上            → front
 *   - 首次流程 / 引导在屏上   → front
 *   - 工作台本体在屏上        → desktop
 * 一一对应的好处是不会出现「屏上明明是登录屏,窗口却在底下」这种两套判断各说各话的缝。
 */

export type ShellWindowMode = 'front' | 'desktop'

/**
 * `/account` 探测结果里这条判断用得到的那一点点(结构与 accountApi 的 `AccountProbe`
 * 对得上,但**只要 logged_in 一格** —— 这个文件不该跟着账号视图的其余字段一起变)。
 */
export type ShellAccountProbe = { enabled: false } | { enabled: true, view: { logged_in: boolean } }

/** decideWindowMode 认的那两格状态,取的就是 Workbench 里同名的两个 useState。 */
export interface ShellWindowStage {
  /**
   * `/account` 探测结果。`undefined` = 还没问到(照旧渲染工作台,但那只是"还不知道");
   * `enabled:false` = 这台服务没接账号(展示台、老用例、手机),没有登录屏也没有引导屏。
   */
  account: ShellAccountProbe | undefined
  /**
   * 首次流程那面旗子要不要拦路(真相是 app.json 的 `first_run_done_at`)。
   * `undefined` = 还没问到 / 还没轮到问(没登录时不问)。
   * 引导(onboarding)整段就跑在这一屏里 —— 走完或点「稍后 / 跳过」都会写旗子,
   * 这里跟着翻成 false,所以不需要再单独看一次 `/onboarding.done`。
   */
  firstRunNeeded: boolean | undefined
}

/**
 * 该是哪一档 —— 返回 `undefined` 表示**这一刻还不知道,什么都别发**。
 *
 * 「不知道就不发」不是偷懒,是这条路上唯一安全的默认:壳自己启动时默认就是 front
 * (还没连上工作台、不知道人在哪一步时,先让人看见),不发就等于沿用那个默认。反过来
 * 如果在还没问到 `/account` 的那几毫秒里先发一条 desktop,人会看见窗口"闪一下沉下去"
 * ——而那几毫秒之后多半又要发 front 把它捞回来。
 */
export function decideWindowMode(stage: ShellWindowStage): ShellWindowMode | undefined {
  const { account, firstRunNeeded } = stage
  // 还没问到 /account:屏上照旧是工作台本体,但那只是"还没问到"。见上面那段。
  if (account === undefined) return undefined
  // 这台服务没接账号:不会有登录屏,也不会有引导屏,屏上就是工作台本体。
  if (!account.enabled) return 'desktop'
  // 没登录 → 整屏登录/注册卡。
  if (!account.view.logged_in) return 'front'
  // 登录了,但旗子还没问到 —— 同样是"还不知道",不发。
  if (firstRunNeeded === undefined) return undefined
  // 首次流程三屏 + 引导对话,都是整屏。
  if (firstRunNeeded) return 'front'
  return 'desktop'
}

/**
 * 把结论发给服务端(`POST /shell/window-mode`),服务端转给壳。
 *
 * **静默**:这条路没有人在等一个答复 —— 发失败(壳没开、服务端老版没这条路、网络抖)
 * 最坏的后果是窗口层级停在上一档,而屏上的内容一切照旧;为它弹一句错误话术反而是噪音。
 * 这跟 firstRunApi 那条"失败不静默"的纪律不冲突:那边每一步后面都跟着一个人在等。
 *
 * 不用 postSilently 是因为这里要**回**一个「发出去了没有」给调用方做去重(见 Workbench 的
 * effect:只有真的发出去了才记成"已经是这一档了")。
 */
export async function postWindowMode(
  baseUrl: string,
  mode: ShellWindowMode,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/shell/window-mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      // source:'app' 是壳内页面的自称,服务端还会再验一道壳的 UA 标记(浏览器伪造不了)。
      body: JSON.stringify({ mode, source: 'app' }),
    })
    if (!res.ok) return false
    /**
     * **真相在 body 的 `ok` 里,不在 HTTP 状态码里**(2026-09-25,卡 fix/slot-current-empty)。
     * 壳没连上 / 超时这类业务失败服务端照样回 200 + `{ ok:false }`(同 /snap 的先例)。原来这里只看
     * HTTP,页面就把"壳根本没收到"记成"已经是桌面档了",再也不重发 —— 新壳启动默认是前台档
     * (普通层 + 置前),于是它一直压在认领的窗上面:窗口槽看着是一整块空的深色区,标签却高亮着。
     */
    try {
      const body = await res.json() as { ok?: unknown } | null
      return body?.ok === true
    }
    catch {
      return false
    }
  }
  catch {
    return false
  }
}

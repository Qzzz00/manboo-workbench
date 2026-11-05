/**
 * 主动语音「出声」门控（纯判定，便于单测 + 将来扩展「多设备单播/择主」）。
 *
 * 背景：后端把「主动开场 / journey beat」事件广播给用户的所有在线设备。若某设备
 * 的标签页处于后台（document.visibilityState !== 'visible'），不应替用户「开口」——
 * 否则用户在 A 设备启动 App，B 设备的后台标签也会跟着出声（实测：Windows 启动
 * holo → Mac 后台 Chrome 标签角色开口）。
 *
 * 规则：仅当页面「可见（'visible'）」且 App 演出路径就绪（appReady）时允许
 * performProactive 出声；'hidden' / 'prerender' / 其它未知状态一律返回 false（保守静默）。
 * appReady 承载 ALL-434 的「App/当前角色聊天已就绪」门：冷启动/登录加载/切角色过渡期间
 * 为 false，此时即使页面可见也不开口。记录类副作用（未读 / 消息落库 / refresh）不经此门，
 * 另行照常处理，避免丢消息。
 *
 * @param visibilityState 通常传 document.visibilityState
 * @param appReady App/当前角色聊天演出是否就绪（缺省 true=仅可见性门控，保持旧行为）
 * @returns true=允许出声；false=后台/不可见或 App 未就绪，静默
 */
export function shouldPerformProactive(visibilityState: string, appReady = true): boolean {
  return visibilityState === 'visible' && appReady;
}

/**
 * 「补拉只触发一次」的就绪门边沿判定（纯函数）：useProactivePerformance 监听
 * performanceReady 从「未就绪」变「就绪」的瞬间补一次 catchUp。previousReady 为上次
 * 渲染的值（null=首次渲染），currentReady 为本次值。仅在「本次已就绪且上次未就绪」时
 * 返回 true——含首次渲染即就绪（previousReady=null），覆盖「挂载时 gate 已为 true」的
 * 登录完成场景；就绪态未变化不重复触发，避免每次渲染都补拉。
 */
export function shouldTriggerCatchUpOnReady(previousReady: boolean | null, currentReady: boolean): boolean {
  return currentReady && previousReady !== currentReady;
}

/**
 * 出声门控 + 会话内去重（纯逻辑）：实时 SSE 与上线补拉共用的 perform 出口判定。
 * allowed=false（后台不可见 / App 未就绪）时返回 false 且不把 messageId 计入 performed
 * ——服务端消息保持未 seen，等 gate 打开后由 catchUp 补演，不丢失；allowed=true 时按
 * performed 去重（本会话已演出过返回 false），未演出过则计入并放行。
 *
 * @param allowed 是否允许出声（shouldPerformProactive 的结果）
 * @param messageId proactive 行 id（可缺省）
 * @param performed 会话内已演出 id 集合（调用方持有的 Set，此处可写）
 * @returns true=可继续演出；false=应静默
 */
export function claimPerformIfAllowed(
  allowed: boolean,
  messageId: string | undefined,
  performed: Set<string>,
): boolean {
  if (!allowed) return false;
  if (messageId) {
    if (performed.has(messageId)) return false;
    performed.add(messageId);
  }
  return true;
}

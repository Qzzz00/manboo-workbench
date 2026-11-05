export const MEMORY_CONFIG = {
  /** 触发摘要的消息条数阈值 */
  SUMMARY_THRESHOLD: 20,
  /** 每次摘要保留的最近消息条数（不进入摘要） */
  KEEP_RECENT: 6,
  /** 摘要本身的目标 token 预算（用于 prompt 指令，非硬性截断） */
  SUMMARY_TOKEN_BUDGET: 512,
  /** 构造 prompt 时历史消息 + 摘要的总 token 预算 */
  HISTORY_TOKEN_BUDGET: 4096,
};

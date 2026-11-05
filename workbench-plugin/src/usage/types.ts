/** 一条用量记录(内部类型,不进 protocol——protocol 只暴露聚合后的结果)。 */
export interface UsageRecord {
  /** ISO 时间戳。 */
  ts: string
  /** 已归拢的项目名。 */
  project: string
  model: string
  /** 'claude' | 'codex' | 'dsh' | 'kimi'。 */
  source: string
  /** 真实输入(不含缓存读)。 */
  input: number
  output: number
  cache_read: number
  cache_write: number
  session: string
  /**
   * 去重键。Claude 日志同一次请求会出现多条记录——实测一次全扫命中 29,467 条重复,
   * 不去重用量会被放大数倍。没有可用键时留空,由调用方按"不去重"处理。
   */
  key?: string
}

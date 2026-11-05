import { rollupProject } from './rollup.ts'
import type { UsageRecord } from './types.ts'

/** 带用量的行里一定出现的键。没有它的行不可能有 `message.usage`,collector 在字节上先筛掉(同 Codex 那边)。 */
export const CLAUDE_USAGE_MARKER = '"usage"'

/**
 * 解析 Claude Code 会话日志的一行(`~/.claude/projects/<slug>/*.jsonl`)。
 *
 * 只有带 `message.usage` 的行才是一次真实调用;其余(用户消息、工具结果、元数据)跳过。
 * 坏行一律返回 undefined——日志是外部产物,不能因为一行脏数据让整轮扫描挂掉。
 */
export function parseClaudeLine(line: string, session: string): UsageRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  }
  catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined

  const row = parsed as Record<string, any>
  const usage = row.message?.usage
  if (typeof usage !== 'object' || usage === null) return undefined
  if (typeof row.timestamp !== 'string') return undefined

  const key = row.requestId ?? row.message?.id ?? row.uuid
  return {
    ts: row.timestamp,
    project: rollupProject(typeof row.cwd === 'string' ? row.cwd : ''),
    model: typeof row.message?.model === 'string' ? row.message.model : '(未知)',
    source: 'claude',
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    cache_write: usage.cache_creation_input_tokens ?? 0,
    session,
    ...(typeof key === 'string' ? { key } : {}),
  }
}
